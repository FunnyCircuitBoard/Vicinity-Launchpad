//! One error per failure mode. Messages are written for the person reading a
//! failed transaction in an explorer.

use anchor_lang::prelude::*;

#[error_code]
pub enum LaunchpadError {
    // ---- keys ----
    #[msg("signer is not allowed to do this")]
    Unauthorized,
    #[msg("signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("an address is zero, not executable, or otherwise not usable here")]
    InvalidAddress,
    #[msg("no admin transfer is pending")]
    NoPendingAdmin,
    #[msg("signer is not the pending admin")]
    NotPendingAdmin,
    // ---- pause and payout settings ----
    #[msg("launches are paused")]
    LaunchesPaused,
    #[msg("payouts are paused")]
    PayoutsPaused,
    #[msg("opted-in payouts are not configured")]
    PayoutsNotConfigured,
    #[msg("the payout key must differ from the admin and the dev wallet, and the payout wallet from the payout key and the admin")]
    PayoutKeyNotSeparate,
    // ---- launch configs ----
    #[msg("this launch config is disabled")]
    LaunchConfigDisabled,
    #[msg("the DBC config, quote mint or launch config do not belong together")]
    LaunchConfigMismatch,
    // ---- config rules (LAUNCHPAD-DESIGN.md 7.2) ----
    #[msg(
        "quote mint must be classic SPL Token with no mint or freeze authority and 6 to 9 decimals"
    )]
    QuoteMintNotAllowed,
    #[msg("config fee_claimer must be the dev wallet (FEE_RECIPIENT)")]
    ConfigFeeClaimer,
    #[msg("config leftover_receiver must be the dev wallet (FEE_RECIPIENT)")]
    ConfigLeftoverReceiver,
    #[msg("config must create classic SPL coins")]
    ConfigTokenType,
    #[msg("config must create 6-decimal coins with a fixed supply of exactly 1,000,000,000")]
    ConfigDecimalsOrSupply,
    #[msg("config must collect fees in the quote token")]
    ConfigCollectFeeMode,
    #[msg("config fee must be flat, without dynamic fee, and at most MAX_TRADE_FEE_NUMERATOR")]
    ConfigFee,
    #[msg("config must give the creator (city) exactly REQUIRED_CREATOR_FEE_PERCENT of the trading fee")]
    ConfigFeeSplit,
    #[msg("config must make coin metadata immutable")]
    ConfigMetadataMutable,
    #[msg("config must lock all graduated liquidity permanently, 50/50, with no vesting")]
    ConfigLiquidityLock,
    #[msg("config must graduate to a DAMM v2 customizable pool with a flat quote-only fee of at most 2% and no dynamic, scheduled or compounding fee")]
    ConfigMigration,
    #[msg("config must not charge a graduation fee")]
    ConfigMigrationFee,
    #[msg("config must not lock or vest coins for anyone")]
    ConfigVesting,
    #[msg("config launch fee is above MAX_POOL_CREATION_FEE_LAMPORTS")]
    ConfigLaunchFee,
    // ---- approvals and launch ----
    #[msg("name must be 1 to 32 bytes with no control characters")]
    BadName,
    #[msg("symbol must be 1 to 10 characters of A-Z and 0-9")]
    BadSymbol,
    #[msg("expiry must be in the future and at most APPROVAL_MAX_SECS away")]
    BadExpiry,
    #[msg("this approval has expired")]
    ApprovalExpired,
    #[msg("this city already has a coin")]
    CoinAlreadyLaunched,
    #[msg("signer is not this coin's founder")]
    WrongFounder,
    #[msg("the DBC pool does not belong to this coin")]
    PoolCreatorMismatch,
    // ---- fees, claims and payouts ----
    #[msg("the DAMM v2 pool is not this coin's pair")]
    WrongPool,
    #[msg("the position is not in this pool or not held by this coin")]
    WrongPosition,
    #[msg("the rewards config is not this coin's Holders-only config in the coin's quote token")]
    WrongRewardsConfig,
    #[msg("the rewards vault is not this coin's derived rewards vault")]
    WrongRewardsVault,
    #[msg("the payout destination does not match the founder's agreed destination")]
    DestinationMismatch,
    #[msg("the opt-in was signed by a previous founder")]
    OptInFounderMismatch,
    #[msg("the last payout for this coin was less than 24 hours ago")]
    PayoutTooSoon,
    // ---- arithmetic ----
    #[msg("arithmetic overflow")]
    MathOverflow,
}
