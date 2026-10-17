// L12, H01, H02, H03 (4.4, 8.3, T72, T73, X43b): who may set which pause flag;
// the guardian halt stops buys, buybacks and launches at once while sells,
// claims, forwards, withdrawals and payouts go on, and only the admin clears it;
// the halt-all build, deployed over live state, refuses all eight outflow
// instructions with TradingHalted and moves nothing, and the production build
// deployed back works again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { World, S, PATHS, expectFail, LAMPORTS, DAY } from './helpers.mjs';

const pause = (w, who, flags, label) => w.send([w.ix.setPause({ authority: who.address, ...flags })], [who], label);

test('L12 set_pause: the admin sets anything either way; the payout key only stops payouts; the guardian only stops launches and buys', async () => {
  const w = await World.create();
  const payoutKey = await w.signer(1n); const wallet = await w.signer(1n); const stranger = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = payoutKey;
  const flags = () => { const lp = w.launchpad(); return [lp.launchesPaused, lp.payoutsPaused, lp.buysHalted]; };
  // strangers: nothing
  for (const f of [{ launches: true }, { payouts: true }, { buys: true }, {}]) await expectFail(() => pause(w, stranger, f, `stranger ${JSON.stringify(f)}`), 'Unauthorized');
  // the payout key: only (None, Some(true), None)
  for (const f of [{ payouts: false }, { launches: true }, { buys: true }, { launches: true, payouts: true }, {}]) {
    await expectFail(() => pause(w, payoutKey, f, `payout key ${JSON.stringify(f)}`), 'Unauthorized');
  }
  let r = await pause(w, payoutKey, { payouts: true }, 'payout key pauses payouts');
  assert.deepEqual(r.events[0].data, { launches_paused: false, payouts_paused: true, buys_halted: false, by: payoutKey.address });
  // the guardian: launches and/or buys, only to true, at least one, never payouts
  for (const f of [{ launches: false }, { buys: false }, { payouts: true }, { launches: true, payouts: true }, { buys: true, launches: false }, {}]) {
    await expectFail(() => pause(w, w.guardian, f, `guardian ${JSON.stringify(f)}`), 'Unauthorized');
  }
  await pause(w, w.guardian, { launches: true }, 'guardian stops launches');
  await pause(w, w.guardian, { buys: true }, 'guardian halts buys');
  await pause(w, w.guardian, { launches: true, buys: true }, 'guardian both again');
  assert.deepEqual(flags(), [true, true, true]);
  // the admin: any flag either way, also an empty call (NOTES entry 23)
  await pause(w, w.admin, { launches: false, payouts: false, buys: false }, 'admin clears all');
  assert.deepEqual(flags(), [false, false, false]);
  r = await pause(w, w.admin, {}, 'admin, nothing set');
  assert.deepEqual(r.events[0].data, { launches_paused: false, payouts_paused: false, buys_halted: false, by: w.admin.address });
  await pause(w, w.admin, { buys: true }, 'admin halts buys');
  await pause(w, w.admin, { buys: false }, 'admin resumes buys');
  // a replaced guardian has no power; zero = no guardian
  const oldGuardian = w.guardian;
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: S.ADDRESSES.system })], [w.admin], 'no guardian');
  w.guardian = null;
  await expectFail(() => pause(w, oldGuardian, { buys: true }, 'former guardian'), 'Unauthorized');
  await w.finish();
});

test('H01 the guardian halt: buys, buybacks and launches refuse; sells, claims, forwards, withdrawals and payouts work; only the admin clears', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 700n, symbol: 'HALT' });
  const founder2 = await w.signer(1n);
  await w.approve({ cityId: 701n, founder: founder2, symbol: 'NEXT' });
  const u = await w.signer(100n);
  const b = await w.buy(u, h, 20n * LAMPORTS);
  await w.initRewardsCity(h);
  const payoutKey = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = payoutKey;
  await w.send([w.ix.optInPayout({ founder: h.founder.address, coin: h.coin, expectedDestination: wallet.address, refHash: Array(32).fill(1) })], [h.founder], 'opt in');
  w.warpSlots(200n);
  await pause(w, w.guardian, { buys: true }, 'guardian halts buys');
  // refused
  await expectFail(() => w.buy(u, h, LAMPORTS, { label: 'buy while halted' }), 'BuysHalted');
  await expectFail(() => w.buyback(h, { label: 'buyback while halted' }), 'BuysHalted');
  await expectFail(() => w.launch({ cityId: 701n, founder: founder2, label: 'launch while halted' }), 'BuysHalted');
  // every exit works
  await w.sell(u, h, b.q.tokensOut / 4n, { label: 'sell while halted' });
  await w.claim(h, h.founder, { label: 'claim while halted' });
  await w.withdraw(h, { label: 'withdraw while halted' });
  await w.forward(h, { label: 'forward while halted' });
  await w.sell(u, h, b.q.tokensOut / 4n, { label: 'another sell' });
  await w.payout(h, { destination: wallet.address, label: 'payout while halted' });
  // the guardian cannot clear; the admin can
  await expectFail(() => pause(w, w.guardian, { buys: false }, 'guardian clears'), 'Unauthorized');
  await pause(w, w.admin, { buys: false }, 'admin clears');
  await w.buy(u, h, LAMPORTS, { label: 'buy after the halt' });
  await w.buyback(h, { label: 'buyback after the halt' });
  await w.launch({ cityId: 701n, founder: founder2 });
  // launches paused: launches refuse; trading and exits go on
  const founder3 = await w.signer(1n);
  await w.approve({ cityId: 702n, founder: founder3, symbol: 'THIRD' });
  await pause(w, w.guardian, { launches: true }, 'guardian stops launches');
  await expectFail(() => w.launch({ cityId: 702n, founder: founder3, label: 'launch while launches are paused' }), 'LaunchesPaused');
  await w.buy(u, h, LAMPORTS, { label: 'buy while launches are paused' });
  await w.sell(u, h, 1_000_000_000n, { label: 'sell while launches are paused' });
  await pause(w, w.admin, { launches: false }, 'admin resumes launches');
  await w.launch({ cityId: 702n, founder: founder3 });
  await w.finish();
});

test('H02, H03 the halt-all build over live state: all eight outflows refuse with TradingHalted, nothing moves, settings still work; the production build back works', async (t) => {
  if (!existsSync(PATHS.curveHaltAll)) throw new Error(`missing ${PATHS.curveHaltAll}: run "npm run vcurve:sbf"`);
  const w = await World.create();
  const curve = await w.launchCoin({ cityId: 710n, symbol: 'HCURVE' });
  const pool = await w.launchCoin({ cityId: 711n, symbol: 'HPOOL' });
  const u = await w.signer(500n);
  const cb = await w.buy(u, curve, 10n * LAMPORTS);
  await w.buy(u, pool, 100n * LAMPORTS);
  for (const h of [curve, pool]) await w.initRewardsCity(h);
  const payoutKey = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = payoutKey;
  for (const h of [curve, pool]) await w.send([w.ix.optInPayout({ founder: h.founder.address, coin: h.coin, expectedDestination: wallet.address, refHash: Array(32).fill(2) })], [h.founder], 'opt in');
  const founder3 = await w.signer(1n);
  await w.approve({ cityId: 712n, founder: founder3, symbol: 'HNEXT' });
  w.warpSlots(200n); w.warpSecs(2n * DAY);
  const snap = new Map([curve, pool].map((h) => [h.coin, { data: w.accountInfo(h.coin).data, lamports: w.lamportsOf(h.coin), vault: w.tokenBalance(h.vault) }]));
  w.loadCurve(PATHS.curveHaltAll);
  const refuse = (label, fn) => expectFail(fn, 'TradingHalted').then(() => t.diagnostic(`halt-all refuses ${label}`));
  for (const h of [curve, pool]) {
    await refuse('buy', () => w.send(w.buyIxs(u, h, LAMPORTS, 0n), [u], 'buy (halt-all)'));
    await refuse('sell', () => w.send([w.ix.sell({ user: u.address, coin: h.coin, tokensIn: 1_000_000n, minSolOut: 0n })], [u], 'sell (halt-all)'));
    await refuse('buyback_burn', () => w.buyback(h, { label: 'buyback (halt-all)' }));
    await refuse('withdraw_platform_fees', () => w.withdraw(h, { label: 'withdraw (halt-all)' }));
    await refuse('claim_founder_fees', () => w.claim(h, h.founder, { label: 'claim (halt-all)' }));
    await refuse('forward_holders_fees', () => w.forward(h, { label: 'forward (halt-all)' }));
    await refuse('payout_founder_fees', () => w.payout(h, { destination: wallet.address, label: 'payout (halt-all)' }));
  }
  await refuse('launch', () => w.launch({ cityId: 712n, founder: founder3, label: 'launch (halt-all)' }));
  // settings instructions still work under the halt-all build
  const founder4 = await w.signer(1n);
  await w.approve({ cityId: 713n, founder: founder4, symbol: 'HLATER' });
  await pause(w, w.guardian, { buys: true }, 'guardian halts buys (halt-all)');
  await pause(w, w.admin, { buys: false }, 'admin clears (halt-all)');
  for (const h of [curve, pool]) {
    const s = snap.get(h.coin);
    assert.ok(w.accountInfo(h.coin).data.equals(s.data), 'the Coin\'s bytes did not change');
    assert.equal(w.lamportsOf(h.coin), s.lamports, 'nor its lamports');
    assert.equal(w.tokenBalance(h.vault), s.vault, 'nor its vault');
  }
  // the production build back: every coin's state is intact and everything works
  w.loadCurve(PATHS.curve);
  await w.probe('after the production build is back');
  await w.buy(u, curve, LAMPORTS, { label: 'buy after restore' });
  await w.sell(u, curve, cb.q.tokensOut / 2n, { label: 'sell after restore' });
  await w.sell(u, pool, 1_000_000_000_000n, { label: 'pool sell after restore' });
  for (const h of [curve, pool]) {
    await w.buyback(h, { label: 'buyback after restore' });
    await w.withdraw(h, { label: 'withdraw after restore' });
    await w.forward(h, { label: 'forward after restore' });
    await w.payout(h, { destination: wallet.address, label: 'payout after restore' });
  }
  await w.claim(curve, curve.founder, { label: 'claim after restore' });
  await w.launch({ cityId: 712n, founder: founder3 });
  await w.launch({ cityId: 713n, founder: founder4 });
  await w.finish();
});
