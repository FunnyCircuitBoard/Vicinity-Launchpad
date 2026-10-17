// Client regressions of review round 1 (VICINITY-CURVE-DESIGN.md 14.1, 4.21, T56,
// 4.15, T55; VICINITY-CURVE-NOTES.md 44 to 46), against the real program and the
// mainnet vicinity_rewards in litesvm with the checker on:
//
//   * CLI-1: "pay with any token" (buyWithSwap) used to build the buy leg with
//     min_tokens_out = 0; a front-run then took most of the victim's coins. The
//     helper now refuses to build a buy without its own minimum, and with one the
//     same sandwich makes the victim's buy fail and move nothing.
//   * CLI-2: a failed transaction carries genuine event CPIs of trades that never
//     happened. decodeTransactionEvents reads a whole transaction and returns
//     nothing for a failed one; World.send checks it against every transaction of
//     every suite (the failed ones included).
//   * CLI-3: lamports sent to a city's rewards config address made
//     initRewardsForCoin report an unfixable wrong config; it now proposes
//     init_city over the pre-funded address, and reports an authority problem as
//     fixable (propose_authority / accept_authority), not as O26.
//   * R3-CLI-1 (review round 3): near graduation buyWithSwap took the buy leg's
//     minimum from the partial quote but offered the swap's whole output; once
//     someone else graduated the coin, the buy ran in the pool, was charged all
//     of it and still cleared the minimum. The leg now offers only the partial
//     quote's charge (max_quote_in), and the same bundle makes the buy fail.
//   * MATH3-1 (review round 3): above a coin's sandwich threshold (about 2% to
//     2.5% of its SOL depth under config #0) an ordinary sandwich takes almost
//     any slippage the buyer allows; the buy leg now allows at most 0.3% there,
//     and up to 5% only below it, where no sandwich profits.
import test from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import { World, S, expectFail, LAMPORTS } from './helpers.mjs';
import { systemTransfer } from './fuzz.mjs';

const { PublicKey } = web3;

test('CLI-1 buyWithSwap: no buy leg without a minimum; with the SDK\'s slippage minimum a sandwich front-run makes the victim\'s buy fail', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2_900n, symbol: 'SANDW' });
  const victim = await w.signer(20n);
  const attacker = await w.signer(200n);
  const solIn = 5n * LAMPORTS;
  // the victim's SOL arrived from a swap quoted ExactIn with this minimum (the swap leg itself is G03's)
  const quote = { swapMode: 'ExactIn', outAmount: solIn + 50_000_000n, otherAmountThreshold: solIn };
  const base = { ix: w.ix, user: victim.address, coin: h.coin, mint: h.mint, swapInstructions: [], quote };
  // what the website did before: no minimum, now refused by the helper
  assert.throws(() => S.buyWithSwap(base), (e) => e instanceof S.ComposeError && /minimum/.test(e.message));
  assert.throws(() => S.buyWithSwap({ ...base, minTokensOut: 0n }), S.ComposeError);
  // the website's call: the coin as read before signing; a 5 SOL buy on a fresh coin is above its sandwich threshold, so
  // 0.3% (2% is refused there, review MATH3-1)
  const c0 = w.coinView(h);
  assert.throws(() => S.buyWithSwap({ ...base, coinAccount: c0, slippageBps: 200 }), /sandwich threshold/);
  const { instructions, minTokensOut } = S.buyWithSwap({ ...base, coinAccount: c0, slippageBps: S.LARGE_BUY_MAX_SLIPPAGE_BPS });
  const quoted = S.quoteBuy(S.coinTerms(c0), S.coinState(c0), solIn).tokensOut;
  assert.equal(minTokensOut, S.withSlippage(quoted, S.LARGE_BUY_MAX_SLIPPAGE_BPS));
  assert.equal(Buffer.from(instructions.at(-1).data).readBigUInt64LE(16), minTokensOut, 'the buy carries the minimum');
  // the review's sandwich: a 25.5 SOL front-run on a fresh config #0 coin (the victim would have lost 68% of the coins)
  const front = await w.buy(attacker, h, 25_500_000_000n, { label: 'front-run' });
  const v0 = w.lamportsOf(victim.address);
  const coin0 = w.accountInfo(h.coin);
  await expectFail(() => w.send(instructions, [victim], 'victim\'s buy after the front-run', { feePayer: w.payer }), 'SlippageExceeded');
  assert.equal(w.lamportsOf(victim.address), v0, 'the victim paid nothing (the fee came from the world\'s payer)');
  assert.ok(w.accountInfo(h.coin).data.equals(coin0.data), 'the coin did not move');
  // the attacker can only sell back at a loss (round trip, 5.15)
  const back = await w.sell(attacker, h, front.q.tokensOut, { label: 'back-run' });
  assert.ok(back.q.solOut < front.q.charged, 'the would-be sandwich loses the fees');
  // without the front-run the same buy goes through and delivers at least the minimum
  const fresh = S.buyWithSwap({ ...base, coinAccount: w.coinView(h), slippageBps: S.LARGE_BUY_MAX_SLIPPAGE_BPS });
  await w.send(fresh.instructions, [victim], 'victim\'s buy, no front-run');
  w.addHolder(h.mint, victim);
  assert.ok(w.balanceOf(victim, h.mint) >= fresh.minTokensOut);
  await w.finish();
});

test('CLI-2 a failed transaction carries a genuine Trade event CPI; decodeTransactionEvents returns nothing for it and the real next trade is the only trade_seq 2', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2_901n, symbol: 'FAILEV' });
  const holder = await w.signer(30n);
  await w.buy(holder, h, 20n * LAMPORTS); // trade_seq 1
  const before = w.coinView(h);
  const tokens = w.balanceOf(holder, h.mint);
  // a sell of everything, then a transfer that always fails: the transaction reverts, its metadata keeps the event CPI
  const sell = w.ix.sell({ user: holder.address, coin: h.coin, tokensIn: tokens, minSolOut: 0n });
  const e = await expectFail(() => w.send([sell, systemTransfer(holder.address, w.payer.address, 1_000_000n * LAMPORTS)], [holder], 'sell + a failing transfer', { feePayer: holder }), /insufficient lamports|custom program error: 0x1\b/i);
  assert.ok(e.rpc && e.rpc.meta.err, 'the failed transaction, as getTransaction returns it');
  // the hazard: one inner instruction of the failed transaction is a genuine event CPI that the single-instruction decoder accepts
  const keys = e.rpc.transaction.message.staticAccountKeys;
  const genuine = e.rpc.meta.innerInstructions.flatMap((g) => g.instructions).map((ii) => S.decodeEventCpi({ programId: keys[ii.programIdIndex], accounts: ii.accounts.map((k) => keys[k]), data: ii.data }, { programId: w.programId })).filter(Boolean);
  assert.deepEqual(genuine.map((x) => [x.name, x.data.trade_seq, x.data.is_buy]), [['Trade', 2n, false]]);
  // the rule of 4.21: nothing from a failed transaction
  assert.deepEqual(S.decodeTransactionEvents(e.rpc, { programId: w.programId }), []);
  const after = w.coinView(h);
  assert.deepEqual([after.tradeSeq, after.curveSol, w.balanceOf(holder, h.mint)], [before.tradeSeq, before.curveSol, tokens], 'nothing happened on chain');
  // the next real trade: the only event with trade_seq 2, and decodeTransactionEvents finds it (World.send compares it with the checker)
  const bob = await w.signer(5n);
  const r = await w.buy(bob, h, LAMPORTS);
  const trade = r.res.events.find((x) => x.name === 'Trade');
  assert.equal(trade.data.trade_seq, 2n);
  assert.equal(w.coinView(h).tradeSeq, 2n);
  await w.finish();
});

test('CLI-3 lamports sent to the city\'s rewards config and vault addresses: initRewardsForCoin still proposes init_city, which creates both, and the holders\' share is forwarded', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2_902n, symbol: 'PREFND' });
  const u = await w.signer(20n);
  await w.buy(u, h, 4n * LAMPORTS);
  const R = w.rewardsPdas();
  const config = R.city(h.mint); const vault = R.vault(config);
  const rent0 = w.svm.minimumBalanceForRentExemption(0n);
  // the grief of the review: rent_min(0) to the config address (and to the vault address too), by anyone
  const mallory = await w.signer(1n);
  await w.send([systemTransfer(mallory.address, config, rent0), systemTransfer(mallory.address, vault, rent0 + 1n)], [mallory], 'pre-fund the rewards config and vault addresses', { feePayer: mallory });
  for (const k of [config, vault]) assert.deepEqual([w.accountInfo(k).owner, w.accountInfo(k).data.length], [S.ADDRESSES.system, 0]);
  const getAccount = async (k) => w.accountInfo(k);
  const simulate = async (ixs) => {
    const r = await w.simulate(ixs, [w.payer, w.admin], { feePayer: w.payer });
    return r.ok ? { ok: true, account: r.account } : { ok: false, error: r.error };
  };
  const base = { getAccount, simulate, payer: w.payer.address, registryAdmin: w.admin.address, authority: w.admin.address, coin: w.coinView(h) };
  const r = await S.initRewardsForCoin(base);
  assert.deepEqual([r.instructions.length, r.already], [1, false]);
  await w.send(r.instructions, [w.admin], 'init_city over the pre-funded addresses, as proposed');
  assert.equal(w.accountInfo(config).owner, S.CLUSTERS.mainnet.rewardsProgram);
  const pending = w.coinView(h).holdersPending;
  assert.ok(pending > 0n);
  const f = await w.forward(h);
  assert.equal(f.events.find((x) => x.name === 'HoldersFeesForwarded').data.amount, pending);
  assert.equal((await S.initRewardsForCoin(base)).already, true);

  // an admin hand-over: the existing config's authority no longer matches; that is fixable, never O26
  const next = await w.signer(5n);
  await w.send([w.ix.proposeAdmin({ admin: w.admin.address, newAdmin: next.address })], [w.admin], 'propose_admin');
  await w.send([w.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept_admin');
  await assert.rejects(() => S.initRewardsForCoin({ ...base, authority: next.address }),
    (x) => x.code === 'AuthorityNotAdmin' && x.fixable === true && x.problems.includes('authority is not the vicinity_curve admin') && /propose_authority/.test(x.message) && !/O26/.test(x.message));
  await w.send([w.rewardsIx('propose_authority', { new_authority: new PublicKey(next.address) }, { authority: w.admin.address, config })], [w.admin], 'rewards propose_authority');
  await assert.rejects(() => S.initRewardsForCoin({ ...base, authority: next.address }), (x) => x.code === 'AuthorityNotAdmin' && x.problems.includes('authority is not the vicinity_curve admin'));
  await w.send([w.rewardsIx('accept_authority', {}, { new_authority: next.address, config })], [next], 'rewards accept_authority');
  w.admin = next;
  assert.equal((await S.initRewardsForCoin({ ...base, authority: next.address })).already, true);
  await w.buy(u, h, LAMPORTS);
  await w.forward(h, { label: 'forward after the authority followed the admin' });
  await w.finish();
});

test('R3-CLI-1 a buy that completes the curve offers only its charge: buyWithSwap caps sol_in at the partial quote\'s charge, so a searcher who graduates the coin first makes the victim\'s buy fail instead of charging all of sol_in in the pool', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2_903n, symbol: 'PARTL' });
  const race = await w.launchCoin({ cityId: 2_904n, symbol: 'RACE' });
  const whale = await w.signer(0n);
  w.setRaw(whale.address, Buffer.alloc(0), S.ADDRESSES.system, 2_000n * LAMPORTS);
  const terms = S.coinTerms(w.coinView(h));
  // both curves brought to 84 SOL: about 1 SOL left before graduation
  for (const c of [h, race]) await w.buy(whale, c, S.grossFor(terms, 84n * LAMPORTS), { label: 'the curve to 84 SOL' });
  const victim = await w.signer(30n);
  const solIn = 20n * LAMPORTS;
  // "pay with any token": the swap delivers at least 20 SOL (ExactIn), the website's 2% on the buy leg
  const quote = { swapMode: 'ExactIn', outAmount: solIn + 200_000_000n, otherAmountThreshold: solIn };
  const c0 = w.coinView(h);
  const q = S.quoteBuy(terms, S.coinState(c0), solIn);
  assert.deepEqual([q.partial, q.graduates], [true, true], 'a 20 SOL buy completes the curve');
  const built = S.buyWithSwap({ ix: w.ix, user: victim.address, coin: h.coin, mint: h.mint, swapInstructions: [], quote, coinAccount: c0, slippageBps: 200 });
  assert.equal(built.solIn, q.charged, 'the buy offers only the partial quote\'s charge');
  assert.equal(built.swapSolIn, solIn, 'the swap is still guaranteed 20 SOL');
  assert.equal(built.solIn, S.maxQuoteIn(terms, S.coinState(c0)), '= max_quote_in');
  assert.equal(built.minTokensOut, S.withSlippage(q.tokensOut, 200));
  const data = Buffer.from(built.instructions.at(-1).data);
  assert.deepEqual([data.readBigUInt64LE(8), data.readBigUInt64LE(16)], [built.solIn, built.minTokensOut], 'sol_in and min_tokens_out encoded');
  // the old helper's pair (minimum of the partial quote, sol_in uncapped) is refused, not built
  assert.throws(() => S.buyLegMinimum({ solIn, coinAccount: c0, slippageBps: 200 }), (e) => e instanceof S.ComposeError && /completes the curve/.test(e.message));
  // the searcher's bundle ahead of the victim: graduate the coin, then buy in the new pool
  await w.buy(whale, h, S.maxQuoteIn(terms, S.coinState(w.coinView(h))), { label: 'the searcher graduates the coin' });
  await w.buy(whale, h, 94_750_000_000n, { label: 'the searcher buys in the new pool' });
  // what the uncapped pair would do now: charged all 20 SOL in the pool and still clear the small minimum (simulated only)
  const ata = w.ata(victim.address, h.mint);
  const naive = await w.simulate([S.createAssociatedTokenAccountIdempotent({ payer: victim.address, owner: victim.address, mint: h.mint }),
    w.ix.buy({ user: victim.address, coin: h.coin, userTokenAccount: ata, solIn, minTokensOut: built.minTokensOut })], [victim], { feePayer: w.payer });
  assert.ok(naive.ok, 'the uncapped buy would go through');
  const charged = naive.coin(h.coin).buyVolume - w.coinView(h).buyVolume;
  assert.equal(charged, solIn, 'and be charged all of sol_in');
  // the capped buy: SlippageExceeded, and the victim pays nothing
  const v0 = w.lamportsOf(victim.address);
  const coin0 = w.accountInfo(h.coin);
  await expectFail(() => w.send(built.instructions, [victim], 'the victim\'s capped buy after the bundle', { feePayer: w.payer }), 'SlippageExceeded');
  assert.equal(w.lamportsOf(victim.address), v0, 'the victim paid nothing');
  assert.ok(w.accountInfo(h.coin).data.equals(coin0.data), 'the coin did not move');
  // an honest race on the second coin: another buyer completes the curve first; the capped buy pays at most its charge
  const rq = S.quoteBuy(terms, S.coinState(w.coinView(race)), solIn);
  const leg = S.buyWithSwap({ ix: w.ix, user: victim.address, coin: race.coin, mint: race.mint, swapInstructions: [], quote, coinAccount: w.coinView(race), slippageBps: 200 });
  assert.equal(leg.solIn, rq.charged);
  const other = await w.signer(10n);
  await w.buy(other, race, 2n * LAMPORTS, { label: 'another buyer completes the curve' });
  const inPool = S.quoteBuy(terms, S.coinState(w.coinView(race)), leg.solIn);
  const r0 = w.lamportsOf(victim.address);
  const ataRent = w.svm.minimumBalanceForRentExemption(165n);
  if (inPool.tokensOut >= leg.minTokensOut) {
    await w.send(leg.instructions, [victim], 'the capped buy after the race', { feePayer: w.payer });
    w.addHolder(race.mint, victim);
    assert.equal(r0 - w.lamportsOf(victim.address), leg.solIn + ataRent, 'charged exactly its capped sol_in');
  } else {
    await expectFail(() => w.send(leg.instructions, [victim], 'the capped buy after the race', { feePayer: w.payer }), 'SlippageExceeded');
    assert.equal(w.lamportsOf(victim.address), r0, 'refused, nothing paid');
  }
  await w.finish();
});

// MATH3-1: the best ordinary sandwich of a victim buy (the largest front-run that still lets it pass), found
// with the SDK's quotes (equal to the program's, G01) and then run on chain
function bestFrontRun(terms, st, V, min) {
  const passes = (a) => {
    try {
      const f = S.quoteBuy(terms, st, a);
      if (f.graduates) return false;
      return S.quoteBuy(terms, f.newState, V).tokensOut >= min;
    } catch (e) { if (e instanceof S.MathError) return false; throw e; }
  };
  if (!passes(S.MIN_TRADE_LAMPORTS)) return null;
  let lo = S.MIN_TRADE_LAMPORTS; let hi = 5_000n * LAMPORTS;
  while (hi - lo > 1_000n) { const m = (lo + hi) / 2n; if (passes(m)) lo = m; else hi = m; }
  return lo;
}
/** Front-run, the victim's buy with `min`, back-run on chain: the attacker's result for each credited class. */
async function sandwich(w, h, { V, min, label }) {
  const terms = S.coinTerms(w.coinView(h));
  const plain = S.quoteBuy(terms, S.coinState(w.coinView(h)), V);
  const a = bestFrontRun(terms, S.coinState(w.coinView(h)), V, min);
  assert.ok(a, `${label}: some front-run lets the victim pass`);
  const attacker = await w.signer(0n);
  w.setRaw(attacker.address, Buffer.alloc(0), S.ADDRESSES.system, 10_000n * LAMPORTS);
  const victim = await w.signer(0n);
  w.setRaw(victim.address, Buffer.alloc(0), S.ADDRESSES.system, 100n * LAMPORTS);
  const f = await w.buy(attacker, h, a, { label: `${label}: front-run` });
  const v = await w.buy(victim, h, V, { min, label: `${label}: the victim's buy` });
  const b = await w.sell(attacker, h, f.q.tokensOut, { label: `${label}: back-run` });
  const net = b.q.solOut - f.q.charged;
  const credit = (...k) => k.reduce((x, key) => x + f.q.split[key] + b.q.split[key], 0n);
  return {
    victimLoss: plain.tokensOut - v.q.tokensOut, plainTokens: plain.tokensOut,
    outsider: net, founder: net + credit('founder'), founderFloat: net + credit('founder', 'holders'), platform: net + credit('platform'),
  };
}

test('MATH3-1 an ordinary sandwich profits at any slippage above the coin\'s size threshold and at none below it: the SDK allows 5% only up to sandwichThreshold and 0.3% above it, which bounds the loss', async () => {
  const w = await World.create();
  const T = S.DEFAULT_TERMS;
  const whale = await w.signer(0n);
  w.setRaw(whale.address, Buffer.alloc(0), S.ADDRESSES.system, 1_000n * LAMPORTS);
  let city = 2_910n;
  const coinAt = async (raised, symbol) => {
    const h = await w.launchCoin({ cityId: city++, symbol });
    if (raised === 'pool') await w.buy(whale, h, S.maxQuoteIn(T, S.coinState(w.coinView(h))), { label: 'graduate' });
    else if (raised > 0n) await w.buy(whale, h, S.grossFor(T, raised * LAMPORTS), { label: `the curve to ${raised} SOL` });
    return h;
  };
  // the review's case: a fresh config #0 coin, a 1 SOL buy at the website's 1%: an outsider profits
  const fresh = await coinAt(0n, 'SW1');
  const q1 = S.quoteBuy(T, S.coinState(w.coinView(fresh)), LAMPORTS);
  const review = await sandwich(w, fresh, { V: LAMPORTS, min: S.withSlippage(q1.tokensOut, 100), label: '1 SOL at 1% on a fresh coin' });
  assert.ok(review.outsider > 0n, `the review's sandwich profits (${review.outsider})`);
  assert.ok(review.victimLoss * 10_000n >= q1.tokensOut * 95n, 'the victim loses almost his whole 1%');
  // the SDK no longer builds that buy: above the threshold it allows at most 0.3%
  // (that coin moved; a second fresh coin has the review's state)
  const fresh2 = await coinAt(0n, 'SW2');
  const cf = w.coinView(fresh2);
  const thr = S.sandwichThreshold(S.coinTerms(cf), S.coinState(cf));
  assert.equal(thr, 450_012_804n, 'config #0 at launch: 1.5% of x0');
  for (const bps of [100, 200]) assert.throws(() => S.buyLeg({ solIn: LAMPORTS, coinAccount: cf, slippageBps: bps }), (e) => e instanceof S.ComposeError && /sandwich threshold/.test(e.message));
  const leg = S.buyLeg({ solIn: LAMPORTS, coinAccount: cf, slippageBps: S.LARGE_BUY_MAX_SLIPPAGE_BPS });
  const capped = await sandwich(w, fresh2, { V: LAMPORTS, min: leg.minTokensOut, label: '1 SOL at the SDK\'s 0.3%' });
  assert.ok(capped.victimLoss * 10_000n <= capped.plainTokens * 30n, `the victim loses at most 0.3% (${capped.victimLoss})`);
  for (const k of ['outsider', 'founder', 'founderFloat', 'platform']) assert.ok(capped[k] * 10_000n <= LAMPORTS * 30n, `${k} keeps at most 0.3% (${capped[k]})`);
  // at the threshold, with the most slippage the SDK allows there (5%), nobody profits: on the curve at launch,
  // at 40 SOL raised and in a fresh pool, for an outsider, the founder, the founder holding the float and the platform's key
  const report = [];
  for (const [raised, symbol] of [[0n, 'SWT0'], [40n, 'SWT40'], ['pool', 'SWTP']]) {
    const h = await coinAt(raised, symbol);
    const c = w.coinView(h);
    const V = S.sandwichThreshold(S.coinTerms(c), S.coinState(c));
    const l = S.buyLeg({ solIn: V, coinAccount: c, slippageBps: S.MAX_SWAP_SLIPPAGE_BPS });
    assert.equal(l.large, false, 'at the threshold the full 5% is allowed');
    const r = await sandwich(w, h, { V, min: l.minTokensOut, label: `${symbol}: ${V} lamports at 5%` });
    for (const k of ['outsider', 'founder', 'founderFloat', 'platform']) assert.ok(r[k] < 0n, `${symbol}: the ${k} loses (${r[k]})`);
    report.push(`${symbol} V=${V}: outsider ${r.outsider}, founder ${r.founder}, founder+float ${r.founderFloat}, platform ${r.platform}`);
  }
  console.log(`MATH3-1: the review's 1 SOL at 1%: outsider ${review.outsider}; 1 SOL at 0.3%: victim loss ${capped.victimLoss} of ${capped.plainTokens}, outsider ${capped.outsider}; at the threshold with 5%: ${report.join(' | ')}`);
  await w.finish();
});
