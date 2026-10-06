//! `revoke_approval`: the admin closes a pending approval; its rent goes back
//! to whoever paid it. After this, `launch` for the city fails until a new
//! approval exists.

use anchor_lang::prelude::*;

use crate::constants::{APPROVAL_SEED, LAUNCHPAD_SEED};
use crate::errors::LaunchpadError;
use crate::events::ApprovalRevoked;
use crate::state::{Approval, Launchpad};

#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct RevokeApproval<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ LaunchpadError::Unauthorized,
    )]
    pub launchpad: Account<'info, Launchpad>,

    #[account(
        mut,
        seeds = [APPROVAL_SEED, &city_id.to_le_bytes()],
        bump = approval.bump,
        has_one = rent_payer @ LaunchpadError::InvalidAddress,
        close = rent_payer,
    )]
    pub approval: Account<'info, Approval>,

    /// CHECK: receives the rent; must be `approval.rent_payer` (has_one).
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn handle_revoke_approval(_ctx: Context<RevokeApproval>, city_id: u64) -> Result<()> {
    emit!(ApprovalRevoked { city_id });
    Ok(())
}
