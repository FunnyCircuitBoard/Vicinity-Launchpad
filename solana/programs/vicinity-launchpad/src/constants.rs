//! Program constants.
//!
//! Everything marked `#[constant]` is POLICY and is copied into the IDL
//! (`constants` section), so clients read the values the deployed binary
//! enforces instead of keeping their own copy. LAUNCHPAD-DESIGN.md section 5.6
//! lists them with their reasons.

use anchor_lang::prelude::*;

/// The dev wallet. Every platform fee goes here: Meteora configs are only
/// accepted when they name it as `fee_claimer` and `leftover_receiver`. It is a
/// constant on purpose: no admin key can redirect platform fees, and changing it
/// needs a program upgrade (the upgrade multisig). Devnet uses the same wallet.
#[constant]
pub const FEE_RECIPIENT: Pubkey = pubkey!("13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN");

/// 1,000,000,000 coins at 6 decimals. Every Vicinity coin has exactly this
/// supply, minted once by DBC with the mint authority removed.
#[constant]
pub const COIN_SUPPLY_RAW: u64 = 1_000_000_000_000_000u64;
/// Decimals of every Vicinity coin.
#[constant]
pub const COIN_DECIMALS: u8 = 6;
/// Highest curve trading fee a config may charge: 2.00% (DBC fee denominator
/// 1,000,000,000). DBC's own minimum is 0.25%.
#[constant]
pub const MAX_TRADE_FEE_NUMERATOR: u64 = 20_000_000;
/// The city (pool creator) gets this share of the non-Meteora trading fee; the
/// dev wallet (partner) gets the rest.
#[constant]
pub const REQUIRED_CREATOR_FEE_PERCENT: u8 = 50;
/// Share of the graduated pool's liquidity locked for ever in the dev wallet's
/// position.
#[constant]
pub const REQUIRED_PARTNER_LOCKED_LP_PERCENT: u8 = 50;
/// Share of the graduated pool's liquidity locked for ever in the Coin PDA's
/// position.
#[constant]
pub const REQUIRED_CREATOR_LOCKED_LP_PERCENT: u8 = 50;
/// Highest fee the graduated DAMM v2 pool may charge: 2%.
#[constant]
pub const MAX_MIGRATED_POOL_FEE_BPS: u16 = 200;
/// Highest launch fee (DBC `pool_creation_fee`): 0.5 SOL.
#[constant]
pub const MAX_POOL_CREATION_FEE_LAMPORTS: u64 = 500_000_000;
/// Lowest and highest decimals an allowed quote token may have (WSOL has 9,
/// $VICINITY 6).
#[constant]
pub const MIN_QUOTE_DECIMALS: u8 = 6;
#[constant]
pub const MAX_QUOTE_DECIMALS: u8 = 9;
/// An approval lasts at most 30 days.
#[constant]
pub const APPROVAL_MAX_SECS: i64 = 30 * 86_400;
/// At most one opted-in payout per coin per 24 hours.
#[constant]
pub const PAYOUT_COOLDOWN_SECS: i64 = 86_400;
/// Every coin's metadata URL is this prefix, the coin's mint address and ".json".
#[constant]
pub const METADATA_URI_PREFIX: &str = "https://vicinity.city/coin-meta/";
/// Longest on-chain coin name (Metaplex limit), in bytes.
#[constant]
pub const MAX_NAME_LEN: u8 = 32;
/// Longest ticker (Metaplex limit), in bytes of A-Z0-9.
#[constant]
pub const MAX_SYMBOL_LEN: u8 = 10;

/// Seed of the one `Launchpad` PDA.
pub const LAUNCHPAD_SEED: &[u8] = b"launchpad";
/// Seed of a `LaunchConfig` PDA: `["launch_config", dbc_config]`.
pub const LAUNCH_CONFIG_SEED: &[u8] = b"launch_config";
/// Seed of an `Approval` PDA: `["approval", city_id as u64 little endian]`.
pub const APPROVAL_SEED: &[u8] = b"approval";
/// Seed of a `Coin` PDA: `["coin", city_id as u64 little endian]`.
pub const COIN_SEED: &[u8] = b"coin";
/// Seed of a coin's holders pot (SPL token account): `["holders_pot", coin]`.
pub const HOLDERS_POT_SEED: &[u8] = b"holders_pot";
/// Seed of a coin's founder vault (SPL token account): `["founder_vault", coin]`.
pub const FOUNDER_VAULT_SEED: &[u8] = b"founder_vault";
/// Seed of a `PayoutOptIn` PDA: `["payout_opt_in", coin]`.
pub const PAYOUT_OPT_IN_SEED: &[u8] = b"payout_opt_in";

/// `vicinity_rewards` seeds (that program's constants.rs): the city config is
/// `["city", city_coin_mint]` and its vault `["vault", config]`.
pub const REWARDS_CITY_SEED: &[u8] = b"city";
pub const REWARDS_VAULT_SEED: &[u8] = b"vault";

/// Metaplex Token Metadata program; DBC creates each coin's metadata there.
pub const METAPLEX_PROGRAM_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
/// SPL Token-2022 program. DAMM v2 position NFTs live there; this program only
/// reads the NFT account's mint, holder and amount.
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// DBC's pool authority PDA (`const_pda::pool_authority` in DBC). It owns every
/// curve vault.
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// DAMM v2's pool authority PDA. It owns every DAMM v2 vault.
pub const DAMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
