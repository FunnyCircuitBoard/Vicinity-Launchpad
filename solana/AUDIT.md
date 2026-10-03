# Audit pack for `vicinity_rewards`

Everything an auditor needs to rebuild, run and judge this program. Dates are
UTC. The owner deploys to mainnet himself after the audit (`README.md`,
"Mainnet deployment"); nothing in this repository has touched mainnet.

## 1. Versions

| tool | version | where it matters |
|---|---|---|
| anchor-cli / anchor-lang / anchor-spl | 0.31.1 / 0.31.2 / 0.31.2 (Cargo.lock) | framework, IDL, `init`, `init_if_needed` |
| Agave (solana-cli, test validator) | 4.3.0 | local validator, deploy |
| cargo-build-sbf / platform-tools | 4.4.0 / v1.57 | the on-chain build |
| Rust (host: unit tests, clippy, fmt) | 1.97.0 (pinned in CI) | not part of the on-chain binary |
| spl-token-2022 (program crate, extension allow-list) | 6.0.0 | `instructions/init_city.rs` |
| Node / @coral-xyz/anchor / @solana/web3.js / @solana/spl-token | 22.22 / 0.31.1 / 1.99.0 / 0.4.15 | tests, SDK, demo |

Program id (devnet and localnet; the keypair never entered git):
`Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi`, also in `declare_id!`,
`Anchor.toml` and `sdk/idl/vicinity_rewards.json`.

## 2. Reproducible build

```sh
cd solana
anchor build                       # target/deploy/vicinity_rewards.so + target/idl/vicinity_rewards.json
sha256sum target/deploy/vicinity_rewards.so
diff target/idl/vicinity_rewards.json sdk/idl/vicinity_rewards.json   # must be empty
anchor build --verifiable          # needs Docker (image solanafoundation/anchor:v0.31.1); byte-identical on any machine
sha256sum target/verifiable/vicinity_rewards.so
```

The production binary built here (plain `anchor build`, no features) is the
first row of the table below; it is the binary the devnet step deploys
(section 7). `anchor build --verifiable` could not be run on the build machine
(no Docker daemon); the command above is what the owner runs on his machine in
README step 3, and `solana-verify verify-from-repo` reproduces it from the
commit. Until then the only measured production hash is that of the plain
build.

Hashes to record (the owner fills the last row on his machine, in this file,
in the commit that also carries the mainnet `declare_id!`):

| build | bytes | SHA-256 | status |
|---|---|---|---|
| `anchor build` (production, devnet id, this machine) | 505,088 | `40dd72b943715941d9231cfffcb6b98c67b11ad52b7fb08df06b8dcb1dc4b3e1` | measured, section 8 |
| `anchor build -- --features short-windows` (test only) | 505,088 | `1541cbadb2b78b42e8a30638df95708354eda007196d1fb7d1e4c35dc821a571` | measured, never deployed |
| `anchor build --verifiable` (production, mainnet id) | | | owner, README step 3; `solana-verify verify-from-repo -u mainnet-beta --program-id <id> <repo url> --library-name vicinity_rewards` re-derives it |

The `short-windows` Cargo feature (`programs/vicinity-rewards/Cargo.toml`) is a
test-only build with `MIN_CLAIM_WINDOW_SECS = 60`; every other byte of logic is
the same. A binary's IDL shows which one it is (`constants` section), CI refuses
a production IDL that does not say 1209600, and the test suite refuses to run
its deadline tests against a production build when `VICINITY_REQUIRE_SHORT_WINDOWS`
is set.

## 3. How to run everything

```sh
cd solana && npm ci
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --features short-windows -- -D warnings
cargo test                                                   # 29 unit tests
npm run sdk-test                                             # 47 Merkle tests (JS), fixtures shared with Rust
npm run typecheck
anchor build && diff target/idl/vicinity_rewards.json sdk/idl/vicinity_rewards.json
VICINITY_REQUIRE_SHORT_WINDOWS=1 anchor test -- --features short-windows   # 140 tests, about 9 minutes
anchor localnet &  npm run demo                              # the walk-through, exits 1 if any attack succeeds
```

`anchor test` starts its own validator with the program loaded as upgradeable
and the test wallet as upgrade authority (`Anchor.toml [test] upgradeable = true`);
the registry tests depend on that. If a machine has no IPv6 (anchor's port
check needs it), start the validator by hand:
```sh
anchor build -- --features short-windows
solana-test-validator --reset --ledger /tmp/vicinity-ledger --bind-address 127.0.0.1 --rpc-port 8899 \
  --mint $(solana address) --upgradeable-program <program id> target/deploy/vicinity_rewards.so $(solana address) --quiet &
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json VICINITY_REQUIRE_SHORT_WINDOWS=1 npm test
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json npm run demo
kill %1                                      # then `anchor build` again so target/ holds the production binary
```
The suite expects a fresh ledger (the first registry test must see no registry);
the demo can follow the suite on the same validator (it reuses the registry).
Check `pgrep -f solana-test-validator` before starting one (the process name is
longer than `pgrep -x` can match) and stop it by pid.
`npm run init-registry` (`scripts/init-registry.ts`) is the owner's one-time
`init_registry` after a deploy; the devnet section shows it in use.

What each test file proves is listed in `tests/README-tests.md`; the risk by
risk mapping is in `SECURITY.md` section 4.

## 4. Results on this branch (3 Oct 2026)

Run by the finisher at HEAD of `feat/solana-rewards` with the three documents
present (same binaries as the run recorded in section 8; this table is the
summary, section 8 the detail):

| check | result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --all-targets -- -D warnings`, with and without `short-windows` | clean |
| `cargo test` | 29 passed |
| `npm run sdk-test` | 47 passed |
| `npm run typecheck` | clean (tests, SDK, `scripts/demo.ts`, `scripts/devnet-demo.ts`, `scripts/init-registry.ts`) |
| production `anchor build` | 505,088 bytes, sha256 `40dd72b9...4b3e1` (full hash in section 2); `target/idl` equals `sdk/idl/vicinity_rewards.json`; `MIN_CLAIM_WINDOW_SECS = 1209600` |
| full Anchor suite on the short-windows build, fresh validator, `VICINITY_REQUIRE_SHORT_WINDOWS=1` | 140 passing, 0 failing, 0 pending (8 min) |
| `scripts/init-registry.ts` then `scripts/demo.ts` on a fresh validator with the short-windows build | see section 8 |

## 5. Compute units and transaction size

Measured by `tests/06-large-tree-compute.ts` (`CU_RESULT` lines; claimant is
the only signer and fee payer; `simulateTransaction` and the executed
transaction agreed on every line):

| proof depth | leaves addressable | transaction bytes | compute units | notes |
|---|---|---|---|---|
| 9 and 11 | real 2,000-leaf tree, 8 claims | 788 / 852 | 42,508 to 62,024 | a wallet's first claim creates its token account, hence the spread |
| 20 | 1,048,576 | 1,140 | 44,552 | crafted proof (arbitrary siblings, root valid for that leaf) |
| 22 | 4,194,304 | 1,204 | 51,012 | deepest proof that fits a legacy transaction |

Raw lines of the final run (section 8), `simulated` always equal to `executed`:
depth 11: 42,508 / 47,012 / 62,024 / 48,512 / 48,516 / 44,008; depth 9: 57,064 /
61,560; depth 20: 44,552; depth 22: 51,012. Earlier runs of the same binary
measured 44,498 to 63,008 CU at depth 22 and 48,518 to 59,540 at depth 20; the
spread between runs is token-account creation and account-size dependent CPI
cost, not the proof.

Default limit 200,000 CU per instruction. Proof verification costs about 100 CU
per level (sha256 syscall); the rest is account loading, the token transfer and
the token account creation. A legacy transaction is 1,232 bytes; a `claim` is
500 bytes plus 32 per proof element, so depth 22 is the maximum: epochs must
stay at or below 2^22 = 4,194,304 leaves (or move to v0 transactions with
lookup tables). The on-chain cap of 32 is unreachable defence in depth.

`fund_epoch` and `fund_epoch_from_vault` run two token CPIs plus up to two
account creations; `init_city` two account creations; all well under the limit
(no instruction in the suite has come near 100,000 CU).

## 6. Account sizes and rent

Rent parameters read from the mainnet `Rent` sysvar on 3 Oct 2026
(`SysvarRent111111111111111111111111111111111`): `lamports_per_byte_year = 5080`,
`exemption_threshold = 1.0`, so the rent-exempt minimum is
`(size + 128) * 5080` lamports. `solana rent` with Agave 4.3.0 gives the same
numbers (the older 3480 * 2 schedule, which gives 2,039,280 for a token
account, is no longer what mainnet uses).

| account | bytes | rent-exempt minimum | paid by |
|---|---|---|---|
| Registry | 73 | 1,021,080 lamports (0.00102108 SOL) | deployer, once |
| CityConfig | 303 | 2,189,480 lamports (0.00218948 SOL) | init_city payer |
| vault (SPL token account) | 165 | 1,488,440 lamports (0.00148844 SOL) | init_city payer |
| Epoch | 182 | 1,574,800 lamports (0.0015748 SOL) | fund_epoch funder / fund_epoch_from_vault payer |
| founder token account (once per founder and mint) | 165 | 1,488,440 lamports | first fund_epoch* |
| ClaimStatus | 57 | 939,800 lamports (0.0009398 SOL) | claimant; returned by close_claim_status after sweep or cancel |
| claimant token account (if missing) | 165 | 1,488,440 lamports | claimant |
| program data (505,088-byte binary, `--max-len` = size) | 505,133 | 2,566,725,880 lamports (2.567 SOL) | deployer; about 5.13 SOL with the default 2x headroom for upgrades |

Sizes include the 8-byte Anchor discriminator and were recomputed from the
layouts in `state.rs` (Registry 8+32+32+1; CityConfig grew by 16 bytes and
Epoch by 8 with the pause bookkeeping). Every number above was checked with
`solana rent <bytes> -u mainnet-beta` and `-u devnet` on 3 Oct 2026 (same
values on both).

Rent caveat: the numbers depend on the cluster's rent parameters, which can
change by feature activation. `solana-test-validator` still uses the older
default schedule (3,480 lamports per byte-year, 2 years), so on the local
validator a token account costs 2,039,280 lamports and the program data
account 3.517 SOL; devnet and mainnet report the lower values above today.
Budget for the mainnet deploy with a margin (README step 4: about 3 SOL for
`--max-len` = size, about 5.2 SOL for the default 2x headroom).

## 7. Devnet deployment

See the end of this section for the current state; the procedure was:

```sh
solana-keygen new -o <outside the repo>/devnet-deployer.json      # throwaway, never printed, not committed
solana airdrop 1 <deployer address> -u devnet                       # devnet faucet, repeat until about 2.7 SOL
anchor build                                                        # production, no features (sha256 in section 2)
solana program deploy target/deploy/vicinity_rewards.so --program-id <program keypair> -k <deployer> -u devnet --use-rpc --max-len 505133
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=<deployer> npm run init-registry
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=<deployer> npm run devnet-demo
```

`scripts/devnet-demo.ts` creates the registry (deployer = upgrade authority =
admin), a test reward mint, one city (Split 50/50), funds epoch 0 with a 3-leaf
tree, lets one holder claim, funds epoch 1 and cancels it, and prints every
address with an explorer link. Sweep is not shown on devnet: the production
minimum claim window is 14 days (the script prints the date after which
`sweep_epoch(0)` works); the sweep path is proven by the test suite against a
real 60-second deadline.

### Current state (3 Oct 2026, 10:35 UTC)

**Not deployed yet: the devnet faucet did not release enough SOL.** The
throwaway deployer `9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa`
(https://explorer.solana.com/address/9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa?cluster=devnet)
holds 2 SOL, which is what the public faucet released during 113 `solana airdrop`
requests between 06:38 and 10:32 UTC (two sessions, 1 and 2 SOL requests, the
default RPC and the Alchemy demo endpoint, 90 s to 5 min apart); every other
request was refused with "airdrop request failed ... rate limit" or HTTP 429.
Deploying the 505,088-byte production binary needs 2.567 SOL of rent for the
program data account alone (section 6), so the deploy was not attempted: it
would have failed half way and locked the SOL in a buffer account.

The program id `Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi` therefore has no
account on devnet yet
(https://explorer.solana.com/address/Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi?cluster=devnet).
The auditor's path is the local one in section 3: `npm run init-registry`,
the full suite and `scripts/demo.ts` on a hand-started validator exercise every
instruction, including sweep after a real deadline, against the same bytes
(section 8 records that run). The devnet step is finished by running the three
commands above once the deployer holds about 2.7 SOL (another faucet grant, or
0.7 SOL sent to it from any devnet wallet) and pasting the JSON block that
`devnet-demo` prints below this paragraph; nothing in the repository changes
for that, because `declare_id!`, `Anchor.toml` and the IDL already carry the
devnet program id.

## 8. Final run of this branch (3 Oct 2026, build machine, Agave 4.3.0 test validator)

Run by the finisher at HEAD with the three documents present. Order: Rust
checks, SDK checks, production build and IDL diff, short-windows build, full
suite on a fresh hand-started validator, `init-registry` and the demo on a
second fresh validator, production rebuild (hash equal to the first build).

| step | result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --all-targets -- -D warnings` (default and `--features short-windows`) | clean |
| `cargo test` | 29 passed (math incl. `effective_deadline`, Merkle fixtures, Token-2022 allow-list incl. close authority, vault surplus) |
| `npm install` (lockfile unchanged), `npm run sdk-test` | 47 passed; both fixture files reproduce byte for byte from their generators |
| `npm run typecheck` | clean |
| `anchor build` (production, no features) | 505,088 bytes, sha256 `40dd72b943715941d9231cfffcb6b98c67b11ad52b7fb08df06b8dcb1dc4b3e1`; IDL equals the committed `sdk/idl/vicinity_rewards.json`; `MIN_CLAIM_WINDOW_SECS = 1209600` |
| `anchor build -- --features short-windows` | 505,088 bytes, sha256 `1541cbadb2b78b42e8a30638df95708354eda007196d1fb7d1e4c35dc821a571` (test build, never deployed); IDL says 60 |
| full suite against that build on a fresh validator (`--upgradeable-program`, `VICINITY_REQUIRE_SHORT_WINDOWS=1`) | **140 passing, 0 failing, 0 pending** (8 minutes) |
| `npm run init-registry` on a second fresh validator | registry created at `2rKKwGGcJEDRJBhdHRPtHQpoxPmq9wPWWj3uMrcRaRg3` with the wallet as admin after the script confirmed on chain that the wallet is the upgrade authority; a second run reports "already exists" and sends nothing |
| `scripts/demo.ts` against that validator (it reused the registry) | `DEMO COMPLETE: every step behaved as specified`, exit 0; 13 attacks refused with the exact expected code (double claim, bigger amount, stranger with another leaf, truncated proof, early sweep, cancel with claims, stranger pause, stranger `init_city`, second lock, second `fund_epoch_from_vault`, claim on a swept epoch, old authority, claim while paused); cancel to carry-over, carry-only epoch, 100 tokens sent straight to the vault distributed by `fund_epoch_from_vault` (50 founder / 50 holders), sweep after a real 60 s deadline, claim-status rent returned, `accounting invariants: OK` after every step |
| `anchor build` again (production, so `target/` holds the real binary) | same 505,088 bytes, same sha256 `40dd72b9...4b3e1`, IDL equal, `MIN_CLAIM_WINDOW_SECS = 1209600` |

Compute units of this run are in section 5 (`CU_RESULT` lines). Limit 200,000.

The suite was run exactly as `anchor test` runs it but with a hand-started
validator (section 3 shows the commands), because anchor's port check needs
IPv6, which this sandbox lacks; CI runs the plain command.

What is proven: everything in `SECURITY.md` section 4 and `tests/README-tests.md`,
on a local validator with the test build, plus the production build's IDL and
hash. What is not proven here: the reproducibility of the verifiable build
(needs Docker, README step 3), and the behaviour of the production bytes on a
public cluster beyond what section 7 records.

## 9. Known limitations

1. Eligibility (minimum balance, holding time, exclusion of pools, program
   accounts, founder and team wallets) is decided off chain and must be
   published with the snapshot file; the chain only makes the root immutable
   and checkable (`snapshot_hash` is mandatory for Holders/Split epochs).
2. The authority is trusted for the content of new roots. It cannot take back
   money a published root still lets holders claim (pauses extend deadlines),
   but it decides every new distribution and every founder change.
3. A reward mint with a freeze authority (USDC) can freeze the vault, after
   which nothing can be paid; a frozen or re-owned founder token account blocks
   funding until `set_founder`. WSOL has no freeze authority.
4. Events are logs and can be truncated in large transactions; indexers must
   reconcile from account state.
5. The program is upgradeable until the owner moves or removes the upgrade
   authority. If the upgrade authority is removed before `init_registry`, no
   city can ever be configured under that program id.
6. `fund_epoch_from_vault` is a second, bounded outflow of the vault (the
   founder share of money no epoch has booked). It exists so a fee wallet can
   point at the vault without a program change (spec section 0).
7. Legacy transactions cap a claim proof at depth 22 (4,194,304 leaves per
   epoch).
8. Claim-status rent (0.00094 SOL) stays locked while an epoch is open; it is
   returned by `close_claim_status` after sweep or cancel. Dust from flooring
   stays in the vault as carry-over.
9. Holders-model cities still create (and pay rent for) an empty founder token
   account at the first funding.
10. `cargo-build-sbf` warns that `crate-type = ["cdylib", "lib"]` precludes LTO
    although `Cargo.toml` asks for `lto = "fat"`; `lib` is needed for `cargo
    test`. Binary size and CU only. The binary grew from 382 KB to 505 KB with
    the registry (Anchor's `ProgramData` deserialization pulls in the
    upgradeable loader state codec); parsing the 45-byte ProgramData header by
    hand would shrink it again and save about 0.6 SOL of mainnet rent.
11. `anchor build --verifiable` was not run on the build machine (no Docker
    daemon); the owner runs it in README step 3.

## 10. PRODUCT DECISION REQUIRED

Recommended defaults are what the code does today; nothing else is hardcoded.

1. `ALLOWED_SPLIT_BPS = [2500, 5000, 7500]`: the only founder shares the Split
   model accepts. Recommended: keep; add values only after their economics are
   reviewed.
2. Claim window bounds 14 to 365 days. Recommended: keep; 30 days as the
   Worker's default.
3. Rewards may not be paid in the city coin itself (`RewardMintIsCityCoin`).
   Recommended: keep (no).
4. Unclaimed money: carry-over to the next holders epoch only; no founder or
   treasury sweep. Recommended: keep.
5. Who may create city configs: the registry admin only (new since review).
   Recommended: the Squads multisig as admin; the Worker's ops key as each
   city's `authority`.
6. Money sent straight to the vault: distributed by `fund_epoch_from_vault`
   with the founder share paid from the vault (new since review). Recommended:
   point fee wallets at the vault only if the founder share from the vault is
   acceptable; otherwise point them at an ops token account and use
   `fund_epoch`.
7. Token-2022 reward mints: allow-list (metadata pointer, token metadata,
   group pointer, group member pointer, token group, token group member,
   interest bearing); transfer fee, transfer hook, permanent delegate,
   non-transferable, confidential transfers, default account state, mint close
   authority and unknown extensions are refused. Recommended: keep; use WSOL
   or USDC.
8. Pause: blocks funding and claiming, does not block cancel, extends every
   open epoch's deadline by the pause time (new since review). Recommended:
   keep.
9. `close_claim_status` only after sweep or cancel (claimant rent locked while
   the epoch is open). Recommended: keep.
10. Snapshot eligibility (minimum balance, holding time, exclusions of pools,
    program-owned accounts, the founder and team wallets): off chain,
    unspecified. Recommended starting rule: balance at the snapshot slot at
    least 0.01 percent of circulating supply, excluding the LaunchLab/AMM pool
    accounts, the founder and any wallet Vicinity flags; publish the rule with
    every snapshot file.
11. `snapshot_hash` is mandatory for Holders/Split epochs (new since review);
    `snapshot_slot` is recorded but not validated (any u64). Recommended: the
    Worker always sets both; no further on-chain validation possible.
12. At most 2^22 leaves per epoch (legacy transaction size). Recommended: the
    snapshot job splits larger cities into several epochs or moves to v0
    transactions.
13. The authority should be a Squads multisig; `set_founder` is the one
    economic lever it keeps. Recommended: multisig, alert on every founder
    change.
14. Holders-model cities pay rent for an empty founder token account at the
    first funding (0.0015 SOL). Recommended: accept.
15. Reward mint freeze authority trust: WSOL (none) versus USDC (Circle).
    Recommended: WSOL unless the product needs USDC.
16. Dust from pro-rata flooring stays in the vault as carry-over. Recommended:
    keep.
17. Upgrade authority after the audit: multisig or immutable. Recommended:
    multisig for the first months (so an audit finding can be fixed), then
    `--final`.
18. Founder shares accrue nowhere: a founder with an unusable token account
    blocks funding until `set_founder` (SECURITY.md 3.4). Recommended: accept
    with the runbook; a pull-based `claim_founder` can be added later.
