// LIVE, read-only checks against Jupiter's mainnet API (no key, nothing signed
// or sent). Skipped unless JUPITER_LIVE=1, because CI must not depend on a
// third-party service:
//   JUPITER_LIVE=1 node --test sdk/launchpad/jupiter.live.test.mts
//   (npm run test:jupiter-live)
// 1. A price quote into SOL for three pay-with assets: BTC (cbBTC), ETH
//    (Wormhole) and a tokenized stock (SPYx).
// 2. Pay with cbBTC for a hypothetical SOL-priced Vicinity coin, planned the
//    way the website does it (live /swap/v2/build at route sizes 40, 32, 24
//    with the Vicinity lookup table): every transaction must fit 1,232 bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJupiterQuote, planPayWithAnything } from './jupiter.mts';
import { launchpadLookupTableAddresses, lookupTableFrom } from './lookup-table.mts';
import { payAsset, WSOL_MINT } from './pay-assets.mts';
import { dbc, pdas } from './pda.mjs';
import { MAX_TX_BYTES } from './trade.mts';
import { vicinityConfigParams } from './config.mjs';
import type { CurveLike } from './quote.mts';

// a fresh coin on the default Vicinity curve (nothing is read from chain)
const big = (x: { toString(): string }) => BigInt(x.toString());
const P0 = vicinityConfigParams();
const CURVE = P0.curve.map((c: { sqrt_price: unknown; liquidity: unknown }) => ({ sqrtPrice: big(c.sqrt_price as bigint), liquidity: big(c.liquidity as bigint) }));
const CFG: CurveLike = { curve: CURVE, sqrtStartPrice: big(P0.sqrt_start_price), migrationSqrtPrice: CURVE[0].sqrtPrice, migrationQuoteThreshold: big(P0.migration_quote_threshold), feeNumerator: big(P0.pool_fees.base_fee.cliff_fee_numerator), creatorTradingFeePercentage: 50n };
const START = { sqrtPrice: CFG.sqrtStartPrice, quoteReserve: 0n, baseReserve: 10n ** 15n, isMigrated: 0 };

const live = process.env.JUPITER_LIVE === '1';
const apiKey = process.env.JUPITER_API_KEY || undefined;
const TAKER = '9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa'; // a public address; nothing is signed

const CASES: [string, bigint][] = [['cbBTC', 100_000n], ['ETH', 1_000_000n], ['SPYx', 10_000_000n]];
for (const [symbol, amount] of CASES) {
  test(`live quote: ${symbol} -> SOL`, { skip: !live && 'set JUPITER_LIVE=1' }, async () => {
    const a = payAsset(symbol);
    const q = await fetchJupiterQuote({ inputMint: a.mint, outputMint: WSOL_MINT, amount, slippageBps: 100, maxAccounts: 40 }, { apiKey });
    assert.equal(q.inputMint, a.mint);
    assert.equal(q.outputMint, WSOL_MINT);
    assert.equal(q.swapMode, 'ExactIn');
    const out = BigInt(q.outAmount), min = BigInt(q.otherAmountThreshold);
    assert.ok(out > 0n && min > 0n && min <= out);
    console.log(`${symbol}: ${amount} raw -> ${out} lamports (minimum ${min}), impact ${q.priceImpactPct}, route ${q.routePlan.map((r) => r.swapInfo.label).join(' > ')}`);
  });
}

test('live: pay with cbBTC for a SOL-priced coin, planned as the website does (route sizes 40, 32, 24)', { skip: !live && 'set JUPITER_LIVE=1' }, async () => {
  const P = pdas();
  const mint = P.coin(777001n), dbcConfig = P.coin(777002n);
  const coin = { mint, quoteMint: WSOL_MINT, dbcConfig, dbcPool: dbc.pool(dbcConfig, mint, WSOL_MINT) };
  const lut = lookupTableFrom('7UbiauZFTRXXy8zGMNYsZDPGu1NsDJTNVp7xX7sBQd6c', launchpadLookupTableAddresses({ dbcConfigs: [dbcConfig] }));
  const r = await planPayWithAnything({ payMint: payAsset('cbBTC').mint, amount: 100_000n, trader: TAKER, coin, pool: START, config: CFG, slippageBps: 100, lookupTables: [lut], apiKey });
  console.log(`live cbBTC -> SOL -> coin: tried ${JSON.stringify(r.tried)}; chosen ${r.plan?.mode} (${r.plan?.transactions.map((t) => t.bytes).join(' + ')} bytes), route ${r.plan?.route}`);
  assert.ok(r.plan, 'Jupiter found a route');
  for (const t of r.plan.transactions) assert.ok(t.bytes <= MAX_TX_BYTES, `${t.label} ${t.bytes} bytes`);
  assert.equal(r.plan.buyAmountIn > 0n, true);
});
