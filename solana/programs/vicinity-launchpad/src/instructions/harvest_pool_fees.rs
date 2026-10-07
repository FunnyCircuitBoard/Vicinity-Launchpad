//! `harvest_pool_fees` (permissionless, after graduation): claim the fees of a
//! DAMM v2 position held by the `Coin` PDA into the holders pot, then split
//! exactly like `harvest_curve_fees`.
//!
//! Only positions whose NFT the Coin PDA holds can be claimed (DAMM v2 checks
//! the signer against the NFT holder, and so do we). The pool must be this
//! coin's pair (token A = the coin, token B = its quote token), so only quote
//! fees ever reach the pot. If someone gives the Coin PDA another position in
//! such a pool, its fees simply go to the same city.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::book_harvest;
use crate::constants::{
    COIN_SEED, DAMM_POOL_AUTHORITY, FOUNDER_VAULT_SEED, HOLDERS_POT_SEED, TOKEN_2022_PROGRAM_ID,
};
use crate::cp_amm::{
    self,
    accounts::{Pool, Position},
    cpi::accounts::ClaimPositionFee,
    program::CpAmm,
};
use crate::errors::LaunchpadError;
use crate::events::FeesHarvested;
use crate::math::read_token_account_base;
use crate::state::Coin;

#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct HarvestPoolFees<'info> {
    /// Anyone; pays the rent of `coin_base_account` the first time.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [COIN_SEED, &city_id.to_le_bytes()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,

    /// The DAMM v2 pool (owner and type checked by `AccountLoader`).
    pub damm_pool: AccountLoader<'info, Pool>,

    /// A DAMM v2 position in `damm_pool` (owner and type checked).
    #[account(mut)]
    pub position: AccountLoader<'info, Position>,

    /// CHECK: the position's NFT account (Token-2022): the handler checks it
    /// holds `position.nft_mint`, belongs to the Coin PDA and holds exactly 1.
    #[account(owner = TOKEN_2022_PROGRAM_ID @ LaunchpadError::WrongPosition)]
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK: DAMM v2's pool authority (address pinned and checked by DAMM v2).
    #[account(address = DAMM_POOL_AUTHORITY @ LaunchpadError::InvalidAddress)]
    pub damm_pool_authority: UncheckedAccount<'info>,

    /// CHECK: DAMM v2 checks it equals the pool's token A vault.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: DAMM v2 checks it equals the pool's token B vault.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    #[account(address = coin.mint @ LaunchpadError::WrongPool)]
    pub token_a_mint: Box<Account<'info, Mint>>,

    #[account(address = coin.quote_mint @ LaunchpadError::WrongPool)]
    pub token_b_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = token_a_mint,
        associated_token::authority = coin,
    )]
    pub coin_base_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [HOLDERS_POT_SEED, coin.key().as_ref()],
        bump = coin.holders_pot_bump,
        token::mint = token_b_mint,
        token::authority = coin,
    )]
    pub holders_pot: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [FOUNDER_VAULT_SEED, coin.key().as_ref()],
        bump = coin.founder_vault_bump,
        token::mint = token_b_mint,
        token::authority = coin,
    )]
    pub founder_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: DAMM v2's event authority PDA (checked by DAMM v2's event CPI).
    pub damm_event_authority: UncheckedAccount<'info>,
    pub damm_program: Program<'info, CpAmm>,
}

pub fn handle_harvest_pool_fees(mut ctx: Context<HarvestPoolFees>, city_id: u64) -> Result<()> {
    {
        let a = &ctx.accounts;
        let pool = a.damm_pool.load()?;
        require!(
            pool.token_a_mint == a.coin.mint && pool.token_b_mint == a.coin.quote_mint,
            LaunchpadError::WrongPool
        );
        let position = a.position.load()?;
        let (nft_mint, nft_holder, nft_amount) =
            read_token_account_base(&a.position_nft_account.try_borrow_data()?)
                .ok_or(LaunchpadError::WrongPosition)?;
        require!(
            position.pool == a.damm_pool.key()
                && nft_mint == position.nft_mint
                && nft_holder == a.coin.key()
                && nft_amount == 1,
            LaunchpadError::WrongPosition
        );
    }
    let before = ctx.accounts.holders_pot.amount;
    {
        let a = &ctx.accounts;
        let city_bytes = city_id.to_le_bytes();
        let seeds: &[&[u8]] = &[COIN_SEED, &city_bytes, &[a.coin.bump]];
        cp_amm::cpi::claim_position_fee(CpiContext::new_with_signer(
            a.damm_program.to_account_info(),
            ClaimPositionFee {
                pool_authority: a.damm_pool_authority.to_account_info(),
                pool: a.damm_pool.to_account_info(),
                position: a.position.to_account_info(),
                token_a_account: a.coin_base_account.to_account_info(),
                token_b_account: a.holders_pot.to_account_info(),
                token_a_vault: a.token_a_vault.to_account_info(),
                token_b_vault: a.token_b_vault.to_account_info(),
                token_a_mint: a.token_a_mint.to_account_info(),
                token_b_mint: a.token_b_mint.to_account_info(),
                position_nft_account: a.position_nft_account.to_account_info(),
                signer: a.coin.to_account_info(),
                token_a_program: a.token_program.to_account_info(),
                token_b_program: a.token_program.to_account_info(),
                event_authority: a.damm_event_authority.to_account_info(),
                program: a.damm_program.to_account_info(),
            },
            &[seeds],
        ))?;
    }
    ctx.accounts.holders_pot.reload()?;
    let claimed = ctx
        .accounts
        .holders_pot
        .amount
        .checked_sub(before)
        .ok_or(LaunchpadError::MathOverflow)?;
    if claimed == 0 {
        return Ok(());
    }
    let a = &mut ctx.accounts;
    let (to_holders, to_founder) = book_harvest(
        &a.token_program,
        &a.holders_pot,
        &a.founder_vault,
        &mut a.coin,
        claimed,
    )?;
    emit!(FeesHarvested {
        city_id,
        source: 1,
        claimed,
        surplus: 0,
        to_holders,
        to_founder,
    });
    Ok(())
}
