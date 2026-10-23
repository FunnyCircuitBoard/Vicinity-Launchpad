// The old Raydium LaunchLab path (a founder sends a contract with POST /api/coins/mint, an admin records it with POST
// /api/coins/mint/decide) is closed while the Vicinity launchpad is set up (lpSetup, src/cluster.js: the same gate that hides that
// path on the dashboard). A founder's contract is refused with 409 launchpad_only before anything else, so nothing is read or
// written: no contract waits, no line goes into the public log, the chain is not asked, and the founder check (which puts a seat
// into its grace period on a low balance) does not run. An admin can never RECORD a contract that was sent before (409, nothing
// changes, the chain is not asked), but can still REJECT it: that is the one way to settle such a city, so its coin can be approved
// and launched on the launchpad. Such a rejection only clears what waits, so any admin may make it (the coin's own designer too: the
// one admin who can decide must never be locked out of their own city), and it is logged and told to the founder in fixed, neutral
// words (the contract is not judged: never "Spam" or "Scam", never its address). Every GET /api/coins answer says whether the path is
// closed (launchLabClosed), so the dashboard's words never hang on a second request. With the launchpad's settings missing or
// incomplete the path works exactly as before (test/coins.test.js and test/hardening-coins.test.js cover it there).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IN_UTICA, MINT, browser, chain, newWorld, person, realClock, setHolding, useClock } from "./helpers/world.js";
import { lpSetup } from "../src/cluster.js";
import { LEGACY_REJECTED } from "../src/coins.js";

const UTICA = "5142056";
const COIN_A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const PROGRAM = "Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7", REWARDS = "Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi";
const LP_ON = { LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_PROGRAM_ID: PROGRAM, LAUNCHPAD_REWARDS_PROGRAM_ID: REWARDS, LAUNCHPAD_RPC_URL: "https://lp-rpc.test/devnet" };
const LP_KEYS = ["LAUNCHPAD_CLUSTER", "LAUNCHPAD_PROGRAM_ID", "LAUNCHPAD_REWARDS_PROGRAM_ID", "LAUNCHPAD_RPC_URL", "LAUNCHPAD_DBC_CONFIGS", "LAUNCHPAD_LOOKUP_TABLE", "LAUNCHPAD_TRADING"];
const wranglerVars = () => JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "")).vars;
const design = { name: "Utica Coin", pitch: "The Handshake City, on the map.", pair: "SOL", color: "emerald" };

let env;
beforeEach(() => { useClock("2026-10-20T12:00:00Z"); env = newWorld({ VICINITY_MINT: MINT, NOTIFY: "on" }); });
after(() => realClock());

/** The active City Founder of Utica (the seat made directly), with a saved design (made while the launchpad's settings are off). */
async function founderWithDesign() {
  const f = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  const u = await env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)")
    .bind(UTICA, u.id, u.wallet, at, at).run();
  assert.equal((await f.post("/api/coins/design", design)).ok, true);
  return f;
}
const row = () => env.DB.prepare("SELECT mint, pending_mint, pending_at, launched_at, launched_by FROM city_coins WHERE city_id = ?").bind(UTICA).first();
const launchLines = () => env.DB.prepare("SELECT action FROM mod_actions WHERE action IN ('coin_contract_submitted', 'coin_launch_confirmed', 'coin_contract_rejected')").all().then((r) => r.results.map((x) => x.action));
const rejectedNotes = () => env.DB.prepare("SELECT note FROM mod_actions WHERE action = 'coin_contract_rejected' ORDER BY id").all().then((r) => r.results.map((x) => x.note));
/** The in-app notices of `p` (NOTIFY=on), oldest first. */
async function notices(p) {
  const u = await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(p.w.address).first();
  try { return (await env.DB.prepare("SELECT kind, ref, text, href FROM notices WHERE user_id = ? ORDER BY id").bind(u.id).all()).results.map((r) => ({ ...r })); }
  catch (e) { if (/no such table/.test(String(e))) return []; throw e; }
}
/** Utica's founder with a design and a contract sent through the old path (before the launchpad was set up); then the settings go on. */
async function waitingCity() {
  const f = await founderWithDesign();
  assert.equal((await f.post("/api/coins/mint", { mint: COIN_A })).coin.waiting, true);
  Object.assign(env, LP_ON);
  return f;
}
/** The test chain, counting every request (the closed path must not ask anything). */
function counted() {
  const base = chain(), log = [];
  return { log, fetchImpl: async (url, init) => { log.push(String(url)); return base(url, init); } };
}
const send = async (p, path, body, fetchImpl) => { const r = await p.send(path, { method: "POST", body, fetchImpl }); return { status: r.status, data: await r.json() }; };

test("the live settings (wrangler.jsonc) set the launchpad up, so the LaunchLab path is closed there", () => {
  assert.equal(lpSetup(wranglerVars()).on, true);
});

test("launchpad set up: a founder's POST /api/coins/mint is refused with launchpad_only and nothing changes", async () => {
  const f = await founderWithDesign();
  Object.assign(env, LP_ON);
  const c = counted();
  const r = await send(f, "/api/coins/mint", { mint: COIN_A }, c.fetchImpl);
  assert.deepEqual([r.status, r.data.ok, r.data.error], [409, false, "launchpad_only"]);
  assert.match(r.data.message, /^City coins launch on the Vicinity launchpad now, so a Raydium LaunchLab contract can't be added here\. Nothing was changed\.$/);
  assert.deepEqual({ ...(await row()) }, { mint: null, pending_mint: null, pending_at: null, launched_at: null, launched_by: null });
  assert.deepEqual(await launchLines(), []);
  assert.deepEqual(c.log, [], "nothing is asked of the chain");
  // the public coin says nothing is waiting
  assert.equal((await browser(env).get(`/api/coins?city=${UTICA}`)).coin.waiting, false);
  // even a request that would fail every other check gets the same plain answer (the gate comes first)
  assert.equal((await send(f, "/api/coins/mint", { mint: "nope" })).data.error, "launchpad_only");
  assert.equal((await send(browser(env), "/api/coins/mint", { mint: COIN_A })).data.error, "launchpad_only");
});

test("launchpad set up: the refusal comes before the founder check, so a founder whose balance fell is not put into grace by it", async () => {
  const f = await founderWithDesign();
  Object.assign(env, LP_ON);
  setHolding(f.w.address, 10);
  assert.equal((await send(f, "/api/coins/mint", { mint: COIN_A })).data.error, "launchpad_only");
  const seat = await env.DB.prepare("SELECT status, grace_until FROM seats WHERE city_id = ?").bind(UTICA).first();
  assert.deepEqual([seat.status, seat.grace_until], ["active", null], "the seat is exactly as it was");
});

test("launchpad set up: an admin can't RECORD a waiting contract (409, nothing changes, the chain is not asked), but can REJECT it, which settles the city", async () => {
  // a contract sent through the old path before the launchpad was set up
  const f = await founderWithDesign();
  assert.equal((await f.post("/api/coins/mint", { mint: COIN_A })).coin.waiting, true);
  const before = { ...(await row()) };
  assert.equal(before.pending_mint, COIN_A);
  const adm = await person(env);
  env.ADMIN_WALLETS = adm.w.address;
  Object.assign(env, LP_ON);
  const c = counted();
  for (const body of [{ city: UTICA, mint: COIN_A, approve: true, note: "Checked on the blockchain" }, { city: UTICA, approve: true, note: "" }]) {
    const r = await send(adm, "/api/coins/mint/decide", body, c.fetchImpl);
    assert.deepEqual([r.status, r.data.ok, r.data.error], [409, false, "launchpad_only"], JSON.stringify(body));
    assert.equal(r.data.message, "City coins launch on the Vicinity launchpad now, so a waiting Raydium LaunchLab contract can only be rejected, not recorded. Nothing was changed.");
  }
  assert.deepEqual({ ...(await row()) }, before, "still waiting, nothing recorded");
  assert.deepEqual(await launchLines(), ["coin_contract_submitted"], "only the line from before the launchpad was set up");
  assert.deepEqual(c.log, [], "the chain is not asked");
  // the founder cannot send another one meanwhile
  assert.equal((await send(f, "/api/coins/mint", { mint: "9yQNxyWbF1sYxXb7nq3zJ4sz2tnLoqa4v8bbWbAdwLBS" })).data.error, "launchpad_only");
  assert.equal((await row()).pending_mint, COIN_A);
  // a rejection keeps its rules: signed in, an admin; the founder may never record their own (a second person, as always)
  assert.equal((await send(browser(env), "/api/coins/mint/decide", { city: UTICA, approve: false, note: "x" })).status, 401);
  const member = await person(env);
  assert.deepEqual([(await send(member, "/api/coins/mint/decide", { city: UTICA, approve: false, note: "x" })).data.error], ["not_allowed"]);
  env.ADMIN_WALLETS = `${adm.w.address},${f.w.address}`;
  assert.equal((await send(f, "/api/coins/mint/decide", { city: UTICA, mint: COIN_A, approve: true, note: "mine" })).data.error, "needs_second_person");
  env.ADMIN_WALLETS = adm.w.address;
  assert.equal((await row()).pending_mint, COIN_A, "none of those changed anything");
  // the rejection itself: the contract no longer waits, the public log says so, the chain was not asked
  const rej = await send(adm, "/api/coins/mint/decide", { city: UTICA, mint: COIN_A, approve: false, note: "One city, one coin: it launches on the Vicinity launchpad." }, c.fetchImpl);
  assert.deepEqual([rej.status, rej.data.ok, rej.data.coin.waiting, rej.data.coin.launched], [200, true, false, false], JSON.stringify(rej.data));
  assert.deepEqual({ ...(await row()) }, { mint: null, pending_mint: null, pending_at: null, launched_at: null, launched_by: null });
  assert.deepEqual(await launchLines(), ["coin_contract_submitted", "coin_contract_rejected"]);
  assert.deepEqual(c.log, [], "a rejection asks nothing of the chain");
  // nothing left to decide
  assert.equal((await send(adm, "/api/coins/mint/decide", { city: UTICA, approve: false, note: "again" })).data.error, "not_found");
});

test("launchpad settings missing or incomplete (the devnet defaults never count): the LaunchLab path works exactly as before", async () => {
  const f = await founderWithDesign();
  const adm = await person(env);
  env.ADMIN_WALLETS = adm.w.address;
  for (const partial of [{}, { LAUNCHPAD_CLUSTER: "devnet" }, { LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_PROGRAM_ID: PROGRAM }, { ...LP_ON, LAUNCHPAD_CLUSTER: "on" }, { ...LP_ON, LAUNCHPAD_REWARDS_PROGRAM_ID: PROGRAM }]) {
    for (const k of LP_KEYS) delete env[k];
    Object.assign(env, partial);
    assert.equal(lpSetup(env).on, false, JSON.stringify(partial));
    await env.DB.prepare("UPDATE city_coins SET pending_mint = NULL, pending_at = NULL WHERE city_id = ?").bind(UTICA).run();
    const s = await f.post("/api/coins/mint", { mint: COIN_A });
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.coin.waiting, true);
    const rej = await adm.post("/api/coins/mint/decide", { city: UTICA, mint: COIN_A, approve: false, note: "Not yet" });
    assert.equal(rej.ok, true, JSON.stringify(rej));
    assert.equal(rej.coin.waiting, false);
  }
  // and recording still works with the settings off
  assert.equal((await f.post("/api/coins/mint", { mint: COIN_A })).coin.waiting, true);
  const ok = await adm.post("/api/coins/mint/decide", { city: UTICA, mint: COIN_A, approve: true, note: "Checked on the blockchain" });
  assert.deepEqual([ok.ok, ok.coin.launched, ok.coin.mint], [true, true, COIN_A]);
});

test("every GET /api/coins answer says the old LaunchLab path is closed while the launchpad is set up (launchLabClosed: true), so a page never guesses; with the settings off the answers are exactly as before", async () => {
  await founderWithDesign();
  const adm = await person(env);
  env.ADMIN_WALLETS = adm.w.address;
  const answers = async () => [await browser(env).get("/api/coins"), await browser(env).get(`/api/coins?city=${UTICA}`), await browser(env).get("/api/coins?city=1"), await adm.get("/api/coins?waiting=1")];
  // off: no such key anywhere (the list, one city's coin, a city without one, the admins' queue)
  for (const a of await answers()) assert.equal("launchLabClosed" in a, false, JSON.stringify(a).slice(0, 120));
  assert.deepEqual(Object.keys((await answers())[1]), ["coin", "pairs", "vicinity"]);
  Object.assign(env, LP_ON);
  for (const a of await answers()) assert.equal(a.launchLabClosed, true, JSON.stringify(a).slice(0, 120));
  assert.equal((await answers())[3].ok, true);
  // the live settings: closed
  assert.equal(lpSetup(wranglerVars()).on, true);
});

test("launchpad set up: a rejection is logged and told to the founder in fixed, neutral words, whatever reason or note is sent (never Spam or Scam, never the address)", async () => {
  const f = await waitingCity();
  const adm = await person(env);
  env.ADMIN_WALLETS = adm.w.address;
  // the moderation picker's words, a page that still sends one, or nothing at all: the same line
  const rej = await send(adm, "/api/coins/mint/decide", { city: UTICA, mint: COIN_A, approve: false, note: "Scam / fake token" });
  assert.deepEqual([rej.status, rej.data.ok, rej.data.coin.waiting], [200, true, false], JSON.stringify(rej.data));
  assert.equal(LEGACY_REJECTED, "City coins launch on the Vicinity launchpad now; a contract from the old Raydium LaunchLab path is not recorded.");
  assert.deepEqual(await rejectedNotes(), [`Utica: ${LEGACY_REJECTED}`]);
  // the public log says the same, and never the address
  const audit = JSON.stringify(await (await browser(env).send("/api/audit")).json());
  assert.ok(audit.includes(LEGACY_REJECTED) && !audit.includes("Scam") && !audit.includes(COIN_A));
  // the founder is told (their card just stops saying it waits): a founder notice, to their Founder tab, in the same words
  assert.deepEqual(await notices(f), [{ kind: "founder", ref: UTICA, text: `Utica: ${LEGACY_REJECTED}`, href: "/dashboard#founder" }]);
  // another one sent with no note at all (the dashboard sends none): the same line, no "reason_required"
  await env.DB.prepare("UPDATE city_coins SET pending_mint = ?, pending_at = ? WHERE city_id = ?").bind(COIN_A, new Date(Date.now()).toISOString(), UTICA).run();
  const bare = await send(adm, "/api/coins/mint/decide", { city: UTICA, mint: COIN_A, approve: false });
  assert.equal(bare.status, 200, JSON.stringify(bare.data));
  assert.deepEqual(await rejectedNotes(), [`Utica: ${LEGACY_REJECTED}`, `Utica: ${LEGACY_REJECTED}`]);
});

test("launchpad set up: the admin who designed the coin can settle (reject) its waiting contract, so no city is stuck; never record it; with the settings off a second person is needed as before", async () => {
  const f = await waitingCity();
  env.ADMIN_WALLETS = f.w.address; // the one admin who can decide is this coin's own designer
  const rec = await send(f, "/api/coins/mint/decide", { city: UTICA, mint: COIN_A, approve: true, note: "mine" });
  assert.deepEqual([rec.status, rec.data.error], [403, "needs_second_person"], "never their own record");
  assert.equal((await row()).pending_mint, COIN_A);
  const rej = await send(f, "/api/coins/mint/decide", { city: UTICA, mint: COIN_A, approve: false });
  assert.deepEqual([rej.status, rej.data.ok, rej.data.coin.waiting], [200, true, false], JSON.stringify(rej.data));
  assert.deepEqual({ ...(await row()) }, { mint: null, pending_mint: null, pending_at: null, launched_at: null, launched_by: null });
  assert.deepEqual(await rejectedNotes(), [`Utica: ${LEGACY_REJECTED}`]);
  // with the launchpad's settings off, the old rule holds whole: someone other than the founder decides, with a reason
  for (const k of LP_KEYS) delete env[k];
  assert.equal((await f.post("/api/coins/mint", { mint: COIN_A })).coin.waiting, true);
  assert.equal((await send(f, "/api/coins/mint/decide", { city: UTICA, approve: false, note: "mine" })).data.error, "needs_second_person");
  const adm = await person(env);
  env.ADMIN_WALLETS = adm.w.address;
  assert.equal((await send(adm, "/api/coins/mint/decide", { city: UTICA, approve: false, note: "" })).data.error, "reason_required");
  const old = await send(adm, "/api/coins/mint/decide", { city: UTICA, approve: false, note: "Not yet" });
  assert.equal(old.status, 200);
  assert.equal((await rejectedNotes()).at(-1), "Utica: Not yet", "the admin's own words, as before");
  assert.deepEqual((await notices(f)).map((n) => n.text), [`Utica: ${LEGACY_REJECTED}`], "no notice for the old path's rejection, as before");
});
