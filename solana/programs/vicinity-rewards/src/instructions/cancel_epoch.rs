//! `cancel_epoch`: withdraw a wrong root before anyone has claimed.
//!
//! The only remedy for a bad snapshot. It is limited to epochs with zero
//! claims so that it can never be used to take back money a holder already
//! received or to rewrite history. The holders' money returns to carry-over
//! and is distributed by the next (corrected) epoch.

use anchor_lang::prelude::*;

use crate::constants::{CITY_SEED, EPOCH_SEED};
use crate::errors::RewardsError;
use crate::events::EpochCancelled;
use crate::state::{CityConfig, Epoch, EpochState};

#[derive(Accounts)]
#[instruction(epoch_index: u64)]
pub struct CancelEpoch<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ RewardsError::Unauthorized,
        seeds = [CITY_SEED, config.city_coin_mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, CityConfig>,
    #[account(
        mut,
        seeds = [EPOCH_SEED, config.key().as_ref(), &epoch_index.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Account<'info, Epoch>,
}

pub fn handle_cancel_epoch(ctx: Context<CancelEpoch>, epoch_index: u64) -> Result<()> {
    let epoch = &ctx.accounts.epoch;
    require!(epoch.index == epoch_index, RewardsError::EpochIndexMismatch);
    require!(epoch.state == EpochState::Open, RewardsError::EpochNotOpen);
    require!(epoch.claimed_amount == 0, RewardsError::EpochHasClaims);

    let returned_amount = epoch.holders_amount;
    let carry_over = ctx
        .accounts
        .config
        .carry_over
        .checked_add(returned_amount)
        .ok_or(RewardsError::MathOverflow)?;

    let epoch = &mut ctx.accounts.epoch;
    epoch.state = EpochState::Cancelled;
    let config = &mut ctx.accounts.config;
    config.carry_over = carry_over;

    emit!(EpochCancelled {
        config: config.key(),
        epoch: epoch.key(),
        index: epoch_index,
        returned_amount,
        carry_over,
    });
    Ok(())
}
