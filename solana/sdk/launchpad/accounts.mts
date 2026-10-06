// Typed account decoding and fetching for the Vicinity launchpad
// (LAUNCHPAD-DESIGN.md section 5), the Meteora DBC accounts a coin lives in,
// and the SPL / Metaplex / vicinity_rewards accounts around it.
//
// Every decoder takes the raw account bytes and returns plain objects:
// addresses as base58 strings and every amount as a bigint, so nothing is
// rounded through a JavaScript number. Fetchers take a @solana/web3.js
// `Connection` (or anything with the same three methods) and only read.
import web3 from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { IDL, decodeAccount } from './idl.mjs';
import { ADDRESSES, PROGRAM_IDS, pdas, rewardsPdas } from './pda.mjs';

const { PublicKey } = web3;

export type Address = string;
type Bytes = Uint8Array | Buffer;

const big = (x: { toString(): string } | number | bigint): bigint => BigInt(x.toString());
const b58 = (k: { toBase58(): string }): Address => k.toBase58();
const buf = (d: Bytes): Buffer => (Buffer.isBuffer(d) ? d : Buffer.from(d));
const keyAt = (d: Buffer, at: number): Address => new PublicKey(d.subarray(at, at + 32)).toBase58();
const ZERO = PROGRAM_IDS.system as Address;

// ---------------------------------------------------------------- our program's accounts
export interface LaunchpadAccount {
  admin: Address;
  /** zero address (11111111111111111111111111111111) when no transfer is pending */
  pendingAdmin: Address;
  payoutAuthority: Address;
  payoutDestination: Address;
  rewardsProgram: Address;
  launchesPaused: boolean;
  payoutsPaused: boolean;
  /** both payout fields set (opt-in payouts are possible) */
  payoutsConfigured: boolean;
  bump: number;
}
export interface LaunchConfigAccount {
  dbcConfig: Address;
  quoteMint: Address;
  migrationQuoteThreshold: bigint;
  tradeFeeNumerator: bigint;
  poolCreationFee: bigint;
  enabled: boolean;
  addedAt: bigint;
  bump: number;
}
export interface ApprovalAccount {
  cityId: bigint;
  founder: Address;
  dbcConfig: Address;
  rentPayer: Address;
  name: string;
  symbol: string;
  approvedAt: bigint;
  expiresAt: bigint;
  bump: number;
}
export interface CoinAccount {
  /** the Coin PDA itself (["coin", city_id]) */
  address: Address;
  cityId: bigint;
  founder: Address;
  mint: Address;
  quoteMint: Address;
  dbcConfig: Address;
  dbcPool: Address;
  launchedAt: bigint;
  holdersAccrued: bigint;
  holdersForwarded: bigint;
  founderAccrued: bigint;
  founderClaimed: bigint;
  founderPaidOut: bigint;
  payoutSeq: bigint;
  lastPayoutAt: bigint;
  /** derived: the coin's holders pot and founder vault (token accounts of the quote mint) */
  holdersPot: Address;
  founderVault: Address;
}
export interface PayoutOptInAccount {
  coin: Address;
  founder: Address;
  agreedDestination: Address;
  refHash: Uint8Array;
  optedInAt: bigint;
  bump: number;
}

export type LaunchpadAccountKind = 'Launchpad' | 'LaunchConfig' | 'Approval' | 'Coin' | 'PayoutOptIn';

function discriminator(idl: { accounts: { name: string; discriminator: number[] }[] }, name: string): Buffer {
  const a = idl.accounts.find((x) => x.name === name);
  if (!a) throw new Error(`no account ${name} in the IDL`);
  return Buffer.from(a.discriminator);
}
export const DISCRIMINATORS: Readonly<Record<LaunchpadAccountKind, Buffer>> = Object.freeze({
  Launchpad: discriminator(IDL.launchpad, 'Launchpad'),
  LaunchConfig: discriminator(IDL.launchpad, 'LaunchConfig'),
  Approval: discriminator(IDL.launchpad, 'Approval'),
  Coin: discriminator(IDL.launchpad, 'Coin'),
  PayoutOptIn: discriminator(IDL.launchpad, 'PayoutOptIn'),
});

/** Which of our account types these bytes are (by Anchor discriminator), or null. */
export function accountKind(data: Bytes): LaunchpadAccountKind | null {
  const head = buf(data).subarray(0, 8);
  for (const [k, d] of Object.entries(DISCRIMINATORS)) if (head.equals(d)) return k as LaunchpadAccountKind;
  return null;
}

function expectKind(data: Bytes, kind: LaunchpadAccountKind): Buffer {
  const d = buf(data);
  if (!d.subarray(0, 8).equals(DISCRIMINATORS[kind])) throw new Error(`not a ${kind} account (discriminator mismatch)`);
  return d;
}

export function decodeLaunchpad(data: Bytes): LaunchpadAccount {
  const a = decodeAccount(IDL.launchpad, 'Launchpad', expectKind(data, 'Launchpad'));
  const payoutAuthority = b58(a.payout_authority), payoutDestination = b58(a.payout_destination);
  return {
    admin: b58(a.admin), pendingAdmin: b58(a.pending_admin), payoutAuthority, payoutDestination,
    rewardsProgram: b58(a.rewards_program), launchesPaused: a.launches_paused, payoutsPaused: a.payouts_paused,
    payoutsConfigured: payoutAuthority !== ZERO && payoutDestination !== ZERO, bump: a.bump,
  };
}
export function decodeLaunchConfig(data: Bytes): LaunchConfigAccount {
  const a = decodeAccount(IDL.launchpad, 'LaunchConfig', expectKind(data, 'LaunchConfig'));
  return {
    dbcConfig: b58(a.dbc_config), quoteMint: b58(a.quote_mint), migrationQuoteThreshold: big(a.migration_quote_threshold),
    tradeFeeNumerator: big(a.trade_fee_numerator), poolCreationFee: big(a.pool_creation_fee), enabled: a.enabled,
    addedAt: big(a.added_at), bump: a.bump,
  };
}
export function decodeApproval(data: Bytes): ApprovalAccount {
  const a = decodeAccount(IDL.launchpad, 'Approval', expectKind(data, 'Approval'));
  return {
    cityId: big(a.city_id), founder: b58(a.founder), dbcConfig: b58(a.dbc_config), rentPayer: b58(a.rent_payer),
    name: a.name, symbol: a.symbol, approvedAt: big(a.approved_at), expiresAt: big(a.expires_at), bump: a.bump,
  };
}
/** `address` is the Coin PDA; derived from city_id when omitted (default program id). */
export function decodeCoin(data: Bytes, address?: Address, programId: Address = PROGRAM_IDS.launchpad): CoinAccount {
  const a = decodeAccount(IDL.launchpad, 'Coin', expectKind(data, 'Coin'));
  const P = pdas(programId);
  const cityId = big(a.city_id);
  const addr = address ?? P.coin(cityId);
  return {
    address: addr, cityId, founder: b58(a.founder), mint: b58(a.mint), quoteMint: b58(a.quote_mint),
    dbcConfig: b58(a.dbc_config), dbcPool: b58(a.dbc_pool), launchedAt: big(a.launched_at),
    holdersAccrued: big(a.holders_accrued), holdersForwarded: big(a.holders_forwarded), founderAccrued: big(a.founder_accrued),
    founderClaimed: big(a.founder_claimed), founderPaidOut: big(a.founder_paid_out), payoutSeq: big(a.payout_seq),
    lastPayoutAt: big(a.last_payout_at), holdersPot: P.holdersPot(addr), founderVault: P.founderVault(addr),
  };
}
export function decodePayoutOptIn(data: Bytes): PayoutOptInAccount {
  const a = decodeAccount(IDL.launchpad, 'PayoutOptIn', expectKind(data, 'PayoutOptIn'));
  return {
    coin: b58(a.coin), founder: b58(a.founder), agreedDestination: b58(a.agreed_destination),
    refHash: Uint8Array.from(a.ref_hash), optedInAt: big(a.opted_in_at), bump: a.bump,
  };
}

// ---------------------------------------------------------------- Meteora DBC
export interface DbcPool {
  config: Address;
  creator: Address;
  baseMint: Address;
  baseVault: Address;
  quoteVault: Address;
  baseReserve: bigint;
  quoteReserve: bigint;
  sqrtPrice: bigint;
  protocolQuoteFee: bigint;
  partnerQuoteFee: bigint;
  creatorQuoteFee: bigint;
  protocolBaseFee: bigint;
  partnerBaseFee: bigint;
  creatorBaseFee: bigint;
  activationPoint: bigint;
  isMigrated: number;
  /** 0 pre-bonding-curve, 1 post-bonding-curve, 2 locked vesting / ready to migrate, 3 pool created */
  migrationProgress: number;
  isWithdrawLeftover: number;
  isCreatorWithdrawSurplus: number;
  isPartnerWithdrawSurplus: number;
  isProtocolWithdrawSurplus: number;
}
/** The decoded DBC PoolConfig in the shape sdk/launchpad/curve.mjs expects, plus the fields a client shows. */
export interface CurveConfig {
  curve: { sqrtPrice: bigint; liquidity: bigint }[];
  sqrtStartPrice: bigint;
  migrationSqrtPrice: bigint;
  migrationQuoteThreshold: bigint;
  /** flat trade fee, out of 1,000,000,000 (Vicinity configs have no fee scheduler) */
  feeNumerator: bigint;
  creatorTradingFeePercentage: bigint;
  swapBaseAmount: bigint;
  migrationBaseThreshold: bigint;
  quoteMint: Address;
  feeClaimer: Address;
  leftoverReceiver: Address;
  poolCreationFee: bigint;
  tokenDecimal: number;
  migratedPoolFeeBps: number;
}

export function decodeDbcPool(data: Bytes): DbcPool {
  const ps = decodeAccount(IDL.dbc, 'VirtualPool', buf(data)).pool_state;
  return {
    config: b58(ps.config), creator: b58(ps.creator), baseMint: b58(ps.base_mint), baseVault: b58(ps.base_vault),
    quoteVault: b58(ps.quote_vault), baseReserve: big(ps.base_reserve), quoteReserve: big(ps.quote_reserve), sqrtPrice: big(ps.sqrt_price),
    protocolQuoteFee: big(ps.protocol_quote_fee), partnerQuoteFee: big(ps.partner_quote_fee), creatorQuoteFee: big(ps.creator_quote_fee),
    protocolBaseFee: big(ps.protocol_base_fee), partnerBaseFee: big(ps.partner_base_fee), creatorBaseFee: big(ps.creator_base_fee),
    activationPoint: big(ps.activation_point), isMigrated: ps.is_migrated, migrationProgress: ps.migration_progress,
    isWithdrawLeftover: ps.is_withdraw_leftover, isCreatorWithdrawSurplus: ps.is_creator_withdraw_surplus,
    isPartnerWithdrawSurplus: ps.is_partner_withdraw_surplus, isProtocolWithdrawSurplus: ps.is_protocol_withdraw_surplus,
  };
}
export function decodeDbcConfig(data: Bytes): CurveConfig {
  const c = decodeAccount(IDL.dbc, 'PoolConfig', buf(data));
  return {
    curve: c.curve.map((p: { sqrt_price: unknown; liquidity: unknown }) => ({ sqrtPrice: big(p.sqrt_price as bigint), liquidity: big(p.liquidity as bigint) })),
    sqrtStartPrice: big(c.sqrt_start_price), migrationSqrtPrice: big(c.migration_sqrt_price),
    migrationQuoteThreshold: big(c.migration_quote_threshold), feeNumerator: big(c.pool_fees.base_fee.cliff_fee_numerator),
    creatorTradingFeePercentage: BigInt(c.creator_trading_fee_percentage), swapBaseAmount: big(c.swap_base_amount),
    migrationBaseThreshold: big(c.migration_base_threshold), quoteMint: b58(c.quote_mint), feeClaimer: b58(c.fee_claimer),
    leftoverReceiver: b58(c.leftover_receiver), poolCreationFee: big(c.pool_creation_fee), tokenDecimal: c.token_decimal,
    migratedPoolFeeBps: c.migrated_pool_fee_bps,
  };
}

// ---------------------------------------------------------------- SPL, Metaplex, vicinity_rewards
export interface TokenAccount { mint: Address; owner: Address; amount: bigint; delegate: Address | null; state: number; isNative: boolean; closeAuthority: Address | null }
export interface MintAccount { mintAuthority: Address | null; supply: bigint; decimals: number; isInitialized: boolean; freezeAuthority: Address | null }

/** Classic SPL token account (165 bytes; also the base of a Token-2022 account). */
export function decodeTokenAccount(data: Bytes): TokenAccount {
  const d = buf(data);
  if (d.length < 165) throw new Error('not a token account (too short)');
  const opt = (at: number) => (d.readUInt32LE(at) === 1 ? keyAt(d, at + 4) : null);
  return {
    mint: keyAt(d, 0), owner: keyAt(d, 32), amount: d.readBigUInt64LE(64), delegate: opt(72), state: d[108],
    isNative: d.readUInt32LE(109) === 1, closeAuthority: opt(129),
  };
}
export function decodeMint(data: Bytes): MintAccount {
  const d = buf(data);
  if (d.length < 82) throw new Error('not a mint (too short)');
  const opt = (at: number) => (d.readUInt32LE(at) === 1 ? keyAt(d, at + 4) : null);
  return { mintAuthority: opt(0), supply: d.readBigUInt64LE(36), decimals: d[44], isInitialized: d[45] === 1, freezeAuthority: opt(46) };
}

export interface MetaplexMetadata { updateAuthority: Address; mint: Address; name: string; symbol: string; uri: string; sellerFeeBasisPoints: number; creators: number; isMutable: boolean }
/** Metaplex Token Metadata v1 account: the fields wallets and explorers show. */
export function decodeMetaplexMetadata(data: Bytes): MetaplexMetadata {
  const b = buf(data);
  if (b[0] !== 4) throw new Error('not a Metaplex metadata account (key != MetadataV1)');
  let o = 1;
  const updateAuthority = keyAt(b, o); o += 32;
  const mint = keyAt(b, o); o += 32;
  const str = () => { const n = b.readUInt32LE(o); o += 4; const s = b.subarray(o, o + n).toString('utf8').replace(/\0+$/, ''); o += n; return s; };
  const name = str(), symbol = str(), uri = str();
  const sellerFeeBasisPoints = b.readUInt16LE(o); o += 2;
  let creators = 0;
  if (b[o++] === 1) { creators = b.readUInt32LE(o); o += 4 + creators * 34; }
  o += 1; // primary sale happened
  return { updateAuthority, mint, name, symbol, uri, sellerFeeBasisPoints, creators, isMutable: b[o] === 1 };
}

export type RewardModel = 'Creator' | 'Holders' | 'Split';
export interface RewardsCityConfig {
  authority: Address; founder: Address; cityCoinMint: Address; rewardMint: Address; vault: Address;
  rewardModel: RewardModel; founderBps: number; paused: boolean; epochCount: bigint; carryOver: bigint;
  totalFunded: bigint; totalToFounder: bigint; totalToHolders: bigint; totalClaimed: bigint;
}
export function decodeRewardsCityConfig(data: Bytes): RewardsCityConfig {
  const c = decodeAccount(IDL.rewards, 'CityConfig', buf(data));
  const model = Object.keys(c.reward_model)[0];
  const rewardModel = (model.charAt(0).toUpperCase() + model.slice(1)) as RewardModel;
  return {
    authority: b58(c.authority), founder: b58(c.founder), cityCoinMint: b58(c.city_coin_mint), rewardMint: b58(c.reward_mint),
    vault: b58(c.vault), rewardModel, founderBps: c.founder_bps, paused: c.paused, epochCount: big(c.epoch_count),
    carryOver: big(c.carry_over), totalFunded: big(c.total_funded), totalToFounder: big(c.total_to_founder),
    totalToHolders: big(c.total_to_holders), totalClaimed: big(c.total_claimed),
  };
}

// ---------------------------------------------------------------- fetchers
/** The read-only part of a @solana/web3.js Connection this module uses. */
export type ReadConnection = Pick<Connection, 'getAccountInfo' | 'getMultipleAccountsInfo' | 'getProgramAccounts'>;

async function getData(conn: ReadConnection, addr: Address): Promise<Buffer | null> {
  const a = await conn.getAccountInfo(new PublicKey(addr), 'confirmed');
  return a ? Buffer.from(a.data) : null;
}

export async function fetchLaunchpad(conn: ReadConnection, programId: Address = PROGRAM_IDS.launchpad): Promise<LaunchpadAccount | null> {
  const d = await getData(conn, pdas(programId).launchpad());
  return d ? decodeLaunchpad(d) : null;
}
export async function fetchLaunchConfig(conn: ReadConnection, dbcConfig: Address, programId: Address = PROGRAM_IDS.launchpad): Promise<LaunchConfigAccount | null> {
  const d = await getData(conn, pdas(programId).launchConfig(dbcConfig));
  return d ? decodeLaunchConfig(d) : null;
}
export async function fetchApproval(conn: ReadConnection, cityId: bigint | number, programId: Address = PROGRAM_IDS.launchpad): Promise<ApprovalAccount | null> {
  const d = await getData(conn, pdas(programId).approval(cityId));
  return d ? decodeApproval(d) : null;
}
export async function fetchCoin(conn: ReadConnection, cityId: bigint | number, programId: Address = PROGRAM_IDS.launchpad): Promise<CoinAccount | null> {
  const addr = pdas(programId).coin(cityId);
  const d = await getData(conn, addr);
  return d ? decodeCoin(d, addr, programId) : null;
}
export async function fetchPayoutOptIn(conn: ReadConnection, coin: Address, programId: Address = PROGRAM_IDS.launchpad): Promise<PayoutOptInAccount | null> {
  const d = await getData(conn, pdas(programId).payoutOptIn(coin));
  return d ? decodePayoutOptIn(d) : null;
}

/** Offset of `mint` in our Coin account: discriminator 8, city_id 8, founder 32. */
export const COIN_MINT_OFFSET = 48;

/** Every Vicinity coin (the on-chain registry is the only source of truth for "this is a Vicinity coin"). */
export async function listCoins(conn: ReadConnection, programId: Address = PROGRAM_IDS.launchpad): Promise<CoinAccount[]> {
  const res = await conn.getProgramAccounts(new PublicKey(programId), {
    commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: base58Encode(DISCRIMINATORS.Coin) } }],
  });
  return res.map(({ pubkey, account }) => decodeCoin(Buffer.from(account.data), pubkey.toBase58(), programId))
    .sort((a, b) => (a.cityId < b.cityId ? -1 : a.cityId > b.cityId ? 1 : 0));
}
/** The registry record of a coin mint, or null when the mint is not a Vicinity coin (e.g. created around our program). */
export async function fetchCoinByMint(conn: ReadConnection, mint: Address, programId: Address = PROGRAM_IDS.launchpad): Promise<CoinAccount | null> {
  const res = await conn.getProgramAccounts(new PublicKey(programId), {
    commitment: 'confirmed',
    filters: [{ memcmp: { offset: 0, bytes: base58Encode(DISCRIMINATORS.Coin) } }, { memcmp: { offset: COIN_MINT_OFFSET, bytes: new PublicKey(mint).toBase58() } }],
  });
  if (res.length !== 1) return null;
  return decodeCoin(Buffer.from(res[0].account.data), res[0].pubkey.toBase58(), programId);
}

export interface CoinMarket { coin: CoinAccount; pool: DbcPool; config: CurveConfig; complete: boolean; graduated: boolean }
/** A coin with its live DBC pool and config (what a buy/sell panel needs to quote). */
export async function fetchCoinMarket(conn: ReadConnection, coin: CoinAccount): Promise<CoinMarket> {
  const [p, c] = await conn.getMultipleAccountsInfo([new PublicKey(coin.dbcPool), new PublicKey(coin.dbcConfig)], 'confirmed');
  if (!p || !c) throw new Error(`DBC pool or config of ${coin.mint} not found`);
  const pool = decodeDbcPool(Buffer.from(p.data));
  const config = decodeDbcConfig(Buffer.from(c.data));
  return { coin, pool, config, complete: pool.quoteReserve >= config.migrationQuoteThreshold, graduated: pool.isMigrated === 1 };
}

/** The city's vicinity_rewards config and vault for a coin (null when init_city has not run). */
export async function fetchRewards(conn: ReadConnection, coin: Pick<CoinAccount, 'mint'>, rewardsProgram: Address = PROGRAM_IDS.rewards): Promise<{ config: RewardsCityConfig; configAddress: Address; vault: Address; vaultBalance: bigint } | null> {
  const R = rewardsPdas(rewardsProgram);
  const cfgAddr = R.city(coin.mint);
  const vault = R.vault(cfgAddr);
  const [c, v] = await conn.getMultipleAccountsInfo([new PublicKey(cfgAddr), new PublicKey(vault)], 'confirmed');
  if (!c) return null;
  return { config: decodeRewardsCityConfig(Buffer.from(c.data)), configAddress: cfgAddr, vault, vaultBalance: v ? decodeTokenAccount(Buffer.from(v.data)).amount : 0n };
}

/** Token balance of an account, 0 when it does not exist. */
export async function tokenBalance(conn: ReadConnection, account: Address): Promise<bigint> {
  const d = await getData(conn, account);
  return d ? decodeTokenAccount(d).amount : 0n;
}

/** The wallet that receives every platform fee (the program constant FEE_RECIPIENT). */
export const FEE_RECIPIENT: Address = ADDRESSES.feeRecipient;

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Plain base58 (Bitcoin alphabet), as RPC memcmp filters expect. */
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const x of bytes) n = n * 256n + BigInt(x);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const x of bytes) { if (x !== 0) break; s = `1${s}`; }
  return s;
}
