// The database as production has it today, frozen: the first-version schema plus the migrations that have
// shipped. Sign-up v2 must upgrade THIS safely, so the test copy of production must not drift when somebody
// adds a migration. Two guards, both asserted in test/signup-migration.test.js:
//   - MIGRATIONS in src/store.js must have exactly the ids below (a new entry fails the test until this file is
//     updated on purpose, and the builder here never applies an entry it does not know);
//   - the schema this builds must still have exactly the tables and columns recorded below.
import { d1 } from "./d1.js";
import { SCHEMA, MIGRATIONS } from "../../src/store.js";

export const PROD_MIGRATION_IDS = [
  "2026-09-27-fair-launch",
  "2026-09-27-city-coins",
  "2026-10-01-v5-founder-policy",
  "2026-09-30-admin-dashboard",
  "2026-10-01-terms-agree",
  "2026-10-01-profile",
  "2026-10-02-handoffs",
  "2026-10-09-expiry-indexes",
];

export const PROD_TABLES = [
  "added_cities", "admin_audit", "admin_roles", "admin_test", "admin_tokens", "appeals", "applications", "balance_samples",
  "bans", "blobs", "city_coins", "claims", "election_votes", "elections", "email_codes", "endorsements", "handoffs",
  "manager_terms", "media", "mod_actions", "objections", "pairs", "posts", "rate_events", "reports", "requests",
  "schema_migrations", "seats", "sessions", "settings", "snapshots", "squad_members", "squads", "streaks",
  "town_requests", "used_nonces", "users", "votes", "windows",
];
export const PROD_USERS_COLUMNS = ["id", "wallet", "provider", "provider_id", "handle", "name", "home_city", "home_name", "home_country", "home_at", "early", "badges", "created_at", "terms_version", "terms_agreed_at", "contact_email", "phone"];
export const PROD_HANDOFFS_COLUMNS = ["id", "kind", "user_id", "wallet", "purpose", "net", "result", "created_at", "expires_at"];

const split = (sql) => sql.split(";").map((s) => s.trim()).filter(Boolean);

/** A fresh database in exactly the production shape (same steps as migrate() in src/store.js, frozen ids only). */
export async function prodDb() {
  const db = d1();
  await db.batch(split(SCHEMA).map((s) => db.prepare(s)));
  await db.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)").run();
  for (const id of PROD_MIGRATION_IDS) {
    const m = MIGRATIONS.find((x) => x.id === id);
    if (!m) throw new Error(`prod-schema: migration ${id} no longer exists in src/store.js`);
    for (const s of split(m.sql)) {
      try { await db.prepare(s).run(); }
      catch (e) { if (!/duplicate column/i.test(String(e && e.message ? e.message : e))) throw e; }
    }
    await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(id, "2026-10-02T00:00:00.000Z").run();
  }
  return db;
}

/** Two real-looking members (one Google, one e-mail), their sessions, and a hand-off, like production today. */
export async function seedProd(db) {
  const T = "2026-10-02T09:00:00.000Z", LATER = "2026-11-01T09:00:00.000Z";
  const user = (wallet, provider, providerId, handle, name) => db.prepare(
    `INSERT INTO users (wallet, provider, provider_id, handle, name, home_city, home_name, home_country, home_at, early, created_at, terms_version, terms_agreed_at)
     VALUES (?, ?, ?, ?, ?, '5140405', 'Syracuse', 'US', ?, 1, ?, '2026-10-01', ?)`).bind(wallet, provider, providerId, handle, name, T, T, T);
  await db.batch([
    user("W1Google1111111111111111111111111111111111111", "google", "google-sub-1", "amber-otter-11", "Ann Google"),
    user("W2Email11111111111111111111111111111111111111", "email", "bea@example.com", "quiet-heron-22", "E-mail member"),
  ]);
  await db.batch([
    db.prepare("INSERT INTO sessions (id, wallet, user_id, proof, created_at, expires_at, proven_at) VALUES ('sess-google', 'W1Google1111111111111111111111111111111111111', 1, NULL, ?, ?, ?)").bind(T, LATER, T),
    db.prepare("INSERT INTO sessions (id, wallet, user_id, proof, created_at, expires_at, proven_at) VALUES ('sess-email', 'W2Email11111111111111111111111111111111111111', 2, NULL, ?, ?, NULL)").bind(T, LATER),
    db.prepare("INSERT INTO sessions (id, wallet, user_id, proof, created_at, expires_at, proven_at) VALUES ('sess-pending', 'W3Pending111111111111111111111111111111111111', NULL, NULL, ?, ?, ?)").bind(T, LATER, T),
    db.prepare("INSERT INTO handoffs (id, kind, user_id, wallet, purpose, net, result, created_at, expires_at) VALUES ('hand-1', 'locate', 1, NULL, 'home', 'US|7922', NULL, ?, ?)").bind(T, LATER),
  ]);
}

/** Rows of tables as JSON text, for "nothing else changed" comparisons. spec = { table: [columns] } (v2 adds columns, so name the old ones). */
export async function dumpTables(db, spec) {
  const out = {};
  for (const [t, cols] of Object.entries(spec)) out[t] = (await db.prepare(`SELECT ${cols.join(", ")} FROM ${t} ORDER BY 1`).all()).results;
  return JSON.stringify(out);
}

export const columnsOf = async (db, table) => (await db.prepare(`PRAGMA table_info(${table})`).all()).results.map((r) => r.name);
export const tablesOf = async (db) => (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results.map((r) => r.name);
