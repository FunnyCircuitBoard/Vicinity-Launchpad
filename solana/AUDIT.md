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
| `anchor build` (production, devnet id, this machine) | 505,864 | `f0fbc9d53ed092210eef3f97047644d6f796d634bf11c428795ff8b0b1e509a3` | measured, section 8 |
| `anchor build -- --features short-windows` (test only) | 505,864 | `add08669dab44770c634195652b3c249f8ef4191cc98ef1215195432694ebf98` | measured, never deployed |
| previous production build (commit 689c646, before the second review's fixes) | 505,088 | `40dd72b943715941d9231cfffcb6b98c67b11ad52b7fb08df06b8dcb1dc4b3e1` | superseded; its short-windows twin was `1541cbad...821a571` |
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
VICINITY_REQUIRE_SHORT_WINDOWS=1 anchor test -- --features short-windows   # 144 tests, about 8 minutes
anchor localnet &  npm run demo                              # the walk-through, exits 1 if any attack succeeds
```

`anchor test` starts its own validator with the program loaded as upgradeable
and the test wallet as upgrade authority (`Anchor.toml [test] upgradeable = true`),
plus a second copy of the same binary at the `[[test.genesis]]` address
(`EVvMRwM4Dg9Etp7L9JkouWkcJkXRmW2jHYvgaMVfysbZ`, a throwaway public key with no
private key behind it), also upgradeable with the test wallet as its upgrade
authority; the registry tests need both (tests/01 passes the second program's
real ProgramData to `init_registry`). If a machine has no IPv6 (anchor's port
check needs it), start the validator by hand with the same two programs:
```sh
anchor build -- --features short-windows
solana-test-validator --reset --ledger /tmp/vicinity-ledger --bind-address 127.0.0.1 --rpc-port 8899 \
  --mint $(solana address) \
  --upgradeable-program <program id> target/deploy/vicinity_rewards.so $(solana address) \
  --upgradeable-program EVvMRwM4Dg9Etp7L9JkouWkcJkXRmW2jHYvgaMVfysbZ target/deploy/vicinity_rewards.so $(solana address) --quiet &
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json VICINITY_REQUIRE_SHORT_WINDOWS=1 npm test
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json npm run demo
kill %1                                      # then `anchor build` again so target/ holds the production binary
```
The suite expects a fresh ledger (the first registry test must see no registry);
the demo can follow the suite on the same validator (it reuses the registry).
Check `pgrep -f '^solana-test-validator'` before starting one (the process name
is longer than `pgrep -x` can match, and without the anchor the pattern matches
the shell running it) and stop it by pid.
`npm run init-registry` (`scripts/init-registry.ts`) is the owner's one-time
`init_registry` after a deploy; the devnet section shows it in use.

What each test file proves is listed in `tests/README-tests.md`; the risk by
risk mapping is in `SECURITY.md` section 4.

## 4. Results on this branch (3 Oct 2026)

Run by the second fixer at HEAD of `feat/solana-rewards` after the second
review's fixes (same binaries as the run recorded in section 8; this table is
the summary, section 8 the detail):

| check | result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --all-targets -- -D warnings`, with and without `short-windows` | clean |
| `cargo test` | 29 passed |
| `npm run sdk-test` | 47 passed |
| `npm run typecheck` | clean (tests, SDK, `scripts/demo.ts`, `scripts/devnet-demo.ts`, `scripts/init-registry.ts`) |
| production `anchor build` | 505,864 bytes, sha256 `f0fbc9d5...509a3` (full hash in section 2); `target/idl` equals `sdk/idl/vicinity_rewards.json`; `MIN_CLAIM_WINDOW_SECS = 1209600` |
| full Anchor suite on the short-windows build, fresh validator with both programs, `VICINITY_REQUIRE_SHORT_WINDOWS=1` | 144 passing, 0 failing, 0 pending (8 min) |
| the new regression tests against the previous binary (689c646) | all three red there (the old program accepted what they refuse), section 8 |
| `scripts/init-registry.ts` (creation, hand-over to a stand-in multisig, reruns) and `scripts/demo.ts` on the same validator | see section 8 |

## 5. Compute units and transaction size

Measured by `tests/06-large-tree-compute.ts` (`CU_RESULT` lines; claimant is
the only signer and fee payer; `simulateTransaction` and the executed
transaction agreed on every line):

| proof depth | leaves addressable | transaction bytes | compute units | notes |
|---|---|---|---|---|
| 9 and 11 | real 2,000-leaf tree, 8 claims | 788 / 852 | 42,504 to 51,500 | a wallet's first claim creates its token account, hence the spread |
| 20 | 1,048,576 | 1,140 | 73,032 | crafted proof (arbitrary siblings, root valid for that leaf); first claim of a fresh wallet |
| 22 | 4,194,304 | 1,204 | 52,500 | deepest proof that fits a legacy transaction |

Raw lines of the final run (section 8), `simulated` always equal to `executed`:
depth 11: 42,520 / 47,024 / 42,504 / 47,008 / 51,500 / 42,524; depth 9: 46,560 /
51,064; depth 20: 73,032; depth 22: 52,500. Earlier runs of the previous binary
measured 42,508 to 62,024 at depth 9 and 11, 44,552 to 59,540 at depth 20 and
44,498 to 63,008 at depth 22; the spread between runs is token-account creation
and account-size dependent CPI cost, not the proof (about 100 CU per level).

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
| program data (505,864-byte binary, `--max-len` = size) | 505,909 | 2,570,667,960 lamports (2.571 SOL) | deployer; about 5.14 SOL with the default 2x headroom for upgrades |

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
solana program deploy target/deploy/vicinity_rewards.so --program-id <program keypair> -k <deployer> -u devnet --use-rpc --max-len 505864
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

### Current state (3 Oct 2026, 17:15 UTC): deployed, registry created, demo run

The deployer `9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa` was topped up by the
owner from the public faucet (2 SOL, 4 SOL in total after the 2 SOL the faucet had
released to the build machine between 06:38 and 10:48 UTC in 123 requests). The three
commands above then ran in one go from the build machine, logged outside the
repository, with the saved production binary (505,864 bytes,
`f0fbc9d53ed092210eef3f97047644d6f796d634bf11c428795ff8b0b1e509a3`, hash-checked before
the deploy) and the program keypair of `declare_id!`.

| Step | Result |
|---|---|
| `solana program deploy ... --use-rpc --max-len 505864` | program `Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi`, ProgramData `B4XTEHayYiGTHkrRwMSxduGsWAg6rHAXhMkwqbgFLUoa`, upgrade authority = the deployer, slot 507068536, data length 505,864 bytes, program account balance 2.57066796 SOL; signature `2udFL7bWE9XuFes6sWEKX2cb5jX1RAsVGYJPQbGpgsY9oR62RqJbh67rXpzxk6wJ3B8iyDcPgejYqhME6EtQ4zoC` |
| `npm run init-registry` | registry PDA `2rKKwGGcJEDRJBhdHRPtHQpoxPmq9wPWWj3uMrcRaRg3`, admin = the deployer; signature `4AJAGEd5aMGQw42yZiuCLtiYJBHxC8yq7AJmYtZLvb4WEmvTwphbXWTDKE5dVuZE4AmqrrWkW6X8PY6BNcz66dgd` |
| `npm run devnet-demo` | one city (Split 50/50) with a test reward mint, epoch 0 funded with a 3-leaf tree, one holder claimed 25 with a 2-hash proof (46,480 compute units), epoch 1 funded and cancelled (carry-over 10), accounting invariants OK; five signatures below |
| deployer balance after | 1.39495484 SOL (2.571 SOL of it is now rent in the program account, recoverable with `solana program close` when the devnet copy is retired) |

Explorer: https://explorer.solana.com/address/Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi?cluster=devnet
(every address below takes the same `?cluster=devnet` suffix).

Sweep is not shown: epoch 0's claim deadline is 2026-10-17T17:13:29Z (the production
14-day minimum), so `sweep_epoch(0)` becomes possible on devnet from that moment;
the sweep path is proven by the test suite against a real 60-second deadline
(section 8). The upgrade authority stays with the throwaway deployer on devnet
(SECURITY.md 3.6); on mainnet it moves to the owner's multisig and, after the
audit, to none.

The JSON block `devnet-demo` printed (amounts in base units of the 6-decimal test
reward mint: 100000000 = 100):

```json
{
  "cluster": "devnet",
  "rpc": "https://api.devnet.solana.com",
  "programId": "Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi",
  "transactions": {
    "fundHolders": "2hrjK73YuixBQbFrXs4LaPWyxG3iaWB9iStNh5bbxKxWz3huo4g5wgeQw1dGZRmXfVhzNn3RsZeNTVGhVLoJh9o",
    "fundEpoch0": "TAsJZPM8AUaLszRL9A8eRA4cCxmx94LZWbbFAVmi6TbgSoN5TyxhPji6kkMTn8cG3Tk5V46LhzYpE9P53KaddaK",
    "claimHolderA": "3xgoAti1hdSH74b8WZo3irSAMK7mcNGjCpmapB4Ptb5qRyAbSpqwqdsprDeYZFEbxejYqZzAC32PbSFn5gcn2Ad9",
    "fundEpoch1": "5EPeBymNo2MQ8Y1j3FbompK42NPHRmfATSaZZmmYRg1y1XWkhfxVVSehbBgB96c4rsMujJgaknNrQLPZ2Le4LPQv",
    "cancelEpoch1": "2W45m9o576uFPwj3ZL73c7PyVDkFnyAe9aHwH8H85iwiiCYDAtA5sfuzP48N64b7LcDfDikDm2HrGtRR4mtA4iNW"
  },
  "registry": {
    "address": "2rKKwGGcJEDRJBhdHRPtHQpoxPmq9wPWWj3uMrcRaRg3",
    "admin": "9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa"
  },
  "city": {
    "cityCoinMint": "4eTtu7mFTy3M7VHAhWxFL82pRX9UXBcke8itWf4rDntJ",
    "rewardMint": "3nxbo2CKr9vjSfBDxBG4Au4fiXHJ1w2ETWrfRKapno4q",
    "config": "5YpkCJKwVfCo7cR5An35Xhwm27pfcPxKsQHV6oT88JcL",
    "vault": "ChHayzTTsv5mnpFbjcqmbUippm1MonzG2SLiaKwKAvJ6",
    "authority": "9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa",
    "founder": "4ae7WBDbmM4GNHpzZMBuYJQ47m7fFicfuRD7AiRmwuSf",
    "rewardModel": "split",
    "founderBps": 5000
  },
  "epoch0": {
    "address": "3aXnRMYCg4srEj8BNCbwvwnpk1yN6SmwEaHEJDK5wiU6",
    "merkleRoot": "538016065c13e7fcc22fcfb4fd729eea8f5b6503675bf9d34043932fd075eb09",
    "snapshotHash": "32485e8f63d180c8e3f14c22d633c2d34922371fed8c738ce2e204f062a66e1c",
    "snapshotFile": {
      "slot": 507068602,
      "mint": "4eTtu7mFTy3M7VHAhWxFL82pRX9UXBcke8itWf4rDntJ",
      "amount": "50000000",
      "leaves": [
        {
          "index": 0,
          "claimant": "1DhVpTNXQNn8a3G6xwJ7NR5TLAfne2wdnmgmedjHavz",
          "amount": "25000000"
        },
        {
          "index": 1,
          "claimant": "3UDZZFVMmbQDZXLgtX7mWWjmoRiy82CfhsPQQuju5Gqy",
          "amount": "15000000"
        },
        {
          "index": 2,
          "claimant": "4okmmh6we5VSLZUVhEXuUeerp5zJFfvexgrsyAVd2EYA",
          "amount": "10000000"
        }
      ]
    },
    "depositAmount": "100000000",
    "founderAmount": "50000000",
    "holdersAmount": "50000000",
    "numLeaves": 3,
    "claimDeadline": "2026-10-17T17:13:29.000Z"
  },
  "claim": {
    "claimant": "1DhVpTNXQNn8a3G6xwJ7NR5TLAfne2wdnmgmedjHavz",
    "claimStatus": "CLBwJPzPij5CSYM38AMSx7Key4PAC238X6fjDnCzmsmD",
    "amount": "25000000",
    "proofLength": 2,
    "computeUnits": 46480
  },
  "epoch1": {
    "address": "4tenzixQvfMraf7bU9DSq9aVDKMqzvrpjktKhxbmuxeQ",
    "state": "cancelled",
    "carryOver": "10000000"
  },
  "finalState": {
    "vault": "35000000",
    "founderBalance": "60000000",
    "totalFunded": "120000000",
    "totalToFounder": "60000000",
    "totalToHolders": "60000000",
    "totalClaimed": "25000000",
    "carryOver": "10000000",
    "locked": true
  }
}
```

## 8. Final run of this branch (3 Oct 2026, build machine, Agave 4.3.0 test validator)

Run by the second fixer at HEAD after the second review's fixes. Order: Rust
checks, SDK checks, production build and IDL diff (IDL recommitted), short-windows
build, full suite on a fresh hand-started validator loading both programs, the
three new regression tests against the previous binary, then `init-registry`,
the demo and the admin hand-over on the same validator, production rebuild
(hash equal to the first build).

| step | result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --all-targets -- -D warnings` (default and `--features short-windows`) | clean |
| `cargo test` | 29 passed (math incl. `effective_deadline`, Merkle fixtures, Token-2022 allow-list incl. close authority, vault surplus) |
| `npm run sdk-test` | 47 passed; both fixture files reproduce byte for byte from their generators |
| `npm run typecheck` | clean |
| `anchor build` (production, no features) | 505,864 bytes, sha256 `f0fbc9d53ed092210eef3f97047644d6f796d634bf11c428795ff8b0b1e509a3`; `MIN_CLAIM_WINDOW_SECS = 1209600`; IDL diff against the previous commit: `init_registry.admin` gains `"signer": true`, the founder and admin docs, the `FounderIsProgramAccount` message and the `total_funded` doc change, nothing else (no account, argument, seed or discriminator changed); copied to `sdk/idl/vicinity_rewards.json` |
| `anchor build -- --features short-windows` | 505,864 bytes, sha256 `add08669dab44770c634195652b3c249f8ef4191cc98ef1215195432694ebf98` (test build, never deployed); IDL identical to the committed one except `MIN_CLAIM_WINDOW_SECS = 60` |
| full suite against that build on a fresh validator (`--upgradeable-program` for the program and for the `[[test.genesis]]` copy, `VICINITY_REQUIRE_SHORT_WINDOWS=1`) | **144 passing, 0 failing, 0 pending** (8 minutes) |
| the three new regression tests against the previous short-windows binary (commit 689c646, sha256 `1541cbad...821a571`), each on a fresh validator | each red with "expected a failure ..., but the transaction succeeded": the old program stored an admin that never signed, accepted the registry PDA and another city's config as founder at `init_city`, and paid the founder share into a token account owned by the epoch PDA |
| `npm run init-registry` on the validator after the suite | "registry exists ... admin (the wallet)" after confirming on chain that the wallet is the upgrade authority; nothing sent |
| `scripts/demo.ts` on the same validator (it reused the registry) | `DEMO COMPLETE: every step behaved as specified`, exit 0; 13 attacks refused with the exact expected code (double claim, bigger amount, stranger with another leaf, truncated proof, early sweep, cancel with claims, stranger pause, stranger `init_city`, second lock, second `fund_epoch_from_vault`, claim on a swept epoch, old authority, claim while paused); cancel to carry-over, carry-only epoch, 100 tokens sent straight to the vault distributed by `fund_epoch_from_vault`, sweep after a real 60 s deadline, claim-status rent returned, `accounting invariants: OK` after every step |
| `REGISTRY_ADMIN=<throwaway key standing in for the multisig> npm run init-registry`, twice | first run: reports what is known about the key (ordinary key, no account on chain yet), `propose_admin` sent, `accept_admin` instruction printed (program, accounts, data `702a2d5a74b50daa`); second run: "already proposed; waiting for accept_admin", nothing sent |
| `accept_admin` signed by that key (stand-in for the multisig's vault transaction) | admin moved to the key, `pending_admin` cleared |
| `npm run init-registry` again, with and without `REGISTRY_ADMIN` | "the multisig is the admin; done" / prints the admin and exits; a propose attempt by the wallet afterwards is refused by the script ("only the current admin ... can propose") |
| `anchor build` again (production, so `target/` holds the real binary) | same 505,864 bytes, same sha256 `f0fbc9d5...509a3`, IDL equal, `MIN_CLAIM_WINDOW_SECS = 1209600` |

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
12. A paused city is frozen for holders too: while paused nobody can claim and
    nobody can sweep (the effective deadline moves with the clock), and only
    the authority can unpause. A compromised or absent authority can delay
    every open epoch's holder money indefinitely; it cannot take it. A long
    pause carries an epoch's effective window past `MAX_CLAIM_WINDOW_SECS`
    (a policy bound on the nominal window). `SECURITY.md` 3.8.
13. The founder check is a filter: the program refuses the zero address, the
    config, the vault and any account it owns itself (at `init_city` and at
    every funding), but it cannot know whether anyone can sign for an
    arbitrary off-curve key or a token account address; a share paid to such a
    key is stuck. The SDK's `founderWarnings` / `founderAccountWarnings` flag
    those cases for the operator (`README.md`, off-chain parts).

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
19. Pause has no time limit (limitation 12): an authority can freeze claims
    and sweeps indefinitely. A cap on the total pause per epoch, after which
    claims reopen, would reintroduce a sweep path for a stuck authority.
    Recommended: no cap; alert on every `pause` and on a pause longer than
    planned; the authority is a multisig.
20. Registry admin hand-over: the deployer is the first admin (the program
    requires the admin to sign `init_registry`) and proposes the multisig,
    which accepts in its own transaction before the upgrade authority moves
    (README step 5 and 6, `scripts/init-registry.ts`). Recommended: keep; the
    accept is the proof that the multisig address is right.
