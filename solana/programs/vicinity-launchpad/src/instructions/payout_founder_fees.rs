//! `payout_founder_fees`: the Vicinity payout key sends an opted-in founder's
//! whole founder vault to the associated token account of the one payout
//! wallet fixed in the launchpad settings. Off by default (no payout key).
//!
//! Limits: only the payout key; not while payouts are paused; only if the
//! opt-in was signed by the current founder; only to the destination the
//! founder agreed to, which must also be the current setting; at most once per
//! 24 hours per coin (the timestamp lives on `Coin`, so revoking and opting in
//! again cannot reset it). An empty vault = nothing happens (no transfer, no
//! sequence number, no cooldown). Each payout gets a sequence number for
//! matching off-chain receipts.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::transfer_from_coin;
use crate::constants::{
    COIN_SEED, FOUNDER_VAULT_SEED, LAUNCHPAD_SEED, PAYOUT_COOLDOWN_SECS, PAYOUT_OPT_IN_SEED,
};
use crate::errors::LaunchpadError;
use crate::events::FounderPaidOut;
use crate::state::{Coin, Launchpad, PayoutOptIn};

#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct PayoutFounderFees<'info> {
    /// Must be `launchpad.payout_authority`; pays for the destination's token
    /// account if missing.
    #[account(mut)]
    pub payout_authority: Signer<'info>,

    #[account(seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,

    #[account(mut, seeds = [COIN_SEED, &city_id.to_le_bytes()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,

    #[account(
        seeds = [PAYOUT_OPT_IN_SEED, coin.key().as_ref()],
        bump = opt_in.bump,
        has_one = coin @ LaunchpadError::InvalidAddress,
    )]
    pub opt_in: Box<Account<'info, PayoutOptIn>>,

    #[account(
        mut,
        seeds = [FOUNDER_VAULT_SEED, coin.key().as_ref()],
        bump = coin.founder_vault_bump,
        token::mint = quote_mint,
        token::authority = coin,
    )]
    pub founder_vault: Box<Account<'info, TokenAccount>>,

    #[account(address = coin.quote_mint @ LaunchpadError::LaunchConfigMismatch)]
    pub quote_mint: Box<Account<'info, Mint>>,

    /// CHECK: the payout wallet; must be `launchpad.payout_destination`.
    #[account(address = launchpad.payout_destination @ LaunchpadError::DestinationMismatch)]
    pub destination_wallet: UncheckedAccount<'info>,

    /// The payout wallet's associated token account for the quote token.
    #[account(
        init_if_needed,
        payer = payout_authority,
        associated_token::mint = quote_mint,
        associated_token::authority = destination_wallet,
    )]
    pub destination_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_payout_founder_fees(ctx: Context<PayoutFounderFees>, city_id: u64) -> Result<()> {
    let a = &ctx.accounts;
    let lp = &a.launchpad;
    require!(
        lp.payout_authority != Pubkey::default() && a.payout_authority.key() == lp.payout_authority,
        LaunchpadError::Unauthorized
    );
    require!(!lp.payouts_paused, LaunchpadError::PayoutsPaused);
    require_keys_eq!(
        a.opt_in.founder,
        a.coin.founder,
        LaunchpadError::OptInFounderMismatch
    );
    require_keys_eq!(
        a.opt_in.agreed_destination,
        lp.payout_destination,
        LaunchpadError::DestinationMismatch
    );
    let now = Clock::get()?.unix_timestamp;
    let next_allowed = a
        .coin
        .last_payout_at
        .checked_add(PAYOUT_COOLDOWN_SECS)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(now >= next_allowed, LaunchpadError::PayoutTooSoon);

    let amount = a.founder_vault.amount;
    if amount == 0 {
        return Ok(());
    }
    transfer_from_coin(
        &a.token_program,
        &a.founder_vault,
        a.destination_token_account.to_account_info(),
        &a.coin,
        amount,
    )?;
    let destination = lp.payout_destination;
    let ref_hash = a.opt_in.ref_hash;
    let coin = &mut ctx.accounts.coin;
    coin.founder_paid_out = coin
        .founder_paid_out
        .checked_add(amount)
        .ok_or(LaunchpadError::MathOverflow)?;
    coin.payout_seq = coin
        .payout_seq
        .checked_add(1)
        .ok_or(LaunchpadError::MathOverflow)?;
    coin.last_payout_at = now;
    emit!(FounderPaidOut {
        city_id,
        founder: coin.founder,
        destination,
        amount,
        seq: coin.payout_seq,
        ref_hash,
    });
    Ok(())
}
