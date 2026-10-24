# Citycoin.dev: rebrand inventory (BR-01)

Required by master change order v5 (23 October 2026), section 03 (BR-01: "Create docs/citycoin-master/rebrand-inventory.md with old value, new value, consumer, migration dependency and test") and section 43 ("every brand/domain consumer, old/new value, remaining legacy string, integration owner and migration test").

Written 24 October 2026 against main `4aa408e`, and updated the same day for owner amendment 01 (section 3.8): the main token becomes a new, owner-supplied mint configured as `MAIN_TOKEN_MINT`, `$VICINITY` becomes a legacy token, and the official X and Telegram links move to central configuration. The token counts below are unchanged; only the classification of the mint and social-link occurrences changes. This is an inventory only. No string, route, provider setting or on-chain value has been changed. Untracked files in the working tree (for example `public/brand/citycoin-*.svg`) are not part of `4aa408e`, and this file does not count or assess them.

## 1. Method

- **Search.** `git grep -n -I -i vicinity 4aa408e` finds 3,848 matching lines in 431 text files. `git grep -l -i vicinity 4aa408e` adds 2 binary files (`solana/release/mainnet-2026-10-10/vicinity_launchpad.so`, `vicinity_rewards.so`), for 433 files.
- **Unit of count.** Every count in this file is a **token**: a run of name characters (`[$@A-Za-z0-9_.:/|-]`) that contains "vicinity" in any case. Each binary file counts as one. That gives **4,593 counted items** (4,591 tokens plus 2 binaries). The raw word count is 4,606, because some tokens contain the word twice, for example `https://vicinity.city/brand/vicinity-512.png`.
- **Classifier.** A rule-based script classified every token (first matching rule wins). It was run again for this file, and its output was identical to the earlier run. The rules, in order:
  1. History by path: release files, audit documents, devnet records, applied migrations, countdown site copy.
  2. Deployed program source, IDL and binaries.
  3. Program, crate and IDL names; Cloudflare resource names; environment key names; tie-break hash domains; the on-chain metadata URI constant.
  4. `$VICINITY`, the bare ticker `VICINITY`, the official X handle.
  5. Hosts (`vicinity.city`, `vicinitycity.net`/`.com`, `vicinity.test`, and the mail sender address on vicinity.city), except inside comments and docs.
  6. Quoted browser storage keys and quoted `"vicinity"` API or D1 values.
  7. Docs, comments and internal identifiers.
  8. Anything left that contains "Vicinity": a visible label.
- **Required classes.** The master's five classes plus one more:
  - **migrate**: visible labels plus URLs that move through configuration.
  - **compatibility-required**: old values that must keep working for a window or for as long as existing assets depend on them.
  - **persistent identifier**: values that never change. The master lists serialized enums, database keys, PDA seeds, mints, program IDs, addresses, historical signatures and immutable asset URIs.
  - **third-party**: names that belong to the chain or to someone else's account.
  - **history**.
  - **developer-only**: comments, internal identifiers and developer docs. This sixth class exists because 666 tokens fit none of the five. Renaming them is optional and changes nothing a user sees.
- **Compatibility-required items.** These were taken out of the label and URL classes by explicit rules, listed in section 3.3: the legacy brand image, legacy `/coin-meta` URLs, the old routes and redirect sources, the old domains on the official list, the old wallet statements during the legacy window, and the frozen legacy coin-JSON brand.
- **Error margin.** The rules were spot-checked file by file for `src/` and by sampling elsewhere. A few tokens at class boundaries may be misclassified (for example a local variable named `vicinity`). The per-file totals and the file list are exact.
- **Committing the classifier.** The counts in this file come from a scratch script outside the repository. Stage S02 commits a classifier with the same rules as `scripts/brand/residual.mjs` (report only: it prints counts per class and area and always exits 0; `--list` and `--json` give the detail). Its counts differ a little from the ones below because it scans the tree as committed, including the phase 1 files under `docs/citycoin-master/` that `4aa408e` does not have. It becomes a CI gate on unclassified labels once `BRAND=citycoin` (stage S48).

## 2. Totals

### 2.1 Per class

| Class | Tokens | In production files | In test files |
|---|---|---|---|
| migrate | 1,649 | 831 | 818 |
| compatibility-required | 90 | 51 | 39 |
| persistent identifier | 859 | 442 | 417 |
| third-party | 986 | 512 | 474 |
| history | 343 | 343 | 0 |
| developer-only | 666 | 520 | 146 |
| **Total** | **4,593** (433 files) | 2,699 | 1,894 |

"Test files" means `test/`, `solana/tests*`, any `*.test.*` file and any `/tests/` path. The migrate class splits into 1,298 visible labels and 351 URLs. 589 of the labels are test assertions, which change in the same pull request as the code they test.

How the counts break down inside each kept class:

- **Persistent identifier (859):**

  | Item | Tokens |
  |---|---|
  | Program, crate and IDL names | 205 |
  | API and D1 values `vicinity` | 202 |
  | Environment key names | 176 |
  | Browser storage keys | 140 |
  | Deployed program source | 63 |
  | Cloudflare resource names | 22 |
  | Countdown resources and domain | 17 |
  | On-chain metadata URI constant | 17 |
  | Blocked-password entries | 9 |
  | Tie-break hash domains | 5 |
  | Release binaries | 2 |
  | Cookie name | 1 |

- **Third-party (986):** `$VICINITY` 823, ticker `VICINITY` 88, X handle `@VicinityCitySOL` 75. Under amendment 01 the first two are the legacy token's names and the handle is a legacy social link; their consumers are re-classified in section 3.8.
- **History (343):** release, audit, devnet and migration records 313; countdown site copy 30.

### 2.2 Per area

| Area | Files | Total | migrate | compat. | persistent | third-party | history | dev-only |
|---|---|---|---|---|---|---|---|---|
| test/ (Worker and UI tests) | 163 | 1,734 | 763 | 35 | 377 | 466 | 0 | 93 |
| src/ (Worker) | 59 | 571 | 201 | 27 | 93 | 78 | 0 | 172 |
| public/ (client JS, CSS, images) | 39 | 537 | 194 | 0 | 89 | 172 | 0 | 82 |
| public/*.html (generated by scripts/pages/build.mjs; fix the source) | 16 | 390 | 270 | 0 | 3 | 112 | 0 | 5 |
| solana/ SDK, scripts, tests | 70 | 372 | 73 | 11 | 130 | 13 | 8 | 137 |
| solana/ docs | 13 | 372 | 0 | 3 | 37 | 6 | 275 | 51 |
| scripts/pages/ (page sources and layout) | 17 | 211 | 121 | 0 | 1 | 70 | 0 | 19 |
| docs/ and README.md | 9 | 182 | 0 | 6 | 18 | 49 | 20 | 89 |
| solana/ deployed programs, IDL, release files | 25 | 78 | 0 | 0 | 69 | 0 | 9 | 0 |
| scripts/ (build, preflight, data tools) | 10 | 55 | 16 | 6 | 8 | 18 | 0 | 7 |
| countdown/ (vicinitycity.com Worker) | 5 | 51 | 4 | 0 | 17 | 0 | 30 | 0 |
| repository config (wrangler, package, CI, migrations) | 7 | 40 | 7 | 2 | 17 | 2 | 1 | 11 |

Per-file counts for all 433 files are in Appendix A. That table is the "remaining legacy string" list the master asks for.

## 3. Inventory by class

Each subsection is one class, and every row in it has that class. The row ID prefix repeats it: L and U = migrate, C = compatibility-required, P = persistent identifier, T = third-party. Columns: old value; new value; consumer (`path:line` at `4aa408e`); migration dependency; test; integration owner. "Code" as the owner means the change is made in this repository. Every other owner is the holder of an outside account. Proposed switches (`BRAND`, `SITE_ORIGIN`, `SITE_ORIGINS`, `HOST_REDIRECT`, `PUBLIC_V5`) do not exist yet; unset means today's bytes.

### 3.1 Migrate: visible product labels (1,298 tokens)

| ID | Old value | New value | Consumer | Migration dependency | Test | Owner |
|---|---|---|---|---|---|---|
| L01 | Page titles "Vicinity — One city. One coin. One community." and "<title> · Vicinity" (also `og:title`) | "Citycoin.dev" in the same positions | scripts/pages/build.mjs:104, 115 (every page) | `src/brand.js` read at build time; the build parity test proves that unset `BRAND` gives today's bytes | D01, D07 | Code |
| L02 | Header brand: `aria-label="Vicinity home"`, `/logo.svg`, text "Vicinity" | DS-03 wordmark: lowercase citycoin.dev, navy "citycoin" and gold ".dev", with a verified inverse for dark surfaces; `aria-label="Citycoin.dev home"` | scripts/pages/build.mjs:131-133 | DS-03 asset files, which are not in `4aa408e` | D01, V01, V06 | Code |
| L03 | Footer "Vicinity.city © 2026. All rights reserved." with `/logo.svg` | "Citycoin.dev © 2026. All rights reserved." No new legal entity is named. | scripts/pages/build.mjs:154 | DS-03 | D01 | Code |
| L04 | Social link labels "Vicinity on <network> (<handle>)" and "Vicinity on social media" | "Citycoin.dev on …", for the links in `OFFICIAL_X_URL` and `OFFICIAL_TELEGRAM_URL` only (amendment 01; empty means no icon) | scripts/pages/build.mjs:96, 158 | The owner supplies and verifies the new accounts (T03, section 3.8) | D01, V06 | Code |
| L05 | Icons `public/favicon.svg` and `public/logo.svg` (orange pin, `aria-label="Vicinity"`); `theme-color` #070E19 | DS-03 favicon (SVG and 16/32/48 px), apple-touch 180, app icons 192/512, Civic Atlas theme color | scripts/pages/build.mjs:113, 118, 132, 154; public/favicon.svg; public/logo.svg | DS-03 assets; DS-04 tokens | V01, V06, D07 | Code |
| L06 | Line-1 page titles and descriptions in every page source, for example 404 "This page isn't on the Vicinity map." | Citycoin.dev wording | scripts/pages/src/*.html (100 label tokens; 7 more are in scripts/pages/build.mjs, rows L01-L04); scripts/pages/src/404.html:1, 8, 14. The generated public/*.html follow from the source. | `BRAND` | D01, V06 | Code |
| L07 | Terms of Use: "the operator of Vicinity", "vicinity.city" | "the operator of Citycoin.dev", "citycoin.dev". No change of party. The 2026-10-01 text stays at a versioned URL. | scripts/pages/src/terms.html:1, 6, 45, 110-112, 202 | The owner approves the new Terms text. The same version also changes the Google sign-in clause and the launch-fee clause (00-reconciliation OB-12). | D01, D12 | Code (owner approves) |
| L08 | Client copy, for example the invite "I'm repping <city> on Vicinity…" | Citycoin.dev | public/dashboard.js:841; public/coin-review.js:138-139, 257; public/launchpad.js:346, 558, 607; public/coin.js; public/signup.js; public/coin-ready.js; public/admin.js; public/admin-lp.js (167 label tokens in public/) | A `brand` object on `/api/official` (src/official.js) | D01, V06 | Code |
| L09 | Worker notices and refusals: coin review, takedown, coins and launch | Citycoin.dev wording, only for messages that survive the v5 removals (many belong to flows that 00-reconciliation removes) | src/coinreview.js:78, 96, 108, 127, 340-394, 1209, 1300; src/cointakedown.js:40-42, 160-314; src/coins.js:227, 234, 316, 375, 417-418; src/index.js:550, 556 | 00-reconciliation sections 5.5-5.7 | D01, V05 | Code |
| L10 | "Vicinity" as a party in fee wording | "Citycoin.dev platform" on the custom path. Legacy coin fee lines keep naming the legacy launchpad accurately. | src/fees.js:124-185 | `CC_POLICY` | B05, V05 | Code |
| L11 | Official token table: name "Vicinity", platform "Vicinity Launchpad" | Main-token row labeled "Main token", from `MAIN_TOKEN_MINT` with the on-chain name and symbol recorded at verification (amendment 01); a separate row "Legacy token: $VICINITY" ("VICINITY CITY", `VICINITY`), marked history only; city-coin row "Citycoin.dev launchpad" | src/official.js:66-71 | The owner supplies the new mint and it is verified (amendment-01-new-main-token.md section 4) | D09, D01 | Code |
| L12 | Mail subjects and bodies ("<code> is your Vicinity code"); display name "Vicinity" | Citycoin.dev | src/mail.js:98-99, 149-251 | The sender address moves only after verification (U03) | D06, V06 | Code |
| L13 | Coin-art arc text "VICINITY CITY" (template t1) | New template t2 with the Citycoin.dev emblem. t1 stays so stored picture hashes remain valid. | src/coinart.js:45, 58 | DS-03 emblem | M01, V06 | Code |
| L14 | Coin metadata JSON brand for coins of the new custom program | Citycoin.dev name, citycoin.dev site, logo and versioned metadata prefix | src/coinmeta.js (new constants chosen by program ID); the curve prefix (P15) | The custom program's prefix must change before the audit build | D03, D09 | Code |
| L15 | Brand-impersonation guards that know only "vicinity" | Add "citycoin" and look-alikes; keep "vicinity" | src/me.js:286-299 (reserved usernames); src/screen.js:1061; src/screen-words.js:150-183; src/coinreview.js:133 (reserved tickers) | None | New: guard cases in the existing username and screener tests | Code |
| L16 | Wallet statements "Verify wallet ownership for Vicinity…" and the login, link and proof statements | New purpose-specific statements, for example "Sign in to Citycoin.dev with this wallet." Each keeps the "Free, not a transaction" sentence. | src/solana.js:55-92 | Server challenge service (00-reconciliation OB-7). The old text stays accepted on vicinity.city during the legacy window (C08). | A02, D04 | Code |
| L17 | Label assertions in tests (550 tokens in test/) | Updated with the code they assert | test/ | Same pull request as the code | Full suite | Code |

### 3.2 Migrate through configuration: URLs, hosts and senders (351 tokens)

| ID | Old value | New value | Consumer | Migration dependency | Test | Owner |
|---|---|---|---|---|---|---|
| U01 | `CANONICAL_HOST = "vicinity.city"`; a 301 for every method from the forward hosts and from http | `SITE_ORIGIN` = `https://citycoin.dev`. Answer 308 for GET and HEAD and 421 `wrong_host` (no Location) for other methods. The destination comes from configuration, never from the Host header. | src/index.js:689-707 | Pages must pass through the Worker. Today `run_worker_first` lists only `/api/*`, `/coin-meta/*` and `/official-coins.csv` (wrangler.jsonc:124), so this redirect code cannot run for pages. The fix is `run_worker_first: true` or zone Redirect Rules. | D02, D03, D05; New: test/host-redirect.test.js | Code; Cloudflare account holder (if Redirect Rules) |
| U02 | Worker routes for the old hosts only | Add `citycoin.dev` and `www.citycoin.dev` as custom domains. Cloudflare issues TLS. | wrangler.jsonc:130-133 | Cloudflare access to the citycoin.dev zone. DNS read on 24 Oct 2026: citycoin.dev uses the same nameservers as vicinity.city, has no A record, and www.citycoin.dev does not exist. | D02 | Cloudflare account holder |
| U03 | `EMAIL_FROM`: display name "Vicinity" with a no-reply address on vicinity.city (the same fallback is in code; the address is not reproduced here) | Display name "Citycoin.dev" with a no-reply address on citycoin.dev | wrangler.jsonc:26; src/mail.js:111 | The mail provider must verify citycoin.dev (provider-issued DKIM/SPF) first. Until then, keep the old sender or send in-app notices only. Keep the vicinity.city mail records. | D06 | Mail provider account holder |
| U04 | SMTP `EHLO vicinity.city` and the links in mail templates | From `SITE_ORIGIN` | src/mail.js:88, 91, 150, 171-177, 200, 217, 234, 248, 251 | U03 | D06 | Code |
| U05 | Outbound user agent "vicinity.city/1.0 (+https://vicinity.city)" | "citycoin.dev/1.0 (+https://citycoin.dev)", from configuration | src/sources.js:15; src/swap.js:112 | None | D06 | Code |
| U06 | Data-source labels "read by vicinity.city" | "read by Citycoin.dev" | src/coin.js:80, 119; src/lpcoins.js:457-458; src/marketlive.js:224-232; src/pricehistory.js:207-250; public/coin.js; public/coinchart.js:208; public/launchpad.js:297, 313; public/home.js:83; public/admin.js:513, 639 | public/launchpad.js:297 matches the server text with a regular expression, so change server and client in one pull request | D01 | Code |
| U07 | In-app instructions naming the old host ("open vicinity.city…") | `location.host` or the brand configuration | scripts/pages/src/connect.html:61, 109, 274, 380; public/cities.js:1607; public/dashboard.js:374; public/swap.js:132; public/wallet-send.js:39; public/lp-launch.js:529-533 | None | D01, D06 | Code |
| U08 | Page copy naming the old host | Brand configuration | scripts/pages/src/terms.html:6, 202; scripts/pages/src/credits.html:1, 6, 45; scripts/pages/src/launchpad.html:53, 55; scripts/pages/src/coin.html:159; scripts/pages/src/token.html:45 | L07 for the Terms | D01 | Code |
| U09 | Coin-art URL `https://vicinity.city/coin-meta/art/<sha>.png` | Base chosen per program: coins of the live launchpad keep vicinity.city (C05); new-program coins use citycoin.dev | src/coinart-store.js:130 | None (0 legacy coins today) | D03 | Code |
| U10 | Post-deploy check base `https://vicinity.city` | `SITE_ORIGIN`, plus checks for the 308, the 421 and the excluded paths | scripts/check-live.mjs:6; .github/workflows/deploy.yml:44 | None | D11 | Code |
| U11 | Countdown Worker `REDIRECT_TO = "https://vicinity.city/"` | `https://citycoin.dev/` at redirect cutover, to avoid a two-hop redirect | countdown/src/index.js:12; countdown/public/teaser.js:49; .github/workflows/deploy-countdown.yml:36 | U01 live | D03 | Code; Cloudflare account holder (countdown deploy) |
| U12 | Google OAuth callback registered for vicinity.city; the redirect URI is built from the request | Only if Google legacy linking must work on citycoin.dev during the legacy window: add the citycoin.dev callback, take the URI from configuration, and remove both when the window closes | src/auth.js:471-520 (start), 582-619 (callback) | 00-reconciliation OB-6 | D05, D06 | Google Cloud console holder |
| U13 | Missing consumers: no canonical link, `og:url`, `og:image`, Twitter card, JSON-LD, sitemap, web manifest or apple-touch icon | Add them from `SITE_ORIGIN` and `BRAND`. Production is indexable; preview is `noindex`. | scripts/pages/build.mjs:111-118 (head) | DS-03 social image and icons | D07, V06 | Code |
| U14 | Test fixtures that expect `vicinity.city` or `vicinity.test` origins (213 URL tokens in test/; the other 35 there are compatibility-required) | Follow `SITE_ORIGIN` | test/ | Same pull request | Full suite | Code |

### 3.3 Compatibility-required (90 tokens, plus consumers with no "vicinity" token)

These values keep working after the rename. They must not be redirected into changed content.

| ID | Old value (kept) | New value | Consumer | How long | Test | Owner |
|---|---|---|---|---|---|---|
| C01 | Routes `vicinity.city` and `www.vicinity.city` | Unchanged; they serve redirects and the excluded paths | wrangler.jsonc:131-132 | At least 12 months after cutover (master section 04) | D03, D11 | Cloudflare account holder; registrar (renewal) |
| C02 | Redirect sources `www.vicinity.city`, `vicinitycity.net`, `www.vicinitycity.net` (and `vicinity.city` itself once citycoin.dev is canonical) | 308 to citycoin.dev for public GET and HEAD pages, keeping the path and safe query parameters. The hand-off parameters `link`, `pair`, `code`, `register`, `carry`, `state` and `ref` are dropped. Other methods get 421. | src/index.js:692 | Same window as C01 | D03, D05; New: test/host-redirect.test.js | Code |
| C03 | Official websites `vicinity.city`, `vicinitycity.com`, `vicinitycity.net` | Kept on the list (they redirect); `citycoin.dev` added first | src/official.js:32 | While they redirect | D06 | Code |
| C04 | `/brand/vicinity-512.png` | Unchanged bytes, never redirected | public/brand/vicinity-512.png; named on chain by the Meteora DBC partner-metadata account `2be9mDcnk6rK2XVnNiTBH4JmeWWwFzmUXMSrXMS8si11`, which reads "Vicinity", "https://vicinity.city" and this URL (RPC read, 24 Oct 2026); src/sol/lpadmin-ix.js:48; coin-JSON fallback src/coinmeta.js:13, 37, 187; solana/sdk/launchpad/metadata.mts:19; scripts/mainnet-preflight.mjs:357-361; scripts/brand-png.mjs:3, 17, 56 | Permanently, unless the fee-claimer wallet updates the on-chain record. Whether DBC offers such an update was not verified. | New: test/persist-guard.test.js pins the file hash | Code; fee-claimer wallet holder (`13qRam…`) for any on-chain update |
| C05 | `/coin-meta/<mint>.json`, `/coin-meta/<mint>.png`, `/coin-meta/art/<sha>.png` on vicinity.city | Exact bytes, never redirected | src/coinmeta.js:2, 128-214; the compiled URI prefix (P02); test assertions in test/coin-ready-*.test.js, test/coinmeta.test.js and test/official-coins.test.js | For every coin whose on-chain URI names vicinity.city. There are 0 today (`/official-coins.csv` is empty), and the number stays 0 if legacy launches are paused before any new approval. | D03, D09 | Code |
| C06 | Legacy coin-JSON brand: name "Vicinity", site `https://vicinity.city`, logo, and "Launched on Vicinity (https://vicinity.city) on Solana." | Frozen as `LEGACY_BRAND`, selected by program ID = `vicinity_launchpad`, never re-rendered with the new brand | src/coinmeta.js:35-37, 68; solana/sdk/launchpad/metadata.mts:16-19, 99, 127-131 | As long as legacy coins can exist | New: a stored `meta_json` hashes the same under every `BRAND` value | Code |
| C07 | Meteora partner entry `{ name: "Vicinity", website, logo }` | Unchanged (it mirrors the on-chain record) | src/sol/lpadmin-ix.js:48 | As long as the on-chain record is unchanged | test/persist-guard.test.js | Code |
| C08 | Old wallet statement texts | Accepted only on vicinity.city during the legacy window. citycoin.dev accepts only the new statements (L16). | src/solana.js:55-92 | Until `LEGACY_LINK_UNTIL` | A02, D04 | Code |
| C09 | `/official-coins.csv` and its JSON on vicinity.city (no "vicinity" token; listed as a consumer) | Served on both hosts, never redirected, because a list consumer may not follow redirects | src/officialcoins.js:66, 234-244 | At least the redirect window | D03 | Code |
| C10 | Read-only `GET /api/*` on vicinity.city (no token; listed as a consumer) | Keeps answering during the compatibility window. Mutations answer 421 `wrong_host`. | src/index.js (routing) | The redirect window | D05 | Code |

Token count by rule:

| Rule | Tokens |
|---|---|
| Legacy brand image | 36 |
| Legacy `/coin-meta` URL | 24 |
| Old wallet statements | 11 |
| Legacy SDK builder | 6 |
| Frozen coin-JSON brand | 3 |
| Official list | 3 |
| Old redirect hosts | 3 |
| Old routes | 2 |
| Partner entry | 2 |
| **Total** | **90** |

The 39 test tokens among them assert legacy behavior, and they stay.

### 3.4 Persistent identifiers (859 tokens)

| ID | Value (never changed) | Consumer | Why it stays | Test | Owner |
|---|---|---|---|---|---|
| P01 | Program names and IDs `vicinity_launchpad` (`AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai`) and `vicinity_rewards` (`EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG`); crate names; IDL files; release binaries | wrangler.jsonc:60-61; lp:lib.rs:49; solana/programs/vicinity-rewards/src/lib.rs:43; solana/sdk/idl/; solana/release/mainnet-2026-10-10/*.so | Deployed, verified builds. Renaming changes the build. The UI may show "Launchpad program (vicinity_launchpad)". | D09; New: test/persist-guard.test.js | Code |
| P02 | `METADATA_URI_PREFIX = "https://vicinity.city/coin-meta/"` of the live program | lp:constants.rs:68; src/sol/layout.js:1228; src/coinmeta.js:39; solana/sdk/launchpad/metadata.mts:5, 22, 82 | Compiled into the deployed binary. Every coin this program launches carries it for good. It is the reason for C05. | test/persist-guard.test.js | Code |
| P03 | Worker name `vicinity-map` | wrangler.jsonc:7; `/api/health` `service` field (src/index.js:423); package.json:2; package-lock.json:2, 8; dashboard rollback by name (docs/DEPLOY.md:186) | A live Cloudflare resource | D11 | Cloudflare account holder |
| P04 | D1 database `vicinity-claims` and its ID | wrangler.jsonc:139; migrations/0001_city_claims.sql:1 | Live database name and ID | D08 | Cloudflare account holder |
| P05 | Countdown Worker and D1 `vicinity-countdown`; domain `vicinitycity.com` | countdown/wrangler.jsonc:6, 25; .github/workflows/deploy-countdown.yml:1, 29 | Live resources on another domain (master section 06: "do not rename unrelated domains, provider accounts") | None | Cloudflare account holder |
| P06 | Environment names `VICINITY_MINT` and `VICINITY_REQUIRE_SHORT_WINDOWS` | wrangler.jsonc:32; src/official.js:11-14, 35; .github/workflows/solana.yml:116-120 | Config keys. Renaming one under `keep_vars` (wrangler.jsonc:20) would leave a stale value. Under amendment 01, `VICINITY_MINT` keeps its name but holds only the legacy `$VICINITY` mint for history; the main token is read from the new key `MAIN_TOKEN_MINT` through the adapter `mainMint(env)` (section 3.8). | Full suite; test/masterpolicy.test.js | Code |
| P07 | Tie-break hash domains `vicinity-seat|` and `vicinity-election|` | src/seats.js:395; src/elections.js:99; described on scripts/pages/src/rules.html:28 and public/rules.js:45 | Past results stay reproducible. The descriptions on the rules page go away with the old rules copy. | test/persist-guard.test.js | Code |
| P08 | API and D1 value `vicinity`: `kind: "vicinity"` and key `vicinity` (live `GET /api/coins` returns `"vicinity":"2aVk…"`); `picture: "vicinity"` in `draft_picture`; `by: "vicinity"`; fee-split keys | src/coin.js:33; src/coins.js:124, 152, 155; src/launchpad.js:189, 196, 205, 252; src/coinreview.js:626-655, 793; src/coinart-store.js:240, 242; src/fees.js:108, 117; src/lpadmin.js:732, 844; read by public/launchpad.js, public/coin.js, public/swap.js, public/profile.js, public/coin-review.js and CSS selectors in public/pages-coin.css and public/pages-launchpad.css | Data and API contracts. None is shown to users as-is. | test/persist-guard.test.js | Code |
| P09 | Rewards city tag `vicinity:city:<city id>` | src/sol/lpadmin-ix.js:79-88 (written into each `vicinity_rewards` CityConfig account by `init_city`) | On-chain account data of the legacy rewards program | test/persist-guard.test.js | Code |
| P10 | Browser storage keys such as `vicinity-account`, `vicinity:dash-v2`, `vicinity.walletApp`, `vicinity_terms`, `vicinity-theme`, `vicinity:me` and `vicinity.swapAuto` | public/site.js:28, 108-114, 390, 406, 419, 575-589, 610-615, 633-643; public/theme.js:7, 28, 37; public/swap.js:44-46; public/connect.js:57, 387; public/signup.js:862, 890, 1082, 1473; public/dashboard.js:61, 281, 287, 1980; public/dashboard-v2.js:166; public/cities.js:381, 1326-1333, 1553, 1825; public/profile.js:362 | Storage is per origin, so citycoin.dev starts empty anyway. Renaming gains nothing. | test/persist-guard.test.js | Code |
| P11 | Cookie `vicinity_preview_role` | src/admin.js:44 | Renaming only drops an admin's preview choice | None | Code |
| P12 | Notification preference key `election` (not the brand) | src/notify.js:42 | Stored preferences must keep being read after the kind is retired from the UI | test/persist-guard.test.js | Code |
| P13 | Blocked-password entries `vicinity`, `vicinity.city`, `vicinity1`, … | src/common-passwords.js:9542-9550 | Keep them and add citycoin variants. The file goes away when the password code is deleted (00-reconciliation, after the legacy window). | Existing password tests | Code |
| P14 | Historical signed-message digests (`used_nonces`), with no token in code | D1 data | History; cannot change | None | Code |
| P15 | The draft curve's `vicinity_curve` names, leaf tag `vicinity_curve/launch_leaf` and prefix `https://vicinity.city/coin-meta/` (draft `ec148c2`, not counted above) | curve:programs/vicinity-curve/src/constants.rs:205, 217; curve:sdk/curve/constants.mjs:71; curve crate manifest | **Not persistent yet.** The program is not deployed, so these change to Citycoin names and a citycoin.dev versioned prefix before the audit build. They become persistent identifiers once that build is deployed. | D09; curve IDL tests | Code (curve branch) |

### 3.5 Third-party and on-chain names (986 tokens)

| ID | Value (kept) | Consumer | Rule | Test | Owner |
|---|---|---|---|---|---|
| T01 | `$VICINITY` (823 tokens). The legacy token's on-chain metadata (Metaplex PDA `DwmtvKsStZQypwfkJWNwXCtMUL5Bx1kx268PmwzwV8KJ`) reads name "VICINITY CITY", symbol "VICINITY", with a URI on ipfs.io (RPC read, 24 Oct 2026). | Site-wide | **Re-classified by amendment 01 (section 3.8).** `$VICINITY` (mint `2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray`) is a legacy token, history only, never the main token. Where a string names it as the main token, the consumer migrates to the configured main token (`MAIN_TOKEN_MINT`); where it states a `$VICINITY` fact, it stays as history, labeled "Legacy token: $VICINITY". No rename, swap, airdrop or migration of anyone's holdings. | D09 | No change to the token or its holders is authorized (amendment 01; master section 02) |
| T02 | Ticker `VICINITY` (88 tokens) | src/coin.js:33; src/launchpad.js:189; src/official.js:68; src/coinreview.js:133; src/screen-words.js:183 | On-chain symbol of the legacy token. src/coin.js:33 and src/launchpad.js:189 present it as the main coin and migrate with section 3.8; the reserved-ticker and screener entries (src/coinreview.js:133, src/screen-words.js:183) stay, so nobody can launch a look-alike. | D09 | n/a |
| T03 | Former official X handle `@VicinityCitySOL` (75 tokens) | src/official.js:21, 25; scripts/pages/src/terms.html:45, 112, 166, 197; every generated page footer (section 3.8) | **Re-classified by amendment 01:** a legacy social link (`policy.official_links.legacy.x_url`), refused as the new official link. The official X and Telegram links move to central configuration (`OFFICIAL_X_URL`, `OFFICIAL_TELEGRAM_URL`), owner-supplied and verified; empty means not shown. | D01 (residual report lists it); test/masterpolicy.test.js (`LEGACY_SOCIAL_LINK_AS_OFFICIAL`) | Owner (supplies and proves the new accounts) |
| T04 | Provider names with no "vicinity" token: "Raydium LaunchLab" (where `$VICINITY`, now the legacy token, was really launched) and "Meteora" (the legacy city-coin venue) | scripts/pages/src/index.html:102-106; src/official.js:68; public/swap.js:1353-1355; src/fees.js | Keep where they state real history or the legacy path. Remove Meteora from the new launch and trade path only (00-reconciliation LL-5). | B11, V05 | Code |

### 3.6 History (343 tokens)

Kept as written. These files explain real history (master section 03, "History and attribution"):

- solana/release/mainnet-2026-10-10/*
- solana/AUDIT.md
- solana/LAUNCHPAD-AUDIT.md
- solana/LAUNCHPAD-DEVNET.md
- solana/LAUNCHPAD-DESIGN.md (the as-built design of a deployed program)
- solana/NOTES-integration.md
- docs/AUDIT.md
- docs/HARDENING-2026-10-03.md
- solana/scripts/launchpad/devnet-demo-state.json
- migrations/0001_city_claims.sql
- the countdown site copy (countdown/public/index.html, teaser.js, style.css)

Test: the residual report keeps them out of the label count (D01).

### 3.7 Developer-only (666 tokens)

| Item | Tokens | Examples | Action |
|---|---|---|---|
| Code comments (including 6 that name the token symbol) | 333 | across src/, public/, solana/ | Optional. Update comments that describe user-facing behavior when that code changes. |
| Developer and owner docs | 102 | README.md, docs/DEPLOY.md, docs/MAINNET.md, docs/OWNER-LAUNCH-GUIDE.md, docs/RULES-V7-DRAFT.md, docs/COIN-READY.md, docs/COIN-BATCH.md | Add "Citycoin.dev (formerly Vicinity)" and keep history sections. COIN-BATCH.md and RULES-V7-DRAFT.md are removed by 00-reconciliation (CP-3). |
| Internal identifiers, constants and local variable names | 134 | `VICINITY_BRAND`, `VICINITY_PARTNER`, `VICINITY_LAUNCHED`, `vicinityConfigParams`, `VicinityClient` | Optional. SDK exports get Citycoin aliases, and the old exports stay. |
| Comments and docs naming the old domain | 65 | wrangler.jsonc:11, 127-128; src/index.js:689, 694 | Update with the code they describe |
| Internal cache names and headers | 26 | `cache.vicinity.internal` (src/index.js:137; src/chain.js:319), `x-vicinity-max-age` (src/index.js:128), the MIME boundary (src/mail.js:63-66) | Keep. They are internal and not origins. |
| CSS and markup hooks | 6 | class names | Optional |
| **Total** | **666** | | |

### 3.8 Amendment 01 re-classification: the mint and the social links

Owner amendment 01 (24 October 2026) supersedes the "existing main-token mint preserved" rule for the main token only. Every occurrence of the legacy mint and of the old X account at `4aa408e` falls in one of three groups below. The full consumer list with `path:line` is `amendment-01-new-main-token.md` sections 5 and 6; the counts here come from `git grep` at `4aa408e`.

| Group | Old value | New value | Occurrences at 4aa408e | Migration dependency | Test | Owner |
|---|---|---|---|---|---|---|
| **Main-token consumers: migrate to the `MAIN_TOKEN_MINT` configuration** | the legacy mint, through the setting `VICINITY_MINT` (wrangler.jsonc:32) and `activeMint(env)` (src/official.js:267-268) | the owner-supplied, verified `MAIN_TOKEN_MINT`, through one adapter `mainMint(env)`; `null` until supplied, and every dependent feature stays off | 36 `activeMint(` calls in 17 modules under src/ (the function itself is defined at src/official.js:268), plus the official list (src/official.js:35, 66-72, 250-253, 275-283), the generated /official page (public/official.html:136-141), the swap list with its written-in 6 decimals (src/swap.js:360-362), the Buy panel default (public/swap.js:425), the purchase-link templates (src/launchpad.js:49-64; public/token.js:45-48; public/dashboard.js:1608-1612), the balance sampler (src/ledger.js:24-70), the preflight (scripts/mainnet-preflight.mjs:186-240) and the SDK pay-with list (solana/sdk/launchpad/pay-assets.mts:75, 96) | Owner supplies the mint; verification record; `MAIN_TOKEN_V5` | test/masterpolicy.test.js (`MAIN_TOKEN_MINT_MISSING`, `MAIN_TOKEN_MINT_INVALID`, `MAIN_TOKEN_IS_LEGACY_MINT`); since S02A test/main-token-adapters.test.js and test/main-token-consumers.test.js (server consumers moved behind `tokenMint(env)`; the client scripts' and page copy's `$VICINITY` wording follows with S48) | Code; owner (value) |
| **Legacy `$VICINITY` facts: history** | the legacy mint as a fact about `$VICINITY` | unchanged text, labeled "Legacy token: $VICINITY"; never presented as the main token, never with a Buy or swap | the launch time (src/official.js:13-16), the 60M Jupiter Lock of `$VICINITY` (src/official.js:44-64; scripts/pages/src/token.html:140), the team-wallet listings for `$VICINITY` (src/official.js:36-43, 80-87), the Raydium LaunchLab launch story (scripts/pages/src/index.html:100-106; scripts/pages/src/token.html:138), the balance history (`balance_samples`, `day:<d>` blobs, the dormant Founding Supporters snapshot), the research note (src/marketlive.js:4), the as-built design (solana/LAUNCHPAD-DESIGN.md:27), a recorded Jupiter answer (solana/sdk/launchpad/fixtures/jupiter-build-cbBTC-to-VICINITY-max64.json), the docs (README.md:7, 66; docs/DEPLOY.md:29, 180; docs/MAINNET.md:15) and the 18 test files that contain the mint | None (wording only, with the switch) | The residual report keeps them out of the label count | Code |
| **Social links: central configuration** | `@VicinityCitySOL` from `SOCIAL_PROFILES` (src/official.js:21-26), written into every page footer at build time (scripts/pages/build.mjs:91-96, 158-159) | `OFFICIAL_X_URL` and `OFFICIAL_TELEGRAM_URL`, owner-supplied and verified; empty means not shown; the old account is a legacy link and is refused as official | 16 generated page footers (public/404.html, admin, app, cities, coin, connect, credits, dashboard, index, launchpad, locate, official, profile, rules, terms, token); the dashboard help link (scripts/pages/src/dashboard.html:754); the Terms contact clauses (scripts/pages/src/terms.html:45, 112, 166, 197); the link checker (src/official.js:128-135, 161-172, 188-197); the countdown site (countdown/public/index.html, teaser.js: history). No official Telegram link exists on the site; the only Telegram address in the repository is an invite link in the legacy token's third-party LaunchLab listing data recorded in test/fixtures/launchlab/raymint.json, which is never a source for the official links. | Owner supplies and proves the accounts; a new Terms version (L07) | test/masterpolicy.test.js (`OFFICIAL_X_URL_INVALID`, `OFFICIAL_TELEGRAM_URL_INVALID`, `LEGACY_SOCIAL_LINK_AS_OFFICIAL`) | Code; owner (accounts) |

## 4. Runtime configuration inventory (BR-01 "Runtime configuration")

| Item | Value at `4aa408e` | v5 action |
|---|---|---|
| Worker | `vicinity-map` (wrangler.jsonc:7) | Keep (P03) |
| workers.dev and preview URLs | Both off (wrangler.jsonc:13-14) | A preview environment is needed: its own Worker name, its own D1, `preview.citycoin.dev`, `noindex`, no cron (master BR-02, BR-06 step 2) |
| Routes | `vicinity.city`, `www.vicinity.city` (wrangler.jsonc:130-133) | Add citycoin.dev and www (U02). Keep the old ones (C01). |
| Worker-first paths | `/api/*`, `/coin-meta/*`, `/official-coins.csv` (wrangler.jsonc:124) | Pages must reach the redirect logic (U01) |
| D1 | `vicinity-claims` (wrangler.jsonc:139) | Keep (P04) |
| Cron | `*/10 * * * *` (wrangler.jsonc:141), one D1 lease (src/jobs.js:22-37) | Keep one scheduler for both hosts (D10). The hourly sampler needs its own trigger (00-reconciliation RW-5). |
| Observability | On (wrangler.jsonc:142) | Keep. No hand-off codes in URLs (00-reconciliation OB-9). |
| Plain vars that name the brand or host | `EMAIL_FROM` (wrangler.jsonc:26); `VICINITY_MINT` (wrangler.jsonc:32) | `EMAIL_FROM` migrates (U03). `VICINITY_MINT` keeps its name (P06) but holds only the legacy `$VICINITY` mint for history; the main token moves to `MAIN_TOKEN_MINT` (amendment 01, section 3.8). |
| Other plain vars | `SITE_MODE`, `GOOGLE_CLIENT_ID`, `ADMIN_WALLETS`, `SIGNUP_FLOW`, `PROFILES`, `DASHBOARD_V2`, `SWAP`, `JUPITER_RPS`, `LAUNCHPAD_*`, `NOTIFY`, `WALLET_SEND`, `COIN_V2_*`, `FEED_V2` (wrangler.jsonc:24-114) | No brand in the names. `GOOGLE_CLIENT_ID` and `SIGNUP_FLOW` are retired after the legacy window. `COIN_V2_*` are replaced (00-reconciliation 5.5). |
| New vars | none | `SITE_ORIGIN`, `SITE_ORIGINS`, `BRAND`, `HOST_REDIRECT`, `PUBLIC_V5`; and for amendment 01 `MAIN_TOKEN_V5`, `MAIN_TOKEN_MINT`, `OFFICIAL_X_URL`, `OFFICIAL_TELEGRAM_URL` (each unset = today; the three values stay unset until the owner supplies verified values) |
| Names read by the Worker that are not plain vars (set as Cloudflare secrets or dashboard settings; values never in the repository) | `SOLANA_RPC_URL`, `SOLANA_RPC_URL_BACKUP`, `LAUNCHPAD_RPC_URL`, `RESEND_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `GOOGLE_CLIENT_SECRET`, `PASSWORD_PEPPER`, `JUPITER_API_KEY`, `ATTEST_KEY`, `LIMIT_SALT`, `SWAP_PLATFORM_FEE_BPS`, `SWAP_FEE_ACCOUNT`, `SNAPSHOT_CUTOFF`, `CARRY_RELAY` and rate settings | No brand in any name, so none is renamed. `GOOGLE_CLIENT_SECRET` and `PASSWORD_PEPPER` are deleted after the legacy window. The mail secrets go only if mail is retired. The swap fee settings are removed (00-reconciliation FE-2). |
| CI secret | `CLOUDFLARE_API_TOKEN` (.github/workflows/deploy.yml) | The token must cover the citycoin.dev zone before U02 |
| Security headers and CSP | `'self'` only, no host named (public/_headers:2-8; src/http.js:6-8) | No change |
| CORS | `*` on the read-only metadata and coin list, no credentials (src/coinmeta.js:120; src/officialcoins.js:72) | No change |
| CSRF and cookies | Origin host must equal request host (src/http.js:74-78); host-only `Secure; HttpOnly; SameSite=Lax` cookies (src/http.js:65-66) | Works per host. The session host binding is 00-reconciliation OB-8. |
| DNS (DNS over HTTPS lookup, 24 Oct 2026) | citycoin.dev: NS `pearl.ns.cloudflare.com`, `tim.ns.cloudflare.com`; no A record. www.citycoin.dev: does not exist. vicinity.city: the same NS pair. | Create only the Worker custom-domain records, plus provider-issued mail records if mail is kept. Leave vicinity.city DNS untouched (master section 04). |

## 5. Integration owners

| Integration | What changes | Owner of the action | Status |
|---|---|---|---|
| Cloudflare zone and Worker routes for citycoin.dev; the preview Worker and D1; zone Redirect Rules (if chosen) | U01, U02, preview environment | Cloudflare account holder | Not done. citycoin.dev has no web records (section 4). |
| Mail provider sending domain | U03, U04 | Mail provider account holder | Not done. citycoin.dev has no mail records. |
| Google OAuth client | U12 (only if Google linking runs on the new host during the legacy window), then deletion of the client and secrets | Google Cloud console holder | Not done |
| Domain registrations `vicinity.city`, `vicinitycity.com`, `vicinitycity.net` | Renewal for at least 12 months after cutover (C01) | Owner (registrar access) | Registrar and expiry not verified |
| Official X and Telegram accounts | Amendment 01: the owner supplies the new official X and Telegram addresses and proves them (amendment-01-new-main-token.md section 4.2); `@VicinityCitySOL` becomes a legacy link (T03) | Owner | Not supplied yet |
| New main-token mint | Amendment 01: the owner supplies the mint; it is verified read-only on chain before `MAIN_TOKEN_MINT` is set (amendment-01-new-main-token.md section 4.1) | Owner | Not supplied yet |
| Meteora DBC partner metadata (on chain) | Would need the fee-claimer wallet's signature. Without an update, C04 stays permanent. | Fee-claimer wallet holder (`13qRam…`) | Update support not verified |
| Consumers of `/official-coins.csv` (token-tag lists) | Keep serving on both hosts (C09) | Code | Whether any tracker registered the URL was not verified |
| Repository, CI and page build | L01-L17, U04-U10, U13-U14, C02-C10, P-rows guard test | Code (lead commits) | Not done |
| Draft custom program names and prefix | P15 | Code (curve branch), before the outside audit freeze | Not done |

## 6. Tests

| Test | Asserts | Master ID |
|---|---|---|
| test/brand-residual.test.js (with `scripts/brand/residual.mjs`; report mode since S02) | S02: the report exits 0, its class counts add up, and the rules place the examples of section 3 in their classes. S48: with `BRAND=citycoin`, no label-class "Vicinity" remains outside the allowlist of sections 3.3-3.6. The report lists every remaining token with its class. | D01 |
| test/build-parity.test.js (S02) | With `BRAND` unset, the built pages are byte-identical to the committed `public/` files, and every product name the layout writes comes from `src/brand.js` (a fake label set moves exactly those positions) | D01 (no premature change) |
| test/masterpolicy.test.js (amendment 01 tests, exist) | The legacy mint and the old X link appear in the policy only as legacy facts; `MAIN_TOKEN_MINT`, `OFFICIAL_X_URL` and `OFFICIAL_TELEGRAM_URL` are validated with named errors; since S02A only `src/maintoken.js` imports the policy module | D09 |
| test/main-token-adapters.test.js and test/main-token-consumers.test.js (S02A) | `MAIN_TOKEN_V5` follows the flag rule; `mainMint` never reads `VICINITY_MINT` or answers a legacy mint; `tokenMint` equals `activeMint` with the switch off; the footer's links come from one function for the page build and the Worker's response-time rewrite (identity with the switch off, configured links on, an unset link removed, the legacy account never official); with a clearly fake test mint no `$VICINITY` fact is attributed to the new token, and the job's steps read it | D09 |
| test/persist-guard.test.js (S02) | Every P-row value is unchanged: program IDs, the live `METADATA_URI_PREFIX`, `vicinity` API and D1 values, hash domains, storage keys, the `election` key, the rewards city tag. The hash of `public/brand/vicinity-512.png` is unchanged. | D09 |
| New: legacy metadata byte test | A stored `meta_json` and art served under `/coin-meta` hash the same under every `BRAND` value | D03 |
| New: test/host-redirect.test.js | 308 for GET and HEAD pages with the path kept and hand-off parameters dropped; 421 with no Location for other methods; excluded paths served in place on the old host; no open redirect; no loop | D03, D05 |
| D07 checks | Canonical, `og:url`, `og:image`, Twitter card, sitemap, manifest, icons and start URL use `SITE_ORIGIN` and `BRAND`; preview is `noindex` | D07 |
| D06 checks | CSP, CORS and CSRF unchanged; mail links and user agents come from configuration | D06 |
| Screenshots | Header, footer, wallet prompt, favicon, error pages and mail on desktop and mobile | V06 |

## 7. Order and dependencies

1. `src/brand.js` and `src/site-config.js` as adapters that reproduce today's bytes when unset, plus the amendment 01 adapters `mainMint(env)` and `officialLinks(env)` (implementation-report.md stage S02A). `mainMint(env)` reads only `MAIN_TOKEN_MINT` and returns `null` while it is unset, never the legacy mint; while `MAIN_TOKEN_V5` is off, the live site keeps today's behavior through its existing code paths; the guard and residual tests; this file. Nothing visible changes. (S02 and S02A are on the local branch `cc/s02`: the adapters live in `src/maintoken.js`, the switch-aware `tokenMint(env)`, `teamFor(env, mint)` and `socialProfiles(env)` in `src/official.js`, and the footer's links in `src/footer-social.js`; see amendment-01-new-main-token.md section 11.)
2. Redirect fix for the same zone: method-aware, pages through the Worker, http to https. This is the only step that changes live behavior before a switch moves. It fixes the current www and POST behavior described in U01, so review it on its own.
3. Freeze the legacy brand by program ID (C06) and pin `/brand/vicinity-512.png` (C04).
4. Rename the draft curve (P15) before the outside audit freeze.
5. Search, share and install consumers (U13), then the label migration (L01-L17) under `BRAND=citycoin`. Wallet statements move with the challenge service (L16). The token and social-link migration of section 3.8 goes on with `MAIN_TOKEN_V5`, only after the owner's values are verified.
6. Add the citycoin.dev routes (U02, Cloudflare access). Deploy on both hosts with `HOST_REDIRECT` off.
7. Switch the integrations: sender after verification (U03), check base (U10), official list (C03), countdown target (U11).
8. `HOST_REDIRECT=on`. Hash the excluded paths before and after; they must match.
9. After the windows: retire the old statements (C08) and the Google callback (U12). Keep C01-C05 and C09 for their stated periods.

## 8. Not verified

- Whether Meteora DBC offers an instruction to update partner metadata (C04).
- The registrar and expiry dates of vicinity.city, vicinitycity.com and vicinitycity.net.
- Whether the citycoin.dev zone is in the same Cloudflare account as the Worker. Both domains use the same nameserver pair, which suggests it but does not prove it.
- Whether any tracker registered `https://vicinity.city/official-coins.csv`.
- The classifier is rule-based (section 1). A few tokens at class boundaries may be misclassified.

## 9. Commands run for this file (24 October 2026)

- `git grep -I -n -i vicinity 4aa408e | wc -l` (3,848 lines), `git grep -I -l -i vicinity 4aa408e | wc -l` (431 files), `git grep -l -i vicinity 4aa408e | wc -l` (433 files), `git grep -I -h -o -i vicinity 4aa408e | wc -l` (4,606 raw occurrences).
- The classifier run on `4aa408e` (4,593 rows; identical to the earlier run), then a re-split into the classes of section 1 with the compatibility rules of section 3.3.
- `sed -n` line checks of every `path:line` cited in sections 3 and 4 that was not already checked for 00-reconciliation.md.
- One read-only RPC call: `getMultipleAccounts` (finalized, slot 460702743) on the `$VICINITY` (legacy token) Metaplex metadata PDA and the Meteora DBC partner-metadata PDA.
- DNS over HTTPS lookups at cloudflare-dns.com: citycoin.dev NS and A, www.citycoin.dev A, vicinity.city NS.
- No transaction, keypair, database read or signed request.

## Appendix A. Per-file counts (all 433 files)

Columns: total tokens, then migrate, compatibility-required, persistent identifier, third-party, history and developer-only. Rows are grouped by area, largest first within each area. `public/*.html` files are generated by scripts/pages/build.mjs from scripts/pages/src; fix the source, not the output.

| File | Total | Migrate | Compat. | Persistent | Third-party | History | Dev-only |
|---|---|---|---|---|---|---|---|
| countdown/public/index.html | 20 |  |  | 3 |  | 17 |  |
| countdown/public/teaser.js | 17 | 1 |  | 4 |  | 12 |  |
| countdown/wrangler.jsonc | 7 | 1 |  | 6 |  |  |  |
| countdown/src/index.js | 5 | 2 |  | 3 |  |  |  |
| countdown/public/style.css | 2 |  |  | 1 |  | 1 |  |
| docs/OWNER-LAUNCH-GUIDE.md | 45 |  |  | 6 | 1 |  | 38 |
| docs/MAINNET.md | 40 |  | 6 | 3 | 21 |  | 10 |
| README.md | 31 |  |  | 4 | 17 |  | 10 |
| docs/DEPLOY.md | 29 |  |  | 5 | 9 |  | 15 |
| docs/AUDIT.md | 17 |  |  |  |  | 17 |  |
| docs/RULES-V7-DRAFT.md | 9 |  |  |  |  |  | 9 |
| docs/COIN-READY.md | 5 |  |  |  | 1 |  | 4 |
| docs/COIN-BATCH.md | 3 |  |  |  |  |  | 3 |
| docs/HARDENING-2026-10-03.md | 3 |  |  |  |  | 3 |  |
| public/dashboard.js | 69 | 25 |  | 5 | 30 |  | 9 |
| public/coin.js | 62 | 25 |  | 9 | 12 |  | 16 |
| public/launchpad.js | 56 | 10 |  | 17 | 18 |  | 11 |
| public/dashboard-v2.js | 40 | 16 |  | 2 | 17 |  | 5 |
| public/signup.js | 28 | 21 |  | 4 | 1 |  | 2 |
| public/swap.js | 28 | 11 |  | 8 | 6 |  | 3 |
| public/cities.js | 25 | 4 |  | 7 | 9 |  | 5 |
| public/coin-review.js | 22 | 14 |  | 5 |  |  | 3 |
| public/token.js | 22 | 2 |  | 1 | 18 |  | 1 |
| public/home.js | 20 | 5 |  |  | 14 |  | 1 |
| public/profile.js | 20 | 5 |  | 3 | 12 |  |  |
| public/dashboard-roles.js | 16 | 3 |  |  | 12 |  | 1 |
| public/admin.js | 15 | 10 |  |  | 5 |  |  |
| public/site.js | 13 |  |  | 12 |  |  | 1 |
| public/admin-lp.js | 12 | 9 |  | 2 |  |  | 1 |
| public/coin-ready.js | 12 | 10 |  |  |  |  | 2 |
| public/wallet-send.js | 10 | 6 |  |  | 3 |  | 1 |
| public/connect.js | 8 | 5 |  | 2 |  |  | 1 |
| public/pages-launchpad.css | 8 |  |  | 3 | 5 |  |  |
| public/style.css | 7 | 1 |  |  | 3 |  | 3 |
| public/lp-launch.js | 6 | 5 |  |  |  |  | 1 |
| public/pages-coin.css | 6 |  |  | 4 | 1 |  | 1 |
| public/theme.js | 5 |  |  | 4 |  |  | 1 |
| public/coinchart.js | 4 | 1 |  |  |  |  | 3 |
| public/feedback.js | 3 | 1 |  |  | 1 |  | 1 |
| public/ticker.js | 3 | 1 |  |  |  |  | 2 |
| public/pages-app.css | 2 |  |  |  |  |  | 2 |
| public/polish-dash.css | 2 | 1 |  |  |  |  | 1 |
| public/polish.css | 2 |  |  |  | 1 |  | 1 |
| public/rules.js | 2 |  |  | 1 | 1 |  |  |
| public/app-phone.css | 1 |  |  |  |  |  | 1 |
| public/data/bounds-overview.txt | 1 |  |  |  |  |  | 1 |
| public/favicon.svg | 1 | 1 |  |  |  |  |  |
| public/locate.js | 1 | 1 |  |  |  |  |  |
| public/logo.svg | 1 | 1 |  |  |  |  |  |
| public/pages-home.css | 1 |  |  |  | 1 |  |  |
| public/pages-profile.css | 1 |  |  |  |  |  | 1 |
| public/polish-map.css | 1 |  |  |  | 1 |  |  |
| public/swap.css | 1 |  |  |  | 1 |  |  |
| public/dashboard.html | 60 | 33 |  |  | 25 |  | 2 |
| public/terms.html | 58 | 52 |  |  | 6 |  |  |
| public/index.html | 34 | 17 |  |  | 17 |  |  |
| public/token.html | 30 | 12 |  |  | 18 |  |  |
| public/official.html | 25 | 14 |  | 2 | 9 |  |  |
| public/connect.html | 24 | 21 |  |  | 3 |  |  |
| public/app.html | 22 | 12 |  |  | 10 |  |  |
| public/rules.html | 19 | 14 |  | 1 | 4 |  |  |
| public/coin.html | 18 | 13 |  |  | 2 |  | 3 |
| public/launchpad.html | 17 | 14 |  |  | 3 |  |  |
| public/credits.html | 16 | 14 |  |  | 2 |  |  |
| public/profile.html | 16 | 12 |  |  | 4 |  |  |
| public/404.html | 14 | 12 |  |  | 2 |  |  |
| public/locate.html | 13 | 11 |  |  | 2 |  |  |
| public/admin.html | 12 | 10 |  |  | 2 |  |  |
| public/cities.html | 12 | 9 |  |  | 3 |  |  |
| wrangler.jsonc | 18 | 2 | 2 | 3 | 2 |  | 9 |
| .github/workflows/solana.yml | 9 |  |  | 9 |  |  |  |
| .github/workflows/deploy-countdown.yml | 8 | 5 |  | 2 |  |  | 1 |
| package-lock.json | 2 |  |  | 2 |  |  |  |
| .github/workflows/deploy.yml | 1 |  |  |  |  |  | 1 |
| migrations/0001_city_claims.sql | 1 |  |  |  |  | 1 |  |
| package.json | 1 |  |  | 1 |  |  |  |
| scripts/mainnet-preflight.mjs | 35 | 5 | 3 | 7 | 18 |  | 2 |
| scripts/brand-png.mjs | 4 |  | 3 |  |  |  | 1 |
| scripts/cities/tickers.mjs | 3 | 2 |  | 1 |  |  |  |
| scripts/boundaries/1-links.mjs | 2 | 2 |  |  |  |  |  |
| scripts/boundaries/1b-located-in.mjs | 2 | 2 |  |  |  |  |  |
| scripts/boundaries/2-shapes.mjs | 2 | 2 |  |  |  |  |  |
| scripts/boundaries/overview.mjs | 2 | 1 |  |  |  |  | 1 |
| scripts/check-live.mjs | 2 | 1 |  |  |  |  | 1 |
| scripts/screen/build-vocab.mjs | 2 |  |  |  |  |  | 2 |
| scripts/coin-art/fonts.mjs | 1 | 1 |  |  |  |  |  |
| scripts/pages/src/dashboard.html | 49 | 23 |  |  | 23 |  | 3 |
| scripts/pages/src/terms.html | 47 | 42 |  |  | 4 |  | 1 |
| scripts/pages/src/index.html | 22 | 7 |  |  | 14 |  | 1 |
| scripts/pages/src/token.html | 18 | 4 |  |  | 14 |  |  |
| scripts/pages/src/connect.html | 13 | 11 |  |  | 1 |  | 1 |
| scripts/pages/src/app.html | 10 | 2 |  |  | 7 |  | 1 |
| scripts/pages/build.mjs | 9 | 8 |  |  |  |  | 1 |
| scripts/pages/src/rules.html | 8 | 4 |  | 1 | 2 |  | 1 |
| scripts/pages/src/coin.html | 7 | 3 |  |  |  |  | 4 |
| scripts/pages/src/launchpad.html | 7 | 6 |  |  | 1 |  |  |
| scripts/pages/src/credits.html | 5 | 4 |  |  |  |  | 1 |
| scripts/pages/src/profile.html | 5 | 2 |  |  | 2 |  | 1 |
| scripts/pages/src/404.html | 3 | 2 |  |  |  |  | 1 |
| scripts/pages/src/official.html | 3 | 1 |  |  | 1 |  | 1 |
| scripts/pages/src/cities.html | 2 | 1 |  |  | 1 |  |  |
| scripts/pages/src/locate.html | 2 | 1 |  |  |  |  | 1 |
| scripts/pages/src/admin.html | 1 |  |  |  |  |  | 1 |
| solana/sdk/launchpad/metadata.mts | 34 |  | 7 | 3 |  |  | 24 |
| solana/sdk/launchpad/jupiter.test.mts | 30 | 6 |  | 9 | 4 |  | 11 |
| solana/sdk/launchpad/metadata.test.mts | 29 | 18 | 2 | 4 |  |  | 5 |
| solana/scripts/launchpad/build-mainnet.sh | 24 | 2 |  | 21 |  |  | 1 |
| solana/tests-launchpad/17-admin-builders.test.mjs | 18 | 9 | 1 | 5 |  |  | 3 |
| solana/scripts/launchpad/devnet-demo.mjs | 12 | 2 |  | 3 | 1 |  | 6 |
| solana/sdk/client.ts | 9 | 1 |  | 5 |  |  | 3 |
| solana/scripts/launchpad/devnet-demo-state.json | 8 |  |  |  |  | 8 |  |
| solana/scripts/launchpad/worker-config-bytes.mjs | 8 |  |  |  |  |  | 8 |
| solana/sdk/launchpad/accounts.mts | 8 |  |  | 3 |  |  | 5 |
| solana/sdk/launchpad/config.mjs | 8 | 1 |  | 1 |  |  | 6 |
| solana/sdk/launchpad/keeper.mjs | 8 | 1 |  | 3 |  |  | 4 |
| solana/sdk/launchpad/pay-assets.mts | 8 | 2 |  | 4 | 2 |  |  |
| solana/tests-launchpad/19-wallet-send.test.mjs | 8 | 4 |  |  | 4 |  |  |
| solana/tests-launchpad/helpers.mjs | 8 |  |  | 6 |  |  | 2 |
| solana/sdk/launchpad/snapshot.mjs | 7 | 3 |  | 3 |  |  | 1 |
| solana/tests-launchpad/03-launch.test.mjs | 7 | 5 |  | 2 |  |  |  |
| solana/scripts/launchpad/deploy-devnet.sh | 6 |  |  | 6 |  |  |  |
| solana/scripts/launchpad/setup.mjs | 6 |  |  | 2 | 1 |  | 3 |
| solana/sdk/launchpad/idl.mjs | 6 |  |  | 6 |  |  |  |
| solana/Anchor.toml | 5 |  |  | 5 |  |  |  |
| solana/sdk/launchpad/config.test.mjs | 5 | 1 |  |  |  |  | 4 |
| solana/sdk/launchpad/jupiter.live.test.mts | 5 |  |  |  |  |  | 5 |
| solana/tests-launchpad/02-configs.test.mjs | 5 | 1 |  |  |  |  | 4 |
| solana/package.json | 4 | 1 |  | 3 |  |  |  |
| solana/sdk/launchpad/client.mjs | 4 |  |  | 2 |  |  | 2 |
| solana/sdk/launchpad/index.mts | 4 |  |  | 1 |  |  | 3 |
| solana/sdk/launchpad/quote.mts | 4 | 1 |  | 1 |  |  | 2 |
| solana/sdk/launchpad/rewards.mts | 4 |  |  | 4 |  |  |  |
| solana/sdk/launchpad/trade.mts | 4 |  |  |  |  |  | 4 |
| solana/Cargo.toml | 3 |  |  | 3 |  |  |  |
| solana/scripts/launchpad/crank.mjs | 3 |  |  | 1 |  |  | 2 |
| solana/scripts/launchpad/idl-offsets.mjs | 3 |  |  | 2 |  |  | 1 |
| solana/sdk/fixtures/generate.mjs | 3 | 2 |  | 1 |  |  |  |
| solana/sdk/gen-fixtures.mjs | 3 | 1 |  | 1 |  |  | 1 |
| solana/tests-launchpad/04-trading.test.mjs | 3 |  |  |  |  |  | 3 |
| solana/tests-launchpad/16-coin-meta.test.mjs | 3 | 2 | 1 |  |  |  |  |
| solana/tests-launchpad/18-launch-builders.test.mjs | 3 | 1 |  |  |  |  | 2 |
| solana/tests-launchpad/22-batch-approvals.test.mjs | 3 | 1 |  | 1 |  |  | 1 |
| solana/tests/01-init-lock-authority.ts | 3 | 2 |  | 1 |  |  |  |
| solana/tests/04-sweep-cancel-deadline.ts | 3 |  |  | 3 |  |  |  |
| solana/.gitignore | 2 |  |  | 2 |  |  |  |
| solana/Cargo.lock | 2 |  |  | 2 |  |  |  |
| solana/package-lock.json | 2 |  |  | 2 |  |  |  |
| solana/scripts/init-registry.ts | 2 |  |  |  |  |  | 2 |
| solana/sdk/launchpad/curve.test.mjs | 2 |  |  |  |  |  | 2 |
| solana/sdk/launchpad/jupiter.mts | 2 |  |  |  | 1 |  | 1 |
| solana/sdk/launchpad/lookup-table.mts | 2 |  |  |  |  |  | 2 |
| solana/sdk/launchpad/payout.mts | 2 |  |  |  |  |  | 2 |
| solana/sdk/launchpad/quote.test.mts | 2 |  |  |  |  |  | 2 |
| solana/sdk/merkle.mjs | 2 |  |  | 1 |  |  | 1 |
| solana/tests-launchpad/12-client-sdk.test.mjs | 2 | 2 |  |  |  |  |  |
| solana/tests-launchpad/14-devnet-accounts.test.mjs | 2 | 1 |  |  |  |  | 1 |
| solana/tests-launchpad/15-worker-builder.test.mjs | 2 | 1 |  |  |  |  | 1 |
| solana/tests/helpers.ts | 2 |  |  |  |  |  | 2 |
| solana/scripts/launchpad/claim-platform-fees.mjs | 1 |  |  |  |  |  | 1 |
| solana/scripts/launchpad/snapshot.mjs | 1 |  |  | 1 |  |  |  |
| solana/scripts/launchpad/worker-devnet-trade.mjs | 1 | 1 |  |  |  |  |  |
| solana/sdk/fixtures/merkle-js.json | 1 |  |  | 1 |  |  |  |
| solana/sdk/fixtures/merkle.json | 1 |  |  | 1 |  |  |  |
| solana/sdk/launchpad/curve.mjs | 1 |  |  |  |  |  | 1 |
| solana/sdk/launchpad/pda.mjs | 1 |  |  | 1 |  |  |  |
| solana/sdk/launchpad/platform-fees.mts | 1 |  |  |  |  |  | 1 |
| solana/sdk/launchpad/rewards.test.mts | 1 | 1 |  |  |  |  |  |
| solana/sdk/pda.mjs | 1 |  |  | 1 |  |  |  |
| solana/tests-launchpad/01-admin.test.mjs | 1 |  |  | 1 |  |  |  |
| solana/tests-launchpad/05-fees-rewards.test.mjs | 1 |  |  | 1 |  |  |  |
| solana/tests-launchpad/11-holders-pot.test.mjs | 1 |  |  | 1 |  |  |  |
| solana/tests-launchpad/13-rewards-payout-tools.test.mjs | 1 |  |  |  |  |  | 1 |
| solana/tests-launchpad/20-legacy-config.test.mjs | 1 |  |  |  |  |  | 1 |
| solana/programs/vicinity-launchpad/src/validate.rs | 10 |  |  | 10 |  |  |  |
| solana/sdk/idl/vicinity_launchpad.json | 9 |  |  | 9 |  |  |  |
| solana/programs/vicinity-launchpad/src/math.rs | 7 |  |  | 7 |  |  |  |
| solana/release/mainnet-2026-10-10/BUILD.md | 7 |  |  |  |  | 7 |  |
| solana/programs/vicinity-launchpad/src/lib.rs | 6 |  |  | 6 |  |  |  |
| solana/programs/vicinity-launchpad/src/constants.rs | 5 |  |  | 5 |  |  |  |
| solana/programs/vicinity-launchpad/Cargo.toml | 4 |  |  | 4 |  |  |  |
| solana/sdk/idl/vicinity_rewards.json | 4 |  |  | 4 |  |  |  |
| solana/programs/vicinity-launchpad/src/instructions/add_launch_config.rs | 3 |  |  | 3 |  |  |  |
| solana/programs/vicinity-rewards/Cargo.toml | 3 |  |  | 3 |  |  |  |
| solana/programs/vicinity-launchpad/src/instructions/forward_holders_fees.rs | 2 |  |  | 2 |  |  |  |
| solana/programs/vicinity-launchpad/src/instructions/launch.rs | 2 |  |  | 2 |  |  |  |
| solana/programs/vicinity-rewards/src/instructions/init_registry.rs | 2 |  |  | 2 |  |  |  |
| solana/programs/vicinity-rewards/src/lib.rs | 2 |  |  | 2 |  |  |  |
| solana/release/mainnet-2026-10-10/SHA256SUMS | 2 |  |  |  |  | 2 |  |
| solana/programs/vicinity-launchpad/src/instructions/init_launchpad.rs | 1 |  |  | 1 |  |  |  |
| solana/programs/vicinity-launchpad/src/instructions/opt_in_payout.rs | 1 |  |  | 1 |  |  |  |
| solana/programs/vicinity-launchpad/src/instructions/payout_founder_fees.rs | 1 |  |  | 1 |  |  |  |
| solana/programs/vicinity-launchpad/src/state.rs | 1 |  |  | 1 |  |  |  |
| solana/programs/vicinity-rewards/src/instructions/init_city.rs | 1 |  |  | 1 |  |  |  |
| solana/programs/vicinity-rewards/src/instructions/lock_config.rs | 1 |  |  | 1 |  |  |  |
| solana/programs/vicinity-rewards/src/instructions/set_founder.rs | 1 |  |  | 1 |  |  |  |
| solana/programs/vicinity-rewards/src/state.rs | 1 |  |  | 1 |  |  |  |
| solana/release/mainnet-2026-10-10/vicinity_launchpad.so | 1 |  |  | 1 |  |  |  |
| solana/release/mainnet-2026-10-10/vicinity_rewards.so | 1 |  |  | 1 |  |  |  |
| solana/LAUNCHPAD-DESIGN.md | 178 |  |  |  |  | 178 |  |
| solana/LAUNCHPAD.md | 56 |  | 3 | 10 | 6 |  | 37 |
| solana/LAUNCHPAD-DEVNET.md | 34 |  |  |  |  | 34 |  |
| solana/LAUNCHPAD-AUDIT.md | 31 |  |  |  |  | 31 |  |
| solana/AUDIT.md | 24 |  |  |  |  | 24 |  |
| solana/README.md | 18 |  |  | 12 |  |  | 6 |
| solana/NOTES-integration.md | 8 |  |  |  |  | 8 |  |
| solana/scripts/README-scripts.md | 6 |  |  | 5 |  |  | 1 |
| solana/tests-launchpad/README.md | 5 |  |  | 3 |  |  | 2 |
| solana/SECURITY.md | 4 |  |  | 1 |  |  | 3 |
| solana/tests/README-tests.md | 4 |  |  | 3 |  |  | 1 |
| solana/sdk/README.md | 3 |  |  | 2 |  |  | 1 |
| solana/sdk/fixtures/README.md | 1 |  |  | 1 |  |  |  |
| src/official.js | 61 | 14 | 3 | 13 | 20 |  | 11 |
| src/coinreview.js | 41 | 17 |  | 9 | 1 |  | 14 |
| src/cointakedown.js | 39 | 26 |  |  |  |  | 13 |
| src/mail.js | 37 | 32 |  |  |  |  | 5 |
| src/lpadmin.js | 34 | 13 |  | 6 | 5 |  | 10 |
| src/fees.js | 26 | 17 |  | 3 |  |  | 6 |
| src/coins.js | 25 | 7 |  | 3 | 3 |  | 12 |
| src/sol/lpadmin-ix.js | 22 |  | 3 | 12 |  |  | 7 |
| src/coinmeta.js | 20 |  | 7 | 1 |  |  | 12 |
| src/screen.js | 19 | 8 |  | 1 |  |  | 10 |
| src/index.js | 18 | 3 | 3 | 2 | 3 |  | 7 |
| src/launchpad.js | 15 | 1 |  | 4 | 7 |  | 3 |
| src/lplaunch.js | 15 | 11 |  |  |  |  | 4 |
| src/solana.js | 11 |  | 11 |  |  |  |  |
| src/lpcoins.js | 10 | 9 |  | 1 |  |  |  |
| src/pricehistory.js | 10 | 7 |  |  | 3 |  |  |
| src/coinart-store.js | 9 | 1 |  | 2 |  |  | 6 |
| src/common-passwords.js | 9 |  |  | 9 |  |  |  |
| src/me.js | 9 | 1 |  | 2 | 5 |  | 1 |
| src/walletsend.js | 9 | 2 |  | 1 | 6 |  |  |
| src/lpbatch.js | 8 | 5 |  | 1 |  |  | 2 |
| src/portfolio.js | 8 | 1 |  | 1 | 4 |  | 2 |
| src/screen-words.js | 8 |  |  |  | 1 |  | 7 |
| src/coin.js | 7 | 3 |  | 2 | 2 |  |  |
| src/coinready.js | 7 | 3 |  |  |  |  | 4 |
| src/chain.js | 6 |  |  |  | 4 |  | 2 |
| src/flags.js | 6 |  |  |  | 1 |  | 5 |
| src/swap.js | 6 | 3 |  | 1 | 2 |  |  |
| src/coindefaults.js | 5 | 3 |  |  |  |  | 2 |
| src/admin.js | 4 |  |  | 3 | 1 |  |  |
| src/lpkit.js | 4 | 4 |  |  |  |  |  |
| src/marketlive.js | 4 | 3 |  |  | 1 |  |  |
| src/policy.js | 4 | 2 |  |  | 1 |  | 1 |
| src/profile-core.js | 4 |  |  |  |  |  | 4 |
| src/snapshot.js | 4 |  |  |  | 1 |  | 3 |
| src/store.js | 4 |  |  |  | 1 |  | 3 |
| src/auth.js | 3 |  |  | 1 |  |  | 2 |
| src/coinart.js | 3 | 2 |  |  |  |  | 1 |
| src/feestatus.js | 3 |  |  | 3 |  |  |  |
| src/officialcoins.js | 3 | 1 |  | 2 |  |  |  |
| src/sol/layout.js | 3 |  |  | 3 |  |  |  |
| src/walletlink.js | 3 |  |  |  |  |  | 3 |
| src/cluster.js | 2 |  |  | 1 | 1 |  |  |
| src/market.js | 2 |  |  |  | 2 |  |  |
| src/profiles.js | 2 |  |  |  | 1 |  | 1 |
| src/screen-vocab.js | 2 |  |  | 1 |  |  | 1 |
| src/social.js | 2 |  |  |  |  |  | 2 |
| src/sol/dbc-config-data.js | 2 |  |  |  |  |  | 2 |
| src/sol/lplaunch-ix.js | 2 |  |  | 2 |  |  |  |
| src/sources.js | 2 | 2 |  |  |  |  |  |
| src/elections.js | 1 |  |  | 1 |  |  |  |
| src/launchlab.js | 1 |  |  |  | 1 |  |  |
| src/logins.js | 1 |  |  |  |  |  | 1 |
| src/logos.js | 1 |  |  |  |  |  | 1 |
| src/notify.js | 1 |  |  |  |  |  | 1 |
| src/roles.js | 1 |  |  |  | 1 |  |  |
| src/seats.js | 1 |  |  | 1 |  |  |  |
| src/sol/ix.js | 1 |  |  |  |  |  | 1 |
| src/sol/pda.js | 1 |  |  | 1 |  |  |  |
| test/launchpad-ui.test.js | 76 | 21 |  | 16 | 36 |  | 3 |
| test/launchpad.test.js | 67 | 41 |  | 15 | 9 |  | 2 |
| test/fees.test.js | 50 | 35 |  | 4 |  |  | 11 |
| test/wallet-send.test.js | 47 | 18 |  | 4 | 25 |  |  |
| test/fees-ui.test.js | 42 | 27 |  | 7 | 3 |  | 5 |
| test/swap-links.test.js | 41 | 27 |  | 8 | 6 |  |  |
| test/wallet-tab.test.js | 40 | 13 |  | 4 | 23 |  |  |
| test/coin-ready-recheck-ui.test.js | 39 | 28 |  | 8 |  |  | 3 |
| test/connect-carry.test.js | 35 | 21 |  | 14 |  |  |  |
| test/swap-ui.test.js | 35 | 10 |  | 1 | 24 |  |  |
| test/api.test.js | 34 | 24 |  | 9 | 1 |  |  |
| test/coin-takedown.test.js | 33 | 24 | 2 | 1 |  |  | 6 |
| test/coin-api.test.js | 31 | 10 |  | 14 | 5 |  | 2 |
| test/token-ui.test.js | 30 | 4 |  |  | 26 |  |  |
| test/home-v4.test.js | 29 | 7 |  |  | 22 |  |  |
| test/dashboard-inwallet.test.js | 28 | 9 |  | 16 | 1 |  | 2 |
| test/lp-launch-ui.test.js | 28 | 24 |  | 2 |  |  | 2 |
| test/portfolio.test.js | 28 | 2 |  | 8 | 18 |  |  |
| test/site.test.js | 28 | 12 |  | 7 | 8 |  | 1 |
| test/swap-inwallet.test.js | 27 | 9 |  | 2 | 15 |  | 1 |
| test/coin-ready-recheck.test.js | 26 | 3 | 5 | 15 |  |  | 3 |
| test/official-socials.test.js | 24 | 2 |  |  | 22 |  |  |
| test/swap-ready.test.js | 24 | 4 |  | 1 | 19 |  |  |
| test/preflight.test.js | 23 | 2 |  | 8 | 13 |  |  |
| test/profiles-ui.test.js | 23 | 2 |  | 6 | 15 |  |  |
| test/coinmeta.test.js | 22 | 15 | 6 | 1 |  |  |  |
| test/mainnet-preflight-setup.test.js | 22 | 8 | 4 | 9 | 1 |  |  |
| test/connect-inwallet.test.js | 21 | 5 |  | 16 |  |  |  |
| test/official-coins.test.js | 20 | 4 | 1 | 3 | 10 |  | 2 |
| test/coin-review-ui.test.js | 19 | 14 |  | 5 |  |  |  |
| test/coin-ui.test.js | 19 | 12 |  | 2 | 5 |  |  |
| test/team-lock.test.js | 18 | 1 |  | 3 | 12 |  | 2 |
| test/token-tabs.test.js | 18 |  |  | 1 | 17 |  |  |
| test/admin-ui.test.js | 17 | 3 |  | 2 | 12 |  |  |
| test/countdown.test.js | 17 | 16 |  | 1 |  |  |  |
| test/coin-ready-launch.test.js | 16 | 4 | 10 | 1 |  |  | 1 |
| test/mobile-polish.test.js | 15 | 7 |  | 1 | 7 |  |  |
| test/coin-review.test.js | 14 | 8 | 1 |  | 1 |  | 4 |
| test/dashboard-wallet-card.test.js | 13 | 4 |  | 4 | 5 |  |  |
| test/design-pages.test.js | 13 | 6 |  | 6 | 1 |  |  |
| test/lpadmin.test.js | 13 | 10 |  | 1 | 2 |  |  |
| test/dashboard-design.test.js | 12 | 2 |  | 1 | 9 |  |  |
| test/honest-claims.test.js | 12 | 3 |  |  | 9 |  |  |
| test/lp-approve-design.test.js | 12 | 10 | 1 | 1 |  |  |  |
| test/connect-pairing.test.js | 11 | 8 |  | 3 |  |  |  |
| test/fee-status.test.js | 11 | 2 |  | 6 | 3 |  |  |
| test/live-buttons.test.js | 11 | 2 |  | 7 | 1 |  | 1 |
| test/lpadmin-ui.test.js | 11 | 9 |  | 2 |  |  |  |
| test/lpcoins.test.js | 11 | 8 |  | 3 |  |  |  |
| test/screen.test.js | 11 | 5 |  |  | 1 |  | 5 |
| test/admin-coin-reviews-ui.test.js | 10 | 10 |  |  |  |  |  |
| test/coin-ready-ui.test.js | 10 | 10 |  |  |  |  |  |
| test/lplaunch.test.js | 10 | 7 |  | 2 | 1 |  |  |
| test/ticker-lock.test.js | 10 | 4 |  | 6 |  |  |  |
| test/chain.test.js | 9 | 2 |  | 6 | 1 |  |  |
| test/coin-ready-review-ui.test.js | 9 | 8 |  | 1 |  |  |  |
| test/coin-ready-review.test.js | 9 | 6 | 1 | 2 |  |  |  |
| test/connect-v3-ui.test.js | 9 | 7 |  | 2 |  |  |  |
| test/google-signin-link.test.js | 9 | 8 |  | 1 |  |  |  |
| test/notify.test.js | 9 |  |  | 7 |  |  | 2 |
| test/profile-view.test.js | 9 |  |  | 2 | 7 |  |  |
| test/swap-api.test.js | 9 | 5 |  | 4 |  |  |  |
| test/wallet-link.test.js | 9 | 8 |  |  |  |  | 1 |
| test/cities.test.js | 8 | 6 |  |  | 2 |  |  |
| test/email-auth.test.js | 8 | 7 |  |  | 1 |  |  |
| test/layout-shift.test.js | 8 |  |  | 8 |  |  |  |
| test/market-live.test.js | 8 | 6 |  |  | 2 |  |  |
| test/profile-bio.test.js | 8 | 2 |  | 4 | 1 |  | 1 |
| test/team-wallet.test.js | 8 | 5 |  | 2 | 1 |  |  |
| test/coin-lp-trading.test.js | 7 | 5 |  | 1 |  |  | 1 |
| test/coin-stats.test.js | 7 |  |  | 5 | 2 |  |  |
| test/hardening-coins.test.js | 7 | 1 |  | 1 | 5 |  |  |
| test/hardening-routes.test.js | 7 | 1 |  | 1 |  |  | 5 |
| test/launchlab-closed.test.js | 7 | 4 |  | 2 |  |  | 1 |
| test/password.test.js | 7 | 5 |  | 2 |  |  |  |
| test/phone-dash.test.js | 7 |  |  |  | 1 |  | 6 |
| test/profile.test.js | 7 | 5 |  | 1 | 1 |  |  |
| test/swap-quote-retry.test.js | 7 |  |  | 4 | 3 |  |  |
| test/coin-ready.test.js | 6 | 5 |  | 1 |  |  |  |
| test/home-cities-layout.test.js | 6 |  |  |  | 6 |  |  |
| test/launchpad-dark.test.js | 6 |  |  | 6 |  |  |  |
| test/lp-batch-ui.test.js | 6 | 2 |  | 4 |  |  |  |
| test/mainnet-preflight-guide.test.js | 6 |  |  | 4 |  |  | 2 |
| test/team-unranked.test.js | 6 | 1 |  | 3 | 2 |  |  |
| test/connect-pairing-review.test.js | 5 | 4 |  | 1 |  |  |  |
| test/dashboard-preview.test.js | 5 | 1 |  |  | 3 |  | 1 |
| test/fixtures/launchlab/raymint.json | 5 | 1 |  |  | 4 |  |  |
| test/helpers/swappage.js | 5 | 2 |  | 1 | 2 |  |  |
| test/launchlab-closed-ui.test.js | 5 | 2 |  | 2 |  |  | 1 |
| test/logo-review.test.js | 5 | 2 | 2 | 1 |  |  |  |
| test/lpkit.test.js | 5 | 3 |  | 2 |  |  |  |
| test/signup-ui.test.js | 5 | 5 |  |  |  |  |  |
| test/team-order.test.js | 5 | 3 |  | 1 | 1 |  |  |
| test/coinchart.test.js | 4 | 4 |  |  |  |  |  |
| test/coins.test.js | 4 |  |  | 1 | 2 |  | 1 |
| test/dash-hold.test.js | 4 | 2 |  | 2 |  |  |  |
| test/helpers/connectpage.js | 4 | 3 |  |  |  |  | 1 |
| test/helpers/dashpage.js | 4 | 2 |  | 1 | 1 |  |  |
| test/helpers/market.js | 4 |  |  |  | 4 |  |  |
| test/helpers/tokenpage.js | 4 | 1 |  |  | 3 |  |  |
| test/lp-batch.test.js | 4 | 1 |  | 1 |  |  | 2 |
| test/lp-sign.test.js | 4 | 4 |  |  |  |  |  |
| test/market-honesty.test.js | 4 | 1 |  | 2 | 1 |  |  |
| test/wallets-silent.test.js | 4 | 1 |  |  | 3 |  |  |
| test/admin.test.js | 3 | 2 |  | 1 |  |  |  |
| test/feed-v2.test.js | 3 | 2 |  | 1 |  |  |  |
| test/fixtures/launchpad-worker/devnet-accounts.json | 3 |  |  |  | 3 |  |  |
| test/hardening-public.test.js | 3 | 1 |  |  | 2 |  |  |
| test/hardening-review.test.js | 3 |  |  | 1 | 2 |  |  |
| test/helpers/readyworld.js | 3 | 1 | 1 | 1 |  |  |  |
| test/legacy-contract.test.js | 3 | 1 |  | 1 |  |  | 1 |
| test/map-labels.test.js | 3 |  |  | 1 | 2 |  |  |
| test/map-overview.test.js | 3 |  |  |  |  |  | 3 |
| test/program-pins.test.js | 3 | 2 |  | 1 |  |  |  |
| test/robustness.test.js | 3 | 2 |  | 1 |  |  |  |
| test/signup-flow.test.js | 3 | 1 |  | 2 |  |  |  |
| test/ticker-pins.test.js | 3 | 2 |  |  |  |  | 1 |
| test/token-card.test.js | 3 |  |  |  | 3 |  |  |
| test/v4-review.test.js | 3 | 2 |  | 1 |  |  |  |
| test/admin-growth.test.js | 2 | 1 |  |  | 1 |  |  |
| test/coin-review-fixes.test.js | 2 |  |  |  |  |  | 2 |
| test/coinart.test.js | 2 | 1 | 1 |  |  |  |  |
| test/connect-wallet.test.js | 2 | 2 |  |  |  |  |  |
| test/dashboard-tabs.test.js | 2 |  |  |  |  |  | 2 |
| test/dashboard-v2.test.js | 2 | 1 |  | 1 |  |  |  |
| test/fixtures/launchlab/jup_tok.json | 2 |  |  |  | 2 |  |  |
| test/hardening-auth.test.js | 2 | 1 |  | 1 |  |  |  |
| test/helpers/jupfake.js | 2 | 2 |  |  |  |  |  |
| test/helpers/pagedom.js | 2 |  |  | 2 |  |  |  |
| test/holders-global.test.js | 2 |  |  | 1 | 1 |  |  |
| test/holders-pages.test.js | 2 |  |  | 2 |  |  |  |
| test/home-d3.test.js | 2 | 1 |  |  |  |  | 1 |
| test/ledger-load.test.js | 2 |  |  | 2 |  |  |  |
| test/limits.test.js | 2 | 2 |  |  |  |  |  |
| test/lptrade.test.js | 2 | 1 |  | 1 |  |  |  |
| test/screen-wordlist.test.js | 2 |  |  |  |  |  | 2 |
| test/signup-dark.test.js | 2 | 2 |  |  |  |  |  |
| test/signup-review-step2.test.js | 2 | 1 |  | 1 |  |  |  |
| test/stale-balances.test.js | 2 |  |  | 2 |  |  |  |
| test/wallet-disown.test.js | 2 | 2 |  |  |  |  |  |
| test/accounts.test.js | 1 | 1 |  |  |  |  |  |
| test/coin-review-nits.test.js | 1 | 1 |  |  |  |  |  |
| test/contrast.test.js | 1 |  |  |  | 1 |  |  |
| test/d3-fix.test.js | 1 |  |  |  | 1 |  |  |
| test/dashboard-v2-ui.test.js | 1 | 1 |  |  |  |  |  |
| test/dashboard.test.js | 1 |  |  | 1 |  |  |  |
| test/email-auth-input-shapes.test.js | 1 | 1 |  |  |  |  |  |
| test/fair.test.js | 1 |  |  | 1 |  |  |  |
| test/feedback-ui.test.js | 1 |  |  |  | 1 |  |  |
| test/feedback.test.js | 1 | 1 |  |  |  |  |  |
| test/fixtures/launchpad-worker/mainnet-pool-config.json | 1 | 1 |  |  |  |  |  |
| test/handoff.test.js | 1 | 1 |  |  |  |  |  |
| test/helpers/fakedom.js | 1 | 1 |  |  |  |  |  |
| test/helpers/screen-corpus.js | 1 | 1 |  |  |  |  |  |
| test/helpers/world.js | 1 | 1 |  |  |  |  |  |
| test/holders-shared.test.js | 1 |  |  | 1 |  |  |  |
| test/motion.test.js | 1 | 1 |  |  |  |  |  |
| test/no-wallet-dashboard.test.js | 1 |  |  | 1 |  |  |  |
| test/profiles-dark.test.js | 1 |  |  | 1 |  |  |  |
| test/signup-location.test.js | 1 | 1 |  |  |  |  |  |
| test/signup-review-password.test.js | 1 |  |  | 1 |  |  |  |
| test/signup-security.test.js | 1 | 1 |  |  |  |  |  |
| test/steward-squads.test.js | 1 |  |  | 1 |  |  |  |
