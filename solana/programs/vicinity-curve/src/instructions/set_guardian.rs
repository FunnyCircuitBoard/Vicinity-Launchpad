//! `set_guardian(guardian)` (4.4): the admin sets or clears (zero) the guardian,
//! whose only power is to set `launches_paused` and `buys_halted` to true. To
//! recover from a stolen guardian the admin clears `buys_halted` and replaces
//! the guardian in the same proposal.

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::CurveError;
use crate::events::GuardianChanged;
use crate::state::Launchpad;

#[derive(Accounts)]
pub struct SetGuardian<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ CurveError::Unauthorized,
    )]
    pub launchpad: Box<Account<'info, Launchpad>>,
}

pub fn handle_set_guardian(ctx: Context<SetGuardian>, guardian: Pubkey) -> Result<()> {
    let lp = &mut ctx.accounts.launchpad;
    let old = lp.guardian;
    lp.guardian = guardian;
    emit!(GuardianChanged { old, new: guardian });
    Ok(())
}
