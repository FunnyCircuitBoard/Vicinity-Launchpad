// The ready-made city coin (COIN_V2_READY=on) against the stage 1 recheck: an approval on chain is "approved" for a founder only when it
// is theirs and was built from the coin they chose (another wallet's or an earlier design's is said as that); the card shows the
// version that is approved or launched, not today's defaults; a choice the city list moved away from neither previews nor keeps the
// ticker from the city that has it now; an earlier studio design is kept aside whatever time passed; a failed bind never stores a
// coin's JSON for good; unknown and taken tickers count on this launchpad only, all of them, and every approval on chain; a waiting
// LaunchLab contract is a candidate's reason and never in the public log.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { IN_UTICA, advance, browser, person, realClock, reprove } from "./helpers/world.js";
import { _resetLpKit } from "../src/lpkit.js";
import { _resetLpAdmin } from "../src/lpadmin.js";
import { _resetLpCoins, ensureLpCoinsSchema } from "../src/lpcoins.js";
import { _resetCityCache } from "../src/cities.js";
import { _resetTickers } from "../src/tickers.js";
import { _setArtRenderer } from "../src/coinready.js";
import { ensureLpAdminSchema } from "../src/lpadmin.js";
import { metadataAddress } from "../src/sol/metaplex.js";
import { nodeRenderer } from "../scripts/coin-art/render.mjs";
import { PROGRAM, SYRACUSE, UTICA, approvalAccount, launchOnChain, metadataAccount, seenOf, world } from "./helpers/readyworld.js";
import { addr } from "./helpers/lpchain.js";

before(async () => { const r = await nodeRenderer(); _setArtRenderer(r); });
after(() => { _setArtRenderer(null); realClock(); });
beforeEach(() => { _resetLpKit(); _resetLpAdmin(); _resetLpCoins(); realClock(); });

const WAITING = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
/** Another active founder of `city`, holding the bar (a seat made directly, as the other coin tests do). */
async function seat(w, city, name) {
  const p = await person(w.env, { home: IN_UTICA, holds: 2_000_000 });
  const u = await w.env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(p.w.address).first();
  const at = new Date(Date.now()).toISOString();
  p.seatId = (await w.env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, ?, 'US', ?, ?, 3, 1000000, 'active', ?, ?)")
    .bind(city, name, u.id, u.wallet, at, at).run()).meta.last_row_id;
  p.uid = u.id;
  return p;
}
/** The city list with other tickers (and region names) from now on. */
function relist(w, tickers, admin = { "US.NY": "New York" }) {
  const files = { "/data/tickers.json": JSON.stringify(tickers) };
  const assets = w.env.ASSETS;
  w.env.ASSETS = { fetch: async (r) => {
    const path = new URL(r.url).pathname;
    if (files[path]) return new Response(files[path]);
    if (path === "/data/cities.json") { const c = await (await assets.fetch(r)).json(); return new Response(JSON.stringify({ ...c, admin })); }
    return assets.fetch(r);
  } };
  _resetCityCache(); _resetTickers();
}
const view = async (w, who, city = UTICA) => w.get(who, `/api/coins/ready?city=${city}`);
/** The owner's approval as it lands on chain (approve_launch, from the card he was shown), after the build's 5-minute hold. */
async function approveOnChain(w, { cityId = UTICA, founder = w.f.w.address, name = "Utica", symbol = "UTICA" } = {}) {
  advance(6 * 60_000);
  w.lp.S.accounts[await w.L.approval(BigInt(cityId))] = approvalAccount({ cityId, founder, rentPayer: w.owner.w.address, name, symbol, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400 });
}

test("S1R-2: an approval on chain for a former founder's wallet is said as that to the new founder, never 'approved', and nothing of it is theirs", async () => {
  const w = await world();
  await w.useCoin();
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(await w.card()), expiryDays: 7 });
  assert.equal(b.ok, true, JSON.stringify(b));
  await approveOnChain(w);
  // the founder who chose it: approved, as before
  assert.equal((await view(w, w.f)).gate.code, "approved");
  // A's seat is released before the owner revokes; B takes it with another wallet
  await w.env.DB.prepare("UPDATE seats SET status = 'released' WHERE city_id = ? AND user_id = (SELECT id FROM users WHERE wallet = ?)").bind(UTICA, w.f.w.address).run();
  const nb = await seat(w, UTICA, "Utica");
  const v = await view(w, nb);
  assert.equal(v.gate.code, "approved_other", JSON.stringify(v.gate));
  assert.equal(v.gate.message, "This city's coin is approved on the blockchain for another wallet than yours (the founder's wallet when it was approved). Vicinity's owner must revoke that approval before you can choose and launch your coin.");
  assert.doesNotMatch(JSON.stringify(v), /It launches exactly as approved/);
  assert.equal(v.inUse, false);
  // the launch card agrees: not theirs to launch
  const st = await w.get(nb, `/api/lp/launch/status?city=${UTICA}`);
  assert.equal(st.error, "founder_mismatch");
  // and "Use this coin" is refused with the same words
  await reprove(nb);
  const u = await w.post(nb, "/api/coins/ready/use", { cityId: UTICA, contentHash: v.coin.contentHash });
  assert.deepEqual([u.status, u.error], [409, "approved_other"]);
});

test("SEC-S1-5: an approval built without this design (the switch off when the owner approved) is named as what launches; no preview of the ready-made coin", async () => {
  const w = await world();
  await w.useCoin();
  w.env.COIN_V2_READY = "off";
  const c = await w.card();
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c), expiryDays: 7 });
  assert.equal(b.ok, true, JSON.stringify(b));
  await approveOnChain(w);
  await ensureLpAdminSchema(w.env.DB);
  await w.env.DB.prepare("INSERT INTO lp_approvals_log (cluster, program_id, city_id, action, founder, name, symbol, expires_at, signature, by_wallet, at) VALUES ('devnet', ?, ?, 'approve', ?, 'Utica', 'UTICA', 'x', 'sigA', ?, 'now')")
    .bind(PROGRAM, UTICA, w.f.w.address, w.owner.w.address).run();
  w.env.COIN_V2_READY = "on";
  const v = await view(w, w.f);
  assert.equal(v.gate.code, "approved_earlier", JSON.stringify(v.gate));
  assert.equal(v.gate.message, "Your city's coin is approved on the blockchain as “Utica” ($UTICA), but not with the Vicinity coin shown here. It launches as approved, with the design it was approved with.");
  // the launch publishes the badge and the design row's words (test/coin-ready-launch.test.js), so nobody is shown the template as that coin
  assert.equal((await view(w, browser(w.env))).preview, null);
  assert.equal(v.preview, null);
});

test("S1R-4: approved, then launched, the card shows the version that is approved or launched, not today's defaults (a renamed region)", async () => {
  const w = await world();
  const coin = await w.useCoin();
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(await w.card()), expiryDays: 7 });
  assert.equal(b.ok, true, JSON.stringify(b));
  await approveOnChain(w);
  relist(w, { 5128581: "NYC", 5140405: "SYRACUSE", 5106834: "ALBANY", 5142056: "UTICA" }, { "US.NY": "New York State" });
  let v = await view(w, w.f);
  assert.equal(v.gate.code, "approved");
  assert.deepEqual([v.coin.description, v.coin.contentHash, v.coin.art, v.city.region], ["The city coin of Utica, New York, United States.", coin.contentHash, coin.art, "New York"]);
  assert.equal(v.inUse, true);
  // launched and bound: the same version, for good
  delete w.lp.S.accounts[await w.L.approval(BigInt(UTICA))];
  const mint = await launchOnChain(w);
  advance(10 * 60_000);
  assert.equal((await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA })).ok, true);
  v = await view(w, w.f);
  assert.equal(v.chosen.launched, true);
  assert.deepEqual([v.coin.description, v.coin.contentHash, v.city.region], ["The city coin of Utica, New York, United States.", coin.contentHash, "New York"]);
  const j = JSON.parse((await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json);
  assert.equal(j.city.region, v.city.region, "the card and the coin's JSON say the same");
});

test("S1R-3 / SEC-S1-4: a choice the city list moved away from neither previews nor keeps the ticker; the city that has it now chooses it; a swap works both ways", async () => {
  const w = await world();
  await w.useCoin(); // Utica chose $UTICA
  const sy = await seat(w, SYRACUSE, "Syracuse");
  relist(w, { 5128581: "NYC", 5140405: "UTICA", 5106834: "ALBANY", 5142056: "UTICA2" });
  // (1) Utica's stale choice is nobody's preview any more (it can never be approved: "no longer matches the city list")
  assert.equal((await view(w, browser(w.env))).preview, null);
  const card = await w.card();
  assert.equal(card.ok, false);
  assert.match(card.reasons.join(" "), /no longer matches the city list/);
  // (2) Syracuse has UTICA now: no symbol_taken, its preview shows, and "Use this coin" records it (Utica's stale row lets it go)
  let s = await view(w, sy, SYRACUSE);
  assert.equal(s.gate, null, JSON.stringify(s.gate));
  assert.equal(s.coin.ticker, "UTICA");
  const a = await w.post(sy, "/api/coins/ready/art", { cityId: SYRACUSE });
  await reprove(sy);
  const u = await w.post(sy, "/api/coins/ready/use", { cityId: SYRACUSE, contentHash: a.coin.contentHash });
  assert.equal(u.ok, true, JSON.stringify(u));
  const rows = (await w.env.DB.prepare("SELECT city_id, symbol FROM coin_ready ORDER BY city_id").all()).results;
  assert.deepEqual(rows.map((r) => [r.city_id, r.symbol]), [[SYRACUSE, "UTICA"], [UTICA, `~${UTICA}`]]);
  // Utica's founder sees a new version to choose ($UTICA2), and can
  const uv = await view(w, w.f);
  assert.deepEqual([uv.gate, uv.coin.ticker, uv.inUse, uv.chosen.current], [null, "UTICA2", false, true]);
  await reprove(w.f);
  const a1 = await w.post(w.f, "/api/coins/ready/art", { cityId: UTICA });
  assert.equal((await w.post(w.f, "/api/coins/ready/use", { cityId: UTICA, contentHash: a1.coin.contentHash })).ok, true);
  // a swap of the two chosen tickers: each city takes its new one, neither is stuck
  relist(w, { 5128581: "NYC", 5140405: "UTICA2", 5106834: "ALBANY", 5142056: "UTICA" });
  s = await view(w, sy, SYRACUSE);
  const back = await view(w, w.f);
  assert.deepEqual([s.gate, back.gate], [null, null]);
  await reprove(sy); await reprove(w.f);
  const a2 = await w.post(sy, "/api/coins/ready/art", { cityId: SYRACUSE });
  assert.equal((await w.post(sy, "/api/coins/ready/use", { cityId: SYRACUSE, contentHash: a2.coin.contentHash })).ok, true);
  const a3 = await w.post(w.f, "/api/coins/ready/art", { cityId: UTICA });
  assert.equal((await w.post(w.f, "/api/coins/ready/use", { cityId: UTICA, contentHash: a3.coin.contentHash })).ok, true);
  const after = (await w.env.DB.prepare("SELECT city_id, symbol FROM coin_ready ORDER BY city_id").all()).results;
  assert.deepEqual(after.map((r) => [r.city_id, r.symbol]), [[SYRACUSE, "UTICA2"], [UTICA, "UTICA"]]);
  // an APPROVED choice keeps its ticker whatever the list says (the approval stands for it): never released
  await w.env.DB.prepare("UPDATE coin_ready SET approved_hash = content_hash WHERE city_id = ?").bind(UTICA).run();
  relist(w, { 5128581: "NYC", 5140405: "UTICA", 5106834: "ALBANY", 5142056: "UTICA2" });
  assert.equal((await view(w, sy, SYRACUSE)).gate.code, "symbol_taken");
});

test("SEC-S1-1: an earlier studio design saved a minute before 'Use this coin' is kept aside, and the public line says so only when it was", async () => {
  const w = await world({ ready: null });
  assert.equal((await w.post(w.f, "/api/coins/design", { name: "Utica Coin", pitch: "The Handshake City.", pair: "SOL", color: "emerald" })).ok, true);
  const before = await w.env.DB.prepare("SELECT * FROM city_coins WHERE city_id = ?").bind(UTICA).first();
  advance(60_000);
  w.env.COIN_V2_READY = "on";
  await reprove(w.f);
  const coin = await w.useCoin();
  assert.ok(coin.contentHash);
  const kept = (await w.env.DB.prepare("SELECT design_json FROM coin_legacy_designs WHERE city_id = ?").bind(UTICA).all()).results;
  assert.equal(kept.length, 1, "kept aside");
  assert.deepEqual(JSON.parse(kept[0].design_json), before);
  const note = (await w.env.DB.prepare("SELECT note FROM mod_actions WHERE action = 'coin_design' ORDER BY id DESC").first()).note;
  assert.match(note, /\(the earlier design is kept aside\)$/);
  // a choice made over a design row that is already the ready-made coin copies nothing, and says nothing of it
  relist(w, { 5128581: "NYC", 5140405: "SYRACUSE", 5106834: "ALBANY", 5142056: "UTICA" }, { "US.NY": "New York State" });
  advance(60_000);
  await reprove(w.f);
  const v = await w.post(w.f, "/api/coins/ready/art", { cityId: UTICA });
  assert.equal((await w.post(w.f, "/api/coins/ready/use", { cityId: UTICA, contentHash: v.coin.contentHash })).ok, true);
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM coin_legacy_designs").first()).n, 1);
  assert.doesNotMatch((await w.env.DB.prepare("SELECT note FROM mod_actions WHERE action = 'coin_design' ORDER BY id DESC").first()).note, /kept aside/);
});

test("SEC-S1-3: a bind that fails once (a database error) stores no JSON; the next record binds the version and publishes its picture", async () => {
  const w = await world();
  const coin = await w.useCoin();
  const sha = coin.art.slice(15, 79);
  assert.equal((await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(await w.card()) })).ok, true);
  const mint = await launchOnChain(w);
  advance(10 * 60_000);
  const db = w.env.DB;
  let failed = 0;
  w.env.DB = new Proxy(db, { get: (t, k) => (k === "prepare" ? (sql) => {
    const st = t.prepare(sql);
    if (!/^UPDATE coin_ready SET mint/.test(sql) || failed) return st;
    return { bind: (...a) => { const bound = st.bind(...a); return { ...bound, first: (...x) => bound.first(...x), all: (...x) => bound.all(...x), run: async () => { failed++; throw new Error("D1_ERROR: network connection lost"); } }; } };
  } : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  const rec = await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA });
  w.env.DB = db;
  assert.equal(failed, 1);
  assert.equal(rec.ok, true, JSON.stringify(rec));
  assert.equal((await db.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json, null, "nothing stored for good");
  assert.equal((await db.prepare("SELECT mint FROM coin_ready WHERE city_id = ?").bind(UTICA).first()).mint, null);
  // the next record (the page again, or the sweep) binds it and publishes the version's picture
  assert.equal((await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA })).ok, true);
  const j = JSON.parse((await db.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json);
  assert.equal(j.image, `https://vicinity.city/coin-meta/art/${sha}.png`);
  assert.equal((await db.prepare("SELECT mint FROM coin_ready WHERE city_id = ?").bind(UTICA).first()).mint, mint);
});

test("SEC-S1-3: the first /coin-meta read of a coin whose bind fails answers a short 503 and stores nothing; the next read binds and serves the version", async () => {
  const w = await world();
  const coin = await w.useCoin();
  const sha = coin.art.slice(15, 79);
  assert.equal((await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(await w.card()) })).ok, true);
  const mint = await launchOnChain(w);
  // recorded while the chain's metadata could not be read: no JSON yet
  const md = await metadataAddress(mint), saved = w.lp.S.accounts[md];
  delete w.lp.S.accounts[md];
  advance(10 * 60_000);
  assert.equal((await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA })).ok, true);
  w.lp.S.accounts[md] = saved;
  const { handleCoinMeta } = await import("../src/coinmeta.js");
  const read = (env) => handleCoinMeta(new Request(`https://vicinity.city/coin-meta/${mint}.json`, { headers: { "cf-connecting-ip": "198.51.100.9" } }), env, w.lp.fetchImpl);
  const db = w.env.DB;
  const broken = { ...w.env, DB: new Proxy(db, { get: (t, k) => (k === "prepare" ? (sql) => {
    const st = t.prepare(sql);
    if (!/^UPDATE coin_ready SET mint/.test(sql)) return st;
    return { bind: (...a) => { const bound = st.bind(...a); return { ...bound, run: async () => { throw new Error("D1_ERROR: overloaded"); } }; } };
  } : typeof t[k] === "function" ? t[k].bind(t) : t[k]) }) };
  const r1 = await read(broken);
  assert.equal(r1.status, 503);
  assert.match(r1.headers.get("cache-control"), /max-age=10\b/);
  assert.equal((await db.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json, null);
  const r2 = await read(w.env);
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).image, `https://vicinity.city/coin-meta/art/${sha}.png`);
});

test("S1R-6 / SEC-S1-6: unknown tickers count on this launchpad only and ALL of them (not the first 20); the owner's list sees every approval on chain", async () => {
  const w = await world();
  await w.useCoin();
  await ensureLpCoinsSchema(w.env.DB);
  const ins = (cluster, program, city, mint, symbol = null) => w.env.DB.prepare(`INSERT INTO lp_coins (cluster, program_id, city_id, mint, coin, founder, name, symbol, quote_mint, dbc_config, dbc_pool, recorded_at)
    VALUES (?, ?, ?, ?, 'c', 'f', ?, ?, 'q', 'd', 'p', 'now')`).bind(cluster, program, city, mint, symbol, symbol).run();
  // (a) a coin of another network or program with no symbol: it can't be read here nor launch here, so it blocks nothing
  await ins("mainnet", PROGRAM, "900000001", addr(1001));
  await ins("devnet", "OtherProgram1111111111111111111111111111111", "900000002", addr(1002));
  let c = await w.card();
  assert.equal(c.ok, true, JSON.stringify(c.reasons));
  // (b) 21 coins of this launchpad whose symbols were never read: the first 20 are read from the chain now, the 21st is still unknown
  const mints = [];
  for (let i = 0; i < 21; i++) { const m = addr(1010 + i); mints.push(m); await ins("devnet", PROGRAM, String(910000000 + i), m); }
  for (const m of mints.slice(0, 20)) w.lp.S.accounts[await metadataAddress(m)] = metadataAccount(m, "Town", `T${mints.indexOf(m)}`, `https://vicinity.city/coin-meta/${m}.json`);
  c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), /A coin launched for another city \(\d+\) has a ticker this site could not read/);
  // it is read on the next look (the chain has it now): free again
  const last = mints[20];
  w.lp.S.accounts[await metadataAddress(last)] = metadataAccount(last, "Town", "T20", `https://vicinity.city/coin-meta/${last}.json`);
  c = await w.card();
  assert.equal(c.ok, true, JSON.stringify(c.reasons));
  // (c) an approval on chain for a city with no design row here (outside the list's cities): its ticker is still taken
  const other = await person(w.env);
  w.lp.S.accounts[await w.L.approval(920000001n)] = approvalAccount({ cityId: "920000001", founder: other.w.address, rentPayer: w.owner.w.address, name: "Elsewhere", symbol: "UTICA", expiresAt: Math.floor(Date.now() / 1000) + 86_400 });
  c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), /The ticker UTICA is already launched or approved for another city \(920000001\)/);
});

test("S1R-5 / SEC-S1-2: switch on, a waiting LaunchLab contract is a candidate's reason, and a launch recorded anyway never names it in the public log", async () => {
  const w = await world();
  await w.useCoin();
  await w.env.DB.prepare("UPDATE city_coins SET pending_mint = ?, pending_at = 'x' WHERE city_id = ?").bind(WAITING, UTICA).run();
  const c = await w.card();
  assert.equal(c.ok, false);
  assert.ok(c.reasons.some((x) => /A Raydium LaunchLab contract sent for this city through the old path is still waiting/.test(x)), JSON.stringify(c.reasons));
  // the founder launches anyway with an approval used directly on chain: recorded, the contract dropped, its address only for the staff
  await launchOnChain(w);
  assert.equal((await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA })).ok, true);
  const note = (await w.env.DB.prepare("SELECT note FROM mod_actions WHERE action = 'coin_launched'").first()).note;
  assert.match(note, /A Raydium LaunchLab contract that was still waiting for this city was dropped: one city has one coin\.$/);
  assert.ok(!note.includes(WAITING));
  assert.ok(!JSON.stringify(await browser(w.env).get("/api/audit")).includes(WAITING));
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'coin_contract_dropped'").first()).n, 1);
});

test("S1R-1: /api/coins?city= says who made the design: the ready-made coin chosen or launched with it (madeBy vicinity), never a studio design", async () => {
  const w = await world();
  const pub = async () => (await w.get(browser(w.env), `/api/coins?city=${UTICA}`)).coin;
  await w.useCoin();
  assert.equal((await pub()).madeBy, "vicinity");
  // the founder's seat released: still Vicinity's coin
  await w.env.DB.prepare("UPDATE seats SET status = 'released' WHERE city_id = ?").bind(UTICA).run();
  assert.equal((await pub()).madeBy, "vicinity");
  await w.env.DB.prepare("UPDATE seats SET status = 'active' WHERE city_id = ?").bind(UTICA).run();
  // launched with it (bound): Vicinity's coin for good, whatever the switch says
  assert.equal((await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(await w.card()) })).ok, true);
  await launchOnChain(w);
  advance(10 * 60_000);
  assert.equal((await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA })).ok, true);
  assert.deepEqual([(await pub()).launched, (await pub()).madeBy], [true, "vicinity"]);
  w.env.COIN_V2_READY = "off";
  assert.equal((await pub()).madeBy, "vicinity");
  // a studio design: no key, and with the switch off nothing of it at all
  const w2 = await world({ ready: null });
  assert.equal((await w2.post(w2.f, "/api/coins/design", { name: "Utica Coin", pitch: "", pair: "SOL", color: "gold" })).ok, true);
  const studio = (await w2.get(browser(w2.env), `/api/coins?city=${UTICA}`)).coin;
  assert.equal("madeBy" in studio, false);
  w2.env.COIN_V2_READY = "on";
  assert.equal("madeBy" in (await w2.get(browser(w2.env), `/api/coins?city=${UTICA}`)).coin, false);
});
