//! Checked `u128` helpers. Every product, quotient, sum and difference of the
//! crate goes through one of these (5.12), so no expression can wrap or panic.

use crate::error::MathError;

/// `D` as `u128`.
pub(crate) const D: u128 = crate::constants::BPS as u128;

#[inline]
pub(crate) fn mul(a: u128, b: u128) -> Result<u128, MathError> {
    a.checked_mul(b).ok_or(MathError::Overflow)
}

#[inline]
pub(crate) fn add(a: u128, b: u128) -> Result<u128, MathError> {
    a.checked_add(b).ok_or(MathError::Overflow)
}

/// `a - b`; a negative result is reported as `err` (the caller knows whether it
/// means an overflow or a broken state).
#[inline]
pub(crate) fn sub(a: u128, b: u128, err: MathError) -> Result<u128, MathError> {
    a.checked_sub(b).ok_or(err)
}

/// `floor(a / b)`.
#[inline]
pub(crate) fn div_floor(a: u128, b: u128) -> Result<u128, MathError> {
    a.checked_div(b).ok_or(MathError::DivisionByZero)
}

/// `ceil(a / b)`, computed as `floor(a / b) + (a mod b != 0)` so that it needs
/// no `a + b - 1` (equal to 5.1's `(a + b - 1) / b`, without its overflow).
#[inline]
pub(crate) fn div_ceil(a: u128, b: u128) -> Result<u128, MathError> {
    if b == 0 {
        return Err(MathError::DivisionByZero);
    }
    Ok(a.div_ceil(b))
}

/// Narrowing to `u64` (`try_from`, 5.12).
#[inline]
pub(crate) fn to_u64(a: u128) -> Result<u64, MathError> {
    u64::try_from(a).map_err(|_| MathError::Overflow)
}

#[inline]
pub(crate) fn add64(a: u64, b: u64) -> Result<u64, MathError> {
    a.checked_add(b).ok_or(MathError::Overflow)
}

#[inline]
pub(crate) fn sub64(a: u64, b: u64, err: MathError) -> Result<u64, MathError> {
    a.checked_sub(b).ok_or(err)
}

/// Adds a `u64` amount to a `u128` lifetime counter.
#[inline]
pub(crate) fn add128(a: u128, b: u64) -> Result<u128, MathError> {
    a.checked_add(b as u128).ok_or(MathError::Overflow)
}
