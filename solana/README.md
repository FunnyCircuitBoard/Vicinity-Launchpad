# Vicinity Rewards (`vicinity_rewards`)

The Solana program behind "one city, one coin" rewards. For every city coin it
keeps one vault, records the founder's chosen reward model permanently, pays the
founder's share, lets qualifying holders claim their share against published,
verifiable Merkle snapshots, and keeps exact accounting. Nothing else.

This file is for the owner and the auditor. `SECURITY.md` has the threat model
and the list of risks with the mechanism and test that answers each.
`AUDIT.md` has toolchain versions, the reproducible build, compute units, rent,
devnet addresses, known limitations and the list of product decisions.

## What it is and what it is not

It is:

* a **rewards vault**: one SPL token account per city coin, owned by a program
  address, that only the program can move money out of;
* a **distributor**: the operator publishes a Merkle root per epoch, holders
  prove their leaf and are paid from the vault; nobody can claim twice, claim
  another wallet's leaf, or claim more than the epoch holds;
* a **ledger**: every lamport that went in, to the founder, to holders and out
  through claims is summed in the config, and six invariants tie those sums to
  the vault balance (`tests/helpers.ts`, `assertInvariants`).

It is not:

* a token launcher, a bonding curve, a pool or a swap. City coins are created
  and traded on Raydium LaunchLab and Raydium AMM; this program never touches
  the city coin, it only uses its mint address as the identity of a config;
* an oracle for eligibility. Who qualifies, with what balance, after what
  holding time, is decided off chain when the snapshot is taken. The chain
  guarantees that the published root cannot change, that every claim is proven
  against it, and that the published snapshot hash lets anyone recompute it;
* a treasury with an emergency exit. There is no `withdraw`. The only ways money
  leaves the vault are `claim` (to the wallet named in a leaf) and the founder
  share of `fund_epoch_from_vault` (to the founder's own token account, booked).

## Architecture

```
  Raydium LaunchLab / AMM          Vicinity Worker (off chain)           this program (on chain)
  ----------------------           ---------------------------           ------------------------------------
  creates the city coin  ------>   init_city (registry admin)  ------>   Registry ["registry"]  admin = Vicinity
  trades, pays fees                                                       CityConfig ["city", city_coin_mint]
       |                                                                    authority, founder, model, bps, totals
       | fee wallet = ops token account   fund_epoch(amount, root)          vault ["vault", config]  (SPL token acct)
       +------------------------------->  (money from the funder)  ---->      |
       | fee wallet = the vault itself    fund_epoch_from_vault(root)         |  Epoch ["epoch", config, index]
       +------------------------------->  (money already in the vault) -->    |    root, holders_amount, deadline
                                                                              |
  holder's wallet  <----  proof + amount from the Worker's API                |  claim(index, leaf, amount, proof)
       |                                                                      |    ClaimStatus ["claim", epoch, wallet]
       +--------------------------------------------------------------->  vault -> holder's token account
```

One epoch = one deposit (or one vault surplus) + one Merkle root + one claim
window. Unclaimed money is swept into `carry_over` after the deadline and
distributed by the next epoch. A wrong root can be cancelled while nobody has
claimed; its money also goes to `carry_over`.

## Accounts

| account | seeds | size (bytes) | one per | written by |
|---|---|---|---|---|
| `Registry` | `["registry"]` | 73 | program | `init_registry`, `propose_admin`, `accept_admin` |
| `CityConfig` | `["city", city_coin_mint]` | 303 | city coin | `init_city`, authority instructions, funding, claim |
| vault (SPL token account) | `["vault", config]` | 165 | city coin | token program only (program-signed transfers) |
| `Epoch` | `["epoch", config, index as u64 LE]` | 182 | funded distribution | `fund_epoch*` (write-once fields), `claim`, `sweep_epoch`, `cancel_epoch` |
| `ClaimStatus` | `["claim", epoch, claimant]` | 57 | claim | `claim` (created), `close_claim_status` (closed) |

Sizes include the 8-byte Anchor discriminator. Field by field documentation is
in `programs/vicinity-rewards/src/state.rs`. The IDL (`sdk/idl/vicinity_rewards.json`)
carries the seeds of every PDA and the policy constants.

`CityConfig` fields that matter for money: `reward_model` and `founder_bps`
(permanent once `locked`), `founder` (changeable by the authority), `carry_over`,
and the four totals with the invariants
`total_funded == total_to_founder + total_to_holders` and
`total_claimed <= total_to_holders`; the vault balance equals
`total_to_holders - total_claimed` plus any money that reached the vault
directly and has not been booked yet by `fund_epoch_from_vault`.

## Instructions

| instruction | signer(s) | what it does | refuses when |
|---|---|---|---|
| `init_registry` | payer, **program upgrade authority** | one-time: creates the registry with `admin` | signer is not the upgrade authority (`NotUpgradeAuthority`), registry exists |
| `propose_admin(new)` / `accept_admin` | registry admin / proposed key | two-step admin transfer; zero address cancels | `Unauthorized`, `NoPendingAdmin`, `NotPendingAdmin` |
| `init_city(model, bps, tag)` | payer, **registry admin**, authority | creates config + vault for one city coin | not admin (`Unauthorized`), bps/model mismatch, reward mint == city coin, unsupported Token-2022 mint, founder zero/config/vault, bad tag, config exists |
| `lock_config` | authority | economics permanent before the first epoch | `AlreadyLocked` |
| `set_founder(new)` | authority | future founder shares go to `new` | zero, config PDA or vault as founder |
| `propose_authority(new)` / `accept_authority` | authority / proposed key | two-step authority transfer | as for admin |
| `pause` / `unpause` | authority | blocks funding and claiming; pause time is added to every open epoch's deadline | `AlreadyPaused` / `NotPaused` |
| `fund_epoch(amount, root, leaves, slot, hash, window)` | authority, funder | moves `founder_bps` of `amount` to the founder's ATA and the rest to the vault, adds `carry_over`, opens the epoch, locks the config | paused, window out of bounds, nothing to distribute, Creator with tree or holder money, Holders/Split without root/leaves/snapshot hash |
| `fund_epoch_from_vault(root, leaves, slot, hash, window)` | authority, payer | same, but the money is the vault's **unaccounted surplus** (`vault - (total_to_holders - total_claimed)`); the founder share leaves the vault signed by the config PDA | same rules |
| `claim(index, leaf_index, amount, proof)` | claimant | pays `amount` from the vault to the claimant's ATA | paused, epoch not open, past the (pause-extended) deadline, index out of range, amount 0, proof too long or invalid, cap exceeded, already claimed (account exists) |
| `sweep_epoch(index)` | authority | after the deadline: unclaimed money to `carry_over`; state Swept | not open, deadline not passed (pauses extend it) |
| `cancel_epoch(index)` | authority | before any claim: holders money back to `carry_over`; state Cancelled | not open, has claims |
| `close_claim_status(index)` | claimant | rent of the claim status back, only after sweep or cancel | epoch still open, not the claimant |

Every state change emits an event (`src/events.rs`). Events are logs; an
indexer must reconcile from account state because Solana truncates logs in
busy transactions.

## Where the reward money comes from

The program is agnostic: any token account holding the reward mint can fund an
epoch (`fund_epoch`), and anything that arrives in the vault directly can be
booked into an epoch (`fund_epoch_from_vault`). So a LaunchLab creator-fee
wallet or a Vicinity platform-fee wallet can be pointed either at an ops token
account that then calls `fund_epoch`, or straight at the vault. Both paths pay
the founder share and book every unit; neither needs a program change.

The reward mint is chosen once per city at `init_city`. Classic SPL Token mints
(WSOL, USDC) are always accepted. Token-2022 mints are accepted only without
extensions that change amounts, transferability or the mint's existence
(transfer fee, transfer hook, permanent delegate, non-transferable, confidential
transfers, default account state, mint close authority and any unknown
extension are refused).

## Trust assumptions, in one paragraph

Whoever holds the **upgrade authority** can replace the program; whoever holds
the **registry admin** decides which city coins get a config; whoever holds a
city's **authority** publishes roots (the chain cannot judge a root's fairness,
only hold it immutable and verifiable), pauses, sweeps, cancels and changes the
founder. None of them can move vault money to themselves except by publishing a
root that names themselves, which is public and checkable against the snapshot
file. Recommended: all three keys on a Squads multisig, the upgrade authority
frozen after the audit. Details and the per-risk table: `SECURITY.md`.

## Policy constants (PRODUCT DECISION REQUIRED)

Nothing economic is invented in code paths; everything that is policy is a
`#[constant]` in `src/constants.rs`, present in the IDL, read by the SDK
(`client.policy()`) and asserted equal to the SDK's fallback literals by the
tests. The UI must only ever show these values.

| constant | default | decision |
|---|---|---|
| `ALLOWED_SPLIT_BPS` | 2500, 5000, 7500 | founder shares the Split model may use |
| `MIN_CLAIM_WINDOW_SECS` | 14 days | shortest claim window |
| `MAX_CLAIM_WINDOW_SECS` | 365 days | longest claim window |
| `CREATOR_BPS` / `HOLDERS_BPS` | 10000 / 0 | fixed by the model names |

Policies the binary enforces without a number:

* **No rewards in the city coin itself** (`RewardMintIsCityCoin`): the reward
  mint must differ from the city coin. Recommended: keep.
* **Unclaimed money is carried over only**: after the deadline it rolls into
  the next holders epoch; there is no sweep to the founder or a treasury and
  no withdraw. Recommended: keep.
* **Token-2022 policy**: classic SPL Token mints always; Token-2022 mints only
  without transfer fee, transfer hook, permanent delegate, non-transferable,
  confidential transfers, default account state, mint close authority or any
  unknown extension (allow-list, fails closed). Recommended: WSOL or USDC.
* **Registry admin model**: only `registry.admin` can create a city config;
  only the upgrade authority can create the registry, once. Recommended: the
  Squads multisig as admin, the Worker's ops key as each city's authority.
* **Snapshot hash mandatory** for Holders/Split epochs
  (`MissingSnapshotHash`): a root nobody can recompute is refused.

The full list of open product decisions (including off-chain eligibility, fee
routing and unclaimed-money policy) with recommended defaults is in `AUDIT.md`
section 10.

## Repository layout

```
solana/
  Anchor.toml, Cargo.toml          workspace; [test] upgradeable = true (the registry needs the upgrade authority)
  programs/vicinity-rewards/       the program (src/instructions/*.rs one file per instruction, state.rs, math.rs, merkle.rs)
  sdk/                             merkle.mjs (Worker-importable), pda.mjs, client.ts (builders), idl/ (committed production IDL), fixtures/
  tests/                           Anchor tests (01..06) and helpers.ts with the accounting invariants
  scripts/demo.ts                  the auditor's local walk-through; scripts/devnet-demo.ts the devnet one;
  scripts/init-registry.ts         the owner's one-time init_registry after a deploy (npm run init-registry)
  README.md, SECURITY.md, AUDIT.md this documentation
```

## Build, test, demo

Toolchain (pinned in CI, `.github/workflows/solana.yml`): Rust 1.97.0, Anchor
0.31.1, Agave 4.3.0 (platform-tools v1.57), Node 22.

```sh
cd solana
npm ci
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --features short-windows -- -D warnings
cargo test                                   # unit tests: math, Merkle (fixtures shared with JS), mint checks, deadline
npm run sdk-test                             # Merkle SDK against the same fixtures
npm run typecheck
anchor build                                 # production binary + IDL (target/idl must equal sdk/idl)
VICINITY_REQUIRE_SHORT_WINDOWS=1 anchor test -- --features short-windows   # full suite (see tests/README-tests.md)
anchor localnet & npm run demo               # the auditor's walk-through, see scripts/README-scripts.md
```

`--features short-windows` is a test-only build with a 60-second minimum claim
window so the deadline, sweep and pause-extension paths run against a real
clock. It must never be deployed; the IDL constant `MIN_CLAIM_WINDOW_SECS` tells
a production binary (1209600) from a test one (60), and CI checks it.

## Mainnet deployment (the owner, on his own machine)

Nothing in this repository has been deployed to mainnet and nothing here holds a
mainnet key. The steps below are the whole procedure; every command is run on
the owner's machine with the owner's wallet.

1. **Fresh program keypair.** `solana-keygen new --no-bip39-passphrase -o ~/vicinity-mainnet-program.json`
   (keep it offline after step 4; it is only needed to deploy to this address
   the first time). Print its address: `solana address -k ~/vicinity-mainnet-program.json`.
2. **Put the address in the code.** Replace the id in
   `programs/vicinity-rewards/src/lib.rs` (`declare_id!("...")`) and in both
   `[programs.*]` entries of `Anchor.toml`. Commit.
3. **Reproducible build.** With Docker running:
   `anchor build --verifiable` (uses the `solanafoundation/anchor:v0.31.1`
   image). Record `sha256sum target/verifiable/vicinity_rewards.so`; this is the
   hash the auditor and anyone else can reproduce from the commit.
   Copy `target/idl/vicinity_rewards.json` to `sdk/idl/` and commit it.
4. **Deploy.** `solana config set --url mainnet-beta`, make sure the deploying
   wallet holds about 3 SOL (rent for the program data account: 2.57 SOL for
   the 505 KB binary with `--max-len` equal to its size, about 5.1 SOL with the
   default 2x headroom for future upgrades; see `AUDIT.md`), then
   `anchor deploy --provider.cluster mainnet --program-name vicinity_rewards --program-keypair ~/vicinity-mainnet-program.json --verifiable`
   (or `solana program deploy target/verifiable/vicinity_rewards.so --program-id ~/vicinity-mainnet-program.json --use-rpc`;
   add `--max-len 505133` to pay rent for the exact size instead of the 2x default).
5. **Create the registry immediately**, in the same session, with the deploying
   wallet (the upgrade authority) and the multisig as admin:
   ```sh
   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
   ANCHOR_WALLET=<the deploying wallet> \
   REGISTRY_ADMIN=<Squads vault address> \
   npm run init-registry
   ```
   (`scripts/init-registry.ts`: checks on chain that the wallet is the upgrade
   authority, does nothing if the registry exists, prints the transaction.)
   Until the registry exists no city config can be created, and once the
   upgrade authority is gone it can never be created.
6. **Hand the upgrade authority to the multisig:**
   `solana program set-upgrade-authority <program id> --new-upgrade-authority <Squads vault address> --skip-new-upgrade-authority-signer-check`
   (or make it immutable right away, step 8).
7. **Verify what is on chain.** `solana program dump <program id> /tmp/onchain.so`
   and compare `sha256sum` with the verifiable build (the dump may be padded
   with zeros up to the account size; compare the first N bytes where N is the
   size of your .so, or use `solana-verify verify-from-repo`). Also
   `anchor idl init --filepath target/idl/vicinity_rewards.json <program id> --provider.cluster mainnet`
   so the IDL is on chain for explorers.
8. **Freeze after the audit (optional, irreversible):**
   `solana program set-upgrade-authority <program id> --final`. After this no
   bug can be fixed; do it only when the auditor has signed off and the
   registry exists.
9. **Per city:** the Worker (ops key = registry admin, or a key the admin
   delegates to by being the `authority`) calls `init_city` right after the
   LaunchLab create, then `fund_epoch` or `fund_epoch_from_vault` per epoch.

## Devnet

A throwaway deployer keypair created on the build machine (outside the
repository, never printed) deploys the production build to devnet
(`solana program deploy`), creates the registry with `npm run init-registry`,
then `scripts/devnet-demo.ts` creates one demo city with a test reward mint,
funds epoch 0 with a 3-leaf tree, lets one holder claim, funds epoch 1 and
cancels it. Addresses, explorer links and transaction signatures (or, if the
devnet faucet did not fund the deployer, the exact state reached) are in
`AUDIT.md` section 7. The committed `declare_id!` is the devnet program id.

## Off-chain parts (specified, not built here)

* **Snapshot job** (Worker): at slot S read the holders of the city coin,
  apply eligibility (PRODUCT DECISION), compute pro-rata amounts in reward-mint
  base units (`sdk/merkle.mjs` `allocateProRata`, floor, dust stays as
  carry-over), build the tree, publish the snapshot file (JSON: slot, mint,
  amount, leaves), set `snapshot_hash = sha256(file)`, call `fund_epoch`.
* **Proof API**: `/api/rewards/<mint>/<epoch>/proof?wallet=` returns index,
  amount and proof; the page builds `claim` for the user's wallet.
* **Monitoring**: alert when `vault != total_to_holders - total_claimed` (money
  waiting for `fund_epoch_from_vault`), when a `fund_epoch` fails on the
  founder's token account (frozen or re-owned ATA: call `set_founder`), and on
  every `set_founder`, `propose_authority`, `propose_admin`.
