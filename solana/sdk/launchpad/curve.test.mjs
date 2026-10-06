// SDK tests for curve.mjs (no chain): the 9.5 worked examples and the curve
// properties over thousands of random trades. tests-launchpad/04 checks the
// same mirror against the real DBC program to the raw unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteSwap, applySwap, curveQuoteAt, curveBaseSoldAt, feeOnAmount, includedFeeAmount, splitFees, SwapMode, Direction, CurveError } from './curve.mjs';
import { vicinityConfigParams } from './config.mjs';

const Q = 1n << 128n;
const SOL = 1_000_000_000n;
function defaultConfig(opts) {
  const p = vicinityConfigParams(opts);
  const B = (x) => BigInt(x.toString());
  const curve = p.curve.map((c) => ({ sqrtPrice: B(c.sqrt_price), liquidity: B(c.liquidity) }));
  while (curve.length < 20) curve.push({ sqrtPrice: 0n, liquidity: 0n });
  return {
    curve, sqrtStartPrice: B(p.sqrt_start_price), migrationSqrtPrice: curve[0].sqrtPrice,
    migrationQuoteThreshold: B(p.migration_quote_threshold), feeNumerator: B(p.pool_fees.base_fee.cliff_fee_numerator), creatorTradingFeePercentage: 50n,
  };
}
const start = (cfg) => ({ sqrtPrice: cfg.sqrtStartPrice, quoteReserve: 0n, baseReserve: 10n ** 15n });

test('the 9.5 worked examples (default config, curve at its start)', () => {
  const cfg = defaultConfig();
  const buy = quoteSwap(start(cfg), cfg, { direction: Direction.Buy, mode: SwapMode.ExactIn, amount0: SOL, hasReferral: true });
  assert.equal(buy.out, 34_193_903_663_504n);
  assert.deepEqual([buy.fee, buy.protocol, buy.referral, buy.partner, buy.creator], [12_500_000n, 2_000_000n, 500_000n, 5_000_000n, 5_000_000n]);
  const back = quoteSwap(applySwap(start(cfg), buy), cfg, { direction: Direction.Sell, mode: SwapMode.ExactIn, amount0: buy.out, hasReferral: true });
  assert.equal(back.grossOut, 987_499_999n);
  assert.equal(back.fee, 12_343_750n);
  assert.equal(back.out, 975_156_249n);
  const exactOut = quoteSwap(start(cfg), cfg, { direction: Direction.Buy, mode: SwapMode.ExactOut, amount0: 10_000_000_000_000n });
  assert.equal(exactOut.excludedIn, 282_221_366n);
  assert.equal(exactOut.includedIn, 285_793_789n);
  const fill = quoteSwap(start(cfg), cfg, { direction: Direction.Buy, mode: SwapMode.PartialFill, amount0: 1000n * SOL });
  assert.equal(fill.includedIn, 86_075_949_368n);
  assert.equal(fill.excludedIn, 85n * SOL);
  assert.equal(fill.out, 793_099_988_517_385n);
  assert.equal(fill.next, cfg.migrationSqrtPrice);
  // all fees up to graduation in one buy: 1.0759 SOL
  assert.equal(fill.fee, 1_075_949_368n);
  assert.deepEqual([fill.partner, fill.creator, fill.protocol], [430_379_748n, 430_379_747n, 215_189_873n]);
});

test('fee helpers: ceil on the way in, exact inverse, exact split', () => {
  for (const a of [1n, 2n, 79n, 80n, 81n, 10n ** 9n, 123_456_789_012n]) {
    const f = feeOnAmount(12_500_000n, a, true);
    assert.equal(f.fee, (a * 12_500_000n + 999_999_999n) / 1_000_000_000n);
    assert.equal(f.amount + f.fee, a);
    assert.equal(f.trading + f.protocol + f.referral, f.fee);
    const { included, fee } = includedFeeAmount(12_500_000n, f.amount);
    assert.ok(included >= f.amount && included - fee === f.amount);
  }
  assert.deepEqual(splitFees(100n, false), { trading: 80n, protocol: 20n, referral: 0n });
  assert.deepEqual(splitFees(100n, true), { trading: 80n, protocol: 16n, referral: 4n });
});

test('refusals match DBC: zero amount, beyond graduation for exact-in, completed curve', () => {
  const cfg = defaultConfig();
  assert.throws(() => quoteSwap(start(cfg), cfg, { direction: Direction.Buy, mode: SwapMode.ExactIn, amount0: 0n }), (e) => e.code === 'AmountIsZero');
  assert.throws(() => quoteSwap(start(cfg), cfg, { direction: Direction.Buy, mode: SwapMode.ExactIn, amount0: 100n * SOL }), (e) => e.code === 'InsufficientLiquidity');
  assert.throws(() => quoteSwap({ ...start(cfg), quoteReserve: cfg.migrationQuoteThreshold }, cfg, { direction: Direction.Buy, mode: SwapMode.ExactIn, amount0: 1n }), (e) => e.code === 'PoolIsCompleted');
  assert.throws(() => quoteSwap(start(cfg), cfg, { direction: Direction.Sell, mode: SwapMode.ExactIn, amount0: 10n ** 12n }), (e) => e instanceof CurveError);
});

function rng(seed) { let x = BigInt(seed); return () => { x ^= x << 13n; x &= (1n << 64n) - 1n; x ^= x >> 7n; x ^= x << 17n; x &= (1n << 64n) - 1n; return x; }; }

test('properties over 5,000 random trades: solvent, no free coins, rounding towards the pool, no profitable round trip', () => {
  for (const opts of [{}, { quoteDecimals: 6, migrationQuoteThreshold: 25_000_000 }]) {
    const cfg = defaultConfig(opts);
    const L = cfg.curve[0].liquidity;
    const next = rng(opts.quoteDecimals ?? 9);
    let pool = start(cfg);
    let held = 0n;
    let trades = 0;
    const unit = opts.quoteDecimals === 6 ? 1_000_000n : SOL;
    for (let i = 0; i < 5000 && pool.quoteReserve < cfg.migrationQuoteThreshold; i++) {
      const buy = held === 0n || next() % 3n !== 0n;
      const args = buy
        ? { direction: Direction.Buy, mode: next() % 4n === 0n ? SwapMode.ExactOut : SwapMode.ExactIn, amount0: buy && next() % 4n === 0n ? 1n + next() % (10n ** 13n) : 1n + next() % unit, hasReferral: next() % 2n === 0n }
        : { direction: Direction.Sell, mode: SwapMode.ExactIn, amount0: 1n + next() % held, hasReferral: next() % 2n === 0n };
      let q;
      try { q = quoteSwap(pool, cfg, args); } catch (e) { if (e instanceof CurveError) continue; throw e; }
      const s = pool.sqrtPrice;
      if (buy && args.mode === SwapMode.ExactIn) assert.ok(q.out * (s * (s * L + q.excludedIn * Q)) <= q.excludedIn * Q * L, 'buy rounds down');
      if (buy && args.mode === SwapMode.ExactOut) assert.ok(q.excludedIn * (Q * (L - q.out * s)) >= L * q.out * s * s, 'exact-out input rounds up');
      if (!buy) assert.ok(q.grossOut * (Q * (L + q.includedIn * s)) <= L * q.includedIn * s * s, 'sell rounds down');
      if (buy && q.out > 0n) {
        const after = applySwap(pool, q);
        const back = quoteSwap(after, cfg, { direction: Direction.Sell, mode: SwapMode.ExactIn, amount0: q.out });
        assert.ok(back.out < q.includedIn, 'a round trip never profits');
      }
      pool = applySwap(pool, q);
      held += buy ? q.out : -q.includedIn;
      trades++;
      assert.ok(pool.quoteReserve >= curveQuoteAt(cfg, pool.sqrtPrice), 'reserve covers the curve');
      assert.ok(10n ** 15n - pool.baseReserve <= curveBaseSoldAt(cfg, pool.sqrtPrice), 'no free coins');
      assert.ok(pool.sqrtPrice >= cfg.sqrtStartPrice && pool.sqrtPrice <= cfg.migrationSqrtPrice);
    }
    assert.ok(trades > 1000, `${trades} trades`);
  }
});
