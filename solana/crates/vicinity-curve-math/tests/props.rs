//! Property tests P01 to P10 of VICINITY-CURVE-DESIGN.md 12.2.
//!
//! CI runs a small number of cases per property (see `common::cases`); the
//! spec's "at least 10^6 cases each" is
//! `PROPTEST_CASES=1000000 cargo test --release -p vicinity-curve-math --test props`.

mod common;

use common::*;
use proptest::prelude::*;
use std::collections::HashMap;
use vicinity_curve_math::constants::*;
use vicinity_curve_math::*;

/// One random operation of a coin's life.
#[derive(Clone, Debug)]
enum Op {
    Buy(u64),
    /// Sell a fraction (per mille) of one of four users' coins.
    Sell(u8, u16),
    /// Sell a few raw units (flat steps, dust).
    SellDust(u64),
    /// Advance the slot, then run the buyback crank.
    Buyback(u64),
    Pay(u8),
    InjectBuyback(u64),
    InjectLiquidity(u64),
}

fn buy_amount() -> impl Strategy<Value = u64> {
    prop_oneof![
        1 => 0u64..200_000,
        8 => (480u32..1140).prop_map(|e| 10f64.powf(e as f64 / 100.0) as u64),
        1 => Just(u64::MAX),
    ]
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        8 => buy_amount().prop_map(Op::Buy),
        6 => (0u8..4, 1u16..=1000).prop_map(|(u, f)| Op::Sell(u, f)),
        1 => (1u64..5_000).prop_map(Op::SellDust),
        3 => prop_oneof![Just(0u64), Just(149), Just(150), 0u64..1_000].prop_map(Op::Buyback),
        1 => (0u8..3).prop_map(Op::Pay),
        1 => (1_000_000u64..10_000_000_000_000).prop_map(Op::InjectBuyback),
        1 => (1_000_000u64..100_000_000_000).prop_map(Op::InjectLiquidity),
    ]
}

/// What one applied operation did, for the per-operation properties.
enum Done {
    Buy(State, BuyQuote),
    Sell(State, SellQuote),
    Buyback(BuybackQuote),
    Other,
}

/// Applies one operation (errors are fine: a refused trade changes nothing),
/// checks the invariants of `Sim::check`, and reports what happened.
fn apply(m: &mut Sim, held: &mut [u64; 4], op: &Op) -> Done {
    let before = m.st;
    let done = match *op {
        Op::Buy(g) => match m.buy(g) {
            Ok(q) => {
                held[(q.tokens_out % 4) as usize] += q.tokens_out;
                Done::Buy(before, q)
            }
            Err(e) => {
                // Overflow only for amounts no wallet can hold (the coin's liabilities
                // would leave u64); P10 forbids it below 2^59 lamports.
                let ok = matches!(e, MathError::TradeTooSmall | MathError::ZeroOutput)
                    || (e == MathError::Overflow && g >= 1 << 62);
                assert!(ok, "buy {g}: {e:?}");
                Done::Other
            }
        },
        Op::Sell(u, f) => {
            let h = held[u as usize];
            let tk = ((h as u128 * f as u128) / 1000) as u64;
            if tk == 0 {
                return Done::Other;
            }
            match m.sell(tk) {
                Ok(q) => {
                    held[u as usize] -= tk;
                    Done::Sell(before, q)
                }
                Err(e) => {
                    assert_eq!(e, MathError::ZeroOutput);
                    Done::Other
                }
            }
        }
        Op::SellDust(tk) => {
            // a few raw units from a user who holds them (flat steps, dust)
            let Some(u) = (0..4).find(|&u| held[u] >= tk) else {
                return Done::Other;
            };
            match m.sell(tk) {
                Ok(q) => {
                    held[u] -= tk;
                    Done::Sell(before, q)
                }
                Err(e) => {
                    assert_eq!(e, MathError::ZeroOutput);
                    Done::Other
                }
            }
        }
        Op::Buyback(dt) => {
            m.slot += dt;
            match m.buyback().unwrap() {
                Some(q) => Done::Buyback(q),
                None => Done::Other,
            }
        }
        Op::Pay(w) => {
            m.pay(w);
            Done::Other
        }
        Op::InjectBuyback(x) => {
            m.inject_buyback(x);
            Done::Other
        }
        Op::InjectLiquidity(x) => {
            m.inject_liquidity(x);
            Done::Other
        }
    };
    m.check();
    done
}

fn run(t: Terms, ops: &[Op]) -> Sim {
    let mut m = Sim::launch(t, 0);
    let mut held = [0u64; 4];
    for o in ops {
        apply(&mut m, &mut held, o);
    }
    m
}

/// Reachable states: a random prefix on a random valid config.
fn reached() -> impl Strategy<Value = Sim> {
    (valid_config(), prop::collection::vec(op(), 0..12)).prop_map(|(p, ops)| run(terms(&p), &ops))
}

proptest! {
    #![proptest_config(config(4096))]

    /// P01: random curve operation sequences keep curve_sol == f(tokens_sold)
    /// (I4), with every other invariant of `Sim::check` after every operation.
    #[test]
    fn p01_curve_state_function(p in valid_config(), ops in prop::collection::vec(op(), 1..40)) {
        let t = terms(&p);
        let mut m = Sim::launch(t, 0);
        let mut held = [0u64; 4];
        for o in &ops {
            apply(&mut m, &mut held, o);
            if m.st.phase == Phase::Curve {
                prop_assert_eq!(m.st.curve_sol, curve_value(&t, m.st.tokens_sold).unwrap());
                prop_assert!(m.st.curve_sol < t.graduation_sol);
            }
        }
    }

    /// P02: sequences returning to the same s give the same curve_sol (path
    /// independence): every visited s maps to one r, and buying then selling
    /// the same coins back in pieces returns to the starting (s, r) exactly.
    #[test]
    fn p02_path_independence(
        p in valid_config(),
        prefix in prop::collection::vec(buy_amount(), 0..4),
        buys in prop::collection::vec(100_000u64..3_000_000_000, 1..6),
        cuts in prop::collection::vec(1u16..1000, 0..6),
        ops in prop::collection::vec(op(), 1..30),
    ) {
        let t = terms(&p);
        let mut m = Sim::launch(t, 0);
        for g in prefix {
            // at most half of what the curve still needs, so the prefix never graduates
            let half = ((t.graduation_sol - m.st.curve_sol) / 2).max(1);
            let _ = m.buy(g.min(gross_for(&t, half).unwrap()));
            prop_assert_eq!(m.st.phase, Phase::Curve);
        }
        let (s0, r0) = (m.st.tokens_sold, m.st.curve_sol);
        let mut coins = 0u64;
        for g in buys {
            match m.buy(g) {
                Ok(q) if !q.graduates => coins += q.tokens_out,
                _ => return Ok(()),
            }
        }
        let mut left = coins;
        for c in cuts {
            let tk = (left as u128 * c as u128 / 1000) as u64;
            if tk > 0 && tk < left && m.sell(tk).is_ok() { left -= tk; }
        }
        if left > 0 && m.sell(left).is_ok() { left = 0; }
        if left == 0 {
            prop_assert_eq!((m.st.tokens_sold, m.st.curve_sol), (s0, r0));
        }
        // any sequence: one curve_sol per tokens_sold
        let mut seen: HashMap<u64, u64> = HashMap::new();
        let mut m = Sim::launch(t, 0);
        let mut held = [0u64; 4];
        for o in &ops {
            apply(&mut m, &mut held, o);
            if m.st.phase == Phase::Curve {
                let r = *seen.entry(m.st.tokens_sold).or_insert(m.st.curve_sol);
                prop_assert_eq!(r, m.st.curve_sol);
            }
        }
    }

    /// P03: non-completing buys put every net lamport into the curve (c == n,
    /// no dust; Lemma C3), under random valid configs and reachable states.
    #[test]
    fn p03_no_dust(m in reached(), g in buy_amount()) {
        if m.st.phase != Phase::Curve { return Ok(()); }
        if let Ok(q) = quote_buy(&m.t, &m.st, g) {
            let fee = fee_split(&m.t, g).unwrap().fee;
            if !q.graduates {
                prop_assert_eq!(q.charged, g);
                prop_assert_eq!(q.net, g - fee);
                prop_assert!(!q.partial);
                prop_assert_eq!(q.new_state.curve_sol, m.st.curve_sol + q.net);
            } else {
                prop_assert_eq!(q.net, m.t.graduation_sol - m.st.curve_sol);
                prop_assert!(q.charged <= g);
            }
        }
    }

    /// P04: in the pool, X * Y never decreases across any operation and both
    /// reserves stay positive (Lemma P, I6).
    #[test]
    fn p04_pool_product(
        p in valid_config(),
        extra in prop_oneof![Just(0u64), 0u64..300_000_000_000],
        ops in prop::collection::vec(op(), 1..40),
    ) {
        let mut m = pool_state(terms(&p), extra);
        let mut held = [m.t.curve_supply, 0, 0, 0];
        for o in &ops {
            let k0 = m.st.pool_sol as u128 * m.st.pool_tokens as u128;
            apply(&mut m, &mut held, o);
            let k1 = m.st.pool_sol as u128 * m.st.pool_tokens as u128;
            prop_assert!(k1 >= k0, "X * Y fell from {} to {}", k0, k1);
            prop_assert!(m.st.pool_sol >= 1 && m.st.pool_tokens >= 1);
        }
    }

    /// P05: a buy followed by a sell of the coins bought, from any reachable
    /// state, returns less than was charged (I18), and at most
    /// (1 - f)(1 - f + 2 b_L / D) of it plus a few lamports of rounding (5.15).
    #[test]
    fn p05_round_trip(m0 in reached(), extra in prop_oneof![Just(0u64), 0u64..200_000_000_000], g in 100_000u64..2_000_000_000_000) {
        let mut m = m0;
        if m.st.phase == Phase::Pool { m.inject_liquidity(extra); }
        let Ok(q) = m.buy(g) else { return Ok(()); };
        let Ok(s) = m.sell(q.tokens_out) else { return Ok(()); };
        m.check();
        let (t, l) = (m.t.total_fee_bps as u128, m.t.liquidity_bps as u128);
        prop_assert!(s.sol_out < q.charged, "no free value: {} back for {}", s.sol_out, q.charged);
        prop_assert!(s.sol_out as u128 * D * D <= q.charged as u128 * (D - t) * (D - t + 2 * l) + 6 * D * D);
    }

    /// P07: ledger identities and liabilities conservation after every
    /// operation (I7, I8, I9, I10), including payouts and injected balances.
    #[test]
    fn p07_ledgers_and_conservation(p in valid_config(), ops in prop::collection::vec(op(), 1..60)) {
        let t = terms(&p);
        let mut m = Sim::launch(t, 0);
        let mut held = [0u64; 4];
        for o in &ops {
            let lam0 = m.lam;
            let seq0 = m.st.trade_seq;
            let paid0 = m.platform_paid + m.founder_paid + m.holders_paid;
            let done = apply(&mut m, &mut held, o);
            let traded = matches!(done, Done::Buy(..) | Done::Sell(..));
            prop_assert_eq!(m.st.trade_seq, seq0 + traded as u64, "trade_seq grows by exactly 1 per trade");
            let paid = m.platform_paid + m.founder_paid + m.holders_paid - paid0;
            match done {
                Done::Buy(_, q) => {
                    prop_assert_eq!(m.lam, lam0 + q.charged, "buy: liabilities grow by charged = c + fee");
                    prop_assert_eq!(q.charged, q.net + q.split.fee);
                }
                Done::Sell(_, q) => {
                    prop_assert_eq!(m.lam, lam0 - q.sol_out, "sell: liabilities change by -gross + fee");
                    prop_assert_eq!(q.sol_out, q.gross - q.split.fee);
                }
                Done::Buyback(q) => {
                    prop_assert_eq!(m.lam, lam0, "buyback: no lamport moves");
                    prop_assert!(q.spent <= q.cap && q.spent >= 1 && q.coins >= 1);
                }
                Done::Other => prop_assert!(m.lam == lam0 - paid as u64 || m.lam > lam0),
            }
        }
    }

    /// P08: fee * D <= A * t and fee > A * t / D - 1 for all A, and Lemma F.
    #[test]
    fn p08_fee_bounds(a in any::<u64>(), bps in (0u16..=2_000, 0u16..=2_000, 0u16..=2_000, 0u16..=2_000, 0u16..=1_999)) {
        let t = Terms {
            liquidity_bps: bps.0, platform_bps: bps.1, founder_bps: bps.2, holders_bps: bps.3, buyback_bps: bps.4,
            total_fee_bps: bps.0 + bps.1 + bps.2 + bps.3 + bps.4, ..Terms::DEFAULT
        };
        let s = fee_split(&t, a).unwrap();
        let at = a as u128 * t.total_fee_bps as u128;
        prop_assert!(s.fee as u128 * D <= at);
        prop_assert!((s.fee as u128 + 1) * D > at);
        prop_assert_eq!(s.fee, s.liquidity + s.platform + s.founder + s.holders + s.buyback);
        prop_assert!(s.liquidity >= s.liquidity_floor && s.liquidity <= s.liquidity_floor + 4);
    }

    /// P09: drip <= min(L, floor(A * b_L / D)), and drip only in the pool (I12, I16).
    #[test]
    fn p09_drip_bounds(p in valid_config(), ops in prop::collection::vec(op(), 1..50)) {
        let t = terms(&p);
        let mut m = Sim::launch(t, 0);
        let mut held = [0u64; 4];
        for o in &ops {
            let l0 = m.st.liquidity_pending;
            match apply(&mut m, &mut held, o) {
                Done::Buy(before, q) => {
                    let a = q.charged as u128 * t.liquidity_bps as u128 / D;
                    prop_assert!(q.drip as u128 <= a && q.drip <= l0);
                    if before.phase == Phase::Curve { prop_assert_eq!(q.drip, 0); }
                    else { prop_assert_eq!(m.st.liquidity_pending, l0 - q.drip, "L only falls in the pool"); }
                }
                Done::Sell(before, q) => {
                    let a = q.gross as u128 * t.liquidity_bps as u128 / D;
                    prop_assert!(q.drip as u128 <= a && q.drip <= l0);
                    if before.phase == Phase::Curve {
                        prop_assert_eq!(q.drip, 0);
                        prop_assert_eq!(m.st.liquidity_pending, l0 + q.split.liquidity, "L only grows on the curve");
                    } else { prop_assert_eq!(m.st.liquidity_pending, l0 - q.drip); }
                }
                _ => {}
            }
        }
    }
}

/// Kinds of starting state for the buyback attacks (checks.py `kinds`).
fn attack_state() -> impl Strategy<Value = Sim> {
    (
        valid_config(),
        0u32..=1000,
        prop_oneof![
            Just(0u64),
            Just(10_000_000_000),
            Just(200_000_000_000),
            0u64..300_000_000_000
        ],
        any::<bool>(),
    )
        .prop_map(|(p, frac, extra, pool)| {
            let t = terms(&p);
            let mut m = if pool {
                pool_state(t, extra)
            } else {
                curve_state(t, (t.graduation_sol as u128 * frac as u128 / 1001) as u64)
            };
            m.slot = 1_000_000;
            m
        })
}

fn credit() -> impl Strategy<Value = Credit> {
    prop_oneof![
        Just(Credit::None),
        Just(Credit::Founder),
        Just(Credit::FounderHolders)
    ]
}

/// Splits `a` into legs at the cut points (per mille), dropping legs below the
/// minimum buy (checks.py does the same).
fn legs(a: u64, cuts: &[u16]) -> Vec<u64> {
    let mut pts: Vec<u64> = cuts
        .iter()
        .map(|&c| (a as u128 * c as u128 / 1000) as u64)
        .collect();
    pts.sort_unstable();
    let mut out = Vec::new();
    let mut prev = 0;
    for p in pts.into_iter().chain(std::iter::once(a)) {
        if p - prev >= MIN_TRADE_LAMPORTS {
            out.push(p - prev);
        }
        prev = p;
    }
    out
}

proptest! {
    #![proptest_config(config(1024))]

    /// P06: the single-run buyback sandwich (attacker buys, one buyback runs
    /// with the cap binding, attacker sells), canonical and random multi-leg,
    /// for attackers credited nothing, the founder share, and the founder and
    /// holders shares: never a profit, and each result within Theorem M
    /// (canonical) or the split-leg bound (multi-leg), plus rounding (7.3).
    /// Only configs with a buyback share: without one no backlog ever accrues.
    #[test]
    fn p06_buyback_sandwich(
        m0 in attack_state(),
        a_exp in 550u32..1230,
        buy_cuts in prop::collection::vec(1u16..1000, 0..6),
        sell_cuts in prop::collection::vec(1u16..1000, 0..6),
        credit in credit(),
    ) {
        let mut m0 = m0;
        // a config without a buyback share never accrues a backlog: no run, nothing to sandwich
        if m0.t.buyback_bps == 0 { return Ok(()); }
        m0.inject_buyback(1_000_000_000_000_000); // unlimited backlog: the cap binds
        let a = 10f64.powf(a_exp as f64 / 100.0) as u64;
        let canonical = buy_cuts.is_empty() && sell_cuts.is_empty();
        let buys = legs(a, &buy_cuts);
        if buys.is_empty() { return Ok(()); }
        let pool_buy = m0.st.phase == Phase::Pool;
        let Some((paid, got)) = sandwich(&m0, &buys, &sell_cuts, credit) else { return Ok(()); };
        prop_assert!(got < paid, "profit: {} back for {}", got, paid);
        let l2 = 2 * m0.t.liquidity_bps as u128;
        let (num, den) = if canonical {
            sandwich_bound(&m0.t, credit, if pool_buy { l2 } else { 0 }, 0)
        } else {
            sandwich_bound(&m0.t, credit, l2, l2)
        };
        let slack = 8 + 4 * (buys.len() + sell_cuts.len() + 1) as u128;
        prop_assert!(got * den <= paid * num + slack * den, "bound: got {} paid {} ({:?})", got, paid, credit);
    }

    /// P06b: hold-through (Theorem M_K): a backlog of 0.5% to 10% of depth, of
    /// 10 caps, or unlimited, held for 1 to 30 runs with no other trade. Every
    /// result is within (1 + B/X1)^2 (1 - f)(1 - f + 2l) plus rounding; a profit
    /// needs B/X1 above u*, and never comes before K* runs.
    #[test]
    fn p06b_hold_through(
        m0 in attack_state(),
        backlog in prop_oneof![
            (5u64..=100).prop_map(|permille| (0u8, permille)),
            Just((1u8, 10)),
            Just((2u8, 0)),
        ],
        a_exp in 800u32..1100,
        k in 1u32..=30,
    ) {
        let mut m = m0;
        if m.t.buyback_bps == 0 { return Ok(()); }
        let dep = depth(&m.t, &m.st).unwrap();
        let cap = buyback_cap(&m.t, &m.st).unwrap();
        let have = m.st.buyback_pending;
        let want = match backlog {
            (0, permille) => dep / 1000 * permille,
            (1, n) => cap * n,
            _ => 1_000_000_000_000_000,
        };
        m.inject_buyback(want.saturating_sub(have).max(1));
        let a = 10f64.powf(a_exp as f64 / 100.0) as u64;
        let pool = m.st.phase == Phase::Pool;
        let Some((paid, out, spent, x1)) = hold(&m, a, k) else { return Ok(()); };
        let (t, l) = (m.t.total_fee_bps as f64, m.t.liquidity_bps as f64);
        let d = D as f64;
        let inj = if pool { 2.0 * l / d } else { 0.0 };
        let u = spent as f64 / x1 as f64;
        let f = t / d;
        let bound = (1.0 + u).powi(2) * (1.0 - f) * (1.0 - f + inj);
        let res = out as f64 - paid as f64;
        prop_assert!(res <= (bound - 1.0) * paid as f64 + 16.0 + paid as f64 * 1e-12,
            "M_K: result {} bound {} (u {}, k {})", res, bound, u, k);
        if res > 16.0 {
            let s = t / (BUYBACK_CAP_DIVISOR as f64 * d);
            let ustar = 1.0 / ((1.0 - f) * (1.0 - f + inj)).sqrt() - 1.0;
            prop_assert!(u > ustar * (1.0 - 1e-9), "profit below u*: u {} u* {}", u, ustar);
            let kstar = ((1.0 / ((1.0 - f) * (1.0 - f + inj))).ln() / (2.0 * (1.0 + s).ln())).ceil() as u32;
            prop_assert!(k >= kstar, "profit after {} runs, K* = {}", k, kstar);
        }
    }

    /// P09b: drip farming from random states under random configs passing V1
    /// to V11, by an attacker who holds the float and is credited the founder,
    /// holders and buyback shares: never a gain beyond the fee's rounding
    /// allowance of less than one lamport per trade (7.5, 5.11).
    #[test]
    fn p09b_drip_farming(
        p in valid_config(),
        extra in prop_oneof![Just(0u64), Just(4_000_000_000), Just(20_000_000_000), 0u64..50_000_000_000],
        w_exp in 800u32..1080,
        n in 1u32..=100,
    ) {
        let w = 10f64.powf(w_exp as f64 / 100.0) as u64;
        let (gain, trades) = farm(terms(&p), extra, w, n);
        // The fee is rounded down: it may favour the trader by less than one lamport
        // per trade (5.1, 5.11, T12), drip or no drip. Anything above that allowance
        // would be value released by the drip (NOTES 16).
        prop_assert!(gain <= trades as i128 + 1, "drip farming gained {} lamports in {} trades", gain, trades);
    }

    /// P10: random configs that pass V1 to V11, and the extreme terms
    /// x0 = y0 = 2^60 with t = 250: no overflow anywhere at extreme reachable
    /// states (buys up to 2^59 lamports, more than all SOL in existence, full
    /// sells, unlimited buyback backlogs).
    #[test]
    fn p10_no_overflow_at_extremes(
        p in prop_oneof![3 => valid_config(), 1 => Just(ConfigParams::DEFAULT)],
        extreme in any::<bool>(),
        ops in prop::collection::vec(
            prop_oneof![
                3 => (1u64 << 40..=1u64 << 59).prop_map(Op::Buy),
                2 => (0u8..4, 1u16..=1000).prop_map(|(u, f)| Op::Sell(u, f)),
                2 => Just(Op::Buyback(150)),
                1 => Just(Op::InjectBuyback(1 << 59)),
                1 => (0u8..3).prop_map(Op::Pay),
            ],
            1..20,
        ),
    ) {
        let t = if extreme {
            let probe = Terms {
                virtual_sol: MAX_VIRTUAL, virtual_tokens: MAX_VIRTUAL,
                curve_supply: 20_000_000_000_000, pool_supply: COIN_SUPPLY - 20_000_000_000_000,
                graduation_sol: 1, ..Terms::DEFAULT
            };
            let s = tokens_for(&probe, MAX_GRADUATION_LAMPORTS).unwrap();
            Terms { curve_supply: s, pool_supply: COIN_SUPPLY - s, graduation_sol: curve_value(&probe, s).unwrap(), ..probe }
        } else {
            terms(&p)
        };
        // `apply` refuses any error other than the expected trade refusals, so an
        // Overflow, DivisionByZero or InvalidState anywhere fails the test.
        run(t, &ops);
    }
}
