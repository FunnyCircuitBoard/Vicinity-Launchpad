// The account step: Terms before anything, e-mail + password (with the code), Google, and the closed doors of v2
// (the old routes can only sign people in; an account is only ever made by the finish, which the account step runs itself the
// moment the login is verified: onboarding v3, no wallet step).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, advance, browser, loginBody, realClock, useClock, wallet } from "./helpers/world.js";
import { GOOD_PASSWORD, doEmail, doGoogle, doLocation, doTerms, fakeGoogle, finish, journey, linkDirect, member, one, outbox, rows, startSignup, stateOf } from "./helpers/signup.js";
import { slowDb } from "./helpers/slowdb.js";
import { _stats, verifyPassword } from "../src/password.js";
import { limitKey } from "../src/limits.js";
import { sendEmailCode } from "../src/auth.js";
import { TERMS_VERSION } from "../src/signup-core.js";
import { readFileSync } from "node:fs";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const count = async (table) => (await one(env.DB, `SELECT COUNT(*) AS n FROM ${table}`)).n;
const typed = (b, body) => b.send("/api/signup/email", { method: "POST", body, fetchImpl: box.fetch });
const verify = (b, body) => b.send("/api/signup/email/verify", { method: "POST", body, fetchImpl: box.fetch });
const ready = async (extra = {}) => { const b = browser(env, extra.net); await startSignup(b); await doLocation(b); await doTerms(b); return b; };

test("the Terms: only the current version counts, and it is recorded with the time of the first tick", async () => {
  const b = browser(env);
  await startSignup(b);
  for (const version of ["2020-01-01", "2026-10-02", "", null, 20261001, undefined, ["2026-10-01"]]) {
    const r = await b.send("/api/signup/terms", { method: "POST", body: { version } });
    assert.equal(r.status, 400, JSON.stringify(version));
    assert.equal((await r.json()).error, "bad_version");
  }
  assert.equal((await b.send("/api/signup/terms", { method: "POST", body: undefined })).status, 400);
  assert.equal((await stateOf(b)).terms.done, false);

  const first = await doTerms(b);
  assert.deepEqual(first.state.terms, { done: true, version: "2026-10-01" });
  const at1 = (await one(env.DB, "SELECT terms_at FROM signups")).terms_at;
  advance(5 * 60_000);
  await doTerms(b);
  assert.equal((await one(env.DB, "SELECT terms_at FROM signups")).terms_at, at1, "ticking again does not move the time");
});

test("no account step without the Terms: e-mail answers terms_required and Google is not even started", async () => {
  const b = browser(env);
  await startSignup(b);
  const r = await typed(b, { email: "no.terms@example.com", password: GOOD_PASSWORD });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "terms_required");
  assert.equal(box.sent.length, 0);
  for (const who of [b, browser(env)]) { // with a sign-up that has no Terms, and with no sign-up at all
    const g = await who.send("/api/auth/google/start?signup=1");
    assert.equal(g.status, 302);
    assert.equal(g.headers.get("location"), "/connect?error=terms_required");
    assert.deepEqual(g.headers.getSetCookie().filter((c) => c.startsWith("vo=")), [], "no OAuth cookie either");
  }
  await doTerms(b);
  const ok = await b.send("/api/auth/google/start?signup=1");
  assert.match(ok.headers.get("location"), /^https:\/\/accounts\.google\.com\//);
});

test("e-mail and password: the address is checked, and the mail service must be there", async () => {
  const b = await ready();
  for (const email of ["", "not-an-email", "a@b", "two words@example.com", null, 5, "a@b.co\u0000"]) {
    const r = await typed(b, { email, password: GOOD_PASSWORD });
    assert.equal(r.status, 400, JSON.stringify(email));
    assert.equal((await r.json()).error, "bad_email");
  }
  const noMail = V2({ RESEND_API_KEY: undefined });
  const c = browser(noMail);
  await startSignup(c);
  await doTerms(c);
  const r = await c.send("/api/signup/email", { method: "POST", body: { email: "ok@example.com", password: GOOD_PASSWORD }, fetchImpl: box.fetch });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "email_unavailable");
});

test("the password rules answer with a code only, never echo the password, and send and store nothing", async () => {
  const b = await ready();
  const email = "rules@example.com";
  const cases = {
    password_short: "short1!", password_long: "x".repeat(129) + "q", password_common: "password123",
    password_is_email: "rules@example.com", bad_password: undefined,
  };
  const derives = _stats.derives;
  for (const [code, password] of Object.entries(cases)) {
    const pw = code === "password_is_email" ? "rules@example.com" : password;
    const r = await typed(b, { email, password: pw });
    const text = await r.text();
    assert.equal(r.status, 400, code);
    assert.deepEqual(JSON.parse(text), { ok: false, error: code }, code);
    if (typeof pw === "string") assert.ok(!text.includes(pw), code + ": the password is not echoed");
  }
  assert.equal((await typed(b, { email, password: 12345678901234 })).status, 400, "a number is not a password");
  assert.equal(box.sent.length, 0, "nothing is mailed");
  assert.equal(_stats.derives, derives, "nothing is hashed for a refused password");
  assert.equal((await one(env.DB, "SELECT pending_email, pending_pw_hash FROM signups")).pending_email, null, "nothing is stored");
});

test("a known address gets exactly the same answer, the same hashing work and the same mail as a new one", async () => {
  await member(env, box, { via: "email", email: "known@example.com" });
  const a = await ready(), b = await ready();
  const measure = async (who, email) => {
    const d = _stats.derives, s = box.sent.length;
    const r = await typed(who, { email, password: GOOD_PASSWORD });
    return { status: r.status, body: await r.json(), derives: _stats.derives - d, sent: box.sent.length - s, kind: box.last().kind };
  };
  const known = await measure(a, "known@example.com");
  const unknown = await measure(b, "unknown@example.com");
  assert.deepEqual(known, unknown);
  assert.deepEqual({ status: known.status, body: known.body, derives: known.derives, sent: known.sent }, { status: 200, body: { ok: true }, derives: 1, sent: 1 });
  assert.deepEqual((await stateOf(a)).account, { done: false, pending: { email: "k***@example.com" } });
  assert.deepEqual((await stateOf(b)).account, { done: false, pending: { email: "u***@example.com" } });
});

test("a code for one address can never finish another: a wrong address is refused BEFORE the code is used up", async () => {
  const a = await ready(), other = await ready();
  await typed(a, { email: "alice@example.com", password: GOOD_PASSWORD });
  await typed(other, { email: "bob@example.com", password: GOOD_PASSWORD });
  const codeA = box.codeFor("alice@example.com"), codeB = box.codeFor("bob@example.com");

  // Bob's code and Bob's address in Alice's sign-up: refused as a mismatch, nothing consumed
  let r = await verify(a, { email: "bob@example.com", code: codeB });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "email_mismatch");
  // Bob's code with Alice's address (typed or implied) is just a wrong code
  assert.equal((await (await verify(a, { email: "alice@example.com", code: codeB })).json()).error, "code_wrong");
  assert.equal((await (await verify(a, { code: codeB })).json()).error, "code_wrong");
  // Alice's own code was not burned by any of that, Bob's is still his: each verified mailbox makes its account on the spot
  const madeA = await (await verify(a, { code: codeA })).json();
  assert.deepEqual([madeA.ok, madeA.isNew, madeA.next], [true, true, "/dashboard?welcome=1"], JSON.stringify(madeA));
  assert.equal((await (await verify(other, { code: codeB })).json()).ok, true);
  assert.deepEqual((await rows(env.DB, "SELECT provider, provider_id FROM users ORDER BY id")).map((u) => [u.provider, u.provider_id]), [["email", "alice@example.com"], ["email", "bob@example.com"]]);
  assert.equal((await a.get("/api/me?lite=1")).signedIn, true);
  // a sign-up with no address typed has nothing to verify
  const none = await ready();
  assert.equal((await (await verify(none, { code: "123456" })).json()).error, "email_mismatch");
});

test("the code is checked: six digits, counted wrong guesses, expiry, and only five guesses per code", async () => {
  const b = await ready();
  await typed(b, { email: "guess@example.com", password: GOOD_PASSWORD });
  const code = box.codeFor("guess@example.com");
  for (const bad of [undefined, "", "12345", "abc", 12]) assert.equal((await (await verify(b, { code: bad })).json()).error, "bad_code", JSON.stringify(bad));
  const wrong = code === "000000" ? "111111" : "000000";
  const w1 = await (await verify(b, { code: wrong })).json();
  assert.deepEqual(w1, { ok: false, error: "code_wrong", left: 4 });
  for (let i = 0; i < 3; i++) await verify(b, { code: wrong });
  const last = await (await verify(b, { code: wrong })).json();
  assert.equal(last.left, 0);
  const locked = await verify(b, { code });
  assert.equal(locked.status, 429, "five wrong guesses throw the code away, even the right one after that");
  assert.equal((await locked.json()).error, "too_many");

  const c = await ready();
  await typed(c, { email: "late@example.com", password: GOOD_PASSWORD });
  const late = box.codeFor("late@example.com");
  advance(11 * 60_000);
  assert.equal((await (await verify(c, { code: late })).json()).error, "code_expired");
});

test("two parallel requests with the right code: exactly one wins", async () => {
  env.DB = slowDb(env.DB);
  const b = await ready();
  await typed(b, { email: "race@example.com", password: GOOD_PASSWORD });
  const code = box.codeFor("race@example.com");
  const answers = await Promise.all(Array.from({ length: 6 }, () => verify(b, { code }).then((r) => r.json())));
  assert.equal(answers.filter((a) => a.ok).length, 1, JSON.stringify(answers));
  // the others find the code already used up (or, being a sixth guess at a live code, are turned away)
  assert.ok(answers.filter((a) => !a.ok).every((a) => ["code_expired", "too_many"].includes(a.error)), JSON.stringify(answers));
  assert.equal(await count("users"), 1, "the winner's mailbox made exactly one account");
  assert.equal((await b.get("/api/me?lite=1")).signedIn, true);
});

test("changing the e-mail before the code forgets the earlier address, and only the LAST password typed is the one the account gets", async () => {
  const b = await ready();
  await typed(b, { email: "first@example.com", password: "first password here" });
  let s = await stateOf(b);
  assert.deepEqual(s.account, { done: false, pending: { email: "f***@example.com" } });

  await typed(b, { email: "second@example.com", password: "second password here" });
  s = await stateOf(b);
  assert.deepEqual(s.account, { done: false, pending: { email: "s***@example.com" } }, "the earlier address is void");
  assert.equal(s.next, "account");
  // the first address' code no longer belongs to this sign-up
  assert.equal((await (await verify(b, { email: "first@example.com", code: box.codeFor("first@example.com") })).json()).error, "email_mismatch");

  // typing the same address again (after the minute) with a new password: the new one is kept, and the code makes the account
  advance(61_000);
  await typed(b, { email: "second@example.com", password: "third password here" });
  const made = await (await verify(b, { code: box.codeFor("second@example.com") })).json();
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.isNew, true);
  const u = await one(env.DB, "SELECT provider_id, password_hash, wallet FROM users");
  assert.equal(u.provider_id, "second@example.com");
  assert.equal(u.wallet, null, "no wallet: it is linked later, from the dashboard");
  assert.equal((await verifyPassword(env, u.password_hash, "third password here")).ok, true);
  assert.equal((await verifyPassword(env, u.password_hash, "second password here")).ok, false);
  assert.equal(await count("users"), 1);
});

test("the person can forget the account step (an e-mail typed, no code yet) and choose again (the Terms and the community stay)", async () => {
  const b = await ready();
  await doEmail(b, box, "undecided@example.com", { verify: false });
  assert.deepEqual((await stateOf(b)).account, { done: false, pending: { email: "u***@example.com" } });
  const r = await b.post("/api/signup/account/reset");
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.account, { done: false });
  assert.equal(r.state.terms.done, true);
  assert.equal(r.state.location.done, true);
  assert.deepEqual({ ...await one(env.DB, "SELECT provider, provider_id, identity_name, identity_at, pending_email, pending_pw_hash FROM signups") },
    { provider: null, provider_id: null, identity_name: null, identity_at: null, pending_email: null, pending_pw_hash: null });
  // Google instead: the callback records the login and makes the account in the same request
  const g = await doGoogle(b, "changed-my-mind");
  assert.equal(g.to, "/dashboard?welcome=1");
  assert.deepEqual({ ...await one(env.DB, "SELECT provider, provider_id, password_hash FROM users") }, { provider: "google", provider_id: "changed-my-mind", password_hash: null });
  assert.equal((await browser(env).send("/api/signup/account/reset", { method: "POST", body: {} })).status, 401, "needs a sign-up");
  // the typed e-mail's code is worth nothing to anyone now
  assert.equal(await count("signups"), 0);
});

test("an address that is already an account signs that person in, ignores the typed password, and ends the sign-up", async () => {
  const mem = await linkDirect(env, await member(env, box, { via: "email", email: "back@example.com" }));
  const hashBefore = (await one(env.DB, "SELECT password_hash FROM users")).password_hash;
  const b = await ready();
  const res = await typed(b, { email: "back@example.com", password: "a completely different one" });
  assert.deepEqual(await res.json(), { ok: true });
  const r = await verify(b, { email: "back@example.com", code: box.codeFor("back@example.com") });
  const answer = await r.json();
  assert.deepEqual(answer, { ok: true, existing: true, isNew: false, next: "/dashboard" });
  assert.equal((await one(env.DB, "SELECT password_hash FROM users")).password_hash, hashBefore, "the password of the account did not change");
  const me = await b.get("/api/me?lite=1");
  assert.equal(me.signedIn, true);
  assert.equal(me.user.wallet, mem.w.address);
  assert.equal(me.fresh, false, "an e-mail sign-in does not prove the wallet");
  assert.ok(!b.has("vsu"), "the sign-up cookie is cleared");
  assert.equal(await count("signups"), 0);
  assert.equal(await count("users"), 1);
});

test("Google: a known id signs in; a new id makes the account in the callback itself, with the first name, and lands on the welcome", async () => {
  await member(env, box, { via: "google", sub: "known-sub" });
  const users = await count("users");
  const b = await ready();
  const known = await doGoogle(b, "known-sub");
  assert.equal(known.to, "/dashboard");
  assert.equal(known.cb.headers.getSetCookie().some((c) => c.startsWith("vs=") && !/Max-Age=0/.test(c)), true);
  assert.equal(await count("users"), users);
  assert.equal(await count("signups"), 0, "the half-done sign-up that signed in as a member is gone");

  const c = await ready();
  const fresh = await doGoogle(c, "fresh-sub", { name: "Fiona" });
  assert.equal(fresh.to, "/dashboard?welcome=1");
  const names = fresh.cb.headers.getSetCookie().map((x) => x.split("=")[0]);
  assert.deepEqual(names, ["vo", "vs", "vsu"], "the OAuth cookie cleared, the 30-day session set, the sign-up cookie cleared");
  assert.match(fresh.cb.headers.getSetCookie()[1], /^vs=[A-Za-z0-9_-]{43}; .*Max-Age=2592000$/);
  assert.match(fresh.cb.headers.getSetCookie()[2], /^vsu=; .*Max-Age=0$/);
  assert.equal(await count("users"), users + 1, "the account exists the moment Google answered");
  assert.deepEqual({ ...await one(env.DB, "SELECT provider, provider_id, name, wallet, home_name FROM users WHERE provider_id = 'fresh-sub'") },
    { provider: "google", provider_id: "fresh-sub", name: "Fiona", wallet: null, home_name: "Utica" });
  assert.equal((await c.get("/api/me?lite=1")).signedIn, true);
  assert.equal(await count("signups"), 0);
});

test("S1: with v2 on the OLD e-mail route can only sign people in. An unknown address creates no account", async () => {
  const b = browser(env);
  await b.send("/api/auth/email/start", { method: "POST", body: { email: "sneaky@example.com" }, fetchImpl: box.fetch });
  const r = await b.send("/api/auth/email/verify", { method: "POST", body: { email: "sneaky@example.com", code: box.codeFor("sneaky@example.com") }, fetchImpl: box.fetch });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: "no_account" });
  assert.equal(await count("users"), 0, "no account without the Terms and the location");
  assert.equal((await b.get("/api/me?lite=1")).signedIn, false);
  // the same with a half-done sign-up open in the browser: the OLD route still makes nothing of it
  const c = await ready();
  await c.send("/api/auth/email/start", { method: "POST", body: { email: "halfway@example.com" }, fetchImpl: box.fetch });
  const r2 = await c.send("/api/auth/email/verify", { method: "POST", body: { email: "halfway@example.com", code: box.codeFor("halfway@example.com") }, fetchImpl: box.fetch });
  assert.equal((await r2.json()).error, "no_account", "no 'connect your wallet first' text in v2");
  assert.equal(await count("users"), 0);
  assert.equal((await stateOf(c)).account.done, false, "and the sign-up did not record the address either");
});

test("S1: the Google callback without the sign-up marker only signs in, and a forged marker needs a live sign-up with the Terms", async () => {
  const b = browser(env);
  const start = await b.send("/api/auth/google/start");
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cb = await b.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: fakeGoogle("sneaky-sub") });
  assert.equal(cb.headers.get("location"), "/connect?error=no_account");
  assert.equal(await count("users"), 0);
  assert.ok(!b.has("vsu"), "and no sign-up was made out of it");

  // forge the marker: no sign-up at all -> expired, nothing recorded
  const f = browser(env);
  const s2 = await f.send("/api/auth/google/start");
  const st2 = new URL(s2.headers.get("location")).searchParams.get("state");
  f.jar.set("vo", f.jar.get("vo") + ".s");
  const cb2 = await f.send(`/api/auth/google/callback?code=c&state=${st2}`, { fetchImpl: fakeGoogle("forged-sub") });
  assert.equal(cb2.headers.get("location"), "/connect?error=login_expired");
  assert.equal(await count("users"), 0);
  assert.equal(await count("signups"), 0, "and no sign-up was made out of it");

  // a sign-up without the Terms: the marker is not enough
  const g = browser(env);
  await startSignup(g);
  const s3 = await g.send("/api/auth/google/start");
  const st3 = new URL(s3.headers.get("location")).searchParams.get("state");
  g.jar.set("vo", g.jar.get("vo") + ".s");
  const cb3 = await g.send(`/api/auth/google/callback?code=c&state=${st3}`, { fetchImpl: fakeGoogle("forged-2") });
  assert.equal(cb3.headers.get("location"), "/connect?error=terms_required");
  assert.equal((await stateOf(g)).account.done, false);
  assert.equal(await count("users"), 0);
});

test("Google callback problems come back as /connect?error=: cancelled, bad state, a Google that fails", async () => {
  const b = await ready();
  const begin = async () => new URL((await b.send("/api/auth/google/start?signup=1")).headers.get("location")).searchParams.get("state");
  await begin();
  assert.equal((await b.send("/api/auth/google/callback?error=access_denied")).headers.get("location"), "/connect?error=login_cancelled");
  await begin();
  const wrong = await b.send("/api/auth/google/callback?code=c&state=nope", { fetchImpl: fakeGoogle("x") });
  assert.equal(wrong.headers.get("location"), "/connect?error=login_expired");
  const state = await begin();
  const broken = await b.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: async () => new Response("{}", { status: 500 }) });
  assert.equal(broken.headers.get("location"), "/connect?error=login_failed");
  assert.equal((await stateOf(b)).account.done, false);
});

test("a login that already has an account signs that person in (Google and e-mail alike), and a login whose account appears before the finish is social_taken", async () => {
  await member(env, box, { via: "google", sub: "owned-sub" });
  await member(env, box, { via: "email", email: "owned@example.com" });
  const b = browser(env);
  await startSignup(b);
  await doLocation(b);
  await doTerms(b);
  // the known logins sign in (linkIdentity finds the account): that is the "I already have an account" way through New here
  const g = await doGoogle(b, "owned-sub");
  assert.equal(g.to, "/dashboard");
  assert.equal(await count("users"), 2);
  assert.equal(await count("signups"), 0, "the sign-up is ended by the sign-in");
  const e = browser(env);
  await startSignup(e);
  await doLocation(e);
  await doTerms(e);
  await typed(e, { email: "owned@example.com", password: GOOD_PASSWORD });
  const known = await verify(e, { code: box.codeFor("owned@example.com") });
  assert.deepEqual(await known.json(), { ok: true, existing: true, isNew: false, next: "/dashboard" });
  assert.ok(known.headers.getSetCookie().some((c) => c.startsWith("vs=") && !/Max-Age=0/.test(c)), "signed in");
  assert.equal(await count("users"), 2);
  // social_taken proper: the login was recorded on the sign-up (its finish did not go through, say the network moved) and the
  // account for that identity appears before the finish is tried again: the transaction refuses, nothing is created
  const c = browser(env);
  await startSignup(c);
  await doLocation(c);
  await doTerms(c);
  await env.DB.prepare("UPDATE signups SET provider = 'email', provider_id = 'racer@example.com', identity_name = 'Racer', identity_at = loc_at WHERE provider IS NULL").run();
  assert.equal((await stateOf(c)).account.done, true);
  await env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (NULL, 'email', 'racer@example.com', 'Racer9', ?)").bind(new Date(Date.now()).toISOString()).run();
  const fin = await c.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([fin.status, (await fin.json()).error], [409, "social_taken"]);
  assert.equal(await count("users"), 3, "nothing was created for the racer");
  assert.ok(c.has("vsu"), "the sign-up stays, so the page can offer another login");
  assert.equal((await c.get("/api/me?lite=1")).signedIn, false);
  // another login on the same sign-up goes through (the account step records over the taken one)
  await typed(c, { email: "racer2@example.com", password: GOOD_PASSWORD });
  const r = await verify(c, { code: box.codeFor("racer2@example.com") });
  const body = await r.json();
  assert.deepEqual([r.status, body.ok, body.isNew, body.next], [200, true, true, "/dashboard?welcome=1"], JSON.stringify(body));
  assert.equal(await count("users"), 4);
});

test("sending the code is limited: once a minute per address, five a sign-up an hour, and a failed mail gives the slot back", async () => {
  const b = await ready();
  assert.equal((await typed(b, { email: "limit@example.com", password: GOOD_PASSWORD })).status, 200);
  const soon = await typed(b, { email: "limit@example.com", password: GOOD_PASSWORD });
  assert.equal(soon.status, 429);
  assert.equal((await soon.json()).error, "too_soon");
  assert.equal(box.sent.length, 1);

  // five tries an hour for one sign-up (counted even when refused)
  for (let i = 0; i < 3; i++) await typed(b, { email: `more${i}@example.com`, password: GOOD_PASSWORD });
  const sixth = await typed(b, { email: "more9@example.com", password: GOOD_PASSWORD });
  assert.equal(sixth.status, 429);
  assert.equal((await sixth.json()).error, "slow_down");

  // the mail service is down: 503, and the very next try (once it is back) is not blocked by the minute rule
  const c = await ready();
  box.failing = true;
  const down = await typed(c, { email: "flaky@example.com", password: GOOD_PASSWORD });
  assert.equal(down.status, 503);
  assert.equal((await down.json()).error, "email_unavailable");
  box.failing = false;
  assert.equal((await typed(c, { email: "flaky@example.com", password: GOOD_PASSWORD })).status, 200);

  // 20 sends in 24 hours per address, across sign-ups
  const d = await ready();
  await env.DB.prepare("INSERT INTO auth_limits (key, n, window_start) VALUES (?, 20, ?)").bind(await limitKey(env, "mail", "capped@example.com"), new Date(Date.now()).toISOString()).run();
  const capped = await typed(d, { email: "capped@example.com", password: GOOD_PASSWORD });
  assert.equal(capped.status, 429);
  assert.equal((await capped.json()).error, "slow_down");
});

test("verifying is limited too: 20 tries an hour per sign-up", async () => {
  const b = await ready();
  await typed(b, { email: "tries@example.com", password: GOOD_PASSWORD });
  let last;
  for (let i = 0; i < 21; i++) last = await verify(b, { code: "000000" });
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error, "slow_down");
});

test("every account step needs a live sign-up, and refuses a signed-in person", async () => {
  const none = browser(env);
  for (const [path, body] of [["/api/signup/terms", { version: "2026-10-01" }], ["/api/signup/email", { email: "a@b.co", password: GOOD_PASSWORD }],
    ["/api/signup/email/verify", { code: "123456" }], ["/api/signup/account/reset", {}], ["/api/signup/finish", {}]]) {
    const r = await none.send(path, { method: "POST", body });
    assert.equal(r.status, 401, path);
    assert.equal((await r.json()).error, "no_signup", path);
  }
  const mem = await member(env, box, { via: "google" });
  for (const [path, body] of [["/api/signup/terms", { version: "2026-10-01" }], ["/api/signup/email", { email: "a@b.co", password: GOOD_PASSWORD }],
    ["/api/signup/email/verify", { code: "123456" }], ["/api/signup/account/reset", {}], ["/api/signup/finish", {}]]) {
    const r = await mem.b.send(path, { method: "POST", body });
    assert.equal(r.status, 409, path);
    assert.equal((await r.json()).error, "already_signed_in", path);
  }
});

test("the Terms version the server asks for is the version printed on the Terms page", () => {
  const page = readFileSync(new URL("../scripts/pages/src/terms.html", import.meta.url), "utf8");
  assert.equal(TERMS_VERSION, "2026-10-01");
  assert.ok(page.includes(`Version ${TERMS_VERSION}`), "terms.html must show the version people accept (change both together)");
});

test("sendEmailCode for the password routes: noSend does the same database work without mailing, waitUntil mails in the background and still gives the slot back", async () => {
  await member(env, box, { via: "google" }); // makes the tables
  const row = (email) => one(env.DB, "SELECT send_count, last_sent_at, expires_at FROM email_codes WHERE email = ?", email);

  const quiet = await sendEmailCode(env, "unknown@example.com", { fetchImpl: box.fetch, noSend: true, kind: "reset" });
  assert.deepEqual(quiet, { ok: true });
  assert.equal(box.sent.length, 0, "nothing mailed");
  assert.equal((await row("unknown@example.com")).send_count, 1, "but the slot is claimed like a real send");
  assert.equal((await sendEmailCode(env, "unknown@example.com", { fetchImpl: box.fetch, noSend: true })).error, "too_soon", "so the minute rule is the same too");

  const waits = [];
  const real = await sendEmailCode(env, "known@example.com", { fetchImpl: box.fetch, waitUntil: (p) => waits.push(p), kind: "reset" });
  assert.deepEqual(real, { ok: true });
  await Promise.all(waits);
  assert.equal(box.sent.length, 1);
  assert.equal(box.last().kind, "reset");
  assert.equal(box.last().to, "known@example.com");

  box.failing = true;
  const later = [];
  const failed = await sendEmailCode(env, "flaky@example.com", { fetchImpl: box.fetch, waitUntil: (p) => later.push(p), kind: "reset" });
  assert.deepEqual(failed, { ok: true }, "the answer does not wait for the mail server");
  await Promise.all(later);
  assert.equal((await row("flaky@example.com")).send_count, 0, "the mail never left: the slot was given back");
  box.failing = false;
  assert.deepEqual(await sendEmailCode(env, "flaky@example.com", { fetchImpl: box.fetch }), { ok: true }, "and the person can ask again at once");
});

test("if the sign-up tables cannot be checked when Google comes back, the person lands on a plain 'unavailable' message and nothing is recorded", async () => {
  const b = await ready();
  const begin = new URL((await b.send("/api/auth/google/start?signup=1")).headers.get("location")).searchParams.get("state");
  const real = env.DB;
  env.DB = { ...real, prepare: (sql) => {
    if (!/schema_migrations WHERE id/.test(sql)) return real.prepare(sql);
    const failing = { sql, bind: () => failing, first: async () => { throw new Error("D1_ERROR: disk I/O error"); } };
    return failing;
  } };
  const cb = await b.send(`/api/auth/google/callback?code=c&state=${begin}`, { fetchImpl: fakeGoogle("never-recorded") });
  env.DB = real;
  assert.equal(cb.headers.get("location"), "/connect?error=login_unavailable");
  assert.equal((await stateOf(b)).account.done, false);
  assert.equal(await count("users"), 0);
});
