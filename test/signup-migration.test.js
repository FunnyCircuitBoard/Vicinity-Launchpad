// Sign-up v2, database part: the new tables and columns arrive lazily, safely and only when asked for.
// Proven on the frozen production schema with real-looking members, and with a database that fails half-way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNUP_MIGRATION, MIGRATIONS, SCHEMA, ensureSchema, ensureSignupSchema } from "../src/store.js";
import { PROD_MIGRATION_IDS, PROD_TABLES, PROD_USERS_COLUMNS, PROD_HANDOFFS_COLUMNS, prodDb, seedProd, dumpTables, columnsOf, tablesOf } from "./helpers/prod-schema.js";
import { slowDb } from "./helpers/slowdb.js";
import { newWorld, browser, person, wallet, loginBody } from "./helpers/world.js";

const OLD_ROWS = { users: PROD_USERS_COLUMNS, sessions: ["id", "wallet", "user_id", "proof", "created_at", "expires_at", "proven_at"], handoffs: PROD_HANDOFFS_COLUMNS };
const ids = async (db) => (await db.prepare("SELECT id FROM schema_migrations ORDER BY id").all()).results.map((r) => r.id);

// ---- the frozen production schema cannot drift unnoticed ----

test("the frozen production schema matches src/store.js (a new migration must update test/helpers/prod-schema.js on purpose)", async () => {
  assert.deepEqual(MIGRATIONS.map((m) => m.id), PROD_MIGRATION_IDS,
    "src/store.js MIGRATIONS changed: record the new id in PROD_MIGRATION_IDS (and the new tables/columns) in test/helpers/prod-schema.js");
  assert.equal(MIGRATIONS.length, 7);
  assert.ok(!MIGRATIONS.some((m) => m.id === SIGNUP_MIGRATION.id), "the sign-up v2 migration must never be in MIGRATIONS (it runs only when SIGNUP_FLOW=v2)");
  const db = await prodDb();
  assert.deepEqual(await tablesOf(db), PROD_TABLES);
  assert.deepEqual(await columnsOf(db, "users"), PROD_USERS_COLUMNS);
  assert.deepEqual(await columnsOf(db, "handoffs"), PROD_HANDOFFS_COLUMNS);
  assert.deepEqual(await ids(db), [...PROD_MIGRATION_IDS].sort());
  // the same database the real ensureSchema() builds from nothing
  const real = (await import("./helpers/d1.js")).d1();
  await ensureSchema(real);
  assert.deepEqual(await tablesOf(real), PROD_TABLES);
  assert.deepEqual(await columnsOf(real, "users"), PROD_USERS_COLUMNS);
  assert.ok(SCHEMA.length > 0);
});

test("with the switch off nothing creates the sign-up tables: ensureSchema alone leaves production untouched", async () => {
  const db = await prodDb();
  await seedProd(db);
  const before = await dumpTables(db, OLD_ROWS);
  await ensureSchema(db);
  await ensureSchema(db);
  assert.equal(await dumpTables(db, OLD_ROWS), before);
  const tables = await tablesOf(db);
  assert.ok(!tables.includes("signups") && !tables.includes("auth_limits"));
  assert.ok(!(await columnsOf(db, "users")).includes("password_hash"));
  assert.ok(!(await columnsOf(db, "handoffs")).includes("signup_id"));
  assert.ok(!(await ids(db)).includes(SIGNUP_MIGRATION.id));
});

// ---- the SQL text ----

test("migration SQL: no semicolon inside a comment or a string (split() cuts on every semicolon)", () => {
  const sql = SIGNUP_MIGRATION.sql;
  let outside = 0, inside = 0, i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") { const e = sql.indexOf("\n", i); const end = e < 0 ? sql.length : e; inside += (sql.slice(i, end).match(/;/g) || []).length; i = end; continue; }
    if (c === "/" && sql[i + 1] === "*") { const e = sql.indexOf("*/", i + 2); const end = e < 0 ? sql.length : e + 2; inside += (sql.slice(i, end).match(/;/g) || []).length; i = end; continue; }
    if (c === "'" || c === '"' || c === "`") { const e = sql.indexOf(c, i + 1); const end = e < 0 ? sql.length : e + 1; inside += (sql.slice(i, end).match(/;/g) || []).length; i = end; continue; }
    if (c === ";") outside++;
    i++;
  }
  assert.equal(inside, 0, "a semicolon inside a comment or a string would silently corrupt the migration");
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, outside + 1, "the last statement has no trailing semicolon, every other one has exactly one");
  assert.equal(statements.length, 7);
  for (const s of statements) assert.match(s, /^(CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN)\b/, `unexpected statement: ${s.slice(0, 40)}`);
  assert.equal(SIGNUP_MIGRATION.id, "2026-10-03-signup-v2");
});

test("migration SQL touches only what the design lists (no DROP, no DELETE, no UPDATE, nothing on existing columns)", () => {
  const sql = SIGNUP_MIGRATION.sql;
  assert.ok(!/\b(DROP|DELETE|UPDATE|INSERT|REPLACE|RENAME)\b/i.test(sql));
  const alters = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+) ([A-Z]+)(.*)/g)].map((m) => [m[1], m[2], m[3], m[4].replace(/;/, "").trim()]);
  assert.deepEqual(alters, [["users", "password_hash", "TEXT", ""], ["handoffs", "signup_id", "TEXT", ""]], "only two nullable columns, no default, no constraint");
});

// ---- idempotent on the frozen production schema ----

test("ensureSignupSchema twice on production with two members: new tables and columns appear, every old row is untouched", async () => {
  const db = await prodDb();
  await seedProd(db);
  const before = await dumpTables(db, OLD_ROWS);
  const others = ["claims", "posts", "settings", "email_codes", "seats"].reduce((o, t) => ({ ...o, [t]: ["*"] }), {});
  const othersBefore = await dumpTables(db, others);

  await ensureSignupSchema(db);
  const afterOnce = await dumpTables(db, OLD_ROWS);
  assert.equal(afterOnce, before, "first run changes no existing row");
  await ensureSignupSchema(db);
  assert.equal(await dumpTables(db, OLD_ROWS), before, "second run changes no existing row");
  assert.equal(await dumpTables(db, others), othersBefore);

  assert.deepEqual(await tablesOf(db), [...PROD_TABLES, "auth_limits", "signups"].sort());
  assert.deepEqual(await columnsOf(db, "users"), [...PROD_USERS_COLUMNS, "password_hash"]);
  assert.deepEqual(await columnsOf(db, "handoffs"), [...PROD_HANDOFFS_COLUMNS, "signup_id"]);
  assert.deepEqual(await columnsOf(db, "signups"), ["id", "terms_version", "terms_at", "loc_city", "loc_name", "loc_country", "loc_choices", "loc_net", "loc_at", "provider", "provider_id", "identity_name", "identity_at", "pending_email", "pending_pw_hash", "created_at", "expires_at"]);
  assert.deepEqual(await columnsOf(db, "auth_limits"), ["key", "n", "window_start"]);

  const idx = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('signups_expires','auth_limits_window','handoffs_signup')").all()).results.map((r) => r.name).sort();
  assert.deepEqual(idx, ["auth_limits_window", "handoffs_signup", "signups_expires"]);
  const users = (await db.prepare("SELECT id, password_hash FROM users ORDER BY id").all()).results;
  assert.deepEqual(users, [{ id: 1, password_hash: null }, { id: 2, password_hash: null }]);
  assert.equal((await db.prepare("SELECT signup_id FROM handoffs WHERE id = 'hand-1'").first("signup_id")), null);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(SIGNUP_MIGRATION.id).first("n")), 1);
  assert.deepEqual(await ids(db), [...PROD_MIGRATION_IDS, SIGNUP_MIGRATION.id].sort());
});

test("ensureSignupSchema is memoized per database, and also safe when it has to run again (another server, lost memo, lost record)", async () => {
  const db = await prodDb();
  await seedProd(db);
  const p = ensureSignupSchema(db);
  assert.equal(ensureSignupSchema(db), p, "same promise for the same database");
  await p;
  // a fresh handle on the same database (a new worker instance) finds the record and does nothing
  const second = { ...db };
  await ensureSignupSchema(second);
  // the record lost (as if a crash happened after the last ALTER): all statements run again, duplicate columns are ignored
  await db.prepare("DELETE FROM schema_migrations WHERE id = ?").bind(SIGNUP_MIGRATION.id).run();
  const third = { ...db };
  await ensureSignupSchema(third);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(SIGNUP_MIGRATION.id).first("n")), 1);
  assert.deepEqual(await columnsOf(db, "users"), [...PROD_USERS_COLUMNS, "password_hash"]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM users").first("n")), 2);
});

test("two servers running the migration at the same moment both succeed", async () => {
  const db = await prodDb();
  await seedProd(db);
  const a = slowDb({ ...db }), b = slowDb({ ...db });
  const results = await Promise.allSettled([ensureSignupSchema(a), ensureSignupSchema(b)]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"], JSON.stringify(results.map((r) => String(r.reason))));
  assert.deepEqual(await columnsOf(db, "users"), [...PROD_USERS_COLUMNS, "password_hash"]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(SIGNUP_MIGRATION.id).first("n")), 1);
});

test("ensureSignupSchema also builds everything from an empty database (first install)", async () => {
  const { d1 } = await import("./helpers/d1.js");
  const db = d1();
  await ensureSignupSchema(db);
  assert.ok((await tablesOf(db)).includes("signups"));
  assert.ok((await columnsOf(db, "users")).includes("password_hash"));
  assert.deepEqual(await ids(db), [...PROD_MIGRATION_IDS, SIGNUP_MIGRATION.id].sort());
});

test("after the sign-up migration the rest of the site still works: ensureSchema, e-mail sign-in code for an existing member, wallet sign-up", async () => {
  const env = { ...newWorld({ RESEND_API_KEY: "rk-test" }), DB: await prodDb() };
  await seedProd(env.DB);
  await ensureSignupSchema(env.DB);
  await ensureSchema(env.DB);

  const sent = [];
  const mail = async (url, init) => { const body = JSON.parse(init.body); sent.push({ to: body.to[0], code: body.text.match(/code is (\d{6})/)[1] }); return new Response(JSON.stringify({ id: "re_1" })); };
  const b = browser(env);
  assert.equal((await b.send("/api/auth/email/start", { method: "POST", body: { email: "bea@example.com" }, fetchImpl: mail })).status, 200);
  const r = await b.send("/api/auth/email/verify", { method: "POST", body: { email: "bea@example.com", code: sent[0].code }, fetchImpl: mail });
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.next, "/dashboard");
  const me = await b.get("/api/me");
  assert.equal(me.signedIn, true);
  assert.equal(me.user.handle, "quiet-heron-22");
  assert.ok(!JSON.stringify(me).includes("password_hash"), "the new column never leaks through /api/me");

  const fresh = await person(env);
  assert.equal((await fresh.get("/api/me")).signedIn, true, "a brand new v1 account is created fine with the new column present");
});

// ---- the migration fails half-way: only the new sign-up may suffer ----

function faulty(db, log) {
  const state = { armed: true };
  const out = {
    ...db,
    prepare: (sql) => {
      if (state.armed && /^ALTER TABLE users ADD COLUMN password_hash/i.test(sql)) {
        log.push(sql);
        const failing = { sql, bind: () => failing, run: async () => { throw new Error("D1_ERROR: disk I/O error"); }, first: async () => { throw new Error("D1_ERROR: disk I/O error"); }, all: async () => { throw new Error("D1_ERROR: disk I/O error"); } };
        return failing;
      }
      return db.prepare(sql);
    },
  };
  return { db: out, state };
}

test("fault injection: a failing ALTER makes ensureSignupSchema reject, the site keeps working, and the next call retries", async () => {
  const base = await prodDb();
  await seedProd(base);
  const attempts = [];
  const { db, state } = faulty(base, attempts);
  const env = { ...newWorld(), DB: db };

  await assert.rejects(ensureSignupSchema(db), /disk I\/O error/);
  assert.equal(attempts.length, 1);
  // not remembered as done or as failed: the very next call tries again (and fails again while the fault lasts)
  await assert.rejects(ensureSignupSchema(db), /disk I\/O error/);
  assert.equal(attempts.length, 2, "the failed attempt was forgotten, so the second call ran the migration again");
  assert.equal((await base.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(SIGNUP_MIGRATION.id).first("n")), 0, "never recorded as applied");
  assert.ok(!(await columnsOf(base, "users")).includes("password_hash"));

  // everything that is not the new sign-up is unaffected
  const members = await browser(env).send("/api/members");
  assert.equal(members.status, 200);
  assert.equal((await members.json()).ok !== false, true);
  const w = await wallet();
  const login = await browser(env).post("/api/auth/wallet", await loginBody(w));
  assert.equal(login.ok, true);
  assert.equal(login.next, "social", "wallet sign-in answers exactly as before");
  const p = await person(env);
  assert.equal((await p.get("/api/me")).signedIn, true, "an existing-style v1 sign-up still creates an account");

  // the fault clears: the next call completes the migration
  state.armed = false;
  await ensureSignupSchema(db);
  assert.ok((await columnsOf(base, "users")).includes("password_hash"));
  assert.ok((await columnsOf(base, "handoffs")).includes("signup_id"));
  assert.equal((await base.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(SIGNUP_MIGRATION.id).first("n")), 1);
  assert.equal(ensureSignupSchema(db), ensureSignupSchema(db), "and now it is remembered");
  const users = (await base.prepare("SELECT COUNT(*) AS n FROM users").first("n"));
  assert.equal(users, 3, "the two seeded members and the one v1 sign-up are all still there");
});

test("fault injection: a failure in the record-keeping step also rejects and retries cleanly", async () => {
  const base = await prodDb();
  let armed = true, tries = 0;
  const db = { ...base, prepare: (sql) => {
    if (armed && /^INSERT OR IGNORE INTO schema_migrations/i.test(sql)) {
      const stmt = base.prepare(sql);
      return { sql, bind: (...p) => { const bound = stmt.bind(...p); return { ...bound, run: async () => { if (p[0] === SIGNUP_MIGRATION.id) { tries++; throw new Error("D1_ERROR: network lost"); } return bound.run(); } }; } };
    }
    return base.prepare(sql);
  } };
  await assert.rejects(ensureSignupSchema(db), /network lost/);
  assert.equal(tries, 1);
  armed = false;
  await ensureSignupSchema(db);
  assert.ok((await ids(base)).includes(SIGNUP_MIGRATION.id));
  assert.deepEqual(await columnsOf(base, "users"), [...PROD_USERS_COLUMNS, "password_hash"], "the columns that were added before the failure were not added twice");
});
