//! `propose_admin`: step one of the two-step admin transfer. Proposing the zero
//! address cancels a pending transfer. The proposed admin may be neither the
//! payout key nor the payout wallet (`accept_admin` checks again).

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::LaunchpadError;
use crate::events::AdminProposed;
use crate::math::check_payout_keys_separate;
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
    if new_admin != Pubkey::default() {
        check_payout_keys_separate(&new_admin, &lp.payout_authority, &lp.payout_destination)?;
    }
    lp.pending_admin = new_admin;
    emit!(AdminProposed {
        admin: lp.admin,
        pending_admin: new_admin,
    });
    Ok(())
}
