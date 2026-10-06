//! `accept_admin`: step two of the admin transfer, signed by the proposed key,
//! which proves the new admin is a live key (for example a Squads vault).

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::LaunchpadError;
use crate::events::AdminChanged;
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
    let old = lp.admin;
    lp.admin = lp.pending_admin;
    lp.pending_admin = Pubkey::default();
    emit!(AdminChanged {
        old_admin: old,
        new_admin: lp.admin,
    });
    Ok(())
}
