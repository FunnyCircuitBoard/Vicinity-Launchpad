//! Program constants.
//!
//! Everything in this file is POLICY, not mechanism. The values are the
//! recommended defaults from the spec and are listed under "PRODUCT DECISION
//! REQUIRED" in the README. Changing one of them changes what the program
//! enforces, so the UI must only ever show what is written here.
//!
//! The policy numbers carry `#[constant]`, which puts them into the IDL
//! (`constants` section). Clients read them from there instead of hard coding
//! a copy, so the UI can only ever show what the deployed binary enforces.

use anchor_lang::prelude::*;

/// Seed of the one `Registry` PDA: `["registry"]`.
pub const REGISTRY_SEED: &[u8] = b"registry";
/// Seed of a `CityConfig` PDA: `["city", city_coin_mint]`.
pub const CITY_SEED: &[u8] = b"city";
/// Seed of a city's reward vault (SPL token account): `["vault", config]`.
pub const VAULT_SEED: &[u8] = b"vault";
/// Seed of an `Epoch` PDA: `["epoch", config, index as u64 little endian]`.
pub const EPOCH_SEED: &[u8] = b"epoch";
/// Seed of a `ClaimStatus` PDA: `["claim", epoch, claimant]`.
pub const CLAIM_SEED: &[u8] = b"claim";

/// Basis points denominator: 10000 bps = 100%.
#[constant]
pub const BPS_DENOMINATOR: u64 = 10_000;
/// The Creator model sends everything to the founder.
#[constant]
pub const CREATOR_BPS: u16 = 10_000;
/// The Holders model sends nothing to the founder.
#[constant]
pub const HOLDERS_BPS: u16 = 0;
/// Founder shares the Split model may use (PRODUCT DECISION: 25/50/75).
/// Arbitrary splits are deliberately not allowed until their economics are
/// reviewed; the UI offers exactly these choices.
#[constant]
pub const ALLOWED_SPLIT_BPS: [u16; 3] = [2_500, 5_000, 7_500];

/// Shortest claim window an epoch may have (PRODUCT DECISION: 14 days).
///
/// The `short-windows` Cargo feature (tests only, see Cargo.toml) lowers this
/// to 60 seconds so that the deadline, sweep and close_claim_status paths can
/// be exercised against a real clock. The IDL of such a build carries the short
/// value, so a client can tell the two apart.
#[cfg(not(feature = "short-windows"))]
#[constant]
pub const MIN_CLAIM_WINDOW_SECS: i64 = 14 * 86_400;
/// Test build (`--features short-windows`): see the production value above.
#[cfg(feature = "short-windows")]
#[constant]
pub const MIN_CLAIM_WINDOW_SECS: i64 = 60;
/// Longest claim window an epoch may have (PRODUCT DECISION: 365 days).
#[constant]
pub const MAX_CLAIM_WINDOW_SECS: i64 = 365 * 86_400;

/// A proof of 32 hashes covers a tree of 2^32 leaves, more than `num_leaves`
/// (a u32) can ever address. Longer proofs are rejected before any hashing.
pub const MAX_PROOF_LEN: usize = 32;

/// Length of the human reference tag stored in the config.
pub const CITY_TAG_LEN: usize = 32;

/// An all-zero hash. Used as "no Merkle root" for Creator-model epochs.
pub const ZERO_HASH: [u8; 32] = [0u8; 32];
