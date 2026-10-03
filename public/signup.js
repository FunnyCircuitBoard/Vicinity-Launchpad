// Sign-up v2: 1 Location, 2 Account (terms, then Google or e-mail + password), 3 Wallet, then the dashboard. Plus the "Log in" tab.
// Loaded by connect.js ONLY when /api/me says signupFlow is "v2" (so today's page never downloads it). The wallet screens
// (pick / sign / phone / app) are today's, in connect.js: step 3 reuses them and gets the result through walletProven().
// Needs site.js (window.V) and wallets.js (window.VW). Nothing here touches the DOM until start() is called.
(() => {
  "use strict";

  /* ================= pure helpers: no DOM (test/signup-ui.test.js runs them in node) ================= */
  const STEPS = ["location", "account", "wallet"];
  const VIEW_OF = { location: "location", account: "account", wallet: "wallet", finish: "finish" };

  /**
   * Which screen to show and what the step bar looks like.
   * st = `state` from GET /api/signup/state; hold = a step the person is looking at again;
   * force = "wallet" when the wallet check can't be used any more (it expired) although the server still counts it.
   */
  function viewFor(st, hold, force) {
    const done = [Boolean(st.location && st.location.done), Boolean(st.account && st.account.done), Boolean(st.wallet && st.wallet.done)];
    let view = VIEW_OF[st.next] || "location";
    if (view === "finish" && force === "wallet") { view = "wallet"; done[2] = false; }
    const editable = { location: done[0] && !done[1], account: done[1] && !done[2], wallet: false }; // a step can be redone until the NEXT one is done
    if (hold && editable[hold]) view = hold;
    const finishing = view === "finish";
    const steps = STEPS.map((key, i) => ({ key, n: i + 1, done: done[i] || finishing, active: !finishing && key === view, editable: editable[key] && key !== view }));
    return { view, steps };
  }
  /** Step 1: what the location box shows. */
  function locSub(st, handoff, redo) {
    if (handoff) return "handoff";
    if (redo) return "ask";
    if (st.location.done) return "done";
    return st.location.choices && st.location.choices.length ? "choices" : "ask";
  }
  /** Step 2: choose a login / wait for the e-mailed code / done. mode is what the person did on this page ("code" | "choose" | null = whatever the server says). */
  function accSub(st, mode) {
    const a = st.account;
    if (a.done) return "done";
    if (mode === "code" || (mode == null && a.pending)) return "code";
    return "choose";
  }
  /** True when the sign-up row holds anything the person would have to redo (the wallet lives in its own session, so it does not count). */
  const hasProgress = (st) => Boolean(st && (st.location.done || (st.location.choices && st.location.choices.length) || st.terms.done || st.account.done || st.account.pending));

  /** Passwords are counted in characters people see (code points, after the same normalising the server does). */
  const pwLen = (s) => { try { return Array.from(String(s).normalize("NFKC")).length; } catch { return String(s).length; } };
  /** Length-only password guidance (the server enforces the real policy). */
  function pwHint(len) {
    if (len === 0) return { level: "empty", text: "At least 10 characters. A few random words work well." };
    if (len > 128) return { level: "long", text: "128 characters at most." };
    if (len < 10) return { level: "short", text: `${len} of 10 characters. ${10 - len} more to go.` };
    if (len < 14) return { level: "ok", text: "Long enough. Longer is stronger." };
    return { level: "good", text: "Good length." };
  }
  /** Which field a refused "send me a code" (reset) belongs to: the e-mail box while the first form shows, the code box once the second one does (its Send a new code button lives there). */
  const resetField = (form2Hidden) => (form2Hidden ? "rs-email" : "rs-code");
  const PHONE_NOTE = "On a phone, “Open app” opens this page inside your wallet app, and the sign-up starts again from step 1 there. What you did here is not carried over.";
  /** Step 3's opening text. `phone` = a phone with no wallet in this browser, where the only way on is to open the wallet app's own browser. */
  const walletLead = (phone) => "Last step. Connect the wallet you hold $VICINITY in and sign a free message. It isn't a transaction and can't move funds. Your account is created the moment it is verified." + (phone ? " " + PHONE_NOTE : "");
  /** What the page says when "New here" with an e-mail that already has an account signs the person in instead (the typed password is thrown away). */
  const SAME_EMAIL = "That e-mail already has a Vicinity account, so we logged you in. The password you just typed was not saved: to set a new one, use “Forgot or never set a password?” on the Log in tab. Taking you to your dashboard…";
  /** Only ever follow the server to our own dashboard. */
  const safeNext = (next) => (next === "/dashboard?welcome=1" ? next : "/dashboard");
  /** Same loose shape check as the server (the code that arrives is the real proof). */
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && !/[\u0000-\u001f\u007f-\u009f<>]/.test(e);

  const LOCATION_UNVERIFIED = "We couldn't confirm your location. Turn on precise location, use your normal mobile or home internet (no VPN), and try again.";
  // One plain sentence for every error the backend can answer with (PLAN.md 3.4), plus the page's own (offline, generic).
  const ERR = {
    // location
    location_required: "We couldn't read your location. Please try again.",
    location_unverified: LOCATION_UNVERIFIED,
    "location_unverified:finish": "Your connection no longer matches the place you shared (a different network, or a VPN?), so please check your location again. Everything else is saved.",
    cities_unavailable: "The map is busy. Please try again in a minute.",
    bad_choice: "That choice isn't available any more. Please check your location again.",
    no_choices: "There is nothing to choose from any more. Please check your location again.",
    slow_down: "That's a lot of attempts. Take a short break and try again in a little while.",
    "slow_down:login": "Too many tries. Wait a few minutes, or log in with your wallet or Google, or use “Forgot or never set a password? E-mail me a code”.",
    "slow_down:reset": "Too many codes were asked for that address just now. Wait a little while and try again. You can always log in with your wallet.",
    handoff_expired: "That link expired. Tap “Get a new link” to try again.",
    // the sign-up itself
    no_signup: "Your sign-up was open too long, so we cleared it. Please start again.",
    already_signed_in: "You're already signed in. Taking you to your dashboard…",
    already_finished: "Your account is already created. Taking you to your dashboard…",
    terms_required: "Please tick the box to agree to the Terms of Use.",
    bad_version: "The Terms of Use were updated. Please reload the page to read the new version.",
    not_enabled: "Sign-up is being updated. Please reload the page.",
    signup_unavailable: "Sign-up is down for a moment. Please try again in a few minutes.",
    wrong_origin: "Something went wrong. Please reload the page and try again.",
    // e-mail and password
    bad_email: "That doesn't look like an e-mail address.",
    bad_password: "That password can't be used. Try a longer one, made of a few random words.",
    password_short: "Use at least 10 characters.",
    password_long: "Use 128 characters or fewer.",
    password_common: "That password is too easy to guess. Try a few random words instead.",
    password_is_email: "Your password can't be your e-mail address. Pick something different.",
    email_unavailable: "We can't send e-mails right now. Please try again in a few minutes.",
    too_soon: "A code was just sent. Wait a minute before asking for another.",
    too_many: "Too many tries. Wait an hour, then ask for a new code.",
    "too_many:reset": "Too many codes were asked for that address. Wait an hour, then try again. You can always log in with your wallet.",
    "too_many:code": "That code was tried too many times. Tap “Send a new code” and use the new one.",
    "code_wrong:last": "That code doesn't match, and it can't be tried again. Tap “Send a new code” and use the new one.",
    bad_code: "Enter the 6-digit code from the e-mail.",
    code_wrong: "That code doesn't match. Please check it and try again.",
    code_expired: "That code expired. Send a new one.",
    email_mismatch: "That code was sent to a different e-mail. Tap “Use a different e-mail” to start that part again.",
    no_account: "No Vicinity account uses that login yet. You're on the New here tab: follow the steps to create one.",
    social_taken: "That login is already linked to a different wallet. Log in with the wallet it's linked to, or choose another login.",
    wallet_taken: "This wallet already has a Vicinity account. Use the Log in tab with it instead.",
    // finishing
    wallet_required: "We need to check your wallet again. Connect it below to finish. Everything else is saved.",
    wallet_expired: "Your wallet check timed out. Connect your wallet again to finish. Everything else is saved.",
    account_required: "Your login isn't confirmed yet. Please finish the account step.",
    changed_retry: "Something changed while we were creating your account. Please try again.",
    // log in
    bad_credentials: "That e-mail and password don't match. Signed up with Google? Use the Google button. Forgot your password, or never set one? Use “E-mail me a code” below.",
    no_email_login: "Only accounts created with an e-mail address can use a password.",
    reprove: "Please connect your wallet and sign once more first.",
    // Google bounce-backs (/connect?error=...)
    login_unavailable: "Log in with Google is being switched on. Please check back soon, or use e-mail or your wallet.",
    login_cancelled: "Sign-in was cancelled. Nothing changed.",
    login_failed: "The sign-in didn't go through. Please try again.",
    login_expired: "That sign-in took too long or was opened in another tab. Please try again.",
    // the page itself
    offline: "Couldn't reach Vicinity. Check your connection and try again.",
    generic: "Something went wrong. Please try again.",
  };
  /** One plain sentence for any server answer: errText({ error: "code_wrong", left: 4 }) or errText("bad_email", "login"). */
  function errText(d, ctx) {
    const code = typeof d === "string" ? d : d && d.error;
    if (code === "code_wrong") { const n = d && d.left; return n == null ? ERR.code_wrong : n === 0 ? ERR["code_wrong:last"] : `That code doesn't match. ${n} ${n === 1 ? "try" : "tries"} left.`; }
    return (ctx && ERR[`${code}:${ctx}`]) || ERR[code] || ERR.generic;
  }
  /** Google (or the server) sent the person back to /connect?error=<code>: which tab to open, and what to say. */
  function bounceFor(code) {
    const text = errText(code);
    if (code === "terms_required") return { tab: "new", hold: "account", text };
    if (code === "no_account" || code === "social_taken") return { tab: "new", text };
    if (code === "wallet_taken") return { tab: "login", text };
    return { text };
  }
  /**
   * What to do with a refusal from POST /api/signup/finish.
   *  go "wallet": reconnect the wallet (the rest is saved) · "next": ask the server where we are and go there · "stuck": stay and offer actions
   */
  function finishPlan(d) {
    const e = d && d.error;
    if (e === "wallet_expired" || e === "wallet_required") return { go: "wallet", text: errText(d) };
    if (e === "location_unverified") return { go: "next", text: errText(e, "finish") };
    if (e === "location_required" || e === "account_required" || e === "terms_required") return { go: "next", text: errText(d) };
    if (e === "wallet_taken") return { go: "stuck", text: errText(d), actions: ["login", "wallet"] };
    if (e === "social_taken") return { go: "stuck", text: errText(d), actions: ["ident", "login"] };
    if (e === "changed_retry") return { go: "stuck", text: errText(d), actions: ["retry"], auto: true };
    return { go: "stuck", text: errText(d), actions: ["retry"] };
  }

  window.VSignup = { start, pure: { viewFor, locSub, accSub, hasProgress, pwLen, pwHint, safeNext, validEmail, errText, bounceFor, finishPlan, resetField, walletLead, SAME_EMAIL, ERR } };

  /* ================= the controller ================= */
  function start(ctx) {
    const { $, $$, el, api, toast, copy, burst, getLocation, webView } = window.V;
    const W = window.VW;
    const { panel, params, show, setErr, renderPick, drawQR, showProof } = ctx;
    const inApp = () => W.inWalletApp();
    const S = {
      tab: "new", srv: null, me: null, providers: { google: false, email: false }, cur: "", view: "location",
      hold: null,           // a finished step the person is looking at again (or has just finished and not pressed Continue on)
      redo: false,          // step 1: show "Share my location" again although there is a result
      accMode: null,        // step 2: "choose" | "code" | null (null = what the server says)
      forceWallet: false,   // the wallet check expired: show the wallet step even though the server still counts it
      started: false, finishing: false, finishFailed: null, finishRetried: false,
      ho: null, codeEmail: "", resetEmail: "", noteView: "", first: true, leaving: false, lost: false,
    };
    const text = (sel, t) => { $(sel).textContent = t; };
    const hide = (sel, h = true) => { $(sel).hidden = h; };
    let liveFlip = false;
    /** Spoken by screen readers (a polite live region that exists from the start). */
    const announce = (t) => { liveFlip = !liveFlip; text("#su-live", liveFlip ? t : t + " "); };
    /** A calm one-sentence note under the step bar (why we moved the person). */
    function notice(msg) { const n = $("#su-note"); n.textContent = msg || ""; n.hidden = !msg; S.noteView = msg ? S.view : ""; if (msg) announce(msg); }

    /* ---------- talking to the server ---------- */
    /** api() plus the answers every call shares: switched off, signed in elsewhere, sign-up lost. d._handled = "the page already dealt with it". */
    async function call(path, body, opt) {
      const d = await api(path, body);
      if (d._status === 404 && d.error === "not_enabled") { flagOff(); d._handled = true; return d; }
      if (d.error === "already_signed_in" || d.error === "already_finished") {
        const fin = path.endsWith("/finish");
        signedIn(errText(d), fin ? "/dashboard?welcome=1" : "/dashboard"); d._handled = true; return d;
      }
      if (d.error === "no_signup" && !(opt && opt.again)) return lostSignup(path, body, d);
      return d;
    }
    /** The switch was turned off while the page was open: reload once so the old sign-up takes over. */
    function flagOff() {
      let again = false;
      try { again = sessionStorage.getItem("su-reload") === "1"; sessionStorage.setItem("su-reload", "1"); } catch { /* private mode: just say so */ }
      if (again) setErr(errText("not_enabled")); else location.reload();
    }
    /** The sign-up row is gone (it lives an hour): make a fresh one. If nothing was done yet, carry on silently; else start over, saying so. */
    async function lostSignup(path, body, d) {
      const empty = !hasProgress(S.srv);
      S.started = false;
      const st = await call("/api/signup/start", {}, { again: true });
      if (st._handled || !st.ok) return st._handled ? st : d;
      S.started = true; S.srv = st.state;
      if (empty) return call(path, body, { again: true });
      startOver(); d._handled = true; return d;
    }
    function startOver() {
      stopHandoff();
      Object.assign(S, { hold: null, redo: false, accMode: null, forceWallet: false, finishFailed: null, codeEmail: "", tab: "new" });
      for (const id of ["su-pw", "su-code"]) $(`#${id}`).value = "";
      render(); notice(errText("no_signup"));
    }
    async function refresh() {
      const had = hasProgress(S.srv);
      const d = await call("/api/signup/state");
      if (d.ok && d.state) {
        S.srv = d.state;
        if (had && !hasProgress(S.srv)) { // it was there a moment ago and now it is empty: the sign-up row expired
          S.started = false; S.lost = true;
          Object.assign(S, { hold: null, redo: false, accMode: null, codeEmail: "", forceWallet: false, finishFailed: null });
        }
      }
      return d;
    }
    /** POST /api/signup/start once per page (the answer also refreshes the 60-minute clock). Returns the server's answer. */
    async function ensureSignup() {
      if (S.started) return { ok: true };
      const d = await call("/api/signup/start", {}, { again: true });
      if (d.ok) { S.started = true; if (d.state) S.srv = d.state; }
      return d;
    }

    /* ---------- small UI helpers ---------- */
    /** Error line next to an input: sets aria-invalid on the input and fills the line (empty text clears it). The line stays in the page: see .su-err. */
    function fieldErr(id, msg) {
      const e = $(`#${id}-error`), i = $(`#${id}`);
      if (e) e.textContent = msg || "";
      if (i && i.tagName === "INPUT") { if (msg) i.setAttribute("aria-invalid", "true"); else i.removeAttribute("aria-invalid"); }
    }
    const clearErrs = (...ids) => ids.forEach((id) => fieldErr(id, ""));
    /** A button that shows what it is doing and can't be pressed twice. */
    async function busy(btn, label, fn) {
      if (btn.dataset.busy) return undefined;
      if (S.noteView) notice(""); // the person is moving on: the note about why they were moved has done its job
      const old = btn.textContent, hadFocus = document.activeElement === btn;
      btn.dataset.busy = "1"; btn.disabled = true; btn.textContent = label; btn.setAttribute("aria-busy", "true");
      try { return await fn(); } finally {
        delete btn.dataset.busy; btn.removeAttribute("aria-busy"); btn.disabled = false; btn.textContent = old; syncTerms();
        // A disabled button drops the keyboard's place (Enter or Space on it): give it back after an error, unless the page moved it on.
        if (hadFocus && (!document.activeElement || document.activeElement === document.body)) btn.focus({ preventScroll: true });
      }
    }
    /** "Send a new code" can't be used again for a minute (the server enforces it too). */
    function cooldown(btn, label, seconds = 60) {
      let left = seconds;
      btn.disabled = true;
      const tick = () => {
        if (left <= 0) { btn.disabled = false; btn.textContent = label; return; }
        btn.textContent = `${label} (${left}s)`; left -= 1; setTimeout(tick, 1000);
      };
      tick();
    }
    const SHOW_FOCUS = { location: "#su-loc-title", account: "#su-acc-title", wallet: "#wallet-h", finish: "#su-fin-title", login: "#lg-title", reset: "#rs-title" };
    /** Moving to another screen: focus its heading (not on the very first draw, so the page still starts at the top for keyboard users). */
    function focusHeading(key) {
      const h = $(SHOW_FOCUS[key]);
      if (!h) return;
      if (!S.first) {
        h.setAttribute("tabindex", "-1");
        h.focus({ preventScroll: true });
        panel.scrollIntoView({ block: "start", behavior: window.V.reduced ? "auto" : "smooth" });
      }
      S.first = false;
    }
    const STEP_NAME = { location: "Location", account: "Account", wallet: "Wallet" };

    /* ---------- page chrome: tabs, step bar, which part of today's "pick" screen shows ---------- */
    function drawSteps(steps) {
      for (const st of steps) {
        const li = $(`#su-steps li[data-step="${st.key}"]`), b = li.firstElementChild;
        li.classList.toggle("is-active", st.active);
        li.classList.toggle("is-done", st.done && !st.active);
        b.disabled = !st.editable;
        if (st.active) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
        li.querySelector("[data-step-state]").textContent = st.active ? ", current step" : st.done ? (st.editable ? ", done. Tap to change." : ", done") : ", not started yet";
      }
    }
    /** Called by connect.js every time a screen is shown. */
    function onShow(s) {
      S.cur = s;
      const newTab = S.tab === "new";
      $("#su-top").hidden = s === "approve" || s === "done" || s === "loading";
      $(".su-tabs").hidden = !["pick", "su-location", "su-account", "su-reset"].includes(s);
      $("#su-steps").hidden = !newTab || ["su-reset", "approve", "done", "loading"].includes(s);
      $("#tab-new").setAttribute("aria-pressed", String(newTab));
      $("#tab-login").setAttribute("aria-pressed", String(!newTab));
      if (s === "pick") {
        hide("#login-block"); // today's log-in block never shows in v2
        hide("#lg-block", newTab); hide("#or-line", newTab); hide("#su-wallet-lead", !newTab);
        if (newTab) text("#su-wallet-lead", walletLead(W.isMobile && !inApp() && !W.list().length)); // wallets turn up a moment after load: this runs again then
        text("#wallet-h", newTab ? "Connect your wallet" : "Log in with your wallet");
        if (!newTab) text("#or-line span", "Or log in with your wallet");
        const google = S.providers.google && !inApp();
        hide("#lg-google", !google); hide("#lg-inapp", !(inApp() && S.providers.google));
        hide("#lg-or", !(google && S.providers.email)); hide("#lg-form", !S.providers.email);
        hide("#lg-off", Boolean(S.providers.google || S.providers.email));
      }
      if (s === "su-account") drawProviders();
      if (s === "sign") text("#sign-h", newTab ? "Verify this wallet" : "Sign in with this wallet");
      if (["sign", "phone", "app"].includes(s) && S.noteView) notice("");
      if (["sign", "phone", "app"].includes(s) && !S.first) { // today's wallet sub-screens: the keyboard follows the person to the new heading
        const h = $(`.cstate[data-state="${s}"] h2`);
        h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true });
      }
    }
    const signLabel = () => (S.tab === "new" ? "Verify wallet" : "Sign in");
    function setIntro() {
      const title = $(".connect__intro .page-title"), accent = el("span", "accent");
      if (S.tab === "login") {
        text(".connect__intro .kicker", "Welcome back");
        accent.textContent = "Your city's waiting."; title.replaceChildren("Log in.", el("br"), accent);
        text(".connect__intro .lead", "Log in with your wallet, your Google account, or your e-mail and password. You won't repeat anything else.");
      } else {
        text(".connect__intro .kicker", "Join Vicinity");
        accent.textContent = "Represent."; title.replaceChildren("Check in. Verify.", el("br"), accent);
        text(".connect__intro .lead", "Three quick steps: where you are, who you are, and your wallet. Then your dashboard shows how much $VICINITY you hold, your rank and your community. Already a member? Tap Log in.");
      }
    }

    /* ---------- one render() decides what is on screen ---------- */
    function render() {
      setIntro();
      if (S.tab === "login") {
        if (S.noteView) notice("");
        if (S.reset) { show("su-reset"); focusHeading("reset"); return; }
        show("pick"); renderPick(); focusHeading("login");
        return;
      }
      const { view, steps } = viewFor(S.srv, S.hold, S.forceWallet ? "wallet" : null);
      if (S.noteView && S.noteView !== view) notice("");
      S.view = view;
      if (view === "location") showLocation(steps);
      else if (view === "account") showAccount(steps);
      else if (view === "wallet") showWallet(steps);
      else { drawSteps(steps); if (S.finishFailed) showFinishStuck(S.finishFailed); else finish(); }
      if (S.lost) { S.lost = false; notice(errText("no_signup")); } // found out while looking: say so, in the view the person lands on
    }
    function stepAnnounce(view) {
      if (STEP_NAME[view]) announce(`Step ${STEPS.indexOf(view) + 1} of 3: ${STEP_NAME[view]}`);
    }
    function setTab(tab) {
      if (S.tab === tab && !S.reset) return;
      S.tab = tab; S.reset = false; stopHandoff();
      render();
    }

    /* ---------- the end of every successful path ---------- */
    function signedIn(sub, next, ms = 1200) {
      if (S.leaving) return;
      S.leaving = true; stopHandoff();
      show("done");
      text("#done-sub", sub);
      const to = safeNext(next);
      $(".cstate[data-state=done] a").href = to;
      announce(sub);
      const r = panel.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + 80);
      setTimeout(() => location.assign(to), ms);
    }

    /* ================= step 1: location ================= */
    function showLocation(steps) {
      drawSteps(steps);
      show("su-location");
      const sub = locSub(S.srv, S.ho, S.redo);
      hide("#su-loc-ask", sub !== "ask"); hide("#su-loc-handoff", sub !== "handoff"); hide("#su-loc-choices", sub !== "choices"); hide("#su-loc-done", sub !== "done");
      text("#su-loc-title", sub === "done" ? "Location confirmed" : "Where are you?");
      if (sub === "choices") drawChoices();
      if (sub === "done") {
        const c = S.srv.location.community;
        text("#su-loc-city", c ? `${c.name}, ${c.country}` : "Your community");
        text("#su-loc-note", `This will be your home community. You can change it once after 7 days. ${S.srv.location.picked ? "You chose it from the three nearest. " : ""}Your exact location was not saved.`);
      }
      stepAnnounce("location"); focusHeading("location");
    }
    function locError(msg) { text("#su-loc-error", msg || ""); }
    function locStatus(msg) { if (msg) { text("#su-loc-status-text", msg); announce(msg); } hide("#su-loc-status", !msg); }
    /** After any failure to read the position: say so, and offer to finish in another browser (never a dead end). */
    function offerElsewhere() {
      text("#su-loc-phone", W.isMobile ? "Finish this step in another browser instead" : "Finish this step on my phone instead");
      hide("#su-loc-phone", false);
    }
    async function shareLocation() {
      const btn = $("#su-loc-go");
      locError(""); hide("#su-loc-phone");
      await busy(btn, "Checking your location…", async () => {
        locStatus("Waiting for your browser. If it asks, choose Allow.");
        let loc;
        try { loc = await getLocation(); }
        catch (e) { locStatus(""); return locationUnavailable(e); }
        locStatus("Finding your community…");
        const s = await ensureSignup();
        if (!s.ok) { locStatus(""); if (!s._handled) locError(errText(s)); return; }
        const r = await call("/api/signup/location", { location: loc });
        locStatus("");
        if (r._handled) return;
        if (!r.ok) { locError(errText(r)); offerElsewhere(); return; }
        await refresh(); S.redo = false; S.hold = S.srv.location.done ? "location" : null; render();
      });
    }
    /** GPS did not answer. Inside a wallet app: finish in the phone's own browser. Elsewhere: say why, and offer another browser or the phone. */
    function locationUnavailable(e) {
      if ((e && e.inApp) || inApp()) return startHandoff("app");
      locError(e && e.message ? e.message : errText("location_required"));
      offerElsewhere();
    }
    function drawChoices() {
      const ul = $("#su-choices");
      ul.replaceChildren(...S.srv.location.choices.map((c) => {
        const b = el("button", "city-row"); b.type = "button";
        const nm = el("span", "city-row__name"); nm.append(el("strong", null, c.name), el("span", null, c.km != null ? `about ${c.km} km away` : c.country));
        b.append(nm, el("span", "tag tag--ok", "Join"));
        b.addEventListener("click", () => pickChoice(c.id));
        const li = el("li"); li.append(b); return li;
      }));
    }
    async function pickChoice(id) {
      text("#su-choices-error", "");
      const r = await call("/api/signup/location/choice", { id });
      if (r._handled) return;
      if (!r.ok) {
        if (r.error === "bad_choice" || r.error === "no_choices") await refresh(); // the list may have changed: show what is there now
        if (S.srv.location.choices && S.srv.location.choices.length) return text("#su-choices-error", errText(r));
        S.redo = true; render(); return locError(errText(r)); // nothing to choose from any more: back to "Share my location"
      }
      await refresh(); S.redo = false; S.hold = "location"; render();
    }

    /* ---- the hand-off: a wallet app's browser (or a computer without GPS) can't read the position, so a normal browser does ---- */
    async function startHandoff(kind) {
      const s = await ensureSignup();
      if (!s.ok) return s._handled ? undefined : locError(errText(s));
      const h = await call("/api/signup/location/handoff", {});
      if (h._handled) return;
      if (!h.ok) return locError(errText(h));
      const desktop = kind === "desktop";
      S.ho = { code: h.code, until: Date.parse(h.expiresAt), timer: null, kind };
      $("#su-ho-link").value = h.url;
      text("#su-ho-why", { app: "This wallet app's browser can't share your location, so we'll finish this step in Safari or Chrome.", desktop: "This computer can't share its location. You can finish this step on your phone. Your phone must be on the same Wi-Fi as this computer.", browser: "This browser can't share your location, so we'll finish this step in a different browser on this phone." }[kind] || "");
      const steps = desktop
        ? ["Scan the code with your phone's camera, or copy the link below and open it on your phone.", "On your phone tap Share my location.", "Come back here. This page continues by itself."]
        : ["Copy the link below.", `Paste it in ${kind === "browser" ? "another browser app" : "Safari or Chrome"} and tap Share my location.`, "Come back here. This page continues by itself."];
      $("#su-ho-steps").replaceChildren(...steps.map((t) => el("li", null, t)));
      hide("#su-ho-qrwrap", !desktop);
      if (desktop) { const c = el("canvas"); c.id = "su-ho-qr"; c.width = c.height = 232; c.setAttribute("aria-label", "QR code to finish the location step on your phone"); $("#su-ho-qrwrap").replaceChildren(c); drawQR(c, h.url); }
      text("#su-ho-status-text", desktop ? "Waiting for your phone…" : "Waiting for your browser…");
      hide("#su-ho-status", false); text("#su-ho-error", ""); hide("#su-ho-renew");
      render();
      S.ho.timer = setTimeout(pollHandoff, 2000);
    }
    async function pollHandoff() {
      const ho = S.ho; if (!ho) return;
      if (Date.now() > ho.until) return handoffExpired();
      const r = await call("/api/signup/location/handoff/claim", { code: ho.code });
      if (S.ho !== ho || r._handled) return; // cancelled while waiting, or dealt with
      if (r.ok) { stopHandoff(); await refresh(); S.redo = false; S.hold = S.srv.location.done ? "location" : null; return render(); }
      if (r.status === "expired" || r._status === 410) return handoffExpired();
      ho.timer = setTimeout(pollHandoff, r._status === 429 ? 6000 : 2000);
    }
    function handoffExpired() {
      if (!S.ho) return;
      clearTimeout(S.ho.timer);
      text("#su-ho-error", errText("handoff_expired")); hide("#su-ho-status"); hide("#su-ho-renew", false);
    }
    async function renewHandoff() { const kind = S.ho && S.ho.kind; stopHandoff(); if (kind) await startHandoff(kind); }
    function stopHandoff() { if (S.ho) clearTimeout(S.ho.timer); S.ho = null; }

    /* ================= step 2: account ================= */
    /** Which of Google / e-mail / neither is offered here. Google can't run inside a wallet app's browser. */
    function drawProviders() {
      const google = S.providers.google && !inApp(), email = S.providers.email;
      hide("#su-google", !google); hide("#su-inapp", !(inApp() && S.providers.google));
      hide("#su-email-form", !email); hide("#su-or", !(google && email)); hide("#su-off", Boolean(S.providers.google || S.providers.email));
    }
    function showAccount(steps) {
      drawSteps(steps);
      show("su-account");
      const sub = accSub(S.srv, S.accMode), a = S.srv.account, c = S.srv.location.community, w = S.srv.wallet;
      hide("#su-recap", !c); if (c) text("#su-recap-city", `${c.name}, ${c.country}`);
      hide("#su-recap-wallet", !(w.done && w.address)); if (w.address) text("#su-recap-wallet-addr", w.address);
      hide("#su-acc-choose", sub !== "choose"); hide("#su-code-form", sub !== "code"); hide("#su-acc-done", sub !== "done");
      text("#su-terms-version", S.srv.terms.version);
      if (S.srv.terms.done) $("#su-terms").checked = true;
      drawProviders();
      if (sub === "code") text("#su-code-to", S.codeEmail || (a.pending && a.pending.email) || "your e-mail");
      if (sub === "done") text("#su-acc-who", a.provider === "google" ? "Google account verified" : `E-mail verified: ${a.email || ""}`);
      syncTerms();
      stepAnnounce("account"); focusHeading("account");
    }
    /** The two ways to continue stay disabled until the terms box is ticked. */
    function syncTerms() {
      const ok = $("#su-terms").checked;
      $("#su-google").disabled = !ok;
      const send = $("#su-email-send"); if (!send.dataset.busy) send.disabled = !ok;
    }
    function accError(msg) { text("#su-acc-error", msg || ""); }
    /** The server needs the terms before any identity step. The box must be ticked; the answer is recorded here. Returns true when it is on record. */
    async function ensureTerms() {
      if (!$("#su-terms").checked) { fieldErr("su-terms", errText("terms_required")); return false; }
      const s = await ensureSignup();
      if (!s.ok) { if (!s._handled) accError(errText(s)); return false; }
      if (S.srv.terms.done) return true;
      const r = await call("/api/signup/terms", { version: S.srv.terms.version });
      if (r._handled) return false;
      if (!r.ok) { accError(errText(r)); return false; }
      S.srv.terms.done = true; return true;
    }
    async function useGoogle() {
      accError(""); fieldErr("su-terms", "");
      await busy($("#su-google"), "Opening Google…", async () => {
        if (await ensureTerms()) location.assign("/api/auth/google/start?signup=1");
      });
    }
    /** Field-level checks the server repeats (so a typo costs no round trip). Returns true when something is wrong. */
    function checkPassword(id, pw) {
      const n = pwLen(pw);
      if (n < 10) { fieldErr(id, errText("password_short")); return true; }
      if (n > 128) { fieldErr(id, errText("password_long")); return true; }
      return false;
    }
    async function sendCode(ev) {
      if (ev) ev.preventDefault();
      clearErrs("su-email", "su-pw", "su-terms"); accError("");
      const email = $("#su-email").value.trim().toLowerCase(), pw = $("#su-pw").value;
      let bad = false;
      if (!validEmail(email)) { fieldErr("su-email", errText("bad_email")); bad = true; }
      if (checkPassword("su-pw", pw)) bad = true;
      if (bad) return;
      await busy($("#su-email-send"), "Sending…", async () => {
        if (!(await ensureTerms())) return;
        let d = await call("/api/signup/email", { email, password: pw });
        if (d._handled) return;
        if (!d.ok && d.error === "terms_required" && $("#su-terms").checked) { // the sign-up row is a new one: record the ticked box again and carry on
          S.srv.terms.done = false;
          if (!(await ensureTerms())) return;
          d = await call("/api/signup/email", { email, password: pw });
          if (d._handled) return;
        }
        if (!d.ok) {
          if (d.error === "bad_email") return fieldErr("su-email", errText(d));
          if (/^password_|^bad_password$/.test(d.error)) return fieldErr("su-pw", errText(d));
          if (d.error === "terms_required") { S.srv.terms.done = false; return fieldErr("su-terms", errText(d)); }
          return accError(errText(d));
        }
        S.codeEmail = email; S.accMode = "code"; clearErrs("su-code"); $("#su-code").value = "";
        render(); $("#su-code").focus();
        cooldown($("#su-code-resend"), "Send a new code");
      });
    }
    async function resendCode() {
      const email = S.codeEmail, pw = $("#su-pw").value;
      if (!email || !pw) { // after a reload the password is not here any more (and the server only keeps a hash)
        S.accMode = "choose"; render();
        if (email) $("#su-email").value = email;
        $("#su-pw").value = ""; fieldErr("su-pw", "Type your password again to get a new code."); return;
      }
      const btn = $("#su-code-resend");
      if (btn.disabled) return; // a double tap would send two requests, and the second one is refused ("A code was just sent")
      btn.disabled = true;
      let cooling = false;
      try {
        const d = await call("/api/signup/email", { email, password: pw });
        if (d._handled) return;
        if (!d.ok) return fieldErr("su-code", errText(d));
        toast("New code sent"); cooldown(btn, "Send a new code"); cooling = true;
      } finally { if (!cooling) btn.disabled = false; }
    }
    async function verifyCode(ev) {
      if (ev) ev.preventDefault();
      fieldErr("su-code", "");
      const code = $("#su-code").value.replace(/\D/g, "").slice(0, 6);
      if (code.length !== 6) return fieldErr("su-code", errText("bad_code"));
      await busy($("#su-code-verify"), "Checking…", async () => {
        const d = await call("/api/signup/email/verify", { ...(S.codeEmail ? { email: S.codeEmail } : {}), code });
        if (d._handled) return;
        if (!d.ok) {
          if (d.error === "email_mismatch") { S.accMode = "choose"; S.codeEmail = ""; await refresh(); render(); return accError(errText(d)); }
          return fieldErr("su-code", errText(d, "code"));
        }
        $("#su-pw").value = ""; S.codeEmail = ""; S.accMode = null;
        if (d.existing) return signedIn(SAME_EMAIL, d.next, 5000); // longer than usual: there is a sentence to read
        if (d.state) S.srv = d.state; else await refresh();
        S.hold = "account"; render();
      });
    }
    /** "Use a different login / e-mail": forget the identity step only (terms and location stay). */
    async function useDifferentLogin() {
      const d = await call("/api/signup/account/reset", {});
      if (d._handled) return;
      if (!d.ok) return accError(errText(d));
      Object.assign(S, { codeEmail: "", accMode: "choose", hold: null });
      $("#su-pw").value = ""; if (d.state) S.srv = d.state; else await refresh();
      S.accMode = null; render();
    }

    /* ================= step 3: the wallet (today's screens) ================= */
    function showWallet(steps) {
      drawSteps(steps);
      show("pick"); renderPick(); // renderPick -> onShow("pick") writes the lead
      stepAnnounce("wallet"); focusHeading("wallet");
    }
    /** connect.js: the wallet is proven. An existing account is signed in; a new wallet joins this sign-up. */
    async function walletProven(d) {
      if (String(d.next || "").startsWith("/dashboard")) return signedIn("This wallet already has a Vicinity account, so we logged you in. Taking you to your dashboard…", d.next);
      if (d.next !== "signup") return location.reload(); // the switch went back to the old sign-up while this page was open
      const wasLogin = S.tab === "login";
      S.forceWallet = false; S.finishFailed = null; S.finishRetried = false;
      await refresh(); S.tab = "new"; S.hold = null;
      render();
      const { view, steps } = viewFor(S.srv);
      if (view === "finish") return; // the page creates the account right away
      const left = steps.filter((x) => !x.done).length;
      const msg = wasLogin
        ? `No Vicinity account uses this wallet yet, so we're setting one up. ${left} ${left === 1 ? "step" : "steps"} left.`
        : `Wallet verified. ${left} ${left === 1 ? "step" : "steps"} left.`;
      if (wasLogin) notice(msg); else { toast(msg); announce(msg); }
    }

    /* ================= the end: create the account ================= */
    const FINISH_BUTTONS = { retry: "#su-fin-retry", login: "#su-fin-login", wallet: "#su-fin-wallet", ident: "#su-fin-ident" };
    async function finish() {
      if (S.finishing) return;
      S.finishing = true;
      show("su-finish"); text("#su-fin-error", ""); hide("#su-fin-actions"); text("#su-fin-title", "Creating your account…"); hide("#su-fin-sub", false);
      announce("Creating your account");
      const d = await call("/api/signup/finish", {});
      S.finishing = false;
      if (d._handled) return;
      if (d.ok) return signedIn("Your account is ready. Taking you to your dashboard, where you can see how much $VICINITY you hold, your rank and your community.", d.next);
      const me = await api("/api/me?lite=1"); // another tab may have finished it already
      if (me.signedIn) return signedIn(errText("already_finished"), "/dashboard?welcome=1");
      const plan = finishPlan(d);
      if (plan.auto && !S.finishRetried) { S.finishRetried = true; return setTimeout(finish, 1200); }
      if (plan.go === "wallet") { S.forceWallet = true; await refresh(); render(); return notice(plan.text); }
      if (plan.go === "next") {
        await refresh(); S.hold = null; S.redo = false; S.accMode = null;
        if (viewFor(S.srv).view !== "finish") { render(); return notice(plan.text); } // the server cleared the step: go there
      }
      S.finishFailed = plan; showFinishStuck(plan);
    }
    function showFinishStuck(plan) {
      show("su-finish");
      text("#su-fin-title", "We couldn't finish yet"); hide("#su-fin-sub");
      text("#su-fin-error", plan.text); announce(plan.text);
      hide("#su-fin-actions", false);
      const acts = plan.actions || ["retry"];
      for (const [k, sel] of Object.entries(FINISH_BUTTONS)) hide(sel, !acts.includes(k));
      S.first = false; $("#su-fin-title").setAttribute("tabindex", "-1"); $("#su-fin-title").focus({ preventScroll: true });
    }
    async function finishAction(kind) {
      if (kind === "retry") { S.finishFailed = null; S.finishRetried = false; return finish(); }
      if (kind === "login") { S.finishFailed = null; S.tab = "login"; return render(); }
      if (kind === "wallet") { await api("/api/auth/logout", {}); S.finishFailed = null; S.forceWallet = false; await refresh(); return render(); }
      if (kind === "ident") { S.finishFailed = null; return useDifferentLogin(); }
    }

    /* ================= the Log in tab ================= */
    function loginDone() { signedIn("Taking you to your dashboard…", "/dashboard"); }
    async function logIn(ev) {
      ev.preventDefault();
      clearErrs("lg-email", "lg-pw", "lg");
      const email = $("#lg-email").value.trim().toLowerCase(), pw = $("#lg-pw").value;
      let bad = false;
      if (!validEmail(email)) { fieldErr("lg-email", errText("bad_email")); bad = true; }
      if (!pw) { fieldErr("lg-pw", "Enter your password."); bad = true; }
      if (bad) return;
      await busy($("#lg-submit"), "Logging in…", async () => {
        const d = await call("/api/auth/email/login", { email, password: pw });
        if (d._handled) return;
        if (!d.ok) { text("#lg-error", errText(d, "login")); return; }
        $("#lg-pw").value = ""; loginDone();
      });
    }
    function openReset() {
      S.reset = true; S.resetEmail = ""; $("#rs-email").value = $("#lg-email").value;
      hide("#rs-form1", false); hide("#rs-form2"); clearErrs("rs-email", "rs-code", "rs-pw", "rs");
      render();
    }
    async function resetStart(ev) {
      if (ev) ev.preventDefault();
      clearErrs("rs-email", "rs-code");
      const email = $("#rs-email").value.trim().toLowerCase();
      if (!validEmail(email)) return fieldErr("rs-email", errText("bad_email"));
      await busy($("#rs-send"), "Sending…", async () => {
        const d = await call("/api/auth/password/reset/start", { email });
        if (d._handled) return;
        if (!d.ok) return fieldErr(resetField($("#rs-form2").hidden), errText(d, "reset")); // the form that is on screen, not the hidden one
        S.resetEmail = email; text("#rs-sent-to", email);
        hide("#rs-form1"); hide("#rs-form2", false); $("#rs-code").focus();
        announce(`If that address has an account, we sent a 6-digit code to ${email}.`);
        cooldown($("#rs-resend"), "Send a new code");
      });
    }
    async function resetSave(ev) {
      ev.preventDefault();
      clearErrs("rs-code", "rs-pw", "rs");
      const code = $("#rs-code").value.replace(/\D/g, "").slice(0, 6), pw = $("#rs-pw").value;
      let bad = false;
      if (code.length !== 6) { fieldErr("rs-code", errText("bad_code")); bad = true; }
      if (checkPassword("rs-pw", pw)) bad = true;
      if (bad) return;
      await busy($("#rs-save"), "Saving…", async () => {
        const d = await call("/api/auth/password/reset", { email: S.resetEmail, code, password: pw });
        if (d._handled) return;
        if (!d.ok) {
          if (/^password_|^bad_password$/.test(d.error)) return fieldErr("rs-pw", errText(d));
          if (/^code_|^bad_code$|^too_many$/.test(d.error)) return fieldErr("rs-code", errText(d, "code"));
          return fieldErr("rs", errText(d, "login"));
        }
        $("#rs-pw").value = ""; loginDone();
      });
    }

    /* ================= wiring (once) ================= */
    function wire() {
      $("#tab-new").addEventListener("click", () => setTab("new"));
      $("#tab-login").addEventListener("click", () => setTab("login"));
      $$("#su-steps button").forEach((b) => b.addEventListener("click", () => { S.hold = b.closest("li").dataset.step; S.redo = false; render(); }));
      // step 1
      $("#su-loc-go").addEventListener("click", shareLocation);
      $("#su-loc-phone").addEventListener("click", () => startHandoff(W.isMobile ? "browser" : "desktop"));
      $("#su-ho-copy").addEventListener("click", () => copy($("#su-ho-link").value, "Link copied. Paste it in your browser."));
      $("#su-ho-link").addEventListener("focus", (e) => e.target.select());
      $("#su-ho-cancel").addEventListener("click", () => { stopHandoff(); render(); });
      $("#su-ho-renew").addEventListener("click", renewHandoff);
      $("#su-choices-redo").addEventListener("click", () => { S.redo = true; render(); });
      $("#su-loc-continue").addEventListener("click", () => { S.hold = null; S.redo = false; render(); });
      $("#su-loc-redo").addEventListener("click", () => { S.redo = true; S.hold = "location"; locError(""); render(); });
      // coming back to the wallet app: the timers slept while it was in the background, so ask right away
      document.addEventListener("visibilitychange", () => { if (!document.hidden && S.ho) { clearTimeout(S.ho.timer); pollHandoff(); } });
      // step 2
      $("#su-terms").addEventListener("change", () => { fieldErr("su-terms", ""); syncTerms(); });
      $("#su-google").addEventListener("click", useGoogle);
      $("#su-email-form").addEventListener("submit", sendCode);
      $("#su-code-form").addEventListener("submit", verifyCode);
      $("#su-code-resend").addEventListener("click", resendCode);
      $("#su-code-change").addEventListener("click", useDifferentLogin);
      $("#su-acc-continue").addEventListener("click", () => { S.hold = null; render(); });
      $("#su-acc-redo").addEventListener("click", useDifferentLogin);
      // finish
      for (const [k, sel] of Object.entries(FINISH_BUTTONS)) $(sel).addEventListener("click", () => finishAction(k));
      // log in
      $("#lg-form").addEventListener("submit", logIn);
      $("#lg-forgot").addEventListener("click", openReset);
      $("#lg-copy").addEventListener("click", () => copy(`${location.origin}/connect`, "Link copied. Paste it in Safari or Chrome."));
      $("#rs-form1").addEventListener("submit", resetStart);
      $("#rs-form2").addEventListener("submit", resetSave);
      $("#rs-resend").addEventListener("click", resetStart);
      $("#rs-back").addEventListener("click", () => { S.reset = false; render(); });
      // password fields: show/hide, length guidance
      $$(".su-pw__toggle").forEach((b) => b.addEventListener("click", () => {
        const i = $(`#${b.getAttribute("aria-controls")}`), shown = i.type === "password";
        i.type = shown ? "text" : "password"; b.textContent = shown ? "Hide" : "Show"; b.setAttribute("aria-label", shown ? "Hide password" : "Show password");
      }));
      for (const id of ["su-pw", "rs-pw"]) $(`#${id}`).addEventListener("input", (e) => { const h = pwHint(pwLen(e.target.value)), p = $(`#${id}-hint`); p.textContent = h.text; p.dataset.level = h.level; });
      // a wallet turning up (they appear a moment after the page loads) can show this is a wallet app: Google goes away
      W.onChange(() => { if (S.cur === "su-account") drawProviders(); });
      // the page was restored from the back/forward cache: it may show a finished step, so start fresh
      window.addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });
    }

    /* ================= start ================= */
    function init(me, err) {
      S.me = me; S.providers = me.providers || S.providers;
      panel.classList.add("su-on"); panel.removeAttribute("aria-live"); // the panel changes a lot: announcements go through #su-live and the error lines
      hide("#stepper");
      hide("#login-block"); // today's log-in block never shows in v2
      $("#su-top").append($("#c-error")); // wallet errors (today's code writes them to #c-error) now sit right under the step bar
      wire();
      return (async () => {
        const d = await refresh();
        if (!d.ok || !S.srv) { show("loading"); text("#su-loading-text", `The sign-up didn't load. ${errText(d)}`); hide("#su-reload", false); $("#su-reload").onclick = () => location.reload(); return; }
        try { sessionStorage.removeItem("su-reload"); } catch { /* ignore */ }
        const st = S.srv, bounce = err ? bounceFor(err) : null;
        const mid = Boolean(hasProgress(st) || st.wallet.done || me.pending);
        let remembered = false; try { remembered = localStorage.getItem("vicinity-account") === "1"; } catch { /* ignore */ }
        S.tab = params.get("mode") === "login" ? "login" : mid ? "new" : remembered ? "login" : "new";
        if (bounce && bounce.tab) S.tab = bounce.tab;
        if (params.get("step")) { history.replaceState(null, "", location.pathname); if (st.account.done && !st.wallet.done) S.hold = "account"; }
        if (bounce && bounce.hold && viewFor(st).steps.find((x) => x.key === bounce.hold).editable) S.hold = bounce.hold;
        // a transfer for an app wallet was started before this page was reloaded: carry on waiting for it
        if (me.proof && S.tab === "new" && viewFor(st).view === "wallet") { setIntro(); drawSteps(viewFor(st).steps); showProof(me.proof); }
        else render();
        if (bounce) { setErr(bounce.text); announce(bounce.text); }
      })();
    }

    return { init, onShow, walletProven, signLabel };
  }
})();
