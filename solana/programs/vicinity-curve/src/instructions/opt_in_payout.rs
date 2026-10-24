//! `opt_in_payout(expected_destination, ref_hash)` (4.18): the founder agrees
//! that the payout key may send his founder share, at most daily, to the
//! currently configured payout wallet (X Money style; off by default, O12).
//! `ref_hash` is the SHA-256 of the off-chain reference, never a name or an
//! account number.

use anchor_lang::prelude::*;

use crate::constants::{COIN_SEED, LAUNCHPAD_SEED, PAYOUT_OPT_IN_SEED};
use crate::errors::CurveError;
use crate::events::PayoutOptedIn;
use crate::instructions::now;
use crate::state::{CurveCoin, Launchpad, PayoutOptIn};

#[derive(Accounts)]
pub struct OptInPayout<'info> {
    #[account(mut)]
    pub founder: Signer<'info>,

    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(
        seeds = [COIN_SEED, &coin.city_id.to_le_bytes()],
        bump = coin.bump,
        has_one = founder @ CurveError::WrongFounder,
    )]
    pub coin: Box<Account<'info, CurveCoin>>,

    #[account(
        init,
        payer = founder,
        space = 8 + PayoutOptIn::INIT_SPACE,
        seeds = [PAYOUT_OPT_IN_SEED, coin.key().as_ref()],
        bump,
    )]
    pub opt_in: Box<Account<'info, PayoutOptIn>>,

    pub system_program: Program<'info, System>,
}

pub fn handle_opt_in_payout(
    ctx: Context<OptInPayout>,
    expected_destination: Pubkey,
    ref_hash: [u8; 32],
) -> Result<()> {
    let lp = &ctx.accounts.launchpad;
    let zero = Pubkey::default();
    require!(
        lp.payout_authority != zero && lp.payout_destination != zero,
        CurveError::PayoutsNotConfigured
    );
    require_keys_eq!(
        expected_destination,
        lp.payout_destination,
        CurveError::DestinationMismatch
    );
    let (timestamp, _) = now()?;
    let founder = ctx.accounts.founder.key();
    let coin_key = ctx.accounts.coin.key();
    let city_id = ctx.accounts.coin.city_id;
    let o = &mut ctx.accounts.opt_in;
    o.coin = coin_key;
    o.founder = founder;
    o.agreed_destination = expected_destination;
    o.ref_hash = ref_hash;
    o.opted_in_at = timestamp;
    o.bump = ctx.bumps.opt_in;
    emit!(PayoutOptedIn {
        city_id,
        founder,
        destination: expected_destination,
        ref_hash,
    });
    Ok(())
}
