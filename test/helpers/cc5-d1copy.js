// The S08 D1 copy (test/cc5-d1copy.test.js, test/cc5-parity.test.js): the production schema as read on 24 October 2026 (schema only, no
// rows: test/fixtures/prod-schema-2026-10-24.sql, 88 objects) loaded into a database, plus SYNTHETIC rows in every one of its tables. No
// member data exists anywhere here: every wallet is base58 of sha256("cc5-synthetic-..."), every person "Synthetic Member n", every e-mail
// address under example.invalid. Two engines run the same executor (test/helpers/cc5-d1copy-worker.js):
//   - "miniflare local D1": Cloudflare's local D1 inside workerd (Miniflare, installed with wrangler), the closest thing to D1 that runs
//     without a Cloudflare account; no remote resource, no persistence (a temporary database per run);
//   - "node:sqlite": Node's built-in SQLite (test/helpers/d1.js), always available.
// When workerd cannot start here, the Miniflare tests are skipped with the reason; the node:sqlite ones always run.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { d1 } from "./d1.js";
import { makeExecutor } from "./cc5-d1copy-worker.js";
import { base58Encode } from "../../src/solana.js";
import { MIGRATIONS } from "../../src/store.js";

const ROOT = new URL("../../", import.meta.url);
export const rootPath = (p = "") => fileURLToPath(new URL(p, ROOT));
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");

/* ------------------------------------------------------------------ the production schema read */

export const PROD_SCHEMA_FILE = "test/fixtures/prod-schema-2026-10-24.sql";
/** The 88 statements of the schema read (it has no trigger, so a statement ends at a semicolon at the end of a line). */
export function prodSchemaStatements() {
  return read(PROD_SCHEMA_FILE).replace(/^--[^\n]*\n/gm, "").split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}

/** The tables of the schema read with their columns (PRAGMA table_info), read once from an in-memory copy. */
function prodTables() {
  const db = new DatabaseSync(":memory:");
  for (const s of prodSchemaStatements()) db.exec(s);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const out = {};
  for (const n of names) out[n] = db.prepare(`PRAGMA table_info("${n}")`).all().map((c) => ({ ...c }));
  db.close();
  return out;
}

/* ------------------------------------------------------------------ synthetic rows */

const T0 = Date.parse("2026-10-24T09:00:00.000Z");
const at = (days) => new Date(T0 + days * 86400_000).toISOString();
const digest = (label) => createHash("sha256").update(`cc5-synthetic-${label}`).digest();
/** A synthetic Solana-shaped address: base58 of 32 bytes nobody holds a key for. */
export const synthAddress = (label) => base58Encode(new Uint8Array(digest(label)));
export const synthWallet = (n) => synthAddress(`wallet-${n}`);
const synthHash = (label) => digest(label).toString("hex");
/** Session tokens of the synthetic members (the cookie value); the sessions table stores sha256(token) in base64url, like src/auth.js. */
export const synthSessionToken = (n) => `cc5-synthetic-session-token-${n}`;
const sessionId = (n) => createHash("sha256").update(synthSessionToken(n)).digest("base64url");
const CITY = [["5128581", "New York City"], ["5140405", "Syracuse"], ["5106834", "Albany"]];
const city = (i) => CITY[(i - 1) % CITY.length];
const MINT = (i) => synthAddress(`mint-${i}`);

/**
 * The migration ids a database in the production shape carries: every entry of MIGRATIONS (src/store.js) and the lazy migrations whose
 * objects the schema read shows (sign-up, limits, profiles, launchpad, market, feedback, wallet-optional and wallet-app columns, logins,
 * feed v2, logo review, notices, launchpad coins). Not the COIN_V2 ones (no coin_requests table) and not the S04 host binding (no
 * sessions.host column). The ids are code constants, not data.
 */
export const PRODUCTION_SHAPE_MIGRATION_IDS = Object.freeze([
  ...MIGRATIONS.map((m) => m.id),
  "2026-10-03-auth-limits", "2026-10-03-launchpad-v2", "2026-10-03-profiles", "2026-10-03-signup-v2", "2026-10-06-launchpad-market",
  "2026-10-09-feedback", "2026-10-09-wallet-optional", "2026-10-10-lp-coins", "2026-10-10-wallet-app", "2026-10-11-wallet-app-2",
  "2026-10-12-user-logins", "2026-10-16-feed-v2", "2026-10-16-logo-review", "2026-10-16-notify",
]);

const USERS = 5;
/** Per-table rows that carry meaning for the Worker's paths (members, sessions, posts, coins) and keep today's facts true: 5 members, no live
 *  seat (seats are 'ended' history), no open window or election, no city coin with a mint. `null` count = the default of 3 rows. */
const SPECIAL = {
  users: [USERS, (i) => {
    const provider = ["google", "email", "wallet", "google", "email"][i - 1];
    return {
      id: i, wallet: i <= 4 ? synthWallet(i) : null, provider,
      provider_id: provider === "wallet" ? synthWallet(i) : provider === "google" ? `synthetic-google-sub-${i}` : `member${i}@example.invalid`,
      handle: `synthetic-member-${i}`, name: `Synthetic Member ${i}`, home_city: city(i)[0], home_name: city(i)[1], home_country: "US",
      home_at: at(-20 + i), early: 1, badges: "[]", created_at: at(-20 + i), terms_version: "2026-10-01", terms_agreed_at: at(-20 + i),
      contact_email: null, phone: null, password_hash: null, bio: `Synthetic bio ${i}`, wallet_at: i <= 4 ? at(-19 + i) : null,
      wallet_via: i <= 4 ? "extension" : null, wallet_app: null, password_at: null, national_ack_at: null, notice_prefs: null,
    };
  }],
  sessions: [3, (i) => ({ id: sessionId(i), wallet: i <= 2 ? synthWallet(i) : null, user_id: i, proof: null, created_at: at(-1), expires_at: i < 3 ? at(30) : at(-2), proven_at: at(-1), made_by: null })],
  // posts 1 and 2 in New York City by members 1 and 4 (both live there), post 3 in Syracuse by member 2, post 4 member 1's reply to post 1
  posts: [4, (i) => ({ id: i, user_id: [1, 4, 2, 1][i - 1], scope: "city", place: city([1, 4, 2, 1][i - 1])[0], country: "US", kind: i === 4 ? "reply" : "meme",
    body: `Synthetic post ${i}`, media_id: null, parent_id: i === 4 ? 1 : null, score: i, reports: 0, replies: i === 1 ? 1 : 0, hidden: 0, created_at: at(-3 + i / 10),
    hidden_until: null, hide_confirmed: 0, deleted_at: null })],
  city_coins: [2, (i) => ({ city_id: city(i)[0], city_name: city(i)[1], country: "US", seat_id: i, user_id: i, name: `Synthetic City Coin ${i}`, pitch: "Synthetic pitch",
    pair: "SOL", color: "#3366ff", media_id: null, mint: null, pending_mint: null, pending_at: null, launched_at: null, launched_by: null, updated_at: at(-4), created_at: at(-4),
    logo_status: null, logo_reason: null, logo_note: null, logo_reviewed_at: null, logo_reviewed_by: null, logo_hash: null, approved_media_id: null })],
  seats: [3, (i) => ({ status: "ended", ended_at: at(-5), end_reason: "resigned", city_id: city(i)[0], city_name: city(i)[1], user_id: i, wallet: synthWallet(i), policy: 6, threshold: 1000000, graces: "[]", probation_until: null, grace_until: null, appeal_until: null })],
  windows: [3, (i) => ({ status: "decided", kind: "standard", city_id: city(i)[0], city_name: city(i)[1], opened_at: at(-15), closes_at: at(-8), decided_at: at(-8), result: "{}", policy: 6, threshold: 1000000 })],
  elections: [2, (i) => ({ status: "decided", opened_at: at(-15), closes_at: at(-8), decided_at: at(-8), result: "{}", policy: 6, country: ["US", "CA"][i - 1] })],
  manager_terms: [null, () => ({ status: "ended", ended_reason: "term_over", starts_at: at(-60), ends_at: at(-30) })],
  squads: [null, (i) => ({ status: "closed", city_id: city(i)[0], city_name: city(i)[1], founder_wallet: synthWallet(i) })],
  snapshots: [null, () => ({ status: "cancelled", policy: 6 })],
  appeals: [null, () => ({ status: "closed" })],
  objections: [null, () => ({ status: "rejected" })],
  requests: [null, () => ({ status: "rejected" })],
  town_requests: [null, () => ({ status: "rejected" })],
  feedback: [null, (i) => ({ status: "done", kind: "idea", email: `member${i}@example.invalid` })],
  bans: [null, (i) => ({ user_id: i, country: "US", expires_at: at(-1) })],
  handoffs: [null, (i) => ({ id: `synthetic-handoff-${i}`, kind: "locate", user_id: i, wallet: null, purpose: "home", net: "US|7922", result: null, expires_at: i === 1 ? at(-1) : at(1) })],
  pairs: [null, (i) => ({ id: `synthetic-pair-${i}`, pin: "000000", wallet: null, purpose: "login", user_id: null, expires_at: i === 1 ? at(-1) : at(1) })],
  used_nonces: [null, (i) => ({ nonce: `synthetic-nonce-${i}`, expires_at: i === 1 ? at(-1) : at(1) })],
  email_codes: [null, (i) => ({ email: `member${i}@example.invalid`, code_hash: synthHash(`code-${i}`), expires_at: at(-1), window_start: null })],
  signups: [null, (i) => ({ id: `synthetic-signup-${i}`, provider: null, provider_id: null, pending_email: null, pending_pw_hash: null, expires_at: at(-1) })],
  settings: [null, (i) => ({ key: `synthetic-setting-${i}`, value: `value-${i}` })],
  blobs: [null, (i) => ({ key: "synthetic-blob", part: i - 1, data: { $blob: synthHash(`blob-${i}`) } })],
  media: [null, (i) => ({ type: "image/png", bytes: { $blob: `89504e47${synthHash(`media-${i}`)}` } })],
  user_logins: [null, (i) => ({ user_id: i, provider: "google", provider_id: `synthetic-google-sub-${i}` })],
  claims: [null, (i) => ({ city_id: city(i)[0], wallet: synthWallet(i), city_name: city(i)[1], country: "US" })],
  streaks: [null, (i) => ({ wallet: synthWallet(i), level: 1000 * i, above_since: at(-10) })],
  admin_roles: [null, (i) => ({ wallet: synthWallet(10 + i), role: "moderator" })],
  lp_coins: [null, (i) => ({ cluster: "devnet", program_id: synthAddress("program"), city_id: city(i)[0], mint: MINT(i), coin: synthAddress(`coin-${i}`), founder: synthWallet(i),
    name: `Synthetic ${i}`, symbol: `SYN${i}`, quote_mint: synthAddress("quote"), dbc_config: synthAddress("config"), dbc_pool: synthAddress(`pool-${i}`), meta_json: "{}" })],
  lp_setup: [null, (i) => ({ cluster: "devnet", program_id: synthAddress("program"), step: `step-${i}` })],
  lp_approvals_log: [null, (i) => ({ cluster: "devnet", program_id: synthAddress("program"), city_id: city(i)[0], action: "approve", signature: synthAddress(`sig-${i}`) })],
  price_candles: [null, (i) => ({ mint: MINT(1), tf: "1h", t: 1792800000 + i * 3600, o: 1, h: 2, l: 0.5, c: 1.5, src: "synthetic" })],
  price_samples: [null, (i) => ({ mint: MINT(1), at: T0 - i * 600_000, stage: "curve" })],
  balance_samples: [null, (i) => ({ day: at(-i).slice(0, 10), holders: 10 + i })],
  follows: [null, (i) => ({ follower_id: i, followee_id: (i % USERS) + 1 })],
  // members 1 and 4 neither mute nor block anyone, so member 1 sees (and can vote on) member 4's post in their city
  blocks: [null, (i) => ({ blocker_id: [2, 3, 5][i - 1], blocked_id: [5, 2, 3][i - 1] })],
  mutes: [null, (i) => ({ muter_id: [2, 3, 5][i - 1], muted_id: [3, 5, 2][i - 1] })],
  votes: [null, (i) => ({ post_id: i, user_id: (i % USERS) + 1, weight: 1 })],
  reports: [null, (i) => ({ post_id: i, user_id: ((i + 1) % USERS) + 1 })],
  profile_reports: [null, (i) => ({ user_id: i, reporter_id: (i % USERS) + 1 })],
  election_votes: [null, (i) => ({ election_id: 1, user_id: i, seat_id: i })],
  endorsements: [null, (i) => ({ window_id: i, user_id: i, application_id: i })],
  squad_members: [null, (i) => ({ squad_id: 1, user_id: i, wallet: synthWallet(i) })],
  applications: [null, (i) => ({ window_id: i, user_id: i, wallet: synthWallet(i), city_id: city(i)[0], withdrawn: 0 })],
  rate_events: [null, (i) => ({ user_id: i, kind: "post", at: at(-3) })],
  notices: [null, (i) => ({ user_id: i, kind: "reply", href: "/dashboard", read_at: null })],
  admin_tokens: [null, (i) => ({ mint: MINT(10 + i), founder_wallet: synthWallet(i), platform: "other" })],
  coin_stats: [null, (i) => ({ mint: MINT(i) })],
  market_meta: [null, (i) => ({ mint: MINT(i), pool: synthAddress(`pool-${i}`) })],
  added_cities: [null, (i) => ({ country: "US", lat: 42 + i / 10, lon: -75 - i / 10, added_by: synthWallet(i) })],
  auth_limits: [null, (i) => ({ key: synthHash(`limit-${i}`) })],
};

/** A value for a column nothing above names (by name, then by type). */
function generic(table, col, i) {
  const n = col.name, type = String(col.type).toUpperCase();
  if (col.pk === 1 && type === "INTEGER") return i;
  if (/^(wallet|founder|founder_wallet|by_wallet|granted_by|registered_by|added_by)$/.test(n)) return synthWallet(i);
  if (/(^|_)(mint|coin|pool|config|address|signature|program_id)$/.test(n)) return synthAddress(`${table}-${n}-${i}`);
  if (/(^|_)(expires_at|ends_at|closes_at|until)$/.test(n)) return at(10 + i);
  if (/(_at|^at|_start|^day)$/.test(n) && type === "TEXT") return at(-10 + i);
  if (/(^|_)country$/.test(n)) return "US";
  if (/^(city_id|city|place|near_id|home_city|loc_city)$/.test(n)) return city(i)[0];
  if (/(^|_)name$/.test(n)) return `Synthetic ${table} ${i}`;
  if (/hash$|^merkle_root$/.test(n)) return synthHash(`${table}-${n}-${i}`);
  if (/^(badges|graces|loc_choices)$/.test(n)) return "[]";
  if (/^(result|detail|meta_json)$/.test(n)) return "{}";
  if (/email$/.test(n)) return `member${i}@example.invalid`;
  if (/(^|_)id$/.test(n) && type === "INTEGER") return ((i - 1) % USERS) + 1;
  if (type === "INTEGER") return col.dflt_value !== null && /^-?\d+$/.test(col.dflt_value) ? Number(col.dflt_value) : i;
  if (type === "REAL") return i + 0.5;
  if (type === "BLOB") return { $blob: synthHash(`${table}-${n}-${i}`) };
  return `synthetic-${table}-${n}-${i}`;
}

let rowsCache = null;
/** { table: [row] }: a few synthetic rows in every table of the schema read (schema_migrations: the production-shape ids above). */
export function syntheticRows() {
  if (rowsCache) return rowsCache;
  const out = {};
  for (const [table, columns] of Object.entries(prodTables())) {
    if (table === "schema_migrations") {
      out[table] = PRODUCTION_SHAPE_MIGRATION_IDS.map((id, i) => ({ id, applied_at: at(-30 + i / 100) }));
      continue;
    }
    const [count, special] = SPECIAL[table] || [null, () => ({})];
    out[table] = [];
    for (let i = 1; i <= (count || 3); i++) {
      const s = special(i);
      const row = {};
      for (const c of columns) row[c.name] = Object.prototype.hasOwnProperty.call(s, c.name) ? s[c.name] : generic(table, c, i);
      for (const k of Object.keys(s)) if (!(k in row)) throw new Error(`synthetic rows: ${table}.${k} is not a column of the schema read`);
      out[table].push(row);
    }
  }
  rowsCache = out;
  return out;
}

/* ------------------------------------------------------------------ the engines */

const short = (e) => String((e && e.message) || e).split("\n")[0].slice(0, 160);
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error(`${what} did not answer within ${ms} ms`)), ms); t.unref?.(); })]);
const jsonCopy = (v) => JSON.parse(JSON.stringify(v));

const returnsRows = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
/**
 * test/helpers/d1.js with a batch that runs in one synchronous step, like D1's (one transaction the server never interleaves with another
 * request's statements). The shared helper awaits between a batch's statements, so two batches at once would nest BEGIN; the race test
 * runs many at once.
 */
function atomicD1() {
  const db = d1();
  const raw = db._raw;
  return {
    ...db,
    async batch(list) {
      raw.exec("BEGIN");
      try {
        const out = list.map((s) => {
          const st = raw.prepare(s.sql);
          if (returnsRows(s.sql)) return { results: st.all(...s.params).map((r) => ({ ...r })), success: true, meta: {} };
          const r = st.run(...s.params);
          return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
        });
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

/** Node's SQLite: one database per name (test/helpers/d1.js with an atomic batch), the executor in-process. */
export function nodeEngine(names) {
  const env = Object.fromEntries(names.map((n) => [n, atomicD1()]));
  const exec = makeExecutor(env);
  return { name: "node:sqlite", call: async (op) => jsonCopy(await exec(op)), env, dispose: async () => {} };
}

/** wrangler.jsonc's compatibility date (the production Worker's). */
export function compatibilityDate() {
  return (/"compatibility_date"\s*:\s*"([0-9-]+)"/.exec(read("wrangler.jsonc")) || [])[1] || "2026-09-01";
}

/**
 * Cloudflare's local D1 inside workerd: one Miniflare instance whose Worker is the executor module, one local database per name (no
 * persistence by default: a temporary database that ends with dispose). Rejects with the reason when Miniflare is missing or workerd cannot start.
 * `proxy(name)` is the same database seen from Node (a second runtime on the same D1, for the race test). The census tests
 * (test/cc5-census.test.js) pass `persistDir` (a `<dir>/.wrangler/state/v3` outside the repository) and `databaseIds` (name -> the
 * database_id of their own wrangler config), so that `wrangler d1 execute --local --config <dir>/wrangler.json` reads the same database.
 */
/** `entry` and every module it imports with a relative static or dynamic import, repository-relative, the entry first. */
export function moduleClosure(entry) {
  const seen = [];
  const visit = (rel) => {
    if (seen.includes(rel)) return;
    seen.push(rel);
    const text = read(rel);
    const dir = rel.split("/").slice(0, -1);
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm)) {
      const parts = [...dir];
      for (const seg of m[1].split("/")) { if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg); }
      visit(parts.join("/"));
    }
  };
  visit(entry);
  return seen;
}

export async function miniflareEngine(names, { timeoutMs = 30_000, persistDir = null, databaseIds = {} } = {}) {
  let mod;
  try { mod = await import("miniflare"); }
  catch (e) { throw new Error(`miniflare is not installed (${short(e)})`); }
  const { Miniflare, convertV4MiniflareOptions } = mod;
  const options = {
    // the executor and every module it imports, statically (src/cc5schema.js, src/store.js, and src/v5policy.js with what that reads)
    modules: moduleClosure("test/helpers/cc5-d1copy-worker.js").map((f) => ({ type: "ESModule", path: rootPath(f) })),
    modulesRoot: rootPath(),
    compatibilityDate: compatibilityDate(),
    d1Databases: Object.fromEntries(names.map((n) => [n, databaseIds[n] || `cc5-d1copy-${n.toLowerCase()}`])),
    ...(persistDir ? { resourcePersistencePath: persistDir } : {}),
    host: "127.0.0.1",
    port: 0,
    cf: false, // placeholder request.cf: Miniflare otherwise fetches workers.cloudflare.com/cf.json and caches it in the working directory
  };
  let mf;
  try {
    mf = new Miniflare(typeof convertV4MiniflareOptions === "function" ? convertV4MiniflareOptions(options) : options);
    await withTimeout(mf.ready, timeoutMs, "workerd");
  } catch (e) {
    if (mf) await mf.dispose().catch(() => {});
    throw new Error(`workerd did not start (${short(e)})`);
  }
  const call = async (op) => {
    const res = await mf.dispatchFetch("http://cc5.d1copy.invalid/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) });
    const body = await res.json();
    if (!body.ok) throw new Error(`executor: ${body.error}`);
    return body.value;
  };
  try { await withTimeout(call({ op: "groups" }), timeoutMs, "the executor"); }
  catch (e) { await mf.dispose().catch(() => {}); throw new Error(`workerd did not run the executor (${short(e)})`); }
  return { name: "miniflare local D1", call, proxy: (n) => mf.getD1Database(n), dispose: () => mf.dispose() };
}

/** Build a copy on database `db`: the schema read, then the synthetic rows. Answers the number of objects loaded. */
export async function buildCopy(engine, db) {
  const statements = prodSchemaStatements();
  await engine.call({ op: "load", db, statements });
  await engine.call({ op: "seed", db, rows: syntheticRows() });
  return statements.length;
}

/* ------------------------------------------------------------------ the design doc, read as data */

const DOC_PATH = "docs/citycoin-master/schema-and-api.md";
export const DOC_SECTIONS = { "3.8": "cc5-ops", "3.2": "cc5-selection", "3.4": "cc5-activity", "3.3": "cc5-managers", "3.5": "cc5-metadata", "3.6": "cc5-launch", "3.7": "cc5-hourly" };
/** The SQL of section `n` (its ```sql blocks), comments removed. */
export function docSql(n) {
  const doc = read(DOC_PATH);
  const start = doc.indexOf(`### ${n} `);
  if (start < 0) throw new Error(`no section ${n}`);
  const end = doc.indexOf("\n### ", start + 5);
  return [...doc.slice(start, end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n").replace(/--[^\n]*/g, "");
}
/** Whitespace-normalized SQL, as sqlite_master stores it (IF NOT EXISTS is dropped there). */
export const normSql = (s) => String(s).replace(/--[^\n]*/g, "").replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s*;\s*$/, "")
  .replace(/^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS /, "CREATE $1 ").trim();
/** The statements of sections 3.2 to 3.8 (a statement ends at a semicolon at the end of a line; a trigger's inner one is followed by END). */
export function docStatements() {
  return Object.keys(DOC_SECTIONS).flatMap((n) => docSql(n).split(/;[ \t]*(?:\n|$)/).map((s) => s.trim()).filter(Boolean));
}
/** A database built straight from the doc's SQL (Node's SQLite through test/helpers/d1.js, independent of src/cc5schema.js), to compare a
 *  migrated copy with. */
export function docReference() {
  const db = d1();
  for (const n of Object.keys(DOC_SECTIONS)) db._raw.exec(docSql(n));
  return db;
}
/** The executor over the doc reference (database name "REF"), answering plain JSON like the engines do. */
export function makeExecutorForReference(ref) {
  const exec = makeExecutor({ REF: ref });
  return async (op) => jsonCopy(await exec(op));
}
/** The error names the stage record lists (docs/citycoin-master/schema-migrations.md section 4, "The names the writers see"). */
export function recordedErrorNames() {
  const text = read("docs/citycoin-master/schema-migrations.md");
  const start = text.indexOf("The names the writers see:");
  if (start < 0) throw new Error("schema-migrations.md: the list of error names is missing");
  return [...new Set([...text.slice(start, text.indexOf("\n\n", start)).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))];
}

function topLevelItems(body) {
  const items = [];
  let depth = 0, cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { items.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  return items.map((s) => s.replace(/\s+/g, " "));
}
const listOf = (s) => s.split(",").map((x) => x.trim());
const valuesOf = (s) => [...s.matchAll(/'([^']*)'/g)].map((m) => m[1]);

/**
 * The doc's tables as data: columns (type, NOT NULL, DEFAULT, PRIMARY KEY, AUTOINCREMENT, UNIQUE, CHECK as { in } or { between }), the
 * table's keys (every PRIMARY KEY and UNIQUE, as column lists) and its unique indexes ({ name, cols, where }). A CHECK or a WHERE of a form
 * this reader does not know throws, so a doc change cannot slip past the constraint tests.
 */
export function docModel() {
  const tables = {};
  for (const s of docStatements()) {
    const t = /^CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*)\)$/.exec(s.replace(/\s+/g, " "));
    if (t) {
      const model = { name: t[1], columns: [], keys: [], uniqueIndexes: [], indexes: [] };
      for (const item of topLevelItems(t[2])) {
        let m;
        if ((m = /^PRIMARY KEY \(([^)]*)\)$/.exec(item))) { model.keys.push({ kind: "pk", cols: listOf(m[1]) }); continue; }
        if ((m = /^UNIQUE \(([^)]*)\)$/.exec(item))) { model.keys.push({ kind: "unique", cols: listOf(m[1]) }); continue; }
        const c = /^(\w+) (\w+)(.*)$/.exec(item);
        if (!c) throw new Error(`docModel: ${t[1]}: cannot read "${item}"`);
        const rest = c[3];
        const col = { name: c[1], type: c[2], notNull: /NOT NULL/.test(rest), pk: /PRIMARY KEY/.test(rest), autoinc: /AUTOINCREMENT/.test(rest),
          unique: /\bUNIQUE\b/.test(rest), default: (/DEFAULT ('[^']*'|-?\d+)/.exec(rest) || [])[1] ?? null, check: null };
        const ck = /CHECK \((.*)\)$/.exec(rest.trim()) || /CHECK \((.*)\)/.exec(rest);
        if (ck) {
          let k;
          if ((k = new RegExp(`^${col.name} IN \\((.*)\\)$`).exec(ck[1].trim()))) col.check = { in: valuesOf(k[1]) };
          else if ((k = new RegExp(`^${col.name} BETWEEN (-?\\d+) AND (-?\\d+)$`).exec(ck[1].trim()))) col.check = { between: [Number(k[1]), Number(k[2])] };
          else throw new Error(`docModel: ${t[1]}.${col.name}: CHECK of an unknown form: ${ck[1]}`);
        }
        if (col.pk) model.keys.push({ kind: "pk", cols: [col.name] });
        if (col.unique) model.keys.push({ kind: "unique", cols: [col.name] });
        model.columns.push(col);
      }
      tables[model.name] = model;
      continue;
    }
    const ix = /^CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+) ON (\w+) \(([^)]*)\)(?: WHERE (.*))?$/.exec(s.replace(/\s+/g, " "));
    if (ix) {
      const entry = { name: ix[2], cols: listOf(ix[4]), where: ix[5] || null };
      if (entry.where && !/^(\w+) = '([^']*)'$|^(\w+) IN \((.*)\)$|^(\w+) IS NULL$/.test(entry.where)) throw new Error(`docModel: ${entry.name}: WHERE of an unknown form`);
      (ix[1] ? tables[ix[3]].uniqueIndexes : tables[ix[3]].indexes).push(entry);
    }
  }
  return tables;
}

/** The value of `col` that makes a row of the doc's table valid (k makes every free value distinct). */
export function docValue(col, k) {
  if (col.check && col.check.in) return col.check.in[0];
  if (col.check && col.check.between) return col.check.between[0];
  if (col.type === "INTEGER") return k;
  return `${col.name}-${k}`;
}
/** A valid row of a doc table: every NOT NULL column without a default and every PRIMARY KEY column (always bound: open item O9), plus
 *  `over`. An AUTOINCREMENT id is given explicitly (k) so the steps can name the row. */
export function docRow(model, k, over = {}) {
  const row = {};
  for (const c of model.columns) if ((c.notNull && c.default === null) || c.pk) row[c.name] = c.autoinc ? k : docValue(c, k);
  for (const key of model.keys.filter((x) => x.kind === "pk")) for (const name of key.cols) if (!(name in row)) row[name] = docValue(model.columns.find((c) => c.name === name), k);
  return { ...row, ...over };
}
/** Values for the columns `cols` shared by two rows (to collide on a key): `base` for an INTEGER, text otherwise, a valid value for a CHECK. */
export function sharedValues(model, cols, base) {
  return Object.fromEntries(cols.map((name) => {
    const c = model.columns.find((x) => x.name === name);
    if (c.check) return [name, c.check.in ? c.check.in[0] : c.check.between[0]];
    return [name, c.type === "INTEGER" ? base : `${name}-shared-${base}`];
  }));
}
/** INSERT of a row object (verb "INSERT INTO", "INSERT OR REPLACE INTO", ...; tail e.g. " ON CONFLICT ..."). */
export function insertStep(verb, table, row, tail = "", check = null) {
  const cols = Object.keys(row);
  return { sql: `${verb} ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})${tail}`, params: Object.values(row), ...(check ? { check } : {}) };
}
