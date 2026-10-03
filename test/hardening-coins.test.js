// Launch-week hardening of city coins: recording a contract needs the exact address the admin looked at and a
// blockchain check that it is a token mint with a supply.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { IN_UTICA, MINT, browser, chain, newWorld, person, realClock, useClock } from "./helpers/world.js";

let env;
beforeEach(() => { useClock("2026-10-20T12:00:00Z"); env = newWorld({ VICINITY_MINT: MINT }); });
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
