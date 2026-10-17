//! `set_guardian(guardian)` (4.4): the admin sets or clears (zero) the guardian,
//! whose only power is to set `launches_paused`, `buys_halted` and
//! `buybacks_halted` to true. To recover from a stolen guardian the first
//! proposal replaces the guardian, optionally with a `set_pause` that sets
//! `buybacks = Some(false)` (or `buys = Some(true)`) and leaves buys halted, so
//! that the thief's last flag before execution cannot make that `set_pause`
//! (and with it the replacement) fail; buys reopen in a later proposal after
//! the keeper has drained the backlogs (4.4, 8.3; reviews R4-DIFF-4, OPS-3).
//! The guardian "cannot touch money" (8.1): it may not be `FEE_RECIPIENT`,
//! the payout key or the payout wallet (GOV-2); and it is not the admin or
//! the proposed admin, whose actions wait for the time lock (R5-CONS-1).

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::CurveError;
use crate::events::GuardianChanged;
use crate::helpers::{
    check_guardian_separate, check_not_fee_recipient, check_payout_keys_separate,
};
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
    check_not_fee_recipient(&guardian)?;
    check_payout_keys_separate(
        &lp.admin,
        &guardian,
        &lp.payout_authority,
        &lp.payout_destination,
    )?;
    check_guardian_separate(&guardian, &lp.admin, &lp.pending_admin)?;
    let old = lp.guardian;
    lp.guardian = guardian;
    emit!(GuardianChanged { old, new: guardian });
    Ok(())
}
