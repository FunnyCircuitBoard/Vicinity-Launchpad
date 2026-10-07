//! `revoke_payout_opt_in`: the current founder, or the founder who signed the
//! opt-in (for example after a handover), closes it. The rent goes back to the
//! signer of the opt-in. Always works, paused or not.

use anchor_lang::prelude::*;

use crate::constants::{COIN_SEED, PAYOUT_OPT_IN_SEED};
use crate::errors::LaunchpadError;
use crate::events::PayoutOptInRevoked;
use crate::state::{Coin, PayoutOptIn};

#[derive(Accounts)]
#[instruction(city_id: u64)]
pub struct RevokePayoutOptIn<'info> {
    /// `coin.founder` or `opt_in.founder`.
    pub by: Signer<'info>,

    #[account(seeds = [COIN_SEED, &city_id.to_le_bytes()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,

    #[account(
        mut,
        seeds = [PAYOUT_OPT_IN_SEED, coin.key().as_ref()],
        bump = opt_in.bump,
        has_one = coin @ LaunchpadError::InvalidAddress,
        constraint = opt_in.founder == opt_in_founder.key() @ LaunchpadError::InvalidAddress,
        close = opt_in_founder,
    )]
    pub opt_in: Box<Account<'info, PayoutOptIn>>,

    /// CHECK: receives the rent; must be `opt_in.founder`.
    #[account(mut)]
    pub opt_in_founder: UncheckedAccount<'info>,
}

pub fn handle_revoke_payout_opt_in(ctx: Context<RevokePayoutOptIn>, city_id: u64) -> Result<()> {
    let by = ctx.accounts.by.key();
    require!(
        by == ctx.accounts.coin.founder || by == ctx.accounts.opt_in.founder,
        LaunchpadError::Unauthorized
    );
    emit!(PayoutOptInRevoked {
        city_id,
        founder: ctx.accounts.opt_in.founder,
        by,
    });
    Ok(())
}
