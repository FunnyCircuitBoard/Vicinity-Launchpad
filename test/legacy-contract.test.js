// One city, one coin, whatever the switches say: a contract sent for a city through the old Raydium LaunchLab path that still waits for a
// check (city_coins.pending_mint) may already be that city's coin. So the Vicinity launchpad never launches that city while it waits
// (GET /api/lp/launch/status says so before the founder presses, POST /api/lp/launch/tx refuses before anything is built), the owner's
// list of approvals tells him to revoke an approval for such a city (the program itself does not know about the contract), and a launch
// recorded from the chain anyway (an approval that was used on chain directly) names the contract it drops in the public log.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { _resetLpKit } from "../src/lpkit.js";
import { _resetLpCoins } from "../src/lpcoins.js";
import { _resetLpAdmin } from "../src/lpadmin.js";
import { _resetProgramPins } from "../src/programpins.js";
import { metadataAddress } from "../src/sol/metaplex.js";
import { metadataUriFor } from "../src/coinmeta.js";
import { base58Decode } from "../src/solana.js";
import { concat, u32le, u64le } from "../src/sol/bytes.js";
import { launchpad as launchpadPdas } from "../src/sol/pda.js";
import { MINT, browser, chain as mainChain, newWorld, person, realClock, useClock } from "./helpers/world.js";
import { seedCoin } from "./helpers/launchpad.js";
import { DEMOV, DEMOV_CITY, LP_ON, METAPLEX, PROGRAM, SOL_CONFIG, addr, lpChain, metaplexData, meteoraAsTested } from "./helpers/lpchain.js";

const CITY = "5142056"; // Utica (ticker UTICA in the test world)
const TABLE = "5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe";
const ON = { ...LP_ON, LAUNCHPAD_DBC_CONFIGS: SOL_CONFIG, LAUNCHPAD_LOOKUP_TABLE: TABLE, VICINITY_MINT: MINT };
const WAITING = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const b64 = (u8) => Buffer.from(u8).toString("base64");
function approvalAccount({ cityId, founder, rentPayer = addr(5), name = "Utica Coin", symbol = "UTICA", expiresAt }) {
  const enc = new TextEncoder();
  const str = (s) => concat([u32le(enc.encode(s).length), enc.encode(s)]);
  const body = concat([Uint8Array.of(233, 9, 153, 49, 11, 222, 59, 130), u64le(BigInt(cityId)), base58Decode(founder), base58Decode(SOL_CONFIG), base58Decode(rentPayer), str(name), str(symbol), u64le(1), u64le(BigInt(expiresAt)), Uint8Array.of(254)]);
  const out = new Uint8Array(179); out.set(body);
  return { owner: PROGRAM, data: b64(out) };
}

beforeEach(() => { _resetLpKit(); _resetLpCoins(); _resetLpAdmin(); _resetProgramPins(); realClock(); });

/** Utica's active founder (holding the founder amount) with the owner's approval on chain; the launchpad RPC is the fake chain. */
async function world() {
  useClock("2026-10-20T12:00:00Z");
  const env = { ...newWorld(), ...ON };
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  const f = await person(env, { holds: 2_000_000 });
  const u = await env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  const seat = (await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)")
    .bind(CITY, u.id, u.wallet, at, at).run()).meta.last_row_id;
  await seedCoin(env.DB, { city: CITY, name: "Utica", coin: "Utica Coin", user: u.id, seat });
  const lp = lpChain();
  await meteoraAsTested(lp.S.accounts);
  const L = launchpadPdas(PROGRAM);
  lp.S.accounts[await L.approval(BigInt(CITY))] = approvalAccount({ cityId: CITY, founder: f.w.address, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 });
  const main = mainChain();
  const fetchImpl = async (url, init) => (String(url).startsWith(LP_ON.LAUNCHPAD_RPC_URL) ? lp.fetchImpl(url, init) : main(url, init));
  const call = async (who, path, body) => {
    const url = body === undefined ? `${path}${path.includes("?") ? "&" : "?"}cluster=devnet` : path;
    const r = await who.send(url, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : { cluster: "devnet", ...body }, fetchImpl });
    return { status: r.status, data: await r.json() };
  };
  const waiting = () => env.DB.prepare("UPDATE city_coins SET pending_mint = ?, pending_at = ? WHERE city_id = ?").bind(WAITING, at, CITY).run();
  const settled = () => env.DB.prepare("UPDATE city_coins SET pending_mint = NULL, pending_at = NULL WHERE city_id = ?").bind(CITY).run();
  return { env, owner, f, lp, call, waiting, settled };
}

test("a waiting LaunchLab contract: the launch card says nothing can launch, and the launch is refused before anything is built", async () => {
  const w = await world();
  assert.equal((await w.call(w.f, `/api/lp/launch/status?city=${CITY}`)).data.state, "ready", "approved, nothing waiting: ready");
  await w.waiting();
  const st = await w.call(w.f, `/api/lp/launch/status?city=${CITY}`);
  assert.equal(st.status, 200, JSON.stringify(st.data));
  assert.deepEqual([st.data.state, st.data.why], ["paused", "legacy_contract"]);
  assert.equal(st.data.message, "A contract sent for this city through the old Raydium LaunchLab path is still waiting. Nothing can launch until an admin settles it.");
  const from = w.lp.S.log.length;
  const tx = await w.call(w.f, "/api/lp/launch/tx", { cityId: CITY, mint: addr(90) });
  assert.deepEqual([tx.status, tx.data.ok, tx.data.error], [409, false, "legacy_contract"]);
  assert.match(tx.data.message, /still waiting\. Nothing can launch until an admin settles it\. Nothing was built\.$/);
  assert.equal(w.lp.S.log.slice(from).filter((l) => ["simulateTransaction", "getLatestBlockhash", "getProgramAccounts"].includes(l.method)).length, 0, "nothing read for the build, nothing built");
  assert.equal((await w.env.DB.prepare("SELECT pending_mint FROM city_coins WHERE city_id = ?").bind(CITY).first()).pending_mint, WAITING, "the contract is left as it is");
  // settled (an admin rejected it): the launch is built as before
  await w.settled();
  assert.equal((await w.call(w.f, `/api/lp/launch/status?city=${CITY}`)).data.state, "ready");
  const ok = await w.call(w.f, "/api/lp/launch/tx", { cityId: CITY, mint: addr(91) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test("a waiting LaunchLab contract: the owner's list of approvals tells him to revoke that city's approval (it still works on chain)", async () => {
  const w = await world();
  const card = async () => (await w.call(w.owner, "/api/admin/lp/candidates")).data.approvals.find((a) => a.cityId === CITY);
  const before = await card();
  assert.ok(before, "the approval is listed");
  assert.equal(before.warnings.some((x) => /LaunchLab/.test(x)), false);
  await w.waiting();
  const after = await card();
  assert.ok(after.warnings.includes("A Raydium LaunchLab contract sent for this city through the old path is still waiting (the city may have that coin already). This website will not let the founder launch while it waits, but the approval still works on chain until it expires. Revoke it, then settle that contract (Contracts waiting for a check, in the Moderate tab)."), JSON.stringify(after.warnings));
  assert.ok(!JSON.stringify(after).includes(WAITING), "the waiting address itself is not in the answer");
});

test("a launch recorded while a LaunchLab contract still waited names the contract it drops in the public log line", async () => {
  const env = { ...newWorld(), ...LP_ON };
  const lp = lpChain({ accounts: { [await metadataAddress(DEMOV)]: { owner: METAPLEX, data: metaplexData({ mint: DEMOV, name: "Demo Vicinity", symbol: "DEMOV", uri: metadataUriFor(DEMOV) }) } } });
  await seedCoin(env.DB, { city: DEMOV_CITY, name: "Demo City", coin: "Demo Coin", user: 7, seat: 1, pending: WAITING });
  const r = await browser(env).send("/api/lp/record", { method: "POST", body: { cityId: DEMOV_CITY }, fetchImpl: lp.fetchImpl });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const design = await env.DB.prepare("SELECT mint, pending_mint FROM city_coins WHERE city_id = ?").bind(DEMOV_CITY).first();
  assert.deepEqual([design.mint, design.pending_mint], [DEMOV, null]);
  const lines = (await env.DB.prepare("SELECT note FROM mod_actions WHERE action = 'coin_launched'").all()).results;
  assert.equal(lines.length, 1);
  assert.match(lines[0].note, new RegExp(`the coin design is locked\\. A Raydium LaunchLab contract that was still waiting for this city \\(${WAITING}\\) was dropped: one city has one coin\\.$`));
  // a city with nothing waiting: the line is as it always was
  const env2 = { ...newWorld(), ...LP_ON };
  await seedCoin(env2.DB, { city: DEMOV_CITY, name: "Demo City", coin: "Demo Coin", user: 7, seat: 1 });
  assert.equal((await browser(env2).send("/api/lp/record", { method: "POST", body: { cityId: DEMOV_CITY }, fetchImpl: lp.fetchImpl })).status, 200);
  assert.match((await env2.DB.prepare("SELECT note FROM mod_actions WHERE action = 'coin_launched'").first()).note, /the coin design is locked\.$/);
});
