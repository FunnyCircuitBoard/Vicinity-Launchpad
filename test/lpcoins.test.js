// City coins recorded from the chain (src/lpcoins.js) and the dark routes of the city-coin launch: /api/lp/* and /api/admin/lp/*
// answer 404 not_enabled without the settings (production-like), the admin's lp routes are the owner's with a fresh proof on POST,
// POST /api/lp/record records once (lp_coins, city_coins.mint only if empty, a public log line), GET /api/lp/coin gives the stage
// and progress from the DBC pool, and the job's sweep finds coins nobody recorded.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { _resetLpCoins, curveOf, recordLaunchedCoin, sweepLaunchedCoins } from "../src/lpcoins.js";
import { _resetLpKit } from "../src/lpkit.js";
import { runJobs } from "../src/jobs.js";
import { LAYOUT } from "../src/sol/layout.js";
import { metadataAddress } from "../src/sol/metaplex.js";
import { metadataUriFor } from "../src/coinmeta.js";
import { advance, browser, clock, newWorld, person, realClock, useClock } from "./helpers/world.js";
import { seedCoin } from "./helpers/launchpad.js";
import { DEMOV, DEMOV_CITY, DEMOV_COIN, DEMOV_POOL, LP_ON, METAPLEX, addr, lpChain, metaplexData } from "./helpers/lpchain.js";

const wranglerVars = () => JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "")).vars;
// The live settings without the three City-coins setup settings (production before PR-1, or any deploy that drops them):
// everything must stay dark there. The live settings themselves (setup on, trading off) are pinned in lpkit.test.js.
const darkVars = () => { const v = wranglerVars(); for (const k of ["LAUNCHPAD_CLUSTER", "LAUNCHPAD_PROGRAM_ID", "LAUNCHPAD_REWARDS_PROGRAM_ID", "LAUNCHPAD_DBC_CONFIGS", "LAUNCHPAD_LOOKUP_TABLE", "LAUNCHPAD_TRADING"]) delete v[k]; return v; };
beforeEach(() => { _resetLpCoins(); _resetLpKit(); realClock(); });
async function world(extra = {}) {
  const env = { ...newWorld(), ...LP_ON, ...extra };
  const chain = lpChain({ accounts: { [await metadataAddress(DEMOV)]: { owner: METAPLEX, data: metaplexData({ mint: DEMOV, name: "Demo Vicinity", symbol: "DEMOV", uri: metadataUriFor(DEMOV) }) } } });
  const b = browser(env);
  const call = async (path, { method = "GET", body, origin } = {}) => { const r = await b.send(path, { method, body, fetchImpl: chain.fetchImpl, ...(origin !== undefined ? { origin } : {}) }); return { status: r.status, data: await r.json() }; };
  return { env, chain, b, call };
}
/** Rewrite one field of an account in the fake chain (offsets from the generated layout). */
function setField(chain, address, layout, field, value) {
  const f = LAYOUT[layout].fields[field];
  const bytes = Buffer.from(chain.S.accounts[address].data, "base64");
  if (f.type === "u8" || f.type === "bool") bytes[f.at] = Number(value);
  else if (f.type === "u64") bytes.writeBigUInt64LE(BigInt(value), f.at);
  chain.S.accounts[address].data = bytes.toString("base64");
}

test("dark: with production-like settings every /api/lp/* and /api/admin/lp/* route answers 404 not_enabled, before any check", async () => {
  const env = { ...newWorld(), ...darkVars() };
  const chain = lpChain();
  const b = browser(env);
  for (const [path, method] of [["/api/lp/record", "POST"], ["/api/lp/coin?mint=" + DEMOV, "GET"], ["/api/lp/launch/status?city=1", "GET"], ["/api/lp/launch/tx", "POST"],
    ["/api/lp/graduate/tx", "POST"], ["/api/lp/founder-claim/tx", "POST"], ["/api/lp/anything", "DELETE"], ["/api/admin/lp/status", "GET"], ["/api/admin/lp/tx", "POST"], ["/api/admin/lp", "GET"]]) {
    const r = await b.send(path, { method, body: method === "POST" ? {} : undefined, fetchImpl: chain.fetchImpl });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(await r.json(), { ok: false, error: "not_enabled" }, path);
  }
  assert.equal(chain.S.log.length, 0);
});

test("on: the stubs answer not_enabled, unknown lp paths not_found, and /api/admin/lp/* is the owner's with a fresh proof on POST", async () => {
  useClock();
  const env = { ...newWorld(), ...LP_ON };
  const p = await person(env);
  env.ADMIN_WALLETS = p.w.address;
  const someone = await person(env);
  const chain = lpChain();
  const call = async (who, path, method = "GET", extra = {}) => { const r = await who.send(path, { method, body: method === "POST" ? {} : undefined, fetchImpl: chain.fetchImpl, ...extra }); return { status: r.status, data: await r.json() }; };
  // the founder track's routes (src/lplaunch.js): their first check is the page's cluster echo
  assert.deepEqual([(await call(p, "/api/lp/launch/status?city=1&cluster=mainnet")).status, (await call(p, "/api/lp/launch/status?city=1&cluster=mainnet")).data.error], [409, "cluster_mismatch"]);
  assert.deepEqual((await call(p, "/api/lp/nothing-here")).status, 404);
  assert.equal((await call(p, "/api/lp/nothing-here")).data.error, "not_found");
  // the admin router line: signed out 401, not the owner 403, the owner reaches the admin track's stub
  assert.equal((await call(browser(env), "/api/admin/lp/status")).data.error, "sign_in");
  assert.deepEqual((await call(someone, "/api/admin/lp/status")).data, { ok: false, error: "forbidden", need: "owner" });
  // the owner reaches the admin track's handler (src/lpadmin.js), whose first check is the page's cluster echo
  assert.deepEqual([(await call(p, "/api/admin/lp/status")).status, (await call(p, "/api/admin/lp/status")).data.error], [409, "cluster_mismatch"]);
  assert.deepEqual([(await call(p, "/api/admin/lp/tx", "POST")).status, (await call(p, "/api/admin/lp/tx", "POST")).data.error], [409, "cluster_mismatch"], "a fresh proof: reaches the handler");
  assert.equal((await call(p, "/api/admin/lp/tx", "POST", { origin: null })).data.error, "wrong_origin");
  advance(31 * 60_000);
  assert.deepEqual((await call(p, "/api/admin/lp/tx", "POST")).data, { ok: false, error: "reprove" }, "a proof older than 30 minutes");
  assert.equal((await call(p, "/api/admin/lp/status")).status, 409, "reading needs no fresh proof (the handler answers)");
  realClock();
});

test("POST /api/lp/record: records a launched coin once from the chain, locks the design, logs it publicly; idempotent", async () => {
  const { env, chain, call } = await world();
  await seedCoin(env.DB, { city: DEMOV_CITY, name: "Demo City", country: "US", coin: "Demo Coin", user: 7, seat: 1 });
  const r = await call("/api/lp/record", { method: "POST", body: { cityId: DEMOV_CITY } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.recorded, r.data.mint, r.data.cityId, r.data.cluster, r.data.coinPage], [true, DEMOV, DEMOV_CITY, "devnet", `/coin?mint=${DEMOV}`]);
  assert.equal(chain.calls("getAccountInfo")[0].params[0], DEMOV_COIN, "read the city's Coin record");
  const row = await env.DB.prepare("SELECT * FROM lp_coins WHERE city_id = ?").bind(DEMOV_CITY).first();
  assert.deepEqual([row.mint, row.coin, row.dbc_pool, row.quote_mint], [DEMOV, DEMOV_COIN, DEMOV_POOL, "So11111111111111111111111111111111111111112"]);
  assert.ok(row.meta_json && JSON.parse(row.meta_json).name === "Demo Vicinity", "the /coin-meta JSON is built at once");
  const design = await env.DB.prepare("SELECT mint, launched_at, pending_mint FROM city_coins WHERE city_id = ?").bind(DEMOV_CITY).first();
  assert.equal(design.mint, DEMOV);
  assert.equal(design.launched_at, row.launched_at);
  const log = (await env.DB.prepare("SELECT * FROM mod_actions WHERE action = 'coin_launched'").all()).results;
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].actor_id, log[0].actor_role, log[0].place, log[0].country], [7, "founder", DEMOV_CITY, "US"]);
  assert.match(log[0].note, /^Demo City: launched on the Vicinity launchpad \(Solana devnet\), contract EAXz.*Recorded from the blockchain/);
  // the public audit shows it
  const audit = await call("/api/audit");
  assert.ok(audit.data.actions.some((a) => a.action === "coin_launched"));
  // again: nothing new
  const again = await call("/api/lp/record", { method: "POST", body: { cityId: Number(DEMOV_CITY) } });
  assert.deepEqual([again.status, again.data.recorded], [200, false]);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'coin_launched'").first()).n, 1);
  // the founder can no longer change the design (src/coins.js refuses once city_coins.mint is set): checked by the lock itself
  assert.ok(await env.DB.prepare("SELECT 1 FROM city_coins WHERE city_id = ? AND mint IS NOT NULL").bind(DEMOV_CITY).first());
});

test("POST /api/lp/record: another mint already recorded for the city is never overwritten; no design row is fine; bad and unknown cities", async () => {
  const { env, call } = await world();
  await seedCoin(env.DB, { city: DEMOV_CITY, name: "Demo City", mint: addr(321), user: 7 });
  const r = await call("/api/lp/record", { method: "POST", body: { cityId: DEMOV_CITY } });
  assert.equal(r.status, 200);
  assert.equal((await env.DB.prepare("SELECT mint FROM city_coins WHERE city_id = ?").bind(DEMOV_CITY).first()).mint, addr(321), "unchanged");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'coin_launched'").first()).n, 0);
  assert.ok(await env.DB.prepare("SELECT 1 FROM lp_coins WHERE mint = ?").bind(DEMOV).first(), "the chain's record is kept apart");
  const w2 = await world();
  assert.equal((await w2.call("/api/lp/record", { method: "POST", body: { cityId: DEMOV_CITY } })).status, 200, "no design row");
  assert.deepEqual((await w2.call("/api/lp/record", { method: "POST", body: { cityId: "12345" } })).data, { ok: false, error: "not_launched" });
  assert.equal((await w2.call("/api/lp/record", { method: "POST", body: { cityId: "12345" } })).status, 404);
  assert.equal((await w2.call("/api/lp/record", { method: "POST", body: { cityId: "-1" } })).data.error, "bad_city");
  assert.equal((await w2.call("/api/lp/record", { method: "POST", body: { cityId: "99999999999999999999" } })).data.error, "bad_city", "beyond u64");
  assert.equal((await w2.call("/api/lp/record", { method: "POST", body: { cityId: DEMOV_CITY }, origin: "https://elsewhere.example" })).status, 403);
  assert.equal((await w2.call("/api/lp/record")).status, 405);
  let last;
  for (let i = 0; i < 21; i++) last = await w2.call("/api/lp/record", { method: "POST", body: { cityId: DEMOV_CITY } });
  assert.equal(last.status, 429, "20 a minute per connection");
  w2.chain.S.down = true;
  const down = await recordLaunchedCoin(w2.env, { cityId: "777" }, w2.chain.fetchImpl);
  assert.deepEqual(down, { ok: false, error: "rpc_unavailable" });
});

test("GET /api/lp/coin: stage and progress toward the target from the DBC pool (curve, full, graduated), the founder masked", async () => {
  const { env, chain, call } = await world();
  const r = await call(`/api/lp/coin?mint=${DEMOV}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.stage, r.data.cityId, r.data.cluster, r.data.progress.target, r.data.progress.symbol], ["curve", DEMOV_CITY, "devnet", 1, "SOL"]);
  assert.ok(r.data.progress.raised > 0 && r.data.progress.raised < 1 && r.data.progress.pct > 0 && r.data.progress.pct < 100, JSON.stringify(r.data.progress));
  assert.match(r.data.founder, /^91WeA\*{5}Ggr$/);
  assert.ok(await env.DB.prepare("SELECT 1 FROM lp_coins WHERE mint = ?").bind(DEMOV).first(), "looked up on the chain once, and recorded");
  const row = await env.DB.prepare("SELECT * FROM lp_coins WHERE mint = ?").bind(DEMOV).first();
  setField(chain, DEMOV_POOL, "VirtualPool", "quote_reserve", 1_000_000_000n);
  _resetLpCoins();
  assert.deepEqual([(await curveOf(env, row, chain.fetchImpl)).stage, (await curveOf(env, row, chain.fetchImpl)).progressPct], ["full", 100]);
  setField(chain, DEMOV_POOL, "VirtualPool", "is_migrated", 1);
  _resetLpCoins();
  assert.equal((await curveOf(env, row, chain.fetchImpl)).stage, "graduated");
  assert.equal(await curveOf({ ...env, LAUNCHPAD_PROGRAM_ID: addr(9) }, row, chain.fetchImpl), null, "a row of another program is not read under this one");
  assert.equal((await call(`/api/lp/coin?mint=${addr(77)}`)).status, 404);
  assert.equal((await call("/api/lp/coin?mint=nope")).data.error, "bad_mint");
});

test("the job's sweep: every 30 minutes, every Coin record of the program, the new ones recorded; nothing while the settings are missing", async () => {
  useClock("2026-10-10T12:00:00Z");
  const { env, chain } = await world();
  await seedCoin(env.DB, { city: DEMOV_CITY, name: "Demo City", user: 7 });
  const out = await runJobs(env, clock.now, chain.fetchImpl);
  assert.deepEqual(out.lpCoins, { found: 1, recorded: 1, failed: 0, left: 0 });
  assert.equal((await env.DB.prepare("SELECT mint FROM city_coins WHERE city_id = ?").bind(DEMOV_CITY).first()).mint, DEMOV);
  assert.deepEqual(chain.calls("getProgramAccounts").map((c) => c.params[1].filters), [[{ dataSize: 243 }]]);
  assert.deepEqual(await sweepLaunchedCoins(env, clock.now + 10 * 60_000, chain.fetchImpl), { skipped: "not due" });
  assert.deepEqual(await sweepLaunchedCoins(env, clock.now + 31 * 60_000, chain.fetchImpl), { found: 1, recorded: 0, failed: 0, left: 0 });
  const off = { ...newWorld(), ...darkVars() };
  const quiet = lpChain();
  const r = await runJobs(off, clock.now, quiet.fetchImpl);
  assert.equal(r.lpCoins, undefined, "no step at all without the settings");
  assert.ok(!quiet.S.log.some((l) => l.params && l.params[0] === LP_ON.LAUNCHPAD_PROGRAM_ID), "our program is never read");
  realClock();
});

test("the Launchpad list and the coin page: a coin of our launchpad shows its Vicinity curve, no Raydium link, honest chart and trade lines", async () => {
  const { env, chain, call } = await world({ LAUNCHPAD_V2: "on" });
  await seedCoin(env.DB, { city: DEMOV_CITY, name: "Demo City", coin: "Demo Coin", user: 7 });
  assert.equal((await call("/api/lp/record", { method: "POST", body: { cityId: DEMOV_CITY } })).status, 200);
  const SOL = "So11111111111111111111111111111111111111112";
  const asked = [];
  const markets = async (url, init) => {
    const u = new URL(String(url));
    const ok = (b) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    if (u.hostname.endsWith("jup.ag")) { asked.push(u.host + u.pathname); return ok(u.pathname.endsWith("/search") ? [] : u.pathname.includes("price") ? { [SOL]: { usdPrice: 150, priceChange24h: 1 } } : {}); }
    if (u.hostname.endsWith("raydium.io")) { asked.push(u.host + u.pathname); return ok({ success: true, data: { rows: [] } }); }
    if (u.hostname === "api.dexscreener.com") { asked.push(u.host); return ok({ schemaVersion: "1.0.0", pairs: [] }); }
    return chain.fetchImpl(url, init);
  };
  const b = browser(env);
  const list = await (await b.send("/api/launchpad", { fetchImpl: markets })).json();
  const card = list.coins.find((c) => c.mint === DEMOV);
  assert.ok(card, "the recorded coin is a live card");
  assert.equal(card.status, "live");
  assert.deepEqual([card.market.launchpad, card.market.curve, card.market.stage, card.market.lpCurve.stage, card.market.lpCurve.symbol, card.market.lpCurve.target], ["vicinity", null, "curve", "curve", "SOL", 1]);
  assert.ok(card.market.lpCurve.progressPct > 0 && card.market.lpCurve.progressPct < 100);
  assert.equal(card.market.liquidityKind, "bonding_curve");
  assert.ok(card.market.priceUsd > 0 && /On-chain curve × SOL price \(Jupiter\)/.test(card.market.sources.price), JSON.stringify(card.market.sources));
  assert.ok(Math.abs(card.market.liquidityUsd - card.market.lpCurve.raised * 150) < 1e-9);
  assert.deepEqual(card.links, { raydium: null, jupiter: null, dexscreener: null, solscan: `https://solscan.io/token/${DEMOV}`, here: `/coin?mint=${DEMOV}` });
  assert.ok(!JSON.stringify(card).includes("raydium.io"), "no Raydium link anywhere on the card");
  const page = await (await b.send(`/api/coin?mint=${DEMOV}`, { fetchImpl: markets })).json();
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.deepEqual([page.market.launchpad, page.market.lpCurve.stage, page.trades.missing, page.links.raydium, page.links.here], ["vicinity", "curve", "No trade list yet for coins on the Vicinity curve", null, `/coin?mint=${DEMOV}`]);
  assert.equal(page.links.pool, `https://solscan.io/account/${DEMOV_POOL}`);
  assert.ok(!asked.some((a) => a.startsWith("launch-history-v1.raydium.io")), "Raydium's trade list is never asked for a coin that was never there");
  const chart = await (await b.send(`/api/coin/chart?mint=${DEMOV}&tf=24h`, { fetchImpl: markets })).json();
  assert.deepEqual([chart.ok, chart.candles, chart.missing.candles], [true, null, "No chart yet for coins on the Vicinity curve"]);
  // graduated: the open market's pages come back, still no Raydium
  setField(chain, DEMOV_POOL, "VirtualPool", "is_migrated", 1);
  _resetLpCoins();
  const { curvesFor, lpLinks } = await import("../src/lpcoins.js");
  const row = await env.DB.prepare("SELECT * FROM lp_coins WHERE mint = ?").bind(DEMOV).first();
  assert.equal((await curvesFor(env, [row], chain.fetchImpl)).get(DEMOV).stage, "graduated");
  assert.deepEqual(lpLinks(DEMOV, "graduated"), { raydium: null, jupiter: `https://jup.ag/tokens/${DEMOV}`, dexscreener: `https://dexscreener.com/solana/${DEMOV}`, solscan: `https://solscan.io/token/${DEMOV}`, here: `/coin?mint=${DEMOV}` });
});

test("the Launchpad page (public/launchpad.js): a card of our launchpad says 'Vicinity launchpad', moves to a Meteora pool, never links Raydium", async () => {
  const vm = await import("node:vm");
  const fakeEl = () => ({ textContent: "", classList: { toggle() {}, add() {}, remove() {} }, style: {}, offsetWidth: 0, addEventListener() {}, dataset: {}, hidden: false, replaceChildren() {} });
  const win = { V: { $: () => fakeEl(), $$: () => [], el: () => fakeEl(), official: Promise.resolve({ launchpadV2: true }), opensAt: () => 0, reduced: true, api: async () => ({}), fmt: String, isAddr: () => false } };
  vm.runInNewContext(readFileSync(new URL("../public/launchpad.js", import.meta.url), "utf8"), { window: win, Intl, URLSearchParams, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {} });
  const P = win.VLaunchpad.pure;
  const plain = (x) => JSON.parse(JSON.stringify(x)); // the page runs in its own realm
  const card = (lpCurve, extra = {}) => ({ kind: "city", status: "live", mint: DEMOV, pair: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" }, city: { id: DEMOV_CITY },
    market: { launchpad: "vicinity", curve: null, lpCurve, ...extra }, links: { raydium: null, here: `/coin?mint=${DEMOV}`, solscan: `https://solscan.io/token/${DEMOV}` } });
  const c = card({ stage: "curve", symbol: "SOL", raised: 14.8, target: 85, progressPct: 17.41 });
  assert.equal(P.venueLine(c), "Vicinity launchpad · SOL pair");
  assert.deepEqual(plain(P.curveView(c)), { graduated: false, value: 17.41, pct: "17.4%", text: "14.80 of 85.00 SOL raised · moves to a Meteora pool at 85.00 SOL · Solana chain" });
  assert.deepEqual(plain(P.curveView(card({ stage: "full", symbol: "SOL", raised: 85, target: 85, progressPct: 100 }))), { graduated: false, value: 100, pct: "100%", label: "Bonding curve · full", text: "The curve is full: it moves to a Meteora pool next · Solana chain" });
  assert.equal(P.curveView(card({ stage: "graduated", symbol: "SOL" })).label, "✓ Graduated to Meteora");
  assert.equal(P.links(c).raydium, null, "no raydium.io fallback for our coins");
  assert.match(P.links({ ...c, market: {} }).raydium, /raydium\.io/, "a LaunchLab coin keeps its link");
  assert.equal(P.curveView(card(null)), null);
});
