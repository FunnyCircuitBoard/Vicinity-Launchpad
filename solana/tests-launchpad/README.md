# Launchpad tests (in process, no validator)

```
npm run launchpad:fixtures   # once: dumps Meteora DBC, DAMM v2 and Metaplex from mainnet, checks pinned SHA-256
anchor build                 # the tests load target/deploy/vicinity_launchpad.so and vicinity_rewards.so
npm run test:launchpad       # every *.test.mjs here, about 15 seconds
npm run sdk-test:launchpad   # sdk/launchpad/*.test.mjs and *.test.mts (no chain)
npm run typecheck:launchpad  # the TypeScript SDK (sdk/launchpad/*.mts)
npm run test:jupiter-live    # optional: read-only calls to Jupiter's mainnet API (quotes, one composed plan)
npm run test:devnet-accounts # optional: the devnet demo's configs and test token, read from devnet and replayed here
```

Before a devnet demo, run the suite on Meteora's devnet builds too:
`NETWORK=devnet npm run launchpad:fixtures` then
`LAUNCHPAD_PROGRAMS_DIR=tests-launchpad/fixtures/programs-devnet npm run test:launchpad`.

Each test builds its own `World` (`helpers.mjs`): one litesvm instance with our
program and `vicinity_rewards` loaded through the upgradeable loader (the test
`deployer` key is their upgrade authority, so `init_launchpad` and
`init_registry` are exercised for real), the three mainnet dumps, the WSOL
mint, the DAMM v2 customizable config (`fixtures/accounts/`), DBC's pool
authority funded for graduation's flash rent, and the clock at real time. No
ports are opened and nothing touches the network.

| file | design section 17 ids |
|---|---|
| `01-admin.test.mjs` | TA01-TA08 (TA08: an admin hand-over never merges the admin with the payout key or wallet) |
| `02-configs.test.mjs` | TB01-TB17 (TB17: the leftover rule 7.2(13)) |
| `03-launch.test.mjs` | TC01-TC11 |
| `04-trading.test.mjs` | TD01-TD11 (TD11: random trades, `PROP_SEED` and `PROP_STEPS` env) |
| `05-fees-rewards.test.mjs` | TE01-TE09 |
| `06-founder-payout.test.mjs` | TF01-TF11 |
| `07-graduation.test.mjs` | TG01-TG08 |
| `08-attacks.test.mjs` | TH01-TH12 |
| `09-graduation-defences.test.mjs` | TG09-TG14 (surplus, pre-funded addresses, atomic graduation, nothing twice, nothing left behind) |
| `10-keeper.test.mjs` | TI01-TI07 (the keeper of `scripts/launchpad/crank.mjs`; TI07: it recreates the dev wallet's referral account and ignores positions outside the coin's own pool) |
| `11-holders-pot.test.mjs` | TE10-TE15 (where the holders' money can go, end to end to each holder's claim; TE14 time-weighted snapshots against a flash holder; TE15 the reward token's own decimals and minimum payout) |
| `12-client-sdk.test.mjs` | TJ01-TJ11: the TypeScript client SDK (`sdk/launchpad/*.mts`) against the real programs: decoders and fetchers, launch with a first buy, quote parity over many random trades (`CLIENT_PARITY_STEPS`, `CLIENT_PARITY_SEED`), the harvest split, SOL wrapping, coin to coin, pay with anything and sell into anything (a real DBC swap standing in for Jupiter's), graduation and DAMM v2 trades from the builders, pay with anything near and after graduation (TJ10), the dev wallet's referral account recreated by every builder (TJ11) |
| `13-rewards-payout-tools.test.mjs` | TK01-TK04: unsigned "send to all holders" batches, a rewards round funded and claimed through the SDK, the founder payout hooks and the payout planner |
| `14-devnet-accounts.test.mjs` | TL01-TL02 (opt-in, `npm run test:devnet-accounts`, reads devnet, sends nothing): the test token and the two Vicinity Meteora configs the devnet demo created, read from devnet and replayed through our program on Meteora's devnet builds: every config rule passes, a coin on each trades, and the tVIC coin fills, pays its fees and graduates (LAUNCHPAD-DEVNET.md) |
| `17-admin-builders.test.mjs` | TN01-TN07: the admin "City coins" tab (`src/lpadmin.js`, `src/sol/lpadmin-ix.js`, `src/sol/squads.js`): every builder equals the SDK's, the generated `src/sol/dbc-config-data.js` is current, the Worker's fingerprints of Meteora's programs as loaded (`src/programpins.js`) are the dumps' SHA-256 (the mainnet pins); then every transaction the routes build is signed and run here: init_registry + init_launchpad (the ProgramData authority check), the hand-over of both upgrade authorities to a Squads vault, the price curve from a one-time key (byte-equal to the expected account; the live mainnet curve, PoolConfig.version 0, passes the same check), its allow-list entry, the fee account, the speed table, the partner entry, approve / revoke, holder rewards, collect / forward, pause, pool fees after graduation and the dev wallet's platform-fee claims |
| `18-launch-builders.test.mjs` | TO01-TO05: the founder's launch and graduation on the website (`src/lplaunch.js`, `src/sol/lplaunch-ix.js`): every builder equals the SDK's (launch + first buy = `buildLaunch`, `claim_founder_fees`, `migration_damm_v2`, the leftover); then every transaction the routes build for the signed-in wallet is signed with the one-time keys a browser makes and run here through the Vicinity speed table (v0): the launch without and with a first buy (the exact quoted coins, the exact SOL change the page showed, the immutable metadata and its `/coin-meta` URI), graduation once the curve is full (any signed-in wallet pays) and the leftover, the founder's fees collected as SOL |
| `20-legacy-config.test.mjs` | TV01-TV02: the live mainnet price curve `EZVHCg…` (PoolConfig.version 0, made with DBC 0.2.1; a "legacy" config for DBC 0.2.2 and later) on the pinned build: its exact bytes (`test/fixtures/launchpad-worker/mainnet-pool-config.json`) differ from what `create_config` writes now only in the version byte, and a coin's whole life on it (launch, trades, refusals, harvest, fill, the keeper's graduation with the leftover and the surplus, the dev wallet's claims, DAMM v2 trades and position fees) equals the same life on a version-1 config to the unit. Run it at every Meteora re-pin |
| `21-fee-status.test.mjs` | TQ01-TQ07: the website's fee status (`src/feestatus.js`, `GET /api/fee-status`) read over this World: every figure equals the Coin record's counters as the program wrote them (SDK decoder), the founder vault, the holders pot, the curve's creator fee and the city's share of DBC's completion surplus (the SDK's split); the founder's part still in the curve is exactly what the next `harvest_curve_fees` books, and with the vault exactly what the founder's Collect (harvest + claim) pays; a gift to the vault is collected, never earned; the forward to the rewards vault; read when the curve is full and before any harvest, the curve fees and the surplus are exactly what the next harvest claims, split once; after graduation the city's DAMM v2 position, from the pool's and the position's bytes, is exactly what `harvest_pool_fees` claims (the dev wallet's position never counts); a position NFT given to the record lands in an account of the giver's choice (here the record's own associated account, not DAMM v2's NFT-account address), counts, and each `harvest_pool_fees` (through that account) moves exactly the Worker's figure; given while a reading is under way (between its listing of the record's accounts and its last answer), that reading withholds the estimate alone and the next one counts it; around the founder's Collect, on the curve and after graduation, the founder card's own rule (`public/lp-launch.js`) refuses the reading from before it against the status read after it and shows the one after it; the status's figures there are `src/lplaunch.js` `founderFees` itself, whose Coin-record counters (earned; collected = claimed + paid out) equal what the program wrote after the claim, both Collects and a payout; after graduation the card's "In your fee vault" row (there with or without a Collect button) is exactly what that Collect moved; a payout the founder agreed to (`payout_founder_fees`) is paid out and collected, never earned, and the reading from before it is refused by the collected counter even once the vault holds more again (the balances alone could not tell). `RECORD=1` writes `test/fixtures/launchpad-worker/fee-status.json`, which the root suite replays (`test/fee-status.test.js`) |

**Invariants.** `assertInvariants` (design section 15) runs after every
successful transaction in every test. So does `assertMoneyFlows` (invariant
8): it reads the token instructions that actually ran in the transaction, at
the top level and inside every CPI, and fails the test if money left a holders
pot, a founder vault or a Holders-only rewards vault for anywhere the design
does not allow, or if any of them was approved, re-assigned, burned, closed,
frozen or thawed. Every movement it sees is kept in `World.flows`.
`INVARIANTS=off` skips both for a quick run.

**Helpers for graduation.** `graduate(w, coin, cranker)` runs DBC's
permissionless migration with fresh position-NFT keys; `churn(w, coin)` makes
many small pseudo-random trades (which is what builds DBC's rounding surplus);
`completeCurve(w, coin)` fills the rest of the curve with one partial-fill buy.
`svmReader(w)` and `fakeConnection(w)` let the keeper and the snapshot tool
read the test VM, the second through the same web3.js `Connection` calls the
scripts make.

**Errors.** `expectFail(fn, ...codes)` accepts error names (ours, Anchor's or
Meteora's) and regular expressions over the logs. Where Anchor reports a
substitution through its own check before ours (it creates `init_if_needed`
accounts and loads every account first), the test lists both; what matters is
that the transaction is refused and no balance moves.

**The dev wallet.** `FEE_RECIPIENT` (`13qRam…`) is a program constant and the
tests have no key for it. `World.sendAsDevWallet` turns litesvm's signature
check off for that one transaction only; everything else is signature-checked.

**Config rules.** `World.cloneConfig(mutate)` copies a real DBC config account
and rewrites single fields in its raw bytes (offsets from the DBC IDL), which
is exactly what our on-chain check reads; DBC itself would refuse many of
these configs at `create_config`.

Numbers printed with `TD10_STORED`, `TD11`, `TG01`, `TG02`, `TG03`, `TG04` and
`TG08` are recorded in `LAUNCHPAD-AUDIT.md`.
