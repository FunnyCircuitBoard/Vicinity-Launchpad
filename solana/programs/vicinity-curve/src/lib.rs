//! `vicinity_curve`: the fully custom Vicinity launchpad. One program runs a
//! city coin's whole life: admin approval, launch, bonding curve, graduation,
//! the pool after graduation, fee booking, payouts and buyback-and-burn. No
//! Meteora program, no other AMM, no third party receives anything.
//!
//! `solana/VICINITY-CURVE-DESIGN.md` (revision 2) is the specification; the
//! places where the build had to choose between readings of it are recorded in
//! `solana/VICINITY-CURVE-NOTES.md`.
//!
//! * One permanent `Coin` account per city (`["coin", city_id LE]`, Rust
//!   `CurveCoin`, 693 bytes, fixed offsets) is the city's record and its
//!   market. All of the coin's SOL is native lamports of this account; its
//!   coins sit in the vault PDA `["coin_vault", coin]`.
//! * The program calls the pure integer crate `vicinity-curve-math` for every
//!   number it computes and writes what it returns; handlers do no arithmetic
//!   of their own except checked counter additions (4.0, 5.16).
//! * Lamports leave a `Coin` only through `custody::pay_out` (6.5); no CPI
//!   follows it except the event CPI (rule of 4.0).
//! * Within the program no key can move money or change a live coin; nothing
//!   can stop sells, claims, forwards or withdrawals (section 8).
//!
//! Features (3.1): `no-idl` (default: no Anchor IDL instructions in any build,
//! 8.4), `devnet` (the compiled ids of 3.2), `halt-all` (the pre-audited
//! emergency build: the eight outflow instructions refuse, 8.3) and
//! `short-windows` (accepted and ignored).

// Anchor 0.31 macros emit cfg flags that rustc does not know about.
#![allow(unexpected_cfgs)]
// Anchor 0.31's `#[program]` expands to `AccountInfo::realloc`, deprecated in
// the solana-program it pins; nothing in this crate's own code is deprecated.
#![allow(deprecated)]
// `anchor_lang::Result` carries a large error type by design.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod custody;
pub mod errors;
pub mod events;
pub mod helpers;
pub mod instructions;
pub mod state;

use instructions::*;

// Localnet / devnet id: a throwaway keypair kept outside the repository; the
// math crate's `PROGRAM_ID` (the owner `decode_coin` requires) is the same key.
// For mainnet the owner generates a fresh keypair on his own machine and puts
// its public key here, in the math crate and in Anchor.toml (3.1).
declare_id!("nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk");

#[program]
pub mod vicinity_curve {
    use super::*;

    /// 4.1. One-time: create the global `Launchpad`. Only the program's upgrade
    /// authority can call it; the admin signs too.
    pub fn init_launchpad(ctx: Context<InitLaunchpad>, guardian: Pubkey) -> Result<()> {
        instructions::init_launchpad::handle_init_launchpad(ctx, guardian)
    }

    /// 4.2. Step one of the admin transfer (zero cancels).
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::propose_admin::handle_propose_admin(ctx, new_admin)
    }

    /// 4.3. Step two of the admin transfer, signed by the proposed key.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::accept_admin::handle_accept_admin(ctx)
    }

    /// 4.4. Pause or resume launches, payouts and buys. The payout key may
    /// only pause payouts; the guardian may only pause launches and buys.
    pub fn set_pause(
        ctx: Context<SetPause>,
        launches: Option<bool>,
        payouts: Option<bool>,
        buys: Option<bool>,
    ) -> Result<()> {
        instructions::set_pause::handle_set_pause(ctx, launches, payouts, buys)
    }

    /// 4.4. Set or clear (zero) the guardian.
    pub fn set_guardian(ctx: Context<SetGuardian>, guardian: Pubkey) -> Result<()> {
        instructions::set_guardian::handle_set_guardian(ctx, guardian)
    }

    /// 4.5. Set (or clear, with two zeros) the payout key and payout wallet.
    pub fn set_payout_config(
        ctx: Context<SetPayoutConfig>,
        payout_authority: Pubkey,
        payout_destination: Pubkey,
    ) -> Result<()> {
        instructions::set_payout_config::handle_set_payout_config(
            ctx,
            payout_authority,
            payout_destination,
        )
    }

    /// 4.6. Add a split and curve for future coins (V1 to V11).
    pub fn add_launch_config(ctx: Context<AddLaunchConfig>, p: ConfigParams) -> Result<()> {
        instructions::add_launch_config::handle_add_launch_config(ctx, p)
    }

    /// 4.7. Switch a config on or off for future approvals and launches.
    pub fn set_launch_config_enabled(
        ctx: Context<SetLaunchConfigEnabled>,
        enabled: bool,
    ) -> Result<()> {
        instructions::set_launch_config_enabled::handle_set_launch_config_enabled(ctx, enabled)
    }

    /// 4.8. Approve one founder to launch one city's coin.
    #[allow(clippy::too_many_arguments)]
    pub fn approve_launch(
        ctx: Context<ApproveLaunch>,
        city_id: u64,
        founder: Pubkey,
        config_id: u16,
        name: String,
        symbol: String,
        meta_hash: [u8; 32],
        expires_at: i64,
    ) -> Result<()> {
        instructions::approve_launch::handle_approve_launch(
            ctx, city_id, founder, config_id, name, symbol, meta_hash, expires_at,
        )
    }

    /// 4.9. Close a pending approval (the admin, or anyone once expired).
    pub fn revoke_approval(ctx: Context<RevokeApproval>, city_id: u64) -> Result<()> {
        instructions::revoke_approval::handle_revoke_approval(ctx, city_id)
    }

    /// 4.10. The approved founder launches the city's coin.
    pub fn launch(ctx: Context<Launch>, city_id: u64) -> Result<()> {
        instructions::launch::handle_launch(ctx, city_id)
    }

    /// 4.11. Exact-in buy on the curve or in the pool.
    pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        instructions::buy::handle_buy(ctx, sol_in, min_tokens_out)
    }

    /// 4.12. Exact-in sell on the curve or in the pool.
    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        instructions::sell::handle_sell(ctx, tokens_in, min_sol_out)
    }

    /// 4.13. Permissionless buyback-and-burn crank.
    pub fn buyback_burn(ctx: Context<BuybackBurn>) -> Result<()> {
        instructions::buyback_burn::handle_buyback_burn(ctx)
    }

    /// 4.14. Permissionless: pay `platform_pending` to `FEE_RECIPIENT`.
    pub fn withdraw_platform_fees(ctx: Context<WithdrawPlatformFees>) -> Result<()> {
        instructions::withdraw_platform_fees::handle_withdraw_platform_fees(ctx)
    }

    /// 4.15. Permissionless: pay `holders_pending` to the city's checked
    /// `vicinity_rewards` WSOL vault (followed by a top-level `SyncNative`).
    pub fn forward_holders_fees(ctx: Context<ForwardHoldersFees>) -> Result<()> {
        instructions::forward_holders_fees::handle_forward_holders_fees(ctx)
    }

    /// 4.16. The founder takes `founder_pending`.
    pub fn claim_founder_fees(ctx: Context<ClaimFounderFees>) -> Result<()> {
        instructions::claim_founder_fees::handle_claim_founder_fees(ctx)
    }

    /// 4.17. The founder hands the seat to a co-signing key.
    pub fn transfer_founder(ctx: Context<TransferFounder>) -> Result<()> {
        instructions::transfer_founder::handle_transfer_founder(ctx)
    }

    /// 4.18. The founder opts in to daily payouts to the payout wallet.
    pub fn opt_in_payout(
        ctx: Context<OptInPayout>,
        expected_destination: Pubkey,
        ref_hash: [u8; 32],
    ) -> Result<()> {
        instructions::opt_in_payout::handle_opt_in_payout(ctx, expected_destination, ref_hash)
    }

    /// 4.19. Close a payout opt-in (current founder or its signer).
    pub fn revoke_payout_opt_in(ctx: Context<RevokePayoutOptIn>) -> Result<()> {
        instructions::revoke_payout_opt_in::handle_revoke_payout_opt_in(ctx)
    }

    /// 4.20. The payout key pays an opted-in founder's share to the payout
    /// wallet, at most daily.
    pub fn payout_founder_fees(ctx: Context<PayoutFounderFees>) -> Result<()> {
        instructions::payout_founder_fees::handle_payout_founder_fees(ctx)
    }
}

#[cfg(test)]
mod tests {
    use anchor_lang::Discriminator;

    /// 14.3: instruction discriminators are `sha256("global:<name>")[..8]`,
    /// what decoders and aggregators match on.
    #[test]
    fn instruction_discriminators() {
        let h = |s: &str| anchor_lang::solana_program::hash::hash(s.as_bytes()).to_bytes();
        let cases: &[(&[u8], &str)] = &[
            (
                crate::instruction::InitLaunchpad::DISCRIMINATOR,
                "init_launchpad",
            ),
            (crate::instruction::Launch::DISCRIMINATOR, "launch"),
            (crate::instruction::Buy::DISCRIMINATOR, "buy"),
            (crate::instruction::Sell::DISCRIMINATOR, "sell"),
            (
                crate::instruction::BuybackBurn::DISCRIMINATOR,
                "buyback_burn",
            ),
        ];
        for (d, name) in cases {
            assert_eq!(*d, &h(&format!("global:{name}"))[..8], "{name}");
        }
    }

    /// 8.4: the default features leave Anchor's IDL instructions out.
    #[test]
    fn no_idl_is_a_default_feature() {
        const { assert!(cfg!(feature = "no-idl")) };
    }
}
