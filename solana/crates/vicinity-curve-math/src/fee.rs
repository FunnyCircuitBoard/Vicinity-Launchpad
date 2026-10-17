//! The fee and its split (5.2) and the gross-up of the partial fill (Lemma G,
//! 5.4).

use crate::arith::{div_floor, mul, sub, to_u64, D};
use crate::error::MathError;
use crate::types::{FeeSplit, Terms};

/// `floor(a * bps / D)`.
#[inline]
fn share(a: u128, bps: u16) -> Result<u64, MathError> {
    to_u64(div_floor(mul(a, bps as u128)?, D)?)
}

/// The fee of a trade amount `A` and its split (5.2):
///
/// ```text
/// fee       = floor(A * t / D)          rounded down: never above t/D (R2)
/// platform  = floor(A * b_P / D)        each named share rounded down
/// founder   = floor(A * b_F / D)
/// holders   = floor(A * b_H / D)
/// buyback   = floor(A * b_B / D)
/// liquidity = fee - platform - founder - holders - buyback   (the remainder)
/// ```
///
/// `A` is the SOL a buyer is charged or the gross SOL a sell releases. Lemma F:
/// the shares add up to `fee`, `liquidity_floor <= liquidity <=
/// liquidity_floor + 4`, and `fee * D <= A * t`.
pub fn fee_split(terms: &Terms, amount: u64) -> Result<FeeSplit, MathError> {
    terms.check_fees()?;
    let a = amount as u128;
    let fee = share(a, terms.total_fee_bps)?;
    let platform = share(a, terms.platform_bps)?;
    let founder = share(a, terms.founder_bps)?;
    let holders = share(a, terms.holders_bps)?;
    let buyback = share(a, terms.buyback_bps)?;
    let named = platform as u128 + founder as u128 + holders as u128 + buyback as u128;
    // Never negative when t is the sum of the five (Lemma F (b)); checked anyway.
    let liquidity = to_u64(sub(fee as u128, named, MathError::InvalidTerms)?)?;
    let liquidity_floor = share(a, terms.liquidity_bps)?;
    Ok(FeeSplit {
        fee,
        liquidity,
        liquidity_floor,
        platform,
        founder,
        holders,
        buyback,
    })
}

/// `floor(A * t / D)` without the split.
#[inline]
pub(crate) fn fee_of(amount: u128, t: u16) -> Result<u128, MathError> {
    div_floor(mul(amount, t as u128)?, D)
}

/// Lemma G for a total fee of `t` basis points: the least charge `G` whose net
/// `G - floor(G * t / D)` is exactly `net` (`net >= 1`):
/// `floor((net - 1) * D / (D - t)) + 1`.
pub(crate) fn gross_for_t(net: u128, t: u16) -> Result<u128, MathError> {
    if net == 0 {
        return Err(MathError::ZeroAmount);
    }
    let dt = sub(D, t as u128, MathError::InvalidTerms)?;
    let g = div_floor(mul(net - 1, D)?, dt)?;
    g.checked_add(1).ok_or(MathError::Overflow)
}

/// Lemma G (5.4): the least `G` with `G - floor(G * t / D) == net`, i.e. the
/// charge of a buy whose net is exactly `net`, fee at most `t/D`. `net` must
/// be at least 1 (`ZeroAmount` otherwise).
pub fn gross_for(terms: &Terms, net: u64) -> Result<u64, MathError> {
    terms.check_fees()?;
    to_u64(gross_for_t(net as u128, terms.total_fee_bps)?)
}
