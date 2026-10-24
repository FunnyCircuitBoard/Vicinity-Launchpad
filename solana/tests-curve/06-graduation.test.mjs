// L07: graduation (5.4, 5.6, 5.10, I5, I17): exactly at S coins sold and 85 SOL
// in the curve; the partial fill of the last buy (E3, E6), the last raw unit for
// 1 lamport (E10, rem = 1), the strict minimum of a completing buy, Graduated,
// and the next trade on the pool with the same account list (E4, E5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, S, expectFail, LAMPORTS } from './helpers.mjs';

const T = S.DEFAULT_TERMS;

test('L07 E3: one buy of 100 SOL fills the curve, is charged 87,179,487,179 and graduates at exactly 85 SOL; the pool takes over (E4, E5)', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 200n, symbol: 'GRAD' });
  const u = await w.signer(500n);
  const l0 = w.lamportsOf(u.address);
  const b = await w.buy(u, h, 100n * LAMPORTS);
  const ataRent = w.svm.minimumBalanceForRentExemption(165n);
  assert.equal(l0 - w.lamportsOf(u.address) - ataRent, 87_179_487_179n, 'charged; 12.82 SOL never left the wallet');
  assert.deepEqual([b.q.partial, b.q.graduates, b.q.tokensOut], [true, true, 793_099_990_000_000n]);
  let c = w.coinView(h);
  assert.deepEqual([c.phase, c.tokensSold, c.curveSol, c.poolSol, c.poolTokens], [1, T.curveSupply, 85_000_000_000n, 85_000_000_000n, 206_900_000_900_000n], 'exactly at S and R; the pool opens at (R, P)');
  assert.deepEqual([c.liquidityPending, c.platformPending, c.founderPending, c.holdersPending, c.buybackPending], [435_897_438n, 610_256_410n, 435_897_435n, 435_897_435n, 261_538_461n]);
  assert.deepEqual([c.graduatedAt, c.graduationSlot], [w.now(), w.slot()]);
  assert.equal(w.tokenBalance(h.vault), T.poolSupply, 'the vault holds exactly P');
  const t = b.res.events.find((e) => e.name === 'Trade').data;
  assert.deepEqual([t.phase, t.sol_in, t.sol_amount, t.sol_net, t.partial, t.graduated, t.virtual_sol_after, t.virtual_tokens_after],
    [0, 100n * LAMPORTS, 87_179_487_179n, 85_000_000_000n, true, true, 85_000_000_000n, 206_900_000_900_000n]);
  const g = b.res.events.find((e) => e.name === 'Graduated').data;
  assert.deepEqual([g.pool_sol, g.pool_tokens, g.liquidity_pending, g.last_virtual_sol, g.last_virtual_tokens],
    [85_000_000_000n, 206_900_000_900_000n, 435_897_438n, 115_000_853_639n, 279_925_608_486_615n]);
  // 5.10: the pool opens below the curve's last price, never above
  assert.ok(85_000_000_000n * 279_925_608_486_615n <= 115_000_853_639n * 206_900_000_900_000n);
  // E4 on the pool with the very same instruction shape
  const v = await w.signer(10n);
  const before = w.ix.buy({ user: v.address, coin: h.coin, solIn: 1n, minTokensOut: 0n }).accounts.map((a) => a.address);
  const e4 = await w.buy(v, h, LAMPORTS);
  assert.deepEqual(w.ix.buy({ user: v.address, coin: h.coin, solIn: 1n, minTokensOut: 0n }).accounts.map((a) => a.address), before, 'same 10 accounts');
  assert.deepEqual([e4.q.tokensOut, e4.q.drip], [2_346_350_693_544n, 5_000_000n]);
  c = w.coinView(h);
  assert.deepEqual([c.poolSol, c.poolTokens, c.liquidityPending], [85_985_000_000n, 204_553_650_206_456n, 430_897_438n]);
  // E5
  const e5 = await w.sell(v, h, 2_346_350_693_544n);
  assert.deepEqual([e5.q.gross, e5.q.solOut, e5.q.drip], [975_113_405n, 950_735_570n, 4_875_567n]);
  c = w.coinView(h);
  assert.deepEqual([c.poolSol, c.poolTokens, c.liquidityPending], [85_019_637_730n, 206_900_000_900_000n, 426_021_871n]);
  await w.finish();
});

test('L07 E6: from 84.5 SOL a 1 SOL buy is a partial fill charged 512,820,512; max_quote_in sizes it exactly', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 201n, symbol: 'PART' });
  const a = await w.signer(200n); const b = await w.signer(10n);
  await w.buy(a, h, 86_666_666_666n);
  let c = w.coinView(h);
  assert.deepEqual([c.tokensSold, c.curveSol], [791_877_616_545_871n, 84_500_000_000n]);
  assert.equal(S.maxQuoteIn(S.coinTerms(c), S.coinState(c)), 512_820_512n);
  // a buyer who expects more coins than remain is refused and pays nothing (strict minimum, M13)
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: b.address, owner: b.address, mint: h.mint })], [b], 'b\'s token account');
  await expectFail(() => w.send([w.ix.buy({ user: b.address, coin: h.coin, solIn: LAMPORTS, minTokensOut: 1_222_373_454_130n })], [b], 'expects more than remains'), 'SlippageExceeded');
  const l0 = w.lamportsOf(b.address);
  const r = await w.buy(b, h, LAMPORTS, { min: 1_222_373_454_129n });
  assert.equal(l0 - w.lamportsOf(b.address), 512_820_512n, '487,179,488 lamports stay in the wallet');
  assert.deepEqual([r.q.charged, r.q.tokensOut, r.q.partial, r.q.graduates], [512_820_512n, 1_222_373_454_129n, true, true]);
  assert.deepEqual([r.q.split.fee, r.q.split.liquidity, r.q.split.platform, r.q.split.founder, r.q.split.holders, r.q.split.buyback],
    [12_820_512n, 2_564_104n, 3_589_743n, 2_564_102n, 2_564_102n, 1_538_461n]);
  c = w.coinView(h);
  assert.deepEqual([c.phase, c.curveSol, c.poolSol], [1, 85_000_000_000n, 85_000_000_000n]);
  await w.finish();
});

test('L07 E10 (rem = 1): at R - 1 the last raw unit costs 1 lamport, fee 0, and graduates; a buy of exactly max_quote_in is not partial', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 202n, symbol: 'LAST' });
  const a = await w.signer(500n); const b = await w.signer(500n);
  await w.buy(a, h, S.grossFor(T, S.curveValue(T, T.curveSupply - 1n)));
  let c = w.coinView(h);
  assert.deepEqual([c.tokensSold, c.curveSol], [T.curveSupply - 1n, T.graduationSol - 1n]);
  const l0 = w.lamportsOf(b.address);
  const r = await w.buy(b, h, 100_000n);
  assert.deepEqual([r.q.charged, r.q.split.fee, r.q.tokensOut, r.q.graduates, r.q.partial], [1n, 0n, 1n, true, true]);
  assert.equal(l0 - w.lamportsOf(b.address) - w.svm.minimumBalanceForRentExemption(165n), 1n, 'one lamport');
  c = w.coinView(h);
  assert.deepEqual([c.phase, c.curveSol, c.tokensSold], [1, T.graduationSol, T.curveSupply]);
  // a second coin: a buy of exactly max_quote_in from 10 SOL raised completes with charged == sol_in or by the least charge
  const h2 = await w.launchCoin({ cityId: 203n, symbol: 'EXACT' });
  await w.buy(a, h2, 10n * LAMPORTS);
  c = w.coinView(h2);
  const g = S.maxQuoteIn(S.coinTerms(c), S.coinState(c));
  const r2 = await w.buy(b, h2, g);
  assert.equal(r2.q.graduates, true);
  assert.equal(r2.q.charged, g, 'max_quote_in is charged in full');
  assert.equal(r2.q.net, T.graduationSol - c.curveSol, 'and nets exactly the lamports still needed');
  // one lamport below max_quote_in does not complete the curve
  const h3 = await w.launchCoin({ cityId: 204n, symbol: 'BELOW' });
  await w.buy(a, h3, 10n * LAMPORTS);
  const c3 = w.coinView(h3);
  const g3 = S.maxQuoteIn(S.coinTerms(c3), S.coinState(c3));
  const r3 = await w.buy(b, h3, g3 - 1n);
  assert.equal(r3.q.graduates, false);
  assert.equal(w.coinView(h3).phase, 0);
  await w.finish();
});

test('L07 graduation cannot happen twice; curve sells after it are pool sells; the whole supply can be sold back into the pool', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 205n, symbol: 'TWICE' });
  const u = await w.signer(500n);
  await w.buy(u, h, 100n * LAMPORTS);
  const again = await w.buy(u, h, 50n * LAMPORTS);
  assert.equal(again.q.graduates, false);
  assert.equal(again.res.events.filter((e) => e.name === 'Graduated').length, 0);
  // sell everything the buyer holds back into the pool (X*Y never decreases; reserves stay positive)
  const all = w.balanceOf(u, h.mint);
  await w.sell(u, h, all);
  const c = w.coinView(h);
  assert.ok(c.poolSol >= (T.graduationSol * T.poolSupply) / S.COIN_SUPPLY, 'pool SOL above the floor R*P/10^15 of 5.7');
  await w.finish();
});
