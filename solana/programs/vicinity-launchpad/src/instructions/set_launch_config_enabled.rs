//! `set_launch_config_enabled`: the admin switches an allowed config on or off
//! for new approvals and launches. Coins already launched are not affected.

use anchor_lang::prelude::*;

use crate::constants::{LAUNCHPAD_SEED, LAUNCH_CONFIG_SEED};
use crate::errors::LaunchpadError;
use crate::events::LaunchConfigEnabled;
use crate::state::{LaunchConfig, Launchpad};

#[derive(Accounts)]
pub struct SetLaunchConfigEnabled<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ LaunchpadError::Unauthorized,
    )]
    pub launchpad: Account<'info, Launchpad>,

    #[account(
        mut,
        seeds = [LAUNCH_CONFIG_SEED, launch_config.dbc_config.as_ref()],
        bump = launch_config.bump,
    )]
    pub launch_config: Account<'info, LaunchConfig>,
}

pub fn handle_set_launch_config_enabled(
    ctx: Context<SetLaunchConfigEnabled>,
    enabled: bool,
) -> Result<()> {
    let lc = &mut ctx.accounts.launch_config;
    lc.enabled = enabled;
    emit!(LaunchConfigEnabled {
        dbc_config: lc.dbc_config,
        enabled,
    });
    Ok(())
}
