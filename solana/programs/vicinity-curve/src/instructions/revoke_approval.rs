//! `revoke_approval(city_id)` (4.9): the admin closes a pending approval at any
//! time; anyone may close it once it has expired (M17). The rent always goes
//! to `approval.rent_payer` (pinned by `has_one`), never to the caller.

use anchor_lang::prelude::*;

use crate::constants::{APPROVAL_SEED, LAUNCHPAD_SEED};
use crate::errors::CurveError;
use crate::events::ApprovalRevoked;
use crate::instructions::now;
use crate::state::{Approval, Launchpad};

#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct RevokeApproval<'info> {
    pub by: Signer<'info>,

    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(
        mut,
        seeds = [APPROVAL_SEED, &city_id.to_le_bytes()],
        bump = approval.bump,
        has_one = rent_payer @ CurveError::InvalidAddress,
        close = rent_payer,
    )]
    pub approval: Box<Account<'info, Approval>>,

    /// CHECK: receives the approval's rent; pinned by `has_one`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn handle_revoke_approval(ctx: Context<RevokeApproval>, city_id: u64) -> Result<()> {
    let by = ctx.accounts.by.key();
    if by != ctx.accounts.launchpad.admin {
        let (now, _) = now()?;
        require!(
            now > ctx.accounts.approval.expires_at,
            CurveError::ApprovalNotExpired
        );
    }
    emit!(ApprovalRevoked { city_id, by });
    Ok(())
}
