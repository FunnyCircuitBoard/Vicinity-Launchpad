// "Launch your city coin" (the dashboard's Founder tab) and "Move to the open market" (the coin page): window.LPLaunch. Needs
// site.js (window.V), wallets.js (window.VW) and lp-sign.js (window.LP). Everything here is switched off with the launchpad's
// settings: /api/official has no cityCoins key, the probe (GET /api/lp/launch/status, no city) is not even asked and nothing is
// shown, so the Raydium LaunchLab copy the dashboard always had stays (public/dashboard.js decides that from probe()).
// The Worker builds each transaction UNSIGNED for the signed-in wallet and simulates it (src/lplaunch.js); this page shows what will
// be signed and the exact SOL change BEFORE the wallet opens (LP.renderSummary); lp-sign.js has the one-time key(s) made in this
// browser (the coin's address, the two position NFTs) sign first, then the wallet signs and sends it (or, a wallet that only
// signs, signs and the site's relay sends).
// Only textContent here: nothing from the server is ever HTML. No inline script, no inline style, no element ids made.
//   LPLaunch.probe()                         -> Promise<{ on, cluster, configsSet, speedTable } | null>
//   LPLaunch.founder(card, { cityId, design })  the founder card: approved / signing / done / expired / paused / not approved
//   LPLaunch.graduate(box, { mint, ticker })    the coin page's "Move to the open market" (then the leftover step)
//   LPLaunch.pure                              the helpers test/lp-launch-ui.test.js runs in node
(() => {
  "use strict";
  const MAX_FIRST_BUY = 10_000_000_000n; // lamports (src/lplaunch.js MAX_FIRST_BUY_LAMPORTS)
  const FIRST_BUY_SLIPPAGE_BPS = 50;

  /* =====================================================================
     Pure helpers
     ===================================================================== */
  /** An amount of SOL the founder typed -> { lamports } ("" is 0), { tooLarge } past 10 SOL, or null when it is not an amount. */
  function parseSol(text) {
    const t = String(text == null ? "" : text).trim().replace(",", ".");
    if (t === "" || t === "0") return { lamports: "0" };
    const m = /^(\d{1,3})(?:\.(\d{0,9}))?$/.exec(t) || /^()\.(\d{1,9})$/.exec(t);
    if (!m) return null;
    const v = BigInt(m[1] || "0") * 1_000_000_000n + BigInt((m[2] || "").padEnd(9, "0") || "0");
    if (v > MAX_FIRST_BUY) return { tooLarge: true };
    return { lamports: v.toString() };
  }
  const solText = (lamports, max = 6) => `${(Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: max })} SOL`;
  const coinsText = (ui) => { const n = Number(ui); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(ui); };
  function dateText(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : ""; }
  function leftText(seconds) {
    const s = Number(seconds) || 0, d = Math.floor(s / 86400), h = Math.floor(s / 3600);
    return d >= 2 ? `${d} days left` : h >= 1 ? `${h} hours left` : `${Math.max(1, Math.ceil(s / 60))} minutes left`;
  }
  const NOT_APPROVED = "An admin approves your coin on chain first; your pair must be SOL.";
  /** What the card says for a status answer: { state, tag: [text, class], lines: [...], canLaunch }. */
  function view(st, design = null) {
    const s = st && st.ok ? st.state : "error";
    const ticker = st && st.coin && st.coin.symbol ? `$${st.coin.symbol}` : st && st.ticker ? `$${st.ticker}` : "your coin";
    switch (s) {
      case "ready": return { state: s, tag: ["Approved", "tag--gold"], canLaunch: true, lines: [`An admin approved ${ticker}. Launch it whenever you are ready: one signature in your wallet.`] };
      case "launched": return { state: s, tag: ["● Live", "tag--ok"], canLaunch: false, lines: [`${ticker} is live on the Vicinity launchpad.`] };
      case "expired": return { state: s, tag: ["Approval expired", "tag--warn"], canLaunch: false, lines: [st.message || "Your approval expired. Ask an admin to approve your coin again."] };
      case "paused": return { state: s, tag: ["Paused", "tag--warn"], canLaunch: false, lines: [st.message || "Launches are paused for now. Your approval stays; try again later."] };
      case "not_approved": {
        const lines = [st.message || NOT_APPROVED];
        if (design && design.pair && design.pair !== "SOL") lines.push(`Your design is paired with ${design.pair}. Pick SOL in the coin studio and save, then ask an admin to approve it.`);
        if (!design) lines.push("Design your coin first in the coin studio (its name, logo and colour), then ask an admin to approve it.");
        return { state: s, tag: ["Not approved yet", ""], canLaunch: false, lines };
      }
      default: return { state: "error", tag: [st && st.error === "founder_mismatch" ? "Wrong wallet" : "Not available", "tag--warn"], canLaunch: false,
        lines: [(st && st.message) || (window.LP ? window.LP.say(st && st.error, st || undefined) : "Something went wrong. Try again in a minute.")] };
    }
  }
  /**
   * The coin page's graduation box for a /api/lp/graduate/status answer: { action: migrate|leftover|null, title, text, cost, button }.
   * The move's text is short: the curve card right above already says the curve is full and that nobody can trade until the move.
   */
  const MIGRATE_TEXT = "Anyone signed in with a wallet can make the move now.";
  function gradView(g) {
    if (!g || !g.ok) return { action: null, title: null, text: null };
    if (g.canMigrate) return { action: "migrate", title: "Move to the open market", text: MIGRATE_TEXT, cost: g.cost && g.cost.words, button: "Move to the open market" };
    if (g.leftoverDue) return { action: "leftover", title: "One step left", text: g.message, cost: "Only the network fee (about 0.000005 SOL), plus about 0.002 SOL of rent once if the dev wallet has no account for this coin yet.", button: "Return the unsold coins" };
    return { action: null, title: g.stage === "full" ? "Moving to the open market" : null, text: g.stage === "full" ? g.message : null };
  }
  const STATUS = { signing: "Waiting for your wallet…", sending: "Sending…", confirming: "Sent. Waiting for the network to confirm…", done: "Confirmed on the blockchain.",
    // the send's outcome is not known yet (lp-sign.js: the relay's unclear: true, or no answer from the site): watched, never sent twice
    unclear: "Sent, but the network's answer did not come back. Watching the blockchain for it: do not send it again." };
  /** The status line for lp-sign.js's onStatus(state, signature, extra). */
  const statusText = (s, extra) => (s === "confirming" && extra && extra.unclear ? STATUS.unclear : STATUS[s] || s);

  const pure = { parseSol, solText, coinsText, dateText, leftText, view, gradView, statusText, NOT_APPROVED, STATUS, MIGRATE_TEXT };
  const root = typeof window !== "undefined" ? window : globalThis;
  root.LPLaunch = { pure };
  if (typeof document === "undefined" || !root.V) return; // node: the helpers are enough

  /* =====================================================================
     The page
     ===================================================================== */
  const V = root.V, el = V.el;
  const words = (r) => (r && r.message) || (root.LP ? root.LP.say(r && r.error, r || undefined) : "Something went wrong.");
  const enc = encodeURIComponent;
  let probeMemo = null;
  /**
   * Is the launch switched on here? { on, cluster, ... } or null. /api/official (asked by every page anyway, site.js V.official) says
   * cityCoins only while the settings are there; only then is the probe asked (a site without them sends no request and logs no 404).
   * Asked once per page.
   */
  function probe() {
    if (!probeMemo) {
      probeMemo = Promise.resolve(V.official).then((o) => (o && o.cityCoins ? V.api("/api/lp/launch/status") : null))
        .then((r) => (r && r.ok && r.on ? r : null)).catch(() => null);
    }
    return probeMemo;
  }
  const link = (text, href, external = false) => { const a = el("a", "lp-link", text); a.href = href; if (external) { a.target = "_blank"; a.rel = "noopener"; } return a; };
  function button(label, cls, onClick) {
    const b = el("button", cls, label); b.type = "button";
    b.addEventListener("click", async () => { if (b.disabled) return; b.disabled = true; try { await onClick(b); } finally { if (b.isConnected) b.disabled = false; } });
    return b;
  }
  const fact = (dl, label, value) => { dl.append(el("dt", null, label)); const dd = el("dd"); if (value && typeof value === "object") dd.append(value); else dd.textContent = value == null ? "—" : String(value); dl.append(dd); };
  const short = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a || ""));
  function netLine(target, cluster) {
    if (!target) return;
    target.hidden = false;
    target.className = `lp-net${cluster === "mainnet" ? " lp-net--main" : ""}`;
    target.textContent = cluster === "mainnet" ? "Solana MAINNET: real SOL" : `Solana ${cluster || "devnet"} (test network): no real money`;
  }

  /* ----- the wallet that signs: the one this account is signed in with ----- */
  /**
   * The wallet of this browser whose address is `expected` (the session's wallet), connected. With several wallets the person picks one
   * in `box`. Throws Error(plain words) when there is none here, or when the connected account is another one.
   */
  async function walletFor(expected, box) {
    const W = root.VW;
    const list = W ? W.list().filter((w) => w.canSign !== false) : [];
    if (!list.length) {
      const phantom = W && W.KNOWN ? W.KNOWN.find((k) => k.id === "phantom") : null;
      const e = new Error(W && W.isMobile ? "No wallet in this browser. Open this page in your wallet app (Phantom) and sign there." : "No wallet found in this browser. Install Phantom (or another Solana wallet that can sign), or open this page in your wallet app.");
      if (phantom && W.isMobile) e.open = phantom.open(location.href);
      throw e;
    }
    const ready = list.find((w) => w.account && w.account.address === expected);
    if (ready) return ready;
    const check = async (w) => {
      const a = await w.connect();
      if (a !== expected) throw new Error(`Your wallet is on ${short(a)}, but you are signed in with ${short(expected)}. Switch accounts in your wallet, then start again.`);
      return w;
    };
    if (list.length === 1) return check(list[0]);
    return new Promise((resolve, reject) => {
      const row = el("div", "lp-wallets");
      row.append(el("p", "small", `Pick the wallet that holds ${short(expected)}:`));
      for (const w of list) row.append(button(`Use ${w.name}`, "btn btn--glass btn--sm", async () => { try { resolve(await check(w)); } catch (e) { reject(e); } }));
      row.append(button("Cancel", "link-btn", () => reject(new Error("Stopped. Nothing was sent."))));
      box.replaceChildren(row);
    });
  }

  /**
   * One signature, in `box`: build through `build(keys)` (the Worker checks and simulates), show the decoded list and the SOL change,
   * then "Approve in your wallet". Resolves to the relay's result after `onDone`, or null when it stopped (the reason is on screen).
   */
  async function runStep(box, { expected, cluster, ephemeral = 0, build, approve = "Approve in your wallet", onDone }) {
    box.replaceChildren(el("p", "muted small", "Preparing: the site builds this transaction and tries it on the blockchain first. Nothing is sent yet."));
    let h;
    try {
      if (ephemeral && !(await root.LP.supported())) throw new Error(root.LP.say("unsupported"));
      const wallet = await walletFor(expected, box);
      box.replaceChildren(el("p", "muted small", "Preparing: the site builds this transaction and tries it on the blockchain first. Nothing is sent yet."));
      h = await root.LP.prepare({ wallet, ephemeral, cluster, build });
    } catch (e) {
      const p = el("p", "lp-error", e && e.message ? e.message : "This could not be prepared. Nothing was sent.");
      box.replaceChildren(p);
      if (e && e.open) box.append(link("Open in Phantom", e.open));
      return null;
    }
    const sum = el("div", "lp-sum");
    root.LP.renderSummary(sum, h.response);
    const line = el("p", "lp-status"); line.setAttribute("role", "status");
    return new Promise((resolve) => {
      const cancel = button("Cancel", "btn btn--glass btn--sm", () => { box.replaceChildren(el("p", "muted small", "Stopped. Nothing was sent.")); resolve(null); });
      const go = button(approve, "btn btn--primary", async () => {
        cancel.disabled = true;
        try {
          const r = await h.sign({ onStatus: (s, _sig, extra) => { line.textContent = statusText(s, extra); } });
          go.remove(); cancel.remove();
          if (r.solscan) line.append(" ", link("See it on Solscan", r.solscan, true));
          if (onDone) await onDone(r, h.response);
          resolve(r);
        } catch (e) {
          line.textContent = e && e.message ? e.message : "Something went wrong. Nothing was sent.";
          if (e && e.signature && e.solscan) line.append(" ", link("Check it on Solscan", e.solscan, true));
          cancel.disabled = false;
          if (e && e.signature) { go.remove(); resolve(null); } // it may have landed: never offer to send it twice
        }
      });
      const row = el("div", "lp-row"); row.append(go, cancel);
      box.replaceChildren(sum, row, line);
      try { go.focus(); } catch { /* not on screen yet */ }
    });
  }

  /* =====================================================================
     The founder card (dashboard)
     ===================================================================== */
  /** Record the launched coin on the site (it reads the chain; a few tries while the network settles). */
  async function record(cityId) {
    for (let i = 0; i < 6; i++) {
      const r = await V.api("/api/lp/record", { cityId: String(cityId) });
      if (r && r.ok) return r;
      if (!r || !["not_launched", "rpc_unavailable", "offline", "unavailable"].includes(r.error)) return r;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    return null;
  }

  /**
   * Fill `card` (#lp-launch: [data-lp-state], [data-lp-net], [data-lp-body]) for the signed-in founder of `cityId`. { on, state }.
   * `onChange(result)` runs after the card refreshed itself because something landed (a launch, a fee collection).
   */
  async function founder(card, opts = {}) {
    const { cityId, design = null } = opts;
    const p = await probe();
    if (!p) { card.hidden = true; return { on: false }; }
    const body = card.querySelector("[data-lp-body]"), tag = card.querySelector("[data-lp-state]");
    const st = await V.api(`/api/lp/launch/status?city=${enc(cityId)}&cluster=${enc(p.cluster)}`);
    if (st && st.error === "not_enabled") { card.hidden = true; return { on: false }; }
    card.hidden = false;
    netLine(card.querySelector("[data-lp-net]"), p.cluster);
    const v = view(st, design);
    tag.textContent = v.tag[0]; tag.className = `tag ${v.tag[1]}`.trim();
    const title = card.querySelector("h2");
    if (title) title.textContent = v.state === "launched" ? "Your city coin" : "Launch your city coin";
    body.replaceChildren(...v.lines.map((t) => el("p", v.state === "error" ? "lp-error" : "small", t)));
    const again = async () => { const r = await founder(card, opts); if (typeof opts.onChange === "function") opts.onChange(r); return r; };
    if (v.state === "ready") readyView(body, st, p, again);
    else if (v.state === "launched") launchedView(body, st, p, again);
    return { on: true, state: v.state };
  }

  function readyView(body, st, p, again) {
    const ticker = `$${st.coin.symbol}`;
    const head = el("p", "lp-coin");
    head.append(el("strong", "lp-coin__name", st.coin.name), " ", el("span", "lp-coin__tk", ticker), " ", el("span", "muted", "· paired with SOL"));
    const dl = el("dl", "lp-facts");
    fact(dl, "Fees on every trade", st.fees.words);
    fact(dl, "Approved until", `${dateText(st.approval.expiresAt)} (${leftText(st.approval.secondsLeft)})`);
    fact(dl, "What it costs you", st.cost.words);
    fact(dl, "Your wallet", short(st.wallet));
    body.append(head, dl);
    // the optional first buy, with its exact quote (the curve's start is fixed, so the quote is exact)
    let buy = { lamports: "0" };
    const quote = el("p", "small lp-quote"); quote.setAttribute("role", "status");
    if (st.firstBuy && st.firstBuy.allowed) {
      const label = el("label", "lp-buy");
      const input = el("input", "field lp-buy__input");
      input.setAttribute("type", "text"); input.setAttribute("inputmode", "decimal"); input.setAttribute("autocomplete", "off"); input.placeholder = "0";
      label.append(el("span", null, `Buy some ${ticker} right away (optional, up to 10 SOL)`), input);
      body.append(label, quote);
      let seq = 0, timer = 0;
      input.addEventListener("input", () => {
        clearTimeout(timer);
        const mine = ++seq;
        buy = parseSol(input.value);
        if (!buy) { quote.textContent = "Type an amount of SOL, like 0.5."; return; }
        if (buy.tooLarge) { quote.textContent = "The first buy is at most 10 SOL."; return; }
        if (buy.lamports === "0") { quote.textContent = ""; return; }
        quote.textContent = "Working out the exact amount…";
        timer = setTimeout(async () => {
          const r = await V.api(`/api/lp/launch/status?city=${enc(st.cityId)}&cluster=${enc(p.cluster)}&buy=${enc(buy.lamports)}&slippageBps=${FIRST_BUY_SLIPPAGE_BPS}`);
          if (mine !== seq) return; // a newer amount was typed meanwhile
          if (r && r.ok && r.quote) quote.textContent = `You get exactly ${coinsText(r.quote.coinsOutUi)} ${ticker} for ${solText(r.quote.amountInLamports)} (the 1.25% fee included), in the same transaction as the launch.`;
          else quote.textContent = (r && (r.quoteError || r.message)) || words(r);
        }, 400);
      });
    } else if (st.firstBuy && st.firstBuy.reason) body.append(el("p", "small muted", st.firstBuy.reason));
    const flow = el("div", "lp-flow");
    const go = button(`Launch ${ticker}`, "btn btn--primary lp-go", async () => {
      if (!buy) { quote.textContent = "Type an amount of SOL, like 0.5, or leave it empty."; return; }
      if (buy.tooLarge) { quote.textContent = "The first buy is at most 10 SOL."; return; }
      go.hidden = true;
      const r = await runStep(flow, {
        expected: st.wallet, cluster: p.cluster, ephemeral: 1, approve: `Approve the launch in your wallet`,
        build: (keys) => V.api("/api/lp/launch/tx", { cityId: st.cityId, cluster: p.cluster, mint: keys[0], firstBuyLamports: buy.lamports, slippageBps: FIRST_BUY_SLIPPAGE_BPS }),
        onDone: async () => {
          flow.append(el("p", "lp-status", "Your coin is live. Recording it on vicinity.city…"));
          const rec = await record(st.cityId);
          if (V.toast) V.toast(`${ticker} is live`);
          await again();
          if (!rec || !rec.ok) body.append(el("p", "small muted", "vicinity.city records it by itself within 30 minutes."));
        },
      });
      if (!r) go.hidden = false;
    });
    body.append(go, flow);
  }

  function launchedView(body, st, p, again) {
    // the chain's symbol, else the city's ticker (the launched status names it as `ticker`); never "Your coin Your coin is live."
    const sym = (st.coin && st.coin.symbol) || st.ticker || null;
    body.replaceChildren(el("p", "lp-live", sym ? `Your coin $${sym} is live.` : "Your coin is live."));
    const mint = el("p", "small mono lp-addr", st.mint);
    const links = el("p", "lp-links");
    links.append(link("Open your coin's page", st.coinPage), " · ", link("See it on Solscan", st.explorer, true));
    body.append(mint, links);
    const f = st.founderFees;
    if (!st.yours) { body.append(el("p", "small muted", "The coin's founder on chain is another wallet, so its founder fees are not collected from here.")); return; }
    if (!f) return;
    body.append(el("p", "small", `Your founder fees: ${solText(f.totalLamports)} waiting for you (a quarter of a percent of every trade).`));
    if (BigInt(f.totalLamports || "0") > 0n) {
      const flow = el("div", "lp-flow");
      const go = button("Collect your fees", "btn btn--glass btn--sm", async () => {
        go.hidden = true;
        const r = await runStep(flow, {
          expected: st.wallet, cluster: p.cluster, approve: "Approve in your wallet",
          build: () => V.api("/api/lp/founder-claim/tx", { cityId: st.cityId, cluster: p.cluster }),
          onDone: async () => { if (V.toast) V.toast("Fees collected"); await again(); },
        });
        if (!r) go.hidden = false;
      });
      body.append(go, flow);
    }
  }

  /* =====================================================================
     "Move to the open market" (coin page)
     ===================================================================== */
  /** Fill `box` ([data-lp-grad-title], [data-lp-grad-text], [data-lp-grad-body]) for a launchpad coin; hidden when there is nothing to do. */
  async function graduate(box, { mint, ticker = null } = {}) {
    const p = await probe();
    if (!p) { box.hidden = true; return null; }
    const g = await V.api(`/api/lp/graduate/status?mint=${enc(mint)}&cluster=${enc(p.cluster)}`);
    const v = gradView(g);
    const title = box.querySelector("[data-lp-grad-title]"), text = box.querySelector("[data-lp-grad-text]"), body = box.querySelector("[data-lp-grad-body]");
    if (!v.title) { box.hidden = true; return g; }
    box.hidden = false;
    title.textContent = v.title; text.textContent = v.text || "";
    body.replaceChildren();
    if (!v.action) return g;
    body.append(el("p", "small muted", `Cost: ${v.cost}`));
    const flow = el("div", "lp-flow");
    const go = button(v.button, v.action === "migrate" ? "btn btn--primary" : "btn btn--glass", async () => {
      const me = await V.api("/api/me?lite=1"); // asked on the tap: signed in a moment ago in another tab counts
      if (!me || !me.signedIn) { flow.replaceChildren(el("p", "small", "Sign in with your wallet first: the wallet you signed in with pays."), link("Sign in", `/connect?mode=login&next=${enc(location.pathname + location.search)}`)); return; }
      if (!me.user || !me.user.wallet) { flow.replaceChildren(el("p", "small", "Link a wallet to your account first (Dashboard, Home): that wallet pays."), link("Go to the dashboard", "/dashboard#wallet-card")); return; }
      go.hidden = true;
      const r = await runStep(flow, {
        expected: me.user.wallet, cluster: p.cluster, ephemeral: v.action === "migrate" ? 2 : 0,
        approve: v.action === "migrate" ? "Approve the move in your wallet" : "Approve in your wallet",
        build: (keys) => V.api("/api/lp/graduate/tx", { mint, cluster: p.cluster, step: v.action, ...(v.action === "migrate" ? { nft1: keys[0], nft2: keys[1] } : {}) }),
        onDone: async () => { if (V.toast) V.toast(v.action === "migrate" ? `${ticker ? `$${ticker}` : "The coin"} is on the open market` : "Done"); await graduate(box, { mint, ticker }); },
      });
      if (!r) go.hidden = false;
    });
    body.append(go, flow);
    return g;
  }

  Object.assign(root.LPLaunch, { probe, founder, graduate, _walletFor: walletFor, _runStep: runStep });
})();
