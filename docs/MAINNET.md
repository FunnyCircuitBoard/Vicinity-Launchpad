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
same panel and the Worker answers `not_enabled` for curve trades (the page says "Swapping is switched off right now").

## 2. Settings (where each one lives: docs/DEPLOY.md "Where each setting lives")

| setting | value for mainnet | required for |
|---|---|---|
| `SWAP` | `on` | the panel and `/api/swap/*` (`off` or unset = hidden, 404, the old Raydium links and words stay) |
| `JUPITER_API_KEY` (Secret) | a key from portal.jup.ag (the Developer plan, 10 requests per second, is the one for a launch day) | real builds (`/swap/v2/build`); without it quotes are estimates from the keyless API and no transaction is built |
| `JUPITER_RPS` | the plan's requests per second (`10`) | the per-server token bucket: more than this per second becomes estimates, never errors |
| `JUPITER_API_BASE` | unset (= `https://api.jup.ag`); `JUPITER_LITE_BASE` unset (= `https://lite-api.jup.ag`) | |
| `SWAP_PLATFORM_FEE_BPS`, `SWAP_FEE_ACCOUNT` | unset = no platform fee (an owner decision; the page says "takes no fee") | a Jupiter platform fee to that token account |
| `SOLANA_RPC_URL` (Secret) | the provider's mainnet URL (Helius or similar) | every chain read, the simulations, the relay's `sendTransaction`, the status polls |
| `RPC_TIMEOUT_MS` | `8000` | |
| `LAUNCHPAD_TRADING` | `on` only after section 4 | curve trades and `/api/launchpad/trade/*` |
| `LAUNCHPAD_CLUSTER` | `mainnet` | which chain the curve trades and their badges speak of |
| `LAUNCHPAD_PROGRAM_ID` | the deployed program (section 4) | REQUIRED on mainnet: no default exists, trading stays off without it |
| `LAUNCHPAD_DBC_CONFIGS` | the Meteora configs created for mainnet, comma-separated | REQUIRED on mainnet |
| `LAUNCHPAD_LOOKUP_TABLE` | the table created for mainnet | optional; without it trades are legacy-sized (bigger, still under 1232 bytes today) |
| `LAUNCHPAD_RPC_URL` (Secret) | unset = `SOLANA_RPC_URL` | |

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
1. Secrets in Cloudflare: `SOLANA_RPC_URL` (set already), `JUPITER_API_KEY` (new). Variables: `JUPITER_RPS=10`, `RPC_TIMEOUT_MS=8000`.
2. On your machine, with the secrets exported in the shell:
   `JUPITER_API_KEY=… JUPITER_RPS=10 SOLANA_RPC_URL=… npm run mainnet:preflight -- --set SWAP=on --site https://vicinity.city`
   Every row but the launchpad ones must PASS (those WARN while `LAUNCHPAD_TRADING` is off). `Jupiter keyed build SOL → $VICINITY`
   asks Jupiter for the build the Worker would ask for (0.01 SOL, the dev wallet as taker) and runs it through the Worker's own
   validator: a layout Jupiter changed fails here first, before anyone presses Swap.
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

## 4. City coins on mainnet: the launchpad program (NOT done, needs the owner's keys)

Nothing of this is automated or guessed. Each step by the owner on his own machine; the multisig signs where it says so.
solana/LAUNCHPAD.md section 9 has the detail of every command.

0. Before anything: the outside audit of `vicinity_launchpad` (LAUNCHPAD.md section 9); a lawyer's sign-off on the
   stock-token country list (pay-with-anything only); the website serves `/coin-meta/<mint>.json` and `/brand/vicinity-512.png`
   (a blocker: the URI in each coin can never change); the Jupiter Developer key (section 3); the Workers Paid plan confirmed;
   the Helius plan sized for one `getProgramAccounts` per coin per 10 minutes plus the trade traffic of section 6.
1. Keys, on the owner's machine only: `solana-keygen new` for the program id, the DBC config and a deployer wallet funded with
   about 2.3 SOL; the Squads multisig (upgrade authority and admin) with at least two signers.
2. Verifiable build: `anchor build --verifiable` (Docker), the SHA-256 of `vicinity_launchpad.so` recorded, `declare_id!` =
   the new program key, rebuild, the hash into solana/LAUNCHPAD-AUDIT.md.
3. Deploy: `solana program deploy --program-id <key> --upgrade-authority <deployer> --url mainnet-beta` (about 2.20 SOL rent
   plus fees), then `solana program set-upgrade-authority … --new-upgrade-authority <squads vault>`, plus `security.txt`.
4. Setup with `solana/scripts/launchpad/setup.mjs`, each command first WITHOUT `--send` to see the plan, then `--send --mainnet`:
   `config` (SOL quote, 85 SOL graduation, 125 bps, 0.05 SOL pool creation fee; the config keypair signs), `init` (admin = the
   multisig), `add-config`, `referral-accounts` (SOL and $VICINITY), the lookup table. `vicinity_rewards` `init_city` is per
   coin, later.
5. Site settings in the Cloudflare dashboard (kept by `keep_vars`): `LAUNCHPAD_PROGRAM_ID`, `LAUNCHPAD_DBC_CONFIGS`,
   `LAUNCHPAD_LOOKUP_TABLE`, `LAUNCHPAD_CLUSTER=mainnet`; `LAUNCHPAD_RPC_URL` unset.
6. `npm run mainnet:preflight -- --cluster mainnet --set LAUNCHPAD_TRADING=on --expect-upgrade-authority <squads vault> --expect-admin <squads vault>`
   with those exported: every launchpad row must PASS: the program is executable and owned by the upgradeable loader; the
   upgrade authority IS the multisig (a plain wallet is a FAIL on mainnet); the global account is initialised, not paused, its
   admin IS the multisig, a rewards program is set; each config is Meteora's with the dev wallet as fee claimer and leftover
   receiver, 125 bps, creator share 50 %, pool creation fee under the program's cap (a SOL config that does not graduate at
   85 SOL is a WARN: an owner decision); each config has an enabled allow-list entry under our program; the dev wallet's referral
   account exists for each quote mint; the lookup table holds the nine addresses a trade needs.
7. Flip `LAUNCHPAD_TRADING=on` (dashboard variable, then a pull request). Smoke with the owner's wallet after the first approved
   city launch: buy 0.01 SOL of that coin on `/coin` (the panel says "Live · curve", the fee line says "1.25% curve fee"), then
   sell it back; compare both with the quote on Solscan to the raw unit (the devnet rehearsal of exactly this:
   solana/LAUNCHPAD-DEVNET.md section 10); `npm run launchpad:claim-fees` lists what waits for the dev wallet.
8. Keeper: `scripts/launchpad/crank.mjs` on a small server with its own 0.5 SOL wallet, a minute pass and a daily pass, an alert
   on a failed pass (LAUNCHPAD.md section 7).
9. Rollback: `LAUNCHPAD_TRADING=off` stops the routes at the next request; `set_pause launches=true` through the multisig stops
   new launches; trades on existing curves cannot be stopped (Meteora's program is permissionless) and the panel then only
   says so.

## 5. The preflight, row by row (`scripts/mainnet-preflight.mjs`, read-only, Node 22, no dependencies)

```
npm run mainnet:preflight -- [--cluster devnet|mainnet] [--set KEY=VALUE]… [--rpc <url>] [--site https://vicinity.city]
                             [--expect-upgrade-authority <address>] [--expect-admin <address>] [--check-limits]
```

Settings come from `wrangler.jsonc` vars, then the shell (export the secrets for the run), then `--set`. Exit code 1 on any
FAIL. No key is printed (the Jupiter key goes out as a request header, exactly as the Worker sends it). Nothing is sent:
every call is a GET or a JSON-RPC read; `--check-limits` posts invalid bodies that are counted and refused before any work.

| row | PASS when | otherwise |
|---|---|---|
| `SWAP`, `LAUNCHPAD_TRADING` | on (and, for trading, the cluster settings complete) | WARN off; FAIL on with settings missing |
| `LAUNCHPAD_CLUSTER` | mainnet | WARN devnet while trading is on: test coins only |
| `VICINITY_MINT`, `SOLANA_RPC_URL`, `RPC_TIMEOUT_MS` | set | FAIL / FAIL / WARN |
| `site /api/health`, `site /api/official`, `site security headers / and /api/health`, `site cron alive` (`--site`) | 200; the switches as set here and the mint; CSP self-only + HSTS + nosniff + no framing; a balance sample under 25 minutes old | WARN when the site's switches differ from the settings here (dashboard vs wrangler.jsonc); FAIL on missing headers or a cron that never ran |
| `site /api/swap/config`, `site live quote SOL → $VICINITY`, `site attempt limit /api/swap/quote` (`--site`, the site's swap on) | mainnet, keyed; 0.01 SOL quoted with its source and latency; the 61st quote of one connection is 429 (`--check-limits`) | WARN keyless / Jupiter busy; FAIL no 429 |
| `JUPITER_API_KEY`, `JUPITER_RPS`, `SWAP_PLATFORM_FEE_BPS / SWAP_FEE_ACCOUNT` | key set; rate above 1; a fee only with a valid account | WARN / WARN / FAIL (a fee with no account) |
| `Jupiter lite quote SOL → $VICINITY` | the keyless quote answers with a route | FAIL: nobody can buy $VICINITY today |
| `Jupiter keyed build SOL → $VICINITY` (key set) | `/swap/v2/build` answers 200 for the dev wallet AND the Worker's validator accepts it | WARN 429 (the plan's allowance); FAIL refused by the key or by the validator |
| `mainnet RPC answers`, `mainnet RPC health`, `$VICINITY mint on mainnet`, `Jupiter program on mainnet` | mainnet genesis; getHealth ok and two accounts under 1.5 s; 6 decimals, no mint or freeze authority; executable | FAIL / WARN slow / WARN authority / FAIL |
| `no mainnet launchpad address in the code` | always PASS: it prints the mainnet defaults (null, []) | |
| `LAUNCHPAD_RPC_URL`, `LAUNCHPAD_PROGRAM_ID`, `LAUNCHPAD_DBC_CONFIGS` | set or defaulted (devnet); on mainnet the id and configs REQUIRED | WARN public RPC; FAIL missing |
| `launchpad RPC cluster`, `launchpad RPC health` | the cluster it should be; getHealth ok and the configs under 1.5 s | FAIL / WARN |
| `launchpad program` | executable, owned by the upgradeable loader | FAIL |
| `upgrade authority` | = `--expect-upgrade-authority`; immutable also PASS | FAIL a different key, or a plain wallet on mainnet; WARN a plain wallet on devnet or an unexpected non-wallet |
| `Meteora DBC program` | executable on the cluster | FAIL |
| `launchpad global account`, `launchpad admin`, `rewards program` | initialised, not paused; admin = `--expect-admin`; a rewards program set | FAIL not initialised; WARN paused; FAIL a different admin or a plain wallet on mainnet; FAIL no rewards program |
| `DBC config <id>` | Meteora's; fee claimer and leftover receiver = the dev wallet; 125 bps; creator share 50 %; pool creation fee under the cap | FAIL; WARN a SOL config not graduating at 85 SOL on mainnet |
| `allow-list entry <id>` | an enabled LaunchConfig under our program for that config | FAIL (setup.mjs add-config) |
| `referral account <quote>` | the dev wallet's token account for the quote mint exists | WARN (the first trade recreates it; that trader pays about 0.002 SOL) |
| `LAUNCHPAD_LOOKUP_TABLE` | a table holding the nine addresses a trade needs | WARN some missing or unset; FAIL not a table |
| `dev wallet` | in `ADMIN_WALLETS` | WARN |

Recorded runs on 9 October 2026 (the logs are in the implementer's report):

* devnet settings, `--expect-upgrade-authority` and `--expect-admin` = the devnet deployer: **34 rows, 31 pass, 3 warn, 0 fail**
  (the warnings: no Jupiter key in that shell, `JUPITER_RPS` at its default, `LAUNCHPAD_CLUSTER` devnet);
* mainnet settings with no program deployed: **19 rows, 13 pass, 3 warn, 3 fail** (`LAUNCHPAD_TRADING`, `LAUNCHPAD_PROGRAM_ID`,
  `LAUNCHPAD_DBC_CONFIGS`): the program rows fail cleanly and nothing else is skipped;
* `--site https://vicinity.city` (today's live site, switches off): health, `/api/official` (swap off, launchpadTrading off,
  the mint), the security headers on `/` and `/api/health`, the cron (a sample 7 minutes old) all PASS; the swap rows are
  skipped with a WARN because the site's swap is off.

## 6. Costs (estimates; nothing of section 4 was run on mainnet)

* Jupiter swaps: the person pays the network fee (5,000 lamports per signature), the priority fee Jupiter suggests (the Worker
  caps it at 0.01 SOL and shows "priority fee ≤" in the quote), and once per new token account 2,039,280 lamports of rent
  (returned when the account is closed). Vicinity takes no fee unless `SWAP_PLATFORM_FEE_BPS` is set. Jupiter's Developer plan:
  $25 per month.
* Curve trades: the curve's 125 bps (100 bps to Meteora's fee claimer = the dev wallet, split by the program into city, holders,
  founder and dev as LAUNCHPAD.md describes; 25 bps referral), the network fee, 55,000 to 73,000 compute units (devnet runs).
* The launchpad on mainnet (LAUNCHPAD.md section 9): the deploy about 2.23 SOL at the peak, config + init + allow-list about
  0.01 SOL, referral accounts and the table about 0.008 SOL, Meteora partner metadata about 0.002 SOL, the keeper's float 0.5 SOL
  plus about 0.03 SOL per graduation it runs, the Helius plan, the audit quote. Per launch the founder pays about 0.076 SOL.
* The Worker, per trade: one Jupiter build per (wallet, pair, amount, slippage) per 12 s (keyless quotes are shared the same
  way), one simulation per built transaction, one `sendTransaction` per relayed trade (wallets that cannot send themselves),
  one `getSignatureStatuses` per 2 s per watching page, a balance read per wallet per 10 s. Limits in src/guards.js and
  docs/DEPLOY.md.

## 7. Launch-day load check (the harness, fakes for Jupiter and the chain; the Worker is real)

`all-e2e/load-swap.cjs` on port 9340, mode `all` (SWAP on, keyed Jupiter, `JUPITER_RPS=10`), measured on 9 October 2026:

| phase | result |
|---|---|
| 200 quotes in 10 s from 10 connections, 20 distinct keys | 200 × 200, p50 10 ms, p95 15 ms; 20 Jupiter builds (one per key), never more than 2 × `JUPITER_RPS` in one second; the overflow at the peak answered as estimates, never errors |
| one connection, 70 quotes in 3 s | 60 × 200 then 10 × 429 `slow_down` with Retry-After |
| 50 quote + tx pairs in 5 s | 50 builds for the quotes, NOT ONE more for the transactions (each reuses its quote's build); every tx simulated once, ≤ 1232 bytes, version 0; p95 18 ms |
| 50 relayed sends | 50 signatures back, p95 16 ms |
| 450 status polls in 6 s | 450 × 200 (45 per connection, under 240 per minute), pending → confirmed → finalized |
| outbound | nothing reached the internet |

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
* Jupiter builds and keyless quotes are kept 12 s per key with one in-flight call per key (no stampede); lookup tables 10 min;
  a failed Jupiter call is never kept and a negative cache (5 s, or Retry-After) stops a flood of retries.
* Every `/api/swap/*` and `/api/launchpad/trade/*` route is Origin-checked, counted before the work (per connection, and per
  wallet for `/tx`), answers `{ ok: false, error: <code> }`, and simulates before the wallet opens so slippage, missing SOL
  and program errors are plain words, not a wallet warning.
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
  key is set; with the key, every quote for a connected wallet is a real build.
