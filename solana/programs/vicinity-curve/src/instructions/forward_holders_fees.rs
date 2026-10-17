//! `forward_holders_fees()` (4.15): anyone may call; the whole
//! `holders_pending` goes to the city's `vicinity_rewards` WSOL vault, where
//! holders claim it with Merkle proofs.
//!
//! Before any money moves, the city's rewards config (PDA `["city", mint]`
//! under the compiled `REWARDS_PROGRAM_ID`) is read by hand and must pay
//! holders only (model Holders, founder share 0), in WSOL, through the vault
//! passed (PDA `["vault", config]`), for this coin, with the `vicinity_curve`
//! admin as its authority and no authority transfer pending (SEC-2). If the
//! config is missing or wrong, the call fails and the money keeps collecting.
//!
//! The vault is credited by a direct lamport move (any program may credit a
//! writable account). There is no `SyncNative` CPI here (SEC-1, rule of 4.0):
//! a CPI listing only the vault would see its credit but not the Coin's debit
//! and fail with `UnbalancedInstruction`. The SDK and the keeper append a
//! top-level SPL Token `SyncNative(rewards_vault)` instruction right after this
//! one (permissionless); until then the vault holds more lamports than its
//! token amount shows, and nothing is lost.

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::constants::{
    COIN_SEED, LAUNCHPAD_SEED, NATIVE_MINT, REWARDS_CITY_SEED, REWARDS_PROGRAM_ID,
    REWARDS_VAULT_SEED,
};
use crate::custody::{pay_out, require_not_halted};
use crate::errors::CurveError;
use crate::events::HoldersFeesForwarded;
use crate::helpers::{check_rewards_authority, check_rewards_config, read_rewards_city_config};
use crate::state::{CurveCoin, Launchpad};

#[event_cpi]
#[derive(Accounts)]
pub struct ForwardHoldersFees<'info> {
    /// `admin` is read: the rewards config's authority must equal it.
    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(
        mut,
        seeds = [COIN_SEED, &coin.city_id.to_le_bytes()],
        bump = coin.bump,
    )]
    pub coin: Box<Account<'info, CurveCoin>>,

    /// CHECK: the city's `vicinity_rewards` CityConfig: owner is the compiled
    /// rewards program and the address is derived from the coin mint; the
    /// handler reads and checks its fields.
    #[account(
        constraint = *rewards_city_config.owner == REWARDS_PROGRAM_ID
            @ CurveError::WrongRewardsConfig,
        constraint = rewards_city_config.key()
            == Pubkey::find_program_address(
                &[REWARDS_CITY_SEED, coin.mint.as_ref()],
                &REWARDS_PROGRAM_ID,
            ).0
            @ CurveError::WrongRewardsConfig,
    )]
    pub rewards_city_config: UncheckedAccount<'info>,

    /// The city's rewards vault: derived from the config under the rewards
    /// program, a classic WSOL token account owned by the config PDA.
    #[account(
        mut,
        constraint = rewards_vault.key()
            == Pubkey::find_program_address(
                &[REWARDS_VAULT_SEED, rewards_city_config.key().as_ref()],
                &REWARDS_PROGRAM_ID,
            ).0
            @ CurveError::WrongRewardsVault,
        constraint = rewards_vault.mint == NATIVE_MINT @ CurveError::WrongRewardsVault,
        constraint = rewards_vault.owner == rewards_city_config.key()
            @ CurveError::WrongRewardsVault,
    )]
    pub rewards_vault: Box<Account<'info, TokenAccount>>,
}

pub fn handle_forward_holders_fees(ctx: Context<ForwardHoldersFees>) -> Result<()> {
    require_not_halted()?;
    let a = &ctx.accounts;
    let view = read_rewards_city_config(&a.rewards_city_config.try_borrow_data()?)?;
    check_rewards_config(&view, &a.coin.mint, &NATIVE_MINT, &a.rewards_vault.key())?;
    check_rewards_authority(&view, &a.launchpad.admin)?;

    let vault_info = a.rewards_vault.to_account_info();
    let rewards_vault = a.rewards_vault.key();
    let coin = &mut ctx.accounts.coin;
    let amount = coin.holders_pending;
    if amount == 0 {
        return Ok(());
    }
    coin.holders_pending = 0;
    coin.holders_forwarded = coin
        .holders_forwarded
        .checked_add(amount as u128)
        .ok_or(CurveError::MathOverflow)?;
    let liabilities_after = coin.liabilities()?;
    pay_out(
        &coin.to_account_info(),
        coin.rent_reserve,
        &vault_info,
        amount,
        liabilities_after,
    )?;
    let (city_id, total_forwarded) = (coin.city_id, coin.holders_forwarded);
    emit_cpi!(HoldersFeesForwarded {
        city_id,
        amount,
        rewards_vault,
        total_forwarded,
    });
    Ok(())
}
