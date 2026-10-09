// The finish (src/signup-finish.js): the one atomic step that makes the account, run by the account step itself the moment the
// login is verified, and by POST /api/signup/finish when the page tries again. Races, collisions, failures half-way: nothing is
// ever created by halves and nothing the person already proved is thrown away by a failure.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, browser, realClock, useClock } from "./helpers/world.js";
import { GOOD_PASSWORD, doEmail, doGoogle, doLocation, doTerms, fakeGoogle, finish, journey, member, one, outbox, rows, startSignup, stateOf } from "./helpers/signup.js";
import { slowDb } from "./helpers/slowdb.js";
import { FINISH } from "../src/signup-finish.js";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const count = async (table, where = "1 = 1") => (await one(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)).n;
const NOW = () => new Date(Date.now()).toISOString();
const insertUser = (wallet, provider, providerId, handle = "Someone" + Math.floor(Math.random() * 1e6)) =>
  env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (?, ?, ?, ?, ?)").bind(wallet, provider, providerId, handle, NOW()).run();
/** Everything finish may touch, as text: to prove a failed finish changed nothing. */
const snapshot = async () => JSON.stringify({
  users: await rows(env.DB, "SELECT * FROM users ORDER BY id"), sessions: await rows(env.DB, "SELECT * FROM sessions ORDER BY id"),
  signups: await rows(env.DB, "SELECT * FROM signups ORDER BY id"), handoffs: await rows(env.DB, "SELECT * FROM handoffs ORDER BY id"),
});
// Where Cloudflare puts the connection: at home (Comcast, near Utica) and, for one request, on another network
const HOME = { country: "US", asn: 7922, asOrganization: "Comcast Cable", latitude: 43.1, longitude: -75.2 };
const AWAY = { ...HOME, asn: 701, asOrganization: "Verizon Business" };
let n = 0;
/**
 * A person whose login is verified and recorded but whose account is not made yet: the only way that happens in v3 is a finish that
 * refused (here: the code or the Google answer arrived from another network, so the location was forgotten) followed by the location
 * step done again. Everything is in place, the sign-up's `next` is "finish", and POST /api/signup/finish is the tap that is left.
 */
async function ready({ via = "email", email, sub } = {}) {
  const b = browser(env, { ip: `203.0.113.${(n % 200) + 10}`, cf: HOME });
  const usersBefore = await count("users").catch(() => 0); // (the tables are made by the first sign-up request)
  const j = await journey(b, box, { via, until: "terms" });
  if (via === "email") {
    j.email = email || `fin${n++}@example.com`;
    await b.send("/api/signup/email", { method: "POST", body: { email: j.email, password: GOOD_PASSWORD }, fetchImpl: box.fetch });
    const v = await (await b.send("/api/signup/email/verify", { method: "POST", body: { code: box.codeFor(j.email) }, fetchImpl: box.fetch, cf: AWAY })).json();
    assert.deepEqual([v.ok, v.existing, v.finishError], [true, false, "location_unverified"], JSON.stringify(v));
  } else {
    j.sub = sub || `g-fin-${n++}`;
    const start = await b.send("/api/auth/google/start?signup=1");
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cb = await b.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: fakeGoogle(j.sub), cf: AWAY });
    assert.equal(cb.headers.get("location"), "/connect?error=location_unverified");
  }
  assert.equal(await count("users"), usersBefore, "no account yet");
  assert.equal((await stateOf(b)).next, "location", "only the location was forgotten");
  assert.equal((await doLocation(b)).ok, true);
  assert.equal((await stateOf(b)).next, "finish");
  return { b, ...j };
}
/** Run `hook` once, right after finish's own checks looked at the identity and before its transaction (the window a race lives in). */
function afterChecks(hook) {
  const real = env.DB;
  let fired = false;
  const wrap = (s) => ({ ...s, bind: (...p) => wrap(s.bind(...p)), first: async () => { const r = await s.first(); if (!fired) { fired = true; await hook(real); } return r; } });
  env.DB = { ...real, prepare: (sql) => (sql === "SELECT id FROM users WHERE provider = ? AND provider_id = ?" ? wrap(real.prepare(sql)) : real.prepare(sql)) };
  return () => { env.DB = real; };
}

test("the finish is four statements in one transaction, every value from the sign-up row, the account without a wallet", () => {
  assert.equal(FINISH.length, 4);
  assert.match(FINISH[0], /^INSERT INTO users \(wallet, provider, provider_id, handle, name, early, created_at, terms_version, terms_agreed_at, home_city, home_name, home_country, home_at, password_hash\)\s+SELECT NULL, s\.provider, s\.provider_id/);
  assert.match(FINISH[0], /NOT EXISTS \(SELECT 1 FROM users WHERE provider = \?4 AND provider_id = \?5\)/);
  assert.match(FINISH[1], /^INSERT INTO sessions \(id, wallet, user_id, proof, created_at, expires_at, proven_at\)\s+SELECT \?8, NULL, u\.id, NULL, \?1, \?9, NULL FROM users u/);
  assert.match(FINISH[2], /^DELETE FROM handoffs WHERE signup_id = \?2 AND EXISTS \(SELECT 1 FROM sessions WHERE id = \?8\)$/);
  assert.match(FINISH[3], /^DELETE FROM signups WHERE id = \?2 AND EXISTS \(SELECT 1 FROM sessions WHERE id = \?8\)$/);
  for (const sql of FINISH) assert.ok(!/pairs|wallet = \?|proven_at = \?/.test(sql), "no wallet, no proof, no pair: " + sql);
});

test("the tap that is left: POST /api/signup/finish makes the account (no wallet, no proof) and signs the browser in, with the welcome", async () => {
  const { b, email } = await ready();
  const res = await b.send("/api/signup/finish", { method: "POST", body: {} });
  const body = await res.json();
  assert.deepEqual(body, { ok: true, next: "/dashboard?welcome=1", isNew: true, welcome: { name: null, city: "Utica", memberNumber: 1 } });
  const sc = res.headers.getSetCookie();
  assert.match(sc.find((c) => c.startsWith("vs=")), /Max-Age=2592000$/);
  assert.match(sc.find((c) => c.startsWith("vsu=")), /Max-Age=0$/);
  const u = await one(env.DB, "SELECT wallet, provider, provider_id, home_name FROM users");
  assert.deepEqual({ ...u }, { wallet: null, provider: "email", provider_id: email, home_name: "Utica" });
  const s = await one(env.DB, "SELECT wallet, proven_at, user_id FROM sessions");
  assert.deepEqual([s.wallet, s.proven_at, s.user_id != null], [null, null, true]);
  assert.equal(await count("signups"), 0);
  const me = await b.get("/api/me?lite=1");
  assert.deepEqual([me.signedIn, me.fresh, me.user.wallet], [true, true, null]);
  // a Google person: the first name is on the welcome, and the member number counts the people of the community before
  const g = await ready({ via: "google" });
  const r2 = await finish(g.b);
  assert.deepEqual(r2.welcome, { name: "G" + g.sub, city: "Utica", memberNumber: 2 });
});

test("two or more finishes at the same moment make ONE account and ONE session; the others are told it is already done", async () => {
  env.DB = slowDb(env.DB, 3);
  const { b } = await ready();
  const answers = await Promise.all(Array.from({ length: 5 }, () => b.send("/api/signup/finish", { method: "POST", body: {} }).then(async (r) => ({ status: r.status, ...(await r.json()) }))));
  assert.equal(answers.filter((a) => a.ok).length, 1, JSON.stringify(answers));
  for (const a of answers.filter((x) => !x.ok)) assert.ok(["already_finished", "no_signup"].includes(a.error), JSON.stringify(a));
  assert.ok(answers.some((a) => a.error === "already_finished"), "at least one loser knew why: " + JSON.stringify(answers));
  assert.equal(await count("users"), 1);
  assert.equal(await count("sessions", "user_id IS NOT NULL"), 1, "one full session");
  assert.equal(await count("sessions", "user_id IS NULL"), 0, "no pending session");
  assert.equal(await count("signups"), 0);
  assert.equal((await b.get("/api/me?lite=1")).signedIn, true);
});

test("a login that already has an account: social_taken, and nothing is thrown away", async () => {
  const { b } = await ready({ via: "email", email: "taken@example.com" });
  await insertUser(null, "email", "taken@example.com");
  const before = await snapshot();
  const r = await b.send("/api/signup/finish", { method: "POST", body: {} });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { ok: false, error: "social_taken" });
  assert.equal(await snapshot(), before);
  assert.equal((await stateOf(b)).account.done, true, "the page can offer another login on the same sign-up");
});

test("the same collision in the split second AFTER finish checked: the transaction refuses, nothing changes, and the stranger gets no session", async () => {
  const { b } = await ready({ via: "email", email: "raced@example.com" });
  const restore = afterChecks((db) => db.prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (NULL, 'email', 'raced@example.com', 'Racer2', ?)").bind(NOW()).run());
  const r = await b.send("/api/signup/finish", { method: "POST", body: {} });
  restore();
  assert.deepEqual([r.status, (await r.json()).error], [409, "social_taken"]);
  assert.equal(await count("users"), 1, "only the stranger's account exists");
  assert.equal(await count("signups"), 1, "the sign-up is still there");
  assert.equal(await count("sessions", "user_id IS NOT NULL"), 0, "the stranger's account was NOT given a session by us");
});

test("the person's identity voided in the split second after finish checked: no account, and the answer says what is missing", async () => {
  const { b } = await ready({ via: "email", email: "void@example.com" });
  const restore = afterChecks((db) => db.prepare("UPDATE signups SET provider = NULL, provider_id = NULL, identity_at = NULL, pending_email = 'x@example.com'").run());
  const r = await b.send("/api/signup/finish", { method: "POST", body: {} });
  restore();
  assert.deepEqual([r.status, (await r.json()).error], [400, "account_required"]);
  assert.equal(await count("users"), 0);
  assert.equal(await count("signups"), 1);
});

test("the transaction checks every condition itself: whatever changes in the split second after finish looked, nothing is created", async () => {
  const cases = [
    ["the community is forgotten", "UPDATE signups SET loc_city = NULL", "location_required", 400],
    ["the Terms are replaced by an old version", "UPDATE signups SET terms_version = '2020-01-01'", "terms_required", 400],
    ["the sign-up runs out", "UPDATE signups SET expires_at = '2000-01-01T00:00:00.000Z'", "no_signup", 401],
    ["the identity is swapped for another", "UPDATE signups SET provider_id = 'someone-else'", "changed_retry", 409],
  ];
  for (const [name, sql, error, status] of cases) {
    env = V2();
    box = outbox();
    const { b } = await ready();
    const restore = afterChecks((db) => db.prepare(sql).run());
    const r = await b.send("/api/signup/finish", { method: "POST", body: {} });
    restore();
    const answer = await r.json();
    assert.deepEqual([r.status, answer.ok, answer.error], [status, false, error], name + " " + JSON.stringify(answer));
    assert.equal(await count("users"), 0, name + ": no account");
    assert.equal(await count("sessions", "user_id IS NOT NULL"), 0, name + ": no session");
  }
});

test("a username that collides at the INSERT (taken a moment earlier, any letter case) is replaced by another one, and nothing is burned", async () => {
  const { b } = await ready();
  await insertUser(null, "google", "w-old", "swiftharbor10");
  const real = env.DB;
  let lie = 1; // the first "is this name free?" lookup wrongly says yes, like a name taken a moment later by someone else
  const lookup = (stmt) => ({ ...stmt, bind: (...p) => ({ ...stmt.bind(...p), first: async () => (lie-- > 0 ? null : stmt.bind(...p).first()) }) });
  env.DB = { ...real, prepare: (sql) => (/^SELECT id FROM users WHERE lower\(handle\)/.test(sql) ? lookup(real.prepare(sql)) : real.prepare(sql)) };
  const realRandom = Math.random;
  let calls = 0;
  Math.random = () => (calls++ < 3 ? 0 : 0.5); // the first name drawn is SwiftHarbor10
  let r;
  try { r = await finish(b); } finally { Math.random = realRandom; env.DB = real; }
  assert.equal(r.ok, true, JSON.stringify(r));
  const u = await one(env.DB, "SELECT handle FROM users WHERE provider = 'email'");
  assert.notEqual(u.handle.toLowerCase(), "swiftharbor10");
  assert.equal(await count("users"), 2);
  assert.equal(await count("signups"), 0);
});

test("an error half-way through the transaction changes NOTHING anywhere, and the same tap works once it is fixed", async () => {
  const { b } = await ready();
  const before = await snapshot();
  const real = env.DB;
  env.DB = { ...real, prepare: (sql) => (/^INSERT INTO sessions .* SELECT \?8,/s.test(sql.replace(/\s+/g, " ")) ? real.prepare("INSERT INTO table_that_does_not_exist (x) VALUES (?1)") : real.prepare(sql)) };
  await assert.rejects(finish(b), /no such table/i);
  env.DB = real;
  assert.equal(await snapshot(), before, "users, sessions, sign-ups and hand-offs are exactly as they were");
  assert.equal((await stateOf(b)).next, "finish");
  assert.equal((await finish(b)).ok, true);
  assert.equal(await count("users"), 1);
});

test("what is missing is named, and nothing is deleted: the community, the Terms, the account (and 'the e-mail is typed but not verified')", async () => {
  // community missing: the verified code records the login and says so; the finish route says the same
  const b1 = browser(env);
  await startSignup(b1);
  await doTerms(b1);
  const v = await doEmail(b1, box, "noloc@example.com");
  assert.deepEqual([v.verify.ok, v.verify.finishError, v.verify.state.next], [true, "location_required", "location"], JSON.stringify(v.verify));
  const r1 = await b1.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([r1.status, (await r1.json()).error], [400, "location_required"]);
  assert.equal((await stateOf(b1)).account.done, true, "the verified login is kept");

  // the Terms missing
  const b0 = browser(env);
  await startSignup(b0);
  await doLocation(b0);
  const r0 = await b0.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([r0.status, (await r0.json()).error], [400, "terms_required"]);

  // account missing, and the e-mail typed but not verified
  const b2 = browser(env);
  await startSignup(b2);
  await doLocation(b2);
  await doTerms(b2);
  const r2 = await b2.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([r2.status, await r2.json()], [400, { ok: false, error: "account_required" }]);
  await b2.send("/api/signup/email", { method: "POST", body: { email: "typed@example.com", password: "a long enough password" }, fetchImpl: box.fetch });
  assert.deepEqual(await (await b2.send("/api/signup/finish", { method: "POST", body: {} })).json(), { ok: false, error: "account_required", pending: true });

  assert.equal(await count("users"), 0);
  assert.equal(await count("signups"), 3);
});

test("Terms from an older version do not count, and the person is asked to tick again", async () => {
  const { b } = await ready();
  await env.DB.prepare("UPDATE signups SET terms_version = '2020-01-01'").run();
  const r = await b.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([r.status, (await r.json()).error], [400, "terms_required"]);
  assert.equal((await stateOf(b)).terms.done, false);
  assert.equal((await stateOf(b)).account.done, false, "an account step without current Terms is not done");
  assert.equal(await count("users"), 0);
});

test("only the browser that holds the sign-up cookie can finish it; a member who taps it gets already_signed_in", async () => {
  const { b: victim } = await ready();
  const attacker = browser(env);
  const r = await attacker.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([r.status, (await r.json()).error], [401, "no_signup"]);
  attacker.jar.set("vsu", "A".repeat(43));
  assert.equal((await attacker.send("/api/signup/finish", { method: "POST", body: {} })).status, 401);
  assert.equal(await count("users"), 0);
  assert.equal((await stateOf(victim)).next, "finish", "the victim's sign-up is untouched");
  const m = await member(env, box);
  const again = await m.b.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([again.status, (await again.json()).error], [409, "already_signed_in"]);
});

test("no session fixation: a session cookie the browser carried in is replaced by a new token, never adopted", async () => {
  const { b } = await ready();
  b.jar.set("vs", "B".repeat(43));
  assert.equal((await finish(b)).ok, true);
  assert.notEqual(b.jar.get("vs"), "B".repeat(43));
  const old = browser(env);
  old.jar.set("vs", "B".repeat(43));
  assert.equal((await old.get("/api/me")).signedIn, false);
  assert.equal((await b.get("/api/me?lite=1")).signedIn, true);
});

test("after the finish a replay of the same cookies finds nothing", async () => {
  const { b } = await ready();
  const jarBefore = new Map(b.jar);
  assert.equal((await finish(b)).ok, true);
  const replay = browser(env);
  for (const [k, v] of jarBefore) replay.jar.set(k, v);
  const r = await replay.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([r.status, (await r.json()).error], [401, "no_signup"]);
  assert.deepEqual((await replay.get("/api/signup/state")).state.next, "location");
  assert.equal(await count("users"), 1);
});

test("finish is limited to ten tries an hour per sign-up (the account step's own try counts), and without any cookie it is simply no_signup", async () => {
  const { b } = await ready();
  await env.DB.prepare("UPDATE signups SET terms_version = '2020-01-01'").run();
  const answers = [];
  for (let i = 0; i < 10; i++) answers.push((await b.send("/api/signup/finish", { method: "POST", body: {} })).status);
  assert.deepEqual(answers, [400, 400, 400, 400, 400, 400, 400, 400, 400, 429], "one try was the verified code itself");
  assert.equal((await (await b.send("/api/signup/finish", { method: "POST", body: {} })).json()).error, "slow_down");
  const { b: other } = await ready();
  await env.DB.prepare("UPDATE signups SET terms_version = '2020-01-01'").run();
  assert.equal((await other.send("/api/signup/finish", { method: "POST", body: {} })).status, 400, "the limit is per sign-up");
  assert.equal((await browser(env).send("/api/signup/finish", { method: "POST", body: {} })).status, 401);
});

test("the account is built from the database: whatever the page sends with the request is ignored", async () => {
  const { b } = await ready({ via: "email", email: "honest@example.com" });
  const r = await b.send("/api/signup/finish", { method: "POST", body: {
    wallet: "Attacker1111111111111111111111111111111111111", provider: "google", provider_id: "evil", handle: "Admin", name: "Evil", home_city: "5128581",
    early: 0, terms_version: "1999-01-01", password_hash: "pbkdf2-sha256$1$x$y", email: "evil@example.com" } });
  assert.equal((await r.json()).ok, true);
  const u = await one(env.DB, "SELECT * FROM users");
  assert.equal(u.wallet, null);
  assert.equal(u.provider_id, "honest@example.com");
  assert.notEqual(u.handle, "Admin");
  assert.equal(u.home_city, "5142056");
  assert.equal(u.terms_version, "2026-10-01");
  assert.ok(u.password_hash.startsWith("pbkdf2-sha256$1000$"));
});

test("a Google person gets a Google account with no password, whatever e-mail was typed before", async () => {
  const b = browser(env);
  await startSignup(b);
  await doLocation(b);
  await doTerms(b);
  await doEmail(b, box, "first.try@example.com", { verify: false }); // typed an e-mail first ...
  await b.post("/api/signup/account/reset");                          // ... then chose Google instead
  assert.equal((await doGoogle(b, "google-after-email")).to, "/dashboard?welcome=1");
  const u = await one(env.DB, "SELECT provider, provider_id, password_hash, wallet FROM users");
  assert.deepEqual({ ...u }, { provider: "google", provider_id: "google-after-email", password_hash: null, wallet: null });
});
