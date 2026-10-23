// Parity of the BigInt math port (math.mjs) with the Rust math crate: it
// replays the crate's golden vectors (crates/vicinity-curve-math/reference/vectors.json,
// written by reference/generate_vectors.py from the verbatim reference model of
// VICINITY-CURVE-DESIGN.md Appendix A and replayed by tests/differential.rs) and
// requires exact equality of every quote, every error and all 26 state figures
// after every operation; then the worked examples E1 to E10 of 5.14 and the
// margins of 5.13. The parity against the program's real results is in
// tests-curve (every trade and buyback of every litesvm test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as M from './math.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(here, '..', '..', 'crates', 'vicinity-curve-math', 'reference', 'vectors.json');
// Integers in the file reach u128: parse every integer token as BigInt.
const V = JSON.parse(readFileSync(VECTORS, 'utf8'), (k, v, ctx) => (typeof v === 'number' && /^-?\d+$/.test(ctx?.source ?? '') ? BigInt(ctx.source) : v));

const cfg = (c) => ({
  liquidityBps: c.bps[0], platformBps: c.bps[1], founderBps: c.bps[2], holdersBps: c.bps[3], buybackBps: c.bps[4],
  virtualSol: c.x0, virtualTokens: c.y0, curveSupply: c.S, poolSupply: c.P, graduationSol: c.R, launchFeeLamports: c.fee ?? 0n,
});
const splitRow = (s) => [s.fee, s.liquidity, s.liquidityFloor, s.platform, s.founder, s.holders, s.buyback];
const stateRow = (st, vault) => [BigInt(st.phase), ...M.STATE_KEYS.slice(1).map((k) => st[k]), M.liabilities(st), vault];
const errOf = (fn) => { try { fn(); return null; } catch (e) { if (e instanceof M.MathError) return e.code; throw e; } };

test('vector file layout and the state fields', () => {
  assert.equal(V.state_fields.length, 26);
  const snake = (s) => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  assert.deepEqual(V.state_fields.slice(0, 24), M.STATE_KEYS.map(snake));
  assert.deepEqual(V.state_fields.slice(24), ['liabilities', 'vault']);
});

test('lives replay exactly (every quote, error and state figure after every operation)', () => {
  let ops = 0;
  const kinds = new Map();
  V.lives.forEach((life, li) => {
    const p = cfg(life.config);
    assert.equal(M.validateConfig(p), true, `life ${li} config passes V1 to V11`);
    const t = M.termsFromParams(p);
    let st = M.stateAtLaunch(life.launch_slot);
    let vault = t.curveSupply + t.poolSupply;
    life.ops.forEach(([name, arg, res, want], oi) => {
      const ctx = `life ${li} op ${oi} ${name} ${arg}`;
      let kind = name;
      if (name === 'buy') {
        try {
          const q = M.quoteBuy(t, st, arg);
          assert.deepEqual([q.charged, q.net, q.tokensOut, ...splitRow(q.split), q.drip, BigInt(q.partial), BigInt(q.graduates)], res, ctx);
          if (q.graduates) kind += q.partial ? ':graduates:partial' : ':graduates';
          st = q.newState; vault -= q.tokensOut;
        } catch (e) {
          if (!(e instanceof M.MathError)) throw e;
          assert.equal(e.code, res, ctx); kind += `:${e.code}`;
        }
      } else if (name === 'sell') {
        try {
          const q = M.quoteSell(t, st, arg);
          assert.deepEqual([q.gross, q.solOut, ...splitRow(q.split), q.drip], res, ctx);
          st = q.newState; vault += arg;
        } catch (e) {
          if (!(e instanceof M.MathError)) throw e;
          assert.equal(e.code, res, ctx); kind += `:${e.code}`;
        }
      } else if (name === 'buyback') {
        const q = M.quoteBuyback(t, st, arg);
        if (q) {
          assert.deepEqual([q.spent, q.coins, q.cap], res, ctx);
          st = q.newState; vault -= q.coins;
        } else {
          assert.equal(res, null, `${ctx}: the model ran a buyback, the port did not`); kind += ':noop';
        }
      } else if (name === 'pay_plat' || name === 'pay_fdr' || name === 'pay_hld') {
        const k = { pay_plat: 'platformPending', pay_fdr: 'founderPending', pay_hld: 'holdersPending' }[name];
        assert.equal(st[k], res, ctx);
        st = { ...st, [k]: 0n };
      } else if (name === 'inject_bb') {
        st = { ...st, buybackPending: st.buybackPending + arg, buybackEarned: st.buybackEarned + arg, feesTotal: st.feesTotal + arg };
      } else if (name === 'inject_liq') {
        st = { ...st, liquidityPending: st.liquidityPending + arg, liquidityEarned: st.liquidityEarned + arg, feesTotal: st.feesTotal + arg };
      } else if (name === 'max_quote_in') {
        const e = errOf(() => assert.equal(M.maxQuoteIn(t, st), res, ctx));
        if (e) assert.equal(e, res, ctx);
      } else {
        assert.fail(`unknown op ${name}`);
      }
      assert.deepEqual(stateRow(st, vault), want, `${ctx}: state after the operation`);
      ops++;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    });
  });
  assert.ok(ops >= 5_000, `at least 5,000 operations, got ${ops}`);
  for (const k of ['buy', 'sell', 'buyback', 'buy:graduates:partial', 'buyback:noop', 'buy:TradeTooSmall', 'sell:ZeroOutput',
    'sell:SellExceedsCurve', 'sell:ZeroAmount', 'max_quote_in']) {
    assert.ok((kinds.get(k) ?? 0) > 0, `no ${k} in the vectors`);
  }
});

test('fee split, gross-up, curve value and inverse vectors', () => {
  for (const e of V.fee_split) {
    const [l, p, f, h, b] = e.bps;
    const t = { ...M.DEFAULT_TERMS, liquidityBps: l, platformBps: p, founderBps: f, holdersBps: h, buybackBps: b, totalFeeBps: l + p + f + h + b };
    assert.deepEqual(splitRow(M.feeSplit(t, e.amount)), e.split, JSON.stringify(e, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  }
  for (const e of V.gross_for) {
    const t = { ...M.DEFAULT_TERMS, liquidityBps: e.t, platformBps: 0n, founderBps: 0n, holdersBps: 0n, buybackBps: 0n, totalFeeBps: e.t };
    if (e.gross === null) assert.equal(errOf(() => M.grossFor(t, e.net)), 'Overflow');
    else assert.equal(M.grossFor(t, e.net), e.gross);
  }
  for (const e of V.curve) {
    const t = M.termsFromParams(cfg(e.config));
    assert.equal(M.curveValue(t, e.s), e.f);
    assert.equal(M.tokensFor(t, e.q), e.tokens_for);
  }
});

test('validate_config vectors hit every rule', () => {
  const seen = new Set();
  for (const e of V.validate) {
    const got = M.configRule(cfg(e.params));
    assert.equal(got, e.rule, JSON.stringify(e, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    seen.add(got ?? 'pass');
  }
  for (const r of ['pass', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11']) assert.ok(seen.has(r), `no ${r} vector`);
});

test('derive_curve vectors (5.9)', () => {
  for (const e of V.derive) {
    let got = null;
    try { got = M.deriveCurve(e.S, e.P, e.R); } catch (x) { if (!(x instanceof M.MathError)) throw x; }
    assert.deepEqual(got, e.result);
  }
});

test('worked examples E1 to E10 (5.14) and the default config figures (5.9, 5.13)', () => {
  const t = M.DEFAULT_TERMS;
  const s0 = M.stateAtLaunch(0n);
  // E1
  const e1 = M.quoteBuy(t, s0, 1_000_000_000n);
  assert.deepEqual([e1.charged, e1.net, e1.tokensOut, ...splitRow(e1.split)], [1_000_000_000n, 975_000_000n, 33_774_693_369_781n, 25_000_000n, 5_000_000n, 5_000_000n, 7_000_000n, 5_000_000n, 5_000_000n, 3_000_000n]);
  assert.deepEqual(M.spotPrice(t, e1.newState), [30_975_853_639n, 1_039_250_905_116_834n]);
  // E2
  const e2 = M.quoteSell(t, e1.newState, e1.tokensOut);
  assert.deepEqual([e2.gross, e2.solOut, ...splitRow(e2.split)], [975_000_000n, 950_625_000n, 24_375_000n, 4_875_000n, 4_875_000n, 6_825_000n, 4_875_000n, 4_875_000n, 2_925_000n]);
  assert.equal(e2.newState.tokensSold, 0n); assert.equal(e2.newState.curveSol, 0n);
  assert.equal(M.liabilities(e2.newState), 49_375_000n);
  // E3
  const e3 = M.quoteBuy(t, s0, 100_000_000_000n);
  assert.deepEqual([e3.charged, e3.tokensOut, e3.partial, e3.graduates], [87_179_487_179n, 793_099_990_000_000n, true, true]);
  assert.deepEqual(splitRow(e3.split), [2_179_487_179n, 435_897_438n, 435_897_435n, 610_256_410n, 435_897_435n, 435_897_435n, 261_538_461n]);
  assert.deepEqual([e3.newState.poolSol, e3.newState.poolTokens, e3.newState.liquidityPending], [85_000_000_000n, 206_900_000_900_000n, 435_897_438n]);
  // E4, E5
  const e4 = M.quoteBuy(t, e3.newState, 1_000_000_000n);
  assert.deepEqual([e4.tokensOut, e4.drip, e4.newState.poolSol, e4.newState.poolTokens, e4.newState.liquidityPending], [2_346_350_693_544n, 5_000_000n, 85_985_000_000n, 204_553_650_206_456n, 430_897_438n]);
  const e5 = M.quoteSell(t, e4.newState, e4.tokensOut);
  assert.deepEqual([e5.gross, e5.solOut, e5.drip, e5.newState.poolSol, e5.newState.poolTokens, e5.newState.liquidityPending], [975_113_405n, 950_735_570n, 4_875_567n, 85_019_637_730n, 206_900_000_900_000n, 426_021_871n]);
  assert.deepEqual(splitRow(e5.split), [24_377_835n, 4_875_568n, 4_875_567n, 6_825_793n, 4_875_567n, 4_875_567n, 2_925_340n]);
  // E6
  assert.equal(M.grossFor(t, 84_500_000_000n), 86_666_666_666n);
  const s6 = M.quoteBuy(t, s0, 86_666_666_666n).newState;
  assert.deepEqual([s6.tokensSold, s6.curveSol], [791_877_616_545_871n, 84_500_000_000n]);
  assert.equal(M.maxQuoteIn(t, s6), 512_820_512n);
  const e6 = M.quoteBuy(t, s6, 1_000_000_000n);
  assert.deepEqual([e6.charged, e6.tokensOut, e6.graduates, e6.partial], [512_820_512n, 1_222_373_454_129n, true, true]);
  assert.deepEqual(splitRow(e6.split), [12_820_512n, 2_564_104n, 2_564_102n, 3_589_743n, 2_564_102n, 2_564_102n, 1_538_461n]);
  // E7: buyback 150 slots after E3
  const e7 = M.quoteBuyback(t, e3.newState, 150n);
  assert.deepEqual([e7.spent, e7.coins, e7.cap], [85_000_000n, 206_693_307_592n, 85_000_000n]);
  assert.deepEqual([e7.newState.poolSol, e7.newState.poolTokens, e7.newState.buybackPending], [85_085_000_000n, 206_693_307_592_408n, 176_538_461n]);
  assert.equal(M.quoteBuyback(t, e3.newState, 149n), null, 'interval not passed');
  // E8: buyback on the curve after a 10 SOL buy
  const b8 = M.quoteBuy(t, s0, 10_000_000_000n);
  assert.equal(b8.tokensOut, 263_189_306_077_696n);
  assert.equal(M.depth(t, b8.newState), 39_750_853_639n);
  const e8 = M.quoteBuyback(t, b8.newState, 150n);
  assert.deepEqual([e8.spent, e8.coins, e8.cap, e8.newState.tokensSold, e8.newState.curveSol], [30_000_000n, 610_723_163_277n, 39_750_853n, 263_800_029_240_973n, 9_780_000_000n]);
  // E9
  const e9 = M.quoteBuy(t, s0, 100_000n);
  assert.deepEqual([e9.tokensOut, ...splitRow(e9.split)], [3_487_222_633n, 2_500n, 500n, 500n, 700n, 500n, 500n, 300n]);
  assert.equal(errOf(() => M.quoteBuy(t, s0, 99_999n)), 'TradeTooSmall');
  // E10: the last raw unit, charged 1 lamport with a fee of 0
  const s10 = M.quoteBuy(t, s0, M.grossFor(t, M.curveValue(t, t.curveSupply - 1n))).newState;
  assert.deepEqual([s10.tokensSold, s10.curveSol], [t.curveSupply - 1n, t.graduationSol - 1n]);
  const e10 = M.quoteBuy(t, s10, 10_000_000_000n);
  assert.deepEqual([e10.charged, e10.split.fee, e10.tokensOut, e10.graduates], [1n, 0n, 1n, true]);
  // 5.9 and 5.13
  assert.equal(M.curveValue(t, t.curveSupply), 85_000_000_000n);
  assert.equal(M.curveValue(t, t.curveSupply - 1n), 84_999_999_999n);
  assert.equal(M.launchDust(t), 9_100_000n);
  assert.equal(M.grossFor(t, t.graduationSol), 87_179_487_179n, "floor(84,999,999,999 * 10,000 / 9,750) + 1");
  assert.deepEqual(M.v8Sides(M.DEFAULT_CONFIG), [613_813_296_968_750_000_000n, 618_750_000_000_000_000_000n]);
  assert.deepEqual(M.v11Sides(M.DEFAULT_CONFIG), [[2_400_937_500n, 2_405_000_000n], [2_413_250_000n, 2_417_850_000n]]);
  assert.deepEqual([M.buybackCap(t, s0), M.buybackCap(t, e3.newState)], [30_000_853n, 85_000_000n]);
});

test('errors instead of panics at the bounds (U09, T14, T15)', () => {
  const t = M.DEFAULT_TERMS;
  const s0 = M.stateAtLaunch(0n);
  const pool = M.quoteBuy(t, s0, 100_000_000_000n).newState;
  assert.equal(errOf(() => M.quoteBuy(t, pool, M.U64_MAX)), 'Overflow', 'liabilities would leave u64 (NOTES entry 5)');
  assert.equal(errOf(() => M.quoteSell(t, s0, 1n)), 'SellExceedsCurve');
  assert.equal(errOf(() => M.quoteSell(t, s0, 0n)), 'ZeroAmount');
  assert.equal(errOf(() => M.maxQuoteIn(t, pool)), 'WrongPhase');
  assert.equal(errOf(() => M.quoteBuy({ ...t, totalFeeBps: 249n }, s0, 1_000_000n)), 'InvalidTerms');
  assert.equal(errOf(() => M.quoteBuy(t, { ...s0, curveSol: t.graduationSol }, 1_000_000n)), 'InvalidState');
  assert.equal(errOf(() => M.curveValue(t, t.curveSupply + 1n)), 'InvalidTerms');
  assert.throws(() => M.quoteBuy(t, s0, -1n), RangeError);
  assert.throws(() => M.quoteBuy(t, s0, M.U64_MAX + 1n), RangeError);
  const big = { ...M.DEFAULT_CONFIG, virtualSol: 1n << 60n, virtualTokens: 1n << 60n };
  assert.notEqual(M.configRule(big), null);
  assert.equal(M.programErrorOf(new M.MathError('Overflow')), 'MathOverflow');
  assert.equal(M.programErrorOf(new M.MathError('ZeroOutput')), 'ZeroOutput');
  assert.equal(M.withSlippage(1_000_000n, 100), 990_000n);
});

test('the port refuses inputs the Rust types cannot hold', () => {
  assert.throws(() => M.terms({ ...M.DEFAULT_TERMS, liquidityBps: 70_000n }), RangeError);
  assert.throws(() => M.state({ ...M.stateAtLaunch(0n), phase: 2 }), RangeError);
  assert.throws(() => M.state({ ...M.stateAtLaunch(0n), buyVolume: M.U128_MAX + 1n }), RangeError);
});

test('buybackKeepUp: the volume per interval a keeper running every interval keeps up with, t / (C * b_B) of the depth, and 8.4\'s operating rule C * b_B <= 3t (7.2; review R9-PF-1, O36)', () => {
  const at = (shares) => M.buybackKeepUp({ ...M.DEFAULT_CONFIG, ...shares });
  assert.equal(M.BUYBACK_KEEP_UP_FACTOR, 3n);
  // config #0: a third of the depth, exactly at the edge of the rule
  assert.deepEqual(at({}), { buybackBps: 30n, totalFeeBps: 250n, keepUp: { num: 250n, den: 750n }, withinRule: true });
  // the review's config and O1's buyback alternative pass V1 to V11 but not the rule
  const heavy = { liquidityBps: 0n, platformBps: 0n, founderBps: 0n, holdersBps: 0n, buybackBps: 250n };
  assert.equal(M.configRule({ ...M.DEFAULT_CONFIG, ...heavy }), null);
  assert.deepEqual(at(heavy).keepUp, { num: 250n, den: 6250n });
  assert.equal(at(heavy).withinRule, false);
  assert.equal(at({ liquidityBps: 0n, platformBps: 70n, founderBps: 50n, holdersBps: 50n, buybackBps: 80n }).withinRule, false);
  assert.equal(at({ liquidityBps: 49n, buybackBps: 31n }).withinRule, false);
  // a smaller total fee shrinks the cap with it: 3t / C is the most b_B may be
  assert.equal(at({ liquidityBps: 0n, platformBps: 50n, founderBps: 20n, holdersBps: 20n, buybackBps: 10n }).withinRule, true);
  assert.equal(at({ liquidityBps: 0n, platformBps: 50n, founderBps: 20n, holdersBps: 20n, buybackBps: 11n }).withinRule, true);
  assert.equal(at({ liquidityBps: 0n, platformBps: 40n, founderBps: 20n, holdersBps: 20n, buybackBps: 11n }).withinRule, false);
  // no buyback share: nothing to keep up with
  assert.deepEqual(at({ liquidityBps: 80n, buybackBps: 0n }), { buybackBps: 0n, totalFeeBps: 250n, keepUp: null, withinRule: true });
});
