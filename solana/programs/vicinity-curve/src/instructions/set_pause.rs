//! `set_pause(launches, payouts, buys)` (4.4).
//!
//! | signer | may set |
//! |---|---|
//! | `admin` | any flag, to true or false |
//! | nonzero `payout_authority` | only `(None, Some(true), None)` |
//! | nonzero `guardian` | only `launches` and `buys`, only to `Some(true)`, `payouts = None`, at least one set |
//!
//! Nothing can stop sells, claims, forwards or withdrawals: no flag exists for
//! them, and `sell` never reads this account (8.3).

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::CurveError;
use crate::events::PauseChanged;
use crate::helpers::pause_allowed;
use crate::state::Launchpad;

#[derive(Accounts)]
pub struct SetPause<'info> {
    /// The admin, the payout key or the guardian.
    pub authority: Signer<'info>,

    #[account(mut, seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Box<Account<'info, Launchpad>>,
}

pub fn handle_set_pause(
    ctx: Context<SetPause>,
    launches: Option<bool>,
    payouts: Option<bool>,
    buys: Option<bool>,
) -> Result<()> {
    let lp = &mut ctx.accounts.launchpad;
    let by = ctx.accounts.authority.key();
    require!(
        pause_allowed(
            &by,
            &lp.admin,
            &lp.payout_authority,
            &lp.guardian,
            launches,
            payouts,
            buys
        ),
        CurveError::Unauthorized
    );
    if let Some(v) = launches {
        lp.launches_paused = v;
    }
    if let Some(v) = payouts {
        lp.payouts_paused = v;
    }
    if let Some(v) = buys {
        lp.buys_halted = v;
    }
    emit!(PauseChanged {
        launches_paused: lp.launches_paused,
        payouts_paused: lp.payouts_paused,
        buys_halted: lp.buys_halted,
        by,
    });
    Ok(())
}
