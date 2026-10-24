//! `set_launch_approver(approver)` (4.24): the admin sets, rotates or removes
//! (zero) the launch approver, the key whose only powers are to publish and
//! to clear launch batches (8.1).
//!
//! The approver is never `FEE_RECIPIENT` (`FeeRecipientRole`), the admin, a
//! nonzero pending admin, a nonzero guardian, a nonzero payout key or a
//! nonzero payout wallet (`ApproverHoldsRole`); the other side of each rule is
//! checked where those keys are set (`propose_admin`, `accept_admin`,
//! `set_guardian`, `set_payout_config`), and `check_founder_key` refuses the
//! approver as a founder from then on. That the new key holds no founder seat
//! already cannot be seen on chain: 8.4's operating rule, checked by the
//! deploy checklist with `--proposed-launch-approver`.
//!
//! Every call clears both stored batches, whatever the new key is, and lifts a
//! halt: a batch never outlives a change of the key that signed it, and a halt
//! is lifted only together with a fresh start (the new approver's first batch
//! takes force a review window after it is published). Calling with the
//! current key is how the admin lifts a halt after a false alarm. Under the
//! time lock (O11) this takes 48 hours; the fast stops are the clear and the
//! guardian's pause. `LaunchApproverChanged` is an event CPI, like the
//! publication and the clear (review R6-RT-3).

use anchor_lang::prelude::*;

use crate::constants::{LAUNCHPAD_SEED, LAUNCH_BATCH_SEED};
use crate::errors::CurveError;
use crate::events::LaunchApproverChanged;
use crate::helpers::check_approver_separate;
use crate::state::{LaunchBatch, Launchpad};

#[event_cpi]
#[derive(Accounts)]
pub struct SetLaunchApprover<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ CurveError::Unauthorized,
    )]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(mut, seeds = [LAUNCH_BATCH_SEED], bump = launch_batch.bump)]
    pub launch_batch: Box<Account<'info, LaunchBatch>>,
}

pub fn handle_set_launch_approver(ctx: Context<SetLaunchApprover>, approver: Pubkey) -> Result<()> {
    let lp = &mut ctx.accounts.launchpad;
    check_approver_separate(&approver, lp)?;
    let old = lp.launch_approver;
    lp.launch_approver = approver;
    let lb = &mut ctx.accounts.launch_batch;
    lb.latest.cleared = true;
    lb.previous.cleared = true;
    lb.halted = false;
    emit_cpi!(LaunchApproverChanged {
        old,
        new: approver,
        latest_seq: lb.latest.seq,
    });
    Ok(())
}
