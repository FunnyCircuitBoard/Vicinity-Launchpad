//! Native-lamport custody (VICINITY-CURVE-DESIGN.md 6.5) and the halt-all
//! guard (8.3).
//!
//! All of a coin's SOL is plain lamports of its `Coin` account. Lamports leave
//! a `Coin` only through [`pay_out`], used by `sell`, `withdraw_platform_fees`,
//! `forward_holders_fees`, `claim_founder_fees` and `payout_founder_fees`.
//!
//! Rule of 4.0: no CPI may follow a direct lamport move unless every account
//! whose lamports moved is in that CPI's account list (the runtime compares
//! the caller's lamport sum over the accounts the CPI lists, and fails with
//! `UnbalancedInstruction` otherwise). In this program the only CPI after a
//! `pay_out` is `emit_cpi!`, whose single account is the event authority, so
//! both sides of the move stay outside it. `forward_holders_fees` therefore
//! does not call SPL `SyncNative` (4.15, SEC-1).

use anchor_lang::prelude::*;

use crate::helpers::debit_after;

/// The single debit helper (6.5): moves `amount` lamports from the `Coin` to
/// `to`, refusing (`RentFloor`) unless the `Coin` keeps at least
/// `liabilities_after + min(rent_reserve, live rent of its size)`.
///
/// `liabilities_after` is computed from the state after the instruction's
/// bookkeeping, so the rent part and every remaining obligation can never be
/// paid out. Without donations a `Coin` holds exactly `rent_reserve +
/// liabilities` (I9), so the check never fails in a correct program; it is the
/// line an auditor can read in one place. The floor uses the smaller of the
/// stored and the live rent, so a rent increase can never block an exit (X63).
pub fn pay_out<'info>(
    coin: &AccountInfo<'info>,
    rent_reserve: u64,
    to: &AccountInfo<'info>,
    amount: u64,
    liabilities_after: u64,
) -> Result<()> {
    let rent_live = Rent::get()?.minimum_balance(coin.data_len());
    let left = debit_after(
        coin.lamports(),
        amount,
        rent_reserve,
        rent_live,
        liabilities_after,
    )?;
    **coin.try_borrow_mut_lamports()? = left;
    let credited = to
        .lamports()
        .checked_add(amount)
        .ok_or(crate::errors::CurveError::MathOverflow)?;
    **to.try_borrow_mut_lamports()? = credited;
    Ok(())
}

/// The halt-all build (8.3): the eight handlers that move lamports or tokens
/// out of a `Coin` or its vault (`launch`, `buy`, `sell`, `buyback_burn`,
/// `withdraw_platform_fees`, `forward_holders_fees`, `claim_founder_fees`,
/// `payout_founder_fees`) call this first and fail with `TradingHalted`.
#[cfg(feature = "halt-all")]
pub fn require_not_halted() -> Result<()> {
    err!(crate::errors::CurveError::TradingHalted)
}

/// Without the `halt-all` feature the guard is empty and compiles away.
#[cfg(not(feature = "halt-all"))]
#[inline(always)]
pub fn require_not_halted() -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 8.3: only the halt-all build refuses, with `TradingHalted` (6043).
    #[test]
    fn halt_all_guard() {
        let r = require_not_halted();
        if cfg!(feature = "halt-all") {
            match r {
                Err(Error::AnchorError(e)) => assert_eq!(e.error_code_number, 6043),
                other => panic!("expected TradingHalted, got {other:?}"),
            }
        } else {
            assert!(r.is_ok());
        }
    }
}
