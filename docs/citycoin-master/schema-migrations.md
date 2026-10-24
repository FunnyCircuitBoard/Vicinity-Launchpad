# Citycoin.dev v5: schema migrations (stage S08)

Master change order v5, sections 07 (BR-05), 16, 17 (WP-01), 20 to 32 and 37. Design: `schema-and-api.md` section 3 (sections 3.2 to 3.10)
and section 5. Plan: `implementation-report.md` stage S08 and rows A14, B14 and D08. This file is the stage record; the implementation
report is updated by the release step.

**Status on 24 October 2026: nothing here is applied or called.** Local branch `cc/s08` only (not pushed, not merged, not deployed). No
route, job or `src/index.js` path imports the new module, so the Worker issues exactly the D1 statements it issues today, whatever the
switches say (shown statement by statement in section 5), and the built `public/` does not change. No production or remote database was
read or written for this work: the census and the backup tools (section 8) ran only against Cloudflare's local D1 with synthetic rows,
and every `--remote` case of their tests runs in-process with a wrangler stand-in that never starts wrangler. Live facts at the time: 5
members, 0 seats, 0 open windows, no city coin listed. A review of the stage was answered the same day (section 10): its fixes are in
this record.

## 1. What S08 built

| File | What it is |
|---|---|
| `src/cc5schema.js` | The seven statement lists of `schema-and-api.md` sections 3.2 to 3.8 (`cc5-ops`, `cc5-selection`, `cc5-activity`, `cc5-managers`, `cc5-metadata`, `cc5-launch`, `cc5-hourly`), the order of section 3.10 step 2 with a reserved first slot for `cc5-identity`, the pure helper `groupsForFlags(flags)`, the Worker's entry `ensureCc5Group(env, id)` with its fail-closed gate `cc5GateRefusal(env, id)`, the ungated runner `cc5Runner(opts)` (backup rehearsal and tests), the writer helper `keptInsert(table, row, key)`, and the named error `Cc5SchemaError` |
| `test/cc5-schema.test.js` | 35 tests on Node's SQLite (the engine D1 runs): the doc parity, the switch mapping, the gate, the runner (failures, timeouts, races, caching), every append-only and conditional trigger, the rowid and NULL-key rules, the writer helper, the CHECK constraints and partial indexes, and the guard that nothing in the Worker or the pages calls the runner yet |
| `test/cc5-d1copy.test.js` | 14 tests, each run twice: on Cloudflare's local D1 inside workerd (Miniflare) and on Node's SQLite, against a copy of the production database's shape with synthetic rows (section 5) |
| `test/cc5-parity.test.js` | 3 tests: the switches-off parity claim, by running the Worker's real request and job entry points against a fake D1 that records every statement (section 5) |
| `test/helpers/cc5-d1copy.js` | The copy: the schema read, synthetic rows in every one of its 55 tables, the two engines (the Miniflare one loads the executor with its whole static import graph, and can persist to a `<dir>/.wrangler/state/v3` outside the repository, so `wrangler d1 execute --local --config <dir>/wrangler.json` reads the same database), and a reader of section 3 as data (tables, columns, CHECKs, keys, indexes) |
| `test/helpers/cc5-d1copy-worker.js` | The executor the D1-copy tests drive: inside workerd it is the Worker (so `src/cc5schema.js` runs in the Workers runtime against local D1); in Node it runs in-process |
| `test/fixtures/prod-schema-2026-10-24.sql` | The production D1 schema as read on 24 October 2026: `sqlite_master` text of 88 objects, **schema only, no rows** |
| `scripts/citycoin/census.mjs` | The count-only census (section 3.10 steps 1 and 3, R1 section 9, §07 acceptance): counts, table names, schema object names and sha256 (or keyed HMAC-SHA256) digests, never a row value; every statement checked to be one SELECT; read through `wrangler d1 execute --json`, local by default; `--compare` for before and after (section 8) |
| `scripts/citycoin/backup.mjs` | The backup step before each migration: Time Travel bookmark, optional export outside the repository (wrangler's output captured, never printed), restore into a new local copy validated by the census (schema exact, data digests, row counts), rehearsal of the groups on that copy, restore commands; dry run by default (section 8) |
| `scripts/citycoin/lib.mjs` | What the two share: the wrangler environment (no debug log, no metrics, log level forced to `log`), the captured wrangler runner, the outside-the-repository path rule, the digest key rule, the argument parser |
| `test/cc5-census.test.js` | 20 tests: the one-SELECT rule, the column lists against the schema read, the path and key rules, the census on Node's SQLite and through `wrangler d1 execute --local` on Cloudflare's local D1, privacy scans, a migration's before and after, the schema digest against a lossy restore, the churn allowance, keyed digests, refusals, a remote backup run against a wrangler stand-in, the failure paths, and the backup step end to end on a local copy (section 8.4) |

Nothing in `src/`, `public/` or the page build imports `scripts/citycoin/`; the Worker and the built pages are unchanged by it.

## 2. The groups

Each group is created only when its switch first leaves its default, and only by a feature stage that calls `ensureCc5Group(env, id)`;
that call itself refuses (`switch_at_default`, `config_refused`) unless env's own switches need the group and the v5 configuration check
accepts the deployment (section 3). Until a feature stage adds that call, no group is ever created.

| Id | Design | Created when | Prerequisites | Tables | Kept rows (triggers) |
|---|---|---|---|---|---|
| `cc5-ops` | 3.8 | the first of `SELECTION_V5` shadow or on, `CC_HOURLY` shadow or on, `LAUNCH_V5` on | none | `job_leases`, `idempotency_keys` | a lease row (never deleted; fencing never goes back) |
| `cc5-selection` | 3.2 | `SELECTION_V5` shadow or on | `cc5-ops` (cycles are claimed under the `selection` lease, 3.2 rule "Order") | `selection_cities`, `selection_cycles`, `selection_snapshots`, `selection_receipts`, `national_ranks`, `founder_records` (the FounderRecord mirror) | founded cities; receipts; founder records |
| `cc5-activity` | 3.4 | `ACTIVITY_POINTS` shadow or on | none | `activity_events`, `activity_evidence`, `activity_totals` | activity events |
| `cc5-managers` | 3.3 | `MANAGER_APPS` on | `cc5-selection`, `cc5-activity` | `manager_applications`, `manager_application_events`, `country_managers` | application events; managers |
| `cc5-metadata` | 3.5 | `METADATA_V5` on | none | `city_metadata_versions`, `city_metadata_active`, `city_metadata_uploads`, `city_metadata_requests`, `city_metadata_request_events`, `city_review_locks` | versions; a launched city's active row; request events |
| `cc5-launch` | 3.6 | `LAUNCH_V5` on | `cc5-ops`, `cc5-metadata` | `city_launches`, `launch_preparations` | launch records |
| `cc5-hourly` | 3.7 | `CC_HOURLY` shadow or on | `cc5-ops` | `hourly_runs`, `hourly_samples`, `hourly_actions`, `hourly_leaves` | runs, samples and actions (no delete, no overwrite, fixed keys); a confirmed action; a leaf once its hour's root is on chain or once it is paid or claimed (R9) |

Every table, column, type, CHECK, UNIQUE, key and index is the doc's word for word; the test reads `schema-and-api.md` and compares
each statement (sections 3.2 to 3.8), so a later edit of either side fails it. Three things in the doc were amended by this stage while
nothing is recorded anywhere (R25): `NOT NULL` on the seven text primary keys, the unique index `hourly_actions_once`, and the kept-table
writer rule of doc rule 4. In all: 26 tables, 16 named indexes and 64 triggers (106 statements), no `ALTER` of an existing table, no view
and no foreign key.

**Why each prerequisite never creates a group whose own switch is at its default.** A prerequisite is listed only where the v5
configuration check already refuses the dependant switch without the prerequisite's switch: `MANAGER_APPS=on` needs `SELECTION_V5=on` and
`ACTIVITY_POINTS=on` (`MANAGER_APPS_WITHOUT_SELECTION`, `MANAGER_APPS_WITHOUT_POINTS`), and `LAUNCH_V5=on` needs `METADATA_V5=on`
(`LAUNCH_V5_WITHOUT_METADATA_V5`). `cc5-ops` has no switch of its own; section 3.8 names the three switches that create it, and those are
exactly the three groups that list it. A test walks every combination of the six switches and asserts it for each combination the check
does not refuse as incompatible.

**Order (section 3.10 step 2).** `CC5_ORDER` is `cc5-identity`, `cc5-ops`, `cc5-selection`, `cc5-activity`, `cc5-managers`,
`cc5-metadata`, `cc5-launch`, `cc5-hourly`. `cc5-ops` sits before `cc5-selection` because the selection job is the first job that takes a
lease. Only prerequisites are ordered at run time: doc rule 2 (each group when its own switch first leaves its default) overrides the
step 2 sequence, so `CC_HOURLY=shadow` before `SELECTION_V5` creates `cc5-ops` and `cc5-hourly` with no `cc5-selection`, and
`cc5-selection` can exist before `cc5-identity` (R22; what hourly reads from other groups is open item O16).

**`cc5-identity` (stage S09, local branch `cc/s09`, not built here).** It is a reserved id: `ensureCc5Group(env, "cc5-identity")` rejects
with `group_not_built`, and no statement here creates or alters an identity table or column (`auth_challenges`, `city_assignments`, the
`users` and `sessions` columns of section 3.1). To add it, S09 adds one entry to `CC5_GROUPS` and removes it from `CC5_RESERVED`:
`switches: { WALLET_ONLY: ["on"] }`, a `prepare(db)` step that runs `ensureOnboardSchema` first (section 3.1: "It runs only after
`ONBOARD_MIGRATION` has run"), and its statements, with each `ALTER TABLE ... ADD COLUMN` written as `{ table, column, sql }`, which the
runner issues only when `PRAGMA table_info` shows the column missing and which tolerates a racing isolate's "duplicate column". Both forms
are tested here with a test registry. Section 9 records the backfill rule that stage must apply.

## 3. The runner contract (for the feature stages, S17 and later)

```js
import { ensureCc5Group, Cc5SchemaError } from "./cc5schema.js";
// behind the feature's own gate in src/v5policy.js, before the first read or write of the group's tables:
try { await ensureCc5Group(env, "cc5-selection"); }
catch (e) { if (e instanceof Cc5SchemaError) return json({ ok: false, error: e.code }, e.status); throw e; } // 503 not_enabled, this feature only
```

- **Fails closed (the gate).** `ensureCc5Group` takes the Worker's `env`, never a bare database (`env_required`). It refuses with
  `switch_at_default` unless a switch that needs the group has left its default (`groupsForFlags` over `deploymentFromEnv(env).flags`, the
  switches as `src/v5policy.js` reads them), and with `config_refused` unless the v5 configuration check accepts the deployment
  (`policyConfig(env).ok`). With the committed `wrangler.jsonc` every group is refused before any statement (tested on both engines). Today
  no switch can count anyway: each switch that needs one of the program, cluster, archive or main-token inputs is refused until the stage
  that builds it adds the setting. `cc5Runner(opts)` is the same runner without the gate, for the backup rehearsal on a restored local
  copy and for the tests; the Worker never calls it.
- **One step per statement.** Each statement runs on its own; the group's id is recorded in the existing `schema_migrations` table
  (`INSERT OR IGNORE`) only after every statement succeeded. A failure leaves no record, so the next call runs the whole list again;
  every statement is `CREATE ... IF NOT EXISTS` (or a column-guarded `ALTER`), so the statements that already ran are harmless.
- **Prerequisites first.** `ensureCc5Group(env, "cc5-managers")` ensures `cc5-ops`, `cc5-selection` and `cc5-activity` first, in order.
  It resolves to the ids now in place, in order.
- **Two isolates at once.** Both run the same idempotent statements and the record is `INSERT OR IGNORE`: one record per group (tested on
  Node's SQLite and on a local D1).
- **Cached per isolate, successes only.** A group in place is remembered per database object; a second call issues no statement. A
  failure, and a call still pending, are never cached: two calls in one isolate before the first success may both run the (idempotent)
  statements.
- **Time limit.** One call may take 10 seconds (`CC5_TIMEOUT_MS`; a D1 binding call has no timeout of its own). After that it rejects
  with `timeout`; the stalled work is not cached, so the next call starts again, and a late finish is harmless (IF NOT EXISTS, INSERT OR
  IGNORE). A stalled prerequisite does not hold back the next call either.
- **The error.** `Cc5SchemaError`: `name` "Cc5SchemaError", `status` 503, `code` "not_enabled", `group` (the id asked for; an id outside
  the registry is shown quoted, escaped and cut to 40 characters), `failed` (the group whose step failed: the same one or a prerequisite),
  `reason`, `inner` (for `prerequisite_failed`, the prerequisite's own reason), `step` (the statement index; -1 for a `prepare` step),
  `cause`. The reasons: `unknown_group`, `group_not_built` (cc5-identity), `env_required`, `switch_at_default`, `config_refused`,
  `no_database`, `registry_invalid`, `prepare_failed` (today's `ensureSchema`, which makes `schema_migrations` exist, failed: usually D1
  itself), `record_read_failed` (reading the group's record failed), `statement_failed`, `record_failed` (the record insert failed),
  `prerequisite_failed`, `timeout`. One log line per failure: `cc5 schema unavailable <group> <failed> <reason> [step <n>] [inner
  <reason>] [<D1 message, 120 characters>]`; never a row value.
- **`groupsForFlags(flags)`** maps switch values (as the gate applies them; trimmed, any letter case) to the groups they need,
  prerequisites included, in `CC5_ORDER`. A value outside a group's list, including a malformed one, needs nothing. With the switches of
  the committed `wrangler.jsonc` it answers an empty list (tested). The census and backup step (section 8) use it to name the groups a
  switch change will create.
- **What the first request costs** (finding F4; counted on Node's SQLite with today's `ensureSchema` already cached, and the same on the
  local D1 within a statement): creating a group from nothing issues its statements plus one record read and one record insert per group in
  its closure. `cc5-ops` 7 D1 queries; `cc5-selection` 32 (with `cc5-ops`); `cc5-activity` 12; `cc5-managers` 60 when `cc5-ops`,
  `cc5-selection` and `cc5-activity` are not yet recorded, otherwise 19; `cc5-metadata` 23; `cc5-launch` 40 (with `cc5-ops` and
  `cc5-metadata`); `cc5-hourly` 34 (with `cc5-ops`). Once recorded, a new isolate pays one record read per group in the closure. A cold
  isolate also pays today's `ensureSchema`, which every route already runs. The largest statement is 1,086 bytes (D1's limit is 100 KB),
  with at most 2 bound parameters. The worst case (60) is above the Workers Free plan's 50 queries per invocation; **the design assumes
  Workers Paid (1,000)**, which production already needs (`SIGNUP_FLOW=v2` is live and its password hashing needs it). A job that creates
  groups on the cron's first run pays the same counts once. Running each create-only group as one D1 batch (one round trip, atomic) is
  possible later under the same ids, but is not done here: one step per statement is the pattern of the S04 migration (one failure never
  breaks more than it must).

**Writing to a kept table.** Every append-only or kept table has a BEFORE INSERT trigger (`<table>_no_overwrite`, `..._kept_no_overwrite`)
that aborts when the new row collides with a kept row on any unique key (section 4). It fires before SQLite resolves the conflict, so on a
kept row:

| Statement | Result |
|---|---|
| plain `INSERT` of a new row | appends |
| plain `INSERT` that collides | aborts with the table's name (instead of "UNIQUE constraint failed") |
| `INSERT ... SELECT ... WHERE NOT EXISTS (...)` (doc rule 4): **`keptInsert(table, row, key)`** in `src/cc5schema.js` | a quiet no-op on a duplicate (0 changes), also inside a batch: **the idempotent form to use**. A row that collides on another unique key still aborts (a real conflict is never silently dropped) |
| `INSERT OR REPLACE`, `REPLACE`, `INSERT OR IGNORE`, `ON CONFLICT DO NOTHING`, `ON CONFLICT DO UPDATE` | abort with the table's name |
| `UPDATE`, `UPDATE OR REPLACE`, `DELETE` | abort with the table's name (where the table forbids them) |

The local D1 reports these as `D1_ERROR: <name>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`, so a writer matches the name. Inside a
D1 batch the abort rolls the whole batch back (tested on both engines). A retried launch batch (the record, `launched_mint`, the
`launch:<city>` event) written with `keptInsert` succeeds twice with one row each (tested). The same rule now stands in
`schema-and-api.md` rule 4, rule 5 and section 5, where the feature stages read it, and beside each kept table in `src/cc5schema.js`.

**Writer rules the doc's SQL comments carry** (finding SF-11; the stored SQL keeps no comments, R1, so they are kept as JavaScript
comments beside each statement in `src/cc5schema.js` and listed here):

- `idempotency_keys.response_json` never holds a secret or a one-time code; routes that return one take no key (`/api/signup/handoff`);
  `expires_at` is 24 hours after `created_at` (open item O18 for the helper, the allowlist and the sweep).
- `job_leases`: `fencing` goes +1 on every acquisition, acquisition is only the doc's conditional upsert, and a lease row is never deleted
  or written with `INSERT OR REPLACE` (R23).
- `activity_events`: a reversal row carries 0 points and names what it reverses (`reverses_id`); `points` comes from the policy at write
  time; `activity_at` is the source activity's time.
- `selection_snapshots.blob_key` and `hourly_samples.blob_key`: readable by the verifier and the owner only;
  `city_metadata_uploads.storage_key` is private, never a public URL.
- `hourly_samples.taken_at` is written after the sample; planned times are never stored or published.
- `founder_records.wallet`: one founder seat per wallet in this release (one account, one fixed city).
- `selection_receipts.verifier_digest` is written only when it equals `digest` (open item O17).
- `hourly_leaves` and `hourly_actions` carry no `mode`: shadow runs never write them (open item O13).
- Never bind an id or rowid below 1: a kept table refuses it (R24).

## 4. Append-only and kept rows

Doc rule 6 (`schema-and-api.md` line 49) asks for triggers that reject UPDATE and DELETE. UPDATE and DELETE triggers alone do not hold:
`INSERT OR REPLACE` and `UPDATE OR REPLACE` delete the conflicting old row **without firing its DELETE triggers** unless
`recursive_triggers` is on, and D1 runs with it off (read on the local D1: `PRAGMA recursive_triggers` = 0; `foreign_keys` = 1). The test
shows the hole on a copy without the guard (REPLACE rewrites a founder record) and its closure with it. The design that holds on D1, used
for every kept row:

- `<table>_no_update` / `_no_delete`: BEFORE UPDATE / BEFORE DELETE, `RAISE(ABORT, '<name>')` (conditional where the row is kept only in
  a state);
- `<table>_no_overwrite`: BEFORE INSERT `WHEN EXISTS (SELECT 1 FROM <table> WHERE <kept> AND ((NEW.rowid > 0 AND rowid = NEW.rowid) OR
  <each unique key> = NEW.<key> ...))`, every primary key, UNIQUE column, UNIQUE constraint and unique index (a partial index with its
  condition on both rows), plus the rowid (an explicit rowid can replace a row too; an INTEGER PRIMARY KEY is the rowid, so the rowid term
  covers it). In a BEFORE INSERT trigger `NEW.rowid` is undefined unless the statement names the rowid: SQLite reads it as -1, exactly
  like an explicit -1, so the rowid is compared only when it is above 0 (finding SF-4);
- `<table>_rowid_positive`: AFTER INSERT `WHEN NEW.rowid < 1` (the only AFTER triggers): no kept table ever holds a rowid below 1, so
  skipping the undefined rowid misses nothing, and a row with id -1 can no longer wedge every later insert. SQLite gives an automatic
  rowid one above the largest, so a single row below 1 would make the next automatic rowid 0; therefore an update may not move a row
  below 1 either (every append-only and keyed table refuses rowid changes; the four tables kept only in a state refuse it in their
  takeover trigger). For receipts, whose `cycle_id` is the rowid, `selection_receipts_cycle_required` refuses a missing or non-positive
  cycle id before the insert (R24);
- `<table>_..._no_takeover`, where a row is kept only in a state and its keys may change: BEFORE UPDATE `WHEN NEW.rowid < 1 OR EXISTS` a
  different kept row on the new key (an `UPDATE OR REPLACE` that moves another row onto it would delete it).

The names the writers see: `founder_record_immutable`, `receipt_immutable`, `city_already_founded`, `manager_application_event_append_only`,
`country_manager_append_only`, `activity_event_append_only`, `metadata_version_append_only`, `metadata_frozen_after_launch`,
`metadata_request_event_append_only`, `launch_record_immutable`, `hourly_run_permanent`, `hourly_sample_permanent`,
`hourly_action_permanent`, `hourly_leaf_permanent`, `receipt_cycle_required`, `job_lease_fenced` (the first three and `metadata_frozen_after_launch` are the doc's own).

The doc's own trigger statements (`selection_cities_founded_terminal`, `selection_receipts_no_update`, `selection_receipts_no_delete`,
`founder_records_no_update`, `founder_records_no_delete`, `city_metadata_active_frozen_after_launch`) are created word for word.

**Hourly leaves** (findings SF-1, SF-3). A leaf is kept only once it is a confirmed funded allocation (master §31, `master-v5.txt` 1794):
it is paid or claimed, or its hour's root is on chain, which is a confirmed `holder_root` action for the same (cluster, program, coin,
quote, hour) or a live run of that hour in `root_published`, `paying` or `done`. A confirmed action is final and never deleted, so a later
run status cannot release the leaves. While kept: no delete, no overwrite, no takeover, and its keys, wallet and amount are fixed; paid or
claimed is final. Before that (a shadow run's leaf, or a live run's before its root, including one whose verification failed) a leaf can
be corrected, replaced or removed, so it never blocks the live leaf of the same hour.

**Job leases** (finding SF-9). `job_leases_no_delete` and `job_leases_fencing_forward` (no change of name or rowid, fencing never lower, a
new holder only with a higher fencing). Both pass the doc's acquisition upsert and a renewal by the holder. `INSERT OR REPLACE` cannot be
refused without refusing the doc's upsert as well (a BEFORE INSERT trigger sees both as inserts), so writers never use it (R23, O7).

**Not built: a runtime check of the guards** (finding SEC-3, optional part). On a recorded group the runner trusts the record and does not
look for its triggers. A check that re-creates or refuses on a missing trigger would collide with the retention release of open item O14
(a later group drops a trigger by design), so it belongs with the first such group (O20). A missing or changed guard is caught by the
census schema digest and the backup validation (section 8).

## 5. Evidence on D1

Run with `node --test test/cc5-d1copy.test.js test/cc5-parity.test.js` (part of `npm test`; about 9 seconds, nearly all of it workerd).

**The copy.** `test/fixtures/prod-schema-2026-10-24.sql` (the production schema read on 24 October 2026: 88 objects, no rows) is loaded
into a fresh database, then synthetic rows go into every one of its 55 tables (185 rows): 5 members (Google, e-mail and wallet sign-ins,
one without a wallet), sessions (live and expired), posts, a reply, votes, follows, mutes, blocks, two city coins without a mint, devnet
launchpad coins, price history, notices and feedback; seats, windows and elections only as closed history, so the live facts hold (no live
seat, no open window, no listed coin). Every wallet is base58 of `sha256("cc5-synthetic-...")`, every e-mail address is under
`example.invalid`, and no member data is copied anywhere. `schema_migrations` carries the migration ids the production shape implies (every
`MIGRATIONS` entry and the lazy migrations whose objects the read shows), so today's `ensureSchema` treats the copy like production.

**The engines.** Every test of `test/cc5-d1copy.test.js` runs twice. (1) **Cloudflare's local D1 inside workerd**, through Miniflare
5.20260921.0-alpha (installed with wrangler 4.137.0): the executor module is the Worker, loaded with its whole static import graph (now
including `src/v5policy.js` and what it reads), so the real `src/cc5schema.js` and `src/store.js` run inside the Workers runtime against
local D1 databases; temporary, never persisted, `cf: false` so Miniflare fetches nothing; no account, no remote binding. (2) **Node's
SQLite** (`test/helpers/d1.js`, with a batch that runs in one step like D1's). When workerd cannot start, the workerd half is reported as
skipped with the reason and the Node half still runs; on 24 October both ran here. Both engines report `PRAGMA recursive_triggers` = 0
and `foreign_keys` = 1.

**What the 14 tests show, on both engines** (28 passed, 0 skipped):

| Check | Result |
|---|---|
| The copy | 88 objects loaded; every table has rows |
| Order (3.10 step 2) | `cc5-identity` answers `group_not_built` and touches nothing; the seven groups apply in `CC5_ORDER`, each resolving to itself and its prerequisites; the 106 group statements run exactly once and in order; the seven records land in that order, after every statement of their group |
| Re-run | the same isolate issues no statement at all; a new isolate reads the records and issues no group statement and no write; the copy (every object, every table's hash, every record) is identical afterwards |
| Nothing existing changes | for each of the 56 existing tables (`sqlite_sequence` included): the same columns, row count and sha256 over its sorted rows (each row as SQLite's `quote()` of every column) before and after all seven groups; each of the 88 existing objects byte-identical; `schema_migrations` keeps its rows and gains exactly the seven ids; the only objects added are the 106 group objects and SQLite's automatic indexes of their keys |
| Schema matches the doc | read back from `sqlite_master` and `PRAGMA table_xinfo`, `index_list`, `index_xinfo`: identical to a database built straight from the doc's SQL (section 3, Node's SQLite, independent of `src/cc5schema.js`): 26 tables, every column, type, NOT NULL, default, key, CHECK and index (16 named); the doc's 6 triggers word for word; each of the other 58 triggers is a BEFORE trigger on its own table (or its AFTER INSERT rowid check) that only `RAISE(ABORT, ...)`s with a name section 4 lists |
| Append-only and kept tables | each of the 14 tables with an overwrite guard (the test asserts the list is complete), with a row in its kept state: UPDATE, DELETE, `INSERT OR REPLACE`, `REPLACE`, upsert (`ON CONFLICT DO UPDATE`), `INSERT OR IGNORE`, `ON CONFLICT DO NOTHING` and `UPDATE OR REPLACE` onto the kept key are refused with the table's name and every row stays byte-identical (112 attempts); the same statements succeed on `activity_totals`, which the doc keeps mutable |
| CHECK, NOT NULL, UNIQUE | read from the doc and walked: each of the 26 CHECK lists refuses a value outside it and accepts each of its 107 values; each of the 4 ranges refuses one past either end and accepts both ends; each of the 218 NOT NULL columns refuses NULL; each of the 46 keys and non-partial unique indexes refuses a second row (UNIQUE, or the table's guard name first); each of the 5 partial unique indexes refuses a second row inside it and accepts one outside |
| Primary keys and NULL | the seven text keys refuse NULL; a receipt without a cycle id is refused (`receipt_cycle_required`: on both engines `NEW.cycle_id` of a NULL key reads below 1 in a BEFORE INSERT trigger); `activity_totals.user_id` takes the next rowid (open item O9) |
| The writer rule | `keptInsert` twice is one row; `INSERT OR IGNORE` on the kept row aborts; an `activity_events` id of -1 or 0 is refused |
| The gate | with the committed `wrangler.jsonc` every group is refused (`switch_at_default`, 503) before any statement and the copy is unchanged; with `ACTIVITY_POINTS=shadow`, `DEPLOYMENT_ENV=test` and `LEGACY_SEATS=frozen` (an accepted deployment) `cc5-activity` is created and `cc5-ops` refused |
| Two runners at once | two requests, each racing every group from new isolates (21 runners), plus, on workerd, a runner in Node on the same local D1 (a second runtime): all succeed, each group recorded once, the same objects as one runner in order |
| Failure mid-group | an injected D1 error at `cc5-ops`' `idempotency_keys` table (through `cc5-hourly`): `prerequisite_failed` with `inner` `statement_failed`, no record for either; at `cc5-metadata`'s third table: `statement_failed` at that step, no record, the earlier tables kept; at `cc5-launch`'s overwrite guard: its prerequisites recorded, it not; a failing record insert: `record_failed`, no record. The same isolate then retries every group and each completes; the end state equals a clean run's, and every existing table's hash is unchanged |
| Real engine error | a stray `city_metadata_requests` table without the doc's columns makes `cc5-metadata` fail at its index (`no such column`), with no record; once the stray table is dropped the retry completes with the clean run's objects |
| Why the overwrite guard | with `founder_records_no_overwrite` dropped, `INSERT OR REPLACE` rewrites a founder record on both engines (its DELETE trigger never fires); with the guard restored the same statement is refused and the row is unchanged |

**Switches-off parity** (`test/cc5-parity.test.js`, 3 passed). The import graph of `src/index.js`, static and dynamic imports, does not
reach `src/cc5schema.js`. The Worker's real entry points (the default `fetch` and `scheduled`) run 26 visitor requests, 8 signed-in reads
and 5 signed-in writes (a post, a vote, a notices call, a feedback message, a logout), then the cron twice (once at 03:05 UTC, which also
prunes the balance history), against a fake D1 that records every statement: the copy above, with a fixed clock, a seeded random
generator and a fake chain. With the switches as committed in `wrangler.jsonc` (481 statements), with every v5 switch set to its default,
and with no setting at all: no statement names any of the 106 group objects or a `cc5-` id, and the database ends with exactly the objects
it started with (no table, index or trigger added or changed). The committed and the all-defaults runs issue the same statements in the
same order and give the same answers. Even with the six group switches set away from their defaults, no cc5 statement is issued and no
table appears, because nothing in this stage calls the runner (and the runner's own gate would refuse them: their inputs are missing).

**Mutation checks** (run by hand on 24 October, not committed): dropping `city_launches`' overwrite guard, recording a group before its
statements, widening the `segment` range to 0-5, adding a group index on `users`, letting the job call `ensureCc5Group`, and changing one
member's row during a migration each made the tests above fail. For the review round, every new regression test of
`test/cc5-schema.test.js` was run against the module as it was before the fixes and failed there (section 10).

**Census observation (pre-existing, not caused by this stage).** The production schema read has no index `streaks_active`. It is declared
inside the migration `2026-09-27-fair-launch` (`src/store.js:199`), but that line was added on 3 October (commit 1c8c047) to a migration
production had already recorded on 27 September, so production never ran it; a recorded id never runs again (the rule O8 exists for). The
copy reproduces it: today's `ensureSchema` adds nothing to it, and no group adds the index. Open item O10.

This is a copy of the production **schema** with synthetic rows; the dry run on a copy of the production **data** (a validated backup,
restored locally) is the backup step of section 8, which the owner runs (E9). The census and the backup step were exercised on this copy
(section 8.4).

## 6. Readings of the design (where it is abbreviated or ambiguous)

Where the doc is abbreviated or ambiguous the conservative reading is taken. Some readings add a safety rule beyond the doc's own marks
and say so (R3, R4, R6 to R9, R23, R24): each is the smallest rule that keeps a confirmed chain fact or a kept row from being rewritten,
and a later group can release one with `DROP TRIGGER` under a new id (O8, O14). Line numbers are `schema-and-api.md` unless marked §NN
(master section) or `master-v5.txt`.

| # | Doc | Reading |
|---|---|---|
| R1 | rule 3, line 41; "Statement lists below are abbreviated to the definitions", line 216 | Each group is an array of single statements; comments in the doc's SQL are kept out of the stored SQL (they are not part of a definition). The comments that carry a rule are kept as JavaScript comments beside the statement and listed in section 3 (finding SF-11). |
| R2 | value comments such as `-- 'selection' \| 'hourly' \| 'keeper' \| 'activity'` (line 893), `-- 'chain_launch' \| 'post' ...` (line 548), `carry_reason` (line 806) | A comment listing values is **not** turned into a CHECK. Only the CHECKs the doc writes are created. |
| R3 | `selection_cities_founded_terminal` (line 338); "Founder selected is terminal" (`master-v5.txt` 1228, §21); "reject every ordinary ... deletion" (1238) | The doc's UPDATE trigger, plus (an added rule): a founded city's row cannot be deleted, replaced or taken over (otherwise DELETE or REPLACE would reopen a founded city). Unfounded rows stay free, REPLACE included. |
| R4 | `selection_receipts_no_update` / `_no_delete` (lines 391-394) | As written: updates allowed until `verifier_digest` is set, never deleted. Because a receipt is never deleted, REPLACE (a delete) is refused for every receipt, and no update may move one receipt onto another's `cycle_id` or `digest` (an added rule). |
| R5 | `-- append-only triggers ...` (lines 508, 560, 640, 703) and rule 6 (line 49) | "Append-only triggers" means no UPDATE, no DELETE and no overwrite (section 4), for `manager_application_events`, `activity_events`, `city_metadata_versions`, `city_metadata_request_events` and `founder_records`. |
| R6 | `-- triggers: no DELETE; UPDATE only sets ended_at, ended_by and end_reason, once` (line 523); `master-v5.txt` 1300-1301 | No DELETE, no REPLACE (including through the one-active-manager partial index), and the one allowed UPDATE is the one that ends the term: it sets `ended_at`, `ended_by` and `end_reason` together (an ending without who or why would freeze an incomplete row: finding SF-6), changes no other column, and is refused once `ended_at` is set. |
| R7 | `city_metadata_active_frozen_after_launch` (line 652); "afterwards nothing here may change" (line 650); §24 "keep identity/economics immutable" (`master-v5.txt` 1410) | The doc's UPDATE trigger, plus (an added rule): a launched city's active row cannot be deleted, replaced (by city, ticker or mint) or taken over. Before launch the row changes freely, REPLACE included. |
| R8 | 3.6 rules: "A record is written only from a confirmed chain read" (line 780); §24 "permanent uniqueness after launch" (`master-v5.txt` 1398) | An added rule (the doc marks no trigger here): `city_launches` is append-only (no UPDATE, DELETE or overwrite on any of its keys: `(cluster, program_id, city_id)`, `mint`, `ticker`, `city_id`). A launch cannot be undone on chain, so its mirror cannot be edited. The retried launch batch writes it with `keptInsert`. `launch_preparations` stays mutable. |
| R9 | 3.7 rules: actions confirmed "only after the chain shows the effect" (line 873); "Leaves stay owed until paid or claimed; no expiry and no sweep" (line 877); §16 "idempotent per-coin/per-quote/per-hour records" (`master-v5.txt` 968); §31 "A caller cannot redirect the destination" (1787) and "Confirmed funded holder allocations remain owed until paid ... no administrative sweep" (1794-1795) | Added rules (the doc marks no trigger in 3.7): no hourly run, sample or action is ever deleted or replaced and its key columns never change (a deleted or replaced keyed record would let an hour or an action run twice); a `confirmed` action is final; each action tuple is unique (`hourly_actions_once`, R25). A **leaf** is protected only once it is a confirmed funded allocation (section 4: paid or claimed, or its hour's root on chain); then it is never deleted, replaced or redirected and paid or claimed is final. Before that it can be corrected (findings SF-1, SF-3). Status and progress columns otherwise change freely (the state machines belong to S42 and S44). Retention is open item O14. |
| R10 | no `REFERENCES` anywhere in sections 3.2 to 3.8 | No foreign key is added. D1 enforces declared foreign keys (`foreign_keys` = 1 on the local D1), so inventing one would change what writes succeed. |
| R11 | "`coin_art` is reused for approved, content-addressed image bytes" (line 617) | `cc5-metadata` does not create `coin_art`: it belongs to `READY_MIGRATION` (`src/coinart-store.js`), and the production schema read has no `coin_art` (the COIN_V2 switches never ran there). Open item O1. |
| R12 | `cc5-ops` "created with the first of SELECTION_V5, CC_HOURLY or LAUNCH_V5" (line 889) against the lease name `'activity'` (line 893) | The creation sentence is followed: `ACTIVITY_POINTS` does not create `cc5-ops`. Open item O2. |
| R13 | derived and mutable tables: `activity_totals` "derived cache, rebuilt at any time" (line 586), `city_review_locks` (line 705; the approval batch deletes its row, line 726), `selection_cycles`, `selection_snapshots`, `national_ranks` (30-day retention, line 463), `manager_applications`, `activity_evidence`, `city_metadata_uploads`, `city_metadata_requests`, `launch_preparations`, `idempotency_keys` (24-hour expiry) | No trigger: the doc marks none of them, and their rules need updates or deletes. `job_leases` is not among them any more (R23). |
| R14 | prerequisites | A prerequisite is listed only where the configuration check already requires the prerequisite's switch (section 2), so "created only when its switch first leaves its default" holds for every group. Reads of another group's tables whose switch is not guaranteed on are open items O3 to O6 and O16, not prerequisites. |
| R15 | "users by migration case" (3.10 step 3, line 935); R1 section 9 (`R1-identity.md` 173-182) | Both readings are counted, `testlab` accounts excluded as R1's table says: R1's buckets with R1's first query verbatim (M1 wallet and city, M2 wallet without a city, M3 Google or e-mail without a wallet, other), and the sign-in a member has today (a wallet plus a Google or e-mail sign-in, including an added Google sign-in in `user_logins`; a wallet only; Google only; e-mail only; other). R1's duplicate-wallet and live-session queries are used verbatim. |
| R16 | `SELECT status, COUNT(*) FROM seats GROUP BY status` (3.10 step 3, line 936) | A status is a row value, so the label is a constant: a `CASE` maps the six statuses the code writes (`provisional`, `active`, `grace`, `steward`, `released`, `revoked`; src/seats.js, src/admin.js) to themselves and anything else to `other`. The same rule for clusters (`mainnet`, `devnet`, `other`) and the `cc5-` record ids. A label outside a count's list stops the census instead of being printed. |
| R17 | "Compare before/after counts and hashes for wallets, profiles, posts, canonical locations, FounderRecords, city coins and monetary liabilities" (§07, `master-v5.txt` 482); 3.10 step 1 (line 931) | Eight digest categories over fixed columns of the production schema read: `wallets`, `profiles` and `locations` split `users` so that each of its columns is in exactly one; `posts` (with `votes`); `community` (`follows`, `blocks`, `mutes`: §07 "community history", line 468); `founders` (`seats`, `claims`, `manager_terms`: today's founder and manager roles; the v5 `founder_records` mirror is digested on its own under `cc5` once it exists, so creating it does not change the category); `coins` (`city_coins`, `lp_coins`, `admin_tokens`); `onchain` (`lp_approvals_log`, `lp_setup`). The database holds no balance or payout today, so "monetary liabilities" is read as these on-chain records; the hourly leaves (amounts owed once their root is on chain) are digested under `cc5` when `cc5-hourly` exists. Fixed columns mean a migration that adds a column or a table leaves every category digest unchanged. Plus the schema itself (R19). |
| R18 | "hashes" (3.10 step 1); "returning no member data" (line 935) | sha256 over sorted rows, computed in the census process. A digest of a few low-entropy rows (a wallet whose `wallet_at` is NULL, ids 1 to 5) could be confirmed by guessing against public holder lists, so a census of the production database is always keyed: HMAC-SHA256 under a 32-byte key kept outside the repository, the output carrying only the key's fingerprint. An unkeyed census needs `--unkeyed`, which `--remote` refuses, and a local database whose wrangler config is outside the repository (a restored copy may hold production data) needs `--key-file` or `--unkeyed` (finding SEC-8). |
| R19 | "Validate a backup" (3.10 step 1; §07 "Take/validate backups", `master-v5.txt` 477; §37 step 1, 2091) | A Time Travel bookmark cannot be validated without restoring production to it, so validation uses the export: it is restored into a new local database, and the census of that copy must equal the source's on the **schema** (every table, index and trigger, object for object: findings F1, SEC-3), on every category digest, and on every table's row count except the tables a live site writes on its own between the two reads (`CHURN_TABLES`, finding SEC-6). Without `--export` the step records the bookmark only. |
| R20 | "dry-run every migration on a copy" (line 931) | The groups the switch change creates (`groupsForFlags`, prerequisites included) are created on the validated local copy by the real runner (`cc5Runner` through Miniflare's local D1), and the census before and after must show every preserved category, every existing object and every existing row count unchanged, exactly those groups' objects added (tables, named indexes, triggers) and their records present. |
| R21 | "run by someone with production D1 access" (line 935); E9 | Both tools default to the local database; `--remote` is an explicit operator choice and is never run by this stage. The census holds rows only in memory and runs wrangler with `WRANGLER_WRITE_LOGS=false` and `WRANGLER_LOG=log`, its output captured and never shown (section 8.1). |
| R22 | rule 2 (lines 38-40) against 3.10 step 2 (lines 933-934) | Rule 2 (lazy, per switch) overrides the step 2 sequence: only listed prerequisites are ordered at run time (finding SF-12). |
| R23 | `fencing ... +1 on every acquisition` (line 895); "a run that lost its lease ... cannot write" (lines 914-917) | An added rule: a lease row is never deleted, its name and rowid never change, `fencing` never goes back, and a new holder comes only with a higher fencing (`job_lease_fenced`; finding SF-9). The doc's upsert and a renewal pass; `INSERT OR REPLACE` is a writer rule (section 4, O7). |
| R24 | none (SQLite's rowid rules) | An added rule: no kept table holds a rowid below 1 (an explicit one is refused after the insert, an update to one before it), so the overwrite guard can skip the undefined `NEW.rowid` of an insert that names no rowid (finding SF-4). A receipt without a positive cycle id is refused (`receipt_cycle_required`), because its INTEGER PRIMARY KEY would otherwise be given the next rowid: a permanent receipt for the wrong cycle (finding SF-5). |
| R25 | sections 3.2 to 3.8; rules 4 and 5; section 5 | Amended in `schema-and-api.md` by this stage, while nothing is recorded anywhere (later it would be a table rebuild under a new id): `NOT NULL` on the seven text primary keys (`selection_cities.city_id`, `founder_records.city_id`, `city_metadata_active.city_id`, `city_review_locks.city_id`, `launch_preparations.id`, `hourly_actions.action_key`, `job_leases.name`; SQLite's legacy rule lets a text primary key be NULL, and on an append-only table such a row could never be removed: finding SF-5); `CREATE UNIQUE INDEX hourly_actions_once ON hourly_actions (cluster, program_id, coin, quote_mint, utc_hour, action, batch)`, so two spellings of one action key cannot both exist (finding SF-8); the kept-table writer rule in rules 4 and 5, section 5, 3.4, 3.6, 3.7 and 3.8 (finding SF-2); a note at the top of section 3. |

## 7. Open items for later stages

| # | For | Item |
|---|---|---|
| O1 | S24, S25 | Approved image bytes go to `coin_art`, which production does not have: the metadata stage calls `ensureReadySchema` (`src/coinart-store.js`) or adds `coin_art` to a later group under a new id. |
| O2 | S20 | If the activity job takes the `'activity'` lease (line 893), it needs `cc5-ops`, which section 3.8 does not create for `ACTIVITY_POINTS`; amend line 889 (and add `cc5-ops` to `cc5-activity`'s prerequisites) or keep the activity job lease-free. |
| O3 | S17 | Selection reads `city_assignments` and `users.signup_completed_at` (3.2 "Candidates", line 447), which are `cc5-identity`'s; `SELECTION_V5` does not require `WALLET_ONLY` in the configuration check. Either add that requirement (then `cc5-identity` becomes a prerequisite of `cc5-selection`) or define the candidate source without it. |
| O4 | S24, S26, S61 | `founder_records` (the FounderRecord mirror) is created by `cc5-selection` only. `FOUNDER_RECORD_CHAIN` has no group, and `METADATA_V5` and `LAUNCH_V5` do not require `SELECTION_V5`. Until the FounderRecord interface reads the chain (it answers `founder_record_unavailable` until S61, implementation-report S24), the metadata and launch stages must not read `founder_records` unless `cc5-selection` is recorded. |
| O5 | S26 | The launch batch appends the `launch:<city>` activity event (line 782), but `LAUNCH_V5` does not require `ACTIVITY_POINTS`. `cc5-launch` therefore does not require `cc5-activity`; the launch batch appends the event only when `cc5-activity` is recorded, and the activity backfill (3.4, line 607; §23 "A confirmed existing city launch can receive its one-time award") covers a later switch-on. |
| O6 | S21, S22 | The manager check "confirmed launch" (line 526) reads `city_launches` or `lp_coins`; `MANAGER_APPS` does not require `LAUNCH_V5`, so it reads `city_launches` only when `cc5-launch` is recorded (or reads the `launch:<city>` activity event). |
| O7 | every writer | A kept table takes a plain INSERT or the guarded `keptInsert`; any conflict clause on a kept row aborts (section 3). A job lease is acquired only by the doc's upsert and never deleted or written with `INSERT OR REPLACE` (the trigger refuses the delete; it cannot refuse the replace). Never bind an id or rowid below 1. |
| O8 | every later change | A recorded group never runs again. A change to a group's statements ships under a new id (the pattern of `APPROVED_MIGRATION` in `src/coinart-store.js`), never by editing a recorded list. |
| O9 | S20 | Of the single-column primary keys, only `activity_totals.user_id` still takes NULL (an INTEGER PRIMARY KEY is the rowid: NULL is given the next rowid, and `NOT NULL` has no effect there). It is a derived cache, rewritten freely, so the activity stage always binds the user id. The seven text keys refuse NULL and receipts refuse a missing cycle id (R24, R25). Pinned by both test files. |
| O10 | S16, census | `streaks_active` is missing in production (section 5): `src/store.js` declares it inside the already-recorded `2026-09-27-fair-launch` migration. The streak update runs without it until a later change ships the index under a new migration id, or until `LEGACY_SEATS=frozen` stops streak updates (3.9). Not an S08 change. |
| O11 | the owner's first census (E9) | The census and the backup step have run only against Cloudflare's local D1. Their statements (SELECTs over `sqlite_master` with the `sql` column, `pragma_table_info('<table>')`, `quote()`) and `wrangler d1 time-travel info` and `d1 export --remote` have not run against the remote database. If remote D1 refuses a statement, the census stops with D1's message and prints nothing else; the first remote run is the check. Miniflare's local export leaves out `_cf_` and `sqlite_` tables and keeps every object's SQL text byte for byte (the restored schema digest equals the source's, section 8.4); that the remote export does the same is not verified here: a restore whose schema differs stops the step as "NOT validated". |
| O12 | every census | A census is two or three wrangler calls (schema and columns; then counts and digests, split when over 100 statements; more when one part exceeds 5,000 rows). Writes between calls on a live site can make a before and after differ in churning counts (sessions, rate limits); preserved categories should not move during a migration window, and a difference there means stop and investigate. |
| O13 | S42, S44 | `hourly_leaves` and `hourly_actions` have no `mode` (the doc's 3.7), while `hourly_runs` keys on it. Shadow runs never write leaves or actions (they compute and publish evidence from `hourly_runs` and their own blobs); if shadow needs them, a later group adds a `mode` column (or shadow tables) under a new id. A shadow leaf written by mistake is not kept (R9), so it can be removed; a shadow action would be kept and would occupy the live action key. |
| O14 | S42, S44, a later group | Retention: hourly runs, samples and actions, and kept leaves, are never deleted (R9), and leaves are one row per holder per coin per hour, against D1's per-database size limit. The doc sets no retention for 3.7. Before the volume matters, the owner decides one; a later group (new id) releases the rows past it with `DROP TRIGGER` of the matching guard and a new, bounded guard, and the census records the counts before and after. |
| O15 | S42, S44 | The master asks to keep actual paid, funded, pending and carry-forward balances separate, to show pregraduation locked, postgraduation applied and pending liquidity separately, and to publish the buyback pending amount and last execution (`master-v5.txt` 1738-1739, 1826-1827, 1843-1844). The schema stores per hour `funded_raw`, `allocated_raw`, `dust_raw` and `carried_raw`, and per action `amount_raw`. The source chosen here: liquidity buckets and `buyback_pending` are read from the program's on-chain bucket accounts (the chain enforces the caps, so it is authoritative); paid and owed amounts are sums over `hourly_leaves` by status; the last buyback is the latest confirmed `buyback` action. If S42 or S44 need a stored per-coin, per-quote balance snapshot (for B07 to B10 evidence), it ships as a new group id. |
| O16 | S42, S44 | The hourly job needs the founder payout destination (`founder_records`) and the coin list (`city_launches`), while `CC_HOURLY` requires neither `SELECTION_V5` nor `LAUNCH_V5`. It reads both from chain (the FounderRecord and the coin registry), or from those tables only when `cc5-selection` and `cc5-launch` are recorded. |
| O17 | S17 | A receipt freezes as soon as `verifier_digest` is set, and there is one receipt per cycle. The selection stage writes `verifier_digest` only when it equals `digest`; a disagreement is recorded on `selection_cycles.error_code` (`verifier_disagreement`) and retried on the same cycle (3.2). A `CHECK (verifier_digest IS NULL OR verifier_digest = digest)` would need a table rebuild under a new id. |
| O18 | the stage that builds idempotency keys (section 5) | All writes to `idempotency_keys` go through one helper that accepts only routes on an explicit replayable allowlist; `/api/signup/handoff` and any route whose response carries a code, token or session is excluded, with a test. `response_json` can hold a member's own answer, so the same stage builds the 24-hour expiry sweep (`idempotency_keys_expires`). |
| O19 | the owner, before S17 writes the first row | Permanent tables hold personal data (`founder_records.wallet` and `user_id`, `activity_events`, the event tables' `actor`, `note` and `checks_json`, `country_managers`). There is no erasure or redaction path: a member's deletion request or a moderation removal of harmful text needs a sanctioned procedure (an owner-run migration under a new id that rewrites only the personal columns to a tombstone in one batch, with an audit row), which the owner and the master's audit rules decide. Test-lab accounts never write v5 tables: the existing test-lab reset (`src/admin.js` `RESET_ORDER`) deletes only legacy tables, and a batch that also tried a v5 row would abort as a whole. |
| O20 | the first group that releases a guard (O14) | A runtime check that a recorded group's triggers exist (re-create or refuse) is designed together with the first group that drops one by design; until then the census schema digest is the check (section 4). |

## 8. The census and the backup step (owner or operator steps, external E9)

Both tools are operator tools in `scripts/citycoin/`; nothing in the Worker imports them. They default to the local database of a wrangler
config. Reading or exporting the **production** database (`--remote`) needs production D1 access (implementation-report E9: "Production
D1 read and export access ... Credential holder") and is run by the owner or the credential holder, never by the stage that built them.
Run them from a checkout of this repository after `npm ci` (they use the wrangler it pins, 4.137.0), on a trusted machine of the
operator's.

### 8.1 The census (`scripts/citycoin/census.mjs`)

```
node scripts/citycoin/census.mjs --remote --key-file ~/citycoin-ops/census.key > ~/citycoin-ops/census-before.json
node scripts/citycoin/census.mjs --compare ~/citycoin-ops/census-before.json ~/citycoin-ops/census-after.json
```

- **What it prints:** the database name, `local` or `remote`, the time, every table's name and row count, the counts below, a digest per
  category and per part, the schema (counts per type, one digest, one digest per object by name), and the duplicate-wallet check. Never a
  row value, wallet, e-mail address, name or id: count labels are constants (R16), every number is checked to be a count, a table or object
  name that is not a plain identifier is counted but not printed, and rows read for a digest exist only in the process's memory. Exit 3
  when duplicate wallets exist (the output is still printed).
- **Counts:** users (total, testlab, with a wallet, with a city), users by R1 case and by sign-in (R15), duplicate wallets (must be 0),
  cities with members, live sessions with and without a wallet proof, sessions (total, expired, without a user, without a wallet), seats
  by status and live seats, open windows, open elections, live manager terms, claims, posts (total, replies, hidden, deleted), city coins
  (total, with a mint, launched), `lp_coins`, `lp_approvals_log` and `lp_setup` by cluster, admin tokens, `schema_migrations` (total,
  `cc5-` records), which history tables exist (3.9 and 3.10 step 3), and, when present, every cc5 table's rows and digest.
- **Digests (R17, R18):** each part is sha256 of `<columns joined by ",">\n<sorted rows>`, a row being SQLite's `quote()` of each column
  joined by "," (the same row hash as `tableHash` in `test/helpers/cc5-d1copy-worker.js`; a test shows they are equal); a category's
  digest covers its parts' names, row counts and digests. `--key-file <path>` makes every digest an HMAC-SHA256: the key (32 random bytes,
  hex) is created on first use with mode 0600, must be outside the repository and every git work tree, is refused when others can read
  it, and only its fingerprint is printed. **`--remote` requires `--key-file`**; a local database whose config is outside the repository
  needs `--key-file` or `--unkeyed` (R18). Keep the key for the after-run: two censuses compare only when their fingerprints match.
- **The schema (findings F1, SEC-3):** one read of `sqlite_master` (type, name, table, SQL; SQLite's `sqlite_*` and D1's `_cf_*` objects
  left out): counts per type, a digest over every object, and a digest per object by name. Schema text is not member data, and still only
  names and digests are printed.
- **How it reads:** only `wrangler d1 execute <database> --json --command "<SELECT>;\n<SELECT>..."`, `--local` by default. Each statement
  is checked to be exactly one SELECT (no second statement, no comment, no write, `PRAGMA`, `ATTACH`, transaction or `RETURNING` keyword,
  no unterminated quote) before it is joined and again before each call; a refused statement stops the census. On a wrangler failure it
  reports D1's error text about the SQL, never wrangler's output.
- **Wrangler's debug log and output.** Wrangler 4.137.0 appends every line it prints, `--json` query results included, to a log file under
  `~/.config/.wrangler/logs` (or `WRANGLER_LOG_PATH`) unless `WRANGLER_WRITE_LOGS=false` (`node_modules/wrangler/wrangler-dist/cli.js`,
  `appendToDebugLogFile`; confirmed here on a local copy: the rows of a query appeared in the log). Both tools run wrangler with
  `WRANGLER_WRITE_LOGS=false`, `WRANGLER_SEND_METRICS=false`, the banner off (no npm update check), `CLOUDFLARE_CF_FETCH_ENABLED=false`
  (otherwise the local Miniflare behind every `--local` command fetches `https://workers.cloudflare.com/cf.json` into
  `node_modules/.mf/`; seen here once before the switch was added) and `WRANGLER_LOG=log` (an operator's `debug` level would print API
  answers; a lower level would hide the `--json` results), with its output captured and never shown (`scripts/citycoin/lib.mjs`; a test
  asserts no log file is written). **An operator who runs `wrangler d1 execute --remote` by hand should set `WRANGLER_WRITE_LOGS=false`
  too**, or the rows land on disk.
- **What the census process holds** (finding SEC-9): to compute the digests it reads every covered column into memory, including
  `password_hash`, `contact_email`, `phone`, `provider_id` and post bodies. Nothing is printed or written, but those values pass through
  the operator's process: run it on a trusted machine with core dumps off (`ulimit -c 0`) and an encrypted disk (swap).
- **`--compare a.json b.json`:** `ok` (exit 0) when every preserved category has the same digest, row count and missing parts, no table
  disappeared, and no schema object disappeared or changed (`schema.status` is `same`, or `added` when objects were only added, as a
  migration does); otherwise exit 4 with the categories, parts and objects that changed. Changed counts, row counts, added tables and
  objects and new `cc5-` records are listed without failing it (a live site's sessions move; a migration adds objects).

### 8.2 The backup step before each migration (`scripts/citycoin/backup.mjs`)

Before the configuration change that moves a switch away from its default (and so lets a feature stage create a group), the operator runs,
at a quiet time (a write between the source census and the export can stop the validation, step 4):

```
node scripts/citycoin/backup.mjs --flags SELECTION_V5=shadow --export ~/citycoin-ops/2026-11-01.sql --key-file ~/citycoin-ops/census.key   # dry run: prints the plan
node scripts/citycoin/backup.mjs --remote --execute --yes --flags SELECTION_V5=shadow --export ~/citycoin-ops/2026-11-01.sql --key-file ~/citycoin-ops/census.key
```

Without `--execute` it prints the steps and the exact commands and runs, reads and writes nothing (the default plan is the remote one).
`--execute` needs `--remote` or `--local`; with `--remote` and `--export` it needs `--yes` (the remote export pauses D1). `--groups
cc5-ops,cc5-selection` names groups directly; `--flags` maps switch values through `groupsForFlags` (prerequisites included, in the order
of section 3.10 step 2); `cc5-identity` is refused (stage S09). An export is a copy of the source's member data, so `--export` with
`--execute` needs `--key-file` (or `--unkeyed` for a development database). The steps:

| Step | What runs | Notes |
|---|---|---|
| 1. Bookmark (remote only) | `wrangler d1 time-travel info <db> --json` | The D1 Time Travel bookmark of this moment, printed with its restore command; the answer is read only in a bookmark's shape. A local database has no Time Travel. |
| 2. Census of the source | the census above (keyed for `--remote`) | Saved as `<export>.census-source.json`. A failed duplicate-wallet check is printed: stop before any migration. |
| 3. Export (with `--export`) | `wrangler d1 export <db> --<target> --output <file>` (`--skip-confirmation` for remote: the confirmation is `--yes`) | The file holds member data: it must be outside this repository and every git work tree (resolved through symlinks, no `..`), must not exist (never overwritten), and is created with mode 0600 before wrangler writes it. Its size and sha256 are printed. **Wrangler's output is captured and never printed** (finding SEC-1): on a remote export it prints a pre-signed download link to the whole dump, valid for one hour. **D1 does not serve queries while a remote export runs** (wrangler's own warning; seconds for this database). An export that fails is deleted; a step that fails after a complete export names the export and the restore folder as holding member data (finding SEC-5). |
| 4. Validate | `wrangler d1 execute cc5-restored-copy --local --config <export>.restore/wrangler.json --file <export>`, then the census of that copy | A **new** local database in `<export>.restore/` (its own config; never the source). Valid only when its schema equals step 2's object for object, every category digest equals step 2's, and every table's row count does too, except the tables a live site writes on its own (`CHURN_TABLES` in `census.mjs`: sessions, settings, rate limits, nonces, in-flight sign-ups, the cron's samples, streaks, snapshots, coin stats and price history, notices, feedback), which are listed (R19). Otherwise "NOT validated", exit 5, no rehearsal; a changed category or row count there points at a write on the live site between the census and the export: run again at a quiet time. |
| 5. Rehearse (with `--groups` or `--flags`) | the runner (`src/cc5schema.js` `cc5Runner`) on the restored copy through Miniflare's local D1, then the census | Holds only when the preserved categories, every existing object and every existing row count are unchanged, exactly the groups' objects (tables, named indexes, triggers) and tables were added, and their records are present (R20). Otherwise exit 5. |
| Restore commands (printed, never run) | `wrangler d1 time-travel restore <db> --bookmark=<bookmark>`; or `wrangler d1 create <db>-restored-<date>` then `wrangler d1 execute <db>-restored-<date> --remote --file=<export>` | Time Travel undoes every write after the bookmark, site-wide. The second leaves production as it is. |

The export and `<export>.restore/` hold member data: keep them on the operator's own encrypted disk, never in a repository, an issue, a
chat or a pull request, and delete them when the release no longer needs them. The census files beside them hold counts and digests only.
**An operator who runs `wrangler d1 export --remote` by hand sees a one-hour bearer link to the dump in its output: never paste or share
that output.**

### 8.3 When to run what

- **Before every switch change that `groupsForFlags` says creates a group** (the first `SELECTION_V5`, `ACTIVITY_POINTS`, `MANAGER_APPS`,
  `METADATA_V5`, `LAUNCH_V5` or `CC_HOURLY` value other than its default): the backup step with `--export` and `--flags` (bookmark, census,
  export, validation, rehearsal). The groups are additive (no `ALTER`, no write to an existing table), so the bookmark and the validated
  export are the rollback; the rehearsal is the dry run of 3.10 step 1.
- **After the deployment and the first request that creates the group:** the census again with the same key, then `--compare` with step
  2's file: every preserved category must be `same`, the schema `added` (only the group's objects), and the new `cc5-` records and tables
  appear.
- **Before and after `cc5-identity` (stage S09), stage S16's seat freeze and the cutover (S55):** the same pair. S09's backfill (section 9)
  writes only the new `users` columns, which no category covers, so every category must stay `same`; its dry run on the restored copy is
  where the count checks of section 9 run.
- The first remote run of each tool is itself the check of open item O11.

### 8.4 Evidence (24 October 2026, local only)

`test/cc5-census.test.js`, 20 tests, all passing here (about 30 seconds; the two command-line tests need workerd and are skipped with the
reason when it cannot start):

| Check | Result |
|---|---|
| One SELECT per statement | 7 accepted forms (string literals holding `;`, `--` and `/*`, quoted identifiers, `pragma_table_info`); 25 refused forms (writes, second statements, comments, `WITH`, `PRAGMA`, `ATTACH`, `EXPLAIN`, `RETURNING`, `load_extension`, unterminated quotes, brackets, backticks, control characters, over-long), each with its reason and without echoing a literal |
| Column lists | every category column exists in the schema read; each `users` column is in exactly one of wallets, profiles and locations; every other part is its whole table in order; every count's columns exist; 26 cc5 tables, none in production |
| Census on the copy (Node's SQLite) | every count equals the synthetic rows' (computed in JavaScript); all 55 tables counted; `coin_requests`, `coin_screenings`, `coin_ready`, `coin_legacy_designs`, `coin_versions` absent (the COIN_V2 tables never ran in production); every one of the 100+ statements is one SELECT; the copy byte-identical afterwards; each full-table part's digest equals `tableHash` |
| Privacy | the census output contains none of the copy's 268 member-like synthetic values (wallets, addresses, e-mails, names, handles, tokens, bodies, hashes, blobs) and no "Synthetic Member", "example.invalid" or "synthetic-"; every key and string of the output is a census constant, a table or schema object name, a digest, the database name or the time |
| Sensitivity and compare | an identical copy compares `ok`; an expired session changes counts but stays `ok`; one changed wallet changes exactly `wallets` (part `wallets.users`); a changed post and a deleted `lp_setup` row add `posts` and `onchain` and that row count; a dropped table is reported removed |
| Before and after every group (3.10 step 1) | all eight categories `same`; exactly the 26 cc5 tables added; the only row count changed is `schema_migrations` 22 to 29; the seven records listed; each new table 0 rows with the empty-table hash; the schema `added` with exactly the 106 group objects, every existing object's digest unchanged |
| Schema against a lossy restore (F1, SEC-3) | a copy with `cc5-selection` and the same copy with every named index and trigger dropped: every data digest and row count equal (the earlier validation passed it), the schema `changed` with exactly the dropped objects listed, "NOT validated"; two founder-record guards dropped by hand show as removed in `--compare` (exit 4) with every category `same`; a weaker trigger under the same name shows as changed |
| Rehearsal exactness (F1) | a missing guard, an object outside the groups, a changed existing object, a missing record or a moved row count each make the rehearsal not hold |
| Churn (SEC-6) | sessions and rate-limit rows that moved between the reads leave the backup valid and are listed; a moved `admin_audit` count does not; no preserved table is a churn table |
| Remote backup run (wrangler stand-in, SEC-1) | `--remote --execute --yes`: bookmark, census, export (`--skip-confirmation`), restore, census, "backup VALIDATED"; the stand-in's signed export link never appears in stdout or stderr; no wrangler call inherits the terminal; `WRANGLER_LOG=debug` from the operator is forced back to `log` |
| Failure paths (SEC-5) | a failed export: the partial file is deleted and the message says so; a failed restore: the export and the restore folder are named as holding member data |
| Keyed digests | the key file is created 0600 outside the repository and re-read; HMAC digests differ from plain ones, are stable under the same key, and a plain and a keyed census refuse to compare; a group-readable or malformed key and a key inside the repository are refused |
| Paging and missing data | pages of 2 rows give the same digests; an empty database reports every count absent and every part missing; duplicate wallets fail the check; a table name that is not an identifier is counted, not printed |
| Wrangler stand-in | two calls, each `d1 execute <db> --local --json --command ... --config ...` holding only checked SELECTs; a failure or an unreadable answer never echoes what wrangler printed (a planted row value never appears) |
| Refusals before anything runs | census: `--remote` without a key, `--remote --unkeyed`, `--key-file` with `--unkeyed`, a config outside the repository without a key or `--unkeyed`, both targets, `--out` or `--key-file` inside the repository, a database name like an option, bad `--compare`, unknown options; backup: `--execute` without a target, `--remote --execute` without a key, a remote export without `--yes`, an export without a key or `--unkeyed`, an export inside the repository, an existing export, a missing folder, `cc5-identity`, an unknown group, groups without an export, malformed `--flags`, `--groups` with `--flags`; no key or file is created |
| Backup dry run | the remote plan with its exact commands (bookmark, census, export, restore into `cc5-restored-copy`, census) and the restore commands; nothing written |
| Census command line on Cloudflare's local D1 | `node scripts/citycoin/census.mjs --local --config <copy>/wrangler.json --unkeyed` (real `wrangler d1 execute --local` on a Miniflare-seeded copy; without `--unkeyed` it is refused): exit 0, **the same counts, tables, schema and digests as on Node's SQLite**, no synthetic value in stdout or stderr, **no wrangler log file written**, `--compare` exit 0 on equal files and 4 with `posts` changed, the local database unchanged afterwards |
| Backup command line, `--local --execute` | `--groups cc5-selection` gives `cc5-ops, cc5-selection`; the export is written 0600 outside the repository; the restored copy's census equals the source's on all 55 tables, the schema (88 objects, byte for byte: Miniflare's export keeps every object's SQL text) and 8 categories ("backup VALIDATED"); the rehearsal adds exactly the 8 tables and the 28 objects of the two groups with their records and leaves every category and existing object unchanged ("rehearsal HELD"); the source database is unchanged; no synthetic value printed, no wrangler log written; a second run on the same export is refused |

Mutation checks run by hand on 24 October (not committed): removing `WRANGLER_WRITE_LOGS=false` made the command-line census test fail on
the log file; letting the seat count print the raw status made the census stop ("a label outside its list") and the census tests fail.

**The whole website test command** (`node scripts/copy-assets.mjs && node scripts/pages/build.mjs && npm test`) is recorded in section 10
for the state after the review round.

## 9. Rule for stage S09 (`cc5-identity`): the `signup_completed_at` backfill

Recorded here as a rule for that stage; nothing in S08 writes it. From `schema-and-api.md` section 3.1 (lines 307-316), count-checked on
a database copy first (D08):

- Only rows with `wallet IS NOT NULL AND home_city IS NOT NULL AND provider != 'testlab'` get a value.
- The value is `MAX(created_at, COALESCE(wallet_at, created_at), COALESCE(home_at, created_at))` (the three columns exist in production:
  `users.created_at`, `users.home_at`, `users.wallet_at`). SQLite's multi-argument `MAX` returns NULL when any argument is NULL, hence
  the `COALESCE`s.
- ISO 8601 strings of one format compare correctly as text: the migration test first asserts that every value involved matches the
  `new Date().toISOString()` format (`YYYY-MM-DDTHH:MM:SS.sssZ`) and refuses to backfill otherwise.
- The value is an upper bound of the true completion time and is published as such.
- The set-once trigger `users_signup_completed_once` (section 3.1) lets the backfill fill a NULL value and refuses any later change, so
  the backfill can only touch rows whose value is still NULL (one that tried more would abort).
- The other 3.1 backfills (`loc_method = 'legacy'`, `loc_verified_at = home_at`, `loc_policy = 'pre-v5'`; `legacy_state` by the census
  predicates with ambiguous rows quarantined, never merged; one `legacy_backfill` row in `city_assignments` per user with a wallet and a
  city, `assigned_at = signup_completed_at`) follow the same copy-first rule.

## 10. Review round (24 October 2026)

A review of the stage raised 12 schema findings (SF-1 to SF-12), 4 runner and tool findings (F1 to F4), 10 security findings (SEC-1 to
SEC-10) and a note that the reviewer's own checks held. Each was reproduced first; each fix has a regression test, and every new test of
`test/cc5-schema.test.js` was run against the module as it stood before the fixes and failed there.

| Finding | What changed | Test |
|---|---|---|
| SF-1, SF-3 (leaves of shadow or unpublished runs could never be removed; added rules called "no product rule") | a leaf is kept only once paid or claimed or once its hour's root is on chain (confirmed `holder_root`, or a live run in `root_published`, `paying`, `done`); readings R3 to R9 say which rules are added; O13 (no `mode` on leaves and actions), O14 (retention) | `cc5-schema`: "hourly leaves (findings SF-1, SF-3)" |
| SF-2 (conflict clauses abort on kept tables; the doc did not say so) | `keptInsert` exported; the writer rule in `schema-and-api.md` rules 4 and 5, section 5, 3.4, 3.6, 3.7, 3.8, and beside each kept table in the module | `cc5-schema`: "keptInsert (finding SF-2)"; `cc5-d1copy`: "the writer rule on this engine" |
| SF-4 (`NEW.rowid` is -1 in a BEFORE INSERT trigger: a row with id -1 wedged the table) | the rowid is compared only above 0; `<table>_rowid_positive` (AFTER INSERT) and the takeover triggers keep every rowid at 1 or above | `cc5-schema`: "no kept table holds a rowid below 1"; `cc5-d1copy`: id -1 and 0 refused on both engines |
| SF-5 (single-column primary keys took NULL) | `NOT NULL` on the seven text keys (doc and code, R25); `selection_receipts_cycle_required`; O9 narrowed to `activity_totals.user_id` | `cc5-schema`: "primary keys are never NULL"; `cc5-d1copy`: "primary keys and NULL" |
| SF-6 (an ending without `ended_by` or `end_reason` froze the row) | the ending update must set all three (R6) | `cc5-schema`: the country-manager test |
| SF-7 (paid, pending, liquidity and buyback balances stored nowhere) | O15 states the source: chain buckets, sums over leaves, the latest confirmed action | — (open item) |
| SF-8 (two spellings of one action key could both exist) | `hourly_actions_once` unique index over the parts (doc and code, R25), included in the overwrite guard | `cc5-schema`: the hourly runs, samples and actions test; `cc5-d1copy`: 46 keys walked |
| SF-9 (DELETE plus re-insert reset a lease's fencing) | `job_leases_no_delete`, `job_leases_fencing_forward` (R23); `INSERT OR REPLACE` is a writer rule (O7) | `cc5-schema`: "job leases never lose their fencing" |
| SF-10 (a mismatching verifier digest freezes a receipt) | O17 | — (open item) |
| SF-11 (invariants in the doc's SQL comments were dropped) | kept as comments beside each statement; listed in section 3 | — |
| SF-12 (the 3.10 order is not enforced between unrelated groups) | R22; O16 for what hourly reads | — |
| F1, SEC-3 (backup validation, rehearsal and `--compare` were blind to triggers and indexes) | the census digests the schema; validation requires it exactly, `--compare` fails on a removed or changed object, the rehearsal requires exactly the groups' objects; census version `cc5-census/2` | `cc5-census`: "schema in the census", "rehearsal check", the command-line backup |
| F2 (a stalled D1 call held every later call in the isolate) | a 10-second limit per call (`timeout`); only successes are cached | `cc5-schema`: "a stalled D1 call fails closed" |
| F3 (an outage read as `record_failed`; prerequisite reasons dropped) | `prepare_failed`, `record_read_failed`, `inner` on the error and in the log line | `cc5-schema`: "errors name where they failed" |
| F4 (first-request cost undocumented) | measured and recorded in section 3, with the Workers Paid assumption | — |
| SEC-1 (the remote export printed a one-hour link to the dump) | the export runs captured, never printed; `--yes` required; `WRANGLER_LOG` forced to `log`; the inherited-output path removed; the warning in 8.2 | `cc5-census`: "backup --remote --execute (wrangler stand-in ...)" |
| SEC-2 (the runner did not check the switch) | `ensureCc5Group(env, id)` refuses a bare database and refuses unless env's switches need the group and the configuration check accepts the deployment; `cc5Runner` stays ungated for the rehearsal and tests | `cc5-schema`: "ensureCc5Group fails closed"; `cc5-d1copy`: "the Worker's entry fails closed on this engine" |
| SEC-4 (nothing guarantees idempotency responses never hold secrets) | O18; the rule kept beside `response_json` | — (open item) |
| SEC-5 (failure paths left member data without saying where) | a partial export is deleted; the export and the restore folder are named | `cc5-census`: "backup failures say where member data was left" |
| SEC-6 (live-site churn made validation fail) | only `CHURN_TABLES` may move between the reads; the quiet-window requirement in 8.2 | `cc5-census`: "backup validation allows only the live site's churn tables" |
| SEC-7 (no erasure or redaction path for permanent personal data) | O19 for the owner | — (open item) |
| SEC-8 (a local copy of production could be censused unkeyed) | `--unkeyed` explicit; a config outside the repository needs a key or `--unkeyed`; `--remote` refuses `--unkeyed` | `cc5-census`: refusals and the command-line tests |
| SEC-9 (the census holds secret columns in memory) | kept as designed; the exposure and the precautions in 8.1 | — |
| SEC-10 (an unknown group id was logged as given) | logged quoted, escaped and cut to 40 characters | `cc5-schema`: the unknown-id test |

**No live change.** No route, job or `src/index.js` path imports `src/cc5schema.js` (the parity test and the caller guard still pass);
`src/cc5schema.js` now imports `src/v5policy.js` for its gate, which does not change what the Worker imports. The whole website test
command (`node scripts/copy-assets.mjs && node scripts/pages/build.mjs && npm test`, 24 October, on this branch with every S08 file and the
review fixes): 2,404 tests, 2,403 passed, 0 failed, 1 skipped (the opt-in live read `SQUADS_LIVE=1`, skipped before S08 too; workerd ran,
so no D1-copy or command-line test was skipped); the rebuilt `public/` is byte-identical to the committed one (`git status` shows no change
under `public/`). Before the review round the same command ran 2,387 tests with the same single skip.
