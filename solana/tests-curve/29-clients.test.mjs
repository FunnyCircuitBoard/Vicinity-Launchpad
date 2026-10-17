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
  // "pay with any token": the swap delivers at least 20 SOL (ExactIn), the website's 2% on the buy leg
  const quote = swapQuote({ swapMode: 'ExactIn', outAmount: solIn + 200_000_000n, otherAmountThreshold: solIn });
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
  assert.equal(thr, 390_011_097n, 'config #0 at launch: 1.3% of x0 (150 bps less one run\'s 20, SDK4-4)');
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
  // the SDK's threshold at 5%
  const leg = S.buyLeg({ solIn: S.sandwichThreshold(T, st), coinAccount: c, slippageBps: 500 });
  assert.deepEqual([leg.large, leg.threshold], [false, 1_105_000_000n]);
  const nb = bestStraddle(T, st, leg.solIn, leg.minTokensOut);
  assert.ok(nb && nb.top < 0n, `the model's best straddle loses (${nb?.top})`);
  const n = await straddle(w, now, { V: leg.solIn, min: leg.minTokensOut, A: nb.A, self: nb.self, label: 'the SDK\'s threshold at 5%' });
  for (const k of Object.keys(CLASSES)) assert.ok(n.res[k] < 0n, `the ${k} loses (${n.res[k]})`);
  console.log(`R4-DIFF-3: old size ${oldV} at 5%: ${fmt(o.res)}; the SDK's ${leg.solIn} at 5%: ${fmt(n.res)}`);
  await w.finish();
});

test('SDK4-4 a due buyback run inside the sandwich: at the old threshold with 5% the founder holding the float profits; at the SDK\'s threshold (2t/C left for the run) every class loses', async () => {
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
    const V = V0(st0);
    const min = S.withSlippage(S.quoteBuy(T, st0, V).tokensOut, 500);
    if (label === 'SDK') assert.equal(S.buyLeg({ solIn: V, coinAccount: c0, slippageBps: 500 }).minTokensOut, min);
    const slot = w.slot();
    let best = null;
    for (let a = 1_000_000n; a < 3n * LAMPORTS; a += 1_000_000n) {
      const f = S.quoteBuy(T, st0, a); const v = S.quoteBuy(T, f.newState, V);
      if (v.tokensOut < min) break;
      const bb = S.quoteBuyback(T, v.newState, slot);
      const s = S.quoteSell(T, bb.newState, f.tokensOut);
      const p = s.solOut - f.charged + creditOf([f, s], CLASSES.founderFloat);
      if (!best || p > best.p) best = { a, p };
    }
    const attacker = await richSigner(w, 50n); const victim = await richSigner(w, 10n);
    const f = await w.buy(attacker, h, best.a, { label: `${label}: front-run` });
    await w.send(w.buyIxs(victim, h, V, min), [victim], `${label}: the victim's buy at 5%`);
    w.addHolder(h.mint, victim);
    const e = await w.buyback(h, { label: `${label}: the due run inside the sandwich` });
    assert.ok(e.events.some((x) => x.name === 'BuybackBurned'));
    const s = await w.sell(attacker, h, f.q.tokensOut, { label: `${label}: back-run` });
    const res = classResults(s.q.solOut - f.q.charged, [f.q, s.q]);
    if (label === 'SDK') for (const k of Object.keys(CLASSES)) assert.ok(res[k] < 0n, `SDK threshold: the ${k} loses (${res[k]})`);
    else assert.ok(res.founderFloat > 0n, `old threshold: the founder holding the float profits (${res.founderFloat})`);
    report.push(`${label} V=${V}: ${fmt(res)}`);
  }
  console.log(`SDK4-4: ${report.join(' | ')}`);
  await w.finish();
});

test('R4-DIFF-2 splitting a large buy into threshold-size buys in separate transactions is no defence: one sandwich wraps every piece at 1%; judged by the order (orderSolIn) each piece allows 0.3% and the loss stays at about 0.3%', async () => {
  const w = await World.create();
  const T = S.DEFAULT_TERMS;
  const order = 5n * LAMPORTS;
  const report = [];
  for (const [label, bps, cityId, symbol] of [['the old advice, 1% per piece', 100, 2_950n, 'SPLA'], ['judged by the order, 0.3% per piece', 30, 2_951n, 'SPLB']]) {
    const h = await w.launchCoin({ cityId, symbol });
    const c0 = w.coinView(h); const st0 = S.coinState(c0);
    const thr = S.sandwichThreshold(T, st0);
    // the pieces and their minimums, each from the snapshot advanced by the earlier pieces (as a client would)
    const pieces = []; let st = st0; let left = order;
    while (left > 0n) {
      const V = left < thr ? left : thr;
      const coin = { ...c0, ...st };
      if (bps === 100) {
        assert.equal(S.buyLeg({ solIn: V, coinAccount: coin, slippageBps: bps }).large, false, 'alone, each piece may allow 1%');
        assert.throws(() => S.buyLeg({ solIn: V, coinAccount: coin, slippageBps: bps, orderSolIn: order }), /part of an order/);
      }
      const leg = bps === 100 ? S.buyLeg({ solIn: V, coinAccount: coin, slippageBps: bps }) : S.buyLeg({ solIn: V, coinAccount: coin, slippageBps: bps, orderSolIn: order });
      pieces.push(leg); st = leg.quote.newState; left -= V;
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
      const leg = S.sellLeg({ tokensIn: tokens, coinAccount: c0, slippageBps: 500 });
      assert.equal(leg.large, false);
      min = leg.minSolOut;
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
