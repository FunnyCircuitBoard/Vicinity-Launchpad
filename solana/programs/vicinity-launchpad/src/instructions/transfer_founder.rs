//! `transfer_founder`: the founder hands the seat (and the founder share from
//! now on) to a new key. Both sign, which proves the new key is live. Money
//! already in the vault goes with the seat, so the founder should claim first.
//! The admin has no way to change a founder (decision D9).

use anchor_lang::prelude::*;

use crate::constants::COIN_SEED;
use crate::errors::LaunchpadError;
use crate::events::FounderTransferred;
use crate::state::Coin;

#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct TransferFounder<'info> {
    pub founder: Signer<'info>,

    pub new_founder: Signer<'info>,

    #[account(
        mut,
        seeds = [COIN_SEED, &city_id.to_le_bytes()],
        bump = coin.bump,
        has_one = founder @ LaunchpadError::WrongFounder,
    )]
    pub coin: Box<Account<'info, Coin>>,
}

pub fn handle_transfer_founder(ctx: Context<TransferFounder>, city_id: u64) -> Result<()> {
    let new = ctx.accounts.new_founder.key();
    let coin = &mut ctx.accounts.coin;
    let old = coin.founder;
    coin.founder = new;
    emit!(FounderTransferred { city_id, old, new });
    Ok(())
}
