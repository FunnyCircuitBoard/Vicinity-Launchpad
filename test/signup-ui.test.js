// Sign-up v2, browser side: the pure helpers of public/signup.js (run in node, no DOM) and checks that the page
// markup, the loader in connect.js and the script agree with each other and with the backend contract.
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

const empty = () => ({ terms: { done: false, version: "2026-10-01" }, location: { done: false }, account: { done: false }, wallet: { done: false }, next: "location" });
const state = (o = {}) => ({ ...empty(), ...o });

test("viewFor: the steps follow the server's `next`, finished steps are ticked", () => {
  let v = P.viewFor(empty());
  assert.equal(v.view, "location");
  assert.deepEqual(plain(v.steps.map((s) => [s.key, s.done, s.active])), [["location", false, true], ["account", false, false], ["wallet", false, false]]);
  v = P.viewFor(state({ location: { done: true }, next: "account" }));
  assert.equal(v.view, "account");
  assert.deepEqual(plain(v.steps.map((s) => s.done)), [true, false, false]);
  v = P.viewFor(state({ location: { done: true }, account: { done: true }, next: "wallet" }));
  assert.equal(v.view, "wallet");
  v = P.viewFor(state({ location: { done: true }, account: { done: true }, wallet: { done: true }, next: "finish" }));
  assert.equal(v.view, "finish");
  assert.ok(v.steps.every((s) => s.done && !s.active && !s.editable), "all ticked, none open for change while the account is being created");
  assert.equal(P.viewFor({ ...empty(), next: "nonsense" }).view, "location", "an unknown step falls back to the first one");
});

test("viewFor: a step can be revisited only until the NEXT one is done", () => {
  const atAccount = state({ location: { done: true }, next: "account" });
  assert.equal(P.viewFor(atAccount, "location").view, "location", "location is editable while the account is not done");
  assert.equal(P.viewFor(atAccount, "location").steps[0].active, true);
  assert.equal(P.viewFor(atAccount).steps[0].editable, true);
  const atWallet = state({ location: { done: true }, account: { done: true }, next: "wallet" });
  assert.equal(P.viewFor(atWallet, "location").view, "wallet", "location is locked once the account is done");
  assert.equal(P.viewFor(atWallet, "account").view, "account", "the account can still be changed before the wallet");
  assert.deepEqual(plain(P.viewFor(atWallet).steps.map((s) => s.editable)), [false, true, false]);
  assert.equal(P.viewFor(atWallet, "wallet").view, "wallet", "the wallet step is never held (it is just the current one)");
  assert.equal(P.viewFor(atAccount, "wallet").view, "account", "a hold on a step that is not editable is ignored");
});

test("viewFor: an expired wallet check shows the wallet step again although the server still counts it", () => {
  const all = state({ location: { done: true }, account: { done: true }, wallet: { done: true }, next: "finish" });
  const v = P.viewFor(all, null, "wallet");
  assert.equal(v.view, "wallet");
  assert.deepEqual(plain(v.steps.map((s) => [s.done, s.active])), [[true, false], [true, false], [false, true]]);
  assert.equal(P.viewFor(empty(), null, "wallet").view, "location", "an earlier step that is missing still comes first");
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

test("hasProgress: only what lives in the sign-up row counts (the wallet is its own session)", () => {
  assert.equal(P.hasProgress(empty()), false);
  assert.equal(P.hasProgress(null), false);
  assert.equal(P.hasProgress(state({ wallet: { done: true } })), false);
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
  assert.equal(P.safeNext("/dashboard"), "/dashboard");
  for (const bad of ["//evil.example/x", "https://evil.example", "javascript:alert(1)", "/dashboard?welcome=2", "/connect", "", null, undefined, "/dashboard/../x"]) assert.equal(P.safeNext(bad), "/dashboard", String(bad));
});

test("validEmail: the same loose shape check as the server", () => {
  for (const ok of ["a@b.co", "ada.lovelace@example.com", "x+tag@sub.example.org"]) assert.equal(P.validEmail(ok), true, ok);
  for (const bad of ["", "nope", "a@b", "a@b.c", "a b@c.de", "a@b.co<script>", "a@@b.co", "@b.co", "a@.co"]) assert.equal(P.validEmail(bad), false, bad);
});

// every code the backend can answer with (PLAN.md section 3.4) has its own plain sentence
const CONTRACT_CODES = [
  "location_required", "location_unverified", "cities_unavailable", "bad_choice", "no_choices", "slow_down",
  "no_signup", "already_signed_in", "already_finished", "terms_required", "bad_version", "not_enabled", "signup_unavailable", "wrong_origin",
  "bad_email", "bad_password", "password_short", "password_long", "password_common", "password_is_email", "email_unavailable", "too_soon", "too_many",
  "bad_code", "code_wrong", "code_expired", "email_mismatch", "no_account", "social_taken", "wallet_taken",
  "wallet_required", "wallet_expired", "account_required", "changed_retry",
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
  assert.match(P.errText("location_unverified", "finish"), /Everything else is saved/, "at the end the person is told nothing else is lost");
  assert.equal(P.errText("bad_email", "login"), P.errText("bad_email"), "an unknown context falls back to the plain sentence");
});

test("no sentence leaks a password, a code, an address or a stack trace, and none is an emoji or markup", () => {
  for (const [k, t] of Object.entries(P.ERR)) {
    assert.doesNotMatch(t, /<|>|\$\{|undefined|null|NaN/, k);
    assert.doesNotMatch(t, /\p{Extended_Pictographic}/u, `${k}: no emoji`);
  }
});

test("bounceFor: where a return from Google lands and what it says", () => {
  assert.deepEqual(plain(P.bounceFor("terms_required")), { tab: "new", hold: "account", text: P.ERR.terms_required });
  assert.equal(P.bounceFor("no_account").tab, "new");
  assert.match(P.bounceFor("no_account").text, /New here/);
  assert.equal(P.bounceFor("social_taken").tab, "new");
  assert.equal(P.bounceFor("wallet_taken").tab, "login", "that wallet has an account: the Log in tab is the way in");
  for (const c of ["login_unavailable", "login_cancelled", "login_failed", "login_expired"]) {
    const b = P.bounceFor(c);
    assert.equal(b.tab, undefined, `${c} keeps whichever tab the person was on`);
    assert.equal(b.text, P.ERR[c]);
  }
  assert.equal(P.bounceFor("???").text, P.ERR.generic);
});

test("finishPlan: every refusal of POST /api/signup/finish has a way forward", () => {
  assert.deepEqual(plain(P.finishPlan({ error: "wallet_expired" })), { go: "wallet", text: P.ERR.wallet_expired });
  assert.equal(P.finishPlan({ error: "wallet_required" }).go, "wallet");
  const loc = P.finishPlan({ error: "location_unverified" });
  assert.equal(loc.go, "next", "back to wherever the server says (it cleared the location)");
  assert.match(loc.text, /Everything else is saved/);
  for (const e of ["location_required", "account_required", "terms_required"]) assert.equal(P.finishPlan({ error: e }).go, "next", e);
  assert.deepEqual(plain(P.finishPlan({ error: "wallet_taken" }).actions), ["login", "wallet"]);
  assert.deepEqual(plain(P.finishPlan({ error: "social_taken" }).actions), ["ident", "login"]);
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
  assert.deepEqual(order, ["theme", "site", "vendor/qrcode", "wallets", "connect"], "signup.js is not one of the page's scripts");
  assert.doesNotMatch(html, /<script[^>]*signup/, "no script tag for it, whatever the comments say");
  assert.equal((connectJs.match(/loadScript\("\/signup\.js"\)/g) || []).length, 1, "fetched in one place only, the loader");
  assert.match(connectJs, /if \(me\.signupFlow === "v2"\) return startV2\(me, err\);/);
  const body = connectJs.slice(connectJs.indexOf("async function startV2"), connectJs.indexOf("/* ---------- start ---------- */"));
  assert.ok(body.includes('loadScript("/signup.js")'), "the loader lives in startV2, which only the v2 check calls");
  assert.equal((connectJs.match(/startV2\(/g) || []).length, 2, "defined once, called once");
  assert.match(connectJs, /let signup = null;/, "the controller stays null for everyone else");
  for (const hook of ["signup.onShow(s)", "signup.signLabel()", "signup.walletProven(d)"]) assert.ok(connectJs.includes(hook), hook);
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

test("only the endpoints of the contract are used (PLAN.md 3.3)", () => {
  const contract = new Set([
    "/api/signup/start", "/api/signup/state", "/api/signup/location", "/api/signup/location/choice", "/api/signup/location/handoff", "/api/signup/location/handoff/claim",
    "/api/signup/terms", "/api/signup/account/reset", "/api/signup/email", "/api/signup/email/verify", "/api/signup/finish",
    "/api/auth/google/start?signup=1", "/api/auth/email/login", "/api/auth/password/reset/start", "/api/auth/password/reset",
    "/api/auth/logout", "/api/me?lite=1",
  ]);
  const used = new Set([...src.matchAll(/["'`](\/api\/[^"'`]+)["'`]/g)].map((m) => m[1]));
  assert.ok(used.size >= 14);
  for (const u of used) assert.ok(contract.has(u), `${u} is not in the contract`);
  assert.doesNotMatch(src, /\/api\/auth\/email\/(start|verify)/, "today's e-mail sign-in endpoints are not used by v2");
  assert.doesNotMatch(src, /\/api\/locate\/handoff/, "the page in the wallet app uses the /api/signup/location/handoff/* routes");
});

test("the terms box comes first in step 2, and nothing continues without it", () => {
  const step = html.slice(html.indexOf('data-state="su-account"'));
  const at = (s) => step.indexOf(s);
  assert.ok(at('id="su-terms"') > 0);
  assert.ok(at('id="su-terms"') < at('id="su-google"'), "the box before Google");
  assert.ok(at('id="su-terms"') < at('id="su-email-form"'), "the box before the e-mail form");
  assert.match(step, /<input type="checkbox" id="su-terms" name="terms"[^>]*>(?![^]*checked)/, "unchecked by default");
  assert.match(step, /id="su-google"[^>]*\bdisabled\b/);
  assert.match(step, /id="su-email-send"[^>]*\bdisabled\b/);
  assert.match(step, /href="\/terms"/);
  assert.match(step, /id="su-terms-version"/);
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
