//! `set_payout_config`: the admin sets the payout key and the payout wallet
//! for opted-in founder payouts, or switches payouts off with two zeros.
//!
//! Existing opt-ins whose `agreed_destination` differs from the new wallet stop
//! working until the founder signs again; they are never redirected
//! (`payout_founder_fees` checks both). The keys must be separate: the payout
//! key is neither the admin nor the dev wallet, and the payout wallet is
//! neither the payout key nor the admin.

use anchor_lang::prelude::*;

use crate::constants::{FEE_RECIPIENT, LAUNCHPAD_SEED};
use crate::errors::LaunchpadError;
use crate::events::PayoutConfigChanged;
use crate::state::Launchpad;

#[derive(Accounts)]
pub struct SetPayoutConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ LaunchpadError::Unauthorized,
    )]
    pub launchpad: Account<'info, Launchpad>,
}

pub fn handle_set_payout_config(
    ctx: Context<SetPayoutConfig>,
    payout_authority: Pubkey,
    payout_destination: Pubkey,
) -> Result<()> {
    let lp = &mut ctx.accounts.launchpad;
    let zero = Pubkey::default();
    let off = payout_authority == zero && payout_destination == zero;
    if !off {
        require!(
            payout_authority != zero && payout_destination != zero,
            LaunchpadError::InvalidAddress
        );
        require!(
            payout_authority != lp.admin
                && payout_authority != FEE_RECIPIENT
                && payout_destination != payout_authority
                && payout_destination != lp.admin,
            LaunchpadError::PayoutKeyNotSeparate
        );
    }
    emit!(PayoutConfigChanged {
        old_authority: lp.payout_authority,
        new_authority: payout_authority,
        old_destination: lp.payout_destination,
        new_destination: payout_destination,
    });
    lp.payout_authority = payout_authority;
    lp.payout_destination = payout_destination;
    Ok(())
}
