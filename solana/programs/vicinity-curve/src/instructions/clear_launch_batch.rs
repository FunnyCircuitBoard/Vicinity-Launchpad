//! `clear_launch_batch(halt)` (4.26): the admin, the launch approver or the
//! guardian ends every stored batch (`latest.cleared = previous.cleared =
//! true`) and, with `halt`, refuses further publications until the admin's
//! `set_launch_approver` (a new key, or the same key after a false alarm).
//!
//! A pure stop: it never approves, re-opens a batch or lifts a halt; nothing
//! is ever set to false here. After a clear without `halt` the approver's next
//! batch takes force a review window after it is published. The per-city path
//! (4.8 to 4.10) is untouched; to stop every launch at once the guardian or
//! the admin sets `launches_paused` (4.4). The guardian and the approver may
//! halt as well as clear: a thief of either key could only stop batch
//! launches, which he can do anyway (8.1). The event is emitted also when
//! nothing changed (a repeated clear), by event CPI so that padding the
//! transaction until its log is truncated cannot hide it (review R6-RT-3).

use anchor_lang::prelude::*;

use crate::constants::{LAUNCHPAD_SEED, LAUNCH_BATCH_SEED};
use crate::errors::CurveError;
use crate::events::LaunchBatchCleared;
use crate::helpers::may_clear_batches;
use crate::state::{LaunchBatch, Launchpad};

#[event_cpi]
#[derive(Accounts)]
pub struct ClearLaunchBatch<'info> {
    pub authority: Signer<'info>,

    /// `admin`, `guardian` and `launch_approver` are read.
    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(mut, seeds = [LAUNCH_BATCH_SEED], bump = launch_batch.bump)]
    pub launch_batch: Box<Account<'info, LaunchBatch>>,
}

pub fn handle_clear_launch_batch(ctx: Context<ClearLaunchBatch>, halt: bool) -> Result<()> {
    let by = ctx.accounts.authority.key();
    require!(
        may_clear_batches(&by, &ctx.accounts.launchpad),
        CurveError::Unauthorized
    );
    let lb = &mut ctx.accounts.launch_batch;
    lb.latest.cleared = true;
    lb.previous.cleared = true;
    if halt {
        lb.halted = true;
    }
    emit_cpi!(LaunchBatchCleared {
        by,
        latest_seq: lb.latest.seq,
        previous_seq: lb.previous.seq,
        halted: lb.halted,
    });
    Ok(())
}
