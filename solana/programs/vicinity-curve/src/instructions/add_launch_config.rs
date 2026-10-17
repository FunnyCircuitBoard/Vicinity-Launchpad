//! `add_launch_config(p)` (4.6): the admin adds a split and curve for future
//! coins. Every field except `enabled` is written once, after
//! `validate_config` (V1 to V11, 5.13), and never again. A change of fees or
//! curve for future coins is a new config (R4); live coins never read their
//! config again.

use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, LAUNCHPAD_SEED};
use crate::errors::{config_err, math_err, CurveError};
use crate::events::ConfigAdded;
use crate::instructions::now;
use crate::state::{LaunchConfig, Launchpad};

/// The arguments of `add_launch_config` (4.6): what `validate_config` checks.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfigParams {
    pub liquidity_bps: u16,
    pub platform_bps: u16,
    pub founder_bps: u16,
    pub holders_bps: u16,
    pub buyback_bps: u16,
    pub virtual_sol: u64,
    pub virtual_tokens: u64,
    pub curve_supply: u64,
    pub pool_supply: u64,
    pub graduation_sol: u64,
    pub launch_fee_lamports: u64,
}

impl From<ConfigParams> for vicinity_curve_math::ConfigParams {
    fn from(p: ConfigParams) -> Self {
        vicinity_curve_math::ConfigParams {
            liquidity_bps: p.liquidity_bps,
            platform_bps: p.platform_bps,
            founder_bps: p.founder_bps,
            holders_bps: p.holders_bps,
            buyback_bps: p.buyback_bps,
            virtual_sol: p.virtual_sol,
            virtual_tokens: p.virtual_tokens,
            curve_supply: p.curve_supply,
            pool_supply: p.pool_supply,
            graduation_sol: p.graduation_sol,
            launch_fee_lamports: p.launch_fee_lamports,
        }
    }
}

#[derive(Accounts)]
pub struct AddLaunchConfig<'info> {
    pub admin: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ CurveError::Unauthorized,
    )]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(
        init,
        payer = payer,
        space = 8 + LaunchConfig::INIT_SPACE,
        seeds = [CONFIG_SEED, &launchpad.next_config_id.to_le_bytes()],
        bump,
    )]
    pub config: Box<Account<'info, LaunchConfig>>,

    pub system_program: Program<'info, System>,
}

pub fn handle_add_launch_config(ctx: Context<AddLaunchConfig>, p: ConfigParams) -> Result<()> {
    let params: vicinity_curve_math::ConfigParams = p.into();
    vicinity_curve_math::validate_config(&params).map_err(config_err)?;
    let lp = &mut ctx.accounts.launchpad;
    require!(lp.next_config_id < u16::MAX, CurveError::ConfigCount);
    // `total_fee_bps` is the sum of the five shares, from the math crate.
    let terms = vicinity_curve_math::Terms::from_params(&params).map_err(math_err)?;
    let (timestamp, _) = now()?;

    let config_id = lp.next_config_id;
    let c = &mut ctx.accounts.config;
    c.config_id = config_id;
    c.enabled = true;
    c.bump = ctx.bumps.config;
    c.liquidity_bps = terms.liquidity_bps;
    c.platform_bps = terms.platform_bps;
    c.founder_bps = terms.founder_bps;
    c.holders_bps = terms.holders_bps;
    c.buyback_bps = terms.buyback_bps;
    c.total_fee_bps = terms.total_fee_bps;
    c.virtual_sol = terms.virtual_sol;
    c.virtual_tokens = terms.virtual_tokens;
    c.curve_supply = terms.curve_supply;
    c.pool_supply = terms.pool_supply;
    c.graduation_sol = terms.graduation_sol;
    c.launch_fee_lamports = params.launch_fee_lamports;
    c.created_at = timestamp;
    c._reserved = [0; 64];
    lp.next_config_id = config_id.checked_add(1).ok_or(CurveError::ConfigCount)?;

    emit!(ConfigAdded {
        config_id,
        liquidity_bps: c.liquidity_bps,
        platform_bps: c.platform_bps,
        founder_bps: c.founder_bps,
        holders_bps: c.holders_bps,
        buyback_bps: c.buyback_bps,
        total_fee_bps: c.total_fee_bps,
        virtual_sol: c.virtual_sol,
        virtual_tokens: c.virtual_tokens,
        curve_supply: c.curve_supply,
        pool_supply: c.pool_supply,
        graduation_sol: c.graduation_sol,
        launch_fee_lamports: c.launch_fee_lamports,
        enabled: true,
        created_at: timestamp,
    });
    Ok(())
}
