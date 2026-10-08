// GET /api/coin and GET /api/coin/chart (LAUNCHPAD_V2=on), the job's "market" step (one price sample per coin every 10 minutes,
// Raydium LaunchLab's 15-minute candles, the 03:00 pruning) and the Launchpad list's market fields, against a fake outside world
// built from the REAL answers recorded on 6 Oct 2026 (test/helpers/market.js). No test touches the network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { IN_UTICA, MINT, browser, clock, newWorld, person, realClock, useClock } from "./helpers/world.js";
import { CITY_COIN, LP, fakeCaches, mintNo, seedCoin } from "./helpers/launchpad.js";
import { SOL, fixture, marketWorld, poolAccount } from "./helpers/market.js";
import { spyDb, schemaOf } from "./helpers/profiles.js";
import { _resetLaunchpad } from "../src/launchpad.js";
import { _resetMarket } from "../src/market.js";
import { _resetCoin } from "../src/coin.js";
import { poolAddress } from "../src/launchlab.js";
import { aggregate, lastPerBucket, pruneMarket, recordMarket } from "../src/pricehistory.js";
import { runJobs } from "../src/jobs.js";
import { MARKET_MIGRATION, MIGRATIONS } from "../src/store.js";

const NOW = "2026-10-06T16:00:00Z"; // 11 hours after the last recorded trade (04:43:31 UTC)
beforeEach(() => { useClock(NOW); _resetLaunchpad(); _resetMarket(); _resetCoin(); });
after(() => realClock());

const POOL = await poolAddress(MINT, SOL);
const SOL_USD = fixture("jup_price.json")[SOL].usdPrice;
const JUP_PRICE = 0.000007577217833193381;
const nowS = () => Math.floor(clock.now / 1000);
const quiet = async (fn) => { const e = console.error; const logged = []; console.error = (...a) => logged.push(a.join(" ")); try { return { value: await fn(), logged }; } finally { console.error = e; } };
/** Raydium's recorded 15-minute rows as the chart serves them: oldest first, the open inside the range (src/marketlive.js candleOf). */
const recorded15 = () => fixture("kline_15m.json").data.rows.map((r) => [r.t, r.o, Math.max(r.h, r.o), Math.min(r.l, r.o), r.c]).sort((a, b) => a[0] - b[0]);
const rows = async (env, sql, ...p) => (await env.DB.prepare(sql).bind(...p).all()).results;

/* ------------------------------------------------------------------ the switch, the shapes, the allow-list */

test("switch off: both routes are 404 not_enabled before anything else, no outside call, no new table; the job has no market step", async () => {
  const env = newWorld({ VICINITY_MINT: MINT });
  env.DB = spyDb(env.DB);
  const w = await marketWorld(MINT);
  const b = browser(env);
  for (const path of [`/api/coin?mint=${MINT}`, `/api/coin/chart?mint=${MINT}&tf=24h`, "/api/coin?mint=bad", "/api/coin/chart"]) {
    for (const method of ["GET", "POST"]) {
      const r = await b.send(path, { method, fetchImpl: w.fetchImpl, body: method === "POST" ? {} : undefined });
      assert.deepEqual([r.status, await r.json()], [404, { ok: false, error: "not_enabled" }], `${method} ${path}`);
    }
  }
  assert.deepEqual(w.log, []);
  const out = await runJobs(env, clock.now, w.fetchImpl, () => 0.99);
  assert.ok(!("market" in out));
  assert.ok(!env.DB.log.some((x) => /price_samples|price_candles|market_meta/i.test(x.sql)));
  assert.ok(!(await schemaOf(env.DB)).tables.some((t) => /^price_|^market_meta$/.test(t)));
  assert.ok(!MIGRATIONS.some((m) => m.id === MARKET_MIGRATION.id), "never part of the migrations every request runs");
});

test("switch on: a bad mint is 400, a bad tf 400, another method 405; an unknown or still-waiting mint is 404 unknown_coin and NEVER leaves the Worker", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const PENDING = mintNo(7); // a real-looking contract still waiting for an admin's check: not allow-listed
  await seedCoin(env.DB, { city: 5140405, name: "Syracuse", pending: PENDING });
  const w = await marketWorld(MINT);
  const b = browser(env);
  const get = async (p) => { const r = await b.send(p, { fetchImpl: w.fetchImpl }); return [r.status, await r.json()]; };
  assert.deepEqual(await get("/api/coin"), [400, { ok: false, error: "bad_mint" }]);
  assert.deepEqual(await get("/api/coin?mint=<script>"), [400, { ok: false, error: "bad_mint" }]);
  assert.deepEqual(await get(`/api/coin/chart?mint=${MINT}&tf=1y`), [400, { ok: false, error: "bad_tf" }]);
  assert.deepEqual(await get(`/api/coin/chart?mint=${MINT}&tf=1h%00`), [400, { ok: false, error: "bad_tf" }]);
  for (const m of [CITY_COIN, PENDING, SOL]) {
    assert.deepEqual(await get(`/api/coin?mint=${m}`), [404, { ok: false, error: "unknown_coin" }], m);
    assert.deepEqual(await get(`/api/coin/chart?mint=${m}&tf=24h`), [404, { ok: false, error: "unknown_coin" }], m);
  }
  assert.deepEqual(w.log, [], "not one outside call for a mint that is not allow-listed");
  const post = await b.send(`/api/coin?mint=${MINT}`, { method: "POST", body: {}, fetchImpl: w.fetchImpl });
  assert.deepEqual([post.status, await post.json()], [405, { error: "method_not_allowed" }]);
  assert.equal((await get("/api/coin/chart?mint=" + MINT))[0], 200, "tf defaults to 24h");
});

/* ------------------------------------------------------------------ GET /api/coin */

test("GET /api/coin for $VICINITY: facts, the live market with a source per number, our holder count, Raydium's trades with masked wallets, links, attribution", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const w = await marketWorld(MINT);
  await env.DB.prepare("SELECT 1").first();
  await browser(env).send("/api/launchpad", { fetchImpl: w.fetchImpl }); // makes coin_stats
  await env.DB.prepare("INSERT INTO coin_stats (mint, holders, updated_at) VALUES (?, 37, '2026-10-06T15:50:00.000Z')").bind(MINT).run();
  _resetLaunchpad();
  const res = await browser(env).send(`/api/coin?mint=${MINT}`, { fetchImpl: w.fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=30");
  const text = await res.text(), d = JSON.parse(text);
  assert.deepEqual(Object.keys(d), ["ok", "asOf", "mint", "coin", "facts", "market", "holders", "trades", "samples", "links", "attribution"]);
  assert.deepEqual(d.coin, { kind: "vicinity", ticker: "VICINITY", name: "Vicinity", city: null, pair: { symbol: "SOL", mint: SOL }, launchedAt: null, color: "gold", logo: null });
  assert.deepEqual(d.facts, { supply: 1e9, decimals: 6, program: "SPL Token", mintingDisabled: true, freezingDisabled: true, mintHeldByProgram: false, source: "Solana blockchain, read by vicinity.city" });
  const m = d.market;
  assert.deepEqual([m.priceUsd, m.marketCapUsd, m.volume24hUsd, m.priceChange24hPct, m.traders24h], [JUP_PRICE, 7577.217833193381, 221.02457715972727 + 315.17594188232897, -0.7440200264703254, 18]);
  assert.equal(m.liquidityUsd, 14.795544124 * SOL_USD);
  assert.deepEqual([m.stage, m.liquidityKind, m.curve.raised, m.curve.target, m.curve.progressPct.toFixed(4), m.priceNative], ["curve", "bonding_curve", 14.795544124, 85, "17.4065", 6.233650881956076e-8]);
  assert.deepEqual(d.holders, { count: 37, asOf: "2026-10-06T15:50:00.000Z", source: "Counted by vicinity.city (pools and team wallets excluded)" });
  assert.equal(d.trades.source, "Raydium LaunchLab");
  assert.equal(d.trades.rows.length, 20);
  const t0 = fixture("trade.json").data.rows[0];
  assert.deepEqual(d.trades.rows[0], { txid: t0.txid, at: "2026-10-06T04:43:31.000Z", side: "buy", tokens: 158764.265017, amount: 0.009999621, symbol: "SOL",
    wallet: `${t0.owner.slice(0, 5)}*****${t0.owner.slice(-3)}`, url: `https://solscan.io/tx/${t0.txid}` });
  for (const t of fixture("trade.json").data.rows) assert.ok(!text.includes(t.owner), "no trader's full wallet anywhere in the answer");
  assert.deepEqual(d.links, { raydium: `https://raydium.io/launchpad/token/?mint=${MINT}`, jupiter: `https://jup.ag/swap/SOL-${MINT}`, dexscreener: null,
    solscan: `https://solscan.io/token/${MINT}`, pool: `https://solscan.io/account/${POOL}` }, "no DEX Screener link while it lists nothing");
  assert.deepEqual(d.attribution.map((a) => a.text), ["Price, market cap, 24 h volume & change: Jupiter · Powered by Jupiter", "Chart & trades: Raydium LaunchLab",
    "Bonding curve & SOL raised: Solana blockchain, read by vicinity.city", "Holders: counted by vicinity.city"]);
  assert.deepEqual(d.samples, { since: null, change24hNativePct: null, source: "vicinity.city samples" });
  // one build per 30 s per server: a second viewer costs nothing outside
  const n = w.log.length;
  await browser(env).send(`/api/coin?mint=${MINT}`, { fetchImpl: w.fetchImpl });
  assert.equal(w.log.length, n);
});

test("GET /api/coin for a recorded city coin, and when sources fail: a dash with a reason per number, the answer kept 5 seconds only", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const f = await person(env, { home: IN_UTICA, holds: 10 });
  const u = await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(f.w.address).first();
  await seedCoin(env.DB, { city: 5142056, name: "Utica", coin: "Utica Coin", mint: CITY_COIN, pair: "SOL", color: "emerald", launchedAt: "2026-10-05T10:00:00.000Z", user: u.id });
  const w = await marketWorld(MINT, { jup: { mode: "http500" }, tokens: { mode: "html" } });
  const { value: res, logged } = await quiet(() => browser(env).send(`/api/coin?mint=${CITY_COIN}`, { fetchImpl: w.fetchImpl }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=5");
  const d = await res.json();
  assert.deepEqual(d.coin, { kind: "city", ticker: "UTICA", name: "Utica Coin", city: { id: "5142056", name: "Utica", country: "US" }, pair: { symbol: "SOL", mint: SOL },
    launchedAt: "2026-10-05T10:00:00.000Z", color: "emerald", logo: null });
  assert.equal(d.market.priceUsd, null);
  assert.equal(d.market.missing.price, "Jupiter could not be reached; no LaunchLab curve on the chain; no DEX Screener pool");
  assert.deepEqual(d.trades, { source: null, rows: [], missing: "No LaunchLab curve known for this coin" });
  assert.equal(d.holders, null);
  assert.ok(logged.every((l) => !/[1-9A-HJ-NP-Za-km-z]{32,}/.test(l)), "no address in the log: " + logged.join(" | "));
  assert.ok(!w.log.some((x) => x.url.includes(f.w.address)), "the founder's wallet is never sent anywhere");
});

test("GET /api/coin: edge-cached per mint for 30 s, and the public limiter counts only edge-cache misses: 60 a minute per connection, then 429 slow_down", async () => {
  const env = LP({ VICINITY_MINT: MINT, LIMIT_SALT: "s" });
  const w = await marketWorld(MINT);
  const edge = fakeCaches();
  edge.install();
  try {
    const b = browser(env, { ip: "198.51.100.7" });
    const first = await b.send(`/api/coin?mint=${MINT}`, { fetchImpl: w.fetchImpl });
    assert.equal(first.status, 200);
    assert.deepEqual([...edge.store.keys()], [`https://cache.vicinity.internal/coin-${MINT}`]);
    assert.equal([...edge.store.values()][0].maxAge, 30);
    for (let i = 0; i < 100; i++) assert.equal((await b.send(`/api/coin?mint=${MINT}`, { fetchImpl: w.fetchImpl })).status, 200, "hits are free");
    const chart = await b.send(`/api/coin/chart?mint=${MINT}&tf=7d`, { fetchImpl: w.fetchImpl });
    assert.equal(chart.headers.get("cache-control"), "public, max-age=300");
    assert.ok(edge.store.has(`https://cache.vicinity.internal/coin-chart-${MINT}-7d`));
  } finally { edge.uninstall(); }
  // without an edge cache every request is a miss and is counted
  const b2 = browser(env, { ip: "198.51.100.8" });
  for (let i = 0; i < 60; i++) assert.equal((await b2.send(`/api/coin?mint=${MINT}`, { fetchImpl: w.fetchImpl })).status, 200, `request ${i + 1}`);
  const slow = await b2.send(`/api/coin?mint=${MINT}`, { fetchImpl: w.fetchImpl });
  assert.deepEqual([slow.status, await slow.json(), slow.headers.get("retry-after")], [429, { ok: false, error: "slow_down" }, "60"]);
  assert.equal((await browser(env, { ip: "198.51.100.9" }).send(`/api/coin?mint=${MINT}`, { fetchImpl: w.fetchImpl })).status, 200, "another connection is not affected");
  for (let i = 0; i < 60; i++) await b2.send(`/api/coin/chart?mint=${MINT}&tf=24h`, { fetchImpl: w.fetchImpl });
  assert.equal((await b2.send(`/api/coin/chart?mint=${MINT}&tf=24h`, { fetchImpl: w.fetchImpl })).status, 429, "the chart has its own 60 a minute");
});

test("GET /api/coin after graduation: the stage says so, the trades are labelled as the curve's, and DEX Screener's pool (pool liquidity, its link) takes over", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const PAIR = "9gJHwbyEn3U7eZyf61sTX31mqPNNhwnyDoA9Fn3pMqdq";
  const { pairFor } = await import("./helpers/launchpad.js");
  const w = await marketWorld(MINT, { pools: { [POOL]: poolAccount(MINT, { graduated: true }) }, dex: { [MINT]: [pairFor(MINT, { pairAddress: PAIR, liquidity: { usd: 22764 } })] } });
  const d = await (await browser(env).send(`/api/coin?mint=${MINT}`, { fetchImpl: w.fetchImpl })).json();
  assert.deepEqual([d.market.stage, d.market.liquidityKind, d.market.liquidityUsd, d.market.pairAddress, d.market.priceNative], ["graduated", "pool", 22764, PAIR, null]);
  assert.equal(d.trades.note, "Trades on the bonding curve, before graduation");
  assert.equal(d.links.dexscreener, `https://dexscreener.com/solana/${MINT}`, "now DEX Screener lists it");
  assert.ok(d.attribution.some((a) => a.text === "Pool data after graduation: DEX Screener"));
});

/* ------------------------------------------------------------------ the Launchpad list */

test("the Launchpad card of $VICINITY shows real numbers now (it showed only holders): price, market cap, SOL in the curve, 24 h volume and change, each with its source", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const w = await marketWorld(MINT);
  const res = await browser(env).send("/api/launchpad", { fetchImpl: w.fetchImpl });
  assert.equal(res.headers.get("cache-control"), "public, max-age=30");
  const d = await res.json();
  const m = d.vicinity.market;
  assert.deepEqual([m.priceUsd, m.marketCapUsd, m.liquidityUsd, m.volume24hUsd, m.priceChange24hPct],
    [JUP_PRICE, 7577.217833193381, 14.795544124 * SOL_USD, 221.02457715972727 + 315.17594188232897, -0.7440200264703254]);
  assert.equal(m.sources.liquidity, "SOL in the bonding curve (on-chain) × SOL price (Jupiter)");
  assert.equal(m.curve.progressPct.toFixed(2), "17.41");
  assert.deepEqual(d.attribution.map((a) => a.text), ["Price, market cap, 24 h volume & change: Jupiter · Powered by Jupiter", "Bonding curve & SOL raised: Solana blockchain, read by vicinity.city"]);
  assert.ok(!w.hosts().includes("launch-history-v1.raydium.io"), "the list never asks for trades or candles");
});

/* ------------------------------------------------------------------ the job: samples and candles */

test("the job's market step: one sample per coin on the 10-minute grid, Raydium's 15-minute candles backfilled from launch in one page, then 10 at a time", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const w = await marketWorld(MINT);
  const out = await runJobs(env, clock.now, w.fetchImpl, () => 0.99);
  assert.deepEqual(out.market, { coins: 1, sampled: 1, candles: 109, klineCoins: 1, failed: 0 });
  const [s] = await rows(env, "SELECT * FROM price_samples");
  assert.deepEqual(s, { mint: MINT, at: nowS(), slot: 453948825, stage: "curve", price_native: 6.233650881956076e-8, pair_usd: SOL_USD, price_usd: JUP_PRICE, usd_src: "jupiter", raised: 14.795544124 });
  const kl = w.urls("launch-history").map((u) => new URL(u).searchParams);
  assert.deepEqual(kl.map((q) => [q.get("interval"), q.get("limit"), q.get("poolId")]), [["15m", "500", POOL]]);
  const c = await rows(env, "SELECT t, o, h, l, c FROM price_candles WHERE mint = ? AND tf = '15m' ORDER BY t", MINT);
  assert.deepEqual(c.map((r) => [r.t, r.o, r.h, r.l, r.c]), recorded15(), "exactly Raydium's rows (the open inside the range)");
  const [meta] = await rows(env, "SELECT * FROM market_meta");
  assert.deepEqual(meta, { mint: MINT, pool: POOL, backfilled_at: "2026-10-06T16:00:00.000Z", kline_at: "2026-10-06T16:00:00.000Z", graduated_at: null });

  // ten minutes later: one more sample, and only the newest 10 candles are asked
  clock.now += 10 * 60_000;
  const again = await recordMarket(env, clock.now, w.fetchImpl);
  assert.deepEqual([again.sampled, again.candles], [1, 10]);
  assert.equal((await rows(env, "SELECT at FROM price_samples ORDER BY at")).map((r) => r.at).join(), `${nowS() - 600},${nowS()}`);
  assert.equal(new URL(w.urls("launch-history").pop()).searchParams.get("limit"), "10");
  assert.equal((await rows(env, "SELECT COUNT(*) AS n FROM price_candles")).at(0).n, 109);
  // the same run twice in one 10-minute slot is still one sample (the grid)
  await recordMarket(env, clock.now + 60_000, w.fetchImpl);
  assert.equal((await rows(env, "SELECT COUNT(*) AS n FROM price_samples")).at(0).n, 2);
});

test("the job: after missed runs the candle gap is read page by page until it meets what is stored; nothing launched costs nothing; Jupiter missing means the curve × SOL price", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const w = await marketWorld(MINT);
  await recordMarket(env, clock.now, w.fetchImpl);
  // 25 new 15-minute buckets traded while the job was down
  const newest = fixture("kline_15m.json").data.rows[0];
  const extra = Array.from({ length: 25 }, (_, i) => ({ ...newest, t: newest.t + (25 - i) * 900, o: newest.c, h: newest.c * 1.01, l: newest.c, c: newest.c * 1.01 }));
  w.raydium.kline["15m"] = [...extra, ...w.raydium.kline["15m"]];
  clock.now += 6 * 3_600_000;
  const r = await recordMarket(env, clock.now, w.fetchImpl);
  assert.equal(r.failed, 0);
  const asked = w.urls("launch-history").slice(1).map((u) => new URL(u).searchParams);
  assert.deepEqual(asked.map((q) => [q.get("limit"), q.get("nextPageKey")]), [["10", null], ["100", "00000010"]], "the newest 10, then the next page until it overlaps");
  assert.equal((await rows(env, "SELECT COUNT(*) AS n FROM price_candles")).at(0).n, 134);

  // Jupiter has no price: the sample keeps the exact curve × SOL price and says so
  _resetLaunchpad();
  w.jup.prices = { [SOL]: fixture("jup_price.json")[SOL] }; w.tokens.items = [];
  clock.now += 10 * 60_000;
  await recordMarket(env, clock.now, w.fetchImpl);
  const last = (await rows(env, "SELECT price_usd, usd_src FROM price_samples ORDER BY at DESC LIMIT 1"))[0];
  assert.deepEqual(last, { price_usd: 6.233650881956076e-8 * SOL_USD, usd_src: "jupiter_pair" });
  // every source down: no sample at all (a gap), no throw
  _resetLaunchpad();
  const dead = await marketWorld(MINT, { jup: { mode: "http500" }, tokens: { mode: "http500" }, rpcMode: "http500" });
  clock.now += 10 * 60_000;
  const { value: d, logged } = await quiet(() => recordMarket(env, clock.now, dead.fetchImpl));
  assert.deepEqual([d.sampled, d.klineCoins], [0, 0]);
  assert.deepEqual(d.sources.sort(), ["chain:rpc_http_500", "jupiter_price:http_500", "jupiter_tokens:http_500"]);
  assert.ok(logged.every((l) => !/[1-9A-HJ-NP-Za-km-z]{32,}/.test(l)));

  // nothing launched: no call at all
  const idle = LP();
  const quietWorld = await marketWorld(MINT);
  assert.deepEqual(await recordMarket(idle, clock.now, quietWorld.fetchImpl), { coins: 0, sampled: 0, candles: 0, klineCoins: 0, failed: 0 });
  assert.deepEqual(quietWorld.log, []);
});

test("the job: at most `klineMax` coins' candles a run (read longest ago first); after graduation one last read, then Raydium is never asked again", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  await seedCoin(env.DB, { city: 5142056, name: "Utica", mint: CITY_COIN, pair: "SOL" });
  const cityPool = await poolAddress(CITY_COIN, SOL);
  const w = await marketWorld(MINT, { pools: { [POOL]: poolAccount(MINT), [cityPool]: poolAccount(CITY_COIN) } });
  const one = await recordMarket(env, clock.now, w.fetchImpl, { klineMax: 1 });
  assert.deepEqual([one.sampled, one.klineCoins], [2, 1]);
  clock.now += 600_000;
  await recordMarket(env, clock.now, w.fetchImpl, { klineMax: 1 });
  const metas = await rows(env, "SELECT mint, pool FROM market_meta ORDER BY mint");
  assert.deepEqual(metas.map((r) => r.mint).sort(), [MINT, CITY_COIN].sort(), "the second run took the other coin");
  assert.equal(metas.find((r) => r.mint === CITY_COIN).pool, cityPool);

  // $VICINITY graduates: one last read, then no more
  _resetLaunchpad();
  w.pools[POOL] = poolAccount(MINT, { graduated: true });
  const before = w.count("launch-history");
  clock.now += 600_000;
  await recordMarket(env, clock.now, w.fetchImpl, { klineMax: 5 });
  const g = (await rows(env, "SELECT graduated_at, kline_at FROM market_meta WHERE mint = ?", MINT))[0];
  assert.deepEqual(g, { graduated_at: new Date(clock.now).toISOString(), kline_at: new Date(clock.now).toISOString() });
  const s = (await rows(env, "SELECT stage, price_native, usd_src FROM price_samples WHERE mint = ? ORDER BY at DESC LIMIT 1", MINT))[0];
  assert.deepEqual(s, { stage: "graduated", price_native: null, usd_src: "jupiter" });
  const after1 = w.count("launch-history");
  assert.equal(after1 - before, 2, "this run: the last read of $VICINITY and the city coin's");
  for (let i = 0; i < 3; i++) { _resetLaunchpad(); clock.now += 600_000; await recordMarket(env, clock.now, w.fetchImpl, { klineMax: 5 }); }
  const later = w.urls("launch-history").slice(after1);
  assert.equal(later.length, 3, "three more runs: three reads");
  assert.ok(later.every((u) => u.includes(cityPool)), "only the coin still on its curve");
});

test("pruning at 03:00 UTC: samples older than 30 days keep the last of each hour, older than 365 days the last of each day; old 15-minute candles become exact 4-hour candles", async () => {
  useClock("2026-12-20T03:05:00Z");
  const env = LP({ VICINITY_MINT: MINT });
  const w = await marketWorld(MINT, { raydium: { kline: { "15m": [], "1m": [] } } });
  await recordMarket(env, clock.now - 3 * 3_600_000, w.fetchImpl); // makes the tables (not a 03:00 run: nothing pruned)
  const s0 = nowS();
  const put = [];
  for (let at = Math.floor((s0 - 40 * 86400) / 600) * 600; at < s0; at += 600) put.push(env.DB.prepare("INSERT OR IGNORE INTO price_samples (mint, at, price_usd, usd_src) VALUES (?, ?, ?, 'jupiter')").bind(MINT, at, at / 1e12));
  for (let at = s0 - 400 * 86400; at < s0 - 366 * 86400; at += 3600) put.push(env.DB.prepare("INSERT OR IGNORE INTO price_samples (mint, at, price_usd, usd_src) VALUES (?, ?, ?, 'jupiter')").bind(MINT, at, at / 1e12));
  const candles = [];
  for (let t = Math.floor((s0 - 35 * 86400) / 900) * 900; t < s0 - 25 * 86400; t += 900) { const p = 1e-8 * (1 + Math.sin(t / 5000) / 2); candles.push([t, p, p * 1.02, p * 0.97, p * 1.01]); }
  for (const [t, o, h, l, c] of candles) put.push(env.DB.prepare("INSERT INTO price_candles (mint, tf, t, o, h, l, c, src) VALUES (?, '15m', ?, ?, ?, ?, ?, 'raydium')").bind(MINT, t, o, h, l, c));
  for (let i = 0; i < put.length; i += 50) await env.DB.batch(put.slice(i, i + 50));

  const out = await recordMarket(env, clock.now, w.fetchImpl);
  assert.ok(out.pruned, "the 03:00 run prunes");
  const cut = s0 - 30 * 86400;
  const old = await rows(env, "SELECT at FROM price_samples WHERE at < ? AND at >= ? ORDER BY at", cut, s0 - 365 * 86400);
  const perHour = new Map(); for (const r of old) perHour.set(Math.floor(r.at / 3600), (perHour.get(Math.floor(r.at / 3600)) || 0) + 1);
  assert.ok([...perHour.values()].every((n) => n === 1), "one sample per hour after 30 days");
  assert.ok(old.filter((r) => r.at < cut - 3600).every((r) => r.at % 3600 === 3000), "and it is the LAST of its hour");
  const recent = await rows(env, "SELECT COUNT(*) AS n FROM price_samples WHERE at >= ?", cut);
  assert.equal(recent[0].n, (Math.floor(s0 / 600) * 600 - Math.ceil(cut / 600) * 600) / 600 + 1, "every 10-minute sample of the last 30 days is untouched");
  const ancient = await rows(env, "SELECT at FROM price_samples WHERE at < ?", s0 - 365 * 86400);
  const perDay = new Map(); for (const r of ancient) perDay.set(Math.floor(r.at / 86400), (perDay.get(Math.floor(r.at / 86400)) || 0) + 1);
  assert.ok(ancient.length > 0 && [...perDay.values()].every((n) => n === 1), "one per day after a year");

  const boundary = Math.floor(cut / 14400) * 14400;
  const left15 = await rows(env, "SELECT t FROM price_candles WHERE tf = '15m' ORDER BY t");
  assert.ok(left15.every((r) => r.t >= boundary), "no 15-minute candle older than the cut is left");
  const got4h = (await rows(env, "SELECT t, o, h, l, c FROM price_candles WHERE tf = '4h' ORDER BY t")).map((r) => [r.t, r.o, r.h, r.l, r.c]);
  assert.deepEqual(got4h, aggregate(candles.filter((c) => c[0] < boundary), 14400), "exact: first open, highest high, lowest low, last close");
  assert.equal(left15.length + got4h.length * 16 >= candles.length, true);
});

/* ------------------------------------------------------------------ GET /api/coin/chart */

test("the chart: Raydium's candles in SOL (15 m for 24 h, 1 h for 7 d, 4 h for 30 d) and our USD samples, each labelled with its source and the span it covers", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const w = await marketWorld(MINT);
  // before the job ever ran: honest empties
  const empty = await (await browser(env).send(`/api/coin/chart?mint=${MINT}&tf=24h`, { fetchImpl: w.fetchImpl })).json();
  assert.equal(empty.candles, null);
  assert.match(empty.missing.candles, /^No candles recorded/);
  assert.deepEqual([empty.line.points, empty.line.recordingSince], [[], null]);
  assert.match(empty.missing.line, /^Not recorded yet/);
  assert.deepEqual(w.log, [], "the 24 h chart reads only the database");

  await recordMarket(env, clock.now, w.fetchImpl);
  const get = async (tf) => (await browser(env).send(`/api/coin/chart?mint=${MINT}&tf=${tf}`, { fetchImpl: w.fetchImpl })).json();
  const day = await get("24h");
  assert.deepEqual(Object.keys(day), ["ok", "mint", "tf", "asOf", "candles", "line", "missing"]);
  const since = nowS() - 86400;
  const want = recorded15().filter((r) => r[0] >= Math.floor(since / 900) * 900);
  assert.deepEqual(day.candles, { unit: "SOL", interval: "15m", source: "Raydium LaunchLab", rows: want, from: new Date(want[0][0] * 1000).toISOString(), to: "2026-10-06T04:30:00.000Z" });
  assert.deepEqual(day.line.points, [[nowS(), JUP_PRICE, "j", 6.233650881956076e-8]]);
  assert.deepEqual([day.line.unit, day.line.interval, day.line.source, day.line.recordingSince], ["USD", "10m", "vicinity.city samples", "2026-10-06T16:00:00.000Z"]);
  assert.match(day.line.rule, /Jupiter's price \(last trade\) every 10 minutes; the on-chain curve × SOL price \(Jupiter\) where Jupiter had none/);
  assert.deepEqual(day.missing, {});

  const week = await get("7d");
  assert.equal(week.candles.interval, "1h");
  assert.deepEqual(week.candles.rows, aggregate(recorded15(), 3600), "all of it (the coin is 3 days old), exactly aggregated");
  const b = week.candles.rows.find((r) => r[0] === 1791259200); // 2026-10-06 04:00 UTC
  const inside = recorded15().filter((r) => r[0] >= 1791259200 && r[0] < 1791262800);
  assert.deepEqual(b, [1791259200, inside[0][1], Math.max(...inside.map((r) => r[2])), Math.min(...inside.map((r) => r[3])), inside.at(-1)[4]]);
  assert.equal((await get("30d")).candles.interval, "4h");
  const all = await get("all");
  assert.deepEqual([all.candles.interval, all.candles.from], ["1h", "2026-10-03T16:00:00.000Z"], "a 3-day history is shown by the hour, from launch");
  // the line thins out the same way: last sample per bucket
  assert.deepEqual(lastPerBucket([[0, 1], [600, 2], [3600, 3], [4200, 4]], 3600), [[600, 2], [4200, 4]]);
});

test("the 1-hour chart asks Raydium for 1-minute candles (kept 60 s); when Raydium fails it says so and falls back to our 15-minute copy, kept 10 s", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const w = await marketWorld(MINT);
  await recordMarket(env, clock.now, w.fetchImpl);
  const shift = Math.floor((nowS() - 1200 - fixture("kline_1m.json").data.rows[0].t) / 60) * 60;
  w.raydium.kline["1m"] = fixture("kline_1m.json").data.rows.map((r) => ({ ...r, t: r.t + shift })); // as if the last trades were 20 minutes ago
  const n0 = w.count("launch-history");
  const res = await browser(env).send(`/api/coin/chart?mint=${MINT}&tf=1h`, { fetchImpl: w.fetchImpl });
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  const h = await res.json();
  assert.equal(h.candles.interval, "1m");
  assert.ok(h.candles.rows.length > 0 && h.candles.rows.every((r) => r[0] >= nowS() - 3600 && r[0] % 60 === 0));
  const asked = new URL(w.urls("launch-history").at(-1)).searchParams;
  assert.deepEqual([asked.get("interval"), asked.get("limit")], ["1m", "60"]);
  await browser(env).send(`/api/coin/chart?mint=${MINT}&tf=1h`, { fetchImpl: w.fetchImpl });
  assert.equal(w.count("launch-history") - n0, 1, "the second viewer within 60 s: from memory");

  _resetLaunchpad();
  w.raydium.klineMode = "http429";
  const down = await browser(env).send(`/api/coin/chart?mint=${MINT}&tf=1h`, { fetchImpl: w.fetchImpl });
  assert.equal(down.headers.get("cache-control"), "public, max-age=10");
  const d = await down.json();
  assert.deepEqual([d.candles.interval, d.candles.note], ["15m", "Raydium's 1-minute candles could not be read: 15-minute candles from vicinity.city's copy"]);
  assert.equal(d.missing.candles, "No trades in this range", "the last stored trade was 11 hours ago");
});
