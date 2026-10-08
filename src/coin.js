/**
 * The Launchpad's coin page data (only while LAUNCHPAD_V2=on; src/index.js answers 404 not_enabled otherwise):
 *   GET /api/coin?mint=<mint>                         facts, live market, holders, recent trades, links, sources
 *   GET /api/coin/chart?mint=<mint>&tf=1h|24h|7d|30d|all   price series (src/pricehistory.js)
 * The mint must be allow-listed: $VICINITY (the VICINITY_MINT setting) or a city coin an admin recorded. Anything else is
 * 404 unknown_coin BEFORE any outside call: an unknown mint never leaves the Worker. Both routes are public, edge-cached
 * (src/index.js cached()) and counted by the public limiter on a cache miss (src/guards.js).
 * Every number carries its source; a missing one carries a reason (market.missing). Nothing is estimated.
 */
import { json } from "./http.js";
import { activeMint, launchedAtOf } from "./official.js";
import { PAIRS, coinOf, coinView } from "./coins.js";
import { getTokenFacts } from "./chain.js";
import { tickerOf } from "./tickers.js";
import { ensureLaunchpadSchema, ensureSchema } from "./store.js";
import { tradeLinks } from "./launchpad.js";
import { attributionFor, liveMarkets, maskWallet, raydiumTradesFor } from "./marketlive.js";
import { chartFor, minTimeOf, samplesSummary } from "./pricehistory.js";
import { codeOf } from "./sources.js";
import { poolAddress } from "./launchlab.js";
import { isSolanaAddress } from "./solana.js";
import { iso } from "./policy.js";

const SOL = PAIRS.SOL.mint;
const MEMO_MS = 30_000, DEGRADED_MS = 5_000, FACTS_MS = 5 * 60_000;

/** The coin behind an allow-listed mint, or null. Reads the database only (never the network). */
export async function allowListed(env, mint) {
  if (!isSolanaAddress(mint)) return null;
  const vic = activeMint(env);
  if (vic && mint === vic) {
    return { kind: "vicinity", mint, pairMint: SOL, pair: "SOL", ticker: "VICINITY", name: "Vicinity", launchedAt: launchedAtOf(mint), city: null, color: "gold", logo: null };
  }
  await ensureSchema(env.DB);
  const row = await env.DB.prepare("SELECT city_id FROM city_coins WHERE mint = ?").bind(mint).first();
  if (!row) return null;
  const v = coinView(await coinOf(env.DB, row.city_id));
  if (!v || v.mint !== mint || !v.pairMint) return null;
  return { kind: "city", mint, pairMint: v.pairMint, pair: v.pair, ticker: (await tickerOf(env, v.city))?.ticker || null, name: v.name, launchedAt: v.launchedAt,
    city: { id: String(v.city), name: v.cityName, country: v.country }, color: v.color, logo: v.logo };
}

const facts = new Map(); // mint -> { at, value | null, failedAt }
async function factsOf(env, mint, fetchImpl, now) {
  const hit = facts.get(mint);
  if (hit && (hit.value ? now - hit.at < FACTS_MS : now - hit.at < DEGRADED_MS)) return hit.value;
  let value = null;
  try {
    const f = await getTokenFacts(env, mint, fetchImpl);
    value = { supply: Number.isFinite(f.supply) ? f.supply : null, decimals: Number.isInteger(f.decimals) ? f.decimals : null, program: f.program,
      mintingDisabled: Boolean(f.mintingDisabled), freezingDisabled: Boolean(f.freezingDisabled), mintHeldByProgram: Boolean(f.mintHeldByProgram) };
  } catch (e) { console.error("coin facts unavailable", codeOf(e)); }
  facts.set(mint, { at: now, value });
  if (facts.size > 2_000) facts.delete(facts.keys().next().value);
  return value;
}

let memos = new WeakMap(); // env.DB -> Map(mint -> { at, ttl, promise }): one build per coin per server per 30 seconds (5 when something failed)
export const _resetCoin = () => { memos = new WeakMap(); facts.clear(); };

async function build(env, coin, fetchImpl, now) {
  const live = await liveMarkets(env, [coin], fetchImpl, { now });
  const market = live.markets.get(coin.mint);
  let holders = null, holdersOk = true;
  try {
    await ensureLaunchpadSchema(env.DB);
    const r = await env.DB.prepare("SELECT holders, updated_at FROM coin_stats WHERE mint = ?").bind(coin.mint).first();
    if (r && r.holders != null) holders = { count: Number(r.holders), asOf: r.updated_at, source: "Counted by vicinity.city (pools and team wallets excluded)" };
  } catch (e) { holdersOk = false; console.error("coin holders unavailable", codeOf(e)); }
  const f = await factsOf(env, coin.mint, fetchImpl, now);

  // recent trades: Raydium LaunchLab's own list for the pool the chain confirmed (none after graduation: the curve is closed). When
  // the chain could not be read, the pool's address is still known (pure math from the mint and its pair), so Raydium is asked anyway
  let trades;
  const unread = !market.curve && market.codes?.chain === "unreadable" && market.stage == null;
  const guessed = unread ? await poolAddress(coin.mint, coin.pairMint) : null;
  const pool = market.curve?.poolId || guessed;
  if (pool) {
    const r = await raydiumTradesFor(pool, fetchImpl, { now, minT: minTimeOf(coin) });
    const list = r.values.get(pool);
    const symbol = market.curve?.symbol || coin.pair || "SOL";
    trades = { source: "Raydium LaunchLab", rows: Array.isArray(list) ? list.map((t) => ({ txid: t.txid, at: iso(t.at * 1000), side: t.side, tokens: t.tokens,
      amount: t.amount, symbol, wallet: maskWallet(t.owner), url: `https://solscan.io/tx/${t.txid}` })) : [] };
    if (!Array.isArray(list)) trades.missing = guessed ? "The chain could not be read, and Raydium could not be reached" : "Raydium could not be reached";
    else if (!list.length) trades.missing = guessed ? "The chain could not be read, and Raydium lists no trades for this coin's LaunchLab pool" : "No trades yet";
    if (market.curve && market.curve.stage !== "curve") trades.note = "Trades on the bonding curve, before graduation";
    if (r.stale) trades.stale = true;
    if (!r.ok) live.ok = false;
  } else trades = { source: null, rows: [], missing: market.stage === "graduated" || market.stage === "migrating" ? "Trades after graduation are on the AMM pool: see DEX Screener"
    : market.stage === "pool" ? "Its trades are on its DEX pool: see DEX Screener" : "No LaunchLab curve known for this coin" };

  let samples = null;
  try { samples = await samplesSummary(env, coin, now); } catch (e) { console.error("coin samples unavailable", codeOf(e)); }

  const links = tradeLinks(coin.mint, coin.pairMint);
  if (market.stage === "curve" || (!market.pairAddress && market.stage !== "pool")) links.dexscreener = null; // DEX Screener lists nothing before migration
  if (market.curve?.poolId || (guessed && trades.rows.length)) links.pool = `https://solscan.io/account/${pool}`; // a pool the chain or Raydium knows
  const body = {
    ok: true, asOf: iso(now), mint: coin.mint,
    coin: { kind: coin.kind, ticker: coin.ticker, name: coin.name, city: coin.city, pair: { symbol: coin.pair, mint: coin.pairMint }, launchedAt: coin.launchedAt, color: coin.color, logo: coin.logo },
    facts: f ? { ...f, source: "Solana blockchain, read by vicinity.city" } : null,
    market, holders, trades, samples, links,
    attribution: attributionFor(live.used, { holders: Boolean(holders), trades: Boolean(pool) }),
  };
  if (!f) body.missing = { facts: "The chain could not be read" };
  return { body, degraded: !live.ok || !holdersOk || !f };
}

/** GET /api/coin?mint= (the route has checked the switch, the method, the database and the mint's shape). */
export async function handleCoin(env, mint, fetchImpl = fetch, now = Date.now()) {
  const coin = await allowListed(env, mint);
  if (!coin) return json({ ok: false, error: "unknown_coin" }, 404);
  if (!memos.has(env.DB)) memos.set(env.DB, new Map());
  const memo = memos.get(env.DB);
  let m = memo.get(mint);
  if (!m || now - m.at >= m.ttl || now < m.at) {
    m = { at: now, ttl: MEMO_MS, promise: null };
    m.promise = build(env, coin, fetchImpl, now).then((r) => { if (r.degraded) m.ttl = DEGRADED_MS; return r; });
    m.promise.catch(() => { if (memo.get(mint) === m) memo.delete(mint); });
    memo.set(mint, m);
    if (memo.size > 500) memo.delete(memo.keys().next().value);
  }
  try {
    const { body, degraded } = await m.promise;
    return json(body, 200, { "Cache-Control": `public, max-age=${degraded ? DEGRADED_MS / 1000 : MEMO_MS / 1000}` });
  } catch (e) {
    console.error("coin page failed", codeOf(e));
    return json({ ok: false, error: "coin_unavailable" }, 503);
  }
}

export const CHART_TTL = { "1h": 60, "24h": 60, "7d": 300, "30d": 300, all: 300 };

/** GET /api/coin/chart?mint=&tf= (the route has checked the switch, the method, the database, the mint and tf). */
export async function handleCoinChart(env, mint, tf, fetchImpl = fetch, now = Date.now()) {
  const coin = await allowListed(env, mint);
  if (!coin) return json({ ok: false, error: "unknown_coin" }, 404);
  try {
    const body = await chartFor(env, coin, tf, fetchImpl, now);
    const short = body.candles?.note && /could not be read/.test(body.candles.note);
    return json(body, 200, { "Cache-Control": `public, max-age=${short ? 10 : CHART_TTL[tf]}` });
  } catch (e) {
    console.error("coin chart failed", codeOf(e));
    return json({ ok: false, error: "chart_unavailable" }, 503);
  }
}
