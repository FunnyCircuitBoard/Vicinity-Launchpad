// The ready-made coin through the EXISTING approval and launch path (COIN_V2_READY=on): the owner's City coins tab approves only the
// founder's chosen ready-made coin (its name, ticker and description are the defaults; the version and picture are on the card), never a
// ticker another city launched or holds an approval for; the approval binds the defaults as today; the launch record then publishes the
// template picture at /coin-meta/art/<sha256>.png and the metadata JSON built on the server from the version, bound to the coin for good
// and served whatever any switch says afterwards. With the switch off the candidate list is exactly as before.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BOUNDS, CITIES, IN_UTICA, MINT, advance, browser, newWorld, person, realClock, useClock, chain } from "./helpers/world.js";
import { _resetLpKit, GENESIS } from "../src/lpkit.js";
import { _resetLpAdmin } from "../src/lpadmin.js";
import { _resetLpCoins, ensureLpCoinsSchema } from "../src/lpcoins.js";
import { _resetCityCache } from "../src/cities.js";
import { _resetTickers } from "../src/tickers.js";
import { handleCoinMeta } from "../src/coinmeta.js";
import { _setArtRenderer } from "../src/coinready.js";
import { sha256Hex } from "../src/coinart.js";
import { base58Decode, base58Encode } from "../src/solana.js";
import { concat, u32le, u64le } from "../src/sol/bytes.js";
import { LAYOUT } from "../src/sol/layout.js";
import { ADDRESSES, PROGRAM_IDS, launchpad as launchpadPdas, programDataAddress } from "../src/sol/pda.js";
import { metadataAddress } from "../src/sol/metaplex.js";
import { meteoraAsTested } from "./helpers/lpchain.js";
import { nodeRenderer } from "../scripts/coin-art/render.mjs";

const PROGRAM = "Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7", REWARDS = "Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi";
const LOADER = PROGRAM_IDS.upgradeableLoader, WSOL = ADDRESSES.wsol, METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const UTICA = "5142056";
const b64 = (u8) => Buffer.from(u8).toString("base64");
let n = 0;
const fresh = () => base58Encode(Uint8Array.from({ length: 32 }, (_, j) => (++n * 37 + j * 11 + 5) & 255));
const CONFIG = fresh();
// the price curve's bytes are the live mainnet one's (EZVHCg…, made with DBC 0.2.1: PoolConfig.version 0), which approvals name
const LIVE_CONFIG = JSON.parse(readFileSync(new URL("./fixtures/launchpad-worker/mainnet-pool-config.json", import.meta.url), "utf8")).accounts.EZVHCgxKZhvXmUGMXJMEw8tZHiTmoHPyM9mNNQ5u1kSP;
const enc = new TextEncoder();
const s32 = (s) => concat([u32le(enc.encode(s).length), enc.encode(s)]);

function layoutAccount(name, values) {
  const L = LAYOUT[name], out = new Uint8Array(L.size);
  out.set(L.discriminator, 0);
  for (const [k, v] of Object.entries(values)) {
    const f = L.fields[k];
    if (f.type === "pubkey") out.set(base58Decode(v), f.at);
    else if (f.type === "u64" || f.type === "i64") out.set(u64le(BigInt.asUintN(64, BigInt(v))), f.at);
    else out[f.at] = Number(v);
  }
  return out;
}
const programAccount = (pd) => ({ owner: LOADER, executable: true, data: b64(concat([u32le(2), base58Decode(pd)])) });
const programDataAccount = (authority) => ({ owner: LOADER, data: b64(concat([u32le(3), u64le(1234), Uint8Array.of(1), base58Decode(authority), new Uint8Array(64).fill(7)])) });
function approvalAccount({ cityId, founder, rentPayer, name, symbol, expiresAt }) {
  const body = concat([Uint8Array.of(233, 9, 153, 49, 11, 222, 59, 130), u64le(cityId), base58Decode(founder), base58Decode(CONFIG), base58Decode(rentPayer), s32(name), s32(symbol), u64le(1), u64le(expiresAt), Uint8Array.of(254)]);
  const out = new Uint8Array(179); out.set(body);
  return { owner: PROGRAM, data: b64(out) };
}
const metadataAccount = (mint, name, symbol, uri) => ({ owner: METAPLEX, data: b64(concat([Uint8Array.of(4), new Uint8Array(32), base58Decode(mint), s32(name), s32(symbol), s32(uri), Uint8Array.of(0, 0, 0, 0, 0)])) });

/** The launchpad's RPC: accounts by address, getProgramAccounts with filters, a simulation; every call logged. */
function fakeChain(accounts = {}) {
  const S = { accounts: { ...accounts }, log: [], down: false };
  const acc = (k, slice) => {
    const a = S.accounts[k];
    if (!a) return null;
    let data = Buffer.from(a.data, "base64");
    const space = data.length; // the whole account, whatever the slice (as the real RPC answers)
    if (slice) data = data.subarray(slice.offset, slice.offset + slice.length);
    return { owner: a.owner, lamports: a.lamports ?? 2_000_000, data: [data.toString("base64"), "base64"], executable: Boolean(a.executable), rentEpoch: 0, space };
  };
  const one = ({ method, params }) => {
    if (S.down && method !== "getGenesisHash") throw new Error("down");
    switch (method) {
      case "getGenesisHash": return GENESIS.devnet;
      case "getLatestBlockhash": return { context: { slot: 1 }, value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000 } };
      case "getAccountInfo": return { context: { slot: 1 }, value: acc(params[0], params[1] && params[1].dataSlice) };
      case "getMultipleAccounts": return { context: { slot: 1 }, value: params[0].map((k) => acc(k, params[1] && params[1].dataSlice)) };
      case "getProgramAccounts": {
        const [program, cfg] = params;
        return Object.entries(S.accounts).filter(([, a]) => a.owner === program).filter(([, a]) => {
          const d = Buffer.from(a.data, "base64");
          return (cfg.filters || []).every((f) => (f.dataSize != null ? d.length === f.dataSize : Buffer.from(base58Decode(f.memcmp.bytes)).equals(d.subarray(f.memcmp.offset, f.memcmp.offset + 32))));
        }).map(([k]) => ({ pubkey: k, account: acc(k) }));
      }
      case "getSignaturesForAddress": return [];
      case "simulateTransaction": return { context: { slot: 1 }, value: { err: null, logs: ["Program log: ok"], unitsConsumed: 30_000, accounts: (params[1].accounts ? params[1].accounts.addresses : []).map(() => ({ lamports: 1_995_000, owner: PROGRAM_IDS.system, data: ["", "base64"] })) } };
      default: throw new Error("unexpected " + method);
    }
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    S.log.push({ method: body.method, params: body.params });
    try { return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: one(body) })); }
    catch (e) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: String(e.message) } })); }
  };
  return { S, fetchImpl, count: (m, at) => S.log.filter((l) => l.method === m && (at === undefined || l.params[0] === at)).length };
}

const LP_ON = { LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_PROGRAM_ID: PROGRAM, LAUNCHPAD_REWARDS_PROGRAM_ID: REWARDS, LAUNCHPAD_RPC_URL: "https://lp-rpc.test/devnet", LAUNCHPAD_DBC_CONFIGS: CONFIG };
const SYRACUSE = "5140405";
// what the City coins card sends with "Approve on chain" (public/admin-lp.js): with the ready-made coin, the exact version it showed too
const seenOf = (c) => ({ cityId: c.cityId, name: c.name, symbol: c.symbol, founder: c.founder, designAt: c.designAt, ...(c.ready ? { contentHash: c.ready.contentHash } : {}) });

before(async () => { const r = await nodeRenderer(); _setArtRenderer(r); });
after(() => { _setArtRenderer(null); realClock(); });
beforeEach(() => { _resetLpKit(); _resetLpAdmin(); _resetLpCoins(); realClock(); });

/** The owner with a started launchpad and the SOL curve allowed; Utica's active founder holding the bar; the list with region names. */
async function world({ ready = "on" } = {}) {
  useClock("2026-10-20T12:00:00Z");
  const env = { ...newWorld({ VICINITY_MINT: MINT, ...(ready ? { COIN_V2_READY: ready } : {}) }), ...LP_ON };
  _resetCityCache(); _resetTickers();
  const files = { "/data/cities.json": JSON.stringify({ ...CITIES, admin: { "US.NY": "New York" } }), "/data/bounds/US.txt": BOUNDS,
    "/data/tickers.json": JSON.stringify({ 5128581: "NYC", 5140405: "SYRACUSE", 5106834: "ALBANY", 5142056: "UTICA" }) };
  env.ASSETS = { fetch: async (r) => { const f = files[new URL(r.url).pathname]; return f ? new Response(f) : new Response("", { status: 404 }); } };
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  const L = launchpadPdas(PROGRAM);
  const [pdLp, pdRw] = await Promise.all([programDataAddress(PROGRAM), programDataAddress(REWARDS)]);
  const lp = fakeChain({
    [PROGRAM]: programAccount(pdLp), [REWARDS]: programAccount(pdRw), [pdLp]: programDataAccount(owner.w.address), [pdRw]: programDataAccount(owner.w.address),
    [await L.launchpad()]: { owner: PROGRAM, data: b64(layoutAccount("Launchpad", { admin: owner.w.address, rewards_program: REWARDS })) },
    [await L.launchConfig(CONFIG)]: { owner: PROGRAM, data: b64(layoutAccount("LaunchConfig", { dbc_config: CONFIG, quote_mint: WSOL, enabled: 1 })) },
    [CONFIG]: { owner: PROGRAM_IDS.dbc, data: LIVE_CONFIG.data },
  });
  await meteoraAsTested(lp.S.accounts);
  const main = chain();
  const both = (url, init) => (String(url).startsWith("https://lp-rpc.test") ? lp.fetchImpl(url, init) : main(url, init));
  const f = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  const u = await env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)").bind(UTICA, u.id, u.wallet, at, at).run();
  const post = async (who, path, body) => { const r = await who.send(path, { method: "POST", body, fetchImpl: both }); return { status: r.status, ...(await r.json()) }; };
  const get = async (who, path) => (await who.send(path, { fetchImpl: both })).json();
  const card = async () => (await get(owner, "/api/admin/lp/candidates?cluster=devnet")).candidates.find((c) => c.cityId === UTICA);
  /** The founder takes the ready-made coin: the picture, then "Use this coin" with the version shown. */
  const useCoin = async () => {
    const a = await post(f, "/api/coins/ready/art", { cityId: UTICA });
    assert.equal(a.ok, true, JSON.stringify(a));
    const r = await post(f, "/api/coins/ready/use", { cityId: UTICA, contentHash: a.coin.contentHash });
    assert.equal(r.ok, true, JSON.stringify(r));
    return a.coin;
  };
  return { env, owner, f, lp, both, post, get, card, L, useCoin };
}
const meta = (env, path, method = "GET") => handleCoinMeta(new Request(`https://vicinity.city${path}`, { method, headers: { "cf-connecting-ip": "198.51.100.8" } }), env, chain());

test("the owner approves the founder's chosen ready-made coin as today: defaults on the card, its version and picture; the approval binds them", async () => {
  const w = await world();
  assert.equal(await w.card(), undefined, "no design row yet: nothing to approve");
  const coin = await w.useCoin();
  const c = await w.card();
  assert.deepEqual([c.ok, c.name, c.symbol, c.pair, c.pitch, c.logo, c.founder], [true, "Utica", "UTICA", "SOL", "The city coin of Utica, New York, United States.", false, w.f.w.address], JSON.stringify(c.reasons));
  assert.deepEqual(c.ready, { version: coin.version, contentHash: coin.contentHash, template: "t1", art: coin.art });
  // the approval stands for that exact version: none sent (a page from before), or another one, builds nothing
  for (const contentHash of [undefined, "f".repeat(64)]) {
    const x = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c), contentHash, expiryDays: 7 });
    assert.deepEqual([x.status, x.error], [409, "design_changed"], String(contentHash));
  }
  assert.equal(await w.env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`lp_design_hold:${UTICA}`).first(), null, "nothing held either");
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c), expiryDays: 7 });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual(b.summary.find((x) => x.ix === "approve_launch").fields, { cityId: UTICA, founder: w.f.w.address, name: "Utica", symbol: "UTICA", expiresAt: "2026-10-27T12:00:00.000Z" });
  // from the build on, the choice is frozen too (the hold, then the Approval on chain)
  const again = await w.post(w.f, "/api/coins/ready/use", { cityId: UTICA, contentHash: coin.contentHash });
  assert.deepEqual([again.status, again.error], [409, "held"]);
});

test("switch on: a studio design the founder never replaced, or a ticker another city launched or holds an approval for, is not approved", async () => {
  const w = await world();
  // an earlier studio design (made before the switch): kept, but not approvable while the switch is on
  await w.env.DB.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, updated_at, created_at) SELECT ?, 'Utica', 'US', id, user_id, 'Utica Coin', 'The Handshake City.', 'SOL', 'gold', ?, ? FROM seats WHERE city_id = ?")
    .bind(UTICA, "2026-10-19T00:00:00.000Z", "2026-10-19T00:00:00.000Z", UTICA).run();
  let c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), /has not chosen the Vicinity coin yet/);
  assert.equal(c.ready, null);
  assert.equal((await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c) })).error, "blocked");
  await w.useCoin();
  assert.equal((await w.card()).ok, true);
  // (a Raydium LaunchLab contract still waiting for the city: stage 0's rule, whatever the switch says. The candidates skip such a city
  // (fix/close-launchlab-path, test/lpadmin.test.js) and nothing launches while it waits (test/legacy-contract.test.js))
  // another city launched with UTICA (a moved ticker): never approved twice
  await ensureLpCoinsSchema(w.env.DB);
  await w.env.DB.prepare(`INSERT INTO lp_coins (cluster, program_id, city_id, mint, coin, founder, name, symbol, quote_mint, dbc_config, dbc_pool, recorded_at)
    VALUES ('devnet', ?, ?, ?, 'c', 'f', 'Syracuse', 'UTICA', 'q', 'd', 'p', 'now')`).bind(PROGRAM, SYRACUSE, fresh()).run();
  c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), new RegExp(`The ticker UTICA is already launched or approved for another city \\(${SYRACUSE}\\)`));
  await w.env.DB.prepare("DELETE FROM lp_coins").run();
  assert.equal((await w.card()).ok, true);
  // another city's approval on chain names UTICA
  const other = await person(w.env);
  const ou = await w.env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(other.w.address).first();
  await w.env.DB.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, updated_at, created_at) VALUES (?, 'Syracuse', 'US', 99, ?, 'Syracuse', NULL, 'SOL', 'gold', 'x', 'x')").bind(SYRACUSE, ou.id).run();
  w.lp.S.accounts[await w.L.approval(BigInt(SYRACUSE))] = approvalAccount({ cityId: SYRACUSE, founder: other.w.address, rentPayer: w.owner.w.address, name: "Syracuse", symbol: "UTICA", expiresAt: Math.floor(Date.now() / 1000) + 86_400 });
  c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), /already launched or approved for another city/);
  // the city list changed under the choice (another ticker now): the founder must use the coin again
  delete w.lp.S.accounts[await w.L.approval(BigInt(SYRACUSE))];
  await w.env.DB.prepare("UPDATE coin_ready SET symbol = 'UTICAOLD' WHERE city_id = ?").bind(UTICA).run();
  await w.env.DB.prepare("UPDATE coin_versions SET symbol = 'UTICAOLD'").run();
  assert.match((await w.card()).reasons.join(" "), /no longer matches the city list/);
});

test("switch off: the candidate list is exactly as before (a studio design is approvable, no ready key)", async () => {
  const w = await world({ ready: null });
  await w.env.DB.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, updated_at, created_at) SELECT ?, 'Utica', 'US', id, user_id, 'Utica Coin', 'The Handshake City.', 'SOL', 'gold', ?, ? FROM seats WHERE city_id = ?")
    .bind(UTICA, "2026-10-19T00:00:00.000Z", "2026-10-19T00:00:00.000Z", UTICA).run();
  const c = await w.card();
  assert.deepEqual([c.ok, c.reasons, "ready" in c], [true, [], false]);
});

test("the launch record publishes the template picture and the server-built JSON from the version, bound to the coin for good", async () => {
  const w = await world();
  const coin = await w.useCoin();
  const sha = coin.art.slice(15, 79);
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(await w.card()) });
  assert.equal(b.ok, true, JSON.stringify(b));
  // the approval lands, then the founder launches with it (the program copies the approved name and symbol into the coin's metadata)
  const mint = fresh();
  w.lp.S.accounts[await w.L.coin(BigInt(UTICA))] = { owner: PROGRAM, data: b64(layoutAccount("Coin", { city_id: UTICA, founder: w.f.w.address, mint, quote_mint: WSOL, dbc_config: CONFIG, dbc_pool: fresh() })) };
  w.lp.S.accounts[await metadataAddress(mint)] = metadataAccount(mint, "Utica", "UTICA", `https://vicinity.city/coin-meta/${mint}.json`);
  advance(10 * 60_000);
  const rec = await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const lc = await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first();
  const j = JSON.parse(lc.meta_json);
  assert.deepEqual([j.name, j.symbol, j.image, j.description], ["Utica", "UTICA", `https://vicinity.city/coin-meta/art/${sha}.png`,
    "The city coin of Utica, New York, United States. Launched on Vicinity (https://vicinity.city) on Solana."]);
  assert.deepEqual(j.city, { id: 5142056, name: "Utica", country: "US", region: "New York", countryName: "United States", ticker: "UTICA" });
  const bound = await w.env.DB.prepare("SELECT mint, bound_at, approved_hash FROM coin_ready WHERE city_id = ?").bind(UTICA).first();
  assert.equal(bound.mint, mint, "the version is the coin's for good");
  assert.equal(bound.approved_hash, coin.contentHash, "the approval was built from it");
  // wallets that guess /coin-meta/<mint>.png are sent to the permanent picture
  const png = await meta(w.env, `/coin-meta/${mint}.png`);
  assert.deepEqual([png.status, png.headers.get("location")], [302, `/coin-meta/art/${sha}.png`]);
  // whatever changes on the design row afterwards (a moderator's text takedown rebuilds the JSON), the JSON keeps its picture
  const t = await w.post(w.owner, "/api/coins/takedown", { city: UTICA, what: "text", reason: "abuse", note: "testing the rebuild" });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(JSON.parse((await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json).image, `https://vicinity.city/coin-meta/art/${sha}.png`);
  // every switch off (the ready coin and the launchpad's settings): the picture and the JSON keep being served
  const dark = { ...w.env };
  for (const k of ["COIN_V2_READY", ...Object.keys(LP_ON)]) delete dark[k];
  const pic = await meta(dark, `/coin-meta/art/${sha}.png`);
  assert.equal(pic.status, 200);
  assert.equal(await sha256Hex(new Uint8Array(await pic.arrayBuffer())), sha);
  const js = await meta(dark, `/coin-meta/${mint}.json`);
  assert.equal(js.status, 200);
  assert.equal((await js.json()).image, `https://vicinity.city/coin-meta/art/${sha}.png`);
  assert.equal((await meta(dark, `/coin-meta/${mint}.png`)).headers.get("location"), `/coin-meta/art/${sha}.png`);
});

test("a coin launched with another name than the chosen version (or none chosen) gets the old JSON: a version is never published unmatched", async () => {
  const w = await world();
  await w.useCoin();
  const mint = fresh();
  w.lp.S.accounts[await w.L.coin(BigInt(UTICA))] = { owner: PROGRAM, data: b64(layoutAccount("Coin", { city_id: UTICA, founder: w.f.w.address, mint, quote_mint: WSOL, dbc_config: CONFIG, dbc_pool: fresh() })) };
  w.lp.S.accounts[await metadataAddress(mint)] = metadataAccount(mint, "Utica Coin", "UTICA", `https://vicinity.city/coin-meta/${mint}.json`);
  const rec = await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const j = JSON.parse((await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json);
  assert.equal(j.image, `https://vicinity.city/coin-meta/${mint}.png`, "the legacy picture URL");
  assert.equal((await w.env.DB.prepare("SELECT mint FROM coin_ready WHERE city_id = ?").bind(UTICA).first()).mint, null, "not bound");
});

/** The founder's coin approved and launched on the fake chain (the program copies the approved name and symbol into the metadata). */
async function launchOnChain(w, { name = "Utica", symbol = "UTICA" } = {}) {
  const mint = fresh();
  w.lp.S.accounts[await w.L.coin(BigInt(UTICA))] = { owner: PROGRAM, data: b64(layoutAccount("Coin", { city_id: UTICA, founder: w.f.w.address, mint, quote_mint: WSOL, dbc_config: CONFIG, dbc_pool: fresh() })) };
  w.lp.S.accounts[await metadataAddress(mint)] = metadataAccount(mint, name, symbol, `https://vicinity.city/coin-meta/${mint}.json`);
  return mint;
}

test("switch off at record time: a choice made while it was on is NOT published (the legacy JSON and badge), and stays unbound", async () => {
  const w = await world();
  const coin = await w.useCoin();
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(await w.card()) });
  assert.equal(b.ok, true, JSON.stringify(b));
  w.env.COIN_V2_READY = "off"; // rolled back (the owner turned the template's look down)
  const mint = await launchOnChain(w);
  advance(10 * 60_000);
  assert.equal((await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA })).ok, true);
  const j = JSON.parse((await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json);
  assert.equal(j.image, `https://vicinity.city/coin-meta/${mint}.png`, "the legacy picture URL, not the template");
  assert.equal((await w.env.DB.prepare("SELECT mint FROM coin_ready WHERE city_id = ?").bind(UTICA).first()).mint, null);
  assert.equal((await meta(w.env, `/coin-meta/${mint}.png`)).headers.get("location"), "/brand/vicinity-512.png");
  // the picture itself is still served (it was stored), whatever the switch says
  assert.equal((await meta(w.env, coin.art)).status, 200);
});

test("an approval built with the switch off binds no ready-made version, even if the switch is on again when the launch is recorded", async () => {
  const w = await world();
  await w.useCoin();
  w.env.COIN_V2_READY = "off";
  const c = await w.card(); // the legacy card: no ready key, the badge line
  assert.equal("ready" in c, false);
  const b = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c) });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal((await w.env.DB.prepare("SELECT approved_hash FROM coin_ready WHERE city_id = ?").bind(UTICA).first()).approved_hash, null);
  w.env.COIN_V2_READY = "on";
  const mint = await launchOnChain(w);
  advance(10 * 60_000);
  assert.equal((await w.post(browser(w.env), "/api/lp/record", { cityId: UTICA })).ok, true);
  const j = JSON.parse((await w.env.DB.prepare("SELECT meta_json FROM lp_coins WHERE mint = ?").bind(mint).first()).meta_json);
  assert.equal(j.image, `https://vicinity.city/coin-meta/${mint}.png`, "never a picture the owner did not see at approval");
  assert.equal((await w.env.DB.prepare("SELECT mint FROM coin_ready WHERE city_id = ?").bind(UTICA).first()).mint, null);
});

test("approving writes the hold first, then reads the design again: a choice that lands meanwhile is never built from", async () => {
  const w = await world();
  await w.useCoin();
  const c = await w.card();
  // a "Use this coin" lands at the last moment before the owner's hold is written (after his request read the candidates): here the
  // design row changes right before that write. Built first and held after (as before), the approval would name a version nobody showed
  const db = w.env.DB;
  let landed = false;
  w.env.DB = new Proxy(db, { get: (t, k) => (k === "prepare" ? (sql) => {
    const st = t.prepare(sql);
    if (!/^INSERT INTO settings \(key, value\)/.test(sql)) return st;
    return { bind: (...a) => { const b = st.bind(...a); return { ...b, first: (...x) => b.first(...x), all: (...x) => b.all(...x), run: async () => {
      if (!landed && String(a[0]) === `lp_design_hold:${UTICA}`) { landed = true; await db.prepare("UPDATE city_coins SET updated_at = ? WHERE city_id = ?").bind("2026-10-20T12:00:00.900Z", UTICA).run(); }
      return b.run();
    } }; } };
  } : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  const r = await w.post(w.owner, "/api/admin/lp/approve/tx", { cluster: "devnet", ...seenOf(c) });
  w.env.DB = db;
  assert.equal(landed, true, "the change landed inside the request");
  assert.deepEqual([r.status, r.error], [409, "design_changed"], JSON.stringify(r).slice(0, 300));
  assert.equal(w.lp.S.log.filter((l) => l.method === "simulateTransaction").length, 0, "nothing built");
  assert.equal((await db.prepare("SELECT approved_hash FROM coin_ready WHERE city_id = ?").bind(UTICA).first()).approved_hash, null, "no version marked approved");
});

test("a launched coin whose symbol the site never read blocks approvals until it is known", async () => {
  const w = await world();
  await w.useCoin();
  await ensureLpCoinsSchema(w.env.DB);
  const other = fresh();
  await w.env.DB.prepare(`INSERT INTO lp_coins (cluster, program_id, city_id, mint, coin, founder, name, symbol, quote_mint, dbc_config, dbc_pool, recorded_at)
    VALUES ('devnet', ?, ?, ?, 'c', 'f', NULL, NULL, 'q', 'd', 'p', 'now')`).bind(PROGRAM, SYRACUSE, other).run();
  let c = await w.card();
  assert.equal(c.ok, false);
  assert.match(c.reasons.join(" "), new RegExp(`A coin launched for another city \\(${SYRACUSE}\\) has a ticker this site could not read`));
  // the chain has it (SYRACUSE): stored, and the card is free again
  w.lp.S.accounts[await metadataAddress(other)] = metadataAccount(other, "Syracuse", "SYRACUSE", `https://vicinity.city/coin-meta/${other}.json`);
  c = await w.card();
  assert.equal(c.ok, true, JSON.stringify(c.reasons));
  assert.equal((await w.env.DB.prepare("SELECT symbol FROM lp_coins WHERE mint = ?").bind(other).first()).symbol, "SYRACUSE");
});
