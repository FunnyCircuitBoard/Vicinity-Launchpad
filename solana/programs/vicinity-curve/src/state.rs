//! Account layouts (VICINITY-CURVE-DESIGN.md 3.3 to 3.9). Borsh, so the field
//! order below is the byte order; the sizes are fixed by const assertions and
//! the offsets of `Launchpad`, `LaunchConfig` and `CurveCoin` are tested field
//! by field (`tests` below, and U10 against the math crate's `decode_coin`).

use anchor_lang::prelude::*;
use vicinity_curve_math::{Phase, State, Terms};

use crate::constants::{
    APPROVAL_LEN, COIN_LEN, LAUNCHPAD_LEN, LAUNCH_CONFIG_LEN, PAYOUT_OPT_IN_LEN, TICKER_LOCK_LEN,
};
use crate::errors::CurveError;

/// One per program; seeds `["launchpad"]`; 238 bytes (3.4).
///
/// There is no fee-recipient field, no program-id field and no coin counter
/// (3.2). `buy` and `launch` read `buys_halted`, `buyback_burn` reads
/// `buybacks_halted`; `sell` never reads this account.
/// `buybacks_halted` implies `buys_halted` (`set_pause` refuses anything else,
/// review LL-1): no buyback backlog can build while anyone can buy ahead of it.
#[account]
#[derive(InitSpace)]
pub struct Launchpad {
    /// Offset 8. Approves launches, adds and enables configs, sets any pause
    /// flag either way, sets the payout key and wallet and the guardian.
    pub admin: Pubkey,
    /// Offset 40. Second step of an admin transfer; zero = none.
    pub pending_admin: Pubkey,
    /// Offset 72. Key that may run opted-in founder payouts; zero = off.
    pub payout_authority: Pubkey,
    /// Offset 104. System-owned wallet that receives opted-in payouts; zero = off.
    pub payout_destination: Pubkey,
    /// Offset 136. May only set `launches_paused`, `buys_halted` and
    /// `buybacks_halted` to true; zero = none.
    pub guardian: Pubkey,
    /// Offset 168. Blocks `launch`.
    pub launches_paused: bool,
    /// Offset 169. Blocks `payout_founder_fees`.
    pub payouts_paused: bool,
    /// Offset 170. Blocks `buy` and `launch`; never an exit.
    pub buys_halted: bool,
    /// Offset 171. Id of the next `LaunchConfig`; sequential from 0.
    pub next_config_id: u16,
    /// Offset 173.
    pub bump: u8,
    /// Offset 174. Blocks `buyback_burn`; set only while `buys_halted` is
    /// (review LL-1). Taken from the reserved bytes: the size is unchanged.
    pub buybacks_halted: bool,
    /// Offset 175. Zero.
    pub _reserved: [u8; 63],
}

/// One per allowed split and curve; seeds `["config", config_id u16 LE]`;
/// 144 bytes; immutable except `enabled` (3.5).
#[account]
#[derive(InitSpace)]
pub struct LaunchConfig {
    /// Offset 8. Equals the seed.
    pub config_id: u16,
    /// Offset 10. Admin switch for new approvals and launches only.
    pub enabled: bool,
    /// Offset 11.
    pub bump: u8,
    /// Offset 12. `b_L`.
    pub liquidity_bps: u16,
    /// Offset 14. `b_P`.
    pub platform_bps: u16,
    /// Offset 16. `b_F`.
    pub founder_bps: u16,
    /// Offset 18. `b_H`.
    pub holders_bps: u16,
    /// Offset 20. `b_B`.
    pub buyback_bps: u16,
    /// Offset 22. Sum of the five.
    pub total_fee_bps: u16,
    /// Offset 24. `x0`.
    pub virtual_sol: u64,
    /// Offset 32. `y0`.
    pub virtual_tokens: u64,
    /// Offset 40. `S`.
    pub curve_supply: u64,
    /// Offset 48. `P`.
    pub pool_supply: u64,
    /// Offset 56. `R`, which must equal `f(S)`.
    pub graduation_sol: u64,
    /// Offset 64. Paid to `FEE_RECIPIENT` at launch.
    pub launch_fee_lamports: u64,
    /// Offset 72.
    pub created_at: i64,
    /// Offset 80. Zero.
    pub _reserved: [u8; 64],
}

impl LaunchConfig {
    /// The parameters `validate_config` checks (5.13).
    pub fn params(&self) -> vicinity_curve_math::ConfigParams {
        vicinity_curve_math::ConfigParams {
            liquidity_bps: self.liquidity_bps,
            platform_bps: self.platform_bps,
            founder_bps: self.founder_bps,
            holders_bps: self.holders_bps,
            buyback_bps: self.buyback_bps,
            virtual_sol: self.virtual_sol,
            virtual_tokens: self.virtual_tokens,
            curve_supply: self.curve_supply,
            pool_supply: self.pool_supply,
            graduation_sol: self.graduation_sol,
            launch_fee_lamports: self.launch_fee_lamports,
        }
    }
}

/// One per city while pending; seeds `["approval", city_id u64 LE]`; at most
/// 181 bytes (3.6). Closed by `launch` or `revoke_approval`, rent to
/// `rent_payer`.
#[account]
#[derive(InitSpace)]
pub struct Approval {
    /// Offset 8.
    pub city_id: u64,
    /// Offset 16. The only wallet that may launch this city's coin.
    pub founder: Pubkey,
    /// Offset 48. The config the coin must use.
    pub config_id: u16,
    /// Offset 50. Receives the rent on close.
    pub rent_payer: Pubkey,
    /// Offset 82. SHA-256 of the metadata JSON the website serves (3.10);
    /// nonzero.
    pub meta_hash: [u8; 32],
    /// Offset 114. Coin name (`check_name`).
    #[max_len(32)]
    pub name: String,
    /// City ticker, `A-Z0-9` (`check_symbol`).
    #[max_len(10)]
    pub symbol: String,
    /// Unix time of the approval.
    pub approved_at: i64,
    /// At most 30 days after `approved_at`.
    pub expires_at: i64,
    /// Bump of `["approval", city_id LE]`.
    pub bump: u8,
}

/// One per city, permanent; seeds `["coin", city_id u64 LE]`; 693 bytes with
/// fixed offsets (3.7). This file calls it `Coin`; the Rust name gives it the
/// discriminator `sha256("account:CurveCoin")[..8]`, distinct from the old
/// program's `Coin`.
///
/// All of the coin's SOL is held as native lamports of this account
/// (`rent_reserve` + the reserve of its phase + the five buckets, plus any
/// donation); its coins sit in the vault PDA `["coin_vault", coin]`.
#[account]
#[derive(InitSpace)]
pub struct CurveCoin {
    /// Offset 8. 1.
    pub layout_version: u8,
    /// Offset 9. 0 Curve, 1 Pool; only 0 to 1, once.
    pub phase: u8,
    /// Offset 10.
    pub bump: u8,
    /// Offset 11.
    pub mint_bump: u8,
    /// Offset 12.
    pub vault_bump: u8,
    /// Offset 13. Config it launched under (display; terms are copied below).
    pub config_id: u16,
    /// Offset 15.
    pub city_id: u64,
    /// Offset 23. PDA `["mint", coin]`.
    pub mint: Pubkey,
    /// Offset 55. PDA `["coin_vault", coin]`.
    pub vault: Pubkey,
    /// Offset 87. Receives the founder share; changes only in `transfer_founder`.
    pub founder: Pubkey,
    /// Offset 119. Ticker, zero padded.
    pub symbol: [u8; 10],
    /// Offset 129. Frozen copy (R4).
    pub liquidity_bps: u16,
    /// Offset 131.
    pub platform_bps: u16,
    /// Offset 133.
    pub founder_bps: u16,
    /// Offset 135.
    pub holders_bps: u16,
    /// Offset 137.
    pub buyback_bps: u16,
    /// Offset 139. `t`.
    pub total_fee_bps: u16,
    /// Offset 141. `x0`.
    pub virtual_sol: u64,
    /// Offset 149. `y0`.
    pub virtual_tokens: u64,
    /// Offset 157. `S`.
    pub curve_supply: u64,
    /// Offset 165. `P`.
    pub pool_supply: u64,
    /// Offset 173. `R`.
    pub graduation_sol: u64,
    /// Offset 181. `COIN_SUPPLY - S - P`, burned at launch.
    pub dust_burned: u64,
    /// Offset 189. `s`; equals `S` after graduation.
    pub tokens_sold: u64,
    /// Offset 197. `r = f(s)` on the curve; frozen at `R` after graduation.
    pub curve_sol: u64,
    /// Offset 205. `X`; 0 on the curve.
    pub pool_sol: u64,
    /// Offset 213. `Y`; 0 on the curve.
    pub pool_tokens: u64,
    /// Offset 221. `L`: curve-phase liquidity share not yet in the pool.
    pub liquidity_pending: u64,
    /// Offset 229. Owed to `FEE_RECIPIENT`.
    pub platform_pending: u64,
    /// Offset 237. Owed to the founder.
    pub founder_pending: u64,
    /// Offset 245. Owed to the rewards vault.
    pub holders_pending: u64,
    /// Offset 253. Waiting to be spent on buyback.
    pub buyback_pending: u64,
    /// Offset 261.
    pub launched_at: i64,
    /// Offset 269.
    pub launch_slot: u64,
    /// Offset 277. 0 on the curve.
    pub graduated_at: i64,
    /// Offset 285. 0 on the curve.
    pub graduation_slot: u64,
    /// Offset 293. Rate limit (= `launch_slot` until the first buyback).
    pub last_buyback_slot: u64,
    /// Offset 301. 24-hour payout cooldown.
    pub last_payout_at: i64,
    /// Offset 309. Payout receipt number.
    pub payout_seq: u64,
    /// Offset 317. +1 per trade; gap-free.
    pub trade_seq: u64,
    /// Offset 325.
    pub buyback_count: u64,
    /// Offset 333. Raw coins burned by buybacks.
    pub tokens_burned: u64,
    /// Offset 341. Lifetime lamports charged to buyers (fee included).
    pub buy_volume: u128,
    /// Offset 357. Lifetime gross lamports released to sellers (before fee).
    pub sell_volume: u128,
    /// Offset 373. Lifetime fees.
    pub fees_total: u128,
    /// Offset 389. Lifetime liquidity share, rounding remainders included.
    pub liquidity_earned: u128,
    /// Offset 405. Lifetime lamports moved into `pool_sol` by liquidity
    /// shares and drips.
    pub liquidity_added: u128,
    /// Offset 421.
    pub platform_earned: u128,
    /// Offset 437.
    pub platform_withdrawn: u128,
    /// Offset 453.
    pub founder_earned: u128,
    /// Offset 469.
    pub founder_claimed: u128,
    /// Offset 485.
    pub founder_paid_out: u128,
    /// Offset 501.
    pub holders_earned: u128,
    /// Offset 517.
    pub holders_forwarded: u128,
    /// Offset 533.
    pub buyback_earned: u128,
    /// Offset 549. Lamports moved from the buyback bucket into the reserve.
    pub buyback_spent: u128,
    /// Offset 565. Copied from the approval (3.10).
    pub meta_hash: [u8; 32],
    /// Offset 597. `Rent::minimum_balance(693)` at launch: the rent part of
    /// the account's lamports, used by `pay_out` (6.5).
    pub rent_reserve: u64,
    /// Offset 605. Zero.
    pub _reserved: [u8; 88],
}

impl CurveCoin {
    /// The frozen terms the math works on (offsets 129 to 180).
    pub fn terms(&self) -> Terms {
        Terms {
            liquidity_bps: self.liquidity_bps,
            platform_bps: self.platform_bps,
            founder_bps: self.founder_bps,
            holders_bps: self.holders_bps,
            buyback_bps: self.buyback_bps,
            total_fee_bps: self.total_fee_bps,
            virtual_sol: self.virtual_sol,
            virtual_tokens: self.virtual_tokens,
            curve_supply: self.curve_supply,
            pool_supply: self.pool_supply,
            graduation_sol: self.graduation_sol,
        }
    }

    /// The mutable state the trade, buyback and payout math works on.
    /// `MathOverflow` for a phase byte other than 0 or 1 (never written).
    pub fn state(&self) -> Result<State> {
        let phase = Phase::from_u8(self.phase).ok_or(CurveError::MathOverflow)?;
        Ok(State {
            phase,
            tokens_sold: self.tokens_sold,
            curve_sol: self.curve_sol,
            pool_sol: self.pool_sol,
            pool_tokens: self.pool_tokens,
            liquidity_pending: self.liquidity_pending,
            platform_pending: self.platform_pending,
            founder_pending: self.founder_pending,
            holders_pending: self.holders_pending,
            buyback_pending: self.buyback_pending,
            last_buyback_slot: self.last_buyback_slot,
            trade_seq: self.trade_seq,
            buyback_count: self.buyback_count,
            tokens_burned: self.tokens_burned,
            buy_volume: self.buy_volume,
            sell_volume: self.sell_volume,
            fees_total: self.fees_total,
            liquidity_earned: self.liquidity_earned,
            liquidity_added: self.liquidity_added,
            platform_earned: self.platform_earned,
            founder_earned: self.founder_earned,
            holders_earned: self.holders_earned,
            buyback_earned: self.buyback_earned,
            buyback_spent: self.buyback_spent,
        })
    }

    /// Writes a state the math crate returned (4.11 effect 3, 4.12 effect 2,
    /// 4.13): every field of `State`, nothing else.
    pub fn apply_state(&mut self, s: &State) {
        self.phase = s.phase.as_u8();
        self.tokens_sold = s.tokens_sold;
        self.curve_sol = s.curve_sol;
        self.pool_sol = s.pool_sol;
        self.pool_tokens = s.pool_tokens;
        self.liquidity_pending = s.liquidity_pending;
        self.platform_pending = s.platform_pending;
        self.founder_pending = s.founder_pending;
        self.holders_pending = s.holders_pending;
        self.buyback_pending = s.buyback_pending;
        self.last_buyback_slot = s.last_buyback_slot;
        self.trade_seq = s.trade_seq;
        self.buyback_count = s.buyback_count;
        self.tokens_burned = s.tokens_burned;
        self.buy_volume = s.buy_volume;
        self.sell_volume = s.sell_volume;
        self.fees_total = s.fees_total;
        self.liquidity_earned = s.liquidity_earned;
        self.liquidity_added = s.liquidity_added;
        self.platform_earned = s.platform_earned;
        self.founder_earned = s.founder_earned;
        self.holders_earned = s.holders_earned;
        self.buyback_earned = s.buyback_earned;
        self.buyback_spent = s.buyback_spent;
    }

    /// The coin's liabilities after this instruction's bookkeeping (6.5): the
    /// reserve of its phase plus the five buckets, from the math crate.
    pub fn liabilities(&self) -> Result<u64> {
        vicinity_curve_math::liabilities(&self.state()?).map_err(crate::errors::math_err)
    }
}

/// One per ticker, permanent; seeds `["ticker", symbol bytes]`; 49 bytes (3.8).
#[account]
#[derive(InitSpace)]
pub struct TickerLock {
    /// Offset 8.
    pub city_id: u64,
    /// Offset 16.
    pub mint: Pubkey,
    /// Offset 48.
    pub bump: u8,
}

/// One per coin while its founder is opted in; seeds `["payout_opt_in",
/// coin]`; 145 bytes (3.9).
#[account]
#[derive(InitSpace)]
pub struct PayoutOptIn {
    /// Offset 8.
    pub coin: Pubkey,
    /// Offset 40. Who signed; must still equal `coin.founder` at every payout.
    pub founder: Pubkey,
    /// Offset 72. Copy of `launchpad.payout_destination` when the founder
    /// signed; every payout must match it and the current setting.
    pub agreed_destination: Pubkey,
    /// Offset 104. SHA-256 of the off-chain reference, never a name or an
    /// account number.
    pub ref_hash: [u8; 32],
    /// Offset 136.
    pub opted_in_at: i64,
    /// Offset 144.
    pub bump: u8,
}

// Sizes of 3.3, discriminator included.
const _: () = assert!(8 + Launchpad::INIT_SPACE == LAUNCHPAD_LEN);
const _: () = assert!(8 + LaunchConfig::INIT_SPACE == LAUNCH_CONFIG_LEN);
const _: () = assert!(8 + Approval::INIT_SPACE == APPROVAL_LEN);
const _: () = assert!(8 + CurveCoin::INIT_SPACE == COIN_LEN);
const _: () = assert!(8 + TickerLock::INIT_SPACE == TICKER_LOCK_LEN);
const _: () = assert!(8 + PayoutOptIn::INIT_SPACE == PAYOUT_OPT_IN_LEN);
const _: () = assert!(COIN_LEN == 693);

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{AccountSerialize, Discriminator};

    fn key(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    fn bytes<T: AccountSerialize>(acc: &T) -> Vec<u8> {
        let mut v = Vec::new();
        acc.try_serialize(&mut v).unwrap();
        v
    }

    fn u16_at(d: &[u8], at: usize) -> u16 {
        u16::from_le_bytes(d[at..at + 2].try_into().unwrap())
    }
    fn u64_at(d: &[u8], at: usize) -> u64 {
        u64::from_le_bytes(d[at..at + 8].try_into().unwrap())
    }
    fn i64_at(d: &[u8], at: usize) -> i64 {
        i64::from_le_bytes(d[at..at + 8].try_into().unwrap())
    }

    #[test]
    fn launchpad_offsets() {
        let lp = Launchpad {
            admin: key(1),
            pending_admin: key(2),
            payout_authority: key(3),
            payout_destination: key(4),
            guardian: key(5),
            launches_paused: true,
            payouts_paused: false,
            buys_halted: true,
            next_config_id: 0xBEEF,
            bump: 254,
            buybacks_halted: true,
            _reserved: [0; 63],
        };
        let d = bytes(&lp);
        assert_eq!(d.len(), LAUNCHPAD_LEN);
        assert_eq!(&d[0..8], Launchpad::DISCRIMINATOR);
        for (i, at) in [8usize, 40, 72, 104, 136].iter().enumerate() {
            assert_eq!(d[*at..*at + 32], [i as u8 + 1; 32], "pubkey at {at}");
        }
        assert_eq!((d[168], d[169], d[170]), (1, 0, 1));
        assert_eq!(u16_at(&d, 171), 0xBEEF);
        assert_eq!(d[173], 254);
        assert_eq!(d[174], 1, "buybacks_halted at 174");
        assert!(d[175..238].iter().all(|b| *b == 0));
    }

    #[test]
    fn launch_config_offsets() {
        let c = LaunchConfig {
            config_id: 7,
            enabled: true,
            bump: 200,
            liquidity_bps: 50,
            platform_bps: 70,
            founder_bps: 51,
            holders_bps: 52,
            buyback_bps: 30,
            total_fee_bps: 253,
            virtual_sol: 11,
            virtual_tokens: 22,
            curve_supply: 33,
            pool_supply: 44,
            graduation_sol: 55,
            launch_fee_lamports: 66,
            created_at: -77,
            _reserved: [0; 64],
        };
        let d = bytes(&c);
        assert_eq!(d.len(), LAUNCH_CONFIG_LEN);
        assert_eq!(u16_at(&d, 8), 7);
        assert_eq!((d[10], d[11]), (1, 200));
        let bps = [12, 14, 16, 18, 20, 22].map(|at| u16_at(&d, at));
        assert_eq!(bps, [50, 70, 51, 52, 30, 253]);
        let u = [24, 32, 40, 48, 56, 64].map(|at| u64_at(&d, at));
        assert_eq!(u, [11, 22, 33, 44, 55, 66]);
        assert_eq!(i64_at(&d, 72), -77);
    }

    #[test]
    fn approval_offsets_and_max_size() {
        let a = Approval {
            city_id: 5_128_581,
            founder: key(9),
            config_id: 3,
            rent_payer: key(8),
            meta_hash: [7; 32],
            name: "a".repeat(32),
            symbol: "ABCDEFGHIJ".into(),
            approved_at: 100,
            expires_at: 200,
            bump: 250,
        };
        let d = bytes(&a);
        assert_eq!(d.len(), APPROVAL_LEN, "largest approval");
        assert_eq!(u64_at(&d, 8), 5_128_581);
        assert_eq!(d[16..48], [9; 32]);
        assert_eq!(u16_at(&d, 48), 3);
        assert_eq!(d[50..82], [8; 32]);
        assert_eq!(d[82..114], [7; 32]);
        assert_eq!(u32::from_le_bytes(d[114..118].try_into().unwrap()), 32);
    }

    #[test]
    fn ticker_lock_and_opt_in_offsets() {
        let t = TickerLock {
            city_id: 42,
            mint: key(3),
            bump: 9,
        };
        let d = bytes(&t);
        assert_eq!(d.len(), TICKER_LOCK_LEN);
        assert_eq!(u64_at(&d, 8), 42);
        assert_eq!(d[16..48], [3; 32]);
        assert_eq!(d[48], 9);

        let o = PayoutOptIn {
            coin: key(1),
            founder: key(2),
            agreed_destination: key(3),
            ref_hash: [4; 32],
            opted_in_at: 5,
            bump: 6,
        };
        let d = bytes(&o);
        assert_eq!(d.len(), PAYOUT_OPT_IN_LEN);
        assert_eq!(d[8..40], [1; 32]);
        assert_eq!(d[40..72], [2; 32]);
        assert_eq!(d[72..104], [3; 32]);
        assert_eq!(d[104..136], [4; 32]);
        assert_eq!(i64_at(&d, 136), 5);
        assert_eq!(d[144], 6);
    }

    /// A `CurveCoin` with a distinct nonzero value in every field.
    fn sample_coin() -> CurveCoin {
        CurveCoin {
            layout_version: 1,
            phase: 1,
            bump: 253,
            mint_bump: 252,
            vault_bump: 251,
            config_id: 0x0102,
            city_id: 0x0102_0304_0506_0708,
            mint: key(11),
            vault: key(12),
            founder: key(13),
            symbol: *b"ABCDEFGHI1",
            liquidity_bps: 50,
            platform_bps: 70,
            founder_bps: 51,
            holders_bps: 52,
            buyback_bps: 30,
            total_fee_bps: 253,
            virtual_sol: 1_001,
            virtual_tokens: 1_002,
            curve_supply: 1_003,
            pool_supply: 1_004,
            graduation_sol: 1_005,
            dust_burned: 1_006,
            tokens_sold: 1_007,
            curve_sol: 1_008,
            pool_sol: 1_009,
            pool_tokens: 1_010,
            liquidity_pending: 1_011,
            platform_pending: 1_012,
            founder_pending: 1_013,
            holders_pending: 1_014,
            buyback_pending: 1_015,
            launched_at: -1_016,
            launch_slot: 1_017,
            graduated_at: -1_018,
            graduation_slot: 1_019,
            last_buyback_slot: 1_020,
            last_payout_at: -1_021,
            payout_seq: 1_022,
            trade_seq: 1_023,
            buyback_count: 1_024,
            tokens_burned: 1_025,
            buy_volume: (1 << 100) + 1_026,
            sell_volume: (1 << 100) + 1_027,
            fees_total: (1 << 100) + 1_028,
            liquidity_earned: (1 << 100) + 1_029,
            liquidity_added: (1 << 100) + 1_030,
            platform_earned: (1 << 100) + 1_031,
            platform_withdrawn: (1 << 100) + 1_032,
            founder_earned: (1 << 100) + 1_033,
            founder_claimed: (1 << 100) + 1_034,
            founder_paid_out: (1 << 100) + 1_035,
            holders_earned: (1 << 100) + 1_036,
            holders_forwarded: (1 << 100) + 1_037,
            buyback_earned: (1 << 100) + 1_038,
            buyback_spent: (1 << 100) + 1_039,
            meta_hash: [14; 32],
            rent_reserve: 1_040,
            _reserved: [0; 88],
        }
    }

    /// Every offset of 3.7, read straight from the Borsh bytes.
    #[test]
    fn coin_offsets_of_3_7() {
        let c = sample_coin();
        let d = bytes(&c);
        assert_eq!(d.len(), COIN_LEN);
        assert_eq!(&d[0..8], CurveCoin::DISCRIMINATOR);
        assert_eq!((d[8], d[9], d[10], d[11], d[12]), (1, 1, 253, 252, 251));
        assert_eq!(u16_at(&d, 13), 0x0102);
        assert_eq!(u64_at(&d, 15), 0x0102_0304_0506_0708);
        assert_eq!(d[23..55], [11; 32]);
        assert_eq!(d[55..87], [12; 32]);
        assert_eq!(d[87..119], [13; 32]);
        assert_eq!(&d[119..129], b"ABCDEFGHI1");
        let bps = [129, 131, 133, 135, 137, 139].map(|at| u16_at(&d, at));
        assert_eq!(bps, [50, 70, 51, 52, 30, 253]);
        // u64 fields from offset 141 to 253, then 269, 285, 293, 309 to 333.
        let u64s: [(usize, u64); 20] = [
            (141, 1_001),
            (149, 1_002),
            (157, 1_003),
            (165, 1_004),
            (173, 1_005),
            (181, 1_006),
            (189, 1_007),
            (197, 1_008),
            (205, 1_009),
            (213, 1_010),
            (221, 1_011),
            (229, 1_012),
            (237, 1_013),
            (245, 1_014),
            (253, 1_015),
            (269, 1_017),
            (285, 1_019),
            (293, 1_020),
            (309, 1_022),
            (317, 1_023),
        ];
        for (at, v) in u64s {
            assert_eq!(u64_at(&d, at), v, "u64 at {at}");
        }
        assert_eq!(u64_at(&d, 325), 1_024);
        assert_eq!(u64_at(&d, 333), 1_025);
        assert_eq!(i64_at(&d, 261), -1_016);
        assert_eq!(i64_at(&d, 277), -1_018);
        assert_eq!(i64_at(&d, 301), -1_021);
        // u128 lifetime counters from 341 to 549, 16 bytes apart.
        for (i, at) in (341..=549).step_by(16).enumerate() {
            let v = u128::from_le_bytes(d[at..at + 16].try_into().unwrap());
            assert_eq!(v, (1u128 << 100) + 1_026 + i as u128, "u128 at {at}");
        }
        assert_eq!(d[565..597], [14; 32]);
        assert_eq!(u64_at(&d, 597), 1_040);
        assert!(d[605..693].iter().all(|b| *b == 0));
    }

    /// U10 (12.1): the math crate's `decode_coin` reads exactly the program's
    /// Borsh `CurveCoin` (round trip), and refuses a wrong owner, a wrong
    /// length, `layout_version != 1`, a phase other than 0 or 1, and the old
    /// program's `Coin` bytes.
    #[test]
    fn u10_decode_coin_round_trip() {
        use vicinity_curve_math::{decode_coin, DecodeError};
        let owner = crate::ID.to_bytes();
        assert_eq!(
            owner,
            vicinity_curve_math::constants::PROGRAM_ID,
            "declare_id! and the math crate's PROGRAM_ID are the same key"
        );
        let c = sample_coin();
        let d = bytes(&c);
        let v = decode_coin(&owner, &d).expect("decodes");
        assert_eq!(v.layout_version, c.layout_version);
        assert_eq!(v.phase.as_u8(), c.phase);
        assert_eq!((v.bump, v.mint_bump, v.vault_bump), (253, 252, 251));
        assert_eq!(v.config_id, c.config_id);
        assert_eq!(v.city_id, c.city_id);
        assert_eq!(v.mint, c.mint.to_bytes());
        assert_eq!(v.vault, c.vault.to_bytes());
        assert_eq!(v.founder, c.founder.to_bytes());
        assert_eq!(v.symbol, c.symbol);
        assert_eq!(v.terms, c.terms());
        assert_eq!(v.state, c.state().unwrap());
        assert_eq!(v.dust_burned, c.dust_burned);
        assert_eq!(v.launched_at, c.launched_at);
        assert_eq!(v.launch_slot, c.launch_slot);
        assert_eq!(v.graduated_at, c.graduated_at);
        assert_eq!(v.graduation_slot, c.graduation_slot);
        assert_eq!(v.last_payout_at, c.last_payout_at);
        assert_eq!(v.payout_seq, c.payout_seq);
        assert_eq!(v.platform_withdrawn, c.platform_withdrawn);
        assert_eq!(v.founder_claimed, c.founder_claimed);
        assert_eq!(v.founder_paid_out, c.founder_paid_out);
        assert_eq!(v.holders_forwarded, c.holders_forwarded);
        assert_eq!(v.meta_hash, c.meta_hash);
        assert_eq!(v.rent_reserve, c.rent_reserve);

        // A coin on the curve, and a state written back by apply_state, round
        // trip too.
        let mut curve = sample_coin();
        curve.phase = 0;
        let st = curve.state().unwrap();
        let mut again = sample_coin();
        again.apply_state(&st);
        assert_eq!(again.state().unwrap(), st);
        let v = decode_coin(&owner, &bytes(&curve)).unwrap();
        assert_eq!(v.state, st);

        // Rejections.
        let legacy = crate::constants::LEGACY_PROGRAM_ID.to_bytes();
        assert_eq!(decode_coin(&legacy, &d), Err(DecodeError::WrongOwner));
        assert_eq!(decode_coin(&[0; 32], &d), Err(DecodeError::WrongOwner));
        assert_eq!(
            decode_coin(&owner, &d[..692]),
            Err(DecodeError::WrongLength)
        );
        let mut long = d.clone();
        long.push(0);
        assert_eq!(decode_coin(&owner, &long), Err(DecodeError::WrongLength));
        let mut v2 = d.clone();
        v2[8] = 2;
        assert_eq!(
            decode_coin(&owner, &v2),
            Err(DecodeError::WrongLayoutVersion)
        );
        let mut p2 = d.clone();
        p2[9] = 2;
        assert_eq!(decode_coin(&owner, &p2), Err(DecodeError::InvalidPhase));
        // The old program's Coin discriminator (`sha256("account:Coin")`).
        let h = anchor_lang::solana_program::hash::hash(b"account:Coin").to_bytes();
        let mut old = d.clone();
        old[0..8].copy_from_slice(&h[..8]);
        assert_eq!(
            decode_coin(&owner, &old),
            Err(DecodeError::WrongDiscriminator)
        );
    }

    /// `state()` refuses a phase byte that is neither 0 nor 1 (never written).
    #[test]
    fn invalid_phase_byte_is_refused() {
        let mut c = sample_coin();
        c.phase = 7;
        assert!(c.state().is_err());
        assert!(c.liabilities().is_err());
    }

    /// `liabilities()` is the math crate's figure: reserve of the phase plus
    /// the five buckets.
    #[test]
    fn liabilities_by_phase() {
        let mut c = sample_coin();
        c.phase = 1;
        assert_eq!(
            c.liabilities().unwrap(),
            1_009 + 1_011 + 1_012 + 1_013 + 1_014 + 1_015
        );
        c.phase = 0;
        assert_eq!(
            c.liabilities().unwrap(),
            1_008 + 1_011 + 1_012 + 1_013 + 1_014 + 1_015
        );
    }

    /// `LaunchConfig::params()` maps every field in order.
    #[test]
    fn launch_config_params() {
        let c = LaunchConfig {
            config_id: 0,
            enabled: true,
            bump: 1,
            liquidity_bps: 1,
            platform_bps: 2,
            founder_bps: 3,
            holders_bps: 4,
            buyback_bps: 5,
            total_fee_bps: 15,
            virtual_sol: 6,
            virtual_tokens: 7,
            curve_supply: 8,
            pool_supply: 9,
            graduation_sol: 10,
            launch_fee_lamports: 11,
            created_at: 0,
            _reserved: [0; 64],
        };
        let p = c.params();
        assert_eq!(
            (
                p.liquidity_bps,
                p.platform_bps,
                p.founder_bps,
                p.holders_bps,
                p.buyback_bps
            ),
            (1, 2, 3, 4, 5)
        );
        assert_eq!(
            (
                p.virtual_sol,
                p.virtual_tokens,
                p.curve_supply,
                p.pool_supply,
                p.graduation_sol,
                p.launch_fee_lamports
            ),
            (6, 7, 8, 9, 10, 11)
        );
        assert_eq!(p.total_fee_bps(), 15);
    }

    #[test]
    fn discriminators() {
        let h = |s: &str| anchor_lang::solana_program::hash::hash(s.as_bytes()).to_bytes();
        assert_eq!(CurveCoin::DISCRIMINATOR, &h("account:CurveCoin")[..8]);
        assert_eq!(
            CurveCoin::DISCRIMINATOR,
            &vicinity_curve_math::constants::CURVE_COIN_DISCRIMINATOR[..]
        );
        // The old program's Coin is `sha256("account:Coin")`: distinct (SEC-8).
        assert_ne!(CurveCoin::DISCRIMINATOR, &h("account:Coin")[..8]);
        // Launchpad, Approval and PayoutOptIn keep the old names, so their
        // discriminators equal the old program's (decoders check the owner).
        assert_eq!(Launchpad::DISCRIMINATOR, &h("account:Launchpad")[..8]);
        assert_eq!(
            Launchpad::DISCRIMINATOR,
            &crate::constants::LEGACY_LAUNCHPAD_DISCRIMINATOR[..]
        );
    }
}
