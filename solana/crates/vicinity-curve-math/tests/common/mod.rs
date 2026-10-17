//! Shared test helpers: a coin simulator that tracks the lamports and the vault
//! next to the math crate's state and checks the invariants of section 9 that
//! the math alone decides (I4, I6, I7, I8, I9, I10, the u64 bounds), config
//! builders, and the attack drivers of checks.py (sandwich, hold, farm).
#![allow(dead_code)]

use proptest::prelude::*;
use vicinity_curve_math::constants::*;
use vicinity_curve_math::*;

pub const D: u128 = BPS as u128;

/// Proptest case count: `PROPTEST_CASES` when set (the spec's 10^6 is
/// `PROPTEST_CASES=1000000 cargo test --release -p vicinity-curve-math`),
/// otherwise `default` (sized so the whole crate runs in well under 2 minutes
/// in CI's debug build).
pub fn cases(default: u32) -> u32 {
    std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

pub fn config(default_cases: u32) -> ProptestConfig {
    ProptestConfig {
        cases: cases(default_cases),
        max_local_rejects: u32::MAX,
        max_global_rejects: u32::MAX,
        failure_persistence: None,
        ..ProptestConfig::default()
    }
}

pub fn params(bps: [u16; 5], x0: u64, y0: u64, s: u64, p: u64, r: u64) -> ConfigParams {
    ConfigParams {
        liquidity_bps: bps[0],
        platform_bps: bps[1],
        founder_bps: bps[2],
        holders_bps: bps[3],
        buyback_bps: bps[4],
        virtual_sol: x0,
        virtual_tokens: y0,
        curve_supply: s,
        pool_supply: p,
        graduation_sol: r,
        launch_fee_lamports: 50_000_000,
    }
}

pub fn with_bps(bps: [u16; 5]) -> ConfigParams {
    let d = ConfigParams::DEFAULT;
    ConfigParams {
        liquidity_bps: bps[0],
        platform_bps: bps[1],
        founder_bps: bps[2],
        holders_bps: bps[3],
        buyback_bps: bps[4],
        ..d
    }
}

pub fn terms(p: &ConfigParams) -> Terms {
    Terms::from_params(p).unwrap()
}

/// Terms whose whole fee is `t` basis points (as liquidity), for the fee
/// functions only.
pub fn terms_with_t(t: u16) -> Terms {
    Terms {
        liquidity_bps: t,
        platform_bps: 0,
        founder_bps: 0,
        holders_bps: 0,
        buyback_bps: 0,
        total_fee_bps: t,
        ..Terms::DEFAULT
    }
}

/// A valid config for `(S, P, R)` and the shares, found by 5.9's search in a
/// window of 64 around `x0*` (the minimum sits within a few units of it).
pub fn derived(bps: [u16; 5], dust: u64, p: u64, r: u64) -> Option<ConfigParams> {
    let s = COIN_SUPPLY.checked_sub(dust)?.checked_sub(p)?;
    let (x0, y0) = derive_curve_within(s, p, r, 64).ok()?;
    let c = params(bps, x0, y0, s, p, r);
    validate_config(&c).ok().map(|_| c)
}

pub fn bps_strategy() -> impl Strategy<Value = [u16; 5]> {
    (0u16..=120, 0u16..=120, 0u16..=120, 0u16..=120, 0u16..=60)
        .prop_map(|(a, b, c, d, e)| [a, b, c, d, e])
}

/// Configs passing V1 to V11: the default, random shares on the default curve,
/// and random curves derived by 5.9's search with random shares.
pub fn valid_config() -> impl Strategy<Value = ConfigParams> {
    prop_oneof![
        2 => Just(ConfigParams::DEFAULT),
        3 => bps_strategy().prop_filter_map("V1 to V11", |b| {
            let c = with_bps(b);
            validate_config(&c).ok().map(|_| c)
        }),
        3 => (
            bps_strategy(),
            prop_oneof![Just(0u64), Just(9_100_000u64), 0u64..=MAX_DUST_RAW],
            10_000_000_000_000u64..=450_000_000_000_000,
            0u32..=4000,
        )
            .prop_filter_map("derived curve passing V1 to V11", |(b, dust, p, e)| {
                let r = 10f64.powf(9.0 + e as f64 / 1000.0) as u64;
                derived(b, dust, p, r.clamp(MIN_GRADUATION_LAMPORTS, MAX_GRADUATION_LAMPORTS))
            }),
    ]
}

/// One coin from launch: the math state plus the lamports above rent and the
/// vault balance an on-chain coin would hold, and the payouts made.
#[derive(Clone, Debug)]
pub struct Sim {
    pub t: Terms,
    pub st: State,
    pub lam: u64,
    pub vault: u64,
    pub platform_paid: u128,
    pub founder_paid: u128,
    pub holders_paid: u128,
    pub slot: u64,
}

impl Sim {
    pub fn launch(t: Terms, slot: u64) -> Sim {
        Sim {
            t,
            st: State::at_launch(slot),
            lam: 0,
            vault: t.curve_supply + t.pool_supply,
            platform_paid: 0,
            founder_paid: 0,
            holders_paid: 0,
            slot,
        }
    }

    pub fn buy(&mut self, sol_in: u64) -> Result<BuyQuote, MathError> {
        let q = quote_buy(&self.t, &self.st, sol_in)?;
        self.st = q.new_state;
        self.lam += q.charged;
        self.vault -= q.tokens_out;
        Ok(q)
    }

    pub fn sell(&mut self, tokens_in: u64) -> Result<SellQuote, MathError> {
        let q = quote_sell(&self.t, &self.st, tokens_in)?;
        self.st = q.new_state;
        self.lam -= q.sol_out;
        self.vault += tokens_in;
        Ok(q)
    }

    pub fn buyback(&mut self) -> Result<Option<BuybackQuote>, MathError> {
        let q = quote_buyback(&self.t, &self.st, self.slot)?;
        if let Some(q) = q {
            self.st = q.new_state;
            self.vault -= q.coins;
        }
        Ok(q)
    }

    /// `withdraw_platform_fees` (0), `claim_founder_fees` (1),
    /// `forward_holders_fees` (2): the handler's bookkeeping.
    pub fn pay(&mut self, which: u8) -> u64 {
        let st = &mut self.st;
        let (pending, paid) = match which {
            0 => (&mut st.platform_pending, &mut self.platform_paid),
            1 => (&mut st.founder_pending, &mut self.founder_paid),
            _ => (&mut st.holders_pending, &mut self.holders_paid),
        };
        let a = *pending;
        *pending = 0;
        *paid += a as u128;
        self.lam -= a;
        a
    }

    /// A buyback backlog as checks.py's `state()` makes it (booked as earned).
    pub fn inject_buyback(&mut self, x: u64) {
        self.st.buyback_pending += x;
        self.st.buyback_earned += x as u128;
        self.st.fees_total += x as u128;
        self.lam += x;
    }

    /// Extra set-aside liquidity, as checks.py injects it.
    pub fn inject_liquidity(&mut self, x: u64) {
        self.st.liquidity_pending += x;
        self.st.liquidity_earned += x as u128;
        self.st.fees_total += x as u128;
        self.lam += x;
    }

    /// The invariants the math decides: I1 (phase fields), I4, I6 (positive
    /// reserves), I7, I8, I9 (lamports above rent == liabilities), I10 (vault).
    pub fn check(&self) {
        let (t, st) = (&self.t, &self.st);
        match st.phase {
            Phase::Curve => {
                assert!(st.tokens_sold < t.curve_supply, "I1 s < S");
                assert_eq!(st.curve_sol, curve_value(t, st.tokens_sold).unwrap(), "I4");
                assert!(st.curve_sol < t.graduation_sol, "I4 r <= R - 1");
                assert_eq!((st.pool_sol, st.pool_tokens), (0, 0), "I1 pool empty");
                assert_eq!(
                    self.vault,
                    t.curve_supply - st.tokens_sold + t.pool_supply,
                    "I10"
                );
            }
            Phase::Pool => {
                assert_eq!(st.tokens_sold, t.curve_supply, "I1 s = S");
                assert_eq!(st.curve_sol, t.graduation_sol, "I1 r = R");
                assert!(st.pool_sol >= 1 && st.pool_tokens >= 1, "I6");
                assert_eq!(self.vault, st.pool_tokens, "I10");
            }
        }
        assert_eq!(
            st.platform_pending as u128,
            st.platform_earned - self.platform_paid,
            "I7"
        );
        assert_eq!(
            st.founder_pending as u128,
            st.founder_earned - self.founder_paid,
            "I7"
        );
        assert_eq!(
            st.holders_pending as u128,
            st.holders_earned - self.holders_paid,
            "I7"
        );
        assert_eq!(
            st.buyback_pending as u128,
            st.buyback_earned - st.buyback_spent,
            "I7"
        );
        assert_eq!(
            st.liquidity_pending as u128,
            st.liquidity_earned - st.liquidity_added,
            "I7"
        );
        assert_eq!(
            st.fees_total,
            st.liquidity_earned
                + st.platform_earned
                + st.founder_earned
                + st.holders_earned
                + st.buyback_earned,
            "I8"
        );
        assert_eq!(liabilities(st).unwrap(), self.lam, "I9");
    }
}

/// Reachable curve state holding `r` lamports (one buy of `gross_for(r)` from
/// launch), or the launch state for `r == 0`.
pub fn curve_state(t: Terms, r: u64) -> Sim {
    let mut m = Sim::launch(t, 0);
    if r > 0 {
        m.buy(gross_for(&t, r).unwrap().max(MIN_TRADE_LAMPORTS))
            .unwrap();
    }
    m
}

/// Pool state right after a full-curve buy, with `extra` set-aside liquidity.
pub fn pool_state(t: Terms, extra: u64) -> Sim {
    let mut m = Sim::launch(t, 0);
    let q = m.buy(max_quote_in(&t, &m.st).unwrap()).unwrap();
    assert!(q.graduates);
    m.inject_liquidity(extra);
    m
}

/// Credited shares: none, the founder's, or the founder's and the holders'.
#[derive(Clone, Copy, Debug)]
pub enum Credit {
    None,
    Founder,
    FounderHolders,
}

impl Credit {
    pub fn of(self, st: &State) -> u128 {
        match self {
            Credit::None => 0,
            Credit::Founder => st.founder_pending as u128,
            Credit::FounderHolders => st.founder_pending as u128 + st.holders_pending as u128,
        }
    }
    pub fn bps(self, t: &Terms) -> u128 {
        match self {
            Credit::None => 0,
            Credit::Founder => t.founder_bps as u128,
            Credit::FounderHolders => t.founder_bps as u128 + t.holders_bps as u128,
        }
    }
}

/// Result of one buyback sandwich (checks.py `sandwich`): the attacker buys in
/// `buys.len()` legs, one buyback runs, he sells everything in the sell legs
/// (fractions of what is left, the last leg sells the rest). `None` when the
/// buyback did nothing or a buy leg failed. Returns `(paid, got)` with `got`
/// including his credited shares.
pub fn sandwich(m0: &Sim, buys: &[u64], sells: &[u16], credit: Credit) -> Option<(u128, u128)> {
    let mut m = m0.clone();
    let before = credit.of(&m.st);
    let (mut paid, mut got, mut coins) = (0u128, 0u128, 0u64);
    for &b in buys {
        let q = m.buy(b).ok()?;
        paid += q.charged as u128;
        coins += q.tokens_out;
    }
    m.buyback().unwrap()?;
    let mut left = coins;
    for &frac in sells {
        let tk = ((left as u128 * frac as u128) / 1000) as u64;
        if tk == 0 || tk >= left {
            continue;
        }
        if let Ok(q) = m.sell(tk) {
            got += q.sol_out as u128;
            left -= tk;
        }
    }
    if left > 0 {
        got += m.sell(left).ok()?.sol_out as u128;
    }
    m.check();
    got += credit.of(&m.st) - before;
    Some((paid, got))
}

/// Theorem M (canonical) or the split-leg bound, as `got <= paid * num / den +
/// slack`, with `num/den = (1 + s)^2 (1 - f + i)(1 - f + j + c) + c` where
/// `s = t/(C D)`, `f = t/D`, `c` the credited share, and `i`, `j` the injected
/// liquidity allowances of the two legs (0 on the curve; `2 b_L / D` in the
/// pool, on the buy leg only for the canonical form, on both for split legs).
pub fn sandwich_bound(t: &Terms, credit: Credit, i_bps: u128, j_bps: u128) -> (u128, u128) {
    let cd = BUYBACK_CAP_DIVISOR as u128 * D;
    let tt = t.total_fee_bps as u128;
    let c = credit.bps(t);
    let num = (cd + tt) * (cd + tt) * (D - tt + i_bps) * (D - tt + j_bps + c) + c * cd * cd * D;
    let den = cd * cd * D * D;
    (num, den)
}

/// checks.py `hold`: buy `a`, let up to `k` buyback runs execute with no other
/// trade, sell everything. Returns `(paid, out, spent_by_buybacks, depth_after_buy)`.
pub fn hold(m0: &Sim, a: u64, k: u32) -> Option<(u128, u128, u128, u128)> {
    let mut m = m0.clone();
    let q = m.buy(a).ok()?;
    let x1 = depth(&m.t, &m.st).unwrap() as u128;
    let mut spent = 0u128;
    for _ in 0..k {
        match m.buyback().unwrap() {
            Some(r) => spent += r.spent as u128,
            None => break,
        }
        m.slot += BUYBACK_INTERVAL_SLOTS;
    }
    let out = m.sell(q.tokens_out).ok()?.sol_out as u128;
    m.check();
    Some((q.charged as u128, out, spent, x1))
}

/// checks.py `farm`: the attacker holds the float (bought the whole curve),
/// `extra` set-aside liquidity is waiting, he round-trips `w` up to `n` times
/// (until nothing is pending) and then sells everything; compared with selling
/// everything at once. Credited the founder, holders and buyback shares.
/// Returns the gain in lamports (negative: a loss) and the number of trades
/// the attacker made beyond the baseline's single sell.
pub fn farm(t: Terms, extra: u64, w: u64, n: u32) -> (i128, u32) {
    let credited = |st: &State| {
        st.founder_pending as i128 + st.holders_pending as i128 + st.buyback_pending as i128
    };
    let mut m = Sim::launch(t, 0);
    let held = m.buy(max_quote_in(&t, &m.st).unwrap()).unwrap().tokens_out;
    m.inject_liquidity(extra);
    let mut base = m.clone();
    let c0 = credited(&base.st);
    let out0 = base.sell(held).unwrap().sol_out as i128 + credited(&base.st) - c0;
    let c1 = credited(&m.st);
    let mut cash: i128 = 0;
    let mut trades = 0;
    for _ in 0..n {
        let q = match m.buy(w) {
            Ok(q) => q,
            Err(_) => break,
        };
        cash -= q.charged as i128;
        cash += m.sell(q.tokens_out).unwrap().sol_out as i128;
        trades += 2;
        if m.st.liquidity_pending == 0 {
            break;
        }
    }
    cash += m.sell(held).unwrap().sol_out as i128 + credited(&m.st) - c1;
    m.check();
    (cash - out0, trades)
}
