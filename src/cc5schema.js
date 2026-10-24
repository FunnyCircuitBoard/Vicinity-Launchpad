/**
 * Citycoin.dev master v5, stage S08: the additive D1 schema groups of docs/citycoin-master/schema-and-api.md section 3 and the runner that
 * creates them lazily (docs/citycoin-master/schema-migrations.md is the stage record: every reading of the design made here is listed there
 * with its doc line).
 *
 * NOTHING HERE RUNS TODAY. No route, job or src/index.js path imports this module (test/cc5-schema.test.js keeps it that way until the feature
 * stage that needs a group adds its own call), so with every switch at its default the Worker issues exactly the D1 statements it issues
 * today and the built pages are unchanged. A feature stage calls ensureCc5Group(env, id) before its first read or write of the group's
 * tables and answers 503 not_enabled for that feature alone when the call rejects. ensureCc5Group itself refuses (fails closed) unless the
 * Worker's own settings need the group: a switch that needs it has left its default AND the v5 configuration check accepts the deployment
 * (cc5GateRefusal below). A feature stage still reads its switch through its own gate in src/v5policy.js before calling it.
 *
 *   CC5_ORDER          the order of section 3.10 step 2: cc5-identity (reserved for stage S09, not built here), then cc5-ops (before the
 *                      first job that takes a lease: the selection job), cc5-selection, cc5-activity, cc5-managers, cc5-metadata, cc5-launch,
 *                      cc5-hourly. Only prerequisites are ordered at run time: a group is created when its own switch first leaves its
 *                      default (doc rule 2), so cc5-hourly may well exist before cc5-selection.
 *   CC5_GROUPS         id -> { id, section, switches, requires, statements }. `switches` names the switch values that need the group (each
 *                      one a value other than the switch's default); `requires` the groups that must exist first; `statements` the
 *                      statement list, one statement per entry (never split SQL text: triggers hold semicolons inside BEGIN ... END).
 *                      An entry is SQL text (CREATE ... IF NOT EXISTS) or { table, column, sql } for an ALTER TABLE ... ADD COLUMN, which
 *                      runs only when PRAGMA table_info shows the column missing ("duplicate column" from a racing isolate is ignored).
 *                      No group of this stage alters an existing table; the form exists for cc5-identity.
 *   groupsForFlags(f)  the groups the switches in `f` need, prerequisites included, in CC5_ORDER (pure; `f` maps switch names to values,
 *                      as the gate applies them; a value outside a group's list, including any malformed value, needs nothing).
 *   cc5GateRefusal(env, id)  null when this Worker's settings need group `id` (a switch that needs it is set, and the v5 configuration check
 *                      accepts the deployment), else the reason: "switch_at_default" or "config_refused". Never throws.
 *   ensureCc5Group(env, id)  the Worker's entry: refuses with the gate's reason unless cc5GateRefusal(env, id) is null (and refuses a bare
 *                      database: "env_required"), then creates the group `id` and its prerequisites on env.DB (each statement its own
 *                      step) and records `id` in the existing schema_migrations table, only after every statement succeeded. Safe to repeat
 *                      and to run from two isolates at once (every statement is IF NOT EXISTS or column-guarded; the record is INSERT OR
 *                      IGNORE). Only a success is cached per isolate; a failure, or a call that outlives its time limit (10 s), is
 *                      forgotten, so the next call retries. Resolves to the ids now in place (the group and its prerequisites, in
 *                      CC5_ORDER); rejects with a Cc5SchemaError.
 *   cc5Runner(opts)    the same runner without the gate, over any registry and any database object: the backup step's rehearsal on a
 *                      restored local copy (scripts/citycoin/backup.mjs) and the tests use it. Never called from the Worker.
 *   Cc5SchemaError     name "Cc5SchemaError", status 503, code "not_enabled"; `group` is the id asked for (an id outside the registry is
 *                      shown quoted and cut to 40 characters), `failed` the group whose step failed (the same, or a prerequisite),
 *                      `reason` one of unknown_group, group_not_built, env_required, switch_at_default, config_refused, no_database,
 *                      registry_invalid, prepare_failed, record_read_failed, statement_failed, record_failed, prerequisite_failed, timeout;
 *                      `inner` the prerequisite's own reason (prerequisite_failed only); `step` the index of the failed statement.
 *   keptInsert(table, row, key)  the idempotent insert for a kept table (see below): { sql, params }.
 *
 * Append-only and immutable tables (doc rule 6, and each "append-only" or "immutable" mark in section 3) reject UPDATE and DELETE with BEFORE
 * triggers that RAISE(ABORT, '<name>'), AND reject an INSERT that would collide with a kept row on any unique key (`<table>_no_overwrite`):
 * INSERT OR REPLACE and UPDATE OR REPLACE delete the old row WITHOUT firing its DELETE triggers (D1 runs with recursive_triggers off), so
 * without that guard REPLACE could rewrite history. A BEFORE INSERT trigger fires before conflict resolution, so the guard also turns
 * INSERT OR IGNORE, ON CONFLICT DO NOTHING and ON CONFLICT DO UPDATE on a kept row into the same named error: writers of these tables use a
 * plain INSERT, or the guarded INSERT ... SELECT ... WHERE NOT EXISTS (...) of doc rule 4 (keptInsert below), never a conflict clause.
 * Where a row becomes kept only in a state (a founded city, a launched city's metadata, a confirmed hourly action, a leaf whose root is on
 * chain), `<table>_..._no_takeover` also stops an UPDATE OR REPLACE of another row from deleting it by moving onto its key. Every kept table
 * refuses a row whose rowid is below 1 (`<table>_rowid_positive`; for receipts, a missing cycle id), so the overwrite guard can skip the
 * undefined NEW.rowid of an insert that names no rowid without missing a kept row.
 */
import { ensureSchema } from "./store.js";
import { deploymentFromEnv, policyConfig } from "./v5policy.js";

/** Groups named in CC5_ORDER whose statements belong to another stage: stage S09 (local branch cc/s09) adds cc5-identity, first. */
export const CC5_RESERVED = Object.freeze({
  "cc5-identity": "schema-and-api.md section 3.1, stage S09: runs first, after ONBOARD_MIGRATION (src/store.js); not built in stage S08",
});

/** Section 3.10 step 2. cc5-ops sits before the first job that takes a lease (the selection job, under the 'selection' lease). */
export const CC5_ORDER = Object.freeze([
  "cc5-identity", "cc5-ops", "cc5-selection", "cc5-activity", "cc5-managers", "cc5-metadata", "cc5-launch", "cc5-hourly",
]);

/** How long one ensureCc5Group call may take before it fails closed (a D1 binding call has no timeout of its own). */
export const CC5_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ trigger builders */

const abort = (message) => `BEGIN SELECT RAISE(ABORT, '${message}'); END`;

/**
 * The SQL that is true for an existing row of the table (columns unqualified, inside SELECT ... FROM <table>) when the new row (NEW.*)
 * would collide with it: on the rowid, then on each of `keys`, which is a column, a list of columns, or { cols, where, newWhere } for a
 * partial unique index (a collision needs both rows inside the index). An INTEGER PRIMARY KEY is the rowid itself, so it is never listed.
 * `mode` "insert": in a BEFORE INSERT trigger NEW.rowid is undefined unless the statement names the rowid (SQLite reads it as -1, exactly
 * like an explicit -1), so the rowid is compared only when it is a real one (> 0); no kept table holds a rowid below 1 to be missed
 * (rowidPositive). `mode` "update": NEW.rowid is the row's new rowid, compared as it is.
 */
function collides(keys, mode) {
  const parts = [mode === "insert" ? "(NEW.rowid > 0 AND rowid = NEW.rowid)" : "rowid = NEW.rowid"];
  for (const k of keys) {
    if (typeof k === "string") parts.push(`${k} = NEW.${k}`);
    else if (Array.isArray(k)) parts.push(`(${k.map((c) => `${c} = NEW.${c}`).join(" AND ")})`);
    else parts.push(`(${k.cols.map((c) => `${c} = NEW.${c}`).join(" AND ")} AND ${k.where} AND ${k.newWhere})`);
  }
  return parts.join(" OR ");
}
const keptAnd = (kept) => (kept ? `(${kept}) AND ` : "");

/** BEFORE INSERT: no new row may replace a kept row (kept = SQL on the existing row; null = every row is kept). */
const noOverwrite = (name, table, message, keys, kept = null) =>
  `CREATE TRIGGER IF NOT EXISTS ${name} BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${keptAnd(kept)}(${collides(keys, "insert")})) ${abort(message)}`;

/**
 * BEFORE UPDATE, on a table whose rows are kept only in a state (the others refuse every rowid change): no update of another row may move
 * onto a kept row's key (UPDATE OR REPLACE would delete the kept row), and no row may move to a rowid below 1 (see rowidPositive).
 */
const noTakeover = (name, table, message, keys, kept = null) =>
  `CREATE TRIGGER IF NOT EXISTS ${name} BEFORE UPDATE ON ${table} WHEN NEW.rowid < 1 OR EXISTS (SELECT 1 FROM ${table} WHERE rowid <> OLD.rowid AND ${keptAnd(kept)}(${collides(keys, "update")})) ${abort(message)}`;

/**
 * AFTER INSERT: the stored rowid is a real one. SQLite gives an automatic rowid one above the largest in the table, so a single row below 1
 * would make the next automatic rowid 0 or negative; an explicit rowid below 1 is refused here, and an update to one by noTakeover (every
 * other kept table refuses any rowid change), so every rowid of a kept table, automatic or not, stays at 1 or above.
 */
const rowidPositive = (table, message) =>
  `CREATE TRIGGER IF NOT EXISTS ${table}_rowid_positive AFTER INSERT ON ${table} WHEN NEW.rowid < 1 ${abort(message)}`;

const changed = (cols) => cols.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ");

/** No UPDATE, no DELETE, no overwrite, no rowid below 1: the triggers of an append-only (or immutable) table. */
const appendOnly = (table, message, keys) => [
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} ${abort(message)}`,
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} ${abort(message)}`,
  noOverwrite(`${table}_no_overwrite`, table, message, keys),
  rowidPositive(table, message),
];

/** A keyed record that is never deleted or replaced and whose key columns never change (the hourly runs, samples and actions). */
const keptRecord = (table, message, keys, fixed) => [
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} ${abort(message)}`,
  noOverwrite(`${table}_no_overwrite`, table, message, keys),
  `CREATE TRIGGER IF NOT EXISTS ${table}_keys_fixed BEFORE UPDATE ON ${table} WHEN ${changed(["rowid", ...fixed])} ${abort(message)}`,
  rowidPositive(table, message),
];

/* ------------------------------------------------------------------ 3.8 job leases and idempotency keys: cc5-ops */

const OPS = [
  // name: 'selection' | 'hourly' | 'keeper' | 'activity'; holder: random id of the run; fencing: +1 on every acquisition. Acquisition only by
  // the doc's conditional upsert (3.8); a lease row is never deleted or replaced (a reset fencing would let a run that lost its lease write)
  `CREATE TABLE IF NOT EXISTS job_leases (
  name        TEXT NOT NULL PRIMARY KEY,
  holder      TEXT NOT NULL,
  fencing     INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
)`,
  // fencing never goes back (schema-migrations.md, reading R23): no DELETE; an update keeps the name and the rowid, never lowers fencing, and
  // a new holder comes with a higher fencing. INSERT OR REPLACE cannot be refused without refusing the doc's upsert too: writers never use it
  `CREATE TRIGGER IF NOT EXISTS job_leases_no_delete BEFORE DELETE ON job_leases ${abort("job_lease_fenced")}`,
  `CREATE TRIGGER IF NOT EXISTS job_leases_fencing_forward BEFORE UPDATE ON job_leases WHEN NEW.name IS NOT OLD.name OR NEW.rowid IS NOT OLD.rowid OR NEW.fencing < OLD.fencing OR (NEW.holder IS NOT OLD.holder AND NEW.fencing <= OLD.fencing) ${abort("job_lease_fenced")}`,
  // scope: route + user id, or 'job:<name>'; request_hash: sha256 of method, path and canonical body; response_json: never a secret or a
  // one-time code (routes that return one are not replayable and take no key; schema-and-api.md section 5); expires_at: 24 hours
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope           TEXT NOT NULL,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('in_progress','done')),
  response_status INTEGER,
  response_json   TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  PRIMARY KEY (scope, key)
)`,
  "CREATE INDEX IF NOT EXISTS idempotency_keys_expires ON idempotency_keys (expires_at)",
];

/* ------------------------------------------------------------------ 3.2 selection, snapshots, receipts, FounderRecord mirror: cc5-selection */

const FOUNDED = "status = 'founded'";
const SELECTION = [
  // opened_at: the first city_assignments row, or the moment SELECTION_V5 first left "off"; first_cycle: selectionEpoch(opened_at) + 1.
  // KEPT once founded (a founded city is terminal): no update, delete, replace or takeover
  `CREATE TABLE IF NOT EXISTS selection_cities (
  city_id       TEXT NOT NULL PRIMARY KEY,
  country       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('awaiting','processing','founded')),
  opened_at     TEXT NOT NULL,
  first_cycle   INTEGER NOT NULL,
  founded_cycle INTEGER,
  updated_at    TEXT NOT NULL
)`,
  // the doc's trigger: a founded city is terminal
  `CREATE TRIGGER IF NOT EXISTS selection_cities_founded_terminal BEFORE UPDATE ON selection_cities WHEN OLD.status = 'founded' ${abort("city_already_founded")}`,
  // terminal also against DELETE and REPLACE (schema-migrations.md, reading R3)
  `CREATE TRIGGER IF NOT EXISTS selection_cities_founded_no_delete BEFORE DELETE ON selection_cities WHEN OLD.status = 'founded' ${abort("city_already_founded")}`,
  noOverwrite("selection_cities_founded_no_overwrite", "selection_cities", "city_already_founded", ["city_id"], FOUNDED),
  noTakeover("selection_cities_founded_no_takeover", "selection_cities", "city_already_founded", ["city_id"], FOUNDED),
  rowidPositive("selection_cities", "city_already_founded"),

  // claimed_until, claim_token: the per-cycle claim under the 'selection' lease (D10); digest: sha256 of the canonical receipt; error_code e.g.
  // supply_mismatch, provider_disagreement, slot_disagreement, verifier_disagreement
  `CREATE TABLE IF NOT EXISTS selection_cycles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  mode              TEXT NOT NULL CHECK (mode IN ('shadow','live')),
  city_id           TEXT NOT NULL,
  cycle             INTEGER NOT NULL,
  boundary_at       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('due','processing','data_error','empty','selected')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  error_code        TEXT,
  claimed_until     TEXT,
  claim_token       TEXT,
  cutoff_slot       INTEGER,
  cutoff_block_time TEXT,
  next_slot         INTEGER,
  next_block_time   TEXT,
  candidate_count   INTEGER,
  digest            TEXT,
  winner_wallet     TEXT,
  policy_version    TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (mode, city_id, cycle)
)`,
  "CREATE INDEX IF NOT EXISTS selection_cycles_due ON selection_cycles (mode, status, boundary_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS selection_cycles_one_winner ON selection_cycles (mode, city_id) WHERE status = 'selected'",

  // blob_key: the full input in the existing chunked blobs table, readable by the verifier and the owner only
  `CREATE TABLE IF NOT EXISTS selection_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id              INTEGER NOT NULL,
  attempt               INTEGER NOT NULL,
  provider              TEXT NOT NULL CHECK (provider IN ('A','B','verifier')),
  cutoff_slot           INTEGER,
  supply_raw            TEXT,
  sum_all_accounts_raw  TEXT,
  candidate_vector_hash TEXT,
  blob_key              TEXT,
  status                TEXT NOT NULL CHECK (status IN ('ok','incomplete','supply_mismatch','error')),
  read_at               TEXT NOT NULL,
  UNIQUE (cycle_id, attempt, provider)
)`,

  // KEPT: never deleted or replaced; immutable once verifier_digest is set. verifier_digest is written only when it equals digest (a
  // disagreement is selection_cycles.error_code 'verifier_disagreement', retried on the same cycle: open item O17); receipt_json keeps
  // private fields out (they stay in the blob)
  `CREATE TABLE IF NOT EXISTS selection_receipts (
  cycle_id        INTEGER PRIMARY KEY,
  digest          TEXT NOT NULL UNIQUE,
  merkle_root     TEXT NOT NULL,
  receipt_json    TEXT NOT NULL,
  public_json     TEXT NOT NULL,
  verifier_digest TEXT,
  created_at      TEXT NOT NULL
)`,
  // the doc's two triggers: immutable once the verifier's digest is recorded, never deleted
  `CREATE TRIGGER IF NOT EXISTS selection_receipts_no_update BEFORE UPDATE ON selection_receipts WHEN OLD.verifier_digest IS NOT NULL ${abort("receipt_immutable")}`,
  `CREATE TRIGGER IF NOT EXISTS selection_receipts_no_delete BEFORE DELETE ON selection_receipts ${abort("receipt_immutable")}`,
  // never deleted, so never replaced either (reading R4); cycle_id is the rowid, so the rowid term covers it
  noOverwrite("selection_receipts_no_overwrite", "selection_receipts", "receipt_immutable", ["digest"]),
  noTakeover("selection_receipts_no_takeover", "selection_receipts", "receipt_immutable", ["digest"]),
  // a receipt names its cycle: a missing cycle id would otherwise be given the next rowid, a permanent receipt for the wrong cycle (reading R24)
  `CREATE TRIGGER IF NOT EXISTS selection_receipts_cycle_required BEFORE INSERT ON selection_receipts WHEN NEW.cycle_id IS NULL OR NEW.cycle_id < 1 ${abort("receipt_cycle_required")}`,

  `CREATE TABLE IF NOT EXISTS national_ranks (
  mode        TEXT NOT NULL,
  cycle       INTEGER NOT NULL,
  country     TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  wallet      TEXT NOT NULL,
  raw         TEXT NOT NULL,
  rank        INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (mode, cycle, country, user_id)
)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS national_ranks_rank ON national_ranks (mode, cycle, country, rank)",

  // KEPT (append-only): the FounderRecord mirror. wallet: one account, one fixed city in this release (§19), so one founder seat per wallet
  `CREATE TABLE IF NOT EXISTS founder_records (
  city_id        TEXT NOT NULL PRIMARY KEY,
  country        TEXT NOT NULL,
  wallet         TEXT NOT NULL UNIQUE,
  user_id        INTEGER,
  cycle          INTEGER NOT NULL,
  cutoff_slot    INTEGER NOT NULL,
  snapshot_hash  TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  selected_at    TEXT NOT NULL,
  cluster        TEXT NOT NULL,
  program_id     TEXT NOT NULL,
  chain_pda      TEXT NOT NULL UNIQUE,
  chain_tx       TEXT NOT NULL,
  chain_slot     INTEGER NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('selection','legacy_evidence')),
  recorded_at    TEXT NOT NULL
)`,
  // the doc's founder_records_no_update and founder_records_no_delete, plus the overwrite guard
  ...appendOnly("founder_records", "founder_record_immutable", ["city_id", "wallet", "chain_pda"]),
];

/* ------------------------------------------------------------------ 3.3 country-manager applications: cc5-managers */

const MANAGERS = [
  // checks_at_submit: JSON of founder record, confirmed launch, points, national rank (cycle, computed_at), standing; checks_hash: sha256 of the
  // checks the owner saw (a decision must echo it); decided_by: the owner wallet
  `CREATE TABLE IF NOT EXISTS manager_applications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL,
  wallet             TEXT NOT NULL,
  country            TEXT NOT NULL,
  city_id            TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft','submitted','under_review','approved','rejected','withdrawn','needs_requalification')),
  summary            TEXT NOT NULL,
  checks_at_submit   TEXT,
  checks_at_decision TEXT,
  checks_hash        TEXT,
  decision_note      TEXT,
  decided_by         TEXT,
  decided_at         TEXT,
  policy_version     TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  submitted_at       TEXT,
  updated_at         TEXT NOT NULL
)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS manager_applications_open ON manager_applications (wallet, country) WHERE status IN ('draft','submitted','under_review','needs_requalification')",
  "CREATE INDEX IF NOT EXISTS manager_applications_queue ON manager_applications (country, status, submitted_at)",

  // KEPT (append-only)
  `CREATE TABLE IF NOT EXISTS manager_application_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  at             TEXT NOT NULL,
  actor_kind     TEXT NOT NULL CHECK (actor_kind IN ('applicant','owner','system')),
  actor          TEXT,
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  checks_json    TEXT,
  note           TEXT
)`,
  ...appendOnly("manager_application_events", "manager_application_event_append_only", []),

  // KEPT: never deleted or replaced; the one update ends the term
  `CREATE TABLE IF NOT EXISTS country_managers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  country        TEXT NOT NULL,
  user_id        INTEGER NOT NULL,
  wallet         TEXT NOT NULL,
  application_id INTEGER NOT NULL UNIQUE,
  appointed_by   TEXT NOT NULL,
  appointed_at   TEXT NOT NULL,
  ended_at       TEXT,
  ended_by       TEXT,
  end_reason     TEXT CHECK (end_reason IN ('revoked','replaced'))
)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS country_managers_active ON country_managers (country) WHERE ended_at IS NULL",
  // the doc: no DELETE; UPDATE only sets ended_at, ended_by and end_reason, once (reading R6: the one update ends the term and sets all three)
  `CREATE TRIGGER IF NOT EXISTS country_managers_no_delete BEFORE DELETE ON country_managers ${abort("country_manager_append_only")}`,
  `CREATE TRIGGER IF NOT EXISTS country_managers_end_once BEFORE UPDATE ON country_managers WHEN OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL OR NEW.ended_by IS NULL OR NEW.end_reason IS NULL OR ${changed(["id", "country", "user_id", "wallet", "application_id", "appointed_by", "appointed_at"])} ${abort("country_manager_append_only")}`,
  noOverwrite("country_managers_no_overwrite", "country_managers", "country_manager_append_only",
    ["application_id", { cols: ["country"], where: "ended_at IS NULL", newWhere: "NEW.ended_at IS NULL" }]),
  rowidPositive("country_managers", "country_manager_append_only"),
];

/* ------------------------------------------------------------------ 3.4 activity ledger: cc5-activity */

const ACTIVITY = [
  // KEPT (append-only). source_type: 'chain_launch' | 'post' | 'evidence' | 'reversal'; points: from the policy at write time, and a reversal
  // row carries 0 and names what it reverses (reverses_id); activity_at: the time of the source activity (decides the UTC day); dedup_key:
  // 'launch:<city>', 'post:<id>', 'reply:<id>', 'evidence:<id>', 'reversal:<event id>' (written with keptInsert, so a repeat is a no-op)
  `CREATE TABLE IF NOT EXISTS activity_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  wallet         TEXT,
  city_id        TEXT,
  country        TEXT,
  event_type     TEXT NOT NULL CHECK (event_type IN ('launch','post','reply','initiative','proposal','reversal')),
  source_type    TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  points         INTEGER NOT NULL,
  activity_at    TEXT NOT NULL,
  self_reply     INTEGER NOT NULL DEFAULT 0,
  review_state   TEXT NOT NULL CHECK (review_state IN ('auto','accepted')),
  dedup_key      TEXT NOT NULL UNIQUE,
  reverses_id    INTEGER UNIQUE,
  policy_version TEXT NOT NULL,
  created_at     TEXT NOT NULL
)`,
  "CREATE INDEX IF NOT EXISTS activity_events_user ON activity_events (user_id, event_type, activity_at)",
  ...appendOnly("activity_events", "activity_event_append_only", ["dedup_key", "reverses_id"]),

  // event_id: the activity_events row an acceptance appended
  `CREATE TABLE IF NOT EXISTS activity_evidence (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  wallet       TEXT NOT NULL,
  city_id      TEXT NOT NULL,
  country      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('initiative','proposal')),
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  links_json   TEXT NOT NULL DEFAULT '[]',
  media_id     INTEGER,
  body_hash    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('submitted','accepted','rejected','duplicate','withdrawn')),
  duplicate_of INTEGER,
  reviewer     TEXT,
  review_note  TEXT,
  reviewed_at  TEXT,
  event_id     INTEGER UNIQUE,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS activity_evidence_body ON activity_evidence (user_id, kind, body_hash)",
  "CREATE INDEX IF NOT EXISTS activity_evidence_queue ON activity_evidence (status, created_at)",

  // a derived cache, rebuilt at any time from activity_events: no trigger. user_id is the rowid: writers always bind it (open item O9)
  `CREATE TABLE IF NOT EXISTS activity_totals (
  user_id        INTEGER PRIMARY KEY,
  total          INTEGER NOT NULL,
  by_category    TEXT NOT NULL,
  computed_at    TEXT NOT NULL,
  policy_version TEXT NOT NULL
)`,
];

/* ------------------------------------------------------------------ 3.5 city metadata: cc5-metadata */

const LAUNCHED = "launched_mint IS NOT NULL";
const ACTIVE_KEYS = ["city_id", "ticker", "launched_mint"];
const METADATA = [
  // KEPT (append-only). version: 1 = the registry default, +1 per approved request; descriptive_text: the approved text (location and pair
  // are rendered, never typed); image_sha256: coin_art.sha256; content_hash: sha256 of the pair-independent canonical content
  `CREATE TABLE IF NOT EXISTS city_metadata_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id          TEXT NOT NULL,
  version          INTEGER NOT NULL,
  origin           TEXT NOT NULL CHECK (origin IN ('default','approved_request')),
  request_id       INTEGER,
  ticker           TEXT NOT NULL,
  name             TEXT NOT NULL,
  descriptive_text TEXT NOT NULL,
  image_sha256     TEXT NOT NULL,
  canonical_json   TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  per_quote_json   TEXT NOT NULL,
  registry_version INTEGER,
  policy_version   TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (city_id, version),
  UNIQUE (city_id, content_hash)
)`,
  ...appendOnly("city_metadata_versions", "metadata_version_append_only", [["city_id", "version"], ["city_id", "content_hash"]]),

  // KEPT once launched_mint is set. ticker: the global ticker lock before launch; publish_tx: the chain confirmation of the version (null only
  // for a default not yet in a published root); launched_mint: set once at the confirmed launch, afterwards nothing here may change
  `CREATE TABLE IF NOT EXISTS city_metadata_active (
  city_id       TEXT NOT NULL PRIMARY KEY,
  version_id    INTEGER NOT NULL,
  version       INTEGER NOT NULL,
  ticker        TEXT NOT NULL UNIQUE,
  activated_at  TEXT NOT NULL,
  publish_tx    TEXT,
  publish_slot  INTEGER,
  launched_mint TEXT UNIQUE
)`,
  // the doc's trigger: nothing changes once the launched mint is set (so it is set once)
  `CREATE TRIGGER IF NOT EXISTS city_metadata_active_frozen_after_launch BEFORE UPDATE ON city_metadata_active WHEN OLD.launched_mint IS NOT NULL ${abort("metadata_frozen_after_launch")}`,
  // ... also against DELETE and REPLACE (reading R7)
  `CREATE TRIGGER IF NOT EXISTS city_metadata_active_launched_no_delete BEFORE DELETE ON city_metadata_active WHEN OLD.launched_mint IS NOT NULL ${abort("metadata_frozen_after_launch")}`,
  noOverwrite("city_metadata_active_launched_no_overwrite", "city_metadata_active", "metadata_frozen_after_launch", ACTIVE_KEYS, LAUNCHED),
  noTakeover("city_metadata_active_launched_no_takeover", "city_metadata_active", "metadata_frozen_after_launch", ACTIVE_KEYS, LAUNCHED),
  rowidPositive("city_metadata_active", "metadata_frozen_after_launch"),

  // stripped_sha256: after EXIF, XMP, text and location chunks are removed; normalized_sha256: the square PNG the coin would publish;
  // storage_key: private (chunked blobs or a private bucket), never a public URL
  `CREATE TABLE IF NOT EXISTS city_metadata_uploads (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id            TEXT NOT NULL,
  user_id            INTEGER NOT NULL,
  original_type      TEXT NOT NULL CHECK (original_type IN ('image/png','image/jpeg','image/webp')),
  original_bytes_len INTEGER NOT NULL CHECK (original_bytes_len BETWEEN 1 AND 10000000),
  width              INTEGER NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height             INTEGER NOT NULL CHECK (height BETWEEN 1 AND 4096),
  stripped_sha256    TEXT NOT NULL,
  normalized_sha256  TEXT,
  storage_key        TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('quarantined','attached','approved','discarded')),
  created_at         TEXT NOT NULL
)`,

  // wallet: must equal founder_records.wallet for the city; proposal_hash: sha256 of the canonical proposal, signed by the founder on chain
  `CREATE TABLE IF NOT EXISTS city_metadata_requests (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id              TEXT NOT NULL,
  user_id              INTEGER NOT NULL,
  wallet               TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('draft','submitted','under_review','approved_publishing','active','rejected','withdrawn','superseded')),
  base_version         INTEGER NOT NULL,
  proposed_ticker      TEXT,
  proposed_upload_id   INTEGER,
  proposed_text        TEXT,
  reason               TEXT NOT NULL,
  proposal_hash        TEXT,
  submit_tx            TEXT,
  submit_slot          INTEGER,
  decision_note        TEXT,
  decided_by           TEXT,
  decided_at           TEXT,
  publish_tx           TEXT,
  publish_slot         INTEGER,
  resulting_version_id INTEGER,
  policy_version       TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS city_metadata_requests_open ON city_metadata_requests (city_id) WHERE status IN ('draft','submitted','under_review','approved_publishing')",
  "CREATE INDEX IF NOT EXISTS city_metadata_requests_queue ON city_metadata_requests (status, updated_at)",

  // KEPT (append-only)
  `CREATE TABLE IF NOT EXISTS city_metadata_request_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL,
  at          TEXT NOT NULL,
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('founder','owner','system')),
  actor       TEXT,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT,
  chain_tx    TEXT
)`,
  ...appendOnly("city_metadata_request_events", "metadata_request_event_append_only", []),

  // a mirror of the on-chain ReviewLock (the chain is authoritative); the approval batch deletes its row: no trigger
  `CREATE TABLE IF NOT EXISTS city_review_locks (
  city_id       TEXT NOT NULL PRIMARY KEY,
  request_id    INTEGER NOT NULL UNIQUE,
  proposal_hash TEXT NOT NULL,
  base_version  INTEGER NOT NULL,
  chain_pda     TEXT NOT NULL,
  opened_tx     TEXT NOT NULL,
  opened_slot   INTEGER NOT NULL
)`,
];

/* ------------------------------------------------------------------ 3.6 launch records and preparation: cc5-launch */

const LAUNCH = [
  // KEPT (append-only, reading R8). founder: equals founder_records.wallet; metadata_hash: the per-quote JSON hash bound on chain at launch.
  // Written once from a confirmed chain read, with keptInsert keyed on (cluster, program_id, city_id), so a retried launch batch is a no-op
  `CREATE TABLE IF NOT EXISTS city_launches (
  cluster             TEXT NOT NULL,
  program_id          TEXT NOT NULL,
  city_id             TEXT NOT NULL,
  mint                TEXT NOT NULL UNIQUE,
  coin                TEXT NOT NULL,
  founder             TEXT NOT NULL,
  quote_config_id     INTEGER NOT NULL,
  quote_mint          TEXT NOT NULL,
  metadata_version_id INTEGER NOT NULL,
  metadata_hash       TEXT NOT NULL,
  ticker              TEXT NOT NULL UNIQUE,
  launch_tx           TEXT NOT NULL,
  launch_slot         INTEGER NOT NULL,
  launched_at         TEXT NOT NULL,
  recorded_at         TEXT NOT NULL,
  PRIMARY KEY (cluster, program_id, city_id)
)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS city_launches_city ON city_launches (city_id)",
  // a confirmed launch is permanent (reading R8)
  ...appendOnly("city_launches", "launch_record_immutable", [["cluster", "program_id", "city_id"], "mint", "ticker", "city_id"]),

  // only if the launch must be split into prepare and finalize (§26)
  `CREATE TABLE IF NOT EXISTS launch_preparations (
  id              TEXT NOT NULL PRIMARY KEY,
  city_id         TEXT NOT NULL,
  founder         TEXT NOT NULL,
  version_id      INTEGER NOT NULL,
  quote_config_id INTEGER NOT NULL,
  stage           TEXT NOT NULL CHECK (stage IN ('built','prepared','finalized','expired')),
  prepare_tx      TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS launch_preparations_open ON launch_preparations (city_id) WHERE stage IN ('built','prepared')",
];

/* ------------------------------------------------------------------ 3.7 hourly processing records: cc5-hourly */

const RUN_KEY = ["cluster", "program_id", "coin", "quote_mint", "utc_hour", "mode"];
const SAMPLE_KEY = ["cluster", "program_id", "coin", "utc_hour", "segment"];
const ACTION_TUPLE = ["cluster", "program_id", "coin", "quote_mint", "utc_hour", "action", "batch"];
const LEAF_KEY = ["cluster", "program_id", "coin", "quote_mint", "utc_hour", "leaf_index"];
const HOUR_OF = (a, b) => ["cluster", "program_id", "coin", "quote_mint", "utc_hour"].map((c) => `${a}.${c} = ${b}.${c}`).join(" AND ");
/**
 * A leaf is kept (never deleted, replaced or redirected) once it is a confirmed funded allocation (master §31): paid or claimed, or its hour's
 * root is on chain, which is a confirmed holder_root action (final, never deleted: a later run status cannot release the leaf) or a live
 * run in root_published, paying or done. Before that the allocation can still be corrected (a run that fails verification), and a leaf of
 * no live root is never kept (reading R9; hourly_leaves carries no mode, so shadow runs never write it: open item O13). `ref` is the row:
 * OLD in a row trigger, or the table name inside SELECT ... FROM hourly_leaves.
 */
const keptLeaf = (ref) => `(${ref}.status IN ('paid','claimed')`
  + ` OR EXISTS (SELECT 1 FROM hourly_actions a WHERE ${HOUR_OF("a", ref)} AND a.action = 'holder_root' AND a.status = 'confirmed')`
  + ` OR EXISTS (SELECT 1 FROM hourly_runs r WHERE ${HOUR_OF("r", ref)} AND r.mode = 'live' AND r.status IN ('root_published','paying','done')))`;
const HOURLY = [
  // KEPT: never deleted or replaced, keys fixed. utc_hour: floor(unix_seconds / 3600) of the hour whose holdings are measured;
  // allocated_raw: the sum of floored leaves; dust_raw: funded - allocated, carried with a public reason; carry_reason: 'insufficient_samples'
  // | 'no_recipient_weight' | 'dust' | 'below_executable_unit'. Paid, pending, liquidity and buyback balances are not stored here (open item O15)
  `CREATE TABLE IF NOT EXISTS hourly_runs (
  cluster           TEXT NOT NULL,
  program_id        TEXT NOT NULL,
  coin              TEXT NOT NULL,
  quote_mint        TEXT NOT NULL,
  utc_hour          INTEGER NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('shadow','live')),
  status            TEXT NOT NULL CHECK (status IN ('sampling','insufficient_samples','allocated','verified','root_published','paying','done','carried','failed')),
  cutoff_slot       INTEGER,
  samples_ok        INTEGER NOT NULL DEFAULT 0,
  funded_raw        TEXT,
  allocated_raw     TEXT,
  dust_raw          TEXT,
  carried_raw       TEXT,
  carry_reason      TEXT,
  recipient_count   INTEGER,
  list_hash         TEXT,
  root              TEXT,
  verifier_a_digest TEXT,
  verifier_b_digest TEXT,
  policy_version    TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (cluster, program_id, coin, quote_mint, utc_hour, mode)
)`,
  ...keptRecord("hourly_runs", "hourly_run_permanent", [RUN_KEY], RUN_KEY),

  // KEPT: never deleted or replaced, keys fixed (retention: open item O14). segment 0-3: one per 15-minute segment, 4: the cutoff balance;
  // taken_at: written after the sample (planned times are never stored or published)
  `CREATE TABLE IF NOT EXISTS hourly_samples (
  cluster      TEXT NOT NULL,
  program_id   TEXT NOT NULL,
  coin         TEXT NOT NULL,
  utc_hour     INTEGER NOT NULL,
  segment      INTEGER NOT NULL CHECK (segment BETWEEN 0 AND 4),
  slot         INTEGER NOT NULL,
  taken_at     TEXT NOT NULL,
  holders_hash TEXT NOT NULL,
  holder_count INTEGER NOT NULL,
  blob_key     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('ok','unreliable')),
  PRIMARY KEY (cluster, program_id, coin, utc_hour, segment)
)`,
  ...keptRecord("hourly_samples", "hourly_sample_permanent", [SAMPLE_KEY], SAMPLE_KEY),

  // KEPT: never deleted or replaced, keys fixed, confirmed is final. action_key: 'cluster|program|coin|quote_mint|utc_hour|action|batch' (§30),
  // and the tuple itself is unique (hourly_actions_once), so two spellings of one key cannot both exist. No mode: shadow never writes it (O13)
  `CREATE TABLE IF NOT EXISTS hourly_actions (
  action_key      TEXT NOT NULL PRIMARY KEY,
  cluster         TEXT NOT NULL,
  program_id      TEXT NOT NULL,
  coin            TEXT NOT NULL,
  quote_mint      TEXT NOT NULL,
  utc_hour        INTEGER NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('platform_payout','founder_payout','holder_root','holder_batch','buyback','liquidity_reconcile')),
  batch           INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('planned','sent','confirmed','failed','skipped')),
  amount_raw      TEXT,
  signature       TEXT,
  slot            INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error           TEXT,
  claimed_until   TEXT,
  claim_token     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
)`,
  "CREATE INDEX IF NOT EXISTS hourly_actions_work ON hourly_actions (status, next_attempt_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS hourly_actions_once ON hourly_actions (cluster, program_id, coin, quote_mint, utc_hour, action, batch)",
  ...keptRecord("hourly_actions", "hourly_action_permanent", ["action_key", ACTION_TUPLE], ["action_key", ...ACTION_TUPLE]),
  // confirmed only after the chain shows the effect: final
  `CREATE TRIGGER IF NOT EXISTS hourly_actions_confirmed_final BEFORE UPDATE ON hourly_actions WHEN OLD.status = 'confirmed' ${abort("hourly_action_permanent")}`,

  // KEPT once its root is on chain (keptLeaf above): owed until paid or claimed, with no expiry and no sweep; no mode (open item O13)
  `CREATE TABLE IF NOT EXISTS hourly_leaves (
  cluster     TEXT NOT NULL,
  program_id  TEXT NOT NULL,
  coin        TEXT NOT NULL,
  quote_mint  TEXT NOT NULL,
  utc_hour    INTEGER NOT NULL,
  leaf_index  INTEGER NOT NULL,
  wallet      TEXT NOT NULL,
  amount_raw  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('owed','paid','claimed')),
  paid_tx     TEXT,
  PRIMARY KEY (cluster, program_id, coin, quote_mint, utc_hour, leaf_index)
)`,
  // a kept leaf is never deleted, replaced, taken over or redirected (its keys, wallet and amount are fixed); paid or claimed is final
  `CREATE TRIGGER IF NOT EXISTS hourly_leaves_kept_no_delete BEFORE DELETE ON hourly_leaves WHEN ${keptLeaf("OLD")} ${abort("hourly_leaf_permanent")}`,
  noOverwrite("hourly_leaves_kept_no_overwrite", "hourly_leaves", "hourly_leaf_permanent", [LEAF_KEY], keptLeaf("hourly_leaves")),
  noTakeover("hourly_leaves_kept_no_takeover", "hourly_leaves", "hourly_leaf_permanent", [LEAF_KEY], keptLeaf("hourly_leaves")),
  `CREATE TRIGGER IF NOT EXISTS hourly_leaves_kept_fixed BEFORE UPDATE ON hourly_leaves WHEN ${keptLeaf("OLD")} AND (${changed(["rowid", ...LEAF_KEY, "wallet", "amount_raw"])}) ${abort("hourly_leaf_permanent")}`,
  `CREATE TRIGGER IF NOT EXISTS hourly_leaves_paid_final BEFORE UPDATE ON hourly_leaves WHEN OLD.status IN ('paid','claimed') ${abort("hourly_leaf_permanent")}`,
  rowidPositive("hourly_leaves", "hourly_leaf_permanent"),
];

/* ------------------------------------------------------------------ the registry */

const LEFT_OFF = Object.freeze(["shadow", "on"]); // a three-value switch (off, shadow, on) that "leaves off"
const TURNED_ON = Object.freeze(["on"]);

const group = (id, section, switches, requires, statements) => Object.freeze({
  id,
  section,
  switches: Object.freeze(switches),
  requires: Object.freeze(requires),
  statements: Object.freeze(statements.map((s) => (typeof s === "string" ? s : Object.freeze({ ...s })))),
});

export const CC5_GROUPS = Object.freeze({
  // 3.8: "created with the first of SELECTION_V5, CC_HOURLY or LAUNCH_V5"
  "cc5-ops": group("cc5-ops", "3.8", { SELECTION_V5: LEFT_OFF, CC_HOURLY: LEFT_OFF, LAUNCH_V5: TURNED_ON }, [], OPS),
  // 3.2: "created when SELECTION_V5 first leaves off"; each cycle is claimed under the 'selection' lease (cc5-ops)
  "cc5-selection": group("cc5-selection", "3.2", { SELECTION_V5: LEFT_OFF }, ["cc5-ops"], SELECTION),
  // 3.4: "created when ACTIVITY_POINTS first leaves off"
  "cc5-activity": group("cc5-activity", "3.4", { ACTIVITY_POINTS: LEFT_OFF }, [], ACTIVITY),
  // 3.3: "created when MANAGER_APPS first turns on"; reads founder records and national ranks (cc5-selection) and points (cc5-activity).
  // The configuration check refuses MANAGER_APPS=on without SELECTION_V5=on and ACTIVITY_POINTS=on, so both switches have left off already.
  "cc5-managers": group("cc5-managers", "3.3", { MANAGER_APPS: TURNED_ON }, ["cc5-selection", "cc5-activity"], MANAGERS),
  // 3.5: "created when METADATA_V5 first turns on"
  "cc5-metadata": group("cc5-metadata", "3.5", { METADATA_V5: TURNED_ON }, [], METADATA),
  // 3.6: "created when LAUNCH_V5 first turns on"; the launch batch sets city_metadata_active.launched_mint (cc5-metadata; the check refuses
  // LAUNCH_V5=on without METADATA_V5=on) and launch retries use idempotency keys (cc5-ops)
  "cc5-launch": group("cc5-launch", "3.6", { LAUNCH_V5: TURNED_ON }, ["cc5-ops", "cc5-metadata"], LAUNCH),
  // 3.7: "created when CC_HOURLY first leaves off"; the hourly and keeper jobs run under leases (cc5-ops). The founder payout destination and
  // the coin list are read from chain, or from founder_records / city_launches only once cc5-selection / cc5-launch are recorded (open item O16)
  "cc5-hourly": group("cc5-hourly", "3.7", { CC_HOURLY: LEFT_OFF }, ["cc5-ops"], HOURLY),
});

/**
 * Problems with a registry (an empty list when it is sound): every id in the order is a group or reserved, every group is in the order,
 * every prerequisite is a group placed before it, and every statement is CREATE ... IF NOT EXISTS text or a column-guarded ALTER.
 */
export function registryProblems(groups = CC5_GROUPS, order = CC5_ORDER, reserved = CC5_RESERVED) {
  const out = [];
  const pos = new Map(order.map((id, i) => [id, i]));
  if (pos.size !== order.length) out.push("order: an id is listed twice");
  for (const id of order) if (!groups[id] && !reserved[id]) out.push(`order: ${id} is neither a group nor reserved`);
  for (const [id, g] of Object.entries(groups)) {
    if (!g || g.id !== id) { out.push(`${id}: id mismatch`); continue; }
    if (!pos.has(id)) out.push(`${id}: not in the order`);
    if (reserved[id]) out.push(`${id}: also reserved`);
    for (const r of g.requires) {
      if (!groups[r]) out.push(`${id}: requires ${r}, which is not a group`);
      else if (!(pos.get(r) < pos.get(id))) out.push(`${id}: requires ${r}, which is not before it`);
    }
    g.statements.forEach((s, i) => {
      if (typeof s === "string") {
        if (!/^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS [a-z_][a-z0-9_]*\s/.test(s)) out.push(`${id}: statement ${i} is not CREATE ... IF NOT EXISTS`);
      } else if (!(s && /^[a-z_][a-z0-9_]*$/.test(s.table) && /^[a-z_][a-z0-9_]*$/.test(s.column)
        && new RegExp(`^ALTER TABLE ${s.table} ADD COLUMN ${s.column}\\s`).test(s.sql))) {
        out.push(`${id}: statement ${i} is neither CREATE ... IF NOT EXISTS nor a column-guarded ALTER TABLE ${s && s.table} ADD COLUMN ${s && s.column}`);
      }
    });
  }
  return out;
}

/* ------------------------------------------------------------------ switches to groups */

const flagValue = (flags, name) => (typeof flags[name] === "string" ? flags[name].trim().toLowerCase() : "");

/** The groups a set of switch values needs (see the top of this file). Pure; never throws. */
export function groupsForFlags(flags, groups = CC5_GROUPS, order = CC5_ORDER) {
  const f = flags !== null && typeof flags === "object" ? flags : {};
  const wanted = new Set();
  const add = (id) => {
    if (wanted.has(id) || !groups[id]) return;
    wanted.add(id);
    for (const r of groups[id].requires) add(r);
  };
  for (const id of order) {
    const g = groups[id];
    if (g && Object.entries(g.switches).some(([name, values]) => values.includes(flagValue(f, name)))) add(id);
  }
  return Object.freeze(order.filter((id) => wanted.has(id)));
}

/**
 * Why this Worker's settings do not let group `id` be created: null when a switch that needs it has left its default (groupsForFlags over
 * the switches as src/v5policy.js deploymentFromEnv reads them) AND the v5 configuration check accepts the deployment (policyConfig);
 * otherwise "switch_at_default" or "config_refused". Never throws: anything odd refuses. Each feature stage still applies its own gate first.
 */
export function cc5GateRefusal(env, id) {
  try {
    if (!groupsForFlags(deploymentFromEnv(env).flags).includes(id)) return "switch_at_default";
    if (policyConfig(env).ok !== true) return "config_refused";
    return null;
  } catch {
    return "config_refused";
  }
}

/* ------------------------------------------------------------------ writing to a kept table */

const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * The idempotent insert for a kept table (doc rule 4; schema-migrations.md section 3): { sql, params } for
 *   INSERT INTO <table> (<columns of row>) SELECT ?, ... WHERE NOT EXISTS (SELECT 1 FROM <table> WHERE <key column> = ? AND ...)
 * A repeat of the same row is a quiet no-op (0 changes), so a retried batch succeeds; a row that collides on another unique key still aborts
 * with the table's name (a real conflict, never silently dropped). `key` is the idempotency key: a list of columns of `row` (for example
 * ["cluster", "program_id", "city_id"] for a launch record, ["dedup_key"] for an activity event). Never write a kept table with INSERT OR
 * IGNORE, INSERT OR REPLACE or an ON CONFLICT clause: its overwrite guard aborts them, and inside a D1 batch the abort rolls everything back.
 */
export function keptInsert(table, row, key) {
  if (typeof table !== "string" || !IDENT.test(table)) throw new TypeError("keptInsert: a table name");
  const cols = row !== null && typeof row === "object" ? Object.keys(row) : [];
  if (!cols.length || !cols.every((c) => IDENT.test(c))) throw new TypeError("keptInsert: a row of plain column names");
  if (cols.some((c) => row[c] === undefined)) throw new TypeError("keptInsert: every column has a value (null for none)");
  if (!Array.isArray(key) || !key.length || !key.every((c) => cols.includes(c))) throw new TypeError("keptInsert: the key is a list of the row's columns");
  return {
    sql: `INSERT INTO ${table} (${cols.join(", ")}) SELECT ${cols.map(() => "?").join(", ")} WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${key.map((c) => `${c} = ?`).join(" AND ")})`,
    params: [...cols.map((c) => row[c]), ...key.map((c) => row[c])],
  };
}

/* ------------------------------------------------------------------ the runner */

/** The error a feature route turns into 503 not_enabled for that feature only (see the top of this file). */
export class Cc5SchemaError extends Error {
  constructor({ group, failed = group, reason, inner = null, step = null, cause = undefined }) {
    super(`cc5 schema ${group} unavailable: ${reason}${failed !== group ? ` (${failed}${inner ? `: ${inner}` : ""})` : ""}${step !== null ? ` at step ${step}` : ""}`);
    this.name = "Cc5SchemaError";
    this.group = group;
    this.failed = failed;
    this.reason = reason;
    this.inner = inner;
    this.step = step;
    this.status = 503;
    this.code = "not_enabled";
    if (cause !== undefined) this.cause = cause;
  }
}

const isDuplicateColumn = (e) => /duplicate column/i.test(String((e && e.message) || e));
const short = (e) => String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 120);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isDb = (x) => Boolean(x) && typeof x.prepare === "function";
const TIMED_OUT = Symbol("cc5 timeout");

/**
 * A runner over a registry. ensureCc5Group below is the one over CC5_GROUPS with the v5 gate; the backup rehearsal and the tests build
 * others. Options: groups, order, reserved, prepareSchema (makes schema_migrations exist; default src/store.js ensureSchema), log (one line
 * per failure; never a value from a row), gate ((env, id) -> null or a refusal reason; when set, the target must be an env with DB, never a
 * bare database), timeoutMs (one call's limit; CC5_TIMEOUT_MS).
 */
export function cc5Runner({ groups = CC5_GROUPS, order = CC5_ORDER, reserved = CC5_RESERVED, prepareSchema = ensureSchema, log = console.error,
  gate = null, timeoutMs = CC5_TIMEOUT_MS } = {}) {
  const ready = new WeakMap(); // db -> Set(group ids in place): settled successes only (a failure or a stalled call is never cached)
  let problems = null;

  async function step(db, s) {
    if (typeof s === "string") { await db.prepare(s).run(); return; }
    const cols = (await db.prepare(`PRAGMA table_info(${s.table})`).all()).results.map((r) => r.name);
    if (cols.includes(s.column)) return;
    try { await db.prepare(s.sql).run(); }
    catch (e) { if (!isDuplicateColumn(e)) throw e; }
  }

  async function apply(db, id) {
    let have = ready.get(db);
    if (!have) ready.set(db, (have = new Set()));
    if (have.has(id)) return;
    const g = groups[id];
    for (const r of [...g.requires].sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
      try { await apply(db, r); }
      catch (e) { throw e instanceof Cc5SchemaError ? e : new Cc5SchemaError({ group: r, reason: "statement_failed", cause: e }); }
    }
    let done;
    try { done = await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(id).first(); }
    catch (e) { throw new Cc5SchemaError({ group: id, reason: "record_read_failed", cause: e }); }
    if (!done) {
      if (typeof g.prepare === "function") {
        try { await g.prepare(db); }
        catch (e) { throw new Cc5SchemaError({ group: id, reason: "statement_failed", step: -1, cause: e }); }
      }
      for (let i = 0; i < g.statements.length; i++) {
        try { await step(db, g.statements[i]); }
        catch (e) { throw new Cc5SchemaError({ group: id, reason: "statement_failed", step: i, cause: e }); }
      }
      try {
        await db.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(id, new Date().toISOString()).run();
      } catch (e) { throw new Cc5SchemaError({ group: id, reason: "record_failed", cause: e }); }
    }
    have.add(id);
  }

  return async function ensure(target, id) {
    const known = typeof id === "string" && (hasOwn(groups, id) || hasOwn(reserved, id));
    const label = known ? id : JSON.stringify(String(id).slice(0, 40)); // an id outside the registry is never logged as given
    const fail = (reason, extra = {}) => {
      const e = new Cc5SchemaError({ group: label, reason, ...extra });
      const line = ["cc5 schema unavailable", e.group, e.failed, e.reason];
      if (e.step !== null) line.push(`step ${e.step}`);
      if (e.inner) line.push(`inner ${e.inner}`);
      if (extra.cause !== undefined) line.push(short(extra.cause));
      try { log(...line); } catch { /* a log line is never worth a failed call */ }
      return e;
    };
    if (problems === null) problems = registryProblems(groups, order, reserved);
    if (problems.length) throw fail("registry_invalid");
    if (!known || !hasOwn(groups, id)) throw fail(known ? "group_not_built" : "unknown_group");
    if (gate) {
      if (!target || typeof target !== "object" || isDb(target)) throw fail("env_required");
      const why = gate(target, id);
      if (why) throw fail(String(why));
    }
    const db = isDb(target) ? target : target && isDb(target.DB) ? target.DB : null;
    if (!db) throw fail("no_database");

    let timer = null;
    const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); });
    const within = (p) => { p.catch(() => {}); return Promise.race([p, limit]); }; // a late rejection of a stalled call is never unhandled
    try {
      let r;
      try { r = await within(Promise.resolve().then(() => prepareSchema(db))); } // schema_migrations exists (it does in production)
      catch (e) { throw fail("prepare_failed", { cause: e }); }
      if (r === TIMED_OUT) throw fail("timeout");
      try { r = await within(apply(db, id)); }
      catch (e) {
        if (e instanceof Cc5SchemaError) {
          throw fail(e.group === id ? e.reason : "prerequisite_failed", {
            failed: e.failed, inner: e.group === id ? null : e.reason, step: e.step, cause: e.cause !== undefined ? e.cause : e,
          });
        }
        throw fail("statement_failed", { cause: e });
      }
      if (r === TIMED_OUT) throw fail("timeout");
      return closure(groups, order, id);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** `id` and its prerequisites, in order. */
function closure(groups, order, id) {
  const seen = new Set();
  const add = (x) => { if (seen.has(x) || !groups[x]) return; seen.add(x); for (const r of groups[x].requires) add(r); };
  add(id);
  return Object.freeze(order.filter((x) => seen.has(x)));
}

const workerRunner = cc5Runner({ gate: cc5GateRefusal });

/** The Worker's entry: create group `id` (and its prerequisites) on env.DB, only while env's own settings need it; see the top of this file. */
export function ensureCc5Group(env, id) {
  return workerRunner(env, id);
}
