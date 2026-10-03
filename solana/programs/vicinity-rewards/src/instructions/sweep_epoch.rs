//! `sweep_epoch`: close an epoch after its deadline and roll the unclaimed
//! holder money into the next epoch.
//!
//! No money leaves the vault here. PRODUCT DECISION: alternative destinations
//! for unclaimed money (founder, treasury) are not implemented; carry-over to
//! the next holders epoch is the only behaviour, which keeps the "only claim
//! moves vault money" rule intact.
//!
//! The deadline is the pause-extended one (`math::effective_deadline`): while
//! the city is paused the time to the deadline does not shrink, so the
//! authority cannot pause, wait, and sweep money that a published root
//! promised to holders who were prevented from claiming.

use anchor_lang::prelude::*;

use crate::constants::{CITY_SEED, EPOCH_SEED};
use crate::errors::RewardsError;
use crate::events::EpochSwept;
use crate::math::effective_deadline;
use crate::state::{CityConfig, Epoch, EpochState};

#[derive(Accounts)]
#[instruction(epoch_index: u64)]
pub struct SweepEpoch<'info> {
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

pub fn handle_sweep_epoch(ctx: Context<SweepEpoch>, epoch_index: u64) -> Result<()> {
    let epoch = &ctx.accounts.epoch;
    require!(epoch.index == epoch_index, RewardsError::EpochIndexMismatch);
    require!(epoch.state == EpochState::Open, RewardsError::EpochNotOpen);
    let now = Clock::get()?.unix_timestamp;
    let config = &ctx.accounts.config;
    let deadline = effective_deadline(
        epoch.claim_deadline,
        epoch.pause_secs_at_funding,
        config.paused_total_secs,
        config.paused,
        config.paused_at,
        now,
    )?;
    require!(now > deadline, RewardsError::ClaimDeadlineNotPassed);

    let unclaimed_amount = epoch
        .holders_amount
        .checked_sub(epoch.claimed_amount)
        .ok_or(RewardsError::MathOverflow)?;
    let carry_over = ctx
        .accounts
        .config
        .carry_over
        .checked_add(unclaimed_amount)
        .ok_or(RewardsError::MathOverflow)?;

    let epoch = &mut ctx.accounts.epoch;
    epoch.state = EpochState::Swept;
    let config = &mut ctx.accounts.config;
    config.carry_over = carry_over;

    emit!(EpochSwept {
        config: config.key(),
        epoch: epoch.key(),
        index: epoch_index,
        unclaimed_amount,
        carry_over,
    });
    Ok(())
}
