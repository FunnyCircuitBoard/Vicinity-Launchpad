# `sdk/curve`: client SDK of `vicinity_curve`

Plain ESM (`.mjs`), BigInt amounts, no Anchor at run time. It follows
`VICINITY-CURVE-DESIGN.md` 14.1 (the design calls the directory `sdk/vcurve/`; see
`VICINITY-CURVE-NOTES.md` entry 28).

| file | what |
|---|---|
| `constants.mjs` | program id, the compiled ids of each cluster build (3.2), policy constants, account sizes, every instruction, account and event discriminator, the error codes of 4.22 |
| `pda.mjs` | `curvePdas({ programId, cluster })`: launchpad, config, approval, coin, mint, coin vault, ticker, payout opt-in, event authority, ProgramData, the old program's coin, approval and launchpad, the city's `vicinity_rewards` config and vault; `metadataAddress`, `associatedTokenAddress`, `metadataUri` |
| `math.mjs` | BigInt port of `crates/vicinity-curve-math`: `feeSplit`, `grossFor`, `curveValue`, `tokensFor`, `quoteBuy`, `quoteSell`, `quoteBuyback`, `maxQuoteIn`, `spotPrice`, `depth`, `buybackCap`, `liabilities`, `launchDust`, `validateConfig` (with `v8Sides`, `v11Sides`), `deriveCurve`; the same checks, rounding and errors; client helpers `withSlippage`, `cheapestAttackerCostBps`, `buybackRunMarginBps`, `sandwichCostBps`, `sandwichDepth` and `sandwichThreshold` (5.15; reviews MATH3-1, R4-DIFF-3, SDK4-4) |
| `accounts.mjs` | fixed-offset decoders of `Launchpad`, `LaunchConfig`, `Approval`, `CurveCoin`, `TickerLock`, `PayoutOptIn`, each checking the program owner, the length and the discriminator (`CurveCoin` also the layout version and phase); `coinTerms` / `coinState` feed the math; the `vicinity_rewards` CityConfig reader and the program's two rules for the holders' destination |
| `events.mjs` | decoders of the 21 events. Indexers use `decodeTransactionEvents(tx)` on what getTransaction returns: nothing from a failed transaction (its metadata still carries genuine event CPIs of trades that never happened), event CPIs only from an inner instruction whose enclosing call is `vicinity_curve` with the event authority as its only account, `emit!` events only from `vicinity_curve`'s log lines (4.21, T56). `decodeEventCpi` and `decodeEventLogs` check one instruction or one log list only |
| `instructions.mjs` | builders for all 21 instructions with the fixed account lists of section 4 written out, `forwardHoldersFeesWithSync` (the top-level `SyncNative` of 4.15), `syncNative`, the idempotent associated-token-account create and compute-budget instructions |
| `prechecks.mjs` | the client pre-checks of 14.3 (T58) on account snapshots, each failing with a `PrecheckError` that says why: the buyer is a system-owned account without data that can pay (`precheckBuyer`, `precheckBuy`; it also refuses a buy that would leave a rent-exempt wallet below the rent-exempt minimum), and SOL to an account holding 0 lamports is at least `rent_min(0)` (`precheckSolCredit`, `precheckSell`, `precheckClaim`, `precheckPayout`) |
| `rewards.mjs` | the city's `vicinity_rewards` config: `initCityInstruction` (init_city, Holders / 0 / WSOL by default) and `initRewardsForCoin`, which simulates init_city, decodes the CityConfig it would write and runs `check_rewards_config` and the authority rule on it before proposing anything (4.15, R03, 14.1); lamports someone sent to the config address are no config (init_city creates over them, T55); an existing correct config needs nothing, one whose only problem is its authority is fixable (`AuthorityNotAdmin`: propose_authority / accept_authority), one with wrong economics is not (`ExistsWrong`, O26); `simulateWithConnection` adapts a web3.js Connection |
| `compose.mjs` | the buy and sell legs and "pay with any token" (14.1, 14.3, G03): `buyLeg` quotes the buy on the coin's snapshot, caps `sol_in` at `max_quote_in` (max(the charge, `MIN_TRADE_LAMPORTS`), 5.4) when the buy completes the curve (reviews R3-CLI-1, R4-DIFF-1: within about 97,500 lamports of graduation the capped buy offers `MIN_TRADE_LAMPORTS` and takes the last raw units) and gives its `min_tokens_out` (`minTokensOut`, or `slippageBps` up to 500, at least 1; without one it throws, since a buy without a minimum can be sandwiched); `sellLeg` gives a sell's `min_sol_out` the same way (review R4-DIFF-5); the slippage depends on the size (reviews MATH3-1, R4-DIFF-5): up to 5% for a trade (a buy's charge, a sell's gross) at or below the coin's `sandwichThreshold` (math.mjs: `(t - max(b_F + b_H, b_P) - 2t/C)/D` of `min(x0 + curve_sol, graduation_sol)` on the curve, of `pool_sol` in the pool), at most 0.3% above it, for a minimum given or derived; `buySlippagePolicy` and `sellSlippagePolicy` give the default (1%, or 0.3% above the threshold); splitting is no defence (review R4-DIFF-2), and a piece of a larger order is judged by the order's total (`orderSolIn`, `orderGross`); `buyLegMinimum` refuses an uncapped `sol_in`; `solInFromSwapQuote` (native SOL out only, review SDK4-5; ExactOut: `outAmount`; ExactIn: `otherAmountThreshold`, never the quoted `outAmount`) and `buyWithSwap`, the swap instructions followed by the idempotent token account create and the buy of `buyLeg` |
| `g01-vectors.mjs` | the reader of the Rust crate's G01 vectors (`reference/g01-vectors.json`): line parser, config of each life, the state digest |

Instructions come back in `@solana/kit`'s shape `{ programAddress, accounts: [{ address, role }], data }`.

```js
import { curveInstructions, decodeCurveCoin, coinTerms, coinState, quoteBuy, buyLeg, buySlippagePolicy, sellLeg, sellSlippagePolicy } from './sdk/curve/index.mjs';
const ix = curveInstructions({ programId, cluster: 'mainnet' });
const coin = decodeCurveCoin(await getAccount(ix.pdas.coin(cityId)), { programId });
const q = quoteBuy(coinTerms(coin), coinState(coin), 1_000_000_000n);       // q.charged, q.tokensOut, q.graduates, ...
// the slippage the buy may allow: 1% up to the coin's sandwich threshold, 0.3% above it (5.15; buyLeg refuses more)
const policy = buySlippagePolicy(coin, 1_000_000_000n);
// the buy leg: sol_in capped at max_quote_in when the buy completes the curve (never offer more than the
// partial quote priced: if another buy graduates the coin first, the rest would be charged in the pool)
const leg = buyLeg({ solIn: 1_000_000_000n, coinAccount: coin, slippageBps: policy.defaultSlippageBps });
const buy = ix.buy({ user, cityId, solIn: leg.solIn, minTokensOut: leg.minTokensOut });
// a sell: the same rule on its gross
const out = sellLeg({ tokensIn, coinAccount: coin, slippageBps: sellSlippagePolicy(coin, tokensIn).defaultSlippageBps });
const sell = ix.sell({ user, cityId, tokensIn, minSolOut: out.minSolOut });
```

Pay with any token (a Jupiter quote to native SOL with `wrapAndUnwrapSol`; the buy leg's minimum from the coin as read before signing):

```js
const swapSolIn = solInFromSwapQuote(quote); // refuses a quote whose outputMint is not native SOL
const { instructions, solIn, minTokensOut } = buyWithSwap({ ix, user, coin: ix.pdas.coin(cityId), mint: coin.mint,
  swapInstructions, quote, coinAccount: coin, slippageBps: buySlippagePolicy(coin, swapSolIn).defaultSlippageBps }); // solIn <= swapSolIn; the rest stays in the wallet
```

Pre-checks and the rewards config before sending:

```js
import { precheckBuy, initRewardsForCoin, simulateWithConnection } from './sdk/curve/index.mjs';
const rent0 = BigInt(await connection.getMinimumBalanceForRentExemption(0));
const q = precheckBuy({ coin, userAccount: await getAccount(user), solIn, firstBuyRent: ataRent, rentExemptMinimum: rent0 }); // throws PrecheckError
const { instructions } = await initRewardsForCoin({ getAccount, simulate: simulateWithConnection(connection, { feePayer }),
  payer: feePayer, registryAdmin: squadsVault, authority: squadsVault, coin }); // RewardsConfigError: nothing to propose
```

Tests (`npm run sdk-test:curve`): `math.test.mjs` replays the math crate's golden vectors
(`crates/vicinity-curve-math/reference/vectors.json`, from the reference model of Appendix A)
and requires every quote, error and state figure to be equal, and checks the worked examples
E1 to E10; `idl.test.mjs` checks every constant, discriminator and error against the committed
IDL, every builder's account list, flags and argument encoding against the IDL and Anchor's
encoder, and the account and event decoders against Anchor's encoding; `events.test.mjs` checks
`decodeTransactionEvents` over the RPC's shapes (failed transactions, the caller rule, logs);
`prechecks.test.mjs` checks every pre-check and its edges and `compose.mjs` (no buy or sell without a minimum, the completing buy's cap, the size rule), the init_city builder against Anchor's encoder and the committed
`vicinity_rewards` IDL, and `initRewardsForCoin` over a fake chain (`tests-curve/21-sdk-prechecks.test.mjs`
checks the same predictions against the real programs in litesvm); `g01.test.mjs` replays every operation of the
G01 vectors exported by the Rust crate (more than 10^4 trades; `tests-curve/22-g01-onchain.test.mjs` replays them on chain). The parity with the
program's real results is checked by `tests-curve` after every trade and buyback of every test.
