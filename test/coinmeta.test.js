// /coin-meta/<mint>.json and .png (src/coinmeta.js): dark without the city-coin settings (and nothing created in the database);
// with them, the JSON of metadata.mts built from the ON-CHAIN name and symbol and the city's design, kept in lp_coins and served
// from there for ever (even after the settings go); the on-chain uri must be this very URL; an unknown mint costs one RPC call
// per 5 minutes and counts against coin_meta; the logo with its real type or a redirect to the brand PNG; CORS and cache headers.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { coinMetadataJson, coinPageUrl, handleCoinMeta, metadataUriFor } from "../src/coinmeta.js";
import { _resetLpCoins, recordLaunchedCoin } from "../src/lpcoins.js";
import { _resetLpKit } from "../src/lpkit.js";
import { ensureLogoSchema } from "../src/store.js";
import { hashOf, rejectLogo } from "../src/logos.js";
import { metadataAddress } from "../src/sol/metaplex.js";
import { LAYOUT } from "../src/sol/layout.js";
import { newWorld } from "./helpers/world.js";
import { seedCoin } from "./helpers/launchpad.js";
import { DEMOV, DEMOV_CITY, LP_ON, METAPLEX, addr, lpChain, metaplexData } from "./helpers/lpchain.js";

const NYC = { id: 5128581, name: "New York City", country: "US", ticker: "NYC" };
const MINT = addr(42);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(40).fill(1)]);
beforeEach(() => { _resetLpCoins(); _resetLpKit(); });
const get = (env, chain, path, { method = "GET", now = Date.now(), ip = "198.51.100.7" } = {}) =>
  handleCoinMeta(new Request(`https://vicinity.city${path}`, { method, headers: { "cf-connecting-ip": ip } }), env, chain.fetchImpl, now);
async function demovWorld({ uri = metadataUriFor(DEMOV), name = "Demo Vicinity", symbol = "DEMOV", design = true } = {}) {
  const env = { ...newWorld(), ...LP_ON };
  const chain = lpChain({ accounts: { [await metadataAddress(DEMOV)]: { owner: METAPLEX, lamports: 5_616_720, data: metaplexData({ mint: DEMOV, name, symbol, uri }) } } });
  if (design) await seedCoin(env.DB, { city: DEMOV_CITY, name: "Demo City", country: "US", coin: "Edited Later", pitch: "A city that tests things.", user: 1, seat: 1 });
  return { env, chain };
}
const tables = async (env) => (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((r) => r.name);

test("coin-meta: the JSON is metadata.mts's, with external_url and website /coin?mint= (parity with the SDK's own expectations)", () => {
  const j = coinMetadataJson({ mint: MINT, name: "New York City Coin", symbol: "NYC", city: NYC });
  assert.deepEqual(j, {
    name: "New York City Coin", symbol: "NYC",
    description: "The city coin of New York City. Launched on Vicinity (https://vicinity.city) on Solana.",
    image: `https://vicinity.city/coin-meta/${MINT}.png`, external_url: `https://vicinity.city/coin?mint=${MINT}`,
    createdOn: "https://vicinity.city", launchpad: "Vicinity", launchpadLogo: "https://vicinity.city/brand/vicinity-512.png", network: "Solana",
    city: { id: 5128581, name: "New York City", country: "US", ticker: "NYC" }, showName: true,
    attributes: [{ trait_type: "Launchpad", value: "Vicinity" }, { trait_type: "Network", value: "Solana" }, { trait_type: "City", value: "New York City" }],
    website: `https://vicinity.city/coin?mint=${MINT}`,
  });
  assert.equal(coinPageUrl(MINT), `https://vicinity.city/coin?mint=${MINT}`);
  assert.equal(metadataUriFor(MINT), `${LAYOUT.constants.METADATA_URI_PREFIX}${MINT}.json`);
  assert.equal(LAYOUT.constants.METADATA_URI_PREFIX, "https://vicinity.city/coin-meta/");
  assert.throws(() => coinMetadataJson({ mint: MINT, name: "x".repeat(33), symbol: "NYC", city: NYC }), /1 to 32 bytes/);
  assert.throws(() => coinMetadataJson({ mint: MINT, name: "X", symbol: "LA", city: NYC }), /city ticker/);
  assert.throws(() => coinMetadataJson({ mint: MINT, name: "X", symbol: "NYC", city: NYC, pitch: "see www.x.com" }), /links/);
});

test("coin-meta: dark with production-like settings: 404 JSON with CORS, no RPC call, no table created; the dispatch is before the static files", async () => {
  const env = newWorld();
  const chain = lpChain();
  for (const p of [`/coin-meta/${DEMOV}.json`, `/coin-meta/${DEMOV}.png`, "/coin-meta/x.json", "/coin-meta/"]) {
    const r = await get(env, chain, p);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("cache-control"), "public, max-age=60");
    assert.match(r.headers.get("content-type"), /^application\/json/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await r.json(), { ok: false, error: "not_found" });
  }
  const head = await get(env, chain, `/coin-meta/${DEMOV}.json`, { method: "HEAD" });
  assert.equal(head.status, 404);
  assert.equal(await head.text(), "");
  assert.equal((await get(env, chain, `/coin-meta/${DEMOV}.json`, { method: "POST" })).status, 405);
  assert.equal(chain.S.log.length, 0, "no node is asked");
  // a warm server does no database work at all while dark: the missing lp_coins table is remembered (it is only ever created with
  // the settings on, which is another deploy)
  let statements = 0;
  const prep = env.DB.prepare;
  env.DB.prepare = function (sql) { statements++; return prep.call(this, sql); };
  for (let i = 0; i < 5; i++) assert.equal((await get(env, chain, `/coin-meta/${addr(300 + i)}.json`)).status, 404);
  env.DB.prepare = prep;
  assert.equal(statements, 0, "no D1 statement per request while dark");
  assert.ok(!(await tables(env)).includes("lp_coins"), "nothing new in the database while dark");
  // through the Worker's own fetch (not the static files: wrangler.jsonc run_worker_first has /coin-meta/*)
  const assetsAsked = [];
  const r = await worker.fetch(new Request(`http://localhost/coin-meta/${DEMOV}.json`), { ...env, ASSETS: { fetch: async (q) => { assetsAsked.push(q.url); return new Response("page", { status: 404 }); } } }, {});
  assert.equal(r.status, 404);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(assetsAsked, []);
});

test("coin-meta: with the settings, a launched coin's JSON comes from the chain's name and symbol and the city's design, then from the database", async () => {
  const { env, chain } = await demovWorld();
  // the Coin record's oldest signature is the APPROVAL (approve_launch reads that address); the metadata account's is the launch
  chain.S.signatures["DcCDswmYyzh4ZXkXHLenxGGcjq1WGSXpEgiuPc4pwZCw"] = [{ signature: "4VW2nMkqHr7E6TesgW1zdWBHrC1kKwDMkuqMDmHk4P9hTS9ftCwErGx3qp5DUsJvfjRfgqnVieRuFfCrCT3zXWeC", err: null }];
  chain.S.signatures[await metadataAddress(DEMOV)] = [{ signature: "5ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk", err: null }];
  const r = await get(env, chain, `/coin-meta/${DEMOV}.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  const j = await r.json();
  assert.deepEqual(j, coinMetadataJson({ mint: DEMOV, name: "Demo Vicinity", symbol: "DEMOV", pitch: "A city that tests things.", city: { id: DEMOV_CITY, name: "Demo City", country: "US", ticker: "DEMOV" } }));
  assert.equal(j.name, "Demo Vicinity", "the chain's name, not the design's (\"Edited Later\")");
  assert.equal(chain.calls("getProgramAccounts").length, 1);
  const pga = chain.calls("getProgramAccounts")[0].params[1].filters;
  // 243 bytes, the Coin discriminator d7c335eed9c4d533 (base58 d6AgYymcV8v) at byte 0, the mint at byte 48
  assert.deepEqual(pga, [{ dataSize: 243 }, { memcmp: { offset: 0, bytes: "d6AgYymcV8v" } }, { memcmp: { offset: 48, bytes: DEMOV } }]);
  // recorded (src/lpcoins.js): the row, the city's mint (the design is locked), the public log line
  const row = await env.DB.prepare("SELECT * FROM lp_coins WHERE mint = ?").bind(DEMOV).first();
  assert.deepEqual([row.cluster, row.program_id, row.city_id, row.name, row.symbol, row.launch_sig], ["devnet", LP_ON.LAUNCHPAD_PROGRAM_ID, DEMOV_CITY, "Demo Vicinity", "DEMOV", "5ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk"]);
  const design = await env.DB.prepare("SELECT mint, name FROM city_coins WHERE city_id = ?").bind(DEMOV_CITY).first();
  assert.deepEqual([design.mint, design.name], [DEMOV, "Demo Vicinity"], "locked, and named as on chain (not the edited \"Edited Later\")");
  // the second answer is the database's: no node asked, the same bytes
  const before = chain.S.log.length;
  const again = await get(env, chain, `/coin-meta/${DEMOV}.json`);
  assert.deepEqual(await again.json(), j);
  assert.equal(chain.S.log.length, before);
  const head = await get(env, chain, `/coin-meta/${DEMOV}.json`, { method: "HEAD" });
  assert.deepEqual([head.status, await head.text()], [200, ""]);
  // the settings gone: a recorded coin keeps answering from the database
  const off = { ...env, LAUNCHPAD_CLUSTER: undefined, LAUNCHPAD_PROGRAM_ID: undefined, LAUNCHPAD_REWARDS_PROGRAM_ID: undefined };
  const kept = await get(off, chain, `/coin-meta/${DEMOV}.json`);
  assert.equal(kept.status, 200);
  assert.deepEqual(await kept.json(), j);
  assert.equal(chain.S.log.length, before);
});

test("coin-meta: an on-chain uri that is not this URL, or no metadata, answers 404 without a program-wide lookup (recorded only by its city)", async () => {
  const { env, chain } = await demovWorld({ uri: "https://elsewhere.example/x.json" });
  const r = await get(env, chain, `/coin-meta/${DEMOV}.json`);
  assert.equal(r.status, 404);
  assert.equal(chain.calls("getProgramAccounts").length, 0, "a mint whose metadata does not point here is never looked up program-wide");
  assert.equal(await env.DB.prepare("SELECT 1 FROM lp_coins WHERE mint = ?").bind(DEMOV).first(), null);
  // recorded by its city (the founder's page, the sweep): still no JSON for a uri that is not this URL
  assert.equal((await recordLaunchedCoin(env, { cityId: DEMOV_CITY }, chain.fetchImpl)).ok, true);
  assert.ok(await env.DB.prepare("SELECT 1 FROM lp_coins WHERE mint = ? AND meta_json IS NULL").bind(DEMOV).first());
  assert.equal((await get(env, chain, `/coin-meta/${DEMOV}.json`, { now: Date.now() + 6 * 60_000 })).status, 404);
  _resetLpCoins(); // a new server
  const { env: e2, chain: c2 } = await demovWorld();
  delete c2.S.accounts[await metadataAddress(DEMOV)];
  assert.equal((await get(e2, c2, `/coin-meta/${DEMOV}.json`)).status, 404);
  // the metadata appears later (the next request after the negative memo): built then
  c2.S.accounts[await metadataAddress(DEMOV)] = { owner: METAPLEX, data: metaplexData({ mint: DEMOV, name: "Demo Vicinity", symbol: "DEMOV", uri: metadataUriFor(DEMOV) }) };
  assert.equal((await get(e2, c2, `/coin-meta/${DEMOV}.json`, { now: Date.now() + 6 * 60_000 })).status, 200);
});

test("coin-meta: an unknown mint costs one getAccountInfo per 5 minutes and never a getProgramAccounts; the chain lookups count against coin_meta", async () => {
  const { env, chain } = await demovWorld();
  const unknown = addr(500);
  const metaOf = async (m) => chain.calls("getAccountInfo").filter((c) => c.params[0] === m).length;
  const unknownMeta = await metadataAddress(unknown);
  const t0 = Date.now();
  assert.equal((await get(env, chain, `/coin-meta/${unknown}.json`, { now: t0 })).status, 404);
  assert.equal((await get(env, chain, `/coin-meta/${unknown}.png`, { now: t0 + 1000 })).status, 404);
  assert.equal(await metaOf(unknownMeta), 1, "remembered as unknown");
  assert.equal((await get(env, chain, `/coin-meta/${unknown}.json`, { now: t0 + 5 * 60_000 + 1 })).status, 404);
  assert.equal(await metaOf(unknownMeta), 2, "asked again after 5 minutes");
  assert.equal(chain.calls("getProgramAccounts").length, 0, "the expensive program-wide lookup only for a mint whose metadata points here");
  // 40 invented mints from 40 connections (each under its own per-connection counter): 40 cheap reads, no program-wide lookup
  for (let i = 0; i < 40; i++) assert.equal((await get(env, chain, `/coin-meta/${addr(700 + i)}.json`, { now: t0 + 6 * 60_000, ip: `203.0.113.${i}` })).status, 404);
  assert.equal(chain.calls("getProgramAccounts").length, 0);
  // a flood of invented mints from one connection: the 61st chain lookup in a minute is refused
  let last;
  for (let i = 0; i < 61; i++) last = await get(env, chain, `/coin-meta/${addr(600 + i)}.json`, { now: t0 + 10 * 60_000 });
  assert.equal(last.status, 429);
  assert.equal(last.headers.get("access-control-allow-origin"), "*");
  // a recorded coin is never counted: it answers from the database
  assert.equal((await get(env, chain, `/coin-meta/${DEMOV}.json`, { now: t0 + 10 * 60_000 })).status, 429, "not recorded yet: a chain lookup, refused");
  assert.equal((await get(env, chain, `/coin-meta/${DEMOV}.json`, { now: t0 + 10 * 60_000, ip: "203.0.113.9" })).status, 200);
  assert.equal((await get(env, chain, `/coin-meta/${DEMOV}.json`, { now: t0 + 10 * 60_000 })).status, 200, "recorded: the flooded connection gets it from the database");
});

test("coin-meta: a recorded coin whose JSON is not built yet costs at most one metadata read per 5 minutes, and those reads count against coin_meta (merge review A, minor 1)", async () => {
  const { env, chain } = await demovWorld();
  const metaAddr = await metadataAddress(DEMOV);
  const saved = chain.S.accounts[metaAddr];
  delete chain.S.accounts[metaAddr]; // the metadata could not be read when the coin was recorded
  assert.equal((await recordLaunchedCoin(env, { cityId: DEMOV_CITY }, chain.fetchImpl)).ok, true);
  assert.ok(await env.DB.prepare("SELECT 1 FROM lp_coins WHERE mint = ? AND meta_json IS NULL").bind(DEMOV).first());
  const reads = () => chain.calls("getAccountInfo").filter((c) => c.params[0] === metaAddr).length;
  const before = reads();
  const t0 = Date.now() + 6 * 60_000; // past any memo the recording itself left
  // 100 requests from 100 connections within 5 minutes: one chain read, then the negative memo answers
  for (let i = 0; i < 100; i++) assert.equal((await get(env, chain, `/coin-meta/${DEMOV}.json`, { now: t0 + i * 1000, ip: `198.18.0.${i}` })).status, 404);
  assert.equal(reads() - before, 1, "one getAccountInfo for 100 public requests");
  // the node fails (no memo for a failure): one connection's reads stop at the coin_meta counter, 429 with CORS
  chain.S.down = true;
  const statuses = [];
  for (let i = 0; i < 61; i++) statuses.push((await get(env, chain, `/coin-meta/${DEMOV}.json`, { now: t0 + 6 * 60_000, ip: "198.18.1.1" })).status);
  assert.deepEqual([...new Set(statuses.slice(0, 60))], [503]);
  assert.equal(statuses[60], 429, "the 61st read in a minute is refused");
  const refused = await get(env, chain, `/coin-meta/${DEMOV}.json`, { now: t0 + 6 * 60_000, ip: "198.18.1.1", method: "HEAD" });
  assert.deepEqual([refused.status, refused.headers.get("access-control-allow-origin"), await refused.text()], [429, "*", ""]);
  // the metadata appears and the node is back: built on the next read after the memo, then served from the database to everyone
  chain.S.down = false;
  chain.S.accounts[metaAddr] = saved;
  const built = await get(env, chain, `/coin-meta/${DEMOV}.json`, { now: t0 + 6 * 60_000, ip: "198.18.2.2" });
  assert.equal(built.status, 200);
  assert.equal((await get(env, chain, `/coin-meta/${DEMOV}.json`, { now: t0 + 6 * 60_000, ip: "198.18.1.1" })).status, 200, "the flooded connection reads it from the database");
});

test("coin-meta: the PNG is the founder's APPROVED logo with its real type, or a redirect to the brand PNG (no logo, waiting for a check, tampered, taken down)", async () => {
  const { env, chain } = await demovWorld();
  const none = await get(env, chain, `/coin-meta/${DEMOV}.png`);
  assert.deepEqual([none.status, none.headers.get("location"), none.headers.get("access-control-allow-origin")], [302, "/brand/vicinity-512.png", "*"]);
  await ensureLogoSchema(env.DB);
  const m = await env.DB.prepare("INSERT INTO media (user_id, type, bytes, created_at) VALUES (1, 'image/png', ?, ?)").bind(PNG, new Date().toISOString()).run();
  // uploaded, waiting for an admin's check (src/logos.js): the badge still
  await env.DB.prepare("UPDATE city_coins SET media_id = ?, logo_status = 'pending' WHERE city_id = ?").bind(m.meta.last_row_id, DEMOV_CITY).run();
  assert.equal((await get(env, chain, `/coin-meta/${DEMOV}.png`)).status, 302, "a picture nobody approved is never served");
  // approved: the picture, with the hash of its bytes on the row
  await env.DB.prepare("UPDATE city_coins SET approved_media_id = media_id, logo_hash = ?, logo_status = 'approved' WHERE city_id = ?").bind(await hashOf(PNG), DEMOV_CITY).run();
  const logo = await get(env, chain, `/coin-meta/${DEMOV}.png`);
  assert.equal(logo.status, 200);
  assert.deepEqual([logo.headers.get("content-type"), logo.headers.get("cache-control"), logo.headers.get("x-content-type-options")], ["image/png", "public, max-age=3600", "nosniff"]);
  assert.deepEqual(new Uint8Array(await logo.arrayBuffer()), PNG);
  // the bytes swapped under the approved row: not what the admin approved, so the badge
  await env.DB.prepare("UPDATE media SET bytes = ? WHERE id = ?").bind(Uint8Array.from([...PNG.slice(0, 8), ...new Uint8Array(40).fill(2)]), m.meta.last_row_id).run();
  assert.equal((await get(env, chain, `/coin-meta/${DEMOV}.png`)).status, 302, "tampered bytes are never served");
  await env.DB.prepare("UPDATE media SET bytes = ? WHERE id = ?").bind(PNG, m.meta.last_row_id).run();
  assert.equal((await get(env, chain, `/coin-meta/${DEMOV}.png`)).status, 200);
  // an admin took it down (src/coins.js handleTakedown → rejectLogo): the public picture goes, the badge is back
  await rejectLogo(env.DB, DEMOV_CITY, { reason: "abuse", note: "Offensive picture", by: 1, at: Date.now(), takedown: true });
  assert.equal((await get(env, chain, `/coin-meta/${DEMOV}.png`)).status, 302);
});

test("the brand PNG (public/brand/vicinity-512.png, scripts/brand-png.mjs): 512 x 512, an opaque PNG on the site's background, at most 60 KB", async () => {
  const { readFileSync } = await import("node:fs");
  const { pngInfo } = await import("../scripts/brand-png.mjs");
  const bytes = new Uint8Array(readFileSync(new URL("../public/brand/vicinity-512.png", import.meta.url)));
  const info = pngInfo(bytes);
  assert.deepEqual([info.width, info.height], [512, 512]);
  assert.ok([0, 2, 3].includes(info.colorType), `no alpha channel (colour type ${info.colorType})`);
  assert.ok(bytes.length <= 60 * 1024, `${bytes.length} bytes`);
  // the URL the SDK's partner metadata and the JSON name is this very file
  assert.equal(coinMetadataJson({ mint: MINT, name: "X", symbol: "NYC", city: NYC }).launchpadLogo, "https://vicinity.city/brand/vicinity-512.png");
});
