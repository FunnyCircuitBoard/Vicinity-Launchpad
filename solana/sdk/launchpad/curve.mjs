// Exact BigInt mirror of Meteora DBC 0.2.1 swap math (programs/dynamic-bonding-curve/src:
// curve.rs, state/virtual_pool.rs get_swap_result_*, state/config.rs fees).
//
// Our program never prices anything: the curve, buys, sells and graduation run inside DBC.
// This module exists so the website can quote trades and set slippage bounds, and so the
// tests can check DBC's results to the raw unit and assert the curve invariants
// (tests-launchpad/04-trading.test.mjs). It only supports what Vicinity configs allow:
// a flat fee (no fee scheduler decay, no dynamic fee) collected in the quote token.

export const FEE_DENOMINATOR = 1_000_000_000n;
export const PROTOCOL_FEE_PERCENT = 20n; // Meteora's cut of every trading fee
export const HOST_FEE_PERCENT = 20n; // referral share of Meteora's cut
export const RESOLUTION = 64n;
const Q128 = 1n << 128n;
const U64_MAX = (1n << 64n) - 1n;

export const SwapMode = Object.freeze({ ExactIn: 0, PartialFill: 1, ExactOut: 2 });
export const Direction = Object.freeze({ Buy: 'QuoteToBase', Sell: 'BaseToQuote' });

export class CurveError extends Error {
  constructor(code, msg) { super(`${code}: ${msg}`); this.code = code; }
}

const divCeil = (a, b) => (a + b - 1n) / b;
export function mulDiv(a, b, d, roundUp) {
  if (d <= 0n) throw new CurveError('MathOverflow', 'division by zero');
  const p = a * b;
  return roundUp ? divCeil(p, d) : p / d;
}
function toU64(x) {
  if (x < 0n || x > U64_MAX) throw new CurveError('MathOverflow', `value ${x} outside u64`);
  return x;
}

// Δbase = L·(√P_upper − √P_lower)/(√P_upper·√P_lower)
export function deltaBase(lower, upper, liquidity, roundUp) {
  return mulDiv(liquidity, upper - lower, lower * upper, roundUp);
}
// Δquote = L·(√P_upper − √P_lower)/2^128
export function deltaQuote(lower, upper, liquidity, roundUp) {
  const prod = liquidity * (upper - lower);
  return roundUp ? divCeil(prod, Q128) : prod >> (RESOLUTION * 2n);
}
const nextFromQuoteIn = (s, l, amt) => s + (amt << (RESOLUTION * 2n)) / l; // rounds down
const nextFromBaseIn = (s, l, amt) => (amt === 0n ? s : mulDiv(l, s, l + amt * s, true));
function nextFromQuoteOut(s, l, amt) {
  const r = s - divCeil(amt << 128n, l);
  if (r < 0n) throw new CurveError('MathOverflow', 'sqrt price below zero');
  return r;
}
function nextFromBaseOut(s, l, amt) {
  if (amt === 0n) return s;
  const den = l - amt * s;
  if (den <= 0n) throw new CurveError('MathOverflow', 'base out exceeds liquidity');
  return mulDiv(l, s, den, true);
}

// ---- fees (config.rs PoolFeesConfig) ----
export function splitFees(fee, hasReferral) {
  let protocol = (fee * PROTOCOL_FEE_PERCENT) / 100n;
  const trading = fee - protocol;
  const referral = hasReferral ? (protocol * HOST_FEE_PERCENT) / 100n : 0n;
  protocol -= referral;
  return { trading, protocol, referral };
}
export function feeOnAmount(numerator, amount, hasReferral) {
  const fee = mulDiv(amount, numerator, FEE_DENOMINATOR, true);
  return { amount: amount - fee, fee, ...splitFees(fee, hasReferral) };
}
export function includedFeeAmount(numerator, excluded) {
  const included = mulDiv(excluded, FEE_DENOMINATOR, FEE_DENOMINATOR - numerator, true);
  return { included, fee: included - excluded };
}
export function splitPartnerCreator(trading, creatorPercent) {
  const creator = creatorPercent === 0n ? 0n : (trading * creatorPercent) / 100n;
  return { creator, partner: trading - creator };
}

/** DBC's partner-and-creator share of the completion surplus (state/virtual_pool.rs). */
export const PARTNER_AND_CREATOR_SURPLUS_PERCENT = 80n;
/**
 * How DBC splits the completion surplus (quote reserve above the raise target,
 * rounding dust the curve collected): 20% Meteora, the rest split between the
 * partner (dev wallet) and the creator (the Coin PDA, i.e. the city) like the
 * trading fee. Each side withdraws its share once. Mirrors DBC 0.2.1
 * get_total_surplus / get_creator_surplus / get_partner_surplus / get_protocol_surplus.
 */
export function surplusShares(quoteReserve, migrationQuoteThreshold, creatorPercent) {
  const total = quoteReserve > migrationQuoteThreshold ? quoteReserve - migrationQuoteThreshold : 0n;
  const pc = (total * PARTNER_AND_CREATOR_SURPLUS_PERCENT) / 100n;
  const creator = (pc * BigInt(creatorPercent)) / 100n;
  return { total, creator, partner: pc - creator, protocol: total - pc };
}

// ---- curve walks (virtual_pool.rs) ----
function segments(config) {
  return config.curve.filter((p) => p.sqrtPrice !== 0n && p.liquidity !== 0n);
}

function quoteToBaseFromIn(config, sqrtPrice, amountIn, stop) {
  let out = 0n, cur = sqrtPrice, left = amountIn;
  for (const seg of segments(config)) {
    const ref = stop < seg.sqrtPrice ? stop : seg.sqrtPrice;
    if (ref > cur) {
      const maxIn = deltaQuote(cur, ref, seg.liquidity, true);
      if (left < maxIn) {
        const next = nextFromQuoteIn(cur, seg.liquidity, left);
        out += toU64(deltaBase(cur, next, seg.liquidity, false));
        cur = next; left = 0n;
        break;
      }
      out += toU64(deltaBase(cur, ref, seg.liquidity, false));
      cur = ref; left -= maxIn;
      if (ref === stop) break;
    }
  }
  return { out: toU64(out), next: cur, left };
}

function baseToQuoteFromIn(config, sqrtPrice, amountIn) {
  const c = config.curve;
  let out = 0n, cur = sqrtPrice, left = amountIn;
  for (let i = c.length - 2; i >= 0; i--) {
    if (c[i].sqrtPrice === 0n || c[i].liquidity === 0n) continue;
    if (c[i].sqrtPrice < cur) {
      const l = c[i + 1].liquidity;
      const maxIn = deltaBase(c[i].sqrtPrice, cur, l, true);
      if (left < maxIn) {
        const next = nextFromBaseIn(cur, l, left);
        out += toU64(deltaQuote(next, cur, l, false));
        cur = next; left = 0n;
        break;
      }
      out += toU64(deltaQuote(c[i].sqrtPrice, cur, l, false));
      cur = c[i].sqrtPrice; left -= maxIn;
    }
  }
  if (left !== 0n) {
    let next = nextFromBaseIn(cur, c[0].liquidity, left);
    if (next < config.sqrtStartPrice) {
      next = config.sqrtStartPrice;
      left -= toU64(deltaBase(next, cur, c[0].liquidity, true));
    } else left = 0n;
    out += toU64(deltaQuote(next, cur, c[0].liquidity, false));
    cur = next;
  }
  return { out: toU64(out), next: cur, left };
}

function quoteToBaseFromOut(config, sqrtPrice, amountOut) {
  let input = 0n, cur = sqrtPrice, left = amountOut;
  for (const seg of segments(config)) {
    if (seg.sqrtPrice > cur) {
      const maxOut = deltaBase(cur, seg.sqrtPrice, seg.liquidity, false);
      if (left < maxOut) {
        const next = nextFromBaseOut(cur, seg.liquidity, left);
        input += toU64(deltaQuote(cur, next, seg.liquidity, true));
        cur = next; left = 0n;
        break;
      }
      input += toU64(deltaQuote(cur, seg.sqrtPrice, seg.liquidity, true));
      cur = seg.sqrtPrice; left -= maxOut;
    }
  }
  if (left !== 0n) throw new CurveError('AmountLeftIsNotZero', 'not enough coins left on the curve');
  return { input: toU64(input), next: cur };
}

function baseToQuoteFromOut(config, sqrtPrice, amountOut) {
  const c = config.curve;
  let input = 0n, cur = sqrtPrice, left = amountOut;
  for (let i = c.length - 2; i >= 0; i--) {
    if (c[i].sqrtPrice === 0n || c[i].liquidity === 0n) continue;
    if (c[i].sqrtPrice < cur) {
      const l = c[i + 1].liquidity;
      const maxOut = deltaQuote(c[i].sqrtPrice, cur, l, false);
      if (left < maxOut) {
        const next = nextFromQuoteOut(cur, l, left);
        input += toU64(deltaBase(next, cur, l, true));
        cur = next; left = 0n;
        break;
      }
      input += toU64(deltaBase(c[i].sqrtPrice, cur, l, true));
      cur = c[i].sqrtPrice; left -= maxOut;
    }
  }
  if (left !== 0n) {
    const maxOut = deltaQuote(config.sqrtStartPrice, cur, c[0].liquidity, false);
    if (left > maxOut) throw new CurveError('InsufficientLiquidity', 'not enough quote on the curve');
    const next = nextFromQuoteOut(cur, c[0].liquidity, left);
    if (next < config.sqrtStartPrice) throw new CurveError('InsufficientLiquidity', 'below start price');
    input += toU64(deltaBase(next, cur, c[0].liquidity, true));
    cur = next;
  }
  return { input: toU64(input), next: cur };
}

/**
 * Quote one DBC swap2 exactly as DBC 0.2.1 computes it.
 * pool: { sqrtPrice, quoteReserve }   config: decoded PoolConfig (BigInt fields, see decodeConfig)
 * Returns the amounts DBC moves and the fee split it books.
 */
export function quoteSwap(pool, config, { direction, mode, amount0, hasReferral = false }) {
  const numerator = config.feeNumerator;
  const creatorPct = config.creatorTradingFeePercentage;
  const amount = BigInt(amount0);
  if (amount <= 0n) throw new CurveError('AmountIsZero', 'amount must be positive');
  if (pool.quoteReserve >= config.migrationQuoteThreshold) throw new CurveError('PoolIsCompleted', 'curve is complete');
  const buy = direction === Direction.Buy;
  let r;
  if (mode === SwapMode.ExactOut) {
    if (buy) {
      const { input, next } = quoteToBaseFromOut(config, pool.sqrtPrice, amount);
      if (next > config.migrationSqrtPrice) throw new CurveError('InsufficientLiquidity', 'past the graduation price');
      const { included, fee } = includedFeeAmount(numerator, input);
      r = { includedIn: toU64(included), excludedIn: input, out: amount, next, fee, ...splitFees(fee, hasReferral), left: 0n };
    } else {
      const { included: inclOut, fee } = includedFeeAmount(numerator, amount);
      const { input, next } = baseToQuoteFromOut(config, pool.sqrtPrice, toU64(inclOut));
      if (next > config.migrationSqrtPrice) throw new CurveError('InsufficientLiquidity', 'past the graduation price');
      r = { includedIn: input, excludedIn: input, out: amount, next, fee, ...splitFees(fee, hasReferral), left: 0n };
    }
  } else if (buy) {
    const f = feeOnAmount(numerator, amount, hasReferral);
    const w = quoteToBaseFromIn(config, pool.sqrtPrice, f.amount, config.migrationSqrtPrice);
    if (mode === SwapMode.ExactIn) {
      if (w.left !== 0n) throw new CurveError('InsufficientLiquidity', 'buy would pass the graduation price; use partial fill');
      r = { includedIn: amount, excludedIn: f.amount, out: w.out, next: w.next, fee: f.fee, trading: f.trading, protocol: f.protocol, referral: f.referral, left: 0n };
    } else if (w.left !== 0n) {
      const excl = f.amount - w.left;
      const { included, fee } = includedFeeAmount(numerator, excl);
      r = { includedIn: toU64(included), excludedIn: excl, out: w.out, next: w.next, fee, ...splitFees(fee, hasReferral), left: w.left };
    } else {
      r = { includedIn: amount, excludedIn: f.amount, out: w.out, next: w.next, fee: f.fee, trading: f.trading, protocol: f.protocol, referral: f.referral, left: 0n };
    }
  } else {
    const w = baseToQuoteFromIn(config, pool.sqrtPrice, amount);
    if (mode === SwapMode.ExactIn && w.left !== 0n) throw new CurveError('InsufficientLiquidity', 'sell below the start price');
    const f = feeOnAmount(numerator, w.out, hasReferral);
    r = { includedIn: amount - w.left, excludedIn: amount - w.left, out: f.amount, grossOut: w.out, next: w.next, fee: f.fee, trading: f.trading, protocol: f.protocol, referral: f.referral, left: w.left };
  }
  const { creator, partner } = splitPartnerCreator(r.trading, creatorPct);
  return { ...r, creator, partner, direction, mode };
}

/** Apply a quoted swap to a pool snapshot the way DBC's apply_swap_result does. */
export function applySwap(pool, q) {
  const p = { ...pool };
  p.sqrtPrice = q.next;
  p.partnerQuoteFee = (p.partnerQuoteFee ?? 0n) + q.partner;
  p.creatorQuoteFee = (p.creatorQuoteFee ?? 0n) + q.creator;
  p.protocolQuoteFee = (p.protocolQuoteFee ?? 0n) + q.protocol;
  if (q.direction === Direction.Buy) {
    p.quoteReserve += q.excludedIn;
    p.baseReserve -= q.out;
  } else {
    p.baseReserve += q.excludedIn;
    p.quoteReserve -= q.out + q.trading + q.protocol + q.referral;
  }
  return p;
}

/** Quote needed for the curve to sit at sqrtPrice: the integral from the start price (rounded down). */
export function curveQuoteAt(config, sqrtPrice) {
  let total = 0n, lower = config.sqrtStartPrice;
  for (const seg of segments(config)) {
    if (sqrtPrice <= lower) break;
    const upper = sqrtPrice < seg.sqrtPrice ? sqrtPrice : seg.sqrtPrice;
    total += deltaQuote(lower, upper, seg.liquidity, false);
    lower = seg.sqrtPrice;
  }
  return total;
}
/** Coins the curve has sold when it sits at sqrtPrice (rounded up: the most it could owe). */
export function curveBaseSoldAt(config, sqrtPrice) {
  let total = 0n, lower = config.sqrtStartPrice;
  for (const seg of segments(config)) {
    if (sqrtPrice <= lower) break;
    const upper = sqrtPrice < seg.sqrtPrice ? sqrtPrice : seg.sqrtPrice;
    total += deltaBase(lower, upper, seg.liquidity, true);
    lower = seg.sqrtPrice;
  }
  return total;
}
