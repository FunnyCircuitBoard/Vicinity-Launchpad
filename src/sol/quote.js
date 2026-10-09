/**
 * Curve trade quotes for the Worker: a plain-JavaScript port of solana/sdk/launchpad/quote.mts on top of the SDK's own
 * curve.mjs (the exact BigInt copy of Meteora DBC's swap maths, imported as is). Every number is what the chain will do, to
 * the raw unit; the parity test (solana/tests-launchpad/15-worker-builder.test.mjs) compares hundreds of random quotes with
 * quoteBuy/quoteSell and with litesvm running the real DBC program.
 *   quoteBuy   exact in; the last buy of a curve becomes DBC's partial fill (the curve takes what it needs, the rest stays with the buyer)
 *   quoteSell  exact in
 * Fees: the trade fee (1.25%) splits into Meteora's cut, the referral (the dev wallet's quote account), the dev wallet's partner
 * share and the city's share, which our program later halves between holders and founder.
 */
import { CurveError, Direction, FEE_DENOMINATOR, SwapMode, applySwap, quoteSwap } from "../../solana/sdk/launchpad/curve.mjs";

export { CurveError, SwapMode };
export const BPS = 10_000n;
export const MAX_SLIPPAGE_BPS = 5_000;
const Q128 = 1n << 128n;

export function checkSlippage(bps) {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) throw new RangeError("bad_slippage");
  return BigInt(bps);
}
export const minOutWithSlippage = (out, bps) => (out * (BPS - checkSlippage(bps))) / BPS;
export const splitHarvest = (c) => { const toFounder = c / 2n; return { toHolders: c - toFounder, toFounder }; };
/** Spot price for display: quote tokens per whole coin (a float; never used for amounts). */
export function priceInQuote(sqrtPrice, quoteDecimals, coinDecimals = 6) {
  const scaled = (sqrtPrice * sqrtPrice * 10n ** 18n) / Q128;
  return (Number(scaled) / 1e18) * 10 ** (coinDecimals - quoteDecimals);
}
export const feeBpsOf = (config) => Number((config.feeNumerator * BPS) / FEE_DENOMINATOR);

function impactBps(sqrtBefore, quoteAmount, coinAmount, side) {
  if (coinAmount === 0n || quoteAmount === 0n) return 0;
  const execOverSpot = (quoteAmount * Q128 * BPS) / (coinAmount * sqrtBefore * sqrtBefore);
  const d = side === "buy" ? execOverSpot - BPS : BPS - execOverSpot;
  return d < 0n ? 0 : Number(d);
}
const fees = (q) => { const { toHolders, toFounder } = splitHarvest(q.creator); return { total: q.fee, meteora: q.protocol, referral: q.referral, devWallet: q.partner, city: q.creator, holders: toHolders, founder: toFounder }; };
function finish(side, mode, q, pool, config, amount0, amount1, minOut) {
  const after = applySwap({ ...pool, baseReserve: pool.baseReserve ?? 0n }, q);
  return {
    side, mode, amountIn: q.includedIn, amountOut: q.out, amount0, amount1, minOut, fees: fees(q),
    refund: side === "buy" && mode === SwapMode.PartialFill ? amount0 - q.includedIn : 0n,
    completesCurve: after.quoteReserve >= config.migrationQuoteThreshold,
    sqrtPriceBefore: pool.sqrtPrice, sqrtPriceAfter: q.next,
    priceImpactBps: side === "buy" ? impactBps(pool.sqrtPrice, q.excludedIn, q.out, "buy") : impactBps(pool.sqrtPrice, q.grossOut ?? q.out, q.excludedIn, "sell"),
    poolAfter: { sqrtPrice: after.sqrtPrice, quoteReserve: after.quoteReserve, baseReserve: after.baseReserve },
  };
}
const refuseNothingOut = (q) => { if (q.out === 0n) throw new CurveError("AmountIsZero", "this trade would return nothing; trade a larger amount"); };

/** Buy with an exact amount of the quote token (fee included). Past the graduation price it is DBC's partial fill. */
export function quoteBuy(pool, config, { amountIn, slippageBps = 100, referral = true }) {
  const amount = BigInt(amountIn);
  let mode = SwapMode.ExactIn, q;
  try { q = quoteSwap(pool, config, { direction: Direction.Buy, mode, amount0: amount, hasReferral: referral }); }
  catch (e) {
    if (!(e instanceof CurveError) || e.code !== "InsufficientLiquidity") throw e;
    mode = SwapMode.PartialFill;
    q = quoteSwap(pool, config, { direction: Direction.Buy, mode, amount0: amount, hasReferral: referral });
  }
  refuseNothingOut(q);
  const minOut = minOutWithSlippage(q.out, slippageBps);
  return finish("buy", mode, q, pool, config, amount, minOut, minOut);
}
/** Sell an exact number of coins for the quote token (the fee comes off the output). */
export function quoteSell(pool, config, { amountIn, slippageBps = 100, referral = true }) {
  const amount = BigInt(amountIn);
  const q = quoteSwap(pool, config, { direction: Direction.Sell, mode: SwapMode.ExactIn, amount0: amount, hasReferral: referral });
  refuseNothingOut(q);
  const minOut = minOutWithSlippage(q.out, slippageBps);
  return finish("sell", SwapMode.ExactIn, q, pool, config, amount, minOut, minOut);
}
