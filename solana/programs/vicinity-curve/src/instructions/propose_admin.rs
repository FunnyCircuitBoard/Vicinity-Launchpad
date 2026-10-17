//! `propose_admin(new_admin)` (4.2): step one of the two-step admin transfer.
//! A zero `new_admin` cancels a pending transfer. The payout key and wallet
//! must stay separate from the proposed admin (8.2).

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::CurveError;
use crate::events::AdminProposed;
use crate::helpers::check_payout_keys_separate;
use crate::state::Launchpad;

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ CurveError::Unauthorized,
    )]
    pub launchpad: Box<Account<'info, Launchpad>>,
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
