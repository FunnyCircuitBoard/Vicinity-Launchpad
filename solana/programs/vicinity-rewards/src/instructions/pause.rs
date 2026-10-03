//! `pause`: stop `fund_epoch` and `claim` for one city.
//! Sweep and cancel keep working so a paused city can still be wound down.
//! Pausing never moves money and never changes the economics.

use anchor_lang::prelude::*;

use crate::constants::CITY_SEED;
use crate::errors::RewardsError;
use crate::events::PauseChanged;
use crate::state::CityConfig;

#[derive(Accounts)]
pub struct Pause<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ RewardsError::Unauthorized,
        seeds = [CITY_SEED, config.city_coin_mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, CityConfig>,
}

pub fn handle_pause(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(!config.paused, RewardsError::AlreadyPaused);
    config.paused = true;
    emit!(PauseChanged {
        config: config.key(),
        paused: true,
    });
    Ok(())
}
