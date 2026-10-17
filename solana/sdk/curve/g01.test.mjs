// G01 (VICINITY-CURVE-DESIGN.md 12.5): the JavaScript port replays the golden
// vectors the Rust crate exports (crates/vicinity-curve-math/reference/
// g01-vectors.json, written by tests/g01_vectors.rs) and must agree on every
// quote, error, fee share, drip, buyback amount and state digest of more than
// 10^4 trades, graduating buys, partial fills, pool trades and buyback runs.
// tests-curve/22-g01-onchain.test.mjs replays the same file on the program.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from './index.mjs';
import { G01_PATH, lifeConfig, parseOp, payState, stateDigest } from './g01-vectors.mjs';

test('G01: the JavaScript port agrees with the Rust crate on every operation of the golden vectors (more than 10^4 trades)', () => {
  const v = JSON.parse(readFileSync(G01_PATH, 'utf8'));
  let trades = 0; let ops = 0; let graduations = 0; let partials = 0; let runs = 0;
  for (const [li, l] of v.lives.entries()) {
    const t = S.termsFromParams(lifeConfig(l));
    assert.equal(S.validateConfig(lifeConfig(l)), true, `life ${li}: config passes V1 to V11`);
    let st = S.stateAtLaunch(BigInt(l.launch_slot));
    for (const [oi, line] of l.ops.entries()) {
      const op = parseOp(line);
      const at = `life ${li} op ${oi} (${line})`;
      ops++;
      if (op.kind === 'buy' || op.kind === 'sell') {
        let q; let e;
        try { q = op.kind === 'buy' ? S.quoteBuy(t, st, op.solIn) : S.quoteSell(t, st, op.tokensIn); } catch (x) { e = x; }
        if (op.error) { assert.ok(e instanceof S.MathError && e.code === op.error, `${at}: expected ${op.error}, got ${e?.message ?? 'success'}`); continue; }
        assert.ok(!e, `${at}: ${e?.message}`);
        const s = q.split;
        assert.deepEqual([s.fee, s.liquidity, s.liquidityFloor, s.platform, s.founder, s.holders, s.buyback, q.drip],
          [op.split.fee, op.split.liquidity, op.split.liquidityFloor, op.split.platform, op.split.founder, op.split.holders, op.split.buyback, op.drip], `${at}: split and drip`);
        if (op.kind === 'buy') {
          assert.deepEqual([q.charged, q.net, q.tokensOut, q.partial, q.graduates], [op.charged, op.net, op.tokensOut, op.partial, op.graduates], `${at}: buy`);
          graduations += q.graduates ? 1 : 0; partials += q.partial ? 1 : 0;
        } else assert.deepEqual([q.gross, q.solOut], [op.gross, op.solOut], `${at}: sell`);
        st = q.newState; trades++;
      } else if (op.kind === 'buyback') {
        const q = S.quoteBuyback(t, st, op.slot);
        if (op.noop) { assert.equal(q, null, `${at}: a no-op`); continue; }
        assert.ok(q, `${at}: the port found nothing to do`);
        assert.deepEqual([q.spent, q.coins, q.cap], [op.spent, op.coins, op.cap], `${at}: buyback`);
        st = q.newState; trades++; runs++;
      } else {
        const [amount, next] = payState(st, op.which);
        assert.equal(amount, op.amount, `${at}: payout amount`);
        st = next;
      }
      assert.equal(stateDigest(st), op.digest, `${at}: state digest`);
    }
    assert.deepEqual(S.STATE_KEYS.map((k) => String(st[k])), l.final, `life ${li}: final state`);
  }
  assert.ok(trades >= 10_000, `${trades} trades`);
  assert.deepEqual([trades, graduations, partials, runs], [v.trades, v.graduations, v.partial_fills, v.buyback_runs]);
  assert.ok(ops > trades);
});
