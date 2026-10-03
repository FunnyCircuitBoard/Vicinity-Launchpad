//! `set_founder`: point the founder share at another wallet.
//!
//! Allowed at any time, locked or not, because founder seats change under
//! Vicinity's own rules (a founder can lose the seat). This is the one
//! economic lever the authority keeps, which is why the authority should be a
//! multisig: whoever controls it decides who receives every future founder
//! share. It never touches money already paid or money in the vault.

use anchor_lang::prelude::*;

use crate::constants::CITY_SEED;
use crate::errors::RewardsError;
use crate::events::FounderChanged;
use crate::state::CityConfig;

#[derive(Accounts)]
pub struct SetFounder<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ RewardsError::Unauthorized,
        seeds = [CITY_SEED, config.city_coin_mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, CityConfig>,
}

pub fn handle_set_founder(ctx: Context<SetFounder>, new_founder: Pubkey) -> Result<()> {
    require_keys_neq!(new_founder, Pubkey::default(), RewardsError::InvalidFounder);
    // The founder share is paid to the founder's associated token account. If
    // the founder were the config PDA or the vault, that account would be owned
    // by a key no instruction ever signs for and the money would be lost. Only
    // a key is passed here, so other accounts of this program (registry, epoch,
    // another config) cannot be recognised at this point; `fund_epoch` and
    // `fund_epoch_from_vault` refuse them before paying (FounderIsProgramAccount),
    // and the authority corrects the founder with another `set_founder`.
    require_keys_neq!(
        new_founder,
        ctx.accounts.config.key(),
        RewardsError::FounderIsProgramAccount
    );
    require_keys_neq!(
        new_founder,
        ctx.accounts.config.vault,
        RewardsError::FounderIsProgramAccount
    );
    let config = &mut ctx.accounts.config;
    let old_founder = config.founder;
    config.founder = new_founder;
    emit!(FounderChanged {
        config: config.key(),
        old_founder,
        new_founder,
    });
    Ok(())
}
