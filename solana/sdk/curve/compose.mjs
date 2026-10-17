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
import { createAssociatedTokenAccountIdempotent } from './instructions.mjs';
import { associatedTokenAddress } from './pda.mjs';
import { coinState, coinTerms } from './accounts.mjs';
import { quoteBuy, withSlippage } from './math.mjs';

export class ComposeError extends Error {
  constructor(message) { super(`ComposeError: ${message}`); this.name = 'ComposeError'; }
}

/** The largest slippage `buyWithSwap` accepts for the buy leg, in basis points (5%; 14.1's default is 1% to 2%). */
export const MAX_SWAP_SLIPPAGE_BPS = 500;

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
 * The buy leg: `{ solIn, minTokensOut, quote }` for a buy of up to `solIn` on
 * the coin as read before signing (`coinAccount`, a decoded CurveCoin;
 * required, since the cap below reads it):
 *   * `solIn` is capped at the quote's charge when the buy completes the curve
 *     (R3-CLI-1), so the transaction never offers more than the partial quote
 *     priced;
 *   * `minTokensOut` is given (at least 1), or the quote of the capped `solIn`
 *     less `slippageBps` (0 to MAX_SWAP_SLIPPAGE_BPS); exactly one of the two.
 * Anything else throws ComposeError.
 */
export function buyLeg({ solIn, minTokensOut, coinAccount, slippageBps, mint }) {
  const given = minTokensOut !== undefined && minTokensOut !== null;
  const bySlippage = slippageBps !== undefined && slippageBps !== null;
  if (given && bySlippage) throw new ComposeError('pass minTokensOut or slippageBps, not both');
  if (!given && !bySlippage) throw new ComposeError('the buy leg needs its own minimum: pass minTokensOut, or coinAccount and slippageBps (a buy without a minimum can be sandwiched, 14.1)');
  if (given && BigInt(minTokensOut) < 1n) throw new ComposeError('the buy leg needs min_tokens_out of at least 1: a buy without a minimum can be sandwiched (14.1)');
  if (!coinAccount) throw new ComposeError('the buy leg needs coinAccount, the decoded CurveCoin the quote is computed from (a buy that completes the curve offers only its charge, 14.3)');
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
  let min;
  if (given) {
    min = BigInt(minTokensOut);
  } else {
    min = withSlippage(quote.tokensOut, bps);
    if (min < 1n) throw new ComposeError('the buy is too small for a minimum of at least one raw coin');
  }
  return { solIn: capped, minTokensOut: min, quote };
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
