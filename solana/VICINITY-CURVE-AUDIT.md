# `vicinity_curve`: audit pack

For the outside auditor of the Solana program `vicinity_curve`, the custom Vicinity launchpad
(draft PR #83 of `FunnyCircuitBoard/Vicinity-Launchpad`, branch `feat/vicinity-curve`, not
merged). Prepared on 23 October 2026. Every figure below is taken from the repository or from a
command run for this file on that day; each names its source. Section numbers without a file name
("3.2", "8.4", "Appendix C") are sections of `VICINITY-CURVE-DESIGN.md` (the specification);
"NOTES n" is entry n of `VICINITY-CURVE-NOTES.md` (the implementation notes);
`VICINITY-CURVE-DEVNET.md` is the record of rehearsal D01.

Status: nothing of this program has been deployed to mainnet or signed for it, and the repository
holds no mainnet program id for it (3.1: the owner generates that key on his own machine). The
mainnet deployment waits for this audit (1.3). The
two programs already on mainnet, `vicinity_rewards` and the old `vicinity_launchpad`, are not
changed by this work.

Contents: 1 Scope. 2 Building and the expected hashes. 3 Running the tests. 4 Purpose and money
flows. 5 Roles and keys. 6 Threat model. 7 Invariants and where they are checked. 8 Review
history. 9 Known limitations and accepted risks. 10 Open owner decisions. 11 Rehearsal D01. 12
Questions for the auditor. Appendix: the gate run for this file.

---

## 1. Scope

### 1.1 The commit

| item | value |
|---|---|
| repository | `https://github.com/FunnyCircuitBoard/Vicinity-Launchpad` |
| branch | `feat/vicinity-curve` (draft PR #83) |
| commit of the code in scope | `cd56508fc3274a84960b04c06b4f4f8f2282e656` |
| last change to the program or crate source | `f76c646` (review round 7: a doc comment in `state.rs`, which changed the IDL and not the binary) |
| last change to the program binary | `ae8e071` (review round 6); the production build has been sha256 `0a5beef2...` since (Appendix C, rounds 7 to 10; re-built for this file, 2.3) |

The commit that adds this file changes documentation only (this file, the header of
`VICINITY-CURVE-DESIGN.md` and `solana/README.md`): `git diff --stat cd56508 <that commit>` lists
those three files and nothing else, so every in-scope file below is byte-identical at both commits.

### 1.2 In scope: the on-chain code

The Anchor program (crate `programs/vicinity-curve`, 26 instructions, 7 account types, 26 events,
72 errors with codes 6000 to 6071, 49 IDL constants; counted from `sdk/idl/vicinity_curve.json`)
and the pure integer math crate it calls for every amount (`crates/vicinity-curve-math`,
`#![no_std]`, `#![forbid(unsafe_code)]`, no dependency besides `core`, 3.1). Line ranges are the
part of each file before its first top-level `#[cfg(test)]` item; the rest of the file is unit
tests. Counts include comments and blank lines.

| file (under `solana/`) | lines | in scope | test code from line |
|---|---|---|---|
| `programs/vicinity-curve/src/lib.rs` | 311 | 1-270 (lines 46-47 declare the test-only `checklist` module) | 271 |
| `programs/vicinity-curve/src/state.rs` | 955 | 1-470 | 471 |
| `programs/vicinity-curve/src/constants.rs` | 558 | 1-303 | 304 |
| `programs/vicinity-curve/src/errors.rs` | 401 | 1-277 | 278 |
| `programs/vicinity-curve/src/events.rs` | 357 | 1-357 | none |
| `programs/vicinity-curve/src/helpers.rs` | 1,428 | 1-560 | 561 |
| `programs/vicinity-curve/src/custody.rs` | 243 | 1-96 | 97 |
| `programs/vicinity-curve/src/batch.rs` | 944 | 1-192 (188-192 are the doc comment of the test-only `reference` module) | 193 |
| `programs/vicinity-curve/src/instructions/mod.rs` | 150 | 1-81 | 82 |
| `programs/vicinity-curve/src/instructions/*.rs` (the 26 handlers, one file each) | 2,840 | all | none |
| `programs/vicinity-curve/src/checklist.rs` | 1,257 | none (test-only: source rules and the instruction contract against the IDL) | 1 |
| `crates/vicinity-curve-math/src/` (`arith`, `config`, `constants`, `decode`, `error`, `fee`, `lib`, `trade`, `types`) | 1,600 | all | none (tests are in `tests/`) |
| **total** | **11,044** | **7,046** (program 5,446 in 35 files; crate 1,600 in 9 files) | |

The 26 handlers and their line counts: `accept_admin` 58, `add_launch_config` 124,
`approve_launch` 183, `buy` 179, `buyback_burn` 112, `claim_founder_fees` 60, `clear_launch_batch`
56, `forward_holders_fees` 114, `init_launch_batch` 55, `init_launchpad` 95, `launch` 504,
`launch_from_batch` 301, `opt_in_payout` 76, `payout_founder_fees` 121, `propose_admin` 51,
`publish_launch_batch` 109, `revoke_approval` 46, `revoke_payout_opt_in` 48, `sell` 144,
`set_guardian` 54, `set_launch_approver` 63, `set_launch_config_enabled` 42, `set_pause` 65,
`set_payout_config` 63, `transfer_founder` 56, `withdraw_platform_fees` 61.

Also in scope, because they decide what is compiled: `Cargo.toml` (workspace release profile:
`overflow-checks = true`, `lto = "fat"`, `codegen-units = 1`, `opt-level = 3`),
`programs/vicinity-curve/Cargo.toml` (features `no-idl` (default), `devnet`, `halt-all`; exact
pins `anchor-lang = "=0.31.2"` with `event-cpi`, `anchor-spl = "=0.31.2"`, `mpl-token-metadata =
"=5.1.1"`), `crates/vicinity-curve-math/Cargo.toml` and `Cargo.lock` (sha256 `f89a4dd0...`;
resolves `solana-program` 2.3.0, `spl-token` 7.0.0). All three builds are in scope: production
(default features), `devnet` (only the four compiled ids of 3.2 differ) and `halt-all` (the
pre-audited emergency build of 8.3: nine handlers refuse with `TradingHalted`).

The integration contract with the two deployed programs is in scope as this program's side of it:
the fixed-offset reads of the old `vicinity_launchpad`'s `Launchpad`, `Coin` and `Approval` and of
`vicinity_rewards`' `Registry` and `CityConfig` (3.2, 4.8, 4.10, 4.15, 8.5), and the credit of the
rewards WSOL vault by a direct lamport move followed by a separate top-level `SyncNative` (4.0,
4.15).

### 1.3 Requested in scope: off-chain code the safety argument relies on

These run on the owner's, a guardian member's or the website's computer, not on chain. A defect
in them cannot move funds by itself, but sections 8.1, 8.4 and 8.6 rely on them against a stolen
launch approver key, a compromised website and a hostile RPC (T85, T89), and the website's trade
protection relies on the SDK (T78 to T80). We ask the auditor to include them.

| file (under `solana/`) | lines | what the design relies on it for |
|---|---|---|
| `scripts/vcurve/batch.mjs` | 1,117 | the owner's batch verifier (`verify`, `--tx`, `--correct`), `confirm` and the monitor's `check` (8.4 steps 2, 3 and 5) |
| `scripts/vcurve/guardian-stop.mjs` | 501 | a guardian member's one-transaction stop through Squads v4 (8.4 step 5, review R7-1) |
| `scripts/vcurve/preflight.mjs` | 562 | the deploy checklist and its proposed-key checks (8.4 preconditions and operating rules) |
| `sdk/curve/batch.mjs` | 448 | the launch leaf, tree and proof builder and the in-force function (3.12, 8.6) |
| `sdk/curve/math.mjs` | 689 | the JavaScript port of the math crate (the checker and every client quote use it) |
| `sdk/curve/prechecks.mjs`, `compose.mjs` | 130, 352 | the size-dependent slippage policy and the composed buy (5.15, 14.1, T78 to T80) |
| `sdk/curve/events.mjs` | 254 | the transaction-level event decoder with the acceptance rule of 4.21 (T56) |
| `sdk/curve/accounts.mjs`, `constants.mjs`, `instructions.mjs`, `pda.mjs`, `rewards.mjs`, `index.mjs` | 245, 236, 385, 97, 210, 14 | decoders, constants, instruction builders, addresses, the rewards-config checks |

### 1.4 Reference material (not code under audit)

* The test suites of section 3 and their harness: the per-transaction checker
  `tests-curve/invariants.mjs` (1,474 lines), the world `tests-curve/helpers.mjs` (852), the fuzz
  model `tests-curve/fuzz.mjs` (1,160), the test-only router `tests-curve/router/`, the 46 mutant
  builds of `scripts/vcurve/batch-mutants.py` (43 in NOTES 77, three more in NOTES 82). The
  checker is the test oracle for section 9; whether it checks what section 9 says is question 12
  of section 12.
* The reference model and checks of Appendix A (`crates/vicinity-curve-math/reference/`:
  `model.py`, `checks.py`, `derive.py`, `generate_vectors.py`, and the golden vectors
  `vectors.json` and `g01-vectors.json`).
* `scripts/vcurve/sbf-builds.sh` and `idl.sh` (the build and IDL scripts of 2.2).

### 1.5 Out of scope

* The code of `vicinity_rewards` (`EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG`) and of the old
  `vicinity_launchpad` (`AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai`), deployed on mainnet on 10
  October 2026 (`release/mainnet-2026-10-10/BUILD.md`) and unchanged here; the suites load those
  committed release binaries, SHA-256 checked against `release/mainnet-2026-10-10/SHA256SUMS`
  (`tests-curve/helpers.mjs`). Their own documentation is `AUDIT.md` and `LAUNCHPAD-AUDIT.md`.
* Third-party programs and frameworks: System, SPL Token, the associated token program, Metaplex
  Token Metadata, Squads v4, the Agave runtime and Anchor 0.31.2 itself (how this program uses
  them is in scope).
* The website at the repository root, its batch page, the batch monitor process and the keeper:
  the batch page and the monitor are not built (14.1), nor is the keeper (review R5-CONS-6).
* Key generation, deployment and the Squads configuration on mainnet (operating steps of 8.4).
* Everything else under `solana/` (`programs/vicinity-rewards`, `programs/vicinity-launchpad`,
  `sdk/launchpad`, `tests`, `tests-launchpad`, the Meteora interfaces in `idls/`).

---

## 2. Building and the expected hashes

### 2.1 Toolchain, as used for this file

| tool | version | read with |
|---|---|---|
| Agave solana-cli | 4.3.0 (src:44b42d45; feat:c9ad34d2, client:Agave) | `solana --version` |
| cargo-build-sbf | 4.4.0, platform-tools v1.57, SBF rustc 1.95.0 | `cargo build-sbf --version` |
| anchor-cli | 0.31.1 (drives `anchor build` and the IDL; the program depends on `anchor-lang` 0.31.2, 3.1) | `anchor --version` |
| host Rust (tests, clippy, IDL) | rustc 1.97.0 (2d8144b78 2026-07-07), cargo 1.97.0 | `rustc --version` |
| Node | v22.22.0, npm 10.9.4 | `node --version` |

The CI workflow `.github/workflows/solana.yml` pins `AGAVE_VERSION: 4.3.0`, `ANCHOR_VERSION: 0.31.1`
and Node 22. The Agave release used here is the one installed at
`~/.local/share/solana/install/releases/stable-44b42d45ec7e555b26ca15ad924a7432d18aaa9f/`.

### 2.2 Commands

From `solana/`:

```sh
npm run vcurve:sbf      # bash scripts/vcurve/sbf-builds.sh: the three builds, sizes, hashes
anchor build            # target/deploy/vicinity_curve.so (the production build) and target/idl/
npm run vcurve:idl:check   # regenerates the IDL with idl-build and diffs it with sdk/idl/vicinity_curve.json
```

`sbf-builds.sh` runs, for each variant, `cargo build-sbf --manifest-path
programs/vicinity-curve/Cargo.toml --sbf-out-dir target/vcurve-builds/<variant>` with no feature,
`--features devnet` or `--features halt-all`; it touches `lib.rs` first so that the crate
recompiles and prints its warnings, fails on any "Stack offset ... exceeded" warning (C04), and
prints each binary's size and SHA-256 (C03). The only warning cargo-build-sbf prints is that two
crate types (`cdylib` and `lib`) preclude link-time optimisation, so `lto = "fat"` has no effect
(NOTES 19).

### 2.3 Expected hashes at `cd56508`

| build | features | bytes | SHA-256 |
|---|---|---|---|
| production | default (`no-idl`) | 738,064 | `0a5beef231cfcc1327d9e497bb631f7c8edc99468338daed932ddce90bba3b5b` |
| devnet | `devnet` | 738,064 | `d052b8fccf5ed0fc9bbb0ee56e4a77ae5a3ec99c6fa6c906119f51db71c18fa3` |
| halt-all | `halt-all` | 736,840 | `4d631647c38230690ad57a28e49d021e0ad956a7edbc454dc107558849a0d868` |
| client IDL `sdk/idl/vicinity_curve.json` | `idl-build` | 6,398 lines | `2ecf3e686204b8d723cde124d69b0b7030e29835678bc0d08cf6428957ed4db7` |

All three binaries carry the program id `nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk` in
`declare_id!` (`lib.rs` line 56), a throwaway localnet and devnet key kept outside the repository
(3.1). The production and `halt-all` builds compile the mainnet ids of `vicinity_rewards` and the
old `vicinity_launchpad` (3.2); the devnet build compiles their devnet ids. The mainnet binary will
be this source with the owner's program id in `declare_id!` and `Anchor.toml`, so its hash will
differ from the table; 8.4 and C03 require that binary's hash to be published with a verified
build before it is deployed, and 11.1 says the compute figures are measured again with that id.

### 2.4 How the hashes were checked for this file

1. `npm run vcurve:sbf` in the working tree: the three hashes of 2.3, "no stack warning: yes"
   (33 s with the dependencies cached).
2. A clean copy: `git archive cd56508 solana | tar -x` into a new directory with no `target/`,
   then `bash scripts/vcurve/sbf-builds.sh` there: the same three hashes (2 min 35 s, dependencies
   compiled afresh from the warm cargo registry cache of the same machine). The source paths
   embedded in the binary are relative (`strings` shows `programs/vicinity-curve/src/...` and
   `src/...` only), so the build directory does not enter it.
3. `anchor build`: `target/deploy/vicinity_curve.so` has the production hash `0a5beef2...`.
4. D01: the devnet build was deployed and read back from the chain byte for byte
   (`VICINITY-CURVE-DEVNET.md` section 3).
5. The full gate of the Appendix ran `npm run vcurve:sbf` again and found the three hashes.

Not done: a Docker-based verifiable build (`solana-verify build` or `anchor build
--verifiable`), whose image brings its own toolchain and so gives other hashes. The release of
`vicinity_rewards` and the old `vicinity_launchpad` was not one either (`BUILD.md`); 8.4 makes the
verified build a step before each deploy.

---

## 3. Running the tests

Preparation, from `solana/`: `npm ci`; `npm run launchpad:fixtures` (downloads the program dumps
the suites load and checks them against pinned SHA-256: Metaplex Token Metadata `31f0a627...`,
Squads v4 `dec8d3e0...`, Meteora DBC `e2bfc853...` and DAMM v2 `967ff9fb...`, all from mainnet;
`scripts/launchpad/fetch-fixtures.sh`); `anchor build`; `npm run vcurve:sbf`; `npm run
curve:router` (the test-only router of `26-router`). The dumps used for this file had those four
hashes.

| suite | command (from `solana/`) | what it covers | result for this file |
|---|---|---|---|
| format and lints | `cargo fmt --all -- --check`; `cargo clippy --all-targets -- -D warnings`, again with `--features short-windows`, and `cargo clippy -p vicinity-curve --all-targets --features devnet` and `--features halt-all`, each with `-D warnings` | the workspace | clean |
| program unit tests | `cargo test` (also `-p vicinity-curve --features devnet` and `--features halt-all`) | the `#[cfg(test)]` modules (among them U10 to U13 and the `pay_out` tests) and `checklist.rs` (source rules and the instruction contract against the IDL) | 77 passed in each of the three builds |
| math crate | `cargo test` | `tests/unit.rs` 17 (the U tests of 12.1), `config_rules.rs` 14 (V01 to V11), `props.rs` 12 (P01 to P10, P06b, P09b), `no_free_value.rs` 3 (P11a, P11b, and a check that I18's old spot-value clause is false, NOTES 35), `differential.rs` 7 (the vectors of Appendix A's model), `g01_vectors.rs` 1 (G01) | 54 passed |
| property tests at 10^6 cases | `PROPTEST_CASES=1000000 cargo test --release -p vicinity-curve-math --test props` and `--test no_free_value` | 12.2's "at least 10^6 cases each" (CI runs 1,024 to 4,096 cases, NOTES 1, 35) | run for this file, release build: 12 passed (85.6 s) and 3 passed (32.1 s) |
| smoke | `npm run test:vcurve` | `tests-vcurve/00-smoke`: one coin's life on the production build, then the halt-all build over it and back | 1 passed |
| SDK | `npm run sdk-test:curve` | `sdk/curve/*.test.mjs`: math parity, events, IDL, batch leaves and proofs, the client pre-checks | 52 passed |
| litesvm lifecycle and attack suites | `npm run test:curve` | `tests-curve/01` to `34` (the table in `tests-curve/README.md`); the checker of section 7 after every transaction | 203 passed (about 3 minutes) |
| fuzz, longer | `VCURVE_FUZZ_STEPS=n VCURVE_FUZZ_SEEDS=s node --test tests-curve/23-fuzz.test.mjs` | F01 and F02 with the model byte-equal after every transaction (CI: 300 steps on seeds 1 and 2) | run for this file: seed 11, 20,000 steps, passed in 7 min 30 s: 16,155 transactions, 9,696 succeeded and 6,459 failed (3,830 as the model predicted; 2,392 invalid variants, of which 2,370 were refused, 4 replaced an open slot and were re-synced, 10 replaced the `program` slot of an instruction that emitted nothing, 8 could not be built); 16 coins launched and graduated; 283 publications, 70 clears and 9 batch launches accepted. Earlier long runs: seed 7 at 100,000 steps and seed 8 at 30,000 before the batch path (NOTES 38), eight seeds of 2,500 steps with it (NOTES 76) |
| batch mutants | `python3 scripts/vcurve/batch-mutants.py . <out dir>` | 46 mutant programs, one batch rule removed or weakened in each, run against `30-batch` (H02 for the halt-all mutant) with and without the checker (NOTES 77, 82; about 1.5 minutes per mutant) | not re-run for this file; NOTES 77 and 82 record all 46 killed in both modes, and the program binary has not changed since (2.3) |

The same gate also runs the repository's other suites, which this program does not touch:
`cargo test` of `vicinity_rewards` (29) and `vicinity_launchpad` (27), `npm run test:launchpad`
(155 passed) and the website suite at the repository root (`node scripts/copy-assets.mjs &&
node scripts/pages/build.mjs && npm test`: 1,910 tests, 1,909 passed, 1 skipped). The Appendix
lists every step and result.

Useful switches (`tests-curve/README.md`): `VCURVE_INVARIANTS=off` skips the checker,
`VCURVE_PROBE=end` runs the liveness probe only at the end of each test, `VCURVE_I18_RUNS` lengthens
`25-no-free-value`, `VCURVE_G01_LIVES` shortens `22-g01-onchain`, and `VCURVE_SO`,
`VCURVE_HALT_ALL_SO`, `VCURVE_SQUADS_SO` point at other binaries.

---

## 4. Purpose and money flows

**What it is** (0.1). One program runs a city coin's whole life: approval (by the admin one city at
a time, or in a daily Merkle batch signed by a separate launch approver), launch, a bonding curve,
graduation into the coin's own constant-product pool, fee booking, payouts and buyback-and-burn. No
Meteora program, no other AMM and no third party receives anything; the old program's launch path,
which runs on Meteora, is retired before the first approval here (8.5). One permanent `Coin` PDA
per city (`["coin", city_id]`, 693 bytes) holds the frozen terms, the reserves, five fee buckets
and every lifetime counter, and **all of the coin's SOL as native lamports**; the coin's tokens sit
in one SPL token account it owns (`["coin_vault", coin]`). One coin per city and one per ticker
(`TickerLock`, permanent), checked across the old program as well (8.5).

**The default config #0** (5.9): 1,000,000,000 coins at 6 decimals, mint and freeze authority
none, metadata immutable; 793,099,990 coins sold on the curve; 206,900,000.9 coins kept for the
pool; the curve completes at exactly 85 SOL; virtual reserves 30.000853639 SOL and
1,073,025,598.486615 coins; the 9.1 coins R8's figures leave over are burned in the launch
transaction (O3). Launch fee 0.05 SOL to `FEE_RECIPIENT`.

**Money map** (6.1, 6.4):

```
buy / sell (curve or pool), inside the trade:
  fee = floor(A * 250 / 10,000) of the SOL leg A, never above 2.5%; all lamports stay in the Coin
  +-- 0.5% liquidity  -> pool phase: into pool_sol in the trade; curve phase: liquidity_pending,
  |                      dripped into the pool after graduation; locked for ever if the coin never graduates (O2)
  +-- 0.7% platform   -> platform_pending -- withdraw_platform_fees (anyone) ----> FEE_RECIPIENT (compiled)
  +-- 0.5% founder    -> founder_pending  -- claim_founder_fees (founder) -------> founder
  |                                       `- payout_founder_fees (payout key, opted-in, daily) -> payout wallet
  +-- 0.5% holders    -> holders_pending  -- forward_holders_fees (anyone) ------> the city's vicinity_rewards
  |                                          WSOL vault (Holders config, authority == admin), then Merkle rounds
  +-- 0.3% buyback    -> buyback_pending  -- buyback_burn (anyone; <= 0.1% of depth; 1 per 150 slots)
                                             buys at the curve or pool price, SPL burn, no fee
launch (founder signs): 0.05 SOL -> FEE_RECIPIENT; 9.1 coins burned; Metaplex's own 0.01 SOL fee
graduation: inside the buy that takes the last curve coin; no CPI, no lamport moves
seller payout: sell pays the signer gross - fee
```

Each named share is rounded down; the rounding remainder (0 to 4 lamports) stays in liquidity
(5.2). Every lamport leaves a `Coin` through one helper, `custody::pay_out`, which refuses any
debit that would leave less than `min(rent_reserve, live rent) + liabilities` (6.5); there are
exactly five such debits (seller payout, platform withdrawal, founder claim, founder payout,
holders forward), checked as source rules by `checklist.rs`. Prices and amounts come from stored
counters, never from balances (1.3), so donations are surplus (T7, T8). No instruction can stop a
sell, a claim, a forward or a withdrawal; the guardian and the admin can stop buys, buybacks and
launches (8.3); the `halt-all` build, deployed by upgrade, stops every outflow.

---

## 5. Roles and keys

From 8.1, where each row has its references. "Program" means the program refuses it; "rule" means
an operating rule of 8.4 that the deploy checklist checks where it can.

| key | can | cannot |
|---|---|---|
| **admin**: the Squads vault `AB5qB1iAukPB7p1dkukQ1qSke3yQBDeSd5o69dLFGs7X` (multisig `6v8hwKYS...`, 2 of 3), which is also the upgrade authority and, in `vicinity_rewards`, the registry admin, every city's rewards authority and the upgrade authority; the old program's admin must be the same key (8.5) | approve and revoke launches; add configs inside V1 to V11 and enable or disable them; set any pause flag either way; set the payout key and wallet, the guardian and the launch approver; hand over the admin seat in two steps; clear launch batches. As upgrade authority: replace the program (including with `halt-all`) and so take every coin's reserves and buckets, after the 48-hour time lock once the first coin is live (O11). As rewards authority: publish the Merkle roots that decide who receives the holders' money | without an upgrade: move any lamport or token; change a live coin's split, curve, founder or state; block sells, claims, forwards or withdrawals; redirect platform fees; change the compiled program ids; mint; freeze; create a second coin for a city or a ticker |
| **guardian**: a separate Squads multisig with no time lock, 1 of 3, controlled by the vault (O35); never `FEE_RECIPIENT`, the payout key or wallet, the admin, the proposed admin or the launch approver (program) | `set_pause` setting `launches`, `buys` and, only while buys are halted, `buybacks` to true; `clear_launch_batch`, with or without halting publication. Each member stops with one transaction (`guardian-stop.mjs`) | clear any flag; lift a batch halt; publish; block exits; touch money; change any setting |
| **launch approver** (`Launchpad.launch_approver`; zero turns the batch path off): a dedicated key in the owner's own wallet, on a device or seed with no Squads member key (O32, rule) | `publish_launch_batch`: one Merkle root of at most 512 entries (founder, config, name, ticker, metadata hash per city with no coin), in force no sooner than 12 hours after publication and for at most 48 hours (O30, O31); `clear_launch_batch` | move money; launch for a founder; shorten the review window or lengthen the validity; approve what a per-city launch would refuse; change any setting, flag, config or live coin; lift a halt; publish while halted. It is never `FEE_RECIPIENT`, the admin, the proposed admin, the guardian, the payout key or wallet (program) |
| **payout key** (off by default) | `payout_founder_fees` for opted-in founders, to the fixed payout wallet, once a day per coin; pause payouts | resume payouts; pay anywhere else; touch another bucket |
| **founder** (per coin, chosen at approval or named in a batch; never `FEE_RECIPIENT`, the guardian, the payout key or the launch approver, program) | claim, opt in or out of payouts, hand the seat over with both signatures | touch another bucket or coin |
| **keeper** (Vicinity's fee-payer hot key, O24; not built) | sign permissionless cranks as fee payer: `buyback_burn`, `withdraw_platform_fees`, `forward_holders_fees`; send the rent top-up of 6.5 (a plain transfer) | anything a stranger cannot do; it receives nothing (I21) |
| **`FEE_RECIPIENT`** `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` (compiled; the owner's wallet) | receive launch fees and platform withdrawals; trade like any wallet | hold any seat (program: admin, proposed admin, guardian, payout key or wallet, founder, launch approver, upgrade authority at `init_launchpad`); later moves of the upgrade authority and its holding of city coins are rules (8.4, O29) |
| **anyone** | trade; run `buyback_burn`, `withdraw_platform_fees`, `forward_holders_fees`; revoke an expired approval | everything else |
| **website** | build unsigned transactions; compute the daily batch list; give founders their entries and proofs | hold any admin, guardian, payout, approver or upgrade key (8.1, 8.4) |

Worst cases (8.1): two of the three Squads keys can, as upgrade authority, take everything after
the 48-hour time lock, during which holders can sell and the guardian can halt buys; a stolen
launch approver key can, if nobody clears within the 12-hour window, let founders of the thief's
choosing take up to 512 cities without a coin, but reaches no lamport or token; a stolen guardian
can halt buys, buybacks and launches until the admin replaces it; a stolen payout key reaches only
opted-in founders' shares, to the agreed wallet, daily; a stolen founder key reaches that coin's
`founder_pending`.

---

## 6. Threat model

Section 10 lists 91 threats (T1 to T91), each with its mitigation and the invariants and tests
that answer it, and 12.6 maps them to tests. In groups:

| group | threats | main mitigation | tests |
|---|---|---|---|
| account and program substitution, re-initialisation, closes, aliasing, pre-funded PDAs | T1 to T6, T29, T30, T47, T48, T54, T55 | seeds re-derived with stored bumps; addresses pinned to the `Coin`; typed accounts; compiled program ids; plain `init` only; only `Approval` and `PayoutOptIn` close | X01 to X06, X29, X30, X47, X48, X54, X55, F02 |
| donations, rent and custody | T7, T8, T31, T32, T63 | stored counters decide prices; `pay_out`'s floor; per-coin liabilities; `rent_reserve` | I9, I10; X07, X08, X31, X32, X63 |
| math, rounding and the partial fill | T9 to T18, T57 | the curve as a state function; fee rounded down; gross-up Lemma G; checked u128 arithmetic; strict minimums | I4, I6, I12, I17; U01 to U09, P01 to P10, X13 to X18, X57 |
| graduation | T19 to T23 | one-sided continuity; graduation as field writes inside the completing buy; buybacks never graduate | I1, I5, I15; L07, X19, X23 |
| MEV and economics | T24 to T28, T62, T76, T79, T80 | buyback cap of 0.1% of depth once per 150 slots; V8, V10, V11; size-dependent client slippage | P06, P06b, P09, P09b, X24 to X28, 29-clients |
| uniqueness, metadata, supply | T33 to T40, T67, T88, T91 | permanent `Coin` and `TickerLock`; the old program checked at every approval and launch; `check_name`; authorities removed; immutable metadata | I11, I19; X33 to X40b, 28-governance |
| keys, governance and upgrades | T43 to T46, T49 to T53, T64, T65, T72, T73, T77 | the powers of 8.1; role separation in the program; `no-idl`; time lock and guardian | I2, I20, I21; X43, X43b, X44, X50, X51, X64, X65, 28-governance |
| runtime and integration | T41, T42, T56, T58 to T61, T66, T68 to T71, T74, T75, T78 | O(1) paths; trades never read `LaunchBatch`; event CPIs and the indexer rule; the CPI rule of 4.0; the SDK pre-checks | I22; C01, X42, X56, X58, X59, X61, R01 to R03, E01, G02, G03 |
| the batch launch approval | T81 to T91 | the leaf built from the call's arguments and signer; leaf and node prefixes; the in-force function; the 12-hour window; the off-chain verifier, confirmation, monitor comparison and guardian stop | I23 to I25; U13, P12, L14, X66 to X76, F01, CK1, 30 to 34 |

T36 (look-alike tokens outside the program), T68 (a front end's own fee) and T74 (third-party pools
for the coin) cannot be prevented by the program; 6.6 and 14.5 say how they are labelled.

---

## 7. Invariants and where they are checked

Section 9 states 25 invariants. The per-transaction checker `tests-curve/invariants.mjs` asserts
I1 to I17 and I19 to I25 after every successful transaction of every litesvm suite (I18 is a
property over sequences; review R5-CONS-5), and `checkFailedTransaction` (line 310) checks that a
failed transaction moved nothing but its fee. The checker's entry point is `checkTransaction`
(line 460); the line numbers below are of that file at `cd56508`.

| # | invariant (short; section 9 has the exact text) | enforced in the program by | checked by |
|---|---|---|---|
| I1 | `phase` goes 0 to 1 once; curve and pool field rules | `buy.rs` (graduation inside the completing buy) | `checkCoin` (966); L07, U07, F01 |
| I2 | frozen terms never change; `founder` only in `transfer_founder` with both signatures | no writer of the frozen fields after `launch` / `launch_from_batch` | `checkCoin` byte compare (981); `checkTransaction` (815); L13 |
| I3 | fee caps and V1 to V11 hold for each coin's snapshot | `validate_config` (math `config.rs`) at `add_launch_config`, `launch` and `launch_from_batch` | `checkCoin` (984); V01 to V11, F03 |
| I4 | curve: `curve_sol == f(tokens_sold)`, `<= R - 1` | math `trade.rs` (`curve_value`, `quote_buy`, `quote_sell`) | `checkCoin` (989); P01, P02, F01 |
| I5 | graduation exactly at `S` and `R`; pool opens at `(R, P)`; vault holds `P` | math `quote_buy`; `buy.rs` | `checkTransaction` (763 to 840); L07 |
| I6 | pool reserves positive; `X * Y` never decreases | math `trade.rs` (outputs rounded down) | `checkTransaction` per event (702) and `checkCoin` (996); P04, L08 |
| I7 | each bucket equals earned minus paid | handlers book both sides | `checkCoin` (1003); P07 |
| I8 | `fees_total` is the sum of the five earned counters | math `fee_split` | `checkCoin` (1009); P07 |
| I9 | `coin.lamports >= min(rent_reserve, rent_min) + liabilities`, equality without donations | `custody::pay_out` (the single debit helper) | `checkCoin` (1011); X07, X31, X63 |
| I10 | vault holds at least the coins owed, equality without donations | transfers and burns only from the vault in `buy`, `buyback_burn`, `launch` | `checkCoin` (1016); X08 |
| I11 | supply, authorities none, 6 decimals, immutable metadata with the approved name, symbol and URI | `launch.rs`, `launch_from_batch.rs` | `checkCoin` (1021); L05, X39, X40b |
| I12 | per-trade fee, split, remainder 0 to 4, drip bound, minimum buy, `charged <= sol_in` | math `fee.rs`, `trade.rs`; `buy.rs` | `checkTransaction` (717); U01, U02, P08, P09 |
| I13 | the `Coin`'s lamport change equals the events | handlers | `checkTransaction` SOL tracing (469, 844) |
| I14 | every lamport and token goes only to its allowed destination | `pay_out` callers; token CPIs | `checkTransaction` (469 to 660), `checkDestinations` (386), `checkLaunch` (888) |
| I15 | buyback cap, interval, never graduates, supply falls by the burn | math `buyback_cap`, `quote_buyback`; `buyback_burn.rs` | `checkTransaction` (779 to 856); U08, L09, X23 to X26 |
| I16 | monotone counters; `trade_seq` +1 per trade | handlers | `checkCoin` (1029), `checkTransaction` (758, 825) |
| I17 | partial fill delivers `S - s`, charged by the gross-up | math `quote_buy`, `gross_for` | `checkTransaction` (739); U06, U07 |
| I18 | no free value: round trips and random sequences never gain | (a property of the math) | math `tests/props.rs` (P05), `tests/no_free_value.rs` (P11a, P11b), `tests-curve/25-no-free-value`; not per transaction |
| I19 | one `Coin` per city, one `TickerLock` per ticker; the old program and the rewards registry checked at every approval and launch, with the seats of that call | `init` of the PDAs; `helpers.rs` legacy and registry reads in `approve_launch.rs`, `launch.rs`, `launch_from_batch.rs` | `checkGlobal` (1226) with `seatWalk` (1068); L04, X33 to X35, 28-governance |
| I20 | settings: role separation, flags set and cleared only by the right keys, buybacks halted only with buys, configs immutable but `enabled`, program bytes change only by upgrade | `helpers.rs` `check_payout_keys_separate`, `check_guardian_separate`, `check_not_fee_recipient`, `check_founder_key`, `pause_allowed`, `pause_flags_consistent` | `checkGlobal` (1314 to 1375), `checkProgramBytes` (337); 28-governance, 27-checker-gaps |
| I21 | no money path to the admin, guardian, payout key, launch approver, upgrade authority or keeper | the fixed destinations of 6.4; role separation | `checkTransaction` (575, 610); X43, X43b |
| I22 | liveness: nothing stuck; the intended permanent balances named | the no-op rule of 4.0; V4 | `probeLiveness` (1406); F01, X40b, X63 |
| I23 | no launch without an approval or a valid proof from the batch in force | `launch_from_batch.rs` with `batch.rs` (`launch_leaf`, `verify_proof`, `max_proof_len`, `batch_in_force`) | `batchWalk` (1120, I23 at 1180); U13, P12, X66 to X76, CK1 |
| I24 | `LaunchBatch` written only by its four instructions; `seq` +1 per publication; window bounds; clears and halts | `publish_launch_batch.rs` (`batch_window_ok`, `apply_publication`), `clear_launch_batch.rs` (`may_clear_batches`), `set_launch_approver.rs` | `batchWalk` (1120 to 1210); L14, 31-batch-checker |
| I25 | the launch approver holds no other seat and no money path | `helpers.rs` `check_approver_separate`, `check_not_approver` | `checkGlobal` (1337); X71, X73 |

The checker also replays every transaction's events through the SDK's math port and compares
every `Coin` field (the parity of the port with the program), and decodes every transaction with
the SDK's `decodeTransactionEvents`, which must find exactly the checker's events (E01). Its own
gaps were tested by doctoring real transactions (`13-checker`, `27-checker-gaps`,
`31-batch-checker`).

---

## 8. Review history

The specification's revision 1 was reviewed once before the build, and the build ten times
(rounds 1 to 10, 17 to 23 October 2026). Each round's findings were reproduced by a separate
verifier before being accepted; the severities are the verifier's. Appendix C has every finding,
its response and, where a part was not applied, the reason. Rows with one root cause count once,
at their highest severity (the number of finding ids is given too).

| round (date) | lenses | rows (ids) | severity | outcome | what changed the program |
|---|---|---|---|---|---|
| spec revision 1 (before the build) | security, math, runtime, integration | 46 (46) | 2 blocker, 14 major, 25 minor, 5 nit | all applied (INT-2 in part) | the design itself (revision 2) |
| 1 (17 Oct) | accounts, custody, math, governance, integration | 11 (11) | 2 medium, 3 low, 6 info | 5 fixed; 6 rejected | GOV-1 (the old program's admin must be this admin, `LegacyAdminMismatch`), GOV-2 (`FeeRecipientRole`) |
| 2 (17 Oct) | round-1 fix diff, conformance, attacker economics, fresh audit | 4 (4) | 3 low, 1 info | 4 fixed | R2-DIFF-1 and SPEC-1 (role keys refused as founders; `FEE_RECIPIENT` as upgrade authority at init), ECON-1 (V2b in the crate), FA-1 (`check_name`) |
| 3 (17 Oct) | round-2 fix diff, math, lifecycle, hostile roles, clients | 8 (8) | 1 medium, 3 low, 4 info | 6 fixed (HR-1 as text and operating rule, O29 open); 2 rejected | R3-DIFF-1 and MATH3-2 (V2b as a sum), LL-1 (separate `buybacks_halted`) |
| 4 (17 Oct) | round-3 fix diff, operations, cross-program calls, state machine, SDK and docs | 13 (18) | 7 low, 6 info | 13 fixed | OPS-1 (the rewards registry's admin at every approval and launch) |
| 5 (17 Oct) | round-4 fix diff, registry dependency, economics, consistency, cross-coin arithmetic | 12 (14) | 5 low, 5 info, 2 nit | 9 fixed; 3 rejected | R5-CONS-1 (`GuardianIsAdmin`) |
| 6 (18 Oct) | the batch launch approval: diff, Merkle and leaf code, roles and timing | 6 (7) | 2 medium, 2 low, 2 info | 5 fixed (O34, O35 opened); 1 rejected | R6-RT-3 (the three batch settings events as event CPIs) |
| 7 (23 Oct) | batch attacker, conformance; verification of round 6 against the real program and Squads v4 | 11 (13) | 3 medium, 4 low, 3 info, 1 none | 9 fixed; 1 noted; 1 rejected | none (a doc comment; IDL only) |
| 8 (23 Oct) | operator under attack, round-7 diff; verification of round 8 | 11 (12) | 7 low, 4 info | 11 fixed | none |
| 9 (23 Oct) | round-8 tools diff, program funds; verification of round 9 | 5 (5) | 4 low, 1 info | 5 fixed (R9-PF-1 as an operating rule, the SDK's `buybackKeepUp` and the checklist; O36 open) | none |
| 10 (23 Oct) | the program fresh (instruction data read twice); the owner's tools | 2 (2) | 2 info | 1 fixed in the checker and tests; 1 rejected as a defect and hardened | none |
| **build rounds 1 to 10** | | **83 (94)** | **0 high, 8 medium, 38 low, 34 info, 2 nit, 1 none** | **68 fixed or applied, 14 rejected, 1 noted** | rounds 1 to 6 only |

Where the fixes went: rounds 1 to 6 changed the program or the crate in the rows named above, and
the SDK, the checker and the text elsewhere; rounds 7 to 10 changed only the owner's tools
(`scripts/vcurve/`), the SDK's client helpers, the checker, the tests and the text. Two reported
"high" findings were judged medium by the verifier (R3-CLI-1, R6-RT-1). Rounds 7 to 10 changed
no program code; the one finding of those rounds about the program's own rules, R9-PF-1, is
answered by an operating rule, the SDK and the checklist, and its program rule is open decision
O36.

What was rejected, and why (Appendix C has the full reasons):

| id | round | reason |
|---|---|---|
| ACPI-1 | 1 | specified and tested (4.15, T70, `09-outflows`): a forward without a config fails before its no-op check; the keeper skips errors |
| LC-INFO-1, MATH-INFO-1 | 1 | SIMD-0392 is active on mainnet, devnet, testnet and in litesvm; its side point is now stated in 6.5 and T63 |
| GOV-3 | 1 | intended and tested (X50): the founder agreed to that payout wallet by name |
| GOV-4 | 1 | the time lock is a Squads property and already a precondition (8.4) |
| GOV-5 | 1 | specified (4.2, 8.2) and tested |
| HR-2 | 3 | the recorded design (4.17, T52, O22): the seat moves only with both signatures |
| HR-3 | 3 | recorded (R9, 3.2): `FEE_RECIPIENT` changes only by upgrade; no third party's money is reachable |
| R5-REG-2 | 5 | needs a deliberately wrong build; fails closed at the first approval, before any time lock |
| R5-REG-3 | 5 | the accepted fail-closed coupling with the registry, enforced in CI by the IDL diff and U12 |
| R5-CONS-6 | 5 | the keeper is website work not yet built, as the spec says |
| MK-2 | 6 | discloses nothing the system does not already disclose (a guessable metadata hash only) |
| R7-FRESH-1 | 7 | Metaplex Token Metadata is immutable on mainnet and the pinned dump equals it |
| R10-RPC-1 | 10 | 8.4 allows one RPC; hardened anyway (`ONE_RPC` warning, `--one-rpc-ok`) |
| VERIFY-SUMMARY (noted) | 7 | the round-6 fixes held; one reproduction's stray archive file was removed |

Parts of accepted findings that were not applied, each with its reason in Appendix C, include
INT-2's larger buyback step and dropping the first-run delay (spec review); ECON-1's stronger forms;
HR-1's change to V8 and V11 (open as O29); R9-PF-1's rule V12 (open as O36); R7-CONF-1's hardware
wallet transport in the verifier; R5-REG-1's SDK helper for the hand-over.

---

## 9. Known limitations and accepted risks

Each is stated in the specification or the notes; none is hidden behind an owner decision that is
not listed in section 10.

1. **The upgrade authority is the main trust** (8.1, 8.4). Two of the three Squads keys can replace
   the program and take every coin's reserves and buckets, and as rewards authority every forwarded
   holder lamport; the 48-hour time lock (from the first mainnet coin, O11) and the guardian's buy
   halt are the mitigations. The time lock is a property of the Squads multisig, not of the program,
   and applies to every proposal of the vault in every program (8.4).
2. **A mathematical exploit can drain in the first block**, before anyone signs a halt (8.3).
3. **Liquidity of a coin that never graduates is locked for ever** (O2, I22's intended permanent
   balances), as are the buyback bucket's dust below one raw coin, curve-phase rounding remainders
   when `liquidity_bps = 0`, and donations (O21).
4. **The multi-run buyback hold** (Theorem M_K, O25): a trader who buys while a public backlog above
   about 2.0% to 2.6% of depth exists and holds through 21 to 26 runs with no other trading can
   profit (lower figures for a founder, and lower again with an honest trade inside the hold, review
   KR-1). Open, section 10.
5. **The platform's key** (`FEE_RECIPIENT`) is credited `b_P` of its own legs and is outside V8 and
   V11; an operating rule keeps it and the owner's wallets out of city coins and founder seats
   (review HR-1). Open as O29.
6. **The buyback share is not bounded against the fixed per-run cap** by V1 to V11 (review R9-PF-1):
   a config such as (0, 0, 0, 0, 250) passes and makes a backlog the normal state of a traded coin;
   an operating rule and the checklist keep configs within config #0's keep-up. Open as O36.
7. **Operating rules the program cannot enforce** (8.4): the upgrade authority never moves to
   `FEE_RECIPIENT`; a new guardian, payout key or launch approver never names an existing founder
   (the program checks at approvals, launches and founder transfers, not when the setting changes);
   `FEE_RECIPIENT` and the owner's wallets hold no city coins; the approver key shares no device or
   seed with a member key; the guardian multisig is controlled by the vault, with a threshold of 1
   and at least two members able to act alone. `scripts/vcurve/preflight.mjs` checks what can be
   read from the chain.
8. **A stolen launch approver key** can take up to 512 coin-less cities if no stop lands within the
   12-hour window (8.1, T85). The stops are the guardian members (one transaction each), the owner
   with his restored key and the admin. A thief who also holds one guardian member key can race the
   multisig's transaction index at the rent of a vault transaction per index (8.1; O34 would remove
   the race).
9. **Stale batch entries** (O33): a founder who loses his seat after the batch is signed can launch
   until the next batch takes force, the batch is cleared, or it expires (at most 48 hours of
   validity after a lead of at most 48 hours). The website's refusal is not a protection.
10. **A thief signing the very message the owner verified** within its blockhash's minute cannot be
    told apart from the owner (ed25519 is deterministic); only the owner knows he refused it (review
    R8-DIFF-2's stated residual).
11. **One RPC** gives `confirm` and `check` no protection against a lying RPC; they warn `ONE_RPC`
    and `confirm` keeps nothing without `--one-rpc-ok` (review R10-RPC-1). In D01 the two RPC
    addresses were one validator.
12. **Not built**: the batch monitor process, the website's batch page, the keeper and its alerts
    (14.1, R5-CONS-6); a Squads mode of the verifier, without which an approver multisig (O32 (a))
    is reported not ready (R8-DIFF-6); the hardware-wallet transport of R7-CONF-1 (a); clear-only
    stopper keys (O34).
13. **A guardian stop can execute up to four times** on a quiet chain, each extra execution costing
    the member the rent of a vault transaction and proposal (about 0.0056 SOL), and the monitor sees
    up to four `LaunchBatchCleared` events; NOTES 87 says twice (D01, `VICINITY-CURVE-DEVNET.md`
    section 8 item 5). Harmless to the program; not changed.
14. **`payout_founder_fees` with nothing pending is a quiet success** (no event, no sequence, no
    cooldown, 4.20); a payout hook must read the `FounderPaidOut` event or `founder_paid_out` (D01,
    section 8 item 6).
15. **Rent increases** (T63, review OPS-2): the runtime refuses a debit that would leave a `Coin`
    below the live rent minimum (SIMD-0392), so after an increase the exits of a coin whose remaining
    liabilities are below the increase wait until someone tops the `Coin` up; the keeper's top-up
    (`coinRentTopUp`, 6.5) is specified, not running.
16. **A wrong `vicinity_rewards` config can never be fixed** (4.15, O26): the holders' money of that
    coin waits in `holders_pending` until an upgrade.
17. **Third-party pools** for the coin pay no Vicinity fee and cannot be prevented (T74, 6.6).
18. **Look-alike names**: `check_name` refuses invisible and blank characters, not look-alike
    letters of other scripts; the ticker is the identifier (T38).
19. **The metadata JSON** is served by the website; its SHA-256 is stored and emitted, so a change is
    detectable, not prevented (T37, O28).
20. **Native SOL custody** is not proven to route through every aggregator and terminal; written
    confirmation is required before the audit freeze (M1, O10, O23).
21. **Binary size**: 738,064 bytes against 11.4's 450 KB target, costing rent (about 3.75 SOL at
    5,080 lamports per byte for the program data account, `VICINITY-CURVE-DEVNET.md` section 1), and
    as much for each upgrade buffer and the `halt-all` buffer kept ready; `lto` is ineffective with
    two crate types (NOTES 19).
22. **Compute figures depend on the program id** (bump searches): measured with the throwaway id,
    to be measured again with the mainnet id (11.1).
23. **Anchor's `#[event_cpi]` `program` slot** accepts any account in an instruction that emits
    nothing (a crank or payout with nothing to do); nothing changes (NOTES 38, noted for auditors).
24. **Bytes after an instruction's arguments are ignored** by every instruction (Anchor 0.31 decodes
    by prefix, 4.0); off-chain readers must decode by prefix too (review R10-FRESH-1).

---

## 10. Open owner decisions

The specification builds a default for each decision of section 13. The following are open: the
owner has not yet accepted the default or chosen an alternative. They are stated as in section 13;
nothing in the program changes until he decides.

| # | question | default (built) | alternatives in section 13 |
|---|---|---|---|
| O25 | the residual multi-run buyback risk (Theorem M_K) | accept and disclose: a buyer who holds through about 21 to 26 runs (16 to 21 for a founder) of a backlog above about 2.0% to 2.6% of depth (1.5% to 2.0% for a founder) with no other trading can profit; with one honest trade inside the hold the figures are lower (review KR-1); the sign-off covers configs within config #0's keep-up only (O36). Mitigated by the 0.1% step, V11, a keeper every interval, an alert above two caps and the backlog shown on the coin page | execute buybacks inside trades (contradicts R7's "executed separately" and R5; not offered) |
| O29 | the platform's key in the MEV rules (review HR-1) | not counted by V8 and V11; the operating rule of 8.4 keeps `FEE_RECIPIENT` and the owner's wallets out of city coins and founder seats | (a) count `b_P` in V8 and give the platform its own horizon in V11; (b) keep `b_P <= max(b_F, b_H)` in every config. Either changes which fee splits are allowed and needs a crate, model and vector change before the audit |
| O30 | the batch review window `BATCH_REVIEW_SECS` | 12 hours | 6 hours (a guardian member on call overnight); 1 to 2 hours (needs an automatic clear-only key on a server, which the owner ruled out); 24 hours (founders wait a further day). A compiled constant |
| O31 | the longest batch validity `BATCH_MAX_VALIDITY_SECS` and the SDK's default | at most 48 hours; the SDK proposes 36 | at most 24 hours (a late signature closes batch launches until the next batch); at most 72 hours (a weekend without signing; a stale founder can launch for up to three days) |
| O32 | who holds the launch approver key | a dedicated key in the owner's own wallet, used for nothing else, on a device or seed with no Squads member key, backed up offline | (a) a separate Squads multisig without a time lock (not supported by the verifier yet, review R8-DIFF-6); (b) a team member other than the owner |
| O33 | stale batch entries | accept and disclose (9 above) | a per-entry revocation the approver could sign (a second approver power and another account at launch; not built) |
| O34 | stops during the review window that do not depend on the guardian multisig | not built | a few clear-only stopper keys set by the admin (a new field and rule in the program, a larger audit scope) |
| O35 | the guardian multisig's configuration | controlled by the admin vault, no time lock, 1 of 3, at least two members able to act alone (the checklist refuses anything else) | an autonomous multisig with a threshold of 2 or more (slower stops; two members can remove the third) |
| O36 | the buyback share against the fixed per-run cap (review R9-PF-1) | not a program rule: the operating rule `C * b_B <= 3t` (config #0 at the edge), checked by `buybackKeepUp` and the checklist | (a) a rule V12 in `validate_config` with `K_B` = 3 or 8 (a new error, a binary change); (b) a per-run cap scaled by `b_B` (changes V8, V11 and Theorem M_K) |

Section 13 also lists O1 to O24 and O26 to O28 with the default this build implements; it marks
O3 (the 9.1 leftover coins), O9 (the guardian, because aggregators copy the 10-account trade list)
and O10 (native SOL against WSOL custody) for a decision before the audit freeze.

---

## 11. Rehearsal D01

`VICINITY-CURVE-DEVNET.md` records test D01 of 12.5, run on 23 October 2026 from 09:20 to 21:45
UTC with throwaway keys only (no mainnet key, RPC or account).

* **Where it ran: not on devnet itself.** The program account costs 3.750 SOL on devnet, the public
  faucet refused every request of the run and the proof-of-work faucets were empty, and the `devnet`
  build can approve and launch on devnet only after the old devnet deployer's key hands over the
  old program's admin and the rewards registry's admin, which the run was not permitted to do
  (sections 1 and 9). D01 ran on a local Agave 4.3.0 validator that cloned devnet's feature set and
  every program and account the `devnet` build reads (the old `vicinity_launchpad` with its
  `Launchpad` and configs, `vicinity_rewards` with its registry, Metaplex, Squads v4). The
  `devnet` build (sha256 `d052b8fc...`) was deployed at the throwaway id `nhgCm...` and read back
  byte for byte.
* **What was rehearsed** (81 transactions, each with its signature, compute, fee and size in
  section 11): 8.5's hand-over; a real Squads v4 guardian (controlled by the admin, 1 of 2, no time
  lock); init, config #0 and a demonstration config graduating at 1.000000001 SOL; a per-city
  approval and launch with the first buy; curve trading; a partially filled graduating buy capped
  by the SDK; pool trades and the drip; five buybacks (one on the curve, four in the pool);
  withdrawals, claims, two forwards into the city's `vicinity_rewards` WSOL vault created by
  `init_city`, a payout and its 24-hour cooldown; a guardian stop through `guardian-stop.mjs` (buys
  refused; sells, claims, withdrawals and buybacks working; the guardian unable to resume), the
  buyback-halt ordering and the admin's recovery; a batch built with the SDK, verified with
  `batch.mjs verify` on two RPC addresses, signed, confirmed and checked; a batch launch refused
  inside the 12-hour window and accepted after it (waited out in real time), a pending per-city
  approval winning over the batch; a guardian clear with halt, a publication refused, the admin's
  rotation and a new publication.
* **Results.** No program defect and no tool defect. Each coin held exactly `rent_reserve` plus its
  liabilities after the run (I9). Every compute figure was inside its 11.1 budget and within a few
  hundred units of the litesvm measurement where the inputs were the same; the differences have
  stated causes (devnet's Metaplex is another binary with 607-byte metadata accounts, the `devnet`
  build's bump searches, the validator's rent of 6,960 lamports per byte). One documentation point
  (limitation 13 above) and wording notes on the checklist and `check`.
* **Not reached**: devnet itself; the website's list and `verify --tx` (the batch page and the
  monitor are not built); two independent RPC providers (two addresses of one validator; against
  devnet itself `preflight.mjs` and `check` were run read-only, `check` through two real
  providers); a
  three-member guardian; a launch from the second batch (its window opened after the run); the
  `halt-all` build over live state (H03, covered in litesvm by `11-halts` and `test:vcurve`).
  Section 10 of that file says what running D01 on devnet itself needs from the owner.

---

## 12. Questions for the auditor

We ask the auditor to give these particular attention, besides a full review of the scope of 1.2
and 1.3.

1. **Custody.** Is `custody::pay_out` the only way lamports leave a `Coin`, and is its floor
   (`min(rent_reserve, live rent) + liabilities_after`, liabilities taken after the state update)
   correct for all five debits (6.5)? Does any instruction make a CPI after a direct lamport move
   other than the event CPI (the rule of 4.0)?
2. **Rounding and overflow in the math crate.** Do the rounding directions of 5.11 hold everywhere
   (the fee down, outputs down, the gross-up of Lemma G exact), do the bounds of 5.12 hold for every
   config V1 to V11 accept, and is every narrowing checked?
3. **Config validation.** Is `validate_config` (V1 to V11, V2b) complete for what sections 5 and 7
   claim of every accepted config? Rounds 3 and 9 each found a config class the rules did not bound
   (HR-1, R9-PF-1); are there others?
4. **Buyback MEV.** Do Theorem M, the split-leg bound and Theorem M_K (7.3) hold as implemented, and
   is the sign-off asked in O25 (and O29, O36) a fair statement of the residual?
5. **Graduation.** Can a buy, a sell or a buyback reach a half-graduated or doubly graduated state,
   or open the pool above the curve's last price (5.6, 5.10, I1, I5)?
6. **Accounts of `launch` and `launch_from_batch`** (22 each): are all of them validated, including
   the fixed-offset reads of the old program's and the rewards program's accounts (3.2, 8.5) and the
   Metaplex CPI's accounts?
7. **The batch path.** Is the leaf encoding injective and domain-separated (3.12), can an inner node
   or another deployment's leaf pass `verify_proof`, and does `batch_in_force` implement 8.6's table
   (supersession at the newer `valid_from`, a pending batch replaced, clears and halts)? Is the
   12-hour window enforceable against every sequence of publications and clears?
8. **Instruction data read twice.** The four city-level instructions read their leading arguments in
   `#[instruction(..)]` and in the handler, and bytes after the arguments are ignored (4.0, review
   R10-FRESH-1). Is there any path where the two readings can disagree?
9. **Roles and halts.** Can any key gain a power section 8.1 does not list, including through the
   order of instructions within one transaction (the seat walk of I19 and I24)? Can a flag the
   guardian sets make an admin recovery proposal fail other than as 4.4 states?
10. **The `halt-all` build and upgrades.** Does `halt-all` refuse every outflow (the nine handlers)
    while leaving every account layout identical, so that a deploy over live state and back is safe
    (H02, H03)?
11. **Anchor 0.31 specifics.** `no-idl` and the absence of the IDL instructions; `init` over
    pre-funded accounts (T55); the `#[event_cpi]` `program` slot (limitation 23); `Box` and the 4 KB
    stack frame (C04); the two crate types (NOTES 19).
12. **The test oracle.** Does `tests-curve/invariants.mjs` check what section 9 states, or does it
    trust anything it should verify (for example, the SDK math port it replays events through)?
13. **The owner's tools** (1.3). Can a compromised website, a lying RPC or a thief with the approver
    key make `batch.mjs verify`, `confirm` or `check` accept something the owner did not sign, or
    make `guardian-stop.mjs` report a stop that did not land?
14. **The integration with `vicinity_rewards`.** Is `forward_holders_fees` (the direct lamport credit
    of a WSOL vault, with `SyncNative` left to a separate top-level instruction) safe against every
    config `vicinity_rewards` can hold (4.15, R01 to R03)?

---

## Appendix: the gate run for this file

Run on 23 October 2026 with the toolchain of 2.1, on the tree of the commit that adds this file
(`cd56508` plus the three documentation files of 1.1) before this table was written into it; no
test reads this file. The script is a local copy of the CI steps of `.github/workflows/solana.yml`
for the curve, plus the repository's other suites; the same steps were also run on `cd56508`
itself with the same results. Logs are not committed.

| # | step (from `solana/`, the last two from the repository root) | result | time | detail |
|---|---|---|---|---|
| 1 | `cargo fmt --all -- --check` | PASS | 1 s |  |
| 2 | `cargo clippy --all-targets -- -D warnings` | PASS | 1 s |  |
| 3 | `cargo clippy --all-targets --features short-windows -- -D warnings` | PASS | 1 s |  |
| 4 | `cargo clippy -p vicinity-curve --all-targets --features devnet -- -D warnings` | PASS | 2 s |  |
| 5 | `cargo clippy -p vicinity-curve --all-targets --features halt-all -- -D warnings` | PASS | 2 s |  |
| 6 | `cargo test` | PASS | 15 s | 187 passed, 0 failed (14 test binaries) |
| 7 | `cargo test -p vicinity-curve --features devnet` | PASS | 2 s | 77 passed, 0 failed (2 test binaries) |
| 8 | `cargo test -p vicinity-curve --features halt-all` | PASS | 3 s | 77 passed, 0 failed (2 test binaries) |
| 9 | `anchor build` | PASS | 16 s |  |
| 10 | no stack warning in anchor build | PASS | | |
| 11 | `diff target/idl/vicinity_curve.json sdk/idl/vicinity_curve.json` | PASS | 0 s |  |
| 12 | `diff target/idl/vicinity_rewards.json sdk/idl/vicinity_rewards.json` | PASS | 0 s |  |
| 13 | `diff target/idl/vicinity_launchpad.json sdk/idl/vicinity_launchpad.json` | PASS | 0 s |  |
| 14 | `npm run vcurve:idl` | PASS | 0 s |  |
| 15 | `git diff --exit-code -- sdk/idl/vicinity_curve.json` | PASS | 0 s |  |
| 16 | `npm run vcurve:idl:check` | PASS | 0 s |  |
| 17 | `npm run vcurve:sbf` | PASS | 34 s | no stack warning: yes |
| 18 | hash 0a5beef231cfcc1327d9e497bb631f7c8edc99468338daed932ddce90bba3b5b | PASS | | |
| 19 | hash d052b8fccf5ed0fc9bbb0ee56e4a77ae5a3ec99c6fa6c906119f51db71c18fa3 | PASS | | |
| 20 | hash 4d631647c38230690ad57a28e49d021e0ad956a7edbc454dc107558849a0d868 | PASS | | |
| 21 | `sha256sum target/deploy/vicinity_curve.so` | PASS | 0 s | 0a5beef231cfcc13... |
| 22 | `npm run curve:router` | PASS | 1 s |  |
| 23 | `npm run test:vcurve` | PASS | 1 s | 1 tests, 1 passed, 0 failed |
| 24 | `npm run sdk-test:curve` | PASS | 2 s | 52 tests, 52 passed, 0 failed |
| 25 | `npm run test:curve` | PASS | 177 s | 203 tests, 203 passed, 0 failed |
| 26 | `bash -c cp <pinned dumps>/*.so tests-launchpad/fixtures/programs/` | PASS | 0 s |  |
| 27 | `npm run test:launchpad` | PASS | 36 s | 155 tests, 155 passed, 0 failed |
| 28 | `bash -c node scripts/copy-assets.mjs && node scripts/pages/build.mjs && npm test` | PASS | 61 s | 1910 tests, 1909 passed, 0 failed, 1 skipped |
| 29 | `git status --porcelain` | PASS | 0 s | modified: `solana/README.md`, `solana/VICINITY-CURVE-DESIGN.md`; new: `solana/VICINITY-CURVE-AUDIT.md`; untracked symlinks, never committed: `node_modules`, `solana/node_modules`, `solana/target` |
