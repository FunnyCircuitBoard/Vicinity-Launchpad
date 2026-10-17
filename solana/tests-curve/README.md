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
transaction it checks that nothing moved but the fee. `VCURVE_INVARIANTS=off`
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
