//! `sell(tokens_in, min_sol_out)` (4.12): exact-in sell, on the curve or in the
//! pool, with the same 10 accounts in the same order as `buy`.
//!
//! No minimum and no flag blocks a sell: `launchpad` is an unchecked account
//! whose address is checked and whose data is never read, and
//! `system_program` is unused; both keep the two account lists identical
//! (4.12, 8.3). Every number comes from `vicinity_curve_math::quote_sell`
//! (5.5, 5.7). The seller is paid by a direct lamport move through
//! `custody::pay_out`, after the bookkeeping; the only CPI after it is the
//! event CPI (rule of 4.0).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use vicinity_curve_math::{quote_sell, spot_price, State};

use crate::constants::{COIN_DECIMALS, COIN_SEED, LAUNCHPAD_SEED};
use crate::custody::{pay_out, require_not_halted};
use crate::errors::{math_err, CurveError};
use crate::events::Trade;
use crate::instructions::now;
use crate::state::CurveCoin;

#[event_cpi]
#[derive(Accounts)]
pub struct Sell<'info> {
    /// Owns `user_token_account` and receives `sol_out` lamports. If it holds
    /// 0 lamports, the payout must reach the rent-exempt minimum of an empty
    /// account or the runtime refuses the transaction (14.3).
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [COIN_SEED, &coin.city_id.to_le_bytes()],
        bump = coin.bump,
    )]
    pub coin: Box<Account<'info, CurveCoin>>,

    /// CHECK: the `Launchpad` PDA; only its address is checked and its data is
    /// never read, so no setting can stop an exit.
    #[account(seeds = [LAUNCHPAD_SEED], bump)]
    pub launchpad: UncheckedAccount<'info>,

    #[account(constraint = mint.key() == coin.mint @ CurveError::InvalidAddress)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = coin_vault.key() == coin.vault @ CurveError::InvalidAddress,
    )]
    pub coin_vault: Box<Account<'info, TokenAccount>>,

    /// The seller's token account of this mint.
    #[account(
        mut,
        constraint = user_token_account.mint == mint.key() @ CurveError::WrongTokenAccount,
        constraint = user_token_account.owner != coin.key() @ CurveError::SameAccount,
        constraint = user_token_account.owner == user.key() @ CurveError::WrongTokenAccount,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    /// Unused; keeps the account list identical to `buy`'s.
    pub system_program: Program<'info, System>,
}

pub fn handle_sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
    require_not_halted()?;
    let a = &ctx.accounts;
    require!(tokens_in >= 1, CurveError::ZeroAmount);
    let terms = a.coin.terms();
    let before: State = a.coin.state()?;
    let q = quote_sell(&terms, &before, tokens_in).map_err(math_err)?;
    require!(q.sol_out >= 1, CurveError::ZeroOutput);
    require!(q.sol_out >= min_sol_out, CurveError::SlippageExceeded);
    let (timestamp, slot) = now()?;

    // 1. Coins in: user token account -> vault, signed by the user.
    token::transfer_checked(
        CpiContext::new(
            a.token_program.to_account_info(),
            TransferChecked {
                from: a.user_token_account.to_account_info(),
                mint: a.mint.to_account_info(),
                to: a.coin_vault.to_account_info(),
                authority: a.user.to_account_info(),
            },
        ),
        tokens_in,
        COIN_DECIMALS,
    )?;

    // 2. State: the math crate's new state.
    let user_info = a.user.to_account_info();
    let user = a.user.key();
    let coin = &mut ctx.accounts.coin;
    coin.apply_state(&q.new_state);
    let liabilities_after = coin.liabilities()?;

    // 3. Pay the seller (6.5): the single debit helper, after the bookkeeping.
    pay_out(
        &coin.to_account_info(),
        coin.rent_reserve,
        &user_info,
        q.sol_out,
        liabilities_after,
    )?;

    // 4. Event.
    let after = q.new_state;
    let (virtual_sol_after, virtual_tokens_after) = spot_price(&terms, &after).map_err(math_err)?;
    let (city_id, mint) = (coin.city_id, coin.mint);
    emit_cpi!(Trade {
        city_id,
        mint,
        user,
        is_buy: false,
        phase: before.phase.as_u8(),
        sol_in: 0,
        sol_amount: q.gross,
        sol_net: q.sol_out,
        token_amount: tokens_in,
        fee: q.split.fee,
        fee_liquidity: q.split.liquidity,
        fee_platform: q.split.platform,
        fee_founder: q.split.founder,
        fee_holders: q.split.holders,
        fee_buyback: q.split.buyback,
        liquidity_dripped: q.drip,
        partial: false,
        graduated: false,
        virtual_sol_after,
        virtual_tokens_after,
        tokens_sold: after.tokens_sold,
        curve_sol: after.curve_sol,
        pool_sol: after.pool_sol,
        pool_tokens: after.pool_tokens,
        liquidity_pending: after.liquidity_pending,
        trade_seq: after.trade_seq,
        slot,
        timestamp,
    });
    Ok(())
}
