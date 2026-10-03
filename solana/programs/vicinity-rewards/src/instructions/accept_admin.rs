//! `accept_admin`: second step of the registry admin transfer, signed by the
//! proposed key.

use anchor_lang::prelude::*;

use crate::constants::REGISTRY_SEED;
use crate::errors::RewardsError;
use crate::events::AdminAccepted;
use crate::state::Registry;

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        constraint = registry.pending_admin != Pubkey::default() @ RewardsError::NoPendingAdmin,
        constraint = registry.pending_admin == new_admin.key() @ RewardsError::NotPendingAdmin,
    )]
    pub registry: Account<'info, Registry>,
}

pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    let old_admin = registry.admin;
    registry.admin = ctx.accounts.new_admin.key();
    registry.pending_admin = Pubkey::default();
    emit!(AdminAccepted {
        registry: registry.key(),
        old_admin,
        new_admin: registry.admin,
    });
    Ok(())
}
