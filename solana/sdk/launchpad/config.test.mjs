// SDK tests for config.mjs and pda.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import { vicinityConfigParams, VICINITY_DEFAULTS } from './config.mjs';
import { IDL, buildIx, constant } from './idl.mjs';
import { pdas, PROGRAM_IDS, ADDRESSES, rewardsPdas } from './pda.mjs';

test('the default Vicinity config (LAUNCHPAD-DESIGN.md 7.1)', () => {
  const p = vicinityConfigParams();
  assert.equal(VICINITY_DEFAULTS.migrationQuoteThreshold, 85);
  assert.equal(p.migration_quote_threshold.toString(), '85000000000');
  assert.equal(p.pool_fees.base_fee.cliff_fee_numerator.toString(), '12500000');
  assert.equal(p.pool_fees.base_fee.first_factor, 0);
  assert.equal(p.pool_fees.dynamic_fee, null);
  assert.equal(p.collect_fee_mode, 0);
  assert.equal(p.migration_option, 1);
  assert.equal(p.migration_fee_option, 6);
  assert.equal(p.token_type, 0);
  assert.equal(p.token_decimal, 6);
  assert.equal(p.token_update_authority, 1);
  assert.equal(p.creator_trading_fee_percentage, 50);
  assert.equal(p.partner_permanent_locked_liquidity_percentage, 50);
  assert.equal(p.creator_permanent_locked_liquidity_percentage, 50);
  assert.equal(p.partner_liquidity_percentage + p.creator_liquidity_percentage, 0);
  assert.equal(p.migration_fee.fee_percentage + p.migration_fee.creator_fee_percentage, 0);
  assert.deepEqual([p.migrated_pool_fee.collect_fee_mode, p.migrated_pool_fee.dynamic_fee, p.migrated_pool_fee.pool_fee_bps], [0, 0, 125]);
  assert.equal(p.migrated_pool_base_fee_mode, 0);
  assert.equal(p.compounding_fee_bps, 0);
  assert.equal(p.token_supply.pre_migration_token_supply.toString(), '1000000000000000');
  assert.equal(p.token_supply.post_migration_token_supply.toString(), '1000000000000000');
  assert.equal(p.pool_creation_fee.toString(), '50000000');
  assert.equal(p.enable_first_swap_with_min_fee, false);
  assert.equal(p.sqrt_start_price.toString(), '97539716077334678');
  assert.equal(p.curve[0].sqrt_price.toString(), '373894382314756693');
  assert.equal(p.curve[0].liquidity.toString(), '104662611932995410955326609817160');
  // it encodes as DBC create_config arguments
  const ix = buildIx(IDL.dbc, 'create_config', { config_parameters: p }, {
    config: ADDRESSES.wsol, fee_claimer: ADDRESSES.feeRecipient, leftover_receiver: ADDRESSES.feeRecipient, quote_mint: ADDRESSES.wsol,
    payer: ADDRESSES.wsol, event_authority: ADDRESSES.wsol, program: PROGRAM_IDS.dbc,
  });
  assert.equal(ix.data.length, 259); // 8-byte discriminator + borsh ConfigParameters with a two-point curve
});

test('PDA seeds match the program (the IDL records the constant seeds)', () => {
  const P = pdas();
  const seedsOf = (ix, acct) => IDL.launchpad.instructions.find((i) => i.name === ix).accounts.find((a) => a.name === acct).pda.seeds;
  const constSeed = (ix, acct) => Buffer.from(seedsOf(ix, acct)[0].value).toString();
  assert.equal(constSeed('init_launchpad', 'launchpad'), 'launchpad');
  assert.equal(constSeed('add_launch_config', 'launch_config'), 'launch_config');
  assert.equal(constSeed('approve_launch', 'approval'), 'approval');
  assert.equal(constSeed('launch', 'coin'), 'coin');
  assert.equal(constSeed('launch', 'holders_pot'), 'holders_pot');
  assert.equal(constSeed('launch', 'founder_vault'), 'founder_vault');
  assert.equal(constSeed('opt_in_payout', 'opt_in'), 'payout_opt_in');
  const u = Buffer.alloc(8); u.writeBigUInt64LE(5128581n);
  assert.equal(P.coin(5128581n), web3.PublicKey.findProgramAddressSync([Buffer.from('coin'), u], new web3.PublicKey(PROGRAM_IDS.launchpad))[0].toBase58());
  assert.equal(IDL.launchpad.address, PROGRAM_IDS.launchpad);
  assert.equal(IDL.rewards.address, PROGRAM_IDS.rewards);
  assert.equal(constant(IDL.launchpad, 'FEE_RECIPIENT'), ADDRESSES.feeRecipient);
  const R = rewardsPdas();
  assert.equal(R.vault(R.city(ADDRESSES.wsol)).length > 30, true);
});

test('buildIx refuses a missing argument instead of encoding zero', () => {
  assert.throws(() => buildIx(IDL.launchpad, 'approve_launch', { cityId: 1 }, {}), /missing argument city_id/);
});
