//! `init_launchpad`: one-time creation of the global `Launchpad` account.
//!
//! Only the program's upgrade authority can call it, so nobody can race the
//! deployer to the `["launchpad"]` PDA. The admin must sign too, so the stored
//! admin is a live key (a mistyped admin could never be replaced). The
//! ProgramData header is parsed by hand (math::program_data_upgrade_authority)
//! instead of with Anchor's `ProgramData` type, which costs about 120 KB.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::LaunchpadError;
use crate::events::LaunchpadInitialized;
use crate::math::program_data_upgrade_authority;
use crate::state::Launchpad;

#[derive(Accounts)]
pub struct InitLaunchpad<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Becomes `launchpad.admin`. Must sign (see the module comment).
    pub admin: Signer<'info>,

    /// Must be the program's current upgrade authority.
    pub upgrade_authority: Signer<'info>,

    /// CHECK: this program's ProgramData account: the address is derived from
    /// this program id under the upgradeable loader and the owner is checked;
    /// the handler reads the upgrade authority from its header.
    #[account(
        owner = bpf_loader_upgradeable::ID @ LaunchpadError::NotUpgradeAuthority,
        constraint = program_data.key() == Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID).0
            @ LaunchpadError::NotUpgradeAuthority,
    )]
    pub program_data: UncheckedAccount<'info>,

    /// CHECK: the `vicinity_rewards` program. It must be executable; its id is
    /// stored for ever, so this catches a typo.
    #[account(constraint = rewards_program.executable @ LaunchpadError::InvalidAddress)]
    pub rewards_program: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Launchpad::INIT_SPACE,
        seeds = [LAUNCHPAD_SEED],
        bump,
    )]
    pub launchpad: Account<'info, Launchpad>,

    pub system_program: Program<'info, System>,
}

pub fn handle_init_launchpad(ctx: Context<InitLaunchpad>) -> Result<()> {
    let data = ctx.accounts.program_data.try_borrow_data()?;
    let authority =
        program_data_upgrade_authority(&data).ok_or(LaunchpadError::NotUpgradeAuthority)?;
    require_keys_eq!(
        authority,
        ctx.accounts.upgrade_authority.key(),
        LaunchpadError::NotUpgradeAuthority
    );
    drop(data);

    let lp = &mut ctx.accounts.launchpad;
    lp.admin = ctx.accounts.admin.key();
    lp.pending_admin = Pubkey::default();
    lp.payout_authority = Pubkey::default();
    lp.payout_destination = Pubkey::default();
    lp.rewards_program = ctx.accounts.rewards_program.key();
    lp.launches_paused = false;
    lp.payouts_paused = false;
    lp.bump = ctx.bumps.launchpad;
    emit!(LaunchpadInitialized {
        launchpad: lp.key(),
        admin: lp.admin,
        rewards_program: lp.rewards_program,
        upgrade_authority: authority,
    });
    Ok(())
}
