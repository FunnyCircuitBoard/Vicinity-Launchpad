//! `transfer_founder()` (4.17): the founder hands the seat to a key that
//! co-signs. Money still pending goes with the seat (the founder should claim
//! first); an existing payout opt-in stops working (it names the old founder).
//! The admin can never change a founder.

use anchor_lang::prelude::*;

use crate::constants::COIN_SEED;
use crate::errors::CurveError;
use crate::events::FounderTransferred;
use crate::state::CurveCoin;

#[derive(Accounts)]
pub struct TransferFounder<'info> {
    pub founder: Signer<'info>,

    pub new_founder: Signer<'info>,

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
