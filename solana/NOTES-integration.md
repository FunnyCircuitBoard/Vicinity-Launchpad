# Integration notes (vicinity_rewards, branch feat/solana-rewards)

Written by the integrator after joining the program (Rust) and the SDK/tests
(TypeScript) work. Everything below was measured on this branch; numbers that
belong in AUDIT.md are marked as such.

## Toolchain (what produced the numbers below)

| tool | version |
|---|---|
| anchor-cli | 0.31.1 |
| Agave (solana-cli) | 4.3.0 |
| cargo-build-sbf / platform-tools | 4.4.0 / v1.57 |
| rustc (host, unit tests, clippy) | stable 1.97.0 |
| node | 22 |

Program id (localnet/devnet placeholder, keypair outside git): `Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi`.
Production binary `target/deploy/vicinity_rewards.so`: 382,120 bytes (unchanged by the integration; the `#[constant]` attributes only add to the IDL).

## The one command

```
anchor test -- --features short-windows
```

builds the program with the test-only `short-windows` feature
(MIN_CLAIM_WINDOW_SECS = 60 instead of 14 days), starts a validator with it and
runs all 120 mocha tests. Plain `anchor test` uses the production build and
reports the 7 deadline/sweep/close tests as pending (they cannot wait 14 days).
`cargo test` (21 unit tests), `cargo clippy --all-targets -- -D warnings`,
`cargo fmt --all -- --check`, `npm run sdk-test` (47 node tests) and
`npm run typecheck` complete the picture; `.github/workflows/solana.yml` runs
exactly this sequence and additionally checks that the committed IDL equals the
production build's IDL and that the committed fixtures equal their generators'
output.

### Environment caveat for whoever reruns this on the build box

The sandbox the integration ran in has no IPv6. anchor's "is the RPC port
free" check (crate `portpicker`) needs an IPv6 bind, so `anchor test` and
`anchor localnet` refuse to start their validator there with "rpc port 8899 is
already in use" even when nothing listens. The suite was therefore run exactly
as anchor runs it, by hand: `anchor build -- --features short-windows`, then
`solana-test-validator --reset --ledger <dir> --bind-address 127.0.0.1
--rpc-port 8899 --mint <wallet> --bpf-program <id> target/deploy/vicinity_rewards.so`,
then `anchor test --skip-local-validator --skip-build --skip-deploy` (which runs
`Anchor.toml` `scripts.test` = `npm run test` with `ANCHOR_PROVIDER_URL` and
`ANCHOR_WALLET` set). The demo was run the same way with `npm run demo`.
GitHub's runners have IPv6; CI uses the plain commands. The helper script used
here is not part of the repo (it hard-codes sandbox paths).

## What the integration changed

1. `programs/vicinity-rewards/src/constants.rs`: the policy constants carry
   `#[constant]` and appear in the IDL `constants` section with evaluated values
   (`MIN_CLAIM_WINDOW_SECS = 1209600`, `MAX_CLAIM_WINDOW_SECS = 31536000`,
   `ALLOWED_SPLIT_BPS = [2500, 5000, 7500]`, `CREATOR_BPS`, `HOLDERS_BPS`,
   `BPS_DENOMINATOR`). The UI and the Worker read them from the IDL instead of
   hard coding a copy (spec section 0: the UI must not show a number the program
   does not enforce).
2. `Cargo.toml` feature `short-windows` (test only, never deployed): MIN window
   60 s. A build's IDL shows which value it enforces.
3. `sdk/client.ts` loads `target/idl/vicinity_rewards.json` before the committed
   `sdk/idl/vicinity_rewards.json` (the tests must see the IDL of the binary on
   the validator); `VICINITY_IDL=<path>` overrides both.
4. `tests/helpers.ts`: test epochs default to a 30-day window (`defaultWindow()`),
   never to the minimum, so the 60 s minimum cannot expire an epoch under a
   running test file; only the deadline tests fund with the minimum.
5. Fixtures: one shape for both files (`sdk/fixtures/README.md`). The
   dependency-free generator of `merkle.json` is now in the repo
   (`sdk/fixtures/generate.mjs`, reproduces the committed file byte for byte);
   `sdk/gen-fixtures.mjs` writes `merkle-js.json` in the same shape. The Rust
   unit test and the JS test each read BOTH files and also check the recorded
   depth. One Merkle rule on both sides: sorted-pair nodes, an odd level
   promotes its last node unchanged, a 1-leaf tree has root == leaf.
6. `scripts/demo.ts`: every attack now has to be refused with the specific
   error the spec names (a wrong reason fails the demo, exit code 1); epochs 1
   and 2 get a normal 30-day window, epoch 0 the minimum so the sweep step runs
   on a short-window build.
7. `.github/workflows/solana.yml`: sdk-test, typecheck, production build, IDL
   diff, fixture regeneration diff, then `anchor test -- --features short-windows`.

## Account sizes and rent (for AUDIT.md)

Sizes include the 8-byte Anchor discriminator; rent is the rent-exempt minimum
(`solana rent`, mainnet default rent parameters).

| account | bytes | rent-exempt minimum | paid by |
|---|---|---|---|
| CityConfig | 287 | 2,108,200 lamports (0.0021082 SOL) | init_city payer |
| vault (SPL token account) | 165 | 1,488,440 lamports (0.00148844 SOL) | init_city payer |
| Epoch | 174 | 1,534,160 lamports (0.00153416 SOL) | fund_epoch funder |
| founder ATA (once per founder and mint) | 165 | 1,488,440 lamports | fund_epoch funder (init_if_needed) |
| ClaimStatus | 57 | 939,800 lamports (0.0009398 SOL) | claimant; returned by close_claim_status after sweep/cancel |
| claimant ATA (if missing) | 165 | 1,488,440 lamports | claimant (init_if_needed) |

## Compute units and transaction size (for AUDIT.md)

Measured by `tests/06-large-tree-compute.ts` on this run (claimant is the only
signer and fee payer, one legacy transaction, `simulateTransaction` and the
executed transaction agree):

| proof depth | leaves addressable | transaction bytes | compute units (executed) | notes |
|---|---|---|---|---|
| 9 and 11 | real 2,000-leaf tree | 788 / 852 | 42,002 to 56,550 (8 claims) | first claim of a wallet creates its ATA, hence the spread |
| 20 | 1,048,576 | 1,140 | 48,518 | crafted proof (siblings arbitrary, root valid for that leaf) |
| 22 | 4,194,304 | 1,204 | 49,002 | deepest proof that fits a legacy transaction |

Earlier runs of the same binary gave 48,522 / 48,538 CU at depth 20 and 44,498
CU at depth 22 (the difference is ATA creation and account-size dependent CPI
cost, not the proof); every measurement is far under the 200,000 CU default
limit, and `simulateTransaction` always reported the same number as the
executed transaction. Proof verification itself costs about 100 CU per level
(sha256 syscall); the bulk is account loading, the token transfer CPI and the
ATA creation.

Limits: 200,000 CU default per instruction; a legacy transaction is 1,232
bytes, a `claim` is 500 bytes + 32 per proof element, so the deepest proof that
fits is 22 (trees up to 2^22 = 4,194,304 leaves). Depth 23 and a 33-element
proof are refused by the runtime ("Transaction too large"), so the on-chain
`ProofTooLong` check (cap 32) is unreachable defence in depth. The snapshot job
must keep an epoch at or below 2^22 leaves (or move to a v0 transaction with an
address lookup table later).

## Results of the final run (3 Oct 2026, this branch)

| check | result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --all-targets -- -D warnings` (with and without `short-windows`) | clean |
| `cargo test` | 21 passed |
| `npm run sdk-test` | 47 passed (both fixture files reproduce) |
| `npm run typecheck` | clean |
| `anchor build` (production) | 382,120 bytes; IDL equals `sdk/idl/vicinity_rewards.json` |
| full suite on the short-windows build | 120 passing, 0 failing, 0 pending (5 min) |
| `scripts/demo.ts` on the short-windows build | "DEMO COMPLETE: every step behaved as specified", 11 attacks refused with the exact expected code, sweep after a real 60 s deadline, claim status rent (0.0012876 SOL incl. fee delta) returned |

## Spec section 5 coverage check

Every invariant in PROGRAM-SPEC.md section 5 has at least one test; the table in
`tests/README-tests.md` maps them. Items that were pending before the integration
and run now: claim after deadline (ClaimDeadlinePassed), sweep after deadline
(state Swept, carry_over, vault unchanged, event), EpochNotOpen on a swept
epoch for claim/sweep/cancel, close_claim_status (only the claimant, only an
existing status, rent returned, closing does not reopen the claim), swept
carry-over flows into the next epoch. Nothing is skipped in the full run.

Not testable on chain by design and documented instead: close_claim_status
after cancel (a cancellable epoch has zero claims, so no ClaimStatus exists);
ProofTooLong (see above).

## Open items for the docs/deploy step (not in this role)

- `README.md`, `SECURITY.md`, `AUDIT.md` (spec section 7) still to be written;
  copy the two tables above and the toolchain versions into AUDIT.md.
- Devnet deployment and explorer links (throwaway keypair outside the repo).
- `anchor build --verifiable` hash (Docker daemon untested in this sandbox).
- SPEC GAP flagged by the program author, needs an owner decision before mainnet:
  `init_city` is permissionless per mint (first caller wins the PDA), see the
  TRUST ASSUMPTION comment in `instructions/init_city.rs`.
- SPEC GAP: tokens sent straight to the vault (not through `fund_epoch`) are
  stuck by design (there is no withdraw and no "fund from vault"); fee wallets
  must point at an ops token account that then calls `fund_epoch`.

## Addendum by the finisher (3 Oct 2026, after the review fixes)

The numbers above describe the branch before commits d48b194 and fa37658
(registry, `fund_epoch_from_vault`, pause-extended deadlines). Current numbers
live in `AUDIT.md`: the production binary is 505,088 bytes, the suite has 140
tests, `cargo test` 29, and the account sizes are Registry 73, CityConfig 303,
Epoch 182, ClaimStatus 57. Every open item of the list above is closed or
recorded there: the docs exist, the devnet state is in `AUDIT.md` section 7,
the verifiable build stays with the owner (Docker), the two SPEC GAPs are
closed by the registry gate and by `fund_epoch_from_vault`.

## Addendum by the second fixer (3 Oct 2026, after the second review)

Four low findings, all accepted; none disputed after reproducing them against
the code (details in `SECURITY.md` 3.10). Program changes: `init_registry`'s
`admin` is a `Signer`; `init_city`, `fund_epoch` and `fund_epoch_from_vault`
refuse a founder whose account this program owns (and the epoch being
created). `scripts/init-registry.ts` creates the registry with the wallet as
admin and proposes the multisig. The test validator loads a second copy of the
program (`Anchor.toml [[test.genesis]]`) so the foreign-ProgramData case is
tested for real; a hand-started validator needs the extra
`--upgradeable-program` flag shown in `AUDIT.md` section 3. Current numbers and
hashes: `AUDIT.md` sections 2, 4, 6 and 8.
