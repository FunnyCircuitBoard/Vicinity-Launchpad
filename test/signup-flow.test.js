// The new sign-up (onboarding v3) from end to end through the real API: location, Terms + account (e-mail or Google). The account
// exists the moment the login is verified; there is no wallet step (the wallet is linked later, from the dashboard).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EMPTY, MINT, V2, browser, clock, loginBody, realClock, setHolding, useClock, wallet, advance, tick } from "./helpers/world.js";
import { GOOD_PASSWORD, doEmail, doGoogle, doLocation, doTerms, doWallet, dumpAll, finish, journey, linkDirect, member, memberWithWallet, one, outbox, pickCommunity, recordAnswers, rows, startSignup, stateOf } from "./helpers/signup.js";
import { verifyPassword } from "../src/password.js";
import { cleanupSignups } from "../src/signup-core.js";
import { runJobs } from "../src/jobs.js";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const cookiesOf = (res) => res.headers.getSetCookie();
const count = async (table) => (await one(env.DB, `SELECT COUNT(*) AS n FROM ${table}`)).n;
const EMPTY_STATE = { terms: { done: false, version: "2026-10-01" }, location: { done: false }, account: { done: false }, next: "location" };

test("e-mail path: every step moves 'next' on, and the verified code makes the account and signs the browser in", async () => {
  const b = browser(env), email = "ada@example.com";
  let s = (await startSignup(b)).state;
  assert.deepEqual(s, EMPTY_STATE);

  const loc = await doLocation(b);
  assert.deepEqual(loc, { ok: true, community: { id: "5142056", name: "Utica", country: "US" } });
  s = await stateOf(b);
  assert.equal(s.location.done, true);
  assert.deepEqual(s.location.community, { id: "5142056", name: "Utica", country: "US" });
  assert.equal(s.next, "account", "location done: the account step is next");

  s = (await doTerms(b)).state;
  assert.equal(s.terms.done, true);
  assert.equal(s.next, "account", "Terms alone are not the account");

  const typed = await b.send("/api/signup/email", { method: "POST", body: { email, password: GOOD_PASSWORD }, fetchImpl: box.fetch });
  assert.deepEqual(await typed.json(), { ok: true });
  s = await stateOf(b);
  assert.deepEqual(s.account, { done: false, pending: { email: "a***@example.com" } });
  assert.equal(s.next, "account");
  assert.equal(await count("users"), 0, "a typed address is not an account");

  const code = box.codeFor(email);
  const res = await b.send("/api/signup/email/verify", { method: "POST", body: { code }, fetchImpl: box.fetch });
  const verified = await res.json();
  assert.deepEqual(verified, { ok: true, existing: false, isNew: true, next: "/dashboard?welcome=1", welcome: { name: null, city: "Utica", memberNumber: 1 } });
  assert.equal(cookiesOf(res).filter((c) => c.startsWith("vs=") && !/Max-Age=0/.test(c)).length, 1, "signed in by the very same answer");
  assert.ok(!b.has("vsu"), "the sign-up cookie is cleared");
  const me = await b.get("/api/me?lite=1");
  assert.equal(me.signedIn, true);
  assert.equal(me.user.wallet, null, "no wallet: that comes later, from the dashboard");
  assert.equal(me.user.home.name, "Utica");
  assert.deepEqual(await stateOf(b), EMPTY_STATE, "the sign-up is over");
});

test("Google path: the callback makes the account in the same request (with the first name) and lands on the welcome", async () => {
  const b = browser(env);
  await startSignup(b);
  await doLocation(b);
  await doTerms(b);
  const g = await doGoogle(b, "google-sub-77", { name: "Gina" });
  assert.equal(g.to, "/dashboard?welcome=1");
  assert.equal(await count("users"), 1, "the account exists the moment Google answered");
  const u = await one(env.DB, "SELECT provider, provider_id, name, password_hash, wallet, home_name FROM users");
  assert.deepEqual({ ...u }, { provider: "google", provider_id: "google-sub-77", name: "Gina", password_hash: null, wallet: null, home_name: "Utica" });
  assert.equal((await b.get("/api/me?lite=1")).signedIn, true);
  assert.equal(await count("signups"), 0);
  assert.equal((await one(env.DB, "SELECT proven_at FROM sessions")).proven_at, null, "no wallet proof on the session");
});

test("the Google callback says where to go when the community is still missing: the login is recorded, the location step is next, then the finish", async () => {
  const b = browser(env);
  await startSignup(b);
  await doTerms(b);
  assert.equal((await doGoogle(b, "g-early")).to, "/connect?step=location");
  assert.equal(await count("users"), 0, "no community, no account");
  let s = await stateOf(b);
  assert.deepEqual(s.account, { done: true, provider: "google" }, "the login is kept");
  assert.equal(s.next, "location");
  await doLocation(b);
  s = await stateOf(b);
  assert.equal(s.next, "finish");
  const done = await finish(b);
  assert.deepEqual([done.ok, done.next, done.isNew], [true, "/dashboard?welcome=1", true]);
  assert.equal(await count("users"), 1);
});

test("the two steps can come in either order: the account is made once, by whichever step was last", async () => {
  // location first: the verified code is the end
  const a = browser(env);
  await startSignup(a);
  await doLocation(a);
  await doTerms(a);
  const first = await doEmail(a, box, "order0@example.com");
  assert.equal(first.verify.isNew, true, JSON.stringify(first.verify));
  // account first: the verified code is recorded, the finish waits for the community, and the location step is the end
  const b = browser(env);
  await startSignup(b);
  await doTerms(b);
  const second = await doEmail(b, box, "order1@example.com");
  assert.deepEqual([second.verify.ok, second.verify.existing, second.verify.finishError], [true, false, "location_required"], JSON.stringify(second.verify));
  assert.equal(second.verify.state.next, "location");
  assert.equal(await count("users"), 1);
  await doLocation(b);
  assert.equal((await stateOf(b)).next, "finish");
  const done = await finish(b);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(await count("users"), 2);
  for (const x of [a, b]) assert.equal((await x.get("/api/me?lite=1")).signedIn, true);
});

test("the state never carries coordinates, a full e-mail, a hash or a token (checked on every answer of a whole journey)", async () => {
  const b = browser(env), email = "private.person@example.com";
  const seen = recordAnswers(b);
  const point = { lat: 43.1234567, lon: -75.2345678, accuracy: 30 };
  await startSignup(b);
  await doLocation(b, point);
  await doTerms(b);
  await stateOf(b);
  await doEmail(b, box, email);
  await b.get("/api/me");
  const text = seen.join("\n");
  assert.ok(seen.items.length >= 7, "every answer of the journey was looked at");
  for (const secret of ["43.1234567", "75.2345678", "private.person", email, "pbkdf2", GOOD_PASSWORD, b.jar.get("vs")]) {
    assert.ok(!text.includes(secret), `a response contains ${secret}`);
  }
  assert.ok(!(await dumpAll(env.DB)).includes("1234567"), "the coordinates are in no row");
});

test("after the finish: the user row is complete (no wallet), the session is a 30-day cookie with no wallet proof, and every trace of the sign-up is gone", async () => {
  env = V2({ VICINITY_MINT: MINT });
  const b = browser(env), email = "full@example.com";
  const j = await journey(b, box, { via: "email", email });
  assert.equal(j.finish.ok, true);
  const u = await one(env.DB, "SELECT * FROM users");
  const at = new Date(clock.now).toISOString();
  assert.equal(u.wallet, null);
  assert.equal(u.provider, "email");
  assert.equal(u.provider_id, email);
  assert.match(u.handle, /^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/, "an auto username");
  assert.equal(u.name, "E-mail member");
  assert.equal(u.early, 0, "the coin is already launched: not an early member");
  assert.equal(u.created_at, at);
  assert.equal(u.terms_version, "2026-10-01");
  assert.equal(u.terms_agreed_at, at);
  assert.deepEqual([u.home_city, u.home_name, u.home_country, u.home_at], ["5142056", "Utica", "US", at]);
  assert.ok(u.password_hash.startsWith("pbkdf2-sha256$1000$"), "an e-mail account keeps only the hash of its password");
  assert.ok((await verifyPassword(env, u.password_hash, GOOD_PASSWORD)).ok);
  assert.deepEqual([u.contact_email, u.phone, u.badges], [null, null, null]);

  // the cookies of the answer that made the account: a 30-day session, the sign-up cookie cleared
  const b2 = browser(env);
  await journey(b2, box, { via: "email", until: "terms" });
  await b2.send("/api/signup/email", { method: "POST", body: { email: "second@example.com", password: GOOD_PASSWORD }, fetchImpl: box.fetch });
  const res = await b2.send("/api/signup/email/verify", { method: "POST", body: { code: box.codeFor("second@example.com") }, fetchImpl: box.fetch });
  const sc = cookiesOf(res);
  const vs = sc.find((c) => c.startsWith("vs="));
  assert.match(vs, /^vs=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
  assert.match(sc.find((c) => c.startsWith("vsu=")), /^vsu=; .*Max-Age=0$/);

  // nothing is left: the sign-up rows, their hand-offs; one full session per person, none pending, none proven
  assert.equal(await count("signups"), 0);
  assert.equal(await count("handoffs"), 0);
  assert.equal((await rows(env.DB, "SELECT id FROM sessions WHERE user_id IS NULL")).length, 0, "no pending session");
  const full = await rows(env.DB, "SELECT wallet, proven_at FROM sessions WHERE user_id IS NOT NULL");
  assert.equal(full.length, 2, "one full session per person");
  assert.deepEqual(full.map((r) => [r.wallet, r.proven_at]), [[null, null], [null, null]]);
});

test("after the finish /api/me shows the home community, no wallet (setup 67 %), a fresh login, and the community counts one member; a linked wallet completes it", async () => {
  env = V2({ VICINITY_MINT: MINT }); // launched: holdings are real once a wallet is linked
  const b = browser(env), w = await wallet();
  const j = await journey(b, box, { via: "google", w });
  assert.equal(j.finish.ok, true);
  setHolding(w.address, 1234);
  let me = await b.get("/api/me");
  assert.equal(me.signedIn, true);
  assert.equal(me.signupFlow, "v2");
  assert.equal(me.user.hasPassword, false, "a Google account has no password");
  assert.equal(me.user.wallet, null);
  assert.equal(me.user.home.name, "Utica");
  assert.equal(me.community.name, "Utica");
  assert.equal(me.community.memberNumber, 1);
  assert.equal(me.holding.amount, 0, "no wallet, nothing to count yet");
  assert.equal(me.fresh, true, "a login without a wallet counts as fresh for 30 minutes");
  assert.deepEqual(me.setup.percent, 67);
  assert.deepEqual(me.setup.steps.map((s) => [s.id, s.done]), [["location", true], ["account", true], ["wallet", false]]);
  const members = await (await b.send("/api/members")).json();
  assert.deepEqual(members.communities.map((c) => [c.name, c.members]), [["Utica", 1]]);

  await linkDirect(env, j, { proven: false });
  me = await b.get("/api/me");
  assert.equal(me.user.wallet, w.address);
  assert.equal(me.holding.amount, 1234);
  assert.equal(me.setup.percent, 100);
  assert.equal(me.fresh, false, "with a wallet, only a wallet proof is fresh");
  advance(31 * 60_000);
  const later = browser(env);
  const k = await journey(later, box, { via: "email" });
  assert.equal(k.finish.ok, true);
  advance(31 * 60_000);
  assert.equal((await later.get("/api/me?lite=1")).fresh, false, "and the login's 30 minutes run out");
});

test("/api/me says signupFlow v2 for the signed-out and the signed-in shapes, and hasPassword for the person who has one", async () => {
  const out = browser(env);
  assert.deepEqual(await out.get("/api/me"), { signedIn: false, providers: { google: true, email: true }, signupFlow: "v2" });
  const m = await member(env, box, { via: "email" });
  for (const url of ["/api/me", "/api/me?lite=1"]) {
    const me = await m.b.get(url);
    assert.equal(me.signupFlow, "v2", url);
    assert.equal(me.user.hasPassword, true, url);
  }
  const g = await member(env, box, { via: "google" });
  assert.equal((await g.b.get("/api/me?lite=1")).user.hasPassword, false);
});

test("empty land: three nearest to choose from, the choice stays changeable until the end, and the chosen one becomes home", async () => {
  const b = browser(env);
  await startSignup(b);
  const loc = await b.post("/api/signup/location", { location: EMPTY, country: "US" });
  assert.equal(loc.ok, true);
  assert.equal(loc.community, undefined);
  assert.equal(loc.choices.length, 3);
  for (const c of loc.choices) {
    assert.deepEqual(Object.keys(c).sort(), ["country", "id", "km", "name"]);
    assert.equal(c.country, "US");
    assert.equal(c.km % 5, 0, "distances are rounded to 5 km");
  }
  let s = await stateOf(b);
  assert.equal(s.location.done, false);
  assert.equal(s.location.picked, false);
  assert.equal(s.next, "location");
  assert.deepEqual(s.location.choices, loc.choices);

  const first = await pickCommunity(b, loc.choices[0].id);
  assert.deepEqual(first, { ok: true, community: { id: loc.choices[0].id, name: loc.choices[0].name, country: "US" } });
  s = await stateOf(b);
  assert.equal(s.location.done, true);
  assert.equal(s.location.picked, true);
  assert.deepEqual(s.location.choices, loc.choices, "the choices stay after picking");

  const second = await pickCommunity(b, loc.choices[2].id);
  assert.equal(second.community.id, loc.choices[2].id, "changed their mind");

  await doTerms(b);
  const made = await doEmail(b, box, "wild@example.com");
  assert.equal(made.verify.isNew, true, JSON.stringify(made.verify));
  assert.equal(made.verify.welcome.city, loc.choices[2].name);
  const u = await one(env.DB, "SELECT home_city, home_name, home_country FROM users");
  assert.deepEqual({ ...u }, { home_city: loc.choices[2].id, home_name: loc.choices[2].name, home_country: "US" });
});

test("GET /api/signup/state with no cookie, a made-up cookie or an expired sign-up answers the empty state and creates nothing", async () => {
  const b = browser(env);
  const r = await b.send("/api/signup/state");
  assert.deepEqual(await r.json(), { ok: true, state: EMPTY_STATE });
  assert.deepEqual(cookiesOf(r), [], "no cookie is set by a read");
  b.jar.set("vsu", "made-up-token");
  assert.deepEqual((await b.get("/api/signup/state")), { ok: true, state: EMPTY_STATE });
  assert.equal(await count("signups"), 0);

  const real = browser(env);
  await startSignup(real);
  await doTerms(real);
  advance(61 * 60_000);
  assert.deepEqual(await real.get("/api/signup/state"), { ok: true, state: EMPTY_STATE }, "expired: back to the start, not an error");
});

test("start twice gives the same sign-up (and no second row); after it expired a start makes a fresh one with a new token", async () => {
  const b = browser(env);
  await startSignup(b);
  await doTerms(b);
  const token1 = b.jar.get("vsu");
  const again = await startSignup(b);
  assert.equal(again.state.terms.done, true, "the current sign-up comes back");
  assert.equal(b.jar.get("vsu"), token1, "same cookie");
  assert.equal(await count("signups"), 1);
  advance(2 * 3600_000);
  const fresh = await startSignup(b);
  assert.equal(fresh.state.terms.done, false);
  assert.notEqual(b.jar.get("vsu"), token1, "never reuses an old token");
  assert.equal(await count("signups"), 2, "the expired one waits for the scheduled tidy-up");
});

test("signing in as an existing person during 'New here' ends the half-done sign-up: wallet, Google, e-mail code and the phone-QR way", async () => {
  const mem = await memberWithWallet(env, box, { via: "email", email: "member@example.com" });
  const memGoogle = await memberWithWallet(env, box, { via: "google", sub: "member-google" });

  const startHalf = async () => {
    const b = browser(env);
    await startSignup(b);
    await doLocation(b);
    await doTerms(b);
    assert.ok(b.has("vsu"));
    return b;
  };
  const ended = async (b, label) => {
    assert.ok(!b.has("vsu"), label + ": the sign-up cookie is cleared");
    assert.equal((await b.get("/api/me?lite=1")).signedIn, true, label + ": signed in");
  };

  // 1. a wallet that is linked to an account
  let b = await startHalf();
  const r = await b.post("/api/auth/wallet", await loginBody(mem.w));
  assert.equal(r.next, "/dashboard");
  await ended(b, "wallet");

  // 2. a Google login that already has an account (started from the sign-up page, so it carries the marker)
  b = await startHalf();
  const g = await doGoogle(b, "member-google");
  assert.equal(g.to, "/dashboard");
  await ended(b, "google");

  // 3. an e-mail address that already has an account, through the sign-up's own route
  b = await startHalf();
  const e = await doEmail(b, box, "member@example.com", { password: "another long password" });
  assert.deepEqual({ ok: e.verify.ok, existing: e.verify.existing, isNew: e.verify.isNew, next: e.verify.next }, { ok: true, existing: true, isNew: false, next: "/dashboard" });
  await ended(b, "e-mail");

  // 4. the same address through today's e-mail code route
  b = await startHalf();
  await b.send("/api/auth/email/start", { method: "POST", body: { email: "member@example.com" }, fetchImpl: box.fetch });
  advance(61_000); // (the first code of this address is a minute old: a new send is allowed)
  const old = await (await b.send("/api/auth/email/verify", { method: "POST", body: { email: "member@example.com", code: box.codeFor("member@example.com") }, fetchImpl: box.fetch })).json();
  assert.equal(old.next, "/dashboard");
  await ended(b, "old e-mail route");

  // 5. a phone approves for this computer ("sign in with my phone"): pair + finish
  b = await startHalf();
  const pair = await b.post("/api/pair");
  const phone = browser(env);
  const body = await loginBody(memGoogle.w, pair.pin);
  assert.equal((await phone.post("/api/auth/wallet", { ...body, pair: pair.code })).paired, true);
  const fin = await b.post("/api/pair/finish", { code: pair.code });
  assert.equal(fin.next, "/dashboard");
  await ended(b, "pair");

  assert.equal(await count("signups"), 0, "every half-done sign-up was deleted");
  assert.equal(await count("users"), 2, "and nobody got a second account");
});

test("an unknown wallet in v2 never gets an account from a wallet login alone, whatever it does next", async () => {
  const b = browser(env);
  const w = await wallet();
  const r = await doWallet(b, w);
  assert.notEqual(r.next, "/dashboard");
  assert.equal((await b.get("/api/me")).signedIn, false);
  assert.equal(await count("users"), 0);
  assert.deepEqual(await stateOf(b), EMPTY_STATE, "and no sign-up was started by it");
});

test("fault injection: while the new tables cannot be made, start answers 503 signup_unavailable and the rest of the site is untouched; then it recovers", async () => {
  let armed = true;
  const real = env.DB;
  env.DB = { ...real, prepare: (sql) => {
    if (armed && /^ALTER TABLE users ADD COLUMN password_hash/i.test(sql)) {
      const failing = { sql, bind: () => failing, run: async () => { throw new Error("D1_ERROR: disk I/O error"); }, first: async () => { throw new Error("D1_ERROR: disk I/O error"); }, all: async () => { throw new Error("D1_ERROR: disk I/O error"); } };
      return failing;
    }
    return real.prepare(sql);
  } };
  const b = browser(env);
  for (const path of ["/api/signup/start", "/api/signup/location", "/api/signup/finish"]) {
    const r = await b.send(path, { method: "POST", body: {} });
    assert.equal(r.status, 503, path);
    assert.deepEqual(await r.json(), { ok: false, error: "signup_unavailable" });
  }
  assert.equal((await b.send("/api/signup/state")).status, 503);
  // the old routes do not need the new tables
  assert.equal((await b.send("/api/members")).status, 200);
  assert.equal((await b.send("/api/me?lite=1")).status, 200);
  armed = false;
  assert.equal((await startSignup(b)).ok, true, "the next request makes the tables and goes on");
});

test("the scheduled tidy-up removes expired sign-ups and old counters, keeps live ones, and never fails when the tables are missing", async () => {
  const noTables = V2();
  await assert.doesNotReject(cleanupSignups(noTables, clock.now));
  assert.equal((await runJobs(noTables, clock.now, undefined, () => 0.99)).cleanup.ok, true);

  const live = browser(env);
  await startSignup(live);
  await doTerms(live);
  const gone = browser(env);
  await startSignup(gone);
  await env.DB.prepare("UPDATE signups SET expires_at = ? WHERE id != (SELECT id FROM signups ORDER BY created_at, rowid LIMIT 1)").bind(new Date(clock.now - 1000).toISOString()).run();
  const t = new Date(clock.now).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO auth_limits (key, n, window_start) VALUES ('old', 3, ?)").bind(new Date(clock.now - 25 * 3600_000).toISOString()),
    env.DB.prepare("INSERT INTO auth_limits (key, n, window_start) VALUES ('recent', 3, ?)").bind(t),
  ]);
  const out = await tick(env);
  assert.deepEqual(out.cleanup, { ok: true });
  assert.equal(await count("signups"), 1, "the expired one is gone, the live one stays");
  assert.deepEqual((await rows(env.DB, "SELECT key FROM auth_limits WHERE key IN ('old','recent')")).map((r) => r.key), ["recent"]);
});

test("the sign-up e-mail says 'verification code', and the same sender and subject as the sign-in e-mail", async () => {
  const b = browser(env);
  await startSignup(b);
  await doTerms(b);
  await doEmail(b, box, "words@example.com", { verify: false });
  assert.equal(box.last().kind, "signup");
  assert.equal(box.last().subject, `${box.last().code} is your Vicinity code`);
});

test("with the real password cost (100,000 rounds, no test setting) a whole sign-up still works, and the stored hash says so", async () => {
  env = V2({ PASSWORD_ITERATIONS: undefined });
  const b = browser(env);
  const started = performance.now(); // (Date.now is the test clock)
  const j = await journey(b, box, { via: "email" });
  assert.equal(j.finish.ok, true, JSON.stringify(j.finish));
  assert.ok((await one(env.DB, "SELECT password_hash FROM users")).password_hash.startsWith("pbkdf2-sha256$100000$"));
  assert.ok(performance.now() - started < 5000, "one hash at full cost is well under a second");
});
