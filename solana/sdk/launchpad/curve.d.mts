// Types for curve.mjs (the exact BigInt copy of Meteora DBC 0.2.1's swap maths).
export declare const FEE_DENOMINATOR: bigint;
export declare const PROTOCOL_FEE_PERCENT: bigint;
export declare const HOST_FEE_PERCENT: bigint;
export declare const RESOLUTION: bigint;
export declare const PARTNER_AND_CREATOR_SURPLUS_PERCENT: bigint;
export declare const SwapMode: Readonly<{ ExactIn: 0; PartialFill: 1; ExactOut: 2 }>;
export declare const Direction: Readonly<{ Buy: 'QuoteToBase'; Sell: 'BaseToQuote' }>;
export declare class CurveError extends Error {
  constructor(code: string, msg: string);
  code: string;
}
export interface CurvePoint { sqrtPrice: bigint; liquidity: bigint }
export interface CurveConfigLike {
  curve: CurvePoint[];
  sqrtStartPrice: bigint;
  migrationSqrtPrice: bigint;
  migrationQuoteThreshold: bigint;
  feeNumerator: bigint;
  creatorTradingFeePercentage: bigint;
}
export interface PoolSnapshot { sqrtPrice: bigint; quoteReserve: bigint; baseReserve?: bigint; partnerQuoteFee?: bigint; creatorQuoteFee?: bigint; protocolQuoteFee?: bigint }
export interface SwapQuote {
  /** what leaves the trader (fee included on buys) */
  includedIn: bigint;
  /** what the curve itself takes (fee excluded on buys) */
  excludedIn: bigint;
  /** what the trader receives */
  out: bigint;
  /** sells only: quote out before the fee */
  grossOut?: bigint;
  next: bigint;
  fee: bigint;
  trading: bigint;
  protocol: bigint;
  referral: bigint;
  creator: bigint;
  partner: bigint;
  left: bigint;
  direction: 'QuoteToBase' | 'BaseToQuote';
  mode: 0 | 1 | 2;
}
export declare function mulDiv(a: bigint, b: bigint, d: bigint, roundUp: boolean): bigint;
export declare function deltaBase(lower: bigint, upper: bigint, liquidity: bigint, roundUp: boolean): bigint;
export declare function deltaQuote(lower: bigint, upper: bigint, liquidity: bigint, roundUp: boolean): bigint;
export declare function splitFees(fee: bigint, hasReferral: boolean): { trading: bigint; protocol: bigint; referral: bigint };
export declare function feeOnAmount(numerator: bigint, amount: bigint, hasReferral: boolean): { amount: bigint; fee: bigint; trading: bigint; protocol: bigint; referral: bigint };
export declare function includedFeeAmount(numerator: bigint, excluded: bigint): { included: bigint; fee: bigint };
export declare function splitPartnerCreator(trading: bigint, creatorPercent: bigint): { creator: bigint; partner: bigint };
export declare function surplusShares(quoteReserve: bigint, migrationQuoteThreshold: bigint, creatorPercent: bigint | number): { total: bigint; creator: bigint; partner: bigint; protocol: bigint };
export declare function quoteSwap(pool: PoolSnapshot, config: CurveConfigLike, args: { direction: 'QuoteToBase' | 'BaseToQuote'; mode: 0 | 1 | 2; amount0: bigint | number | string; hasReferral?: boolean }): SwapQuote;
export declare function applySwap<T extends PoolSnapshot>(pool: T, q: SwapQuote): T & { sqrtPrice: bigint; quoteReserve: bigint; baseReserve: bigint; partnerQuoteFee: bigint; creatorQuoteFee: bigint; protocolQuoteFee: bigint };
export declare function curveQuoteAt(config: CurveConfigLike, sqrtPrice: bigint): bigint;
export declare function curveBaseSoldAt(config: CurveConfigLike, sqrtPrice: bigint): bigint;
