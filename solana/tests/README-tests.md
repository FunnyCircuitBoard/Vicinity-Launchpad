# Anchor tests

`anchor test` (or `npm test` against a running validator with the program
deployed) runs every file in `tests/*.ts` with ts-mocha. Each file creates its
own city coin mint(s), so files are independent and the order does not matter.
After every test the accounting invariants of the touched cities are asserted
(`assertInvariants` in `helpers.ts`).

| file | spec section 5 items |
|---|---|
| `01-init-lock-authority.ts` | IDL surface (exactly 16 instructions, no withdraw/set_root, every PDA's seeds, SDK constants equal the IDL constants), the registry (only the upgrade authority creates it, only its admin can create cities, two-step admin transfer, a stranger cannot squat a config), init for Creator/Holders/Split 25/50/75, every init rejection (incl. founder = config/vault, authority signature checked on chain), lock, set_founder, two-step authority with cancel-by-reproposal and zero-address cancel, pause/unpause, events |
| `02-fund-epoch.ts` | exact founder floor and holders remainder for 25/50/75 and tiny amounts, Creator and Holders paths, auto-lock, window bounds, MissingSnapshotHash, NothingToDistribute, Paused, Unauthorized, funder token account checks, insufficient funds, epoch PDA, founder ATA checks, write-once epoch fields; `fund_epoch_from_vault`: money sent straight to the vault is distributed, only the unaccounted surplus counts, carry-over adds up, Creator model, same rules and founder ATA binding as fund_epoch |
| `03-claim.ts` | exact payouts, ATA creation, ClaimStatus, Claimed event, claimant signature checked on chain, double claim, wrong amount/index/proof, another wallet's leaf, truncated/overlong/33-element proofs, tampered sibling, zero amount, paused, missing epoch, pre-existing ATA, cap test with a crafted root (total > deposit), Creator epoch has nothing to claim |
| `04-sweep-cancel-deadline.ts` | cancel rules and events, carry-over into the next epoch exactly, carry-only epoch (amount 0), pause does not block cancel, pause time bookkeeping; with a short window: claim after deadline, sweep, EpochNotOpen on swept, close_claim_status rules and rent, and a pause extends the deadline (claim still works after the nominal deadline, sweep only after the extended one) |
| `05-substitution.ts` | wrong vault / other city's vault, config and epoch of another city, forged PDAs, foreign claim status, foreign destination ATA, other mint's token account, wrong token program, founder ATA of someone else, Token-2022 transfer-fee and mint-close-authority mints rejected at init, plain Token-2022 mint works end to end |
| `06-large-tree-compute.ts` | 2,000 leaves (depth 11) with 8 claims, 1-leaf tree, compute units of `claim` at depth 11, 20 and 22 (prints `CU_RESULT` lines for AUDIT.md) |

`npm run sdk-test` runs the pure Merkle tests (`sdk/merkle.test.mjs`), including
the fixture cross-check against `sdk/fixtures/merkle.json` and
`sdk/fixtures/merkle-js.json` (the Rust unit test reads the same two files; see
`sdk/fixtures/README.md`). `npm run typecheck` type-checks the tests, the SDK
and the demo.

## The one command that runs everything

```
anchor test -- --features short-windows
```

`MIN_CLAIM_WINDOW_SECS` is 14 days in production. The cases "claim after
deadline", "sweep", "claim on a swept epoch", "close_claim_status after
sweep" and "a pause extends the deadline" (8 tests in
`04-sweep-cancel-deadline.ts`, plus the sweep step of `scripts/demo.ts`) can
only run when an epoch's deadline passes during the run.
The `short-windows` Cargo feature (`programs/vicinity-rewards/Cargo.toml`,
tests only) lowers the minimum to 60 seconds; the arguments after `--` go to
`cargo build-sbf` and to the IDL build, so the IDL of that build carries
`MIN_CLAIM_WINDOW_SECS = 60` in its `constants` section.

How the tests notice: `sdk/client.ts` loads `target/idl/vicinity_rewards.json`
first (the IDL of the binary `anchor test` just deployed) and falls back to the
committed `sdk/idl/vicinity_rewards.json`; `VICINITY_IDL=<path>` overrides both.
`04` reads `MIN_CLAIM_WINDOW_SECS` from `idl.constants` and runs the deadline
block when it is at most 120 seconds. With a production build (`anchor test`
without the feature) that block prints a warning and is reported as pending:
a green run with "7 pending" is NOT a full run.

Every other test funds its epochs with `defaultWindow()` (30 days clamped into
the program's bounds, `helpers.ts`), never with the minimum, so a 60-second
minimum cannot expire an epoch under a running test file.

The test validator loads the program through the upgradeable loader with the
test wallet as upgrade authority (`Anchor.toml` `[test] upgradeable = true`).
`helpers.ts` creates the registry lazily with that wallet as admin
(`ensureRegistry`), so every `createCity` can sign as admin without an extra
key; the registry tests in `01` prove that nobody else can. The suite expects a
fresh ledger: the first registry test asserts that no registry exists yet (the
only state in which the upgrade-authority check is observable) and fails
loudly on a reused ledger instead of passing for the wrong reason. `anchor test`
always starts fresh; a hand-started validator needs `--reset`.

The mainnet build must not enable the feature: `anchor build --verifiable`
without features is what gets deployed, and its IDL shows
`MIN_CLAIM_WINDOW_SECS = 1209600`. CI (`.github/workflows/solana.yml`) builds
production first, checks the committed IDL against it, and only then builds and
tests with the feature.

## Error matching

`expectError(promise, ...codes)` accepts the program's error names
(`InvalidProof`, `Unauthorized`, ...), Anchor constraint names
(`ConstraintSeeds`, `ConstraintHasOne`, `ConstraintTokenMint`, ...) and regexes
over the transaction logs (`already in use` for a double claim: the system
program refuses to create the existing `ClaimStatus`). A code name matches only
as a whole word, so `Paused` is never satisfied by `AlreadyPaused` or `NotPaused`. Where Anchor may report
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
