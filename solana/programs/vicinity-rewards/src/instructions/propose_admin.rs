//! `propose_admin`: first step of the two-step registry admin transfer.
//! Same rules as `propose_authority`: the zero address cancels, a new key
//! replaces, nothing changes until `accept_admin`.

use anchor_lang::prelude::*;

use crate::constants::REGISTRY_SEED;
use crate::errors::RewardsError;
use crate::events::AdminProposed;
use crate::state::Registry;

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin @ RewardsError::Unauthorized,
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
    )]
    pub registry: Account<'info, Registry>,
}

pub fn handle_propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    registry.pending_admin = new_admin;
    emit!(AdminProposed {
        registry: registry.key(),
        admin: registry.admin,
        pending_admin: new_admin,
    });
    Ok(())
}
