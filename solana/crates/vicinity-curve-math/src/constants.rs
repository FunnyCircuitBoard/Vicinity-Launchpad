//! Compiled constants of VICINITY-CURVE-DESIGN.md 3.2 that the math uses, and
//! the fixed layout facts of the `Coin` account (3.7) that `decode_coin` checks.
//!
//! The program re-exports the policy values with `#[constant]` so that they
//! appear in its IDL; this crate is their single definition.

/// Raw units minted once per coin: 1,000,000,000 coins at 6 decimals (R8).
pub const COIN_SUPPLY: u64 = 1_000_000_000_000_000;

/// Decimals of every coin mint (R8).
pub const COIN_DECIMALS: u8 = 6;

/// Basis-point denominator `D`.
pub const BPS: u64 = 10_000;

/// A config's five shares never add up to more than 2.5% (R2, R4, V1).
pub const MAX_TOTAL_FEE_BPS: u16 = 250;

/// Smallest total fee a config may have (V1): keeps the buyback cap and the MEV
/// bounds meaningful. Also the least a trader credited the founder's share,
/// the holders' share or both pays per leg (V2b).
pub const MIN_TOTAL_FEE_BPS: u16 = 1;

/// Vicinity's own share never exceeds 1.2% (V2).
pub const MAX_PLATFORM_FEE_BPS: u16 = 120;

/// A founder's share never exceeds 1.0% (V2); with the holders' share it is
/// never the whole fee (V2b).
pub const MAX_FOUNDER_FEE_BPS: u16 = 100;

/// Smallest `sol_in` of a buy, 0.0001 SOL (5.2, O5). Sells have no minimum.
pub const MIN_TRADE_LAMPORTS: u64 = 100_000;

/// `C`: a buyback run spends at most `depth * total_fee_bps / (C * D)`
/// (0.1% of depth at 2.5%).
pub const BUYBACK_CAP_DIVISOR: u64 = 25;

/// At most one buyback per coin per interval; the first at least this many
/// slots after the launch slot.
pub const BUYBACK_INTERVAL_SLOTS: u64 = 150;

/// V11: a hold through fewer runs than this is unprofitable for any trader.
pub const BUYBACK_MIN_HORIZON_RUNS: u64 = 20;

/// V11: the same for an attacker credited his own share on both legs.
pub const BUYBACK_MIN_HORIZON_RUNS_FOUNDER: u64 = 15;

/// V8: the conservative single-run bound is at most 99 percent.
pub const MEV_MAX_PERCENT: u64 = 99;

/// Most raw units a config may burn at launch (`COIN_SUPPLY - S - P`).
pub const MAX_DUST_RAW: u64 = 1_000_000_000;

/// Bound on `virtual_sol` and `virtual_tokens` (5.12): 2^60.
pub const MAX_VIRTUAL: u64 = 1 << 60;

/// Smallest graduation target, 1 SOL (V5).
pub const MIN_GRADUATION_LAMPORTS: u64 = 1_000_000_000;

/// Largest graduation target, 10,000 SOL (V5).
pub const MAX_GRADUATION_LAMPORTS: u64 = 10_000_000_000_000;

/// V7: the pool opens at most this many parts per 10^9 below the curve's last
/// price, never above.
pub const CONTINUITY_PPB: u64 = 1;

/// Denominator of [`CONTINUITY_PPB`].
pub const PPB: u64 = 1_000_000_000;

/// R8 cap on a config's launch fee, 0.5 SOL (V9).
pub const MAX_LAUNCH_FEE_LAMPORTS: u64 = 500_000_000;

/// Half-width of 5.9's integer search around the continuous `x0*` used by
/// [`crate::derive_curve`].
pub const DERIVE_CURVE_RADIUS: u64 = 20_000;

/// `vicinity_curve` program id compiled into this crate (the owner that
/// `decode_coin` requires): the localnet and devnet throwaway key
/// `nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk` (3.1). Mainnet uses a key the
/// owner generates; it replaces this value together with the program's
/// `declare_id!`.
pub const PROGRAM_ID: [u8; 32] = [
    11, 181, 32, 249, 119, 40, 115, 85, 183, 22, 201, 43, 218, 117, 161, 239, 207, 93, 175, 198,
    154, 87, 224, 20, 129, 8, 58, 228, 223, 46, 28, 73,
];

/// Anchor discriminator of the `CurveCoin` account:
/// `sha256("account:CurveCoin")[..8]` (3.7).
pub const CURVE_COIN_DISCRIMINATOR: [u8; 8] = [222, 133, 204, 32, 124, 103, 133, 230];

/// Size of the `Coin` account including the discriminator (3.3, 3.7).
pub const COIN_ACCOUNT_LEN: usize = 693;

/// `Coin.layout_version` written by `launch` (3.7).
pub const COIN_LAYOUT_VERSION: u8 = 1;
