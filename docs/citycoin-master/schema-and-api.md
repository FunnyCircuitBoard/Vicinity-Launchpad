# Citycoin.dev v5: schema and API design

> **DESIGN. NOT BUILT.** Nothing in this file exists in the live site at main `4aa408e` or in the draft program at `ec148c2`.
> No table, column, trigger, route, switch or program instruction described below has been created, migrated, deployed,
> audited or approved by an owner review event. The only pieces that exist as code are the policy document
> (`docs/citycoin-master/policy.json`), its frozen mirror `src/masterpolicy.js` (imported by no live module) and
> `test/masterpolicy.test.js`.

Master change order v5 (23 Oct 2026), sections 16, 20 to 31 and 43, with the identity, metadata and launch sections they depend
on (18, 19, 24 to 26, 36, 37). Prepared 24 Oct 2026, and updated the same day for owner amendment 01 (section 2.4): the main token
is a new, owner-supplied mint read from the configuration key `MAIN_TOKEN_MINT` after on-chain verification, `null` until then;
`$VICINITY` is a legacy token; the official X and Telegram links are configuration keys too.

## 0. How to read this

- **"Today"** statements describe the live site at `4aa408e` and cite `path:line` in the worktree, or name a read-only command
  run on 24 Oct 2026. `curve:` paths are the draft program checkout `vcurve` at `ec148c2`, relative to its `solana/` folder.
- **"DESIGN"** statements are proposals. Every DESIGN item is marked with the master section it implements.
- Live facts checked for this file (4 public GETs, 1 read-only RPC call, 24 Oct 2026):
  - `GET https://vicinity.city/api/seats`: 0 seats, 0 open windows.
  - `GET https://vicinity.city/api/policy`: policy version 6, effective 2026-10-16, `founder.qualifyingDays` 7.
  - `GET https://vicinity.city/api/coins`: 0 coin designs.
  - `GET https://vicinity.city/official-coins.csv`: 200 with an empty body (no city coin recorded).
  - `getMultipleAccounts` (finalized, slot 460699237): the `$VICINITY` mint `2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray` (the
    main token when this read was made; a legacy token since amendment 01) is a classic SPL Token mint with 6 decimals and no mint
    or freeze authority; USDC has both authorities; WSOL has 9 decimals and
    neither; the Squads multisig `6v8hwKYSAWXXx6ZGGmvbg87n8eVy9MAgNruFgVqRFjYV` has threshold 2 and a time lock of 0 seconds.
- Inputs: the reconciliation files R1 (identity), R2 (selection and roles), R3 (metadata and launch), R4 (programs and money)
  and R5 (brand, domain and UI). Where they proposed different names for the same thing, section 2.3 records the one chosen here.

## 1. Design rules for every change below

1. **Additive only.** New tables and nullable columns. No existing column is dropped, renamed or rewritten in this release.
   History tables (seats, windows, elections, streaks, coin review stages) stay readable and stop being written. (§07 BR-05,
   §17 WP-01: "Retain historical records for audit only".)
2. **Lazy, per-switch migrations.** Each group below is created the first time its switch leaves its default, following the
   existing pattern of `SIGNUP_MIGRATION` and `ensureSignupSchema` (src/store.js:573, :615): a failure breaks only the new feature,
   and with every switch at its default no new statement touches the database.
3. **Statement lists, not split SQL.** Today's runner splits migration text on every semicolon (src/store.js:541, rule repeated
   at src/store.js:568 and :989). Triggers contain semicolons inside `BEGIN ... END`, so every v5 migration is an array of
   statements (the shape `READY_MIGRATION.tables` already uses, src/coinart-store.js:22-75), recorded in `schema_migrations`.
4. **One D1 batch per atomic step.** A D1 batch commits or fails as one transaction (the property the users-table rebuild relies
   on, src/store.js:846-857). Every state transition below that must be atomic is written as one batch of guarded statements
   (`INSERT ... SELECT ... WHERE`, `UPDATE ... WHERE status = ?`), never as read-then-write.
5. **Uniqueness lives in the database** (and, for founders, launches, tickers and review locks, on chain), not only in route
   code. (§18 "Enforce a database unique index"; §21 "Enforce uniqueness in database and chain state".)
6. **Append-only where the master says permanent or append-only.** `founder_records`, `activity_events`,
   `manager_application_events`, `city_metadata_versions` and the request-event tables reject `UPDATE` and `DELETE` with
   triggers. Triggers must be confirmed on a D1 copy in the migration test (SQLite supports them; this design has not run them on
   D1).
7. **Raw token amounts are TEXT.** Base-unit amounts are stored as decimal strings and handled as BigInt. SQLite integers are
   signed 64-bit and JavaScript numbers are exact only to 2^53; u64 amounts and fee sums can exceed both.
8. **Times** are ISO 8601 UTC text from `new Date().toISOString()`, as every existing table stores them (for example
   `users.created_at`, src/store.js:66). Slots and epochs are INTEGER.
9. **Every new row that applies a rule stores `policy_version`** (`citycoin-master-v5`). On chain, the 32-byte field is
   `sha256(utf8("citycoin-master-v5"))` (DESIGN, §16 "mirror critical authorization/economic fields on chain").
10. **No secrets, coordinates, hand-off codes or e-mail addresses** in any new table except the hashed forms named below.
    (§16 Public policy; §19 step 3; §06 BR-04 Analytics.)

## 2. The policy and the switches

### 2.1 One versioned policy (§16)

- `docs/citycoin-master/policy.json` holds every master value with its master section (`master_sections`) and the notes on
  what the draft program and the live site do differently (`code_verification`).
- `src/masterpolicy.js` exports the same document deeply frozen (`MASTER_POLICY`), `validatePolicy`, and the pure helpers
  `selectionEpoch`, `selectionBoundary`, `nextSelectionBoundary`, `tradeFeeSplit` and `activityTotals`, plus, for amendment 01,
  `mainTokenConfig`, `officialLinks`, `validateDeploymentConfig` and `MAIN_TOKEN_FEATURES` (section 2.4). The test keeps the two
  files identical and checks that no live module imports the helper module.
- DESIGN: when the first v5 switch is built, `GET /api/policy` keeps its current answer (src/index.js:426-428) and adds a
  `master` key (the public policy document, section 4.9). The SDK and jobs import the same JSON.
- DESIGN: `policy_digest` = sha256 of the canonical JSON (sorted keys, no spaces) of the `policy` object. It is published on
  `/api/policy/master` and recorded in the release manifest, so a reader can tell whether two deployments run the same policy.

### 2.2 Switches and configuration acceptance (§16 "Configuration acceptance")

None of these switches exists at `4aa408e` (src/flags.js:1-116 lists today's). Each default is today's behavior. They are
read like today's switches (exact value, trimmed, case-insensitive) and validated together at the first request and at the
start of each job run by `validatePolicy` (src/masterpolicy.js), which returns named errors and keeps every dependent feature
off while any error exists.

| Switch | Values (default first) | Turns on | Requires (named error when missing) |
|---|---|---|---|
| `WALLET_ONLY` | off, on | wallet-only sign-in and registration (§18, §19) | `SITE_ORIGINS`, `SITE_ORIGIN` (`MISSING_SITE_ORIGINS`, `MISSING_SITE_ORIGIN`) |
| `LEGACY_LINK` | off, on | the time-boxed link window for Google- or e-mail-only accounts (§05) | `WALLET_ONLY=on` (`LEGACY_LINK_WITHOUT_WALLET_ONLY`), `LEGACY_LINK_UNTIL` (`MISSING_LEGACY_LINK_UNTIL`) |
| `LEGACY_SEATS` | on, frozen | "frozen": every seat, squad, endorsement, objection, resign and election writer answers 410 (§15) | none |
| `SELECTION_V5` | off, shadow, on | the six-hour snapshot engine; "shadow" writes dry-run cycles only (§20, §21) | shadow: archive providers A and B (`MISSING_ARCHIVE_PROVIDER_A/B`) and the configured main-token mint (`MAIN_TOKEN_MINT_MISSING`, amendment 01); on: also `FOUNDER_RECORD_CHAIN=on` (`SELECTION_ON_WITHOUT_CHAIN_RECORD`), `LEGACY_SEATS=frozen` (`SELECTION_ON_WITH_LEGACY_SEATS`), publisher and verifier keys (`MISSING_SELECTION_PUBLISHER`, `MISSING_SELECTION_VERIFIER`) |
| `FOUNDER_RECORD_CHAIN` | off, on | reads and mirrors on-chain FounderRecords (§21) | `program_id`, `cluster` |
| `ACTIVITY_POINTS` | off, shadow, on | the activity ledger (§23) | none |
| `MANAGER_APPS` | off, on | country-manager applications and the owner inbox (§22) | `SELECTION_V5=on`, `ACTIVITY_POINTS=on` (`MANAGER_APPS_WITHOUT_SELECTION`, `MANAGER_APPS_WITHOUT_POINTS`), and `MAIN_TOKEN_MINT` for the national rank (`MAIN_TOKEN_MINT_MISSING`) |
| `METADATA_V5` | off, on | protected defaults, founder requests, owner metadata inbox (§24, §25) | in production: `FOUNDER_RECORD_CHAIN=on` (`METADATA_V5_PRODUCTION_WITHOUT_CHAIN`), `metadata_admin`, `program_id`, `cluster` |
| `LAUNCH_V5` | off, on | self-service launch on the custom program (§26) | `LEGACY_LAUNCH=off` (`LAUNCH_V5_WITH_LEGACY_LAUNCH`), `FOUNDER_RECORD_CHAIN=on`, `METADATA_V5=on`, `program_id`, `cluster`, `treasury`, `metadata_admin`, `governance_vault`, `guardian`, at least one enabled quote config whose chain facts pass (`NO_ENABLED_QUOTE_CONFIG`, `QUOTE_*`); an enabled `main_token` quote also needs `MAIN_TOKEN_MINT` and chain facts keyed by it (`MAIN_TOKEN_MINT_MISSING`, `QUOTE_FACTS_MISSING`, amendment 01) |
| `LEGACY_LAUNCH` | on, off | "off": the website builds no legacy approval, batch or launch (§27, §37 step 9) | none |
| `CC_TRADING` | off, on | buys and sells on the custom curve and pool (§27, §28) | `program_id`, `cluster`, enabled quote configs; an enabled `main_token` quote also needs `MAIN_TOKEN_MINT` and chain facts keyed by it (`MAIN_TOKEN_MINT_MISSING`, `QUOTE_FACTS_MISSING`) |
| `CC_HOURLY` | off, shadow, on | hourly processing; "shadow" computes and publishes evidence, sends nothing (§30, §31) | shadow: `program_id`, `cluster`; on: also `treasury`, `keeper`, `hourly_verifier_a`, `hourly_verifier_b` |
| `HOST_REDIRECT` | off, on | 308 redirects from old public GET/HEAD pages (§04) | `SITE_ORIGIN` equal to `https://citycoin.dev` (`HOST_REDIRECT_TARGET_NOT_CANONICAL`) |
| `PUBLIC_V5` | off, on | `/api/status`, `/api/policy/master`, the `master` key and the public pages (§16, §35) | none |
| `MAIN_TOKEN_V5` | off, on | amendment 01: every main-token consumer (token page, holder list, balance sampling, purchase links, Buy panel default, official list) reads the verified `MAIN_TOKEN_MINT`; `$VICINITY` is shown as legacy; the footer and link checker use the configured official links | `MAIN_TOKEN_MINT` (`MAIN_TOKEN_MINT_MISSING`) |

Further named errors from `validatePolicy`: `ENVIRONMENT_UNSET` (a changed switch without an environment), `FIXTURE_IN_PRODUCTION`
(local fixtures are visibly test-only), `CLUSTER_NOT_MAINNET_IN_PRODUCTION`, `MAINNET_MONEY_FLAG_OUTSIDE_PRODUCTION`,
`INPUT_NOT_A_PUBLIC_KEY`, `TREASURY_NOT_DEDICATED`, `ROLE_KEYS_NOT_DISTINCT`, `SITE_ORIGINS_INVALID`, `SITE_ORIGIN_NOT_ALLOWED`,
`LEGACY_LINK_UNTIL_INVALID`, `FLAG_UNKNOWN`, `FLAG_VALUE_INVALID`, `FLAG_MISSING`, `INPUT_UNKNOWN`, and for drift from the master:
`POLICY_VERSION_MISMATCH`, `POLICY_VALUE_MISMATCH`, `POLICY_KEY_UNKNOWN`, `FEE_SPLIT_SUM`, `BUYBACK_THROUGHPUT`,
`PLATFORM_FEE_NOT_ZERO`, `SELECTION_CYCLE`, `ACTIVITY_CAPS_SUM`, `CURVE_SUPPLY_SUM`, `QUOTE_UNITS`. Amendment 01 adds
`MAIN_TOKEN_MINT_MISSING`, `MAIN_TOKEN_MINT_INVALID`, `MAIN_TOKEN_IS_LEGACY_MINT`, `OFFICIAL_X_URL_INVALID`,
`OFFICIAL_TELEGRAM_URL_INVALID` and `LEGACY_SOCIAL_LINK_AS_OFFICIAL` (section 2.4). A passing validation never means
a feature is deployed or released: the release gates of §37 are evidence, recorded in the release manifest, not configuration.

Secret names (never values) the validation checks for presence: `SELECTION_ARCHIVE_URL_A`, `SELECTION_ARCHIVE_URL_B`. The hourly
verifiers and the selection verifier run in separately credentialed services; the website holds none of their credentials (§31,
§36).

### 2.3 Names chosen where the reconciliation files differed

| Thing | Chosen here | Other proposals |
|---|---|---|
| Self-service launch switch | `LAUNCH_V5` | R4 `CC_LAUNCH` (same switch) |
| Completed-signup time | `users.signup_completed_at` (the master's term, §16 Tie-break, §20) | R1 `users.registered_at` |
| Hourly job-key table | `hourly_actions` | R4 `cc_jobs` |
| Metadata tables | new `city_metadata_*` tables | R3: adapt `coin_requests` in place (its CHECK constraint, src/coinreview.js:144-145, cannot be altered without a table rebuild) |
| Selection verifier error | `MISSING_SELECTION_VERIFIER` | R2 `VERIFIER_KEY_UNSET` |

### 2.4 Main token and official links (owner amendment 01, 24 Oct 2026)

Full text, consumer list and verification procedure: `amendment-01-new-main-token.md`.

**Configuration keys.** Each value lives in one Worker setting and is read only through the helpers in `src/masterpolicy.js`
(wired into the Worker as `mainMint(env)` and `officialLinks(env)` when the code stage is built). The policy document holds `null`
for all three and never holds the values; `deployment.inputs` lists the three keys, `null`.

| Key | Holds | Value today | Shape rule | Named errors |
|---|---|---|---|---|
| `MAIN_TOKEN_MINT` | the main-token mint | **unset**: the owner has not supplied it | base58 32-byte public key, not the all-zero default key; not a `policy.legacy_tokens` mint | `MAIN_TOKEN_MINT_INVALID`, `MAIN_TOKEN_IS_LEGACY_MINT`; `MAIN_TOKEN_MINT_MISSING` when a feature that needs it is on |
| `OFFICIAL_X_URL` | the official X page | **unset** | `https://x.com/<handle>`, 1 to 15 characters of `A-Za-z0-9_`; `twitter.com` accepted and normalized to `x.com` | `OFFICIAL_X_URL_INVALID`, `LEGACY_SOCIAL_LINK_AS_OFFICIAL` |
| `OFFICIAL_TELEGRAM_URL` | the official Telegram channel or group | **unset** | `https://t.me/<name>`, 5 to 32 characters of `A-Za-z0-9_` | `OFFICIAL_TELEGRAM_URL_INVALID` |

Features that need `MAIN_TOKEN_MINT`: founder selection (`SELECTION_V5` shadow or on), manager ranking (`MANAGER_APPS=on`), the token
page and purchase links (`MAIN_TOKEN_V5=on`), and the main-token quote (`main_token` in `enabled_quote_configs` with `LAUNCH_V5` or
`CC_TRADING` on). Unset values are accepted while those features are off; an unset link is simply not shown. A set value is always
shape-checked. `validateDeploymentConfig(env, features)` applies the same rules to a Worker environment and a feature list, and
also refuses a malformed feature list (`FEATURE_UNKNOWN`, `FEATURES_INVALID`). Shape is not verification: nobody sets a value
before its verification record exists.

**What reads the configured mint.** Founder selection (`founder_selection.balance_measure`, the candidate vectors and receipts in
section 3.2), the tie-break raw balance (`tie_break.balance_mint`), the national rank (`country_manager.national_rank_balance`,
table `national_ranks`), balance sampling and the holder list, the token page, purchase links, and the main-token quote config.
Hourly holder distribution (section 3.7) is per city coin and does not read it.

**Balance history.** Today's `balance_samples` table and `day:<d>` blobs (src/store.js:184-191; src/ledger.js:61-70) carry no mint
and hold only `$VICINITY`. DESIGN: an additive `mint` column on `balance_samples` and mint-keyed blobs (`day:<mint>:<d>`), created
the first time `MAIN_TOKEN_V5` leaves "off"; the existing rows are the legacy `$VICINITY` series, labeled historical. Two mints are
never summed into one day. Selection snapshots (section 3.2) read the chain at the cutoff slot and never these samples.

**Public policy fields** (on `/api/policy/master` and the `master` key, section 4.9; null until verified):

```json
{
  "main_token": { "mint": null, "config_key": "MAIN_TOKEN_MINT", "verified": null, "purchase_links": "hidden" },
  "legacy_tokens": [{ "symbol": "$VICINITY", "mint": "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray", "role": "legacy, history only", "automatic_swap_or_migration": false }],
  "official_links": { "x_url": null, "telegram_url": null, "legacy": { "x_url": "https://x.com/VicinityCitySOL" } }
}
```

When a value is configured and verified, the answer fills `main_token.mint` with it and `main_token.verified` with
`{ slot, verifiedAt, decimals, mintAuthority, freezeAuthority, name, symbol }` from the verification record, and fills
`official_links.x_url` and `telegram_url` with the normalized links. `null` always means "not configured, not shown", never zero
or a placeholder. `purchase_links` reads "hidden" until a live quote finds a route for the configured mint.

## 3. D1 schema additions (DESIGN)

Conventions: `city_id` is TEXT, as today (`users.home_city`, src/store.js:60; `coin_versions.city_id`, src/coinart-store.js:36);
on chain it is the u64 GeoNames id. Wallets are base58 text of 32 bytes, validated before any write. Statement lists below are
abbreviated to the definitions; each group also records its migration id in `schema_migrations`.

### 3.1 Identity, registration and location (§16 Identity, §18, §19, §05)

Today: `users.wallet` is `UNIQUE` (src/store.js:55) and becomes nullable-UNIQUE after the onboarding rebuild
(src/store.js:840-890); sessions are found by token hash with no host check (src/auth.js:125-135); cookies are host-only
`HttpOnly; Secure; SameSite=Lax` (src/http.js:64-66); writes need `Origin` host = request host (src/http.js:73-77); a signed
message is valid 10 minutes (src/signed.js:9) and `GET /api/message` stores no nonce (src/index.js:501-502); single use is a
message digest in `used_nonces` (src/signed.js:80).

Migration id `cc5-identity`, created when `WALLET_ONLY` first leaves "off". It runs only after `ONBOARD_MIGRATION` has run,
because that rebuild re-creates only three indexes and no trigger on `users` (src/store.js:858-871, :874-890).

```sql
ALTER TABLE users ADD COLUMN signup_completed_at TEXT;   -- set once, by the registration batch
ALTER TABLE users ADD COLUMN loc_verified_at TEXT;
ALTER TABLE users ADD COLUMN loc_policy TEXT;            -- 'citycoin-master-v5' for new registrations
ALTER TABLE users ADD COLUMN loc_method TEXT;            -- 'inside' | 'nearest' | 'legacy'
ALTER TABLE users ADD COLUMN legacy_state TEXT;          -- 'wallet_linked' | 'legacy_unlinked' | 'linked_in_window' | 'closed_unresolved'
CREATE UNIQUE INDEX IF NOT EXISTS users_wallet_unique ON users (wallet) WHERE wallet IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS users_signup_completed_once BEFORE UPDATE OF signup_completed_at ON users
  WHEN OLD.signup_completed_at IS NOT NULL AND NEW.signup_completed_at IS NOT OLD.signup_completed_at
  BEGIN SELECT RAISE(ABORT, 'signup_completed_at_immutable'); END;

ALTER TABLE sessions ADD COLUMN host TEXT;               -- the canonical host the session was issued on; NULL = vicinity.city
ALTER TABLE sessions ADD COLUMN auth TEXT;               -- 'wallet' | 'legacy_link'

CREATE TABLE IF NOT EXISTS auth_challenges (
  id           TEXT PRIMARY KEY,                         -- 128-bit random id returned to the client
  nonce_hash   TEXT NOT NULL UNIQUE,                     -- sha256(nonce); the nonce itself exists only inside the message
  purpose      TEXT NOT NULL CHECK (purpose IN ('login','register','reprove','legacy_link')),
  host         TEXT NOT NULL,                            -- from SITE_ORIGINS, never from the Host header
  cluster      TEXT NOT NULL,
  wallet       TEXT NOT NULL,
  ref          TEXT,                                     -- signups.id (register) or sessions.id (reprove, legacy_link)
  message_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,                            -- created_at + 120 s (policy identity.challenge_seconds)
  used_at      TEXT,
  used_by      TEXT                                      -- hash of the session id the consumption created
);
CREATE INDEX IF NOT EXISTS auth_challenges_expires ON auth_challenges (expires_at);

ALTER TABLE handoffs ADD COLUMN bind TEXT;               -- register hand-off: JSON {city_id, country, policy_version}, never coordinates

CREATE TABLE IF NOT EXISTS city_assignments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  wallet         TEXT NOT NULL,
  city_id        TEXT NOT NULL,
  country        TEXT NOT NULL,
  assigned_at    TEXT NOT NULL,
  ended_at       TEXT,                                   -- never set by relocation (none in this release); only an audited owner correction
  source         TEXT NOT NULL CHECK (source IN ('registration','legacy_backfill','legacy_link','first_location')),
  policy_version TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS city_assignments_current ON city_assignments (user_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS city_assignments_wallet_current ON city_assignments (wallet) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS city_assignments_city ON city_assignments (city_id, assigned_at);
CREATE TRIGGER IF NOT EXISTS city_assignments_no_delete BEFORE DELETE ON city_assignments
  BEGIN SELECT RAISE(ABORT, 'city_assignment_append_only'); END;
CREATE TRIGGER IF NOT EXISTS city_assignments_end_once BEFORE UPDATE ON city_assignments
  WHEN OLD.ended_at IS NOT NULL OR NEW.user_id IS NOT OLD.user_id OR NEW.wallet IS NOT OLD.wallet OR NEW.city_id IS NOT OLD.city_id
    OR NEW.assigned_at IS NOT OLD.assigned_at
  BEGIN SELECT RAISE(ABORT, 'city_assignment_append_only'); END;
```

Rules:

- **Unique wallet (§18).** One account per canonical wallet: the existing column constraint plus the named partial index. Base58
  of 32 bytes is one-to-one, so text equality is key equality (R1). Registration inserts with `ON CONFLICT(wallet) DO NOTHING`
  in the same batch that consumes the challenge, then opens a session for `users WHERE wallet = ?`: a lost race returns the
  existing account and never changes its city (§18 "Concurrent first signups upsert/return the same account").
- **Challenge consumption (§18 two-minute, one-use).** One batch: `UPDATE auth_challenges SET used_at = ?, used_by = ? WHERE id = ?
  AND used_at IS NULL AND expires_at > ? AND purpose = ? AND wallet = ? AND host = ?`, then `INSERT INTO sessions ... SELECT ...
  WHERE EXISTS (SELECT 1 FROM auth_challenges WHERE id = ? AND used_by = ?)`. A failed or expired challenge creates nothing.
  This replaces the fail-open digest check for v5 purposes.
- **Host binding (§05, D04).** `getSession` refuses a row whose `host` differs from the request host (NULL counts as
  `vicinity.city`). Copied cookies fail on the other host.
- **Location once (§19).** Raw coordinates are never stored. `loc_verified_at`, `loc_policy` and `loc_method` record the
  privacy-safe evidence. `POST /api/home` writes only when `users.home_city IS NULL` (never located), once.
- **Backfill** (count-checked on a database copy first, D08):
  - `signup_completed_at` for rows with `wallet IS NOT NULL AND home_city IS NOT NULL AND provider != 'testlab'`:
    `MAX(created_at, COALESCE(wallet_at, created_at), COALESCE(home_at, created_at))` (columns at src/store.js:63, :66, :942).
    ISO strings of one format compare correctly as text; the migration test asserts that every value matches the
    `toISOString()` format before relying on it. This is an upper bound of the true completion time and is published as such.
  - `loc_method = 'legacy'`, `loc_verified_at = home_at`, `loc_policy = 'pre-v5'` where `home_city` is set.
  - `legacy_state` by R1's census predicates (wallet and city: `wallet_linked`; wallet without a city: `wallet_linked` plus a
    location-once prompt; `provider IN ('google','email')` without a wallet: `legacy_unlinked`). Ambiguous rows are quarantined,
    never merged (§07, §18).
  - `city_assignments`: one `legacy_backfill` row per user with a wallet and a city, `assigned_at = signup_completed_at`.
- **Retention.** `auth_challenges` rows are deleted by the existing 10-minute cleanup step (src/jobs.js:64-76) once expired.

### 3.2 Founder selection, snapshots, receipts and the FounderRecord mirror (§16, §20, §21)

Today: the founder system is the seat and stake-ladder model of policy v6 (src/policy.js:20-71; live `GET /api/policy` answered
version 6); seat statuses include `grace` and are not permanent (src/store.js:264-275); the live site has 0 seats and 0 windows
(`GET /api/seats`). Neither program has a FounderRecord, and the draft has `transfer_founder`
(curve:programs/vicinity-curve/src/instructions/transfer_founder.rs:1-4).

Migration id `cc5-selection`, created when `SELECTION_V5` first leaves "off".

```sql
CREATE TABLE IF NOT EXISTS selection_cities (
  city_id       TEXT PRIMARY KEY,
  country       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('awaiting','processing','founded')),
  opened_at     TEXT NOT NULL,          -- first city_assignments row, or the moment SELECTION_V5 first left "off"
  first_cycle   INTEGER NOT NULL,       -- selectionEpoch(opened_at) + 1: the next boundary, no holding wait
  founded_cycle INTEGER,
  updated_at    TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS selection_cities_founded_terminal BEFORE UPDATE ON selection_cities
  WHEN OLD.status = 'founded' BEGIN SELECT RAISE(ABORT, 'city_already_founded'); END;

CREATE TABLE IF NOT EXISTS selection_cycles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  mode              TEXT NOT NULL CHECK (mode IN ('shadow','live')),
  city_id           TEXT NOT NULL,
  cycle             INTEGER NOT NULL,   -- epoch = floor(boundary / 21600)
  boundary_at       TEXT NOT NULL,      -- 00:00, 06:00, 12:00 or 18:00 UTC
  status            TEXT NOT NULL CHECK (status IN ('due','processing','data_error','empty','selected')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  error_code        TEXT,               -- e.g. supply_mismatch, provider_disagreement, slot_disagreement, verifier_disagreement
  claimed_until     TEXT,               -- per-cycle claim (D10): two runs or two hosts never work one cycle
  claim_token       TEXT,
  cutoff_slot       INTEGER,
  cutoff_block_time TEXT,
  next_slot         INTEGER,
  next_block_time   TEXT,
  candidate_count   INTEGER,
  digest            TEXT,               -- sha256 of the canonical receipt
  winner_wallet     TEXT,
  policy_version    TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (mode, city_id, cycle)
);
CREATE INDEX IF NOT EXISTS selection_cycles_due ON selection_cycles (mode, status, boundary_at);
CREATE UNIQUE INDEX IF NOT EXISTS selection_cycles_one_winner ON selection_cycles (mode, city_id) WHERE status = 'selected';

CREATE TABLE IF NOT EXISTS selection_snapshots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id             INTEGER NOT NULL,
  attempt              INTEGER NOT NULL,
  provider             TEXT NOT NULL CHECK (provider IN ('A','B','verifier')),
  cutoff_slot          INTEGER,
  supply_raw           TEXT,            -- mint supply at the cutoff slot
  sum_all_accounts_raw TEXT,            -- sum over every token account of the mint at that slot; must equal supply_raw
  candidate_vector_hash TEXT,           -- sha256 of the sorted (wallet, raw) list for this city's candidates
  blob_key             TEXT,            -- full input in the existing chunked blobs table (src/store.js:178); verifier and owner only
  status               TEXT NOT NULL CHECK (status IN ('ok','incomplete','supply_mismatch','error')),
  read_at              TEXT NOT NULL,
  UNIQUE (cycle_id, attempt, provider)
);

CREATE TABLE IF NOT EXISTS selection_receipts (
  cycle_id        INTEGER PRIMARY KEY,
  digest          TEXT NOT NULL UNIQUE,
  merkle_root     TEXT NOT NULL,
  receipt_json    TEXT NOT NULL,        -- canonical receipt (R2 WP04-4 format); private fields stay in the blob
  public_json     TEXT NOT NULL,        -- digest, root, count, cutoff slot and time, mint, policy, winner, winner proof, masked tie rows
  verifier_digest TEXT,                 -- the independent verifier's digest; must equal digest before finalization
  created_at      TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS selection_receipts_no_update BEFORE UPDATE ON selection_receipts
  WHEN OLD.verifier_digest IS NOT NULL BEGIN SELECT RAISE(ABORT, 'receipt_immutable'); END;
CREATE TRIGGER IF NOT EXISTS selection_receipts_no_delete BEFORE DELETE ON selection_receipts
  BEGIN SELECT RAISE(ABORT, 'receipt_immutable'); END;

CREATE TABLE IF NOT EXISTS national_ranks (
  mode        TEXT NOT NULL,
  cycle       INTEGER NOT NULL,
  country     TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  wallet      TEXT NOT NULL,
  raw         TEXT NOT NULL,
  rank        INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (mode, cycle, country, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS national_ranks_rank ON national_ranks (mode, cycle, country, rank);

CREATE TABLE IF NOT EXISTS founder_records (
  city_id        TEXT PRIMARY KEY,
  country        TEXT NOT NULL,
  wallet         TEXT NOT NULL UNIQUE,  -- one account, one fixed city in this release (§19), so one founder seat per wallet
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
);
CREATE TRIGGER IF NOT EXISTS founder_records_no_update BEFORE UPDATE ON founder_records
  BEGIN SELECT RAISE(ABORT, 'founder_record_immutable'); END;
CREATE TRIGGER IF NOT EXISTS founder_records_no_delete BEFORE DELETE ON founder_records
  BEGIN SELECT RAISE(ABORT, 'founder_record_immutable'); END;
```

Rules:

- **Clock.** `cycle = selectionEpoch(boundary)`; every surface takes `serverTime` and the next boundary from the status API and
  counts down with the server offset (§33). The cutoff slot is fixed by chain block time (the highest finalized slot with
  `blockTime <= boundary`), not by the job's wake-up time (§20).
- **Order.** Each run takes, per city, the lowest `cycle` with status `due`, `processing` or `data_error` whose boundary has
  passed, claims it (`claimed_until`, `claim_token` under the `selection` lease, section 3.8) and finishes it before creating
  the next (§20 "never let a delayed job skip a valid earlier winner").
- **Completeness.** A cycle closes `empty` only when both providers resolve the same cutoff slot, each provider's sum over all
  token accounts equals the mint supply at that slot, both candidate vectors are identical, and no candidate has a positive
  balance. The mint is the configured main token (`MAIN_TOKEN_MINT`, amendment 01). "Supply can only fall" was true of the legacy
  `$VICINITY` mint (no mint authority); for the configured mint it holds only if its verification record shows no mint authority,
  and otherwise the supply read at each cutoff slot is recorded with the snapshot. Any other outcome is `data_error` on the same cycle,
  retried with `attempts + 1` and alerted (§20, §21, A06, A09).
- **Candidates.** Users with a current `city_assignments` row for the city assigned at or before the boundary,
  `signup_completed_at <= boundary`, a wallet, no ban active at the boundary, not a test-lab account, not an excluded holder
  (off-curve owners, team wallets and locks of the configured main token as confirmed at its verification, pool authorities,
  and every program role key that a FounderRecord may not name).
  Exclusions are listed with reasons in the private receipt.
- **Ranking.** Raw balance descending, then `signup_completed_at` ascending, then the 32 decoded key bytes ascending (comparing
  base58 text is wrong; R2). The same comparator and read rank every registered wallet per country into `national_ranks`.
- **Finalization.** `shadow`: the cycle row is the end. `live`: the publisher submits the result signed with the verifier's
  agreement; only after the on-chain FounderRecord is seen finalized does one batch insert `founder_records`, set the cycle to
  `selected` and the city to `founded`. If the chain already holds a record for the city, the job copies it and raises the
  "attempt to select a founded city" alert. The on-chain record is authoritative (§21).
- **Founder status is permanent.** No route or job updates or deletes `founder_records`. A ban or other restriction is read
  separately (today's `bans`, src/store.js:136-143) and blocks actions, never identity (§21, A10).
- **Backfill.** None expected: the live site has 0 seats (GET above) and no recorded city coin (`/official-coins.csv` empty).
  `source = 'legacy_evidence'` exists only for a genuinely permanent founder with a confirmed launched coin, after evidence
  review (§17); none is known.
- **Retention.** Cycles, snapshots and receipts are kept. `national_ranks` keeps 30 days plus every cycle referenced by a
  manager application's evidence (the evidence JSON also copies the rank).

### 3.3 Country-manager applications (§16, §22)

Today: managers are elected for 90-day terms (src/policy.js:65-71); tables `elections`, `election_votes`, `manager_terms`
(src/store.js:308-340) become history.

Migration id `cc5-managers`, created when `MANAGER_APPS` first turns on.

```sql
CREATE TABLE IF NOT EXISTS manager_applications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL,
  wallet             TEXT NOT NULL,
  country            TEXT NOT NULL,
  city_id            TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft','submitted','under_review','approved','rejected','withdrawn','needs_requalification')),
  summary            TEXT NOT NULL,
  checks_at_submit   TEXT,              -- JSON: founder record, confirmed launch, points, national rank (cycle, computed_at), standing
  checks_at_decision TEXT,
  checks_hash        TEXT,              -- sha256 of the checks the owner saw; a decision must echo it
  decision_note      TEXT,
  decided_by         TEXT,              -- owner wallet
  decided_at         TEXT,
  policy_version     TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  submitted_at       TEXT,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS manager_applications_open ON manager_applications (wallet, country)
  WHERE status IN ('draft','submitted','under_review','needs_requalification');
CREATE INDEX IF NOT EXISTS manager_applications_queue ON manager_applications (country, status, submitted_at);

CREATE TABLE IF NOT EXISTS manager_application_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  at             TEXT NOT NULL,
  actor_kind     TEXT NOT NULL CHECK (actor_kind IN ('applicant','owner','system')),
  actor          TEXT,
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  checks_json    TEXT,
  note           TEXT
);
-- append-only triggers (no UPDATE, no DELETE), as for founder_records

CREATE TABLE IF NOT EXISTS country_managers (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS country_managers_active ON country_managers (country) WHERE ended_at IS NULL;
-- triggers: no DELETE; UPDATE only sets ended_at, ended_by and end_reason, once
```

Rules: eligibility (FounderRecord in the registered country, confirmed launch, at least 100 valid points, national rank 1, no
active suspension) is checked at submission and again inside the owner's approval batch; the approval batch inserts the
`country_managers` row only `WHERE` the re-run checks pass and no active manager exists, otherwise the application becomes
`needs_requalification` (§22, A12). No job ever ends a manager; replace and revoke are owner routes with an audit row in the
existing `admin_audit` (src/store.js:471-478) and a public `mod_actions` row without evidence (src/store.js:341-358). A job step
at each cutoff and on each activity reversal moves open applications that fell below a requirement to `needs_requalification`
and sends the notice kind `manager`. Backfill: none (no active manager exists while 0 seats exist; R2 finding 2).

### 3.4 Activity ledger (§23)

Today: no ledger exists. Posts and replies live in `posts` (src/store.js:96-114).

Migration id `cc5-activity`, created when `ACTIVITY_POINTS` first leaves "off".

```sql
CREATE TABLE IF NOT EXISTS activity_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  wallet         TEXT,
  city_id        TEXT,
  country        TEXT,
  event_type     TEXT NOT NULL CHECK (event_type IN ('launch','post','reply','initiative','proposal','reversal')),
  source_type    TEXT NOT NULL,         -- 'chain_launch' | 'post' | 'evidence' | 'reversal'
  source_id      TEXT NOT NULL,
  points         INTEGER NOT NULL,      -- from the policy at write time; a reversal row carries 0 and names what it reverses
  activity_at    TEXT NOT NULL,         -- time of the source activity (decides the UTC day)
  self_reply     INTEGER NOT NULL DEFAULT 0,
  review_state   TEXT NOT NULL CHECK (review_state IN ('auto','accepted')),
  dedup_key      TEXT NOT NULL UNIQUE,  -- 'launch:<city>', 'post:<id>', 'reply:<id>', 'evidence:<id>', 'reversal:<event id>'
  reverses_id    INTEGER UNIQUE,
  policy_version TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_events_user ON activity_events (user_id, event_type, activity_at);
-- append-only triggers (no UPDATE, no DELETE)

CREATE TABLE IF NOT EXISTS activity_evidence (
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
  event_id     INTEGER UNIQUE,          -- the activity_events row an acceptance appended
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS activity_evidence_body ON activity_evidence (user_id, kind, body_hash);
CREATE INDEX IF NOT EXISTS activity_evidence_queue ON activity_evidence (status, created_at);

CREATE TABLE IF NOT EXISTS activity_totals (   -- derived cache, rebuilt at any time from activity_events
  user_id        INTEGER PRIMARY KEY,
  total          INTEGER NOT NULL,
  by_category    TEXT NOT NULL,
  computed_at    TEXT NOT NULL,
  policy_version TEXT NOT NULL
);
```

Rules:

- One row per eligible source activity (the UNIQUE `dedup_key` makes concurrent crediting of one post produce one row, A13).
  Posts and replies are written only after the moderation hide window has passed with the post visible and not deleted, the
  duplicate check (normalized body hash against the author's recent posts) and the spam screen; evidence rows only after an
  owner or authorized moderator accepts them, and never by the submitter (§23).
- **Totals are computed, not stored per event.** `activityTotals(rows)` in src/masterpolicy.js is the reference computation:
  policy points by type, category caps (40/20/20/30/20, total 130), at most one credited post and two credited replies per UTC
  day, no self-replies, reversal rows remove the event they name. `activity_totals` caches its result per user after each new
  row. Holding, logging in, self-transfers and buying volume have no event type (§23).
- A confirmed hide or deletion of a source appends a `reversal` row, recomputes the total, and moves any open manager
  application below 100 points to `needs_requalification` (§23, A13).
- **Backfill.** Only for users who have a FounderRecord: replay their existing visible posts and replies through the same rules
  with the original times, and append the one launch award for a confirmed launch. Today no FounderRecord exists, so no rows.

### 3.5 City metadata: versions, uploads, requests and the review lock (§16 Metadata changes, §24, §25)

Today: the dark COIN_V2 stages keep `coin_art` (content-addressed bytes), `coin_versions`, `coin_ready`
(src/coinart-store.js:22-75) and `coin_requests` with statuses `draft, pending, approved, changes_needed, cancelled, withdrawn`
and one open request per city (src/coinreview.js:138-173). Their switches are off; the live `GET /api/coins` answered 0 designs.
Picture uploads are capped at 200,000 bytes (src/social.js:42).

Migration id `cc5-metadata`, created when `METADATA_V5` first turns on. `coin_art` is reused for approved, content-addressed
image bytes.

```sql
CREATE TABLE IF NOT EXISTS city_metadata_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id          TEXT NOT NULL,
  version          INTEGER NOT NULL,          -- 1 = the registry default; +1 per approved request
  origin           TEXT NOT NULL CHECK (origin IN ('default','approved_request')),
  request_id       INTEGER,
  ticker           TEXT NOT NULL,
  name             TEXT NOT NULL,
  descriptive_text TEXT NOT NULL,             -- the approved text; location and pair are rendered, never typed
  image_sha256     TEXT NOT NULL,             -- coin_art.sha256
  canonical_json   TEXT NOT NULL,             -- city, region (or explicit "no state or region"), country ids and names, source, list and normalization versions
  content_hash     TEXT NOT NULL,             -- sha256 of the pair-independent canonical content
  per_quote_json   TEXT NOT NULL,             -- {quote_config_id: {description, metadata_json_sha256}} for every approved quote
  registry_version INTEGER,
  policy_version   TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (city_id, version),
  UNIQUE (city_id, content_hash)
);
-- append-only triggers (no UPDATE, no DELETE)

CREATE TABLE IF NOT EXISTS city_metadata_active (
  city_id       TEXT PRIMARY KEY,
  version_id    INTEGER NOT NULL,
  version       INTEGER NOT NULL,
  ticker        TEXT NOT NULL UNIQUE,         -- the global ticker lock before launch
  activated_at  TEXT NOT NULL,
  publish_tx    TEXT,                         -- chain confirmation of the version (null only for a default not yet in a published root)
  publish_slot  INTEGER,
  launched_mint TEXT UNIQUE                   -- set once at the confirmed launch; afterwards nothing here may change
);
CREATE TRIGGER IF NOT EXISTS city_metadata_active_frozen_after_launch BEFORE UPDATE ON city_metadata_active
  WHEN OLD.launched_mint IS NOT NULL BEGIN SELECT RAISE(ABORT, 'metadata_frozen_after_launch'); END;

CREATE TABLE IF NOT EXISTS city_metadata_uploads (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id            TEXT NOT NULL,
  user_id            INTEGER NOT NULL,
  original_type      TEXT NOT NULL CHECK (original_type IN ('image/png','image/jpeg','image/webp')),
  original_bytes_len INTEGER NOT NULL CHECK (original_bytes_len BETWEEN 1 AND 10000000),
  width              INTEGER NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height             INTEGER NOT NULL CHECK (height BETWEEN 1 AND 4096),
  stripped_sha256    TEXT NOT NULL,           -- after EXIF, XMP, text and location chunks are removed
  normalized_sha256  TEXT,                    -- the square PNG the coin would publish
  storage_key        TEXT NOT NULL,           -- private: chunked blobs or a private bucket, never a public URL
  status             TEXT NOT NULL CHECK (status IN ('quarantined','attached','approved','discarded')),
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS city_metadata_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id             TEXT NOT NULL,
  user_id             INTEGER NOT NULL,
  wallet              TEXT NOT NULL,          -- must equal founder_records.wallet for the city
  status              TEXT NOT NULL CHECK (status IN ('draft','submitted','under_review','approved_publishing','active','rejected','withdrawn','superseded')),
  base_version        INTEGER NOT NULL,
  proposed_ticker     TEXT,
  proposed_upload_id  INTEGER,
  proposed_text       TEXT,
  reason              TEXT NOT NULL,
  proposal_hash       TEXT,                   -- sha256 of the canonical proposal; the founder signs it on chain at submission
  submit_tx           TEXT,
  submit_slot         INTEGER,
  decision_note       TEXT,
  decided_by          TEXT,
  decided_at          TEXT,
  publish_tx          TEXT,
  publish_slot        INTEGER,
  resulting_version_id INTEGER,
  policy_version      TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS city_metadata_requests_open ON city_metadata_requests (city_id)
  WHERE status IN ('draft','submitted','under_review','approved_publishing');
CREATE INDEX IF NOT EXISTS city_metadata_requests_queue ON city_metadata_requests (status, updated_at);

CREATE TABLE IF NOT EXISTS city_metadata_request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('founder','owner','system')), actor TEXT,
  from_status TEXT, to_status TEXT NOT NULL, note TEXT, chain_tx TEXT
);
-- append-only triggers

CREATE TABLE IF NOT EXISTS city_review_locks (   -- mirror of the on-chain ReviewLock; the chain is authoritative
  city_id       TEXT PRIMARY KEY,
  request_id    INTEGER NOT NULL UNIQUE,
  proposal_hash TEXT NOT NULL,
  base_version  INTEGER NOT NULL,
  chain_pda     TEXT NOT NULL,
  opened_tx     TEXT NOT NULL,
  opened_slot   INTEGER NOT NULL
);
```

Rules:

- **Defaults** are deterministic from the canonical registry (version 1, `origin = 'default'`) and are materialized lazily the
  first time a founder, the launch flow or the public preview asks for them; the hash is reproducible either way.
- **State machine** `draft → submitted → under_review → approved_publishing → active`, or `rejected`, `withdrawn`,
  `superseded`. Moves past `draft` happen only after the matching chain transaction is confirmed (submission creates the
  ReviewLock; approval publishes the version and clears the lock in one instruction; rejection or withdrawal clears it), so the
  database never says "submitted" or "active" ahead of the chain (§25).
- **Approval batch** (owner only, fresh proof): re-checks that the city is not launched, the base version is still active, the
  ticker is free, and the proposal hash equals the one submitted; inserts the new `city_metadata_versions` row; points
  `city_metadata_active` at it; marks the request `active`; deletes the lock mirror row; appends the event. A changed upload,
  text or ticker is a new request.
- **Images.** PNG, JPEG or WebP, at most 10,000,000 bytes and 4096 x 4096 decoded pixels, signature verified, metadata
  stripped, SVG, HTML and executables refused. Uploads stay private until approval; approved bytes go to `coin_art` by hash.
  D1 limits the size of one row, so bytes over that limit are stored in the existing chunked `blobs` table
  (src/store.js:178-183) or in a private bucket (a new binding: owner action). The current Cloudflare limits must be checked when
  this is built.
- **Migration from the dark COIN_V2 tables**, only where they exist (preview and test databases; production was not read):
  `coin_versions` rows become version-1 rows with their content kept as `canonical_json` v1; `coin_requests` statuses map
  `pending → submitted`, `changes_needed → rejected`, `cancelled → withdrawn`, `approved → active` (R3 25-R1). Old rows are not
  rewritten.

### 3.6 Launch records and preparation (§24, §26)

Today: legacy launches are recorded in `lp_coins` keyed by (cluster, program, city) (src/lpcoins.js:47-65).

Migration id `cc5-launch`, created when `LAUNCH_V5` first turns on.

```sql
CREATE TABLE IF NOT EXISTS city_launches (
  cluster             TEXT NOT NULL,
  program_id          TEXT NOT NULL,
  city_id             TEXT NOT NULL,
  mint                TEXT NOT NULL UNIQUE,
  coin                TEXT NOT NULL,
  founder             TEXT NOT NULL,            -- equals founder_records.wallet
  quote_config_id     INTEGER NOT NULL,
  quote_mint          TEXT NOT NULL,
  metadata_version_id INTEGER NOT NULL,
  metadata_hash       TEXT NOT NULL,            -- the per-quote JSON hash bound on chain at launch
  ticker              TEXT NOT NULL UNIQUE,
  launch_tx           TEXT NOT NULL,
  launch_slot         INTEGER NOT NULL,
  launched_at         TEXT NOT NULL,
  recorded_at         TEXT NOT NULL,
  PRIMARY KEY (cluster, program_id, city_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS city_launches_city ON city_launches (city_id);

CREATE TABLE IF NOT EXISTS launch_preparations (   -- only if the launch must be split into prepare and finalize (§26)
  id              TEXT PRIMARY KEY,
  city_id         TEXT NOT NULL,
  founder         TEXT NOT NULL,
  version_id      INTEGER NOT NULL,
  quote_config_id INTEGER NOT NULL,
  stage           TEXT NOT NULL CHECK (stage IN ('built','prepared','finalized','expired')),
  prepare_tx      TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS launch_preparations_open ON launch_preparations (city_id) WHERE stage IN ('built','prepared');
```

Rules: a city recorded in `lp_coins` or `city_launches` is launched; the route refuses a second launch and the program refuses it
on chain (one launch per city across old and new programs, §24). A record is written only from a confirmed chain read
(idempotent on `(cluster, program_id, city_id)`), and the same batch sets `city_metadata_active.launched_mint`, appends the
`launch:<city>` activity event and the community launch event.

### 3.7 Hourly processing records (§16 Distribution, §30, §31, §32)

Today: the only scheduler is a cron every 10 minutes (wrangler.jsonc:141) with one D1 lease (src/jobs.js:22-38); holder rounds
in the rewards program have a minimum claim window of 14 days (solana/programs/vicinity-rewards/src/constants.rs:44-48).

Migration id `cc5-hourly`, created when `CC_HOURLY` first leaves "off".

```sql
CREATE TABLE IF NOT EXISTS hourly_runs (
  cluster        TEXT NOT NULL,
  program_id     TEXT NOT NULL,
  coin           TEXT NOT NULL,
  quote_mint     TEXT NOT NULL,
  utc_hour       INTEGER NOT NULL,       -- floor(unix_seconds / 3600) of the hour whose holdings are measured
  mode           TEXT NOT NULL CHECK (mode IN ('shadow','live')),
  status         TEXT NOT NULL CHECK (status IN ('sampling','insufficient_samples','allocated','verified','root_published','paying','done','carried','failed')),
  cutoff_slot    INTEGER,
  samples_ok     INTEGER NOT NULL DEFAULT 0,
  funded_raw     TEXT,
  allocated_raw  TEXT,                   -- sum of floored leaves
  dust_raw       TEXT,                   -- funded - allocated, carried with a public reason
  carried_raw    TEXT,
  carry_reason   TEXT,                   -- 'insufficient_samples' | 'no_recipient_weight' | 'dust' | 'below_executable_unit'
  recipient_count INTEGER,
  list_hash      TEXT,
  root           TEXT,
  verifier_a_digest TEXT,
  verifier_b_digest TEXT,
  policy_version TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (cluster, program_id, coin, quote_mint, utc_hour, mode)
);

CREATE TABLE IF NOT EXISTS hourly_samples (
  cluster      TEXT NOT NULL,
  program_id   TEXT NOT NULL,
  coin         TEXT NOT NULL,
  utc_hour     INTEGER NOT NULL,
  segment      INTEGER NOT NULL CHECK (segment BETWEEN 0 AND 4),   -- 0-3: one per 15-minute segment; 4: the cutoff balance
  slot         INTEGER NOT NULL,
  taken_at     TEXT NOT NULL,          -- written after the sample; planned times are never stored or published
  holders_hash TEXT NOT NULL,
  holder_count INTEGER NOT NULL,
  blob_key     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('ok','unreliable')),
  PRIMARY KEY (cluster, program_id, coin, utc_hour, segment)
);

CREATE TABLE IF NOT EXISTS hourly_actions (
  action_key    TEXT PRIMARY KEY,      -- 'cluster|program|coin|quote_mint|utc_hour|action|batch' (§30)
  cluster       TEXT NOT NULL,
  program_id    TEXT NOT NULL,
  coin          TEXT NOT NULL,
  quote_mint    TEXT NOT NULL,
  utc_hour      INTEGER NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('platform_payout','founder_payout','holder_root','holder_batch','buyback','liquidity_reconcile')),
  batch         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL CHECK (status IN ('planned','sent','confirmed','failed','skipped')),
  amount_raw    TEXT,
  signature     TEXT,
  slot          INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error         TEXT,
  claimed_until TEXT,
  claim_token   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hourly_actions_work ON hourly_actions (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS hourly_leaves (
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
);
```

Rules:

- An action moves `planned → sent → confirmed` only after the chain shows the effect; a retry first reads the chain (the paid
  bitmap and monotonic hour ids on chain make a replay a no-op), so a crash between send and confirm never pays twice (§30, B08).
- One failed destination, quote or coin never blocks the others: each action has its own row, backoff (`next_attempt_at`) and
  alert (§30).
- Leaves stay `owed` until paid or claimed; no expiry and no sweep (§31). Only dust and funds without recipient weight carry.
- The buyback action is scheduled at most once per 150 slots per coin and never bypasses the per-run cap of
  `min(floor(depth / 1000), buyback_pending)`; a missed hour never produces catch-up runs (§32).
- **Scheduling gap (today).** A 10-minute cron leaves two of the four 15-minute segments with exactly one tick, so a sample there
  would be predictable (wrangler.jsonc:141). The sampler needs a finer, randomized scheduler (for example a one-minute cron or
  a Durable Object alarm). This is an infrastructure item, not built.

### 3.8 Job leases and idempotency keys (§05, §30, D10)

Today: one lease row `settings.job_lease`, 8 minutes, taken by an atomic conditional upsert (src/jobs.js:22-30). The citycoin.dev
route will be added to the same Worker, so no second scheduler appears (R1 R1-07).

Migration id `cc5-ops`, created with the first of `SELECTION_V5`, `CC_HOURLY` or `LAUNCH_V5`.

```sql
CREATE TABLE IF NOT EXISTS job_leases (
  name        TEXT PRIMARY KEY,         -- 'selection' | 'hourly' | 'keeper' | 'activity'
  holder      TEXT NOT NULL,            -- random id of the run
  fencing     INTEGER NOT NULL,         -- +1 on every acquisition
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope           TEXT NOT NULL,        -- route + user id, or 'job:<name>'
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,        -- sha256 of method, path and canonical body
  status          TEXT NOT NULL CHECK (status IN ('in_progress','done')),
  response_status INTEGER,
  response_json   TEXT,                 -- never a secret or one-time code (routes that return one are not replayable)
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,        -- 24 hours
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires ON idempotency_keys (expires_at);
```

Acquisition copies today's pattern: `INSERT ... ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, fencing =
job_leases.fencing + 1, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at WHERE job_leases.expires_at < ?`.
Every write a lease holder makes is guarded by `AND (SELECT fencing FROM job_leases WHERE name = ?) = ?`, so a run that lost its
lease (slow, crashed, or on the other host) cannot write. Per-item claims (`claimed_until`, `claim_token`) sit under the lease.

### 3.9 Tables that become history (read-only)

| Tables (today) | After the switch | Kept because |
|---|---|---|
| `windows`, `applications`, `endorsements`, `seats`, `squads`, `squad_members`, `objections` (src/store.js:210-307) | no writer once `LEGACY_SEATS=frozen` | audit history (§07, §17) |
| `elections`, `election_votes`, `manager_terms` (src/store.js:308-340) | no writer once `LEGACY_SEATS=frozen` | audit history |
| `streaks`, `balance_samples` (src/store.js:184-199) | streak updates stop; samples may feed monitoring | history; `streaks` may be dropped after the observation period |
| `coin_requests`, `coin_screenings`, `coin_ready`, `coin_legacy_designs` | read-only once `METADATA_V5` is on | migration source, history |
| `email_codes`, `signups` provider fields, `users.password_hash`, `user_logins` | purged or frozen after the legacy link window (R1 WU-9) | Terms receipts and identifiers stay |

### 3.10 Order, checks and census

1. Validate a backup and dry-run every migration on a copy of the production database; compare before and after counts and
   hashes for users with wallets, posts, cities, founder records, coins and monetary rows (§07, §37 step 1-2, D08).
2. Run `cc5-identity` (after `ONBOARD_MIGRATION`), then `cc5-selection`, `cc5-activity`, `cc5-managers`, `cc5-metadata`,
   `cc5-launch`, `cc5-hourly`, with `cc5-ops` before the first job that needs a lease.
3. Count-only census queries, run by someone with production D1 access, returning no member data (R1 section 9 lists three):
   duplicate wallets (must be 0); users by migration case; non-wallet sessions; plus `SELECT status, COUNT(*) FROM seats GROUP
   BY status` and `SELECT name FROM sqlite_master WHERE name IN ('coin_requests','coin_versions')` to confirm what history exists.

## 4. API design (DESIGN)

### 4.0 Conventions

- **Auth levels.**
  - `public`: no session.
  - `session`: a wallet-bound session cookie. Under `WALLET_ONLY` the cookie is host-only `__Host-` prefixed and the session row
    carries `host` (section 3.1). Today's cookie is `vs` (src/session.js:6).
  - `fresh`: a session whose wallet was proven within the policy window (today 30 minutes: src/policy.js:90, src/auth.js:240-244).
  - `founder`: `session` + the session wallet equals `founder_records.wallet` for the city in the path.
  - `moderator`, `admin`, `owner`: today's console roles; owner comes only from `ADMIN_WALLETS` (src/admin.js:42-57) and every
    console write needs a fresh proof (src/admin.js:783-784).
- **Writes** need `Origin` host = request host (src/http.js:73-77) and a host in `SITE_ORIGINS`. A mutation on a non-canonical
  host answers `421 {ok:false, error:"wrong_host", origin}` with no `Location` (§04, D05).
- **Errors** keep today's envelope `{ ok: false, error: "<code>" }` with an HTTP status, plus a plain `message` (§34 "understandable
  error/recovery messages"). Common: `400 bad_request`, `401 sign_in`, `403 forbidden`, `404 not_found` (also every route whose
  switch is off), `405 method_not_allowed`, `409` state conflicts, `410` retired or expired, `421 wrong_host`, `429 slow_down`,
  `503 unavailable`.
- **Money routes only build.** They return unsigned transactions, a decoded summary and a relay ticket; the person's wallet
  signs. The Worker holds no key and signs nothing, as today (src/walletsend.js:1-4; src/lplaunch.js:1-7).
- **Rate limits** use today's per-connection `publicLimit` (src/guards.js:22, :117) and per-account counters.
- **Time.** Every status answer carries `serverTime` (ISO) so pages count down with the server clock (§33, A08).
- Requests marked **(idem)** accept an `Idempotency-Key` header (section 5).

### 4.1 Sign-in and registration (§18, §19, §05; switch `WALLET_ONLY`)

| Method and path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `POST /api/auth/challenge` | public (`login`, `register`); session (`reprove`); legacy session (`legacy_link`) | `{purpose, address, ref?}` | `{challengeId, message, expiresAt}`; the message names origin, cluster, wallet, nonce, purpose, `Expiration Time` and says it is free and not a transaction | `bad_address`, `bad_purpose`, `location_required` (register before location), `slow_down` |
| `POST /api/auth/wallet` (changed) | public | `{challengeId, address, signature}` | `{ok, user:{id, handle, city, country}, next}` and the session cookie | `challenge_unknown`, `challenge_expired` (410), `challenge_used` (409), `wrong_purpose`, `wrong_wallet`, `wrong_site`, `signature_mismatch`, `no_account` (404: go to registration in a normal browser; no location is asked here) |
| `POST /api/auth/logout` (kept) | session | none | `{ok}`, cookie cleared | none |
| `POST /api/signup/start`, `/location`, `/location/choice`, `/terms` (kept) | public (signup cookie) | as today | as today | as today; location stays in the normal browser |
| `POST /api/signup/wallet` (new) | public (signup cookie) **(idem)** | `{challengeId, address, signature, displayName?}` | `{ok, user, existing:false}` or `{ok, user, existing:true}` when the wallet already had an account (its city is unchanged) | `location_required`, `signup_expired` (410: restart registration), challenge errors, `handle_taken` |
| `POST /api/signup/handoff` (new) | public (signup cookie) | none | `{code, expiresAt}` (single use, 5 minutes, in the body only) | `location_required`, `slow_down` |
| `POST /api/signup/handoff/info`, `/claim`, `/status` (new) | public | `{code, ...}` in the body, never in a URL | city and country label only; `claim` registers like `/api/signup/wallet` | `code_unknown`, `code_used`, `code_expired` (410), `contested` |
| `GET /api/me` (changed) | session | none | adds `walletOnly`, `registration {city, country, verifiedAt, method}`, `roles {founderCity?, managerCountry?}` read from `founder_records` and `country_managers` | `sign_in` |
| `POST /api/home` (changed) | fresh | `{attestation}` | `{ok, city}` | `location_fixed` (409) when a city is already set |

### 4.2 Selection status (§20, §21, §33; switch `SELECTION_V5`, shown in shadow with a "provisional" label)

| Method and path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/selection/status` | public | none | `{serverTime, policyVersion, cycleSeconds:21600, epoch, nextBoundary, mode, lastRun {at, citiesProcessed, dataErrors}, verifier {agreementRate24h, publisher?, verifier?}, cities {awaiting, processing, founded}}` | `not_found` while off |
| `GET /api/selection/city/:cityId` | public | none | `{cityId, status: awaiting|processing|founded, serverTime, nextBoundary?, provisional {label, updatedAt, slot, rows:[{rank, wallet (masked), raw}]}?, founder?, history:[{cycle, boundary, status, candidateCount, digest}]}`; a data outage reads "Processing", never "No holder" | `unknown_city` (404) |
| `GET /api/selection/receipts/:cycleId` | public | none | the public receipt: digest, Merkle root, candidate count, cutoff slot and time, mint, policy version, winner and winner proof, masked tie rows | `not_found` |
| `GET /api/selection/me` | session | none | own provisional rank and raw balance in the own city; own leaf proof for each finalized cycle | `sign_in` |
| `GET /api/admin/selection/cycles?status=` | owner | none | cycles with error codes and attempts, for operations | `forbidden` |

There is no route that selects, replaces or deletes a founder.

### 4.3 Founder record (§21, §14 "Founded city")

| Method and path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/founders/:cityId` | public | none | `{cityId, country, wallet, cycle, cutoffSlot, snapshotHash, policyVersion, selectedAt, receipt, chain {cluster, programId, pda, tx, slot}, launch: not_launched|launched}` (the master asks to show the actual selected wallet and receipt) | `not_found` |
| `GET /api/founders?country=` | public | none | list of the above | none |
| any other method on `/api/founders/*` | none | none | none | `405 founder_record_immutable` |

### 4.4 Country-manager applications (§22, §34; switch `MANAGER_APPS`)

| Method and path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/manager/status` | session | none | `{requirements:[{key: founder|launched|points|national_rank|standing, met, detail}], points {total, byCategory}, nationalRank {rank, raw, cycle, computedAt, stale}, application?, manager?}` | `sign_in` |
| `POST /api/manager/applications` | fresh **(idem)** | `{country, cityId, summary}` | `{application}` with the evidence snapshot the server attached | `not_founder`, `not_launched`, `points_below`, `rank_not_first`, `suspended`, `country_mismatch`, `open_application_exists` (409) |
| `POST /api/manager/applications/:id/withdraw` | fresh | none | `{application}` | `not_yours`, `not_open` |
| `GET /api/countries/:country/manager` | public | none | `{country, manager?: {handle, wallet, appointedAt}}` | none |
| `GET /api/admin/managers?country=&status=` | owner | none | the inbox, with refreshed checks | `forbidden` |
| `GET /api/admin/managers/:id` | owner | none | full evidence, history, refreshed rank and points, `checksHash` | `forbidden`, `not_found` |
| `POST /api/admin/managers/decide` | owner, fresh **(idem)** | `{id, decision: under_review|approve|reject, note?, checksHash}` | `{application, manager?}` | `stale_checks` (409: re-open the evidence), `needs_requalification` (409, the application moved there), `active_manager_exists` (409), `not_open` |
| `POST /api/admin/managers/revoke` | owner, fresh | `{country, reason}` | `{ok}` | `no_active_manager` |
| `POST /api/admin/managers/replace` | owner, fresh | `{country, applicationId, note}` | `{manager}` | as decide |

Admin and moderator sessions receive 403 on every manager decision route (§40 cross-role denial).

### 4.5 Activity evidence and points (§23; switch `ACTIVITY_POINTS`)

| Method and path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/activity/me` | session | none | `activityTotals` output for the own ledger: totals, categories, credited and not credited rows with reasons | `sign_in` |
| `GET /api/activity/summary?user=` | public | none | category totals only, never evidence | `not_found` |
| `POST /api/activity/evidence` | fresh **(idem)** | `{kind: initiative|proposal, title, summary, links?, mediaId?}` | `{evidence}` | `duplicate` (same body), `slow_down`, `not_registered` |
| `POST /api/activity/evidence/:id/withdraw` | fresh | none | `{evidence}` | `not_yours`, `not_open` |
| `GET /api/admin/activity/evidence?status=` | moderator | none | the review queue | `forbidden` |
| `POST /api/admin/activity/evidence/decide` | moderator, fresh **(idem)** | `{id, decision: accept|reject|duplicate, duplicateOf?, note?}` | `{evidence, event?}` | `own_evidence` (403), `not_open`, `duplicate_of_unknown` |
| `POST /api/admin/activity/reverse` | moderator, fresh **(idem)** | `{eventId, reason}` | `{reversal}` | `already_reversed`, `not_found` |

Evidence review changes points only; it never touches founder, launch or metadata state (§23).

### 4.6 Metadata requests and owner review (§24, §25; switch `METADATA_V5`)

| Method and path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/city-metadata/:cityId` | public | none | `{active {version, ticker, name, descriptiveText, imageUrl, contentHash, registryVersion}, previews:[{quoteConfigId, quote, description, metadataHash}], reviewLock: none|submitted|under_review|approved_publishing, launched}` | `unknown_city` |
| `GET /api/city-metadata/:cityId/request` | founder | none | the open request with its status history | `not_founder` |
| `POST /api/city-metadata/:cityId/uploads` | founder, fresh | image bytes (`image/png`, `image/jpeg`, `image/webp`) | `{uploadId, width, height, sha256}` (private) | `unsupported_type`, `too_large`, `too_many_pixels`, `bad_signature`, `launched` |
| `POST /api/city-metadata/:cityId/requests` | founder, fresh **(idem)** | `{ticker?, uploadId?, descriptiveText?, reason, baseVersion}` | `{request}` (draft) with per-quote rendered previews | `not_founder`, `launched` (409), `open_request_exists` (409), `stale_base_version` (409), `ticker_invalid`, `ticker_taken`, `text_refused` |
| `POST /api/city-metadata/:cityId/requests/:id/submit` | founder, fresh **(idem)** | `{proposalHash}` | unsigned `submit_metadata_proposal` transaction (founder signs; creates the on-chain ReviewLock), decoded summary, relay ticket | `hash_mismatch`, `not_draft` |
| `POST /api/city-metadata/:cityId/requests/:id/withdraw` | founder, fresh | none | unsigned withdraw transaction (clears the lock) or `{request}` for a draft | `not_open` |
| `POST /api/city-metadata/confirm` | public **(idem)** | `{signature}` | `{request}` after the chain read confirms the transition | `not_confirmed` (409, retry), `unknown_transaction` |
| `GET /api/admin/city-metadata/requests?status=` | owner | none | the owner-only inbox | `forbidden` |
| `GET /api/admin/city-metadata/requests/:id` | owner | none | current and proposed diff, image previews, city identity, ticker conflicts, final description and JSON hash for every enabled quote | `forbidden` |
| `POST /api/admin/city-metadata/requests/:id/decide` | owner, fresh **(idem)** | `{decision: under_review|approve|reject, note?, proposalHash}` | approve: unsigned publish transaction for the metadata-admin key and the request in `approved_publishing`; reject: unsigned lock-clearing transaction | `launched` (409), `stale_base_version`, `ticker_taken`, `hash_mismatch`, `not_open` |

Founder routes never write the active metadata. Admin and moderator sessions receive 403 on the decide route; there is no
per-launch owner approval (§25, §26, §36).

### 4.7 Launch preparation (§26, §29; switch `LAUNCH_V5`)

| Method and path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/city-launch/status?cityId=` | session | none | `{policyVersion, registryVersion, founderRecord, launched, reviewLock, activeVersion, quotes:[{id, symbol, mint, decimals, minBuy, graduation}], checklist:[{key, ok, detail}], costs:{platformLaunchFee:"0", networkFee, priorityFee, rent:[...], metadataFee, firstBuy:"none"}}` | `unknown_city` |
| `POST /api/city-launch/tx` | founder, fresh **(idem)** | `{cityId, quoteConfigId, expectedMetadataHash, firstBuy?: {amountRaw, minOutRaw}}` | unsigned transaction(s) with the decoded program ids, accounts, signers, city, pair, metadata hash and amounts, the simulation, the receipt and a relay ticket | `not_founder`, `launched` (409), `review_locked` (409), `version_changed` (409: refresh), `quote_not_enabled`, `min_out_required`, `simulation_failed`, `too_large` (use prepare and finalize) |
| `POST /api/city-launch/record` | public **(idem)** | `{signature}` | `{launch}` after a confirmed chain read; writes `city_launches`, the launch activity event and the listing once | `not_confirmed` (409), `not_a_launch` |
| relay | as today | ticketed bytes to the existing relay (`/api/swap/send`) | as today | as today |

The receipt itemizes "Citycoin.dev platform launch fee: 0" separately from network, priority, rent and metadata costs (§14,
§29). Rebuilding expired bytes needs a new receipt and signature.

### 4.8 Hourly status (§30, §31, §32; switch `CC_HOURLY`)

| Method and path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `GET /api/hourly/status` | public | none | `{serverTime, nextHour, mode, lastHour {hour, status}, coins:[{mint, quote, paid, funded, pending, carried, liquidity {locked, applied, pending}, buyback {pending, lastRunSlot, lastRunAt, backlogRuns}}], alerts:{missedHours, rootDisagreements, drift}}` | `not_found` while off |
| `GET /api/hourly/coins/:mint?hour=` | public | none | per-hour run: samples (slots, times after the fact), funded, allocated, dust and carry with reasons, root, leaf count, list hash, verifier agreement, action receipts with signatures | `not_found` |
| `GET /api/hourly/proof?mint=&hour=&wallet=` | public | none | `{index, amount, proof[], status: owed|paid|claimed}` | `not_found` |
| `POST /api/hourly/claim/tx` | session **(idem)** | `{mint, hour}` | unsigned recovery claim for the session wallet's own leaf | `nothing_owed`, `already_paid` |

### 4.9 Public policy and status (§16 Public policy, §35; switch `PUBLIC_V5`)

| Method and path | Auth | Response |
|---|---|---|
| `GET /api/policy` (changed) | public | today's answer plus `master` (the public policy document and `policy_digest`) |
| `GET /api/policy/master` | public | `{policyVersion, ownerDelegationDate, policyDigest, policy, masterSections, status}`, with `policy.main_token`, `policy.legacy_tokens` and `policy.official_links` filled from the verified configuration as in section 2.4 (null until verified); never `deployment.inputs` secrets (only secret presence booleans exist anyway) |
| `GET /api/status` | public | `{serverTime, policyVersion, areas:[{area, label: historical|approved_target|active, source}], mainToken {mint, verifiedAt} or null, legacyTokens, officialLinks {xUrl, telegramUrl} (null when unset), activePairs (read from chain), selection {schedule, nextBoundary}, fees {target: 250 bps split, live: the legacy config from /api/fees}, hourly {mode, lastHour}, authorities:[{role, address, verifiedAt, source}]}` |

Labels come from deployment and chain state, never from copy (§35). Nothing on these routes returns secrets, hand-off codes,
coordinates or applicant evidence.

## 5. Idempotency keys

**Client keys.** POST routes marked (idem) accept `Idempotency-Key` (16 to 64 characters of `[A-Za-z0-9_-]`; a UUID is fine).
The server stores `(scope = route + user id, key, request_hash)` in `idempotency_keys` for 24 hours:

- same key, same request: the stored response is returned with `Idempotent-Replay: true`;
- same key, different request: `409 idempotency_conflict`;
- same key while the first is running: `409 in_progress`.

Routes that return a one-time code (`/api/signup/handoff`) are not replayable and take no key; they are rate-limited instead.

**Server keys.** Background work uses deterministic keys, so retries and a second host can never act twice:

| Work | Key | Enforced by |
|---|---|---|
| Selection cycle | `(mode, city_id, cycle)` | `selection_cycles` UNIQUE plus the per-cycle claim under the `selection` lease |
| FounderRecord | `["founder_record", city_id]` PDA on chain; `city_id` primary key in D1 | program `init` (a second record fails) and the D1 primary key |
| Activity award | `dedup_key`: `launch:<city>`, `post:<id>`, `reply:<id>`, `evidence:<id>`, `reversal:<event id>` | `activity_events.dedup_key` UNIQUE |
| Manager decision | `(application id, checks_hash)` plus status guard | the decision batch `WHERE status IN (...) AND checks_hash = ?` |
| Metadata transition | `(request id, to_status, chain signature)` | request status guard and the on-chain lock |
| Launch record | `(cluster, program_id, city_id)` | `city_launches` primary key and the on-chain city and ticker locks |
| Hourly action | `cluster|program|coin|quote_mint|utc_hour|action|batch` (§30) | `hourly_actions` primary key, the on-chain paid bitmap and monotonic hour ids |
| Wallet challenge | `auth_challenges.id` single use | the consumption batch (section 3.1) |

## 6. Existing endpoints: stay, change or retire

Route list at `4aa408e`: src/index.js:6-63 (header) and the route switch that starts at src/index.js:421.

| Endpoint (today) | Verdict | Under which switch | Notes |
|---|---|---|---|
| `GET /api/health`, `/api/check` | stay | none | |
| `GET /api/token`, `/api/holders`, `/api/rank`, `POST /api/verify` | change | `MAIN_TOKEN_V5` | read the configured, verified `MAIN_TOKEN_MINT` instead of `VICINITY_MINT` (src/index.js:169, 452, 465, 476); the `$VICINITY` list, if kept, moves to a history route labeled legacy; `/api/verify` stays stateless (no session) |
| `GET /api/official` | change | `PUBLIC_V5`, `MAIN_TOKEN_V5` | adds `brand` (R5); `tokenContract` and `tokens[0]` from the configured main token; adds `legacyTokens` and `officialLinks` (null when unset); the old X handle leaves `socials` and is listed as legacy |
| `GET /api/policy` | change | `PUBLIC_V5` | adds `master`; v6 answer kept as history |
| `GET /api/message` (login, link) | change | `WALLET_ONLY` | replaced by `POST /api/auth/challenge` for login and link; codes leave the URL |
| `POST /api/auth/wallet`, `/api/auth/reprove` | change | `WALLET_ONLY` | challenge-based, host-bound sessions |
| `POST /api/auth/transfer`, `/api/auth/transfer/check` | retire (404) | `WALLET_ONLY` | the tiny-transfer proof is a payment, not a signature |
| `/api/auth/google/*`, `/api/auth/email/*`, `/api/auth/password/*`, `/api/me/password`, `/api/me/google/*`, `/api/signup/email*`, `/api/signup/account/reset`, old `/api/signup/finish` | retire (404) | `WALLET_ONLY` (restricted legacy forms only during `LEGACY_LINK`) | identifiers and Terms receipts stay as data (§05) |
| `/api/signup/location/handoff*` (location inside a wallet app) | retire | `WALLET_ONLY` | registration location stays in the normal browser (§19) |
| `/api/signup/start`, `/state`, `/terms`, `/location`, `/location/choice` | stay | none | reused by wallet-only registration |
| `POST /api/pair`, `/api/pair/finish` | change | `WALLET_ONLY` | codes in POST bodies; 5 minutes; purpose `register` added |
| `/api/me/wallet/link`, `/carry*` | change | `LEGACY_LINK` | only inside the legacy window, for legacy sessions |
| `POST /api/me/wallet/unlink` | retire | `WALLET_ONLY` | one wallet is the account |
| `GET /api/me`, `/api/me/*` profile routes | change / stay | `WALLET_ONLY` | new keys; roles from `founder_records` and `country_managers` |
| `POST /api/home`, `/api/locate`, `/api/locate/handoff/*` | change | `WALLET_ONLY` | only for an account that was never located; purpose `home` only |
| `GET /api/seats`, `/api/claims`, `/api/seats/results/:id`, `/api/elections/results/:id`, `/api/moderator` | stay as history | `LEGACY_SEATS=frozen` | marked `historical: true`; never an input to roles |
| `/api/seats/apply`, `/withdraw`, `/endorse`, `/object`, `/resign`, `/objections/decide`, `/squad/*`, `POST /api/elections/vote` | retire (410 `rule_retired`) | `LEGACY_SEATS=frozen` | replaced by automatic selection and owner-reviewed managers |
| `GET /api/members`, `/api/audit`, `/api/posts*`, `/api/mod*`, `/api/appeals*`, `/api/feedback`, `/api/notices*`, `/api/profile*`, `/api/follow*`, `/api/block`, `/api/mutes` | stay | none | founders no longer moderate their city by default (R2) |
| `POST /api/towns` | change | `WALLET_ONLY` | no GPS; uses the registered city and country |
| `GET /api/snapshots*`, `POST /api/snapshots/cancel` | stay as history | none | Founding Supporters snapshot is dormant; not a selection input |
| `GET /api/coins`, `/api/prices` | stay | none | legacy design list (0 rows today) |
| `POST /api/coins/design`, `/api/coins/mint`, `/api/coins/mint/decide`, `/api/coins/ready/use` | retire (409 or 404) | `METADATA_V5` | no direct founder metadata edit (§25, M01) |
| `GET /api/coins/ready`, `/api/coins/ready/art`, `/api/coins/review/*`, `/api/admin/coins/reviews*` | replace | `METADATA_V5` | by `/api/city-metadata/*` and the owner-only inbox |
| `POST /api/coins/takedown` | change | `METADATA_V5` | before launch: reject or withdraw; after launch: hide on our pages only, never change `/coin-meta` bytes |
| `/coin-meta/*`, `GET /official-coins.csv`, `/api/official-coins` | stay (never redirected) | none | legacy bytes exact; new-program coins added to the list |
| `/api/lp/launch/*`, `/api/admin/lp/*` approve, revoke and batch | retire for new launches | `LEGACY_LAUNCH=off` | owner's on-chain pause of the legacy program is a separate real signature |
| `/api/lp/graduate/*`, `/api/lp/founder-claim/*`, `/api/lp/coin`, `/api/lp/record`, `/api/launchpad/trade/*`, `/api/fees`, `/api/fee-status` | stay, legacy only | none | labeled legacy; dormant while no legacy coin exists |
| `/api/swap/*` | change | none; `MAIN_TOKEN_V5` for the token list | remove the configurable platform fee option (today default 0: src/cluster.js:93-97); the token list offers the configured main token with decimals read from chain (today `$VICINITY` with 6 decimals written in code, src/swap.js:360-362) and no `$VICINITY` entry |
| `/api/wallet/send/*` | stay | none | adds new-program city coins; zero platform fee |
| `GET /api/launchpad`, `/api/coin`, `/api/coin/chart` | stay; main-token card changes | `MAIN_TOKEN_V5` for the main-token card | shows new-program coins once they exist; the main-token card and its purchase links come from the configured mint (links only when a quote finds a route); no live card for `$VICINITY` |

## 7. Tests this design implies

| Area | Master checks | Tests to add when built |
|---|---|---|
| Unique wallet, challenge, host binding | A01, A02, D04 | race of two registrations (one row, same id); expired, used, wrong-purpose, wrong-wallet and wrong-host challenges; copied cookie on the other host |
| Location once | A03, A04 | schema scan finds no coordinate columns; `/api/home` refuses a located account |
| Selection | A05 to A10, D10 | fake providers: multiple token accounts, supply mismatch → `data_error`, provider disagreement, earliest cycle first, determinism of digest, triggers abort UPDATE and DELETE on `founder_records`, two concurrent runs (one lease holder) |
| Managers and activity | A12, A13 | each requirement's error; crafted decide from admin, moderator and founder → 403; requalification on reversal; `activityTotals` equals the cached totals |
| Metadata and launch | M01 to M04, B01, B03, A11 | founder cannot write active metadata; open-request uniqueness; stale base; post-launch refusal; launch record idempotency; zero platform launch fee decoded |
| Hourly | B07 to B10 | crash between send and confirm; replay; insufficient samples carry; leaves owed until paid |
| Configuration | §16 acceptance; amendment 01 | `test/masterpolicy.test.js` (exists; 33 tests passing on 24 Oct 2026, 7 of them for amendment 01: the policy fields, legacy-only occurrences, `mainTokenConfig`, `officialLinks`, `validateDeploymentConfig` and the switch mapping) |

## 8. Dependencies and items not verified

- **Real external actions** (not performed, not assumable): two historical balance providers and their secrets; an independently
  hosted selection verifier and two hourly verifier services; selection publisher, verifier, metadata-admin, keeper and treasury
  keys generated by people on their own machines; Squads signatures for the program deployment, the 48-hour time lock (today 0
  seconds, read above), the guardian multisig and quote-config onboarding; the owner's signature to pause legacy launches; an
  outside audit of every new program instruction; the 48-hour shadow and 72-hour observation periods (§37); the owner's real
  review decisions on manager applications and metadata proposals; the owner's new main-token mint, official X address and official
  Telegram address, each verified before use (amendment 01).
- **Not verified here:** that D1 enforces the triggers and partial indexes above (run on a D1 copy); the current D1 row-size
  limit for uploads; which history tables exist in the production database (needs the count-only census); the exact candidate
  exclusion list for program role keys, which depends on the final program.
