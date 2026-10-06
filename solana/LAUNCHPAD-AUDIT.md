# Vicinity Launchpad: build, test and measurement record

This file records what was built from `LAUNCHPAD-DESIGN.md`, how it was built,
what the tests showed, and what is still to do. It is for the owner and for an
outside auditor. Everything here was measured on the build machine on
6 October 2026. Nothing has been deployed anywhere yet, and nothing in this
work touched mainnet except read-only program dumps.

## 1. In plain English (for the owner)

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
* The tests run the real Meteora and Metaplex programs (copied from mainnet)
  and the real rewards program, in one process: 84 launchpad tests, 7 SDK
  tests, 25 Rust unit tests, plus the existing rewards suites, all green.
* Not done yet: putting it on devnet (the test wallet needs about 1.5 to 2 more
  devnet SOL; section 6), the helper scripts for running it, and the website
  pieces. An outside audit is needed before mainnet.

## 2. What was built

| part | where |
|---|---|
| the program (18 instructions) | `programs/vicinity-launchpad/src` (`lib.rs`, `instructions/*`, `validate.rs` = design 7.2, `math.rs` = split, URL, ProgramData header, rewards-config reader) |
| Meteora interfaces it is compiled against | `idls/dynamic_bonding_curve.json` (DBC 0.2.1), `idls/cp_amm.json` (DAMM v2 0.2.4) |
| committed program interface | `sdk/idl/vicinity_launchpad.json` |
| SDK | `sdk/launchpad/`: `pda.mjs` (addresses), `config.mjs` (the Vicinity Meteora config via Meteora's `buildCurve`), `curve.mjs` (exact copy of DBC's swap maths for quotes), `client.mjs` (instruction builders: our 18, DBC `swap2` buy/sell exact in, exact out and partial fill, coin to coin, graduation, platform-fee claims, DAMM v2 swap and fee claim), `idl.mjs` |
| in-process tests | `tests-launchpad/01..08-*.test.mjs`, `helpers.mjs` (`assertInvariants`), `README.md` |
| fixtures | `scripts/launchpad/fetch-fixtures.sh` (mainnet dumps, pinned SHA-256; the dumps are gitignored), `tests-launchpad/fixtures/accounts/` (the DAMM v2 customizable config) |
| CI | `.github/workflows/solana.yml`: launchpad IDL diff, SDK tests, fixtures, in-process tests |

Program id (devnet and local, throwaway keypair kept outside the repository):
`Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7`. For mainnet the owner generates
a fresh keypair (design section 20).

## 3. Build

| item | value |
|---|---|
| toolchain | anchor-cli 0.31.1 (anchor-lang/anchor-spl 0.31.2 from the lockfile), solana-cli 4.3.0, cargo-build-sbf 4.4.0 (platform-tools v1.57), rustc 1.97.0, node 22.22.0 |
| `anchor build` (production, no features) | `target/deploy/vicinity_launchpad.so`, 427,176 bytes, SHA-256 `5b8ced5104c2b6ab26922147a311cb0da62f600aeed0f4a724393be1224aeb78`; rebuilt from a touched source: same hash |
| IDL | 105,460 bytes, SHA-256 `538d0d5895451cf47f4010438a669c4fbcd83ceeee0c5111bbb8418a9ddb4a3d` (`target/idl` = `sdk/idl`) |
| `vicinity_rewards` after this work | rebuilt: 505,864 bytes, SHA-256 `f0fbc9d53ed092210eef3f97047644d6f796d634bf11c428795ff8b0b1e509a3`, identical to the hash recorded in AUDIT.md; its IDL is unchanged; its `short-windows` test build also matches AUDIT.md (`add08669…ebf98`) |
| rent for the program (devnet, `solana rent 427221`) | 2.17093292 SOL for the ProgramData account at `--max-len` = size, plus 0.00083312 SOL for the program account |

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
| Rust unit tests, both crates | `cargo test` | launchpad 25 passed (every rule of 7.2 broken one field at a time, the 50/50 split with a 200,000-case property loop and an additivity loop, names, tickers, the URL, the ProgramData header, the rewards-config reader, the token-account reader); rewards 29 passed |
| clippy and fmt | `cargo clippy --all-targets -- -D warnings`, the same with `--features short-windows`, `cargo fmt --all -- --check` | clean |
| launchpad in-process suite | `npm run launchpad:fixtures` once, then `npm run test:launchpad` | 84 passed, about 14 s; every invariant of design section 15 checked after every successful transaction |
| launchpad SDK | `npm run sdk-test:launchpad` | 7 passed (includes 5,000 random trades per quote type on the maths alone) |
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
| `harvest_curve_fees` (first time, creates the coin's own account) | 70,616 | 723 |
| `harvest_curve_fees` | 47,309 | 723 |
| `forward_holders_fees` | 22,726 | 458 |
| `claim_founder_fees` (creating the founder's account) | 33,388 | 555 |
| `set_payout_config` / `set_pause` | 6,024 / 5,527 | 413 / 352 |
| `opt_in_payout` / `revoke_payout_opt_in` | 24,005 / 9,331 | 520 / 391 |
| `payout_founder_fees` (creating the payout wallet's account) | 45,048 | 558 |
| DBC `swap2` partial fill up to graduation | 32,840 | 699 |
| DBC `migration_damm_v2` (graduation crank) | 243,000 to 266,000 | 1,109 |

### 5.2 Money and rent

* A launch cost the founder 0.0812 SOL in the test VM, which uses the old rent
  rate (6,960 lamports per byte); at today's rate (5,080) that is about
  0.076 SOL: 0.05 SOL launch fee, 0.01 SOL Metaplex fee, and rent for the
  `Coin` record, its two token accounts, the DBC pool, its vaults, the mint and
  the metadata.
* The graduation crank cost the cranker 0.0325 SOL (32,518,200 lamports, rent
  of the DAMM v2 accounts plus fees).

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

## 6. Devnet (not done in this step)

The program is not deployed yet. The throwaway deployer
`9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa` holds about 1.39 devnet SOL; the
program needs 2.17 SOL of rent and, during the deploy, a buffer of the same
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
5. **Size** 427 KB instead of 300 KB (section 3).
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
9. **Not built in this step** (design 18 and 20): `create-dbc-config.mjs`,
   `init-launchpad.mjs`, `devnet-demo.mjs`, `crank.mjs`,
   `claim-platform-fees.mjs`, `snapshot.mjs`, the pay-with-anything composer,
   and all website work.

## 8. Reproduce

```
cd solana
npm ci
anchor build                       # both programs; hashes in section 3
cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --all -- --check
npm run launchpad:fixtures         # mainnet dumps, checked against pinned hashes
npm run test:launchpad             # 84 tests, no validator
npm run sdk-test:launchpad && npm run sdk-test && npm run typecheck
```
