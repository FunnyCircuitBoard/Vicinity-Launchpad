//! `unpause`: resume funding and claiming. The seconds spent paused are added
//! to `paused_total_secs`, which extends the deadline of every epoch funded
//! before the pause (see `math::effective_deadline`).

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
    let now = Clock::get()?.unix_timestamp;
    // A clock that moved backwards must not shrink the total.
    let this_pause = now
        .checked_sub(config.paused_at)
        .ok_or(RewardsError::MathOverflow)?
        .max(0);
    config.paused_total_secs = config
        .paused_total_secs
        .checked_add(this_pause)
        .ok_or(RewardsError::MathOverflow)?;
    config.paused = false;
    config.paused_at = 0;
    emit!(PauseChanged {
        config: config.key(),
        paused: false,
        paused_total_secs: config.paused_total_secs,
    });
    Ok(())
}
