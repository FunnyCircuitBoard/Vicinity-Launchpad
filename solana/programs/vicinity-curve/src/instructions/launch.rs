//! `launch(city_id)` (4.10): the approved founder launches the city's coin.
//!
//! The program creates the permanent `Coin` record, the mint PDA
//! `["mint", coin]` (classic SPL Token, 6 decimals, no freeze authority) and
//! the vault PDA `["coin_vault", coin]`, both with the `Coin` PDA as authority,
//! and the permanent `TickerLock`. Then, signed by the `Coin` PDA:
//!
//! 1. the launch fee goes to `FEE_RECIPIENT` (system transfer from `payer`);
//! 2. Metaplex `create_metadata_accounts_v3`: the approved name and symbol,
//!    `uri = METADATA_URI_PREFIX + mint + ".json"`, no creators, collection or
//!    uses, `is_mutable = false`, update authority the `Coin` PDA;
//! 3. `mint_to(vault, COIN_SUPPLY)`, once;
//! 4. `burn(vault, COIN_SUPPLY - S - P)`: R8's leftover 9.1 coins on default
//!    config #0 (O3 (a));
//! 5. `set_authority(mint, MintTokens, None)`: nobody can ever mint again.
//!
//! The terms (split and curve) are copied from the config and frozen forever
//! (R4). The approval closes at exit (rent to its `rent_payer`). R1 across
//! both programs is re-checked here (8.5): no `Coin` and no `Approval` for the
//! city in the old program, its launches paused, and its admin this program's
//! admin with no transfer pending (GOV-1), and so is the `vicinity_rewards`
//! registry's admin (OPS-1). The signing founder is checked
//! again against the settings of this moment: never `FEE_RECIPIENT`, the
//! guardian, the payout key or the launch approver (R2-DIFF-1, SPEC-1, 4.24).
//! No direct lamport move happens in `launch`.
//!
//! Effects 1 to 7 are one function, `launch_coin`, which `launch_from_batch`
//! (4.27) calls too, so the two launch paths cannot drift apart.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;
use anchor_spl::metadata::{create_metadata_accounts_v3, CreateMetadataAccountsV3};
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Burn, Mint, MintTo, SetAuthority, Token, TokenAccount};
use vicinity_curve_math::{launch_dust, validate_config, State, Terms};

use crate::constants::{
    APPROVAL_SEED, COIN_DECIMALS, COIN_LEN, COIN_SEED, COIN_SUPPLY, COIN_VAULT_SEED, CONFIG_SEED,
    FEE_RECIPIENT, LAUNCHPAD_SEED, LEGACY_LAUNCHPAD, METAPLEX_PROGRAM_ID, MINT_SEED,
    REWARDS_REGISTRY, TICKER_SEED,
};
use crate::custody::require_not_halted;
use crate::errors::{config_err, math_err, CurveError};
use crate::events::CoinLaunched;
use crate::helpers::{
    check_founder_key, check_name, check_symbol, is_empty_system_account, legacy_admin_matches,
    legacy_approval_address, legacy_coin_address, legacy_launches_paused, legacy_launchpad_valid,
    metadata_address, metadata_uri, rewards_registry_matches, symbol_bytes,
};
use crate::instructions::{now, with_coin_signer};
use crate::state::{Approval, CurveCoin, LaunchConfig, Launchpad, TickerLock};

#[event_cpi]
#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct Launch<'info> {
    /// Must be `approval.founder`.
    pub founder: Signer<'info>,

    /// Pays every rent, the launch fee and Metaplex's own fee (usually the
    /// founder).
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(
        mut,
        seeds = [APPROVAL_SEED, &city_id.to_le_bytes()],
        bump = approval.bump,
        has_one = rent_payer @ CurveError::InvalidAddress,
        close = rent_payer,
    )]
    pub approval: Box<Account<'info, Approval>>,

    /// CHECK: receives the approval's rent; pinned by `has_one`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,

    #[account(
        seeds = [CONFIG_SEED, &approval.config_id.to_le_bytes()],
        bump = config.bump,
        constraint = config.enabled @ CurveError::ConfigDisabled,
    )]
    pub config: Box<Account<'info, LaunchConfig>>,

    #[account(
        init,
        payer = payer,
        space = 8 + CurveCoin::INIT_SPACE,
        seeds = [COIN_SEED, &city_id.to_le_bytes()],
        bump,
    )]
    pub coin: Box<Account<'info, CurveCoin>>,

    #[account(
        init,
        payer = payer,
        seeds = [MINT_SEED, coin.key().as_ref()],
        bump,
        mint::decimals = COIN_DECIMALS,
        mint::authority = coin,
        mint::token_program = token_program,
    )]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        seeds = [COIN_VAULT_SEED, coin.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = coin,
        token::token_program = token_program,
    )]
    pub coin_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        space = 8 + TickerLock::INIT_SPACE,
        seeds = [TICKER_SEED, approval.symbol.as_bytes()],
        bump,
    )]
    pub ticker_lock: Box<Account<'info, TickerLock>>,

    /// CHECK: the Metaplex metadata PDA of the mint (re-derived here), created
    /// by the Metaplex CPI.
    #[account(
        mut,
        constraint = metadata.key() == metadata_address(&mint.key()) @ CurveError::InvalidAddress,
    )]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: `FEE_RECIPIENT` (compiled constant, R9).
    #[account(
        mut,
        constraint = fee_recipient.key() == FEE_RECIPIENT @ CurveError::InvalidAddress,
    )]
    pub fee_recipient: UncheckedAccount<'info>,

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

    /// CHECK: the old program's `Launchpad`, read by hand (owner, size,
    /// discriminator), whose launches must be paused and whose admin must be
    /// this program's admin with no transfer pending (GOV-1).
    #[account(
        constraint = legacy_launchpad.key() == LEGACY_LAUNCHPAD @ CurveError::InvalidAddress,
        constraint = legacy_launchpad_valid(&legacy_launchpad) @ CurveError::InvalidAddress,
        constraint = legacy_launches_paused(&legacy_launchpad) @ CurveError::LegacyLaunchesOpen,
        constraint = legacy_admin_matches(&legacy_launchpad, &launchpad.admin)
            @ CurveError::LegacyAdminMismatch,
    )]
    pub legacy_launchpad: UncheckedAccount<'info>,

    /// CHECK: `vicinity_rewards`' `Registry` (address compiled per cluster),
    /// read by hand: owner, size and discriminator, its `admin` this
    /// program's admin and its `pending_admin` zero (8.4, OPS-1).
    #[account(
        constraint = rewards_registry.key() == REWARDS_REGISTRY @ CurveError::InvalidAddress,
        constraint = rewards_registry_matches(&rewards_registry, &launchpad.admin)
            @ CurveError::RewardsRegistryAdminMismatch,
    )]
    pub rewards_registry: UncheckedAccount<'info>,

    /// CHECK: the Metaplex Token Metadata program (address pinned).
    #[account(
        constraint = metadata_program.key() == METAPLEX_PROGRAM_ID @ CurveError::InvalidAddress,
    )]
    pub metadata_program: UncheckedAccount<'info>,

    /// Classic SPL Token, never Token-2022 (R3).
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// Required by the Metaplex CPI wrapper.
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_launch(ctx: Context<Launch>, city_id: u64) -> Result<()> {
    require_not_halted()?;
    let a = &ctx.accounts;
    require!(!a.launchpad.launches_paused, CurveError::LaunchesPaused);
    require!(!a.launchpad.buys_halted, CurveError::BuysHalted);
    let (timestamp, slot) = now()?;
    require!(
        timestamp <= a.approval.expires_at,
        CurveError::ApprovalExpired
    );
    require_keys_eq!(
        a.founder.key(),
        a.approval.founder,
        CurveError::WrongFounder
    );
    check_founder_key(
        &a.founder.key(),
        &a.launchpad.guardian,
        &a.launchpad.payout_authority,
        &a.launchpad.launch_approver,
    )?;
    let params = a.config.params();
    validate_config(&params).map_err(config_err)?;
    check_name(&a.approval.name)?;
    check_symbol(&a.approval.symbol)?;

    // Effects 1 to 7 (shared with launch_from_batch, 4.27).
    let bumps = CreatedBumps {
        coin: ctx.bumps.coin,
        mint: ctx.bumps.mint,
        vault: ctx.bumps.coin_vault,
        ticker: ctx.bumps.ticker_lock,
    };
    let what = LaunchWhat {
        city_id,
        founder: a.approval.founder,
        config_id: a.approval.config_id,
        name: a.approval.name.clone(),
        symbol: a.approval.symbol.clone(),
        meta_hash: a.approval.meta_hash,
        params,
        timestamp,
        slot,
    };
    let a = &mut *ctx.accounts;
    let done = launch_coin(
        &LaunchTargets {
            payer: &a.payer,
            fee_recipient: &a.fee_recipient,
            metadata: &a.metadata,
            metadata_program: &a.metadata_program,
            mint: &a.mint,
            coin_vault: &a.coin_vault,
            token_program: &a.token_program,
            system_program: &a.system_program,
            rent: &a.rent,
        },
        &mut a.coin,
        &mut a.ticker_lock,
        &what,
        bumps,
    )?;

    // 8. The approval closes at exit (rent to rent_payer).
    emit_cpi!(coin_launched(&what, &done));
    Ok(())
}

/// The bumps of the accounts a launch creates.
#[derive(Clone, Copy)]
pub struct CreatedBumps {
    pub coin: u8,
    pub mint: u8,
    pub vault: u8,
    pub ticker: u8,
}

/// What is launched: from the `Approval` (4.10) or from the batch leaf the
/// call proved (4.27), and the config's parameters at this moment.
pub struct LaunchWhat {
    pub city_id: u64,
    pub founder: Pubkey,
    pub config_id: u16,
    pub name: String,
    pub symbol: String,
    pub meta_hash: [u8; 32],
    pub params: vicinity_curve_math::ConfigParams,
    pub timestamp: i64,
    pub slot: u64,
}

/// The accounts effects 1 to 7 read or sign with (both launch paths list them
/// with the same constraints).
pub struct LaunchTargets<'a, 'info> {
    pub payer: &'a Signer<'info>,
    pub fee_recipient: &'a UncheckedAccount<'info>,
    pub metadata: &'a UncheckedAccount<'info>,
    pub metadata_program: &'a UncheckedAccount<'info>,
    pub mint: &'a Account<'info, Mint>,
    pub coin_vault: &'a Account<'info, TokenAccount>,
    pub token_program: &'a Program<'info, Token>,
    pub system_program: &'a Program<'info, System>,
    pub rent: &'a Sysvar<'info, Rent>,
}

/// What effects 1 to 7 produced, for `CoinLaunched`.
pub struct LaunchDone {
    pub terms: Terms,
    pub dust: u64,
    pub launch_fee: u64,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub uri: String,
}

/// Effects 1 to 7 of 4.10, in this order, for both launch paths (4.10, 4.27:
/// "through the same function", so the two cannot drift apart). The caller
/// has run every check of its section. No direct lamport move happens here.
pub fn launch_coin<'info>(
    t: &LaunchTargets<'_, 'info>,
    coin: &mut Account<'info, CurveCoin>,
    ticker_lock: &mut Account<'info, TickerLock>,
    what: &LaunchWhat,
    bumps: CreatedBumps,
) -> Result<LaunchDone> {
    let terms = Terms::from_params(&what.params).map_err(math_err)?;
    let dust = launch_dust(&terms).map_err(math_err)?;
    let launch_fee = what.params.launch_fee_lamports;
    let mint_key = t.mint.key();
    let vault_key = t.coin_vault.key();
    let uri = metadata_uri(&mint_key);
    let coin_info = coin.to_account_info();

    // 1. Launch fee: payer -> FEE_RECIPIENT.
    if launch_fee > 0 {
        system_program::transfer(
            CpiContext::new(
                t.system_program.to_account_info(),
                Transfer {
                    from: t.payer.to_account_info(),
                    to: t.fee_recipient.to_account_info(),
                },
            ),
            launch_fee,
        )?;
    }

    // 2. to 5., signed by the Coin PDA.
    with_coin_signer(what.city_id, bumps.coin, |signer| -> Result<()> {
        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                t.metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: t.metadata.to_account_info(),
                    mint: t.mint.to_account_info(),
                    mint_authority: coin_info.clone(),
                    payer: t.payer.to_account_info(),
                    update_authority: coin_info.clone(),
                    system_program: t.system_program.to_account_info(),
                    rent: t.rent.to_account_info(),
                },
                signer,
            ),
            DataV2 {
                name: what.name.clone(),
                symbol: what.symbol.clone(),
                uri: uri.clone(),
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            false, // is_mutable
            true,  // update_authority_is_signer
            None,  // collection_details
        )?;
        token::mint_to(
            CpiContext::new_with_signer(
                t.token_program.to_account_info(),
                MintTo {
                    mint: t.mint.to_account_info(),
                    to: t.coin_vault.to_account_info(),
                    authority: coin_info.clone(),
                },
                signer,
            ),
            COIN_SUPPLY,
        )?;
        if dust > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    t.token_program.to_account_info(),
                    Burn {
                        mint: t.mint.to_account_info(),
                        from: t.coin_vault.to_account_info(),
                        authority: coin_info.clone(),
                    },
                    signer,
                ),
                dust,
            )?;
        }
        token::set_authority(
            CpiContext::new_with_signer(
                t.token_program.to_account_info(),
                SetAuthority {
                    current_authority: coin_info.clone(),
                    account_or_mint: t.mint.to_account_info(),
                },
                signer,
            ),
            AuthorityType::MintTokens,
            None,
        )
    })?;

    // 6. The Coin record: frozen terms, launch state, every other field 0.
    let rent_reserve = Rent::get()?.minimum_balance(COIN_LEN);
    {
        let c = &mut **coin;
        c.layout_version = vicinity_curve_math::constants::COIN_LAYOUT_VERSION;
        c.bump = bumps.coin;
        c.mint_bump = bumps.mint;
        c.vault_bump = bumps.vault;
        c.config_id = what.config_id;
        c.city_id = what.city_id;
        c.mint = mint_key;
        c.vault = vault_key;
        c.founder = what.founder;
        c.symbol = symbol_bytes(&what.symbol);
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
        c.dust_burned = dust;
        // Phase Curve, reserves, buckets and lifetime counters 0,
        // last_buyback_slot = launch_slot (the first buyback waits 150 slots).
        c.apply_state(&State::at_launch(what.slot));
        c.launched_at = what.timestamp;
        c.launch_slot = what.slot;
        c.graduated_at = 0;
        c.graduation_slot = 0;
        c.last_payout_at = 0;
        c.payout_seq = 0;
        c.platform_withdrawn = 0;
        c.founder_claimed = 0;
        c.founder_paid_out = 0;
        c.holders_forwarded = 0;
        c.meta_hash = what.meta_hash;
        // The rent part of the account's lamports (6.5); a pre-funded Coin
        // address keeps the extra lamports as a donation.
        c.rent_reserve = rent_reserve;
        c._reserved = [0; 88];
    }

    // 7. The ticker lock.
    {
        let tl = &mut **ticker_lock;
        tl.city_id = what.city_id;
        tl.mint = mint_key;
        tl.bump = bumps.ticker;
    }
    Ok(LaunchDone {
        terms,
        dust,
        launch_fee,
        mint: mint_key,
        vault: vault_key,
        uri,
    })
}

/// `CoinLaunched` (4.21) of a launch by either path.
pub fn coin_launched(what: &LaunchWhat, done: &LaunchDone) -> CoinLaunched {
    let t = &done.terms;
    CoinLaunched {
        city_id: what.city_id,
        founder: what.founder,
        mint: done.mint,
        vault: done.vault,
        config_id: what.config_id,
        name: what.name.clone(),
        symbol: what.symbol.clone(),
        uri: done.uri.clone(),
        meta_hash: what.meta_hash,
        supply_minted: COIN_SUPPLY,
        dust_burned: done.dust,
        curve_supply: t.curve_supply,
        pool_supply: t.pool_supply,
        graduation_sol: t.graduation_sol,
        virtual_sol: t.virtual_sol,
        virtual_tokens: t.virtual_tokens,
        liquidity_bps: t.liquidity_bps,
        platform_bps: t.platform_bps,
        founder_bps: t.founder_bps,
        holders_bps: t.holders_bps,
        buyback_bps: t.buyback_bps,
        total_fee_bps: t.total_fee_bps,
        launch_fee: done.launch_fee,
        slot: what.slot,
        timestamp: what.timestamp,
    }
}
