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
// API: GET https://api.jup.ag/swap/v2/build (ExactIn only; raw instructions,
// lookup tables and a blockhash). Keyless access allows 0.5 requests per
// second; production passes an API key (x-api-key), kept in a Worker secret.
import web3 from '@solana/web3.js';
import type { AddressLookupTableAccount as AltT, VersionedTransaction as VersionedTransactionT, Connection } from '@solana/web3.js';
import { ADDRESSES, PROGRAM_IDS, ata } from './pda.mjs';
import { SwapMode } from './curve.mjs';
import { buildBuy, createAta, setComputeUnitLimit, toV0Transaction, txBytes, unwrapSol, COMPUTE_BUDGET_PROGRAM, MAX_TX_BYTES, CU, referralAccount } from './trade.mts';
import type { Ix, CoinRef } from './trade.mts';
import * as C from './client.mjs';
import type { Address } from './accounts.mts';

const { AddressLookupTableAccount, PublicKey } = web3;

export const JUPITER_API = 'https://api.jup.ag';
/** Jupiter's aggregator program (the swap instruction must call it). */
export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** Programs Jupiter's setup and cleanup instructions may call (account creation, wrapping, closing). */
export const JUPITER_HELPER_PROGRAMS = Object.freeze([PROGRAM_IDS.ata, PROGRAM_IDS.token, PROGRAM_IDS.token2022, PROGRAM_IDS.system, COMPUTE_BUDGET_PROGRAM]);
/** Route sizes to try for a SOL-priced coin (smaller routes leave room for our buy); VICINITY routes only at 64. */
export const MAX_ACCOUNTS_STEPS = Object.freeze([40, 32, 24]);
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

/**
 * Refuse a Jupiter response that does not do what we asked: ExactIn between
 * the expected mints, the trader as the only signer, the swap through Jupiter's
 * program, helpers only from the account/token/system programs, and the output
 * landing in the trader's own account for the output mint.
 */
export function checkJupiterBuild(build: JupiterBuild, { trader, inputMint, outputMint, inAmount, jupiterProgram = JUPITER_PROGRAM }: { trader: Address; inputMint: Address; outputMint: Address; inAmount?: bigint; jupiterProgram?: Address }): void {
  const fail = (m: string) => { throw new Error(`Jupiter response refused: ${m}`); };
  if (build.swapMode !== 'ExactIn') fail(`swapMode ${build.swapMode}, expected ExactIn`);
  if (build.inputMint !== inputMint) fail(`input mint ${build.inputMint}, expected ${inputMint}`);
  if (build.outputMint !== outputMint) fail(`output mint ${build.outputMint}, expected ${outputMint}`);
  if (inAmount !== undefined && BigInt(build.inAmount) !== inAmount) fail(`in amount ${build.inAmount}, expected ${inAmount}`);
  if (BigInt(build.otherAmountThreshold) <= 0n) fail('zero guaranteed output');
  if (BigInt(build.otherAmountThreshold) > BigInt(build.outAmount)) fail('guaranteed output above the quoted output');
  if (build.swapInstruction.programId !== jupiterProgram) fail(`swap program ${build.swapInstruction.programId}`);
  const all = [...build.computeBudgetInstructions, ...build.setupInstructions, build.swapInstruction, ...(build.cleanupInstruction ? [build.cleanupInstruction] : []), ...build.otherInstructions, ...(build.tipInstruction ? [build.tipInstruction] : [])];
  for (const i of all) for (const a of i.accounts) if (a.isSigner && a.pubkey !== trader) fail(`unexpected signer ${a.pubkey}`);
  for (const i of [...build.setupInstructions, ...(build.cleanupInstruction ? [build.cleanupInstruction] : []), ...build.otherInstructions]) {
    if (!JUPITER_HELPER_PROGRAMS.includes(i.programId)) fail(`helper instruction calls ${i.programId}`);
  }
  for (const i of build.computeBudgetInstructions) if (i.programId !== COMPUTE_BUDGET_PROGRAM) fail('compute budget instruction calls another program');
  if (build.tipInstruction) fail('tip instructions are not used (send through your own RPC)');
  const outs = [ata(trader, outputMint, PROGRAM_IDS.token), ata(trader, outputMint, PROGRAM_IDS.token2022)];
  if (!build.swapInstruction.accounts.some((a) => outs.includes(a.pubkey) && a.isWritable)) fail(`the swap does not pay into the trader's own ${outputMint} account`);
}

/** Jupiter's compute-unit price instruction(s) only: we set the limit ourselves. */
function cuPriceOnly(build: JupiterBuild): Ix[] {
  return build.computeBudgetInstructions.map(jupiterIx).filter((ix) => ix.data[0] === 3);
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
 * and `outputMint = coin.quoteMint`.
 */
export function composePayWithAnything({ build, trader, coin, minCoinsOut, buyMode = SwapMode.ExactIn, referral, lookupTables = [], cuLimit = DEFAULT_PAY_CU, maxBytes = MAX_TX_BYTES, jupiterProgram }: {
  build: JupiterBuild; trader: Address; coin: CoinRef; minCoinsOut: bigint; buyMode?: 0 | 1;
  referral?: Address | null; lookupTables?: AltT[]; cuLimit?: number; maxBytes?: number;
  /** tests only: the program the swap instruction must call (default: Jupiter's) */
  jupiterProgram?: Address;
}): PayPlan {
  checkJupiterBuild(build, { trader, inputMint: build.inputMint, outputMint: coin.quoteMint, jupiterProgram });
  if (minCoinsOut <= 0n) throw new Error('minCoinsOut must be positive');
  const buyAmountIn = BigInt(build.otherAmountThreshold);
  const alts = [...jupiterLookupTables(build), ...lookupTables];
  const { blockhash } = jupiterBlockhash(build);
  const sol = coin.quoteMint === ADDRESSES.wsol;
  const ref = referral === null ? undefined : (referral ?? referralAccount(coin.quoteMint));
  const swap = C.swap as unknown as (a: Record<string, unknown>) => Ix;
  const buyIx = swap({
    trader, pool: coin.dbcPool, config: coin.dbcConfig, baseMint: coin.mint, quoteMint: coin.quoteMint, side: 'buy', mode: buyMode,
    amount0: buyAmountIn, amount1: minCoinsOut, referral: ref,
  });
  const route = build.routePlan.map((r) => r.swapInfo.label).join(' > ');
  const notes: string[] = [];
  const one: Ix[] = [
    ...cuPriceOnly(build),
    ...build.setupInstructions.map(jupiterIx),
    jupiterIx(build.swapInstruction),
    createAta(trader, trader, coin.mint),
    buyIx,
    ...(build.cleanupInstruction ? [jupiterIx(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(jupiterIx),
  ];
  const base = {
    buyAmountIn, minCoinsOut, expectedSurplus: BigInt(build.outAmount) - buyAmountIn,
    surplusKept: (sol && build.cleanupInstruction ? 'SOL' : 'quote token') as PayPlan['surplusKept'], route,
  };
  let bytes = Infinity;
  let tx: VersionedTransactionT | null = null;
  try { tx = toV0Transaction({ payer: trader, instructions: one, blockhash, lookupTables: alts, cuLimit }); bytes = txBytes(tx); } catch { /* too many accounts or too large to serialize */ }
  if (tx && bytes <= maxBytes) {
    return { mode: 'one-transaction', transactions: [{ label: 'swap and buy', instructions: one, lookupTables: alts, cuLimit, bytes, tx }], ...base, notes };
  }
  notes.push(`swap plus buy is ${Number.isFinite(bytes) ? `${bytes} bytes` : 'too large'} (limit ${maxBytes}): sent as two transactions, swap then buy`);
  // two transactions: Jupiter exactly as returned (its cleanup unwraps SOL), then a plain buy of the guaranteed minimum
  const swapOnly: Ix[] = [...cuPriceOnly(build), ...build.setupInstructions.map(jupiterIx), jupiterIx(build.swapInstruction), ...(build.cleanupInstruction ? [jupiterIx(build.cleanupInstruction)] : []), ...build.otherInstructions.map(jupiterIx)];
  const tx1 = toV0Transaction({ payer: trader, instructions: swapOnly, blockhash, lookupTables: alts, cuLimit });
  const buyOnly = buildBuy({ trader, coin, amountIn: buyAmountIn, minOut: minCoinsOut, mode: buyMode, referral: referral === null ? null : ref, handleSol: sol });
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

export interface SellPlan { mode: 'one-transaction' | 'two-transactions'; transactions: PlannedTransaction[]; minQuoteOut: bigint; minAssetOut: bigint; route: string; notes: string[] }
/**
 * Sell a coin, then swap the quote token into another asset (BTC, ETH, a
 * stock token...). `build` must be ExactIn from the coin's quote token, for
 * exactly `minQuoteOut` (the sell's guaranteed minimum), with
 * wrapAndUnwrapSol=false so Jupiter spends the WSOL the sell delivered. Any
 * quote above the minimum stays with the seller (unwrapped to SOL).
 */
export function composeSellIntoAnything({ build, trader, coin, coinAmountIn, minQuoteOut, referral, lookupTables = [], cuLimit = DEFAULT_PAY_CU, maxBytes = MAX_TX_BYTES, jupiterProgram }: {
  build: JupiterBuild; trader: Address; coin: CoinRef; coinAmountIn: bigint; minQuoteOut: bigint;
  referral?: Address | null; lookupTables?: AltT[]; cuLimit?: number; maxBytes?: number;
  /** tests only: the program the swap instruction must call (default: Jupiter's) */
  jupiterProgram?: Address;
}): SellPlan {
  checkJupiterBuild(build, { trader, inputMint: coin.quoteMint, outputMint: build.outputMint, inAmount: minQuoteOut, jupiterProgram });
  const sol = coin.quoteMint === ADDRESSES.wsol;
  if (sol && build.setupInstructions.some((i) => i.programId === PROGRAM_IDS.system)) throw new Error('ask Jupiter with wrapAndUnwrapSol=false: the sell already delivers WSOL');
  const alts = [...jupiterLookupTables(build), ...lookupTables];
  const { blockhash } = jupiterBlockhash(build);
  const ref = referral === null ? undefined : (referral ?? referralAccount(coin.quoteMint));
  const swap = C.swap as unknown as (a: Record<string, unknown>) => Ix;
  const sellIx = swap({ trader, pool: coin.dbcPool, config: coin.dbcConfig, baseMint: coin.mint, quoteMint: coin.quoteMint, side: 'sell', mode: SwapMode.ExactIn, amount0: coinAmountIn, amount1: minQuoteOut, referral: ref });
  const sellPart: Ix[] = [createAta(trader, trader, coin.quoteMint), sellIx];
  const jupPart: Ix[] = [...build.setupInstructions.map(jupiterIx), jupiterIx(build.swapInstruction), ...(build.cleanupInstruction ? [jupiterIx(build.cleanupInstruction)] : []), ...build.otherInstructions.map(jupiterIx)];
  // unwrap what the sell delivered above the minimum, unless Jupiter's own cleanup already closes that WSOL account
  const wsolAta = ata(trader, ADDRESSES.wsol);
  const jupiterCloses = !!build.cleanupInstruction && Buffer.from(build.cleanupInstruction.data, 'base64')[0] === 9 && build.cleanupInstruction.accounts[0]?.pubkey === wsolAta;
  const tail: Ix[] = sol && !jupiterCloses ? [unwrapSol(trader)] : [];
  const route = build.routePlan.map((r) => r.swapInfo.label).join(' > ');
  const minAssetOut = BigInt(build.otherAmountThreshold);
  const all = [...cuPriceOnly(build), ...sellPart, ...jupPart, ...tail];
  let bytes = Infinity, tx: VersionedTransactionT | null = null;
  try { tx = toV0Transaction({ payer: trader, instructions: all, blockhash, lookupTables: alts, cuLimit }); bytes = txBytes(tx); } catch { /* too large */ }
  if (tx && bytes <= maxBytes) return { mode: 'one-transaction', transactions: [{ label: 'sell and swap', instructions: all, lookupTables: alts, cuLimit, bytes, tx }], minQuoteOut, minAssetOut, route, notes: [] };
  const s = [...sellPart];
  const j = [...cuPriceOnly(build), ...jupPart, ...tail];
  const tx1 = toV0Transaction({ payer: trader, instructions: s, blockhash, lookupTables, cuLimit: CU.swap });
  const tx2 = toV0Transaction({ payer: trader, instructions: j, blockhash, lookupTables: alts, cuLimit });
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
 *   * paying with the quote token itself (SOL for a SOL-priced coin) needs no swap;
 *   * otherwise ask Jupiter at decreasing route sizes until swap + buy fit one
 *     transaction; VICINITY routes only at 64, so it is planned as two.
 * `minCoinsOutFor(quoteIn)` turns the guaranteed quote amount into the least
 * coins accepted (quoteBuy(...).minOut for the live pool).
 */
export async function planPayWithAnything({ payMint, amount, trader, coin, slippageBps, minCoinsOutFor, lookupTables = [], apiKey, fetchImpl }: {
  payMint: Address; amount: bigint; trader: Address; coin: CoinRef; slippageBps: number;
  minCoinsOutFor: (quoteIn: bigint) => bigint; lookupTables?: AltT[]; apiKey?: string; fetchImpl?: FetchLike;
}): Promise<{ direct: Ix[] | null; plan: PayPlan | null; tried: { maxAccounts: number; result: string }[] }> {
  if (payMint === coin.quoteMint) {
    return { direct: buildBuy({ trader, coin, amountIn: amount, minOut: minCoinsOutFor(amount) }), plan: null, tried: [] };
  }
  const steps = coin.quoteMint === ADDRESSES.wsol ? [...MAX_ACCOUNTS_STEPS] : [64];
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
    const plan = composePayWithAnything({ build, trader, coin, minCoinsOut: minCoinsOutFor(BigInt(build.otherAmountThreshold)), lookupTables });
    tried.push({ maxAccounts, result: `${plan.mode} (${plan.transactions.map((t) => t.bytes).join(' + ')} bytes)` });
    if (plan.mode === 'one-transaction') return { direct: null, plan, tried };
    fallback ??= plan;
  }
  return { direct: null, plan: fallback, tried };
}
