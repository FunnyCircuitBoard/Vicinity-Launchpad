# Scripts

## `demo.ts`: the auditor's "see it working" run

Runs the complete life cycle of one city coin's rewards against a local
validator and prints every balance after every step: init (Split 50/50), fund,
three Merkle claims, a block of attacks that must fail, a cancelled epoch whose
money becomes carry-over, a carry-only epoch, the two-step authority transfer,
pause/unpause, and the final accounting with the invariants checked.

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

The program id comes from `sdk/idl/vicinity_rewards.json` (`address`), which
`anchor build` produces; keep it in sync with `declare_id!` and `Anchor.toml`.

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

## Devnet deployment and the real snapshot job

Deploying to devnet/mainnet is described in the workspace `README.md`. The
snapshot job (read holders, apply eligibility, `allocateProRata`, publish the
snapshot file, call `fund_epoch`) is specified in `PROGRAM-SPEC.md` section 6
and belongs to the Worker; `sdk/merkle.mjs` and `sdk/client.ts` are the pieces it
will reuse.
