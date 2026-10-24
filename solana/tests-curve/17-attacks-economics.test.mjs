// Economically motivated attacks of 12.4 and section 10, with exact numbers:
// X07 and X08 donations of lamports and coins to a Coin and its vault through a
// whole life (a twin coin without donations gives the same state, the same
// quotes and the same balances at every step, and the donation can never be
// taken out), X09 and X12 rounding farming and fee dodging with many tiny trades
// on the curve (the saving is below one lamport per trade, against 5,000 per
// signature), X10 the same in the pool, X11 round trips on the curve, in the pool
// and across graduation against 5.15's bounds, X28 dust sells against the drip,
// X27 drip farming by the founder holding the whole float (credited the founder,
// holders and buyback shares of his own legs), X27b the same on the V10 edge
// config (50, 51, 50, 50, 30), and (50, 50, 50, 50, 30) refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, S, expectFail, LAMPORTS, DAY } from './helpers.mjs';

const T = S.DEFAULT_TERMS;
const D = S.BPS;
const view = (w, h) => w.coinView(h);
const st = (w, h) => S.coinState(w.coinView(h));
const sysTransfer = (from, to, n) => ({ programAddress: S.ADDRESSES.system, accounts: [{ address: String(from), role: S.Role.WS }, { address: String(to), role: S.Role.W }],
  data: new Uint8Array([2, 0, 0, 0, ...Buffer.from(new BigUint64Array([BigInt(n)]).buffer)]) });
const tokenTransfer = (src, dst, owner, n) => ({ programAddress: S.ADDRESSES.token, accounts: [{ address: src, role: S.Role.W }, { address: dst, role: S.Role.W }, { address: String(owner), role: S.Role.RS }],
  data: new Uint8Array([3, ...Buffer.from(new BigUint64Array([BigInt(n)]).buffer)]) });
const fees = (r) => r.res.events.filter((e) => e.name === 'Trade').reduce((s, e) => s + e.data.fee, 0n);
const pct = (num, den) => (Number(num) / Number(den)) * 100;

// ---------------------------------------------------------------- X07, X08
test('X07, X08 donations of lamports and coins through a whole life: a twin coin without them has the same state, quotes and balances at every step; the donation can never be taken out', async () => {
  const w = await World.create();
  const donor = await w.signer(500n);
  // coin A is donated to before launch (its Coin pre-funded above rent), on the curve and in the pool; coin B never
  const fA = await w.signer(5n); const fB = await w.signer(5n);
  await w.approve({ cityId: 1700n, founder: fA, symbol: 'DONA' });
  await w.approve({ cityId: 1701n, founder: fB, symbol: 'DONB' });
  const rentCoin = w.svm.minimumBalanceForRentExemption(693n);
  const pre = rentCoin + 1_000_000n;
  let lamportDonated = pre - rentCoin;
  await w.send([sysTransfer(donor.address, w.P.coin(1700n), pre)], [donor], 'pre-fund coin A above rent', { lamportDonation: { coin: w.P.coin(1700n), amount: lamportDonated } });
  const A = await w.launch({ cityId: 1700n, founder: fA });
  const B = await w.launch({ cityId: 1701n, founder: fB });
  for (const h of [A, B]) await w.initRewardsCity(h);
  const pk = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: pk.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = pk;
  for (const [h, f] of [[A, fA], [B, fB]]) await w.send([w.ix.optInPayout({ founder: f.address, coin: h.coin, expectedDestination: wallet.address, refHash: Array(32).fill(6) })], [f], 'opt in');
  // twin traders: what each does on A, its twin does on B
  const users = { A: [await w.signer(300n), await w.signer(300n)], B: [await w.signer(300n), await w.signer(300n)] };
  const d = { A: await w.signer(50n), B: await w.signer(50n) }; // coin donors: each buys the same, only A's donates his coins
  const twin = async (label, fn) => {
    const before = { A: users.A.map((u) => w.lamportsOf(u.address)), B: users.B.map((u) => w.lamportsOf(u.address)) };
    const fa = w.lamportsOf(fA.address) - w.lamportsOf(fB.address);
    await fn(A, users.A, 'A'); await fn(B, users.B, 'B');
    assert.deepEqual(st(w, A), st(w, B), `${label}: same state`);
    for (const k of ['founderClaimed', 'founderPaidOut', 'platformWithdrawn', 'holdersForwarded', 'payoutSeq', 'lastPayoutAt']) assert.equal(view(w, A)[k], view(w, B)[k], `${label}: ${k}`);
    for (const i of [0, 1]) assert.equal(w.lamportsOf(users.A[i].address) - before.A[i], w.lamportsOf(users.B[i].address) - before.B[i], `${label}: trader ${i} got the same`);
    assert.equal(w.lamportsOf(fA.address) - w.lamportsOf(fB.address), fa, `${label}: the founders got the same`);
    for (const i of [0, 1]) assert.equal(w.balanceOf(users.A[i], A.mint), w.balanceOf(users.B[i], B.mint), `${label}: trader ${i} holds the same`);
  };
  const donateLamports = async (n, label) => {
    await w.send([sysTransfer(donor.address, A.coin, n)], [donor], label, { lamportDonation: { coin: A.coin, amount: n } });
    lamportDonated += n;
  };
  let coinsDonated = 0n;
  const surplus = (h) => { const c = view(w, h); return w.lamportsOf(h.coin) - c.rentReserve - S.liabilities(S.coinState(c)); };
  // the curve
  await twin('buys', async (h, [u, v]) => { await w.buy(u, h, 10n * LAMPORTS, { label: `buy ${h.cityId}` }); await w.buy(v, h, 3n * LAMPORTS, { label: `buy ${h.cityId}` }); });
  await donateLamports(5n * LAMPORTS, 'donate 5 SOL to coin A on the curve');
  await twin('coin donors buy', async (h, _, k) => { await w.buy(d[k], h, 2n * LAMPORTS, { label: `donor buys ${k}` }); });
  const give = w.balanceOf(d.A, A.mint) / 2n;
  await w.send([tokenTransfer(S.associatedTokenAddress(d.A.address, A.mint), A.vault, d.A.address, give)], [d.A], 'donate coins to coin A\'s vault (curve)', { tokenDonation: true });
  coinsDonated += give;
  await twin('sells after the donations', async (h, [u]) => { await w.sell(u, h, w.balanceOf(u, h.mint) / 2n, { label: `sell ${h.cityId}` }); });
  w.warpSlots(150n); w.warpSecs(DAY);
  await twin('buyback, withdraw, claim, forward, payout', async (h, _, k) => {
    await w.buyback(h, { label: `buyback ${k}` }); await w.withdraw(h, { label: `withdraw ${k}` });
    await w.claim(h, k === 'A' ? fA : fB, { label: `claim ${k}` }); await w.forward(h, { label: `forward ${k}` });
  });
  await twin('graduation', async (h, [, v]) => { await w.buy(v, h, 100n * LAMPORTS, { label: `graduate ${h.cityId}` }); });
  assert.equal(view(w, A).phase, 1);
  // the pool
  await donateLamports(7n * LAMPORTS, 'donate 7 SOL to coin A in the pool');
  const give2 = w.balanceOf(d.A, A.mint);
  await w.send([tokenTransfer(S.associatedTokenAddress(d.A.address, A.mint), A.vault, d.A.address, give2)], [d.A], 'donate coins to coin A\'s vault (pool)', { tokenDonation: true });
  coinsDonated += give2;
  await twin('pool trades', async (h, [u, v]) => {
    await w.buy(u, h, 20n * LAMPORTS, { label: `pool buy ${h.cityId}` });
    await w.sell(v, h, w.balanceOf(v, h.mint) / 3n, { label: `pool sell ${h.cityId}` });
  });
  w.warpSlots(150n); w.warpSecs(DAY);
  await twin('pool buyback and payouts', async (h, _, k) => { await w.buyback(h, { label: `pool buyback ${k}` }); await w.payout(h, { destination: wallet.address, label: `payout ${k}` }); });
  // everyone leaves, every bucket is paid out
  await twin('everyone sells everything', async (h, [u, v]) => {
    await w.sell(u, h, w.balanceOf(u, h.mint), { label: `exit ${h.cityId}` });
    await w.sell(v, h, w.balanceOf(v, h.mint), { label: `exit ${h.cityId}` });
  });
  w.warpSlots(150n); w.warpSecs(DAY);
  await twin('final payouts', async (h, _, k) => {
    await w.withdraw(h, { label: `withdraw ${k}` }); await w.claim(h, k === 'A' ? fA : fB, { label: `claim ${k}` }); await w.forward(h, { label: `forward ${k}` });
  });
  // the donations are exactly the surplus: no instruction ever paid any of it out
  assert.equal(surplus(A), lamportDonated, `coin A keeps all ${lamportDonated} donated lamports`);
  assert.equal(surplus(B), 0n);
  assert.equal(w.tokenBalance(A.vault) - view(w, A).poolTokens, coinsDonated, 'coin A\'s vault keeps every donated coin');
  assert.equal(w.tokenBalance(B.vault), view(w, B).poolTokens);
  // a seller of every last coin of A cannot reach the donated coins: the pool math uses pool_tokens, not the vault balance
  assert.deepEqual(S.spotPrice(T, st(w, A)), S.spotPrice(T, st(w, B)));
  await w.finish();
});

// ---------------------------------------------------------------- X09, X12
test('X09, X12 rounding farming and fee dodging on the curve: 60 tiny trades save less than one lamport each against one round trip of the same size, and pay 5,000 lamports per signature', async () => {
  const w = await World.create();
  const A = await w.launchCoin({ cityId: 1710n, symbol: 'TINYA' });
  const B = await w.launchCoin({ cityId: 1711n, symbol: 'TINYB' });
  const atk = await w.signer(10n); const ref = await w.signer(10n);
  // 30 buys of 100,039 lamports: each fee is floor(2,500.975) = 2,500, the most a buy can save by rounding (0.975 lamport)
  const g = 100_039n; const N = 30;
  const a0 = w.lamportsOf(atk.address);
  let atkFees = 0n;
  for (let k = 0; k < N; k++) {
    const r = await w.buy(atk, A, g, { label: `tiny buy ${k}` });
    atkFees += fees(r);
    assert.equal(r.q.charged, g);
    assert.equal(r.q.net, g - 2_500n, 'c == n: the curve adds exactly the net, no dust (Theorem C)');
  }
  const ataRent = w.svm.minimumBalanceForRentExemption(165n);
  // sell everything back in 30 pieces, packed 10 per transaction (T12: about 25 to 40 sells fit one transaction)
  const total = w.balanceOf(atk, A.mint);
  const piece = total / BigInt(N);
  for (let tx = 0; tx < 3; tx++) {
    const ixs = [];
    for (let k = 0; k < 10; k++) ixs.push(w.ix.sell({ user: atk.address, coin: A.coin, tokensIn: tx === 2 && k === 9 ? total - piece * 29n : piece, minSolOut: 0n }));
    const r = await w.send(ixs, [atk], `10 tiny sells (${tx})`);
    atkFees += r.events.filter((e) => e.name === 'Trade').reduce((s, e) => s + e.data.fee, 0n);
  }
  assert.deepEqual([view(w, A).tokensSold, view(w, A).curveSol], [0n, 0n], 'the curve is back at 0: path independence');
  const atkLoss = a0 - w.lamportsOf(atk.address) - ataRent;
  assert.equal(atkLoss, atkFees, 'the attacker lost exactly the fees he paid, to the lamport');
  // the reference: one buy of the same total and one sell, on the twin coin
  const r0 = w.lamportsOf(ref.address);
  const rb = await w.buy(ref, B, g * BigInt(N), { label: 'one buy of the same total' });
  const rs = await w.sell(ref, B, rb.q.tokensOut, { label: 'one sell' });
  const refLoss = r0 - w.lamportsOf(ref.address) - ataRent;
  assert.equal(refLoss, fees(rb) + fees(rs));
  const saving = refLoss - atkLoss;
  assert.ok(saving >= 0n && saving < BigInt(2 * N), `the 60 tiny trades saved ${saving} lamports: less than one per trade`);
  const signatures = BigInt(N + 3) * 5_000n; // 30 buys + 3 sell transactions
  assert.ok(signatures > 1_000n * saving, `against ${signatures} lamports of signatures`);
  assert.ok(pct(atkLoss, g * BigInt(N)) > 4.9, `the round trip still costs ${pct(atkLoss, g * BigInt(N)).toFixed(3)}%`);
  // every lamport the curve took stayed in the buckets: no drain
  for (const h of [A, B]) { const c = view(w, h); assert.equal(w.lamportsOf(h.coin), c.rentReserve + S.liabilities(S.coinState(c))); }
  console.log(`X09/X12: 60 tiny trades lost ${atkLoss} lamports in fees, one round trip ${refLoss}: saving ${saving} lamports vs ${signatures} in signatures`);
  await w.finish();
});

// ---------------------------------------------------------------- X10
test('X10 rounding farming in the pool: 60 tiny trades after graduation save less than one lamport each against one round trip, lose about 4% like it, and X*Y never falls', async () => {
  const w = await World.create();
  const A = await w.launchCoin({ cityId: 1720n, symbol: 'PTINA' });
  const B = await w.launchCoin({ cityId: 1721n, symbol: 'PTINB' });
  const g0 = await w.signer(500n);
  for (const h of [A, B]) await w.buy(g0, h, 100n * LAMPORTS, { label: `graduate ${h.cityId}` });
  const atk = await w.signer(10n); const ref = await w.signer(10n);
  const ataRent = w.svm.minimumBalanceForRentExemption(165n);
  const k0 = view(w, A).poolSol * view(w, A).poolTokens;
  const a0 = w.lamportsOf(atk.address);
  const g = 100_039n; const N = 30;
  for (let k = 0; k < N; k++) await w.buy(atk, A, g, { label: `tiny pool buy ${k}` });
  const total = w.balanceOf(atk, A.mint);
  const piece = total / BigInt(N);
  for (let tx = 0; tx < 3; tx++) {
    const ixs = [];
    for (let k = 0; k < 10; k++) ixs.push(w.ix.sell({ user: atk.address, coin: A.coin, tokensIn: tx === 2 && k === 9 ? total - piece * 29n : piece, minSolOut: 0n }));
    await w.send(ixs, [atk], `10 tiny pool sells (${tx})`);
  }
  const atkLoss = a0 - w.lamportsOf(atk.address) - ataRent;
  const r0 = w.lamportsOf(ref.address);
  const rb = await w.buy(ref, B, g * BigInt(N), { label: 'one pool buy' });
  await w.sell(ref, B, rb.q.tokensOut, { label: 'one pool sell' });
  const refLoss = r0 - w.lamportsOf(ref.address) - ataRent;
  assert.ok(atkLoss > 0n && refLoss > 0n);
  assert.ok(atkLoss + BigInt(2 * N) >= refLoss, `splitting in the pool saves under a lamport per trade (tiny ${atkLoss}, one ${refLoss})`);
  assert.ok(view(w, A).poolSol * view(w, A).poolTokens >= k0, 'X*Y never decreased');
  assert.ok(pct(atkLoss, g * BigInt(N)) > 3.96, `pool round trip loss ${pct(atkLoss, g * BigInt(N)).toFixed(3)}% at least (1-f)(1-f+2l)`);
  console.log(`X10: 60 tiny pool trades lost ${atkLoss} lamports, one round trip ${refLoss}`);
  await w.finish();
});

// ---------------------------------------------------------------- X11
test('X11 round trips: on the curve exactly the two fees, in the pool at most (1 - f)(1 - f + 2l), across graduation within the same bound, for every size', async () => {
  const w = await World.create();
  const whale = await w.signer(5_000n);
  const bound = (charged) => (charged * (D - T.totalFeeBps) * (D - T.totalFeeBps + 2n * T.liquidityBps)) / (D * D) + 6n;
  const worst = { curve: 0, pool: 0, cross: 0 };
  // the curve at 0 and at 40 SOL raised
  for (const [i, raised] of [0n, 40n].entries()) {
    const h = await w.launchCoin({ cityId: 1730n + BigInt(i), symbol: `RTC${i}` });
    if (raised) await w.buy(whale, h, S.grossFor(T, raised * LAMPORTS), { label: `curve to ${raised} SOL` });
    for (const sol of [100_000n, LAMPORTS, 10n * LAMPORTS, 40n * LAMPORTS]) {
      const u = await w.signer(100n);
      const b = await w.buy(u, h, sol, { label: `curve round trip buy ${sol}` });
      const s = await w.sell(u, h, b.q.tokensOut, { label: `curve round trip sell ${sol}` });
      assert.equal(b.q.charged - s.q.solOut, b.q.split.fee + s.q.split.fee, 'the curve takes exactly the two fees');
      const f2 = D - T.totalFeeBps;
      assert.ok(s.q.solOut <= (b.q.charged * f2 * f2) / (D * D) + 2n, 'back at most (1 - f)^2 of the charge, plus the two fees\' rounding (under a lamport each)');
      worst.curve = Math.max(worst.curve, Number(s.q.solOut) / Number(b.q.charged));
    }
  }
  // the pool, with and without pending set-aside liquidity
  for (const [i, churn] of [0, 4].entries()) {
    const h = await w.launchCoin({ cityId: 1740n + BigInt(i), symbol: `RTP${i}` });
    for (let k = 0; k < churn; k++) { const b = await w.buy(whale, h, 40n * LAMPORTS, { label: 'churn' }); await w.sell(whale, h, b.q.tokensOut, { label: 'churn' }); }
    await w.buy(whale, h, 100n * LAMPORTS, { label: 'graduate' });
    for (const sol of [100_000n, LAMPORTS, 10n * LAMPORTS, 200n * LAMPORTS]) {
      const u = await w.signer(300n);
      const b = await w.buy(u, h, sol, { label: `pool round trip buy ${sol}` });
      const s = await w.sell(u, h, b.q.tokensOut, { label: `pool round trip sell ${sol}` });
      assert.ok(s.q.solOut <= bound(b.q.charged), `pool: ${s.q.solOut} <= ${bound(b.q.charged)}`);
      worst.pool = Math.max(worst.pool, Number(s.q.solOut) / Number(b.q.charged));
    }
  }
  // across graduation: buy on the curve, someone graduates the coin, sell in the pool
  for (const [i, raised] of [10n, 60n, 84n].entries()) {
    const h = await w.launchCoin({ cityId: 1750n + BigInt(i), symbol: `RTX${i}` });
    await w.buy(whale, h, S.grossFor(T, raised * LAMPORTS), { label: `curve to ${raised} SOL` });
    const u = await w.signer(100n);
    const b = await w.buy(u, h, LAMPORTS / 2n, { label: 'buy on the curve' });
    await w.buy(whale, h, 100n * LAMPORTS, { label: 'someone graduates' });
    const s = await w.sell(u, h, b.q.tokensOut, { label: 'sell in the pool' });
    if (raised === 84n) assert.ok(s.q.solOut < b.q.charged, 'a buyer just before graduation is not handed a pop');
    worst.cross = Math.max(worst.cross, Number(s.q.solOut) / Number(b.q.charged));
  }
  assert.ok(worst.curve <= 0.9507, `curve best ${worst.curve}: a loss of at least 4.93% (4.94% but for under a lamport of rounding on the smallest buy)`);
  assert.ok(worst.pool <= 0.9604, `pool best ${worst.pool}: a loss of at least 3.96%`);
  console.log(`X11 best results: curve ${worst.curve}, pool ${worst.pool}, bought on the curve and sold after graduation ${worst.cross} (that buyer profits only from the graduating buyer's price impact, as on any market)`);
  await w.finish();
});

// ---------------------------------------------------------------- X28
test('X28 dust sells: the drip of a sell is floor(A * b_L / D), nothing below 200 lamports; the rounding remainder never drips; buys cannot be dust', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1760n, symbol: 'DUST' });
  const whale = await w.signer(1_000n);
  for (let k = 0; k < 3; k++) { const b = await w.buy(whale, h, 40n * LAMPORTS, { label: 'churn' }); await w.sell(whale, h, b.q.tokensOut, { label: 'churn' }); }
  // curve-phase dust: a 1-lamport sell drips nothing (curve trades never drip) and its remainder joins the set-aside liquidity
  const d = await w.signer(10n);
  await w.buy(d, h, 5_000_000n, { label: 'dust trader buys' });
  await w.buy(whale, h, 100n * LAMPORTS, { label: 'graduate' });
  assert.ok(view(w, h).liquidityPending > 1_000_000n);
  const tokensForGross = (target) => {
    let lo = 1n; let hi = 1n;
    const gross = (a) => S.quoteSell(T, st(w, h), a).gross;
    const g = (a) => { try { return gross(a); } catch { return 0n; } };
    while (g(hi) < target) hi *= 2n;
    while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (g(mid) >= target) hi = mid; else lo = mid; }
    return g(hi) === target ? hi : null;
  };
  for (const gross of [1n, 2n, 39n, 40n, 41n, 160n, 161n, 199n, 200n, 201n, 399n, 400n, 401n]) {
    const a = tokensForGross(gross);
    assert.ok(a, `a sell with gross ${gross} exists`);
    const L0 = view(w, h).liquidityPending;
    const r = await w.sell(d, h, a, { label: `dust sell, gross ${gross}` });
    assert.equal(r.q.gross, gross);
    const floorL = (gross * T.liquidityBps) / D;
    assert.equal(r.q.drip, floorL, `drip = floor(${gross} * 50 / 10,000) = ${floorL}`);
    assert.equal(L0 - view(w, h).liquidityPending, floorL, 'only the floor left the set-aside liquidity');
    assert.ok(r.q.split.liquidity - floorL <= 4n && r.q.split.liquidity >= floorL, 'the remainder (0 to 4) stays with the trade\'s own share');
    assert.ok(r.q.drip <= r.q.split.platform || gross < 200n, 'a sell\'s drip never exceeds its platform share (V10)');
  }
  // buys have a 0.0001 SOL minimum: the smallest buy drips 500 lamports against a 700-lamport platform share
  const q = S.quoteBuy(T, st(w, h), S.MIN_TRADE_LAMPORTS);
  assert.deepEqual([q.drip, q.split.platform], [500n, 700n]);
  await expectFail(() => w.send([w.ix.buy({ user: d.address, coin: h.coin, solIn: S.MIN_TRADE_LAMPORTS - 1n, minTokensOut: 0n })], [d], 'dust buy'), 'TradeTooSmall');
  await w.finish();
});

// ---------------------------------------------------------------- X27, X27b
/**
 * A coin under `configId` with other traders' set-aside liquidity waiting, graduated by its founder, who then holds the
 * whole float; returns the state for the drip farming attack.
 */
async function farmingCoin(w, cityId, symbol, configId, churnRounds) {
  const founder = await w.signer(2_000n);
  const h = await w.launchCoin({ cityId, symbol, configId, founder });
  const others = await w.signer(3_000n);
  for (let k = 0; k < churnRounds; k++) { const b = await w.buy(others, h, 40n * LAMPORTS, { label: 'others churn' }); await w.sell(others, h, b.q.tokensOut, { label: 'others churn' }); }
  await w.claim(h, founder, { label: 'founder claims what others paid' });
  await w.buy(founder, h, 120n * LAMPORTS, { label: 'founder graduates: he holds the whole float' });
  return { h, founder };
}
/** Drip farming by the founder: `rounds` round trips of `size`, then he sells everything; result against selling at once, credited his founder, holders and buyback shares. */
async function farm(w, h, founder, size, rounds) {
  const terms = S.coinTerms(view(w, h));
  const all = w.balanceOf(founder, h.mint);
  const pendingFounder = view(w, h).founderPending;
  // the baseline: sell everything at once from this state (and the founder's share of that sell)
  const base = S.quoteSell(terms, st(w, h), all);
  const baseValue = base.solOut + base.split.founder + base.split.holders + base.split.buyback;
  const l0 = w.lamportsOf(founder.address);
  let credited = 0n;
  const L0 = view(w, h).liquidityPending;
  for (let k = 0; k < rounds; k++) {
    const b = await w.buy(founder, h, size, { label: `farm buy ${k}` });
    const s = await w.sell(founder, h, b.q.tokensOut, { label: `farm sell ${k}` });
    credited += b.q.split.holders + b.q.split.buyback + s.q.split.holders + s.q.split.buyback;
  }
  const last = await w.sell(founder, h, w.balanceOf(founder, h.mint), { label: 'farmer sells everything' });
  credited += last.q.split.holders + last.q.split.buyback;
  await w.claim(h, founder, { label: 'farmer claims his founder share' });
  const value = w.lamportsOf(founder.address) - l0 + credited - pendingFounder;
  return { result: value - baseValue, dripped: L0 - view(w, h).liquidityPending, base: baseValue };
}

test('X27 drip farming: the founder holding the whole float, credited the founder, holders and buyback shares of his legs, loses against selling at once (V10)', async () => {
  const w = await World.create();
  for (const [i, size, rounds] of [[0, LAMPORTS, 12], [1, 20n * LAMPORTS, 4], [2, 60n * LAMPORTS, 2]]) {
    const { h, founder } = await farmingCoin(w, 1770n + BigInt(i), `FARM${i}`, 0, 4);
    const r = await farm(w, h, founder, size, rounds);
    assert.ok(r.dripped > 0n, 'the attack released set-aside liquidity');
    assert.ok(r.result < 0n, `${rounds} round trips of ${size}: result ${r.result} lamports (dripped ${r.dripped})`);
    console.log(`X27 default config, ${rounds} x ${Number(size) / 1e9} SOL: ${Number(r.result) / 1e9} SOL against selling at once (released ${r.dripped} lamports of set-aside liquidity)`);
  }
  await w.finish();
});

test('X27b the V10 edge on chain: (50, 51, 50, 50, 30) passes and drip farming still loses; (50, 50, 50, 50, 30) is refused at add_launch_config', async () => {
  const w = await World.create();
  await expectFail(() => w.addConfig({ ...S.DEFAULT_CONFIG, platformBps: 50n }), 'ConfigDripFarmable');
  const edge = await w.addConfig({ ...S.DEFAULT_CONFIG, platformBps: 51n });
  for (const [i, size, rounds] of [[0, 5n * LAMPORTS, 8], [1, 50n * LAMPORTS, 3]]) {
    const { h, founder } = await farmingCoin(w, 1780n + BigInt(i), `EDGE${i}`, edge, 4);
    assert.equal(view(w, h).platformBps, 51n);
    const r = await farm(w, h, founder, size, rounds);
    assert.ok(r.dripped > 0n);
    assert.ok(r.result < 0n, `edge config, ${rounds} x ${size}: ${r.result}`);
    console.log(`X27b edge config, ${rounds} x ${Number(size) / 1e9} SOL: ${Number(r.result) / 1e9} SOL against selling at once`);
  }
  await w.finish();
});

// ---------------------------------------------------------------- graduation-boundary snipes
test('X17, X19 graduation-boundary sandwiches: a victim whose impact is below twice the fee cannot be sandwiched at a profit; a larger one with 1% slippage loses at most his tolerance; a front-run that graduates the coin and is not followed by the victim loses', async () => {
  const w = await World.create();
  const whale = await w.signer(5_000n);
  const results = [];
  let city = 1790n;
  for (const [kind, size, slipBps] of [['small victim, 1%', 300_000_000n, 100n], ['large victim, 1%', 3n * LAMPORTS, 100n], ['large careless victim', 3n * LAMPORTS, null]]) {
    for (const a of [50_000_000n, LAMPORTS / 2n, 2n * LAMPORTS, 6n * LAMPORTS]) {
      const h = await w.launchCoin({ cityId: city, symbol: `SNP${city}` });
      city++;
      await w.buy(whale, h, S.grossFor(T, 80n * LAMPORTS), { label: 'curve to 80 SOL' });
      const victim = await w.signer(50n); const atk = await w.signer(50n);
      await w.send([S.createAssociatedTokenAccountIdempotent({ payer: w.payer.address, owner: victim.address, mint: h.mint })], [], 'victim token account');
      w.addHolder(h.mint, victim);
      const vq = S.quoteBuy(T, st(w, h), size);
      // the victim's own price impact on the curve, against twice the fee
      const [x1, y1] = S.spotPrice(T, vq.newState); const [x0, y0] = S.spotPrice(T, st(w, h));
      const impact = Number(x1 * y0) / Number(x0 * y1) - 1;
      const min = slipBps === null ? 0n : S.withSlippage(vq.tokensOut, slipBps);
      const a0 = w.lamportsOf(atk.address); const v0 = w.lamportsOf(victim.address);
      const fb = await w.buy(atk, h, a, { label: 'attacker front-runs' });
      let victimCharged = null;
      try {
        victimCharged = (await w.buy(victim, h, size, { min, label: 'victim buy' })).q.charged;
      } catch (e) {
        assert.match(`${e.logs?.join('\n')}\n${e.errText}`, /SlippageExceeded/);
        assert.equal(w.lamportsOf(victim.address), v0, 'a refused victim pays nothing');
      }
      await w.sell(atk, h, fb.q.tokensOut, { label: 'attacker back-runs' });
      const pnl = w.lamportsOf(atk.address) - a0 + w.svm.minimumBalanceForRentExemption(165n);
      if (victimCharged !== null) assert.ok(w.balanceOf(victim, h.mint) >= min, 'the victim got at least his minimum');
      if (impact < 0.0494) assert.ok(pnl < 0n, `${kind}: impact ${(impact * 100).toFixed(2)}% below twice the fee, front-run ${a}: ${pnl}`);
      if (slipBps !== null) assert.ok(pnl < 0n || (victimCharged !== null && pnl * 10_000n <= victimCharged * slipBps), `${kind}, front-run ${a}: ${pnl} beyond the victim's tolerance`);
      if (fb.q.graduates && victimCharged === null) assert.ok(pnl < 0n, 'a front-run that graduates the coin, with the victim refused, loses');
      results.push(`${kind} (impact ${(impact * 100).toFixed(2)}%), front-run ${Number(a) / 1e9} SOL${fb.q.graduates ? ' (graduates)' : ''}: attacker ${(Number(pnl) / 1e9).toFixed(6)} SOL, victim ${victimCharged !== null ? 'filled' : 'refused'}`);
    }
  }
  console.log(`graduation-boundary sandwiches: ${results.join(' | ')}`);
  await w.finish();
});

// ---------------------------------------------------------------- 7.4: wash trading by the founder
test('7.4 wash trading by the founder pays nobody: he pays 2.5% per leg and gets back his 0.5%, on the curve and in the pool', async () => {
  const w = await World.create();
  for (const graduate of [false, true]) {
    const founder = await w.signer(1_000n);
    const h = await w.launchCoin({ cityId: graduate ? 1799n : 1798n, symbol: graduate ? 'WASHP' : 'WASHC', founder });
    if (graduate) await w.buy(await w.signer(200n), h, 100n * LAMPORTS, { label: 'others graduate' });
    await w.claim(h, founder, { label: 'empty bucket' });
    const l0 = w.lamportsOf(founder.address);
    let volume = 0n;
    for (let k = 0; k < 6; k++) {
      const b = await w.buy(founder, h, 10n * LAMPORTS, { label: `wash buy ${k}` });
      const s = await w.sell(founder, h, b.q.tokensOut, { label: `wash sell ${k}` });
      volume += b.q.charged + s.q.gross;
    }
    await w.claim(h, founder, { label: 'founder claims his share of his own volume' });
    const loss = l0 - w.lamportsOf(founder.address) - w.svm.minimumBalanceForRentExemption(165n);
    assert.ok(loss > 0n, 'a loss');
    // at least the four other shares (platform, holders, buyback, liquidity: 2% of volume) less the pool's injected liquidity he may recover
    assert.ok(loss * 10_000n >= volume * (graduate ? 100n : 199n), `${graduate ? 'pool' : 'curve'}: loss ${loss} on volume ${volume} (${pct(loss, volume).toFixed(3)}%)`);
    console.log(`7.4 founder wash trading (${graduate ? 'pool' : 'curve'}): ${(Number(loss) / 1e9).toFixed(4)} SOL lost on ${(Number(volume) / 1e9).toFixed(1)} SOL of volume (${pct(loss, volume).toFixed(3)}%)`);
  }
  await w.finish();
});
