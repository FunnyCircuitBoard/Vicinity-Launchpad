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
//   * MATH3-1 (review round 3): above a coin's sandwich threshold (the SDK's
//     sandwichThreshold, 1.3% of its SOL depth under config #0 since round 4)
//     an ordinary sandwich takes almost any slippage the buyer allows; the buy
//     leg now allows at most 0.3% there, and up to 5% only below it, where no
//     sandwich profits.
//   * Review round 4: within about 97,500 lamports of graduation the SDK built
//     no buy at all (R4-DIFF-1, SM-1, SDK4-1); the threshold used the curve's
//     depth for a buy that can be pushed into the pool (R4-DIFF-3, SDK4-2) and
//     left out a buyback run inside the sandwich (SDK4-4); splitting a large
//     buy into threshold-size buys was offered as a defence (R4-DIFF-2); sells
//     had no size rule (R4-DIFF-5, SDK4-3).
//   * Review round 5: the pieces of a split order re-quoted from fresh reads
//     let a searcher ratchet the price (R5-DIFF-1); trades from one snapshot
//     in one block were sandwiched together at sizes allowed one at a time
//     (MV-1); the threshold allowed for one buyback run while a hold through
//     every run of a public backlog profited (KR-1).
import test from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import { World, S, expectFail, LAMPORTS } from './helpers.mjs';
import { systemTransfer } from './fuzz.mjs';

const { PublicKey } = web3;
/** A Jupiter quote from some token to native SOL (buyWithSwap takes nothing else, review SDK4-5). */
const swapQuote = (q) => ({ inputMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', outputMint: S.ADDRESSES.nativeMint, ...q });

test('CLI-1 buyWithSwap: no buy leg without a minimum; with the SDK\'s slippage minimum a sandwich front-run makes the victim\'s buy fail', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 2_900n, symbol: 'SANDW' });
  const victim = await w.signer(20n);
  const attacker = await w.signer(200n);
  const solIn = 5n * LAMPORTS;
  // the victim's SOL arrived from a swap quoted ExactIn with this minimum (the swap leg itself is G03's)
  const quote = swapQuote({ swapMode: 'ExactIn', outAmount: solIn + 50_000_000n, otherAmountThreshold: solIn });
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
  // "pay with any token": the swap delivers at least 20 SOL (ExactIn); the buy leg at the most the SDK allows (its
  // charge, 1.03 SOL, is above the threshold that the whale's 0.25 SOL of backlog lowers to 0.595 SOL, KR-1: 0.3%)
  const quote = swapQuote({ swapMode: 'ExactIn', outAmount: solIn + 200_000_000n, otherAmountThreshold: solIn });
  const c0 = w.coinView(h);
  const bps = S.buySlippagePolicy(c0, solIn).maxSlippageBps;
  assert.equal(bps, S.LARGE_BUY_MAX_SLIPPAGE_BPS);
  const q = S.quoteBuy(terms, S.coinState(c0), solIn);
  assert.deepEqual([q.partial, q.graduates], [true, true], 'a 20 SOL buy completes the curve');
  const built = S.buyWithSwap({ ix: w.ix, user: victim.address, coin: h.coin, mint: h.mint, swapInstructions: [], quote, coinAccount: c0, slippageBps: bps });
  assert.equal(built.solIn, q.charged, 'the buy offers only the partial quote\'s charge');
  assert.equal(built.swapSolIn, solIn, 'the swap is still guaranteed 20 SOL');
  assert.equal(built.solIn, S.maxQuoteIn(terms, S.coinState(c0)), '= max_quote_in');
  assert.equal(built.minTokensOut, S.withSlippage(q.tokensOut, bps));
  const data = Buffer.from(built.instructions.at(-1).data);
  assert.deepEqual([data.readBigUInt64LE(8), data.readBigUInt64LE(16)], [built.solIn, built.minTokensOut], 'sol_in and min_tokens_out encoded');
  // the old helper's pair (minimum of the partial quote, sol_in uncapped) is refused, not built
  assert.throws(() => S.buyLegMinimum({ solIn, coinAccount: c0, slippageBps: bps }), (e) => e instanceof S.ComposeError && /completes the curve/.test(e.message));
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
  const leg = S.buyWithSwap({ ix: w.ix, user: victim.address, coin: race.coin, mint: race.mint, swapInstructions: [], quote, coinAccount: w.coinView(race), slippageBps: bps });
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
  assert.equal(thr, 390_011_097n, 'config #0 at launch: 1.3% of x0 (150 bps less one run\'s 20, SDK4-4)');
  for (const bps of [100, 200]) assert.throws(() => S.buyLeg({ solIn: LAMPORTS, coinAccount: cf, slippageBps: bps }), (e) => e instanceof S.ComposeError && /sandwich threshold/.test(e.message));
  const leg = S.buyLeg({ solIn: LAMPORTS, coinAccount: cf, slippageBps: S.LARGE_BUY_MAX_SLIPPAGE_BPS });
  const capped = await sandwich(w, fresh2, { V: LAMPORTS, min: leg.minTokensOut, label: '1 SOL at the SDK\'s 0.3%' });
  assert.ok(capped.victimLoss * 10_000n <= capped.plainTokens * 30n, `the victim loses at most 0.3% (${capped.victimLoss})`);
  for (const k of ['outsider', 'founder', 'founderFloat', 'platform']) assert.ok(capped[k] * 10_000n <= LAMPORTS * 30n, `${k} keeps at most 0.3% (${capped[k]})`);
  // one buy alone at the threshold with 5% (5.15's single-trade bound), nobody profits: on the curve at launch,
  // at 40 SOL raised and in a fresh pool, for an outsider, the founder, the founder holding the float and the platform's
  // key. The SDK itself allows only 0.3% at the threshold since trades sharing a block are sandwiched together (MV-1).
  const report = [];
  for (const [raised, symbol] of [[0n, 'SWT0'], [40n, 'SWT40'], ['pool', 'SWTP']]) {
    const h = await coinAt(raised, symbol);
    const c = w.coinView(h);
    const V = S.sandwichThreshold(S.coinTerms(c), S.coinState(c));
    assert.throws(() => S.buyLeg({ solIn: V, coinAccount: c, slippageBps: S.MAX_SWAP_SLIPPAGE_BPS }), /review MV-1/);
    assert.deepEqual([S.buySlippagePolicy(c, V).maxSlippageBps, S.buySlippagePolicy(c, V).large], [S.LARGE_BUY_MAX_SLIPPAGE_BPS, false]);
    const l = { minTokensOut: S.withSlippage(S.quoteBuy(S.coinTerms(c), S.coinState(c), V).tokensOut, S.MAX_SWAP_SLIPPAGE_BPS) };
    const r = await sandwich(w, h, { V, min: l.minTokensOut, label: `${symbol}: ${V} lamports at 5%` });
    for (const k of ['outsider', 'founder', 'founderFloat', 'platform']) assert.ok(r[k] < 0n, `${symbol}: the ${k} loses (${r[k]})`);
    report.push(`${symbol} V=${V}: outsider ${r.outsider}, founder ${r.founder}, founder+float ${r.founderFloat}, platform ${r.platform}`);
  }
  console.log(`MATH3-1: the review's 1 SOL at 1%: outsider ${review.outsider}; 1 SOL at 0.3%: victim loss ${capped.victimLoss} of ${capped.plainTokens}, outsider ${capped.outsider}; at the threshold with 5%: ${report.join(' | ')}`);
  await w.finish();
});

// ---------------------------------------------------------------- review round 4
const CLASSES = { outsider: [], founder: ['founder'], founderFloat: ['founder', 'holders'], platform: ['platform'] };
const creditOf = (legs, keys) => legs.filter(Boolean).reduce((x, q) => x + keys.reduce((y, k) => y + q.split[k], 0n), 0n);
const classResults = (raw, legs) => Object.fromEntries(Object.entries(CLASSES).map(([k, keys]) => [k, raw + creditOf(legs, keys)]));
async function richSigner(w, sol) { const s = await w.signer(0n); w.setRaw(s.address, Buffer.alloc(0), S.ADDRESSES.system, sol * LAMPORTS); return s; }
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');

test('R4-DIFF-1, SM-1, SDK4-1 within about 97,500 lamports of graduation the SDK builds the buy that graduates the coin: sol_in capped at max_quote_in (MIN_TRADE_LAMPORTS), charged the last raw units\' price', async () => {
  const w = await World.create();
  const T = S.DEFAULT_TERMS;
  const byBuy = await w.launchCoin({ cityId: 2_920n, symbol: 'NEARA' });
  const byBuyback = await w.launchCoin({ cityId: 2_921n, symbol: 'NEARB' });
  const raced = await w.launchCoin({ cityId: 2_922n, symbol: 'NEARC' });
  const whale = await richSigner(w, 500n);
  // a buy leaves the curve 50,000 lamports short (the review's griefing state); a buyback leaves it 1 lamport short (5.4, I22)
  for (const h of [byBuy, raced]) await w.buy(whale, h, S.grossFor(T, T.graduationSol - 50_000n), { label: 'the curve to 50,000 lamports short' });
  await w.buy(whale, byBuyback, S.grossFor(T, T.graduationSol - 1_000n), { label: 'the curve to 1,000 lamports short' });
  w.warpSlots(Number(S.BUYBACK_INTERVAL_SLOTS));
  await w.buyback(byBuyback, { label: 'the curve buyback ends at S - 1' });
  const ataRent = w.svm.minimumBalanceForRentExemption(165n);
  for (const [h, label] of [[byBuy, 'after a buy'], [byBuyback, 'after the buyback']]) {
    const coin = w.coinView(h);
    const rem = T.graduationSol - coin.curveSol;
    assert.ok(S.grossFor(T, rem) < S.MIN_TRADE_LAMPORTS, `${label}: the remainder (${rem}) costs less than MIN_TRADE_LAMPORTS`);
    const victim = await w.signer(5n);
    // the website's call: pay with any token, 1 SOL delivered, the default slippage
    const quote = swapQuote({ swapMode: 'ExactIn', outAmount: LAMPORTS + 10_000_000n, otherAmountThreshold: LAMPORTS });
    const policy = S.buySlippagePolicy(coin, LAMPORTS);
    assert.equal(policy.defaultSlippageBps, S.DEFAULT_BUY_SLIPPAGE_BPS);
    const built = S.buyWithSwap({ ix: w.ix, user: victim.address, coin: h.coin, mint: h.mint, swapInstructions: [], quote, coinAccount: coin, slippageBps: policy.defaultSlippageBps });
    assert.equal(built.solIn, S.MIN_TRADE_LAMPORTS, `${label}: the buy offers max_quote_in`);
    assert.equal(built.solIn, S.maxQuoteIn(T, S.coinState(coin)));
    assert.deepEqual([built.quote.partial, built.quote.graduates, built.quote.tokensOut], [true, true, T.curveSupply - coin.tokensSold]);
    assert.equal(S.buyLegMinimum({ solIn: S.MIN_TRADE_LAMPORTS, coinAccount: coin, slippageBps: 100 }), built.minTokensOut);
    const v0 = w.lamportsOf(victim.address);
    await w.send(built.instructions, [victim], `the SDK's buy ${label}`, { feePayer: w.payer });
    w.addHolder(h.mint, victim);
    assert.equal(w.coinView(h).phase, 1, `${label}: the coin graduated`);
    assert.equal(v0 - w.lamportsOf(victim.address), built.quote.charged + ataRent, 'charged the partial quote\'s charge, not MIN_TRADE_LAMPORTS');
    assert.equal(w.balanceOf(victim, h.mint), built.quote.tokensOut, 'the last raw units of the curve');
    console.log(`R4-DIFF-1 ${label}: rem ${rem}, sol_in ${built.solIn}, charged ${built.quote.charged}, coins ${built.quote.tokensOut}, min ${built.minTokensOut}`);
  }
  // the exposure the cap leaves: someone else graduates the coin first; the capped buy runs in the pool, charged MIN_TRADE_LAMPORTS
  const coin = w.coinView(raced);
  const leg = S.buyLeg({ solIn: 20n * LAMPORTS, coinAccount: coin, slippageBps: 100 });
  assert.equal(leg.solIn, S.MIN_TRADE_LAMPORTS);
  await w.buy(whale, raced, S.maxQuoteIn(T, S.coinState(coin)), { label: 'someone else graduates the coin' });
  const victim = await w.signer(5n);
  const r0 = w.lamportsOf(victim.address);
  await w.send(w.buyIxs(victim, raced, leg.solIn, leg.minTokensOut), [victim], 'the capped buy, now in the pool', { feePayer: w.payer });
  w.addHolder(raced.mint, victim);
  assert.equal(r0 - w.lamportsOf(victim.address), S.MIN_TRADE_LAMPORTS + ataRent, 'at most 0.0001 SOL charged in the pool');
  assert.ok(w.balanceOf(victim, raced.mint) >= leg.minTokensOut);
  await w.finish();
});

/** The best straddle of a victim buy `V` with minimum `min` near graduation (5.15, R4-DIFF-3): graduate (`self`: the attacker does it), buy `A` in the new pool, the victim's buy, sell; by the SDK's model (= the program, G01). */
function bestStraddle(T, st, V, min) {
  const grad = S.quoteBuy(T, st, S.maxQuoteIn(T, st));
  let best = null;
  for (const self of [false, true]) {
    for (let A = 10_000_000n; A < 20n * LAMPORTS; A += 10_000_000n) {
      const f = S.quoteBuy(T, grad.newState, A);
      const v = S.quoteBuy(T, f.newState, V);
      if (v.tokensOut < min) break;
      const b = S.quoteSell(T, v.newState, self ? f.tokensOut + grad.tokensOut : f.tokensOut);
      const raw = b.solOut - f.charged - (self ? grad.charged : 0n);
      const res = classResults(raw, self ? [grad, f, b] : [f, b]);
      const top = Object.values(res).reduce((x, y) => (y > x ? y : x));
      if (best === null || top > best.top) best = { top, A, self };
    }
  }
  return best;
}
/** The straddle on chain: `{ results per class, victimTokens }`. */
async function straddle(w, h, { V, min, A, self, label }) {
  const T = S.coinTerms(w.coinView(h));
  const attacker = await richSigner(w, 100n);
  const other = await richSigner(w, 10n);
  const victim = await richSigner(w, 10n);
  const g = await w.buy(self ? attacker : other, h, S.maxQuoteIn(T, S.coinState(w.coinView(h))), { label: `${label}: graduate` });
  const f = await w.buy(attacker, h, A, { label: `${label}: buy in the new pool` });
  await w.send(w.buyIxs(victim, h, V, min), [victim], `${label}: the victim's curve-quoted buy, now in the pool`);
  w.addHolder(h.mint, victim);
  const b = await w.sell(attacker, h, self ? f.q.tokensOut + g.q.tokensOut : f.q.tokensOut, { label: `${label}: sell` });
  const raw = b.q.solOut - f.q.charged - (self ? g.q.charged : 0n);
  return { res: classResults(raw, self ? [g.q, f.q, b.q] : [f.q, b.q]), victimTokens: w.balanceOf(victim, h.mint) };
}

test('R4-DIFF-3, SDK4-2 near graduation the sandwich threshold is judged at the depth of the pool the buy can be pushed into: the old curve-depth size at 5% is straddled for profit, the SDK now refuses it, and at its threshold with 5% every class loses', async () => {
  const w = await World.create();
  const T = S.DEFAULT_TERMS;
  const whale = await richSigner(w, 500n);
  const old = await w.launchCoin({ cityId: 2_930n, symbol: 'STRO' });
  const now = await w.launchCoin({ cityId: 2_931n, symbol: 'STRN' });
  for (const h of [old, now]) await w.buy(whale, h, S.grossFor(T, T.graduationSol - 1_700_000_000n), { label: 'the curve to 1.7 SOL short' });
  const c = w.coinView(now);
  const st = S.coinState(c);
  assert.equal(S.sandwichDepth(T, st), T.graduationSol, 'the pool\'s depth, not the curve\'s 113.3 SOL');
  // the review's victim: the old threshold (150 bps of x0 + curve_sol), 5%, a buy that does not complete the curve
  const oldV = ((T.virtualSol + st.curveSol) * 150n) / 10_000n;
  assert.equal(oldV, 1_699_512_804n);
  assert.equal(S.quoteBuy(T, st, oldV).graduates, false);
  assert.throws(() => S.buyLeg({ solIn: oldV, coinAccount: c, slippageBps: 500 }), /sandwich threshold/);
  const oldMin = S.withSlippage(S.quoteBuy(T, st, oldV).tokensOut, 500);
  const ob = bestStraddle(T, st, oldV, oldMin);
  const o = await straddle(w, old, { V: oldV, min: oldMin, A: ob.A, self: ob.self, label: 'old size at 5%' });
  assert.ok(o.res.founderFloat > 0n, `the old size is straddled for profit by the founder holding the float (${o.res.founderFloat})`);
  // the SDK's threshold (130 bps of 85 SOL with one cap of backlog; the whale's buy left 3.0 caps, so four runs are
  // counted, 70 bps: review KR-1), one buy at it with 5% (the SDK allows only 0.3% there, MV-1)
  assert.deepEqual([S.sandwichRuns(T, st), S.sandwichThreshold(T, st)], [4n, 595_000_000n]);
  const thrNow = S.sandwichThreshold(T, st);
  assert.throws(() => S.buyLeg({ solIn: thrNow, coinAccount: c, slippageBps: 500 }), /review MV-1/);
  const leg = { solIn: thrNow, minTokensOut: S.withSlippage(S.quoteBuy(T, st, thrNow).tokensOut, 500) };
  const nb = bestStraddle(T, st, leg.solIn, leg.minTokensOut);
  assert.ok(nb && nb.top < 0n, `the model's best straddle loses (${nb?.top})`);
  const n = await straddle(w, now, { V: leg.solIn, min: leg.minTokensOut, A: nb.A, self: nb.self, label: 'the SDK\'s threshold at 5%' });
  for (const k of Object.keys(CLASSES)) assert.ok(n.res[k] < 0n, `the ${k} loses (${n.res[k]})`);
  console.log(`R4-DIFF-3: old size ${oldV} at 5%: ${fmt(o.res)}; one buy at the SDK's threshold ${leg.solIn} at 5%: ${fmt(n.res)}`);
  await w.finish();
});

test('SDK4-4, KR-1 due buyback runs inside the sandwich: at the old threshold with 5% the founder holding the float profits with one run; at the SDK\'s threshold (2t/C left for every run the backlog pays for) one buy with 5% loses for every class whenever the attacker sells', async () => {
  const w = await World.create();
  const T = S.DEFAULT_TERMS;
  const trader = await richSigner(w, 100n);
  const report = [];
  for (const [label, V0, cityId, symbol] of [['old 150 bps', (st) => (S.depth(T, st) * 150n) / 10_000n, 2_940n, 'RUNO'], ['SDK', (st) => S.sandwichThreshold(T, st), 2_941n, 'RUNN']]) {
    const h = await w.launchCoin({ cityId, symbol });
    const r = await w.buy(trader, h, 20n * LAMPORTS, { label: 'an earlier buy' });
    await w.sell(trader, h, r.q.tokensOut, { label: 'an earlier sell' });
    w.warpSlots(200);
    const c0 = w.coinView(h); const st0 = S.coinState(c0);
    assert.ok(st0.buybackPending > S.buybackCap(T, st0), 'more than one cap is pending: a run is due');
    // the round trip left about 4 caps: the SDK counts 4 runs (KR-1); the old threshold allowed for none
    const runs = label === 'SDK' ? Number(S.sandwichRuns(T, st0)) : 1;
    if (label === 'SDK') assert.ok(runs >= 3, `${runs} runs counted`);
    const V = V0(st0);
    const min = S.withSlippage(S.quoteBuy(T, st0, V).tokensOut, 500);
    // one buy alone at 5% (5.15's single-trade bound); the SDK allows only 0.3% at its threshold (MV-1)
    if (label === 'SDK') assert.throws(() => S.buyLeg({ solIn: V, coinAccount: c0, slippageBps: 500 }), /review MV-1/);
    let best = null;
    for (let a = 1_000_000n; a < 3n * LAMPORTS; a += 1_000_000n) {
      const f = S.quoteBuy(T, st0, a); const v = S.quoteBuy(T, f.newState, V);
      if (v.tokensOut < min) break;
      let st = v.newState; let slot = w.slot();
      for (let k = 1; k <= runs; k++) {
        const bb = S.quoteBuyback(T, st, slot); if (!bb) break; st = bb.newState; slot += 150n;
        const sq = S.quoteSell(T, st, f.tokensOut);
        const res = classResults(sq.solOut - f.charged, [f, sq]);
        const p = label === 'SDK' ? Object.values(res).reduce((x, y) => (y > x ? y : x)) : res.founderFloat;
        if (!best || p > best.p) best = { a, p, k };
      }
    }
    const attacker = await richSigner(w, 50n); const victim = await richSigner(w, 10n);
    const f = await w.buy(attacker, h, best.a, { label: `${label}: front-run` });
    await w.send(w.buyIxs(victim, h, V, min), [victim], `${label}: the victim's buy at 5%`);
    w.addHolder(h.mint, victim);
    for (let k = 0; k < best.k; k++) {
      if (k) w.warpSlots(150);
      const e = await w.buyback(h, { label: `${label}: due run ${k + 1} inside the sandwich` });
      assert.ok(e.events.some((x) => x.name === 'BuybackBurned'));
    }
    const s = await w.sell(attacker, h, f.q.tokensOut, { label: `${label}: back-run after ${best.k} run(s)` });
    const res = classResults(s.q.solOut - f.q.charged, [f.q, s.q]);
    if (label === 'SDK') for (const k of Object.keys(CLASSES)) assert.ok(res[k] < 0n, `SDK threshold: the ${k} loses (${res[k]})`);
    else assert.ok(res.founderFloat > 0n, `old threshold: the founder holding the float profits (${res.founderFloat})`);
    report.push(`${label} V=${V}, ${best.k} run(s): ${fmt(res)}`);
  }
  console.log(`SDK4-4: ${report.join(' | ')}`);
  await w.finish();
});

test('R4-DIFF-2 splitting a large buy into threshold-size buys in separate transactions is no defence: one sandwich wraps every piece at 1%; judged by the order (orderSolIn, order) each piece allows 0.3% and the loss stays at about 0.3%', async () => {
  const w = await World.create();
  const T = S.DEFAULT_TERMS;
  const order = 5n * LAMPORTS;
  const report = [];
  for (const [label, bps, cityId, symbol] of [['the old advice, 1% per piece', 100, 2_950n, 'SPLA'], ['judged by the order, 0.3% per piece', 30, 2_951n, 'SPLB']]) {
    const h = await w.launchCoin({ cityId, symbol });
    const c0 = w.coinView(h); const st0 = S.coinState(c0);
    const thr = S.sandwichThreshold(T, st0);
    // the pieces and their minimums, all from one snapshot advanced by the earlier pieces, so they can be signed
    // together: the old advice by hand at 1% each (the SDK now refuses it: alone a threshold-size buy allows 0.3%,
    // MV-1, and as a piece of the order 0.3%); the SDK's legs anchored to the order's start (R5-DIFF-1), the snapshot
    // advanced by the earlier pieces as coinAccount and their quoted coins as received
    const pieces = []; let st = st0; let left = order; let received = 0n;
    while (left > 0n) {
      const V = left < thr ? left : thr;
      const coin = { ...c0, ...st };
      let leg;
      if (bps === 100) {
        if (V === thr) assert.throws(() => S.buyLeg({ solIn: V, coinAccount: coin, slippageBps: bps }), /review MV-1/);
        assert.throws(() => S.buyLeg({ solIn: V, coinAccount: coin, slippageBps: bps, orderSolIn: order, order: { start: c0, pieces: pieces.map((l) => l.solIn), received } }), /part of an order/);
        const quote = S.quoteBuy(T, st, V);
        leg = { solIn: V, minTokensOut: S.withSlippage(quote.tokensOut, bps), quote };
      } else {
        leg = S.buyLeg({ solIn: V, coinAccount: coin, slippageBps: bps, orderSolIn: order, order: { start: c0, pieces: pieces.map((l) => l.solIn), received } });
        assert.equal(leg.minTokensOut, S.withSlippage(leg.quote.tokensOut, bps), 'from one snapshot the order\'s floor never binds');
      }
      pieces.push(leg); st = leg.quote.newState; left -= V; received += leg.quote.tokensOut;
    }
    const plain = pieces.reduce((x, l) => x + l.quote.tokensOut, 0n);
    // the largest front-run that lets every piece pass
    const passes = (a) => {
      let s1 = S.quoteBuy(T, st0, a).newState;
      for (const l of pieces) { const q = S.quoteBuy(T, s1, l.solIn); if (q.tokensOut < l.minTokensOut) return false; s1 = q.newState; }
      return true;
    };
    let lo = S.MIN_TRADE_LAMPORTS; let hi = 50n * LAMPORTS;
    assert.ok(passes(lo));
    while (hi - lo > 100_000n) { const m = (lo + hi) / 2n; if (passes(m)) lo = m; else hi = m; }
    const attacker = await richSigner(w, 100n); const victim = await richSigner(w, 20n);
    const f = await w.buy(attacker, h, lo, { label: `${label}: front-run` });
    for (const [i, l] of pieces.entries()) await w.send(w.buyIxs(victim, h, l.solIn, l.minTokensOut), [victim], `${label}: piece ${i + 1} of ${pieces.length}, its own transaction`);
    w.addHolder(h.mint, victim);
    const b = await w.sell(attacker, h, f.q.tokensOut, { label: `${label}: back-run after the last piece` });
    const got = w.balanceOf(victim, h.mint);
    const lossBps = ((plain - got) * 10_000n) / plain;
    const res = classResults(b.q.solOut - f.q.charged, [f.q, b.q]);
    if (bps === 100) {
      assert.ok(lossBps >= 90n, `every piece passed and the victim lost about the whole 1% (${lossBps} bps)`);
      assert.ok(res.outsider > 0n, `an outsider profits (${res.outsider})`);
    } else {
      assert.ok(lossBps <= 30n, `the victim loses at most 0.3% (${lossBps} bps)`);
      for (const k of Object.keys(CLASSES)) assert.ok(res[k] * 10_000n <= order * 30n, `${k} keeps at most 0.3% of the order (${res[k]})`);
    }
    report.push(`${label}: ${pieces.length} pieces of at most ${thr}, front-run ${lo}, victim loss ${lossBps} bps, ${fmt(res)}`);
  }
  console.log(`R4-DIFF-2: ${report.join(' | ')}`);
  await w.finish();
});

/** The least sol_in that buys at least `tokens` raw coins. */
function leastBuyFor(T, st, tokens) {
  let lo = S.MIN_TRADE_LAMPORTS; let hi = 500n * LAMPORTS;
  while (hi - lo > 1n) { const m = (lo + hi) / 2n; if (S.quoteBuy(T, st, m).tokensOut >= tokens) hi = m; else lo = m; }
  return hi;
}

test('R4-DIFF-5, SDK4-3 the sell leg: a sell above the threshold at 1% is sandwiched by an ordinary holder; sellLeg refuses it, at its 0.3% the seller loses at most 0.3%, and a threshold-size sell at 5% leaves every class at a loss', async () => {
  const w = await World.create();
  const T = S.DEFAULT_TERMS;
  const whale = await richSigner(w, 500n);
  const report = [];
  for (const [label, cityId, symbol] of [['1% (no sell rule before round 4)', 2_960n, 'SELA'], ['sellLeg at 0.3%', 2_961n, 'SELB'], ['threshold-size sell at 5%', 2_962n, 'SELC']]) {
    const h = await w.launchCoin({ cityId, symbol });
    await w.buy(whale, h, S.grossFor(T, 45n * LAMPORTS), { label: 'the curve to 45 SOL' });
    const victim = await richSigner(w, 20n);
    const attacker = await richSigner(w, 60n);
    await w.buy(victim, h, label.startsWith('threshold') ? 1_200_000_000n : S.grossFor(T, 5n * LAMPORTS), { label: 'the victim\'s position' });
    const inv = await w.buy(attacker, h, S.grossFor(T, 10n * LAMPORTS), { label: 'the attacker\'s inventory' });
    const c0 = w.coinView(h); const st0 = S.coinState(c0);
    const thr = S.sandwichThreshold(T, st0);
    let tokens = w.balanceOf(victim, h.mint);
    let min;
    if (label.startsWith('1%')) {
      assert.ok(S.quoteSell(T, st0, tokens).gross > thr);
      assert.throws(() => S.sellLeg({ tokensIn: tokens, coinAccount: c0, slippageBps: 100 }), /sandwich threshold/);
      min = S.withSlippage(S.quoteSell(T, st0, tokens).solOut, 100);
    } else if (label.startsWith('sellLeg')) {
      min = S.sellLeg({ tokensIn: tokens, coinAccount: c0, slippageBps: S.sellSlippagePolicy(c0, tokens).defaultSlippageBps }).minSolOut;
      assert.equal(min, S.withSlippage(S.quoteSell(T, st0, tokens).solOut, 30));
    } else {
      while (S.quoteSell(T, st0, tokens).gross > thr) tokens -= tokens / 200n;
      // one sell alone at 5% (5.15's single-trade bound); the SDK allows less at this size (MV-1)
      assert.throws(() => S.sellLeg({ tokensIn: tokens, coinAccount: c0, slippageBps: 500 }), /review MV-1/);
      assert.equal(S.sellSlippagePolicy(c0, tokens).large, false);
      min = S.withSlippage(S.quoteSell(T, st0, tokens).solOut, 500);
    }
    const quoted = S.quoteSell(T, st0, tokens).solOut;
    // the best front-run sell (the attacker then buys back exactly the coins he sold)
    let best = null;
    const step = inv.q.tokensOut / 400n;
    for (let a = step; a <= inv.q.tokensOut; a += step) {
      const f = S.quoteSell(T, st0, a); const v = S.quoteSell(T, f.newState, tokens);
      if (v.solOut < min) break;
      const g = leastBuyFor(T, v.newState, a);
      const bq = S.quoteBuy(T, v.newState, g);
      const res = classResults(f.solOut - bq.charged, [f, bq]);
      const top = Object.values(res).reduce((x, y) => (y > x ? y : x));
      if (!best || top > best.top) best = { a, g, top };
    }
    assert.ok(best, `${label}: some front-run lets the seller pass`);
    const f = await w.sell(attacker, h, best.a, { label: `${label}: front-run sell` });
    const l0 = w.lamportsOf(victim.address);
    await w.send([w.ix.sell({ user: victim.address, coin: h.coin, tokensIn: tokens, minSolOut: min })], [victim], `${label}: the victim's sell`, { feePayer: w.payer });
    const got = w.lamportsOf(victim.address) - l0;
    const b = await w.buy(attacker, h, best.g, { label: `${label}: buy back` });
    assert.ok(b.q.tokensOut >= best.a, 'the attacker has his coins back');
    const res = classResults(f.q.solOut - b.q.charged, [f.q, b.q]);
    const lossBps = ((quoted - got) * 10_000n) / quoted;
    if (label.startsWith('1%')) assert.ok(res.outsider > 0n && lossBps >= 80n, `an ordinary holder profits (${res.outsider}) and the seller loses most of 1% (${lossBps} bps)`);
    else if (label.startsWith('sellLeg')) assert.ok(lossBps <= 30n, `the seller loses at most 0.3% (${lossBps} bps)`);
    else for (const k of Object.keys(CLASSES)) assert.ok(res[k] < 0n, `threshold-size sell at 5%: the ${k} loses (${res[k]})`);
    report.push(`${label}: threshold ${thr}, gross ${S.quoteSell(T, st0, tokens).gross}, seller loss ${lossBps} bps, ${fmt(res)}`);
  }
  console.log(`R4-DIFF-5: ${report.join(' | ')}`);
  await w.finish();
});

// ---------------------------------------------------------------- review round 5
/** A config #0 coin graduated by a whale; by default the keeper then runs every interval until at most one cap of backlog is left. */
async function poolCoin(w, cityId, symbol, { drain = true } = {}) {
  const T = S.DEFAULT_TERMS;
  const h = await w.launchCoin({ cityId, symbol });
  const whale = await richSigner(w, 200n);
  await w.buy(whale, h, S.maxQuoteIn(T, S.coinState(w.coinView(h))), { label: `${symbol}: graduate` });
  w.warpSlots(200);
  while (drain && S.sandwichRuns(T, S.coinState(w.coinView(h))) > 1n) { await w.buyback(h, { label: `${symbol}: the keeper's run` }); w.warpSlots(150); }
  return h;
}
/** Other traders' round trips until the bucket holds at least `caps` caps (a cap at the depth the SDK judges at). */
async function churnTo(w, h, caps, label) {
  const T = S.DEFAULT_TERMS;
  const trader = await richSigner(w, 500n);
  const capAt = (st) => (S.sandwichDepth(T, st) * T.totalFeeBps) / (S.BUYBACK_CAP_DIVISOR * 10_000n);
  let i = 0;
  while (true) {
    const st = S.coinState(w.coinView(h));
    if (st.buybackPending * 1000n >= capAt(st) * BigInt(Math.round(caps * 1000))) break;
    const r = await w.buy(trader, h, 10n * LAMPORTS, { label: `${label}: volume ${++i}` });
    await w.sell(trader, h, r.q.tokensOut, { label: `${label}: volume ${i}` });
  }
  w.warpSlots(200);
}
/**
 * The best wrap of victim buys `legs` ({ solIn, min }) on state `st` by the SDK's model (= the program, G01): front-run
 * `a`, the legs, then up to `maxRuns` due buyback runs (one per interval from `slot`), then the back-run; per class
 * `{ a, p, k }` (k = runs before the back-run).
 */
function bestWrapPerClass(T, st, legs, { slot, maxRuns = 40 } = {}) {
  const best = {};
  for (let a = S.MIN_TRADE_LAMPORTS; a < 30n * LAMPORTS; a += a < LAMPORTS ? 1_000_000n : 5_000_000n) {
    const f = S.quoteBuy(T, st, a); if (f.graduates) break;
    let s = f.newState; let ok = true;
    for (const l of legs) { const q = S.quoteBuy(T, s, l.solIn); if (q.tokensOut < l.min) { ok = false; break; } s = q.newState; }
    if (!ok) break;
    let sl = slot;
    for (let k = 0; k <= maxRuns; k++) {
      const b = S.quoteSell(T, s, f.tokensOut);
      const res = classResults(b.solOut - f.charged, [f, b]);
      for (const [c, p] of Object.entries(res)) if (!best[c] || p > best[c].p) best[c] = { a, p, k };
      const r = S.quoteBuyback(T, s, sl); if (!r) break; s = r.newState; sl += 150n;
    }
  }
  return best;
}
/** The wrap on chain: front-run `a` by a fresh attacker, every victim transaction, `k` runs, the back-run; the class results. */
async function wrapOnChain(w, h, { a, k, victimTxs, label }) {
  const attacker = await richSigner(w, 50n);
  const f = await w.buy(attacker, h, a, { label: `${label}: front-run` });
  for (const [i, v] of victimTxs.entries()) { await w.send(v.instructions, [v.signer], `${label}: victim ${i + 1}`); w.addHolder(h.mint, v.signer); }
  for (let j = 0; j < k; j++) { if (j) w.warpSlots(150); await w.buyback(h, { label: `${label}: run ${j + 1}` }); }
  const b = await w.sell(attacker, h, f.q.tokensOut, { label: `${label}: back-run after ${k} run(s)` });
  return classResults(b.q.solOut - f.q.charged, [f.q, b.q]);
}
/** The largest charge whose policy allows `bps`. */
function largestFor(coin, bps) {
  const thr = S.sandwichThreshold(S.coinTerms(coin), S.coinState(coin));
  let lo = 0n; let hi = thr + 1n;
  while (hi - lo > 1n) { const m = (lo + hi) / 2n; if (m >= S.MIN_TRADE_LAMPORTS && S.buySlippagePolicy(coin, m).maxSlippageBps >= bps) lo = m; else hi = m; }
  return lo;
}
const swapQuoteOf = (V) => swapQuote({ swapMode: 'ExactIn', outAmount: V + 10_000_000n, otherAmountThreshold: V });

test('MV-1 two SDK buys read from one snapshot land in one block: at round 4\'s allowance (5% each at the threshold) the founder wraps both with the due run for a profit; the SDK now refuses that, and at the sizes it allows every class loses', async () => {
  const w = await World.create();
  const T = S.DEFAULT_TERMS;
  const report = [];
  // round 4's allowance: two threshold buys at 5%, one due run (the coin's backlog spent to at most one cap)
  const old = await poolCoin(w, 2_970n, 'MVOLD');
  const c0 = w.coinView(old); const st0 = S.coinState(c0);
  const V = S.sandwichThreshold(T, st0);
  assert.equal(S.sandwichRuns(T, st0), 1n);
  assert.throws(() => S.buyLeg({ solIn: V, coinAccount: c0, slippageBps: 500 }), /review MV-1/);
  const min5 = S.withSlippage(S.quoteBuy(T, st0, V).tokensOut, 500);
  const legsOld = [{ solIn: V, min: min5 }, { solIn: V, min: min5 }];
  const bo = bestWrapPerClass(T, st0, legsOld, { slot: w.slot(), maxRuns: 1 });
  assert.ok(bo.founder.p > 0n, `the model: the founder profits (${bo.founder.p})`);
  const victimsOld = [await richSigner(w, 5n), await richSigner(w, 5n)];
  const ro = await wrapOnChain(w, old, { a: bo.founder.a, k: bo.founder.k, label: 'two threshold buys at 5%', victimTxs: victimsOld.map((v) => ({ signer: v, instructions: w.buyIxs(v, old, V, min5) })) });
  assert.ok(ro.founder > 0n, `on chain the founder profits (${ro.founder}; review MV-1)`);
  report.push(`round 4's allowance: 2 x ${V} at 5%, front ${bo.founder.a}: ${fmt(ro)}`);
  // the SDK now, on a twin coin: two buys at the largest size it allows for 2%, and three at the largest for 1%, built
  // with buyWithSwap from one snapshot; the best class's best wrap through every run
  // (three buys of the largest 1% size, or of half of it, cannot all pass even unattacked: three of a quarter of it)
  for (const [bps, n, part, cityId, symbol] of [[200, 2, 1n, 2_971n, 'MVNEW2'], [100, 3, 4n, 2_972n, 'MVNEW1']]) {
    const h = await poolCoin(w, cityId, symbol);
    w.warpSlots(150);
    const c = w.coinView(h); const st = S.coinState(c);
    const size = largestFor(c, bps) / part;
    assert.ok(size >= S.MIN_TRADE_LAMPORTS && size < S.sandwichThreshold(T, st), `${bps} bps up to ${size}`);
    const victims = []; for (let i = 0; i < n; i++) victims.push(await richSigner(w, 5n));
    const built = victims.map((v) => S.buyWithSwap({ ix: w.ix, user: v.address, coin: h.coin, mint: h.mint, swapInstructions: [], quote: swapQuoteOf(size), coinAccount: c, slippageBps: bps }));
    const best = bestWrapPerClass(T, st, built.map((b) => ({ solIn: b.solIn, min: b.minTokensOut })), { slot: w.slot() });
    assert.equal(Object.keys(best).length, 4, 'some front-run lets every buy pass');
    for (const [k, v] of Object.entries(best)) assert.ok(v.p < 0n, `${n} x ${size} at ${bps} bps: the model's best for the ${k} loses (${v.p})`);
    const top = Object.entries(best).reduce((x, y) => (y[1].p > x[1].p ? y : x));
    const r = await wrapOnChain(w, h, { a: top[1].a, k: top[1].k, label: `${n} SDK buys at ${bps} bps`, victimTxs: victims.map((v, i) => ({ signer: v, instructions: built[i].instructions })) });
    for (const k of Object.keys(CLASSES)) assert.ok(r[k] < 0n, `${n} x ${size} at ${bps} bps on chain: the ${k} loses (${r[k]})`);
    report.push(`SDK: ${n} x ${size} at ${bps} bps, front ${top[1].a} (${top[0]}), ${top[1].k} run(s): ${fmt(r)}`);
  }
  console.log(`MV-1: ${report.join(' | ')}`);
  await w.finish();
});

test('KR-1 a public backlog: one buy at round 4\'s one-run threshold, held through the runs, profits (8.4 caps at 5%, 3 caps at 1%); the SDK now counts every run the backlog pays for and refuses it, and at what it allows every class loses through every run', async () => {
  const w = await World.create();
  const T = S.DEFAULT_TERMS;
  const report = [];
  for (const [caps, bps, cityId, symbol] of [[8.4, 500, 2_975n, 'KRA'], [3, 100, 2_977n, 'KRB']]) {
    // round 4's threshold: 130 bps of the depth whatever the backlog
    const old = await poolCoin(w, cityId, `${symbol}O`);
    await churnTo(w, old, caps, `${symbol}O`);
    const c0 = w.coinView(old); const st0 = S.coinState(c0);
    const oldV = (S.sandwichDepth(T, st0) * 130n) / 10_000n;
    assert.ok(S.sandwichThreshold(T, st0) < oldV, 'the SDK\'s threshold is now lower');
    assert.throws(() => S.buyLeg({ solIn: oldV, coinAccount: c0, slippageBps: bps }), /sandwich threshold/);
    const min = S.withSlippage(S.quoteBuy(T, st0, oldV).tokensOut, bps);
    const bo = bestWrapPerClass(T, st0, [{ solIn: oldV, min }], { slot: w.slot() });
    const who = caps > 5 ? 'founder' : 'founderFloat';
    assert.ok(bo[who].p > 0n && bo[who].k >= 3, `the model: the ${who} profits after ${bo[who].k} runs (${bo[who].p})`);
    const victim = await richSigner(w, 5n);
    const ro = await wrapOnChain(w, old, { a: bo[who].a, k: bo[who].k, label: `${caps} caps, round 4's threshold at ${bps} bps`, victimTxs: [{ signer: victim, instructions: w.buyIxs(victim, old, oldV, min) }] });
    assert.ok(ro[who] > 0n, `on chain the ${who} profits after ${bo[who].k} runs (${ro[who]}; review KR-1)`);
    report.push(`${caps} caps, ${oldV} at ${bps} bps, ${bo[who].k} runs: ${fmt(ro)}`);
    // the SDK now, on a twin coin with the same backlog
    const h = await poolCoin(w, cityId + 1n, `${symbol}N`);
    await churnTo(w, h, caps, `${symbol}N`);
    const c = w.coinView(h); const st = S.coinState(c);
    const runs = S.sandwichRuns(T, st);
    assert.equal(S.sandwichThreshold(T, st), (S.sandwichDepth(T, st) * S.sandwichCostBps(T, st)) / 10_000n);
    assert.equal(S.sandwichCostBps(T, st), runs >= 8n ? 0n : 150n - 20n * runs, `${runs} runs counted`);
    const victimN = await richSigner(w, 5n);
    let built; let size;
    if (S.sandwichThreshold(T, st) === 0n) {
      // nothing left: every buy is large, 0.3%; the victim loses at most that
      size = oldV;
      assert.deepEqual([S.buySlippagePolicy(c, size).maxSlippageBps, S.buySlippagePolicy(c, size).large], [30, true]);
      built = S.buyWithSwap({ ix: w.ix, user: victimN.address, coin: h.coin, mint: h.mint, swapInstructions: [], quote: swapQuoteOf(size), coinAccount: c, slippageBps: 30 });
    } else {
      size = largestFor(c, bps);
      built = S.buyWithSwap({ ix: w.ix, user: victimN.address, coin: h.coin, mint: h.mint, swapInstructions: [], quote: swapQuoteOf(size), coinAccount: c, slippageBps: bps });
    }
    const best = bestWrapPerClass(T, st, [{ solIn: built.solIn, min: built.minTokensOut }], { slot: w.slot() });
    assert.equal(Object.keys(best).length, 4, 'some front-run lets the buy pass');
    const top = Object.entries(best).reduce((x, y) => (y[1].p > x[1].p ? y : x));
    const plain = built.quote.tokensOut;
    const r = await wrapOnChain(w, h, { a: top[1].a, k: top[1].k, label: `${caps} caps, the SDK's buy`, victimTxs: [{ signer: victimN, instructions: built.instructions }] });
    const lossBps = ((plain - w.balanceOf(victimN, h.mint)) * 10_000n) / plain;
    if (S.sandwichThreshold(T, st) === 0n) assert.ok(lossBps <= 30n, `the victim loses at most 0.3% (${lossBps} bps)`);
    else for (const k of Object.keys(CLASSES)) assert.ok(r[k] < 0n, `${caps} caps, the SDK's ${size} at ${bps} bps: the ${k} loses (${r[k]})`);
    report.push(`SDK at ${caps} caps (${runs} runs): ${size} at ${S.buySlippagePolicy(c, size).maxSlippageBps} bps, ${top[1].k} run(s): ${fmt(r)}, victim -${lossBps} bps`);
  }
  console.log(`KR-1: ${report.join(' | ')}`);
  await w.finish();
});

test('R5-DIFF-1 a split order whose pieces are each built from a fresh read: anchored to the order\'s start (order), a searcher who front-runs every piece by the most it clears and sells after the last takes at most the order\'s 0.3%', async () => {
  const w = await World.create();
  const T = S.DEFAULT_TERMS;
  const h = await w.launchCoin({ cityId: 2_980n, symbol: 'RATCH' });
  const start = w.coinView(h);
  const thr = S.sandwichThreshold(T, S.coinState(start));
  const total = 5n * LAMPORTS;
  assert.throws(() => S.buyLeg({ solIn: thr, coinAccount: start, slippageBps: 30, orderSolIn: total }), /needs order: \{ start, pieces, received \}/);
  // the order as quoted at its start: the pieces in sequence with no other trade
  let plain = 0n; { let s = S.coinState(start); let left = total; while (left > 0n) { const V = left < thr ? left : thr; const q = S.quoteBuy(T, s, V); plain += q.tokensOut; s = q.newState; left -= V; } }
  const victim = await richSigner(w, 20n);
  const attacker = await richSigner(w, 100n);
  const pieces = []; let received = 0n; let left = total; let held = 0n; let spent = 0n;
  while (left > 0n) {
    const V = left < thr ? left : thr;
    const fresh = w.coinView(h); // the coin as read just before this piece is signed
    const leg = S.buyLeg({ solIn: V, coinAccount: fresh, slippageBps: 30, orderSolIn: total, order: { start, pieces, received } });
    // the searcher's front-run: the most that still lets the piece pass (the model on the same read)
    const st = S.coinState(fresh);
    const passes = (a) => S.quoteBuy(T, S.quoteBuy(T, st, a).newState, leg.solIn).tokensOut >= leg.minTokensOut;
    let lo = 0n; let hi = 30n * LAMPORTS; while (hi - lo > 10_000n) { const m = (lo + hi) / 2n; if (m >= S.MIN_TRADE_LAMPORTS && passes(m)) lo = m; else hi = m; }
    if (lo >= S.MIN_TRADE_LAMPORTS) { const f = await w.buy(attacker, h, lo, { label: `front-run of piece ${pieces.length + 1}` }); held += f.q.tokensOut; spent += f.q.charged; }
    const t0 = w.balanceOf(victim, h.mint);
    await w.send(w.buyIxs(victim, h, leg.solIn, leg.minTokensOut), [victim], `piece ${pieces.length + 1}, its own transaction`);
    w.addHolder(h.mint, victim);
    received += w.balanceOf(victim, h.mint) - t0; pieces.push(leg.solIn); left -= V;
  }
  const b = await w.sell(attacker, h, held, { label: 'the searcher sells after the last piece' });
  const lossBps = ((plain - received) * 10_000n) / plain;
  const outsider = b.q.solOut - spent;
  assert.equal(pieces.length, 13);
  assert.ok(lossBps <= 30n, `the order loses at most its 0.3% (${lossBps} bps; review R5-DIFF-1 measured 187 with fresh minimums)`);
  assert.ok(outsider * 10_000n <= total * 30n, `the searcher keeps at most 0.3% of the order (${outsider})`);
  console.log(`R5-DIFF-1: ${pieces.length} pieces of at most ${thr}, the order lost ${lossBps} bps, the searcher ${outsider}`);
  await w.finish();
});
