// The founder's 0.25% and the opt-in dollar payout ("X Money", UsePaid style;
// LAUNCHPAD-DESIGN.md section 13).
//
// On chain (built, switched off until the owner configures a payout key):
//   * every harvest puts the founder's half of the city's fee share into the
//     coin's founder vault;
//   * the founder can always claim it to their own wallet (`buildFounderClaim`),
//     paused or not, opted in or not;
//   * the founder can opt in (`buildOptIn`), signed and revocable at any time
//     (`buildRevokeOptIn`), letting Vicinity's payout key move the vault, at
//     most once a day, ONLY into the one payout wallet fixed in the settings
//     and copied into the opt-in when the founder signed;
//   * `planPayouts` lists which opted-in coins the payout service may pay now,
//     and why the others are skipped; `buildPayout` is the payout key's call.
//
// Off chain (documented in LAUNCHPAD.md; NOT built): the payout service swaps
// the received SOL to USDC and a licensed off-ramp partner pays US dollars by
// bank transfer into the founder's X Money account (X Money has no public API).
import { createHash } from 'node:crypto';
import web3 from '@solana/web3.js';
import * as C from './client.mjs';
import { ADDRESSES, PROGRAM_IDS, ata, pdas } from './pda.mjs';
import { unwrapSol } from './trade.mts';
import type { Ix } from './trade.mts';
import { decodeCoin, decodePayoutOptIn, decodeLaunchpad, decodeTokenAccount, DISCRIMINATORS, base58Encode } from './accounts.mts';
import type { Address, CoinAccount, LaunchpadAccount, PayoutOptInAccount, ReadConnection } from './accounts.mts';

const { PublicKey } = web3;
/** At most one opted-in payout per coin per 24 hours (program constant PAYOUT_COOLDOWN_SECS). */
export const PAYOUT_COOLDOWN_SECS = 86_400n;

/**
 * The opt-in's reference: SHA-256 of the payout partner's customer id and a
 * per-founder salt. Only this hash goes on chain, never a name, X handle or
 * bank number; Vicinity keeps the id and salt off chain to match receipts.
 */
export function refHash(partnerCustomerId: string, salt: Uint8Array | string): Uint8Array {
  if (!partnerCustomerId) throw new Error('partner customer id required');
  const s = typeof salt === 'string' ? Buffer.from(salt, 'utf8') : Buffer.from(salt);
  if (s.length < 16) throw new Error('use a salt of at least 16 random bytes');
  return new Uint8Array(createHash('sha256').update(Buffer.from(partnerCustomerId, 'utf8')).update(s).digest());
}

/** The founder takes the whole founder vault to their own wallet (with `unwrap`, WSOL arrives as SOL). */
export function buildFounderClaim({ founder, coin, unwrap = true }: { founder: Address; coin: Pick<CoinAccount, 'cityId' | 'quoteMint'>; unwrap?: boolean }): Ix[] {
  const ix = C.claimFounderFees({ founder, coin }) as Ix;
  return unwrap && coin.quoteMint === ADDRESSES.wsol ? [ix, unwrapSol(founder)] : [ix];
}
/**
 * The founder opts in to payouts into `expectedDestination`, which must equal
 * the payout wallet in the launchpad settings at the moment it lands (so a
 * settings change while the founder signs cannot swap it).
 */
export function buildOptIn({ founder, cityId, expectedDestination, ref }: { founder: Address; cityId: bigint; expectedDestination: Address; ref: Uint8Array }): Ix {
  if (ref.length !== 32) throw new Error('ref must be 32 bytes (refHash)');
  return C.optInPayout({ founder, cityId, expectedDestination, refHash: ref }) as Ix;
}
/** Withdraw the opt-in at any time (the founder signs; the rent goes back to them). */
export function buildRevokeOptIn({ founder, cityId, optInFounder = founder }: { founder: Address; cityId: bigint; optInFounder?: Address }): Ix {
  return C.revokePayoutOptIn({ by: founder, cityId, optInFounder }) as Ix;
}
/** The payout key's call: the founder vault to the fixed payout wallet's quote-token account. */
export function buildPayout({ payoutAuthority, coin, destination }: { payoutAuthority: Address; coin: Pick<CoinAccount, 'cityId' | 'quoteMint'>; destination: Address }): Ix {
  return C.payoutFounderFees({ payoutAuthority, coin, destination }) as Ix;
}

export interface PayoutCandidate {
  coin: CoinAccount;
  optIn: PayoutOptInAccount | null;
  vaultBalance: bigint;
}
export interface PayoutDecision { cityId: bigint; mint: Address; founder: Address; amount: bigint; pay: boolean; reason: string }
/**
 * Which opted-in coins the payout service may pay now. Mirrors every check
 * of `payout_founder_fees` (so nothing it sends fails), plus a minimum amount
 * (suggested about $50 worth, like UsePaid) so tiny payouts wait.
 */
export function planPayouts({ launchpad, candidates, now, minAmount = 0n, payoutAuthority }: { launchpad: LaunchpadAccount; candidates: PayoutCandidate[]; now: bigint; minAmount?: bigint; payoutAuthority: Address }): PayoutDecision[] {
  return candidates.map(({ coin, optIn, vaultBalance }) => {
    const d = { cityId: coin.cityId, mint: coin.mint, founder: coin.founder, amount: vaultBalance };
    const no = (reason: string) => ({ ...d, pay: false, reason });
    if (!launchpad.payoutsConfigured) return no('payouts are not configured (switched off)');
    if (launchpad.payoutAuthority !== payoutAuthority) return no('this key is not the payout authority');
    if (launchpad.payoutsPaused) return no('payouts are paused');
    if (!optIn) return no('the founder has not opted in');
    if (optIn.founder !== coin.founder) return no('the founder seat changed since the opt-in (the new founder must opt in)');
    if (optIn.agreedDestination !== launchpad.payoutDestination) return no('the payout wallet changed since the opt-in (the founder must opt in again)');
    if (now < coin.lastPayoutAt + PAYOUT_COOLDOWN_SECS) return no(`cooldown: next payout after ${coin.lastPayoutAt + PAYOUT_COOLDOWN_SECS}`);
    if (vaultBalance === 0n) return no('nothing to pay');
    if (vaultBalance < minAmount) return no(`below the minimum payout (${minAmount})`);
    return { ...d, pay: true, reason: `pay ${vaultBalance} to ${launchpad.payoutDestination}` };
  });
}

/** Read everything planPayouts needs (read-only). */
export async function loadPayoutCandidates(conn: ReadConnection, programId: Address = PROGRAM_IDS.launchpad): Promise<{ launchpad: LaunchpadAccount; candidates: PayoutCandidate[] }> {
  const P = pdas(programId);
  const pid = new PublicKey(programId);
  const [lpInfo, coinAccs, optAccs] = await Promise.all([
    conn.getAccountInfo(new PublicKey(P.launchpad()), 'confirmed'),
    conn.getProgramAccounts(pid, { commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: base58Encode(DISCRIMINATORS.Coin) } }] }),
    conn.getProgramAccounts(pid, { commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: base58Encode(DISCRIMINATORS.PayoutOptIn) } }] }),
  ]);
  if (!lpInfo) throw new Error('launchpad not initialised');
  const launchpad = decodeLaunchpad(Buffer.from(lpInfo.data));
  const coins = coinAccs.map((a) => decodeCoin(Buffer.from(a.account.data), a.pubkey.toBase58(), programId));
  const optIns = new Map(optAccs.map((a) => { const o = decodePayoutOptIn(Buffer.from(a.account.data)); return [o.coin, o]; }));
  const vaults = await conn.getMultipleAccountsInfo(coins.map((c) => new PublicKey(c.founderVault)), 'confirmed');
  return {
    launchpad,
    candidates: coins
      .map((coin, i) => ({ coin, optIn: optIns.get(coin.address) ?? null, vaultBalance: vaults[i] ? decodeTokenAccount(Buffer.from(vaults[i].data)).amount : 0n }))
      .filter((c) => c.optIn !== null),
  };
}

/** The payout wallet's account that receives a coin's payouts (ATA of the fixed destination for the quote token). */
export function payoutReceivingAccount(destination: Address, quoteMint: Address): Address {
  return ata(destination, quoteMint);
}
