// F03 (VICINITY-CURVE-DESIGN.md 12.5): config fuzz over the whole V1 to V11
// space. Every golden config of the reference model (crates/vicinity-curve-math/
// reference/vectors.json, 1,500 cases written by the Python model of Appendix A,
// hitting every rule) that fits the instruction's u16 and u64 arguments, and a
// seeded set of configs built around valid curves found by 5.9's search (each
// rule broken alone, every field one step either side of a valid value, random
// shares), is sent to add_launch_config on chain. The program accepts exactly
// the configs the model accepts, refuses each other one with the error of its
// first failing rule (5.13's table order), stores accepted ones byte for byte
// and counts them in next_config_id; a refused one creates nothing. A sample of
// the accepted configs is then launched and traded to graduation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { World, S, SOL, TxError, LAMPORTS } from './helpers.mjs';
import { makeRng } from './fuzz.mjs';

const VECTORS = JSON.parse(readFileSync(join(SOL, 'crates', 'vicinity-curve-math', 'reference', 'vectors.json'), 'utf8'),
  (k, v, ctx) => (typeof v === 'number' && /^-?\d+$/.test(ctx?.source ?? '') ? BigInt(ctx.source) : v));
const fromVector = (c) => ({
  liquidityBps: BigInt(c.bps[0]), platformBps: BigInt(c.bps[1]), founderBps: BigInt(c.bps[2]), holdersBps: BigInt(c.bps[3]), buybackBps: BigInt(c.bps[4]),
  virtualSol: BigInt(c.x0), virtualTokens: BigInt(c.y0), curveSupply: BigInt(c.S), poolSupply: BigInt(c.P), graduationSol: BigInt(c.R), launchFeeLamports: BigInt(c.fee ?? 0),
});
const fits = (p) => [p.virtualSol, p.virtualTokens, p.curveSupply, p.poolSupply, p.graduationSol, p.launchFeeLamports].every((x) => x >= 0n && x < 1n << 64n)
  && [p.liquidityBps, p.platformBps, p.founderBps, p.holdersBps, p.buybackBps].every((x) => x >= 0n && x <= 0xffffn);
const ERROR = { V1: 'ConfigFeeTotal', V2: 'ConfigFeeShareCap', V3: 'ConfigSupply', V4: 'ConfigCurveBounds', V5: 'ConfigGraduation', V6: 'ConfigAbsorption',
  V7: 'ConfigContinuity', V8: 'ConfigBuybackMev', V9: 'ConfigLaunchFee', V10: 'ConfigDripFarmable', V11: 'ConfigBuybackHorizon' };
const KEYS = ['liquidityBps', 'platformBps', 'founderBps', 'holdersBps', 'buybackBps', 'virtualSol', 'virtualTokens', 'curveSupply', 'poolSupply', 'graduationSol', 'launchFeeLamports'];

/** Configs around valid curves: random shares, each field one step either side, and each rule broken on purpose. */
function generated(seed, n) {
  const r = makeRng(seed);
  const out = [];
  const bps = () => ({ liquidityBps: BigInt(r.int(121)), platformBps: BigInt(r.int(121)), founderBps: BigInt(r.int(101)), holdersBps: BigInt(r.int(121)), buybackBps: BigInt(r.int(61)) });
  const curve = () => {
    for (;;) {
      const p = 10_000_000_000_000n + r.below(440_000_000_000_000n);
      const dust = r.chance(0.4) ? 0n : r.chance(0.5) ? 9_100_000n : r.below(S.MAX_DUST_RAW + 1n);
      const s = S.COIN_SUPPLY - p - dust;
      const R = r.log(9, 13);
      const g = R < S.MIN_GRADUATION_LAMPORTS ? S.MIN_GRADUATION_LAMPORTS : R > S.MAX_GRADUATION_LAMPORTS ? S.MAX_GRADUATION_LAMPORTS : R;
      try { const [x0, y0] = S.deriveCurve(s, p, g, 64n); return { virtualSol: x0, virtualTokens: y0, curveSupply: s, poolSupply: p, graduationSol: g }; } catch { /* try another */ }
    }
  };
  while (out.length < n) {
    const base = { ...bps(), ...curve(), launchFeeLamports: r.below(S.MAX_LAUNCH_FEE_LAMPORTS + 1n) };
    out.push(base);
    // every field one step either side
    const k = r.pick(KEYS);
    out.push({ ...base, [k]: base[k] + 1n });
    if (base[k] > 0n) out.push({ ...base, [k]: base[k] - 1n });
    // each rule broken on purpose
    const t = base.liquidityBps + base.platformBps + base.founderBps + base.holdersBps + base.buybackBps;
    out.push({ ...base, holdersBps: base.holdersBps + 251n - t > 0n ? base.holdersBps + 251n - t : base.holdersBps + 300n }); // V1 (or V2)
    out.push({ ...base, platformBps: 121n, liquidityBps: 0n, founderBps: 0n, holdersBps: 0n, buybackBps: 0n }); // V2
    out.push({ ...base, founderBps: 101n, liquidityBps: 0n, platformBps: 0n, holdersBps: 0n, buybackBps: 0n }); // V2
    out.push({ ...base, founderBps: base.founderBps, liquidityBps: 0n, platformBps: 0n, holdersBps: 0n, buybackBps: 0n }); // V2b (or V1 at 0)
    out.push({ ...base, holdersBps: base.holdersBps + 1n, liquidityBps: 0n, platformBps: 0n, founderBps: 0n, buybackBps: 0n }); // V2b
    out.push({ ...base, poolSupply: base.poolSupply + S.MAX_DUST_RAW + 1n }); // V3
    out.push({ ...base, virtualSol: S.MAX_VIRTUAL + 1n }); // V4
    out.push({ ...base, graduationSol: base.graduationSol + 1n }); // V5 (f(S) != R)
    out.push({ ...base, virtualTokens: base.curveSupply + 1n }); // V6 or earlier
    out.push({ ...base, virtualSol: base.virtualSol - 41n }); // V7 below the curve's end
    out.push({ ...base, launchFeeLamports: S.MAX_LAUNCH_FEE_LAMPORTS + 1n }); // V9
    out.push({ ...base, liquidityBps: base.platformBps, platformBps: base.platformBps }); // V10 when b_L = b_P > 0
    out.push({ ...base, buybackBps: 60n, liquidityBps: 0n, platformBps: 1n, founderBps: 0n, holdersBps: 0n }); // V8 / V11 with a tiny total
  }
  return out;
}

test('F03: on-chain validate_config agrees with the reference model on every golden config and on a seeded set across V1 to V11', async () => {
  const w = await World.create();
  w.probeEach = false;
  const golden = VECTORS.validate.map((e) => ({ p: fromVector(e.params), rule: e.rule ?? null, src: 'golden' })).filter((x) => fits(x.p));
  const gen = generated(Number(process.env.VCURVE_F03_SEED ?? 3), Number(process.env.VCURVE_F03_N ?? 360)).map((p) => ({ p, rule: S.configRule(p), src: 'generated' }));
  const counts = {};
  const accepted = [];
  let nextId = w.launchpad().nextConfigId;
  for (const [i, { p, rule, src }] of [...golden, ...gen].entries()) {
    assert.equal(S.configRule(p), rule, `${src} ${i}: the SDK port agrees with the reference model`);
    counts[rule ?? 'pass'] = (counts[rule ?? 'pass'] ?? 0) + 1;
    const ix = w.ix.addLaunchConfig({ admin: w.admin.address, payer: w.payer.address, configId: nextId, params: p });
    let err = null;
    try { await w.send([ix], [w.admin], `F03 ${src} ${i} (${rule ?? 'pass'})`, { noProbe: true }); } catch (e) { if (!(e instanceof TxError)) throw e; err = e; }
    if (rule === null) {
      assert.equal(err, null, `${src} ${i}: a valid config was refused: ${err?.message}`);
      const c = w.config(nextId);
      assert.deepEqual(S.configParamsOf(c), S.configParams(p), 'stored as given');
      assert.equal(c.enabled, true);
      accepted.push(nextId);
      nextId++;
    } else {
      assert.ok(err, `${src} ${i}: ${rule} config accepted`);
      assert.ok(new RegExp(`\\b${ERROR[rule]}\\b`).test(`${err.logs.join('\n')}\n${err.errText}`), `${src} ${i}: expected ${ERROR[rule]}, got ${err.message}`);
      assert.equal(w.exists(w.P.config(nextId)), false, 'nothing created');
    }
    assert.equal(w.launchpad().nextConfigId, nextId);
  }
  for (const rule of [...Object.keys(ERROR), 'pass']) assert.ok(counts[rule] >= 4, `rule ${rule} covered (${counts[rule] ?? 0})`);
  const total = golden.length + gen.length;
  assert.ok(total >= 1_500, `${total} configs`);
  // a sample of the accepted configs, launched and traded to graduation
  const sample = accepted.filter((_, i) => i % Math.max(1, Math.floor(accepted.length / 8)) === 0).slice(0, 8);
  const whale = await w.signer(1n);
  w.setRaw(whale.address, Buffer.alloc(0), S.ADDRESSES.system, 100_000_000n * LAMPORTS);
  for (const [k, id] of sample.entries()) {
    const h = await w.launchCoin({ cityId: 8_000_000n + BigInt(k), symbol: `CF${k}`, configId: id });
    await w.buy(whale, h, LAMPORTS / 10n, { label: `first buy on config ${id}` });
    const c = w.coinView(h);
    await w.buy(whale, h, S.maxQuoteIn(S.coinTerms(c), S.coinState(c)), { label: `graduate config ${id}` });
    assert.equal(w.coinView(h).phase, 1);
    await w.sell(whale, h, w.balanceOf(whale, h.mint) / 3n, { label: `sell in the pool of config ${id}` });
  }
  await w.finish();
  console.log(`F03: ${total} configs (${golden.length} golden, ${gen.length} generated), by rule ${JSON.stringify(counts)}; ${accepted.length} accepted, ${sample.length} launched to graduation`);
});
