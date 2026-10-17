//! The data the math works on: a config's parameters (4.6), a coin's frozen
//! terms and its mutable state (3.7), and the quotes the trade functions return
//! (5.16).

use crate::constants::BPS;
use crate::error::MathError;

/// Phase of a coin (`Coin.phase`, 3.7): 0 Curve, 1 Pool; only 0 to 1, once.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum Phase {
    /// Bonding curve (phase 0).
    #[default]
    Curve = 0,
    /// Pool after graduation (phase 1).
    Pool = 1,
}

impl Phase {
    /// The byte stored in `Coin.phase`.
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    /// The phase of a stored byte; `None` for anything but 0 and 1.
    pub const fn from_u8(v: u8) -> Option<Phase> {
        match v {
            0 => Some(Phase::Curve),
            1 => Some(Phase::Pool),
            _ => None,
        }
    }
}

/// `ConfigParams` of `add_launch_config` (4.6): what `validate_config` checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfigParams {
    /// `b_L`, the 0.5% "protocol/liquidity" bucket.
    pub liquidity_bps: u16,
    /// `b_P`, Vicinity platform.
    pub platform_bps: u16,
    /// `b_F`, city founder.
    pub founder_bps: u16,
    /// `b_H`, city holder rewards.
    pub holders_bps: u16,
    /// `b_B`, buyback and burn.
    pub buyback_bps: u16,
    /// `x0`, virtual lamports at the start.
    pub virtual_sol: u64,
    /// `y0`, virtual raw coins at the start.
    pub virtual_tokens: u64,
    /// `S`, raw coins sold on the curve.
    pub curve_supply: u64,
    /// `P`, raw coins kept for the pool.
    pub pool_supply: u64,
    /// `R`, lamports the curve holds when complete; must equal `f(S)`.
    pub graduation_sol: u64,
    /// Paid to `FEE_RECIPIENT` at launch.
    pub launch_fee_lamports: u64,
}

impl ConfigParams {
    /// Default config #0 (3.5, 5.9): split 0.5/0.7/0.5/0.5/0.3, design A's
    /// integers, R8's sold and pool figures exactly, 85 SOL, 0.05 SOL launch
    /// fee; burns `10^15 - S - P = 9,100,000` raw at launch (O3 (a)).
    pub const DEFAULT: ConfigParams = ConfigParams {
        liquidity_bps: 50,
        platform_bps: 70,
        founder_bps: 50,
        holders_bps: 50,
        buyback_bps: 30,
        virtual_sol: 30_000_853_639,
        virtual_tokens: 1_073_025_598_486_615,
        curve_supply: 793_099_990_000_000,
        pool_supply: 206_900_000_900_000,
        graduation_sol: 85_000_000_000,
        launch_fee_lamports: 50_000_000,
    };

    /// Sum of the five shares (in `u32`, as V1 sums them).
    pub const fn total_fee_bps(&self) -> u32 {
        self.liquidity_bps as u32
            + self.platform_bps as u32
            + self.founder_bps as u32
            + self.holders_bps as u32
            + self.buyback_bps as u32
    }
}

/// A coin's frozen terms (3.7 offsets 129 to 180): the split and the curve,
/// copied from its config at launch and never written again (R4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terms {
    /// `b_L`.
    pub liquidity_bps: u16,
    /// `b_P`.
    pub platform_bps: u16,
    /// `b_F`.
    pub founder_bps: u16,
    /// `b_H`.
    pub holders_bps: u16,
    /// `b_B`.
    pub buyback_bps: u16,
    /// `t`, the sum of the five.
    pub total_fee_bps: u16,
    /// `x0`.
    pub virtual_sol: u64,
    /// `y0`.
    pub virtual_tokens: u64,
    /// `S`.
    pub curve_supply: u64,
    /// `P`.
    pub pool_supply: u64,
    /// `R`.
    pub graduation_sol: u64,
}

impl Terms {
    /// The terms of default config #0.
    pub const DEFAULT: Terms = Terms {
        liquidity_bps: 50,
        platform_bps: 70,
        founder_bps: 50,
        holders_bps: 50,
        buyback_bps: 30,
        total_fee_bps: 250,
        virtual_sol: 30_000_853_639,
        virtual_tokens: 1_073_025_598_486_615,
        curve_supply: 793_099_990_000_000,
        pool_supply: 206_900_000_900_000,
        graduation_sol: 85_000_000_000,
    };

    /// The terms `launch` copies from a config, with `total_fee_bps` computed
    /// as the sum of the five shares (4.6). Fails with `InvalidTerms` when the
    /// sum does not fit `u16`; it does not run `validate_config`.
    pub fn from_params(p: &ConfigParams) -> Result<Terms, MathError> {
        let total = u16::try_from(p.total_fee_bps()).map_err(|_| MathError::InvalidTerms)?;
        Ok(Terms {
            liquidity_bps: p.liquidity_bps,
            platform_bps: p.platform_bps,
            founder_bps: p.founder_bps,
            holders_bps: p.holders_bps,
            buyback_bps: p.buyback_bps,
            total_fee_bps: total,
            virtual_sol: p.virtual_sol,
            virtual_tokens: p.virtual_tokens,
            curve_supply: p.curve_supply,
            pool_supply: p.pool_supply,
            graduation_sol: p.graduation_sol,
        })
    }

    /// Preconditions of the fee functions: `t` equals the sum of the five
    /// shares and `t < D` (so `D - t > 0` in the gross-up).
    pub(crate) fn check_fees(&self) -> Result<(), MathError> {
        let sum = self.liquidity_bps as u32
            + self.platform_bps as u32
            + self.founder_bps as u32
            + self.holders_bps as u32
            + self.buyback_bps as u32;
        if sum != self.total_fee_bps as u32 || sum >= BPS as u32 {
            return Err(MathError::InvalidTerms);
        }
        Ok(())
    }

    /// Preconditions of every curve and trade function (5.1, T15): the fee
    /// preconditions, `x0 >= 1`, `y0 > S >= 1` and `R >= 1`.
    pub(crate) fn check(&self) -> Result<(), MathError> {
        self.check_fees()?;
        if self.virtual_sol == 0
            || self.curve_supply == 0
            || self.virtual_tokens <= self.curve_supply
            || self.graduation_sol == 0
        {
            return Err(MathError::InvalidTerms);
        }
        Ok(())
    }
}

/// The part of a coin's state that trades and buybacks read and write (3.7):
/// the reserves, the five buckets and the lifetime counters a trade or a
/// buyback moves. Outflow counters of the payout instructions
/// (`platform_withdrawn`, `founder_claimed`, ...) and the time fields are the
/// handlers' business.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct State {
    /// `phase`.
    pub phase: Phase,
    /// `s`: raw coins sold on the curve (burned buyback coins count as sold);
    /// `S` after graduation.
    pub tokens_sold: u64,
    /// `r = f(s)` on the curve; frozen at `R` after graduation.
    pub curve_sol: u64,
    /// `X`: pool SOL reserve; 0 on the curve.
    pub pool_sol: u64,
    /// `Y`: pool coin reserve; 0 on the curve.
    pub pool_tokens: u64,
    /// `L`: curve-phase liquidity share not yet in the pool.
    pub liquidity_pending: u64,
    /// Owed to `FEE_RECIPIENT`.
    pub platform_pending: u64,
    /// Owed to the founder.
    pub founder_pending: u64,
    /// Owed to the rewards vault.
    pub holders_pending: u64,
    /// Waiting to be spent on buyback.
    pub buyback_pending: u64,
    /// Slot of the last buyback (the launch slot until the first one).
    pub last_buyback_slot: u64,
    /// +1 per trade.
    pub trade_seq: u64,
    /// Number of buyback runs.
    pub buyback_count: u64,
    /// Raw coins burned by buybacks.
    pub tokens_burned: u64,
    /// Lifetime lamports charged to buyers (fee included).
    pub buy_volume: u128,
    /// Lifetime gross lamports released to sellers (before the fee).
    pub sell_volume: u128,
    /// Lifetime fees.
    pub fees_total: u128,
    /// Lifetime liquidity share, rounding remainders included.
    pub liquidity_earned: u128,
    /// Lifetime lamports moved into `pool_sol` by liquidity shares and drips.
    pub liquidity_added: u128,
    /// Lifetime platform share.
    pub platform_earned: u128,
    /// Lifetime founder share.
    pub founder_earned: u128,
    /// Lifetime holders share.
    pub holders_earned: u128,
    /// Lifetime buyback share.
    pub buyback_earned: u128,
    /// Lifetime lamports moved from the buyback bucket into the reserve.
    pub buyback_spent: u128,
}

impl State {
    /// The state `launch` writes (4.10 effect 6): every field 0, phase Curve,
    /// `last_buyback_slot = launch_slot`.
    pub const fn at_launch(launch_slot: u64) -> State {
        State {
            phase: Phase::Curve,
            tokens_sold: 0,
            curve_sol: 0,
            pool_sol: 0,
            pool_tokens: 0,
            liquidity_pending: 0,
            platform_pending: 0,
            founder_pending: 0,
            holders_pending: 0,
            buyback_pending: 0,
            last_buyback_slot: launch_slot,
            trade_seq: 0,
            buyback_count: 0,
            tokens_burned: 0,
            buy_volume: 0,
            sell_volume: 0,
            fees_total: 0,
            liquidity_earned: 0,
            liquidity_added: 0,
            platform_earned: 0,
            founder_earned: 0,
            holders_earned: 0,
            buyback_earned: 0,
            buyback_spent: 0,
        }
    }
}

/// A trade's fee and its split (5.2), all rounded down except `liquidity`,
/// which takes the remainder (0 to 4 lamports above `liquidity_floor`,
/// Lemma F).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeSplit {
    /// `floor(A * t / D)`.
    pub fee: u64,
    /// `fee - platform - founder - holders - buyback`.
    pub liquidity: u64,
    /// `floor(A * b_L / D)`: the liquidity share without the remainder; the
    /// most a pool trade may drip (5.7).
    pub liquidity_floor: u64,
    /// `floor(A * b_P / D)`.
    pub platform: u64,
    /// `floor(A * b_F / D)`.
    pub founder: u64,
    /// `floor(A * b_H / D)`.
    pub holders: u64,
    /// `floor(A * b_B / D)`.
    pub buyback: u64,
}

/// Result of `quote_buy` (5.4, 5.7).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuyQuote {
    /// Lamports taken from the buyer (`<= sol_in`; less only on the partial
    /// fill of the graduating buy).
    pub charged: u64,
    /// Lamports into the curve or the pool (`charged - fee`).
    pub net: u64,
    /// Raw coins to the buyer.
    pub tokens_out: u64,
    /// Fee of `charged` and its split.
    pub split: FeeSplit,
    /// Lamports moved from `liquidity_pending` into the pool (0 on the curve).
    pub drip: u64,
    /// `charged < sol_in`.
    pub partial: bool,
    /// This buy completes the curve; `new_state` is already in phase Pool.
    pub graduates: bool,
    /// The state to write.
    pub new_state: State,
}

/// Result of `quote_sell` (5.5, 5.7).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SellQuote {
    /// Lamports the market releases before the fee.
    pub gross: u64,
    /// Lamports paid to the seller (`gross - fee`).
    pub sol_out: u64,
    /// Fee of `gross` and its split.
    pub split: FeeSplit,
    /// Lamports moved from `liquidity_pending` into the pool (0 on the curve).
    pub drip: u64,
    /// The state to write.
    pub new_state: State,
}

/// Result of `quote_buyback` when a run does something (7.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuybackQuote {
    /// Lamports moved from `buyback_pending` into the reserve.
    pub spent: u64,
    /// Raw coins to burn from the vault.
    pub coins: u64,
    /// `floor(depth * t / (C * D))` at execution.
    pub cap: u64,
    /// The state to write.
    pub new_state: State,
}
