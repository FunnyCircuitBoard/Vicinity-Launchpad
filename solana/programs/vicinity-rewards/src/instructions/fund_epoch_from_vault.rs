//! `fund_epoch_from_vault`: turn money that arrived in the vault directly
//! (a LaunchLab creator-fee wallet or a platform fee wallet pointed at the
//! vault, or a plain transfer) into an epoch, exactly as `fund_epoch` does for
//! a deposit.
//!
//! Spec section 0: "design the vault so that pointing a fee wallet at it needs
//! no program change". The vault is an ordinary token account, so anyone can
//! send to it; without this instruction such money would be stuck forever
//! (there is no withdraw by design, and `fund_epoch` only distributes what the
//! funder deposits).
//!
//! What counts: `surplus = vault.amount - (total_to_holders - total_claimed)`.
//! The subtracted part is exactly the money the vault already owes (open
//! epochs' unclaimed amounts plus carry-over), so the surplus is only what no
//! epoch has booked yet. The founder share of the surplus leaves the vault to
//! the founder's ATA, signed by the config PDA. This is the second and last
//! outflow of the vault besides `claim`; it is bounded by `founder_bps` of money
//! that was never promised to holders, and it is booked in `total_to_founder`
//! so every accounting invariant keeps holding. The rest is booked as the
//! holders' deposit of the new epoch and stays in the vault.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::{CITY_SEED, EPOCH_SEED, VAULT_SEED};
use crate::errors::RewardsError;
use crate::instructions::fund_epoch::{plan_epoch, record_epoch, EpochInputs};
use crate::state::{CityConfig, Epoch};

#[derive(Accounts)]
pub struct FundEpochFromVault<'info> {
    /// The publisher of the root. Must be `config.authority`.
    pub authority: Signer<'info>,

    /// Pays the rent of the epoch account and of the founder's token account
    /// if it does not exist yet. May be the same key as `authority`.
    #[account(mut)]
    pub payer: Signer<'info>,

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

    #[account(mint::token_program = token_program)]
    pub reward_mint: InterfaceAccount<'info, Mint>,

    /// Source of the founder share and home of the holders' part.
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

    /// The founder's associated token account for `reward_mint` (see `fund_epoch`).
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = reward_mint,
        associated_token::authority = founder,
        associated_token::token_program = token_program,
    )]
    pub founder_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        space = 8 + Epoch::INIT_SPACE,
        seeds = [EPOCH_SEED, config.key().as_ref(), &config.epoch_count.to_le_bytes()],
        bump,
    )]
    pub epoch: Account<'info, Epoch>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Money in the vault that no epoch has booked: the vault balance minus what
/// the vault still owes (open epochs' unclaimed amounts plus carry-over).
pub fn vault_surplus(vault_amount: u64, config: &CityConfig) -> Result<u64> {
    let owed = config
        .total_to_holders
        .checked_sub(config.total_claimed)
        .ok_or(RewardsError::MathOverflow)?;
    // The vault can never hold less than it owes (only `claim` takes money out
    // and it is capped by the epoch's holders_amount), so this cannot fail; if
    // it ever did, refusing is the only safe answer.
    vault_amount
        .checked_sub(owed)
        .ok_or(RewardsError::MathOverflow.into())
}

pub fn handle_fund_epoch_from_vault(
    ctx: Context<FundEpochFromVault>,
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
    let surplus = vault_surplus(ctx.accounts.vault.amount, &ctx.accounts.config)?;
    let plan = plan_epoch(&ctx.accounts.config, surplus, &inputs)?;
    let decimals = ctx.accounts.reward_mint.decimals;
    let city_coin_mint = ctx.accounts.config.city_coin_mint;
    let config_bump = ctx.accounts.config.bump;

    // ---- founder share leaves the vault, signed by the config PDA --------
    if plan.founder_amount > 0 {
        let signer_seeds: &[&[u8]] = &[CITY_SEED, city_coin_mint.as_ref(), &[config_bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.founder_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[signer_seeds],
            ),
            plan.founder_amount,
            decimals,
        )?;
    }
    // The holders' part is already in the vault; booking it is enough.

    // ---- state ----------------------------------------------------------
    record_epoch(
        &mut ctx.accounts.config,
        &mut ctx.accounts.epoch,
        ctx.bumps.epoch,
        &plan,
        &inputs,
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with(total_to_holders: u64, total_claimed: u64) -> CityConfig {
        CityConfig {
            authority: Pubkey::default(),
            pending_authority: Pubkey::default(),
            founder: Pubkey::default(),
            city_coin_mint: Pubkey::default(),
            reward_mint: Pubkey::default(),
            vault: Pubkey::default(),
            reward_model: crate::state::RewardModel::Holders,
            founder_bps: 0,
            locked: true,
            paused: false,
            paused_at: 0,
            paused_total_secs: 0,
            epoch_count: 1,
            carry_over: 0,
            total_funded: total_to_holders,
            total_to_founder: 0,
            total_to_holders,
            total_claimed,
            city_tag: [0u8; 32],
            bump: 0,
            vault_bump: 0,
        }
    }

    #[test]
    fn surplus_is_vault_minus_what_is_owed() {
        // owed 700 (1000 booked, 300 claimed); vault holds 1700: 1000 unbooked
        assert_eq!(
            vault_surplus(1_700, &config_with(1_000, 300)).unwrap(),
            1_000
        );
        // nothing unbooked
        assert_eq!(vault_surplus(700, &config_with(1_000, 300)).unwrap(), 0);
        // fresh city
        assert_eq!(vault_surplus(0, &config_with(0, 0)).unwrap(), 0);
        assert_eq!(vault_surplus(5, &config_with(0, 0)).unwrap(), 5);
    }

    #[test]
    fn a_vault_below_what_it_owes_is_refused() {
        assert!(vault_surplus(699, &config_with(1_000, 300)).is_err());
        assert!(vault_surplus(0, &config_with(1, 0)).is_err());
    }
}
