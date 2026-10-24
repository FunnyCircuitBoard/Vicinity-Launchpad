// L06: curve trading (4.11, 4.12, 5.2 to 5.5): buys and sells with the exact fee
// buckets to the lamport (E1, E2, E9 of 5.14), the minimum buy, slippage both
// ways, the refusals of a sell (zero amount, beyond the curve, a flat step),
// the user token account rules, and Trade events equal to state (the checker
// replays every trade through the SDK's math port).
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, S, expectFail, LAMPORTS } from './helpers.mjs';

const buckets = (c) => [c.liquidityPending, c.platformPending, c.founderPending, c.holdersPending, c.buybackPending];

test('L06 E1 and E2 to the lamport: buy 1 SOL at launch, sell the coins back; every bucket exact', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 100n, symbol: 'EONE' });
  const u = await w.signer(10n);
  const rent = w.coinView(h).rentReserve;
  // E1
  const l0 = w.lamportsOf(u.address);
  const b = await w.buy(u, h, 1_000_000_000n);
  const ataRent = w.svm.minimumBalanceForRentExemption(165n);
  assert.equal(l0 - w.lamportsOf(u.address), 1_000_000_000n + ataRent, 'charged exactly 1 SOL (plus the new token account\'s rent; the fee payer pays the fee)');
  assert.equal(w.balanceOf(u, h.mint), 33_774_693_369_781n, '33,774,693.369781 coins');
  let c = w.coinView(h);
  assert.deepEqual(buckets(c), [5_000_000n, 7_000_000n, 5_000_000n, 5_000_000n, 3_000_000n]);
  assert.deepEqual([c.tokensSold, c.curveSol, c.tradeSeq, c.buyVolume, c.feesTotal], [33_774_693_369_781n, 975_000_000n, 1n, 1_000_000_000n, 25_000_000n]);
  assert.deepEqual(S.spotPrice(S.coinTerms(c), S.coinState(c)), [30_975_853_639n, 1_039_250_905_116_834n]);
  assert.equal(w.lamportsOf(h.coin), rent + 1_000_000_000n);
  const t = b.res.events.find((e) => e.name === 'Trade').data;
  assert.deepEqual([t.is_buy, t.phase, t.sol_in, t.sol_amount, t.sol_net, t.token_amount, t.fee, t.partial, t.graduated, t.trade_seq],
    [true, 0, 1_000_000_000n, 1_000_000_000n, 975_000_000n, 33_774_693_369_781n, 25_000_000n, false, false, 1n]);
  // E2: path independence, 950,625,000 back
  const s = await w.sell(u, h, 33_774_693_369_781n);
  assert.equal(s.q.solOut, 950_625_000n);
  c = w.coinView(h);
  assert.deepEqual([c.tokensSold, c.curveSol], [0n, 0n], 'the curve back to zero exactly');
  assert.deepEqual(buckets(c), [9_875_000n, 13_825_000n, 9_875_000n, 9_875_000n, 5_925_000n]);
  assert.equal(w.lamportsOf(h.coin) - rent, 49_375_000n, 'only the two fees remain');
  assert.equal(c.sellVolume, 975_000_000n);
  const ts = s.res.events.find((e) => e.name === 'Trade').data;
  assert.deepEqual([ts.is_buy, ts.sol_in, ts.sol_amount, ts.sol_net, ts.fee, ts.fee_liquidity, ts.fee_platform, ts.fee_founder, ts.fee_holders, ts.fee_buyback, ts.trade_seq],
    [false, 0n, 975_000_000n, 950_625_000n, 24_375_000n, 4_875_000n, 6_825_000n, 4_875_000n, 4_875_000n, 2_925_000n, 2n]);
  await w.finish();
});

test('L06 the minimum buy (E9), slippage both ways, and the sell refusals', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 101n, symbol: 'MIN' });
  const u = await w.signer(10n);
  // E9: 0.0001 SOL is the smallest buy; one lamport less is refused
  const ataIx = S.createAssociatedTokenAccountIdempotent({ payer: u.address, owner: u.address, mint: h.mint });
  await expectFail(() => w.send([ataIx, w.ix.buy({ user: u.address, coin: h.coin, solIn: 99_999n, minTokensOut: 0n })], [u], 'buy 99,999'), 'TradeTooSmall');
  const e9 = await w.buy(u, h, 100_000n);
  assert.equal(e9.q.tokensOut, 3_487_222_633n);
  assert.deepEqual(buckets(w.coinView(h)), [500n, 700n, 500n, 500n, 300n]);
  // slippage: a minimum one above the quote is refused and nothing moves; the quote itself passes
  const c = w.coinView(h);
  const q = S.quoteBuy(S.coinTerms(c), S.coinState(c), 2n * LAMPORTS);
  await expectFail(() => w.send([w.ix.buy({ user: u.address, coin: h.coin, solIn: 2n * LAMPORTS, minTokensOut: q.tokensOut + 1n })], [u], 'buy above the quote'), 'SlippageExceeded');
  await w.buy(u, h, 2n * LAMPORTS, { min: q.tokensOut });
  const bal = w.balanceOf(u, h.mint);
  const c2 = w.coinView(h);
  const qs = S.quoteSell(S.coinTerms(c2), S.coinState(c2), bal / 3n);
  await expectFail(() => w.send([w.ix.sell({ user: u.address, coin: h.coin, tokensIn: bal / 3n, minSolOut: qs.solOut + 1n })], [u], 'sell above the quote'), 'SlippageExceeded');
  await w.sell(u, h, bal / 3n, { min: qs.solOut });
  // sells: zero, beyond the curve (refused before any token moves), a flat step of f releasing nothing
  await expectFail(() => w.send([w.ix.sell({ user: u.address, coin: h.coin, tokensIn: 0n, minSolOut: 0n })], [u], 'sell 0'), 'ZeroAmount');
  const sold = w.coinView(h).tokensSold;
  await expectFail(() => w.send([w.ix.sell({ user: u.address, coin: h.coin, tokensIn: sold + 1n, minSolOut: 0n })], [u], 'sell beyond the curve'), 'SellExceedsCurve');
  // after a buy the curve sits on the top of a step (C1): one raw unit back releases 0 lamports
  const v = await w.signer(10n);
  await w.buy(v, h, 1_234_567n);
  await expectFail(() => w.send([w.ix.sell({ user: v.address, coin: h.coin, tokensIn: 1n, minSolOut: 0n })], [v], 'sell 1 raw unit'), 'ZeroOutput');
  // there is no minimum on sells: a small sell that releases something works (O5)
  const cc = w.coinView(h);
  let n = 1n;
  const releases = (k) => { try { return S.quoteSell(S.coinTerms(cc), S.coinState(cc), k).solOut >= 1n; } catch (e) { if (e.code === 'ZeroOutput') return false; throw e; } };
  while (!releases(n)) n *= 2n;
  await w.sell(v, h, n, { label: `small sell of ${n} raw units` });
  await w.finish();
});

test('L06 the user token account: right mint, never one of the Coin PDA, a sell only from the user\'s own account', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 102n, symbol: 'TOKA' });
  const h2 = await w.launchCoin({ cityId: 103n, symbol: 'TOKB' });
  const u = await w.signer(10n); const v = await w.signer(10n);
  await w.buy(u, h, LAMPORTS);
  await w.buy(u, h2, LAMPORTS);
  // another coin's token account
  await expectFail(() => w.send([w.ix.buy({ user: u.address, coin: h.coin, userTokenAccount: S.associatedTokenAddress(u.address, h2.mint), solIn: LAMPORTS, minTokensOut: 0n })], [u], 'wrong mint'), 'WrongTokenAccount');
  // the vault itself, and a token account whose authority is the Coin PDA (coins could never move again)
  await expectFail(() => w.send([w.ix.buy({ user: u.address, coin: h.coin, userTokenAccount: h.vault, solIn: LAMPORTS, minTokensOut: 0n })], [u], 'the vault'), 'SameAccount');
  const coinAta = S.associatedTokenAddress(h.coin, h.mint);
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: u.address, owner: h.coin, mint: h.mint })], [u], 'an ATA of the Coin PDA');
  await expectFail(() => w.send([w.ix.buy({ user: u.address, coin: h.coin, userTokenAccount: coinAta, solIn: LAMPORTS, minTokensOut: 0n })], [u], 'the Coin PDA\'s ATA'), 'SameAccount');
  // a buy may deliver to someone else's token account of the mint (a router's)
  const vAta = S.associatedTokenAddress(v.address, h.mint);
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: v.address, owner: v.address, mint: h.mint })], [v], 'v\'s ATA');
  await w.send([w.ix.buy({ user: u.address, coin: h.coin, userTokenAccount: vAta, solIn: LAMPORTS, minTokensOut: 0n })], [u], 'buy for v');
  w.addHolder(h.mint, v);
  assert.ok(w.balanceOf(v, h.mint) > 0n);
  // a sell only from the user's own token account
  await expectFail(() => w.send([w.ix.sell({ user: u.address, coin: h.coin, userTokenAccount: vAta, tokensIn: 1_000_000n, minSolOut: 0n })], [u], 'sell from v\'s account'), 'WrongTokenAccount');
  // the vault and mint of another coin in a trade
  await expectFail(() => w.send([w.ix.buy({ user: u.address, coin: h.coin, solIn: LAMPORTS, minTokensOut: 0n, overrides: { coin_vault: h2.vault } })], [u], 'another vault'), 'InvalidAddress');
  await expectFail(() => w.send([w.ix.sell({ user: u.address, coin: h.coin, tokensIn: 1_000_000n, minSolOut: 0n, overrides: { mint: h2.mint, user_token_account: S.associatedTokenAddress(u.address, h2.mint) } })], [u], 'another mint'), 'InvalidAddress');
  await w.finish();
});

test('L06 many traders on one curve: every Trade equals state, round trips lose, the curve stays a function of tokens sold', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 104n, symbol: 'MANY' });
  const traders = [await w.signer(500n), await w.signer(500n), await w.signer(500n)];
  let x = 7; let trades = 0n;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  for (let k = 0; k < 40; k++) {
    const t = traders[k % 3];
    const bal = w.balanceOf(t, h.mint);
    if (rnd() < 0.6 || bal === 0n) {
      await w.buy(t, h, BigInt(Math.floor(rnd() * 3e9)) + 100_000n, { label: `buy ${k}` }); trades++;
    } else {
      const amt = (bal * BigInt(Math.floor(rnd() * 100) + 1)) / 100n;
      const c = w.coinView(h);
      let q; try { q = S.quoteSell(S.coinTerms(c), S.coinState(c), amt); } catch { continue; }
      if (q.solOut >= 1n) { await w.sell(t, h, amt, { label: `sell ${k}` }); trades++; }
    }
  }
  // a round trip from this state loses (I18)
  const r = await w.signer(100n);
  const b = await w.buy(r, h, 5n * LAMPORTS);
  const s = await w.sell(r, h, b.q.tokensOut);
  assert.ok(s.q.solOut < b.q.charged);
  const loss = Number(b.q.charged - s.q.solOut) / Number(b.q.charged);
  assert.ok(loss > 0.0493 && loss < 0.0495, `curve round trip costs about 4.94% (${loss})`);
  assert.equal(w.coinView(h).tradeSeq, trades + 2n, 'trade_seq counts every trade, gap-free');
  await w.finish();
});
