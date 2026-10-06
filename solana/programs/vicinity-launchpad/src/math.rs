//! Small pure helpers, unit-tested below: the fee split, the metadata URL,
//! name and symbol rules, the ProgramData header and the `vicinity_rewards`
//! CityConfig reader. Nothing here touches accounts.

use anchor_lang::prelude::*;

use crate::constants::{MAX_NAME_LEN, MAX_SYMBOL_LEN, METADATA_URI_PREFIX};
use crate::errors::LaunchpadError;

/// Split a harvested amount `c` between the founder vault and the holders pot.
/// The founder gets the floor of half, holders the rest (the odd unit), so
/// `to_holders + to_founder == c` exactly and `to_founder <= to_holders <= to_founder + 1`.
/// Returns `(to_holders, to_founder)`.
pub fn split_fee(c: u64) -> (u64, u64) {
    let to_founder = c / 2;
    // c - floor(c/2) can never underflow.
    let to_holders = c - to_founder;
    (to_holders, to_founder)
}

/// `https://vicinity.city/coin-meta/<base58 mint>.json`. Keyed by the mint, so
/// the URL of a coin cannot be known before the coin exists.
pub fn metadata_uri(mint: &Pubkey) -> String {
    let mut s = String::with_capacity(METADATA_URI_PREFIX.len() + 44 + 5);
    s.push_str(METADATA_URI_PREFIX);
    s.push_str(&mint.to_string());
    s.push_str(".json");
    s
}

/// 1 to 32 bytes, no control characters (UTF-8 is otherwise allowed: city
/// names such as "São Paulo" are real).
pub fn check_name(name: &str) -> Result<()> {
    require!(
        !name.is_empty()
            && name.len() <= MAX_NAME_LEN as usize
            && !name.chars().any(|c| c.is_control()),
        LaunchpadError::BadName
    );
    Ok(())
}

/// 1 to 10 bytes of `A-Z0-9` (the city ticker from tickers.json).
pub fn check_symbol(symbol: &str) -> Result<()> {
    require!(
        !symbol.is_empty()
            && symbol.len() <= MAX_SYMBOL_LEN as usize
            && symbol
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
        LaunchpadError::BadSymbol
    );
    Ok(())
}

/// Reads the upgrade authority from a BPF upgradeable loader ProgramData
/// account, parsing the 45-byte bincode header by hand (u32 tag = 3, u64 slot,
/// u8 option = 1, 32-byte authority) instead of using Anchor's `ProgramData`
/// type, whose codec costs about 120 KB of program size. Returns `None` when
/// the data is not a ProgramData account or the program is immutable.
pub fn program_data_upgrade_authority(data: &[u8]) -> Option<Pubkey> {
    if data.len() < 45 {
        return None;
    }
    let tag = u32::from_le_bytes(data[0..4].try_into().ok()?);
    if tag != 3 || data[12] != 1 {
        return None;
    }
    Some(Pubkey::new_from_array(data[13..45].try_into().ok()?))
}

/// The three fields of an SPL token account (classic or Token-2022: the base
/// layout is the same) that `harvest_pool_fees` checks on the position NFT
/// account: mint (bytes 0..32), holder (32..64), amount (64..72), and that it
/// is initialized (byte 108 == 1). Parsed by hand so the program carries no
/// Token-2022 extension code.
pub fn read_token_account_base(data: &[u8]) -> Option<(Pubkey, Pubkey, u64)> {
    if data.len() < 165 || data[108] != 1 {
        return None;
    }
    let mint = Pubkey::new_from_array(data[0..32].try_into().ok()?);
    let owner = Pubkey::new_from_array(data[32..64].try_into().ok()?);
    let amount = u64::from_le_bytes(data[64..72].try_into().ok()?);
    Some((mint, owner, amount))
}

/// Anchor discriminator of `vicinity_rewards::state::CityConfig`
/// (sha256("account:CityConfig")[..8]; also in sdk/idl/vicinity_rewards.json).
pub const REWARDS_CITY_CONFIG_DISCRIMINATOR: [u8; 8] = [14, 136, 110, 28, 46, 68, 178, 115];
/// `vicinity_rewards::state::RewardModel::Holders` as Borsh encodes it.
pub const REWARDS_MODEL_HOLDERS: u8 = 1;

/// The fields of a `vicinity_rewards` CityConfig that decide where the
/// holders' money can go. Layout (Borsh, after the 8-byte discriminator):
/// authority 32, pending_authority 32, founder 32, city_coin_mint 32,
/// reward_mint 32, vault 32, reward_model u8, founder_bps u16 LE, ...
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RewardsCityConfigView {
    pub city_coin_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub vault: Pubkey,
    pub reward_model: u8,
    pub founder_bps: u16,
}

pub fn read_rewards_city_config(data: &[u8]) -> Result<RewardsCityConfigView> {
    require!(
        data.len() >= 203 && data[0..8] == REWARDS_CITY_CONFIG_DISCRIMINATOR,
        LaunchpadError::WrongRewardsConfig
    );
    let key = |at: usize| Pubkey::new_from_array(data[at..at + 32].try_into().unwrap());
    Ok(RewardsCityConfigView {
        city_coin_mint: key(104),
        reward_mint: key(136),
        vault: key(168),
        reward_model: data[200],
        founder_bps: u16::from_le_bytes([data[201], data[202]]),
    })
}

/// The holders' share may only go to a rewards config that pays holders only
/// (model Holders, 0% founder), in the coin's quote token, through the vault
/// we are about to pay. Under Creator or Split, `fund_epoch_from_vault` would
/// pay part of it to `config.founder`, which the rewards authority can change.
pub fn check_rewards_config(
    view: &RewardsCityConfigView,
    coin_mint: &Pubkey,
    quote_mint: &Pubkey,
    vault: &Pubkey,
) -> Result<()> {
    require!(
        view.city_coin_mint == *coin_mint
            && view.reward_model == REWARDS_MODEL_HOLDERS
            && view.founder_bps == 0
            && view.reward_mint == *quote_mint
            && view.vault == *vault,
        LaunchpadError::WrongRewardsConfig
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic xorshift64*, so the property loops need no extra crate
    /// and every run checks the same cases.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
    }

    #[test]
    fn split_examples() {
        assert_eq!(split_fee(0), (0, 0));
        assert_eq!(split_fee(1), (1, 0));
        assert_eq!(split_fee(2), (1, 1));
        assert_eq!(split_fee(1_001), (501, 500));
        assert_eq!(split_fee(u64::MAX), (u64::MAX / 2 + 1, u64::MAX / 2));
    }

    #[test]
    fn split_properties() {
        let mut r = Rng(0x9E37_79B9_7F4A_7C15);
        let mut cases: Vec<u64> = (0..64).collect();
        cases.extend([u64::MAX, u64::MAX - 1, 1 << 63, (1 << 63) - 1]);
        for _ in 0..200_000 {
            // Mix full-range values with small ones (where off-by-one bugs hide).
            let v = r.next();
            cases.push(if v & 1 == 0 { v } else { v % 10_000 });
        }
        for c in cases {
            let (h, f) = split_fee(c);
            assert_eq!(
                h as u128 + f as u128,
                c as u128,
                "nothing created or lost for {c}"
            );
            assert!(f <= h && h <= f + 1, "holders get the odd unit for {c}");
            assert_eq!(f, c / 2);
        }
    }

    #[test]
    fn split_is_additive_over_harvests() {
        // Invariant 3: founder_accrued <= holders_accrued <= founder_accrued + harvests.
        let mut r = Rng(42);
        let (mut h, mut f, mut n) = (0u128, 0u128, 0u128);
        for _ in 0..10_000 {
            let c = r.next() % 1_000_000_007;
            let (a, b) = split_fee(c);
            h += a as u128;
            f += b as u128;
            if c > 0 {
                n += 1;
            }
            assert!(f <= h && h <= f + n);
        }
    }

    #[test]
    fn uri_is_keyed_by_mint() {
        let mint = Pubkey::new_from_array([7u8; 32]);
        let uri = metadata_uri(&mint);
        assert_eq!(uri, format!("https://vicinity.city/coin-meta/{mint}.json"));
        assert!(uri.len() <= 200, "Metaplex URI limit");
        // the longest base58 pubkey is 44 chars
        let max = metadata_uri(&Pubkey::new_from_array([255u8; 32]));
        assert!(max.len() <= 81);
    }

    #[test]
    fn names() {
        assert!(check_name("New York City Coin").is_ok());
        assert!(check_name("São Paulo").is_ok());
        assert!(check_name(&"a".repeat(32)).is_ok());
        assert!(check_name(&"a".repeat(33)).is_err());
        assert!(check_name("").is_err());
        assert!(check_name("bad\nname").is_err());
        assert!(check_name("bad\u{0}").is_err());
        // 32 bytes is the limit, not 32 characters
        assert!(check_name(&"é".repeat(17)).is_err());
    }

    #[test]
    fn symbols() {
        for ok in ["NYC", "A", "SAOPAULO", "X1", "ABCDEFGHIJ"] {
            assert!(check_symbol(ok).is_ok(), "{ok}");
        }
        for bad in ["", "nyc", "NY C", "ABCDEFGHIJK", "NY-C", "ÉÉ", "$NYC"] {
            assert!(check_symbol(bad).is_err(), "{bad:?}");
        }
    }

    fn program_data(tag: u32, option: u8, auth: [u8; 32]) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&tag.to_le_bytes());
        d.extend_from_slice(&123u64.to_le_bytes());
        d.push(option);
        d.extend_from_slice(&auth);
        d.extend_from_slice(&[0x7f; 100]); // the ELF follows
        d
    }

    #[test]
    fn program_data_header() {
        let a = [9u8; 32];
        assert_eq!(
            program_data_upgrade_authority(&program_data(3, 1, a)),
            Some(Pubkey::new_from_array(a))
        );
        // immutable program: option = 0
        assert_eq!(program_data_upgrade_authority(&program_data(3, 0, a)), None);
        // a Program account (tag 2) or a Buffer (tag 1) is not ProgramData
        assert_eq!(program_data_upgrade_authority(&program_data(2, 1, a)), None);
        assert_eq!(program_data_upgrade_authority(&program_data(1, 1, a)), None);
        assert_eq!(program_data_upgrade_authority(&[3, 0, 0, 0]), None);
    }

    fn city_config(model: u8, bps: u16, mint: Pubkey, reward: Pubkey, vault: Pubkey) -> Vec<u8> {
        let mut d = REWARDS_CITY_CONFIG_DISCRIMINATOR.to_vec();
        d.extend_from_slice(&[1u8; 32]); // authority
        d.extend_from_slice(&[0u8; 32]); // pending
        d.extend_from_slice(&[2u8; 32]); // founder
        d.extend_from_slice(mint.as_ref());
        d.extend_from_slice(reward.as_ref());
        d.extend_from_slice(vault.as_ref());
        d.push(model);
        d.extend_from_slice(&bps.to_le_bytes());
        d.extend_from_slice(&[0u8; 100]);
        d
    }

    #[test]
    fn token_account_base() {
        let (mint, holder) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut d = vec![0u8; 182]; // Token-2022 accounts are longer than 165
        d[0..32].copy_from_slice(mint.as_ref());
        d[32..64].copy_from_slice(holder.as_ref());
        d[64..72].copy_from_slice(&1u64.to_le_bytes());
        d[108] = 1;
        assert_eq!(read_token_account_base(&d), Some((mint, holder, 1)));
        d[108] = 2; // frozen
        assert_eq!(read_token_account_base(&d), None);
        d[108] = 1;
        assert_eq!(read_token_account_base(&d[..164]), None);
    }

    #[test]
    fn discriminator_matches_anchor() {
        let h = anchor_lang::solana_program::hash::hash(b"account:CityConfig");
        assert_eq!(h.to_bytes()[..8], REWARDS_CITY_CONFIG_DISCRIMINATOR);
    }

    #[test]
    fn rewards_config_rules() {
        let (mint, quote, vault) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        let ok = city_config(1, 0, mint, quote, vault);
        let v = read_rewards_city_config(&ok).unwrap();
        assert!(check_rewards_config(&v, &mint, &quote, &vault).is_ok());

        let bad = [
            city_config(0, 10_000, mint, quote, vault), // Creator
            city_config(2, 2_500, mint, quote, vault),  // Split
            city_config(1, 1, mint, quote, vault),      // Holders but founder share
            city_config(1, 0, Pubkey::new_unique(), quote, vault), // other coin
            city_config(1, 0, mint, Pubkey::new_unique(), vault), // other reward token
            city_config(1, 0, mint, quote, Pubkey::new_unique()), // other vault
        ];
        for d in bad {
            let v = read_rewards_city_config(&d).unwrap();
            assert!(check_rewards_config(&v, &mint, &quote, &vault).is_err());
        }
        let mut wrong_disc = ok.clone();
        wrong_disc[0] ^= 1;
        assert!(read_rewards_city_config(&wrong_disc).is_err());
        assert!(read_rewards_city_config(&ok[..100]).is_err());
    }
}
