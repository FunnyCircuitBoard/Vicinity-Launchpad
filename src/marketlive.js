/**
 * Live market data for the Launchpad (only while LAUNCHPAD_V2=on): $VICINITY and the city coins an admin recorded, and NOTHING
 * else. Callers pass allow-listed mints only (src/launchpad.js, src/coin.js); an unknown mint never reaches this module.
 * Research and every shape below: real answers recorded on 6 Oct 2026 for 2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray
 * (test/fixtures/launchlab/). Every value is checked for type and range and kept as a plain number or a known-shape string;
 * every other field is dropped.
 *
 * Sources and what each one is used for (the label travels with every number, src/launchpad.js shows "—" plus a reason when
 * the source has nothing):
 *   the chain       the LaunchLab curve (src/launchlab.js): spot price in the pair token, SOL raised against the 85 SOL
 *                   graduation target, tokens sold, status. 30 s.
 *   Jupiter price   GET {JUPITER_API_BASE}/price/v3?ids= (up to 50 ids): usdPrice (USD per whole token, the LAST TRADE's price),
 *                   priceChange24h (percent), liquidity (USD). A token Jupiter does not price is simply missing from the answer:
 *                   that is "no price", never 0. The pair tokens (SOL, USDC, RAY) are asked in the same call. 30 s, last good
 *                   value kept 5 minutes (marked stale).
 *   Jupiter tokens  GET {JUPITER_API_BASE}/tokens/v2/search?query= (up to 100 mints): mcap, fdv, stats24h (buy and sell
 *                   volume in USD, traders, price change), graduatedPool / graduatedAt after migration. 60 s.
 *                   A missing stats24h is "—", not 0. Jupiter's terms: show "Powered by Jupiter" (ATTRIBUTION below) and do not
 *                   act as a public data proxy: our routes answer only what our own pages show, for allow-listed coins.
 *   Raydium mint    GET https://launch-mint-v1.raydium.io/get/by/mints?ids= (20 a call): the rolling 24 h volume in USD (volumeU),
 *                   asked ONLY for curve coins whose volume Jupiter and DEX Screener did not give. Its poolId must equal the
 *                   derived pool. Its finishingRate is price-based and is NOT the graduation progress: not used. 60 s.
 *   Raydium trades  GET https://launch-history-v1.raydium.io/trade?poolId=&limit=20: recent trades. 30 s.
 *   Raydium kline   GET https://launch-history-v1.raydium.io/kline?poolId=&interval=1m|5m|15m&limit=1..500[&nextPageKey=]: OHLC in
 *                   the pair token, newest first, only buckets that had trades, no volume (src/pricehistory.js stores 15m).
 *   DEX Screener    src/market.js (unchanged): nothing before migration, the AMM pool after it (pool liquidity).
 * Limits: Jupiter keyless is 30 a minute (a key: 60), Raydium publishes none (Cloudflare, 429 with Retry-After), DEX Screener
 * 300 a minute. Here: per server at most one call per source per 30-60 s, 5 s of silence after any failure (longer when the
 * source sent Retry-After), 3.5 s timeout and one retry after a network error (src/sources.js).
 */
import { Source, SourceError, getJson } from "./sources.js";
import { readCurves } from "./launchlab.js";
import { marketFor } from "./market.js";
import { isSolanaAddress } from "./solana.js";

const JUPITER_BASE = "https://lite-api.jup.ag";
export const RAYDIUM_MINT_URL = "https://launch-mint-v1.raydium.io/get/by/mints";
export const RAYDIUM_HISTORY = "https://launch-history-v1.raydium.io";
export const KLINE_INTERVALS = { "1m": 60, "5m": 300, "15m": 900 };
const EARLIEST = Date.parse("2025-01-01T00:00:00Z") / 1000; // no LaunchLab trade is older (a lower bound for any coin's rows)

// plausible ranges: a value outside is a broken answer, not a market (Raydium's own list carries junk market caps near 1e13)
const MAX = { price: 1e6, mcap: 1e12, liquidity: 1e11, volume: 1e11, native: 1e6, tokens: 1e13, pair: 1e10, traders: 1e8 };
const fin = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? n + 0 : null;
};
const positive = (v, max) => { const n = fin(v); return n != null && n > 0 && n <= max ? n : null; };
const nonNegative = (v, max) => { const n = fin(v); return n != null && n >= 0 && n <= max ? n : null; };
const percent = (v) => { const n = fin(v); return n != null && n >= -100 && n <= 1e6 ? n : null; };
const count = (v, max) => (Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null);
const isoOrNull = (v) => (typeof v === "string" && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const plain = (v) => v != null && typeof v === "object" && !Array.isArray(v);
export const maskWallet = (w) => (w ? `${w.slice(0, 5)}*****${w.slice(-3)}` : null);

const jupBase = (env) => String((env && env.JUPITER_API_BASE) || JUPITER_BASE).replace(/\/+$/, "");
const jupHeaders = (env) => (env && env.JUPITER_API_KEY ? { "x-api-key": String(env.JUPITER_API_KEY) } : {});

/* ------------------------------------------------------------------ Jupiter */

/** One mint's entry of a Jupiter price v3 answer, or null (missing, or no usable price). */
export function jupPriceOf(e) {
  if (!plain(e)) return null;
  const usdPrice = positive(e.usdPrice, MAX.price);
  if (usdPrice == null) return null;
  return { usdPrice, change24hPct: percent(e.priceChange24h), liquidityUsd: nonNegative(e.liquidity, MAX.liquidity), blockId: count(e.blockId, Number.MAX_SAFE_INTEGER) };
}

/** One item of a Jupiter tokens v2 answer (already matched to the asked mint), or null. */
export function jupTokenOf(t) {
  if (!plain(t)) return null;
  const s = plain(t.stats24h) ? t.stats24h : null;
  const buy = s ? nonNegative(s.buyVolume, MAX.volume) : null, sell = s ? nonNegative(s.sellVolume, MAX.volume) : null;
  return {
    usdPrice: positive(t.usdPrice, MAX.price), mcapUsd: positive(t.mcap, MAX.mcap), fdvUsd: positive(t.fdv, MAX.mcap),
    liquidityUsd: nonNegative(t.liquidity, MAX.liquidity), circSupply: positive(t.circSupply, MAX.tokens), totalSupply: positive(t.totalSupply, MAX.tokens),
    stats24h: s ? { volumeUsd: buy != null && sell != null ? buy + sell : null, buyVolumeUsd: buy, sellVolumeUsd: sell, traders: count(s.numTraders, MAX.traders), changePct: percent(s.priceChange) } : null,
    graduatedPool: isSolanaAddress(t.graduatedPool) ? t.graduatedPool : null, graduatedAt: isoOrNull(t.graduatedAt),
    // where Jupiter says the coin was launched (its own field; only this one known value is kept)
    launchlab: t.metaLaunchpad === "raydium-launchlab" || t.launchpad === "raydium-launchlab",
  };
}

const jupPrices = new Source("jupiter_price", { ttlMs: 30_000 });
const jupTokens = new Source("jupiter_tokens", { ttlMs: 60_000 });

/** Jupiter price v3 for some mints: Source.get's answer (values: mint -> jupPriceOf | null | undefined). */
export function jupiterPriceFor(env, mints, fetchImpl = fetch, now = Date.now()) {
  return jupPrices.get(mints.filter(isSolanaAddress), now, async (want) => {
    const got = new Map();
    for (let i = 0; i < want.length; i += 50) {
      const ids = want.slice(i, i + 50);
      const d = await getJson(`${jupBase(env)}/price/v3?ids=${ids.join(",")}`, fetchImpl, { headers: jupHeaders(env) });
      if (!plain(d)) throw new SourceError("bad_answer");
      for (const m of ids) got.set(m, Object.hasOwn(d, m) ? jupPriceOf(d[m]) : null);
    }
    return got;
  });
}

/** Jupiter tokens v2 for some mints (values: mint -> jupTokenOf | null | undefined). */
export function jupiterTokensFor(env, mints, fetchImpl = fetch, now = Date.now()) {
  return jupTokens.get(mints.filter(isSolanaAddress), now, async (want) => {
    const got = new Map();
    for (let i = 0; i < want.length; i += 100) {
      const ids = want.slice(i, i + 100);
      const d = await getJson(`${jupBase(env)}/tokens/v2/search?query=${ids.join(",")}`, fetchImpl, { headers: jupHeaders(env) });
      if (!Array.isArray(d) || d.length > 500) throw new SourceError("bad_answer");
      for (const t of d) if (plain(t) && ids.includes(t.id) && !got.has(t.id)) got.set(t.id, jupTokenOf(t));
    }
    return got;
  });
}

/* ------------------------------------------------------------------ Raydium LaunchLab */

const raydiumOk = (d) => { if (!plain(d) || d.success !== true || !plain(d.data) || !Array.isArray(d.data.rows)) throw new SourceError(plain(d) && d.success === false ? "raydium_refused" : "bad_answer"); return d.data; };

/** One row of launch-mint-v1 /get/by/mints, checked against the pool we derived ourselves; null when it does not belong. */
export function raydiumMintOf(r, pool) {
  if (!plain(r) || !pool || r.poolId !== pool) return null;
  return {
    poolId: pool, marketCapUsd: positive(r.marketCap, MAX.mcap), volume24hUsd: nonNegative(r.volumeU, MAX.volume), volume24hPair: nonNegative(r.volumeB, MAX.pair),
    migrateAmmId: isSolanaAddress(r.migrateAmmId) ? r.migrateAmmId : null,
  };
}

const raydiumMints = new Source("raydium_mint", { ttlMs: 60_000 });
/** coins: [{ mint, poolId }] (poolId derived by src/launchlab.js). values: mint -> raydiumMintOf | null | undefined. */
export function raydiumMintFor(coins, fetchImpl = fetch, now = Date.now()) {
  const pools = new Map(coins.filter((c) => isSolanaAddress(c.mint) && c.poolId).map((c) => [c.mint, c.poolId]));
  return raydiumMints.get([...pools.keys()], now, async (want) => {
    const got = new Map();
    for (let i = 0; i < want.length; i += 20) {
      const ids = want.slice(i, i + 20);
      const data = raydiumOk(await getJson(`${RAYDIUM_MINT_URL}?ids=${ids.join(",")}`, fetchImpl));
      for (const r of data.rows.slice(0, 100)) if (plain(r) && ids.includes(r.mint) && !got.has(r.mint)) got.set(r.mint, raydiumMintOf(r, pools.get(r.mint)));
    }
    return got;
  });
}

const TXID = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
/** One trade row, or null: the txid, the owner, the side, both amounts and the time must all be right. Times are unix seconds. */
export function tradeOf(r, pool, { minT = EARLIEST, maxT }) {
  if (!plain(r) || r.poolId !== pool || typeof r.txid !== "string" || !TXID.test(r.txid) || !isSolanaAddress(r.owner)) return null;
  if (r.side !== "buy" && r.side !== "sell") return null;
  const tokens = positive(r.amountA, MAX.tokens), amount = positive(r.amountB, MAX.pair);
  if (tokens == null || amount == null || !Number.isSafeInteger(r.blockTime) || r.blockTime < minT || r.blockTime > maxT) return null;
  return { txid: r.txid, owner: r.owner, at: r.blockTime, side: r.side, tokens, amount };
}

const trades = new Source("raydium_trades", { ttlMs: 30_000 });
/** The latest trades of one pool (newest first): values: pool -> [trade] | null | undefined. */
export function raydiumTradesFor(pool, fetchImpl = fetch, { now = Date.now(), minT = EARLIEST, limit = 20 } = {}) {
  return trades.get([pool], now, async ([p]) => {
    const data = raydiumOk(await getJson(`${RAYDIUM_HISTORY}/trade?poolId=${p}&limit=${limit}`, fetchImpl));
    const maxT = Math.floor(now / 1000) + 60;
    const rows = data.rows.slice(0, 100).map((r) => tradeOf(r, p, { minT, maxT })).filter(Boolean).sort((a, b) => b.at - a.at);
    return new Map([[p, rows]]);
  });
}

/**
 * One kline row as [t, o, h, l, c] (t unix seconds at the bucket's start, prices in the pair token), or null.
 * Raydium's open is the curve's price BEFORE the bucket's first trade (it equals the previous bucket's close in every recorded
 * row) while its high and low cover only the prices after each trade: half the recorded rows have the open outside [low, high].
 * The curve did sit at the open when the bucket began, so the bucket's range is widened to include it: high = max(high, open),
 * low = min(low, open). Exact, nothing estimated. Checked: low <= high and the close inside [low, high].
 */
export function candleOf(r, pool, sec, { minT = EARLIEST, maxT }) {
  if (!plain(r) || r.poolId !== pool || !Number.isSafeInteger(r.t) || r.t % sec !== 0 || r.t < minT - sec || r.t > maxT) return null;
  const o = positive(r.o, MAX.native), h = positive(r.h, MAX.native), l = positive(r.l, MAX.native), c = positive(r.c, MAX.native);
  if (o == null || h == null || l == null || c == null) return null;
  const tol = 1e-9;
  if (l > h * (1 + tol) || c > h * (1 + tol) || c < l * (1 - tol)) return null;
  return [r.t, o, Math.max(h, o), Math.min(l, o), c];
}

/**
 * One page of Raydium's kline for a pool: { rows: [[t,o,h,l,c]] oldest first, nextPageKey, dropped }. Throws a SourceError.
 * Empty rows are "no trades in that span", not an error (the API answers rows: [] for a pool it does not know too).
 */
export async function fetchKline(pool, interval, fetchImpl = fetch, { limit = 10, nextPageKey = null, now = Date.now(), minT = EARLIEST } = {}) {
  const sec = KLINE_INTERVALS[interval];
  if (!sec || !isSolanaAddress(pool)) throw new SourceError("bad_request");
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  const key = nextPageKey && /^[A-Za-z0-9_-]{1,200}$/.test(nextPageKey) ? `&nextPageKey=${nextPageKey}` : "";
  const data = raydiumOk(await getJson(`${RAYDIUM_HISTORY}/kline?poolId=${pool}&interval=${interval}&limit=${n}${key}`, fetchImpl, { timeoutMs: 4_000 }));
  const maxT = Math.floor(now / 1000) + 60;
  const seen = new Map();
  let dropped = 0;
  for (const r of data.rows.slice(0, 600)) { const c = candleOf(r, pool, sec, { minT, maxT }); if (c) seen.set(c[0], c); else dropped++; }
  const next = typeof data.nextPageKey === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(data.nextPageKey) ? data.nextPageKey : null;
  return { rows: [...seen.values()].sort((a, b) => a[0] - b[0]), nextPageKey: data.rows.length ? next : null, dropped };
}

const liveKline = new Source("raydium_kline_1m", { ttlMs: 60_000 });
/** The last hour of 1-minute candles of a pool, kept 60 s: values: pool -> rows | null | undefined. */
export function recentCandles(pool, fetchImpl = fetch, { now = Date.now(), minT = EARLIEST } = {}) {
  return liveKline.get([pool], now, async ([p]) => new Map([[p, (await fetchKline(p, "1m", fetchImpl, { limit: 60, now, minT })).rows]]));
}

// DEX Screener (src/market.js, unchanged) behind the same per-mint memory: 30 s, 5 s of silence after a failure
const dexMarkets = new Source("dexscreener", { ttlMs: 30_000 });
function dexFor(mints, fetchImpl, now) {
  return dexMarkets.get(mints, now, async (want) => {
    const r = await marketFor(want, fetchImpl, { now });
    if (!r.ok) throw new SourceError("dexscreener_failed");
    return r.markets;
  });
}

export const _resetMarketLive = () => { for (const s of [jupPrices, jupTokens, raydiumMints, trades, liveKline, dexMarkets]) s.reset(); };
export const _sources = { jupPrices, jupTokens, raydiumMints, trades, liveKline, dexMarkets };

/* ------------------------------------------------------------------ one market per coin */

/** What the page shows under the numbers (Jupiter's terms ask for "Powered by Jupiter" wherever its data is shown). */
export const ATTRIBUTION = {
  jupiter: { text: "Price, market cap, 24 h volume & change: Jupiter · Powered by Jupiter", url: "https://jup.ag" },
  raydium: { text: "Chart & trades: Raydium LaunchLab", url: "https://raydium.io/launchpad/" },
  raydiumVolume: { text: "Chart, trades & 24 h volume: Raydium LaunchLab", url: "https://raydium.io/launchpad/" },
  chain: { text: "Bonding curve & SOL raised: Solana blockchain, read by vicinity.city", url: null },
  dexscreener: { text: "Pool data after graduation: DEX Screener", url: "https://dexscreener.com" },
  dexscreenerPool: { text: "Pool data: DEX Screener", url: "https://dexscreener.com" },
  holders: { text: "Holders: counted by vicinity.city", url: null },
};
const LABEL = {
  jupiter: "Jupiter", jupiterTrade: "Jupiter (last trade)", dex: "DEX Screener", raydium: "Raydium LaunchLab",
  curve: (s) => `On-chain curve × ${s} price (Jupiter)`, supply: "Price × on-chain supply",
  inCurve: (s) => `${s} in the bonding curve (on-chain) × ${s} price (Jupiter)`, chain: "Solana blockchain, read by vicinity.city",
};

/** The empty market of a coin (every number null), the shape src/launchpad.js puts on a card. */
const blank = () => ({
  priceUsd: null, marketCapUsd: null, fdvUsd: null, liquidityUsd: null, volume24hUsd: null, priceChange24hPct: null, pairAddress: null, dex: null, url: null,
  priceNative: null, nativeSymbol: null, liquidityKind: null, traders24h: null, stage: null, curve: null, sources: {}, missing: {}, stale: false, launchpad: null,
});

/**
 * One coin's market from what each source said. `s` holds, for this coin: curve, jp (its Jupiter price), pairUsd, jt (Jupiter
 * tokens), dx (DEX Screener market), rm (Raydium mint) and for each the state (undefined = could not be asked; curveState
 * undefined = the chain could not be read, null = the chain says there is no LaunchLab pool). `staleOf` says which sources
 * answered from a last good copy. Pure: no network, no clock.
 *
 * The stage comes from the chain, else from Jupiter's or Raydium's graduation record; a DEX Screener pair alone says "pool" only
 * when the chain confirmed there is no LaunchLab curve. DEX Screener's numbers are used only past the curve (graduated, or a coin
 * that never had one): before graduation, or while the chain cannot be read, a pair there can only be someone else's pool, at any
 * price its creator chose, so its market cap, volume, change, liquidity and price are never shown next to the curve's.
 */
export function combine(coin, s, staleOf = {}) {
  const m = blank();
  const used = new Set(), codes = {};
  const take = (field, value, label, src) => { m[field] = value; m.sources[fieldName(field)] = label; codes[fieldName(field)] = src; used.add(src); if (staleOf[src]) m.stale = true; };
  const { curve, jp, jt, rm, pairUsd } = s;
  const chainUnread = !curve && s.curveState === undefined;
  if (curve) {
    m.curve = { poolId: curve.poolId, stage: curve.stage, symbol: curve.symbol, raised: curve.raised, target: curve.target, progressPct: curve.progressPct,
      tokensSold: curve.tokensSold, tokensForSale: curve.tokensForSale, supply: curve.supply, slot: curve.slot };
    m.sources.curve = LABEL.chain; used.add("chain");
    if (curve.stage === "curve") { m.priceNative = curve.priceNative; m.nativeSymbol = curve.symbol; }
  }
  m.stage = curve ? curve.stage : jt?.graduatedPool || rm?.migrateAmmId ? "graduated" : chainUnread ? null : s.dx ? "pool" : null;
  const dexOk = Boolean(s.dx) && (m.stage === "graduated" || m.stage === "migrating" || m.stage === "pool");
  const dx = dexOk ? s.dx : null; // DEX Screener, only where its pool is the coin's market
  if (dx) { m.pairAddress = dx.pairAddress; m.dex = dx.dex; m.url = dx.url; }
  if (curve || jt?.launchlab) m.launchpad = "raydium-launchlab"; // the chain found its LaunchLab pool, or Jupiter says it launched there
  if (!m.url && curve) m.url = `https://raydium.io/launchpad/token/?mint=${coin.mint}`;
  const onCurve = curve && curve.stage === "curve";

  // price: Jupiter's last trade, else the curve's spot × the pair's USD price (exact), else DEX Screener
  if (jp?.usdPrice != null) take("priceUsd", jp.usdPrice, LABEL.jupiterTrade, "jupiter");
  else if (jt?.usdPrice != null) take("priceUsd", jt.usdPrice, LABEL.jupiterTrade, "jupiter");
  else if (onCurve && pairUsd != null) take("priceUsd", curve.priceNative * pairUsd, LABEL.curve(curve.symbol), "jupiter_pair");
  else if (dx?.priceUsd != null) take("priceUsd", dx.priceUsd, LABEL.dex, "dexscreener");

  // market cap and fully diluted value: Jupiter, else DEX Screener, else price × the supply the curve records
  const supply = curve?.supply || jt?.totalSupply || null;
  if (jt?.mcapUsd != null) take("marketCapUsd", jt.mcapUsd, LABEL.jupiter, "jupiter");
  else if (dx?.marketCapUsd != null) take("marketCapUsd", dx.marketCapUsd, LABEL.dex, "dexscreener");
  else if (m.priceUsd != null && supply) take("marketCapUsd", m.priceUsd * supply, LABEL.supply, "computed");
  if (jt?.fdvUsd != null) take("fdvUsd", jt.fdvUsd, LABEL.jupiter, "jupiter");
  else if (dx?.fdvUsd != null) take("fdvUsd", dx.fdvUsd, LABEL.dex, "dexscreener");
  else if (m.priceUsd != null && supply) take("fdvUsd", m.priceUsd * supply, LABEL.supply, "computed");

  // liquidity: on the curve there is no AMM pool, only the pair token the curve holds; after graduation, the pool's
  if (onCurve) {
    m.liquidityKind = "bonding_curve";
    if (pairUsd != null) take("liquidityUsd", curve.raised * pairUsd, LABEL.inCurve(curve.symbol), "jupiter_pair");
  } else if (dx?.liquidityUsd != null) { m.liquidityKind = "pool"; take("liquidityUsd", dx.liquidityUsd, LABEL.dex, "dexscreener"); }
  else if (jp?.liquidityUsd != null && !curve) { m.liquidityKind = m.stage === "graduated" ? "pool" : null; take("liquidityUsd", jp.liquidityUsd, LABEL.jupiter, "jupiter"); }

  // 24 h volume: Jupiter (buy + sell), else Raydium's rolling 24 h, else DEX Screener. Missing is "—", never 0.
  if (jt?.stats24h?.volumeUsd != null) take("volume24hUsd", jt.stats24h.volumeUsd, LABEL.jupiter, "jupiter");
  else if (rm?.volume24hUsd != null) take("volume24hUsd", rm.volume24hUsd, LABEL.raydium, "raydium");
  else if (dx?.volume24hUsd != null) take("volume24hUsd", dx.volume24hUsd, LABEL.dex, "dexscreener");
  if (jt?.stats24h?.traders != null && m.sources.volume24h === LABEL.jupiter) m.traders24h = jt.stats24h.traders;

  // 24 h change: always one source, named (the sources disagree by up to 3 points)
  if (jp?.change24hPct != null) take("priceChange24hPct", jp.change24hPct, LABEL.jupiter, "jupiter");
  else if (jt?.stats24h?.changePct != null) take("priceChange24hPct", jt.stats24h.changePct, LABEL.jupiter, "jupiter");
  else if (dx?.priceChange24hPct != null) take("priceChange24hPct", dx.priceChange24hPct, LABEL.dex, "dexscreener");

  // why a number is "—"
  const jupWhy = s.jpState === undefined ? "Jupiter could not be reached" : "Jupiter has no price for it (no trade in the last 7 days)";
  const chainWhy = chainUnread ? "the chain could not be read" : !curve ? "no LaunchLab curve on the chain" : curve.stage !== "curve" ? "the curve has graduated" : pairUsd == null ? `no ${curve.symbol} price` : null;
  const dexWhy = !s.dxAsked ? null : s.dxState === undefined ? "DEX Screener could not be reached" : !s.dx ? "no DEX Screener pool"
    : dx ? null : onCurve ? "a DEX Screener pool before graduation is not the coin's market" : "DEX Screener is not used while the chain cannot be read";
  const why = (...parts) => parts.filter(Boolean).join("; ");
  if (m.priceUsd == null) m.missing.price = why(jupWhy, chainWhy, dexWhy);
  if (m.marketCapUsd == null) m.missing.marketCap = why("no price to multiply", s.jtState === undefined ? "Jupiter could not be reached" : null);
  if (m.liquidityUsd == null) m.missing.liquidity = onCurve ? `no ${curve.symbol} price` : why(chainWhy, dexWhy) || "no source has it";
  if (m.volume24hUsd == null) m.missing.volume24h = why(s.jtState === undefined ? "Jupiter could not be reached" : "Jupiter has no 24 h trades for it", curve ? (s.rmState === undefined ? "Raydium could not be reached" : "Raydium has no 24 h volume") : null, dexWhy);
  if (m.priceChange24hPct == null) m.missing.change24h = why(jupWhy, dexWhy);
  // which DEX Screener line the sources say: after graduation, or a coin that trades on a DEX pool only
  if (used.has("dexscreener")) used.add(m.stage === "pool" ? "dexscreener_pool" : "dexscreener_graduated");
  Object.defineProperty(m, "codes", { value: { ...codes, used: [...used], chain: chainUnread ? "unreadable" : "read" }, enumerable: false }); // for the job and the caller, never in an answer
  return m;
}
const fieldName = (f) => ({ priceUsd: "price", marketCapUsd: "marketCap", fdvUsd: "fdv", liquidityUsd: "liquidity", volume24hUsd: "volume24h", priceChange24hPct: "change24h" })[f] || f;

/**
 * Markets for allow-listed coins: coins = [{ mint, pairMint }]. Returns { markets: Map(mint -> market), ok, used: Set(source),
 * errors: [short codes], pairPrices: Map(pair mint -> USD | null) }. Each market carries a hidden (not enumerable, so never
 * serialised) `codes` = { price: "jupiter" | "jupiter_pair" | "dexscreener", ..., used: [...] }. ok is false when any source that was asked failed (the caller keeps such an answer only briefly).
 * `dex: false` leaves DEX Screener out. Never throws.
 */
export async function liveMarkets(env, coins, fetchImpl = fetch, { now = Date.now(), dex = true } = {}) {
  const list = [];
  const seen = new Set();
  for (const c of coins) if (c && isSolanaAddress(c.mint) && !seen.has(c.mint)) { seen.add(c.mint); list.push({ mint: c.mint, pairMint: isSolanaAddress(c.pairMint) ? c.pairMint : null }); }
  const markets = new Map();
  if (!list.length) return { markets, ok: true, used: new Set(), errors: [], pairPrices: new Map() };
  const mints = list.map((c) => c.mint);
  const pairs = [...new Set(list.map((c) => c.pairMint).filter(Boolean))];
  const [cv, jp, jt, dx] = await Promise.all([
    readCurves(env, list.filter((c) => c.pairMint), fetchImpl, { now }),
    jupiterPriceFor(env, [...mints, ...pairs.filter((p) => !seen.has(p))], fetchImpl, now),
    jupiterTokensFor(env, mints, fetchImpl, now),
    dex ? dexFor(mints, fetchImpl, now) : Promise.resolve(null),
  ]);
  // Raydium's volume, only for curve coins the others left without one (on the curve DEX Screener's volume is never used: see combine)
  const needRaydium = list.filter((c) => {
    const curve = cv.curves.get(c.mint), t = jt.values.get(c.mint), d = dx?.values.get(c.mint);
    return curve && t?.stats24h?.volumeUsd == null && (curve.stage === "curve" || d?.volume24hUsd == null);
  }).map((c) => ({ mint: c.mint, poolId: cv.curves.get(c.mint).poolId }));
  const rm = needRaydium.length ? await raydiumMintFor(needRaydium, fetchImpl, now) : null;

  const errors = [];
  const note = (name, r) => { if (r && !r.ok) errors.push(`${name}:${r.error || "failed"}`); };
  note("chain", cv); note("jupiter_price", jp); note("jupiter_tokens", jt); note("raydium_mint", rm); note("dexscreener", dx);
  const staleOf = { jupiter: jp.stale || jt.stale, jupiter_pair: jp.stale, chain: cv.stale, raydium: rm?.stale || false, dexscreener: dx?.stale || false };
  const used = new Set();
  for (const c of list) {
    const curve = cv.curves.get(c.mint);
    const m = combine(c, {
      curve: curve || null, curveState: c.pairMint ? curve : null, jp: jp.values.get(c.mint) || null, jpState: jp.values.get(c.mint), // no pair: no LaunchLab pool to read
      pairUsd: c.pairMint ? jp.values.get(c.pairMint)?.usdPrice ?? null : null, jt: jt.values.get(c.mint) || null, jtState: jt.values.get(c.mint),
      dx: dx?.values.get(c.mint) || null, dxState: dx ? dx.values.get(c.mint) : null, dxAsked: Boolean(dx),
      rm: rm?.values.get(c.mint) || null, rmState: rm ? rm.values.get(c.mint) : null,
    }, staleOf);
    for (const u of m.codes.used) used.add(u);
    markets.set(c.mint, m);
  }
  const pairPrices = new Map(pairs.map((p) => [p, jp.values.get(p)?.usdPrice ?? null]));
  return { markets, ok: errors.length === 0, used, errors, pairPrices };
}

/** The attribution lines for the sources an answer used (Jupiter's "Powered by Jupiter" whenever its data is shown). */
export function attributionFor(used, { holders = false, trades = false } = {}) {
  const out = [];
  if (used.has("jupiter") || used.has("jupiter_pair")) out.push(ATTRIBUTION.jupiter);
  if (trades || used.has("raydium")) out.push(used.has("raydium") ? ATTRIBUTION.raydiumVolume : ATTRIBUTION.raydium); // the volume it gave is credited too
  if (used.has("chain")) out.push(ATTRIBUTION.chain);
  if (used.has("dexscreener_graduated") || (used.has("dexscreener") && !used.has("dexscreener_pool"))) out.push(ATTRIBUTION.dexscreener);
  if (used.has("dexscreener_pool")) out.push(ATTRIBUTION.dexscreenerPool);
  if (holders) out.push(ATTRIBUTION.holders);
  return out;
}
