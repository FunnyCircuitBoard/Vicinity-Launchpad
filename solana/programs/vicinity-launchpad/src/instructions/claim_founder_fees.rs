//! `claim_founder_fees`: the founder takes the whole founder vault into their
//! own associated token account. Works while anything is paused and whether or
//! not the founder has opted in to payouts. An empty vault = nothing happens.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::transfer_from_coin;
use crate::constants::{COIN_SEED, FOUNDER_VAULT_SEED};
use crate::errors::LaunchpadError;
use crate::events::FounderFeesClaimed;
use crate::state::Coin;

#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct ClaimFounderFees<'info> {
    /// Must be `coin.founder`; pays for its own token account if missing.
    #[account(mut)]
    pub founder: Signer<'info>,

    #[account(
        mut,
        seeds = [COIN_SEED, &city_id.to_le_bytes()],
        bump = coin.bump,
        has_one = founder @ LaunchpadError::WrongFounder,
    )]
    pub coin: Box<Account<'info, Coin>>,

    #[account(
        mut,
        seeds = [FOUNDER_VAULT_SEED, coin.key().as_ref()],
        bump = coin.founder_vault_bump,
        token::mint = quote_mint,
        token::authority = coin,
    )]
    pub founder_vault: Box<Account<'info, TokenAccount>>,

    #[account(address = coin.quote_mint @ LaunchpadError::LaunchConfigMismatch)]
    pub quote_mint: Box<Account<'info, Mint>>,

    /// The founder's own associated token account for the quote token.
    #[account(
        init_if_needed,
        payer = founder,
        associated_token::mint = quote_mint,
        associated_token::authority = founder,
    )]
    pub founder_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_claim_founder_fees(ctx: Context<ClaimFounderFees>, city_id: u64) -> Result<()> {
    let a = &ctx.accounts;
    let amount = a.founder_vault.amount;
    if amount == 0 {
        return Ok(());
    }
    transfer_from_coin(
        &a.token_program,
        &a.founder_vault,
        a.founder_token_account.to_account_info(),
        &a.coin,
        amount,
    )?;
    let founder = a.founder.key();
    let coin = &mut ctx.accounts.coin;
    coin.founder_claimed = coin
        .founder_claimed
        .checked_add(amount)
        .ok_or(LaunchpadError::MathOverflow)?;
    emit!(FounderFeesClaimed {
        city_id,
        founder,
        amount,
    });
    Ok(())
}
