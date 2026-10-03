//! `accept_authority`: second step of the authority transfer. Only the
//! proposed key can sign it, which proves that key exists and is controlled.

use anchor_lang::prelude::*;

use crate::constants::CITY_SEED;
use crate::errors::RewardsError;
use crate::events::AuthorityAccepted;
use crate::state::CityConfig;

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub new_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CITY_SEED, config.city_coin_mint.as_ref()],
        bump = config.bump,
        constraint = config.pending_authority != Pubkey::default() @ RewardsError::NoPendingAuthority,
        constraint = config.pending_authority == new_authority.key() @ RewardsError::NotPendingAuthority,
    )]
    pub config: Account<'info, CityConfig>,
}

pub fn handle_accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let old_authority = config.authority;
    config.authority = ctx.accounts.new_authority.key();
    config.pending_authority = Pubkey::default();
    emit!(AuthorityAccepted {
        config: config.key(),
        old_authority,
        new_authority: config.authority,
    });
    Ok(())
}
