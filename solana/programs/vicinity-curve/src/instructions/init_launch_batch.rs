//! `init_launch_batch()` (4.23): the admin creates the one `LaunchBatch`
//! account (3.11), every field zero: no batch (`latest.seq = previous.seq =
//! 0`), not halted. One time: a second call fails at `init`.
//!
//! Creating the account does not turn the batch path on; that is
//! `set_launch_approver` (4.24). A separate instruction rather than a change
//! to `init_launchpad`: the reviewed `init_launchpad` stays as it is, a
//! deployment already initialised gains the account, and the program keeps
//! plain `init` everywhere (T29).

use anchor_lang::prelude::*;

use crate::constants::{LAUNCHPAD_SEED, LAUNCH_BATCH_SEED};
use crate::errors::CurveError;
use crate::events::LaunchBatchInitialized;
use crate::state::{BatchRecord, LaunchBatch, Launchpad};

#[derive(Accounts)]
pub struct InitLaunchBatch<'info> {
    pub admin: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ CurveError::Unauthorized,
    )]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(
        init,
        payer = payer,
        space = 8 + LaunchBatch::INIT_SPACE,
        seeds = [LAUNCH_BATCH_SEED],
        bump,
    )]
    pub launch_batch: Box<Account<'info, LaunchBatch>>,

    pub system_program: Program<'info, System>,
}

pub fn handle_init_launch_batch(ctx: Context<InitLaunchBatch>) -> Result<()> {
    let lb = &mut ctx.accounts.launch_batch;
    lb.bump = ctx.bumps.launch_batch;
    lb.halted = false;
    lb.latest = BatchRecord::default();
    lb.previous = BatchRecord::default();
    lb._reserved = [0; 32];
    emit!(LaunchBatchInitialized {
        by: ctx.accounts.admin.key(),
    });
    Ok(())
}
