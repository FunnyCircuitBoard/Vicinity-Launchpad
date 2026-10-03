//! `init_registry`: one-time creation of the `Registry` that says who may
//! create city configs.
//!
//! Only the program's upgrade authority can call it (the account that
//! `anchor deploy` leaves in charge of the program), so nobody can race the
//! deployer to the `["registry"]` PDA. It runs once per deployment, right after
//! `anchor deploy` and before the upgrade authority is moved to a multisig or
//! removed. If the program is ever frozen without a registry, `init_city` can
//! never be called: the deployment steps in README.md make this the first
//! transaction after the deploy.
//!
//! The admin it stores must sign too. The registry is created once and
//! `propose_admin` needs the stored admin, so an admin key that nobody
//! controls (a mistyped address, the vault of the wrong multisig) would leave
//! `init_city` unusable for ever with no in-program recovery. Requiring the
//! signature makes that impossible: a key that signed exists and is live. A
//! multisig becomes admin afterwards with `propose_admin` / `accept_admin`,
//! where the accept is the same proof (README.md, mainnet step 5).

use anchor_lang::prelude::*;

use crate::constants::REGISTRY_SEED;
use crate::errors::RewardsError;
use crate::events::RegistryInitialized;
use crate::program::VicinityRewards;
use crate::state::Registry;

#[derive(Accounts)]
pub struct InitRegistry<'info> {
    /// Pays the rent of the registry.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Must be the program's current upgrade authority.
    pub upgrade_authority: Signer<'info>,

    /// Becomes `registry.admin`, the only key that may create city configs.
    /// It must sign, like `authority` in `init_city`: a key that never signed
    /// could be one nobody holds, and nothing in the program could ever
    /// replace it (see the module comment). Usually the deployer itself, which
    /// then hands the role to the multisig with `propose_admin`.
    pub admin: Signer<'info>,

    /// This program's executable account; Anchor checks the address.
    ///
    /// Note on error order: Anchor runs every `init` before the other accounts'
    /// constraints, so while the registry does not exist a wrong signer gets
    /// `NotUpgradeAuthority`, and once it exists (the normal state) anyone,
    /// including a wrong signer, gets the system program's "already in use".
    /// Both refuse; the transaction never changes anything.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ RewardsError::NotUpgradeAuthority)]
    pub program: Program<'info, VicinityRewards>,

    /// The program's ProgramData account (BPF upgradeable loader), which
    /// names the upgrade authority.
    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ RewardsError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,

    #[account(
        init,
        payer = payer,
        space = 8 + Registry::INIT_SPACE,
        seeds = [REGISTRY_SEED],
        bump,
    )]
    pub registry: Account<'info, Registry>,

    pub system_program: Program<'info, System>,
}

pub fn handle_init_registry(ctx: Context<InitRegistry>) -> Result<()> {
    // Unreachable for a signer (nobody can sign for the zero address); kept so
    // the rule is stated where the admin is stored.
    require_keys_neq!(
        ctx.accounts.admin.key(),
        Pubkey::default(),
        RewardsError::InvalidAdmin
    );
    let registry = &mut ctx.accounts.registry;
    registry.admin = ctx.accounts.admin.key();
    registry.pending_admin = Pubkey::default();
    registry.bump = ctx.bumps.registry;
    emit!(RegistryInitialized {
        registry: registry.key(),
        admin: registry.admin,
        upgrade_authority: ctx.accounts.upgrade_authority.key(),
    });
    Ok(())
}
