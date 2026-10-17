# vicinity_curve lifecycle suites (litesvm, in process)

```
anchor build                 # target/deploy/vicinity_curve.so (the production build)
npm run vcurve:sbf           # target/vcurve-builds/halt-all/vicinity_curve.so (H02, H03)
npm run launchpad:fixtures   # once: the pinned Metaplex and Meteora DBC mainnet dumps
npm run test:curve           # every *.test.mjs here
```

`helpers.mjs` builds a `World`: one LiteSVM with the production build of
`vicinity_curve` (upgradeable, the test deployer as upgrade authority), the
committed mainnet binaries of `vicinity_rewards` and the old
`vicinity_launchpad` (`release/mainnet-2026-10-10`, SHA-256 checked) at their
mainnet addresses, the pinned Metaplex dump (and Meteora DBC for the old
program's launches), SPL Token and the associated token program, the WSOL mint
and a fixed clock. `VCURVE_SO` and `VCURVE_HALT_ALL_SO` point at other builds.

Every transaction goes through `World.send`. After every successful
transaction `invariants.mjs` checks every invariant of
`VICINITY-CURVE-DESIGN.md` section 9 (I1 to I22): SOL by the lamport difference
of every account in the message, explained by the fee, the system and native
token instructions that executed, the money events of `vicinity_curve` and
Anchor's closes; tokens from the token instructions that executed; each coin's
state by replaying the transaction's events through the SDK's math port
(`sdk/curve/math.mjs`) and comparing every field, which is also the parity of
the SDK with the program's real results; then the per-coin and global
invariants, and the liveness probe of I22 by simulation. After every failed
transaction it checks that nothing moved but the fee (none for a transaction the
runtime refuses before executing it). Every transaction is also decoded with the
SDK's `decodeTransactionEvents`, from the shape an RPC's getTransaction returns:
it must find exactly the checker's events, and nothing for a failed transaction.
`VCURVE_INVARIANTS=off`
skips the checks; `VCURVE_PROBE=end` runs the liveness probe only at the end
of each test.

| file | spec |
|---|---|
| `01-admin.test.mjs` | L01, L02, set_guardian, set_payout_config |
| `02-configs.test.mjs` | L03: config #0, edge configs, every V error on chain (golden vectors), enable/disable |
| `03-approvals.test.mjs` | L04: approve_launch checks, revoke and expiry, coin and ticker checks, the real old program's Approval, Coin and pause, the account at LEGACY_LAUNCHPAD |
| `04-launch.test.mjs` | L05: accounts, metadata, meta_hash, the 9.1-coin burn, authorities, launch fee, rent, legacy checks at launch, the pool-option config, substitutions; C01/C02 launch + first buy through a lookup table |
| `05-curve-trading.test.mjs` | L06: E1, E2, E9 to the lamport, the minimum buy, slippage, sell refusals, the user token account rules, many traders |
| `06-graduation.test.mjs` | L07: E3 (graduation at exactly S and 85 SOL), E4, E5 on the pool, E6 partial fill, E10 (rem = 1), max_quote_in, no second graduation |
| `07-pool.test.mjs` | L08: pool trades with the liquidity share and the drip until the set-aside liquidity is 0; dust sells drip nothing; the pool round trip bound |
| `08-buyback.test.mjs` | L09: the first run 150 slots after launch, the interval, E7 and E8, the cap and the backlog, burn and supply counters, never graduating (X23), no-ops, refused while buys are halted |
| `09-outflows.test.mjs` | L10: withdraw only to FEE_RECIPIENT, claim only by the founder, keeper batches; R01/R02 forward into the real vicinity_rewards vault, SyncNative, fund_epoch_from_vault and a holder's claim; R03 wrong configs; a new admin and the rewards authority (4.2) |
| `10-founder.test.mjs` | L10/L11: the payout opt-in path (exact wallet, daily, pause, never redirected, revoke) and transfer_founder |
| `11-halts.test.mjs` | L12, H01, H02, H03: the set_pause matrix, the guardian halt, the halt-all build over live state and back |
| `12-compute.test.mjs` | C01, C02: compute units of every instruction against the 11.1 budgets, the website's transaction sizes (also written to `target/vcurve-measurements.json`) |
| `13-checker.test.mjs` | L13: declared donations and holder burns keep every invariant; the checker fails on undeclared ones and on an out-of-band edit; `pay_out` refuses every debit when the liabilities exceed the balance (X31); forged events are refused (T56) |
| `14-attacks.test.mjs` | X01, X02, X04, X05 and F02 in miniature (every non-signer slot of the seven money instructions substituted: always refused, nothing moves); X04 completed (a real Token-2022 mint and Token-2022 copies of the coin's mint, vault and a holder's token account, with and without the Token-2022 program, in buy and sell) and X02 completed (a `Coin` made by the old program itself in the coin slot of all nine coin-level instructions) (NOTES 48); X32 (cross-coin bleed), X33 (approval replay), X58 (a 0-lamport seller or founder), X65 (the IDL tag returns `IdlInstructionStub`) |
| `15-attacks-accounts.test.mjs` | 12.4 account threats (NOTES 33): X03 fake mint, X06 metadata address, X29 re-initialisation of every account, X30 close and revival, X36, X37, X38, X39, X54 aliased accounts, X55 pre-funded PDAs, X60, X64 |
| `16-attacks-trading.test.mjs` | 12.4 trading threats: X13 zero outputs, X14 overflow, X15 zero denominators, X16 every partial-fill edge, X17 to X22, X40, X41, X42, X57 |
| `17-attacks-economics.test.mjs` | X07 and X08 donations against a twin coin, X09, X10, X11 round trips, X12 tiny trades, X27 and X27b drip farming, X28 dust sells; graduation-boundary sandwiches and founder wash trading |
| `18-attacks-buyback.test.mjs` | X23 bundled, X24 canonical sandwich (and the founder credited), X25 multi-leg bundles and the hold through K runs (T76), X26, X61 a hostile crank caller (its 0-lamport fee payer refused before execution, NOTES 47); a backlog the attacker makes himself |
| `19-attacks-admin.test.mjs` | X34, X35, X43, X43b, X44, X45, X46, X47 with the other cluster's id, X47b, X48 to X53 |
| `20-attacks-runtime.test.mjs` | X56 event spoofing, X59 clock warps, X62 launch sniping, X63 a rent increase |
| `21-sdk-prechecks.test.mjs` | 14.3 (T58) against the real runtime: the SDK's pre-checks refuse exactly what the chain refuses (0-lamport destinations, buyers with data or another owner, a buy leaving dust); R03's `initRewardsForCoin` against the real `vicinity_rewards` (authority problems fixable, NOTES 46) |
| `22-g01-onchain.test.mjs` | G01: every operation of the Rust crate's golden vectors (`reference/g01-vectors.json`, more than 10^4 trades) replayed on chain; events, errors and state digests equal (`VCURVE_G01_LIVES=n` for the first n lives) |
| `23-fuzz.test.mjs` | F01, F02: seeded random sequences over all 21 instructions, valid and invalid, with the model of `fuzz.mjs` side by side (CI: 300 steps on two seeds) |
| `24-configs-f03.test.mjs` | F03: every golden config and a seeded set across V1 to V11 through `add_launch_config`; a sample launched to graduation |
| `25-no-free-value.test.mjs` | I18 on chain (NOTES 35): one address alone from reachable states, and all addresses together, never gain (`VCURVE_I18_RUNS`) |
| `26-router.test.mjs` | G02, G03, R02b with the test-only mock router of `router/` (`npm run curve:router`) |
| `27-checker-gaps.test.mjs` | the checker itself (NOTES 34): I14 destinations pinned, I21 for tokens, I20 at run time (code edits, each cluster's compiled ids), I5 and I6 at every step of a multi-instruction transaction; the two regressions of the long F01/F02 run (a coin named only by its metadata account, buyback dust in an expensive pool); the fee rule of the failed-transaction check (NOTES 47) |
| `28-governance.test.mjs` | review GOV-1 and GOV-2 (NOTES 42, 43): the old program's admin must be this program's admin with no transfer pending (the mainnet case, `13qRam` as old admin, and every hand-over); `FEE_RECIPIENT` is never the admin or the guardian; the guardian is never the payout key or wallet |
| `29-clients.test.mjs` | review CLI-1, CLI-2 and CLI-3 (NOTES 44 to 46): `buyWithSwap` builds no buy without a minimum and the sandwich then fails; a failed transaction's genuine event CPI is not an event (`decodeTransactionEvents`); a pre-funded rewards config address is no config, and authority problems are fixable |

`fuzz.mjs` is the F01/F02 engine (a seeded generator, the actions, the model and its predictions);
`router/` is a native program used only by `26-router.test.mjs` and never deployed. Long runs:

```
VCURVE_FUZZ_STEPS=100000 VCURVE_FUZZ_SEEDS=7 VCURVE_FUZZ_LOG=1 node --test tests-curve/23-fuzz.test.mjs
VCURVE_I18_RUNS=200 node --test tests-curve/25-no-free-value.test.mjs
VCURVE_F03_N=5000 node --test tests-curve/24-configs-f03.test.mjs
```
