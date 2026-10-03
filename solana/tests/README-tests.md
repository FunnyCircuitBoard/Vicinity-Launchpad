# Anchor tests

`anchor test` (or `npm test` against a running validator with the program
deployed) runs every file in `tests/*.ts` with ts-mocha. Each file creates its
own city coin mint(s), so files are independent and the order does not matter.
After every test the accounting invariants of the touched cities are asserted
(`assertInvariants` in `helpers.ts`).

| file | spec section 5 items |
|---|---|
| `01-init-lock-authority.ts` | IDL surface (exactly 12 instructions, no withdraw/set_root), init for Creator/Holders/Split 25/50/75, every init rejection, lock, set_founder, two-step authority with cancel-by-reproposal and zero-address cancel, pause/unpause, events |
| `02-fund-epoch.ts` | exact founder floor and holders remainder for 25/50/75 and tiny amounts, Creator and Holders paths, auto-lock, window bounds, NothingToDistribute, Paused, Unauthorized, funder token account checks, insufficient funds, epoch PDA, founder ATA checks, write-once epoch fields |
| `03-claim.ts` | exact payouts, ATA creation, ClaimStatus, Claimed event, double claim, wrong amount/index/proof, another wallet's leaf, truncated/overlong/33-element proofs, tampered sibling, zero amount, paused, missing epoch, pre-existing ATA, cap test with a crafted root (total > deposit), Creator epoch has nothing to claim |
| `04-sweep-cancel-deadline.ts` | cancel rules and events, carry-over into the next epoch exactly, carry-only epoch (amount 0), pause does not block cancel/sweep; with a short window: claim after deadline, sweep, EpochNotOpen on swept, close_claim_status rules and rent |
| `05-substitution.ts` | wrong vault / other city's vault, config and epoch of another city, forged PDAs, foreign claim status, foreign destination ATA, other mint's token account, wrong token program, founder ATA of someone else, Token-2022 transfer-fee mint rejected at init, plain Token-2022 mint works end to end |
| `06-large-tree-compute.ts` | 2,000 leaves (depth 11) with 8 claims, 1-leaf tree, compute units of `claim` at depth 11, 20 and 32 (prints `CU_RESULT` lines for AUDIT.md) |

`npm run sdk-test` runs the pure Merkle tests (`sdk/merkle.test.mjs`), including
the fixture cross-check against `sdk/fixtures/merkle.json`.

## Short claim window for the deadline tests

`MIN_CLAIM_WINDOW_SECS` is 14 days. The cases "claim after deadline", "sweep",
"claim on a swept epoch" and "close_claim_status after sweep" can only run when
an epoch's deadline passes during the test run. `04-sweep-cancel-deadline.ts`
reads the constant from the IDL (`idl.constants`, present when the program
declares it with `#[constant]`) and runs those cases when it is at most 120
seconds; otherwise it prints a warning and skips them.

To run them, build the program for tests with a short minimum window, for
example a Cargo feature that overrides the constant:

```toml
# programs/vicinity-rewards/Cargo.toml
[features]
short-windows = []
```

```rust
// constants.rs
#[cfg(not(feature = "short-windows"))]
pub const MIN_CLAIM_WINDOW_SECS: i64 = 14 * 86_400;
#[cfg(feature = "short-windows")]
pub const MIN_CLAIM_WINDOW_SECS: i64 = 5;
```

and `anchor test -- --features short-windows` (the IDL then carries the short
value, and the tests wait for real deadlines of a few seconds). The mainnet
build must not enable the feature; `anchor build --verifiable` without features
is what gets deployed.

## Error matching

`expectError(promise, ...codes)` accepts the program's error names
(`InvalidProof`, `Unauthorized`, ...), Anchor constraint names
(`ConstraintSeeds`, `ConstraintHasOne`, `ConstraintTokenMint`, ...) and regexes
over the transaction logs (`already in use` for a double claim: the system
program refuses to create the existing `ClaimStatus`). Where Anchor may report
a substitution through different constraints depending on account order, the
test lists every acceptable code; the point is that the transaction is refused
and no balance moves, which is asserted separately.

## Compute units and transaction size

`06-large-tree-compute.ts` prints lines like

```
CU_RESULT claim depth=20 tx_bytes=1140 simulated=NNNNN executed=NNNNN limit=200000
```

for depths 11 (real 2,000-leaf tree), 20 and 22 (crafted proofs with arbitrary
siblings; the root is valid for exactly that leaf). Copy the numbers into
`AUDIT.md`.

Why 22 and not 32: a legacy Solana transaction is capped at 1232 bytes. A
`claim` with the claimant as the only signer is 500 bytes plus 32 per proof
element (11 account keys, blockhash, instruction header, 32 bytes of fixed
arguments), so the deepest proof that fits is 22, i.e. trees of up to 2^22 =
4,194,304 leaves. Depth 23 fails at `Transaction.serialize()` with "Transaction
too large" (tested). A 32- or 33-element proof cannot be put into any
transaction, so the on-chain `ProofTooLong` check (cap 32) is defence in depth
and unreachable; `03-claim.ts` proves the transaction-level refusal instead.
When a second signer co-signs (the test harness's provider wallet), the limit
drops to 19; the real claim flow has one signer. The snapshot job should keep
the number of leaves per epoch at or below 2^22 (dedupe, apply eligibility, and
if a city ever has more holders, split the epoch).

Anchor's TypeScript instruction coder has a 1000-byte buffer and cannot encode
proofs longer than 30 elements; `helpers.ts` has `rawClaimInstruction` for the
oversize cases.
