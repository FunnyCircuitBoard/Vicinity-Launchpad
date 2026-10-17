//! Small pure helpers, unit-tested below: name and ticker rules, the metadata
//! URI, payout-key separation, the ProgramData header, the `vicinity_rewards`
//! CityConfig reader, the old program's `Launchpad` checks and the arithmetic
//! of the single debit helper (6.5). Nothing here moves money.

use anchor_lang::prelude::*;

use crate::constants::{
    FEE_RECIPIENT, LEGACY_ADMIN_AT, LEGACY_APPROVAL_SEED, LEGACY_COIN_SEED,
    LEGACY_LAUNCHES_PAUSED_AT, LEGACY_LAUNCHPAD_DISCRIMINATOR, LEGACY_LAUNCHPAD_LEN,
    LEGACY_PENDING_ADMIN_AT, LEGACY_PROGRAM_ID, MAX_NAME_LEN, MAX_SYMBOL_LEN, METADATA_SEED,
    METADATA_URI_PREFIX, METAPLEX_PROGRAM_ID, REWARDS_CITY_CONFIG_DISCRIMINATOR,
    REWARDS_MODEL_HOLDERS,
};
use crate::errors::CurveError;

/// `METADATA_URI_PREFIX + mint (base58) + ".json"` (3.10). Keyed by the mint,
/// so a coin's URI cannot be known before the coin exists.
pub fn metadata_uri(mint: &Pubkey) -> String {
    let mut s = String::with_capacity(METADATA_URI_PREFIX.len() + 44 + 5);
    s.push_str(METADATA_URI_PREFIX);
    s.push_str(&mint.to_string());
    s.push_str(".json");
    s
}

/// 1 to 32 bytes of visible characters (T38; review FA-1). Refused: control
/// characters, every invisible character (`is_format_char`: Unicode's
/// default-ignorable code points and the other format characters), every
/// blank character (`is_blank_char`), and a U+0020 space at the start, at the
/// end or next to another one. UTF-8 is otherwise allowed ("São Paulo"). The
/// name becomes a permanent Metaplex name, so a right-to-left override, a
/// zero-width space or a Hangul filler that looks like nothing could never be
/// removed again. (Look-alike letters of other scripts and canonically
/// equivalent spellings remain possible; names are not unique, the ticker is
/// the identifier.)
pub fn check_name(name: &str) -> Result<()> {
    require!(
        !name.is_empty()
            && name.len() <= MAX_NAME_LEN as usize
            && !name
                .chars()
                .any(|c| c.is_control() || is_format_char(c) || is_blank_char(c))
            && !name.starts_with(' ')
            && !name.ends_with(' ')
            && !name.contains("  "),
        CurveError::BadName
    );
    Ok(())
}

/// Invisible characters: every Unicode `Default_Ignorable_Code_Point`
/// (DerivedCoreProperties.txt: soft hyphen, combining grapheme joiner, Arabic
/// letter mark, the Hangul fillers, Khmer inherent vowels, Mongolian free
/// variation selectors and vowel separator, zero-width spaces and joiners,
/// left-to-right and right-to-left marks, embeddings, overrides and isolates,
/// invisible operators, variation selectors, the byte-order mark, the
/// reserved U+FFF0 to U+FFF8, shorthand format controls, musical beam and
/// phrase controls, and the whole tag and variation-selector-supplement block
/// U+E0000 to U+E0FFF), and the other format characters (category Cf) that
/// change layout without a glyph of their own: Arabic number signs, the end
/// of ayah, the Syriac abbreviation mark, the Arabic pound and piastre marks,
/// the interlinear annotation marks, Kaithi number signs and the Egyptian
/// hieroglyph format controls.
pub fn is_format_char(c: char) -> bool {
    matches!(
        c as u32,
        0x00AD
            | 0x034F
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x0890..=0x0891
            | 0x08E2
            | 0x115F..=0x1160
            | 0x17B4..=0x17B5
            | 0x180B..=0x180F
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x206F
            | 0x3164
            | 0xFE00..=0xFE0F
            | 0xFEFF
            | 0xFFA0
            | 0xFFF0..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0000..=0xE0FFF
    )
}

/// Blank characters, which render as empty space and would make a name look
/// like a shorter one: every space separator other than U+0020 (no-break,
/// Ogham, the typographic spaces U+2000 to U+200A, narrow no-break, medium
/// mathematical, ideographic), the line and paragraph separators, the braille
/// blank and the musical null notehead.
pub fn is_blank_char(c: char) -> bool {
    matches!(
        c as u32,
        0x00A0 | 0x1680 | 0x2000
            ..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x2800 | 0x3000 | 0x1D159
    )
}

/// 1 to 10 bytes of `A-Z0-9` (the city ticker from tickers.json).
pub fn check_symbol(symbol: &str) -> Result<()> {
    require!(
        !symbol.is_empty()
            && symbol.len() <= MAX_SYMBOL_LEN as usize
            && symbol
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
        CurveError::BadSymbol
    );
    Ok(())
}

/// The ticker zero padded to the 10 bytes of `Coin.symbol` (3.7). The caller
/// has run `check_symbol` (at most 10 bytes).
pub fn symbol_bytes(symbol: &str) -> [u8; 10] {
    let mut out = [0u8; 10];
    for (o, b) in out.iter_mut().zip(symbol.bytes()) {
        *o = b;
    }
    out
}

/// The admin, the payout key and the payout wallet are three different keys,
/// and neither payout key nor payout wallet is the guardian or `FEE_RECIPIENT`
/// (4.2, 4.4, 4.5; GOV-2: the guardian "cannot touch money", 8.1). Nothing to
/// check while payouts are off (both payout settings zero). A zero guardian
/// (none) never equals a set payout key or wallet.
pub fn check_payout_keys_separate(
    admin: &Pubkey,
    guardian: &Pubkey,
    payout_authority: &Pubkey,
    payout_destination: &Pubkey,
) -> Result<()> {
    let zero = Pubkey::default();
    if *payout_authority == zero && *payout_destination == zero {
        return Ok(());
    }
    require!(
        payout_authority != admin
            && payout_authority != guardian
            && *payout_authority != FEE_RECIPIENT
            && payout_destination != payout_authority
            && payout_destination != admin
            && payout_destination != guardian
            && *payout_destination != FEE_RECIPIENT,
        CurveError::PayoutKeyNotSeparate
    );
    Ok(())
}

/// `FEE_RECIPIENT` only receives (8.1: "it signs nothing"): it may never be the
/// admin, the proposed admin or the guardian (GOV-2). A hot wallet that is
/// also the platform-fee wallet would otherwise approve launches and, through
/// `forward_holders_fees`' authority rule (4.15), publish every city's
/// holder reward roots, or hold the guardian's halt and receive withdrawals.
pub fn check_not_fee_recipient(key: &Pubkey) -> Result<()> {
    require!(*key != FEE_RECIPIENT, CurveError::FeeRecipientRole);
    Ok(())
}

/// The founder seat (4.8, 4.10, 4.17; review R2-DIFF-1, SPEC-1). A founder
/// receives the coin's founder share (4.16, 4.20), so the seat never goes to a
/// key that may not touch money: not zero (`InvalidAddress`), not
/// `FEE_RECIPIENT` (`FeeRecipientRole`; it only receives platform and launch
/// fees), not the guardian (it only brakes) and not the payout key (it only
/// pays opted-in founders to the payout wallet) (`FounderHoldsRole`). A zero
/// guardian or payout key (none) never equals a nonzero founder. The admin may
/// be a founder: it chooses every founder anyway (8.1). Checked against the
/// settings of the moment: a later `set_guardian` or `set_payout_config`
/// naming a key that already holds a seat is not detected (the program cannot
/// enumerate coins; 8.4).
pub fn check_founder_key(
    founder: &Pubkey,
    guardian: &Pubkey,
    payout_authority: &Pubkey,
) -> Result<()> {
    require!(*founder != Pubkey::default(), CurveError::InvalidAddress);
    check_not_fee_recipient(founder)?;
    require!(
        founder != guardian && founder != payout_authority,
        CurveError::FounderHoldsRole
    );
    Ok(())
}

/// The arguments of `set_pause` (4.4): `None` leaves a flag as it is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PauseArgs {
    pub launches: Option<bool>,
    pub payouts: Option<bool>,
    pub buys: Option<bool>,
    pub buybacks: Option<bool>,
}

/// Who may set which pause flag (4.4).
///
/// * the admin: any flag, to true or false;
/// * a nonzero `payout_authority`: only `(None, Some(true), None, None)`;
/// * a nonzero `guardian`: only `launches`, `buys` and `buybacks`, only to
///   `Some(true)`, `payouts = None`, at least one set.
///
/// A key that holds more than one role may do what any of its roles allows.
/// Whether the resulting flags are allowed together is
/// [`pause_flags_consistent`]'s question.
pub fn pause_allowed(
    signer: &Pubkey,
    admin: &Pubkey,
    payout_authority: &Pubkey,
    guardian: &Pubkey,
    a: PauseArgs,
) -> bool {
    let zero = Pubkey::default();
    if signer == admin {
        return true;
    }
    let as_payout_key = *payout_authority != zero
        && signer == payout_authority
        && a.launches.is_none()
        && a.payouts == Some(true)
        && a.buys.is_none()
        && a.buybacks.is_none();
    let only_true = |v: Option<bool>| v.is_none() || v == Some(true);
    let as_guardian = *guardian != zero
        && signer == guardian
        && a.payouts.is_none()
        && only_true(a.launches)
        && only_true(a.buys)
        && only_true(a.buybacks)
        && (a.launches.is_some() || a.buys.is_some() || a.buybacks.is_some());
    as_payout_key || as_guardian
}

/// The flags after `set_pause` may be stored only if buybacks are halted
/// solely while buys are (review LL-1): a halt of buybacks alone would let a
/// backlog build that anyone could buy ahead of, and resuming buys before
/// buybacks would open the market in front of that backlog.
pub fn pause_flags_consistent(buys_halted: bool, buybacks_halted: bool) -> bool {
    !buybacks_halted || buys_halted
}

/// Reads the upgrade authority from a BPF upgradeable loader ProgramData
/// account, parsing the 45-byte bincode header by hand (u32 tag = 3, u64 slot,
/// u8 option = 1, 32-byte authority). `None` when the data is not a
/// ProgramData account or the program is immutable.
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

/// The fields of a `vicinity_rewards` CityConfig that decide where the
/// holders' money can go and who publishes its rounds. Layout (Borsh, after
/// the 8-byte discriminator): authority 32 (byte 8), pending_authority 32
/// (40), founder 32 (72), city_coin_mint 32 (104), reward_mint 32 (136), vault
/// 32 (168), reward_model u8 (200), founder_bps u16 LE (201), ...
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RewardsCityConfigView {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub city_coin_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub vault: Pubkey,
    pub reward_model: u8,
    pub founder_bps: u16,
}

/// Reads a CityConfig (discriminator and length checked; `WrongRewardsConfig`).
pub fn read_rewards_city_config(data: &[u8]) -> Result<RewardsCityConfigView> {
    require!(
        data.len() >= 203 && data[0..8] == REWARDS_CITY_CONFIG_DISCRIMINATOR,
        CurveError::WrongRewardsConfig
    );
    let key = |at: usize| -> Result<Pubkey> {
        let arr: [u8; 32] = data[at..at + 32]
            .try_into()
            .map_err(|_| CurveError::WrongRewardsConfig)?;
        Ok(Pubkey::new_from_array(arr))
    };
    Ok(RewardsCityConfigView {
        authority: key(8)?,
        pending_authority: key(40)?,
        city_coin_mint: key(104)?,
        reward_mint: key(136)?,
        vault: key(168)?,
        reward_model: data[200],
        founder_bps: u16::from_le_bytes([data[201], data[202]]),
    })
}

/// The holders' share may only go to a rewards config that pays holders only
/// (model Holders, 0% founder), in `reward_mint` (WSOL), through the vault we
/// are about to pay, for this coin (4.15). Under Creator or Split,
/// `fund_epoch_from_vault` would pay part of it to `config.founder`.
pub fn check_rewards_config(
    view: &RewardsCityConfigView,
    coin_mint: &Pubkey,
    reward_mint: &Pubkey,
    vault: &Pubkey,
) -> Result<()> {
    require!(
        view.city_coin_mint == *coin_mint
            && view.reward_model == REWARDS_MODEL_HOLDERS
            && view.founder_bps == 0
            && view.reward_mint == *reward_mint
            && view.vault == *vault,
        CurveError::WrongRewardsConfig
    );
    Ok(())
}

/// The rewards config's root publisher must be the admin, with no authority
/// transfer pending (4.15, SEC-2).
pub fn check_rewards_authority(view: &RewardsCityConfigView, admin: &Pubkey) -> Result<()> {
    require!(
        view.authority == *admin && view.pending_authority == Pubkey::default(),
        CurveError::WrongRewardsConfig
    );
    Ok(())
}

/// An address nobody has created an account at: no data and owned by the
/// System program (it may hold lamports; a pre-funded PDA is still empty).
pub fn is_empty_system_account(account: &AccountInfo) -> bool {
    account.data_is_empty() && *account.owner == anchor_lang::system_program::ID
}

/// The old program's `Coin` PDA of a city: `["coin", city_id LE]` under
/// `LEGACY_PROGRAM_ID` (4.8).
pub fn legacy_coin_address(city_id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[LEGACY_COIN_SEED, &city_id.to_le_bytes()],
        &LEGACY_PROGRAM_ID,
    )
    .0
}

/// The old program's `Approval` PDA of a city: `["approval", city_id LE]`
/// under `LEGACY_PROGRAM_ID` (4.8).
pub fn legacy_approval_address(city_id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[LEGACY_APPROVAL_SEED, &city_id.to_le_bytes()],
        &LEGACY_PROGRAM_ID,
    )
    .0
}

/// The Metaplex metadata PDA of a mint: `["metadata", METAPLEX_PROGRAM_ID,
/// mint]` under `METAPLEX_PROGRAM_ID` (4.10, T6).
pub fn metadata_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[METADATA_SEED, METAPLEX_PROGRAM_ID.as_ref(), mint.as_ref()],
        &METAPLEX_PROGRAM_ID,
    )
    .0
}

/// The bytes at `LEGACY_LAUNCHPAD` are the old program's `Launchpad`: owned by
/// `legacy_program`, exactly 171 bytes, `Launchpad` discriminator (4.8).
pub fn legacy_launchpad_bytes_valid(owner: &Pubkey, legacy_program: &Pubkey, data: &[u8]) -> bool {
    owner == legacy_program
        && data.len() as u64 == LEGACY_LAUNCHPAD_LEN
        && data[0..8] == LEGACY_LAUNCHPAD_DISCRIMINATOR
}

/// The old program's launches are paused: `data[168] == 1` (a Borsh `true`;
/// 4.8). The caller has checked `legacy_launchpad_bytes_valid`.
pub fn legacy_launches_paused_bytes(data: &[u8]) -> bool {
    data.get(LEGACY_LAUNCHES_PAUSED_AT as usize) == Some(&1)
}

/// The old program's admin is this program's admin and no admin transfer is
/// pending there (8.5, GOV-1): `data[8..40] == admin` and `data[40..72]`
/// zero. Then reopening the old program's launches (which would break R1 in
/// the other direction, O19) needs the same multisig and time lock as every
/// admin action here, never a key outside it. The caller has checked
/// `legacy_launchpad_bytes_valid` (171 bytes).
pub fn legacy_admin_matches_bytes(data: &[u8], admin: &Pubkey) -> bool {
    let at = LEGACY_ADMIN_AT as usize;
    let pending_at = LEGACY_PENDING_ADMIN_AT as usize;
    match (data.get(at..at + 32), data.get(pending_at..pending_at + 32)) {
        (Some(a), Some(p)) => a == admin.as_ref() && p.iter().all(|b| *b == 0),
        _ => false,
    }
}

/// `legacy_admin_matches_bytes` on an account (checked after
/// `legacy_launchpad_valid`). A borrow failure counts as a mismatch.
pub fn legacy_admin_matches(account: &AccountInfo, admin: &Pubkey) -> bool {
    match account.try_borrow_data() {
        Ok(data) => legacy_admin_matches_bytes(&data, admin),
        Err(_) => false,
    }
}

/// `legacy_launchpad_bytes_valid` on an account, against the compiled
/// `LEGACY_PROGRAM_ID`. A borrow failure counts as invalid.
pub fn legacy_launchpad_valid(account: &AccountInfo) -> bool {
    match account.try_borrow_data() {
        Ok(data) => legacy_launchpad_bytes_valid(account.owner, &LEGACY_PROGRAM_ID, &data),
        Err(_) => false,
    }
}

/// `legacy_launches_paused_bytes` on an account (checked after
/// `legacy_launchpad_valid`). A borrow failure counts as not paused.
pub fn legacy_launches_paused(account: &AccountInfo) -> bool {
    match account.try_borrow_data() {
        Ok(data) => legacy_launches_paused_bytes(&data),
        Err(_) => false,
    }
}

/// The arithmetic of `pay_out` (6.5): the `Coin`'s balance after a debit of
/// `amount`, refused unless it keeps `liabilities_after + min(rent_reserve,
/// rent_live)`.
///
/// ```text
/// floor = liabilities_after + min(rent_reserve, rent_live)    (MathOverflow)
/// left  = balance - amount                                   (RentFloor if negative)
/// require left >= floor                                      (RentFloor)
/// ```
pub fn debit_after(
    balance: u64,
    amount: u64,
    rent_reserve: u64,
    rent_live: u64,
    liabilities_after: u64,
) -> Result<u64> {
    let floor = liabilities_after
        .checked_add(rent_reserve.min(rent_live))
        .ok_or(CurveError::MathOverflow)?;
    let left = balance.checked_sub(amount).ok_or(CurveError::RentFloor)?;
    require!(left >= floor, CurveError::RentFloor);
    Ok(left)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic xorshift64*, so the loops need no extra crate.
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

    fn code(r: Result<impl std::fmt::Debug>) -> u32 {
        match r {
            Err(Error::AnchorError(e)) => e.error_code_number,
            other => panic!("expected an Anchor error, got {other:?}"),
        }
    }

    // ---- U11 (reused tests): check_name, check_symbol, metadata_uri ----

    #[test]
    fn u11_uri_is_keyed_by_mint() {
        let mint = Pubkey::new_from_array([7u8; 32]);
        let uri = metadata_uri(&mint);
        assert_eq!(uri, format!("https://vicinity.city/coin-meta/{mint}.json"));
        assert!(uri.len() <= 200, "Metaplex URI limit");
        let max = metadata_uri(&Pubkey::new_from_array([255u8; 32]));
        assert!(max.len() <= 81);
    }

    #[test]
    fn u11_names() {
        assert!(check_name("New York City Coin").is_ok());
        assert!(check_name("São Paulo").is_ok());
        assert!(check_name(&"a".repeat(32)).is_ok());
        assert!(check_name(&"a".repeat(33)).is_err());
        assert!(check_name("").is_err());
        assert!(check_name("bad\nname").is_err());
        assert!(check_name("bad\u{0}").is_err());
        // 32 bytes is the limit, not 32 characters
        assert!(check_name(&"é".repeat(17)).is_err());
        for bad in [
            "evil\u{202E}nioc",
            "New\u{200B}York",
            "\u{200F}Cairo",
            "Paris\u{2066}",
            "\u{FEFF}Rome",
            "Lima\u{00AD}",
            "Oslo\u{E0041}",
            "Kyiv\u{2069}",
        ] {
            assert_eq!(code(check_name(bad)), 6021, "{bad:?}");
        }
        for ok in [
            "Zürich",
            "Kraków",
            "東京",
            "القاهرة",
            "Тбилиси",
            "Reykjavík",
        ] {
            assert!(check_name(ok).is_ok(), "{ok}");
        }
    }

    /// FA-1: every Unicode `Default_Ignorable_Code_Point` (DerivedCoreProperties.txt)
    /// and every blank character is refused alone, at the start, inside and at
    /// the end of a name (the review's names looked exactly like "Paris"); the
    /// code points next to each range stay allowed; U+0020 only as a single
    /// space between two other characters.
    #[test]
    fn u11_default_ignorables_and_blanks() {
        const DEFAULT_IGNORABLE: [(u32, u32); 17] = [
            (0x00AD, 0x00AD),
            (0x034F, 0x034F),
            (0x061C, 0x061C),
            (0x115F, 0x1160),
            (0x17B4, 0x17B5),
            (0x180B, 0x180F),
            (0x200B, 0x200F),
            (0x202A, 0x202E),
            (0x2060, 0x206F),
            (0x3164, 0x3164),
            (0xFE00, 0xFE0F),
            (0xFEFF, 0xFEFF),
            (0xFFA0, 0xFFA0),
            (0xFFF0, 0xFFF8),
            (0x1BCA0, 0x1BCA3),
            (0x1D173, 0x1D17A),
            (0xE0000, 0xE0FFF),
        ];
        const BLANK: [(u32, u32); 9] = [
            (0x00A0, 0x00A0),
            (0x1680, 0x1680),
            (0x2000, 0x200A),
            (0x2028, 0x2029),
            (0x202F, 0x202F),
            (0x205F, 0x205F),
            (0x2800, 0x2800),
            (0x3000, 0x3000),
            (0x1D159, 0x1D159),
        ];
        let mut n = 0;
        for &(lo, hi) in DEFAULT_IGNORABLE.iter().chain(BLANK.iter()) {
            for cp in lo..=hi {
                let c = char::from_u32(cp).unwrap();
                for name in [
                    c.to_string(),
                    format!("{c}Paris"),
                    format!("Pa{c}ris"),
                    format!("Paris{c}"),
                ] {
                    assert_eq!(code(check_name(&name)), 6021, "U+{cp:04X} in {name:?}");
                }
                n += 1;
            }
        }
        assert_eq!(n, 4_194);
        // the review's names, accepted end to end before (Metaplex stored them as given)
        for name in [
            "Paris\u{3164}",
            "Pari\u{034F}s",
            "\u{3164}\u{3164}\u{3164}",
            "Paris\u{2800}",
        ] {
            assert_eq!(code(check_name(name)), 6021, "{name:?}");
        }
        // the code points next to each range are visible and stay allowed
        for cp in [
            0x00ACu32, 0x00AE, 0x034E, 0x0350, 0x061B, 0x061D, 0x115E, 0x1161, 0x17B3, 0x17B6,
            0x180A, 0x1810, 0x2010, 0x2027, 0x2030, 0x2070, 0x3163, 0x3165, 0xFDFC, 0xFE10, 0xFEFC,
            0xFF9F, 0xFFA1, 0xFFFC, 0x1BC9F, 0x1D158, 0x1D15A, 0x1D172, 0x1D17B, 0x00A1, 0x169C,
            0x1681, 0x27FF, 0x2801, 0x3001, 0x205E,
        ] {
            let c = char::from_u32(cp).unwrap();
            assert!(check_name(&format!("Pa{c}ris")).is_ok(), "U+{cp:04X}");
        }
        // spaces: one U+0020 between two characters, never at either end or doubled
        for ok in ["New York", "New York City Coin", "A B", "Rio de Janeiro"] {
            assert!(check_name(ok).is_ok(), "{ok:?}");
        }
        for bad in [
            " ",
            "  ",
            " Paris",
            "Paris ",
            "New  York",
            "New York ",
            "\u{3164} ",
        ] {
            assert_eq!(code(check_name(bad)), 6021, "{bad:?}");
        }
    }

    #[test]
    fn u11_symbols() {
        for ok in ["NYC", "A", "SAOPAULO", "X1", "ABCDEFGHIJ"] {
            assert!(check_symbol(ok).is_ok(), "{ok}");
        }
        for bad in ["", "nyc", "NY C", "ABCDEFGHIJK", "NY-C", "ÉÉ", "$NYC"] {
            assert_eq!(code(check_symbol(bad)), 6022, "{bad:?}");
        }
        assert_eq!(symbol_bytes("NYC"), *b"NYC\0\0\0\0\0\0\0");
        assert_eq!(symbol_bytes("ABCDEFGHIJ"), *b"ABCDEFGHIJ");
    }

    /// U11, exhaustively on small inputs: every one-byte ticker passes exactly
    /// when it is `A-Z` or `0-9`; every length from 1 to 10 passes and 11
    /// fails; every control character (C0, DEL, C1) and every listed format
    /// character is refused in a name, alone or inside one; a 32-byte name of
    /// two-byte characters passes.
    #[test]
    fn u11_exhaustive_small_inputs() {
        for b in 0u8..=255 {
            let s = (b as char).to_string();
            let want = b.is_ascii_uppercase() || b.is_ascii_digit();
            assert_eq!(check_symbol(&s).is_ok(), want, "byte {b}");
        }
        for len in 1..=11 {
            let s = "Z".repeat(len);
            assert_eq!(check_symbol(&s).is_ok(), len <= 10, "length {len}");
        }
        let controls = (0u32..0x20).chain([0x7F]).chain(0x80..0xA0);
        let formats = [
            0x00ADu32, 0x0600, 0x0605, 0x061C, 0x06DD, 0x070F, 0x0890, 0x0891, 0x08E2, 0x180E,
            0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x202A, 0x202E, 0x2060, 0x2064, 0x2066, 0x206F,
            0xFEFF, 0xFFF9, 0xFFFB, 0x110BD, 0x110CD, 0x13430, 0x1343F, 0x1BCA0, 0x1BCA3, 0x1D173,
            0x1D17A, 0xE0001, 0xE0020, 0xE007F,
        ];
        for cp in controls.chain(formats) {
            let c = char::from_u32(cp).unwrap();
            assert_eq!(code(check_name(&c.to_string())), 6021, "U+{cp:04X}");
            assert_eq!(code(check_name(&format!("Ab{c}cd"))), 6021, "U+{cp:04X}");
        }
        // Neighbours of the listed ranges stay allowed.
        for cp in [0x00AEu32, 0x0606, 0x2010, 0x2070, 0xFFFC] {
            let c = char::from_u32(cp).unwrap();
            assert!(check_name(&format!("City{c}")).is_ok(), "U+{cp:04X}");
        }
        assert!(check_name(&"é".repeat(16)).is_ok());
        assert_eq!(code(check_name(&"é".repeat(17))), 6021);
    }

    #[test]
    fn payout_keys_separate() {
        let admin = Pubkey::new_unique();
        let guardian = Pubkey::new_unique();
        let key = Pubkey::new_unique();
        let wallet = Pubkey::new_unique();
        let zero = Pubkey::default();
        for g in [guardian, zero] {
            assert!(check_payout_keys_separate(&admin, &g, &key, &wallet).is_ok());
            assert!(check_payout_keys_separate(&admin, &g, &zero, &zero).is_ok());
        }
        // payouts off: nothing to check, whoever the other keys are
        assert!(check_payout_keys_separate(&FEE_RECIPIENT, &FEE_RECIPIENT, &zero, &zero).is_ok());
        assert!(check_payout_keys_separate(&FEE_RECIPIENT, &guardian, &key, &wallet).is_ok());
        for (a, g, k, w) in [
            (admin, guardian, admin, wallet),
            (admin, guardian, FEE_RECIPIENT, wallet),
            (admin, guardian, key, key),
            (admin, guardian, key, admin),
            (admin, guardian, key, FEE_RECIPIENT),
            (key, guardian, key, wallet),
            (wallet, guardian, key, wallet),
            // GOV-2: the guardian is neither payout key nor payout wallet
            (admin, key, key, wallet),
            (admin, wallet, key, wallet),
        ] {
            assert_eq!(code(check_payout_keys_separate(&a, &g, &k, &w)), 6008);
        }
    }

    /// GOV-2: FEE_RECIPIENT is refused as admin, proposed admin or guardian.
    #[test]
    fn fee_recipient_has_no_role() {
        assert_eq!(code(check_not_fee_recipient(&FEE_RECIPIENT)), 6052);
        assert!(check_not_fee_recipient(&Pubkey::new_unique()).is_ok());
        assert!(check_not_fee_recipient(&Pubkey::default()).is_ok());
    }

    /// R2-DIFF-1, SPEC-1: the founder seat is never zero, `FEE_RECIPIENT`, the
    /// guardian or the payout key; the admin, the payout wallet and any other
    /// key may hold it; unset roles (zero) refuse nobody.
    #[test]
    fn founder_seat_rules() {
        let (guardian, payout_key, founder) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        let zero = Pubkey::default();
        assert!(check_founder_key(&founder, &guardian, &payout_key).is_ok());
        assert!(check_founder_key(&founder, &zero, &zero).is_ok());
        assert_eq!(code(check_founder_key(&zero, &guardian, &payout_key)), 6002);
        assert_eq!(code(check_founder_key(&zero, &zero, &zero)), 6002);
        for (g, k) in [(guardian, payout_key), (zero, zero)] {
            assert_eq!(code(check_founder_key(&FEE_RECIPIENT, &g, &k)), 6052);
        }
        assert_eq!(
            code(check_founder_key(&guardian, &guardian, &payout_key)),
            6053
        );
        assert_eq!(code(check_founder_key(&guardian, &guardian, &zero)), 6053);
        assert_eq!(
            code(check_founder_key(&payout_key, &guardian, &payout_key)),
            6053
        );
        assert_eq!(
            code(check_founder_key(&payout_key, &zero, &payout_key)),
            6053
        );
    }

    #[test]
    fn pause_roles() {
        let (admin, pk, g, other) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        let z = Pubkey::default();
        let all = [None, Some(false), Some(true)];
        for l in all {
            for p in all {
                for b in all {
                    for k in all {
                        let a = PauseArgs {
                            launches: l,
                            payouts: p,
                            buys: b,
                            buybacks: k,
                        };
                        // The admin may set anything.
                        assert!(pause_allowed(&admin, &admin, &pk, &g, a));
                        // A stranger may set nothing.
                        assert!(!pause_allowed(&other, &admin, &pk, &g, a));
                        // The payout key may only stop payouts.
                        let want_pk = l.is_none() && p == Some(true) && b.is_none() && k.is_none();
                        assert_eq!(pause_allowed(&pk, &admin, &pk, &g, a), want_pk);
                        // The guardian may only stop launches, buys and buybacks.
                        let want_g = p.is_none()
                            && l != Some(false)
                            && b != Some(false)
                            && k != Some(false)
                            && (l.is_some() || b.is_some() || k.is_some());
                        assert_eq!(pause_allowed(&g, &admin, &pk, &g, a), want_g);
                        // Unset roles (zero keys) give nothing, even to the zero key.
                        assert!(!pause_allowed(&z, &admin, &z, &z, a));
                    }
                }
            }
        }
        // review LL-1: buybacks are halted only while buys are
        assert!(pause_flags_consistent(false, false));
        assert!(pause_flags_consistent(true, false));
        assert!(pause_flags_consistent(true, true));
        assert!(!pause_flags_consistent(false, true));
    }

    fn program_data(tag: u32, option: u8, auth: [u8; 32]) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&tag.to_le_bytes());
        d.extend_from_slice(&123u64.to_le_bytes());
        d.push(option);
        d.extend_from_slice(&auth);
        d.extend_from_slice(&[0x7f; 100]);
        d
    }

    #[test]
    fn program_data_header() {
        let a = [9u8; 32];
        assert_eq!(
            program_data_upgrade_authority(&program_data(3, 1, a)),
            Some(Pubkey::new_from_array(a))
        );
        assert_eq!(program_data_upgrade_authority(&program_data(3, 0, a)), None);
        assert_eq!(program_data_upgrade_authority(&program_data(2, 1, a)), None);
        assert_eq!(program_data_upgrade_authority(&program_data(1, 1, a)), None);
        assert_eq!(program_data_upgrade_authority(&[3, 0, 0, 0]), None);
    }

    fn city_config(
        authority: Pubkey,
        pending: Pubkey,
        model: u8,
        bps: u16,
        mint: Pubkey,
        reward: Pubkey,
        vault: Pubkey,
    ) -> Vec<u8> {
        let mut d = REWARDS_CITY_CONFIG_DISCRIMINATOR.to_vec();
        d.extend_from_slice(authority.as_ref());
        d.extend_from_slice(pending.as_ref());
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
    fn rewards_config_rules() {
        let (admin, mint, vault) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        let wsol = crate::constants::NATIVE_MINT;
        let z = Pubkey::default();
        let ok = city_config(admin, z, 1, 0, mint, wsol, vault);
        let v = read_rewards_city_config(&ok).unwrap();
        assert_eq!(v.authority, admin);
        assert_eq!(v.pending_authority, z);
        assert!(check_rewards_config(&v, &mint, &wsol, &vault).is_ok());
        assert!(check_rewards_authority(&v, &admin).is_ok());

        let bad_economics = [
            city_config(admin, z, 0, 10_000, mint, wsol, vault), // Creator
            city_config(admin, z, 2, 2_500, mint, wsol, vault),  // Split
            city_config(admin, z, 1, 1, mint, wsol, vault),      // founder share
            city_config(admin, z, 1, 0, Pubkey::new_unique(), wsol, vault),
            city_config(admin, z, 1, 0, mint, Pubkey::new_unique(), vault),
            city_config(admin, z, 1, 0, mint, wsol, Pubkey::new_unique()),
        ];
        for d in bad_economics {
            let v = read_rewards_city_config(&d).unwrap();
            assert_eq!(code(check_rewards_config(&v, &mint, &wsol, &vault)), 6038);
        }
        // X47b: a stranger as authority, or a pending transfer, is refused.
        let stranger = city_config(Pubkey::new_unique(), z, 1, 0, mint, wsol, vault);
        let v = read_rewards_city_config(&stranger).unwrap();
        assert_eq!(code(check_rewards_authority(&v, &admin)), 6038);
        let pending = city_config(admin, Pubkey::new_unique(), 1, 0, mint, wsol, vault);
        let v = read_rewards_city_config(&pending).unwrap();
        assert_eq!(code(check_rewards_authority(&v, &admin)), 6038);

        let mut wrong_disc = ok.clone();
        wrong_disc[0] ^= 1;
        assert_eq!(code(read_rewards_city_config(&wrong_disc)), 6038);
        assert_eq!(code(read_rewards_city_config(&ok[..202])), 6038);
    }

    #[test]
    fn rewards_discriminator_matches_anchor() {
        let h = anchor_lang::solana_program::hash::hash(b"account:CityConfig");
        assert_eq!(h.to_bytes()[..8], REWARDS_CITY_CONFIG_DISCRIMINATOR);
    }

    #[test]
    fn legacy_launchpad_checks() {
        let prog = Pubkey::new_unique();
        let mut d = vec![0u8; 171];
        d[0..8].copy_from_slice(&LEGACY_LAUNCHPAD_DISCRIMINATOR);
        assert!(legacy_launchpad_bytes_valid(&prog, &prog, &d));
        assert!(!legacy_launches_paused_bytes(&d));
        d[168] = 1;
        assert!(legacy_launches_paused_bytes(&d));
        // Only a Borsh `true` counts as paused.
        d[168] = 2;
        assert!(!legacy_launches_paused_bytes(&d));
        d[168] = 1;
        // Wrong owner, size or discriminator.
        assert!(!legacy_launchpad_bytes_valid(
            &Pubkey::new_unique(),
            &prog,
            &d
        ));
        assert!(!legacy_launchpad_bytes_valid(&prog, &prog, &d[..170]));
        let mut longer = d.clone();
        longer.push(0);
        assert!(!legacy_launchpad_bytes_valid(&prog, &prog, &longer));
        let mut other = d.clone();
        other[0] ^= 1;
        assert!(!legacy_launchpad_bytes_valid(&prog, &prog, &other));
    }

    /// GOV-1: the old program's admin (bytes 8..40) must be this program's
    /// admin and its pending admin (40..72) zero.
    #[test]
    fn legacy_admin_checks() {
        let admin = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let mut d = vec![0u8; 171];
        d[0..8].copy_from_slice(&LEGACY_LAUNCHPAD_DISCRIMINATOR);
        // a zero admin is never this program's admin
        assert!(!legacy_admin_matches_bytes(&d, &admin));
        d[8..40].copy_from_slice(admin.as_ref());
        assert!(legacy_admin_matches_bytes(&d, &admin));
        assert!(!legacy_admin_matches_bytes(&d, &other));
        // a pending transfer, to anyone (even to this admin), is refused
        for pending in [other, admin] {
            let mut p = d.clone();
            p[40..72].copy_from_slice(pending.as_ref());
            assert!(!legacy_admin_matches_bytes(&p, &admin));
        }
        // one byte of the pending admin is enough
        let mut p = d.clone();
        p[71] = 1;
        assert!(!legacy_admin_matches_bytes(&p, &admin));
        // the other fields do not matter
        let mut q = d.clone();
        q[72..168].fill(9);
        q[168] = 1;
        assert!(legacy_admin_matches_bytes(&q, &admin));
        // too short to hold both fields
        assert!(!legacy_admin_matches_bytes(&d[..71], &admin));
    }

    // ---- debit helper arithmetic (6.5) ----

    #[test]
    fn debit_examples() {
        // E1 (5.14): rent + 1 SOL; a sell paying out the E2 figure leaves
        // exactly rent + liabilities.
        let rent = 5_714_160;
        let bal = rent + 1_000_000_000;
        let liab_after = 49_375_000; // the two fees of E1 and E2
        let out = 950_625_000;
        assert_eq!(
            debit_after(bal, out, rent, rent, liab_after).unwrap(),
            rent + liab_after
        );
        // One lamport more breaches the floor.
        assert_eq!(
            code(debit_after(bal, out + 1, rent, rent, liab_after)),
            6037
        );
        // More than the balance.
        assert_eq!(code(debit_after(10, 11, 0, 0, 0)), 6037);
        // Floor overflow.
        assert_eq!(code(debit_after(u64::MAX, 0, 1, 1, u64::MAX)), 6044);
        // A rent increase never raises the floor above the stored rent (X63):
        // the smaller of the two counts.
        assert_eq!(
            debit_after(bal, out, rent, rent + rent / 10, liab_after).unwrap(),
            rent + liab_after
        );
        // A rent decrease lowers it.
        assert_eq!(
            debit_after(bal, out + 100, rent, rent - 100, liab_after).unwrap(),
            rent - 100 + liab_after
        );
        // Donations are surplus: a debit may never reach them by itself, but
        // they are not needed for the floor either.
        assert_eq!(
            debit_after(bal + 7, out, rent, rent, liab_after).unwrap(),
            rent + liab_after + 7
        );
    }

    #[test]
    fn debit_properties() {
        let mut r = Rng(0x5EED_1234_ABCD_0001);
        for _ in 0..200_000 {
            let small = r.next() & 1 == 0;
            let pick = |r: &mut Rng| {
                if small {
                    r.next() % 1_000_000
                } else {
                    r.next() >> 2
                }
            };
            let (bal, amount, rr, rl, liab) = (
                pick(&mut r),
                pick(&mut r),
                pick(&mut r),
                pick(&mut r),
                pick(&mut r),
            );
            let floor = liab as u128 + rr.min(rl) as u128;
            match debit_after(bal, amount, rr, rl, liab) {
                Ok(left) => {
                    assert_eq!(left as u128 + amount as u128, bal as u128);
                    assert!(left as u128 >= floor);
                }
                Err(_) => assert!(
                    (amount as u128) > bal as u128
                        || (bal as u128 - amount as u128) < floor
                        || floor > u64::MAX as u128
                ),
            }
        }
    }
}

#[cfg(test)]
mod pda_tests {
    use super::*;

    /// T6: the metadata address is Metaplex's own PDA of the mint.
    #[test]
    fn metadata_pda_matches_metaplex() {
        for b in [1u8, 7, 200] {
            let mint = Pubkey::new_from_array([b; 32]);
            let (want, _) =
                anchor_spl::metadata::mpl_token_metadata::accounts::Metadata::find_pda(&mint);
            assert_eq!(metadata_address(&mint), want);
        }
    }

    /// The old program's PDAs are derived under the compiled legacy id.
    #[test]
    fn legacy_pdas() {
        for city in [1u64, 5_128_581, u64::MAX] {
            let le = city.to_le_bytes();
            assert_eq!(
                legacy_coin_address(city),
                Pubkey::find_program_address(&[b"coin", &le], &LEGACY_PROGRAM_ID).0
            );
            assert_eq!(
                legacy_approval_address(city),
                Pubkey::find_program_address(&[b"approval", &le], &LEGACY_PROGRAM_ID).0
            );
            assert_ne!(legacy_coin_address(city), legacy_approval_address(city));
        }
    }
}

#[cfg(test)]
mod account_tests {
    use super::*;

    fn with_account<R>(owner: Pubkey, data: &mut [u8], f: impl FnOnce(&AccountInfo) -> R) -> R {
        let key = Pubkey::new_unique();
        let mut lamports = 1_000_000u64;
        let info = AccountInfo::new(&key, false, false, &mut lamports, data, &owner, false, 0);
        f(&info)
    }

    /// The "nothing here yet" test of 4.8: no data and owned by System; a
    /// pre-funded address still counts as empty (T55).
    #[test]
    fn empty_system_account() {
        let system = anchor_lang::system_program::ID;
        assert!(with_account(system, &mut [], is_empty_system_account));
        assert!(!with_account(system, &mut [0], is_empty_system_account));
        assert!(!with_account(crate::ID, &mut [], is_empty_system_account));
        assert!(!with_account(
            LEGACY_PROGRAM_ID,
            &mut [0; 171],
            is_empty_system_account
        ));
    }

    /// The old program's `Launchpad` read through an `AccountInfo`: owner,
    /// size and discriminator, then the pause byte.
    #[test]
    fn legacy_launchpad_account() {
        let mut d = [0u8; 171];
        d[0..8].copy_from_slice(&LEGACY_LAUNCHPAD_DISCRIMINATOR);
        assert!(with_account(
            LEGACY_PROGRAM_ID,
            &mut d,
            legacy_launchpad_valid
        ));
        assert!(!with_account(
            LEGACY_PROGRAM_ID,
            &mut d,
            legacy_launches_paused
        ));
        d[168] = 1;
        assert!(with_account(
            LEGACY_PROGRAM_ID,
            &mut d,
            legacy_launches_paused
        ));
        // Same bytes under another owner (this program, System) are refused.
        assert!(!with_account(crate::ID, &mut d, legacy_launchpad_valid));
        let system = anchor_lang::system_program::ID;
        assert!(!with_account(system, &mut d, legacy_launchpad_valid));
        // An empty account at the address is refused, not read.
        assert!(!with_account(
            LEGACY_PROGRAM_ID,
            &mut [],
            legacy_launchpad_valid
        ));
        assert!(!with_account(
            LEGACY_PROGRAM_ID,
            &mut [],
            legacy_launches_paused
        ));
        // GOV-1 through an AccountInfo
        let admin = Pubkey::new_unique();
        assert!(!with_account(LEGACY_PROGRAM_ID, &mut d, |a| {
            legacy_admin_matches(a, &admin)
        }));
        d[8..40].copy_from_slice(admin.as_ref());
        assert!(with_account(LEGACY_PROGRAM_ID, &mut d, |a| {
            legacy_admin_matches(a, &admin)
        }));
        assert!(!with_account(LEGACY_PROGRAM_ID, &mut [], |a| {
            legacy_admin_matches(a, &admin)
        }));
    }
}
