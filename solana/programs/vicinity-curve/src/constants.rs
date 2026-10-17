//! Compiled constants (VICINITY-CURVE-DESIGN.md 3.2).
//!
//! Everything marked `#[constant]` is policy and is copied into the IDL
//! (`constants` section), so clients read the values the deployed binary
//! enforces. The economic values are defined once, in the math crate
//! (`vicinity_curve_math::constants`), and re-exported here.
//!
//! The ids of the other programs are compiled per cluster: the default build
//! (mainnet, and the localnet tests, which load the real programs at their
//! mainnet addresses) and the `devnet` build (3.2, C03).

use anchor_lang::prelude::*;
use vicinity_curve_math::constants as m;

/// R9: the only destination of platform fees and launch fees. Changing it
/// needs a program upgrade.
#[constant]
pub const FEE_RECIPIENT: Pubkey = pubkey!("13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN");

/// Compiled program ids of the two clusters (3.2, C03). Unit test U12 checks
/// `LEGACY_LAUNCHPAD` of each against its derivation; the selected set is the
/// one below.
pub mod cluster {
    use anchor_lang::prelude::*;

    /// `vicinity_rewards`, mainnet.
    pub const MAINNET_REWARDS_PROGRAM_ID: Pubkey =
        pubkey!("EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG");
    /// `vicinity_rewards`, devnet (LAUNCHPAD-DEVNET.md).
    pub const DEVNET_REWARDS_PROGRAM_ID: Pubkey =
        pubkey!("Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi");
    /// The old `vicinity_launchpad`, mainnet.
    pub const MAINNET_LEGACY_PROGRAM_ID: Pubkey =
        pubkey!("AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai");
    /// The old `vicinity_launchpad`, devnet.
    pub const DEVNET_LEGACY_PROGRAM_ID: Pubkey =
        pubkey!("Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7");
    /// `find_program_address(["launchpad"], MAINNET_LEGACY_PROGRAM_ID)`.
    pub const MAINNET_LEGACY_LAUNCHPAD: Pubkey =
        pubkey!("4g9KRZ76Mpw6HCCu713yEGzm1txdCod3S1SugL7M9GwN");
    /// `find_program_address(["launchpad"], DEVNET_LEGACY_PROGRAM_ID)`.
    pub const DEVNET_LEGACY_LAUNCHPAD: Pubkey =
        pubkey!("ppX3a7oUKmZg2aAmxct8LnKdxNAcoGFDowcyzvbTsbw");
}

/// Owner of every `vicinity_rewards` city config and vault the holders' share
/// may go to (mainnet build; the localnet tests load the real program here).
#[cfg(not(feature = "devnet"))]
#[constant]
pub const REWARDS_PROGRAM_ID: Pubkey = cluster::MAINNET_REWARDS_PROGRAM_ID;
/// Owner of every `vicinity_rewards` city config and vault (devnet build).
#[cfg(feature = "devnet")]
#[constant]
pub const REWARDS_PROGRAM_ID: Pubkey = cluster::DEVNET_REWARDS_PROGRAM_ID;

/// The old `vicinity_launchpad` program whose `Coin`, `Approval` and
/// `Launchpad` accounts are checked for R1 (mainnet build).
#[cfg(not(feature = "devnet"))]
#[constant]
pub const LEGACY_PROGRAM_ID: Pubkey = cluster::MAINNET_LEGACY_PROGRAM_ID;
/// The old `vicinity_launchpad` program (devnet build).
#[cfg(feature = "devnet")]
#[constant]
pub const LEGACY_PROGRAM_ID: Pubkey = cluster::DEVNET_LEGACY_PROGRAM_ID;

/// The old program's global account, `find_program_address(["launchpad"],
/// LEGACY_PROGRAM_ID)` (mainnet build; unit test U12 checks the derivation).
#[cfg(not(feature = "devnet"))]
#[constant]
pub const LEGACY_LAUNCHPAD: Pubkey = cluster::MAINNET_LEGACY_LAUNCHPAD;
/// The old program's global account (devnet build).
#[cfg(feature = "devnet")]
#[constant]
pub const LEGACY_LAUNCHPAD: Pubkey = cluster::DEVNET_LEGACY_LAUNCHPAD;

/// `sha256("account:Launchpad")[..8]`: the old program's `Launchpad`
/// discriminator (equal to this program's, the struct keeps its name).
#[constant]
pub const LEGACY_LAUNCHPAD_DISCRIMINATOR: [u8; 8] = [247, 20, 16, 242, 203, 38, 169, 160];
/// Size of the old program's `Launchpad` (discriminator, five Pubkeys,
/// `launches_paused`, `payouts_paused`, `bump`).
#[constant]
pub const LEGACY_LAUNCHPAD_LEN: u64 = 171;
/// Offset of `launches_paused` in the old program's `Launchpad`.
#[constant]
pub const LEGACY_LAUNCHES_PAUSED_AT: u64 = 168;
/// Offset of `admin` in the old program's `Launchpad` (8.5, GOV-1): it must
/// be this program's admin at every approval and launch.
#[constant]
pub const LEGACY_ADMIN_AT: u64 = 8;
/// Offset of `pending_admin` in the old program's `Launchpad`: it must be
/// zero at every approval and launch.
#[constant]
pub const LEGACY_PENDING_ADMIN_AT: u64 = 40;

/// 1,000,000,000 coins at 6 decimals, minted once per coin (R8).
#[constant]
pub const COIN_SUPPLY: u64 = m::COIN_SUPPLY;
/// Decimals of every coin (R8).
#[constant]
pub const COIN_DECIMALS: u8 = m::COIN_DECIMALS;
/// Basis-point denominator `D`.
#[constant]
pub const BPS: u64 = m::BPS;
/// A config's five shares never add up to more than 2.5% (R2, V1).
#[constant]
pub const MAX_TOTAL_FEE_BPS: u16 = m::MAX_TOTAL_FEE_BPS;
/// Smallest total fee of a config (V1).
#[constant]
pub const MIN_TOTAL_FEE_BPS: u16 = m::MIN_TOTAL_FEE_BPS;
/// Vicinity's own share never exceeds 1.2% (V2).
#[constant]
pub const MAX_PLATFORM_FEE_BPS: u16 = m::MAX_PLATFORM_FEE_BPS;
/// A founder's share never exceeds 1.0% (V2).
#[constant]
pub const MAX_FOUNDER_FEE_BPS: u16 = m::MAX_FOUNDER_FEE_BPS;
/// Smallest `sol_in` of a buy, 0.0001 SOL; sells have no minimum (O5).
#[constant]
pub const MIN_TRADE_LAMPORTS: u64 = m::MIN_TRADE_LAMPORTS;
/// `C`: a buyback spends at most `depth * total_fee_bps / (C * D)`.
#[constant]
pub const BUYBACK_CAP_DIVISOR: u64 = m::BUYBACK_CAP_DIVISOR;
/// At most one buyback per coin per interval; the first at least this many
/// slots after launch.
#[constant]
pub const BUYBACK_INTERVAL_SLOTS: u64 = m::BUYBACK_INTERVAL_SLOTS;
/// V11 horizon for any trader.
#[constant]
pub const BUYBACK_MIN_HORIZON_RUNS: u64 = m::BUYBACK_MIN_HORIZON_RUNS;
/// V11 horizon for an attacker credited his own share.
#[constant]
pub const BUYBACK_MIN_HORIZON_RUNS_FOUNDER: u64 = m::BUYBACK_MIN_HORIZON_RUNS_FOUNDER;
/// V8: the conservative single-run bound is at most this percentage.
#[constant]
pub const MEV_MAX_PERCENT: u64 = m::MEV_MAX_PERCENT;
/// Most raw units a config may burn at launch.
#[constant]
pub const MAX_DUST_RAW: u64 = m::MAX_DUST_RAW;
/// Bound on `virtual_sol` and `virtual_tokens` (2^60).
#[constant]
pub const MAX_VIRTUAL: u64 = m::MAX_VIRTUAL;
/// Smallest graduation target, 1 SOL.
#[constant]
pub const MIN_GRADUATION_LAMPORTS: u64 = m::MIN_GRADUATION_LAMPORTS;
/// Largest graduation target, 10,000 SOL.
#[constant]
pub const MAX_GRADUATION_LAMPORTS: u64 = m::MAX_GRADUATION_LAMPORTS;
/// V7: the pool opens at most this many parts per 10^9 below the curve's last
/// price, never above.
#[constant]
pub const CONTINUITY_PPB: u64 = m::CONTINUITY_PPB;
/// R8 cap on a config's launch fee, 0.5 SOL.
#[constant]
pub const MAX_LAUNCH_FEE_LAMPORTS: u64 = m::MAX_LAUNCH_FEE_LAMPORTS;
/// An approval lasts at most 30 days.
#[constant]
pub const APPROVAL_MAX_SECS: i64 = 30 * 86_400;
/// At most one opted-in payout per coin per 24 hours.
#[constant]
pub const PAYOUT_COOLDOWN_SECS: i64 = 86_400;
/// Every coin's metadata URI is this prefix, the mint (base58) and ".json".
#[constant]
pub const METADATA_URI_PREFIX: &str = "https://vicinity.city/coin-meta/";
/// Longest on-chain coin name (Metaplex limit), in bytes.
#[constant]
pub const MAX_NAME_LEN: u8 = 32;
/// Longest ticker (Metaplex limit), in bytes of `A-Z0-9`.
#[constant]
pub const MAX_SYMBOL_LEN: u8 = 10;
/// Metaplex Token Metadata program (metadata for classic SPL coins).
#[constant]
pub const METAPLEX_PROGRAM_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
/// Reward mint of every city's rewards vault (WSOL).
#[constant]
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// `sha256("account:CityConfig")[..8]` of `vicinity_rewards`.
pub const REWARDS_CITY_CONFIG_DISCRIMINATOR: [u8; 8] = [14, 136, 110, 28, 46, 68, 178, 115];
/// `vicinity_rewards::state::RewardModel::Holders` as Borsh encodes it.
pub const REWARDS_MODEL_HOLDERS: u8 = 1;

// ---- account sizes, discriminator included (3.3) ----

/// `Launchpad` (3.4).
pub const LAUNCHPAD_LEN: usize = 238;
/// `LaunchConfig` (3.5).
pub const LAUNCH_CONFIG_LEN: usize = 144;
/// `Approval` at its largest (3.6).
pub const APPROVAL_LEN: usize = 181;
/// `Coin` / `CurveCoin` (3.7).
pub const COIN_LEN: usize = m::COIN_ACCOUNT_LEN;
/// `TickerLock` (3.8).
pub const TICKER_LOCK_LEN: usize = 49;
/// `PayoutOptIn` (3.9).
pub const PAYOUT_OPT_IN_LEN: usize = 145;

// ---- seeds (3.2) ----

/// `["launchpad"]`.
pub const LAUNCHPAD_SEED: &[u8] = b"launchpad";
/// `["config", config_id u16 LE]`.
pub const CONFIG_SEED: &[u8] = b"config";
/// `["approval", city_id u64 LE]`.
pub const APPROVAL_SEED: &[u8] = b"approval";
/// `["coin", city_id u64 LE]`.
pub const COIN_SEED: &[u8] = b"coin";
/// `["mint", coin]`.
pub const MINT_SEED: &[u8] = b"mint";
/// `["coin_vault", coin]`.
pub const COIN_VAULT_SEED: &[u8] = b"coin_vault";
/// `["ticker", symbol bytes]`.
pub const TICKER_SEED: &[u8] = b"ticker";
/// `["payout_opt_in", coin]`.
pub const PAYOUT_OPT_IN_SEED: &[u8] = b"payout_opt_in";
/// `vicinity_rewards`: city config `["city", city_coin_mint]`.
pub const REWARDS_CITY_SEED: &[u8] = b"city";
/// `vicinity_rewards`: vault `["vault", config]`.
pub const REWARDS_VAULT_SEED: &[u8] = b"vault";
/// Old program: `["coin", city_id u64 LE]`.
pub const LEGACY_COIN_SEED: &[u8] = b"coin";
/// Old program: `["approval", city_id u64 LE]`.
pub const LEGACY_APPROVAL_SEED: &[u8] = b"approval";
/// Old program: `["launchpad"]`.
pub const LEGACY_LAUNCHPAD_SEED: &[u8] = b"launchpad";
/// Metaplex: `["metadata", METAPLEX_PROGRAM_ID, mint]`.
pub const METADATA_SEED: &[u8] = b"metadata";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn idl(name: &str) -> Value {
        let path = format!("{}/../../sdk/idl/{name}.json", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        serde_json::from_str(&text).unwrap()
    }

    fn struct_fields<'a>(idl: &'a Value, name: &str) -> &'a Vec<Value> {
        idl["types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .unwrap_or_else(|| panic!("type {name}"))["type"]["fields"]
            .as_array()
            .unwrap()
    }

    /// Borsh size of the fixed-size field types these layouts use.
    fn size_of(ty: &Value) -> usize {
        match ty.as_str() {
            Some("pubkey") => 32,
            Some("bool") | Some("u8") => 1,
            Some("u16") => 2,
            Some("u64") | Some("i64") => 8,
            // A fieldless enum (RewardModel) is one byte in Borsh.
            _ if ty.get("defined").is_some() => 1,
            other => panic!("unexpected field type {other:?}"),
        }
    }

    /// Offset of `field` in an Anchor account (8-byte discriminator first).
    fn offset_of(fields: &[Value], field: &str) -> usize {
        let mut at = 8;
        for f in fields {
            if f["name"] == field {
                return at;
            }
            at += size_of(&f["type"]);
        }
        panic!("field {field}");
    }

    fn account_discriminator(idl: &Value, name: &str) -> Vec<u8> {
        idl["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == name)
            .unwrap()["discriminator"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_u64().unwrap() as u8)
            .collect()
    }

    /// U12 (12.1): `LEGACY_LAUNCHPAD` equals its derivation for each cluster
    /// build, and the compiled set is the one of this build's cluster.
    #[test]
    fn u12_legacy_launchpad_derivations() {
        let derive =
            |program: &Pubkey| Pubkey::find_program_address(&[LEGACY_LAUNCHPAD_SEED], program).0;
        assert_eq!(
            derive(&cluster::MAINNET_LEGACY_PROGRAM_ID),
            cluster::MAINNET_LEGACY_LAUNCHPAD
        );
        assert_eq!(
            derive(&cluster::DEVNET_LEGACY_PROGRAM_ID),
            cluster::DEVNET_LEGACY_LAUNCHPAD
        );
        assert_eq!(derive(&LEGACY_PROGRAM_ID), LEGACY_LAUNCHPAD);
        if cfg!(feature = "devnet") {
            assert_eq!(LEGACY_PROGRAM_ID, cluster::DEVNET_LEGACY_PROGRAM_ID);
            assert_eq!(REWARDS_PROGRAM_ID, cluster::DEVNET_REWARDS_PROGRAM_ID);
        } else {
            assert_eq!(LEGACY_PROGRAM_ID, cluster::MAINNET_LEGACY_PROGRAM_ID);
            assert_eq!(REWARDS_PROGRAM_ID, cluster::MAINNET_REWARDS_PROGRAM_ID);
        }
        // The devnet ids are the deployments the committed IDLs name.
        assert_eq!(
            idl("vicinity_launchpad")["address"].as_str().unwrap(),
            cluster::DEVNET_LEGACY_PROGRAM_ID.to_string()
        );
        assert_eq!(
            idl("vicinity_rewards")["address"].as_str().unwrap(),
            cluster::DEVNET_REWARDS_PROGRAM_ID.to_string()
        );
    }

    /// U12: the legacy discriminator, size and the `launches_paused`, `admin`
    /// and `pending_admin` offsets match
    /// the old program's `Launchpad` (from its committed IDL), and its `Coin`
    /// and `Approval` seeds are the ones this program derives.
    #[test]
    fn u12_legacy_launchpad_layout_and_seeds() {
        let old = idl("vicinity_launchpad");
        assert_eq!(
            account_discriminator(&old, "Launchpad"),
            LEGACY_LAUNCHPAD_DISCRIMINATOR.to_vec()
        );
        let h = anchor_lang::solana_program::hash::hash(b"account:Launchpad").to_bytes();
        assert_eq!(h[..8], LEGACY_LAUNCHPAD_DISCRIMINATOR);
        let fields = struct_fields(&old, "Launchpad");
        let len: usize = 8 + fields.iter().map(|f| size_of(&f["type"])).sum::<usize>();
        assert_eq!(len as u64, LEGACY_LAUNCHPAD_LEN);
        assert_eq!(
            offset_of(fields, "launches_paused") as u64,
            LEGACY_LAUNCHES_PAUSED_AT
        );
        // GOV-1: the admin and pending admin this program compares
        assert_eq!(offset_of(fields, "admin") as u64, LEGACY_ADMIN_AT);
        assert_eq!(
            offset_of(fields, "pending_admin") as u64,
            LEGACY_PENDING_ADMIN_AT
        );
        assert_eq!(fields.iter().filter(|f| f["type"] == "pubkey").count(), 5);

        // Seeds of the old program's approval and coin PDAs (its launch
        // instruction): ["approval", city_id] and ["coin", city_id].
        let launch = old["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["name"] == "launch")
            .unwrap();
        let seed0 = |name: &str| -> Vec<u8> {
            let acc = launch["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["name"] == name)
                .unwrap();
            let seeds = acc["pda"]["seeds"].as_array().unwrap();
            assert_eq!(seeds.len(), 2, "{name}: const + city_id");
            assert_eq!(seeds[1]["path"], "city_id");
            seeds[0]["value"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect()
        };
        assert_eq!(seed0("approval"), LEGACY_APPROVAL_SEED.to_vec());
        assert_eq!(seed0("coin"), LEGACY_COIN_SEED.to_vec());
    }

    /// The hand-read `vicinity_rewards` CityConfig offsets (helpers.rs) match
    /// its committed IDL, and `REWARDS_MODEL_HOLDERS` is the `Holders` variant.
    #[test]
    fn rewards_city_config_layout() {
        let rw = idl("vicinity_rewards");
        assert_eq!(
            account_discriminator(&rw, "CityConfig"),
            REWARDS_CITY_CONFIG_DISCRIMINATOR.to_vec()
        );
        let fields = struct_fields(&rw, "CityConfig");
        let want = [
            ("authority", 8),
            ("pending_authority", 40),
            ("city_coin_mint", 104),
            ("reward_mint", 136),
            ("vault", 168),
            ("reward_model", 200),
            ("founder_bps", 201),
        ];
        for (name, at) in want {
            assert_eq!(offset_of(fields, name), at, "{name}");
        }
        let variants = rw["types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "RewardModel")
            .unwrap()["type"]["variants"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(
            variants[REWARDS_MODEL_HOLDERS as usize]["name"], "Holders",
            "Borsh index of Holders"
        );
    }

    /// Program ids this crate pins match the libraries' own constants.
    #[test]
    fn pinned_program_ids() {
        assert_eq!(METAPLEX_PROGRAM_ID, anchor_spl::metadata::ID);
        assert_eq!(NATIVE_MINT, anchor_spl::token::spl_token::native_mint::ID);
        assert_eq!(vicinity_curve_math::constants::COIN_ACCOUNT_LEN, COIN_LEN);
        assert_eq!(APPROVAL_MAX_SECS, 2_592_000);
        assert_eq!(PAYOUT_COOLDOWN_SECS, 86_400);
        assert_eq!(
            FEE_RECIPIENT.to_string(),
            "13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN"
        );
    }
}
