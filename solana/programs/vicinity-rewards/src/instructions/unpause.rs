//! `unpause`: resume `fund_epoch` and `claim`.

use anchor_lang::prelude::*;

use crate::constants::CITY_SEED;
use crate::errors::RewardsError;
use crate::events::PauseChanged;
use crate::state::CityConfig;

#[derive(Accounts)]
pub struct Unpause<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ RewardsError::Unauthorized,
        seeds = [CITY_SEED, config.city_coin_mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, CityConfig>,
}

pub fn handle_unpause(ctx: Context<Unpause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.paused, RewardsError::NotPaused);
    config.paused = false;
    emit!(PauseChanged {
        config: config.key(),
        paused: false,
    });
    Ok(())
}
