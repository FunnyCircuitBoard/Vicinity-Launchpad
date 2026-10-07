// "Pay with anything" and "sell into anything" (LAUNCHPAD-DESIGN.md 9.6).
//
// A curve only ever takes its own quote token (SOL by default). To pay with
// BTC, ETH, USDC, a tokenized stock, STONK or $VICINITY, the buyer's own
// transaction first swaps that asset into the quote token through Jupiter,
// then buys the coin with Jupiter's GUARANTEED minimum output
// (`otherAmountThreshold`), so the buy can never ask for more than the swap
// delivered. Whatever Jupiter delivers above that minimum stays with the
// buyer: as SOL for a SOL-priced coin (Jupiter's cleanup unwraps it), as the
// quote token otherwise. One signature, nothing custodial, nothing held by
// Vicinity in between.
//
// Jupiter is mainnet only, so this cannot run on devnet. The composition is
// tested with recorded Jupiter responses (sdk/launchpad/fixtures) and, in
// process, with a stand-in swap (tests-launchpad/12-client-sdk.test.mjs).
//
// Jupiter's answer is NOT trusted (checkJupiterBuild): the swap must be one of
// Jupiter's two ExactIn route instructions, decoded by position (who signs,
// which account pays, where the output lands, the amount in and the minimum
// out, which must match what the JSON promises); every helper instruction is
// allow-listed by program, opcode and accounts (create the trader's own token
// account, wrap and unwrap the trader's own SOL, nothing else); and Jupiter's
// priority fee is capped (0.01 SOL by default).
//
// API: GET https://api.jup.ag/swap/v2/build (ExactIn only; raw instructions,
// lookup tables and a blockhash). Keyless access allows 0.5 requests per
// second; production passes an API key (x-api-key), kept in a Worker secret.
import web3 from '@solana/web3.js';
import type { AddressLookupTableAccount as AltT, VersionedTransaction as VersionedTransactionT, Connection } from '@solana/web3.js';
import { ADDRESSES, PROGRAM_IDS, ata } from './pda.mjs';
import { SwapMode } from './curve.mjs';
import { buildBuy, createAta, setComputeUnitPrice, toV0Transaction, txBytes, unwrapSol, referralFor, maxCuPrice, COMPUTE_BUDGET_PROGRAM, MAX_TX_BYTES, MAX_PRIORITY_FEE_LAMPORTS, CU } from './trade.mts';
import type { Ix, CoinRef } from './trade.mts';
import { quoteBuy, MAX_SLIPPAGE_BPS } from './quote.mts';
import type { PoolLike, CurveLike } from './quote.mts';
import * as C from './client.mjs';
import type { Address } from './accounts.mts';

const { AddressLookupTableAccount, PublicKey } = web3;

export const JUPITER_API = 'https://api.jup.ag';
/** Jupiter's aggregator program (the swap instruction must call it). */
export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/**
 * Programs Jupiter's setup and cleanup instructions may call, and what each
 * may do (checkJupiterBuild): ATA create-idempotent of the trader's own
 * account; a System transfer of the trader's SOL into the trader's own WSOL
 * account (paying with SOL only); SPL Token sync-native and close of the
 * trader's own WSOL account back to the trader. Everything else is refused.
 */
export const JUPITER_HELPER_PROGRAMS = Object.freeze([PROGRAM_IDS.ata, PROGRAM_IDS.token, PROGRAM_IDS.system]);
/** The Jupiter swap instructions accepted (ExactIn routes; discriminators = sha256("global:<name>")[..8]). */
export const JUPITER_SWAP_DISCRIMINATORS = Object.freeze({ route_v2: 'bb64facc31c4af14', shared_accounts_route_v2: 'd19853937cfed8e9' });
/** Route sizes to try, smallest-but-roomy first (smaller routes leave room for our buy), then 64 as a last resort. */
export const MAX_ACCOUNTS_STEPS = Object.freeze([40, 32, 24, 64]);
/** Compute limit used when the transaction is not simulated first (Jupiter routes use up to about 400k). */
export const DEFAULT_PAY_CU = 600_000;

export interface JupiterApiInstruction { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }
export interface JupiterBuild {
  inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold: string;
  swapMode: string; slippageBps: number; priceImpactPct?: string;
  routePlan: { percent?: number; bps?: number; swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string } }[];
  computeBudgetInstructions: JupiterApiInstruction[];
  setupInstructions: JupiterApiInstruction[];
  swapInstruction: JupiterApiInstruction;
  cleanupInstruction: JupiterApiInstruction | null;
  otherInstructions: JupiterApiInstruction[];
  tipInstruction: JupiterApiInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
  blockhashWithMetadata: { blockhash: number[]; lastValidBlockHeight: number };
}
export interface JupiterBuildParams {
  inputMint: Address; outputMint: Address; amount: bigint; taker: Address; slippageBps: number;
  maxAccounts?: number; wrapAndUnwrapSol?: boolean;
}
export class JupiterNoRoute extends Error {}

export function jupiterBuildUrl(p: JupiterBuildParams, base = JUPITER_API): string {
  const q = new URLSearchParams({
    inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString(), taker: p.taker,
    slippageBps: String(p.slippageBps), maxAccounts: String(p.maxAccounts ?? 64), wrapAndUnwrapSol: String(p.wrapAndUnwrapSol ?? true),
  });
  return `${base}/swap/v2/build?${q}`;
}
type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
async function getJson(url: string, apiKey: string | undefined, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, apiKey ? { headers: { 'x-api-key': apiKey } } : undefined);
  const body = await res.text();
  let j: Record<string, unknown>;
  try { j = JSON.parse(body); } catch { throw new Error(`Jupiter answered ${res.status}: ${body.slice(0, 200)}`); }
  if (!res.ok || j.error) {
    const msg = String(j.error ?? body).slice(0, 200);
    if (/no route/i.test(msg)) throw new JupiterNoRoute(msg);
    throw new Error(`Jupiter answered ${res.status}: ${msg}`);
  }
  return j;
}
/** Swap instructions from Jupiter (read-only: nothing is signed or sent). */
export async function fetchJupiterBuild(p: JupiterBuildParams, { apiKey, fetchImpl = fetch as unknown as FetchLike, base = JUPITER_API }: { apiKey?: string; fetchImpl?: FetchLike; base?: string } = {}): Promise<JupiterBuild> {
  return (await getJson(jupiterBuildUrl(p, base), apiKey, fetchImpl)) as unknown as JupiterBuild;
}
export interface JupiterQuote { inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold: string; swapMode: string; slippageBps: number; priceImpactPct: string; routePlan: { swapInfo: { label: string } }[] }
/** A price quote only (GET /swap/v1/quote): what the website shows before the buyer commits. */
export async function fetchJupiterQuote({ inputMint, outputMint, amount, slippageBps, maxAccounts }: Omit<JupiterBuildParams, 'taker'>, { apiKey, fetchImpl = fetch as unknown as FetchLike, base = JUPITER_API }: { apiKey?: string; fetchImpl?: FetchLike; base?: string } = {}): Promise<JupiterQuote> {
  const q = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps), swapMode: 'ExactIn', ...(maxAccounts ? { maxAccounts: String(maxAccounts) } : {}) });
  return (await getJson(`${base}/swap/v1/quote?${q}`, apiKey, fetchImpl)) as unknown as JupiterQuote;
}

/** A Jupiter API instruction as a @solana/kit-shaped instruction. */
export function jupiterIx(i: JupiterApiInstruction): Ix {
  return {
    programAddress: i.programId,
    accounts: i.accounts.map((a) => ({ address: a.pubkey, role: (a.isSigner ? 2 : 0) | (a.isWritable ? 1 : 0) })),
    data: new Uint8Array(Buffer.from(i.data, 'base64')),
  };
}
/** Jupiter's lookup tables, from the addresses it returns (no RPC call needed). */
export function jupiterLookupTables(build: Pick<JupiterBuild, 'addressesByLookupTableAddress'>): AltT[] {
  return Object.entries(build.addressesByLookupTableAddress ?? {}).map(([key, addrs]) => new AddressLookupTableAccount({
    key: new PublicKey(key),
    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addrs.map((a) => new PublicKey(a)) },
  }));
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes: number[] | Uint8Array): string {
  let n = 0n;
  for (const x of bytes) n = n * 256n + BigInt(x);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of bytes) { if (x !== 0) break; s = `1${s}`; }
  return s;
}
export function jupiterBlockhash(build: Pick<JupiterBuild, 'blockhashWithMetadata'>): { blockhash: string; lastValidBlockHeight: number } {
  return { blockhash: b58(build.blockhashWithMetadata.blockhash), lastValidBlockHeight: build.blockhashWithMetadata.lastValidBlockHeight };
}

/** A swap instruction read by position: who signs, which accounts pay and receive, and the amounts it enforces. */
export interface DecodedSwap {
  kind: string;
  /** the user transfer authority: must be the trader */
  authority: Address;
  /** the account the input is taken from */
  source: Address;
  /** every account the output may land in (all must be the trader's own) */
  destinations: Address[];
  sourceMint?: Address;
  destinationMint?: Address;
  sourceTokenProgram?: Address;
  destinationTokenProgram?: Address;
  inAmount: bigint;
  /** the least output the instruction itself enforces on chain */
  minOut: bigint;
  quotedOutAmount?: bigint;
  slippageBps?: number;
  platformFeeBps: number;
  positiveSlippageBps: number;
}
export type SwapDecoder = (ix: JupiterApiInstruction) => DecodedSwap;

/**
 * Decode Jupiter's ExactIn swap (route_v2 or shared_accounts_route_v2, the two
 * kinds /swap/v2/build returns; checked against recorded mainnet answers).
 * Anything else throws. The minimum out is what Jupiter's program enforces:
 * quoted - floor(quoted x slippage / 10,000).
 */
export function decodeJupiterSwap(ix: JupiterApiInstruction): DecodedSwap {
  const d = Buffer.from(ix.data, 'base64');
  const disc = d.subarray(0, 8).toString('hex');
  const acc = (i: number): Address => {
    const a = ix.accounts[i];
    if (!a) throw new Error(`Jupiter response refused: swap instruction has no account ${i}`);
    return a.pubkey;
  };
  const args = (o: number) => {
    if (d.length < o + 26) throw new Error('Jupiter response refused: swap instruction data too short');
    const quoted = d.readBigUInt64LE(o + 8), slip = d.readUInt16LE(o + 16);
    return { inAmount: d.readBigUInt64LE(o), quotedOutAmount: quoted, slippageBps: slip, minOut: quoted - (quoted * BigInt(slip)) / 10_000n, platformFeeBps: d.readUInt16LE(o + 18), positiveSlippageBps: d.readUInt16LE(o + 20) };
  };
  if (disc === JUPITER_SWAP_DISCRIMINATORS.route_v2) {
    // user_transfer_authority, user_source, user_destination, source_mint, destination_mint,
    // source_token_program, destination_token_program, destination_token_account (optional: the program id = none), event_authority, program
    const optional = acc(7);
    return {
      kind: 'route_v2', authority: acc(0), source: acc(1), destinations: optional === JUPITER_PROGRAM ? [acc(2)] : [acc(2), optional],
      sourceMint: acc(3), destinationMint: acc(4), sourceTokenProgram: acc(5), destinationTokenProgram: acc(6), ...args(8),
    };
  }
  if (disc === JUPITER_SWAP_DISCRIMINATORS.shared_accounts_route_v2) {
    // program_authority, user_transfer_authority, source, program_source, program_destination, destination,
    // source_mint, destination_mint, source_token_program, destination_token_program, event_authority, program; data: id u8 first
    return {
      kind: 'shared_accounts_route_v2', authority: acc(1), source: acc(2), destinations: [acc(5)],
      sourceMint: acc(6), destinationMint: acc(7), sourceTokenProgram: acc(8), destinationTokenProgram: acc(9), ...args(9),
    };
  }
  throw new Error(`Jupiter response refused: swap instruction ${disc} is not an ExactIn route this SDK knows`);
}

const TOKEN_PROGRAMS: readonly string[] = [PROGRAM_IDS.token, PROGRAM_IDS.token2022];
const traderAccountsFor = (trader: Address, mint: Address) => TOKEN_PROGRAMS.map((p) => ata(trader, mint, p));

/**
 * Refuse a Jupiter response that does not do exactly what we asked:
 *   * ExactIn between the expected mints, for the expected amount, a positive
 *     guaranteed output no higher than the quote, slippage at most 50%;
 *   * the trader is the only signer; no tip instruction;
 *   * the swap is Jupiter's route_v2 or shared_accounts_route_v2, read by
 *     position: the trader authorises it, the input comes from the trader's own
 *     account of the input mint, the output lands only in the trader's own
 *     account of the output mint, the amount in, quoted out and slippage match
 *     the JSON, the minimum it enforces is the JSON's otherAmountThreshold, and
 *     there is no platform fee or positive-slippage cut;
 *   * every setup, cleanup and other instruction is on the allow-list
 *     (JUPITER_HELPER_PROGRAMS), checked by opcode and accounts.
 */
export function checkJupiterBuild(build: JupiterBuild, { trader, inputMint, outputMint, inAmount, jupiterProgram = JUPITER_PROGRAM, swapDecoder = decodeJupiterSwap, maxSlippageBps = MAX_SLIPPAGE_BPS }: {
  trader: Address; inputMint: Address; outputMint: Address; inAmount?: bigint; maxSlippageBps?: number;
  /** tests only: the program the swap instruction must call (default: Jupiter's) */
  jupiterProgram?: Address;
  /** tests only: how to read that swap instruction (default: Jupiter's layouts) */
  swapDecoder?: SwapDecoder;
}): DecodedSwap {
  const fail = (m: string): never => { throw new Error(`Jupiter response refused: ${m}`); };
  if (build.swapMode !== 'ExactIn') fail(`swapMode ${build.swapMode}, expected ExactIn`);
  if (build.inputMint !== inputMint) fail(`input mint ${build.inputMint}, expected ${inputMint}`);
  if (build.outputMint !== outputMint) fail(`output mint ${build.outputMint}, expected ${outputMint}`);
  const jsonIn = BigInt(build.inAmount), threshold = BigInt(build.otherAmountThreshold);
  if (inAmount !== undefined && jsonIn !== inAmount) fail(`in amount ${build.inAmount}, expected ${inAmount}`);
  if (threshold <= 0n) fail('zero guaranteed output');
  if (threshold > BigInt(build.outAmount)) fail('guaranteed output above the quoted output');
  if (!(build.slippageBps >= 0 && build.slippageBps <= maxSlippageBps)) fail(`slippage ${build.slippageBps} bps above ${maxSlippageBps}`);
  if (build.swapInstruction.programId !== jupiterProgram) fail(`swap program ${build.swapInstruction.programId}`);
  if (build.tipInstruction) fail('tip instructions are not used (send through your own RPC)');
  const helpers = [...build.setupInstructions, ...(build.cleanupInstruction ? [build.cleanupInstruction] : []), ...build.otherInstructions];
  const all = [...build.computeBudgetInstructions, ...helpers, build.swapInstruction];
  for (const i of all) for (const a of i.accounts) if (a.isSigner && a.pubkey !== trader) fail(`unexpected signer ${a.pubkey}`);
  for (const i of build.computeBudgetInstructions) if (i.programId !== COMPUTE_BUDGET_PROGRAM || i.accounts.length) fail('compute budget instruction calls another program or names accounts');

  // the swap itself, by position
  const sw = swapDecoder(build.swapInstruction);
  if (sw.authority !== trader) fail(`the swap is authorised by ${sw.authority}, not the trader`);
  if (sw.sourceMint !== undefined && sw.sourceMint !== inputMint) fail(`the swap spends ${sw.sourceMint}, not ${inputMint}`);
  if (sw.destinationMint !== undefined && sw.destinationMint !== outputMint) fail(`the swap delivers ${sw.destinationMint}, not ${outputMint}`);
  const srcOk = sw.sourceTokenProgram ? TOKEN_PROGRAMS.includes(sw.sourceTokenProgram) && sw.source === ata(trader, inputMint, sw.sourceTokenProgram) : traderAccountsFor(trader, inputMint).includes(sw.source);
  if (!srcOk) fail(`the swap spends from ${sw.source}, not the trader's own ${inputMint} account`);
  const outs = sw.destinationTokenProgram ? (TOKEN_PROGRAMS.includes(sw.destinationTokenProgram) ? [ata(trader, outputMint, sw.destinationTokenProgram)] : []) : traderAccountsFor(trader, outputMint);
  if (sw.destinations.length === 0 || !sw.destinations.every((dst) => outs.includes(dst))) fail(`the swap does not pay into the trader's own ${outputMint} account`);
  if (sw.inAmount !== jsonIn) fail(`the swap spends ${sw.inAmount}, the answer says ${jsonIn}`);
  if (sw.quotedOutAmount !== undefined && sw.quotedOutAmount !== BigInt(build.outAmount)) fail(`the swap quotes ${sw.quotedOutAmount}, the answer says ${build.outAmount}`);
  if (sw.slippageBps !== undefined && sw.slippageBps !== build.slippageBps) fail(`the swap allows ${sw.slippageBps} bps of slippage, the answer says ${build.slippageBps}`);
  if (sw.minOut !== threshold) fail(`the swap guarantees ${sw.minOut}, the answer says ${threshold}`);
  if (sw.platformFeeBps !== 0 || sw.positiveSlippageBps !== 0) fail('the swap takes a platform fee or a positive-slippage cut');

  // every other instruction, by opcode and accounts
  const wsolAta = ata(trader, ADDRESSES.wsol);
  const routeMints = new Set<string>([inputMint, outputMint, ...build.routePlan.flatMap((r) => [r.swapInfo.inputMint, r.swapInfo.outputMint])]);
  for (const i of helpers) {
    const d = Buffer.from(i.data, 'base64');
    const a = (k: number) => i.accounts[k]?.pubkey;
    if (i.programId === PROGRAM_IDS.ata) {
      // CreateIdempotent: funder, account, owner, mint, system program, token program
      if (!(d.length === 1 && d[0] === 1) || i.accounts.length !== 6) fail('associated-token instruction other than create-idempotent');
      if (a(0) !== trader || a(2) !== trader) fail('creates a token account for, or paid by, someone else');
      if (a(4) !== PROGRAM_IDS.system || !TOKEN_PROGRAMS.includes(a(5)!)) fail('creates a token account with unexpected programs');
      if (!routeMints.has(a(3)!)) fail(`creates a token account for ${a(3)}, which is not on the route`);
      if (a(1) !== ata(trader, a(3)!, a(5)!)) fail('creates an account that is not the trader\'s own associated account');
    } else if (i.programId === PROGRAM_IDS.system) {
      // Transfer: u32 2, u64 lamports; only to wrap the SOL being paid
      if (!(d.length === 12 && d.readUInt32LE(0) === 2) || i.accounts.length !== 2) fail('system instruction other than a transfer');
      if (inputMint !== ADDRESSES.wsol) fail('moves SOL although the payment is not in SOL');
      if (a(0) !== trader || a(1) !== wsolAta) fail('sends SOL anywhere but the trader\'s own WSOL account');
      if (d.readBigUInt64LE(4) > jsonIn) fail('wraps more SOL than the swap spends');
    } else if (i.programId === PROGRAM_IDS.token) {
      if (d.length === 1 && d[0] === 17) {
        if (i.accounts.length !== 1 || a(0) !== wsolAta) fail('sync-native of an account other than the trader\'s WSOL account');
      } else if (d.length === 1 && d[0] === 9) {
        if (i.accounts.length !== 3 || a(0) !== wsolAta || a(1) !== trader || a(2) !== trader) fail('closes an account other than the trader\'s WSOL account, or pays it to someone else');
      } else {
        fail(`token instruction ${d[0]} is not allowed (only sync-native and close of the trader's WSOL account)`);
      }
    } else {
      fail(`helper instruction calls ${i.programId}`);
    }
  }
  return sw;
}

/**
 * Jupiter's compute-unit price, capped so that price x `cuLimit` stays within
 * `maxPriorityFee` (0.01 SOL by default). Jupiter's own limit and any other
 * compute-budget instruction are dropped: we set the limit ourselves.
 */
export function cappedCuPrice(build: Pick<JupiterBuild, 'computeBudgetInstructions'>, cuLimit: number, maxPriorityFee: bigint = MAX_PRIORITY_FEE_LAMPORTS): Ix[] {
  const prices = build.computeBudgetInstructions.map(jupiterIx).filter((ix) => ix.data[0] === 3 && ix.data.length === 9).map((ix) => Buffer.from(ix.data).readBigUInt64LE(1));
  if (prices.length === 0) return [];
  const asked = prices.reduce((m, p) => (p > m ? p : m), 0n);
  const cap = maxCuPrice(cuLimit, maxPriorityFee);
  return [setComputeUnitPrice(asked < cap ? asked : cap)];
}
/** The pool parts the composers need to refuse a finished curve. */
export type CurveState = PoolLike & { isMigrated?: number | boolean };
function refuseFinishedCurve(pool: CurveState | undefined, config: Pick<CurveLike, 'migrationQuoteThreshold'> | undefined): void {
  if (!pool || !config) return;
  if (pool.isMigrated) throw new Error('this coin has graduated: buy it on its DAMM v2 pool (buildPoolSwap or Jupiter), not on the curve');
  if (pool.quoteReserve >= config.migrationQuoteThreshold) throw new Error('this curve is full and waiting for graduation: buying resumes on the DAMM v2 pool once it graduates');
}

export interface PlannedTransaction {
  label: string;
  instructions: Ix[];
  lookupTables: AltT[];
  cuLimit: number;
  bytes: number;
  /** unsigned; the trader signs (and is the fee payer) */
  tx: VersionedTransactionT;
}
export interface PayPlan {
  mode: 'one-transaction' | 'two-transactions';
  /** DBC swap mode of the buy: always 1 (partial fill), so the last buy of a curve refunds instead of failing */
  buyMode: 0 | 1;
  transactions: PlannedTransaction[];
  /** the quote amount the curve buy spends: Jupiter's guaranteed minimum */
  buyAmountIn: bigint;
  minCoinsOut: bigint;
  /** what Jupiter expects to deliver above the minimum; it stays with the buyer */
  expectedSurplus: bigint;
  surplusKept: 'SOL' | 'quote token';
  route: string;
  notes: string[];
}

/**
 * Compose Jupiter (user's asset -> the coin's quote token) and the curve buy
 * into one transaction when it fits 1,232 bytes, else two (swap, then buy).
 * `build` must be an ExactIn /swap/v2/build response with `taker = trader`
 * and `outputMint = coin.quoteMint`; it is checked (checkJupiterBuild) before
 * anything is composed. The buy is a partial fill, and with `pool`/`config`
 * a finished or graduated curve is refused before the buyer's asset is sold.
 * In two-transaction mode, rebuild the buy from the live pool after the swap
 * lands (buildBuyAfterSwap) instead of sending the planned one blindly.
 */
export function composePayWithAnything({ build, trader, coin, minCoinsOut, buyMode = SwapMode.PartialFill, referral, ensureReferralAccount, lookupTables = [], cuLimit = DEFAULT_PAY_CU, maxBytes = MAX_TX_BYTES, maxPriorityFee = MAX_PRIORITY_FEE_LAMPORTS, inAmount, pool, config, jupiterProgram, swapDecoder }: {
  build: JupiterBuild; trader: Address; coin: CoinRef; minCoinsOut: bigint; buyMode?: 0 | 1;
  referral?: Address | null; ensureReferralAccount?: boolean; lookupTables?: AltT[]; cuLimit?: number; maxBytes?: number; maxPriorityFee?: bigint;
  /** the amount the buyer agreed to pay (checked against Jupiter's answer) */
  inAmount?: bigint;
  /** the coin's live DBC pool and config: a finished or graduated curve is refused */
  pool?: CurveState; config?: Pick<CurveLike, 'migrationQuoteThreshold'>;
  /** tests only: the program the swap instruction must call (default: Jupiter's) */
  jupiterProgram?: Address;
  /** tests only: how to read that swap instruction */
  swapDecoder?: SwapDecoder;
}): PayPlan {
  refuseFinishedCurve(pool, config);
  checkJupiterBuild(build, { trader, inputMint: build.inputMint, outputMint: coin.quoteMint, inAmount, jupiterProgram, swapDecoder });
  if (minCoinsOut <= 0n) throw new Error('minCoinsOut must be positive');
  const buyAmountIn = BigInt(build.otherAmountThreshold);
  const alts = [...jupiterLookupTables(build), ...lookupTables];
  const { blockhash } = jupiterBlockhash(build);
  const sol = coin.quoteMint === ADDRESSES.wsol;
  const { referral: ref, setup: refSetup } = referralFor(coin.quoteMint, trader, referral, ensureReferralAccount);
  const swap = C.swap as unknown as (a: Record<string, unknown>) => Ix;
  const buyIx = swap({
    trader, pool: coin.dbcPool, config: coin.dbcConfig, baseMint: coin.mint, quoteMint: coin.quoteMint, side: 'buy', mode: buyMode,
    amount0: buyAmountIn, amount1: minCoinsOut, referral: ref,
  });
  const route = build.routePlan.map((r) => r.swapInfo.label).join(' > ');
  const notes: string[] = [];
  const price = cappedCuPrice(build, cuLimit, maxPriorityFee);
  const one: Ix[] = [
    ...price,
    ...refSetup,
    ...build.setupInstructions.map(jupiterIx),
    jupiterIx(build.swapInstruction),
    createAta(trader, trader, coin.mint),
    buyIx,
    ...(build.cleanupInstruction ? [jupiterIx(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(jupiterIx),
  ];
  const base = {
    buyMode, buyAmountIn, minCoinsOut, expectedSurplus: BigInt(build.outAmount) - buyAmountIn,
    surplusKept: (sol && build.cleanupInstruction ? 'SOL' : 'quote token') as PayPlan['surplusKept'], route,
  };
  let bytes = Infinity;
  let tx: VersionedTransactionT | null = null;
  try { tx = toV0Transaction({ payer: trader, instructions: one, blockhash, lookupTables: alts, cuLimit, maxPriorityFee }); bytes = txBytes(tx); } catch (e) { if (/priority fee/.test(String((e as Error).message))) throw e; /* too many accounts or too large to serialize */ }
  if (tx && bytes <= maxBytes) {
    return { mode: 'one-transaction', transactions: [{ label: 'swap and buy', instructions: one, lookupTables: alts, cuLimit, bytes, tx }], ...base, notes };
  }
  notes.push(`swap plus buy is ${Number.isFinite(bytes) ? `${bytes} bytes` : 'too large'} (limit ${maxBytes}): sent as two transactions, swap then buy`);
  notes.push('after the swap lands, re-read the pool and rebuild the buy with buildBuyAfterSwap (the curve may have filled or graduated meanwhile)');
  // two transactions: Jupiter's checked instructions (its cleanup unwraps SOL), then a partial-fill buy of the guaranteed minimum
  const swapOnly: Ix[] = [...price, ...build.setupInstructions.map(jupiterIx), jupiterIx(build.swapInstruction), ...(build.cleanupInstruction ? [jupiterIx(build.cleanupInstruction)] : []), ...build.otherInstructions.map(jupiterIx)];
  const tx1 = toV0Transaction({ payer: trader, instructions: swapOnly, blockhash, lookupTables: alts, cuLimit, maxPriorityFee });
  const buyOnly = buildBuy({ trader, coin, amountIn: buyAmountIn, minOut: minCoinsOut, mode: buyMode, referral, ensureReferralAccount, handleSol: sol });
  const tx2 = toV0Transaction({ payer: trader, instructions: buyOnly, blockhash, lookupTables, cuLimit: CU.swap });
  const b1 = txBytes(tx1), b2 = txBytes(tx2);
  if (b1 > MAX_TX_BYTES) throw new Error(`Jupiter's own transaction is ${b1} bytes; ask for a smaller route (maxAccounts)`);
  return {
    mode: 'two-transactions',
    transactions: [
      { label: 'swap', instructions: swapOnly, lookupTables: alts, cuLimit, bytes: b1, tx: tx1 },
      { label: 'buy', instructions: buyOnly, lookupTables, cuLimit: CU.swap, bytes: b2, tx: tx2 },
    ],
    ...base, notes,
  };
}

/**
 * Two-transaction pay-with-anything, step 2: the swap has landed and the buyer
 * holds `amountIn` of the coin's quote token. Re-quote against the pool as it
 * is now and build a partial-fill buy. Throws (and the buyer simply keeps the
 * quote token) when the curve filled or graduated in between.
 */
export function buildBuyAfterSwap({ trader, coin, pool, config, amountIn, slippageBps = 100, referral, ensureReferralAccount }: {
  trader: Address; coin: CoinRef; pool: CurveState; config: CurveLike; amountIn: bigint; slippageBps?: number; referral?: Address | null; ensureReferralAccount?: boolean;
}): { instructions: Ix[]; expectedCoins: bigint; minOut: bigint; refund: bigint } {
  refuseFinishedCurve(pool, config);
  const q = quoteBuy(pool, config, { amountIn, slippageBps, referral: referral !== null });
  const instructions = buildBuy({ trader, coin, amountIn, minOut: q.minOut as bigint, mode: SwapMode.PartialFill, referral, ensureReferralAccount, handleSol: coin.quoteMint === ADDRESSES.wsol });
  return { instructions, expectedCoins: q.amountOut, minOut: q.minOut as bigint, refund: q.refund };
}

export interface SellPlan { mode: 'one-transaction' | 'two-transactions'; transactions: PlannedTransaction[]; minQuoteOut: bigint; minAssetOut: bigint; route: string; notes: string[] }
/**
 * Sell a coin, then swap the quote token into another asset (BTC, ETH, a
 * stock token...). `build` must be ExactIn from the coin's quote token, for
 * exactly `minQuoteOut` (the sell's guaranteed minimum), with
 * wrapAndUnwrapSol=false so Jupiter spends the WSOL the sell delivered. Any
 * quote above the minimum stays with the seller (unwrapped to SOL).
 */
export function composeSellIntoAnything({ build, trader, coin, coinAmountIn, minQuoteOut, referral, ensureReferralAccount, lookupTables = [], cuLimit = DEFAULT_PAY_CU, maxBytes = MAX_TX_BYTES, maxPriorityFee = MAX_PRIORITY_FEE_LAMPORTS, jupiterProgram, swapDecoder }: {
  build: JupiterBuild; trader: Address; coin: CoinRef; coinAmountIn: bigint; minQuoteOut: bigint;
  referral?: Address | null; ensureReferralAccount?: boolean; lookupTables?: AltT[]; cuLimit?: number; maxBytes?: number; maxPriorityFee?: bigint;
  /** tests only: the program the swap instruction must call (default: Jupiter's) */
  jupiterProgram?: Address;
  /** tests only: how to read that swap instruction */
  swapDecoder?: SwapDecoder;
}): SellPlan {
  const sol = coin.quoteMint === ADDRESSES.wsol;
  if (sol && build.setupInstructions.some((i) => i.programId === PROGRAM_IDS.system)) throw new Error('ask Jupiter with wrapAndUnwrapSol=false: the sell already delivers WSOL');
  checkJupiterBuild(build, { trader, inputMint: coin.quoteMint, outputMint: build.outputMint, inAmount: minQuoteOut, jupiterProgram, swapDecoder });
  if (coinAmountIn <= 0n || minQuoteOut <= 0n) throw new RangeError('coinAmountIn and minQuoteOut must be positive');
  const alts = [...jupiterLookupTables(build), ...lookupTables];
  const { blockhash } = jupiterBlockhash(build);
  const { referral: ref, setup: refSetup } = referralFor(coin.quoteMint, trader, referral, ensureReferralAccount);
  const swap = C.swap as unknown as (a: Record<string, unknown>) => Ix;
  const sellIx = swap({ trader, pool: coin.dbcPool, config: coin.dbcConfig, baseMint: coin.mint, quoteMint: coin.quoteMint, side: 'sell', mode: SwapMode.ExactIn, amount0: coinAmountIn, amount1: minQuoteOut, referral: ref });
  const sellPart: Ix[] = [...refSetup, createAta(trader, trader, coin.quoteMint), sellIx];
  const jupPart: Ix[] = [...build.setupInstructions.map(jupiterIx), jupiterIx(build.swapInstruction), ...(build.cleanupInstruction ? [jupiterIx(build.cleanupInstruction)] : []), ...build.otherInstructions.map(jupiterIx)];
  // unwrap what the sell delivered above the minimum, unless Jupiter's own cleanup already closes that WSOL account back to the trader
  const wsolAta = ata(trader, ADDRESSES.wsol);
  const c = build.cleanupInstruction;
  const jupiterCloses = !!c && c.programId === PROGRAM_IDS.token && Buffer.from(c.data, 'base64')[0] === 9 && c.accounts[0]?.pubkey === wsolAta && c.accounts[1]?.pubkey === trader && c.accounts[2]?.pubkey === trader;
  const tail: Ix[] = sol && !jupiterCloses ? [unwrapSol(trader)] : [];
  const route = build.routePlan.map((r) => r.swapInfo.label).join(' > ');
  const minAssetOut = BigInt(build.otherAmountThreshold);
  const price = cappedCuPrice(build, cuLimit, maxPriorityFee);
  const all = [...price, ...sellPart, ...jupPart, ...tail];
  let bytes = Infinity, tx: VersionedTransactionT | null = null;
  try { tx = toV0Transaction({ payer: trader, instructions: all, blockhash, lookupTables: alts, cuLimit, maxPriorityFee }); bytes = txBytes(tx); } catch (e) { if (/priority fee/.test(String((e as Error).message))) throw e; /* too large */ }
  if (tx && bytes <= maxBytes) return { mode: 'one-transaction', transactions: [{ label: 'sell and swap', instructions: all, lookupTables: alts, cuLimit, bytes, tx }], minQuoteOut, minAssetOut, route, notes: [] };
  const s = [...sellPart];
  const j = [...price, ...jupPart, ...tail];
  const tx1 = toV0Transaction({ payer: trader, instructions: s, blockhash, lookupTables, cuLimit: CU.swap });
  const tx2 = toV0Transaction({ payer: trader, instructions: j, blockhash, lookupTables: alts, cuLimit, maxPriorityFee });
  return {
    mode: 'two-transactions', minQuoteOut, minAssetOut, route,
    transactions: [
      { label: 'sell', instructions: s, lookupTables, cuLimit: CU.swap, bytes: txBytes(tx1), tx: tx1 },
      { label: 'swap', instructions: j, lookupTables: alts, cuLimit, bytes: txBytes(tx2), tx: tx2 },
    ],
    notes: [`sell plus swap is ${Number.isFinite(bytes) ? `${bytes} bytes` : 'too large'} (limit ${maxBytes}): sent as two transactions`],
  };
}

/**
 * Simulate a planned transaction and return a compute limit of 1.2x what it
 * used (design 9.6, point 5), capped at 1,400,000. Read-only.
 */
export async function simulatedCuLimit(connection: Pick<Connection, 'simulateTransaction'>, tx: VersionedTransactionT): Promise<number> {
  const res = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  if (res.value.err) throw new Error(`simulation failed: ${JSON.stringify(res.value.err)} ${(res.value.logs ?? []).slice(-3).join(' | ')}`);
  const used = res.value.unitsConsumed ?? 1_400_000;
  return Math.min(1_400_000, Math.ceil(used * 1.2));
}

/**
 * The whole pay-with-anything flow for the website, read-only:
 *   * the coin's live pool and config come first: a full or graduated curve is
 *     refused before anything is asked of Jupiter (buy on the DAMM v2 pool);
 *   * paying with the quote token itself (SOL for a SOL-priced coin) needs no swap;
 *   * otherwise ask Jupiter at route sizes 40, 32, 24 and finally 64 until
 *     swap + buy fit one transaction (64 usually means two).
 * Every buy is a partial fill. `minCoinsOutFor(quoteIn)` turns the guaranteed
 * quote amount into the least coins accepted; by default quoteBuy(...).minOut
 * on the live pool at `slippageBps`.
 */
export async function planPayWithAnything({ payMint, amount, trader, coin, pool, config, slippageBps, minCoinsOutFor, lookupTables = [], apiKey, fetchImpl }: {
  payMint: Address; amount: bigint; trader: Address; coin: CoinRef;
  /** the coin's live DBC pool and config (decodeDbcPool / decodeDbcConfig) */
  pool: CurveState; config: CurveLike;
  slippageBps: number;
  minCoinsOutFor?: (quoteIn: bigint) => bigint; lookupTables?: AltT[]; apiKey?: string; fetchImpl?: FetchLike;
}): Promise<{ direct: Ix[] | null; plan: PayPlan | null; tried: { maxAccounts: number; result: string }[] }> {
  refuseFinishedCurve(pool, config);
  const minFor = minCoinsOutFor ?? ((q: bigint) => quoteBuy(pool, config, { amountIn: q, slippageBps }).minOut as bigint);
  if (payMint === coin.quoteMint) {
    return { direct: buildBuy({ trader, coin, amountIn: amount, minOut: minFor(amount), mode: SwapMode.PartialFill }), plan: null, tried: [] };
  }
  const steps = [...MAX_ACCOUNTS_STEPS];
  const tried: { maxAccounts: number; result: string }[] = [];
  let fallback: PayPlan | null = null;
  for (const maxAccounts of steps) {
    let build: JupiterBuild;
    try {
      build = await fetchJupiterBuild({ inputMint: payMint, outputMint: coin.quoteMint, amount, taker: trader, slippageBps, maxAccounts, wrapAndUnwrapSol: true }, { apiKey, fetchImpl });
    } catch (e) {
      tried.push({ maxAccounts, result: e instanceof JupiterNoRoute ? 'no route' : String((e as Error).message) });
      continue;
    }
    let plan: PayPlan;
    try {
      plan = composePayWithAnything({ build, trader, coin, minCoinsOut: minFor(BigInt(build.otherAmountThreshold)), lookupTables, inAmount: amount, pool, config });
    } catch (e) {
      tried.push({ maxAccounts, result: String((e as Error).message) });
      continue;
    }
    tried.push({ maxAccounts, result: `${plan.mode} (${plan.transactions.map((t) => t.bytes).join(' + ')} bytes)` });
    if (plan.mode === 'one-transaction') return { direct: null, plan, tried };
    fallback ??= plan;
  }
  return { direct: null, plan: fallback, tried };
}
