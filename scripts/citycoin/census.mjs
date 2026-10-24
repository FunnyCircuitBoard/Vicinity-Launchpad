#!/usr/bin/env node
/**
 * Citycoin.dev master v5, stage S08: the count-only census of a D1 database. schema-and-api.md section 3.10 step 1 (before and after counts
 * and hashes of a migration) and step 3 (the count-only census queries; R1 section 9's three queries verbatim), master section 07 BR-05
 * acceptance ("Compare before/after counts and hashes for wallets, profiles, posts, canonical locations, FounderRecords, city coins and
 * monetary liabilities"). The owner's guide is docs/citycoin-master/schema-migrations.md section 8.
 *
 *   node scripts/citycoin/census.mjs [--local | --remote] [--database <name>] [--config <wrangler config>] [--key-file <path>] [--out <path>]
 *   node scripts/citycoin/census.mjs --compare <before.json> <after.json>
 *
 * WHAT IT PRINTS: the database name, local or remote, the time, table names, counts, sha256 digests (HMAC-SHA256 with --key-file) and the
 * result of its checks. Never a row value, wallet, e-mail address, name or id: every count label is a constant of this file (a CASE maps
 * anything else to "other"), every number is checked to be a count, and the rows read for a digest exist only in this process's memory.
 *
 * HOW IT READS: only through `wrangler d1 execute <database> --json --command ...`, with --local by default (the local database of the
 * wrangler config; `.wrangler/state` next to it). --remote reads the production database: a step for the owner or someone with production
 * D1 access (external dependency E9), never run by the stage that built this; it needs --key-file. Every statement is checked to be ONE
 * SELECT before it is sent (assertSingleSelect: no second statement, no comment, no write, PRAGMA, ATTACH or transaction keyword); several
 * checked SELECTs go in one `--command`, joined by ";". Wrangler runs with WRANGLER_WRITE_LOGS=false (scripts/citycoin/lib.mjs), so the
 * rows it prints to this process are not copied to its debug log.
 *
 * DIGESTS. A digest covers fixed columns of the existing tables (CATEGORIES below, the columns of the production schema read of
 * 24 October 2026), so a migration that adds a table or a column does not change it, and any change to a covered row does. Each part is
 * sha256(<columns joined by ",">\n<sorted rows>), each row being SQLite's quote() of each column joined by "," (the row hash of
 * test/helpers/cc5-d1copy-worker.js `tableHash`); a category's digest covers its parts' names, row counts and digests. Every cc5 table
 * present (src/cc5schema.js) gets a count and a digest of all its columns. With --key-file every digest is an HMAC-SHA256 under a 32-byte key
 * kept outside the repository (created on first use, mode 0600); the output carries only the key's fingerprint, so a published census
 * cannot be used to test guesses about members' rows, and two censuses compare only when their fingerprints match.
 *
 * EXIT: 0 done; 2 refused (nothing was read); 3 the duplicate-wallet check failed (the census is still printed); 4 --compare found a
 * difference in preserved data; 1 any other failure.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CC5_GROUPS, CC5_ORDER } from "../../src/cc5schema.js";
import { DEFAULT_CONFIG, Refusal, databaseNameFromConfig, checkDatabaseName, outsideRepository, parseArgs, runWrangler, targetOf } from "./lib.mjs";

export const CENSUS_VERSION = "cc5-census/1";
export const PAGE_ROWS = 5000;
const MAX_CALL_STATEMENTS = 100;
const MAX_CALL_CHARS = 60_000;

/* ------------------------------------------------------------------ the one-SELECT rule */

const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|MERGE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|TRANSACTION|RETURNING|TRIGGER|EXPLAIN|LOAD_EXTENSION)\b/i;

/** The statement with every string literal and quoted identifier replaced by an empty one; refuses an unterminated quote. */
function scrubbed(sql) {
  let out = "";
  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    if (ch !== "'" && ch !== '"') { out += ch; i++; continue; }
    let j = i + 1;
    for (;;) {
      if (j >= sql.length) throw new Refusal("census: refused a statement with an unterminated quote");
      if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } break; }
      j++;
    }
    out += ch === "'" ? " '' " : ' "" ';
    i = j + 1;
  }
  return out;
}

/** Answers `sql` when it is exactly one SELECT statement; throws a Refusal otherwise (the reason, never the statement's literals). */
export function assertSingleSelect(sql) {
  if (typeof sql !== "string" || !sql.trim()) throw new Refusal("census: refused an empty statement");
  if (sql.length > 20_000) throw new Refusal("census: refused an over-long statement");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(sql)) throw new Refusal("census: refused a statement with a control character");
  const bare = scrubbed(sql);
  if (/[`[\]]/.test(bare)) throw new Refusal("census: refused a bracket or backtick identifier");
  if (bare.includes(";")) throw new Refusal("census: refused more than one statement (or a terminating semicolon)");
  if (/--|\/\*|\*\//.test(bare)) throw new Refusal("census: refused a statement with a comment");
  if (!/^\s*SELECT\s/i.test(bare)) throw new Refusal("census: refused a statement that is not a SELECT");
  const m = FORBIDDEN.exec(bare);
  if (m) throw new Refusal(`census: refused a statement with the keyword ${m[1].toUpperCase()}`);
  return sql;
}

/* ------------------------------------------------------------------ what it counts and hashes */

/** Seat statuses written by src/seats.js and src/admin.js; the first four are a live seat (the IN list those files use). */
export const SEAT_STATUSES = Object.freeze(["provisional", "active", "grace", "steward", "released", "revoked"]);
const LIVE_SEATS = SEAT_STATUSES.slice(0, 4);
export const CLUSTERS = Object.freeze(["mainnet", "devnet"]);
/** schema-and-api.md section 3.9 (tables that become history) and section 3.10 step 3 (coin_requests, coin_versions). */
export const HISTORY_TABLES = Object.freeze([
  "windows", "applications", "endorsements", "seats", "squads", "squad_members", "objections", "elections", "election_votes", "manager_terms",
  "streaks", "balance_samples", "coin_requests", "coin_screenings", "coin_ready", "coin_legacy_designs", "coin_versions", "email_codes",
  "signups", "user_logins",
]);
/** id -> the tables its statements create (src/cc5schema.js), for every built group, in CC5_ORDER. */
export const CC5_TABLES = Object.freeze(Object.fromEntries(CC5_ORDER.filter((id) => CC5_GROUPS[id]).map((id) => [id, Object.freeze(
  CC5_GROUPS[id].statements.map((s) => (typeof s === "string" ? (/^CREATE TABLE IF NOT EXISTS (\w+)/.exec(s) || [])[1] : null)).filter(Boolean),
)])));

const part = (table, columns, where = null) => Object.freeze({ table, columns: Object.freeze(columns), where });
/**
 * The preserved data of master section 07, as fixed column lists of the production schema read (test/fixtures/prod-schema-2026-10-24.sql).
 * The users table is split so that every one of its columns is in exactly one of wallets, profiles and locations (a test checks it).
 */
export const CATEGORIES = Object.freeze({
  wallets: Object.freeze([part("users", ["id", "wallet", "wallet_at", "wallet_via", "wallet_app"], "wallet IS NOT NULL")]),
  profiles: Object.freeze([
    part("users", ["id", "provider", "provider_id", "handle", "name", "early", "badges", "created_at", "terms_version", "terms_agreed_at",
      "contact_email", "phone", "password_hash", "bio", "password_at", "national_ack_at", "notice_prefs"]),
    part("user_logins", ["user_id", "provider", "provider_id", "created_at"]),
  ]),
  locations: Object.freeze([part("users", ["id", "home_city", "home_name", "home_country", "home_at"], "home_city IS NOT NULL")]),
  posts: Object.freeze([
    part("posts", ["id", "user_id", "scope", "place", "country", "kind", "body", "media_id", "parent_id", "score", "reports", "replies", "hidden",
      "created_at", "hidden_until", "hide_confirmed", "deleted_at"]),
    part("votes", ["post_id", "user_id", "weight", "created_at"]),
  ]),
  community: Object.freeze([
    part("follows", ["follower_id", "followee_id", "created_at"]),
    part("blocks", ["blocker_id", "blocked_id", "created_at"]),
    part("mutes", ["muter_id", "muted_id", "created_at"]),
  ]),
  founders: Object.freeze([
    part("seats", ["id", "city_id", "city_name", "country", "user_id", "wallet", "window_id", "application_id", "policy", "threshold", "status",
      "created_at", "appeal_until", "activated_at", "grace_until", "graces", "ended_at", "end_reason", "probation_until"]),
    part("claims", ["city_id", "wallet", "city_name", "country", "claimed_at"]),
    part("manager_terms", ["id", "country", "seat_id", "user_id", "wallet", "election_id", "starts_at", "ends_at", "consecutive", "status",
      "ended_reason"]),
  ]),
  coins: Object.freeze([
    part("city_coins", ["city_id", "city_name", "country", "seat_id", "user_id", "name", "pitch", "pair", "color", "media_id", "mint", "pending_mint",
      "pending_at", "launched_at", "launched_by", "updated_at", "created_at", "logo_status", "logo_reason", "logo_note", "logo_reviewed_at",
      "logo_reviewed_by", "logo_hash", "approved_media_id"]),
    part("lp_coins", ["cluster", "program_id", "city_id", "mint", "coin", "founder", "name", "symbol", "quote_mint", "dbc_config", "dbc_pool",
      "launch_sig", "launched_at", "recorded_at", "meta_json", "meta_at"]),
    part("admin_tokens", ["mint", "city", "founder_wallet", "platform", "registered_by", "created_at"]),
  ]),
  onchain: Object.freeze([
    part("lp_approvals_log", ["id", "cluster", "program_id", "city_id", "action", "founder", "name", "symbol", "expires_at", "signature",
      "by_wallet", "at"]),
    part("lp_setup", ["cluster", "program_id", "step", "address", "signature", "by_wallet", "at"]),
  ]),
});
export const PRESERVED = Object.freeze(Object.keys(CATEGORIES));

const LIVE_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const lit = (s) => `'${s}'`;
/** CASE <col> WHEN 'a' THEN 'a' ... ELSE 'other' END: the label is always a constant of this file. */
const labelCase = (col, labels) => `CASE ${col} ${labels.map((l) => `WHEN ${lit(l)} THEN ${lit(l)}`).join(" ")} ELSE 'other' END`;
const byCluster = (table) => ({
  key: `${table}_by_cluster`, needs: { [table]: ["cluster"] }, kind: "groups", labels: [...CLUSTERS, "other"],
  sql: () => `SELECT ${labelCase("cluster", CLUSTERS)} AS k, COUNT(*) AS n FROM ${table} GROUP BY k`,
});
const R1_USER_CASES = ["M1", "M2", "M3", "other"];
const SIGN_IN_CASES = ["wallet_and_provider", "wallet_only", "provider_only", "email_only", "other"];
const CC5_IDS = CC5_ORDER.filter((id) => CC5_GROUPS[id] || id === "cc5-identity");

/**
 * The counts: { key, needs: { table: [columns] }, kind: "value" (one number), "row" (named numbers) or "groups" (a count per constant label),
 * sql(columnsOf) }. A count whose table or columns are missing is reported under `absent`, never guessed.
 */
export const COUNTS = Object.freeze([
  { key: "users", needs: { users: ["wallet", "provider", "home_city"] }, kind: "row", fields: ["total", "testlab", "with_wallet", "with_city"],
    sql: () => "SELECT COUNT(*) AS total, COALESCE(SUM(provider = 'testlab'), 0) AS testlab, COALESCE(SUM(provider != 'testlab' AND wallet IS NOT NULL), 0) AS with_wallet, COALESCE(SUM(provider != 'testlab' AND home_city IS NOT NULL), 0) AS with_city FROM users" },
  // R1 section 9, first query, verbatim (M1 wallet and city, M2 wallet without a city, M3 Google or e-mail without a wallet; testlab excluded)
  { key: "users_by_r1_case", needs: { users: ["wallet", "provider", "home_city"] }, kind: "groups", labels: R1_USER_CASES,
    sql: () => "SELECT CASE WHEN wallet IS NOT NULL AND home_city IS NOT NULL THEN 'M1' WHEN wallet IS NOT NULL THEN 'M2' WHEN provider IN ('google','email') THEN 'M3' ELSE 'other' END AS bucket, COUNT(*) AS n FROM users WHERE provider != 'testlab' GROUP BY bucket" },
  // the sign-in a member has today: a wallet plus a Google or e-mail sign-in (their own provider or an added Google sign-in in user_logins),
  // a wallet only, Google only, e-mail only (testlab excluded)
  { key: "users_by_sign_in", needs: { users: ["id", "wallet", "provider"] }, kind: "groups", labels: SIGN_IN_CASES,
    sql: (cols) => {
      const added = cols.user_logins && cols.user_logins.includes("user_id") ? " OR EXISTS (SELECT 1 FROM user_logins l WHERE l.user_id = users.id)" : "";
      return `SELECT CASE WHEN wallet IS NOT NULL AND (provider IN ('google','email')${added}) THEN 'wallet_and_provider' WHEN wallet IS NOT NULL THEN 'wallet_only' WHEN provider = 'google' THEN 'provider_only' WHEN provider = 'email' THEN 'email_only' ELSE 'other' END AS k, COUNT(*) AS n FROM users WHERE provider != 'testlab' GROUP BY k`;
    } },
  // R1 section 9, second query, verbatim: must be 0
  { key: "duplicate_wallets", needs: { users: ["wallet"] }, kind: "value", field: "duplicate_wallets",
    sql: () => "SELECT COUNT(*) AS duplicate_wallets FROM (SELECT wallet FROM users WHERE wallet IS NOT NULL GROUP BY wallet HAVING COUNT(*) > 1)" },
  { key: "cities_with_members", needs: { users: ["home_city", "provider"] }, kind: "value", field: "n",
    sql: () => "SELECT COUNT(DISTINCT home_city) AS n FROM users WHERE home_city IS NOT NULL AND provider != 'testlab'" },
  // R1 section 9, third query, verbatim: live signed-in sessions with and without a wallet proof
  { key: "live_sessions_by_proof", needs: { sessions: ["user_id", "expires_at", "proven_at"] }, kind: "groups", labels: ["wallet_proven", "not_wallet_proven"],
    sql: () => `SELECT CASE WHEN proven_at IS NULL THEN 'not_wallet_proven' ELSE 'wallet_proven' END AS kind, COUNT(*) AS n FROM sessions WHERE user_id IS NOT NULL AND expires_at > ${LIVE_NOW} GROUP BY kind` },
  { key: "sessions", needs: { sessions: ["user_id", "wallet", "expires_at"] }, kind: "row", fields: ["total", "expired", "without_user", "without_wallet"],
    sql: () => `SELECT COUNT(*) AS total, COALESCE(SUM(expires_at <= ${LIVE_NOW}), 0) AS expired, COALESCE(SUM(user_id IS NULL), 0) AS without_user, COALESCE(SUM(wallet IS NULL), 0) AS without_wallet FROM sessions` },
  // section 3.10 step 3: SELECT status, COUNT(*) FROM seats GROUP BY status (with the label limited to the statuses the code writes)
  { key: "seats_by_status", needs: { seats: ["status"] }, kind: "groups", labels: [...SEAT_STATUSES, "other"],
    sql: () => `SELECT ${labelCase("status", SEAT_STATUSES)} AS k, COUNT(*) AS n FROM seats GROUP BY k` },
  { key: "live_seats", needs: { seats: ["status"] }, kind: "value", field: "n",
    sql: () => `SELECT COUNT(*) AS n FROM seats WHERE status IN (${LIVE_SEATS.map(lit).join(", ")})` },
  { key: "open_windows", needs: { windows: ["status"] }, kind: "value", field: "n", sql: () => "SELECT COUNT(*) AS n FROM windows WHERE status = 'open'" },
  { key: "open_elections", needs: { elections: ["status"] }, kind: "value", field: "n", sql: () => "SELECT COUNT(*) AS n FROM elections WHERE status = 'open'" },
  { key: "live_manager_terms", needs: { manager_terms: ["status"] }, kind: "value", field: "n",
    sql: () => "SELECT COUNT(*) AS n FROM manager_terms WHERE status IN ('upcoming', 'active')" },
  { key: "claims", needs: { claims: [] }, kind: "value", field: "n", sql: () => "SELECT COUNT(*) AS n FROM claims" },
  { key: "posts", needs: { posts: ["parent_id", "hidden", "deleted_at"] }, kind: "row", fields: ["total", "replies", "hidden", "deleted"],
    sql: () => "SELECT COUNT(*) AS total, COALESCE(SUM(parent_id IS NOT NULL), 0) AS replies, COALESCE(SUM(hidden != 0), 0) AS hidden, COALESCE(SUM(deleted_at IS NOT NULL), 0) AS deleted FROM posts" },
  { key: "city_coins", needs: { city_coins: ["mint", "launched_at"] }, kind: "row", fields: ["total", "with_mint", "launched"],
    sql: () => "SELECT COUNT(*) AS total, COALESCE(SUM(mint IS NOT NULL), 0) AS with_mint, COALESCE(SUM(launched_at IS NOT NULL), 0) AS launched FROM city_coins" },
  byCluster("lp_coins"),
  { key: "admin_tokens", needs: { admin_tokens: [] }, kind: "value", field: "n", sql: () => "SELECT COUNT(*) AS n FROM admin_tokens" },
  byCluster("lp_approvals_log"),
  byCluster("lp_setup"),
  { key: "schema_migrations", needs: { schema_migrations: ["id"] }, kind: "row", fields: ["total", "cc5"],
    sql: () => "SELECT COUNT(*) AS total, COALESCE(SUM(id LIKE 'cc5-%'), 0) AS cc5 FROM schema_migrations" },
  { key: "cc5_records", needs: { schema_migrations: ["id"] }, kind: "groups", labels: [...CC5_IDS, "other"],
    sql: () => `SELECT ${labelCase("id", CC5_IDS)} AS k, COUNT(*) AS n FROM schema_migrations WHERE id LIKE 'cc5-%' GROUP BY k` },
]);

/* ------------------------------------------------------------------ the census */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const q = (name) => `"${name}"`;
const lineExpr = (columns) => columns.map((c) => `quote(${q(c)})`).join(" || ',' || ");
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
function count(v, what) {
  if (!isCount(v)) throw new Error(`census: ${what} did not answer a count`);
  return v;
}

/** The digest function: sha256, or HMAC-SHA256 under `key` (a Buffer). */
export function digester(key = null) {
  return key ? (text) => createHmac("sha256", key).update(text).digest("hex") : (text) => createHash("sha256").update(text).digest("hex");
}
/** The fingerprint a census prints for its key: never the key. */
export const keyFingerprint = (key) => createHash("sha256").update("cc5-census-key\n").update(key).digest("hex").slice(0, 16);

/**
 * Run the census through `exec(statements) -> Promise<rows[][]>` (one array of row objects per statement; scripts/citycoin/census.mjs
 * wranglerExecutor, or a test's direct executor). Every statement is checked by assertSingleSelect first. Answers the census object.
 */
export async function runCensus(exec, { database, target = "local", key = null, now = () => new Date(), pageRows = PAGE_ROWS } = {}) {
  const H = digester(key);
  const run = async (statements) => {
    if (!statements.length) return [];
    for (const s of statements) assertSingleSelect(s);
    const out = await exec(statements);
    if (!Array.isArray(out) || out.length !== statements.length || !out.every(Array.isArray)) throw new Error("census: the database answered the wrong number of results");
    return out;
  };

  // 1. the tables, and the columns of every table this census reads (pragma_table_info answers no row for a missing table)
  const wanted = [...new Set([
    ...Object.values(CATEGORIES).flat().map((p) => p.table), ...COUNTS.flatMap((c) => Object.keys(c.needs)), ...Object.values(CC5_TABLES).flat(), "user_logins",
  ])];
  const [tableRows, ...columnRows] = await run(["SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ...wanted.map((t) => `SELECT name FROM pragma_table_info('${t}') ORDER BY cid`)]);
  const names = tableRows.map((r) => r.name).filter((n) => typeof n === "string" && !/^sqlite_/.test(n) && !/^_cf_/.test(n));
  const tables = names.filter((n) => IDENT.test(n));
  const unprintable = names.length - tables.length;
  const present = new Set(tables);
  const cols = {};
  wanted.forEach((t, i) => { if (present.has(t)) cols[t] = columnRows[i].map((r) => r.name).filter((n) => typeof n === "string"); });
  const has = (table, columns = []) => Boolean(cols[table]) && columns.every((c) => cols[table].includes(c) && IDENT.test(c));

  // 2. every table's row count, the counts, and the digest parts (first page; further pages below)
  const counts = COUNTS.filter((c) => Object.entries(c.needs).every(([t, cs]) => has(t, cs)));
  const parts = [];
  for (const [category, list] of Object.entries(CATEGORIES)) for (const p of list) parts.push({ category, ...p, ok: has(p.table, p.columns) });
  const cc5Present = Object.entries(CC5_TABLES).flatMap(([group, ts]) => ts.filter((t) => cols[t] && cols[t].length && cols[t].every((c) => IDENT.test(c))).map((t) => ({ group, table: t, columns: cols[t], where: null, ok: true })));
  const readable = [...parts.filter((p) => p.ok), ...cc5Present];
  const page = (p, offset) => `SELECT ${lineExpr(p.columns)} AS line FROM ${q(p.table)}${p.where ? ` WHERE ${p.where}` : ""} ORDER BY line LIMIT ${pageRows} OFFSET ${offset}`;
  const results = await run([
    ...tables.map((t) => `SELECT COUNT(*) AS n FROM ${q(t)}`),
    ...counts.map((c) => c.sql(cols)),
    ...readable.map((p) => page(p, 0)),
  ]);
  const tableCounts = Object.fromEntries(tables.map((t, i) => [t, count(results[i][0] && results[i][0].n, `the row count of ${t}`)]));
  const countRows = results.slice(tables.length, tables.length + counts.length);
  const lines = readable.map((p, i) => results[tables.length + counts.length + i]);
  for (let open = readable.map((p, i) => i).filter((i) => lines[i].length === pageRows); open.length;) {
    const more = await run(open.map((i) => page(readable[i], lines[i].length)));
    open.forEach((i, k) => lines[i].push(...more[k]));
    open = open.filter((i, k) => more[k].length === pageRows);
  }

  // 3. the counts, read through their constant labels only
  const out = {};
  const absent = COUNTS.filter((c) => !counts.includes(c)).map((c) => c.key);
  counts.forEach((c, i) => {
    const rows = countRows[i];
    if (c.kind === "value") out[c.key] = count(rows[0] && rows[0][c.field], c.key);
    else if (c.kind === "row") out[c.key] = Object.fromEntries(c.fields.map((f) => [f, count(rows[0] && rows[0][f], `${c.key}.${f}`)]));
    else {
      const g = Object.fromEntries(c.labels.map((l) => [l, 0]));
      for (const r of rows) {
        const [label, n] = Object.values(r);
        if (!c.labels.includes(label)) throw new Error(`census: ${c.key} answered a label outside its list`);
        g[label] += count(n, c.key);
      }
      out[c.key] = g;
    }
  });

  // 4. digests: each part over its sorted rows, each category over its parts
  const partDigest = (p, rows) => {
    const ls = rows.map((r) => { if (typeof r.line !== "string") throw new Error(`census: ${p.table} answered a row the digest cannot read`); return r.line; });
    ls.sort();
    return { rows: ls.length, digest: H(`${p.columns.join(",")}\n${ls.join("\n")}`) };
  };
  const digested = new Map(readable.map((p, i) => [p, partDigest(p, lines[i])]));
  const digests = {};
  for (const category of PRESERVED) {
    const mine = parts.filter((p) => p.category === category);
    const done = mine.filter((p) => p.ok).map((p) => ({ table: p.table, ...digested.get(p) }));
    const missing = mine.filter((p) => !p.ok).map((p) => (cols[p.table] ? `${p.table}.${p.columns.filter((c) => !cols[p.table].includes(c)).join(",")}` : p.table));
    digests[category] = {
      rows: done.reduce((a, p) => a + p.rows, 0),
      digest: H(`${CENSUS_VERSION}\t${category}\n${done.map((p) => `${p.table}\t${p.rows}\t${p.digest}`).join("\n")}`),
      parts: Object.fromEntries(done.map((p) => [p.table, { rows: p.rows, digest: p.digest }])),
      missing,
    };
  }
  const cc5Tables = Object.fromEntries(cc5Present.map((p) => [p.table, { group: p.group, rows: digested.get(p).rows, digest: digested.get(p).digest }]));
  const recorded = out.cc5_records ? CC5_IDS.filter((id) => out.cc5_records[id] > 0) : [];

  const census = {
    census: CENSUS_VERSION,
    database: database ?? null,
    target,
    at: now().toISOString(),
    digest: { algorithm: key ? "hmac-sha256" : "sha256", key_fingerprint: key ? keyFingerprint(key) : null },
    checks: { duplicate_wallets_zero: out.duplicate_wallets === undefined ? null : out.duplicate_wallets === 0 },
    counts: out,
    absent,
    tables: tableCounts,
    tables_with_unprintable_names: unprintable,
    history_tables: { present: HISTORY_TABLES.filter((t) => present.has(t)), absent: HISTORY_TABLES.filter((t) => !present.has(t)) },
    cc5: {
      recorded,
      tables: cc5Tables,
      absent_tables: Object.values(CC5_TABLES).flat().filter((t) => !cc5Tables[t]),
    },
    digests,
  };
  return census;
}

/* ------------------------------------------------------------------ comparing two censuses */

function leaves(obj, prefix = "", into = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === "object") leaves(v, `${prefix}${k}.`, into);
    else into[`${prefix}${k}`] = v;
  }
  return into;
}
const sameList = (a = [], b = []) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Compare two census outputs: `ok` is true when every preserved category (CATEGORIES) has the same digest, row count and missing parts and
 * no table disappeared. Changed counts and row counts are listed (sessions and rate limits move on a live site) but do not fail it.
 * Refuses outputs of another version, or made with different digest keys.
 */
export function compareCensus(before, after) {
  for (const c of [before, after]) if (!c || c.census !== CENSUS_VERSION || !c.digests || !c.tables) throw new Refusal(`compare: not a ${CENSUS_VERSION} census output`);
  if (before.digest.algorithm !== after.digest.algorithm || before.digest.key_fingerprint !== after.digest.key_fingerprint) {
    throw new Refusal("compare: the two censuses were made with different digest keys; run both with the same --key-file");
  }
  const categories = {};
  const partsChanged = [];
  for (const cat of PRESERVED) {
    const a = before.digests[cat], b = after.digests[cat];
    const same = Boolean(a && b) && a.digest === b.digest && a.rows === b.rows && sameList(a.missing, b.missing);
    categories[cat] = same ? "same" : "changed";
    if (!same) {
      for (const t of new Set([...Object.keys((a && a.parts) || {}), ...Object.keys((b && b.parts) || {})])) {
        const x = a && a.parts[t], y = b && b.parts[t];
        if (!x || !y || x.digest !== y.digest || x.rows !== y.rows) partsChanged.push(`${cat}.${t}`);
      }
    }
  }
  const tb = Object.keys(before.tables), ta = Object.keys(after.tables);
  const tables = {
    added: ta.filter((t) => !(t in before.tables)),
    removed: tb.filter((t) => !(t in after.tables)),
    row_counts_changed: tb.filter((t) => t in after.tables && before.tables[t] !== after.tables[t]).map((t) => ({ table: t, before: before.tables[t], after: after.tables[t] })),
  };
  const la = leaves(before.counts), lb = leaves(after.counts);
  const counts = [...new Set([...Object.keys(la), ...Object.keys(lb)])].filter((k) => la[k] !== lb[k]).map((k) => ({ count: k, before: la[k] ?? null, after: lb[k] ?? null }));
  return {
    ok: Object.values(categories).every((v) => v === "same") && tables.removed.length === 0,
    categories,
    parts_changed: partsChanged,
    tables,
    counts_changed: counts,
    cc5: {
      recorded_added: after.cc5.recorded.filter((id) => !before.cc5.recorded.includes(id)),
      recorded_removed: before.cc5.recorded.filter((id) => !after.cc5.recorded.includes(id)),
      tables_added: Object.keys(after.cc5.tables).filter((t) => !before.cc5.tables[t]),
    },
  };
}

/* ------------------------------------------------------------------ reading through wrangler */

function chunks(statements) {
  const out = [];
  let cur = [], size = 0;
  for (const s of statements) {
    if (cur.length && (cur.length >= MAX_CALL_STATEMENTS || size + s.length + 2 > MAX_CALL_CHARS)) { out.push(cur); cur = []; size = 0; }
    cur.push(s);
    size += s.length + 2;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The JSON wrangler printed (the first line that opens an array or an object), or null; never echoes the text. */
function wranglerJson(stdout) {
  const at = String(stdout).search(/^\s*[[{]/m);
  if (at < 0) return null;
  try { return JSON.parse(String(stdout).slice(at)); } catch { return null; }
}
const clip = (s, n = 240) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * exec(statements) over `wrangler d1 execute <database> --<target> --json --command "<s1>;\n<s2>..."` (statements already checked; checked
 * again here). Answers one array of rows per statement. On a failure it reports wrangler's error text (about the SQL) but never its stdout.
 */
export function wranglerExecutor({ database, target, config = null, run = runWrangler }) {
  checkDatabaseName(database);
  if (target !== "local" && target !== "remote") throw new Refusal("census: the target is --local or --remote");
  return async (statements) => {
    const answers = [];
    for (const chunk of chunks(statements)) {
      for (const s of chunk) assertSingleSelect(s);
      const args = ["d1", "execute", database, `--${target}`, "--json", "--command", chunk.join(";\n")];
      if (config) args.push("--config", config);
      const { code, stdout, stderr } = await run(args);
      const parsed = wranglerJson(stdout);
      if (code !== 0) {
        const text = parsed && parsed.error ? clip(parsed.error.text || parsed.error.message) : "";
        const last = clip(String(stderr).split("\n").filter((l) => l.trim()).pop());
        throw new Error(`census: wrangler d1 execute failed (exit ${code})${text ? `: ${text}` : ""}${last ? ` | ${last}` : ""}`);
      }
      if (!Array.isArray(parsed) || parsed.length !== chunk.length) throw new Error("census: wrangler printed an answer the census cannot read (not shown)");
      for (const r of parsed) {
        if (!r || r.success === false || !Array.isArray(r.results)) throw new Error("census: wrangler reported a statement that did not succeed");
        answers.push(r.results);
      }
    }
    return answers;
  };
}

/* ------------------------------------------------------------------ the key and the files */

/** The digest key at `file` (outside the repository): read it, or create 32 random bytes there (hex, mode 0600) when it does not exist. */
export function loadKey(file, { create = true, onCreate = () => {} } = {}) {
  const real = outsideRepository(file, "the census key file");
  let st = null;
  try { st = lstatSync(real); } catch { st = null; }
  if (!st) {
    if (!create) throw new Refusal(`the census key file ${file} does not exist`);
    const hex = randomBytes(32).toString("hex");
    const fd = openSync(real, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
    try { writeSync(fd, `${hex}\n`); } finally { closeSync(fd); }
    onCreate(real);
    return Buffer.from(hex, "hex");
  }
  if (!st.isFile()) throw new Refusal(`the census key file ${file} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw new Refusal(`the census key file ${file} is readable by others; chmod 600 it`);
  const text = readFileSync(real, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Refusal(`the census key file ${file} does not hold a 32-byte hex key`);
  return Buffer.from(text, "hex");
}

/** Write `text` to a NEW file (refuses an existing one, symlinks included), mode `mode`. */
export function writeNewFile(file, text, mode = 0o600) {
  const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), mode);
  try { writeSync(fd, text); } finally { closeSync(fd); }
}

/* ------------------------------------------------------------------ the command line */

const USAGE = `usage:
  node scripts/citycoin/census.mjs [--local | --remote] [--database <name>] [--config <wrangler config>] [--key-file <path>] [--out <path>]
  node scripts/citycoin/census.mjs --compare <before.json> <after.json>
--local (default) reads the local database of the wrangler config; --remote reads the production database (owner or credential holder
only, and only with --key-file <path outside the repository>). Prints counts and digests only.
`;

/** The CLI. `io` replaces process I/O and the wrangler runner in tests. Answers the exit code. */
export async function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s));
  const err = io.err || ((s) => process.stderr.write(s));
  const run = io.run || runWrangler;
  try {
    const { opts, positionals } = parseArgs(argv, { flags: ["local", "remote", "compare", "help"], values: ["database", "config", "key-file", "out"] });
    if (opts.help) { out(USAGE); return 0; }
    if (opts.compare) {
      if (positionals.length !== 2 || Object.keys(opts).length !== 1) throw new Refusal(`--compare takes two census files and nothing else\n${USAGE}`);
      const [a, b] = positionals.map((f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { throw new Refusal(`compare: cannot read ${f} as JSON`); } });
      const result = compareCensus(a, b);
      out(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 4;
    }
    if (positionals.length) throw new Refusal(`unexpected argument ${positionals[0].slice(0, 60)}\n${USAGE}`);
    const target = targetOf(opts, "local");
    const config = opts.config || null;
    const database = opts.database ? checkDatabaseName(opts.database) : databaseNameFromConfig(config || DEFAULT_CONFIG);
    if (target === "remote" && !opts["key-file"]) throw new Refusal("--remote needs --key-file <path outside the repository>: digests of production data are always keyed");
    const outFile = opts.out ? outsideRepository(opts.out, "the census output file") : null;
    const key = opts["key-file"] ? loadKey(opts["key-file"], { onCreate: (f) => err(`census: created a new digest key at ${f} (keep it for the after-run; never commit or share it)\n`) }) : null;
    if (target === "remote") err(`census: read-only SELECTs against the REMOTE database ${database} (owner or credential holder step, E9)\n`);
    const census = await runCensus(wranglerExecutor({ database, target, config, run }), { database, target, key, now: io.now });
    const text = `${JSON.stringify(census, null, 2)}\n`;
    if (outFile) writeNewFile(outFile, text, 0o644);
    out(text);
    if (census.checks.duplicate_wallets_zero === false) { err("census: CHECK FAILED: duplicate wallets exist (must be 0)\n"); return 3; }
    return 0;
  } catch (e) {
    if (e instanceof Refusal) { err(`${e.message}\n`); return 2; }
    err(`census failed: ${clip(e && e.message, 400)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
