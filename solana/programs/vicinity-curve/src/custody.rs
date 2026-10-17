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
    move_lamports(coin, rent_reserve, rent_live, to, amount, liabilities_after)
}

/// The lamport move of [`pay_out`], given the live rent figure (split out so
/// that the unit tests can run it on real `AccountInfo`s without the `Rent`
/// sysvar). Both balances are computed before either is written, so a refusal
/// leaves both untouched; the debit and the credit are of the same `amount`.
///
/// `to` must be another account than the `Coin` (`InvalidAddress`). No caller
/// can pass the `Coin` itself (the destinations are a signer, the compiled
/// `FEE_RECIPIENT`, a token account or a system-owned wallet), so this only
/// keeps a future caller from booking a payout that moves nothing
/// (VICINITY-CURVE-NOTES.md entry 22).
fn move_lamports(
    coin: &AccountInfo,
    rent_reserve: u64,
    rent_live: u64,
    to: &AccountInfo,
    amount: u64,
    liabilities_after: u64,
) -> Result<()> {
    require_keys_neq!(
        *coin.key,
        *to.key,
        crate::errors::CurveError::InvalidAddress
    );
    let left = debit_after(
        coin.lamports(),
        amount,
        rent_reserve,
        rent_live,
        liabilities_after,
    )?;
    let credited = to
        .lamports()
        .checked_add(amount)
        .ok_or(crate::errors::CurveError::MathOverflow)?;
    **coin.try_borrow_mut_lamports()? = left;
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

    fn code(r: Result<()>) -> u32 {
        match r {
            Err(Error::AnchorError(e)) => e.error_code_number,
            other => panic!("expected an Anchor error, got {other:?}"),
        }
    }

    /// Runs `f` on a `Coin`-like account (owned by this program, 693 bytes)
    /// holding `coin_lamports` and a destination holding `to_lamports`, and
    /// returns the result with both balances afterwards.
    fn run(
        coin_lamports: u64,
        to_lamports: u64,
        f: impl FnOnce(&AccountInfo, &AccountInfo) -> Result<()>,
    ) -> (Result<()>, u64, u64) {
        let (coin_key, to_key) = (Pubkey::new_unique(), Pubkey::new_unique());
        let (mut cl, mut tl) = (coin_lamports, to_lamports);
        let mut coin_data = vec![0u8; crate::constants::COIN_LEN];
        let mut to_data: Vec<u8> = Vec::new();
        let system = anchor_lang::system_program::ID;
        let coin = AccountInfo::new(
            &coin_key,
            false,
            true,
            &mut cl,
            &mut coin_data,
            &crate::ID,
            false,
            0,
        );
        let to = AccountInfo::new(
            &to_key,
            true,
            true,
            &mut tl,
            &mut to_data,
            &system,
            false,
            0,
        );
        let r = f(&coin, &to);
        let (c, t) = (coin.lamports(), to.lamports());
        (r, c, t)
    }

    /// 6.5: the move debits the `Coin` and credits the destination by the same
    /// amount, down to exactly `rent + liabilities_after`.
    #[test]
    fn move_lamports_pays_exactly_down_to_the_floor() {
        let rent = 5_714_160;
        let liab_after = 49_375_000;
        let out = 950_625_000;
        let bal = rent + liab_after + out;
        let (r, c, t) = run(bal, 7, |coin, to| {
            move_lamports(coin, rent, rent, to, out, liab_after)
        });
        assert!(r.is_ok());
        assert_eq!((c, t), (rent + liab_after, 7 + out));
    }

    /// A refused move (below the floor, more than the balance, a credit that
    /// overflows) leaves both balances untouched.
    #[test]
    fn refused_moves_change_nothing() {
        let rent = 1_000;
        let cases: [(u64, u64, u64, u64, u32); 3] = [
            // (coin balance, destination balance, amount, liabilities, error)
            (rent + 100, 0, 101, 0, 6037),
            (50, 0, 51, 0, 6037),
            (rent + 100, u64::MAX, 100, 0, 6044),
        ];
        for (bal, to_bal, amount, liab, err) in cases {
            let (r, c, t) = run(bal, to_bal, |coin, to| {
                move_lamports(coin, rent, rent, to, amount, liab)
            });
            assert_eq!(code(r), err, "{bal} {to_bal} {amount} {liab}");
            assert_eq!((c, t), (bal, to_bal), "nothing moved");
        }
    }

    /// X63: a higher live rent never raises the floor above the stored rent;
    /// a lower one lowers it.
    #[test]
    fn floor_uses_the_smaller_rent() {
        let rent = 5_714_160;
        let (r, c, _) = run(rent + 10, 0, |coin, to| {
            move_lamports(coin, rent, rent + rent / 10, to, 10, 0)
        });
        assert!(r.is_ok());
        assert_eq!(c, rent);
        let (r, c, _) = run(rent + 10, 0, |coin, to| {
            move_lamports(coin, rent, rent - 5, to, 15, 0)
        });
        assert!(r.is_ok());
        assert_eq!(c, rent - 5);
    }

    /// Donated lamports above `rent + liabilities` stay in the `Coin`: a debit
    /// takes only its amount.
    #[test]
    fn donations_stay() {
        let (r, c, t) = run(10_000 + 777, 0, |coin, to| {
            move_lamports(coin, 1_000, 1_000, to, 4_000, 5_000)
        });
        assert!(r.is_ok());
        assert_eq!((c, t), (6_777, 4_000));
    }

    /// The destination can never be the `Coin` itself (`InvalidAddress`).
    #[test]
    fn destination_must_differ_from_the_coin() {
        let key = Pubkey::new_unique();
        let mut lamports = 10_000u64;
        let mut data = vec![0u8; crate::constants::COIN_LEN];
        let coin = AccountInfo::new(
            &key,
            false,
            true,
            &mut lamports,
            &mut data,
            &crate::ID,
            false,
            0,
        );
        let alias = coin.clone();
        assert_eq!(code(move_lamports(&coin, 0, 0, &alias, 1, 0)), 6002);
        assert_eq!(coin.lamports(), 10_000);
    }

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
