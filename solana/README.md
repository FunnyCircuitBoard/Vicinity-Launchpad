# Vicinity Rewards (`vicinity_rewards`)

The Solana program behind "one city, one coin" rewards. For every city coin it
keeps one vault, records the founder's chosen reward model permanently, pays the
founder's share, lets qualifying holders claim their share against published,
verifiable Merkle snapshots, and keeps exact accounting. Nothing else.

**A second program lives in this folder:** `vicinity_launchpad`
(`programs/vicinity-launchpad`), Vicinity's own launchpad on top of Meteora's
bonding curve: one coin per city, platform fees to the dev wallet, the city's
fee share split between holders (through this rewards program) and the
founder, and an opt-in founder payout for X Money. Start with `LAUNCHPAD.md`
(the owner's guide and the auditor's notes); `LAUNCHPAD-DESIGN.md` is its
specification, `LAUNCHPAD-AUDIT.md` its build and test record and
`LAUNCHPAD-DEVNET.md` its devnet deployment. Everything below is about
`vicinity_rewards`, which the launchpad work did not change.

**A third program, not deployed:** `vicinity_curve` (`programs/vicinity-curve`,
with its integer math crate `crates/vicinity-curve-math`), a fully custom
launchpad without Meteora: one coin per city with its own bonding curve, its
own pool after graduation, fee buckets, payouts, buyback-and-burn and a daily
batch launch approval. `VICINITY-CURVE-DESIGN.md` is its specification,
`VICINITY-CURVE-NOTES.md` its implementation notes, `VICINITY-CURVE-DEVNET.md`
its rehearsal D01, and `VICINITY-CURVE-AUDIT.md` the audit pack for the
outside auditor (scope, reproducible build and binary hashes, test suites,
roles, invariants, review history, open owner decisions). It does not change
`vicinity_rewards` either.

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
| `init_registry` | payer, **program upgrade authority**, **admin** | one-time: creates the registry; the admin must sign too, so a key nobody holds can never become the only key that may create cities (there is no second `init_registry`) | signer is not the upgrade authority (`NotUpgradeAuthority`), admin did not sign (`AccountNotSigner`), registry exists |
| `propose_admin(new)` / `accept_admin` | registry admin / proposed key | two-step admin transfer; zero address cancels | `Unauthorized`, `NoPendingAdmin`, `NotPendingAdmin` |
| `init_city(model, bps, tag)` | payer, **registry admin**, authority | creates config + vault for one city coin | not admin (`Unauthorized`), bps/model mismatch, reward mint == city coin, unsupported Token-2022 mint, founder zero or an account of this program (config, vault, registry, epoch, claim status: `FounderIsProgramAccount`), bad tag, config exists |
| `lock_config` | authority | economics permanent before the first epoch | `AlreadyLocked` |
| `set_founder(new)` | authority | future founder shares go to `new` | zero, the config PDA or the vault; it only sees a key, so any other account of this program is refused by the next funding instead |
| `propose_authority(new)` / `accept_authority` | authority / proposed key | two-step authority transfer | as for admin |
| `pause` / `unpause` | authority | blocks funding and claiming; pause time is added to every open epoch's deadline | `AlreadyPaused` / `NotPaused` |
| `fund_epoch(amount, root, leaves, slot, hash, window)` | authority, funder | moves `founder_bps` of `amount` to the founder's ATA and the rest to the vault, adds `carry_over`, opens the epoch, locks the config | paused, window out of bounds, nothing to distribute, Creator with tree or holder money, Holders/Split without root/leaves/snapshot hash, founder is an account of this program (`FounderIsProgramAccount`, fixed with `set_founder`) |
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
file. The authority can also keep a city paused for as long as it likes: while
paused nobody can claim and nobody can sweep, so holders' money is delayed, not
taken. Recommended: all three keys on a Squads multisig, the upgrade authority
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
  only the upgrade authority can create the registry, once, and the admin it
  names must sign (so the deployer starts as admin and hands the role to the
  multisig with the two-step transfer, whose accept proves the multisig is
  live). Recommended: the Squads multisig as admin, the Worker's ops key as
  each city's authority.
* **Founder address**: the program refuses the zero address, the config, the
  vault and any account it owns itself; it cannot see whether anyone can sign
  for an arbitrary key, so the Worker shows `founderWarnings` /
  `founderAccountWarnings` (`sdk/client.ts`) before `init_city` and
  `set_founder`. A program address works only if its program signs token
  transfers for it (a Squads vault does; this program's PDAs do not).
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

  programs/vicinity-launchpad/     the launchpad program (LAUNCHPAD.md, LAUNCHPAD-DESIGN.md, LAUNCHPAD-AUDIT.md, LAUNCHPAD-DEVNET.md)
  idls/                            Meteora DBC and DAMM v2 interfaces the launchpad is compiled against
  sdk/launchpad/                   launchpad SDK: addresses, Meteora config, curve maths, instruction builders,
                                   keeper (graduation and daily fee run), holder snapshot and rewards rounds (JavaScript),
                                   and the typed layer the website uses (index.mts: accounts, quotes, launch/buy/sell/
                                   coin-to-coin/graduate builders, metadata, pay with anything via Jupiter, holder
                                   airdrops, rewards rounds, founder payout hooks, platform-fee claims)
  tests-launchpad/                 launchpad in-process tests (litesvm, no validator); README.md there
  scripts/launchpad/               fetch-fixtures.sh (program dumps for the tests, pinned hashes), crank.mjs (the keeper:
                                   npm run launchpad:crank), snapshot.mjs (rewards rounds, read-only), setup.mjs
                                   (config, init, allow-list), claim-platform-fees.mjs (the dev wallet's fees),
                                   deploy-devnet.sh (guarded devnet deploy), devnet-demo.mjs (the whole flow on
                                   devnet, resumable from devnet-demo-state.json), devnet-record.mjs (the tables
                                   of LAUNCHPAD-DEVNET.md)

  programs/vicinity-curve/         the custom curve program (VICINITY-CURVE-DESIGN.md, -NOTES.md, -DEVNET.md, -AUDIT.md)
  crates/vicinity-curve-math/      its pure integer math crate, with the reference model and vectors
  sdk/curve/                       its SDK: accounts, quotes, instruction builders, events, batch leaves and proofs
  scripts/vcurve/                  its builds (sbf-builds.sh, idl.sh) and the owner's tools: batch.mjs (batch
                                   verifier, confirm, monitor check), guardian-stop.mjs, preflight.mjs (deploy checklist)
  tests-curve/, tests-vcurve/      its in-process suites (litesvm) and the per-transaction invariant checker
  rehearsals/vicinity-curve-d01/   the record of rehearsal D01 on a local copy of devnet: the driver as run, every
                                   transaction record and tool output it kept (VICINITY-CURVE-DEVNET.md section 12)
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
npm run launchpad:fixtures && npm run test:launchpad && npm run sdk-test:launchpad   # the launchpad (no validator)
npm run typecheck:launchpad                  # the launchpad's TypeScript SDK
```

`--features short-windows` is a test-only build with a 60-second minimum claim
window so the deadline, sweep and pause-extension paths run against a real
clock. It must never be deployed; the IDL constant `MIN_CLAIM_WINDOW_SECS` tells
a production binary (1209600) from a test one (60), and CI checks it.

## Mainnet deployment (the owner, on his own machine)

Nothing in this repository has been deployed to mainnet and nothing here holds a
mainnet key. Both programs (`vicinity_rewards` and `vicinity_launchpad`) go to
mainnet together, deployed by the owner from his Mac with Solana CLI 4.3.0 and set
up on vicinity.city with his Phantom wallet: **`../docs/OWNER-LAUNCH-GUIDE.md`**
has every command, and `../docs/MAINNET.md` section 4 the order and the team's
read-only checks. In short:

1. **Keys, on the owner's machine only.** `solana-keygen new` for the deployer,
   both program ids and two explicit buffers. He sends only the public addresses.
2. **The build.** `bash scripts/launchpad/build-mainnet.sh <launchpad id> <rewards id>`
   (the team, with the pinned cargo-build-sbf 4.4.0 / platform-tools v1.57) copies
   the build inputs to a scratch directory, first rebuilds them unchanged and checks
   the audited SHA-256 (`f0fbc9d5…09a3` here, `8706e3bf…27f0` for the launchpad),
   then changes only the two `declare_id!` lines, rebuilds, and checks that the new
   binaries differ from the audited ones in the id bytes only. It writes the two
   `.so` files, `SHA256SUMS` and `build-record.json`. The repository keeps the
   devnet ids (`anchor keys sync` never runs); no `security.txt` is added (it would
   change the audited bytes); no Docker `--verifiable` build is made.
3. **Deploy.** `solana program deploy vicinity_rewards.so --program-id rewards-program.json --buffer rewards-buffer.json --use-rpc --with-compute-unit-price 50000 --max-sign-attempts 100`
   through a paid, staked RPC (`--use-rpc` sends every upload through it; a free plan's one sendTransaction per second
   makes it hours),
   then the same for the launchpad. **Solana CLI 4.3 sizes the program to the
   binary** (`--max-len` defaults to the file's length; there is no 2x headroom any
   more) and extends the account by itself if a later upgrade needs more room
   (`--no-auto-extend` turns that off). The rent is therefore exactly 2.57066796 SOL
   for this program (505,909 bytes of ProgramData) and 2.20539564 SOL for the
   launchpad, plus 0.00083312 SOL per program account: 4.77772984 SOL for both
   (read from mainnet with `solana rent` on 10 Oct 2026). The owner funds the
   deployer with 4.9 SOL: `program deploy` first checks that the payer could cover
   the rent plus the highest possible fee of every upload at the chosen priority
   fee (0.039685 SOL for this program, 0.034135 SOL for the launchpad at
   `--with-compute-unit-price 50000`; 0.150775 and 0.129685 at 200000; measured on
   devnet with CLI 4.3.0), although it really spends about 0.003 SOL each. A stopped deploy resumes when the same command runs
   again (the explicit buffer); `solana program close --buffers` returns a
   half-written buffer's rent.
4. **Verify.** `solana program show <id>` (data length 505864) and
   `solana program dump <id> check.so` + `shasum -a 256`: the dump is exactly the
   binary (no padding, because the program is sized to it), so its SHA-256 equals
   the build's.
5. **Start the registry, then hand over.** `init_registry` must be signed by the
   current upgrade authority, so the order is: `solana program set-upgrade-authority <id> --new-upgrade-authority <owner's Phantom> --skip-new-upgrade-authority-signer-check`;
   then the website's City coins tab, step 1, signs `init_registry` (and
   `init_launchpad`) in Phantom: the owner's wallet becomes the registry admin; then
   step 2 hands both upgrade authorities to the owner's Squads vault (2 of 3). The
   registry admin can move to the vault later with `propose_admin` / `accept_admin`.
   (`npm run init-registry` and `scripts/init-registry.ts` are for devnet and
   localnet.)
6. **Freeze after the audit (optional, irreversible, through the Squads vault):**
   `set-upgrade-authority --final`. After this no bug can be fixed.
7. **Per city:** the City coins tab's "Set up holder rewards" signs `init_city`
   (the owner's wallet as payer, registry admin and authority) once per launched
   coin; reward rounds (`fund_epoch` / `fund_epoch_from_vault`) are not on the
   website yet, and the holders' share waits in the city's vault.

`npm run mainnet:preflight -- --cluster mainnet --setup <summary.json> --build-record <build-record.json> --expect-admin <owner>`
(repository root) checks all of it read-only: both programs, their upgrade
authority (the Squads vault), their fingerprints, the registry and its admin.

## Devnet

A throwaway deployer keypair created on the build machine (outside the
repository, never printed) deploys the production build to devnet
(`solana program deploy`), creates the registry with `npm run init-registry`,
then `scripts/devnet-demo.ts` creates one demo city with a test reward mint,
funds epoch 0 with a 3-leaf tree, lets one holder claim, funds epoch 1 and
cancels it. This ran on 3 Oct 2026 (17:12 UTC): the program is live on devnet as
`Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi`, with the registry, the demo city, the
claim and the cancelled epoch on chain; every address, explorer link and transaction
signature is in `AUDIT.md` section 7. The committed `declare_id!` is the devnet
program id.

## Off-chain parts (specified, not built here)

* **Snapshot job** (Worker): at slot S read the holders of the city coin,
  apply eligibility (PRODUCT DECISION), compute pro-rata amounts in reward-mint
  base units (`sdk/merkle.mjs` `allocateProRata`, floor, dust stays as
  carry-over), build the tree, publish the snapshot file (JSON: slot, mint,
  amount, leaves), set `snapshot_hash = sha256(file)`, call `fund_epoch`.
* **Proof API**: `/api/rewards/<mint>/<epoch>/proof?wallet=` returns index,
  amount and proof; the page builds `claim` for the user's wallet.
* **Founder addresses**: before `init_city` and `set_founder` the Worker runs
  `founderWarnings(founder, {config, vault, programId})` and
  `founderAccountWarnings(connection, founder, programId)` from `sdk/client.ts`
  and shows every warning to the operator (the chain refuses what it can
  recognise; it cannot know whether anyone can sign for an arbitrary key).
* **WSOL as reward mint**: lamports sent to the vault's address as plain SOL
  do not count as token balance (and so not as surplus) until anyone calls the
  token program's permissionless `SyncNative` on the vault; the Worker runs it
  before `fund_epoch_from_vault`.
* **Monitoring**: alert when `vault != total_to_holders - total_claimed` (money
  waiting for `fund_epoch_from_vault`), when a `fund_epoch*` fails on the
  founder (frozen or re-owned ATA, or `FounderIsProgramAccount`: call
  `set_founder`), when a city stays paused for longer than planned (claims and
  sweeps are frozen until `unpause`), and on every `set_founder`,
  `propose_authority`, `propose_admin`, `pause`.
