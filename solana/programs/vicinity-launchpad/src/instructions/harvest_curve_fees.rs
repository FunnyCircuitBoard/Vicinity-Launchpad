//! `harvest_curve_fees` (permissionless): claim the creator half of the curve
//! trading fees from DBC (the `Coin` PDA is the pool creator) into the holders
//! pot, then move the founder's half on to the founder vault.
//!
//! Once the curve is complete, the same call also collects, exactly once, the
//! city's share of DBC's completion "surplus" (`creator_withdraw_surplus`): the
//! rounding dust the curve took above its target, about 0.2 lamport per trade
//! (LAUNCHPAD-DESIGN.md 10.5). It lands in the pot and is split like a fee, so
//! nothing owed to the city stays behind in DBC.
//!
//! Only the increase of the pot during the claims counts, so money that
//! strangers send into the pot or vault beforehand changes no counter; it just
//! goes out with the next forward or claim. Nothing to claim = nothing happens.
//!
//! `coin_base_account` (the Coin PDA's account for its own coin) exists only
//! because DBC asks for a base-token account. Base fees are always 0 (rule
//! 7.2(4): fees in the quote token), and nothing ever moves that account.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::{book_harvest, read_dbc_pool};
use crate::constants::{COIN_SEED, DBC_POOL_AUTHORITY, FOUNDER_VAULT_SEED, HOLDERS_POT_SEED};
use crate::dynamic_bonding_curve::{
    self,
    accounts::PoolConfig,
    cpi::accounts::{ClaimCreatorTradingFee, CreatorWithdrawSurplus},
    program::DynamicBondingCurve,
};
use crate::errors::LaunchpadError;
use crate::events::FeesHarvested;
use crate::state::Coin;

#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct HarvestCurveFees<'info> {
    /// Anyone; pays the rent of `coin_base_account` the first time.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [COIN_SEED, &city_id.to_le_bytes()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,

    /// CHECK: DBC's pool authority (address pinned and checked by DBC).
    #[account(address = DBC_POOL_AUTHORITY @ LaunchpadError::InvalidAddress)]
    pub dbc_pool_authority: UncheckedAccount<'info>,

    /// CHECK: this coin's DBC pool; DBC checks the creator signature against it.
    #[account(mut, address = coin.dbc_pool @ LaunchpadError::PoolCreatorMismatch)]
    pub dbc_pool: UncheckedAccount<'info>,

    /// This coin's DBC config (owner DBC and type checked): its raise target
    /// tells whether the curve is complete, and DBC needs it for the surplus.
    #[account(address = coin.dbc_config @ LaunchpadError::LaunchConfigMismatch)]
    pub dbc_config: AccountLoader<'info, PoolConfig>,

    /// CHECK: DBC checks it equals the pool's base vault.
    #[account(mut)]
    pub dbc_base_vault: UncheckedAccount<'info>,

    /// CHECK: DBC checks it equals the pool's quote vault.
    #[account(mut)]
    pub dbc_quote_vault: UncheckedAccount<'info>,

    #[account(address = coin.mint @ LaunchpadError::PoolCreatorMismatch)]
    pub base_mint: Box<Account<'info, Mint>>,

    #[account(address = coin.quote_mint @ LaunchpadError::LaunchConfigMismatch)]
    pub quote_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = base_mint,
        associated_token::authority = coin,
    )]
    pub coin_base_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [HOLDERS_POT_SEED, coin.key().as_ref()],
        bump = coin.holders_pot_bump,
        token::mint = quote_mint,
        token::authority = coin,
    )]
    pub holders_pot: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [FOUNDER_VAULT_SEED, coin.key().as_ref()],
        bump = coin.founder_vault_bump,
        token::mint = quote_mint,
        token::authority = coin,
    )]
    pub founder_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: DBC's event authority PDA (checked by DBC's event CPI).
    pub dbc_event_authority: UncheckedAccount<'info>,
    pub dbc_program: Program<'info, DynamicBondingCurve>,
}

pub fn handle_harvest_curve_fees(mut ctx: Context<HarvestCurveFees>, city_id: u64) -> Result<()> {
    let before = ctx.accounts.holders_pot.amount;
    let city_bytes = city_id.to_le_bytes();
    let seeds: &[&[u8]] = &[COIN_SEED, &city_bytes, &[ctx.accounts.coin.bump]];
    {
        let a = &ctx.accounts;
        dynamic_bonding_curve::cpi::claim_creator_trading_fee(
            CpiContext::new_with_signer(
                a.dbc_program.to_account_info(),
                ClaimCreatorTradingFee {
                    pool_authority: a.dbc_pool_authority.to_account_info(),
                    pool: a.dbc_pool.to_account_info(),
                    token_a_account: a.coin_base_account.to_account_info(),
                    token_b_account: a.holders_pot.to_account_info(),
                    base_vault: a.dbc_base_vault.to_account_info(),
                    quote_vault: a.dbc_quote_vault.to_account_info(),
                    base_mint: a.base_mint.to_account_info(),
                    quote_mint: a.quote_mint.to_account_info(),
                    creator: a.coin.to_account_info(),
                    token_base_program: a.token_program.to_account_info(),
                    token_quote_program: a.token_program.to_account_info(),
                    event_authority: a.dbc_event_authority.to_account_info(),
                    program: a.dbc_program.to_account_info(),
                },
                &[seeds],
            ),
            u64::MAX,
            u64::MAX,
        )?;
    }
    ctx.accounts.holders_pot.reload()?;
    let after_fees = ctx.accounts.holders_pot.amount;

    // The city's share of the completion surplus: once the curve is complete
    // (DBC's own test: quote reserve >= target) and while DBC has not paid it
    // yet. DBC pays it at most once (its flag), into the pot, signed by `coin`.
    let surplus_due = {
        let a = &ctx.accounts;
        let pool = read_dbc_pool(&a.dbc_pool)?.pool_state;
        let target = a.dbc_config.load()?.migration_quote_threshold;
        pool.quote_reserve >= target && pool.is_creator_withdraw_surplus == 0
    };
    if surplus_due {
        let a = &ctx.accounts;
        dynamic_bonding_curve::cpi::creator_withdraw_surplus(CpiContext::new_with_signer(
            a.dbc_program.to_account_info(),
            CreatorWithdrawSurplus {
                pool_authority: a.dbc_pool_authority.to_account_info(),
                config: a.dbc_config.to_account_info(),
                virtual_pool: a.dbc_pool.to_account_info(),
                token_quote_account: a.holders_pot.to_account_info(),
                quote_vault: a.dbc_quote_vault.to_account_info(),
                quote_mint: a.quote_mint.to_account_info(),
                creator: a.coin.to_account_info(),
                token_quote_program: a.token_program.to_account_info(),
                event_authority: a.dbc_event_authority.to_account_info(),
                program: a.dbc_program.to_account_info(),
            },
            &[seeds],
        ))?;
        ctx.accounts.holders_pot.reload()?;
    }

    let after = ctx.accounts.holders_pot.amount;
    let claimed = after
        .checked_sub(before)
        .ok_or(LaunchpadError::MathOverflow)?;
    let surplus = after
        .checked_sub(after_fees)
        .ok_or(LaunchpadError::MathOverflow)?;
    if claimed == 0 {
        return Ok(());
    }
    let a = &mut ctx.accounts;
    let (to_holders, to_founder) = book_harvest(
        &a.token_program,
        &a.holders_pot,
        &a.founder_vault,
        &mut a.coin,
        claimed,
    )?;
    emit!(FeesHarvested {
        city_id,
        source: 0,
        claimed,
        surplus,
        to_holders,
        to_founder,
    });
    Ok(())
}
