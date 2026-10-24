// Citycoin.dev master v5, stage S08: the additive D1 schema groups (docs/citycoin-master/schema-and-api.md section 3, sections 3.2 to 3.8)
// and their lazy runner (src/cc5schema.js; the stage record is docs/citycoin-master/schema-migrations.md). Nothing calls the runner yet, so
// the live site issues exactly today's statements; these tests run the real SQL on Node's SQLite (test/helpers/d1.js), which is the engine
// D1 runs. The same triggers were also run on a local D1 (workerd) built from the production schema: schema-migrations.md section 5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { d1 } from "./helpers/d1.js";
import { prodDb, seedProd } from "./helpers/prod-schema.js";
import {
  CC5_GROUPS, CC5_ORDER, CC5_RESERVED, Cc5SchemaError, cc5Runner, ensureCc5Group, groupsForFlags, registryProblems,
} from "../src/cc5schema.js";
import { FLAG_VALUES, MASTER_POLICY, validatePolicy, withDeployment } from "../src/masterpolicy.js";
import { deploymentFromEnv } from "../src/v5policy.js";
import {
  ensureSchema, ensureSignupSchema, ensureProfilesSchema, ensureLimitsSchema, ensureOnboardSchema, ensureFeedbackSchema, ensureLoginsSchema,
  ensureFeedSchema, ensureLogoSchema, ensureNotifySchema, ensureLaunchpadSchema, ensureMarketSchema,
} from "../src/store.js";
import { ensureLpCoinsSchema } from "../src/lpcoins.js";
import { ensureLpAdminSchema } from "../src/lpadmin.js";
import { ensureReadySchema } from "../src/coinart-store.js";
import { ensureReviewSchema } from "../src/coinreview.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const IDS = ["cc5-ops", "cc5-selection", "cc5-activity", "cc5-managers", "cc5-metadata", "cc5-launch", "cc5-hourly"];
const quiet = () => {};
const runner = (opts = {}) => cc5Runner({ log: quiet, ...opts });
/** For the test registries below: only the record table, nothing from src/store.js. */
const migrationsTable = (db) => db.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)").run();
const T = "2026-10-24T12:00:00.000Z";

/** Schema objects other than SQLite's own: [{ type, name, tbl_name, sql }] sorted by name. */
const objects = async (db) => (await db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results;
const names = async (db) => new Set((await objects(db)).map((o) => o.name));
const cols = async (db, t) => (await db.prepare(`PRAGMA table_info(${t})`).all()).results.map((r) => r.name);
const recorded = async (db) => (await db.prepare("SELECT id FROM schema_migrations WHERE id LIKE 'cc5-%' ORDER BY id").all()).results.map((r) => r.id);
const rowsOf = async (db, t) => JSON.stringify((await db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results);

/** A database that counts statements and can be told to fail one (matched by a regular expression on its SQL). */
function probe(db, { failOn = null, error = "simulated D1 failure" } = {}) {
  const seen = [];
  const state = { failOn };
  const wrap = (s) => ({
    ...s,
    bind: (...p) => wrap(s.bind(...p)),
    run: async () => { seen.push(s.sql); if (state.failOn && state.failOn.test(s.sql)) throw new Error(error); return s.run(); },
    first: async (c) => { seen.push(s.sql); return s.first(c); },
    all: async () => { seen.push(s.sql); return s.all(); },
  });
  return { prepare: (sql) => wrap(db.prepare(sql)), batch: (l) => db.batch(l), exec: (q) => db.exec(q), seen, state, inner: db };
}

/* ------------------------------------------------------------------ the doc, read as data */

const DOC = read("docs/citycoin-master/schema-and-api.md");
const SECTION_OF = { "3.2": "cc5-selection", "3.3": "cc5-managers", "3.4": "cc5-activity", "3.5": "cc5-metadata", "3.6": "cc5-launch", "3.7": "cc5-hourly", "3.8": "cc5-ops" };
/** The text of section `n` (### 3.n ... up to the next ### heading). */
function section(n) {
  const start = DOC.indexOf(`### ${n} `);
  assert.ok(start > 0, `section ${n} exists`);
  const end = DOC.indexOf("\n### ", start + 5);
  return DOC.slice(start, end);
}
const sqlBlocks = (text) => [...text.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
const norm = (s) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s*;\s*$/, "").trim();
/** The statements of a SQL block (a statement ends at a semicolon at the end of a line; a trigger's inner one is followed by END). */
const docStatements = (sql) => sql.replace(/--[^\n]*/g, "").split(/;[ \t]*(?:\n|$)/).map(norm).filter(Boolean);
/** The items of a CREATE TABLE (columns and table constraints), each normalized. */
function tableItems(sql) {
  const body = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"));
  const items = [];
  let depth = 0, cur = "";
  for (const ch of body.replace(/--[^\n]*/g, "")) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { items.push(norm(cur)); cur = ""; } else cur += ch;
  }
  items.push(norm(cur));
  return items.filter(Boolean);
}
const tableName = (s) => (/^CREATE TABLE IF NOT EXISTS (\w+)/.exec(s) || [])[1];
const objectName = (s) => (/^CREATE (?:TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS (\w+)/.exec(s) || [])[1];
const groupStatements = (id) => CC5_GROUPS[id].statements.filter((s) => typeof s === "string");

/* ------------------------------------------------------------------ the registry */

test("the registry follows section 3.10 step 2: cc5-identity reserved first (stage S09), cc5-ops before the first leased job, prerequisites before their dependants, idempotent statements only", () => {
  assert.deepEqual(registryProblems(), []);
  assert.deepEqual([...CC5_ORDER], ["cc5-identity", ...IDS]);
  assert.deepEqual(Object.keys(CC5_RESERVED), ["cc5-identity"], "the identity group is a reserved slot, not built in S08");
  assert.equal(CC5_GROUPS["cc5-identity"], undefined);
  assert.deepEqual(Object.keys(CC5_GROUPS).sort(), [...IDS].sort());
  const requires = Object.fromEntries(IDS.map((id) => [id, [...CC5_GROUPS[id].requires]]));
  assert.deepEqual(requires, {
    "cc5-ops": [],
    "cc5-selection": ["cc5-ops"],
    "cc5-activity": [],
    "cc5-managers": ["cc5-selection", "cc5-activity"],
    "cc5-metadata": [],
    "cc5-launch": ["cc5-ops", "cc5-metadata"],
    "cc5-hourly": ["cc5-ops"],
  });
  for (const id of IDS) {
    assert.ok(Object.isFrozen(CC5_GROUPS[id]) && Object.isFrozen(CC5_GROUPS[id].statements) && Object.isFrozen(CC5_GROUPS[id].switches), `${id} frozen`);
    for (const s of CC5_GROUPS[id].statements) {
      assert.equal(typeof s, "string", `${id}: no group of S08 alters an existing table`);
      assert.match(s, /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS \w+\s/, `${id}: ${s.slice(0, 60)}`);
    }
  }
  // the checker itself refuses what it must
  const bad = { a: { id: "a", section: "x", switches: {}, requires: ["b"], statements: ["CREATE TABLE t (x)"] }, b: { id: "b", section: "x", switches: {}, requires: [], statements: [{ table: "t", column: "y", sql: "ALTER TABLE u ADD COLUMN y TEXT" }] } };
  assert.deepEqual(registryProblems(bad, ["a", "b", "c"], {}), [
    "order: c is neither a group nor reserved",
    "a: requires b, which is not before it",
    "a: statement 0 is not CREATE ... IF NOT EXISTS",
    "b: statement 0 is neither CREATE ... IF NOT EXISTS nor a column-guarded ALTER TABLE t ADD COLUMN y",
  ]);
});

test("each group is section 3 word for word: every table's columns, types, CHECK, UNIQUE and keys, every index, and the doc's own triggers (sections 3.2 to 3.8)", () => {
  const marks = [];
  for (const [n, id] of Object.entries(SECTION_OF)) {
    const text = section(n);
    assert.equal((/Migration id `(cc5-[a-z]+)`/.exec(text) || [])[1], id, `section ${n} names ${id}`);
    assert.equal(CC5_GROUPS[id].section, n);
    const doc = docStatements(sqlBlocks(text));
    const mine = groupStatements(id);
    const docTables = doc.filter((s) => s.startsWith("CREATE TABLE"));
    const myTables = mine.filter((s) => s.startsWith("CREATE TABLE"));
    assert.deepEqual(myTables.map(tableName), docTables.map(tableName), `${id}: the doc's tables, in the doc's order`);
    for (const d of docTables) {
      const m = myTables.find((s) => tableName(s) === tableName(d));
      assert.deepEqual(tableItems(m), tableItems(d), `${id}: ${tableName(d)} as the doc defines it`);
    }
    // every index and every trigger the doc writes out, word for word
    for (const d of doc.filter((s) => !s.startsWith("CREATE TABLE"))) {
      const m = mine.find((s) => objectName(s) === objectName(d));
      assert.ok(m, `${id}: ${objectName(d)} is created`);
      assert.equal(norm(m), d, `${id}: ${objectName(d)} as the doc writes it`);
    }
    // the doc's "append-only triggers" marks (a comment after a table's statements): no UPDATE, no DELETE, no overwrite
    for (const chunk of sqlBlocks(text).split(/(?=CREATE TABLE IF NOT EXISTS )/).filter((c) => c.startsWith("CREATE TABLE"))) {
      const t = tableName(chunk);
      const mark = /\n-- (append-only triggers[^\n]*|triggers: [^\n]*)/.exec(chunk);
      if (!mark) continue;
      marks.push(t);
      if (/^append-only/.test(mark[1])) for (const k of ["no_update", "no_delete", "no_overwrite"]) assert.ok(mine.some((s) => objectName(s) === `${t}_${k}`), `${id}: ${t}_${k}`);
      else assert.ok(mine.some((s) => objectName(s) === `${t}_no_delete`) && mine.some((s) => objectName(s) === `${t}_end_once`), `${id}: ${t} (${mark[1]})`);
    }
  }
  assert.deepEqual(marks.sort(), ["activity_events", "city_metadata_request_events", "city_metadata_versions", "country_managers", "manager_application_events"]);
  // rule 6 of section 1 lists the append-only tables; each has all three triggers
  for (const t of ["founder_records", "activity_events", "manager_application_events", "city_metadata_versions", "city_metadata_request_events"]) {
    const all = IDS.flatMap(groupStatements).map(objectName);
    for (const k of ["no_update", "no_delete", "no_overwrite"]) assert.ok(all.includes(`${t}_${k}`), `${t}_${k}`);
  }
});

test("the switch that creates each group is the one its section names (created when ... first leaves off / first turns on; cc5-ops with the first of three)", () => {
  for (const [n, id] of Object.entries(SECTION_OF)) {
    const text = section(n);
    const sw = CC5_GROUPS[id].switches;
    const one = /created when `(\w+)` first (leaves "off"|turns on)/.exec(text);
    if (one) {
      const values = one[2] === "turns on" ? ["on"] : FLAG_VALUES[one[1]].slice(1);
      assert.deepEqual(JSON.parse(JSON.stringify(sw)), { [one[1]]: values }, `${id}: ${one[0]}`);
    } else {
      const many = /created with the first of `(\w+)`, `(\w+)` or `(\w+)`/.exec(text);
      assert.ok(many, `${id}: a creation sentence`);
      assert.deepEqual(Object.keys(sw).sort(), many.slice(1).sort());
      for (const [name, values] of Object.entries(sw)) assert.deepEqual([...values], FLAG_VALUES[name].slice(1), `${id}: ${name} leaving its default`);
    }
  }
});

test("nothing here is identity (cc5-identity is stage S09): no identity table, column or ALTER, and asking for it is refused as not built", async () => {
  const text = IDS.flatMap((id) => CC5_GROUPS[id].statements).map((s) => (typeof s === "string" ? s : s.sql)).join("\n");
  for (const word of ["auth_challenges", "city_assignments", "signup_completed_at", "loc_verified_at", "loc_policy", "loc_method", "legacy_state", "users_wallet_unique", "ALTER TABLE", " ON users", " ON sessions", " ON handoffs"]) {
    assert.ok(!text.includes(word), `no ${word}`);
  }
  const doc31 = docStatements(sqlBlocks(section("3.1"))).map(objectName).filter(Boolean);
  const all = new Set(IDS.flatMap(groupStatements).map(objectName));
  for (const n of doc31) assert.ok(!all.has(n), `${n} belongs to cc5-identity`);
  await assert.rejects(runner()(d1(), "cc5-identity"), (e) => e instanceof Cc5SchemaError && e.reason === "group_not_built" && e.status === 503 && e.code === "not_enabled");
});

test("no name collides with an object any migration in src/ already creates, nor with the production shape", async () => {
  const mine = new Set(IDS.flatMap(groupStatements).map(objectName));
  assert.equal(mine.size, IDS.flatMap(groupStatements).length, "every statement creates its own object");
  const existing = new Set();
  for (const f of readdirSync(new URL("src/", root))) {
    if (!f.endsWith(".js") || f === "cc5schema.js") continue;
    for (const m of read(`src/${f}`).matchAll(/CREATE (?:TABLE|INDEX|UNIQUE INDEX|TRIGGER|VIEW)(?: IF NOT EXISTS)? ["`]?(\w+)/g)) existing.add(m[1]);
  }
  assert.ok(existing.has("users") && existing.has("schema_migrations") && existing.has("coin_versions") && existing.has("lp_coins"));
  for (const n of mine) assert.ok(!existing.has(n), `${n} is new`);
  const prod = await names(await productionLike());
  for (const n of mine) assert.ok(!prod.has(n), `${n} is not in the production shape`);
});

/* ------------------------------------------------------------------ switches */

test("groupsForFlags: defaults, malformed values and unknown switches need nothing; each switch leaving its default needs its groups, prerequisites included, in section 3.10 order", () => {
  for (const f of [undefined, null, "SELECTION_V5=on", 7, {}, Object.fromEntries(Object.entries(FLAG_VALUES).map(([k, v]) => [k, v[0]]))]) {
    assert.deepEqual([...groupsForFlags(f)], [], JSON.stringify(f));
  }
  const cases = [
    [{ SELECTION_V5: "shadow" }, ["cc5-ops", "cc5-selection"]],
    [{ SELECTION_V5: "on" }, ["cc5-ops", "cc5-selection"]],
    [{ ACTIVITY_POINTS: "shadow" }, ["cc5-activity"]],
    [{ ACTIVITY_POINTS: "on" }, ["cc5-activity"]],
    [{ MANAGER_APPS: "on", SELECTION_V5: "on", ACTIVITY_POINTS: "on" }, ["cc5-ops", "cc5-selection", "cc5-activity", "cc5-managers"]],
    [{ METADATA_V5: "on" }, ["cc5-metadata"]],
    [{ LAUNCH_V5: "on", METADATA_V5: "on" }, ["cc5-ops", "cc5-metadata", "cc5-launch"]],
    [{ CC_HOURLY: "shadow" }, ["cc5-ops", "cc5-hourly"]],
    [{ CC_HOURLY: "on" }, ["cc5-ops", "cc5-hourly"]],
    [{ CC_HOURLY: " Shadow ", SELECTION_V5: "ON" }, ["cc5-ops", "cc5-selection", "cc5-hourly"]], // trimmed, any letter case, like the switches
    [{ SELECTION_V5: "yes", ACTIVITY_POINTS: true, METADATA_V5: "shadow", MANAGER_APPS: "shadow", LAUNCH_V5: 1 }, []], // not a value of the switch
    [{ WALLET_ONLY: "on", LEGACY_SEATS: "frozen", FOUNDER_RECORD_CHAIN: "on", CC_TRADING: "on", PUBLIC_V5: "on", MAIN_TOKEN_V5: "on", HOST_REDIRECT: "on" }, []],
    [Object.fromEntries(Object.entries(FLAG_VALUES).map(([k, v]) => [k, v[v.length - 1]])), IDS],
  ];
  for (const [flags, want] of cases) assert.deepEqual([...groupsForFlags(flags)], want, JSON.stringify(flags));
  assert.ok(Object.isFrozen(groupsForFlags({ SELECTION_V5: "on" })));
});

test("every switch value the registry names is a real value of the policy's switch, never its default", () => {
  for (const id of IDS) {
    for (const [name, values] of Object.entries(CC5_GROUPS[id].switches)) {
      assert.ok(FLAG_VALUES[name], `${id}: ${name} is a switch`);
      assert.ok(values.length > 0);
      for (const v of values) assert.ok(FLAG_VALUES[name].includes(v) && v !== FLAG_VALUES[name][0], `${id}: ${name}=${v}`);
    }
  }
});

test("each group is created only when its own switch has left its default, for every switch combination the configuration check does not refuse as incompatible", () => {
  const SW = ["SELECTION_V5", "ACTIVITY_POINTS", "MANAGER_APPS", "METADATA_V5", "LAUNCH_V5", "CC_HOURLY"];
  const INCOMPATIBLE = new Set(["MANAGER_APPS_WITHOUT_SELECTION", "MANAGER_APPS_WITHOUT_POINTS", "LAUNCH_V5_WITHOUT_METADATA_V5"]);
  let accepted = 0, withManagers = 0, withLaunch = 0;
  const walk = (i, flags) => {
    if (i === SW.length) {
      const codes = validatePolicy(withDeployment(MASTER_POLICY, { environment: "test", flags })).errors.map((e) => e.code);
      if (codes.some((c) => INCOMPATIBLE.has(c))) return;
      accepted++;
      if (flags.MANAGER_APPS === "on") withManagers++;
      if (flags.LAUNCH_V5 === "on") withLaunch++;
      for (const id of groupsForFlags(flags)) {
        assert.ok(Object.entries(CC5_GROUPS[id].switches).some(([name, values]) => values.includes(flags[name])), `${id} for ${JSON.stringify(flags)}`);
      }
      return;
    }
    for (const v of FLAG_VALUES[SW[i]]) walk(i + 1, { ...flags, [SW[i]]: v });
  };
  walk(0, {});
  assert.ok(accepted > 50 && withManagers > 0 && withLaunch > 0, `the walk is not vacuous (${accepted}, ${withManagers}, ${withLaunch})`);
  // the gates a prerequisite relies on are really there
  const codes = (flags) => validatePolicy(withDeployment(MASTER_POLICY, { environment: "test", flags })).errors.map((e) => e.code);
  assert.ok(codes({ MANAGER_APPS: "on" }).includes("MANAGER_APPS_WITHOUT_SELECTION") && codes({ MANAGER_APPS: "on", SELECTION_V5: "shadow" }).includes("MANAGER_APPS_WITHOUT_SELECTION"));
  assert.ok(codes({ MANAGER_APPS: "on" }).includes("MANAGER_APPS_WITHOUT_POINTS") && codes({ MANAGER_APPS: "on", ACTIVITY_POINTS: "shadow" }).includes("MANAGER_APPS_WITHOUT_POINTS"));
  assert.ok(codes({ LAUNCH_V5: "on" }).includes("LAUNCH_V5_WITHOUT_METADATA_V5"));
});

test("as committed: the switches the Worker reads from wrangler.jsonc need no group, and nothing in the Worker (src/) or the pages (public/) calls the runner yet", () => {
  const wrangler = JSON.parse(read("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
  assert.deepEqual([...groupsForFlags(deploymentFromEnv(wrangler.vars).flags)], []);
  assert.deepEqual([...groupsForFlags(wrangler.vars)], []);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(new URL(dir, root))) {
      const rel = `${dir}${name}`;
      if (name === "node_modules" || name.startsWith(".")) continue;
      if (statSync(new URL(rel, root)).isDirectory()) walk(`${rel}/`);
      else if (/\.(m?js|html)$/.test(name)) files.push(rel);
    }
  };
  for (const dir of ["src/", "public/"]) walk(dir); // operator scripts (scripts/) may read the registry; they never run in the Worker
  assert.ok(files.includes("src/index.js") && files.includes("src/jobs.js") && files.includes("src/cc5schema.js"));
  const callers = files.filter((f) => f !== "src/cc5schema.js" && /cc5schema|ensureCc5Group|cc5-(ops|selection|activity|managers|metadata|launch|hourly)\b/.test(read(f)));
  assert.deepEqual(callers, [], "a feature stage (S17 and later) adds its own call, and this test with it");
  assert.doesNotMatch(read("wrangler.jsonc"), /cc5/);
});

/* ------------------------------------------------------------------ the runner */

/** The production shape (test/helpers/prod-schema.js) with today's rows, plus every lazy migration production has, and the dark COIN_V2 tables. */
async function productionLike() {
  const db = await prodDb();
  await seedProd(db);
  for (const ensure of [ensureSignupSchema, ensureProfilesSchema, ensureLimitsSchema, ensureOnboardSchema, ensureFeedbackSchema, ensureLoginsSchema,
    ensureFeedSchema, ensureLogoSchema, ensureNotifySchema, ensureLaunchpadSchema, ensureMarketSchema, ensureLpCoinsSchema, ensureLpAdminSchema,
    ensureReadySchema, ensureReviewSchema]) await ensure(db);
  return db;
}

/** The objects each group adds: tables with their columns, indexes and triggers (SQLite's automatic indexes aside). */
const ADDS = {
  "cc5-ops": {
    tables: {
      job_leases: ["name", "holder", "fencing", "acquired_at", "expires_at"],
      idempotency_keys: ["scope", "key", "request_hash", "status", "response_status", "response_json", "created_at", "expires_at"],
    },
    indexes: ["idempotency_keys_expires"],
    triggers: [],
  },
  "cc5-selection": {
    tables: {
      selection_cities: ["city_id", "country", "status", "opened_at", "first_cycle", "founded_cycle", "updated_at"],
      selection_cycles: ["id", "mode", "city_id", "cycle", "boundary_at", "status", "attempts", "error_code", "claimed_until", "claim_token", "cutoff_slot",
        "cutoff_block_time", "next_slot", "next_block_time", "candidate_count", "digest", "winner_wallet", "policy_version", "created_at", "updated_at"],
      selection_snapshots: ["id", "cycle_id", "attempt", "provider", "cutoff_slot", "supply_raw", "sum_all_accounts_raw", "candidate_vector_hash", "blob_key", "status", "read_at"],
      selection_receipts: ["cycle_id", "digest", "merkle_root", "receipt_json", "public_json", "verifier_digest", "created_at"],
      national_ranks: ["mode", "cycle", "country", "user_id", "wallet", "raw", "rank", "computed_at"],
      founder_records: ["city_id", "country", "wallet", "user_id", "cycle", "cutoff_slot", "snapshot_hash", "policy_version", "selected_at", "cluster", "program_id",
        "chain_pda", "chain_tx", "chain_slot", "source", "recorded_at"],
    },
    indexes: ["national_ranks_rank", "selection_cycles_due", "selection_cycles_one_winner"],
    triggers: ["founder_records_no_delete", "founder_records_no_overwrite", "founder_records_no_update", "selection_cities_founded_no_delete", "selection_cities_founded_no_overwrite",
      "selection_cities_founded_no_takeover", "selection_cities_founded_terminal", "selection_receipts_no_delete", "selection_receipts_no_overwrite", "selection_receipts_no_takeover",
      "selection_receipts_no_update"],
  },
  "cc5-activity": {
    tables: {
      activity_events: ["id", "user_id", "wallet", "city_id", "country", "event_type", "source_type", "source_id", "points", "activity_at", "self_reply", "review_state",
        "dedup_key", "reverses_id", "policy_version", "created_at"],
      activity_evidence: ["id", "user_id", "wallet", "city_id", "country", "kind", "title", "summary", "links_json", "media_id", "body_hash", "status", "duplicate_of",
        "reviewer", "review_note", "reviewed_at", "event_id", "created_at", "updated_at"],
      activity_totals: ["user_id", "total", "by_category", "computed_at", "policy_version"],
    },
    indexes: ["activity_events_user", "activity_evidence_body", "activity_evidence_queue"],
    triggers: ["activity_events_no_delete", "activity_events_no_overwrite", "activity_events_no_update"],
  },
  "cc5-managers": {
    tables: {
      manager_applications: ["id", "user_id", "wallet", "country", "city_id", "status", "summary", "checks_at_submit", "checks_at_decision", "checks_hash", "decision_note",
        "decided_by", "decided_at", "policy_version", "created_at", "submitted_at", "updated_at"],
      manager_application_events: ["id", "application_id", "at", "actor_kind", "actor", "from_status", "to_status", "checks_json", "note"],
      country_managers: ["id", "country", "user_id", "wallet", "application_id", "appointed_by", "appointed_at", "ended_at", "ended_by", "end_reason"],
    },
    indexes: ["country_managers_active", "manager_applications_open", "manager_applications_queue"],
    triggers: ["country_managers_end_once", "country_managers_no_delete", "country_managers_no_overwrite", "manager_application_events_no_delete",
      "manager_application_events_no_overwrite", "manager_application_events_no_update"],
  },
  "cc5-metadata": {
    tables: {
      city_metadata_versions: ["id", "city_id", "version", "origin", "request_id", "ticker", "name", "descriptive_text", "image_sha256", "canonical_json", "content_hash",
        "per_quote_json", "registry_version", "policy_version", "created_at"],
      city_metadata_active: ["city_id", "version_id", "version", "ticker", "activated_at", "publish_tx", "publish_slot", "launched_mint"],
      city_metadata_uploads: ["id", "city_id", "user_id", "original_type", "original_bytes_len", "width", "height", "stripped_sha256", "normalized_sha256", "storage_key",
        "status", "created_at"],
      city_metadata_requests: ["id", "city_id", "user_id", "wallet", "status", "base_version", "proposed_ticker", "proposed_upload_id", "proposed_text", "reason",
        "proposal_hash", "submit_tx", "submit_slot", "decision_note", "decided_by", "decided_at", "publish_tx", "publish_slot", "resulting_version_id", "policy_version",
        "created_at", "updated_at"],
      city_metadata_request_events: ["id", "request_id", "at", "actor_kind", "actor", "from_status", "to_status", "note", "chain_tx"],
      city_review_locks: ["city_id", "request_id", "proposal_hash", "base_version", "chain_pda", "opened_tx", "opened_slot"],
    },
    indexes: ["city_metadata_requests_open", "city_metadata_requests_queue"],
    triggers: ["city_metadata_active_frozen_after_launch", "city_metadata_active_launched_no_delete", "city_metadata_active_launched_no_overwrite",
      "city_metadata_active_launched_no_takeover", "city_metadata_request_events_no_delete", "city_metadata_request_events_no_overwrite",
      "city_metadata_request_events_no_update", "city_metadata_versions_no_delete", "city_metadata_versions_no_overwrite", "city_metadata_versions_no_update"],
  },
  "cc5-launch": {
    tables: {
      city_launches: ["cluster", "program_id", "city_id", "mint", "coin", "founder", "quote_config_id", "quote_mint", "metadata_version_id", "metadata_hash", "ticker",
        "launch_tx", "launch_slot", "launched_at", "recorded_at"],
      launch_preparations: ["id", "city_id", "founder", "version_id", "quote_config_id", "stage", "prepare_tx", "created_at", "expires_at"],
    },
    indexes: ["city_launches_city", "launch_preparations_open"],
    triggers: ["city_launches_no_delete", "city_launches_no_overwrite", "city_launches_no_update"],
  },
  "cc5-hourly": {
    tables: {
      hourly_runs: ["cluster", "program_id", "coin", "quote_mint", "utc_hour", "mode", "status", "cutoff_slot", "samples_ok", "funded_raw", "allocated_raw", "dust_raw",
        "carried_raw", "carry_reason", "recipient_count", "list_hash", "root", "verifier_a_digest", "verifier_b_digest", "policy_version", "created_at", "updated_at"],
      hourly_samples: ["cluster", "program_id", "coin", "utc_hour", "segment", "slot", "taken_at", "holders_hash", "holder_count", "blob_key", "status"],
      hourly_actions: ["action_key", "cluster", "program_id", "coin", "quote_mint", "utc_hour", "action", "batch", "status", "amount_raw", "signature", "slot", "attempts",
        "next_attempt_at", "error", "claimed_until", "claim_token", "created_at", "updated_at"],
      hourly_leaves: ["cluster", "program_id", "coin", "quote_mint", "utc_hour", "leaf_index", "wallet", "amount_raw", "status", "paid_tx"],
    },
    indexes: ["hourly_actions_work"],
    triggers: ["hourly_actions_confirmed_final", "hourly_actions_keys_fixed", "hourly_actions_no_delete", "hourly_actions_no_overwrite", "hourly_leaves_keys_fixed",
      "hourly_leaves_no_delete", "hourly_leaves_no_overwrite", "hourly_leaves_paid_final", "hourly_runs_keys_fixed", "hourly_runs_no_delete", "hourly_runs_no_overwrite",
      "hourly_samples_keys_fixed", "hourly_samples_no_delete", "hourly_samples_no_overwrite"],
  },
};

test("ensureCc5Group creates exactly a group and its prerequisites (on env.DB or the database given), records each id after its statements, and nothing else", async () => {
  for (const id of IDS) {
    const db = d1();
    await ensureSchema(db);
    const before = await names(db);
    const need = new Set();
    const add = (x) => { need.add(x); CC5_GROUPS[x].requires.forEach(add); };
    add(id);
    const want = IDS.filter((x) => need.has(x));
    assert.deepEqual([...await runner()(id === "cc5-hourly" ? { DB: db } : db, id)], want, `${id} resolves to itself and its prerequisites`);
    assert.deepEqual(await recorded(db), [...want].sort());
    const added = (await objects(db)).filter((o) => !before.has(o.name));
    const tables = Object.assign({}, ...want.map((w) => ADDS[w].tables));
    const indexes = want.flatMap((w) => ADDS[w].indexes).sort();
    const triggers = want.flatMap((w) => ADDS[w].triggers).sort();
    assert.deepEqual(added.filter((o) => o.type === "table").map((o) => o.name).sort(), Object.keys(tables).sort(), `${id}: tables`);
    for (const [t, c] of Object.entries(tables)) assert.deepEqual(await cols(db, t), c, `${id}: ${t} columns`);
    assert.deepEqual(added.filter((o) => o.type === "index").map((o) => o.name).sort(), indexes, `${id}: indexes`);
    assert.deepEqual(added.filter((o) => o.type === "trigger").map((o) => o.name).sort(), triggers, `${id}: triggers`);
    assert.deepEqual(added.filter((o) => !["table", "index", "trigger"].includes(o.type)), [], `${id}: no view`);
  }
  assert.equal(IDS.flatMap((id) => groupStatements(id)).length,
    IDS.reduce((n, id) => n + Object.keys(ADDS[id].tables).length + ADDS[id].indexes.length + ADDS[id].triggers.length, 0), "the list above covers every statement");
});

test("additive only: on the production shape with today's rows, every existing object and every existing row is unchanged after all seven groups", async () => {
  const db = await productionLike();
  const before = await objects(db);
  const tables = before.filter((o) => o.type === "table").map((o) => o.name);
  const rows = {};
  for (const t of tables) rows[t] = await rowsOf(db, t);
  for (const id of IDS) await ensureCc5Group(db, id);
  const after = await objects(db);
  const beforeNames = new Set(before.map((o) => o.name));
  assert.deepEqual(after.filter((o) => beforeNames.has(o.name)), before, "every existing table, index and trigger is exactly as it was");
  for (const t of tables) {
    if (t === "schema_migrations") continue;
    assert.equal(await rowsOf(db, t), rows[t], `${t} rows unchanged`);
  }
  const migrations = JSON.parse(rows.schema_migrations);
  const now = (await db.prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all()).results;
  assert.deepEqual(now.slice(0, migrations.length), migrations, "existing records untouched");
  assert.deepEqual(now.slice(migrations.length).map((r) => r.id).sort(), [...IDS].sort(), "one record per group, nothing else");
  assert.ok(now.slice(migrations.length).every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.applied_at)));
});

test("cached per isolate: once a group is in place, asking again issues no statement; a new isolate reads the record and runs no CREATE", async () => {
  const db = probe(d1());
  const run = runner();
  await run(db, "cc5-launch");
  const first = db.seen.length;
  assert.ok(db.seen.some((s) => s.startsWith("CREATE TABLE IF NOT EXISTS city_launches")));
  await run(db, "cc5-launch");
  await run({ DB: db }, "cc5-metadata");
  await run(db, "cc5-ops");
  assert.equal(db.seen.length, first, "nothing more on this isolate");
  db.seen.length = 0;
  await runner()(db, "cc5-launch"); // another isolate
  assert.ok(db.seen.length > 0 && db.seen.every((s) => !/^(CREATE|ALTER|INSERT)/.test(s)), db.seen.join("\n"));
});

test("two isolates racing on one database both succeed, with one record per group; a lost record makes the next isolate re-run every statement harmlessly", async () => {
  const db = d1();
  await Promise.all([runner()(db, "cc5-managers"), runner()(db, "cc5-managers"), runner()({ DB: db }, "cc5-selection"), runner()(db, "cc5-hourly")]);
  assert.deepEqual(await recorded(db), ["cc5-activity", "cc5-hourly", "cc5-managers", "cc5-ops", "cc5-selection"]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 'cc5-managers'").first()).n, 1);
  const shape = JSON.stringify(await objects(db));
  await db.prepare("DELETE FROM schema_migrations WHERE id LIKE 'cc5-%'").run();
  const p = probe(db);
  await runner()(p, "cc5-managers");
  const mine = new Set(IDS.flatMap(groupStatements).map(objectName));
  assert.equal(p.seen.filter((s) => mine.has(objectName(s))).length, ["cc5-ops", "cc5-selection", "cc5-activity", "cc5-managers"].reduce((n, id) => n + CC5_GROUPS[id].statements.length, 0));
  assert.equal(JSON.stringify(await objects(db)), shape, "IF NOT EXISTS: the same objects");
  assert.deepEqual(await recorded(db), ["cc5-activity", "cc5-managers", "cc5-ops", "cc5-selection"]);
});

test("a failing statement: a Cc5SchemaError (503 not_enabled) naming the group and the step, nothing recorded for it, other groups unaffected, and the next call retries", async () => {
  const lines = [];
  const db = probe(d1(), { failOn: /^CREATE TABLE IF NOT EXISTS hourly_leaves/ });
  const run = runner({ log: (...a) => lines.push(a.join(" ")) });
  const err = await run(db, "cc5-hourly").catch((e) => e);
  assert.ok(err instanceof Cc5SchemaError && err instanceof Error);
  assert.equal(err.name, "Cc5SchemaError");
  assert.equal(err.status, 503);
  assert.equal(err.code, "not_enabled");
  assert.equal(err.group, "cc5-hourly");
  assert.equal(err.failed, "cc5-hourly");
  assert.equal(err.reason, "statement_failed");
  assert.equal(err.step, CC5_GROUPS["cc5-hourly"].statements.findIndex((s) => s.startsWith("CREATE TABLE IF NOT EXISTS hourly_leaves")));
  assert.match(String(err.cause && err.cause.message), /simulated D1 failure/);
  assert.deepEqual(await recorded(db.inner), ["cc5-ops"], "the prerequisite finished and is recorded; the failed group is not");
  assert.ok((await names(db.inner)).has("hourly_actions") && !(await names(db.inner)).has("hourly_leaves"), "statements before the failure ran (each one is safe to run again)");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^cc5 schema unavailable cc5-hourly cc5-hourly statement_failed step \d+ simulated D1 failure$/);
  // the other groups do not depend on it
  await run(db, "cc5-activity");
  await run(db, "cc5-launch");
  assert.deepEqual(await recorded(db.inner), ["cc5-activity", "cc5-launch", "cc5-metadata", "cc5-ops"]);
  // the failure was forgotten: the next call retries, and succeeds once D1 does
  await assert.rejects(run(db, "cc5-hourly"), (e) => e.reason === "statement_failed");
  db.state.failOn = null;
  assert.deepEqual([...await run(db, "cc5-hourly")], ["cc5-ops", "cc5-hourly"]);
  assert.ok((await recorded(db.inner)).includes("cc5-hourly"));
});

test("a failing prerequisite fails every group that needs it (prerequisite_failed, naming it) and no other; a failing record is a failure too", async () => {
  const db = probe(d1(), { failOn: /^CREATE TABLE IF NOT EXISTS job_leases/ });
  const run = runner();
  for (const id of ["cc5-selection", "cc5-managers", "cc5-launch", "cc5-hourly"]) {
    const e = await run(db, id).catch((x) => x);
    assert.ok(e instanceof Cc5SchemaError, id);
    assert.deepEqual([e.group, e.failed, e.reason, e.step, e.status, e.code], [id, "cc5-ops", "prerequisite_failed", 0, 503, "not_enabled"], id);
  }
  await run(db, "cc5-activity");
  await run(db, "cc5-metadata");
  assert.deepEqual(await recorded(db.inner), ["cc5-activity", "cc5-metadata"]);
  const db2 = probe(d1(), { failOn: /^INSERT OR IGNORE INTO schema_migrations/ });
  await ensureSchema(db2.inner);
  const e = await runner()(db2, "cc5-activity").catch((x) => x);
  assert.deepEqual([e.group, e.reason], ["cc5-activity", "record_failed"]);
});

test("unknown, reserved and database-less calls are refused with the named error; the log line names the group and reason only", async () => {
  const lines = [];
  const run = runner({ log: (...a) => lines.push(a.join(" ")) });
  for (const [target, id, reason] of [[d1(), "cc5-nope", "unknown_group"], [d1(), undefined, "unknown_group"], [d1(), "toString", "unknown_group"],
    [d1(), "cc5-identity", "group_not_built"], [{}, "cc5-ops", "no_database"], [null, "cc5-ops", "no_database"], [{ DB: {} }, "cc5-ops", "no_database"]]) {
    const e = await run(target, id).catch((x) => x);
    assert.ok(e instanceof Cc5SchemaError, String(id));
    assert.deepEqual([e.reason, e.status, e.code], [reason, 503, "not_enabled"], String(id));
  }
  assert.equal(lines.length, 7);
  for (const l of lines) assert.match(l, /^cc5 schema unavailable \S+ \S+ (unknown_group|group_not_built|no_database) +$/);
  // the module's own runner refuses the same way
  await assert.rejects(ensureCc5Group(d1(), "cc5-identity").catch((e) => { throw e; }), (e) => e.reason === "group_not_built");
});

test("a broken registry refuses every call (registry_invalid) before touching the database", async () => {
  const db = probe(d1());
  const groups = { "x-a": { id: "x-a", section: "t", switches: {}, requires: [], statements: ["CREATE TABLE widgets (id INTEGER)"] } };
  const e = await runner({ groups, order: ["x-a"], reserved: {}, prepareSchema: migrationsTable })(db, "x-a").catch((x) => x);
  assert.equal(e.reason, "registry_invalid");
  assert.deepEqual(db.seen, []);
});

test("the ALTER form (for cc5-identity, stage S09): runs only when PRAGMA table_info shows the column missing; a racing isolate's duplicate column is ignored", async () => {
  const groups = {
    "x-base": { id: "x-base", section: "t", switches: {}, requires: [], statements: ["CREATE TABLE IF NOT EXISTS widgets (id INTEGER PRIMARY KEY)"] },
    "x-alter": { id: "x-alter", section: "t", switches: {}, requires: ["x-base"], statements: [{ table: "widgets", column: "colour", sql: "ALTER TABLE widgets ADD COLUMN colour TEXT" }] },
  };
  const opts = { groups, order: ["x-base", "x-alter"], reserved: {}, prepareSchema: migrationsTable };
  const db = probe(d1());
  assert.deepEqual([...await runner(opts)(db, "x-alter")], ["x-base", "x-alter"]);
  assert.deepEqual(await cols(db.inner, "widgets"), ["id", "colour"]);
  assert.equal(db.seen.filter((s) => s.startsWith("ALTER")).length, 1);
  // the column is there (another isolate added it), the record is not: no ALTER is issued
  await db.inner.prepare("DELETE FROM schema_migrations WHERE id = 'x-alter'").run();
  db.seen.length = 0;
  await runner(opts)(db, "x-alter");
  assert.equal(db.seen.filter((s) => s.startsWith("ALTER")).length, 0);
  assert.ok(db.seen.includes("PRAGMA table_info(widgets)"));
  assert.equal((await db.inner.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 'x-alter'").first()).n, 1);
  // the race: PRAGMA said missing, then another isolate added it first
  const raced = d1();
  const p = probe(raced);
  const realPrepare = p.prepare;
  p.prepare = (sql) => (sql.startsWith("ALTER") ? { run: async () => { throw new Error("D1_ERROR: duplicate column name: colour: SQLITE_ERROR"); } } : realPrepare(sql));
  await runner(opts)(p, "x-alter");
  assert.deepEqual((await raced.prepare("SELECT id FROM schema_migrations WHERE id LIKE 'x-%' ORDER BY id").all()).results.map((r) => r.id), ["x-alter", "x-base"]);
  // any other ALTER failure is a failure
  const other = probe(d1());
  const otherPrepare = other.prepare;
  other.prepare = (sql) => (sql.startsWith("ALTER") ? { run: async () => { throw new Error("D1_ERROR: no such table: widgets"); } } : otherPrepare(sql));
  const e = await runner(opts)(other, "x-alter").catch((x) => x);
  assert.deepEqual([e.reason, e.failed, e.step], ["statement_failed", "x-alter", 0]);
});

test("a group's prepare step (the slot cc5-identity uses to run ONBOARD_MIGRATION first) runs after its prerequisites and before its statements, once", async () => {
  const order = [];
  const groups = {
    "x-base": { id: "x-base", section: "t", switches: {}, requires: [], statements: ["CREATE TABLE IF NOT EXISTS widgets (id INTEGER PRIMARY KEY)"] },
    "x-next": { id: "x-next", section: "t", switches: {}, requires: ["x-base"], prepare: async (db) => { order.push((await names(db)).has("widgets") ? "prepare after base" : "prepare too early"); },
      statements: ["CREATE TABLE IF NOT EXISTS gadgets (id INTEGER PRIMARY KEY)"] },
  };
  const db = d1();
  const run = runner({ groups, order: ["x-base", "x-next"], reserved: {}, prepareSchema: migrationsTable });
  await run(db, "x-next");
  await run(db, "x-next");
  assert.deepEqual(order, ["prepare after base"]);
  assert.ok((await names(db)).has("gadgets"));
  const failing = { ...groups, "x-next": { ...groups["x-next"], prepare: async () => { throw new Error("onboard migration failed"); } } };
  const e = await runner({ groups: failing, order: ["x-base", "x-next"], reserved: {}, prepareSchema: migrationsTable })(d1(), "x-next").catch((x) => x);
  assert.deepEqual([e.reason, e.failed, e.step], ["statement_failed", "x-next", -1]);
});

/* ------------------------------------------------------------------ append-only and immutable tables */

const W = (n) => `Wtest${String(n).padStart(39, "1")}`; // synthetic wallet-shaped text; no member data anywhere in this file
const P = "Ptest1111111111111111111111111111111111111";
const insertSql = (verb, table, row, tail = "") => {
  const c = Object.keys(row);
  return { sql: `${verb} ${table} (${c.join(", ")}) VALUES (${c.map(() => "?").join(", ")})${tail}`, params: Object.values(row) };
};
const exec = (db, { sql, params = [] }) => db.prepare(sql).bind(...params).run();
const ins = (db, table, row, verb = "INSERT INTO", tail = "") => exec(db, insertSql(verb, table, row, tail));

/** Every way a statement could rewrite or remove the row `row` of `table` (keyed by `keys`, each a list of columns): none may succeed. */
function overwriteAttempts(table, row, keys, change) {
  const out = [];
  for (const key of keys) {
    // a new row that shares only this key (every other unique value fresh), so REPLACE would delete exactly the kept row
    const fresh = { ...row, ...change(key) };
    for (const k of key) fresh[k] = row[k];
    out.push([`INSERT OR REPLACE by ${key}`, insertSql("INSERT OR REPLACE INTO", table, fresh)]);
    out.push([`REPLACE by ${key}`, insertSql("REPLACE INTO", table, fresh)]);
    out.push([`INSERT OR IGNORE by ${key}`, insertSql("INSERT OR IGNORE INTO", table, fresh)]);
    out.push([`ON CONFLICT DO NOTHING by ${key}`, insertSql("INSERT INTO", table, fresh, " ON CONFLICT DO NOTHING")]);
    const set = Object.keys(row).find((c) => !keys.flat().includes(c) && c !== "id");
    out.push([`ON CONFLICT DO UPDATE by ${key}`, insertSql("INSERT INTO", table, fresh, ` ON CONFLICT(${key.join(", ")}) DO UPDATE SET ${set} = excluded.${set}`)]);
    out.push([`plain INSERT by ${key}`, insertSql("INSERT INTO", table, fresh)]);
  }
  return out;
}

/** The append-only tables: a valid row, its unique keys, a change giving fresh values for the other keys, and the error name. */
const APPEND_ONLY = [
  ["cc5-selection", "founder_records", "founder_record_immutable",
    { city_id: "c-1", country: "US", wallet: W(1), user_id: 1, cycle: 100, cutoff_slot: 5, snapshot_hash: "s1", policy_version: "citycoin-master-v5", selected_at: T,
      cluster: "devnet", program_id: P, chain_pda: "pda-1", chain_tx: "tx-1", chain_slot: 6, source: "selection", recorded_at: T },
    [["city_id"], ["wallet"], ["chain_pda"]], (k) => ({ city_id: "c-2", wallet: W(2), chain_pda: "pda-2", snapshot_hash: `rewritten-${k}` })],
  ["cc5-managers", "manager_application_events", "manager_application_event_append_only",
    { id: 1, application_id: 1, at: T, actor_kind: "owner", actor: W(3), from_status: "under_review", to_status: "approved", checks_json: "{}", note: "n" },
    [["id"]], () => ({ note: "rewritten" })],
  ["cc5-activity", "activity_events", "activity_event_append_only",
    { id: 1, user_id: 1, wallet: W(1), city_id: "c-1", country: "US", event_type: "post", source_type: "post", source_id: "11", points: 2, activity_at: T,
      self_reply: 0, review_state: "auto", dedup_key: "post:11", reverses_id: 7, policy_version: "citycoin-master-v5", created_at: T },
    [["id"], ["dedup_key"], ["reverses_id"]], (k) => ({ id: 2, dedup_key: "post:12", reverses_id: 8, points: 40, source_id: `rewritten-${k}` })],
  ["cc5-metadata", "city_metadata_versions", "metadata_version_append_only",
    { id: 1, city_id: "c-1", version: 1, origin: "default", request_id: null, ticker: "CITY", name: "City", descriptive_text: "d", image_sha256: "i1",
      canonical_json: "{}", content_hash: "h1", per_quote_json: "{}", registry_version: 1, policy_version: "citycoin-master-v5", created_at: T },
    [["id"], ["city_id", "version"], ["city_id", "content_hash"]], () => ({ id: 2, version: 2, content_hash: "h2", ticker: "EVIL" })],
  ["cc5-metadata", "city_metadata_request_events", "metadata_request_event_append_only",
    { id: 1, request_id: 1, at: T, actor_kind: "owner", actor: W(3), from_status: "under_review", to_status: "approved_publishing", note: "n", chain_tx: "tx" },
    [["id"]], () => ({ note: "rewritten" })],
  ["cc5-launch", "city_launches", "launch_record_immutable",
    { cluster: "devnet", program_id: P, city_id: "c-1", mint: "mint-1", coin: "coin-1", founder: W(1), quote_config_id: 1, quote_mint: "q", metadata_version_id: 1,
      metadata_hash: "m", ticker: "CITY", launch_tx: "tx", launch_slot: 9, launched_at: T, recorded_at: T },
    [["cluster", "program_id", "city_id"], ["mint"], ["ticker"], ["city_id"]],
    (k) => ({ city_id: "c-2", mint: "mint-2", ticker: "OTHER", program_id: k.includes("program_id") ? P : "Pother", founder: W(9) })],
];

test("REPLACE cannot rewrite history: without the overwrite guard INSERT OR REPLACE silently replaces a founder record (delete triggers do not fire); with it every path fails and the row stays", async () => {
  const [, table, message, row] = APPEND_ONLY[0];
  // the hole the guard closes, shown on a copy without it
  const bare = d1();
  await runner()(bare, "cc5-selection");
  await bare.prepare("DROP TRIGGER founder_records_no_overwrite").run();
  await ins(bare, table, row);
  await ins(bare, table, { ...row, wallet: W(8), chain_pda: "pda-8", snapshot_hash: "rewritten" }, "INSERT OR REPLACE INTO");
  assert.equal((await bare.prepare("SELECT snapshot_hash FROM founder_records WHERE city_id = 'c-1'").first()).snapshot_hash, "rewritten",
    "with only BEFORE DELETE triggers, REPLACE deletes the old row without firing them");
  assert.equal((await bare.prepare("PRAGMA recursive_triggers").first()).recursive_triggers, 0);
  // with the guard
  const db = d1();
  await runner()(db, "cc5-selection");
  await ins(db, table, row);
  const kept = await rowsOf(db, table);
  for (const [what, s] of [
    ...overwriteAttempts(table, row, APPEND_ONLY[0][4], APPEND_ONLY[0][5]),
    ["UPDATE", { sql: "UPDATE founder_records SET wallet = ? WHERE city_id = 'c-1'", params: [W(5)] }],
    ["UPDATE OR REPLACE", { sql: "UPDATE OR REPLACE founder_records SET snapshot_hash = 'x'" }],
    ["DELETE", { sql: "DELETE FROM founder_records" }],
  ]) {
    await assert.rejects(exec(db, s), new RegExp(message), what);
    assert.equal(await rowsOf(db, table), kept, `${what}: the record is unchanged`);
  }
  // a batch that tries it rolls back whole
  await assert.rejects(db.batch([db.prepare("INSERT INTO national_ranks (mode, cycle, country, user_id, wallet, raw, rank, computed_at) VALUES ('live', 1, 'US', 1, ?, '5', 1, ?)").bind(W(1), T),
    db.prepare("INSERT OR REPLACE INTO founder_records (city_id, country, wallet, cycle, cutoff_slot, snapshot_hash, policy_version, selected_at, cluster, program_id, chain_pda, chain_tx, chain_slot, source, recorded_at) VALUES ('c-1', 'US', ?, 1, 1, 'x', 'v', ?, 'devnet', ?, 'pda-x', 'tx', 1, 'selection', ?)").bind(W(6), T, P, T)]),
  /founder_record_immutable/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM national_ranks").first()).n, 0);
});

test("append-only tables (rule 6, the doc's append-only marks, and the launch record): append works; UPDATE, DELETE and every overwrite path fail with the table's name; rows unchanged", async () => {
  for (const [id, table, message, row, keys, change] of APPEND_ONLY) {
    const db = d1();
    await runner()(db, id);
    await ins(db, table, row);
    const kept = await rowsOf(db, table);
    const attempts = [
      ...overwriteAttempts(table, row, keys, change),
      ["UPDATE", { sql: `UPDATE ${table} SET ${Object.keys(row).find((c) => !keys.flat().includes(c))} = NULL` }],
      ["UPDATE OR REPLACE", { sql: `UPDATE OR REPLACE ${table} SET ${keys[0][0]} = ${keys[0][0]}` }],
      ["DELETE", { sql: `DELETE FROM ${table}` }],
    ];
    for (const [what, s] of attempts) {
      await assert.rejects(exec(db, s), new RegExp(message), `${table}: ${what}`);
      assert.equal(await rowsOf(db, table), kept, `${table}: ${what} left the row`);
    }
    // a genuinely new row is appended
    const next = { ...row, ...change(["none"]) };
    if ("id" in next) next.id = 50;
    for (const key of keys) if (key.every((k) => next[k] === row[k])) next[key[key.length - 1]] = `${next[key[key.length - 1]]}-new`;
    await ins(db, table, next);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 2, `${table}: append works`);
  }
});

test("a founded city is terminal: other cities change freely; a founded one cannot be updated, deleted, replaced or taken over", async () => {
  const db = d1();
  await runner()(db, "cc5-selection");
  const city = (id, status) => ({ city_id: id, country: "US", status, opened_at: T, first_cycle: 1, founded_cycle: status === "founded" ? 3 : null, updated_at: T });
  await ins(db, "selection_cities", city("c-1", "awaiting"));
  await exec(db, { sql: "UPDATE selection_cities SET status = 'processing' WHERE city_id = 'c-1'" });
  await ins(db, "selection_cities", city("c-1", "awaiting"), "INSERT OR REPLACE INTO"); // not founded: the doc allows it
  await exec(db, { sql: "UPDATE selection_cities SET status = 'founded', founded_cycle = 3 WHERE city_id = 'c-1'" });
  await ins(db, "selection_cities", city("c-2", "awaiting"));
  const kept = await rowsOf(db, "selection_cities");
  for (const s of [
    { sql: "UPDATE selection_cities SET status = 'awaiting' WHERE city_id = 'c-1'" },
    { sql: "DELETE FROM selection_cities WHERE city_id = 'c-1'" },
    insertSql("INSERT OR REPLACE INTO", "selection_cities", city("c-1", "awaiting")),
    insertSql("INSERT INTO", "selection_cities", city("c-1", "awaiting"), " ON CONFLICT(city_id) DO UPDATE SET status = 'awaiting'"),
    { sql: "UPDATE OR REPLACE selection_cities SET city_id = 'c-1' WHERE city_id = 'c-2'" },
  ]) {
    await assert.rejects(exec(db, s), /city_already_founded/, s.sql);
    assert.equal(await rowsOf(db, "selection_cities"), kept, s.sql);
  }
  await exec(db, { sql: "UPDATE selection_cities SET status = 'processing' WHERE city_id = 'c-2'" });
  await exec(db, { sql: "DELETE FROM selection_cities WHERE city_id = 'c-2'" });
});

test("a receipt is never deleted or replaced, and is immutable once the verifier's digest is recorded (the doc's two triggers)", async () => {
  const db = d1();
  await runner()(db, "cc5-selection");
  const receipt = (cycle, digest) => ({ cycle_id: cycle, digest, merkle_root: "r", receipt_json: "{}", public_json: "{}", verifier_digest: null, created_at: T });
  await ins(db, "selection_receipts", receipt(1, "d1"));
  await ins(db, "selection_receipts", receipt(2, "d2"));
  await exec(db, { sql: "UPDATE selection_receipts SET merkle_root = 'r2' WHERE cycle_id = 1" }); // before verification the doc allows it
  for (const s of [
    { sql: "DELETE FROM selection_receipts WHERE cycle_id = 2" },
    insertSql("INSERT OR REPLACE INTO", "selection_receipts", receipt(2, "d9")),
    insertSql("INSERT OR REPLACE INTO", "selection_receipts", receipt(9, "d2")),
    { sql: "UPDATE OR REPLACE selection_receipts SET digest = 'd2' WHERE cycle_id = 1" },
    { sql: "UPDATE OR REPLACE selection_receipts SET cycle_id = 2 WHERE cycle_id = 1" },
  ]) await assert.rejects(exec(db, s), /receipt_immutable/, s.sql);
  await exec(db, { sql: "UPDATE selection_receipts SET verifier_digest = 'd1' WHERE cycle_id = 1" });
  const kept = await rowsOf(db, "selection_receipts");
  await assert.rejects(exec(db, { sql: "UPDATE selection_receipts SET merkle_root = 'r3' WHERE cycle_id = 1" }), /receipt_immutable/);
  await assert.rejects(exec(db, { sql: "UPDATE selection_receipts SET verifier_digest = NULL WHERE cycle_id = 1" }), /receipt_immutable/);
  assert.equal(await rowsOf(db, "selection_receipts"), kept);
});

test("a city's active metadata is frozen once its launched mint is set: before launch it changes; after, no update, delete, replace or takeover (by city, ticker or mint)", async () => {
  const db = d1();
  await runner()(db, "cc5-metadata");
  const active = (city, ticker, mint = null) => ({ city_id: city, version_id: 1, version: 1, ticker, activated_at: T, publish_tx: null, publish_slot: null, launched_mint: mint });
  await ins(db, "city_metadata_active", active("c-1", "ONE"));
  await exec(db, { sql: "UPDATE city_metadata_active SET ticker = 'UNO', version = 2 WHERE city_id = 'c-1'" });
  await ins(db, "city_metadata_active", active("c-1", "UNO"), "INSERT OR REPLACE INTO"); // not launched: allowed
  await exec(db, { sql: "UPDATE city_metadata_active SET launched_mint = 'mint-1' WHERE city_id = 'c-1'" });
  await ins(db, "city_metadata_active", active("c-2", "TWO"));
  const kept = await rowsOf(db, "city_metadata_active");
  for (const s of [
    { sql: "UPDATE city_metadata_active SET launched_mint = NULL WHERE city_id = 'c-1'" },
    { sql: "UPDATE city_metadata_active SET ticker = 'NEW' WHERE city_id = 'c-1'" },
    { sql: "DELETE FROM city_metadata_active WHERE city_id = 'c-1'" },
    insertSql("INSERT OR REPLACE INTO", "city_metadata_active", active("c-1", "NEW")),
    insertSql("INSERT OR REPLACE INTO", "city_metadata_active", active("c-9", "UNO")),
    insertSql("INSERT OR REPLACE INTO", "city_metadata_active", active("c-9", "NINE", "mint-1")),
    { sql: "UPDATE OR REPLACE city_metadata_active SET ticker = 'UNO' WHERE city_id = 'c-2'" },
    { sql: "UPDATE OR REPLACE city_metadata_active SET launched_mint = 'mint-1' WHERE city_id = 'c-2'" },
    { sql: "UPDATE OR REPLACE city_metadata_active SET city_id = 'c-1' WHERE city_id = 'c-2'" },
  ]) {
    await assert.rejects(exec(db, s), /metadata_frozen_after_launch/, s.sql);
    assert.equal(await rowsOf(db, "city_metadata_active"), kept, s.sql);
  }
  await exec(db, { sql: "UPDATE city_metadata_active SET ticker = 'DOS' WHERE city_id = 'c-2'" });
  await exec(db, { sql: "DELETE FROM city_metadata_active WHERE city_id = 'c-2'" });
});

test("a country manager is never deleted or replaced; the one update ends the term (ended_at, ended_by, end_reason) and nothing else, once; one active manager per country", async () => {
  const db = d1();
  await runner()(db, "cc5-managers");
  const mgr = (id, country, app, ended = null) => ({ id, country, user_id: id, wallet: W(id), application_id: app, appointed_by: W(9), appointed_at: T, ended_at: ended, ended_by: ended && W(9), end_reason: ended && "revoked" });
  await ins(db, "country_managers", mgr(1, "US", 10));
  await assert.rejects(ins(db, "country_managers", mgr(2, "US", 11)), /country_manager_append_only|UNIQUE/, "one active manager per country");
  const kept = await rowsOf(db, "country_managers");
  for (const s of [
    { sql: "DELETE FROM country_managers" },
    { sql: "UPDATE country_managers SET wallet = ? WHERE id = 1", params: [W(5)] },
    { sql: "UPDATE country_managers SET ended_by = ? WHERE id = 1", params: [W(9)] }, // not an ending
    { sql: "UPDATE country_managers SET ended_at = ?, country = 'CA' WHERE id = 1", params: [T] },
    insertSql("INSERT OR REPLACE INTO", "country_managers", mgr(1, "CA", 12)),
    insertSql("INSERT OR REPLACE INTO", "country_managers", mgr(3, "CA", 10)),
    insertSql("INSERT OR REPLACE INTO", "country_managers", mgr(4, "US", 13)), // the partial index: would delete the active manager
  ]) {
    await assert.rejects(exec(db, s), /country_manager_append_only/, s.sql);
    assert.equal(await rowsOf(db, "country_managers"), kept, s.sql);
  }
  await exec(db, { sql: "UPDATE country_managers SET ended_at = ?, ended_by = ?, end_reason = 'replaced' WHERE id = 1", params: [T, W(9)] });
  await assert.rejects(exec(db, { sql: "UPDATE country_managers SET end_reason = 'revoked' WHERE id = 1" }), /country_manager_append_only/, "once");
  await assert.rejects(exec(db, { sql: "UPDATE country_managers SET ended_at = NULL WHERE id = 1" }), /country_manager_append_only/);
  await ins(db, "country_managers", mgr(2, "US", 11)); // the next manager
  await assert.rejects(ins(db, "country_managers", mgr(3, "US", 11, T)), /country_manager_append_only|UNIQUE/, "one appointment per application");
  await assert.rejects(exec(db, { sql: "UPDATE country_managers SET end_reason = 'other', ended_at = ? WHERE id = 2", params: [T] }), /CHECK/);
});

test("hourly records are kept and keyed: never deleted or replaced, keys never change; a confirmed action and a paid or claimed leaf are final; a leaf is never redirected", async () => {
  const db = d1();
  await runner()(db, "cc5-hourly");
  const k = { cluster: "devnet", program_id: P, coin: "coin-1" };
  const run = { ...k, quote_mint: "q", utc_hour: 490000, mode: "shadow", status: "sampling", samples_ok: 0, policy_version: "citycoin-master-v5", created_at: T, updated_at: T };
  const sample = { ...k, utc_hour: 490000, segment: 0, slot: 1, taken_at: T, holders_hash: "h", holder_count: 3, blob_key: "b", status: "ok" };
  const action = { action_key: "devnet|P|coin-1|q|490000|holder_batch|0", ...k, quote_mint: "q", utc_hour: 490000, action: "holder_batch", batch: 0, status: "planned", attempts: 0, created_at: T, updated_at: T };
  const leaf = { ...k, quote_mint: "q", utc_hour: 490000, leaf_index: 0, wallet: W(1), amount_raw: "1000", status: "owed", paid_tx: null };
  for (const [table, row, message, change] of [
    ["hourly_runs", run, "hourly_run_permanent", "UPDATE hourly_runs SET utc_hour = 490001"],
    ["hourly_samples", sample, "hourly_sample_permanent", "UPDATE hourly_samples SET segment = 1"],
    ["hourly_actions", action, "hourly_action_permanent", "UPDATE hourly_actions SET batch = 1"],
    ["hourly_leaves", leaf, "hourly_leaf_permanent", "UPDATE hourly_leaves SET wallet = 'Wredirect'"],
  ]) {
    await ins(db, table, row);
    const kept = await rowsOf(db, table);
    for (const s of [{ sql: `DELETE FROM ${table}` }, insertSql("INSERT OR REPLACE INTO", table, row), insertSql("INSERT OR IGNORE INTO", table, row), { sql: change },
      { sql: `UPDATE ${table} SET rowid = 99` }]) {
      await assert.rejects(exec(db, s), new RegExp(message), `${table}: ${s.sql}`);
      assert.equal(await rowsOf(db, table), kept, `${table}: ${s.sql}`);
    }
  }
  await assert.rejects(exec(db, { sql: "UPDATE hourly_leaves SET amount_raw = '1'" }), /hourly_leaf_permanent/);
  // the work moves on: status and progress fields change
  await exec(db, { sql: "UPDATE hourly_runs SET status = 'allocated', funded_raw = '10', allocated_raw = '9', dust_raw = '1'" });
  await exec(db, { sql: "UPDATE hourly_samples SET status = 'unreliable'" });
  await exec(db, { sql: "UPDATE hourly_actions SET status = 'sent', signature = 'sig', attempts = 1" });
  await exec(db, { sql: "UPDATE hourly_actions SET status = 'confirmed', slot = 5" });
  await assert.rejects(exec(db, { sql: "UPDATE hourly_actions SET status = 'planned'" }), /hourly_action_permanent/, "confirmed is final");
  await exec(db, { sql: "UPDATE hourly_leaves SET status = 'paid', paid_tx = 'tx'" });
  await assert.rejects(exec(db, { sql: "UPDATE hourly_leaves SET status = 'owed'" }), /hourly_leaf_permanent/, "paid is final");
  await assert.rejects(exec(db, { sql: "UPDATE hourly_leaves SET paid_tx = 'other'" }), /hourly_leaf_permanent/);
  await ins(db, "hourly_leaves", { ...leaf, leaf_index: 1, wallet: W(2) });
  await exec(db, { sql: "UPDATE hourly_leaves SET status = 'claimed' WHERE leaf_index = 1" });
  await assert.rejects(exec(db, { sql: "UPDATE hourly_leaves SET status = 'paid' WHERE leaf_index = 1" }), /hourly_leaf_permanent/, "claimed is final");
});

test("the doc's CHECK constraints and unique and partial indexes hold (a sample of each kind)", async () => {
  const db = d1();
  for (const id of IDS) await runner()(db, id);
  const cycle = (id, mode, city, n, status) => ({ id, mode, city_id: city, cycle: n, boundary_at: T, status, policy_version: "v", created_at: T, updated_at: T });
  await ins(db, "selection_cycles", cycle(1, "live", "c-1", 1, "selected"));
  await assert.rejects(ins(db, "selection_cycles", cycle(2, "live", "c-1", 2, "selected")), /UNIQUE/, "one winner per city and mode");
  await ins(db, "selection_cycles", cycle(3, "shadow", "c-1", 2, "selected"));
  await assert.rejects(ins(db, "selection_cycles", cycle(4, "live", "c-1", 1, "empty")), /UNIQUE/, "one cycle per (mode, city, cycle)");
  await assert.rejects(ins(db, "selection_cycles", cycle(5, "live", "c-2", 1, "skipped")), /CHECK/);
  await assert.rejects(ins(db, "selection_snapshots", { cycle_id: 1, attempt: 1, provider: "C", status: "ok", read_at: T }), /CHECK/);
  const app = (id, status) => ({ id, user_id: 1, wallet: W(1), country: "US", city_id: "c-1", status, summary: "s", policy_version: "v", created_at: T, updated_at: T });
  await ins(db, "manager_applications", app(1, "submitted"));
  await assert.rejects(ins(db, "manager_applications", app(2, "draft")), /UNIQUE/, "one open application per wallet and country");
  await exec(db, { sql: "UPDATE manager_applications SET status = 'rejected' WHERE id = 1" });
  await ins(db, "manager_applications", app(2, "draft"));
  const req = (id, status) => ({ id, city_id: "c-1", user_id: 1, wallet: W(1), status, base_version: 1, reason: "r", policy_version: "v", created_at: T, updated_at: T });
  await ins(db, "city_metadata_requests", req(1, "under_review"));
  await assert.rejects(ins(db, "city_metadata_requests", req(2, "draft")), /UNIQUE/, "one open request per city");
  await ins(db, "city_metadata_requests", req(3, "rejected"));
  const upload = (over) => ({ city_id: "c-1", user_id: 1, original_type: "image/png", original_bytes_len: 10, width: 10, height: 10, stripped_sha256: "s", storage_key: "k", status: "quarantined", created_at: T, ...over });
  await ins(db, "city_metadata_uploads", upload({}));
  for (const bad of [{ original_type: "image/svg+xml" }, { original_bytes_len: 10000001 }, { original_bytes_len: 0 }, { width: 4097 }, { height: 0 }, { status: "public" }]) {
    await assert.rejects(ins(db, "city_metadata_uploads", upload(bad)), /CHECK/, JSON.stringify(bad));
  }
  const prep = (id, stage) => ({ id, city_id: "c-1", founder: W(1), version_id: 1, quote_config_id: 1, stage, created_at: T, expires_at: T });
  await ins(db, "launch_preparations", prep("p1", "built"));
  await assert.rejects(ins(db, "launch_preparations", prep("p2", "prepared")), /UNIQUE/, "one open preparation per city");
  await ins(db, "launch_preparations", prep("p3", "expired"));
  const ev = (id, body) => ({ id, user_id: 1, wallet: W(1), city_id: "c-1", country: "US", kind: "initiative", title: "t", summary: "s", body_hash: body, status: "submitted", created_at: T, updated_at: T });
  await ins(db, "activity_evidence", ev(1, "b1"));
  await assert.rejects(ins(db, "activity_evidence", ev(2, "b1")), /UNIQUE/, "one evidence per body");
  assert.equal((await db.prepare("SELECT links_json FROM activity_evidence WHERE id = 1").first()).links_json, "[]");
  await assert.rejects(ins(db, "hourly_samples", { cluster: "d", program_id: P, coin: "c", utc_hour: 1, segment: 5, slot: 1, taken_at: T, holders_hash: "h", holder_count: 1, blob_key: "b", status: "ok" }), /CHECK/);
  await assert.rejects(ins(db, "idempotency_keys", { scope: "s", key: "k", request_hash: "h", status: "maybe", created_at: T, expires_at: T }), /CHECK/);
  await ins(db, "idempotency_keys", { scope: "s", key: "k", request_hash: "h", status: "in_progress", created_at: T, expires_at: T });
  await assert.rejects(ins(db, "idempotency_keys", { scope: "s", key: "k", request_hash: "h2", status: "done", created_at: T, expires_at: T }), /UNIQUE/);
  await ins(db, "national_ranks", { mode: "live", cycle: 1, country: "US", user_id: 1, wallet: W(1), raw: "5", rank: 1, computed_at: T });
  await assert.rejects(ins(db, "national_ranks", { mode: "live", cycle: 1, country: "US", user_id: 2, wallet: W(2), raw: "5", rank: 1, computed_at: T }), /UNIQUE/, "one rank 1");
  // the derived caches and mutable queues have no trigger: they are rewritten freely
  await ins(db, "activity_totals", { user_id: 1, total: 2, by_category: "{}", computed_at: T, policy_version: "v" });
  await ins(db, "activity_totals", { user_id: 1, total: 4, by_category: "{}", computed_at: T, policy_version: "v" }, "INSERT OR REPLACE INTO");
  await exec(db, { sql: "DELETE FROM national_ranks" });
  await ins(db, "job_leases", { name: "selection", holder: "a", fencing: 1, acquired_at: T, expires_at: T });
  await exec(db, { sql: "INSERT INTO job_leases (name, holder, fencing, acquired_at, expires_at) VALUES ('selection', 'b', 1, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, fencing = job_leases.fencing + 1 WHERE job_leases.expires_at < ?", params: [T, T, "9999"] });
  assert.deepEqual(await db.prepare("SELECT holder, fencing FROM job_leases").first(), { holder: "b", fencing: 2 }, "the section 3.8 lease acquisition works");
});
