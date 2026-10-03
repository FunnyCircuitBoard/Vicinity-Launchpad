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
    /// of the associated token account below.
    pub founder: UncheckedAccount<'info>,

    /// The founder's associated token account for `reward_mint`. The ATA
    /// derivation binds it to (founder, reward_mint, token_program), so a token
    /// account of someone else or of another mint is rejected. This is one of
    /// the two places `init_if_needed` is used: the recipient may not have an
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

pub fn handle_fund_epoch(
    ctx: Context<FundEpoch>,
    amount: u64,
    merkle_root: [u8; 32],
    num_leaves: u32,
    snapshot_slot: u64,
    snapshot_hash: [u8; 32],
    claim_window_secs: i64,
) -> Result<()> {
    // ---- checks (read only) ---------------------------------------------
    let config = &ctx.accounts.config;
    require!(!config.paused, RewardsError::Paused);
    require!(
        (MIN_CLAIM_WINDOW_SECS..=MAX_CLAIM_WINDOW_SECS).contains(&claim_window_secs),
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
                num_leaves == 0 && merkle_root == ZERO_HASH,
                RewardsError::CreatorModelHasTree
            );
        }
        RewardModel::Holders | RewardModel::Split => {
            require!(merkle_root != ZERO_HASH, RewardsError::MissingMerkleRoot);
            require!(num_leaves > 0, RewardsError::MissingLeaves);
        }
    }

    let now = Clock::get()?.unix_timestamp;
    let claim_deadline = now
        .checked_add(claim_window_secs)
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
    let config_key = config.key();
    let decimals = ctx.accounts.reward_mint.decimals;

    // ---- transfers (funder signs both) ----------------------------------
    if founder_amount > 0 {
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
            founder_amount,
            decimals,
        )?;
    }
    if holders_deposit > 0 {
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
            holders_deposit,
            decimals,
        )?;
    }

    // ---- state ----------------------------------------------------------
    let epoch = &mut ctx.accounts.epoch;
    epoch.config = config_key;
    epoch.index = index;
    epoch.merkle_root = merkle_root;
    epoch.deposit_amount = amount;
    epoch.founder_amount = founder_amount;
    epoch.holders_amount = holders_amount;
    epoch.claimed_amount = 0;
    epoch.num_leaves = num_leaves;
    epoch.snapshot_slot = snapshot_slot;
    epoch.snapshot_hash = snapshot_hash;
    epoch.funded_at = now;
    epoch.claim_deadline = claim_deadline;
    epoch.state = EpochState::Open;
    epoch.bump = ctx.bumps.epoch;
    let epoch_key = epoch.key();

    let config = &mut ctx.accounts.config;
    config.epoch_count = next_epoch_count;
    config.carry_over = 0;
    // Money has moved under this model and split: they are permanent now.
    config.locked = true;
    config.total_funded = total_funded;
    config.total_to_founder = total_to_founder;
    config.total_to_holders = total_to_holders;

    emit!(EpochFunded {
        config: config_key,
        epoch: epoch_key,
        index,
        deposit_amount: amount,
        founder_amount,
        holders_deposit,
        carry_in,
        holders_amount,
        num_leaves,
        merkle_root,
        snapshot_slot,
        snapshot_hash,
        funded_at: now,
        claim_deadline,
    });
    Ok(())
}
