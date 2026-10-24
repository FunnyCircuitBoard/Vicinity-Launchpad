// I18 no free value on chain (VICINITY-CURVE-DESIGN.md 9, I18; the math crate's
// tests/no_free_value.rs states the properties and why the literal wording, coins
// valued at the final spot price, is not one). Random sequences in litesvm with
// the invariant checker after every transaction:
//   * one address alone: on a random config, from a reachable state made by
//     other traders (curve or pool, set-aside liquidity waiting), an address
//     that comes with SOL only buys (graduating buys and partial fills
//     included) and sells at random, then sells what it holds; its lamports,
//     wallet and token account together, never end above where they started;
//   * all addresses together: four addresses (one the founder) trade a fresh
//     coin at random, run buybacks, collect the founder's fees, withdraw and
//     forward, pass coins between them and receive SOL gifts from outside;
//     after each sells everything, their lamports together never exceed what
//     they started with plus the gifts they received.
// Fees are paid by the World's payer, so every lamport counted moved through
// the program or a declared gift. VCURVE_I18_RUNS sets the number of
// sequences (CI: 6 lone, 4 together).
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, S, LAMPORTS, TxError } from './helpers.mjs';
import { makeRng, systemTransfer, tokenTransfer } from './fuzz.mjs';

const RUNS = Number(process.env.VCURVE_I18_RUNS ?? 0);
const lamportsOf = (w, u, mint) => w.lamportsOf(u.address) + w.lamportsOf(w.ata(u.address, mint));
async function attempt(fn) { try { return await fn(); } catch (e) { if (e instanceof TxError || e instanceof S.MathError) return null; throw e; } }

/** A random valid config: #0, random shares on its curve, or a small curve found by 5.9's search. */
async function randomConfig(w, r) {
  const k = r.int(3);
  if (k === 0) return 0;
  for (let i = 0; i < 40; i++) {
    let p = { ...S.DEFAULT_CONFIG, liquidityBps: BigInt(r.int(121)), platformBps: BigInt(r.int(121)), founderBps: BigInt(r.int(101)), holdersBps: BigInt(r.int(121)), buybackBps: BigInt(r.int(61)) };
    if (k === 2) {
      const R = 1_000_000_000n + r.below(20_000_000_000n);
      const P = 100_000_000_000_000n + r.below(200_000_000_000_000n);
      const Sx = S.COIN_SUPPLY - P;
      try { const [x0, y0] = S.deriveCurve(Sx, P, R, 64n); p = { ...p, virtualSol: x0, virtualTokens: y0, curveSupply: Sx, poolSupply: P, graduationSol: R }; } catch { continue; }
    }
    if (S.configRule(p) === null) return w.addConfig(p);
  }
  return 0;
}

test('I18 on chain, one address alone: from reachable states, buying, selling and graduating at random never ends with more than it came with', async () => {
  const runs = RUNS || 6;
  let worst = -(10n ** 30n); let seqs = 0; let trades = 0;
  for (let run = 0; run < runs; run++) {
    const r = makeRng(1_000 + run);
    const w = await World.create();
    w.probeEach = false;
    const configId = await randomConfig(w, r);
    const h = await w.launchCoin({ cityId: 600n + BigInt(run), symbol: `NF${run}`, configId });
    const terms = S.coinTerms(w.coinView(h));
    // other traders make a reachable state: on the curve, near its end, or in the pool with liquidity set aside
    const others = [await w.signer(1n), await w.signer(1n)];
    for (const o of others) w.setRaw(o.address, Buffer.alloc(0), S.ADDRESSES.system, 1_000_000n * LAMPORTS);
    const target = r.int(3);
    for (let k = 0; k < 6 + r.int(10); k++) {
      const o = r.pick(others);
      const c = w.coinView(h);
      if (c.phase === 0 && target < 2 && r.chance(0.7)) {
        const g = S.maxQuoteIn(terms, S.coinState(c));
        await attempt(() => w.buy(o, h, target === 0 ? g / 8n + S.MIN_TRADE_LAMPORTS : g - g / 50n));
      } else if (c.phase === 0 && target === 2 && r.chance(0.3)) await attempt(() => w.buy(o, h, S.maxQuoteIn(terms, S.coinState(c))));
      else if (r.chance(0.6)) await attempt(() => w.buy(o, h, r.log(6, Math.log10(Number(terms.graduationSol)) - 1)));
      else { const bal = w.balanceOf(o, h.mint); if (bal > 0n) await attempt(() => w.sell(o, h, (bal * BigInt(1 + r.int(900))) / 1000n)); }
    }
    // the address alone
    const me = await w.signer(1n);
    const start = 100_000n * LAMPORTS;
    w.setRaw(me.address, Buffer.alloc(0), S.ADDRESSES.system, start);
    for (let k = 0; k < 10 + r.int(30); k++) {
      const c = w.coinView(h);
      const bal = w.balanceOf(me, h.mint);
      const x = r.next();
      let done = null;
      if (x < 0.5 || bal === 0n) {
        const g = c.phase === 0 && r.chance(0.1) ? S.maxQuoteIn(terms, S.coinState(c)) : r.log(5, Math.log10(Number(terms.graduationSol)) - 0.8);
        done = await attempt(() => w.buy(me, h, g, { label: `alone: buy ${g}` }));
      } else {
        done = await attempt(() => w.sell(me, h, r.chance(0.1) ? 1n + r.below(5_000n) : (bal * BigInt(1 + r.int(1000))) / 1000n, { label: 'alone: sell' }));
      }
      if (done) trades++;
    }
    const left = w.balanceOf(me, h.mint);
    if (left > 0n) { const c = w.coinView(h); let q = null; try { q = S.quoteSell(S.coinTerms(c), S.coinState(c), left); } catch { q = null; } if (q) await w.sell(me, h, left, { label: 'alone: sell everything' }); }
    const gain = lamportsOf(w, me, h.mint) - start;
    assert.ok(gain <= 0n, `run ${run}: the lone address gained ${gain} lamports`);
    if (gain > worst) worst = gain;
    seqs++;
    await w.finish();
  }
  console.log(`I18 alone: ${seqs} sequences, ${trades} trades, best result ${worst} lamports (never above 0)`);
});

test('I18 on chain, all addresses together: random trades, buybacks, payouts, transfers and gifts from launch never leave them with more than they put in plus the gifts', async () => {
  const runs = RUNS || 4;
  let seqs = 0; let txs = 0;
  for (let run = 0; run < runs; run++) {
    const r = makeRng(2_000 + run);
    const w = await World.create();
    w.probeEach = false;
    const configId = await randomConfig(w, r);
    const founder = await w.signer(1n);
    const members = [founder, await w.signer(1n), await w.signer(1n), await w.signer(1n)];
    const each = 50_000n * LAMPORTS;
    for (const m of members) w.setRaw(m.address, Buffer.alloc(0), S.ADDRESSES.system, each);
    const h = await w.launchCoin({ cityId: 700n + BigInt(run), symbol: `NT${run}`, configId, founder });
    // the launch's rent and fee are the founder's cost (and Metaplex's), as on mainnet: counted from after the launch
    await w.initRewardsCity(h);
    const terms = S.coinTerms(w.coinView(h));
    const startTotal = members.reduce((s, m) => s + lamportsOf(w, m, h.mint), 0n);
    const outsider = await w.signer(1_000n);
    let gifts = 0n;
    for (let k = 0; k < 40 + r.int(60); k++) {
      const m = r.pick(members);
      const c = w.coinView(h);
      const x = r.next();
      if (x < 0.4) {
        const g = c.phase === 0 && r.chance(0.08) ? S.maxQuoteIn(terms, S.coinState(c)) : r.log(5, Math.log10(Number(terms.graduationSol)) - 0.8);
        await attempt(() => w.buy(m, h, g));
      } else if (x < 0.7) {
        const bal = w.balanceOf(m, h.mint);
        if (bal > 0n) await attempt(() => w.sell(m, h, (bal * BigInt(1 + r.int(1000))) / 1000n));
      } else if (x < 0.8) { w.warpSlots(150n + BigInt(r.int(200))); await w.buyback(h); }
      else if (x < 0.85) await w.claim(h, founder);
      else if (x < 0.88) await w.withdraw(h);
      else if (x < 0.91) await w.forward(h);
      else if (x < 0.96) {
        // coins passed between members
        const to = r.pick(members); const bal = w.balanceOf(m, h.mint);
        if (bal > 0n && to !== m) {
          await w.send([S.createAssociatedTokenAccountIdempotent({ payer: m.address, owner: to.address, mint: h.mint }), tokenTransfer(w.ata(m.address, h.mint), h.mint, w.ata(to.address, h.mint), m.address, bal / 2n + 1n)], [m], 'coins between members');
          w.addHolder(h.mint, to);
        }
      } else {
        // a gift of SOL from outside: received, so subtracted
        const g = 1n + r.below(LAMPORTS);
        await w.send([systemTransfer(outsider.address, m.address, g)], [outsider], 'a gift from outside');
        gifts += g;
      }
      txs++;
    }
    for (const m of members) {
      const bal = w.balanceOf(m, h.mint);
      if (bal === 0n) continue;
      const c = w.coinView(h); let ok = true;
      try { S.quoteSell(S.coinTerms(c), S.coinState(c), bal); } catch { ok = false; }
      if (ok) await w.sell(m, h, bal, { label: 'everyone sells everything' });
    }
    const endTotal = members.reduce((s, m) => s + lamportsOf(w, m, h.mint), 0n);
    assert.ok(endTotal <= startTotal + gifts, `run ${run}: together they gained ${endTotal - startTotal - gifts} lamports net of gifts`);
    seqs++;
    await w.finish();
  }
  console.log(`I18 together: ${seqs} sequences, ${txs} operations, never a gain net of gifts`);
});
