// The dev wallet collects its platform fees (LAUNCHPAD-DESIGN.md 11.3).
//
// Every platform fee is earmarked on chain for the dev wallet (13qRam…, the
// Meteora config's fee_claimer) and waits in Meteora's accounts until the dev
// wallet signs a claim. Nobody else can claim it. This module finds what is
// waiting, in every DBC pool under every Vicinity config (including coins
// that strangers created around our program under our config: their fees are
// the dev wallet's too), and builds the claims as instruction lists packed into
// transactions under 1,232 bytes, for the dev wallet to sign:
//   * claim_trading_fee                 the 0.5% partner share of curve trades
//   * claim_partner_pool_creation_fee   90% of each launch fee
//   * partner_withdraw_surplus          its share of a completed curve's rounding surplus
//   * DAMM v2 claim_position_fee        half of the pool fees after graduation
// It reads only; scripts/launchpad/claim-platform-fees.mjs writes the unsigned
// transactions for a signing page (or signs on the owner's own machine).
import web3 from '@solana/web3.js';
import { IDL, decodeAccount } from './idl.mjs';
import { ADDRESSES, PROGRAM_IDS, ata } from './pda.mjs';
import * as C from './client.mjs';
import { surplusShares } from './curve.mjs';
import { findCityPositions } from './keeper.mjs';
import { createAta, measure, MAX_TX_BYTES } from './trade.mts';
import type { Ix } from './trade.mts';
import { DISCRIMINATORS, decodeLaunchConfig, decodeDbcPool, decodeDbcConfig } from './accounts.mts';
import type { Address } from './accounts.mts';

/** The keeper's reader interface (keeper.mjs connectionReader, or the test VM's). */
export interface Reader {
  getProgramAccounts(programId: Address, opts?: { memcmp?: { offset: number; bytes: string | Uint8Array }[]; dataSize?: number }): Promise<{ address: Address; owner: Address; lamports: bigint; data: Buffer }[]>;
  getMultipleAccounts(addresses: Address[]): Promise<({ address: Address; owner: Address; lamports: bigint; data: Buffer } | null)[]>;
}
/** `amount` is what is waiting (0 for a DAMM v2 position: its fees are only known when claimed); `unit` says in what. */
export interface PlatformClaim { kind: 'tradingFee' | 'poolCreationFee' | 'surplus' | 'poolPositionFee'; pool: Address; mint: Address; quoteMint: Address; amount: bigint; unit: 'quote' | 'lamports'; instructions: Ix[]; cu: number }
export interface PlatformFeePlan {
  claims: PlatformClaim[];
  transactions: { label: string; instructions: Ix[]; cuLimit: number; bytes: number }[];
  totals: { quoteByMint: Record<string, string>; lamports: string };
}

const PRIM: Record<string, number> = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };
type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } };
function typeSize(ty: IdlType): number {
  if (typeof ty === 'string') return PRIM[ty];
  if ('array' in ty) return typeSize(ty.array[0]) * ty.array[1];
  const def = (IDL.dbc.types as { name: string; type: { fields: { type: IdlType }[] } }[]).find((x) => x.name === ty.defined.name);
  if (!def) throw new Error(`no type ${ty.defined.name}`);
  return def.type.fields.reduce((s, f) => s + typeSize(f.type), 0);
}
/** Byte offset of `config` in a DBC VirtualPool (discriminator + VolatilityTracker), from the IDL. */
export const DBC_POOL_CONFIG_OFFSET = 8 + typeSize({ defined: { name: 'VolatilityTracker' } });
const VIRTUAL_POOL_DISCRIMINATOR = Buffer.from((IDL.dbc.accounts as { name: string; discriminator: number[] }[]).find((x) => x.name === 'VirtualPool')!.discriminator);
const PARTNER_CREATION_FEE_CLAIMED = 0b10; // DBC state/virtual_pool.rs PARTNER_CREATION_FEE_CLAIMED_MASK
const CU = { tradingFee: 60_000, poolCreationFee: 25_000, surplus: 40_000, poolPositionFee: 70_000, perTx: 1_400_000 };

export async function planPlatformFeeClaims(reader: Reader, { feeRecipient = ADDRESSES.feeRecipient, launchpadProgram = PROGRAM_IDS.launchpad, maxBytes = MAX_TX_BYTES }: { feeRecipient?: Address; launchpadProgram?: Address; maxBytes?: number } = {}): Promise<PlatformFeePlan> {
  const configs = (await reader.getProgramAccounts(launchpadProgram, { memcmp: [{ offset: 0, bytes: DISCRIMINATORS.LaunchConfig }] }))
    .map((a) => decodeLaunchConfig(a.data));
  const claims: PlatformClaim[] = [];
  for (const lc of configs) {
    const [cfgAcc] = await reader.getMultipleAccounts([lc.dbcConfig]);
    if (!cfgAcc) continue;
    const cfg = decodeDbcConfig(cfgAcc.data);
    const rawCfg = decodeAccount(IDL.dbc, 'PoolConfig', cfgAcc.data);
    const creationFee = BigInt(rawCfg.pool_creation_fee.toString());
    const pools = await reader.getProgramAccounts(PROGRAM_IDS.dbc, { memcmp: [{ offset: 0, bytes: VIRTUAL_POOL_DISCRIMINATOR }, { offset: DBC_POOL_CONFIG_OFFSET, bytes: new web3.PublicKey(lc.dbcConfig).toBytes() }] });
    for (const pa of pools) {
      const p = decodeDbcPool(pa.data);
      const raw = decodeAccount(IDL.dbc, 'VirtualPool', pa.data).pool_state;
      const mint = p.baseMint, quote = cfg.quoteMint;
      const accounts = [createAta(feeRecipient, feeRecipient, mint), createAta(feeRecipient, feeRecipient, quote)];
      if (p.partnerQuoteFee > 0n || p.partnerBaseFee > 0n) {
        claims.push({ kind: 'tradingFee', pool: pa.address, mint, quoteMint: quote, amount: p.partnerQuoteFee, unit: 'quote', cu: CU.tradingFee, instructions: [...accounts, C.claimPartnerTradingFee({ feeClaimer: feeRecipient, dbcPool: pa.address, dbcConfig: lc.dbcConfig, coinMint: mint, quoteMint: quote, baseAccount: ata(feeRecipient, mint), quoteAccount: ata(feeRecipient, quote) }) as Ix] });
      }
      if (creationFee > 0n && (raw.creation_fee_bits & PARTNER_CREATION_FEE_CLAIMED) === 0) {
        claims.push({ kind: 'poolCreationFee', pool: pa.address, mint, quoteMint: quote, amount: creationFee - creationFee / 10n, unit: 'lamports', cu: CU.poolCreationFee, instructions: [C.claimPartnerPoolCreationFee({ feeClaimer: feeRecipient, dbcPool: pa.address, dbcConfig: lc.dbcConfig }) as Ix] });
      }
      const complete = p.quoteReserve >= cfg.migrationQuoteThreshold;
      const surplus = surplusShares(p.quoteReserve, cfg.migrationQuoteThreshold, cfg.creatorTradingFeePercentage).partner;
      if (complete && !p.isPartnerWithdrawSurplus && surplus > 0n) {
        claims.push({ kind: 'surplus', pool: pa.address, mint, quoteMint: quote, amount: surplus, unit: 'quote', cu: CU.surplus, instructions: [createAta(feeRecipient, feeRecipient, quote), C.partnerWithdrawSurplus({ feeClaimer: feeRecipient, dbcPool: pa.address, dbcConfig: lc.dbcConfig, quoteMint: quote, quoteAccount: ata(feeRecipient, quote) }) as Ix] });
      }
      if (p.isMigrated) {
        const positions = await findCityPositions(reader, { address: feeRecipient, mint, quoteMint: quote });
        for (const pos of positions) {
          claims.push({ kind: 'poolPositionFee', pool: pos.pool, mint, quoteMint: quote, amount: 0n, unit: 'quote', cu: CU.poolPositionFee, instructions: [...accounts, C.dammClaimPositionFee({ owner: feeRecipient, pool: pos.pool, nftMint: pos.nftMint, mintA: mint, mintB: quote, accountA: ata(feeRecipient, mint), accountB: ata(feeRecipient, quote) }) as Ix] });
        }
      }
    }
  }
  // pack in order; a claim's own account creations always travel with it
  const transactions: PlatformFeePlan['transactions'] = [];
  let cur: { label: string; instructions: Ix[]; cuLimit: number; bytes: number } | null = null;
  for (const c of claims) {
    const label = `${c.kind} ${c.pool.slice(0, 6)}…`;
    if (cur) {
      const both: Ix[] = [...cur.instructions, ...c.instructions];
      const bytes: number = measure(feeRecipient, both, [], cur.cuLimit + c.cu);
      if (bytes <= maxBytes && cur.cuLimit + c.cu <= CU.perTx) { cur = { label: `${cur.label}, ${label}`, instructions: both, cuLimit: cur.cuLimit + c.cu, bytes }; continue; }
      transactions.push(cur);
    }
    cur = { label, instructions: c.instructions, cuLimit: c.cu, bytes: measure(feeRecipient, c.instructions, [], c.cu) };
  }
  if (cur) transactions.push(cur);
  const quoteByMint: Record<string, string> = {};
  let lamports = 0n;
  for (const c of claims) {
    if (c.unit === 'lamports') lamports += c.amount;
    else if (c.amount > 0n) quoteByMint[c.quoteMint] = String(BigInt(quoteByMint[c.quoteMint] ?? '0') + c.amount);
  }
  return { claims, transactions, totals: { quoteByMint, lamports: String(lamports) } };
}
