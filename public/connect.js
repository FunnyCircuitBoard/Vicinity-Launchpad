// Connect page: 1. prove the wallet (sign a message / phone QR / tiny transfer)  2. Google or e-mail  3. dashboard.
// Needs site.js (window.V), wallets.js (window.VW) and vendor/qrcode.js (window.qrcode).
(() => {
  "use strict";
  const { $, $$, el, api, toast, copy, short, isAddr, burst } = window.V;
  const W = window.VW;
  const params = new URLSearchParams(location.search);
  const pairCode = params.get("pair");
  // "Open app" on a phone brought a sign-up here from Safari / Chrome: its one-time code (site.js already took it out of the address bar)
  const carryCode = window.V.takeCarry ? window.V.takeCarry() : null;
  const panel = $("#connect-panel");
  let state = "pick", active = null, address = null, message = null, pairPin = null, providers = { google: false, email: false };
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
    const order = W.isMobile ? rest.filter((k) => k.open).concat(rest.filter((k) => !k.open)) : rest;
    const carry = signup ? signup.carrier() : null;
    $("#wallets-known").replaceChildren(...order.map((k) => knownTile(k, location.origin + "/connect", carry)));
    $("#wallets-known").classList.toggle("wallet-grid--apps", Boolean(W.isMobile && !list.length)); // a phone's only way on: full rows that say "Open app"
    $("#more-label").textContent = W.isMobile && !list.length ? "Open Vicinity in your wallet app" : list.length ? "More wallets" : "Get a wallet";
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

  async function loadMessage(pin) {
    message = null; $("#c-msg").textContent = "Loading…";
    const d = await api(`/api/message?address=${encodeURIComponent(address)}&action=login${pin ? "&pin=" + pin : ""}`);
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
      if (!d.ok) throw ours(d.error === "expired" ? "That message expired. Please sign again." : d.error === "pair_expired" ? "That code expired. Start again on your computer." : d.error === "pin_mismatch" ? "The check number doesn't match. Start again on your computer." : d.error === "offline" ? "Couldn't reach Vicinity. Check your connection and try again." : "Sign-in failed. Please try again.");
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

  /** The wallet is proven: straight to the dashboard (linked before) or on to Google / e-mail. */
  function after(d) {
    if (signup) return signup.walletProven(d); // v2: straight to the dashboard (account exists) or on to the sign-up steps
    if (d.next === "signup") return location.reload(); // the new sign-up was switched on while this old page was open (or its /api/me answer was lost): the reloaded page is the new one
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
  $("#alt-phone").addEventListener("click", async () => {
    setErr("");
    const d = await api("/api/pair", {});
    if (!d.ok) return setErr("Couldn't start. Please try again.", $("#alt-phone"));
    show("phone");
    $("#pair-pin").textContent = d.pin;
    // On a phone the code can't be scanned by the phone itself: its wallet apps open the link instead (it works on any connection,
    // and the sign-in comes back here: the way through when "Open app" can't carry the sign-up, e.g. behind iCloud Private Relay).
    // A tablet keeps the QR code: "Wallet on my phone" there means the phone next to it.
    const samePhone = W.isPhone && !W.inWalletApp();
    $("#pair-h").textContent = samePhone ? "Sign in your wallet app" : "Scan with your phone";
    $("#pair-qr").hidden = samePhone; $("#pair-howto").hidden = samePhone;
    $("#pair-howto-phone").hidden = !samePhone; $("#pair-apps").hidden = !samePhone;
    $("#pair-apps").replaceChildren(...(samePhone ? W.KNOWN.filter((k) => k.open).map((k) => knownTile(k, d.url)) : []));
    if (!samePhone) drawQR($("#qr"), d.url);
    const until = Date.parse(d.expiresAt);
    const status = $("#pair-status");
    const dot = el("span", "live-dot"); dot.setAttribute("aria-hidden", "true");
    status.replaceChildren(dot, samePhone ? " Waiting for your wallet app…" : " Waiting for your phone…");
    const poll = async () => {
      clearTimeout(timer);
      if (state !== "phone" || pairPoll !== poll) return;
      if (Date.now() > until) { status.textContent = "The code expired. Go back and try again."; return; }
      const s = await api(`/api/pair?code=${encodeURIComponent(d.code)}`);
      if (s.status === "expired") { status.textContent = "The code expired. Go back and try again."; return; }
      if (s.status === "ready") {
        const f = await api("/api/pair/finish", { code: d.code });
        if (f.ok) { pairPoll = null; toast(samePhone ? "Wallet approved ✓" : "Phone approved ✓"); address = f.wallet; return after(f); }
      }
      timer = setTimeout(poll, 2000);
    };
    pairPoll = poll;
    timer = setTimeout(poll, 2000);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state === "phone" && pairPoll) pairPoll(); });

  /* ---------- the phone's side: approve the computer's sign-in ---------- */
  async function startApprove() {
    show("approve");
    const s = await api(`/api/pair?code=${encodeURIComponent(pairCode)}`);
    if (s.status !== "waiting") { $("#approve-wallets").hidden = true; return setErr(s.status === "ready" ? "This code was already used." : "This code has expired. Start again on your computer.", $("#approve-pin").parentNode); }
    pairPin = s.pin;
    $("#approve-pin").textContent = s.pin;
    renderApprove();
  }
  function renderApprove() {
    if (!pairPin || !$("#approve-done").hidden) return;
    const list = W.list();
    $("#approve-wallets").replaceChildren(...list.map((a) => walletButton(a, approveWith)));
    $("#approve-open").hidden = list.length > 0;
    $("#approve-links").replaceChildren(...W.KNOWN.filter((k) => k.open).map((k) => knownTile(k, location.href)));
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
        $("#approve-wallets").hidden = true; $("#approve-open").hidden = true; $("#approve-done").hidden = false;
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
    const d = await api("/api/auth/transfer", { address: a });
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
    try {
      await loadScript("/signup.js");
      signup = window.VSignup.start({ panel, params, show, setErr, renderPick, drawQR, showProof: (proof) => { show("app"); showCode(proof); } });
      await signup.init(me, err, carryCode);
    } catch {
      signup = null; show("loading"); gateNow();
      $("#su-loading-text").textContent = "The sign-up didn't load.";
      $("#su-reload").hidden = false;
      $("#su-reload").onclick = () => location.reload();
      setErr("Please reload the page. If it keeps happening, try again in a few minutes.");
    }
  }

  /** A carried sign-up's code that this page can't use (signed in already, the switch is off...): the Terms gate opens as usual. */
  const gateNow = () => { if (carryCode !== null && window.V.termsGate) window.V.termsGate.open(); };

  /* ---------- start ---------- */
  (async () => {
    const err = params.get("error");
    if (err) history.replaceState(null, "", location.pathname + (pairCode ? `?pair=${pairCode}` : ""));
    if (pairCode) { gateNow(); return startApprove(); }
    const me = await window.V.ready;
    providers = me.providers || providers;
    if (params.get("mode") === "login" || hasAccount()) welcomeBack();
    if (me.signedIn) { gateNow(); show("done"); setTimeout(() => location.assign("/dashboard"), 900); return; }
    if (me.signupFlow === "v2") return startV2(me, err);
    gateNow();
    if (me.pending) showSocial(me.pending.wallet);
    else if (me.proof) { show("app"); showCode(me.proof); }
    else { show("pick"); renderPick(); }
    if (err && ERR[err]) setErr(ERR[err]);
  })();
})();
