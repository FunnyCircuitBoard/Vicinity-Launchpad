//! Account layouts. Sizes come from `InitSpace`; every account is allocated with
//! `8 + T::INIT_SPACE` (8 bytes for the Anchor discriminator).

use anchor_lang::prelude::*;

/// How the reward money of a city coin is divided. Permanent once the config
/// is locked (explicitly, or by the first funded epoch).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RewardModel {
    /// Everything goes to the founder (founder_bps = 10000).
    Creator,
    /// Everything goes to qualifying holders (founder_bps = 0).
    Holders,
    /// A fixed allowed split between founder and holders.
    Split,
}

/// Life cycle of an epoch. `Open` is the only state in which claims are paid.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum EpochState {
    Open,
    Cancelled,
    Swept,
}

/// One per city coin. Seeds: `["city", city_coin_mint]`.
#[account]
#[derive(InitSpace)]
pub struct CityConfig {
    /// Operator key (Vicinity ops; a Squads multisig is recommended). Publishes
    /// epochs, pauses, changes the founder. Cannot change economics after lock
    /// and can never move vault money: there is no withdraw instruction.
    pub authority: Pubkey,
    /// Second step of an authority transfer. Zero address = nothing pending.
    pub pending_authority: Pubkey,
    /// Receives the founder share at every `fund_epoch`.
    pub founder: Pubkey,
    /// The city coin this config belongs to. Identity of the config.
    pub city_coin_mint: Pubkey,
    /// The asset rewards are paid in (for example WSOL or USDC).
    pub reward_mint: Pubkey,
    /// SPL token account for `reward_mint`, owner = this PDA. Seeds `["vault", config]`.
    pub vault: Pubkey,
    /// Permanent after lock.
    pub reward_model: RewardModel,
    /// Founder share in basis points. Permanent after lock.
    pub founder_bps: u16,
    /// Set by `lock_config` or by the first `fund_epoch`. Once true the
    /// economics (model, bps, mints, vault) can never change: no instruction
    /// writes them.
    pub locked: bool,
    /// Blocks `fund_epoch` and `claim`. Sweep and cancel keep working so a
    /// paused city can still be wound down.
    pub paused: bool,
    /// Index of the next epoch.
    pub epoch_count: u64,
    /// Unclaimed holder money from swept or cancelled epochs, rolled into the
    /// next epoch's `holders_amount`.
    pub carry_over: u64,
    /// Lifetime amount deposited through `fund_epoch`.
    pub total_funded: u64,
    /// Lifetime amount paid to founders. Invariant: total_funded == total_to_founder + total_to_holders.
    pub total_to_founder: u64,
    /// Lifetime amount deposited into the vault for holders.
    pub total_to_holders: u64,
    /// Lifetime amount paid out by `claim`. Invariant: total_claimed <= total_to_holders.
    pub total_claimed: u64,
    /// ASCII, zero padded, informational only (for example `us-ny-utica`).
    pub city_tag: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
}

/// One per funded distribution. Seeds: `["epoch", config, index as u64 LE]`.
///
/// `merkle_root`, `holders_amount`, `num_leaves`, `snapshot_*`, the amounts and
/// the deadline are write-once: they are set when the epoch is created and no
/// instruction updates them. Only `claimed_amount` and `state` change.
#[account]
#[derive(InitSpace)]
pub struct Epoch {
    /// The `CityConfig` this epoch belongs to (also bound by the PDA seeds; the
    /// field lets indexers list a city's epochs with a memcmp filter).
    pub config: Pubkey,
    pub index: u64,
    /// Root of the snapshot tree. All zeros for Creator-model epochs.
    pub merkle_root: [u8; 32],
    /// Amount passed to `fund_epoch` (audit trail: founder + holders deposit).
    pub deposit_amount: u64,
    /// Part of `deposit_amount` paid to the founder.
    pub founder_amount: u64,
    /// Distributable to holders in this epoch = holders deposit + carry-over taken.
    pub holders_amount: u64,
    /// Sum of all claims paid from this epoch. Never exceeds `holders_amount`.
    pub claimed_amount: u64,
    pub num_leaves: u32,
    /// Slot at which the holder snapshot was taken.
    pub snapshot_slot: u64,
    /// SHA-256 of the published snapshot file, so anyone can recompute the root.
    pub snapshot_hash: [u8; 32],
    pub funded_at: i64,
    /// Claims are accepted while `now <= claim_deadline`.
    pub claim_deadline: i64,
    pub state: EpochState,
    pub bump: u8,
}

/// Proof that a wallet has claimed from an epoch. Seeds: `["claim", epoch, claimant]`.
///
/// Created with `init` inside `claim`, so a second claim by the same wallet in
/// the same epoch fails at account creation, before any program logic runs.
/// Rent is paid by the claimant and returned by `close_claim_status` once the
/// epoch is finished.
#[account]
#[derive(InitSpace)]
pub struct ClaimStatus {
    pub claimant: Pubkey,
    pub amount: u64,
    pub claimed_at: i64,
    pub bump: u8,
}
