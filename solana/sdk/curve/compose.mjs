// "Pay with any token" (VICINITY-CURVE-DESIGN.md 14.1, 12.5 G03): a swap to
// native SOL followed by our buy in the same transaction. The buy's `sol_in`
// must never exceed what the swap is guaranteed to deliver, or a swap that
// under-delivers makes the buy spend SOL the user already had:
//   * ExactOut quote: the swap delivers exactly `outAmount`, so sol_in = outAmount;
//   * ExactIn quote: the swap delivers at least `otherAmountThreshold` (its minimum
//     output, below which it fails), so sol_in = otherAmountThreshold, never the
//     quoted `outAmount`.
// A buy that completes the curve charges less than sol_in (partial fill); the
// rest of what the swap delivered stays in the user's wallet.
import { createAssociatedTokenAccountIdempotent } from './instructions.mjs';
import { associatedTokenAddress } from './pda.mjs';

export class ComposeError extends Error {
  constructor(message) { super(`ComposeError: ${message}`); this.name = 'ComposeError'; }
}

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
 * `[...swapInstructions, create the buyer's token account (idempotent), buy]`
 * with `sol_in` from the quote (solInFromSwapQuote). `ix` is the deployment's
 * builders (curveInstructions). Returns `{ instructions, solIn }`.
 */
export function buyWithSwap({ ix, user, coin, mint, swapInstructions, quote, minTokensOut = 0n, createTokenAccount = true }) {
  const solIn = solInFromSwapQuote(quote);
  const userTokenAccount = associatedTokenAddress(user, mint);
  const out = [...swapInstructions];
  if (createTokenAccount) out.push(createAssociatedTokenAccountIdempotent({ payer: user, owner: user, mint }));
  out.push(ix.buy({ user, coin, userTokenAccount, solIn, minTokensOut }));
  return { instructions: out, solIn };
}
