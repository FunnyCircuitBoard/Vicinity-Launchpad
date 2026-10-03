// City coins: the City Founder designs their city's coin (name, pitch, colour, logo, pair); everyone can see it;
// every change is logged; the contract is recorded by a different person (an admin) and then the design locks.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { IN_UTICA, MINT, browser, newWorld, person, realClock, setHolding, useClock, advance } from "./helpers/world.js";

let env;
beforeEach(() => { useClock("2026-10-20T12:00:00Z"); env = newWorld({ VICINITY_MINT: MINT }); });
after(() => realClock());

// a 1×1 PNG
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c63f8ffff3f0005fe02fea7d6a3f40000000049454e44ae426082", "hex").toString("base64");
const CITY_COIN = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SOL = "So11111111111111111111111111111111111111112";
const design = (over = {}) => ({ name: "Utica Coin", pitch: "The Handshake City, on the map.", pair: "SOL", color: "emerald", ...over });

/** A person who holds and is the active City Founder of Utica (the seat made directly: coins only need an active founder). */
async function founder() {
  const f = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  const u = await env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES ('5142056', 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)")
    .bind(u.id, u.wallet, at, at).run();
  return f;
}

test("the city's founder designs its coin; everyone can see it; every change is in the public log", async () => {
  const local = await person(env, { home: IN_UTICA, holds: 10 });
  assert.equal((await local.post("/api/coins/design", design())).error, "not_founder");

  const f = await founder();
  assert.equal((await f.post("/api/coins/design", design({ pair: "BONK" }))).error, "bad_pair");
  assert.equal((await f.post("/api/coins/design", design({ color: "neon" }))).error, "bad_color");
  assert.equal((await f.post("/api/coins/design", design({ name: "utica.coin" }))).error, "bad_name", "no links in the name");
  assert.equal((await f.post("/api/coins/design", design({ name: "x" }))).error, "bad_name");
  assert.equal((await f.post("/api/coins/design", design({ pitch: `buy ${CITY_COIN}` }))).error, "no_addresses");
  assert.equal((await f.post("/api/coins/design", design({ pitch: "see https://scam.example" }))).error, "no_links");
  assert.equal((await f.post("/api/coins/design", design({ image: Buffer.from("<svg onload=alert(1)>").toString("base64") }))).error, "bad_image");

  const r = await f.post("/api/coins/design", design({ image: PNG }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.coin.name, "Utica Coin");
  assert.equal(r.coin.pair, "SOL");
  assert.equal(r.coin.pairMint, SOL);
  assert.match(r.coin.logo, /^\/api\/media\/\d+$/);

  const pub = await browser(env).get("/api/coins?city=5142056");
  assert.equal(pub.coin.name, "Utica Coin");
  assert.equal(pub.coin.color, "emerald");
  assert.equal(pub.coin.launched, false);
  assert.deepEqual(Object.keys(pub.pairs), ["SOL", "USDC", "RAY"]);
  const logo = await browser(env).send(pub.coin.logo);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.equal((await browser(env).get("/api/coins")).coins.length, 1);

  // change the pair and drop the logo
  const r2 = await f.post("/api/coins/design", design({ pair: "USDC", removeLogo: true }));
  assert.equal(r2.coin.pair, "USDC");
  assert.equal(r2.coin.logo, null);

  const audit = (await browser(env).get("/api/audit?country=US")).actions.filter((a) => a.action === "coin_design");
  assert.equal(audit.length, 2);
  assert.match(audit[0].note, /paired with USDC/);
  assert.match(audit[0].note, /logo removed/);
  assert.equal(audit[0].target, "city_coin");

  // sensitive: the wallet must have been proven in the last 30 minutes
  advance(31 * 60_000);
  assert.equal((await f.post("/api/coins/design", design())).error, "reprove");
});

test("a founder who sold below the amount can't design (grace)", async () => {
  const f = await founder();
  setHolding(f.w.address, 10);
  assert.equal((await f.post("/api/coins/design", design())).error, "in_grace");
});

test("launch: the founder submits the contract, a different person (an admin) records it, then the design is locked", async () => {
  const f = await founder();
  assert.equal((await f.post("/api/coins/mint", { mint: CITY_COIN })).error, "design_first");
  await f.post("/api/coins/design", design());
  assert.equal((await f.post("/api/coins/mint", { mint: MINT })).error, "not_a_city_coin", "not $VICINITY");
  assert.equal((await f.post("/api/coins/mint", { mint: SOL })).error, "not_a_city_coin", "not the pair");
  assert.equal((await f.post("/api/coins/mint", { mint: "nope" })).error, "bad_address");
  const s = await f.post("/api/coins/mint", { mint: CITY_COIN });
  assert.equal(s.ok, true);
  assert.equal(s.coin.waiting, true);
  assert.equal(s.coin.mint, null, "not official until checked");
  assert.ok(!JSON.stringify(await browser(env).get("/api/coins?city=5142056")).includes(CITY_COIN), "a contract waiting for a check is never shown publicly");

  const adm = await person(env);
  assert.equal((await adm.get("/api/coins?waiting=1")).error, "not_allowed");
  env.ADMIN_WALLETS = `${adm.w.address},${f.w.address}`;
  const waiting = await adm.get("/api/coins?waiting=1");
  assert.equal(waiting.waiting[0].pendingMint, CITY_COIN);
  assert.equal((await adm.post("/api/coins/mint/decide", { city: "5142056", approve: false })).error, "reason_required");
  assert.equal((await f.post("/api/coins/mint/decide", { city: "5142056", approve: true })).error, "needs_second_person", "a founder who is also an admin can't approve their own coin");

  const ok = await adm.post("/api/coins/mint/decide", { city: "5142056", mint: CITY_COIN, approve: true, note: "Checked on Raydium LaunchLab" });
  assert.equal(ok.coin.launched, true);
  assert.equal(ok.coin.mint, CITY_COIN);
  assert.equal((await browser(env).get("/api/coins?city=5142056")).coin.mint, CITY_COIN);

  assert.equal((await f.post("/api/coins/design", design({ name: "Other" }))).error, "coin_locked");
  assert.equal((await adm.post("/api/coins/takedown", { city: "5142056", what: "text", reason: "abuse", note: "rude name" })).error, "coin_locked");
  assert.equal((await adm.post("/api/coins/takedown", { city: "5142056", what: "logo", reason: "abuse" })).error, "reason_required");
  const t = await adm.post("/api/coins/takedown", { city: "5142056", what: "logo", reason: "abuse", note: "Offensive picture" });
  assert.equal(t.ok, true);
  const log = (await browser(env).get("/api/audit?country=US")).actions.map((a) => a.action);
  for (const a of ["coin_design", "coin_contract_submitted", "coin_launch_confirmed", "coin_logo_removed"]) assert.ok(log.includes(a), a);
});

test("prices: only for $VICINITY, the pairs and launched city coins (never an open proxy)", async () => {
  const b = browser(env);
  const asked = [];
  const jup = async (url) => { asked.push(String(url)); return new Response(JSON.stringify({ [SOL]: { usdPrice: 150 }, [MINT]: { usdPrice: 0.002 } })); };
  const r = await (await b.send(`/api/prices?mints=${SOL},${MINT},${CITY_COIN}`, { fetchImpl: jup })).json();
  assert.deepEqual(r.prices, { [SOL]: 150, [MINT]: 0.002 });
  assert.equal(asked.length, 1);
  assert.ok(!asked[0].includes(CITY_COIN), "an unknown token is never looked up");
});
