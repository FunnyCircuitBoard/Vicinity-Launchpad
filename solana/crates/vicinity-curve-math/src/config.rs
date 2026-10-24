//! `validate_config` (5.13) and `derive_curve` (5.9).

use crate::arith::{div_ceil, div_floor, D};
use crate::constants::{
    BUYBACK_CAP_DIVISOR, BUYBACK_MIN_HORIZON_RUNS, BUYBACK_MIN_HORIZON_RUNS_FOUNDER, COIN_SUPPLY,
    CONTINUITY_PPB, DERIVE_CURVE_RADIUS, MAX_DUST_RAW, MAX_FOUNDER_FEE_BPS,
    MAX_GRADUATION_LAMPORTS, MAX_LAUNCH_FEE_LAMPORTS, MAX_PLATFORM_FEE_BPS, MAX_TOTAL_FEE_BPS,
    MAX_VIRTUAL, MEV_MAX_PERCENT, MIN_GRADUATION_LAMPORTS, MIN_TOTAL_FEE_BPS, PPB,
};
use crate::error::{ConfigError, MathError};
use crate::trade::f_raw;
use crate::types::ConfigParams;

/// Checked `u128` arithmetic for one rule: any overflow fails that rule (no
/// rule can overflow once the rules before it passed, 5.12; checked anyway).
struct Rule(ConfigError);

impl Rule {
    fn mul(&self, a: u128, b: u128) -> Result<u128, ConfigError> {
        a.checked_mul(b).ok_or(self.0)
    }
    fn add(&self, a: u128, b: u128) -> Result<u128, ConfigError> {
        a.checked_add(b).ok_or(self.0)
    }
    fn sub(&self, a: u128, b: u128) -> Result<u128, ConfigError> {
        a.checked_sub(b).ok_or(self.0)
    }
    fn check(&self, ok: bool) -> Result<(), ConfigError> {
        if ok {
            Ok(())
        } else {
            Err(self.0)
        }
    }
}

/// `C * D` = 250,000.
const CD: u128 = BUYBACK_CAP_DIVISOR as u128 * D;

/// V8's two sides for the five shares `(b_L, b_P, b_F, b_H, b_B)`, with
/// `t` their sum and `m = max(b_F, b_H)`:
///
/// ```text
/// left  = 100 * ((C*D + t)^2 * (D - t + 2*b_L + m) * (D - t + 2*b_L) + m * D * (C*D)^2)
/// right = 99 * (C*D)^2 * D^2
/// ```
///
/// V8 requires `left <= right` when `b_B > 0`. Default config #0: left
/// 613,813,296,968,750,000,000, right 618,750,000,000,000,000,000 (5.13). The
/// shares must already pass V1 (`t <= 250`).
pub fn v8_sides(p: &ConfigParams) -> Result<(u128, u128), ConfigError> {
    let r = Rule(ConfigError::BuybackMev);
    let t = p.total_fee_bps() as u128;
    let l = p.liquidity_bps as u128;
    let m = p.founder_bps.max(p.holders_bps) as u128;
    let base = r.sub(D, t)?; // D - t
    let a = r.add(base, r.mul(2, l)?)?; // D - t + 2 b_L
    let cdt = r.add(CD, t)?;
    let mut left = r.mul(cdt, cdt)?;
    left = r.mul(left, r.add(a, m)?)?;
    left = r.mul(left, a)?;
    left = r.add(left, r.mul(r.mul(m, D)?, r.mul(CD, CD)?)?)?;
    left = r.mul(left, 100)?;
    let right = r.mul(r.mul(MEV_MAX_PERCENT as u128, r.mul(CD, CD)?)?, D * D)?;
    Ok((left, right))
}

/// `((left1, right1), (left2, right2))` of [`v11_sides`].
pub type V11Sides = ((u128, u128), (u128, u128));

/// V11's two inequalities as `((left1, right1), (left2, right2))`:
///
/// ```text
/// C*(D - t)*(D - t + 2*b_L)       <= D*(C*D - 2*(K - 1)*t)        K = 20 (any trader)
/// C*(D - t + 2*b_L)*(D - t + m)   <= (D - m)*(C*D - 2*(K_F - 1)*t) K_F = 15 (credited)
/// ```
///
/// (`2*(K - 1) = 38` and `2*(K_F - 1) = 28` in 5.13.) Default config #0:
/// 2,400,937,500 <= 2,405,000,000 and 2,413,250,000 <= 2,417,850,000. The
/// shares must already pass V1 and V2.
pub fn v11_sides(p: &ConfigParams) -> Result<V11Sides, ConfigError> {
    let r = Rule(ConfigError::BuybackHorizon);
    let c = BUYBACK_CAP_DIVISOR as u128;
    let t = p.total_fee_bps() as u128;
    let l = p.liquidity_bps as u128;
    let m = p.founder_bps.max(p.holders_bps) as u128;
    let base = r.sub(D, t)?;
    let a = r.add(base, r.mul(2, l)?)?;
    let k = 2 * (BUYBACK_MIN_HORIZON_RUNS as u128 - 1);
    let kf = 2 * (BUYBACK_MIN_HORIZON_RUNS_FOUNDER as u128 - 1);
    let left1 = r.mul(r.mul(c, base)?, a)?;
    let right1 = r.mul(D, r.sub(CD, r.mul(k, t)?)?)?;
    let left2 = r.mul(r.mul(c, a)?, r.add(base, m)?)?;
    let right2 = r.mul(r.sub(D, m)?, r.sub(CD, r.mul(kf, t)?)?)?;
    Ok(((left1, right1), (left2, right2)))
}

/// `validate_config` (5.13): rules V1 to V11 in table order, the first failing
/// rule's error. Pure; the program runs it in `add_launch_config` and again in
/// every `launch`.
///
/// | rule | condition |
/// |---|---|
/// | V1 | `1 <= t <= 250` (summed in `u32`) |
/// | V2 | `b_P <= 120`, `b_F <= 100`, and V2b `b_F + b_H + MIN_TOTAL_FEE_BPS <= t` |
/// | V3 | `S >= 1`, `P >= 1`, `S + P <= 10^15`, `10^15 - S - P <= MAX_DUST_RAW` |
/// | V4 | `1 <= x0 <= 2^60`, `S < y0 <= 2^60`, `x0 * t >= C*D`, `R * P * t >= C*D * 10^15` |
/// | V5 | `10^9 <= R <= 10^13`, `f(S) == R`, V5b `f(S - 1) <= R - 1` |
/// | V6 | `x0 * y0 <= (y0 - S)^2` |
/// | V7 | `0 <= (x0 + R)*P - R*(y0 - S) <= floor((x0 + R)*P * CONTINUITY_PPB / 10^9)` |
/// | V8 | if `b_B > 0`: [`v8_sides`] left `<=` right |
/// | V9 | `launch_fee_lamports <= 500,000,000` |
/// | V10 | `b_L == 0` or `b_L < b_P` |
/// | V11 | if `b_B > 0`: both inequalities of [`v11_sides`] |
pub fn validate_config(p: &ConfigParams) -> Result<(), ConfigError> {
    let t = p.total_fee_bps() as u128;

    // V1
    let r = Rule(ConfigError::FeeTotal);
    r.check(t >= MIN_TOTAL_FEE_BPS as u128 && t <= MAX_TOTAL_FEE_BPS as u128)?;

    // V2 (and V2b: a trader credited back the founder's share, the holders'
    // share or both, as a founder who also holds the float is, still pays at
    // least MIN_TOTAL_FEE_BPS net per leg, with or without a buyback share;
    // reviews ECON-1 and R3-DIFF-1). Equivalent to b_L + b_P + b_B >= 1.
    let r = Rule(ConfigError::FeeShareCap);
    r.check(p.platform_bps <= MAX_PLATFORM_FEE_BPS && p.founder_bps <= MAX_FOUNDER_FEE_BPS)?;
    let credited = r.add(p.founder_bps as u128, p.holders_bps as u128)?;
    r.check(r.add(credited, MIN_TOTAL_FEE_BPS as u128)? <= t)?;

    // V3
    let r = Rule(ConfigError::Supply);
    let (s, pp) = (p.curve_supply as u128, p.pool_supply as u128);
    let supply = COIN_SUPPLY as u128;
    r.check(s >= 1 && pp >= 1)?;
    let sold_and_pool = r.add(s, pp)?;
    r.check(sold_and_pool <= supply && supply - sold_and_pool <= MAX_DUST_RAW as u128)?;

    // V4
    let r = Rule(ConfigError::CurveBounds);
    let (x0, y0, big_r) = (
        p.virtual_sol as u128,
        p.virtual_tokens as u128,
        p.graduation_sol as u128,
    );
    let max_v = MAX_VIRTUAL as u128;
    r.check(x0 >= 1 && x0 <= max_v && s < y0 && y0 <= max_v)?;
    r.check(r.mul(x0, t)? >= CD)?;
    r.check(r.mul(r.mul(big_r, pp)?, t)? >= r.mul(CD, supply)?)?;

    // V5 (and V5b)
    let r = Rule(ConfigError::Graduation);
    r.check(big_r >= MIN_GRADUATION_LAMPORTS as u128 && big_r <= MAX_GRADUATION_LAMPORTS as u128)?;
    let f_s = f_raw(p.virtual_sol, p.virtual_tokens, p.curve_supply).map_err(|_| r.0)?;
    r.check(f_s == big_r)?;
    let f_s1 = f_raw(p.virtual_sol, p.virtual_tokens, p.curve_supply - 1).map_err(|_| r.0)?;
    r.check(f_s1 < big_r)?;

    // V6
    let r = Rule(ConfigError::Absorption);
    let d = y0 - s; // y0 > S by V4
    r.check(r.mul(x0, y0)? <= r.mul(d, d)?)?;

    // V7
    let r = Rule(ConfigError::Continuity);
    let opening = r.mul(r.add(x0, big_r)?, pp)?; // (x0 + R) * P
    let curve_end = r.mul(big_r, d)?; // R * d
    r.check(curve_end <= opening)?;
    let tolerance = r.mul(opening, CONTINUITY_PPB as u128)? / PPB as u128;
    r.check(opening - curve_end <= tolerance)?;

    // V8
    if p.buyback_bps > 0 {
        let (left, right) = v8_sides(p)?;
        Rule(ConfigError::BuybackMev).check(left <= right)?;
    }

    // V9
    Rule(ConfigError::LaunchFee).check(p.launch_fee_lamports <= MAX_LAUNCH_FEE_LAMPORTS)?;

    // V10
    Rule(ConfigError::DripFarmable)
        .check(p.liquidity_bps == 0 || p.liquidity_bps < p.platform_bps)?;

    // V11
    if p.buyback_bps > 0 {
        let ((l1, r1), (l2, r2)) = v11_sides(p)?;
        Rule(ConfigError::BuybackHorizon).check(l1 <= r1 && l2 <= r2)?;
    }
    Ok(())
}

/// [`derive_curve_within`] with 5.9's radius of 20,000 around `x0*`.
pub fn derive_curve(
    curve_supply: u64,
    pool_supply: u64,
    graduation_sol: u64,
) -> Result<(u64, u64), MathError> {
    derive_curve_within(
        curve_supply,
        pool_supply,
        graduation_sol,
        DERIVE_CURVE_RADIUS,
    )
}

/// The integer search of 5.9 (off-chain helper; the program never calls it):
/// for every `x0` within `radius` of the continuous `x0* = R*P/(S - P)`, the
/// largest `d = y0 - S` with exact completion
/// (`ceil(x0*S/R) <= d <= floor((x0*S - 1)/(R - 1))`), one-sided continuity
/// (`R*d <= (x0 + R)*P`), V5b, V6, `x0, y0 <= 2^60` and V7's tolerance; returns
/// the `(x0, y0)` with the smallest continuity gap `(x0 + R)*P - R*d` (the
/// smallest `x0` on a tie). Default `S`, `P`, `R` give design A's
/// `(30,000,853,639, 1,073,025,598,486,615)`.
///
/// `InvalidTerms` when `S <= P`, `P == 0`, `R < 2` or no `x0` in the window is
/// admissible.
pub fn derive_curve_within(
    curve_supply: u64,
    pool_supply: u64,
    graduation_sol: u64,
    radius: u64,
) -> Result<(u64, u64), MathError> {
    let (s, p, r) = (
        curve_supply as u128,
        pool_supply as u128,
        graduation_sol as u128,
    );
    if p == 0 || s <= p || r < 2 {
        return Err(MathError::InvalidTerms);
    }
    let (num, den) = (r * p, s - p);
    let (q, rm) = (num / den, num % den);
    let lo = if rm == 0 {
        q.saturating_sub(radius as u128)
    } else {
        q.saturating_sub(radius as u128).saturating_add(1)
    }
    .max(1);
    let hi = q.saturating_add(radius as u128);
    let max_v = MAX_VIRTUAL as u128;
    let mut best: Option<(u128, u128, u128)> = None; // (gap, x0, y0)
    let mut x0 = lo;
    while x0 <= hi && x0 <= max_v {
        if let Some(found) = candidate(x0, s, p, r)? {
            if best.is_none_or(|b| found.0 < b.0) {
                best = Some(found);
            }
        }
        x0 += 1;
    }
    match best {
        Some((_, x0, y0)) => Ok((
            u64::try_from(x0).map_err(|_| MathError::Overflow)?,
            u64::try_from(y0).map_err(|_| MathError::Overflow)?,
        )),
        None => Err(MathError::InvalidTerms),
    }
}

/// `(gap, x0, y0)` for one `x0` of the search, or `None` if inadmissible.
fn candidate(x0: u128, s: u128, p: u128, r: u128) -> Result<Option<(u128, u128, u128)>, MathError> {
    let ov = MathError::Overflow;
    let a = x0.checked_mul(s).ok_or(ov)?;
    let opening = x0.checked_add(r).ok_or(ov)?.checked_mul(p).ok_or(ov)?;
    let d_hi = div_floor(a - 1, r - 1)?.min(opening / r);
    if d_hi < div_ceil(a, r)? {
        return Ok(None);
    }
    let d = d_hi;
    let y0 = s.checked_add(d).ok_or(ov)?;
    // V5b: f(S - 1) = ceil(x0 * (S - 1) / (d + 1)) <= R - 1
    if div_ceil(x0.checked_mul(s - 1).ok_or(ov)?, d + 1)? > r - 1 {
        return Ok(None);
    }
    // V6
    if x0.checked_mul(y0).ok_or(ov)? > d.checked_mul(d).ok_or(ov)? {
        return Ok(None);
    }
    if y0 > MAX_VIRTUAL as u128 {
        return Ok(None);
    }
    let gap = opening - r * d; // >= 0: d <= opening / r
    if gap > opening * CONTINUITY_PPB as u128 / PPB as u128 {
        return Ok(None);
    }
    Ok(Some((gap, x0, y0)))
}
