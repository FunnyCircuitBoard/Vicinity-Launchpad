// Connect page: 1. prove the wallet (sign a message / phone QR / tiny transfer)  2. X or Google  3. dashboard.
// Needs site.js (window.V), wallets.js (window.VW) and vendor/qrcode.js (window.qrcode).
(() => {
  "use strict";
  const { $, $$, el, api, toast, copy, short, isAddr, burst } = window.V;
  const W = window.VW;
  const params = new URLSearchParams(location.search);
  const pairCode = params.get("pair");
  const panel = $("#connect-panel");
  let state = "pick", active = null, address = null, message = null, pairPin = null, providers = { google: false, x: false };

  const ERR = {
    social_taken: "That X / Google account is already linked to a different wallet. Sign in with the wallet it's linked to, or use another account.",
    wallet_taken: "This wallet is already linked to another account. Sign in with that account instead.",
    wallet_first: "That X / Google login isn't linked to a Vicinity account yet. New here? Connect your wallet below first, then link that login in step 2.",
    login_unavailable: "Log in with X and Google is being switched on. Please check back soon, or use your wallet.",
    login_cancelled: "Sign-in was cancelled. Nothing changed.",
    login_failed: "The sign-in didn't go through. Please try again.",
    login_expired: "That sign-in took too long or was opened in another tab. Please try again.",
    link_expired: "That link expired or was already used. Start again in your wallet app.",
  };
  const setErr = (m) => { const e = $("#c-error"); e.textContent = m || ""; e.hidden = !m; };
  const hasAccount = () => { try { return localStorage.getItem("vicinity-account") === "1"; } catch { return false; } };
  /** Returning people (the header's Log in button, or an account remembered on this device) get a "welcome back" top. */
  function welcomeBack() {
    $(".connect__intro .kicker").textContent = "Welcome back";
    const title = $(".connect__intro .page-title"), accent = el("span", "accent", "Your city's waiting.");
    title.replaceChildren("Log in.", el("br"), accent);
    $(".connect__intro .lead").textContent = "Log in with the X or Google account you linked, or with your wallet. New here? Use your wallet to create your account.";
  }
  const cancelled = (e) => /reject|cancel|denied|declin|closed/i.test(String(e?.message || e)) || e?.code === 4001;

  function show(s) {
    state = s;
    $$(".cstate", panel).forEach((x) => (x.hidden = x.dataset.state !== s));
    setErr("");
    const step = ["social", "link", "linkphone"].includes(s) ? 2 : ["done", "linkdone"].includes(s) ? 3 : 1;
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
  /** The "Log in" block: X / Google for people who already have an account. Google can't run inside wallet apps. */
  function renderLogin() {
    const inApp = W.inWalletApp();
    $("#login-x").hidden = !providers.x;
    $("#login-google").hidden = !providers.google || inApp;
    $("#login-off").hidden = Boolean(providers.x || providers.google);
    $("#login-inapp").hidden = !(inApp && providers.google);
  }
  $("#login-copy").addEventListener("click", () => copy(`${location.origin}/connect`, "Link copied. Paste it in Safari or Chrome."));
  function renderPick() {
    renderLogin();
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

  /** The wallet is proven: straight to the dashboard (linked before) or on to X / Google. */
  function after(d) {
    if (String(d.next || "").startsWith("/dashboard")) {
      show("done");
      const r = panel.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + 80);
      setTimeout(() => location.assign("/dashboard"), 900);
    } else showSocial(d.wallet || address);
  }
  function showSocial(wallet) {
    const inApp = W.inWalletApp();
    $("#s-addr").textContent = short(wallet);
    $("#go-x").hidden = !providers.x;
    $("#go-google").hidden = !providers.google || inApp; // Google refuses to run inside a wallet app's browser
    $("#social-off").hidden = Boolean(providers.x || providers.google);
    $("#social-inapp").hidden = !(inApp && (providers.x || providers.google));
    show("social");
  }

  /* ---------- sign-up finished in the phone's own browser (wallet apps can't run Google; cookies don't cross browsers) ---------- */
  $("#link-start").addEventListener("click", async () => {
    setErr("");
    const d = await api("/api/auth/handoff", {});
    if (!d.ok) return setErr("Couldn't start. Please connect your wallet again.");
    show("link");
    $("#link-pin").textContent = d.pin;
    $("#link-url").value = d.url;
    const until = Date.parse(d.expiresAt), status = $("#link-status");
    const poll = async () => {
      if (state !== "link") return;
      if (Date.now() > until) { status.textContent = "The link expired. Go back and try again."; return; }
      const f = await api("/api/auth/handoff/finish", { code: d.code });
      if (f.ok) { toast("Linked ✓"); return after(f); }
      if (f.status === "expired") { status.textContent = "The link expired. Go back and try again."; return; }
      timer = setTimeout(poll, 2000);
    };
    clearTimeout(timer); timer = setTimeout(poll, 2000);
  });
  $("#link-copy").addEventListener("click", () => copy($("#link-url").value, "Link copied. Paste it in Safari or Chrome."));
  $("#link-url").addEventListener("focus", (e) => e.target.select());
  /** The phone's own browser, opened from the wallet app's link. */
  async function startLinkPhone(code) {
    const r = await api(`/api/auth/handoff?code=${encodeURIComponent(code)}`);
    if (!r.ok) { show("pick"); renderPick(); return setErr(ERR.link_expired); }
    $("#lp-addr").textContent = r.wallet; $("#lp-pin").textContent = r.pin;
    const me = await window.V.ready; providers = me.providers || providers;
    $("#lp-x").href = `/api/auth/x/start?link=${encodeURIComponent(code)}`; $("#lp-x").hidden = !providers.x;
    $("#lp-google").href = `/api/auth/google/start?link=${encodeURIComponent(code)}`; $("#lp-google").hidden = !providers.google;
    show("linkphone");
  }
  $("#s-restart").addEventListener("click", async () => { await api("/api/auth/logout", {}); active = null; address = null; show("pick"); renderPick(); });
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
    if (params.get("linked")) { history.replaceState(null, "", location.pathname); return show("linkdone"); }
    if (params.get("link")) return startLinkPhone(params.get("link"));
    const me = await window.V.ready;
    providers = me.providers || providers;
    if (params.get("mode") === "login" || hasAccount()) welcomeBack();
    if (me.signedIn) { show("done"); setTimeout(() => location.assign("/dashboard"), 900); return; }
    if (me.pending) showSocial(me.pending.wallet);
    else if (me.proof) { show("app"); showCode(me.proof); }
    else { show("pick"); renderPick(); }
    if (err && ERR[err]) setErr(ERR[err]);
  })();
})();
