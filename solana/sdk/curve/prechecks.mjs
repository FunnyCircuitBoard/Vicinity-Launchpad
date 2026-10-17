// Client-side pre-checks of VICINITY-CURVE-DESIGN.md 14.3 (T58): the two
// runtime conditions that make a correct buy, sell or claim fail on chain,
// checked before a transaction is built so the caller gets a clear error
// instead of a failed transaction.
//
//   1. `user` of a `buy` pays `charged` by a system transfer, so it must be a
//      system-owned account without data (a router PDA that carries data, or a
//      key assigned to another program, cannot buy).
//   2. SOL paid to an account holding 0 lamports must be at least the
//      rent-exempt minimum of an empty account (`rent_min(0)`), or the runtime
//      refuses the whole transaction (InsufficientFundsForRent). The rule is
//      `lamports(destination) > 0 or out >= rent_min(0)`: a sell's `sol_out` to
//      its `user`, a claim's `founder_pending` to the founder, a payout's
//      `founder_pending` to the payout wallet.
//   3. The same rent rule on the way out: a buyer whose system account is
//      rent-exempt may end with 0 lamports or with at least `rent_min(0)`, never
//      in between (the runtime refuses a rent-exempt account turning
//      rent-paying), so a buy that would leave dust in the wallet fails too.
//
// Pure functions over account snapshots `{ owner, lamports, data }` (or null
// for an account that does not exist), as RPC and litesvm return them; the
// rent-exempt minimum of an empty account comes from the caller (RPC
// `getMinimumBalanceForRentExemption(0)`, litesvm
// `minimumBalanceForRentExemption(0n)`). Nothing here touches the network.
import { ADDRESSES } from './constants.mjs';
import { coinState, coinTerms } from './accounts.mjs';
import { liabilities, quoteBuy, quoteSell } from './math.mjs';

export class PrecheckError extends Error {
  constructor(code, message) {
    super(`PrecheckError::${code}: ${message}`);
    this.name = 'PrecheckError';
    this.code = code;
  }
}

const ownerOf = (a) => String(a.owner ?? a.programAddress);
const lamportsOf = (a) => (a ? BigInt(a.lamports) : 0n);
const dataLen = (a) => (a?.data ? a.data.length : 0);
const big = (x, what) => {
  if (x === undefined || x === null) throw new TypeError(`${what} missing`);
  return BigInt(x);
};

/**
 * Condition 1 (14.3): `user` must be a system-owned account without data that
 * can pay `charged`; with `rentExemptMinimum`, also condition 3 (what is left
 * is 0 or at least that minimum). Returns nothing; throws PrecheckError
 * otherwise. `charged` is the quote's charge (`quoteBuy(...).charged`);
 * `extraLamports` what else the same transaction takes from `user` (the token
 * account's rent on a first buy, the fee when `user` pays it).
 */
export function precheckBuyer({ userAccount, charged, extraLamports = 0n, rentExemptMinimum }) {
  if (!userAccount || lamportsOf(userAccount) === 0n) throw new PrecheckError('BuyerHoldsNoSol', 'the buyer\'s account holds no lamports');
  if (ownerOf(userAccount) !== ADDRESSES.system) {
    throw new PrecheckError('BuyerNotSystemAccount', `the buyer is owned by ${ownerOf(userAccount)}: a buy pays by a system transfer, which only a system-owned account can make (14.3)`);
  }
  if (dataLen(userAccount) > 0) {
    throw new PrecheckError('BuyerCarriesData', `the buyer carries ${dataLen(userAccount)} bytes of data: a system transfer cannot debit an account with data (14.3; a router PDA with data cannot be the user of a buy)`);
  }
  const need = big(charged, 'charged') + BigInt(extraLamports);
  if (lamportsOf(userAccount) < need) throw new PrecheckError('BuyerCannotPay', `the buyer holds ${lamportsOf(userAccount)} lamports, the transaction takes ${need}`);
  if (rentExemptMinimum !== undefined) {
    const left = lamportsOf(userAccount) - need;
    const rent = BigInt(rentExemptMinimum);
    if (lamportsOf(userAccount) >= rent && left > 0n && left < rent) {
      throw new PrecheckError('BuyerLeftBelowRent', `the buy would leave ${left} lamports in the buyer's account, below the rent-exempt minimum of ${rent}; the runtime would refuse it. Buy ${left} lamports more or ${rent - left} less`);
    }
  }
}

/**
 * Condition 2 (14.3): `lamports(destination) > 0 or amount >= rent_min(0)`.
 * `amount` 0 is a no-op and always passes.
 */
export function precheckSolCredit({ destinationAccount, amount, rentExemptMinimum, what = 'the payment' }) {
  const a = big(amount, 'amount');
  const rent = big(rentExemptMinimum, 'rentExemptMinimum');
  if (a === 0n || lamportsOf(destinationAccount) > 0n) return;
  if (a < rent) {
    throw new PrecheckError('BelowRentExemptMinimum',
      `${what} of ${a} lamports goes to an account holding 0 lamports and is below the rent-exempt minimum of an empty account (${rent}); the runtime would refuse the transaction. Fund the account first or wait for a larger amount (14.3, T58)`);
  }
}

/**
 * A buy of `solIn` by `user` from a decoded coin: the quote, after both
 * conditions of 14.3 hold. `firstBuyRent` is the rent of the token account the
 * same transaction creates (0 when it exists), `feeLamports` the signature fee
 * when `user` pays it.
 */
export function precheckBuy({ coin, userAccount, solIn, firstBuyRent = 0n, feeLamports = 0n, rentExemptMinimum }) {
  const q = quoteBuy(coinTerms(coin), coinState(coin), solIn);
  precheckBuyer({ userAccount, charged: q.charged, extraLamports: BigInt(firstBuyRent) + BigInt(feeLamports), rentExemptMinimum });
  return q;
}

/** A sell of `tokensIn` by `user`: the quote, after the rent condition on `user` (the seller receives `sol_out`). */
export function precheckSell({ coin, userAccount, tokensIn, rentExemptMinimum }) {
  const q = quoteSell(coinTerms(coin), coinState(coin), tokensIn);
  precheckSolCredit({ destinationAccount: userAccount, amount: q.solOut, rentExemptMinimum, what: 'the sell\'s output' });
  return q;
}

/** `claim_founder_fees`: the founder receives the whole `founder_pending`. Returns that amount. */
export function precheckClaim({ coin, founderAccount, rentExemptMinimum }) {
  precheckSolCredit({ destinationAccount: founderAccount, amount: coin.founderPending, rentExemptMinimum, what: 'the founder\'s claim' });
  return coin.founderPending;
}

/** `payout_founder_fees`: the payout wallet receives the whole `founder_pending`. Returns that amount. */
export function precheckPayout({ coin, destinationAccount, rentExemptMinimum }) {
  precheckSolCredit({ destinationAccount, amount: coin.founderPending, rentExemptMinimum, what: 'the founder payout' });
  return coin.founderPending;
}

/**
 * The keeper's top-up of a Coin after a change of the rent rate (6.5, T63, 14.1; review OPS-2): the lamports that let
 * every exit of the coin through, `liabilities + rentExemptMinimum - coinLamports`, or 0. `coin` is the decoded
 * CurveCoin, `coinLamports` its balance, `rentExemptMinimum` the live rent-exempt minimum of a Coin (693 bytes: RPC
 * `getMinimumBalanceForRentExemption(693)`). `pay_out` keeps `liabilities + min(rent_reserve, live)` (6.5), but the
 * runtime refuses any debit that leaves the account below the live minimum, so after a raise of `d` the last `d`
 * lamports of exits stay frozen until the Coin holds its liabilities plus the live minimum. The trigger is
 * `coinLamports < liabilities + rentExemptMinimum`, not `coinLamports < rentExemptMinimum`: a coin above the live
 * minimum can be blocked, and one topped up only to the minimum still is. Lamports donated earlier count.
 */
export function coinRentTopUp({ coin, coinLamports, rentExemptMinimum }) {
  const need = liabilities(coinState(coin)) + big(rentExemptMinimum, 'rentExemptMinimum') - big(coinLamports, 'coinLamports');
  return need > 0n ? need : 0n;
}
