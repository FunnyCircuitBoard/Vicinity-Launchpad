//! Events (VICINITY-CURVE-DESIGN.md 4.21).
//!
//! Every instruction that moves lamports or tokens emits with `emit_cpi!`: a
//! self-CPI signed by the `["__event_authority"]` PDA, which cannot be
//! truncated like a log; indexers accept it only from an inner instruction of
//! this program signed by that PDA. Settings instructions emit with `emit!`.
//! Every figure in every event is also a counter or a field of an account, so
//! an indexer can reconcile from state.

use anchor_lang::prelude::*;

// ---- event CPI (money and tokens) ----

/// `launch` (4.10).
#[event]
pub struct CoinLaunched {
    pub city_id: u64,
    pub founder: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub config_id: u16,
    pub name: String,
    pub symbol: String,
    /// `METADATA_URI_PREFIX + mint + ".json"`.
    pub uri: String,
    /// SHA-256 of the metadata JSON the website serves at `uri` (3.10).
    pub meta_hash: [u8; 32],
    /// `COIN_SUPPLY`, minted once.
    pub supply_minted: u64,
    /// `COIN_SUPPLY - curve_supply - pool_supply`, burned in the same
    /// instruction.
    pub dust_burned: u64,
    pub curve_supply: u64,
    pub pool_supply: u64,
    pub graduation_sol: u64,
    pub virtual_sol: u64,
    pub virtual_tokens: u64,
    pub liquidity_bps: u16,
    pub platform_bps: u16,
    pub founder_bps: u16,
    pub holders_bps: u16,
    pub buyback_bps: u16,
    pub total_fee_bps: u16,
    /// Lamports paid to `FEE_RECIPIENT` in this instruction.
    pub launch_fee: u64,
    pub slot: u64,
    pub timestamp: i64,
}

/// Every `buy` and `sell` (4.11, 4.12).
#[event]
pub struct Trade {
    pub city_id: u64,
    pub mint: Pubkey,
    pub user: Pubkey,
    pub is_buy: bool,
    /// Phase the trade executed in (0 Curve, 1 Pool); a graduating buy
    /// executes in phase 0.
    pub phase: u8,
    /// Buy: lamports offered (`sol_in`). Sell: 0.
    pub sol_in: u64,
    /// Buy: lamports charged. Sell: gross lamports released before the fee.
    pub sol_amount: u64,
    /// Buy: lamports into the curve or pool. Sell: lamports paid to the user.
    pub sol_net: u64,
    /// Raw coins bought or sold.
    pub token_amount: u64,
    pub fee: u64,
    pub fee_liquidity: u64,
    pub fee_platform: u64,
    pub fee_founder: u64,
    pub fee_holders: u64,
    pub fee_buyback: u64,
    /// Lamports moved from `liquidity_pending` into `pool_sol` (0 on the curve).
    pub liquidity_dripped: u64,
    /// `sol_amount < sol_in` (only the buy that completes the curve).
    pub partial: bool,
    /// This buy completed the curve (a `Graduated` event follows).
    pub graduated: bool,
    /// Virtual reserves of the market after the trade: curve
    /// `(x0 + curve_sol, y0 - tokens_sold)`, pool `(pool_sol, pool_tokens)`.
    pub virtual_sol_after: u64,
    pub virtual_tokens_after: u64,
    pub tokens_sold: u64,
    pub curve_sol: u64,
    pub pool_sol: u64,
    pub pool_tokens: u64,
    pub liquidity_pending: u64,
    /// +1 per trade, gap-free per coin.
    pub trade_seq: u64,
    pub slot: u64,
    pub timestamp: i64,
}

/// The buy that takes the last curve coin (5.6).
#[event]
pub struct Graduated {
    pub city_id: u64,
    pub mint: Pubkey,
    /// `R`.
    pub pool_sol: u64,
    /// `P`.
    pub pool_tokens: u64,
    /// The curve-phase liquidity set aside for the drip (5.8).
    pub liquidity_pending: u64,
    /// The curve's last virtual reserves, `(x0 + R, y0 - S)`.
    pub last_virtual_sol: u64,
    pub last_virtual_tokens: u64,
    pub slot: u64,
    pub timestamp: i64,
}

/// `buyback_burn` (4.13, 7.1).
#[event]
pub struct BuybackBurned {
    pub city_id: u64,
    pub mint: Pubkey,
    pub phase: u8,
    /// Lamports moved from `buyback_pending` into the reserve.
    pub sol_spent: u64,
    /// Raw coins burned by this run.
    pub tokens_burned: u64,
    /// `floor(depth * t / (25 * D))` at execution.
    pub cap: u64,
    pub buyback_pending_after: u64,
    /// `Coin.tokens_burned` after this run.
    pub tokens_burned_total: u64,
    /// `mint.supply` after the burn.
    pub supply_after: u64,
    pub virtual_sol_after: u64,
    pub virtual_tokens_after: u64,
    pub slot: u64,
    pub timestamp: i64,
}

/// `withdraw_platform_fees` (4.14).
#[event]
pub struct PlatformFeesWithdrawn {
    pub city_id: u64,
    pub amount: u64,
    pub total_withdrawn: u128,
}

/// `forward_holders_fees` (4.15).
#[event]
pub struct HoldersFeesForwarded {
    pub city_id: u64,
    pub amount: u64,
    pub rewards_vault: Pubkey,
    pub total_forwarded: u128,
}

/// `claim_founder_fees` (4.16).
#[event]
pub struct FounderFeesClaimed {
    pub city_id: u64,
    pub founder: Pubkey,
    pub amount: u64,
    pub total_claimed: u128,
}

/// `payout_founder_fees` (4.20).
#[event]
pub struct FounderPaidOut {
    pub city_id: u64,
    pub founder: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub seq: u64,
    pub ref_hash: [u8; 32],
    pub total_paid_out: u128,
}

// ---- emit! (settings) ----

/// `init_launchpad` (4.1).
#[event]
pub struct LaunchpadInitialized {
    pub admin: Pubkey,
    pub upgrade_authority: Pubkey,
    pub guardian: Pubkey,
}

/// `propose_admin` (4.2); a zero `pending_admin` cancels.
#[event]
pub struct AdminProposed {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

/// `accept_admin` (4.3).
#[event]
pub struct AdminChanged {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

/// `set_pause` (4.4): the flags after the change and who changed them.
#[event]
pub struct PauseChanged {
    pub launches_paused: bool,
    pub payouts_paused: bool,
    pub buys_halted: bool,
    pub by: Pubkey,
}

/// `set_guardian` (4.4).
#[event]
pub struct GuardianChanged {
    pub old: Pubkey,
    pub new: Pubkey,
}

/// `set_payout_config` (4.5).
#[event]
pub struct PayoutConfigChanged {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
    pub old_destination: Pubkey,
    pub new_destination: Pubkey,
}

/// `add_launch_config` (4.6): every field of the new config.
#[event]
pub struct ConfigAdded {
    pub config_id: u16,
    pub liquidity_bps: u16,
    pub platform_bps: u16,
    pub founder_bps: u16,
    pub holders_bps: u16,
    pub buyback_bps: u16,
    pub total_fee_bps: u16,
    pub virtual_sol: u64,
    pub virtual_tokens: u64,
    pub curve_supply: u64,
    pub pool_supply: u64,
    pub graduation_sol: u64,
    pub launch_fee_lamports: u64,
    pub enabled: bool,
    pub created_at: i64,
}

/// `set_launch_config_enabled` (4.7).
#[event]
pub struct ConfigEnabled {
    pub config_id: u16,
    pub enabled: bool,
}

/// `approve_launch` (4.8).
#[event]
pub struct LaunchApproved {
    pub city_id: u64,
    pub founder: Pubkey,
    pub config_id: u16,
    pub name: String,
    pub symbol: String,
    pub meta_hash: [u8; 32],
    pub expires_at: i64,
}

/// `revoke_approval` (4.9).
#[event]
pub struct ApprovalRevoked {
    pub city_id: u64,
    pub by: Pubkey,
}

/// `transfer_founder` (4.17).
#[event]
pub struct FounderTransferred {
    pub city_id: u64,
    pub old: Pubkey,
    pub new: Pubkey,
}

/// `opt_in_payout` (4.18).
#[event]
pub struct PayoutOptedIn {
    pub city_id: u64,
    pub founder: Pubkey,
    pub destination: Pubkey,
    pub ref_hash: [u8; 32],
}

/// `revoke_payout_opt_in` (4.19).
#[event]
pub struct PayoutOptInRevoked {
    pub city_id: u64,
    /// The founder who signed the opt-in.
    pub founder: Pubkey,
    pub by: Pubkey,
}
