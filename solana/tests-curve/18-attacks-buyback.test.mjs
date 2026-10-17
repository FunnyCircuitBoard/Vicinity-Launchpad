// Attacks on the buyback (7.1 to 7.3, T23 to T26, T61, T76), on chain with the
// exact bounds of the specification: X23 a buyback that stops at S - 1 bundled
// with a 0.0001 SOL buy that graduates the coin for 1 lamport, in one
// transaction; X24 the canonical sandwich (attacker buy, one run, attacker sell)
// on the curve and in the pool for several sizes, against Theorem M, and by the
// founder credited his share (and his and the holders' shares); X25 the bundled
// multi-leg sandwich (three buy legs, the run, three sell legs in one
// transaction) against the split-leg bound, at most one run per bundle, and the
// hold through K runs of a seeded backlog against Theorem M_K (a loss below K*,
// the bound at every K); X26 the crank called at every interval (timing changes
// only how many coins are burned); X61 a hostile crank caller; HR-1 the
// platform's key, credited b_P of its own legs, which V8 and V11 do not count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, S, expectFail, mintInfo, offlineKey, LAMPORTS } from './helpers.mjs';

const T = S.DEFAULT_TERMS;
const D = S.BPS;
const t = T.totalFeeBps;
const CD = S.BUYBACK_CAP_DIVISOR * D; // 1 / s
const view = (w, h) => w.coinView(h);
const st = (w, h) => S.coinState(w.coinView(h));
const fingerprint = (w, addrs) => addrs.map((a) => { const x = w.accountInfo(a); return x ? `${a}:${x.lamports}:${x.data.toString('hex')}` : `${a}:none`; });
const ROUNDING = 16n; // lamports of integer rounding allowed per bound (a few per leg, 7.3)

/** A coin whose buyback bucket holds more than one run's cap, built by other traders' round trips (the curve ends where it started). */
async function coinWithBacklog(w, cityId, symbol, { churn = 2, size = 20n, graduate = false, founder } = {}) {
  const h = await w.launchCoin({ cityId, symbol, founder });
  const others = await w.signer(5_000n);
  for (let k = 0; k < churn; k++) { const b = await w.buy(others, h, size * LAMPORTS, { label: 'others churn' }); await w.sell(others, h, b.q.tokensOut, { label: 'others churn' }); }
  if (graduate) {
    await w.buy(others, h, 100n * LAMPORTS, { label: 'others graduate the coin' });
    await w.sell(others, h, w.balanceOf(others, h.mint), { label: 'others sell out' });
  }
  w.warpSlots(150n);
  return { h, others };
}
/** Theorem M (7.3): back * (CD)^2 * D^2 <= a * (CD + t)^2 * legs, with `legs` the product of the two legs' factors over D^2. */
const withinM = (back, a, legsNum) => back * CD * CD * D * D <= a * (CD + t) * (CD + t) * legsNum + ROUNDING * CD * CD * D * D;
const ratio = (x, y) => Number(x) / Number(y);

// ---------------------------------------------------------------- X23
test('X23 a buyback that stops at S - 1 and a 0.0001 SOL buy that graduates the coin for 1 lamport, bundled in one transaction', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1800n, symbol: 'BUND' });
  const u = await w.signer(500n); const v = await w.signer(10n);
  await w.buy(u, h, S.grossFor(T, T.graduationSol - 1_000n), { label: 'curve 1,000 lamports short of R' });
  w.warpSlots(150n);
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: v.address, owner: v.address, mint: h.mint })], [v], 'v\'s token account');
  w.addHolder(h.mint, v);
  const v0 = w.lamportsOf(v.address);
  const r = await w.send([w.ix.buybackBurn({ coin: h.coin }), w.ix.buy({ user: v.address, coin: h.coin, solIn: S.MIN_TRADE_LAMPORTS, minTokensOut: 0n })], [v], 'buyback + 0.0001 SOL buy, one transaction');
  const bb = r.events.find((e) => e.name === 'BuybackBurned').data;
  const tr = r.events.find((e) => e.name === 'Trade').data;
  assert.equal(bb.sol_spent, 999n, 'the buyback stopped at f(S - 1) = R - 1');
  assert.deepEqual([tr.sol_amount, tr.fee, tr.token_amount, tr.partial, tr.graduated], [1n, 0n, 1n, true, true], 'the buy paid 1 lamport for the last raw unit');
  assert.equal(r.events.filter((e) => e.name === 'Graduated').length, 1);
  assert.equal(v0 - w.lamportsOf(v.address), 1n);
  assert.deepEqual([view(w, h).phase, view(w, h).curveSol, view(w, h).poolSol], [1, T.graduationSol, T.graduationSol], 'graduation exactly at R (V7: the timing is harmless)');
  await w.finish();
});

// ---------------------------------------------------------------- X24
test('X24 the canonical sandwich on chain (attacker buy, one run, attacker sell): within Theorem M on the curve and in the pool at every size; never a profit for the founder credited his share or his and the holders\' shares', async () => {
  const w = await World.create();
  const legsCurve = (D - t) * (D - t);
  const legsPool = (D - t) * (D - t + 2n * T.liquidityBps);
  const best = { curve: -1, pool: -1, founder: -1, founderHolders: -1 };
  let city = 1810n;
  for (const graduate of [false, true]) {
    for (const a of [S.MIN_TRADE_LAMPORTS, LAMPORTS, 10n * LAMPORTS, 50n * LAMPORTS]) {
      const { h } = await coinWithBacklog(w, city, `SW${city}`, { graduate });
      city++;
      const c0 = view(w, h);
      const cap = S.buybackCap(T, st(w, h));
      assert.ok(c0.buybackPending > cap, 'the bucket exceeds the cap: the run spends a full step');
      const atk = await w.signer(100n);
      const b = await w.buy(atk, h, a, { label: 'front-run' });
      const r = await w.buyback(h, { label: 'the run' });
      const spent = r.events[0].data.sol_spent;
      const s = await w.sell(atk, h, b.q.tokensOut, { label: 'back-run' });
      const back = s.q.solOut;
      assert.ok(back < b.q.charged, `${graduate ? 'pool' : 'curve'} ${a}: a loss`);
      assert.ok(withinM(back, b.q.charged, graduate ? legsPool : legsCurve), `Theorem M: ${back} of ${b.q.charged} (spent ${spent})`);
      const k = graduate ? 'pool' : 'curve';
      best[k] = Math.max(best[k], ratio(back, b.q.charged));
    }
  }
  assert.ok(best.curve <= 0.9526, `curve best ${best.curve}: a loss of at least 4.74% (Theorem M 0.95253)`);
  assert.ok(best.pool <= 0.9623, `pool best ${best.pool}: a loss of at least 3.77% (Theorem M 0.96230)`);
  // the founder sandwiches his own coin's buyback: credited his share of both legs (7.3: at most (1+s)^2 (1-f+2l)(1-f+c) + c)
  for (const graduate of [false, true]) {
    const founder = await w.signer(200n);
    const { h } = await coinWithBacklog(w, city, `SWF${city}`, { graduate, founder });
    city++;
    await w.claim(h, founder, { label: 'founder empties his bucket first' });
    const a = 10n * LAMPORTS;
    const l0 = w.lamportsOf(founder.address);
    const b = await w.buy(founder, h, a, { label: 'founder front-runs' });
    await w.buyback(h, { label: 'the run' });
    const s = await w.sell(founder, h, b.q.tokensOut, { label: 'founder back-runs' });
    await w.claim(h, founder, { label: 'founder claims his share of his legs' });
    const ataRent = w.svm.minimumBalanceForRentExemption(165n);
    const back = w.lamportsOf(founder.address) - (l0 - b.q.charged - ataRent);
    assert.equal(back, s.q.solOut + b.q.split.founder + s.q.split.founder, 'proceeds plus his own founder shares');
    const c = T.founderBps;
    const l = graduate ? T.liquidityBps : 0n;
    // (1+s)^2 (1-f+2l)(1-f+c) + c, over (CD)^2 D^2
    const lhs = back * CD * CD * D * D;
    const rhs = b.q.charged * ((CD + t) * (CD + t) * (D - t + 2n * l) * (D - t + c) + c * CD * CD * D) + ROUNDING * CD * CD * D * D;
    assert.ok(lhs <= rhs, `founder-credited bound (${graduate ? 'pool' : 'curve'})`);
    assert.ok(back < b.q.charged, 'still a loss');
    best.founder = Math.max(best.founder, ratio(back, b.q.charged));
    // and credited the holders' share of his legs too: never a profit (NOTES entry 13)
    const withHolders = back + b.q.split.holders + s.q.split.holders;
    assert.ok(withHolders < b.q.charged, 'never a profit credited the founder and holders shares');
    best.founderHolders = Math.max(best.founderHolders, ratio(withHolders, b.q.charged));
  }
  assert.ok(best.founder <= 0.9723, `founder best ${best.founder}: at least 2.78% (7.3)`);
  console.log(`X24 best results: curve ${best.curve.toFixed(5)}, pool ${best.pool.toFixed(5)}, founder credited ${best.founder.toFixed(5)}, founder and holders credited ${best.founderHolders.toFixed(5)}`);
  await w.finish();
});

// ---------------------------------------------------------------- X25
test('X25 the bundled multi-leg sandwich (three buys, the run, three sells in one transaction) stays within the split-leg bound; a bundle holds at most one run', async () => {
  const w = await World.create();
  let city = 1830n;
  const best = { curve: -1, pool: -1 };
  for (const graduate of [false, true]) {
    for (const a of [3n * LAMPORTS, 30n * LAMPORTS]) {
      const { h } = await coinWithBacklog(w, city, `ML${city}`, { graduate });
      city++;
      const atk = await w.signer(100n);
      await w.send([S.createAssociatedTokenAccountIdempotent({ payer: atk.address, owner: atk.address, mint: h.mint })], [atk], 'token account');
      w.addHolder(h.mint, atk);
      const l0 = w.lamportsOf(atk.address);
      // the bundle: the sell legs are sized from the model of the state after the buy legs and the run
      let s0 = st(w, h);
      const legs = [a / 3n, a / 3n, a - 2n * (a / 3n)];
      let bought = 0n;
      for (const g of legs) { const q = S.quoteBuy(T, s0, g); bought += q.tokensOut; s0 = q.newState; }
      const sells = [bought / 3n, bought / 3n, bought - 2n * (bought / 3n)];
      const ixs = [...legs.map((g) => w.ix.buy({ user: atk.address, coin: h.coin, solIn: g, minTokensOut: 0n })), w.ix.buybackBurn({ coin: h.coin }),
        ...sells.map((n) => w.ix.sell({ user: atk.address, coin: h.coin, tokensIn: n, minSolOut: 0n }))];
      const r = await w.send(ixs, [atk], `multi-leg bundle ${a}`);
      assert.equal(r.events.filter((e) => e.name === 'BuybackBurned').length, 1, 'the run happened inside the bundle');
      const back = w.lamportsOf(atk.address) - (l0 - a);
      // split-leg bound without credit: (1+s)^2 (1-f+2l)^2
      const l = graduate ? T.liquidityBps : 0n;
      assert.ok(withinM(back, a, (D - t + 2n * l) * (D - t + 2n * l)), `split-leg bound: ${back} of ${a}`);
      assert.ok(back < a, 'a loss');
      best[graduate ? 'pool' : 'curve'] = Math.max(best[graduate ? 'pool' : 'curve'], ratio(back, a));
    }
  }
  // at most one run per coin per bundle: [run, buy, run, sell, run] spends one step
  const { h } = await coinWithBacklog(w, city, 'ONERUN');
  const atk = await w.signer(50n);
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: atk.address, owner: atk.address, mint: h.mint })], [atk], 'token account');
  w.addHolder(h.mint, atk);
  const q = S.quoteBuy(T, st(w, h), LAMPORTS);
  const r = await w.send([w.ix.buybackBurn({ coin: h.coin }), w.ix.buy({ user: atk.address, coin: h.coin, solIn: LAMPORTS, minTokensOut: 0n }), w.ix.buybackBurn({ coin: h.coin }),
    w.ix.sell({ user: atk.address, coin: h.coin, tokensIn: q.tokensOut / 2n, minSolOut: 0n }), w.ix.buybackBurn({ coin: h.coin })], [atk], 'three cranks in one bundle');
  assert.equal(r.events.filter((e) => e.name === 'BuybackBurned').length, 1);
  assert.ok(best.curve <= 0.9526 && best.pool <= 0.9723, `best multi-leg results: curve ${best.curve}, pool ${best.pool}`);
  console.log(`X25 multi-leg best results: curve ${best.curve.toFixed(5)}, pool ${best.pool.toFixed(5)} (split-leg bound 0.95253 / 0.97217)`);
  await w.finish();
});

test('X25, T76 holding through K runs of a seeded backlog (Theorem M_K): a loss for every K below K* (26 on the curve, 21 in the pool), within (1 + B/X1)^2 (1-f)(1-f+2l) at every K', async () => {
  const w = await World.create();
  const report = [];
  for (const [graduate, kStar, size, churn] of [[false, 26, 40n, 4], [true, 21, 200n, 4]]) {
    const { h } = await coinWithBacklog(w, graduate ? 1841n : 1840n, graduate ? 'HOLDP' : 'HOLDC', { graduate, churn, size });
    const atk = await w.signer(10n);
    const a = LAMPORTS / 10n;
    const b = await w.buy(atk, h, a, { label: 'buy before the backlog runs' });
    const X1 = S.depth(T, st(w, h));
    const backlog = view(w, h).buybackPending;
    const uStarPct = graduate ? 2.042 : 2.564;
    let B = 0n; let K = 0;
    const l = graduate ? T.liquidityBps : 0n;
    let lastLossK = 0; let firstProfitK = null;
    while (view(w, h).buybackPending > 0n && K < 60) {
      w.warpSlots(150n);
      const r = await w.buyback(h, { label: `run ${K + 1}` });
      B += r.events[0].data.sol_spent; K++;
      // what selling now would return (the model of the next sell from this exact state)
      const back = S.quoteSell(T, st(w, h), b.q.tokensOut).solOut;
      const lhs = back * X1 * X1 * D * D;
      const rhs = b.q.charged * (X1 + B) * (X1 + B) * (D - t) * (D - t + 2n * l) + ROUNDING * X1 * X1 * D * D;
      assert.ok(lhs <= rhs, `M_K at K = ${K}: ${back} of ${b.q.charged}, B/X1 = ${ratio(B, X1)}`);
      if (back < b.q.charged) lastLossK = K; else if (firstProfitK === null) firstProfitK = K;
      if (K < kStar) assert.ok(back < b.q.charged, `K = ${K} < K* = ${kStar}: still a loss`);
      if (ratio(B, X1) * 100 <= uStarPct) assert.ok(back < b.q.charged, `B/X1 = ${(ratio(B, X1) * 100).toFixed(3)}% <= u*: a loss`);
    }
    const s = await w.sell(atk, h, b.q.tokensOut, { label: 'sell after the hold' });
    const result = ratio(s.q.solOut, b.q.charged) - 1;
    report.push(`${graduate ? 'pool' : 'curve'}: backlog ${backlog} lamports = ${(ratio(backlog, X1) * 100).toFixed(2)}% of depth, ${K} runs spent ${B}; loss through K = ${lastLossK}${firstProfitK ? `, first profit at K = ${firstProfitK}` : ''}; held to the end: ${(result * 100).toFixed(3)}%`);
  }
  console.log(`X25/T76 hold-through: ${report.join(' | ')}`);
  await w.finish();
});

// ---------------------------------------------------------------- X26
test('X26 the crank called at every interval (or every slot) only changes how many coins are burned: every run within its cap, the whole bucket spent either way, the caller paid nothing', async () => {
  const w = await World.create();
  const A = await w.launchCoin({ cityId: 1850n, symbol: 'CRNKA' });
  const B = await w.launchCoin({ cityId: 1851n, symbol: 'CRNKB' });
  const uA = await w.signer(500n); const uB = await w.signer(500n);
  const k0 = w.lamportsOf(w.keeper.address);
  let fees = 0n; let runsA = 0;
  // the same trades on both; coin A cranked at every chance (every slot of the interval included), coin B never during trading
  for (let round = 0; round < 6; round++) {
    await w.buy(uA, A, 5n * LAMPORTS, { label: `A buy ${round}` }); await w.buy(uB, B, 5n * LAMPORTS, { label: `B buy ${round}` });
    for (let slot = 0; slot < 3; slot++) {
      const r = await w.buyback(A, { label: `A crank ${round}.${slot}` });
      fees += 5_000n;
      for (const e of r.events) { runsA++; assert.ok(e.data.sol_spent <= e.data.cap); }
      w.warpSlots(1n);
    }
    w.warpSlots(150n);
    const r = await w.buyback(A, { label: `A crank ${round} after the interval` });
    fees += 5_000n;
    assert.equal(r.events.length, 1);
    runsA++;
  }
  // coin B: cranked only now, once per interval until the bucket is empty
  let runsB = 0;
  while (view(w, B).buybackPending > 0n) {
    w.warpSlots(150n);
    const r = await w.buyback(B, { label: `B crank ${runsB}` });
    fees += 5_000n;
    assert.equal(r.events.length, 1); assert.ok(r.events[0].data.sol_spent <= r.events[0].data.cap);
    runsB++;
  }
  while (view(w, A).buybackPending > 0n) { w.warpSlots(150n); await w.buyback(A, { label: 'A last crank' }); fees += 5_000n; runsA++; }
  for (const h of [A, B]) assert.equal(view(w, h).buybackSpent, view(w, h).buybackEarned, 'the whole bucket spent');
  assert.equal(view(w, A).buybackEarned, view(w, B).buybackEarned, 'the same money accrued');
  assert.notEqual(view(w, A).tokensBurned, view(w, B).tokensBurned, 'timing changed only how many coins were burned');
  assert.ok(runsA > runsB);
  assert.equal(w.lamportsOf(w.keeper.address), k0 - fees, 'the caller paid the fees and received nothing');
  console.log(`X26: frequent cranks ${runsA} runs burned ${view(w, A).tokensBurned}; late cranks ${runsB} runs burned ${view(w, B).tokensBurned}`);
  await w.finish();
});

// ---------------------------------------------------------------- X61
test('X61 a hostile crank caller chooses nothing and receives nothing: extra data, read-only accounts, a 0-lamport fee payer, repeated calls', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1860n, symbol: 'HOST' });
  const u = await w.signer(100n);
  await w.buy(u, h, 20n * LAMPORTS);
  await w.initRewardsCity(h);
  w.warpSlots(150n);
  const caller = await w.signer(1n);
  const watch = [h.coin, h.mint, h.vault];
  const refuse = async (fn, ...codes) => { const before = fingerprint(w, watch); await expectFail(fn, ...codes); assert.deepEqual(fingerprint(w, watch), before); };
  // read-only where the program writes: refused by the account constraints
  for (const slot of ['coin', 'mint', 'coin_vault']) {
    const ix = w.ix.buybackBurn({ coin: h.coin });
    const i = S.ACCOUNT_TABLES.buyback_burn.findIndex(([n]) => n === slot);
    const bad = { ...ix, accounts: ix.accounts.map((m, k) => (k === i ? { ...m, role: S.Role.R } : m)) };
    await refuse(() => w.send([bad], [], `buyback with ${slot} read-only`, { feePayer: caller }), 'ConstraintMut', /writable|privilege|ReadonlyDataModified|ExternalAccountDataModified|read-only/i);
  }
  for (const [name, ix] of [['withdraw', w.ix.withdrawPlatformFees({ coin: h.coin })], ['forward', w.ix.forwardHoldersFees({ coin: h.coin })]]) {
    const i = ix.accounts.findIndex((m) => m.address === h.coin);
    await refuse(() => w.send([{ ...ix, accounts: ix.accounts.map((m, k) => (k === i ? { ...m, role: S.Role.R } : m)) }], [], `${name} with the Coin read-only`, { feePayer: caller }), 'ConstraintMut');
  }
  // arguments appended to an instruction that takes none are ignored: the run is exactly the model's
  const q = S.quoteBuyback(T, st(w, h), w.slot());
  const extra = w.ix.buybackBurn({ coin: h.coin });
  const c0 = w.lamportsOf(caller.address);
  const r = await w.send([{ ...extra, data: new Uint8Array([...extra.data, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]) }], [], 'buyback with 8 bytes of "arguments"', { feePayer: caller });
  assert.deepEqual([r.events[0].data.sol_spent, r.events[0].data.tokens_burned], [q.spent, q.coins], 'the caller chose nothing');
  assert.equal(w.lamportsOf(caller.address), c0 - 5_000n, 'and received nothing');
  // calling again at once, and twenty times in one transaction: no-ops
  const again = await w.send(Array.from({ length: 20 }, () => w.ix.buybackBurn({ coin: h.coin })), [], 'twenty cranks in one transaction', { feePayer: caller });
  assert.equal(again.events.length, 0);
  // withdraw and forward pay only their fixed destinations whoever calls them
  const supply0 = mintInfo(w.accountInfo(h.mint)).supply;
  const fr0 = w.lamportsOf(S.ADDRESSES.feeRecipient);
  const pending = view(w, h).platformPending;
  await w.withdraw(h, { feePayer: caller, label: 'withdraw by the hostile caller' });
  assert.equal(w.lamportsOf(S.ADDRESSES.feeRecipient) - fr0, pending);
  await w.forward(h, { feePayer: caller, label: 'forward by the hostile caller' });
  assert.equal(w.lamportsOf(caller.address), c0 - 4n * 5_000n);
  assert.equal(mintInfo(w.accountInfo(h.mint)).supply, supply0);
  // a fee payer with no lamports cannot even start: refused before execution, it pays no fee and nothing moves (the
  // failed-transaction check knows such a refusal charges nothing, L2)
  const broke = await w.signer(0n);
  w.warpSlots(150n);
  await w.buy(u, h, LAMPORTS);
  const before = fingerprint(w, watch);
  await refuse(() => w.send([w.ix.buybackBurn({ coin: h.coin })], [], 'buyback paid by a 0-lamport fee payer', { feePayer: broke }), /AccountNotFound|InsufficientFundsForFee/);
  assert.deepEqual(fingerprint(w, watch), before);
  assert.equal(w.lamportsOf(broke.address), 0n);
  await w.finish();
});

// ---------------------------------------------------------------- 7.3: a backlog made by the attacker himself
test('X25, T76 a backlog the attacker makes himself by wash trading (as founder, credited his share), then holds through every run: a loss at every position size (7.3: at least 4 lamports of fees per lamport of backlog)', async () => {
  const w = await World.create();
  const report = [];
  let city = 1870n;
  for (const graduate of [false, true]) {
    for (const a of [LAMPORTS, 20n * LAMPORTS]) {
      const founder = await w.signer(3_000n);
      const h = await w.launchCoin({ cityId: city, symbol: `SELF${city}`, founder });
      city++;
      const others = await w.signer(500n);
      if (graduate) { await w.buy(others, h, 100n * LAMPORTS, { label: 'others graduate the coin' }); w.warpSlots(150n); while (view(w, h).buybackPending > 0n) { await w.buyback(h, { label: 'clear the graduation backlog' }); w.warpSlots(150n); } }
      await w.claim(h, founder, { label: 'founder starts with an empty bucket' });
      const l0 = w.lamportsOf(founder.address);
      // wash trading: round trips of 40 SOL until the backlog is over 3% of depth (above u*), each run's cap kept from spending it
      while (view(w, h).buybackPending * 100n < 3n * S.depth(T, st(w, h))) {
        const b = await w.buy(founder, h, 40n * LAMPORTS, { label: 'wash buy' });
        await w.sell(founder, h, b.q.tokensOut, { label: 'wash sell' });
      }
      const backlog = view(w, h).buybackPending;
      const b = await w.buy(founder, h, a, { label: 'the position' });
      let runs = 0;
      while (view(w, h).buybackPending > 0n && runs < 80) { w.warpSlots(150n); await w.buyback(h, { label: `run ${runs + 1}` }); runs++; }
      await w.sell(founder, h, b.q.tokensOut, { label: 'sell after the hold' });
      await w.claim(h, founder, { label: 'founder claims his share of everything he paid' });
      const pnl = w.lamportsOf(founder.address) - l0 + w.svm.minimumBalanceForRentExemption(165n);
      assert.ok(pnl < 0n, `${graduate ? 'pool' : 'curve'}, position ${a}: ${pnl}`);
      report.push(`${graduate ? 'pool' : 'curve'}: backlog ${(Number(backlog) / 1e9).toFixed(3)} SOL made by wash trading, position ${Number(a) / 1e9} SOL held through ${runs} runs: ${(Number(pnl) / 1e9).toFixed(4)} SOL`);
    }
  }
  console.log(`self-made backlog: ${report.join(' | ')}`);
  await w.finish();
});

// ---------------------------------------------------------------- HR-1: the platform's key in the MEV rules
test('HR-1 the platform\'s key is credited b_P of its own legs, which V8 and V11 do not count: (0, 120, 0, 1, 1) passes V1 to V11, and FEE_RECIPIENT\'s canonical single-run sandwich returns a profit where a plain trader loses (why 8.4 keeps it out of city coins); the clients\' sandwich threshold counts it', async () => {
  const w = await World.create();
  w.svm.withSigverify(false); // FEE_RECIPIENT is the owner's key; with signature checks off its transactions show what its holder could do
  const params = { ...S.DEFAULT_CONFIG, liquidityBps: 0n, platformBps: 120n, founderBps: 0n, holdersBps: 1n, buybackBps: 1n };
  assert.equal(S.configRule(params), null, 'V1 to V11 pass');
  const configId = await w.addConfig(params);
  const terms = S.termsFromParams(params);
  // the clients count the platform's credit (5.15): its cost per leg is t - b_P = 2 bps, not t - (b_F + b_H) = 121
  assert.equal(S.cheapestAttackerCostBps(terms), 2n);
  const fee = offlineKey(S.ADDRESSES.feeRecipient);
  w.svm.airdrop(fee.address, 10n * LAMPORTS);
  const out = [];
  for (const who of ['FEE_RECIPIENT', 'plain']) {
    const h = await w.launchCoin({ cityId: who === 'plain' ? 1_961n : 1_960n, symbol: who === 'plain' ? 'PLAIN' : 'PLATK', configId });
    const others = await w.signer(5_000n);
    // other traders' curve round trips build a backlog of more than one run's cap (the curve ends where it started)
    for (;;) {
      const c = w.coinView(h);
      if (c.buybackPending >= 3n * S.buybackCap(terms, S.coinState(c))) break;
      const b = await w.buy(others, h, 20n * LAMPORTS, { label: 'others buy' });
      await w.sell(others, h, b.q.tokensOut, { label: 'others sell' });
    }
    w.warpSlots(200n);
    const actor = who === 'plain' ? await w.signer(100n) : fee;
    await w.send([S.createAssociatedTokenAccountIdempotent({ payer: w.payer.address, owner: actor.address, mint: h.mint })], [], 'the actor\'s token account');
    if (who === 'FEE_RECIPIENT') await w.withdraw(h, { label: 'the platform share so far' });
    const l0 = w.lamportsOf(actor.address);
    const position = 5n * LAMPORTS;
    const b = await w.buy(actor, h, position, { label: `${who}: front-run` });
    await w.buyback(h, { label: `${who}: the one run` });
    await w.sell(actor, h, b.q.tokensOut, { label: `${who}: back-run` });
    if (who === 'FEE_RECIPIENT') await w.withdraw(h, { label: 'the platform share of its own legs' });
    const pnl = w.lamportsOf(actor.address) - l0;
    out.push(`${who} ${pnl} lamports (${(Number(pnl) * 100 / Number(position)).toFixed(4)}%)`);
    if (who === 'plain') assert.ok(pnl * 100n < -position, `a plain trader loses more than 1% (${pnl})`);
    else assert.ok(pnl > 0n, `FEE_RECIPIENT gains from a single run (${pnl}): outside V8's bound, so the operating rule of 8.4`);
  }
  console.log(`HR-1 single-run sandwich under (0, 120, 0, 1, 1): ${out.join(', ')}`);
  await w.finish();
});
