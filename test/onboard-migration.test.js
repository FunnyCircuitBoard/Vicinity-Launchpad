// Onboarding v3, database part: users.wallet becomes nullable through a ONE-TIME guarded rebuild of the users table (one D1 batch =
// one transaction), and pairs gets purpose + user_id. Proven on the frozen production schema (test/helpers/prod-schema.js) with the
// two lazy migrations live has run (sign-up v2, profiles), seeded with real-looking members, their sessions, a seat, posts and badges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIGRATIONS, ONBOARD_MIGRATION, PROFILES_MIGRATION, SCHEMA, SIGNUP_MIGRATION, ensureOnboardSchema, ensureSchema, ensureSignupSchema, walletOptionalStatements } from "../src/store.js";
import { PROD_MIGRATION_IDS, PROD_USERS_COLUMNS, columnsOf, prodDb, seedProd } from "./helpers/prod-schema.js";
import { d1 } from "./helpers/d1.js";
import { slowDb } from "./helpers/slowdb.js";

const split = (sql) => sql.split(";").map((s) => s.trim()).filter(Boolean);
const T = "2026-10-02T09:00:00.000Z";
const W1 = "W1Google1111111111111111111111111111111111111";

/** Production today: the frozen schema, the two lazy migrations live has run, two members, their sessions, a seat, posts and badges. */
async function liveDb() {
  const db = await prodDb();
  await seedProd(db);
  for (const m of [SIGNUP_MIGRATION, PROFILES_MIGRATION]) {
    for (const s of split(m.sql)) { try { await db.prepare(s).run(); } catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; } }
    await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(m.id, T).run();
  }
  await db.batch([
    db.prepare("UPDATE users SET badges = '[\"early\",\"verified\",\"local\"]', bio = 'Hello from Syracuse', password_hash = CASE WHEN provider = 'email' THEN 'pbkdf2$1000$salt$hash' END"),
    db.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES ('5140405', 'Syracuse', 'US', 1, ?, 5, 100000, 'active', ?, ?)").bind(W1, T, T),
    db.prepare("INSERT INTO posts (user_id, scope, place, country, kind, body, created_at) VALUES (1, 'city', '5140405', 'US', 'checkin', 'hello', ?)").bind(T),
    db.prepare("INSERT INTO posts (user_id, scope, place, country, kind, body, created_at) VALUES (2, 'country', 'US', 'US', 'talk', 'hi', ?)").bind(T),
    db.prepare("INSERT INTO pairs (id, pin, created_at, expires_at) VALUES ('pair-old', '42', ?, ?)").bind(T, "2026-11-01T09:00:00.000Z"),
  ]);
  return db;
}
const raw = (db) => db._raw;
const picture = (db) => ({
  usersSql: raw(db).prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().sql,
  indexes: raw(db).prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' AND sql IS NOT NULL ORDER BY name").all().map((i) => i.name),
  users: raw(db).prepare("SELECT * FROM users ORDER BY id").all(),
  seq: raw(db).prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get(),
  cols: raw(db).prepare("PRAGMA table_info(users)").all().map((c) => c.name),
  notnull: raw(db).prepare("PRAGMA table_info(users)").all().find((c) => c.name === "wallet").notnull,
  sessions: raw(db).prepare("SELECT * FROM sessions ORDER BY id").all(),
  seats: raw(db).prepare("SELECT * FROM seats ORDER BY id").all(),
  posts: raw(db).prepare("SELECT * FROM posts ORDER BY id").all(),
  handoffs: raw(db).prepare("SELECT * FROM handoffs ORDER BY id").all(),
  pairs: raw(db).prepare("SELECT id, pin, wallet, created_at, expires_at FROM pairs ORDER BY id").all(),
  migrations: raw(db).prepare("SELECT id FROM schema_migrations ORDER BY id").all().map((r) => r.id),
});
const recorded = async (db) => Number((await db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(ONBOARD_MIGRATION.id).first()).n);

test("the frozen production schema is untouched by this change: MIGRATIONS still has the 8 shipped entries (the expiry indexes of 9 Oct are the eighth), the onboarding one is lazy", () => {
  assert.equal(MIGRATIONS.length, 8);
  assert.deepEqual(MIGRATIONS.map((m) => m.id), PROD_MIGRATION_IDS);
  assert.ok(!MIGRATIONS.some((m) => m.id === ONBOARD_MIGRATION.id), "never in MIGRATIONS: it must only run on a v2 sign-up / wallet-link request");
  assert.equal(ONBOARD_MIGRATION.id, "2026-10-09-wallet-optional");
  assert.deepEqual(ONBOARD_MIGRATION.pairs, ["ALTER TABLE pairs ADD COLUMN purpose TEXT", "ALTER TABLE pairs ADD COLUMN user_id INTEGER"]);
});

test("live: users is rebuilt once with wallet nullable: every row, id, column, index, session, seat, post and the id counter kept; pairs gets two columns", async () => {
  const db = await liveDb();
  const before = picture(db);
  assert.equal(before.notnull, 1, "live today: wallet NOT NULL");
  assert.deepEqual(before.cols, [...PROD_USERS_COLUMNS, "password_hash", "bio"]);
  assert.equal(before.users.length, 2);

  const logs = [];
  const log = console.log; console.log = (...a) => logs.push(a.join(" "));
  try { await ensureOnboardSchema(db); } finally { console.log = log; }
  const after = picture(db);
  assert.equal(after.notnull, 0, "wallet is nullable now");
  assert.deepEqual(after.users, before.users, "every users row, every value, every id");
  assert.deepEqual(after.cols, before.cols, "column list and order");
  assert.deepEqual(after.indexes, before.indexes, "the same index names (users_home, users_country, users_handle_unique, and the autoindexes)");
  assert.deepEqual(after.indexes.filter((n) => !n.startsWith("sqlite_")).sort(), ["users_country", "users_handle_unique", "users_home"]);
  assert.deepEqual(after.seq, before.seq, "sqlite_sequence(users) carried over");
  assert.deepEqual(after.sessions, before.sessions);
  assert.deepEqual(after.seats, before.seats);
  assert.deepEqual(after.posts, before.posts);
  assert.deepEqual(after.handoffs, before.handoffs);
  assert.deepEqual(after.pairs, before.pairs, "the old pair row reads as before");
  assert.deepEqual(await columnsOf(db, "pairs"), ["id", "pin", "wallet", "created_at", "expires_at", "purpose", "user_id"]);
  assert.equal((await db.prepare("SELECT purpose, user_id FROM pairs WHERE id = 'pair-old'").first()).purpose, null, "an old row is a login pair (NULL purpose)");
  assert.deepEqual(after.migrations, [...before.migrations, ONBOARD_MIGRATION.id].sort());
  assert.equal(await recorded(db), 1);
  assert.match(after.usersSql, /\bwallet\s+TEXT\s+UNIQUE\b/);
  assert.ok(!/NOT NULL UNIQUE/.test(after.usersSql.split("\n").find((l) => /\bwallet\b/.test(l))), "the NOT NULL is gone from the wallet line only");
  assert.ok(/provider\s+TEXT\s+NOT NULL/.test(after.usersSql), "the other constraints stay");
  assert.ok((await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users_new'").first()) === null, "no users_new left behind");
  assert.ok(logs.some((l) => /users rebuilt: wallet optional rows=2/.test(l)), "one log line says what happened (no identifiers)");
  assert.ok(!logs.some((l) => l.includes(W1)));

  // behaviour: two NULL wallets coexist, a duplicate real wallet / provider id / handle (any case) is refused, ids keep counting
  raw(db).prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (NULL, 'google', 'g-3', 'nowallet-a', 't')").run();
  raw(db).prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (NULL, 'google', 'g-4', 'nowallet-b', 't')").run();
  assert.equal(raw(db).prepare("SELECT MAX(id) AS m FROM users").get().m, 4);
  for (const [sql, why] of [
    [`INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES ('${W1}', 'google', 'g-5', 'dup-wallet', 't')`, "wallet UNIQUE"],
    ["INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (NULL, 'google', 'google-sub-1', 'dup-provider', 't')", "UNIQUE (provider, provider_id)"],
    ["INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (NULL, 'google', 'g-6', 'NOWALLET-A', 't')", "users_handle_unique (case-insensitive)"],
  ]) assert.throws(() => raw(db).prepare(sql).run(), /UNIQUE/, why);
  // the link statement (src/walletlink.js): binds a wallet to an account that has none, refuses one another account owns, is idempotent
  const link = raw(db).prepare("UPDATE users SET wallet = ?1 WHERE id = ?2 AND wallet IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE wallet = ?1)");
  assert.equal(link.run("W9New111111111111111111111111111111111111111", 3).changes, 1);
  assert.equal(link.run("W9New111111111111111111111111111111111111111", 3).changes, 0, "already linked");
  assert.equal(link.run(W1, 4).changes, 0, "a taken wallet is refused");
  // SCHEMA's CREATE TABLE IF NOT EXISTS users (… NOT NULL …) on the next cold start is a no-op
  await ensureSchema({ ...db });
  raw(db).exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, provider_id TEXT NOT NULL, created_at TEXT NOT NULL)");
  assert.equal(picture(db).notnull, 0, "still nullable after SCHEMA ran again");
});

test("the AUTOINCREMENT counter: an id a deleted account once had is never given out again after the rebuild", async () => {
  const db = await liveDb();
  // the admin test lab seeds users and deletes them again: live's counter is ahead of MAX(id)
  raw(db).prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES ('WTest111111111111111111111111111111111111111', 'testlab', 'seed-1', '@testlab1', 't')").run();
  raw(db).prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES ('WTest211111111111111111111111111111111111111', 'testlab', 'seed-2', '@testlab2', 't')").run();
  raw(db).prepare("DELETE FROM users WHERE provider = 'testlab'").run();
  assert.equal(raw(db).prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get().seq, 4);
  assert.equal(raw(db).prepare("SELECT MAX(id) AS m FROM users").get().m, 2);
  await ensureOnboardSchema(db);
  assert.equal(raw(db).prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get().seq, 4, "the counter survived the rebuild");
  const r = raw(db).prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (NULL, 'google', 'g-new', 'brand-new', 't')").run();
  assert.equal(Number(r.lastInsertRowid), 5, "the next account gets a fresh id, not a deleted one's");
});

test("idempotent: a second call (and a second server with a lost memo) changes nothing and records nothing twice", async () => {
  const db = await liveDb();
  const p = ensureOnboardSchema(db);
  assert.equal(ensureOnboardSchema(db), p, "same promise for the same database");
  await p;
  const once = picture(db);
  await ensureOnboardSchema({ ...db }); // a fresh handle: finds the record
  assert.deepEqual(picture(db), once);
  await ensureOnboardSchema(db);
  assert.deepEqual(picture(db), once);
  assert.equal(await recorded(db), 1);
});

test("two servers running it at the same moment both succeed, and the table is rebuilt once", async () => {
  const db = await liveDb();
  const before = picture(db);
  const a = slowDb({ ...db }), b = slowDb({ ...db });
  const results = await Promise.allSettled([ensureOnboardSchema(a), ensureOnboardSchema(b)]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"], JSON.stringify(results.map((r) => String(r.reason))));
  const after = picture(db);
  assert.equal(after.notnull, 0);
  assert.deepEqual(after.users, before.users);
  assert.equal(await recorded(db), 1);
});

test("already nullable (a fresh database built after a later SCHEMA change): only the record is written, no rebuild", async () => {
  const db = await liveDb();
  await ensureOnboardSchema(db);
  await db.prepare("DELETE FROM schema_migrations WHERE id = ?").bind(ONBOARD_MIGRATION.id).run(); // the record lost (a crash right after the batch)
  const before = picture(db);
  let rebuilds = 0;
  const spy = { ...db, batch: async (l) => { if (l.some((s) => /^DROP TABLE users$/.test(s.sql))) rebuilds++; return db.batch(l); } };
  await ensureOnboardSchema(spy);
  assert.equal(rebuilds, 0, "no rebuild batch");
  assert.deepEqual({ ...picture(db), migrations: null }, { ...before, migrations: null });
  assert.equal(await recorded(db), 1);
});

test("from an empty database (first install): ensureSchema's users (no password_hash, no bio yet) is rebuilt fine, and the later ALTERs still add their columns", async () => {
  const db = d1();
  await ensureSchema(db);
  await ensureOnboardSchema(db);
  assert.equal(picture(db).notnull, 0);
  assert.deepEqual(await columnsOf(db, "users"), [...PROD_USERS_COLUMNS, "password_hash"], "ensureSignupSchema ran first (password_hash), profiles not yet");
  for (const s of split(PROFILES_MIGRATION.sql)) { try { await db.prepare(s).run(); } catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; } }
  assert.deepEqual(await columnsOf(db, "users"), [...PROD_USERS_COLUMNS, "password_hash", "bio"]);
  assert.deepEqual(picture(db).indexes.filter((n) => !n.startsWith("sqlite_")).sort(), ["users_country", "users_handle_unique", "users_home"]);
  raw(db).prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (NULL, 'google', 'g-1', 'first', 't')").run();
  assert.equal(raw(db).prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
});

test("a users table that is not the shape this expects is refused: nothing touched, nothing recorded, the error says so", async () => {
  // a database whose users table was made by hand with another constraint (no UNIQUE on wallet): the CREATE TABLE text does not match
  const db = d1();
  const odd = SCHEMA.replace("wallet       TEXT NOT NULL UNIQUE,", "wallet       TEXT NOT NULL,");
  assert.notEqual(odd, SCHEMA);
  await db.batch(split(odd).map((s) => db.prepare(s)));
  await ensureSchema(db); // CREATE TABLE IF NOT EXISTS: the odd users table stays
  await ensureSignupSchema(db); // (runs first inside ensureOnboardSchema too: password_hash is added before the shape is looked at)
  raw(db).prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES ('W', 'google', 'g-1', 'one', 't')").run();
  const before = picture(db);
  await assert.rejects(ensureOnboardSchema(db), /unexpected users shape/);
  const after = picture(db);
  assert.deepEqual({ ...after, migrations: null }, { ...before, migrations: null }, "users untouched");
  assert.equal(after.notnull, 1);
  assert.equal(await recorded(db), 0);
  assert.ok(raw(db).prepare("SELECT name FROM sqlite_master WHERE name = 'users_new'").get() === undefined);
  // the pure function refuses the same shapes
  assert.throws(() => walletOptionalStatements("CREATE TABLE users (id INTEGER PRIMARY KEY, wallet TEXT NOT NULL, provider TEXT)", ["id", "wallet", "provider"], T), /unexpected users shape/);
  assert.throws(() => walletOptionalStatements("CREATE TABLE members (id INTEGER PRIMARY KEY, wallet TEXT NOT NULL UNIQUE)", ["id", "wallet"], T), /unexpected users shape/);
  assert.throws(() => walletOptionalStatements("", ["id"], T), /unexpected users shape/);
});

test("walletOptionalStatements: the exact statements, in order, built only from the live CREATE TABLE text and the column list", () => {
  const sql = "CREATE TABLE users (\n  id           INTEGER PRIMARY KEY AUTOINCREMENT,\n  wallet       TEXT NOT NULL UNIQUE,\n  provider     TEXT NOT NULL,\n  created_at   TEXT NOT NULL, password_hash TEXT, bio TEXT\n)";
  const s = walletOptionalStatements(sql, ["id", "wallet", "provider", "created_at", "password_hash", "bio"], T);
  assert.equal(s[0], "CREATE TABLE users_new (\n  id           INTEGER PRIMARY KEY AUTOINCREMENT,\n  wallet TEXT UNIQUE,\n  provider     TEXT NOT NULL,\n  created_at   TEXT NOT NULL, password_hash TEXT, bio TEXT\n)");
  assert.equal(s[1], "INSERT INTO users_new (id, wallet, provider, created_at, password_hash, bio) SELECT id, wallet, provider, created_at, password_hash, bio FROM users");
  assert.match(s[2], /^INSERT INTO sqlite_sequence/); assert.match(s[3], /^UPDATE sqlite_sequence/);
  assert.equal(s[4], "DROP TABLE users");
  assert.equal(s[5], "ALTER TABLE users_new RENAME TO users");
  assert.deepEqual(s.slice(6, 9), ONBOARD_MIGRATION.indexes);
  assert.deepEqual(s[9], { sql: "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)", params: [ONBOARD_MIGRATION.id, T] });
  assert.equal(s.length, 10);
  // the IF NOT EXISTS form (a database built by SCHEMA keeps that text) is handled too
  assert.match(walletOptionalStatements("CREATE TABLE IF NOT EXISTS users (\n  wallet       TEXT NOT NULL UNIQUE\n)", ["wallet"], T)[0], /^CREATE TABLE users_new \(/);
});

/** A database whose batch fails on the statement that matches `re` (the transaction rolls back, like D1). */
function failingBatch(db, re, log) {
  const state = { armed: true };
  const out = { ...db, batch: async (list) => {
    if (state.armed && list.some((s) => re.test(s.sql))) { log.push("batch"); throw new Error("D1_ERROR: disk I/O error"); }
    return db.batch(list);
  } };
  return { db: out, state };
}

test("fault injection: the batch fails: the old table is exactly as it was, nothing is recorded, the memo is forgotten, and the next call succeeds", async () => {
  const base = await liveDb();
  const before = picture(base);
  const tries = [];
  const { db, state } = failingBatch(slowDb(base), /^DROP TABLE users$/, tries);
  await assert.rejects(ensureOnboardSchema(db), /disk I\/O error/);
  assert.equal(tries.length, 1);
  await assert.rejects(ensureOnboardSchema(db), /disk I\/O error/);
  assert.equal(tries.length, 2, "the failed attempt was forgotten: the second call ran again");
  const during = picture(base);
  assert.deepEqual({ ...during, migrations: null }, { ...before, migrations: null }, "users untouched (still NOT NULL, same rows, same indexes)");
  assert.equal(during.notnull, 1);
  assert.equal(await recorded(base), 0, "never recorded");
  assert.ok(raw(base).prepare("SELECT name FROM sqlite_master WHERE name = 'users_new'").get() === undefined, "no half-made table");
  // (pairs' ALTERs ran before the batch and are harmless to repeat: the columns are simply there)
  assert.deepEqual(await columnsOf(base, "pairs"), ["id", "pin", "wallet", "created_at", "expires_at", "purpose", "user_id"]);
  state.armed = false;
  await ensureOnboardSchema(db);
  const after = picture(base);
  assert.equal(after.notnull, 0);
  assert.deepEqual(after.users, before.users);
  assert.deepEqual(after.seq, before.seq);
  assert.equal(await recorded(base), 1);
});

test("a real failure inside the transaction (a UNIQUE clash while copying) rolls everything back: SQLite keeps the old users", async () => {
  const base = await liveDb();
  const before = picture(base);
  // make the copy itself fail: a users_new that already exists with a conflicting row would need the CREATE to fail first, so inject at the INSERT instead
  const db = { ...base, batch: async (list) => base.batch(list.map((s) => (/^INSERT INTO users_new/.test(s.sql) ? base.prepare("INSERT INTO users_new (id, wallet, provider, provider_id, created_at) SELECT id, 'same', provider, provider_id, created_at FROM users") : s))) };
  await assert.rejects(ensureOnboardSchema(db), /UNIQUE/);
  const after = picture(base);
  assert.deepEqual({ ...after, migrations: null }, { ...before, migrations: null });
  assert.equal(after.notnull, 1);
  assert.equal(await recorded(base), 0);
});

test("the sign-up migration still runs first (users.password_hash and handoffs.signup_id exist before the rebuild), and its record stays", async () => {
  const db = await prodDb();
  await seedProd(db);
  await ensureOnboardSchema(db);
  assert.ok((await columnsOf(db, "users")).includes("password_hash"));
  assert.ok((await columnsOf(db, "handoffs")).includes("signup_id"));
  assert.ok((await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(SIGNUP_MIGRATION.id).first()) !== null);
  assert.equal(picture(db).notnull, 0);
  assert.deepEqual(picture(db).users.map((u) => u.id), [1, 2]);
  await ensureSignupSchema(db); // memoized: nothing to do
});
