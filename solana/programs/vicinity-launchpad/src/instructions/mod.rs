//! One file per instruction. Each file holds the Anchor account struct (all
//! constraints) and a uniquely named `handle_<instruction>` function (unique so
//! the glob re-exports below, which Anchor's `#[program]` macro needs, never collide).

pub mod accept_admin;
pub mod add_launch_config;
pub mod approve_launch;
pub mod claim_founder_fees;
pub mod forward_holders_fees;
pub mod harvest_curve_fees;
pub mod harvest_pool_fees;
pub mod init_launchpad;
pub mod launch;
pub mod opt_in_payout;
pub mod payout_founder_fees;
pub mod propose_admin;
pub mod revoke_approval;
pub mod revoke_payout_opt_in;
pub mod set_launch_config_enabled;
pub mod set_pause;
pub mod set_payout_config;
pub mod transfer_founder;

pub use accept_admin::*;
pub use add_launch_config::*;
pub use approve_launch::*;
pub use claim_founder_fees::*;
pub use forward_holders_fees::*;
pub use harvest_curve_fees::*;
pub use harvest_pool_fees::*;
pub use init_launchpad::*;
pub use launch::*;
pub use opt_in_payout::*;
pub use payout_founder_fees::*;
pub use propose_admin::*;
pub use revoke_approval::*;
pub use revoke_payout_opt_in::*;
pub use set_launch_config_enabled::*;
pub use set_pause::*;
pub use set_payout_config::*;
pub use transfer_founder::*;

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::COIN_SEED;
use crate::state::Coin;

/// SPL transfer out of one of the coin's two token accounts (holders pot or
/// founder vault), signed by the `Coin` PDA. Every caller pins `to` with
/// account constraints; this helper is the only place the PDA signs a transfer.
pub(crate) fn transfer_from_coin<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: AccountInfo<'info>,
    coin: &Account<'info, Coin>,
    amount: u64,
) -> Result<()> {
    let city_id = coin.city_id.to_le_bytes();
    let seeds: &[&[u8]] = &[COIN_SEED, &city_id, &[coin.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: from.to_account_info(),
                to,
                authority: coin.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// Book a harvest: `claimed` quote units just landed in the holders pot. The
/// founder half (rounded down) moves on to the founder vault; the pot keeps
/// the rest. Returns `(to_holders, to_founder)`. Counters are updated with
/// checked arithmetic.
pub(crate) fn book_harvest<'info>(
    token_program: &Program<'info, Token>,
    holders_pot: &Account<'info, TokenAccount>,
    founder_vault: &Account<'info, TokenAccount>,
    coin: &mut Account<'info, Coin>,
    claimed: u64,
) -> Result<(u64, u64)> {
    let (to_holders, to_founder) = crate::math::split_fee(claimed);
    if to_founder > 0 {
        transfer_from_coin(
            token_program,
            holders_pot,
            founder_vault.to_account_info(),
            coin,
            to_founder,
        )?;
    }
    coin.holders_accrued = coin
        .holders_accrued
        .checked_add(to_holders)
        .ok_or(crate::errors::LaunchpadError::MathOverflow)?;
    coin.founder_accrued = coin
        .founder_accrued
        .checked_add(to_founder)
        .ok_or(crate::errors::LaunchpadError::MathOverflow)?;
    Ok((to_holders, to_founder))
}
