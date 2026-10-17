//! `CurveError` (VICINITY-CURVE-DESIGN.md 4.22): codes from 6000 in exactly
//! this order; new codes are only ever appended. Messages are written for the
//! person reading a failed transaction in an explorer.

use anchor_lang::prelude::*;
use vicinity_curve_math::{ConfigError, MathError};

#[error_code]
pub enum CurveError {
    /// 6000
    #[msg("signer is not allowed to do this")]
    Unauthorized,
    /// 6001
    #[msg("signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    /// 6002
    #[msg("a pinned address, PDA, owner, size or discriminator check failed")]
    InvalidAddress,
    /// 6003
    #[msg("no admin transfer is pending")]
    NoPendingAdmin,
    /// 6004
    #[msg("signer is not the pending admin")]
    NotPendingAdmin,
    /// 6005
    #[msg("launches are paused")]
    LaunchesPaused,
    /// 6006
    #[msg("payouts are paused")]
    PayoutsPaused,
    /// 6007
    #[msg("opted-in payouts are not configured")]
    PayoutsNotConfigured,
    /// 6008
    #[msg("the admin, the payout key and the payout wallet must be three different keys, and neither payout key nor payout wallet may be the guardian or the fee recipient")]
    PayoutKeyNotSeparate,
    /// 6009
    #[msg("this launch config is disabled")]
    ConfigDisabled,
    /// 6010
    #[msg("65,535 launch configs reached")]
    ConfigCount,
    /// 6011
    #[msg("V1: the five fee shares must add up to 1 to 250 basis points")]
    ConfigFeeTotal,
    /// 6012
    #[msg("V2: platform share above 1.2%, founder share above 1.0%, or a founder or holders share that leaves less than 0.01% of the fee")]
    ConfigFeeShareCap,
    /// 6013
    #[msg("V3: curve and pool supplies out of range")]
    ConfigSupply,
    /// 6014
    #[msg("V4: virtual reserves out of range, or a buyback cap could be 0")]
    ConfigCurveBounds,
    /// 6015
    #[msg("V5: the curve must complete at exactly graduation_sol (1 to 10,000 SOL) and the last buy must add at least one lamport")]
    ConfigGraduation,
    /// 6016
    #[msg("V6: the curve would leave dust (x0 * y0 > (y0 - S)^2)")]
    ConfigAbsorption,
    /// 6017
    #[msg("V7: the pool must open at most 1 part per billion below the curve's last price, never above")]
    ConfigContinuity,
    /// 6018
    #[msg("V8: the buyback could be sandwiched at a profit")]
    ConfigBuybackMev,
    /// 6019
    #[msg("V9: launch fee above 0.5 SOL")]
    ConfigLaunchFee,
    /// 6020
    #[msg("city_id must be at least 1")]
    BadCityId,
    /// 6021
    #[msg("coin name must be 1 to 32 bytes without control or invisible formatting characters")]
    BadName,
    /// 6022
    #[msg("ticker must be 1 to 10 characters A-Z or 0-9")]
    BadSymbol,
    /// 6023
    #[msg("expiry must be in the future and at most 30 days away")]
    BadExpiry,
    /// 6024
    #[msg("this approval has expired")]
    ApprovalExpired,
    /// 6025
    #[msg("only the admin may revoke an approval that has not expired")]
    ApprovalNotExpired,
    /// 6026
    #[msg("this city already has a coin")]
    CoinAlreadyLaunched,
    /// 6027
    #[msg("this ticker is already taken")]
    TickerTaken,
    /// 6028
    #[msg("this city has a coin under vicinity_launchpad")]
    LegacyCoinExists,
    /// 6029
    #[msg("signer is not this coin's founder")]
    WrongFounder,
    /// 6030
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    /// 6031
    #[msg("a buy must be at least 0.0001 SOL")]
    TradeTooSmall,
    /// 6032
    #[msg("this trade would return nothing")]
    ZeroOutput,
    /// 6033
    #[msg("price moved beyond the slippage limit")]
    SlippageExceeded,
    /// 6034
    #[msg("cannot sell more coins than the curve has sold")]
    SellExceedsCurve,
    /// 6035
    #[msg("the user token account belongs to the coin")]
    SameAccount,
    /// 6036
    #[msg("wrong token account: other mint, or not owned by the seller")]
    WrongTokenAccount,
    /// 6037
    #[msg("this debit would breach the rent part plus the coin's liabilities")]
    RentFloor,
    /// 6038
    #[msg("the city's rewards config must pay holders only, in WSOL, through this vault, for this coin, with the admin as its authority and no transfer pending")]
    WrongRewardsConfig,
    /// 6039
    #[msg("wrong rewards vault")]
    WrongRewardsVault,
    /// 6040
    #[msg("payout destination does not match")]
    DestinationMismatch,
    /// 6041
    #[msg("the payout opt-in was signed by another founder")]
    OptInFounderMismatch,
    /// 6042
    #[msg("at most one payout per coin per 24 hours")]
    PayoutTooSoon,
    /// 6043
    #[msg("trading is halted (halt-all build)")]
    TradingHalted,
    /// 6044
    #[msg("arithmetic overflow")]
    MathOverflow,
    /// 6045
    #[msg("V10: the liquidity share must be 0 or below the platform share")]
    ConfigDripFarmable,
    /// 6046
    #[msg("V11: a multi-run buyback hold would pay off too soon")]
    ConfigBuybackHorizon,
    /// 6047
    #[msg("this city has a pending approval under vicinity_launchpad")]
    LegacyApprovalExists,
    /// 6048
    #[msg("vicinity_launchpad launches are not paused")]
    LegacyLaunchesOpen,
    /// 6049
    #[msg("buys are halted")]
    BuysHalted,
    /// 6050
    #[msg("meta_hash must not be all zeros")]
    BadMetaHash,
    /// 6051
    #[msg(
        "vicinity_launchpad's admin must be this program's admin, with no admin transfer pending"
    )]
    LegacyAdminMismatch,
    /// 6052
    #[msg("the fee recipient cannot be the admin, the proposed admin, the guardian, the upgrade authority at init or a coin's founder")]
    FeeRecipientRole,
    /// 6053
    #[msg("a coin's founder cannot be the guardian or the payout key")]
    FounderHoldsRole,
}

/// The program error for a math crate error (4.22): the trade refusals keep
/// their names; every other math error (overflow, a broken precondition, a
/// failed self-check) is `MathOverflow`.
pub fn math_error(e: MathError) -> CurveError {
    match e {
        MathError::TradeTooSmall => CurveError::TradeTooSmall,
        MathError::ZeroAmount => CurveError::ZeroAmount,
        MathError::ZeroOutput => CurveError::ZeroOutput,
        MathError::SellExceedsCurve => CurveError::SellExceedsCurve,
        MathError::Overflow
        | MathError::DivisionByZero
        | MathError::WrongPhase
        | MathError::InvalidTerms
        | MathError::InvalidState => CurveError::MathOverflow,
    }
}

/// `math_error` as an Anchor error, for `map_err`.
pub fn math_err(e: MathError) -> Error {
    math_error(e).into()
}

/// The program error of each `validate_config` rule (5.13).
pub fn config_error(e: ConfigError) -> CurveError {
    match e {
        ConfigError::FeeTotal => CurveError::ConfigFeeTotal,
        ConfigError::FeeShareCap => CurveError::ConfigFeeShareCap,
        ConfigError::Supply => CurveError::ConfigSupply,
        ConfigError::CurveBounds => CurveError::ConfigCurveBounds,
        ConfigError::Graduation => CurveError::ConfigGraduation,
        ConfigError::Absorption => CurveError::ConfigAbsorption,
        ConfigError::Continuity => CurveError::ConfigContinuity,
        ConfigError::BuybackMev => CurveError::ConfigBuybackMev,
        ConfigError::LaunchFee => CurveError::ConfigLaunchFee,
        ConfigError::DripFarmable => CurveError::ConfigDripFarmable,
        ConfigError::BuybackHorizon => CurveError::ConfigBuybackHorizon,
    }
}

/// `config_error` as an Anchor error, for `map_err`.
pub fn config_err(e: ConfigError) -> Error {
    config_error(e).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 4.22: the codes are fixed; a reordering would break every client.
    #[test]
    fn codes_are_in_spec_order() {
        let table: [(CurveError, u32); 54] = [
            (CurveError::Unauthorized, 6000),
            (CurveError::NotUpgradeAuthority, 6001),
            (CurveError::InvalidAddress, 6002),
            (CurveError::NoPendingAdmin, 6003),
            (CurveError::NotPendingAdmin, 6004),
            (CurveError::LaunchesPaused, 6005),
            (CurveError::PayoutsPaused, 6006),
            (CurveError::PayoutsNotConfigured, 6007),
            (CurveError::PayoutKeyNotSeparate, 6008),
            (CurveError::ConfigDisabled, 6009),
            (CurveError::ConfigCount, 6010),
            (CurveError::ConfigFeeTotal, 6011),
            (CurveError::ConfigFeeShareCap, 6012),
            (CurveError::ConfigSupply, 6013),
            (CurveError::ConfigCurveBounds, 6014),
            (CurveError::ConfigGraduation, 6015),
            (CurveError::ConfigAbsorption, 6016),
            (CurveError::ConfigContinuity, 6017),
            (CurveError::ConfigBuybackMev, 6018),
            (CurveError::ConfigLaunchFee, 6019),
            (CurveError::BadCityId, 6020),
            (CurveError::BadName, 6021),
            (CurveError::BadSymbol, 6022),
            (CurveError::BadExpiry, 6023),
            (CurveError::ApprovalExpired, 6024),
            (CurveError::ApprovalNotExpired, 6025),
            (CurveError::CoinAlreadyLaunched, 6026),
            (CurveError::TickerTaken, 6027),
            (CurveError::LegacyCoinExists, 6028),
            (CurveError::WrongFounder, 6029),
            (CurveError::ZeroAmount, 6030),
            (CurveError::TradeTooSmall, 6031),
            (CurveError::ZeroOutput, 6032),
            (CurveError::SlippageExceeded, 6033),
            (CurveError::SellExceedsCurve, 6034),
            (CurveError::SameAccount, 6035),
            (CurveError::WrongTokenAccount, 6036),
            (CurveError::RentFloor, 6037),
            (CurveError::WrongRewardsConfig, 6038),
            (CurveError::WrongRewardsVault, 6039),
            (CurveError::DestinationMismatch, 6040),
            (CurveError::OptInFounderMismatch, 6041),
            (CurveError::PayoutTooSoon, 6042),
            (CurveError::TradingHalted, 6043),
            (CurveError::MathOverflow, 6044),
            (CurveError::ConfigDripFarmable, 6045),
            (CurveError::ConfigBuybackHorizon, 6046),
            (CurveError::LegacyApprovalExists, 6047),
            (CurveError::LegacyLaunchesOpen, 6048),
            (CurveError::BuysHalted, 6049),
            (CurveError::BadMetaHash, 6050),
            (CurveError::LegacyAdminMismatch, 6051),
            (CurveError::FeeRecipientRole, 6052),
            (CurveError::FounderHoldsRole, 6053),
        ];
        for (e, code) in table {
            assert_eq!(u32::from(e), code, "{e:?}");
        }
    }

    #[test]
    fn math_errors_map_to_their_names() {
        let code = |e: MathError| u32::from(math_error(e));
        assert_eq!(code(MathError::TradeTooSmall), 6031);
        assert_eq!(code(MathError::ZeroAmount), 6030);
        assert_eq!(code(MathError::ZeroOutput), 6032);
        assert_eq!(code(MathError::SellExceedsCurve), 6034);
        for e in [
            MathError::Overflow,
            MathError::DivisionByZero,
            MathError::WrongPhase,
            MathError::InvalidTerms,
            MathError::InvalidState,
        ] {
            assert_eq!(code(e), 6044, "{e:?}");
        }
    }

    #[test]
    fn config_errors_map_to_their_rules() {
        let pairs = [
            (ConfigError::FeeTotal, 6011),
            (ConfigError::FeeShareCap, 6012),
            (ConfigError::Supply, 6013),
            (ConfigError::CurveBounds, 6014),
            (ConfigError::Graduation, 6015),
            (ConfigError::Absorption, 6016),
            (ConfigError::Continuity, 6017),
            (ConfigError::BuybackMev, 6018),
            (ConfigError::LaunchFee, 6019),
            (ConfigError::DripFarmable, 6045),
            (ConfigError::BuybackHorizon, 6046),
        ];
        for (e, code) in pairs {
            assert_eq!(u32::from(config_error(e)), code, "{e:?}");
        }
    }
}
