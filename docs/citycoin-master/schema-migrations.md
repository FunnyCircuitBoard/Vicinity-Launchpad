# Citycoin.dev v5: schema migrations (stage S08)

Master change order v5, sections 07 (BR-05), 16, 17 (WP-01), 20 to 32 and 37. Design: `schema-and-api.md` section 3 (sections 3.2 to 3.10)
and section 5. Plan: `implementation-report.md` stage S08 and rows A14, B14 and D08. This file is the stage record; the implementation
report is updated by the release step.

**Status on 24 October 2026: nothing here is applied or called.** Local branch `cc/s08` only (not pushed, not merged, not deployed). No
route, job or `src/index.js` path imports the new module, so the Worker issues exactly the D1 statements it issues today, whatever the
switches say (shown statement by statement in section 5), and the built `public/` does not change. No production or remote database was
read or written for this work. Live facts at the time: 5 members, 0 seats, 0 open windows, no city coin listed.

## 1. What this part of S08 built

| File | What it is |
|---|---|
| `src/cc5schema.js` | The seven statement lists of `schema-and-api.md` sections 3.2 to 3.8 (`cc5-ops`, `cc5-selection`, `cc5-activity`, `cc5-managers`, `cc5-metadata`, `cc5-launch`, `cc5-hourly`), the order of section 3.10 step 2 with a reserved first slot for `cc5-identity`, the pure helper `groupsForFlags(flags)`, the runner `ensureCc5Group(envOrDb, id)` and its named error `Cc5SchemaError` |
| `test/cc5-schema.test.js` | 27 tests on Node's SQLite (the engine D1 runs): the doc parity, the switch mapping, the runner, every append-only and conditional trigger, the CHECK constraints and partial indexes, and the guard that nothing in the Worker or the pages calls the runner yet |
| `test/cc5-d1copy.test.js` | 12 tests, each run twice: on Cloudflare's local D1 inside workerd (Miniflare) and on Node's SQLite, against a copy of the production database's shape with synthetic rows (section 5) |
| `test/cc5-parity.test.js` | 3 tests: the switches-off parity claim, by running the Worker's real request and job entry points against a fake D1 that records every statement (section 5) |
| `test/helpers/cc5-d1copy.js` | The copy: the schema read, synthetic rows in every one of its 55 tables, the two engines, and a reader of section 3 as data (tables, columns, CHECKs, keys, indexes) |
| `test/helpers/cc5-d1copy-worker.js` | The executor the D1-copy tests drive: inside workerd it is the Worker (so `src/cc5schema.js` runs in the Workers runtime against local D1); in Node it runs in-process |
| `test/fixtures/prod-schema-2026-10-24.sql` | The production D1 schema as read on 24 October 2026: `sqlite_master` text of 88 objects, **schema only, no rows** |

The census script and the backup step are the rest of S08 (section 8).

## 2. The groups

Each group is created only when its switch first leaves its default, and only by a feature stage that calls `ensureCc5Group` while that
switch counts (the fail-closed gate of `src/v5policy.js`: the switch is set, the v5 configuration check accepts the deployment and its
inputs are valid). Until a feature stage adds that call, no group is ever created.

| Id | Design | Created when | Prerequisites | Tables | Kept rows (triggers) |
|---|---|---|---|---|---|
| `cc5-ops` | 3.8 | the first of `SELECTION_V5` shadow or on, `CC_HOURLY` shadow or on, `LAUNCH_V5` on | none | `job_leases`, `idempotency_keys` | none |
| `cc5-selection` | 3.2 | `SELECTION_V5` shadow or on | `cc5-ops` (cycles are claimed under the `selection` lease, 3.2 rule "Order") | `selection_cities`, `selection_cycles`, `selection_snapshots`, `selection_receipts`, `national_ranks`, `founder_records` (the FounderRecord mirror) | founded cities; receipts; founder records |
| `cc5-activity` | 3.4 | `ACTIVITY_POINTS` shadow or on | none | `activity_events`, `activity_evidence`, `activity_totals` | activity events |
| `cc5-managers` | 3.3 | `MANAGER_APPS` on | `cc5-selection`, `cc5-activity` | `manager_applications`, `manager_application_events`, `country_managers` | application events; managers |
| `cc5-metadata` | 3.5 | `METADATA_V5` on | none | `city_metadata_versions`, `city_metadata_active`, `city_metadata_uploads`, `city_metadata_requests`, `city_metadata_request_events`, `city_review_locks` | versions; a launched city's active row; request events |
| `cc5-launch` | 3.6 | `LAUNCH_V5` on | `cc5-ops`, `cc5-metadata` | `city_launches`, `launch_preparations` | launch records |
| `cc5-hourly` | 3.7 | `CC_HOURLY` shadow or on | `cc5-ops` | `hourly_runs`, `hourly_samples`, `hourly_actions`, `hourly_leaves` | every hourly record (no delete, no overwrite, fixed keys); a confirmed action; a paid or claimed leaf |

Every table, column, type, CHECK, UNIQUE, key and index is the doc's word for word; the test reads `schema-and-api.md` and compares
each statement (sections 3.2 to 3.8), so a later edit of either side fails it. In all: 26 tables, 15 named indexes and 47 triggers (88
statements), no `ALTER` of an existing table, no view and no foreign key.

**Why each prerequisite never creates a group whose own switch is at its default.** A prerequisite is listed only where the v5
configuration check already refuses the dependant switch without the prerequisite's switch: `MANAGER_APPS=on` needs `SELECTION_V5=on` and
`ACTIVITY_POINTS=on` (`MANAGER_APPS_WITHOUT_SELECTION`, `MANAGER_APPS_WITHOUT_POINTS`), and `LAUNCH_V5=on` needs `METADATA_V5=on`
(`LAUNCH_V5_WITHOUT_METADATA_V5`). `cc5-ops` has no switch of its own; section 3.8 names the three switches that create it, and those are
exactly the three groups that list it. A test walks every combination of the six switches and asserts it for each combination the check
does not refuse as incompatible.

**Order (section 3.10 step 2).** `CC5_ORDER` is `cc5-identity`, `cc5-ops`, `cc5-selection`, `cc5-activity`, `cc5-managers`,
`cc5-metadata`, `cc5-launch`, `cc5-hourly`. `cc5-ops` sits before `cc5-selection` because the selection job is the first job that takes a
lease. Prerequisites run in this order.

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
// only while the switch counts (its gate in src/v5policy.js), before the first read or write of the group's tables:
try { await ensureCc5Group(env, "cc5-selection"); }
catch (e) { if (e instanceof Cc5SchemaError) return json({ ok: false, error: e.code }, e.status); throw e; } // 503 not_enabled, this feature only
```

- **One step per statement.** Each statement runs on its own; the group's id is recorded in the existing `schema_migrations` table
  (`INSERT OR IGNORE`) only after every statement succeeded. A failure leaves no record, so the next call runs the whole list again;
  every statement is `CREATE ... IF NOT EXISTS` (or a column-guarded `ALTER`), so the statements that already ran are harmless.
- **Prerequisites first.** `ensureCc5Group(env, "cc5-managers")` ensures `cc5-ops`, `cc5-selection` and `cc5-activity` first, in order.
  It resolves to the ids now in place, in order.
- **Two isolates at once.** Both run the same idempotent statements and the record is `INSERT OR IGNORE`: one record per group (tested on
  Node's SQLite and on a local D1).
- **Cached per isolate.** Success is remembered per database object; a second call issues no statement. A failure is forgotten.
- **The error.** `Cc5SchemaError`: `name` "Cc5SchemaError", `status` 503, `code` "not_enabled", `group` (the id asked for), `failed`
  (the group whose step failed: the same one or a prerequisite), `reason` (`unknown_group`, `group_not_built`, `no_database`,
  `registry_invalid`, `statement_failed`, `record_failed`, `prerequisite_failed`), `step` (the statement index; -1 for a `prepare` step),
  `cause`. One log line per failure: `cc5 schema unavailable <group> <failed> <reason> step <n> <D1 message, 120 characters>`; never a row
  value.
- **`groupsForFlags(flags)`** maps switch values (as the gate applies them; trimmed, any letter case) to the groups they need,
  prerequisites included, in `CC5_ORDER`. A value outside a group's list, including a malformed one, needs nothing. With the switches of
  the committed `wrangler.jsonc` it answers an empty list (tested). The census and backup step (section 8) use it to name the groups a
  switch change will create.

**Writing to a kept table.** Every append-only or kept table has a BEFORE INSERT trigger (`<table>_no_overwrite`) that aborts when the new
row collides with a kept row on any unique key (section 4). It fires before SQLite resolves the conflict, so on a kept row:

| Statement | Result |
|---|---|
| plain `INSERT` of a new row | appends |
| plain `INSERT` that collides | aborts with the table's name (instead of "UNIQUE constraint failed") |
| `INSERT ... SELECT ... WHERE NOT EXISTS (...)` (doc rule 4, line 44) | a quiet no-op on a duplicate (0 changes): **the idempotent form to use** |
| `INSERT OR REPLACE`, `REPLACE`, `INSERT OR IGNORE`, `ON CONFLICT DO NOTHING`, `ON CONFLICT DO UPDATE` | abort with the table's name |
| `UPDATE`, `UPDATE OR REPLACE`, `DELETE` | abort with the table's name (where the table forbids them) |

The local D1 reports these as `D1_ERROR: <name>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`, so a writer matches the name. Inside a
D1 batch the abort rolls the whole batch back (tested on both engines).

## 4. Append-only and kept rows

Doc rule 6 (`schema-and-api.md` line 49) asks for triggers that reject UPDATE and DELETE. UPDATE and DELETE triggers alone do not hold:
`INSERT OR REPLACE` and `UPDATE OR REPLACE` delete the conflicting old row **without firing its DELETE triggers** unless
`recursive_triggers` is on, and D1 runs with it off (read on the local D1: `PRAGMA recursive_triggers` = 0; `foreign_keys` = 1). The test
shows the hole on a copy without the guard (REPLACE rewrites a founder record) and its closure with it. The design that holds on D1, used
for every kept row:

- `<table>_no_update` / `_no_delete`: BEFORE UPDATE / BEFORE DELETE, `RAISE(ABORT, '<name>')` (conditional where the row is kept only in
  a state);
- `<table>_no_overwrite`: BEFORE INSERT `WHEN EXISTS (SELECT 1 FROM <table> WHERE <kept> AND (rowid = NEW.rowid OR <each unique key> =
  NEW.<key> ...))`, every primary key, UNIQUE column, UNIQUE constraint and unique index (a partial index with its condition on both
  rows), plus the rowid (an explicit rowid can replace a row too);
- `<table>_..._no_takeover`, where a row is kept only in a state and its keys may change: BEFORE UPDATE `WHEN EXISTS` a different kept row
  on the new key (an `UPDATE OR REPLACE` that moves another row onto it would delete it).

The names the writers see: `founder_record_immutable`, `receipt_immutable`, `city_already_founded`, `manager_application_event_append_only`,
`country_manager_append_only`, `activity_event_append_only`, `metadata_version_append_only`, `metadata_frozen_after_launch`,
`metadata_request_event_append_only`, `launch_record_immutable`, `hourly_run_permanent`, `hourly_sample_permanent`,
`hourly_action_permanent`, `hourly_leaf_permanent` (the first three and `metadata_frozen_after_launch` are the doc's own).

The doc's own trigger statements (`selection_cities_founded_terminal`, `selection_receipts_no_update`, `selection_receipts_no_delete`,
`founder_records_no_update`, `founder_records_no_delete`, `city_metadata_active_frozen_after_launch`) are created word for word.

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
5.20260921.0-alpha (installed with wrangler 4.137.0): the executor module is the Worker, so the real `src/cc5schema.js` and
`src/store.js` run inside the Workers runtime against local D1 databases; temporary, never persisted, `cf: false` so Miniflare fetches
nothing; no account, no remote binding. (2) **Node's SQLite** (`test/helpers/d1.js`, with a batch that runs in one step like D1's). When
workerd cannot start, the workerd half is reported as skipped with the reason and the Node half still runs; on 24 October both ran here.
Both engines report `PRAGMA recursive_triggers` = 0 and `foreign_keys` = 1.

**What the 12 tests show, on both engines** (24 passed, 0 skipped):

| Check | Result |
|---|---|
| The copy | 88 objects loaded; every table has rows |
| Order (3.10 step 2) | `cc5-identity` answers `group_not_built` and touches nothing; the seven groups apply in `CC5_ORDER`, each resolving to itself and its prerequisites; the 88 group statements run exactly once and in order; the seven records land in that order, after every statement of their group |
| Re-run | the same isolate issues no statement at all; a new isolate reads the records and issues no group statement and no write; the copy (every object, every table's hash, every record) is identical afterwards |
| Nothing existing changes | for each of the 56 existing tables (`sqlite_sequence` included): the same columns, row count and sha256 over its sorted rows (each row as SQLite's `quote()` of every column) before and after all seven groups; each of the 88 existing objects byte-identical; `schema_migrations` keeps its rows and gains exactly the seven ids; the only objects added are the 88 group objects and SQLite's automatic indexes of their keys |
| Schema matches the doc | read back from `sqlite_master` and `PRAGMA table_xinfo`, `index_list`, `index_xinfo`: identical to a database built straight from the doc's SQL (section 3, Node's SQLite, independent of `src/cc5schema.js`): 26 tables, every column, type, NOT NULL, default, key, CHECK and index; the doc's 6 triggers word for word; each of the other 41 triggers is a BEFORE trigger on its own table that only `RAISE(ABORT, ...)`s with a name section 4 lists |
| Append-only and kept tables | each of the 14 tables with an overwrite guard (the test asserts the list is complete), with a row in its kept state: UPDATE, DELETE, `INSERT OR REPLACE`, `REPLACE`, upsert (`ON CONFLICT DO UPDATE`), `INSERT OR IGNORE`, `ON CONFLICT DO NOTHING` and `UPDATE OR REPLACE` onto the kept key are refused with the table's name and every row stays byte-identical (112 attempts); the same statements succeed on `activity_totals`, which the doc keeps mutable |
| CHECK, NOT NULL, UNIQUE | read from the doc and walked: each of the 26 CHECK lists refuses a value outside it and accepts each of its 107 values; each of the 4 ranges refuses one past either end and accepts both ends; each of the 211 NOT NULL columns refuses NULL; each of the 45 keys and non-partial unique indexes refuses a second row (UNIQUE, or the table's guard name first); each of the 5 partial unique indexes refuses a second row inside it and accepts one outside |
| Two runners at once | two requests, each racing every group from new isolates (21 runners), plus, on workerd, a runner in Node on the same local D1 (a second runtime): all succeed, each group recorded once, the same objects as one runner in order |
| Failure mid-group | an injected D1 error at `cc5-ops`' second statement (through `cc5-hourly`): `prerequisite_failed`, no record for either; at `cc5-metadata`'s third table: `statement_failed` at that step, no record, the earlier tables kept; at `cc5-launch`'s overwrite guard: its prerequisites recorded, it not; a failing record insert: `record_failed`, no record. The same isolate then retries every group and each completes; the end state equals a clean run's, and every existing table's hash is unchanged |
| Real engine error | a stray `city_metadata_requests` table without the doc's columns makes `cc5-metadata` fail at its index (`no such column`), with no record; once the stray table is dropped the retry completes with the clean run's objects |
| Why the overwrite guard | with `founder_records_no_overwrite` dropped, `INSERT OR REPLACE` rewrites a founder record on both engines (its DELETE trigger never fires); with the guard restored the same statement is refused and the row is unchanged |
| Open item O9 | pinned: the 9 single-column primary keys without NOT NULL accept NULL (section 7) |

**Switches-off parity** (`test/cc5-parity.test.js`, 3 passed). The import graph of `src/index.js`, static and dynamic imports, does not
reach `src/cc5schema.js`. The Worker's real entry points (the default `fetch` and `scheduled`) run 26 visitor requests, 8 signed-in reads
and 5 signed-in writes (a post, a vote, a notices call, a feedback message, a logout), then the cron twice (once at 03:05 UTC, which also
prunes the balance history), against a fake D1 that records every statement: the copy above, with a fixed clock, a seeded random
generator and a fake chain. With the switches as committed in `wrangler.jsonc` (481 statements), with every v5 switch set to its default,
and with no setting at all: no statement names any of the 88 group objects or a `cc5-` id, and the database ends with exactly the objects it
started with (no table, index or trigger added or changed). The committed and the all-defaults runs issue the same statements in the same
order and give the same answers. Even with the six group switches set away from their defaults, no cc5 statement is issued and no table
appears, because nothing in this stage calls the runner.

**Mutation checks** (run by hand on 24 October, not committed): dropping `city_launches`' overwrite guard, recording a group before its
statements, widening the `segment` range to 0-5, adding a group index on `users`, letting the job call `ensureCc5Group`, and changing one
member's row during a migration each made the tests above fail.

**Census observation (pre-existing, not caused by this stage).** The production schema read has no index `streaks_active`. It is declared
inside the migration `2026-09-27-fair-launch` (`src/store.js:199`), but that line was added on 3 October (commit 1c8c047) to a migration
production had already recorded on 27 September, so production never ran it; a recorded id never runs again (the rule O8 exists for). The
copy reproduces it: today's `ensureSchema` adds nothing to it, and no group adds the index. Open item O10.

This is a copy of the production **schema** with synthetic rows; the dry run on a copy of the production **data** (a validated backup,
restored locally) belongs to the backup step (section 8).

## 6. Readings of the design (where it is abbreviated or ambiguous)

The conservative reading is taken each time; no product rule is added. Line numbers are `schema-and-api.md` unless marked §NN (master
section) or `master-v5.txt`.

| # | Doc | Reading |
|---|---|---|
| R1 | rule 3, line 41; "Statement lists below are abbreviated to the definitions", line 216 | Each group is an array of single statements; comments in the doc's SQL are kept out of the stored SQL (they are not part of a definition). |
| R2 | value comments such as `-- 'selection' \| 'hourly' \| 'keeper' \| 'activity'` (line 893), `-- 'chain_launch' \| 'post' ...` (line 548), `carry_reason` (line 806) | A comment listing values is **not** turned into a CHECK. Only the CHECKs the doc writes are created. |
| R3 | `selection_cities_founded_terminal` (line 338); "Founder selected is terminal" (`master-v5.txt` 1228, §21); "reject every ordinary ... deletion" (1238) | The doc's UPDATE trigger, plus: a founded city's row cannot be deleted, replaced or taken over (otherwise DELETE or REPLACE would reopen a founded city). Unfounded rows stay free, REPLACE included. |
| R4 | `selection_receipts_no_update` / `_no_delete` (lines 391-394) | As written: updates allowed until `verifier_digest` is set, never deleted. Because a receipt is never deleted, REPLACE (a delete) is refused for every receipt, and no update may move one receipt onto another's `cycle_id` or `digest`. |
| R5 | `-- append-only triggers ...` (lines 508, 560, 640, 703) and rule 6 (line 49) | "Append-only triggers" means no UPDATE, no DELETE and no overwrite (section 4), for `manager_application_events`, `activity_events`, `city_metadata_versions`, `city_metadata_request_events` and `founder_records`. |
| R6 | `-- triggers: no DELETE; UPDATE only sets ended_at, ended_by and end_reason, once` (line 523) | No DELETE, no REPLACE (including through the one-active-manager partial index), and the one allowed UPDATE is the one that ends the term: it must set `ended_at`, may set `ended_by` and `end_reason`, changes no other column, and is refused once `ended_at` is set. An update that leaves `ended_at` empty is refused. |
| R7 | `city_metadata_active_frozen_after_launch` (line 652); "afterwards nothing here may change" (line 650); §24 "keep identity/economics immutable" (`master-v5.txt` 1410) | The doc's UPDATE trigger, plus: a launched city's active row cannot be deleted, replaced (by city, ticker or mint) or taken over. Before launch the row changes freely, REPLACE included. |
| R8 | 3.6 rules: "A record is written only from a confirmed chain read" (line 780); §24 "permanent uniqueness after launch" (`master-v5.txt` 1398) | `city_launches` is append-only (no UPDATE, DELETE or overwrite on any of its keys: `(cluster, program_id, city_id)`, `mint`, `ticker`, `city_id`). A launch cannot be undone on chain, so its mirror cannot be edited. `launch_preparations` stays mutable. |
| R9 | 3.7 rules: actions confirmed "only after the chain shows the effect" (line 873); "Leaves stay owed until paid or claimed; no expiry and no sweep" (line 877); §16 "idempotent per-coin/per-quote/per-hour records" (`master-v5.txt` 968); §31 "A caller cannot redirect the destination" (1787) and "no ... administrative sweep" (1795) | No hourly record is ever deleted or replaced and its key columns never change (a deleted or replaced keyed record would let an hour or an action run twice). A `confirmed` action is final. A leaf's wallet and amount never change, and `paid` or `claimed` is final. Status and progress columns otherwise change freely (the state machines belong to S42 and S44). |
| R10 | no `REFERENCES` anywhere in sections 3.2 to 3.8 | No foreign key is added. D1 enforces declared foreign keys (`foreign_keys` = 1 on the local D1), so inventing one would change what writes succeed. |
| R11 | "`coin_art` is reused for approved, content-addressed image bytes" (line 617) | `cc5-metadata` does not create `coin_art`: it belongs to `READY_MIGRATION` (`src/coinart-store.js`), and the production schema read has no `coin_art` (the COIN_V2 switches never ran there). Open item O1. |
| R12 | `cc5-ops` "created with the first of SELECTION_V5, CC_HOURLY or LAUNCH_V5" (line 889) against the lease name `'activity'` (line 893) | The creation sentence is followed: `ACTIVITY_POINTS` does not create `cc5-ops`. Open item O2. |
| R13 | derived and mutable tables: `activity_totals` "derived cache, rebuilt at any time" (line 586), `city_review_locks` (line 705; the approval batch deletes its row, line 726), `selection_cycles`, `selection_snapshots`, `national_ranks` (30-day retention, line 463), `manager_applications`, `activity_evidence`, `city_metadata_uploads`, `city_metadata_requests`, `launch_preparations`, `job_leases`, `idempotency_keys` (24-hour expiry) | No trigger: the doc marks none of them, and their rules need updates or deletes. |
| R14 | prerequisites | A prerequisite is listed only where the configuration check already requires the prerequisite's switch (section 2), so "created only when its switch first leaves its default" holds for every group. Reads of another group's tables whose switch is not guaranteed on are open items O3 to O6, not prerequisites. |

## 7. Open items for later stages

| # | For | Item |
|---|---|---|
| O1 | S24, S25 | Approved image bytes go to `coin_art`, which production does not have: the metadata stage calls `ensureReadySchema` (`src/coinart-store.js`) or adds `coin_art` to a later group under a new id. |
| O2 | S20 | If the activity job takes the `'activity'` lease (line 893), it needs `cc5-ops`, which section 3.8 does not create for `ACTIVITY_POINTS`; amend line 889 (and add `cc5-ops` to `cc5-activity`'s prerequisites) or keep the activity job lease-free. |
| O3 | S17 | Selection reads `city_assignments` and `users.signup_completed_at` (3.2 "Candidates", line 447), which are `cc5-identity`'s; `SELECTION_V5` does not require `WALLET_ONLY` in the configuration check. Either add that requirement (then `cc5-identity` becomes a prerequisite of `cc5-selection`) or define the candidate source without it. |
| O4 | S24, S26, S61 | `founder_records` (the FounderRecord mirror) is created by `cc5-selection` only. `FOUNDER_RECORD_CHAIN` has no group, and `METADATA_V5` and `LAUNCH_V5` do not require `SELECTION_V5`. Until the FounderRecord interface reads the chain (it answers `founder_record_unavailable` until S61, implementation-report S24), the metadata and launch stages must not read `founder_records` unless `cc5-selection` is recorded. |
| O5 | S26 | The launch batch appends the `launch:<city>` activity event (line 782), but `LAUNCH_V5` does not require `ACTIVITY_POINTS`. `cc5-launch` therefore does not require `cc5-activity`; the launch batch appends the event only when `cc5-activity` is recorded, and the activity backfill (3.4, line 607; §23 "A confirmed existing city launch can receive its one-time award") covers a later switch-on. |
| O6 | S21, S22 | The manager check "confirmed launch" (line 526) reads `city_launches` or `lp_coins`; `MANAGER_APPS` does not require `LAUNCH_V5`, so it reads `city_launches` only when `cc5-launch` is recorded (or reads the `launch:<city>` activity event). |
| O7 | every writer | A kept table takes a plain INSERT or a guarded `INSERT ... SELECT ... WHERE NOT EXISTS`; any conflict clause on a kept row aborts (section 3). |
| O8 | every later change | A recorded group never runs again. A change to a group's statements ships under a new id (the pattern of `APPROVED_MIGRATION` in `src/coinart-store.js`), never by editing a recorded list. |
| O9 | every writer; a later doc revision | Nine single-column primary keys in section 3 have no NOT NULL: `selection_cities.city_id`, `founder_records.city_id`, `city_metadata_active.city_id`, `city_review_locks.city_id`, `launch_preparations.id`, `hourly_actions.action_key`, `job_leases.name` (TEXT: SQLite's legacy rule, on D1 too, accepts NULL, and NULLs never collide) and `selection_receipts.cycle_id`, `activity_totals.user_id` (INTEGER PRIMARY KEY: NULL is given the next rowid). The text is kept word for word (R1), so writers always bind the key; on an append-only table a NULL-key row could never be removed. Adding NOT NULL means a new table definition under a new id (O8). Pinned by `test/cc5-d1copy.test.js`. |
| O10 | S16, census | `streaks_active` is missing in production (section 5): `src/store.js` declares it inside the already-recorded `2026-09-27-fair-launch` migration. The streak update runs without it until a later change ships the index under a new migration id, or until `LEGACY_SEATS=frozen` stops streak updates (3.9). Not an S08 change. |

## 8. Still to do in S08

- **Census** (3.10 step 3, §07 acceptance, D08): a script that records counts and hashes only, never member data: duplicate wallets
  (must be 0), users by migration case, non-wallet sessions, seats by status, which history tables exist, and before and after counts and
  digests of wallets, profiles, posts, locations, founder records, coins and monetary rows. Production access is external E9.
- **Backup step before each migration** (3.10 step 1, §07 "Take/validate backups before migration; dry-run on a copy", `master-v5.txt`
  477): before a switch change that `groupsForFlags` says creates a group, a validated backup and a dry run of that group on a restored
  copy, compared by the census. Run by the credential holder (E9); nothing in this repository runs against production.
- ~~A committed, repeatable D1-copy harness for the checks of section 5~~: done (`test/cc5-d1copy.test.js`, `test/cc5-parity.test.js`,
  section 5). The census can reuse its row hash (`tableHash` in `test/helpers/cc5-d1copy-worker.js`: count and sha256 per table, never a
  row).

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
