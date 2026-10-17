// G01 on chain (VICINITY-CURVE-DESIGN.md 12.5): the program replays the golden
// vectors exported by the Rust crate (crates/vicinity-curve-math/reference/
// g01-vectors.json; sdk/curve/g01.test.mjs replays them through the
// JavaScript port). Every coin life of the file is launched on its config at
// its slot, and every operation is sent as the transaction it describes: buys
// and sells by four holders, buyback runs at the recorded slots, withdrawals,
// founder claims and forwards into a real vicinity_rewards vault. Each Trade
// and BuybackBurned event must carry the vector's numbers, each refusal the
// vector's error, and the Coin's 24 state fields must hash to the vector's
// digest after every operation and equal its final state at the end of each
// life. The invariant checker runs after every transaction as everywhere
// (which also compares each event with the JavaScript port), and the I22
// liveness probe at the end of every life. More than 10^4 trades;
// VCURVE_G01_LIVES=n replays only the first n lives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, S, expectFail } from './helpers.mjs';
import { G01_PATH, lifeConfig, parseOp, stateDigest } from '../sdk/curve/g01-vectors.mjs';

const near = (a, b) => assert.equal(a, b);

test('G01: the program, the Rust crate and the JavaScript port agree to the lamport on every trade and buyback of the golden vectors', async () => {
  const v = JSON.parse(readFileSync(G01_PATH, 'utf8'));
  const limit = Number(process.env.VCURVE_G01_LIVES ?? v.lives.length);
  // a fresh World every 8 lives keeps the number of accounts the checker reads after each transaction small
  let w; let holders; let topUp;
  const fresh = async () => {
    w = await World.create();
    w.probeEach = false;
    holders = [];
    for (let i = 0; i < 4; i++) holders.push(await w.signer(1n));
    // the holders' wallets are topped up to 10^8 SOL before each life (the vectors buy up to 1.5 R of 10,000 SOL)
    topUp = () => { for (const u of holders) w.setRaw(u.address, Buffer.alloc(0), S.ADDRESSES.system, 100_000_000_000_000_000n); };
  };
  let txs = 0;
  const stats = { trades: 0, refusals: 0, noops: 0, payouts: 0, graduations: 0, partials: 0, runs: 0, lives: 0 };
  const t0 = Date.now();
  for (const [li, l] of v.lives.slice(0, limit).entries()) {
    if (li % 8 === 0) { if (w) txs += w.txs; await fresh(); }
    const params = lifeConfig(l);
    const isDefault = Object.entries(S.DEFAULT_CONFIG).every(([k, x]) => params[k] === x);
    const configId = isDefault ? 0 : await w.addConfig(params);
    // launch at the life's slot (the digests include last_buyback_slot)
    const c0 = w.svm.getClock(); assert.ok(BigInt(l.launch_slot) >= c0.slot, 'slots only move forward'); c0.slot = BigInt(l.launch_slot); w.svm.setClock(c0);
    topUp();
    const founder = await w.signer(10n);
    const cityId = 7_000_000n + BigInt(li);
    await w.approve({ cityId, founder, configId, symbol: `G${li}`, name: `G01 life ${li}` });
    const h = await w.launch({ cityId, founder });
    await w.initRewardsCity(h);
    const terms = S.coinTerms(w.coinView(h));
    assert.equal(w.coinView(h).launchSlot, BigInt(l.launch_slot));
    for (const [oi, line] of l.ops.entries()) {
      const op = parseOp(line);
      const at = `life ${li} op ${oi} (${line})`;
      const ev = (r, name) => r.events.filter((e) => e.name === name && e.data.city_id === cityId);
      if (op.kind === 'buy' || op.kind === 'sell') {
        const u = holders[op.holder];
        const ix = op.kind === 'buy'
          ? w.buyIxs(u, h, op.solIn, 0n)
          : [w.ix.sell({ user: u.address, coin: h.coin, tokensIn: op.tokensIn, minSolOut: 0n })];
        if (op.error) { await expectFail(() => w.send(ix, [u], at), op.error); stats.refusals++; continue; }
        const r = await w.send(ix, [u], at);
        if (op.kind === 'buy') w.addHolder(h.mint, u);
        const [e] = ev(r, 'Trade');
        const d = e.data;
        assert.deepEqual([d.fee, d.fee_liquidity, d.fee_platform, d.fee_founder, d.fee_holders, d.fee_buyback, d.liquidity_dripped],
          [op.split.fee, op.split.liquidity, op.split.platform, op.split.founder, op.split.holders, op.split.buyback, op.drip], `${at}: shares and drip`);
        if (op.kind === 'buy') {
          assert.deepEqual([d.sol_in, d.sol_amount, d.sol_net, d.token_amount, d.partial, d.graduated], [op.solIn, op.charged, op.net, op.tokensOut, op.partial, op.graduates], `${at}: buy`);
          stats.graduations += op.graduates ? 1 : 0; stats.partials += op.partial ? 1 : 0;
        } else assert.deepEqual([d.token_amount, d.sol_amount, d.sol_net], [op.tokensIn, op.gross, op.solOut], `${at}: sell`);
        stats.trades++;
      } else if (op.kind === 'buyback') {
        const c = w.svm.getClock(); assert.ok(op.slot >= c.slot); c.slot = op.slot; w.svm.setClock(c);
        const r = await w.buyback(h, { label: at });
        const runs = ev(r, 'BuybackBurned');
        if (op.noop) { assert.equal(runs.length, 0, `${at}: no run`); stats.noops++; } else {
          assert.deepEqual([runs[0].data.sol_spent, runs[0].data.tokens_burned, runs[0].data.cap], [op.spent, op.coins, op.cap], `${at}: buyback`);
          stats.trades++; stats.runs++;
        }
      } else {
        if (op.which === 0) await w.withdraw(h, { label: at });
        else if (op.which === 1) await w.claim(h, founder, { label: at });
        else await w.forward(h, { label: at });
        stats.payouts++;
      }
      if (op.digest) near(stateDigest(S.coinState(w.coinView(h))), op.digest, `${at}: the Coin's state digest`);
    }
    assert.deepEqual(S.STATE_KEYS.map((k) => String(S.coinState(w.coinView(h))[k])), l.final, `life ${li}: final state`);
    assert.ok(terms);
    await w.probe(`end of G01 life ${li}`);
    stats.lives++;
  }
  if (limit >= v.lives.length) {
    assert.deepEqual([stats.trades, stats.graduations, stats.partials, stats.runs], [v.trades, v.graduations, v.partial_fills, v.buyback_runs]);
    assert.ok(stats.trades >= 10_000);
  }
  txs += w.txs;
  console.log(`G01 on chain: ${JSON.stringify(stats)}, ${txs} transactions in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
});
