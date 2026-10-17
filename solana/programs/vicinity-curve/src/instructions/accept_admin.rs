//! `accept_admin()` (4.3): step two of the admin transfer, signed by the
//! proposed key. The separation rule is checked again, because the payout
//! settings may have changed since the proposal.
//!
//! `forward_holders_fees` requires each city's rewards authority to equal the
//! admin (4.15), so a new admin must also take over each city's rewards
//! authority in `vicinity_rewards`; holders' money waits in `holders_pending`
//! until then.

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::CurveError;
use crate::events::AdminChanged;
use crate::helpers::check_payout_keys_separate;
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
    check_payout_keys_separate(&new_admin, &lp.payout_authority, &lp.payout_destination)?;
    let old_admin = lp.admin;
    lp.admin = new_admin;
    lp.pending_admin = Pubkey::default();
    emit!(AdminChanged {
        old_admin,
        new_admin,
    });
    Ok(())
}
