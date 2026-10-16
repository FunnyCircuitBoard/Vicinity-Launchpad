/**
 * Send from the Wallet tab (wallet onboarding, step 2; WALLET_SEND=on). public/dashboard.js fetches this file only when /api/me says
 * walletSend, so with the switch off nothing here exists. It adds a Send button to the Balances card and a Send sheet (the Buy panel's
 * bottom sheet, swap.css): what to send among the coins this wallet holds (the tab's own rows: SOL, $VICINITY, the city coins), an amount
 * with Max, the destination with Paste and a live check (format, your own wallet, then the Worker's verdict: the live check is one build
 * with ?live=1, counted apart from the taps on the Worker, so typing never uses up a Review; an address the chain has no account for is
 * said plainly, never as a good sign), then a confirm screen that shows the Worker's summary word for word (POST /api/wallet/send/build:
 * every number and every line on it comes from there; this file computes no fee, no rent and no maximum) with the full destination
 * address, its first and last four characters emphasised, one sentence ("A send cannot be undone. Check the address.") and one Send
 * button. Then the person's own wallet signs, through public/lp-sign.js exactly as the city-coin pages do: a wallet that sends signs and
 * sends itself; one that only signs signs, the page checks it changed nothing, and the site's relay (/api/wallet/send/relay, the swap's
 * relay under another name) sends it with the build's ticket. While the wallet is open or the network is being asked the sheet stays
 * open (Escape, the ✕ and a tap outside wait), so the outcome is seen here. The status (/api/wallet/send/status), a Solscan link, and
 * the balances are read again from the chain. Nothing here holds a key; the site never signs.
 *   window.VWalletSend.init({ me, state, readWallet }) -> { render(me), open(), close() }
 *     me()          the last /api/me answer      state()       the Wallet tab's last answer and rows (dashboard-v2.js walletState)
 *     readWallet()  the balances again, from the chain (after a confirmed send)
 */
(() => {
  "use strict";
  const W = () => window.VW;
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const isAddr = (a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "");
  const ROUTES = Object.freeze({ build: "/api/wallet/send/build", send: "/api/wallet/send/relay", status: "/api/wallet/send/status" });
  const CLUSTER = "mainnet";
  const FRESH_MS = 30_000; // a build older than this is made again before the wallet opens: its blockhash lives about a minute, and the wallet takes its time
  const CHECK_MS = 600; // the live check waits this long after the last keystroke (one build, not one per key)
  const SLOW_MS = 60_000; // after a 429 no live check for a minute (the live checks have their own budget on the Worker: 60 an hour per account)
  const DEST = new Set(["bad_address", "same_wallet", "not_a_wallet"]); // refusals about the destination: said under that field
  const SENDING = new Set(["signing", "sending", "confirming"]); // the sheet stays open in these: the wallet is open, or the network is being asked
  // plain words when the Worker's answer carries none of its own (it nearly always does: `message`)
  const WORDS = {
    bad_address: "That is not a Solana address.", same_wallet: "That is your own wallet address.", not_a_wallet: "This address is not a person's wallet.",
    unsupported_asset: "Only SOL, $VICINITY and Vicinity city coins can be sent from here.", bad_amount: "Type an amount above zero, with a point for decimals (like 0.5).",
    too_many_decimals: "Too many decimals for this coin.", insufficient_sol: "Not enough SOL for this send.", insufficient_balance: "You do not hold that much.",
    leaves_dust: "This would leave too little SOL in your wallet.", amount_below_rent: "That wallet has not been used yet and needs more SOL than this to open.", all_required: "This would send everything you have. Tap Max for that.",
    no_wallet: "Link a wallet to your account first.", sign_in: "Sign in again, then try once more.", wrong_origin: "Please open vicinity.city directly and try again.", bad_origin: "Please open vicinity.city directly and try again.",
    slow_down: "Too many tries in a short time. Wait a minute and try again.", rpc_unavailable: "The blockchain could not be reached just now. Nothing was sent. Try again in a minute.",
    unavailable: "This is not available right now. Nothing was sent. Try again in a minute.", not_found: "Sending is switched off right now.", bad_json: "Something went wrong. Nothing was sent.",
    program_error: "The network refused this send. Nothing was spent.", rejected_by_network: "The network refused this send. Nothing was spent.", tx_too_large: "This send is too big for one transaction.",
    offline: "You seem to be offline. Nothing was sent.", no_lp: "The signing module could not load. Reload the page and try again.", wrong_wallet: "That is a different wallet. Use the one linked to your account.",
  };
  const say = (d) => {
    if (d && typeof d.message === "string" && d.message) return d.message;
    // a 429 says how long its window is (Retry-After): the hourly counters are not "a minute"
    if (d && d.error === "slow_down" && d._retryAfter >= 120) return `Too many checks this hour. Try again in up to ${Math.ceil(d._retryAfter / 60)} minutes.`;
    return WORDS[d && d.error] || (window.LP && typeof window.LP.say === "function" && d && d.error ? window.LP.say(d.error, d) : "Something went wrong. Nothing was sent.");
  };
  /** A held amount for the asset list (display only; the amount sent is what the person types, and the Worker's numbers are the summary). */
  const num = (v) => { const n = Number(v); if (!Number.isFinite(n)) return ""; const a = Math.abs(n); return a === 0 ? "0" : a >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : a >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : n.toLocaleString("en-US", { maximumSignificantDigits: 6 }); };
  const styled = () => { if (Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((l) => /\/wallet-send\.css$/.test(l.getAttribute("href") || ""))) return; const l = el("link"); l.setAttribute("rel", "stylesheet"); l.setAttribute("href", "/wallet-send.css"); (document.head || document.body).append(l); };
  /** public/lp-sign.js (the dashboard loads it; fetched here when a page did not): window.LP, or null. */
  let lpP = null;
  const ensureLP = () => (window.LP ? Promise.resolve(window.LP) : (lpP ||= new Promise((done) => {
    const s = document.createElement("script"); s.src = "/lp-sign.js";
    const t = setTimeout(() => { lpP = null; done(null); }, 8000);
    s.onload = () => { clearTimeout(t); done(window.LP || null); };
    s.onerror = () => { clearTimeout(t); lpP = null; done(null); };
    (document.head || document.body).append(s);
  })));
  /** One request to this site (the shape the Buy panel uses): GET without a body, POST with one; _status rides along; never throws. */
  async function req(path, body) {
    try {
      const r = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && d.ok === undefined) d.ok = false;
      if (!r.ok && !d.error) d.error = r.status === 429 ? "slow_down" : r.status === 404 ? "not_found" : "unavailable";
      d._status = r.status;
      const ra = r.headers && typeof r.headers.get === "function" ? Number(r.headers.get("Retry-After")) : NaN; // seconds: how long the 429's window is
      if (r.status === 429 && Number.isFinite(ra) && ra > 0) d._retryAfter = ra;
      return d;
    } catch { return { ok: false, error: "offline", _status: 0 }; }
  }

  let ctx = null, btn = null, sheet = null, ui = null, timer = 0, seq = 0, slowUntil = 0, askedRead = false;
  const fresh = () => ({ asset: null, amount: "", all: false, to: "", build: null, builtAt: 0, key: "", check: null, phase: "form", handle: null, wallet: null, sig: null, solscan: null, error: null, busy: false });
  let s = fresh();
  const me = () => (ctx && ctx.me ? ctx.me() : null);
  const linked = () => { const m = me(); return m && m.user && typeof m.user.wallet === "string" && isAddr(m.user.wallet) ? m.user.wallet : null; };
  /** What this wallet holds among the coins the tab shows: [{ id: "SOL" | mint, label, sub, amount }], [] when it holds none, null while unread. */
  function assets() {
    const st = ctx && ctx.state ? ctx.state() : null;
    if (!st || !Array.isArray(st.rows)) return null;
    return st.rows.filter((r) => r && r.key && r.amount > 0).map((r) => ({ id: r.key, label: r.label, sub: r.sub, amount: r.amount }));
  }

  /* ---------------------------------------------------------------- the button */
  function init(c) {
    ctx = c;
    mount();
    return { render, open, close: closeSheet, get state() { return s; } };
  }
  function mount() {
    const acts = $("#wt-balances .dv2-actions");
    if (!acts || $("#wt-send")) return;
    btn = el("button", "btn btn--glass btn--sm wsend-open", "Send"); btn.type = "button"; btn.id = "wt-send"; btn.hidden = true;
    btn.addEventListener("click", () => open());
    acts.prepend(btn);
  }
  /** After every /api/me: the button only with a linked wallet and the switch on; a wallet that goes closes an open sheet. */
  function render(d) {
    if (!btn) mount();
    const w = d && d.user && d.user.wallet && d.walletSend === true;
    if (btn) btn.hidden = !w;
    if (!w && sheet && sheet.hasAttribute("open")) closeSheet();
    if (w && sheet && sheet.hasAttribute("open") && s.phase === "form") drawAssets();
  }

  /* ---------------------------------------------------------------- the sheet */
  function make() {
    styled();
    sheet = el("dialog", "swap-sheet wsend-sheet"); sheet.setAttribute("aria-label", "Send");
    const card = el("div", "swap-sheet__card wsend");
    const close = el("button", "swap-sheet__close", "✕"); close.type = "button"; close.setAttribute("aria-label", "Close"); close.addEventListener("click", closeSheet);
    // the form
    const form = el("div", "wsend__form");
    const title = el("h2", "h2--sm wsend__title", "Send from this wallet"); title.setAttribute("tabindex", "-1");
    const from = el("p", "small muted wsend__from");
    const assetsBox = el("div", "wsend__assets"); assetsBox.setAttribute("role", "radiogroup"); assetsBox.setAttribute("aria-label", "What to send");
    const amtRow = el("div", "wsend__row"), amtLab = el("label", "wsend__label", "Amount"), amtLine = el("div", "wsend__line");
    const amt = el("input", "wsend__input wsend__amt"); amt.id = "wsend-amt"; amt.setAttribute("type", "text"); amt.inputMode = "decimal"; amt.autocomplete = "off"; amt.placeholder = "0.0"; amtLab.setAttribute("for", "wsend-amt");
    const max = el("button", "wsend__max", "Max"); max.type = "button"; max.setAttribute("aria-label", "Max: the most you can send");
    amtLine.append(amt, max); amtRow.append(amtLab, amtLine);
    const toRow = el("div", "wsend__row"), toLab = el("label", "wsend__label", "To (a Solana wallet address)"), toLine = el("div", "wsend__line");
    const to = el("input", "wsend__input wsend__to"); to.id = "wsend-to"; to.setAttribute("type", "text"); to.autocomplete = "off"; to.setAttribute("spellcheck", "false"); to.setAttribute("autocapitalize", "off"); to.placeholder = "Paste the address"; toLab.setAttribute("for", "wsend-to");
    const paste = el("button", "wsend__paste", "Paste"); paste.type = "button";
    paste.hidden = !(navigator.clipboard && typeof navigator.clipboard.readText === "function");
    toLine.append(to, paste); toRow.append(toLab, toLine);
    const check = el("p", "small wsend__check"); check.setAttribute("role", "status"); check.setAttribute("aria-live", "polite");
    const status = el("p", "small wsend__status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const review = el("button", "btn btn--primary btn--block wsend__review", "Review"); review.type = "button";
    const foot = el("p", "tiny muted wsend__foot", "Only SOL, $VICINITY and Vicinity city coins. You sign in your own wallet; Vicinity never holds your keys and takes no fee.");
    form.append(el("p", "kicker", "Send"), title, from, assetsBox, amtRow, toRow, check, status, review, foot);
    // the confirm screen
    const confirm = el("div", "wsend__confirm"); confirm.hidden = true;
    const ctitle = el("h2", "h2--sm", "Check, then send"); ctitle.setAttribute("tabindex", "-1");
    const lines = el("ul", "wsend__lines");
    const toLabel = el("p", "small muted wsend__to-label", "To this address");
    const addr = el("code", "wsend__addr mono");
    const notice = el("p", "small wsend__notice");
    const wallets = el("div", "wsend__wallets");
    const cstatus = el("p", "small wsend__status"); cstatus.setAttribute("role", "status"); cstatus.setAttribute("aria-live", "polite");
    const links = el("p", "tiny wsend__links");
    const go = el("button", "btn btn--primary btn--block wsend__go", "Send"); go.type = "button";
    const back = el("button", "link-btn wsend__back", "Back"); back.type = "button";
    confirm.append(el("p", "kicker", "Confirm"), ctitle, lines, toLabel, addr, notice, wallets, cstatus, links, go, back);
    card.append(close, form, confirm); sheet.append(card);
    sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); }); // a tap outside the card
    sheet.addEventListener("cancel", (e) => { if (SENDING.has(s.phase)) e.preventDefault(); }); // Escape: not while the wallet is open or the network is asked
    sheet.addEventListener("close", onClosed);
    document.body.append(sheet);
    ui = { card, form, title, from, assetsBox, amt, max, to, paste, check, status, review, confirm, ctitle, lines, addr, notice, wallets, cstatus, links, go, back };
    assetsBox.addEventListener("keydown", onAssetKey);
    amt.addEventListener("input", onAmount);
    to.addEventListener("input", onTo);
    paste.addEventListener("click", onPaste);
    max.addEventListener("click", onMax);
    review.addEventListener("click", onReview);
    go.addEventListener("click", onSend);
    back.addEventListener("click", () => toForm());
  }
  function open() {
    if (!linked()) return;
    if (!sheet) make();
    s = fresh(); seq++; askedRead = false;
    ui.amt.value = ""; ui.to.value = ""; ui.check.textContent = ""; ui.check.className = "small wsend__check"; ui.status.textContent = ""; ui.status.className = "small wsend__status";
    ui.review.disabled = false; ui.review.textContent = "Review"; ui.review.classList.remove("is-busy"); // a build cut short by the last close
    ui.from.replaceChildren("From your linked wallet ", el("code", "mono", shortAddr(linked())), ".");
    drawAssets();
    toForm();
    if (typeof sheet.showModal === "function") { try { sheet.showModal(); } catch { sheet.setAttribute("open", ""); } } else sheet.setAttribute("open", "");
    setTimeout(() => { if (!sheet.hasAttribute("open")) return; try { (s.asset ? ui.amt : ui.title).focus({ preventScroll: true }); } catch { /* no focus */ } }, 50);
  }
  /** Close: not while the wallet is open or the network is being asked (the outcome is shown here; Done, Send more or Back come after). */
  function closeSheet() {
    if (!sheet || SENDING.has(s.phase)) return;
    if (typeof sheet.close === "function" && sheet.hasAttribute("open")) sheet.close(); else { sheet.removeAttribute("open"); onClosed(); }
  }
  function onClosed() { clearTimeout(timer); seq++; s = fresh(); if (ui) { ui.wallets.replaceChildren(); ui.links.replaceChildren(); } }
  /** The radio list of what this wallet holds; the first one is chosen when none is. Drawn again only when something changed (every /api/me redraws the tab): the keyboard stays where it was. */
  let drawn = null;
  function drawAssets() {
    const list = assets();
    const box = ui.assetsBox;
    if (list && list.length && !list.some((a) => a.id === s.asset)) { s.asset = list[0].id; invalidate(); }
    if (!list || !list.length) s.asset = null;
    const shape = list === null ? null : `${s.asset}|${list.map((a) => `${a.id}:${a.amount}`).join("|")}`;
    if (shape !== null && shape === drawn && box.children.length) return;
    drawn = shape;
    const focused = document.activeElement && document.activeElement.dataset && document.activeElement.parentNode === box ? document.activeElement.dataset.asset : null;
    box.replaceChildren();
    if (list === null) {
      box.append(el("p", "small muted wsend__none", "Reading your balances…"));
      // asked once per opening (dashboard.js rests 10 s between reads: asking again at once would answer nothing new)
      if (!askedRead && ctx && ctx.readWallet) { askedRead = true; const n = seq; Promise.resolve(ctx.readWallet()).then(() => { if (n === seq && sheet && sheet.hasAttribute("open") && s.phase === "form") drawAssets(); }).catch(() => {}); }
    }
    else if (!list.length) box.append(el("p", "small muted wsend__none", "Nothing to send yet: this wallet holds none of the coins this page shows."));
    for (const a of list || []) {
      const b = el("button", "wsend__asset"); b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(a.id === s.asset)); b.dataset.asset = a.id;
      b.append(el("span", "wsend__asset-name", a.label), el("span", "wsend__asset-amt", `${num(a.amount)} held`));
      b.addEventListener("click", () => { if (s.asset === a.id) return; s.asset = a.id; s.all = false; invalidate(); drawAssets(); scheduleCheck(); });
      box.append(b);
    }
    if (focused) { const again = [...box.children].find((b) => b.dataset && b.dataset.asset === focused); if (again) try { again.focus({ preventScroll: true }); } catch { /* no focus */ } }
    const none = !list || !list.length;
    ui.amt.disabled = none; ui.max.disabled = none; ui.to.disabled = none; ui.review.disabled = none;
  }
  /** The arrow keys move through the radios and choose, as in a radio group (Tab leaves it). */
  function onAssetKey(e) {
    const k = e.key;
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(k)) return;
    const radios = [...ui.assetsBox.children].filter((b) => b.dataset && b.dataset.asset);
    let t = e.target; while (t && t !== ui.assetsBox && !(t.dataset && t.dataset.asset && t.parentNode === ui.assetsBox)) t = t.parentNode;
    const i = radios.indexOf(t);
    if (i < 0 || radios.length < 2) return;
    e.preventDefault();
    const next = radios[(i + (k === "ArrowDown" || k === "ArrowRight" ? 1 : radios.length - 1)) % radios.length];
    next.click(); // chooses it (and redraws the list: the keyboard follows below)
    const again = [...ui.assetsBox.children].find((b) => b.dataset && b.dataset.asset === next.dataset.asset);
    if (again) try { again.focus({ preventScroll: true }); } catch { /* no focus */ }
  }

  /* ---------------------------------------------------------------- the form */
  /** A new amount, asset or destination: the build on hand is for something else. */
  function invalidate() { s.build = null; s.builtAt = 0; s.key = ""; s.handle = null; }
  function onAmount() { const v = ui.amt.value.trim(); s.amount = v.startsWith(".") ? `0${v}` : v; s.all = false; invalidate(); setStatus(""); scheduleCheck(); } // ".5" is 0.5 (the Worker wants the leading digit)
  function onTo() { s.to = ui.to.value.trim(); invalidate(); setStatus(""); liveFormat(); scheduleCheck(); }
  async function onPaste() {
    try { const t = String(await navigator.clipboard.readText() || "").trim(); if (t) { ui.to.value = t; onTo(); } else setStatus("Nothing to paste.", "bad"); }
    catch { setStatus("Could not read the clipboard. Paste the address into the field.", "bad"); }
    try { ui.to.focus({ preventScroll: true }); } catch { /* no focus */ }
  }
  /** The free part of the live check: the shape of the address, and your own wallet. */
  function liveFormat() {
    const to = s.to;
    if (!to) return setCheck("", "");
    if (to === linked()) return setCheck(WORDS.same_wallet, "bad");
    if (!isAddr(to)) return setCheck(to.length < 32 ? "Keep typing or paste the full address." : WORDS.bad_address, to.length < 32 ? "" : "bad");
    setCheck("Looks like a Solana address. Checking…", "");
  }
  const setCheck = (text, kind) => { ui.check.textContent = text; ui.check.className = `small wsend__check${kind ? ` is-${kind}` : ""}`; };
  const setStatus = (text, kind) => { ui.status.textContent = text; ui.status.className = `small wsend__status${kind ? ` is-${kind}` : ""}`; };
  const buildKey = () => `${s.asset}|${s.all ? "all" : s.amount}|${s.to}`;
  /** Ready for the Worker: an asset, an amount (or Max), a destination that passes the free checks. */
  const complete = () => Boolean(s.asset && (s.all || (s.amount && /^\d*\.?\d+$/.test(s.amount) && Number(s.amount) > 0)) && isAddr(s.to) && s.to !== linked());
  /** The live check: one build, CHECK_MS after the last change, when the form is complete; never twice for the same form. */
  function scheduleCheck() {
    clearTimeout(timer);
    if (!complete() || Date.now() < slowUntil) return;
    timer = setTimeout(() => { if (sheet && sheet.hasAttribute("open") && s.phase === "form" && complete() && s.key !== buildKey()) build({ live: true }); }, CHECK_MS);
  }
  /**
   * POST /api/wallet/send/build. { ok: true } keeps the answer (and its summary) as the build on hand; a refusal about the destination
   * goes under that field, any other under the amount; `all`: Max (the Worker names the amount).
   */
  async function build({ live = false, all = s.all } = {}) {
    const keyOf = () => `${s.asset}|${all ? "all" : s.amount}|${s.to}`;
    const n = ++seq, key = keyOf();
    s.busy = true; ui.review.disabled = true; ui.review.textContent = live ? "Review" : "Checking…"; ui.review.classList.toggle("is-busy", !live);
    if (!live) setStatus("Checking with the server…", "");
    // the page's own check is counted apart from the taps on the Worker (?live=1): typing never uses up a Review
    const d = await req(live ? `${ROUTES.build}?live=1` : ROUTES.build, { to: s.to, asset: s.asset, ...(all ? { all: true } : { amount: s.amount }) });
    if (n !== seq) return null; // a newer build took over (the Review button is its now), or the sheet was closed
    s.busy = false; ui.review.disabled = false; ui.review.textContent = "Review"; ui.review.classList.remove("is-busy");
    if (key !== keyOf()) return null; // the form changed while the answer was on its way and nothing newer was asked: this answer is for the old form
    if (d && d.ok && d.tx && d.summary) {
      s.build = d; s.builtAt = Date.now(); s.key = key; s.handle = null;
      if (all) { s.all = true; s.amount = d.amount; ui.amt.value = d.amount; }
      const dest = d.summary.destination || {};
      // an address the chain has no account for is said plainly, not as a good sign: that is how a mistyped address usually looks
      setCheck(dest.exists ? "A wallet on the Solana chain." : "An address that has not been used on Solana yet.", dest.exists ? "ok" : "");
      setStatus("");
      return d;
    }
    if (d && d._status === 429) {
      slowUntil = Date.now() + SLOW_MS;
      if (live) { setStatus("Live checks are paused for a minute. Tap Review when you are ready.", ""); return null; }
    }
    if (DEST.has(d && d.error)) { setCheck(say(d), "bad"); setStatus(""); }
    else setStatus(say(d), "bad");
    return null;
  }
  /** Max: the Worker says the most that can go to THIS destination (fee and rent depend on it), and fills the amount in. */
  async function onMax() {
    if (!s.asset) return;
    if (s.busy) return setStatus("Checking… one moment.", "");
    if (!isAddr(s.to) || s.to === linked()) { setStatus("Type the destination first: the most you can send depends on it (the network fee, and the recipient's account rent for a coin).", ""); try { ui.to.focus({ preventScroll: true }); } catch { /* no focus */ } return; }
    clearTimeout(timer);
    s.all = true; invalidate();
    await build({ live: false, all: true });
  }
  /** Review: the build on hand when it is fresh and for this very form, else a new one; then the confirm screen. */
  async function onReview() {
    if (s.busy) return setStatus("Checking… one moment.", "");
    if (!s.asset) return setStatus("Choose what to send.", "bad");
    if (!s.all && !(s.amount && /^\d*\.?\d+$/.test(s.amount) && Number(s.amount) > 0)) { setStatus(WORDS.bad_amount, "bad"); try { ui.amt.focus({ preventScroll: true }); } catch { /* no focus */ } return; }
    if (!s.to) { setCheck("Paste or type the destination address.", "bad"); try { ui.to.focus({ preventScroll: true }); } catch { /* no focus */ } return; }
    if (s.to === linked()) return setCheck(WORDS.same_wallet, "bad");
    if (!isAddr(s.to)) return setCheck(WORDS.bad_address, "bad");
    clearTimeout(timer);
    const have = s.build && s.key === buildKey() && Date.now() - s.builtAt < FRESH_MS;
    const d = have ? s.build : await build({ live: false });
    if (!d) return;
    toConfirm();
  }

  /* ---------------------------------------------------------------- the confirm screen */
  function toForm() {
    s.phase = "form"; s.handle = null; s.sig = null; s.solscan = null; s.error = null; s.busy = false;
    ui.form.hidden = false; ui.confirm.hidden = true; ui.wallets.replaceChildren(); ui.links.replaceChildren(); ui.cstatus.textContent = ""; ui.cstatus.className = "small wsend__status";
    ui.go.hidden = false; ui.go.disabled = false; ui.go.textContent = "Send"; ui.back.hidden = false; ui.back.textContent = "Back";
    drawAssets();
  }
  /** The Worker's summary, word for word; the full address with its ends emphasised; the one sentence; then the wallet. */
  function toConfirm() {
    const sum = s.build.summary;
    s.phase = "confirm";
    ui.form.hidden = true; ui.confirm.hidden = false;
    ui.lines.replaceChildren(...(Array.isArray(sum.lines) ? sum.lines : []).map((t) => el("li", null, String(t))));
    const to = String(sum.to || s.to);
    ui.addr.replaceChildren(el("b", null, to.slice(0, 4)), to.slice(4, -4), el("b", null, to.slice(-4)));
    ui.addr.setAttribute("aria-label", `Destination ${to}`);
    ui.notice.textContent = `${sum.notice || "A send cannot be undone."} Check the address.`;
    ui.cstatus.textContent = ""; ui.cstatus.className = "small wsend__status"; ui.links.replaceChildren();
    ui.go.hidden = false; ui.go.disabled = true; ui.go.textContent = "Send"; ui.back.hidden = false; ui.back.textContent = "Back";
    setTimeout(() => { try { ui.ctitle.focus({ preventScroll: true }); } catch { /* no focus */ } }, 30);
    connectWallet();
  }
  const cstatus = (text, kind) => { ui.cstatus.textContent = text; ui.cstatus.className = `small wsend__status${kind ? ` is-${kind}` : ""}`; };
  const addressOf = (a) => (a && a.account && a.account.address) || null;
  /**
   * The wallet that signs: the one linked to this account, and only that one (the transaction is built from it). The Buy panel's
   * connected wallet when it is that one; inside a wallet app the account it already shares (no prompt); else the person picks one here
   * and connects it; a phone's own browser has no wallet on the page: Vicinity opens inside the wallet app instead.
   */
  async function connectWallet() {
    const n = seq, want = linked(), w = W();
    ui.wallets.replaceChildren();
    const VS = window.VSwap;
    if (VS && VS.wallet && VS.wallet.adapter && VS.wallet.address === want) return connected(VS.wallet.adapter, want);
    if (s.wallet && s.wallet.address === want && addressOf(s.wallet.adapter) === want) return connected(s.wallet.adapter, want);
    if (!w) return cstatus(WORDS.no_lp, "bad");
    const list = w.list().filter((a) => a.canSend || a.canSign);
    if (!list.length && w.isMobile) {
      // a phone's Safari / Chrome: no wallet on the page; this very page opens inside the wallet app, signed in
      ui.go.hidden = true;
      const lead = el("p", "small wsend__lead", "Sending happens in your wallet app. Open Vicinity there and send from its Wallet tab:");
      const row = el("div", "swap__deeplinks");
      const here = w.KNOWN.filter((k) => typeof k.open === "function").slice(0, 3);
      for (const k of here) { const a = el("a", "wallet-option"); a.setAttribute("href", k.open(`${location.origin}/connect?mode=login&with=${k.id}&next=${encodeURIComponent("/dashboard#wallet")}`)); a.setAttribute("rel", "noopener"); a.dataset.app = k.id; a.append(w.mark(k.name), el("span", null, `Open in ${k.name}`), el("span", "go", "↗")); row.append(a); }
      ui.wallets.append(lead, row);
      return;
    }
    if (!list.length) { ui.go.hidden = true; ui.wallets.append(el("p", "small muted", "No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload this page.")); return; }
    // inside a wallet app with one wallet: the account it already shares with this site, never a question
    if (list.length === 1 && w.inWalletApp() && typeof list[0].connectSilently === "function") {
      cstatus("Checking your wallet…", "");
      let address = null;
      try { address = await list[0].connectSilently(); } catch { address = null; }
      if (n !== seq) return;
      if (address === want) return connected(list[0], want);
      cstatus("", "");
    }
    ui.wallets.append(el("p", "small muted", `Connect the wallet linked to this account (${shortAddr(want)}) to sign:`));
    for (const a of list) {
      const b = el("button", "wallet-option"); b.type = "button";
      const icon = w.safeIcon(a.icon);
      if (icon) { const img = el("img"); img.alt = ""; img.src = icon; b.append(img); } else b.append(w.mark(a.name));
      b.append(el("span", null, a.name), el("span", "detected", a.canSend ? "Connect" : "Signs"));
      b.addEventListener("click", async () => {
        cstatus("Connecting…", "");
        let address = null;
        try { address = await a.connect(); } catch (e) { if (n !== seq) return; return cstatus(/reject|cancel|denied|declin|closed|dismiss/i.test(String(e && e.message)) ? "You closed the wallet. Nothing was sent." : "The wallet did not connect. Try again.", "bad"); }
        if (n !== seq) return;
        if (address !== want) return cstatus(`That is a different wallet (${shortAddr(address)}). Use the one linked to your account, ${shortAddr(want)}: switch accounts in your wallet and try again.`, "bad");
        connected(a, want);
      });
      ui.wallets.append(b);
    }
  }
  /**
   * The linked wallet is connected: the signing module checks that the built bytes name it as the one signer; then the Send button is
   * live. `quiet`: after a cancel in the wallet, the same details are prepared again without a word (the cancel's words stay).
   */
  async function connected(adapter, address, { quiet = false } = {}) {
    const n = seq;
    s.wallet = { adapter, address };
    ui.wallets.replaceChildren();
    if (!quiet) cstatus("Preparing…", "");
    const LP = await ensureLP();
    if (n !== seq || s.phase !== "confirm") return;
    if (!LP) return cstatus(WORDS.no_lp, "bad");
    try { s.handle = await LP.prepare({ wallet: adapter, build: async () => s.build, cluster: CLUSTER, routes: { send: ROUTES.send, status: ROUTES.status } }); }
    catch (e) { return cstatus((e && e.message) || WORDS.wrong_wallet, "bad"); }
    if (n !== seq || s.phase !== "confirm") return;
    if (!quiet) cstatus(`Connected ${shortAddr(address)}. Tap Send: your wallet asks you to confirm.`, "");
    ui.go.disabled = false; ui.go.hidden = false;
  }
  /**
   * Send: the wallet is called INSIDE this tap (a phone opens its wallet app only straight from a tap). A build that is running out is
   * made again instead, and the wallet stays shut until the next tap on the refreshed details.
   */
  function onSend() {
    if (s.phase === "done") return closeSheet();
    if (s.phase !== "confirm" || !s.handle || s.busy) return;
    if (Date.now() - s.builtAt >= FRESH_MS) return refreshBuild();
    s.phase = "signing"; ui.go.disabled = true; ui.go.textContent = "Confirm in your wallet…"; ui.back.hidden = true;
    const n = seq, handle = s.handle; s.handle = null; // one tap is one use (public/lp-sign.js)
    // the outcome belongs to this sheet: one closed and opened again meanwhile (seq moved on) is never written into
    handle.sign({ onStatus: (...a) => { if (n === seq) onStatus(...a); } }).then((r) => { if (n === seq) onDone(r.signature, r.solscan); }, (e) => { if (n === seq) onFail(e); });
  }
  async function refreshBuild() {
    const n = seq;
    s.busy = true; ui.go.disabled = true; cstatus("Checking the details again (they are kept fresh for half a minute)…", "");
    const d = await req(ROUTES.build, { to: s.to, asset: s.asset, ...(s.all ? { all: true } : { amount: s.amount }) });
    if (n !== seq) return;
    if (s.phase !== "confirm") { s.busy = false; return; } // Back was tapped meanwhile: the form is live again
    s.busy = false;
    if (!d || !d.ok || !d.tx || !d.summary) { ui.go.hidden = true; return cstatus(`${say(d)} Nothing was sent. Go back and start again.`, "bad"); }
    const same = JSON.stringify(d.summary.lines) === JSON.stringify((s.build && s.build.summary.lines) || null);
    s.build = d; s.builtAt = Date.now(); s.handle = null;
    toConfirm();
    cstatus(same ? "Details refreshed, unchanged. Tap Send again." : "Details refreshed. Check them again, then tap Send.", "");
  }
  function onStatus(stage, signature, extra) {
    if (stage === "signing") { s.phase = "signing"; cstatus("Confirm in your wallet.", ""); }
    else if (stage === "sending") { s.phase = "sending"; cstatus("Sending to the network…", ""); ui.go.textContent = "Sending…"; }
    else if (stage === "confirming") { s.phase = "confirming"; s.sig = signature || null; ui.go.textContent = "Confirming…"; cstatus(extra && extra.unclear ? "Sent, probably: the answer was unclear. Waiting for the network to say…" : "Sent. Waiting for the network to confirm…", ""); solscanLink(); }
  }
  function solscanLink() {
    ui.links.replaceChildren();
    if (!s.sig) return;
    const a = el("a", null, "View on Solscan ↗"); a.setAttribute("href", s.solscan || `https://solscan.io/tx/${s.sig}`); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener");
    ui.links.append(el("span", "mono", shortAddr(s.sig)), " · ", a);
  }
  async function onDone(signature, solscan) {
    s.phase = "done"; s.sig = signature || s.sig; s.solscan = solscan || s.solscan;
    solscanLink();
    cstatus("Confirmed ✓ Sent. Reading your balances again…", "ok");
    ui.go.disabled = false; ui.go.textContent = "Done"; ui.back.hidden = false; ui.back.textContent = "Send more";
    // dashboard.js readWallet: true once the chain was asked again (past the Worker's memo, after any read already running), false when it could not be
    let read = false;
    try { read = ctx && ctx.readWallet ? (await ctx.readWallet()) !== false : false; } catch { read = false; }
    cstatus(read ? "Confirmed ✓ Sent. Your balances show the chain as it is now." : "Confirmed ✓ Sent. Your balances could not be read again right now: tap Refresh in the Wallet tab.", "ok");
  }
  function onFail(e) {
    s.phase = "failed"; s.error = e;
    if (e && e.signature) { s.sig = e.signature; s.solscan = e.solscan || null; solscanLink(); }
    cstatus((e && e.message) || "Something went wrong. Nothing was sent.", "bad");
    ui.back.hidden = false; ui.back.textContent = "Back";
    // an outcome nobody knows (the wallet answered without an id, no answer from the site, expired by a wallet's own blockhash): never
    // offered again from this build; a cancel in the wallet, or a refusal before anything went out: the same details can be sent again
    if (e && (e.unclear || e.signature)) { ui.go.hidden = true; return; }
    ui.go.textContent = "Send"; ui.go.disabled = true; s.phase = "confirm";
    if (s.wallet) connected(s.wallet.adapter, s.wallet.address, { quiet: true }); else connectWallet();
  }

  window.VWalletSend = { init, ROUTES, words: say };
})();
