//! `buyback_burn()` (4.13, 7.1): permissionless crank, no arguments. The
//! caller chooses nothing and receives nothing.
//!
//! The math crate decides everything (`quote_buyback`): at most one run per
//! 150 slots per coin (the first at least 150 slots after launch), at most
//! `depth * t / (25 * D)` lamports per run (0.1% of the market's SOL depth at
//! 2.5%), no fee (O7), and on the curve never past `S - 1` coins sold, so a
//! buyback never graduates the coin (M8). The SOL never leaves the `Coin`: it
//! moves from the buyback bucket into the reserve, and the coins it buys are
//! burned from the vault with SPL `burn`.
//!
//! No-op (`Ok`, no state change, no event) when there is nothing to do; a halt
//! (`BuybacksHalted`) is an error (4.0). Buybacks have their own flag (review
//! LL-1): while only buys are halted they go on, so no backlog builds, and
//! after a halt of both the admin resumes buybacks first and the keeper spends
//! each coin's backlog while nobody can buy ahead of it.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};
use vicinity_curve_math::{quote_buyback, spot_price};

use crate::constants::{COIN_SEED, LAUNCHPAD_SEED};
use crate::custody::require_not_halted;
use crate::errors::{math_err, CurveError};
use crate::events::BuybackBurned;
use crate::instructions::{now, with_coin_signer};
use crate::state::{CurveCoin, Launchpad};

#[event_cpi]
#[derive(Accounts)]
pub struct BuybackBurn<'info> {
    #[account(
        mut,
        seeds = [COIN_SEED, &coin.city_id.to_le_bytes()],
        bump = coin.bump,
    )]
    pub coin: Box<Account<'info, CurveCoin>>,

    /// Only `buybacks_halted` is read.
    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    /// Writable: a burn lowers the supply.
    #[account(mut, constraint = mint.key() == coin.mint @ CurveError::InvalidAddress)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = coin_vault.key() == coin.vault @ CurveError::InvalidAddress,
    )]
    pub coin_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_buyback_burn(ctx: Context<BuybackBurn>) -> Result<()> {
    require_not_halted()?;
    let a = &ctx.accounts;
    require!(!a.launchpad.buybacks_halted, CurveError::BuybacksHalted);
    let (timestamp, slot) = now()?;
    let terms = a.coin.terms();
    let before = a.coin.state()?;
    let q = match quote_buyback(&terms, &before, slot).map_err(math_err)? {
        Some(q) => q,
        // Bucket empty, interval not passed, or nothing to buy: no-op.
        None => return Ok(()),
    };
    let (city_id, bump) = (a.coin.city_id, a.coin.bump);

    // Burn the coins the buyback bought, signed by the Coin PDA.
    with_coin_signer(city_id, bump, |signer| {
        token::burn(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                Burn {
                    mint: a.mint.to_account_info(),
                    from: a.coin_vault.to_account_info(),
                    authority: a.coin.to_account_info(),
                },
                signer,
            ),
            q.coins,
        )
    })?;

    // State: reserve, buyback bucket and counters from the math crate. No
    // lamport leaves the account.
    let coin = &mut ctx.accounts.coin;
    coin.apply_state(&q.new_state);
    let mint_key = coin.mint;
    let after = q.new_state;
    let (virtual_sol_after, virtual_tokens_after) = spot_price(&terms, &after).map_err(math_err)?;
    ctx.accounts.mint.reload()?;
    let supply_after = ctx.accounts.mint.supply;

    emit_cpi!(BuybackBurned {
        city_id,
        mint: mint_key,
        phase: before.phase.as_u8(),
        sol_spent: q.spent,
        tokens_burned: q.coins,
        cap: q.cap,
        buyback_pending_after: after.buyback_pending,
        tokens_burned_total: after.tokens_burned,
        supply_after,
        virtual_sol_after,
        virtual_tokens_after,
        slot,
        timestamp,
    });
    Ok(())
}
