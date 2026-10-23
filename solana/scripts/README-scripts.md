# Scripts

## `demo.ts`: the auditor's "see it working" run

Runs the complete life cycle of one city coin's rewards against a local
validator and prints every balance after every step: registry, init (Split
50/50), fund, three Merkle claims, a block of attacks that must fail (including
a stranger trying to create a city config), a cancelled epoch whose money
becomes carry-over, a carry-only epoch, money sent straight to the vault and
distributed with `fund_epoch_from_vault`, the two-step authority transfer,
pause/unpause, and the final accounting with the invariants checked.

## `devnet-demo.ts`: the same story on devnet (what AUDIT.md section 7 records)

```sh
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=<path to the devnet deployer keypair> npm run devnet-demo
```

Creates a test reward mint, the registry (the wallet must be the program's
upgrade authority), one city config (Split 50/50), funds epoch 0 with a 3-leaf
tree, lets one holder claim, funds epoch 1 and cancels it (carry-over), and
prints every address with an explorer link plus a JSON block to paste into
`AUDIT.md`. Sweep cannot be shown on devnet before the 14-day minimum window has
passed; the script prints the date after which `sweep_epoch` for epoch 0 works.

```sh
cd solana
npm install                 # once
anchor build                # once; writes target/deploy/vicinity_rewards.so and the IDL
anchor localnet             # terminal 1: validator with the program deployed, stays running
npm run demo                # terminal 2
```

Without Anchor's `localnet` you can start the validator yourself:

```sh
solana-test-validator --reset \
  --bpf-program $(solana address -k target/deploy/vicinity_rewards-keypair.json) target/deploy/vicinity_rewards.so
```

Environment (all optional): `ANCHOR_PROVIDER_URL` (default `http://127.0.0.1:8899`),
`ANCHOR_WALLET` (default `~/.config/solana/id.json`; if the file does not exist
a throwaway wallet is written to `.anchor/demo-wallet.json` and airdropped).

The program id comes from the IDL's `address`: `sdk/client.ts` loads
`target/idl/vicinity_rewards.json` (the build you just made) first and falls
back to the committed `sdk/idl/vicinity_rewards.json`; `VICINITY_IDL=<path>`
overrides both. Keep the id in sync with `declare_id!` and `Anchor.toml`.

The demo creates the registry first (`init_registry`, signed by the wallet,
which is the validator's upgrade authority for the program) and uses the same
wallet as registry admin; without a registry no city config can be created.

What to look at in the output:

* every `balances after ...` block ends with `accounting invariants: OK`:
  `total_funded == total_to_founder + total_to_holders`, `total_claimed <=
  total_to_holders`, `vault == total_to_holders - total_claimed`, `vault == sum
  of open epochs' unclaimed + carry_over`, per-epoch `claimed <= holders`.
* the founder share is floored and the remainder goes to holders (`splitAmount`).
* the attack block lists the exact error code the program answered with and
  shows the vault balance unchanged.
* the sweep step runs only when the program was built with a short
  `MIN_CLAIM_WINDOW_SECS` (the demo reads the IDL constant); with the 14-day
  default it says so and the test suite covers sweep instead.

The demo exits with code 1 if any "must fail" step succeeds.

## `init-registry.ts`: the owner's one-time step after a deploy

```sh
ANCHOR_PROVIDER_URL=<rpc url> ANCHOR_WALLET=<upgrade authority keypair> REGISTRY_ADMIN=<admin public key> npm run init-registry
```

Creates the `["registry"]` PDA with the wallet as admin (the program requires
the admin to sign `init_registry`, so a key nobody holds can never become the
only key that may create cities). With `REGISTRY_ADMIN` it then proposes that
key as the new admin (`propose_admin`) and prints the `accept_admin`
instruction (program, accounts, data) for the multisig to execute; the accept
proves the key is live. It reads the program's ProgramData account first and
refuses when the wallet is not the upgrade authority, repeats no step that is
done (safe to rerun; a rerun after the accept prints the multisig as admin),
and prints every transaction with an explorer link. The devnet-demo creates
the registry itself when it is missing, so on devnet either order works; on
mainnet this script is step 5 of the README's deployment procedure, and step 6
(moving the upgrade authority) waits until it prints the multisig as admin.

## Devnet deployment and the real snapshot job

Deploying to devnet/mainnet is described in the workspace `README.md`. The
snapshot job (read holders, apply eligibility, `allocateProRata`, publish the
snapshot file, call `fund_epoch`) is specified in `PROGRAM-SPEC.md` section 6
and belongs to the Worker; `sdk/merkle.mjs` and `sdk/client.ts` are the pieces it
will reuse.

## `vcurve/`: the vicinity_curve IDL and builds (VICINITY-CURVE-DESIGN.md 8.4, C03, C04)

```sh
cd solana
npm run vcurve:idl          # regenerate sdk/idl/vicinity_curve.json from the source
npm run vcurve:idl:check    # fail if the committed IDL differs from the source
npm run vcurve:sbf          # production, devnet and halt-all SBF builds
```

The deployed `vicinity_curve` binary has no IDL instructions (`no-idl` is a
default feature), so its client IDL is generated with Anchor's `idl-build`
feature and committed; CI diffs it against `anchor build`'s output.
`vcurve:sbf` builds the three variants into `target/vcurve-builds/<variant>/`
(never over `target/deploy`), recompiling the program crate each time so that
every cargo-build-sbf warning is printed, fails on any "Stack offset ...
exceeded" warning and prints each binary's size and SHA-256. CI runs it after
every push. Sizes and the toolchain are recorded in `VICINITY-CURVE-NOTES.md`.

`vcurve/preflight.mjs` is the deploy checklist of 8.4 and 8.5: it reads each
precondition from the chain and exits 1 while any is not met. It needs
`--guardian-multisig`, the guardian's Squads multisig, and refuses one whose
members can change it (an autonomous multisig; only a controlled multisig whose
config authority is the admin vault passes), one with a time lock, one the
guardian is not a vault of, a launch approver that is one of its member keys
(review R6-RT-2), a threshold above 1 or fewer than two members who can each
start, approve and execute a stop alone (review R7-2), and a launch approver that
is any vault of it (review R7-CONF-3); `--vault-multisig` adds the same approver
checks for the vault's multisig, and `--approver-multisig` checks an approver that
is a multisig vault (O32 (a): one of its vaults, no time lock, no member key
shared with the guardian's or the vault's multisig; required when the approver
is not a wallet key). An approver that is not a wallet key is not ready at all
while the batch verifier cannot check a publication made through Squads (review
R8-DIFF-6); an approver multisig whose members include the guardian, the admin
vault, any vault of the guardian's or the vault's multisig or any other program
address, or whose config authority is neither none nor the admin vault, is
refused, and a threshold of 1 is a warning (review R8-DIFF-3). Every
`LaunchConfig` must keep a buyback share the keeper can keep up with as under
config #0, `C * b_B <= 3t` (8.4's operating rule; the program accepts more, open
owner decision O36): an enabled config outside it is not ready
(`CONFIG_BUYBACK_THROUGHPUT`), a disabled one is a warning (review R9-PF-1).
`--proposed-guardian`, `--proposed-payout-authority`,
`--proposed-payout-destination` and `--proposed-launch-approver` check a key
before the proposal that sets it is signed.

`vcurve/batch.mjs` is the owner's batch verifier (`verify <list file>`, before
he signs the day's `publish_launch_batch`), his confirmation (`confirm <seq>
<root>`, within minutes of its landing) and the monitor's comparison (`check
<list or archive file>`, after a publication), 8.4 steps 2, 3 and 5. Every
`--rpc` must be a provider the website does not operate or relay; with `--rpc`
twice the two must be different providers (by IP address, or by the last two
labels of the host name), and every account, the Clock sysvar (within a
minute; the earlier is used) and the pending approvals must agree on both, for
`verify`, `confirm` and `check` alike (reviews R8-DIFF-1, R8-DIFF-4); each city's
`Coin` (and the old program's), which every trade rewrites, is compared only in
whether it exists and its owner, so a trade between the two reads stops nothing
(R8-NEW-1). `verify` prints the
day's changes only against lists the owner signed and confirmed (reviews
R6-DIFF-1, R6-RT-1, R7-BA-1, R7-3): its archive (`--archive <dir>`, default
`$VICINITY_BATCH_ARCHIVE` or `~/.vicinity-curve/launch-batches`) keeps each
verified list in `pending/` with the window of its transaction, and `confirm`
moves it to `signed/` only when the chain holds exactly that publication; a live
stored batch that is not a confirmed list is a problem. On a first use, with an
empty archive, `--previous` / `--in-force` may stand in, read from two RPCs of
different providers (`--rpc` twice; review R7-4) and printed in full. With `--tx
<base64>` it checks that the transaction the website's batch page built is
exactly the verified publication, with the default window (reviews R7-CONF-1,
R8-DIFF-2); either way it prints the message hash a hardware wallet shows when
it blind-signs, and the owner signs exactly that transaction. `--correct`
builds (or, with `--tx`, checks) 8.4 step 5's correction of a batch in force,
`clear_launch_batch(halt = false)` then the publication in one transaction,
and shows the changes as they stand once the clear has landed; without it a
list that removes or changes an entry of the batch in force is warned that the
batch keeps running until the new list's valid_from (review R8-OPS-1).
`confirm` keeps a list as a baseline only when the transaction that wrote it
is the one the owner verified, by its message hash, on every RPC (review
R8-DIFF-2); it reads that transaction from the block of the record's
`published_slot`, so no flood of transactions naming LaunchBatch can hide it, and
a transaction not found (`TX_NOT_FOUND`) or a block an RPC cannot serve
(`TX_UNREAD`) is a reason to retry or read through a third provider, never a
theft; the alarm of `verify` says the same (review R9-TOOLS-2). The transaction
that wrote the record is any `publish_launch_batch` of it in that block, by its
discriminator and decoded arguments, whatever bytes follow them: the program
ignores them, so a thief's republication with bytes appended is found, named
(`warning TX_EXTRA_DATA`) and, being another message hash, is the stolen-key
alarm (`NOT_YOUR_TRANSACTION`); `verify --tx` refuses a page transaction whose
publication is not exactly 68 bytes (`TX_PUBLISH_DATA`; review R9-CHECK-1). The archive's MAC key is `~/.vicinity-curve/archive.key`, never a
file inside an archive folder, and must be 32 bytes; every run names the
folder and the key's fingerprint and warns when the folder is not the one used
last (review R8-DIFF-5). An approver that is not a wallet key is refused
(review R8-DIFF-6). A ticker another city
can still launch with is refused (review R7-BA-2). Each entry is printed with its
metadata hash, and each changed entry names the fields that differ (review
R6-DIFF-2). It prints the unsigned transaction only when nothing is wrong, and
never holds or asks for a key.

`vcurve/guardian-stop.mjs` is a guardian member's stop (8.4 step 5; review
R7-1): `clear_launch_batch(halt = true)` (`--clear`) and/or `set_pause`
(`--pause-launches`, `--halt-buys`) through the guardian's Squads vault, with
the vault transaction's create, proposal, approval and execution in one
transaction, so that no approved proposal waits where another member could
cancel it; it sends its stop for the multisig's next few transaction indices at
once (`--variants`, default 4) and repeats (`--rounds`) until the chain shows
the stop. It needs `--rpc` twice, two providers the website does not operate or
relay: it reads both, sends through both, and reports the stop only when both
show it and one of the member's transactions is confirmed (review R8-OPS-2).
Every RPC call has a timeout (`--timeout`, seconds, default 8): an RPC that
fails or does not answer is reported, the stop goes through the other at once
(each blockhash's variants are sent the moment it arrives), and the run then
ends with `PROBLEM RPC_FAILED` (exit 1), never a success on one RPC's word; the
print-only mode prints the variants on every blockhash obtained. Everything an
RPC returns is checked on its own: a multisig transaction index with no room for
the variants below 2^64 (`RPC_BAD_INDEX`) or a blockhash that is not 32 bytes in
base58 is that RPC's failure, and the other RPC's variants are still printed or
sent (review R9-TOOLS-1). When both RPCs answer and disagree on the stop, the
rounds end once one shows it with the member's transaction confirmed on both,
and the run ends with `PROBLEM RPC_DISAGREE` (check through a third provider;
review R9-TOOLS-3). RPCs are named by host only, never by their full URL.
Each transaction carries a compute-unit limit (150,000) and price
(`--priority-fee`, micro-lamports per unit, default 1,000,000, doubled each
round up to 50,000,000; review R8-DIFF-7). With `--keypair <file>` it signs
with the member's key (never printed); with `--member <key>` it only prints the
unsigned transactions and their message hashes.
