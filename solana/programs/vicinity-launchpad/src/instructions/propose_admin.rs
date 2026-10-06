//! `propose_admin`: step one of the two-step admin transfer. Proposing the zero
//! address cancels a pending transfer.

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::LaunchpadError;
use crate::events::AdminProposed;
use crate::state::Launchpad;

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ LaunchpadError::Unauthorized,
    )]
    pub launchpad: Account<'info, Launchpad>,
}

pub fn handle_propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
    let lp = &mut ctx.accounts.launchpad;
    lp.pending_admin = new_admin;
    emit!(AdminProposed {
        admin: lp.admin,
        pending_admin: new_admin,
    });
    Ok(())
}
