//! `transfer_founder()` (4.17): the founder hands the seat to a key that
//! co-signs. Money still pending goes with the seat (the founder should claim
//! first); an existing payout opt-in stops working (it names the old founder).
//! The admin can never change a founder.
//!
//! The new founder is never `FEE_RECIPIENT`, the guardian or the payout key
//! (the founder seat receives money; R2-DIFF-1, SPEC-1), so the instruction
//! reads the `Launchpad` (read-only, seed-pinned).

use anchor_lang::prelude::*;

use crate::constants::{COIN_SEED, LAUNCHPAD_SEED};
use crate::errors::CurveError;
use crate::events::FounderTransferred;
use crate::helpers::check_founder_key;
use crate::state::{CurveCoin, Launchpad};

#[derive(Accounts)]
pub struct TransferFounder<'info> {
    pub founder: Signer<'info>,

    pub new_founder: Signer<'info>,

    /// Read for the guardian and the payout key (the new founder is neither).
    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(
        mut,
        seeds = [COIN_SEED, &coin.city_id.to_le_bytes()],
        bump = coin.bump,
        has_one = founder @ CurveError::WrongFounder,
    )]
    pub coin: Box<Account<'info, CurveCoin>>,
}

pub fn handle_transfer_founder(ctx: Context<TransferFounder>) -> Result<()> {
    let new = ctx.accounts.new_founder.key();
    let lp = &ctx.accounts.launchpad;
    check_founder_key(&new, &lp.guardian, &lp.payout_authority)?;
    let coin = &mut ctx.accounts.coin;
    let old = coin.founder;
    coin.founder = new;
    emit!(FounderTransferred {
        city_id: coin.city_id,
        old,
        new,
    });
    Ok(())
}
