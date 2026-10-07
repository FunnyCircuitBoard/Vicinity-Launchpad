//! `validate_vicinity_config` (LAUNCHPAD-DESIGN.md section 7.2): the only
//! Meteora DBC configs our program will launch coins under. It runs at
//! `add_launch_config` and again at every `launch`, in case a vendor upgrade
//! ever made configs mutable. Each rule has its own error so a failed check
//! names the rule it hit.
//!
//! The raise target and the curve shape are deliberately not constrained; the
//! price and supply mathematics are DBC's own validation at `create_config`.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::dynamic_bonding_curve::accounts::PoolConfig;
use crate::errors::LaunchpadError;

/// Rule 2: the quote token. Classic SPL Token only (so no Token-2022 extension
/// such as a permanent delegate, pause, transfer hook or transfer fee can ever
/// reach a curve), no mint or freeze authority, 6 to 9 decimals. WSOL and
/// $VICINITY pass; USDC (authorities), xStocks and every Token-2022 mint fail.
pub fn validate_quote_mint(
    owner: &Pubkey,
    has_mint_authority: bool,
    has_freeze_authority: bool,
    decimals: u8,
) -> Result<()> {
    require!(
        *owner == anchor_spl::token::ID
            && !has_mint_authority
            && !has_freeze_authority
            && (MIN_QUOTE_DECIMALS..=MAX_QUOTE_DECIMALS).contains(&decimals),
        LaunchpadError::QuoteMintNotAllowed
    );
    Ok(())
}

/// Rules 1 and 3 to 13, plus the config half of rule 2.
pub fn validate_vicinity_config(c: &PoolConfig) -> Result<()> {
    // (1) every platform fee and the leftover go to the dev wallet
    require_keys_eq!(
        c.fee_claimer,
        FEE_RECIPIENT,
        LaunchpadError::ConfigFeeClaimer
    );
    require_keys_eq!(
        c.leftover_receiver,
        FEE_RECIPIENT,
        LaunchpadError::ConfigLeftoverReceiver
    );
    // (2) the config's quote token is classic SPL (0); the mint itself is
    // checked by validate_quote_mint
    require!(c.quote_token_flag == 0, LaunchpadError::QuoteMintNotAllowed);
    // (3) classic SPL coin, 6 decimals, fixed supply of exactly 10^15
    require!(c.token_type == 0, LaunchpadError::ConfigTokenType);
    require!(
        c.token_decimal == COIN_DECIMALS
            && c.fixed_token_supply_flag == 1
            && c.pre_migration_token_supply == COIN_SUPPLY_RAW
            && c.post_migration_token_supply == COIN_SUPPLY_RAW,
        LaunchpadError::ConfigDecimalsOrSupply
    );
    // (4) fees in the quote token, so base fees are always 0
    require!(
        c.collect_fee_mode == 0,
        LaunchpadError::ConfigCollectFeeMode
    );
    // (5) a flat fee scheduler (mode 0 or 1 with no decay), no dynamic fee,
    // capped, and no cheaper "minimum fee" for the first buy (with a flat fee
    // that flag changes nothing today; refusing it keeps a future fee mode or
    // Meteora upgrade from quietly lowering the founder's first-buy fee)
    let base = &c.pool_fees.base_fee;
    require!(
        base.base_fee_mode <= 1
            && base.first_factor == 0
            && base.second_factor == 0
            && base.third_factor == 0
            && base.cliff_fee_numerator <= MAX_TRADE_FEE_NUMERATOR
            && c.pool_fees.dynamic_fee.initialized == 0
            && c.enable_first_swap_with_min_fee == 0,
        LaunchpadError::ConfigFee
    );
    // (6) the city's half
    require!(
        c.creator_trading_fee_percentage == REQUIRED_CREATOR_FEE_PERCENT,
        LaunchpadError::ConfigFeeSplit
    );
    // (7) immutable metadata (TokenAuthorityOption::Immutable)
    require!(
        c.token_update_authority == 1,
        LaunchpadError::ConfigMetadataMutable
    );
    // (8) all graduated liquidity locked for ever, 50/50, nothing withdrawable or vesting
    let no_vesting = |v: &crate::dynamic_bonding_curve::types::LiquidityVestingInfo| {
        v.is_initialized == 0
            && v.vesting_percentage == 0
            && v.bps_per_period == 0
            && v.number_of_periods == 0
            && v.frequency == 0
            && v.cliff_duration_from_migration_time == 0
    };
    require!(
        c.partner_liquidity_percentage == 0
            && c.creator_liquidity_percentage == 0
            && c.partner_permanent_locked_liquidity_percentage
                == REQUIRED_PARTNER_LOCKED_LP_PERCENT
            && c.creator_permanent_locked_liquidity_percentage
                == REQUIRED_CREATOR_LOCKED_LP_PERCENT
            && no_vesting(&c.partner_liquidity_vesting_info)
            && no_vesting(&c.creator_liquidity_vesting_info),
        LaunchpadError::ConfigLiquidityLock
    );
    // (9) DAMM v2 customizable pool, flat quote-only fee of at most 2%: no
    // dynamic (volatility) fee on top, no market-cap scheduler, no compounding
    require!(
        c.migration_option == 1
            && c.migration_fee_option == 6
            && c.migrated_collect_fee_mode == 0
            && c.migrated_pool_fee_bps <= MAX_MIGRATED_POOL_FEE_BPS
            && c.migrated_dynamic_fee == 0
            && c.migrated_pool_base_fee_mode == 0
            && c.migrated_pool_base_fee_bytes == [0u8; 16]
            && c.migrated_compounding_fee_bps == 0,
        LaunchpadError::ConfigMigration
    );
    // (10) no graduation fee
    require!(
        c.migration_fee_percentage == 0 && c.creator_migration_fee_percentage == 0,
        LaunchpadError::ConfigMigrationFee
    );
    // (11) no locked vesting (team allocation)
    let lv = &c.locked_vesting_config;
    require!(
        lv.amount_per_period == 0
            && lv.cliff_duration_from_migration_time == 0
            && lv.frequency == 0
            && lv.number_of_period == 0
            && lv.cliff_unlock_amount == 0,
        LaunchpadError::ConfigVesting
    );
    // (12) launch fee cap
    require!(
        c.pool_creation_fee <= MAX_POOL_CREATION_FEE_LAMPORTS,
        LaunchpadError::ConfigLaunchFee
    );
    // (13) no hidden allocation through the leftover: DBC sends whatever is
    // neither sold on the curve nor kept for the graduated pool to the
    // leftover receiver (the dev wallet, rule 1). Only rounding dust may be left.
    require!(
        config_leftover(c)? <= MAX_LEFTOVER_RAW as u128,
        LaunchpadError::ConfigLeftover
    );
    Ok(())
}

/// Rule 13: coins a config leaves over after graduation, in raw units:
/// supply - swap_base_amount - migration_base_threshold, in u128 with checked
/// subtraction. A config that sells or keeps more than the supply is refused.
pub fn config_leftover(c: &PoolConfig) -> Result<u128> {
    (c.pre_migration_token_supply as u128)
        .checked_sub(c.swap_base_amount as u128)
        .and_then(|x| x.checked_sub(c.migration_base_threshold as u128))
        .ok_or_else(|| LaunchpadError::ConfigLeftover.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::LaunchpadError as E;

    /// The default Vicinity config (LAUNCHPAD-DESIGN.md 7.1) as DBC stores it.
    pub fn good() -> PoolConfig {
        let mut c: PoolConfig = bytemuck::Zeroable::zeroed();
        c.quote_mint = anchor_spl::token::spl_token::native_mint::ID;
        c.fee_claimer = FEE_RECIPIENT;
        c.leftover_receiver = FEE_RECIPIENT;
        c.pool_fees.base_fee.cliff_fee_numerator = 12_500_000;
        c.collect_fee_mode = 0;
        c.migration_option = 1;
        c.activation_type = 1;
        c.token_decimal = 6;
        c.token_type = 0;
        c.partner_permanent_locked_liquidity_percentage = 50;
        c.creator_permanent_locked_liquidity_percentage = 50;
        c.migration_fee_option = 6;
        c.fixed_token_supply_flag = 1;
        c.creator_trading_fee_percentage = 50;
        c.token_update_authority = 1;
        c.migration_quote_threshold = 85_000_000_000;
        c.pre_migration_token_supply = COIN_SUPPLY_RAW;
        c.post_migration_token_supply = COIN_SUPPLY_RAW;
        c.migrated_pool_fee_bps = 125;
        c.pool_creation_fee = 50_000_000;
        // buildCurve's split for an 85 SOL target: about 9.1 coins of rounding left over
        c.swap_base_amount = 793_099_990_000_000;
        c.migration_base_threshold = 206_900_000_900_000;
        c
    }

    fn err_of(c: &PoolConfig) -> Option<anchor_lang::error::Error> {
        validate_vicinity_config(c).err()
    }

    fn assert_rule(f: impl Fn(&mut PoolConfig), want: E) {
        let mut c = good();
        f(&mut c);
        let got = err_of(&c).expect("config should be refused");
        assert_eq!(got, anchor_lang::error::Error::from(want), "wrong rule");
    }

    #[test]
    fn default_config_passes() {
        assert!(validate_vicinity_config(&good()).is_ok());
        // edges that are still allowed
        let mut c = good();
        c.pool_fees.base_fee.cliff_fee_numerator = MAX_TRADE_FEE_NUMERATOR;
        c.pool_fees.base_fee.base_fee_mode = 1; // exponential mode with no decay is flat too
        c.migrated_pool_fee_bps = MAX_MIGRATED_POOL_FEE_BPS;
        c.pool_creation_fee = MAX_POOL_CREATION_FEE_LAMPORTS;
        assert!(validate_vicinity_config(&c).is_ok());
    }

    #[test]
    fn rule_1_fee_receivers() {
        assert_rule(
            |c| c.fee_claimer = Pubkey::new_unique(),
            E::ConfigFeeClaimer,
        );
        assert_rule(
            |c| c.leftover_receiver = Pubkey::new_unique(),
            E::ConfigLeftoverReceiver,
        );
    }

    #[test]
    fn rule_2_quote() {
        assert_rule(|c| c.quote_token_flag = 1, E::QuoteMintNotAllowed);
        let spl = anchor_spl::token::ID;
        assert!(validate_quote_mint(&spl, false, false, 9).is_ok()); // WSOL
        assert!(validate_quote_mint(&spl, false, false, 6).is_ok()); // VICINITY
        assert!(validate_quote_mint(&TOKEN_2022_PROGRAM_ID, false, false, 8).is_err()); // xStocks
        assert!(validate_quote_mint(&spl, true, true, 6).is_err()); // USDC
        assert!(validate_quote_mint(&spl, false, true, 6).is_err()); // freeze authority
        assert!(validate_quote_mint(&spl, true, false, 6).is_err()); // live mint authority
        assert!(validate_quote_mint(&spl, false, false, 5).is_err());
        assert!(validate_quote_mint(&spl, false, false, 10).is_err());
        assert!(validate_quote_mint(&Pubkey::new_unique(), false, false, 9).is_err());
    }

    #[test]
    fn rule_3_coin_type_decimals_supply() {
        assert_rule(|c| c.token_type = 1, E::ConfigTokenType);
        assert_rule(|c| c.token_decimal = 9, E::ConfigDecimalsOrSupply);
        assert_rule(|c| c.fixed_token_supply_flag = 0, E::ConfigDecimalsOrSupply);
        assert_rule(
            |c| c.pre_migration_token_supply -= 1,
            E::ConfigDecimalsOrSupply,
        );
        assert_rule(
            |c| c.post_migration_token_supply += 1,
            E::ConfigDecimalsOrSupply,
        );
    }

    #[test]
    fn rule_4_collect_mode() {
        assert_rule(|c| c.collect_fee_mode = 1, E::ConfigCollectFeeMode);
    }

    #[test]
    fn rule_5_fee() {
        assert_rule(
            |c| c.pool_fees.base_fee.cliff_fee_numerator = MAX_TRADE_FEE_NUMERATOR + 1,
            E::ConfigFee,
        );
        assert_rule(|c| c.pool_fees.base_fee.base_fee_mode = 2, E::ConfigFee); // rate limiter
        assert_rule(|c| c.pool_fees.base_fee.first_factor = 10, E::ConfigFee);
        assert_rule(|c| c.pool_fees.base_fee.second_factor = 1, E::ConfigFee);
        assert_rule(|c| c.pool_fees.base_fee.third_factor = 1, E::ConfigFee);
        assert_rule(|c| c.pool_fees.dynamic_fee.initialized = 1, E::ConfigFee);
        assert_rule(|c| c.enable_first_swap_with_min_fee = 1, E::ConfigFee);
    }

    #[test]
    fn rule_6_split() {
        assert_rule(|c| c.creator_trading_fee_percentage = 49, E::ConfigFeeSplit);
        assert_rule(
            |c| c.creator_trading_fee_percentage = 100,
            E::ConfigFeeSplit,
        );
    }

    #[test]
    fn rule_7_metadata() {
        for v in [0u8, 2, 3, 4] {
            assert_rule(
                move |c| c.token_update_authority = v,
                E::ConfigMetadataMutable,
            );
        }
    }

    #[test]
    fn rule_8_liquidity() {
        assert_rule(
            |c| c.partner_liquidity_percentage = 1,
            E::ConfigLiquidityLock,
        );
        assert_rule(
            |c| c.creator_liquidity_percentage = 1,
            E::ConfigLiquidityLock,
        );
        assert_rule(
            |c| c.partner_permanent_locked_liquidity_percentage = 49,
            E::ConfigLiquidityLock,
        );
        assert_rule(
            |c| c.creator_permanent_locked_liquidity_percentage = 51,
            E::ConfigLiquidityLock,
        );
        assert_rule(
            |c| c.partner_liquidity_vesting_info.is_initialized = 1,
            E::ConfigLiquidityLock,
        );
        assert_rule(
            |c| c.creator_liquidity_vesting_info.vesting_percentage = 5,
            E::ConfigLiquidityLock,
        );
        assert_rule(
            |c| c.creator_liquidity_vesting_info.frequency = 5,
            E::ConfigLiquidityLock,
        );
    }

    #[test]
    fn rule_9_migration() {
        assert_rule(|c| c.migration_option = 0, E::ConfigMigration);
        assert_rule(|c| c.migration_fee_option = 2, E::ConfigMigration);
        assert_rule(|c| c.migrated_collect_fee_mode = 1, E::ConfigMigration);
        assert_rule(|c| c.migrated_collect_fee_mode = 2, E::ConfigMigration);
        assert_rule(
            |c| c.migrated_pool_fee_bps = MAX_MIGRATED_POOL_FEE_BPS + 1,
            E::ConfigMigration,
        );
        // the three gaps the design review found
        assert_rule(|c| c.migrated_dynamic_fee = 1, E::ConfigMigration);
        assert_rule(|c| c.migrated_pool_base_fee_mode = 3, E::ConfigMigration);
        for i in 0..16 {
            assert_rule(
                move |c| c.migrated_pool_base_fee_bytes[i] = 1,
                E::ConfigMigration,
            );
        }
        assert_rule(|c| c.migrated_compounding_fee_bps = 1, E::ConfigMigration);
    }

    #[test]
    fn rule_10_migration_fee() {
        assert_rule(|c| c.migration_fee_percentage = 1, E::ConfigMigrationFee);
        assert_rule(
            |c| c.creator_migration_fee_percentage = 1,
            E::ConfigMigrationFee,
        );
    }

    #[test]
    fn rule_11_vesting() {
        assert_rule(
            |c| c.locked_vesting_config.amount_per_period = 1,
            E::ConfigVesting,
        );
        assert_rule(
            |c| c.locked_vesting_config.cliff_unlock_amount = 1,
            E::ConfigVesting,
        );
        assert_rule(
            |c| c.locked_vesting_config.number_of_period = 1,
            E::ConfigVesting,
        );
        assert_rule(|c| c.locked_vesting_config.frequency = 1, E::ConfigVesting);
        assert_rule(
            |c| c.locked_vesting_config.cliff_duration_from_migration_time = 1,
            E::ConfigVesting,
        );
    }

    #[test]
    fn rule_12_launch_fee() {
        assert_rule(
            |c| c.pool_creation_fee = MAX_POOL_CREATION_FEE_LAMPORTS + 1,
            E::ConfigLaunchFee,
        );
    }

    #[test]
    fn rule_13_leftover() {
        assert_eq!(config_leftover(&good()).unwrap(), 9_100_000);
        // exactly the cap passes, one raw unit more is refused
        let mut c = good();
        c.swap_base_amount = COIN_SUPPLY_RAW - c.migration_base_threshold - MAX_LEFTOVER_RAW;
        assert_eq!(config_leftover(&c).unwrap(), MAX_LEFTOVER_RAW as u128);
        assert!(validate_vicinity_config(&c).is_ok());
        assert_rule(
            |c| {
                c.swap_base_amount =
                    COIN_SUPPLY_RAW - c.migration_base_threshold - MAX_LEFTOVER_RAW - 1
            },
            E::ConfigLeftover,
        );
        // the reviewer's config: half the supply left over for the dev wallet
        assert_rule(
            |c| {
                c.swap_base_amount = 293_099_994_000_000;
                c.migration_base_threshold = 206_900_002_000_000;
            },
            E::ConfigLeftover,
        );
        // nothing sold or kept at all
        assert_rule(
            |c| {
                c.swap_base_amount = 0;
                c.migration_base_threshold = 0;
            },
            E::ConfigLeftover,
        );
        // selling or keeping more than the supply cannot underflow into a pass
        assert_rule(|c| c.swap_base_amount = COIN_SUPPLY_RAW, E::ConfigLeftover);
        assert_rule(
            |c| {
                c.swap_base_amount = u64::MAX;
                c.migration_base_threshold = u64::MAX;
            },
            E::ConfigLeftover,
        );
    }

    #[test]
    fn target_and_curve_are_free() {
        let mut c = good();
        c.migration_quote_threshold = 25_000_000_000_000;
        c.sqrt_start_price = 123;
        c.curve[0].sqrt_price = 456;
        c.curve[0].liquidity = 789;
        assert!(validate_vicinity_config(&c).is_ok());
    }
}
