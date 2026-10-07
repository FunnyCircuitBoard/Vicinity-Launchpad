//! `add_launch_config`: the admin allow-lists a Meteora DBC config after the
//! program has checked every Vicinity rule on chain (validate.rs, design 7.2).
//!
//! DBC configs are immutable, so a fee or target change means a new config;
//! each existing coin keeps the config it launched with. The rules run again at
//! every `launch`.

use anchor_lang::prelude::*;
use anchor_spl::token::spl_token::{self, solana_program::program_pack::Pack};

use crate::constants::{LAUNCHPAD_SEED, LAUNCH_CONFIG_SEED};
use crate::dynamic_bonding_curve::accounts::PoolConfig;
use crate::errors::LaunchpadError;
use crate::events::LaunchConfigAdded;
use crate::state::{LaunchConfig, Launchpad};
use crate::validate::{validate_quote_mint, validate_vicinity_config};

#[derive(Accounts)]
pub struct AddLaunchConfig<'info> {
    pub admin: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [LAUNCHPAD_SEED],
        bump = launchpad.bump,
        has_one = admin @ LaunchpadError::Unauthorized,
    )]
    pub launchpad: Account<'info, Launchpad>,

    /// The Meteora config. `AccountLoader` checks that DBC owns it and that its
    /// discriminator is `PoolConfig` (not a pool, not a transfer-hook config).
    pub dbc_config: AccountLoader<'info, PoolConfig>,

    /// CHECK: the config's quote token. Read by hand so that a Token-2022 (or
    /// any non-SPL) mint gets the clear `QuoteMintNotAllowed` error of rule 2.
    pub quote_mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + LaunchConfig::INIT_SPACE,
        seeds = [LAUNCH_CONFIG_SEED, dbc_config.key().as_ref()],
        bump,
    )]
    pub launch_config: Account<'info, LaunchConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handle_add_launch_config(ctx: Context<AddLaunchConfig>) -> Result<()> {
    let cfg = ctx.accounts.dbc_config.load()?;
    let qm = &ctx.accounts.quote_mint;
    require_keys_eq!(
        cfg.quote_mint,
        qm.key(),
        LaunchpadError::LaunchConfigMismatch
    );
    require_keys_eq!(
        *qm.owner,
        spl_token::ID,
        LaunchpadError::QuoteMintNotAllowed
    );
    let mint = spl_token::state::Mint::unpack(&qm.try_borrow_data()?)
        .map_err(|_| LaunchpadError::QuoteMintNotAllowed)?;
    validate_quote_mint(
        qm.owner,
        mint.mint_authority.is_some(),
        mint.freeze_authority.is_some(),
        mint.decimals,
    )?;
    validate_vicinity_config(&cfg)?;

    let lc = &mut ctx.accounts.launch_config;
    lc.dbc_config = ctx.accounts.dbc_config.key();
    lc.quote_mint = cfg.quote_mint;
    lc.migration_quote_threshold = cfg.migration_quote_threshold;
    lc.trade_fee_numerator = cfg.pool_fees.base_fee.cliff_fee_numerator;
    lc.pool_creation_fee = cfg.pool_creation_fee;
    lc.enabled = true;
    lc.added_at = Clock::get()?.unix_timestamp;
    lc.bump = ctx.bumps.launch_config;
    emit!(LaunchConfigAdded {
        dbc_config: lc.dbc_config,
        quote_mint: lc.quote_mint,
        migration_quote_threshold: lc.migration_quote_threshold,
        trade_fee_numerator: lc.trade_fee_numerator,
        pool_creation_fee: lc.pool_creation_fee,
    });
    Ok(())
}
