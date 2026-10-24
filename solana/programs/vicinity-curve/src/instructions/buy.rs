//! `buy(sol_in, min_tokens_out)` (4.11): exact-in buy, on the curve or in the
//! pool, with the same 10 accounts as `sell` before and after graduation.
//!
//! Every number comes from `vicinity_curve_math::quote_buy` (5.4, 5.7): the
//! charge (`charged <= sol_in`; less only on the partial fill of the buy that
//! completes the curve), the coins out, the fee split, the drip and the whole
//! new state, which the handler writes without arithmetic of its own. The buy
//! that takes the last curve coin graduates the coin in the same instruction
//! (5.6): no CPI, no account, no keeper.
//!
//! Only the coin, its vault and the user's two accounts are written;
//! `Launchpad` is read for `buys_halted` only, so trades of different coins
//! never contend.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use vicinity_curve_math::{quote_buy, spot_price, Phase, State};

use crate::constants::{COIN_DECIMALS, COIN_SEED, LAUNCHPAD_SEED, MIN_TRADE_LAMPORTS};
use crate::custody::require_not_halted;
use crate::errors::{math_err, CurveError};
use crate::events::{Graduated, Trade};
use crate::instructions::{now, with_coin_signer};
use crate::state::{CurveCoin, Launchpad};

#[event_cpi]
#[derive(Accounts)]
pub struct Buy<'info> {
    /// Pays `charged` lamports by a system transfer, so it must be a
    /// system-owned account without data (14.3).
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [COIN_SEED, &coin.city_id.to_le_bytes()],
        bump = coin.bump,
    )]
    pub coin: Box<Account<'info, CurveCoin>>,

    /// Only `buys_halted` is read.
    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(constraint = mint.key() == coin.mint @ CurveError::InvalidAddress)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = coin_vault.key() == coin.vault @ CurveError::InvalidAddress,
    )]
    pub coin_vault: Box<Account<'info, TokenAccount>>,

    /// Any token account of this mint (a router may deliver to an account it
    /// controls), except one whose authority is the `Coin` PDA (the vault or
    /// any other), from which coins could never move again.
    #[account(
        mut,
        constraint = user_token_account.mint == mint.key() @ CurveError::WrongTokenAccount,
        constraint = user_token_account.owner != coin.key() @ CurveError::SameAccount,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
    require_not_halted()?;
    let a = &ctx.accounts;
    require!(!a.launchpad.buys_halted, CurveError::BuysHalted);
    require!(sol_in >= MIN_TRADE_LAMPORTS, CurveError::TradeTooSmall);
    let terms = a.coin.terms();
    let before: State = a.coin.state()?;
    let q = quote_buy(&terms, &before, sol_in).map_err(math_err)?;
    require!(q.tokens_out >= 1, CurveError::ZeroOutput);
    require!(q.tokens_out >= min_tokens_out, CurveError::SlippageExceeded);
    let (timestamp, slot) = now()?;
    let (city_id, bump) = (a.coin.city_id, a.coin.bump);

    // 1. Value in: user -> Coin, exactly `charged` (the rest of `sol_in` never
    //    leaves the user's wallet).
    system_program::transfer(
        CpiContext::new(
            a.system_program.to_account_info(),
            Transfer {
                from: a.user.to_account_info(),
                to: a.coin.to_account_info(),
            },
        ),
        q.charged,
    )?;

    // 2. Coins out: vault -> user token account, signed by the Coin PDA.
    with_coin_signer(city_id, bump, |signer| {
        token::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                TransferChecked {
                    from: a.coin_vault.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.user_token_account.to_account_info(),
                    authority: a.coin.to_account_info(),
                },
                signer,
            ),
            q.tokens_out,
            COIN_DECIMALS,
        )
    })?;

    // 3. State: the math crate's new state; on graduation it is already in
    //    phase Pool with pool_sol = R and pool_tokens = P (5.6).
    let user = a.user.key();
    let coin = &mut ctx.accounts.coin;
    coin.apply_state(&q.new_state);
    if q.graduates {
        coin.graduated_at = timestamp;
        coin.graduation_slot = slot;
    }
    let after = q.new_state;
    let (virtual_sol_after, virtual_tokens_after) = spot_price(&terms, &after).map_err(math_err)?;
    let mint = coin.mint;

    // 4. Events.
    emit_cpi!(Trade {
        city_id,
        mint,
        user,
        is_buy: true,
        phase: before.phase.as_u8(),
        sol_in,
        sol_amount: q.charged,
        sol_net: q.net,
        token_amount: q.tokens_out,
        fee: q.split.fee,
        fee_liquidity: q.split.liquidity,
        fee_platform: q.split.platform,
        fee_founder: q.split.founder,
        fee_holders: q.split.holders,
        fee_buyback: q.split.buyback,
        liquidity_dripped: q.drip,
        partial: q.partial,
        graduated: q.graduates,
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
    if q.graduates {
        // The curve's last virtual reserves (x0 + R, y0 - S), from the math
        // crate on the curve-phase view of the final state.
        let last_curve = State {
            phase: Phase::Curve,
            ..after
        };
        let (last_virtual_sol, last_virtual_tokens) =
            spot_price(&terms, &last_curve).map_err(math_err)?;
        emit_cpi!(Graduated {
            city_id,
            mint,
            pool_sol: after.pool_sol,
            pool_tokens: after.pool_tokens,
            liquidity_pending: after.liquidity_pending,
            last_virtual_sol,
            last_virtual_tokens,
            slot,
            timestamp,
        });
    }
    Ok(())
}
