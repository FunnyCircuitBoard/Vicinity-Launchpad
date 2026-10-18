//! `launch_from_batch(city_id, batch_seq, config_id, name, symbol, meta_hash,
//! proof)` (4.27): a founder named in the launch batch in force launches the
//! city's coin with no per-launch signature but his own.
//!
//! The program never takes a leaf hash: it builds the leaf of 3.12 from this
//! call's own arguments and its signer (`batch::launch_leaf`) and folds it
//! through `proof` (at most `min(9, depth(leaf_count))` hashes, refused by
//! length before any hashing) to the root of the batch named by `batch_seq`,
//! which must be in force (8.6: `latest`, or `previous` before
//! `latest.valid_from`; not cleared; published by the current approver;
//! `valid_from <= now <= valid_until`). So the founder, city, config, name,
//! ticker and metadata hash are exactly the signed list's.
//!
//! Every check of `approve_launch` (4.8) and `launch` (4.10) runs here at the
//! moment of the launch: the pause and halt flags, the founder key against
//! every role, the config enabled and valid, the name, the ticker and the
//! metadata hash, the old program's `Coin`, `Approval`, pause and admin, the
//! rewards registry's admin, an empty `Coin` and `TickerLock` (`init`). A
//! pending per-city `Approval` for the city wins (`ApprovalPending`). Effects
//! 1 to 7 are `launch::launch_coin`, the same function `launch` calls. No
//! approval closes, no direct lamport move happens, and `LaunchBatch` is not
//! written (launches of different cities never contend on it). One use per
//! leaf: the launch creates the city's permanent `Coin` and the ticker's
//! `TickerLock`.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use vicinity_curve_math::validate_config;

use crate::batch::{batch_in_force, launch_leaf, max_proof_len, verify_proof};
use crate::constants::{
    APPROVAL_SEED, COIN_DECIMALS, COIN_SEED, COIN_VAULT_SEED, CONFIG_SEED, FEE_RECIPIENT,
    LAUNCHPAD_SEED, LAUNCH_BATCH_SEED, LEGACY_LAUNCHPAD, METAPLEX_PROGRAM_ID, MINT_SEED,
    REWARDS_REGISTRY, TICKER_SEED,
};
use crate::custody::require_not_halted;
use crate::errors::{config_err, CurveError};
use crate::events::LaunchedFromBatch;
use crate::helpers::{
    check_founder_key, check_name, check_symbol, is_empty_system_account, legacy_admin_matches,
    legacy_approval_address, legacy_coin_address, legacy_launches_paused, legacy_launchpad_valid,
    metadata_address, rewards_registry_matches,
};
use crate::instructions::launch::{
    coin_launched, launch_coin, CreatedBumps, LaunchTargets, LaunchWhat,
};
use crate::instructions::now;
use crate::state::{CurveCoin, LaunchBatch, LaunchConfig, Launchpad, TickerLock};

#[event_cpi]
#[derive(Accounts)]
#[instruction(city_id: u64, batch_seq: u64, config_id: u16, name: String, symbol: String)]
pub struct LaunchFromBatch<'info> {
    /// The leaf's founder: the leaf is built with this key.
    pub founder: Signer<'info>,

    /// Pays every rent, the launch fee and Metaplex's own fee (usually the
    /// founder).
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    /// Read only: a batch launch never writes `LaunchBatch`.
    #[account(seeds = [LAUNCH_BATCH_SEED], bump = launch_batch.bump)]
    pub launch_batch: Box<Account<'info, LaunchBatch>>,

    /// CHECK: this program's `Approval` PDA for the city; must be empty: a
    /// pending per-city approval wins over any batch (4.8, 4.27).
    #[account(
        seeds = [APPROVAL_SEED, &city_id.to_le_bytes()],
        bump,
        constraint = is_empty_system_account(&approval) @ CurveError::ApprovalPending,
    )]
    pub approval: UncheckedAccount<'info>,

    #[account(
        seeds = [CONFIG_SEED, &config_id.to_le_bytes()],
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
        seeds = [TICKER_SEED, symbol.as_bytes()],
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

#[allow(clippy::too_many_arguments)]
pub fn handle_launch_from_batch(
    ctx: Context<LaunchFromBatch>,
    city_id: u64,
    batch_seq: u64,
    config_id: u16,
    name: String,
    symbol: String,
    meta_hash: [u8; 32],
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    require_not_halted()?;
    let a = &ctx.accounts;
    let lp = &a.launchpad;
    // 1. the pause and halt flags
    require!(!lp.launches_paused, CurveError::LaunchesPaused);
    require!(!lp.buys_halted, CurveError::BuysHalted);
    // 2. the batch path on and not halted
    require!(
        lp.launch_approver != Pubkey::default(),
        CurveError::LaunchApproverNotSet
    );
    require!(!a.launch_batch.halted, CurveError::BatchesHalted);
    // 3. the named batch in force (8.6)
    let (timestamp, slot) = now()?;
    let b = batch_in_force(&a.launch_batch, &lp.launch_approver, batch_seq, timestamp)?;
    // 4. to 7. every rule of approve_launch and launch, at this moment
    require!(city_id >= 1, CurveError::BadCityId);
    let founder = a.founder.key();
    check_founder_key(
        &founder,
        &lp.guardian,
        &lp.payout_authority,
        &lp.launch_approver,
    )?;
    let params = a.config.params();
    validate_config(&params).map_err(config_err)?;
    check_name(&name)?;
    check_symbol(&symbol)?;
    require!(meta_hash != [0u8; 32], CurveError::BadMetaHash);
    // 8. the proof's length, before any hashing
    require!(
        proof.len() <= max_proof_len(b.leaf_count),
        CurveError::ProofTooLong
    );
    // 9. the leaf from this call's arguments and signer, folded to the root
    let leaf = launch_leaf(
        &crate::ID,
        batch_seq,
        city_id,
        &founder,
        config_id,
        &meta_hash,
        &name,
        &symbol,
    )?;
    require!(
        verify_proof(&proof, &b.root, &leaf),
        CurveError::InvalidProof
    );
    let root = b.root;

    // Effects 1 to 7, through the same function as launch (4.10).
    let bumps = CreatedBumps {
        coin: ctx.bumps.coin,
        mint: ctx.bumps.mint,
        vault: ctx.bumps.coin_vault,
        ticker: ctx.bumps.ticker_lock,
    };
    let what = LaunchWhat {
        city_id,
        founder,
        config_id,
        name,
        symbol,
        meta_hash,
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

    emit_cpi!(coin_launched(&what, &done));
    emit_cpi!(LaunchedFromBatch {
        city_id,
        founder,
        mint: done.mint,
        config_id,
        batch_seq,
        root,
        leaf,
    });
    Ok(())
}
