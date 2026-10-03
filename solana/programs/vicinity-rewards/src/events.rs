//! Events. Every state change emits one so the Worker and auditors can rebuild
//! the full history from transaction logs.

use anchor_lang::prelude::*;

use crate::state::RewardModel;

#[event]
pub struct RegistryInitialized {
    pub registry: Pubkey,
    pub admin: Pubkey,
    pub upgrade_authority: Pubkey,
}

#[event]
pub struct AdminProposed {
    pub registry: Pubkey,
    pub admin: Pubkey,
    /// Zero address means a pending transfer was cancelled.
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminAccepted {
    pub registry: Pubkey,
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct CityInitialized {
    pub config: Pubkey,
    pub city_coin_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub founder: Pubkey,
    pub reward_model: RewardModel,
    pub founder_bps: u16,
    pub city_tag: [u8; 32],
}

#[event]
pub struct ConfigLocked {
    pub config: Pubkey,
}

#[event]
pub struct FounderChanged {
    pub config: Pubkey,
    pub old_founder: Pubkey,
    pub new_founder: Pubkey,
}

#[event]
pub struct AuthorityProposed {
    pub config: Pubkey,
    pub authority: Pubkey,
    /// Zero address means a pending transfer was cancelled.
    pub pending_authority: Pubkey,
}

#[event]
pub struct AuthorityAccepted {
    pub config: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct PauseChanged {
    pub config: Pubkey,
    pub paused: bool,
    /// Completed pause seconds so far (grows at every unpause).
    pub paused_total_secs: i64,
}

#[event]
pub struct EpochFunded {
    pub config: Pubkey,
    pub epoch: Pubkey,
    pub index: u64,
    /// True when the money came from the vault's unaccounted balance
    /// (`fund_epoch_from_vault`), false when a funder deposited it (`fund_epoch`).
    pub from_vault: bool,
    pub deposit_amount: u64,
    pub founder_amount: u64,
    pub holders_deposit: u64,
    pub carry_in: u64,
    pub holders_amount: u64,
    pub num_leaves: u32,
    pub merkle_root: [u8; 32],
    pub snapshot_slot: u64,
    pub snapshot_hash: [u8; 32],
    pub funded_at: i64,
    pub claim_deadline: i64,
}

#[event]
pub struct Claimed {
    pub config: Pubkey,
    pub epoch: Pubkey,
    pub index: u64,
    pub claimant: Pubkey,
    pub leaf_index: u32,
    pub amount: u64,
    pub epoch_claimed_amount: u64,
}

#[event]
pub struct EpochSwept {
    pub config: Pubkey,
    pub epoch: Pubkey,
    pub index: u64,
    pub unclaimed_amount: u64,
    pub carry_over: u64,
}

#[event]
pub struct EpochCancelled {
    pub config: Pubkey,
    pub epoch: Pubkey,
    pub index: u64,
    pub returned_amount: u64,
    pub carry_over: u64,
}

#[event]
pub struct ClaimStatusClosed {
    pub config: Pubkey,
    pub epoch: Pubkey,
    pub claimant: Pubkey,
}
