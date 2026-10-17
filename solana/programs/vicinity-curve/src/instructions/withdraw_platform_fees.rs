//! `withdraw_platform_fees()` (4.14): anyone may call; the whole
//! `platform_pending` goes to the compiled `FEE_RECIPIENT` (R9) by the single
//! debit helper. No other instruction pays platform money. No-op when the
//! bucket is empty. Nothing can pause it (8.3); only the halt-all build
//! refuses it.

use anchor_lang::prelude::*;

use crate::constants::{COIN_SEED, FEE_RECIPIENT};
use crate::custody::{pay_out, require_not_halted};
use crate::errors::CurveError;
use crate::events::PlatformFeesWithdrawn;
use crate::state::CurveCoin;

#[event_cpi]
#[derive(Accounts)]
pub struct WithdrawPlatformFees<'info> {
    #[account(
        mut,
        seeds = [COIN_SEED, &coin.city_id.to_le_bytes()],
        bump = coin.bump,
    )]
    pub coin: Box<Account<'info, CurveCoin>>,

    /// CHECK: `FEE_RECIPIENT` (compiled constant, R9).
    #[account(
        mut,
        constraint = fee_recipient.key() == FEE_RECIPIENT @ CurveError::InvalidAddress,
    )]
    pub fee_recipient: UncheckedAccount<'info>,
}

pub fn handle_withdraw_platform_fees(ctx: Context<WithdrawPlatformFees>) -> Result<()> {
    require_not_halted()?;
    let to = ctx.accounts.fee_recipient.to_account_info();
    let coin = &mut ctx.accounts.coin;
    let amount = coin.platform_pending;
    if amount == 0 {
        return Ok(());
    }
    coin.platform_pending = 0;
    coin.platform_withdrawn = coin
        .platform_withdrawn
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
    let (city_id, total_withdrawn) = (coin.city_id, coin.platform_withdrawn);
    emit_cpi!(PlatformFeesWithdrawn {
        city_id,
        amount,
        total_withdrawn,
    });
    Ok(())
}
