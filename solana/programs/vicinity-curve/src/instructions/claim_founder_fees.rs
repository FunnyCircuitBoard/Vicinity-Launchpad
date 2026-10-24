//! `claim_founder_fees()` (4.16): the founder takes the whole
//! `founder_pending`, by the single debit helper, whatever is paused and
//! whether or not he opted in to payouts. No-op when the bucket is empty. If
//! the founder's wallet holds 0 lamports, the claim must reach the rent-exempt
//! minimum of an empty account (14.3).

use anchor_lang::prelude::*;

use crate::constants::COIN_SEED;
use crate::custody::{pay_out, require_not_halted};
use crate::errors::CurveError;
use crate::events::FounderFeesClaimed;
use crate::state::CurveCoin;

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimFounderFees<'info> {
    #[account(mut)]
    pub founder: Signer<'info>,

    #[account(
        mut,
        seeds = [COIN_SEED, &coin.city_id.to_le_bytes()],
        bump = coin.bump,
        has_one = founder @ CurveError::WrongFounder,
    )]
    pub coin: Box<Account<'info, CurveCoin>>,
}

pub fn handle_claim_founder_fees(ctx: Context<ClaimFounderFees>) -> Result<()> {
    require_not_halted()?;
    let to = ctx.accounts.founder.to_account_info();
    let founder = ctx.accounts.founder.key();
    let coin = &mut ctx.accounts.coin;
    let amount = coin.founder_pending;
    if amount == 0 {
        return Ok(());
    }
    coin.founder_pending = 0;
    coin.founder_claimed = coin
        .founder_claimed
        .checked_add(amount as u128)
        .ok_or(CurveError::MathOverflow)?;
    let liabilities_after = coin.liabilities()?;
    pay_out(
        &coin.to_account_info(),
        coin.rent_reserve,
        &to,
        amount,
        liabilities_after,
    )?;
    let (city_id, total_claimed) = (coin.city_id, coin.founder_claimed);
    emit_cpi!(FounderFeesClaimed {
        city_id,
        founder,
        amount,
        total_claimed,
    });
    Ok(())
}
