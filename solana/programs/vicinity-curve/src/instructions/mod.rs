//! One file per instruction (`handle_<name>`), as in `vicinity_launchpad`
//! (VICINITY-CURVE-DESIGN.md 3.1, section 4).
//!
//! Every handler runs its checks in the order of its section of 4, then its
//! effects in the order of 4.0: CPIs that bring value in, CPIs that send tokens
//! out or burn, the in-memory state update, direct lamport moves through
//! `custody::pay_out` (which reads the post-update liabilities), then events.

pub mod accept_admin;
pub mod add_launch_config;
pub mod init_launchpad;
pub mod propose_admin;
pub mod set_guardian;
pub mod set_launch_config_enabled;
pub mod set_pause;
pub mod set_payout_config;

pub use accept_admin::*;
pub use add_launch_config::*;
pub use init_launchpad::*;
pub use propose_admin::*;
pub use set_guardian::*;
pub use set_launch_config_enabled::*;
pub use set_pause::*;
pub use set_payout_config::*;

use anchor_lang::prelude::*;

use crate::constants::COIN_SEED;

/// Runs `f` with the `Coin` PDA's signer seeds `["coin", city_id LE, bump]`:
/// the only seeds this program ever signs with besides the event authority.
pub fn with_coin_signer<R>(city_id: u64, bump: u8, f: impl FnOnce(&[&[&[u8]]]) -> R) -> R {
    let city = city_id.to_le_bytes();
    let bump = [bump];
    let seeds: &[&[u8]] = &[COIN_SEED, &city, &bump];
    f(&[seeds])
}

/// `Clock` once per handler: (unix timestamp, slot).
pub fn now() -> Result<(i64, u64)> {
    let clock = Clock::get()?;
    Ok((clock.unix_timestamp, clock.slot))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The signer seeds re-create the `Coin` PDA the account constraints
    /// derive, for any city and the canonical bump.
    #[test]
    fn coin_signer_seeds_make_the_coin_pda() {
        for city in [1u64, 5_128_581, u64::MAX] {
            let (pda, bump) =
                Pubkey::find_program_address(&[COIN_SEED, &city.to_le_bytes()], &crate::ID);
            let made = with_coin_signer(city, bump, |s| {
                Pubkey::create_program_address(s[0], &crate::ID).unwrap()
            });
            assert_eq!(made, pda);
        }
    }

    /// `ConfigParams` reaches the math crate field for field.
    #[test]
    fn config_params_conversion() {
        let p = ConfigParams {
            liquidity_bps: 1,
            platform_bps: 2,
            founder_bps: 3,
            holders_bps: 4,
            buyback_bps: 5,
            virtual_sol: 6,
            virtual_tokens: 7,
            curve_supply: 8,
            pool_supply: 9,
            graduation_sol: 10,
            launch_fee_lamports: 11,
        };
        let m: vicinity_curve_math::ConfigParams = p.into();
        assert_eq!(
            m,
            vicinity_curve_math::ConfigParams {
                liquidity_bps: 1,
                platform_bps: 2,
                founder_bps: 3,
                holders_bps: 4,
                buyback_bps: 5,
                virtual_sol: 6,
                virtual_tokens: 7,
                curve_supply: 8,
                pool_supply: 9,
                graduation_sol: 10,
                launch_fee_lamports: 11,
            }
        );
        // Default config #0 passes V1 to V11 through this path.
        let d = vicinity_curve_math::ConfigParams::DEFAULT;
        let back = ConfigParams {
            liquidity_bps: d.liquidity_bps,
            platform_bps: d.platform_bps,
            founder_bps: d.founder_bps,
            holders_bps: d.holders_bps,
            buyback_bps: d.buyback_bps,
            virtual_sol: d.virtual_sol,
            virtual_tokens: d.virtual_tokens,
            curve_supply: d.curve_supply,
            pool_supply: d.pool_supply,
            graduation_sol: d.graduation_sol,
            launch_fee_lamports: d.launch_fee_lamports,
        };
        assert!(vicinity_curve_math::validate_config(&back.into()).is_ok());
    }
}
