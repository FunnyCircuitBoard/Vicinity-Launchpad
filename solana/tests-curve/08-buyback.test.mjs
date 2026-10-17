// L09: buyback_burn (4.13, 7.1, 7.2, I15): the 150-slot interval, including the
// first run after launch; the cap of 0.1% of the market's depth; the SPL burn,
// the supply and the burn counters (E7, E8 of 5.14); never graduating the coin
// (it stops at S - 1, then a 0.0001 SOL buy completes the curve for 1 lamport,
// X23); the no-op cases (no state change, no event); refused while buys are
// halted; the caller chooses nothing and receives nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, S, expectFail, mintInfo, LAMPORTS } from './helpers.mjs';

const T = S.DEFAULT_TERMS;
const supply = (w, h) => mintInfo(w.accountInfo(h.mint)).supply;

test('L09 E8 on the curve: nothing in the launch interval, then one run per 150 slots, capped, burned, counted', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 400n, symbol: 'BURN' });
  const launchSlot = w.coinView(h).launchSlot;
  const u = await w.signer(50n);
  const b = await w.buy(u, h, 10n * LAMPORTS);
  assert.equal(b.q.tokensOut, 263_189_306_077_696n);
  // 149 slots after launch: a no-op (no state change, no event)
  w.warpSlots(149n - (w.slot() - launchSlot));
  const before = w.accountInfo(h.coin).data;
  let r = await w.buyback(h, { label: 'buyback at launch + 149' });
  assert.equal(r.events.length, 0);
  assert.ok(w.accountInfo(h.coin).data.equals(before), 'nothing changed');
  // 150 slots after launch: E8
  w.warpSlots(1n);
  const s0 = supply(w, h);
  const k0 = w.lamportsOf(w.keeper.address);
  r = await w.buyback(h, { label: 'buyback E8' });
  const e = r.events.find((x) => x.name === 'BuybackBurned').data;
  assert.deepEqual([e.phase, e.sol_spent, e.tokens_burned, e.cap, e.buyback_pending_after, e.tokens_burned_total, e.supply_after],
    [0, 30_000_000n, 610_723_163_277n, 39_750_853n, 0n, 610_723_163_277n, s0 - 610_723_163_277n]);
  const c = w.coinView(h);
  assert.deepEqual([c.tokensSold, c.curveSol, c.buybackPending, c.buybackSpent, c.tokensBurned, c.buybackCount, c.lastBuybackSlot],
    [263_800_029_240_973n, 9_780_000_000n, 0n, 30_000_000n, 610_723_163_277n, 1n, w.slot()]);
  assert.equal(supply(w, h), s0 - 610_723_163_277n, 'the supply fell by the burned coins');
  assert.equal(w.lamportsOf(w.keeper.address), k0 - 5_000n, 'the caller paid the fee and received nothing');
  // E8 price move: +0.151%
  const p0 = Number(39_750_853_639n) / Number(T.virtualTokens - 263_189_306_077_696n);
  const p1 = Number(T.virtualSol + c.curveSol) / Number(T.virtualTokens - c.tokensSold);
  assert.ok(Math.abs(p1 / p0 - 1.00151) < 0.00001, `price +0.151% (${p1 / p0})`);
  // the bucket is empty: no-op even after the interval
  w.warpSlots(150n);
  r = await w.buyback(h, { label: 'buyback with an empty bucket' });
  assert.equal(r.events.length, 0);
  // new fees, but within 150 slots of the last run: no-op; after it: a second run
  await w.buy(u, h, 5n * LAMPORTS);
  r = await w.buyback(h, { label: 'buyback after a trade, interval passed' });
  assert.equal(r.events.length, 1);
  await w.buy(u, h, 5n * LAMPORTS);
  w.warpSlots(149n);
  r = await w.buyback(h, { label: 'buyback 149 slots after the last run' });
  assert.equal(r.events.length, 0);
  w.warpSlots(1n);
  r = await w.buyback(h, { label: 'buyback 150 slots after the last run' });
  assert.equal(r.events.length, 1);
  assert.equal(w.coinView(h).buybackCount, 3n);
  // at most one run per coin per transaction: two in one transaction, the second is a no-op
  await w.buy(u, h, 5n * LAMPORTS);
  w.warpSlots(150n);
  r = await w.send([w.ix.buybackBurn({ coin: h.coin }), w.ix.buybackBurn({ coin: h.coin })], [], 'two buybacks in one transaction', { feePayer: w.keeper });
  assert.equal(r.events.filter((x) => x.name === 'BuybackBurned').length, 1);
  await w.finish();
});

test('L09 E7 in the pool: the cap binds at 0.1% of pool_sol, the backlog waits for the next runs', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 401n, symbol: 'POOLB' });
  const u = await w.signer(500n);
  await w.buy(u, h, 100n * LAMPORTS);
  w.warpSlots(150n);
  const s0 = supply(w, h);
  let r = await w.buyback(h, { label: 'buyback E7' });
  const e = r.events.find((x) => x.name === 'BuybackBurned').data;
  assert.deepEqual([e.phase, e.sol_spent, e.tokens_burned, e.cap, e.buyback_pending_after], [1, 85_000_000n, 206_693_307_592n, 85_000_000n, 176_538_461n]);
  let c = w.coinView(h);
  assert.deepEqual([c.poolSol, c.poolTokens], [85_085_000_000n, 206_693_307_592_408n]);
  assert.equal(supply(w, h), s0 - 206_693_307_592n, 'supply 999,793,297.592408 coins');
  assert.equal(supply(w, h), 999_793_297_592_408n);
  // the backlog is spent over the next runs, one cap at a time
  let runs = 1;
  while (w.coinView(h).buybackPending > 0n && runs < 10) {
    w.warpSlots(150n);
    const before = w.coinView(h);
    r = await w.buyback(h, { label: `backlog run ${runs + 1}` });
    const ev = r.events[0].data;
    assert.equal(ev.cap, (before.poolSol * T.totalFeeBps) / (S.BUYBACK_CAP_DIVISOR * S.BPS));
    assert.equal(ev.sol_spent, before.buybackPending < ev.cap ? before.buybackPending : ev.cap);
    runs++;
  }
  c = w.coinView(h);
  assert.equal(c.buybackPending, 0n);
  assert.equal(c.buybackSpent, c.buybackEarned);
  assert.equal(runs, 4, '261,538,461 lamports in caps of about 85,000,000');
  await w.finish();
});

test('L09 the buyback never graduates the coin: it stops at S - 1, and a 0.0001 SOL buy then completes the curve for 1 lamport (X23)', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 402n, symbol: 'NOGRAD' });
  const u = await w.signer(500n); const v = await w.signer(10n);
  // the curve 1,000 lamports short of R, with a bucket far larger than that
  await w.buy(u, h, S.grossFor(T, T.graduationSol - 1_000n));
  let c = w.coinView(h);
  assert.equal(c.curveSol, T.graduationSol - 1_000n);
  assert.ok(c.buybackPending > 1_000n);
  w.warpSlots(150n);
  const r = await w.buyback(h, { label: 'buyback near completion' });
  const e = r.events[0].data;
  c = w.coinView(h);
  assert.deepEqual([c.phase, c.tokensSold, c.curveSol], [0, T.curveSupply - 1n, T.graduationSol - 1n], 'capped at S - 1');
  assert.equal(e.sol_spent, 999n);
  // the next buyback is a no-op at f(S - 1) (I22: the next user buy graduates the coin)
  w.warpSlots(150n);
  const again = await w.buyback(h, { label: 'buyback at f(S - 1)' });
  assert.equal(again.events.length, 0);
  // a bundled 0.0001 SOL buy graduates the coin, charged 1 lamport
  const g = await w.buy(v, h, 100_000n);
  assert.deepEqual([g.q.charged, g.q.tokensOut, g.q.graduates], [1n, 1n, true]);
  assert.equal(w.coinView(h).phase, 1);
  // and after graduation buybacks proceed in the pool
  w.warpSlots(150n);
  const p = await w.buyback(h, { label: 'buyback in the pool' });
  assert.equal(p.events[0].data.phase, 1);
  await w.finish();
});

test('L09 refused while buys are halted; the halt stops nothing else; a fresh coin\'s empty bucket is a no-op; substitutions refused', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 403n, symbol: 'HALTB' });
  const h2 = await w.launchCoin({ cityId: 404n, symbol: 'OTHER' });
  const u = await w.signer(50n);
  w.warpSlots(200n);
  let r = await w.buyback(h, { label: 'fresh coin, empty bucket' });
  assert.equal(r.events.length, 0);
  await w.buy(u, h, 3n * LAMPORTS);
  w.warpSlots(150n);
  await w.send([w.ix.setPause({ authority: w.guardian.address, buys: true })], [w.guardian], 'guardian halts buys');
  await expectFail(() => w.buyback(h, { label: 'buyback while halted' }), 'BuysHalted');
  // the account list is pinned: another coin's mint or vault, Token-2022
  await w.send([w.ix.setPause({ authority: w.admin.address, buys: false })], [w.admin], 'admin clears');
  await expectFail(() => w.send([w.ix.buybackBurn({ coin: h.coin, overrides: { mint: h2.mint } })], [], 'another mint', { feePayer: w.keeper }), 'InvalidAddress');
  await expectFail(() => w.send([w.ix.buybackBurn({ coin: h.coin, overrides: { coin_vault: h2.vault } })], [], 'another vault', { feePayer: w.keeper }), 'InvalidAddress');
  await expectFail(() => w.send([w.ix.buybackBurn({ coin: h.coin, overrides: { token_program: S.ADDRESSES.token2022 } })], [], 'Token-2022', { feePayer: w.keeper }), 'InvalidProgramId');
  r = await w.buyback(h, { label: 'buyback after the halt is cleared' });
  assert.equal(r.events.length, 1);
  await w.finish();
});
