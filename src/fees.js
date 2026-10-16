/**
 * The fee schedule of a Meteora DBC price curve, read from the deployed config and nothing else. Every fee figure the site shows
 * (the coin page's and the Launchpad's Fees sections, the founder's launch card, the Buy panel's pool-fee line, the admin's
 * "matches the defaults" sentence) comes through feeSchedule(), so no page carries a fee as a literal: a coin keeps the config
 * it launched under for ever (DBC configs are immutable), and a config with other values shows its own figures.
 *
 *   feeSchedule(config, opts)   the decoded PoolConfig (src/sol/dbc.js decodeConfig) -> the schedule in basis points, exact integers
 *                               where the split is whole; where it is not, one decimal of a basis point and the text says "about"
 *   feeWords(schedule, scope)   the plain sentences the pages show, with accurate labels (Meteora's cut is its PROTOCOL fee: never
 *                               "liquidity", never "LP revenue"); meteoraWords and poolSplitWords are its clauses the founder's
 *                               launch card shares (src/lplaunch.js feeSplit)
 *   GET /api/fees[?mint=]       the schedule of the live launch config, or of the config a recorded coin launched under (public,
 *                               read-only, counted by the public limiter on a cache miss; the config bytes are kept 10 minutes per
 *                               server, the answer is Cache-Control: public, max-age=300)
 *
 * What the chain does with a curve trade's fee (DBC; measured on copies of Meteora's mainnet programs on 16 Oct 2026, measured again,
 * identical, on Meteora's upgraded programs the same day, and checked at the live fee by solana/tests-launchpad 04-trading TD01 and
 * 07-graduation TG01): Meteora's program keeps PROTOCOL_FEE_PERCENT (20%) of
 * every trading fee as its protocol fee; when the swap names a referral account, HOST_FEE_PERCENT (20%) of that cut, a fifth, goes to
 * that account instead: trades built by vicinity.city name the dev wallet's account, other front-ends do not. The rest splits by the
 * config's creator_trading_fee_percentage between the city's Coin PDA (the creator) and the dev wallet (the partner); our program
 * halves the city's part at harvest (math.rs split_fee: founder floor(c/2), holders the rest). After graduation the DAMM v2 pool's fee
 * (migrated_pool_fee_bps) splits the same way: Meteora 20%, the rest to the two permanently locked positions by the config's
 * locked-liquidity percentages (the dev wallet's and the city's Coin PDA's, then halved founder/holders), dilutable only if someone
 * adds liquidity later. The launch fee (pool_creation_fee) goes 90% to the dev wallet and 10% to Meteora
 * (PROTOCOL_POOL_CREATION_FEE_PERCENT). At graduation Meteora keeps 0.2% of the SOL and of the coins moved into the pool, once (not a
 * trading fee). These
 * percentages are Meteora's program behaviour, not fields of the config: they are options here with those defaults, named in the answer
 * with their source.
 */
import { json } from "./http.js";
import { isSolanaAddress } from "./solana.js";
import { codeOf } from "./sources.js";
import { lpSetup } from "./cluster.js";
import { readAccounts } from "./lpkit.js";
import { decodeConfig } from "./sol/dbc.js";
import { formatAmount } from "./sol/input.js";
import { iso } from "./policy.js";
import { findCoin } from "./lpcoins.js";
import { FEE_DENOMINATOR, HOST_FEE_PERCENT, PROTOCOL_FEE_PERCENT } from "../solana/sdk/launchpad/curve.mjs";

/**
 * Meteora's program constants (not in the config): the SDK's fee mirror (curve.mjs), measured on 16 Oct 2026 on copies of Meteora's
 * mainnet programs pinned in October 2026, and measured again, identical, on Meteora's upgraded mainnet programs the same day.
 */
export const METEORA = Object.freeze({
  protocolPercent: Number(PROTOCOL_FEE_PERCENT), // Meteora's cut of every trading fee (20), before and after graduation
  referralPercent: Number(HOST_FEE_PERCENT), // the part of that cut a swap's referral account gets (20: a fifth)
  creationFeeProtocolPercent: 10, // PROTOCOL_POOL_CREATION_FEE_PERCENT: Meteora's part of the launch fee
  migrationFeeBps: 20, // 0.2% of the SOL and of the coins moved into the pool at graduation, once
  source: "Meteora's program (measured 16 Oct 2026 on copies of its mainnet programs pinned in October 2026; re-measured identical on Meteora's upgraded programs on 16 Oct 2026)",
});
const SOL_DECIMALS = 9;
const CONFIG_MS = 10 * 60_000;

/* ---------------------------------------------------------------- exact fractions */
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
const frac = (n, d = 1n) => { const g = gcd(n, d) || 1n; return { n: n / g, d: d / g }; };
const mul = (f, pn, pd) => frac(f.n * BigInt(pn), f.d * BigInt(pd));
const sub = (a, b) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const half = (f) => frac(f.n, f.d * 2n);
const same = (a, b) => a.n * b.d === b.n * a.d;
/** A fraction of the trade (1 = the whole trade) as a figure: basis points with at most one decimal, and whether that is exact. */
function figure(f) {
  const tenths = f.n * 100_000n, exact = tenths % f.d === 0n;
  const t = exact ? tenths / f.d : (2n * tenths + f.d) / (2n * f.d); // tenths of a basis point, rounded half up when not exact
  const bps = Number(t) / 10;
  const pct = trim((Number(t) / 1000).toFixed(3));
  return { bps, pct, exact, text: `${exact ? "" : "about "}${pct}%` };
}
const trim = (s) => s.replace(/\.?0+$/, "");
/** "a fifth" for 20, "a quarter" for 25, "half" for 50, else "N%". */
const partWords = (pct) => (pct === 20 ? "a fifth" : pct === 25 ? "a quarter" : pct === 50 ? "half" : `${pct}%`);
const short = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a || ""));

/**
 * Whether the config's fees are the flat ones this schedule describes (our program's rules 5 and 9, validate.rs, allow no other): the
 * curve's base fee with no scheduler or rate limiter (mode 0 or 1, the three factors 0) and no dynamic fee; the pool's fee the
 * customizable migrated_pool_fee_bps (migration fee option 6) with no dynamic fee and no scheduler. A field the object does not carry
 * is not checked (the synthetic configs of the tests); decodeConfig carries them all. Anything else: no schedule, nothing said.
 */
function isFlat(c) {
  const zero = (v) => v == null || BigInt(v) === 0n;
  return (c.baseFeeMode == null || Number(c.baseFeeMode) <= 1) && zero(c.firstFactor) && zero(c.secondFactor) && zero(c.thirdFactor) && zero(c.dynamicFeeOn)
    && (c.migrationFeeOption == null || Number(c.migrationFeeOption) === 6) && zero(c.migratedDynamicFee) && zero(c.migratedPoolBaseFeeMode);
}

/**
 * The schedule of a decoded PoolConfig. `config`: decodeConfig()'s object (feeNumerator, creatorTradingFeePercentage,
 * migratedPoolFeeBps, poolCreationFee, the four liquidity percentages); the options are Meteora's percentages (METEORA) and the
 * source to name (address, readAt ms). Pure: no network, no literal fee.
 */
export function feeSchedule(config, { protocolPercent = METEORA.protocolPercent, referralPercent = METEORA.referralPercent, creationFeeProtocolPercent = METEORA.creationFeeProtocolPercent, address = null, readAt = null } = {}) {
  if (!config || !isFlat(config)) return null;
  const P = BigInt(protocolPercent), R = BigInt(referralPercent), C = BigInt(config.creatorTradingFeePercentage);
  const partnerLp = BigInt((config.partnerLockedLpPercentage ?? 0) + (config.partnerLpPercentage ?? 0));
  const creatorLp = BigInt((config.creatorLockedLpPercentage ?? 0) + (config.creatorLpPercentage ?? 0));
  const lpTotal = partnerLp + creatorLp || 100n;
  // the curve: the fee is a fraction of the trade (numerator over DBC's FEE_DENOMINATOR, 1e9)
  const total = frac(BigInt(config.feeNumerator), FEE_DENOMINATOR);
  const meteora = mul(total, P, 100n), referral = mul(meteora, R, 100n);
  const rest = sub(total, meteora), city = mul(rest, C, 100n), vicinity = sub(rest, city), founder = half(city), holders = sub(city, founder);
  // the pool: migrated_pool_fee_bps of the trade; Meteora's cut, then the locked positions by their share of the liquidity
  const pTotal = frac(BigInt(config.migratedPoolFeeBps), 10_000n);
  const pMeteora = mul(pTotal, P, 100n), positions = sub(pTotal, pMeteora);
  const pVicinity = mul(positions, partnerLp, lpTotal), pCity = mul(positions, creatorLp, lpTotal), pFounder = half(pCity), pHolders = sub(pCity, pFounder);
  const F = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, figure(v)]));
  const curve = F({ total, meteora, referral, vicinity, city, founder, holders }), pool = F({ total: pTotal, meteora: pMeteora, positions, vicinity: pVicinity, city: pCity, founder: pFounder, holders: pHolders });
  const bps = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`${k}Bps`, v.bps]));
  const launchFee = BigInt(config.poolCreationFee);
  return {
    curve: { ...bps(curve), exact: Object.values(curve).every((f) => f.exact), text: Object.fromEntries(Object.entries(curve).map(([k, v]) => [k, v.text])) },
    pool: { ...bps(pool), exact: Object.values(pool).every((f) => f.exact), text: Object.fromEntries(Object.entries(pool).map(([k, v]) => [k, v.text])),
      // "split the same way" as the curve only when the city's part of the fee (creator %) and its part of the liquidity are the same share
      sameAsCurve: same(frac(C, 100n), frac(creatorLp, lpTotal)) },
    launchFeeLamports: launchFee.toString(), launchFeeSol: formatAmount(launchFee, SOL_DECIMALS),
    launchSplit: { vicinity: 100 - creationFeeProtocolPercent, meteora: creationFeeProtocolPercent },
    meteora: { protocolPercent, referralPercent, creationFeeProtocolPercent, migrationFeeBps: METEORA.migrationFeeBps, source: METEORA.source },
    source: { config: address, readAt: readAt == null ? null : iso(readAt) },
  };
}

/**
 * "Meteora protocol fee 0.25% (20% of the fee, set by Meteora's program, which sends a fifth of that to Vicinity on trades made here)":
 * the same clause wherever the curve's split is said (the Fees sections, the founder's launch card). Only the 20% and the fifth are
 * Meteora's program's, and the clause says so for both; the 0.25% is the config's fee times the 20%. `past`: the words for a coin that
 * has left its curve ("sent").
 */
export function meteoraWords(S, { past = false } = {}) {
  const r = S.meteora.referralPercent;
  return `Meteora protocol fee ${S.curve.text.meteora} (${S.meteora.protocolPercent}% of the fee, set by Meteora's program${r > 0 ? `, which ${past ? "sent" : "sends"} ${partWords(r)} of that to Vicinity on trades made here` : ""})`;
}
/** The note on the pool's split: the two locked positions share their part with anyone who adds liquidity later. */
const LATER = "(anyone who adds liquidity to the pool later takes part of everything but the Meteora protocol fee)";
/**
 * How the pool fee splits after graduation, the same clause wherever it is said. The site's trades then go through Jupiter with no
 * referral of ours (src/lptrade.js, src/swap.js), so none of the Meteora protocol fee goes to Vicinity there; and the two locked
 * positions share the rest with anyone who adds liquidity to the pool later. `founder`: how the founder is named ("the city's
 * founder", "you"). Meteora's cut is called "the Meteora protocol fee" in every sentence, one name for one thing.
 */
export function poolSplitWords(S, founder = "the city's founder") {
  const p = S.pool.text;
  const after = S.meteora.referralPercent > 0 ? `none of the Meteora protocol fee goes to Vicinity ${LATER}` : LATER;
  if (S.pool.sameAsCurve) return S.meteora.referralPercent > 0 ? `split the same way, except that ${after}` : `split the same way ${LATER}`;
  return `split: Meteora protocol fee ${p.meteora}, Vicinity ${p.vicinity}, ${founder} ${p.founder}, the city's holder pot ${p.holders}; ${after}`;
}

/**
 * Where the founder's and the holder pot's figures come from besides the settings: our program halves the city's share at harvest
 * (math.rs split_fee), which is not a field of the settings. Said under every source line. `founder`: "the founder", "you".
 */
export const halvesWords = (founder = "the founder") => `Vicinity's program splits the city's share evenly between ${founder} and the holder pot.`;
/**
 * The plain sentences for a schedule. `scope`: "live" (the Launchpad: the price curve new coins launch on) or "coin" (a coin page:
 * the settings that coin launched under). Every number is the schedule's; the labels are the accurate ones (Meteora's cut is its
 * protocol fee). A coin page also gets `graduated` ({ curve, steps }): the same facts for a coin that has moved to its pool, the pool
 * first (the fee that applies now), the curve after it in the past tense.
 */
export function feeWords(S, scope = "live") {
  const c = S.curve.text, p = S.pool.text, coin = scope === "coin", r = S.meteora.referralPercent;
  // what waits for its own step. Reward rounds are not on the site yet (docs/OWNER-LAUNCH-GUIDE.md) and are not a promise (the
  // Terms, Platform Mechanisms): the holders' share is said to wait, never to be paid. Meteora's own part waits too, until Meteora
  // collects it (DBC's and DAMM v2's protocol-fee claims)
  const rest = "waits on chain until collected: Meteora collects its own, the founder collects theirs, Vicinity claims its own, and the holders' share stays on chain for holder reward rounds. Those rounds are not on the site yet and are not a promise (see the Terms).";
  // the referral is the one part paid inside the trade itself (the fee check of 16 Oct 2026), and only on curve trades the site
  // builds (they name the dev wallet's account); other front-ends name their own or none
  const during = r > 0 ? `On curve trades made here, only Vicinity's part of the Meteora protocol fee reaches a wallet during the trade. The rest ${rest}` : `No share reaches a wallet during the trade. Each ${rest}`;
  const words = {
    curve: `Every buy and sell on the price curve pays ${c.total}: ${meteoraWords(S)}, Vicinity ${c.vicinity}, the city's founder ${c.founder}, the city's holder pot ${c.holders}. ${coin ? "After graduation, this coin's" : "After a coin graduates, its"} pool fee is ${p.total}, ${poolSplitWords(S)}.`,
    steps: during,
    // the 90 / 10 split and the 0.2% are Meteora's program's, not the config's: each says so
    oneOff: `Launch fee: ${S.launchFeeSol} SOL, paid once by the founder (${S.launchSplit.vicinity}% Vicinity, ${S.launchSplit.meteora}% Meteora, as Meteora's program splits it). At graduation Meteora's program keeps ${trim((S.meteora.migrationFeeBps / 100).toFixed(2))}% of the SOL and of the coins moved into the pool, once. No Vicinity fee on wallet transfers; only Solana's network fee and, for a first-time recipient, one-time account rent.`,
    // the founder / holder-pot halving is our program's rule, not the settings': said after the source, as its own (the pages write
    // their own source line in the viewer's clock and add `halves` after it)
    source: `Read from ${coin ? "this coin's" : "the"} price-curve settings on Solana${S.source.config ? ` (${short(S.source.config)})` : ""}${S.source.readAt ? ` at ${S.source.readAt.slice(11, 16)} UTC` : ""}. ${halvesWords()}`,
    halves: halvesWords(),
  };
  if (!coin) return words;
  // a graduated coin: the pool's fee leads, with its own figures; the steps say only what waits on chain (whether Jupiter's own routing pays
  // anyone inside a pool trade is not ours to state)
  const pool = `This coin has graduated. Every buy and sell in its pool pays ${p.total}: Meteora protocol fee ${p.meteora} (${S.meteora.protocolPercent}% of the fee, set by Meteora's program), Vicinity ${p.vicinity}, the city's founder ${p.founder}, the city's holder pot ${p.holders}. Anyone else who adds liquidity to the pool takes part of everything but the Meteora protocol fee, so these shares can be smaller.`;
  const sameSplit = S.pool.sameAsCurve && S.pool.totalBps === S.curve.totalBps; // the same figures, not only the same shares
  const before = sameSplit
    ? `Before graduation, every buy and sell on the price curve paid ${c.total}, split the same way${r > 0 ? `, except that Meteora's program sent ${partWords(r)} of the Meteora protocol fee to Vicinity on trades made here` : ""}.`
    : `Before graduation, every buy and sell on the price curve paid ${c.total}: ${meteoraWords(S, { past: true })}, Vicinity ${c.vicinity}, the city's founder ${c.founder}, the city's holder pot ${c.holders}.`;
  return { ...words, graduated: { curve: `${pool} ${before}`, steps: `Each share ${rest}` } };
}

/* ---------------------------------------------------------------- the route */
const configs = new Map(); // config address -> { at, promise of { config, readAt } | null }: the bytes, 10 minutes per server
export const _resetFees = () => configs.clear();
/** The decoded config at `address` (null when the account is not a DBC config); throws on a transport failure. */
async function configAt(env, address, fetchImpl, now) {
  const hit = configs.get(address);
  if (hit && now - hit.at < CONFIG_MS && now >= hit.at) return hit.promise;
  const promise = readAccounts(env, [address], fetchImpl).then((m) => { const c = decodeConfig(m.get(address) || null); return c ? { config: c, readAt: now } : null; });
  configs.set(address, { at: now, promise });
  promise.catch(() => { if (configs.get(address)?.promise === promise) configs.delete(address); });
  if (configs.size > 200) configs.delete(configs.keys().next().value);
  return promise;
}

/**
 * GET /api/fees            the schedule of the live launch config (the first of LAUNCHPAD_DBC_CONFIGS)
 * GET /api/fees?mint=<mint> the schedule of the config that coin launched under (a coin recorded here, or found on the chain)
 * The route in src/index.js has checked the gate (lpSetup on), the method and the mint's shape, and counts the public limit on a
 * cache miss. Answers: 200 the schedule; 404 not_found (no such coin), config_not_set (no live config yet), config_missing (the
 * address holds no DBC config) or config_not_flat (a fee that changes, which our program never allows); 503 when the chain could
 * not be read.
 */
export async function handleFees(request, env, fetchImpl = fetch, now = Date.now()) {
  const s = lpSetup(env);
  if (!s.on) return json({ ok: false, error: "not_enabled" }, 404);
  const mint = new URL(request.url).searchParams.get("mint");
  let address, coin = null, scope = "live";
  if (mint !== null) {
    if (!isSolanaAddress(mint)) return json({ ok: false, error: "bad_mint" }, 400);
    if (!env.DB) return json({ ok: false, error: "unavailable" }, 503);
    // an unknown mint's chain lookup is counted as /api/lp/coin counts it (lp_coin), not a second time under "fees"
    const f = await findCoin(request, env, mint, fetchImpl, now, "lp_coin");
    if (f.response) return f.response;
    if (f.error) return json({ ok: false, error: f.error === "rpc_unavailable" ? "rpc_unavailable" : "unavailable" }, 503);
    if (!f.row) return json({ ok: false, error: "not_found" }, 404, { "Cache-Control": "public, max-age=60" });
    address = f.row.dbc_config; coin = { mint: f.row.mint, cityId: String(f.row.city_id), symbol: f.row.symbol || null }; scope = "coin";
  } else {
    if (!s.configsSet) return json({ ok: false, error: "config_not_set" }, 404);
    address = s.dbcConfigs[0];
  }
  let read;
  try { read = await configAt(env, address, fetchImpl, now); } catch (e) { console.error("fees config read failed", codeOf(e)); return json({ ok: false, error: "rpc_unavailable" }, 503); }
  if (!read) return json({ ok: false, error: "config_missing" }, 404);
  const S = feeSchedule(read.config, { address, readAt: read.readAt });
  if (!S) return json({ ok: false, error: "config_not_flat" }, 404); // a fee that changes with time or volatility: never described as flat
  return json({ ok: true, cluster: s.cluster, config: address, ...(coin ? { coin } : {}), readAt: S.source.readAt, ...S, words: feeWords(S, scope) }, 200, { "Cache-Control": "public, max-age=300" });
}
