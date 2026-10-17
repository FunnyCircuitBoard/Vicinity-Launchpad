//! Error types. Every function of the crate returns one of these instead of
//! panicking (5.16, T14, T15).

/// Errors of the trade and curve functions.
///
/// The program maps `Overflow`, `DivisionByZero`, `InvalidTerms`,
/// `InvalidState` and `WrongPhase` to its `MathOverflow` (6044); the others
/// have a program error of the same name (4.22).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MathError {
    /// An intermediate left `u128` or a result left `u64` (5.12).
    Overflow,
    /// A division by zero. Only reachable with terms or a state that break the
    /// preconditions of 5.1 (`y0 > S >= s`, `x0 >= 1`, `t < D`).
    DivisionByZero,
    /// A buy below `MIN_TRADE_LAMPORTS` (5.2).
    TradeTooSmall,
    /// A sell of 0 raw units, or a gross-up of a net of 0 lamports.
    ZeroAmount,
    /// The trade would deliver nothing (0 coins to a buyer, 0 lamports to a
    /// seller).
    ZeroOutput,
    /// A curve sell above `tokens_sold`.
    SellExceedsCurve,
    /// The function is not defined in the coin's phase (`max_quote_in` in the
    /// pool).
    WrongPhase,
    /// The frozen terms break a precondition of the math: `total_fee_bps` is
    /// not the sum of the five shares or is not below `D`, `virtual_tokens <=
    /// curve_supply`, `virtual_sol == 0`, or a curve argument outside `[0, S]`.
    InvalidTerms,
    /// The state breaks an invariant the math relies on (curve: `tokens_sold <
    /// S` and `curve_sol < R`), or a quote failed its own consistency check.
    InvalidState,
}

/// Errors of `validate_config`, one per rule of 5.13 (program errors
/// `ConfigFeeTotal` 6011 to `ConfigBuybackHorizon` 6046).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigError {
    /// V1: `1 <= t <= 250`.
    FeeTotal,
    /// V2: platform above 1.2% or founder above 1.0%.
    FeeShareCap,
    /// V3: supplies.
    Supply,
    /// V4: curve bounds and the nonzero buyback cap.
    CurveBounds,
    /// V5 (including V5b): exact completion and the graduation range.
    Graduation,
    /// V6: exact absorption.
    Absorption,
    /// V7: one-sided continuity within 1 part per 10^9.
    Continuity,
    /// V8: single-run buyback MEV bound.
    BuybackMev,
    /// V9: launch fee cap.
    LaunchFee,
    /// V10: the drip cannot be farmed.
    DripFarmable,
    /// V11: multi-run buyback horizon.
    BuybackHorizon,
}

/// Errors of `decode_coin` (5.16, 14.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// The account is not owned by the `vicinity_curve` program.
    WrongOwner,
    /// The data is not exactly 693 bytes.
    WrongLength,
    /// The first 8 bytes are not the `CurveCoin` discriminator.
    WrongDiscriminator,
    /// `layout_version` is not 1.
    WrongLayoutVersion,
    /// `phase` is neither 0 (Curve) nor 1 (Pool).
    InvalidPhase,
}
