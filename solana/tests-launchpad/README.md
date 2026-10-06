# Launchpad tests (in process, no validator)

```
npm run launchpad:fixtures   # once: dumps Meteora DBC, DAMM v2 and Metaplex from mainnet, checks pinned SHA-256
anchor build                 # the tests load target/deploy/vicinity_launchpad.so and vicinity_rewards.so
npm run test:launchpad       # every *.test.mjs here, about 15 seconds
npm run sdk-test:launchpad   # sdk/launchpad/*.test.mjs (no chain)
```

Each test builds its own `World` (`helpers.mjs`): one litesvm instance with our
program and `vicinity_rewards` loaded through the upgradeable loader (the test
`deployer` key is their upgrade authority, so `init_launchpad` and
`init_registry` are exercised for real), the three mainnet dumps, the WSOL
mint, the DAMM v2 customizable config (`fixtures/accounts/`), DBC's pool
authority funded for graduation's flash rent, and the clock at real time. No
ports are opened and nothing touches the network.

| file | design section 17 ids |
|---|---|
| `01-admin.test.mjs` | TA01-TA07 |
| `02-configs.test.mjs` | TB01-TB16 |
| `03-launch.test.mjs` | TC01-TC11 |
| `04-trading.test.mjs` | TD01-TD11 (TD11: random trades, `PROP_SEED` and `PROP_STEPS` env) |
| `05-fees-rewards.test.mjs` | TE01-TE09 |
| `06-founder-payout.test.mjs` | TF01-TF11 |
| `07-graduation.test.mjs` | TG01-TG08 |
| `08-attacks.test.mjs` | TH01-TH12 |
| `09-graduation-defences.test.mjs` | TG09-TG14 (surplus, pre-funded addresses, atomic graduation, nothing twice, nothing left behind) |
| `10-keeper.test.mjs` | TI01-TI06 (the keeper of `scripts/launchpad/crank.mjs`) |
| `11-holders-pot.test.mjs` | TE10-TE13 (where the holders' money can go, end to end to each holder's claim) |

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
