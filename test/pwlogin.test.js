// Password log-in for e-mail accounts (SIGNUP_FLOW=v2): log in, "forgot it or never had one" (reset by e-mail code), and
// changing it while signed in. What is proven here: nobody can tell from an answer (or from the hashing work done) whether an
// address has an account or a password, guessing is limited by atomic counters that are checked BEFORE any hashing (also under
// parallel requests), the attacker is shut out before the victim, a reset needs a code mailed to that very address, and a
// password never proves the wallet. The hashing work is counted with password._stats (CPU work, not wall-clock time).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, advance, browser, realClock, reprove, useClock, wallet } from "./helpers/world.js";
import { GOOD_PASSWORD, dumpAll, journey, member, one, outbox, recordAnswers, rows, startSignup, doWallet } from "./helpers/signup.js";
import { slowDb } from "./helpers/slowdb.js";
import { _stats, verifyPassword } from "../src/password.js";
import { limitKey } from "../src/limits.js";
import { sha256 } from "../src/http.js";
import { cleanEmail, validEmail } from "../src/auth.js";
import { ensureSignupSchema } from "../src/store.js";
import { resetKey } from "../src/pwlogin.js";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const ALICE = "alice@example.com", NEW_PASSWORD = "a brand new pass phrase";
const login = (b, email, password, extra = {}) => b.send("/api/auth/email/login", { method: "POST", body: { email, password }, ...extra });
const startReset = (b, email, extra = {}) => b.send("/api/auth/password/reset/start", { method: "POST", body: { email }, fetchImpl: box.fetch, ...extra });
const reset = (b, email, code, password, extra = {}) => b.send("/api/auth/password/reset", { method: "POST", body: { email, code, password }, ...extra });
const change = (b, body, extra = {}) => b.send("/api/me/password", { method: "POST", body, ...extra });
const answer = async (r) => ({ status: r.status, body: await r.json(), cookies: r.headers.getSetCookie() });
const derivesOf = async (fn) => { const before = _stats.derives; const out = await fn(); return { out, derives: _stats.derives - before }; };
const userOf = (email) => one(env.DB, "SELECT * FROM users WHERE provider_id = ?", email);
const sessionOf = async (b) => one(env.DB, "SELECT * FROM sessions WHERE id = ?", await sha256(b.jar.get("vs")));
const countersLike = (prefix) => rows(env.DB, "SELECT key, n FROM auth_limits WHERE key LIKE ? ORDER BY key", prefix + ":%");
const ip = (n) => `198.51.100.${n}`;

/** An e-mail account the way production has one: made by a sign-in code, so it has no password at all. */
async function legacy(email = "legacy@example.com") {
  await ensureSignupSchema(env.DB);
  const w = await wallet();
  await env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, handle, name, early, created_at) VALUES (?, 'email', ?, ?, 'E-mail member', 1, ?)")
    .bind(w.address, email, "LegacyPerson" + email.length, new Date(Date.now()).toISOString()).run();
  return { w, email };
}
/** Sign in with the old e-mail code route (it still works in v2 for existing accounts, and proves no wallet). */
async function codeLogin(email, extra = {}) {
  const b = browser(env, extra);
  assert.equal((await b.send("/api/auth/email/start", { method: "POST", body: { email }, fetchImpl: box.fetch })).status, 200);
  const r = await b.send("/api/auth/email/verify", { method: "POST", body: { email, code: box.codeFor(email) } });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  return b;
}
/** Make a code for an address known (the real one goes by e-mail): "424242" under the reset name. */
const setResetCode = async (email, code = "424242") => env.DB.prepare("UPDATE email_codes SET code_hash = ? WHERE email = ?").bind(await sha256(code), resetKey(email)).run();
/** Count the SQL a request runs (statement text only, no values). */
function spyDb(db, log) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  return { ...db,
    prepare: (sql) => { log.push(norm(sql)); return db.prepare(sql); },
    batch: (list) => { log.push("BATCH " + list.map((s) => norm(s.sql)).join(" ; ")); return db.batch(list); } };
}
function captureLogs() {
  const lines = [], orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => Object.assign(console, orig) };
}
async function withoutRandom(fn) { // no 5 % tidy-up statements, so two runs of the same request run the same SQL
  const real = Math.random;
  Math.random = () => 0.5;
  try { return await fn(); } finally { Math.random = real; }
}

/* ---------------- log in ---------------- */

test("log in: the right password signs in, with a 30-day session that carries NO wallet proof", async () => {
  const alice = await member(env, box, { via: "email", email: ALICE });
  const b = browser(env);
  const { out: r, derives } = await derivesOf(() => login(b, "  Alice@Example.COM ", GOOD_PASSWORD));
  assert.equal(derives, 1, "one hash");
  assert.deepEqual(await answer(r).then(({ status, body }) => ({ status, body })), { status: 200, body: { ok: true, next: "/dashboard" } });
  const vs = r.headers.getSetCookie().filter((c) => c.startsWith("vs="));
  assert.equal(vs.length, 1);
  assert.match(vs[0], /^vs=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
  const me = await b.get("/api/me");
  assert.equal(me.signedIn, true);
  assert.equal(me.user.hasPassword, true);
  assert.equal(me.fresh, false, "a password does not prove the wallet: sensitive actions still ask for it");
  const s = await sessionOf(b);
  assert.equal(s.user_id, (await userOf(ALICE)).id);
  assert.equal(s.wallet, alice.w.address);
  assert.equal(s.proven_at, null);
  assert.equal(Date.parse(s.expires_at) - Date.now(), 30 * 86400_000);
  assert.equal((await change(b, { password: NEW_PASSWORD })).status, 403, "so a first step like changing the password asks for the wallet again");
});

test("log in: an unknown address, a wrong password, an account with no password and a Google account's contact address are indistinguishable", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const gina = await member(env, box, { via: "google", sub: "g-gina" });
  await env.DB.prepare("UPDATE users SET contact_email = 'contact@example.com' WHERE provider = 'google'").run();
  await legacy("legacy@example.com");
  await env.DB.prepare("UPDATE users SET password_hash = 'garbage' WHERE provider_id = ?").bind(ALICE).run(); // a corrupt value too
  const cases = [["nobody@example.com", GOOD_PASSWORD], [ALICE, "not the password here"], ["legacy@example.com", GOOD_PASSWORD], ["contact@example.com", GOOD_PASSWORD]];
  const seen = [];
  for (const [i, [email, password]] of cases.entries()) {
    const { out, derives } = await derivesOf(async () => answer(await login(browser(env, { ip: ip(20 + i) }), email, password)));
    seen.push({ ...out, derives });
  }
  assert.ok(gina.b);
  for (const s of seen) assert.deepEqual(s, { status: 401, body: { ok: false, error: "bad_credentials" }, cookies: [], derives: 1 });
});

test("log in: input that cannot be an account's is refused alike, with no hashing and no attempt counted; a broken body is a plain 400", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(30) });
  const bad = [{ email: "nope", password: GOOD_PASSWORD }, { email: ALICE, password: 12345678901 }, { email: ALICE, password: ["x"] }, { email: ALICE },
    { password: GOOD_PASSWORD }, { email: ALICE, password: "x".repeat(2000) }, { email: ALICE, password: "y".repeat(129) }, { email: "a@b.c\u0000", password: GOOD_PASSWORD }];
  const before = (await rows(env.DB, "SELECT key FROM auth_limits")).length;
  for (const body of bad) {
    const { out, derives } = await derivesOf(async () => answer(await b.send("/api/auth/email/login", { method: "POST", body })));
    assert.deepEqual({ ...out, derives }, { status: 401, body: { ok: false, error: "bad_credentials" }, cookies: [], derives: 0 }, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await rows(env.DB, "SELECT key FROM auth_limits")).length, before, "nothing was counted");
  const broken = await b.send("/api/auth/email/login", { method: "POST", body: undefined });
  assert.deepEqual([broken.status, (await broken.json()).error], [400, "bad_json"]);
});

test("log in: a long password written with combining accents is accepted when it is within the limit once normalized", async () => {
  const letters = "aeiouycnszlrwg";
  const long = Array.from({ length: 120 }, (_, i) => letters[(i * 5) % 14] + "́").join(""); // 240 code points typed, 120 characters after NFKC
  assert.ok(long.length > 128 && Array.from(long.normalize("NFKC")).length <= 128);
  const alice = await member(env, box, { via: "email", email: ALICE });
  const b = browser(env), c = browser(env, { ip: ip(31) });
  assert.equal((await login(b, ALICE, GOOD_PASSWORD)).status, 200);
  const r = await change(b, { current: GOOD_PASSWORD, password: long });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal((await login(c, ALICE, long)).status, 200, "it was good enough to set, so it is good enough to type");
  assert.equal((await login(browser(env, { ip: ip(32) }), ALICE, long.normalize("NFKC"))).status, 200, "and the same text composed differently is the same password");
  assert.ok(alice.b);
});

test("log in: signing in from a browser that holds a half-done sign-up ends it, and the old session of that browser is gone", async () => {
  const alice = await member(env, box, { via: "email", email: ALICE });
  const oldId = await sha256(alice.b.jar.get("vs"));
  const b = browser(env);
  await startSignup(b);
  await doWallet(b, await wallet()); // a pending wallet session as well
  assert.ok(b.has("vsu") && b.has("vs"));
  const pendingId = await sha256(b.jar.get("vs"));
  const r = await login(b, ALICE, GOOD_PASSWORD);
  assert.equal(r.status, 200);
  assert.match(r.headers.getSetCookie().find((c) => c.startsWith("vsu=")), /Max-Age=0$/);
  assert.equal(b.has("vsu"), false);
  assert.equal((await rows(env.DB, "SELECT id FROM signups")).length, 0);
  assert.equal(await one(env.DB, "SELECT id FROM sessions WHERE id = ?", pendingId), null, "the pending wallet session is gone, no fixation");
  assert.ok(await one(env.DB, "SELECT id FROM sessions WHERE id = ?", oldId), "another device's session is not touched");
  assert.equal((await b.get("/api/me")).user.hasPassword, true);
});

/* ---------------- guessing: counters before hashing, the attacker first ---------------- */

test("five wrong tries from one connection lock that connection out for that address (even with the right password), nobody else, and no hash is made once locked", async () => {
  await member(env, box, { via: "email", email: ALICE });
  await member(env, box, { via: "email", email: "bob@example.com" });
  const attacker = browser(env, { ip: ip(40) }), victim = browser(env, { ip: ip(41) });
  for (let i = 0; i < 5; i++) assert.equal((await login(attacker, ALICE, "wrong guess number " + i)).status, 401);
  const { out: locked, derives } = await derivesOf(async () => answer(await login(attacker, ALICE, GOOD_PASSWORD)));
  assert.deepEqual({ status: locked.status, body: locked.body, cookies: locked.cookies, derives }, { status: 429, body: { ok: false, error: "slow_down" }, cookies: [], derives: 0 });
  assert.equal(attacker.has("vs"), false);
  // the attacker's connection is not shut out from other addresses (the per-address pair counter is separate) ...
  assert.equal((await login(attacker, "bob@example.com", GOOD_PASSWORD)).status, 200);
  // ... and the owner, on another connection, still gets in
  assert.equal((await login(victim, ALICE, GOOD_PASSWORD)).status, 200);
  // the lock ends with the window
  advance(15 * 60_000 + 1000);
  assert.equal((await login(browser(env, { ip: ip(40) }), ALICE, GOOD_PASSWORD)).status, 200);
});

test("an attacker who keeps hammering from ONE connection is refused without using up the address: the owner still gets in", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const attacker = browser(env, { ip: ip(46) });
  const { out: statuses, derives } = await derivesOf(async () => {
    const out = [];
    for (let i = 0; i < 100; i++) out.push((await login(attacker, ALICE, "wrong guess number " + i)).status);
    return out;
  });
  assert.equal(statuses.filter((s) => s === 401).length, 5);
  assert.equal(statuses.filter((s) => s === 429).length, 95);
  assert.equal(derives, 5);
  assert.deepEqual((await countersLike("pwa")).map((r) => r.n), [5], "only the five that got through were counted on the address");
  assert.equal((await login(browser(env, { ip: ip(47) }), ALICE, GOOD_PASSWORD)).status, 200, "the owner is not shut out by one connection, however hard it hammers");
  // the same for the reset route: wrong codes from one connection, then the owner resets
  await startReset(browser(env, { ip: ip(48) }), ALICE);
  await setResetCode(ALICE);
  const guesser = browser(env, { ip: ip(49) });
  for (let i = 0; i < 100; i++) await reset(guesser, ALICE, String(100000 + i), NEW_PASSWORD);
  assert.deepEqual((await countersLike("rsa")).map((r) => r.n), [5]);
  assert.equal((await one(env.DB, "SELECT attempts FROM email_codes WHERE email = ?", resetKey(ALICE))).attempts, 5, "and only five ever reached the code");
  assert.equal((await reset(browser(env, { ip: ip(50) }), ALICE, "424242", NEW_PASSWORD)).status, 429, "the code itself is spent after five wrong tries (as for any e-mail code)");
});

test("an unknown address is locked exactly like a known one (the lock says nothing about the account)", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const run = async (email, where) => {
    const b = browser(env, { ip: where });
    const out = [];
    for (let i = 0; i < 7; i++) out.push((await login(b, email, "wrong guess number " + i)).status);
    out.push((await login(b, email, GOOD_PASSWORD)).status);
    return out;
  };
  const known = await run(ALICE, ip(42)), unknown = await run("nobody@example.com", ip(43));
  assert.deepEqual(known, [401, 401, 401, 401, 401, 429, 429, 429]);
  assert.deepEqual(unknown, known);
});

test("one connection gets 60 password tries in 15 minutes across all addresses, then nothing (and hashes nothing)", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(44) });
  const { out: statuses, derives } = await derivesOf(async () => {
    const out = [];
    for (let i = 0; i < 60; i++) out.push((await login(b, `someone${i}@example.com`, "wrong guess number " + i)).status);
    return out;
  });
  assert.ok(statuses.every((s) => s === 401));
  assert.equal(derives, 60);
  const { out: over, derives: more } = await derivesOf(async () => (await login(b, ALICE, GOOD_PASSWORD)).status);
  assert.deepEqual([over, more], [429, 0]);
  assert.equal((await login(browser(env, { ip: ip(45) }), ALICE, GOOD_PASSWORD)).status, 200, "another connection is fine");
});

test("the owner is shut out of the PASSWORD route only by an attack from three or more connections, only for the window, and keeps the e-mail code and the wallet", async () => {
  const alice = await member(env, box, { via: "email", email: ALICE });
  const attackers = [ip(50), ip(51), ip(52)].map((x) => browser(env, { ip: x }));
  for (const [k, a] of attackers.entries()) {
    for (let i = 0; i < 5; i++) assert.equal((await login(a, ALICE, `guess ${k} number ${i} here`)).status, 401);
    if (k === 1) assert.equal((await login(browser(env, { ip: ip(60) }), ALICE, GOOD_PASSWORD)).status, 200, "two attackers: the owner still gets in"); // 10 + the owner's own try, given back
  }
  const { out: shut, derives } = await derivesOf(async () => (await login(browser(env, { ip: ip(61) }), ALICE, GOOD_PASSWORD)).status);
  assert.deepEqual([shut, derives], [429, 0], "three attackers used up the address");
  // but the other ways in work: the e-mail code, and the wallet
  const viaCode = await codeLogin(ALICE, { ip: ip(61) });
  assert.equal((await viaCode.get("/api/me")).signedIn, true);
  const viaWallet = browser(env, { ip: ip(61) });
  assert.equal((await doWallet(viaWallet, alice.w)).next, "/dashboard");
  // and the reset route has its own counters
  assert.equal((await startReset(browser(env, { ip: ip(61) }), ALICE)).status, 200);
  advance(15 * 60_000 + 1000);
  assert.equal((await login(browser(env, { ip: ip(61) }), ALICE, GOOD_PASSWORD)).status, 200, "the window ended");
});

test("a person who gets it right never builds up a count: success gives its attempt back", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(62) });
  for (let i = 0; i < 4; i++) await login(b, ALICE, "wrong guess number " + i);
  assert.equal((await login(b, ALICE, GOOD_PASSWORD)).status, 200);
  for (const kind of ["pwi", "pwp", "pwa"]) assert.deepEqual((await countersLike(kind)).map((r) => r.n), [4], kind + ": 5 tries, 1 given back");
  await env.DB.prepare("DELETE FROM auth_limits").run();
  for (let i = 0; i < 30; i++) assert.equal((await login(b, ALICE, GOOD_PASSWORD)).status, 200, "try " + i);
  for (const kind of ["pwi", "pwp", "pwa"]) assert.deepEqual((await countersLike(kind)).map((r) => r.n), [0], kind);
});

test("61 guesses at once: at most 5 are ever hashed for one address from one connection", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const slow = { ...env, DB: slowDb(env.DB) };
  const { out: results, derives } = await derivesOf(() => Promise.all(Array.from({ length: 61 }, (_, i) => login(browser(slow, { ip: ip(70) }), ALICE, "wrong guess number " + i))));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 5);
  assert.equal(statuses.filter((s) => s === 429).length, 56);
  assert.equal(derives, 5, "only the first five ever reached the hash");
  assert.equal((await countersLike("pwp"))[0].n, 61, "every attempt was counted, atomically");
});

test("61 guesses at once from 13 connections: at most 15 are ever hashed for one address", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const slow = { ...env, DB: slowDb(env.DB) };
  const { out: results, derives } = await derivesOf(() => Promise.all(Array.from({ length: 61 }, (_, i) => login(browser(slow, { ip: ip(100 + (i % 13)) }), ALICE, "wrong guess number " + i))));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 15);
  assert.equal(statuses.filter((s) => s === 429).length, 46);
  assert.equal(derives, 15);
});

test("61 guesses at once from one connection at 61 different addresses: exactly 60 are hashed", async () => {
  const slow = { ...env, DB: slowDb(env.DB) };
  await browser(slow).get("/api/signup/state"); // tables and the counter salt exist before the race
  const { out: results, derives } = await derivesOf(() => Promise.all(Array.from({ length: 61 }, (_, i) => login(browser(slow, { ip: ip(71) }), `person${i}@example.com`, "wrong guess number " + i))));
  assert.equal(results.filter((r) => r.status === 401).length, 60);
  assert.equal(results.filter((r) => r.status === 429).length, 1);
  assert.equal(derives, 60);
});

test("the counters never contain an address, an IP or a password", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: "203.0.113.99" });
  await login(b, ALICE, "a wrong password here");
  await startReset(b, ALICE);
  await reset(b, ALICE, "123456", NEW_PASSWORD);
  const text = JSON.stringify(await rows(env.DB, "SELECT * FROM auth_limits"));
  for (const secret of [ALICE, "alice", "203.0.113", "a wrong password here", NEW_PASSWORD]) assert.ok(!text.includes(secret), secret);
  for (const { key } of await rows(env.DB, "SELECT key FROM auth_limits")) {
    assert.match(key, /^([a-z]+:[A-Za-z0-9_-]{22}|(pwp|rsp):[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{22}|sus:site)$/, key);
  }
});

/* ---------------- rehash: a stronger hash or a pepper arrives later ---------------- */

test("a hash made with fewer rounds, or before the pepper existed, is rewritten at the next good log-in; a wrong password rewrites nothing", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const hashOf = async () => (await userOf(ALICE)).password_hash;
  const first = await hashOf();
  assert.match(first, /^pbkdf2-sha256\$1000\$/);
  assert.equal((await login(browser(env, { ip: ip(80) }), ALICE, "the wrong password")).status, 401);
  assert.equal(await hashOf(), first);

  const stronger = { ...env, PASSWORD_ITERATIONS: "2000" };
  assert.equal((await login(browser(stronger, { ip: ip(81) }), ALICE, GOOD_PASSWORD)).status, 200);
  const second = await hashOf();
  assert.match(second, /^pbkdf2-sha256\$2000\$/);
  assert.equal((await verifyPassword(stronger, second, GOOD_PASSWORD)).ok, true);

  const peppered = { ...stronger, PASSWORD_PEPPER: "a-test-pepper-not-a-real-one" };
  assert.equal((await login(browser(peppered, { ip: ip(82) }), ALICE, GOOD_PASSWORD)).status, 200);
  const third = await hashOf();
  assert.match(third, /^pbkdf2-sha256\$2000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}\$p1$/);
  assert.equal((await login(browser(peppered, { ip: ip(83) }), ALICE, GOOD_PASSWORD)).status, 200);
  assert.equal(await hashOf(), third, "nothing left to upgrade");
  // the pepper is gone: a peppered hash fails CLOSED, with the same answer as any wrong password
  const logs = captureLogs();
  let r;
  try { r = await answer(await login(browser(stronger, { ip: ip(84) }), ALICE, GOOD_PASSWORD)); } finally { logs.restore(); }
  assert.deepEqual([r.status, r.body], [401, { ok: false, error: "bad_credentials" }]);
  assert.ok(logs.lines.includes("pepper missing"));
});

/* ---------------- reset: forgot it, or never had one ---------------- */

test("reset start: the same answer, the same database work and the same hashing for a known and an unknown address; only the known one is mailed", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const logA = [], logB = [], mailsBefore = box.sent.length;
  const spyA = { ...env, DB: spyDb(env.DB, logA) }, spyB = { ...env, DB: spyDb(env.DB, logB) };
  // each spy environment sets up its counter salt once: do that first, with another address
  await withoutRandom(async () => { await startReset(browser(spyA, { ip: ip(90) }), "warm.a@example.com"); await startReset(browser(spyB, { ip: ip(91) }), "warm.b@example.com"); });
  logA.length = 0; logB.length = 0;
  const known = await withoutRandom(() => derivesOf(async () => answer(await startReset(browser(spyA, { ip: ip(92) }), ALICE))));
  const unknown = await withoutRandom(() => derivesOf(async () => answer(await startReset(browser(spyB, { ip: ip(93) }), "nobody@example.com"))));
  assert.deepEqual(known, unknown);
  assert.deepEqual(known.out, { status: 200, body: { ok: true }, cookies: [] });
  assert.equal(known.derives, 0);
  assert.ok(logA.length >= 5, "the statements were recorded: " + logA.length);
  assert.deepEqual(logA, logB, "exactly the same SQL for both");
  const sent = box.sent.slice(mailsBefore).filter((m) => !m.to.startsWith("warm"));
  assert.deepEqual(sent.map((m) => [m.to, m.kind]), [[ALICE, "reset"]], "one mail, to the real account, saying it is a reset code");
  assert.match(sent[0].code, /^\d{6}$/);
  // both left a code row under the reset name, and neither touched the plain address (the sign-in code row)
  const keys = (await rows(env.DB, "SELECT email FROM email_codes ORDER BY email")).map((r) => r.email).filter((k) => !k.includes("warm"));
  assert.deepEqual(keys, [resetKey("nobody@example.com"), resetKey(ALICE)].sort());
});

test("reset start: with ctx.waitUntil the mail goes out after the answer (and ctx.waitUntil is called on ctx); an unknown address hands nothing over", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const before = box.sent.length;
  let release;
  const gate = new Promise((r) => { release = r; });
  const gated = async (url, init) => { if (String(url) === "https://api.resend.com/emails") await gate; return box.fetch(url, init); };
  const background = [];
  const ctx = { waitUntil(p) { assert.equal(this, ctx, "called as a method of ctx"); background.push(p); } };
  const r = await answer(await startReset(browser(env, { ip: ip(94) }), ALICE, { ctx, fetchImpl: gated }));
  assert.deepEqual([r.status, r.body], [200, { ok: true }], "answered while the mail is still on its way");
  assert.equal(background.length, 1);
  assert.equal(box.sent.length, before);
  release();
  await Promise.all(background);
  assert.equal(box.sent.length, before + 1);
  const u = await answer(await startReset(browser(env, { ip: ip(95) }), "nobody@example.com", { ctx, fetchImpl: gated }));
  assert.deepEqual([u.status, u.body], [200, { ok: true }]);
  assert.equal(background.length, 1, "nothing to send, nothing handed to waitUntil");
  assert.equal(box.sent.length, before + 1);
});

test("reset start: a mail that fails in the background gives the send slot back, and the answer was {ok:true} all the same", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const background = [], ctx = { waitUntil: (p) => background.push(p) };
  box.failing = true;
  const r = await answer(await startReset(browser(env, { ip: ip(96) }), ALICE, { ctx }));
  assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  await Promise.all(background);
  assert.equal((await one(env.DB, "SELECT last_sent_at FROM email_codes WHERE email = ?", resetKey(ALICE))).last_sent_at, null, "the slot is free again");
  box.failing = false;
  const again = await answer(await startReset(browser(env, { ip: ip(96) }), ALICE, { ctx }));
  assert.deepEqual([again.status, again.body], [200, { ok: true }], "no minute to wait after a mail that never left");
  await Promise.all(background);
  assert.equal(box.codeFor(ALICE).length, 6);
});

test("reset start: the refusals do not depend on the account: bad address, no mail service, too soon, per address, per connection", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(97) });
  for (const email of ["", "nope", "a@b", null, 5, "x y@example.com"]) {
    const r = await answer(await b.send("/api/auth/password/reset/start", { method: "POST", body: { email } }));
    assert.deepEqual([r.status, r.body], [400, { ok: false, error: "bad_email" }], JSON.stringify(email));
  }
  const noMail = V2({ RESEND_API_KEY: undefined });
  for (const email of [ALICE, "nobody@example.com"]) {
    const r = await answer(await startReset(browser(noMail, { ip: ip(98) }), email));
    assert.deepEqual([r.status, r.body], [503, { ok: false, error: "email_unavailable" }]);
  }
  // the same sequence of answers for the same series of requests, whether the address has an account or not
  const series = async (email, where) => {
    useClock("2026-10-01T12:00:00Z");
    const c = browser(env, { ip: where }), out = [];
    for (const wait of [0, 10_000, 60_000, 70_000, 10_000, 70_000, 70_000, 70_000]) {
      advance(wait);
      const r = await answer(await startReset(c, email));
      out.push(r.status === 200 ? "ok" : r.body.error);
    }
    return out;
  };
  const known = await series(ALICE, ip(99)), unknown = await series("nobody@example.com", ip(100));
  assert.deepEqual(known, unknown);
  assert.ok(["ok", "too_soon", "slow_down"].every((x) => known.includes(x)), known.join());
  // 20 mails an hour per connection, whatever the addresses
  useClock("2026-10-01T18:00:00Z");
  const busy = browser(env, { ip: ip(101) });
  let last;
  for (let i = 0; i < 21; i++) last = await startReset(busy, `person${i}@example.com`);
  assert.deepEqual([last.status, (await last.json()).error], [429, "slow_down"]);
  // 20 a day per address, shared with the sign-up route
  const key = await limitKey(env, "mail", "daily@example.com");
  await env.DB.prepare("INSERT INTO auth_limits (key, n, window_start) VALUES (?, 20, ?)").bind(key, new Date(Date.now()).toISOString()).run();
  const daily = await startReset(browser(env, { ip: ip(102) }), "daily@example.com");
  assert.deepEqual([daily.status, (await daily.json()).error], [429, "slow_down"]);
});

test("reset start: 30 requests at once for one address send ONE mail, and a known and an unknown address are treated alike", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const slow = { ...env, DB: slowDb(env.DB) };
  const flood = async (email) => {
    const before = box.sent.length;
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => startReset(browser(slow, { ip: ip(170 + i) }), email)));
    const tally = {};
    for (const r of results) { const a = await answer(r); const k = a.status === 200 ? "ok" : a.body.error; tally[k] = (tally[k] || 0) + 1; }
    return { tally, mails: box.sent.length - before };
  };
  const known = await flood(ALICE), unknown = await flood("nobody@example.com");
  assert.deepEqual(known.tally, { ok: 1, too_soon: 4, slow_down: 25 }, "one claim, four tries inside the minute, the rest over the per-address cap of 5 an hour");
  assert.deepEqual(unknown.tally, known.tally);
  assert.deepEqual([known.mails, unknown.mails], [1, 0]);
});

test("reset: the code, a good password, and the person is signed in with a new session; the code works once", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(110) });
  await startReset(b, ALICE);
  const code = box.codeFor(ALICE);
  const { out: r, derives } = await derivesOf(async () => reset(b, ALICE, code, NEW_PASSWORD));
  assert.equal(derives, 1, "one hash, only after the code was right");
  assert.deepEqual(await answer(r).then(({ status, body }) => ({ status, body })), { status: 200, body: { ok: true, next: "/dashboard" } });
  assert.match(r.headers.getSetCookie().find((c) => c.startsWith("vs=")), /Max-Age=2592000$/);
  const me = await b.get("/api/me");
  assert.deepEqual([me.signedIn, me.user.hasPassword, me.fresh], [true, true, false]);
  assert.equal((await sessionOf(b)).proven_at, null, "a reset does not prove the wallet");
  // the new password works and the old one does not
  assert.equal((await login(browser(env, { ip: ip(111) }), ALICE, NEW_PASSWORD)).status, 200);
  assert.equal((await login(browser(env, { ip: ip(112) }), ALICE, GOOD_PASSWORD)).status, 401);
  // the code is used up
  const again = await answer(await reset(browser(env, { ip: ip(113) }), ALICE, code, "yet another pass phrase"));
  assert.deepEqual([again.status, again.body], [400, { ok: false, error: "code_expired" }]);
  assert.equal(await one(env.DB, "SELECT email FROM email_codes WHERE email = ?", resetKey(ALICE)), null);
});

test("reset: a code is typed in any format (spaces, dashes) and an address in any case", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(114) });
  await startReset(b, "ALICE@example.com");
  const code = box.codeFor(ALICE);
  const r = await reset(b, " Alice@Example.com", code.slice(0, 3) + " " + code.slice(3), NEW_PASSWORD);
  assert.equal(r.status, 200);
});

test("reset: a refused password does not use up the code, and costs no hash and no attempt", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(115) });
  await startReset(b, ALICE);
  const code = box.codeFor(ALICE);
  const before = (await rows(env.DB, "SELECT key FROM auth_limits")).length;
  const cases = { password_short: "short1!", password_long: "x".repeat(129) + "q", password_common: "password123", password_is_email: "alice@example.com", bad_password: undefined };
  const { derives } = await derivesOf(async () => {
    for (const [error, password] of Object.entries(cases)) {
      const r = await answer(await reset(b, ALICE, code, password));
      assert.deepEqual([r.status, r.body], [400, { ok: false, error }], error);
    }
  });
  assert.equal(derives, 0);
  assert.equal((await one(env.DB, "SELECT attempts FROM email_codes WHERE email = ?", resetKey(ALICE))).attempts, 0, "the code was not even looked at");
  assert.equal((await rows(env.DB, "SELECT key FROM auth_limits")).length, before);
  assert.equal((await reset(b, ALICE, code, NEW_PASSWORD)).status, 200, "the same code still works with a good password");
  // the shape of the call
  for (const [body, error] of [[{ email: "nope", code, password: NEW_PASSWORD }, "bad_email"], [{ email: ALICE, code: "12", password: NEW_PASSWORD }, "bad_code"], [{ email: ALICE, password: NEW_PASSWORD }, "bad_code"]]) {
    const r = await answer(await b.send("/api/auth/password/reset", { method: "POST", body }));
    assert.deepEqual([r.status, r.body], [400, { ok: false, error }]);
  }
});

test("reset: a wrong code says how many tries are left, the sixth try is refused, and no hash is made", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(116) });
  await startReset(b, ALICE);
  await setResetCode(ALICE);
  const { out, derives } = await derivesOf(async () => {
    const seen = [];
    for (let i = 0; i < 6; i++) seen.push(await answer(await reset(b, ALICE, String(100000 + i), NEW_PASSWORD)));
    return seen;
  });
  assert.deepEqual(out.slice(0, 5).map((r) => [r.status, r.body.error, r.body.left]), [0, 1, 2, 3, 4].map((i) => [400, "code_wrong", 4 - i]));
  assert.deepEqual([out[5].status, out[5].body.error], [429, "slow_down"]);
  assert.equal(derives, 0);
  assert.equal((await one(env.DB, "SELECT attempts FROM email_codes WHERE email = ?", resetKey(ALICE))).attempts, 5);
  assert.equal((await login(browser(env, { ip: ip(117) }), ALICE, GOOD_PASSWORD)).status, 200, "the password did not change");
});

test("reset: 30 guesses at once reach the code at most five times", async () => {
  await member(env, box, { via: "email", email: ALICE });
  await startReset(browser(env, { ip: ip(118) }), ALICE);
  await setResetCode(ALICE);
  const slow = { ...env, DB: slowDb(env.DB) };
  const { out: results, derives } = await derivesOf(() => Promise.all(Array.from({ length: 30 }, (_, i) => reset(browser(slow, { ip: ip(119) }), ALICE, String(100000 + i), NEW_PASSWORD))));
  assert.equal(results.filter((r) => r.status === 400).length, 5);
  assert.equal(results.filter((r) => r.status === 429).length, 25);
  assert.equal((await one(env.DB, "SELECT attempts FROM email_codes WHERE email = ?", resetKey(ALICE))).attempts, 5);
  assert.equal(derives, 0);
});

test("reset: two requests with the right code at once: exactly one wins, one session is left, and it is the winner's password", async () => {
  await member(env, box, { via: "email", email: ALICE });
  await startReset(browser(env, { ip: ip(120) }), ALICE);
  const code = box.codeFor(ALICE), slow = { ...env, DB: slowDb(env.DB) };
  const passwords = ["the first pass phrase", "the second pass phrase"];
  const results = await Promise.all(passwords.map((p, i) => reset(browser(slow, { ip: ip(121 + i) }), ALICE, code, p)));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 400]);
  const winner = results.findIndex((r) => r.status === 200);
  assert.equal((await results[1 - winner].json()).error, "code_expired");
  const u = await userOf(ALICE);
  assert.equal((await verifyPassword(env, u.password_hash, passwords[winner])).ok, true);
  assert.equal((await verifyPassword(env, u.password_hash, passwords[1 - winner])).ok, false);
  assert.equal((await rows(env.DB, "SELECT id FROM sessions WHERE user_id = ?", u.id)).length, 1);
});

test("reset: success ends every other session of that person (and only theirs), and clears their attempt counters", async () => {
  const alice = await member(env, box, { via: "email", email: ALICE });
  const bob = await member(env, box, { via: "email", email: "bob@example.com" });
  const phone = browser(env, { ip: ip(130) }), laptop = browser(env, { ip: ip(131) });
  await login(phone, ALICE, GOOD_PASSWORD);
  await login(laptop, ALICE, GOOD_PASSWORD);
  for (const x of [alice.b, phone, laptop, bob.b]) assert.equal((await x.get("/api/me")).signedIn, true);
  // attacker tries have piled up on the log-in counters and on the reset counters
  const attacker = browser(env, { ip: ip(132) });
  for (let i = 0; i < 6; i++) await login(attacker, ALICE, "wrong guess number " + i);
  await login(attacker, "bob@example.com", "wrong guess number 1");
  assert.ok((await countersLike("pwp")).some((r) => r.n >= 5));

  const b = browser(env, { ip: ip(133) });
  await startReset(b, ALICE);
  assert.equal((await reset(b, ALICE, box.codeFor(ALICE), NEW_PASSWORD)).status, 200);
  for (const x of [alice.b, phone, laptop]) assert.equal((await x.get("/api/me")).signedIn, false, "an old session is over");
  assert.equal((await b.get("/api/me")).signedIn, true, "the new one works");
  assert.equal((await bob.b.get("/api/me")).signedIn, true, "someone else is untouched");
  assert.equal((await rows(env.DB, "SELECT id FROM sessions WHERE user_id = ?", (await userOf(ALICE)).id)).length, 1);
  // the counters of Alice's address are gone (log-in and reset kinds, every connection), Bob's stay
  const left = await rows(env.DB, "SELECT key FROM auth_limits WHERE key LIKE 'pw%' OR key LIKE 'rs%'");
  const pairs = left.filter((r) => r.key.startsWith("pwp:") || r.key.startsWith("pwa:"));
  assert.equal(pairs.length, 2, "Bob's address counter and Bob's pair counter remain: " + pairs.map((r) => r.key).join());
  assert.equal((await login(attacker, ALICE, NEW_PASSWORD)).status, 200, "the connection that had been locked out gets the route back");
});

test("reset: a person who forgot the password and got locked out can still use the code, with counters of its own", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(134) });
  for (let i = 0; i < 6; i++) await login(b, ALICE, "wrong guess number " + i);
  assert.equal((await login(b, ALICE, GOOD_PASSWORD)).status, 429, "locked out of the password route");
  assert.equal((await startReset(b, ALICE)).status, 200);
  assert.equal((await reset(b, ALICE, box.codeFor(ALICE), NEW_PASSWORD)).status, 200);
  assert.equal((await login(b, ALICE, NEW_PASSWORD)).status, 200);
});

test("reset: a code for one address never works for another, and the wrong try is counted against the address it was aimed at", async () => {
  await member(env, box, { via: "email", email: ALICE });
  await member(env, box, { via: "email", email: "bob@example.com" });
  const b = browser(env, { ip: ip(135) });
  await startReset(b, ALICE);
  await startReset(b, "bob@example.com");
  const [codeA, codeB] = [box.codeFor(ALICE), box.codeFor("bob@example.com")];
  assert.notEqual(codeA, codeB);
  const wrong = await answer(await reset(b, "bob@example.com", codeA, "mallory chose this one"));
  assert.deepEqual([wrong.status, wrong.body], [400, { ok: false, error: "code_wrong", left: 4 }]);
  assert.equal((await login(browser(env, { ip: ip(136) }), "bob@example.com", GOOD_PASSWORD)).status, 200, "Bob's password is unchanged");
  assert.equal((await one(env.DB, "SELECT attempts FROM email_codes WHERE email = ?", resetKey(ALICE))).attempts, 0, "Alice's code is untouched");
  assert.equal((await reset(b, ALICE, codeA, NEW_PASSWORD)).status, 200, "and works for Alice");
  // an address that never asked for a reset answers the same, with an account or without
  await member(env, box, { via: "email", email: "carol@example.com" });
  const carol = await answer(await reset(browser(env, { ip: ip(137) }), "carol@example.com", "123456", NEW_PASSWORD));
  const ghost = await answer(await reset(browser(env, { ip: ip(137) }), "never@example.com", "123456", NEW_PASSWORD));
  assert.deepEqual([carol.status, carol.body], [400, { ok: false, error: "code_expired" }]);
  assert.deepEqual([ghost.status, ghost.body], [carol.status, carol.body]);
});

test("reset: a sign-in code can never be a reset code, and a reset code can never sign anyone in", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(138) });
  assert.equal((await b.send("/api/auth/email/start", { method: "POST", body: { email: ALICE }, fetchImpl: box.fetch })).status, 200);
  const signinCode = box.last().code;
  assert.equal(box.last().kind, "signin");
  // 1. before any reset was asked for, the sign-in code finds nothing under the reset name
  const none = await answer(await reset(b, ALICE, signinCode, NEW_PASSWORD));
  assert.deepEqual([none.status, none.body.error], [400, "code_expired"]);
  // 2. after one was asked for, it is simply a wrong code
  await startReset(b, ALICE);
  assert.equal(box.last().kind, "reset");
  const resetCode = box.last().code;
  const wrong = await answer(await reset(b, ALICE, signinCode, NEW_PASSWORD));
  assert.deepEqual([wrong.status, wrong.body.error, wrong.body.left], [400, "code_wrong", 4]);
  // 3. the reset code does not sign in at the old route ...
  const noSignin = await answer(await b.send("/api/auth/email/verify", { method: "POST", body: { email: ALICE, code: resetCode } }));
  assert.deepEqual([noSignin.status, noSignin.body.error], [400, "code_wrong"]);
  assert.equal(b.has("vs"), false);
  // ... nor at the contact e-mail check of a signed-in person
  const carol = await member(env, box, { via: "email", email: "carol@example.com" });
  const contact = await carol.b.send("/api/me/contact/email/verify", { method: "POST", body: { email: ALICE, code: resetCode } });
  assert.equal(contact.status, 400);
  // 4. the sign-in code still signs in (nothing was spent), and the reset code still resets
  assert.equal((await b.send("/api/auth/email/verify", { method: "POST", body: { email: ALICE, code: signinCode } })).status, 200);
  assert.equal((await reset(browser(env, { ip: ip(139) }), ALICE, resetCode, NEW_PASSWORD)).status, 200);
});

test("reset: the name a reset code is filed under can never be a valid address, so no other route can ever reach it", () => {
  for (const email of ["alice@example.com", "a@b.co", "reset@alice@example.com", "x@y.zz", "reset:alice@example.com"]) {
    const key = resetKey(email);
    assert.equal(validEmail(key), false, key);
    assert.equal(validEmail(cleanEmail(key)), false);
    assert.notEqual(key, email);
  }
  assert.notEqual(resetKey("a@b.co"), resetKey("a@b.cc"));
  assert.equal(validEmail("reset@alice@example.com"), false, "so nobody can ask for a sign-in code under that name");
});

test("reset: an e-mail account that was made with a code and has no password yet gets its first password this way, and /api/me says so", async () => {
  const old = await legacy();
  assert.equal((await login(browser(env, { ip: ip(140) }), old.email, GOOD_PASSWORD)).status, 401, "no password yet");
  const b = browser(env, { ip: ip(141) });
  assert.equal((await startReset(b, old.email)).status, 200);
  assert.equal((await reset(b, old.email, box.codeFor(old.email), GOOD_PASSWORD)).status, 200);
  assert.equal((await b.get("/api/me")).user.hasPassword, true);
  assert.equal((await login(browser(env, { ip: ip(142) }), old.email, GOOD_PASSWORD)).status, 200);
  // the code way in still works for it
  assert.equal((await (await codeLogin(old.email, { ip: ip(143) })).get("/api/me")).signedIn, true);
});

test("reset: a half-done sign-up in the same browser ends, with its pending wallet session", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(144) });
  await startSignup(b);
  await doWallet(b, await wallet());
  const pending = await sha256(b.jar.get("vs"));
  await startReset(b, ALICE);
  const r = await reset(b, ALICE, box.codeFor(ALICE), NEW_PASSWORD);
  assert.equal(r.status, 200);
  assert.equal(b.has("vsu"), false);
  assert.equal((await rows(env.DB, "SELECT id FROM signups")).length, 0);
  assert.equal(await one(env.DB, "SELECT id FROM sessions WHERE id = ?", pending), null);
  assert.equal((await b.get("/api/me")).signedIn, true);
});

test("reset: an account that vanished after the code was sent answers no_account (the code is spent); a code nobody was mailed is a wrong code", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(145) });
  await startReset(b, ALICE);
  const code = box.codeFor(ALICE);
  await env.DB.prepare("DELETE FROM users WHERE provider_id = ?").bind(ALICE).run();
  const r = await answer(await reset(b, ALICE, code, NEW_PASSWORD));
  assert.deepEqual([r.status, r.body], [404, { ok: false, error: "no_account" }]);
  assert.equal(b.has("vs"), false);
  // an unknown address got a code row too, but nobody has the code: a guess is "wrong", exactly as for a known address
  await startReset(b, "ghost@example.com");
  const guess = await answer(await reset(b, "ghost@example.com", "111111", NEW_PASSWORD));
  assert.deepEqual([guess.status, guess.body], [400, { ok: false, error: "code_wrong", left: 4 }]);
});

/* ---------------- change it while signed in ---------------- */

test("change: only e-mail accounts have a password; a Google account answers no_email_login, a stranger sign_in, a foreign site wrong_origin", async () => {
  const gina = await member(env, box, { via: "google", sub: "g-gina" });
  const r = await answer(await change(gina.b, { password: NEW_PASSWORD }));
  assert.deepEqual([r.status, r.body], [403, { ok: false, error: "no_email_login" }]);
  assert.equal((await userOf("g-gina")).password_hash, null);
  const stranger = await answer(await change(browser(env), { password: NEW_PASSWORD }));
  assert.deepEqual([stranger.status, stranger.body], [401, { ok: false, error: "sign_in" }]);
  const alice = await member(env, box, { via: "email", email: ALICE });
  const before = (await userOf(ALICE)).password_hash;
  const foreign = await answer(await change(alice.b, { current: GOOD_PASSWORD, password: NEW_PASSWORD }, { origin: "https://evil.example" }));
  assert.deepEqual([foreign.status, foreign.body], [403, { ok: false, error: "wrong_origin" }]);
  assert.equal((await userOf(ALICE)).password_hash, before);
});

test("change: with the current password it works with no wallet proof, ends the OTHER sessions and keeps this one", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const here = browser(env, { ip: ip(150) }), other = browser(env, { ip: ip(151) });
  await login(here, ALICE, GOOD_PASSWORD);
  await login(other, ALICE, GOOD_PASSWORD);
  assert.equal((await here.get("/api/me")).fresh, false);
  const { out: r, derives } = await derivesOf(async () => answer(await change(here, { current: GOOD_PASSWORD, password: NEW_PASSWORD })));
  assert.deepEqual([r.status, r.body, derives], [200, { ok: true }, 2], "one hash to check the old, one to make the new");
  assert.equal((await here.get("/api/me")).signedIn, true);
  assert.equal((await other.get("/api/me")).signedIn, false);
  assert.equal((await login(browser(env, { ip: ip(152) }), ALICE, NEW_PASSWORD)).status, 200);
  assert.equal((await login(browser(env, { ip: ip(153) }), ALICE, GOOD_PASSWORD)).status, 401);
  // the answer carries no cookie and success gave the attempt back
  assert.deepEqual(r.cookies, []);
  assert.deepEqual((await countersLike("pwu")).map((x) => x.n), [0]);
});

test("change: a wrong current password is refused (bad_credentials) and changes nothing, even with a fresh wallet proof; a missing one needs the wallet", async () => {
  const alice = await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(154) });
  await login(b, ALICE, GOOD_PASSWORD);
  const p = { w: alice.w, ...b };
  const hash = (await userOf(ALICE)).password_hash;
  const wrong = await derivesOf(async () => answer(await change(b, { current: "not the current one", password: NEW_PASSWORD })));
  assert.deepEqual([wrong.out.status, wrong.out.body, wrong.derives], [401, { ok: false, error: "bad_credentials" }, 1]);
  const nothing = await derivesOf(async () => answer(await change(b, { password: NEW_PASSWORD })));
  assert.deepEqual([nothing.out.status, nothing.out.body, nothing.derives], [403, { ok: false, error: "reprove" }, 0]);
  assert.equal((await reprove(p)).ok, true);
  assert.equal((await b.get("/api/me")).fresh, true);
  const stillWrong = await answer(await change(b, { current: "not the current one", password: NEW_PASSWORD }));
  assert.deepEqual([stillWrong.status, stillWrong.body.error], [401, "bad_credentials"], "a typed current password has to be right");
  assert.equal((await userOf(ALICE)).password_hash, hash);
  for (const current of [12345, ["x"], { a: 1 }]) assert.equal((await change(b, { current, password: NEW_PASSWORD })).status, 401);
});

test("change: a fresh wallet proof alone is enough; an empty current counts as none", async () => {
  const alice = await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(155) });
  await login(b, ALICE, GOOD_PASSWORD);
  assert.equal((await reprove({ w: alice.w, ...b })).ok, true);
  const r = await derivesOf(async () => answer(await change(b, { current: "", password: NEW_PASSWORD })));
  assert.deepEqual([r.out.status, r.out.body, r.derives], [200, { ok: true }, 1]);
  assert.equal((await login(browser(env, { ip: ip(156) }), ALICE, NEW_PASSWORD)).status, 200);
});

test("change: a wallet proof that has run out (30 minutes) is not a proof", async () => {
  const alice = await member(env, box, { via: "email", email: ALICE }); // the journey's session still carries its wallet proof
  assert.equal((await alice.b.get("/api/me")).fresh, true);
  advance(31 * 60_000);
  assert.equal((await alice.b.get("/api/me")).fresh, false);
  const r = await answer(await change(alice.b, { password: NEW_PASSWORD }));
  assert.deepEqual([r.status, r.body.error], [403, "reprove"]);
});

test("change: a first password (the account has none) needs a fresh wallet proof, whatever else is sent", async () => {
  const old = await legacy();
  const b = await codeLogin(old.email, { ip: ip(157) });
  assert.equal((await b.get("/api/me")).user.hasPassword, false);
  for (const body of [{ password: NEW_PASSWORD }, { current: GOOD_PASSWORD, password: NEW_PASSWORD }, { current: "", password: NEW_PASSWORD }]) {
    const { out, derives } = await derivesOf(async () => answer(await change(b, body)));
    assert.deepEqual([out.status, out.body.error, derives], [403, "reprove", 0]);
  }
  assert.equal((await userOf(old.email)).password_hash, null);
  assert.equal((await reprove({ w: old.w, ...b })).ok, true);
  assert.equal((await change(b, { password: NEW_PASSWORD })).status, 200);
  assert.equal((await b.get("/api/me")).user.hasPassword, true);
  assert.equal((await login(browser(env, { ip: ip(158) }), old.email, NEW_PASSWORD)).status, 200);
});

test("change: the password rules answer with a code only, hash nothing and count nothing", async () => {
  const alice = await member(env, box, { via: "email", email: ALICE });
  const cases = { password_short: "short1!", password_long: "x".repeat(129) + "q", password_common: "password123", password_is_email: ALICE, bad_password: undefined };
  const { derives } = await derivesOf(async () => {
    for (const [error, password] of Object.entries(cases)) {
      const r = await answer(await change(alice.b, { current: GOOD_PASSWORD, password }));
      assert.deepEqual([r.status, r.body], [400, { ok: false, error }], error);
    }
  });
  assert.equal(derives, 0);
  assert.equal((await countersLike("pwu")).length, 0);
});

test("change: ten tries per person in 15 minutes, then slow_down without any hashing", async () => {
  const alice = await member(env, box, { via: "email", email: ALICE });
  const b = browser(env, { ip: ip(159) });
  await login(b, ALICE, GOOD_PASSWORD);
  void alice;
  for (let i = 0; i < 10; i++) assert.equal((await change(b, { current: "wrong current " + i, password: NEW_PASSWORD })).status, 401);
  const { out, derives } = await derivesOf(async () => answer(await change(b, { current: GOOD_PASSWORD, password: NEW_PASSWORD })));
  assert.deepEqual([out.status, out.body, derives], [429, { ok: false, error: "slow_down" }, 0]);
  advance(15 * 60_000 + 1000);
  assert.equal((await change(b, { current: GOOD_PASSWORD, password: NEW_PASSWORD })).status, 200);
});

/* ---------------- nothing leaks ---------------- */

test("no answer of the four routes (or of /api/me after them) carries a hash, a password, a code or a key named like one", async () => {
  await member(env, box, { via: "email", email: ALICE });
  const a = browser(env, { ip: ip(160) }), b = browser(env, { ip: ip(161) });
  const seenA = recordAnswers(a), seenB = recordAnswers(b);
  await login(a, ALICE, "a wrong password here");
  await login(a, ALICE, GOOD_PASSWORD);
  await a.get("/api/me");
  await change(a, { current: GOOD_PASSWORD, password: NEW_PASSWORD });
  await startReset(b, ALICE);
  const code = box.codeFor(ALICE);
  await reset(b, ALICE, "000000", "another pass phrase 1");
  await reset(b, ALICE, code, "another pass phrase 2");
  await b.get("/api/me");
  const all = [...seenA, ...seenB];
  assert.ok(all.length >= 8, "every answer was looked at");
  const scan = (o, path = "") => {
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { assert.ok(k === "hasPassword" || !/password|hash/i.test(k), `a key named ${path}.${k}`); scan(v, path + "." + k); }
    else if (typeof o === "string") assert.ok(!/pbkdf2/i.test(o), `a hash-like value at ${path}`);
  };
  for (const text of all) scan(JSON.parse(text));
  const text = all.join("\n");
  for (const secret of [GOOD_PASSWORD, NEW_PASSWORD, "another pass phrase", code, "pbkdf2", ALICE]) assert.ok(!text.includes(secret), "an answer contains " + secret);
});

test("nothing is logged: no address, password, code or hash, on any path of the four routes", async () => {
  const alice = await member(env, box, { via: "email", email: ALICE });
  const old = await legacy();
  const logs = captureLogs();
  try {
    const a = browser(env, { ip: ip(162) }), b = browser(env, { ip: ip(163) });
    await login(a, ALICE, "a wrong password here");
    await login(a, "nobody@example.com", "a wrong password here");
    await login(a, ALICE, GOOD_PASSWORD);
    await change(a, { current: GOOD_PASSWORD, password: NEW_PASSWORD });
    await change(a, { current: "wrong current password", password: "some other pass phrase" });
    await startReset(b, ALICE);
    await startReset(b, "nobody@example.com");
    box.failing = true;
    await startReset(browser(env, { ip: ip(164) }), old.email);
    box.failing = false;
    await reset(b, ALICE, "000000", "another pass phrase 1");
    await reset(b, ALICE, box.codeFor(ALICE), "another pass phrase 2");
    await login(browser({ ...env, PASSWORD_PEPPER: "x-pepper" }, { ip: ip(165) }), ALICE, "another pass phrase 2");
    await login(browser({ ...env, PASSWORD_ITERATIONS: "2000" }, { ip: ip(166) }), ALICE, "another pass phrase 2");
  } finally { logs.restore(); }
  const text = logs.lines.join("\n");
  for (const secret of [ALICE, "alice", "nobody", old.email, "legacy", GOOD_PASSWORD, NEW_PASSWORD, "a wrong password", "wrong current", "pass phrase", "pbkdf2", box.codeFor(ALICE), alice.w.address]) {
    assert.ok(!text.includes(secret), `a log line contains ${secret}`);
  }
});

test("the stored hash is the only trace of a password: not in any other table, the sign-up row or the counters", async () => {
  const j = browser(env);
  await journey(j, box, { via: "email", email: "dora@example.com", password: "dora's long pass phrase" });
  const b = browser(env, { ip: ip(167) });
  await login(b, "dora@example.com", "dora's long pass phrase");
  await change(b, { current: "dora's long pass phrase", password: NEW_PASSWORD });
  await startReset(b, "dora@example.com");
  await reset(b, "dora@example.com", box.codeFor("dora@example.com"), "dora's last pass phrase");
  const dump = await dumpAll(env.DB);
  for (const secret of ["dora's long pass phrase", NEW_PASSWORD, "dora's last pass phrase"]) assert.ok(!dump.includes(secret), secret);
  assert.equal((await rows(env.DB, "SELECT id FROM users WHERE password_hash IS NOT NULL")).length, 1);
  assert.equal((await rows(env.DB, "SELECT id FROM signups")).length, 0, "the sign-up row (it held the hash for a while) is gone");
});
