// The ready-made city coin (COIN_V2_READY=on, src/coinready.js) through the real API and real SQL: exactly as before with the switch off;
// the founder's coin from the registry with no side effect on a GET; the picture drawn once per version by the founder's own POST and
// never on a page view; "Use this coin" records that exact version for the existing approval path, keeping an earlier studio design
// aside; every server check (founder, wallet, live amount, ban, registry ticker, launched / waiting contract, ticker taken elsewhere,
// design frozen, fresh proof, atomic counters); previews only for a city with a founder, labelled.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { BOUNDS, CITIES, IN_UTICA, MINT, browser, newWorld, person, realClock, reprove, setHolding, useClock, advance, chain } from "./helpers/world.js";
import { GATES, PREVIEW_LABEL, READY_LIMITS, _setArtRenderer, canonicalContent } from "../src/coinready.js";
import { NAME_OVERRIDES, coinDefaults, defaultDescription } from "../src/coindefaults.js";
import { nameProblem } from "../src/lpadmin.js";
import { coinSvg, sha256Hex } from "../src/coinart.js";
import { _resetCityCache } from "../src/cities.js";
import { _resetTickers } from "../src/tickers.js";
import { _resetLpCoins } from "../src/lpcoins.js";
import { ensureLpCoinsSchema } from "../src/lpcoins.js";
import { ensureLpAdminSchema } from "../src/lpadmin.js";
import { nodeRenderer } from "../scripts/coin-art/render.mjs";
import { readFileSync } from "node:fs";

const UTICA = "5142056", SYRACUSE = "5140405";
const ADMIN_NAMES = { "US.NY": "New York" };
let env, renders = 0, failRender = false;
before(async () => {
  const r = await nodeRenderer();
  _setArtRenderer(async (svg) => { renders++; if (failRender) throw new Error("render failed"); return r(svg); });
});
after(() => { _setArtRenderer(null); realClock(); });
beforeEach(() => { useClock("2026-10-20T12:00:00Z"); _resetLpCoins(); renders = 0; failRender = false; env = world(); });

/** The test world (four New York cities) with region names in the list, and the switch as given (on by default). */
function world(extra = { COIN_V2_READY: "on" }) {
  const e = newWorld({ VICINITY_MINT: MINT, ...extra });
  _resetCityCache(); _resetTickers();
  const files = { "/data/cities.json": JSON.stringify({ ...CITIES, admin: ADMIN_NAMES }), "/data/bounds/US.txt": BOUNDS,
    "/data/tickers.json": JSON.stringify({ 5128581: "NYC", 5140405: "SYRACUSE", 5106834: "ALBANY", 5142056: "UTICA" }) };
  e.ASSETS = { fetch: async (r) => { const f = files[new URL(r.url).pathname]; return f ? new Response(f) : new Response("", { status: 404 }); } };
  return e;
}
/** The active founder of `city` (the seat made directly, as in test/coins.test.js), holding the bar unless told otherwise. */
async function founder(e = env, { city = UTICA, name = "Utica", holds = 2_000_000, status = "active", wallet = null } = {}) {
  const f = await person(e, { home: IN_UTICA, holds });
  const u = await e.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  await e.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, ?, 'US', ?, ?, 3, 1000000, ?, ?, ?)")
    .bind(city, name, u.id, wallet || u.wallet, status, at, at).run();
  f.uid = u.id;
  return f;
}
const tables = async (e = env) => (await e.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((r) => r.name);
const NEW_TABLES = ["coin_art", "coin_versions", "coin_ready", "coin_legacy_designs"];
const view = (who, city = UTICA) => who.get(`/api/coins/ready?city=${city}`);
const art = (who, city = UTICA) => who.post("/api/coins/ready/art", { cityId: city });
const use = (who, contentHash, city = UTICA) => who.post("/api/coins/ready/use", { cityId: city, contentHash });
const row = (sql, ...p) => env.DB.prepare(sql).bind(...p).first();
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c63f8ffff3f0005fe02fea7d6a3f40000000049454e44ae426082", "hex").toString("base64");

test("switch off (unset, off, anything but on): the routes are unknown paths, /api/me has no key, nothing is made, the old routes are as before", async () => {
  for (const value of [undefined, "", "off", "yes", "true", "1", "onn", "o n"]) {
    env = world(value === undefined ? {} : { COIN_V2_READY: value });
    const f = await founder();
    for (const [path, method] of [["/api/coins/ready?city=" + UTICA, "GET"], ["/api/coins/ready", "POST"], ["/api/coins/ready", "PUT"], ["/api/coins/ready/art", "POST"],
      ["/api/coins/ready/art", "GET"], ["/api/coins/ready/use", "POST"], ["/api/coins/ready/use", "DELETE"]]) {
      const r = await f.send(path, { method, body: method === "GET" ? undefined : { cityId: UTICA, contentHash: "a".repeat(64) } });
      assert.equal(r.status, 404, `${value} ${method} ${path}`);
      assert.deepEqual(await r.json(), { error: "not_found" }, "the very answer of an unknown path");
    }
    const me = await f.get("/api/me");
    assert.equal("coinV2Ready" in me, false, String(value));
    // the studio and the LaunchLab contract route behave exactly as they always did
    const d = await f.post("/api/coins/design", { name: "Utica Coin", pitch: "The Handshake City.", pair: "SOL", color: "emerald", image: PNG });
    assert.equal(d.ok, true, JSON.stringify(d));
    const m = await f.post("/api/coins/mint", { mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" });
    assert.equal(m.ok, true, JSON.stringify(m));
    for (const t of NEW_TABLES) assert.equal((await tables()).includes(t), false, `${value}: no ${t}`);
    assert.equal(renders, 0);
  }
  // " ON " counts: exactly "on", trimmed, any letter case
  env = world({ COIN_V2_READY: " ON " });
  const f = await founder();
  assert.equal((await f.get("/api/me")).coinV2Ready, true);
  assert.equal((await view(f)).ok, true);
});

test("the founder's coin comes from the registry: ticker, name, city, region, country, default description; the GET changes nothing", async () => {
  const f = await founder();
  const v = await view(f);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.mode, "founder");
  assert.deepEqual(v.city, { id: UTICA, name: "Utica", region: "New York", regionCode: "NY", country: "US", countryName: "United States" });
  assert.deepEqual([v.coin.ticker, v.coin.name, v.coin.description, v.coin.pair, v.coin.templateVersion, v.coin.source],
    ["UTICA", "Utica", "The city coin of Utica, New York, United States.", "SOL", "t1", "Vicinity city list"]);
  assert.deepEqual([v.coin.art, v.coin.contentHash, v.coin.version, v.chosen, v.inUse, v.gate], [null, null, null, null, false, null], "no picture yet: none is drawn on a GET");
  assert.equal(renders, 0);
  for (const t of NEW_TABLES) assert.equal((await tables()).includes(t), false, `a GET makes no ${t}`);
  // a founder whose balance fell below the bar: the GET says so, and does NOT start the grace period (a POST would)
  setHolding(f.w.address, 10);
  const low = await view(f);
  assert.deepEqual(low.gate, { code: "in_grace", message: GATES.in_grace });
  assert.equal((await row("SELECT status, grace_until FROM seats WHERE user_id = ?", f.uid)).status, "active", "no side effect: still active");
  assert.equal((await row("SELECT grace_until FROM seats WHERE user_id = ?", f.uid)).grace_until, null);
  assert.equal((await f.send(`/api/coins/ready?city=${UTICA}`)).headers.get("cache-control"), "no-store");
  // bad ids
  for (const bad of ["", "abc", "0", "-1", "18446744073709551615", "1".repeat(21)]) assert.equal((await f.send(`/api/coins/ready?city=${bad}`)).status, 400, bad);
});

test("the picture is drawn once per version by the founder's POST, stored, and served for ever at /coin-meta/art/<sha256>.png", async () => {
  const f = await founder();
  const a = await art(f);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(renders, 1);
  assert.match(a.coin.art, /^\/coin-meta\/art\/[0-9a-f]{64}\.png$/);
  const sha = a.coin.art.slice(15, 79);
  // the content hash is the SHA-256 of the canonical content, which names the picture by its hash
  const content = canonicalContent({ city: { id: UTICA, name: "Utica", region: "New York", country: "US", countryName: "United States" }, name: "Utica", symbol: "UTICA",
    description: "The city coin of Utica, New York, United States.", artSha256: sha, templateVersion: "t1" });
  assert.equal(content, `{"v":1,"city":{"id":"5142056","name":"Utica","region":"New York","country":"US","countryName":"United States"},"name":"Utica","symbol":"UTICA","description":"The city coin of Utica, New York, United States.","image":{"sha256":"${sha}","template":"t1"},"pair":"SOL"}`);
  assert.equal(a.coin.contentHash, await sha256Hex(content));
  assert.equal(a.coin.version, a.coin.contentHash.slice(0, 8));
  // again, and the GET: the stored picture, never drawn twice
  assert.equal((await art(f)).coin.art, a.coin.art);
  assert.equal((await view(f)).coin.contentHash, a.coin.contentHash);
  assert.equal(renders, 1);
  const stored = await row("SELECT sha256, svg_sha256, template_version, type FROM coin_art");
  assert.deepEqual([stored.sha256, stored.svg_sha256, stored.template_version, stored.type], [sha, await sha256Hex(coinSvg({ ticker: "UTICA", city: "Utica" })), "t1", "image/png"]);
  // served: immutable, hash-named, safe headers; HEAD works; anyone can fetch it
  const res = await browser(env).send(a.coin.art.replace("/coin-meta", "/coin-meta"), { method: "GET" }).catch(() => null);
  assert.equal(res.status, 404, "/coin-meta is not under /api: handleApi does not serve it");
  const { handleCoinMeta } = await import("../src/coinmeta.js");
  const get = (path, method = "GET", e = env) => handleCoinMeta(new Request(`https://vicinity.city${path}`, { method, headers: { "cf-connecting-ip": "198.51.100.9" } }), e, chain());
  const r = await get(a.coin.art);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(await sha256Hex(new Uint8Array(await r.arrayBuffer())), sha);
  const h = await get(a.coin.art, "HEAD");
  assert.deepEqual([h.status, (await h.arrayBuffer()).byteLength], [200, 0]);
  assert.equal((await get(`/coin-meta/art/${"0".repeat(64)}.png`)).status, 404);
  assert.equal((await get(`/coin-meta/art/${sha.toUpperCase()}.png`)).status, 404, "lower-case hex only");
  // the bytes no longer hash to their name (a tampered row): never served
  await env.DB.prepare("UPDATE coin_art SET bytes = ? WHERE sha256 = ?").bind(new Uint8Array([1, 2, 3]), sha).run();
  assert.equal((await get(a.coin.art)).status, 404);
});

test("the picture route is the founder's only: signed out, cross-site, another city, another wallet; counted (20 an hour) before any work", async () => {
  const f = await founder();
  assert.equal((await browser(env).post("/api/coins/ready/art", { cityId: UTICA })).error, "sign_in");
  assert.equal((await f.send("/api/coins/ready/art", { method: "POST", body: { cityId: UTICA }, origin: "https://evil.example" })).status, 403);
  assert.equal((await art(f, SYRACUSE)).error, "not_founder");
  assert.equal((await art(f, "nope")).error, "bad_city");
  const other = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  assert.equal((await art(other)).error, "not_founder");
  setHolding(f.w.address, 10);
  assert.equal((await art(f)).error, "in_grace", "no picture for a founder below the bar");
  assert.equal((await row("SELECT status FROM seats WHERE user_id = ?", f.uid)).status, "active", "and no grace started by it");
  setHolding(f.w.address, 2_000_000);
  for (let i = 0; i < READY_LIMITS.art.max - 1; i++) assert.equal((await art(f)).ok, true); // the grace answer above was counted too
  const r = await f.send("/api/coins/ready/art", { method: "POST", body: { cityId: UTICA } });
  assert.equal(r.status, 429);
  assert.equal(renders, 1, "drawn once, whatever the number of asks");
  advance(61 * 60_000);
  assert.equal((await art(f)).ok, true, "a new hour");
});

test("Use this coin: a fresh proof and the exact version shown; the row becomes the defaults for the owner's approval; logged; idempotent", async () => {
  const f = await founder();
  const a = await art(f);
  const wrong = await use(f, "f".repeat(64));
  assert.deepEqual([wrong.ok, wrong.error], [false, "coin_changed"]);
  assert.equal(wrong.coin.contentHash, a.coin.contentHash, "the answer shows the current version");
  assert.equal(await row("SELECT 1 AS x FROM city_coins WHERE city_id = ?", UTICA), null, "nothing written");
  assert.equal((await use(f, "not-a-hash")).error, "bad_request");
  advance(31 * 60_000);
  assert.equal((await use(f, a.coin.contentHash)).error, "reprove", "a wallet proof in the last 30 minutes");
  await reprove(f);
  const r = await use(f, a.coin.contentHash);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.used, r.inUse, r.chosen.contentHash, r.chosen.current], [true, true, a.coin.contentHash, true]);
  const cc = await row("SELECT * FROM city_coins WHERE city_id = ?", UTICA);
  assert.deepEqual([cc.name, cc.pitch, cc.pair, cc.color, cc.media_id, cc.seat_id != null, cc.user_id, cc.mint], ["Utica", "The city coin of Utica, New York, United States.", "SOL", "ink", null, true, f.uid, null]);
  const ready = await row("SELECT * FROM coin_ready WHERE city_id = ?", UTICA);
  assert.deepEqual([ready.content_hash, ready.symbol, ready.design_at, ready.mint], [a.coin.contentHash, "UTICA", cc.updated_at, null]);
  const v = await row("SELECT * FROM coin_versions WHERE id = ?", ready.version_id);
  assert.equal(await sha256Hex(v.content_json), v.content_hash, "the stored content hashes to its name");
  assert.deepEqual([v.origin, v.name, v.symbol, v.art_sha256, v.template_version], ["default", "Utica", "UTICA", a.coin.art.slice(15, 79), "t1"]);
  // public: the design log line names the version; the public coin is the ready one
  const audit = (await browser(env).get("/api/audit?country=US")).actions.filter((x) => x.action === "coin_design");
  assert.equal(audit.length, 1);
  assert.match(audit[0].note, new RegExp(`^Utica: the Vicinity coin \\$UTICA "Utica", version ${a.coin.version}$`));
  const pub = await browser(env).get(`/api/coins?city=${UTICA}`);
  assert.deepEqual([pub.coin.name, pub.coin.pair, pub.coin.pitch], ["Utica", "SOL", "The city coin of Utica, New York, United States."]);
  // again: nothing new
  const again = await use(f, a.coin.contentHash);
  assert.deepEqual([again.ok, again.already], [true, true]);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'coin_design'").first()).n, 1);
  assert.equal(renders, 1);
  // while the switch is on, the old studio and the LaunchLab contract routes are closed
  const d = await f.send("/api/coins/design", { method: "POST", body: { name: "Moon", pitch: "", pair: "SOL", color: "gold" } });
  assert.deepEqual([d.status, (await d.json()).error], [409, "use_ready_coin"]);
  for (const p of ["/api/coins/mint", "/api/coins/mint/decide"]) {
    const m = await f.send(p, { method: "POST", body: { mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", city: UTICA } });
    assert.deepEqual([m.status, (await m.json()).error], [409, "launchpad_only"], p);
  }
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM city_coins WHERE pending_mint IS NOT NULL").first()).n, 0);
});

test("an earlier studio design is untouched by a visit, and copied aside whole (picture included) before Use this coin replaces it", async () => {
  env = world({}); // the switch off: the founder designs the old way
  const f = await founder();
  assert.equal((await f.post("/api/coins/design", { name: "Utica Coin", pitch: "The Handshake City.", pair: "USDC", color: "emerald", image: PNG })).ok, true);
  const before = await row("SELECT * FROM city_coins WHERE city_id = ?", UTICA);
  assert.ok(before.media_id && before.logo_status === "pending");
  env.COIN_V2_READY = "on";
  await view(f); await art(f); await view(browser(env));
  assert.deepEqual(await row("SELECT * FROM city_coins WHERE city_id = ?", UTICA), before, "a visit (and drawing the picture) never touches the earlier design");
  const a = await view(f);
  const r = await use(f, a.coin.contentHash);
  assert.equal(r.ok, true, JSON.stringify(r));
  const kept = (await env.DB.prepare("SELECT * FROM coin_legacy_designs WHERE city_id = ?").bind(UTICA).all()).results;
  assert.equal(kept.length, 1);
  assert.deepEqual(JSON.parse(kept[0].design_json), before, "the whole row, as it was");
  assert.equal(kept[0].copied_by, f.uid);
  assert.ok(await row("SELECT 1 AS x FROM media WHERE id = ?", before.media_id), "the picture's bytes are kept");
  const now = await row("SELECT name, pair, media_id, logo_status, approved_media_id FROM city_coins WHERE city_id = ?", UTICA);
  assert.deepEqual(now, { name: "Utica", pair: "SOL", media_id: null, logo_status: null, approved_media_id: null });
  assert.match((await browser(env).get("/api/audit?country=US")).actions[0].note, /the earlier design is kept aside/);
  // using it again copies nothing more (the row is the ready-made coin now)
  assert.equal((await use(f, a.coin.contentHash)).already, true);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM coin_legacy_designs").first()).n, 1);
  // the switch off again: the studio is back, and a save there makes the choice stale (the approval path sees the studio design)
  env.COIN_V2_READY = "off";
  advance(1000);
  assert.equal((await f.post("/api/coins/design", { name: "Utica Again", pitch: "", pair: "SOL", color: "gold" })).ok, true);
  const stale = await row("SELECT r.design_at, c.updated_at FROM coin_ready r JOIN city_coins c ON c.city_id = r.city_id WHERE r.city_id = ?", UTICA);
  assert.notEqual(stale.design_at, stale.updated_at);
  env.COIN_V2_READY = "on";
  const v = await view(f);
  assert.deepEqual([v.chosen.current, v.inUse], [false, false]);
});

test("every check again on the server: wallet, ban, waiting contract, launched coin, ticker taken elsewhere, registry, frozen design", async () => {
  const f = await founder();
  const hash = (await art(f)).coin.contentHash;
  const gateOf = async () => (await view(f)).gate;
  const refused = async (code, status = 409) => { const r = await f.send("/api/coins/ready/use", { method: "POST", body: { cityId: UTICA, contentHash: hash } }); assert.deepEqual([r.status, (await r.json()).error], [status, code], code); };

  // a LaunchLab contract waiting for a check (written the old way): skipped
  await env.DB.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, pending_mint, pending_at, updated_at, created_at) VALUES (?, 'Utica', 'US', 1, ?, 'Utica Coin', NULL, 'SOL', 'gold', ?, ?, ?, ?)")
    .bind(UTICA, f.uid, "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "2026-10-20T00:00:00Z", "2026-10-20T00:00:00Z", "2026-10-20T00:00:00Z").run();
  assert.equal((await gateOf()).code, "legacy_contract");
  await refused("legacy_contract");
  // launched (recorded the old way)
  await env.DB.prepare("UPDATE city_coins SET pending_mint = NULL, mint = ? WHERE city_id = ?").bind("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", UTICA).run();
  assert.equal((await gateOf()).code, "launched");
  await refused("launched");
  assert.equal((await view(browser(env))).preview, null, "no preview of a launched city");
  await env.DB.prepare("DELETE FROM city_coins WHERE city_id = ?").bind(UTICA).run();
  // launched on the launchpad (lp_coins), even before city_coins knows
  await ensureLpCoinsSchema(env.DB);
  await env.DB.prepare(`INSERT INTO lp_coins (cluster, program_id, city_id, mint, coin, founder, name, symbol, quote_mint, dbc_config, dbc_pool, recorded_at)
    VALUES ('devnet', 'P', ?, 'MintUtica', 'c', 'f', 'Utica', 'UTICA', 'q', 'd', 'p', 'now')`).bind(UTICA).run();
  assert.equal((await gateOf()).code, "launched");
  // the ticker launched for ANOTHER city (a moved ticker): never twice
  await env.DB.prepare("UPDATE lp_coins SET city_id = ? WHERE city_id = ?").bind(SYRACUSE, UTICA).run();
  assert.equal((await gateOf()).code, "symbol_taken");
  await refused("symbol_taken");
  await env.DB.prepare("DELETE FROM lp_coins").run();
  // an approval the owner built for another city with this ticker, not revoked since
  await ensureLpAdminSchema(env.DB);
  await env.DB.prepare("INSERT INTO lp_approvals_log (cluster, program_id, city_id, action, founder, name, symbol, expires_at, signature, by_wallet, at) VALUES ('mainnet', 'P', ?, 'approve', 'f', 'Syracuse', 'UTICA', 'x', 'sig1', 'w', 'now')").bind(SYRACUSE).run();
  assert.equal((await gateOf()).code, "symbol_taken");
  await env.DB.prepare("INSERT INTO lp_approvals_log (cluster, program_id, city_id, action, founder, name, symbol, expires_at, signature, by_wallet, at) VALUES ('mainnet', 'P', ?, 'revoke', NULL, NULL, NULL, NULL, 'sig2', 'w', 'now')").bind(SYRACUSE).run();
  assert.equal(await gateOf(), null, "revoked since: free again");
  // a ban, here or everywhere
  await env.DB.prepare("INSERT INTO bans (user_id, country, by_user, reason, created_at) VALUES (?, 'US', 1, 'spam', ?)").bind(f.uid, new Date(Date.now()).toISOString()).run();
  assert.equal((await gateOf()).code, "banned");
  await refused("banned", 403);
  await env.DB.prepare("DELETE FROM bans").run();
  // the account's wallet is not the seat's
  await env.DB.prepare("UPDATE seats SET wallet = ? WHERE user_id = ?").bind("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", f.uid).run();
  assert.equal((await gateOf()).code, "wallet_mismatch");
  await refused("wallet_mismatch", 403);
  await env.DB.prepare("UPDATE seats SET wallet = ? WHERE user_id = ?").bind(f.w.address, f.uid).run();
  // a real founder action below the bar: refused, and (as every founder action) the seat enters its grace period
  setHolding(f.w.address, 10);
  await refused("in_grace", 403);
  assert.equal((await row("SELECT status FROM seats WHERE user_id = ?", f.uid)).status, "grace");
  assert.equal((await gateOf()).code, "in_grace", "the seat in grace still sees its coin and why");
  assert.equal(await row("SELECT 1 AS x FROM coin_ready"), null, "nothing recorded through any of it");
});

test("the registry decides: a city it does not know has no coin; a list that cannot be read says so; the long names are shortened", async () => {
  const f = await founder(env, { city: "999999", name: "Newtown" });
  const v = await view(f, "999999");
  assert.deepEqual([v.mode, v.coin, v.gate.code], ["founder", null, "no_ticker"]);
  assert.equal((await art(f, "999999")).error, "no_ticker");
  assert.equal(renders, 0);
  _resetTickers();
  const down = world();
  const files = down.ASSETS;
  down.ASSETS = { fetch: async (r) => (new URL(r.url).pathname === "/data/tickers.json" ? new Response("", { status: 503 }) : files.fetch(r)) };
  const g = await founder(down);
  assert.equal((await g.get(`/api/coins/ready?city=${UTICA}`)).gate.code, "list_unavailable");
  _resetTickers();
  // the three registry names longer than a coin name may be (32 bytes) have a shorter coin name; every other is the name itself
  const cities = JSON.parse(readFileSync(new URL("../public/data/cities.json", import.meta.url), "utf8"));
  const tickers = JSON.parse(readFileSync(new URL("../public/data/tickers.json", import.meta.url), "utf8"));
  const needs = [];
  let n = 0;
  for (const [cc, list] of Object.entries(cities.byCountry)) for (const r of list) {
    if (!tickers[String(r[0])]) continue;
    n++;
    if (nameProblem(r[1])) needs.push(String(r[0]));
    const name = NAME_OVERRIDES[r[0]] || r[1];
    assert.equal(nameProblem(name), null, `${r[0]} ${name}`);
    const region = r[2] ? cities.admin[`${cc}.${r[2]}`] || null : null;
    const desc = defaultDescription({ name: r[1], region, countryName: cities.countries[cc] });
    assert.ok(desc.length <= 200 && !/https?:|www\./.test(desc), desc);
  }
  assert.equal(n, 8030);
  assert.deepEqual(needs.sort(), Object.keys(NAME_OVERRIDES).sort(), "the overrides hold exactly the names that need one");
  assert.equal(defaultDescription({ name: "Singapore", region: "Singapore", countryName: "Singapore" }), "The city coin of Singapore.");
  assert.equal(defaultDescription({ name: "Flying Fish Cove", region: null, countryName: "Christmas Island" }), "The city coin of Flying Fish Cove, Christmas Island.");
  const real = { ASSETS: { fetch: async (r) => new Response(readFileSync(new URL(`../public${new URL(r.url).pathname}`, import.meta.url))) } };
  _resetCityCache(); _resetTickers();
  const g2 = await coinDefaults(real, "2917788", "DE");
  assert.deepEqual([g2.ok, g2.name, g2.ticker, g2.city.name], [true, "Greifswald", "UUHG", "Universitäts- und Hansestadt Greifswald"]);
  assert.equal((await coinDefaults(real, "5142056", "FR")).code, "not_in_list", "the id must be a city of that country");
  _resetCityCache(); _resetTickers();
});

test("a design frozen on chain (the owner approving or approved) is not replaced; the chain unreadable is said, never guessed", async () => {
  const { LP_ON, PROGRAM, lpChain } = await import("./helpers/lpchain.js");
  const { launchpad: pdas } = await import("../src/sol/pda.js");
  env = world({ COIN_V2_READY: "on", ...LP_ON });
  const lp = lpChain();
  const main = chain();
  const both = (url, init) => (String(url).startsWith(LP_ON.LAUNCHPAD_RPC_URL) ? lp.fetchImpl(url, init) : main(url, init));
  const f = await founder();
  const call = async (path, body) => (await f.send(path, { method: body ? "POST" : "GET", body, fetchImpl: both })).json();
  const a = await call("/api/coins/ready/art", { cityId: UTICA });
  assert.equal(a.gate, null, JSON.stringify(a));
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind(`lp_design_hold:${UTICA}`, new Date(Date.now() + 60_000).toISOString()).run();
  assert.equal((await call(`/api/coins/ready?city=${UTICA}`)).gate.code, "held");
  assert.equal((await call("/api/coins/ready/use", { cityId: UTICA, contentHash: a.coin.contentHash })).error, "held");
  advance(120_000);
  lp.S.accounts[await pdas(PROGRAM).approval(BigInt(UTICA))] = { owner: PROGRAM, data: Buffer.alloc(179).toString("base64") };
  assert.equal((await call(`/api/coins/ready?city=${UTICA}`)).gate.code, "approved");
  assert.equal((await call("/api/coins/ready/use", { cityId: UTICA, contentHash: a.coin.contentHash })).error, "approved");
  lp.S.down = true;
  assert.equal((await call(`/api/coins/ready?city=${UTICA}`)).gate.code, "rpc_unavailable");
  const r = await f.send("/api/coins/ready/use", { method: "POST", body: { cityId: UTICA, contentHash: a.coin.contentHash }, fetchImpl: both });
  assert.deepEqual([r.status, (await r.json()).error], [503, "rpc_unavailable"]);
  assert.equal(await row("SELECT 1 AS x FROM coin_ready"), null);
});

test("Use this coin is counted per account, atomically, before any work (10 a day); a ticker another city chose is refused", async () => {
  const f = await founder();
  const hash = (await art(f)).coin.contentHash;
  for (let i = 0; i < READY_LIMITS.use.max; i++) assert.equal((await use(f, hash)).ok, true);
  const r = await f.send("/api/coins/ready/use", { method: "POST", body: { cityId: UTICA, contentHash: hash } });
  assert.equal(r.status, 429);
  // another city that holds the ticker in its own choice (a moved ticker): the unique symbol refuses the second
  env = world();
  const g = await founder();
  const h2 = (await art(g)).coin.contentHash;
  const { ensureReadySchema } = await import("../src/coinart-store.js");
  await ensureReadySchema(env.DB);
  await env.DB.prepare("INSERT INTO coin_ready (city_id, version_id, content_hash, symbol, design_at, seat_id, user_id, chosen_at) VALUES (?, 1, ?, 'UTICA', 'x', 1, 1, 'x')").bind(SYRACUSE, "e".repeat(64)).run();
  assert.equal((await view(g)).gate.code, "symbol_taken");
  assert.equal((await use(g, h2)).error, "symbol_taken");
});

test("previews: only for a city that has a founder, labelled Preview, not launched; never drawn for a visitor; counted per connection", async () => {
  const visitor = browser(env, { ip: "203.0.113.5" });
  assert.deepEqual(await view(visitor), { ok: true, mode: "preview", preview: null }, "Utica has no founder yet: no preview");
  assert.deepEqual(await view(visitor, SYRACUSE), { ok: true, mode: "preview", preview: null });
  const f = await founder();
  const p = await view(visitor);
  assert.deepEqual(p.preview, { label: PREVIEW_LABEL, ticker: "UTICA", name: "Utica", description: "The city coin of Utica, New York, United States.",
    city: { name: "Utica", region: "New York", countryName: "United States" }, art: null });
  assert.equal(PREVIEW_LABEL, "Preview, not launched");
  assert.equal(renders, 0, "a visitor never makes a picture");
  const a = await art(f);
  assert.equal((await view(visitor)).preview.art, a.coin.art, "once the founder's picture exists, the preview shows it");
  // a member of the city who is not the founder sees the preview too (not the founder's view)
  const member = await person(env, { home: IN_UTICA, holds: 10 });
  assert.equal((await view(member)).mode, "preview");
  // a seat in grace still means the city has a founder; a provisional one does not yet
  await env.DB.prepare("UPDATE seats SET status = 'provisional' WHERE user_id = ?").bind(f.uid).run();
  assert.equal((await view(visitor)).preview, null);
  let last;
  for (let i = 0; i < 61; i++) last = await visitor.send(`/api/coins/ready?city=${UTICA}`);
  assert.equal(last.status, 429, "60 a minute per connection");
});
