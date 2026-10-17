# `sdk/curve`: client SDK of `vicinity_curve`

Plain ESM (`.mjs`), BigInt amounts, no Anchor at run time. It follows
`VICINITY-CURVE-DESIGN.md` 14.1 (the design calls the directory `sdk/vcurve/`; see
`VICINITY-CURVE-NOTES.md` entry 28).

| file | what |
|---|---|
| `constants.mjs` | program id, the compiled ids of each cluster build (3.2), policy constants, account sizes, every instruction, account and event discriminator, the error codes of 4.22 |
| `pda.mjs` | `curvePdas({ programId, cluster })`: launchpad, config, approval, coin, mint, coin vault, ticker, payout opt-in, event authority, ProgramData, the old program's coin, approval and launchpad, the city's `vicinity_rewards` config and vault; `metadataAddress`, `associatedTokenAddress`, `metadataUri` |
| `math.mjs` | BigInt port of `crates/vicinity-curve-math`: `feeSplit`, `grossFor`, `curveValue`, `tokensFor`, `quoteBuy`, `quoteSell`, `quoteBuyback`, `maxQuoteIn`, `spotPrice`, `depth`, `buybackCap`, `liabilities`, `launchDust`, `validateConfig` (with `v8Sides`, `v11Sides`), `deriveCurve`; the same checks, rounding and errors |
| `accounts.mjs` | fixed-offset decoders of `Launchpad`, `LaunchConfig`, `Approval`, `CurveCoin`, `TickerLock`, `PayoutOptIn`, each checking the program owner, the length and the discriminator (`CurveCoin` also the layout version and phase); `coinTerms` / `coinState` feed the math; the `vicinity_rewards` CityConfig reader and the program's two rules for the holders' destination |
| `events.mjs` | decoders of the 21 events: event CPIs (only from `vicinity_curve` with the event authority as their account) and `emit!` log lines |
| `instructions.mjs` | builders for all 21 instructions with the fixed account lists of section 4 written out, `forwardHoldersFeesWithSync` (the top-level `SyncNative` of 4.15), `syncNative`, the idempotent associated-token-account create and compute-budget instructions |

Instructions come back in `@solana/kit`'s shape `{ programAddress, accounts: [{ address, role }], data }`.

```js
import { curveInstructions, decodeCurveCoin, coinTerms, coinState, quoteBuy, withSlippage } from './sdk/curve/index.mjs';
const ix = curveInstructions({ programId, cluster: 'mainnet' });
const coin = decodeCurveCoin(await getAccount(ix.pdas.coin(cityId)), { programId });
const q = quoteBuy(coinTerms(coin), coinState(coin), 1_000_000_000n);       // q.charged, q.tokensOut, q.graduates, ...
const buy = ix.buy({ user, cityId, solIn: 1_000_000_000n, minTokensOut: withSlippage(q.tokensOut, 100) });
```

Tests (`npm run sdk-test:curve`): `math.test.mjs` replays the math crate's golden vectors
(`crates/vicinity-curve-math/reference/vectors.json`, from the reference model of Appendix A)
and requires every quote, error and state figure to be equal, and checks the worked examples
E1 to E10; `idl.test.mjs` checks every constant, discriminator and error against the committed
IDL, every builder's account list, flags and argument encoding against the IDL and Anchor's
encoder, and the account and event decoders against Anchor's encoding. The parity with the
program's real results is checked by `tests-curve` after every trade and buyback of every test.
