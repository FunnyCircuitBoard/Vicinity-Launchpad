//! Account layouts. Sizes come from `InitSpace`; every account is allocated with
//! `8 + T::INIT_SPACE` (8 bytes for the Anchor discriminator).

use anchor_lang::prelude::*;

/// One per program. Seeds: `["launchpad"]`.
///
/// The dev wallet is not stored: it is the constant `FEE_RECIPIENT`.
#[account]
#[derive(InitSpace)]
pub struct Launchpad {
    /// Approves launches, allow-lists Meteora configs, sets the payout key and
    /// wallet, pauses. Holds no power over any token.
    pub admin: Pubkey,
    /// Second step of an admin transfer. Zero address = nothing pending.
    pub pending_admin: Pubkey,
    /// Key allowed to run opted-in founder payouts. Zero = payouts are off.
    pub payout_authority: Pubkey,
    /// Wallet whose quote-token account receives opted-in payouts. Zero = off.
    pub payout_destination: Pubkey,
    /// The `vicinity_rewards` program id. Set once at init, never changeable.
    pub rewards_program: Pubkey,
    /// Blocks `launch`.
    pub launches_paused: bool,
    /// Blocks `payout_founder_fees`.
    pub payouts_paused: bool,
    pub bump: u8,
}

/// One per allowed Meteora DBC config. Seeds: `["launch_config", dbc_config]`.
///
/// The economic fields are copies of the (immutable) DBC config for display;
/// the program re-validates the DBC config itself at every launch.
#[account]
#[derive(InitSpace)]
pub struct LaunchConfig {
    pub dbc_config: Pubkey,
    pub quote_mint: Pubkey,
    /// Raise target F in quote raw units.
    pub migration_quote_threshold: u64,
    /// DBC fee numerator out of 1,000,000,000.
    pub trade_fee_numerator: u64,
    /// Launch fee in lamports.
    pub pool_creation_fee: u64,
    /// The admin can switch a config off for new approvals and launches.
    pub enabled: bool,
    pub added_at: i64,
    pub bump: u8,
}

/// One per city while an approval is pending. Seeds: `["approval", city_id LE]`.
/// Closed (rent back to `rent_payer`) by `launch` or `revoke_approval`.
#[account]
#[derive(InitSpace)]
pub struct Approval {
    pub city_id: u64,
    /// The only wallet that may launch this city's coin.
    pub founder: Pubkey,
    /// The allowed DBC config (quote token, target, fees) the coin must use.
    pub dbc_config: Pubkey,
    /// Receives this account's rent when it is closed.
    pub rent_payer: Pubkey,
    /// On-chain coin name.
    #[max_len(32)]
    pub name: String,
    /// The city ticker (A-Z0-9).
    #[max_len(10)]
    pub symbol: String,
    pub approved_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

/// One per city, for ever (there is no close instruction). Seeds: `["coin", city_id LE]`.
///
/// This PDA is the DBC pool creator, so the creator half of the trading fee
/// belongs to the city. It signs only: the DBC launch, DBC
/// `claim_creator_trading_fee`, DAMM v2 `claim_position_fee`, and SPL transfers
/// out of its holders pot and founder vault to the destinations each
/// instruction pins.
#[account]
#[derive(InitSpace)]
pub struct Coin {
    pub city_id: u64,
    /// Receives the founder share; changes only by `transfer_founder`.
    pub founder: Pubkey,
    /// The coin mint (created by DBC).
    pub mint: Pubkey,
    pub quote_mint: Pubkey,
    pub dbc_config: Pubkey,
    /// The DBC virtual pool; its `creator` field equals this PDA.
    pub dbc_pool: Pubkey,
    pub launched_at: i64,
    /// Lifetime amount booked into the holders pot by harvests.
    pub holders_accrued: u64,
    /// Lifetime amount moved from the pot to the rewards vault.
    pub holders_forwarded: u64,
    /// Lifetime amount booked into the founder vault by harvests.
    pub founder_accrued: u64,
    /// Lifetime amount claimed by the founder.
    pub founder_claimed: u64,
    /// Lifetime amount sent by opted-in payouts.
    pub founder_paid_out: u64,
    /// Payout counter; never resets, so `(city_id, seq)` is a unique receipt key.
    pub payout_seq: u64,
    /// Unix time of the last payout (24-hour cooldown). Kept here so revoking
    /// and opting in again cannot reset it.
    pub last_payout_at: i64,
    pub bump: u8,
    pub holders_pot_bump: u8,
    pub founder_vault_bump: u8,
}

/// One per coin while the founder is opted in to payouts. Seeds: `["payout_opt_in", coin]`.
#[account]
#[derive(InitSpace)]
pub struct PayoutOptIn {
    pub coin: Pubkey,
    /// Who signed; must still equal `coin.founder` at every payout.
    pub founder: Pubkey,
    /// Copy of `launchpad.payout_destination` when the founder signed. Every
    /// payout must match it AND the current setting, so a settings change can
    /// never redirect this founder's money.
    pub agreed_destination: Pubkey,
    /// SHA-256 of the off-chain reference (partner customer id plus salt).
    /// Never a name, X handle or bank number.
    pub ref_hash: [u8; 32],
    pub opted_in_at: i64,
    pub bump: u8,
}
