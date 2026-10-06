/**
 * Price history for the Launchpad's coin page (only while LAUNCHPAD_V2=on): what the 10-minute job records, and the chart
 * series GET /api/coin/chart answers from it. Two series, each labelled with where it comes from and what span it covers:
 *
 *   candles  OHLC in the pair token (SOL for $VICINITY), from Raydium LaunchLab's kline: the curve's spot price after each
 *            trade (equal to the chain's to the last digit). Only buckets that had trades exist: a gap is "no trade", never
 *            filled in. The job stores the 15-minute candles (price_candles); the chart serves them as 15 m (24 h), 1 h (7 d),
 *            4 h (30 d) or 1 d, aggregated exactly (open of the first, close of the last, highest high, lowest low). The
 *            1-hour view asks Raydium for 1-minute candles (kept 60 s). After graduation Raydium's kline stops: the stored
 *            candles end there.
 *   line     USD, our own samples (price_samples): every 10 minutes the job keeps the price the page shows (Jupiter's last
 *            trade, else the curve × SOL, else DEX Screener; usd_src says which) and the curve's spot in SOL. It exists from
 *            the first recording on, and only where the job ran: nothing before is ever made up.
 * Retention (the 03:00 UTC run): samples keep every 10 minutes for 30 days, then the last of each hour, after 365 days the
 * last of each day; 15-minute candles older than 30 days are rolled into 4-hour candles (exact) and removed.
 */
import { ensureMarketSchema } from "./store.js";
import { activeMint, launchedAtOf } from "./official.js";
import { PAIRS } from "./coins.js";
import { liveMarkets, fetchKline, recentCandles } from "./marketlive.js";
import { codeOf } from "./sources.js";
import { DAY, iso } from "./policy.js";

const SOL = PAIRS.SOL.mint;
const GRID = 600; // seconds: one sample per coin per 10-minute run
const EARLIEST = Date.parse("2025-01-01T00:00:00Z") / 1000;
const shortErr = (e) => codeOf(e);

/** The coins whose market is recorded: $VICINITY (paired with SOL) and every city coin an admin recorded, nothing else. */
export async function allowListedCoins(env) {
  const out = [];
  const vic = activeMint(env);
  if (vic) out.push({ mint: vic, pairMint: SOL, launchedAt: launchedAtOf(vic) });
  const rows = (await env.DB.prepare("SELECT mint, pair, launched_at FROM city_coins WHERE mint IS NOT NULL ORDER BY launched_at, city_id LIMIT 10000").all()).results;
  for (const r of rows) if (r.mint !== vic && PAIRS[r.pair]) out.push({ mint: r.mint, pairMint: PAIRS[r.pair].mint, launchedAt: null });
  return out;
}

/** The earliest time a row of this coin can have (unix seconds): its launch for $VICINITY, else the start of 2025. */
export const minTimeOf = (coin) => (coin && coin.launchedAt && Number.isFinite(Date.parse(coin.launchedAt)) ? Math.floor(Date.parse(coin.launchedAt) / 1000) : EARLIEST);

async function batched(db, stmts) { for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50)); }

const UPSERT_CANDLE = `INSERT INTO price_candles (mint, tf, t, o, h, l, c, src) VALUES (?, ?, ?, ?, ?, ?, ?, 'raydium')
  ON CONFLICT(mint, tf, t) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c`;

/**
 * Read one coin's 15-minute candles into price_candles. First time (or a new pool): everything since launch, page after page
 * (at most `backfillPages` pages of 500). After that: the newest 10, and more pages only when there is a gap since the last
 * stored candle (the job missed some runs). Returns how many rows were written. Throws a short-coded error.
 */
async function ingestCandles(env, coin, pool, meta, fetchImpl, now, { backfillPages = 20 } = {}) {
  const db = env.DB;
  const backfill = !meta || !meta.backfilled_at || meta.pool !== pool;
  const last = backfill ? null : (await db.prepare("SELECT MAX(t) AS t FROM price_candles WHERE mint = ? AND tf = '15m'").bind(coin.mint).first())?.t ?? null;
  const rows = new Map();
  let key = null, pages = 0;
  for (;;) {
    const page = await fetchKline(pool, "15m", fetchImpl, { limit: backfill ? 500 : pages ? 100 : 10, nextPageKey: key, now, minT: minTimeOf(coin) });
    pages++;
    for (const r of page.rows) rows.set(r[0], r);
    key = page.nextPageKey;
    if (!key || !page.rows.length) break;
    if (!backfill && (last == null || page.rows[0][0] <= last)) break;
    if (pages >= (backfill ? backfillPages : 5)) break;
  }
  await batched(db, [...rows.values()].map(([t, o, h, l, c]) => db.prepare(UPSERT_CANDLE).bind(coin.mint, "15m", t, o, h, l, c)));
  return { rows: rows.size, backfill, pages };
}

/**
 * The job's "market" step: one sample per allow-listed coin (a coin no source could price is simply not sampled: a gap), then
 * the candles of at most `klineMax` LaunchLab coins (those read longest ago first), then, in the 03:00 UTC run, the pruning.
 * Zero calls while nothing is launched.
 */
export async function recordMarket(env, now = Date.now(), fetchImpl = fetch, { klineMax = 10, backfillPages = 20 } = {}) {
  const db = env.DB;
  await ensureMarketSchema(db);
  const coins = await allowListedCoins(env);
  const out = { coins: coins.length, sampled: 0, candles: 0, klineCoins: 0, failed: 0 };
  if (!coins.length) return out;
  // DEX Screener is left out: Jupiter prices a graduated coin too, and the samples need nothing else from it
  const live = await liveMarkets(env, coins, fetchImpl, { now, dex: false });
  if (!live.ok) out.sources = live.errors;
  const at = Math.floor(now / 1000 / GRID) * GRID;
  const stmts = [];
  for (const c of coins) {
    const m = live.markets.get(c.mint);
    if (!m || (m.priceUsd == null && m.priceNative == null)) continue;
    stmts.push(db.prepare(`INSERT INTO price_samples (mint, at, slot, stage, price_native, pair_usd, price_usd, usd_src, raised) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mint, at) DO UPDATE SET slot = excluded.slot, stage = excluded.stage, price_native = excluded.price_native, pair_usd = excluded.pair_usd,
      price_usd = excluded.price_usd, usd_src = excluded.usd_src, raised = excluded.raised`)
      .bind(c.mint, at, m.curve?.slot ?? null, m.stage, m.priceNative, live.pairPrices.get(c.pairMint) ?? null, m.priceUsd, m.priceUsd == null ? null : m.codes.price || null, m.curve ? m.curve.raised : null));
  }
  await batched(db, stmts);
  out.sampled = stmts.length;

  // candles: only coins whose LaunchLab pool the chain confirmed; after graduation one last read, then never again
  const metas = new Map((await db.prepare("SELECT mint, pool, backfilled_at, kline_at, graduated_at FROM market_meta").all()).results.map((r) => [r.mint, r]));
  const due = coins.filter((c) => live.markets.get(c.mint)?.curve)
    .filter((c) => { const mt = metas.get(c.mint); return !(mt && mt.graduated_at && mt.kline_at && mt.kline_at >= mt.graduated_at); })
    .sort((a, b) => (metas.get(a.mint)?.kline_at || "").localeCompare(metas.get(b.mint)?.kline_at || ""))
    .slice(0, klineMax);
  for (const c of due) {
    const curve = live.markets.get(c.mint).curve;
    const meta = metas.get(c.mint) || null;
    try {
      const r = await ingestCandles(env, c, curve.poolId, meta, fetchImpl, now, { backfillPages });
      out.candles += r.rows; out.klineCoins++;
      const graduatedAt = curve.stage !== "curve" ? meta?.graduated_at || iso(now) : null;
      await db.prepare(`INSERT INTO market_meta (mint, pool, backfilled_at, kline_at, graduated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(mint) DO UPDATE SET pool = excluded.pool, backfilled_at = COALESCE(excluded.backfilled_at, market_meta.backfilled_at), kline_at = excluded.kline_at, graduated_at = excluded.graduated_at`)
        .bind(c.mint, curve.poolId, r.backfill ? iso(now) : null, iso(now), graduatedAt).run();
    } catch (e) {
      out.failed++;
      console.error("market candles skipped one coin", shortErr(e)); // letters and digits only, never an address
    }
  }
  const d = new Date(now);
  if (d.getUTCHours() === 3 && d.getUTCMinutes() < 10) out.pruned = await pruneMarket(env, now);
  return out;
}

/** Retention (see the top of this file). Returns how many rows went. */
export async function pruneMarket(env, now = Date.now()) {
  const db = env.DB;
  await ensureMarketSchema(db);
  const s = Math.floor(now / 1000);
  const hourly = s - 30 * 86400, daily = s - 365 * 86400;
  const thin = (cut, per) => db.prepare(`DELETE FROM price_samples WHERE at < ?1 AND (mint, at) NOT IN
    (SELECT mint, MAX(at) FROM price_samples WHERE at < ?1 GROUP BY mint, at / ${per})`).bind(cut).run();
  const a = await thin(hourly, 3600), b = await thin(daily, 86400);
  // 15-minute candles older than 30 days become 4-hour candles: whole 4-hour buckets only, so every bucket is rolled once
  const cut = Math.floor(hourly / 14400) * 14400;
  const old = (await db.prepare("SELECT mint, t, o, h, l, c FROM price_candles WHERE tf = '15m' AND t < ? ORDER BY mint, t LIMIT 50000").bind(cut).all()).results;
  const rolled = [];
  for (const [mint, rows] of groupBy(old, (r) => r.mint)) for (const k of aggregate(rows.map((r) => [r.t, r.o, r.h, r.l, r.c]), 14400)) rolled.push([mint, ...k]);
  await batched(db, rolled.map(([mint, t, o, h, l, c]) => db.prepare(`INSERT INTO price_candles (mint, tf, t, o, h, l, c, src) VALUES (?, '4h', ?, ?, ?, ?, ?, 'raydium')
    ON CONFLICT(mint, tf, t) DO UPDATE SET h = MAX(price_candles.h, excluded.h), l = MIN(price_candles.l, excluded.l), c = excluded.c`).bind(mint, t, o, h, l, c)));
  const last = old.length ? old[old.length - 1] : null;
  const gone = old.length ? await db.prepare("DELETE FROM price_candles WHERE tf = '15m' AND t < ?").bind(old.length >= 50000 ? Math.floor(last.t / 14400) * 14400 : cut).run() : null;
  return { samples: (a.meta?.changes || 0) + (b.meta?.changes || 0), candles: gone?.meta?.changes || 0, rolled: rolled.length };
}

function groupBy(list, key) { const m = new Map(); for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }

/**
 * Exact aggregation of candles [[t,o,h,l,c]] (oldest first, each bucket no wider than `sec`) into buckets of `sec` seconds:
 * the open of the first, the highest high, the lowest low, the close of the last. A bucket with no candle has no row.
 */
export function aggregate(rows, sec) {
  const out = [];
  for (const [t, o, h, l, c] of rows) {
    const b = Math.floor(t / sec) * sec;
    const cur = out[out.length - 1];
    if (cur && cur[0] === b) { cur[2] = Math.max(cur[2], h); cur[3] = Math.min(cur[3], l); cur[4] = c; }
    else out.push([b, o, h, l, c]);
  }
  return out;
}

/** The last point of each bucket of `sec` seconds (points oldest first, [t, ...]). */
export function lastPerBucket(points, sec) {
  if (sec <= GRID) return points;
  const out = [];
  for (const p of points) {
    const b = Math.floor(p[0] / sec) * sec;
    if (out.length && Math.floor(out[out.length - 1][0] / sec) * sec === b) out[out.length - 1] = p; else out.push(p);
  }
  return out;
}

export const CHART_TFS = ["1h", "24h", "7d", "30d", "all"];
const SPAN = { "1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };
const STEP = { "1h": 60, "24h": 900, "7d": 3600, "30d": 14400 };
const NAME = { 60: "1m", 600: "10m", 900: "15m", 3600: "1h", 14400: "4h", 86400: "1d" };
/** For "all": a step that keeps the series between a few dozen and a few hundred points. */
const stepFor = (spanSec) => (spanSec <= 2 * 86400 ? 900 : spanSec <= 14 * 86400 ? 3600 : spanSec <= 90 * 86400 ? 14400 : 86400);
const SRC = { jupiter: "j", jupiter_pair: "c", dexscreener: "d" };

/**
 * The chart answer of one allow-listed coin: { ok, mint, tf, asOf, candles, line, missing }.
 *   candles  { unit, interval, source, rows: [[t,o,h,l,c]], from, to } (t unix seconds) or null
 *   line     { unit: "USD", interval, source, rule, points: [[t, usd | null, "j" | "c" | "d" | null, native | null]], from, to,
 *            recordingSince } or null.  j = Jupiter (last trade), c = on-chain curve × pair price (Jupiter), d = DEX Screener.
 *   missing  { candles?, line? }: why a series is empty.
 */
export async function chartFor(env, coin, tf, fetchImpl = fetch, now = Date.now()) {
  const db = env.DB;
  await ensureMarketSchema(db);
  const nowS = Math.floor(now / 1000);
  const meta = await db.prepare("SELECT pool, graduated_at, backfilled_at FROM market_meta WHERE mint = ?").bind(coin.mint).first();
  const symbol = Object.keys(PAIRS).find((k) => PAIRS[k].mint === coin.pairMint) || null;
  const missing = {};
  const range = async (table, col) => (await db.prepare(`SELECT MIN(${col}) AS a FROM ${table} WHERE mint = ?`).bind(coin.mint).first())?.a ?? null;

  // ---- candles (pair token) ----
  let candles = null;
  const firstCandle = await range("price_candles", "t");
  const span = tf === "all" ? (firstCandle == null ? 0 : nowS - firstCandle) : SPAN[tf];
  const step = tf === "all" ? stepFor(span) : STEP[tf];
  const since = tf === "all" ? 0 : nowS - SPAN[tf];
  let rows = null, interval = NAME[step], note = null;
  if (tf === "1h" && meta?.pool && !meta.graduated_at) {
    const r = await recentCandles(meta.pool, fetchImpl, { now, minT: minTimeOf(coin) });
    if (Array.isArray(r.values.get(meta.pool))) rows = r.values.get(meta.pool).filter((x) => x[0] >= since);
    else note = "Raydium's 1-minute candles could not be read: 15-minute candles from vicinity.city's copy";
  }
  if (rows == null) {
    const s = tf === "1h" ? 900 : step;
    const from = Math.floor(since / s) * s; // the first bucket that overlaps the range
    const stored = (await db.prepare("SELECT t, o, h, l, c FROM price_candles WHERE mint = ? AND t >= ? ORDER BY t, tf").bind(coin.mint, from).all()).results;
    rows = aggregate(stored.map((r) => [r.t, r.o, r.h, r.l, r.c]), s);
    interval = NAME[s];
  }
  if (meta?.pool || rows.length) {
    candles = { unit: symbol, interval, source: "Raydium LaunchLab", rows, from: rows.length ? iso(rows[0][0] * 1000) : null, to: rows.length ? iso(rows[rows.length - 1][0] * 1000) : null };
    if (note) candles.note = note;
    if (meta?.graduated_at) candles.note = `Raydium's candles end at graduation (seen by vicinity.city ${meta.graduated_at.slice(0, 10)})`;
    if (!rows.length) missing.candles = firstCandle == null ? (meta?.backfilled_at ? "No trades recorded by Raydium yet" : "Not recorded yet: the first reading runs within 10 minutes") : "No trades in this range";
  } else missing.candles = "No candles recorded: every 10 minutes vicinity.city reads Raydium's candles of each coin on a LaunchLab curve";

  // ---- line (USD, our samples) ----
  const firstSample = await range("price_samples", "at");
  const lspan = tf === "all" ? (firstSample == null ? 0 : nowS - firstSample) : SPAN[tf];
  const lstep = tf === "1h" || tf === "24h" ? GRID : tf !== "all" ? STEP[tf] : stepFor(lspan) === 900 ? GRID : stepFor(lspan);
  const samples = (await db.prepare("SELECT at, price_usd, usd_src, price_native FROM price_samples WHERE mint = ? AND at >= ? ORDER BY at").bind(coin.mint, since).all()).results
    .map((r) => [r.at, r.price_usd ?? null, r.price_usd == null ? null : SRC[r.usd_src] || null, r.price_native ?? null]);
  const points = lastPerBucket(samples, lstep);
  const line = {
    unit: "USD", interval: NAME[lstep], source: "vicinity.city samples",
    rule: `Jupiter's price (last trade) every 10 minutes; the on-chain curve × ${symbol || "pair"} price (Jupiter) where Jupiter had none`,
    points, from: points.length ? iso(points[0][0] * 1000) : null, to: points.length ? iso(points[points.length - 1][0] * 1000) : null,
    recordingSince: firstSample == null ? null : iso(firstSample * 1000),
  };
  if (!points.length) missing.line = firstSample == null ? "Not recorded yet: vicinity.city samples the price every 10 minutes from its first run on" : "No sample in this range";
  return { ok: true, mint: coin.mint, tf, asOf: iso(now), candles, line, missing };
}

/** What our samples say about the last 24 hours, in the pair token (null until 24 hours of samples exist). */
export async function samplesSummary(env, coin, now = Date.now()) {
  const db = env.DB;
  await ensureMarketSchema(db);
  const nowS = Math.floor(now / 1000);
  const first = await db.prepare("SELECT MIN(at) AS a FROM price_samples WHERE mint = ?").bind(coin.mint).first();
  if (first?.a == null) return { since: null, change24hNativePct: null, source: "vicinity.city samples" };
  const latest = await db.prepare("SELECT at, price_native FROM price_samples WHERE mint = ? AND price_native IS NOT NULL ORDER BY at DESC LIMIT 1").bind(coin.mint).first();
  const dayAgo = await db.prepare("SELECT at, price_native FROM price_samples WHERE mint = ? AND price_native IS NOT NULL AND at <= ? ORDER BY at DESC LIMIT 1").bind(coin.mint, nowS - 86400).first();
  const fresh = latest && nowS - latest.at <= 3 * GRID && dayAgo && latest.at - dayAgo.at <= 86400 + 3 * GRID && dayAgo.price_native > 0;
  return { since: iso(first.a * 1000), change24hNativePct: fresh ? ((latest.price_native - dayAgo.price_native) / dayAgo.price_native) * 100 : null, source: "vicinity.city samples" };
}

export const _DAY = DAY;
