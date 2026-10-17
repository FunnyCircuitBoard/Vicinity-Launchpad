//! `approve_launch(city_id, founder, config_id, name, symbol, meta_hash,
//! expires_at)` (4.8): the admin approves one founder to launch one city's coin
//! under one enabled config, with the SHA-256 of the metadata JSON the website
//! will serve (3.10).
//!
//! R1 across both programs (8.5, M16): the city must have no `Coin` here, the
//! ticker no `TickerLock`, and the old `vicinity_launchpad` program no `Coin`
//! and no `Approval` for the city, with its launches paused and its admin this
//! program's admin with no admin transfer pending (GOV-1), so that only the
//! same multisig could ever reopen it. The same legacy checks run again in
//! `launch`.
//!
//! The founder is never `FEE_RECIPIENT`, the guardian or the payout key (the
//! founder seat receives money; R2-DIFF-1, SPEC-1); `launch` checks the
//! signing founder again.
//!
//! A second approval for the same city fails at `init` until the first is used
//! or revoked. A symbol longer than 32 bytes fails the ticker seed derivation
//! before `check_symbol` (still refused).

use anchor_lang::prelude::*;

use crate::constants::{
    APPROVAL_MAX_SECS, APPROVAL_SEED, COIN_SEED, CONFIG_SEED, LAUNCHPAD_SEED, LEGACY_LAUNCHPAD,
    TICKER_SEED,
};
use crate::errors::CurveError;
use crate::events::LaunchApproved;
use crate::helpers::{
    check_founder_key, check_name, check_symbol, is_empty_system_account, legacy_admin_matches,
    legacy_approval_address, legacy_coin_address, legacy_launches_paused, legacy_launchpad_valid,
};
use crate::instructions::now;
use crate::state::{Approval, LaunchConfig, Launchpad};

#[derive(Accounts)]
#[instruction(city_id: u64, founder: Pubkey, config_id: u16, name: String, symbol: String)]
pub struct ApproveLaunch<'info> {
    /// Pays the approval rent (refunded on close to `rent_payer = admin`).
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ CurveError::Unauthorized,
    )]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(
        seeds = [CONFIG_SEED, &config_id.to_le_bytes()],
        bump = config.bump,
        constraint = config.enabled @ CurveError::ConfigDisabled,
    )]
    pub config: Box<Account<'info, LaunchConfig>>,

    #[account(
        init,
        payer = admin,
        space = 8 + Approval::INIT_SPACE,
        seeds = [APPROVAL_SEED, &city_id.to_le_bytes()],
        bump,
    )]
    pub approval: Box<Account<'info, Approval>>,

    /// CHECK: this program's `Coin` PDA for the city; must not exist yet.
    #[account(
        seeds = [COIN_SEED, &city_id.to_le_bytes()],
        bump,
        constraint = is_empty_system_account(&coin) @ CurveError::CoinAlreadyLaunched,
    )]
    pub coin: UncheckedAccount<'info>,

    /// CHECK: the ticker's `TickerLock` PDA; must not exist yet.
    #[account(
        seeds = [TICKER_SEED, symbol.as_bytes()],
        bump,
        constraint = is_empty_system_account(&ticker_lock) @ CurveError::TickerTaken,
    )]
    pub ticker_lock: UncheckedAccount<'info>,

    /// CHECK: the old program's `Coin` PDA for the city; must be empty.
    #[account(
        constraint = legacy_coin.key() == legacy_coin_address(city_id) @ CurveError::InvalidAddress,
        constraint = is_empty_system_account(&legacy_coin) @ CurveError::LegacyCoinExists,
    )]
    pub legacy_coin: UncheckedAccount<'info>,

    /// CHECK: the old program's `Approval` PDA for the city; must be empty.
    #[account(
        constraint = legacy_approval.key() == legacy_approval_address(city_id)
            @ CurveError::InvalidAddress,
        constraint = is_empty_system_account(&legacy_approval)
            @ CurveError::LegacyApprovalExists,
    )]
    pub legacy_approval: UncheckedAccount<'info>,

    /// CHECK: the old program's `Launchpad` (address compiled per cluster),
    /// read by hand: owner, size and discriminator, then `launches_paused`,
    /// then its `admin` (this program's admin) and `pending_admin` (zero).
    #[account(
        constraint = legacy_launchpad.key() == LEGACY_LAUNCHPAD @ CurveError::InvalidAddress,
        constraint = legacy_launchpad_valid(&legacy_launchpad) @ CurveError::InvalidAddress,
        constraint = legacy_launches_paused(&legacy_launchpad) @ CurveError::LegacyLaunchesOpen,
        constraint = legacy_admin_matches(&legacy_launchpad, &launchpad.admin)
            @ CurveError::LegacyAdminMismatch,
    )]
    pub legacy_launchpad: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_approve_launch(
    ctx: Context<ApproveLaunch>,
    city_id: u64,
    founder: Pubkey,
    config_id: u16,
    name: String,
    symbol: String,
    meta_hash: [u8; 32],
    expires_at: i64,
) -> Result<()> {
    require!(city_id >= 1, CurveError::BadCityId);
    let lp = &ctx.accounts.launchpad;
    check_founder_key(&founder, &lp.guardian, &lp.payout_authority)?;
    check_name(&name)?;
    check_symbol(&symbol)?;
    require!(meta_hash != [0u8; 32], CurveError::BadMetaHash);
    let (now, _) = now()?;
    let latest = now
        .checked_add(APPROVAL_MAX_SECS)
        .ok_or(CurveError::BadExpiry)?;
    require!(
        now < expires_at && expires_at <= latest,
        CurveError::BadExpiry
    );

    let a = &mut ctx.accounts.approval;
    a.city_id = city_id;
    a.founder = founder;
    a.config_id = config_id;
    a.rent_payer = ctx.accounts.admin.key();
    a.meta_hash = meta_hash;
    a.name = name.clone();
    a.symbol = symbol.clone();
    a.approved_at = now;
    a.expires_at = expires_at;
    a.bump = ctx.bumps.approval;
    emit!(LaunchApproved {
        city_id,
        founder,
        config_id,
        name,
        symbol,
        meta_hash,
        expires_at,
    });
    Ok(())
}
