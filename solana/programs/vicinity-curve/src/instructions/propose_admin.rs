//! `propose_admin(new_admin)` (4.2): step one of the two-step admin transfer.
//! A zero `new_admin` cancels a pending transfer. The proposed admin may not be
//! `FEE_RECIPIENT` (GOV-2), the payout key and wallet must stay separate
//! from it and from the guardian (8.2), and it may not be the guardian, whose
//! halt must not wait for the admin's time lock (R5-CONS-1).

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::CurveError;
use crate::events::AdminProposed;
use crate::helpers::{
    check_guardian_separate, check_not_fee_recipient, check_payout_keys_separate,
};
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
        check_not_fee_recipient(&new_admin)?;
        check_payout_keys_separate(
            &new_admin,
            &lp.guardian,
            &lp.payout_authority,
            &lp.payout_destination,
        )?;
        check_guardian_separate(&lp.guardian, &lp.admin, &new_admin)?;
    }
    lp.pending_admin = new_admin;
    emit!(AdminProposed {
        admin: lp.admin,
        pending_admin: new_admin,
    });
    Ok(())
}
