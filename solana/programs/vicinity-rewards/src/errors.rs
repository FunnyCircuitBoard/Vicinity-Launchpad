//! One error per failure mode. Messages are written for the person reading a
//! failed transaction in an explorer, so they say what was wrong, not where.

use anchor_lang::prelude::*;

#[error_code]
pub enum RewardsError {
    #[msg("founder_bps does not match the reward model (Creator = 10000, Holders = 0, Split = an allowed split)")]
    FounderBpsMismatch,
    #[msg(
        "founder_bps for the Split model must be one of ALLOWED_SPLIT_BPS (see the IDL constants)"
    )]
    SplitBpsNotAllowed,
    #[msg("founder_bps is greater than 10000")]
    InvalidFounderBps,
    #[msg("the reward mint must not be the city coin itself")]
    RewardMintIsCityCoin,
    #[msg("the reward mint uses a Token-2022 extension the vault cannot account for (transfer fee, transfer hook, permanent delegate, non-transferable, confidential transfers, default account state, mint close authority, or an unknown extension)")]
    UnsupportedRewardMint,
    #[msg("city_tag must be printable ASCII followed by zero padding")]
    InvalidCityTag,
    #[msg("founder must not be the zero address")]
    InvalidFounder,
    #[msg("founder must not be an account of this program (config, vault, registry, epoch, claim status): nothing could ever move money out of its token account")]
    FounderIsProgramAccount,
    #[msg("signer is not the config authority (or, for init_city, not the registry admin)")]
    Unauthorized,
    #[msg("signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("admin must not be the zero address")]
    InvalidAdmin,
    #[msg("no admin transfer is pending")]
    NoPendingAdmin,
    #[msg("signer is not the pending admin")]
    NotPendingAdmin,
    #[msg("config is already locked")]
    AlreadyLocked,
    #[msg("no authority transfer is pending")]
    NoPendingAuthority,
    #[msg("signer is not the pending authority")]
    NotPendingAuthority,
    #[msg("config is already paused")]
    AlreadyPaused,
    #[msg("config is not paused")]
    NotPaused,
    #[msg("funding and claiming are paused for this city")]
    Paused,
    #[msg("claim_window_secs is outside [MIN_CLAIM_WINDOW_SECS, MAX_CLAIM_WINDOW_SECS] (see the IDL constants)")]
    ClaimWindowOutOfRange,
    #[msg(
        "nothing to distribute: the deposit (or the vault surplus) is 0 and there is no carry-over"
    )]
    NothingToDistribute,
    #[msg("Creator model: the holders amount must be 0 (no holder share and no carry-over)")]
    CreatorModelHasHolderFunds,
    #[msg("Creator model: num_leaves must be 0 and merkle_root must be all zeros")]
    CreatorModelHasTree,
    #[msg("Holders and Split models: merkle_root must not be all zeros")]
    MissingMerkleRoot,
    #[msg("Holders and Split models: num_leaves must be greater than 0")]
    MissingLeaves,
    #[msg("Holders and Split models: snapshot_hash must not be all zeros (the root must be recomputable from a published snapshot)")]
    MissingSnapshotHash,
    #[msg("epoch index does not match the epoch account")]
    EpochIndexMismatch,
    #[msg("epoch is not open")]
    EpochNotOpen,
    #[msg("the claim deadline has passed")]
    ClaimDeadlinePassed,
    #[msg("the claim deadline has not passed yet")]
    ClaimDeadlineNotPassed,
    #[msg("leaf_index must be smaller than num_leaves")]
    LeafIndexOutOfRange,
    #[msg("claim amount must be greater than 0")]
    ZeroClaimAmount,
    #[msg("proof is longer than 32 hashes")]
    ProofTooLong,
    #[msg("Merkle proof does not verify for this leaf (wrong index, wallet, amount or proof)")]
    InvalidProof,
    #[msg("claim would exceed the epoch's holders amount")]
    ClaimExceedsHoldersAmount,
    #[msg("epoch already has claims; it can only be swept after the deadline")]
    EpochHasClaims,
    #[msg("epoch is still open; a claim status can be closed only after sweep or cancel")]
    EpochStillOpen,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
