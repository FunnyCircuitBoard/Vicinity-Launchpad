// Connect page. Today's sign-up (SIGNUP_FLOW unset): 1. prove the wallet (sign a message / phone QR / tiny transfer)  2. Google or
// e-mail  3. dashboard. With the new sign-up on (/api/me says signupFlow "v2") this file loads public/signup.js, which runs the
// two-step sign-up, the Log in tab and the LINK MODE (a member without a wallet links one); the wallet screens here (pick, sign,
// phone, app, approve) serve all of them, and hand the wallet's answer to signup.walletProven().
// Needs site.js (window.V), wallets.js (window.VW) and vendor/qrcode.js (window.qrcode).
(() => {
  "use strict";
  const { $, $$, el, api, toast, copy, short, isAddr, burst } = window.V;
  const W = window.VW;
  const params = new URLSearchParams(location.search);
  const pairCode = params.get("pair");
  // "Open app" on a phone brought a one-time code here from Safari / Chrome (site.js already took it out of the address bar): a link
  // code (the wallet app links this wallet to the account that made it), or an old sign-up's carry code (only a calm line now)
  const carryCode = window.V.takeCarry ? window.V.takeCarry() : null;
  const linkCode = window.V.takeLink ? window.V.takeLink() : null;
  const panel = $("#connect-panel");
  let state = "pick", active = null, address = null, message = null, pairPin = null, pairPurpose = "login", providers = { google: false, email: false };
  let signup = null; // the v2 sign-up controller (public/signup.js): stays null unless /api/me says signupFlow is "v2", so today's page runs untouched

  const ERR = {
    social_taken: "That Google account is already linked to a different wallet. Sign in with the wallet it's linked to, or use another account.",
    wallet_taken: "This wallet is already linked to another account. Sign in with that account instead.",
    wallet_first: "That login isn't linked to a Vicinity account yet. New here? Connect your wallet below first, then link that login in step 2.",
    login_unavailable: "Log in with Google is being switched on. Please check back soon, or use e-mail or your wallet.",
    login_cancelled: "Sign-in was cancelled. Nothing changed.",
    login_failed: "The sign-in didn't go through. Please try again.",
    login_expired: "That sign-in took too long or was opened in another tab. Please try again.",
  };
  /**
   * The wallet error line. `near` = the control that failed: the line moves right under it, so the person sees it where they
   * pressed (a phone can be scrolled far from the top of the panel), and it is brought into view and read out (role="alert").
   * Without `near` it sits in its usual place: under the step bar in the new sign-up, at the end of the panel otherwise.
   */
  function setErr(m, near) {
    const e = $("#c-error");
    if (!m) { e.textContent = ""; e.hidden = true; return; }
    if (shown(near)) near.after(e); else (signup ? $("#su-top") : panel).append(e);
    e.textContent = m; e.hidden = false;
    reveal(e);
  }
  /** A calm "still waiting" line under a control (not an error: read out politely, role="status"). */
  function setWait(m, near) {
    const w = $("#c-wait");
    if (!m) { w.textContent = ""; w.hidden = true; return; }
    if (shown(near)) near.after(w); else (signup ? $("#su-top") : panel).append(w);
    w.textContent = m; w.hidden = false;
    reveal(w);
  }
  const shown = (x) => Boolean(x && x.isConnected && (!x.getClientRects || x.getClientRects().length));
  /** Scrolls a message into view when it is off screen (or under the phone's bottom menu bar). */
  function reveal(e) {
    const r = e.getBoundingClientRect(), h = window.innerHeight || document.documentElement.clientHeight;
    if (r.top < 8 || r.bottom > h - 90) e.scrollIntoView({ block: "center", behavior: window.V.reduced ? "auto" : "smooth" });
  }
  // The e-mail form moves between the log-in block and the sign-up step, so its errors live INSIDE the form (right next to the input).
  const setEmailErr = (m) => { const e = $("#email-error"); e.textContent = m || ""; e.hidden = !m; };
  const hasAccount = () => { try { return localStorage.getItem("vicinity-account") === "1"; } catch { return false; } };
  /** Returning people (the header's Log in button, or an account remembered on this device) get a "welcome back" top. */
  function welcomeBack() {
    $(".connect__intro .kicker").textContent = "Welcome back";
    const title = $(".connect__intro .page-title"), accent = el("span", "accent", "Your city's waiting.");
    title.replaceChildren("Log in.", el("br"), accent);
    $(".connect__intro .lead").textContent = "Log in with the Google account or e-mail you signed up with, or with your wallet. New here? Use your wallet to create your account.";
  }
  const cancelled = (e) => /reject|cancel|denied|declin|closed/i.test(String(e?.message || e)) || e?.code === 4001;

  function show(s) {
    if (state === "phone" && s !== "phone") { pairPoll = null; forgetPair(); } // the pairing was used, or the person left it (Back, another way)
    state = s; screenGen++;
    $$(".cstate", panel).forEach((x) => (x.hidden = x.dataset.state !== s));
    setErr("");
    forget(); // a wallet request still open belongs to the screen being left: a late answer to it counts for nothing
    const step = s === "social" ? 2 : s === "done" ? 3 : 1;
    $$("#stepper li").forEach((li) => { const n = Number(li.dataset.s); li.classList.toggle("is-active", n === step); li.classList.toggle("is-done", n < step); });
    if (signup) signup.onShow(s);
  }

  /* ---------- wallet buttons ---------- */
  function walletButton(adapter, onClick) {
    const b = el("button", "wallet-option"); b.type = "button";
    const icon = W.safeIcon(adapter.icon);
    if (icon) { const img = el("img"); img.alt = ""; img.src = icon; b.append(img); } else b.append(W.mark(adapter.name));
    b.append(el("span", null, adapter.name), el("span", "detected", "Detected"));
    b.addEventListener("click", () => onClick(adapter, b));
    return b;
  }
  /**
   * Phones: open this page inside the wallet app. Computers: get the wallet. `carry` (the new sign-up at its wallet step on a
   * phone): the tile first makes a one-time code, so the wallet app's browser carries on with THIS sign-up (public/signup.js).
   */
  function knownTile(k, target, carry) {
    if (carry && W.isMobile && k.open) {
      const b = el("button", "wallet-option"); b.type = "button";
      b.append(W.mark(k.name), el("span", null, k.name), el("span", "go", "Open app"));
      b.addEventListener("click", () => carry(k, b));
      return b;
    }
    const a = el("a", "wallet-option");
    a.append(W.mark(k.name), el("span", null, k.name));
    if (W.isMobile && k.open) { a.href = k.open(target); a.append(el("span", "go", "Open app")); }
    else { a.href = k.site; a.target = "_blank"; a.rel = "noopener"; a.append(el("span", "go", "Get")); }
    return a;
  }
  /** The "Already a member? Log in" block: Google or e-mail. Google can't run inside wallet apps. */
  function renderLogin() {
    if (signup) return; // v2 draws its own Log in block
    const inApp = W.inWalletApp();
    $("#login-google").hidden = !providers.google || inApp;
    $("#login-email").hidden = !providers.email;
    $("#login-off").hidden = Boolean(providers.google || providers.email);
    $("#login-inapp").hidden = !(inApp && providers.google);
    mountEmail("login");
  }
  $("#login-copy").addEventListener("click", () => copy(`${location.origin}/connect`, "Link copied. Paste it in Safari or Chrome."));
  function renderPick() {
    renderLogin();
    const list = W.list();
    $("#wallets-detected").replaceChildren(...list.map((a) => walletButton(a, connectWith)));
    $("#wallets-none").hidden = list.length > 0;
    const rest = W.KNOWN.filter((k) => !list.some((a) => k.match.test(a.name)));
    // a phone (the new sign-up): the wallet apps that can open this page come first; the ones still to install wait behind a second
    // "More wallets" (#wallets-more), so "Wallet on my phone" and "Skip for now" are not 17 rows down. Today's page keeps its one list.
    const split = Boolean(signup) && W.isMobile;
    const order = split ? rest.filter((k) => k.open) : W.isMobile ? rest.filter((k) => k.open).concat(rest.filter((k) => !k.open)) : rest;
    const others = split ? rest.filter((k) => !k.open) : [];
    const carry = signup ? signup.carrier() : null;
    $("#wallets-known").replaceChildren(...order.map((k) => knownTile(k, location.origin + "/connect", carry)));
    const more = $("#wallets-more");
    if (more) { more.hidden = !others.length; $("#wallets-rest").replaceChildren(...others.map((k) => knownTile(k, location.origin + "/connect", null))); }
    $("#wallets-known").classList.toggle("wallet-grid--apps", Boolean(W.isMobile && !list.length)); // a phone's only way on: full rows that say "Open app"
    $("#more-label").textContent = W.isMobile && !list.length ? "Open Vicinity in your wallet app" : list.length ? "More wallets" : "Get a wallet";
    // "Wallet on my phone" on the phone itself: no code to scan, its wallet apps open the approval (openPair)
    $("#alt-phone em").textContent = samePhone() ? "Approve in your wallet app, then finish here." : "Scan a code with your phone, sign there, continue here.";
    $("#more-wallets").open = list.length === 0;
    if (signup) signup.onShow("pick"); // a wallet turning up changes whether this is a wallet app (Google hidden)
  }
  W.onChange(() => { if (state === "pick") renderPick(); if (state === "approve") renderApprove(); });

  /* ---------- waiting for the wallet: never in silence ---------- */
  // A wallet can leave a request unanswered (its window closed with the X, hidden behind the browser, the app switched away):
  // after HINT_MS the page says where to look; after GIVE_UP_MS the button works again with a plain message. An answer that
  // comes later still counts, unless the person pressed again (a newer attempt) or left the screen.
  const HINT_MS = 8000, GIVE_UP_MS = 30000;
  let attempt = 0, waits = [];
  // The sign screen: which wallet requests are still open (by attempt), and the screen they belong to. A late signature counts as
  // long as the person is still on that screen, nothing went through yet, and no NEWER request is still open in the wallet: so an
  // approval given after the 30 s message still counts even if the person pressed again and the wallet refused that second one.
  let screenGen = 0, signedOn = -1;
  const openSigns = new Set();
  const later = (fn, ms) => waits.push(setTimeout(fn, ms));
  function stopWaits() { waits.forEach(clearTimeout); waits = []; setWait(""); }
  function forget() { attempt++; stopWaits(); resetSign(); }
  const signLabel = () => (signup ? signup.signLabel() : "Sign in");
  function resetSign() { const b = $("#c-sign"); b.disabled = false; b.removeAttribute("aria-busy"); b.textContent = signLabel(); }
  const nameOf = (a) => (a && a.name) || "your wallet";
  /** Where a wallet's request shows: computers keep it behind the wallet's icon in the browser's toolbar. */
  const lookFor = (name) => (W.isMobile ? `Look for the ${name} request on your screen.` : `No ${name} window? Click the ${name} icon in your browser's toolbar (top right).`);
  const busyTile = (tile, on) => {
    if (!tile) return;
    tile.dataset.at = String(Date.now());
    if (on) tile.setAttribute("aria-busy", "true"); else tile.removeAttribute("aria-busy");
    const t = tile.querySelector(".detected");
    if (t) t.textContent = on ? "Waiting…" : "Detected";
  };

  async function connectWith(adapter, tile) {
    if (tile && tile.getAttribute("aria-busy") === "true" && Date.now() - Number(tile.dataset.at || 0) < 1500) return; // a double tap
    forget(); setErr("");
    const my = attempt, name = nameOf(adapter), near = $("#wallets-detected");
    busyTile(tile, true);
    later(() => { if (my === attempt) setWait(`Waiting for ${name} to connect. ${lookFor(name)}`, near); }, HINT_MS);
    later(() => {
      if (my !== attempt) return;
      setWait(""); busyTile(tile, false);
      setErr(`${name} hasn't answered yet. ${lookFor(name)} Or tap ${name} again.`, near);
    }, GIVE_UP_MS);
    try {
      const addr = await adapter.connect();
      if (my !== attempt) return; // the person moved on (another wallet, another screen)
      address = addr; active = adapter;
      $("#c-addr").textContent = short(address);
      $("#c-wallet").textContent = adapter.name;
      show("sign");
      await loadMessage();
    } catch (e) {
      if (my !== attempt) return;
      forget(); busyTile(tile, false);
      setErr(cancelled(e) ? "Connection cancelled in your wallet." : `Couldn't connect to ${name}. Please try again.`, near);
    }
  }

  /**
   * The exact text the wallet signs. A login statement, or (the link mode, and the approval of a link pairing) the LINK statement that
   * names the account the wallet joins: the server hands it out for the signed-in person, or for the owner of the pairing (&pair=).
   */
  async function loadMessage(pin) {
    message = null; $("#c-msg").textContent = "Loading…";
    const link = (signup && signup.linkMode()) || (pin && pairPurpose === "link");
    const q = `address=${encodeURIComponent(address)}&action=${link ? "link" : "login"}${pin ? "&pin=" + pin : ""}${pin && link ? "&pair=" + encodeURIComponent(pairCode) : ""}`;
    const d = await api(`/api/message?${q}`);
    if (d.message) { message = d.message; $("#c-msg").textContent = d.message; }
    else $("#c-msg").textContent = "Couldn't load the message. Try again.";
    return message;
  }
  /** Our own sentences (they are shown as they are); anything else a wallet throws gets a plain one (signError). */
  const ours = (text) => Object.assign(new Error(text), { ours: true });
  /** The wallet signs the message, the server checks it. isCurrent() false = the person moved on: nothing is sent. */
  async function signIn(pair, isCurrent = () => true) {
    const wallet = active, addr = address;
    const msg = message || await loadMessage(pair ? pairPin : null);
    try {
      if (!msg) throw ours("Couldn't prepare the message. Please try again.");
      const sig = await wallet.signMessage(new TextEncoder().encode(msg));
      if (!isCurrent()) throw Object.assign(new Error("moved on"), { stale: true });
      const body = { address: addr, message: msg, signature: btoa(String.fromCharCode(...sig)) };
      if (pair) body.pair = pair;
      const d = await api("/api/auth/wallet", body);
      if (!d.ok && signup && signup.handles(d.error)) return d; // no account for this wallet, a wallet already linked...: the sign-up page says what to do
      // (pairing: "where you started" is a computer, or Safari / Chrome on this same phone)
      if (!d.ok) throw ours(d.error === "expired" ? "That message expired. Please sign again." : d.error === "pair_expired" ? "That code expired. Go back to where you started and try again." : d.error === "pin_mismatch" ? "The check number doesn't match. Go back to where you started and try again." : d.error === "offline" ? "Couldn't reach Vicinity. Check your connection and try again." : "Sign-in failed. Please try again.");
      return d;
    } finally { if (message === msg) message = null; }
  }
  function signError(err, name) {
    if (err && err.ours) return err.message;
    if (cancelled(err)) return "Signing cancelled in your wallet. Nothing happened.";
    return `${name} couldn't sign the message. Please try again, or use another wallet.`;
  }
  /** Hint, then a plain message, while a wallet request is open (see HINT_MS). `again` = what to press to ask once more. */
  function watchWallet(my, name, near, again, onGiveUp) {
    later(() => { if (my === attempt) setWait(`Waiting for ${name} to sign. ${lookFor(name)}`, near); }, HINT_MS);
    later(() => {
      if (my !== attempt) return;
      setWait(""); onGiveUp();
      setErr(`${name} hasn't answered yet. ${W.isMobile ? `Approve the request in ${name}` : `Open ${name} (its icon in your browser's toolbar) and approve the request`}, or ${again} to ask again.`, near);
    }, GIVE_UP_MS);
  }
  $("#c-sign").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    forget(); setErr("");
    const my = attempt, scr = screenGen, name = nameOf(active);
    openSigns.add(my);
    const live = () => scr === screenGen && signedOn !== scr && ![...openSigns].some((a) => a > my);
    btn.disabled = true; btn.setAttribute("aria-busy", "true"); btn.textContent = "Check your wallet…";
    watchWallet(my, name, btn, `press ${signLabel()}`, resetSign);
    try {
      const d = await signIn(null, () => { openSigns.delete(my); return live(); });
      if (!live()) return; // the person left this screen meanwhile
      signedOn = scr;
      stopWaits(); setErr(""); after(d); // the button stays busy while the page moves on
    } catch (err) {
      openSigns.delete(my);
      if (err && err.stale) return;
      if (my !== attempt && !live()) return; // a newer request owns the button and the message line
      forget();
      setErr(signError(err, name), btn);
      loadMessage();
    }
  });

  /** The wallet is proven: straight to the dashboard (linked before) or on to Google / e-mail. v2: the sign-up page decides (link, sign in, no account). */
  function after(d) {
    if (signup) return signup.walletProven(d);
    if (String(d.next || "").startsWith("/dashboard")) {
      show("done");
      const r = panel.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + 80);
      setTimeout(() => location.assign("/dashboard"), 900);
    } else showSocial(d.wallet || address);
  }
  function showSocial(wallet) {
    const inApp = W.inWalletApp();
    $("#s-addr").textContent = short(wallet);
    $("#go-google").hidden = !providers.google || inApp; // Google refuses to run inside a wallet app's browser
    $("#go-email").hidden = !providers.email;
    mountEmail("social");
    $("#social-off").hidden = Boolean(providers.google || providers.email);
    $("#social-inapp").hidden = !(inApp && providers.google);
    show("social");
  }

  $("#s-restart").addEventListener("click", async () => { await api("/api/auth/logout", {}); active = null; address = null; show("pick"); renderPick(); });

  /* ---------- e-mail codes ---------- */
  // ONE e-mail form + code step serves both places ("Already a member? Log in" and the sign-up step 2): it is moved
  // into whichever block is showing, and the button group that opened it is hidden while it is open.
  let emailAddr = "";
  const groupOf = { login: "#login-social", social: "#go-social" };
  function mountEmail(where) {
    const slot = $(`#${where}-email-slot`);
    if (slot.contains($("#email-form"))) return; // already here (a wallet appearing re-renders the page: don't close a form being typed in)
    slot.append($("#email-form"));
    $("#email-form").hidden = true;
    $("#email-step-address").hidden = false;
    $("#email-step-code").hidden = true;
    $(groupOf.login).hidden = false; $(groupOf.social).hidden = false;
  }
  function openEmail(where) {
    setErr(""); setEmailErr("");
    mountEmail(where);
    $("#email-form").hidden = false;
    $(groupOf[where]).hidden = true;
    $("#email-addr").focus();
  }
  $("#go-email").addEventListener("click", () => openEmail("social"));
  $("#login-email").addEventListener("click", () => openEmail("login"));
  async function emailSend() {
    setErr(""); setEmailErr("");
    emailAddr = $("#email-addr").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailAddr)) { setEmailErr("That doesn't look like an e-mail address."); return; }
    const btn = $("#email-send"); btn.disabled = true; btn.textContent = "Sending…";
    try {
      const d = await api("/api/auth/email/start", { email: emailAddr });
      if (!d.ok) throw new Error(d.error);
      $("#email-sent-to").textContent = emailAddr;
      $("#email-step-address").hidden = true;
      $("#email-step-code").hidden = false;
      $("#email-code").value = "";
      $("#email-code").focus();
    } catch (e) { setEmailErr(emailErr(e.message)); }
    finally { btn.disabled = false; btn.textContent = "Send me a code"; }
  }
  async function emailVerify() {
    setErr(""); setEmailErr("");
    const code = $("#email-code").value.replace(/\D/g, "").slice(0, 6);
    if (code.length !== 6) { setEmailErr("Enter the 6-digit code from the e-mail."); return; }
    const btn = $("#email-verify"); btn.disabled = true; btn.textContent = "Checking…";
    try {
      const d = await api("/api/auth/email/verify", { email: emailAddr, code });
      if (!d.ok) throw new Error(d.error + (d.left != null ? ":" + d.left : ""));
      location.assign(d.next || "/dashboard");
    } catch (e) { setEmailErr(emailErr(e.message)); }
    finally { btn.disabled = false; btn.textContent = "Verify"; }
  }
  function emailErr(code) {
    const [c, left] = String(code).split(":");
    return {
      bad_email: "That doesn't look like an e-mail address.",
      email_unavailable: "E-mail sign-in is being switched on. Please check back soon.",
      too_soon: "A code was just sent — wait a minute before asking for another.",
      too_many: "Too many tries. Wait an hour, then ask for a new code.",
      code_expired: "That code expired. Send a new one.",
      code_wrong: `That code doesn't match. ${left} ${left === "1" ? "try" : "tries"} left.`,
      bad_code: "Enter the 6-digit code from the e-mail.",
      social_taken: "That e-mail is already linked to a different wallet. Sign in with the wallet it's linked to, or use another address.",
      wallet_taken: "This wallet is already linked to another account. Sign in with that account instead.",
      wallet_first: "That e-mail isn't linked to a wallet yet. Connect your wallet first, then verify your e-mail.",
    }[c] || "Something went wrong. Please try again.";
  }
  $("#email-form").addEventListener("submit", (e) => { e.preventDefault(); emailSend(); });
  $("#email-verify").addEventListener("click", emailVerify);
  $("#email-resend").addEventListener("click", emailSend);
  $("#email-code").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); emailVerify(); } });
  $$("[data-back]").forEach((b) => b.addEventListener("click", () => { clearTimeout(timer); show("pick"); renderPick(); })); // show() also drops a request still open

  /* ---------- wallet on a phone: the computer shows a QR code ---------- */
  let timer = null;
  function drawQR(canvas, text) {
    const ctx = canvas.getContext("2d");
    if (typeof window.qrcode !== "function") { canvas.replaceWith(Object.assign(el("a", "chip-link", "Open this link on your phone"), { href: text })); return; }
    const q = window.qrcode(0, "M"); q.addData(text); q.make();
    const n = q.getModuleCount(), quiet = 2, cells = n + quiet * 2, scale = Math.max(2, Math.floor(464 / cells));
    canvas.width = canvas.height = cells * scale;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0B1626";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  }
  let pairPoll = null; // the running "has the phone approved?" question, asked again at once when this page comes back on screen
  // The pairing waiting here is kept in this tab's sessionStorage (never localStorage, the address bar or a log): iOS often throws a
  // Safari tab away while the person is in the wallet app, and the reloaded page must still find the approval just given there.
  // { code, pin, until, for: "signup" | "login" (the v2 tab it was started on) | "connect" (today's page), name, relay }. Forgotten
  // only on a definite answer: it was used, it ran out, the person left the pairing screen (Back, another way), or the page loaded
  // fine and is somewhere else now. A request that fails while the reloaded page starts (a phone's network waking up after the
  // app switch) keeps it for the next load.
  const PAIR_KEY = "vicinity-pair";
  // While one is kept, the browser does not put a reloaded tab back where the old page was scrolled to (it would scroll the pairing
  // screen's heading away again, after resumePair brought it into view): history.scrollRestoration is "manual" until it is forgotten.
  const restoreScroll = (how) => { try { if ("scrollRestoration" in history) history.scrollRestoration = how; } catch { /* ignore */ } };
  const savePair = (p) => { try { sessionStorage.setItem(PAIR_KEY, JSON.stringify(p)); restoreScroll("manual"); } catch { /* private mode: it works without */ } };
  const forgetPair = () => { try { sessionStorage.removeItem(PAIR_KEY); } catch { /* ignore */ } restoreScroll("auto"); };
  function savedPair() {
    let p = null;
    try { p = JSON.parse(sessionStorage.getItem(PAIR_KEY) || "null"); } catch { return null; }
    return p && typeof p.code === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(p.code) && Number.isFinite(p.until) && typeof p.pin === "string" ? p : null;
  }
  /** On a phone the code can't be scanned by the phone itself: its wallet apps open the link instead. A tablet keeps the QR code. */
  function samePhone() { return W.isPhone && !W.inWalletApp(); }
  /** A kept pairing ran out before the person came back (it lasts 10 minutes): one calm line where it was started. */
  function ranOut(p) {
    const m = `That approval ran out (it lasts 10 minutes). Tap ${p.relay && p.name ? p.name : "“Wallet on my phone”"} again for a new check number.`;
    if (signup) signup.say(m); else setErr(m);
  }
  /**
   * Brings the top of the panel (the step bar and the heading) into view just under the sticky header, when it is hidden above it
   * (or, `always`, wherever it is: a reloaded page that shows the pairing again starts at the top, above the old hero).
   */
  function panelInView(always = false) {
    const head = $(".site-header"), below = head ? head.getBoundingClientRect().bottom : 0;
    const top = panel.getBoundingClientRect().top;
    if ((always ? Math.abs(top - below - 12) < 4 : top >= below) || typeof window.scrollTo !== "function") return;
    window.scrollTo({ top: Math.max(0, top + (window.scrollY || 0) - below - 12), behavior: window.V.reduced ? "auto" : "smooth" });
  }
  $("#alt-phone").addEventListener("click", async () => {
    setErr("");
    const ctx = signup ? signup.pairContext() : { for: "connect", purpose: "login", name: null, relay: false };
    const d = await api("/api/pair", ctx.purpose === "link" ? { purpose: "link" } : {}); // a link pairing joins the wallet to this account; a login one signs the device in
    if (!d.ok) return setErr("Couldn't start. Please try again.", $("#alt-phone")); // (the wallet tapped and the reason stay for the next try)
    if (signup) signup.pairStarted();
    const p = { code: d.code, pin: d.pin, until: Date.parse(d.expiresAt), for: ctx.for, name: ctx.name || null, relay: Boolean(ctx.relay) };
    savePair(p);
    openPair(p, d.url);
  });
  /**
   * The pairing screen for a code: a new one, or (`resumed`) one this tab kept before it was reloaded, which asks the server at once.
   */
  function openPair(p, url = `${location.origin}/connect?pair=${p.code}`, resumed = false) {
    show("phone");
    $("#pair-pin").textContent = p.pin;
    // On a phone its wallet apps open the link (it works on any connection, and the sign-in comes back here: the way through when
    // "Open app" can't carry the sign-up, e.g. behind iCloud Private Relay). A tablet keeps the QR code for the phone next to it.
    const phone = samePhone();
    const why = p.relay && signup ? signup.relayWhy(p.name || null, !phone) : null; // why the pairing (and not "Open app")
    $("#pair-h").textContent = phone ? `Approve in ${p.name || "your wallet app"}, then finish here` : "Scan with your phone";
    $("#pair-why").textContent = why || ""; $("#pair-why").hidden = !why;
    $("#pair-qr").hidden = phone; $("#pair-howto").hidden = phone;
    $("#pair-howto-phone").hidden = !phone; $("#pair-apps").hidden = !phone;
    $("#pair-apps").replaceChildren(...(phone ? W.KNOWN.filter((k) => k.open).map((k) => knownTile(k, url)) : []));
    if (!phone) drawQR($("#qr"), url);
    const status = $("#pair-status");
    const dot = el("span", "live-dot"); dot.setAttribute("aria-hidden", "true");
    status.replaceChildren(dot, phone ? " Waiting for your wallet app…" : " Waiting for your phone…");
    let first = resumed; // the first answer after a reload: a code that ran out meanwhile goes back to where it was started
    /**
     * The code is gone: used, or run out. Used by another tab of this browser (a duplicated tab keeps the same pairing, and the
     * faster one finishes it): carry on from where that tab got to, never "expired" to a person who is in. Otherwise it ran out.
     */
    const gone = async (onLoad) => {
      pairPoll = null; forgetPair(); clearTimeout(timer);
      // Look twice, 1.5 s apart: the other tab's answer (and the cookie it sets) may still be on its way.
      for (let look = 0; look < 2; look++) {
        if (look) await new Promise((r) => setTimeout(r, 1500));
        if (state !== "phone") return; // the person left meanwhile (Back)
        if (await usedElsewhere()) return;
      }
      if (state !== "phone") return;
      if (onLoad) { show("pick"); renderPick(); return ranOut(p); }
      status.textContent = "The code expired. Go back and try again.";
    };
    const poll = async () => {
      clearTimeout(timer);
      if (state !== "phone" || pairPoll !== poll) return;
      if (Date.now() > p.until) return gone(first);
      const s = await api(`/api/pair?code=${encodeURIComponent(p.code)}`);
      if (state !== "phone" || pairPoll !== poll) return; // the person left meanwhile (Back): nothing more
      const onLoad = first && Boolean(s.status); first = first && !s.status; // (no answer at all is not an answer: offline)
      if (s.status === "expired") return gone(onLoad);
      if (s.status === "ready") {
        const f = await api("/api/pair/finish", { code: p.code });
        if (state !== "phone" || pairPoll !== poll) return;
        if (f.ok) { pairPoll = null; forgetPair(); toast(phone ? "Wallet approved ✓" : "Phone approved ✓"); address = f.wallet; return after(f); }
        if (signup && signup.handles(f.error)) { pairPoll = null; forgetPair(); address = f.wallet || address; return after(f); } // no account for that wallet, or it is taken: said on screen
        if (f.status === "expired") return gone(false); // someone was faster: another tab of this browser, a moment ago
      }
      timer = setTimeout(poll, 2000);
    };
    pairPoll = poll;
    clearTimeout(timer);
    if (resumed) poll(); else timer = setTimeout(poll, 2000);
    if (phone) panelInView(resumed); // the person tapped far down the page: the heading and the step bar must not sit under the header
  }
  /** The pairing on screen is gone: did another tab of this browser use it? Then this page carries on from there (true). */
  async function usedElsewhere() {
    if (signup) return signup.pairGone();
    const me = await api("/api/me?lite=1");
    if (state !== "phone") return true;
    if (me.signedIn) { show("done"); setTimeout(() => location.assign("/dashboard"), 900); return true; }
    if (me.pending) { showSocial(me.pending.wallet); return true; } // that tab is at step 2 (Google or e-mail): so is this one
    return false;
  }
  /**
   * The page loaded fine (its state is known): a pairing this tab kept is picked up again where it was started, and finished at once
   * if the wallet app approved it meanwhile. Not called when the page could not load its state: then the pairing stays kept.
   */
  function resumePair() {
    const p = savedPair();
    if (!p) return;
    if ((p.for === "connect") === Boolean(signup)) return forgetPair(); // made by the other sign-up (switched on or off meanwhile)
    const may = signup ? signup.resumePair(p) : "resume";
    if (may === "later") return; // the sign-up isn't on screen yet: kept for the next load
    if (may !== "resume") return forgetPair(); // the sign-up went on (or another way is open): nothing to finish here
    if (Date.now() > p.until) { forgetPair(); return ranOut(p); }
    openPair(p, undefined, true);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state === "phone" && pairPoll) pairPoll(); });

  /* ---------- the phone's side: approve the computer's sign-in, or the link of this wallet to an account ---------- */
  // Sign-up v2: the wallet app's browser shows only the approve card, at the top (today's hero and its 1-2-3 steps are the old
  // sign-up's), and says plainly what to do with the wallet tile. The card shows at once, in the new sign-up's look (never today's
  // pick screen, and nothing that moves the tile, while /api/me is on its way); today's look comes back only when /api/me answers
  // that the new sign-up is off. A LINK pairing (the owner's dashboard asked for it) names the account the wallet joins, and its
  // Terms are on record there: no Terms gate here. A login pairing is a first visit like any other: the gate shows.
  let approveV2 = true;
  async function startApprove() {
    show("approve");
    $(".connect__intro").hidden = true;
    window.V.ready.then((me) => {
      if (!me || me.ok === false || me.signupFlow === "v2") return;
      approveV2 = false; $(".connect__intro").hidden = false; $("#approve-tap").hidden = true; // today's sign-up: its hero and 1-2-3 steps, as before
    });
    const s = await api(`/api/pair?code=${encodeURIComponent(pairCode)}`);
    if (s.purpose === "link" && s.status === "waiting" && window.V.termsGate) window.V.termsGate.agreed(s.terms || "2026-10-01"); else gateNow();
    if (s.status !== "waiting") { $("#approve-wallets").hidden = true; return setErr(s.status === "ready" ? "This code was already used." : "This code has expired. Go back to where you started and try again.", $("#approve-pin").parentNode); }
    pairPin = s.pin; pairPurpose = s.purpose === "link" ? "link" : "login";
    $("#approve-pin").textContent = s.pin;
    if (pairPurpose === "link") {
      $("#approve-h").textContent = `Link this wallet to ${s.name || "•••"}'s Vicinity account?`;
      $("#approve-owner").textContent = `@${s.handle || "•••"}`;
      $("#approve-city").textContent = s.community ? `📍 ${s.community.name}, ${s.community.country}` : ""; $("#approve-city").hidden = !s.community;
      $("#approve-who").hidden = false;
      $("#approve-ask").replaceChildren("Does Safari (or your computer), where you started, show check number ", $("#approve-pin"), "?");
      $("#approve-warn").textContent = "Only continue if you started this yourself. Never sign for a code someone sent you.";
      $("#approve-terms").hidden = false;
      $("#approve-done-text").replaceChildren(el("strong", null, "Approved."), " Go back to where you started: your dashboard finishes the link, or says why it can't.");
    }
    renderApprove();
  }
  function renderApprove() {
    if (!pairPin || !$("#approve-done").hidden) return;
    const list = W.list();
    $("#approve-wallets").replaceChildren(...list.map((a) => walletButton(a, approveWith)));
    $("#approve-open").hidden = list.length > 0;
    $("#approve-links").replaceChildren(...W.KNOWN.filter((k) => k.open).map((k) => knownTile(k, location.href)));
    if (approveV2) { $("#approve-tap").textContent = `Tap ${list.length === 1 ? list[0].name : "your wallet"} below and sign. Nothing is paid or moved.`; $("#approve-tap").hidden = !list.length; }
  }
  async function approveWith(adapter) {
    forget(); setErr("");
    const my = attempt, name = nameOf(adapter), near = $("#approve-wallets");
    watchWallet(my, name, near, `tap ${name} again`, () => {});
    try {
      address = await adapter.connect(); active = adapter;
      if (my !== attempt) return;
      await loadMessage(pairPin);
      const d = await signIn(pairCode, () => my === attempt);
      if (my !== attempt) return;
      stopWaits();
      if (d.paired) {
        $("#approve-wallets").hidden = true; $("#approve-open").hidden = true; $("#approve-tap").hidden = true; $("#approve-done").hidden = false;
        toast("Approved ✓ Go back to where you started");
      }
    } catch (e) {
      if (my !== attempt) return;
      forget();
      setErr(cancelled(e) ? "Signing cancelled in your wallet. Nothing happened." : signError(e, name), near);
    }
  }

  /* ---------- app wallets (FOMO…): a tiny exact transfer ---------- */
  $("#alt-app").addEventListener("click", () => { show("app"); $("#tp-code").hidden = true; $("#tp-form").hidden = false; $("#tp-addr").focus(); });
  $("#tp-form").addEventListener("submit", async (e) => {
    e.preventDefault(); setErr("");
    const a = $("#tp-addr").value.trim();
    if (!isAddr(a)) return setErr("That doesn't look like a Solana wallet address.", $("#tp-form"));
    const d = await api("/api/auth/transfer", signup && signup.linkMode() ? { address: a, link: true } : { address: a }); // link: the signed-in account takes the wallet the transfer proves
    if (!d.ok) return setErr(d.error === "slow_down" ? "Too many tries from your network right now. Wait a few minutes and try again." : "Couldn't start. Please try again.", $("#tp-form"));
    showCode(d);
  });
  function showCode(d) {
    address = d.address;
    $("#tp-form").hidden = true; $("#tp-code").hidden = false;
    $("#tp-sol").textContent = d.sol;
    $("#tp-from").textContent = short(d.address);
    $("#tp-copy-amt").onclick = () => copy(d.sol, "Amount copied");
    $("#tp-copy-addr").onclick = () => copy(d.address, "Your address copied");
    const started = Date.now(), status = $("#tp-status");
    const poll = async () => {
      if (state !== "app") return;
      if (Date.now() - started > 30 * 60_000) { status.textContent = "This code expired. Go back and get a new one."; return; }
      const r = await api("/api/auth/transfer/check", {});
      if (r.ok) { toast("Transfer found ✓ Wallet verified"); return after(r); }
      if (signup && signup.handles(r.error)) return after(r); // found, but no account for that wallet (or it is taken): said on screen
      if (r.error === "no_proof" || r.error === "expired") { status.textContent = "This code expired. Go back and get a new one."; return; }
      // slow_down: the server wants fewer checks from this connection; ask every 30 seconds instead of 10
      timer = setTimeout(poll, r.error === "slow_down" ? 30_000 : 10_000);
    };
    clearTimeout(timer); timer = setTimeout(poll, 8000);
  }

  /* ---------- sign-up v2: loaded only when the server says so ---------- */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.append(s);
    });
  }
  async function startV2(me, err) {
    show("loading"); // hides today's half-drawn pick screen while the sign-up loads
    let loaded = false;
    try {
      await loadScript("/signup.js");
      signup = window.VSignup.start({ panel, params, show, setErr, renderPick, drawQR, showProof: (proof) => { show("app"); showCode(proof); } });
      loaded = await signup.init(me, err, { carry: carryCode, link: linkCode });
    } catch {
      signup = null; show("loading"); gateNow(); // (a pairing kept by this tab stays kept: the reload picks it up)
      $("#su-loading-text").textContent = "The sign-up didn't load.";
      $("#su-reload").hidden = false;
      $("#su-reload").onclick = () => location.reload();
      setErr("Please reload the page. If it keeps happening, try again in a few minutes.");
      return;
    }
    // reloaded during a pairing (iOS put this tab away while the person was in the wallet app). The sign-up didn't load (a request
    // failed): kept, and its "Reload the page" picks it up.
    if (loaded) resumePair();
  }

  /** The Terms gate site.js held back for a code or a pairing this page can't vouch for (the switch is off, an old link...): it opens as usual. */
  const gateNow = () => { if (window.V.termsGate) window.V.termsGate.open(); };

  /* ---------- start ---------- */
  (async () => {
    const err = params.get("error");
    if (err) history.replaceState(null, "", location.pathname + (pairCode ? `?pair=${pairCode}` : ""));
    if (pairCode) return startApprove(); // (the gate: startApprove decides, once it knows what the pairing is for)
    const me = await window.V.ready;
    providers = me.providers || providers;
    if (params.get("mode") === "login" || hasAccount()) welcomeBack();
    // the new sign-up: a link code (the wallet app's browser), or a member whose account has no wallet yet (the link mode, whatever the address said)
    if (me.signupFlow === "v2" && (linkCode !== null || (me.signedIn && me.user && !me.user.wallet))) return startV2(me, err);
    if (me.signedIn) { forgetPair(); gateNow(); show("done"); setTimeout(() => location.assign("/dashboard"), 900); return; }
    if (me.signupFlow === "v2") return startV2(me, err);
    gateNow();
    if (me.pending) { forgetPair(); showSocial(me.pending.wallet); }
    else if (me.proof) { forgetPair(); show("app"); showCode(me.proof); }
    else {
      show("pick"); renderPick();
      if (me.ok !== false) resumePair();
      else if ((savedPair() || { until: 0 }).until >= Date.now()) setErr("Couldn't reach Vicinity to finish. Check your connection, then reload this page."); // /api/me failed: the pairing stays kept
    }
    if (err && ERR[err]) setErr(ERR[err]);
  })();
})();
