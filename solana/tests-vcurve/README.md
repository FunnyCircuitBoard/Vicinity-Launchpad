# vicinity_curve tests (in process, no validator)

```
npm run vcurve:sbf           # builds target/vcurve-builds/{production,devnet,halt-all}/vicinity_curve.so
npm run launchpad:fixtures   # once: the Metaplex dump (also used by tests-launchpad)
npm run test:vcurve          # every *.test.mjs here
```

`00-smoke.test.mjs` (stage 2) runs one coin's life on the production build in
litesvm with default config #0: `init_launchpad` (the test deployer is the
upgrade authority), `add_launch_config`, `approve_launch` (the old program's
`Launchpad` is a crafted 171-byte account with launches paused), `launch`, the
worked examples E1 to E3 of VICINITY-CURVE-DESIGN.md 5.14 to the lamport and
raw unit, a pool buy, a buyback and its no-op, `withdraw_platform_fees`,
`claim_founder_fees`, `forward_holders_fees` with a top-level `SyncNative`
(crafted `vicinity_rewards` CityConfig and WSOL vault), the opted-in payout
and its cooldown, the guardian halt (buys refuse, sells and claims work, only
the admin clears), then the halt-all build deployed over the live coin (all
eight outflow instructions refuse with `TradingHalted`, the `Coin` is
unchanged) and the production build deployed back. After every outflow it
checks that the `Coin` holds exactly `rent_reserve` plus its liabilities (I9).
`VCURVE_VERBOSE=1` prints compute units per step.

The litesvm suites of the design's section 12 (L01 to L13, X01 to X65, H01 to
H03, R01 to R03, G02, C01) are stage 3.
