# Citycoin.dev v5: schema migrations (stage S08)

Master change order v5, sections 07 (BR-05), 16, 17 (WP-01), 20 to 32 and 37. Design: `schema-and-api.md` section 3 (sections 3.2 to 3.10)
and section 5. Plan: `implementation-report.md` stage S08 and rows A14, B14 and D08. This file is the stage record; the implementation
report is updated by the release step.

**Status on 24 October 2026: nothing here is applied or called.** Local branch `cc/s08` only (not pushed, not merged, not deployed). No
route, job or `src/index.js` path imports the new module, so the Worker issues exactly the D1 statements it issues today, whatever the
switches say, and the built `public/` does not change. No production or remote database was read or written for this work. Live facts
at the time: 5 members, 0 seats, 0 open windows, no city coin listed.

## 1. What this part of S08 built

| File | What it is |
|---|---|
| `src/cc5schema.js` | The seven statement lists of `schema-and-api.md` sections 3.2 to 3.8 (`cc5-ops`, `cc5-selection`, `cc5-activity`, `cc5-managers`, `cc5-metadata`, `cc5-launch`, `cc5-hourly`), the order of section 3.10 step 2 with a reserved first slot for `cc5-identity`, the pure helper `groupsForFlags(flags)`, the runner `ensureCc5Group(envOrDb, id)` and its named error `Cc5SchemaError` |
| `test/cc5-schema.test.js` | 27 tests on Node's SQLite (the engine D1 runs): the doc parity, the switch mapping, the runner, every append-only and conditional trigger, the CHECK constraints and partial indexes, and the guard that nothing in the Worker or the pages calls the runner yet |

The census script, the backup step and a committed, repeatable D1-copy harness are the rest of S08 (section 8).

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

`test/cc5-schema.test.js` runs on Node's SQLite (`node --test test/cc5-schema.test.js`: 27 passed). The design was also run on a **local
D1** (workerd, through wrangler 4.137.0 `getPlatformProxy`, a throwaway database in a temporary folder with a placeholder database id and
no remote binding) loaded with the production schema read on 24 October 2026 (schema only, no rows, 88 objects). With the real
`ensureCc5Group`: all seven groups created (each resolving to itself and its prerequisites), every one of the 88 production objects
unchanged, exactly the 88 new objects added, seven records, a second isolate changing nothing, two racing isolates on a fresh D1
recording each group once; and on the kept tables every REPLACE, upsert, `INSERT OR IGNORE`, UPDATE, `UPDATE OR REPLACE` and DELETE
attempt refused with its name and the row unchanged, a batch containing one rolled back whole, a guarded `INSERT ... WHERE NOT EXISTS` a
quiet no-op, unfounded and unlaunched rows still changing, and, with the overwrite guard dropped, D1 letting REPLACE rewrite a founder
record. 55 checks, 55 passed. This is a copy of the production **schema**; the dry run on a copy of the production **data** (backup
restored locally) belongs to the backup step (section 8).

Observation for the census: the production schema read of 24 October has no index `streaks_active`, which `src/store.js:199` (`SCHEMA`)
declares; on the local copy, today's `ensureSchema` added it before any group ran. Not caused by this stage; worth confirming in the
count-only census.

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

## 8. Still to do in S08

- **Census** (3.10 step 3, §07 acceptance, D08): a script that records counts and hashes only, never member data: duplicate wallets
  (must be 0), users by migration case, non-wallet sessions, seats by status, which history tables exist, and before and after counts and
  digests of wallets, profiles, posts, locations, founder records, coins and monetary rows. Production access is external E9.
- **Backup step before each migration** (3.10 step 1, §07 "Take/validate backups before migration; dry-run on a copy", `master-v5.txt`
  477): before a switch change that `groupsForFlags` says creates a group, a validated backup and a dry run of that group on a restored
  copy, compared by the census. Run by the credential holder (E9); nothing in this repository runs against production.
- **A committed, repeatable D1-copy harness** for the checks of section 5.

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
