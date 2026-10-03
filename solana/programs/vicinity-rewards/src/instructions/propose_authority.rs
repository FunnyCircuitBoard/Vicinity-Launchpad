//! `propose_authority`: first step of the two-step authority transfer.
//! Proposing the zero address cancels a pending transfer; proposing another
//! key replaces it. Nothing changes until the new key calls `accept_authority`,
//! so a typo can never hand the city to a key nobody controls.

use anchor_lang::prelude::*;

use crate::constants::CITY_SEED;
use crate::errors::RewardsError;
use crate::events::AuthorityProposed;
use crate::state::CityConfig;

#[derive(Accounts)]
pub struct ProposeAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ RewardsError::Unauthorized,
        seeds = [CITY_SEED, config.city_coin_mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, CityConfig>,
}

pub fn handle_propose_authority(
    ctx: Context<ProposeAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.pending_authority = new_authority;
    emit!(AuthorityProposed {
        config: config.key(),
        authority: config.authority,
        pending_authority: new_authority,
    });
    Ok(())
}
