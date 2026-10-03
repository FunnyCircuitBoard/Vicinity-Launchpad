//! `close_claim_status`: give the claimant its rent back once the epoch is
//! finished.
//!
//! Only after Swept or Cancelled: while the epoch is Open the claim status IS
//! the double-claim protection, and closing it would let the wallet claim
//! again. After sweep or cancel, `claim` refuses the epoch anyway (state is
//! not Open), so the account has served its purpose.

use anchor_lang::prelude::*;

use crate::constants::{CITY_SEED, CLAIM_SEED, EPOCH_SEED};
use crate::errors::RewardsError;
use crate::events::ClaimStatusClosed;
use crate::state::{CityConfig, ClaimStatus, Epoch, EpochState};

#[derive(Accounts)]
#[instruction(epoch_index: u64)]
pub struct CloseClaimStatus<'info> {
    /// Receives the rent. Must be the wallet the claim status belongs to.
    #[account(mut)]
    pub claimant: Signer<'info>,
    #[account(
        seeds = [CITY_SEED, config.city_coin_mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, CityConfig>,
    #[account(
        seeds = [EPOCH_SEED, config.key().as_ref(), &epoch_index.to_le_bytes()],
        bump = epoch.bump,
        constraint = epoch.state != EpochState::Open @ RewardsError::EpochStillOpen,
    )]
    pub epoch: Account<'info, Epoch>,
    #[account(
        mut,
        close = claimant,
        has_one = claimant,
        seeds = [CLAIM_SEED, epoch.key().as_ref(), claimant.key().as_ref()],
        bump = claim_status.bump,
    )]
    pub claim_status: Account<'info, ClaimStatus>,
}

pub fn handle_close_claim_status(ctx: Context<CloseClaimStatus>, epoch_index: u64) -> Result<()> {
    require!(
        ctx.accounts.epoch.index == epoch_index,
        RewardsError::EpochIndexMismatch
    );
    emit!(ClaimStatusClosed {
        config: ctx.accounts.config.key(),
        epoch: ctx.accounts.epoch.key(),
        claimant: ctx.accounts.claimant.key(),
    });
    Ok(())
}
