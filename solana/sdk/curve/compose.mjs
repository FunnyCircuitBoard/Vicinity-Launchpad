// "Pay with any token" (VICINITY-CURVE-DESIGN.md 14.1, 12.5 G03): a swap to
// native SOL followed by our buy in the same transaction. Two limits protect
// the user, one per leg:
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
//     `buyWithSwap` therefore refuses to build a buy without a positive minimum:
//     the caller passes `minTokensOut`, or the coin's snapshot and a slippage
//     in basis points (at most MAX_SWAP_SLIPPAGE_BPS), from which the minimum
//     is the quote for the guaranteed `sol_in`, less the slippage.
// A buy that completes the curve charges less than sol_in (partial fill); the
// rest of what the swap delivered stays in the user's wallet.
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
 * The buy leg's `min_tokens_out` for `solIn`: `minTokensOut` as given (it must
 * be at least 1), or the quote of `solIn` on the coin's snapshot (`coinAccount`,
 * a decoded CurveCoin) less `slippageBps` (0 to MAX_SWAP_SLIPPAGE_BPS). Exactly
 * one of the two ways; anything else throws ComposeError, so no buy is ever
 * built without a limit.
 */
export function buyLegMinimum({ solIn, minTokensOut, coinAccount, slippageBps, mint }) {
  const given = minTokensOut !== undefined && minTokensOut !== null;
  const bySlippage = slippageBps !== undefined && slippageBps !== null;
  if (given && bySlippage) throw new ComposeError('pass minTokensOut or slippageBps, not both');
  if (given) {
    const min = BigInt(minTokensOut);
    if (min < 1n) throw new ComposeError('the buy leg needs min_tokens_out of at least 1: a buy without a minimum can be sandwiched (14.1)');
    return min;
  }
  if (!bySlippage) throw new ComposeError('the buy leg needs its own minimum: pass minTokensOut, or coinAccount and slippageBps (a buy without a minimum can be sandwiched, 14.1)');
  const bps = Number(slippageBps);
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SWAP_SLIPPAGE_BPS) throw new ComposeError(`slippageBps must be an integer from 0 to ${MAX_SWAP_SLIPPAGE_BPS}, got ${slippageBps}`);
  if (!coinAccount) throw new ComposeError('slippageBps needs coinAccount, the decoded CurveCoin the quote is computed from');
  if (mint !== undefined && String(coinAccount.mint) !== String(mint)) throw new ComposeError(`coinAccount is the coin of mint ${coinAccount.mint}, not ${mint}`);
  const q = quoteBuy(coinTerms(coinAccount), coinState(coinAccount), BigInt(solIn));
  const min = withSlippage(q.tokensOut, bps);
  if (min < 1n) throw new ComposeError('the buy is too small for a minimum of at least one raw coin');
  return min;
}

/**
 * `[...swapInstructions, create the buyer's token account (idempotent), buy]`
 * with `sol_in` from the quote (solInFromSwapQuote) and the buy leg's own
 * minimum (buyLegMinimum: `minTokensOut`, or `coinAccount` with
 * `slippageBps`). `ix` is the deployment's builders (curveInstructions).
 * Returns `{ instructions, solIn, minTokensOut }`.
 */
export function buyWithSwap({ ix, user, coin, mint, swapInstructions, quote, minTokensOut, coinAccount, slippageBps, createTokenAccount = true }) {
  const solIn = solInFromSwapQuote(quote);
  const min = buyLegMinimum({ solIn, minTokensOut, coinAccount, slippageBps, mint });
  const userTokenAccount = associatedTokenAddress(user, mint);
  const out = [...swapInstructions];
  if (createTokenAccount) out.push(createAssociatedTokenAccountIdempotent({ payer: user, owner: user, mint }));
  out.push(ix.buy({ user, coin, userTokenAccount, solIn, minTokensOut: min }));
  return { instructions: out, solIn, minTokensOut: min };
}
