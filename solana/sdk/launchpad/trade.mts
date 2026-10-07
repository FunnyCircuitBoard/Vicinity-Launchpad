// Ready-to-sign instruction lists for the things a person does with a city
// coin: launch it, buy, sell, swap one coin for another, and graduate it.
//
// Each builder returns @solana/kit-shaped instructions (see idl.mjs: address
// strings and numeric roles), including the small setup steps a wallet needs:
// creating the trader's token accounts if they are missing, wrapping SOL into
// WSOL before a buy and unwrapping what is left afterwards. Every trade that
// carries the vicinity.city referral first (re)creates the dev wallet's
// referral account if it is missing (an idempotent step that costs nothing
// when the account exists): Meteora refuses a trade whose referral account
// does not exist, and the dev wallet closes it whenever it unwraps its WSOL.
// Every curve buy is sent as DBC's partial fill: below the graduation price it
// is exactly an exact-in buy, and the last buy of a curve takes what the curve
// can still sell and refunds the rest instead of failing. `toV0Transaction`
// turns a list into an unsigned versioned transaction (with lookup tables) and
// `txBytes` measures it against Solana's 1,232-byte limit.
//
// Nothing here signs or sends. Trading is Meteora DBC `swap2`; our program is
// only involved in `buildLaunch` (LAUNCHPAD-DESIGN.md 6.3 and 9.6).
import web3 from '@solana/web3.js';
import type { AddressLookupTableAccount, VersionedTransaction as VersionedTransactionT, TransactionInstruction as TransactionInstructionT } from '@solana/web3.js';
import * as C from './client.mjs';
import { Role } from './idl.mjs';
import { ADDRESSES, PROGRAM_IDS, ata } from './pda.mjs';
import { SwapMode } from './curve.mjs';
import type { Address, CoinAccount } from './accounts.mts';

const { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } = web3;

/** Solana's packet limit for one transaction. */
export const MAX_TX_BYTES = 1232;
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
/** Compute limits measured in tests-launchpad (LAUNCHPAD-AUDIT.md 5.1), with headroom. */
export const CU = Object.freeze({ launch: 300_000, launchWithBuy: 400_000, swap: 120_000, coinToCoin: 200_000, graduate: 400_000, leftover: 80_000 });
/** Most priority fee a transaction built here may carry: 0.01 SOL (compute-unit price x limit). */
export const MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n;
/** What a priority fee costs: price (micro-lamports per compute unit) x limit, rounded up. */
export function priorityFeeLamports(microLamportsPerCu: bigint, cuLimit: number): bigint {
  return (microLamportsPerCu * BigInt(cuLimit) + 999_999n) / 1_000_000n;
}
/** The highest compute-unit price that keeps the priority fee within `maxFee` at `cuLimit`. */
export function maxCuPrice(cuLimit: number, maxFee: bigint = MAX_PRIORITY_FEE_LAMPORTS): bigint {
  return (maxFee * 1_000_000n) / BigInt(Math.max(1, cuLimit));
}

/** A @solana/kit-shaped instruction: role 0 read-only, 1 writable, 2 read-only signer, 3 writable signer. */
export interface Ix { programAddress: Address; accounts: { address: Address; role: number }[]; data: Uint8Array }
/** What a trade needs to know about a coin (a decoded `Coin` has all of it). */
export type CoinRef = Pick<CoinAccount, 'mint' | 'quoteMint' | 'dbcPool' | 'dbcConfig'> & { cityId?: bigint };

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

// ---------------------------------------------------------------- small instructions
export function setComputeUnitLimit(units: number): Ix {
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: new Uint8Array([2, ...u32(units)]) };
}
export function setComputeUnitPrice(microLamports: bigint): Ix {
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: new Uint8Array([3, ...u64(microLamports)]) };
}
export function systemTransfer(from: Address, to: Address, lamports: bigint): Ix {
  return { programAddress: PROGRAM_IDS.system, accounts: [{ address: from, role: Role.WS }, { address: to, role: Role.W }], data: new Uint8Array([...u32(2), ...u64(lamports)]) };
}
export function syncNative(account: Address): Ix {
  return { programAddress: PROGRAM_IDS.token, accounts: [{ address: account, role: Role.W }], data: new Uint8Array([17]) };
}
export function closeTokenAccount(account: Address, destination: Address, owner: Address): Ix {
  return { programAddress: PROGRAM_IDS.token, accounts: [{ address: account, role: Role.W }, { address: destination, role: Role.W }, { address: owner, role: Role.RS }], data: new Uint8Array([9]) };
}
/** Associated-token "create idempotent": makes `owner`'s account for `mint` if missing, else does nothing. */
export function createAta(payer: Address, owner: Address, mint: Address, tokenProgram: Address = PROGRAM_IDS.token): Ix {
  return C.createAtaIdempotent({ payer, owner, mint, tokenProgram }) as Ix;
}
/** Wrap `lamports` of the trader's SOL into their WSOL account (created if missing). */
export function wrapSol(owner: Address, lamports: bigint, payer: Address = owner): Ix[] {
  const wsolAta = ata(owner, ADDRESSES.wsol);
  return [createAta(payer, owner, ADDRESSES.wsol), systemTransfer(owner, wsolAta, lamports), syncNative(wsolAta)];
}
/** Close the trader's WSOL account: everything in it comes back as plain SOL. */
export function unwrapSol(owner: Address): Ix {
  return closeTokenAccount(ata(owner, ADDRESSES.wsol), owner, owner);
}

/** The vicinity.city referral account for a quote token: the dev wallet's account (worth 20% of Meteora's cut). */
export function referralAccount(quoteMint: Address): Address {
  return ata(ADDRESSES.feeRecipient, quoteMint);
}
/**
 * Create the dev wallet's referral account for a quote token if it is missing
 * (idempotent: nothing happens when it exists). Anyone may pay. Every trade
 * builder here prepends it by default; setup.mjs and the keeper create it too.
 */
export function createReferralAccount(payer: Address, quoteMint: Address): Ix {
  return createAta(payer, ADDRESSES.feeRecipient, quoteMint);
}
/**
 * The referral account a trade uses (undefined = none) and the setup step that
 * makes sure it exists. `referral`: undefined = the dev wallet's account for
 * the quote token, null = no referral, or another account. `ensure` defaults
 * to true for the dev wallet's account (the only one we know how to create).
 */
export function referralFor(quoteMint: Address, payer: Address, referral?: Address | null, ensure?: boolean): { referral: Address | undefined; setup: Ix[] } {
  if (referral === null) return { referral: undefined, setup: [] };
  const ref = referral ?? referralAccount(quoteMint);
  const isDevWallets = ref === referralAccount(quoteMint);
  if (ensure && !isDevWallets) throw new Error('ensureReferralAccount only knows how to create the dev wallet\'s referral account');
  return { referral: ref, setup: (ensure ?? isDevWallets) && isDevWallets ? [createReferralAccount(payer, quoteMint)] : [] };
}

// ---------------------------------------------------------------- trading
export interface TradeCommon {
  trader: Address;
  coin: CoinRef;
  /** referral token account: default the dev wallet's account for the quote token; null for none */
  referral?: Address | null;
  /** wrap/unwrap SOL around the trade when the quote token is WSOL (default true) */
  handleSol?: boolean;
  /**
   * prepend the idempotent creation of the dev wallet's referral account
   * (default true whenever the trade uses it: a missing referral account makes
   * Meteora refuse the trade, and the dev wallet closes it when it unwraps SOL)
   */
  ensureReferralAccount?: boolean;
}
const isWsol = (m: Address) => m === ADDRESSES.wsol;
function referralOf(t: TradeCommon): Address | undefined {
  return referralFor(t.coin.quoteMint, t.trader, t.referral, false).referral;
}
function referralSetup(t: TradeCommon): Ix[] {
  return referralFor(t.coin.quoteMint, t.trader, t.referral, t.ensureReferralAccount).setup;
}
// client.mjs is JavaScript; its swap builder takes the mode as a plain number.
const dbcSwap2 = C.swap as unknown as (args: Record<string, unknown>) => Ix;
function swapIx(t: TradeCommon, side: 'buy' | 'sell', mode: number, amount0: bigint, amount1: bigint, outputAccount?: Address): Ix {
  return dbcSwap2({
    trader: t.trader, pool: t.coin.dbcPool, config: t.coin.dbcConfig, baseMint: t.coin.mint, quoteMint: t.coin.quoteMint,
    side, mode, amount0, amount1, referral: referralOf(t), outputAccount,
  });
}

/**
 * Buy coins: `amountIn` quote, at least `minOut` coins. Partial fill (mode 1,
 * the default) is exactly an exact-in buy below the graduation price; for the
 * last buy of a curve it takes only what the curve can still sell and leaves
 * the rest with the buyer instead of failing. Mode 0 (strict exact in) is
 * still available. With SOL as the quote token the SOL is wrapped first and
 * whatever is left (a partial-fill refund) is unwrapped afterwards; with
 * another quote token the trader's account for it must already hold it.
 */
export function buildBuy(t: TradeCommon & { amountIn: bigint; minOut: bigint; mode?: 0 | 1 }): Ix[] {
  if (t.amountIn <= 0n) throw new RangeError('amountIn must be positive');
  if (t.minOut <= 0n) throw new RangeError('minOut must be positive: a buy that may return 0 coins is refused');
  const sol = (t.handleSol ?? true) && isWsol(t.coin.quoteMint);
  const ixs: Ix[] = [...referralSetup(t)];
  if (sol) ixs.push(...wrapSol(t.trader, t.amountIn));
  ixs.push(createAta(t.trader, t.trader, t.coin.mint));
  ixs.push(swapIx(t, 'buy', t.mode ?? SwapMode.PartialFill, t.amountIn, t.minOut));
  if (sol) ixs.push(unwrapSol(t.trader));
  return ixs;
}
/** Buy exactly `amountOut` coins, paying at most `maxIn` quote (fee included). */
export function buildBuyExactOut(t: TradeCommon & { amountOut: bigint; maxIn: bigint }): Ix[] {
  if (t.amountOut <= 0n) throw new RangeError('amountOut must be positive');
  const sol = (t.handleSol ?? true) && isWsol(t.coin.quoteMint);
  const ixs: Ix[] = [...referralSetup(t)];
  if (sol) ixs.push(...wrapSol(t.trader, t.maxIn));
  ixs.push(createAta(t.trader, t.trader, t.coin.mint));
  ixs.push(swapIx(t, 'buy', SwapMode.ExactOut, t.amountOut, t.maxIn));
  if (sol) ixs.push(unwrapSol(t.trader));
  return ixs;
}
/** Sell `amountIn` coins for at least `minOut` quote (exact in), or (mode 2) exactly `amountOut` quote for at most `maxIn` coins. */
export function buildSell(t: TradeCommon & ({ amountIn: bigint; minOut: bigint; mode?: 0 } | { amountOut: bigint; maxIn: bigint; mode: 2 })): Ix[] {
  if ('amountOut' in t ? t.amountOut <= 0n : t.minOut <= 0n) throw new RangeError('a sell that may return nothing is refused (minOut or amountOut must be positive)');
  const sol = (t.handleSol ?? true) && isWsol(t.coin.quoteMint);
  const ixs: Ix[] = [...referralSetup(t)];
  ixs.push(createAta(t.trader, t.trader, t.coin.quoteMint));
  if ('amountOut' in t) ixs.push(swapIx(t, 'sell', SwapMode.ExactOut, t.amountOut, t.maxIn));
  else ixs.push(swapIx(t, 'sell', SwapMode.ExactIn, t.amountIn, t.minOut));
  if (sol) ixs.push(unwrapSol(t.trader));
  return ixs;
}
/**
 * Coin A to coin B (both priced in the same quote token) in one transaction:
 * sell A for at least `quoteMin`, buy B with exactly `quoteMin` for at least
 * `minOut`. If B's minimum is missed, everything reverts. Use quoteCoinToCoin
 * for the numbers. The buy is a partial fill by default (`buyMode` 1): it
 * stops at B's graduation price and the rest stays as the quote token.
 */
export function buildCoinToCoin({ trader, from, to, amountIn, quoteMin, minOut, referral, handleSol = true, buyMode = SwapMode.PartialFill, ensureReferralAccount }: { trader: Address; from: CoinRef; to: CoinRef; amountIn: bigint; quoteMin: bigint; minOut: bigint; referral?: Address | null; handleSol?: boolean; buyMode?: 0 | 1; ensureReferralAccount?: boolean }): Ix[] {
  if (from.quoteMint !== to.quoteMint) throw new Error('coin to coin in one transaction needs both coins priced in the same quote token; otherwise sell, then pay with anything');
  if (amountIn <= 0n || quoteMin <= 0n || minOut <= 0n) throw new RangeError('amountIn, quoteMin and minOut must be positive');
  const sol = handleSol && isWsol(from.quoteMint);
  return [
    ...referralFor(from.quoteMint, trader, referral, ensureReferralAccount).setup,
    createAta(trader, trader, from.quoteMint),
    createAta(trader, trader, to.mint),
    swapIx({ trader, coin: from, referral }, 'sell', SwapMode.ExactIn, amountIn, quoteMin),
    swapIx({ trader, coin: to, referral }, 'buy', buyMode, quoteMin, minOut),
    ...(sol ? [unwrapSol(trader)] : []),
  ];
}

// ---------------------------------------------------------------- launch and graduation
export interface LaunchParams {
  founder: Address;
  /** pays rent and the launch fee (usually the founder) */
  payer?: Address;
  /** the new coin's address: a fresh keypair that signs the transaction */
  baseMint: Address;
  cityId: bigint;
  dbcConfig: Address;
  quoteMint: Address;
  /** the approval's rent_payer (the admin who approved), refunded when the approval closes */
  rentPayer: Address;
  /** the founder's first buy in the same transaction (partial fill by default) */
  firstBuy?: { amountIn: bigint; minOut: bigint; mode?: 0 | 1 };
}
/**
 * `launch` (our program creates the coin through DBC with the Coin PDA as its
 * creator), optionally followed by the founder's first buy. Signers: founder,
 * payer and baseMint. The launch alone is about 1,050 bytes, so the first buy
 * only fits with the Vicinity lookup table; otherwise send it straight after
 * (planLaunch decides).
 */
export function buildLaunch(p: LaunchParams): Ix[] {
  const ixs: Ix[] = [C.launch({ founder: p.founder, payer: p.payer ?? p.founder, baseMint: p.baseMint, cityId: p.cityId, dbcConfig: p.dbcConfig, quoteMint: p.quoteMint, rentPayer: p.rentPayer }) as Ix];
  if (p.firstBuy) {
    const a = C.launchAccounts({ cityId: p.cityId, baseMint: p.baseMint, dbcConfig: p.dbcConfig, quoteMint: p.quoteMint });
    ixs.push(...buildBuy({ trader: p.founder, coin: { mint: p.baseMint, quoteMint: p.quoteMint, dbcPool: a.pool, dbcConfig: p.dbcConfig }, amountIn: p.firstBuy.amountIn, minOut: p.firstBuy.minOut, mode: p.firstBuy.mode }));
  }
  return ixs;
}
/** The DBC pool address a launch will create (known before the launch, from the fresh mint). */
export function launchPoolAddress(p: Pick<LaunchParams, 'cityId' | 'baseMint' | 'dbcConfig' | 'quoteMint'>): Address {
  return C.launchAccounts(p).pool;
}

/**
 * Graduation (permissionless): DBC moves the completed curve into a DAMM v2
 * pool with locked liquidity. `firstNftMint`/`secondNftMint` are fresh
 * keypairs that sign. Needs a 400,000 compute limit; the payer repays about
 * 0.033 SOL of rent.
 */
export function buildGraduate({ payer, coin, firstNftMint, secondNftMint }: { payer: Address; coin: CoinRef; firstNftMint: Address; secondNftMint: Address }): Ix[] {
  return [C.migrateToDammV2({ payer, dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, quoteMint: coin.quoteMint, firstNftMint, secondNftMint }) as Ix];
}
/** After graduation: send the unsold dust to the dev wallet (creating its coin account if needed). Permissionless. */
export function buildWithdrawLeftover({ payer, coin }: { payer: Address; coin: CoinRef }): Ix[] {
  return [
    createAta(payer, ADDRESSES.feeRecipient, coin.mint),
    C.withdrawLeftover({ dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, receiverAccount: ata(ADDRESSES.feeRecipient, coin.mint) }) as Ix,
  ];
}
/** Trade a graduated coin on its DAMM v2 pool (the coin is token A, the quote token B). */
export function buildPoolSwap({ trader, coin, dammPool, side, amountIn, minOut, handleSol = true }: { trader: Address; coin: CoinRef; dammPool: Address; side: 'buy' | 'sell'; amountIn: bigint; minOut: bigint; handleSol?: boolean }): Ix[] {
  const sol = handleSol && isWsol(coin.quoteMint);
  const ixs: Ix[] = [];
  if (side === 'buy' && sol) ixs.push(...wrapSol(trader, amountIn));
  if (side === 'sell') ixs.push(createAta(trader, trader, coin.quoteMint));
  else ixs.push(createAta(trader, trader, coin.mint));
  ixs.push(C.dammSwap({ trader, pool: dammPool, mintA: coin.mint, mintB: coin.quoteMint, aToB: side === 'sell', amountIn, minOut }) as Ix);
  if (sol) ixs.push(unwrapSol(trader));
  return ixs;
}

// ---------------------------------------------------------------- transactions
export function toWeb3Instruction(ix: Ix): TransactionInstructionT {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: (a.role & 2) !== 0, isWritable: (a.role & 1) !== 0 })),
    data: Buffer.from(ix.data),
  });
}
export function fromWeb3Instruction(ix: TransactionInstructionT): Ix {
  return { programAddress: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ address: k.pubkey.toBase58(), role: (k.isSigner ? 2 : 0) | (k.isWritable ? 1 : 0) })), data: new Uint8Array(ix.data) };
}

/** A placeholder blockhash for measuring (any 32 bytes: the size does not depend on it). */
export const MEASURE_BLOCKHASH = '11111111111111111111111111111111';

/**
 * An unsigned v0 transaction. A compute limit is prepended when `cuLimit` is
 * given (and a price when `cuPrice` is). Lookup tables shrink it; signatures
 * are left empty for the wallet to fill. Refuses a priority fee above
 * `maxPriorityFee` (default 0.01 SOL), counting `cuPrice` and any
 * compute-unit price instruction in `instructions`.
 */
export function toV0Transaction({ payer, instructions, blockhash = MEASURE_BLOCKHASH, lookupTables = [], cuLimit, cuPrice, maxPriorityFee = MAX_PRIORITY_FEE_LAMPORTS }: { payer: Address; instructions: Ix[]; blockhash?: string; lookupTables?: AddressLookupTableAccount[]; cuLimit?: number; cuPrice?: bigint; maxPriorityFee?: bigint }): VersionedTransactionT {
  const prices = [...(cuPrice ? [cuPrice] : []), ...instructions.filter((i) => i.programAddress === COMPUTE_BUDGET_PROGRAM && i.data[0] === 3).map((i) => Buffer.from(i.data).readBigUInt64LE(1))];
  for (const p of prices) {
    const fee = priorityFeeLamports(p, cuLimit ?? 1_400_000);
    if (fee > maxPriorityFee) throw new Error(`priority fee ${fee} lamports is above the ${maxPriorityFee}-lamport cap`);
  }
  const all = [...(cuLimit ? [setComputeUnitLimit(cuLimit)] : []), ...(cuPrice ? [setComputeUnitPrice(cuPrice)] : []), ...instructions];
  const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: all.map(toWeb3Instruction) }).compileToV0Message(lookupTables);
  return new VersionedTransaction(msg);
}
/** Wire size of a transaction (signatures included, as 64-byte slots). Throws when it cannot even be serialized. */
export function txBytes(tx: VersionedTransactionT): number {
  return tx.serialize().length;
}
/** Size of these instructions as one v0 transaction, or Infinity when they cannot be compiled into one. */
export function measure(payer: Address, instructions: Ix[], lookupTables: AddressLookupTableAccount[] = [], cuLimit = 200_000): number {
  try { return txBytes(toV0Transaction({ payer, instructions, lookupTables, cuLimit })); } catch { return Infinity; }
}
/** Addresses that must sign these instructions (the fee payer first). */
export function requiredSigners(payer: Address, instructions: Ix[]): Address[] {
  const s = new Set<Address>([payer]);
  for (const ix of instructions) for (const a of ix.accounts) if (a.role & 2) s.add(a.address);
  return [...s];
}

export interface PlannedTx { label: string; instructions: Ix[]; cuLimit: number; bytes: number; signers: Address[] }
/**
 * Launch plan: one transaction with the founder's first buy when it fits
 * (needs the Vicinity lookup table), else the launch and then the buy.
 */
export function planLaunch(p: LaunchParams, lookupTables: AddressLookupTableAccount[] = []): PlannedTx[] {
  const payer = p.payer ?? p.founder;
  const all = buildLaunch(p);
  const one = measure(payer, all, lookupTables, CU.launchWithBuy);
  if (!p.firstBuy || one <= MAX_TX_BYTES) return [{ label: p.firstBuy ? 'launch + first buy' : 'launch', instructions: all, cuLimit: p.firstBuy ? CU.launchWithBuy : CU.launch, bytes: one, signers: requiredSigners(payer, all) }];
  const launchOnly = all.slice(0, 1), buy = all.slice(1);
  return [
    { label: 'launch', instructions: launchOnly, cuLimit: CU.launch, bytes: measure(payer, launchOnly, lookupTables, CU.launch), signers: requiredSigners(payer, launchOnly) },
    { label: 'first buy', instructions: buy, cuLimit: CU.swap, bytes: measure(p.founder, buy, lookupTables, CU.swap), signers: requiredSigners(p.founder, buy) },
  ];
}
