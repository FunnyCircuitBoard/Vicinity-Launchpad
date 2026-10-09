// Onboarding v3 (SIGNUP_FLOW=v2): 1 Location, 2 Account (one tap agrees to the Terms and goes to Google; e-mail and a password are the
// other way), then the dashboard. The account exists the moment the login is verified: there is no wallet step. Plus the "Log in" tab,
// and the LINK MODE for a member whose account has no wallet yet (/connect?mode=link from the dashboard, or any signed-in visit):
// one free signature links the wallet, from this browser, from the wallet app on this phone ("Open app": /connect?link=CODE), from
// the phone for a computer (the pairing), or with a tiny transfer. Loaded by connect.js ONLY when /api/me says signupFlow is "v2"
// (so today's page never downloads it). The wallet screens (pick / sign / phone / app) are today's, in connect.js: the link mode and
// the Log in tab reuse them and get the result through walletProven(). Needs site.js (window.V) and wallets.js (window.VW). Nothing
// here touches the DOM until start() is called.
(() => {
  "use strict";

  /* ================= pure helpers: no DOM (test/signup-ui.test.js runs them in node) ================= */
  const STEPS = ["location", "account"];
  const VIEW_OF = { location: "location", account: "account", finish: "finish" };

  /**
   * Which screen to show and what the step bar looks like.
   * st = `state` from GET /api/signup/state; hold = a step the person is looking at again ("location": the done view, reachable from
   * the bar until the account is made).
   */
  function viewFor(st, hold) {
    const done = [Boolean(st.location && st.location.done), Boolean(st.account && st.account.done)];
    let view = VIEW_OF[st.next] || "location";
    const editable = { location: done[0] && view !== "finish", account: false }; // the account step ends the sign-up: nothing to redo after it
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
  /** True when the sign-up row holds anything the person would have to redo. */
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
  /**
   * Why the pairing screen ("approve in the wallet app, finish here") shows instead of "Open app": the connection is hidden behind a
   * relay, so the link can't move into the wallet app. `name` = the wallet the person tapped (null: "your wallet app"); `iphone` = Safari
   * on an iPhone, where the relay is iCloud Private Relay; `qr` = the screen shows a QR code for a phone (a tablet), not the wallet apps.
   */
  function relayWhy(name, iphone, qr) {
    const w = name || "your wallet app";
    const lead = `${iphone ? "Your iPhone hides its connection (iCloud Private Relay)" : "This browser hides its connection (a VPN or a private relay)"}, so the link can't move into ${w}`;
    return qr ? `${lead} here. Instead, scan the code below with your phone and approve there, then come back here: this page finishes the link by itself.` : `${lead}. Approve there instead, then come back here: this page finishes the link by itself.`;
  }
  /** The "Open app" screen's lead on a phone: what happens in the wallet app `name` (owner decision F4: the person stays there, signed in). */
  const carryLead = (name) => `${name} opens Vicinity and asks to connect this wallet to your account. Check the number, connect, and sign the free message. Then you stay in ${name}, logged in.`;
  /** The small print under "Open <app>": a relay code also has to be OPENED within 2 minutes, but the page renews it by itself, so the words don't say so. */
  const carrySmall = (relay) => (relay ? "This link works once, only on this phone. Never send it to anyone." : "This link works once, for 10 minutes, only on this phone. Never send it to anyone.");
  /** The link page's lead on a phone (the wallet apps as rows). */
  const linkLead = () => "Tap your wallet app. It opens Vicinity there: check the number, then sign once. You stay in the app, logged in.";
  /**
   * Back in Safari and the wallet app never opened the link (a universal link that fell back to the web, an app not installed). `browser`:
   * "iphone" (Safari: app links can be switched off per site with a long press), "chrome" (Chrome on Android: app links work there, so
   * it is the app), anything else (Firefox and others on Android ship with "open links in apps" off: Chrome does it).
   */
  const carryHint = (name, browser) => (browser === "iphone" || browser === true
    ? `${name} didn't open Vicinity? Press and hold “Open ${name}”, then choose “Open in ${name}”. No ${name} yet? Get it first.`
    : browser === "chrome"
      ? `${name} didn't open Vicinity? Make sure ${name} is installed, then tap “Open ${name}” again. Or tap “Didn't work?” below.`
      : `${name} didn't open Vicinity? Make sure ${name} is installed, or open this page in Chrome and try again.`);
  /**
   * The link was opened, but the server could not let it in there (carry/status "refused"). An ordinary link: the wallet app is on another
   * connection (Wi-Fi in one app and mobile data in the other), and the pairing, which works on any connection, becomes the button. A relay
   * link (`relay`, behind iCloud Private Relay): it was opened in another country or through a server or a VPN, which is rarely the person
   * (audit SEC-2: the pairing is bound to nothing, so it is never pushed then): a new link is the button (it kills this one), and the
   * pairing stays the quiet way for a phone abroad.
   */
  const carryRefused = (name, relay) => (relay
    ? "Your link was opened in another country or through a VPN, so it can't be used there. If that wasn't you, someone else has your link: get a new one, and never send it to anyone."
    : `${name} opened your link, but it is on another internet connection (Wi-Fi and mobile data?), so the link can't be used there. Approve in ${name} instead: that way works on any connection.`);
  /** The pairing under the "Open <app>" screen (the quiet way; after a relay link was refused, still the quiet way). */
  const carryPairQuiet = (name) => `Didn't work? Approve in ${name || "your wallet app"} and finish here instead`;
  /**
   * The wallet app opened the link on another connection (or, `relay`, from another country or through a VPN): what its dead screen says.
   * It quotes the button Safari shows then (carry/status "refused"): the pairing, "Approve in Phantom instead"; for a relay link the quiet
   * one, "Didn't work? Approve in Phantom and finish here instead". `name` = this wallet app.
   */
  const carryNetwork = (name, relay) => (relay
    ? `This link works only in the country where you made it, and not through a VPN. Travelling? Go back to Safari or Chrome and tap “${carryPairQuiet(name)}”: that way works anywhere.`
    : `Your wallet app and Safari are on different internet connections (Wi-Fi and mobile data?). Go back to Safari or Chrome and tap “Approve in ${name || "your wallet app"} instead”: that way works on any connection.`);
  /**
   * The three ways a wallet with no account is told where to go. `inApp` = a wallet app's own browser (Google can't run there), `name` its
   * name, `returning` = this browser has a hint of a member who connected a wallet before (the "more than one wallet" sentence is for them).
   */
  function noAccountCopy(inApp, name, returning = false) {
    const many = !returning ? "" : name ? ` More than one wallet in ${name}? Switch to the one you linked, then try again.` : " More than one wallet in your app? Switch to the one you linked, then try again.";
    return inApp
      ? { title: "No account for this wallet yet", body: `Vicinity accounts start with Google or e-mail. Create yours in Safari or Chrome (it takes a minute), then connect this wallet from your dashboard, one tap.${many}`, primary: "copy" }
      : { title: "No account for this wallet yet", body: "Create one with Google in a minute, then connect this wallet from your dashboard.", primary: "create" };
  }
  /**
   * The wallet is linked: what the done screen says and does. `where` = "app" (the wallet app's own browser: it stays there, on the
   * dashboard), "phone" (Safari / Chrome on a phone: the person keeps going in the wallet app, `app` its name) or "here" (a computer).
   * `inThere` (phone): the wallet app's browser got its own session (it claimed the link code); a pairing or a transfer gives it none, so
   * the person signs in there with one signature.
   */
  function linkedCopy(where, wallet, app, inThere = false) {
    const w = `Wallet ${wallet} is on your account.`, who = app || "Your wallet", there = app || "your wallet app";
    if (where === "app") return { h: `${who} connected ✓`, sub: `${w} Opening your dashboard…`, go: "Open my dashboard", auto: true };
    if (where === "phone") return { h: `${who} connected ✓`, sub: inThere ? `${w} Keep going in ${there}: you're logged in there.` : `${w} Keep going in ${there}: sign in there with one free signature.`, go: app ? `Open ${app}` : "Open my dashboard", auto: false };
    return { h: "Wallet linked.", sub: `${w} Taking you to your dashboard…`, go: "Open my dashboard", auto: true };
  }
  /** What the page says when "New here" with an e-mail that already has an account signs the person in instead (the typed password is thrown away). */
  const SAME_EMAIL = "That e-mail already has a Vicinity account, so we logged you in. The password you just typed was not saved: to set a new one, use “Forgot or never set a password?” on the Log in tab. Taking you to your dashboard…";
  /** Only ever follow the server (or a "with" link's next=) to our own dashboard: one of its tabs at most (/dashboard#profile). */
  const safeNext = (next) => (next === "/dashboard?welcome=1" || next === "/dashboard?linked=1" || /^\/dashboard#[a-z][a-z0-9-]{0,24}$/.test(String(next)) ? next : "/dashboard");
  /** Same loose shape check as the server (the code that arrives is the real proof). */
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && !/[\u0000-\u001f\u007f-\u009f<>]/.test(e);

  const LOCATION_UNVERIFIED = "We couldn't confirm your location. Turn on precise location, use your normal mobile or home internet (no VPN), and try again.";
  // One plain sentence for every error the backend can answer with, plus the page's own (offline, generic).
  const ERR = {
    // location
    location_required: "We couldn't read your location. Please try again.",
    location_unverified: LOCATION_UNVERIFIED,
    "location_unverified:finish": "Your connection no longer matches the place you shared (a different network, or a VPN?), so please check your location again. Your login is saved.",
    cities_unavailable: "The map is busy. Please try again in a minute.",
    bad_choice: "That choice isn't available any more. Please check your location again.",
    no_choices: "There is nothing to choose from any more. Please check your location again.",
    slow_down: "That's a lot of attempts. Take a short break and try again in a little while.",
    "slow_down:login": "Too many tries. Wait a few minutes, or log in with your wallet or Google, or use “Forgot or never set a password? E-mail me a code”.",
    "slow_down:reset": "Too many codes were asked for that address just now. Wait a little while and try again. You can always log in with your wallet.",
    handoff_expired: "That link expired. Tap “Get a new link” to try again.",
    // "Open app" on a phone: the wallet link goes on in the wallet app's browser
    carry_expired: "That link was already used or has run out (it works once, for 10 minutes). Go back to Safari or Chrome and tap Connect wallet again.",
    "carry_expired:app": "This link is old. Go back to Safari or Chrome and tap “Connect wallet” again.",
    carry_network: carryNetwork(null, false), // (the dead screen names the app: carryNetwork)
    "carry_network:relay": carryNetwork(null, true),
    carry_opened: "For your safety it no longer works. Go back to Safari or Chrome and tap “Get a new link”. That stops the old one.",
    carry_contested: "Someone else opened your link. It no longer works. Get a new link.",
    carry_ranout: "That link ran out. Get a new link.",
    carry_relay: "This browser hides its connection (a VPN or a private relay), so the link can't move into your wallet app. Approve there instead, then come back here: this page finishes the link by itself.", // (relayWhy() names the wallet)
    carry_replaced: "A newer link was made (another tab?). Get a new link here.",
    carry_elsewhere: "That link only works inside your wallet app, on the phone where you started. Nothing was changed.",
    carry_declined: "OK, nothing was linked. The link stays unused.",
    carry_old: "That link is from the old sign-up. Your account is a tap away: log in, or start here.",
    link_done: "A wallet was linked to this account a moment ago. Nothing changed here.",
    // the wallet link
    has_wallet: "Your account already has a wallet.",
    wrong_wallet: "That is not the wallet on your account. Use the one you linked, or unlink it first from your Profile tab.",
    no_account: "No Vicinity account uses this wallet yet. Accounts start with Google or e-mail; the wallet is linked from the dashboard.",
    use_link: "That signature was for a sign-in, so nothing was linked. To add this wallet to your account, use Connect wallet on your dashboard.",
    // the sign-up itself
    no_signup: "Your sign-up was open too long, so we cleared it. Please start again.",
    already_signed_in: "You're already signed in. Taking you to your dashboard…",
    already_finished: "Your account is already created. Taking you to your dashboard…",
    terms_required: "Please tick the box to agree to the Terms of Use.",
    bad_version: "The Terms of Use were updated. Please reload the page to read the new version.",
    not_enabled: "Sign-up is being updated. Please reload the page.",
    signup_unavailable: "Sign-up is down for a moment. Please try again in a few minutes.",
    link_unavailable: "The wallet link is down for a moment. Please try again in a few minutes.",
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
    social_taken: "That login already has a Vicinity account. Log in with it instead, or choose another login.",
    wallet_taken: "This wallet already belongs to another Vicinity account. Choose a different wallet, or log in to that account with it.",
    "wallet_taken:app": "This wallet already has a Vicinity account. Pick another wallet in your app, or sign in to that account with it.",
    // finishing
    account_required: "Your login isn't confirmed yet. Please finish the account step.",
    changed_retry: "Something changed while we were creating your account. Please try again.",
    // log in
    bad_credentials: "That e-mail and password don't match. Signed up with Google? Use the Google button. Forgot your password, or never set one? Use “E-mail me a code” below.",
    no_email_login: "Only accounts created with an e-mail address can use a password.",
    reprove: "Please connect your wallet and sign once more first.",
    relogin: "For your safety, log in again here, then tap “Remove it” on your dashboard again.",
    relogin_confirm: "For your safety, log in again here. Then try once more on your dashboard.",
    sign_in: "Please log in first.",
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
    if (code === "carry_network" && d && d.relay) return ERR["carry_network:relay"];
    if (code === "code_wrong") { const n = d && d.left; return n == null ? ERR.code_wrong : n === 0 ? ERR["code_wrong:last"] : `That code doesn't match. ${n} ${n === 1 ? "try" : "tries"} left.`; }
    if (code === "has_wallet" && d && d.wallet) return `Your account already has a wallet (${d.wallet}).`;
    return (ctx && ERR[`${code}:${ctx}`]) || ERR[code] || ERR.generic;
  }
  /** Google (or the server) sent the person back to /connect?error=<code>: which tab to open, where to land, and what to say. */
  function bounceFor(code) {
    if (code === "location_unverified") return { tab: "new", text: errText(code, "finish") }; // the server cleared the location: step 1, the login is kept
    if (code === "terms_required") return { tab: "new", text: errText(code) };
    if (code === "social_taken") return { tab: "new", stuck: true, text: errText(code) }; // the stuck screen: log in instead, or another login
    if (code === "no_account") return { tab: "new", text: errText(code) };
    if (code === "wallet_taken") return { tab: "login", text: errText(code) };
    return { text: errText(code) };
  }
  /**
   * What to do with a refusal from POST /api/signup/finish.
   *  go "next": ask the server where we are and go there · "stuck": stay and offer actions
   */
  function finishPlan(d) {
    const e = d && d.error;
    if (e === "location_unverified") return { go: "next", text: errText(e, "finish") };
    if (e === "location_required" || e === "account_required" || e === "terms_required") return { go: "next", text: errText(d) };
    if (e === "social_taken") return { go: "stuck", text: errText(d), actions: ["login", "ident"] };
    if (e === "changed_retry") return { go: "stuck", text: errText(d), actions: ["retry"], auto: true };
    return { go: "stuck", text: errText(d), actions: ["retry"] };
  }
  /** The wallet answers the sign-up page deals with itself (connect.js hands them to walletProven instead of showing a plain error). */
  const HANDLED = ["no_account", "wallet_taken", "has_wallet", "wrong_wallet", "link_done", "use_link"];

  window.VSignup = { start, pure: { viewFor, locSub, accSub, hasProgress, pwLen, pwHint, safeNext, validEmail, errText, bounceFor, finishPlan, resetField, relayWhy, carryLead, carrySmall, linkLead, carryHint, carryRefused, carryPairQuiet, carryNetwork, noAccountCopy, linkedCopy, SAME_EMAIL, ERR, HANDLED } };

  /* ================= the controller ================= */
  function start(ctx) {
    const { $, $$, el, api, toast, copy, burst, getLocation, short } = window.V;
    const W = window.VW;
    const { panel, params, show, setErr, renderPick, drawQR, showProof, quickSignIn } = ctx;
    const inApp = () => W.inWalletApp();
    // owner decision F4 (phones live inside the wallet app): the KNOWN wallet app whose own browser this is (null in Safari, Chrome, on a
    // computer, and in Instagram's or Facebook's browser), and the one this person uses on this phone (site.js V.walletApp)
    const WA = window.V.walletApp || { here: () => null, remembered: () => null, remember() {} };
    const here = () => WA.here();
    const knownApp = (id) => (id && W.KNOWN.find((k) => k.id === id)) || null;
    /** The link that opens Vicinity inside the wallet app `k`, signed in (or signing in with one tap there): /connect?mode=login&with=<id>. */
    const openIn = (k) => k.open(`${location.origin}/connect?mode=login&with=${k.id}`);
    const shortAddr = (a) => (short ? short(a) : `${String(a).slice(0, 4)}…${String(a).slice(-4)}`);
    const S = {
      mode: "signup",       // "signup" (New here / Log in) | "link" (a member without a wallet links one) | "linkin" (the wallet app's browser, /connect?link=)
      tab: "new", srv: null, me: null, providers: { google: false, email: false }, cur: "", view: "location",
      hold: null,           // a finished step the person is looking at again (or has just finished and not pressed Continue on)
      redo: false,          // step 1: show "Share my location" again although there is a result
      accMode: null,        // step 2: "choose" | "code" | null (null = what the server says)
      termsTouched: false,  // the Terms box was unticked by hand: the primaries wait for it
      started: false, finishing: false, finishFailed: null, finishRetried: false,
      ho: null, codeEmail: "", resetEmail: "", noteView: "", first: true, leaving: false, lost: false, autoTimer: null, justLocated: false,
      carry: null,          // link mode on a phone: an "Open app" link made here and not used yet { k, name, link, pin, ref, until, replaced, expired, opened }
      carryTimer: null,     // asking the server what became of it
      offer: null,          // the wallet app's browser: a link code that brought it here, waiting for the person to confirm { code, info }
      pairRelay: false,     // the pairing screen is shown instead of "Open app" because of a relay (Safari behind iCloud Private Relay)
      pairName: null,       // the wallet app the person tapped before the pairing screen (its heading names it)
      gatePending: false,   // "Sign in with Phantom" opened this page in the wallet app: the Terms gate waits for the sign-in (agreed on the account)
      withLink: false,      // this page was opened by such a link (/connect?mode=login&with=phantom)
      next: null,           // where that link asked to land after the sign-in (/dashboard#profile: "confirm it's you" in Safari), checked
      backRenewals: 0,      // links renewed because the person came back to this tab after the old one ran out
      touched: false,       // the person tapped or typed on this page (a late wallet never switches the tab under their finger)
    };
    const text = (sel, t) => { $(sel).textContent = t; };
    const hide = (sel, h = true) => { $(sel).hidden = h; };
    let liveFlip = false;
    /** Spoken by screen readers (a polite live region that exists from the start). */
    const announce = (t) => { liveFlip = !liveFlip; text("#su-live", liveFlip ? t : t + " "); };
    /** A calm one-sentence note under the step bar (why we moved the person). */
    function notice(msg) {
      const n = $("#su-note"); n.textContent = msg || ""; n.hidden = !msg; S.noteView = msg ? S.view : ""; if (msg) announce(msg);
      if (S.mode !== "signup") $("#su-top").hidden = !msg; // the link mode has no tabs or steps: the top shows only for a note
    }
    const reduced = () => Boolean(window.V.reduced);

    /* ---------- talking to the server ---------- */
    /** api() plus the answers every call shares: switched off, signed in elsewhere, sign-up lost. d._handled = "the page already dealt with it". */
    async function call(path, body, opt) {
      const d = await api(path, body);
      if (d._status === 404 && d.error === "not_enabled") { flagOff(); d._handled = true; return d; }
      if (S.mode === "signup" && (d.error === "already_signed_in" || d.error === "already_finished")) {
        const fin = path.endsWith("/finish");
        signedIn(errText(d), fin ? "/dashboard?welcome=1" : "/dashboard"); d._handled = true; return d;
      }
      if (d.error === "no_signup" && S.mode === "signup" && !(opt && opt.again)) return lostSignup(path, body, d);
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
      Object.assign(S, { hold: null, redo: false, accMode: null, finishFailed: null, codeEmail: "", tab: "new" });
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
          Object.assign(S, { hold: null, redo: false, accMode: null, codeEmail: "", finishFailed: null });
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
    const SHOW_FOCUS = { location: "#su-loc-title", account: "#su-acc-title", finish: "#su-fin-title", login: "#lg-title", reset: "#rs-title", carry: "#carry-h", carryIn: "#carry-in-h", link: "#link-title", noAccount: "#na-h", linkDead: "#ld-h" };
    /** Moving to another screen: focus its heading (not on the very first draw, so the page still starts at the top for keyboard users). */
    function focusHeading(key) {
      const h = $(SHOW_FOCUS[key]);
      if (!h) return;
      if (!S.first) {
        h.setAttribute("tabindex", "-1");
        h.focus({ preventScroll: true });
        panel.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" });
      }
      S.first = false;
    }
    const STEP_NAME = { location: "Location", account: "Account" };

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
    const linkMode = () => S.mode === "link";
    /** Called by connect.js every time a screen is shown. */
    function onShow(s) {
      S.cur = s;
      const newTab = S.tab === "new" && S.mode === "signup";
      // a phone in the link modes: the panel's own "Almost done · Link your wallet." is the heading, so the hero (the same words) goes
      const hero = $(".connect__intro"); if (hero) hero.hidden = (S.mode === "link" || S.mode === "linkin") && W.isMobile;
      $("#su-top").hidden = s === "approve" || s === "done" || s === "loading" || (S.mode !== "signup" && !S.noteView);
      $(".su-tabs").hidden = !["pick", "su-location", "su-account", "su-reset", "no-account"].includes(s) || S.mode !== "signup";
      $("#su-steps").hidden = !newTab || ["su-reset", "approve", "done", "loading", "carry-in", "no-account", "link-dead", "carry"].includes(s);
      $("#tab-new").setAttribute("aria-pressed", String(newTab));
      $("#tab-login").setAttribute("aria-pressed", String(!newTab && S.mode === "signup"));
      if (s === "pick") {
        hide("#login-block"); // today's log-in block never shows in v2
        const link = linkMode();
        hide("#lg-block", link || newTab); hide("#link-top", !link); hide("#or-line", link || newTab); hide("#su-wallet-lead", !link);
        hide("#alt-skip", !link); hide("#alt-check", link);
        text("#wallet-h", link ? "Choose your wallet" : "Log in with your wallet");
        const phoneLink = link && W.isMobile && !inApp() && !W.list().length; // Safari / Chrome on a phone: the wallet apps open the link
        if (link) text("#su-wallet-lead", phoneLink ? linkLead() : "Pick the wallet you want on your account. One free signature, nothing is paid or moved.");
        if (link && W.isMobile && !inApp()) hide("#wallets-none"); // a phone's browser never holds a wallet: the lead above says what to tap, "use your phone" would be odd
        hide("#link-noapp", !phoneLink); // "No wallet app yet? Get Phantom (free) ..." (a new tab: this page stays)
        // the Log in tab inside a known wallet app: ONE button signs in (connect + one signature); New here stays one tap away
        const k = here(), only = W.list().length === 1 ? W.list()[0] : null, inLogin = !link && !newTab;
        hide("#lg-wallet", !(inLogin && k && only)); hide("#lg-wallet-note", !(inLogin && k && only)); hide("#lg-join", !(inLogin && k));
        if (inLogin && k && only) text("#lg-wallet", `Sign in with ${only.name}`);
        if (!link) text("#or-line span", "Or log in with your wallet");
        const google = S.providers.google && !inApp();
        hide("#lg-google", !google); hide("#lg-inapp", !(inApp() && S.providers.google));
        hide("#lg-or", !(google && S.providers.email)); hide("#lg-form", !S.providers.email);
        hide("#lg-off", Boolean(S.providers.google || S.providers.email));
        text("#alt-phone em", W.isPhone && !inApp() ? (link ? "Approve in your wallet app, then finish here." : "Approve in your wallet app, then finish here.") : (link ? "Scan a code with your phone, sign there, finish here." : "Scan a code with your phone, sign there, continue here."));
        text("#alt-app em", link ? "Can't connect to websites? Send yourself a tiny, exact amount instead." : "Can't connect to websites? Send yourself a tiny, exact amount instead.");
      }
      if (s === "su-account") drawProviders();
      if (s === "sign") {
        text("#sign-h", linkMode() ? "Sign to link this wallet" : "Sign in with this wallet");
        text("#c-msg-label", linkMode() ? "See the message you will sign" : "See the message you'll sign");
        $("#c-sign").textContent = signLabel();
      }
      if (["sign", "phone", "app"].includes(s) && S.noteView) notice("");
      if (["sign", "phone", "app"].includes(s) && !S.first) { // today's wallet sub-screens: the keyboard follows the person to the new heading
        const h = $(`.cstate[data-state="${s}"] h2`);
        h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true });
      }
      if (["sign", "phone", "app"].includes(s) && linkMode()) linkStarted();
    }
    const signLabel = () => (linkMode() ? "Link wallet" : "Sign in");
    function setIntro() {
      const title = $(".connect__intro .page-title"), accent = el("span", "accent");
      const bullet = $(".connect__intro .safety li");
      if (bullet) bullet.textContent = S.mode === "link" || S.mode === "linkin" ? "Linking is free. It isn't a transaction and can't move funds." : "Signing in is free. It isn't a transaction and can't move funds.";
      if (S.mode === "link" || S.mode === "linkin") {
        text(".connect__intro .kicker", "Almost done");
        accent.textContent = "One signature."; title.replaceChildren("Connect your wallet.", el("br"), accent);
        text(".connect__intro .lead", "One free signature proves the wallet is yours. Nothing is paid or moved. Then your dashboard shows how much $VICINITY you hold and your rank.");
      } else if (S.tab === "login") {
        text(".connect__intro .kicker", "Welcome back");
        accent.textContent = "Your city's waiting."; title.replaceChildren("Log in.", el("br"), accent);
        text(".connect__intro .lead", "Log in with your Google account, your e-mail and password, or your wallet. You won't repeat anything else.");
      } else {
        text(".connect__intro .kicker", "Join Vicinity");
        accent.textContent = "Represent."; title.replaceChildren("Check in. Verify.", el("br"), accent);
        text(".connect__intro .lead", "Two quick steps: where you are, then who you are. Your dashboard opens right after. Link a wallet there whenever you like. Already a member? Tap Log in.");
      }
    }

    /* ---------- one render() decides what is on screen ---------- */
    function render() {
      const root = document.documentElement; // site.js hid the hero for a link code: the ordinary page has it
      if (S.mode === "signup" && root && root.classList) root.classList.remove("has-link");
      setIntro();
      if (S.offer) return drawOffer();                              // the wallet app's browser: "link this wallet to your account?"
      if (S.mode === "link") {
        if (S.carry) return drawCarry();                            // an "Open app" link is waiting to be used
        show("pick"); renderPick(); focusHeading("link");
        return;
      }
      if (S.tab === "login") {
        if (S.noteView) notice("");
        if (S.reset) { show("su-reset"); focusHeading("reset"); return; }
        show("pick"); renderPick(); focusHeading("login");
        return;
      }
      const { view, steps } = viewFor(S.srv, S.hold);
      if (S.noteView && S.noteView !== view) notice("");
      S.view = view;
      if (view === "location") showLocation(steps);
      else if (view === "account") showAccount(steps);
      else { drawSteps(steps); if (S.finishFailed) showFinishStuck(S.finishFailed); else finish(); }
      if (S.lost) { S.lost = false; notice(errText("no_signup")); } // found out while looking: say so, in the view the person lands on
    }
    function stepAnnounce(view) {
      if (STEP_NAME[view]) announce(`Step ${STEPS.indexOf(view) + 1} of 2: ${STEP_NAME[view]}`);
    }
    function setTab(tab) {
      if (S.mode !== "signup") S.mode = "signup";
      else if (S.tab === tab && !S.reset) return;
      S.tab = tab; S.reset = false; stopHandoff(); pairStarted(); // (a wallet tapped on the other tab is not this tab's)
      render();
    }

    /* ---------- the end of every successful path ---------- */
    function signedIn(sub, next, ms = 1200) {
      if (S.leaving) return;
      S.leaving = true; stopHandoff(); stopCarry();
      const k = here(); if (k) WA.remember(k.id); // signed in inside a wallet app: that is the app this person uses on this phone
      if (S.gatePending) { // the account agreed to the Terms: noted here so the gate never shows in this wallet app (asked once, before leaving)
        S.gatePending = false;
        api("/api/me?lite=1").then((me) => { const g = window.V.termsGate; if (g) { if (me && me.termsVersion) g.agreed(me.termsVersion); else g.open(); } });
      }
      show("done");
      text("#done-h", "You're in."); text("#done-badge", "📍");
      text("#done-sub", sub);
      const to = safeNext(next);
      $("#done-go").setAttribute("href", to); text("#done-go", "Open my dashboard →");
      announce(sub);
      const r = panel.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + 80);
      setTimeout(() => location.assign(to), ms);
    }
    /**
     * The wallet is linked to the account: the gold badge, then (owner decision F4) wherever the person shops on this device.
     *   viaApp  this IS the wallet app's browser (it claimed the code): "Phantom connected ✓", and its own dashboard opens here, logged in
     *   a phone's Safari / Chrome (Phantom finished it, or approved a pairing): "Keep going in Phantom" with Open Phantom (signed in there,
     *           or one signature) and Stay here; nothing moves by itself
     *   a computer: "Wallet linked.", then the dashboard
     * `appId` = the wallet app that linked it (the server's answer), else the one tapped here. Remembered for the Buy panel and the dashboard.
     * `inThere` = that app's browser got its own session (it claimed this page's link code): "you're logged in there"; otherwise (a
     * pairing, a transfer) it says one signature signs in there.
     */
    function linkDone(wallet, viaApp, appId, inThere = false) {
      if (S.leaving) return;
      S.leaving = true; stopCarry(); forgetLink(); forgetCarry();
      try { sessionStorage.removeItem("vl-started"); } catch { /* ignore */ }
      const k = knownApp(appId) || (viaApp ? here() : WA.remembered());
      if (k) WA.remember(k.id);
      const phone = !viaApp && W.isMobile && !here() && !W.list().length, away = Boolean(phone && k && k.open);
      const c = linkedCopy(viaApp ? "app" : away ? "phone" : "here", shortAddr(wallet), k ? k.name : null, inThere);
      show("done");
      text("#done-badge", "🔗"); text("#done-h", c.h); text("#done-sub", c.sub);
      $("#done-go").setAttribute("href", away ? openIn(k) : "/dashboard?linked=1"); text("#done-go", c.go);
      hide("#done-stay", !away);
      announce(`${c.h} ${c.sub}`);
      const r = panel.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + 80);
      // replace: Back from the dashboard must not land on this page again (it would bounce to the dashboard)
      if (!away) setTimeout(() => location.replace("/dashboard?linked=1"), viaApp ? 1500 : 1200);
    }
    /** A link attempt started in this tab: the dashboard (same tab, later) polls for the wallet while this is set. */
    function linkStarted() { try { sessionStorage.setItem("vl-started", "1"); } catch { /* ignore */ } }

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
        if (S.justLocated) { // just confirmed: a moment to see it, then step 2 by itself (the bar still leads back here)
          S.justLocated = false;
          clearTimeout(S.autoTimer);
          S.autoTimer = setTimeout(() => {
            if (S.cur !== "su-location" || S.hold !== "location" || S.view !== "location" || S.leaving) return;
            S.hold = null; render();
            announce(`Location confirmed: ${c ? c.name : "your community"}. Step 2 of 2: Account`);
          }, reduced() ? 0 : 800);
        }
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
    /** The location is in: show it done (and move on by itself after a moment). */
    function located() { S.redo = false; S.hold = S.srv.location.done ? "location" : null; S.justLocated = Boolean(S.hold); render(); }
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
        await refresh(); located();
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
      await refresh(); located();
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
      if (r.ok) { stopHandoff(); await refresh(); return located(); }
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

    /* ================= step 2: the account ================= */
    /** Which of Google / e-mail / neither is offered here. Google can't run inside a wallet app's browser: e-mail here, or Safari. */
    function drawProviders() {
      const app = inApp(), google = S.providers.google && !app, email = S.providers.email;
      hide("#su-google", !google); hide("#su-google-note", !google); hide("#su-inapp", !(app && S.providers.google));
      hide("#su-email-alt", !email); hide("#su-off", Boolean(S.providers.google || S.providers.email));
      // e-mail is the way in on a computer and inside a wallet app (no Google there); on a phone's Safari it waits behind one line
      const alt = $("#su-email-alt");
      if (email && (!W.isMobile || app || !google) && !alt.dataset.touched) alt.open = true;
    }
    function showAccount(steps) {
      drawSteps(steps);
      show("su-account");
      const sub = accSub(S.srv, S.accMode), a = S.srv.account, c = S.srv.location.community;
      hide("#su-recap", !c); if (c) text("#su-recap-city", `${c.name}, ${c.country}`);
      hide("#su-acc-choose", sub !== "choose"); hide("#su-code-form", sub !== "code"); hide("#su-acc-done", sub !== "done");
      text("#su-terms-version", S.srv.terms.version);
      if (S.srv.terms.done) $("#su-terms").checked = true;
      drawProviders();
      if (sub === "code") text("#su-code-to", S.codeEmail || (a.pending && a.pending.email) || "your e-mail");
      if (sub === "done") text("#su-acc-who", a.provider === "google" ? "Google account verified" : `E-mail verified: ${a.email || ""}`);
      syncTerms();
      stepAnnounce("account"); focusHeading("account");
    }
    /** One tap agrees: the primaries work until the person unticks the box by hand; then they wait for it, and a hint says so. */
    function syncTerms() {
      const refused = S.termsTouched && !$("#su-terms").checked;
      $("#su-google").disabled = refused;
      const send = $("#su-email-send"); if (!send.dataset.busy) send.disabled = refused;
      hide("#su-terms-hint", !refused);
    }
    function accError(msg) { text("#su-acc-error", msg || ""); }
    /** The server needs the Terms before any identity step: the tap ticks the box and records it. Returns true when it is on record. */
    async function ensureTerms() {
      const box = $("#su-terms");
      if (!box.checked) {
        if (S.termsTouched) { fieldErr("su-terms", errText("terms_required")); return false; } // unticked on purpose: the tap does not override that
        box.checked = true; syncTerms();
      }
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
        $("#su-email-alt").open = true;
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
    let verifying = false;
    async function verifyCode(ev) {
      if (ev) ev.preventDefault();
      if (verifying) return;
      fieldErr("su-code", "");
      const code = $("#su-code").value.replace(/\D/g, "").slice(0, 6);
      if (code.length !== 6) return fieldErr("su-code", errText("bad_code"));
      verifying = true;
      try {
        await busy($("#su-code-verify"), "Checking…", async () => {
          const d = await call("/api/signup/email/verify", { ...(S.codeEmail ? { email: S.codeEmail } : {}), code });
          if (d._handled) return;
          if (!d.ok) {
            if (d.error === "email_mismatch") { S.accMode = "choose"; S.codeEmail = ""; await refresh(); render(); return accError(errText(d)); }
            return fieldErr("su-code", errText(d, "code"));
          }
          $("#su-pw").value = ""; S.codeEmail = ""; S.accMode = null;
          if (d.existing) return signedIn(SAME_EMAIL, d.next, 5000); // longer than usual: there is a sentence to read
          if (d.isNew) return signedIn("Your account is ready. Taking you to your dashboard…", d.next); // the account was made with this very code
          // the login is recorded; the account waits for something the server named (the location again, a login that is taken...)
          if (d.state) S.srv = d.state; else await refresh();
          S.hold = null;
          if (d.finishError === "social_taken") { S.finishFailed = finishPlan({ error: d.finishError }); return render(); }
          render();
          if (d.finishError) notice(finishPlan({ error: d.finishError }).text);
        });
      } finally { verifying = false; }
    }
    /** "Use a different login / e-mail": forget the identity step only (terms and location stay). */
    async function useDifferentLogin() {
      const d = await call("/api/signup/account/reset", {});
      if (d._handled) return;
      if (!d.ok) return accError(errText(d));
      Object.assign(S, { codeEmail: "", accMode: "choose", hold: null, finishFailed: null });
      $("#su-pw").value = ""; if (d.state) S.srv = d.state; else await refresh();
      S.accMode = null; render();
    }

    /* ================= the wallet, in the link mode and on the Log in tab ================= */
    /** connect.js: the wallet is proven (or the server refused it with a code the page knows: HANDLED). */
    async function walletProven(d) {
      if (!d.ok) {
        walletFailed(); // ("Sign in with Phantom" opened this page: the person is not in, so this browser is a first visit: the Terms gate)
        if (d.error === "no_account") return showNoAccount();
        if (d.error === "link_done" || (d.error === "has_wallet" && S.mode === "link")) { const me = await api("/api/me?lite=1"); if (me.user && me.user.wallet) return linkDone(me.user.wallet); }
        show("pick"); renderPick();
        return setErr(errText(d), $("#wallets-detected"));
      }
      if (d.linked) return linkDone(d.wallet, false, (WA.remembered() || {}).id);
      if (String(d.next || "").startsWith("/dashboard")) {
        // ("Open Phantom" from Safari's "confirm it's you": the page the person was on, /dashboard#profile, came along as next=)
        return signedIn(S.mode === "link" ? "Your wallet is on your account. Taking you to your dashboard…" : "This wallet already has a Vicinity account, so we logged you in. Taking you to your dashboard…", d.next === "/dashboard" && S.next ? S.next : d.next);
      }
      return location.reload(); // an answer this page does not know (the switch went back to the old sign-up while this page was open)
    }
    const handles = (code) => HANDLED.includes(code);
    /** A hint that this browser belongs to a member who connected a wallet before: logged in here once, a wallet app remembered, or a "Sign in with Phantom" link. */
    function returningHere() {
      if (S.withLink || WA.remembered()) return true;
      try { return localStorage.getItem("vicinity-account") === "1"; } catch { return false; }
    }
    /** S10: a wallet nobody owns. Never step 1 by surprise, no location, no Terms, no Google: one screen that says where to go. */
    function showNoAccount() {
      const app = inApp(), k = here(), c = noAccountCopy(app, k ? k.name : null, returningHere());
      show("no-account");
      text("#na-h", c.title); text("#na-body", c.body);
      hide("#na-create", c.primary !== "create"); hide("#na-copy", c.primary !== "copy"); hide("#na-tiny", !app);
      announce(`${c.title}. ${c.body}`);
      S.first = false; focusHeading("noAccount");
    }

    /* ---- phones: "Open app" opens the link inside the wallet app's own browser ---- */
    // Safari / Chrome on a phone has no wallet in it; the wallet app opens pages in its own browser, with its own cookies. A tile first
    // makes a one-time code (POST /api/me/wallet/carry), then "Open <wallet>" opens /connect?link=CODE in the app. That page shows whose
    // account it is (the same check number as here, the username masked, the community) and links the wallet only when the person
    // confirms and signs there (offerLink, then claimLink). This page asks, while it is on screen, what became of it.
    /** connect.js asks before drawing the wallet tiles: in the link mode on a phone, a tile carries the link into the wallet app. */
    function carrier() {
      return S.mode === "link" && W.isMobile && !inApp() ? carryTo : null;
    }
    // A relay code (iCloud Private Relay) must be OPENED within 2 minutes: while its screen is on show and nobody opened it, it is renewed
    // quietly 15 s before, at most 3 times a visit (the person reading slowly never meets "ran out"; the server keeps the 2-minute rule).
    const RENEW_EARLY = 15_000, RENEW_MAX = 3, RENEW_BACK = 3;
    const carryOf = (k, r, more = {}) => ({ k, name: k.name, url: r.url, link: k.open(r.url), pin: r.pin, ref: r.ref, until: Date.parse(r.expiresAt),
      relay: Boolean(r.relay), openBy: r.openBy ? Date.parse(r.openBy) : null, replaced: false, expired: false, opened: false, contested: false, renewals: 0, ...more });
    // The link on screen is kept in this tab (sessionStorage, like a pairing): when "Open Phantom" fell back to phantom.com in this very
    // tab (no app, or app links off) and the person comes Back, or the tab reloads, the same screen comes back, with a fresh link.
    const CARRY_KEY = "vicinity-carry";
    const keepCarry = (c) => { try { sessionStorage.setItem(CARRY_KEY, JSON.stringify({ id: c.k.id, url: c.url, pin: c.pin, ref: c.ref, until: c.until, relay: c.relay, openBy: c.openBy })); } catch { /* private mode: a reload starts at the wallets */ } };
    const forgetCarry = () => { try { sessionStorage.removeItem(CARRY_KEY); } catch { /* ignore */ } };
    function keptCarry() {
      let c = null;
      try { c = JSON.parse(sessionStorage.getItem(CARRY_KEY) || "null"); } catch { return null; }
      const k = c && knownApp(c.id);
      if (!k || !k.open || typeof c.url !== "string" || !/^https?:\/\/[^/]+\/connect\?link=[A-Za-z0-9_-]{32,64}$/.test(c.url) || !/^[A-Za-z0-9_-]{12}$/.test(String(c.ref)) || !(c.until > Date.now() - 3600_000)) { forgetCarry(); return null; }
      return carryOf(k, { url: c.url, pin: String(c.pin), ref: c.ref, expiresAt: new Date(c.until).toISOString(), relay: c.relay, openBy: c.openBy ? new Date(c.openBy).toISOString() : null }, { restored: true });
    }
    async function carryTo(k, tile) {
      if (tile && tile.disabled) return;
      const go = tile ? tile.querySelector(".go") : null;
      setErr(""); if (S.noteView) notice("");
      if (tile) { tile.disabled = true; tile.setAttribute("aria-busy", "true"); } if (go) go.textContent = "Getting your link…";
      try {
        const r = await call("/api/me/wallet/carry", { app: k.id });
        if (r._handled) return;
        WA.remember(k.id); // for now: the app that really links it is remembered when it does (the status names it)
        if (!r.ok) {
          // Behind a relay the server could not make a link for this app (no country, another app...): the other way round (approve there, finish here)
          if (r.error === "carry_relay") return pairInstead(k.name, true);
          if (r.error === "has_wallet") return walletProven(r);
          if (r.error === "sign_in") return location.assign("/connect?mode=login");
          return setErr(errText(r), $("#more-wallets"));
        }
        S.carry = carryOf(k, r);
        keepCarry(S.carry);
        try { sessionStorage.setItem("su-carry", k.name); } catch { /* the name is only for the words on this page */ }
        linkStarted();
        render();
      } finally {
        if (tile) { tile.disabled = false; tile.removeAttribute("aria-busy"); } if (go) go.textContent = "Open app";
      }
    }
    /**
     * /connect?mode=link&app=phantom (the dashboard's "Link with Phantom" on a phone): the "Open app" link for that wallet is made at once,
     * as if its tile had been tapped. Anywhere else (a computer, inside the app already) the tiles are enough. The name leaves the address bar.
     */
    function openApp(id) {
      if (!id) return;
      if (params.has("app")) { params.delete("app"); try { history.replaceState(null, "", location.pathname + (String(params) ? `?${params}` : "")); } catch { /* ignore */ } }
      const k = W.KNOWN.find((x) => x.id === String(id).toLowerCase());
      if (!k || !k.open || !carrier()) return;
      const tile = $$("#wallets-known .wallet-option").find((b) => b.tagName === "BUTTON" && b.textContent.includes(k.name)) || null;
      carryTo(k, tile);
    }
    function stopCarry() { clearTimeout(S.carryTimer); clearTimeout(S.renewTimer); S.carryTimer = null; S.renewTimer = null; S.carry = null; }
    function pollSoon(ms) { clearTimeout(S.carryTimer); S.carryTimer = setTimeout(pollCarry, ms); }
    /** The "Open <wallet>" screen: the check number, and one tap opens the wallet app on this account's link. */
    function drawCarry() {
      const c = S.carry, name = c.name;
      show("carry");
      text("#carry-h", `Connect your wallet in ${name}`);
      text("#carry-lead", carryLead(name));
      text("#carry-pin", c.pin || "--");
      text("#carry-small", carrySmall(c.relay));
      const get = $("#carry-get"); get.href = c.k.site; text("#carry-get", `No ${name} on this phone? Get it first.`);
      const a = $("#carry-open"); a.href = c.link; a.textContent = `Open ${name}`;
      const dead = c.expired || c.replaced || c.contested, refused = Boolean(c.refused && !c.opened && !dead);
      const away = refused && c.refusedRelay; // a relay link opened in another country or through a VPN: a new link is the button (carryRefused)
      hide("#carry-open", dead || refused); hide("#carry-pinrow", dead || refused || !c.pin); hide("#carry-status", dead || refused); hide("#carry-renew", !dead && !away); hide("#carry-get", dead || refused);
      hide("#carry-hint", dead || refused || !c.hint); text("#carry-hint", c.hint ? carryHint(name, browserKind()) : "");
      text("#carry-status-text", c.opened ? `${name} opened your link…` : c.fresh ? `New link ready. Waiting for ${name}…` : `Waiting for ${name}…`);
      text("#carry-error", c.contested ? errText("carry_contested") : c.replaced ? errText("carry_replaced") : c.expired ? (c.relay && !c.opened ? errText("carry_ranout") : "That link ran out (links work for 10 minutes). Get a new link.")
        : refused ? carryRefused(name, c.refusedRelay) : "");
      // the way that works on any connection: a quiet link under the button, or THE button when the wallet app could not use the link
      const pair = $("#carry-pair"); pair.className = refused && !away ? "btn btn--primary btn--block" : "link-btn";
      text("#carry-pair", refused && !away ? `Approve in ${name} instead` : carryPairQuiet(name));
      announce(dead || refused ? $("#carry-error").textContent : c.fresh ? `New link ready: check number ${c.pin}. Tap Open ${name}.` : `Connect your wallet in ${name}: check number ${c.pin}. Tap Open ${name}.`);
      focusHeading("carry");
      if (!dead) { pollSoon(c.restored ? 0 : 3000); planRenew(c); }
    }
    /** A relay code on screen that nobody opened: a new one 15 s before its 2 minutes are up (never while the person is in the wallet app). */
    function planRenew(c) {
      clearTimeout(S.renewTimer); S.renewTimer = null;
      if (!c.relay || c.opened || c.refused || !c.openBy || c.renewals >= RENEW_MAX) return; // (a refused link stays: the screen says why)
      S.renewTimer = setTimeout(() => {
        if (S.carry !== c || c.opened || S.leaving || S.cur !== "carry" || document.hidden) return;
        renewCarry({ quiet: true });
      }, Math.max(0, c.openBy - RENEW_EARLY - Date.now()));
    }
    /** While this page is on screen: did the wallet app open the link, link the wallet, or is the link dead? (Asked again the moment the page comes back.) */
    async function pollCarry() {
      clearTimeout(S.carryTimer); S.carryTimer = null;
      const c = S.carry;
      if (!c || document.hidden || S.mode !== "link" || S.leaving) return;
      const d = await api("/api/me/wallet/carry/status?ref=" + encodeURIComponent(c.ref));
      if (S.carry !== c || S.leaving) return;
      if (!d.ok) { // no answer (offline, or the route is gone): the dashboard's own answer says whether the wallet is there
        const me = await api("/api/me?lite=1");
        if (S.carry !== c || S.leaving) return;
        if (me.user && me.user.wallet) return linkDone(me.user.wallet);
        return pollSoon(5000);
      }
      if (d.status === "linked") { text("#carry-status-text", "Linked ✓"); return linkDone(d.wallet, false, d.app || c.k.id, true); } // (that app claimed it: a session there)
      // a link this tab kept and showed again (Back from phantom.com, a reload): nobody opened it, so it may have been seen on the way
      // (a download page has its address): a new one at once, never "ran out" to a person who just came back
      if (c.restored) { c.restored = false; if (d.status === "waiting" || d.status === "expired") return renewCarry({ quiet: true, hint: d.status === "waiting" }); }
      // back in this tab after a while (installing the app, setting it up): a link nobody opened that ran out meanwhile is replaced at
      // once, quietly ("New link ready"), never "ran out" (at most RENEW_BACK times a visit)
      const justBack = c.justBack; c.justBack = false;
      if (justBack && d.status === "expired" && !c.opened && !c.contested && S.backRenewals < RENEW_BACK) { S.backRenewals++; return renewCarry({ quiet: true }); }
      if (d.status === "contested") { c.contested = true; forgetCarry(); return render(); }
      if (d.status === "expired" || Date.now() > c.until) { c.expired = true; forgetCarry(); return render(); }
      if (d.status === "replaced") { c.replaced = true; forgetCarry(); return render(); }
      // the wallet app opened it on another connection: say why, and the pairing is the button (behind a relay, from another country or
      // a VPN: say so, and a new link is the button)
      if (d.status === "refused" && !c.refused) { c.refused = true; c.refusedRelay = Boolean(d.relay); clearTimeout(S.renewTimer); render(); return; }
      if (d.status === "opened" && c.refused) { c.refused = false; render(); } // ...then it opened from the right one after all
      if (d.status === "opened" && !c.opened) { c.opened = true; c.fresh = false; clearTimeout(S.renewTimer); text("#carry-status-text", `${c.name} opened your link…`); announce(`${c.name} opened your link.`); }
      if (d.status === "waiting" && c.back && !c.hint && !c.refused) { c.hint = true; hide("#carry-hint", false); text("#carry-hint", carryHint(c.name, browserKind())); announce($("#carry-hint").textContent); }
      pollSoon(3000);
    }
    /** A new code for the same wallet app: by a tap ("Get a new link"), or quietly (a relay code about to run out, a kept one shown again). */
    async function renewCarry({ quiet = false, hint = false } = {}) {
      const old = S.carry, k = old && old.k;
      if (!k) return render();
      const go = async () => {
        const r = await call("/api/me/wallet/carry", { app: k.id });
        if (S.carry !== old || S.leaving || r._handled) return;
        if (!r.ok) {
          if (r.error === "carry_relay") { stopCarry(); forgetCarry(); render(); return pairInstead(k.name, true); }
          if (r.error === "has_wallet") return walletProven(r);
          if (quiet) { old.expired = true; forgetCarry(); return render(); }
          text("#carry-error", errText(r)); return;
        }
        S.carry = carryOf(k, r, { renewals: old.renewals + (quiet ? 1 : 0), fresh: quiet, hint: hint || old.hint, back: old.back });
        keepCarry(S.carry);
        render();
      };
      if (quiet) return go();
      await busy($("#carry-renew"), "Getting your link…", go);
    }
    /** The other way round on a phone: approve in the wallet app `name`, finish here (connect.js's pairing screen). relay = why. */
    function pairInstead(name, relay) {
      S.pairName = name || null;
      S.pairRelay = Boolean(relay);
      $("#alt-phone").click();
    }
    const iphone = () => /iPhone|iPod/i.test(String(navigator.userAgent || ""));
    /** carryHint's browser: "iphone", "chrome" (Chrome itself on Android: not its web view, Samsung, Firefox, Edge or Opera), or "other". */
    const browserKind = () => {
      const ua = String(navigator.userAgent || "");
      if (iphone()) return "iphone";
      return /Android/i.test(ua) && /Chrome\//.test(ua) && !/; wv\)|\bwv\b|SamsungBrowser|Firefox|EdgA|OPR\/|YaBrowser|UCBrowser/i.test(ua) ? "chrome" : "other";
    };
    /**
     * connect.js asks as the pairing starts: what it is for (the link of this account, or the Log in tab), the wallet the person
     * tapped (or none) and whether a relay is the reason. Used up once the pairing has started (pairStarted): a later "Wallet on my
     * phone" starts plain, but a start that failed ("Couldn't start") keeps them for the next try.
     */
    function pairContext() {
      return { for: S.mode === "link" ? "link" : "login", purpose: S.mode === "link" ? "link" : "login", name: S.pairName, relay: S.pairRelay };
    }
    function pairStarted() { S.pairName = null; S.pairRelay = false; }
    /**
     * This tab was reloaded (or iOS threw it away while the person was in the wallet app) during a pairing it kept (connect.js,
     * sessionStorage): may it carry on here? Only where it was started: the Log in tab, or the link mode of this account.
     * "resume" shows the pairing screen again; "later" = this page isn't ready yet (it didn't load): keep it for the next load;
     * "forget" = nothing to finish here.
     */
    function resumePair(saved) {
      if (S.cur === "loading" || (S.mode === "signup" && !S.srv)) return "later";
      if (S.leaving || S.offer || S.ho || S.carry) return "forget";
      if (saved.for === "link") return S.mode === "link" ? "resume" : "forget";
      if (saved.for === "login") { if (S.mode !== "signup") return "forget"; if (S.tab !== "login" || S.reset) { S.tab = "login"; S.reset = false; render(); } return "resume"; }
      return "forget"; // (a pairing of the old sign-up's wallet step: there is no such step any more)
    }
    /**
     * connect.js: the pairing on screen is gone (used, or run out). When another tab of this browser used it (a duplicated tab keeps
     * the same pairing), carry on from where that tab got to: it linked the wallet, or signed in. Returns true when this page moved on.
     */
    async function pairGone() {
      const me = await api("/api/me?lite=1");
      if (S.leaving || S.cur !== "phone") return true;
      if (S.mode === "link") { if (me.user && me.user.wallet) { linkDone(me.user.wallet); return true; } return false; }
      if (me.signedIn) { signedIn("This was finished in another tab. Taking you to your dashboard…", "/dashboard"); return true; }
      return false;
    }
    /** A wallet app's browser can take a while to put its wallet on the page: wait up to `ms` for it (true at once when the user agent says so). */
    function inAppSoon(ms = 3000) {
      return new Promise((resolve) => {
        if (inApp()) return resolve(true);
        let t = null;
        const off = W.onChange(() => { if (inApp()) { off(); clearTimeout(t); resolve(true); } });
        t = setTimeout(() => { off(); resolve(inApp()); }, ms);
      });
    }
    // The link code this tab is showing (the confirm screen, or the plain screen for a dead one) is kept in sessionStorage, so a reload
    // inside the wallet app (pull-to-refresh) offers it again (site.js reads it back for an hour at most) instead of the sign-up.
    // Forgotten when the link went through, the person said it is not them, or they chose the ordinary page.
    const LINK_KEY = "vicinity-link";
    // (with the opener nonce the server handed this browser: a wallet browser that drops cookies still proves it opened the code)
    const keepLink = (code, opener) => { try { sessionStorage.setItem(LINK_KEY, JSON.stringify({ code, at: Date.now(), ...(opener ? { opener } : {}) })); } catch { /* private mode: a reload starts over */ } };
    const forgetLink = () => { try { sessionStorage.removeItem(LINK_KEY); } catch { /* ignore */ } };
    const keptOpener = (code) => { try { const k = JSON.parse(sessionStorage.getItem(LINK_KEY) || "null"); return k && k.code === code && typeof k.opener === "string" ? k.opener : null; } catch { return null; } };
    /**
     * This browser was opened with a link code (/connect?link=). NOTHING happens on load: only a wallet app's browser on a phone even
     * looks at it, and the person first sees whose account it is (the check number of the page where they started, the username
     * masked, the community) and confirms, then signs (claimLink). Returns { offer } to show that; { dead } when the server refused
     * the code (used, run out, another connection, the account got its wallet): inside the wallet app that is ONE plain screen and
     * the Terms gate stays shut (never step 1 of the sign-up here); or { note } on a computer or in Safari, where the link is simply
     * not looked at (+ the Terms gate opens as usual). Never asks for a location, the Terms or a Google login.
     */
    async function offerLink(code) {
      const gate = window.V.termsGate;
      const plain = (msg) => { forgetLink(); if (gate) gate.open(); return { note: msg }; };
      if (!W.isMobile || !(await inAppSoon())) return plain(errText("carry_elsewhere"));
      const kept = keptOpener(code);
      const info = await call("/api/me/wallet/carry/info", kept ? { code, opener: kept } : { code });
      if (info._handled) return {};
      keepLink(code, info.opener || kept); // whatever the answer: a reload here shows this same screen again, not the sign-up
      if (!info.ok) return { dead: info };
      return { offer: { code, info, opener: info.opener || kept } }; // (the Terms were accepted on that account: the gate waits; noted here once the person says it is theirs)
    }
    /** F1: inside the wallet app's browser, a link that is dead (used, run out, another connection, or already done): one plain screen, nothing else. */
    function showLinkDead(r) {
      const code = r && r.error, app = inApp(), k = here();
      const known = { carry_expired: app ? "Almost there" : "That link was used or ran out", carry_network: "That link can't be used here", carry_opened: "That link was opened in another app", link_done: "A wallet is already linked" }[code];
      S.offer = null; S.mode = "linkin"; // no tabs, no step bar, no hero on a phone: this browser is the wallet app's
      show("link-dead");
      text("#ld-h", known || "Couldn't check your link");
      text("#ld-body", code === "carry_expired" && app ? errText(code, "app") : code === "link_done" && k ? `This account has its wallet. If it is the one in ${k.name}, sign in with it here.`
        : code === "carry_network" ? carryNetwork(k ? k.name : null, Boolean(r.relay)) : errText(r));
      // a button only where there is something to do here: sign in with the linked wallet, or try again when there was no answer at all
      hide("#ld-retry", Boolean(known)); hide("#ld-signin", !(code === "link_done" && k));
      if (k) { text("#ld-signin", `Sign in with ${k.name}`); $("#ld-signin").dataset.app = k.id; }
      announce(`${$("#ld-h").textContent}. ${$("#ld-body").textContent}`);
      S.first = false; focusHeading("linkDead");
    }
    /** S8: "Link this wallet to Sa•••'s Vicinity account?" in the wallet app's browser. */
    function drawOffer() {
      const i = S.offer.info, c = i.community, o = i.owner || {};
      show("carry-in");
      text("#carry-in-h", `Link this wallet to ${o.name || "•••"}'s Vicinity account?`);
      text("#carry-in-avatar", o.initial || "•");
      text("#carry-in-handle", `@${o.handle || "•••"}`);
      text("#carry-in-city", c ? `📍 ${c.name}, ${c.country}` : "");
      text("#carry-in-pin", i.pin);
      text("#carry-in-error", "");
      // this wallet app's browser is logged in to SOMEONE ELSE's account: said before anything is signed; "Yes" logs it out here first
      hide("#carry-in-here", !i.here); text("#carry-in-here", i.here ? `This app is logged in to ${i.here}'s account. Linking logs it out here.` : "");
      text("#carry-in-yes", i.here ? `Yes, log out ${i.here} and link` : "Yes, link my wallet");
      hide("#carry-in-yes", false); hide("#carry-in-wallets"); hide("#carry-in-tap"); hide("#carry-in-signin");
      announce(`Link this wallet to ${o.name || "someone"}'s Vicinity account? Check number ${i.pin}. Only continue if you started this yourself, on this phone.`);
      S.first = false; focusHeading("carryIn"); // the question is why the person is here: bring it on screen at once (the intro sits above it)
    }
    /**
     * "Yes, link my wallet": the account's Terms count here too. With exactly one wallet in this app (the usual case) its connect sheet and
     * then its sign sheet follow at once (no tile to tap); with several, or none yet, the tiles (re-drawn when the injection is late).
     * "Yes, log out Jo••• and link": this browser leaves the other account first (the server would refuse the claim otherwise).
     */
    let accepting = false;
    async function acceptLink() {
      if (!S.offer || accepting) return;
      accepting = true;
      try {
        if (window.V.termsGate) window.V.termsGate.agreed(S.offer.info.terms);
        if (S.offer.info.here) {
          const out = await api("/api/auth/logout", {});
          if (!out.ok) return text("#carry-in-error", errText(out.error === "offline" ? "offline" : "generic"));
          S.offer.info.here = null; S.me = { ...(S.me || {}), signedIn: false, user: null }; hide("#carry-in-here");
        }
        hide("#carry-in-yes");
        const list = W.list();
        if (list.length === 1) { text("#carry-in-tap", `Check ${list[0].name}: connect, then sign. Nothing is paid or moved.`); hide("#carry-in-tap", false); return claimLink(list[0], null); }
        hide("#carry-in-wallets", false);
        drawOfferWallets();
      } finally { accepting = false; }
    }
    function drawOfferWallets() {
      if (!S.offer || $("#carry-in-wallets").hidden) return;
      const list = W.list();
      $("#carry-in-wallets").replaceChildren(...list.map((a) => {
        const b = el("button", "wallet-option"); b.type = "button";
        const icon = W.safeIcon(a.icon);
        if (icon) { const img = el("img"); img.alt = ""; img.src = icon; b.append(img); } else b.append(W.mark(a.name));
        b.append(el("span", null, a.name), el("span", "detected", "Detected"));
        b.addEventListener("click", () => claimLink(a, b));
        return b;
      }));
      text("#carry-in-tap", list.length ? `Tap ${list.length === 1 ? list[0].name : "your wallet"} and sign. Nothing is paid or moved.` : "Waiting for your wallet app to connect…");
      hide("#carry-in-tap", false);
    }
    let claiming = false;
    /**
     * Connect, sign the link statement that names the owner, and the server links the wallet to that account and signs this browser in
     * (the person stays in the wallet app). `tile` is null when "Yes" went straight on (one wallet): a failure then shows the tiles to retry.
     */
    async function claimLink(adapter, tile) {
      const o = S.offer; if (!o || claiming) return;
      claiming = true; text("#carry-in-error", ""); hide("#carry-in-signin");
      const tag = tile ? tile.querySelector(".detected") : null;
      if (tile) { tile.setAttribute("aria-busy", "true"); if (tag) tag.textContent = "Waiting…"; }
      const k = here() || W.knownFor(adapter.name), opener = o.opener ? `&opener=${encodeURIComponent(o.opener)}` : "";
      try {
        const address = await adapter.connect();
        const m = await api("/api/message?address=" + encodeURIComponent(address) + "&action=link&code=" + encodeURIComponent(o.code) + opener);
        // the code died while the question was on screen (it ran out, someone else opened it, another connection): the same one plain
        // screen as a refused claim, never a tile to try again that could not work
        if (!m.message) { if (m.error && (handles(m.error) || /^carry_/.test(String(m.error)))) return linkRefused(m); return text("#carry-in-error", errText(m.error ? m : "offline")); }
        const sig = await adapter.signMessage(new TextEncoder().encode(m.message));
        const r = await call("/api/me/wallet/carry/claim", { code: o.code, address, message: m.message, signature: btoa(String.fromCharCode(...sig)),
          ...(o.opener ? { opener: o.opener } : {}), ...(k ? { app: k.id } : {}) });
        if (r._handled) return;
        if (!r.ok) {
          if (r.error === "already_signed_in") return text("#carry-in-error", "This app is logged in to another Vicinity account. Open the link again from Safari or Chrome: it offers to log it out here.");
          if (r.error === "wallet_taken") { // this wallet signs in to its own account: one tap away
            text("#carry-in-error", `This wallet already has a Vicinity account. Pick another wallet in ${k ? k.name : "your app"}, or sign in to that account with it.`);
            if (k) { text("#carry-in-signin", `Sign in with ${k.name}`); $("#carry-in-signin").dataset.app = k.id; hide("#carry-in-signin", false); }
            return;
          }
          if (/^carry_/.test(String(r.error)) || r.error === "link_done") return linkRefused(r);
          return text("#carry-in-error", errText(r));
        }
        S.offer = null;
        linkDone(r.wallet, true, r.app || (k && k.id));
      } catch (e) {
        text("#carry-in-error", /reject|cancel|denied|declin|closed/i.test(String((e && e.message) || e)) || (e && e.code === 4001) ? "Signing cancelled in your wallet. Nothing happened." : `${adapter.name || "Your wallet"} couldn't sign. Please try again.`);
      } finally {
        claiming = false;
        if (tile) { tile.removeAttribute("aria-busy"); if (tag) tag.textContent = "Detected"; }
        else if (S.offer && !S.leaving && S.cur === "carry-in") { hide("#carry-in-tap"); hide("#carry-in-wallets", false); drawOfferWallets(); } // to try again: the tile
      }
    }
    /** The wallet app's "Sign in with Phantom" (a dead link for an account that has its wallet, a wallet that is another account's): one tap, one signature. */
    function signInHere(id) { forgetLink(); location.assign(`/connect?mode=login&with=${encodeURIComponent(id)}`); }
    /** The code is dead (used, run out, another connection) or the account got a wallet meanwhile: say so, nothing else to do here. */
    async function linkRefused(r) {
      S.offer = null;
      const me = S.me || {};
      if (me.signedIn && me.user && !me.user.wallet) { forgetLink(); await leaveOffer("login"); return notice(errText(r)); } // the account's own browser: its link mode
      showLinkDead(r);
    }
    /** "No, that is not me": nothing happens, the code stays unused, and this is an ordinary first visit (the Terms gate). */
    async function declineLink() {
      S.offer = null; forgetLink();
      if (window.V.termsGate) window.V.termsGate.open();
      await leaveOffer("new");
      notice(errText("carry_declined"));
    }
    /** The dead-link screen's "log in here instead": the ordinary Log in tab, and the Terms gate as for anyone new in this browser. */
    async function leaveDead() {
      forgetLink();
      if (window.V.termsGate) window.V.termsGate.open();
      await leaveOffer("login");
    }
    /** Off the confirm screen: the ordinary page for whoever this browser is (a member without a wallet: the link mode; else the tabs). */
    async function leaveOffer(tab) {
      const me = S.me || {};
      if (me.signedIn && me.user && !me.user.wallet) { S.mode = "link"; return render(); }
      S.mode = "signup"; S.tab = tab;
      if (!S.srv) { const d = await refresh(); if (!d.ok || !S.srv) return failedLoad(d); }
      render();
    }

    /* ================= the end: create the account (only a page that retries ever sees this) ================= */
    const FINISH_BUTTONS = { retry: "#su-fin-retry", login: "#su-fin-login", ident: "#su-fin-ident" };
    async function finish() {
      if (S.finishing) return;
      S.finishing = true;
      show("su-finish"); text("#su-fin-error", ""); hide("#su-fin-actions"); text("#su-fin-title", "Creating your account…"); hide("#su-fin-sub", false);
      announce("Creating your account");
      const d = await call("/api/signup/finish", {});
      S.finishing = false;
      if (d._handled) return;
      if (d.ok) return signedIn("Your account is ready. Taking you to your dashboard…", d.next);
      const me = await api("/api/me?lite=1"); // another tab may have finished it already
      if (me.signedIn) return signedIn(errText("already_finished"), "/dashboard?welcome=1");
      const plan = finishPlan(d);
      if (plan.auto && !S.finishRetried) { S.finishRetried = true; return setTimeout(finish, 1200); }
      if (plan.go === "next") {
        await refresh(); S.hold = null; S.redo = false; S.accMode = null;
        if (viewFor(S.srv).view !== "finish") { render(); return notice(plan.text); } // the server cleared the step: go there
      }
      S.finishFailed = plan; showFinishStuck(plan);
    }
    function showFinishStuck(plan) {
      show("su-finish");
      text("#su-fin-title", plan.actions && plan.actions.includes("ident") ? "That login already has a Vicinity account" : "We couldn't finish yet"); hide("#su-fin-sub");
      text("#su-fin-error", plan.text); announce(plan.text);
      hide("#su-fin-actions", false);
      const acts = plan.actions || ["retry"];
      for (const [k, sel] of Object.entries(FINISH_BUTTONS)) hide(sel, !acts.includes(k));
      S.first = false; $("#su-fin-title").setAttribute("tabindex", "-1"); $("#su-fin-title").focus({ preventScroll: true });
    }
    async function finishAction(kind) {
      if (kind === "retry") { S.finishFailed = null; S.finishRetried = false; return finish(); }
      if (kind === "login") { S.finishFailed = null; S.tab = "login"; return render(); }
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
      $$("#su-steps button").forEach((b) => b.addEventListener("click", () => { clearTimeout(S.autoTimer); S.justLocated = false; S.hold = b.closest("li").dataset.step; S.redo = false; render(); }));
      // step 1
      $("#su-loc-go").addEventListener("click", shareLocation);
      $("#su-loc-phone").addEventListener("click", () => startHandoff(W.isMobile ? "browser" : "desktop"));
      $("#su-ho-copy").addEventListener("click", () => copy($("#su-ho-link").value, "Link copied. Paste it in your browser."));
      $("#su-ho-link").addEventListener("focus", (e) => e.target.select());
      $("#su-ho-cancel").addEventListener("click", () => { stopHandoff(); render(); });
      $("#su-ho-renew").addEventListener("click", renewHandoff);
      $("#su-choices-redo").addEventListener("click", () => { S.redo = true; render(); });
      $("#su-loc-continue").addEventListener("click", () => { clearTimeout(S.autoTimer); S.justLocated = false; S.hold = null; S.redo = false; render(); });
      $("#su-loc-redo").addEventListener("click", () => { clearTimeout(S.autoTimer); S.justLocated = false; S.redo = true; S.hold = "location"; locError(""); render(); });
      $("#su-recap-redo").addEventListener("click", () => { S.redo = true; S.hold = "location"; locError(""); render(); });
      // coming back to the wallet app: the timers slept while it was in the background, so ask right away
      document.addEventListener("visibilitychange", () => { if (!document.hidden && S.ho) { clearTimeout(S.ho.timer); pollHandoff(); } });
      // "Open app" (phones): back from the wallet app, ask at once what happened there (and say what to do if it never opened the link)
      document.addEventListener("visibilitychange", () => { if (!document.hidden && S.carry) { S.carry.back = true; S.carry.justBack = true; pollCarry(); } });
      $("#carry-back").addEventListener("click", () => { stopCarry(); render(); });
      // the other way on a phone: approve in the wallet app, finish here (the pairing: no cookie or connection has to match)
      $("#carry-pair").addEventListener("click", () => { const name = S.carry && S.carry.name; stopCarry(); render(); pairInstead(name, false); });
      $("#carry-renew").addEventListener("click", () => renewCarry());
      $("#carry-in-signin").addEventListener("click", (e) => signInHere(e.currentTarget.dataset.app));
      $("#ld-signin").addEventListener("click", (e) => signInHere(e.currentTarget.dataset.app));
      // the Log in tab inside a wallet app: one tap signs in (connect + one signature); "New here? Join" is the other tab
      $("#lg-wallet").addEventListener("click", () => { const a = W.list()[0]; if (a && quickSignIn) quickSignIn(a, null); });
      $("#lg-join").addEventListener("click", () => setTab("new"));
      $("#carry-in-yes").addEventListener("click", acceptLink);
      $("#carry-in-no").addEventListener("click", declineLink);
      // the dead-link screen (the wallet app's browser)
      $("#ld-retry").addEventListener("click", () => location.reload());
      $("#ld-login").addEventListener("click", leaveDead);
      // the no-account screen
      $("#na-create").addEventListener("click", () => { S.mode = "signup"; S.tab = "new"; S.hold = null; render(); });
      $("#na-another").addEventListener("click", () => { S.mode = "signup"; S.tab = "login"; render(); });
      $("#na-copy").addEventListener("click", () => copy(`${location.origin}/connect`, "Paste it in Safari or Chrome"));
      $("#na-login").addEventListener("click", () => { S.mode = "signup"; S.tab = "login"; render(); });
      // step 2
      $("#su-terms").addEventListener("change", () => { S.termsTouched = true; fieldErr("su-terms", ""); syncTerms(); });
      $("#su-google").addEventListener("click", useGoogle);
      $("#su-copy").addEventListener("click", () => copy(`${location.origin}/connect`, "Link copied. Paste it in Safari or Chrome."));
      $("#su-email-alt").addEventListener("toggle", () => { $("#su-email-alt").dataset.touched = "1"; });
      $("#su-email-form").addEventListener("submit", sendCode);
      $("#su-code-form").addEventListener("submit", verifyCode);
      $("#su-code").addEventListener("input", (e) => { if (e.target.value.replace(/\D/g, "").length === 6) verifyCode(); }); // the 6th digit sends it
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
      // a wallet turning up (they appear a moment after the page loads) can show this is a wallet app: Google goes away; the link's tiles fill in
      W.onChange(() => {
        if (S.cur === "su-account") drawProviders();
        if (S.cur === "carry-in") drawOfferWallets();
        if (S.cur === "pick" && S.mode === "signup") onShow("pick"); // the Log in tab's "Sign in with <wallet>" for a wallet that came late
      });
      // the page was restored from the back/forward cache: it may show a finished step, so start fresh
      window.addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });
    }

    /* ================= start ================= */
    /**
     * Resolves true once the page shows the sign-up (its state loaded), false when it could not load it ("Reload the page").
     * `brought` = { carry, link }: the codes site.js took out of the address bar (an old sign-up carry, or a link for this phone's wallet app).
     * A signed-in member without a wallet lands in the link mode, whatever the address said (an old bookmark lands right).
     */
    function init(me, err, brought = {}) {
      S.me = me; S.providers = me.providers || S.providers;
      // "Connect Phantom" / "Sign in with Phantom" (/connect?mode=login&with=phantom), opened inside the wallet app: read once, then gone
      // (&next=/dashboard#profile: where to land after it, only one of the dashboard's own tabs: safeNext)
      const withId = params.get("with"), nextAsked = params.get("next");
      S.withLink = withId !== null; S.next = nextAsked !== null && safeNext(nextAsked) === nextAsked && nextAsked !== "/dashboard" ? nextAsked : null;
      if (withId !== null || nextAsked !== null) { params.delete("with"); params.delete("next"); try { history.replaceState(null, "", location.pathname + (String(params) ? `?${params}` : "")); } catch { /* ignore */ } }
      panel.classList.add("su-on"); panel.removeAttribute("aria-live"); // the panel changes a lot: announcements go through #su-live and the error lines
      for (const t of ["pointerdown", "keydown", "click"]) panel.addEventListener(t, () => { S.touched = true; });
      hide("#stepper");
      hide("#login-block"); // today's log-in block never shows in v2
      wire(); // wallet errors (#c-error) sit under the step bar, or right under the control that failed (connect.js setErr)
      return (async () => {
        if (brought.link != null) { // "Open app" brought a link here: ask before anything happens
          const o = await offerLink(brought.link);
          if (S.leaving) return true;
          if (o.offer) { S.offer = o.offer; S.mode = "linkin"; render(); return true; }
          const said = o.dead ? errText(o.dead) : o.note;
          if (me.signedIn && me.user && !me.user.wallet) { // this browser is the account's own (logged in here before): its link mode, with the reason
            forgetLink(); if (o.dead && window.V.termsGate) window.V.termsGate.agreed(me.termsVersion || "2026-10-01");
            S.mode = "link"; render(); if (said) notice(said); return true;
          }
          if (me.signedIn) { forgetLink(); signedIn("You're already set. Taking you to your dashboard…", "/dashboard"); return true; }
          if (o.dead) { showLinkDead(o.dead); return true; } // the wallet app's browser: one plain screen, the gate stays shut, never step 1
          if (o.note) S.tab = "new";
          const d = await refresh();
          if (!d.ok || !S.srv) return failedLoad(d);
          render(); if (o.note) notice(o.note);
          return true;
        }
        if (me.signedIn && me.user && !me.user.wallet) { // the link mode: the account exists, the wallet does not
          S.mode = "link";
          if ((brought.carry != null || withId !== null) && window.V.termsGate) window.V.termsGate.agreed(me.termsVersion || "2026-10-01");
          // a link this tab showed before (Back from phantom.com, a reload): the same screen, with a fresh link if nobody opened it
          const kept = W.isMobile && !inApp() ? keptCarry() : null;
          if (kept) S.carry = kept;
          render();
          if (err) { const b = bounceFor(err); setErr(b.text); announce(b.text); }
          if (!kept) openApp(params.get("app"));
          return true;
        }
        if (brought.carry != null && window.V.termsGate) window.V.termsGate.open(); // an old sign-up's link: one calm line, the ordinary tabs
        const d = await refresh();
        if (!d.ok || !S.srv) return failedLoad(d);
        try { sessionStorage.removeItem("su-reload"); } catch { /* ignore */ }
        const st = S.srv, bounce = err ? bounceFor(err) : null;
        const mid = hasProgress(st);
        let remembered = false; try { remembered = localStorage.getItem("vicinity-account") === "1"; } catch { /* ignore */ }
        // inside a known wallet app a visitor most likely signs in with its wallet (a sign-up's location rarely works there): Log in first
        S.tab = params.get("mode") === "login" ? "login" : mid ? "new" : remembered || here() ? "login" : "new";
        if (bounce && bounce.tab) S.tab = bounce.tab;
        if (params.get("step")) history.replaceState(null, "", location.pathname);
        if (bounce && bounce.stuck) S.finishFailed = finishPlan({ error: err });
        // a transfer for an app wallet was started before this page was reloaded (the Log in tab): carry on waiting for it
        if (me.proof && S.tab === "login") { setIntro(); showProof(me.proof); }
        else render();
        if (bounce && !bounce.stuck) { if (bounce.tab === "new" && viewFor(st).view !== "finish") notice(bounce.text); else { setErr(bounce.text); announce(bounce.text); } }
        if (brought.carry != null) notice(errText("carry_old"));
        if (withId !== null) quickFromLink(withId);
        else if (S.tab === "new" && !mid && !bounce && W.isMobile && !here()) lateWalletApp();
        return true;
      })();
    }
    /**
     * /connect?mode=login&with=<id> for a visitor: inside that wallet app (its wallet turns up within 3 s), the sign-in starts by itself,
     * once: its connect sheet, then ONE signature, then the dashboard (the owner's "tap Connect wallet, go to the wallet, buy there").
     * The account's Terms are noted on the way in; anywhere else (Safari, a computer, another app) the page is the ordinary Log in tab
     * and the Terms gate opens as for any first visit.
     */
    async function quickFromLink(id) {
      const gate = window.V.termsGate;
      const wanted = () => W.list().find((a) => { const k = W.knownFor(a.name); return k && k.id === id; }) || null;
      if (W.isMobile && !wanted()) await new Promise((resolve) => {
        const off = W.onChange(() => { if (wanted()) { off(); clearTimeout(t); resolve(); } });
        const t = setTimeout(() => { off(); resolve(); }, 3000);
      });
      const a = wanted();
      if (!a || !here() || !quickSignIn || S.leaving || S.mode !== "signup") { if (gate) gate.open(); return; }
      S.gatePending = true;
      if (S.tab !== "login" || S.reset) { S.tab = "login"; S.reset = false; render(); }
      quickSignIn(a, null);
    }
    /**
     * A wallet app's wallet can turn up a few seconds after the page drew (late injection): this IS a wallet app then, and a visitor who has
     * not touched the page yet gets the Log in tab after all, with its "Sign in with <wallet>" (as if the wallet had been there at once).
     * Someone already typing or tapping on New here is never moved.
     */
    function lateWalletApp(ms = 5000) {
      let t = null;
      const off = W.onChange(() => {
        if (!here()) return;
        off(); clearTimeout(t);
        if (S.touched || S.leaving || S.mode !== "signup" || S.tab !== "new" || S.cur !== "su-location" || S.hold || hasProgress(S.srv)) return;
        setTab("login");
      });
      t = setTimeout(off, ms);
    }
    /** connect.js: the wallet said no (cancelled, failed) during a sign-in this page started for a "with" link: a first visit after all (the gate). */
    function walletFailed() { if (!S.gatePending) return; S.gatePending = false; if (window.V.termsGate) window.V.termsGate.open(); }
    function failedLoad(d) {
      show("loading"); text("#su-loading-text", `The sign-up didn't load. ${errText(d)}`); hide("#su-reload", false); $("#su-reload").onclick = () => location.reload();
      return false;
    }

    return { init, onShow, walletProven, walletFailed, handles, signLabel, linkMode, carrier, pairContext, pairStarted, resumePair, pairGone, say: notice,
      relayWhy: (name, qr) => relayWhy(name, iphone(), qr) };
  }
})();
