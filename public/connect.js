// Connect page: 1. prove the wallet (sign a message / phone QR / tiny transfer)  2. Google or e-mail  3. dashboard.
// Needs site.js (window.V), wallets.js (window.VW) and vendor/qrcode.js (window.qrcode).
(() => {
  "use strict";
  const { $, $$, el, api, toast, copy, short, isAddr, burst } = window.V;
  const W = window.VW;
  const params = new URLSearchParams(location.search);
  const pairCode = params.get("pair");
  const panel = $("#connect-panel");
  let state = "pick", active = null, address = null, message = null, pairPin = null, providers = { google: false, email: false };

  const ERR = {
    social_taken: "That Google account is already linked to a different wallet. Sign in with the wallet it's linked to, or use another account.",
    wallet_taken: "This wallet is already linked to another account. Sign in with that account instead.",
    wallet_first: "That login isn't linked to a wallet yet. Connect your wallet first, then sign in with Google or e-mail.",
    login_unavailable: "Sign-in with Google is being switched on. Please check back soon.",
    login_cancelled: "Sign-in was cancelled. Nothing changed.",
    login_failed: "The sign-in didn't go through. Please try again.",
    login_expired: "That sign-in took too long or was opened in another tab. Please try again.",
  };
  const setErr = (m) => { const e = $("#c-error"); e.textContent = m || ""; e.hidden = !m; };
  const cancelled = (e) => /reject|cancel|denied|declin|closed/i.test(String(e?.message || e)) || e?.code === 4001;

  function show(s) {
    state = s;
    $$(".cstate", panel).forEach((x) => (x.hidden = x.dataset.state !== s));
    setErr("");
    const step = s === "social" ? 2 : s === "done" ? 3 : 1;
    $$("#stepper li").forEach((li) => { const n = Number(li.dataset.s); li.classList.toggle("is-active", n === step); li.classList.toggle("is-done", n < step); });
  }

  /* ---------- wallet buttons ---------- */
  function walletButton(adapter, onClick) {
    const b = el("button", "wallet-option"); b.type = "button";
    const icon = W.safeIcon(adapter.icon);
    if (icon) { const img = el("img"); img.alt = ""; img.src = icon; b.append(img); } else b.append(W.mark(adapter.name));
    b.append(el("span", null, adapter.name), el("span", "detected", "Detected"));
    b.addEventListener("click", () => onClick(adapter));
    return b;
  }
  /** Phones: open this page inside the wallet app. Computers: get the wallet. */
  function knownTile(k, target) {
    const a = el("a", "wallet-option");
    a.append(W.mark(k.name), el("span", null, k.name));
    if (W.isMobile && k.open) { a.href = k.open(target); a.append(el("span", "go", "Open app")); }
    else { a.href = k.site; a.target = "_blank"; a.rel = "noopener"; a.append(el("span", "go", "Get")); }
    return a;
  }
  function renderPick() {
    const list = W.list();
    $("#wallets-detected").replaceChildren(...list.map((a) => walletButton(a, connectWith)));
    $("#wallets-none").hidden = list.length > 0;
    const rest = W.KNOWN.filter((k) => !list.some((a) => k.match.test(a.name)));
    const order = W.isMobile ? rest.filter((k) => k.open).concat(rest.filter((k) => !k.open)) : rest;
    $("#wallets-known").replaceChildren(...order.map((k) => knownTile(k, location.origin + "/connect")));
    $("#more-label").textContent = W.isMobile && !list.length ? "Open Vicinity in your wallet app" : list.length ? "More wallets" : "Get a wallet";
    $("#more-wallets").open = list.length === 0;
  }
  W.onChange(() => { if (state === "pick") renderPick(); if (state === "approve") renderApprove(); });

  async function connectWith(adapter) {
    setErr("");
    try {
      address = await adapter.connect(); active = adapter;
      $("#c-addr").textContent = short(address);
      $("#c-wallet").textContent = adapter.name;
      show("sign");
      await loadMessage();
    } catch (e) { setErr(cancelled(e) ? "Connection cancelled in your wallet." : "Couldn't connect. Please try again."); }
  }

  async function loadMessage(pin) {
    message = null; $("#c-msg").textContent = "Loading…";
    const d = await api(`/api/message?address=${encodeURIComponent(address)}&action=login${pin ? "&pin=" + pin : ""}`);
    if (d.message) { message = d.message; $("#c-msg").textContent = d.message; }
    else $("#c-msg").textContent = "Couldn't load the message. Try again.";
    return message;
  }
  async function signIn(pair) {
    try {
      if (!message) await loadMessage(pair ? pairPin : null);
      if (!message) throw new Error("Couldn't prepare the message. Please try again.");
      const sig = await active.signMessage(new TextEncoder().encode(message));
      const body = { address, message, signature: btoa(String.fromCharCode(...sig)) };
      if (pair) body.pair = pair;
      const d = await api("/api/auth/wallet", body);
      if (!d.ok) throw new Error(d.error === "expired" ? "That message expired. Please sign again." : d.error === "pair_expired" ? "That code expired. Start again on your computer." : d.error === "pin_mismatch" ? "The check number doesn't match. Start again on your computer." : "Sign-in failed. Please try again.");
      return d;
    } finally { message = null; }
  }
  $("#c-sign").addEventListener("click", async (e) => {
    setErr("");
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = "Check your wallet…";
    try { after(await signIn()); }
    catch (err) { setErr(cancelled(err) ? "Signing cancelled in your wallet. Nothing happened." : err.message); loadMessage(); }
    finally { btn.disabled = false; btn.textContent = "Sign in"; }
  });

  /** The wallet is proven: straight to the dashboard (linked before) or on to Google / e-mail. */
  function after(d) {
    if (String(d.next || "").startsWith("/dashboard")) {
      show("done");
      const r = panel.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + 80);
      setTimeout(() => location.assign("/dashboard"), 900);
    } else showSocial(d.wallet || address);
  }
  function showSocial(wallet) {
    $("#s-addr").textContent = short(wallet);
    $("#go-google").hidden = !providers.google;
    $("#go-email").hidden = !providers.email;
    $("#email-form").hidden = true;
    $("#email-step-address").hidden = false;
    $("#email-step-code").hidden = true;
    $(".social-btns").hidden = false;
    $("#social-off").hidden = Boolean(providers.google || providers.email);
    show("social");
  }
  $("#s-restart").addEventListener("click", async () => { await api("/api/auth/logout", {}); active = null; address = null; show("pick"); renderPick(); });

  /* ---------- e-mail codes ---------- */
  let emailAddr = "";
  $("#go-email").addEventListener("click", () => {
    setErr("");
    $("#email-form").hidden = false;
    $(".social-btns").hidden = true;
    $("#email-step-address").hidden = false;
    $("#email-step-code").hidden = true;
    $("#email-addr").focus();
  });
  async function emailSend() {
    setErr("");
    emailAddr = $("#email-addr").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailAddr)) { setErr("That doesn't look like an e-mail address."); return; }
    const btn = $("#email-send"); btn.disabled = true; btn.textContent = "Sending…";
    try {
      const d = await api("/api/auth/email/start", { email: emailAddr });
      if (!d.ok) throw new Error(d.error);
      $("#email-sent-to").textContent = emailAddr;
      $("#email-step-address").hidden = true;
      $("#email-step-code").hidden = false;
      $("#email-code").value = "";
      $("#email-code").focus();
    } catch (e) { setErr(emailErr(e.message)); }
    finally { btn.disabled = false; btn.textContent = "Send me a code"; }
  }
  async function emailVerify() {
    setErr("");
    const code = $("#email-code").value.replace(/\D/g, "").slice(0, 6);
    if (code.length !== 6) { setErr("Enter the 6-digit code from the e-mail."); return; }
    const btn = $("#email-verify"); btn.disabled = true; btn.textContent = "Checking…";
    try {
      const d = await api("/api/auth/email/verify", { email: emailAddr, code });
      if (!d.ok) throw new Error(d.error + (d.left != null ? ":" + d.left : ""));
      location.assign(d.next || "/dashboard");
    } catch (e) { setErr(emailErr(e.message)); }
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
  $$("[data-back]").forEach((b) => b.addEventListener("click", () => { clearTimeout(timer); show("pick"); renderPick(); }));

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
  $("#alt-phone").addEventListener("click", async () => {
    setErr("");
    const d = await api("/api/pair", {});
    if (!d.ok) return setErr("Couldn't start. Please try again.");
    show("phone");
    $("#pair-pin").textContent = d.pin;
    drawQR($("#qr"), d.url);
    const until = Date.parse(d.expiresAt);
    const status = $("#pair-status");
    const poll = async () => {
      if (state !== "phone") return;
      if (Date.now() > until) { status.textContent = "The code expired. Go back and try again."; return; }
      const s = await api(`/api/pair?code=${encodeURIComponent(d.code)}`);
      if (s.status === "expired") { status.textContent = "The code expired. Go back and try again."; return; }
      if (s.status === "ready") {
        const f = await api("/api/pair/finish", { code: d.code });
        if (f.ok) { toast("Phone approved ✓"); address = f.wallet; return after(f); }
      }
      timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
  });

  /* ---------- the phone's side: approve the computer's sign-in ---------- */
  async function startApprove() {
    show("approve");
    const s = await api(`/api/pair?code=${encodeURIComponent(pairCode)}`);
    if (s.status !== "waiting") { $("#approve-wallets").hidden = true; return setErr(s.status === "ready" ? "This code was already used." : "This code has expired. Start again on your computer."); }
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
    setErr("");
    try {
      address = await adapter.connect(); active = adapter;
      await loadMessage(pairPin);
      const d = await signIn(pairCode);
      if (d.paired) {
        $("#approve-wallets").hidden = true; $("#approve-open").hidden = true; $("#approve-done").hidden = false;
        toast("Approved ✓ Go back to your computer");
      }
    } catch (e) { setErr(cancelled(e) ? "Signing cancelled in your wallet. Nothing happened." : e.message || "Couldn't approve. Please try again."); }
  }

  /* ---------- app wallets (FOMO…): a tiny exact transfer ---------- */
  $("#alt-app").addEventListener("click", () => { show("app"); $("#tp-code").hidden = true; $("#tp-form").hidden = false; $("#tp-addr").focus(); });
  $("#tp-form").addEventListener("submit", async (e) => {
    e.preventDefault(); setErr("");
    const a = $("#tp-addr").value.trim();
    if (!isAddr(a)) return setErr("That doesn't look like a Solana wallet address.");
    const d = await api("/api/auth/transfer", { address: a });
    if (!d.ok) return setErr("Couldn't start. Please try again.");
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
      if (r.error === "no_proof") { status.textContent = "This code expired. Go back and get a new one."; return; }
      timer = setTimeout(poll, 10_000);
    };
    clearTimeout(timer); timer = setTimeout(poll, 8000);
  }

  /* ---------- start ---------- */
  (async () => {
    const err = params.get("error");
    if (err) history.replaceState(null, "", location.pathname + (pairCode ? `?pair=${pairCode}` : ""));
    if (pairCode) return startApprove();
    const me = await window.V.ready;
    providers = me.providers || providers;
    if (me.signedIn) { show("done"); setTimeout(() => location.assign("/dashboard"), 900); return; }
    if (me.pending) showSocial(me.pending.wallet);
    else if (me.proof) { show("app"); showCode(me.proof); }
    else { show("pick"); renderPick(); }
    if (err && ERR[err]) setErr(ERR[err]);
  })();
})();
