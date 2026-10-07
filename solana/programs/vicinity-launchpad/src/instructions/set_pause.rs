//! `set_pause`: the admin pauses or resumes launches and payouts. The payout
//! key may only pause payouts (`launches = None, payouts = Some(true)`): it can
//! stop itself, never resume. Sells, harvests, forwards, claims, revokes and
//! graduation are never paused.

use anchor_lang::prelude::*;

use crate::constants::LAUNCHPAD_SEED;
use crate::errors::LaunchpadError;
use crate::events::PauseChanged;
use crate::state::Launchpad;

#[derive(Accounts)]
pub struct SetPause<'info> {
    /// The admin, or the payout key (pause payouts only).
    pub authority: Signer<'info>,

    #[account(mut, seeds = [LAUNCHPAD_SEED], bump = launchpad.bump)]
    pub launchpad: Account<'info, Launchpad>,
}

pub fn handle_set_pause(
    ctx: Context<SetPause>,
    launches: Option<bool>,
    payouts: Option<bool>,
) -> Result<()> {
    let lp = &mut ctx.accounts.launchpad;
    let by = ctx.accounts.authority.key();
    if by != lp.admin {
        let is_payout_key = lp.payout_authority != Pubkey::default() && by == lp.payout_authority;
        require!(
            is_payout_key && launches.is_none() && payouts == Some(true),
            LaunchpadError::Unauthorized
        );
    }
    if let Some(v) = launches {
        lp.launches_paused = v;
    }
    if let Some(v) = payouts {
        lp.payouts_paused = v;
    }
    emit!(PauseChanged {
        launches_paused: lp.launches_paused,
        payouts_paused: lp.payouts_paused,
        by,
    });
    Ok(())
}
