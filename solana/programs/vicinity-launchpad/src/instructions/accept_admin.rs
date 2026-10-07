//! `accept_admin`: step two of the admin transfer, signed by the proposed key,
//! which proves the new admin is a live key (for example a Squads vault). The
//! new admin may be neither the payout key nor the payout wallet as they are
//! set at this moment (they may have changed since the proposal).

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::LaunchpadError;
use crate::events::AdminChanged;
use crate::math::check_payout_keys_separate;
use crate::state::Launchpad;

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,

    #[account(mut, seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Account<'info, Launchpad>,
}

pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let lp = &mut ctx.accounts.launchpad;
    require_keys_neq!(
        lp.pending_admin,
        Pubkey::default(),
        LaunchpadError::NoPendingAdmin
    );
    require_keys_eq!(
        lp.pending_admin,
        ctx.accounts.new_admin.key(),
        LaunchpadError::NotPendingAdmin
    );
    check_payout_keys_separate(
        &lp.pending_admin,
        &lp.payout_authority,
        &lp.payout_destination,
    )?;
    let old = lp.admin;
    lp.admin = lp.pending_admin;
    lp.pending_admin = Pubkey::default();
    emit!(AdminChanged {
        old_admin: old,
        new_admin: lp.admin,
    });
    Ok(())
}
