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
//   * the slippage a trade may allow (MATH3-1, R4-DIFF-5, MV-1, KR-1): above the
//     coin's sandwich threshold (`sandwichThreshold`, 1.3% of the market's SOL
//     depth under config #0 with at most one buyback cap pending, judged on the
//     depth of the pool the trade could be pushed into, and lower for every
//     further cap of visible backlog, KR-1) an ordinary sandwich profits at any
//     slippage and takes nearly all of it, so such a trade may allow at most
//     LARGE_BUY_MAX_SLIPPAGE_BPS (0.3%). At or below it a trade of size V may
//     allow a slippage s only while V + depth' * s / (2D) stays at or below the
//     threshold (MV-1: trades that read the same coin and share a block are
//     sandwiched together, and each one's tolerance is room for the others),
//     never more than MAX_SWAP_SLIPPAGE_BPS (5%) and always at least 0.3%. The
//     same rule for buys (judged on the charge) and sells (judged on the
//     gross). Splitting a large trade into smaller ones is no defence: an
//     attacker can hold his position across separate transactions and wrap
//     every piece (review R4-DIFF-2); a client that splits an order judges
//     each piece by the order's total (`orderSolIn`, `orderGross`) and anchors
//     every piece's minimum to the order's start (`order`: the coin as read
//     when the order began, the earlier pieces and what they delivered), so
//     the whole order gets at least its slippage less than the start's quote.
//     A minimum re-quoted from a fresh read before each piece would let the
//     price be pushed up piece after piece (review R5-DIFF-1: 1.9% lost on a
//     5 SOL order at 0.3% per piece).
//   * the swap's output is native SOL (SDK4-5): `outputMint` must be the native
//     mint (unwrapped by the swap, `wrapAndUnwrapSol`), or the buy would spend
//     SOL the user already had.
import { createAssociatedTokenAccountIdempotent } from './instructions.mjs';
import { associatedTokenAddress } from './pda.mjs';
import { coinState, coinTerms } from './accounts.mjs';
import { maxQuoteIn, quoteBuy, quoteSell, sandwichDepth, sandwichThreshold, withSlippage } from './math.mjs';
import { ADDRESSES, MIN_TRADE_LAMPORTS } from './constants.mjs';

export class ComposeError extends Error {
  constructor(message) { super(`ComposeError: ${message}`); this.name = 'ComposeError'; }
}

/** The largest slippage a buy or sell leg may ever allow, in basis points (5%; at or below the coin's sandwich threshold the size rule of MV-1 allows less; 14.1's default is 1%). */
export const MAX_SWAP_SLIPPAGE_BPS = 500;
/** The largest slippage a buy or sell leg may allow above the coin's sandwich threshold, in basis points (0.3%; 5.15, 14.1, reviews MATH3-1, R4-DIFF-5). */
export const LARGE_BUY_MAX_SLIPPAGE_BPS = 30;
/** 14.1's default slippage for a buy or sell at or below the sandwich threshold, in basis points (1%, or less when the size rule of MV-1 allows less). */
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

/**
 * The policy of a trade of `size` lamports (a buy's charge, a sell's gross) on a coin whose threshold is `threshold`
 * and whose sandwich depth is `depthP`, judged with the whole order's size `order` when the trade is a piece of a
 * larger one (R4-DIFF-2). Above the threshold at most LARGE_BUY_MAX_SLIPPAGE_BPS. At or below it the most a trade
 * may allow is `floor(2 * D * (threshold - judged) / depthP)` (review MV-1: a slippage `s` is allowed only while
 * `judged + depth' * s / (2D) <= threshold`, so that every trade wrapped by one sandwich in the same block fits under
 * the threshold together), clamped to LARGE_BUY_MAX_SLIPPAGE_BPS..MAX_SWAP_SLIPPAGE_BPS. Config #0: about 2.6% for
 * the smallest trades, 1% up to 0.24 SOL on a fresh coin and 0.68 SOL at pool open, 0.3% from 0.36 SOL and 1.04 SOL.
 */
function policy(size, threshold, depthP, order) {
  const judged = order !== undefined && order !== null && BigInt(order) > size ? BigInt(order) : size;
  const large = judged > threshold;
  let max = LARGE_BUY_MAX_SLIPPAGE_BPS;
  if (!large) {
    const room = depthP > 0n ? (2n * D * (threshold - judged)) / depthP : 0n;
    max = room >= BigInt(MAX_SWAP_SLIPPAGE_BPS) ? MAX_SWAP_SLIPPAGE_BPS : room <= BigInt(LARGE_BUY_MAX_SLIPPAGE_BPS) ? LARGE_BUY_MAX_SLIPPAGE_BPS : Number(room);
  }
  return { maxSlippageBps: max, defaultSlippageBps: Math.min(DEFAULT_BUY_SLIPPAGE_BPS, max), large, judged };
}

/**
 * The slippage a buy of `solIn` on this coin may allow, in basis points (MATH3-1, MV-1, KR-1): LARGE_BUY_MAX_SLIPPAGE_BPS
 * above the coin's sandwich threshold; at or below it, the size rule of `policy` (at most MAX_SWAP_SLIPPAGE_BPS).
 * `coinAccount` is a decoded CurveCoin; `orderSolIn`, when this buy is one piece of a larger order, is the order's
 * total, by which the piece is judged (R4-DIFF-2). Returns `{ maxSlippageBps, defaultSlippageBps, threshold, charged,
 * large }` (`charged` is what the buy would pay: less than `solIn` when it completes the curve).
 */
export function buySlippagePolicy(coinAccount, solIn, { orderSolIn } = {}) {
  if (!coinAccount) throw new ComposeError('the slippage policy needs coinAccount, the decoded CurveCoin as read before signing');
  const terms = coinTerms(coinAccount); const state = coinState(coinAccount);
  const q = quoteBuy(terms, state, BigInt(solIn));
  const threshold = sandwichThreshold(terms, state);
  const p = policy(q.charged, threshold, sandwichDepth(terms, state), orderSolIn);
  return { maxSlippageBps: p.maxSlippageBps, defaultSlippageBps: p.defaultSlippageBps, threshold, charged: q.charged, large: p.large };
}

/**
 * The slippage a sell of `tokensIn` raw coins may allow, in basis points (reviews R4-DIFF-5, MV-1, KR-1): the buy rule
 * on the sell's gross (the SOL it takes out of the reserve before the fee). `orderGross`, when this sell is one piece
 * of a larger order, is the order's total gross. Returns `{ maxSlippageBps, defaultSlippageBps, threshold, gross,
 * large }`.
 */
export function sellSlippagePolicy(coinAccount, tokensIn, { orderGross } = {}) {
  if (!coinAccount) throw new ComposeError('the slippage policy needs coinAccount, the decoded CurveCoin as read before signing');
  const terms = coinTerms(coinAccount); const state = coinState(coinAccount);
  const q = quoteSell(terms, state, BigInt(tokensIn));
  const threshold = sandwichThreshold(terms, state);
  const p = policy(q.gross, threshold, sandwichDepth(terms, state), orderGross);
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
function legMinimum({ out, given, givenMin, bps, maxBps, tooMuch }) {
  if (given) {
    const min = BigInt(givenMin);
    if (min < withSlippage(out, maxBps)) {
      const allowed = ((out - min) * D + out - 1n) / out; // for the message, rounded up
      throw tooMuch(`about ${allowed} bps`);
    }
    return min;
  }
  if (bps > maxBps) throw tooMuch(`${bps} bps`);
  const min = withSlippage(out, bps);
  return min < 1n ? 1n : min;
}

/** The refusal of a slippage above what the policy `p` allows for a trade of `size` lamports (5.15; MATH3-1, MV-1). */
const tooMuchFor = (what, size, threshold, order, p) => (allowed) => {
  const part = order ? ` (part of an order of ${order} lamports)` : '';
  if (p.large) {
    return new ComposeError(`a ${what} of ${size} lamports${part} is above this coin's sandwich threshold of ${threshold} lamports (5.15): `
      + `an ordinary sandwich takes almost any slippage it allows, so it may allow at most ${LARGE_BUY_MAX_SLIPPAGE_BPS} bps (it allows ${allowed}); `
      + 'lower the slippage. Splitting it into smaller trades does not help: an attacker can hold his position across separate transactions '
      + 'and wrap every piece (review R4-DIFF-2)');
  }
  return new ComposeError(`a ${what} of ${size} lamports${part} may allow at most ${p.maxSlippageBps} bps (it allows ${allowed}, more than ${p.maxSlippageBps}): `
    + `at or below this coin's sandwich threshold of ${threshold} lamports the slippage a trade may allow shrinks as its size nears the threshold, `
    + 'because trades that read the same coin and land in one block are sandwiched together and each one\'s tolerance is room for the others '
    + '(5.15, review MV-1)');
};

/**
 * The order a leg is one piece of (reviews R4-DIFF-2, R5-DIFF-1), or null when the leg is the whole trade. `total` is
 * the order's total (`orderSolIn` or `orderGross`), `asked` the leg's own size on the same scale; a leg smaller than
 * the total is a piece and needs `order = { start, pieces, received }`: `start` the decoded CurveCoin as read when the
 * order began (the same coin), `pieces` the size of each earlier piece as sent (`sol_in` of each buy, `tokens_in` of
 * each sell), `received` what they delivered in all (raw coins for buys, lamports for sells).
 */
function orderOf({ total, order, asked, what, totalName, coinAccount }) {
  const hasOrder = order !== undefined && order !== null;
  const hasTotal = total !== undefined && total !== null;
  if (hasOrder && !hasTotal) throw new ComposeError(`pass ${totalName}, the order's total, with order`);
  if (!hasTotal) return null;
  if (!hasOrder) {
    if (BigInt(total) <= asked) return null;
    throw new ComposeError(`this ${what} is one piece of an order of ${total} (${totalName}), so it needs order: { start, pieces, received }, `
      + `the coin as read when the order began, the ${what === 'buy' ? 'sol_in' : 'tokens_in'} of each earlier piece and what they delivered: `
      + 'a minimum re-quoted from a fresh read before each piece lets a searcher who holds his position push the price up piece after piece '
      + '(review R5-DIFF-1)');
  }
  if (!order.start) throw new ComposeError('order.start must be the decoded CurveCoin as read when the order began (review R5-DIFF-1)');
  if (String(order.start.mint) !== String(coinAccount.mint)) throw new ComposeError(`order.start is the coin of mint ${order.start.mint}, not ${coinAccount.mint}`);
  const pieces = (order.pieces ?? []).map((x) => BigInt(x));
  const received = BigInt(order.received ?? 0);
  if (pieces.some((x) => x <= 0n) || received < 0n) throw new ComposeError('order.pieces must be positive sizes and order.received at least 0');
  return { start: order.start, pieces, received, total: BigInt(total) };
}

/**
 * The least the piece `piece` may deliver so that the order as a whole delivers at least its quote at the order's
 * start, less `bps` (review R5-DIFF-1): `floor(Q * (D - bps) / D) - received`, where `Q` is what the earlier pieces
 * and this one deliver in sequence from `start` with no other trade (`quoteBuy` / `quoteSell`, which equal the
 * program, G01). Whatever an attacker does between the pieces, the order loses at most `bps` against that quote.
 */
function anchoredFloor(ord, piece, bps, what) {
  const terms = coinTerms(ord.start); let st = coinState(ord.start);
  let total = 0n;
  for (const size of [...ord.pieces, piece]) {
    const q = what === 'buy' ? quoteBuy(terms, st, size) : quoteSell(terms, st, size);
    total += what === 'buy' ? q.tokensOut : q.solOut;
    st = q.newState;
  }
  return withSlippage(total, bps) - ord.received;
}

/** A piece's minimum with its order's floor (R5-DIFF-1): at least the floor at the slippage used; refused when the coin's current quote is already below it. */
function withOrderFloor({ ord, min, out, piece, given, bps, maxBps, what, unit }) {
  if (!ord) return min;
  const floor = anchoredFloor(ord, piece, given ? maxBps : bps, what);
  if (given) {
    if (min < floor) {
      throw new ComposeError(`the minimum ${min} lets the order lose more than ${maxBps} bps against its quote when it began: this piece must deliver at least `
        + `${floor} ${unit} (review R5-DIFF-1)`);
    }
    return min;
  }
  if (out < floor) {
    throw new ComposeError(`the order has used up its slippage: this piece would deliver ${out} ${unit} at the current price, and the order needs at least ${floor} `
      + `from it to stay within ${bps} bps of its quote when it began; the price moved against the order since then (perhaps a sandwich held across its pieces, `
      + 'review R5-DIFF-1). End the order here; a new order started from a fresh read starts a new slippage budget');
  }
  return floor > min ? floor : min;
}

/**
 * The buy leg: `{ solIn, minTokensOut, quote, threshold, large }` for a buy of up to `solIn` on the coin as read
 * before signing (`coinAccount`, a decoded CurveCoin; required, since every rule below reads it):
 *   * `solIn` is capped at `max_quote_in` (5.4: max(the charge, MIN_TRADE_LAMPORTS)) when the buy completes the
 *     curve (R3-CLI-1, R4-DIFF-1), so the transaction never offers more than the partial quote priced; within about
 *     97,500 lamports of graduation the capped buy offers MIN_TRADE_LAMPORTS and its quote stays partial (it takes
 *     the last `S - s` raw units);
 *   * `minTokensOut` is given (at least 1), or the quote of the capped `solIn` less `slippageBps` (at least 1);
 *     exactly one of the two;
 *   * the slippage the minimum allows, given or derived, is at most what `buySlippagePolicy` allows: at most
 *     LARGE_BUY_MAX_SLIPPAGE_BPS when the charge (or `orderSolIn`, the whole order this buy is a piece of) is above
 *     the coin's sandwich threshold, and below it at most the size rule's figure (MATH3-1, R4-DIFF-2, MV-1);
 *   * a piece of a larger order (`orderSolIn` above `solIn`) needs `order = { start, pieces, received }` (the coin
 *     as read when the order began, the `sol_in` of each earlier piece, the raw coins they delivered), and its
 *     minimum is at least what keeps the whole order within the slippage of its quote at `start`; the piece is
 *     refused once the current quote is below that (R5-DIFF-1). Pieces signed together from one snapshot pass, for
 *     each piece, the snapshot advanced by the earlier pieces as `coinAccount` and their quoted coins as `received`.
 * Anything else throws ComposeError.
 */
export function buyLeg({ solIn, minTokensOut, coinAccount, slippageBps, mint, orderSolIn, order }) {
  const given = minTokensOut !== undefined && minTokensOut !== null;
  const bySlippage = slippageBps !== undefined && slippageBps !== null;
  const bps = legArgs({ given, bySlippage, givenMin: minTokensOut, slippageBps, coinAccount, mint, what: 'buy', minName: 'minTokensOut' });
  const terms = coinTerms(coinAccount); const state = coinState(coinAccount);
  const asked = BigInt(solIn);
  const ord = orderOf({ total: orderSolIn, order, asked, what: 'buy', totalName: 'orderSolIn', coinAccount });
  let quote = quoteBuy(terms, state, asked);
  // R3-CLI-1, R4-DIFF-1: the completing buy offers max_quote_in, never more
  const capped = quote.partial ? maxQuoteIn(terms, state) : asked;
  if (capped !== asked) quote = quoteBuy(terms, state, capped);
  // still partial only at MIN_TRADE_LAMPORTS, when the remainder costs less than that (the last raw units)
  if ((quote.partial && capped !== MIN_TRADE_LAMPORTS) || quote.tokensOut < 1n) throw new ComposeError('internal: the capped buy is still a partial fill above MIN_TRADE_LAMPORTS');
  if (ord && ord.pieces.reduce((x, y) => x + y, 0n) + capped > ord.total) throw new ComposeError(`the pieces of the order add up to more than orderSolIn ${ord.total}`);
  const threshold = sandwichThreshold(terms, state);
  const p = policy(quote.charged, threshold, sandwichDepth(terms, state), orderSolIn);
  let min = legMinimum({ out: quote.tokensOut, given, givenMin: minTokensOut, bps, maxBps: p.maxSlippageBps,
    tooMuch: tooMuchFor('buy', quote.charged, threshold, orderSolIn, p) });
  min = withOrderFloor({ ord, min, out: quote.tokensOut, piece: capped, given, bps, maxBps: p.maxSlippageBps, what: 'buy', unit: 'raw coins' });
  return { solIn: capped, minTokensOut: min, quote, threshold, large: p.large, maxSlippageBps: p.maxSlippageBps };
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
 * The sell leg (reviews R4-DIFF-5, MV-1, R5-DIFF-1): `{ tokensIn, minSolOut, quote, threshold, large }` for a sell of
 * `tokensIn` raw coins on the coin as read before signing (`coinAccount`): `minSolOut` is given (at least 1), or the
 * quote's `solOut` less `slippageBps` (at least 1); the slippage it allows is at most what `sellSlippagePolicy`
 * allows (the buy rule on the sell's gross, or on `orderGross`, the whole order's). A piece of a larger order
 * (`orderGross` above this sell's gross) needs `order = { start, pieces, received }` (the coin as read when the order
 * began, the `tokens_in` of each earlier piece, the lamports they delivered) and is held to the order's floor as for
 * buys. Anything else throws ComposeError. The rent rule on the seller is `precheckSell`'s.
 */
export function sellLeg({ tokensIn, minSolOut, coinAccount, slippageBps, mint, orderGross, order }) {
  const given = minSolOut !== undefined && minSolOut !== null;
  const bySlippage = slippageBps !== undefined && slippageBps !== null;
  const bps = legArgs({ given, bySlippage, givenMin: minSolOut, slippageBps, coinAccount, mint, what: 'sell', minName: 'minSolOut' });
  const terms = coinTerms(coinAccount); const state = coinState(coinAccount);
  const amount = BigInt(tokensIn);
  const quote = quoteSell(terms, state, amount);
  const ord = orderOf({ total: orderGross, order, asked: quote.gross, what: 'sell', totalName: 'orderGross', coinAccount });
  const threshold = sandwichThreshold(terms, state);
  const p = policy(quote.gross, threshold, sandwichDepth(terms, state), orderGross);
  let min = legMinimum({ out: quote.solOut, given, givenMin: minSolOut, bps, maxBps: p.maxSlippageBps,
    tooMuch: tooMuchFor('sell', quote.gross, threshold, orderGross, p) });
  min = withOrderFloor({ ord, min, out: quote.solOut, piece: amount, given, bps, maxBps: p.maxSlippageBps, what: 'sell', unit: 'lamports' });
  return { tokensIn: amount, minSolOut: min, quote, threshold, large: p.large, maxSlippageBps: p.maxSlippageBps };
}

/**
 * `[...swapInstructions, create the buyer's token account (idempotent), buy]` with the buy leg of buyLeg: `sol_in`
 * from the swap quote (solInFromSwapQuote: native SOL out), capped at `max_quote_in` for a buy that completes the
 * curve, and its own minimum (`minTokensOut`, or `slippageBps`), both on `coinAccount`, the coin as read before
 * signing (and `orderSolIn` / `order` for a piece of a larger order, as buyLeg). `ix` is the deployment's builders (curveInstructions). Returns `{ instructions, solIn, minTokensOut,
 * swapSolIn, quote }`: `solIn` is what the buy offers, `swapSolIn` what the swap is guaranteed to deliver (any
 * difference stays in the wallet).
 */
export function buyWithSwap({ ix, user, coin, mint, swapInstructions, quote, minTokensOut, coinAccount, slippageBps, orderSolIn, order, createTokenAccount = true }) {
  const swapSolIn = solInFromSwapQuote(quote);
  const leg = buyLeg({ solIn: swapSolIn, minTokensOut, coinAccount, slippageBps, mint, orderSolIn, order });
  const userTokenAccount = associatedTokenAddress(user, mint);
  const out = [...swapInstructions];
  if (createTokenAccount) out.push(createAssociatedTokenAccountIdempotent({ payer: user, owner: user, mint }));
  out.push(ix.buy({ user, coin, userTokenAccount, solIn: leg.solIn, minTokensOut: leg.minTokensOut }));
  return { instructions: out, solIn: leg.solIn, minTokensOut: leg.minTokensOut, swapSolIn, quote: leg.quote };
}
