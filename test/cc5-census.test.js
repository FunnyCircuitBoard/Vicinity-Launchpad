// Citycoin.dev master v5, stage S08: the census (scripts/citycoin/census.mjs) and the backup step before each migration
// (scripts/citycoin/backup.mjs), on the D1 copy of test/helpers/cc5-d1copy.js (the production schema read of 24 October 2026 with
// SYNTHETIC rows only: fake wallets, "Synthetic Member n", addresses under example.invalid). Three layers:
//   - the rules themselves (one SELECT per statement, the fixed column lists, paths outside the repository), pure;
//   - the census through a direct executor on Node's SQLite: counts, digests, privacy, sensitivity, a migration's before and after;
//   - the real command lines through `wrangler d1 execute --local` and `wrangler d1 export --local` on Cloudflare's local D1 (Miniflare
//     seeds a persisted copy in a temporary folder outside the repository; skipped with the reason only when workerd cannot start).
// Nothing here touches a remote resource: every `--remote` case runs in-process with a wrangler stand-in that fails the test if called.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CC5_GROUPS, CC5_ORDER } from "../src/cc5schema.js";
import {
  CATEGORIES, CC5_OBJECTS, CC5_TABLES, CENSUS_VERSION, CHURN_TABLES, COUNTS, HISTORY_TABLES, PRESERVED, SCHEMA_TYPES, assertSingleSelect, compareCensus, loadKey,
  main as censusMain, runCensus, wranglerExecutor,
} from "../scripts/citycoin/census.mjs";
import { groupClosure, main as backupMain, parseBookmark, parseFlags, planBackup, rehearsalHeld, validateRestore } from "../scripts/citycoin/backup.mjs";
import { REPO_ROOT, Refusal, outsideRepository, wranglerEnv } from "../scripts/citycoin/lib.mjs";
import { tableHash } from "./helpers/cc5-d1copy-worker.js";
import { buildCopy, miniflareEngine, nodeEngine, prodSchemaStatements, syntheticRows } from "./helpers/cc5-d1copy.js";
import { d1 } from "./helpers/d1.js";

const BUILT = CC5_ORDER.filter((id) => CC5_GROUPS[id]);
const ALL_CC5_TABLES = Object.values(CC5_TABLES).flat();
const TMP = mkdtempSync(path.join(os.tmpdir(), "cc5-census-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** Node's SQLite engine with `names` databases, and a census executor over one of them that records every statement. */
const node = nodeEngine(["MAIN", "MOVED", "MIGRATED", "PAGED", "SRC", "LOSSY", "CHURN"]);
function direct(db, seen = []) {
  return async (statements) => {
    const out = [];
    for (const s of statements) { seen.push(s); out.push((await db.prepare(s).all()).results); }
    return out;
  };
}
const copies = new Map();
const copy = (name) => {
  if (!copies.has(name)) copies.set(name, buildCopy(node, name));
  return copies.get(name);
};

/** The production schema read's tables and columns (in order), read straight from the fixture. */
function fixtureColumns() {
  const db = d1();
  for (const s of prodSchemaStatements()) db._raw.exec(s);
  const out = {};
  for (const { name } of db._raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    out[name] = db._raw.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name);
  }
  return out;
}
const FIXTURE = fixtureColumns();

/** Every synthetic string a census must never print (member-like values of every table), minus the census's own constant words. */
function syntheticValues() {
  const own = new Set([...Object.keys(FIXTURE), ...COUNTS.flatMap((c) => c.labels || []), ...PRESERVED, ...BUILT, CENSUS_VERSION]);
  const out = new Set();
  for (const [table, rows] of Object.entries(syntheticRows())) {
    if (table === "schema_migrations") continue;
    for (const row of rows) {
      for (const v of Object.values(row)) {
        if (typeof v === "string" && v.length >= 8 && !/^[a-z_]+$/.test(v) && !own.has(v)) out.add(v); // not the code words (statuses, providers, kinds)
        if (v && typeof v === "object" && typeof v.$blob === "string") out.add(v.$blob);
      }
    }
  }
  return [...out];
}
const SECRETS = syntheticValues();
function assertNoSyntheticValue(text, where) {
  const found = SECRETS.filter((v) => text.includes(v));
  assert.deepEqual(found.slice(0, 5), [], `${where} printed ${found.length} synthetic row values`);
  for (const marker of ["Synthetic Member", "example.invalid", "cc5-synthetic", "synthetic-"]) assert.ok(!text.includes(marker), `${where} printed "${marker}"`);
}

/** The schema object names a census may print: those of the production schema read and of the cc5 groups. */
const OBJECT_NAMES = (() => {
  const db = d1();
  for (const s of prodSchemaStatements()) db._raw.exec(s);
  return new Set([...db._raw.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map((r) => r.name), ...Object.values(CC5_OBJECTS).flat()]);
})();

/** Every key and every string of a census output is a constant of the census, a table or schema object name, a digest or the run's own name and time. */
function assertOnlyCountsAndDigests(census) {
  const tables = new Set([...Object.keys(FIXTURE), ...ALL_CC5_TABLES, ...HISTORY_TABLES]);
  const keys = new Set([
    "census", "database", "target", "at", "digest", "algorithm", "key_fingerprint", "checks", "duplicate_wallets_zero", "counts", "absent", "tables",
    "tables_with_unprintable_names", "history_tables", "present", "cc5", "recorded", "absent_tables", "digests", "rows", "parts", "missing", "group",
    "schema", "objects", "objects_with_unprintable_names", "unprintable_digest", ...SCHEMA_TYPES,
    ...COUNTS.flatMap((c) => [c.key, ...(c.fields || []), ...(c.labels || [])]), ...PRESERVED,
  ]);
  const missingNames = new Set(Object.values(CATEGORIES).flat().map((p) => p.table));
  const fixed = new Set([CENSUS_VERSION, census.database, census.target, "sha256", "hmac-sha256", ...BUILT, "cc5-identity", ...COUNTS.map((c) => c.key)]);
  const walk = (v, key) => {
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "number") { assert.ok(Number.isSafeInteger(v) && v >= 0, `${key}: ${v} is not a count`); return; }
    if (typeof v === "string") {
      const ok = /^[0-9a-f]{64}$/.test(v) || (key === "key_fingerprint" && /^[0-9a-f]{16}$/.test(v)) || (key === "at" && !Number.isNaN(Date.parse(v)))
        || fixed.has(v) || tables.has(v) || (key === "missing" && missingNames.has(v.split(".")[0]));
      assert.ok(ok, `${key}: a string the census must not print`);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, key)); return; }
    for (const [k, x] of Object.entries(v)) {
      assert.ok(keys.has(k) || tables.has(k) || (key === "objects" && OBJECT_NAMES.has(k)), `the key ${JSON.stringify(k)} is not a census constant, a table or a schema object name`);
      walk(x, k);
    }
  };
  walk(census, "");
}

/** The census's counts computed in JavaScript from the synthetic rows, for the clock `now`. */
function expectedCounts(rows, now) {
  const users = rows.users.filter((u) => u.provider !== "testlab");
  const logins = new Set(rows.user_logins.map((l) => l.user_id));
  const live = (s) => s.user_id !== null && s.expires_at > now;
  const tally = (list, f, labels) => Object.fromEntries(labels.map((l) => [l, list.filter((x) => f(x) === l).length]));
  return {
    users: { total: rows.users.length, testlab: rows.users.length - users.length, with_wallet: users.filter((u) => u.wallet).length, with_city: users.filter((u) => u.home_city).length },
    users_by_r1_case: tally(users, (u) => (u.wallet && u.home_city ? "M1" : u.wallet ? "M2" : ["google", "email"].includes(u.provider) ? "M3" : "other"), ["M1", "M2", "M3", "other"]),
    users_by_sign_in: tally(users, (u) => (u.wallet && (["google", "email"].includes(u.provider) || logins.has(u.id)) ? "wallet_and_provider" : u.wallet ? "wallet_only"
      : u.provider === "google" ? "provider_only" : u.provider === "email" ? "email_only" : "other"), ["wallet_and_provider", "wallet_only", "provider_only", "email_only", "other"]),
    duplicate_wallets: 0,
    cities_with_members: new Set(users.filter((u) => u.home_city).map((u) => u.home_city)).size,
    live_sessions_by_proof: tally(rows.sessions.filter(live), (s) => (s.proven_at ? "wallet_proven" : "not_wallet_proven"), ["wallet_proven", "not_wallet_proven"]),
    sessions: { total: rows.sessions.length, expired: rows.sessions.filter((s) => s.expires_at <= now).length, without_user: rows.sessions.filter((s) => s.user_id === null).length,
      without_wallet: rows.sessions.filter((s) => s.wallet === null).length },
    seats_by_status: { provisional: 0, active: 0, grace: 0, steward: 0, released: 0, revoked: 0, other: rows.seats.length }, // the copy's seats are 'ended' history
    live_seats: 0,
    open_windows: rows.windows.filter((w) => w.status === "open").length,
    open_elections: rows.elections.filter((w) => w.status === "open").length,
    live_manager_terms: rows.manager_terms.filter((m) => ["upcoming", "active"].includes(m.status)).length,
    claims: rows.claims.length,
    posts: { total: rows.posts.length, replies: rows.posts.filter((p) => p.parent_id !== null).length, hidden: rows.posts.filter((p) => p.hidden).length, deleted: rows.posts.filter((p) => p.deleted_at).length },
    city_coins: { total: rows.city_coins.length, with_mint: rows.city_coins.filter((c) => c.mint).length, launched: rows.city_coins.filter((c) => c.launched_at).length },
    lp_coins_by_cluster: tally(rows.lp_coins, (r) => (["mainnet", "devnet"].includes(r.cluster) ? r.cluster : "other"), ["mainnet", "devnet", "other"]),
    admin_tokens: rows.admin_tokens.length,
    lp_approvals_log_by_cluster: tally(rows.lp_approvals_log, (r) => r.cluster, ["mainnet", "devnet", "other"]),
    lp_setup_by_cluster: tally(rows.lp_setup, (r) => r.cluster, ["mainnet", "devnet", "other"]),
    schema_migrations: { total: rows.schema_migrations.length, cc5: 0 },
    cc5_records: Object.fromEntries([...CC5_ORDER, "other"].map((id) => [id, 0])),
  };
}
const without = (c, ...keys) => { const x = { ...c }; for (const k of keys) delete x[k]; return x; };

/* ------------------------------------------------------------------ Cloudflare's local D1 copy for the command-line runs (seeded before any test is registered) */

const DB_NAME = "cc5-census-copy";
const DB_ID = "00000000-0000-4000-8000-00000000c5c5";
const LOCAL = path.join(TMP, "local");
const CONFIG = path.join(LOCAL, "wrangler.json");
const LOGS = path.join(TMP, "wrangler-logs");
mkdirSync(LOCAL, { recursive: true });
writeFileSync(CONFIG, JSON.stringify({ name: "cc5-census-test", compatibility_date: "2026-09-01", d1_databases: [{ binding: "DB", database_name: DB_NAME, database_id: DB_ID }] }));
const persisted = () => miniflareEngine(["COPY"], { persistDir: path.join(LOCAL, ".wrangler", "state", "v3"), databaseIds: { COPY: DB_ID } });

let seeded = null, mfSkip = false;
try {
  const mf = await persisted();
  try { await buildCopy(mf, "COPY"); seeded = await mf.call({ op: "snapshot", db: "COPY" }); }
  finally { await mf.dispose(); }
} catch (e) {
  mfSkip = `Cloudflare's local D1 (workerd) is unavailable here, so the command-line runs were skipped: ${String(e.message).slice(0, 200)}`;
}

function cli(script, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(REPO_ROOT, "scripts", "citycoin", script), ...args], { cwd: REPO_ROOT, env: { ...process.env, WRANGLER_LOG_PATH: LOGS }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const logFiles = () => (existsSync(LOGS) ? readdirSync(LOGS) : []);

/* ------------------------------------------------------------------ the rules */

test("census: assertSingleSelect accepts one SELECT and refuses everything else, naming the reason and never echoing a literal", () => {
  for (const ok of ["SELECT 1", "select name from sqlite_master where type = 'table'", "SELECT quote(\"a\") || ',' || quote(\"b\") AS line FROM \"t\" ORDER BY line LIMIT 5 OFFSET 0",
    "SELECT 'it''s; -- not a comment /* nor this */' AS x", "SELECT name FROM pragma_table_info('users') ORDER BY cid", "SELECT \"weird;name\" FROM t",
    "SELECT COUNT(*) AS n FROM seats WHERE status IN ('released', 'revoked')"]) assert.equal(assertSingleSelect(ok), ok);
  const refused = {
    "": /empty/, "   ": /empty/, "INSERT INTO users (id) VALUES (1)": /not a SELECT/, "UPDATE users SET wallet = NULL": /not a SELECT/,
    "DELETE FROM users": /not a SELECT/, "SELECT 1; DROP TABLE users": /more than one statement/, "SELECT 1;": /more than one statement/,
    "SELECT 1 -- x": /comment/, "SELECT /* x */ 1": /comment/, "WITH x AS (SELECT 1) SELECT * FROM x": /not a SELECT/, "PRAGMA table_info(users)": /not a SELECT/,
    "SELECT * FROM users WHERE 1 = (SELECT 1 FROM (DELETE FROM users RETURNING 1))": /keyword DELETE/, "SELECT load_extension('x')": /LOAD_EXTENSION/,
    "SELECT 'unterminated": /unterminated quote/, "SELECT `a` FROM t": /backtick/, "SELECT [a] FROM t": /bracket/, "EXPLAIN SELECT 1": /not a SELECT/,
    "REPLACE INTO t VALUES (1)": /not a SELECT/, "SELECT 1 UNION SELECT 2 FROM t; ATTACH DATABASE 'x' AS y": /more than one statement/,
    "ATTACH DATABASE 'file' AS x": /not a SELECT/, "SELECT * FROM t\u0000": /control character/, "VACUUM": /not a SELECT/, "BEGIN": /not a SELECT/,
    "SELECT 1 FROM t WHERE x IN (SELECT 1) RETURNING *": /RETURNING/, "SELECT 1 FROM pragma_table_info('t'); PRAGMA writable_schema = 1": /more than one statement/,
  };
  for (const [sql, why] of Object.entries(refused)) {
    assert.throws(() => assertSingleSelect(sql), (e) => e instanceof Refusal && why.test(e.message) && !e.message.includes("'x'") && !e.message.includes("file"), sql);
  }
  for (const bad of [null, undefined, 42, {}]) assert.throws(() => assertSingleSelect(bad), Refusal);
  assert.throws(() => assertSingleSelect(`SELECT ${"1, ".repeat(10_000)}1`), /over-long/);
});

test("census: the digest columns are the production schema read's, every users column is in exactly one of wallets, profiles and locations, and every other part is its whole table in order", () => {
  for (const [category, parts] of Object.entries(CATEGORIES)) {
    for (const p of parts) {
      assert.ok(FIXTURE[p.table], `${category}: ${p.table} is a table of the production schema read`);
      for (const c of p.columns) assert.ok(FIXTURE[p.table].includes(c), `${category}: ${p.table}.${c}`);
      if (p.table !== "users") assert.deepEqual([...p.columns], FIXTURE[p.table], `${category}: ${p.table} covers every column, in order`);
    }
  }
  const usersParts = Object.values(CATEGORIES).flat().filter((p) => p.table === "users");
  const covered = usersParts.flatMap((p) => p.columns.filter((c) => c !== "id"));
  assert.deepEqual([...covered].sort(), FIXTURE.users.filter((c) => c !== "id").sort(), "each users column once (the id in each part)");
  assert.equal(new Set(covered).size, covered.length);
  for (const c of COUNTS) for (const [t, cols] of Object.entries(c.needs)) for (const col of cols) assert.ok(FIXTURE[t] && FIXTURE[t].includes(col), `${c.key} needs ${t}.${col}`);
  assert.deepEqual(Object.keys(CC5_TABLES), BUILT);
  assert.equal(ALL_CC5_TABLES.length, 26, "the 26 tables of src/cc5schema.js");
  for (const t of ALL_CC5_TABLES) assert.ok(!FIXTURE[t], `${t} is new`);
});

test("lib: export, key and output paths must be outside the repository and every git work tree, without '..', through symlinks", () => {
  const ok = path.join(TMP, "paths", "backup.sql");
  mkdirSync(path.dirname(ok), { recursive: true });
  assert.equal(outsideRepository(ok, "x"), ok);
  assert.equal(outsideRepository(path.join(TMP, "paths", "new-folder", "b.sql"), "x"), path.join(TMP, "paths", "new-folder", "b.sql"));
  const link = path.join(TMP, "paths", "into-repo");
  symlinkSync(path.join(REPO_ROOT, "docs"), link);
  const fakeRepo = path.join(TMP, "paths", "other-repo");
  mkdirSync(path.join(fakeRepo, ".git"), { recursive: true });
  for (const [p, why] of [
    [path.join(REPO_ROOT, "backup.sql"), /outside the repository/], [REPO_ROOT, /outside the repository/], ["backup.sql", /outside the repository/],
    [path.join(REPO_ROOT, ".git", "b.sql"), /outside the repository/], [path.join(REPO_ROOT, "nope", "deeper", "b.sql"), /outside the repository/],
    [path.join(link, "b.sql"), /outside the repository/], [`${TMP}/paths/../x.sql`, /without ".." segments/],
    [path.join(fakeRepo, "b.sql"), /git work tree/], ["", /a path is required/],
  ]) assert.throws(() => outsideRepository(p, "the export file"), (e) => e instanceof Refusal && why.test(e.message), p);
  const env = wranglerEnv({ PATH: "/bin" });
  assert.deepEqual([env.WRANGLER_WRITE_LOGS, env.WRANGLER_SEND_METRICS, env.WRANGLER_HIDE_BANNER, env.CLOUDFLARE_CF_FETCH_ENABLED, env.PATH], ["false", "false", "true", "false", "/bin"]);
});

test("backup: groups and switch values name the groups with prerequisites in order; cc5-identity and unknown ids are refused; a bookmark is read only in its own shape", () => {
  assert.deepEqual(groupClosure(["cc5-managers"]), ["cc5-ops", "cc5-selection", "cc5-activity", "cc5-managers"]);
  assert.deepEqual(groupClosure(["cc5-launch", "cc5-hourly"]), ["cc5-ops", "cc5-metadata", "cc5-launch", "cc5-hourly"]);
  assert.throws(() => groupClosure(["cc5-identity"]), /stage S09/);
  assert.throws(() => groupClosure(["users"]), /unknown group/);
  assert.deepEqual(parseFlags("SELECTION_V5=shadow, CC_HOURLY=on"), { SELECTION_V5: "shadow", CC_HOURLY: "on" });
  for (const bad of ["SELECTION_V5", "selection_v5=on", "A=b;rm", "SELECTION_V5=on x"]) assert.throws(() => parseFlags(bad), Refusal, bad);
  assert.equal(parseBookmark('{\n  "bookmark": "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683"\n}\n'), "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683");
  assert.equal(parseBookmark('Proxy environment variables detected.\n{"bookmark":"0000000a-00000001-00004e5f-0123abcd"}'), "0000000a-00000001-00004e5f-0123abcd");
  for (const bad of ["", "{}", '{"bookmark": "; rm -rf /"}', '{"bookmark": 5}', "not json", `{"bookmark":"${"a-".repeat(80)}a"}`]) assert.throws(() => parseBookmark(bad), Refusal, bad);
  const steps = planBackup({ database: "vicinity-claims", target: "remote", config: null, exportFile: "/safe/b.sql", restoreDir: "/safe/b.sql.restore", keyFile: "/safe/k",
    groups: ["cc5-ops", "cc5-selection"], yes: false });
  assert.deepEqual(steps.map((s) => s.id), ["bookmark", "census-source", "export", "restore-copy", "census-restored", "rehearse", "census-rehearsed"]);
  assert.deepEqual(steps[0].argv, ["d1", "time-travel", "info", "vicinity-claims", "--json"]);
  assert.deepEqual(steps[2].argv, ["d1", "export", "vicinity-claims", "--remote", "--output", "/safe/b.sql", "--skip-confirmation"], "the confirmation is --yes on our side; wrangler's output is never shown");
  assert.deepEqual(steps[3].argv, ["d1", "execute", "cc5-restored-copy", "--local", "--config", "/safe/b.sql.restore/wrangler.json", "--file", "/safe/b.sql"], "the restore writes a NEW local database, never the source");
  for (const s of steps) if (s.argv && s.id !== "bookmark" && s.id !== "export") assert.ok(!s.argv.includes("--remote"), `${s.id} never touches the remote database`);
  assert.ok(steps[1].shell.includes("--key-file"));
});

/* ------------------------------------------------------------------ the census on Node's SQLite */

test("census on the copy (node:sqlite): the counts equal the synthetic rows', every statement is one SELECT, nothing in the copy changes, and the full-table digests equal the harness's row hash", async () => {
  await copy("MAIN");
  const db = node.env.MAIN;
  const before = await node.call({ op: "snapshot", db: "MAIN" });
  const seen = [];
  const now = new Date().toISOString();
  const c = await runCensus(direct(db, seen), { database: "copy", target: "local" });
  assert.equal(c.census, CENSUS_VERSION);
  assert.deepEqual(c.counts, expectedCounts(syntheticRows(), now));
  assert.deepEqual(c.checks, { duplicate_wallets_zero: true });
  assert.deepEqual(c.absent, []);
  assert.deepEqual(c.tables, Object.fromEntries(Object.entries(syntheticRows()).map(([t, rows]) => [t, rows.length]).sort(([a], [b]) => (a < b ? -1 : 1))));
  assert.deepEqual(c.history_tables.absent, ["coin_requests", "coin_screenings", "coin_ready", "coin_legacy_designs", "coin_versions"], "the COIN_V2 tables never ran in production");
  assert.deepEqual([c.cc5.recorded, c.cc5.tables, c.cc5.absent_tables], [[], {}, ALL_CC5_TABLES]);
  assert.ok(seen.length > 100);
  for (const s of seen) assert.equal(assertSingleSelect(s), s);
  assert.deepEqual(await node.call({ op: "snapshot", db: "MAIN" }), before, "the census wrote nothing");
  for (const [category, parts] of Object.entries(CATEGORIES)) {
    assert.deepEqual(c.digests[category].missing, []);
    for (const p of parts.filter((x) => x.table !== "users")) {
      const h = await tableHash(db, p.table);
      assert.deepEqual(c.digests[category].parts[p.table], { rows: h.count, digest: h.sha256 }, `${category}.${p.table} is tableHash's sha256`);
    }
  }
  assert.equal(c.digests.wallets.rows, 4);
  assert.equal(c.digests.locations.rows, 5);
});

test("census output (node:sqlite): no synthetic wallet, address, e-mail, name, handle, token, body or blob, and only census constants, table names, counts and digests", async () => {
  await copy("MAIN");
  const c = await runCensus(direct(node.env.MAIN), { database: "copy", target: "local" });
  assertNoSyntheticValue(JSON.stringify(c), "the census");
  assertOnlyCountsAndDigests(c);
  assert.ok(SECRETS.length > 200, `scanned for ${SECRETS.length} synthetic values`);
});

test("census sensitivity and --compare semantics: one changed wallet or post changes exactly its category; churn outside the preserved data does not fail the comparison", async () => {
  await copy("MAIN");
  await copy("MOVED");
  const a = await runCensus(direct(node.env.MAIN), { database: "copy", target: "local" });
  const same = compareCensus(a, await runCensus(direct(node.env.MOVED), { database: "moved", target: "local" }));
  assert.equal(same.ok, true);
  assert.deepEqual(same.counts_changed, []);
  const raw = node.env.MOVED._raw;
  raw.prepare("UPDATE sessions SET expires_at = ? WHERE id = (SELECT MIN(id) FROM sessions)").run("2000-01-01T00:00:00.000Z");
  const churn = compareCensus(a, await runCensus(direct(node.env.MOVED), { database: "moved", target: "local" }));
  assert.equal(churn.ok, true, "sessions are not preserved data");
  assert.ok(churn.counts_changed.some((x) => x.count.startsWith("sessions.") || x.count.startsWith("live_sessions")));
  raw.prepare("UPDATE users SET wallet = ? WHERE id = 2").run("SyntheticReplacementWa11et111111111111111111");
  const moved = compareCensus(a, await runCensus(direct(node.env.MOVED), { database: "moved", target: "local" }));
  assert.equal(moved.ok, false);
  assert.deepEqual(Object.entries(moved.categories).filter(([, v]) => v === "changed").map(([k]) => k), ["wallets"]);
  assert.deepEqual(moved.parts_changed, ["wallets.users"]);
  raw.prepare("UPDATE posts SET body = body || '.' WHERE id = 3").run();
  raw.prepare("DELETE FROM lp_setup WHERE rowid = (SELECT MIN(rowid) FROM lp_setup)").run();
  const more = compareCensus(a, await runCensus(direct(node.env.MOVED), { database: "moved", target: "local" }));
  assert.deepEqual(Object.entries(more.categories).filter(([, v]) => v === "changed").map(([k]) => k), ["wallets", "posts", "onchain"]);
  assert.deepEqual(more.tables.row_counts_changed, [{ table: "lp_setup", before: 3, after: 2 }]);
  raw.exec("DROP TABLE mutes");
  const dropped = compareCensus(a, await runCensus(direct(node.env.MOVED), { database: "moved", target: "local" }));
  assert.deepEqual(dropped.tables.removed, ["mutes"]);
  assert.equal(dropped.categories.community, "changed");
  assert.throws(() => compareCensus(a, { census: "other" }), Refusal);
});

test("census before and after every group on the copy (the migration check of section 3.10 step 1): preserved data and every existing row count unchanged, the 26 tables and 7 records added", async () => {
  await copy("MIGRATED");
  const beforeC = await runCensus(direct(node.env.MIGRATED), { database: "copy", target: "local" });
  const r = await node.call({ op: "ensure", db: "MIGRATED", ids: BUILT, isolate: "fresh" });
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
  const afterC = await runCensus(direct(node.env.MIGRATED), { database: "copy", target: "local" });
  const cmp = compareCensus(beforeC, afterC);
  assert.equal(cmp.ok, true);
  assert.deepEqual(cmp.categories, Object.fromEntries(PRESERVED.map((k) => [k, "same"])));
  assert.deepEqual(cmp.tables.added.sort(), [...ALL_CC5_TABLES].sort());
  assert.deepEqual(cmp.tables.row_counts_changed, [{ table: "schema_migrations", before: 22, after: 29 }]);
  assert.deepEqual(cmp.cc5.recorded_added, BUILT);
  assert.deepEqual(afterC.cc5.recorded, BUILT);
  // the schema: every existing object kept byte for byte, exactly the groups' objects added (SQLite's automatic indexes are not counted)
  assert.deepEqual([cmp.schema.status, cmp.schema.removed, cmp.schema.changed, cmp.schema.unprintable_changed], ["added", [], [], false]);
  assert.deepEqual([...cmp.schema.added].sort(), Object.values(CC5_OBJECTS).flat().sort());
  assert.equal(Object.values(CC5_OBJECTS).flat().length, 106);
  for (const [name, digest] of Object.entries(beforeC.schema.objects)) assert.equal(afterC.schema.objects[name], digest, name);
  assert.deepEqual(afterC.cc5.absent_tables, []);
  assert.equal(afterC.counts.schema_migrations.cc5, 7);
  for (const t of ALL_CC5_TABLES) {
    const h = await tableHash(node.env.MIGRATED, t);
    assert.deepEqual({ rows: afterC.cc5.tables[t].rows, digest: afterC.cc5.tables[t].digest }, { rows: 0, digest: h.sha256 }, t);
  }
  assertOnlyCountsAndDigests(afterC);
  assertNoSyntheticValue(JSON.stringify(afterC), "the census after the groups");
});

test("census digest key: HMAC-SHA256 under a key kept outside the repository (created 0600), same key same digests, a published census cannot be compared without it", async () => {
  await copy("MAIN");
  const keyFile = path.join(TMP, "keys", "census.key");
  mkdirSync(path.dirname(keyFile), { recursive: true });
  let created = null;
  const k1 = loadKey(keyFile, { onCreate: (f) => { created = f; } });
  assert.equal(created, keyFile);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(loadKey(keyFile).equals(k1), "the second run reads the same key");
  const plain = await runCensus(direct(node.env.MAIN), { database: "copy" });
  const keyed = await runCensus(direct(node.env.MAIN), { database: "copy", key: k1 });
  const again = await runCensus(direct(node.env.MAIN), { database: "copy", key: loadKey(keyFile) });
  assert.equal(keyed.digest.algorithm, "hmac-sha256");
  assert.match(keyed.digest.key_fingerprint, /^[0-9a-f]{16}$/);
  assert.ok(!readFileSync(keyFile, "utf8").includes(keyed.digest.key_fingerprint));
  assert.deepEqual(keyed.counts, plain.counts);
  for (const cat of PRESERVED) assert.notEqual(keyed.digests[cat].digest, plain.digests[cat].digest);
  assert.equal(compareCensus(keyed, again).ok, true);
  assert.throws(() => compareCensus(plain, keyed), /different digest keys/);
  chmodSync(keyFile, 0o644);
  assert.throws(() => loadKey(keyFile), /readable by others/);
  const bad = path.join(TMP, "keys", "bad.key");
  writeFileSync(bad, "not a key\n", { mode: 0o600 });
  assert.throws(() => loadKey(bad), /32-byte hex key/);
  assert.throws(() => loadKey(path.join(REPO_ROOT, "census.key")), /outside the repository/);
  assert.ok(!existsSync(path.join(REPO_ROOT, "census.key")));
});

test("census paging and missing tables: small pages give the same digests; an empty database and a table without its columns are reported as absent, never guessed; duplicate wallets fail the check", async () => {
  await copy("PAGED");
  const full = await runCensus(direct(node.env.PAGED), { database: "copy" });
  const paged = await runCensus(direct(node.env.PAGED), { database: "copy", pageRows: 2 });
  assert.deepEqual(paged.digests, full.digests);
  const empty = await runCensus(direct(d1()), { database: "empty" });
  assert.deepEqual([empty.tables, empty.counts, empty.checks.duplicate_wallets_zero], [{}, {}, null]);
  assert.deepEqual(empty.absent, COUNTS.map((c) => c.key));
  assert.deepEqual(empty.digests.wallets.missing, ["users"]);
  assert.equal(empty.digests.wallets.rows, 0);
  const odd = d1();
  odd._raw.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, wallet TEXT, provider TEXT, home_city TEXT); CREATE TABLE \"we ird\" (x)");
  odd._raw.exec("INSERT INTO users (wallet, provider, home_city) VALUES ('W1', 'wallet', 'c'), ('W1', 'wallet', 'c'), (NULL, 'testlab', NULL)");
  const dup = await runCensus(direct(odd), { database: "odd" });
  assert.equal(dup.counts.duplicate_wallets, 1);
  assert.equal(dup.checks.duplicate_wallets_zero, false);
  assert.deepEqual(dup.counts.users, { total: 3, testlab: 1, with_wallet: 2, with_city: 2 });
  assert.equal(dup.tables_with_unprintable_names, 1);
  assert.deepEqual(Object.keys(dup.tables), ["users"], "a table name the census cannot print safely is counted, not printed");
  assert.match(dup.digests.profiles.missing[0], /^users\.provider_id,handle,name/);
  assert.ok(!JSON.stringify(dup).includes("W1"));
});

test("census through wrangler (stand-in runner): only checked SELECTs in each --command, the arguments are read-only, and a failure never echoes what wrangler printed", async () => {
  const calls = [];
  const fake = (answer) => async (args) => { calls.push(args); return answer(args); };
  const answerOf = (st) => (st.startsWith("SELECT type, name, tbl_name, sql FROM sqlite_master") ? [{ type: "table", name: "claims", tbl_name: "claims", sql: "CREATE TABLE claims (city_id TEXT)" }]
    : st === "SELECT name FROM pragma_table_info('claims') ORDER BY cid" ? FIXTURE.claims.map((name) => ({ name }))
    : st.startsWith("SELECT name FROM pragma_table_info(") || st.startsWith("SELECT quote(") ? [] : [{ n: 0 }]);
  const rowsFor = (args) => JSON.stringify(args[6].split(";\n").map((st) => ({ results: answerOf(st), success: true, meta: {} })));
  const exec = wranglerExecutor({ database: "vicinity-claims", target: "local", config: "/x/wrangler.json", run: fake((args) => ({ code: 0, stdout: rowsFor(args), stderr: "" })) });
  const c = await runCensus(exec, { database: "vicinity-claims" });
  assert.deepEqual([c.tables, c.counts.claims, c.digests.founders.parts.claims.rows], [{ claims: 0 }, 0, 0]);
  assert.equal(calls.length, 2, "one call for the tables and columns, one for everything else");
  for (const args of calls) {
    assert.deepEqual(args.slice(0, 6), ["d1", "execute", "vicinity-claims", "--local", "--json", "--command"]);
    assert.deepEqual(args.slice(7), ["--config", "/x/wrangler.json"]);
    for (const s of args[6].split(";\n")) assertSingleSelect(s);
  }
  const secret = "SyntheticSecretRowValue";
  const failing = wranglerExecutor({ database: "vicinity-claims", target: "local", run: fake(() => ({ code: 1, stdout: `[{"results":[{"line":"${secret}"}]}]\n{"error":{"text":"no such table: x"}}`, stderr: "" })) });
  await assert.rejects(failing(["SELECT 1"]), (e) => /exit 1/.test(e.message) && !e.message.includes(secret));
  const garbled = wranglerExecutor({ database: "vicinity-claims", target: "local", run: fake(() => ({ code: 0, stdout: `[{"results":[{"line":"${secret}"}],"success":true}, {}]`, stderr: "" })) });
  await assert.rejects(garbled(["SELECT 1"]), (e) => /cannot read/.test(e.message) && !e.message.includes(secret));
  await assert.rejects(exec(["DELETE FROM users"]), /not a SELECT/);
  assert.throws(() => wranglerExecutor({ database: "--remote", target: "local" }), Refusal);
  assert.throws(() => wranglerExecutor({ database: "x", target: "production" }), Refusal);
});

test("command lines refuse before running anything: --remote without a key, paths inside the repository, existing exports, unknown or S09 groups, two targets, --execute without a target", async () => {
  const run = async () => { throw new Error("wrangler must not run"); };
  const rehearse = async () => { throw new Error("no rehearsal must run"); };
  const quiet = { out: () => {}, err: () => {}, run, rehearse };
  const existing = path.join(TMP, "refusals", "exists.sql");
  mkdirSync(path.dirname(existing), { recursive: true });
  writeFileSync(existing, "");
  const key = path.join(TMP, "refusals", "k.key");
  for (const argv of [
    ["--remote"], ["--remote", "--local"], ["--out", path.join(REPO_ROOT, "census.json")], ["--key-file", path.join(REPO_ROOT, "k")], ["--database", "--x"],
    ["--compare", "a.json"], ["--bogus"], ["stray"],
    // finding SEC-8: a config outside the repository needs a key or an explicit --unkeyed; --remote never takes --unkeyed
    ["--local", "--config", CONFIG], ["--remote", "--unkeyed"], ["--unkeyed", "--key-file", key],
  ]) {
    let err = "";
    assert.equal(await censusMain(argv, { ...quiet, err: (s) => { err += s; } }), 2, argv.join(" "));
    assert.ok(err.length > 0);
  }
  for (const argv of [
    ["--remote", "--execute"], ["--execute"], ["--remote", "--local", "--execute"], ["--local", "--execute", "--export", path.join(REPO_ROOT, "b.sql")],
    ["--local", "--execute", "--export", existing], ["--local", "--groups", "cc5-identity", "--export", path.join(TMP, "refusals", "n.sql")],
    ["--local", "--groups", "users", "--export", path.join(TMP, "refusals", "n.sql")], ["--local", "--groups", "cc5-ops"], ["--flags", "SELECTION_V5"],
    ["--local", "--groups", "cc5-ops", "--flags", "SELECTION_V5=on"], ["--remote", "--execute", "--key-file", key, "--export", path.join(TMP, "nofolder", "b.sql")],
    // finding SEC-1: a remote export needs --yes (wrangler's own prompt is never shown); finding SEC-8: keys
    ["--remote", "--execute", "--key-file", key, "--export", path.join(TMP, "refusals", "r.sql")], ["--remote", "--execute", "--unkeyed"],
    ["--local", "--execute", "--config", CONFIG], ["--local", "--execute", "--export", path.join(TMP, "refusals", "k.sql")],
  ]) assert.equal(await backupMain(argv, quiet), 2, argv.join(" "));
  assert.ok(!existsSync(path.join(TMP, "refusals", "r.sql")) && !existsSync(path.join(TMP, "refusals", "k.sql")));
  assert.ok(!existsSync(key), "no key was created by a refused run");
  assert.ok(!existsSync(path.join(TMP, "refusals", "n.sql")));
});

test("schema in the census (findings F1, SEC-3): a restore that loses triggers and indexes is NOT a valid backup, a dropped guard shows in --compare, and the data digests alone would not have seen it", async () => {
  for (const name of ["SRC", "LOSSY"]) {
    await buildCopy(node, name);
    const r = await node.call({ op: "ensure", db: name, ids: ["cc5-selection"], isolate: "fresh" });
    assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
  }
  const source = await runCensus(direct(node.env.SRC), { database: "copy", target: "local" });
  // the lossy restore of the finding: the same rows, every named index and every trigger gone
  const raw = node.env.LOSSY._raw;
  const lost = raw.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL").all();
  for (const o of lost) raw.exec(`DROP ${o.type.toUpperCase()} "${o.name}"`);
  const lossy = await runCensus(direct(node.env.LOSSY), { database: "lossy", target: "local" });
  assert.deepEqual(lossy.digests, source.digests, "every data digest is the same: the old validation passed this restore");
  assert.deepEqual(lossy.tables, source.tables);
  const v = validateRestore(source, lossy);
  assert.equal(v.valid, false);
  assert.equal(v.compare.ok, false);
  assert.equal(v.compare.schema.status, "changed");
  assert.deepEqual([...v.compare.schema.removed].sort(), lost.map((o) => o.name).sort());
  assert.ok(v.compare.schema.removed.includes("founder_records_no_overwrite") && v.compare.schema.removed.includes("selection_cycles_one_winner"));
  assert.ok(lossy.schema.counts.trigger === 0 && source.schema.counts.trigger > 0);
  // the probe of SEC-3: two guards dropped by hand on a database that has its group recorded
  const hand = await runCensus(direct(node.env.SRC), { database: "copy", target: "local" });
  node.env.SRC._raw.exec("DROP TRIGGER founder_records_no_overwrite; DROP TRIGGER founder_records_no_update");
  const after = await runCensus(direct(node.env.SRC), { database: "copy", target: "local" });
  const cmp = compareCensus(hand, after);
  assert.deepEqual([cmp.ok, cmp.schema.status, cmp.schema.removed.sort()], [false, "changed", ["founder_records_no_overwrite", "founder_records_no_update"]]);
  assert.deepEqual(Object.values(cmp.categories), PRESERVED.map(() => "same"));
  // a changed object (same name, other SQL) is a change too
  node.env.SRC._raw.exec("CREATE TRIGGER founder_records_no_update BEFORE UPDATE ON founder_records WHEN 0 BEGIN SELECT 1; END");
  const weaker = compareCensus(hand, await runCensus(direct(node.env.SRC), { database: "copy", target: "local" }));
  assert.deepEqual([weaker.ok, weaker.schema.removed, weaker.schema.changed], [false, ["founder_records_no_overwrite"], ["founder_records_no_update"]]);
  assertOnlyCountsAndDigests(lossy);
});

test("rehearsal check (finding F1): the objects added must be exactly the groups' objects; a missing trigger or an extra object does not hold", async () => {
  await copy("MAIN");
  const ids = ["cc5-ops", "cc5-selection"];
  const before = await runCensus(direct(node.env.MAIN), { database: "copy", target: "local" });
  const fake = (mutate) => {
    const after = JSON.parse(JSON.stringify(before));
    for (const o of ids.flatMap((id) => CC5_OBJECTS[id])) after.schema.objects[o] = "f".repeat(64);
    for (const tb of ids.flatMap((id) => CC5_TABLES[id])) after.tables[tb] = 0;
    after.tables.schema_migrations += 2;
    after.cc5.recorded = [...ids];
    after.schema.digest = "e".repeat(64);
    mutate(after);
    return after;
  };
  assert.equal(rehearsalHeld(before, fake(() => {}), ids, ids).held, true);
  assert.equal(rehearsalHeld(before, fake((a) => { delete a.schema.objects.founder_records_no_overwrite; }), ids, ids).held, false, "a guard missing");
  assert.equal(rehearsalHeld(before, fake((a) => { a.schema.objects.users_extra_index = "1".repeat(64); }), ids, ids).held, false, "an object outside the groups");
  assert.equal(rehearsalHeld(before, fake((a) => { a.schema.objects.users = "2".repeat(64); }), ids, ids).held, false, "an existing object changed");
  assert.equal(rehearsalHeld(before, fake((a) => { a.cc5.recorded = ["cc5-ops"]; }), ids, ids).held, false, "a record missing");
  assert.equal(rehearsalHeld(before, fake((a) => { a.tables.posts += 1; }), ids, ids).held, false, "an existing row count moved");
});

test("backup validation allows only the live site's churn tables to move between the census and the export (finding SEC-6)", async () => {
  await buildCopy(node, "CHURN");
  const source = await runCensus(direct(node.env.CHURN), { database: "copy", target: "local" });
  const raw = node.env.CHURN._raw;
  raw.prepare("DELETE FROM sessions WHERE id = (SELECT MIN(id) FROM sessions)").run();
  raw.prepare("DELETE FROM rate_events WHERE rowid = (SELECT MIN(rowid) FROM rate_events)").run();
  const churned = validateRestore(source, await runCensus(direct(node.env.CHURN), { database: "copy", target: "local" }));
  assert.equal(churned.valid, true);
  assert.deepEqual(churned.churned.sort(), ["rate_events", "sessions"]);
  for (const tb of churned.churned) assert.ok(CHURN_TABLES.includes(tb));
  raw.prepare("DELETE FROM admin_audit WHERE rowid = (SELECT MIN(rowid) FROM admin_audit)").run();
  const moved = validateRestore(source, await runCensus(direct(node.env.CHURN), { database: "copy", target: "local" }));
  assert.deepEqual([moved.valid, moved.moved], [false, ["admin_audit"]]);
  for (const c of Object.values(CATEGORIES).flat()) assert.ok(!CHURN_TABLES.includes(c.table), `${c.table}: preserved data is never churn`);
});

/** A wrangler stand-in for a REMOTE backup run, in-process: it answers like wrangler (a remote export prints its one-hour link) and records every call. */
function remoteStandIn({ exportCode = 0, restoreCode = 0 } = {}) {
  const calls = [];
  const SIGNED = "https://example.invalid/d1-export/dump.sql?X-Signed=SyntheticBearerTokenThatMustNeverPrint";
  const answer = (st) => (st.startsWith("SELECT type, name, tbl_name, sql FROM sqlite_master") ? [{ type: "table", name: "claims", tbl_name: "claims", sql: "CREATE TABLE claims (city_id TEXT)" }]
    : st === "SELECT name FROM pragma_table_info('claims') ORDER BY cid" ? FIXTURE.claims.map((name) => ({ name }))
      : st.startsWith("SELECT name FROM pragma_table_info(") || st.startsWith("SELECT quote(") ? [] : [{ n: 0 }]);
  const run = async (args, opts) => {
    calls.push({ args, opts });
    if (args[1] === "time-travel") return { code: 0, stdout: '{"bookmark":"0000000a-00000001-00004e5f-0123abcd"}', stderr: "" };
    if (args[1] === "export") {
      writeFileSync(args[args.indexOf("--output") + 1], exportCode === 0 ? "CREATE TABLE claims (city_id TEXT);\n" : "CREATE TABLE cla");
      return { code: exportCode, stdout: `Creating export\nYou can also download your export from the following URL manually. This link will be valid for one hour: ${SIGNED}\n`, stderr: `export noise ${SIGNED}` };
    }
    if (args.includes("--file")) return { code: restoreCode, stdout: `restored ${SIGNED}`, stderr: "" };
    const i = args.indexOf("--command");
    return { code: 0, stdout: JSON.stringify(args[i + 1].split(";\n").map((st) => ({ results: answer(st), success: true, meta: {} }))), stderr: "" };
  };
  return { run, calls, SIGNED };
}

test("backup --remote --execute (wrangler stand-in, nothing real runs; finding SEC-1): the export's output, which carries a one-hour bearer link to the dump, is captured and never printed", async () => {
  const dir = mkdtempSync(path.join(TMP, "remote-"));
  const exportFile = path.join(dir, "prod.sql");
  const keyFile = path.join(dir, "k.key");
  const w = remoteStandIn();
  let out = "", err = "";
  const code = await backupMain(["--remote", "--execute", "--yes", "--key-file", keyFile, "--export", exportFile], { out: (s) => { out += s; }, err: (s) => { err += s; }, run: w.run, rehearse: async () => { throw new Error("no rehearsal"); } });
  assert.equal(code, 0, out + err);
  assert.ok(!(out + err).includes(w.SIGNED) && !(out + err).includes("SyntheticBearerToken"), "the signed link never reaches the terminal");
  assert.match(out, /backup VALIDATED/);
  assert.match(out, /bookmark: 0000000a-00000001-00004e5f-0123abcd/);
  const exp = w.calls.find((c) => c.args[1] === "export");
  assert.deepEqual(exp.args, ["d1", "export", "vicinity-claims", "--remote", "--output", exportFile, "--skip-confirmation"]);
  for (const c of w.calls) assert.ok(c.opts === undefined || !c.opts.inherit, `${c.args.slice(0, 3).join(" ")}: wrangler's output is never inherited`);
  assert.equal(statSync(exportFile).mode & 0o777, 0o600);
  const env = wranglerEnv({ WRANGLER_LOG: "debug", PATH: "/bin" });
  assert.equal(env.WRANGLER_LOG, "log", "an operator's debug level would print API answers; it is forced back");
});

test("backup failures say where member data was left (finding SEC-5): a failed export is deleted; after a failed restore the export and the restore folder are named", async () => {
  const dir = mkdtempSync(path.join(TMP, "fail-"));
  const keyFile = path.join(dir, "k.key");
  const exp1 = path.join(dir, "a.sql");
  let err = "";
  const a = remoteStandIn({ exportCode: 1 });
  assert.equal(await backupMain(["--remote", "--execute", "--yes", "--key-file", keyFile, "--export", exp1], { out: () => {}, err: (s) => { err += s; }, run: a.run }), 1);
  assert.match(err, /wrangler d1 export did not complete \(exit 1\)/);
  assert.ok(err.includes(`the partial export ${exp1} was deleted`), err);
  assert.ok(!existsSync(exp1));
  assert.ok(!err.includes(a.SIGNED));
  const exp2 = path.join(dir, "b.sql");
  err = "";
  const b = remoteStandIn({ restoreCode: 1 });
  assert.equal(await backupMain(["--remote", "--execute", "--yes", "--key-file", keyFile, "--export", exp2], { out: () => {}, err: (s) => { err += s; }, run: b.run }), 1);
  assert.ok(err.includes(`the export ${exp2} holds member data`), err);
  assert.ok(err.includes(`${exp2}.restore holds a partly restored copy with member data`), err);
  assert.ok(existsSync(exp2));
});

test("backup dry run (the default): prints the remote plan with its exact commands and the restore commands, and runs, reads and writes nothing", async () => {
  let out = "";
  const exportFile = path.join(TMP, "dry", "backup.sql");
  mkdirSync(path.dirname(exportFile), { recursive: true });
  const code = await backupMain(["--flags", "SELECTION_V5=shadow,ACTIVITY_POINTS=off", "--export", exportFile], {
    out: (s) => { out += s; }, err: (s) => { out += s; }, run: async () => { throw new Error("wrangler must not run"); }, rehearse: async () => { throw new Error("no rehearsal"); },
  });
  assert.equal(code, 0);
  for (const line of ["DRY RUN: nothing was run, read or written", "Groups the switch change creates (with prerequisites, in order): cc5-ops, cc5-selection",
    "wrangler d1 time-travel info vicinity-claims --json", `wrangler d1 export vicinity-claims --remote --output ${exportFile}`,
    `wrangler d1 execute cc5-restored-copy --local --config ${exportFile}.restore/wrangler.json --file ${exportFile}`, "wrangler d1 time-travel restore vicinity-claims",
    "--key-file '<key file outside the repository>'", "Run again with --execute"]) assert.ok(out.includes(line), line);
  assert.deepEqual(readdirSync(path.dirname(exportFile)), [], "nothing was written");
});

/* ------------------------------------------------------------------ the real command lines on Cloudflare's local D1 */


test("census command line on Cloudflare's local D1 (wrangler d1 execute --local): the same counts and digests as on Node's SQLite, nothing printed but counts and digests, no wrangler log written, nothing changed", { skip: mfSkip }, async () => {
  const refused = await cli("census.mjs", ["--local", "--config", CONFIG]);
  assert.equal(refused.code, 2, "a config outside the repository needs --key-file or --unkeyed (finding SEC-8)");
  assert.match(refused.stderr, /outside this repository/);
  const r = await cli("census.mjs", ["--local", "--config", CONFIG, "--unkeyed"]);
  assert.equal(r.code, 0, r.stderr);
  const viaWrangler = JSON.parse(r.stdout);
  await copy("MAIN");
  const viaNode = await runCensus(direct(node.env.MAIN), { database: DB_NAME, target: "local" });
  assert.deepEqual(without(viaWrangler, "at"), without(viaNode, "at"), "workerd's D1 and Node's SQLite give the same census");
  assert.equal(viaWrangler.database, DB_NAME);
  assertOnlyCountsAndDigests(viaWrangler);
  assertNoSyntheticValue(r.stdout + r.stderr, "the census command line");
  assert.deepEqual(logFiles(), [], "wrangler wrote no debug log (WRANGLER_WRITE_LOGS=false)");
  const out = path.join(TMP, "census-a.json");
  const again = await cli("census.mjs", ["--local", "--config", CONFIG, "--unkeyed", "--out", out]);
  assert.equal(again.code, 0, again.stderr);
  const cmp = await cli("census.mjs", ["--compare", out, out]);
  assert.equal(cmp.code, 0);
  assert.equal(JSON.parse(cmp.stdout).ok, true);
  const changed = JSON.parse(readFileSync(out, "utf8"));
  changed.digests.posts.digest = "0".repeat(64);
  writeFileSync(path.join(TMP, "census-b.json"), JSON.stringify(changed));
  const diff = await cli("census.mjs", ["--compare", out, path.join(TMP, "census-b.json")]);
  assert.equal(diff.code, 4);
  assert.equal(JSON.parse(diff.stdout).categories.posts, "changed");
  const mf = await persisted();
  try { assert.deepEqual(await mf.call({ op: "snapshot", db: "COPY" }), seeded, "the local database is unchanged"); }
  finally { await mf.dispose(); }
});

test("backup command line, --local --execute: export outside the repository (0600), restored into a new local copy and validated by the census, groups rehearsed on that copy only, restore commands printed", { skip: mfSkip }, async () => {
  const dir = mkdtempSync(path.join(TMP, "backup-"));
  const exportFile = path.join(dir, "backup.sql");
  const r = await cli("backup.mjs", ["--local", "--execute", "--config", CONFIG, "--export", exportFile, "--groups", "cc5-selection", "--unkeyed"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Groups the switch change creates \(with prerequisites, in order\): cc5-ops, cc5-selection/);
  assert.match(r.stdout, /backup VALIDATED: the restored copy has the same 55 tables and row counts, the same schema \(88 objects\) and the same digests for 8 categories/);
  assert.match(r.stdout, new RegExp(`rehearsal HELD: cc5-ops, cc5-selection created on the restored copy \\(8 tables and ${CC5_OBJECTS["cc5-ops"].length + CC5_OBJECTS["cc5-selection"].length} objects added, records cc5-ops, cc5-selection\\)`));
  assert.match(r.stdout, /into an empty local database \(move the config's \.wrangler\/state folder aside first\): wrangler d1 execute cc5-census-copy --local/);
  assert.match(r.stdout, /export: .*backup\.sql \(\d+ bytes, sha256 [0-9a-f]{64}, mode 0600\)/);
  assert.equal(statSync(exportFile).mode & 0o777, 0o600);
  assert.ok(statSync(exportFile).size > 1000);
  const source = JSON.parse(readFileSync(`${exportFile}.census-source.json`, "utf8"));
  const restored = JSON.parse(readFileSync(`${exportFile}.census-restored.json`, "utf8"));
  const rehearsed = JSON.parse(readFileSync(`${exportFile}.census-rehearsed.json`, "utf8"));
  assert.deepEqual([source.database, restored.database], [DB_NAME, "cc5-restored-copy"]);
  assert.deepEqual(restored.digests, source.digests);
  assert.deepEqual(restored.tables, source.tables);
  assert.deepEqual(restored.schema, source.schema, "the restored copy has every object of the source, byte for byte (the export keeps the SQL text)");
  assert.deepEqual(Object.keys(rehearsed.cc5.tables).sort(), [...CC5_TABLES["cc5-ops"], ...CC5_TABLES["cc5-selection"]].sort());
  assert.deepEqual(rehearsed.digests, source.digests);
  assert.deepEqual(source.cc5.tables, {}, "the source got no group");
  for (const c of [source, restored, rehearsed]) assertOnlyCountsAndDigests(c);
  assertNoSyntheticValue(r.stdout + r.stderr, "the backup command line");
  assert.deepEqual(logFiles(), [], "wrangler wrote no debug log");
  const mf = await persisted();
  try { assert.deepEqual(await mf.call({ op: "snapshot", db: "COPY" }), seeded, "the source database is unchanged: the rehearsal ran on the restored copy"); }
  finally { await mf.dispose(); }
  const second = await cli("backup.mjs", ["--local", "--execute", "--config", CONFIG, "--export", exportFile, "--unkeyed"]);
  assert.equal(second.code, 2, "an existing export is never overwritten");
});
