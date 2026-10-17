// Fixed-offset decoders of the six vicinity_curve accounts (VICINITY-CURVE-DESIGN.md
// 3.4 to 3.9) and of the vicinity_rewards CityConfig fields the program reads
// (4.15). No Anchor, no IDL: every field is read at its offset.
//
// Every decoder checks the account's owner (the vicinity_curve program id) as
// well as its length and discriminator: `Launchpad`, `Approval` and
// `PayoutOptIn` share their discriminators with the old vicinity_launchpad's
// accounts, so bytes alone do not identify them (3.7, SEC-8). `CurveCoin`
// additionally requires `layout_version == 1` and a phase of 0 or 1 (5.16,
// NOTES entry 7).
//
// Input: `{ owner, data }` (owner as base58, @solana/kit address or PublicKey;
// data as Uint8Array or Buffer), as RPC and litesvm return them. Integers are
// BigInt except phase, bumps, versions and config ids (numbers); keys are base58.
import web3 from '@solana/web3.js';
import {
  ACCOUNT_DISCRIMINATORS, ACCOUNT_LEN, ADDRESSES, CURVE_PROGRAM_ID, REWARDS_CITY_CONFIG_DISCRIMINATOR, REWARDS_MODEL_HOLDERS,
} from './constants.mjs';
import { clusterIds } from './pda.mjs';

const { PublicKey } = web3;

export class DecodeError extends Error {
  constructor(code, detail = '') {
    super(`DecodeError::${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'DecodeError';
    this.code = code;
  }
}

class Reader {
  constructor(data) {
    this.b = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
  }
  need(at, n) { if (at + n > this.b.length) throw new DecodeError('WrongLength', `read ${n} at ${at} of ${this.b.length}`); }
  u8(at) { this.need(at, 1); return this.b[at]; }
  bool(at) {
    const x = this.u8(at);
    if (x > 1) throw new DecodeError('InvalidBool', `byte ${at} is ${x}`);
    return x === 1;
  }
  u16(at) { this.need(at, 2); return this.v.getUint16(at, true); }
  u32(at) { this.need(at, 4); return this.v.getUint32(at, true); }
  u64(at) { this.need(at, 8); return this.v.getBigUint64(at, true); }
  i64(at) { this.need(at, 8); return this.v.getBigInt64(at, true); }
  u128(at) { return this.u64(at) + (this.u64(at + 8) << 64n); }
  key(at) { this.need(at, 32); return new PublicKey(this.b.subarray(at, at + 32)).toBase58(); }
  bytes(at, n) { this.need(at, n); return Uint8Array.from(this.b.subarray(at, at + n)); }
  /** Borsh string at `at`: `[value, next offset]`. */
  string(at, max) {
    const n = this.u32(at);
    if (n > max) throw new DecodeError('BadString', `length ${n} above ${max}`);
    this.need(at + 4, n);
    let s;
    try { s = new TextDecoder('utf-8', { fatal: true }).decode(this.b.subarray(at + 4, at + 4 + n)); } catch { throw new DecodeError('BadString', 'not UTF-8'); }
    return [s, at + 4 + n];
  }
}

/** The owner of an account snapshot as base58 (`owner` as a string or PublicKey, or kit's `programAddress`). */
export const ownerOf = (a) => (a.owner instanceof PublicKey ? a.owner.toBase58() : String(a.owner ?? a.programAddress));
function open(account, name, { programId = CURVE_PROGRAM_ID, exactLength = true } = {}) {
  if (!account) throw new DecodeError('Missing', name);
  if (ownerOf(account) !== String(programId)) throw new DecodeError('WrongOwner', `${name} owned by ${ownerOf(account)}`);
  const r = new Reader(account.data);
  const len = ACCOUNT_LEN[name];
  if (exactLength ? r.b.length !== len : r.b.length < 8) throw new DecodeError('WrongLength', `${name}: ${r.b.length} bytes, expected ${len}`);
  const disc = ACCOUNT_DISCRIMINATORS[name];
  for (let i = 0; i < 8; i++) if (r.b[i] !== disc[i]) throw new DecodeError('WrongDiscriminator', name);
  return r;
}

/** `Launchpad` (3.4; 238 bytes). */
export function decodeLaunchpad(account, opts) {
  const r = open(account, 'Launchpad', opts);
  return {
    admin: r.key(8), pendingAdmin: r.key(40), payoutAuthority: r.key(72), payoutDestination: r.key(104), guardian: r.key(136),
    launchesPaused: r.bool(168), payoutsPaused: r.bool(169), buysHalted: r.bool(170), nextConfigId: r.u16(171), bump: r.u8(173),
    buybacksHalted: r.bool(174),
  };
}

/** `LaunchConfig` (3.5; 144 bytes). */
export function decodeLaunchConfig(account, opts) {
  const r = open(account, 'LaunchConfig', opts);
  return {
    configId: r.u16(8), enabled: r.bool(10), bump: r.u8(11),
    liquidityBps: BigInt(r.u16(12)), platformBps: BigInt(r.u16(14)), founderBps: BigInt(r.u16(16)), holdersBps: BigInt(r.u16(18)),
    buybackBps: BigInt(r.u16(20)), totalFeeBps: BigInt(r.u16(22)),
    virtualSol: r.u64(24), virtualTokens: r.u64(32), curveSupply: r.u64(40), poolSupply: r.u64(48), graduationSol: r.u64(56),
    launchFeeLamports: r.u64(64), createdAt: r.i64(72),
  };
}
/** The `ConfigParams` of a decoded config (what validate_config checks). */
export const configParamsOf = (c) => ({
  liquidityBps: c.liquidityBps, platformBps: c.platformBps, founderBps: c.founderBps, holdersBps: c.holdersBps, buybackBps: c.buybackBps,
  virtualSol: c.virtualSol, virtualTokens: c.virtualTokens, curveSupply: c.curveSupply, poolSupply: c.poolSupply,
  graduationSol: c.graduationSol, launchFeeLamports: c.launchFeeLamports,
});

/** `Approval` (3.6; allocated at its maximum of 181 bytes, Borsh strings inside). */
export function decodeApproval(account, opts) {
  const r = open(account, 'Approval', opts);
  const [name, at1] = r.string(114, 32);
  const [symbol, at2] = r.string(at1, 10);
  return {
    cityId: r.u64(8), founder: r.key(16), configId: r.u16(48), rentPayer: r.key(50), metaHash: r.bytes(82, 32),
    name, symbol, approvedAt: r.i64(at2), expiresAt: r.i64(at2 + 8), bump: r.u8(at2 + 16),
  };
}

/** Byte offsets of the `Coin` (`CurveCoin`) fields (3.7). */
export const COIN_OFFSETS = Object.freeze({
  layoutVersion: 8, phase: 9, bump: 10, mintBump: 11, vaultBump: 12, configId: 13, cityId: 15, mint: 23, vault: 55, founder: 87,
  symbol: 119, liquidityBps: 129, platformBps: 131, founderBps: 133, holdersBps: 135, buybackBps: 137, totalFeeBps: 139,
  virtualSol: 141, virtualTokens: 149, curveSupply: 157, poolSupply: 165, graduationSol: 173, dustBurned: 181, tokensSold: 189,
  curveSol: 197, poolSol: 205, poolTokens: 213, liquidityPending: 221, platformPending: 229, founderPending: 237,
  holdersPending: 245, buybackPending: 253, launchedAt: 261, launchSlot: 269, graduatedAt: 277, graduationSlot: 285,
  lastBuybackSlot: 293, lastPayoutAt: 301, payoutSeq: 309, tradeSeq: 317, buybackCount: 325, tokensBurned: 333,
  buyVolume: 341, sellVolume: 357, feesTotal: 373, liquidityEarned: 389, liquidityAdded: 405, platformEarned: 421,
  platformWithdrawn: 437, founderEarned: 453, founderClaimed: 469, founderPaidOut: 485, holdersEarned: 501,
  holdersForwarded: 517, buybackEarned: 533, buybackSpent: 549, metaHash: 565, rentReserve: 597, reserved: 605,
});

/** `Coin` (`CurveCoin`, 3.7; 693 bytes): every field at its fixed offset. */
export function decodeCurveCoin(account, opts) {
  const r = open(account, 'CurveCoin', opts);
  const o = COIN_OFFSETS;
  const layoutVersion = r.u8(o.layoutVersion);
  if (layoutVersion !== 1) throw new DecodeError('WrongLayoutVersion', String(layoutVersion));
  const phase = r.u8(o.phase);
  if (phase !== 0 && phase !== 1) throw new DecodeError('InvalidPhase', String(phase));
  const symbolBytes = r.bytes(o.symbol, 10);
  const end = symbolBytes.indexOf(0);
  const out = {
    layoutVersion, phase, bump: r.u8(o.bump), mintBump: r.u8(o.mintBump), vaultBump: r.u8(o.vaultBump), configId: r.u16(o.configId),
    cityId: r.u64(o.cityId), mint: r.key(o.mint), vault: r.key(o.vault), founder: r.key(o.founder),
    symbol: new TextDecoder().decode(end === -1 ? symbolBytes : symbolBytes.subarray(0, end)), symbolBytes,
    metaHash: r.bytes(o.metaHash, 32),
  };
  for (const k of ['liquidityBps', 'platformBps', 'founderBps', 'holdersBps', 'buybackBps', 'totalFeeBps']) out[k] = BigInt(r.u16(o[k]));
  for (const k of ['virtualSol', 'virtualTokens', 'curveSupply', 'poolSupply', 'graduationSol', 'dustBurned', 'tokensSold', 'curveSol',
    'poolSol', 'poolTokens', 'liquidityPending', 'platformPending', 'founderPending', 'holdersPending', 'buybackPending', 'launchSlot',
    'graduationSlot', 'lastBuybackSlot', 'payoutSeq', 'tradeSeq', 'buybackCount', 'tokensBurned', 'rentReserve']) out[k] = r.u64(o[k]);
  for (const k of ['launchedAt', 'graduatedAt', 'lastPayoutAt']) out[k] = r.i64(o[k]);
  for (const k of ['buyVolume', 'sellVolume', 'feesTotal', 'liquidityEarned', 'liquidityAdded', 'platformEarned', 'platformWithdrawn',
    'founderEarned', 'founderClaimed', 'founderPaidOut', 'holdersEarned', 'holdersForwarded', 'buybackEarned', 'buybackSpent']) out[k] = r.u128(o[k]);
  return out;
}
/** The frozen terms of a decoded coin, for the quote functions of math.mjs. */
export const coinTerms = (c) => ({
  liquidityBps: c.liquidityBps, platformBps: c.platformBps, founderBps: c.founderBps, holdersBps: c.holdersBps, buybackBps: c.buybackBps,
  totalFeeBps: c.totalFeeBps, virtualSol: c.virtualSol, virtualTokens: c.virtualTokens, curveSupply: c.curveSupply,
  poolSupply: c.poolSupply, graduationSol: c.graduationSol,
});
/** The trade state of a decoded coin, for the quote functions of math.mjs. */
export const coinState = (c) => ({
  phase: c.phase, tokensSold: c.tokensSold, curveSol: c.curveSol, poolSol: c.poolSol, poolTokens: c.poolTokens,
  liquidityPending: c.liquidityPending, platformPending: c.platformPending, founderPending: c.founderPending,
  holdersPending: c.holdersPending, buybackPending: c.buybackPending, lastBuybackSlot: c.lastBuybackSlot, tradeSeq: c.tradeSeq,
  buybackCount: c.buybackCount, tokensBurned: c.tokensBurned, buyVolume: c.buyVolume, sellVolume: c.sellVolume,
  feesTotal: c.feesTotal, liquidityEarned: c.liquidityEarned, liquidityAdded: c.liquidityAdded, platformEarned: c.platformEarned,
  founderEarned: c.founderEarned, holdersEarned: c.holdersEarned, buybackEarned: c.buybackEarned, buybackSpent: c.buybackSpent,
});

/** `TickerLock` (3.8; 49 bytes). */
export function decodeTickerLock(account, opts) {
  const r = open(account, 'TickerLock', opts);
  return { cityId: r.u64(8), mint: r.key(16), bump: r.u8(48) };
}

/** `PayoutOptIn` (3.9; 145 bytes). */
export function decodePayoutOptIn(account, opts) {
  const r = open(account, 'PayoutOptIn', opts);
  return { coin: r.key(8), founder: r.key(40), agreedDestination: r.key(72), refHash: r.bytes(104, 32), optedInAt: r.i64(136), bump: r.u8(144) };
}

const DECODERS = {
  Launchpad: decodeLaunchpad, LaunchConfig: decodeLaunchConfig, Approval: decodeApproval, CurveCoin: decodeCurveCoin,
  TickerLock: decodeTickerLock, PayoutOptIn: decodePayoutOptIn,
};
/** The account type of a vicinity_curve account by owner and discriminator, or null. */
export function accountType(account, { programId = CURVE_PROGRAM_ID } = {}) {
  if (!account || ownerOf(account) !== String(programId)) return null;
  const d = account.data instanceof Uint8Array ? account.data : new Uint8Array(account.data);
  for (const [name, disc] of Object.entries(ACCOUNT_DISCRIMINATORS)) {
    if (d.length >= 8 && disc.every((x, i) => d[i] === x)) return name;
  }
  return null;
}
/** Decode any vicinity_curve account: `{ type, ...fields }`. */
export function decodeAny(account, opts) {
  const type = accountType(account, opts);
  if (!type) throw new DecodeError('UnknownAccount');
  return { type, ...DECODERS[type](account, opts) };
}

/**
 * The vicinity_rewards `CityConfig` fields `forward_holders_fees` reads (4.15),
 * read exactly as the program's `read_rewards_city_config` does: owner the
 * cluster's rewards program, at least 203 bytes, the CityConfig discriminator.
 */
export function decodeRewardsCityConfig(account, { cluster = 'mainnet' } = {}) {
  const ids = clusterIds(cluster);
  if (!account) throw new DecodeError('Missing', 'CityConfig');
  if (ownerOf(account) !== ids.rewardsProgram) throw new DecodeError('WrongOwner', `CityConfig owned by ${ownerOf(account)}`);
  const r = new Reader(account.data);
  if (r.b.length < 203) throw new DecodeError('WrongLength', `CityConfig: ${r.b.length} bytes`);
  for (let i = 0; i < 8; i++) if (r.b[i] !== REWARDS_CITY_CONFIG_DISCRIMINATOR[i]) throw new DecodeError('WrongDiscriminator', 'CityConfig');
  return {
    authority: r.key(8), pendingAuthority: r.key(40), founder: r.key(72), cityCoinMint: r.key(104), rewardMint: r.key(136),
    vault: r.key(168), rewardModel: r.u8(200), founderBps: r.u16(201),
  };
}
/**
 * The program's two rules for the holders' destination (4.15:
 * check_rewards_config and the authority rule): `[]` when forward_holders_fees
 * would accept this config, otherwise the list of reasons.
 */
export function rewardsConfigProblems(view, { mint, vault, admin }) {
  const zero = ADDRESSES.system;
  const out = [];
  if (view.cityCoinMint !== String(mint)) out.push('city_coin_mint is not this coin');
  if (view.rewardModel !== REWARDS_MODEL_HOLDERS) out.push('model is not Holders');
  if (view.founderBps !== 0) out.push('founder_bps is not 0');
  if (view.rewardMint !== ADDRESSES.nativeMint) out.push('reward mint is not WSOL');
  if (view.vault !== String(vault)) out.push('vault is not the derived vault');
  if (view.authority !== String(admin)) out.push('authority is not the vicinity_curve admin');
  if (view.pendingAuthority !== zero) out.push('an authority transfer is pending');
  return out;
}
