//! `opt_in_payout`: the founder lets the Vicinity payout key send their
//! founder fees, at most once a day, ONLY into the one payout wallet fixed in
//! the launchpad settings, so a payout service can turn them into US dollars
//! for the founder's X Money account (LAUNCHPAD-DESIGN.md section 13).
//!
//! The founder names the destination they expect; if the setting differs (for
//! example it changed while they were signing) the opt-in is refused. The
//! destination is copied into the opt-in, and every payout must match both the
//! copy and the current setting, so a settings change can never redirect this
//! founder's money. Only a hash of the off-chain reference goes on chain.
//! Revocable at any time (`revoke_payout_opt_in`); the founder can always still
//! claim directly.

use anchor_lang::prelude::*;

use crate::constants::{COIN_SEED, LAUNCHPAD_SEED, PAYOUT_OPT_IN_SEED};
use crate::errors::LaunchpadError;
use crate::events::PayoutOptedIn;
use crate::state::{Coin, Launchpad, PayoutOptIn};

#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct OptInPayout<'info> {
    /// Must be `coin.founder`; pays the opt-in's rent (refunded on revoke).
    #[account(mut)]
    pub founder: Signer<'info>,

    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(
        seeds = [COIN_SEED, &city_id.to_le_bytes()],
        bump = coin.bump,
        has_one = founder @ LaunchpadError::WrongFounder,
    )]
    pub coin: Box<Account<'info, Coin>>,

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
    city_id: u64,
    expected_destination: Pubkey,
    ref_hash: [u8; 32],
) -> Result<()> {
    let lp = &ctx.accounts.launchpad;
    require!(
        lp.payout_authority != Pubkey::default() && lp.payout_destination != Pubkey::default(),
        LaunchpadError::PayoutsNotConfigured
    );
    require_keys_eq!(
        expected_destination,
        lp.payout_destination,
        LaunchpadError::DestinationMismatch
    );
    let founder = ctx.accounts.founder.key();
    let coin = ctx.accounts.coin.key();
    let o = &mut ctx.accounts.opt_in;
    o.coin = coin;
    o.founder = founder;
    o.agreed_destination = expected_destination;
    o.ref_hash = ref_hash;
    o.opted_in_at = Clock::get()?.unix_timestamp;
    o.bump = ctx.bumps.opt_in;
    emit!(PayoutOptedIn {
        city_id,
        founder,
        destination: expected_destination,
        ref_hash,
    });
    Ok(())
}
