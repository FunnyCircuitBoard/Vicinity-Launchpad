// Onboarding v3, browser side: the pure helpers of public/signup.js (run in node, no DOM) and checks that the page
// markup, the loader in connect.js and the script agree with each other and with the backend contract (two steps, no wallet step;
// the wallet is linked from the dashboard: the link mode of the same page).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
const src = read("signup.js");
const win = {};
vm.runInNewContext(src, { window: win }); // the file only defines things; nothing touches the page until start() is called
const P = win.VSignup.pure;
const plain = (x) => JSON.parse(JSON.stringify(x)); // the script runs in its own realm: compare plain copies

const empty = () => ({ terms: { done: false, version: "2026-10-01" }, location: { done: false }, account: { done: false }, next: "location" });
const state = (o = {}) => ({ ...empty(), ...o });

test("viewFor: two steps that follow the server's `next`, finished steps ticked; 'finish' ticks both and holds nothing open", () => {
  let v = P.viewFor(empty());
  assert.equal(v.view, "location");
  assert.deepEqual(plain(v.steps.map((s) => [s.key, s.n, s.done, s.active])), [["location", 1, false, true], ["account", 2, false, false]]);
  v = P.viewFor(state({ location: { done: true }, next: "account" }));
  assert.equal(v.view, "account");
  assert.deepEqual(plain(v.steps.map((s) => s.done)), [true, false]);
  v = P.viewFor(state({ location: { done: true }, account: { done: true }, next: "finish" }));
  assert.equal(v.view, "finish");
  assert.ok(v.steps.every((s) => s.done && !s.active && !s.editable), "all ticked, none open for change while the account is being created");
  assert.equal(P.viewFor({ ...empty(), next: "nonsense" }).view, "location", "an unknown step falls back to the first one");
  assert.equal(P.viewFor({ ...empty(), next: "wallet" }).view, "location", "the old wallet step is no step: the first one");
});

test("viewFor: the location can be looked at again until the account is made; the account step is never held (it ends the sign-up)", () => {
  const atAccount = state({ location: { done: true }, next: "account" });
  assert.equal(P.viewFor(atAccount, "location").view, "location", "the done view, from the bar");
  assert.equal(P.viewFor(atAccount, "location").steps[0].active, true);
  assert.equal(P.viewFor(atAccount).steps[0].editable, true);
  assert.equal(P.viewFor(atAccount, "account").view, "account", "a hold on the current step changes nothing");
  assert.equal(P.viewFor(empty(), "location").view, "location");
  assert.equal(P.viewFor(empty(), "account").view, "location", "a hold on a step that is not editable is ignored");
  const finishing = state({ location: { done: true }, account: { done: true }, next: "finish" });
  assert.equal(P.viewFor(finishing, "location").view, "finish", "while the account is being created nothing is open");
  // the login is recorded but the location was cleared (the finish refused it): step 1 again, step 2 ticked
  const back = state({ location: { done: false }, account: { done: true, provider: "google" }, next: "location" });
  assert.deepEqual(plain(P.viewFor(back).steps.map((s) => [s.done, s.active])), [[false, true], [true, false]]);
});

test("locSub / accSub: which part of a step shows", () => {
  const choices = [{ id: 1, name: "A", country: "US", km: 10 }];
  assert.equal(P.locSub(empty(), null, false), "ask");
  assert.equal(P.locSub(state({ location: { done: false, choices } }), null, false), "choices");
  assert.equal(P.locSub(state({ location: { done: true, choices, picked: true } }), null, false), "done", "choices stay after picking, the community wins");
  assert.equal(P.locSub(state({ location: { done: true } }), null, true), "ask", "Check again shows the button");
  assert.equal(P.locSub(state({ location: { done: true } }), { code: "x" }, false), "handoff", "a running hand-off wins");
  assert.equal(P.accSub(empty(), null), "choose");
  assert.equal(P.accSub(state({ account: { done: false, pending: { email: "a***@b.co" } } }), null), "code", "after a reload the pending code is resumed");
  assert.equal(P.accSub(state({ account: { done: false, pending: { email: "a***@b.co" } } }), "choose"), "choose", "unless the person went back");
  assert.equal(P.accSub(empty(), "code"), "code");
  assert.equal(P.accSub(state({ account: { done: true, provider: "google" } }), "code"), "done");
});

test("hasProgress: what lives in the sign-up row counts", () => {
  assert.equal(P.hasProgress(empty()), false);
  assert.equal(P.hasProgress(null), false);
  assert.equal(P.hasProgress(state({ location: { done: true } })), true);
  assert.equal(P.hasProgress(state({ location: { done: false, choices: [{ id: 1 }] } })), true);
  assert.equal(P.hasProgress(state({ terms: { done: true, version: "2026-10-01" } })), true);
  assert.equal(P.hasProgress(state({ account: { done: false, pending: { email: "a***@b.co" } } })), true);
});

test("passwords are counted in characters people see; the hint is length only", () => {
  assert.equal(P.pwLen("abc"), 3);
  assert.equal(P.pwLen("😀😀😀"), 3, "an emoji is one character");
  assert.equal(P.pwLen("ｐａｓｓ"), 4, "full-width letters are normalised like the server does (NFKC)");
  assert.equal(P.pwHint(0).level, "empty");
  assert.equal(P.pwHint(5).level, "short");
  assert.match(P.pwHint(5).text, /5 of 10 characters\. 5 more to go\./);
  assert.equal(P.pwHint(10).level, "ok");
  assert.equal(P.pwHint(14).level, "good");
  assert.equal(P.pwHint(129).level, "long");
  assert.equal(P.pwHint(128).level, "good");
});

test("safeNext only ever leaves for our own dashboard", () => {
  assert.equal(P.safeNext("/dashboard?welcome=1"), "/dashboard?welcome=1");
  assert.equal(P.safeNext("/dashboard?linked=1"), "/dashboard?linked=1");
  assert.equal(P.safeNext("/dashboard"), "/dashboard");
  assert.equal(P.safeNext("/dashboard#profile"), "/dashboard#profile", "a tab of our own dashboard (\"Open Phantom\" from Safari's 'confirm it's you')");
  for (const bad of ["//evil.example/x", "https://evil.example", "javascript:alert(1)", "/dashboard?welcome=2", "/connect", "", null, undefined, "/dashboard/../x", "/dashboard#x y", "/dashboard#Profile", "/dashboard#a/b", "/dashboard#"]) assert.equal(P.safeNext(bad), "/dashboard", String(bad));
});

test("validEmail: the same loose shape check as the server", () => {
  for (const ok of ["a@b.co", "ada.lovelace@example.com", "x+tag@sub.example.org"]) assert.equal(P.validEmail(ok), true, ok);
  for (const bad of ["", "nope", "a@b", "a@b.c", "a b@c.de", "a@b.co<script>", "a@@b.co", "@b.co", "a@.co"]) assert.equal(P.validEmail(bad), false, bad);
});

// every code the backend can answer with (the sign-up, the log-in, the wallet link) has its own plain sentence
const CONTRACT_CODES = [
  "location_required", "location_unverified", "cities_unavailable", "bad_choice", "no_choices", "slow_down",
  "no_signup", "already_signed_in", "already_finished", "terms_required", "bad_version", "not_enabled", "signup_unavailable", "link_unavailable", "wrong_origin",
  "bad_email", "bad_password", "password_short", "password_long", "password_common", "password_is_email", "email_unavailable", "too_soon", "too_many",
  "bad_code", "code_wrong", "code_expired", "email_mismatch", "no_account", "social_taken", "wallet_taken",
  "account_required", "changed_retry",
  "has_wallet", "wrong_wallet", "link_done", "use_link", "carry_expired", "carry_network", "carry_relay", "carry_replaced", "carry_elsewhere", "carry_old", "sign_in",
  "carry_opened", "relogin",
  "bad_credentials", "no_email_login", "reprove",
  "login_unavailable", "login_cancelled", "login_failed", "login_expired",
  "offline",
];
test("errText: every backend error code maps to one plain sentence", () => {
  const generic = P.ERR.generic;
  for (const code of CONTRACT_CODES) {
    const t = P.errText({ ok: false, error: code });
    assert.notEqual(t, generic, `${code} has its own sentence`);
    assert.match(t, /[.!?”…]$/, `${code} ends like a sentence`);
    assert.ok(t.length < 200, `${code} stays short enough to read at a glance`);
    assert.equal(P.errText(code), t, "a bare code works too");
  }
  assert.equal(P.errText({ error: "something_new" }), generic);
  assert.equal(P.errText(undefined), generic);
  assert.equal(P.errText({}), generic);
});

test("errText: tries left, and the places where one code needs another sentence", () => {
  assert.match(P.errText({ error: "code_wrong", left: 4 }), /4 tries left\./);
  assert.match(P.errText({ error: "code_wrong", left: 1 }), /1 try left\./);
  assert.doesNotMatch(P.errText({ error: "code_wrong", left: 1 }), /tries/);
  assert.match(P.errText({ error: "code_wrong" }), /doesn't match/);
  assert.match(P.errText("slow_down", "login"), /wallet or Google/, "log in: the sentence points at the other ways in");
  assert.doesNotMatch(P.errText("slow_down"), /wallet/);
  assert.match(P.errText("too_many", "code"), /Send a new code/, "a code tried too often needs a new one");
  assert.match(P.errText("too_many"), /Wait an hour/, "too many codes sent: wait");
  assert.match(P.errText("location_unverified", "finish"), /Your login is saved/, "at the end the person is told the login is not lost");
  assert.equal(P.errText({ error: "has_wallet", wallet: "7Np4…T4K2" }), "Your account already has a wallet (7Np4…T4K2).", "the masked wallet when the server names it");
  assert.equal(P.errText("bad_email", "login"), P.errText("bad_email"), "an unknown context falls back to the plain sentence");
});

test("phones live inside the wallet app (owner decision F4): the words of the link, plain and short", () => {
  assert.equal(P.carryLead("Phantom"), "Phantom opens Vicinity and asks to connect this wallet to your account. Check the number, connect, and sign the free message. Then you stay in Phantom, logged in.");
  assert.equal(P.linkLead(), "Tap your wallet app. It opens Vicinity there: check the number, then sign once. You stay in the app, logged in.");
  assert.equal(P.carrySmall(false), "This link works once, for 10 minutes, only on this phone. Never send it to anyone.");
  assert.equal(P.carrySmall(true), "This link works once, only on this phone. Never send it to anyone.", "the 2-minute rule is the server's: the page renews a relay link by itself");
  assert.equal(P.carryHint("Phantom", "iphone"), "Phantom didn't open Vicinity? Press and hold “Open Phantom”, then choose “Open in Phantom”. No Phantom yet? Get it first.");
  assert.equal(P.carryHint("Phantom", "chrome"), "Phantom didn't open Vicinity? Make sure Phantom is installed, then tap “Open Phantom” again. Or tap “Didn't work?” below.");
  assert.equal(P.carryHint("Phantom", "other"), "Phantom didn't open Vicinity? Make sure Phantom is installed, or open this page in Chrome and try again.");
  // the wallet app DID open it, but on another connection: the pairing is the way (review finding ux-UX-2); a relay link opened in another
  // country or through a VPN is rarely the person: neutral words, a new link (audit SEC-2: never steered to the pairing, bound to nothing)
  assert.equal(P.carryRefused("Phantom", false), "Phantom opened your link, but it is on another internet connection (Wi-Fi and mobile data?), so the link can't be used there. Approve in Phantom instead: that way works on any connection.");
  assert.equal(P.carryRefused("Phantom", true), "Your link was opened in another country or through a VPN, so it can't be used there. If that wasn't you, someone else has your link: get a new one, and never send it to anyone.");
  assert.equal(P.carryPairQuiet("Phantom"), "Didn't work? Approve in Phantom and finish here instead");
  // the dead-link screen and its causes, in the wallet app
  assert.equal(P.errText("carry_expired", "app"), "This link is old. Go back to Safari or Chrome and tap “Connect wallet” again.");
  assert.equal(P.errText("carry_opened"), "For your safety it no longer works. Go back to Safari or Chrome and tap “Get a new link”. That stops the old one.");
  assert.match(P.errText({ error: "carry_network" }), /^Your wallet app and Safari are on different internet connections \(Wi-Fi and mobile data\?\)\./);
  assert.equal(P.carryNetwork("Phantom", true), "This link works only in the country where you made it, and not through a VPN. Travelling? Go back to Safari or Chrome and tap “Didn't work? Approve in Phantom and finish here instead”: that way works anywhere.");
  assert.equal(P.errText({ error: "carry_network", relay: true }), P.carryNetwork(null, true));
  assert.equal(P.ERR.carry_contested, "Someone else opened your link. It no longer works. Get a new link.");
  assert.equal(P.ERR.carry_ranout, "That link ran out. Get a new link.", "(review finding ux-UX-7: the 2-minute rule is the server's, never in the words)");
  // a wallet with no account inside the wallet app: for a RETURNING member, more than one wallet in the app is the usual reason; a
  // brand-new person never linked anything (review finding ux-COPY-1)
  assert.match(P.noAccountCopy(true, "Phantom", true).body, / More than one wallet in Phantom\? Switch to the one you linked, then try again\.$/);
  assert.doesNotMatch(P.noAccountCopy(true, "Phantom").body, /More than one wallet|you linked/);
  assert.doesNotMatch(P.noAccountCopy(false, "Phantom", true).body, /More than one wallet/);
  // the done screen: in the wallet app, on a phone's Safari (keep going in the app), on a computer
  assert.deepEqual({ ...P.linkedCopy("app", "7Np4…T4K2", "Phantom") }, { h: "Phantom connected ✓", sub: "Wallet 7Np4…T4K2 is on your account. Opening your dashboard…", go: "Open my dashboard", auto: true });
  // a phone's Safari: logged in there only when that app claimed this page's link code (review finding safety-F6: a pairing gives it none)
  assert.deepEqual({ ...P.linkedCopy("phone", "7Np4…T4K2", "Phantom", true) }, { h: "Phantom connected ✓", sub: "Wallet 7Np4…T4K2 is on your account. Keep going in Phantom: you're logged in there.", go: "Open Phantom", auto: false });
  assert.deepEqual({ ...P.linkedCopy("phone", "7Np4…T4K2", "Phantom") }, { h: "Phantom connected ✓", sub: "Wallet 7Np4…T4K2 is on your account. Keep going in Phantom: sign in there with one free signature.", go: "Open Phantom", auto: false });
  assert.deepEqual({ ...P.linkedCopy("here", "7Np4…T4K2", null) }, { h: "Wallet linked.", sub: "Wallet 7Np4…T4K2 is on your account. Taking you to your dashboard…", go: "Open my dashboard", auto: true });
  for (const t of [P.carryLead("Phantom"), P.linkLead(), P.carrySmall(true), P.carryHint("Phantom", "iphone"), P.carryHint("Phantom", "chrome")]) assert.ok(t.length < 200 && !/\bwalletProven|undefined/.test(t), t);
});

test("no sentence leaks a password, a code, an address or a stack trace, and none is an emoji or markup", () => {
  for (const [k, t] of Object.entries(P.ERR)) {
    assert.doesNotMatch(t, /<|>|\$\{|undefined|null|NaN/, k);
    assert.doesNotMatch(t, /\p{Extended_Pictographic}/u, `${k}: no emoji`);
  }
});

test("bounceFor: where a return from Google lands and what it says", () => {
  assert.deepEqual(plain(P.bounceFor("terms_required")), { tab: "new", text: P.ERR.terms_required });
  assert.deepEqual(plain(P.bounceFor("location_unverified")), { tab: "new", text: P.ERR["location_unverified:finish"] }, "the server cleared the location: step 1, the login is kept");
  assert.equal(P.bounceFor("no_account").tab, "new");
  assert.match(P.bounceFor("no_account").text, /start with Google or e-mail/);
  assert.deepEqual(plain(P.bounceFor("social_taken")), { tab: "new", stuck: true, text: P.ERR.social_taken }, "the stuck screen: log in instead, or another login");
  assert.equal(P.bounceFor("wallet_taken").tab, "login", "that wallet has an account: the Log in tab is the way in");
  for (const c of ["login_unavailable", "login_cancelled", "login_failed", "login_expired"]) {
    const b = P.bounceFor(c);
    assert.equal(b.tab, undefined, `${c} keeps whichever tab the person was on`);
    assert.equal(b.text, P.ERR[c]);
  }
  assert.equal(P.bounceFor("???").text, P.ERR.generic);
});

test("finishPlan: every refusal of POST /api/signup/finish has a way forward (and none of them is a wallet)", () => {
  const loc = P.finishPlan({ error: "location_unverified" });
  assert.equal(loc.go, "next", "back to wherever the server says (it cleared the location)");
  assert.match(loc.text, /Your login is saved/);
  for (const e of ["location_required", "account_required", "terms_required"]) assert.equal(P.finishPlan({ error: e }).go, "next", e);
  assert.deepEqual(plain(P.finishPlan({ error: "social_taken" }).actions), ["login", "ident"]);
  for (const e of ["wallet_required", "wallet_expired", "wallet_taken"]) assert.deepEqual(plain(P.finishPlan({ error: e }).actions), ["retry"], `${e}: no wallet action exists in the sign-up any more`);
  const again = P.finishPlan({ error: "changed_retry" });
  assert.equal(again.auto, true, "tried once more by itself");
  for (const e of ["slow_down", "signup_unavailable", "offline", "wrong_origin", "unheard_of", undefined]) {
    const p = P.finishPlan(e === undefined ? {} : { error: e });
    assert.equal(p.go, "stuck", String(e));
    assert.deepEqual(plain(p.actions), ["retry"], `${e}: the person can always try again`);
    assert.ok(p.text.length > 10);
  }
});

/* ---------- the page, the loader and the script agree ---------- */
const html = read("connect.html");
const connectJs = read("connect.js");
const locateJs = read("locate.js");

test("flag off: connect.html never loads signup.js, connect.js fetches it only when the server says v2", () => {
  const order = [...html.matchAll(/<script src="\/([a-z/]+)\.js"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["theme", "site", "vendor/qrcode", "wallets", "connect", "feedback"], "signup.js is not one of the page's scripts (feedback.js is the site-wide widget, on every page)");
  assert.doesNotMatch(html, /<script[^>]*signup/, "no script tag for it, whatever the comments say");
  assert.equal((connectJs.match(/loadScript\("\/signup\.js"\)/g) || []).length, 1, "fetched in one place only, the loader");
  assert.match(connectJs, /if \(me\.signupFlow === "v2"\) return startV2\(me, err\);/);
  const body = connectJs.slice(connectJs.indexOf("async function startV2"), connectJs.indexOf("/* ---------- start ---------- */"));
  assert.ok(body.includes('loadScript("/signup.js")'), "the loader lives in startV2, which only the v2 check calls");
  assert.equal((connectJs.match(/startV2\(/g) || []).length, 3, "defined once, called twice (a link code or a member without a wallet; the ordinary v2 page), both after /api/me said v2");
  assert.match(connectJs, /me\.signupFlow === "v2" && \(linkCode !== null \|\| \(me\.signedIn && me\.user && !me\.user\.wallet\)\)\) return startV2\(me, err\);/);
  assert.match(connectJs, /let signup = null;/, "the controller stays null for everyone else");
  for (const hook of ["signup.onShow(s)", "signup.signLabel()", "signup.walletProven(d)", "signup.handles(", "signup.linkMode()"]) assert.ok(connectJs.includes(hook), hook);
});

test("every element signup.js looks up exists on the page (a typo would break the sign-up for everyone)", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set();
  for (const m of src.matchAll(/["'`]#([A-Za-z][\w-]*)["'`]/g)) used.add(m[1]);
  for (const m of src.matchAll(/\(\s*["'`]#([A-Za-z][\w-]*)\b/g)) used.add(m[1]);
  assert.ok(used.size > 60, "the scan found the lookups");
  for (const id of used) if (!ids.has(id)) {
    // ids the script builds itself (the QR canvas is created before it is looked up)
    assert.ok(["su-ho-qr"].includes(id), `#${id} is used by signup.js but missing from connect.html`);
  }
  // ids built from a prefix: fieldErr("su-email") needs #su-email AND #su-email-error
  const fields = new Set([...src.matchAll(/fieldErr\(\s*"([\w-]+)"/g)].map((m) => m[1]));
  for (const m of src.matchAll(/clearErrs\(([^)]*)\)/g)) for (const x of m[1].matchAll(/"([\w-]+)"/g)) fields.add(x[1]);
  assert.ok(fields.size >= 8);
  for (const id of fields) assert.ok(ids.has(`${id}-error`), `#${id}-error exists`);
  for (const id of ["lg-email", "lg-pw", "lg", "rs-email", "rs-code", "rs-pw", "rs", "su-email", "su-pw", "su-terms", "su-code"]) assert.ok(ids.has(`${id}-error`), `#${id}-error`);
});

test("only the endpoints of the contract are used", () => {
  const contract = new Set([
    "/api/signup/start", "/api/signup/state", "/api/signup/location", "/api/signup/location/choice", "/api/signup/location/handoff", "/api/signup/location/handoff/claim",
    "/api/signup/terms", "/api/signup/account/reset", "/api/signup/email", "/api/signup/email/verify", "/api/signup/finish",
    "/api/me/wallet/carry", "/api/me/wallet/carry/info", "/api/me/wallet/carry/claim", "/api/me/wallet/carry/status?ref=", "/api/message?address=",
    "/api/auth/google/start?signup=1", "/api/auth/email/login", "/api/auth/password/reset/start", "/api/auth/password/reset",
    "/api/me?lite=1",
    "/api/auth/logout", // "Yes, log out Jo••• and link": the wallet app's browser leaves another account on an explicit tap (owner decision F4)
  ]);
  const used = new Set([...src.matchAll(/["'`](\/api\/[^"'`]+)["'`]/g)].map((m) => m[1]));
  assert.ok(used.size >= 14);
  for (const u of used) assert.ok(contract.has(u), `${u} is not in the contract`);
  assert.doesNotMatch(src, /\/api\/auth\/email\/(start|verify)/, "today's e-mail sign-in endpoints are not used by v2");
  assert.doesNotMatch(src, /\/api\/locate\/handoff/, "the page in the wallet app uses the /api/signup/location/handoff/* routes");
  assert.doesNotMatch(src, /\/api\/signup\/carry/, "the old sign-up carry routes are gone");
  assert.doesNotMatch(src, /\/api\/auth\/wallet|\/api\/pair/, "the wallet routes are connect.js's (the one rule of the server decides what a proof does)");
});

test("step 2: one primary action that agrees and continues with Google, the Terms box right under it, the e-mail way folded behind one line", () => {
  const step = html.slice(html.indexOf('data-state="su-account"'), html.indexOf('data-state="carry"'));
  const at = (s) => step.indexOf(s);
  assert.ok(at('id="su-google"') > 0 && at('id="su-google"') < at('id="su-terms"'), "the one tap comes first; it ticks the box");
  assert.match(step, /id="su-google"[^>]*>[^]*?Agree and continue with Google</);
  assert.doesNotMatch(step.match(/<button[^>]*id="su-google"[^>]*>/)[0], /\bdisabled\b/, "not disabled: the tap itself agrees");
  assert.match(step, /<input type="checkbox" id="su-terms" name="terms"[^>]*>(?![^]*checked)/, "unchecked until the tap (or the person) ticks it");
  assert.match(step, /id="su-terms-hint"[^>]*>Tick the box to continue\.</, "unticking by hand holds the primaries, with this hint");
  assert.match(step, /id="su-google-note"[^>]*>By continuing you agree to the Terms of Use\.</);
  assert.match(step, /One account per login keeps fake accounts out\. No wallet needed to join\./);
  assert.match(step, /<details class="su-alt" id="su-email-alt">\s*<summary id="su-email-summary">Use e-mail and a password instead<\/summary>\s*<form class="su-form" id="su-email-form"/);
  assert.match(step, /id="su-email-send">Agree and send me a code</);
  assert.match(step, /href="\/terms"/);
  assert.match(step, /id="su-terms-version"/);
  assert.doesNotMatch(step, /su-recap-wallet|Wallet verified/, "no wallet in the account step");
});

test("the step bar has two steps and a 'Wallet · later' chip that is not a step; no wallet screen belongs to the sign-up", () => {
  const bar = html.slice(html.indexOf('id="su-steps"'), html.indexOf('id="su-note"'));
  assert.deepEqual([...bar.matchAll(/data-step="([a-z]+)"/g)].map((m) => m[1]), ["location", "account"]);
  assert.match(bar, /<li class="su-later" id="su-later" title="Your wallet comes later, from your dashboard\. Free, one signature\."><span class="su-later__chip">Wallet · later<\/span>/);
  assert.doesNotMatch(html, /data-step="wallet"|data-state="su-wallet"/);
  assert.match(html, /<link rel="stylesheet" href="\/onboard\.css">/, "the new pieces are styled from public\/onboard.css (no inline style)");
  assert.doesNotMatch(src, /walletLead|PHONE_NOTE|showWallet|forceWallet|\/api\/signup\/carry/, "the wallet step's code is gone from the sign-up script");
});

test("password fields: the right autocomplete for password managers, length limits, and no password in a URL", () => {
  const attr = (id, a) => (html.match(new RegExp(`<input id="${id}"[^>]*\\b${a}="([^"]*)"`)) || [])[1];
  assert.equal(attr("su-pw", "autocomplete"), "new-password");
  assert.equal(attr("rs-pw", "autocomplete"), "new-password");
  assert.equal(attr("lg-pw", "autocomplete"), "current-password");
  assert.equal(attr("lg-email", "autocomplete"), "username");
  assert.equal(attr("su-email", "autocomplete"), "email");
  assert.equal(attr("su-code", "autocomplete"), "one-time-code");
  for (const id of ["su-pw", "rs-pw", "lg-pw"]) assert.equal(attr(id, "maxlength"), "128", id);
  for (const id of ["su-pw", "rs-pw"]) assert.equal(attr(id, "minlength"), "10", id);
  for (const form of html.match(/<form class="su-form"[^>]*>/g)) assert.match(form, /method="post"/, "a form that is submitted without script never puts a password in the address bar: " + form);
  assert.equal([...html.matchAll(/<form class="su-form"[^>]*>/g)].length, 5);
});

test("the Log in tab offers the reset flow with its exact words", () => {
  assert.match(html, /id="lg-forgot">Forgot or never set a password\? E-mail me a code<\/button>/);
  assert.match(html, /id="lg-google"/);
  assert.match(html, /id="lg-form"/);
});

test("the strict security policy holds: no inline script or style, no markup built from text, nothing logged", () => {
  assert.doesNotMatch(html, /\sstyle="/, "no style attributes");
  assert.doesNotMatch(html, /<style/);
  assert.doesNotMatch(html, /\son[a-z]+="/, "no inline handlers");
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\.style\.cssText|setAttribute\(["']style/);
  assert.doesNotMatch(src, /console\./, "never logs anything (e-mail addresses, codes and places must not reach a log)");
  assert.doesNotMatch(src, /localStorage\.setItem|document\.cookie/, "nothing about the person is kept in the browser");
  assert.doesNotMatch(src, /https?:\/\//, "no other website");
});

test("the Safari page says what a sign-up location check is for", () => {
  assert.match(locateJs, /signup: "check where you are for your new account"/);
});

test("the confirmed-location text tells people about the 7-day lock", () => {
  assert.match(src, /You can change it once after 7 days\./);
});
