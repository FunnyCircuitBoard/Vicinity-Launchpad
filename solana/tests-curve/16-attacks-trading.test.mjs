// Attack tests of 12.4 on trading (section 10): X13 zero outputs (every way to
// pay for nothing, including a minimum buy into a pool whose price a whale has
// pushed above 97,500 lamports per raw unit), X14 overflow (u64::MAX in every
// argument and every config field), X15 division by zero (the configs that would
// divide by zero, and trades at extreme pool states), X16 partial-fill edges
// (remainders 1 to 8, 39 to 41, the minimum buy's boundary 97,499 to 97,501, a
// large one, and a mid-step start), X17 a victim forced near completion, X18
// oversell, X19 graduation arbitrage, X20 pre-creation and graduation griefing,
// X21 double graduation, X22 half-graduated state, X40 re-selling burned coins,
// X41 compute exhaustion, X42 a trade while another coin is hammered, X57 stale
// quotes.
//
// Every refusal goes through World.send (the failed-transaction check: nothing
// moved but the fee payer's fee, no vicinity_curve byte changed); `refuse` also
// compares the attacked accounts, and the victims below never pay the fee, so
// their balances must be exactly unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner } from '@solana/kit';
import { World, S, expectFail, mintInfo, LAMPORTS } from './helpers.mjs';

const T = S.DEFAULT_TERMS;
const U64 = S.U64_MAX;
const fingerprint = (w, addrs) => addrs.map((a) => { const x = w.accountInfo(a); return x ? `${a}:${x.lamports}:${x.data.toString('hex')}` : `${a}:none`; });
async function refuse(w, watch, fn, ...codes) {
  const before = fingerprint(w, watch);
  const e = await expectFail(fn, ...codes);
  assert.deepEqual(fingerprint(w, watch), before, 'an attacked account changed');
  return e;
}
const coinAccounts = (h) => [h.coin, h.mint, h.vault];
const view = (w, h) => w.coinView(h);
const st = (w, h) => S.coinState(w.coinView(h));
const quoteBuy = (w, h, g) => S.quoteBuy(T, st(w, h), g);
const quoteSell = (w, h, n) => S.quoteSell(T, st(w, h), n);
const buyIx = (w, user, h, solIn, minTokensOut = 0n, o = {}) => w.ix.buy({ user: user.address, coin: h.coin, solIn, minTokensOut, ...o });
const sellIx = (w, user, h, tokensIn, minSolOut = 0n, o = {}) => w.ix.sell({ user: user.address, coin: h.coin, tokensIn, minSolOut, ...o });
/** A funded signer with a token account of the coin already created (so a refused buy moves nothing at all). */
async function trader(w, h, sol = 100n) {
  const s = await w.signer(sol);
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: w.payer.address, owner: s.address, mint: h.mint })], [], 'token account');
  w.addHolder(h.mint, s);
  return s;
}
/** A signer holding `lamports` exactly (set out of band: more than the test faucet holds). */
async function whale(w, lamports) {
  const s = await w.signer(0n);
  w.setRaw(s.address, Buffer.alloc(0), S.ADDRESSES.system, lamports);
  return s;
}

// ---------------------------------------------------------------- X13
test('X13 zero outputs: no buy or sell can pay for nothing, on the curve or in the pool (including a minimum buy after a whale pushed the pool price above 97,500 lamports per raw unit)', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1600n, symbol: 'ZOUT' });
  const u = await trader(w, h);
  const watch = [...coinAccounts(h), u.address, S.associatedTokenAddress(u.address, h.mint)];
  await refuse(w, watch, () => w.send([buyIx(w, u, h, 0n)], [u], 'buy 0'), 'TradeTooSmall');
  await refuse(w, watch, () => w.send([buyIx(w, u, h, S.MIN_TRADE_LAMPORTS - 1n)], [u], 'buy 99,999'), 'TradeTooSmall');
  await refuse(w, watch, () => w.send([sellIx(w, u, h, 0n)], [u], 'sell 0'), 'ZeroAmount');
  await w.buy(u, h, 3_333_333n, { label: 'buy (the curve on top of a step)' });
  // after a buy the curve sits on the top of a flat step: a sell inside it releases 0 lamports
  let n = 1n; while (quoteSellOrZero(w, h, n * 2n) === 0n) n *= 2n;
  await refuse(w, watch, () => w.send([sellIx(w, u, h, 1n)], [u], 'sell 1 raw unit on a flat step'), 'ZeroOutput');
  await refuse(w, watch, () => w.send([sellIx(w, u, h, n)], [u], `sell ${n} raw units inside the step`), 'ZeroOutput');
  // graduate; in the pool a 1-raw-unit sell is worth less than a lamport (X < Y + 1)
  const g = await trader(w, h, 200n);
  await w.buy(g, h, 100n * LAMPORTS, { label: 'graduating buy' });
  assert.equal(view(w, h).phase, 1);
  await refuse(w, watch, () => w.send([sellIx(w, g, h, 1n)], [g], 'pool sell of 1 raw unit'), 'ZeroOutput');
  // a whale pushes the pool price above 97,500 lamports per raw unit (about 1.4 million SOL in; set out of band)
  const big = await whale(w, 1_500_000_000_000_000n);
  await w.buy(big, h, 1_400_000_000_000_000n, { label: 'whale buy of 1.4 million SOL' });
  const c = view(w, h);
  assert.ok(c.poolSol > 97_500n * c.poolTokens, `price ${c.poolSol / c.poolTokens} lamports per raw unit`);
  assert.throws(() => quoteBuy(w, h, S.MIN_TRADE_LAMPORTS), (e) => e.code === 'ZeroOutput');
  // the minimum buy would deliver 0 coins: refused, the buyer keeps every lamport
  await refuse(w, watch, () => w.send([buyIx(w, u, h, S.MIN_TRADE_LAMPORTS)], [u], 'minimum buy for 0 coins'), 'ZeroOutput');
  // the smallest buy that delivers a coin passes; one lamport less is refused
  let lo = S.MIN_TRADE_LAMPORTS; let hi = 10n * LAMPORTS;
  const delivers = (x) => { try { return quoteBuy(w, h, x).tokensOut >= 1n; } catch { return false; } };
  while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (delivers(mid)) hi = mid; else lo = mid; }
  await refuse(w, watch, () => w.send([buyIx(w, u, h, hi - 1n)], [u], `buy ${hi - 1n} for 0 coins`), 'ZeroOutput');
  const r = await w.buy(u, h, hi, { label: `buy ${hi}: the first that delivers a raw unit` });
  assert.equal(r.q.tokensOut, 1n);
  // the extreme state divides by nothing: trades both ways still work, and the whale can leave
  await w.sell(big, h, w.balanceOf(big, h.mint), { label: 'the whale sells everything back' });
  await w.finish();
});
function quoteSellOrZero(w, h, n) { try { return quoteSell(w, h, n).solOut; } catch (e) { if (e.code === 'ZeroOutput') return 0n; throw e; } }

// ---------------------------------------------------------------- X14, X15
test('X14, X15 overflow and division by zero: u64::MAX in every trade argument and every config field, and every zero denominator, are refused with their errors and never panic', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1610n, symbol: 'OVER' });
  const u = await trader(w, h, 300n);
  const b = await w.buy(u, h, 10n * LAMPORTS);
  const watch = [...coinAccounts(h), u.address, S.associatedTokenAddress(u.address, h.mint)];
  // on the curve: an oversized sell is beyond the curve, oversized minimums are slippage
  await refuse(w, watch, () => w.send([sellIx(w, u, h, U64)], [u], 'curve sell u64::MAX'), 'SellExceedsCurve');
  await refuse(w, watch, () => w.send([buyIx(w, u, h, LAMPORTS, U64)], [u], 'buy, min u64::MAX'), 'SlippageExceeded');
  await refuse(w, watch, () => w.send([sellIx(w, u, h, b.q.tokensOut, U64)], [u], 'sell, min u64::MAX'), 'SlippageExceeded');
  // a curve buy of u64::MAX is only charged what completes the curve (a partial fill, I17)
  const want = S.grossFor(T, T.graduationSol - view(w, h).curveSol);
  const l0 = w.lamportsOf(u.address);
  const r = await w.buy(u, h, U64, { label: 'curve buy of u64::MAX' });
  assert.deepEqual([r.q.charged, r.q.partial, r.q.graduates], [want, true, true]);
  assert.equal(l0 - w.lamportsOf(u.address), want, 'charged exactly the completing amount');
  // in the pool: the reserve or the liabilities would leave u64 -> MathOverflow before any lamport moves
  const c = view(w, h);
  const liab = S.liabilities(S.coinState(c));
  for (const [label, g, code] of [['u64::MAX', U64, 'MathOverflow'], ['u64::MAX - pool_sol (liabilities above u64)', U64 - c.poolSol, 'MathOverflow'],
    ['u64::MAX - liabilities - 1 SOL (fits; the wallet cannot pay)', U64 - liab - LAMPORTS, null]]) {
    let expected = code;
    try { quoteBuy(w, h, g); } catch (e) { expected = S.programErrorOf(e); }
    if (expected) await refuse(w, watch, () => w.send([buyIx(w, u, h, g)], [u], `pool buy ${label}`), expected);
    else await refuse(w, watch, () => w.send([buyIx(w, u, h, g)], [u], `pool buy ${label}`), /insufficient lamports|0x1\b/i);
  }
  await refuse(w, watch, () => w.send([sellIx(w, u, h, U64)], [u], 'pool sell u64::MAX'), 'MathOverflow');
  await refuse(w, watch, () => w.send([sellIx(w, u, h, w.balanceOf(u, h.mint) + 1n)], [u], 'pool sell above the balance'), /insufficient funds|0x1\b/i);
  // configs: u64::MAX (u16::MAX for a share) in each field, and the zero denominators of T15
  const want_ = { V1: 'ConfigFeeTotal', V2: 'ConfigFeeShareCap', V3: 'ConfigSupply', V4: 'ConfigCurveBounds', V5: 'ConfigGraduation', V6: 'ConfigAbsorption',
    V7: 'ConfigContinuity', V8: 'ConfigBuybackMev', V9: 'ConfigLaunchFee', V10: 'ConfigDripFarmable', V11: 'ConfigBuybackHorizon' };
  const D = S.DEFAULT_CONFIG;
  const hostile = [];
  for (const k of ['liquidityBps', 'platformBps', 'founderBps', 'holdersBps', 'buybackBps']) hostile.push([`${k} = u16::MAX`, { ...D, [k]: 0xffffn }]);
  for (const k of ['virtualSol', 'virtualTokens', 'curveSupply', 'poolSupply', 'graduationSol', 'launchFeeLamports']) hostile.push([`${k} = u64::MAX`, { ...D, [k]: U64 }]);
  hostile.push(['all shares 0 (t = 0: D - t, x0*t)', { ...D, liquidityBps: 0n, platformBps: 0n, founderBps: 0n, holdersBps: 0n, buybackBps: 0n }]);
  hostile.push(['virtual_sol 0 (x0 + q)', { ...D, virtualSol: 0n }]);
  hostile.push(['virtual_tokens = curve_supply (y0 - s at s = S)', { ...D, virtualTokens: D.curveSupply }]);
  hostile.push(['virtual_tokens below curve_supply', { ...D, virtualTokens: D.curveSupply - 1n }]);
  hostile.push(['curve_supply 0', { ...D, curveSupply: 0n }]);
  hostile.push(['pool_supply 0 (Y + a, an empty pool)', { ...D, poolSupply: 0n }]);
  hostile.push(['graduation_sol 0', { ...D, graduationSol: 0n }]);
  for (const [label, p] of hostile) {
    const rule = S.configRule(p);
    assert.ok(rule, `${label}: the model refuses it`);
    await refuse(w, [w.P.launchpad(), w.P.config(1)], () => w.addConfig(p), want_[rule]);
  }
  assert.equal(w.launchpad().nextConfigId, 1);
  await w.finish();
});

// ---------------------------------------------------------------- X16
test('X16 partial-fill edges: remainders 1 to 8, 39 to 41, around the minimum buy (97,499 to 97,501) and large, every buy size, and a completing buy from the middle of a flat step', async () => {
  const w = await World.create();
  const filler = await w.signer(3_000n);
  const rems = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 39n, 40n, 41n, 97_499n, 97_500n, 97_501n, 1_000_000_007n];
  let city = 1620n;
  for (const rem of rems) {
    const h = await w.launchCoin({ cityId: city, symbol: `REM${city}` });
    city++;
    // bring the curve to exactly R - rem (every lamport value is some f(s) on the default curve: the price stays below 1 lamport per raw unit)
    await w.buy(filler, h, S.grossFor(T, T.graduationSol - rem), { label: `to R - ${rem}` });
    const c0 = view(w, h);
    assert.equal(c0.curveSol, T.graduationSol - rem);
    const buyer = await trader(w, h, 10n);
    // every buy size, simulated from this state: the program's state after each equals the model's
    const sizes = [S.MIN_TRADE_LAMPORTS, S.grossFor(T, rem), S.grossFor(T, rem) - 1n, S.grossFor(T, rem) + 1n, 5n * LAMPORTS, U64];
    for (const g of sizes) {
      let q; try { q = quoteBuy(w, h, g); } catch (e) { q = e; }
      const sim = await w.simulate([buyIx(w, buyer, h, g)], [buyer]);
      if (q instanceof Error) {
        assert.equal(sim.ok, false, `rem ${rem}, sol_in ${g}: refused like the model (${q.code})`);
        assert.ok(new RegExp(S.programErrorOf(q)).test(sim.error) || S.programErrorOf(q) === 'TradeTooSmall', sim.error);
        continue;
      }
      assert.equal(sim.ok, true, `rem ${rem}, sol_in ${g}: ${sim.error}`);
      assert.deepEqual(S.coinState(sim.coin(h.coin)), q.newState, `rem ${rem}, sol_in ${g}: state equals the model`);
      if (q.graduates) {
        // I17 / Lemma G: only the least charge netting exactly rem is taken, and exactly S - s coins are delivered
        assert.equal(q.net, rem);
        assert.equal(q.tokensOut, T.curveSupply - c0.tokensSold);
        if (q.partial) assert.equal(q.charged, ((rem - 1n) * S.BPS) / (S.BPS - T.totalFeeBps) + 1n);
        else assert.equal(q.charged, g, 'not partial only when the offered net is exactly the remainder (NOTES 12)');
        assert.ok(q.charged <= g);
      } else assert.ok(q.net < rem && q.charged === g);
    }
    // send the minimum buy for real when it completes, else the exact completing size
    const g = S.grossFor(T, rem) <= S.MIN_TRADE_LAMPORTS ? S.MIN_TRADE_LAMPORTS : S.grossFor(T, rem);
    const l0 = w.lamportsOf(buyer.address);
    const r = await w.buy(buyer, h, g, { label: `completing buy at rem ${rem}` });
    assert.equal(r.q.graduates, true);
    assert.equal(l0 - w.lamportsOf(buyer.address), r.q.charged, 'the buyer paid exactly the charge');
    if (rem === 1n) assert.deepEqual([r.q.charged, r.q.split.fee, r.q.tokensOut], [1n, 0n, 1n], 'rem = 1: one lamport, no fee, the last raw unit');
    if (rem === 97_499n) assert.deepEqual([r.q.charged, r.q.partial], [99_998n, true]);
    if (rem === 97_500n) assert.deepEqual([r.q.charged, r.q.partial, r.q.split.fee], [100_000n, false, 2_500n]);
  }
  // the last step from its middle: a sell lands mid-step (it releases a lamport), and the completing buy delivers exactly S - s from there
  const h = await w.launchCoin({ cityId: city, symbol: 'MIDSTEP' });
  await w.buy(filler, h, S.grossFor(T, T.graduationSol - 10n), { label: 'to R - 10' });
  let k = 1n; while (quoteSellOrZero(w, h, k) === 0n) k += 997n;
  await w.sell(filler, h, k, { label: `sell ${k} raw units: into the middle of a lower step` });
  const c = view(w, h);
  assert.ok(S.curveValue(T, c.tokensSold + 1n) === c.curveSol, 'the curve now sits inside a flat step, not on its top');
  const buyer = await trader(w, h, 10n);
  const r = await w.buy(buyer, h, S.MIN_TRADE_LAMPORTS, { label: 'completing buy from mid-step' });
  assert.deepEqual([r.q.graduates, r.q.tokensOut, r.q.net], [true, T.curveSupply - c.tokensSold, T.graduationSol - c.curveSol]);
  await w.finish();
});

// ---------------------------------------------------------------- X17, X57
test('X17, X57 a victim forced near completion and stale quotes: a strict minimum refuses (the victim pays nothing); without one the victim is charged only for the coins delivered', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1640n, symbol: 'VICT' });
  const whaleS = await w.signer(500n); const attacker = await trader(w, h, 100n); const victim = await trader(w, h, 100n);
  await w.buy(whaleS, h, S.grossFor(T, 84n * LAMPORTS), { label: 'curve to 84 SOL' });
  const vAta = S.associatedTokenAddress(victim.address, h.mint);
  const watch = [...coinAccounts(h), victim.address, vAta];
  // the victim quotes 0.5 SOL on the curve and signs with that minimum
  const quoted = quoteBuy(w, h, LAMPORTS / 2n);
  assert.equal(quoted.graduates, false);
  // the attacker front-runs: the victim's 0.5 SOL would now complete the curve with fewer coins
  await w.buy(attacker, h, 700_000_000n, { label: 'attacker front-runs' });
  const now = quoteBuy(w, h, LAMPORTS / 2n);
  assert.ok(now.partial && now.tokensOut < quoted.tokensOut);
  const v0 = w.lamportsOf(victim.address);
  await refuse(w, watch, () => w.send([buyIx(w, victim, h, LAMPORTS / 2n, quoted.tokensOut)], [victim], 'victim with the stale minimum'), 'SlippageExceeded');
  assert.equal(w.lamportsOf(victim.address), v0, 'the victim paid nothing (not even the fee: the world pays it)');
  // with a 1% tolerance it is still refused (the shortfall is larger); with no minimum it is a partial fill charged gross_for(c) only
  await refuse(w, watch, () => w.send([buyIx(w, victim, h, LAMPORTS / 2n, S.withSlippage(quoted.tokensOut, 100n))], [victim], 'victim with 1% slippage'), 'SlippageExceeded');
  const rem = T.graduationSol - view(w, h).curveSol;
  const sold = view(w, h).tokensSold;
  const r = await w.buy(victim, h, LAMPORTS / 2n, { label: 'victim without a minimum: partial fill' });
  assert.deepEqual([r.q.partial, r.q.graduates, r.q.net, r.q.tokensOut], [true, true, rem, T.curveSupply - sold]);
  assert.equal(r.q.charged, ((rem - 1n) * S.BPS) / (S.BPS - T.totalFeeBps) + 1n, 'charged = gross_for(c)');
  assert.equal(v0 - w.lamportsOf(victim.address), r.q.charged, 'the rest never left his wallet');
  // stale quotes in the pool, both ways (X57); and across graduation on a second coin
  const sQuote = quoteSell(w, h, w.balanceOf(victim, h.mint) / 2n);
  await w.sell(attacker, h, w.balanceOf(attacker, h.mint), { label: 'attacker dumps first' });
  await refuse(w, watch, () => w.send([sellIx(w, victim, h, w.balanceOf(victim, h.mint) / 2n, sQuote.solOut)], [victim], 'stale pool sell'), 'SlippageExceeded');
  const bQuote = quoteBuy(w, h, 2n * LAMPORTS);
  await w.buy(attacker, h, 10n * LAMPORTS, { label: 'attacker buys first' });
  await refuse(w, watch, () => w.send([buyIx(w, victim, h, 2n * LAMPORTS, bQuote.tokensOut)], [victim], 'stale pool buy'), 'SlippageExceeded');
  // within tolerance a small move passes
  const q2 = quoteBuy(w, h, LAMPORTS);
  await w.buy(attacker, h, 1_000_000n, { label: 'a tiny trade in between' });
  await w.buy(victim, h, LAMPORTS, { min: S.withSlippage(q2.tokensOut, 100n), label: 'victim within 1%' });
  const h2 = await w.launchCoin({ cityId: 1641n, symbol: 'VICT2' });
  await w.buy(whaleS, h2, S.grossFor(T, 84n * LAMPORTS), { label: 'second curve to 84 SOL' });
  const v2 = await trader(w, h2, 100n);
  const q3 = quoteBuy(w, h2, LAMPORTS / 2n);
  await w.buy(attacker, h2, 100n * LAMPORTS, { label: 'attacker graduates the coin first' });
  await refuse(w, [...coinAccounts(h2), v2.address], () => w.send([buyIx(w, v2, h2, LAMPORTS / 2n, q3.tokensOut)], [v2], 'victim\'s curve quote executed in the pool'), 'SlippageExceeded');
  await w.finish();
});

// ---------------------------------------------------------------- X18, X40
test('X18, X40 oversell and re-selling burned coins: nobody can sell more than the curve sold; burned coins (buyback or holder burns) can never be sold back', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1650n, symbol: 'OSELL' });
  const u = await trader(w, h, 100n);
  await w.buy(u, h, 20n * LAMPORTS);
  w.warpSlots(150n);
  await w.buyback(h, { label: 'buyback burns coins from the vault' });
  const c = view(w, h);
  assert.ok(c.tokensBurned > 0n);
  const holderTotal = w.balanceOf(u, h.mint);
  assert.equal(holderTotal, c.tokensSold - c.tokensBurned, 'holders hold exactly the coins sold minus the burned ones');
  assert.equal(mintInfo(w.accountInfo(h.mint)).supply, holderTotal + w.tokenBalance(h.vault), 'supply = holders + vault');
  const watch = [...coinAccounts(h), u.address];
  await refuse(w, watch, () => w.send([sellIx(w, u, h, c.tokensSold + 1n)], [u], 'sell more than the curve sold'), 'SellExceedsCurve');
  await refuse(w, watch, () => w.send([sellIx(w, u, h, c.tokensSold)], [u], 'sell the burned coins too'), /insufficient funds|0x1\b/i);
  // the holder sells everything he has: the curve returns to the burned coins, whose SOL stays in the reserve
  await w.sell(u, h, holderTotal, { label: 'sell all' });
  const c2 = view(w, h);
  assert.deepEqual([c2.tokensSold, c2.curveSol], [c.tokensBurned, S.curveValue(T, c.tokensBurned)]);
  assert.ok(c2.curveSol > 0n, 'the buyback\'s SOL backs coins that no longer exist');
  await refuse(w, watch, () => w.send([sellIx(w, u, h, 1n)], [u], 'sell with nothing left'), /insufficient funds|0x1\b|ZeroOutput/i);
  // X40b: a holder burns part of his coins; what he burned can never be sold
  const v = await trader(w, h, 50n);
  const b = await w.buy(v, h, 5n * LAMPORTS);
  const burnIx = { programAddress: S.ADDRESSES.token, accounts: [{ address: S.associatedTokenAddress(v.address, h.mint), role: S.Role.W }, { address: h.mint, role: S.Role.W }, { address: v.address, role: S.Role.RS }],
    data: new Uint8Array([8, ...Buffer.from(new BigUint64Array([b.q.tokensOut / 2n]).buffer)]) };
  await w.send([burnIx], [v], 'holder burns half', { holderBurn: true });
  await refuse(w, [...watch, v.address], () => w.send([sellIx(w, v, h, b.q.tokensOut)], [v], 'sell the burned half too'), /insufficient funds|0x1\b/i);
  await w.sell(v, h, b.q.tokensOut - b.q.tokensOut / 2n, { label: 'sell what is left' });
  await w.finish();
});

// ---------------------------------------------------------------- X19, X20, X21, X22
test('X19 to X22: graduation arbitrage loses, pre-created accounts cannot grief graduation, graduation happens once, and a failed graduating transaction leaves no half state', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1660n, symbol: 'POP' });
  const a = await w.signer(500n); const attacker = await trader(w, h, 300n);
  await w.buy(a, h, S.grossFor(T, 80n * LAMPORTS), { label: 'curve to 80 SOL' });
  // X20: everything an outsider can create around the coin before graduation
  const xfer = (from, to, n) => ({ programAddress: S.ADDRESSES.system, accounts: [{ address: from, role: S.Role.WS }, { address: to, role: S.Role.W }], data: new Uint8Array([2, 0, 0, 0, ...Buffer.from(new BigUint64Array([n]).buffer)]) });
  await w.send([xfer(attacker.address, h.coin, 123_456n)], [attacker], 'lamports to the Coin before graduation', { lamportDonation: { coin: h.coin, amount: 123_456n } });
  await w.send([S.createAssociatedTokenAccountIdempotent({ payer: attacker.address, owner: h.coin, mint: h.mint }),
    S.createAssociatedTokenAccountIdempotent({ payer: attacker.address, owner: h.coin, mint: S.ADDRESSES.nativeMint })], [attacker], 'the Coin PDA\'s token accounts, pre-created');
  // X22: a graduating buy inside a transaction that then fails is undone entirely
  const g = await trader(w, h, 200n);
  const before = fingerprint(w, [...coinAccounts(h), g.address]);
  await expectFail(() => w.send([buyIx(w, g, h, 10n * LAMPORTS), sellIx(w, g, h, U64)], [g], 'graduating buy, then a failing instruction'), 'MathOverflow', 'SellExceedsCurve');
  assert.deepEqual(fingerprint(w, [...coinAccounts(h), g.address]), before, 'no half-graduated state');
  assert.equal(view(w, h).phase, 0);
  // a graduating buy the buyer cannot pay: the system transfer fails, nothing moves
  const poor = await trader(w, h, 1n);
  await refuse(w, [...coinAccounts(h), poor.address], () => w.send([buyIx(w, poor, h, 10n * LAMPORTS)], [poor], 'graduating buy without the lamports'), /insufficient lamports|0x1\b/i);
  // X19: the attacker takes the last curve coins himself and sells them straight into the new pool
  const l0 = w.lamportsOf(attacker.address);
  const b = await w.buy(attacker, h, 10n * LAMPORTS, { label: 'attacker takes the last coins (graduates)' });
  assert.equal(b.q.graduates, true);
  const ev = b.res.events.find((e) => e.name === 'Graduated').data;
  // V7 / 5.10: the pool opens below the curve's last price by at most 1 part per billion, never above
  assert.ok(ev.pool_sol * ev.last_virtual_tokens <= ev.last_virtual_sol * ev.pool_tokens, 'pool price <= last curve price');
  assert.ok((ev.pool_sol * ev.last_virtual_tokens) * 1_000_000_000n >= (ev.last_virtual_sol * ev.pool_tokens) * 999_999_999n, 'within 1e-9');
  assert.equal(view(w, h).poolSol, T.graduationSol, 'the curve-phase liquidity was not dumped into the pool');
  assert.ok(view(w, h).liquidityPending > 0n);
  // X21: a second graduating-size buy in the same transaction as more trades is a pool buy; no second Graduated
  const r2 = await w.send([buyIx(w, a, h, 50n * LAMPORTS), buyIx(w, a, h, 50n * LAMPORTS)], [a], 'two large buys after graduation');
  assert.equal(r2.events.filter((e) => e.name === 'Graduated').length, 0);
  assert.equal(view(w, h).phase, 1);
  await w.sell(a, h, w.balanceOf(a, h.mint), { label: 'a sells his pool coins back' });
  const s = await w.sell(attacker, h, b.q.tokensOut, { label: 'attacker sells into the pool' });
  const back = w.lamportsOf(attacker.address) - (l0 - b.q.charged);
  assert.equal(back, s.q.solOut);
  assert.ok(s.q.solOut < b.q.charged, 'graduation arbitrage loses');
  const ratio = Number(s.q.solOut) / Number(b.q.charged);
  assert.ok(ratio < 0.951, `back ${ratio}: less than the two fees alone would leave`);
  // a buyback after graduation works on the pool and never touches the curve
  w.warpSlots(150n);
  await w.buyback(h, { label: 'pool buyback' });
  assert.deepEqual([view(w, h).phase, view(w, h).tokensSold, view(w, h).curveSol], [1, T.curveSupply, T.graduationSol]);
  await w.finish();
});

// ---------------------------------------------------------------- X41, X42
test('X41, X42 compute stays flat whatever the state or extra accounts; a coin hammered by many trades never touches another coin or the Launchpad', async () => {
  const w = await World.create();
  const hot = await w.launchCoin({ cityId: 1670n, symbol: 'HOT' });
  const calm = await w.launchCoin({ cityId: 1671n, symbol: 'CALM' });
  const traders = [await trader(w, hot, 2_000n), await trader(w, hot, 2_000n), await trader(w, hot, 2_000n)];
  const c0 = await trader(w, calm, 100n);
  const cu = { buy: [], sell: [] };
  const record = (r, name) => { for (const x of r.ixCu.filter((y) => y.name === name)) cu[name].push(x.cu); };
  const lp0 = w.accountInfo(w.P.launchpad()).data;
  const calmTrades = [];
  // hammer: three trades of the hot coin per transaction, the calm coin's own trade in between
  for (let k = 0; k < 8; k++) {
    const ixs = traders.map((t, i) => buyIx(w, t, hot, BigInt(1 + k + i) * 300_000_000n));
    record(await w.send(ixs, traders, `hammer ${k}`), 'buy');
    if (k % 2 === 0) { const r = await w.buy(c0, calm, 50_000_000n, { label: `calm buy ${k}` }); record(r.res, 'buy'); calmTrades.push(r.q); }
  }
  for (const t of traders) { const r = await w.sell(t, hot, w.balanceOf(t, hot.mint) / 3n, { label: 'hot sell' }); record(r.res, 'sell'); }
  // the calm coin's state is exactly its own trades replayed from launch
  let s = S.stateAtLaunch(view(w, calm).launchSlot);
  for (const q of calmTrades) s = S.quoteBuy(T, s, q.charged).newState;
  assert.deepEqual(st(w, calm), s, 'the calm coin saw only its own trades');
  assert.ok(w.accountInfo(w.P.launchpad()).data.equals(lp0), 'trades never write the Launchpad');
  // the same and a calm trade in one transaction with another coin's trades
  const r = await w.send([buyIx(w, traders[0], hot, LAMPORTS), buyIx(w, c0, calm, LAMPORTS), sellIx(w, traders[1], hot, 1_000_000_000n)], [traders[0], c0, traders[1]], 'mixed transaction');
  assert.equal(r.events.filter((e) => e.name === 'Trade').length, 3);
  // graduate the hot coin, then trade in a pool with huge reserves; with 10 extra accounts appended (no remaining accounts are read)
  record((await w.buy(traders[0], hot, 100n * LAMPORTS, { label: 'graduate hot' })).res, 'buy');
  for (const t of traders) record((await w.buy(t, hot, 500n * LAMPORTS, { label: 'big pool buy' })).res, 'buy');
  const extra = await Promise.all(Array.from({ length: 10 }, async () => ({ address: (await generateKeyPairSigner()).address, role: S.Role.R })));
  const withExtra = buyIx(w, traders[2], hot, LAMPORTS);
  const q = quoteBuy(w, hot, LAMPORTS);
  const re = await w.send([{ ...withExtra, accounts: [...withExtra.accounts, ...extra] }], [traders[2]], 'pool buy with 10 extra accounts');
  record(re, 'buy');
  assert.equal(re.events.find((e) => e.name === 'Trade').data.token_amount, q.tokensOut, 'extra accounts change nothing');
  const sx = sellIx(w, traders[2], hot, 1_000_000_000n);
  record(await w.send([{ ...sx, accounts: [...sx.accounts, ...extra] }], [traders[2]], 'pool sell with 10 extra accounts'), 'sell');
  for (const [name, list] of Object.entries(cu)) {
    const max = Math.max(...list); const min = Math.min(...list);
    assert.ok(max <= 48_000, `${name}: ${max} CU within the 11.1 test budget`);
    assert.ok(max - min <= 6_000, `${name}: compute is flat across states (${min} to ${max} CU, a graduating buy included)`);
  }
  await w.finish();
});

// ---------------------------------------------------------------- X16 (every remainder), X21 (one transaction)
test('X16 every remainder from 1 to 300 lamports, on the top of its step and from inside it: every buy size is charged only the least amount netting the remainder, and delivers exactly S - s', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1690n, symbol: 'EVERY' });
  const holder = await w.signer(500n);
  // R - 1 (the last flat step below S); then down one lamport at a time with 1-lamport sells (no minimum on sells, O5)
  await w.buy(holder, h, S.grossFor(T, T.graduationSol - 1n), { label: 'to R - 1' });
  const buyer = await trader(w, h, 10n);
  const probe = w.probeEach; w.probeEach = false; // 300 steps: the liveness probe runs at the end
  const checkAt = async (rem, where) => {
    const c0 = view(w, h);
    assert.equal(c0.curveSol, T.graduationSol - rem);
    for (const g of [S.MIN_TRADE_LAMPORTS, S.grossFor(T, rem), U64]) {
      if (g < S.MIN_TRADE_LAMPORTS) continue;
      const q = quoteBuy(w, h, g);
      const sim = await w.simulate([buyIx(w, buyer, h, g)], [buyer]);
      assert.equal(sim.ok, true, `rem ${rem} (${where}), sol_in ${g}: ${sim.error}`);
      assert.deepEqual(S.coinState(sim.coin(h.coin)), q.newState, `rem ${rem} (${where}), sol_in ${g}`);
      assert.deepEqual([q.graduates, q.net, q.tokensOut], [true, rem, T.curveSupply - c0.tokensSold], `rem ${rem} (${where}): completes with net exactly rem and S - s coins`);
      assert.equal(q.charged, q.partial ? ((rem - 1n) * S.BPS) / (S.BPS - T.totalFeeBps) + 1n : g, 'Lemma G');
    }
  };
  for (let rem = 1n; rem <= 300n; rem++) {
    if (rem > 1n) {
      // sell down to the top of the step of R - rem (gross 1 lamport)
      const s = view(w, h).tokensSold;
      const top = S.tokensFor(T, T.graduationSol - rem);
      await w.sell(holder, h, s - top, { label: `to R - ${rem}` });
    }
    await checkAt(rem, 'top of its step');
    if (rem % 25n === 0n) {
      // every 25th remainder also from inside a step: sell to the middle of the next step down (a sell inside one step
      // releases nothing and is refused, ZeroOutput), check rem + 1 from there, then continue the walk from rem + 2
      const s = view(w, h).tokensSold;
      const nextTop = S.tokensFor(T, T.graduationSol - rem - 1n);
      const mid = nextTop - 7n; // f(mid) = R - rem - 1 as long as the step is wider than 7 raw units (about 2,433 here)
      assert.equal(S.curveValue(T, mid), T.graduationSol - rem - 1n);
      await w.sell(holder, h, s - mid, { label: `to the middle of the step of R - ${rem + 1n}` });
      await checkAt(rem + 1n, 'inside its step');
      rem++;
      const s2 = view(w, h).tokensSold;
      const top2 = S.tokensFor(T, T.graduationSol - rem - 1n);
      await w.sell(holder, h, s2 - top2, { label: `to R - ${rem + 1n}` });
      rem++;
      await checkAt(rem, 'top of its step');
    }
  }
  w.probeEach = probe;
  // send one for real: the minimum buy at R - 300 or so is a partial fill charged exactly gross_for(rem)
  const rem = T.graduationSol - view(w, h).curveSol;
  const l0 = w.lamportsOf(buyer.address);
  const r = await w.buy(buyer, h, S.MIN_TRADE_LAMPORTS, { label: `completing buy at rem ${rem}` });
  assert.deepEqual([r.q.partial, r.q.charged], [true, S.grossFor(T, rem)]);
  assert.equal(l0 - w.lamportsOf(buyer.address), r.q.charged);
  await w.finish();
});

test('X21 two graduating-size buys in one transaction: the first graduates, the second is a pool buy, one Graduated event; a buyback in the same transaction runs on the pool', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1695n, symbol: 'ONCE' });
  const a = await trader(w, h, 500n); const b = await trader(w, h, 500n);
  w.warpSlots(150n);
  await w.buy(a, h, 10n * LAMPORTS, { label: 'fees for a buyback' });
  const r = await w.send([buyIx(w, a, h, 100n * LAMPORTS), buyIx(w, b, h, 100n * LAMPORTS), w.ix.buybackBurn({ coin: h.coin })], [a, b], 'graduate, buy again, buyback: one transaction');
  const trades = r.events.filter((e) => e.name === 'Trade');
  assert.deepEqual(trades.map((e) => [e.data.phase, e.data.graduated]), [[0, true], [1, false]]);
  assert.equal(r.events.filter((e) => e.name === 'Graduated').length, 1);
  const bb = r.events.find((e) => e.name === 'BuybackBurned');
  assert.ok(bb && bb.data.phase === 1, 'the run in the same transaction ran on the pool');
  assert.deepEqual([view(w, h).tokensSold, view(w, h).curveSol], [T.curveSupply, T.graduationSol]);
  await w.finish();
});
