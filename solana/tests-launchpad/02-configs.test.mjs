// TB01-TB16: only Vicinity-shaped Meteora configs are accepted (design 7.2).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
import { World, C, IDL, P, ADDRESSES, PROGRAM_IDS, expectFail, assertInvariants, eventsNamed, mintData, decodeAccount } from './helpers.mjs';
import { vicinityConfigParams } from '../sdk/launchpad/config.mjs';

const { BN } = anchor;
const pk = (s) => new web3.PublicKey(s);
const rnd = () => web3.Keypair.generate().publicKey;

describe('02 launch configs', () => {
  let w;
  before(async () => { w = await World.create(); });

  const add = (cfg, quoteMint = ADDRESSES.wsol, admin = w.admin) =>
    w.send([C.addLaunchConfig({ admin: admin.address, dbcConfig: cfg, quoteMint })], [admin], 'add_launch_config');
  const refuse = async (mutate, ...codes) => {
    const cfg = await w.cloneConfig(mutate);
    await expectFail(() => add(cfg), ...codes);
    assert.equal(w.exists(P.launchConfig(cfg)), false);
  };

  it('TB01 the default config (85 SOL, 1.25%, all locked) is accepted with its values copied', async () => {
    const lc = decodeAccount(IDL.launchpad, 'LaunchConfig', w.account(P.launchConfig(w.config)).data);
    assert.equal(lc.dbc_config.toBase58(), w.config);
    assert.equal(lc.quote_mint.toBase58(), ADDRESSES.wsol);
    assert.equal(lc.migration_quote_threshold.toString(), '85000000000');
    assert.equal(lc.trade_fee_numerator.toString(), '12500000');
    assert.equal(lc.pool_creation_fee.toString(), '50000000');
    assert.equal(lc.enabled, true);
    // a byte-identical clone is accepted too, and emits its event
    const cfg = await w.cloneConfig(() => {});
    const res = await add(cfg);
    const ev = eventsNamed(res, 'LaunchConfigAdded')[0].data;
    assert.equal(ev.dbc_config.toBase58(), cfg);
    assert.equal(ev.pool_creation_fee.toString(), '50000000');
    // only the admin may add, and only once
    const stranger = await w.signer();
    const another = await w.cloneConfig(() => {});
    await expectFail(() => add(another, ADDRESSES.wsol, stranger), 'Unauthorized');
    await expectFail(() => add(cfg), /already in use/);
    assertInvariants(w);
  });

  it('TB02 fee claimer must be the dev wallet (real create_config and edited bytes)', async () => {
    const other = await w.createDbcConfig({}, { feeClaimer: rnd().toBase58() });
    await expectFail(() => add(other), 'ConfigFeeClaimer');
    await refuse((c) => { c.fee_claimer = rnd(); }, 'ConfigFeeClaimer');
  });
  it('TB03 leftover receiver must be the dev wallet', async () => {
    const other = await w.createDbcConfig({}, { leftoverReceiver: rnd().toBase58() });
    await expectFail(() => add(other), 'ConfigLeftoverReceiver');
  });
  it('TB04 creator fee percentage must be 50', async () => {
    await refuse((c) => { c.creator_trading_fee_percentage = 49; }, 'ConfigFeeSplit');
    await refuse((c) => { c.creator_trading_fee_percentage = 100; }, 'ConfigFeeSplit');
  });
  it('TB05 fee above 2%, a fee schedule that decays, or a dynamic fee is refused', async () => {
    await refuse((c) => { c.pool_fees.base_fee.cliff_fee_numerator = new BN(20_000_001); }, 'ConfigFee');
    await refuse((c) => { c.pool_fees.base_fee.first_factor = 60; }, 'ConfigFee');
    await refuse((c) => { c.pool_fees.base_fee.third_factor = new BN(1000); }, 'ConfigFee');
    await refuse((c) => { c.pool_fees.base_fee.base_fee_mode = 2; }, 'ConfigFee');
    await refuse((c) => { c.pool_fees.dynamic_fee.initialized = 1; }, 'ConfigFee');
    // exactly 2% is allowed
    await add(await w.cloneConfig((c) => { c.pool_fees.base_fee.cliff_fee_numerator = new BN(20_000_000); }));
  });
  it('TB06 mutable metadata is refused', async () => {
    for (const v of [0, 2, 3, 4]) await refuse((c) => { c.token_update_authority = v; }, 'ConfigMetadataMutable');
  });
  it('TB07 a Token-2022 coin is refused', async () => {
    await refuse((c) => { c.token_type = 1; }, 'ConfigTokenType');
  });
  it('TB08 a Token-2022 quote mint (xStock-like: permanent delegate, pause, hook) is refused', async () => {
    const xstock = rnd().toBase58();
    // a Token-2022 mint (extensions follow the base layout; the owner alone refuses it)
    w.setRaw(xstock, Buffer.concat([mintData({ decimals: 8, mintAuthority: rnd().toBase58(), freezeAuthority: rnd().toBase58() }), Buffer.alloc(200)]), PROGRAM_IDS.token2022);
    const cfg = await w.cloneConfig((c) => { c.quote_mint = pk(xstock); });
    await expectFail(() => add(cfg, xstock), 'QuoteMintNotAllowed');
    const flagged = await w.cloneConfig((c) => { c.quote_token_flag = 1; });
    await expectFail(() => add(flagged), 'QuoteMintNotAllowed');
  });
  it('TB09 a quote mint with a freeze authority (USDC-like) or a live mint authority is refused', async () => {
    const cases = [
      mintData({ decimals: 6, mintAuthority: rnd().toBase58(), freezeAuthority: rnd().toBase58() }), // USDC
      mintData({ decimals: 6, freezeAuthority: rnd().toBase58() }),
      mintData({ decimals: 6, mintAuthority: rnd().toBase58() }),
      mintData({ decimals: 5 }),
      mintData({ decimals: 10 }),
    ];
    for (const data of cases) {
      const m = rnd().toBase58();
      w.setRaw(m, data, PROGRAM_IDS.token);
      const cfg = await w.cloneConfig((c) => { c.quote_mint = pk(m); });
      await expectFail(() => add(cfg, m), 'QuoteMintNotAllowed');
    }
    // a VICINITY-like mint (6 decimals, no authorities) passes
    const vic = rnd().toBase58();
    w.setRaw(vic, mintData({ decimals: 6, supply: 10n ** 15n }), PROGRAM_IDS.token);
    await add(await w.cloneConfig((c) => { c.quote_mint = pk(vic); }), vic);
    // the quote mint passed must be the config's
    const cfg2 = await w.cloneConfig(() => {});
    await expectFail(() => add(cfg2, vic), 'LaunchConfigMismatch');
  });
  it('TB10 liquidity must be 50/50 permanently locked, nothing withdrawable or vesting', async () => {
    await refuse((c) => { c.partner_liquidity_percentage = 10; c.partner_permanent_locked_liquidity_percentage = 40; }, 'ConfigLiquidityLock');
    await refuse((c) => { c.creator_liquidity_percentage = 50; c.creator_permanent_locked_liquidity_percentage = 0; }, 'ConfigLiquidityLock');
    await refuse((c) => { c.partner_permanent_locked_liquidity_percentage = 60; c.creator_permanent_locked_liquidity_percentage = 40; }, 'ConfigLiquidityLock');
    await refuse((c) => { c.creator_liquidity_vesting_info.is_initialized = 1; c.creator_liquidity_vesting_info.vesting_percentage = 10; }, 'ConfigLiquidityLock');
  });
  it('TB11 a graduation fee or a locked vesting allocation is refused', async () => {
    await refuse((c) => { c.migration_fee_percentage = 5; }, 'ConfigMigrationFee');
    await refuse((c) => { c.creator_migration_fee_percentage = 5; }, 'ConfigMigrationFee');
    await refuse((c) => { c.locked_vesting_config.amount_per_period = new BN(1000); c.locked_vesting_config.number_of_period = new BN(10); }, 'ConfigVesting');
    await refuse((c) => { c.locked_vesting_config.cliff_unlock_amount = new BN(1); }, 'ConfigVesting');
  });
  it('TB12 supply must be exactly 10^15 and fixed', async () => {
    await refuse((c) => { c.fixed_token_supply_flag = 0; }, 'ConfigDecimalsOrSupply');
    await refuse((c) => { c.pre_migration_token_supply = new BN('1000000000000001'); }, 'ConfigDecimalsOrSupply');
    await refuse((c) => { c.post_migration_token_supply = new BN('999999999999999'); }, 'ConfigDecimalsOrSupply');
    await refuse((c) => { c.token_decimal = 9; }, 'ConfigDecimalsOrSupply');
  });
  it('TB13 a launch fee above 0.5 SOL is refused', async () => {
    await refuse((c) => { c.pool_creation_fee = new BN(500_000_001); }, 'ConfigLaunchFee');
    const big = await w.createDbcConfig({ poolCreationFeeSol: 0.6 });
    await expectFail(() => add(big), 'ConfigLaunchFee');
  });
  it('TB14 graduation must be a DAMM v2 customizable pool with a flat quote-only fee <= 2% and nothing on top', async () => {
    await refuse((c) => { c.migration_option = 0; }, 'ConfigMigration');
    await refuse((c) => { c.migration_fee_option = 5; }, 'ConfigMigration');
    await refuse((c) => { c.migrated_collect_fee_mode = 1; }, 'ConfigMigration');
    await refuse((c) => { c.migrated_collect_fee_mode = 2; }, 'ConfigMigration');
    await refuse((c) => { c.migrated_pool_fee_bps = 201; }, 'ConfigMigration');
    // the three gaps found in the design review, one case each
    await refuse((c) => { c.migrated_dynamic_fee = 1; }, 'ConfigMigration');
    await refuse((c) => { c.migrated_pool_base_fee_mode = 3; }, 'ConfigMigration');
    await refuse((c) => { c.migrated_pool_base_fee_bytes[7] = 1; }, 'ConfigMigration');
    await refuse((c) => { c.migrated_compounding_fee_bps = 10; }, 'ConfigMigration');
    // a real DBC config with a 3% graduated pool fee
    const hi = await w.createDbcConfig({ migratedPoolFeeBps: 300 });
    await expectFail(() => add(hi), 'ConfigMigration');
    // collecting fees in both tokens on the curve
    await refuse((c) => { c.collect_fee_mode = 1; }, 'ConfigCollectFeeMode');
  });
  it('TB15 type cosplay: a byte-identical config owned by another program, and a DBC pool as config', async () => {
    const foreign = await w.cloneConfig(() => {}, { owner: PROGRAM_IDS.token });
    await expectFail(() => add(foreign), 'AccountOwnedByWrongProgram');
    const ours = await w.cloneConfig(() => {}, { owner: PROGRAM_IDS.launchpad });
    await expectFail(() => add(ours), 'AccountOwnedByWrongProgram');
    const coin = await w.launchCoin({ cityId: 4242n });
    await expectFail(() => add(coin.dbcPool), 'AccountDiscriminatorMismatch');
    // a system account
    const s = await w.signer();
    await expectFail(() => add(s.address), 'AccountOwnedByWrongProgram', 'AccountNotInitialized');
  });
  it('TB16 a disabled config blocks approve_launch and launch; re-enabling restores it', async () => {
    const founder = await w.signer();
    await w.approve({ cityId: 7001n, founder });
    const stranger = await w.signer();
    await expectFail(() => w.send([C.setLaunchConfigEnabled({ admin: stranger.address, dbcConfig: w.config, enabled: false })], [stranger]), 'Unauthorized');
    const res = await w.send([C.setLaunchConfigEnabled({ admin: w.admin.address, dbcConfig: w.config, enabled: false })], [w.admin]);
    assert.equal(eventsNamed(res, 'LaunchConfigEnabled')[0].data.enabled, false);
    await expectFail(() => w.approve({ cityId: 7002n, founder }), 'LaunchConfigDisabled');
    await expectFail(() => w.launchCoin({ cityId: 7001n, founder, approved: true }), 'LaunchConfigDisabled');
    await w.send([C.setLaunchConfigEnabled({ admin: w.admin.address, dbcConfig: w.config, enabled: true })], [w.admin]);
    await w.launchCoin({ cityId: 7001n, founder, approved: true });
    assertInvariants(w);
  });

  it('config.mjs builds what DBC accepts and our rules allow, for SOL and VICINITY-style quotes', async () => {
    const p = vicinityConfigParams({ quoteDecimals: 6, migrationQuoteThreshold: 25_000_000 });
    assert.equal(p.migration_quote_threshold.toString(), '25000000000000');
    const vic = rnd().toBase58();
    w.setRaw(vic, mintData({ decimals: 6, supply: 10n ** 15n }), PROGRAM_IDS.token);
    const cfg = await w.createDbcConfig({}, { quoteMint: vic, params: p });
    await add(cfg, vic);
  });
});
