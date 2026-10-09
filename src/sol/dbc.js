/**
 * Account decoders for the accounts a curve trade reads, by the byte offsets generated from the IDLs (src/sol/layout.js):
 * our Coin, Launchpad and LaunchConfig records and Meteora DBC's VirtualPool and PoolConfig. Each decoder checks the owner
 * when given, the Anchor discriminator and the size, and returns plain values: addresses as base58, amounts as BigInt.
 * Anything that does not match answers null ("not that account"), never a guess. Parity with the SDK's anchor-based decoders
 * is proven in solana/tests-launchpad/15-worker-builder.test.mjs; the recorded devnet accounts are decoded in test/lptrade.test.js.
 */
import { base58Encode } from "../solana.js";
import { readI64, readU128, readU16, readU32, readU64 } from "./bytes.js";
import { LAYOUT } from "./layout.js";
import { PROGRAM_IDS } from "./pda.js";

const b64 = (s) => { try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; } };
/** Account bytes from an RPC answer ({ data: [base64, "base64"] } or a Uint8Array) and its owner. */
export function accountBytes(account) {
  if (!account) return null;
  if (account instanceof Uint8Array) return { bytes: account, owner: null };
  const d = account.data;
  const bytes = d instanceof Uint8Array ? d : Array.isArray(d) && d[1] === "base64" && typeof d[0] === "string" ? b64(d[0]) : typeof d === "string" ? b64(d) : null;
  return bytes ? { bytes, owner: account.owner || null } : null;
}
const matches = (bytes, layout) => bytes.length === layout.size && layout.discriminator.every((x, i) => bytes[i] === x);
const key = (bytes, f) => base58Encode(bytes.subarray(f.at, f.at + 32));
const read = (bytes, f) => {
  switch (f.type) {
    case "pubkey": return key(bytes, f);
    case "u64": return readU64(bytes, f.at);
    case "i64": return readI64(bytes, f.at);
    case "u128": return readU128(bytes, f.at);
    case "u16": return readU16(bytes, f.at);
    case "u8": return bytes[f.at];
    case "bool": return bytes[f.at] !== 0;
    default: throw new Error("unsupported_field_" + f.type);
  }
};
function decode(account, layout, owner, pick) {
  const a = accountBytes(account);
  if (!a || (owner && a.owner && a.owner !== owner) || !matches(a.bytes, layout)) return null;
  const F = layout.fields, out = {};
  for (const [name, path] of Object.entries(pick)) out[name] = read(a.bytes, F[path]);
  return out;
}

/** Our Coin record (["coin", city id] under the launchpad program). */
export const decodeCoin = (account, programId) => decode(account, LAYOUT.Coin, programId, {
  cityId: "city_id", founder: "founder", mint: "mint", quoteMint: "quote_mint", dbcConfig: "dbc_config", dbcPool: "dbc_pool", launchedAt: "launched_at",
  holdersAccrued: "holders_accrued", holdersForwarded: "holders_forwarded", founderAccrued: "founder_accrued", founderClaimed: "founder_claimed",
});
/** Our global account (["launchpad"]). */
export const decodeLaunchpad = (account, programId) => decode(account, LAYOUT.Launchpad, programId, {
  admin: "admin", pendingAdmin: "pending_admin", payoutAuthority: "payout_authority", payoutDestination: "payout_destination", rewardsProgram: "rewards_program",
  launchesPaused: "launches_paused", payoutsPaused: "payouts_paused",
});
/** A config's allow-list entry (["launch_config", dbc config]). */
export const decodeLaunchConfig = (account, programId) => decode(account, LAYOUT.LaunchConfig, programId, {
  dbcConfig: "dbc_config", quoteMint: "quote_mint", migrationQuoteThreshold: "migration_quote_threshold", tradeFeeNumerator: "trade_fee_numerator",
  poolCreationFee: "pool_creation_fee", enabled: "enabled", addedAt: "added_at",
});
/** Meteora's VirtualPool (the curve of one coin). isMigrated 1 = graduated into the DAMM v2 pool. */
export const decodePool = (account) => decode(account, LAYOUT.VirtualPool, PROGRAM_IDS.dbc, {
  config: "config", creator: "creator", baseMint: "base_mint", baseVault: "base_vault", quoteVault: "quote_vault",
  baseReserve: "base_reserve", quoteReserve: "quote_reserve", sqrtPrice: "sqrt_price", isMigrated: "is_migrated", migrationProgress: "migration_progress",
  protocolQuoteFee: "protocol_quote_fee", partnerQuoteFee: "partner_quote_fee", creatorQuoteFee: "creator_quote_fee", poolType: "pool_type",
});
/** Meteora's PoolConfig in the shape solana/sdk/launchpad/curve.mjs quotes with (curve[20] as BigInt pairs) plus what the page shows. */
export function decodeConfig(account) {
  const a = accountBytes(account);
  if (!a || (a.owner && a.owner !== PROGRAM_IDS.dbc) || !matches(a.bytes, LAYOUT.PoolConfig)) return null;
  const F = LAYOUT.PoolConfig.fields, r = (p) => read(a.bytes, F[p]);
  const curve = [];
  for (let i = 0; i < F.curve.count; i++) curve.push({ sqrtPrice: r(`curve[${i}].sqrt_price`), liquidity: r(`curve[${i}].liquidity`) });
  return {
    quoteMint: r("quote_mint"), feeClaimer: r("fee_claimer"), leftoverReceiver: r("leftover_receiver"),
    feeNumerator: r("pool_fees.base_fee.cliff_fee_numerator"), baseFeeMode: r("pool_fees.base_fee.base_fee_mode"), dynamicFeeOn: r("pool_fees.dynamic_fee.initialized"),
    creatorTradingFeePercentage: BigInt(r("creator_trading_fee_percentage")), collectFeeMode: r("collect_fee_mode"), tokenDecimal: r("token_decimal"),
    swapBaseAmount: r("swap_base_amount"), migrationQuoteThreshold: r("migration_quote_threshold"), migrationBaseThreshold: r("migration_base_threshold"),
    migrationSqrtPrice: r("migration_sqrt_price"), sqrtStartPrice: r("sqrt_start_price"), curve, poolCreationFee: r("pool_creation_fee"),
    migratedPoolFeeBps: r("migrated_pool_fee_bps"), tokenType: r("token_type"), quoteTokenFlag: r("quote_token_flag"),
  };
}
/** The on-chain AddressLookupTable account: its addresses (56-byte header, then 32 bytes each). null when it is not one. */
export function decodeLookupTable(account) {
  const a = accountBytes(account);
  if (!a || (a.owner && a.owner !== PROGRAM_IDS.lookupTable) || a.bytes.length < 56 || (a.bytes.length - 56) % 32 !== 0) return null;
  if (a.bytes[0] !== 1 || a.bytes[1] !== 0 || a.bytes[2] !== 0 || a.bytes[3] !== 0) return null; // ProgramState::LookupTable = 1 (u32 LE)
  const deactivationSlot = readU64(a.bytes, 4);
  const addresses = [];
  for (let at = 56; at < a.bytes.length; at += 32) addresses.push(base58Encode(a.bytes.subarray(at, at + 32)));
  return { deactivationSlot, addresses };
}
/** A plain SPL token account's amount and owner (165 bytes), or null. */
export function decodeTokenAccount(account) {
  const a = accountBytes(account);
  if (!a || a.bytes.length < 165) return null;
  return { mint: base58Encode(a.bytes.subarray(0, 32)), owner: base58Encode(a.bytes.subarray(32, 64)), amount: readU64(a.bytes, 64) };
}
/**
 * The upgradeable loader's accounts (what `solana program show` reads): a Program account (36 bytes: state 2, then the
 * ProgramData address) and a ProgramData account (state 3, the last deploy slot, Option<upgrade authority>, then the ELF).
 * Only the first 45 bytes of ProgramData matter here, so a caller may fetch them with dataSlice. null when it is not that account.
 */
export function decodeProgramAccount(account) {
  const a = accountBytes(account);
  if (!a || (a.owner && a.owner !== PROGRAM_IDS.upgradeableLoader) || a.bytes.length !== 36 || readU32(a.bytes, 0) !== 2) return null;
  return { programData: base58Encode(a.bytes.subarray(4, 36)) };
}
export function decodeProgramData(account) {
  const a = accountBytes(account);
  if (!a || (a.owner && a.owner !== PROGRAM_IDS.upgradeableLoader) || a.bytes.length < 13 || readU32(a.bytes, 0) !== 3) return null;
  const hasAuthority = a.bytes[12] === 1;
  if (hasAuthority && a.bytes.length < 45) return null;
  return { slot: readU64(a.bytes, 4), upgradeAuthority: hasAuthority ? base58Encode(a.bytes.subarray(13, 45)) : null };
}
/** The name of a DBC error code, or null. */
export const dbcErrorName = (code) => LAYOUT.dbcErrors[String(code)] || null;
export const launchpadErrorName = (code) => LAYOUT.launchpadErrors[String(code)] || null;
export const PROGRAM_CONSTANTS = LAYOUT.constants;
