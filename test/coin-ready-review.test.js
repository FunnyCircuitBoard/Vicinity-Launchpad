// The ready-made city coin (COIN_V2_READY=on) against the stage 1 review: one rule for a waiting Raydium LaunchLab contract (an admin
// can reject it, never record it; nothing of a request is read before the admin check), previews only of the coin that will launch,
// a stale "table missing" never misleads a write, an approval being built wins over "Use this coin", a new founder chooses again, a
// launched coin whose symbol the site never read is never taken for a free ticker, and a low balance is not called a grace period.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { BOUNDS, CITIES, IN_UTICA, MINT, browser, newWorld, person, realClock, reprove, setHolding, useClock, chain } from "./helpers/world.js";
import { GATES, _setArtRenderer } from "../src/coinready.js";
import { _resetCityCache } from "../src/cities.js";
import { _resetTickers } from "../src/tickers.js";
import { _resetLpCoins, ensureLpCoinsSchema } from "../src/lpcoins.js";
import { artBytes } from "../src/coinart-store.js";
import { handleApi } from "../src/index.js";
import { nodeRenderer } from "../scripts/coin-art/render.mjs";

const UTICA = "5142056", SYRACUSE = "5140405", WAITING = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
let env, renders = 0, onRender = null;
before(async () => {
  const r = await nodeRenderer();
  _setArtRenderer(async (svg) => { renders++; if (onRender) await onRender(); return r(svg); });
});
after(() => { _setArtRenderer(null); realClock(); });
beforeEach(() => { useClock("2026-10-20T12:00:00Z"); _resetLpCoins(); renders = 0; onRender = null; env = world(); });

function world(extra = { COIN_V2_READY: "on" }) {
  const e = newWorld({ VICINITY_MINT: MINT, ...extra });
  _resetCityCache(); _resetTickers();
  const files = { "/data/cities.json": JSON.stringify({ ...CITIES, admin: { "US.NY": "New York" } }), "/data/bounds/US.txt": BOUNDS,
    "/data/tickers.json": JSON.stringify({ 5128581: "NYC", 5140405: "SYRACUSE", 5106834: "ALBANY", 5142056: "UTICA" }) };
  e.ASSETS = { fetch: async (r) => { const f = files[new URL(r.url).pathname]; return f ? new Response(f) : new Response("", { status: 404 }); } };
  return e;
}
async function founder(e = env, { city = UTICA, name = "Utica", holds = 2_000_000 } = {}) {
  const f = await person(e, { home: IN_UTICA, holds });
  const u = await e.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  f.seatId = (await e.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, ?, 'US', ?, ?, 3, 1000000, 'active', ?, ?)")
    .bind(city, name, u.id, u.wallet, at, at).run()).meta.last_row_id;
  f.uid = u.id;
  return f;
}
const view = (who, city = UTICA) => who.get(`/api/coins/ready?city=${city}`);
const art = (who, city = UTICA) => who.post("/api/coins/ready/art", { cityId: city });
const use = (who, contentHash, city = UTICA) => who.post("/api/coins/ready/use", { cityId: city, contentHash });
const row = (sql, ...p) => env.DB.prepare(sql).bind(...p).first();
const count = async (sql, ...p) => (await env.DB.prepare(sql).bind(...p).first()).n;

test("a waiting LaunchLab contract, switch on and the launchpad set up: an admin rejects it (in fixed words, src/coins.js settleLegacyContract), never records it", async () => {
  const { LP_ON } = await import("./helpers/lpchain.js");
  env = world({ COIN_V2_READY: "on", ...LP_ON });
  const f = await founder();
  await env.DB.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pair, color, pending_mint, pending_at, updated_at, created_at) VALUES (?, 'Utica', 'US', ?, ?, 'Utica Coin', 'SOL', 'gold', ?, 'x', 'x', 'x')")
    .bind(UTICA, f.seatId, f.uid, WAITING).run();
  const adm = await person(env);
  env.ADMIN_WALLETS = adm.w.address;
  const send = async (who, body) => { const r = await who.send("/api/coins/mint/decide", { method: "POST", body }); return { status: r.status, ...(await r.json()) }; };
  const accept = await send(adm, { city: UTICA, mint: WAITING, approve: true, note: "Checked" });
  assert.deepEqual([accept.status, accept.error], [409, "launchpad_only"]);
  assert.match(accept.message, /can only be rejected, not recorded/);
  assert.equal((await row("SELECT pending_mint FROM city_coins WHERE city_id = ?", UTICA)).pending_mint, WAITING);
  // with the launchpad set up a rejection only settles the city, in fixed neutral words whatever note is sent (stage 0's rule)
  const reject = await send(adm, { city: UTICA, mint: WAITING, approve: false, note: "" });
  assert.equal(reject.ok, true, JSON.stringify(reject));
  assert.equal((await row("SELECT pending_mint FROM city_coins WHERE city_id = ?", UTICA)).pending_mint, null);
  const { LEGACY_REJECTED } = await import("../src/coins.js");
  assert.equal((await row("SELECT note FROM mod_actions WHERE action = 'coin_contract_rejected'")).note, `Utica: ${LEGACY_REJECTED}`);
  assert.equal(await count("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'coin_contract_rejected'"), 1);
  // a founder still can't send one
  const m = await f.send("/api/coins/mint", { method: "POST", body: { mint: WAITING } });
  assert.deepEqual([m.status, (await m.json()).error], [409, "launchpad_only"]);
});

test("nothing of a request to the contract routes is read before the admin check (no body parsed by anyone who is not an admin)", async () => {
  let pulled = 0;
  // a stream that is read only on demand (no read ahead): each pull is one 64 KB piece of a body that keeps coming
  const big = () => new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(64 * 1024).fill(32)); if (pulled > 4) c.close(); } }, { highWaterMark: 0 });
  for (const path of ["/api/coins/mint/decide", "/api/coins/mint"]) {
    pulled = 0;
    const req = new Request(`https://vicinity.test${path}`, { method: "POST", body: big(), duplex: "half", headers: { "content-type": "application/json", origin: "https://vicinity.test" } });
    const res = await handleApi(req, env, chain());
    assert.ok([401, 403, 409].includes(res.status), `${path} ${res.status}`);
    assert.equal(pulled, 0, `${path}: the body was never read`);
  }
});

test("previews show only the coin that will launch: none with a waiting LaunchLab contract or a design that is not the chosen coin; the chosen coin's own words", async () => {
  const f = await founder();
  const visitor = browser(env, { ip: "203.0.113.9" });
  const a = await art(f);
  assert.equal((await view(visitor)).preview.ticker, "UTICA");
  // a contract waiting from the old LaunchLab path (the city may have that coin already): no preview, for anyone, the founder too
  await env.DB.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pair, color, pending_mint, pending_at, updated_at, created_at) VALUES (?, 'Utica', 'US', ?, ?, 'Utica Coin', 'SOL', 'gold', ?, 'x', 'x', 'x')")
    .bind(UTICA, f.seatId, f.uid, WAITING).run();
  assert.equal((await view(visitor)).preview, null);
  const fv = await view(f);
  assert.deepEqual([fv.preview, fv.gate.code], [null, "legacy_contract"]);
  // an earlier studio design (perhaps approved on chain before the switch: that is what launches): no preview of the ready-made coin
  await env.DB.prepare("UPDATE city_coins SET pending_mint = NULL, pending_at = NULL WHERE city_id = ?").bind(UTICA).run();
  assert.equal((await view(visitor)).preview, null);
  assert.deepEqual([(await view(f)).preview, (await view(f)).earlier], [null, true]);
  // chosen: the preview is that version, with its own ticker, name and picture
  await reprove(f);
  assert.equal((await use(f, a.coin.contentHash)).ok, true);
  const p = (await view(visitor)).preview;
  assert.deepEqual([p.ticker, p.name, p.chosen, p.art], ["UTICA", "Utica", true, a.coin.art]);
  // the city list moved the ticker after the choice: the preview keeps the chosen version's ticker WITH its picture, never a mix
  await env.DB.prepare("UPDATE coin_ready SET symbol = 'UTICAOLD' WHERE city_id = ?").bind(UTICA).run();
  await env.DB.prepare("UPDATE coin_versions SET symbol = 'UTICAOLD'").run();
  const moved = (await view(visitor)).preview;
  assert.deepEqual([moved.ticker, moved.art], ["UTICAOLD", a.coin.art]);
  // another city launched with the ticker: no preview of a coin that can't launch
  await env.DB.prepare("UPDATE coin_ready SET symbol = 'UTICA' WHERE city_id = ?").bind(UTICA).run();
  await env.DB.prepare("UPDATE coin_versions SET symbol = 'UTICA'").run();
  await ensureLpCoinsSchema(env.DB);
  await env.DB.prepare(`INSERT INTO lp_coins (cluster, program_id, city_id, mint, coin, founder, name, symbol, quote_mint, dbc_config, dbc_pool, recorded_at)
    VALUES ('devnet', 'P', ?, 'MintSyr', 'c', 'f', 'Syracuse', 'UTICA', 'q', 'd', 'p', 'now')`).bind(SYRACUSE).run();
  assert.equal((await view(visitor)).preview, null);
});

test("a stale 'table missing' remembered by one server never misleads a write: Use this coin records and answers as it should", async () => {
  const f = await founder();
  // server X: the same database through another object (another isolate's binding)
  const real = env.DB;
  const other = { prepare: (...a) => real.prepare(...a), batch: (...a) => real.batch(...a), exec: (...a) => real.exec(...a) };
  const envX = { ...env, DB: other };
  assert.equal(await artBytes(other, "a".repeat(64)), null, "server X looks for a picture before the tables exist: 'missing' remembered");
  // server Y (env) makes the tables, draws and stores the picture
  const a = await art(f);
  assert.equal(renders, 1);
  await reprove(f);
  // server X, within the minute: the picture is found (not drawn again), the choice is recorded and answered as such
  const { handleReadyUse, handleReadyArt } = await import("../src/coinready.js");
  const cookie = [...f.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const post = async (h, body) => (await h(new Request("https://vicinity.test/api/coins/ready/x", { method: "POST", headers: { cookie, origin: "https://vicinity.test", "content-type": "application/json" }, body: JSON.stringify(body) }), envX, chain())).json();
  const ax = await post(handleReadyArt, { cityId: UTICA });
  assert.equal(ax.coin.contentHash, a.coin.contentHash);
  assert.equal(renders, 1, "not drawn again");
  const ux = await post(handleReadyUse, { cityId: UTICA, contentHash: a.coin.contentHash });
  assert.deepEqual([ux.ok, ux.used, ux.inUse], [true, true, true], JSON.stringify(ux));
  assert.equal(await count("SELECT COUNT(*) AS n FROM coin_ready"), 1);
});

test("an approval being built wins over Use this coin: a hold that lands while the picture is drawn leaves nothing of the choice written", async () => {
  const f = await founder();
  const v = await view(f);
  assert.equal(v.gate, null);
  // the page showed the version (its hash is known from the same defaults); the owner starts approving while the picture is drawn
  const { coinSvg, sha256Hex, TEMPLATE_VERSION } = await import("../src/coinart.js");
  const { canonicalContent } = await import("../src/coinready.js");
  const png = await (await nodeRenderer())(coinSvg({ ticker: "UTICA", city: "Utica" }));
  const hash = await sha256Hex(canonicalContent({ city: v.city, name: v.coin.name, symbol: "UTICA", description: v.coin.description, artSha256: await sha256Hex(png), templateVersion: TEMPLATE_VERSION }));
  onRender = () => env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`lp_design_hold:${UTICA}`, new Date(Date.now() + 300_000).toISOString()).run();
  await reprove(f);
  const r = await f.send("/api/coins/ready/use", { method: "POST", body: { cityId: UTICA, contentHash: hash } });
  const j = await r.json();
  assert.deepEqual([r.status, j.error], [409, "held"], JSON.stringify(j));
  assert.equal(await row("SELECT 1 AS x FROM city_coins WHERE city_id = ?", UTICA), null, "no design row");
  assert.equal(await count("SELECT COUNT(*) AS n FROM coin_ready"), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'coin_design'"), 0);
});

test("a new founder after a change of seat chooses the coin again (the former founder's choice is not theirs), and then it is", async () => {
  const a = await founder();
  const h = (await art(a)).coin.contentHash;
  await reprove(a);
  assert.equal((await use(a, h)).inUse, true);
  // A's seat is released, B takes it
  await env.DB.prepare("UPDATE seats SET status = 'released' WHERE id = ?").bind(a.seatId).run();
  const b = await founder();
  const vb = await view(b);
  assert.deepEqual([vb.inUse, vb.chosen.current, vb.chosen.mine, vb.gate], [false, true, false, null]);
  await reprove(b);
  const r = await use(b, h);
  assert.deepEqual([r.ok, r.used, r.inUse, r.already], [true, true, true, undefined], JSON.stringify(r));
  const cc = await row("SELECT seat_id, user_id FROM city_coins WHERE city_id = ?", UTICA);
  assert.deepEqual([cc.seat_id, cc.user_id], [b.seatId, b.uid], "the design row names the current founder's seat");
  const cr = await row("SELECT seat_id, design_at, approved_hash FROM coin_ready WHERE city_id = ?", UTICA);
  assert.deepEqual([cr.seat_id, cr.approved_hash], [b.seatId, null]);
});

test("a launched coin whose symbol the site never read is read from the chain, or blocks: never taken for a free ticker", async () => {
  const { LP_ON, PROGRAM, lpChain, metaplexData, METAPLEX } = await import("./helpers/lpchain.js");
  const { metadataAddress } = await import("../src/sol/metaplex.js");
  const { metadataUriFor } = await import("../src/coinmeta.js");
  env = world({ COIN_V2_READY: "on", ...LP_ON });
  const f = await founder();
  await ensureLpCoinsSchema(env.DB);
  const mint = "9yQNxyWbF1sYxXb7nq3zJ4sz2tnLoqa4v8bbWbAdwLBS";
  await env.DB.prepare(`INSERT INTO lp_coins (cluster, program_id, city_id, mint, coin, founder, name, symbol, quote_mint, dbc_config, dbc_pool, recorded_at)
    VALUES ('devnet', ?, ?, ?, 'c', 'f', NULL, NULL, 'q', 'd', 'p', 'now')`).bind(PROGRAM, SYRACUSE, mint).run();
  const lp = lpChain();
  const main = chain();
  const both = (url, init) => (String(url).startsWith(LP_ON.LAUNCHPAD_RPC_URL) ? lp.fetchImpl(url, init) : main(url, init));
  const gateOf = async () => (await (await f.send(`/api/coins/ready?city=${UTICA}`, { fetchImpl: both })).json()).gate;
  // the chain has no metadata to read: unknown, so the founder can't choose a ticker it may be
  assert.deepEqual(await gateOf(), { code: "ticker_unchecked", message: GATES.ticker_unchecked });
  // the chain says it is UTICA: stored, and the ticker is taken
  lp.S.accounts[await metadataAddress(mint)] = { owner: METAPLEX, data: metaplexData({ mint, name: "Syracuse", symbol: "UTICA", uri: metadataUriFor(mint) }) };
  assert.equal((await gateOf()).code, "symbol_taken");
  const r = await row("SELECT name, symbol FROM lp_coins WHERE mint = ?", mint);
  assert.deepEqual([r.name, r.symbol], ["Syracuse", "UTICA"]);
});

test("the coin's JSON, built on its first read, stores the chain's name and symbol where the launch record could not", async () => {
  const { LP_ON, PROGRAM, lpChain, metaplexData, METAPLEX, DEMOV, DEMOV_CITY } = await import("./helpers/lpchain.js");
  const { metadataAddress } = await import("../src/sol/metaplex.js");
  const { metadataUriFor, handleCoinMeta } = await import("../src/coinmeta.js");
  env = world({ COIN_V2_READY: "on", ...LP_ON });
  await ensureLpCoinsSchema(env.DB);
  await env.DB.prepare(`INSERT INTO lp_coins (cluster, program_id, city_id, mint, coin, founder, name, symbol, quote_mint, dbc_config, dbc_pool, recorded_at)
    VALUES ('devnet', ?, ?, ?, 'c', 'f', NULL, NULL, 'So11111111111111111111111111111111111111112', 'd', 'p', 'now')`).bind(PROGRAM, DEMOV_CITY, DEMOV).run();
  const lp = lpChain({ accounts: { [await metadataAddress(DEMOV)]: { owner: METAPLEX, data: metaplexData({ mint: DEMOV, name: "Demo Vicinity", symbol: "DEMOV", uri: metadataUriFor(DEMOV) }) } } });
  const res = await handleCoinMeta(new Request(`https://vicinity.city/coin-meta/${DEMOV}.json`, { headers: { "cf-connecting-ip": "198.51.100.3" } }), env, lp.fetchImpl);
  assert.equal(res.status, 200);
  const r = await row("SELECT name, symbol, meta_json FROM lp_coins WHERE mint = ?", DEMOV);
  assert.deepEqual([r.name, r.symbol, Boolean(r.meta_json)], ["Demo Vicinity", "DEMOV", true]);
});

test("the grace period is named only when the seat is in it: Use this coin below the bar puts it there, then says so", async () => {
  const f = await founder();
  const h = (await art(f)).coin.contentHash;
  setHolding(f.w.address, 10);
  assert.equal((await view(f)).gate.code, "below_amount");
  assert.equal((await row("SELECT status FROM seats WHERE id = ?", f.seatId)).status, "active", "a look starts nothing");
  await reprove(f);
  const r = await f.send("/api/coins/ready/use", { method: "POST", body: { cityId: UTICA, contentHash: h } });
  const j = await r.json();
  assert.deepEqual([r.status, j.error, j.message], [403, "in_grace", GATES.in_grace]);
  assert.equal((await row("SELECT status FROM seats WHERE id = ?", f.seatId)).status, "grace");
  assert.equal((await view(f)).gate.code, "in_grace", "now it is in grace, and the page says so");
});

test("the picture's city line is the coin's own name: a long registry name shortened for the chain is drawn shortened too", async () => {
  // Greifswald: the list says "Universitäts- und Hansestadt Greifswald" (40 bytes); its coin is named "Greifswald"
  const e = newWorld({ VICINITY_MINT: MINT, COIN_V2_READY: "on" });
  _resetCityCache(); _resetTickers();
  const cities = { ...CITIES, countries: { ...CITIES.countries, DE: "Germany" }, admin: { "US.NY": "New York", "DE.12": "Mecklenburg-Vorpommern" },
    byCountry: { ...CITIES.byCountry, DE: [[2917788, "Universitäts- und Hansestadt Greifswald", "12", 54.09, 13.38, 59000]] } };
  const files = { "/data/cities.json": JSON.stringify(cities), "/data/bounds/US.txt": BOUNDS, "/data/tickers.json": JSON.stringify({ 5142056: "UTICA", 2917788: "UUHG" }) };
  e.ASSETS = { fetch: async (r) => { const f = files[new URL(r.url).pathname]; return f ? new Response(f) : new Response("", { status: 404 }); } };
  env = e;
  const f = await person(e, { home: IN_UTICA, holds: 2_000_000 });
  const u = await e.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  await e.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES ('2917788', 'Greifswald', 'DE', ?, ?, 3, 1000000, 'active', ?, ?)").bind(u.id, u.wallet, at, at).run();
  const a = await art(f, "2917788");
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual([a.coin.name, a.city.name], ["Greifswald", "Universitäts- und Hansestadt Greifswald"]);
  const { coinSvg, sha256Hex } = await import("../src/coinart.js");
  const stored = await row("SELECT svg_sha256 FROM coin_art");
  assert.equal(stored.svg_sha256, await sha256Hex(coinSvg({ ticker: "UUHG", city: "Greifswald" })), "drawn with the coin's name");
  assert.notEqual(stored.svg_sha256, await sha256Hex(coinSvg({ ticker: "UUHG", city: "Universitäts- und Hansestadt Greifswald" })));
});

test("a database whose coin tables were made before approved_hash existed: pages still read it, the next write of the switch adds the column", async () => {
  const { READY_MIGRATION, APPROVED_MIGRATION } = await import("../src/coinart-store.js");
  const { ensureSchema } = await import("../src/store.js");
  await ensureSchema(env.DB);
  // the tables exactly as the first stage 1 build made them (coin_ready without approved_hash), and its migration marked done
  for (const t of READY_MIGRATION.tables) await env.DB.prepare(t.replace(",\n  approved_hash TEXT", "")).run();
  await env.DB.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, 'x')").bind(READY_MIGRATION.id).run();
  const cols = async () => (await env.DB.prepare("PRAGMA table_info(coin_ready)").all()).results.map((c) => c.name);
  assert.equal((await cols()).includes("approved_hash"), false);
  const f = await founder();
  await env.DB.prepare("INSERT INTO coin_versions (city_id, origin, content_json, content_hash, name, symbol, description, art_sha256, template_version, created_at) VALUES (?, 'default', '{}', ?, 'Utica', 'UTICA', 'd', ?, 't1', 'x')").bind(UTICA, "c".repeat(64), "d".repeat(64)).run();
  await env.DB.prepare("INSERT INTO coin_ready (city_id, version_id, content_hash, symbol, design_at, seat_id, user_id, chosen_at) VALUES (?, 1, ?, 'UTICA', 'x', ?, ?, 'x')").bind(UTICA, "c".repeat(64), f.seatId, f.uid).run();
  const v = await view(f);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.chosen.contentHash, "c".repeat(64), "read, as not approved");
  assert.equal((await cols()).includes("approved_hash"), false, "a GET alters nothing");
  await art(f); // a POST of the switch
  assert.equal((await cols()).includes("approved_hash"), true);
  assert.ok(await env.DB.prepare("SELECT 1 AS x FROM schema_migrations WHERE id = ?").bind(APPROVED_MIGRATION.id).first());
});
