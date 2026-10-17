// L03: add_launch_config for config #0 and edge configs, every V error on chain
// (5.13; the program's validate_config agrees with the reference model's on the
// golden vectors, F03 in miniature), set_launch_config_enabled and what a
// disabled config blocks (4.6, 4.7, R4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { World, S, SOL, expectFail, metaHash, DAY } from './helpers.mjs';

const VECTORS = JSON.parse(readFileSync(join(SOL, 'crates', 'vicinity-curve-math', 'reference', 'vectors.json'), 'utf8'),
  (k, v, ctx) => (typeof v === 'number' && /^-?\d+$/.test(ctx?.source ?? '') ? BigInt(ctx.source) : v));
const fromVector = (c) => ({
  liquidityBps: c.bps[0], platformBps: c.bps[1], founderBps: c.bps[2], holdersBps: c.bps[3], buybackBps: c.bps[4],
  virtualSol: c.x0, virtualTokens: c.y0, curveSupply: c.S, poolSupply: c.P, graduationSol: c.R, launchFeeLamports: c.fee ?? 0n,
});
const fits = (p) => [p.virtualSol, p.virtualTokens, p.curveSupply, p.poolSupply, p.graduationSol, p.launchFeeLamports].every((x) => x >= 0n && x < 1n << 64n)
  && [p.liquidityBps, p.platformBps, p.founderBps, p.holdersBps, p.buybackBps].every((x) => x >= 0n && x <= 0xffffn);

test('L03 config #0: every field, ConfigAdded, the default figures of 5.9', async () => {
  const w = await World.create({ config0: false });
  const res = await w.send([w.ix.addLaunchConfig({ admin: w.admin.address, payer: w.payer.address, configId: 0, params: S.DEFAULT_CONFIG })], [w.admin], 'add config #0');
  const c = w.config(0);
  assert.deepEqual(S.configParamsOf(c), { ...S.DEFAULT_CONFIG });
  assert.deepEqual([c.configId, c.enabled, c.totalFeeBps, c.createdAt], [0, true, 250n, w.now()]);
  assert.equal(c.bump, S.findPda([Buffer.from('config'), Buffer.from([0, 0])], w.programId)[1]);
  assert.equal(w.launchpad().nextConfigId, 1);
  const ev = res.events.find((e) => e.name === 'ConfigAdded').data;
  assert.deepEqual([ev.config_id, ev.liquidity_bps, ev.platform_bps, ev.founder_bps, ev.holders_bps, ev.buyback_bps, ev.total_fee_bps, ev.virtual_sol,
    ev.virtual_tokens, ev.curve_supply, ev.pool_supply, ev.graduation_sol, ev.launch_fee_lamports, ev.enabled, ev.created_at],
  [0n, 50n, 70n, 50n, 50n, 30n, 250n, 30_000_853_639n, 1_073_025_598_486_615n, 793_099_990_000_000n, 206_900_000_900_000n, 85_000_000_000n, 50_000_000n, true, w.now()]);
  // only the admin; ids are sequential (the seed is next_config_id)
  const stranger = await w.signer();
  await expectFail(() => w.send([w.ix.addLaunchConfig({ admin: stranger.address, payer: w.payer.address, configId: 1, params: S.DEFAULT_CONFIG })], [stranger], 'stranger'), 'Unauthorized');
  await expectFail(() => w.send([w.ix.addLaunchConfig({ admin: w.admin.address, payer: w.payer.address, configId: 5, params: S.DEFAULT_CONFIG })], [w.admin], 'wrong id'), 'ConstraintSeeds');
  await expectFail(() => w.send([w.ix.addLaunchConfig({ admin: w.admin.address, payer: w.payer.address, configId: 0, params: S.DEFAULT_CONFIG })], [w.admin], 'id 0 again'), 'ConstraintSeeds', /already in use/);
  await w.finish();
});

test('L03 edge configs: the pool option O3 (c), the V10 edge, and every V error on chain (golden vectors)', async () => {
  const w = await World.create();
  // O3 (c): the 9.1 coins in the pool, no burn (5.9)
  const poolOption = { ...S.DEFAULT_CONFIG, virtualSol: 30_000_855_424n, virtualTokens: 1_073_025_615_141_714n, poolSupply: 206_900_010_000_000n };
  assert.equal(S.launchDust(S.termsFromParams(poolOption)), 0n);
  assert.equal(await w.addConfig(poolOption), 1);
  // V10's edge passes (b_P = b_L + 1), b_P = b_L fails (X27b)
  assert.equal(await w.addConfig({ ...S.DEFAULT_CONFIG, platformBps: 51n }), 2);
  await expectFail(() => w.addConfig({ ...S.DEFAULT_CONFIG, platformBps: 50n }), 'ConfigDripFarmable');
  // revision 1's founder-favouring split is refused by V2 (X44)
  await expectFail(() => w.addConfig({ ...S.DEFAULT_CONFIG, liquidityBps: 50n, platformBps: 0n, founderBps: 170n, holdersBps: 0n, buybackBps: 30n }), 'ConfigFeeShareCap');
  // one golden vector per rule, and passing ones: the program's verdict equals the model's
  const byRule = new Map();
  for (const e of VECTORS.validate) {
    const p = fromVector(e.params);
    if (!fits(p)) continue;
    const k = e.rule ?? 'pass';
    if ((byRule.get(k)?.length ?? 0) < (k === 'pass' ? 3 : 2)) byRule.set(k, [...(byRule.get(k) ?? []), p]);
  }
  const want = { V1: 'ConfigFeeTotal', V2: 'ConfigFeeShareCap', V3: 'ConfigSupply', V4: 'ConfigCurveBounds', V5: 'ConfigGraduation', V6: 'ConfigAbsorption',
    V7: 'ConfigContinuity', V8: 'ConfigBuybackMev', V9: 'ConfigLaunchFee', V10: 'ConfigDripFarmable', V11: 'ConfigBuybackHorizon' };
  let tested = 0;
  for (const [rule, list] of byRule) {
    for (const p of list) {
      assert.equal(S.configRule(p), rule === 'pass' ? null : rule, 'the SDK port agrees with the model');
      if (rule === 'pass') {
        const id = await w.addConfig(p);
        assert.deepEqual(S.configParamsOf(w.config(id)), S.configParams(p));
      } else {
        await expectFail(() => w.addConfig(p), want[rule]);
      }
      tested++;
    }
  }
  assert.deepEqual([...byRule.keys()].sort(), ['V1', 'V10', 'V11', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'pass'].sort());
  assert.ok(tested >= 25);
  await w.finish();
});

test('L03 set_launch_config_enabled: only the admin; a disabled config blocks approvals and launches, never live coins', async () => {
  const w = await World.create();
  const stranger = await w.signer();
  const founder = await w.signer(); const founder2 = await w.signer();
  const live = await w.launchCoin({ cityId: 1n, founder, symbol: 'LIVE' });
  await w.approve({ cityId: 2n, founder: founder2, symbol: 'NEXT' });
  await expectFail(() => w.send([w.ix.setLaunchConfigEnabled({ admin: stranger.address, configId: 0, enabled: false })], [stranger], 'stranger'), 'Unauthorized');
  const r = await w.send([w.ix.setLaunchConfigEnabled({ admin: w.admin.address, configId: 0, enabled: false })], [w.admin], 'disable config #0');
  assert.deepEqual(r.events[0], { name: 'ConfigEnabled', data: { config_id: 0n, enabled: false } });
  assert.equal(w.config(0).enabled, false);
  // new approvals and launches under it are refused
  await expectFail(() => w.approve({ cityId: 3n, founder: founder2, symbol: 'THREE' }), 'ConfigDisabled');
  await expectFail(() => w.launch({ cityId: 2n, founder: founder2 }), 'ConfigDisabled');
  // the live coin never reads its config again: trades and exits go on
  const u = await w.signer(100n);
  const b = await w.buy(u, live, 2_000_000_000n);
  await w.sell(u, live, b.q.tokensOut / 2n);
  // re-enabled: the pending approval launches
  await w.send([w.ix.setLaunchConfigEnabled({ admin: w.admin.address, configId: 0, enabled: true })], [w.admin], 'enable config #0');
  await w.launch({ cityId: 2n, founder: founder2 });
  // a config that does not exist
  await expectFail(() => w.send([w.ix.setLaunchConfigEnabled({ admin: w.admin.address, configId: 9, enabled: false })], [w.admin], 'no config 9'), 'AccountNotInitialized');
  await expectFail(() => w.send([w.ix.approveLaunch({ admin: w.admin.address, cityId: 4n, founder: founder2.address, configId: 9, name: 'X', symbol: 'FOUR', metaHash: metaHash(4), expiresAt: w.now() + DAY })], [w.admin], 'approve under config 9'), 'AccountNotInitialized');
  await w.finish();
});
