# Vicinity Launchpad: build, test and measurement record

This file records what was built from `LAUNCHPAD-DESIGN.md`, how it was built,
what the tests showed, and what is still to do. It is for the owner and for an
outside auditor. Everything here was measured on the build machine on
6 October 2026. Nothing has been deployed anywhere yet, and nothing in this
work touched mainnet except read-only program dumps.

## 1. In plain English (for the owner)

* **7 October: three reviewers checked the work; everything they confirmed is
  fixed** (section 10). The most important: a price-curve setting could have
  given the dev wallet a hidden share of every coin (now impossible, the
  program refuses it); the website's trades depended on one account of your
  dev wallet that unwrapping SOL closes (now recreated automatically); and a
  dishonest answer from Jupiter could have drained a buyer (now every
  instruction in it is checked). All tests pass again (section 10.3).
* The launchpad program is written and passes all of its tests. It is a small
  Vicinity program on top of Meteora's audited bonding curve, exactly as the
  design describes: one coin per city, launched only by the founder you
  approve; every platform fee goes to your dev wallet `13qRam…`, which is now
  written into the program itself; the city's share of every trade is split
  50/50 between the city's holders and its founder; the founder can claim, or
  opt in to the dollar payout for X Money, which stays switched off until you
  set up a payout partner.
* People pay in SOL by default. Coins graduate into a Meteora trading pool at
  85 SOL, with the pool's liquidity locked for good.
* Graduation and holder rewards are finished:
  * a **keeper** program (`scripts/launchpad/crank.mjs`) graduates each coin
    as soon as its curve fills, sends the unsold dust to your dev wallet, and
    every day moves the city's fees on to the holders' rewards vault. Anyone
    could do these steps; the keeper just makes sure nobody has to wait. Its
    wallet only pays small fees and can touch nobody's money;
  * graduation cannot be blocked, cannot stop half way, and leaves nothing of
    yours or the city's behind inside Meteora (section 5.5). One small change
    from the design: the city now also collects its share of Meteora's
    "rounding surplus" (section 7, point 10);
  * a **snapshot tool** (`scripts/launchpad/snapshot.mjs`) picks the holders
    for each rewards round (it leaves out pools, your dev wallet and the
    founder), splits the money, and says to wait until a round can pay at
    least 20 holders 0.01 SOL each;
  * the tests now check, in every transaction, that the holders' money only
    ever moves to where the design says, all the way to each holder's own
    claim.
* The tests run the real Meteora and Metaplex programs (copied from mainnet)
  and the real rewards program, in one process: 101 launchpad tests, 18 SDK
  tests, 25 Rust unit tests, plus the existing rewards suites, all green.
* Not done yet: putting it on devnet (the test wallet needs about 1.5 to 2 more
  devnet SOL; section 6), the remaining helper scripts (config creation,
  setup, the devnet demo, the dev wallet's batch fee claims), and the website
  pieces. An outside audit is needed before mainnet.

## 2. What was built

| part | where |
|---|---|
| the program (18 instructions) | `programs/vicinity-launchpad/src` (`lib.rs`, `instructions/*`, `validate.rs` = design 7.2, `math.rs` = split, URL, ProgramData header, rewards-config reader) |
| Meteora interfaces it is compiled against | `idls/dynamic_bonding_curve.json` (DBC 0.2.1), `idls/cp_amm.json` (DAMM v2 0.2.4) |
| committed program interface | `sdk/idl/vicinity_launchpad.json` |
| SDK | `sdk/launchpad/`: `pda.mjs` (addresses), `config.mjs` (the Vicinity Meteora config via Meteora's `buildCurve`), `curve.mjs` (exact copy of DBC's swap maths for quotes, and of its surplus split), `client.mjs` (instruction builders: our 18, DBC `swap2` buy/sell exact in, exact out and partial fill, coin to coin, graduation, leftover, platform-fee and surplus claims, DAMM v2 swap and fee claim, `initRewardsForCoin`), `keeper.mjs` (the keeper's reading, planning and packing), `snapshot.mjs` (holder snapshot and rewards-round rules), `idl.mjs` |
| scripts | `scripts/launchpad/crank.mjs` (the keeper; plan-only unless `--send`, refuses mainnet without `--mainnet`), `scripts/launchpad/snapshot.mjs` (read-only: writes a round's file and CSV) |
| in-process tests | `tests-launchpad/01..11-*.test.mjs`, `helpers.mjs` (`assertInvariants`, `assertMoneyFlows`), `README.md` |
| fixtures | `scripts/launchpad/fetch-fixtures.sh` (mainnet dumps, pinned SHA-256; the dumps are gitignored), `tests-launchpad/fixtures/accounts/` (the DAMM v2 customizable config) |
| CI | `.github/workflows/solana.yml`: launchpad IDL diff, SDK tests, fixtures, in-process tests |

Program id (devnet and local, throwaway keypair kept outside the repository):
`Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7`. For mainnet the owner generates
a fresh keypair (design section 20).

## 3. Build

| item | value |
|---|---|
| toolchain | anchor-cli 0.31.1 (anchor-lang/anchor-spl 0.31.2 from the lockfile), solana-cli 4.3.0, cargo-build-sbf 4.4.0 (platform-tools v1.57), rustc 1.97.0, node 22.22.0 |
| `anchor build` (production, no features) | `target/deploy/vicinity_launchpad.so`, 433,960 bytes, SHA-256 `8706e3bfb1dc7b39a5790586144327267cdb5336ed34a541504723811e0e27f0` after the review fixes of section 10 (before them: 432,408 bytes, `a0fc828c…7378b`; before the surplus collection of section 7, point 10: 427,176 bytes, `5b8ced51…`) |
| IDL | 107,109 bytes, SHA-256 `e5ee932049723d60c7e6d3d9729f5cd26a6ff39a10ad05bf77b4e432485291ec` (`target/idl` = `sdk/idl`; before the review fixes 106,277 bytes, `1bc0de29…237c`) |
| `vicinity_rewards` after this work | rebuilt: 505,864 bytes, SHA-256 `f0fbc9d53ed092210eef3f97047644d6f796d634bf11c428795ff8b0b1e509a3`, identical to the hash recorded in AUDIT.md; its IDL is unchanged; its `short-windows` test build also matches AUDIT.md (`add08669…ebf98`) |
| rent for the program (devnet, `solana rent 434005`) | 2.20539564 SOL for the ProgramData account at `--max-len` = size, plus the program account; `deploy-devnet.sh` asks for 2.22622876 SOL in all, with 0.02 SOL of fee margin |

**Size.** The design targeted 300 KB or less. The production binary is 427 KB.
What was done to get there from 586 KB:

* `opt-level = "z"` for this crate only (`[profile.release.package.vicinity-launchpad]`
  in `Cargo.toml`); `vicinity_rewards` keeps opt-level 3 and its recorded hash;
* `anchor-spl` without its default features (no Token-2022 extension code);
* the Token-2022 position NFT account is read by hand (`math::read_token_account_base`);
* the ProgramData header is parsed by hand (no Anchor `ProgramData` type).

The rest is the 18 instructions themselves (each Anchor account struct with its
constraints is 3 to 13 KB of code) plus Anchor's own on-chain IDL instructions.
Building with the `no-idl` feature would remove the latter, but then the IDL
cannot be published on chain, which Solscan needs (design 8.4), so it was left
in. Cost of the extra size: about 0.65 SOL of rent at deploy.

## 4. Tests

| suite | command (from `solana/`) | result |
|---|---|---|
| Rust unit tests, both crates | `cargo test` | launchpad 27 passed (every rule of 7.2 broken one field at a time, including rule 13, the 50/50 split with a 200,000-case property loop and an additivity loop, names (with the formatting characters), tickers, the URL, the ProgramData header, the rewards-config reader, the token-account reader, the three separate payout keys); rewards 29 passed |
| clippy and fmt | `cargo clippy --all-targets -- -D warnings`, the same with `--features short-windows`, `cargo fmt --all -- --check` | clean |
| launchpad in-process suite | `npm run launchpad:fixtures` once, then `npm run test:launchpad` | 119 passed, about 55 s (106 for the program, 13 for the client SDK; 112 before the review fixes of section 10); every invariant of design section 15 checked after every successful transaction, invariant 8 from the token instructions that actually ran. Also 119 passed on Meteora's devnet builds |
| launchpad SDK | `npm run sdk-test:launchpad` | 55 passed, 4 skipped (the live Jupiter tests, opt-in with `npm run test:jupiter-live`: 4 passed); includes 5,000 random trades per quote type on the maths alone, the keeper's planning rules, the snapshot rules (time-weighting, per-token minimum), the design 9.5 numbers through `quote.mts`, the metadata file, Jupiter composition from recorded answers and 26 hostile Jupiter answers, airdrop batching and payout planning |
| launchpad TypeScript SDK | `npm run typecheck:launchpad` | clean |
| existing SDK and types | `npm run sdk-test`, `npm run typecheck` | 47 passed; clean |
| `vicinity_rewards` Anchor suite | see below | 144 passing, 0 failing, 0 pending (8 min) |

The rewards suite needs a validator. `anchor test` would start one on its
default ports, and this machine shares ports 9001-9008 with another job, so it
was run the way `tests/README-tests.md` allows ("`npm test` against a running
validator with the program deployed"): the `short-windows` test build, a
hand-started validator with `--reset`, both copies of the program loaded
upgradeable with the test wallet as upgrade authority, on ports 18899 (RPC),
19900 (faucet), 18001 (gossip) and 18002-18040, then
`ANCHOR_PROVIDER_URL=http://127.0.0.1:18899 ANCHOR_WALLET=~/.config/solana/id.json npm test`.
The validator was stopped and its ledger deleted afterwards, and the
production rewards binary was rebuilt (same hash as above).

The property test (TD11) was also run with seeds 1, 777, 424242 and 99 at 400
steps each: every one traded the curve to completion with the copy of DBC's
maths matching the real program to the raw unit after every trade.

## 5. Measurements

### 5.1 Compute units and transaction sizes (in-process, real Meteora programs)

| instruction | CU | bytes (with a compute-budget instruction) |
|---|---|---|
| `init_launchpad` | 12,991 | 546 |
| DBC `create_config` (the Vicinity config) | 36,992 | 703 |
| `add_launch_config` | 14,710 | 482 |
| `approve_launch` | 20,612 | 558 |
| `launch` (creates the coin through DBC and Metaplex) | 154,600 to 173,704 | 1,049 |
| DBC `swap2` buy, exact in, with the dev wallet referral | 32,994 | 731 |
| DBC `swap2` sell, exact in | 28,151 | 699 |
| coin to coin (two `swap2` in one transaction, with referral) | 64,033 | 934 (the limit is 1,232) |
| `harvest_curve_fees` (first time, creates the coin's own account) | 66,739 to 70,616 | 756 (723 before the `dbc_config` account) |
| `harvest_curve_fees` (nothing to claim) | 41,334 | 756 |
| `harvest_curve_fees` (the one that also collects the city's surplus) | 64,573 | 756 |
| `forward_holders_fees` | 22,726 | 458 |
| `claim_founder_fees` (creating the founder's account) | 33,388 | 555 |
| `set_payout_config` / `set_pause` | 6,024 / 5,527 | 413 / 352 |
| `opt_in_payout` / `revoke_payout_opt_in` | 24,005 / 9,331 | 520 / 391 |
| `payout_founder_fees` (creating the payout wallet's account) | 45,048 | 558 |
| DBC `swap2` partial fill up to graduation | 32,840 | 699 |
| DBC `migration_damm_v2` (graduation crank) | 237,000 to 266,000 | 1,109 |
| keeper, minute pass after a curve fills: graduation, then leftover + harvest + forward in one transaction | 243,185, then about 160,000 | 1,109, then 973 |
| keeper, daily pass, ten coins' harvest + forward | 7 transactions | 878 to 1,170 each |

### 5.2 Money and rent

* A launch cost the founder 0.0812 SOL in the test VM, which uses the old rent
  rate (6,960 lamports per byte); at today's rate (5,080) that is about
  0.076 SOL: 0.05 SOL launch fee, 0.01 SOL Metaplex fee, and rent for the
  `Coin` record, its two token accounts, the DBC pool, its vaults, the mint and
  the metadata.
* The graduation crank cost the cranker 0.0325 SOL (32,518,200 lamports, rent
  of the DAMM v2 accounts plus fees).
* The keeper wallet spent 0.0468 SOL over the nine transactions of test
  10-keeper (one graduation, the dev wallet's coin account, fees), in the test
  VM's old rent rate.

### 5.3 What DBC stored for the default config (85 SOL)

* `swap_base_amount` = 793,099,988.517386 coins; `migration_base_threshold` =
  206,900,002.375753 coins; `migration_sqrt_price` = 373894382314756693, equal
  to the `curve[0]` point from `buildCurve`.
* The 9.5 worked examples hold to the raw unit against the real program:
  1 SOL buys 34,193,903.663504 coins; selling them back returns 0.975156249 SOL;
  10,000,000 coins cost 0.285793789 SOL; filling the curve costs 86.075949368
  SOL for 793,099,988.517385 coins.

### 5.4 Graduation (test TG01-TG05)

* The DAMM v2 pool opens at exactly the curve's last price (sqrt price
  373894382314756693) with 206,486,202.368568 coins and 84.83 SOL; fee 1.25%
  (12,500,000 out of 10^9), fees in SOL only, no dynamic or compounding fee;
  DAMM v2's protocol share is 20% of the pool fee.
* Positions: the `Coin` PDA's holds 38,602,015,546,194,733,828,948,087,007,830
  permanently locked liquidity plus **1 unit unlocked** (DBC rounds the lock
  down); the dev wallet's holds 38,602,015,545,284,630,904,364,926,950,564,
  all locked. The one unlocked unit is about 10^-32 of the pool, and our
  program has no instruction that removes liquidity, so it can never move.
* Pool fees after some trading: the city's position earned 51,231,118
  lamports and the dev wallet's 51,231,117 (close to half each, as the design
  says).
* Leftover: 9.109297 coins went to the dev wallet with `withdraw_leftover`;
  the supply stayed exactly 10^15.

### 5.5 Graduation defences and the keeper (tests TG09-TG14, TI01-TI06)

* **Surplus.** A curve filled by one partial-fill buy from the start ends
  exactly on its target (surplus 0). Every trade rounds a fraction of a
  lamport in the curve's favour: 1 lamport after a few buys, 43 after 240
  random trades (city 17, dev wallet 17, Meteora 9), 117 to 125 after about
  600. `harvest_curve_fees` collects the city's share exactly once, before or
  after graduation (TG09); a stranger posing as the creator is refused by DBC
  (`Unauthorized`, TG12).
* **Pre-funded addresses.** With 0.00089 SOL, 0.5 SOL and 0.002 SOL sent in
  advance to the pool and its two vault addresses, graduation succeeded
  (264,168 CU) and opened a pool identical, to the unit, to one graduated
  without the donations (TG10, TG11).
* **Atomic.** A graduation that ran out of compute at 120,000 CU, and one whose
  payer held 0.02 SOL and could not repay DBC's rent loan ("insufficient
  lamports 19985000, need 22606080"), each left no pool and no change in the
  curve or its vaults; a retry by another wallet succeeded (TG11). A second
  graduation is refused (`NotPermitToDoThisAction`), a second leftover too
  (`LeftoverHasBeenWithdraw`).
* **Nothing left behind.** After graduation, every claim, the leftover and the
  city's harvest, forward and founder claim: DBC's quote vault held exactly
  1.419892179 SOL and its base vault 413,800.004751 coins, both exactly
  Meteora's own protocol fees, surplus share and 0.2% migration fee; the
  city's pot, vault and coin account were empty (TG13). The dev wallet got its
  17-lamport surplus share and 9.109366 coins of leftover (TG14).
* **Keeper.** One minute pass graduated a coin, sent the leftover to the dev
  wallet (creating its coin account), collected fees and surplus and forwarded
  the holders' half, in two transactions; the next pass found nothing; a daily
  pass then forwarded 0.0162 SOL of pool fees (TI02). It found the city's
  position after a stranger ran the graduation with its own NFT keys (TI03).
  It reported, and did not send, coins with no rewards config or a Split
  config, and forwarded the waiting pot once the config was fixed (TI01).

### 5.6 Where the holders' money can go (tests TE10-TE13)

* Every successful transaction of the whole suite is checked from the token
  instructions that actually ran (`assertMoneyFlows`): money left a holders
  pot only to its founder vault or its city's checked rewards vault, a founder
  vault only to the founder or the agreed payout wallet, and a Holders-only
  rewards vault only inside a holder's own claim, to that holder.
* All 21 token accounts of a busy test world, tried as the destination of a
  forward, a harvest, a founder claim and a payout: 80 substitutions refused,
  no balance moved, and the designed destinations then worked (TE11).
* Every field of a city's rewards config changed one at a time: the 10 changes
  to fields `forward_holders_fees` relies on (type, coin, reward token, vault,
  model Creator/Split/invalid, founder share 1/2,500/10,000 bps) were refused
  with `WrongRewardsConfig`; the 16 changes to the rewards authority's own
  bookkeeping (authority, founder, pause, totals, tag, bumps) were accepted
  (TE12).
* End to end (TE13): nine holders, graduation, harvest and forward put
  0.230898133 SOL in the city's rewards vault. The snapshot, through the
  script's own code path, excluded the dev wallet, the founder and both
  Meteora vault authorities; the default gate said to wait (nine holders, not
  twenty); with the gate lowered to five, all nine were paid at least 0.01 SOL
  by `fund_epoch_from_vault` and `claim`, 5 lamports of rounding stayed for the
  next round, and the founder received nothing from the holders' round.

## 6. Devnet (not done in this step)

The program is not deployed yet. The throwaway deployer
`9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa` holds about 1.39 devnet SOL; the
program needs 2.20 SOL of rent and, during the deploy, a buffer of the same
size (returned afterwards). **The owner should send about 2 devnet SOL to that
address** (faucet.solana.com), or the deploy can use `--max-len` equal to the
size and a fresh buffer keypair once the balance allows it. Design section 19
has the full demo plan; before it, dump the devnet DBC and DAMM v2 binaries
and compare them with the pinned mainnet hashes.

## 7. Differences from the design, and limits an auditor should know

1. **Graduating too early** is refused by DBC 0.2.1 with
   `NotPermitToDoThisAction`, not `PoolIsIncompleted` as the design guessed
   (test TG07 accepts both).
2. **One unit of unlocked liquidity** in the `Coin` PDA's position (5.4).
3. **Error order.** Anchor creates `init_if_needed` accounts and loads every
   account before it runs the other constraints, so a few substitution attacks
   are refused with Anchor's own error (`ConstraintTokenMint`,
   `ConstraintSeeds`, `AccountNotInitialized`, or the associated-token program
   refusing a wrong account) rather than ours. The tests accept either and
   check that no balance moved.
4. **Unreachable checks kept on purpose.** The pool check after the launch CPI
   (`PoolCreatorMismatch`) cannot fail while DBC behaves, and `MathOverflow`
   cannot be reached with real token amounts; both are defence in depth.
5. **Size** 432 KB instead of 300 KB (section 3).
6. **The dev wallet in tests.** `FEE_RECIPIENT` is a constant and the tests
   have no key for it, so the few transactions it signs (platform-fee claims,
   a refused liquidity removal) run with litesvm's signature check off for
   that one transaction (`World.sendAsDevWallet`); every other transaction is
   signature-checked.
7. **Config rules tested on bytes.** The rule tests rewrite one field of a real
   DBC config account at a time (the byte layout comes from the IDL), because
   DBC itself refuses many of those configs at `create_config`; this is what
   our on-chain check reads. A few cases also go through a real
   `create_config`.
8. **Trading is DBC's.** Buy, sell (exact in, exact out, partial fill) and
   coin to coin are DBC `swap2` instructions built by the SDK; our program
   never prices or holds curve money. The curve properties (the curve stays
   solvent, no coin leaves the curve for free, fees exact, rounding always in
   the pool's favour, a round trip never profits) are therefore asserted on
   the real DBC program after every random trade in TD11, and on the SDK's
   copy of the maths in `sdk/launchpad/curve.test.mjs`.
9. **Built since** (section 9): the setup script (`setup.mjs`, in place of
   `create-dbc-config.mjs` and `init-launchpad.mjs`), `devnet-demo.mjs`,
   `claim-platform-fees.mjs` and the pay-with-anything composer. **Still not
   built:** all website work (including the scheduled snapshot job, the claim
   page and the signing pages).
10. **Design change: the city collects its graduation surplus.** The design
    said the city's share of DBC's rounding surplus would stay in DBC ("a few
    lamports"). Measured, it grows with trading (5.5), so `harvest_curve_fees`
    now calls DBC `creator_withdraw_surplus` once, after the curve completes,
    into the holders pot (design 10.5). This adds one CPI signed by the `Coin`
    PDA, the coin's `dbc_config` account (owner and type checked, and pinned
    to `coin.dbc_config`) and a `surplus` field in `FeesHarvested`. The
    decision to call it reads DBC's own completion test and its once-only
    flag; DBC enforces both again. 5,232 bytes of program.
11. **Graduation is one instruction.** DBC 0.2.1's
    `migration_damm_v2_create_metadata` is deprecated and does nothing, and
    Vicinity configs have no locked vesting, so there is no `create_locker`
    step: completion sets the curve straight to "ready to migrate" (progress 2)
    and `migration_damm_v2` takes it to "pool created" (3) in one atomic step.
12. **What can never move** (all dust or strangers' donations): 1 unit of
    unlocked liquidity in the city's position; coins donated to the `Coin`
    PDA's own coin account; quote tokens donated straight to a DBC vault.
13. **Keeper limits.** It cannot tell in advance whether a DAMM v2 position has
    fees waiting, so the daily pass always includes `harvest_pool_fees` for
    graduated coins (a no-op when empty). Its compute allowance per step is
    about twice what the tests measured, because address derivations cost
    more for some addresses than others.

## 8. Reproduce

```
cd solana
npm ci
anchor build                       # both programs; hashes in section 3
cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --all -- --check
npm run launchpad:fixtures         # mainnet dumps, checked against pinned hashes
npm run test:launchpad             # 119 tests, no validator
npm run sdk-test:launchpad && npm run sdk-test && npm run typecheck && npm run typecheck:launchpad
NETWORK=devnet npm run launchpad:fixtures && LAUNCHPAD_PROGRAMS_DIR=tests-launchpad/fixtures/programs-devnet npm run test:launchpad
npm run test:jupiter-live          # optional: read-only calls to Jupiter's mainnet API
```

## 9. Client SDK, scripts and devnet (7 Oct 2026)

### 9.1 What was added

| part | where |
|---|---|
| typed SDK (TypeScript, run directly by Node 22; `index.mts` exports all) | `sdk/launchpad/accounts.mts` (decoders and fetchers), `quote.mts` (quotes, slippage bounds, the 50/50 split, prices), `trade.mts` (launch with first buy, buy, sell, exact out, coin to coin, graduation, DAMM v2 trades, SOL wrapping, v0 transactions, sizes), `metadata.mts` (design 8.2 JSON, Meteora partner metadata), `lookup-table.mts`, `pay-assets.mts` and `jupiter.mts` (pay with anything, sell into anything), `rewards.mts` (unsigned airdrop batches, funding a round, claims), `payout.mts` (founder claim, opt-in, revoke, payout, planner), `platform-fees.mts` (the dev wallet's claims); `pda.d.mts` and `curve.d.mts` type the JavaScript; `tsconfig.json` (`npm run typecheck:launchpad`, in CI) |
| recorded Jupiter answers | `sdk/launchpad/fixtures/jupiter-build-*.json` (mainnet `/swap/v2/build`, 6 Oct 2026, taker = the throwaway devnet deployer's public address) |
| scripts | `scripts/launchpad/setup.mjs`, `claim-platform-fees.mjs`, `devnet-demo.mjs`, `lib.mjs` |
| tests | `tests-launchpad/12-client-sdk.test.mjs` (TJ01-TJ09), `13-rewards-payout-tools.test.mjs` (TK01-TK05), `sdk/launchpad/*.test.mts`, `jupiter.live.test.mts` (opt-in) |
| devnet fixtures | `NETWORK=devnet npm run launchpad:fixtures` with pinned devnet hashes; `LAUNCHPAD_PROGRAMS_DIR` in `helpers.mjs` |

### 9.2 Results

* In process, 112 tests pass (101 before, plus 7 in file 12 and 4 in file
  13), with every invariant checked after every transaction as before.
* **Quote parity** (TJ03): 240 random trades over three curves (102 exact-in
  buys, 2 partial fills, 35 exact-out buys, 72 exact-in sells, 29 exact-out
  sells), quoted by `quote.mts` from the decoded chain state and sent with the
  `trade.mts` builders: coins, quote, new price, Meteora's share, the dev
  wallet's share, the city's share and the referral matched the real program
  to the raw unit every time. 68 trades were also sent one unit tighter than
  the SDK's 0-slippage bound and Meteora refused every one
  (`ExceededSlippage`). 22 harvests split exactly as `splitHarvest` predicted,
  including the city's surplus share after each curve filled.
* **Sizes** (bytes of 1,232): launch with the founder's first buy 1,173
  without the Vicinity lookup table, 959 with it (one transaction either way
  for a SOL-priced coin); coin to coin 929; pay with anything with a stand-in
  swap 929; from the recorded Jupiter answers: cbBTC to SOL to a coin 1,102
  (981 with the Vicinity table), a coin to SOL to cbBTC 1,220, cbBTC to
  VICINITY to a VICINITY-priced coin two transactions (1,034 + 526), as the
  design expected. Live (6-7 Oct 2026): cbBTC, ETH and SPYx quotes into SOL
  all routed; a live cbBTC plan fitted one transaction at route size 40
  (1,112 bytes with the Vicinity table).
* **Airdrop batches**: nine recipients per transaction (1,155 bytes) when
  every recipient needs a new token account.
* **Platform fees** (TK05): six claims (two trading-fee claims, two
  launch-fee claims, a surplus share and a DAMM v2 position) in two
  transactions (971 and 702 bytes); nothing claimable afterwards.
* **Meteora's devnet programs differ from mainnet's** (DBC 1,983,568 bytes,
  SHA-256 `f5ccbb01…`, deployed in slot 503,167,099; DAMM v2 `82bb9375…`;
  Metaplex `bb0842f6…`). The whole suite, including files 12 and 13, passes
  on both the mainnet and the devnet builds.
* **Local rehearsal.** Before touching devnet, `devnet-demo.mjs` ran end to end
  on a local validator (ports 18899/19900/18001/18002-18040) loaded with the
  devnet builds of Meteora's and Metaplex's programs and our two programs:
  all 23 steps passed; the deployer spent 0.258 SOL net (0.55 SOL at the
  peak, before the demo wallets returned their SOL). The ledger was deleted.
  One transaction was dropped by the local validator once and confirmed on
  the retry; `lib.mjs` now re-signs and resends a transaction whose blockhash
  expired without it landing (safe: an expired transaction can never land).


### 9.3 Devnet (7 Oct 2026, 00:47-01:00 UTC)

Recorded in full in `LAUNCHPAD-DEVNET.md`.

* **Re-run before touching devnet** (after a container restart): 112/112
  in-process tests, 44/48 SDK tests (4 are the opt-in live Jupiter tests), 47
  rewards SDK tests, 25 + 29 Rust unit tests, both typechecks, and the 4 live
  Jupiter tests (read-only): all green. The production binary is unchanged
  (`a0fc828c…7378b`), and the `vicinity_rewards` binary dumped from devnet is
  byte-identical to today's build (`f0fbc9d5…09a3`).
* **On devnet:** the tVIC test token (no mint or freeze authority), both
  Vicinity DBC configs (fee claimer and leftover receiver = the dev wallet,
  1.25%, launch fee 0.01 SOL), the dev wallet's referral accounts and the
  Vicinity lookup table: nine transactions, 0.0285 SOL.
* **Replayed:** new opt-in test file 14 (TL01-TL02) reads those accounts from
  devnet and runs them through `add_launch_config`, launches, trades, a full
  curve, a harvest and a graduation in process, on Meteora's devnet builds
  and on the mainnet builds: 2/2 pass on each, invariants checked after
  every transaction.
* **Found:** devnet refused `CreateLookupTable` with the finalized slot ("is
  not a recent slot"); the SDK's new `recentSlotForLookupTable` picks a
  produced slot a few behind the tip.
* **Not deployed:** `vicinity_launchpad` needs 2.2183 SOL (checked by
  `scripts/launchpad/deploy-devnet.sh`, which refused cleanly: "needs
  2.218344600 SOL, the deployer has 1.366462080 SOL"); the rest of the demo
  about 0.50 SOL at its peak. The faucet refused all 23 requests from this
  machine between 6 Oct 23:30 and 7 Oct 00:57 UTC. Pending: about 1.35 SOL
  (1.5 requested from the owner).

## 10. First code review and its fixes (7 Oct 2026)

Three reviewers looked at the branch: the maths and economics, the accounts
and CPIs, and the owner's journey end to end. Their confirmed findings and
the nits that were plainly right are fixed below; each fix has a test that
fails on the code before it and passes after (checked by running the new
tests against the earlier binary or the earlier SDK files). The program was
rebuilt; `vicinity_rewards` is unchanged (same hash).

### 10.1 Confirmed findings

| finding | what was wrong | fix | regression test | commit |
|---|---|---|---|---|
| math-econ R1 (high) | rule 7.2 put no limit on DBC's leftover, so a config could hand the dev wallet half of every coin (measured: 500,000,003 coins, sold for 70% of the pool's SOL) | rule 7.2(13): `supply - swap_base_amount - migration_base_threshold` (checked u128) must be at most `MAX_LEFTOVER_RAW` = 1,000 coins; new error `ConfigLeftover` (last in the enum, so earlier codes keep their numbers); checked at `add_launch_config` and at every `launch` | Rust `rule_13_leftover`; TB17 (real configs with 500,000,000 and 1,001 coins left over refused; exact cap passes, one unit more fails; underflow refused; re-checked at launch) | `85cac45` |
| math-econ R2 (medium), owner-e2e F1 (high) | every site trade failed while the dev wallet's quote-token (referral) account was missing; nothing created it on mainnet, and unwrapping SOL in the dev wallet closes it | every builder prepends an idempotent create of the dev wallet's account (buy, buy exact out, sell, coin to coin, launch with first buy, pay with anything in both modes, sell into anything); `setup.mjs referral-accounts`; the keeper recreates it on every pass; owner guide and checklist say never to close it | TJ11 (the dev wallet closes it, then every builder succeeds and brings it back; `referral: null` still works); TI07(a); keeper unit test | `1075b4f`, `268690f` |
| math-econ R3 (low) | holder rewards came from one slot's balances, so a flash holder at the snapshot slot took part of the pot at a profit | each holder counts with min(balance at the cutoff, average of samples taken at random times; `snapshot.mjs --sample`); fewer than 6 samples: not fundable; the file records the sample slots | TE14 (a flash holder's 3,076,693,262-lamport share of a 4 SOL pot becomes 0; a half-seller counts with what it holds; a sample of another coin refused); unit tests | `2092df1` |
| math-econ R4 (low) | the airdrop CSV used 9 decimals for WSOL and 6 for everything else | the reward token's decimals are read from its mint | TE15 (a 9-decimal, authority-free quote token: the CSV now matches the leaves) | `2092df1` |
| accounts-cpi LP-ACPI-1 (medium) | `checkJupiterBuild` allowed any System, Token or Token-2022 instruction and checked the output by membership, so a hostile answer could send SOL away, approve a stranger, close the WSOL account to a stranger, redirect the output, or set a 600-SOL priority fee | the swap must be `route_v2` or `shared_accounts_route_v2`, decoded by position (authority, source, destinations, mints, token programs, `in_amount`, `quoted_out_amount`, `slippage_bps`, no platform fee or positive-slippage cut) and must match the JSON and the buyer's amount; helpers allow-listed by opcode and accounts; the priority fee capped at 0.01 SOL, also in `toV0Transaction`; the sell path accepts Jupiter's close only back to the trader | 26 hostile cases in `jupiter.test.mts` (each of the reviewer's: SOL to a stranger, Approve, ApproveChecked, Transfer, SetAuthority, Token-2022, close to a stranger, output redirected with a decoy, input from a stranger, wrong mints, changed amounts, slippage, platform fee, exact-out route, ...); the priority-fee cap; live answers for cbBTC, ETH, SPYx, USDC, STONK, WBTC and VICINITY all still pass (read-only) | `1075b4f` |
| accounts-cpi LP-ACPI-2 (low) | the "three separate keys" rule could be broken through an admin hand-over | `propose_admin` and `accept_admin` apply the same check as `set_payout_config` (`math::check_payout_keys_separate`); the payout wallet may also not be the dev wallet (optional hardening, now in design 6.1 and 13.2) | TA08 (both orders, cancel, a separate key, payouts off); a TA06 case; invariant 12 extended; Rust unit test | `b094132` |
| owner-e2e F2 (medium) | pay with anything always bought exact in and never looked at the curve: refused near graduation; in two-transaction mode the asset could be sold and the buy then fail | every curve buy is a partial fill; a full or graduated curve is refused before Jupiter is asked; step 2 of the two-transaction mode is rebuilt from the live pool (`buildBuyAfterSwap`) | TJ10 (near graduation the buy fills and refunds; a full curve is refused before the swap; the curve fills between the two transactions and the buyer keeps the SOL; a calm curve's rebuilt buy gets exactly the re-quote); `jupiter.test.mts` | `1075b4f` |
| owner-e2e F3 (low) | stock tokens were hidden in only four countries | an allow-list that fails closed (default EEA and Switzerland, pending a lawyer) plus a block-list of the issuer's excluded and sanctioned countries | the pay-with list test (the reviewer's 13 countries, unknown, `XX`, `T1`) | `372c74e` |
| owner-e2e F4 (low) | the owner guide omitted X Premium and the New York / Massachusetts gap | documented (LAUNCHPAD.md section 7, design 13.4) | (documentation) | docs commit |

### 10.2 Nits

| nit | outcome |
|---|---|
| math-econ N1 (exact-in buys fail at the end of a curve) | fixed with F2: every curve buy is a partial fill (also the JavaScript `coinToCoin`) |
| math-econ N2, owner-e2e N4 (raw 0.01 SOL minimum for every token) | fixed: an explicit minimum is required for reward tokens other than SOL (TE15, unit test) |
| math-econ N3 ("half of the pool fees") | reworded: half of the fees earned by the locked graduation liquidity |
| math-econ N4, owner-e2e N7 (program-address owners never get rewards) | documented in the published rules and the owner guide; `--include` adds a multisig vault by hand |
| math-econ N5 (8.1 claimed an unenforced leftover) | fixed by rule 13; 8.1 names it |
| math-econ N6 (a 1-lamport buy for 0 coins) | fixed: quotes and builders refuse a trade that returns nothing (`4c62e3c`) |
| accounts-cpi N1 (`enable_first_swap_with_min_fee`) | fixed in rule 5 (TB05 case, unit test) |
| accounts-cpi N2 (surplus bundled with the fee harvest) | **skipped.** A separate `collect_curve_surplus` instruction is a program and keeper change for a risk that needs a Meteora upgrade to appear: the surplus call only runs once a curve is complete and while DBC's own flag says it is unpaid, and any Meteora upgrade must be re-tested before use anyway (design section 20, step 1; the fixtures pin DBC's hash). If it ever failed, an upgrade of our program could split it out without any state change. Recorded here for the auditor |
| accounts-cpi N3 (invisible characters in names) | fixed (`2ffe2f0`, TC02 cases, unit test) |
| accounts-cpi N4 (payout record only in logs) | documented: the payout service reconciles from `Coin.payout_seq`, `Coin.founder_paid_out` and each payout's token transfer, not from logs. `emit_cpi!` was not used because it adds two accounts to three instructions and changes their interface for a record the accounts already hold |
| accounts-cpi N5 (keeper harvests strangers' positions) | fixed: only the coin's own pool, at most 16 NFTs read per coin, the rest reported (TI07, unit test) |
| accounts-cpi N6 (Meteora per-pool metadata) | documented as deliberately left out (design 8.3); an upgrade can add it later because the `Coin` PDA stays the creator |
| owner-e2e N1 (Jupiter label also on look-alike coins) | documented (LAUNCHPAD.md section 4) |
| owner-e2e N2 (the site cannot serve coin metadata yet) | listed as a launch blocker (design 20 step 9, LAUNCHPAD.md sections 4 and 9); the website change itself is website work |
| owner-e2e N3 (deploy SOL overstated) | corrected: about 2.23 SOL at the peak |
| owner-e2e N5 (inconsistent byte counts) | replaced by "usually one transaction with the Vicinity lookup table, two without it" |
| owner-e2e N6 (VICINITY routes only at 64) | fixed: every pay-with tries 40, 32, 24, then 64; a live VICINITY payment planned at 40 as one transaction (1,126 bytes) |
| owner-e2e N8 (a lost founder key loses the 0.25%) | documented (LAUNCHPAD.md section 7, design 13.2) |

### 10.3 Build and results after the fixes

* `anchor build`: `vicinity_launchpad.so` 433,960 bytes (1,552 more), SHA-256
  `8706e3bfb1dc7b39a5790586144327267cdb5336ed34a541504723811e0e27f0`; IDL
  107,109 bytes, SHA-256 `e5ee9320…91ec` (`target/idl` = `sdk/idl`);
  `vicinity_rewards.so` unchanged (`f0fbc9d5…09a3`).
* Rust: launchpad 27 and rewards 29 unit tests pass; `cargo clippy
  --all-targets -- -D warnings` (with and without `short-windows`) and
  `cargo fmt --all -- --check` are clean.
* In process: 119 of 119 on Meteora's mainnet builds and 119 of 119 on its
  devnet builds (TA08, TB17, TE14, TE15, TI07, TJ10 and TJ11 are new), every
  invariant checked after every transaction.
* SDK: 55 passed and 4 opt-in live tests skipped (`npm run
  sdk-test:launchpad`); `npm run sdk-test` 47 passed; both typechecks clean.
* Read-only live checks: `npm run test:jupiter-live` 4 of 4 (a live cbBTC
  plan: one transaction, 1,124 bytes with the Vicinity lookup table), and live
  Jupiter answers for ETH, SPYx, USDC, STONK, WBTC and VICINITY all pass the
  stricter checks and plan as one transaction (1,041 to 1,223 bytes);
  `npm run test:devnet-accounts` 2 of 2 (the devnet configs pass the new rule
  13: they leave about 84 and 0.5 coins over).
* `vicinity_rewards` Anchor suite on a local validator (short-windows test
  build, ports 18899/19900/18001/18002-18040, ledger deleted afterwards):
  144 passing, 0 failing, 0 pending (8 min); the production binary was rebuilt afterwards with the
  same hash.
* Devnet: still not deployed. `deploy-devnet.sh` (now pinned to the new hash)
  refused cleanly: "needs 2.226228760 SOL, the deployer has 1.366462080 SOL";
  four more faucet requests between 02:05 and 02:20 UTC were refused.
  Pending: about 1.36 devnet SOL (0.86 for the program, 0.50 for the demo);
  `LAUNCHPAD-DEVNET.md` section 4.
