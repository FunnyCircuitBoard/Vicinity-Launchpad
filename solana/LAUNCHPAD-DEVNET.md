# Vicinity Launchpad on devnet

The record of what runs on Solana **devnet** (the free public test network;
its SOL has no value). Nothing here is mainnet. Last updated 7 October 2026,
15:45 UTC.

## In one minute (for the owner)

* **Status: done.** Our program `vicinity_launchpad` is deployed on devnet and
  the whole demo ran there on 7 October 2026 (15:36 to 15:41 UTC), every step
  through our program and Meteora's real devnet programs:
  * three demo city coins approved and launched with Vicinity metadata, two
    priced in tVIC (the test stand-in for $VICINITY) and one in SOL;
  * buys and sells (exact in and exact out), SOL wrapped and unwrapped, and a
    coin-to-coin swap in one transaction;
  * Demo City (`DEMO`) filled its curve and **graduated into a Meteora DAMM v2
    pool**, and traded there;
  * the keeper collected the fees and forwarded the holders' share;
  * a **holders' rewards round** was funded and both holders claimed; a
    **push to all holders** was sent;
  * the **founder claimed** their 0.25%, and the **X Money payout hook** paid
    an opted-in founder into the one fixed payout wallet, then the founder
    revoked and payouts were switched off again.
* **Every platform fee** is paid to your dev wallet
  `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN`.
* **Cost:** the 5 devnet SOL you sent covered it. The program holds 2.205 SOL
  of deposit (returned if the devnet copy is ever closed); the deployer still
  holds 3.98 SOL. Devnet SOL has no value.
* **Found on devnet and fixed:** the free public RPC refused the keeper's
  search for the city's pool position, so the keeper now reads it by owner
  (section 8, point 5).

## 1. What is on devnet now

Every address below opens on the Solana explorer with `?cluster=devnet`.

| what | address |
|---|---|
| launchpad program (deployed 7 Oct 2026, slot 508,501,875, SHA-256 `8706e3bf…27f0`; signature [`2J2B2Jtauz…`](https://explorer.solana.com/tx/2J2B2Jtauzyd1DPCa6VBYLV9YrRkbxhrzfi6xpmpRTwEvb7v1viBh68qxPpBXS3whUyiWYjRs2KSj7C4jCqcxJKG?cluster=devnet); upgrade authority = the throwaway deployer) | [`Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7`](https://explorer.solana.com/address/Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7?cluster=devnet) |
| its global account (created by `init_launchpad`) | [`ppX3a7oUKmZg2aAmxct8LnKdxNAcoGFDowcyzvbTsbw`](https://explorer.solana.com/address/ppX3a7oUKmZg2aAmxct8LnKdxNAcoGFDowcyzvbTsbw?cluster=devnet) |
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
| **Demo City `DEMO`** (tVIC): mint · Coin record · Meteora curve | [`LcYadjDTuhsbR2ASAxPTsgeArXAkk1iDmvQJTJ89f5B`](https://explorer.solana.com/address/LcYadjDTuhsbR2ASAxPTsgeArXAkk1iDmvQJTJ89f5B?cluster=devnet) · [`Aqr67SzZQ9uiekxa5yrnm7cD4dmHxaX2cfZ73yx7cusb`](https://explorer.solana.com/address/Aqr67SzZQ9uiekxa5yrnm7cD4dmHxaX2cfZ73yx7cusb?cluster=devnet) · [`b1cdZq6rSh3q72L5Ne4KoCJjuV3gWbf7Pmb6WumdqyW`](https://explorer.solana.com/address/b1cdZq6rSh3q72L5Ne4KoCJjuV3gWbf7Pmb6WumdqyW?cluster=devnet) |
| **Demo City's graduated pool** (Meteora DAMM v2; 206,486,200 DEMO + 24,950,000 tVIC at graduation; LP locked) | [`FZxV5nGGVeXrU45pKFY636XHZELMBKboEGQ73JxRmYrB`](https://explorer.solana.com/address/FZxV5nGGVeXrU45pKFY636XHZELMBKboEGQ73JxRmYrB?cluster=devnet) |
| **Demo Town `DEMOT`** (tVIC): mint · Coin record · Meteora curve | [`8b5vSRvgqgaedww5x45FCVZrMyiRQCLYPVzVeuUYTBPc`](https://explorer.solana.com/address/8b5vSRvgqgaedww5x45FCVZrMyiRQCLYPVzVeuUYTBPc?cluster=devnet) · [`BWsfpRwKrU8YseoWNoa2vMgh3hxy8e8e3fuN6xp2hjUz`](https://explorer.solana.com/address/BWsfpRwKrU8YseoWNoa2vMgh3hxy8e8e3fuN6xp2hjUz?cluster=devnet) · [`HJVpXo55geGFZu2KiRmjWj79vzNy6jeCnsTCuUK51dqw`](https://explorer.solana.com/address/HJVpXo55geGFZu2KiRmjWj79vzNy6jeCnsTCuUK51dqw?cluster=devnet) |
| **Demo Village `DEMOV`** (SOL): mint · Coin record · Meteora curve | [`EAXzD7eEJuFr8kfmqrrPBVuUNsd53PWHfsHuYFD8nPby`](https://explorer.solana.com/address/EAXzD7eEJuFr8kfmqrrPBVuUNsd53PWHfsHuYFD8nPby?cluster=devnet) · [`DcCDswmYyzh4ZXkXHLenxGGcjq1WGSXpEgiuPc4pwZCw`](https://explorer.solana.com/address/DcCDswmYyzh4ZXkXHLenxGGcjq1WGSXpEgiuPc4pwZCw?cluster=devnet) · [`GCr3j1bQXJapUQFjxmnVCoPc7ciE1L2UxvKKRwtHpinA`](https://explorer.solana.com/address/GCr3j1bQXJapUQFjxmnVCoPc7ciE1L2UxvKKRwtHpinA?cluster=devnet) |
| Demo City's rewards config · vault · first epoch (`vicinity_rewards`) | [`6F7QSvGssCv5yk3uV6krVj2JQ3a5i1Qxtvvnt5gxHpFN`](https://explorer.solana.com/address/6F7QSvGssCv5yk3uV6krVj2JQ3a5i1Qxtvvnt5gxHpFN?cluster=devnet) · [`FvgQrLpbrXyQuYjc7nxpVKiZ1Hp6sdiTvvbBygY1qzAd`](https://explorer.solana.com/address/FvgQrLpbrXyQuYjc7nxpVKiZ1Hp6sdiTvvbBygY1qzAd?cluster=devnet) · [`GQaCoM13jVQkEX42NNV4dfee6xpxFXsoYpTDX9MV8ojQ`](https://explorer.solana.com/address/GQaCoM13jVQkEX42NNV4dfee6xpxFXsoYpTDX9MV8ojQ?cluster=devnet) |

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

### 1.2 Every transaction

Generated by `node scripts/launchpad/devnet-record.mjs scripts/launchpad/devnet-demo-state.json`
(compute units and fees as the cluster recorded them). The program deploy
itself (about 450 write transactions into a buffer, then one deploy) is
signature [`2J2B2Jtauz…`](https://explorer.solana.com/tx/2J2B2Jtauzyd1DPCa6VBYLV9YrRkbxhrzfi6xpmpRTwEvb7v1viBh68qxPpBXS3whUyiWYjRs2KSj7C4jCqcxJKG?cluster=devnet).

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
| fund-wallets | fund demo wallets | [`5ENXSHNiR4…`](https://explorer.solana.com/tx/5ENXSHNiR4XAaW2sUh2apHCZVR2RGBTwnY3NHr7PXPBXRsMAdiXGrZAxFXPJLfeyE1F23UGE1zM88fcnE8iK7Fr8?cluster=devnet) | 453 | 900 | 5000 |
| init-launchpad | init_launchpad | [`x7W6dE47JL…`](https://explorer.solana.com/tx/x7W6dE47JLdXHTrDVdj7fLpv41aPHhQNoSbB685AKuyUevKvPobr8bRUKERfqwgoeXgJixXokyH4QEHQSJCgxKD?cluster=devnet) | 354 | 12685 | 5000 |
| add-configs | add_launch_config 4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7 | [`4kESa4SpXZ…`](https://explorer.solana.com/tx/4kESa4SpXZgumNPBjoRRGgzyLENwqAP6fGFzz9y3c7LpwcQWnBswjVmmfAov19yc6THEzbRSvymwMrHgirQdda7?cluster=devnet) | 386 | 16238 | 5000 |
| add-configs | add_launch_config 8ZcsWij7BWkhrkvoJuGULN3XreHT9De4dj4ZEVgRMi8J | [`495yKfuo2F…`](https://explorer.solana.com/tx/495yKfuo2FNufpPLvYrFcSEaUyhN8QWAFkdUL9dVcXRNm33H66WfTiAkSaNEHxNxw14PJLN48PwVWWwboHsCBEHJ?cluster=devnet) | 386 | 14738 | 5000 |
| approve | approve_launch DEMO | [`4Ho5yDv4Jz…`](https://explorer.solana.com/tx/4Ho5yDv4JzC2HL2TFPqhqhShEpNCpJpP39ddH9HcGzUNKLTni8oL1ygF6UTHSA9BQnPmctLA8Vjj8HzGSupGEkAK?cluster=devnet) | 454 | 19491 | 5000 |
| approve | approve_launch DEMOT | [`4f7NgSBApq…`](https://explorer.solana.com/tx/4f7NgSBApqDdpNxZFcqHNfYJoDpEpvF61kVuKudFRLDxSnFxPxrF4W2PeAtMgMLsYTxMYsSmePX9Z4AmZ8HUXqrG?cluster=devnet) | 455 | 19516 | 5000 |
| approve | approve_launch DEMOV | [`4VW2nMkqHr…`](https://explorer.solana.com/tx/4VW2nMkqHr7E6TesgW1zdWBHrC1kKwDMkuqMDmHk4P9hTS9ftCwErGx3qp5DUsJvfjRfgqnVieRuFfCrCT3zXWeC?cluster=devnet) | 458 | 19718 | 5000 |
| launch-a | launch + first buy DEMO | [`3xJahVRHCS…`](https://explorer.solana.com/tx/3xJahVRHCSVwguFhByafAAAmWj4sA6wCoY2j7e7NNuYC3vFTAKszFUJAih9QSQVCqWNGxkvVLAGP2gzzNj1dTfW?cluster=devnet) | 869 | 219396 | 10000 |
| launch-b | launch DEMOT | [`5XSqyprDm4…`](https://explorer.solana.com/tx/5XSqyprDm4bkWf4gpA5cfL5Fav16f1Bv5aBDTguiNG8SGeuBg79Po8bCUdXp8kbJpvDEH374o4Nb8JoZHk7rokht?cluster=devnet) | 677 | 156201 | 10000 |
| launch-c | launch + first buy DEMOV | [`2VzWghJZrN…`](https://explorer.solana.com/tx/2VzWghJZrNmcbkKLyeNzNW7dGNSQLsJxa1XmkTwJucF1DToCc4q4aM2i98NgaAFQjWdct24NvWoJPEEKghMj6AL7?cluster=devnet) | 970 | 228886 | 10000 |
| trades | buy DEMO with 2,000,000 tVIC (exact in) | [`3TVThFqi9a…`](https://explorer.solana.com/tx/3TVThFqi9a66BW7ziF6ttPw3SPeTJrT1ipFc49PNQqVVA5XbPLBG4eh4xGuj9mxKLC9Lu2fJWLu1wLsQ2QdkL4An?cluster=devnet) | 537 | 61860 | 5000 |
| trades | sell half of it (exact in) | [`2C9KUSh2e6…`](https://explorer.solana.com/tx/2C9KUSh2e6hFLVDhpidCqRrgFbmZgY6iAxpPVgRJs5m2vBzdNnm1wkMQ1UgTYTJvpCLuTbqSZygeVaBhXxYaZaPy?cluster=devnet) | 537 | 47943 | 5000 |
| trades | buy exactly 5,000,000 DEMO (exact out) | [`aRwAq54L7R…`](https://explorer.solana.com/tx/aRwAq54L7RTz5416Lwo87asydVuveUWp9GHszLayjsgfzPawamWuvFn9kMKPr1AsYY1eRkRvsciWdYXGu8eygMQ?cluster=devnet) | 537 | 53819 | 5000 |
| trades | buy DEMOV with 0.01 SOL (SOL wrapped and unwrapped) | [`3gt2Q794nU…`](https://explorer.solana.com/tx/3gt2Q794nUuYYvkcwPNQae7wvWqxsch428NuAoDA8g1hZjF6XrsdX2fnuwE4B2V3znkBf1ebrzao2mEVGKc4V83i?cluster=devnet) | 638 | 69728 | 5000 |
| trades | sell all DEMOV back to SOL | [`646Ao32X7R…`](https://explorer.solana.com/tx/646Ao32X7RS3QfCHgQT6JtR8J1HikASBzop6Tnzpdd8LaNiPg4LWJ3jaxxQQhb3PCLjjTZMcoE5LmAX9cY1nRmmP?cluster=devnet) | 575 | 54137 | 5000 |
| coin-to-coin | coin to coin: DEMO -> DEMOT in one transaction | [`5y3GWNPTEe…`](https://explorer.solana.com/tx/5y3GWNPTEeHM4Aq9PoU1V9BEhXxnzEBqjvbYRvJ1Vr4otZWjfsM6kbiWiNCYukDW2EJW7X6hxadVY7aLWuUg4Bs2?cluster=devnet) | 750 | 106704 | 5000 |
| rewards-init | vicinity_rewards init_city for DEMO (Holders, 0% founder, paid in tVIC) | [`24unaQFR3w…`](https://explorer.solana.com/tx/24unaQFR3wJshyjAtEJgMuTaViH8Q7NzNKE8zmawU4UsY3Tirca5yZCmHqKsDxbBocJebPUe9T2xR1BCvj1AfGLU?cluster=devnet) | 521 | 25910 | 5000 |
| rewards-init | vicinity_rewards init_city for DEMOT (Holders, 0% founder, paid in tVIC) | [`4mSmp1Q4RD…`](https://explorer.solana.com/tx/4mSmp1Q4RDjtyMtADXH6k8iUqqGdb6A98LGtaFRuZTk7Adbt6zgfkYqwQchh1W5DKJ9TbgWHJy6E7BxxRXxKSmub?cluster=devnet) | 521 | 21410 | 5000 |
| graduate-a | fill the DEMO curve (partial fill, the rest refunded) | [`2uZjHxSBvu…`](https://explorer.solana.com/tx/2uZjHxSBvueo8DifRMhQtiVRF4pTNmPnqo1haPejzm9pbokp2X2xLH41JrZCp76b7hbfnSVDKcRciwTibaap3rm8?cluster=devnet) | 537 | 61970 | 5000 |
| graduate-a | harvest_curve_fees DEMO (fees + the city's surplus share) | [`3xmaeCd3Ef…`](https://explorer.solana.com/tx/3xmaeCd3EfrCZkJTNqbX11vZS6aDCwXf2k1BiChMDqHLz3TuA3HvzdtfaJdeuB558PThm2BSGgAHB5Froq1Rpnq3?cluster=devnet) | 756 | 80230 | 5000 |
| graduate-a | graduate DEMO: Meteora migration_damm_v2 (permissionless) | [`5uYQfsWSfE…`](https://explorer.solana.com/tx/5uYQfsWSfEPXfMwYSZbQkYZR7Tr8codBieQd9hYUPUJ2v8bt7AM6JkzsmXdYfFeF48AzbePRJjfeW3WjaQv4WjTd?cluster=devnet) | 1109 | 246555 | 15000 |
| graduate-a | withdraw_leftover: unsold dust to the dev wallet | [`5pmb9HQwnq…`](https://explorer.solana.com/tx/5pmb9HQwnq5jTJpatKHLbkNsLpygbiGd1j189BcTczL2231NEoaibm6wAovtQpu2NNY7byzNHu71yzikwvr3v5KW?cluster=devnet) | 591 | 50713 | 5000 |
| pool-trades | buy DEMO on its DAMM v2 pool (1,000,000 tVIC) | [`5LfjMebZwX…`](https://explorer.solana.com/tx/5LfjMebZwXhwgYqCcX5RScAek7kbem6hquBj9pAgV5AnLjsYJHjkS63TSbbjaUXH4G5xTuRgNWw4b9Kf7vXEPz8s?cluster=devnet) | 643 | 21535 | 5000 |
| pool-trades | sell some DEMO on the pool | [`3PRUx9bZj5…`](https://explorer.solana.com/tx/3PRUx9bZj5FcnLAaR1rrxbSJFoKCeLXBsaEQwmeMdSE5oDRQSUCee6X9AxgCJCJ2kkMtbVzgdF63KSGASfbKJ4jK?cluster=devnet) | 643 | 17922 | 5000 |
| keeper | keeper: city 999000001 harvestPool, city 999000001 forward | [`4uB8dKedKe…`](https://explorer.solana.com/tx/4uB8dKedKeUkwV772sK9BsRwudrKDpX4HkomytiZ6u2HJrRQm15MQ8xj5wXTW1qjyDhZNXJ87hybQedpwu1SbfSZ?cluster=devnet) | 911 | 74361 | 5000 |
| keeper | keeper: city 999000002 harvestCurve, city 999000002 forward | [`43msHDAtpk…`](https://explorer.solana.com/tx/43msHDAtpkRxeoP3LPNqWyZG3jwv4FG83ogJjagqdLHg7zdmCJhJzpHSKWBprsWknaSXHhWjn1g93Ru3maMSw12G?cluster=devnet) | 878 | 83220 | 5000 |
| keeper | keeper: city 999000003 harvestCurve | [`51RfarDPSe…`](https://explorer.solana.com/tx/51RfarDPSexPF5VvK5gvoY4Ft7kXEmXtYR3hKuKgXvgsrVUGfpbrzP2h4J5V7QnrGkJQRnqJNSCDTS3P5ipKk32K?cluster=devnet) | 756 | 62158 | 5000 |
| rewards-round | forward the holders pot + fund_epoch_from_vault (a rewards round) | [`4LyFEYw2Kp…`](https://explorer.solana.com/tx/4LyFEYw2KpJNjZo6x7DmLGCxH7sFLD4TVUw7kpu6noC5zU8uJ21LK4FhxJE4e7mf9D9GFSU2kmxQgAaXbyRjUnke?cluster=devnet) | 756 | 48060 | 5000 |
| rewards-round | claim leaf 0 by 2ZouHQ… | [`3cUZav2x4W…`](https://explorer.solana.com/tx/3cUZav2x4WxP8heE6y22fbvzTQb1AG94Da2Fh1pC2FTz5PsqS28jNduNA69ARNSzPXDXdddnD5xg6ztRbhnQFy7B?cluster=devnet) | 573 | 26230 | 5000 |
| rewards-round | claim leaf 1 by AAMTJL… | [`2haXP3XGXv…`](https://explorer.solana.com/tx/2haXP3XGXvkmDYfHXRUSaJxfyTApKys3VUnDCLPCn39MWEruYtvk12ssc3hk1TY9z7RRseoCg9BnWkFXbZisUjrE?cluster=devnet) | 573 | 23226 | 5000 |
| push-to-holders | push batch 1/1 (2 holders) | [`66PW1jAohB…`](https://explorer.solana.com/tx/66PW1jAohBrG7d35ssBFpK94BBEoLaprG6a9pXwpAZgVeA1FYpxSjVG5Y1VfVpYyWyMpRam96v7pFpaPBjRzFEqH?cluster=devnet) | 518 | 9234 | 5000 |
| founder-claim | claim_founder_fees DEMO (founder A, paid in tVIC) | [`5dDayedwKm…`](https://explorer.solana.com/tx/5dDayedwKmy3dQe5sRMttcJT3BGZCyx4wbJQRxrAtJ2REAWr4n5ZvyaVmnHYSabA9vqw3Ua2VyrQFyV5rY5kZFtN?cluster=devnet) | 459 | 20691 | 5000 |
| payout | harvest_curve_fees DEMOT | [`3PeRagxNRx…`](https://explorer.solana.com/tx/3PeRagxNRx5QzFNS5zQyoNVEWb3Kb8P5vEMyo8s22r4RjgvpgTJFdARNFZ3ELyA3FErgA7VcvE8gqEbDvgYoVnDM?cluster=devnet) | 756 | 39844 | 5000 |
| payout | set_payout_config (payout key + the one payout wallet) | [`5MNRqqogQk…`](https://explorer.solana.com/tx/5MNRqqogQkB7oipkRCzjivtcieuYy4oC6bt5kocZYv7swPsDmnU1E8vrwMbdKjBmG51E2wc7FAdmTvfruUPBsmgM?cluster=devnet) | 317 | 6103 | 5000 |
| payout | opt_in_payout (founder B, signed, revocable) | [`2ovik2Got6…`](https://explorer.solana.com/tx/2ovik2Got6o3bEGYPSJPk7dUTpQ3bfS1Q9K8fCMFWZ5CSYKXmz3uUxvYWNhpQto3MkYTqDMpW43m1kToSQQ849nj?cluster=devnet) | 424 | 16505 | 5000 |
| payout | payout_founder_fees (payout key -> the fixed payout wallet only) | [`2WZgjWN9hB…`](https://explorer.solana.com/tx/2WZgjWN9hBFhJKx4wmbMAuHidyFQi1jR3ffsc7s9wnQgYSe7xu34qsAgYEBghsog5iMFce2YmiZ4gCR5HBaCFwsc?cluster=devnet) | 558 | 40541 | 5000 |
| payout | revoke_payout_opt_in (founder B) | [`3i73bVocw1…`](https://explorer.solana.com/tx/3i73bVocw1koSmKoYCs8ZJVS2m12jzrSW8jZZk7r5tczhP6r9PPeouvAhFNbT3qaDorzuCwEYDPcDnHhysuyEKXt?cluster=devnet) | 295 | 9331 | 5000 |
| payout | set_payout_config(zero, zero): payouts switched off again | [`46QUjoFPUe…`](https://explorer.solana.com/tx/46QUjoFPUeBYDMJcJf5KgZD8PWApsjfmipxzcAwrGxZNzCEMvXBgxJ57YA51eRBWeiEdVN7ysp7XmjhjZH1okUWS?cluster=devnet) | 317 | 5845 | 5000 |
| sweep | return leftover SOL from 3oXqUy… to the deployer | [`4MuJiJxUz5…`](https://explorer.solana.com/tx/4MuJiJxUz5x46jgNnSWxrqs9wL3X7UimSAHTtJY7tZCnRWzy2DWxWD1gTkzVTUGB1LHRKjrkDZWGb9hu2GHhwuRT?cluster=devnet) | 257 | 300 | 5000 |
| sweep | return leftover SOL from 91WeAy… to the deployer | [`UPhHHrDSjt…`](https://explorer.solana.com/tx/UPhHHrDSjtAeTGBaLkxR7y6uTBKFnaWyFjKYi3gmyGYAq36LUSuVwirFmDRkUKhdUgd8uELBa7DLWUx6VWDDKho?cluster=devnet) | 257 | 300 | 5000 |
| sweep | return leftover SOL from AAMTJL… to the deployer | [`4BhigQsFZp…`](https://explorer.solana.com/tx/4BhigQsFZpbw2Lc9d7wUDAeeKzNv62Hps7prXPE4VxjLCJ32FrseTBDedR3Tddxn73q4qMkmT8yxDqcXCu3WfkoD?cluster=devnet) | 257 | 300 | 5000 |
| sweep | return leftover SOL from 2ZouHQ… to the deployer | [`1v5LnJ2SZn…`](https://explorer.solana.com/tx/1v5LnJ2SZno4g5NgAnEZ1bdGmmFkUAvQhifwQVfVnyUxKo7LX5G3b1Q4EZyvSyKeq831zaukZNMrbSQErJ5WN5C?cluster=devnet) | 257 | 300 | 5000 |
| sweep | return leftover SOL from C66UDS… to the deployer | [`5yAt3R6o3p…`](https://explorer.solana.com/tx/5yAt3R6o3pNU38Fr5ae7gCxtCVghAvJaCyn7e6tZBwgsaqeS4HhKvU3dHE6gPpSomh5YGHn36U1TbbyppbX4KCHV?cluster=devnet) | 257 | 300 | 5000 |

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

## 4. What it cost (devnet SOL, no value)

| | SOL |
|---|---|
| the deployer before (after the owner's 5 devnet SOL, 7 Oct 2026) | 6.3665 |
| program deploy: program data deposit 2.2054 plus the program account and about 450 write fees | 2.2084 |
| the demo, net of the 0.445 lent to the demo wallets and swept back | 0.1816 |
| **the deployer after** (15:41 UTC) | **3.9764** |

The program's 2.2054 SOL deposit comes back with `solana program close` when
the devnet copy is retired.

## 5. How to run it again (on the build machine, which holds the throwaway keys)

```sh
cd solana
export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH
KEYS=<the scratch keys folder>        # throwaway keys only; never in git, never printed

# 1. deploy: checks devnet, the binary's SHA-256, the program address and the
#    SOL first; its own buffer key, so a failed run resumes; prints only the
#    program address and signature (the full output stays in $KEYS)
bash scripts/launchpad/deploy-devnet.sh "$KEYS"

# 2. the demo: skips every step the record marks done (--from <step> to redo from a step)
node scripts/launchpad/devnet-demo.mjs --keys "$KEYS" --state scripts/launchpad/devnet-demo-state.json

# 3. the tables for this file, with explorer links, compute and fees
node scripts/launchpad/devnet-record.mjs scripts/launchpad/devnet-demo-state.json
```

Without those keys (another machine), the same three commands work with a
fresh set of throwaway keys (named in the header of `devnet-demo.mjs`) and a
new record file, except that the program address is fixed by its own key:
deploying elsewhere means a new program address, `declare_id!` and rebuild.

## 6. What the run did (on devnet 7 Oct 2026; rehearsed before on a local validator)

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

## 8. Findings on devnet

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

5. **Public RPCs and the token programs (found in the devnet run, fixed the
   same day).** The free public RPCs (`api.devnet.solana.com`,
   `api.mainnet-beta.solana.com`) answer `getProgramAccounts` on the SPL Token
   and Token-2022 programs only through their mint and owner indexes (size
   165 or the token-account-state filter, plus the mint at offset 0 or the
   owner at offset 32); any other token-program scan is refused ("excluded
   from account secondary indexes"). The keeper's search for the city's pool
   position used an owner filter without the size filter, so the first
   devnet run stopped at the keeper step. Fixed:
   * the keeper (`sdk/launchpad/keeper.mjs`, `findCityPositions`) reads the
     Coin PDA's position NFTs with `getTokenAccountsByOwner`, which public
     RPCs answer; test TI08 runs it through a connection that refuses
     token-program scans exactly as Agave does (and checks the old query is
     refused) and gets the same positions and the same plan;
   * the holder snapshot already used the mint index (size 165 plus the mint
     at offset 0) and ran on the public devnet RPC in this demo; TE13 now
     checks that its query stays answerable there;
   * an independent review of the fix also raised the keeper's limit on
     position NFTs read per coin from 16 to 1,000 (anyone can send NFTs to a
     Coin PDA; pushing the real one past 16 would have cost about 0.035 SOL),
     and anything past the limit is now reported as a note instead of being
     skipped silently.

   Public RPCs also allow only about 10 `getTokenAccountsByOwner` calls per
   10 seconds, one per graduated coin per keeper pass, so the production
   keeper and the snapshot should run on a provider RPC (LAUNCHPAD.md
   section 9).

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
