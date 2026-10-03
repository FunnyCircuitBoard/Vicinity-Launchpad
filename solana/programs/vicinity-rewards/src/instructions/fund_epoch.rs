//! `fund_epoch`: deposit reward money, pay the founder share, publish the
//! holders' Merkle root and open the claim window.
//!
//! Who is trusted here: the `authority` publishes the root. The program cannot
//! know whether the root matches a fair snapshot; it only guarantees that the
//! root cannot change afterwards, that nobody can claim more than the root
//! says, and that the total of all claims can never exceed what was deposited
//! for holders. `snapshot_slot` and `snapshot_hash` let anyone recompute the
//! root from the published snapshot file and catch a wrong root; `cancel_epoch`
//! exists for that case (while nothing has been claimed).
//!
//! The checks and the bookkeeping are shared with `fund_epoch_from_vault`
//! (`plan_epoch` / `record_epoch` below); the two instructions differ only in
//! where the money comes from and who signs the transfers.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::{
    CITY_SEED, EPOCH_SEED, MAX_CLAIM_WINDOW_SECS, MIN_CLAIM_WINDOW_SECS, VAULT_SEED, ZERO_HASH,
};
use crate::errors::RewardsError;
use crate::events::EpochFunded;
use crate::math::split_amount;
use crate::state::{CityConfig, Epoch, EpochState, RewardModel};

#[derive(Accounts)]
pub struct FundEpoch<'info> {
    /// The publisher of the root. Must be `config.authority`.
    pub authority: Signer<'info>,

    /// Owner of `funder_token_account`; pays the rent of the epoch account and
    /// of the founder's token account if it does not exist yet. May be the
    /// same key as `authority`.
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ RewardsError::Unauthorized,
        has_one = reward_mint,
        has_one = vault,
        has_one = founder,
        seeds = [CITY_SEED, config.city_coin_mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, CityConfig>,

    /// Checked against `config.reward_mint` by `has_one`.
    #[account(mint::token_program = token_program)]
    pub reward_mint: InterfaceAccount<'info, Mint>,

    /// Source of the money. Must hold `reward_mint` and belong to `funder`.
    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = funder,
        token::token_program = token_program,
    )]
    pub funder_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Checked against `config.vault` by `has_one` and re-derived from seeds.
    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump = config.vault_bump,
        token::mint = reward_mint,
        token::authority = config,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: must equal `config.founder` (`has_one`); used only as the owner
    /// of the associated token account below. It must not be an account of
    /// this program (registry, a config, an epoch, a claim status) and not the
    /// epoch created here: nothing could ever sign a transfer out of such a
    /// key's token account, so the share would be lost. `set_founder` only
    /// sees a key, so the check belongs here, before any money moves; the
    /// authority then fixes the founder with `set_founder` and funds again.
    #[account(
        constraint = *founder.owner != crate::ID @ RewardsError::FounderIsProgramAccount,
        constraint = founder.key() != epoch.key() @ RewardsError::FounderIsProgramAccount,
    )]
    pub founder: UncheckedAccount<'info>,

    /// The founder's associated token account for `reward_mint`. The ATA
    /// derivation binds it to (founder, reward_mint, token_program), so a token
    /// account of someone else or of another mint is rejected. This is one of
    /// the places `init_if_needed` is used: the recipient may not have an
    /// account yet and creating it must not be a reason a payout fails.
    #[account(
        init_if_needed,
        payer = funder,
        associated_token::mint = reward_mint,
        associated_token::authority = founder,
        associated_token::token_program = token_program,
    )]
    pub founder_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Plain `init`: the index is `config.epoch_count`, so the same index can
    /// never be funded twice.
    #[account(
        init,
        payer = funder,
        space = 8 + Epoch::INIT_SPACE,
        seeds = [EPOCH_SEED, config.key().as_ref(), &config.epoch_count.to_le_bytes()],
        bump,
    )]
    pub epoch: Account<'info, Epoch>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// The write-once inputs of an epoch, as passed by the caller.
pub struct EpochInputs {
    pub merkle_root: [u8; 32],
    pub num_leaves: u32,
    pub snapshot_slot: u64,
    pub snapshot_hash: [u8; 32],
    pub claim_window_secs: i64,
}

/// Everything `plan_epoch` computed; `record_epoch` writes it. Nothing in
/// between may fail silently, so the numbers are carried instead of recomputed.
pub struct EpochPlan {
    pub amount: u64,
    pub founder_amount: u64,
    pub holders_deposit: u64,
    pub carry_in: u64,
    pub holders_amount: u64,
    pub index: u64,
    pub next_epoch_count: u64,
    pub total_funded: u64,
    pub total_to_founder: u64,
    pub total_to_holders: u64,
    pub now: i64,
    pub claim_deadline: i64,
}

/// All checks of spec section 4.6, in order, with no side effect. `amount` is
/// the money entering the distribution (a funder's deposit or the vault's
/// unaccounted surplus).
pub fn plan_epoch(config: &CityConfig, amount: u64, inputs: &EpochInputs) -> Result<EpochPlan> {
    require!(!config.paused, RewardsError::Paused);
    require!(
        (MIN_CLAIM_WINDOW_SECS..=MAX_CLAIM_WINDOW_SECS).contains(&inputs.claim_window_secs),
        RewardsError::ClaimWindowOutOfRange
    );
    require!(
        amount > 0 || config.carry_over > 0,
        RewardsError::NothingToDistribute
    );

    let (founder_amount, holders_deposit) = split_amount(amount, config.founder_bps)?;
    let carry_in = config.carry_over;
    let holders_amount = holders_deposit
        .checked_add(carry_in)
        .ok_or(RewardsError::MathOverflow)?;

    match config.reward_model {
        RewardModel::Creator => {
            // Everything went to the founder; there is nothing to claim, so
            // there must be no tree. The epoch is still recorded (audit trail).
            require!(
                holders_amount == 0,
                RewardsError::CreatorModelHasHolderFunds
            );
            require!(
                inputs.num_leaves == 0 && inputs.merkle_root == ZERO_HASH,
                RewardsError::CreatorModelHasTree
            );
        }
        RewardModel::Holders | RewardModel::Split => {
            require!(
                inputs.merkle_root != ZERO_HASH,
                RewardsError::MissingMerkleRoot
            );
            require!(inputs.num_leaves > 0, RewardsError::MissingLeaves);
            // PRODUCT DECISION (recommended): a root without a published
            // snapshot cannot be checked by anyone, so it is refused.
            require!(
                inputs.snapshot_hash != ZERO_HASH,
                RewardsError::MissingSnapshotHash
            );
        }
    }

    let now = Clock::get()?.unix_timestamp;
    let claim_deadline = now
        .checked_add(inputs.claim_window_secs)
        .ok_or(RewardsError::MathOverflow)?;

    let index = config.epoch_count;
    let next_epoch_count = index.checked_add(1).ok_or(RewardsError::MathOverflow)?;
    let total_funded = config
        .total_funded
        .checked_add(amount)
        .ok_or(RewardsError::MathOverflow)?;
    let total_to_founder = config
        .total_to_founder
        .checked_add(founder_amount)
        .ok_or(RewardsError::MathOverflow)?;
    let total_to_holders = config
        .total_to_holders
        .checked_add(holders_deposit)
        .ok_or(RewardsError::MathOverflow)?;

    Ok(EpochPlan {
        amount,
        founder_amount,
        holders_deposit,
        carry_in,
        holders_amount,
        index,
        next_epoch_count,
        total_funded,
        total_to_founder,
        total_to_holders,
        now,
        claim_deadline,
    })
}

/// Writes the epoch, updates the config totals, locks the config and emits
/// `EpochFunded`. Called after the transfers succeeded.
pub fn record_epoch(
    config: &mut Account<CityConfig>,
    epoch: &mut Account<Epoch>,
    epoch_bump: u8,
    plan: &EpochPlan,
    inputs: &EpochInputs,
    from_vault: bool,
) -> Result<()> {
    let config_key = config.key();

    epoch.config = config_key;
    epoch.index = plan.index;
    epoch.merkle_root = inputs.merkle_root;
    epoch.deposit_amount = plan.amount;
    epoch.founder_amount = plan.founder_amount;
    epoch.holders_amount = plan.holders_amount;
    epoch.claimed_amount = 0;
    epoch.num_leaves = inputs.num_leaves;
    epoch.snapshot_slot = inputs.snapshot_slot;
    epoch.snapshot_hash = inputs.snapshot_hash;
    epoch.funded_at = plan.now;
    epoch.claim_deadline = plan.claim_deadline;
    // Funding while paused is refused, so no pause is running here.
    epoch.pause_secs_at_funding = config.paused_total_secs;
    epoch.state = EpochState::Open;
    epoch.bump = epoch_bump;
    let epoch_key = epoch.key();

    config.epoch_count = plan.next_epoch_count;
    config.carry_over = 0;
    // Money has moved under this model and split: they are permanent now.
    config.locked = true;
    config.total_funded = plan.total_funded;
    config.total_to_founder = plan.total_to_founder;
    config.total_to_holders = plan.total_to_holders;

    emit!(EpochFunded {
        config: config_key,
        epoch: epoch_key,
        index: plan.index,
        from_vault,
        deposit_amount: plan.amount,
        founder_amount: plan.founder_amount,
        holders_deposit: plan.holders_deposit,
        carry_in: plan.carry_in,
        holders_amount: plan.holders_amount,
        num_leaves: inputs.num_leaves,
        merkle_root: inputs.merkle_root,
        snapshot_slot: inputs.snapshot_slot,
        snapshot_hash: inputs.snapshot_hash,
        funded_at: plan.now,
        claim_deadline: plan.claim_deadline,
    });
    Ok(())
}

pub fn handle_fund_epoch(
    ctx: Context<FundEpoch>,
    amount: u64,
    merkle_root: [u8; 32],
    num_leaves: u32,
    snapshot_slot: u64,
    snapshot_hash: [u8; 32],
    claim_window_secs: i64,
) -> Result<()> {
    let inputs = EpochInputs {
        merkle_root,
        num_leaves,
        snapshot_slot,
        snapshot_hash,
        claim_window_secs,
    };
    // ---- checks (read only) ---------------------------------------------
    let plan = plan_epoch(&ctx.accounts.config, amount, &inputs)?;
    let decimals = ctx.accounts.reward_mint.decimals;

    // ---- transfers (funder signs both) ----------------------------------
    if plan.founder_amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.funder_token_account.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.founder_token_account.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            plan.founder_amount,
            decimals,
        )?;
    }
    if plan.holders_deposit > 0 {
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.funder_token_account.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            plan.holders_deposit,
            decimals,
        )?;
    }

    // ---- state ----------------------------------------------------------
    record_epoch(
        &mut ctx.accounts.config,
        &mut ctx.accounts.epoch,
        ctx.bumps.epoch,
        &plan,
        &inputs,
        false,
    )
}
