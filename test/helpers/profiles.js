// Helpers for the member-profile tests (PROFILES=on): a world with the switch on, members with chosen usernames, and a few
// readers of the database. Everything else (people, browsers, the clock) is test/helpers/world.js.
import assert from "node:assert/strict";
import { IN_UTICA, browser, clock, newWorld, person, wallet } from "./world.js";
import { SESSION_COOKIE, SESSION_SECONDS, createSession } from "../../src/auth.js";
import { ensureProfilesSchema, ensureSchema } from "../../src/store.js";

/** A test world with member profiles switched on. */
export const PF = (extra = {}) => newWorld({ PROFILES: "on", ...extra });

/** A signed-in member (wallet + Google) whose username is `handle` (set directly, so tests can name people and test case-insensitivity). */
export async function pfPerson(env, handle, opts = {}) {
  const p = await person(env, opts);
  await env.DB.prepare("UPDATE users SET handle = ? WHERE wallet = ?").bind(handle, p.w.address).run();
  p.handle = handle;
  return p;
}

/** Several members named after `names`, all living in Utica. */
export async function crowd(env, names, opts = { home: IN_UTICA }) {
  const out = [];
  for (const n of names) out.push(await pfPerson(env, n, opts));
  return out;
}

export const rows = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
export const one = (db, sql, ...params) => db.prepare(sql).bind(...params).first();
export const idOf = async (db, handle) => (await one(db, "SELECT id FROM users WHERE handle = ?", handle)).id;

/** Follow rows as "a>b" texts, sorted: what the database really holds. */
export async function followPairs(db) {
  const r = await rows(db, "SELECT a.handle AS a, b.handle AS b FROM follows f JOIN users a ON a.id = f.follower_id JOIN users b ON b.id = f.followee_id");
  return r.map((x) => `${x.a}>${x.b}`).sort();
}
export async function blockPairs(db) {
  const r = await rows(db, "SELECT a.handle AS a, b.handle AS b FROM blocks f JOIN users a ON a.id = f.blocker_id JOIN users b ON b.id = f.blocked_id");
  return r.map((x) => `${x.a}>${x.b}`).sort();
}

/** The tables and the columns of `users` right now (for "nothing new exists"). */
export async function schemaOf(db) {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results.map((r) => r.name);
  const columns = (await db.prepare("PRAGMA table_info(users)").all()).results.map((r) => r.name);
  return { tables, columns };
}

/** Every key, at any depth, of a JSON value. */
export function keysOf(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

/** Fail unless the call answered with this status and (when given) this error code. Returns the parsed body. */
export async function expectStatus(res, status, error) {
  const body = await res.json();
  assert.equal(res.status, status, JSON.stringify(body));
  if (error !== undefined) assert.equal(body.error, error, JSON.stringify(body));
  return body;
}

/**
 * A database that remembers every statement it runs (the SQL text and its values), so a test can prove that something
 * never touched the database, or look at the plan of a real query. Wrap it BEFORE the first request: env.DB = spyDb(env.DB).
 */
export function spyDb(db) {
  const log = [];
  const note = (s) => log.push({ sql: s.sql, params: s.params || [] });
  const wrap = (stmt) => ({
    sql: stmt.sql, params: stmt.params, inner: stmt,
    bind: (...p) => wrap(stmt.bind(...p)),
    first: (...a) => { note(stmt); return stmt.first(...a); },
    run: () => { note(stmt); return stmt.run(); },
    all: () => { note(stmt); return stmt.all(); },
  });
  return {
    ...db, log,
    prepare: (sql) => wrap(db.prepare(sql)),
    batch: (list) => { for (const s of list) note(s.inner || s); return db.batch(list.map((s) => s.inner || s)); },
  };
}

/**
 * A database whose profile tables cannot be made (while `broken.on` is true): the statements that create them fail the way a
 * database error would. Everything else works. Wrap it BEFORE the first request.
 */
export function brokenProfilesDb(db, broken = { on: true }) {
  const wrap = (stmt) => ({
    sql: stmt.sql, params: stmt.params, inner: stmt,
    bind: (...p) => wrap(stmt.bind(...p)),
    first: (...a) => stmt.first(...a),
    all: () => stmt.all(),
    run: () => (broken.on && /CREATE TABLE IF NOT EXISTS follows|ALTER TABLE users ADD COLUMN bio/.test(stmt.sql) ? Promise.reject(new Error("D1_ERROR: disk I/O error")) : stmt.run()),
  });
  return { ...db, prepare: (sql) => wrap(db.prepare(sql)), batch: (list) => db.batch(list.map((s) => s.inner || s)) };
}

const UTICA = { id: "5142056", name: "Utica", country: "US" };

/**
 * A signed-in member made straight in the database (a user row and a session, no sign-in steps): fast, for tests that need
 * many members. Returns a browser like person() does, plus { id, w, handle }. `home: null` for a member without a community,
 * `provider: "testlab"` for a test-lab row, `bio` for a ready-made bio.
 */
export async function quick(env, handle, { home = UTICA, provider = "google", bio = null } = {}) {
  await ensureSchema(env.DB);
  const w = await wallet(), at = new Date(clock.now).toISOString();
  const r = await env.DB.prepare(
    "INSERT INTO users (wallet, provider, provider_id, handle, name, home_city, home_name, home_country, home_at, early, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
    .bind(w.address, provider, "q-" + handle, handle, "Real Name of " + handle, home && home.id, home && home.name, home && home.country, home ? at : null, at).run();
  const id = r.meta.last_row_id;
  if (bio !== null) { await ensureProfilesSchema(env.DB); await env.DB.prepare("UPDATE users SET bio = ? WHERE id = ?").bind(bio, id).run(); }
  const b = browser(env);
  const [pair] = (await createSession(env, { wallet: w.address, userId: id, provenAt: at }, SESSION_SECONDS, clock.now)).split("; ");
  b.jar.set(SESSION_COOKIE, pair.slice(pair.indexOf("=") + 1));
  return { id, w, handle, ...b };
}

/** n member rows (no sessions) named `${prefix}${i}`, for lists and counts. Returns their ids. */
export async function seedUsers(db, prefix, n, { provider = "google", home = UTICA } = {}) {
  await ensureSchema(db);
  const at = new Date(clock.now).toISOString();
  const start = ((await db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM users").first()).m || 0) + 1;
  await db.batch(Array.from({ length: n }, (_, i) => db.prepare(
    "INSERT INTO users (wallet, provider, provider_id, handle, name, home_city, home_name, home_country, home_at, early, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
    .bind(`Seed${prefix}${String(i).padStart(5, "0")}${"1".repeat(30)}`, provider, `s-${prefix}${i}`, `${prefix}${i}`, "Seed " + i, home && home.id, home && home.name, home && home.country, at, at)));
  return Array.from({ length: n }, (_, i) => start + i);
}

/** The counts straight from the rows, nothing hidden: { followers, following, blocking, blockedBy }. */
export async function rawCounts(db, id) {
  const r = await one(db, `SELECT (SELECT COUNT(*) FROM follows WHERE followee_id = ?1) AS followers, (SELECT COUNT(*) FROM follows WHERE follower_id = ?1) AS following,
    (SELECT COUNT(*) FROM blocks WHERE blocker_id = ?1) AS blocking, (SELECT COUNT(*) FROM blocks WHERE blocked_id = ?1) AS blocked_by`, id);
  return { followers: r.followers, following: r.following, blocking: r.blocking, blockedBy: r.blocked_by };
}
