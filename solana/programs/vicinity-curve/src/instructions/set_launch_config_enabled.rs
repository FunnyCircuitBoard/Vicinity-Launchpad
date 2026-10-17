//! `set_launch_config_enabled(enabled)` (4.7): the admin switches a config on
//! or off for future approvals and launches. Live coins never read their
//! config again, so this cannot change any coin.

use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, LAUNCHPAD_SEED};
use crate::errors::CurveError;
use crate::events::ConfigEnabled;
use crate::state::{LaunchConfig, Launchpad};

#[derive(Accounts)]
pub struct SetLaunchConfigEnabled<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ CurveError::Unauthorized,
    )]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(
        mut,
        seeds = [CONFIG_SEED, &config.config_id.to_le_bytes()],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, LaunchConfig>>,
}

pub fn handle_set_launch_config_enabled(
    ctx: Context<SetLaunchConfigEnabled>,
    enabled: bool,
) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.enabled = enabled;
    emit!(ConfigEnabled {
        config_id: c.config_id,
        enabled,
    });
    Ok(())
}
