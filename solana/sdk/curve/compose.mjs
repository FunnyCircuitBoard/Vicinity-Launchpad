// The buy leg of a client transaction, and "pay with any token"
// (VICINITY-CURVE-DESIGN.md 14.1, 14.3, 5.15, 12.5 G03): a swap to native SOL
// followed by our buy in the same transaction. The limits that protect the user:
//   * the swap leg: the buy's `sol_in` never exceeds what the swap is
//     guaranteed to deliver, or a swap that under-delivers makes the buy spend
//     SOL the user already had:
//       - ExactOut quote: the swap delivers exactly `outAmount`, so sol_in = outAmount;
//       - ExactIn quote: the swap delivers at least `otherAmountThreshold` (its minimum
//         output, below which it fails), so sol_in = otherAmountThreshold, never the
//         quoted `outAmount`;
//   * the buy leg: its own `min_tokens_out` (CLI-1). The swap's minimum says
//     nothing about the curve's price: without a minimum on the buy, a searcher
//     who sees the transaction buys ahead of it and sells after it (a sandwich;
//     a 5 SOL buy into a fresh coin lost 68% of its coins in the review's test).
//     No buy is built without a positive minimum.
//   * the completing buy (R3-CLI-1): when the quote is a partial fill (the buy
//     completes the curve and is charged less than sol_in), sol_in is capped at
//     the quote's charge (max_quote_in at that state). A buy that offered more
//     and carried the partial quote's minimum would, once someone else
//     graduates the coin first, run in the pool, be charged all of sol_in and
//     still clear that small minimum: the minimum would no longer limit the
//     price. The SOL the swap delivered beyond the charge stays in the wallet.
//   * the slippage a buy may allow (MATH3-1): above the coin's sandwich
//     threshold (`sandwichThreshold`, about 1.5% of the market's SOL depth
//     under config #0) an ordinary sandwich profits at any slippage and takes
//     nearly all of it, so such a buy may allow at most
//     LARGE_BUY_MAX_SLIPPAGE_BPS (0.3%); below it, up to
//     MAX_SWAP_SLIPPAGE_BPS (5%). A larger buy can be split into buys of at
//     most the threshold, each in its own transaction.
import { createAssociatedTokenAccountIdempotent } from './instructions.mjs';
import { associatedTokenAddress } from './pda.mjs';
import { coinState, coinTerms } from './accounts.mjs';
import { quoteBuy, sandwichThreshold, withSlippage } from './math.mjs';

export class ComposeError extends Error {
  constructor(message) { super(`ComposeError: ${message}`); this.name = 'ComposeError'; }
}

/** The largest slippage a buy leg may allow below the coin's sandwich threshold, in basis points (5%; 14.1's default is 1%). */
export const MAX_SWAP_SLIPPAGE_BPS = 500;
/** The largest slippage a buy leg may allow above the coin's sandwich threshold, in basis points (0.3%; 5.15, 14.1, review MATH3-1). */
export const LARGE_BUY_MAX_SLIPPAGE_BPS = 30;
/** 14.1's default slippage for a buy at or below the sandwich threshold, in basis points (1%). */
export const DEFAULT_BUY_SLIPPAGE_BPS = 100;

const D = 10_000n;

/**
 * The `sol_in` a buy may use after a swap quote (Jupiter's shape: `swapMode`
 * 'ExactIn' or 'ExactOut', `outAmount`, `otherAmountThreshold`; amounts as
 * BigInt, number or decimal string).
 */
export function solInFromSwapQuote(quote) {
  const mode = quote?.swapMode;
  if (mode === 'ExactOut') return BigInt(quote.outAmount);
  if (mode === 'ExactIn') {
    const min = BigInt(quote.otherAmountThreshold);
    if (min > BigInt(quote.outAmount)) throw new ComposeError('otherAmountThreshold above outAmount');
    return min;
  }
  throw new ComposeError(`unknown swapMode ${mode}`);
}

/**
 * The slippage a buy of `solIn` on this coin may allow, in basis points
 * (MATH3-1): MAX_SWAP_SLIPPAGE_BPS up to the coin's sandwich threshold,
 * LARGE_BUY_MAX_SLIPPAGE_BPS above it. `coinAccount` is a decoded CurveCoin.
 * Returns `{ maxSlippageBps, defaultSlippageBps, threshold, charged, large }`
 * (`charged` is what the buy would pay: less than `solIn` when it completes
 * the curve).
 */
export function buySlippagePolicy(coinAccount, solIn) {
  if (!coinAccount) throw new ComposeError('the slippage policy needs coinAccount, the decoded CurveCoin as read before signing');
  const terms = coinTerms(coinAccount); const state = coinState(coinAccount);
  const q = quoteBuy(terms, state, BigInt(solIn));
  const threshold = sandwichThreshold(terms, state);
  const large = q.charged > threshold;
  return {
    maxSlippageBps: large ? LARGE_BUY_MAX_SLIPPAGE_BPS : MAX_SWAP_SLIPPAGE_BPS,
    defaultSlippageBps: large ? LARGE_BUY_MAX_SLIPPAGE_BPS : DEFAULT_BUY_SLIPPAGE_BPS,
    threshold, charged: q.charged, large,
  };
}

/**
 * The buy leg: `{ solIn, minTokensOut, quote, threshold, large }` for a buy of
 * up to `solIn` on the coin as read before signing (`coinAccount`, a decoded
 * CurveCoin; required, since every rule below reads it):
 *   * `solIn` is capped at the quote's charge when the buy completes the curve
 *     (R3-CLI-1), so the transaction never offers more than the partial quote
 *     priced;
 *   * `minTokensOut` is given (at least 1), or the quote of the capped `solIn`
 *     less `slippageBps`; exactly one of the two;
 *   * the slippage the minimum allows, given or derived, is at most
 *     MAX_SWAP_SLIPPAGE_BPS, and at most LARGE_BUY_MAX_SLIPPAGE_BPS when the
 *     charge is above the coin's sandwich threshold (MATH3-1).
 * Anything else throws ComposeError.
 */
export function buyLeg({ solIn, minTokensOut, coinAccount, slippageBps, mint }) {
  const given = minTokensOut !== undefined && minTokensOut !== null;
  const bySlippage = slippageBps !== undefined && slippageBps !== null;
  if (given && bySlippage) throw new ComposeError('pass minTokensOut or slippageBps, not both');
  if (!given && !bySlippage) throw new ComposeError('the buy leg needs its own minimum: pass minTokensOut, or coinAccount and slippageBps (a buy without a minimum can be sandwiched, 14.1)');
  if (given && BigInt(minTokensOut) < 1n) throw new ComposeError('the buy leg needs min_tokens_out of at least 1: a buy without a minimum can be sandwiched (14.1)');
  if (!coinAccount) throw new ComposeError('the buy leg needs coinAccount, the decoded CurveCoin the quote is computed from (its partial fill and its sandwich threshold, 14.1, 14.3)');
  if (mint !== undefined && String(coinAccount.mint) !== String(mint)) throw new ComposeError(`coinAccount is the coin of mint ${coinAccount.mint}, not ${mint}`);
  let bps = null;
  if (bySlippage) {
    bps = Number(slippageBps);
    if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SWAP_SLIPPAGE_BPS) throw new ComposeError(`slippageBps must be an integer from 0 to ${MAX_SWAP_SLIPPAGE_BPS}, got ${slippageBps}`);
  }
  const terms = coinTerms(coinAccount); const state = coinState(coinAccount);
  const asked = BigInt(solIn);
  let quote = quoteBuy(terms, state, asked);
  // R3-CLI-1: the completing buy offers exactly its charge (max_quote_in), never more
  const capped = quote.partial ? quote.charged : asked;
  if (capped !== asked) quote = quoteBuy(terms, state, capped);
  if (quote.partial || quote.tokensOut < 1n) throw new ComposeError('internal: the capped buy is still a partial fill');
  const threshold = sandwichThreshold(terms, state);
  const large = quote.charged > threshold;
  const maxBps = large ? LARGE_BUY_MAX_SLIPPAGE_BPS : MAX_SWAP_SLIPPAGE_BPS;
  const tooMuch = (allowed) => new ComposeError(`a buy of ${quote.charged} lamports is above this coin's sandwich threshold of ${threshold} lamports (5.15): `
    + `an ordinary sandwich takes almost any slippage it allows, so it may allow at most ${LARGE_BUY_MAX_SLIPPAGE_BPS} bps (it allows ${allowed}); `
    + `lower the slippage or split it into buys of at most ${threshold} lamports`);
  let min;
  if (given) {
    min = BigInt(minTokensOut);
    // judged like a derived minimum: at least the quote less the largest slippage allowed (same rounding)
    if (min < withSlippage(quote.tokensOut, maxBps)) {
      const allowed = ((quote.tokensOut - min) * D + quote.tokensOut - 1n) / quote.tokensOut; // for the message, rounded up
      if (large) throw tooMuch(`about ${allowed} bps`);
      throw new ComposeError(`minTokensOut allows about ${allowed} bps of slippage, more than ${MAX_SWAP_SLIPPAGE_BPS}`);
    }
  } else {
    if (bps > maxBps) throw tooMuch(`${bps} bps`);
    min = withSlippage(quote.tokensOut, bps);
    if (min < 1n) throw new ComposeError('the buy is too small for a minimum of at least one raw coin');
  }
  return { solIn: capped, minTokensOut: min, quote, threshold, large };
}

/**
 * The buy leg's `min_tokens_out` for `solIn` (buyLeg). It refuses a `solIn`
 * that buyLeg would cap (a buy that completes the curve, R3-CLI-1): take
 * `buyLeg(...).solIn` and `.minTokensOut` together instead, or the minimum
 * stops limiting the price once someone else graduates the coin.
 */
export function buyLegMinimum(args) {
  const leg = buyLeg(args);
  if (leg.solIn !== BigInt(args.solIn)) {
    throw new ComposeError(`this buy completes the curve: offer sol_in = ${leg.solIn} (the quote's charge, max_quote_in), not ${args.solIn}; `
      + 'buyLeg returns both, since a minimum from the partial quote does not limit the price of a larger sol_in once the coin graduates (14.3)');
  }
  return leg.minTokensOut;
}

/**
 * `[...swapInstructions, create the buyer's token account (idempotent), buy]`
 * with the buy leg of buyLeg: `sol_in` from the swap quote
 * (solInFromSwapQuote), capped at the charge of a buy that completes the
 * curve, and its own minimum (`minTokensOut`, or `slippageBps`), both on
 * `coinAccount`, the coin as read before signing. `ix` is the deployment's
 * builders (curveInstructions). Returns `{ instructions, solIn, minTokensOut,
 * swapSolIn, quote }`: `solIn` is what the buy offers, `swapSolIn` what the
 * swap is guaranteed to deliver (any difference stays in the wallet).
 */
export function buyWithSwap({ ix, user, coin, mint, swapInstructions, quote, minTokensOut, coinAccount, slippageBps, createTokenAccount = true }) {
  const swapSolIn = solInFromSwapQuote(quote);
  const leg = buyLeg({ solIn: swapSolIn, minTokensOut, coinAccount, slippageBps, mint });
  const userTokenAccount = associatedTokenAddress(user, mint);
  const out = [...swapInstructions];
  if (createTokenAccount) out.push(createAssociatedTokenAccountIdempotent({ payer: user, owner: user, mint }));
  out.push(ix.buy({ user, coin, userTokenAccount, solIn: leg.solIn, minTokensOut: leg.minTokensOut }));
  return { instructions: out, solIn: leg.solIn, minTokensOut: leg.minTokensOut, swapSolIn, quote: leg.quote };
}
