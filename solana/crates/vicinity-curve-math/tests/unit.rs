//! Unit tests U01 to U10 of VICINITY-CURVE-DESIGN.md 12.1, including every
//! worked example of 5.14 to the lamport and raw unit, and the figures of 5.9,
//! 5.10 and 5.13. U11 (`check_name`, `check_symbol`, `metadata_uri`) and U12
//! (the compiled legacy addresses) test program code and belong to the program
//! crate; U10's round trip against the program's Borsh struct is added there.

mod common;

use common::*;
use vicinity_curve_math::constants::*;
use vicinity_curve_math::*;

const T: Terms = Terms::DEFAULT;
const X0: u128 = 30_000_853_639;
const Y0: u128 = 1_073_025_598_486_615;
const S: u64 = 793_099_990_000_000;
const P: u64 = 206_900_000_900_000;
const R: u64 = 85_000_000_000;

fn split_of(t: &Terms, a: u64) -> [u64; 7] {
    let s = fee_split(t, a).unwrap();
    [
        s.fee,
        s.liquidity,
        s.liquidity_floor,
        s.platform,
        s.founder,
        s.holders,
        s.buyback,
    ]
}

// ---------------------------------------------------------------- U01

#[test]
fn u01_fee_and_split_examples() {
    // [fee, liquidity, liquidity_floor, platform, founder, holders, buyback]
    let cases: [(u64, [u64; 7]); 9] = [
        (2, [0, 0, 0, 0, 0, 0, 0]),
        (41, [1, 1, 0, 0, 0, 0, 0]),
        (560, [14, 6, 2, 3, 2, 2, 1]),
        (1_961, [49, 13, 9, 13, 9, 9, 5]),
        (100_000, [2_500, 500, 500, 700, 500, 500, 300]),
        (100_001, [2_500, 500, 500, 700, 500, 500, 300]),
        (
            1_000_000_000,
            [
                25_000_000, 5_000_000, 5_000_000, 7_000_000, 5_000_000, 5_000_000, 3_000_000,
            ],
        ),
        (
            975_113_405,
            [
                24_377_835, 4_875_568, 4_875_567, 6_825_793, 4_875_567, 4_875_567, 2_925_340,
            ],
        ),
        (
            87_179_487_179,
            [
                2_179_487_179,
                435_897_438,
                435_897_435,
                610_256_410,
                435_897_435,
                435_897_435,
                261_538_461,
            ],
        ),
    ];
    for (a, want) in cases {
        let got = split_of(&T, a);
        assert_eq!(got, want, "A = {a}");
        assert!(
            got[0] as u128 * D <= a as u128 * 250,
            "fee * D <= A * t at A = {a}"
        );
        assert_eq!(
            got[0],
            got[1] + got[3] + got[4] + got[5] + got[6],
            "sum at A = {a}"
        );
    }
}

// ---------------------------------------------------------------- U02

fn lemma_f(t: &Terms, a: u64) -> u64 {
    let s = fee_split(t, a).unwrap();
    assert_eq!(
        s.fee,
        s.liquidity + s.platform + s.founder + s.holders + s.buyback,
        "Lemma F (a) at {a}"
    );
    assert!(
        s.liquidity >= s.liquidity_floor && s.liquidity <= s.liquidity_floor + 4,
        "Lemma F (b) at {a}"
    );
    let at = a as u128 * t.total_fee_bps as u128;
    assert!(
        s.fee as u128 * D <= at && at < (s.fee as u128 + 1) * D,
        "Lemma F (c) at {a}"
    );
    for (share, bps) in [
        (s.platform, t.platform_bps),
        (s.founder, t.founder_bps),
        (s.holders, t.holders_bps),
        (s.buyback, t.buyback_bps),
    ] {
        assert!(
            share as u128 * D <= a as u128 * bps as u128,
            "Lemma F (d) at {a}"
        );
    }
    s.liquidity - s.liquidity_floor
}

#[test]
fn u02_split_bounds_exhaustive_and_random() {
    let mut first4 = None;
    for a in 0..1_000_000u64 {
        if lemma_f(&T, a) == 4 && first4.is_none() {
            first4 = Some(a);
        }
    }
    assert_eq!(
        first4,
        Some(560),
        "the remainder bound 4 is first reached at 560 lamports"
    );
    let mut x = 0x9E37_79B9_7F4A_7C15u64; // splitmix64
    for _ in 0..100_000 {
        x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        lemma_f(&T, z ^ (z >> 31));
    }
    lemma_f(&T, u64::MAX);
}

// ---------------------------------------------------------------- U03

#[test]
fn u03_curve_value_and_inverse() {
    // Lemma C1: f(s) <= q iff s <= tokens_for(q), on a grid and at the edges.
    let qs = [0u64, 1, 2, 975_000_000, R - 2, R - 1, R, 2 * R];
    for &q in &qs {
        let top = tokens_for(&T, q).unwrap();
        if top <= S {
            assert!(
                curve_value(&T, top).unwrap() <= q,
                "f(tokens_for(q)) <= q at q = {q}"
            );
        }
        if top < S {
            assert!(
                curve_value(&T, top + 1).unwrap() > q,
                "maximality at q = {q}"
            );
        }
    }
    let mut x = 12345u64;
    for _ in 0..20_000 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        let s = x % (S + 1);
        let q = (x >> 11) % (R + 1);
        let fs = curve_value(&T, s).unwrap();
        assert_eq!(
            fs <= q,
            s <= tokens_for(&T, q).unwrap(),
            "Lemma C1 at s = {s}, q = {q}"
        );
        if s < S {
            let step = curve_value(&T, s + 1).unwrap() - fs;
            assert!(step <= 1, "Lemma C2 at s = {s}");
        }
    }
    assert_eq!(curve_value(&T, 0).unwrap(), 0);
    assert_eq!(curve_value(&T, S).unwrap(), R);
    assert_eq!(tokens_for(&T, 0).unwrap(), 0);
    assert_eq!(
        curve_value(&T, S + 1),
        Err(MathError::InvalidTerms),
        "f is defined on [0, S]"
    );
}

// ---------------------------------------------------------------- U04

/// `round(a * 10^18 / b)` by long division in base 10^9 (no u128 overflow).
fn scaled_round(a: u128, b: u128) -> u128 {
    let (mut q, mut r) = (a / b, a % b);
    for _ in 0..2 {
        let t = r * 1_000_000_000;
        q = q * 1_000_000_000 + t / b;
        r = t % b;
    }
    q + u128::from(2 * r >= b)
}

#[test]
fn u04_default_config_integers_of_5_9_and_5_10() {
    let d = Y0 - S as u128;
    assert_eq!(d, 279_925_608_486_615);
    assert_eq!(
        X0 * Y0,
        32_191_683_931_097_316_515_541_985,
        "k = x0 * y0 (85 bits)"
    );
    const { assert!(X0 * Y0 < 1u128 << 85 && X0 * Y0 >= 1u128 << 84) };
    // exact completion
    assert_eq!((R as u128 - 1) * d, 23_793_676_721_082_349_391_513_385);
    assert_eq!(X0 * S as u128, 23_793_676_721_082_363_610_000_000);
    assert_eq!(R as u128 * d, 23_793_676_721_362_275_000_000_000);
    assert_eq!(curve_value(&T, S).unwrap(), R, "f(S) = R");
    assert_eq!(
        curve_value(&T, S - 1).unwrap(),
        R - 1,
        "V5b: f(S - 1) = R - 1"
    );
    assert_eq!(COIN_SUPPLY - S - P, 9_100_000, "dust burned at launch");
    // continuity (5.10): gap and relative gap 2.0e-12, never above
    let opening = (X0 + R as u128) * P as u128;
    assert_eq!(opening - R as u128 * d, 47_593_275_100_000);
    assert_eq!(
        (opening - R as u128 * d) * 1_000_000_000_000_000 / opening,
        2_000,
        "2.000e-12"
    );
    // spot prices in lamports per raw unit, x 10^18 (5.10 prints them rounded)
    assert_eq!(
        scaled_round(X0 + R as u128, d),
        410_826_484_438_986,
        "curve's last price"
    );
    assert_eq!(
        scaled_round(R as u128, P as u128),
        410_826_484_438_164,
        "pool's first price"
    );
    assert_eq!(
        scaled_round(X0 * Y0, d * d),
        410_826_484_435_414,
        "curve derivative at S"
    );
    // absorption 2,434.1 (V6 by a factor of 2,434)
    assert!(2_434 * X0 * Y0 <= d * d && d * d < 2_435 * X0 * Y0);
    assert_eq!(d * d * 10 / (X0 * Y0), 24_341);
    // start and end market cap 27.959 and 410.826 SOL
    assert_eq!(X0 * COIN_SUPPLY as u128 / Y0, 27_959_122_020);
    assert_eq!(R as u128 * COIN_SUPPLY as u128 / P as u128, 410_826_484_438);
    // depth: the real pool's R * P is 54.6% of the curve's k
    assert_eq!(R as u128 * P as u128 * 1_000 / (X0 * Y0), 546);
    // V1 to V11 pass, with the margins printed in 5.13
    assert_eq!(validate_config(&ConfigParams::DEFAULT), Ok(()));
    assert_eq!(Terms::from_params(&ConfigParams::DEFAULT).unwrap(), T);
    assert_eq!(
        v8_sides(&ConfigParams::DEFAULT).unwrap(),
        (613_813_296_968_750_000_000, 618_750_000_000_000_000_000)
    );
    assert_eq!(
        v11_sides(&ConfigParams::DEFAULT).unwrap(),
        (
            (2_400_937_500, 2_405_000_000),
            (2_413_250_000, 2_417_850_000)
        )
    );
    // V8 bound 0.98210 = left / right * 0.99
    let (l, r) = v8_sides(&ConfigParams::DEFAULT).unwrap();
    assert_eq!(l * 99 * 100_000 / (r * 100), 98_210);
    // derive_curve reproduces design A's integers (5.9) and O3 (c)'s
    assert_eq!(derive_curve(S, P, R), Ok((X0 as u64, Y0 as u64)));
    assert_eq!(
        derive_curve(S, 206_900_010_000_000, R),
        Ok((30_000_855_424, 1_073_025_615_141_714))
    );
}

// ---------------------------------------------------------------- U05

#[test]
fn u05_e1_e2_buy_one_sol_and_sell_back() {
    let mut m = Sim::launch(T, 0);
    let q = m.buy(1_000_000_000).unwrap();
    assert_eq!(
        (q.charged, q.net, q.tokens_out),
        (1_000_000_000, 975_000_000, 33_774_693_369_781)
    );
    assert_eq!(split_of(&T, q.charged)[..2], [25_000_000, 5_000_000]);
    assert_eq!(
        (
            q.split.platform,
            q.split.founder,
            q.split.holders,
            q.split.buyback
        ),
        (7_000_000, 5_000_000, 5_000_000, 3_000_000)
    );
    assert!(!q.partial && !q.graduates && q.drip == 0);
    assert_eq!(
        (m.st.tokens_sold, m.st.curve_sol),
        (33_774_693_369_781, 975_000_000)
    );
    assert_eq!(curve_value(&T, m.st.tokens_sold).unwrap(), 975_000_000);
    assert_eq!(
        spot_price(&T, &m.st).unwrap(),
        (30_975_853_639, 1_039_250_905_116_834)
    );
    assert_eq!(m.st.liquidity_pending, 5_000_000);
    assert_eq!(
        liabilities(&m.st).unwrap(),
        1_000_000_000,
        "lamports above rent_reserve"
    );
    m.check();

    let q = m.sell(33_774_693_369_781).unwrap();
    assert_eq!((q.gross, q.sol_out), (975_000_000, 950_625_000));
    assert_eq!(
        split_of(&T, q.gross),
        [24_375_000, 4_875_000, 4_875_000, 6_825_000, 4_875_000, 4_875_000, 2_925_000]
    );
    assert_eq!(
        (m.st.tokens_sold, m.st.curve_sol),
        (0, 0),
        "path independence"
    );
    let st = m.st;
    assert_eq!(
        (
            st.liquidity_pending,
            st.platform_pending,
            st.founder_pending,
            st.holders_pending,
            st.buyback_pending
        ),
        (9_875_000, 13_825_000, 9_875_000, 9_875_000, 5_925_000)
    );
    assert_eq!(liabilities(&st).unwrap(), 49_375_000);
    // round trip costs 4.9375%
    assert_eq!(
        (1_000_000_000u128 - 950_625_000) * 1_000_000 / 1_000_000_000,
        49_375
    );
    m.check();
}

#[test]
fn u05_e3_e4_e5_fill_the_curve_then_pool_round_trip() {
    let mut m = Sim::launch(T, 0);
    let q = m.buy(100_000_000_000).unwrap();
    assert_eq!(q.charged, 87_179_487_179);
    assert!(q.partial && q.graduates);
    assert_eq!(
        split_of(&T, q.charged),
        [
            2_179_487_179,
            435_897_438,
            435_897_435,
            610_256_410,
            435_897_435,
            435_897_435,
            261_538_461
        ]
    );
    assert_eq!(q.tokens_out, 793_099_990_000_000);
    assert_eq!(q.net, R);
    assert_eq!(m.st.phase, Phase::Pool);
    assert_eq!(
        (m.st.pool_sol, m.st.pool_tokens, m.st.liquidity_pending),
        (R, P, 435_897_438)
    );
    assert_eq!((m.st.tokens_sold, m.st.curve_sol), (S, R));
    assert_eq!(
        max_quote_in(&T, &State::at_launch(0)).unwrap(),
        87_179_487_179,
        "fills the curve in one buy"
    );
    m.check();

    // E4
    let q4 = m.buy(1_000_000_000).unwrap();
    assert_eq!(
        (q4.split.fee, q4.net, q4.tokens_out),
        (25_000_000, 975_000_000, 2_346_350_693_544)
    );
    assert_eq!((q4.split.liquidity, q4.drip), (5_000_000, 5_000_000));
    assert_eq!(
        (m.st.pool_sol, m.st.pool_tokens, m.st.liquidity_pending),
        (85_985_000_000, 204_553_650_206_456, 430_897_438)
    );
    m.check();

    // E5
    let q5 = m.sell(2_346_350_693_544).unwrap();
    assert_eq!((q5.gross, q5.sol_out), (975_113_405, 950_735_570));
    assert_eq!(
        split_of(&T, q5.gross),
        [24_377_835, 4_875_568, 4_875_567, 6_825_793, 4_875_567, 4_875_567, 2_925_340]
    );
    assert_eq!(
        q5.drip, 4_875_567,
        "the rounded-down share; the remainder never drips"
    );
    assert_eq!(
        (m.st.pool_sol, m.st.pool_tokens, m.st.liquidity_pending),
        (85_019_637_730, P, 426_021_871)
    );
    m.check();
    // round trip costs 4.9264%
    assert_eq!(
        (1_000_000_000u128 - 950_735_570) * 1_000_000 / 1_000_000_000,
        49_264
    );
}

#[test]
fn u05_e6_partial_fill() {
    assert_eq!(gross_for(&T, 84_500_000_000).unwrap(), 86_666_666_666);
    let mut m = Sim::launch(T, 0);
    let q = m.buy(86_666_666_666).unwrap();
    assert_eq!(q.net, 84_500_000_000);
    assert_eq!(
        (m.st.tokens_sold, m.st.curve_sol),
        (791_877_616_545_871, 84_500_000_000)
    );
    assert_eq!(max_quote_in(&T, &m.st).unwrap(), 512_820_512);
    let q = m.buy(1_000_000_000).unwrap();
    assert_eq!((q.net, q.charged), (500_000_000, 512_820_512));
    assert_eq!(
        split_of(&T, q.charged),
        [12_820_512, 2_564_104, 2_564_102, 3_589_743, 2_564_102, 2_564_102, 1_538_461]
    );
    assert_eq!(q.tokens_out, 1_222_373_454_129);
    assert_eq!(q.tokens_out, S - 791_877_616_545_871, "exactly S - s");
    assert!(q.partial && q.graduates);
    assert_eq!(
        1_000_000_000 - q.charged,
        487_179_488,
        "stays in the buyer's wallet"
    );
    m.check();
}

#[test]
fn u05_e7_buyback_after_e3() {
    let mut m = Sim::launch(T, 0);
    m.buy(100_000_000_000).unwrap();
    assert_eq!(m.st.buyback_pending, 261_538_461);
    m.slot = 149;
    assert_eq!(
        m.buyback().unwrap(),
        None,
        "149 slots after launch: not yet"
    );
    m.slot = 150;
    let (x0, y0) = (m.st.pool_sol as u128, m.st.pool_tokens as u128);
    let q = m.buyback().unwrap().expect("runs 150 slots after launch");
    assert_eq!(
        (q.cap, q.spent, q.coins),
        (85_000_000, 85_000_000, 206_693_307_592)
    );
    assert_eq!(m.st.buyback_pending, 176_538_461);
    assert_eq!(
        (m.st.pool_sol, m.st.pool_tokens),
        (85_085_000_000, 206_693_307_592_408)
    );
    assert_eq!(
        COIN_SUPPLY - 9_100_000 - m.st.tokens_burned,
        999_793_297_592_408,
        "supply after"
    );
    assert_eq!(
        m.st.pool_sol as u128 * y0 * 1_000_000 / (x0 * m.st.pool_tokens as u128),
        1_002_000,
        "price +0.200%"
    );
    assert_eq!(
        (
            m.st.buyback_count,
            m.st.last_buyback_slot,
            m.st.buyback_spent
        ),
        (1, 150, 85_000_000)
    );
    m.check();
    m.slot = 299;
    assert_eq!(m.buyback().unwrap(), None, "one run per 150 slots");
}

#[test]
fn u05_e8_buyback_on_the_curve() {
    let mut m = Sim::launch(T, 0);
    let q = m.buy(10_000_000_000).unwrap();
    assert_eq!(q.tokens_out, 263_189_306_077_696);
    assert_eq!(m.st.buyback_pending, 30_000_000);
    m.slot = 150;
    assert_eq!(depth(&T, &m.st).unwrap(), 39_750_853_639);
    let v0 = spot_price(&T, &m.st).unwrap();
    let q = m.buyback().unwrap().unwrap();
    assert_eq!(
        (q.cap, q.spent, q.coins),
        (39_750_853, 30_000_000, 610_723_163_277)
    );
    assert_eq!(
        (m.st.tokens_sold, m.st.curve_sol),
        (263_800_029_240_973, 9_780_000_000)
    );
    let v1 = spot_price(&T, &m.st).unwrap();
    assert_eq!(
        v1.0 as u128 * v0.1 as u128 * 1_000_000 / (v0.0 as u128 * v1.1 as u128),
        1_001_509,
        "price +0.151%"
    );
    m.check();
}

#[test]
fn u05_e9_smallest_buy_and_e10_last_raw_unit() {
    let q = quote_buy(&T, &State::at_launch(0), 100_000).unwrap();
    assert_eq!(split_of(&T, 100_000), [2_500, 500, 500, 700, 500, 500, 300]);
    assert_eq!(
        (q.charged, q.net, q.tokens_out),
        (100_000, 97_500, 3_487_222_633)
    );
    assert_eq!(
        quote_buy(&T, &State::at_launch(0), 99_999),
        Err(MathError::TradeTooSmall)
    );

    // E10: curve at R - 1 (tokens_sold = S - 1): any buy is charged 1 lamport, fee 0
    let mut m = Sim::launch(T, 0);
    m.buy(gross_for(&T, R - 1).unwrap()).unwrap();
    assert_eq!((m.st.tokens_sold, m.st.curve_sol), (S - 1, R - 1));
    for sol_in in [100_000u64, 1_000_000_000, u64::MAX] {
        let q = quote_buy(&T, &m.st, sol_in).unwrap();
        assert_eq!(
            (q.charged, q.split.fee, q.net, q.tokens_out),
            (1, 0, 1, 1),
            "sol_in {sol_in}"
        );
        assert!(q.graduates && q.partial);
    }
    assert_eq!(max_quote_in(&T, &m.st).unwrap(), MIN_TRADE_LAMPORTS);
    m.buy(MIN_TRADE_LAMPORTS).unwrap();
    m.check();
}

#[test]
fn u05_other_figures() {
    assert_eq!(
        buyback_cap(&T, &State::at_launch(0)).unwrap(),
        30_000_853,
        "cap at launch"
    );
    let end = State {
        curve_sol: R,
        ..State::at_launch(0)
    };
    assert_eq!(
        buyback_cap(&T, &end).unwrap(),
        115_000_853,
        "cap at the end of the curve"
    );
    let open = State {
        phase: Phase::Pool,
        pool_sol: R,
        pool_tokens: P,
        ..State::at_launch(0)
    };
    assert_eq!(
        buyback_cap(&T, &open).unwrap(),
        85_000_000,
        "cap at pool open"
    );
    let floor_x = (R as u128 * P as u128 / COIN_SUPPLY as u128) as u64;
    assert_eq!(
        floor_x, 17_586_500_076,
        "pool depth never below 17.5865 SOL"
    );
    let low = State {
        phase: Phase::Pool,
        pool_sol: floor_x,
        pool_tokens: COIN_SUPPLY,
        ..State::at_launch(0)
    };
    assert_eq!(
        buyback_cap(&T, &low).unwrap(),
        17_586_500,
        "smallest pool cap"
    );
    assert_eq!(
        quote_buy(&T, &State::at_launch(0), 1_000_000_000)
            .unwrap()
            .tokens_out,
        33_774_693_369_781
    );
    let q = quote_buy(&T, &open, 1_000_000_000).unwrap();
    assert_eq!(
        q.tokens_out, 2_346_350_693_544,
        "1 SOL just after graduation"
    );
    // all fees of a curve filled in one buy: 2.179 SOL (0.610 / 0.436 / 0.436 / 0.262 / 0.436)
    let s = fee_split(&T, 87_179_487_179).unwrap();
    assert_eq!(
        [
            s.fee,
            s.platform,
            s.founder,
            s.holders,
            s.buyback,
            s.liquidity
        ]
        .map(|x| x / 1_000_000),
        [2_179, 610, 435, 435, 261, 435]
    );
}

// ---------------------------------------------------------------- U06

#[test]
fn u06_gross_up_lemma_g() {
    let check = |t: u16, c: u64| {
        let tt = terms_with_t(t);
        let g = gross_for(&tt, c).unwrap();
        let net = |g: u64| g - fee_split(&tt, g).unwrap().fee;
        assert_eq!(net(g), c, "h(G') = c at t = {t}, c = {c}");
        assert_eq!(net(g - 1), c - 1, "G' is the least at t = {t}, c = {c}");
    };
    for t in [1u16, 37, 249, 250] {
        for c in 1..200_000u64 {
            check(t, c);
        }
    }
    for t in 1..=250u16 {
        for c in 1..2_000u64 {
            check(t, c);
        }
    }
    let mut x = 0xDEADBEEFu64;
    for _ in 0..50_000 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        let t = (x % 251) as u16;
        let c = 1 + (x >> 9) % 10_000_000_000_000;
        if t == 0 {
            assert_eq!(gross_for(&terms_with_t(0), c).unwrap(), c);
            continue;
        }
        check(t, c);
        // G' <= G whenever c <= h(G)
        let g = c + (x >> 40);
        let tt = terms_with_t(t);
        if c <= g - fee_split(&tt, g).unwrap().fee {
            assert!(gross_for(&tt, c).unwrap() <= g);
        }
    }
    assert_eq!(gross_for(&T, 0), Err(MathError::ZeroAmount));
}

// ---------------------------------------------------------------- U07

#[test]
fn u07_partial_fill() {
    // States at every interesting distance from the end of the curve, rem = R - r.
    for rem in [
        1u64,
        2,
        3,
        100,
        2_433,
        97_499,
        97_500,
        97_501,
        1_000_000,
        500_000_000,
        20_000_000_000,
    ] {
        let st = curve_state(T, R - rem).st;
        assert_eq!(st.curve_sol, R - rem);
        let exact = gross_for(&T, rem).unwrap();
        for sol_in in [
            MIN_TRADE_LAMPORTS,
            exact.max(MIN_TRADE_LAMPORTS),
            exact + 1,
            10_000_000_000,
            u64::MAX,
        ] {
            if sol_in < MIN_TRADE_LAMPORTS {
                continue;
            }
            let q = quote_buy(&T, &st, sol_in).unwrap();
            assert!(q.charged <= sol_in, "charged <= sol_in");
            if q.graduates {
                assert_eq!(q.tokens_out, S - st.tokens_sold, "exactly the coins left");
                assert_eq!(q.net, rem, "exactly the lamports still needed");
                // 5.4: charged = (c == n) ? G : gross_for(c). When the offered net is
                // exactly rem, the buyer is charged sol_in (its fee is the ordinary
                // floor(G t / D)); otherwise the least charge with net rem.
                let n = sol_in - fee_split(&T, sol_in).unwrap().fee;
                let want = if n == rem { sol_in } else { exact };
                assert_eq!(q.charged, want, "the charge of 5.4");
                assert_eq!(q.charged - q.split.fee, rem, "Lemma G");
                assert_eq!(q.partial, q.charged < sol_in);
                assert_eq!(q.new_state.pool_sol, R);
                assert_eq!(q.new_state.pool_tokens, P);
            } else {
                assert!(
                    !q.partial && q.charged == sol_in && q.net == sol_in - q.split.fee,
                    "no dust"
                );
            }
        }
        assert_eq!(
            max_quote_in(&T, &st).unwrap(),
            exact.max(MIN_TRADE_LAMPORTS)
        );
    }
    // rem = 1: charged 1 lamport, fee 0, the last raw unit
    let st = curve_state(T, R - 1).st;
    let q = quote_buy(&T, &st, MIN_TRADE_LAMPORTS).unwrap();
    assert_eq!((q.charged, q.split.fee, q.tokens_out, q.net), (1, 0, 1, 1));
    // rem = 2 needs 2 lamports (fee 0); rem = 40 needs 41 (fee 1)
    assert_eq!(gross_for(&T, 2).unwrap(), 2);
    assert_eq!(gross_for(&T, 40).unwrap(), 41);
}

// ---------------------------------------------------------------- U08

#[test]
fn u08_buyback_quotes() {
    // no-op cases
    let mut m = Sim::launch(T, 1_000);
    m.slot = 1_000_000;
    assert_eq!(m.buyback().unwrap(), None, "empty bucket");
    m.buy(1_000_000_000).unwrap();
    m.slot = 1_149;
    assert_eq!(m.buyback().unwrap(), None, "interval not passed");
    m.slot = 1_150;
    assert!(
        m.buyback().unwrap().is_some(),
        "first run exactly 150 slots after launch"
    );
    m.check();

    // the cap binds and spent <= b <= buyback_pending
    let mut m = curve_state(T, 40_000_000_000);
    m.inject_buyback(10_000_000_000_000);
    m.slot = 10_000;
    let cap = buyback_cap(&T, &m.st).unwrap();
    let q = m.buyback().unwrap().unwrap();
    assert_eq!(
        (q.cap, q.spent),
        (cap, cap),
        "the cap binds and is spent exactly (Lemma C3)"
    );
    m.check();

    // never graduates: from just below the end the run stops at S - 1
    let mut m = curve_state(T, R - 200_000);
    m.inject_buyback(10_000_000_000_000);
    m.slot = 10_000;
    let q = m.buyback().unwrap().unwrap();
    assert_eq!(m.st.tokens_sold, S - 1, "capped at S - 1 coins sold");
    assert_eq!(m.st.curve_sol, R - 1);
    assert!(q.spent <= q.cap);
    m.check();
    m.slot += 150;
    assert_eq!(
        m.buyback().unwrap(),
        None,
        "curve_sol == f(S - 1): the next user buy graduates"
    );
    let q = m.buy(MIN_TRADE_LAMPORTS).unwrap();
    assert!(
        q.graduates && q.charged == 1,
        "a bundled 0.0001 SOL buy graduates, charged 1 lamport"
    );
    m.slot += 150;
    assert!(
        m.buyback().unwrap().is_some(),
        "buybacks proceed in the pool"
    );
    m.check();

    // the unreachable state on the last flat step below S - 1 (2,433 raw units)
    let s = tokens_for(&T, R - 2).unwrap() + 1;
    assert_eq!(S - 1 - s, 2_433);
    assert_eq!(curve_value(&T, s).unwrap(), R - 1);
    let st = State {
        tokens_sold: s,
        curve_sol: R - 1,
        buyback_pending: 1_000_000_000,
        ..State::at_launch(0)
    };
    assert_eq!(
        quote_buyback(&T, &st, 1_000_000).unwrap(),
        None,
        "spent 0: a no-op"
    );

    // cap 0 (only with terms outside V4) and 0 coins in the pool are no-ops
    let tiny = Terms {
        virtual_sol: 1,
        ..T
    };
    let st = State {
        buyback_pending: 5,
        ..State::at_launch(0)
    };
    assert_eq!(buyback_cap(&tiny, &st).unwrap(), 0);
    assert_eq!(quote_buyback(&tiny, &st, 1_000).unwrap(), None, "cap 0");
    let st = State {
        phase: Phase::Pool,
        pool_sol: 10_000_000_000_000,
        pool_tokens: 1,
        buyback_pending: 1_000,
        ..State::at_launch(0)
    };
    assert_eq!(quote_buyback(&T, &st, 1_000).unwrap(), None, "0 coins");
}

// ---------------------------------------------------------------- U09

#[test]
fn u09_overflow_and_division_edges() {
    // u64::MAX inputs never panic
    let st = State::at_launch(0);
    let q = quote_buy(&T, &st, u64::MAX).unwrap();
    assert!(
        q.graduates && q.partial && q.charged == 87_179_487_179,
        "a curve buy of u64::MAX is a partial fill"
    );
    let pool = q.new_state;
    // X + n would still fit u64, but the coin's liabilities (reserve plus the five
    // buckets, L included) would not: the buy is refused so that pay_out's sum can
    // never overflow and block sells (NOTES)
    let n_max = u64::MAX - fee_split(&T, u64::MAX).unwrap().fee;
    assert!((pool.pool_sol as u128 + n_max as u128) <= u64::MAX as u128);
    assert_eq!(
        quote_buy(&T, &pool, u64::MAX),
        Err(MathError::Overflow),
        "liabilities leave u64"
    );
    let q = quote_buy(&T, &pool, 1 << 63).unwrap();
    assert_eq!(
        liabilities(&q.new_state).unwrap(),
        liabilities(&pool).unwrap() + (1 << 63)
    );
    let full = State {
        pool_sol: u64::MAX - 1_000,
        ..pool
    };
    assert_eq!(
        quote_buy(&T, &full, u64::MAX),
        Err(MathError::Overflow),
        "X + n leaves u64"
    );
    let deep = State {
        pool_tokens: u64::MAX - 10,
        ..pool
    };
    assert_eq!(
        quote_sell(&T, &deep, u64::MAX),
        Err(MathError::Overflow),
        "Y + tokens_in leaves u64"
    );
    let most = u64::MAX - pool.pool_tokens;
    let q = quote_sell(&T, &pool, most).unwrap();
    assert!(
        q.gross < pool.pool_sol,
        "X * tokens_in fits u128 and gross < X (Lemma P)"
    );
    assert_eq!(
        quote_sell(&T, &pool, most + 1),
        Err(MathError::Overflow),
        "Y + tokens_in leaves u64"
    );
    assert_eq!(
        quote_sell(&T, &st, u64::MAX),
        Err(MathError::SellExceedsCurve)
    );
    let big = State {
        buyback_pending: u64::MAX,
        ..pool
    };
    assert!(quote_buyback(&T, &big, u64::MAX).unwrap().is_some());
    let late = State {
        last_buyback_slot: u64::MAX,
        ..big
    };
    assert_eq!(
        quote_buyback(&T, &late, u64::MAX),
        Err(MathError::Overflow),
        "slot + interval leaves u64"
    );
    assert_eq!(
        fee_split(&T, u64::MAX).unwrap().fee,
        (u64::MAX as u128 * 250 / 10_000) as u64
    );
    assert_eq!(gross_for(&T, u64::MAX), Err(MathError::Overflow));
    assert_eq!(gross_for(&terms_with_t(0), u64::MAX), Ok(u64::MAX));
    let sat = State {
        platform_pending: u64::MAX,
        ..st
    };
    assert_eq!(
        quote_buy(&T, &sat, 1_000_000_000),
        Err(MathError::Overflow),
        "a bucket leaves u64"
    );
    assert_eq!(liabilities(&sat), Ok(u64::MAX));
    assert_eq!(
        liabilities(&State {
            holders_pending: 1,
            ..sat
        }),
        Err(MathError::Overflow)
    );
    let counters = State {
        buy_volume: u128::MAX,
        ..st
    };
    assert_eq!(
        quote_buy(&T, &counters, 1_000_000_000),
        Err(MathError::Overflow),
        "lifetime counters are checked too"
    );

    // x0 = y0 = 2^60, t = 250, R = 10^13: the largest intermediate (5.12) fits
    let probe = Terms {
        virtual_sol: MAX_VIRTUAL,
        virtual_tokens: MAX_VIRTUAL,
        curve_supply: 20_000_000_000_000,
        pool_supply: COIN_SUPPLY - 20_000_000_000_000,
        graduation_sol: 1,
        ..T
    };
    let s_ext = tokens_for(&probe, MAX_GRADUATION_LAMPORTS).unwrap();
    let r_ext = curve_value(&probe, s_ext).unwrap();
    let ext = Terms {
        curve_supply: s_ext,
        pool_supply: COIN_SUPPLY - s_ext,
        graduation_sol: r_ext,
        ..probe
    };
    assert!(r_ext <= MAX_GRADUATION_LAMPORTS);
    let mut m = Sim::launch(ext, 0);
    m.inject_buyback(u64::MAX / 4);
    m.slot = 1_000;
    let q = m.buyback().unwrap().unwrap();
    assert!(q.cap > 1_000_000_000_000_000, "cap of 0.1% of 2^60");
    assert_eq!(
        m.st.tokens_sold,
        s_ext - 1,
        "even the largest run stops at S - 1"
    );
    let q = m.buy(u64::MAX).unwrap();
    assert!(q.graduates);
    m.slot += 150;
    assert!(m.buyback().unwrap().is_some());
    m.check();

    // division edges: terms that break 5.1's preconditions are refused, never divide by zero
    assert_eq!(
        curve_value(
            &Terms {
                virtual_tokens: S,
                ..T
            },
            0
        ),
        Err(MathError::InvalidTerms),
        "y0 > S"
    );
    assert_eq!(
        tokens_for(
            &Terms {
                virtual_sol: 0,
                ..T
            },
            0
        ),
        Err(MathError::InvalidTerms),
        "x0 >= 1"
    );
    assert_eq!(
        fee_split(&terms_with_t(10_000), 1),
        Err(MathError::InvalidTerms),
        "t < D"
    );
    assert_eq!(
        gross_for(
            &Terms {
                total_fee_bps: 251,
                ..T
            },
            1
        ),
        Err(MathError::InvalidTerms),
        "t is the sum"
    );
    let bad_phase_state = State {
        tokens_sold: S,
        ..State::at_launch(0)
    };
    assert_eq!(
        quote_buy(&T, &bad_phase_state, 1_000_000),
        Err(MathError::InvalidState)
    );
    assert_eq!(
        quote_sell(&T, &State { curve_sol: R, ..st }, 1),
        Err(MathError::InvalidState)
    );
    assert_eq!(max_quote_in(&T, &pool), Err(MathError::WrongPhase));
    assert_eq!(
        Terms::from_params(&ConfigParams {
            liquidity_bps: u16::MAX,
            platform_bps: 1,
            ..ConfigParams::DEFAULT
        }),
        Err(MathError::InvalidTerms)
    );
    // derive_curve with impossible inputs
    assert_eq!(
        derive_curve(P, S, R),
        Err(MathError::InvalidTerms),
        "S <= P"
    );
    assert_eq!(derive_curve(S, 0, R), Err(MathError::InvalidTerms));
    assert_eq!(derive_curve(S, P, 1), Err(MathError::InvalidTerms));
    assert_eq!(
        derive_curve(u64::MAX, u64::MAX - 1, u64::MAX),
        Err(MathError::InvalidTerms)
    );
}

// ---------------------------------------------------------------- U10

/// The `Coin` account written field by field in Borsh order (3.7), as the
/// program's `CurveCoin` serialises it. Returns the bytes and checks that each
/// field lands at its documented offset.
fn coin_bytes(v: &CoinView) -> Vec<u8> {
    let mut b = Vec::with_capacity(COIN_ACCOUNT_LEN);
    let put = |b: &mut Vec<u8>, at: usize, bytes: &[u8]| {
        assert_eq!(b.len(), at, "field at offset {at}");
        b.extend_from_slice(bytes);
    };
    let (t, st) = (&v.terms, &v.state);
    put(&mut b, 0, &CURVE_COIN_DISCRIMINATOR);
    put(&mut b, 8, &[v.layout_version]);
    put(&mut b, 9, &[v.phase.as_u8()]);
    put(&mut b, 10, &[v.bump]);
    put(&mut b, 11, &[v.mint_bump]);
    put(&mut b, 12, &[v.vault_bump]);
    put(&mut b, 13, &v.config_id.to_le_bytes());
    put(&mut b, 15, &v.city_id.to_le_bytes());
    put(&mut b, 23, &v.mint);
    put(&mut b, 55, &v.vault);
    put(&mut b, 87, &v.founder);
    put(&mut b, 119, &v.symbol);
    put(&mut b, 129, &t.liquidity_bps.to_le_bytes());
    put(&mut b, 131, &t.platform_bps.to_le_bytes());
    put(&mut b, 133, &t.founder_bps.to_le_bytes());
    put(&mut b, 135, &t.holders_bps.to_le_bytes());
    put(&mut b, 137, &t.buyback_bps.to_le_bytes());
    put(&mut b, 139, &t.total_fee_bps.to_le_bytes());
    put(&mut b, 141, &t.virtual_sol.to_le_bytes());
    put(&mut b, 149, &t.virtual_tokens.to_le_bytes());
    put(&mut b, 157, &t.curve_supply.to_le_bytes());
    put(&mut b, 165, &t.pool_supply.to_le_bytes());
    put(&mut b, 173, &t.graduation_sol.to_le_bytes());
    put(&mut b, 181, &v.dust_burned.to_le_bytes());
    put(&mut b, 189, &st.tokens_sold.to_le_bytes());
    put(&mut b, 197, &st.curve_sol.to_le_bytes());
    put(&mut b, 205, &st.pool_sol.to_le_bytes());
    put(&mut b, 213, &st.pool_tokens.to_le_bytes());
    put(&mut b, 221, &st.liquidity_pending.to_le_bytes());
    put(&mut b, 229, &st.platform_pending.to_le_bytes());
    put(&mut b, 237, &st.founder_pending.to_le_bytes());
    put(&mut b, 245, &st.holders_pending.to_le_bytes());
    put(&mut b, 253, &st.buyback_pending.to_le_bytes());
    put(&mut b, 261, &v.launched_at.to_le_bytes());
    put(&mut b, 269, &v.launch_slot.to_le_bytes());
    put(&mut b, 277, &v.graduated_at.to_le_bytes());
    put(&mut b, 285, &v.graduation_slot.to_le_bytes());
    put(&mut b, 293, &st.last_buyback_slot.to_le_bytes());
    put(&mut b, 301, &v.last_payout_at.to_le_bytes());
    put(&mut b, 309, &v.payout_seq.to_le_bytes());
    put(&mut b, 317, &st.trade_seq.to_le_bytes());
    put(&mut b, 325, &st.buyback_count.to_le_bytes());
    put(&mut b, 333, &st.tokens_burned.to_le_bytes());
    put(&mut b, 341, &st.buy_volume.to_le_bytes());
    put(&mut b, 357, &st.sell_volume.to_le_bytes());
    put(&mut b, 373, &st.fees_total.to_le_bytes());
    put(&mut b, 389, &st.liquidity_earned.to_le_bytes());
    put(&mut b, 405, &st.liquidity_added.to_le_bytes());
    put(&mut b, 421, &st.platform_earned.to_le_bytes());
    put(&mut b, 437, &v.platform_withdrawn.to_le_bytes());
    put(&mut b, 453, &st.founder_earned.to_le_bytes());
    put(&mut b, 469, &v.founder_claimed.to_le_bytes());
    put(&mut b, 485, &v.founder_paid_out.to_le_bytes());
    put(&mut b, 501, &st.holders_earned.to_le_bytes());
    put(&mut b, 517, &v.holders_forwarded.to_le_bytes());
    put(&mut b, 533, &st.buyback_earned.to_le_bytes());
    put(&mut b, 549, &st.buyback_spent.to_le_bytes());
    put(&mut b, 565, &v.meta_hash);
    put(&mut b, 597, &v.rent_reserve.to_le_bytes());
    put(&mut b, 605, &[0u8; 88]);
    assert_eq!(b.len(), COIN_ACCOUNT_LEN);
    b
}

fn sample_view() -> CoinView {
    let mut m = Sim::launch(T, 7_000);
    m.buy(100_000_000_000).unwrap();
    m.buy(3_000_000_000).unwrap();
    m.slot = 9_000;
    m.buyback().unwrap().unwrap();
    m.sell(1_000_000_000).unwrap();
    let mut i = 0u8;
    let mut next = || {
        i = i.wrapping_add(37);
        i
    };
    let mut key = || core::array::from_fn::<u8, 32, _>(|_| next());
    CoinView {
        layout_version: 1,
        phase: m.st.phase,
        bump: 254,
        mint_bump: 253,
        vault_bump: 252,
        config_id: 7,
        city_id: 2_643_743,
        mint: key(),
        vault: key(),
        founder: key(),
        symbol: *b"LONDON\0\0\0\0",
        terms: T,
        dust_burned: 9_100_000,
        launched_at: 1_792_000_000,
        launch_slot: 7_000,
        graduated_at: 1_792_000_100,
        graduation_slot: 7_250,
        last_payout_at: -5,
        payout_seq: 3,
        platform_withdrawn: 11,
        founder_claimed: 12,
        founder_paid_out: 13,
        holders_forwarded: 14,
        meta_hash: key(),
        rent_reserve: 5_714_160,
        state: m.st,
    }
}

/// Base58 (Bitcoin alphabet) of 32 bytes, for the program-id constant.
fn base58(bytes: &[u8; 32]) -> String {
    const A: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = Vec::new();
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|&&b| b == 0).count();
    std::iter::repeat_n('1', zeros)
        .chain(digits.iter().rev().map(|&d| A[d as usize] as char))
        .collect()
}

#[test]
fn u10_decode_coin_layout_and_rejections() {
    assert_eq!(
        base58(&PROGRAM_ID),
        "nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk"
    );
    let v = sample_view();
    let bytes = coin_bytes(&v);
    let got = decode_coin(&PROGRAM_ID, &bytes).unwrap();
    assert_eq!(got, v, "round trip through the fixed offsets of 3.7");
    assert_eq!(got.terms(), T);
    assert_eq!(got.state(), v.state);
    // the decoded coin quotes like the original
    assert_eq!(
        quote_sell(&got.terms(), &got.state(), 1_000),
        quote_sell(&T, &v.state, 1_000)
    );

    let mut other_owner = PROGRAM_ID;
    other_owner[0] ^= 1;
    assert_eq!(
        decode_coin(&other_owner, &bytes),
        Err(DecodeError::WrongOwner)
    );
    assert_eq!(
        decode_coin(&PROGRAM_ID, &bytes[..692]),
        Err(DecodeError::WrongLength)
    );
    let mut longer = bytes.clone();
    longer.push(0);
    assert_eq!(
        decode_coin(&PROGRAM_ID, &longer),
        Err(DecodeError::WrongLength)
    );
    let mut bad = bytes.clone();
    bad[8] = 2;
    assert_eq!(
        decode_coin(&PROGRAM_ID, &bad),
        Err(DecodeError::WrongLayoutVersion)
    );
    let mut bad = bytes.clone();
    bad[9] = 2;
    assert_eq!(
        decode_coin(&PROGRAM_ID, &bad),
        Err(DecodeError::InvalidPhase)
    );
    // the old program's Coin discriminator, sha256("account:Coin")[..8]
    let mut legacy = bytes.clone();
    legacy[..8].copy_from_slice(&[215, 195, 53, 238, 217, 196, 213, 51]);
    assert_eq!(
        decode_coin(&PROGRAM_ID, &legacy),
        Err(DecodeError::WrongDiscriminator)
    );
    assert_eq!(
        decode_coin(&PROGRAM_ID, &[0u8; 693]),
        Err(DecodeError::WrongDiscriminator)
    );
}
