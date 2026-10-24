/**
 * Citycoin.dev master v5, stage S08: the additive D1 schema groups of docs/citycoin-master/schema-and-api.md section 3 and the runner that
 * creates them lazily (docs/citycoin-master/schema-migrations.md is the stage record: every reading of the design made here is listed there
 * with its doc line).
 *
 * NOTHING HERE RUNS TODAY. No route, job or src/index.js path imports this module (test/cc5-schema.test.js keeps it that way until the feature
 * stage that needs a group adds its own call), so with every switch at its default the Worker issues exactly the D1 statements it issues
 * today and the built pages are unchanged. A feature stage calls ensureCc5Group(env, id) only while its switch counts (the fail-closed gate
 * of src/v5policy.js: the switch is set, the v5 configuration check accepts the deployment and its inputs are valid), and answers
 * 503 not_enabled for that feature alone when the call rejects.
 *
 *   CC5_ORDER          the order of section 3.10 step 2: cc5-identity (reserved for stage S09, not built here), then cc5-ops (before the
 *                      first job that takes a lease: the selection job), cc5-selection, cc5-activity, cc5-managers, cc5-metadata, cc5-launch,
 *                      cc5-hourly.
 *   CC5_GROUPS         id -> { id, section, switches, requires, statements }. `switches` names the switch values that need the group (each
 *                      one a value other than the switch's default); `requires` the groups that must exist first; `statements` the
 *                      statement list, one statement per entry (never split SQL text: triggers hold semicolons inside BEGIN ... END).
 *                      An entry is SQL text (CREATE ... IF NOT EXISTS) or { table, column, sql } for an ALTER TABLE ... ADD COLUMN, which
 *                      runs only when PRAGMA table_info shows the column missing ("duplicate column" from a racing isolate is ignored).
 *                      No group of this stage alters an existing table; the form exists for cc5-identity.
 *   groupsForFlags(f)  the groups the switches in `f` need, prerequisites included, in CC5_ORDER (pure; `f` maps switch names to values,
 *                      as the gate applies them; a value outside a group's list, including any malformed value, needs nothing).
 *   ensureCc5Group(envOrDb, id)  create the group `id` and its prerequisites (each statement its own step), then record `id` in the existing
 *                      schema_migrations table, only after every statement succeeded. Safe to repeat and to run from two isolates at once
 *                      (every statement is IF NOT EXISTS or column-guarded; the record is INSERT OR IGNORE). Success is cached per isolate;
 *                      a failure is forgotten, so the next call retries. Resolves to the ids now in place (the group and its prerequisites,
 *                      in CC5_ORDER); rejects with a Cc5SchemaError.
 *   Cc5SchemaError     name "Cc5SchemaError", status 503, code "not_enabled"; `group` is the id asked for, `failed` the group whose step
 *                      failed (the same, or a prerequisite), `reason` one of unknown_group, group_not_built, no_database, registry_invalid,
 *                      statement_failed, record_failed, prerequisite_failed; `step` the index of the failed statement.
 *
 * Append-only and immutable tables (doc rule 6, and each "append-only" or "immutable" mark in section 3) reject UPDATE and DELETE with BEFORE
 * triggers that RAISE(ABORT, '<name>'), AND reject an INSERT that would collide with a kept row on any unique key (`<table>_no_overwrite`):
 * INSERT OR REPLACE and UPDATE OR REPLACE delete the old row WITHOUT firing its DELETE triggers (D1 runs with recursive_triggers off), so
 * without that guard REPLACE could rewrite history. A BEFORE INSERT trigger fires before conflict resolution, so the guard also turns
 * INSERT OR IGNORE, ON CONFLICT DO NOTHING and ON CONFLICT DO UPDATE on a kept row into the same named error: writers of these tables use a
 * plain INSERT, or the guarded INSERT ... SELECT ... WHERE NOT EXISTS (...) of doc rule 4, never a conflict clause. Where a row becomes
 * kept only in a state (a founded city, a launched city's metadata, a confirmed hourly action), `<table>_..._no_takeover` also stops an
 * UPDATE OR REPLACE of another row from deleting it by moving onto its key.
 */
import { ensureSchema } from "./store.js";

/** Groups named in CC5_ORDER whose statements belong to another stage: stage S09 (local branch cc/s09) adds cc5-identity, first. */
export const CC5_RESERVED = Object.freeze({
  "cc5-identity": "schema-and-api.md section 3.1, stage S09: runs first, after ONBOARD_MIGRATION (src/store.js); not built in stage S08",
});

/** Section 3.10 step 2. cc5-ops sits before the first job that takes a lease (the selection job, under the 'selection' lease). */
export const CC5_ORDER = Object.freeze([
  "cc5-identity", "cc5-ops", "cc5-selection", "cc5-activity", "cc5-managers", "cc5-metadata", "cc5-launch", "cc5-hourly",
]);

/* ------------------------------------------------------------------ trigger builders */

const abort = (message) => `BEGIN SELECT RAISE(ABORT, '${message}'); END`;

/**
 * The SQL that is true for an existing row of the table (columns unqualified, inside SELECT ... FROM <table>) when the new row (NEW.*)
 * would collide with it on one of `keys`: the rowid always, then each key, which is a column, a list of columns, or
 * { cols, where, newWhere } for a partial unique index (a collision needs both rows inside the index).
 */
function collides(keys) {
  const parts = ["rowid = NEW.rowid"];
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
  `CREATE TRIGGER IF NOT EXISTS ${name} BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${keptAnd(kept)}(${collides(keys)})) ${abort(message)}`;

/** BEFORE UPDATE: no update of another row may move onto a kept row's key (UPDATE OR REPLACE would delete the kept row). */
const noTakeover = (name, table, message, keys, kept = null) =>
  `CREATE TRIGGER IF NOT EXISTS ${name} BEFORE UPDATE ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE rowid <> OLD.rowid AND ${keptAnd(kept)}(${collides(keys)})) ${abort(message)}`;

const changed = (cols) => cols.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ");

/** No UPDATE, no DELETE, no overwrite: the three triggers of an append-only (or immutable) table. */
const appendOnly = (table, message, keys) => [
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} ${abort(message)}`,
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} ${abort(message)}`,
  noOverwrite(`${table}_no_overwrite`, table, message, keys),
];

/** A keyed record that is never deleted or replaced and whose key columns never change (the hourly records). */
const keptRecord = (table, message, keys, fixed) => [
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} ${abort(message)}`,
  noOverwrite(`${table}_no_overwrite`, table, message, keys),
  `CREATE TRIGGER IF NOT EXISTS ${table}_keys_fixed BEFORE UPDATE ON ${table} WHEN ${changed(["rowid", ...fixed])} ${abort(message)}`,
];

/* ------------------------------------------------------------------ 3.8 job leases and idempotency keys: cc5-ops */

const OPS = [
  `CREATE TABLE IF NOT EXISTS job_leases (
  name        TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  fencing     INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
)`,
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
  `CREATE TABLE IF NOT EXISTS selection_cities (
  city_id       TEXT PRIMARY KEY,
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
  // never deleted, so never replaced either (reading R4)
  noOverwrite("selection_receipts_no_overwrite", "selection_receipts", "receipt_immutable", ["cycle_id", "digest"]),
  noTakeover("selection_receipts_no_takeover", "selection_receipts", "receipt_immutable", ["cycle_id", "digest"]),

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

  `CREATE TABLE IF NOT EXISTS founder_records (
  city_id        TEXT PRIMARY KEY,
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
  ...appendOnly("manager_application_events", "manager_application_event_append_only", ["id"]),

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
  // the doc: no DELETE; UPDATE only sets ended_at, ended_by and end_reason, once (reading R6: the one update is the one that ends)
  `CREATE TRIGGER IF NOT EXISTS country_managers_no_delete BEFORE DELETE ON country_managers ${abort("country_manager_append_only")}`,
  `CREATE TRIGGER IF NOT EXISTS country_managers_end_once BEFORE UPDATE ON country_managers WHEN OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL OR ${changed(["id", "country", "user_id", "wallet", "application_id", "appointed_by", "appointed_at"])} ${abort("country_manager_append_only")}`,
  noOverwrite("country_managers_no_overwrite", "country_managers", "country_manager_append_only",
    ["id", "application_id", { cols: ["country"], where: "ended_at IS NULL", newWhere: "NEW.ended_at IS NULL" }]),
];

/* ------------------------------------------------------------------ 3.4 activity ledger: cc5-activity */

const ACTIVITY = [
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
  ...appendOnly("activity_events", "activity_event_append_only", ["id", "dedup_key", "reverses_id"]),

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

  // a derived cache, rebuilt at any time from activity_events: no trigger
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
  ...appendOnly("city_metadata_versions", "metadata_version_append_only", ["id", ["city_id", "version"], ["city_id", "content_hash"]]),

  `CREATE TABLE IF NOT EXISTS city_metadata_active (
  city_id       TEXT PRIMARY KEY,
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
  ...appendOnly("city_metadata_request_events", "metadata_request_event_append_only", ["id"]),

  // a mirror of the on-chain ReviewLock (the chain is authoritative); the approval batch deletes its row: no trigger
  `CREATE TABLE IF NOT EXISTS city_review_locks (
  city_id       TEXT PRIMARY KEY,
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

  `CREATE TABLE IF NOT EXISTS launch_preparations (
  id              TEXT PRIMARY KEY,
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
const ACTION_KEY = ["action_key", "cluster", "program_id", "coin", "quote_mint", "utc_hour", "action", "batch"];
const LEAF_KEY = ["cluster", "program_id", "coin", "quote_mint", "utc_hour", "leaf_index"];
const HOURLY = [
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

  `CREATE TABLE IF NOT EXISTS hourly_actions (
  action_key      TEXT PRIMARY KEY,
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
  ...keptRecord("hourly_actions", "hourly_action_permanent", ["action_key"], ACTION_KEY),
  // confirmed only after the chain shows the effect: final
  `CREATE TRIGGER IF NOT EXISTS hourly_actions_confirmed_final BEFORE UPDATE ON hourly_actions WHEN OLD.status = 'confirmed' ${abort("hourly_action_permanent")}`,

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
  // owed until paid or claimed: never deleted (no expiry, no sweep), never redirected (wallet and amount fixed), paid or claimed is final
  ...keptRecord("hourly_leaves", "hourly_leaf_permanent", [LEAF_KEY], [...LEAF_KEY, "wallet", "amount_raw"]),
  `CREATE TRIGGER IF NOT EXISTS hourly_leaves_paid_final BEFORE UPDATE ON hourly_leaves WHEN OLD.status IN ('paid','claimed') ${abort("hourly_leaf_permanent")}`,
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
  // 3.7: "created when CC_HOURLY first leaves off"; the hourly and keeper jobs run under leases (cc5-ops)
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

/* ------------------------------------------------------------------ the runner */

/** The error a feature route turns into 503 not_enabled for that feature only (see the top of this file). */
export class Cc5SchemaError extends Error {
  constructor({ group, failed = group, reason, step = null, cause = undefined }) {
    super(`cc5 schema ${group} unavailable: ${reason}${failed !== group ? ` (${failed})` : ""}${step !== null ? ` at step ${step}` : ""}`);
    this.name = "Cc5SchemaError";
    this.group = group;
    this.failed = failed;
    this.reason = reason;
    this.step = step;
    this.status = 503;
    this.code = "not_enabled";
    if (cause !== undefined) this.cause = cause;
  }
}

const isDuplicateColumn = (e) => /duplicate column/i.test(String((e && e.message) || e));
const short = (e) => String((e && e.message) || e).slice(0, 120);

/**
 * A runner over a registry. ensureCc5Group below is the one over CC5_GROUPS; tests build others (a group with an ALTER, a failing
 * statement). Options: groups, order, reserved, prepareSchema (makes schema_migrations exist; default src/store.js ensureSchema),
 * log (one line per failure; never a value from a row).
 */
export function cc5Runner({ groups = CC5_GROUPS, order = CC5_ORDER, reserved = CC5_RESERVED, prepareSchema = ensureSchema, log = console.error } = {}) {
  const ready = new WeakMap(); // db -> Map(group id -> Promise), success only (a failure is forgotten)
  let problems = null;

  async function step(db, s) {
    if (typeof s === "string") { await db.prepare(s).run(); return; }
    const cols = (await db.prepare(`PRAGMA table_info(${s.table})`).all()).results.map((r) => r.name);
    if (cols.includes(s.column)) return;
    try { await db.prepare(s.sql).run(); }
    catch (e) { if (!isDuplicateColumn(e)) throw e; }
  }

  async function apply(db, id) {
    const g = groups[id];
    for (const r of [...g.requires].sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
      try { await one(db, r); }
      catch (e) { throw e instanceof Cc5SchemaError ? e : new Cc5SchemaError({ group: r, reason: "statement_failed", cause: e }); }
    }
    const done = await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(id).first();
    if (done) return;
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

  function one(db, id) {
    let map = ready.get(db);
    if (!map) ready.set(db, (map = new Map()));
    if (!map.has(id)) map.set(id, apply(db, id).catch((e) => { map.delete(id); throw e; }));
    return map.get(id);
  }

  return async function ensure(target, id) {
    const db = target && typeof target.prepare === "function" ? target : target && target.DB && typeof target.DB.prepare === "function" ? target.DB : null;
    const fail = (reason, extra = {}) => {
      const e = new Cc5SchemaError({ group: String(id), reason, ...extra });
      log("cc5 schema unavailable", e.group, e.failed, e.reason, e.step === null ? "" : `step ${e.step}`, extra.cause ? short(extra.cause) : "");
      return e;
    };
    if (problems === null) problems = registryProblems(groups, order, reserved);
    if (problems.length) throw fail("registry_invalid");
    if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(groups, id)) {
      throw fail(typeof id === "string" && Object.prototype.hasOwnProperty.call(reserved, id) ? "group_not_built" : "unknown_group");
    }
    if (!db) throw fail("no_database");
    try {
      await prepareSchema(db); // schema_migrations exists (it does in production; a fresh database gets the normal schema first)
    } catch (e) { throw fail("record_failed", { cause: e }); }
    try {
      await one(db, id);
    } catch (e) {
      if (e instanceof Cc5SchemaError) {
        throw fail(e.group === id ? e.reason : "prerequisite_failed", { failed: e.failed, step: e.step, cause: e.cause !== undefined ? e.cause : e });
      }
      throw fail("statement_failed", { cause: e });
    }
    return closure(groups, order, id);
  };
}

/** `id` and its prerequisites, in order. */
function closure(groups, order, id) {
  const seen = new Set();
  const add = (x) => { if (seen.has(x) || !groups[x]) return; seen.add(x); for (const r of groups[x].requires) add(r); };
  add(id);
  return Object.freeze(order.filter((x) => seen.has(x)));
}

const defaultRunner = cc5Runner();

/** Create group `id` (and its prerequisites) on env.DB or on the database given; see the top of this file. */
export function ensureCc5Group(envOrDb, id) {
  return defaultRunner(envOrDb, id);
}
