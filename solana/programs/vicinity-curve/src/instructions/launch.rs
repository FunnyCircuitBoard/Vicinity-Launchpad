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
//! admin with no transfer pending (GOV-1). No direct lamport move happens in
//! `launch`.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;
use anchor_spl::metadata::{create_metadata_accounts_v3, CreateMetadataAccountsV3};
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Burn, Mint, MintTo, SetAuthority, Token, TokenAccount};
use vicinity_curve_math::{launch_dust, validate_config, State, Terms};

use crate::constants::{
    APPROVAL_SEED, COIN_DECIMALS, COIN_LEN, COIN_SEED, COIN_SUPPLY, COIN_VAULT_SEED, CONFIG_SEED,
    FEE_RECIPIENT, LAUNCHPAD_SEED, LEGACY_LAUNCHPAD, METAPLEX_PROGRAM_ID, MINT_SEED, TICKER_SEED,
};
use crate::custody::require_not_halted;
use crate::errors::{config_err, math_err, CurveError};
use crate::events::CoinLaunched;
use crate::helpers::{
    check_name, check_symbol, is_empty_system_account, legacy_admin_matches,
    legacy_approval_address, legacy_coin_address, legacy_launches_paused, legacy_launchpad_valid,
    metadata_address, metadata_uri, symbol_bytes,
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
    let params = a.config.params();
    validate_config(&params).map_err(config_err)?;
    check_name(&a.approval.name)?;
    check_symbol(&a.approval.symbol)?;

    let terms = Terms::from_params(&params).map_err(math_err)?;
    let dust = launch_dust(&terms).map_err(math_err)?;
    let launch_fee = params.launch_fee_lamports;
    let mint_key = a.mint.key();
    let vault_key = a.coin_vault.key();
    let uri = metadata_uri(&mint_key);
    let coin_bump = ctx.bumps.coin;

    // 1. Launch fee: payer -> FEE_RECIPIENT.
    if launch_fee > 0 {
        system_program::transfer(
            CpiContext::new(
                a.system_program.to_account_info(),
                Transfer {
                    from: a.payer.to_account_info(),
                    to: a.fee_recipient.to_account_info(),
                },
            ),
            launch_fee,
        )?;
    }

    // 2. to 5., signed by the Coin PDA.
    with_coin_signer(city_id, coin_bump, |signer| -> Result<()> {
        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                a.metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: a.metadata.to_account_info(),
                    mint: a.mint.to_account_info(),
                    mint_authority: a.coin.to_account_info(),
                    payer: a.payer.to_account_info(),
                    update_authority: a.coin.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                    rent: a.rent.to_account_info(),
                },
                signer,
            ),
            DataV2 {
                name: a.approval.name.clone(),
                symbol: a.approval.symbol.clone(),
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
                a.token_program.to_account_info(),
                MintTo {
                    mint: a.mint.to_account_info(),
                    to: a.coin_vault.to_account_info(),
                    authority: a.coin.to_account_info(),
                },
                signer,
            ),
            COIN_SUPPLY,
        )?;
        if dust > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    a.token_program.to_account_info(),
                    Burn {
                        mint: a.mint.to_account_info(),
                        from: a.coin_vault.to_account_info(),
                        authority: a.coin.to_account_info(),
                    },
                    signer,
                ),
                dust,
            )?;
        }
        token::set_authority(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                SetAuthority {
                    current_authority: a.coin.to_account_info(),
                    account_or_mint: a.mint.to_account_info(),
                },
                signer,
            ),
            AuthorityType::MintTokens,
            None,
        )
    })?;

    // 6. The Coin record: frozen terms, launch state, every other field 0.
    let founder = a.approval.founder;
    let config_id = a.approval.config_id;
    let meta_hash = a.approval.meta_hash;
    let symbol = symbol_bytes(&a.approval.symbol);
    let mint_bump = ctx.bumps.mint;
    let vault_bump = ctx.bumps.coin_vault;
    let rent_reserve = Rent::get()?.minimum_balance(COIN_LEN);
    {
        let c = &mut ctx.accounts.coin;
        c.layout_version = vicinity_curve_math::constants::COIN_LAYOUT_VERSION;
        c.bump = coin_bump;
        c.mint_bump = mint_bump;
        c.vault_bump = vault_bump;
        c.config_id = config_id;
        c.city_id = city_id;
        c.mint = mint_key;
        c.vault = vault_key;
        c.founder = founder;
        c.symbol = symbol;
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
        c.apply_state(&State::at_launch(slot));
        c.launched_at = timestamp;
        c.launch_slot = slot;
        c.graduated_at = 0;
        c.graduation_slot = 0;
        c.last_payout_at = 0;
        c.payout_seq = 0;
        c.platform_withdrawn = 0;
        c.founder_claimed = 0;
        c.founder_paid_out = 0;
        c.holders_forwarded = 0;
        c.meta_hash = meta_hash;
        // The rent part of the account's lamports (6.5); a pre-funded Coin
        // address keeps the extra lamports as a donation.
        c.rent_reserve = rent_reserve;
        c._reserved = [0; 88];
    }

    // 7. The ticker lock.
    {
        let t = &mut ctx.accounts.ticker_lock;
        t.city_id = city_id;
        t.mint = mint_key;
        t.bump = ctx.bumps.ticker_lock;
    }

    // 8. The approval closes at exit (rent to rent_payer).
    let a = &ctx.accounts;
    emit_cpi!(CoinLaunched {
        city_id,
        founder,
        mint: mint_key,
        vault: vault_key,
        config_id,
        name: a.approval.name.clone(),
        symbol: a.approval.symbol.clone(),
        uri,
        meta_hash,
        supply_minted: COIN_SUPPLY,
        dust_burned: dust,
        curve_supply: terms.curve_supply,
        pool_supply: terms.pool_supply,
        graduation_sol: terms.graduation_sol,
        virtual_sol: terms.virtual_sol,
        virtual_tokens: terms.virtual_tokens,
        liquidity_bps: terms.liquidity_bps,
        platform_bps: terms.platform_bps,
        founder_bps: terms.founder_bps,
        holders_bps: terms.holders_bps,
        buyback_bps: terms.buyback_bps,
        total_fee_bps: terms.total_fee_bps,
        launch_fee,
        slot,
        timestamp,
    });
    Ok(())
}
