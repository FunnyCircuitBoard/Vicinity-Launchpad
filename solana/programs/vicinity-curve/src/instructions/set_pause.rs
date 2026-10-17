//! `set_pause(launches, payouts, buys, buybacks)` (4.4).
//!
//! | signer | may set |
//! |---|---|
//! | `admin` | any flag, to true or false |
//! | nonzero `payout_authority` | only `(None, Some(true), None, None)` |
//! | nonzero `guardian` | only `launches`, `buys` and `buybacks`, only to `Some(true)`, `payouts = None`, at least one set |
//!
//! Whoever signs, the flags after the call must have `buybacks_halted` only
//! while `buys_halted` (`BuybackHaltWithoutBuyHalt`, review LL-1): a buyback
//! halt goes with a buy halt, and buybacks resume before or with buys, so a
//! backlog never waits for buyers to get ahead of it.
//!
//! Nothing can stop sells, claims, forwards or withdrawals: no flag exists for
//! them, and `sell` never reads this account (8.3).

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::CurveError;
use crate::events::PauseChanged;
use crate::helpers::{pause_allowed, pause_flags_consistent, PauseArgs};
use crate::state::Launchpad;

#[derive(Accounts)]
pub struct SetPause<'info> {
    /// The admin, the payout key or the guardian.
    pub authority: Signer<'info>,

    #[account(mut, seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,
}

pub fn handle_set_pause(ctx: Context<SetPause>, args: PauseArgs) -> Result<()> {
    let lp = &mut ctx.accounts.launchpad;
    let by = ctx.accounts.authority.key();
    require!(
        pause_allowed(&by, &lp.admin, &lp.payout_authority, &lp.guardian, args),
        CurveError::Unauthorized
    );
    if let Some(v) = args.launches {
        lp.launches_paused = v;
    }
    if let Some(v) = args.payouts {
        lp.payouts_paused = v;
    }
    if let Some(v) = args.buys {
        lp.buys_halted = v;
    }
    if let Some(v) = args.buybacks {
        lp.buybacks_halted = v;
    }
    require!(
        pause_flags_consistent(lp.buys_halted, lp.buybacks_halted),
        CurveError::BuybackHaltWithoutBuyHalt
    );
    emit!(PauseChanged {
        launches_paused: lp.launches_paused,
        payouts_paused: lp.payouts_paused,
        buys_halted: lp.buys_halted,
        buybacks_halted: lp.buybacks_halted,
        by,
    });
    Ok(())
}
