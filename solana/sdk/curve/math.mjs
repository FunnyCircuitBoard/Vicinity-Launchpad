// BigInt port of the math crate `vicinity-curve-math` (VICINITY-CURVE-DESIGN.md
// sections 5, 5.13, 5.16 and 7.1): the same functions, the same rounding, the
// same checks in the same order and the same errors, so that a quote made here
// equals the program's result to the lamport and raw unit.
//
// Every u64/u128 bound of the Rust crate is enforced: a product or sum that
// would leave u128, or a result that would leave u64, throws
// MathError('Overflow') exactly where the crate returns `MathError::Overflow`.
// sdk/curve/math.test.mjs replays the crate's golden vectors
// (crates/vicinity-curve-math/reference/vectors.json, generated from the
// reference model of Appendix A) and tests/curve suites compare every quote
// with the program's real results.
//
// Terms, states and quotes use camelCase keys with BigInt values; `phase` is
// 0 (Curve) or 1 (Pool).
import {
  BPS, BUYBACK_CAP_DIVISOR, BUYBACK_INTERVAL_SLOTS, BUYBACK_MIN_HORIZON_RUNS, BUYBACK_MIN_HORIZON_RUNS_FOUNDER,
  COIN_SUPPLY, CONTINUITY_PPB, DERIVE_CURVE_RADIUS, MAX_DUST_RAW, MAX_FOUNDER_FEE_BPS, MAX_GRADUATION_LAMPORTS,
  MAX_LAUNCH_FEE_LAMPORTS, MAX_PLATFORM_FEE_BPS, MAX_TOTAL_FEE_BPS, MAX_VIRTUAL, MEV_MAX_PERCENT,
  MIN_GRADUATION_LAMPORTS, MIN_TOTAL_FEE_BPS, MIN_TRADE_LAMPORTS, PPB,
} from './constants.mjs';

export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const Phase = Object.freeze({ Curve: 0, Pool: 1 });
const D = BPS;

/** Errors of the trade and curve functions (the crate's `MathError`). */
export class MathError extends Error {
  constructor(code) {
    super(`MathError::${code}`);
    this.name = 'MathError';
    this.code = code;
  }
}
/** The program error a math error surfaces as (4.22; NOTES entries 8 and 23). */
export function programErrorOf(e) {
  const code = e?.code ?? e;
  return ['TradeTooSmall', 'ZeroAmount', 'ZeroOutput', 'SellExceedsCurve'].includes(code) ? code : 'MathOverflow';
}

const CONFIG_RULES = Object.freeze({
  FeeTotal: ['V1', 'ConfigFeeTotal'],
  FeeShareCap: ['V2', 'ConfigFeeShareCap'],
  Supply: ['V3', 'ConfigSupply'],
  CurveBounds: ['V4', 'ConfigCurveBounds'],
  Graduation: ['V5', 'ConfigGraduation'],
  Absorption: ['V6', 'ConfigAbsorption'],
  Continuity: ['V7', 'ConfigContinuity'],
  BuybackMev: ['V8', 'ConfigBuybackMev'],
  LaunchFee: ['V9', 'ConfigLaunchFee'],
  DripFarmable: ['V10', 'ConfigDripFarmable'],
  BuybackHorizon: ['V11', 'ConfigBuybackHorizon'],
});
/** Errors of `validateConfig` (the crate's `ConfigError`): `code` as in Rust, `rule` V1 to V11, `programError` as in 4.22. */
export class ConfigError extends Error {
  constructor(code) {
    super(`ConfigError::${code} (${CONFIG_RULES[code][0]})`);
    this.name = 'ConfigError';
    this.code = code;
    this.rule = CONFIG_RULES[code][0];
    this.programError = CONFIG_RULES[code][1];
  }
}

// ---------------------------------------------------------------- checked arithmetic (arith.rs)
const fail = (code) => { throw new MathError(code); };
const mul = (a, b) => { const r = a * b; if (r > U128_MAX) fail('Overflow'); return r; };
const add = (a, b) => { const r = a + b; if (r > U128_MAX) fail('Overflow'); return r; };
const sub = (a, b, code) => (b > a ? fail(code) : a - b);
const divFloor = (a, b) => (b === 0n ? fail('DivisionByZero') : a / b);
const divCeil = (a, b) => {
  if (b === 0n) fail('DivisionByZero');
  return a / b + (a % b === 0n ? 0n : 1n);
};
const toU64 = (a) => (a > U64_MAX ? fail('Overflow') : a);
const add64 = (a, b) => toU64(a + b);
const sub64 = (a, b, code) => (b > a ? fail(code) : a - b);
const add128 = (a, b) => { const r = a + b; if (r > U128_MAX) fail('Overflow'); return r; };

/** An input amount as BigInt within u64 (the Rust functions take u64). */
function u64(x, what = 'amount') {
  const v = BigInt(x);
  if (v < 0n || v > U64_MAX) throw new RangeError(`${what} out of u64: ${x}`);
  return v;
}
function u16(x, what) {
  const v = BigInt(x);
  if (v < 0n || v > 0xffffn) throw new RangeError(`${what} out of u16: ${x}`);
  return v;
}

// ---------------------------------------------------------------- types (types.rs)
const TERM_KEYS = ['liquidityBps', 'platformBps', 'founderBps', 'holdersBps', 'buybackBps', 'totalFeeBps', 'virtualSol', 'virtualTokens', 'curveSupply', 'poolSupply', 'graduationSol'];
const PARAM_KEYS = ['liquidityBps', 'platformBps', 'founderBps', 'holdersBps', 'buybackBps', 'virtualSol', 'virtualTokens', 'curveSupply', 'poolSupply', 'graduationSol', 'launchFeeLamports'];
export const STATE_KEYS = Object.freeze([
  'phase', 'tokensSold', 'curveSol', 'poolSol', 'poolTokens', 'liquidityPending', 'platformPending', 'founderPending',
  'holdersPending', 'buybackPending', 'lastBuybackSlot', 'tradeSeq', 'buybackCount', 'tokensBurned', 'buyVolume',
  'sellVolume', 'feesTotal', 'liquidityEarned', 'liquidityAdded', 'platformEarned', 'founderEarned', 'holdersEarned',
  'buybackEarned', 'buybackSpent',
]);
const U128_STATE = new Set(['buyVolume', 'sellVolume', 'feesTotal', 'liquidityEarned', 'liquidityAdded', 'platformEarned', 'founderEarned', 'holdersEarned', 'buybackEarned', 'buybackSpent']);

/** Normalised terms: BigInt fields, bps within u16, amounts within u64. */
export function terms(t) {
  const out = {};
  for (const k of TERM_KEYS) {
    if (t[k] === undefined) throw new Error(`terms: missing ${k}`);
    out[k] = k.endsWith('Bps') ? u16(t[k], k) : u64(t[k], k);
  }
  return out;
}
/** Normalised config parameters (`ConfigParams` of 4.6). */
export function configParams(p) {
  const out = {};
  for (const k of PARAM_KEYS) {
    if (p[k] === undefined) throw new Error(`configParams: missing ${k}`);
    out[k] = k.endsWith('Bps') ? u16(p[k], k) : u64(p[k], k);
  }
  return out;
}
/** Normalised state. */
export function state(s) {
  const out = {};
  for (const k of STATE_KEYS) {
    if (s[k] === undefined) throw new Error(`state: missing ${k}`);
    if (k === 'phase') {
      const p = Number(s[k]);
      if (p !== 0 && p !== 1) throw new RangeError(`phase must be 0 or 1: ${s[k]}`);
      out.phase = p;
    } else {
      const v = BigInt(s[k]);
      if (v < 0n || v > (U128_STATE.has(k) ? U128_MAX : U64_MAX)) throw new RangeError(`${k} out of range: ${s[k]}`);
      out[k] = v;
    }
  }
  return out;
}

/** Default config #0 (3.5, 5.9): split 0.5/0.7/0.5/0.5/0.3, design A's integers, 85 SOL, 0.05 SOL launch fee. */
export const DEFAULT_CONFIG = Object.freeze({
  liquidityBps: 50n, platformBps: 70n, founderBps: 50n, holdersBps: 50n, buybackBps: 30n,
  virtualSol: 30_000_853_639n, virtualTokens: 1_073_025_598_486_615n, curveSupply: 793_099_990_000_000n,
  poolSupply: 206_900_000_900_000n, graduationSol: 85_000_000_000n, launchFeeLamports: 50_000_000n,
});
/** Sum of the five shares (V1 sums them in u32). */
export const totalFeeBps = (p) => BigInt(p.liquidityBps) + BigInt(p.platformBps) + BigInt(p.founderBps) + BigInt(p.holdersBps) + BigInt(p.buybackBps);
/** The terms `launch` copies from a config (`Terms::from_params`); InvalidTerms when the sum does not fit u16. */
export function termsFromParams(p) {
  const q = configParams(p);
  const t = totalFeeBps(q);
  if (t > 0xffffn) fail('InvalidTerms');
  const { launchFeeLamports, ...rest } = q; // eslint-disable-line no-unused-vars
  return { ...rest, totalFeeBps: t };
}
export const DEFAULT_TERMS = Object.freeze(termsFromParams(DEFAULT_CONFIG));

/** The state `launch` writes (4.10 effect 6): every field 0, phase Curve, `lastBuybackSlot = launchSlot`. */
export function stateAtLaunch(launchSlot) {
  const s = Object.fromEntries(STATE_KEYS.map((k) => [k, 0n]));
  s.phase = Phase.Curve;
  s.lastBuybackSlot = u64(launchSlot, 'launchSlot');
  return s;
}

function checkFees(t) {
  const sum = t.liquidityBps + t.platformBps + t.founderBps + t.holdersBps + t.buybackBps;
  if (sum !== t.totalFeeBps || sum >= D) fail('InvalidTerms');
}
function checkTerms(t) {
  checkFees(t);
  if (t.virtualSol === 0n || t.curveSupply === 0n || t.virtualTokens <= t.curveSupply || t.graduationSol === 0n) fail('InvalidTerms');
}

// ---------------------------------------------------------------- fee.rs
const share = (a, bps) => toU64(divFloor(mul(a, bps), D));

/** The fee of a trade amount and its split (5.2): every share rounded down, the remainder (0 to 4) to liquidity. */
export function feeSplit(termsIn, amount) {
  const t = terms(termsIn);
  checkFees(t);
  const a = u64(amount);
  const fee = share(a, t.totalFeeBps);
  const platform = share(a, t.platformBps);
  const founder = share(a, t.founderBps);
  const holders = share(a, t.holdersBps);
  const buyback = share(a, t.buybackBps);
  const liquidity = toU64(sub(fee, platform + founder + holders + buyback, 'InvalidTerms'));
  const liquidityFloor = share(a, t.liquidityBps);
  return { fee, liquidity, liquidityFloor, platform, founder, holders, buyback };
}
const feeOf = (amount, tbps) => divFloor(mul(amount, tbps), D);
function grossForT(net, tbps) {
  if (net === 0n) fail('ZeroAmount');
  const dt = sub(D, tbps, 'InvalidTerms');
  const g = divFloor(mul(net - 1n, D), dt);
  return add(g, 1n);
}
/** Lemma G (5.4): the least charge whose net `G - floor(G*t/D)` is exactly `net` (net >= 1). */
export function grossFor(termsIn, net) {
  const t = terms(termsIn);
  checkFees(t);
  return toU64(grossForT(u64(net), t.totalFeeBps));
}

// ---------------------------------------------------------------- trade.rs
const fRaw = (x0, y0, s) => divCeil(mul(x0, s), sub(y0, s, 'InvalidTerms'));
const tokensForRaw = (x0, y0, q) => divFloor(mul(q, y0), add(x0, q));

/** `f(s) = ceil(x0 * s / (y0 - s))` for `0 <= s <= S` (5.3). */
export function curveValue(termsIn, s) {
  const t = terms(termsIn);
  checkTerms(t);
  const v = u64(s, 's');
  if (v > t.curveSupply) fail('InvalidTerms');
  return toU64(fRaw(t.virtualSol, t.virtualTokens, v));
}
/** `tokens_for(q) = floor(q * y0 / (x0 + q))`: the largest `s` with `f(s) <= q` (Lemma C1). */
export function tokensFor(termsIn, q) {
  const t = terms(termsIn);
  checkTerms(t);
  return toU64(tokensForRaw(t.virtualSol, t.virtualTokens, u64(q, 'q')));
}
function curvePosition(t, st) {
  if (st.tokensSold >= t.curveSupply || st.curveSol >= t.graduationSol) fail('InvalidState');
  return [st.tokensSold, st.curveSol];
}
function book(st, split, phase) {
  st.platformPending = add64(st.platformPending, split.platform);
  st.founderPending = add64(st.founderPending, split.founder);
  st.holdersPending = add64(st.holdersPending, split.holders);
  st.buybackPending = add64(st.buybackPending, split.buyback);
  st.platformEarned = add128(st.platformEarned, split.platform);
  st.founderEarned = add128(st.founderEarned, split.founder);
  st.holdersEarned = add128(st.holdersEarned, split.holders);
  st.buybackEarned = add128(st.buybackEarned, split.buyback);
  st.liquidityEarned = add128(st.liquidityEarned, split.liquidity);
  st.feesTotal = add128(st.feesTotal, split.fee);
  if (phase === Phase.Curve) {
    st.liquidityPending = add64(st.liquidityPending, split.liquidity);
    return 0n;
  }
  const drip = st.liquidityPending < split.liquidityFloor ? st.liquidityPending : split.liquidityFloor;
  const added = add64(split.liquidity, drip);
  st.poolSol = add64(st.poolSol, added);
  st.liquidityPending = sub64(st.liquidityPending, drip, 'InvalidState');
  st.liquidityAdded = add128(st.liquidityAdded, added);
  return drip;
}

/**
 * Quote of `buy(sol_in)` (5.4, 5.6, 5.7): `{ charged, net, tokensOut, split, drip, partial, graduates, newState }`.
 * `charged <= solIn`; less only on the partial fill of the buy that completes the curve.
 */
export function quoteBuy(termsIn, stateIn, solIn) {
  const t = terms(termsIn);
  const s0 = state(stateIn);
  checkTerms(t);
  const g = u64(solIn, 'solIn');
  if (g < MIN_TRADE_LAMPORTS) fail('TradeTooSmall');
  const tb = t.totalFeeBps;
  const n = sub(g, feeOf(g, tb), 'Overflow');
  const st = { ...s0 };
  const pricedIn = s0.phase;
  let charged; let c; let tokens; let graduates;
  if (s0.phase === Phase.Curve) {
    const [s, r] = curvePosition(t, s0);
    const rem = sub(t.graduationSol, r, 'InvalidState');
    let s2;
    if (n >= rem) {
      s2 = t.curveSupply; c = rem; graduates = true;
    } else {
      s2 = tokensForRaw(t.virtualSol, t.virtualTokens, add(r, n));
      const f2 = fRaw(t.virtualSol, t.virtualTokens, toU64(s2));
      c = sub(f2, r, 'InvalidState'); graduates = false;
    }
    if (c === 0n || c > n) fail('InvalidState');
    charged = c === n ? g : grossForT(c, tb);
    tokens = sub(s2, s, 'InvalidState');
    st.tokensSold = toU64(s2);
    st.curveSol = toU64(add(r, c));
  } else {
    const x = s0.poolSol; const y = s0.poolTokens;
    tokens = divFloor(mul(y, n), add(x, n));
    st.poolSol = toU64(add(x, n));
    st.poolTokens = toU64(sub(y, tokens, 'InvalidState'));
    charged = g; c = n; graduates = false;
  }
  if (tokens === 0n) fail('ZeroOutput');
  if (charged > g) fail('InvalidState');
  charged = toU64(charged);
  const split = feeSplit(t, charged);
  if (sub(charged, split.fee, 'InvalidState') !== c) fail('InvalidState');
  const drip = book(st, split, pricedIn);
  st.buyVolume = add128(st.buyVolume, charged);
  st.tradeSeq = add64(st.tradeSeq, 1n);
  if (graduates) {
    st.phase = Phase.Pool;
    st.poolSol = t.graduationSol;
    st.poolTokens = t.poolSupply;
  }
  liabilities(st);
  return { charged, net: toU64(c), tokensOut: toU64(tokens), split, drip, partial: charged < g, graduates, newState: st };
}

/** Quote of `sell(tokens_in)` (5.5, 5.7): `{ gross, solOut, split, drip, newState }`. */
export function quoteSell(termsIn, stateIn, tokensIn) {
  const t = terms(termsIn);
  const s0 = state(stateIn);
  checkTerms(t);
  const a = u64(tokensIn, 'tokensIn');
  if (a === 0n) fail('ZeroAmount');
  const st = { ...s0 };
  let gross;
  if (s0.phase === Phase.Curve) {
    const [s, r] = curvePosition(t, s0);
    if (a > s) fail('SellExceedsCurve');
    const s2 = s - a;
    const f2 = fRaw(t.virtualSol, t.virtualTokens, s2);
    gross = sub(r, f2, 'InvalidState');
    st.tokensSold = s2;
    st.curveSol = toU64(f2);
  } else {
    const x = s0.poolSol; const y = s0.poolTokens;
    gross = divFloor(mul(x, a), add(y, a));
    st.poolSol = toU64(sub(x, gross, 'InvalidState'));
    st.poolTokens = toU64(add(y, a));
  }
  gross = toU64(gross);
  const split = feeSplit(t, gross);
  const solOut = sub64(gross, split.fee, 'InvalidState');
  if (solOut === 0n) fail('ZeroOutput');
  const drip = book(st, split, s0.phase);
  st.sellVolume = add128(st.sellVolume, gross);
  st.tradeSeq = add64(st.tradeSeq, 1n);
  return { gross, solOut, split, drip, newState: st };
}

/** The market's SOL depth (1.4): `x0 + curveSol` on the curve, `poolSol` in the pool. */
export function depth(termsIn, stateIn) {
  const t = terms(termsIn);
  const s = state(stateIn);
  return s.phase === Phase.Curve ? add64(t.virtualSol, s.curveSol) : s.poolSol;
}
/** `floor(depth * t / (C * D))` (7.1): the most one buyback run may spend. */
export function buybackCap(termsIn, stateIn) {
  const t = terms(termsIn);
  checkTerms(t);
  const dep = depth(t, stateIn);
  return toU64(divFloor(mul(dep, t.totalFeeBps), mul(BUYBACK_CAP_DIVISOR, D)));
}

/** Quote of `buyback_burn()` at `slot` (7.1): `null` for the no-op, else `{ spent, coins, cap, newState }`. */
export function quoteBuyback(termsIn, stateIn, slot) {
  const t = terms(termsIn);
  const s0 = state(stateIn);
  checkTerms(t);
  const sl = u64(slot, 'slot');
  if (s0.buybackPending === 0n) return null;
  if (sl < add64(s0.lastBuybackSlot, BUYBACK_INTERVAL_SLOTS)) return null;
  const cap = buybackCap(t, s0);
  const b = s0.buybackPending < cap ? s0.buybackPending : cap;
  if (b === 0n) return null;
  const st = { ...s0 };
  let spent; let coins;
  if (s0.phase === Phase.Curve) {
    const [s, r] = curvePosition(t, s0);
    const top = tokensForRaw(t.virtualSol, t.virtualTokens, add(r, b));
    const s2 = top < t.curveSupply - 1n ? top : t.curveSupply - 1n;
    const f2 = fRaw(t.virtualSol, t.virtualTokens, toU64(s2));
    spent = sub(f2, r, 'InvalidState');
    coins = sub(s2, s, 'InvalidState');
    if (spent === 0n || coins === 0n) return null;
    st.tokensSold = toU64(s2);
    st.curveSol = toU64(f2);
  } else {
    const x = s0.poolSol; const y = s0.poolTokens;
    coins = divFloor(mul(y, b), add(x, b));
    if (coins === 0n) return null;
    st.poolSol = toU64(add(x, b));
    st.poolTokens = toU64(sub(y, coins, 'InvalidState'));
    spent = b;
  }
  if (spent > b) fail('InvalidState');
  spent = toU64(spent);
  coins = toU64(coins);
  st.buybackPending = sub64(st.buybackPending, spent, 'InvalidState');
  st.buybackSpent = add128(st.buybackSpent, spent);
  st.tokensBurned = add64(st.tokensBurned, coins);
  st.buybackCount = add64(st.buybackCount, 1n);
  st.lastBuybackSlot = sl;
  return { spent, coins, cap, newState: st };
}

/** The `sol_in` that completes the curve exactly (5.4): `max(MIN_TRADE_LAMPORTS, gross_for(R - curveSol))`. */
export function maxQuoteIn(termsIn, stateIn) {
  const t = terms(termsIn);
  const s = state(stateIn);
  checkTerms(t);
  if (s.phase !== Phase.Curve) fail('WrongPhase');
  const [, r] = curvePosition(t, s);
  const g = toU64(grossForT(t.graduationSol - r, t.totalFeeBps));
  return g > MIN_TRADE_LAMPORTS ? g : MIN_TRADE_LAMPORTS;
}

/** Virtual reserves `[virtualSol, virtualTokens]` (5.1): price = first / second lamports per raw unit. */
export function spotPrice(termsIn, stateIn) {
  const t = terms(termsIn);
  const s = state(stateIn);
  if (s.phase === Phase.Curve) return [add64(t.virtualSol, s.curveSol), sub64(t.virtualTokens, s.tokensSold, 'InvalidState')];
  return [s.poolSol, s.poolTokens];
}

/** The reserve of the phase plus the five buckets (6.5): what `pay_out` keeps after every debit. */
export function liabilities(stateIn) {
  const s = state(stateIn);
  let sum = s.phase === Phase.Curve ? s.curveSol : s.poolSol;
  for (const v of [s.liquidityPending, s.platformPending, s.founderPending, s.holdersPending, s.buybackPending]) sum = add64(sum, v);
  return sum;
}

/** Raw units `launch` burns right after the single `mint_to`: `COIN_SUPPLY - S - P` (4.10, O3 (a)). */
export function launchDust(termsIn) {
  const t = terms(termsIn);
  return sub64(COIN_SUPPLY, add64(t.curveSupply, t.poolSupply), 'InvalidTerms');
}

// ---------------------------------------------------------------- config.rs
class Rule {
  constructor(code) { this.code = code; }
  fail() { throw new ConfigError(this.code); }
  mul(a, b) { const r = a * b; if (r > U128_MAX) this.fail(); return r; }
  add(a, b) { const r = a + b; if (r > U128_MAX) this.fail(); return r; }
  sub(a, b) { if (b > a) this.fail(); return a - b; }
  check(ok) { if (!ok) this.fail(); }
}
const CD = BUYBACK_CAP_DIVISOR * D;

/** V8's two sides `[left, right]` (5.13); V8 requires left <= right when `buybackBps > 0`. */
export function v8Sides(pIn) {
  const p = configParams(pIn);
  const r = new Rule('BuybackMev');
  const t = totalFeeBps(p);
  const l = p.liquidityBps;
  const m = p.founderBps > p.holdersBps ? p.founderBps : p.holdersBps;
  const base = r.sub(D, t);
  const a = r.add(base, r.mul(2n, l));
  const cdt = r.add(CD, t);
  let left = r.mul(cdt, cdt);
  left = r.mul(left, r.add(a, m));
  left = r.mul(left, a);
  left = r.add(left, r.mul(r.mul(m, D), r.mul(CD, CD)));
  left = r.mul(left, 100n);
  const right = r.mul(r.mul(MEV_MAX_PERCENT, r.mul(CD, CD)), D * D);
  return [left, right];
}
/** V11's two inequalities `[[left1, right1], [left2, right2]]` (5.13). */
export function v11Sides(pIn) {
  const p = configParams(pIn);
  const r = new Rule('BuybackHorizon');
  const c = BUYBACK_CAP_DIVISOR;
  const t = totalFeeBps(p);
  const l = p.liquidityBps;
  const m = p.founderBps > p.holdersBps ? p.founderBps : p.holdersBps;
  const base = r.sub(D, t);
  const a = r.add(base, r.mul(2n, l));
  const k = 2n * (BUYBACK_MIN_HORIZON_RUNS - 1n);
  const kf = 2n * (BUYBACK_MIN_HORIZON_RUNS_FOUNDER - 1n);
  const left1 = r.mul(r.mul(c, base), a);
  const right1 = r.mul(D, r.sub(CD, r.mul(k, t)));
  const left2 = r.mul(r.mul(c, a), r.add(base, m));
  const right2 = r.mul(r.sub(D, m), r.sub(CD, r.mul(kf, t)));
  return [[left1, right1], [left2, right2]];
}

/** `validate_config` (5.13): throws the first failing rule's ConfigError (table order V1 to V11); returns true otherwise. */
export function validateConfig(pIn) {
  const p = configParams(pIn);
  const t = totalFeeBps(p);
  let r = new Rule('FeeTotal');
  r.check(t >= MIN_TOTAL_FEE_BPS && t <= MAX_TOTAL_FEE_BPS);
  r = new Rule('FeeShareCap');
  r.check(p.platformBps <= MAX_PLATFORM_FEE_BPS && p.founderBps <= MAX_FOUNDER_FEE_BPS);
  // V2b (reviews ECON-1, R3-DIFF-1): a trader credited the founder's share, the holders' share or both (a founder
  // who also holds the float) still pays MIN_TOTAL_FEE_BPS per leg; the same as b_L + b_P + b_B >= 1
  const credited = p.founderBps + p.holdersBps;
  r.check(credited + MIN_TOTAL_FEE_BPS <= t);
  r = new Rule('Supply');
  const s = p.curveSupply; const pp = p.poolSupply;
  r.check(s >= 1n && pp >= 1n);
  const soldAndPool = r.add(s, pp);
  r.check(soldAndPool <= COIN_SUPPLY && COIN_SUPPLY - soldAndPool <= MAX_DUST_RAW);
  r = new Rule('CurveBounds');
  const x0 = p.virtualSol; const y0 = p.virtualTokens; const bigR = p.graduationSol;
  r.check(x0 >= 1n && x0 <= MAX_VIRTUAL && s < y0 && y0 <= MAX_VIRTUAL);
  r.check(r.mul(x0, t) >= CD);
  r.check(r.mul(r.mul(bigR, pp), t) >= r.mul(CD, COIN_SUPPLY));
  r = new Rule('Graduation');
  r.check(bigR >= MIN_GRADUATION_LAMPORTS && bigR <= MAX_GRADUATION_LAMPORTS);
  const fr = (sv) => { try { return fRaw(x0, y0, sv); } catch (e) { if (e instanceof MathError) r.fail(); throw e; } };
  r.check(fr(s) === bigR);
  r.check(fr(s - 1n) < bigR);
  r = new Rule('Absorption');
  const d = y0 - s;
  r.check(r.mul(x0, y0) <= r.mul(d, d));
  r = new Rule('Continuity');
  const opening = r.mul(r.add(x0, bigR), pp);
  const curveEnd = r.mul(bigR, d);
  r.check(curveEnd <= opening);
  const tolerance = r.mul(opening, CONTINUITY_PPB) / PPB;
  r.check(opening - curveEnd <= tolerance);
  if (p.buybackBps > 0n) {
    const [left, right] = v8Sides(p);
    new Rule('BuybackMev').check(left <= right);
  }
  new Rule('LaunchFee').check(p.launchFeeLamports <= MAX_LAUNCH_FEE_LAMPORTS);
  new Rule('DripFarmable').check(p.liquidityBps === 0n || p.liquidityBps < p.platformBps);
  if (p.buybackBps > 0n) {
    const [[l1, r1], [l2, r2]] = v11Sides(p);
    new Rule('BuybackHorizon').check(l1 <= r1 && l2 <= r2);
  }
  return true;
}
/** The first failing rule ('V1' to 'V11') or null. */
export function configRule(p) {
  try { validateConfig(p); return null; } catch (e) { if (e instanceof ConfigError) return e.rule; throw e; }
}

/**
 * The integer search of 5.9 (`derive_curve_within`): for every `x0` within
 * `radius` of `R*P/(S - P)`, the largest admissible `d = y0 - S`; returns
 * `[x0, y0]` with the smallest continuity gap (the smallest `x0` on a tie).
 * Throws MathError('InvalidTerms') when nothing is admissible.
 */
export function deriveCurve(curveSupply, poolSupply, graduationSol, radius = DERIVE_CURVE_RADIUS) {
  const s = u64(curveSupply); const p = u64(poolSupply); const r = u64(graduationSol); const rad = u64(radius);
  if (p === 0n || s <= p || r < 2n) fail('InvalidTerms');
  const num = r * p; const den = s - p;
  const q = num / den; const rm = num % den;
  const sat = (v) => (v < 0n ? 0n : v);
  let lo = rm === 0n ? sat(q - rad) : sat(q - rad) + 1n;
  if (lo < 1n) lo = 1n;
  const hi = q + rad;
  let best = null;
  for (let x0 = lo; x0 <= hi && x0 <= MAX_VIRTUAL; x0++) {
    const found = deriveCandidate(x0, s, p, r);
    if (found && (best === null || found[0] < best[0])) best = found;
  }
  if (!best) fail('InvalidTerms');
  return [toU64(best[1]), toU64(best[2])];
}
function deriveCandidate(x0, s, p, r) {
  const a = mul(x0, s);
  const opening = mul(add(x0, r), p);
  let dHi = divFloor(a - 1n, r - 1n);
  const cap = opening / r;
  if (cap < dHi) dHi = cap;
  if (dHi < divCeil(a, r)) return null;
  const d = dHi;
  const y0 = add(s, d);
  if (divCeil(mul(x0, s - 1n), d + 1n) > r - 1n) return null;
  if (mul(x0, y0) > mul(d, d)) return null;
  if (y0 > MAX_VIRTUAL) return null;
  const gap = opening - r * d;
  if (gap > (opening * CONTINUITY_PPB) / PPB) return null;
  return [gap, x0, y0];
}

// ---------------------------------------------------------------- client helpers
/** `amount * (10,000 - slippageBps) / 10,000`, rounded down: a minimum-out for a quote. */
export function withSlippage(amount, slippageBps) {
  const bps = BigInt(slippageBps);
  if (bps < 0n || bps > D) throw new RangeError(`slippage out of range: ${slippageBps}`);
  return (u64(amount) * (D - bps)) / D;
}
