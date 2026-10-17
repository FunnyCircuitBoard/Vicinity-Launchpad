// The buy and sell legs of a client transaction, and "pay with any token"
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
//   * the completing buy (R3-CLI-1, R4-DIFF-1): when the quote is a partial fill
//     (the buy completes the curve and is charged less than sol_in), sol_in is
//     capped at `max_quote_in` = max(the partial quote's charge,
//     MIN_TRADE_LAMPORTS) (5.4). A buy that offered more and carried the partial
//     quote's minimum would, once someone else graduates the coin first, run in
//     the pool, be charged all of sol_in and still clear that small minimum: the
//     minimum would no longer limit the price. Within about 97,500 lamports of
//     graduation the charge is below MIN_TRADE_LAMPORTS, so the capped buy
//     offers MIN_TRADE_LAMPORTS and is still a partial fill (it takes the last
//     raw units); the exposure is then at most 0.0001 SOL charged in the pool.
//     The SOL the swap delivered beyond the cap stays in the wallet.
//   * the slippage a trade may allow (MATH3-1, R4-DIFF-5): above the coin's
//     sandwich threshold (`sandwichThreshold`, 1.3% of the market's SOL depth
//     under config #0, judged on the depth of the pool the trade could be
//     pushed into) an ordinary sandwich profits at any slippage and takes
//     nearly all of it, so such a trade may allow at most
//     LARGE_BUY_MAX_SLIPPAGE_BPS (0.3%); at or below it, up to
//     MAX_SWAP_SLIPPAGE_BPS (5%). The same rule for buys (judged on the charge)
//     and sells (judged on the gross). Splitting a large trade into smaller ones
//     is no defence: an attacker can hold his position across separate
//     transactions and wrap every piece (review R4-DIFF-2); a client that
//     splits an order judges each piece by the order's total (`orderSolIn`,
//     `orderGross`).
//   * the swap's output is native SOL (SDK4-5): `outputMint` must be the native
//     mint (unwrapped by the swap, `wrapAndUnwrapSol`), or the buy would spend
//     SOL the user already had.
import { createAssociatedTokenAccountIdempotent } from './instructions.mjs';
import { associatedTokenAddress } from './pda.mjs';
import { coinState, coinTerms } from './accounts.mjs';
import { maxQuoteIn, quoteBuy, quoteSell, sandwichThreshold, withSlippage } from './math.mjs';
import { ADDRESSES, MIN_TRADE_LAMPORTS } from './constants.mjs';

export class ComposeError extends Error {
  constructor(message) { super(`ComposeError: ${message}`); this.name = 'ComposeError'; }
}

/** The largest slippage a buy or sell leg may allow at or below the coin's sandwich threshold, in basis points (5%; 14.1's default is 1%). */
export const MAX_SWAP_SLIPPAGE_BPS = 500;
/** The largest slippage a buy or sell leg may allow above the coin's sandwich threshold, in basis points (0.3%; 5.15, 14.1, reviews MATH3-1, R4-DIFF-5). */
export const LARGE_BUY_MAX_SLIPPAGE_BPS = 30;
/** 14.1's default slippage for a buy or sell at or below the sandwich threshold, in basis points (1%). */
export const DEFAULT_BUY_SLIPPAGE_BPS = 100;

const D = 10_000n;

/**
 * The `sol_in` a buy may use after a swap quote (Jupiter's shape: `inputMint`, `outputMint`, `swapMode` 'ExactIn'
 * or 'ExactOut', `outAmount`, `otherAmountThreshold`; amounts as BigInt, number or decimal string). The swap must
 * end in native SOL (`outputMint` the native mint, unwrapped by the swap: Jupiter's `wrapAndUnwrapSol`), from
 * another mint (review SDK4-5): an amount of any other token read as lamports would make the buy spend SOL the user
 * already had.
 */
export function solInFromSwapQuote(quote) {
  if (String(quote?.outputMint) !== ADDRESSES.nativeMint) {
    throw new ComposeError(`the swap must deliver native SOL (outputMint ${ADDRESSES.nativeMint}, unwrapped by the swap), got outputMint ${quote?.outputMint}`);
  }
  if (quote.inputMint === undefined || quote.inputMint === null || String(quote.inputMint) === ADDRESSES.nativeMint) {
    throw new ComposeError(`the swap's inputMint must be another token, got ${quote.inputMint}`);
  }
  const mode = quote.swapMode;
  if (mode === 'ExactOut') return BigInt(quote.outAmount);
  if (mode === 'ExactIn') {
    const min = BigInt(quote.otherAmountThreshold);
    if (min > BigInt(quote.outAmount)) throw new ComposeError('otherAmountThreshold above outAmount');
    return min;
  }
  throw new ComposeError(`unknown swapMode ${mode}`);
}

/** The policy of a trade of `size` lamports (a buy's charge, a sell's gross) on a coin whose threshold is `threshold`, judged with the whole order's size `order` when the trade is a piece of a larger one (R4-DIFF-2). */
function policy(size, threshold, order) {
  const judged = order !== undefined && order !== null && BigInt(order) > size ? BigInt(order) : size;
  const large = judged > threshold;
  return {
    maxSlippageBps: large ? LARGE_BUY_MAX_SLIPPAGE_BPS : MAX_SWAP_SLIPPAGE_BPS,
    defaultSlippageBps: large ? LARGE_BUY_MAX_SLIPPAGE_BPS : DEFAULT_BUY_SLIPPAGE_BPS,
    large,
  };
}

/**
 * The slippage a buy of `solIn` on this coin may allow, in basis points (MATH3-1): MAX_SWAP_SLIPPAGE_BPS up to the
 * coin's sandwich threshold, LARGE_BUY_MAX_SLIPPAGE_BPS above it. `coinAccount` is a decoded CurveCoin;
 * `orderSolIn`, when this buy is one piece of a larger order, is the order's total, by which the piece is judged
 * (R4-DIFF-2). Returns `{ maxSlippageBps, defaultSlippageBps, threshold, charged, large }` (`charged` is what the
 * buy would pay: less than `solIn` when it completes the curve).
 */
export function buySlippagePolicy(coinAccount, solIn, { orderSolIn } = {}) {
  if (!coinAccount) throw new ComposeError('the slippage policy needs coinAccount, the decoded CurveCoin as read before signing');
  const terms = coinTerms(coinAccount); const state = coinState(coinAccount);
  const q = quoteBuy(terms, state, BigInt(solIn));
  const threshold = sandwichThreshold(terms, state);
  const p = policy(q.charged, threshold, orderSolIn);
  return { maxSlippageBps: p.maxSlippageBps, defaultSlippageBps: p.defaultSlippageBps, threshold, charged: q.charged, large: p.large };
}

/**
 * The slippage a sell of `tokensIn` raw coins may allow, in basis points (review R4-DIFF-5): the buy rule on the
 * sell's gross (the SOL it takes out of the reserve before the fee). `orderGross`, when this sell is one piece of a
 * larger order, is the order's total gross. Returns `{ maxSlippageBps, defaultSlippageBps, threshold, gross, large }`.
 */
export function sellSlippagePolicy(coinAccount, tokensIn, { orderGross } = {}) {
  if (!coinAccount) throw new ComposeError('the slippage policy needs coinAccount, the decoded CurveCoin as read before signing');
  const terms = coinTerms(coinAccount); const state = coinState(coinAccount);
  const q = quoteSell(terms, state, BigInt(tokensIn));
  const threshold = sandwichThreshold(terms, state);
  const p = policy(q.gross, threshold, orderGross);
  return { maxSlippageBps: p.maxSlippageBps, defaultSlippageBps: p.defaultSlippageBps, threshold, gross: q.gross, large: p.large };
}

/** The arguments every leg shares: exactly one of a given minimum (at least 1) and a slippage in 0..MAX_SWAP_SLIPPAGE_BPS, and the coin. */
function legArgs({ given, bySlippage, givenMin, slippageBps, coinAccount, mint, what, minName }) {
  if (given && bySlippage) throw new ComposeError(`pass ${minName} or slippageBps, not both`);
  if (!given && !bySlippage) throw new ComposeError(`the ${what} leg needs its own minimum: pass ${minName}, or coinAccount and slippageBps (a ${what} without a minimum can be sandwiched, 14.1)`);
  if (given && BigInt(givenMin) < 1n) throw new ComposeError(`the ${what} leg needs ${minName} of at least 1: a ${what} without a minimum can be sandwiched (14.1)`);
  if (!coinAccount) throw new ComposeError(`the ${what} leg needs coinAccount, the decoded CurveCoin the quote is computed from (its partial fill and its sandwich threshold, 14.1, 14.3)`);
  if (mint !== undefined && String(coinAccount.mint) !== String(mint)) throw new ComposeError(`coinAccount is the coin of mint ${coinAccount.mint}, not ${mint}`);
  if (!bySlippage) return null;
  const bps = Number(slippageBps);
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SWAP_SLIPPAGE_BPS) throw new ComposeError(`slippageBps must be an integer from 0 to ${MAX_SWAP_SLIPPAGE_BPS}, got ${slippageBps}`);
  return bps;
}

/**
 * The minimum of a leg whose quote is `out`: the given one, judged like a derived one (at least `out` less the
 * largest slippage allowed, same rounding), or `out` less `bps`, at least 1 (when `out` is a few raw units, a
 * minimum of 1 allows less slippage than asked, never more).
 */
function legMinimum({ out, given, givenMin, bps, maxBps, large, tooMuch }) {
  if (given) {
    const min = BigInt(givenMin);
    if (min < withSlippage(out, maxBps)) {
      const allowed = ((out - min) * D + out - 1n) / out; // for the message, rounded up
      if (large) throw tooMuch(`about ${allowed} bps`);
      throw new ComposeError(`the minimum allows about ${allowed} bps of slippage, more than ${MAX_SWAP_SLIPPAGE_BPS}`);
    }
    return min;
  }
  if (bps > maxBps) throw tooMuch(`${bps} bps`);
  const min = withSlippage(out, bps);
  return min < 1n ? 1n : min;
}

const tooMuchFor = (what, size, threshold, order) => (allowed) => new ComposeError(`a ${what} of ${size} lamports${order ? ` (part of an order of ${order} lamports)` : ''} `
  + `is above this coin's sandwich threshold of ${threshold} lamports (5.15): an ordinary sandwich takes almost any slippage it allows, `
  + `so it may allow at most ${LARGE_BUY_MAX_SLIPPAGE_BPS} bps (it allows ${allowed}); lower the slippage. Splitting it into smaller trades `
  + 'does not help: an attacker can hold his position across separate transactions and wrap every piece (review R4-DIFF-2)');

/**
 * The buy leg: `{ solIn, minTokensOut, quote, threshold, large }` for a buy of up to `solIn` on the coin as read
 * before signing (`coinAccount`, a decoded CurveCoin; required, since every rule below reads it):
 *   * `solIn` is capped at `max_quote_in` (5.4: max(the charge, MIN_TRADE_LAMPORTS)) when the buy completes the
 *     curve (R3-CLI-1, R4-DIFF-1), so the transaction never offers more than the partial quote priced; within about
 *     97,500 lamports of graduation the capped buy offers MIN_TRADE_LAMPORTS and its quote stays partial (it takes
 *     the last `S - s` raw units);
 *   * `minTokensOut` is given (at least 1), or the quote of the capped `solIn` less `slippageBps` (at least 1);
 *     exactly one of the two;
 *   * the slippage the minimum allows, given or derived, is at most MAX_SWAP_SLIPPAGE_BPS, and at most
 *     LARGE_BUY_MAX_SLIPPAGE_BPS when the charge (or `orderSolIn`, the whole order this buy is a piece of) is above
 *     the coin's sandwich threshold (MATH3-1, R4-DIFF-2).
 * Anything else throws ComposeError.
 */
export function buyLeg({ solIn, minTokensOut, coinAccount, slippageBps, mint, orderSolIn }) {
  const given = minTokensOut !== undefined && minTokensOut !== null;
  const bySlippage = slippageBps !== undefined && slippageBps !== null;
  const bps = legArgs({ given, bySlippage, givenMin: minTokensOut, slippageBps, coinAccount, mint, what: 'buy', minName: 'minTokensOut' });
  const terms = coinTerms(coinAccount); const state = coinState(coinAccount);
  const asked = BigInt(solIn);
  let quote = quoteBuy(terms, state, asked);
  // R3-CLI-1, R4-DIFF-1: the completing buy offers max_quote_in, never more
  const capped = quote.partial ? maxQuoteIn(terms, state) : asked;
  if (capped !== asked) quote = quoteBuy(terms, state, capped);
  // still partial only at MIN_TRADE_LAMPORTS, when the remainder costs less than that (the last raw units)
  if ((quote.partial && capped !== MIN_TRADE_LAMPORTS) || quote.tokensOut < 1n) throw new ComposeError('internal: the capped buy is still a partial fill above MIN_TRADE_LAMPORTS');
  const threshold = sandwichThreshold(terms, state);
  const p = policy(quote.charged, threshold, orderSolIn);
  const min = legMinimum({ out: quote.tokensOut, given, givenMin: minTokensOut, bps, maxBps: p.maxSlippageBps, large: p.large,
    tooMuch: tooMuchFor('buy', quote.charged, threshold, orderSolIn) });
  return { solIn: capped, minTokensOut: min, quote, threshold, large: p.large };
}

/**
 * The buy leg's `min_tokens_out` for `solIn` (buyLeg). It refuses a `solIn` that buyLeg would cap (a buy that
 * completes the curve, R3-CLI-1): take `buyLeg(...).solIn` and `.minTokensOut` together instead, or the minimum
 * stops limiting the price once someone else graduates the coin.
 */
export function buyLegMinimum(args) {
  const leg = buyLeg(args);
  if (leg.solIn !== BigInt(args.solIn)) {
    throw new ComposeError(`this buy completes the curve: offer sol_in = ${leg.solIn} (max_quote_in), not ${args.solIn}; `
      + 'buyLeg returns both, since a minimum from the partial quote does not limit the price of a larger sol_in once the coin graduates (14.3)');
  }
  return leg.minTokensOut;
}

/**
 * The sell leg (review R4-DIFF-5): `{ tokensIn, minSolOut, quote, threshold, large }` for a sell of `tokensIn` raw
 * coins on the coin as read before signing (`coinAccount`): `minSolOut` is given (at least 1), or the quote's
 * `solOut` less `slippageBps` (at least 1); the slippage it allows is at most MAX_SWAP_SLIPPAGE_BPS, and at most
 * LARGE_BUY_MAX_SLIPPAGE_BPS when the sell's gross (or `orderGross`, the whole order's) is above the coin's sandwich
 * threshold, as for buys. Anything else throws ComposeError. The rent rule on the seller is `precheckSell`'s.
 */
export function sellLeg({ tokensIn, minSolOut, coinAccount, slippageBps, mint, orderGross }) {
  const given = minSolOut !== undefined && minSolOut !== null;
  const bySlippage = slippageBps !== undefined && slippageBps !== null;
  const bps = legArgs({ given, bySlippage, givenMin: minSolOut, slippageBps, coinAccount, mint, what: 'sell', minName: 'minSolOut' });
  const terms = coinTerms(coinAccount); const state = coinState(coinAccount);
  const amount = BigInt(tokensIn);
  const quote = quoteSell(terms, state, amount);
  const threshold = sandwichThreshold(terms, state);
  const p = policy(quote.gross, threshold, orderGross);
  const min = legMinimum({ out: quote.solOut, given, givenMin: minSolOut, bps, maxBps: p.maxSlippageBps, large: p.large,
    tooMuch: tooMuchFor('sell', quote.gross, threshold, orderGross) });
  return { tokensIn: amount, minSolOut: min, quote, threshold, large: p.large };
}

/**
 * `[...swapInstructions, create the buyer's token account (idempotent), buy]` with the buy leg of buyLeg: `sol_in`
 * from the swap quote (solInFromSwapQuote: native SOL out), capped at `max_quote_in` for a buy that completes the
 * curve, and its own minimum (`minTokensOut`, or `slippageBps`), both on `coinAccount`, the coin as read before
 * signing. `ix` is the deployment's builders (curveInstructions). Returns `{ instructions, solIn, minTokensOut,
 * swapSolIn, quote }`: `solIn` is what the buy offers, `swapSolIn` what the swap is guaranteed to deliver (any
 * difference stays in the wallet).
 */
export function buyWithSwap({ ix, user, coin, mint, swapInstructions, quote, minTokensOut, coinAccount, slippageBps, orderSolIn, createTokenAccount = true }) {
  const swapSolIn = solInFromSwapQuote(quote);
  const leg = buyLeg({ solIn: swapSolIn, minTokensOut, coinAccount, slippageBps, mint, orderSolIn });
  const userTokenAccount = associatedTokenAddress(user, mint);
  const out = [...swapInstructions];
  if (createTokenAccount) out.push(createAssociatedTokenAccountIdempotent({ payer: user, owner: user, mint }));
  out.push(ix.buy({ user, coin, userTokenAccount, solIn: leg.solIn, minTokensOut: leg.minTokensOut }));
  return { instructions: out, solIn: leg.solIn, minTokensOut: leg.minTokensOut, swapSolIn, quote: leg.quote };
}
