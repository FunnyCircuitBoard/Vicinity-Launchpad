# Citycoin.dev: reconciliation of earlier work against master v5

Required by master change order v5 (23 October 2026), section 15 ("Evidence required") and section 43 ("00-reconciliation.md: in-progress task/code conflicts and exact removal of obsolete qualification/rotation/login/reward rules").

Written 24 October 2026, and updated the same day for owner amendment 01 (section 5.12: a new, centrally configured main token replaces `$VICINITY`, which becomes a legacy token). This file is an inventory of conflicts and a removal plan. Nothing in it has been built, deployed, audited or approved. The live site is still main `4aa408e`. The draft custom program is still `feat/vicinity-curve` at `ec148c2` (draft pull request #83, not deployed anywhere public).

## 1. Summary: what master v5 supersedes

Master v5 says it "supersedes every earlier Vicinity/Citycoin handoff and conflicting cached task" (section 01). Measured against the code, that means the following.

**Superseded. Do not continue any of this work as written:**

1. **Onboarding v3 and sign-up v2: Google, email and password accounts.** This is the live sign-up (`SIGNUP_FLOW=v2`). It is replaced by wallet-only registration and sign-in (section 5.1).
2. **Location checks after sign-up.** This covers the weekly home move, GPS check-in posts, GPS for founder and squad applications, GPS for town requests, and the check-in rule for endorsing and manager elections. Location is asked once, at first registration (section 5.2).
3. **The founder seat system.** This covers founder policy v4 and v5, the Stake Ladder, the seven-day hold, home-for-seven-days, the pitch and application, 72-hour claim windows, endorsements, Seed Steward, squads, objections, grace, release, cooldown, resign and dark-city adoption. It is replaced by six-hour largest-holder snapshots and one permanent FounderRecord per city (section 5.3).
4. **Country-manager elections and founder moderation.** These are replaced by owner-reviewed applications and owner-appointed managers (section 5.4).
5. **`COIN_V2_BATCH`, the owner's daily launch-approval round.** Remove it (section 5.5, CV-9).
6. **The founder coin studio** (`POST /api/coins/design`) and its SOL/USDC/RAY "Raydium LaunchLab" pair list (section 5.6).
7. **Per-city owner launch approval and the 0.05 SOL launch fee for new city coins.** On the live `vicinity_launchpad` path, the approval stays only for legacy assets, and no legacy city coin exists (section 5.7).
8. **The draft `vicinity_curve` approval model.** This covers the per-city `approve_launch`/`Approval` (expires within 30 days), the whole batch launch approval and its launch approver key, the payout opt-in, `transfer_founder`, the launch fee, forwarding of the holders' share to `vicinity_rewards`, and the SOL-only custody. The curve itself stays as the base program (section 5.8).
9. **Claim-only holder reward rounds.** These are funded by one authority, with a 14-day minimum window, a sweep, and minimums of 20 holders and 0.01 SOL. The legacy design pays them every 30 days; master section 15 calls the earlier direction "weekly". They are replaced by automatic hourly distribution (section 5.9).
10. **Rules version 7 draft** (`docs/RULES-V7-DRAFT.md`), `docs/COIN-BATCH.md`, and the open owner decisions those documents and the curve design were waiting for. Master v5 settles them (sections 5.5 and 5.8).

**Kept, but changed to fit v5:** `COIN_V2_READY` (fixed defaults) and `COIN_V2_REVIEW` (change requests and review). Their storage, hashing, art and screening code is reused, with owner-only review, no auto-publish and on-chain locks (section 5.5). The wallet sign-in path, the uniqueness index on `users.wallet`, the location checks of the sign-up, the carry and pairing code, and the holder reader are reused in the new flows.

**Kept unchanged as legacy compatibility:** the two deployed programs and every on-chain identifier, the `$VICINITY` mint as a legacy token (history only; owner amendment 01 replaces it as the main token, section 5.12), `/coin-meta/*` and `/brand/vicinity-512.png` on vicinity.city, and every historical record (section 8). History stays readable and never authorizes a new action.

## 2. Sources and conventions

- **Spec:** `master-v5.txt` (the 47-page master as text). The sections used are 01, 02, 15, 16, 17, 18-26, 29-32, 36, 37, 38-41 and 43.
- **Code:** `path:line` means the live site at main `4aa408e`. `curve:path:line` means `ec148c2`, with paths relative to `solana/` in that checkout. `lp:` abbreviates `solana/programs/vicinity-launchpad/src/` at `4aa408e`.
- **Inputs:** five area reconciliations (identity; selection and roles; metadata and launch; programs and money; brand, domain and UI) were written first, read-only, on 24 October 2026. This file condenses them. The citations used here were re-checked against the code at the two commits above (section 11).
- **Tests:** the master's acceptance IDs are A01-A14, B01-B14, M01-M04, D01-D12 and V01-V06. "New:" names a repository test that does not exist yet.
- **Switches named below are proposals.** None exists at `4aa408e`. In every case, an unset switch means today's behavior.

| Proposed switch | Owner area | Off (default) | On |
|---|---|---|---|
| `WALLET_ONLY` | identity | today's sign-up (`SIGNUP_FLOW=v2`) | wallet-only registration and sign-in; Google, email and password routes answer 404 |
| `LEGACY_LINK` + `LEGACY_LINK_UNTIL` | identity | no legacy window | Google/email-only accounts may link a wallet through a restricted session until the date |
| `LEGACY_SEATS` | selection | today's seat system | `frozen`: every seat, squad, endorsement, objection, resign and election writer answers `410 rule_retired`; history stays readable |
| `SELECTION_V5` | selection | off | `shadow` (dry-run cycles only; no founder is written) or `on` (FounderRecords, after the audited program exists) |
| `FOUNDER_RECORD_CHAIN` | selection | off | reads and mirrors on-chain FounderRecords |
| `ACTIVITY_POINTS`, `MANAGER_APPS` | roles | off | activity ledger; owner-reviewed manager applications |
| `METADATA_V5`, `LAUNCH_V5`, `LEGACY_LAUNCH` | metadata and launch | v5 metadata and launch off; legacy launch builders on | fixed defaults and owner inbox; self-service launch on the custom program (`LAUNCH_V5`; one working note called it `CC_LAUNCH`); `LEGACY_LAUNCH=off` builds no legacy approval or launch |
| `CC_TRADING`, `CC_HOURLY` | programs and money | off | custom-curve trading and hourly processing (`CC_HOURLY` has a `shadow` stage). The public policy and fee display follow `PUBLIC_V5`. |
| `BRAND`, `SITE_ORIGIN(S)`, `HOST_REDIRECT`, `PUBLIC_V5`, `DASHBOARD_V5` | brand and domain | today's bytes and hosts | Citycoin.dev labels, citycoin.dev origin, old-host redirects, new public pages and dashboard |
| `MAIN_TOKEN_V5` + `MAIN_TOKEN_MINT`, `OFFICIAL_X_URL`, `OFFICIAL_TELEGRAM_URL` | token and official links (amendment 01) | today's token page, links and footer (the legacy `$VICINITY` mint and the legacy X account) | every main-token consumer reads the owner-supplied, verified `MAIN_TOKEN_MINT`; `$VICINITY` is shown as legacy; the footer and checker use the configured links (empty means not shown) |

The values, defaults and named validation errors of these switches are in `schema-and-api.md` section 2.2 and `src/masterpolicy.js` (`FLAG_VALUES`); `BRAND`, `DASHBOARD_V5`, `INDEXING` and the theme switch are listed in `implementation-report.md` section 5.

## 3. Live state that sets the migration impact

All rows below come from commands run for this file on 24 October 2026 (section 11) or from code at `4aa408e`.

| Fact | Value | Source |
|---|---|---|
| Live sign-up | Google and email providers on; `signupFlow: "v2"` | `GET /api/me`; wrangler.jsonc:39 |
| Members | 5 (test-lab accounts excluded, src/me.js:456) | `GET /api/members` |
| Founder seats and open claim windows | 0 and 0 | `GET /api/seats` → `"seats":[],"windows":[]` |
| Active policy | version 6, `qualifyingDays` 7, voters need a check-in, manager terms 90 days | `GET /api/policy`; src/policy.js:21, 35, 63, 65-71 |
| Coin designs (studio) | 0 | `GET /api/coins` → `"coins":[]` (also lists pairs SOL, USDC, RAY and `launchLabClosed: true`) |
| City coins recorded from chain | 0 | `GET /official-coins.csv` → HTTP 200, empty body |
| Coin-v2 switches | `COIN_V2_READY`, `COIN_V2_REVIEW`, `COIN_V2_BATCH` all `off` | wrangler.jsonc:97, 103, 109 |
| Legacy launchpad (PDA `4g9KRZ76…9GwN`, owner `AkMP9q…`) | admin `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN`, no pending admin, `launches_paused = 0`, `payouts_paused = 0` | `getMultipleAccounts` (finalized, slot 460699575), offsets from src/sol/layout.js |
| Legacy launch config (PDA `6voKQ4…iY75`) | quote WSOL, trade fee numerator 12,500,000 (1.25%), `pool_creation_fee` 50,000,000 lamports (0.05 SOL), enabled | same read |
| Squads multisig `6v8hwKYS…RjYV` | threshold 2, time lock 0, no config authority | same read |
| Platform fee recipient compiled into the programs | `13qRam…sRiN` | lp:constants.rs:15; curve:programs/vicinity-curve/src/constants.rs:18 |
| Open pull requests | only #83 (`feat/vicinity-curve`, draft) | GitHub REST `GET /repos/…/pulls?state=open` |

**Consequence:** no founder, no country manager and no city coin exists. Freezing the seat system, the elections, the batch round and the legacy launch path takes nothing away from any live user. The two areas with live users are identity (5 members) and copy. The one area with live on-chain exposure is the open legacy launch path: until the owner pauses it, an owner-signed approval could still create a legacy coin, and that coin would carry a vicinity.city metadata URI for good.

## 4. Master section 15 checklist

The nine rows of master section 15, in the master's order.

| # | Earlier direction (master) | Old behavior at the commits above | Files implementing it | Exact change or removal | Migration impact | Replacement test |
|---|---|---|---|---|---|---|
| S15-1 | Google/email registration or optional social login | A new account is created with a Google or email identity and no wallet. Google, email code and password are dashboard logins. A Google login can be added on the Profile. | src/signup-finish.js:41-54; src/signup.js:283-353; src/auth.js:471-619, 631-671, 848-890; src/pwlogin.js:127-283; src/logins.js:44-160; src/me.js:376-392; scripts/pages/src/connect.html:60-110, 265-321, 407-436; wrangler.jsonc:39 | With `WALLET_ONLY=on`: every Google, email-code, password and Profile-Google route answers 404. Registration is location, then a server challenge signed by the wallet, then the account keyed by wallet. Sign-in is the wallet only. Delete the code after the legacy window (section 5.1). | Accounts with `wallet IS NULL` become a migration case (count needs a production census). Sessions not made by a wallet proof are revoked at switch-on. | A01, A03, D04; New: test/identity-a01.test.js, test/identity-config.test.js |
| S15-2 | Location on later sensitive actions or repeat check-ins | GPS is asked again for the weekly home move, check-in posts, seat and squad applications and town requests. Endorsing and manager-election voting need a check-in post. | src/me.js:30, 415-449; src/social.js:221-230; src/seats.js:259-262, 876-878; src/moderation.js:322-339; src/access.js:30-42; src/attest.js:19; src/policy.js:63 | Keep only purpose `home`, and only for accounts with `home_city IS NULL`. No new check-in posts. Town requests use `home_country`/`home_city`. The voter rule goes with the frozen endorsements and elections. | Existing `home_city` values are kept. Old check-in posts stay as history. | A04; New: test/identity-a04.test.js |
| S15-3 | Seven-day tenure, stake ladder, holding streak or waiting window | Founding needs the Stake Ladder amount (100K-1M) held in every sample for 7 days, a home set 7 days earlier, an application and a pitch. Voters need a 7-day account and home. Managers need 30 days as founder. | src/policy.js:24-71, 106-118; src/ledger.js:69, 85-108; src/seats.js:117-157, 240-262; src/access.js:30-42; src/elections.js:27-40; src/me.js:47-66, 167-172 | `LEGACY_SEATS=frozen`: the writers answer 410 and streak updates stop. `MASTER_POLICY` sets `holding_wait_seconds = 0` and `minimum_account_age = 0`. Remove the "Founder-ready" badge and the hold step. | `streaks` rows frozen read-only, later dropped. No live seat exists. | A05; New: test/frozen-legacy.test.js, test/selection-a05.test.js |
| S15-4 | Recurring six-hour operator / round-robin queue | Nothing to remove: no operator, queue or epoch proof exists (git log and a grep for `six-hour` and `round-robin` find none; `21600` occurs only as a chart time step, public/coinchart.js:101). The rotation that does exist is the seat lifecycle (S15-5). | none | Build the six-hour selection: `cycle = floor(unix_seconds / 21600)`, the largest positive registered balance at a finalized cutoff slot, two independent historical providers, the supply-equality completeness check, and the master tie-break. It is a new job step behind `SELECTION_V5`. | New additive tables (`city_assignments`, `selection_cities`, `selection_cycles`, `founder_records`). | A05, A06, A07, A08, A09; New: test/selection-snapshot.test.js |
| S15-5 | Reassignment when a slot expires or a founder loses tokens | A seat goes into grace and is released when the balance falls. A live `stillFounder` check runs before moderation and launch. An objection or admin revocation re-offers the seat. Resign, steward challenge and a 30-day cooldown exist. Both programs have `transfer_founder`. | src/seats.js:59-64, 315-325, 505-539, 583-617, 633-707, 907-971; src/admin.js:280-300, 329; lp:instructions/transfer_founder.rs; curve:programs/vicinity-curve/src/instructions/transfer_founder.rs | Freeze every seat state transition. `founder_records` has `UNIQUE(city_id)`, no status column, and triggers that abort UPDATE and DELETE. The on-chain FounderRecord has no update or close instruction. Delete `transfer_founder` from the custom program before the audit. | Seat rows kept as history. No city coin exists on chain, so no live founder can be transferred. | A10, B13 |
| S15-6 | Launch requires a current epoch proof / current largest balance | The website launch needs a live seat plus the founder amount right now. The draft and live programs need an owner `Approval` that expires within 30 days, or a batch leaf inside its window. | src/lplaunch.js:95-105, 209-231; src/lpbatch.js:96-105; src/coinready.js:192-240; src/coinreview.js:508-535; src/coins.js:96-103; src/lpadmin.js:897-948; curve:programs/vicinity-curve/src/state.rs:127-151; curve:…/instructions/launch.rs:202-210 | Remove every `stillFounder` and `holdsFounderAmount` call from the coin flow. The founder is "the FounderRecord wallet for this city". A new-program `launch` checks `FounderRecord.founder == signer`, the active metadata version, no review lock and an allowed quote config. | No live founder exists. Program interface change in the undeployed curve. | A11, B01, B03 |
| S15-7 | SOL/USDC only; every other SPL pair disabled | Legacy launch refuses any quote but WSOL. The draft curve is SOL-only (lamport custody). The old studio offers SOL, USDC and RAY. | src/lplaunch.js:218; curve:programs/vicinity-curve/src/lib.rs:158 (`buy(sol_in)`); curve:…/state.rs:158-160; src/coins.js:52-57; src/policy.js:84-86 | Generic `QuoteConfig` accounts in the custom program: SOL through WSOL, and USDC as a named default. USDC's mint and freeze authorities are both still set (RPC read, slot 460704034), so it needs an explicit named-default exemption and a disclosure. The configured main token becomes the first additional quote once its owner-supplied mint is verified (owner amendment 01, section 5.12; never `$VICINITY`, which is a legacy token), and further classic SPL mints are added by governance. One allowlist drives the program, SDK, API and selector. | No coins exist. | B04, B11 |
| S15-8 | Weekly holder snapshots, manual round funding or claim-only payouts | `vicinity_rewards` epochs are funded by one authority. The minimum claim window is 14 days, and a sweep exists. Operator round rules require 20 holders, 0.01 SOL and a 0.01% balance floor. The draft curve forwards the holders' share to `vicinity_rewards`. | solana/programs/vicinity-rewards/src/constants.rs:46-48; …/instructions/fund_epoch_from_vault.rs; …/instructions/sweep_epoch.rs; solana/sdk/launchpad/snapshot.mjs:35-41; curve:programs/vicinity-curve/src/instructions/forward_holders_fees.rs:1-10 | In the custom program: hourly `HourRoot` per coin, quote and hour, authorized 2-of-2 by two automated verifiers, with escrow, a paid bitmap, push payouts, a wallet-signed recovery claim, no expiry and no sweep. Keep `vicinity_rewards` deployed but unused by new coins. | No city coin, so no round was ever funded on the website (src/feestatus.js:87). | B07, B08, B09 |
| S15-9 | Automatic country leadership or generic founder moderation | Managers are elected automatically for 90-day terms with a two-term limit. A founder moderates their own city. | src/elections.js:1-125; src/policy.js:65-71; src/admin.js:352-368; src/roles.js:28-37, 62-64; src/moderation.js:30-38 | Freeze elections. Eligibility to apply = FounderRecord + confirmed launch + at least 100 valid activity points + national rank 1 + no active suspension. Only the owner approves. Remove the founder branch of `canModerate`. | `elections`, `election_votes` and `manager_terms` stay as history. No manager is active today. | A12, A13 |

## 5. In-progress and switched-off work, item by item

### 5.1 Onboarding v3 and sign-up v2 (live)

Earlier work: Sign-up v2 (PR #11, `925a37e`), switched on by PR #20 (`e113e69`); onboarding v3 "Location → Google (or e-mail) → Dashboard" (PR #44, `745b233`); "Google sign-in for an existing account" (PR #61, `00d8cae`).

| ID | Old behavior | Files | Exact change or removal | Migration impact | Replacement test |
|---|---|---|---|---|---|
| OB-1 | Sign-up finishes with a Google or email identity and `wallet = NULL`. The wallet is linked later from the dashboard. | src/signup-finish.js:41-54; src/signup.js:283-370; src/walletlink.js:133-155 | New registration batch: consume the challenge, then `INSERT INTO users … ON CONFLICT(wallet) DO NOTHING`, then open a session for that wallet's row. A lost race returns the existing account. | Accounts with no wallet become migration case M3 (OB-6). | A01 (race), A03 |
| OB-2 | Google, email code and password are dashboard logins. | src/auth.js:582-619, 848-890; src/pwlogin.js:127-283; scripts/pages/src/connect.html:60-110 | With `WALLET_ONLY=on`, the routes answer 404. "Sign in" offers the wallet only. An unknown wallet gets `no_account` and is sent to browser registration (the server path already does this: src/auth.js:219-220). | Sessions with `proven_at IS NULL` are revoked at switch-on. Those members sign in again with their wallet. | A04, D04 |
| OB-3 | "Add Google sign-in" on the Profile. | src/auth.js:521-568; src/logins.js:44-160; src/me.js:376-392 | Remove. `user_logins` rows stay as history. | None for wallet-linked members. | A03 |
| OB-4 | `SIGNUP_FLOW` set to anything but `v2`/`v3` brings back the v1 flow, which is wallet-first and then Google or email. | src/flags.js:5-10; src/auth.js:164-184, 205-209, 631-671 | The rollback must not bring Google back. Add `WALLET_ONLY`, whose off state is today's v2. While it is on, `SIGNUP_FLOW` is ignored. Delete `SIGNUP_FLOW` and the v1 code after the legacy window. | None | New: test/identity-config.test.js |
| OB-5 | Unlink a wallet; "Remove it" (disown) within 7 days of a link. | src/walletlink.js:452-468, 483-532 | Unlink is off with `WALLET_ONLY=on`. Disown stays only inside the legacy window and refuses a wallet that has a FounderRecord. | None | A02 |
| OB-6 | Google- or email-only members cannot sign in with a wallet (404 `no_account`). | src/auth.js:219-220 | Census buckets: M1 wallet + city (same account); M2 wallet, no city (same account, location once); M3 no wallet (`legacy_unlinked`: may link a wallet during the `LEGACY_LINK` window through a restricted 15-minute session; afterwards `closed_unresolved`, data kept, no merge, never matched by email). | The M1/M2/M3 split needs a count-only query against production D1. | A14, D04; legacy-link tests adapted from test/wallet-link*.test.js and test/google-signin-link.test.js |
| OB-7 | The sign-in message nonce is minted but not stored. A message is valid for 10 minutes from a client-chosen time. The chain is fixed text. The replay check fails open on a database error. | src/index.js:481-503; src/signed.js:9, 55-56, 64, 72-86; src/solana.js:108 | New `POST /api/auth/challenge`: a stored row with nonce hash, purpose, host from `SITE_ORIGINS`, cluster from config, wallet and 120-second expiry. It is consumed in the same batch that creates the session, and fails closed. | Additive table. | A02 |
| OB-8 | A session row is found by token hash with no host check. | src/auth.js:125-135 | Add `sessions.host`. A session is refused on any other host. | vicinity.city sessions never work on citycoin.dev. | D04; New: test/session-migration.test.js |
| OB-9 | Hand-off and pairing codes reach the Worker in GET query strings while observability is on. | src/walletlink.js:250; src/auth.js:361-365; wrangler.jsonc:142 | New hand-off and pairing codes travel only in POST bodies and live 5 minutes. | None | A03 (log capture holds no code) |
| OB-10 | Sign-up location can start inside a wallet app and be finished in the phone browser. | src/signup.js:181-259; public/signup.js:628-631 | In a wallet-app browser, registration shows only "Open in Safari or Chrome". | None | A03, A04 |
| OB-11 | The tiny-transfer proof, a blockchain payment that lasts 30 minutes, is an alternative to signing. | src/auth.js:406-461 | Off with `WALLET_ONLY=on`, deleted later. | Wallets that cannot sign messages lose this route (say so in help text). | A02 |
| OB-12 | The Terms describe Google or email linking. | scripts/pages/src/terms.html:89 | Publish a new Terms version after the owner approves the text. Keep the 2026-10-01 text at a versioned URL. | `terms_version` receipts are unchanged. | D01; New: test/copy-v5.test.js |

### 5.2 Location checks after sign-up (live)

| ID | Old behavior | Files | Exact change or removal | Migration impact | Replacement test |
|---|---|---|---|---|---|
| LOC-1 | The home community can be moved once a week with a fresh GPS attestation. | src/me.js:30, 415-449; public/dashboard.js:469-490; public/signup.js:588 | `POST /api/home` works only while `home_city IS NULL`, once. Otherwise it answers 409 `location_fixed`. Remove the change-community control. | Existing homes are kept. | A04 |
| LOC-2 | Check-in posts need a `checkin` attestation inside the home city. | src/social.js:221-230; src/attest.js:19; public/dashboard.js:1169-1177 | New posts take `meme`, `talk` and `update` only. `PURPOSES` becomes `["home"]`. | Old check-ins stay readable. | A04 |
| LOC-3 | Seat and squad applications need an `apply` attestation. | src/seats.js:259-262, 876-878 | Frozen with the seat system (5.3). | None (0 seats) | A04, A05 |
| LOC-4 | Town requests need a `request` attestation. | src/moderation.js:322-339 | Use `home_country` and `home_city`, labeled "not location-checked" for reviewers. | None | A04 |
| LOC-5 | Endorsing, joining a squad and voting in a manager election need a check-in post plus a 7-day account and home (`voterProblem`). | src/access.js:30-42; src/policy.js:63; callers src/seats.js:146, 341, 766, 790 and src/elections.js:137 | Every caller is frozen (5.3, 5.4), so `voterProblem` has no live caller left. Delete it with the cleanup. No v5 action uses it. | None | A04, A05 |

### 5.3 Founder seats (live code, 0 seats)

Earlier work: policy v4 "14 days -> 7 days" (PR #3, `bcd0116`); founder policy v5 "Stake Ladder, Seed Steward, Squad Founding" (PR #4, `16c4b5e`); Stake Ladder on the map (PR #23, `b63acd0`); the founder parts of Dashboard v2 (PR #16, `4d66f0b`).

| ID | Old behavior | Files | Exact change or removal | Migration impact | Replacement test |
|---|---|---|---|---|---|
| FS-1 | Eligibility: ladder amount held for 7 days, home for 7 days. | src/policy.js:24-36, 106-118; src/seats.js:117-157; src/ledger.js:85-108 | `LEGACY_SEATS=frozen`. Move the founder and voter blocks of `POLICY` into a frozen `LEGACY_POLICY_V6` object that only history pages read. | `streaks` frozen. | A05; New: test/frozen-legacy.test.js |
| FS-2 | Apply with a pitch and GPS. A 72-hour window. Scoring 50/30/20 over endorsements, contribution and min(balance, 7-day average). | src/seats.js:166-180, 240-296, 328-346, 356-406, 460-539; src/policy.js:37-38, 59-60 | Writers answer 410. Replaced by the six-hour selection (S15-4). | `windows` and `applications` stay readable (src/seats.js:1052-1057). | A05, A07 |
| FS-3 | The first qualified claimer becomes a revocable Seed Steward (probation, quorum, challenge). | src/seats.js:187-237, 505-539; src/policy.js:49-53 | Remove. | None | A10 |
| FS-4 | Grace, release, repeated grace and cooldown on a balance drop. A live `stillFounder` check. | src/seats.js:59-64, 583-631, 633-707; src/policy.js:39-42 | Remove. Founder identity is permanent. A separate `blocked` flag (for example an active ban) limits actions but never changes identity. | None | A10, A11 |
| FS-5 | Objections and admin revocation; the seat is re-offered to the next applicant. | src/seats.js:907-971; src/admin.js:280-300, 329 | Remove. The guardian may stop only a pending finalization (WP-12). | None | A10, B13 |
| FS-6 | Squads (3-5 locals pool holdings). | src/seats.js:709-902; src/store.js:276-294; public/dashboard-roles.js:232-290 | Remove. One wallet, one founder. | None | New: test/frozen-legacy.test.js |
| FS-7 | Resign a seat. | src/seats.js:315-325; public/dashboard-roles.js:76-80 | Remove. A founder may simply never launch. | None | A10 |
| FS-8 | Dark-city adoption after 30 days. | src/seats.js:84-91, 150-153; src/policy.js:53 | Remove. Every city with a registered member enters the cycle schedule. | None | A08 |
| FS-9 | Tie-breaks by `sha256("vicinity-seat|…")` and `sha256("vicinity-election|…")`. | src/seats.js:395, 403; src/elections.js:99, 101 | Remove from new decisions. `compareCandidates`: raw balance descending, then `signup_completed_at` ascending, then decoded 32-byte key ascending. The old hash domains are kept only so past results can be reproduced. | None | A07 |
| FS-10 | Job steps `seats` and `elections`; a streak update on every balance sample. | src/jobs.js:46-47; src/ledger.js:69 | Skipped while frozen; deleted after observation. | About 100 database calls per sample go away. | New: test/frozen-legacy.test.js; D10 |
| FS-11 | The Founding Supporters snapshot uses min(cutoff balance, 14-day average). It is dormant: no cutoff is set. | src/snapshot.js:1-8; src/policy.js:82; src/official.js:313-316 | Not a founder input and not a v5 distribution input. Keep it dormant and readable. Add no new writer. | None | New: test/selection-snapshot.test.js asserts that the selection path never reads it |

### 5.4 Country-manager elections and founder moderation (live code, none active)

| ID | Old behavior | Files | Exact change or removal | Migration impact | Replacement test |
|---|---|---|---|---|---|
| CM-1 | Elections open automatically for countries with an active seat. 90-day terms, at most two in a row. An unused admin route creates elections. | src/elections.js:1-172; src/policy.js:65-71; src/admin.js:345-368 | Freeze them. Replace with `manager_applications` (draft to approved, rejected, withdrawn or needs requalification) and an owner-only decision route. | History kept. No active manager. | A12; New: test/manager-apps.test.js |
| CM-2 | Manager powers exist only while the manager's founder seat is active. | src/roles.js:28-37 | `managerOf` reads `country_managers`. A partial unique index allows one active manager per country. No job ever ends a manager. | None | A12 |
| CM-3 | A founder moderates their own city, gated by a live balance check. | src/roles.js:62-64; src/moderation.js:30-38 | Remove the founder branch. Moderators come from console roles and from owner-appointed managers. | None | A12; section 40 cross-role denial |
| CM-4 | Notice kinds for founder windows and elections. Election rows in the dashboard. | src/notify.js:24, 42; public/dashboard.js:828-883; public/dashboard-v2.js:514-540 | Hide the `election` kind in the UI but keep reading the stored preference. New kinds: selection, activity, manager. | None | V05, B12 |

### 5.5 Coin-v2 (switched off): `COIN_V2_READY`, `COIN_V2_REVIEW`, `COIN_V2_BATCH`

Earlier work: PR #92 (`f17489c`), PR #93 (`5c77397`), PR #94 (`4aa408e`). All three switches are off, and their tables are created only by their own routes (src/coinart-store.js:77-99; src/coinreview.js:191-203). Whether those tables exist in production D1 was not checked.

| ID | Old behavior | Files | Exact change or removal | Migration impact | Replacement test |
|---|---|---|---|---|---|
| CV-1 | `COIN_V2_READY`: a ready-made coin per city. The founder must press "Use this coin". The launch then waits for the owner's on-chain approval. | src/coinready.js:61-83, 192-240, 447-500; src/coinart-store.js:191-204; src/flags.js:80-89; wrangler.jsonc:97; public/coin-ready.js:83, 100 | Keep `canonicalContent` (bumped to content v:2), art storage, `symbolTaken`, the preview and the guarded batches. Remove "Use this coin", the `approved*` and `held` gates, and the seat and founder-amount gates. Defaults are published for every registry city with no founder action, behind `METADATA_V5`. | Switch never on; 0 designs. | M01, M03 |
| CV-2 | The default description has no pair and silently drops a missing or repeated region. The pair is hard-coded SOL. The source label is "Vicinity city list". | src/coindefaults.js:22-31 | `renderDescription(approvedText, canonical, quote)` gives "… City, Region or 'no state or region', Country. Paired with QUOTE on Citycoin.dev." One final JSON and SHA-256 per enabled quote. | None | M01 (one SOL and one non-SOL description) |
| CV-3 | `COIN_V2_REVIEW`: moderators may list requests, and admins or the owner decide. | src/admin.js:790-797; src/coinreview.js:984-1212 | Owner only: `need("owner")` to list, `needPost("owner")` to decide. Show the final description and JSON hash for each enabled quote. | None | M02; section 40 cross-role denial |
| CV-4 | A founder description that passes screening becomes the coin's description at once. | src/coinreview.js:862-923 (pass at 883-889) | Remove auto-publish. Screening is advisory only (blocks and flags). Only owner approval writes a new active version. | None | M02, M03 |
| CV-5 | A change request may change the coin name. | src/coinreview.js:649-652, 722-727 | Remove the name field. One request covers ticker, image and descriptive text. | None | M02 |
| CV-6 | An approved ticker waits for a pull request to `scripts/cities/ticker-overrides.json` (job step `coinRegistry`). | src/coinreview.js:22-24, 1191, 1289-1303; src/jobs.js:60 | Approval publishes a registry version or overlay, and the version becomes active after chain confirmation. Remove `registryStep` and the job step. | `ticker-overrides.json` is empty. | M03 |
| CV-7 | Uploads are square PNG only, 64-1024 px and at most 200,000 bytes. Metadata chunks are not stripped. | src/social.js:42; src/coinreview.js:576-617; public/coin-review.js:318-333 | Accept PNG, JPEG or WebP up to 10 MB and 4096 x 4096. Check file signatures, strip EXIF/XMP/text chunks, refuse SVG and HTML, and publish a normalized PNG. | None | M02, M04 |
| CV-8 | The launch pause during review exists only on the website. | src/coinreview.js:1224-1250; src/lplaunch.js:27-28, 301, 354-355 | On chain in the custom program: `submit_metadata_proposal` creates a ReviewLock, and `launch` refuses while it exists. | None | M02, M04 |
| CV-9 | `COIN_V2_BATCH`: the owner's daily round of approve, renew and revoke transactions on the live launchpad, signed by the owner's everyday wallet. | src/lpbatch.js (whole file, 425 lines); src/flags.js:104-116; wrangler.jsonc:109; src/lpadmin.js:617 (record step `batch`); public/admin-lp.js:344-520; public/lp-sign.js:18-24 (owner-round use); docs/COIN-BATCH.md; docs/DEPLOY.md:42; test/lp-batch.test.js; test/lp-batch-ui.test.js | **Remove.** Per-launch staff approval is forbidden (master sections 24, 26, 36). Keep `LP.signAll` only if a founder's two-transaction launch needs it. | Switch never on; no table or column was added. | B01 (no owner signature on launch); V05 |
| CV-10 | A takedown after launch rewrites the bound version, JSON and picture. | src/cointakedown.js:10-18, 59; src/coins.js:377-382 | For new-program coins, the `/coin-meta` bytes never change because the hash is on chain. Before launch, the owner rejects or withdraws. The legacy path is unchanged. | None (no coins) | M04, D03 |
| CV-11 | Rules version 7 draft promises "the owner signs every approval" and "the pair (SOL)". Pending decisions: template look D5, and whether founder descriptions are always read by a person. | docs/RULES-V7-DRAFT.md:53-54, 70-78; docs/DEPLOY.md:41 | Superseded. v5 delegates design (template t2 with the Citycoin.dev emblem). Every founder change goes to the owner. The v5 rules text replaces version 7. | None (never published) | V05 |

### 5.6 Founder coin studio and the LaunchLab pair list (live route, no users)

| ID | Old behavior | Files | Exact change or removal | Migration impact | Replacement test |
|---|---|---|---|---|---|
| ST-1 | `POST /api/coins/design` lets a founder set name, description, pair, color and logo. It closes only while `COIN_V2_READY` is on. | src/coins.js:158-216; src/index.js:548-551; public/dashboard.js:1287, 1363 | Remove the route and UI under `LEGACY_LAUNCH=off`/`METADATA_V5`. The only metadata write is the change request. | 0 designs (`GET /api/coins`). | M01 |
| ST-2 | Pairs SOL, USDC and RAY described as Raydium LaunchLab pairs. | src/coins.js:52-57; src/policy.js:84-86 | Remove. Quotes come from the enabled `QuoteConfig` accounts. | None | B04, B11 |
| ST-3 | The LaunchLab contract path. | src/coins.js:225-260; src/index.js:552-557 (closed by PR #91, `317d47e`) | Keep closed. Keep `settleLegacyContract` for any old submission. | None | B03 |

### 5.7 Legacy launch path on `vicinity_launchpad` (live, and open on chain)

Earlier work: launchpad contracts (PR #34, `985f384`); "City coins on mainnet: admin setup + 'Approve on chain', founder launch, graduate, /coin-meta" (PR #54, `1801f6a`); Meteora program pins (PR #80, `5d5e5f3`).

| ID | Old behavior | Files | Exact change or removal | Migration impact | Replacement test |
|---|---|---|---|---|---|
| LL-1 | Each launch needs an owner-signed `approve_launch` lasting 1-30 days. The admin is the owner's everyday wallet. | src/lpadmin.js:897-963; src/sol/lpadmin-ix.js:203-211; lp:instructions/approve_launch.rs; public/admin-lp.js:315 | Website: with `LEGACY_LAUNCH=off`, `approveTx` and `launchTx` answer 409. On chain, in order: (1) the owner signs `set_pause(launches = true)` (builder exists: src/lpadmin.js:1106-1121); (2) any legacy Approval is revoked; (3) the legacy admin is handed to the Squads vault if the curve's "same admin" check stays. | On chain, `launches_paused = 0` today (section 3). Every step needs a real owner signature. | B14 (old-launch disable rehearsed), A11 |
| LL-2 | 0.05 SOL launch fee, split 90% dev wallet and 10% Meteora. | RPC read (section 3); src/fees.js:25, 172; src/lplaunch.js:165-174 | Never offered to new coins. The new receipt reads "Citycoin.dev platform launch fee: 0". The legacy config stays as deployed. | None | B01 |
| LL-3 | WSOL quote only. | src/lplaunch.js:218 | New coins use the custom program's quote configs. | None | B04 |
| LL-4 | Founder = live seat + founder amount. | src/lplaunch.js:95-105 | Replaced by the FounderRecord lookup (S15-6). | None | A11 |
| LL-5 | Meteora DBC/DAMM v2 launch, trade, graduation and referral. | src/lptrade.js:1-15; src/sol/dbc.js; src/sol/lplaunch-ix.js:36-143; src/programpins.js; src/swap.js:385 | Keep as a narrow legacy module, unreachable from the new launch and trade path. Label it "Legacy launch (Meteora)". `LAUNCHPAD_TRADING` may go off once a fresh read confirms that no legacy coin exists. | None (0 coins) | B11 |
| LL-6 | The owner initializes each city's rewards vault. | src/lpadmin.js:1075 (`initCityTx`) | Not used by new coins. The new launch creates distribution state in the same instruction. | None | B07 |

### 5.8 Draft `vicinity_curve` (`ec148c2`, draft PR #83, not deployed)

The curve stays the base of the custom program (master section 27). Its approval and money-routing model conflicts with v5. Every item below is a change to the undeployed draft.

| ID | Old behavior | Files | Exact change or removal | Migration impact | Replacement test |
|---|---|---|---|---|---|
| VC-1 | Per-city `approve_launch`/`revoke_approval`; an `Approval` that expires within 30 days. | curve:programs/vicinity-curve/src/lib.rs:132-151; curve:…/state.rs:127-151; curve:…/constants.rs:175-177; curve:…/instructions/approve_launch.rs; curve:…/instructions/revoke_approval.rs | Delete for new launches. `launch(city_id, quote_config_id, expected_meta_hash)` is gated by the FounderRecord. | None (not deployed) | A11, B01, B03 |
| VC-2 | Batch launch approval: `init_launch_batch`, `publish_launch_batch`, `clear_launch_batch`, `launch_from_batch`, `LaunchBatch`, `BatchRecord`. | curve:…/lib.rs:215-268; curve:…/batch.rs (944 lines); curve:…/constants.rs:182-214; curve:sdk/curve/batch.mjs; curve:sdk/curve/batch.test.mjs; curve:scripts/vcurve/batch.mjs; curve:scripts/vcurve/batch-mutants.py; curve:tests-curve/30-33*.test.mjs | **Delete.** Reuse the Merkle leaf and tree code for registry versions, without the founder field. | None | B01, B03 |
| VC-3 | The `launch_approver` key and its separation checks. | curve:…/state.rs:52-57; curve:…/helpers.rs:206-268; curve:…/lib.rs:221-225 | Delete. The founder-key check refuses the treasury, the guardian, the selection publisher and verifier, and the root verifiers. | None | B13 |
| VC-4 | Payout opt-in, payout key, payout wallet, 24-hour cooldown, `payouts_paused`. | curve:…/lib.rs:105-115, 194-211; curve:…/constants.rs:178-180; curve:…/instructions/opt_in_payout.rs; curve:…/instructions/payout_founder_fees.rs | Replace with a permissionless founder payout to `coin.founder` (copied from the FounderRecord at launch). Keep `claim_founder_fees` as the wallet-signed fallback. | None | B07, B13 |
| VC-5 | `transfer_founder`: the founder hands the seat to a co-signing key. | curve:…/lib.rs:189-191; curve:…/instructions/transfer_founder.rs:1-6, 38-56 | Delete it, with its event, SDK builder and tests. | None | A10 |
| VC-6 | Launch step 1 sends `launch_fee_lamports` (config #0: 50,000,000 lamports) to `FEE_RECIPIENT`; the cap is 0.5 SOL. | curve:…/instructions/launch.rs:328-340; curve:crates/vicinity-curve-math/src/types.rs:66-78; curve:…/constants.rs:172-174 | Delete step 1 and the `fee_recipient` account. `validate_config` requires a launch fee of 0. SDK `launchFeeLamports = 0n`. | None | B01 |
| VC-7 | `FEE_RECIPIENT = 13qRam…sRiN`, the owner's everyday wallet. | curve:…/constants.rs:18 | A compiled `TREASURY` that the owner provides; the checklist proves it is not a role or member key. | Owner must name the address before the mainnet build. | B13 |
| VC-8 | The holders' share is forwarded to a `vicinity_rewards` vault. | curve:…/lib.rs:179-181; curve:…/instructions/forward_holders_fees.rs:1-10; curve:sdk/curve/rewards.mjs | Delete forwarding. The share stays in the coin's holders bucket until hourly `HourRoot` payouts (S15-8). | None | B07, B09 |
| VC-9 | SOL-only custody in the Coin account's lamports. | curve:…/lib.rs:158; curve:…/state.rs:158-160 | Per-coin quote vault (WSOL for SOL) and `transfer_checked` per `QuoteConfig`. | None | B04, B06 |
| VC-10 | Buyback throughput rule is an SDK and checklist rule only (open decision O36). | curve:sdk/curve/math.mjs:593-614; curve:scripts/vcurve/preflight.mjs:432-442 | Add V12 `25 * buyback_bps <= 3 * total_fee_bps` to `validate_config`. | None | B10 |
| VC-11 | The deploy checklist demands a 1-of-3 guardian (O35). | curve:scripts/vcurve/preflight.mjs:325-328 | Require a controlled 2-of-3 stop-only guardian with no time lock. Its powers: stop selections, launches, buys and buybacks, and cancel pending roots or selections. It can never resume, reassign, upgrade or withdraw. | None | B13 |
| VC-12 | Vicinity names: crate `vicinity_curve`, leaf tag `vicinity_curve/launch_leaf`, metadata prefix `https://vicinity.city/coin-meta/`. | curve:…/constants.rs:205, 217; curve:sdk/curve/constants.mjs:71 | Rename to Citycoin names with a citycoin.dev versioned prefix before the audit build. Legacy program IDs and their derivation tests stay. | None | D09; curve IDL tests |
| VC-13 | Open owner decisions O11 (time lock from the first launch), O12 (payout opt-in), O30-O32 (batch window, validity, approver key), O35 (guardian 1 of 3), O36 (buyback rule). | curve:VICINITY-CURVE-DESIGN.md:3884-3885, 3904-3910 | Settled by v5: a 48-hour governance delay, no opt-in, no batch, a 2-of-3 guardian, V12 enforced. None of these goes back to the owner as a question. | None | B10, B13 |
| VC-14 | Ten rounds of internal automated review converged on one binary. | curve:VICINITY-CURVE-AUDIT.md (review record) | Those conclusions do not carry over to the changed binary. Re-issue the audit pack for the new binary. Do not call it reviewed, audited or ready until the outside audit closes. | None | D12, B13 |

### 5.9 Holder rewards: claim-only epoch rounds

| ID | Old behavior | Files | Exact change or removal | Migration impact | Replacement test |
|---|---|---|---|---|---|
| RW-1 | `vicinity_rewards`: one authority funds an epoch; minimum claim window of 14 days; `sweep_epoch` after it. | solana/programs/vicinity-rewards/src/constants.rs:46-48; …/instructions/fund_epoch_from_vault.rs; …/instructions/sweep_epoch.rs | New coins never use it. The program stays deployed, and its IDs are untouched. | None (no `CityConfig` is expected: no city coin exists) | B09 |
| RW-2 | Round rules: 0.01% balance floor, 0.01 SOL minimum payout, at least 20 holders, at least 6 random samples per epoch. | solana/sdk/launchpad/snapshot.mjs:35-41 | Remove from the new path. Pro rata with floor and no minimum. Dust and no-recipient funds carry to the next valid hour. | None | B09 |
| RW-3 | Legacy design: an epoch every 30 days by Merkle claim (alternatives listed: monthly or weekly). | solana/LAUNCHPAD-DESIGN.md:2402 | Replaced by 3600-second UTC hours with four unannounced samples (one per 15-minute segment) plus the cutoff. | None | B07, B09 |
| RW-4 | No claim UI on the website ("not a promise"). | src/feestatus.js:87 | Push payouts in bounded batches, plus a wallet-signed recovery claim. | None | B09 |
| RW-5 | The 10-minute cron is the only scheduler. | wrangler.jsonc:141; src/jobs.js:22-62 | Unannounced samples in every 15-minute segment need a 1-minute cron or a Durable Object alarm with a random offset. | Additive tables; more RPC load per coin. | B09, D10 |

### 5.10 Fee wording and the swap fee option

| ID | Old behavior | Files | Exact change or removal | Migration impact | Replacement test |
|---|---|---|---|---|---|
| FE-1 | Fee pages show the live legacy 1.25% and 0.05 SOL as the city-coin fees. | src/fees.js:1-30, 124-185; public/coin.js:719-734; public/launchpad.js:852-855 | Show "Approved target: 2.50% (50/70/50/50/30), not yet active" separately from "Live legacy config: 1.25%, no coins", until a custom-program coin exists. | None | B05, V05 |
| FE-2 | `SWAP_PLATFORM_FEE_BPS` / `SWAP_FEE_ACCOUNT` can add a platform fee to swaps (live value 0). | src/cluster.js:93-97; src/swap.js:134; src/jupswap.js:118-127 | Delete the option, or pin it to 0 with a startup refusal of any other value. | None (already 0) | B02 |
| FE-3 | "An admin approves your coin on chain first; your pair must be SOL", approval-round and "Approve on chain" copy. | public/lp-launch.js:54, 257-275; public/dashboard-v2.js:112, 739-741; public/coin-ready.js:83 | Remove. Use the master's DS-06 "Launch" message. | None | V05, B12 |

### 5.11 Copy and documents

| ID | Old behavior | Files | Exact change or removal | Migration impact | Replacement test |
|---|---|---|---|---|---|
| CP-1 | Seven-day, ladder, steward, squad, objection, election and countdown strings are user-visible in 21 source files. | scripts/pages/src/index.html:48, 55, 104, 112-115; scripts/pages/src/cities.html:135-138; scripts/pages/src/dashboard.html:43-54, 238-842; scripts/pages/src/rules.html:9-150; scripts/pages/src/token.html:182, 188; public/cities.js; public/dashboard.js; public/dashboard-v2.js; public/dashboard-roles.js; public/rules.js; public/token.js; public/admin.js; public/admin-lp.js; src/me.js:47-66; the `founder`, `voters` and `manager` blocks of src/policy.js:24-71 (published by `/api/policy` and read by public/rules.js:16-43) | Remove in the same pull request as the `LEGACY_SEATS` freeze. Use the master's DS-06 messages ("Unfounded city", "Founded city", "Country manager"). Seven-day strings that are not qualification rules (the wallet-link safety window, "New" coins under 7 days, chart ranges, ban lengths) are not part of this removal. | Members see new copy. | V05, B12; New: test/copy-v5.test.js |
| CP-2 | The signed-out dashboard preview shows a seven-day founder path, a squad and an election that "closes in 3 days". | scripts/pages/src/dashboard.html:14-16, 43-54 | Replace with the v5 example (city selection, permanent founder, launch center). | None | V05 |
| CP-3 | Documents for superseded flows. | docs/COIN-BATCH.md; docs/COIN-READY.md; docs/RULES-V7-DRAFT.md; docs/DEPLOY.md:38-43 (switch rows) | Delete COIN-BATCH.md (history stays in git). Rewrite COIN-READY.md as `docs/citycoin-master/metadata-review.md`. Mark RULES-V7-DRAFT.md superseded, then delete it with the cleanup. Update the DEPLOY rows when the switches change. | None | D12 |

### 5.12 Owner amendment 01: the main token, the official X page and the official Telegram (24 October 2026)

The owner's written instruction of 24 October 2026 comes after master v5. For the main token only, it supersedes the master's "existing main-token mint preserved" and "no replacement main-token mint" lines (master sections 02, 07, 14, 16 and 28). Full text, consumer list and verification procedure: `amendment-01-new-main-token.md`. The owner has not supplied the new mint, X address or Telegram address yet; all three stay `null`.

| ID | Superseded direction | Files | Exact change | Migration impact | Replacement test |
|---|---|---|---|---|---|
| AM-1 | **Existing main-token mint preserved** (master sections 02, 07, 14, 16 and 28; this file's earlier section 6.2 row and section 8 kept `2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray` as the main token) | wrangler.jsonc:32; src/official.js:10-16, 35, 66-72, 250-253, 267-283; every `activeMint(env)` consumer (amendment-01-new-main-token.md section 5) | The main token is a new mint supplied by the owner and verified on chain before use, held in one setting, `MAIN_TOKEN_MINT`, read through one adapter. `policy.main_token.mint` is `null` until then. `$VICINITY` becomes `policy.legacy_tokens`: history only, never the main token, a balance source, the founder-selection or manager-ranking balance, a purchase link or the main-token quote. | No live change until the owner supplies the value, it is verified, and `MAIN_TOKEN_V5` goes on. Holders keep their `$VICINITY`: no automatic swap, migration, airdrop or transfer. | test/masterpolicy.test.js (amendment 01 tests: `MAIN_TOKEN_IS_LEGACY_MINT`, `MAIN_TOKEN_MINT_INVALID`, `MAIN_TOKEN_MINT_MISSING`); D09 re-stated (implementation-report.md section 7) |
| AM-2 | Selection, tie-break and national rank measured on "the configured main-token mint", which was `$VICINITY` | policy `founder_selection.balance_measure`, `tie_break.balance_mint`, `country_manager.national_rank_balance`; src/ledger.js:24-70; src/store.js:184-191; src/roles.js:20 | The same rules, measured on the verified `MAIN_TOKEN_MINT`. `SELECTION_V5` (shadow or on) and `MANAGER_APPS=on` refuse to start without it. Balance history is keyed by mint, so two tokens are never summed. Hourly holder distribution is per city coin and unaffected. | `balance_samples` and the `day:<d>` blobs hold only `$VICINITY` and become legacy history | A05 to A07, A12 (the configured mint) |
| AM-3 | `$VICINITY` as the main-token quote config (`quote_mint` = the legacy mint, 6 decimals) | policy `quote_configs.main_token`; S15-7 above | `quote_mint`, `quote_decimals` and the raw graduation and minimum-buy amounts are `null` until the configured mint is verified and passes the quote safety checks. The rules stay: 1,000,000-unit graduation, 1-unit minimum buy, same allocation and curve shape. | None (no custom program is deployed) | B04 |
| AM-4 | The official X account `@VicinityCitySOL`, hard-coded in every page footer; no Telegram | src/official.js:21-26; scripts/pages/build.mjs:78-96, 158-159; 16 generated pages (amendment-01-new-main-token.md section 6) | `OFFICIAL_X_URL` and `OFFICIAL_TELEGRAM_URL`, owner-supplied and verified; empty means not shown. The old X account becomes a legacy link and is refused as the new official one (`LEGACY_SOCIAL_LINK_AS_OFFICIAL`). | Footers lose the X icon until a verified link is configured | V05, V06, D06 |
| AM-5 | Purchase links built from the `$VICINITY` mint | src/launchpad.js:49-64; public/token.js:45-48; public/dashboard.js:1548-1612; public/swap.js:425 | Built only from the configured, verified main-token mint, shown only when a live quote finds a route, otherwise hidden; never for a legacy token | None until the switch | V05, B11 |

## 6. Earlier tasks and pull requests

### 6.1 Merged work, with its verdict under v5

From `git log` at `4aa408e` (PR numbers are in the commit subjects).

| PR (commit) | What it did | Verdict under v5 | Where |
|---|---|---|---|
| #3 (`bcd0116`) | Founder qualifying hold 14 days to 7 days (policy v4) | Superseded | FS-1 |
| #4 (`16c4b5e`) | Founder policy v5: Stake Ladder, Seed Steward, Squad Founding | Superseded | 5.3 |
| #5 (`f603a81`) | Audit fixes, including steward fairness | Steward parts superseded; the rest kept | FS-3 |
| #11 (`925a37e`) | Sign-up v2: location, account with password, wallet, dashboard | Superseded. Its location step and limits are reused in wallet-only registration. | 5.1 |
| #16 (`4d66f0b`) | Dashboard v2: tabs, Founder Status against the seven-day rules | Founder Status superseded; tabs restructured under DS-05 | FS-1, CP-1 |
| #17 (`aa5e57b`) | `vicinity_rewards` claim distributor | Program stays deployed. Its round model is superseded for new coins. | 5.9 |
| #20 (`e113e69`) | Switched on `SIGNUP_FLOW=v2`; password-pepper workflow | Superseded when `WALLET_ONLY` goes on | OB-2, OB-4 |
| #23 (`b63acd0`) | Stake Ladder amount on the live map | Superseded | FS-1, CP-1 |
| #34 (`985f384`) | `vicinity_launchpad` and launch fees to the dev wallet | Legacy only | 5.7 |
| #38 (`52f17a4`) | Sign-up carried into the wallet app | Superseded for registration. The carry logic is reused for the 5-minute register hand-off. | OB-9, OB-10 |
| #44 (`745b233`) | Onboarding v3: Location, then Google or email, then Dashboard; wallet later | Superseded | 5.1 |
| #54 (`1801f6a`) | City coins on mainnet: admin setup, "Approve on chain", founder launch | The approval path is superseded for new coins. Graduate and `/coin-meta` stay for legacy coins. | 5.7 |
| #61 (`00d8cae`) | Google sign-in for an existing account | Superseded | OB-3 |
| #76 (`5ce3188`) | In-app notifications, including founder windows and elections | Notices kept. The window and election kinds are retired from the UI. | CM-4 |
| #79 (`b61d2bf`), #82 (`d89e26f`) | Fee figures from the deployed config; founder fee card | Kept for legacy coins. Target and live are labeled separately. | FE-1 |
| #80 (`5d5e5f3`) | Meteora program pins | Legacy only | LL-5 |
| #88 (`008a1ca`) | Rules v6, "SOL pairs" wording | Rules text superseded by the v5 rules | CP-1, S15-7 |
| #91 (`317d47e`) | Closed the old LaunchLab path (one coin per city) | Kept | ST-3 |
| #92 (`f17489c`) | `COIN_V2_READY` (dark) | Kept and changed | CV-1, CV-2 |
| #93 (`5c77397`) | Request changes, review queue, screening, daily approval round (dark) | Review kept and changed; the daily round removed | CV-3 to CV-9 |
| #94 (`4aa408e`) | Review-queue wording (dark) | Changed with CV-3 | CV-3 |

Merged work with no conflict found: the feed, notifications, Wallet tab and Send switches (#85, #86, #87, #75, #77), the token page and holder list (#69-#71), the official coins list (#81, which keeps serving on both hosts), the coin-name check (#84, which stays a pure check), the ticker pin from chain (#72, adapted to registry versions), picture review (#74, adapted to the M02 image rules), and the dashboard layout fixes (#89, #90, to be restructured under DS-05).

### 6.2 Open and pending work

| Item | Source | Verdict under v5 |
|---|---|---|
| Draft PR #83, `feat/vicinity-curve` (head `ec148c2`) | The only open pull request (GitHub REST read, 24 Oct 2026) | **Continue as the v5 base program**, with VC-1 to VC-14 done before the audit build. |
| "Product update: master plan: ship all workstreams one step at a time (wallet, founder claims v6, identity protections, fees/rewards display, trades/holders views, community dashboard)", pending | The lead session's task list as shown to this reconciliation | **Superseded as a plan.** "Founder claims v6" is replaced by 5.3 and S15-4. The master's ordered execution (section 01) replaces the sequence. |
| "Fee 2.5%: program caps + config v2 + displays + burn ledger", pending | same | **Superseded as written.** The 2.50% split is approved for the new custom program only (master sections 16 and 17). The live 1.25% config is preserved for legacy assets (section 07). The program work continues as VC-6 and VC-10 plus the quote-config work. |
| "Custom Vicinity curve program: review converged; … then owner decisions + outside audit", in progress | same | **Continues** as PR #83 above. The owner decisions are settled by v5 (VC-13). |
| "Claim our programs' on-chain IDL accounts … authority to the Squads vault", in progress | same | No conflict found. It concerns the two live programs, whose IDs v5 preserves (section 07). |
| "Outreach so apps show 'Vicinity'" (message drafts awaiting the owner), pending | same | **Conflicts with the product rename** wherever the messages name the platform as Vicinity. Hold them and reword for Citycoin.dev. Under owner amendment 01 `$VICINITY` is a legacy token, so no message may present it as the main token; messages about the main token wait for the new, verified mint (section 5.12). |
| "Release queue: ship one step at a time, live-verify each", in progress | same | Process only; no conflict. |
| "Master amendment 01: new main token mint + new X + new Telegram (central config, verified only)", pending | same | **Applied (design only) in section 5.12 and `amendment-01-new-main-token.md`.** It supersedes the earlier verdict in this row, which kept `2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray` as the main token because the amendment's text was not yet available. The new mint, X address and Telegram address are not supplied yet and stay `null`; nothing changes on the live site until they are supplied, verified and switched on. |

## 7. Rule for history

- Keep these rows readable: `seats`, `windows`, `applications`, `endorsements`, `squads`, `squad_members`, `objections`, `elections`, `election_votes`, `manager_terms`, `streaks`, check-in posts, `user_logins`, `terms_version`/`terms_agreed_at`, `used_nonces`, `admin_audit` and `mod_actions`.
- No history row may authorize a new action. Once `SELECTION_V5=on`, `powersOf` reads founders only from `founder_records`. Once `MANAGER_APPS=on`, it reads managers only from `country_managers`. History endpoints carry `historical: true`. A test asserts that no history table is read on any authorization path (B12; New: test/frozen-legacy.test.js).
- Temporary operators or pending legacy applications are not permanent founders (master section 17). At `4aa408e` no seat is permanent by design, and 0 live seats exist, so the number of legacy FounderRecords to create is zero. Confirm that count with the admin overview (src/admin.js:146-160) before cutover (A14).

## 8. What stays (never removed by this reconciliation)

- `vicinity_launchpad` (`AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai`) and `vicinity_rewards` (`EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG`): their IDs, layouts, PDAs and compiled constants, including `METADATA_URI_PREFIX = "https://vicinity.city/coin-meta/"` (lp:constants.rs:68).
- The `$VICINITY` mint `2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray` and its on-chain name "VICINITY CITY" and symbol "VICINITY", as a **legacy token** (history only). It is no longer the main token (owner amendment 01, section 5.12), and nobody's holdings are swapped, migrated or transferred.
- `/coin-meta/*` on vicinity.city, serving exact bytes and never redirected. `/brand/vicinity-512.png`, which the on-chain Meteora partner metadata names. `/official-coins.csv` on the old host for at least the redirect window.
- The legacy Meteora modules, while any legacy asset could exist. The single 10-minute job with its D1 lease (src/jobs.js:22-37), so that adding citycoin.dev to the same Worker adds no second scheduler (D10).
- The details of each kept item are in `rebrand-inventory.md`.

## 9. Removal order

Each step is reversible by its switch until its cleanup pull request. On-chain steps cannot be undone like website files.

1. **Freeze, no user impact:** `LEGACY_SEATS=frozen` together with the copy removal CP-1 and CP-2. Delete `COIN_V2_BATCH` (CV-9). Add `LEGACY_LAUNCH` and close the studio route (ST-1).
2. **Owner, on chain:** the legacy admin pauses legacy launches (LL-1 step 1). It should come early: once it is done, no new vicinity.city metadata URI can appear on chain.
3. **Identity:** `WALLET_ONLY=on` and `LEGACY_LINK=on` with an end date (5.1, 5.2). Revoke sessions not made by a wallet proof. Run the census first.
4. **Program branch, undeployed:** VC-1 to VC-12 and the FounderRecord, quote-config, review-lock and hourly instructions. Then the audit pack for the new binary (VC-14).
5. **Shadow:** `SELECTION_V5=shadow` and `CC_HOURLY=shadow` for at least 48 hours of real operation (master section 37).
6. **After the outside audit and the owner's multisig actions:** deploy the custom program paused, then `SELECTION_V5=on`, then `LAUNCH_V5=on`, `CC_TRADING=on` and `CC_HOURLY=on` for 1-3 SOL cities, 72 hours of observation, then the other quotes, each with its own evidence.
7. **Cleanup pull requests, after their windows:** delete the frozen seat and election writers, the Google, email and password code (after `LEGACY_LINK_UNTIL`), the `COIN_V2_READY`/`COIN_V2_REVIEW` code paths and switches, `SIGNUP_FLOW`, the `coinRegistry` job step and RULES-V7-DRAFT.md.

## 10. Owner and external actions that gate removal steps

1. **Owner's everyday wallet `13qRam…sRiN` signs:** the legacy `set_pause(launches = true)`; any Approval revocation; and, if the curve's "same admin" check stays, `propose_admin` to the vault on both programs.
2. **Squads multisig, 2 of 3 real member signatures:** set the time lock to 48 hours (today 0); create the controlled 2-of-3 guardian; deploy the custom program from an owner-generated key with the vault as upgrade authority; set the role keys; add the quote configs; publish registry roots.
3. **Owner provides:** a dedicated treasury address (not `13qRam…`, not a member key); the metadata-admin key; selection publisher and verifier keys and independent verifier hosting; two historical-balance data providers (proposed secret names `SELECTION_ARCHIVE_URL_A`, `SELECTION_ARCHIVE_URL_B`); a funded keeper wallet; a paid RPC plan; an alert destination.
4. **Outside audit** of every new or changed program instruction (VC-14).
5. **Credential holders:** production D1 read access for the identity census; Cloudflare access for the citycoin.dev routes; the Google OAuth console, only if Google linking must work on citycoin.dev during the legacy window, and afterwards to delete the client and the secrets `GOOGLE_CLIENT_SECRET` and `PASSWORD_PEPPER`.
6. **Owner approves the revised Terms text** (OB-12). Its contact clauses name the X account, so they change with amendment 01.
7. **Time:** the legacy-link window, 48 hours of shadow operation, and 72 hours with the first 1-3 cities. None of these may be shortened by invented elapsed time.
8. **Real owner review actions** for every country-manager application and metadata proposal. None may be simulated or seeded.
9. **Owner supplies the new main-token mint, the new official X address and the new official Telegram address** (amendment 01, section 5.12), each verified before use (`amendment-01-new-main-token.md` section 4). Until then all three stay empty and every feature that needs the main token stays off.

## 11. Verification log (24 October 2026)

- `git -C scratchpad/citycoin status` and `git diff --stat 4aa408e -- src public wrangler.jsonc solana scripts test`: no tracked file differs from `4aa408e`.
- Line checks with `sed -n` against `4aa408e`: src/flags.js:1-12, 85-116; src/signup-finish.js:41-54; src/auth.js:204-227; src/signed.js:9; src/index.js:495-503, 546-557, 689-707; src/store.js:55, 846-850; src/policy.js:20-40, 82-100; src/roles.js:28-37, 60-66; src/me.js:28-31, 415-420; src/coins.js:50-58, 156-162; src/coindefaults.js:22-31; src/coinreview.js:576-578, 649-652, 880-890, 1224-1226; src/admin.js:280-282, 329, 352-354, 788-798; src/lpbatch.js:1-20; src/lpadmin.js:895-903, 1073-1076; src/access.js:28-42; src/social.js:219-231; src/lplaunch.js:93-106, 216-220; src/snapshot.js:1-8; src/cluster.js:90-98; src/moderation.js:28-38, 322-324; src/official.js:313-316; src/cointakedown.js:10-18; public/admin-lp.js:344-346; src/jobs.js:46-47, 60; solana/programs/vicinity-rewards/src/constants.rs:44-49; solana/sdk/launchpad/snapshot.mjs:14-41; lp:constants.rs:13-16, 66-69; solana/LAUNCHPAD-DESIGN.md:2402; docs/RULES-V7-DRAFT.md:1-6, 50-78; docs/DEPLOY.md:38-43.
- Line checks against `ec148c2`: curve:programs/vicinity-curve/src/lib.rs (every `pub fn` line); curve:…/instructions/transfer_founder.rs:1-6; curve:…/instructions/launch.rs:326-342; curve:…/constants.rs:16-19, 170-218; curve:crates/vicinity-curve-math/src/types.rs:64-79; curve:…/helpers.rs:204-220; curve:scripts/vcurve/preflight.mjs:325-328; curve:…/instructions/forward_holders_fees.rs:1-10; curve:…/state.rs:127-131, 146-149; curve:VICINITY-CURVE-DESIGN.md:3876-3910.
- Function locations by `grep -n` in src/seats.js, src/elections.js, src/auth.js, src/walletlink.js, src/pwlogin.js, src/logins.js, src/coinready.js, src/coinreview.js, src/coins.js, src/lpbatch.js, src/lpadmin.js and src/lplaunch.js.
- Six public GETs to https://vicinity.city: `/api/seats`, `/api/coins`, `/official-coins.csv`, `/api/me`, `/api/members`, `/api/policy`.
- Two read-only RPC calls on `api.mainnet-beta.solana.com`: `getMultipleAccounts` (finalized) for the legacy Launchpad PDA, the legacy LaunchConfig PDA and the Squads multisig, decoded by hand (slot 460699575); `getAccountInfo` (finalized, parsed) for the USDC mint (slot 460704034).
- `grep -o "CREATE TABLE IF NOT EXISTS …"` over src/ for the history table names in section 7.
- One GitHub REST read: open pull requests of the repository.
- No transaction was sent. No keypair was created or read. No database was read. No signed request was made.
- Amendment 01 update (24 Oct 2026): `git grep -n` at `4aa408e` for `VICINITY_MINT`, `activeMint(`, the legacy mint literal, `x.com/VicinityCitySOL` and `t.me` (commands in `amendment-01-new-main-token.md` section 10). No network request.
- Phase 1 independent check (24 Oct 2026): about 40 of the `path:line` references above re-read at `4aa408e` and `ec148c2`, all matching. Corrected here: the switch table in section 2 (one name per switch, matching `schema-and-api.md` section 2.2: `LAUNCH_V5`, with `CC_LAUNCH` noted as the same switch; `FOUNDER_RECORD_CHAIN` added; `CC_POLICY` dropped because `PUBLIC_V5` covers the public policy); section 9 step 6; and S15-4, where `21600` does occur once at `4aa408e`, as a chart time step.
