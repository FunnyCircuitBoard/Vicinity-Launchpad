// finish: the one atomic step that makes the account. Races, collisions, failures half-way: nothing is ever
// created by halves and nothing the person already proved is thrown away by a failure.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, advance, browser, realClock, useClock, wallet } from "./helpers/world.js";
import { doEmail, doGoogle, doLocation, doTerms, doWallet, finish, journey, one, outbox, rows, startSignup, stateOf } from "./helpers/signup.js";
import { slowDb } from "./helpers/slowdb.js";

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
/** A person who has done everything except the last tap. */
async function ready({ via = "email", net, w, ...rest } = {}) {
  const b = browser(env, net);
  const j = await journey(b, box, { via, w, until: "wallet", ...rest });
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

test("two or more finishes at the same moment make ONE account and ONE session; the others are told it is already done", async () => {
  env.DB = slowDb(env.DB, 3);
  const { b } = await ready();
  const answers = await Promise.all(Array.from({ length: 5 }, () => b.send("/api/signup/finish", { method: "POST", body: {} }).then(async (r) => ({ status: r.status, ...(await r.json()) }))));
  assert.equal(answers.filter((a) => a.ok).length, 1, JSON.stringify(answers));
  for (const a of answers.filter((x) => !x.ok)) assert.ok(["already_finished", "no_signup"].includes(a.error), JSON.stringify(a));
  assert.ok(answers.some((a) => a.error === "already_finished"), "at least one loser knew why: " + JSON.stringify(answers));
  assert.equal(await count("users"), 1);
  assert.equal(await count("sessions", "user_id IS NOT NULL"), 1, "one full session");
  assert.equal(await count("sessions", "user_id IS NULL"), 0, "no pending session left");
  assert.equal(await count("signups"), 0);
  assert.equal((await b.get("/api/me?lite=1")).signedIn, true);
});

test("a wallet that already has an account: wallet_taken, and the sign-up and the proven wallet are kept", async () => {
  const { b, w } = await ready();
  await insertUser(w.address, "google", "someone-else-sub");
  const before = await snapshot();
  const r = await b.send("/api/signup/finish", { method: "POST", body: {} });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { ok: false, error: "wallet_taken" });
  assert.equal(await snapshot(), before, "not one row changed");
  assert.equal((await stateOf(b)).wallet.done, true);
});

test("a login that already has an account: social_taken, and nothing is thrown away", async () => {
  const { b } = await ready({ via: "email", email: "taken@example.com" });
  await insertUser((await wallet()).address, "email", "taken@example.com");
  const before = await snapshot();
  const r = await b.send("/api/signup/finish", { method: "POST", body: {} });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { ok: false, error: "social_taken" });
  assert.equal(await snapshot(), before);
});

test("the same two collisions in the split second AFTER finish checked: the transaction refuses, nothing changes, and nobody else gets a session", async () => {
  // the wallet gets an account while finish is working
  let { b, w } = await ready();
  let restore = afterChecks((db) => db.prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (?, 'google', 'raced-sub', 'Racer1', ?)").bind(w.address, NOW()).run());
  const before = JSON.parse(await snapshot());
  let r = await b.send("/api/signup/finish", { method: "POST", body: {} });
  restore();
  assert.deepEqual([r.status, (await r.json()).error], [409, "wallet_taken"]);
  const after = JSON.parse(await snapshot());
  assert.equal(after.users.length, 1, "only the stranger's account exists");
  assert.equal(await count("sessions", "user_id IS NOT NULL"), 0, "the stranger's account was NOT given a session by us");
  assert.equal(after.signups.length, 1, "the sign-up is still there");
  assert.deepEqual(after.sessions, before.sessions, "so is the pending wallet session, untouched");

  // the login gets an account while finish is working
  env = V2();
  box = outbox();
  ({ b } = await ready({ via: "email", email: "raced@example.com" }));
  restore = afterChecks((db) => db.prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES ('OtherWallet11111111111111111111111111111111', 'email', 'raced@example.com', 'Racer2', ?)").bind(NOW()).run());
  r = await b.send("/api/signup/finish", { method: "POST", body: {} });
  restore();
  assert.deepEqual([r.status, (await r.json()).error], [409, "social_taken"]);
  assert.equal(await count("users"), 1);
  assert.equal(await count("signups"), 1);
  assert.equal(await count("sessions", "user_id IS NOT NULL"), 0);
});

test("the person's identity voided in the split second after finish checked: no account, and the answer says what is missing", async () => {
  const { b } = await ready({ via: "email", email: "void@example.com" });
  const restore = afterChecks((db) => db.prepare("UPDATE signups SET provider = NULL, provider_id = NULL, identity_at = NULL, pending_email = 'x@example.com'").run());
  const r = await b.send("/api/signup/finish", { method: "POST", body: {} });
  restore();
  assert.deepEqual([r.status, (await r.json()).error], [400, "account_required"]);
  assert.equal(await count("users"), 0);
  assert.equal(await count("signups"), 1);
  assert.equal(await count("sessions", "user_id IS NULL"), 1, "the proven wallet is kept");
});

test("the transaction checks every condition itself: whatever changes in the split second after finish looked, nothing is created", async () => {
  const cases = [
    ["the community is forgotten", "UPDATE signups SET loc_city = NULL", "location_required", 400],
    ["the Terms are replaced by an old version", "UPDATE signups SET terms_version = '2020-01-01'", "terms_required", 400],
    ["the sign-up runs out", "UPDATE signups SET expires_at = '2000-01-01T00:00:00.000Z'", "no_signup", 401],
    ["the wallet session is gone", "DELETE FROM sessions WHERE user_id IS NULL", "already_finished_or_wallet", null],
    ["the wallet proof turns stale", "UPDATE sessions SET proven_at = '2000-01-01T00:00:00.000Z' WHERE user_id IS NULL", "wallet_expired", 403],
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
    assert.equal(answer.ok, false, name + " " + JSON.stringify(answer));
    if (status) assert.deepEqual([r.status, answer.error], [status, error], name);
    else assert.ok(["wallet_required", "no_signup"].includes(answer.error), name + " " + JSON.stringify(answer));
    assert.equal(await count("users"), 0, name + ": no account");
    assert.equal(await count("sessions", "user_id IS NOT NULL"), 0, name + ": no session");
  }
});

test("a username that collides at the INSERT (taken a moment earlier, any letter case) is replaced by another one, and nothing is burned", async () => {
  const { b } = await ready();
  await insertUser((await wallet()).address, "wallet", "w-old", "swiftharbor10");
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
  env.DB = { ...real, prepare: (sql) => (/^INSERT INTO sessions .* SELECT \?12/s.test(sql.replace(/\s+/g, " ")) ? real.prepare("INSERT INTO table_that_does_not_exist (x) VALUES (?1)") : real.prepare(sql)) };
  await assert.rejects(finish(b), /no such table/i);
  env.DB = real;
  assert.equal(await snapshot(), before, "users, sessions, sign-ups and hand-offs are exactly as they were");
  assert.equal((await stateOf(b)).next, "finish");
  assert.equal((await finish(b)).ok, true);
  assert.equal(await count("users"), 1);
});

test("a wallet proof that is too old is refused with wallet_expired (prove again), a gone one with wallet_required, and nothing is deleted", async () => {
  const { b, w } = await ready();
  await env.DB.prepare("UPDATE sessions SET proven_at = ? WHERE user_id IS NULL").bind(new Date(Date.now() - 31 * 60_000).toISOString()).run();
  const before = await snapshot();
  const stale = await b.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([stale.status, (await stale.json()).error], [403, "wallet_expired"]);
  assert.equal(await snapshot(), before);
  assert.equal((await stateOf(b)).wallet.done, false, "the page asks for the wallet again");
  await doWallet(b, w);
  assert.equal((await finish(b)).ok, true, "proving again is all it takes");

  const { b: c } = await ready();
  advance(31 * 60_000); // the 30-minute wallet session itself ran out; the sign-up (an hour) did not
  assert.equal((await stateOf(c)).terms.done, true);
  const gone = await c.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([gone.status, (await gone.json()).error], [400, "wallet_required"]);
  assert.equal(await count("signups"), 1);
});

test("what is missing is named, and nothing is deleted: wallet, Terms, community, account (and 'the e-mail is typed but not verified')", async () => {
  // wallet missing
  const noWallet = browser(env);
  await journey(noWallet, box, { via: "email", until: "account" });
  const r0 = await noWallet.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([r0.status, (await r0.json()).error], [400, "wallet_required"]);

  // community missing
  const b1 = browser(env);
  await startSignup(b1);
  await doTerms(b1);
  await doEmail(b1, box, "noloc@example.com");
  await doWallet(b1, await wallet());
  const r1 = await b1.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([r1.status, (await r1.json()).error], [400, "location_required"]);
  assert.equal((await stateOf(b1)).next, "location");

  // account missing, and the e-mail typed but not verified
  const b2 = browser(env);
  await startSignup(b2);
  await doLocation(b2);
  await doTerms(b2);
  await doWallet(b2, await wallet());
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

test("only the browser that holds the sign-up cookie AND the wallet session can finish it", async () => {
  const { b: victim } = await ready();
  // an attacker with a proven wallet of their own but no sign-up
  const attacker = browser(env);
  await doWallet(attacker, await wallet());
  const r = await attacker.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([r.status, (await r.json()).error], [401, "no_signup"]);
  // a made-up or foreign sign-up cookie
  attacker.jar.set("vsu", "A".repeat(43));
  assert.equal((await attacker.send("/api/signup/finish", { method: "POST", body: {} })).status, 401);
  assert.equal(await count("users"), 0);
  assert.equal((await stateOf(victim)).next, "finish", "the victim's sign-up is untouched");
});

test("no session fixation: the wallet session from before the finish is dead afterwards, and the new one is a new token", async () => {
  const { b } = await ready();
  const pendingToken = b.jar.get("vs");
  assert.ok(pendingToken);
  assert.equal((await finish(b)).ok, true);
  assert.notEqual(b.jar.get("vs"), pendingToken);
  const old = browser(env);
  old.jar.set("vs", pendingToken);
  const me = await old.get("/api/me");
  assert.equal(me.signedIn, false);
  assert.ok(!me.pending, "the old pending session does not even say pending");
  assert.equal((await old.send("/api/signup/state")).status, 200);
});

test("after the finish a replay of the same cookies finds nothing, and a signed-in person who taps again gets already_signed_in", async () => {
  const { b } = await ready();
  const jarBefore = new Map(b.jar);
  assert.equal((await finish(b)).ok, true);
  const again = await b.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([again.status, (await again.json()).error], [409, "already_signed_in"]);
  const replay = browser(env);
  for (const [k, v] of jarBefore) replay.jar.set(k, v);
  const r = await replay.send("/api/signup/finish", { method: "POST", body: {} });
  assert.deepEqual([r.status, (await r.json()).error], [401, "no_signup"]);
  assert.equal(await count("users"), 1);
});

test("finish is limited to ten tries an hour per sign-up, and without any cookie it is simply no_signup", async () => {
  const { b } = await ready();
  await env.DB.prepare("UPDATE sessions SET proven_at = ? WHERE user_id IS NULL").bind(new Date(Date.now() - 31 * 60_000).toISOString()).run();
  let last;
  for (let i = 0; i < 11; i++) last = await b.send("/api/signup/finish", { method: "POST", body: {} });
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error, "slow_down");
  assert.equal((await browser(env).send("/api/signup/finish", { method: "POST", body: {} })).status, 401);
});

test("the account is built from the database: whatever the page sends with the request is ignored", async () => {
  const { b, w } = await ready({ via: "email", email: "honest@example.com" });
  const r = await b.send("/api/signup/finish", { method: "POST", body: {
    wallet: "Attacker1111111111111111111111111111111111111", provider: "google", provider_id: "evil", handle: "Admin", name: "Evil", home_city: "5128581",
    early: 0, terms_version: "1999-01-01", password_hash: "pbkdf2-sha256$1$x$y", email: "evil@example.com" } });
  assert.equal((await r.json()).ok, true);
  const u = await one(env.DB, "SELECT * FROM users");
  assert.equal(u.wallet, w.address);
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
  await doEmail(b, box, "first.try@example.com"); // typed an e-mail first ...
  await b.post("/api/signup/account/reset");      // ... then chose Google instead
  const w = await wallet();
  await doWallet(b, w);
  await doGoogle(b, "google-after-email");
  assert.equal((await finish(b)).ok, true);
  const u = await one(env.DB, "SELECT provider, provider_id, password_hash FROM users");
  assert.deepEqual({ ...u }, { provider: "google", provider_id: "google-after-email", password_hash: null });
});
