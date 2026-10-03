//! Vicinity Rewards: per city coin reward vault and Merkle claim distributor.
//!
//! What it does, per city coin: records the founder's reward model (Creator /
//! Holders / Split) permanently, receives reward money, pays the founder's
//! share, lets qualifying holders claim their share against published Merkle
//! snapshots, and keeps exact accounting.
//!
//! What it does not do: create tokens, run curves or pools, decide who
//! qualifies. The snapshot and its root are produced off chain by the
//! authority; the chain guarantees that the root is immutable, that every
//! claim is proven against it, that nobody claims twice, and that the total
//! paid never exceeds what was deposited for holders.

// Anchor 0.31 macros emit cfg flags that rustc does not know about.
#![allow(unexpected_cfgs)]
// Anchor 0.31.1's `#[program]` expands to `AccountInfo::realloc`, which the
// solana-program 2.x it pins has deprecated. Nothing in this crate's own code
// is deprecated; the allow only silences that macro expansion.
#![allow(deprecated)]
// `anchor_lang::Result` carries a large error type by design; the lint would
// flag every handler signature.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod merkle;
pub mod state;

use instructions::*;
use state::RewardModel;

// Localnet / devnet id (throwaway keypair generated on the build machine).
// For mainnet: generate a fresh keypair on the owner's machine, put its public
// key here and in Anchor.toml, then `anchor build --verifiable`.
declare_id!("Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi");

#[program]
pub mod vicinity_rewards {
    use super::*;

    /// Create the config and the vault for one city coin.
    pub fn init_city(
        ctx: Context<InitCity>,
        reward_model: RewardModel,
        founder_bps: u16,
        city_tag: [u8; 32],
    ) -> Result<()> {
        instructions::init_city::handle_init_city(ctx, reward_model, founder_bps, city_tag)
    }

    /// Make the economics permanent (also happens at the first `fund_epoch`).
    pub fn lock_config(ctx: Context<LockConfig>) -> Result<()> {
        instructions::lock_config::handle_lock_config(ctx)
    }

    /// Change who receives the founder share from now on.
    pub fn set_founder(ctx: Context<SetFounder>, new_founder: Pubkey) -> Result<()> {
        instructions::set_founder::handle_set_founder(ctx, new_founder)
    }

    /// Step one of the authority transfer (zero address cancels).
    pub fn propose_authority(ctx: Context<ProposeAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::propose_authority::handle_propose_authority(ctx, new_authority)
    }

    /// Step two of the authority transfer, signed by the proposed key.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        instructions::accept_authority::handle_accept_authority(ctx)
    }

    /// Stop funding and claiming for this city.
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::handle_pause(ctx)
    }

    /// Resume funding and claiming.
    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::unpause::handle_unpause(ctx)
    }

    /// Deposit reward money, pay the founder share, publish the root, open the
    /// claim window.
    pub fn fund_epoch(
        ctx: Context<FundEpoch>,
        amount: u64,
        merkle_root: [u8; 32],
        num_leaves: u32,
        snapshot_slot: u64,
        snapshot_hash: [u8; 32],
        claim_window_secs: i64,
    ) -> Result<()> {
        instructions::fund_epoch::handle_fund_epoch(
            ctx,
            amount,
            merkle_root,
            num_leaves,
            snapshot_slot,
            snapshot_hash,
            claim_window_secs,
        )
    }

    /// Prove a leaf and receive its amount from the vault.
    pub fn claim(
        ctx: Context<Claim>,
        epoch_index: u64,
        leaf_index: u32,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::claim::handle_claim(ctx, epoch_index, leaf_index, amount, proof)
    }

    /// After the deadline: roll unclaimed holder money into the next epoch.
    pub fn sweep_epoch(ctx: Context<SweepEpoch>, epoch_index: u64) -> Result<()> {
        instructions::sweep_epoch::handle_sweep_epoch(ctx, epoch_index)
    }

    /// Before any claim: withdraw a wrong root, money returns to carry-over.
    pub fn cancel_epoch(ctx: Context<CancelEpoch>, epoch_index: u64) -> Result<()> {
        instructions::cancel_epoch::handle_cancel_epoch(ctx, epoch_index)
    }

    /// After sweep or cancel: the claimant takes its rent back.
    pub fn close_claim_status(ctx: Context<CloseClaimStatus>, epoch_index: u64) -> Result<()> {
        instructions::close_claim_status::handle_close_claim_status(ctx, epoch_index)
    }
}
