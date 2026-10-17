//! `decode_coin` (5.16): the fixed-offset `Coin` (`CurveCoin`) layout of 3.7
//! for decoders that do not use Anchor (indexers, aggregator adapters).

use crate::constants::{
    COIN_ACCOUNT_LEN, COIN_LAYOUT_VERSION, CURVE_COIN_DISCRIMINATOR, PROGRAM_ID,
};
use crate::error::DecodeError;
use crate::types::{Phase, State, Terms};

/// Every field of the `Coin` account (3.7), decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoinView {
    /// Offset 8: 1.
    pub layout_version: u8,
    /// Offset 9.
    pub phase: Phase,
    /// Offset 10.
    pub bump: u8,
    /// Offset 11.
    pub mint_bump: u8,
    /// Offset 12.
    pub vault_bump: u8,
    /// Offset 13.
    pub config_id: u16,
    /// Offset 15.
    pub city_id: u64,
    /// Offset 23: PDA `["mint", coin]`.
    pub mint: [u8; 32],
    /// Offset 55: PDA `["coin_vault", coin]`.
    pub vault: [u8; 32],
    /// Offset 87.
    pub founder: [u8; 32],
    /// Offset 119: ticker, zero padded.
    pub symbol: [u8; 10],
    /// Offsets 129 to 180: the frozen split and curve.
    pub terms: Terms,
    /// Offset 181.
    pub dust_burned: u64,
    /// Offset 261.
    pub launched_at: i64,
    /// Offset 269.
    pub launch_slot: u64,
    /// Offset 277.
    pub graduated_at: i64,
    /// Offset 285.
    pub graduation_slot: u64,
    /// Offset 301.
    pub last_payout_at: i64,
    /// Offset 309.
    pub payout_seq: u64,
    /// Offset 437.
    pub platform_withdrawn: u128,
    /// Offset 469.
    pub founder_claimed: u128,
    /// Offset 485.
    pub founder_paid_out: u128,
    /// Offset 517.
    pub holders_forwarded: u128,
    /// Offset 565.
    pub meta_hash: [u8; 32],
    /// Offset 597.
    pub rent_reserve: u64,
    /// Offsets 189 to 260 and 293 to 564 that trades and buybacks move.
    pub state: State,
}

impl CoinView {
    /// The frozen terms, for the quote functions.
    pub fn terms(&self) -> Terms {
        self.terms
    }

    /// The trade state, for the quote functions.
    pub fn state(&self) -> State {
        self.state
    }
}

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn bytes<const N: usize>(&self, at: usize) -> Result<[u8; N], DecodeError> {
        let end = at.checked_add(N).ok_or(DecodeError::WrongLength)?;
        self.0
            .get(at..end)
            .and_then(|s| <[u8; N]>::try_from(s).ok())
            .ok_or(DecodeError::WrongLength)
    }
    fn u8(&self, at: usize) -> Result<u8, DecodeError> {
        Ok(self.bytes::<1>(at)?[0])
    }
    fn u16(&self, at: usize) -> Result<u16, DecodeError> {
        Ok(u16::from_le_bytes(self.bytes(at)?))
    }
    fn u64(&self, at: usize) -> Result<u64, DecodeError> {
        Ok(u64::from_le_bytes(self.bytes(at)?))
    }
    fn i64(&self, at: usize) -> Result<i64, DecodeError> {
        Ok(i64::from_le_bytes(self.bytes(at)?))
    }
    fn u128(&self, at: usize) -> Result<u128, DecodeError> {
        Ok(u128::from_le_bytes(self.bytes(at)?))
    }
}

/// Decodes a `Coin` account (5.16): `owner` must be the `vicinity_curve`
/// program id ([`PROGRAM_ID`]), `data` exactly 693 bytes starting with the
/// `CurveCoin` discriminator, `layout_version == 1` and `phase` 0 or 1; then
/// every field at its fixed offset of 3.7. The owner check is what tells a
/// `CurveCoin` from look-alike bytes in another program's account (SEC-8).
pub fn decode_coin(owner: &[u8; 32], data: &[u8]) -> Result<CoinView, DecodeError> {
    if *owner != PROGRAM_ID {
        return Err(DecodeError::WrongOwner);
    }
    if data.len() != COIN_ACCOUNT_LEN {
        return Err(DecodeError::WrongLength);
    }
    let r = Reader(data);
    if r.bytes::<8>(0)? != CURVE_COIN_DISCRIMINATOR {
        return Err(DecodeError::WrongDiscriminator);
    }
    let layout_version = r.u8(8)?;
    if layout_version != COIN_LAYOUT_VERSION {
        return Err(DecodeError::WrongLayoutVersion);
    }
    let phase = Phase::from_u8(r.u8(9)?).ok_or(DecodeError::InvalidPhase)?;
    let terms = Terms {
        liquidity_bps: r.u16(129)?,
        platform_bps: r.u16(131)?,
        founder_bps: r.u16(133)?,
        holders_bps: r.u16(135)?,
        buyback_bps: r.u16(137)?,
        total_fee_bps: r.u16(139)?,
        virtual_sol: r.u64(141)?,
        virtual_tokens: r.u64(149)?,
        curve_supply: r.u64(157)?,
        pool_supply: r.u64(165)?,
        graduation_sol: r.u64(173)?,
    };
    let state = State {
        phase,
        tokens_sold: r.u64(189)?,
        curve_sol: r.u64(197)?,
        pool_sol: r.u64(205)?,
        pool_tokens: r.u64(213)?,
        liquidity_pending: r.u64(221)?,
        platform_pending: r.u64(229)?,
        founder_pending: r.u64(237)?,
        holders_pending: r.u64(245)?,
        buyback_pending: r.u64(253)?,
        last_buyback_slot: r.u64(293)?,
        trade_seq: r.u64(317)?,
        buyback_count: r.u64(325)?,
        tokens_burned: r.u64(333)?,
        buy_volume: r.u128(341)?,
        sell_volume: r.u128(357)?,
        fees_total: r.u128(373)?,
        liquidity_earned: r.u128(389)?,
        liquidity_added: r.u128(405)?,
        platform_earned: r.u128(421)?,
        founder_earned: r.u128(453)?,
        holders_earned: r.u128(501)?,
        buyback_earned: r.u128(533)?,
        buyback_spent: r.u128(549)?,
    };
    Ok(CoinView {
        layout_version,
        phase,
        bump: r.u8(10)?,
        mint_bump: r.u8(11)?,
        vault_bump: r.u8(12)?,
        config_id: r.u16(13)?,
        city_id: r.u64(15)?,
        mint: r.bytes(23)?,
        vault: r.bytes(55)?,
        founder: r.bytes(87)?,
        symbol: r.bytes(119)?,
        terms,
        dust_burned: r.u64(181)?,
        launched_at: r.i64(261)?,
        launch_slot: r.u64(269)?,
        graduated_at: r.i64(277)?,
        graduation_slot: r.u64(285)?,
        last_payout_at: r.i64(301)?,
        payout_seq: r.u64(309)?,
        platform_withdrawn: r.u128(437)?,
        founder_claimed: r.u128(469)?,
        founder_paid_out: r.u128(485)?,
        holders_forwarded: r.u128(517)?,
        meta_hash: r.bytes(565)?,
        rent_reserve: r.u64(597)?,
        state,
    })
}
