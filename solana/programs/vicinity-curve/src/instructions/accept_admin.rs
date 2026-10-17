//! `accept_admin()` (4.3): step two of the admin transfer, signed by the
//! proposed key. `FEE_RECIPIENT` is refused again (GOV-2) and the separation
//! rules are checked again (the payout keys, and the guardian, which may not
//! be the admin: R5-CONS-1), because the payout settings and the guardian may
//! have changed since the proposal.
//!
//! `forward_holders_fees` requires each city's rewards authority to equal the
//! admin (4.15), so a new admin must also take over each city's rewards
//! authority in `vicinity_rewards`; holders' money waits in `holders_pending`
//! until then. Likewise the old `vicinity_launchpad`'s admin must follow
//! (8.5, GOV-1): until it does, `approve_launch` and `launch` fail with
//! `LegacyAdminMismatch`.

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::CurveError;
use crate::events::AdminChanged;
use crate::helpers::{
    check_guardian_separate, check_not_fee_recipient, check_payout_keys_separate,
};
use crate::state::Launchpad;

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,

    #[account(mut, seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,
}

pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let lp = &mut ctx.accounts.launchpad;
    let new_admin = ctx.accounts.new_admin.key();
    require!(
        lp.pending_admin != Pubkey::default(),
        CurveError::NoPendingAdmin
    );
    require_keys_eq!(lp.pending_admin, new_admin, CurveError::NotPendingAdmin);
    check_not_fee_recipient(&new_admin)?;
    check_payout_keys_separate(
        &new_admin,
        &lp.guardian,
        &lp.payout_authority,
        &lp.payout_destination,
    )?;
    check_guardian_separate(&lp.guardian, &new_admin, &Pubkey::default())?;
    let old_admin = lp.admin;
    lp.admin = new_admin;
    lp.pending_admin = Pubkey::default();
    emit!(AdminChanged {
        old_admin,
        new_admin,
    });
    Ok(())
}
