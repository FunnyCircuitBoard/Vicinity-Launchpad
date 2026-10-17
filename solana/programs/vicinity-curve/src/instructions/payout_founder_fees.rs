//! `payout_founder_fees()` (4.20): the payout key sends an opted-in founder's
//! whole `founder_pending` to the fixed payout wallet, as native SOL, at most
//! once per 24 hours per coin. Off by default (O12).
//!
//! The opt-in must have been signed by the current founder and name the
//! current payout wallet; the cooldown lives on the `Coin`, so re-opting
//! cannot reset it. No-op (no sequence number, no cooldown) when the bucket is
//! empty.

use anchor_lang::prelude::*;

use crate::constants::{COIN_SEED, LAUNCHPAD_SEED, PAYOUT_COOLDOWN_SECS, PAYOUT_OPT_IN_SEED};
use crate::custody::{pay_out, require_not_halted};
use crate::errors::CurveError;
use crate::events::FounderPaidOut;
use crate::instructions::now;
use crate::state::{CurveCoin, Launchpad, PayoutOptIn};

#[event_cpi]
#[derive(Accounts)]
pub struct PayoutFounderFees<'info> {
    pub payout_authority: Signer<'info>,

    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(
        mut,
        seeds = [COIN_SEED, &coin.city_id.to_le_bytes()],
        bump = coin.bump,
    )]
    pub coin: Box<Account<'info, CurveCoin>>,

    #[account(
        seeds = [PAYOUT_OPT_IN_SEED, coin.key().as_ref()],
        bump = opt_in.bump,
        has_one = coin @ CurveError::InvalidAddress,
    )]
    pub opt_in: Box<Account<'info, PayoutOptIn>>,

    /// CHECK: the configured payout wallet, a system-owned account.
    #[account(
        mut,
        constraint = destination_wallet.key() == launchpad.payout_destination
            @ CurveError::DestinationMismatch,
        constraint = *destination_wallet.owner == anchor_lang::system_program::ID
            @ CurveError::InvalidAddress,
    )]
    pub destination_wallet: UncheckedAccount<'info>,
}

pub fn handle_payout_founder_fees(ctx: Context<PayoutFounderFees>) -> Result<()> {
    require_not_halted()?;
    let a = &ctx.accounts;
    let lp = &a.launchpad;
    require!(
        lp.payout_authority != Pubkey::default() && a.payout_authority.key() == lp.payout_authority,
        CurveError::Unauthorized
    );
    require!(!lp.payouts_paused, CurveError::PayoutsPaused);
    require_keys_eq!(
        a.opt_in.founder,
        a.coin.founder,
        CurveError::OptInFounderMismatch
    );
    require_keys_eq!(
        a.opt_in.agreed_destination,
        lp.payout_destination,
        CurveError::DestinationMismatch
    );
    let (timestamp, _) = now()?;
    let next_allowed = a
        .coin
        .last_payout_at
        .checked_add(PAYOUT_COOLDOWN_SECS)
        .ok_or(CurveError::MathOverflow)?;
    require!(timestamp >= next_allowed, CurveError::PayoutTooSoon);

    let to = a.destination_wallet.to_account_info();
    let destination = a.destination_wallet.key();
    let ref_hash = a.opt_in.ref_hash;
    let coin = &mut ctx.accounts.coin;
    let amount = coin.founder_pending;
    if amount == 0 {
        return Ok(());
    }
    coin.founder_pending = 0;
    coin.founder_paid_out = coin
        .founder_paid_out
        .checked_add(amount as u128)
        .ok_or(CurveError::MathOverflow)?;
    coin.payout_seq = coin
        .payout_seq
        .checked_add(1)
        .ok_or(CurveError::MathOverflow)?;
    coin.last_payout_at = timestamp;
    let liabilities_after = coin.liabilities()?;
    pay_out(
        &coin.to_account_info(),
        coin.rent_reserve,
        &to,
        amount,
        liabilities_after,
    )?;
    let (city_id, founder, seq, total_paid_out) = (
        coin.city_id,
        coin.founder,
        coin.payout_seq,
        coin.founder_paid_out,
    );
    emit_cpi!(FounderPaidOut {
        city_id,
        founder,
        destination,
        amount,
        seq,
        ref_hash,
        total_paid_out,
    });
    Ok(())
}
