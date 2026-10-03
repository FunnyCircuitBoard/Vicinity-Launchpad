//! `lock_config`: make the economics permanent before the first epoch.
//! (`fund_epoch` locks automatically; this lets Vicinity lock earlier, for
//! example right after the coin is created, so the UI can show "Permanent".)

use anchor_lang::prelude::*;

use crate::constants::CITY_SEED;
use crate::errors::RewardsError;
use crate::events::ConfigLocked;
use crate::state::CityConfig;

#[derive(Accounts)]
pub struct LockConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ RewardsError::Unauthorized,
        seeds = [CITY_SEED, config.city_coin_mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, CityConfig>,
}

pub fn handle_lock_config(ctx: Context<LockConfig>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(!config.locked, RewardsError::AlreadyLocked);
    config.locked = true;
    emit!(ConfigLocked {
        config: config.key(),
    });
    Ok(())
}
