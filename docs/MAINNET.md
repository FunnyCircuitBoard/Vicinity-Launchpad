# Mainnet runbook: the in-app swap and the launchpad's curve trades

What has to be true, in which order, before people buy $VICINITY and city coins on vicinity.city itself (no Raydium page, no
Jupiter site: the page quotes, the Worker builds and checks, the person's own wallet signs). Everything below is read-only
until the two switches are flipped. `npm run mainnet:preflight` checks the settings, the chain and (with `--site`) the live
Worker and prints one PASS / WARN / FAIL row per check; the team runs it before and after every step that changes something.

Written on 9 October 2026 by the implementer of feat/swap. Nothing in this document was done on mainnet: the agent never
deploys to mainnet and never sends a mainnet transaction. Section 8 lists what only mainnet can prove.

## 1. What is on mainnet already, and what is not

| piece | state today | preflight row |
|---|---|---|
| $VICINITY (`2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray`, Raydium LaunchLab) | live since 3 Oct 2026; Jupiter routes it (0.01 SOL → about 152,000 $VICINITY on 9 Oct) | `$VICINITY mint on mainnet`, `Jupiter lite quote SOL → $VICINITY` |
| Jupiter Swap V2 (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`) | Jupiter's, live | `Jupiter program on mainnet`, `Jupiter keyed build SOL → $VICINITY` |
| Meteora DBC (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`) | Meteora's, live on both clusters | `Meteora DBC program` |
| the launchpad program `vicinity_launchpad` | **devnet only** (`Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7`, solana/LAUNCHPAD-DEVNET.md); nothing on mainnet, no mainnet address anywhere in the code | `LAUNCHPAD_PROGRAM_ID`, `launchpad program`, `upgrade authority`, `no mainnet launchpad address in the code` |
| the Meteora configs our program allow-lists | devnet only (two recorded) | `DBC config …`, `allow-list entry …` |
| the lookup table for curve trades | devnet only (`5tPTiz…`) | `LAUNCHPAD_LOOKUP_TABLE` |
| the dev wallet `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` | a constant compiled into the program; the fee claimer of every config; its referral accounts exist on devnet | `dev wallet`, `referral account …` |
| the website (Worker + pages) | deployed; `SWAP` and `LAUNCHPAD_TRADING` unset, so nothing of this exists on the live site yet | `site /api/official` |

So on day one **$VICINITY and every token Jupiter can route can be swapped in the app as soon as `SWAP=on`** (section 3).
City coins on their bonding curve need the launchpad program on mainnet first (section 4); until then their Buy opens the
same panel, the Worker asks Jupiter (which has no route for a coin still on a Meteora curve) and the page says "No market
can trade this pair right now." Nothing is built and nothing can be signed for such a coin until `LAUNCHPAD_TRADING` is on.

## 2. Settings (where each one lives: docs/DEPLOY.md "Where each setting lives")

| setting | value for mainnet | required for |
|---|---|---|
| `SWAP` | `on` | the panel and `/api/swap/*` (`off` or unset = hidden, 404, the old Raydium links and words stay) |
| `JUPITER_API_KEY` (Secret) | a key from portal.jup.ag (the Developer plan, 10 requests per second, is the one for a launch day) | builds (`/swap/v2/build`) on the plan's own allowance. Without it previews are keyless estimates and the Worker still builds on Jupiter's **anonymous** allowance (api.jup.ag answered a keyless build on 9 Oct 2026), which can end any day without notice: the key is required for a launch, not optional |
| `JUPITER_RPS` | the plan's requests per second (`10`) | the per-server token bucket: more than this per second becomes estimates, never errors |
| `JUPITER_API_BASE` | unset (= `https://api.jup.ag`); `JUPITER_LITE_BASE` unset (= `https://lite-api.jup.ag`) | |
| `SWAP_PLATFORM_FEE_BPS`, `SWAP_FEE_ACCOUNT` | unset = no platform fee (an owner decision; the page says "takes no fee") | a Jupiter platform fee to that token account |
| `SOLANA_RPC_URL` (Secret) | the provider's mainnet URL (Helius or similar) | every chain read, the simulations, the relay's `sendTransaction`, the status polls |
| `SOLANA_RPC_URL_BACKUP` (Secret, recommended) | a mainnet URL from a **different provider** (QuickNode, Alchemy, Triton, Syndica ...) whose plan allows `getProgramAccounts` on the SPL Token program; never the public RPC | asked only when `SOLANA_RPC_URL` refuses or fails (401/402/403/429/5xx, timeout, "max usage reached"); first for 60 s after the provider as a whole failed (key or credits refused, unreachable or too slow, 5xx, or three passing failures within 10 s). Never used if it is not a mainnet node (the Worker asks its genesis hash first). A signed transaction goes to it at most once, as the same bytes; a node's verdict (preflight failure) is never re-sent. Unset = one provider, as before. Added after the 10 Oct 2026 outage (src/rpcpool.js) |
| `RPC_TIMEOUT_MS` | `8000` | |
| `LAUNCHPAD_TRADING` | `on` only after section 4 | curve trades and `/api/launchpad/trade/*` |
| `LAUNCHPAD_CLUSTER` | `mainnet` | which chain the curve trades and their badges speak of |
| `LAUNCHPAD_PROGRAM_ID` | the owner's launchpad address (section 4, PR-1, set before his deploy) | REQUIRED on mainnet: no default exists, trading stays off without it |
| `LAUNCHPAD_REWARDS_PROGRAM_ID` | the owner's rewards address (section 4, PR-1) | REQUIRED for city coins: with `LAUNCHPAD_CLUSTER` and `LAUNCHPAD_PROGRAM_ID` set explicitly it opens the owner's City coins tab, `/api/lp/*` and `/coin-meta` (src/cluster.js `lpSetup`; the devnet defaults never count) |
| `LAUNCHPAD_DBC_CONFIGS` | the Meteora config the City coins tab's step 3 created, from the setup summary (section 4, PR-2) | REQUIRED on mainnet; approving, launching and graduating need it too |
| `LAUNCHPAD_LOOKUP_TABLE` | the speed table of the City coins tab's step 6 (PR-2) | optional for trades (legacy-sized without it, still under 1232 bytes); a launch with a first buy needs it |
| `LAUNCHPAD_RPC_URL` (Secret) | unset = `SOLANA_RPC_URL` | the first node of the curve trades and of every city-coin read and simulation (src/lptrade.js, src/lpkit.js `lpRoute`), with `SOLANA_RPC_URL_BACKUP` behind it on mainnet, all through src/rpcpool.js (never a fetch of their own). Every build first checks the first node's genesis hash; when only the backup answered that check, the build reads, takes its blockhash and simulates on the backup alone, never on the unchecked first node. A city-coin step is sent by the wallet itself when it can send (Phantom: through its own node, so no relay log line appears), or by the relay's `sendTransaction` for a wallet that only signs; that relay send and the status polls of every step use `SOLANA_RPC_URL` then the backup, like the swap; a relay send whose outcome is unclear answers `unclear: true` and the page watches the wallet's signature |

Fixed in code and asserted at module load (src/sol/pda.js, src/lptrade.js): Meteora's programs and authorities, the dev wallet
(= the program constant `FEE_RECIPIENT` = the first published team wallet), Jupiter's program. The launchpad's global account
is the derived PDA `["launchpad"]` under the program id, never a setting.

The switches are read per request: flipping one in the Cloudflare dashboard applies to the next request; a deploy keeps
dashboard variables (`keep_vars`). Put the public ones in `wrangler.jsonc` through a pull request like the other switches.

## 3. Day one: $VICINITY and Jupiter swaps (no program deploy needed)

Who: the owner (secrets), one developer (pull request, smoke test). About an hour.

0. Before anything: a lawyer reads the Terms of Use wording for an in-app swap (today they describe trading "through
   third-party protocols"; the panel executes on Jupiter's route in the person's own wallet, Vicinity never custodies).
   Jupiter's SDK & API License Agreement was NOT reviewed here; the site keeps "Powered by Jupiter" under every Jupiter number.
1. Secrets in Cloudflare: `SOLANA_RPC_URL` (set already), `SOLANA_RPC_URL_BACKUP` (recommended: another provider, see the table above), `JUPITER_API_KEY` (new). Variables: `JUPITER_RPS=10`, `RPC_TIMEOUT_MS=8000`.
2. On your machine, with the secrets exported in the shell. Type them in with `read -rs NAME && export NAME` (paste, Enter: nothing
   is shown, nothing lands in the shell history or the process list), for `JUPITER_API_KEY`, `SOLANA_RPC_URL` and
   `SOLANA_RPC_URL_BACKUP`; never paste a key into `wrangler.jsonc`, a pull request, an issue or a chat. Then:
   `JUPITER_RPS=10 npm run mainnet:preflight -- --set SWAP=on --site https://vicinity.city`
   Every row but the launchpad ones must PASS (those WARN while `LAUNCHPAD_TRADING` is off). `Jupiter build SOL → $VICINITY`
   asks Jupiter for the build the Worker would ask for (0.01 SOL, the dev wallet as taker; with the platform fee when one is
   set) and runs it through the Worker's own validator: a layout Jupiter changed fails here first, before anyone presses
   Swap. The row runs with or without the key (keyless it can only WARN: the anonymous allowance is not a plan).
3. Deploy with `SWAP=on` (pull request). What changes on the site, all behind this one switch:
   * `/token`: the "Buy on Raydium" tile becomes "Buy here" and scrolls to the Buy panel under the contract address; the FAQ's
     third step says the same; Solscan and Chart tiles stay.
   * the dashboard's Buy & swap card holds the live panel for $VICINITY, the city coin and the swap route (the old price-ratio
     estimate and the jup.ag / raydium.io buttons go);
   * `/coin` and the Launchpad cards: every Buy opens the panel as a sheet over the page;
   * the home page's "Buy on Raydium" step and FAQ say "Buy here … routed by Jupiter, executed on Raydium LaunchLab";
   * `/api/launchpad` and `/api/coin` carry `links.here`; `/api/official` carries `swap: true`.
   With `SWAP` off nothing of it exists: the real-Worker harness proves both states (mode `all` and mode `noswap`).
4. Watch the first hour: Cloudflare → Workers → Logs, filter `jupiter_busy` (the bucket or the plan is too small: raise
   `JUPITER_RPS` or the plan), `jupiter build refused` (Jupiter changed a layout: swaps answer `jupiter_refused` until
   src/jupswap.js learns it), `relay send refused`, `swap would fail`. Each log line is a short code, never a wallet or a key.
5. Smoke test with the owner's wallet: 0.01 SOL → $VICINITY on `/token`, on a computer and on a phone inside Phantom. Check:
   the quote names the route ("Routed by Jupiter · executed on Raydium Launchlab"), "Confirm in your wallet", "Swapped ✓ …",
   the Solscan link, the balance refresh, "Swap again". Then the same trade cancelled in the wallet ("Cancelled in your wallet.
   Nothing was sent.").
6. WAF rules for the new routes (docs/DEPLOY.md "Attempt limits"): the code limits apply already; the WAF rows are the second line.
7. Rollback: `SWAP=off` (next request) or Cloudflare's Rollback to the previous deployment. Nothing of the swap keeps state.

## 4. City coins on mainnet: the two programs (NOT done; the owner does it, step by step, with docs/OWNER-LAUNCH-GUIDE.md)

The owner deploys both programs from his Mac with Solana CLI 4.3.0 and does everything after that on vicinity.city, signed
in Phantom (the admin "City coins" tab, owner only). There is no Node and no git on his Mac, no keeper server and no
`setup.mjs` on mainnet: those scripts stay devnet-only. The team builds the two files, changes settings by pull request
(the owner approves), and checks every step read-only. This section is the summary; the guide has every command and screen.

The order is fixed. `init_registry` and `init_launchpad` must be signed by the CURRENT upgrade authority (the programs check
ProgramData), so both programs start under a key that can sign on the website (the owner's Phantom) and move to the Squads
vault only after that. (The earlier version of this section handed the upgrade authority to the vault right after the
deploy and initialised afterwards: that order could not work.)

| # | who, where | what | read-only check |
|---|---|---|---|
| 0 | team | blockers before the FIRST APPROVAL (not before the deploy): the outside audit of `vicinity_launchpad`; the live site serves `/coin-meta/<mint>.json` and `/brand/vicinity-512.png` (the URI in each coin can never change); a lawyer's stock-token country list (pay-with-anything only); the Jupiter key (section 3) | `--site`: `site /coin-meta`, `site /brand/vicinity-512.png` |
| 1 | owner, Mac (guide steps 1 to 5) | CLI 4.3.0; five key files (deployer, launchpad-program, rewards-program, two buffers); his own RPC on a paid, staked plan (Helius Developer: `--use-rpc` sends every upload through it, and a free plan's 1 sendTransaction per second turns step 8 into hours of `Blockhash expired` rounds, measured on devnet behind a 1-per-second limiter); the three Squads member addresses written down (the multisig itself is made in step 11, paid by what step 10 returns). Sends ONLY the three public addresses (deployer, launchpad, rewards) | |
| 2 | team | PR-1: `LAUNCHPAD_CLUSTER=mainnet`, `LAUNCHPAD_PROGRAM_ID`, `LAUNCHPAD_REWARDS_PROGRAM_ID` (the owner approves). Effect: only the owner's City coins tab appears; the public site does not change (trading needs PR-2). And `bash solana/scripts/launchpad/build-mainnet.sh <launchpad> <rewards>`: the two `.so` files, `SHA256SUMS` and `build-record.json`, sent to the owner with the fingerprints in the message | the script itself: the audited bytes reproduce first, then only the ids change |
| 3 | owner, Mac (guide steps 6 to 9) | `shasum -a 256 -c SHA256SUMS`; `solana config set --url <his RPC> --keypair deployer.json`; 4.9 SOL to the deployer (the deploy command checks up front that it could pay the highest possible fee on top of the rent: 0.039685 SOL for the rewards file and 0.034135 SOL for the launchpad file at `--with-compute-unit-price 50000`, 0.150775 and 0.129685 at 200000, measured on devnet with CLI 4.3.0 and an empty payer; each deploy really spends about 0.003 SOL); `solana program deploy <file> --program-id <program>.json --buffer <buffer>.json --use-rpc --with-compute-unit-price 50000 --max-sign-attempts 100`, rewards first, then the launchpad (a failed deploy resumes when the same command runs again, but only after `solana program show <id>` says the program is not there yet: a re-run of a deploy that landed is an upgrade and needs a second buffer's rent); `solana program show` and `solana program dump` + `shasum` | `npm run mainnet:preflight -- --cluster mainnet --build-record build-record.json`: `launchpad program`, `rewards program deployed`, both fingerprints PASS (the global account and the registry FAIL until step 5, as they should) |
| 4 | owner, Mac (guide step 10) | `solana program set-upgrade-authority <id> --new-upgrade-authority 13qRam… --skip-new-upgrade-authority-signer-check` for both; leftover buffers closed; `solana transfer 13qRam… ALL` | `solana program show`: `Authority: 13qRam…` |
| 5 | owner, app.squads.so then website (guide steps 11 and 12), the same sitting | the Squads v4 multisig, 2 of 3, no config authority (0.1 SOL Squads fee plus about 0.003 SOL of accounts); then City coins steps 1 to 7, one Phantom signature each: 1 `init_registry` + `init_launchpad` in one transaction (the owner's wallet becomes the launchpad admin, the registry admin and later each city's rewards authority); 2 two unchecked loader `SetAuthority` instructions to the vault of the pasted multisig (the Worker reads the multisig, refuses a vault, a wallet, a 1-of-N or a controlled multisig, derives vault 0 and shows it for the owner to compare with the Squads app); 3 the Meteora config (a browser key; the Worker compares it byte for byte with the defaults); 4 the allow-list entry; 5 the dev wallet's fee accounts (they exist on mainnet already); 6 the speed table; 7 the partner name (dev wallet only) | each step re-reads the chain before it is offered |
| 6 | owner, website (guide step 13) | step 8: "Send this to the team" (the C5 summary: public addresses and signatures only) | |
| 7 | team | `npm run mainnet:preflight -- --cluster mainnet --setup summary.json --build-record build-record.json --expect-admin 13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` (add `--expect-upgrade-authority <vault>` when the vault is known from the owner independently; otherwise the vault of the summary's multisig, decoded from the chain, is the expectation). No FAIL allowed. Before PR-2 the `setup summary vs settings` row WARNs and prints the exact `LAUNCHPAD_DBC_CONFIGS` and `LAUNCHPAD_LOOKUP_TABLE` values for PR-2 | every row of section 5 marked "setup", the rewards rows, both admins, both fingerprints |
| 8 | team | PR-2: `LAUNCHPAD_DBC_CONFIGS`, `LAUNCHPAD_LOOKUP_TABLE`, `LAUNCHPAD_TRADING=on` (the owner approves) | |
| 9 | team | after the deploy of PR-2: the same preflight plus `--site https://vicinity.city`: `setup summary vs settings` PASS, `LAUNCHPAD_TRADING` PASS, `site /coin-meta`, `site /brand/vicinity-512.png`, `site city-coin routes` PASS | |
| 10 | owner, website (guide step 14) | the first approval (the card shows the name, ticker, founder, description and logo; the build is refused when the design changed since the page loaded; the design is frozen from the build on) (City coins → Approve a city coin); the founder launches from the dashboard's Founder tab. Smoke: buy 0.01 SOL of that coin on `/coin`, then sell it back, and compare both with the quote on Solscan to the raw unit (the devnet rehearsal of exactly this: solana/LAUNCHPAD-DEVNET.md section 10) | |

No keeper: graduation is a button on `/coin` that anyone can press when a curve is full (the payer plus two one-time browser
keys), and collecting fees, holder rewards set-up, forwarding, platform fees and pause are buttons in the City coins tab
(LAUNCHPAD.md section 7 describes the keeper they replace). Rollback: `LAUNCHPAD_TRADING=off` stops the curve trade routes at
the next request; "Pause launches" in the City coins tab stops new launches; trades on existing curves cannot be stopped
(Meteora's program is permissionless) and the panel then only says so.

Not done here on purpose (noted for the auditors): no Docker `anchor build --verifiable` (no Docker on the build machine;
`build-mainnet.sh` instead proves the audited bytes reproduce with the pinned cargo-build-sbf 4.4.0 and platform-tools
v1.57, and that the mainnet binaries differ from them only in the id bytes); no `security.txt` (it would change the audited
bytes); `anchor keys sync` never runs (the repository keeps the devnet ids). Moving the launchpad admin and the registry
admin from the owner's Phantom to the Squads vault (`propose_admin` in Phantom, `accept_admin` through the Squads app) is
possible at any time and not part of the launch.

## 5. The preflight, row by row (`scripts/mainnet-preflight.mjs`, read-only, Node 22, no dependencies)

```
npm run mainnet:preflight -- [--cluster devnet|mainnet] [--set KEY=VALUE]… [--rpc <url>] [--site https://vicinity.city]
                             [--expect-upgrade-authority <address>] [--expect-admin <address>] [--check-limits]
                             [--setup <summary.json>] [--build-record <build-record.json>]
                             [--expect-sha256-launchpad <hex>] [--expect-sha256-rewards <hex>]
```

`--setup` takes the City coins tab's "Send this to the team" box (bare, or the `{ ok, summary }` of `/api/admin/lp/summary`).
A launchpad setting that is set must agree with it; one that is not set yet (before PR-2) is taken from it for this run, and
the `setup summary vs settings` row says so and prints the values. `--build-record` takes build-mainnet.sh's
`build-record.json` (both programs' size and SHA-256); the `--expect-sha256-*` flags give one fingerprint each. The program
rows run as soon as `LAUNCHPAD_PROGRAM_ID` is set (right after the deploy, before any config exists).

Settings come from `wrangler.jsonc` vars, then the shell (export the secrets for the run), then `--set`. Exit code 1 on any
FAIL. No key is printed (the Jupiter key goes out as a request header, exactly as the Worker sends it). Nothing is sent:
every call is a GET or a JSON-RPC read; `--check-limits` posts invalid bodies that are counted and refused before any work.

| row | PASS when | otherwise |
|---|---|---|
| `SWAP`, `LAUNCHPAD_TRADING` | on (and, for trading, the cluster settings complete) | WARN off; FAIL on with settings missing |
| `LAUNCHPAD_CLUSTER` | mainnet | WARN devnet while trading is on: test coins only |
| `VICINITY_MINT`, `SOLANA_RPC_URL`, `RPC_TIMEOUT_MS` | set | FAIL / FAIL / WARN |
| `SOLANA_RPC_URL_BACKUP` | set to another provider (by its domain; the key is never printed) that answers the mainnet genesis and one `getProgramAccounts` of the $VICINITY token accounts without their data | WARN unset, the public RPC, or the same provider as `SOLANA_RPC_URL`; FAIL not mainnet, no answer, or `getProgramAccounts` refused |
| `site /api/health`, `site /api/official`, `site security headers / and /api/health`, `site cron alive` (`--site`) | 200; the switches as set here and the mint; CSP self-only + HSTS + nosniff + no framing; a balance sample under 25 minutes old | WARN when the site's switches differ from the settings here (dashboard vs wrangler.jsonc); FAIL on missing headers or a cron that never ran |
| `site /api/swap/config`, `site live quote SOL → $VICINITY`, `site attempt limit /api/swap/quote` (`--site`, the site's swap on) | mainnet, keyed; 0.01 SOL quoted with its source and latency; the 181st quote of one connection is 429 (`--check-limits`; the number comes from src/guards.js) | WARN keyless / Jupiter busy; FAIL no 429 |
| `JUPITER_API_KEY`, `JUPITER_RPS`, `SWAP_PLATFORM_FEE_BPS / SWAP_FEE_ACCOUNT` | key set; rate above 1; a fee only with a valid account | WARN (keyless builds run on the anonymous allowance) / WARN / FAIL (a fee with no account) |
| `Jupiter lite quote SOL → $VICINITY` | the keyless quote answers with a route | FAIL: nobody can buy $VICINITY today |
| `Jupiter build SOL → $VICINITY` (always) | `/swap/v2/build` answers 200 for the dev wallet (with the platform fee when set) AND the Worker's validator accepts it, with the key | WARN keyless (works on the anonymous allowance today, may stop) or 429; FAIL refused by the key, or by the validator (with or without a key) |
| `mainnet RPC answers`, `mainnet RPC health`, `$VICINITY mint on mainnet`, `Jupiter program on mainnet` | mainnet genesis; getHealth ok and two accounts under 1.5 s; 6 decimals, no mint or freeze authority; executable | FAIL / WARN slow / WARN authority / FAIL |
| `no mainnet launchpad address in the code` | the mainnet defaults of src/cluster.js are null, [] and null (computed, not a literal) | FAIL: an address crept into the code |
| `LAUNCHPAD_RPC_URL`, `LAUNCHPAD_PROGRAM_ID`, `LAUNCHPAD_DBC_CONFIGS` | set or defaulted (devnet); on mainnet the id and configs REQUIRED | WARN public RPC; FAIL missing |
| `launchpad RPC cluster`, `launchpad RPC health` | the cluster it should be; getHealth ok and the configs under 1.5 s | FAIL / WARN |
| `launchpad program` | executable, owned by the upgradeable loader | FAIL |
| `upgrade authority`, `rewards upgrade authority` | = `--expect-upgrade-authority`, or else the vault of the setup summary's Squads multisig (decoded from the chain); immutable also PASS | FAIL a different key; on mainnet FAIL a plain wallet even when it is the expected one, and FAIL whenever there is no expectation (a vault or program address cannot pass by accident); WARN on devnet |
| `launchpad program fingerprint`, `rewards program fingerprint` (with `--build-record` / `--expect-sha256-*`, or always on mainnet) | SHA-256 of ProgramData from byte 45 (what `solana program dump` writes; zero padding after the recorded size is ignored) = the build record | FAIL a different binary or a record for another program id; WARN on mainnet without an expectation (the fingerprint is printed) |
| `Meteora DBC program` | executable on the cluster | FAIL |
| `launchpad global account`, `launchpad admin`, `rewards program` | initialised, not paused; admin = `--expect-admin` (a plain wallet passes when it is the expected one: the owner's Phantom, by decision); the rewards program the launchpad was started with = `LAUNCHPAD_REWARDS_PROGRAM_ID` | FAIL not initialised; WARN paused; FAIL a different admin, or on mainnet any admin while `--expect-admin` is missing; FAIL no rewards program or another one than the setting |
| `rewards program deployed`, `rewards registry`, `registry admin` | executable and upgradeable; the registry exists; its admin = `--expect-admin` | FAIL (the City coins tab's step 1 starts the registry); the admin as for the launchpad |
| `LAUNCHPAD_REWARDS_PROGRAM_ID`, `city coins gate` | set, a valid address, not the launchpad's, not the devnet one on mainnet; the gate on (cluster, program and rewards ids explicit) | FAIL on mainnet when missing; WARN on devnet; the gate row only WARNs (the settings rows say what is missing) |
| `DBC config <id>` | Meteora's; fee claimer and leftover receiver = the dev wallet; 125 bps; creator share 50 %; pool creation fee under the cap | FAIL; WARN a SOL config not graduating at 85 SOL on mainnet |
| `allow-list entry <id>` | an enabled LaunchConfig under our program for that config | FAIL (the City coins tab's step 4; setup.mjs add-config on devnet) |
| `referral account <quote>` | the dev wallet's token account for the quote mint exists | WARN (the next trade recreates it and THAT TRADER pays about 0.002 SOL that is not returned; the quote and the panel say so; the claim script must stop closing it) |
| `LAUNCHPAD_LOOKUP_TABLE` | a table holding the nine addresses a trade needs | WARN some missing or unset; FAIL not a table |
| `speed table for city coins` | the table holds every address the website's launch, graduation and fee transactions share (src/sol/lpadmin-ix.js `lookupTableAddresses`) | WARN some missing (a launch with a first buy may not fit); FAIL deactivated |
| `setup summary`, `setup summary vs settings` (`--setup`) | the box parses; every launchpad setting equals it | FAIL not a summary; FAIL a setting that differs (both values named); WARN settings taken from the summary (before PR-2: the row prints them) |
| `setup Squads multisig`, `setup Squads vault` | a Squads v4 multisig (2 or more approvals, no config authority, enough voters) whose vault 0 is the summary's vault; `--expect-upgrade-authority`, when given, is that vault | FAIL (a pasted vault or wallet, a 1-of-N or controlled multisig, another vault) |
| `setup price curve`, `setup allow-list entry`, `setup speed table` | the config is byte for byte what Meteora writes for Vicinity's defaults (85 SOL, 1.25 %, 0.05 SOL, fees to the dev wallet) and in `LAUNCHPAD_DBC_CONFIGS`; its allow-list entry is the summary's and enabled; the table is `LAUNCHPAD_LOOKUP_TABLE`, active, and holds both | FAIL (on devnet a differing curve only WARNs) |
| `setup admin`, `setup fee accounts`, `setup partner metadata`, `setup signatures` | the summary's admins are the chain's (and `--expect-admin`); the dev wallet's SOL and $VICINITY accounts are the derived ones and exist; Meteora's partner record exists; every setup signature landed without error | FAIL a different address or a failed transaction; WARN an account or a signature not found, no partner record (step 7, not a blocker) |
| `site /coin-meta`, `site /brand/vicinity-512.png`, `site city-coin routes` (`--site`) | an unknown coin answers 404 JSON with `Access-Control-Allow-Origin: *`; the logo 200 `image/png`; `/api/lp/launch/status` answers the probe on the same cluster and 401 for a signed-out city | FAIL while the city coins are on in the settings checked here (WARN while off); FAIL the site off while on here, another cluster, or not 401 |
| `dev wallet` | in `ADMIN_WALLETS` | WARN |

Recorded runs on 9 October 2026, after the review fixes (the logs are in the fixer's report). The shell had `SOLANA_RPC_URL`
and `RPC_TIMEOUT_MS=8000` exported and no Jupiter key (the counts move with what the shell exports: without the RPC secret the
`SOLANA_RPC_URL` row FAILs and the mainnet reads use the public RPC):

* devnet settings, `--expect-upgrade-authority` and `--expect-admin` = the devnet deployer: **35 rows, 31 pass, 4 warn, 0 fail**
  (the warnings: no Jupiter key in that shell, so the `Jupiter build` row is keyless, which it says; `JUPITER_RPS` at its
  default; `LAUNCHPAD_CLUSTER` devnet; the dev wallet not in that shell's `ADMIN_WALLETS`). The keyless build answered in
  248 ms with today's Raydium Launchlab route and the validator accepted it;
* mainnet settings with no program deployed: **20 rows, 14 pass, 3 warn, 3 fail** (`LAUNCHPAD_TRADING`, `LAUNCHPAD_PROGRAM_ID`,
  `LAUNCHPAD_DBC_CONFIGS`): the program rows fail cleanly and nothing else is skipped; the mint, the Jupiter program and the
  lite quote (0.01 SOL → 152,320.805136 $VICINITY) read from mainnet;
* `--site https://vicinity.city` (today's live site, switches off): **41 rows, 33 pass, 8 warn, 0 fail**: health, `/api/official`
  (swap off, launchpadTrading off, the mint), the security headers on `/` and `/api/health`, the cron all PASS; the swap rows
  are skipped with a WARN because the site's swap is off.

These runs used `--rpc https://api.mainnet-beta.solana.com` (the public node; the provider URL is a Cloudflare Secret and was not
in that shell) and no `JUPITER_API_KEY`. The team's own runs with both exported will show `SOLANA_RPC_URL` set and the build row
keyed (PASS instead of WARN).

Recorded on 10 October 2026, after the city-coin rows were added (same shell):

* `--site https://vicinity.city` (today's live site, nothing of the city coins deployed): **52 rows, 38 pass, 14 warn, 0 fail**;
  `site /coin-meta` and `site /brand/vicinity-512.png` WARN (the live Worker does not serve them yet: they must PASS before the
  first approval), `site city-coin routes` PASS ("off on the site, as the settings here say");
* `--cluster mainnet` with no program: **22 rows, 13 pass, 6 warn, 3 fail** (`LAUNCHPAD_PROGRAM_ID`, `LAUNCHPAD_DBC_CONFIGS`,
  `LAUNCHPAD_REWARDS_PROGRAM_ID`);
* against devnet with explicit settings, a devnet setup summary, `--expect-admin` the devnet deployer and the audited
  fingerprints, `--site` a local `wrangler dev` with the gate on: **60 rows, 47 pass, 11 warn, 2 fail**. Both fingerprints were
  read from devnet's ProgramData and equal the audited `8706e3bf…27f0` and `f0fbc9d5…09a3`; `site /coin-meta`,
  `site /brand/vicinity-512.png` and `site city-coin routes` PASS. The two FAILs are expected there: `setup Squads multisig`
  (devnet has no Squads hand-over) and `site cron alive` (no cron in `wrangler dev`). The same Worker with the production
  variables answered `/api/lp/launch/status` 404, which the row reads as "off, as the settings here say".

## 6. Costs (estimates; nothing of section 4 was run on mainnet)

* Jupiter swaps: the person pays the network fee (5,000 lamports per signature), the priority fee Jupiter suggests (the Worker
  caps it at 0.01 SOL; the panel's fee line says "priority ≤ X SOL" with the quote and the exact "priority X SOL" once the
  transaction is built), and once per new token account of theirs 2,039,280 lamports of rent (returned when they close the
  account; the panel's "Account rent" row says so when the wallet has no account for the token yet). Vicinity takes no fee
  unless `SWAP_PLATFORM_FEE_BPS` is set; when it is, the quote's fee line and the panel's footer say the percentage.
  Jupiter's Developer plan price ($25 per month, 10 requests per second) is the owner's figure from portal.jup.ag, not
  verified here.
* Curve trades: the curve's 125 bps (100 bps to Meteora's fee claimer = the dev wallet, split by the program into city, holders,
  founder and dev as LAUNCHPAD.md describes; 25 bps referral), the network fee, 55,000 to 73,000 compute units (devnet runs),
  and, whenever the dev wallet has closed its referral account (it does so when it unwraps SOL), about 0.002 SOL of rent paid
  by the NEXT trader to re-create it, which is not returned to them: the quote carries `fees.referralRentLamports` and
  `referralNote`, the panel shows it in the "Account rent" row, and the preflight's `referral account` row WARNs. The fix is
  operational: keep that account open (do not close it in claim-platform-fees).
* The launchpad and rewards programs on mainnet (docs/OWNER-LAUNCH-GUIDE.md, "Costs"): rent 2.20539564 + 2.57066796 +
  2 × 0.00083312 = 4.77772984 SOL (read from mainnet with `solana rent` on 10 Oct 2026; CLI 4.3 sizes each program to its
  binary), about 0.006 SOL of deploy fees; the owner sends 4.9 SOL to the deployer (the CLI's up-front fee check needs it, see the guide's step 7) and gets about 0.12 back. The Squads multisig
  about 0.103 SOL (Squads' one-time 0.1 SOL fee). The website setup from Phantom about 0.02 SOL. In all about 4.91 SOL; the owner starts with 5.0 in Phantom. No keeper: whoever presses "Move to the open market" pays about 0.03 SOL. Per launch the founder
  pays the config's launch fee plus about 0.0312 SOL of rent (0.0812 SOL with the mainnet defaults). The Helius plan, the
  audit quote.
* The Worker, per trade: one Jupiter build per (wallet, pair, amount, slippage) per 12 s (keyless quotes are shared the same
  way), one simulation per built transaction, one `sendTransaction` per relayed trade (wallets that cannot send themselves),
  one `getSignatureStatuses` per 2 s per watching page, a balance read per wallet per 10 s. Limits in src/guards.js and
  docs/DEPLOY.md.

## 7. Launch-day load check (the harness, fakes for Jupiter and the chain; the Worker is real)

`all-e2e/load-swap.cjs` on port 9348, mode `all` (SWAP on, keyed Jupiter, `JUPITER_RPS=10`), measured on 9 October 2026 after
the review fixes (15 of 15 checks):

| phase | result |
|---|---|
| 200 quotes in 10 s from 10 connections, 20 distinct keys | 200 × 200, p50 13 ms, p95 17 ms; 20 Jupiter builds (one per key), never more than 2 × `JUPITER_RPS` in one second; the overflow at the peak answered as estimates, never errors |
| one connection, 190 quotes in 4 s | 180 × 200 then 10 × 429 `slow_down` with Retry-After (the limit a dozen phones behind one carrier address need) |
| 50 quote + tx pairs in 5 s | 50 builds for the quotes, NOT ONE more for the transactions (each reuses its quote's build, so none of them needs a token from the budget); every tx simulated once, ≤ 1232 bytes, version 0; p95 23 ms |
| 50 relayed sends, each with its ticket | 50 signatures back, p95 18 ms (without the ticket every one is refused `bad_ticket` before any node is asked: that is what the reviewer's open-relay probe now gets) |
| 450 status polls in 6 s over 50 signatures | 450 × 200 (9 per signature under the 60 per minute per signature, 45 per connection, under the per-connection brake: 600 then, 120 since 10 Oct 2026), pending → confirmed → finalized |
| outbound | nothing reached the internet |

The journeys that prove the page side (`all-e2e/scenarios/swap.cjs`, 61 checks, and `scenarios/swap-fix.cjs`, 41 checks, both
9 October 2026 on the same harness): a build worse than the preview stops with "The price moved" and the wallet never opens, the
second press signs exactly the shown numbers; the fee and rent lines; a refused status poll reads "Still checking…" and ends as
Swapped once the minute passes (the Worker's clock moved by the harness); the relay refuses a foreign transaction; 320 px keeps
the whole figure; one live panel per sheet; the Jupiter tiles are information links; mode `noswap` has none of it.

Real Jupiter and provider latency are not in these numbers (section 8).

## 8. Robustness tightened for production (each with a test)

* Every outbound call has a timeout and a plain code: Jupiter 6 s (`jupiter_unavailable` / `jupiter_busy` with Retry-After
  honoured up to 60 s), the RPC 8 s (`rpc_unavailable` / `rpc_busy`), Google's token endpoint 8 s (`login_unavailable`, no
  longer `login_failed` for a stuck Google), Resend 8 s (`email_unavailable`).
* The 10-minute job takes a lease (`settings.job_lease`, one atomic conditional upsert): two overlapping firings never sample
  or advance seats twice; a crashed run's lease expires after 8 minutes.
* D1 indexes on `sessions`, `pairs` and `handoffs` `expires_at` (the cleanup deletes by them), as a repeatable migration that
  touches no data.
* The edge cache is a convenience: a `cache.match` or `cache.put` that throws is a miss, never a 500.
* Jupiter builds and keyless quotes are kept 12 s per key with one in-flight call per key (no stampede); lookup tables 10 min
  (a table whose deactivation began is refused); a failed Jupiter call is never kept and a negative cache (5 s, or Retry-After)
  stops a flood of retries, PER HOST: a 429 on the keyed build host turns previews into lite estimates and pauses builds, it
  never blocks the lite quotes, and the other way round. `/tx` takes from the same per-server budget (`JUPITER_RPS`) as the
  previews when its build is not cached: no visitor can make the Worker build unmetered.
* Every `/api/swap/*` and `/api/launchpad/trade/*` route is Origin-checked, counted before the work (per connection, and per
  wallet for both `/tx` routes), answers `{ ok: false, error: <code> }`, and simulates before the wallet opens so slippage,
  missing SOL and program errors are plain words, not a wallet warning. The status poll is counted per SIGNATURE (60 a minute)
  before the connection's own brake (600), so phones behind one carrier address never use up each other's polls; a refused poll
  makes the page say "Still checking…" and wait for Retry-After, and never "didn't include it in time".
* The page signs what it shows: the `/tx` answer carries the quote of the very build (`quote`) and the panel replaces its
  preview with it before the wallet opens; a build that came out worse (more than 0.5 % less out, a lower minimum, or the
  price impact crossing 3 % or 10 %) stops with "The price moved… press again" and the 10 % checkbox is judged on it; the
  "Swapped ✓" line prints the signed build's amounts. The preview's `quoteId` is informational.
* The relay (`/api/swap/send`) forwards only what this Worker built: `/tx` and `/trade/tx` return a `ticket` (an HMAC over the
  message bytes, 10 minutes, keyed by the limits salt) and the relay refuses a signed transaction without it (`bad_ticket`),
  as well as anything with more than one signer. A wallet that rewrites the message it signs (none of Phantom, Solflare or
  Backpack does for a one-signer transaction that already carries a compute budget) would be refused the same way.
* `cluster=devnet` on the relay routes is honoured only while `LAUNCHPAD_TRADING` is on; the fee-recipient check of
  src/lptrade.js no longer throws at import time (a mismatch answers 503 `misconfigured` on the trade routes only).
* CI runs the tests with `--unhandled-rejections=strict`; `ctx.waitUntil` work and in-flight cache promises carry a `.catch`.
* `/api/swap/config` exposes booleans about secrets only; the preflight prints no secret; logs carry short codes only.

## 9. What the agent could not verify (only mainnet, or the owner's accounts, can)

* That Jupiter's keyed `/swap/v2/build` answers for YOUR key and plan: the harness and the tests used Jupiter's recorded
  9 October answers (rewritten for the asking wallet); no key was on this machine. The preflight's `Jupiter keyed build` row
  is the check, run it with the key exported.
* A real mainnet swap end to end (the agent never sends a mainnet transaction): the same code path was run on devnet for the
  curve (solana/LAUNCHPAD-DEVNET.md section 10, three runs, exact to the raw unit) and in Chromium against the fake chain
  for Jupiter. The live mainnet reads that were done: Jupiter's keyless quote for SOL → $VICINITY through the Worker's own
  route, the mint's facts, the programs' accounts.
* The launchpad program on mainnet, its configs, its lookup table, the multisig: none exist yet (section 4). The preflight
  refuses to pass without them.
* Phantom's, Solflare's and Backpack's real `signAndSendTransaction` on a version-0 transaction with a lookup table, and their
  behaviour when asked for `solana:devnet` inside their in-app browsers: the Wallet Standard calls are exercised with a fake
  wallet that signs with a real Ed25519 key; a real wallet's confirmation screen is not.
* Real latency of the provider RPC and of Jupiter under load (the harness measured the Worker with fakes: quotes p95 15 ms).
* The Workers plan of the owner's account, the Helius plan's limits, and Jupiter's SDK & API License Agreement (its
  attribution clause was not read; the site keeps "Powered by Jupiter" under every Jupiter number and names where each trade
  executes).
* Jupiter's keyless `lite-api` is being retired ("no longer actively maintained"): the estimates path depends on it until the
  key is set; with the key, every quote for a connected wallet is a real build. Keyless builds (api.jup.ag's anonymous
  allowance) worked on 9 October 2026; nothing says they will tomorrow.
* The platform-fee layout of a Jupiter build (`SWAP_PLATFORM_FEE_BPS` on): the validator insists that the swap's optional
  account is `SWAP_FEE_ACCOUNT` and refuses `shared_accounts_route_v2` builds with a fee (the fee account's place in that
  layout was never recorded from a real answer). This was tested against the fake only; before flipping the fee on, run the
  preflight with the fee settings exported: its `Jupiter build` row asks Jupiter for a fee-on build and runs the validator.
* That Phantom, Solflare and Backpack return the message unchanged from `signTransaction` (the relay ticket depends on it);
  the fake wallet does, real ones were not driven here.
* The preflight's `Jupiter build` row buys $VICINITY with SOL as the dev wallet: a plain Token-program route with no lookup
  table today. A Token-2022 output or a route that needs a lookup table (the USDC route does) is exercised only by the tests
  against the recorded 9 October answers; a layout change on those paths would surface in production as `jupiter_refused`
  (fail closed, nothing signed), not in the preflight.
