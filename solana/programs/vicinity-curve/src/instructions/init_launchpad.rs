//! `init_launchpad(guardian)` (4.1): one-time creation of the global
//! `Launchpad` account.
//!
//! Only the program's upgrade authority can call it, so nobody can race the
//! deployer to the `["launchpad"]` PDA (T64). The admin signs too, so the
//! stored admin is a live key. Neither the admin, the guardian nor the upgrade
//! authority may be `FEE_RECIPIENT` (GOV-2, R2-DIFF-1), which only receives;
//! a later change of the upgrade authority (the loader's `SetAuthority`) is
//! outside the program and a deploy precondition (8.4). The ids of the programs this program talks to
//! are compiled constants (3.2), not arguments. The ProgramData header is
//! parsed by hand (`helpers::program_data_upgrade_authority`).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::CurveError;
use crate::events::LaunchpadInitialized;
use crate::helpers::{check_not_fee_recipient, program_data_upgrade_authority};
use crate::state::Launchpad;

#[derive(Accounts)]
pub struct InitLaunchpad<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Becomes `launchpad.admin`; signs so the stored admin is a live key.
    pub admin: Signer<'info>,

    /// Must be the program's current upgrade authority.
    pub upgrade_authority: Signer<'info>,

    /// CHECK: this program's ProgramData account: owner is the upgradeable
    /// loader and the address is derived from this program id; the handler
    /// reads the upgrade authority from its 45-byte header.
    #[account(
        constraint = *program_data.owner == bpf_loader_upgradeable::ID
            @ CurveError::NotUpgradeAuthority,
        constraint = program_data.key()
            == Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID).0
            @ CurveError::NotUpgradeAuthority,
    )]
    pub program_data: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Launchpad::INIT_SPACE,
        seeds = [LAUNCHPAD_SEED],
        bump,
    )]
    pub launchpad: Box<Account<'info, Launchpad>>,

    pub system_program: Program<'info, System>,
}

pub fn handle_init_launchpad(ctx: Context<InitLaunchpad>, guardian: Pubkey) -> Result<()> {
    let authority = {
        let data = ctx.accounts.program_data.try_borrow_data()?;
        program_data_upgrade_authority(&data)
    };
    require!(
        authority == Some(ctx.accounts.upgrade_authority.key()),
        CurveError::NotUpgradeAuthority
    );
    check_not_fee_recipient(&ctx.accounts.upgrade_authority.key())?;
    check_not_fee_recipient(&ctx.accounts.admin.key())?;
    check_not_fee_recipient(&guardian)?;

    let lp = &mut ctx.accounts.launchpad;
    lp.admin = ctx.accounts.admin.key();
    lp.pending_admin = Pubkey::default();
    lp.payout_authority = Pubkey::default();
    lp.payout_destination = Pubkey::default();
    lp.guardian = guardian;
    lp.launches_paused = false;
    lp.payouts_paused = false;
    lp.buys_halted = false;
    lp.buybacks_halted = false;
    lp.next_config_id = 0;
    lp.bump = ctx.bumps.launchpad;
    lp._reserved = [0; 63];
    emit!(LaunchpadInitialized {
        admin: lp.admin,
        upgrade_authority: ctx.accounts.upgrade_authority.key(),
        guardian,
    });
    Ok(())
}
