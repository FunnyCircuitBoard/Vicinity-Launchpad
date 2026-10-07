// The Vicinity Meteora DBC config (LAUNCHPAD-DESIGN.md section 7.1).
//
// The curve is built with Meteora's own helper `buildCurve` (npm
// @meteora-ag/dynamic-bonding-curve-sdk 1.5.13, the package our IDLs come
// from): percentageSupplyOnMigration = 20.69 gives the pump.fun shape (793.1M
// coins sold on the curve, 206.9M kept for the pool). Every other field is the
// Vicinity policy our program enforces (programs/vicinity-launchpad/src/validate.rs).
import { createRequire } from 'node:module';
import anchor from '@coral-xyz/anchor';
import { buildIx, IDL } from './idl.mjs';
import { ADDRESSES, dbc } from './pda.mjs';

const require = createRequire(import.meta.url);
const { buildCurve } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { BN } = anchor;

/** Mainnet default: SOL quote, 85 SOL target, 1.25% flat fee, 0.05 SOL launch fee. */
export const VICINITY_DEFAULTS = Object.freeze({
  quoteDecimals: 9,
  migrationQuoteThreshold: 85,
  tradeFeeBps: 125,
  migratedPoolFeeBps: 125,
  poolCreationFeeSol: 0.05,
  percentageSupplyOnMigration: 20.69,
  totalTokenSupply: 1_000_000_000,
  tokenDecimals: 6,
});

const camelToSnake = (s) => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
function toSnake(v) {
  if (Array.isArray(v)) return v.map(toSnake);
  if (v && typeof v === 'object' && !(v instanceof BN) && v.constructor === Object) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [camelToSnake(k), toSnake(x)]));
  }
  return v;
}

/**
 * `create_config` parameters in the IDL's snake_case shape (BN for integers).
 * Options override VICINITY_DEFAULTS (for example a devnet demo target, or a
 * VICINITY-priced config with quoteDecimals 6).
 */
export function vicinityConfigParams(opts = {}) {
  const o = { ...VICINITY_DEFAULTS, ...opts };
  const p = buildCurve({
    token: {
      tokenType: 0,
      tokenBaseDecimal: o.tokenDecimals,
      tokenQuoteDecimal: o.quoteDecimals,
      tokenAuthorityOption: 1, // immutable metadata
      totalTokenSupply: o.totalTokenSupply,
      // whole coins neither sold on the curve nor kept for the pool; DBC sends
      // them to the dev wallet, so our rule 7.2(13) refuses more than 1,000
      leftover: o.leftover ?? 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: 0,
        feeSchedulerParam: { startingFeeBps: o.tradeFeeBps, endingFeeBps: o.tradeFeeBps, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: 0, // fees in the quote token
      creatorTradingFeePercentage: 50, // the city's half
      poolCreationFee: o.poolCreationFeeSol,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: 1, // DAMM v2
      migrationFeeOption: 6, // customizable pool
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: o.migratedPoolFeeBps },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: 1, // timestamp
    percentageSupplyOnMigration: o.percentageSupplyOnMigration,
    migrationQuoteThreshold: o.migrationQuoteThreshold,
  });
  const s = toSnake(p);
  s.padding = [0, 0];
  return s;
}

/** DBC `create_config`. `config` must sign (a fresh keypair); only the payer pays. */
export function createConfigIx({ config, quoteMint, payer, params, feeClaimer = ADDRESSES.feeRecipient, leftoverReceiver = ADDRESSES.feeRecipient }) {
  return buildIx(IDL.dbc, 'create_config', { config_parameters: params }, {
    config, fee_claimer: feeClaimer, leftover_receiver: leftoverReceiver, quote_mint: quoteMint, payer,
    event_authority: dbc.eventAuthority(), program: IDL.dbc.address,
  });
}
