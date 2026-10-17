// L08: pool trading after graduation (5.7, 5.8): every trade's liquidity share
// enters pool_sol without coins, and the drip moves at most each trade's
// rounded-down liquidity share of the curve-phase set-aside into the pool,
// until liquidity_pending is 0; X*Y never decreases (the checker checks it
// after every transaction, and every drip against the SDK's math).
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, S, LAMPORTS } from './helpers.mjs';

const T = S.DEFAULT_TERMS;

test('L08 pool trades with the liquidity share and the drip until the set-aside liquidity is 0', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 300n, symbol: 'POOL' });
  const whale = await w.signer(5_000n);
  // some curve churn first, so the set-aside liquidity holds more than one graduation's worth
  for (let k = 0; k < 4; k++) {
    const b = await w.buy(whale, h, 20n * LAMPORTS, { label: `churn buy ${k}` });
    await w.sell(whale, h, b.q.tokensOut, { label: `churn sell ${k}` });
  }
  await w.buy(whale, h, 100n * LAMPORTS, { label: 'graduating buy' });
  let c = w.coinView(h);
  assert.equal(c.phase, 1);
  const L0 = c.liquidityPending;
  assert.ok(L0 > 435_897_438n, `set-aside ${L0}`);
  assert.equal(c.liquidityAdded, 0n, 'nothing entered the pool before graduation');
  const traders = [await w.signer(500n), await w.signer(500n)];
  // a dust sell drips nothing while set-aside liquidity waits: below 200 lamports the rounded-down share is 0 (T28, 7.5)
  const d = await w.signer(10n);
  await w.buy(d, h, 100_000n, { label: 'dust holder buys' });
  let n = 1n;
  const cc = w.coinView(h);
  const gross = (k) => { try { return S.quoteSell(S.coinTerms(cc), S.coinState(cc), k).gross; } catch { return 0n; } };
  while (gross(n) < 41n) n *= 2n;
  const dust = await w.sell(d, h, n, { label: 'dust sell' });
  assert.ok(dust.q.gross < 200n && w.coinView(h).liquidityPending > 0n && dust.q.drip === 0n, `dust sell of ${dust.q.gross} lamports dripped ${dust.q.drip}`);
  let rounds = 0;
  while (w.coinView(h).liquidityPending > 0n && rounds < 60) {
    const t = traders[rounds % 2];
    const before = w.coinView(h);
    const r = await w.buy(t, h, 30n * LAMPORTS, { label: `pool buy ${rounds}` });
    const after = w.coinView(h);
    const lf = (r.q.charged * T.liquidityBps) / S.BPS;
    const want = before.liquidityPending < lf ? before.liquidityPending : lf;
    assert.equal(r.q.drip, want, 'drip = min(L, floor(A * b_L / D))');
    assert.equal(after.poolSol - before.poolSol, r.q.net + r.q.split.liquidity + r.q.drip, 'X += net + liquidity + drip (no coins added)');
    assert.equal(after.liquidityAdded - before.liquidityAdded, r.q.split.liquidity + r.q.drip);
    const s = await w.sell(t, h, r.q.tokensOut, { label: `pool sell ${rounds}` });
    assert.ok(s.q.solOut < r.q.charged, 'a pool round trip loses (5.15)');
    rounds++;
  }
  c = w.coinView(h);
  assert.equal(c.liquidityPending, 0n, `drained after ${rounds} round trips`);
  assert.equal(c.liquidityAdded, c.liquidityEarned, 'every liquidity lamport ever earned is in the pool');
  // once drained, trades still add their own liquidity share and drip nothing
  const v = await w.signer(50n);
  const r = await w.buy(v, h, 2n * LAMPORTS, { label: 'after the drip' });
  assert.equal(r.q.drip, 0n);
  assert.equal(w.coinView(h).liquidityPending, 0n);
  await w.finish();
});

test('L08 in the pool the price rises with every liquidity share; the round trip costs at least (1 - f)(1 - f + 2l)', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 301n, symbol: 'PRICE' });
  const a = await w.signer(500n); const b = await w.signer(500n);
  await w.buy(a, h, 100n * LAMPORTS);
  const price = () => { const c = w.coinView(h); return [c.poolSol, c.poolTokens]; };
  const [x0, y0] = price();
  const r = await w.buy(b, h, 10n * LAMPORTS);
  const s = await w.sell(b, h, r.q.tokensOut);
  const [x1, y1] = price();
  assert.equal(y1, y0, 'the coins came back');
  assert.ok(x1 > x0, 'the pool kept the fees\' liquidity shares and drips: the price is higher');
  const bound = (r.q.charged * (S.BPS - T.totalFeeBps) * (S.BPS - T.totalFeeBps + 2n * T.liquidityBps)) / (S.BPS * S.BPS) + 6n;
  assert.ok(s.q.solOut <= bound, `round trip within the bound of 5.15 (${s.q.solOut} <= ${bound})`);
  await w.finish();
});
