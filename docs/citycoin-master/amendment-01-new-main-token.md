# Amendment 01: a new main token, a new official X page and a new official Telegram

> **DESIGN. NOTHING IS LIVE.** Written 24 October 2026. The owner has **not** supplied the new mint, the new X address or the new
> Telegram address yet. All three are unknown, and they stay empty (`null`) in every file of this package until the owner supplies
> them and they pass the verification in section 4. Nothing on the live site (main `4aa408e`) changes until (1) the owner supplies
> verified values, (2) the code stage that reads them is merged, and (3) the token and official-link rollout switch
> `MAIN_TOKEN_V5` is turned on by its own configuration pull request. Until then the live site keeps showing what it shows today.

## 1. The owner's instruction

Owner amendment 01, 24 October 2026, verbatim intent:

> "Citycoin.dev will have a new main token with a new Solana mint, a new official X page, and a new official Telegram handle. Do not
> reuse the old $VICINITY mint as the main token. Use the new mint for balance tracking, city-founder selection and country-manager
> rankings. Update all website branding, token information, purchase links and social links accordingly. Keep the mint address, X
> URL and Telegram URL centrally configured. Use only verified values; never invent addresses or handles. Do not automatically swap
> or migrate existing $VICINITY holdings."

Precedence: this amendment is a written owner instruction issued after master change order v5 (23 October 2026). For the main token
only, it overrides the master's lines that keep the existing main-token mint or forbid a replacement main-token mint (master
sections 02, 07, 14, 16 and 28). Every other master rule stands. In particular, master section 02 still forbids a forced asset
migration and any retroactive change to an existing minted coin; the amendment says the same for `$VICINITY` holdings.

## 2. What changes and what does not

| Area | Before amendment 01 (this package, phase 1) | After amendment 01 |
|---|---|---|
| Main token | The existing mint `2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray` ($VICINITY), fixed in the policy, replacement not authorized | A new mint supplied by the owner, held in one configuration key, `MAIN_TOKEN_MINT`, verified on chain before use. `null` until then. Replacement authorized by this amendment. |
| `$VICINITY` | The main token | A **legacy token**, history only (`policy.legacy_tokens`). Never the main token, never a balance source, never used for founder selection, manager ranking, purchase links or the main-token quote. |
| Holders of `$VICINITY` | n/a | Keep their tokens. No automatic swap, migration, airdrop or transfer of anyone's holdings. No swap is offered for it. |
| Founder selection balance, tie-break balance, national rank | "The configured main-token mint", which was `$VICINITY` | The same rules, measured on the configured, verified `MAIN_TOKEN_MINT` (policy `founder_selection.balance_measure`, `tie_break.balance_mint`, `country_manager.national_rank_balance`) |
| Main-token quote config | `quote_mint` = the `$VICINITY` mint, 6 decimals | `quote_mint` = `null` until the configured mint is verified and passes the quote safety checks. Decimals and raw amounts come from the verified mint. The rules stay: graduation at 1,000,000 main-token units, a minimum buy of 1 unit, the same city-token allocation and curve shape. |
| Purchase links (Buy, Jupiter, DEX Screener and similar) | Built from the `$VICINITY` mint | Built only from the configured, verified main-token mint, and shown only when a live quote finds a real route. Otherwise hidden. Never built for a legacy token. |
| Official X | `@VicinityCitySOL` (https://x.com/VicinityCitySOL) in every page footer | `OFFICIAL_X_URL`, owner-supplied and verified. Empty means not shown. The old account becomes a legacy link (`policy.official_links.legacy.x_url`), and it is refused as the new official link. |
| Official Telegram | None listed | `OFFICIAL_TELEGRAM_URL`, owner-supplied and verified. Empty means not shown. |
| Hourly holder distribution | Per city coin | **Unchanged.** It measures holders of each city coin, not the main token. |
| Fees, selection clock, activity points, manager approval, metadata review, program changes | As in master v5 | **Unchanged.** |
| Deployed programs, program IDs, `/coin-meta/*`, `/brand/vicinity-512.png` | Kept | **Unchanged** (legacy compatibility, master section 08). |
| Policy version | `citycoin-master-v5` | Unchanged string. The `policy_digest` (schema-and-api.md section 2.1) differs, so two deployments can still be told apart. No row has been recorded under the version yet. |

## 3. Central configuration keys and their validation

The three values live in one place each: a Worker setting of the same name, read only through the helpers below. No page, script
or module may write a mint, X address or Telegram address of its own. The policy document (`policy.json`, mirrored in
`src/masterpolicy.js`) holds `null` for all three and never holds the values themselves; the deployment block lists them as inputs
(`deployment.inputs.MAIN_TOKEN_MINT`, `OFFICIAL_X_URL`, `OFFICIAL_TELEGRAM_URL`), all `null`.

| Key | Holds | Until supplied | Shape rule (checked by code) | Named errors |
|---|---|---|---|---|
| `MAIN_TOKEN_MINT` | the new main-token mint | unset; every feature that needs it stays off or hidden | base58 text of a 32-byte public key; not the all-zero default key `11111111111111111111111111111111` (the System Program address, a common "none" placeholder); not any legacy mint | `MAIN_TOKEN_MINT_INVALID`, `MAIN_TOKEN_IS_LEGACY_MINT`, `MAIN_TOKEN_MINT_MISSING` |
| `OFFICIAL_X_URL` | the new official X page | unset; no X link is shown | `https://x.com/<handle>`, handle of 1 to 15 characters from `A-Z`, `a-z`, `0-9` and `_`. `https://twitter.com/<handle>` (and a `www.` prefix or one trailing slash) is accepted and normalized to `https://x.com/<handle>`. No query, fragment, port, user part or second path segment. X's own pages (`home`, `i`, `intent`, `search` and similar) are refused. | `OFFICIAL_X_URL_INVALID`, `LEGACY_SOCIAL_LINK_AS_OFFICIAL` (the old account, in any letter case, on x.com or twitter.com) |
| `OFFICIAL_TELEGRAM_URL` | the new official Telegram channel or group | unset; no Telegram link is shown | `https://t.me/<name>`, name of 5 to 32 characters from `A-Z`, `a-z`, `0-9` and `_`. One trailing slash is allowed. Invite links (`+...`, `joinchat/...`) and Telegram's own pages are refused. | `OFFICIAL_TELEGRAM_URL_INVALID` |

**Features that need the main token** (`MAIN_TOKEN_FEATURES` in `src/masterpolicy.js`): `selection`, `manager_ranking`,
`token_page`, `purchase_links`, `main_token_quote`. If any of them is enabled while `MAIN_TOKEN_MINT` is unset, validation answers
`MAIN_TOKEN_MINT_MISSING`, once, naming every feature that needs it. An unset value is accepted while every dependent feature is off.
A set value is always shape-checked, even with every feature off. An unset link is never an error.

**How `validatePolicy` maps switches to those features:** `SELECTION_V5` shadow or on (selection, including the dry run, reads
balances); `MANAGER_APPS=on` (national rank); `MAIN_TOKEN_V5=on` (token page and purchase links); `LAUNCH_V5=on` or
`CC_TRADING=on` with `main_token` in `enabled_quote_configs` (main-token quote). An enabled main-token quote also needs chain facts
keyed by the configured mint (`QUOTE_FACTS_MISSING` otherwise), a classic SPL Token owner, integer decimals read from chain, and no
mint or freeze authority (`QUOTE_TOKEN_PROGRAM`, `QUOTE_DECIMALS`, `QUOTE_MINT_AUTHORITY`, `QUOTE_FREEZE_AUTHORITY`).
A policy edited to name a legacy mint as `main_token.mint` or `quote_configs.main_token.quote_mint` fails with
`MAIN_TOKEN_IS_LEGACY_MINT` as well as `POLICY_VALUE_MISMATCH`.

**Helpers** (pure, in `src/masterpolicy.js`; since stage S02A imported by exactly one module, the adapter `src/maintoken.js`, section 11):

- `mainTokenConfig(env)` returns `{ configKey: "MAIN_TOKEN_MINT", mint, problem }`. `mint` is `null` when the key is unset, blank,
  malformed or a legacy mint, so a consumer can never pick up an unusable or legacy value; `problem` names the refusal. It never
  reads `VICINITY_MINT`.
- `officialLinks(env)` returns `{ xUrl, telegramUrl, configKeys, problems }`, each link normalized or `null`.
- `validateDeploymentConfig(env, features)` returns `{ ok, errors }` for the three keys against a list (or object of booleans) of
  enabled features. A malformed `features` argument is refused (`FEATURES_INVALID`, `FEATURE_UNKNOWN`), never read as "nothing on".

**The switch.** `MAIN_TOKEN_V5` (off, on; off is today's behavior) is a proposed switch like the others in
`schema-and-api.md` section 2.2. On, every main-token consumer in section 5 reads the verified `MAIN_TOKEN_MINT`, the footer and the
link checker use the configured official links, and `$VICINITY` is shown as legacy. It rolls out with the brand rollout
(`BRAND=citycoin`, implementation-report.md stage S48) or after it, never before the values are verified.

**Shape is not verification.** A key that passes these checks only has the right form. Nobody writes a value into the configuration
until the verification record of section 4 exists for it.

## 4. Verification procedure

Each value is verified once, before it is configured, and again on the day the switch goes on. Every read is read-only: no
transaction, no signature, no keypair, no secret. The record is a new section of this file (section 9), committed with the
configuration pull request that sets the value.

### 4.1 The mint

1. **Source.** The owner supplies the mint in writing (the full base58 text, not a screenshot), through a channel already used for
   owner decisions. The person recording it copies it exactly and compares it character by character with the owner's text. A
   value seen anywhere else (a social post, a token list, a search result) is never used.
2. **Shape.** `mainTokenConfig({ MAIN_TOKEN_MINT: value })` returns the value with `problem: null`. That also proves it is not the
   legacy mint.
3. **Mint account** (read-only `getAccountInfo`, commitment `finalized`, `jsonParsed`, on mainnet, from two independent RPC
   providers that must agree):
   - the account exists;
   - its owner program is the classic SPL Token program `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`. Any other owner, including
     Token-2022, is refused until a reviewed policy change documents and tests it (`policy.main_token.other_token_programs`):
     Token-2022 extensions such as confidential balances, a permanent delegate or transfer hooks would change what a balance
     means for selection and ranking;
   - the parsed type is `mint` and it is initialized;
   - record `decimals`, the raw `supply`, `mintAuthority` and `freezeAuthority` (each an address or none), and the slot of the read.
4. **Who can mint or freeze.** For each authority that is present, record the address and what it is (a wallet on the ed25519
   curve, or a program-derived or multisig account, with its owner program). Then state the consequence in the record:
   - a live **mint authority** can create new balance at will, so whoever holds it can decide founder selections and national
     ranks. The owner must disclose it publicly before `SELECTION_V5` or `MANAGER_APPS` reads this mint, and the
     selection-completeness rule "supply can only fall" (schema-and-api.md section 3.2) no longer holds: the selection job must
     then also record supply at each cutoff;
   - a live **freeze authority** can freeze any holder's account;
   - the **main-token quote** is refused while either authority is present (`requires_revoked_mint_and_freeze_authority`).
5. **Metadata name and symbol, read from chain.** Derive the Metaplex metadata account
   (`["metadata", metadata program, mint]` under the Metaplex token metadata program), read it, and record the update authority,
   name, symbol and URI. If no metadata account exists, record "none": the site then shows the mint without a name and never
   invents one. The name and symbol must match what the owner announced; any difference stops the procedure.
6. **Not a legacy mint.** Confirm the value differs from every `policy.legacy_tokens` mint (step 2 does this in code; the record
   states it).
7. **Holders that are not people.** Read the largest holders once and identify pools, locks, program accounts and team wallets of
   the new token. The owner confirms which addresses are team wallets or locks **for the new token**. The `$VICINITY` team list,
   its Jupiter Lock escrow and its Raydium LaunchLab pool are legacy facts and are not carried over by assumption (section 5.2).
   Founder selection excludes the confirmed ones (schema-and-api.md section 3.2, "Candidates").
8. **Record** (all fields of `policy.main_token.verification_record`): mint, cluster, slot, owner program, decimals, raw supply,
   mint authority, freeze authority, metadata name, metadata symbol, the two RPC providers used, who verified it (a named person)
   and when (UTC). A second person repeats steps 2 to 6 independently and signs off in the same record.

### 4.2 The X page and the Telegram address

1. **Source.** The owner supplies each address in writing. Nobody derives a handle from a name, a search or a similar-looking
   account.
2. **Shape.** `officialLinks(env)` returns the normalized address with no problem. For X, this also refuses the legacy account.
3. **The page exists.** A person opens the normalized address in a normal browser and records the account name and handle that the
   page shows, or the Telegram channel or group title and its public username. A page that does not load, names a different
   handle, or is a personal account the owner did not name stops the procedure.
4. **It is the official account.** At least one of these, recorded with its evidence:
   - the owner shows, in the same session, that they are signed in to it (X settings page, or the Telegram admin view of the channel
     or group);
   - the new account's profile links `https://citycoin.dev` (or, before the domain cutover, `https://vicinity.city`), and the owner
     confirms in writing;
   - for X, the legacy account `@VicinityCitySOL` posts the new handle, and the post's address is recorded.
5. **Record:** the normalized address, the name the page shows, the evidence (post address or a description of what was shown),
   who checked it (a named person) and when (UTC).

### 4.3 On the day the switch goes on

Re-run 4.1 steps 3 to 6 and 4.2 step 3. Any difference from the record (an authority that appeared, a renamed account) stops the
switch until the owner decides.

## 5. Current consumers that must move from the legacy mint to the configured main mint

All references are to main `4aa408e` (no tracked file in the worktree differs from it). Found with `git grep -n` for
`VICINITY_MINT`, `activeMint(`, the legacy mint literal, `withMint(`, `officialFor(`, `launchedAtOf(`, `teamLocks`,
`isTeamWallet(`, `kind: "vicinity"`, and the purchase-link hosts (section 10). Today every consumer below reads the Worker setting
`VICINITY_MINT` (wrangler.jsonc:32), whose value is the legacy mint, through `activeMint(env)` (src/official.js:267-268).

**The rule for the migration:** one adapter, `mainMint(env)` (the `mainTokenConfig` helper, wired in `src/maintoken.js` and applied by `tokenMint(env)` in `src/official.js` since S02A), replaces
`activeMint(env)` for every main-token use under `MAIN_TOKEN_V5=on`. `VICINITY_MINT` keeps its name (rebrand-inventory.md P06) and is
read only to show legacy history. Many places today use `Boolean(activeMint(env))` to mean "the token has launched"
(src/index.js:427, 510, 516; src/signup-finish.js:140; src/auth.js:657; src/roles.js:44; src/me.js:100; src/profiles.js:127).
They must not flip to "not launched" when the main token is unset: the switch cannot go on without `MAIN_TOKEN_MINT`
(`MAIN_TOKEN_MINT_MISSING`), and the early-member flags at src/signup-finish.js:140 and src/auth.js:657 must keep meaning "joined
before `$VICINITY` launched on 3 Oct 2026" (history), not "before the main token is configured".

### 5.1 Configuration and the official list

| Consumer | `path:line` at 4aa408e | Today | Change |
|---|---|---|---|
| Worker setting | wrangler.jsonc:32 | `VICINITY_MINT` = the legacy mint | Keep for history. Add `MAIN_TOKEN_MINT`, `OFFICIAL_X_URL` and `OFFICIAL_TELEGRAM_URL` (unset) in the configuration pull request that follows verification. |
| Code fallback and reader | src/official.js:10-11, 267-268 | `VICINITY_MINT = null`; `activeMint` = setting or fallback | `mainMint(env)` from `MAIN_TOKEN_MINT` only; no code fallback |
| Launch time | src/official.js:13-16 | `VICINITY_LAUNCHED` keyed by the legacy mint; `launchedAtOf` | Legacy fact. The new mint's creation time is recorded only from its verification record. |
| Official token registry | src/official.js:35, 66-72, 275-283 (`tokenContract`, `tokens[0]` "Vicinity", "Raydium LaunchLab", `withMint`) | The legacy mint is "the official token" | Main-token row from `mainMint(env)` with the on-chain name and symbol from the verification record; a separate legacy row for `$VICINITY` marked legacy |
| Official addresses page | src/official.js:250-253 (group "$VICINITY", "The platform token"), 254-262 (the "Team" group, with the `$VICINITY` team-lock note at 256); public/official.html:136-141, built at page-build time from the deployed settings (scripts/pages/build.mjs:211) | Lists the legacy mint as the platform token | Main token from configuration; `$VICINITY` under a "Legacy" group. The page is rebuilt when the value changes. |
| Link checker | src/official.js:144-158 (contract answers), 137-139; 104-107 (`MARKETS`: raydium.io, jup.ag, dexscreener.com, solscan.io) and 201-209 (market-link answers: "This link opens the official $VICINITY on ...", "NOT the official $VICINITY") | "This is the official $VICINITY contract address." | The configured mint answers as the main token; the legacy mint answers "the legacy $VICINITY contract (history only), not the Citycoin.dev main token". A market link is judged against the configured mint; a market link for the legacy mint is answered as legacy, never as "the official" token. |
| `/api/official` | src/index.js:425; src/official.js:289-311 | `tokenContract` = legacy mint | `tokenContract` from `mainMint(env)`; add `legacyTokens` and `officialLinks` keys under `PUBLIC_V5` |
| Edge cache keys | src/index.js:307 (`launchpad-<mint>`), 329 (`swap-config-<mint>`); src/cointakedown.js:106 (purges `launchpad-<mint>`) | Keyed by the legacy mint, or `pre` when none is set | Keyed by `mainMint(env)` (or `pre`), so an answer cached for the legacy mint is never served as the main token's after the switch, and a takedown purges the right key |
| Admin view | src/admin.js:376 (official tokens), 525 (`VICINITY_MINT` present) | Reports the legacy setting | Also report `MAIN_TOKEN_MINT`, `OFFICIAL_X_URL`, `OFFICIAL_TELEGRAM_URL` presence and their `validateDeploymentConfig` errors (presence and error codes only) |

### 5.2 Token page, holders list and labels

| Consumer | `path:line` at 4aa408e | Today | Change |
|---|---|---|---|
| Token page markup | scripts/pages/src/token.html:1, 7, 35, 56, 136, 138, 140, 158, 172, 176, 181, 186, 188 | Title, hero and FAQ name `$VICINITY`; "Minting disabled" (136), "Liquidity locks at graduation" on Raydium (138), "60M team tokens locked" (140), founder amount in `$VICINITY` (188) | Main-token wording from the verification record. Every proof card states a fact read for the new mint, or is removed: 136 only if its mint authority is none, 138 only if its venue says so, 140 only for a verified lock of the new token. The `$VICINITY` facts move to a legacy section. |
| Token page script | public/token.js:45-48 (Solscan, Jupiter, Raydium LaunchLab, DEX Screener links), 146 (`launched` check), 177 and 199 (team wallets and team lock card), and 4, 50, 58, 80, 99, 128, 149, 269, 316, 371, 378, 387, 401, 404, 540, 559, 587 (wording) | Links and cards for the legacy mint | Links built only from the configured mint, purchase links only after a quote finds a route (section 5.4); lock card only for a verified lock of the new token |
| `/api/token` | src/index.js:449-461; src/chain.js:96-147 (`getTokenFacts`) | Facts and price of the legacy mint | `mainMint(env)`; supply, decimals and authorities read live and compared with the verification record |
| `/api/holders`, `/api/rank`, `POST /api/verify` | src/index.js:462-470 and 196-217 (holders), 471-480 and 218-242 (rank), 163-185 (verify, which reads the mint at 169) | Every holder of the legacy mint, ranked | The configured mint. The legacy list, if kept, moves to a history route labeled legacy and is never ranked as the live list. |
| Holder reader | src/chain.js:267-271 (`getAllHolders`; SPL Token and Token-2022 filters), 152, 184, 195 | Reads any mint it is given | No change to the reader; callers pass the configured mint |
| Pool labels | src/chain.js:21-38 ("Raydium LaunchLab curve" at 26 is where `$VICINITY` launched) | Labels by owner program | The program labels stay generic. That the LaunchLab pool is "the token's pool" is a `$VICINITY` fact and becomes history. The new token's pools are identified at verification (4.1 step 7). |
| Team wallets and team lock | src/official.js:36-64 (`teamWallets`, `teamLocks`: 60,000,000 `$VICINITY` in Jupiter Lock escrow `CnRn4NiHSfezUHxh7EUytzcoJv98yeH5CpbCgsvyejB6`, `mint` = the legacy mint at 56), 80-87 (labels), 103 (lock message); src/chain.js:43-60 (`isTeamWallet`, `isTeamLock`, `holderOrder`), 301 | Labeled and never ranked in the `$VICINITY` holder list | `$VICINITY`-specific: the lock, its schedule and the "Team wallet (FOMO)" listing describe `$VICINITY` holdings and become legacy facts. The new token's team wallets and locks are supplied by the owner and verified (4.1 step 7) before the new holder list labels them or selection excludes them. |

### 5.3 Balance sampling, ledger and snapshots

| Consumer | `path:line` at 4aa408e | Today | Change |
|---|---|---|---|
| Balance sampler | src/ledger.js:24-25 (`maybeSample`), 47-70 (`takeSample` reads `activeMint`, publishes the shared holder copy at 59) | Samples every `$VICINITY` holder about once an hour | Samples the configured mint, behind `MAIN_TOKEN_V5` |
| Ledger storage | src/store.js:184-191 (`balance_samples`: no mint column); src/ledger.js:61-70 (blob `day:<d>` with summed balances, keyed by day only) | One series, implicitly `$VICINITY` | Key the series by mint (for example `day:<mint>:<d>` and a `mint` column, additive), or close the `$VICINITY` series at cutover and label it legacy. Two tokens must never be summed into one day. |
| Streaks | src/ledger.js:69 (`updateStreaks`) | Founder hold streaks in `$VICINITY` | Frozen with the seat system (00-reconciliation.md FS-10); history only |
| Founding Supporters snapshot | src/snapshot.js:1-8, 82 (reads the day blobs, excludes the team lists) | Dormant, no cutoff set | Legacy history. Never an input to v5 selection (00-reconciliation.md FS-11). |

### 5.4 Seats, roles, profiles, portfolio, swap, Buy panel and Send

| Consumer | `path:line` at 4aa408e | Today | Change |
|---|---|---|---|
| Seats (frozen by `LEGACY_SEATS`) | src/seats.js:123, 760, 1038 | Founder amounts in `$VICINITY` | Frozen; the v5 selection reads the configured mint (policy `founder_selection.balance_measure`) |
| Roles | src/roles.js:20 (`amountsFor` with the mint), 44 | Live balances of `$VICINITY` | The configured mint for v5 ranks; legacy roles stay history |
| Profiles and member data | src/profiles.js:127, 148; src/me.js:89, 100, 470 | Holding, rank and "holder" counts in `$VICINITY` | The configured mint; a legacy `$VICINITY` holding may be shown labeled legacy |
| Member badges | src/me.js:47-54 ("Early member": joined before `$VICINITY` launched; "Holder", "Founder-ready" and "Big holder" measured in `$VICINITY`) | Badges earned from `$VICINITY` balances | "Early member" stays history (see the rule above). Holding badges measure the configured mint; badges already earned from `$VICINITY` stay as history, labeled legacy |
| Rules page "never" list | src/policy.js:96 ("Mint more $VICINITY: minting is switched off on the blockchain."), shown on /rules | A true statement about the legacy mint | Stays as a legacy fact. A statement about the main token appears only if its verification record shows no mint authority (4.1 step 4) |
| Portfolio | src/portfolio.js:100-103 (`kind: "vicinity"`, symbol `VICINITY`) | `$VICINITY` first in every portfolio | The main token from configuration with its on-chain symbol; `$VICINITY` as a legacy item |
| Sign-up and Google flags | src/signup-finish.js:140; src/auth.js:657 | "early" = token not launched | Keep as history (see the rule above) |
| Swap token list | src/swap.js:360-362 (adds the main token with `decimals: 6` written in code, `kind: "vicinity"`) | `$VICINITY` is the swap's main token | Decimals from the verified mint, symbol from the record; no `$VICINITY` entry |
| Buy panel | public/swap.js:186, 300, 425 (default output = the `kind: "vicinity"` token), 1009, 1064, 1342-1355; public/token.js:75 | Opens on `$VICINITY` | Opens on the configured main token only when a quote finds a route; otherwise no default and no Buy button |
| Coin list and links | src/coins.js:119, 269, 472; src/launchpad.js:49-64 (`buyHereLink`, link templates: raydium.io, jup.ag, dexscreener.com, solscan.io), 130, 189-196 (the `$VICINITY` card: "Raydium LaunchLab", pair SOL), 240-252 (price reads) | `$VICINITY` card and links | Main-token card from configuration; purchase links follow the policy (`main_token.purchase_links`); no legacy card in the live list |
| Market data allow-list | src/market.js:4, 62; src/marketlive.js:2-4 (allow-list, and research recorded on 6 Oct 2026 for the legacy mint); src/pricehistory.js:5, 29, 39 | Market data is fetched only for `$VICINITY` and recorded city coins | The allow-list takes the configured mint instead; the research notes stay as legacy history |
| Coin page | src/coin.js:5 (allow-list: "$VICINITY (the VICINITY_MINT setting)"), 31-33 (`kind: "vicinity"`, ticker `VICINITY`, name "Vicinity", pair SOL); public/coin.js:112-114, 409-411, 428-432, 448 and 607 (the "Official" tag compares `tokenContract`), 614, 667-697, 722, 776, 949-953 | The legacy mint is the official main coin | The configured mint; the legacy mint gets a legacy tag and no Buy |
| Launchpad page | public/launchpad.js:38, 45, 114, 116, 159-165, 195, 214, 224, 227-247, 518, 544, 558, 607, 618, 675, 693-694, 707, 829 | `$VICINITY` leads the list with Raydium links | Main token from configuration |
| Dashboard Buy & swap card | public/dashboard.js:1548-1612 (routes; jup.ag at 1608, raydium.io for the `$VICINITY` mint at 1612) | Links for the legacy mint | Purchase links per policy |
| Price history | src/pricehistory.js:32-33 | Charts `$VICINITY` from its launch time | The configured mint; the `$VICINITY` chart stays as legacy history |
| Send | src/walletsend.js:138 (refuses sending to the team lock), 163 (label `$VICINITY`), 295 (refusal "Only SOL, $VICINITY and Vicinity city coins can be sent from here."); public/wallet-send.js:4, 36, 134 | `$VICINITY` is a supported asset | The main token from configuration. A holder may still send their own `$VICINITY` (their own action, zero platform fee), labeled legacy. |
| Pay-with asset list (SDK) | solana/sdk/launchpad/pay-assets.mts:75, 96 (`VICINITY_MINT`, "Thin liquidity" note); its test solana/sdk/launchpad/jupiter.test.mts:18, 87-88, 118, 156, 162, 235, 270 and fixture solana/sdk/launchpad/fixtures/jupiter-build-cbBTC-to-VICINITY-max64.json | `$VICINITY` is a pay-with asset | Remove from the new path; legacy SDK only |
| Legacy launch setup | solana/scripts/launchpad/setup.mjs:26, 82 (mainnet quotes SOL and `VICINITY_MINT`); solana/LAUNCHPAD-DESIGN.md:25-28 (a possible second legacy launch config priced in `$VICINITY`) | Legacy launchpad quote list | Legacy program only; not a v5 quote (the v5 main-token quote is `quote_configs.main_token`) |
| Legacy referral accounts | src/lpadmin.js:286, 308-317, 417, 732; src/lptrade.js:14, 34 | The fee wallet's `$VICINITY` token account | Legacy path only |

### 5.5 Map, dashboard and page displays

These show the token by name or amount. Each moves to the configured main token's on-chain symbol under `MAIN_TOKEN_V5`, or labels
`$VICINITY` as legacy where it states history:

- public/cities.js:27, 1220, 1276, 1724-1727, 1784, 1799, 1910 (map holder colors and counts);
- public/dashboard.js:356, 452-456, 507, 529, 706-716, 737-745, 923-925, 954-955, 1199, 1460, 1483, 1548-1610;
- public/dashboard-v2.js:15, 519, 542-564, 619-629, 657, 684, 714, 777, 802-803, 819-820;
- public/dashboard-roles.js:106-146, 187, 238;
- public/home.js:4, 71-97, 114, 142;
- public/profile.js:86, 226-228, 257, 397-399, 584-587, 655;
- public/admin.js:477, 600, 632, 641;
- public/signup.js:482 ("your dashboard shows how much $VICINITY you hold and your rank"); public/rules.js:49 ("Balance checks start the moment $VICINITY launches."); public/feedback.js:21 (the "Question" topic names `$VICINITY`);
- page sources: scripts/pages/src/index.html:1, 8, 10, 48, 69, 80, 100-106, 119, 121 (100-106 tell the Raydium LaunchLab launch, which is history); scripts/pages/src/dashboard.html:30-31, 147-227, 507-514, 577, 671, 685, 819-843; scripts/pages/src/app.html:1, 10, 20, 27, 42, 75, 85; scripts/pages/src/cities.html:136; scripts/pages/src/official.html (one line); scripts/pages/src/connect.html:309 and scripts/pages/src/rules.html:121 (what other members can see: "your $VICINITY and city-coin balances"); scripts/pages/src/profile.html:115, 129 (the holdings heading `$VICINITY` and "Only $VICINITY and city coins are shown"); scripts/pages/src/rules.html:20 (the legacy seat rule "hold ... $VICINITY", frozen with `LEGACY_SEATS`, 00-reconciliation.md FS-10); scripts/pages/src/launchpad.html:12 (a comment);
- the generated pages under public/*.html repeat their sources above and are regenerated by the page build, never edited by hand;
- style-sheet comments only, with no visible text: public/pages-coin.css:11, public/pages-home.css:2, public/pages-launchpad.css:5, 98, 120, 164, 188, public/polish-map.css:2, public/polish.css:141, public/style.css:38, 283, 1781, public/swap.css:25.

### 5.6 Metadata and preflight scripts, docs and tests

| Consumer | `path:line` at 4aa408e | Change |
|---|---|---|
| Mainnet preflight | scripts/mainnet-preflight.mjs:109 (settings it reads), 149-154 (holder-list RPC check on the mint), 186-187 (`VICINITY_MINT` must be an address), 203-209 (Jupiter quote and build SOL to `$VICINITY`), 239-240 (mint authorities), 290-291 (`/api/official` `tokenContract`), 322-324 (site quote), 577-591 (`$VICINITY` referral account) | Check `MAIN_TOKEN_MINT` with `validateDeploymentConfig`, the mint facts against the verification record, and the quote for the configured mint; keep the legacy rows labeled legacy |
| `$VICINITY` (legacy token) on-chain metadata | Metaplex account `DwmtvKsStZQypwfkJWNwXCtMUL5Bx1kx268PmwzwV8KJ` (derived from the legacy mint; "VICINITY CITY", "VICINITY"; rebrand-inventory.md T01) | Legacy fact. The new mint's metadata is read at verification (4.1 step 5); the site never writes token metadata for it. |
| Coin-art arc text "VICINITY CITY" | src/coinart.js:45, 58 | A brand string, not the mint: rebrand-inventory.md L13 |
| Reserved tickers | src/coinreview.js:133 (`RESERVED_TICKERS`), src/screen-words.js:183 (`OK_TICKERS`) | Stay: nobody may launch a city coin that looks like the legacy token (rebrand-inventory.md T02). The new token's ticker is added once its symbol is read at verification. |
| Brand strings that are not the token | src/mail.js:159, 208, 242 (the "VICINITY." e-mail wordmark); src/coinmeta.js:34-80 (`VICINITY_BRAND`); src/sol/lpadmin-ix.js:48, 149 (`VICINITY_PARTNER`); scripts/coin-art/fonts.mjs:2 | Not main-token consumers; they follow the brand rollout in rebrand-inventory.md |
| Owner and developer docs | README.md:7, 66, 91; docs/DEPLOY.md:29, 180; docs/MAINNET.md:15, 153; docs/AUDIT.md:139, 170; and every other line that names `VICINITY` in README.md (12 lines in all), docs/MAINNET.md (18), docs/DEPLOY.md (8), docs/AUDIT.md (4), docs/HARDENING-2026-10-03.md (2), docs/COIN-READY.md (1) and docs/OWNER-LAUNCH-GUIDE.md (1) | Updated in the configuration pull request: `$VICINITY` described as legacy, `MAIN_TOKEN_MINT` as the main token setting. Dated records (audits, hardening notes) keep their text as history. The solana/ design, audit and devnet documents describe the legacy program and stay as history. |
| Code comments that call `$VICINITY` the token | src/index.js:48, 56, 66 (settings list), 434; src/chain.js:3, 183, 192, 542; src/coins.js:464, 469; src/launchpad.js:3, 104, 146, 231; src/portfolio.js:2, 9, 18, 129; src/walletsend.js:2, 17, 152-153; src/admin.js:177; src/store.js:725; src/cluster.js:101; src/flags.js:67; src/launchlab.js:5; src/swap.js:2; src/profiles.js:19; src/roles.js:7; src/official.js:226, 271; public/coin.js:1; public/swap.js:1-2, 1002 | Reworded with the code they describe, in the same pull request |
| Tests that contain the legacy mint | test/coin-ui.test.js, test/launchpad.test.js, test/lpadmin.test.js, test/official-coins.test.js, test/preflight.test.js, test/robustness.test.js, test/team-lock.test.js, test/team-wallet.test.js, test/helpers/jupfake.js, test/helpers/market.js, test/helpers/swappage.js, test/helpers/tokenpage.js, and six fixtures under test/fixtures/jupiter and test/fixtures/launchlab (18 files) | They assert today's behavior and change in the same pull request as the code they test; new tests use a generated test fixture mint, never an invented "real" one |
| Tests that set `VICINITY_MINT` | 56 files under test/ set or read the setting, with a test mint or the legacy mint (for example test/chain.test.js, test/coin-api.test.js, test/helpers/readyworld.js, test/site.test.js:452, which reads wrangler.jsonc); in solana/, tests-launchpad/22-batch-approvals.test.mjs:117 | With the switch off they keep passing unchanged. Each path that reads the main token under `MAIN_TOKEN_V5=on` gets a test that sets `MAIN_TOKEN_MINT` to a generated test fixture mint, plus a test that the legacy mint in `MAIN_TOKEN_MINT` is refused |

## 6. Every social-link location

No official Telegram link exists on the site at `4aa408e`: src/official.js:23 says one is added "once the owner names the official
group", test/official-socials.test.js:43-47 asserts that none is listed, and scripts/pages/build.mjs:83 already carries a Telegram
icon. The only Telegram address in the repository is an invite link inside test/fixtures/launchlab/raymint.json, a recorded
Raydium LaunchLab answer that carries the legacy token's third-party listing data (with the old X account in lower case and a share
query). That listing data is not verified and is never a source for `OFFICIAL_TELEGRAM_URL` or `OFFICIAL_X_URL`; an invite link is
refused by the shape check anyway. The other `t.me` strings are generic: link-host lists (src/screen-words.js:180-181,
src/profile-core.js:90), a comment (src/official.js:21), and test inputs (test/official-socials.test.js:45 checks that a `t.me`
address with the old handle is not official; test/site.test.js:92 adds a made-up example entry inside a test).

| Location | `path:line` at 4aa408e | Today | Change |
|---|---|---|---|
| The one list | src/official.js:21-26 (`SOCIAL_PROFILES`: X, `@VicinityCitySOL`, hosts x.com and twitter.com, "verified 2026-09-30"), 34 (`socials`) | The legacy X account is the official account | Built from `officialLinks(env)`: X and Telegram entries only when configured and verified. The old account moves to a legacy list. |
| Link checker | src/official.js:128-135 (`socialLink`), 161-172 (handle answers), 188-197 (link answers) | `@VicinityCitySOL` answers "official" | The configured accounts answer "official"; the old account answers "the former Vicinity account (legacy), not the current official account" |
| Page footers (build) | scripts/pages/build.mjs:78-96 (`socialLinks`, `aria-label "Vicinity on X (@VicinityCitySOL)"`), 158-159 | One X icon in every footer | Icons only for configured links; none when empty |
| Page footers (generated, hard-coded) | public/404.html:94, admin.html:122, app.html:168, cities.html:236, coin.html:252, connect.html:534, credits.html:142, dashboard.html:929, index.html:204, launchpad.html:170, locate.html:108, official.html:204, profile.html:267, rules.html:216, terms.html:285, token.html:269 (16 pages) | `https://x.com/VicinityCitySOL` written into each page at build time | Regenerated from the configuration by the page build; never edited by hand |
| Dashboard help | scripts/pages/src/dashboard.html:754 (public/dashboard.html:825) | "Contact us on X (@VicinityCitySOL)" | From configuration, hidden when unset |
| Terms of Use | scripts/pages/src/terms.html:45, 112, 166, 197 (public/terms.html:113, 180, 234, 265) | The contact clauses name the X account | A new Terms version approved by the owner (00-reconciliation.md OB-12, rebrand-inventory.md L07). The 2026-10-01 text stays at its versioned address. |
| Countdown site (vicinitycity.com) | countdown/public/index.html:7, 14, 19, 21, 34, 36, 57, 59, 133, 158; countdown/public/teaser.js:7, 27, 46, 251 | Follow buttons for the old account | History (rebrand-inventory.md section 3.6); it redirects at cutover (U11) |
| Tests | test/official-socials.test.js (lines 2-47), test/site.test.js:200, test/mobile-polish.test.js:76, test/api.test.js:35, test/hardening-coins.test.js:188-190, test/fixtures/launchlab/raymint.json | Assert the old account | Change with the code; new tests use format-only test fixture handles |

## 7. How `$VICINITY` is presented after the switch

- **Clearly labeled legacy:** "Legacy token: $VICINITY", with its mint for verification, the date it launched on Raydium
  LaunchLab (3 Oct 2026) and the team lock facts, all under a "Legacy" heading. It is never called the main token, the platform token
  or "the only official token".
- **No swap and no purchase:** no Buy button, no Buy-panel default, no Jupiter or DEX Screener purchase link, no price prompt to
  trade it, and no offer to swap it into the new token.
- **Holders keep their tokens.** Nothing is swapped, migrated, airdropped, burned or transferred on anyone's behalf. A member's own
  `$VICINITY` balance may be shown in their wallet view, labeled legacy, and they may still send it themselves.
- **History stays readable:** past balance samples, the old holder ranking (if kept), the Founding Supporters data and the legacy
  seat history are labeled historical and never authorize a new action (00-reconciliation.md section 7).
- **The link checker** names the legacy mint and the old X account as legacy, so a visitor is not told they are current.

## 8. When anything changes on the live site

Nothing changes on the live site until all of these are true:

1. the owner has supplied the mint, the X address and the Telegram address (any link may stay unset; it is then not shown);
2. each supplied value has a complete verification record (section 4), signed off by two people;
3. the code stage that adds the adapters and moves the consumers of sections 5 and 6 behind `MAIN_TOKEN_V5` is merged, with the
   switch off (implementation-report.md stage S02A);
4. a configuration pull request sets the values and turns `MAIN_TOKEN_V5` on, after `validatePolicy` and `validateDeploymentConfig`
   pass. Founder selection and manager ranking read the new mint only when their own switches go on (S17, S21, S61, S62).

Until then, the live site keeps today's behavior, including the legacy mint and the legacy X link.

## 9. Verification records

None yet. The owner has not supplied any of the three values. This section receives the records of section 4 when they exist.

## 10. Commands run for this file (24 October 2026, read-only)

- `git diff --stat 4aa408e` (no tracked file differs).
- `git grep -n` at `4aa408e` for: `VICINITY_MINT`; `activeMint(`; `2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray`; imports of
  `activeMint`, `withMint`, `officialFor`, `launchedAtOf`, `OFFICIAL`; `withMint(`, `officialFor(`, `launchedAtOf(`, `teamLocks`,
  `holderOrder`, `isTeamWallet(`; `kind: "vicinity"` and `"vicinity"` keys; `raydium.io`, `jup.ag/(swap|tokens)`,
  `dexscreener.com/solana`, `solscan.io/token`; `VICINITY` per page source and client script; `x.com/VicinityCitySOL`,
  `VicinityCitySOL`, `t.me/` and `telegram`.
- Independent check of the same day (amendment review): `git grep -c "activeMint("` per file under src/ (36 calls in 17 modules,
  each call site compared with sections 5.1 to 5.4, which added the cache keys at src/index.js:307 and 329 and
  src/cointakedown.js:106); `git grep -n VICINITY` over src/, public/ (pages, scripts and style sheets) and scripts/, compared line
  by line with the citations above; `git grep -l VICINITY_MINT -- test` (56 files); `git grep -i vicinitycitysol` (case-insensitive,
  which found the lower-case handle in test/fixtures/launchlab/raymint.json).
- `git show 4aa408e:<file>` reads of src/official.js, src/chain.js, src/index.js, src/ledger.js, src/store.js and
  scripts/pages/build.mjs at the cited lines.
- No RPC call, no network request, no transaction, no keypair and no secret. Nothing about the new mint was read, because no mint
  has been supplied.

## 11. Stage S02A implementation (local branch `cc/s02`, not merged, nothing deployed)

Built on 24 October 2026 on top of stage S02. No value was supplied: `MAIN_TOKEN_MINT`, `OFFICIAL_X_URL` and `OFFICIAL_TELEGRAM_URL`
stay unset, and `wrangler.jsonc` is unchanged. With `MAIN_TOKEN_V5` unset the site is today's: the built `public/` folder is byte
for byte the committed one, and a scratch sweep of the real Worker (public and signed-in API answers with every header, the static
asset fallback, the old-host and http redirects, two scheduled job runs, every D1 row and the D1 schema, every log line) gave the
same bytes for the reference tree `361cbe2` and this branch (implementation-report.md section 11).

| Piece | Where | With `MAIN_TOKEN_V5` on |
|---|---|---|
| The switch | src/flags.js `mainTokenV5On` | Exactly "on" (trimmed, any letter case); anything else is off |
| Adapters | src/maintoken.js `mainMint`, `officialLinks`, `mainTokenFeatures`, `checkDeploymentConfig`, `mainTokenStatus` | `mainMint` reads only `MAIN_TOKEN_MINT` through `mainTokenConfig` (never `VICINITY_MINT`, never a legacy or malformed mint); the configuration check runs at the first request of an isolate (src/index.js) and at each job start (src/jobs.js): off it reports nothing, on each named error is logged once per isolate as its code and key name only |
| One reader for every consumer | src/official.js `tokenMint(env)` | Off: exactly `activeMint(env)`. On: `mainMint(env)`, or `null`, and then each consumer takes its existing "not launched" path. Moved behind it: /api/token, /api/holders, /api/rank, /api/verify, /api/policy and /api/seats `launched`, the edge-cache keys (src/index.js, src/cointakedown.js), the coin page's allow-list (src/coin.js), /api/coins and the price allow-list (src/coins.js), the Launchpad's first card, its holder counts and the job's coin stats (src/launchpad.js), the price history (src/pricehistory.js), roles, seats, the dashboard and profiles (src/roles.js, src/seats.js, src/me.js, src/profiles.js), the portfolio and Send (src/portfolio.js, src/walletsend.js), the swap's token list (src/swap.js) and the balance sampler (src/ledger.js). The early-member flags (src/signup-finish.js, src/auth.js) and the legacy referral account (src/lpadmin.js) keep reading `VICINITY_MINT`: history and the legacy program. |
| `$VICINITY` facts | src/official.js `teamFor`, `withMint`, `officialAddresses`, `checkOfficial`; src/chain.js | The team wallets and the Jupiter Lock never label, unrank or set aside anyone in the new token's holder list (they still do in every other list); /api/official names the configured mint (`tokens[0]` "Main token", no venue), lists `teamWallets` and `teamLocks` empty, and carries `$VICINITY` with its team wallets and lock under `legacyTokens` (swap false) and the configured links under `officialLinks`; the link checker answers the legacy mint, the old X account and market links for the legacy mint as legacy (`verdict: "warning"`, `legacy: true`); the /official page lists a "Legacy" group; the holding badges read "main tokens", "Early member" keeps its history wording |
| Purchase links and the Buy panel default | src/swap.js `mainTokenRoute`, `mainTokenEntry`; src/launchpad.js `mainTokenLinks`; src/coin.js | The existing quote path (Jupiter lite `/swap/v1/quote`, 0.1 SOL into the mint, kept 5 minutes with a route, 1 minute without) decides: with a route the swap's list has the main token (`kind: "vicinity"`, decimals read from the chain, no symbol of `$VICINITY`'s) and the Launchpad card and coin page carry Jupiter, DEX Screener and Solscan links (never Raydium LaunchLab); without one there is no default, no Buy and no purchase link. `$VICINITY` gets no swap entry and no coin page. |
| Balance history | src/ledger.js `dayKey` | A series of the new token's own (`mday:<mint>:<day>` blobs), never summed with a `$VICINITY` day; no legacy hold streak is started, continued, ended or counted (`tenure` answers not qualified); its own old days are pruned; the `day:` series and the Founding Supporters data stay as history |
| Social links, one source | src/official.js `socialProfiles`; src/footer-social.js; scripts/pages/build.mjs | The page build and the Worker's response-time rewrite use the same functions, so a built page and a rewritten one are the same bytes; only configured, checked links are shown, an unset link is removed (the dashboard's "Contact us on X" item with it), and the old account is never shown as official. Today the Worker sees only the HTML it serves itself through its static-asset fallback (an address no file matches, so the 404 page): `run_worker_first` lists only `/api/*`, `/coin-meta/*` and `/official-coins.csv` (wrangler.jsonc). The other pages get their links from the page build, which reads `wrangler.jsonc`. |
| Admin and preflight | src/admin.js (`mainToken` in /api/admin/config); scripts/mainnet-preflight.mjs | Presence of the three settings and the check's error codes, never a value; both appear only once the switch or a setting is set |

Deliberately not done in S02A, and why:

- **The pages' and client scripts' own `$VICINITY` wording.** The token page copy (title, hero, FAQ, "Minting disabled", "60M team
  tokens locked", the founder amount), the client scripts' labels for `kind: "vicinity"` ("$VICINITY", "Buy $VICINITY", the
  Launchpad card's "Pair: $VICINITY / SOL"), the client-side purchase-link fallbacks (public/launchpad.js builds Raydium, Jupiter and
  DEX Screener links from any card's mint; public/token.js builds its four tiles from the contract) and the page sources of section 5.5
  live in `public/`. Changing them would change the live bytes with the switch off, and their new wording is the label migration of
  stage S48. Until then the page build refuses `MAIN_TOKEN_V5=on` in `wrangler.jsonc` (scripts/pages/build.mjs `pageSocials`), which
  enforces section 3's rule that the switch rolls out with the brand rollout or after it. A dashboard-only setting would bypass that
  check; the repository's rule is that switches change by a `wrangler.jsonc` pull request.
- **The Terms of Use contact clauses** that name the old X account: a new Terms version needs the owner's approval (section 6).
- **The on-chain name and symbol of the new token**: shown as "Main token" with no symbol until the verification record exists; no
  name is invented.
- **A mint column for `balance_samples`**: not added, so the D1 schema stays today's. The sampler's cadence still reads the table's
  last row; under the switch its shrink guard compares with the new token's own last sample instead.


**Stage S07 (same local branch, not merged, nothing deployed): the amendment in the public policy.** Behind the `PUBLIC_V5` switch,
and only while the v5 configuration check accepts the deployment (schema-and-api.md sections 2.2 and 4.9; src/v5policy.js), the
`master` key of `GET /api/policy` and `GET /api/policy/master` carry `main_token`, `legacy_tokens` and `official_links`:

- `main_token.mint` is the configured, shape-checked `MAIN_TOKEN_MINT` only while `MAIN_TOKEN_V5` is on, the moment the site's own
  consumers read it (section 4.3: the switch goes on only after the verification record exists); otherwise `null`. A value set ahead of
  the switch is checked but not announced. `verified` stays `null` until the verification record of section 9 is machine-readable,
  and `purchase_links` reads `"hidden"` until the existing quote path finds a route for the configured mint.
- `legacy_tokens` is the policy's block: `$VICINITY`, its legacy mint, history only, no automatic swap or migration.
- `official_links.x_url` and `telegram_url` follow the footer's rule (configured, checked, and only while `MAIN_TOKEN_V5` is on), `null`
  otherwise; `official_links.legacy.x_url` is always the old account.
- The configuration check names a malformed or legacy value even with every switch off (a set value is always shape-checked), and any
  such error keeps `PUBLIC_V5` off. While `MAIN_TOKEN_V5` is on, these three keys are reported by src/maintoken.js only, once.
