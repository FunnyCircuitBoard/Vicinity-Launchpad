// Launch-week hardening, sign-in side: attempt limits for the public chain-touching routes (src/guards.js) and the
// counter table they need (src/store.js, created lazily like the sign-up one); a signed message works once (src/signed.js).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { d1 } from "./helpers/d1.js";
import { slowDb } from "./helpers/slowdb.js";
import { prodDb, seedProd, PROD_TABLES, tablesOf, columnsOf, PROD_MIGRATION_IDS } from "./helpers/prod-schema.js";
import { LIMITS_MIGRATION, SIGNUP_MIGRATION, MIGRATIONS, ensureSchema, ensureLimitsSchema, ensureSignupSchema } from "../src/store.js";
import { PUBLIC_LIMITS, publicLimit } from "../src/guards.js";
import { checkSigned, readSigned } from "../src/signed.js";
import { buildMessage, statementFor } from "../src/solana.js";
import { HOST, ORIGIN, advance, browser, loginBody, newWorld, person, realClock, tick, useClock, wallet } from "./helpers/world.js";

after(() => realClock());

const T0 = Date.parse("2026-10-03T12:00:00Z");
const MIN = 60_000;
const ids = async (db) => (await db.prepare("SELECT id FROM schema_migrations ORDER BY id").all()).results.map((r) => r.id);
const req = (ip, path = "/api/verify") => new Request("https://vicinity.test" + path, { method: "POST", headers: ip ? { "cf-connecting-ip": ip } : {} });

/* ---------------- the counter table ---------------- */

test("the counter table is NOT a migration that runs on every request: MIGRATIONS is unchanged, ensureSchema alone never creates it", async () => {
  assert.deepEqual(MIGRATIONS.map((m) => m.id), PROD_MIGRATION_IDS);
  assert.ok(!MIGRATIONS.some((m) => m.id === LIMITS_MIGRATION.id));
  const db = await prodDb();
  await ensureSchema(db);
  assert.ok(!(await tablesOf(db)).includes("auth_limits"));
  assert.equal(LIMITS_MIGRATION.id, "2026-10-03-auth-limits");
});

test("the SQL: CREATE ... IF NOT EXISTS only, no semicolon inside a string or a comment, the same table the sign-up migration makes", () => {
  const sql = LIMITS_MIGRATION.sql;
  assert.ok(!/--|\/\*|'|"/.test(sql), "no comments and no strings at all, so a semicolon can only be a separator");
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 2);
  for (const s of statements) assert.match(s, /^CREATE (TABLE|INDEX) IF NOT EXISTS\b/);
  assert.ok(!/\b(DROP|DELETE|UPDATE|INSERT|ALTER|REPLACE|RENAME)\b/i.test(sql));
  // statement for statement the sign-up migration's version of the table, so either can run first
  const inSignup = SIGNUP_MIGRATION.sql.split(";").map((s) => s.trim()).filter((s) => /auth_limits/.test(s));
  assert.deepEqual(statements, inSignup);
});

test("ensureLimitsSchema on today's production: the table and index appear, nothing else changes, safe to repeat, recorded once", async () => {
  const db = await prodDb();
  await seedProd(db);
  const before = JSON.stringify((await db.prepare("SELECT * FROM users ORDER BY id").all()).results);
  await ensureLimitsSchema(db);
  await ensureLimitsSchema(db);
  await ensureLimitsSchema({ ...db }); // another server on the same database finds the record
  assert.deepEqual(await tablesOf(db), [...PROD_TABLES, "auth_limits"].sort());
  assert.deepEqual(await columnsOf(db, "auth_limits"), ["key", "n", "window_start"]);
  const idx = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'auth_limits_window'").all()).results;
  assert.equal(idx.length, 1);
  assert.equal(JSON.stringify((await db.prepare("SELECT * FROM users ORDER BY id").all()).results), before);
  assert.deepEqual(await ids(db), [...PROD_MIGRATION_IDS, LIMITS_MIGRATION.id].sort());
  assert.ok(!(await columnsOf(db, "users")).includes("password_hash"), "the sign-up migration did not run");
});

test("either order with the sign-up migration: both succeed, one table, both recorded", async () => {
  const a = await prodDb();
  await ensureLimitsSchema(a);
  await ensureSignupSchema(a);
  assert.deepEqual(await ids(a), [...PROD_MIGRATION_IDS, LIMITS_MIGRATION.id, SIGNUP_MIGRATION.id].sort());
  assert.deepEqual(await columnsOf(a, "auth_limits"), ["key", "n", "window_start"]);
  const b = await prodDb();
  await ensureSignupSchema(b);
  await ensureLimitsSchema(b);
  assert.deepEqual(await ids(b), [...PROD_MIGRATION_IDS, LIMITS_MIGRATION.id, SIGNUP_MIGRATION.id].sort());
  assert.deepEqual(await tablesOf(b), [...PROD_TABLES, "auth_limits", "signups"].sort());
  // two servers at the same moment
  const c = await prodDb();
  const r = await Promise.allSettled([ensureLimitsSchema(slowDb({ ...c })), ensureLimitsSchema(slowDb({ ...c })), ensureSignupSchema(slowDb({ ...c }))]);
  assert.deepEqual(r.map((x) => x.status), ["fulfilled", "fulfilled", "fulfilled"], JSON.stringify(r.map((x) => String(x.reason))));
  assert.equal((await c.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(LIMITS_MIGRATION.id).first("n")), 1);
});

test("a failure is not remembered: the next call runs the migration again; from an empty database it builds everything", async () => {
  const base = await prodDb();
  let armed = true;
  const db = { ...base, prepare: (sql) => {
    if (armed && /^CREATE TABLE IF NOT EXISTS auth_limits/.test(sql)) return { bind: () => ({ run: async () => { throw new Error("D1_ERROR: disk I/O error"); } }), run: async () => { throw new Error("D1_ERROR: disk I/O error"); } };
    return base.prepare(sql);
  } };
  await assert.rejects(ensureLimitsSchema(db), /disk I\/O/);
  await assert.rejects(ensureLimitsSchema(db), /disk I\/O/, "forgotten, so it tried again");
  assert.ok(!(await tablesOf(base)).includes("auth_limits"));
  armed = false;
  await ensureLimitsSchema(db);
  assert.ok((await tablesOf(base)).includes("auth_limits"));
  const empty = d1();
  await ensureLimitsSchema(empty);
  assert.ok((await tablesOf(empty)).includes("users") && (await tablesOf(empty)).includes("auth_limits"));
});

/* ---------------- publicLimit ---------------- */

test("the numbers: verify 30 and transfer 10 and pair 20 per 10 minutes, transfer check 60 per 10 minutes, rank 60 per minute", () => {
  assert.deepEqual(PUBLIC_LIMITS, {
    verify: { max: 30, windowMs: 10 * MIN }, transfer: { max: 10, windowMs: 10 * MIN }, transfer_check: { max: 60, windowMs: 10 * MIN },
    pair: { max: 20, windowMs: 10 * MIN }, rank: { max: 60, windowMs: MIN },
  });
  assert.rejects(publicLimit({ DB: d1() }, req("1.2.3.4"), "nothing"), /unknown public limit/);
});

test("one connection gets 30 verify attempts in 10 minutes, the 31st is a 429 slow_down; another connection is not affected", async () => {
  const env = newWorld({ LIMIT_SALT: "s" });
  for (let i = 0; i < 30; i++) assert.equal(await publicLimit(env, req("203.0.113.9"), "verify", T0 + i), null, `attempt ${i + 1}`);
  const slow = await publicLimit(env, req("203.0.113.9"), "verify", T0 + 30);
  assert.ok(slow instanceof Response);
  assert.equal(slow.status, 429);
  assert.deepEqual(await slow.json(), { ok: false, error: "slow_down" });
  assert.equal(slow.headers.get("Retry-After"), "600");
  assert.equal(slow.headers.get("Cache-Control"), "no-store");
  assert.equal(await publicLimit(env, req("203.0.113.10"), "verify", T0 + 31), null, "a different connection");
  assert.equal(await publicLimit(env, req("203.0.113.9"), "pair", T0 + 31), null, "a different kind of attempt");
  assert.equal(await publicLimit(env, req("2001:db8:1:2:3:4:5:6"), "verify", T0 + 31), null);
  assert.equal(await publicLimit(env, req("203.0.113.9"), "verify", T0 + 10 * MIN), null, "the window is over: a fresh start");
});

test("the attempt is counted before the work, and the counter is atomic: 70 parallel rank lookups let exactly 60 through", async () => {
  const env = newWorld({ LIMIT_SALT: "s" });
  await ensureLimitsSchema(env.DB);
  const slow = { ...env, DB: slowDb(env.DB) };
  const results = await Promise.all(Array.from({ length: 70 }, () => publicLimit(slow, req("198.51.100.7", "/api/rank"), "rank", T0)));
  assert.equal(results.filter((r) => r === null).length, 60);
  assert.equal(results.filter((r) => r && r.status === 429).length, 10);
  assert.equal(await publicLimit(env, req("198.51.100.7", "/api/rank"), "rank", T0 + MIN), null, "a minute later");
});

test("every kind has its own counter per connection, with its own maximum", async () => {
  const env = newWorld({ LIMIT_SALT: "s" });
  for (const [kind, spec] of Object.entries(PUBLIC_LIMITS)) {
    for (let i = 0; i < spec.max; i++) assert.equal(await publicLimit(env, req("192.0.2.1"), kind, T0 + i), null, `${kind} ${i + 1}`);
    assert.equal((await publicLimit(env, req("192.0.2.1"), kind, T0 + spec.max)).status, 429, kind);
  }
});

test("nothing identifying is stored: the counter rows hold a kind and an HMAC, never the address", async () => {
  const env = newWorld({ LIMIT_SALT: "s" });
  await publicLimit(env, req("203.0.113.77"), "verify", T0);
  await publicLimit(env, req("2001:db8:85a3:1:abcd:ef01:2345:6789"), "transfer", T0);
  const rows = (await env.DB.prepare("SELECT * FROM auth_limits").all()).results;
  assert.equal(rows.length, 2);
  for (const r of rows) assert.match(r.key, /^pub:[a-z_]+:[A-Za-z0-9_-]{22}$/, r.key);
  const dump = JSON.stringify(rows);
  for (const s of ["203.0.113", "2001:db8", "85a3", "abcd"]) assert.ok(!dump.includes(s), s);
});

test("a connection without a usable address shares the 'none' bucket (Cloudflare always sets the header in production)", async () => {
  const env = newWorld({ LIMIT_SALT: "s" });
  for (let i = 0; i < 30; i++) await publicLimit(env, req(null), "verify", T0 + i);
  assert.equal((await publicLimit(env, req(null), "verify", T0 + 30)).status, 429);
  assert.equal((await publicLimit(env, req("not an ip"), "verify", T0 + 31)).status, 429, "an unparsable header is the same bucket");
});

test("a database problem never blocks a public route: no database, a failing count, a failing table creation all answer null and log a short code", async () => {
  assert.equal(await publicLimit({}, req("1.2.3.4"), "verify"), null);
  assert.equal(await publicLimit(null, req("1.2.3.4"), "verify"), null);
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    const down = newWorld({ LIMIT_SALT: "s" });
    await ensureLimitsSchema(down.DB);
    down.DB = { ...down.DB, batch: async () => { throw new Error("D1_ERROR: network lost 203.0.113.9") } };
    assert.equal(await publicLimit(down, req("203.0.113.9"), "verify", T0), null);
    const broken = { LIMIT_SALT: "s", DB: { ...d1(), prepare: () => { throw new Error("D1 down"); } } };
    assert.equal(await publicLimit(broken, req("203.0.113.9"), "rank", T0), null);
  } finally { console.error = orig; }
  assert.equal(logged.length, 2);
  for (const l of logged) assert.match(l, /^public limit skipped (verify|rank) /);
});

/* ---------------- a signed message works once ---------------- */

const nonces = (env) => env.DB.prepare("SELECT nonce, expires_at FROM used_nonces ORDER BY nonce").all().then((r) => r.results);

test("wallet sign-in: the same signed message a second time is 409 replayed, a freshly signed one works; the row lives 11 minutes past signing", async () => {
  useClock("2026-10-03T12:00:00Z");
  const env = newWorld();
  const w = await wallet(), body = await loginBody(w);
  const first = await browser(env).send("/api/auth/wallet", { method: "POST", body });
  assert.equal((await first.json()).ok, true);
  const again = await browser(env).send("/api/auth/wallet", { method: "POST", body });
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { ok: false, error: "replayed" });
  assert.equal(again.headers.get("set-cookie"), null, "no session for a replay");
  assert.equal((await browser(env).post("/api/auth/wallet", await loginBody(w))).ok, true, "signing again is fine");
  const rows = await nonces(env);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.match(r.nonce, /^msg:[A-Za-z0-9_-]{43}$/, "a digest, not the message");
    assert.equal(r.expires_at, "2026-10-03T12:11:00.000Z");
    assert.ok(!r.nonce.includes(w.address.slice(0, 8)));
  }
});

test("re-proving and approving a phone sign-in are one-time too", async () => {
  useClock("2026-10-03T12:00:00Z");
  const env = newWorld();
  const a = await person(env);
  advance(31 * MIN);
  const body = await loginBody(a.w);
  assert.equal((await a.post("/api/auth/reprove", body)).ok, true);
  assert.equal((await a.post("/api/auth/reprove", body)).error, "replayed");
  assert.equal((await a.get("/api/me?lite=1")).fresh, true, "the first proof stands");

  const computer = browser(env), phone = browser(env);
  const start = await computer.post("/api/pair");
  const approve = { ...(await loginBody(a.w, start.pin)), pair: start.code };
  assert.equal((await phone.post("/api/auth/wallet", approve)).paired, true);
  assert.equal((await phone.post("/api/auth/wallet", approve)).error, "replayed");
  assert.equal((await computer.post("/api/pair/finish", { code: start.code })).status, "done");
});

test("a replay of a message that only failed later (wrong wallet) is still a replay; a message too old is 'expired' and leaves no row", async () => {
  useClock("2026-10-03T12:00:00Z");
  const env = newWorld();
  const a = await person(env), other = await wallet();
  const body = await loginBody(other);
  assert.equal((await a.post("/api/auth/reprove", body)).error, "wrong_wallet");
  assert.equal((await a.post("/api/auth/reprove", body)).error, "replayed");
  const old = await loginBody(other);
  advance(11 * MIN);
  const r = await browser(env).send("/api/auth/wallet", { method: "POST", body: old });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "expired");
  assert.equal((await nonces(env)).length, 2, "the sign-in and the wrong-wallet message are remembered, the expired one is not");
});

test("the scheduled job sweeps used messages once they could not be replayed anyway", async () => {
  useClock("2026-10-03T12:00:00Z");
  const env = newWorld();
  await browser(env).post("/api/auth/wallet", await loginBody(await wallet()));
  assert.equal((await nonces(env)).length, 1);
  advance(10 * MIN); await tick(env);
  assert.equal((await nonces(env)).length, 1, "still inside the 11 minutes");
  advance(2 * MIN); await tick(env);
  assert.equal((await nonces(env)).length, 0);
});

test("readSigned (the verify route) is one-time once it is handed the database, and exactly as before without it", async () => {
  useClock("2026-10-03T12:00:00Z");
  const env = newWorld();
  const w = await wallet();
  const message = buildMessage({ host: HOST, address: w.address, nonce: "abcdefghijklmnop1234", issuedAt: new Date(Date.now()).toISOString(), statement: statementFor("verify") });
  const body = JSON.stringify({ address: w.address, message, signature: await w.sign(message) });
  const req = () => new Request(ORIGIN + "/api/verify", { method: "POST", body });
  assert.equal((await readSigned(req(), Date.now(), ["verify"], "verified", undefined, env.DB)).parsed.action, "verify");
  const again = await readSigned(req(), Date.now(), ["verify"], "verified", undefined, env.DB);
  assert.equal(again.error.status, 409);
  assert.deepEqual(await again.error.json(), { verified: false, error: "replayed" });
  // without a database (today's wiring) nothing changes
  assert.equal((await readSigned(req(), Date.now(), ["verify"], "verified")).parsed.action, "verify");
  assert.equal((await readSigned(req(), Date.now(), ["verify"], "verified")).parsed.action, "verify");
});

test("two different messages that happen to share a nonce are both fine: it is the whole signed message that works once", async () => {
  useClock("2026-10-03T12:00:00Z");
  const env = newWorld();
  const w1 = await wallet(), w2 = await wallet();
  const mk = async (w) => { const message = buildMessage({ host: HOST, address: w.address, nonce: "samenoncesamenonce", issuedAt: new Date(Date.now()).toISOString(), statement: statementFor("login", {}) }); return { address: w.address, message, signature: await w.sign(message) }; };
  assert.equal((await browser(env).post("/api/auth/wallet", await mk(w1))).ok, true);
  assert.equal((await browser(env).post("/api/auth/wallet", await mk(w2))).ok, true);
  advance(1000);
  assert.equal((await browser(env).post("/api/auth/wallet", await mk(w1))).ok, true, "a second later: a different message");
});

test("when the used-message table cannot be written the message is accepted as before and a short code is logged (the session needs the same database anyway)", async () => {
  useClock("2026-10-03T12:00:00Z");
  const env = newWorld();
  const w = await wallet(), body = await loginBody(w);
  const bad = (error, status = 400) => ({ error: { error, status } });
  const request = new Request(ORIGIN + "/api/auth/wallet", { method: "POST" });
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    await ensureSchema(env.DB);
    const flaky = { ...env.DB, prepare: (sql) => { if (/used_nonces/.test(sql)) throw new Error("D1_ERROR: lost " + body.message.slice(0, 20)); return env.DB.prepare(sql); } };
    assert.equal((await checkSigned(body, request, Date.now(), ["login"], bad, flaky)).parsed.address, w.address);
    assert.equal((await checkSigned(body, request, Date.now(), ["login"], bad, flaky)).parsed.address, w.address);
  } finally { console.error = orig; }
  assert.equal(logged.length, 2);
  for (const l of logged) { assert.match(l, /^used message store failed /); assert.ok(!l.includes(w.address.slice(0, 6)), "never the address"); }
  // the real table works: the next use is a replay
  assert.equal((await checkSigned(body, request, Date.now(), ["login"], bad, env.DB)).parsed.address, w.address);
  assert.deepEqual((await checkSigned(body, request, Date.now(), ["login"], bad, env.DB)).error, { error: "replayed", status: 409 });
});
