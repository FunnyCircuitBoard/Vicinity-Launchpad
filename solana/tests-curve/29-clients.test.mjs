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
  // the website's call: the coin as read before signing, 2% slippage (14.1's default range is 1% to 2%)
  const c0 = w.coinView(h);
  const { instructions, minTokensOut } = S.buyWithSwap({ ...base, coinAccount: c0, slippageBps: 200 });
  const quoted = S.quoteBuy(S.coinTerms(c0), S.coinState(c0), solIn).tokensOut;
  assert.equal(minTokensOut, S.withSlippage(quoted, 200));
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
  const fresh = S.buyWithSwap({ ...base, coinAccount: w.coinView(h), slippageBps: 200 });
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
