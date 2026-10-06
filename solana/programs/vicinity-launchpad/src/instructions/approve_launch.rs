//! `approve_launch`: the admin approves one founder to launch one city's coin
//! under one allowed config, with a fixed name and ticker, for at most 30 days.
//!
//! The approval is a PDA only this program can write; the founder's signature
//! on `launch` consumes it. A second approval for the same city fails at `init`
//! until the first is revoked or used, and a city that already has a coin can
//! never be approved again (the `Coin` account is permanent).

use anchor_lang::prelude::*;

use crate::constants::{
    APPROVAL_MAX_SECS, APPROVAL_SEED, COIN_SEED, LAUNCHPAD_SEED, LAUNCH_CONFIG_SEED,
};
use crate::errors::LaunchpadError;
use crate::events::LaunchApproved;
use crate::math::{check_name, check_symbol};
use crate::state::{Approval, LaunchConfig, Launchpad};

#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct ApproveLaunch<'info> {
    /// The admin, who also pays the approval's rent (refunded when it closes).
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ LaunchpadError::Unauthorized,
    )]
    pub launchpad: Account<'info, Launchpad>,

    #[account(
        seeds = [LAUNCH_CONFIG_SEED, launch_config.dbc_config.as_ref()],
        bump = launch_config.bump,
        constraint = launch_config.enabled @ LaunchpadError::LaunchConfigDisabled,
    )]
    pub launch_config: Account<'info, LaunchConfig>,

    #[account(
        init,
        payer = admin,
        space = 8 + Approval::INIT_SPACE,
        seeds = [APPROVAL_SEED, &city_id.to_le_bytes()],
        bump,
    )]
    pub approval: Account<'info, Approval>,

    /// CHECK: the city's `Coin` address; it must not exist yet (no data, still
    /// owned by the System program). Lamports alone are fine.
    #[account(
        seeds = [COIN_SEED, &city_id.to_le_bytes()],
        bump,
        constraint = coin.data_is_empty() && coin.owner == &System::id() @ LaunchpadError::CoinAlreadyLaunched,
    )]
    pub coin: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_approve_launch(
    ctx: Context<ApproveLaunch>,
    city_id: u64,
    founder: Pubkey,
    name: String,
    symbol: String,
    expires_at: i64,
) -> Result<()> {
    require_keys_neq!(founder, Pubkey::default(), LaunchpadError::InvalidAddress);
    check_name(&name)?;
    check_symbol(&symbol)?;
    let now = Clock::get()?.unix_timestamp;
    let max = now
        .checked_add(APPROVAL_MAX_SECS)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        now < expires_at && expires_at <= max,
        LaunchpadError::BadExpiry
    );

    let a = &mut ctx.accounts.approval;
    a.city_id = city_id;
    a.founder = founder;
    a.dbc_config = ctx.accounts.launch_config.dbc_config;
    a.rent_payer = ctx.accounts.admin.key();
    a.name = name;
    a.symbol = symbol;
    a.approved_at = now;
    a.expires_at = expires_at;
    a.bump = ctx.bumps.approval;
    emit!(LaunchApproved {
        city_id,
        founder,
        dbc_config: a.dbc_config,
        name: a.name.clone(),
        symbol: a.symbol.clone(),
        expires_at,
    });
    Ok(())
}
