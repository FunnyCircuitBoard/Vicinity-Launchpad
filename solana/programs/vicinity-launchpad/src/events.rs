//! Events. Every state change emits one; instructions that find nothing to
//! move emit nothing. Indexers must also reconcile from account state, because
//! logs can be cut short.

use anchor_lang::prelude::*;

#[event]
pub struct LaunchpadInitialized {
    pub launchpad: Pubkey,
    pub admin: Pubkey,
    pub rewards_program: Pubkey,
    pub upgrade_authority: Pubkey,
}

#[event]
pub struct AdminProposed {
    pub admin: Pubkey,
    /// Zero address means a pending transfer was cancelled.
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminChanged {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct PayoutConfigChanged {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
    pub old_destination: Pubkey,
    pub new_destination: Pubkey,
}

#[event]
pub struct PauseChanged {
    pub launches_paused: bool,
    pub payouts_paused: bool,
    pub by: Pubkey,
}

#[event]
pub struct LaunchConfigAdded {
    pub dbc_config: Pubkey,
    pub quote_mint: Pubkey,
    pub migration_quote_threshold: u64,
    pub trade_fee_numerator: u64,
    pub pool_creation_fee: u64,
}

#[event]
pub struct LaunchConfigEnabled {
    pub dbc_config: Pubkey,
    pub enabled: bool,
}

#[event]
pub struct LaunchApproved {
    pub city_id: u64,
    pub founder: Pubkey,
    pub dbc_config: Pubkey,
    pub name: String,
    pub symbol: String,
    pub expires_at: i64,
}

#[event]
pub struct ApprovalRevoked {
    pub city_id: u64,
}

#[event]
pub struct CoinLaunched {
    pub city_id: u64,
    pub founder: Pubkey,
    pub mint: Pubkey,
    pub dbc_pool: Pubkey,
    pub dbc_config: Pubkey,
    pub quote_mint: Pubkey,
}

#[event]
pub struct FeesHarvested {
    pub city_id: u64,
    /// 0 = curve (DBC), 1 = graduated pool (DAMM v2).
    pub source: u8,
    pub claimed: u64,
    pub to_holders: u64,
    pub to_founder: u64,
}

#[event]
pub struct HoldersFeesForwarded {
    pub city_id: u64,
    pub amount: u64,
    pub rewards_vault: Pubkey,
}

#[event]
pub struct FounderFeesClaimed {
    pub city_id: u64,
    pub founder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct FounderTransferred {
    pub city_id: u64,
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct PayoutOptedIn {
    pub city_id: u64,
    pub founder: Pubkey,
    pub destination: Pubkey,
    pub ref_hash: [u8; 32],
}

#[event]
pub struct PayoutOptInRevoked {
    pub city_id: u64,
    pub founder: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct FounderPaidOut {
    pub city_id: u64,
    pub founder: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub seq: u64,
    pub ref_hash: [u8; 32],
}
