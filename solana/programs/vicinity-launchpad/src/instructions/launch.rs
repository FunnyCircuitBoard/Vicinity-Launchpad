//! `launch`: the approved founder launches the city's coin.
//!
//! The program creates the `Coin` record and its two token accounts, then asks
//! DBC (by CPI, with the `Coin` PDA signing as the pool creator) to create the
//! coin: DBC creates the mint with 6 decimals and no freeze authority, mints
//! exactly 1,000,000,000 coins into its own vault, removes the mint authority,
//! creates Metaplex metadata with `is_mutable = false`, and charges the launch
//! fee to `payer`. The approval is consumed (closed, rent back to its payer),
//! so a city can launch exactly once: the `Coin` account is permanent.
//!
//! The metadata URL is built here from the new mint, so a typo is impossible
//! and nobody can know a coin's URL before the coin exists.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::read_dbc_pool;
use crate::constants::{
    APPROVAL_SEED, COIN_SEED, DBC_POOL_AUTHORITY, FOUNDER_VAULT_SEED, HOLDERS_POT_SEED,
    LAUNCHPAD_SEED, LAUNCH_CONFIG_SEED, METAPLEX_PROGRAM_ID,
};
use crate::dynamic_bonding_curve::{
    self, accounts::PoolConfig, cpi::accounts::InitializeVirtualPoolWithSplToken,
    program::DynamicBondingCurve, types::InitializePoolParameters,
};
use crate::errors::LaunchpadError;
use crate::events::CoinLaunched;
use crate::math::metadata_uri;
use crate::state::{Approval, Coin, LaunchConfig, Launchpad};
use crate::validate::{validate_quote_mint, validate_vicinity_config};

#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct Launch<'info> {
    /// Must be the approved founder.
    pub founder: Signer<'info>,

    /// Pays every rent and the launch fee (usually the founder).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// A fresh keypair: the new coin's address. DBC creates the mint.
    #[account(mut)]
    pub base_mint: Signer<'info>,

    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(
        mut,
        seeds = [APPROVAL_SEED, &city_id.to_le_bytes()],
        bump = approval.bump,
        has_one = rent_payer @ LaunchpadError::InvalidAddress,
        close = rent_payer,
    )]
    pub approval: Box<Account<'info, Approval>>,

    /// CHECK: receives the approval's rent; must be `approval.rent_payer`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,

    #[account(
        seeds = [LAUNCH_CONFIG_SEED, approval.dbc_config.as_ref()],
        bump = launch_config.bump,
        constraint = launch_config.enabled @ LaunchpadError::LaunchConfigDisabled,
    )]
    pub launch_config: Box<Account<'info, LaunchConfig>>,

    #[account(
        init,
        payer = payer,
        space = 8 + Coin::INIT_SPACE,
        seeds = [COIN_SEED, &city_id.to_le_bytes()],
        bump,
    )]
    pub coin: Box<Account<'info, Coin>>,

    #[account(
        init,
        payer = payer,
        seeds = [HOLDERS_POT_SEED, coin.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = coin,
    )]
    pub holders_pot: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        seeds = [FOUNDER_VAULT_SEED, coin.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = coin,
    )]
    pub founder_vault: Box<Account<'info, TokenAccount>>,

    /// The allowed Meteora config named by the approval.
    #[account(address = approval.dbc_config @ LaunchpadError::LaunchConfigMismatch)]
    pub dbc_config: AccountLoader<'info, PoolConfig>,

    /// CHECK: DBC's pool authority (address pinned here and checked by DBC).
    #[account(address = DBC_POOL_AUTHORITY @ LaunchpadError::InvalidAddress)]
    pub dbc_pool_authority: UncheckedAccount<'info>,

    /// CHECK: created by DBC (its PDA); checked after the CPI.
    #[account(mut)]
    pub dbc_pool: UncheckedAccount<'info>,

    /// CHECK: created by DBC (its PDA).
    #[account(mut)]
    pub dbc_base_vault: UncheckedAccount<'info>,

    /// CHECK: created by DBC (its PDA).
    #[account(mut)]
    pub dbc_quote_vault: UncheckedAccount<'info>,

    /// CHECK: created by Metaplex through DBC (Metaplex PDA of the mint).
    #[account(mut)]
    pub mint_metadata: UncheckedAccount<'info>,

    /// CHECK: Metaplex Token Metadata program (address pinned).
    #[account(address = METAPLEX_PROGRAM_ID @ LaunchpadError::InvalidAddress)]
    pub metadata_program: UncheckedAccount<'info>,

    /// The config's quote token (classic SPL Token, re-checked below).
    #[account(address = launch_config.quote_mint @ LaunchpadError::LaunchConfigMismatch)]
    pub quote_mint: Box<Account<'info, Mint>>,

    /// CHECK: DBC's event authority PDA (checked by DBC's event CPI).
    pub dbc_event_authority: UncheckedAccount<'info>,

    pub dbc_program: Program<'info, DynamicBondingCurve>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_launch(ctx: Context<Launch>, city_id: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.launchpad.launches_paused, LaunchpadError::LaunchesPaused);
    let now = Clock::get()?.unix_timestamp;
    require!(
        now <= a.approval.expires_at,
        LaunchpadError::ApprovalExpired
    );
    require_keys_eq!(
        a.founder.key(),
        a.approval.founder,
        LaunchpadError::WrongFounder
    );
    // Re-run every config rule, in case a vendor upgrade ever made configs mutable.
    validate_vicinity_config(&*a.dbc_config.load()?)?;
    validate_quote_mint(
        a.quote_mint.to_account_info().owner,
        a.quote_mint.mint_authority.is_some(),
        a.quote_mint.freeze_authority.is_some(),
        a.quote_mint.decimals,
    )?;

    let coin_bump = ctx.bumps.coin;
    let city_bytes = city_id.to_le_bytes();
    let seeds: &[&[u8]] = &[COIN_SEED, &city_bytes, &[coin_bump]];
    dynamic_bonding_curve::cpi::initialize_virtual_pool_with_spl_token(
        CpiContext::new_with_signer(
            a.dbc_program.to_account_info(),
            InitializeVirtualPoolWithSplToken {
                config: a.dbc_config.to_account_info(),
                pool_authority: a.dbc_pool_authority.to_account_info(),
                creator: a.coin.to_account_info(),
                base_mint: a.base_mint.to_account_info(),
                quote_mint: a.quote_mint.to_account_info(),
                pool: a.dbc_pool.to_account_info(),
                base_vault: a.dbc_base_vault.to_account_info(),
                quote_vault: a.dbc_quote_vault.to_account_info(),
                mint_metadata: a.mint_metadata.to_account_info(),
                metadata_program: a.metadata_program.to_account_info(),
                payer: a.payer.to_account_info(),
                token_quote_program: a.token_program.to_account_info(),
                token_program: a.token_program.to_account_info(),
                system_program: a.system_program.to_account_info(),
                event_authority: a.dbc_event_authority.to_account_info(),
                program: a.dbc_program.to_account_info(),
            },
            &[seeds],
        ),
        InitializePoolParameters {
            name: a.approval.name.clone(),
            symbol: a.approval.symbol.clone(),
            uri: metadata_uri(&a.base_mint.key()),
        },
    )?;

    // The pool DBC just created must be this coin's: creator = our PDA, our
    // config, our mint. AccountLoader checks that DBC owns it and its type.
    {
        let pool = read_dbc_pool(&a.dbc_pool)?;
        require!(
            pool.pool_state.creator == a.coin.key()
                && pool.pool_state.config == a.dbc_config.key()
                && pool.pool_state.base_mint == a.base_mint.key(),
            LaunchpadError::PoolCreatorMismatch
        );
    }

    let founder = a.founder.key();
    let mint = a.base_mint.key();
    let dbc_pool = a.dbc_pool.key();
    let dbc_config = a.dbc_config.key();
    let quote_mint = a.quote_mint.key();
    let pot_bump = ctx.bumps.holders_pot;
    let vault_bump = ctx.bumps.founder_vault;
    let coin = &mut ctx.accounts.coin;
    coin.city_id = city_id;
    coin.founder = founder;
    coin.mint = mint;
    coin.quote_mint = quote_mint;
    coin.dbc_config = dbc_config;
    coin.dbc_pool = dbc_pool;
    coin.launched_at = now;
    coin.holders_accrued = 0;
    coin.holders_forwarded = 0;
    coin.founder_accrued = 0;
    coin.founder_claimed = 0;
    coin.founder_paid_out = 0;
    coin.payout_seq = 0;
    coin.last_payout_at = 0;
    coin.bump = coin_bump;
    coin.holders_pot_bump = pot_bump;
    coin.founder_vault_bump = vault_bump;
    emit!(CoinLaunched {
        city_id,
        founder,
        mint,
        dbc_pool,
        dbc_config,
        quote_mint,
    });
    Ok(())
}
