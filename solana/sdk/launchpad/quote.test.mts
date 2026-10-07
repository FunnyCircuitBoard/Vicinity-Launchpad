// quote.mts on its own (no chain): the design 9.5 numbers, slippage bounds,
// the harvest split and the display helpers. Parity with the real programs is
// tested in tests-launchpad/12-client-sdk.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vicinityConfigParams } from './config.mjs';
import {
  quoteBuy, quoteBuyExactOut, quoteSell, quoteSellExactOut, quoteCoinToCoin, quoteFillCurve, splitHarvest,
  minOutWithSlippage, maxInWithSlippage, priceInQuote, marketCapRaw, curveProgressBps, feeBpsOf, CurveError,
} from './quote.mts';
import type { CurveLike, PoolLike } from './quote.mts';

const SOL = 1_000_000_000n;
const big = (x: { toString(): string }) => BigInt(x.toString());
function defaultCurve(): CurveLike {
  const p = vicinityConfigParams();
  const curve = p.curve.map((c: { sqrt_price: unknown; liquidity: unknown }) => ({ sqrtPrice: big(c.sqrt_price as bigint), liquidity: big(c.liquidity as bigint) }));
  return {
    curve, sqrtStartPrice: big(p.sqrt_start_price), migrationSqrtPrice: curve[0].sqrtPrice,
    migrationQuoteThreshold: big(p.migration_quote_threshold), feeNumerator: big(p.pool_fees.base_fee.cliff_fee_numerator), creatorTradingFeePercentage: 50n,
  };
}
const cfg = defaultCurve();
const start: PoolLike = { sqrtPrice: cfg.sqrtStartPrice, quoteReserve: 0n, baseReserve: 10n ** 15n };

test('design 9.5: 1 SOL buys 34,193,903.663504 coins; the fee splits Meteora 0.002 / referral 0.0005 / dev wallet 0.005 / city 0.005', () => {
  const q = quoteBuy(start, cfg, { amountIn: SOL, slippageBps: 100 });
  assert.equal(q.mode, 0);
  assert.equal(q.amountOut, 34_193_903_663_504n);
  assert.equal(q.amount1, 33_851_964_626_868n, 'minimum out at 1% slippage (design 9.5)');
  assert.deepEqual([q.fees.total, q.fees.meteora, q.fees.referral, q.fees.devWallet, q.fees.city], [12_500_000n, 2_000_000n, 500_000n, 5_000_000n, 5_000_000n]);
  assert.deepEqual([q.fees.holders, q.fees.founder], [2_500_000n, 2_500_000n]);
  assert.ok(q.priceImpactBps > 300 && q.priceImpactBps < 340, `impact ${q.priceImpactBps} bps (design: 3.3%)`);
  // selling them straight back returns 0.975156249 SOL
  const s = quoteSell(q.poolAfter, cfg, { amountIn: q.amountOut });
  assert.equal(s.amountOut, 975_156_249n);
  // without the referral, Meteora keeps its whole 0.0025
  const n = quoteBuy(start, cfg, { amountIn: SOL, referral: false });
  assert.deepEqual([n.fees.meteora, n.fees.referral], [2_500_000n, 0n]);
});

test('design 9.5: exactly 10,000,000 coins cost 0.285793789 SOL; the maximum in carries the slippage, rounded up', () => {
  const q = quoteBuyExactOut(start, cfg, { amountOut: 10_000_000_000_000n, slippageBps: 100 });
  assert.equal(q.amountIn, 285_793_789n);
  assert.equal(q.amount1, maxInWithSlippage(285_793_789n, 100));
  assert.equal(q.amount1, 288_651_727n);
});

test('design 9.5: filling the whole curve costs 86.075949368 SOL for 793,099,988.517385 coins (partial fill)', () => {
  const q = quoteFillCurve(start, cfg);
  assert.equal(q.mode, 1);
  assert.equal(q.amountIn, 86_075_949_368n);
  assert.equal(q.amountOut, 793_099_988_517_385n);
  assert.equal(q.completesCurve, true);
  assert.equal(curveProgressBps(q.poolAfter, cfg), 10_000);
  // a too-large exact-in buy becomes a partial fill with the rest refunded
  const big2 = quoteBuy(start, cfg, { amountIn: 200n * SOL });
  assert.equal(big2.mode, 1);
  assert.equal(big2.refund, 200n * SOL - 86_075_949_368n);
  assert.throws(() => quoteBuy(q.poolAfter, cfg, { amountIn: SOL }), (e: unknown) => e instanceof CurveError && /PoolIsCompleted/.test((e as Error).message));
});

test('a trade that would return nothing is refused before it is built (review nit N6: DBC accepts a 1-lamport buy for 0 coins)', () => {
  assert.throws(() => quoteBuy(start, cfg, { amountIn: 1n }), (e: unknown) => e instanceof CurveError && /return nothing/.test((e as Error).message));
  const q = quoteBuy(start, cfg, { amountIn: SOL });
  assert.throws(() => quoteSell(q.poolAfter, cfg, { amountIn: 1n }), /return nothing/);
  // the smallest buy that returns a coin unit is quoted normally
  let n = 1n;
  for (;;) { try { quoteBuy(start, cfg, { amountIn: n }); break; } catch { n += 1n; } }
  assert.ok(n > 1n && n < 1_000n, `smallest buy ${n} lamports`);
  assert.ok(quoteBuy(start, cfg, { amountIn: n }).amountOut > 0n);
});

test('sells: exact in and exact out agree with each other', () => {
  const b = quoteBuy(start, cfg, { amountIn: 10n * SOL });
  const s = quoteSell(b.poolAfter, cfg, { amountIn: b.amountOut / 3n });
  const e = quoteSellExactOut(b.poolAfter, cfg, { amountOut: s.amountOut, slippageBps: 0 });
  assert.ok(e.amountIn <= b.amountOut / 3n, 'getting the same SOL out never needs more coins than the exact-in sell gave');
  // and at most one lamport's worth of coins fewer (about 36,000 raw units at this price)
  assert.ok(e.amountIn >= b.amountOut / 3n - 40_000n, `${e.amountIn} vs ${b.amountOut / 3n}`);
});

test('slippage helpers round in the pool\'s favour and refuse nonsense', () => {
  assert.equal(minOutWithSlippage(1_000_001n, 100), 990_000n);
  assert.equal(maxInWithSlippage(1_000_001n, 100), 1_010_002n);
  assert.equal(minOutWithSlippage(5n, 0), 5n);
  for (const bad of [-1, 5_001, 1.5]) assert.throws(() => minOutWithSlippage(1n, bad), RangeError);
});

test('splitHarvest is the program\'s split: founder floor(c/2), holders the rest', () => {
  let x = 0x9e3779b97f4a7c15n;
  for (let i = 0; i < 20_000; i++) {
    x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    const c = i < 10 ? BigInt(i) : x;
    const { toHolders, toFounder } = splitHarvest(c);
    assert.equal(toHolders + toFounder, c);
    assert.equal(toFounder, c / 2n);
    assert.ok(toHolders - toFounder === 0n || toHolders - toFounder === 1n);
  }
  assert.deepEqual(splitHarvest(1_001n), { toHolders: 501n, toFounder: 500n }, 'test TE03');
});

test('coin to coin: the buy spends exactly the sell\'s guaranteed minimum', () => {
  const a = quoteBuy(start, cfg, { amountIn: 5n * SOL });
  const b = quoteBuy(start, cfg, { amountIn: 2n * SOL });
  const q = quoteCoinToCoin({ pool: a.poolAfter, config: cfg }, { pool: b.poolAfter, config: cfg }, { amountIn: a.amountOut, slippageBps: 100 });
  assert.equal(q.buy.amountIn, q.quoteMin);
  assert.equal(q.quoteMin, q.sell.minOut);
  assert.ok(q.quoteMin < q.sell.amountOut);
  assert.equal(q.minOut, q.buy.minOut);
});

test('display helpers: start price 2.7959e-8 SOL, start market cap about 27.96 SOL, fee 1.25%', () => {
  const p = priceInQuote(cfg.sqrtStartPrice, 9);
  assert.ok(Math.abs(p - 2.7959e-8) / 2.7959e-8 < 1e-3, `price ${p}`);
  const mc = Number(marketCapRaw(cfg.sqrtStartPrice)) / 1e9;
  assert.ok(Math.abs(mc - 27.96) < 0.05, `market cap ${mc}`);
  const end = Number(marketCapRaw(cfg.migrationSqrtPrice)) / 1e9;
  assert.ok(Math.abs(end - 410.83) < 0.5, `end market cap ${end}`);
  assert.equal(feeBpsOf(cfg), 125);
  assert.equal(curveProgressBps({ sqrtPrice: 0n, quoteReserve: 42_500_000_000n }, cfg), 5_000);
});
