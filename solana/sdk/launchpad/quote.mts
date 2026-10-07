// Trade quotes for Vicinity coins, exactly as the chain computes them.
//
// Buys and sells run inside Meteora DBC (our program never prices anything),
// so every number here comes from `curve.mjs`, an exact BigInt copy of DBC
// 0.2.1's swap maths, plus the one piece of maths our own program does: the
// 50/50 split of the city's fee share between holders and founder
// (programs/vicinity-launchpad/src/math.rs `split_fee`). Parity with the real
// programs is tested over many random trades in tests-launchpad/12-client-sdk.
//
// Units: every amount is a bigint in raw units (lamports for SOL, 10^-6 coin
// for a city coin). Slippage is in basis points (100 = 1%).
import { quoteSwap, applySwap, SwapMode, Direction, CurveError, FEE_DENOMINATOR } from './curve.mjs';
import type { CurveConfig } from './accounts.mts';

export { SwapMode, Direction, CurveError, FEE_DENOMINATOR };
export const BPS = 10_000n;
/** 50%: anything above this is almost certainly a typo, so the helpers refuse it. */
export const MAX_SLIPPAGE_BPS = 5_000;
export const COIN_DECIMALS = 6;
export const COIN_SUPPLY_RAW = 10n ** 15n;
const Q128 = 1n << 128n;

/** The part of a DBC pool a quote needs (decodeDbcPool returns more). */
export interface PoolLike { sqrtPrice: bigint; quoteReserve: bigint; baseReserve?: bigint }
/** The part of a DBC config a quote needs (decodeDbcConfig returns it). */
export type CurveLike = Pick<CurveConfig, 'curve' | 'sqrtStartPrice' | 'migrationSqrtPrice' | 'migrationQuoteThreshold' | 'feeNumerator' | 'creatorTradingFeePercentage'>;

export interface FeeBreakdown {
  /** the whole trade fee (rounded up, in the pool's favour) */
  total: bigint;
  /** Meteora's protocol cut, after the referral */
  meteora: bigint;
  /** paid to the referral account (the dev wallet's quote-token account on vicinity.city trades) */
  referral: bigint;
  /** the partner share: earmarked in the pool for the dev wallet */
  devWallet: bigint;
  /** the creator share: earmarked for the city (Coin PDA); our program later splits it */
  city: bigint;
  /** the city's share as split by our program if it were harvested on its own */
  holders: bigint;
  founder: bigint;
}
export interface TradeQuote {
  side: 'buy' | 'sell';
  /** DBC swap2 mode: 0 exact in, 1 partial fill, 2 exact out */
  mode: 0 | 1 | 2;
  /** what leaves the trader, fee included */
  amountIn: bigint;
  /** what the trader receives (fee already taken on a sell) */
  amountOut: bigint;
  /** the exact swap2 parameters to send: amount_0 and amount_1 (min out, or max in for exact out) */
  amount0: bigint;
  amount1: bigint;
  /** slippage bound actually used in amount1 */
  minOut: bigint | null;
  maxIn: bigint | null;
  fees: FeeBreakdown;
  /** partial fill: the part of amount0 the curve could not take (stays with the trader) */
  refund: bigint;
  /** this trade fills the curve to its target; the next step is graduation */
  completesCurve: boolean;
  sqrtPriceBefore: bigint;
  sqrtPriceAfter: bigint;
  /** execution price against the spot price before the trade, in basis points (always >= 0) */
  priceImpactBps: number;
  /** the pool after the trade, for chaining quotes */
  poolAfter: PoolLike;
}

export function checkSlippage(slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) throw new RangeError(`slippage must be an integer from 0 to ${MAX_SLIPPAGE_BPS} bps`);
  return BigInt(slippageBps);
}
/** Least acceptable output: rounded down. */
export function minOutWithSlippage(out: bigint, slippageBps: number): bigint {
  return (out * (BPS - checkSlippage(slippageBps))) / BPS;
}
/** Most acceptable input: rounded up. */
export function maxInWithSlippage(amountIn: bigint, slippageBps: number): bigint {
  const s = checkSlippage(slippageBps);
  return (amountIn * (BPS + s) + BPS - 1n) / BPS;
}

/** Our program's split of a harvested amount: founder gets floor(c/2), holders the rest (the odd unit). */
export function splitHarvest(c: bigint): { toHolders: bigint; toFounder: bigint } {
  if (c < 0n) throw new RangeError('negative amount');
  const toFounder = c / 2n;
  return { toHolders: c - toFounder, toFounder };
}

/** Spot price as an exact fraction: quote raw units per coin raw unit = sqrtPrice² / 2^128. */
export function spotPrice(sqrtPrice: bigint): { num: bigint; den: bigint } {
  return { num: sqrtPrice * sqrtPrice, den: Q128 };
}
/** Spot price for display: quote tokens per whole coin (a float; never use it for amounts). */
export function priceInQuote(sqrtPrice: bigint, quoteDecimals: number, coinDecimals = COIN_DECIMALS): number {
  const { num, den } = spotPrice(sqrtPrice);
  const scaled = (num * 10n ** 18n) / den; // 18 extra digits
  return (Number(scaled) / 1e18) * 10 ** (coinDecimals - quoteDecimals);
}
/** Market cap in quote raw units at the current price (whole supply, rounded down). */
export function marketCapRaw(sqrtPrice: bigint, supply: bigint = COIN_SUPPLY_RAW): bigint {
  const { num, den } = spotPrice(sqrtPrice);
  return (supply * num) / den;
}
/** How far the curve is towards its raise target, in basis points (10,000 = ready to graduate). */
export function curveProgressBps(pool: PoolLike, config: Pick<CurveConfig, 'migrationQuoteThreshold'>): number {
  if (pool.quoteReserve >= config.migrationQuoteThreshold) return 10_000;
  return Number((pool.quoteReserve * BPS) / config.migrationQuoteThreshold);
}

function impactBps(sqrtBefore: bigint, quoteAmount: bigint, coinAmount: bigint, side: 'buy' | 'sell'): number {
  if (coinAmount === 0n || quoteAmount === 0n) return 0;
  const spotNum = sqrtBefore * sqrtBefore; // spot = spotNum / Q128
  // execution price = quote / coin. buy: exec >= spot; sell: exec <= spot.
  const execOverSpot = (quoteAmount * Q128 * BPS) / (coinAmount * spotNum); // in bps
  const d = side === 'buy' ? execOverSpot - BPS : BPS - execOverSpot;
  return d < 0n ? 0 : Number(d);
}

type RawQuote = ReturnType<typeof quoteSwap>;
/** DBC accepts a trade that returns nothing (a 1-lamport buy gives 0 coins for a 1-lamport fee); the SDK refuses to quote it. */
function refuseNothingOut(q: RawQuote): void {
  if (q.out === 0n) throw new CurveError('AmountIsZero', 'this trade would return nothing; trade a larger amount');
}
function feesOf(q: RawQuote): FeeBreakdown {
  const { toHolders, toFounder } = splitHarvest(q.creator);
  return { total: q.fee, meteora: q.protocol, referral: q.referral, devWallet: q.partner, city: q.creator, holders: toHolders, founder: toFounder };
}
function finish(side: 'buy' | 'sell', mode: 0 | 1 | 2, q: RawQuote, pool: PoolLike, config: CurveLike, amount0: bigint, amount1: bigint, minOut: bigint | null, maxIn: bigint | null): TradeQuote {
  const after = applySwap({ ...pool, baseReserve: pool.baseReserve ?? 0n }, q);
  const excludedIn: bigint = q.excludedIn;
  return {
    side, mode, amountIn: q.includedIn, amountOut: q.out, amount0, amount1, minOut, maxIn, fees: feesOf(q),
    refund: side === 'buy' && mode === 1 ? amount0 - q.includedIn : 0n,
    completesCurve: after.quoteReserve >= config.migrationQuoteThreshold,
    sqrtPriceBefore: pool.sqrtPrice, sqrtPriceAfter: q.next,
    priceImpactBps: side === 'buy' ? impactBps(pool.sqrtPrice, excludedIn, q.out, 'buy') : impactBps(pool.sqrtPrice, q.grossOut ?? q.out, excludedIn, 'sell'),
    poolAfter: { sqrtPrice: after.sqrtPrice, quoteReserve: after.quoteReserve, baseReserve: after.baseReserve },
  };
}

export interface QuoteOptions { slippageBps?: number; /** the trade carries the vicinity.city referral account (default true) */ referral?: boolean }

/**
 * Buy with an exact amount of the quote token (fee included). If that amount
 * would push the price past the graduation price, the quote switches to DBC's
 * partial fill: the curve takes only what it needs to reach its target and the
 * rest stays with the buyer (`refund`). (buildBuy sends every buy as a partial
 * fill, which below the graduation price is the same trade.) A buy or sell
 * that would return nothing is refused (CurveError AmountIsZero).
 */
export function quoteBuy(pool: PoolLike, config: CurveLike, { amountIn, slippageBps = 100, referral = true }: QuoteOptions & { amountIn: bigint }): TradeQuote {
  const amount = BigInt(amountIn);
  let mode: 0 | 1 = SwapMode.ExactIn;
  let q: RawQuote;
  try {
    q = quoteSwap(pool, config, { direction: Direction.Buy, mode, amount0: amount, hasReferral: referral });
  } catch (e) {
    if (!(e instanceof CurveError) || (e as CurveError & { code: string }).code !== 'InsufficientLiquidity') throw e;
    mode = SwapMode.PartialFill;
    q = quoteSwap(pool, config, { direction: Direction.Buy, mode, amount0: amount, hasReferral: referral });
  }
  refuseNothingOut(q);
  const minOut = minOutWithSlippage(q.out, slippageBps);
  return finish('buy', mode, q, pool, config, amount, minOut, minOut, null);
}

/** Buy an exact number of coins; `amount1` is the most quote the buyer will pay (slippage included). */
export function quoteBuyExactOut(pool: PoolLike, config: CurveLike, { amountOut, slippageBps = 100, referral = true }: QuoteOptions & { amountOut: bigint }): TradeQuote {
  const q = quoteSwap(pool, config, { direction: Direction.Buy, mode: SwapMode.ExactOut, amount0: BigInt(amountOut), hasReferral: referral });
  const maxIn = maxInWithSlippage(q.includedIn, slippageBps);
  return finish('buy', SwapMode.ExactOut, q, pool, config, BigInt(amountOut), maxIn, null, maxIn);
}

/** Sell an exact number of coins for the quote token (the fee comes off the output). */
export function quoteSell(pool: PoolLike, config: CurveLike, { amountIn, slippageBps = 100, referral = true }: QuoteOptions & { amountIn: bigint }): TradeQuote {
  const amount = BigInt(amountIn);
  const q = quoteSwap(pool, config, { direction: Direction.Sell, mode: SwapMode.ExactIn, amount0: amount, hasReferral: referral });
  refuseNothingOut(q);
  const minOut = minOutWithSlippage(q.out, slippageBps);
  return finish('sell', SwapMode.ExactIn, q, pool, config, amount, minOut, minOut, null);
}

/** Sell for an exact amount of the quote token; `amount1` is the most coins the seller will give. */
export function quoteSellExactOut(pool: PoolLike, config: CurveLike, { amountOut, slippageBps = 100, referral = true }: QuoteOptions & { amountOut: bigint }): TradeQuote {
  const q = quoteSwap(pool, config, { direction: Direction.Sell, mode: SwapMode.ExactOut, amount0: BigInt(amountOut), hasReferral: referral });
  const maxIn = maxInWithSlippage(q.includedIn, slippageBps);
  return finish('sell', SwapMode.ExactOut, q, pool, config, BigInt(amountOut), maxIn, null, maxIn);
}

export interface CoinToCoinQuote {
  sell: TradeQuote;
  buy: TradeQuote;
  /** the quote amount the buy leg spends: the sell leg's guaranteed minimum */
  quoteMin: bigint;
  /** least coins of B the trader accepts */
  minOut: bigint;
}
/**
 * Coin A to coin B, both priced in the same quote token, in one transaction
 * (LAUNCHPAD-DESIGN.md 9.6): sell A exact in for at least `quoteMin`, then buy
 * B with exactly `quoteMin`. Anything the sell returns above `quoteMin` stays
 * in the trader's quote account. Slippage applies to both legs.
 */
export function quoteCoinToCoin(from: { pool: PoolLike; config: CurveLike }, to: { pool: PoolLike; config: CurveLike }, { amountIn, slippageBps = 100, referral = true }: QuoteOptions & { amountIn: bigint }): CoinToCoinQuote {
  const sell = quoteSell(from.pool, from.config, { amountIn, slippageBps, referral });
  const quoteMin = sell.minOut as bigint;
  if (quoteMin === 0n) throw new CurveError('AmountIsZero', 'the sell leg guarantees nothing; trade a larger amount');
  const buy = quoteBuy(to.pool, to.config, { amountIn: quoteMin, slippageBps, referral });
  return { sell, buy, quoteMin, minOut: buy.minOut as bigint };
}

/** Everything a full curve costs from its current state: one partial-fill buy of `budget` (default: generous). */
export function quoteFillCurve(pool: PoolLike, config: CurveLike, { referral = false }: { referral?: boolean } = {}): TradeQuote {
  const left = config.migrationQuoteThreshold - pool.quoteReserve;
  if (left <= 0n) throw new CurveError('PoolIsCompleted', 'curve is complete');
  // fee is at most MAX_TRADE_FEE (2%) on top, so twice what is left is always enough
  return quoteBuy(pool, config, { amountIn: left * 2n + 1_000n, slippageBps: 0, referral });
}

export function feeBpsOf(config: Pick<CurveConfig, 'feeNumerator'>): number {
  return Number((config.feeNumerator * BPS) / FEE_DENOMINATOR);
}
