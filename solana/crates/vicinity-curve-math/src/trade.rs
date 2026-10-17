//! Curve, pool, liquidity drip and buyback (5.3 to 5.8, 7.1).

use crate::arith::{add, add128, add64, div_ceil, div_floor, mul, sub, sub64, to_u64, D};
use crate::constants::{BUYBACK_CAP_DIVISOR, BUYBACK_INTERVAL_SLOTS, MIN_TRADE_LAMPORTS};
use crate::error::MathError;
use crate::fee::{fee_of, fee_split, gross_for_t};
use crate::types::{BuyQuote, BuybackQuote, FeeSplit, Phase, SellQuote, State, Terms};

/// `f(s) = ceil(x0 * s / (y0 - s))` for `s < y0`, rounded UP (5.1, 5.3).
pub(crate) fn f_raw(x0: u64, y0: u64, s: u64) -> Result<u128, MathError> {
    let den = sub(y0 as u128, s as u128, MathError::InvalidTerms)?;
    div_ceil(mul(x0 as u128, s as u128)?, den)
}

/// `tokens_for(q) = floor(q * y0 / (x0 + q))`, rounded DOWN (5.1): the largest
/// `s` with `f(s) <= q` (Lemma C1).
pub(crate) fn tokens_for_raw(x0: u64, y0: u64, q: u128) -> Result<u128, MathError> {
    div_floor(mul(q, y0 as u128)?, add(x0 as u128, q)?)
}

/// The curve value function `f(s)` of 5.3: the lamports the curve holds after
/// `s` raw coins are sold, for `0 <= s <= S` (`InvalidTerms` outside).
pub fn curve_value(terms: &Terms, s: u64) -> Result<u64, MathError> {
    terms.check()?;
    if s > terms.curve_supply {
        return Err(MathError::InvalidTerms);
    }
    to_u64(f_raw(terms.virtual_sol, terms.virtual_tokens, s)?)
}

/// `tokens_for(q)` of 5.1: the largest number of raw coins sold whose curve
/// value is at most `q` lamports (Lemma C1).
pub fn tokens_for(terms: &Terms, q: u64) -> Result<u64, MathError> {
    terms.check()?;
    to_u64(tokens_for_raw(
        terms.virtual_sol,
        terms.virtual_tokens,
        q as u128,
    )?)
}

/// Curve-phase `(s, r)` after the checks the math relies on: `s < S` and
/// `r < R` (I1, I4; so `R - r >= 1`, V5b).
fn curve_position(terms: &Terms, state: &State) -> Result<(u64, u64), MathError> {
    if state.tokens_sold >= terms.curve_supply || state.curve_sol >= terms.graduation_sol {
        return Err(MathError::InvalidState);
    }
    Ok((state.tokens_sold, state.curve_sol))
}

/// Books a trade's split into the buckets and counters (6.2), and in phase Pool
/// moves the liquidity share plus the drip into `pool_sol` (5.7, 5.8):
///
/// ```text
/// Curve: L += liquidity
/// Pool:  drip = min(L, floor(A * b_L / D)); X += liquidity + drip; L -= drip;
///        liquidity_added += liquidity + drip
/// Always: liquidity_earned += liquidity; fees_total += fee; named buckets and
///        their earned counters += their shares
/// ```
///
/// `phase` is the phase the trade was priced in (a graduating buy books in
/// phase Curve, 5.6). Returns the drip.
fn book(st: &mut State, split: &FeeSplit, phase: Phase) -> Result<u64, MathError> {
    st.platform_pending = add64(st.platform_pending, split.platform)?;
    st.founder_pending = add64(st.founder_pending, split.founder)?;
    st.holders_pending = add64(st.holders_pending, split.holders)?;
    st.buyback_pending = add64(st.buyback_pending, split.buyback)?;
    st.platform_earned = add128(st.platform_earned, split.platform)?;
    st.founder_earned = add128(st.founder_earned, split.founder)?;
    st.holders_earned = add128(st.holders_earned, split.holders)?;
    st.buyback_earned = add128(st.buyback_earned, split.buyback)?;
    st.liquidity_earned = add128(st.liquidity_earned, split.liquidity)?;
    st.fees_total = add128(st.fees_total, split.fee)?;
    match phase {
        Phase::Curve => {
            st.liquidity_pending = add64(st.liquidity_pending, split.liquidity)?;
            Ok(0)
        }
        Phase::Pool => {
            // The rounded-down share, never the remainder (5.7, 7.5).
            let drip = st.liquidity_pending.min(split.liquidity_floor);
            let added = add64(split.liquidity, drip)?;
            st.pool_sol = add64(st.pool_sol, added)?;
            st.liquidity_pending = sub64(st.liquidity_pending, drip, MathError::InvalidState)?;
            st.liquidity_added = add128(st.liquidity_added, added)?;
            Ok(drip)
        }
    }
}

/// Quote of `buy(sol_in)` (5.4 on the curve, including the partial fill of the
/// last buy and graduation 5.6; 5.7 in the pool).
///
/// ```text
/// require G >= MIN_TRADE_LAMPORTS
/// n = G - floor(G * t / D)
/// Curve: rem = R - r
///        if n >= rem: s' = S; c = rem; graduates            (maybe partially filled)
///        else:        s' = tokens_for(r + n); c = f(s') - r  (c == n by Lemma C3)
///        charged = (c == n) ? G : floor((c - 1) * D / (D - t)) + 1
///        tokens = s' - s
/// Pool:  c = n; charged = G; tokens = floor(Y * n / (X + n)); X += n; Y -= tokens
/// split(charged); book (drip in the pool); buy_volume += charged; trade_seq += 1
/// graduates: phase = Pool, pool_sol = R, pool_tokens = P (liquidity_pending kept)
/// ```
///
/// A buy that would deliver 0 coins fails with `ZeroOutput` (the program
/// checks `tokens_out >= min_tokens_out` itself).
pub fn quote_buy(terms: &Terms, state: &State, sol_in: u64) -> Result<BuyQuote, MathError> {
    terms.check()?;
    if sol_in < MIN_TRADE_LAMPORTS {
        return Err(MathError::TradeTooSmall);
    }
    let g = sol_in as u128;
    let t = terms.total_fee_bps;
    let n = sub(g, fee_of(g, t)?, MathError::Overflow)?;
    let mut st = *state;
    let priced_in = state.phase;
    let (charged, c, tokens, graduates) = match state.phase {
        Phase::Curve => {
            let (s, r) = curve_position(terms, state)?;
            let (x0, y0) = (terms.virtual_sol, terms.virtual_tokens);
            let rem = sub(
                terms.graduation_sol as u128,
                r as u128,
                MathError::InvalidState,
            )?;
            let (s2, c, graduates) = if n >= rem {
                (terms.curve_supply as u128, rem, true)
            } else {
                let s2 = tokens_for_raw(x0, y0, add(r as u128, n)?)?;
                let f2 = f_raw(x0, y0, to_u64(s2)?)?;
                (s2, sub(f2, r as u128, MathError::InvalidState)?, false)
            };
            if c == 0 || c > n {
                return Err(MathError::InvalidState);
            }
            let charged = if c == n { g } else { gross_for_t(c, t)? };
            let tokens = sub(s2, s as u128, MathError::InvalidState)?;
            st.tokens_sold = to_u64(s2)?;
            st.curve_sol = to_u64(add(r as u128, c)?)?;
            (charged, c, tokens, graduates)
        }
        Phase::Pool => {
            let (x, y) = (state.pool_sol as u128, state.pool_tokens as u128);
            let tokens = div_floor(mul(y, n)?, add(x, n)?)?;
            st.pool_sol = to_u64(add(x, n)?)?;
            st.pool_tokens = to_u64(sub(y, tokens, MathError::InvalidState)?)?;
            (g, n, tokens, false)
        }
    };
    if tokens == 0 {
        return Err(MathError::ZeroOutput);
    }
    if charged > g {
        return Err(MathError::InvalidState);
    }
    let charged = to_u64(charged)?;
    let split = fee_split(terms, charged)?;
    // Lemma G: the fee of the charge is exactly charged - c.
    if sub(charged as u128, split.fee as u128, MathError::InvalidState)? != c {
        return Err(MathError::InvalidState);
    }
    let drip = book(&mut st, &split, priced_in)?;
    st.buy_volume = add128(st.buy_volume, charged)?;
    st.trade_seq = add64(st.trade_seq, 1)?;
    if graduates {
        st.phase = Phase::Pool;
        st.pool_sol = terms.graduation_sol;
        st.pool_tokens = terms.pool_supply;
    }
    // A buy is the only operation that raises the liabilities. Refuse one after
    // which they would not fit u64: `pay_out` sums them for every later debit,
    // and an unrepresentable sum would block every sell (unreachable with the
    // real SOL supply; NOTES).
    liabilities(&st)?;
    Ok(BuyQuote {
        charged,
        net: to_u64(c)?,
        tokens_out: to_u64(tokens)?,
        split,
        drip,
        partial: charged < sol_in,
        graduates,
        new_state: st,
    })
}

/// Quote of `sell(tokens_in)` (5.5 on the curve, 5.7 in the pool).
///
/// ```text
/// require tokens_in >= 1
/// Curve: require tokens_in <= s (SellExceedsCurve); s' = s - tokens_in;
///        gross = r - f(s'); s := s'; r := f(s')
/// Pool:  gross = floor(X * tokens_in / (Y + tokens_in)); X -= gross; Y += tokens_in
/// split(gross); out = gross - fee; require out >= 1 (ZeroOutput)
/// book (drip in the pool); sell_volume += gross; trade_seq += 1
/// ```
pub fn quote_sell(terms: &Terms, state: &State, tokens_in: u64) -> Result<SellQuote, MathError> {
    terms.check()?;
    if tokens_in == 0 {
        return Err(MathError::ZeroAmount);
    }
    let mut st = *state;
    let gross = match state.phase {
        Phase::Curve => {
            let (s, r) = curve_position(terms, state)?;
            if tokens_in > s {
                return Err(MathError::SellExceedsCurve);
            }
            let s2 = s - tokens_in;
            let f2 = f_raw(terms.virtual_sol, terms.virtual_tokens, s2)?;
            let gross = sub(r as u128, f2, MathError::InvalidState)?;
            st.tokens_sold = s2;
            st.curve_sol = to_u64(f2)?;
            gross
        }
        Phase::Pool => {
            let (x, y, a) = (
                state.pool_sol as u128,
                state.pool_tokens as u128,
                tokens_in as u128,
            );
            let gross = div_floor(mul(x, a)?, add(y, a)?)?;
            st.pool_sol = to_u64(sub(x, gross, MathError::InvalidState)?)?;
            st.pool_tokens = to_u64(add(y, a)?)?;
            gross
        }
    };
    let gross = to_u64(gross)?;
    let split = fee_split(terms, gross)?;
    let sol_out = sub64(gross, split.fee, MathError::InvalidState)?;
    if sol_out == 0 {
        return Err(MathError::ZeroOutput);
    }
    let drip = book(&mut st, &split, state.phase)?;
    st.sell_volume = add128(st.sell_volume, gross)?;
    st.trade_seq = add64(st.trade_seq, 1)?;
    Ok(SellQuote {
        gross,
        sol_out,
        split,
        drip,
        new_state: st,
    })
}

/// The market's SOL depth used for buyback caps (1.4, 7.1): `x0 + curve_sol`
/// on the curve, `pool_sol` in the pool.
pub fn depth(terms: &Terms, state: &State) -> Result<u64, MathError> {
    match state.phase {
        Phase::Curve => add64(terms.virtual_sol, state.curve_sol),
        Phase::Pool => Ok(state.pool_sol),
    }
}

/// The most a buyback run may spend: `floor(depth * t / (C * D))`, rounded down
/// (7.1, 5.11): 0.1% of depth at `t = 250`.
pub fn buyback_cap(terms: &Terms, state: &State) -> Result<u64, MathError> {
    terms.check()?;
    let dep = depth(terms, state)? as u128;
    let den = mul(BUYBACK_CAP_DIVISOR as u128, D)?;
    to_u64(div_floor(mul(dep, terms.total_fee_bps as u128)?, den)?)
}

/// Quote of `buyback_burn()` at `slot` (7.1). `Ok(None)` is the no-op of 4.0:
/// the bucket is empty, the interval since `last_buyback_slot` has not passed,
/// the cap is 0, or the run would buy 0 coins or spend 0 lamports.
///
/// ```text
/// cap = floor(depth * t / (C * D)); b = min(buyback_pending, cap)
/// Curve: s' = min(tokens_for(r + b), S - 1)       (never graduates)
///        spent = f(s') - r; coins = s' - s; s := s'; r := f(s')
/// Pool:  coins = floor(Y * b / (X + b)); spent = b; X += b; Y -= coins
/// buyback_pending -= spent; buyback_spent += spent; tokens_burned += coins;
/// buyback_count += 1; last_buyback_slot = slot
/// ```
///
/// No fee is charged on a buyback (O7).
pub fn quote_buyback(
    terms: &Terms,
    state: &State,
    slot: u64,
) -> Result<Option<BuybackQuote>, MathError> {
    terms.check()?;
    if state.buyback_pending == 0 {
        return Ok(None);
    }
    if slot < add64(state.last_buyback_slot, BUYBACK_INTERVAL_SLOTS)? {
        return Ok(None);
    }
    let cap = buyback_cap(terms, state)?;
    let b = state.buyback_pending.min(cap);
    if b == 0 {
        return Ok(None);
    }
    let mut st = *state;
    let (spent, coins) = match state.phase {
        Phase::Curve => {
            let (s, r) = curve_position(terms, state)?;
            let (x0, y0) = (terms.virtual_sol, terms.virtual_tokens);
            let top = tokens_for_raw(x0, y0, add(r as u128, b as u128)?)?;
            let s2 = top.min(terms.curve_supply as u128 - 1);
            let f2 = f_raw(x0, y0, to_u64(s2)?)?;
            let spent = sub(f2, r as u128, MathError::InvalidState)?;
            let coins = sub(s2, s as u128, MathError::InvalidState)?;
            if spent == 0 || coins == 0 {
                return Ok(None);
            }
            st.tokens_sold = to_u64(s2)?;
            st.curve_sol = to_u64(f2)?;
            (spent, coins)
        }
        Phase::Pool => {
            let (x, y, b) = (state.pool_sol as u128, state.pool_tokens as u128, b as u128);
            let coins = div_floor(mul(y, b)?, add(x, b)?)?;
            if coins == 0 {
                return Ok(None);
            }
            st.pool_sol = to_u64(add(x, b)?)?;
            st.pool_tokens = to_u64(sub(y, coins, MathError::InvalidState)?)?;
            (b, coins)
        }
    };
    // spent <= b <= buyback_pending (Lemma C1 on the curve, spent = b in the pool).
    if spent > b as u128 {
        return Err(MathError::InvalidState);
    }
    let spent = to_u64(spent)?;
    let coins = to_u64(coins)?;
    st.buyback_pending = sub64(st.buyback_pending, spent, MathError::InvalidState)?;
    st.buyback_spent = add128(st.buyback_spent, spent)?;
    st.tokens_burned = add64(st.tokens_burned, coins)?;
    st.buyback_count = add64(st.buyback_count, 1)?;
    st.last_buyback_slot = slot;
    Ok(Some(BuybackQuote {
        spent,
        coins,
        cap,
        new_state: st,
    }))
}

/// The `sol_in` that completes the curve exactly (5.4):
/// `max(MIN_TRADE_LAMPORTS, floor((rem - 1) * D / (D - t)) + 1)` with
/// `rem = R - curve_sol`. `WrongPhase` in the pool.
pub fn max_quote_in(terms: &Terms, state: &State) -> Result<u64, MathError> {
    terms.check()?;
    if state.phase != Phase::Curve {
        return Err(MathError::WrongPhase);
    }
    let (_, r) = curve_position(terms, state)?;
    let rem = (terms.graduation_sol - r) as u128;
    let g = to_u64(gross_for_t(rem, terms.total_fee_bps)?)?;
    Ok(g.max(MIN_TRADE_LAMPORTS))
}

/// Virtual reserves `(virtual_sol, virtual_tokens)` that quotes and the spot
/// price use (5.1): `(x0 + curve_sol, y0 - tokens_sold)` on the curve,
/// `(pool_sol, pool_tokens)` in the pool. Spot price = first / second, in
/// lamports per raw unit.
///
/// 5.16 writes `spot_price(state)`; the curve's virtual reserves need `x0` and
/// `y0`, so the function takes the terms as well.
pub fn spot_price(terms: &Terms, state: &State) -> Result<(u64, u64), MathError> {
    match state.phase {
        Phase::Curve => Ok((
            add64(terms.virtual_sol, state.curve_sol)?,
            sub64(
                terms.virtual_tokens,
                state.tokens_sold,
                MathError::InvalidState,
            )?,
        )),
        Phase::Pool => Ok((state.pool_sol, state.pool_tokens)),
    }
}

/// Liabilities of a coin (1.4, 6.5): the reserve of its phase (`curve_sol` or
/// `pool_sol`) plus the five buckets. `pay_out` requires the account to keep at
/// least the rent part plus this figure after every debit.
pub fn liabilities(state: &State) -> Result<u64, MathError> {
    let reserve = match state.phase {
        Phase::Curve => state.curve_sol,
        Phase::Pool => state.pool_sol,
    };
    let mut sum = reserve;
    for v in [
        state.liquidity_pending,
        state.platform_pending,
        state.founder_pending,
        state.holders_pending,
        state.buyback_pending,
    ] {
        sum = add64(sum, v)?;
    }
    Ok(sum)
}
