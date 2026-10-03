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
