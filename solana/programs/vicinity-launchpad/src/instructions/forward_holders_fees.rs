//! `forward_holders_fees` (permissionless): move the holders pot into the
//! city's `vicinity_rewards` vault, where holders claim it with Merkle proofs.
//!
//! Before any money moves, the city's rewards config is read and must pay
//! holders only: model Holders, founder share 0, reward token = the coin's
//! quote token, vault = the derived vault we pay. Under the Creator or Split
//! model `fund_epoch_from_vault` would pay 25% to 100% of what lands in the
//! vault to `config.founder`, which the rewards authority can change with
//! `set_founder`. If the config fails, the pot simply keeps collecting.
//!
//! Who receives the money once it is in the rewards vault is decided by the
//! city's rewards authority through its Merkle roots (LAUNCHPAD-DESIGN.md 12.1).

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::transfer_from_coin;
use crate::constants::{
    COIN_SEED, HOLDERS_POT_SEED, LAUNCHPAD_SEED, REWARDS_CITY_SEED, REWARDS_VAULT_SEED,
};
use crate::errors::LaunchpadError;
use crate::events::HoldersFeesForwarded;
use crate::math::{check_rewards_config, read_rewards_city_config};
use crate::state::{Coin, Launchpad};

#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct ForwardHoldersFees<'info> {
    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(mut, seeds = [COIN_SEED, &city_id.to_le_bytes()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,

    #[account(
        mut,
        seeds = [HOLDERS_POT_SEED, coin.key().as_ref()],
        bump = coin.holders_pot_bump,
        token::mint = quote_mint,
        token::authority = coin,
    )]
    pub holders_pot: Box<Account<'info, TokenAccount>>,

    #[account(address = coin.quote_mint @ LaunchpadError::LaunchConfigMismatch)]
    pub quote_mint: Box<Account<'info, Mint>>,

    /// CHECK: the city's `vicinity_rewards` CityConfig: the address is derived
    /// from the coin mint under the stored rewards program, the owner is that
    /// program, and the handler reads and checks its fields.
    #[account(
        owner = launchpad.rewards_program @ LaunchpadError::WrongRewardsConfig,
        constraint = rewards_city_config.key()
            == Pubkey::find_program_address(&[REWARDS_CITY_SEED, coin.mint.as_ref()], &launchpad.rewards_program).0
            @ LaunchpadError::WrongRewardsConfig,
    )]
    pub rewards_city_config: UncheckedAccount<'info>,

    /// The city's rewards vault: derived from the config under the rewards
    /// program, holding the quote token, owned by the config PDA.
    #[account(
        mut,
        constraint = rewards_vault.key()
            == Pubkey::find_program_address(&[REWARDS_VAULT_SEED, rewards_city_config.key().as_ref()], &launchpad.rewards_program).0
            @ LaunchpadError::WrongRewardsVault,
        token::mint = quote_mint,
        token::authority = rewards_city_config,
    )]
    pub rewards_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_forward_holders_fees(ctx: Context<ForwardHoldersFees>, city_id: u64) -> Result<()> {
    let a = &ctx.accounts;
    let view = read_rewards_city_config(&a.rewards_city_config.try_borrow_data()?)?;
    check_rewards_config(
        &view,
        &a.coin.mint,
        &a.coin.quote_mint,
        &a.rewards_vault.key(),
    )?;

    let amount = a.holders_pot.amount;
    if amount == 0 {
        return Ok(());
    }
    transfer_from_coin(
        &a.token_program,
        &a.holders_pot,
        a.rewards_vault.to_account_info(),
        &a.coin,
        amount,
    )?;
    let vault = a.rewards_vault.key();
    let coin = &mut ctx.accounts.coin;
    coin.holders_forwarded = coin
        .holders_forwarded
        .checked_add(amount)
        .ok_or(LaunchpadError::MathOverflow)?;
    emit!(HoldersFeesForwarded {
        city_id,
        amount,
        rewards_vault: vault,
    });
    Ok(())
}
