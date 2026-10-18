//! `publish_launch_batch(seq, root, leaf_count, valid_from, valid_until)`
//! (4.25): the launch approver publishes one batch of launch approvals, a
//! Merkle root naming, for cities with no coin, the founder, config, name,
//! ticker and metadata hash each may launch with (3.12).
//!
//! * The sequence number is gap-free (`latest.seq + 1`): a signed publication
//!   applies once and only on the state it was prepared for (two publications
//!   prepared from the same state cannot both land, a replayed one fails), and
//!   nobody can exhaust the numbers by jumping to `u64::MAX`. Numbers of
//!   replaced batches are skipped for good.
//! * The window: no sooner than `BATCH_REVIEW_SECS` (12 hours) after
//!   publication, no later than `BATCH_MAX_LEAD_SECS` (48 hours), lasting at
//!   most `BATCH_MAX_VALIDITY_SECS` (48 hours), inclusive at both ends.
//! * The program cannot see the leaves: the root is the approver's statement,
//!   and each leaf is checked in full when it is used (4.27). An empty list is
//!   not a batch (`leaf_count >= 1`); to stop, the approver clears (4.26).
//! * A batch still in its review window is replaced by the next publication
//!   and never takes force; a batch that has begun moves to `previous`, where
//!   it stays in force until the newer one's `valid_from` (8.6).
//!
//! No account is created, nothing is paid but the transaction fee, and the
//! approver never writes `Launchpad`.

use anchor_lang::prelude::*;

use crate::batch::{apply_publication, batch_window_ok};
use crate::constants::{LAUNCHPAD_SEED, LAUNCH_BATCH_SEED, MAX_BATCH_LEAVES};
use crate::errors::CurveError;
use crate::events::LaunchBatchPublished;
use crate::instructions::now;
use crate::state::{BatchRecord, LaunchBatch, Launchpad};

#[derive(Accounts)]
pub struct PublishLaunchBatch<'info> {
    pub approver: Signer<'info>,

    /// Only `launch_approver` is read.
    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(mut, seeds = [LAUNCH_BATCH_SEED], bump = launch_batch.bump)]
    pub launch_batch: Box<Account<'info, LaunchBatch>>,
}

pub fn handle_publish_launch_batch(
    ctx: Context<PublishLaunchBatch>,
    seq: u64,
    root: [u8; 32],
    leaf_count: u32,
    valid_from: i64,
    valid_until: i64,
) -> Result<()> {
    let approver = ctx.accounts.approver.key();
    let set = ctx.accounts.launchpad.launch_approver;
    // 1. the approver of this moment
    require!(
        set != Pubkey::default() && approver == set,
        CurveError::Unauthorized
    );
    let lb = &mut ctx.accounts.launch_batch;
    // 2. publication not halted
    require!(!lb.halted, CurveError::BatchesHalted);
    // 3. gap-free sequence
    require!(
        lb.latest.seq.checked_add(1) == Some(seq),
        CurveError::BatchSeqMismatch
    );
    // 4. a root
    require!(root != [0u8; 32], CurveError::BadBatchRoot);
    // 5. 1 to 512 leaves
    require!(
        (1..=MAX_BATCH_LEAVES).contains(&leaf_count),
        CurveError::BadLeafCount
    );
    // 6. the window
    let (now, slot) = now()?;
    require!(
        batch_window_ok(now, valid_from, valid_until),
        CurveError::BadBatchWindow
    );
    let record = BatchRecord {
        seq,
        root,
        leaf_count,
        valid_from,
        valid_until,
        published_at: now,
        published_slot: slot,
        publisher: approver,
        cleared: false,
    };
    let (previous_seq, replaced_seq) = apply_publication(lb, record, now);
    emit!(LaunchBatchPublished {
        seq,
        root,
        leaf_count,
        valid_from,
        valid_until,
        publisher: approver,
        published_at: now,
        previous_seq,
        replaced_seq,
    });
    Ok(())
}
