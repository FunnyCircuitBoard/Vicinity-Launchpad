# `vicinity_curve`: audit pack

For the outside auditor of the Solana program `vicinity_curve`, the custom Vicinity launchpad
(draft PR #83 of `FunnyCircuitBoard/Vicinity-Launchpad`, branch `feat/vicinity-curve`, not
merged). Prepared on 23 October 2026 and revised on 24 October 2026 after a review of the pack
itself (the end of section 8 lists its items and where each is answered). Every figure below is
taken from the repository or from a command run for this file on those days; each names its
source. Section numbers without a file name ("3.2", "8.4", "Appendix C") are sections of `VICINITY-CURVE-DESIGN.md` (the specification);
"NOTES n" is entry n of `VICINITY-CURVE-NOTES.md` (the implementation notes);
`VICINITY-CURVE-DEVNET.md` is the record of rehearsal D01.

Status: nothing of this program has been deployed to mainnet or signed for it, and the repository
holds no mainnet program id for it (3.1: the owner generates that key on his own machine). The
mainnet deployment waits for this audit (1.3). The
two programs already on mainnet, `vicinity_rewards` and the old `vicinity_launchpad`, are not
changed by this work. As of this pack's date the mainnet preconditions of 8.4 and 8.5 are not
met: the rewards registry's and the old program's admin are still the owner's hot wallet, the old
program's launches are open, the vault's multisig has no time lock and has that hot wallet among
its members, and no guardian multisig exists (section 5).

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
| commit of the code in scope | `bf17550612b6b6ec56fec6bb8beb964d69bfefaf` (this revision); the first revision of the pack (`0ed0ef8`) named `cd56508fc3274a84960b04c06b4f4f8f2282e656` |
| what changed in scope since `cd56508` | only `scripts/vcurve/preflight.mjs` (1.3): the checklist refuses `FEE_RECIPIENT` as a member key of the vault's, the guardian's or the approver's multisig, and reads the vault's multisig before the `Launchpad` exists (section 5; NOTES 106). `git diff --stat cd56508 bf17550 -- solana/programs/vicinity-curve solana/crates solana/Cargo.toml solana/Cargo.lock solana/sdk` is empty |
| last change to the program or crate source | `f76c646` (review round 7: a doc comment in `state.rs`, which changed the IDL and not the binary) |
| last change to the program binary | `ae8e071` (review round 6); the production build has been sha256 `0a5beef2...` since (Appendix C, rounds 7 to 10; re-built for this file, 2.3) |
| CI (`.github/workflows/solana.yml`, "Solana program") | `bf17550`: run 40042968961, green (both jobs; `test:curve` 204 passed, `test:launchpad` 155, `sdk-test:curve` 52, finished 24 October 00:18 UTC; the repository's "CI" run 40042968868 green too); earlier: `cd56508` run 40030886477 and `0ed0ef8` run 40034706784, both green. CI builds the three binaries but compares no hash with an expected value, and its toolchain gives other hashes (2.3) |
| `main` | the branch is 11 commits behind `main` (at `0ed0ef8`); the merge base is `d89e26f`. Under `solana/` those commits change only `sdk/launchpad/metadata.mts`, `sdk/launchpad/metadata.test.mts` and `tests-launchpad/22-batch-approvals.test.mjs` (the rest is the website at the repository root), none of them in scope: merging `main` moves the commit but changes no in-scope file |

The commit that adds this revision of the pack (on top of `bf17550`) changes documentation
only: `git diff --stat bf17550 <that commit>` lists `.md` files and nothing else.

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
| `scripts/vcurve/preflight.mjs` | 580 | the deploy checklist and its proposed-key checks (8.4 preconditions and operating rules, the multisigs behind the admin, the guardian and the approver) |
| `sdk/curve/batch.mjs` | 448 | the launch leaf, tree and proof builder and the in-force function (3.12, 8.6) |
| `sdk/curve/math.mjs` | 689 | the JavaScript port of the math crate (the checker and every client quote use it) |
| `sdk/curve/prechecks.mjs`, `compose.mjs` | 130, 352 | the size-dependent slippage policy and the composed buy (5.15, 14.1, T78 to T80) |
| `sdk/curve/events.mjs` | 254 | the transaction-level event decoder with the acceptance rule of 4.21 (T56) |
| `sdk/curve/accounts.mjs`, `constants.mjs`, `instructions.mjs`, `pda.mjs`, `rewards.mjs`, `index.mjs` | 245, 236, 385, 97, 210, 14 | decoders, constants, instruction builders, addresses, the rewards-config checks |

### 1.4 Reference material (not code under audit)

* The test suites of section 3 and their harness: the per-transaction checker
  `tests-curve/invariants.mjs` (1,474 lines), the world `tests-curve/helpers.mjs` (852), the fuzz
  model `tests-curve/fuzz.mjs` (1,160), the test-only router `tests-curve/router/`, the 46 mutant
  builds of `scripts/vcurve/batch-mutants.py` (43 in NOTES 77, three more in NOTES 82; all 46 run
  again for this revision, section 3). The checker is the test oracle for section 9; whether it
  checks what section 9 says is question 12 of section 12.
* The record of rehearsal D01, `rehearsals/vicinity-curve-d01/` (its driver as run and every
  transaction record and tool output it kept; `VICINITY-CURVE-DEVNET.md` section 12). It is a
  record of a run on a local validator, not evidence anyone can look up on a cluster (section 11).
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
* Key generation, deployment and the Squads configuration on mainnet (operating steps of 8.4). As
  of this pack's date those steps have not been taken and the preconditions they must meet are
  not met; section 5 lists the mainnet state read on 23 October 2026.
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

### 2.3 Expected hashes at `bf17550` (the same as at `cd56508`)

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
be this source with the owner's program id, so its hash will differ from the table; 8.4 and C03
require that binary's hash to be published with a verified build before it is deployed, and 11.1
says the compute figures are measured again with that id. Every place the throwaway id appears
(`git grep nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk`), and what the mainnet id changes there:

| file (under `solana/`) | what it is | changes |
|---|---|---|
| `programs/vicinity-curve/src/lib.rs` line 56, `declare_id!` | the program's own id | **the binary** (the only place compiled into it) |
| `Anchor.toml`, `[programs.localnet]` and `[programs.devnet]` | which keypair `anchor build` and `anchor deploy` expect | the build configuration, not the bytes |
| `crates/vicinity-curve-math/src/constants.rs`, `PROGRAM_ID` (in scope) | the owner `decode_coin` requires, for off-chain readers | not the binary: `decode_coin` is not linked into the program (a clean build with `PROGRAM_ID` replaced by other bytes gave the same `0a5beef2...`, checked for this revision); the crate's tests (`tests/unit.rs` line 1209) |
| `sdk/idl/vicinity_curve.json`, `address` | the client IDL | regenerated by `npm run vcurve:idl` |
| `sdk/curve/constants.mjs`, `CURVE_PROGRAM_ID` | the SDK's id: every client, the owner's tools, the checker | the SDK and the tools |
| `sdk/fixtures/launch-batch.json`; `sdk/curve/batch.test.mjs`; `programs/vicinity-curve/src/batch.rs` line 285 (a unit test); `tests-curve/27-checker-gaps.test.mjs` (a message pattern) | the shared leaf fixture (every leaf contains the program id, so its leaves and root change) and tests | the fixtures and tests |
| the `.md` files | text | nothing |

**CI builds other binaries.** CI installs Agave 4.3.0 from `release.anza.xyz`, whose
cargo-build-sbf is 4.3.0 (platform-tools v1.57, rustc 1.95.0); the hashes above come from
cargo-build-sbf 4.4.0 of the release at `stable-44b42d45` (2.1), whose `solana` reports 4.3.0. For
the same source CI printed production 768,080 bytes `9f4bf9ff6aaf2013aa65c8c52b657dc5d124144fb545bf60d01dede9f4a614dd`,
devnet 768,080 `5ff03bc2a3f3d73b89583017e0290900d9b1180dd785cbf7a7ac8cde5cfbd17e` and halt-all
766,864 `86b27af9cb70b268a19b1ad2fbb61ebec0eb9a67a83efbd9a401f3bfd14094b9` (runs 40030886477 for
`cd56508` and 40034706784 for `0ed0ef8`; and the same three for `bf17550`, run 40042968961). CI compares no hash with an expected
value, so the hashes of this table were checked on one machine only (2.4) and nothing a third party
runs pins them; the verified build of 8.4 decides the mainnet binary's hash.

### 2.4 How the hashes were checked for this file

1. `npm run vcurve:sbf` in the working tree: the three hashes of 2.3, "no stack warning: yes"
   (33 s with the dependencies cached).
2. A clean copy: `git archive cd56508 solana | tar -x` into a new directory with no `target/`,
   then `bash scripts/vcurve/sbf-builds.sh` there: the same three hashes (2 min 35 s, dependencies
   compiled afresh from the warm cargo registry cache of the same machine). The source paths
   embedded in the binary are relative only (`strings` shows `programs/vicinity-curve/src/...`,
   `src/...` and Rust's `library/...`; no `/root`, `/home`, `/tmp` or cargo registry path), so the
   build directory does not enter it. For this revision, again from `git archive 0ed0ef8` with the
   math crate's `PROGRAM_ID` replaced by other bytes: the production hash `0a5beef2...` (2 min 32 s;
   the table of 2.3).
3. `anchor build`: `target/deploy/vicinity_curve.so` has the production hash `0a5beef2...`.
4. D01: the devnet build was deployed to D01's local validator and read back from it byte for byte
   (`VICINITY-CURVE-DEVNET.md` section 3); not on devnet, and that validator's ledger was not kept
   (section 11).
5. The full gate of the Appendix ran `npm run vcurve:sbf` again and found the three hashes.
6. CI's builds of the same source differ (2.3): its toolchain is cargo-build-sbf 4.3.0.

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
| property tests at 10^6 cases | `PROPTEST_CASES=1000000 cargo test --release -p vicinity-curve-math --test props` and `--test no_free_value` | 12.2's "at least 10^6 cases each" (CI runs 1,024 to 4,096 cases, NOTES 1, 35) | run for the first revision of this file (23 October; the crate has not changed since), release build: 12 passed (85.6 s) and 3 passed (32.1 s); the review of the pack ran them again: 12 and 3 passed |
| smoke | `npm run test:vcurve` | `tests-vcurve/00-smoke`: one coin's life on the production build, then the halt-all build over it and back | 1 passed |
| SDK | `npm run sdk-test:curve` | `sdk/curve/*.test.mjs`: math parity, events, IDL, batch leaves and proofs, the client pre-checks | 52 passed |
| litesvm lifecycle and attack suites | `npm run test:curve` | `tests-curve/01` to `34` (the table in `tests-curve/README.md`); the checker of section 7 after every successful transaction, with the exceptions section 7 names | 204 passed (about 3 minutes; 203 before this revision's checklist test) |
| fuzz, longer | `VCURVE_FUZZ_STEPS=n VCURVE_FUZZ_SEEDS=s node --test tests-curve/23-fuzz.test.mjs` | F01 and F02 with the model byte-equal after every transaction (CI: 300 steps on seeds 1 and 2) | run for the first revision of this file (23 October; the program has not changed since): seed 11, 20,000 steps, passed in 7 min 30 s: 16,155 transactions, 9,696 succeeded and 6,459 failed: 3,830 as the model predicted, 2,370 invalid variants refused and 259 steps whose outcome the model leaves open (`fuzz.mjs`, `anyOutcome`). Of the 2,392 invalid variants, 2,370 were refused, 14 succeeded legitimately (4 replaced a free slot and were re-synced, 10 replaced the `program` slot of an instruction that emitted nothing) and 8 could not be built (never sent, so not among the 16,155); 16 coins launched and graduated; 283 publications, 70 clears and 9 batch launches accepted. The run is deterministic for a seed (reproduced exactly in the review of this pack). Earlier long runs: seed 7 at 100,000 steps and seed 8 at 30,000 before the batch path (NOTES 38), eight seeds of 2,500 steps with it (NOTES 76) |
| batch mutants | `python3 scripts/vcurve/batch-mutants.py . <out dir>` | 46 mutant programs, one batch rule removed or weakened in each, run against `30-batch` (H02 for the halt-all mutant) with and without the checker (`MUTANT_CHECKS_OFF=1`; NOTES 77, 82) | 43 of them were last recorded (NOTES 77) at `fd516a6` (18 October), before round 6's `ae8e071` changed `publish_launch_batch`, `clear_launch_batch` and `set_launch_approver`; NOTES 82 ran only its three new mutants on the round-6 binary. Run again for this revision on `git archive 0ed0ef8` (the program and tests of the commit in scope): on 23 October 2026, 46 of 46 killed with the checker (23:26 to 23:42 UTC) and 46 of 46 without it (23:42 to 23:54); every pattern still applied, and each mutant was killed by a failing test of `30-batch` (45) or, for the halt-all mutant, `11-halts` (H02); the reviewer of this pack reported the same result independently |

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
in one SPL token account it owns (`["coin_vault", coin]`). In the Rust source and the IDL the
`Coin` account is the type `CurveCoin` (discriminator `sha256("account:CurveCoin")[..8]`), named so
that it shares no discriminator with the old program's `Coin` (review SEC-8); this file says `Coin`.
One coin per city across both programs: the old program's `Coin` and `Approval` for the city are
checked at every approval and launch (8.5). One coin per ticker within this program only
(`TickerLock`, permanent): the old program has no ticker lock and no old-program ticker is read, so
the ticker of an old-program coin can be used here for another city.

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
counters, never from balances (1.3), so donations are surplus (T7, T8). Sells, claims and
withdrawals cannot be stopped without an upgrade. Forwards can pause, the money waiting in
`holders_pending`: `forward_holders_fees` requires the city's rewards `CityConfig.authority` to be
this program's admin with no authority transfer pending (`helpers.rs`, `check_rewards_authority`),
so after an admin hand-over here (`accept_admin`) every forward fails until each city's rewards
authority has followed (GOV-5, 4.2), and a city's forwards fail while a rewards-authority transfer
of that city is pending in `vicinity_rewards`, which the vault, as rewards authority, can start.
The guardian and the admin can stop buys, buybacks and launches (8.3); the `halt-all` build,
deployed by upgrade, stops every outflow.

---

## 5. Roles and keys

From 8.1, where each row has its references. "Program" means the program refuses it; "rule" means
an operating rule of 8.4 that the deploy checklist checks where it can. The table states the
target state of 8.4 and 8.5; what holds on mainnet today is listed after it.

| key | can | cannot |
|---|---|---|
| **admin**: the Squads vault `AB5qB1iAukPB7p1dkukQ1qSke3yQBDeSd5o69dLFGs7X` (vault 0 of the Squads v4 multisig `6v8hwKYSAWXXx6ZGGmvbg87n8eVy9MAgNruFgVqRFjYV`, 2 of 3; members `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` (`FEE_RECIPIENT`, the owner's hot wallet), `3W8yhnhbU12jQTVZEmJFuoLPBqGU5vJEpmVUWLeeUz2U` and `9CRkALHoEvjAjyXg3P1VCaXMpNTpTsdvDJGR8WzNNH9K`, each with every permission; read on 23 October 2026). By 8.4 and 8.5 it is to be the upgrade authority and, in `vicinity_rewards`, the registry admin, every city's rewards authority and the upgrade authority, and the old program's admin (the program enforces the last, 8.5); the registry admin and the old program's admin are not yet the vault (below), and by 8.4's rule since this revision `FEE_RECIPIENT` leaves the members before the deploy | approve and revoke launches; add configs inside V1 to V11 and enable or disable them; set any pause flag either way; set the payout key and wallet, the guardian and the launch approver; hand over the admin seat in two steps; clear launch batches. As upgrade authority: replace the program (including with `halt-all`) and so take every coin's reserves and buckets, after the 48-hour time lock once the first coin is live (O11). As rewards authority: publish the Merkle roots that decide who receives the holders' money | without an upgrade: move any lamport or token; change a live coin's split, curve, founder or state; block sells, claims or withdrawals (forwards pause during its own hand-over or a pending rewards-authority transfer, section 4); redirect platform fees; change the compiled program ids; mint; freeze; create a second coin for a city or a ticker |
| **guardian**: a separate Squads multisig with no time lock, 1 of 3, controlled by the vault (O35); never `FEE_RECIPIENT`, the payout key or wallet, the admin, the proposed admin or the launch approver (program); `FEE_RECIPIENT` none of its members (rule, checked) | `set_pause` setting `launches`, `buys` and, only while buys are halted, `buybacks` to true; `clear_launch_batch`, with or without halting publication. Each member stops with one transaction (`guardian-stop.mjs`) | clear any flag; lift a batch halt; publish; block exits; touch money; change any setting |
| **launch approver** (`Launchpad.launch_approver`; zero turns the batch path off): a dedicated key in the owner's own wallet, on a device or seed with no Squads member key (O32, rule) | `publish_launch_batch`: one Merkle root of at most 512 entries (founder, config, name, ticker, metadata hash per city with no coin), in force no sooner than 12 hours after publication and for at most 48 hours (O30, O31); `clear_launch_batch` | move money; launch for a founder; shorten the review window or lengthen the validity; approve what a per-city launch would refuse; change any setting, flag, config or live coin; lift a halt; publish while halted. It is never `FEE_RECIPIENT`, the admin, the proposed admin, the guardian, the payout key or wallet (program) |
| **payout key** (off by default) | `payout_founder_fees` for opted-in founders, to the fixed payout wallet, once a day per coin; pause payouts | resume payouts; pay anywhere else; touch another bucket |
| **founder** (per coin, chosen at approval or named in a batch; never `FEE_RECIPIENT`, the guardian, the payout key or the launch approver, program) | claim, opt in or out of payouts, hand the seat over with both signatures | touch another bucket or coin |
| **keeper** (Vicinity's fee-payer hot key, O24; not built) | sign permissionless cranks as fee payer: `buyback_burn`, `withdraw_platform_fees`, `forward_holders_fees`; send the rent top-up of 6.5 (a plain transfer) | anything a stranger cannot do; it receives nothing (I21) |
| **`FEE_RECIPIENT`** `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` (compiled; the owner's hot wallet) | receive launch fees and platform withdrawals; trade like any wallet. **Outside this program, today**: it is one of the three members of the admin vault's multisig (above), so a stolen `FEE_RECIPIENT` key is one of the two signatures that act as the admin and the upgrade authority of all three programs; and it is still the rewards registry's and the old program's admin (below) | hold any seat in this program (program: admin, proposed admin, guardian, payout key or wallet, founder, launch approver, upgrade authority at `init_launchpad`); later moves of the upgrade authority, its holding of city coins (8.4, O29) and, since this revision, any membership of the vault's, the guardian's or the approver's multisig are rules: the checklist refuses each membership (`FEE_RECIPIENT_IS_VAULT_MEMBER`, `FEE_RECIPIENT_IS_GUARDIAN_MEMBER`, `FEE_RECIPIENT_IS_APPROVER_MEMBER`), and on mainnet the first is not met yet |
| **anyone** | trade; run `buyback_burn`, `withdraw_platform_fees`, `forward_holders_fees`; revoke an expired approval | everything else |
| **website** | build unsigned transactions; compute the daily batch list; give founders their entries and proofs | hold any admin, guardian, payout, approver or upgrade key (8.1, 8.4) |

Worst cases (8.1): two of the three Squads keys can, as upgrade authority, take everything after
the 48-hour time lock, during which holders can sell and the guardian can halt buys (today one of
the three is `FEE_RECIPIENT`'s hot wallet and no time lock is set: a theft of that key and of one
other member key would act at once; 8.4 closes both: `FEE_RECIPIENT` leaves the members before the
deploy, and the time lock is set before the first coin launches, O11); a stolen launch
approver key can let founders of the thief's choosing take up to 512 cities without a coin per
publication that nobody clears within its 12-hour window, and a thief who goes unnoticed can
publish again, each new batch taking force 12 hours after its publication, but it reaches no
lamport or token; a stolen guardian can halt buys, buybacks and launches and halt the batch path
(`clear_launch_batch(halt = true)`) until the admin replaces it and sets the launch approver again
(`set_launch_approver` lifts the halt); a stolen payout key reaches only opted-in founders' shares,
to the agreed wallet, daily; a stolen founder key reaches that coin's `founder_pending`.

**Mainnet state on 23 October 2026** (read-only: `node scripts/vcurve/preflight.mjs --rpc
https://api.mainnet-beta.solana.com --vault AB5qB1iAukPB7p1dkukQ1qSke3yQBDeSd5o69dLFGs7X
--vault-multisig 6v8hwKYSAWXXx6ZGGmvbg87n8eVy9MAgNruFgVqRFjYV --cluster mainnet`, at 23:34 UTC;
the multisig read with `getAccountInfo` at slot 460,627,954). These are preconditions of 8.4 and
8.5 that are **not met yet**; the checklist reports 8 problems and one warning:

| what | state | checklist |
|---|---|---|
| `vicinity_curve` | not deployed (no `Launchpad`, no ProgramData, no config #0): expected before the deploy | `CURVE_LAUNCHPAD`, `CURVE_UPGRADE_AUTHORITY`, `CONFIG0` |
| `vicinity_rewards`' registry admin | `13qRam...` (`FEE_RECIPIENT`), nothing pending; not the vault | `REWARDS_REGISTRY_ADMIN` |
| the old `vicinity_launchpad`'s admin | `13qRam...` (`FEE_RECIPIENT`), nothing pending; not the vault | `LEGACY_ADMIN` |
| the old program's launches | open | `LEGACY_LAUNCHES_OPEN` |
| the old program's `LaunchConfig` `6voKQ4uGtc5YShMJ1a3Xf9ahb1MRf5VTWqKfdidAiY75` | enabled | `LEGACY_CONFIG_ENABLED` |
| upgrade authority of `vicinity_rewards` and of the old program | the vault | no problem |
| the vault's multisig `6v8hwKYSAWXXx6ZGGmvbg87n8eVy9MAgNruFgVqRFjYV` | autonomous (config authority none), 2 of 3, time lock 0, `FEE_RECIPIENT` one of the three members | warning `VAULT_TIME_LOCK_UNSET` (O11: 48 hours from the first coin launch); `FEE_RECIPIENT_IS_VAULT_MEMBER` (new in this revision; the first revision's checklist read no multisig while no `Launchpad` existed and printed nothing about it) |
| the guardian multisig | none named yet (no `Launchpad`, so no guardian is set) | (checked once the guardian is proposed, with `--guardian-multisig`) |

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
property over sequences; review R5-CONS-5), except the OPS-4 test of `28-governance`, which turns
the checker off (`w.checks = false`) to close the old program with the loader, and
`checkFailedTransaction` (line 310) checks that a failed transaction moved nothing but its fee.
I22's liveness probe runs after every successful transaction too, except where a test turns it
off and runs it once at the end instead (`probeEach = false`): one test of `16-attacks-trading`
(300 steps), two of `20-attacks-runtime` (rent changes), `22-g01-onchain` (once per life),
`24-configs-f03`, `25-no-free-value`, one test of `27-checker-gaps` and the fuzz (at the end and
every `probeEvery` steps); a few sends of `14-attacks` and `24-configs-f03` pass `noProbe`. The
mutant runs of section 3 use `VCURVE_INVARIANTS=off` by design in their second mode. The checker's entry point is `checkTransaction`
(line 460); the line numbers below are of that file at `bf17550` (unchanged since `cd56508`).

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
| I21 | no money path to the guardian, payout key, launch approver, upgrade authority or keeper. The admin can be paid only as a founder it approved itself (allowed by the program: `check_founder_key` does not refuse the admin; refused by the checker) and gets back an `Approval`'s rent (at `launch` and `revoke_approval`, to `rent_payer`, which `approve_launch` sets to the admin) | the fixed destinations of 6.4; role separation, except for the admin | `checkTransaction` (575, 610); X43, X43b |
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
(rounds 1 to 10, 17 to 23 October 2026). **Who reviewed**: every review here, the specification's
included, was internal and automated: AI agents (Claude) run in the same workflow that wrote the
code, each finding reproduced by a separate verifier agent of the same kind before it was accepted;
every commit on the branch is authored "Claude". None of them is an independent human audit; this
outside audit is the first. The severities are the verifiers'. Appendix C has every finding, its
response and, where a part was not applied, the reason. Rows with one root cause count once, at
their highest severity (the number of finding ids is given too).

**The batch path entered after round 5.** The batch launch approval (`launch_from_batch`,
`publish_launch_batch`, `clear_launch_batch`, `init_launch_batch`, `set_launch_approver`,
`batch.rs`) was specified after round 5 (`0fb6379`, 17 October 23:21 UTC) and added to the program
by `a5fbb42` (18 October 00:21; 2,570 lines added in the program, 944 of them `batch.rs`, mostly its
tests). Rounds 1 to 5 never saw it; only rounds 6 to 10 did. By `git blame` of the in-scope ranges
of 1.2, 1,363 of the 5,446 program lines (and 818 of the 2,840 handler lines) are from `a5fbb42`,
round 6's `ae8e071` or round 7's doc comment `f76c646`.

**When.** The repository does not record when each review started; each began after the previous
round's last commit, and the table gives the commits that answered it (UTC). Rounds 7 to 10,
including their fixes and verifications, all fall between 01:44 and 09:11 UTC on 23 October.

| round (date; answering commits, UTC) | lenses | rows (ids) | severity | outcome | what changed the program |
|---|---|---|---|---|---|
| spec revision 1 (before the build; the specification's first commit is `ee62c31`, 17 Oct 02:37) | security, math, runtime, integration | 46 (46) | 2 blocker, 14 major, 25 minor, 5 nit | all applied (INT-2 in part) | the design itself (revision 2) |
| 1 (17 Oct; after the build's last commit at 10:42, answered 13:29 to 13:39) | accounts, custody, math, governance, integration | 11 (11) | 2 medium, 3 low, 6 info | 5 fixed; 6 rejected | GOV-1 (the old program's admin must be this admin, `LegacyAdminMismatch`), GOV-2 (`FeeRecipientRole`) |
| 2 (17 Oct; 15:16 to 15:40) | round-1 fix diff, conformance, attacker economics, fresh audit | 4 (4) | 3 low, 1 info | 4 fixed | R2-DIFF-1 and SPEC-1 (role keys refused as founders; `FEE_RECIPIENT` as upgrade authority at init), ECON-1 (V2b in the crate), FA-1 (`check_name`) |
| 3 (17 Oct; 17:12 to 18:04) | round-2 fix diff, math, lifecycle, hostile roles, clients | 8 (8) | 1 medium, 3 low, 4 info | 6 fixed (HR-1 as text and operating rule, O29 open); 2 rejected | R3-DIFF-1 and MATH3-2 (V2b as a sum), LL-1 (separate `buybacks_halted`) |
| 4 (17 Oct; 19:44 to 20:23) | round-3 fix diff, operations, cross-program calls, state machine, SDK and docs | 13 (18) | 7 low, 6 info | 13 fixed | OPS-1 (the rewards registry's admin at every approval and launch) |
| 5 (17 Oct; 22:06 to 22:35) | round-4 fix diff, registry dependency, economics, consistency, cross-coin arithmetic | 12 (14) | 5 low, 5 info, 2 nit | 9 fixed; 3 rejected | R5-CONS-1 (`GuardianIsAdmin`) |
| 6 (18 Oct in Appendix C, after the batch path's last commit at 18 Oct 01:17; answered by four commits dated 23 Oct 01:44) | the batch launch approval: diff, Merkle and leaf code, roles and timing | 6 (7) | 2 medium, 2 low, 2 info | 5 fixed (O34, O35 opened); 1 rejected | R6-RT-3 (the three batch settings events as event CPIs) |
| 7 (23 Oct; 03:53) | batch attacker, conformance; verification of round 6 against the real program and Squads v4 | 11 (13) | 3 medium, 4 low, 3 info, 1 none | 9 fixed; 1 noted; 1 rejected | none (a doc comment; IDL only) |
| 8 (23 Oct; 05:45, its verification 06:22) | operator under attack, round-7 diff; verification of round 8 | 11 (12) | 7 low, 4 info | 11 fixed | none |
| 9 (23 Oct; 07:32, its verification 08:04) | round-8 tools diff, program funds; verification of round 9 | 5 (5) | 4 low, 1 info | 5 fixed (R9-PF-1 as an operating rule, the SDK's `buybackKeepUp` and the checklist; O36 open) | none |
| 10 (23 Oct; 08:49 to 09:11) | the program fresh (instruction data read twice); the owner's tools | 2 (2) | 2 info | 1 fixed in the checker and tests; 1 rejected as a defect and hardened | none |
| **build rounds 1 to 10** | | **83 (94)** | **0 high, 8 medium, 38 low, 34 info, 2 nit, 1 none** | **68 fixed or applied, 14 rejected, 1 noted** | rounds 1 to 6 only |

Where the fixes went: rounds 1 to 6 changed the program or the crate in the rows named above, and
the SDK, the checker and the text elsewhere; rounds 7 to 10 changed only the owner's tools
(`scripts/vcurve/`), the SDK's client helpers, the checker, the tests and the text. Two reported
"high" findings were judged medium by the verifier (R3-CLI-1, R6-RT-1). Rounds 7 to 10 changed
no program code. Two findings of those rounds were about the program's own behaviour: R9-PF-1 (the
buyback share against the fixed per-run cap), answered by an operating rule, the SDK and the
checklist, its program rule open as decision O36; and R10-FRESH-1 (every instruction accepts bytes
after its arguments, Anchor 0.31 decoding by prefix), accepted as the program's behaviour, with the
checker and the tests changed (limitation 24).

What was rejected, and why (Appendix C has the full reasons):

| id | round | reason |
|---|---|---|
| ACPI-1 | 1 | specified and tested (4.15, T70, `09-outflows`): a forward without a config fails before its no-op check; the keeper skips errors |
| LC-INFO-1, MATH-INFO-1 | 1 | SIMD-0392 is active on mainnet, devnet, testnet and in litesvm; its side point is now stated in 6.5 and T63 |
| GOV-3 | 1 | intended and tested (X50): the founder agreed to that payout wallet by name |
| GOV-4 | 1 | the time lock is a Squads property and already a precondition (8.4) |
| GOV-5 | 1 | specified (4.2, 8.2) and tested |
| HR-2 | 3 | the recorded design (4.17, T52, O22): the seat moves only with both signatures |
| HR-3 | 3 | recorded (R9, 3.2): `FEE_RECIPIENT` changes only by upgrade; no third party's money is reachable. **Revisited in this revision**: that reasoning left out that `FEE_RECIPIENT` is one of the three members of the admin vault's 2-of-3 multisig, so its stolen key is one of the two signatures that act as the admin and upgrade authority of all three programs. The rejection stands for what HR-3 reported (the platform's income); the membership is now 8.4's operating rule (`FEE_RECIPIENT` is no member of the vault's, the guardian's or the approver's multisig) and the checklist refuses it; on mainnet it is not met yet (section 5) |
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

**The review of this pack (23 October 2026).** The first revision of this file (`0ed0ef8`) and of
`VICINITY-CURVE-DEVNET.md` were reviewed in the same internal, automated way (it found no program
defect and re-derived most figures; the program binary did not change). Each item was checked
before it was answered (Appendix C of the specification, "the review of the audit pack", has the
same list):

| item | answered in |
|---|---|
| `FEE_RECIPIENT` is a member of the admin vault's multisig; the checklist was silent; HR-3's reasoning left it out | 1.1, 5 (admin and `FEE_RECIPIENT` rows, worst cases, mainnet state), 8 (HR-3), 9 item 1; 8.4's new operating rule and the checklist's `FEE_RECIPIENT_IS_*_MEMBER` (NOTES 106; `32-batch-checklist`) |
| the admin row described the target state as current; the multisig shortened | 5 (full addresses, mainnet state), 1.5, the status paragraph |
| who reviewed; the batch path after round 5; the time of each round | 8 |
| "no instruction can stop a forward" | 4, 5 |
| I21 overstated (the admin as a self-approved founder; `Approval` rent) | 7 |
| section 10 incomplete; section 9's opening sentence | 9, 10 |
| D01's signatures cannot be looked up; the record not kept | 11, 1.4; `rehearsals/vicinity-curve-d01/`; `VICINITY-CURVE-DEVNET.md` sections 3, 11 and 12 |
| the mutants' basis stale | 3 (all 46 run again) |
| the fuzz's failure breakdown | 3 |
| the checker and the I22 probe are not on everywhere | 7 |
| one coin per ticker is not checked across the old program | 4 |
| 512 cities per publication, not in all; the guardian's batch halt | 5, 9 item 8 |
| the guardian stop's cost and count are D01's | 9 item 13; `VICINITY-CURVE-DEVNET.md` section 8 item 5 |
| "every item of D01"; the specification and NOTES said D01's batch rehearsal was not built | 11; `VICINITY-CURVE-DEVNET.md`; the specification's Appendix C status and NOTES 76, 87 |
| devnet's Squads binary not recorded | 11; `VICINITY-CURVE-DEVNET.md` section 1 |
| every file holding the throwaway program id | 2.3 |
| `Coin` is the type `CurveCoin` | 4 |
| R10-FRESH-1 is about the program's own behaviour too | 8 |
| `strings` shows `library/...` too | 2.4 |
| CI does not pin the hashes; no CI run cited; `main` | 1.1, 2.3, 2.4 (CI's own builds differ) |
| D01's small inconsistencies (the graduating buy's offer, the payout wallet's funding, a litesvm total) | `VICINITY-CURVE-DEVNET.md` 6.6, 6.7, 7.1, section 11 |
| the KR-1 figures the owner signs off | 9 item 4, 10 (O25) |
| the claims it re-checked and found to hold (builds, IDL, counts, tests, review table, roles, devnet accounts) | no change |

---

## 9. Known limitations and accepted risks

Each is stated in the specification or the notes. Several rest on a default of section 13 that
the owner has not signed off yet (no sign-off of any decision of section 13 is recorded in the
repository): limitation 3 on O2, 4 on O25, 5 on O29, 6 on O36, 9 on O33, 16 on O26, 19 on O28 and
20 on O10 and O23; section 10 lists each of them with the other decisions that await him.

1. **The upgrade authority is the main trust** (8.1, 8.4). Two of the three Squads keys can replace
   the program and take every coin's reserves and buckets, and as rewards authority every forwarded
   holder lamport; the 48-hour time lock (from the first mainnet coin, O11) and the guardian's buy
   halt are the mitigations. The time lock is a property of the Squads multisig, not of the program,
   and applies to every proposal of the vault in every program (8.4). On mainnet today the multisig
   (`6v8hwKYSAWXXx6ZGGmvbg87n8eVy9MAgNruFgVqRFjYV`) has no time lock and one of its three members
   is `FEE_RECIPIENT`'s hot wallet `13qRam...`, so that key and any one other member key act as the
   vault at once; 8.4's operating rule (`FEE_RECIPIENT` no member, since this revision; the
   checklist refuses it) closes the first before the deploy, its precondition on the time lock the
   second before the first coin launches (O11), and section 5 lists the state as of this pack's
   date.
2. **A mathematical exploit can drain in the first block**, before anyone signs a halt (8.3).
3. **Liquidity of a coin that never graduates is locked for ever** (O2, I22's intended permanent
   balances), as are the buyback bucket's dust below one raw coin, curve-phase rounding remainders
   when `liquidity_bps = 0`, and donations (O21).
4. **The multi-run buyback hold** (Theorem M_K, O25): a trader who buys while a public backlog above
   about 2.0% to 2.6% of depth exists and holds through 21 to 26 runs with no other trading can
   profit (16 to 21 runs above 1.5% to 2.0% for a founder). With one honest trade inside the hold
   (one buy at the clients' round-4 threshold; review KR-1) the figures are lower: on chain the
   founder profited after 8 runs of a backlog of 0.84% of depth and an outsider after 15 runs of
   1.5%; the model's least hold is 13 runs for an outsider, 8 for the founder and 3 for a founder
   holding the float. The SDK's own trades now count every run the backlog pays for, so they leave
   every class at a loss; a client allowing more slippage than the SDK does not. Open, section 10.
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
8. **A stolen launch approver key** can take up to 512 coin-less cities per publication that
   nobody clears within its 12-hour window (8.1, T85: at most 512 cities per batch); a thief who
   goes unnoticed past one window can publish again, and each new batch takes force 12 hours after
   its publication. The stops are the guardian members (one transaction each), the owner
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
13. **A guardian stop can execute more than once** on a quiet chain: each of its variants for the
    next indices (`--variants`, default 4, at most 16) executes when the one before has just moved
    the index there, so up to `--variants` executions per RPC view, and up to 8 with the default
    when the two RPCs show different transaction indices (`guardian-stop.mjs` `nextIndices` takes
    up to `--variants` indices per RPC); D01 saw four (`VICINITY-CURVE-DEVNET.md` section 8 item 5;
    NOTES 87 said twice). Each extra execution costs the member the rent of a vault transaction and
    a proposal it cannot close: at mainnet's and devnet's 5,080 lamports per byte (read on 23
    October 2026: `getMinimumBalanceForRentExemption(738109)` = 3,750,243,960 on both) about 0.0041
    SOL for a clear (285 + 262 bytes) and 0.0038 SOL for a pause (223 + 262 bytes), about 0.016 SOL
    for four clears; D01's 0.0056 SOL is its validator's 6,960 lamports per byte. The monitor sees
    as many `LaunchBatchCleared` events. Harmless to the program; not changed.
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
| O25 | the residual multi-run buyback risk (Theorem M_K) | accept and disclose: a buyer who holds through about 21 to 26 runs (16 to 21 for a founder) of a backlog above about 2.0% to 2.6% of depth (1.5% to 2.0% for a founder) with no other trading can profit; with one honest trade inside the hold the figures the owner signs off are lower (review KR-1): on chain the founder profited after 8 runs of a backlog of 0.84% of depth and an outsider after 15 runs of 1.5%, and the model's least hold is 13 runs for an outsider, 8 for the founder and 3 for a founder holding the float; the sign-off covers configs within config #0's keep-up only (O36). Mitigated by the 0.1% step, V11, a keeper every interval, an alert above two caps and the backlog shown on the coin page | execute buybacks inside trades (contradicts R7's "executed separately" and R5; not offered) |
| O29 | the platform's key in the MEV rules (review HR-1) | not counted by V8 and V11; the operating rule of 8.4 keeps `FEE_RECIPIENT` and the owner's wallets out of city coins and founder seats | (a) count `b_P` in V8 and give the platform its own horizon in V11; (b) keep `b_P <= max(b_F, b_H)` in every config. Either changes which fee splits are allowed and needs a crate, model and vector change before the audit |
| O30 | the batch review window `BATCH_REVIEW_SECS` | 12 hours | 6 hours (a guardian member on call overnight); 1 to 2 hours (needs an automatic clear-only key on a server, which the owner ruled out); 24 hours (founders wait a further day). A compiled constant |
| O31 | the longest batch validity `BATCH_MAX_VALIDITY_SECS` and the SDK's default | at most 48 hours; the SDK proposes 36 | at most 24 hours (a late signature closes batch launches until the next batch); at most 72 hours (a weekend without signing; a stale founder can launch for up to three days) |
| O32 | who holds the launch approver key | a dedicated key in the owner's own wallet, used for nothing else, on a device or seed with no Squads member key, backed up offline | (a) a separate Squads multisig without a time lock (not supported by the verifier yet, review R8-DIFF-6); (b) a team member other than the owner |
| O33 | stale batch entries | accept and disclose (9 above) | a per-entry revocation the approver could sign (a second approver power and another account at launch; not built) |
| O34 | stops during the review window that do not depend on the guardian multisig | not built | a few clear-only stopper keys set by the admin (a new field and rule in the program, a larger audit scope) |
| O35 | the guardian multisig's configuration | controlled by the admin vault, no time lock, 1 of 3, at least two members able to act alone (the checklist refuses anything else) | an autonomous multisig with a threshold of 2 or more (slower stops; two members can remove the third) |
| O36 | the buyback share against the fixed per-run cap (review R9-PF-1) | not a program rule: the operating rule `C * b_B <= 3t` (config #0 at the edge), checked by `buybackKeepUp` and the checklist | (a) a rule V12 in `validate_config` with `K_B` = 3 or 8 (a new error, a binary change); (b) a per-run cap scaled by `b_B` (changes V8, V11 and Theorem M_K) |

The decisions above are the ones section 13 calls open. The others (O1 to O24, O26 to O28) have a
default this build implements, but **no owner sign-off of any of them is recorded in the
repository**, and section 13 says that several need one, or a decision before the audit freeze.
They await the owner as well:

| # | what section 13 asks of the owner | default (built) | limitations of section 9 that rest on it |
|---|---|---|---|
| O2 | "needs the owner's explicit sign-off" (also 0.1 and 5.8): the 0.5% liquidity share collected before graduation stays locked for ever in a coin that never graduates | set aside in `liquidity_pending`, dripped into the pool after graduation; locked for a coin that never graduates | 3 |
| O3 | "decide before the audit freeze": R8's 9.1 leftover coins | burned at launch (config #0's integers of 5.9) | none (it fixes config #0's figures) |
| O7 | "sign-off needed": no fee on the buyback, an exception to R2's "every buy", with the 0.1% step and 150-slot interval | at most 0.1% of depth per run, once per 150 slots, no fee | 4 (the step) |
| O9 | "decide before the audit freeze, because aggregators copy the list": the guardian and the 10-account trade lists | a guardian (buys, buybacks, launches), exits never paused | none |
| O10 | written confirmation from Jupiter, Axiom, GMGN and FOMO "before the audit freeze": native SOL custody | native lamports in the `Coin` | 20 |
| O11 | among "the decisions the owner should see first": the 48-hour time lock and everything it delays in the existing programs | Squads 2 of 3, 48-hour time lock from the first coin launch, a guardian | 1 |
| O23 | among the decisions to see first (with O10): visibility on aggregators and wallets | ship the crate, IDL and spec; ask for integration after the audit | 20 |
| O26 | the holders' money of a coin whose rewards config is wrong waits for an upgrade | waits in `holders_pending` | 16 |
| O28 | the metadata JSON served by the website | hash approved, stored and emitted; served write-once | 19 |

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
  `devnet` build (sha256 `d052b8fc...`) was deployed there at the throwaway id `nhgCm...` and read
  back from that validator byte for byte. The Metaplex and Squads v4 it ran against are devnet's
  binaries, not the pinned mainnet dumps the litesvm suites and the round-7 to round-9 fixes were
  tested against: devnet's Squads v4 is sha256
  `97fb2a5c08e5df5e862d8354ac5b97d3587117f98c4457754ca12e30bef0664d`, 1,774,800 bytes (dumped from
  devnet for this revision), against the pinned mainnet dump `dec8d3e0...`, 1,470,416 bytes;
  devnet's Metaplex is `bb0842f6...`, 1,295,344 bytes, against `31f0a627...`.
* **What an auditor can check, and what not.** None of D01's 81 signatures can be looked up on any
  public cluster: they exist only on that local validator (slots 651 to 113,384), whose ledger was
  pruned across 31 restarts and deleted after the run; devnet holds none of D01's accounts
  (`nhgCm...`, `F7V1h...` and `BXDJiox...` do not exist there). The figures of
  `VICINITY-CURVE-DEVNET.md` are therefore a record, not evidence a third party can verify on a
  chain. What is kept, in `rehearsals/vicinity-curve-d01/`: the driver as run (`d01.mjs` and its
  helpers), every transaction's record as read soon after it landed (`d01-log-local.jsonl`: slot,
  compute, fee, size, events, result), the account table and state it read, the three batch lists
  and every output of the owner's tools (`tool-*.txt`), committed for this revision; no key, no
  ledger and no account dump (the validator is gone). Section 10 of that file says what running
  D01 on devnet itself needs, which would give signatures anyone can look up.
* **What was rehearsed** (81 transactions on the local validator, each with its signature,
  compute, fee and size in section 11 of that file): 8.5's hand-over; a real Squads v4 guardian (controlled by the admin, 1 of 2, no time
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
* **Not reached**: devnet itself; the website's list, `verify --tx` and the monitor process (the
  batch page and the monitor are not built; `check`, the monitor's comparison, was run by hand); two independent RPC providers (two addresses of one validator; against
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

Run on 24 October 2026 (00:03 to 00:09 UTC) with the toolchain of 2.1, on the tree of the commit
that adds this revision (`bf17550` plus its documentation files) before this table and the CI row of
1.1 were written into it; no test reads this file. The script is a local copy of the CI steps of
`.github/workflows/solana.yml` for the curve, plus the repository's other suites and the three hash
checks of 2.3; the same steps were also run on `bf17550` itself (23:55 to 00:01) with the same
results. Logs are not committed.

| # | step (from `solana/`, the last two from the repository root) | result | time | detail |
|---|---|---|---|---|
| 1 | `cargo fmt --all -- --check` | PASS | 0 s |  |
| 2 | `cargo clippy --all-targets -- -D warnings` | PASS | 2 s |  |
| 3 | `cargo clippy --all-targets --features short-windows -- -D warnings` | PASS | 2 s |  |
| 4 | `cargo clippy -p vicinity-curve --all-targets --features devnet -- -D warnings` | PASS | 2 s |  |
| 5 | `cargo clippy -p vicinity-curve --all-targets --features halt-all -- -D warnings` | PASS | 2 s |  |
| 6 | `cargo test` | PASS | 14 s | 187 passed, 0 failed (14 test binaries) |
| 7 | `cargo test -p vicinity-curve --features devnet` | PASS | 3 s | 77 passed, 0 failed (2 test binaries) |
| 8 | `cargo test -p vicinity-curve --features halt-all` | PASS | 2 s | 77 passed, 0 failed (2 test binaries) |
| 9 | `anchor build` | PASS | 16 s |  |
| 10 | no stack warning in anchor build | PASS | 0 s |  |
| 11 | `diff target/idl/vicinity_curve.json sdk/idl/vicinity_curve.json` | PASS | 0 s |  |
| 12 | `diff target/idl/vicinity_rewards.json sdk/idl/vicinity_rewards.json` | PASS | 0 s |  |
| 13 | `diff target/idl/vicinity_launchpad.json sdk/idl/vicinity_launchpad.json` | PASS | 0 s |  |
| 14 | `npm run vcurve:idl` | PASS | 1 s |  |
| 15 | `git diff --exit-code -- sdk/idl/vicinity_curve.json` | PASS | 0 s |  |
| 16 | `npm run vcurve:idl:check` | PASS | 0 s |  |
| 17 | `npm run vcurve:sbf` | PASS | 34 s | no stack warning: yes; cargo-build-sbf 4.4.0 |
| 18 | hash 0a5beef231cfcc1327d9e497bb631f7c8edc99468338daed932ddce90bba3b5b (production) | PASS |  |  |
| 19 | hash d052b8fccf5ed0fc9bbb0ee56e4a77ae5a3ec99c6fa6c906119f51db71c18fa3 (devnet) | PASS |  |  |
| 20 | hash 4d631647c38230690ad57a28e49d021e0ad956a7edbc454dc107558849a0d868 (halt-all) | PASS |  |  |
| 21 | `sha256sum target/deploy/vicinity_curve.so` | PASS | 0 s | 0a5beef231cfcc13... |
| 22 | `npm run curve:router` | PASS | 0 s |  |
| 23 | `npm run test:vcurve` | PASS | 1 s | 1 test, 1 passed, 0 failed |
| 24 | `npm run sdk-test:curve` | PASS | 3 s | 52 tests, 52 passed, 0 failed |
| 25 | `npm run test:curve` | PASS | 175 s | 204 tests, 204 passed, 0 failed |
| 26 | `cp <pinned dumps>/*.so tests-launchpad/fixtures/programs/` | PASS | 0 s |  |
| 27 | `npm run test:launchpad` | PASS | 35 s | 155 tests, 155 passed, 0 failed |
| 28 | `node scripts/copy-assets.mjs && node scripts/pages/build.mjs && npm test` | PASS | 65 s | 1910 tests, 1909 passed, 0 failed, 1 skipped |
| 29 | `git status --porcelain` | PASS | 0 s | modified: `solana/README.md`, `solana/VICINITY-CURVE-AUDIT.md`, `-DESIGN.md`, `-DEVNET.md`, `-NOTES.md`; untracked symlinks, never committed: `node_modules`, `solana/node_modules`, `solana/target` |
