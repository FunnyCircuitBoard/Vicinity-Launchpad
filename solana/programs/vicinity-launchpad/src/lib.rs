//! Vicinity Launchpad: one coin per city, launched through Meteora's audited
//! Dynamic Bonding Curve (DBC), with the city's share of trading fees split
//! between the city's holders and its founder.
//!
//! What it does: keeps the launch gate (the admin approves one founder per
//! city; only that founder can launch, once), accepts only Meteora configs
//! shaped the Vicinity way (every platform fee to the dev wallet constant,
//! immutable metadata, fixed supply, liquidity locked for ever, hostile quote
//! tokens refused), creates each coin by CPI with the coin's own PDA as the DBC
//! pool creator, harvests the creator half of the fees, splits it 50/50 into a
//! holders pot and a founder vault, forwards the pot to the city's
//! `vicinity_rewards` vault, lets the founder claim, and runs the opt-in
//! founder payout (X Money / UsePaid style; off by default).
//!
//! What it does not do: hold, price or move any curve money, run swaps or the
//! graduation (DBC does), hold platform fees (they go from DBC to the dev
//! wallet), mint, burn or freeze coins, or send anything to the admin.
//! LAUNCHPAD-DESIGN.md is the specification.

// Anchor 0.31 macros emit cfg flags that rustc does not know about.
#![allow(unexpected_cfgs)]
// Anchor 0.31's `#[program]` expands to `AccountInfo::realloc`, deprecated in
// the solana-program it pins; nothing in this crate's own code is deprecated.
#![allow(deprecated)]
// `anchor_lang::Result` carries a large error type by design.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

declare_program!(dynamic_bonding_curve);
declare_program!(cp_amm);

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;
pub mod validate;

use instructions::*;

// Localnet / devnet id (throwaway keypair generated on the build machine).
// For mainnet: the owner generates a fresh keypair on his own machine, puts its
// public key here and in Anchor.toml, then `anchor build --verifiable`.
declare_id!("Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7");

#[program]
pub mod vicinity_launchpad {
    use super::*;

    /// One-time: create the global `Launchpad` account. Only the program's
    /// upgrade authority can call it, and the admin must sign.
    pub fn init_launchpad(ctx: Context<InitLaunchpad>) -> Result<()> {
        instructions::init_launchpad::handle_init_launchpad(ctx)
    }

    /// Step one of the admin transfer (zero address cancels).
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::propose_admin::handle_propose_admin(ctx, new_admin)
    }

    /// Step two of the admin transfer, signed by the proposed key.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::accept_admin::handle_accept_admin(ctx)
    }

    /// Set (or clear, with two zero addresses) the payout key and payout wallet.
    pub fn set_payout_config(
        ctx: Context<SetPayoutConfig>,
        payout_authority: Pubkey,
        payout_destination: Pubkey,
    ) -> Result<()> {
        instructions::set_payout_config::handle_set_payout_config(
            ctx,
            payout_authority,
            payout_destination,
        )
    }

    /// Pause or resume launches and payouts. The payout key may only pause payouts.
    pub fn set_pause(
        ctx: Context<SetPause>,
        launches: Option<bool>,
        payouts: Option<bool>,
    ) -> Result<()> {
        instructions::set_pause::handle_set_pause(ctx, launches, payouts)
    }

    /// Allow-list a Meteora DBC config after checking every Vicinity rule.
    pub fn add_launch_config(ctx: Context<AddLaunchConfig>) -> Result<()> {
        instructions::add_launch_config::handle_add_launch_config(ctx)
    }

    /// Switch an allowed config on or off for new approvals and launches.
    pub fn set_launch_config_enabled(
        ctx: Context<SetLaunchConfigEnabled>,
        enabled: bool,
    ) -> Result<()> {
        instructions::set_launch_config_enabled::handle_set_launch_config_enabled(ctx, enabled)
    }

    /// Approve one founder to launch one city's coin under one allowed config.
    pub fn approve_launch(
        ctx: Context<ApproveLaunch>,
        city_id: u64,
        founder: Pubkey,
        name: String,
        symbol: String,
        expires_at: i64,
    ) -> Result<()> {
        instructions::approve_launch::handle_approve_launch(
            ctx, city_id, founder, name, symbol, expires_at,
        )
    }

    /// Close a pending approval; its rent goes back to whoever paid it.
    pub fn revoke_approval(ctx: Context<RevokeApproval>, city_id: u64) -> Result<()> {
        instructions::revoke_approval::handle_revoke_approval(ctx, city_id)
    }

    /// The approved founder launches the city's coin (DBC creates the mint,
    /// the fixed supply, the immutable metadata and the curve).
    pub fn launch(ctx: Context<Launch>, city_id: u64) -> Result<()> {
        instructions::launch::handle_launch(ctx, city_id)
    }

    /// Permissionless: claim the city's half of the curve trading fees and
    /// split it into the holders pot and the founder vault.
    pub fn harvest_curve_fees(ctx: Context<HarvestCurveFees>, city_id: u64) -> Result<()> {
        instructions::harvest_curve_fees::handle_harvest_curve_fees(ctx, city_id)
    }

    /// Permissionless: the same for the graduated DAMM v2 pool position.
    pub fn harvest_pool_fees(ctx: Context<HarvestPoolFees>, city_id: u64) -> Result<()> {
        instructions::harvest_pool_fees::handle_harvest_pool_fees(ctx, city_id)
    }

    /// Permissionless: move the holders pot into the city's checked
    /// `vicinity_rewards` vault.
    pub fn forward_holders_fees(ctx: Context<ForwardHoldersFees>, city_id: u64) -> Result<()> {
        instructions::forward_holders_fees::handle_forward_holders_fees(ctx, city_id)
    }

    /// The founder takes the whole founder vault.
    pub fn claim_founder_fees(ctx: Context<ClaimFounderFees>, city_id: u64) -> Result<()> {
        instructions::claim_founder_fees::handle_claim_founder_fees(ctx, city_id)
    }

    /// The founder hands the seat to a new key; both sign.
    pub fn transfer_founder(ctx: Context<TransferFounder>, city_id: u64) -> Result<()> {
        instructions::transfer_founder::handle_transfer_founder(ctx, city_id)
    }

    /// The founder opts in to payouts into the fixed payout wallet.
    pub fn opt_in_payout(
        ctx: Context<OptInPayout>,
        city_id: u64,
        expected_destination: Pubkey,
        ref_hash: [u8; 32],
    ) -> Result<()> {
        instructions::opt_in_payout::handle_opt_in_payout(
            ctx,
            city_id,
            expected_destination,
            ref_hash,
        )
    }

    /// The founder (current, or the one who signed the opt-in) opts out.
    pub fn revoke_payout_opt_in(ctx: Context<RevokePayoutOptIn>, city_id: u64) -> Result<()> {
        instructions::revoke_payout_opt_in::handle_revoke_payout_opt_in(ctx, city_id)
    }

    /// The payout key sends an opted-in founder's vault to the fixed payout
    /// wallet, at most once per 24 hours per coin.
    pub fn payout_founder_fees(ctx: Context<PayoutFounderFees>, city_id: u64) -> Result<()> {
        instructions::payout_founder_fees::handle_payout_founder_fees(ctx, city_id)
    }
}
