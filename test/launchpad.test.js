// GET /api/launchpad (LAUNCHPAD_V2=on): the one answer the Launchpad page builds its tabs from. Cards for $VICINITY and every
// designed city coin, with status, ticker, a founder shown by username and masked wallet, member and holder counts, market data
// from DexScreener (allow-listed mints only, one call per 30 mints, the best pair per coin, nulls for anything missing or
// failed), trade links, country list and counts. One upstream round per server per 30 seconds, shared by every viewer.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IN_NYC, IN_UTICA, MINT, advance, browser, clock, person, realClock, setHolding, tick, useClock } from "./helpers/world.js";
import { CITY_COIN, LP, PENDING, RAY, SOL, USDC, dexMock, fakeCaches, mintNo, pairFor, seedCoin, seedSeat } from "./helpers/launchpad.js";
import { keysOf } from "./helpers/profiles.js";
import { _resetLaunchpad, tradeLinks } from "../src/launchpad.js";
import { _resetMarket, marketFor, marketOf, pickPair } from "../src/market.js";
import { ensureSchema } from "../src/store.js";

beforeEach(() => { useClock("2026-10-12T12:00:00Z"); _resetLaunchpad(); _resetMarket(); });
after(() => realClock());

const CARD_KEYS = ["kind", "status", "city", "ticker", "name", "pitch", "color", "logo", "pair", "mint", "launchedAt", "designedAt", "founder", "members", "market", "holders", "links", "rewardModel"];
const MARKET_KEYS = ["priceUsd", "marketCapUsd", "fdvUsd", "liquidityUsd", "volume24hUsd", "priceChange24hPct", "pairAddress", "dex", "url",
  "priceNative", "nativeSymbol", "liquidityKind", "traders24h", "stage", "curve", "sources", "missing", "stale", "launchpad"];
const NUMBERS = ["priceUsd", "marketCapUsd", "fdvUsd", "liquidityUsd", "volume24hUsd", "priceChange24hPct"];
/** A live coin no source could price: every number null (the page's dash), and a short reason for each one the page shows. */
function noNumbers(m, why = /./) {
  assert.ok(m && typeof m === "object", "a market object, with its reasons");
  for (const k of NUMBERS) assert.equal(m[k], null, k);
  assert.deepEqual(m.sources, {}, "no number, no source");
  assert.deepEqual(Object.keys(m.missing).sort(), ["change24h", "liquidity", "marketCap", "price", "volume24h"]);
  for (const r of Object.values(m.missing)) assert.match(r, why);
}

/** Utica live (founder with a username), Syracuse waiting for the admin's check, Albany designed; the token live; holders counted. */
async function threeStates(env) {
  const f = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  await person(env, { home: IN_UTICA, holds: 50 });
  await person(env, { home: IN_UTICA });
  const other = await person(env, { home: IN_NYC, holds: 10 });
  await seedSeat(env, f, { city: 5142056, name: "Utica", handle: "uticafounder" });
  await seedSeat(env, other, { city: 5128581, name: "New York City", status: "steward" });
  const u = await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(f.w.address).first();
  await seedCoin(env.DB, { city: 5142056, name: "Utica", coin: "Utica Coin", pitch: "The Handshake City, on the map.", pair: "SOL", color: "emerald",
    mint: CITY_COIN, launchedAt: "2026-10-11T10:00:00.000Z", updatedAt: "2026-10-11T10:00:00.000Z", user: u.id, seat: 1 });
  await seedCoin(env.DB, { city: 5140405, name: "Syracuse", coin: "Syracuse Salt", pitch: "Salt City.", pair: "USDC", color: "ocean", pending: PENDING, updatedAt: "2026-10-12T09:00:00.000Z" });
  await seedCoin(env.DB, { city: 5106834, name: "Albany", coin: "Albany", pair: "RAY", color: "violet", media: 7, updatedAt: "2026-10-10T09:00:00.000Z" });
  await tick(env); // a balance sample (member holders) and the holder counts
  return { f, other };
}

test("the aggregation: statuses, tickers, founder by username + masked wallet, members, holders, market, links, countries, stats", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  const { f, other } = await threeStates(env);
  const dex = dexMock({ [CITY_COIN]: [pairFor(CITY_COIN)], [MINT]: [pairFor(MINT, { priceUsd: "0.002", marketCap: 2000000, liquidity: { usd: 90000 }, volume: { h24: 500 }, priceChange: { h24: -1.5 } })] });
  const res = await browser(env).send("/api/launchpad", { fetchImpl: dex.fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=30");
  assert.equal(res.headers.get("content-security-policy").includes("connect-src 'self'"), true);
  const text = await res.text(), d = JSON.parse(text);

  assert.deepEqual(Object.keys(d), ["ok", "asOf", "opensAt", "open", "vicinity", "coins", "countries", "stats", "attribution"]);
  // Utica's coin has no LaunchLab pool on the chain: its DEX pool is its market (not "after graduation": it never had a curve)
  assert.deepEqual(d.attribution.map((a) => a.text), ["Pool data: DEX Screener", "Holders: counted by vicinity.city"], "only the sources this answer used");
  assert.deepEqual([d.ok, d.asOf, d.opensAt, d.open], [true, "2026-10-12T12:00:00.000Z", "2026-10-10T10:10:10-04:00", true]);
  assert.deepEqual(d.coins.map((c) => [c.city.name, c.status]), [["Syracuse", "waiting"], ["Utica", "live"], ["Albany", "designed"]], "most recently updated first, as /api/coins");
  for (const c of [d.vicinity, ...d.coins]) {
    assert.deepEqual(Object.keys(c).filter((k) => k !== "opensAt"), CARD_KEYS, c.name);
    assert.equal(c.rewardModel, null, "no reward model exists in the data: never invented");
    if (c.market) assert.deepEqual(Object.keys(c.market), MARKET_KEYS);
    if (c.logo) assert.match(c.logo, /^\/api\/media\/\d+$/);
  }

  const utica = d.coins[1];
  assert.deepEqual(utica.city, { id: "5142056", name: "Utica", country: "US" });
  assert.deepEqual([utica.kind, utica.ticker, utica.name, utica.pitch, utica.color, utica.logo], ["city", "UTICA", "Utica Coin", "The Handshake City, on the map.", "emerald", null]);
  assert.deepEqual(utica.pair, { symbol: "SOL", mint: SOL });
  assert.deepEqual([utica.mint, utica.launchedAt, utica.designedAt], [CITY_COIN, "2026-10-11T10:00:00.000Z", "2026-10-11T10:00:00.000Z"]);
  assert.deepEqual(utica.founder, { handle: "uticafounder", wallet: `${f.w.address.slice(0, 5)}*****${f.w.address.slice(-3)}`, status: "active" });
  assert.deepEqual(utica.members, { members: 3, holders: 2 }, "three people call Utica home, two of them hold (from the balance sample)");
  assert.deepEqual(utica.holders, { count: 3, asOf: "2026-10-12T12:00:00.000Z" }, "every wallet holding anything (the test chain gives every coin the same holders)");
  const DS = "DEX Screener";
  assert.deepEqual(utica.market, { priceUsd: 0.0012, marketCapUsd: 1200000, fdvUsd: 1200000, liquidityUsd: 45000, volume24hUsd: 12345.6, priceChange24hPct: 12.5,
    pairAddress: mintNo(999), dex: "raydium", url: `https://dexscreener.com/solana/${CITY_COIN.toLowerCase()}`,
    priceNative: null, nativeSymbol: null, liquidityKind: "pool", traders24h: null, stage: "pool", curve: null,
    sources: { price: DS, marketCap: DS, fdv: DS, liquidity: DS, volume24h: DS, change24h: DS }, missing: {}, stale: false, launchpad: null });
  assert.deepEqual(utica.links, {
    raydium: `https://raydium.io/launchpad/token/?mint=${CITY_COIN}`, jupiter: `https://jup.ag/swap/SOL-${CITY_COIN}`,
    dexscreener: `https://dexscreener.com/solana/${CITY_COIN}`, solscan: `https://solscan.io/token/${CITY_COIN}`,
  });
  console.log("CARD (Utica, live) for the frontend:\n" + JSON.stringify(utica, null, 2));

  const syracuse = d.coins[0];
  assert.deepEqual([syracuse.status, syracuse.mint, syracuse.market, syracuse.holders, syracuse.links, syracuse.founder, syracuse.members], ["waiting", null, null, null, null, null, null]);
  assert.deepEqual(syracuse.pair, { symbol: "USDC", mint: USDC });
  const albany = d.coins[2];
  assert.deepEqual([albany.status, albany.ticker, albany.logo, albany.pair.mint, albany.designedAt], ["designed", "ALBANY", "/api/media/7", RAY, "2026-10-10T09:00:00.000Z"]);

  // privacy: the founder's full wallet and the contract waiting for a check are nowhere in the whole answer
  assert.ok(!text.includes(f.w.address), "no full founder wallet");
  assert.ok(!text.includes(other.w.address), "no other wallet either");
  assert.ok(!text.includes(PENDING), "no pending contract");
  const known = [CITY_COIN, MINT, SOL, USDC, RAY, mintNo(999), CITY_COIN.toLowerCase(), MINT.toLowerCase()];
  assert.ok(!/[1-9A-HJ-NP-Za-km-z]{32,}/.test(text.replace(new RegExp(known.join("|"), "g"), "")), "the only long base58 strings are mints and the pair");
  assert.ok(![...keysOf(d)].some((k) => /pending|wallet_|user_id|seat_id/i.test(k)), "no database column leaks: " + [...keysOf(d)].join());

  // $VICINITY, countries, counts
  assert.deepEqual([d.vicinity.kind, d.vicinity.status, d.vicinity.ticker, d.vicinity.name, d.vicinity.mint, d.vicinity.city, d.vicinity.founder], ["vicinity", "live", "VICINITY", "Vicinity", MINT, null, null]);
  assert.deepEqual(d.vicinity.pair, { symbol: "SOL", mint: SOL });
  assert.deepEqual([d.vicinity.market.priceUsd, d.vicinity.market.marketCapUsd, d.vicinity.market.liquidityUsd, d.vicinity.market.volume24hUsd, d.vicinity.market.priceChange24hPct], [0.002, 2000000, 90000, 500, -1.5]);
  assert.deepEqual(d.vicinity.holders, { count: 3, asOf: "2026-10-12T12:00:00.000Z" });
  assert.equal(d.vicinity.links.jupiter, `https://jup.ag/swap/SOL-${MINT}`);
  assert.deepEqual(d.countries, [{ code: "US", name: "United States", count: 3 }]);
  assert.deepEqual(d.stats, { live: 2, new: 1, upcoming: 2 }, "live: Utica + $VICINITY; new: Utica (yesterday); upcoming: Syracuse + Albany");
  assert.deepEqual(dex.mints(), [[MINT, CITY_COIN]], "exactly one DexScreener call, with the allow-listed mints only");
});

test("$VICINITY before its mint: an upcoming card with the opening time, no links, no market; the page's open flag follows the clock", async () => {
  const env = LP();
  await seedCoin(env.DB, { city: 5106834, name: "Albany" });
  useClock("2026-10-05T12:00:00Z");
  const dex = dexMock();
  const d = await (await browser(env).send("/api/launchpad", { fetchImpl: dex.fetchImpl })).json();
  assert.equal(d.open, false);
  assert.deepEqual([d.vicinity.status, d.vicinity.mint, d.vicinity.links, d.vicinity.market, d.vicinity.holders, d.vicinity.opensAt],
    ["upcoming", null, null, null, null, "2026-10-10T10:10:10-04:00"]);
  assert.deepEqual(d.stats, { live: 0, new: 0, upcoming: 2 }, "$VICINITY and Albany");
  assert.deepEqual(dex.seen, [], "nothing to ask DexScreener about");
  assert.deepEqual(d.countries, [{ code: "US", name: "United States", count: 1 }]);
  // the opening passes
  useClock("2026-10-10T14:10:11Z"); _resetLaunchpad();
  const later = await (await browser(env).send("/api/launchpad", { fetchImpl: dex.fetchImpl })).json();
  assert.equal(later.open, true);
  assert.equal(later.vicinity.status, "upcoming", "still no mint: still upcoming");
  // the token launches
  env.VICINITY_MINT = MINT; _resetLaunchpad();
  const live = await (await browser(env).send("/api/launchpad", { fetchImpl: dex.fetchImpl })).json();
  assert.deepEqual([live.vicinity.status, live.vicinity.mint, live.vicinity.links.raydium], ["live", MINT, `https://raydium.io/launchpad/token/?mint=${MINT}`]);
  noNumbers(live.vicinity.market);
  assert.equal(live.vicinity.market.missing.price, "Jupiter has no price for it (no trade in the last 7 days); no LaunchLab curve on the chain; no DEX Screener pool");
  assert.deepEqual(live.stats, { live: 1, new: 0, upcoming: 1 });
  assert.deepEqual(dex.mints(), [[MINT]]);
  // in preview mode the site pretends it opened yesterday
  const preview = await (await browser(LP({ SITE_MODE: "preview" })).send("/api/launchpad", { fetchImpl: dex.fetchImpl })).json();
  assert.equal(preview.open, true);
  assert.equal(preview.opensAt, new Date(Date.now() - 86400000).toISOString());
});

test("DexScreener: the pair with the most liquidity wins (ties: most volume), prices are strings, missing fields are null, a foreign base token is ignored", () => {
  const a = pairFor(CITY_COIN, { pairAddress: mintNo(1), liquidity: { usd: 100 }, volume: { h24: 5 } });
  const b = pairFor(CITY_COIN, { pairAddress: mintNo(2), liquidity: { usd: 900 }, volume: { h24: 1 } });
  const c = pairFor(CITY_COIN, { pairAddress: mintNo(3), liquidity: { usd: 900 }, volume: { h24: 7 } });
  const foreign = pairFor(SOL, { pairAddress: mintNo(4), quoteToken: { address: CITY_COIN }, liquidity: { usd: 1e9 } }); // the coin as the quote of SOL
  const otherChain = pairFor(CITY_COIN, { pairAddress: mintNo(5), chainId: "ethereum", liquidity: { usd: 1e9 } });
  assert.equal(pickPair([a, b, c, foreign, otherChain], CITY_COIN).pairAddress, mintNo(3));
  assert.equal(pickPair([a, b], CITY_COIN).pairAddress, mintNo(2));
  assert.equal(pickPair([foreign, otherChain], CITY_COIN), null);
  assert.equal(pickPair(null, CITY_COIN), null);

  assert.deepEqual(marketOf(pairFor(CITY_COIN, { priceUsd: "0.000045", marketCap: undefined, fdv: undefined, liquidity: undefined, volume: {}, priceChange: { h24: "x" } }), CITY_COIN),
    { priceUsd: 0.000045, marketCapUsd: null, fdvUsd: null, liquidityUsd: null, volume24hUsd: null, priceChange24hPct: null, pairAddress: mintNo(999), dex: "raydium", url: `https://dexscreener.com/solana/${CITY_COIN.toLowerCase()}` });
  // nothing odd is passed on: a bad price, a bad address, a dex id or url with markup fall back to null or to our own address
  const odd = marketOf(pairFor(CITY_COIN, { priceUsd: "<b>1</b>", pairAddress: "<script>", dexId: "ray<dium", url: "javascript:alert(1)", priceChange: { h24: -0 }, marketCap: -5, liquidity: { usd: "12.5" } }), CITY_COIN);
  assert.deepEqual(odd, { priceUsd: null, marketCapUsd: null, fdvUsd: 1200000, liquidityUsd: 12.5, volume24hUsd: 12345.6, priceChange24hPct: 0, pairAddress: null, dex: null, url: `https://dexscreener.com/solana/${CITY_COIN}` });
  assert.equal(marketOf(null, CITY_COIN), null);
});

test("DexScreener through the route: 30 mints a call, a coin crowded out of a full answer is asked again on its own, only allow-listed mints are ever sent", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  for (let i = 1; i <= 31; i++) await seedCoin(env.DB, { city: 900000 + i, name: "City " + i, mint: mintNo(i) });
  await seedCoin(env.DB, { city: 5140405, name: "Syracuse", pending: PENDING });
  await seedCoin(env.DB, { city: 5106834, name: "Albany" });
  const table = {};
  for (let i = 1; i <= 31; i++) table[mintNo(i)] = [pairFor(mintNo(i), { priceUsd: String(i) })];
  table[MINT] = [pairFor(MINT, { priceUsd: "0.5" })];
  const dex = dexMock(table);
  const d = await (await browser(env).send("/api/launchpad", { fetchImpl: dex.fetchImpl })).json();
  assert.equal(dex.seen.length, 2);
  assert.equal(dex.mints()[0].length, 30);
  assert.equal(dex.mints()[1].length, 2);
  const sent = dex.mints().flat();
  assert.deepEqual([...sent].sort(), [MINT, ...Array.from({ length: 31 }, (_, i) => mintNo(i + 1))].sort(), "every launched coin and the token, once each");
  for (const u of dex.seen) { assert.ok(!u.includes(PENDING)); assert.ok(!u.includes(SOL) && !u.includes(USDC) && !u.includes(RAY)); }
  for (const c of d.coins.filter((c) => c.mint)) assert.equal(c.market.priceUsd, Number(c.city.name.slice(5)), c.city.name);
  assert.equal(d.vicinity.market.priceUsd, 0.5);
  assert.equal(d.coins.length, 33);
  assert.deepEqual(d.stats, { live: 32, new: 31, upcoming: 2 }, "$VICINITY has no recorded launch time, so it is live but never New");

  // a popular token with 30 pairs fills the whole answer: the other coin gets a second, smaller call
  _resetLaunchpad(); _resetMarket();
  const env2 = LP({ VICINITY_MINT: MINT });
  await seedCoin(env2.DB, { city: 5142056, name: "Utica", mint: CITY_COIN });
  const crowded = dexMock({ [MINT]: Array.from({ length: 30 }, (_, i) => pairFor(MINT, { pairAddress: mintNo(100 + i), liquidity: { usd: i } })), [CITY_COIN]: [pairFor(CITY_COIN)] });
  const d2 = await (await browser(env2).send("/api/launchpad", { fetchImpl: crowded.fetchImpl })).json();
  assert.deepEqual(crowded.mints(), [[MINT, CITY_COIN], [CITY_COIN]]);
  assert.equal(d2.vicinity.market.pairAddress, mintNo(129), "the most liquid of the 30");
  assert.equal(d2.coins[0].market.priceUsd, 0.0012);
});

test("the DexScreener request ceiling: a batch whose answers keep coming back full is asked at most three times, so a round is at most 3 x ceil(mints / 30) requests, and DEPLOY.md says so", async () => {
  // every mint has 30 pairs: every answer is full and crowds the rest of its batch out, so the top-ups run to their limit
  const table = {};
  for (let i = 1; i <= 63; i++) table[mintNo(i)] = Array.from({ length: 30 }, (_, k) => pairFor(mintNo(i), { pairAddress: mintNo(200 + k) }));
  const one = dexMock(table);
  const r = await marketFor(Array.from({ length: 30 }, (_, i) => mintNo(i + 1)), one.fetchImpl, { now: clock.now });
  assert.deepEqual(one.mints().map((m) => m.length), [30, 29, 28], "one batch: the request and two top-ups, then the batch is let go");
  assert.deepEqual([r.ok, [...r.markets.values()].filter(Boolean).length], [true, 3], "each full answer gave exactly one coin its pair");
  _resetMarket();
  const three = dexMock(table);
  await marketFor(Array.from({ length: 63 }, (_, i) => mintNo(i + 1)), three.fetchImpl, { now: clock.now });
  assert.equal(three.seen.length, 9, "3 x ceil(63 / 30): the ceiling the operations guide must state");
  // the guide sizes against DexScreener's 300 requests a minute from this sentence, so it must not undercount the top-ups
  const deploy = readFileSync(new URL("../docs/DEPLOY.md", import.meta.url), "utf8");
  assert.ok(!deploy.includes("at most one round of `ceil(coins / 30)` requests"), "the old sentence counted one request per batch and no top-ups");
  assert.match(deploy, /at most one round every 30 seconds per server, a round being up to 3 × `ceil\(coins \/ 30\)` requests/);
  assert.match(deploy, /retried once/, "the one retry after a network error or timeout is part of the count too");
});

test("DexScreener down (5xx): every market is null, the answer is kept only 5 seconds, and no new call is made for 5 seconds", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  await seedCoin(env.DB, { city: 5142056, name: "Utica", mint: CITY_COIN });
  const down = dexMock({}, { status: 503 });
  const noisy = console.error; const logged = [];
  console.error = (...a) => { logged.push(a.join(" ")); };
  try {
    const res = await browser(env).send("/api/launchpad", { fetchImpl: down.fetchImpl });
    assert.equal(res.status, 200, "the list still answers");
    assert.equal(res.headers.get("cache-control"), "public, max-age=5");
    const d = await res.json();
    assert.deepEqual([d.ok, d.coins[0].status], [true, "live"]);
    noNumbers(d.coins[0].market); noNumbers(d.vicinity.market);
    assert.match(d.vicinity.market.missing.price, /DEX Screener could not be reached/);
    assert.equal(down.seen.length, 1);
    advance(2_000);
    await browser(env).send("/api/launchpad", { fetchImpl: down.fetchImpl });
    assert.equal(down.seen.length, 1, "within 5 seconds nobody asks again");
    advance(4_000);
    const up = dexMock({ [CITY_COIN]: [pairFor(CITY_COIN)], [MINT]: [pairFor(MINT)] });
    const ok = await browser(env).send("/api/launchpad", { fetchImpl: up.fetchImpl });
    assert.equal(up.seen.length, 1, "after 5 seconds the next viewer retries");
    assert.equal(ok.headers.get("cache-control"), "public, max-age=30");
    assert.equal((await ok.json()).coins[0].market.priceUsd, 0.0012);
  } finally { console.error = noisy; }
  assert.ok(logged.some((l) => /market data unavailable dex_http_503/.test(l)), logged.join("\n"));
  assert.ok(logged.every((l) => !/[1-9A-HJ-NP-Za-km-z]{32,}/.test(l)), "no address in the log");
});

test("DexScreener timeout or network error: one retry, then null for every mint, never a throw; a bad body counts as down (pairs: null does not)", async () => {
  const noisy = console.error; console.error = () => {};
  try {
    const hang = dexMock({}, { hang: true });
    const r = await marketFor([CITY_COIN, MINT], hang.fetchImpl, { now: clock.now, timeoutMs: 30 });
    assert.deepEqual([r.ok, [...r.markets]], [false, [[CITY_COIN, null], [MINT, null]]]);
    assert.equal(hang.seen.length, 2, "the call and its one retry");
    assert.equal((await marketFor([CITY_COIN], hang.fetchImpl, { now: clock.now + 1000 })).ok, false);
    assert.equal(hang.seen.length, 2, "the negative cache holds for 5 seconds");
    assert.equal((await marketFor([CITY_COIN], hang.fetchImpl, { now: clock.now + 5001, timeoutMs: 30 })).ok, false);
    assert.equal(hang.seen.length, 4);

    _resetMarket();
    const broken = dexMock({}, { fail: true });
    assert.equal((await marketFor([CITY_COIN], broken.fetchImpl, { now: clock.now })).ok, false);
    assert.equal(broken.seen.length, 2);

    _resetMarket();
    const junk = { fetchImpl: async () => new Response("not json") };
    assert.equal((await marketFor([CITY_COIN], junk.fetchImpl, { now: clock.now })).ok, false);
    _resetMarket();
    const noKey = { fetchImpl: async () => new Response(JSON.stringify({ schemaVersion: "1.0.0" })) };
    assert.equal((await marketFor([CITY_COIN], noKey.fetchImpl, { now: clock.now })).ok, false, "no pairs field at all: a bad answer");

    // nothing to ask: no call, ok
    _resetMarket();
    const idle = dexMock();
    assert.deepEqual(await marketFor([], idle.fetchImpl), { markets: new Map(), ok: true });
    assert.deepEqual(await marketFor(["not-a-mint", null], idle.fetchImpl), { markets: new Map(), ok: true });
    assert.deepEqual(idle.seen, []);
  } finally { console.error = noisy; }
});

test("DexScreener's pairs: null (a token with no pair yet, as $VICINITY right after launch) is an empty answer, not an outage: no error log, the 30-second copy", async () => {
  // measured 3 Oct 2026: GET api.dexscreener.com/latest/dex/tokens/<the real mint> -> 200 {"schemaVersion":"1.0.0","pairs":null}
  const nullPairs = (seen) => async (url, init) => {
    if (!String(url).startsWith("https://api.dexscreener.com/")) return dexMock().fetchImpl(url, init);
    seen.push(String(url));
    return new Response(JSON.stringify({ schemaVersion: "1.0.0", pairs: null }), { headers: { "content-type": "application/json" } });
  };
  const noisy = console.error; const logged = [];
  console.error = (...a) => { logged.push(a.join(" ")); };
  try {
    const seen = [];
    const r = await marketFor([CITY_COIN, MINT], nullPairs(seen), { now: clock.now });
    assert.deepEqual([r.ok, [...r.markets]], [true, [[CITY_COIN, null], [MINT, null]]]);
    assert.equal(seen.length, 1);
    assert.equal((await marketFor([MINT], nullPairs(seen), { now: clock.now + 1000 })).ok, true, "no 5-second negative window afterwards");
    assert.equal(seen.length, 2);

    _resetMarket();
    const env = LP({ VICINITY_MINT: MINT });
    const lp = [];
    const res = await browser(env).send("/api/launchpad", { fetchImpl: nullPairs(lp) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=30", "the healthy 30-second copy, not the 5-second degraded one");
    const d = await res.json();
    assert.equal(d.vicinity.status, "live");
    noNumbers(d.vicinity.market); // the page still shows its dash for the price, with the reason
    assert.match(d.vicinity.market.missing.price, /no DEX Screener pool/);
    advance(10_000);
    await browser(env).send("/api/launchpad", { fetchImpl: nullPairs(lp) });
    assert.equal(lp.length, 1, "10 seconds later the answer is still the remembered copy");
  } finally { console.error = noisy; }
  assert.deepEqual(logged.filter((l) => /market data unavailable/.test(l)), [], "nothing logged as an outage");
});

test("the real $VICINITY carries its launch time (3 Oct 2026 16:48:12 UTC), so it counts as New for its first 7 days; a test mint has none", async () => {
  // live 3 Oct 2026: stats {"live":1,"new":0}, vicinity.launchedAt null, and the New tab said "No coin went live in the last 7 days"
  const REAL = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
  useClock("2026-10-04T12:00:00Z");
  const d = await (await browser(LP({ VICINITY_MINT: REAL })).send("/api/launchpad", { fetchImpl: dexMock().fetchImpl })).json();
  assert.deepEqual([d.vicinity.status, d.vicinity.launchedAt, d.stats.new], ["live", "2026-10-03T16:48:12.000Z", 1]);
  _resetLaunchpad();
  useClock("2026-10-10T16:48:13Z");
  assert.equal((await (await browser(LP({ VICINITY_MINT: REAL })).send("/api/launchpad", { fetchImpl: dexMock().fetchImpl })).json()).stats.new, 0, "7 days later it is no longer new");
  _resetLaunchpad();
  const test = await (await browser(LP({ VICINITY_MINT: MINT })).send("/api/launchpad", { fetchImpl: dexMock().fetchImpl })).json();
  assert.equal(test.vicinity.launchedAt, null, "a mint without a recorded launch time stays null, as before");
});

test("one upstream round per server per 30 seconds: many viewers at once share it, and the edge cache keeps the same answer for everyone in a region", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  await seedCoin(env.DB, { city: 5142056, name: "Utica", mint: CITY_COIN });
  const dex = dexMock({ [CITY_COIN]: [pairFor(CITY_COIN)], [MINT]: [pairFor(MINT)] });
  const b = browser(env);
  const answers = await Promise.all(Array.from({ length: 8 }, () => b.send("/api/launchpad", { fetchImpl: dex.fetchImpl }).then((r) => r.text())));
  assert.equal(dex.seen.length, 1, "eight viewers at the same moment: one DexScreener call");
  assert.equal(new Set(answers).size, 1, "and the very same answer");
  advance(29_000);
  await b.send("/api/launchpad", { fetchImpl: dex.fetchImpl });
  assert.equal(dex.seen.length, 1, "29 seconds later: still the copy");
  advance(2_000);
  const fresh = await (await b.send("/api/launchpad", { fetchImpl: dex.fetchImpl })).json();
  assert.equal(dex.seen.length, 2, "after 30 seconds: one new round");
  assert.equal(fresh.asOf, new Date(clock.now).toISOString());

  // the edge cache (caches.default) in front of it: the second server in the region does not even build the answer
  const edge = fakeCaches();
  edge.install();
  try {
    _resetLaunchpad(); advance(31_000);
    const first = await b.send("/api/launchpad", { fetchImpl: dex.fetchImpl });
    assert.equal(dex.seen.length, 3);
    assert.equal(edge.store.size, 1);
    const [[key, entry]] = edge.store;
    assert.equal(key, `https://cache.vicinity.internal/launchpad-${MINT}`);
    assert.equal(entry.maxAge, 30);
    _resetLaunchpad(); // "another server": no copy of its own
    const second = await b.send("/api/launchpad", { fetchImpl: dex.fetchImpl });
    assert.equal(dex.seen.length, 3, "served from the edge, nothing built");
    assert.equal(await second.text(), await first.text());
    advance(31_000);
    await b.send("/api/launchpad", { fetchImpl: dex.fetchImpl });
    assert.equal(dex.seen.length, 4, "the edge copy expired with the same 30 seconds");
    // a failed market round is kept only 5 seconds at the edge too
    _resetLaunchpad(); _resetMarket(); advance(31_000);
    await b.send("/api/launchpad", { fetchImpl: dexMock({}, { status: 500 }).fetchImpl });
    assert.equal([...edge.store.values()].pop().maxAge, 5);
  } finally { edge.uninstall(); }
});

test("coin_stats cannot be made: the list still answers (holder counts missing), briefly cached, recovers on its own; a broken database answers 503 launchpad_unavailable", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  await seedCoin(env.DB, { city: 5142056, name: "Utica", mint: CITY_COIN });
  const broken = { on: true };
  const real = env.DB;
  const wrap = (stmt) => ({ sql: stmt.sql, params: stmt.params, inner: stmt, bind: (...p) => wrap(stmt.bind(...p)), first: (...a) => stmt.first(...a), all: () => stmt.all(),
    run: () => (broken.on && /CREATE TABLE IF NOT EXISTS coin_stats/.test(stmt.sql) ? Promise.reject(new Error("D1_ERROR: disk I/O error")) : stmt.run()) });
  env.DB = { ...real, prepare: (sql) => wrap(real.prepare(sql)), batch: (list) => real.batch(list.map((s) => s.inner || s)) };
  const dex = dexMock({ [CITY_COIN]: [pairFor(CITY_COIN)], [MINT]: [pairFor(MINT)] });
  const noisy = console.error; const logged = [];
  console.error = (...a) => { logged.push(a.join(" ")); };
  try {
    const res = await browser(env).send("/api/launchpad", { fetchImpl: dex.fetchImpl });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=5");
    const d = await res.json();
    assert.deepEqual([d.coins[0].holders, d.vicinity.holders, d.coins[0].market.priceUsd], [null, null, 0.0012], "everything but the holder counts");
    broken.on = false; advance(6_000);
    await tick(env, { sample: false });
    const ok = await (await browser(env).send("/api/launchpad", { fetchImpl: dex.fetchImpl })).json();
    assert.equal(ok.coins[0].holders.count, 0, "the table exists now and the job wrote to it");

    // the whole database failing: only this route says so, with no stack or address in the log
    env.DB = { ...real, prepare: () => ({ bind() { return this; }, first: () => Promise.reject(new Error("D1_ERROR: gone")), all: () => Promise.reject(new Error("D1_ERROR: gone")), run: () => Promise.reject(new Error("D1_ERROR: gone")) }), batch: () => Promise.reject(new Error("D1_ERROR: gone")) };
    _resetLaunchpad();
    const bad = await browser(env).send("/api/launchpad", { fetchImpl: dex.fetchImpl });
    assert.equal(bad.status, 503);
    assert.deepEqual(await bad.json(), { ok: false, error: "launchpad_unavailable" });
  } finally { console.error = noisy; }
  assert.ok(logged.some((l) => /coin stats unavailable/.test(l)));
  assert.ok(logged.every((l) => !/[1-9A-HJ-NP-Za-km-z]{32,}/.test(l)), "no address in the log");
});

test("trade links are the dashboard's and the token page's exact addresses; a pair other than SOL is written by its mint on Jupiter", () => {
  assert.deepEqual(tradeLinks(CITY_COIN, SOL), {
    raydium: `https://raydium.io/launchpad/token/?mint=${CITY_COIN}`, jupiter: `https://jup.ag/swap/SOL-${CITY_COIN}`,
    dexscreener: `https://dexscreener.com/solana/${CITY_COIN}`, solscan: `https://solscan.io/token/${CITY_COIN}`,
  });
  assert.equal(tradeLinks(CITY_COIN, USDC).jupiter, `https://jup.ag/swap/${USDC}-${CITY_COIN}`);
  assert.equal(tradeLinks(CITY_COIN, null).jupiter, `https://jup.ag/swap/SOL-${CITY_COIN}`);
  assert.equal(tradeLinks(null, SOL), null);
});

test("a founder without a username shows no handle (never a name made from the wallet); a steward, a provisional and a grace seat keep their status word", async () => {
  const env = LP();
  const a = await person(env, { home: IN_UTICA }), b = await person(env, { home: IN_NYC }), c = await person(env, { home: IN_UTICA });
  await env.DB.prepare("UPDATE users SET handle = NULL, name = NULL WHERE wallet = ?").bind(a.w.address).run();
  await seedSeat(env, a, { city: 5142056, name: "Utica", status: "steward" });
  await seedSeat(env, b, { city: 5128581, name: "New York City", status: "provisional", handle: "bigapple" });
  await env.DB.prepare("UPDATE users SET handle = NULL, name = 'Pat' WHERE wallet = ?").bind(c.w.address).run();
  await seedSeat(env, c, { city: 5106834, name: "Albany", status: "grace" });
  await seedCoin(env.DB, { city: 5142056, name: "Utica" });
  await seedCoin(env.DB, { city: 5128581, name: "New York City" });
  await seedCoin(env.DB, { city: 5106834, name: "Albany" });
  const d = await (await browser(env).send("/api/launchpad", { fetchImpl: dexMock().fetchImpl })).json();
  const utica = d.coins.find((c) => c.city.id === "5142056"), nyc = d.coins.find((c) => c.city.id === "5128581"), albany = d.coins.find((c) => c.city.id === "5106834");
  assert.deepEqual(utica.founder, { handle: null, wallet: `${a.w.address.slice(0, 5)}*****${a.w.address.slice(-3)}`, status: "steward" });
  assert.deepEqual(nyc.founder, { handle: "bigapple", wallet: `${b.w.address.slice(0, 5)}*****${b.w.address.slice(-3)}`, status: "provisional" });
  assert.deepEqual(albany.founder, { handle: null, wallet: `${c.w.address.slice(0, 5)}*****${c.w.address.slice(-3)}`, status: "grace" }, "no username: no handle (a display name must never read as one)");
  assert.ok(!JSON.stringify(d).includes('"Pat"'), "the display name is nowhere in the answer");
  assert.deepEqual(d.coins.map((c) => c.ticker).sort(), ["ALBANY", "NYC", "UTICA"]);
  // a seat that ended is no founder
  await env.DB.prepare("UPDATE seats SET status = 'released', ended_at = ? WHERE city_id = '5142056'").bind(new Date(clock.now).toISOString()).run();
  _resetLaunchpad();
  assert.equal((await (await browser(env).send("/api/launchpad", { fetchImpl: dexMock().fetchImpl })).json()).coins.find((c) => c.city.id === "5142056").founder, null);
});

test("a coin's community outside the 300 largest (where the map's /api/members list stops) still gets its member and holder counts", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  await ensureSchema(env.DB);
  // 300 communities of three people, written straight into users (throwaway values): Utica, with two, is then not among the 300 the map lists
  const t = new Date(clock.now).toISOString(), rows = [];
  for (let i = 1; i <= 300; i++) for (let k = 0; k < 3; k++) {
    rows.push(env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, name, home_city, home_name, home_country, home_at, created_at) VALUES (?, 'google', ?, 'Someone', ?, ?, 'US', ?, ?)")
      .bind(`test-wallet-${i}-${k}`, `test-${i}-${k}`, `c${i}`, `Community ${i}`, t, t));
  }
  await env.DB.batch(rows);
  await person(env, { home: IN_UTICA, holds: 50 });
  await person(env, { home: IN_UTICA });
  await seedCoin(env.DB, { city: 5142056, name: "Utica", mint: CITY_COIN });
  await tick(env); // the balance sample the holder count is read from
  const b = browser(env);
  const mem = await b.get("/api/members");
  assert.equal(mem.communities.length, 300);
  assert.equal(mem.communities.some((c) => c.id === "5142056"), false, "the map's list stops at the 300 largest communities: Utica is not on it");
  const d = await (await b.send("/api/launchpad", { fetchImpl: dexMock().fetchImpl })).json();
  assert.deepEqual(d.coins[0].members, { members: 2, holders: 1 }, "counted for the coin's community itself, by the rule of /api/members, not read from its capped list");
  assert.deepEqual(d.coins[0].city, { id: "5142056", name: "Utica", country: "US" });
});

test("holder counts come from the job: a coin launched after the last run shows no count until the next run", async () => {
  const env = LP({ VICINITY_MINT: MINT });
  setHolding((await person(env, { home: IN_UTICA })).w.address, 12);
  await seedCoin(env.DB, { city: 5142056, name: "Utica", mint: CITY_COIN });
  await tick(env, { sample: false });
  await seedCoin(env.DB, { city: 5140405, name: "Syracuse", mint: mintNo(2), launchedAt: new Date(clock.now).toISOString() });
  const dex = dexMock();
  const d = await (await browser(env).send("/api/launchpad", { fetchImpl: dex.fetchImpl })).json();
  assert.deepEqual([d.coins.find((c) => c.city.id === "5142056").holders, d.coins.find((c) => c.city.id === "5140405").holders], [{ count: 1, asOf: new Date(clock.now).toISOString() }, null]);
  advance(600_000);
  await tick(env, { sample: false });
  const d2 = await (await browser(env).send("/api/launchpad", { fetchImpl: dex.fetchImpl })).json();
  assert.equal(d2.coins.find((c) => c.city.id === "5140405").holders.count, 1);
});
