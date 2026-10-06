// What the Launchpad and the coin page may claim when a source fails or another venue lists the coin (LAUNCHPAD_V2=on), the
// review of 6 Oct 2026 (data findings). Against the fake outside world built from the REAL answers (test/helpers/market.js):
// * a chain that cannot be read is "the chain could not be read": never "no LaunchLab curve", never "graduated" because DEX
//   Screener lists a pair, and Raydium's trade list is still asked for the pool the coin's address derives to;
// * on the bonding curve (or while the stage is unknown) DEX Screener's market cap, volume, change, liquidity and price are never
//   shown next to the curve's price: a pool there before graduation can only be someone else's, at any price its creator chose;
// * "Raydium LaunchLab" is said only when the chain found the coin's LaunchLab pool or Jupiter says it launched there;
// * the attribution says "after graduation" only for a coin that graduated.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { IN_UTICA, MINT, browser, clock, person, realClock, useClock } from "./helpers/world.js";
import { CITY_COIN, LP, pairFor, seedCoin } from "./helpers/launchpad.js";
import { SOL, fixture, marketWorld, poolAccount } from "./helpers/market.js";
import { _resetLaunchpad } from "../src/launchpad.js";
import { _resetMarket } from "../src/market.js";
import { _resetCoin } from "../src/coin.js";
import { _resetLaunchlab, poolAddress } from "../src/launchlab.js";
import { _resetMarketLive, attributionFor, combine, jupTokenOf, liveMarkets } from "../src/marketlive.js";

beforeEach(() => { useClock("2026-10-06T16:00:00Z"); _resetLaunchpad(); _resetMarket(); _resetCoin(); _resetMarketLive(); _resetLaunchlab(); });
after(() => realClock());

const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const POOL = await poolAddress(MINT, SOL);
const SOL_USD = fixture("jup_price.json")[SOL].usdPrice;
/** Someone's pool for the coin on another DEX, while it is still on its curve: 55× the curve's price. */
const THIRD_PARTY = (mint) => [pairFor(mint, { priceUsd: "0.00042", marketCap: 420000, fdv: 420000, liquidity: { usd: 96500 }, volume: { h24: 310.25 }, priceChange: { h24: 12.3 } })];
const DEX_WORDS = /DEX Screener/;

test("the chain cannot be read: the stage is unknown (not 'pool', not 'graduated'), DEX Screener's pair is not used, and the reasons say the chain failed", async () => {
  const w = await marketWorld(MINT, { rpcMode: "http500", dex: { [MINT]: THIRD_PARTY(MINT) } });
  const r = await quiet(() => liveMarkets({}, [{ mint: MINT, pairMint: SOL }], w.fetchImpl, { now: clock.now }));
  const m = r.markets.get(MINT);
  assert.equal(m.stage, null, "unknown, not 'pool' because DEX Screener lists a pair");
  assert.deepEqual([m.curve, m.pairAddress, m.dex], [null, null, null]);
  assert.ok(!Object.values(m.sources).some((s) => DEX_WORDS.test(s)), JSON.stringify(m.sources));
  assert.notEqual(m.liquidityUsd, 96500);
  assert.equal(m.launchpad, "raydium-launchlab", "Jupiter says where it launched");
  assert.ok(!attributionFor(r.used).some((a) => /after graduation/.test(a.text)));
  // Jupiter has no price either: every reason names the chain, none blames a missing curve
  _resetMarketLive(); _resetLaunchlab();
  const w2 = await marketWorld(MINT, { rpcMode: "http500", jup: { prices: { [SOL]: fixture("jup_price.json")[SOL] } }, tokens: { items: [] }, dex: { [MINT]: THIRD_PARTY(MINT) } });
  const m2 = (await quiet(() => liveMarkets({}, [{ mint: MINT, pairMint: SOL }], w2.fetchImpl, { now: clock.now }))).markets.get(MINT);
  assert.equal(m2.priceUsd, null, "no DEX Screener price while the stage is unknown");
  assert.match(m2.missing.price, /the chain could not be read/);
  assert.match(m2.missing.price, /DEX Screener is not used while the chain cannot be read/);
  assert.doesNotMatch(Object.values(m2.missing).join(" "), /no LaunchLab curve|graduated/);
  assert.equal(m2.launchpad, null, "neither the chain nor Jupiter said LaunchLab");
});

test("GET /api/coin with the chain down: Raydium's trades for the derived pool, no 'No LaunchLab curve', no 'after graduation'", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const w = await marketWorld(MINT, { rpcMode: "http500", dex: { [MINT]: THIRD_PARTY(MINT) } });
  const d = await quiet(async () => (await browser(env).send(`/api/coin?mint=${MINT}`, { fetchImpl: w.fetchImpl })).json());
  assert.equal(d.market.stage, null);
  assert.equal(d.trades.source, "Raydium LaunchLab");
  assert.equal(d.trades.rows.length, Math.min(20, fixture("trade.json").data.rows.length), "the pool's address is pure math: Raydium is asked anyway");
  assert.ok(w.urls("launch-history-v1").some((u) => u.includes(`poolId=${POOL}`)));
  assert.equal(d.trades.missing, undefined);
  assert.equal(d.trades.note, undefined, "not labelled as before graduation: the stage is unknown");
  assert.equal(d.links.dexscreener, null, "no link to someone else's pool");
  const words = JSON.stringify(d);
  assert.doesNotMatch(words, /No LaunchLab curve known|Trades after graduation|Pool data after graduation/);
  // and Raydium down too: the trades card says both failed
  _resetCoin(); _resetMarketLive(); _resetLaunchlab();
  const w2 = await marketWorld(MINT, { rpcMode: "http500", raydium: { tradeMode: "http500" } });
  const d2 = await quiet(async () => (await browser(env).send(`/api/coin?mint=${MINT}`, { fetchImpl: w2.fetchImpl })).json());
  assert.equal(d2.trades.missing, "The chain could not be read, and Raydium could not be reached");
});

test("on the bonding curve, someone else's DEX Screener pool never lends the coin its market cap, volume, change or liquidity", async () => {
  // Jupiter prices SOL but not the coin; DEX Screener lists a third-party pair at 55× the curve's price
  const w = await marketWorld(MINT, { jup: { prices: { [SOL]: fixture("jup_price.json")[SOL] } }, tokens: { items: [] }, dex: { [MINT]: THIRD_PARTY(MINT) } });
  const r = await liveMarkets({}, [{ mint: MINT, pairMint: SOL }], w.fetchImpl, { now: clock.now });
  const m = r.markets.get(MINT);
  assert.equal(m.stage, "curve");
  assert.equal(m.priceUsd, 6.233650881956076e-8 * SOL_USD);
  assert.equal(m.sources.price, "On-chain curve × SOL price (Jupiter)");
  assert.equal(m.marketCapUsd, m.priceUsd * 1e9, "price × supply from the same source as the price, not DEX Screener's $420K");
  assert.equal(m.fdvUsd, m.priceUsd * 1e9);
  assert.equal(m.sources.marketCap, "Price × on-chain supply");
  assert.equal(m.volume24hUsd, 511.48322206997324, "Raydium's own 24 h volume, asked because DEX Screener's does not count");
  assert.equal(m.sources.volume24h, "Raydium LaunchLab");
  assert.equal(m.priceChange24hPct, null);
  assert.equal(m.missing.change24h, "Jupiter has no price for it (no trade in the last 7 days); a DEX Screener pool before graduation is not the coin's market");
  assert.equal(m.liquidityKind, "bonding_curve");
  assert.equal(m.liquidityUsd, 14.795544124 * SOL_USD);
  assert.deepEqual([m.pairAddress, m.dex], [null, null]);
  assert.ok(!Object.values(m.sources).some((s) => DEX_WORDS.test(s)), JSON.stringify(m.sources));
  assert.ok(!r.used.has("dexscreener"));
  assert.equal(m.codes.price, "jupiter_pair", "the price history records the curve's price, never a third-party pool's");
});

test("after graduation DEX Screener's pool is the coin's market again, and only then the sources say 'after graduation'", async () => {
  const w = await marketWorld(MINT, { pools: { [POOL]: poolAccount(MINT, { graduated: true }) }, dex: { [MINT]: [pairFor(MINT, { liquidity: { usd: 22764 } })] } });
  const r = await liveMarkets({}, [{ mint: MINT, pairMint: SOL }], w.fetchImpl, { now: clock.now });
  const m = r.markets.get(MINT);
  assert.deepEqual([m.stage, m.liquidityUsd, m.sources.liquidity], ["graduated", 22764, "DEX Screener"]);
  assert.deepEqual(attributionFor(r.used).map((a) => a.text).filter((t) => DEX_WORDS.test(t)), ["Pool data after graduation: DEX Screener"]);
  // a coin the chain says never had a LaunchLab pool, with a DEX pool: its market, without "after graduation"
  const c = combine({ mint: CITY_COIN }, { curve: null, curveState: null, dx: { priceUsd: 0.001, marketCapUsd: 1e6, liquidityUsd: 5e4, pairAddress: "x", dex: "raydium", url: "u" }, dxState: {}, dxAsked: true });
  assert.deepEqual([c.stage, c.marketCapUsd, c.launchpad], ["pool", 1e6, null]);
  assert.deepEqual(attributionFor(new Set(c.codes.used)).map((a) => a.text), ["Pool data: DEX Screener"]);
  // Jupiter's graduation record with the chain unread: graduated, and DEX Screener counts
  const g = combine({ mint: MINT }, { curve: null, curveState: undefined, jt: jupTokenOf(fixture("jup_tok_graduated.json")[0]), jtState: {}, dx: { liquidityUsd: 9 }, dxState: {}, dxAsked: true });
  assert.deepEqual([g.stage, g.liquidityUsd, g.launchpad], ["graduated", 9, "raydium-launchlab"]);
});

test("a city coin with no LaunchLab pool on the chain is not called a LaunchLab coin (card and coin page), and no curve is promised", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const f = await person(env, { home: IN_UTICA, holds: 10 });
  const u = await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(f.w.address).first();
  await seedCoin(env.DB, { city: 5142056, name: "Utica", coin: "Utica Coin", mint: CITY_COIN, pair: "SOL", color: "emerald", launchedAt: "2026-10-05T10:00:00.000Z", user: u.id });
  const w = await marketWorld(MINT, { tokens: { items: [] } });
  const d = await quiet(async () => (await browser(env).send(`/api/coin?mint=${CITY_COIN}`, { fetchImpl: w.fetchImpl })).json());
  assert.deepEqual([d.market.curve, d.market.launchpad, d.market.stage], [null, null, null]);
  assert.equal(d.trades.missing, "No LaunchLab curve known for this coin");
  const lp = await quiet(async () => (await browser(env).send("/api/launchpad", { fetchImpl: w.fetchImpl })).json());
  const utica = lp.coins.find((c) => c.mint === CITY_COIN);
  assert.equal(utica.market.launchpad, null);
  assert.equal(lp.vicinity.market.launchpad, "raydium-launchlab", "$VICINITY's pool is on the chain");
});

test("the sources line credits Raydium with the 24 h volume when the volume came from it", async () => {
  assert.deepEqual(attributionFor(new Set(["raydium"])).map((a) => a.text), ["Chart, trades & 24 h volume: Raydium LaunchLab"]);
  assert.deepEqual(attributionFor(new Set(["jupiter"]), { trades: true }).map((a) => a.text), ["Price, market cap, 24 h volume & change: Jupiter · Powered by Jupiter", "Chart & trades: Raydium LaunchLab"]);
});
