//! `vicinity-curve-math`: the pure integer math of the `vicinity_curve`
//! program, as specified in `solana/VICINITY-CURVE-DESIGN.md` sections 5
//! (math), 5.13 (`validate_config`), 5.16 (this crate) and 7.1 (buyback
//! amounts).
//!
//! The program calls these functions for every number it computes and writes
//! what they return, so an off-chain quote equals the on-chain result to the
//! lamport. Ground rules (3.1, 5.12):
//!
//! * `#![no_std]`, `#![forbid(unsafe_code)]`, no dependency besides `core`;
//! * amounts are `u64` in and out, every product and quotient is computed in
//!   `u128`, every addition and subtraction is checked and every narrowing goes
//!   through `try_from`;
//! * every function returns `Result<_, MathError>` (or [`ConfigError`] /
//!   [`DecodeError`]) instead of panicking;
//! * every rounding is the one of the rounding table 5.11: the fee and the
//!   named shares round down (the remainder stays in liquidity), the curve value
//!   `f(s)` rounds up, coins out and lamports out round down, the drip is the
//!   rounded-down liquidity share, the buyback cap rounds down and the
//!   partial-fill charge is the least charge with the exact net (Lemma G).
//!
//! The reference model of Appendix A (`reference/model.py`, verbatim) is the
//! oracle: `tests/differential.rs` replays `reference/vectors.json`, generated
//! from it, and requires exact equality.
//!
//! Implementation notes for the auditors (every place where this crate had to
//! choose between readings of the specification) are in
//! `solana/VICINITY-CURVE-NOTES.md`.

#![no_std]
#![forbid(unsafe_code)]
#![deny(missing_docs)]

mod arith;
mod config;
pub mod constants;
mod decode;
mod error;
mod fee;
mod trade;
mod types;

pub use config::{
    derive_curve, derive_curve_within, v11_sides, v8_sides, validate_config, V11Sides,
};
pub use decode::{decode_coin, CoinView};
pub use error::{ConfigError, DecodeError, MathError};
pub use fee::{fee_split, gross_for};
pub use trade::{
    buyback_cap, curve_value, depth, launch_dust, liabilities, max_quote_in, quote_buy,
    quote_buyback, quote_sell, spot_price, tokens_for,
};
pub use types::{BuyQuote, BuybackQuote, ConfigParams, FeeSplit, Phase, SellQuote, State, Terms};
