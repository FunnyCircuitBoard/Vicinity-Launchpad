// The Launchpad's live market sources (LAUNCHPAD_V2=on): the LaunchLab curve read from the chain (src/launchlab.js), Jupiter,
// Raydium LaunchLab and DEX Screener combined per coin (src/marketlive.js) on top of src/sources.js. Every source is faked with
// the REAL answers recorded on 6 Oct 2026 (test/fixtures/launchlab/); nothing here touches the network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { MINT, clock, realClock, useClock } from "./helpers/world.js";
import { CITY_COIN, pairFor } from "./helpers/launchpad.js";
import { INCOGNITO, JSON_TYPE, LAUNCHLAB, REAL_MINT, REAL_POOL, SOL, fixture, marketWorld, poolAccount } from "./helpers/market.js";
import { decodePool, findProgramAddress, poolAddress, readCurves, _resetLaunchlab } from "../src/launchlab.js";
import { Source, SourceError, USER_AGENT, codeOf, getJson, retryAfterMs } from "../src/sources.js";
import { _resetMarketLive, attributionFor, candleOf, combine, fetchKline, jupPriceOf, jupTokenOf, liveMarkets, raydiumMintOf, raydiumTradesFor, tradeOf } from "../src/marketlive.js";
import { _resetMarket } from "../src/market.js";
import { base58Decode } from "../src/solana.js";

beforeEach(() => { useClock("2026-10-06T16:00:00Z"); _resetMarketLive(); _resetLaunchlab(); _resetMarket(); });
after(() => realClock());

const quiet = async (fn) => { const e = console.error; const logged = []; console.error = (...a) => logged.push(a.join(" ")); try { return { value: await fn(), logged }; } finally { console.error = e; } };
const POOL_OF_TEST_MINT = await poolAddress(MINT, SOL);

/* ------------------------------------------------------------------ the pool: identity and decoding */

test("the pool id is derived locally: ['pool', mint, pair] under the LaunchLab program, exactly the pools Raydium and the chain name", async () => {
  assert.equal(await poolAddress(REAL_MINT, SOL), REAL_POOL, "$VICINITY / WSOL, as the chain and Raydium's launch-mint API say");
  assert.equal(await poolAddress(INCOGNITO, SOL), fixture("raymint_graduated.json").data.rows[0].poolId, "a graduated coin too");
  assert.equal(fixture("raymint.json").data.rows[0].poolId, REAL_POOL);
  const [addr, bump] = await findProgramAddress([new TextEncoder().encode("pool"), base58Decode(REAL_MINT), base58Decode(SOL)], LAUNCHLAB);
  assert.deepEqual([addr, typeof bump], [REAL_POOL, "number"]);
  assert.notEqual(await poolAddress(REAL_MINT, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), REAL_POOL, "another pair, another pool");
  assert.equal(await poolAddress("nope", SOL), null);
});

test("the recorded pool account decodes to the research's numbers exactly: price 6.233650881956076e-8 SOL, 14.7955 of 85 SOL raised (17.4065 %)", () => {
  const rec = fixture("pool.json").result;
  const c = decodePool(rec.value, { mint: REAL_MINT, pairMint: SOL, poolId: REAL_POOL, slot: rec.context.slot });
  assert.equal(c.priceNative, 6.233650881956076e-8, "the SDK's getPoolPrice, equal to Raydium's last kline close");
  assert.equal(c.priceNative, fixture("kline_15m.json").data.rows[0].c, "and to Raydium's own chart, to the last digit");
  assert.deepEqual([c.stage, c.status, c.symbol, c.raised, c.target, c.supply, c.tokensForSale, c.slot, c.poolId], ["curve", 0, "SOL", 14.795544124, 85, 1e9, 793100000, 453948825, REAL_POOL]);
  assert.equal(c.progressPct.toFixed(4), "17.4065");
  assert.equal(c.tokensSold.toFixed(2), "354403438.21");
  const g = decodePool(fixture("pool_grad.json").result.value, { mint: INCOGNITO, pairMint: SOL });
  assert.deepEqual([g.stage, g.status, g.progressPct, g.raised >= g.target], ["graduated", 2, 100, true], "status 2: realB reached the 85 SOL target");
});

test("decodePool refuses anything that is not exactly our coin's LaunchLab pool", () => {
  const ok = poolAccount(REAL_MINT);
  const opts = { mint: REAL_MINT, pairMint: SOL };
  assert.ok(decodePool(ok, opts));
  const patched = (fn) => poolAccount(REAL_MINT, { patch: fn });
  const cases = {
    "another program": { ...ok, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
    "jsonParsed data": { ...ok, data: { parsed: {} } },
    "not base64": { ...ok, data: ["@@@", "base64"] },
    "wrong size": { ...ok, data: [Buffer.from(new Uint8Array(428)).toString("base64"), "base64"] },
    "wrong discriminator": patched((b) => { b[0] ^= 1; }),
    "unknown status": patched((b) => { b[17] = 7; }),
    "coin decimals not 6": patched((b) => { b[18] = 9; }),
    "pair decimals not SOL's": patched((b) => { b[19] = 6; }),
    "no target": patched((b) => b.fill(0, 69, 77)),
    "virtualA not above realA": patched((b) => { b.set(b.slice(37, 45), 53); }),
    "no supply": patched((b) => b.fill(0, 21, 29)),
  };
  for (const [why, acc] of Object.entries(cases)) assert.equal(decodePool(acc, opts), null, why);
  assert.equal(decodePool(ok, { mint: CITY_COIN, pairMint: SOL }), null, "another coin's pool");
  assert.equal(decodePool(ok, { mint: REAL_MINT, pairMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), null, "another pair");
  assert.equal(decodePool(null, opts), null);
  assert.equal(decodePool(ok, { mint: REAL_MINT, pairMint: "11111111111111111111111111111111" }), null, "a pair we do not know");
});

test("readCurves: one getMultipleAccounts for every pool, kept 30 seconds; a missing account is null; an RPC failure is undefined and silences the chain for 5 seconds", async () => {
  const w = await marketWorld(MINT, { pools: { [POOL_OF_TEST_MINT]: poolAccount(MINT) } });
  const coins = [{ mint: MINT, pairMint: SOL }, { mint: CITY_COIN, pairMint: SOL }];
  const r = await readCurves({}, coins, w.fetchImpl, { now: clock.now });
  assert.equal(r.ok, true);
  assert.equal(r.curves.get(MINT).priceNative, 6.233650881956076e-8);
  assert.equal(r.curves.get(MINT).poolId, POOL_OF_TEST_MINT);
  assert.equal(r.curves.get(CITY_COIN), null, "no account: no curve");
  assert.equal(w.count("solana"), 1);
  await readCurves({}, coins, w.fetchImpl, { now: clock.now + 29_000 });
  assert.equal(w.count("solana"), 1, "29 s later: from memory");
  await readCurves({}, coins, w.fetchImpl, { now: clock.now + 30_000 });
  assert.equal(w.count("solana"), 2);

  _resetLaunchlab();
  const down = await marketWorld(MINT, { rpcMode: "http500" });
  const d = await readCurves({}, coins, down.fetchImpl, { now: clock.now });
  assert.deepEqual([d.ok, d.error, d.curves.get(MINT)], [false, "rpc_http_500", undefined]);
  await readCurves({}, coins, down.fetchImpl, { now: clock.now + 4_000 });
  assert.equal(down.count("solana"), 1, "within 5 seconds nobody asks again");
  assert.equal((await readCurves({}, coins, w.fetchImpl, { now: clock.now + 3_000 })).curves.get(MINT), undefined, "not even another caller");
  // the last good copy is used (marked stale) while the chain is down
  _resetLaunchlab();
  await readCurves({}, coins, w.fetchImpl, { now: clock.now });
  const s = await readCurves({}, coins, down.fetchImpl, { now: clock.now + 60_000 });
  assert.deepEqual([s.ok, s.stale, s.curves.get(MINT).priceNative], [false, true, 6.233650881956076e-8]);
  assert.equal((await readCurves({}, coins, down.fetchImpl, { now: clock.now + 6 * 60_000 })).curves.get(MINT), undefined, "never older than 5 minutes");
});

/* ------------------------------------------------------------------ the shared plumbing */

test("getJson: our User-Agent, JSON only (a Cloudflare challenge page is a failure), 403 and 429 are failures with Retry-After, one retry after a network error or a timeout", async () => {
  const seen = [];
  const answer = (res) => async (url, init) => { seen.push(new Headers(init.headers).get("user-agent")); return typeof res === "function" ? res() : res.clone(); };
  assert.deepEqual(await getJson("https://x.test/a", answer(new Response('{"a":1}', { headers: JSON_TYPE }))), { a: 1 });
  assert.equal(seen[0], USER_AGENT);
  assert.equal(USER_AGENT, "vicinity.city/1.0 (+https://vicinity.city)");
  const fails = async (res, code) => { await assert.rejects(getJson("https://x.test/a", answer(res)), (e) => e instanceof SourceError && e.code === code); };
  await fails(new Response("<!DOCTYPE html><script>challenge</script>", { headers: { "content-type": "text/html" } }), "not_json");
  await fails(new Response("{oops", { headers: JSON_TYPE }), "bad_json");
  await fails(new Response("Forbidden", { status: 403 }), "http_403");
  await fails(new Response("x", { status: 500 }), "http_500");
  await assert.rejects(getJson("https://x.test/a", answer(new Response("{}", { status: 429, headers: { "retry-after": "20" } }))), (e) => e.code === "http_429" && e.retryAfterMs === 20_000);
  await fails(new Response("x".repeat(1_000_001), { headers: JSON_TYPE }), "too_big");
  let n = 0;
  await assert.rejects(getJson("https://x.test/a", async () => { n++; throw new TypeError("fetch failed"); }), (e) => e.code === "network");
  assert.equal(n, 2, "the call and one retry");
  n = 0;
  const hang = async (u, init) => { n++; return new Promise((_, rej) => { const keep = setTimeout(() => rej(new Error("never gave up")), 5_000); init.signal.addEventListener("abort", () => { clearTimeout(keep); rej(new DOMException("t", "TimeoutError")); }); }); };
  await assert.rejects(getJson("https://x.test/a", hang, { timeoutMs: 20 }), (e) => e.code === "timeout");
  assert.equal(n, 2);
  n = 0;
  await assert.rejects(getJson("https://x.test/a", async () => { n++; return new Response("x", { status: 502 }); }), (e) => e.code === "http_502");
  assert.equal(n, 1, "an HTTP answer is never retried");
  assert.equal(retryAfterMs("7"), 7000);
  assert.equal(retryAfterMs(new Date(Date.now() + 9000).toUTCString(), Date.now()) > 7000, true);
  assert.equal(retryAfterMs("soon"), 0);
});

test("Source: per-key memory, one call for the missing keys, callers at the same moment share it, a failure silences it (Retry-After honoured, at most 60 s)", async () => {
  const s = new Source("t", { ttlMs: 30_000, negativeMs: 5_000 });
  const calls = [];
  const ok = async (keys) => { calls.push(keys); await new Promise((r) => setTimeout(r, 5)); return new Map(keys.map((k) => [k, k === "absent" ? null : k.toUpperCase()])); };
  const [a, b] = await Promise.all([s.get(["x", "absent"], 1000, ok), s.get(["x"], 1000, ok)]);
  assert.deepEqual([...a.values], [["x", "X"], ["absent", null]]);
  assert.deepEqual([...b.values], [["x", "X"]]);
  assert.deepEqual(calls, [["x", "absent"]], "the second caller waited for the first call");
  await s.get(["x", "y"], 2000, ok);
  assert.deepEqual(calls[1], ["y"], "only the key it did not have");
  const boom = async () => { throw new SourceError("http_429", 20_000); };
  const f = await s.get(["z"], 40_000, boom);
  assert.deepEqual([f.ok, f.error, f.values.get("z")], [false, "http_429", undefined]);
  const again = await s.get(["z"], 55_000, ok);
  assert.equal(again.ok, false, "20 seconds of silence after Retry-After: 20");
  assert.equal(calls.length, 2);
  assert.equal((await s.get(["z"], 60_001, ok)).ok, true);
  const x = await s.get(["x"], 64_000, boom);
  assert.deepEqual([x.ok, x.stale, x.values.get("x")], [false, true, "X"], "the last good value, marked stale");
  const forever = new Source("t2", { ttlMs: 1 });
  await forever.get(["k"], 0, async () => { throw new SourceError("http_429", 3_600_000); });
  assert.equal(forever.failedUntil, 60_000, "Retry-After is capped at 60 s");
});

/* ------------------------------------------------------------------ field by field */

test("Jupiter's shapes: a missing mint, a string, a negative, an absurd value or a non-object is 'no price'; ranges are checked; unknown fields are dropped", () => {
  const rec = fixture("jup_price.json")[REAL_MINT];
  assert.deepEqual(jupPriceOf(rec), { usdPrice: 0.000007577217833193381, change24hPct: -0.7440200264703254, liquidityUsd: 1779.9587242136834, blockId: 453797234 });
  for (const bad of [undefined, null, "x", [], {}, { usdPrice: -1 }, { usdPrice: 0 }, { usdPrice: "<b>1</b>" }, { usdPrice: 1e9 }, { usdPrice: NaN }, { usdPrice: Infinity }]) assert.equal(jupPriceOf(bad), null, JSON.stringify(bad));
  assert.deepEqual(jupPriceOf({ usdPrice: "0.5", priceChange24h: -150, liquidity: -3, blockId: 1.5 }), { usdPrice: 0.5, change24hPct: null, liquidityUsd: null, blockId: null });
  const t = jupTokenOf(fixture("jup_tok.json")[0]);
  assert.deepEqual(t, { usdPrice: 0.000007577217833193381, mcapUsd: 7577.217833193381, fdvUsd: 7577.217833193381, liquidityUsd: 1779.9587242136834, circSupply: 1e9, totalSupply: 1e9,
    stats24h: { volumeUsd: 221.02457715972727 + 315.17594188232897, buyVolumeUsd: 221.02457715972727, sellVolumeUsd: 315.17594188232897, traders: 18, changePct: -0.7440200264703254 },
    graduatedPool: null, graduatedAt: null, launchlab: true });
  assert.equal(jupTokenOf({ ...fixture("jup_tok.json")[0], stats24h: undefined }).stats24h, null, "no stats24h: no volume (a dash, not 0)");
  assert.equal(jupTokenOf({ ...fixture("jup_tok.json")[0], stats24h: { buyVolume: 5 } }).stats24h.volumeUsd, null, "half the volume is no volume");
  assert.equal(jupTokenOf({ ...fixture("jup_tok.json")[0], stats24h: { buyVolume: 0, sellVolume: 0 } }).stats24h.volumeUsd, 0, "a real 0 stays 0");
  assert.equal(jupTokenOf({ ...fixture("jup_tok.json")[0], mcap: 1e13 }).mcapUsd, null, "junk market caps are refused");
  const g = jupTokenOf(fixture("jup_tok_graduated.json")[0]);
  assert.deepEqual([g.graduatedPool, g.graduatedAt], ["9gJHwbyEn3U7eZyf61sTX31mqPNNhwnyDoA9Fn3pMqdq", "2026-10-05T17:57:19.000Z"]);
  assert.equal(jupTokenOf({ graduatedPool: "<script>", graduatedAt: "yesterday" }).graduatedPool, null);
  assert.equal(jupTokenOf({ metaLaunchpad: "pump.fun", launchpad: "<b>raydium-launchlab</b>" }).launchlab, false, "only Jupiter's exact LaunchLab value counts");
});

test("Raydium's shapes: the launch-mint row must carry OUR pool; trades and candles are checked row by row", () => {
  const row = fixture("raymint.json").data.rows[0];
  assert.deepEqual(raydiumMintOf(row, REAL_POOL), { poolId: REAL_POOL, marketCapUsd: 7540.814774701539, volume24hUsd: 511.48322206997324, volume24hPair: 4.267052429000001, migrateAmmId: null });
  assert.equal(raydiumMintOf(row, "9gJHwbyEn3U7eZyf61sTX31mqPNNhwnyDoA9Fn3pMqdq"), null, "a pool id that is not the derived one is never trusted");
  assert.equal(raydiumMintOf({ ...row, marketCap: 1e13 }, REAL_POOL).marketCapUsd, null);
  assert.equal(raydiumMintOf(fixture("raymint_graduated.json").data.rows[0], "5pkoPNrUTauBF8KNKcXKx4BB6a3x3YimG4B4xfpYcJaJ").migrateAmmId, "9gJHwbyEn3U7eZyf61sTX31mqPNNhwnyDoA9Fn3pMqdq");

  const t = fixture("trade.json").data.rows[0];
  const maxT = Math.floor(clock.now / 1000) + 60;
  assert.deepEqual(tradeOf(t, REAL_POOL, { maxT }), { txid: t.txid, owner: t.owner, at: 1791261811, side: "buy", tokens: 158764.265017, amount: 0.009999621 });
  const bad = {
    "short txid": { txid: "abc" }, "txid with markup": { txid: "<img src=x>" + t.txid.slice(11) }, "owner not an address": { owner: "nobody" },
    "side": { side: "swap" }, "zero tokens": { amountA: 0 }, "negative SOL": { amountB: -1 }, "text amount": { amountA: "lots" },
    "a time in the future": { blockTime: maxT + 1 }, "a time before LaunchLab": { blockTime: 1600000000 }, "a fractional time": { blockTime: 1791261811.5 },
    "another pool": { poolId: "9gJHwbyEn3U7eZyf61sTX31mqPNNhwnyDoA9Fn3pMqdq" },
  };
  for (const [why, over] of Object.entries(bad)) assert.equal(tradeOf({ ...t, ...over }, REAL_POOL, { maxT }), null, why);
  assert.equal(tradeOf(t, REAL_POOL, { maxT, minT: 1791261812 }), null, "before the coin's own launch");

  const k = fixture("kline_15m.json").data.rows[0];
  // Raydium's open is the price before the bucket's first trade (here below the low of the trades): the range includes it
  assert.ok(k.o < k.l, "the recorded row really has its open outside [low, high]");
  assert.deepEqual(candleOf(k, REAL_POOL, 900, { maxT }), [1791261000, 6.22622795471691e-8, 6.233650881956076e-8, 6.22622795471691e-8, 6.233650881956076e-8]);
  const all = fixture("kline_15m.json").data.rows;
  assert.equal(all.map((r) => candleOf(r, REAL_POOL, 900, { maxT })).filter(Boolean).length, all.length, "every recorded row is accepted");
  for (let i = 0; i < all.length - 1; i++) assert.equal(all[i].o, all[i + 1].c, "open = the previous bucket's close, in every recorded row");
  for (const [why, over] of Object.entries({ "not on the 15-minute grid": { t: k.t + 60 }, "high below the close": { h: k.c / 2 }, "low above the close": { l: k.c * 2 }, "low above the high": { l: k.h * 2, c: k.h * 2 }, "zero": { o: 0 }, "string": { c: "1e-8x" }, "future": { t: maxT + 900 }, "another pool": { poolId: CITY_COIN } })) {
    assert.equal(candleOf({ ...k, ...over }, REAL_POOL, 900, { maxT }), null, why);
  }
});

/* ------------------------------------------------------------------ one market per coin */

test("$VICINITY from the recorded answers: Jupiter's last-trade price, mcap, 24 h volume (buy + sell), traders and change; SOL in the curve as liquidity; the curve's progress", async () => {
  const w = await marketWorld(MINT);
  const r = await liveMarkets({}, [{ mint: MINT, pairMint: SOL }], w.fetchImpl, { now: clock.now });
  assert.deepEqual([r.ok, r.errors], [true, []]);
  const m = r.markets.get(MINT);
  const solUsd = fixture("jup_price.json")[SOL].usdPrice;
  assert.equal(m.priceUsd, 0.000007577217833193381);
  assert.equal(m.marketCapUsd, 7577.217833193381);
  assert.equal(m.fdvUsd, 7577.217833193381);
  assert.equal(m.volume24hUsd, 221.02457715972727 + 315.17594188232897);
  assert.equal(m.traders24h, 18);
  assert.equal(m.priceChange24hPct, -0.7440200264703254);
  assert.equal(m.liquidityUsd, 14.795544124 * solUsd, "the SOL the curve holds, at Jupiter's SOL price: never called pool liquidity");
  assert.equal(Math.abs(m.liquidityUsd - 1779.9587242136834) / 1779.9587242136834 < 0.01, true, "and within 1 % of Jupiter's own liquidity figure");
  assert.deepEqual([m.liquidityKind, m.stage, m.priceNative, m.nativeSymbol, m.pairAddress, m.dex], ["bonding_curve", "curve", 6.233650881956076e-8, "SOL", null, null]);
  assert.equal(m.url, `https://raydium.io/launchpad/token/?mint=${MINT}`);
  assert.deepEqual(m.curve, { poolId: POOL_OF_TEST_MINT, stage: "curve", symbol: "SOL", raised: 14.795544124, target: 85, progressPct: m.curve.progressPct, tokensSold: m.curve.tokensSold,
    tokensForSale: 793100000, supply: 1e9, slot: 453948825 });
  assert.equal(m.curve.progressPct.toFixed(2), "17.41");
  assert.deepEqual(m.sources, { price: "Jupiter (last trade)", marketCap: "Jupiter", fdv: "Jupiter", liquidity: "SOL in the bonding curve (on-chain) × SOL price (Jupiter)",
    volume24h: "Jupiter", change24h: "Jupiter", curve: "Solana blockchain, read by vicinity.city" });
  assert.deepEqual([m.missing, m.stale], [{}, false]);
  assert.ok(!JSON.stringify(m).includes("codes"), "the internal source codes are never serialised");
  assert.deepEqual(attributionFor(r.used).map((a) => a.text), ["Price, market cap, 24 h volume & change: Jupiter · Powered by Jupiter", "Bonding curve & SOL raised: Solana blockchain, read by vicinity.city"]);
  // the calls: one Jupiter price (coin + SOL), one Jupiter token search, one RPC, one DEX Screener (pairs: null); Raydium not needed
  assert.deepEqual(w.hosts().sort(), ["api.dexscreener.com", "api.mainnet-beta.solana.com", "lite-api.jup.ag"]);
  assert.deepEqual(w.urls("jup.ag").map((u) => new URL(u).pathname + new URL(u).search), [`/price/v3?ids=${MINT},${SOL}`, `/tokens/v2/search?query=${MINT}`]);
  assert.ok(w.log.filter((x) => /jup\.ag|raydium/.test(x.host)).every((x) => x.ua === "vicinity.city/1.0 (+https://vicinity.city)"), "our User-Agent on every new source");
});

test("Jupiter leaves the coin out (no trade in 7 days): the price is the on-chain curve × SOL, exact and labelled; market cap = price × the curve's supply; volume from Raydium", async () => {
  const w = await marketWorld(MINT, { jup: { prices: { [SOL]: fixture("jup_price.json")[SOL] } }, tokens: { items: [] } });
  const r = await liveMarkets({}, [{ mint: MINT, pairMint: SOL }], w.fetchImpl, { now: clock.now });
  const m = r.markets.get(MINT);
  const solUsd = fixture("jup_price.json")[SOL].usdPrice;
  assert.equal(m.priceUsd, 6.233650881956076e-8 * solUsd);
  assert.equal(m.sources.price, "On-chain curve × SOL price (Jupiter)");
  assert.equal(m.marketCapUsd, m.priceUsd * 1e9);
  assert.equal(m.sources.marketCap, "Price × on-chain supply");
  assert.equal(m.volume24hUsd, 511.48322206997324, "Raydium's rolling 24 h volume, asked only because Jupiter had none");
  assert.equal(m.sources.volume24h, "Raydium LaunchLab");
  assert.equal(m.traders24h, null, "traders only come with Jupiter's volume");
  assert.equal(m.priceChange24hPct, null);
  assert.equal(m.missing.change24h, "Jupiter has no price for it (no trade in the last 7 days); no DEX Screener pool");
  assert.equal(w.count("launch-mint-v1.raydium.io"), 1);
  assert.match(w.urls("launch-mint-v1")[0], new RegExp(`\\?ids=${MINT}$`));
});

test("every source down: no number is invented; each one is '—' with its reason; the chain alone still gives the curve; the answer says it failed", async () => {
  const w = await marketWorld(MINT, { jup: { mode: "http429" }, tokens: { mode: "html" }, raydium: { mode: "http500" } });
  const r = await liveMarkets({}, [{ mint: MINT, pairMint: SOL }], w.fetchImpl, { now: clock.now });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.sort(), ["jupiter_price:http_429", "jupiter_tokens:not_json", "raydium_mint:http_500"]);
  const m = r.markets.get(MINT);
  for (const k of ["priceUsd", "marketCapUsd", "fdvUsd", "liquidityUsd", "volume24hUsd", "priceChange24hPct"]) assert.equal(m[k], null, k);
  assert.equal(m.priceNative, 6.233650881956076e-8, "the curve's own price in SOL is still known");
  assert.equal(m.curve.progressPct.toFixed(4), "17.4065");
  assert.deepEqual(m.missing, {
    price: "Jupiter could not be reached; no SOL price; no DEX Screener pool",
    marketCap: "no price to multiply; Jupiter could not be reached",
    liquidity: "no SOL price",
    volume24h: "Jupiter could not be reached; Raydium could not be reached; no DEX Screener pool",
    change24h: "Jupiter could not be reached; no DEX Screener pool",
  });
  // and the chain down too: nothing at all, still no throw
  _resetMarketLive(); _resetLaunchlab();
  const dead = await marketWorld(MINT, { jup: { mode: "neterr" }, tokens: { mode: "badjson" }, rpcMode: "http500" });
  const d = (await liveMarkets({}, [{ mint: MINT, pairMint: SOL }], dead.fetchImpl, { now: clock.now })).markets.get(MINT);
  assert.deepEqual([d.priceUsd, d.priceNative, d.curve, d.stage], [null, null, null, null]);
  assert.equal(d.missing.price, "Jupiter could not be reached; the chain could not be read; no DEX Screener pool");
});

test("stale: within 5 minutes of a good answer a failed Jupiter call gives the last price, marked stale; the sources are asked at most once per 30 s (prices) and 60 s (tokens)", async () => {
  const w = await marketWorld(MINT);
  const coins = [{ mint: MINT, pairMint: SOL }];
  await liveMarkets({}, coins, w.fetchImpl, { now: clock.now });
  await liveMarkets({}, coins, w.fetchImpl, { now: clock.now + 20_000 });
  assert.deepEqual([w.count("jup.ag"), w.count("solana"), w.count("dexscreener")], [2, 1, 1], "20 s later: everything from memory");
  await liveMarkets({}, coins, w.fetchImpl, { now: clock.now + 31_000 });
  assert.deepEqual(w.urls("jup.ag").map((u) => new URL(u).pathname), ["/price/v3", "/tokens/v2/search", "/price/v3"], "31 s: prices again, the token search (60 s) not yet");
  w.jup.mode = "http500";
  const s = await liveMarkets({}, coins, w.fetchImpl, { now: clock.now + 70_000 });
  const m = s.markets.get(MINT);
  assert.deepEqual([s.ok, m.stale, m.priceUsd], [false, true, 0.000007577217833193381]);
});

test("graduated (chain status 2): no curve price, pool liquidity from DEX Screener, Jupiter's price as before; a DEX Screener pair is never invented before it", async () => {
  const pool = await poolAddress(MINT, SOL);
  const w = await marketWorld(MINT, {
    pools: { [pool]: poolAccount(MINT, { graduated: true }) },
    tokens: { items: [{ ...fixture("jup_tok_graduated.json")[0], id: MINT }] },
    dex: { [MINT]: [pairFor(MINT, { liquidity: { usd: 22764 }, pairAddress: "9gJHwbyEn3U7eZyf61sTX31mqPNNhwnyDoA9Fn3pMqdq" })] },
  });
  const m = (await liveMarkets({}, [{ mint: MINT, pairMint: SOL }], w.fetchImpl, { now: clock.now })).markets.get(MINT);
  assert.deepEqual([m.stage, m.curve.stage, m.curve.progressPct, m.priceNative], ["graduated", "graduated", 100, null]);
  assert.deepEqual([m.liquidityUsd, m.liquidityKind, m.sources.liquidity], [22764, "pool", "DEX Screener"]);
  assert.equal(m.pairAddress, "9gJHwbyEn3U7eZyf61sTX31mqPNNhwnyDoA9Fn3pMqdq");
  assert.equal(m.sources.price, "Jupiter (last trade)");
  assert.equal(m.volume24hUsd, 390402.3203604319 + 372235.537575298);
  // the pure combiner: Jupiter's graduatedPool alone (chain unknown) says graduated too
  const c = combine({ mint: MINT }, { curve: null, curveState: undefined, jt: jupTokenOf(fixture("jup_tok_graduated.json")[0]), jtState: {}, dxAsked: false });
  assert.equal(c.stage, "graduated");
});

test("allow-listed mints only, in batches: 50 ids per Jupiter price call, 100 per token search, the pairs asked once, Raydium only for curve coins that lack a volume", async () => {
  const mints = [MINT, CITY_COIN];
  const w = await marketWorld(MINT, { tokens: { items: [] } });
  await liveMarkets({}, mints.map((m) => ({ mint: m, pairMint: SOL })), w.fetchImpl, { now: clock.now });
  assert.deepEqual(w.urls("jup.ag").map((u) => decodeURIComponent(new URL(u).search)), [`?ids=${MINT},${CITY_COIN},${SOL}`, `?query=${MINT},${CITY_COIN}`]);
  assert.deepEqual(w.urls("launch-mint-v1").map((u) => new URL(u).search), [`?ids=${MINT}`], "CITY_COIN has no curve: Raydium is not asked about it");
  const sent = w.log.map((x) => x.url).join(" ");
  assert.ok(!sent.includes("PendMint"), "nothing else is ever sent");
  // nothing to ask: no call at all
  const idle = await marketWorld(MINT);
  const r = await liveMarkets({}, [{ mint: "not-a-mint" }], idle.fetchImpl, { now: clock.now });
  assert.deepEqual([r.markets.size, idle.log.length], [0, 0]);
});

test("Raydium trades and candles: validated, newest first for trades, oldest first for candles, paging keys checked, an unknown pool is an empty list", async () => {
  const w = await marketWorld(MINT);
  const t = await raydiumTradesFor(POOL_OF_TEST_MINT, w.fetchImpl, { now: clock.now });
  const rows = t.values.get(POOL_OF_TEST_MINT);
  assert.equal(rows.length, 20);
  assert.ok(rows.every((x, i) => i === 0 || rows[i - 1].at >= x.at));
  assert.match(w.urls("launch-history")[0], /\/trade\?poolId=.+&limit=20$/);
  await raydiumTradesFor(POOL_OF_TEST_MINT, w.fetchImpl, { now: clock.now + 29_000 });
  assert.equal(w.count("launch-history"), 1, "kept 30 seconds");

  const k = await fetchKline(POOL_OF_TEST_MINT, "15m", w.fetchImpl, { limit: 500, now: clock.now });
  assert.equal(k.rows.length, 109);
  assert.equal(k.nextPageKey, null);
  assert.ok(k.rows.every((r, i) => i === 0 || k.rows[i - 1][0] < r[0]), "oldest first");
  const page = await fetchKline(POOL_OF_TEST_MINT, "15m", w.fetchImpl, { limit: 10, now: clock.now });
  assert.deepEqual([page.rows.length, page.nextPageKey], [10, "00000010"]);
  const none = await fetchKline(REAL_POOL, "15m", w.fetchImpl, { limit: 10, now: clock.now });
  assert.deepEqual([none.rows, none.nextPageKey], [[], null], "a pool Raydium does not know: no rows, not an error");
  await assert.rejects(fetchKline(POOL_OF_TEST_MINT, "1h", w.fetchImpl), /bad_request/, "Raydium refuses 1h (HTTP 400): never asked");
  await assert.rejects(fetchKline("<pool>", "15m", w.fetchImpl), /bad_request/);
  // the recorded 400 for an unsupported interval reads as a refusal, not data
  const refused = async () => new Response(JSON.stringify(fixture("kline_1h.json")), { status: 200, headers: JSON_TYPE });
  await assert.rejects(fetchKline(POOL_OF_TEST_MINT, "15m", refused), /raydium_refused/);
  const html = await marketWorld(MINT, { raydium: { klineMode: "html" } });
  await assert.rejects(fetchKline(POOL_OF_TEST_MINT, "15m", html.fetchImpl, { now: clock.now }), /not_json/);
  const garbage = await marketWorld(MINT, { raydium: { klineMode: "garbage" } });
  await assert.rejects(fetchKline(POOL_OF_TEST_MINT, "15m", garbage.fetchImpl, { now: clock.now }), /bad_answer/);
  // a hostile paging key is never sent on
  const keys = [];
  await fetchKline(POOL_OF_TEST_MINT, "15m", async (u) => { keys.push(String(u)); return new Response(JSON.stringify({ success: true, data: { rows: [], nextPageKey: "../../x" } }), { headers: JSON_TYPE }); }, { nextPageKey: "a&b=c" });
  assert.ok(!keys[0].includes("nextPageKey"), keys[0]);
});

test("logs: a failing source is logged as a short code, never an address or a URL", async () => {
  const { logged } = await quiet(async () => {
    const w = await marketWorld(MINT, { jup: { mode: "http500" }, tokens: { mode: "neterr" }, rpcMode: "http429" });
    await liveMarkets({}, [{ mint: MINT, pairMint: SOL }], w.fetchImpl, { now: clock.now });
  });
  assert.ok(logged.every((l) => !/[1-9A-HJ-NP-Za-km-z]{32,}/.test(l) && !/https?:/.test(l)), logged.join("\n"));
  assert.equal(codeOf(new Error(`no pool for ${MINT} at https://x`)), "no_pool_for_address_at_https___x", "an address in any error never reaches a log line");
  assert.equal(codeOf(new SourceError("http_429")), "http_429");
  assert.equal(codeOf(null).length <= 40, true);
});

test("getJson reads at most 1 MB: a stated length over it is refused unread, a stream is cancelled the moment it passes it (review SEC-GETJSON-SIZE)", async () => {
  // a source streaming 64 MiB of JSON in 64 KiB pieces; the test counts what was pulled from it
  const flood = ({ stated = null } = {}) => {
    const state = { pulled: 0, cancelled: false };
    const piece = new TextEncoder().encode("[" + "0,".repeat(32767) + "\n");
    const body = new ReadableStream({
      pull(c) { if (state.pulled >= 64 * 1024 * 1024) { c.close(); return; } state.pulled += piece.byteLength; c.enqueue(piece); },
      cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 });
    const headers = { ...JSON_TYPE, ...(stated ? { "content-length": String(stated) } : {}) };
    return { state, fetchImpl: async () => new Response(body, { headers }) };
  };
  const a = flood();
  await assert.rejects(getJson("https://x.example/a", a.fetchImpl), (e) => e instanceof SourceError && e.code === "too_big");
  assert.ok(a.state.pulled <= 1_000_000 + 2 * 65536, `read ${a.state.pulled} bytes, not 64 MiB`);
  assert.equal(a.state.cancelled, true, "the rest is cancelled, not drained");
  const b = flood({ stated: 64 * 1024 * 1024 });
  await assert.rejects(getJson("https://x.example/b", b.fetchImpl), (e) => e.code === "too_big");
  assert.equal(b.state.pulled, 0, "a stated length over the cap: nothing read");
  // a normal answer (and one just under the cap, in pieces) still reads whole, multi-byte text intact
  const ok = await getJson("https://x.example/c", async () => new Response(JSON.stringify({ name: "Zürich ✓", n: [1, 2, 3] }), { headers: JSON_TYPE }));
  assert.deepEqual(ok, { name: "Zürich ✓", n: [1, 2, 3] });
  const big = JSON.stringify({ pad: "é".repeat(450_000) }); // ~900 KB of 2-byte characters
  assert.equal((await getJson("https://x.example/d", async () => new Response(big, { headers: JSON_TYPE }))).pad.length, 450_000);
});
