//! `revoke_payout_opt_in()` (4.19): the current founder, or the founder who
//! signed the opt-in (for example after a hand-over), closes it. The rent goes
//! back to the signer of the opt-in. Always works, paused or not.

use anchor_lang::prelude::*;

use crate::constants::{COIN_SEED, PAYOUT_OPT_IN_SEED};
use crate::errors::CurveError;
use crate::events::PayoutOptInRevoked;
use crate::state::{CurveCoin, PayoutOptIn};

#[derive(Accounts)]
pub struct RevokePayoutOptIn<'info> {
    /// `coin.founder` or `opt_in.founder`.
    pub by: Signer<'info>,

    #[account(seeds = [COIN_SEED, &coin.city_id.to_le_bytes()], bump = coin.bump)]
    pub coin: Box<Account<'info, CurveCoin>>,

    #[account(
        mut,
        seeds = [PAYOUT_OPT_IN_SEED, coin.key().as_ref()],
        bump = opt_in.bump,
        has_one = coin @ CurveError::InvalidAddress,
        constraint = opt_in.founder == opt_in_founder.key() @ CurveError::InvalidAddress,
        close = opt_in_founder,
    )]
    pub opt_in: Box<Account<'info, PayoutOptIn>>,

    /// CHECK: receives the rent; must be `opt_in.founder`.
    #[account(mut)]
    pub opt_in_founder: UncheckedAccount<'info>,
}

pub fn handle_revoke_payout_opt_in(ctx: Context<RevokePayoutOptIn>) -> Result<()> {
    let by = ctx.accounts.by.key();
    let founder = ctx.accounts.opt_in.founder;
    require!(
        by == ctx.accounts.coin.founder || by == founder,
        CurveError::Unauthorized
    );
    emit!(PayoutOptInRevoked {
        city_id: ctx.accounts.coin.city_id,
        founder,
        by,
    });
    Ok(())
}
