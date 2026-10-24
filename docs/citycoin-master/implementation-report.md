# Citycoin.dev implementation report

This is the living completion report that master change order v5 (23 October 2026), section 43, requires. It was started on 24 October 2026. Every stage below updates it when its pull request merges, and again when its switch moves.

> **Status on 24 October 2026:** nothing that master v5 requires is merged to main, deployed, audited or activated. The live site is main `4aa408e`. The draft custom program `vicinity_curve` is at `ec148c2` and is not deployed anywhere public. All four release statuses in section 1 are "not done". Two of the 50 acceptance checks (B02 and D09) already hold today. They hold because of existing code and unchanged identifiers, not because of any v5 work; D09 holds only for its legacy half since owner amendment 01 (section 7). Section 7 gives the evidence for both.
>
> **Owner amendment 01 (24 October 2026):** the main token becomes a new Solana mint supplied by the owner, configured in one place (`MAIN_TOKEN_MINT`) and verified on chain before use; the new official X and Telegram addresses are configured the same way (`OFFICIAL_X_URL`, `OFFICIAL_TELEGRAM_URL`). `$VICINITY` becomes a legacy token, and nobody's holdings are swapped or migrated. The owner has not supplied any of the three values yet, so all three are empty. Stage S02A builds the central configuration; external dependency E18 is the owner's verified values. Details: `amendment-01-new-main-token.md`.

## Contents

1. Four separate statuses
2. Baseline: what is live today
3. Work present in this worktree (uncommitted)
4. Delivery package (section 43) status
5. Switches (proposed; none exists at `4aa408e`)
6. Ordered stages, one pull request each
7. Status of the 50 acceptance checks
8. Real external dependencies
9. Release gates for financial activation (section 37)
10. Decisions the master already made, and owner actions that stay real
11. How to run the current code; tests run for this report
12. Commands run for this report
13. Update log

### How to read this report

- **"Today"** means the live site at main `4aa408e`. The worktree is on branch `claude/gifted-hamilton-cl6bct`, and `git diff --stat 4aa408e` shows no tracked file changed. Paths without a prefix are relative to the repository root. `curve:` paths point into the draft program checkout at `ec148c2`, relative to its `solana/` folder.
- Every statement about the current system cites `path:line` or a command listed in section 12. The inputs were five working reconciliation notes covering identity, selection and roles, metadata and launch, programs and money, and brand, domain and UI. They are working files outside the repository, and their content is consolidated in `00-reconciliation.md`, `rebrand-inventory.md` and `schema-and-api.md`. Every fact this report takes from them was re-checked in code or by a command run for this report.
- **Stage** means one pull request. **Switch** means a `wrangler.jsonc` variable read like today's switches in `src/flags.js`. Changing a switch is its own pull request, following the repository's existing rule (wrangler.jsonc:35, 38). **Closes** names the acceptance checks whose full pass condition is verified at that stage. **Advances** names checks that the stage builds part of.
- This report contains no estimates of time or cost.

## 1. Four separate statuses

Master sections 08 and 43 require these four statuses to be reported separately. All four are **not done**.

| Status | Today | Done means | Stages |
|---|---|---|---|
| **Source code readiness** | **Not done.** No v5 change is on main. Uncommitted drafts exist in this worktree (section 3). None of them is reviewed, merged or imported by a live module. | Every code stage (S01 to S54, S57, S59) is merged on main, and its checks pass in the repository test environment, with commands and results in `test-report.md`. | S01 to S59 |
| **Preview deployment** | **Not done.** No preview environment exists: `workers_dev` and `preview_urls` are false (wrangler.jsonc:13-14), and there is one D1 database (wrangler.jsonc:139). | A separate preview Worker with its own D1 database and no cron runs the v5 code. The rehearsal evidence of S45 and the screenshots of S59 are recorded from it. | S05, S45, S59 |
| **Domain cutover** | **Not done.** citycoin.dev has Cloudflare NS records and no A, AAAA or CNAME record. www.citycoin.dev does not resolve (DNS over HTTPS, 24 Oct 2026 04:03 UTC). The Worker's routes are vicinity.city and www.vicinity.city only (wrangler.jsonc:130-133). | S55 is live: Citycoin.dev on both hosts, citycoin.dev canonical and indexable. S56 is live: old public pages redirect with 308. The synthetic probes are green through the observation period. | S03 to S06, S53 to S56 |
| **Financial activation** | **Not done.** No custom program is on mainnet, no outside audit exists, and no city coin is listed (`/official-coins.csv` answered 200 with an empty body; src/officialcoins.js:236-237 defines that as "no official coin yet"). The legacy launchpad accepts launches (`launches_paused = 0`). The Squads time lock is 0 seconds. Both come from the RPC read for this report at slot 460707501. | S60 to S63 are complete with every section 37 gate met (section 9). Each additional quote path (S64) is reported as its own activation. | S57 to S64 |

**Provider settings changed: none. Prepared: none yet.** Master section 08 requires actual and prepared provider changes to be reported apart. Each stage that touches a provider adds a row here.

| Provider setting | Prepared (reviewable file or command) | Actually changed (with evidence) |
|---|---|---|
| (none yet) | | |

## 2. Baseline: what is live today

| Fact | Value | Evidence |
|---|---|---|
| Worker | One Worker, `vicinity-map` | wrangler.jsonc:7 |
| Routes | `vicinity.city`, `www.vicinity.city` (custom domains) | wrangler.jsonc:130-133 |
| Requests that reach the Worker | `/api/*`, `/coin-meta/*` and `/official-coins.csv` only; pages are served from static assets | wrangler.jsonc:124 |
| Scheduled job | One cron, every 10 minutes, guarded by a D1 lease | wrangler.jsonc:141; src/jobs.js:23-37 |
| Database | One D1 database, `vicinity-claims` | wrangler.jsonc:139 |
| Old-host redirect | `www.vicinity.city` and `http://` requests get a 301 for every method, but only on Worker-first paths, so pages are served without a redirect. The code also lists `vicinitycity.net`, which is not routed to the Worker today (wrangler.jsonc:127-129). | src/index.js:691-706 with wrangler.jsonc:124 |
| Sign-up | Sign-up v2: location, then Google or email, then wallet later. The account is created with `wallet = NULL`. Live `/api/me`: providers google and email, `signupFlow` v2 | wrangler.jsonc:39; src/signup-finish.js:41-46; GET `/api/me` |
| Wallet sign-in | Finds the account by `users.wallet`; an unknown wallet gets 404 `no_account` and nothing is created | src/auth.js:219-220 |
| Founder rules | Policy version 6: Stake Ladder, 7 qualifying days. Live `/api/policy`: version 6, effective 2026-10-16, `qualifyingDays` 7 | src/policy.js:20-36; GET `/api/policy` |
| Founder seats | 0 seats, 0 open windows | GET `/api/seats` |
| Country managers | Elected for 90 days | src/elections.js:1-13 |
| City-coin path | Legacy `vicinity_launchpad` on Meteora DBC/DAMM v2, trading switch on. Live config: 85 SOL target, 1.25% fee, 0.05 SOL launch fee. A launch needs an owner-signed approval; the program checks the approved wallet, the expiry and the pause. | wrangler.jsonc:59-61, 71-72, 78-80; src/lpadmin.js:864 |
| City coins listed | None | GET `/official-coins.csv` (200, empty body) |
| Coin-v2 stages | `COIN_V2_READY`, `COIN_V2_REVIEW` and `COIN_V2_BATCH` are all off | wrangler.jsonc:97, 103, 109 |
| Swap platform fee | 0. It defaults to 0 when `SWAP_PLATFORM_FEE_BPS` is unset; the variable is not in wrangler.jsonc | src/cluster.js:93-96; GET `/api/swap/config` |
| Main token on the live site | `$VICINITY`, mint `2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray`. Classic SPL Token, 6 decimals, no mint or freeze authority, raw supply 999,999,999,999,990. Under owner amendment 01 it becomes a legacy token (history only) once S02A is switched on; the new main-token mint is not supplied yet. | wrangler.jsonc:32; RPC read, slot 460707501 |
| Official social links on the live site | X `@VicinityCitySOL`, in every page footer (built from src/official.js:24-26 by scripts/pages/build.mjs:91-96); no Telegram. Both become central configuration under amendment 01; the X account becomes a legacy link. | src/official.js:21-26 |
| Legacy Launchpad PDA `4g9KRZ76Mpw6HCCu713yEGzm1txdCod3S1SugL7M9GwN` | Owner `AkMP9q…A1Ai`; admin `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN`; no pending admin; `launches_paused = 0`; `payouts_paused = 0` | Derived locally with src/sol/pda.js; RPC read decoded with solana/programs/vicinity-launchpad/src/state.rs:11-27 |
| Squads multisig `6v8hwKYSAWXXx6ZGGmvbg87n8eVy9MAgNruFgVqRFjYV` | Threshold 2, time lock 0 seconds | RPC read, slot 460707501 |
| Site admin | `13qRam…sRiN` | wrangler.jsonc:36 |
| Draft program | Launch needs an admin `Approval` or a batch leaf. It charges a 50,000,000-lamport launch fee to `FEE_RECIPIENT = 13qRam…`. It has `transfer_founder`. It is SOL only (`buy(sol_in, …)`). Its metadata prefix is `https://vicinity.city/coin-meta/` | curve:programs/vicinity-curve/src/lib.rs:132, 153, 158, 189, 255; …/constants.rs:18, 217; …/instructions/launch.rs:328-340; curve:crates/vicinity-curve-math/src/types.rs:66-78 |

## 3. Work present in this worktree (uncommitted)

`git status` on 24 Oct 2026 lists these untracked files. **None is committed, merged, deployed or imported by a live module.** They are the starting material for the stages named, and they still need review in those stages.

| Files | What they are | Stage |
|---|---|---|
| `docs/citycoin-master/00-reconciliation.md` | Reconciliation of earlier work against master v5 (master section 15 evidence) | S01 |
| `docs/citycoin-master/rebrand-inventory.md` | BR-01 inventory: every "vicinity" match, classified | S02 |
| `docs/citycoin-master/policy.json`, `src/masterpolicy.js`, `test/masterpolicy.test.js` | The v5 policy document, its frozen mirror and pure helpers, and its test. Updated for owner amendment 01 (`main_token`, `legacy_tokens`, `official_links`, the `MAIN_TOKEN_V5` switch and three inputs; `mainTokenConfig`, `officialLinks`, `validateDeploymentConfig`). `node --test test/masterpolicy.test.js` passed 33 of 33 after the amendment (26 of 26 before it). | S07, S02A |
| `docs/citycoin-master/amendment-01-new-main-token.md` | Owner amendment 01: the instruction, what changes, the configuration keys and their validation, the verification procedure, every consumer of the legacy mint and every social-link location at `4aa408e` | S02A |
| `docs/citycoin-master/schema-and-api.md` | Schema and API design, marked "DESIGN. NOT BUILT." | S07, S08 and later |
| `docs/citycoin-master/authority-map.md` | Read-only authority map: CURRENT values from read-only RPC and code, TARGET roles from master section 36, and the steps between them. Nothing in it is signed or changed. | S01 (read-only map), S57 |
| `docs/citycoin-master/brand/README.md`, `public/brand/*` (wordmark, icon, mono (navy and white), lockup and app-icon SVGs; favicon 16, 32 and 48 px and .ico; apple-touch 180 px; icons 192 px, 512 px and maskable; Open Graph image 1200 x 630; `tokens.css`) | Draft logo family and design tokens. Structure, renders, raster reproduction and contrast math were re-checked independently on 24 Oct 2026 (brand/README.md, "Verification"); V01 is still open (no browser, device or owner review). | S46, S47 |
| `docs/citycoin-master/implementation-report.md` | This report | every stage |

## 4. Delivery package (section 43) status

| File or folder | Status | Completed in |
|---|---|---|
| `00-reconciliation.md` | Drafted, uncommitted | S01 |
| `rebrand-inventory.md` | Drafted, uncommitted | S02 |
| `domain-cutover.md` | Not started | Started in S03, finished in S56 |
| `policy.json` + `schema-and-api.md` | Drafted, uncommitted | S07, S08 |
| `brand/` + `architecture/` | `brand/README.md` drafted; `architecture/` not started | S46, S52 |
| `selection-proof.md` | Not started | S17, S18, S45 |
| `metadata-review.md` | Not started | S25, S45 |
| `hourly-operations.md` | Not started | S42 to S45 |
| `authority-map.md` | Drafted (read-only map), uncommitted | S01 (read-only map), S57 |
| `amendment-01-new-main-token.md` (owner amendment 01) | Drafted, uncommitted; verification records empty (no value supplied) | S02A; records added with the configuration pull request |
| `test-report.md` | Not started | Every stage adds rows; S59 completes it |
| `release-manifest.json` | Not started | S01 (baseline), S38, S57, S59 |
| `deploy-runbook.md` | Not started | S54, S59 |
| `implementation-report.md` | Started (this file) | Every stage |

## 5. Switches (proposed; none exists at `4aa408e`)

Today's switches are the ones in `src/flags.js`. None of the switches below exists yet. Each default reproduces today's behavior exactly. The names follow `schema-and-api.md` section 2.2, which also lists each switch's named validation errors. The last block comes from the brand, domain and UI reconciliation.

| Switch | Values (default first) | Turns on |
|---|---|---|
| `SITE_ORIGIN`, `SITE_ORIGINS` | today's hosts | Canonical origin and the allowlist of accepted hosts (configuration, not a feature switch) |
| `HOST_REDIRECT` | off, on | 308 from old public GET and HEAD pages to citycoin.dev |
| `WALLET_ONLY` | off, on | Wallet-only sign-in and registration; location once |
| `LEGACY_LINK` + `LEGACY_LINK_UNTIL` | off, on | Time-boxed wallet-link window for Google- or email-only accounts |
| `LEGACY_SEATS` | on, frozen | "frozen": every seat, squad, endorsement, objection, resign and election writer answers 410 |
| `SELECTION_V5` | off, shadow, on | Six-hour snapshot engine; "shadow" writes dry-run cycles only |
| `FOUNDER_RECORD_CHAIN` | off, on | Reads and mirrors on-chain FounderRecords |
| `ACTIVITY_POINTS` | off, shadow, on | Activity ledger |
| `MANAGER_APPS` | off, on | Country-manager applications and the owner inbox |
| `METADATA_V5` | off, on | Protected defaults, founder requests, owner metadata inbox |
| `LAUNCH_V5` | off, on | Self-service launch on the custom program (one reconciliation note called this `CC_LAUNCH`) |
| `LEGACY_LAUNCH` | on, off | "off": the website builds no legacy approval, batch or launch |
| `CC_TRADING` | off, on | Buys and sells on the custom curve and pool |
| `CC_HOURLY` | off, shadow, on | Hourly processing; "shadow" computes and publishes evidence and sends nothing |
| `PUBLIC_V5` | off, on | Public structure, `/architecture`, `/fees`, `/status`, `/api/status`, and the policy `master` key |
| `BRAND` | unset, citycoin | Product labels (build time and Worker text) |
| `DASHBOARD_V5` | off, on | The DS-05 dashboard structure |
| `INDEXING` | off, on | Indexing for production only; preview always stays noindex |
| `MAIN_TOKEN_V5` + `MAIN_TOKEN_MINT`, `OFFICIAL_X_URL`, `OFFICIAL_TELEGRAM_URL` | off, on (the three values unset) | Owner amendment 01: every main-token consumer reads the verified `MAIN_TOKEN_MINT`, `$VICINITY` is shown as legacy, and the footer and link checker use the configured official links (empty means not shown). Validation refuses the switch without `MAIN_TOKEN_MINT` (`MAIN_TOKEN_MINT_MISSING`); in `src/masterpolicy.js` `FLAG_VALUES`. |
| theme switch | off, on | Civic Atlas default with its dark counterpart. The name is not fixed yet; one reconciliation note used `THEME_V5` as a placeholder. |

## 6. Ordered stages, one pull request each

The phases follow master section 01 ("Ordered execution") and section 37 ("Migration order"). A stage may merge earlier than its position only when its dependencies allow it. The order in the list is the master's.

How section 37's migration order maps to the stages:

| Section 37 step | Stages |
|---|---|
| 1. Record branch and deployment state; validate backups | S01; backups in S08 and S55 |
| 2. Add and backfill the master schemas | S04, S08 (each group lazily, per switch) |
| 3. Map verified permanent founders and existing coins | S08, S16. Today there are 0 seats (GET `/api/seats`) and no listed city coin (GET `/official-coins.csv`), so nothing is expected to map. The census confirms it before cutover. |
| 4. Deploy compatible API reads with the old writers paused | S16, S23 |
| 5. Remove seven-day, rotation, Google and GPS-return gates; wallet-only in preview or testnet | S13, S15, S16 |
| 6. Reproducible holder snapshots; dry-run one-time selection | S17, S18 |
| 7. Rehearse custom launch, trade, pairs and hourly distributions with duplicate and recovery tests | S45 |
| 8. Build hashes, authority map, registry and policy versions, independent audit package | S38, S57, S59 |
| 9. Legacy new-launch disable plus cross-program duplicate checks | S35, S58 |
| 10. Deploy production flags disabled; enable only with passing evidence and real signing authority | S60 to S64 |

### Phase 1. WP-00: baseline and reconcile

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S01** Baseline record and reconciliation | `00-reconciliation.md`; this report; `authority-map.md` from a re-runnable read-only RPC script (legacy admin, registry admin, upgrade authorities, multisig threshold, time lock and members); `release-manifest.json` with the baseline revision, Worker, routes, D1 name, cron, program IDs and current switch values; a full `npm run build` and `npm test` run with every pre-existing failure recorded | none | No change. Documents and a read-only script only. | Advances D12 | none |

### Phase 2. BR-01: inventory

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S02** Rebrand inventory, adapters and guards | `rebrand-inventory.md`; `scripts/brand/residual.mjs` (classifier, report-only until S48); `test/persist-guard.test.js` (program IDs, the live metadata URI prefix, stored enum values, hash domains, storage keys); `src/brand.js` and `src/site-config.js` adapters, with a build-parity test proving that unset values give today's bytes. The `mainMint(env)` reader is S02A (owner amendment 01: it reads `MAIN_TOKEN_MINT`, never `VICINITY_MINT`). | `BRAND`, `SITE_ORIGIN`, `SITE_ORIGINS` unset | No change; the parity test proves byte-identical pages | Advances D01, D09 | S01 |
| **S02A** Central main-token and official-link configuration (owner amendment 01) | Adapters `mainMint(env)` and `officialLinks(env)` built on `mainTokenConfig` and `officialLinks` of `src/masterpolicy.js`; `validateDeploymentConfig` at the first request and each job start. Every consumer listed in `amendment-01-new-main-token.md` sections 5 and 6 moves behind the switch: the token page, `/api/token`, `/api/holders`, `/api/rank`, `/api/verify`, the holder list and its labels (the `$VICINITY` team lock, team listings and LaunchLab pool become legacy facts), balance sampling with mint-keyed history, the official list and /official page, the link checker, the footer social icons, the swap token list (decimals read from chain) and Buy-panel default, purchase links (shown only after a live quote finds a route), portfolio, profiles, map and dashboard displays, and the preflight. `$VICINITY` is shown as a legacy token with no swap offered; holders keep their tokens. The "launched" flags keep meaning "`$VICINITY` launched on 3 Oct 2026". A build-parity test proves today's bytes with the switch off. | `MAIN_TOKEN_V5` (off); `MAIN_TOKEN_MINT`, `OFFICIAL_X_URL`, `OFFICIAL_TELEGRAM_URL` unset | **No change at merge.** Only a later configuration pull request, after the owner supplies the values and their verification records exist, sets them and turns the switch on. Then the main token is the new mint everywhere, `$VICINITY` is labeled legacy, and the footer shows only the configured links. | Advances A05, A06, A07, A12, B04, D09, V05, V06 | S02; external E18 for the switch-on only |

### Phase 3. BR-02 and BR-03: domain, routes and sessions

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S03** Host-safe routing and redirects | The canonical host comes from `SITE_ORIGIN`, replacing the literals at src/index.js:691-692. Non-canonical hosts answer 308 for GET and HEAD, and 421 JSON `wrong_host` with no `Location` for every other method. Pages on non-canonical hosts and on `http://` reach the Worker (`run_worker_first` or zone Redirect Rules). The query filter drops hand-off parameters. Excluded paths are served in place: `/coin-meta/*`, `/brand/vicinity-512.png`, `/official-coins.csv` and GET `/api/*`. Cross-domain redirects run only under `HOST_REDIRECT`. Starts `domain-cutover.md`. | `HOST_REDIRECT` (off) for cross-domain | **Changes live behavior at merge on today's hosts only.** `www.vicinity.city` and `http://` page visits redirect to `https://vicinity.city`; today they are served without a redirect. A non-GET request to `www.vicinity.city` gets 421 instead of today's 301. This is the only stage that changes live behavior without a switch, so it is reviewed on its own. If `run_worker_first: true` is chosen, every page request becomes a Worker request (wrangler.jsonc:122-123). | Advances D03, D05 | S02 |
| **S04** Session and challenge host binding | A nullable `sessions.host` column, added by a lazy additive migration (NULL is read as vicinity.city). `getSession` refuses a session row made on another host; today it finds a session by token hash alone (src/auth.js:125-135). Hand-off, QR and challenge hosts come from `SITE_ORIGINS`, never from the request `Host` header. A `Host` outside the allowlist is refused. | Effective once `SITE_ORIGINS` lists a second host | No change with today's values | Advances A02, D04 | S03 |
| **S05** Preview environment | `env.preview` in wrangler.jsonc: its own Worker name and D1 database, route `preview.citycoin.dev`, preview site mode, `X-Robots-Tag: noindex`, no cron trigger | Separate environment | Production unchanged; a separate preview Worker exists after the first preview deploy | Advances D02 (preview isolated), D10 (only production has a cron) | S03; external E1 |
| **S06** Attach citycoin.dev | Routes `citycoin.dev` and `www.citycoin.dev` on the existing Worker; both added to `SITE_ORIGINS`; www redirects with 308 to the apex; citycoin.dev pages carry noindex. vicinity.city stays canonical. | `SITE_ORIGINS` (configuration PR); `HOST_REDIRECT` off; `INDEXING` off | citycoin.dev answers over HTTPS with the current site, unannounced and not indexed. Same Worker, same D1 and the same single cron, so no second scheduler. vicinity.city is unchanged. | Advances D02, D04 (real two-host run), D10 | S03, S04, S05; external E1 |

### Phase 4. WP-01: policy and schema

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S07** Shared v5 policy and configuration validation | Commit `policy.json`, `src/masterpolicy.js` and its test (section 3). `validatePolicy` runs at the first request and at each job start and returns named errors. `/api/policy` gains the `master` key and `/api/policy/master` exists. | `PUBLIC_V5` (off) for the public key | No change. Every switch at its default leaves today's answers as they are (src/index.js:426-428). | Advances A07, A08, A13, B05 (pure helpers: cycle math, fee split, activity totals) | S01 |
| **S08** Additive D1 schema, migration tests, census | Lazy, per-switch statement-list migrations for the identity, selection, founder-mirror, activity, manager, metadata, launch and hourly groups (`schema-and-api.md` section 3). Append-only triggers are tested on a D1 copy. `signup_completed_at` backfill rule. A census script that records counts and hashes only, never member data. A backup step before each migration. | Each group is created only when its switch first leaves its default | No change | Advances A14, B14, D08 | S07; external E9 (census and backup access) |

### Phase 5. WP-02, WP-03 and BR-03: wallet-only sign-in and location once

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S09** Server challenge service | `auth_challenges` (nonce hash, purpose, host from `SITE_ORIGINS`, cluster, wallet, 120-second expiry, single use); `POST /api/auth/challenge`. A v2 signed-message check consumes the challenge in the same D1 batch that creates the session, and fails closed. Today a message is accepted when the used-message store cannot answer (src/signed.js:64, 76-86). Statements name Citycoin.dev and keep the "free, not a transaction" sentence. | `WALLET_ONLY` (the route answers 404 when off) | No change until switched | Advances A02 | S04, S08 |
| **S10** Wallet-only sign-in and sessions | Login purpose only; `__Host-` session cookie; `sessions.auth`; a wallet account-change listener signs out and clears local state; logout disconnects the wallet adapter; the tiny-transfer proof and unlink are off; the admin page uses the challenge | `WALLET_ONLY` | When switched: sign-in is wallet only | Advances A01, A02, A04, D04 | S09 |
| **S11** First-time registration API | Location before wallet, enforced on the server. A wallet-keyed atomic register batch (`ON CONFLICT(wallet)`; `users.wallet` is UNIQUE, src/store.js:55). Register hand-off (5 minutes; codes travel only in POST bodies) and register pairing. The old account routes and the in-wallet-app location hand-off answer 404. | `WALLET_ONLY` | When switched: new accounts are created from a wallet proof after location | Advances A01 (race), A03 | S10 |
| **S12** Connect page UI and copy | "Sign in" and "Register your city" paths; no Google, email or password controls; the `no_account` screen; DS-06 first-registration and returning-login messages; wallet-app browsers are offered "Open in Safari or Chrome" | `WALLET_ONLY`, read through `/api/me` | When switched: the connect page offers the wallet only | Advances A03, A04, V03 | S11 |
| **S13** Location once | `/api/home` is allowed only for an account that was never located; today a home can be changed every 7 days (src/me.js:30). The attestation purpose is `home` only. No new check-in posts; today they require a location attestation (src/social.js:221-230), and old check-ins stay readable. A town request needs no GPS. The check-in clause leaves the voter rule. The dashboard check-in and home-change controls are removed. | `WALLET_ONLY` | When switched: no location prompt after registration | Advances A04 | S10; together with S16 |
| **S14** Legacy link window | Legacy login only at `/connect?mode=legacy`, giving a restricted 15-minute session that can only link a wallet; 410 after `LEGACY_LINK_UNTIL`; disown refused for a wallet that holds a FounderRecord | `LEGACY_LINK` + `LEGACY_LINK_UNTIL` | When switched: Google- or email-only members can link a wallet until the end date | Advances A14, D04 | S10 |
| **S15** Switch-on: wallet-only | Configuration PR, preview first, then production: `WALLET_ONLY=on`, `LEGACY_LINK=on`, `LEGACY_LINK_UNTIL=<date>`. The window length is a delegated implementation choice, recorded here when chosen. Sessions not made by a wallet proof are revoked. Notice text for affected members. | `WALLET_ONLY`, `LEGACY_LINK` | Google, email and password registration and login stop. Wallet-linked members sign in with their wallet as before (src/auth.js:219). Google- or email-only members use the link window. | **Closes A01, A02, A03, A04** (repository and preview runs; physical-device cases stay labeled until devices are available) | S09 to S14; census (E9); revised Terms text (E12) if the text changes; devices (E13) |

### Phase 6. WP-04 and WP-05: six-hour snapshots and permanent founder (website side first)

The on-chain FounderRecord is built with the program changes (S33). Permanent selection is switched on only after deployment, audit and observation (S61).

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S16** Legacy seat freeze and old-rule copy removal | Every seat, squad, endorsement, objection, resign and election writer answers 410. The job skips its seats and elections steps (src/jobs.js:46-47), and streak updates stop. The founder branch of `canModerate` is removed (src/roles.js:63-64). Seven-day, ladder, steward, squad and election copy is removed from pages and dashboard, for example scripts/pages/src/index.html:48, 104, 112, 115. History reads stay. | `LEGACY_SEATS=frozen`; the copy follows the same switch at build time | When switched: no new seat claim, endorsement or election. No member loses a role: 0 seats and 0 open windows today (GET `/api/seats`). | Advances A05, B12, V05 | S07, S08 |
| **S17** Snapshot engine (read side) in shadow | Cutoff resolver: the finalized slot at or before each 00, 06, 12 and 18 UTC boundary, with a recorded time-to-slot mapping. Two independent historical providers. Completeness: the sum of all token accounts equals the raw supply at the cutoff slot, and both providers agree. Candidates from `city_assignments` and `signup_completed_at`, with exclusions published. Ranking: raw balance descending, signup time ascending, key bytes ascending. Receipt, digest and Merkle root; per-cycle claims; `/api/selection/status` and `/api/selection/city/:id` with provisional labels; alerts for missed cycles and divergence. Today's holder reader makes one latest-state read with no chosen slot (src/chain.js:272). | `SELECTION_V5=shadow` (dry-run cycles; no founder is written) | When switched: provisional ranking data exists; the UI comes in S50 | **Closes A05, A07**; advances A06, A08, A09, D10 | S08, S16, S02A (balances of the configured main-token mint; validation refuses shadow without `MAIN_TOKEN_MINT`); external E5 (two historical providers), E18 (the verified main-token mint) |
| **S18** Independent selection verifier | A separate service with its own credentials and provider recomputes each receipt and signs only an identical digest. Disagreement keeps the cycle in Processing. The agreement rate appears on `/api/selection/status`. | `SELECTION_V5=shadow` | Status data only | **Closes A06, A09** (with real providers; fixture runs before that) | S17; external E4, E5 |
| **S19** Founder source switch (dark) | Powers, profiles, posting permission, vote weight and the coin flow read `founder_records`. Every live-balance founder gate is removed; today launch requires a live seat and the founder amount (src/lplaunch.js:95-105). A suspension is a separate `blocked` flag and never touches identity. | Active only under `SELECTION_V5=on`, which requires the on-chain record (S61) | No change until S61 | Advances A10, A11 | S17 |

### Phase 7. WP-06 and WP-06A: country managers and activity points

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S20** Activity ledger | Append-only `activity_events`; post and reply crediting after moderation settles; duplicate, spam, self-reply and daily-limit rules; category caps 40, 20, 20, 30 and 20; reversals; initiative and proposal evidence with a moderator and owner review queue; backfill only from verifiable records; notices | `ACTIVITY_POINTS` (shadow, then on) | When on: members see their point ledger | Advances A13 (every case except the launch award) | S08, S16 |
| **S21** Country-manager applications and owner inbox | National ranks from each verified cutoff; a dashboard Apply flow with one error per unmet requirement; owner-only inbox and decision routes with audit rows; Needs requalification; one active manager per country; replace and revoke with audit; `managerOf` reads `country_managers`. Elections stay frozen; today managers are elected for 90 days (src/elections.js:1-13). | `MANAGER_APPS` (validation requires `SELECTION_V5=on` and `ACTIVITY_POINTS=on`) | When on: eligible founders can apply, and the owner decides | **Closes A12** (repository tests through the real owner route with a test-only admin wallet) | S17, S19, S20; S02A and E18 (national rank on the configured main-token mint) |

### Phase 8. WP-07 and WP-07A: metadata defaults and owner review (website side)

The launch routes depend on the program changes, so they are S41 in phase 9.

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S22** Canonical metadata v2 (pure) | `renderDescription` with city, state or region (or an explicit "no state or region"), country and the selected quote; content v2 with IDs, attribution and normalization version; per-quote JSON and hash; Citycoin.dev brand constants for new-program coins; coin-art template t2 (t1 is kept so stored hashes stay valid) | none (not wired to routes) | No change | Advances M01 | S07 |
| **S23** Retire superseded launch gates | The `LEGACY_LAUNCH` switch. "off" means the website builds no legacy approval, batch or launch, and the founder studio route closes; today that route lets a founder set name, description and pair (src/coins.js:158-162). Deletes `COIN_V2_BATCH`, `src/lpbatch.js` and their UI, docs and tests. | `LEGACY_LAUNCH` stays on until S58 | No change at merge: `COIN_V2_BATCH` is off (wrangler.jsonc:109) | Advances B11, B14, V05 | S22 |
| **S24** Metadata schema and founder request API | `city_metadata_*` tables. One founder request: ticker, image, descriptive text, reason and base version. Image pipeline: PNG, JPEG or WebP up to 10 MB and 4096 x 4096 pixels, metadata stripped, file signatures checked, SVG and HTML refused. The screener is advisory only. The founder is resolved from the FounderRecord interface, which answers `founder_record_unavailable` until S61. | `METADATA_V5` | No change until switched | Advances M02, M04 | S08, S19, S22; external E14 (Workers CPU for image decoding) |
| **S25** Owner-only metadata inbox | Owner role only, for list, image preview and decision; today any admin decides and moderators may view (src/admin.js:791-797). Current and proposed diff with final per-quote descriptions and hashes. Approve, then publishing, then active only after chain confirmation; database-only publication is allowed on preview only, until S34 exists. Reject with a note. | `METADATA_V5` | No change until switched | Advances M03, M04 | S24 |
| **S26** Launch-center UI | Read-only default preview with a pair display selector; "Request metadata change" form; status and launch-lock notice; DS-06 "Metadata" message | `METADATA_V5` | No change until switched | Advances M01, M02, V03 | S25 |
| **S27** Permanent metadata endpoints and mirror | `/coin-meta/*` on citycoin.dev under a versioned prefix for new-program coins. `vicinity.city/coin-meta/*` and `/brand/vicinity-512.png` are served in place and never redirected. An independent mirror on a separate hostname; an availability monitor; registry build, verify, diff and restore scripts. | Mirror writes under `METADATA_V5` | No change for existing URLs | Advances D03, D11, M03 | S06; external E1 (mirror bucket) |

### Phase 9. WP-08, WP-08A and section 29: generic quotes and the program changes

Program stages S28 to S38 are pull requests on a branch from `feat/vicinity-curve` at `ec148c2`. In these stages the program is never deployed to mainnet. Devnet uses throwaway program IDs only, and initialization starts with launches, buys, buybacks and selections halted.

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S28** PU-1 Program identity | Rename crate, module and IDL to Citycoin names. The metadata prefix becomes citycoin.dev with a version segment (today `https://vicinity.city/coin-meta/`, curve:…/constants.rs:217). New leaf tag. Legacy program IDs and their derivation tests are kept. Must land before the audit build is frozen. | not deployed | none | Advances D01, D09 | none |
| **S29** PU-2 Fee policy in config | Remove the launch fee from the launch path and the config; today config #0 charges 50,000,000 lamports to `FEE_RECIPIENT` (types.rs:77; launch.rs:328-340). Program-enforced rule `25 * buyback_bps <= 3 * total_fee_bps`. Keep the 50/70/50/50/30 split (types.rs:67-71). | not deployed | none | Advances B01, B05, B10 | S28 |
| **S30** PU-3 Treasury and fixed-destination payouts | A `TREASURY` constant: a dedicated address supplied by the owner, with a devnet placeholder that a mainnet build refuses. It replaces `FEE_RECIPIENT = 13qRam…` (constants.rs:18). Permissionless founder payout to the coin's founder. Remove the opt-in, payout key, cooldown, `payouts_paused` and `transfer_founder` (lib.rs:189). Keep `claim_founder_fees` as the wallet-signed fallback. | not deployed | none | Advances A10, B07, B13 | S29; external E7 before the mainnet build |
| **S31** PU-4a Quote configs: accounts and validation | `QuoteConfig` accounts; add and enable by governance only; classic-SPL safety rules (Token-2022 refused; a city coin as its own quote refused); a named-default flag for USDC with disclosure; per-quote minimum buy and graduation. Seeds: SOL; USDC with 10,000 graduation; the main token with 1,000,000-unit graduation and a minimum buy of 1 unit, its mint and decimals taken from the verified `MAIN_TOKEN_MINT` (owner amendment 01; never `$VICINITY`, which is a legacy token), so its raw amounts are fixed only when the mint is known. | not deployed | none | Advances B04 | S29; S02A |
| **S32** PU-4b Quote custody and trading | A quote vault per coin (WSOL for SOL); a debit helper per bucket; buy, sell, buyback, withdraw, claim and payout over `transfer_checked`; Coin layout version 2. Today the draft is SOL only (lib.rs:158). | not deployed | none | Advances B04, B05, B06, B10 | S30, S31 |
| **S33** PU-5 FounderRecord and selection authority | A FounderRecord PDA per canonical city holding city, country, founder, cycle, cutoff slot, snapshot hash, policy version, selection time, publisher and verifier. It is created once with `init`: the publisher proposes, and the verifier confirms identical fields. Guardian or admin may cancel only a pending selection. No update, close or transfer instruction. Selections are halted at initialization. | not deployed | none | Advances A10, A11, B13 | S28; external E4 (keys made by people on separate infrastructure; this work never creates keypairs) |
| **S34** PU-6 Registry versions and metadata review lock | `RegistryVersion`: a write-once root with an activation time, published by governance. `CityMetadata` active version. `ReviewLock` from a founder-signed proposal hash. The metadata admin may approve or reject only for an unlaunched city. Refused after launch. | not deployed | none | Advances B03, M02, M03, M04 | S33 |
| **S35** PU-7 FounderRecord-gated launch | `launch(city, quote config, expected metadata hash)`: the signer equals the FounderRecord founder; registry proof; active metadata version; no ReviewLock; enabled config; legacy and new duplicate checks kept; zero platform fee; distribution state initialized. Remove `approve_launch`, `revoke_approval`, `Approval`, the batch path (lib.rs:255), the launch approver and `forward_holders_fees`. | not deployed | none | Advances A11, B01, B03, M03 | S32, S33, S34 |
| **S36** PU-8 Hourly holder distribution instructions | Two root verifier keys. `publish_holder_root` requires both signatures over a domain-separated message. `HourRoot` escrow with a paid bitmap and monotonic hour IDs. Permissionless `distribute_batch` to the leaf wallet's canonical account. `claim_holder` fallback. `cancel_pending_root`. No expiry and no sweep. Today the live rewards program uses claim windows of at least 14 days (solana/programs/vicinity-rewards/src/constants.rs:48). | not deployed | none | Advances B08, B09 | S32, S35 |
| **S37** PU-9 Guardian, governance and preflight | Guardian powers are stop-only: halt selections, launches, buys and buybacks; cancel a pending selection or root; never resume, reassign, upgrade or withdraw. The preflight fails unless the guardian is a controlled 2-of-3 Squads multisig, the vault time lock is 172,800 seconds, the treasury is dedicated and the role keys are distinct. | not deployed | none | Advances B13 | S30, S33, S36 |
| **S38** PU-10 SDK, vectors, devnet deploy, audit pack | Quote-parameterized SDK and golden vectors: SOL with 9 decimals, USDC with 6, and a test mint with a third decimal count. litesvm suites. A devnet deployment with throwaway IDs. A re-issued audit pack for the new binary that lists what changed since the earlier internal reviews; those reviews are not an independent audit. | devnet only | none | **Closes B05, B06**; advances B01, B03, B04, B07 to B10, B13 | S28 to S37; external E8 (devnet SOL), then E6 (outside audit of this binary) |
| **S39** Free-transfer hardening (Worker) | Remove the swap platform-fee option (`SWAP_PLATFORM_FEE_BPS` and `SWAP_FEE_ACCOUNT`, src/cluster.js:93-96), or pin it to 0 with a startup refusal of any other value; add a decode test for swap builds; the Send line "No Vicinity fee." (src/walletsend.js:203) follows `BRAND` | none | No visible change (the live value is already 0, GET `/api/swap/config`) | Keeps B02 true | none |
| **S40** Custom-curve client (Worker) | `src/sol/cc-*.js` quote, build and decode with parity to the SDK vectors; `/api/cc/quote` and `/api/cc/tx`; custom-program city coins added to the Send list | `CC_TRADING` (off), devnet cluster | No change | Advances B02, B06, B11 | S32, S38 |
| **S41** Self-service launch routes and card (WP-07A website side) | New module with status and transaction routes: FounderRecord, policy and registry versions, enabled quotes, checklist. An itemized receipt: "Citycoin.dev platform launch fee: 0", network, priority, rent, metadata, and an optional first buy that defaults to none. Simulate and decode before the wallet opens. Ticketed exact-byte relay. Idempotent record, listing, launch event, the 40-point award and a share card. Imports no Meteora module. | `LAUNCH_V5` (preview and devnet only until S63) | No change | Advances A11, A13, B01, B03, B11, M01, M03 | S19, S20, S25, S35, S40 |

### Phase 10. WP-09, WP-09A and WP-09B: hourly automation

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S42** Hourly engine in shadow | A sampler that takes one unannounced sample in each 15-minute segment plus the cutoff. Today's 10-minute cron (wrangler.jsonc:141) puts exactly one predictable tick in the 15-30 and 45-60 minute segments, so the sampler uses a 1-minute cron or a Durable Object alarm inside the same Worker, under the D1 lease. Exclusions: vaults, treasury, keeper, verifiers, publisher, team wallets and the permanent founder. Weight = min(cutoff, average) in exact integer math. Floored allocation with carry; hours with insufficient samples are carried. `hourly_actions` keyed by cluster, program, coin, quote mint, UTC hour, action and batch. Drift and missed-hour alerts. Shadow computes and publishes evidence and sends nothing. | `CC_HOURLY=shadow` | No change on mainnet (no custom-program coin exists) | Advances B07, B08, B09, D10 | S08, S36 (devnet) |
| **S43** Two hourly verifier services | Verifier A and verifier B are deployed and credentialed separately, with separate RPC providers. They must agree on cutoff, recipient-list hash, quote, funded amount and policy, then sign the 2-of-2 root. Disagreement means no root. | `CC_HOURLY=shadow` until they agree for the whole shadow window | No change | Advances B09 | S42; external E4 |
| **S44** Keeper | Hourly platform and founder payouts; buyback runs at least 150 slots apart under the depth cap; holder push batches; recipient-account creation from the keeper's operations wallet; bounded retries with backoff; receipts; no catch-up batching after a missed hour | `CC_HOURLY=on` only after shadow evidence, devnet first | No change on mainnet | **Closes B10**; advances B07, B08, B14 (keeper restart) | S42, S43; external E4, E8 |
| **S45** Devnet end-to-end rehearsal through the preview website | Deploy the S38 binary on devnet with throwaway keys. Then, through the preview website: a selection record; a metadata request with an authenticated owner fixture; self-service launches on SOL, USDC and a third classic SPL mint; trades and graduation; hourly processing over several hours; keeper crash and restart; verifier disagreement; a recovery claim; a guardian stop. Commands and results go to `test-report.md`, `selection-proof.md`, `metadata-review.md` and `hourly-operations.md`. | `LAUNCH_V5`, `CC_TRADING`, `CC_HOURLY` on preview only | No change on production | **Closes A10, A11, A13, B01, B03, B04, B07, B08, B09, B11, M01, M02, M03, M04** (devnet evidence) | S05, S41, S44; external E1, E8 |

### Phase 11. DS-01 to DS-06, WP-10, WP-10A and WP-11: brand and theme rollout, dashboard, map and city timeline, public /architecture

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S46** Logo family and design tokens | Vector masters (wordmark light and dark, icon, mono, lockup, app icons), raster exports (favicon 16, 32 and 48 px and .ico; apple-touch 180 px; 192 px, 512 px and maskable), Open Graph image 1200 x 630, `tokens.css` (Civic Atlas light and its dark counterpart), `brand/README.md`. Drafts of all of these exist uncommitted (section 3). Today's favicon is the Vicinity mark (`aria-label="Vicinity"` in public/favicon.svg). | none | No visible change: the new files are reachable static URLs, but no page links to them until S48 and S53 | **Closes V01** (after visual checks at 16, 32 and 48 px on light and dark) | S02 |
| **S47** Theme system | One token set used by the public pages, dashboard, owner console and `/architecture`; Civic Atlas light as the default with an accessible dark counterpart; saved preference; contrast checks of the real color pairs; reduced motion. Today dark is the default (public/theme.js:2). | theme switch | When switched: the light Civic Atlas theme is the default | Advances V02, V04 | S46 |
| **S48** Label migration | Citycoin.dev across the layout (today the title reads "Vicinity", scripts/pages/build.mjs:104), page sources, client strings, Worker messages, mail templates with links from `SITE_ORIGIN`, notices, fee wording, the 404 page and the admin console. The main token shows as "Main token" with the on-chain name, symbol and mint of the configured, verified `MAIN_TOKEN_MINT` (owner amendment 01, S02A); `$VICINITY` shows only as a legacy token. Impersonation guards add "citycoin" and keep "vicinity". The residual classifier fails CI on unclassified labels when `BRAND=citycoin`. | `BRAND=citycoin` | When switched: the product name is Citycoin.dev | Advances D01, V06 | S02, S09, S46 |
| **S49** Public structure v5 | Header navigation "Explore cities / How it works / Architecture / Fees"; "Connect wallet" and "Register your city"; hero "Your city. Your coin. Your community.", with the location-once, wallet-only line shown only while `WALLET_ONLY` is on; the three-stage journey; migration notice and `/migration`; `/rules` redirects with 308 to "How it works"; `/app` redirects with 308 to `/` | `PUBLIC_V5` | When switched: the new public structure | Advances V03, V04, V05 | S16, S48 |
| **S50** Map and city timeline | Unfounded cities: next cutoff in server time with a countdown and a visible time zone; Provisional, Processing or Empty-repeating labels; cycle history. Founded cities: the permanent founder (masked wallet), receipt link and coin status, with no next-founder countdown. Country view `/cities?country=<CC>`. DS-06 "Unfounded city" and "Founded city" messages. | Shown when `SELECTION_V5` is not off (labeled provisional in shadow) | When switched: the map shows cutoffs instead of seat windows | Advances A08, A09, A10, V03 | S17, S49 |
| **S51** Dashboard v5 | One Today action; city selection card; permanent founder card; launch center (S26, S41); country manager tab; hourly fees tab (paid, funded, pending and carried; liquidity locked, applied and pending; buyback backlog and last run); owner-only "Metadata requests" and "Manager applications" tabs, separate from Moderate; Rankings tab removed; new notice kinds, opt-in; switching wallets clears state | `DASHBOARD_V5`; each card stays hidden while its API answers `not_enabled` | When switched: the DS-05 dashboard | **Closes A08**; advances A12, B07, B12, M02, V03 | S12, S17, S21, S26, S42 |
| **S52** `/architecture`, `/fees`, `/status` | Seven sections (join and return, find a founder, launch a city, trade, fees and hourly work, country managers, safety and trust) as inline SVG with titles, descriptions and text equivalents; a glossary; a Historical, Approved target and Active legend driven by API fields, never by copy; `/api/status`. Links go only to real receipts, audits and explorer records; the draft program shows "not audited". | `PUBLIC_V5` | When switched: the public learning pages | **Closes B12, V02**; advances V03, V04, V05 | S07, S49, S51 |

### Phase 12. BR-04 to BR-06: integrations and cutover

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S53** Search, share and install | Canonical link, `og:url`, `og:image`, `og:site_name`, Twitter card and JSON-LD (WebSite and Organization). Today only `og:title`, `og:description` and `og:type` exist (scripts/pages/build.mjs:115-117). A build-generated `sitemap.xml`, a robots file with a `Sitemap:` line, `manifest.webmanifest` and the apple-touch icon; none of these exists in `public/` today. theme-color comes from the tokens. Preview stays noindex. No service worker in this stage. | Values from `BRAND` and `SITE_ORIGIN`; `INDEXING` for production | When switched: new metadata on every page | Advances D07, V06 | S46, S48 |
| **S54** Integrations | Mail templates and EHLO from `SITE_ORIGIN`. The sender changes to citycoin.dev only after the provider verifies it; until then, in-app notices only (today the sender is on vicinity.city, wrangler.jsonc:26). Scheduled synthetic probes (home, `/api/me`, `/api/policy`, a `/coin-meta` sample, the old-to-new 308, the mutation 421, certificate expiry) with an alert route. Post-deploy check base from `SITE_ORIGIN`. Official websites list adds citycoin.dev. Countdown Worker target. README and runbooks. `deploy-runbook.md` drafted. | Per item | Per item, each recorded in section 1's provider table | Advances D06, D11, V06 | S06, S48; external E10, E11 |
| **S55** Website cutover | Configuration PR: `SITE_ORIGIN=https://citycoin.dev`, `BRAND=citycoin`, `PUBLIC_V5=on`, `DASHBOARD_V5=on`, theme on, `INDEXING` on for citycoin.dev. `HOST_REDIRECT` stays off. No financial switch changes. Database backup and census before and after. Website rollback rehearsed on preview first. | the switches named | Citycoin.dev on both hosts with the migration notice. citycoin.dev is canonical and indexable. Financial switches unchanged. | **Closes D01, D02, D04, D06, D07, V06**; advances D08, D11 | S06, S15, S47 to S54; preview evidence; external E1, E9 |
| **S56** Redirects on | Configuration PR: `HOST_REDIRECT=on`. Byte hashes of the excluded paths are compared before and after. The probes stay green through an observation period. `domain-cutover.md` records keeping vicinity.city for at least 12 months, with a named renewal and monitoring responsibility. | `HOST_REDIRECT` | Old public pages redirect with 308 to the matching citycoin.dev path, with hand-off parameters dropped. Non-GET requests to old hosts get 421 `wrong_host`. The excluded paths are served in place. | **Closes D03, D05, D11** | S55; external E15 (observation), E16 (renewals) |

### Phase 13. WP-12: security and authority migration

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S57** Authority transitions, prepared for signature | Unsigned, reviewable Squads proposal files for: a 172,800-second time lock on multisig `6v8hw…RjYV` (0 today); creating the controlled 2-of-3 guardian; deploying the audited program with the vault as upgrade authority; role keys; quote configs; registry roots; and, if the cross-program admin check stays, moving the legacy admin to the vault. Also: `authority-map.md` refreshed from read-only RPC, a CI build-hash comparison, and authority checks in `release-manifest.json`. | none | No change: nothing is signed | **Closes B13** (devnet and preflight against the prepared configuration; re-run on mainnet at S60); advances B14, D12 | S37, S38 |
| **S58** Legacy launch closure | The legacy admin `13qRam…sRiN` signs `set_pause(launches = true)` on the legacy launchpad; the website already has a builder for it (src/lpadmin.js:1106). Then a configuration PR sets `LEGACY_LAUNCH=off`. Legacy modules stay only for legacy assets, and none is listed today. | `LEGACY_LAUNCH=off` | No new legacy (Meteora) city launch can be built or executed | Advances A11, B11, B14 | S23; external E3 |

### Phase 14. WP-13 and the migration and design acceptance: evidence

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S59** Acceptance suites and evidence package | Run A01 to A14, B01 to B14, M01 to M04, D01 to D12 and V01 to V06 in the repository test environment, on preview and on devnet. Record exact commands, results and not-run reasons in `test-report.md`. Screenshots at about 390 px and 1440 px in both themes. `selection-proof.md`, `metadata-review.md`, `hourly-operations.md`, `authority-map.md`, `release-manifest.json`, `deploy-runbook.md`, `domain-cutover.md`, `architecture/` diagram source. Rehearsals of database-copy migration, old-launch disable, keeper restart, guardian stop and website rollback. Physical-device tests where devices exist; simulated wallets labeled as simulated. | none | No change | **Closes A14, B14, D08, D10, D12, V03, V04, V05**; re-verifies B02 and D09 | every stage except S60 to S65 |

### Phase 15. Gated production activation (section 37, step 10)

Each stage here needs real external evidence (section 9). None may be reported done on the basis of approval alone.

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S60** Program deployment, paused | After the outside audit closes on the S38 binary, the owner and members execute the S57 proposals, time lock first. The program is deployed with launches, buys, buybacks and selections halted. `FOUNDER_RECORD_CHAIN=on` (reads only). Release-manifest hashes are compared. | `FOUNDER_RECORD_CHAIN` | The custom program exists on mainnet but accepts no launch, buy, buyback or selection | B13 preflight re-run on mainnet | S57, S59; external E2, E6, E7 |
| **S61** Permanent founder selection on | After at least 48 hours of real shadow agreement (8 cycles) plus accelerated multi-cycle tests: governance sets the publisher and verifier keys, the time-locked admin resumes selections, and `SELECTION_V5=on` | `SELECTION_V5=on` | The first permanent FounderRecords are written on chain at six-hour cutoffs. **This is irreversible on chain.** | none new | S18, S19, S60; external E2, E4, E15 |
| **S62** Production activity points and manager applications | `ACTIVITY_POINTS=on` (it may go on earlier; it does not depend on selection) and `MANAGER_APPS=on` | the switches named | Point ledgers visible; eligible founders can apply; the owner decides in the inbox | none new | S20, S21, S61; external E17 (real owner decisions) |
| **S63** First city launches on the SOL path | `LAUNCH_V5=on`, `CC_TRADING=on` and `CC_HOURLY=on` for 1 to 3 verified registry cities on the audited SOL path; then 72 hours with no unresolved critical or high issue before expanding | the switches named | Founders of those cities can launch with a zero platform launch fee; hourly processing runs | none new | S41, S44, S45, S58, S60, S61; external E4, E15 |
| **S64** Additional quote paths | USDC, then the configured main token (owner amendment 01; its verified mint, never `$VICINITY`), and any later approved SPL mint, each enabled by governance with its own passing evidence | quote configs on chain | Each quote becomes selectable only after its own evidence | none new | S63; external E2, E15, E18 |

### Phase 16. Retirement after the windows

| Stage | Pull request | Switch | Live site | Checks | Depends on |
|---|---|---|---|---|---|
| **S65** Retire obsolete code and secrets | After `LEGACY_LINK_UNTIL`: delete the Google, email-code and password code (the credential holder deletes the matching secrets). After observation: delete the frozen seat, squad and election writers, the `COIN_V2_READY` and `COIN_V2_REVIEW` code paths and switches, the `coinRegistry` job step, `SIGNUP_FLOW` and `docs/RULES-V7-DRAFT.md`. Delete legacy money paths once no legacy asset needs them. Redirects stay at least 12 months; legacy assets stay permanently. | none (code removal) | No user-visible change beyond the removals | Full suite and D11 re-run | windows elapsed; external E12 (secret deletion) |

### Master section traceability

Every section of the master maps to the stages above. The third column names requirements that the stage tables do not spell out word for word, so that no master requirement is left without an owner stage. "Planned" means not built.

| Master section | Stages | Requirements named here so they are not lost (all planned) | Checks |
|---|---|---|---|
| 01 Master instruction | all; sections 1, 8 and 10 | Ordered execution as in the stage list; finish independent work and record each exact external dependency (section 8) | all |
| 02 Master scope | all; S02A | No token swap, forced asset migration or retroactive coin change. The replacement main-token mint that section 02 forbade is authorized by owner amendment 01, for the main token only (S02A; D09 restated in section 7) | D09 |
| 03 BR-01 Inventory | S02 | Classify every remaining match (rebrand-inventory.md); confirm in-progress tasks follow the master (00-reconciliation.md section 6.2) | D01, D09 |
| 04 BR-02 Domain, TLS, routes | S03 to S06, S27, S54 to S56 | Preserve unrelated MX, TXT and verification records and publish only provider-verified DNS values (S06, S54; today citycoin.dev has NS records only); configure CSP, CORS and security headers from the services actually used, never wildcard credentials (S03, S54; today's values in rebrand-inventory.md section 4); explicit mapping of old slugs and entity IDs to new routes (S03) | D02, D03, D05, D06 |
| 05 BR-03 Sessions, API, wallet handover | S04, S09 to S15, S65 | Document the expiry and retirement of old sessions, hand-off tokens and signing keys in `domain-cutover.md` (S56) before S65 deletes them | A01, A02, D04, D10 |
| 06 BR-04 Integrations | S48, S53, S54 | Wallet connection: app name, URL, icon and human-readable signed-message identity in every adapter and deep link (S09 statements, S48 labels, S53 icons); analytics and log hostname labels and alert links, never storing coordinates, challenges or hand-off secrets (S54); a versioned service-worker cache only if a service worker is added (none exists in `public/` at `4aa408e`, git grep) | D06, D07, D11, V06 |
| 07 BR-05 Data and on-chain identity | S02, S08, S16, S27, S28 | Before and after counts and hashes of wallets, profiles, posts, locations, FounderRecords, coins and liabilities (S08 census, S55, S59) | A14, D08, D09 |
| 08 BR-06 Cutover runbook | S49, S54 to S56, S59 | Rollback commands that never reset the database or founder state (`deploy-runbook.md`); the plain migration notice (S49); the four statuses (section 1) | D11, D12 |
| 09 DS-01 Logo references | S46 | The detailed skyline-on-coin illustration is for hero and about artwork only; it is not produced yet (brand/README.md, "Left for the rollout" item 10) | V01 |
| 10 DS-02 Themes | S47 | Civic Atlas default plus its accessible dark counterpart; boards B and C are not built | V02 |
| 11 DS-03 Logo system | S46, S48, S53, S54 | Replace the old favicon, loader, wallet-app, manifest, notification and social-preview logos; keep `/brand/vicinity-512.png` for legacy assets | V01, V06 |
| 12 DS-04 Tokens and components | S46, S47, S49 to S52 | Focus, hover, pressed, disabled, loading, empty, error, stale and confirmed states with text or icons; tabular numerals; reduced motion; the familiar labels ("Connect wallet", "Register your city", "View founder selection", "Request metadata change", "Apply for country manager", "View hourly distribution") | V02, V04 |
| 13 DS-05 Layout | S49 to S51 | Public pages need no wallet; dashboard and role mutations need wallet authentication | V03 |
| 14 DS-06 Content | S02, S48, S49, S59 | A before and after screenshot set: the "before" set is captured from today's site before S48 changes any label; the residual-Vicinity-string report comes from `scripts/brand/residual.mjs` (S02, enforced at S48) | D01, V05, V06 |
| 15 Replace earlier work | S16, S23, S65; 00-reconciliation.md | Historical rules never authorize a new action | B12, V05 |
| 16 Fixed policy | S07 | `policy.json` and `src/masterpolicy.js` (section 3) | A07, A08, B05 |
| 17 WP-00, WP-01 | S01, S08 | Record pre-existing test failures (none in the independent full run, section 11) | A14 |
| 18 WP-02 | S09 to S15 | | A01, A02 |
| 19 WP-03 | S11 to S13 | | A03, A04 |
| 20 WP-04 | S17, S18 | | A05 to A09 |
| 21 WP-05 | S19, S33, S61 | | A10, A11 |
| 22 WP-06 | S21, S62 | | A12 |
| 23 WP-06A | S20 | | A13 |
| 24 WP-07 | S22 to S27, S34 | | B03, M01 to M04 |
| 25 Metadata changes | S24 to S26, S34 | | M01 to M04 |
| 26 WP-07A | S35, S41 | | A11, B01, B03 |
| 27 WP-08 | S28 to S38, S40 | The SDK requires a positive minimum-received bound (S38, S40); no admin reserve or LP withdrawal (S32); never-graduated coins keep pending liquidity locked and disclosed (S32, S52) | B06, B11 |
| 28 WP-08A | S31, S32, S38, S64 | | B04 |
| 29 Fees and free transfers | S29, S35, S39, S41 | | B01, B02, B05 |
| 30 WP-09 | S36, S42 to S44 | | B07, B08 |
| 31 WP-09A | S36, S42, S43 | | B09 |
| 32 WP-09B | S29, S32, S44 | | B10 |
| 33 WP-10 | S50, S51 | | A08, B12, V03 |
| 34 WP-10A | S20, S21, S25, S40, S41, S51 | Before any monetary signature, show pair and mint, minimum received, platform fee, network and rent cost, wallet and intended program (S40, S41) | V03, V04 |
| 35 WP-11 | S52 | | B12, V02 |
| 36 WP-12 | S30, S33, S37, S57 | | B13 |
| 37 WP-12A | S58, S60 to S64; section 9 | | B14 |
| 38 WP-13 | S59 | | A01 to A14 |
| 39 WP-13A | S59 | | B01 to B14 |
| 40 Metadata acceptance | S45, S59 | | M01 to M04 |
| 41 Rebrand acceptance | S55, S56, S59 | | D01 to D12 |
| 42 Visual acceptance | S46, S59 | | V01 to V06 |
| 43 Delivery package | section 4 | | all |
| 44 Traceability and final prompt | this report | | all |
| Owner amendment 01 (24 Oct 2026): new main token, official X and Telegram | S02A, S17, S21, S31, S48, S64 | The owner supplies the mint, X address and Telegram address; each is verified before use (`amendment-01-new-main-token.md` section 4); empty values keep every dependent feature off; no automatic swap or migration of `$VICINITY` holdings | A05 to A07, A12, B04, D09, V05, V06 |

## 7. Status of the 50 acceptance checks

"Not started" means no v5 work for the check is merged and the check has not been run. Two checks hold today, and the evidence is given in their rows. "Built in" lists the stages that implement the check. "Closes at" is the stage where the full pass condition is verified.

### Identity and selection (section 38)

| ID | Check | Status | Today (evidence) | Built in | Closes at | External |
|---|---|---|---|---|---|---|
| A01 | Wallet identity | Not started | Wallet sign-in finds the account by `users.wallet` (src/auth.js:219), and `users.wallet` is UNIQUE (src/store.js:55). No wallet-keyed registration exists: v2 creates accounts with `wallet = NULL` (src/signup-finish.js:41-46). | S10, S11 | S15 | E13 |
| A02 | Authentication | Not started | The message host must equal the request host (src/signed.js:51-52), but the message is accepted when the used-message store cannot answer (src/signed.js:64, 76-86). No server-issued two-minute challenge. | S04, S09, S10 | S15 | none |
| A03 | Initial GPS order | Not started | Location comes first, then Google or email (live `/api/me`: providers google and email, `signupFlow` v2). | S11, S12 | S15 | E13 |
| A04 | Returning login | Not started | Sign-in needs no location, but check-in posts require an attestation (src/social.js:221-230) and the home moves weekly (src/me.js:30). | S10, S12, S13 | S15 | none |
| A05 | No holding wait | Not started | 7 qualifying days (src/policy.js:35; live `/api/policy`). | S02A, S16, S17 | S17 | E18 (the verified main-token mint) |
| A06 | Balance snapshot | Not started | One latest-state read with no chosen cutoff slot (src/chain.js:272), of the legacy `$VICINITY` mint. | S02A, S17, S18 | S18 | E5, E18 |
| A07 | Ranking and ties | Not started | No six-hour selection; `founder_records` does not occur in `src/` at `4aa408e` (git grep). Today's tie-breaks are hash-based. The tie-break raw balance is the configured main-token mint (amendment 01). | S02A, S07, S17 | S17 | E18 |
| A08 | Cycle timing | Not started | No six-hour cycle exists. | S07, S17, S50, S51 | S51 | none |
| A09 | Empty and failed cycles | Not started | No cycle state exists. | S17, S18 | S18 | E5 |
| A10 | Permanent founder | Not started | A seat goes into a grace period when its balance falls below the founder amount (src/lplaunch.js:98-103). The draft program has `transfer_founder` (curve:…/lib.rs:189). | S16, S19, S30, S33 | S45 (devnet) | E6 before mainnet |
| A11 | Permanent launch right | Not started | Launch requires a live seat and the founder amount (src/lplaunch.js:95-105). | S19, S35, S41 | S45 (devnet); mainnet after S58 | E3, E6 |
| A12 | Country manager | Not started | Managers are elected for 90 days (src/elections.js:1-13). The national rank reads the configured main-token mint (amendment 01). | S02A, S20, S21, S51 | S21 | E18; E17 (production decisions) |
| A13 | Activity ledger | Not started | No activity ledger; `activity_events` does not occur in `src/` at `4aa408e` (git grep). | S20, S41 | S45 (launch award) | none |
| A14 | Legacy continuity | Not started | Nothing has been migrated yet. 0 seats and 0 open windows (GET `/api/seats`). | S08, S14, S15, S16 | S59 | E9 |

### Money, UI and recovery (section 39)

| ID | Check | Status | Today (evidence) | Built in | Closes at | External |
|---|---|---|---|---|---|---|
| B01 | Free launch | Not started | The live config charges a 0.05 SOL launch fee (wrangler.jsonc:71-72). The draft charges 50,000,000 lamports to `FEE_RECIPIENT` (types.rs:77; launch.rs:328-340) and needs an admin approval. | S29, S35, S41 | S45 (devnet) | E6 before mainnet |
| B02 | Free transfers | **Holds today for the live send builders; must stay true** | The SOL send is the compute budget plus one System transfer (src/walletsend.js:223). The token send is the compute budget, an optional create-idempotent and `transferChecked` (src/walletsend.js:248-252). Fee and rent are separate summary fields. test/wallet-send.test.js:322-326 and :374-379 assert the exact instruction lists. Receive shows only the address and its QR code (public/dashboard-v2.js:15, 776). `node --test test/wallet-send.test.js` for this report: the 11 Worker-side tests passed, including both exact-instruction tests. The 8 page tests failed only because `public/vendor/qrcode.js` is made by the build (scripts/copy-assets.mjs:27) and this worktree was not built; after the build, the full suite passed with them included (section 11). | S39, S40 (custom-program coins join the Send list) | re-verified at S59 | none |
| B03 | Metadata and uniqueness | Not started | The draft has a permanent `TickerLock` and a legacy-coin duplicate check (curve:programs/vicinity-curve/src/instructions/launch.rs:123-127, 146-149), but no FounderRecord, registry root or quote-config check. | S34, S35, S41 | S45 | E6 before mainnet |
| B04 | Three quote paths | Not started | The draft is SOL only (`buy(sol_in, …)`, curve:…/lib.rs:158). The main-token quote has no mint until the configured mint is verified (amendment 01; `quote_configs.main_token.quote_mint` is null); the devnet rehearsal uses a test mint. | S02A, S31, S32, S38 | S45 | E8; E18 before the mainnet main-token path |
| B05 | Fee math | Not started | The draft's config #0 is 50/70/50/50/30 for SOL (types.rs:67-71); not deployed. | S07, S29, S32 | S38 | none |
| B06 | Curve and pool | Not started | Draft SOL suites only (curve:tests-curve/04-launch to 08-buyback, 22-g01-onchain, 25-no-free-value); not deployed, not audited. | S32, S40 | S38 | none |
| B07 | Hourly processing | Not started | No hourly step exists in the job list (src/jobs.js:45-60). | S36, S42, S44, S51 | S45 | E4 |
| B08 | Retry and no duplication | Not started | No hourly records or paid bitmap exist. | S36, S42, S44 | S45 | E4 |
| B09 | Holder safety | Not started | The live rewards program uses claim windows of at least 14 days (vicinity-rewards constants.rs:48). | S36, S42, S43 | S45 | E4, E5 |
| B10 | Liquidity and buyback | Not started | The draft has depth and slot caps; the throughput rule is "not a program rule" (curve:VICINITY-CURVE-DESIGN.md:3910). | S29, S32, S44 | S44 | E8 |
| B11 | No venue dependency | Not started | Live city-coin launches and trades run through Meteora DBC (wrangler.jsonc:78-80). | S23, S40, S41 | S45; mainnet after S58 | E3 |
| B12 | Dashboard, map and page | Not started | Seven-day copy on the home page (scripts/pages/src/index.html:48, 104, 112, 115). | S16, S50, S51, S52 | S52 | none |
| B13 | Authorities and pauses | Not started | Multisig time lock 0 (RPC read for this report). No guardian multisig is recorded. The draft guardian may only set launch, buy and buyback halts to true (curve:programs/vicinity-curve/src/helpers.rs:289-312). | S30, S33, S37, S57 | S57; re-run at S60 | E2 |
| B14 | Migration and recovery | Not started | No migration, rehearsal or rollback record exists for v5. | S08, S23, S44, S45, S55, S58 | S59 | E3, E9 |

### Metadata workflow (section 40)

| ID | Check | Status | Today (evidence) | Built in | Closes at | External |
|---|---|---|---|---|---|---|
| M01 | Fixed defaults | Not started | The live route `POST /api/coins/design` lets a founder set name, description and pair (src/coins.js:158-162). | S22, S24, S26, S35, S41 | S45 | E6 before mainnet |
| M02 | Upload and review | Not started | The review queue is switched off (wrangler.jsonc:103), and any admin may decide (src/admin.js:791-797). | S24, S25, S26, S34 | S45 | none |
| M03 | Approved new default | Not started | A launch still needs the owner's on-chain approval on the legacy path (src/lpadmin.js:864). | S25, S34, S35, S41 | S45 | E17 (production) |
| M04 | Conflict, rejection and race | Not started | No pair in requests and no on-chain review lock. | S24, S25, S34 | S45 | none |

### Rebrand and migration (section 41)

| ID | Check | Status | Today (evidence) | Built in | Closes at | External |
|---|---|---|---|---|---|---|
| D01 | Product rename | Not started | The product is Vicinity, for example the page titles (scripts/pages/build.mjs:104) and the mail sender (wrangler.jsonc:26). | S02, S48 | S55 | none |
| D02 | Canonical host and TLS | Not started | citycoin.dev has NS records only (DNS lookup for this report). Routes are the old hosts only (wrangler.jsonc:130-133). No preview (wrangler.jsonc:13-14). | S03, S05, S06 | S55 | E1 |
| D03 | Redirect mapping | Not started | No cross-domain mapping exists. | S03, S27 | S56 | E15 |
| D04 | Session migration | Not started | Cookies are host-only (src/http.js:65-66), but a session is found by token hash with no host check (src/auth.js:125-135). | S04, S10, S14 | S55 | E1 |
| D05 | Mutation and API safety | Not started | Non-canonical hosts answer 301 for every method (src/index.js:701-706). | S03 | S56 | none |
| D06 | Origins and integrations | Not started | CSRF compares the Origin host with the request host (src/http.js:74-78), but hosts are hard-coded (src/index.js:691-692; wrangler.jsonc:26). | S02, S03, S54 | S55 | E10, E11 |
| D07 | Search, share and install | Not started | No canonical, `og:image` or Twitter tags (scripts/pages/build.mjs:113-117). No manifest, sitemap or robots file in `public/`. | S53 | S55 | none |
| D08 | Data continuity | Not started | No census tooling exists. | S08 | S59 | E9 |
| D09 | Token identity | **Holds today for the legacy identifiers; the amendment 01 part is not started** | Legacy half (holds): `VICINITY_MINT` is `2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray` (wrangler.jsonc:32). RPC read for this report: classic SPL Token mint, 6 decimals, no mint or freeze authority, raw supply 999,999,999,999,990 (slot 460707501). No tracked file differs from `4aa408e`, so no program ID, seed or serialized layout has changed, and nobody's `$VICINITY` holdings have been moved. No legacy city coin is listed (GET `/official-coins.csv`). Amendment 01 half (not started): the main token must be the owner-supplied, verified `MAIN_TOKEN_MINT`, never the legacy mint; the value is not supplied. | S02 (guard), S02A (central main-token configuration), S28 (legacy IDs kept) | re-verified at S59 | E18 |
| D10 | Single-writer jobs | Not started | The base exists: one Worker with one cron (wrangler.jsonc:141) and a D1 job lease (src/jobs.js:23-37). No selection or hourly job exists yet to test. | S05, S06, S17, S42 | S59 | none |
| D11 | Health and rollback | Not started | No scheduled probe and no alert route. | S54, S55 | S56 | E11, E15 |
| D12 | Release evidence | Not started | Uncommitted drafts only (section 3). | S01 onward | S59 | none |

### Visual identity and UX (section 42)

| ID | Check | Status | Today (evidence) | Built in | Closes at | External |
|---|---|---|---|---|---|---|
| V01 | Logo family | Not started | The live favicon and logo are the Vicinity mark (`aria-label="Vicinity"` in public/favicon.svg and public/logo.svg). Draft Citycoin files exist uncommitted (section 3); an independent structural and render check passed on 24 Oct 2026, but no browser, device or owner review has happened. | S46 | S46 | none |
| V02 | Theme system | Not started | Dark is the default (public/theme.js:2). No Civic Atlas tokens on main. | S46, S47, S51, S52 | S52 | none |
| V03 | Responsive workflows | Not started | The v5 screens do not exist. | S12, S26, S49 to S52 | S59 | E13 |
| V04 | Accessibility | Not started | Not run for v5 screens. | S47, S49 to S52 | S59 | none |
| V05 | State correctness | Not started | Seven-day and election copy is live (scripts/pages/src/index.html:48, 112). The token page presents `$VICINITY` as the main token (scripts/pages/src/token.html:7, 186). | S02A, S16, S23, S48, S49, S52 | S59 | none |
| V06 | Brand completeness | Not started | The Vicinity brand is on every surface, and every footer links the legacy X account (amendment 01). | S02A, S48, S53, S54 | S55 | E10, E18 |

**Totals:** 48 not started; 2 hold today and must stay true (B02, and D09 for its legacy identifiers; D09's amendment 01 part is not started); 0 closed by v5 work.

## 8. Real external dependencies

Each item blocks only the stages named. Independent work continues, as master section 01 requires. None of these may be invented, simulated or assumed done.

| ID | Dependency | Who acts | Blocks |
|---|---|---|---|
| **E1** | **Attach citycoin.dev to the existing Worker in Cloudflare** (custom domains `citycoin.dev` and `www.citycoin.dev`, certificate issued), plus the preview D1 database and the `preview.citycoin.dev` route, and the mirror bucket. The deploy token must cover the citycoin.dev zone. citycoin.dev and vicinity.city use the same Cloudflare nameserver pair (DNS lookups for this report), but that does not prove they are in the same account. | Owner, or someone with Cloudflare access | S05, S06, S27, S45, S55 (D02, D04 on the real host) |
| **E2** | **Squads actions signed by the owner and members (2 of 3):** set the 48-hour time lock (today 0); create the controlled 2-of-3 stop-only guardian; deploy the audited program from a key the owner generates, with the vault as upgrade authority; set role keys; add quote configs; publish registry roots; accept the legacy admin and registry admin into the vault if the cross-program admin check stays. The time lock is a setting of the multisig, so it also delays every later vault action, including actions for the live programs. | Owner and multisig members | S60, S61, S64; B13 on mainnet |
| **E3** | **Signatures by the owner's everyday wallet `13qRam…sRiN`**, the current legacy launchpad admin and rewards registry admin: `set_pause(launches = true)` on the legacy launchpad (`launches_paused = 0` today), any Approval revocation, and `propose_admin` to the vault if needed | Owner | S58, and through it S63 (A11, B11 on mainnet) |
| **E4** | **Hosting and credentials, separate from the website**, for the selection publisher and the independent selection verifier, the hourly verifier pair (separate RPC providers) and the keeper, including a funded keeper operations wallet for fees and recipient-account rent. The website holds none of their credentials. Their keys are made by people on separate infrastructure; this work never creates or reads keypairs. | Owner | S18, S33 keys, S43, S44, S61, S63 |
| **E5** | **Two independent historical-balance data providers** (historical indexer or archival RPC), added as secrets `SELECTION_ARCHIVE_URL_A` and `SELECTION_ARCHIVE_URL_B`. Without them, A06 and A09 with real reads are reported as not run. | Owner | S17, S18, S61 |
| **E6** | **Outside audit of the changed program** (FounderRecord and selection authority, FounderRecord-gated launch, registry and review lock, zero launch fee, quote configs and token-vault custody, hourly roots and push payouts, guardian, removal of `transfer_founder` and the approval and batch paths). The ten earlier review rounds of the draft were internal and automated; none is an independent audit (curve:VICINITY-CURVE-AUDIT.md:463-467). | Independent auditor, engaged by the owner | S60 and everything after it |
| **E7** | **A dedicated treasury address**: not `13qRam…`, not a multisig member key, keeper or verifier. It is compiled into the program, so it must exist before the mainnet build. Also the metadata-admin key that the owner names. | Owner | S30 mainnet build, S60 |
| **E8** | **Devnet SOL for rehearsals** (faucet allowance for throwaway deployer, payer and keeper accounts) | Whoever runs the rehearsal | S38, S44, S45 |
| **E9** | **Production D1 read and export access** for the identity census (counts only) and the backups before each migration | Credential holder | S08, S15, S55, S59 |
| **E10** | **Mail sending identity for citycoin.dev** (provider-issued DKIM and SPF records). This is needed only if email notices are kept; without it, notices stay in-app, which the master allows. | Owner or provider account holder | S54, S55 (sender only) |
| **E11** | **An alert destination** for synthetic probes, certificate expiry, missed selection or hourly jobs, divergence and authority changes | Owner | S54, S56, S63 |
| **E12** | **Google OAuth console and secrets**: add the citycoin.dev callback only if Google linking must work on the new host during the legacy window; afterwards delete the client and the secrets `GOOGLE_CLIENT_SECRET` and `PASSWORD_PEPPER` (and the mail secrets if mail is retired). Also the **owner's approval of the revised Terms text**: the current Terms describe linking a Google account or an email address (scripts/pages/src/terms.html:89). | Owner or credential holder | S14, S15, S65 |
| **E13** | **Physical iOS and Android devices with real wallet apps** for the device cases of A01, A03 and V03. Simulated wallets must be labeled as simulated. | Tester with devices | S15, S59 (device rows) |
| **E14** | **Confirmation of the Workers plan** for image-decoding CPU in the metadata upload pipeline | Owner | S24 |
| **E15** | **Observation periods**, which cannot be shortened or fabricated: 48 hours of real snapshot and hourly shadow operation plus accelerated multi-cycle and monetary stress tests; 72 hours with 1 to 3 SOL cities and no unresolved critical or high issue; separate evidence for each additional quote path; a green probe period after the redirects; the legacy-link window before retirement. Before any custom-program coin exists on mainnet, there is nothing on mainnet for the hourly shadow to process. Where its 48 hours are observed is to be recorded in `hourly-operations.md`. | Time | S56, S61, S63, S64, S65 |
| **E16** | **Domain renewals**: vicinity.city, vicinitycity.com and vicinitycity.net kept for at least 12 months after cutover | Owner (registrar access) | S56 |
| **E17** | **Real owner review actions**: every production country-manager application and every metadata proposal is decided by an authenticated owner action. None may be simulated, seeded or marked approved on the owner's behalf. | Owner | S62, and every production M03 and A12 decision |
| **E18** | **The owner supplies the verified new main-token mint, official X URL and official Telegram URL** (owner amendment 01). Each is supplied in writing and verified before it is configured (`amendment-01-new-main-token.md` section 4): for the mint, read-only chain reads of the owner program, decimals, supply, mint authority, freeze authority and metadata name and symbol, from two providers, recorded by a named person with the time; for the links, the page exists and is proven to be the official account. None may be invented, guessed or taken from a search. Also the new token's own team wallets, locks and pools, which selection excludes. Until supplied, all three stay empty and every feature that needs them stays off. | Owner | The S02A switch-on, S17 and S18 with real reads, S21, S48 (main-token label), S61 to S64; A05 to A07, A12, B04 on mainnet, D09 (amendment half), V05, V06 |

## 9. Release gates for financial activation (section 37)

All gates are **not met** on 24 October 2026.

| Gate | Status | Evidence location |
|---|---|---|
| Independent audit closed for the new financial and authority instructions | Not met (no audit) | `release-manifest.json`, audit report link |
| Local and testnet end-to-end rehearsal passed | Not met | `test-report.md` (S45) |
| Correct authorities and the 48-hour time lock | Not met (time lock 0, RPC read for this report) | `authority-map.md` (S57, S60) |
| Verified quote configs | Not met (no custom program deployed) | `release-manifest.json` |
| Real alert routes | Not met | `deploy-runbook.md` (S54) |
| Migration tests passed | Not met | `test-report.md` (S08, S59) |
| 48 hours of real snapshot and hourly shadow operation plus stress tests | Not met | `selection-proof.md`, `hourly-operations.md` |
| Legacy new-launch disable plus cross-program duplicate checks | Not met (`launches_paused = 0`) | S58 record |
| 1 to 3 SOL cities, then 72 hours with no unresolved critical or high issue | Not met | S63 record |
| Each USDC and additional SPL path with its own evidence | Not met | S64 records |

Website rebrand, the public learning page and the nonfinancial dashboard features may ship independently of these gates (master section 37).

## 10. Decisions the master already made, and owner actions that stay real

**Owner amendment 01 (24 October 2026), after the master:** a new main token with a new mint, a new official X page and a new official Telegram, centrally configured and verified; `$VICINITY` is legacy with no automatic swap or migration. This is decided; only the values are pending (E18).

**Approved by the master; not open questions.** The 2.50% trade fee split 50/70/50/50/30 (liquidity, platform, founder, holders, buyback). Zero platform launch, send and receive fees. Wallet-only login. Location once. Six-hour largest-holder selection with one permanent founder per city. Owner-selected country managers. Owner-reviewed metadata changes. SOL, USDC and approved SPL quotes. Hourly automatic processing. The Civic Atlas theme. The master also settles the draft program's open owner decisions O11 (time lock), O12 (payout opt-in), O30 to O32 (batch approval), O35 (guardian configuration) and O36 (buyback rule) (curve:VICINITY-CURVE-DESIGN.md:3884-3910), in the directions given in stages S29 to S37.

**Delegated implementation choices, recorded here when made:** the legacy-link window length; switch names where they are still placeholders; the theme switch name; the exact versioned metadata path on citycoin.dev.

**Real actions that only the owner (or members) can take:** the signatures in E2 and E3, the addresses and keys in E4 and E7, and every production review decision in E17. Approval of the master is not a signature, a deployment, an audit or an owner review event, and this report never counts it as one.

## 11. How to run the current code; tests run for this report

- From `package.json`: `npm run build` copies vendor assets, builds the pages and runs the tests (`node scripts/copy-assets.mjs && node scripts/pages/build.mjs && npm test`). `npm run dev` starts `wrangler dev`. `npm test` runs `node --test test/*.test.js`. The build writes files (for example `public/vendor/qrcode.js`, scripts/copy-assets.mjs:27, and the generated pages), so it was not run when this report was first written. The phase 1 independent check ran it afterward (table below). It wrote only files that git ignores or that it left byte-identical: `git status` listed no new or changed path outside `docs/citycoin-master/`, `public/brand/`, `src/masterpolicy.js` and `test/masterpolicy.test.js`. S01 repeats it and records any pre-existing failure.
- No preview exists, so there are no preview instructions yet. S05 adds them.
- No screenshots exist yet. S59 collects them.

Tests run for this report (24 Oct 2026, Node v22.22.0, in the worktree at `4aa408e` plus the uncommitted files):

| Command | Result |
|---|---|
| `node --test test/wallet-send.test.js` | 20 tests: 12 pass, 8 fail. The 11 Worker-side tests (route guards, validation, exact SOL and token instruction lists, relay ticket, limits, pure helpers) and 1 page CSS test passed. The 8 failing page tests load `public/vendor/qrcode.js`, which the build creates; this worktree was not built. This is recorded as an environment precondition, not a code defect, and S01 re-runs it after a build. |
| `node --test test/masterpolicy.test.js` (uncommitted draft) | 26 tests, 26 pass |
| `node scripts/copy-assets.mjs && node scripts/pages/build.mjs && npm test` (phase 1 independent check, run twice: before and after the fixes in section 13) | Both runs: exit 0; 2,185 tests, 2,184 pass, 0 fail, 1 skipped. The skipped test is the opt-in live Squads read, which runs only with `SQUADS_LIVE=1`. The 8 wallet-send page tests that failed above pass once the build has created `public/vendor/qrcode.js`. No pre-existing failure was found. |
| `node --test test/masterpolicy.test.js` (phase 1 independent check, after the fixes) | 26 tests, 26 pass |
| `node --test test/masterpolicy.test.js` (after owner amendment 01) | 33 tests, 33 pass (7 new amendment 01 tests; 4 earlier tests updated for the configured main-token mint) |
| `node scripts/copy-assets.mjs && node scripts/pages/build.mjs && npm test` (after owner amendment 01) | Exit 0; 2,192 tests, 2,191 pass, 0 fail, 1 skipped (the opt-in live Squads read). `git status --porcelain` was identical before and after the run, and `git diff --stat 4aa408e` shows no tracked change. No module in `src/`, `public/` or `scripts/`, and not `wrangler.jsonc`, names `masterpolicy`. |
| `node --test test/masterpolicy.test.js` (amendment 01 independent check, after its fixes) | 33 tests, 33 pass (the `mainTokenConfig` test now also refuses the all-zero default key) |
| `npm test` (amendment 01 independent check, after its fixes) | Exit 0; 2,192 tests, 2,191 pass, 0 fail, 1 skipped (the opt-in live Squads read). `git status --porcelain -uall` was identical before and after the run; `git diff --stat 4aa408e` shows no tracked change. |
| `node scripts/copy-assets.mjs && node scripts/pages/build.mjs && npm test` (stage S02, local branch `cc/s02`, not merged) | Exit 0; 2,224 tests, 2,223 pass, 0 fail, 1 skipped (the opt-in live Squads read). The 32 new tests are test/persist-guard.test.js (12), test/build-parity.test.js (7), test/brand-adapters.test.js (8) and test/brand-residual.test.js (5); one source-shape assertion in test/v4-review.test.js follows the footer's social label into `src/brand.js`. `git status --porcelain -uall` was identical before and after the run, and `git diff --stat 361cbe2 -- public/ wrangler.jsonc migrations/` is empty. A scratch parity sweep (outside the repository) ran the real Worker of `361cbe2` and of the S02 tree with the live `wrangler.jsonc` settings and no new setting: 290 requests (every `/api` route literal as GET and POST, query routes, pages, `/coin-meta`, the CSV, the old-host and http redirects, signed-in routes, the code e-mail, two swap quotes, the launchpad list and one scheduled job run), comparing status, every response header, the body, every outbound request (URL, method, headers including the User-Agent, body including the mail sender) and the final D1 schema (123 objects). After normalizing random wallets, nonces and codes the two trees were identical, the same as two runs of `361cbe2` against each other. The page build of both trees was identical page by page (16 pages), and `diff -rq` of the built `public/` folders found no difference. |

## 12. Commands run for this report

All on 24 October 2026, read-only.

- `git rev-parse HEAD` gave `4aa408e390b8c23ed11924531d17beec82cf6828`, and `git branch --show-current` gave `claude/gifted-hamilton-cl6bct`. `git diff --stat 4aa408e` showed no tracked change. `git status --short` listed the untracked files in section 3. In the program checkout, `git rev-parse --short HEAD` gave `ec148c2`.
- Line checks with `sed -n` and `grep -n` of every `path:line` cited above, at `4aa408e` and `ec148c2`. `git grep -c` for `activity_events`, `founder_records` and `auth_challenges` in `src/` found no match.
- Five public GET requests to https://vicinity.city:
  - `/api/swap/config`: cluster mainnet, `platformFeeBps` 0.
  - `/api/policy`: version 6, effective 2026-10-16, `qualifyingDays` 7.
  - `/api/me`: providers google and email, `signupFlow` v2, signed out.
  - `/api/seats`: launched, 0 seats, 0 windows.
  - `/official-coins.csv`: 200, 0 bytes.
- One read-only RPC call: `getMultipleAccounts` (finalized, base64) on api.mainnet-beta.solana.com for the legacy Launchpad PDA, the Squads multisig and the `$VICINITY` mint (the main mint when read; a legacy token since owner amendment 01), at slot 460707501. Decoded with solana/programs/vicinity-launchpad/src/state.rs:11-27, the Squads v4 multisig header and the SPL mint layout. The PDA was derived locally with `findProgramAddress` from src/sol/pda.js (seed `launchpad`, program `AkMP9q…A1Ai`).
- DNS over HTTPS (cloudflare-dns.com), not a request to the site: citycoin.dev returned NS `pearl.ns.cloudflare.com` and `tim.ns.cloudflare.com` and no A, AAAA or CNAME record; www.citycoin.dev returned NXDOMAIN; vicinity.city returned the same NS pair.
- Read-only line checks in the draft program checkout: curve:VICINITY-CURVE-AUDIT.md:463-467, curve:VICINITY-CURVE-DESIGN.md:3884-3910, curve:programs/vicinity-curve/src/helpers.rs:285-316, the listing of curve:tests-curve.
- The two `node --test` runs in section 11.
- Phase 1 independent check (24 Oct 2026): the full build and suite twice (section 11); `git status --porcelain -uall` (changes only under `docs/citycoin-master/`, `public/brand/`, `src/masterpolicy.js` and `test/masterpolicy.test.js`); a search of `src/`, `public/`, `scripts/` and `wrangler.jsonc` for `masterpolicy` (no importer); `sed -n` checks of more than 60 cited `path:line` references in this report, `00-reconciliation.md`, `policy.json`, `authority-map.md`, `rebrand-inventory.md` and `brand/README.md`; the rebrand-inventory `git grep` counts (3,848 lines, 431 and 433 files, 4,591 tokens, 4,606 raw occurrences); two read-only `getMultipleAccounts` calls (slots 460713057 and 460713058; `authority-map.md` Appendix B, RPC C); SVG renders and raster hash comparison (`brand/README.md`, "Verification").
- No transaction was sent. No keypair was created or read. No database or secret was read. No signed request was made.

## 13. Update log

| Date (UTC) | Change |
|---|---|
| 2026-10-24 04:05 | Report started. Baseline recorded. 65 stages listed in the master's order. 50 checks: 48 not started, 2 holding today (B02, D09). All four statuses not done. 17 external dependencies listed. |
| 2026-10-24 (phase 1 check) | Independent check of the phase 1 files. Added the master section traceability table (section 6). Listed `authority-map.md` in sections 3 and 4 (it had been drafted but was shown as not started). Recorded the full build and suite run (section 11) and updated B02 and V01. Elsewhere: two section 27 rules added to `policy.json` and `src/masterpolicy.js` (`trading.min_received_bound_required`, `trading.admin_reserve_or_lp_withdrawal`) with test assertions; `public/brand/citycoin-icon-mono-dark.svg` added (white mono for dark surfaces); switch names aligned in `00-reconciliation.md` (`LAUNCH_V5`, no `CC_POLICY`); line references corrected in `brand/README.md`; an independent RPC re-read added to `authority-map.md`. Status counts unchanged: nothing merged, deployed, audited or activated. |
| 2026-10-24 (owner amendment 01) | Applied owner amendment 01 to the phase 1 package, design only. `policy.json` and `src/masterpolicy.js`: the fixed main-token mint replaced by `main_token` (mint `null`, key `MAIN_TOKEN_MINT`, replacement authorized, required checks), `legacy_tokens` ($VICINITY, history only, no automatic swap or migration), `official_links` (X and Telegram `null`, legacy X link), `quote_configs.main_token` with no mint, decimals or raw amounts until verification, the `MAIN_TOKEN_V5` switch and three deployment inputs; helpers `mainTokenConfig`, `officialLinks`, `validateDeploymentConfig` with named errors. New `amendment-01-new-main-token.md`. Updated `00-reconciliation.md` (5.12), `rebrand-inventory.md` (3.8), `schema-and-api.md` (2.4), `authority-map.md` (C22, T11, S14a) and this report (S02A, E18; A05 to A07, A12, B04, D09, V05, V06). No value was supplied, so nothing was verified and nothing changes on the live site. |
| 2026-10-24 (amendment 01 independent check) | Independent check of the amendment 01 files. `amendment-01-new-main-token.md` section 5 gained the consumers an own `git grep` found missing: the edge cache keys keyed by the mint (src/index.js:307, 329; src/cointakedown.js:106), the market-link answers of the link checker (src/official.js:104-107, 201-209), the member badges (src/me.js:47-54), the rules-page claim about minting (src/policy.js:96), the Send refusal text (src/walletsend.js:295), the market-data allow-list, more legacy referral lines, the SDK test and fixture, the legacy design note, page and client strings (connect, profile, rules, sign-up, feedback), style-sheet comments, code comments, reserved tickers, brand-only strings, the other doc mentions and the 56 test files that set `VICINITY_MINT`. Section 6 now says that the only Telegram address in the repository is an invite link inside the legacy token's recorded LaunchLab listing data (test/fixtures/launchlab/raymint.json), never a source. A legacy-metadata row that read "Main token's on-chain metadata" and two "main mint" wordings now name `$VICINITY` as the legacy token. `src/masterpolicy.js`: `MAIN_TOKEN_MINT` also refuses the all-zero default key (`MAIN_TOKEN_MINT_INVALID`), with a test; the test file labels its format-only link probes. `rebrand-inventory.md` order step 1 now says that `mainMint(env)` never returns the legacy mint; `schema-and-api.md` gives `LAUNCH_V5` the same main-token quote requirement as `CC_TRADING`. Tests: section 11. |
| 2026-10-24 (stage S02, local branch `cc/s02`, not merged) | Adapters and guards, with no visible change. `src/site-config.js`: `SITE_ORIGIN` and `SITE_ORIGINS` (unset = today's https://vicinity.city and the three old names that forward there; a malformed value falls back to today's whole, with `SITE_ORIGIN_INVALID`, `SITE_ORIGINS_INVALID` or `SITE_ORIGIN_NOT_ALLOWED`; nothing reads the request Host header), used by the old-name redirect in `src/index.js` and for the User-Agent in `src/sources.js` and `src/swap.js`. `src/brand.js`: `BRAND` with today's label set only (any other value keeps it and reports `BRAND_UNKNOWN`; the page build refuses it), used by the page layout (titles, header brand, copyright line, social labels, security line) and the mail sender's display name. `scripts/brand/residual.mjs`: the residual classifier, report only (exits 0). Tests: test/persist-guard.test.js (program IDs and names, release binary hashes, the live `/coin-meta/` prefix, `/brand/vicinity-512.png` bytes, stored and API values, the rewards city tag, the notice kinds, wallet statements and the message format, hash domains, browser storage keys, cookie names, resource and setting names), test/build-parity.test.js (byte-identical pages with `BRAND` unset; a fake label set moves only label positions), test/brand-adapters.test.js and test/brand-residual.test.js. The main-token adapters stay in S02A; no mint, X or Telegram value was supplied or added. Tests and the parity sweep: section 11. |
