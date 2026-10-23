// One city, one coin, whatever the switches say: a contract sent for a city through the old Raydium LaunchLab path that still waits for a
// check (city_coins.pending_mint) may already be that city's coin. So the Vicinity launchpad never launches that city while it waits
// (GET /api/lp/launch/status says so before the founder presses, first, even before "not approved"; POST /api/lp/launch/tx refuses
// before anything is built, in the same order), the owner's list of approvals tells him to revoke an approval for such a city and
// where to reject the contract (the program itself does not know about the contract), and a launch recorded from the chain anyway (an
// approval that was used on chain directly) says in the public log that a waiting contract was dropped, never which one (nobody checked
// it: it could be a look-alike); the address is kept for the staff in admin_audit.
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
import { LAYOUT } from "../src/sol/layout.js";
import { LEGACY_CONTRACT_WAITING } from "../src/lplaunch.js";
import { MINT, browser, chain as mainChain, newWorld, person, realClock, useClock } from "./helpers/world.js";
import { seedCoin } from "./helpers/launchpad.js";
import { DEMOV, DEMOV_COIN, DEMOV_CITY, LP_ON, METAPLEX, PROGRAM, SOL_CONFIG, addr, lpChain, metaplexData, meteoraAsTested } from "./helpers/lpchain.js";

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
  // what it means first (a line cut short on a phone still says it), the same words the dashboard's founder card uses
  assert.equal(st.data.message, "Nothing can launch until an admin settles the contract sent for this city through the old Raydium LaunchLab path.");
  assert.equal(st.data.message, LEGACY_CONTRACT_WAITING);
  const from = w.lp.S.log.length;
  const tx = await w.call(w.f, "/api/lp/launch/tx", { cityId: CITY, mint: addr(90) });
  assert.deepEqual([tx.status, tx.data.ok, tx.data.error], [409, false, "legacy_contract"]);
  assert.match(tx.data.message, /^Nothing can launch until an admin settles the contract sent for this city through the old Raydium LaunchLab path\. Nothing was built\.$/);
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
  assert.ok(after.warnings.includes("A Raydium LaunchLab contract sent for this city through the old path is still waiting (the city may have that coin already). This website will not let the founder launch while it waits, but the approval still works on chain until it expires. Revoke it, then reject that contract with “Reject the old contract” on this card."), JSON.stringify(after.warnings));
  assert.ok(!JSON.stringify(after).includes(WAITING), "the waiting address itself is not in the answer");
});

test("a launch recorded while a LaunchLab contract still waited says in the public log that one was dropped, never its address (kept in admin_audit)", async () => {
  const env = { ...newWorld(), ...LP_ON };
  const lp = lpChain({ accounts: { [await metadataAddress(DEMOV)]: { owner: METAPLEX, data: metaplexData({ mint: DEMOV, name: "Demo Vicinity", symbol: "DEMOV", uri: metadataUriFor(DEMOV) }) } } });
  await seedCoin(env.DB, { city: DEMOV_CITY, name: "Demo City", coin: "Demo Coin", user: 7, seat: 1, pending: WAITING });
  const r = await browser(env).send("/api/lp/record", { method: "POST", body: { cityId: DEMOV_CITY }, fetchImpl: lp.fetchImpl });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const design = await env.DB.prepare("SELECT mint, pending_mint FROM city_coins WHERE city_id = ?").bind(DEMOV_CITY).first();
  assert.deepEqual([design.mint, design.pending_mint], [DEMOV, null]);
  const lines = (await env.DB.prepare("SELECT note FROM mod_actions WHERE action = 'coin_launched'").all()).results;
  assert.equal(lines.length, 1);
  assert.match(lines[0].note, /the coin design is locked\. A Raydium LaunchLab contract that was still waiting for this city was dropped: one city has one coin\.$/);
  // nobody ever checked that address (it could be a look-alike named after the city): it is never in the public log (/api/audit)
  assert.ok(!lines[0].note.includes(WAITING), lines[0].note);
  assert.ok(!JSON.stringify(await (await browser(env).send("/api/audit")).json()).includes(WAITING), "not in the public log");
  const kept = (await env.DB.prepare("SELECT actor, action, target, detail FROM admin_audit WHERE action = 'coin_contract_dropped'").all()).results;
  assert.equal(kept.length, 1);
  assert.deepEqual([kept[0].actor, kept[0].target], ["site", DEMOV_CITY]);
  assert.ok(kept[0].detail.includes(WAITING) && kept[0].detail.includes(DEMOV), kept[0].detail);
  // a city with nothing waiting: the line is as it always was
  const env2 = { ...newWorld(), ...LP_ON };
  await seedCoin(env2.DB, { city: DEMOV_CITY, name: "Demo City", coin: "Demo Coin", user: 7, seat: 1 });
  assert.equal((await browser(env2).send("/api/lp/record", { method: "POST", body: { cityId: DEMOV_CITY }, fetchImpl: lp.fetchImpl })).status, 200);
  assert.match((await env2.DB.prepare("SELECT note FROM mod_actions WHERE action = 'coin_launched'").first()).note, /the coin design is locked\.$/);
  assert.equal((await env2.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'coin_contract_dropped'").first()).n, 0);
});

/** A field of a recorded account, written as the program writes it. */
function setField(S, address, layout, field, value) {
  const f = LAYOUT[layout].fields[field];
  const bytes = Buffer.from(S.accounts[address].data, "base64");
  if (f.type === "pubkey") bytes.set(base58Decode(value), f.at);
  else bytes.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)), f.at);
  S.accounts[address].data = bytes.toString("base64");
}

test("a waiting LaunchLab contract is what the founder is told first (no approval is given while it waits); only a coin already on chain and an approval for another wallet come before it, in the status and the launch alike", async () => {
  const w = await world();
  await w.waiting();
  const L = launchpadPdas(PROGRAM);
  const apAddr = await L.approval(BigInt(CITY)), mine = w.lp.S.accounts[apAddr];
  const status = () => w.call(w.f, `/api/lp/launch/status?city=${CITY}`);
  const launch = (i) => w.call(w.f, "/api/lp/launch/tx", { cityId: CITY, mint: addr(i) });
  // the usual case: approvals skip such a city, so there is no approval. Not "an admin approves your coin first": that cannot happen
  delete w.lp.S.accounts[apAddr];
  let st = await status();
  assert.deepEqual([st.status, st.data.state, st.data.why, st.data.message], [200, "paused", "legacy_contract", LEGACY_CONTRACT_WAITING], JSON.stringify(st.data));
  let tx = await launch(93);
  assert.deepEqual([tx.status, tx.data.error], [409, "legacy_contract"]);
  // an approval for another wallet: that is said first, as before (403)
  w.lp.S.accounts[apAddr] = approvalAccount({ cityId: CITY, founder: addr(44), expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 });
  st = await status();
  assert.deepEqual([st.status, st.data.error], [403, "founder_mismatch"]);
  tx = await launch(94);
  assert.deepEqual([tx.status, tx.data.error], [403, "founder_mismatch"]);
  // the coin is on chain already (launched, not recorded here yet): "launched" wins, and nothing is built
  w.lp.S.accounts[apAddr] = mine;
  const coinAddr = await L.coin(BigInt(CITY));
  w.lp.S.accounts[coinAddr] = { ...w.lp.S.accounts[DEMOV_COIN] };
  setField(w.lp.S, coinAddr, "Coin", "city_id", CITY);
  setField(w.lp.S, coinAddr, "Coin", "founder", w.f.w.address);
  st = await status();
  assert.deepEqual([st.status, st.data.state, st.data.mint], [200, "launched", DEMOV]);
  const from = w.lp.S.log.length;
  tx = await launch(95);
  assert.deepEqual([tx.status, tx.data.error, tx.data.mint], [409, "already_launched", DEMOV]);
  assert.equal(w.lp.S.log.slice(from).filter((l) => ["simulateTransaction", "getLatestBlockhash"].includes(l.method)).length, 0, "nothing built");
});
