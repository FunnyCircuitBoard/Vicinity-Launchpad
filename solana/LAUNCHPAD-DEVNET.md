# Vicinity Launchpad on devnet

The record of what runs on Solana **devnet** (the free public test network;
its SOL has no value). Nothing here is mainnet. Last updated 7 October 2026,
02:20 UTC.

## In one minute (for the owner)

* **Status: half done.** The parts that do not need our program are live on
  devnet and checked: the test token standing in for $VICINITY, the two
  Vicinity price-curve settings at Meteora (every platform fee paid to your dev
  wallet `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN`), and the shared
  address table that keeps transactions small.
* **Waiting:** our own program (`vicinity_launchpad`) and everything that runs
  through it: approving and launching the demo city coins with Vicinity
  metadata, buying, selling, coin to coin, graduation into a Meteora pool,
  holder rewards and the founder's payout.
* **Why:** the free devnet faucet refuses this build machine for today
  ("You've either reached your airdrop limit today or the airdrop faucet has
  run dry"; 4 more requests between 02:05 and 02:20 UTC were refused too).
  The throwaway devnet wallet holds 1.37 SOL; the program alone needs 2.23 SOL
  of deposit and fees, and the rest of the demo about 0.5 SOL more.
* **Rebuilt after the first code review (7 Oct, 01:47 UTC).** The program
  that waits for devnet now carries the review fixes (the leftover limit, the
  three separate payout keys through an admin hand-over, the name rule):
  433,960 bytes, SHA-256 `8706e3bf…27f0`. Nothing of the program was on
  devnet before, so this is a first deploy, not an upgrade. The SDK and tools
  the demo uses were fixed too (section 8, point 4).
* **What you do:** send **1.5 devnet SOL** to
  `9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa`. Open
  https://faucet.solana.com, sign in with GitHub, paste that address, choose
  devnet, and request the amount (repeat if it gives less each time). It is
  free test money. Then tell the team: the rest is two commands and about ten
  minutes (section 5), and this file is then filled in with every address and
  signature.
* **Meanwhile it is already proven** against these exact devnet accounts, in
  a test that replays them through our program on Meteora's devnet programs
  (section 2), and the whole demo ran end to end on a local copy of devnet
  (LAUNCHPAD-AUDIT.md section 9.2).

## 1. What is on devnet now

Every address below opens on the Solana explorer with `?cluster=devnet`.

| what | address |
|---|---|
| launchpad program (address fixed by `declare_id!`; **not deployed yet**) | [`Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7`](https://explorer.solana.com/address/Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7?cluster=devnet) |
| its global account (created by `init_launchpad`; pending) | [`ppX3a7oUKmZg2aAmxct8LnKdxNAcoGFDowcyzvbTsbw`](https://explorer.solana.com/address/ppX3a7oUKmZg2aAmxct8LnKdxNAcoGFDowcyzvbTsbw?cluster=devnet) |
| `vicinity_rewards` (deployed 3 Oct, AUDIT.md section 7; same binary as today's build) | [`Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi`](https://explorer.solana.com/address/Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi?cluster=devnet) |
| its registry (admin = the throwaway deployer) | [`2rKKwGGcJEDRJBhdHRPtHQpoxPmq9wPWWj3uMrcRaRg3`](https://explorer.solana.com/address/2rKKwGGcJEDRJBhdHRPtHQpoxPmq9wPWWj3uMrcRaRg3?cluster=devnet) |
| throwaway deployer (pays; upgrade authority and admin on devnet only) | [`9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa`](https://explorer.solana.com/address/9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa?cluster=devnet) |
| your dev wallet (receives every platform fee; a constant in the program) | [`13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN`](https://explorer.solana.com/address/13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN?cluster=devnet) |
| **tVIC**, the test token standing in for $VICINITY | [`HFFBwqSde8ehdE3AuoPjYZWbiaVdXJ25Su5QhhpWhBBX`](https://explorer.solana.com/address/HFFBwqSde8ehdE3AuoPjYZWbiaVdXJ25Su5QhhpWhBBX?cluster=devnet) |
| **Vicinity Meteora config, priced in SOL** (demo target 1 SOL) | [`4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7`](https://explorer.solana.com/address/4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7?cluster=devnet) |
| **Vicinity Meteora config, priced in tVIC** (target 25,000,000 tVIC) | [`8ZcsWij7BWkhrkvoJuGULN3XreHT9De4dj4ZEVgRMi8J`](https://explorer.solana.com/address/8ZcsWij7BWkhrkvoJuGULN3XreHT9De4dj4ZEVgRMi8J?cluster=devnet) |
| **Vicinity lookup table** (25 shared addresses) | [`5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe`](https://explorer.solana.com/address/5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe?cluster=devnet) |
| dev wallet's WSOL account (receives the vicinity.city referral share) | [`FGdoiYmovw4J7sAy8a657kWH2QUSBLxup59kkfUeMHa`](https://explorer.solana.com/address/FGdoiYmovw4J7sAy8a657kWH2QUSBLxup59kkfUeMHa?cluster=devnet) |
| dev wallet's tVIC account (same, for tVIC-priced coins) | [`Bh7NGUbZcisjDTV2YDxbLwjLCYz4kYyHGJ6ABtBNYrKt`](https://explorer.solana.com/address/Bh7NGUbZcisjDTV2YDxbLwjLCYz4kYyHGJ6ABtBNYrKt?cluster=devnet) |
| demo founder A (Demo City) | [`3oXqUyBGGe9gfPX3TPAeU9byD9WJ9LdskcpP2gmUTr9m`](https://explorer.solana.com/address/3oXqUyBGGe9gfPX3TPAeU9byD9WJ9LdskcpP2gmUTr9m?cluster=devnet) |
| demo founder B (Demo Town, Demo Village) | [`91WeAyurya1sKGLmLoAbCyD7o5cRhh5UGm24xKvxwGgr`](https://explorer.solana.com/address/91WeAyurya1sKGLmLoAbCyD7o5cRhh5UGm24xKvxwGgr?cluster=devnet) |
| demo trader 1 | [`AAMTJL8EUMJq8noHmgaahN57hXio5iMZCjZa3dPew1Th`](https://explorer.solana.com/address/AAMTJL8EUMJq8noHmgaahN57hXio5iMZCjZa3dPew1Th?cluster=devnet) |
| demo trader 2 | [`2ZouHQPoP6HRzdG5K64DGb6VChgEqDnH3MXdxCLwgL94`](https://explorer.solana.com/address/2ZouHQPoP6HRzdG5K64DGb6VChgEqDnH3MXdxCLwgL94?cluster=devnet) |
| demo payout key (the X Money payout hook) | [`C66UDS1ghGHmrUbmfeDymtDtFGRqbQcXyDQMqyKa6sAL`](https://explorer.solana.com/address/C66UDS1ghGHmrUbmfeDymtDtFGRqbQcXyDQMqyKa6sAL?cluster=devnet) |
| demo payout wallet (stands in for the off-ramp account) | [`FbsE5UjWhT2CGFtWCDwkRvoGCgezdGnJg3WP2zcgmkkK`](https://explorer.solana.com/address/FbsE5UjWhT2CGFtWCDwkRvoGCgezdGnJg3WP2zcgmkkK?cluster=devnet) |
| demo coin mints, reserved (created at launch): Demo City `DEMO`, Demo Town `DEMOT`, Demo Village `DEMOV` | `LcYadjDTuhsbR2ASAxPTsgeArXAkk1iDmvQJTJ89f5B`, `8b5vSRvgqgaedww5x45FCVZrMyiRQCLYPVzVeuUYTBPc`, `EAXzD7eEJuFr8kfmqrrPBVuUNsd53PWHfsHuYFD8nPby` |

### 1.1 Read back from the chain

**tVIC** (`spl-token display`): classic SPL token program, 6 decimals, supply
1,000,000,000 (raw 1,000,000,000,000,000), mint authority **none**, freeze
authority **none**. That is what the launchpad's config rule 7.2(2) demands of
any quote token, and what the real $VICINITY looks like. Holders: the deployer
780M, each trader 100M, each founder 10M.

**The two Vicinity configs** (owner: Meteora DBC `dbcij3…`; values decoded by
the demo right after creation and again by test TL01):

| field | SOL config | tVIC config |
|---|---|---|
| quote token | WSOL `So111…112` | tVIC `HFFBwq…` |
| raise target (graduation) | 1 SOL (demo; the default is 85 SOL) | 25,000,000 tVIC |
| trading fee | 1.25% (Meteora 0.25%; dev wallet 0.50%; city 0.50%, split holders 0.25% / founder 0.25% by our program) | same |
| launch fee | 0.01 SOL (demo; the default is 0.05 SOL) | same |
| fee claimer | `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` | same |
| leftover receiver | `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` | same |
| coins sold on the curve | 793,099,894.092564 | 793,099,999.411112 |
| coins kept for the pool | 206,900,021.912251 | 206,900,000.121841 |

The split between "sold on the curve" and "kept for the pool" is Meteora's own
`buildCurve` result for each target (design 7.1); it differs from pump.fun's
793.1M/206.9M only in the last decimals.

**The lookup table** holds the 25 addresses that Vicinity transactions share
(programs, Meteora's fixed accounts, our global account, both configs and their
allow-list entries, both quote tokens, the dev wallet and its referral
accounts). It is what lets a launch with the founder's first buy, a coin-to-coin
swap or a pay-with-anything purchase fit in one transaction.

### 1.2 Transactions so far

Generated by `node scripts/launchpad/devnet-record.mjs scripts/launchpad/devnet-demo-state.json`
(compute units and fees as the cluster recorded them). Paid by the deployer:
0.0285 SOL in total.

| step | what | signature | bytes | compute units | fee (lamports) |
|---|---|---|---|---|---|
| quote-mint | create tVIC mint | [`3WZHhuTGmV…`](https://explorer.solana.com/tx/3WZHhuTGmVcMwEwH1CYQkBrkQs7vksFywcYqJQfPif4cWeJgLaG8YqZaxCFuQyhsGEGDCaYy7a7b73rmvQiYtSpH?cluster=devnet) | 432 | 502 | 10000 |
| quote-mint | mint 1,000,000,000 tVIC to the demo wallets | [`4kokA689Wo…`](https://explorer.solana.com/tx/4kokA689Wo9pYJpWtXYBxUw3D1LrRD8RZL55MCc2EsUjPwSru8LJurmsiRva5uD6dag4pV5s2hJZouf8HqZAfQwG?cluster=devnet) | 717 | 80224 | 5000 |
| quote-mint | remove the tVIC mint authority | [`49HBQhJh4y…`](https://explorer.solana.com/tx/49HBQhJh4y73NdB6jfWnKiZGk9SZHTzCpnYSTSuSLyuFaDvRaCsGMtEmzbfZFAkJFHjXEsQczYUX9d8djPSdTtic?cluster=devnet) | 248 | 265 | 5000 |
| dbc-configs | Meteora DBC config: SOL, target 1 SOL | [`4et9azRJjs…`](https://explorer.solana.com/tx/4et9azRJjshp6BzcSbB5D4YKVXTAD8YCLwbYQpTxrpR5W1buPUqzMPgvsm2xAGZoMBhDniaZHciyVuun2y3fHb8D?cluster=devnet) | 703 | 36565 | 10000 |
| dbc-configs | Meteora DBC config: tVIC, target 25,000,000 tVIC | [`4ZJMWaEWBk…`](https://explorer.solana.com/tx/4ZJMWaEWBknMCMHgYQBZ5jyRZkEsLBXr8rbcTN5bDXQyw1bWq2Rw3cw3snoWurB8FFDf61d6pUcWcv42JYYpjwrx?cluster=devnet) | 703 | 36579 | 10000 |
| referral-accounts | dev wallet referral accounts (WSOL, tVIC) | [`t8PXehnu5z…`](https://explorer.solana.com/tx/t8PXehnu5zuW5BHfefZ3iGyVx3pGrZNXE9FyF5TZoJ1vnrKdKXB3Xz6eNCVMmJt6dJtMArKEaL7978ErsubJWHL?cluster=devnet) | 452 | 33182 | 5000 |
| lookup-table | create the Vicinity lookup table | [`3pdfWv3t1R…`](https://explorer.solana.com/tx/3pdfWv3t1R8iCTyA8mQZCBUe3ZDbUmTWzpqqxy3T6prPAkfXEaAiC5YXKEBiTxuinPE2CcwHg62pgbDbW7dTUYBN?cluster=devnet) | 292 | 10616 | 5000 |
| lookup-table | extend the lookup table (1/2) | [`L1kYD4RB1L…`](https://explorer.solana.com/tx/L1kYD4RB1LWoBdxvnZxADMu8s5KKomiucH53K8xU3vh9o7SkwqApvjET5p4T9oYBdPtx3iEyHnowW2AgGmr5GoQ?cluster=devnet) | 932 | 11807 | 5000 |
| lookup-table | extend the lookup table (2/2) | [`2gJS7AWWYu…`](https://explorer.solana.com/tx/2gJS7AWWYu6FfdKrVvoBu9RHN7X8KFuDiiCsk9v4xPaooRiVGiEK5KCgkSshBeDLFxL7rxP8evCGWsZW1YFj2TU1?cluster=devnet) | 452 | 7398 | 5000 |

The full record, including the decoded config values, is
`scripts/launchpad/devnet-demo-state.json` (public data only: addresses,
signatures, amounts). The demo resumes from it.

## 2. Already proven against these exact accounts

`npm run test:devnet-accounts` (`tests-launchpad/14-devnet-accounts.test.mjs`)
reads the tVIC mint and both configs from devnet (it sends nothing), loads
them into an in-process copy of the chain running **Meteora's devnet builds**
(the same programs devnet runs) and our program, and then:

* **TL01** `add_launch_config` accepts both configs: every config rule in
  design 7.2 passes, and the allow-list entry records quote token, target,
  the 1.25% trading fee and the 0.01 SOL launch fee;
* **TL02** a coin launched on each config trades (the SOL coin is bought and
  half sold back); the tVIC coin is bought, filled to its 25,000,000 tVIC
  target, its fees are harvested into the holders pot and founder vault, and
  it graduates into a Meteora DAMM v2 pool.

Every invariant of design section 15, including where each token may go, is
checked after each of those transactions. Result on 7 October 2026: 2 of 2
pass, on both Meteora's devnet and mainnet builds; re-run at 02:20 UTC with
the rebuilt program (whose new leftover rule both configs pass: they leave
about 84 and 0.5 coins over, the limit is 1,000): 2 of 2 pass.

Also already done before devnet (LAUNCHPAD-AUDIT.md section 9.2): the
complete demo of section 6 ran on a local validator loaded with the devnet
builds of Meteora's and Metaplex's programs and our two programs (23 of 23
steps), and the full 112-test suite passes on both Meteora builds.

## 3. The devnet programs it relies on (checked 7 October 2026)

| program | address | devnet build |
|---|---|---|
| Meteora DBC (curves) | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | 1,983,568 bytes, deployed in slot 503,167,099, SHA-256 `f5ccbb01…`; a **different build from mainnet's** (2,326,577 bytes); pinned in `scripts/launchpad/fetch-fixtures.sh` |
| Meteora DAMM v2 (pools after graduation) | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | 1,559,448 bytes, slot 503,166,267, SHA-256 `82bb9375…` |
| DAMM v2 customizable config used at graduation | `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` | exists on devnet (owner DAMM v2) |
| Metaplex Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | 1,295,344 bytes, SHA-256 `bb0842f6…` |
| `vicinity_rewards` | `Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi` | 505,864 bytes; dumped from devnet today: SHA-256 `f0fbc9d5…09a3`, identical to today's build |

Graduation can be shown on devnet: DAMM v2 exists there and Meteora's
migration is permissionless, so the demo graduates its coin itself (Meteora's
own keepers do not run on devnet).

## 4. What is pending, and exactly how much SOL it needs

| step | SOL |
|---|---|
| deploy `vicinity_launchpad` (433,960 bytes, SHA-256 `8706e3bf…27f0`): program data deposit 2.20539564 + program account + about 450 write transactions; `deploy-devnet.sh` computed and refused at 02:16 UTC: "needs 2.226228760 SOL, the deployer has 1.366462080 SOL" | **2.2262** |
| the rest of the demo at its peak: 0.445 lent to the demo wallets (returned at the end) plus accounts and fees (measured 0.503 on the local rehearsal, less on devnet whose rent is lower) | **0.50** |
| **total needed** | **about 2.73** |
| the deployer holds (7 Oct 2026, 02:16 UTC) | 1.3665 |
| **shortfall** | **about 1.36 (0.86 for the program alone): please send 1.5** |

After the demo, about 2.42 SOL stays locked as deposits (2.198 in the program,
the rest in demo accounts); `solana program close` returns the program's
2.198 when the devnet copy is retired.

## 5. How to finish (on the build machine, which holds the throwaway keys)

```sh
cd solana
export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH
KEYS=<the scratch keys folder>        # throwaway keys only; never in git, never printed

# 1. deploy: checks devnet, the binary's SHA-256, the program address and the
#    SOL first; its own buffer key, so a failed run resumes; prints only the
#    program address and signature (the full output stays in $KEYS)
bash scripts/launchpad/deploy-devnet.sh "$KEYS"

# 2. the rest of the demo: skips the four steps above (it reads the record)
node scripts/launchpad/devnet-demo.mjs --keys "$KEYS" --state scripts/launchpad/devnet-demo-state.json

# 3. the tables for this file, with explorer links, compute and fees
node scripts/launchpad/devnet-record.mjs scripts/launchpad/devnet-demo-state.json
```

Without those keys (another machine), the same three commands work with a
fresh set of throwaway keys (named in the header of `devnet-demo.mjs`) and a
new record file, except that the program address is fixed by its own key:
deploying elsewhere means a new program address, `declare_id!` and rebuild.

## 6. What the full run adds (rehearsed end to end on a local validator)

1. `init_launchpad` (the deployer as admin) and the allow-list of both configs.
2. Approve and launch three demo cities, each with Vicinity metadata (name,
   ticker, and `https://vicinity.city/coin-meta/<mint>.json`, immutable):
   Demo City `DEMO` and Demo Town `DEMOT` priced in tVIC, Demo Village `DEMOV`
   priced in SOL. Demo City's founder buys 1,000,000 tVIC worth and Demo
   Village's founder 0.02 SOL worth in the launch transaction itself.
3. Trades, each quoted by the SDK first and checked to the raw unit: buy with
   tVIC (exact in), sell half, buy exactly 5,000,000 DEMO (exact out), buy and
   sell DEMOV with SOL (wrapped and unwrapped).
4. Coin to coin: DEMO to DEMOT in one transaction.
5. Rewards set-up for both tVIC cities (`vicinity_rewards` `init_city`:
   Holders model, 0% to the founder, paid in tVIC).
6. Graduation of DEMO: fill the curve (partial fill, the rest refunded),
   harvest the fees and the city's surplus share, Meteora `migration_damm_v2`
   into a DAMM v2 pool, unsold dust to the dev wallet; then a buy and a sell on
   the pool.
7. The keeper's daily pass over every registry coin.
8. A holders' rewards round: the holders pot forwarded and an epoch funded from
   a snapshot (pools, programs, the dev wallet and the founder left out), then
   claims by the holders.
9. "Send to all holders": unsigned batches built by the SDK, signed by the
   deployer standing in for your wallet.
10. The founder's own claim of their 0.25%.
11. The X Money payout hook: payout settings, founder B's signed opt-in, one
    payout by the payout key into the one payout wallet, a second payout
    within 24 hours refused (simulated), the opt-in revoked, payouts switched
    off again.
12. Leftover SOL swept back to the deployer.

The metadata file the website must serve for Demo City
(`coinMetadataJson` in `sdk/launchpad/metadata.mts`):

```json
{
  "name": "Demo City",
  "symbol": "DEMO",
  "description": "The city coin of Demo City. Launched on Vicinity (https://vicinity.city) on Solana.",
  "image": "https://vicinity.city/coin-meta/LcYadjDTuhsbR2ASAxPTsgeArXAkk1iDmvQJTJ89f5B.png",
  "external_url": "https://vicinity.city/c/999000001",
  "createdOn": "https://vicinity.city",
  "launchpad": "Vicinity",
  "launchpadLogo": "https://vicinity.city/brand/vicinity-512.png",
  "network": "Solana",
  "city": { "id": 999000001, "name": "Demo City", "ticker": "DEMO" },
  "showName": true,
  "attributes": [
    { "trait_type": "Launchpad", "value": "Vicinity" },
    { "trait_type": "Network", "value": "Solana" },
    { "trait_type": "City", "value": "Demo City" }
  ],
  "website": "https://vicinity.city/c/999000001"
}
```

## 7. What devnet cannot show

* **Paying with BTC, ETH, stocks or USDC.** Jupiter runs on mainnet only. It
  is shown instead by unit tests on recorded Jupiter answers and by read-only
  live quotes (`npm run test:jupiter-live`, 7 October 2026): cbBTC, ETH and
  SPYx all routed into SOL. At 02:10 UTC, with the stricter checks of the
  review (every Jupiter instruction allow-listed), live answers for cbBTC,
  ETH, SPYx, USDC, STONK, WBTC and VICINITY all passed and each planned as
  one transaction with the Vicinity lookup table (1,041 to 1,223 bytes; the
  size changes with Jupiter's route of the moment, and without the table a
  second transaction is usually needed). Nothing was sent.
* **The "Vicinity" label on Jupiter, DEX Screener, Birdeye and wallets.**
  Those are mainnet listings that you request after the first mainnet launch
  (LAUNCHPAD.md section 4). On devnet the explorer shows the coin's name,
  ticker and metadata link; the link points to vicinity.city, which does not
  serve coin files yet (website work).
* **The dollar leg of an X Money payout.** That is off-chain (LAUNCHPAD.md
  section 7); devnet shows only the on-chain hook.

## 8. Findings on devnet so far

1. **Lookup-table slot.** Devnet refused the first lookup table ("508278447
   is not a recent slot"): on devnet the finalized slot is often the newest
   one, which the cluster does not list yet. The SDK now picks a produced
   slot a few slots back (`recentSlotForLookupTable`, unit-tested); the
   website must use it too.
2. **Faucet.** All 23 airdrop requests from this machine between 6 October
   23:30 and 7 October 00:57 UTC were refused with "You've either reached your
   airdrop limit today or the airdrop faucet has run dry". The requests were
   spaced minutes apart and then stopped; the faucet's daily limit is per
   requester.
3. **Meteora's devnet DBC is a different build from mainnet's.** The full
   suite and TL01-TL02 pass on both, so the demo's results carry over; still,
   re-run `npm run launchpad:fixtures` (both networks) and the suites before
   mainnet and after any Meteora upgrade.
4. **Code review (7 Oct).** The program and SDK were fixed after the first
   code review (`LAUNCHPAD-AUDIT.md` section 10) before anything of the
   program reached devnet. For the demo this means: every trade first makes
   sure the dev wallet's referral account exists (it does on devnet:
   `FGdoiY…` and `Bh7NGU…` above), every curve buy is a partial fill, and the
   rewards round uses balance samples (the demo takes one; mainnet needs at
   least six taken at random times).

## 9. Safety notes

* Only throwaway keys are used, kept outside the repository and never
  printed. `deploy-devnet.sh` keeps the deploy output inside the keys folder
  because a failed deploy can print a recovery phrase.
* `deploy-devnet.sh` and `devnet-demo.mjs` refuse to run against mainnet.
* On devnet the throwaway deployer is the program's upgrade authority and
  the launchpad admin. On mainnet both go to your Squads multisig before the
  first public approval (LAUNCHPAD.md section 9).
* The devnet configs pay the real dev wallet address, because it is a
  constant in the program. Devnet SOL is worthless. After the demo,
  `npm run launchpad:claim-fees -- --rpc https://api.devnet.solana.com` lists
  the devnet fees waiting for the dev wallet (read-only); claiming them is
  the same phone-wallet signing step as on mainnet, once the signing page
  exists (website work). Never export the dev wallet's key to a file for this.
