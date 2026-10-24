// L12, H01, H02, H03, LL-1 (4.4, 8.3, T72, T73, T76, X43b): who may set which
// pause flag; the guardian halt stops buys and launches at once, and buybacks
// too when it halts them with buys, while sells, claims, forwards, withdrawals
// and payouts go on, and only the admin clears it; buybacks are halted only
// while buys are, so after a halt of both the admin resumes buybacks first and
// the keeper spends each backlog before anyone can buy ahead of it (review LL-1);
// the halt-all build, deployed over live state, refuses all nine handlers that
// move lamports or tokens (the eight outflows and launch_from_batch) with
// TradingHalted and moves nothing, while settings (a batch publication among
// them) still work, and the production build deployed back works again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { World, S, PATHS, expectFail, LAMPORTS, DAY } from './helpers.mjs';

const pause = (w, who, flags, label) => w.send([w.ix.setPause({ authority: who.address, ...flags })], [who], label);

test('L12 set_pause: the admin sets anything either way; the payout key only stops payouts; the guardian only stops launches, buys and buybacks; buybacks are halted only while buys are', async () => {
  const w = await World.create();
  const payoutKey = await w.signer(1n); const wallet = await w.signer(1n); const stranger = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = payoutKey;
  const flags = () => { const lp = w.launchpad(); return [lp.launchesPaused, lp.payoutsPaused, lp.buysHalted, lp.buybacksHalted]; };
  // strangers: nothing
  for (const f of [{ launches: true }, { payouts: true }, { buys: true }, { buys: true, buybacks: true }, {}]) await expectFail(() => pause(w, stranger, f, `stranger ${JSON.stringify(f)}`), 'Unauthorized');
  // the payout key: only (None, Some(true), None, None)
  for (const f of [{ payouts: false }, { launches: true }, { buys: true }, { launches: true, payouts: true }, { payouts: true, buybacks: true }, {}]) {
    await expectFail(() => pause(w, payoutKey, f, `payout key ${JSON.stringify(f)}`), 'Unauthorized');
  }
  let r = await pause(w, payoutKey, { payouts: true }, 'payout key pauses payouts');
  assert.deepEqual(r.events[0].data, { launches_paused: false, payouts_paused: true, buys_halted: false, buybacks_halted: false, by: payoutKey.address });
  // the guardian: launches, buys and/or buybacks, only to true, at least one, never payouts
  for (const f of [{ launches: false }, { buys: false }, { buybacks: false }, { payouts: true }, { launches: true, payouts: true }, { buys: true, launches: false },
    { buys: true, buybacks: false }, {}]) {
    await expectFail(() => pause(w, w.guardian, f, `guardian ${JSON.stringify(f)}`), 'Unauthorized');
  }
  // review LL-1: a buyback halt goes with a buy halt, for every signer
  await expectFail(() => pause(w, w.guardian, { buybacks: true }, 'guardian halts buybacks while buys are open'), 'BuybackHaltWithoutBuyHalt');
  await expectFail(() => pause(w, w.admin, { buybacks: true }, 'admin halts buybacks while buys are open'), 'BuybackHaltWithoutBuyHalt');
  await pause(w, w.guardian, { launches: true }, 'guardian stops launches');
  await pause(w, w.guardian, { buys: true }, 'guardian halts buys');
  assert.deepEqual(flags(), [true, true, true, false], 'a buy halt alone leaves buybacks running');
  await pause(w, w.guardian, { buybacks: true }, 'guardian halts buybacks while buys are halted');
  r = await pause(w, w.guardian, { launches: true, buys: true, buybacks: true }, 'guardian all three again');
  assert.deepEqual(flags(), [true, true, true, true]);
  assert.deepEqual(r.events[0].data, { launches_paused: true, payouts_paused: true, buys_halted: true, buybacks_halted: true, by: w.guardian.address });
  // buys never reopen in front of halted buybacks; buybacks first (or both at once)
  await expectFail(() => pause(w, w.admin, { buys: false }, 'admin reopens buys before buybacks'), 'BuybackHaltWithoutBuyHalt');
  await pause(w, w.admin, { buybacks: false }, 'admin resumes buybacks, buys still halted');
  assert.deepEqual(flags(), [true, true, true, false]);
  await pause(w, w.admin, { buybacks: true }, 'admin halts buybacks again');
  // the admin: any flag either way, also an empty call (NOTES entry 23)
  await pause(w, w.admin, { launches: false, payouts: false, buys: false, buybacks: false }, 'admin clears all');
  assert.deepEqual(flags(), [false, false, false, false]);
  r = await pause(w, w.admin, {}, 'admin, nothing set');
  assert.deepEqual(r.events[0].data, { launches_paused: false, payouts_paused: false, buys_halted: false, buybacks_halted: false, by: w.admin.address });
  await pause(w, w.admin, { buys: true }, 'admin halts buys');
  await pause(w, w.admin, { buys: false }, 'admin resumes buys');
  // a replaced guardian has no power; zero = no guardian
  const oldGuardian = w.guardian;
  await w.send([w.ix.setGuardian({ admin: w.admin.address, guardian: S.ADDRESSES.system })], [w.admin], 'no guardian');
  w.guardian = null;
  await expectFail(() => pause(w, oldGuardian, { buys: true }, 'former guardian'), 'Unauthorized');
  await w.finish();
});

test('H01 the guardian halt: buys and launches refuse, buybacks too once halted with them; sells, claims, forwards, withdrawals and payouts work; only the admin clears, buybacks first', async () => {
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
  await expectFail(() => w.launch({ cityId: 701n, founder: founder2, label: 'launch while halted' }), 'BuysHalted');
  // a buy halt alone leaves the buybacks running: no backlog builds while nobody can buy ahead of it (review LL-1)
  const runs0 = w.coinView(h).buybackCount;
  await w.buyback(h, { label: 'buyback while only buys are halted' });
  assert.equal(w.coinView(h).buybackCount, runs0 + 1n, 'the run went through');
  await pause(w, w.guardian, { buybacks: true }, 'guardian halts buybacks too');
  w.warpSlots(200n);
  await expectFail(() => w.buyback(h, { label: 'buyback while halted' }), 'BuybacksHalted');
  // every exit works
  await w.sell(u, h, b.q.tokensOut / 4n, { label: 'sell while halted' });
  await w.claim(h, h.founder, { label: 'claim while halted' });
  await w.withdraw(h, { label: 'withdraw while halted' });
  await w.forward(h, { label: 'forward while halted' });
  await w.sell(u, h, b.q.tokensOut / 4n, { label: 'another sell' });
  await w.payout(h, { destination: wallet.address, label: 'payout while halted' });
  // the guardian cannot clear; the admin can, buybacks first
  await expectFail(() => pause(w, w.guardian, { buys: false }, 'guardian clears'), 'Unauthorized');
  await expectFail(() => pause(w, w.guardian, { buybacks: false }, 'guardian resumes buybacks'), 'Unauthorized');
  await pause(w, w.admin, { buybacks: false }, 'admin resumes buybacks');
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

test('H02, H03 the halt-all build over live state: all nine handlers that move money (launch_from_batch among them) refuse with TradingHalted, nothing moves, settings and batch publication still work; the production build back works', async (t) => {
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
  // a launch batch in force for two more founders (4.27)
  await w.initBatchPath();
  const [bf1, bf2] = [await w.signer(1n), await w.signer(1n)];
  const bt = await w.publishBatch([{ cityId: 714n, founder: bf1, symbol: 'HBATCH' }, { cityId: 715n, founder: bf2, symbol: 'HBATCHB' }]);
  w.warpTo(bt.validFrom);
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
  await refuse('launch_from_batch', () => w.launchFromBatch({ batch: bt, cityId: 714n, founder: bf1, label: 'launch_from_batch (halt-all)' }));
  // the batch path's settings still work: the next day's list is published (batch 1 stays in force until its valid_from)
  const bf3 = await w.signer(1n);
  const bt2 = await w.publishBatch([{ cityId: 716n, founder: bf3, symbol: 'HBATCHC' }], { label: 'publish_launch_batch (halt-all)' });
  assert.equal(w.launchBatch().previous.seq, 1n, 'batch 1 moved to previous');
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
  await w.launchFromBatch({ batch: bt, cityId: 714n, founder: bf1, label: 'launch_from_batch after restore (batch 1, previous)' });
  w.warpTo(bt2.validFrom);
  await w.launchFromBatch({ batch: bt2, cityId: 716n, founder: bf3, label: 'launch_from_batch after restore (batch 2)' });
  await expectFail(() => w.launchFromBatch({ batch: bt, cityId: 715n, founder: bf2, label: 'batch 1 superseded' }), 'BatchSuperseded');
  await w.finish();
});

test('LL-1 a halt of buys and buybacks: sells keep filling the buyback buckets; buys cannot reopen before buybacks; with buybacks resumed and buys still halted the keeper spends the backlog, and the first buyer after the clear loses (on a twin coin left undrained he would profit)', async () => {
  const w = await World.create();
  // two coins with the same history: A is drained before buys reopen, B is not (the runbook's counterfactual)
  const coins = [await w.launchCoin({ cityId: 720n, symbol: 'DRAINA' }), await w.launchCoin({ cityId: 721n, symbol: 'DRAINB' })];
  const [A, B] = coins;
  const terms = S.coinTerms(w.coinView(A));
  const whale = await w.signer(0n);
  w.setRaw(whale.address, Buffer.alloc(0), S.ADDRESSES.system, 1_000n * LAMPORTS);
  const holders = [];
  for (let i = 0; i < 4; i++) holders.push(await w.signer(200n));
  const keeperRun = async (h, label) => {
    const before = w.coinView(h).buybackCount;
    await w.buyback(h, { label });
    return w.coinView(h).buybackCount > before;
  };
  const crank = async (hs, label) => { // the keeper: one run per coin per interval while any bucket can be spent
    let runs = 0;
    for (;;) {
      w.warpSlots(S.BUYBACK_INTERVAL_SLOTS);
      let any = false;
      for (const h of hs) if (w.coinView(h).buybackPending > 0n && await keeperRun(h, `${label} ${w.coinView(h).symbol}`)) any = true;
      if (!any) return runs;
      runs++;
    }
  };
  // each coin graduates and its pool grows to about 320 SOL; the keeper keeps every bucket spent
  for (const h of coins) {
    await w.buy(whale, h, S.maxQuoteIn(terms, S.coinState(w.coinView(h))), { label: 'graduating buy' });
    for (const u of holders) await w.buy(u, h, 60n * LAMPORTS, { label: 'pool buy' });
  }
  await crank(coins, 'keeper before the halt');
  for (const h of coins) assert.equal(w.coinView(h).buybackPending, 0n, 'no backlog before the halt');
  const pause = (who, flags, label) => w.send([w.ix.setPause({ authority: who.address, ...flags })], [who], label);
  // the guardian halts buys and buybacks (a buyback halt alone is refused: it would let a backlog build in front of open buys)
  await expectFail(() => pause(w.guardian, { buybacks: true }, 'the guardian halts buybacks only'), 'BuybackHaltWithoutBuyHalt');
  await pause(w.guardian, { buys: true, buybacks: true }, 'the guardian halts buys and buybacks');
  // 48 hours of exits: everybody sells 95% of his coins in five rounds; each sell books 0.3% into buyback_pending, no run can spend it
  const sellers = [whale, ...holders];
  for (let round = 0; round < 5; round++) {
    for (const h of coins) {
      for (const u of sellers) await w.sell(u, h, w.balanceOf(u, h.mint) * 19n / (100n - 19n * BigInt(round)), { label: `sell during the halt, round ${round}` });
      w.warpSlots(S.BUYBACK_INTERVAL_SLOTS);
      await expectFail(() => w.buyback(h, { label: 'the keeper during the halt' }), 'BuybacksHalted');
    }
  }
  const u = 20_420n; // Theorem M_K's pool threshold u* (2.042%)
  for (const h of coins) {
    const c = w.coinView(h);
    assert.ok(c.buybackPending * 1_000_000n > c.poolSol * u, `a backlog above u*: ${c.buybackPending} of ${c.poolSol}`);
  }
  const attacker = await w.signer(50n);
  await expectFail(() => w.buy(attacker, A, LAMPORTS, { label: 'a buy during the halt' }), 'BuysHalted');
  // the admin cannot open buys in front of the backlog; the guardian cannot resume anything
  await expectFail(() => pause(w.admin, { buys: false }, 'the admin reopens buys first'), 'BuybackHaltWithoutBuyHalt');
  await expectFail(() => pause(w.guardian, { buybacks: false }, 'the guardian resumes buybacks'), 'Unauthorized');
  // proposal 1: buybacks resume while buys stay halted; nobody can buy ahead of the runs
  await pause(w.admin, { buybacks: false }, 'the admin resumes buybacks');
  await expectFail(() => w.buy(attacker, A, LAMPORTS, { label: 'a buy while only buybacks run' }), 'BuysHalted');
  const drained = await crank([A], 'the keeper drains A while buys are halted');
  assert.equal(w.coinView(A).buybackPending, 0n, 'A\'s backlog is spent');
  assert.ok(drained > 10, `${drained} runs`);
  // proposal 2: buys reopen; the first buyer of each coin buys 5 SOL in the same slot and holds through every run
  await pause(w.admin, { buys: false }, 'the admin reopens buys');
  const pnl = new Map();
  const bought = new Map();
  for (const h of coins) bought.set(h.coin, await w.buy(attacker, h, 5n * LAMPORTS, { label: 'the first buyer after the clear' }));
  const held = await crank(coins, 'the keeper after the clear');
  for (const h of coins) {
    const b = bought.get(h.coin);
    const s = await w.sell(attacker, h, b.q.tokensOut, { label: 'the first buyer sells' });
    pnl.set(h.coin, s.q.solOut - b.q.charged);
  }
  assert.ok(pnl.get(A.coin) < 0n, `drained A: the first buyer loses (${pnl.get(A.coin)})`);
  assert.ok(pnl.get(B.coin) > 0n, `undrained B: the first buyer would profit (${pnl.get(B.coin)}), which is why the runbook drains first (8.3)`);
  console.log(`LL-1: A drained in ${drained} runs, first buyer ${Number(pnl.get(A.coin)) / 1e9} SOL; B undrained, ${held} runs, first buyer ${Number(pnl.get(B.coin)) / 1e9} SOL`);
  await w.finish();
});
