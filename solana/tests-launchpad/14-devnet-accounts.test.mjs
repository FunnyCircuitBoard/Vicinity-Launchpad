// TL01-TL02 (opt-in, DEVNET_LIVE=1): the accounts the devnet demo already
// created on devnet, read from devnet (read-only, nothing is sent) and replayed
// through our program in process, so they are proven to work before the
// program itself is on devnet (LAUNCHPAD-DEVNET.md):
//   TL01 the test quote token tVIC and both Vicinity Meteora configs pass every
//        config rule of add_launch_config, with the values the demo expects
//   TL02 a coin launched on each of them trades; the tVIC coin fills its curve,
//        pays out its fees and graduates into a Meteora DAMM v2 pool
// Run it on Meteora's devnet builds, which is what devnet runs:
//   NETWORK=devnet npm run launchpad:fixtures
//   DEVNET_LIVE=1 LAUNCHPAD_PROGRAMS_DIR=tests-launchpad/fixtures/programs-devnet node --test tests-launchpad/14-devnet-accounts.test.mjs
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import web3 from '@solana/web3.js';
import { World, C, IDL, P, ADDRESSES, PROGRAM_IDS, LAMPORTS, ata, decodeAccount, harvest, graduate } from './helpers.mjs';

const live = process.env.DEVNET_LIVE === '1';
const RPC = process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com';
const here = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(join(here, '..', 'scripts', 'launchpad', 'devnet-demo-state.json'), 'utf8'));
const { dbcConfigSol, dbcConfigTvic, testQuoteMint } = state.addresses;
const TVIC = 1_000_000n;

describe('14 the devnet accounts, replayed in process', { skip: !live && 'set DEVNET_LIVE=1 (reads devnet)' }, () => {
  let w;
  before(async () => {
    w = await World.create();
    const conn = new web3.Connection(RPC, 'confirmed');
    const keys = [dbcConfigSol, dbcConfigTvic, testQuoteMint].map((a) => new web3.PublicKey(a));
    const accs = await conn.getMultipleAccountsInfo(keys);
    assert.deepEqual(accs.map((a) => a?.owner.toBase58()), [PROGRAM_IDS.dbc, PROGRAM_IDS.dbc, PROGRAM_IDS.token]);
    keys.forEach((k, i) => w.setRaw(k.toBase58(), accs[i].data, accs[i].owner.toBase58(), BigInt(accs[i].lamports)));
  });

  it('TL01 tVIC and both Vicinity configs pass add_launch_config with the expected values', async () => {
    for (const [cfg, quote, target] of [[dbcConfigSol, ADDRESSES.wsol, LAMPORTS], [dbcConfigTvic, testQuoteMint, 25_000_000n * TVIC]]) {
      await w.send([C.addLaunchConfig({ admin: w.admin.address, dbcConfig: cfg, quoteMint: quote })], [w.admin], `add_launch_config ${cfg}`);
      const lc = decodeAccount(IDL.launchpad, 'LaunchConfig', w.account(P.launchConfig(cfg)).data);
      assert.equal(lc.quote_mint.toBase58(), quote);
      assert.equal(lc.migration_quote_threshold.toString(), String(target));
      assert.equal(lc.trade_fee_numerator.toString(), '12500000'); // 1.25%
      assert.equal(lc.pool_creation_fee.toString(), '10000000'); // the demo's 0.01 SOL launch fee
      assert.equal(lc.enabled, true);
    }
  });

  it('TL02 a coin on each config trades; the tVIC coin fills, pays its fees and graduates', async () => {
    const solCoin = await w.launchCoin({ cityId: 999100003n, name: 'Demo Village', symbol: 'DEMOV', dbcConfig: dbcConfigSol, quoteMint: ADDRESSES.wsol });
    const t = await w.signer(10n);
    await w.trade(t, solCoin, { side: 'buy', amount0: LAMPORTS / 100n, amount1: 1n });
    const held = w.balance(ata(t.address, solCoin.mint));
    assert.ok(held > 0n);
    await w.trade(t, solCoin, { side: 'sell', amount0: held / 2n, amount1: 1n });
    assert.equal(w.balance(ata(t.address, solCoin.mint)), held - held / 2n);
    const coin = await w.launchCoin({ cityId: 999100001n, name: 'Demo City', symbol: 'DEMO', dbcConfig: dbcConfigTvic, quoteMint: testQuoteMint });
    const buyer = await w.signer(10n);
    await w.trade(buyer, coin, { side: 'buy', amount0: 2_000_000n * TVIC, amount1: 1n });
    await w.trade(buyer, coin, { side: 'buy', mode: 1, amount0: 40_000_000n * TVIC, amount1: 1n, label: 'partial fill to graduation' });
    assert.ok(w.pool(coin.dbcPool).quoteReserve >= 25_000_000n * TVIC);
    await harvest(w, coin, 'curve');
    const after = w.coin(coin.cityId);
    assert.ok(after.holdersAccrued > 0n && after.founderAccrued > 0n);
    const g = await graduate(w, coin, await w.signer(5n));
    assert.equal(w.pool(coin.dbcPool).isMigrated, 1);
    assert.equal(w.account(g.pool).programAddress, PROGRAM_IDS.damm);
  });
});
