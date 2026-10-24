//! `set_payout_config(payout_authority, payout_destination)` (4.5).
//!
//! Two zeros switch opted-in payouts off. Otherwise both must be nonzero and
//! separate: the payout key is not the admin, the guardian or `FEE_RECIPIENT`;
//! the payout wallet is not the payout key, the admin, the guardian or
//! `FEE_RECIPIENT` (GOV-2); neither is the launch approver, which never
//! touches money (4.24). Existing opt-ins naming another wallet stop
//! working; they are never redirected.

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::CurveError;
use crate::events::PayoutConfigChanged;
use crate::helpers::{check_not_approver, check_payout_keys_separate};
use crate::state::Launchpad;

#[derive(Accounts)]
pub struct SetPayoutConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ CurveError::Unauthorized,
    )]
    pub launchpad: Box<Account<'info, Launchpad>>,
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
            CurveError::InvalidAddress
        );
        check_payout_keys_separate(
            &lp.admin,
            &lp.guardian,
            &payout_authority,
            &payout_destination,
        )?;
        check_not_approver(&payout_authority, &lp.launch_approver)?;
        check_not_approver(&payout_destination, &lp.launch_approver)?;
    }
    let (old_authority, old_destination) = (lp.payout_authority, lp.payout_destination);
    lp.payout_authority = payout_authority;
    lp.payout_destination = payout_destination;
    emit!(PayoutConfigChanged {
        old_authority,
        new_authority: payout_authority,
        old_destination,
        new_destination: payout_destination,
    });
    Ok(())
}
