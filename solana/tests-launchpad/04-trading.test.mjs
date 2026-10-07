// TD01-TD11: trading runs on Meteora DBC (our program is not involved); the SDK
// builds the swaps and quotes them with sdk/launchpad/curve.mjs. These tests
// pin DBC's behaviour to the raw unit and check the curve invariants after
// every trade, so a vendor change is caught.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { World, C, ADDRESSES, SUPPLY, LAMPORTS, expectFail, assertInvariants, ata, dbc } from './helpers.mjs';
import { quoteSwap, applySwap, curveQuoteAt, curveBaseSoldAt, SwapMode, Direction, CurveError } from '../sdk/launchpad/curve.mjs';
import { vicinityConfigParams } from '../sdk/launchpad/config.mjs';

const Q128 = 1n << 128n;
const WSOL = ADDRESSES.wsol;

function poolSnap(w, coin) {
  const p = w.pool(coin.dbcPool);
  return { ...p, sqrtPrice: p.sqrtPrice, quoteReserve: p.quoteReserve, baseReserve: p.baseReserve };
}
function mirror(w, coin, args) {
  return quoteSwap(poolSnap(w, coin), w.curveConfig(coin.dbcConfig), args);
}

describe('04 trading (SDK against the real DBC)', () => {
  let w, coin, coin2, trader, referral;
  before(async () => {
    w = await World.create();
    coin = await w.launchCoin({ cityId: 900001n, name: 'Demo City', symbol: 'DEMO' });
    coin2 = await w.launchCoin({ cityId: 900002n, name: 'Demo Town', symbol: 'DEMOT' });
    trader = await w.signer();
    referral = w.emptyTokenAccount(ADDRESSES.feeRecipient, WSOL); // the dev wallet's WSOL account
  });

  it('TD01 + TD02: a 1 SOL exact-in buy gives the 9.5 numbers to the unit, and the fee split is exact', async () => {
    const q = mirror(w, coin, { direction: Direction.Buy, mode: SwapMode.ExactIn, amount0: LAMPORTS, hasReferral: true });
    assert.equal(q.out, 34_193_903_663_504n);
    const before = w.pool(coin.dbcPool);
    await w.trade(trader, coin, { side: 'buy', amount0: LAMPORTS, amount1: (q.out * 99n) / 100n, referral });
    assert.equal(w.balance(ata(trader.address, coin.mint)), 34_193_903_663_504n);
    const after = w.pool(coin.dbcPool);
    assert.equal(after.protocolQuoteFee - before.protocolQuoteFee, 2_000_000n); // Meteora 0.2%
    assert.equal(w.balance(referral), 500_000n); // referral 0.05% to the dev wallet
    assert.equal(after.partnerQuoteFee - before.partnerQuoteFee, 5_000_000n); // dev wallet 0.5%
    assert.equal(after.creatorQuoteFee - before.creatorQuoteFee, 5_000_000n); // city 0.5%
    assert.equal(after.quoteReserve - before.quoteReserve, 987_500_000n);
    assert.equal(after.sqrtPrice, q.next);
    assertInvariants(w);
  });

  it('TD03 selling those coins straight back returns 0.975156249 SOL', async () => {
    const coins = w.balance(ata(trader.address, coin.mint));
    const q = mirror(w, coin, { direction: Direction.Sell, mode: SwapMode.ExactIn, amount0: coins, hasReferral: true });
    assert.equal(q.out, 975_156_249n);
    const wsolBefore = w.balance(ata(trader.address, WSOL));
    await w.trade(trader, coin, { side: 'sell', amount0: coins, amount1: q.out, referral, fund: false });
    assert.equal(w.balance(ata(trader.address, WSOL)) - wsolBefore, 975_156_249n);
    assert.equal(w.balance(ata(trader.address, coin.mint)), 0n);
    assertInvariants(w);
  });

  it('TD04 an exact-out buy of 10,000,000 coins costs 0.285793789 SOL; a lower maximum is refused', async () => {
    const t = await w.signer();
    const out = 10_000_000_000_000n;
    const q = mirror(w, coin2, { direction: Direction.Buy, mode: SwapMode.ExactOut, amount0: out, hasReferral: true });
    assert.equal(q.includedIn, 285_793_789n);
    assert.equal(q.excludedIn, 282_221_366n);
    await expectFail(() => w.trade(t, coin2, { side: 'buy', mode: SwapMode.ExactOut, amount0: out, amount1: q.includedIn - 1n, referral }), 'ExceededSlippage');
    w.fundToken(t.address, WSOL, 1n); // now exactly includedIn
    const before = w.balance(ata(t.address, WSOL));
    assert.equal(before, q.includedIn);
    await w.trade(t, coin2, { side: 'buy', mode: SwapMode.ExactOut, amount0: out, amount1: q.includedIn, referral, fund: false });
    assert.equal(w.balance(ata(t.address, coin2.mint)), out);
    assert.equal(before - w.balance(ata(t.address, WSOL)), 285_793_789n);
    assertInvariants(w);
  });

  it('TD05 a missed minimum out and a zero amount are refused', async () => {
    const t = await w.signer();
    const q = mirror(w, coin, { direction: Direction.Buy, mode: SwapMode.ExactIn, amount0: LAMPORTS });
    await expectFail(() => w.trade(t, coin, { side: 'buy', amount0: LAMPORTS, amount1: q.out + 1n }), 'ExceededSlippage');
    await expectFail(() => w.trade(t, coin, { side: 'buy', amount0: 0n, amount1: 0n }), 'AmountIsZero');
    await expectFail(() => w.trade(t, coin, { side: 'sell', amount0: 0n, amount1: 0n, fund: false }), 'AmountIsZero');
    assertInvariants(w);
  });

  it('TD06 coin to coin in one transaction; if the second leg misses its minimum, everything reverts', async () => {
    const t = await w.signer();
    await w.trade(t, coin, { side: 'buy', amount0: 2n * LAMPORTS, amount1: 1n });
    const aBal = w.balance(ata(t.address, coin.mint));
    const sellAmt = aBal / 2n;
    const qa = mirror(w, coin, { direction: Direction.Sell, mode: SwapMode.ExactIn, amount0: sellAmt });
    const quoteMin = (qa.out * 995n) / 1000n;
    const qb = mirror(w, coin2, { direction: Direction.Buy, mode: SwapMode.ExactIn, amount0: quoteMin });
    w.emptyTokenAccount(t.address, coin2.mint);
    const wsolBefore = w.balance(ata(t.address, WSOL));
    // B's minimum one unit too high: the whole transaction fails, A is untouched
    await expectFail(() => w.send(C.coinToCoin({ trader: t.address, from: coin, to: coin2, amountIn: sellAmt, quoteMin, minOut: qb.out + 1n }), [t], 'coin to coin'), 'ExceededSlippage');
    assert.equal(w.balance(ata(t.address, coin.mint)), aBal);
    assert.equal(w.balance(ata(t.address, coin2.mint)), 0n);
    // with the right minimum it goes through in one transaction
    await w.send(C.coinToCoin({ trader: t.address, from: coin, to: coin2, amountIn: sellAmt, quoteMin, minOut: qb.out }), [t], 'coin to coin');
    assert.equal(w.balance(ata(t.address, coin.mint)), aBal - sellAmt);
    assert.equal(w.balance(ata(t.address, coin2.mint)), qb.out);
    // whatever the sale gave above quoteMin stays with the trader as quote
    assert.equal(w.balance(ata(t.address, WSOL)) - wsolBefore, qa.out - quoteMin);
    assert.ok(w.lastTxBytes <= 1232, `two DBC swaps fit one legacy-size transaction (${w.lastTxBytes} bytes)`);
    // different quote tokens are refused by the SDK
    assert.throws(() => C.coinToCoin({ trader: t.address, from: coin, to: { ...coin2, quoteMint: 'x' }, amountIn: 1n, quoteMin: 1n, minOut: 1n }), /same quote token/);
    assertInvariants(w);
  });

  it('TD09 donating quote tokens to the DBC quote vault changes neither the price nor completion', async () => {
    const before = w.pool(coin.dbcPool);
    w.donate(before.quoteVault, 200n * LAMPORTS); // more than the whole 85 SOL target
    const after = w.pool(coin.dbcPool);
    assert.equal(after.quoteReserve, before.quoteReserve);
    assert.equal(after.sqrtPrice, before.sqrtPrice);
    const t = await w.signer();
    const q = mirror(w, coin, { direction: Direction.Buy, mode: SwapMode.ExactIn, amount0: LAMPORTS });
    await w.trade(t, coin, { side: 'buy', amount0: LAMPORTS, amount1: q.out });
    assert.equal(w.balance(ata(t.address, coin.mint)), q.out, 'priced from counters, not the vault balance');
    assertInvariants(w);
  });

  it('TD07 a partial-fill buy completes the curve exactly at the graduation price; the next swap is refused', async () => {
    const t = await w.signer();
    const cfg = w.curveConfig();
    const big = 200n * LAMPORTS;
    const q = mirror(w, coin2, { direction: Direction.Buy, mode: SwapMode.PartialFill, amount0: big });
    assert.ok(q.left > 0n, 'more was offered than the curve can take');
    w.fundToken(t.address, WSOL, big);
    const before = w.balance(ata(t.address, WSOL));
    await w.trade(t, coin2, { side: 'buy', mode: SwapMode.PartialFill, amount0: big, amount1: q.out, fund: false });
    const p = w.pool(coin2.dbcPool);
    assert.equal(p.sqrtPrice, cfg.migrationSqrtPrice);
    assert.ok(p.quoteReserve >= cfg.migrationQuoteThreshold);
    assert.equal(before - w.balance(ata(t.address, WSOL)), q.includedIn, 'only what was used is taken');
    assert.equal(w.balance(ata(t.address, coin2.mint)), q.out);
    // all coins for sale are sold: the ones left in the vault are the pool reserve and the leftover
    assert.equal(SUPPLY - w.balance(p.baseVault) <= cfg.swapBaseAmount, true);
    await expectFail(() => w.trade(t, coin2, { side: 'buy', amount0: LAMPORTS, amount1: 0n }), 'PoolIsCompleted');
    await expectFail(() => w.trade(t, coin2, { side: 'sell', amount0: 1_000_000n, amount1: 0n, fund: false }), 'PoolIsCompleted');
    // the SDK mirror says the same
    assert.throws(() => mirror(w, coin2, { direction: Direction.Buy, mode: SwapMode.ExactIn, amount0: 1n }), (e) => e.code === 'PoolIsCompleted');
    assertInvariants(w);
  });

  it('TD10 config.mjs (Meteora buildCurve) gives the 7.1 parameters and the 9.3 table', () => {
    const p = vicinityConfigParams();
    assert.equal(p.sqrt_start_price.toString(), '97539716077334678');
    assert.equal(p.curve[0].sqrt_price.toString(), '373894382314756693');
    assert.equal(p.curve[0].liquidity.toString(), '104662611932995410955326609817160');
    assert.equal(p.migration_quote_threshold.toString(), '85000000000');
    assert.equal(p.pool_creation_fee.toString(), '50000000');
    const cfg = w.curveConfig();
    assert.equal(cfg.sqrtStartPrice, 97539716077334678n);
    assert.equal(cfg.migrationSqrtPrice, 373894382314756693n);
    // market caps in SOL: price per coin (raw) = s^2 / 2^128; 10^9 coins = 10^15 raw; SOL = 10^9 lamports
    const mcap = (s) => Number((s * s * SUPPLY * 1_000_000n) / Q128 / LAMPORTS) / 1e6;
    assert.ok(Math.abs(mcap(cfg.sqrtStartPrice) - 27.96) < 0.01, `start ${mcap(cfg.sqrtStartPrice)}`);
    assert.ok(Math.abs(mcap(cfg.migrationSqrtPrice) - 410.83) < 0.01, `end ${mcap(cfg.migrationSqrtPrice)}`);
    // other targets of table 9.3
    for (const [F, start, end] of [[40, 13.16, 193.33], [20, 6.58, 96.67]]) {
      const q = vicinityConfigParams({ migrationQuoteThreshold: F });
      const s0 = BigInt(q.sqrt_start_price.toString()), s1 = BigInt(q.curve[0].sqrt_price.toString());
      assert.ok(Math.abs(mcap(s0) - start) < 0.01 && Math.abs(mcap(s1) - end) < 0.01, `F=${F}: ${mcap(s0)} ${mcap(s1)}`);
    }
    // stored by DBC (recorded in LAUNCHPAD-AUDIT.md)
    console.log(`TD10_STORED swap_base_amount=${cfg.swapBaseAmount} migration_base_threshold=${cfg.migrationBaseThreshold} migration_sqrt_price=${cfg.migrationSqrtPrice}`);
  });
});

// ------------------------------------------------------------------ TD08 + TD11
function rng(seed) {
  let x = BigInt(seed) || 88172645463325252n;
  return () => { x ^= x << 13n; x &= (1n << 64n) - 1n; x ^= x >> 7n; x ^= x << 17n; x &= (1n << 64n) - 1n; return x; };
}
const STEPS = Number(process.env.PROP_STEPS ?? 160);
const SEED = process.env.PROP_SEED ?? '20261006';

describe('04 trading: property test against the real DBC (TD08, TD11)', () => {
  it(`TD11 ${STEPS} random trades: mirror exact, curve solvent, no free coins, fees exact, rounding favours the pool`, async () => {
    const w = await World.create();
    const coin = await w.launchCoin({ cityId: 900003n });
    const cfg = w.curveConfig();
    const L = cfg.curve[0].liquidity;
    const traders = [];
    for (let i = 0; i < 4; i++) { const t = await w.signer(); w.fundToken(t.address, WSOL, 60n * LAMPORTS); w.emptyTokenAccount(t.address, coin.mint); traders.push(t); }
    const ref = w.emptyTokenAccount(ADDRESSES.feeRecipient, WSOL);
    const next = rng(SEED);
    const pick = (n) => Number(next() % BigInt(n));
    const logUniform = (max) => { const bits = BigInt(1 + pick(Number(max.toString(2).length))); const m = (1n << bits); return 1n + next() % (m < max ? m : max); };
    const counts = { ok: 0, refused: 0, roundTrips: 0 };
    let completed = false;
    for (let step = 0; step < STEPS && !completed; step++) {
      const t = traders[pick(traders.length)];
      const pool = w.pool(coin.dbcPool);
      const coinBal = w.balance(ata(t.address, coin.mint));
      const wsolBal = w.balance(ata(t.address, WSOL));
      const hasReferral = pick(2) === 0;
      const op = pick(10);
      let args;
      if (op <= 3) args = { direction: Direction.Buy, mode: SwapMode.ExactIn, amount0: logUniform(wsolBal > 3n * LAMPORTS ? 3n * LAMPORTS : wsolBal || 1n) };
      else if (op === 4) args = { direction: Direction.Buy, mode: SwapMode.ExactOut, amount0: logUniform(80_000_000_000_000n) };
      else if (op === 5 && step > STEPS * 0.8) args = { direction: Direction.Buy, mode: SwapMode.PartialFill, amount0: wsolBal };
      else if (op <= 7) args = { direction: Direction.Sell, mode: SwapMode.ExactIn, amount0: coinBal > 0n ? 1n + next() % coinBal : 1n };
      else if (op === 8) args = { direction: Direction.Sell, mode: SwapMode.ExactOut, amount0: logUniform(LAMPORTS / 2n) };
      else args = { direction: Direction.Buy, mode: SwapMode.ExactIn, amount0: logUniform(LAMPORTS), roundTrip: true };
      args.hasReferral = hasReferral;
      let q, qErr;
      try { q = quoteSwap(pool, cfg, args); } catch (e) { if (!(e instanceof CurveError)) throw e; qErr = e; }
      const side = args.direction === Direction.Buy ? 'buy' : 'sell';
      const amount1 = args.mode === SwapMode.ExactOut ? (q ? q.includedIn : (1n << 63n)) : (q ? q.out : 0n);
      const send = () => w.send([C.swap({ trader: t.address, pool: coin.dbcPool, config: coin.dbcConfig, baseMint: coin.mint, quoteMint: WSOL, side, mode: args.mode, amount0: args.amount0, amount1, referral: hasReferral ? ref : undefined })], [t], 'prop swap');
      // a trade the trader cannot pay for fails in the token program; skip those
      const needIn = q ? q.includedIn : 0n;
      const afford = side === 'buy' ? needIn <= wsolBal : needIn <= coinBal;
      if (qErr || !afford) {
        if (qErr && afford) await expectFail(send, qErr.code, 'InsufficientLiquidity', 'AmountLeftIsNotZero', 'MathOverflow', 'PoolIsCompleted');
        counts.refused++;
        continue;
      }
      const before = { coin: coinBal, wsol: wsolBal, ref: w.balance(ref) };
      await send();
      counts.ok++;
      const after = w.pool(coin.dbcPool);
      const exp = applySwap(pool, q);
      // the mirror is exact: pool state and the trader's balances, to the raw unit
      assert.equal(after.sqrtPrice, exp.sqrtPrice, `step ${step} sqrt price`);
      assert.equal(after.quoteReserve, exp.quoteReserve, `step ${step} quote reserve`);
      assert.equal(after.baseReserve, exp.baseReserve, `step ${step} base reserve`);
      assert.equal(after.partnerQuoteFee, exp.partnerQuoteFee, `step ${step} partner fee`);
      assert.equal(after.creatorQuoteFee, exp.creatorQuoteFee, `step ${step} creator fee`);
      assert.equal(after.protocolQuoteFee, exp.protocolQuoteFee, `step ${step} protocol fee`);
      const dCoin = w.balance(ata(t.address, coin.mint)) - before.coin;
      const dWsol = w.balance(ata(t.address, WSOL)) - before.wsol;
      if (side === 'buy') { assert.equal(dCoin, q.out); assert.equal(-dWsol, q.includedIn); } else { assert.equal(-dCoin, q.includedIn); assert.equal(dWsol, q.out); }
      assert.equal(w.balance(ref) - before.ref, hasReferral ? q.referral : 0n);
      // fees exact: ceil(amount × 1.25%) of the quote side, split exactly
      const feeBase = side === 'buy' ? (args.mode === SwapMode.ExactIn ? q.includedIn : q.excludedIn) : q.grossOut ?? (q.out + q.fee);
      if (args.mode === SwapMode.ExactIn) assert.equal(q.fee, (feeBase * cfg.feeNumerator + 999_999_999n) / 1_000_000_000n, `step ${step} fee`);
      assert.equal(q.trading + q.protocol + q.referral, q.fee);
      assert.equal(q.partner + q.creator, q.trading);
      // rounding favours the pool (exact rational math on the single segment)
      const s = pool.sqrtPrice;
      if (side === 'buy' && args.mode !== SwapMode.ExactOut) {
        const net = q.excludedIn;
        // exact coins out = net·Q·L / (s·(s·L + net·Q))
        assert.ok(q.out * (s * (s * L + net * Q128)) <= net * Q128 * L, `step ${step} buy rounds down`);
      } else if (side === 'buy') {
        // exact quote in for `out` coins = L·out·s² / (Q·(L − out·s))
        assert.ok(q.excludedIn * (Q128 * (L - q.out * s)) >= L * q.out * s * s, `step ${step} exact-out input rounds up`);
      } else if (args.mode === SwapMode.ExactIn) {
        const a = q.includedIn;
        // exact gross quote out = L·a·s² / (Q·(L + a·s))
        assert.ok(q.grossOut * (Q128 * (L + a * s)) <= L * a * s * s, `step ${step} sell rounds down`);
      }
      // the curve stays solvent: reserves cover the integral, and no coin left the vault for free
      const now = w.pool(coin.dbcPool);
      assert.ok(now.quoteReserve >= curveQuoteAt(cfg, now.sqrtPrice), `step ${step} quote reserve covers the curve`);
      assert.ok(SUPPLY - w.balance(now.baseVault) <= curveBaseSoldAt(cfg, now.sqrtPrice), `step ${step} coins out <= curve allows`);
      // a buy immediately sold back never returns more than it cost
      if (args.roundTrip && q.out > 0n) {
        const back = quoteSwap(now, cfg, { direction: Direction.Sell, mode: SwapMode.ExactIn, amount0: q.out });
        const wsolMid = w.balance(ata(t.address, WSOL));
        await w.send([C.swap({ trader: t.address, pool: coin.dbcPool, config: coin.dbcConfig, baseMint: coin.mint, quoteMint: WSOL, side: 'sell', mode: SwapMode.ExactIn, amount0: q.out, amount1: back.out })], [t], 'prop round trip');
        const got = w.balance(ata(t.address, WSOL)) - wsolMid;
        assert.equal(got, back.out);
        assert.ok(got < q.includedIn, `step ${step} round trip ${q.includedIn} -> ${got}`);
        counts.roundTrips++;
      }
      if (now.quoteReserve >= cfg.migrationQuoteThreshold) completed = true;
      if (step % 10 === 0) assertInvariants(w);
    }
    assertInvariants(w);
    console.log(`TD11 seed=${SEED} steps=${STEPS} ok=${counts.ok} refused=${counts.refused} roundTrips=${counts.roundTrips} completed=${completed}`);
    assert.ok(counts.ok > STEPS / 3, 'most steps traded');
  });
});
