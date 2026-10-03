// Launch-week hardening of city coins: recording a contract needs the exact address the admin looked at and a
// blockchain check that it is a token mint with a supply.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IN_UTICA, MINT, advance, browser, chain, newWorld, person, realClock, useClock } from "./helpers/world.js";
import { _resetPrices } from "../src/coins.js";

let env;
beforeEach(() => { useClock("2026-10-20T12:00:00Z"); env = newWorld({ VICINITY_MINT: MINT }); _resetPrices(); });
after(() => realClock());

const UTICA = "5142056";
const COIN_A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const COIN_B = "9yQNxyWbF1sYxXb7nq3zJ4sz2tnLoqa4v8bbWbAdwLBS";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const design = { name: "Utica Coin", pitch: "The Handshake City, on the map.", pair: "SOL", color: "emerald" };

/** A person who holds and is the active City Founder of Utica (the seat made directly: coins only need an active founder). */
async function founder() {
  const f = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  const u = await env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)")
    .bind(UTICA, u.id, u.wallet, at, at).run();
  return f;
}
/** A founder with a designed coin whose contract is waiting, and an admin who is not that founder. */
async function waiting(mint = COIN_A) {
  const f = await founder();
  assert.equal((await f.post("/api/coins/design", design)).ok, true);
  assert.equal((await f.post("/api/coins/mint", { mint })).coin.waiting, true);
  const adm = await person(env);
  env.ADMIN_WALLETS = adm.w.address;
  return { f, adm };
}
/** The test chain, except that getAccountInfo for one address answers as told (a value, or a whole Response). */
function chainWhere(address, answer) {
  const base = chain();
  return async (url, init) => {
    const body = JSON.parse(init.body);
    if (!Array.isArray(body) && body.method === "getAccountInfo" && body.params[0] === address) {
      return answer instanceof Response ? answer.clone() : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: answer } }));
    }
    return base(url, init);
  };
}
const decide = async (adm, body, fetchImpl) => (await adm.send("/api/coins/mint/decide", { method: "POST", body, fetchImpl })).json();
const coinNow = () => browser(env).get(`/api/coins?city=${UTICA}`).then((r) => r.coin);
const recorded = async () => (await browser(env).get("/api/audit?country=US")).actions.filter((a) => a.action === "coin_launch_confirmed");

test("recording needs the exact address the admin looked at: a missing or different one is refused and nothing changes", async () => {
  const { adm } = await waiting();
  assert.equal((await decide(adm, { city: UTICA, approve: true, note: "Checked on the blockchain" })).error, "mint_required", "the old page sends no address: a clear error, not a record");
  assert.equal((await decide(adm, { city: UTICA, approve: true, mint: COIN_B, note: "Checked" })).error, "mint_changed");
  const c = await coinNow();
  assert.deepEqual([c.waiting, c.mint, c.launched], [true, null, false]);
  assert.equal((await recorded()).length, 0);
});

test("a founder who swaps the contract after the admin opened it cannot get the new one recorded under the old check", async () => {
  const { f, adm } = await waiting(COIN_A);
  // the admin opens COIN_A on an explorer; meanwhile the founder re-submits another address
  assert.equal((await f.post("/api/coins/mint", { mint: COIN_B })).coin.waiting, true);
  const r = await decide(adm, { city: UTICA, approve: true, mint: COIN_A, note: "Checked on the blockchain" });
  assert.equal(r.error, "mint_changed");
  const c = await coinNow();
  assert.deepEqual([c.waiting, c.mint], [true, null], "still waiting, nothing recorded");
  assert.equal((await recorded()).length, 0);
});

test("the address must be a token mint with a supply on the blockchain, else it is not recorded", async () => {
  const { adm } = await waiting(COIN_A);
  const body = { city: UTICA, approve: true, mint: COIN_A, note: "Checked" };
  for (const [what, value] of [
    ["no account", null],
    ["a wallet", { owner: "11111111111111111111111111111111", data: ["", "base64"] }],
    ["a token account", { owner: TOKEN, data: { parsed: { type: "account", info: { mint: COIN_B, owner: adm.w.address, tokenAmount: { uiAmount: 1 } } } } }],
    ["an empty mint", { owner: TOKEN, data: { parsed: { type: "mint", info: { decimals: 6, supply: "0", mintAuthority: adm.w.address, freezeAuthority: null } } } }],
  ]) {
    const r = await decide(adm, body, chainWhere(COIN_A, value));
    assert.deepEqual([r.error, (await coinNow()).mint], ["not_a_mint", null], what);
  }
  const down = await decide(adm, body, chainWhere(COIN_A, new Response("", { status: 503 })));
  assert.equal(down.error, "chain_unavailable", "an RPC failure is not 'not a mint' and records nothing");
  assert.equal((await coinNow()).waiting, true);
  assert.equal((await recorded()).length, 0);
});

test("a real mint is recorded, and what the chain said about it goes into the public log", async () => {
  const { f, adm } = await waiting(COIN_A);
  const real = { owner: TOKEN_2022, data: { parsed: { type: "mint", info: { decimals: 9, supply: "123000000000", mintAuthority: null, freezeAuthority: null } } } };
  const r = await decide(adm, { city: UTICA, approve: true, mint: COIN_A, note: "Checked on the blockchain" }, chainWhere(COIN_A, real));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.coin.launched, r.coin.mint, r.coin.waiting], [true, COIN_A, false]);
  const [log] = await recorded();
  assert.match(log.note, /Checked on the blockchain/);
  assert.match(log.note, /Token-2022/);
  assert.match(log.note, /supply 123\b/);
  assert.match(log.note, /9 decimals/);
  assert.match(log.note, /mint authority none/);
  assert.match(log.note, /freeze authority none/);
  // recorded once: a second try finds nothing waiting
  assert.equal((await decide(adm, { city: UTICA, approve: true, mint: COIN_A, note: "again" })).error, "not_found");
  assert.equal((await f.post("/api/coins/design", { ...design, name: "Other" })).error, "coin_locked");
});

test("rejecting still works as today without an address (the old page), and with one it must be the address that is waiting", async () => {
  const { f, adm } = await waiting(COIN_A);
  assert.equal((await decide(adm, { city: UTICA, approve: false, mint: COIN_B, note: "not on LaunchLab" })).error, "mint_changed");
  assert.equal((await coinNow()).waiting, true);
  assert.equal((await decide(adm, { city: UTICA, approve: false, note: "not on LaunchLab" })).ok, true);
  assert.equal((await coinNow()).waiting, false);
  assert.equal((await f.post("/api/coins/mint", { mint: COIN_A })).coin.waiting, true);
  assert.equal((await decide(adm, { city: UTICA, approve: false, mint: COIN_A, note: "not on LaunchLab" })).ok, true);
  assert.equal((await coinNow()).waiting, false);
});

test("the link checker knows recorded city coins: the real $UTICA is official for Utica, a contract still being checked is not", async () => {
  const check = async (q) => browser(env).get("/api/check?q=" + encodeURIComponent(q));
  const { adm } = await waiting(COIN_A);
  let r = await check(COIN_A);
  assert.deepEqual([r.verdict, r.kind], ["not_official", "address"], "waiting for the admin's check: not official yet");

  assert.equal((await decide(adm, { city: UTICA, approve: true, mint: COIN_A, note: "Checked" })).ok, true);
  r = await check(COIN_A);
  assert.equal(r.verdict, "official");
  assert.equal(r.kind, "city_coin");
  assert.deepEqual([r.city, r.cityName, r.country, r.ticker], [UTICA, "Utica", "US", "UTICA"]);
  assert.match(r.message, /official \$UTICA/);
  assert.match(r.message, /Utica/);

  r = await check(COIN_B);
  assert.deepEqual([r.verdict, r.kind], ["not_official", "address"], "any other address is still not official");
  r = await check(MINT);
  assert.deepEqual([r.verdict, r.kind], ["official", "contract"], "$VICINITY itself is unchanged");
  r = await check(` ${COIN_A} `);
  assert.equal(r.kind, "city_coin", "spaces around the address are fine, like everywhere else in the checker");
});

test("the link checker calls the token page's own Buy, Jupiter, DEX Screener and Solscan links official, and the same sites with another token not", async () => {
  // measured live 3 Oct 2026: every one of these answered not_official "This link is not on our official list.", including
  // the exact href of the token page's "Buy on Raydium" button, which the same page tells visitors to check first
  const check = async (q) => browser(env).get("/api/check?q=" + encodeURIComponent(q));
  const OLD_TEST_COIN = "2e8VdgpT27LcNWyfk5Ce6ZyGwMdu7ajaSnMph83Xwray";
  const tokenJs = readFileSync(new URL("../public/token.js", import.meta.url), "utf8");
  const hrefs = [...tokenJs.matchAll(/\.href = `(https:\/\/[^`]+\$\{m\})`/g)].map((m) => m[1].replace("${m}", MINT));
  assert.equal(hrefs.length, 4, "the four links the token page builds");
  for (const link of [...hrefs, `https://jup.ag/swap/SOL-${MINT}`, `https://www.raydium.io/launchpad/token/?mint=${MINT}`, `raydium.io/swap/?inputMint=sol&outputMint=${MINT}`]) {
    const r = await check(link);
    assert.deepEqual([r.verdict, r.kind], ["official", "market"], link);
    assert.ok(r.message.includes(MINT), "the answer names the contract");
  }
  assert.match((await check(`https://raydium.io/launchpad/token/?mint=${MINT}`)).message, /official \$VICINITY on Raydium/);

  for (const link of [`https://raydium.io/launchpad/token/?mint=${OLD_TEST_COIN}`, `https://jup.ag/swap/SOL-${COIN_B}`, `https://dexscreener.com/solana/${COIN_B}`,
    `https://solscan.io/token/${OLD_TEST_COIN}`, `https://raydium.io/launchpad/token/?mint=${COIN_B}&ref=${MINT}`]) {
    const r = await check(link);
    assert.deepEqual([r.verdict, r.kind], ["not_official", "market"], link);
    assert.match(r.message, /different token, NOT the official \$VICINITY/);
  }
  for (const bare of ["raydium.io", "https://raydium.io/", "https://jup.ag"]) {
    const r = await check(bare);
    assert.deepEqual([r.verdict, r.kind], ["warning", "market"], bare);
    assert.match(r.message, /real (Raydium|Jupiter)/);
    assert.ok(r.message.includes(MINT));
  }
  // look-alike hosts are not the real sites, whatever they carry
  for (const fake of [`https://raydium.io.evil.io/launchpad/token/?mint=${MINT}`, `https://raydium-io.com/launchpad/token/?mint=${MINT}`, `https://jup.ag.example/tokens/${MINT}`])
    assert.equal((await check(fake)).verdict, "not_official", fake);

  // a recorded city coin's link opens that official coin
  const { adm } = await waiting(COIN_A);
  assert.equal((await check(`https://raydium.io/launchpad/token/?mint=${COIN_A}`)).verdict, "not_official", "still waiting for the admin's check");
  assert.equal((await decide(adm, { city: UTICA, approve: true, mint: COIN_A, note: "Checked" })).ok, true);
  const city = await check(`https://raydium.io/launchpad/token/?mint=${COIN_A}`);
  assert.deepEqual([city.verdict, city.kind, city.ticker], ["official", "market", "UTICA"]);
  assert.match(city.message, /^This Raydium link opens the official \$UTICA/);

  // before a launch nothing changes: no contract, so no trade link can be official
  const pre = await browser(newWorld({})).get("/api/check?q=" + encodeURIComponent(`https://raydium.io/launchpad/token/?mint=${MINT}`));
  assert.equal(pre.verdict, "not_official");
});

test("the link checker names the one official X account instead of claiming there is none", async () => {
  const r = await browser(env).get("/api/check?q=" + encodeURIComponent("@vicinity_official"));
  assert.equal(r.verdict, "not_official");
  assert.match(r.message, /@VicinityCitySOL/);
  assert.doesNotMatch(r.message, /no official social accounts/);
  const ok = await browser(env).get("/api/check?q=" + encodeURIComponent("@vicinitycitysol"));
  assert.equal(ok.verdict, "official");
});

// ---- prices (Jupiter) ----
const SOL = "So11111111111111111111111111111111111111112";
const jupiter = (answer) => { const calls = []; const f = async (url, init) => { calls.push({ url: String(url), headers: new Headers(init && init.headers) }); return answer(); }; f.calls = calls; return f; };
const good = () => new Response(JSON.stringify({ [SOL]: { usdPrice: 150 }, [MINT]: { usdPrice: 0.002 } }));
const prices = (fetchImpl, over = {}) => browser({ ...env, ...over }).send(`/api/prices?mints=${SOL},${MINT}`, { fetchImpl });

test("prices come from the Jupiter address in the settings, with the key when there is one", async () => {
  let j = jupiter(good);
  assert.deepEqual((await (await prices(j)).json()).prices, { [SOL]: 150, [MINT]: 0.002 });
  assert.ok(j.calls[0].url.startsWith("https://lite-api.jup.ag/price/v3?ids="), "default address: " + j.calls[0].url);
  assert.equal(j.calls[0].headers.get("x-api-key"), null, "no key, no header");

  j = jupiter(good);
  await prices(j, { JUPITER_API_BASE: "https://api.jup.ag/", JUPITER_API_KEY: "test-key" });
  assert.ok(j.calls[0].url.startsWith("https://api.jup.ag/price/v3?ids="), "address from the setting: " + j.calls[0].url);
  assert.equal(j.calls[0].headers.get("x-api-key"), "test-key");
});

test("when Jupiter fails, the last good prices are answered as stale for 5 minutes, and the route never throws", async () => {
  const r1 = await (await prices(jupiter(good))).json();
  assert.deepEqual(r1, { prices: { [SOL]: 150, [MINT]: 0.002 } }, "a fresh answer carries no stale mark");

  const limited = await prices(jupiter(() => new Response("slow down", { status: 429 })));
  assert.equal(limited.status, 200);
  assert.deepEqual(await limited.json(), { prices: { [SOL]: 150, [MINT]: 0.002 }, stale: true }, "rate-limited: last good prices, marked stale");

  advance(4 * 60_000);
  const broken = await prices(jupiter(() => { throw new Error("network down"); }));
  assert.equal(broken.status, 200);
  assert.deepEqual(await broken.json(), { prices: { [SOL]: 150, [MINT]: 0.002 }, stale: true }, "unreachable: still the last good prices");

  advance(60_001);
  const old = await (await prices(jupiter(() => new Response("", { status: 503 })))).json();
  assert.deepEqual(old, { prices: { [SOL]: null, [MINT]: null } }, "after 5 minutes the old prices are not shown any more");
});

test("the token page's price also survives a Jupiter outage with the last good price", async () => {
  const token = (fetchImpl) => browser(env).send("/api/token", { fetchImpl });
  const both = (j) => async (url, init) => (String(url).includes("jup.ag") ? j(url, init) : chain()(url, init));
  assert.equal((await (await token(both(jupiter(good)))).json()).price, 0.002);
  assert.equal((await (await token(both(jupiter(() => new Response("", { status: 429 }))))).json()).price, 0.002, "last good price");
  _resetPrices();
  assert.equal((await (await token(both(jupiter(() => new Response("", { status: 429 }))))).json()).price, null, "nothing remembered: no price, no error");
});
