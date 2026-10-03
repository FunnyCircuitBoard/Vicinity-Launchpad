//! `claim`: a holder proves its leaf and receives its share from the vault.
//!
//! This is the ONLY instruction that moves money out of the vault, and only to
//! the wallet named in the leaf. There is deliberately no withdraw for the
//! authority: an emergency path would be a hole a compromised operator key
//! could drain the vault through, and the vault only ever holds money that was
//! promised to holders.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::{CITY_SEED, CLAIM_SEED, EPOCH_SEED, MAX_PROOF_LEN, VAULT_SEED};
use crate::errors::RewardsError;
use crate::events::Claimed;
use crate::math::effective_deadline;
use crate::merkle::{leaf_hash, verify};
use crate::state::{CityConfig, ClaimStatus, Epoch, EpochState};

#[derive(Accounts)]
#[instruction(epoch_index: u64)]
pub struct Claim<'info> {
    /// The wallet in the leaf. Pays the rent of its claim status (returned by
    /// `close_claim_status`) and of its token account if it has none.
    #[account(mut)]
    pub claimant: Signer<'info>,

    #[account(
        mut,
        has_one = reward_mint,
        has_one = vault,
        seeds = [CITY_SEED, config.city_coin_mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, CityConfig>,

    /// Bound to this config and index by its seeds: an epoch of another city
    /// cannot be passed.
    #[account(
        mut,
        seeds = [EPOCH_SEED, config.key().as_ref(), &epoch_index.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Account<'info, Epoch>,

    /// Plain `init`: this is the double-claim protection. If the account
    /// already exists the transaction fails here, before any logic runs.
    #[account(
        init,
        payer = claimant,
        space = 8 + ClaimStatus::INIT_SPACE,
        seeds = [CLAIM_SEED, epoch.key().as_ref(), claimant.key().as_ref()],
        bump,
    )]
    pub claim_status: Account<'info, ClaimStatus>,

    #[account(mint::token_program = token_program)]
    pub reward_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump = config.vault_bump,
        token::mint = reward_mint,
        token::authority = config,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// The claimant's associated token account for `reward_mint`. The ATA
    /// derivation binds it to the claimant, so the money can only land in the
    /// leaf's wallet. Second and last use of `init_if_needed`: a holder who
    /// never held the reward asset must still be able to claim.
    #[account(
        init_if_needed,
        payer = claimant,
        associated_token::mint = reward_mint,
        associated_token::authority = claimant,
        associated_token::token_program = token_program,
    )]
    pub claimant_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_claim(
    ctx: Context<Claim>,
    epoch_index: u64,
    leaf_index: u32,
    amount: u64,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    // ---- checks (read only) ---------------------------------------------
    let config = &ctx.accounts.config;
    let epoch = &ctx.accounts.epoch;
    require!(!config.paused, RewardsError::Paused);
    // Redundant with the seeds, kept as a cheap explicit statement.
    require!(epoch.index == epoch_index, RewardsError::EpochIndexMismatch);
    require!(epoch.state == EpochState::Open, RewardsError::EpochNotOpen);
    let now = Clock::get()?.unix_timestamp;
    // The nominal deadline plus every second the city was paused since this
    // epoch was funded: a pause can never cost holders claim time.
    let deadline = effective_deadline(
        epoch.claim_deadline,
        epoch.pause_secs_at_funding,
        config.paused_total_secs,
        config.paused,
        config.paused_at,
        now,
    )?;
    require!(now <= deadline, RewardsError::ClaimDeadlinePassed);
    require!(
        leaf_index < epoch.num_leaves,
        RewardsError::LeafIndexOutOfRange
    );
    // A zero leaf would create a claim status and move nothing; the builder
    // drops zero amounts, so one here means a mismatch.
    require!(amount > 0, RewardsError::ZeroClaimAmount);
    // Length first, so a huge proof is refused before any hashing.
    require!(proof.len() <= MAX_PROOF_LEN, RewardsError::ProofTooLong);

    let leaf = leaf_hash(leaf_index, &ctx.accounts.claimant.key(), amount);
    require!(
        verify(&proof, &epoch.merkle_root, &leaf),
        RewardsError::InvalidProof
    );

    // The cap: even a root whose leaves add up to more than was deposited can
    // never pay out more than `holders_amount`. The vault is never drained
    // below what other epochs are owed.
    let epoch_claimed_amount = epoch
        .claimed_amount
        .checked_add(amount)
        .ok_or(RewardsError::MathOverflow)?;
    require!(
        epoch_claimed_amount <= epoch.holders_amount,
        RewardsError::ClaimExceedsHoldersAmount
    );
    let total_claimed = config
        .total_claimed
        .checked_add(amount)
        .ok_or(RewardsError::MathOverflow)?;

    let config_key = config.key();
    let epoch_key = epoch.key();
    let city_coin_mint = config.city_coin_mint;
    let config_bump = config.bump;
    let decimals = ctx.accounts.reward_mint.decimals;

    // ---- transfer vault -> claimant, signed by the config PDA -----------
    let signer_seeds: &[&[u8]] = &[CITY_SEED, city_coin_mint.as_ref(), &[config_bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.reward_mint.to_account_info(),
                to: ctx.accounts.claimant_token_account.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        decimals,
    )?;

    // ---- state ----------------------------------------------------------
    let claim_status = &mut ctx.accounts.claim_status;
    claim_status.claimant = ctx.accounts.claimant.key();
    claim_status.amount = amount;
    claim_status.claimed_at = now;
    claim_status.bump = ctx.bumps.claim_status;

    let epoch = &mut ctx.accounts.epoch;
    epoch.claimed_amount = epoch_claimed_amount;

    let config = &mut ctx.accounts.config;
    config.total_claimed = total_claimed;

    emit!(Claimed {
        config: config_key,
        epoch: epoch_key,
        index: epoch_index,
        claimant: claim_status.claimant,
        leaf_index,
        amount,
        epoch_claimed_amount,
    });
    Ok(())
}
