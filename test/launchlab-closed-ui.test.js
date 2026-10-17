// The dashboard while the Vicinity launchpad is set up (/api/official cityCoins, then the probe GET /api/lp/launch/status answers on):
// the old Raydium LaunchLab path is closed on the server (test/launchlab-closed.test.js), so the page shows none of it. The founder's
// "add the contract" field already hides then (test/lp-launch-ui.test.js); here: the admins' queue of contracts waiting for a check
// (its Record and Reject would only be refused) is not asked for and stays hidden, and a founder whose contract was sent before the
// launchpad was set up is not told an admin is checking it. With the settings off the page is exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { ADDR, memberMe, openDashboard } from "./helpers/dashpage.js";

const LP_LAUNCH = readFileSync(new URL("../public/lp-launch.js", import.meta.url), "utf8");
const PENDING = "PendMint1111111111111111111111111111111111111";
const WAITING = { ok: true, waiting: [{ city: "5128581", cityName: "New York City", country: "US", name: "Big Apple", pair: "SOL", pendingMint: PENDING, pendingAt: "2026-10-09T12:00:00Z", designerId: 3 }] };
const coinOf = (over = {}) => ({ ok: true, coin: { city: "5142056", cityName: "Utica", country: "US", name: "Utica Coin", pitch: "", pair: "SOL", pairMint: "So11111111111111111111111111111111111111112", color: "gold", logo: null, mint: null, launched: false, waiting: false, by: "SwiftHarbor10", updatedAt: "2026-10-09T12:00:00Z", ...over }, pairs: null, vicinity: null });
const LEGACY = "A contract for this city is waiting for a check. Nothing can launch until that's settled.";

function adminMe() {
  const me = memberMe({ wallet: ADDR, launched: true, amount: 10, rank: 3 });
  me.roles.admin = true;
  return me;
}
function founderMe() {
  const me = memberMe({ wallet: ADDR, launched: true, amount: 2_000_000, rank: 3 });
  const seat = { id: 7, cityId: "5142056", city: "Utica", country: "US", status: "active", since: "2026-10-01T12:00:00Z", appealUntil: null, graceUntil: null, probationUntil: null, threshold: 100000, policy: 5 };
  me.roles.founder = true; me.level = "founder";
  me.founder.seat = seat;
  me.community.seat = { id: 7, status: "active", name: "SwiftHarbor10", wallet: "7Np41*****4K2", since: seat.since, appealUntil: null, graceUntil: null, probationUntil: null, you: true, openObjections: 0, threshold: 100000, policy: 5, cofounders: [], quorum: null };
  return me;
}
/** The real dashboard with the real lp-launch.js (the built page loads it before dashboard.js; here it joins on the next refresh). */
async function open({ me, gate, coin = coinOf() }) {
  const page = await openDashboard({
    me,
    official: gate ? { ok: true, cityCoins: { cluster: "mainnet" } } : { ok: true },
    api: async (path) => {
      if (path.startsWith("/api/lp/")) return !gate ? { ok: false, error: "not_enabled", _status: 404 } : path.includes("city=") ? { ok: true, cluster: "mainnet", state: "not_approved", message: "Not approved yet." } : { ok: true, on: true, cluster: "mainnet", configsSet: true, speedTable: true };
      if (path === "/api/coins?waiting=1") return WAITING;
      if (path.startsWith("/api/coins")) return coin;
      return undefined;
    },
  });
  page.win.LP = { supported: async () => true, say: (c, x) => (x && x.message) || c, renderSummary() {}, prepare: async () => { throw new Error("not in this test"); } };
  vm.runInContext(LP_LAUNCH, page.win, { filename: "public/lp-launch.js" });
  await page.advance(61_000);
  await page.flush(60);
  return page;
}

test("launchpad set up: the admins' queue of LaunchLab contracts is not asked for again and stays hidden (no Record, no Reject, no count)", async () => {
  const page = await open({ me: adminMe(), gate: true });
  const asked = page.callsTo("/api/coins").filter((c) => c.path === "/api/coins?waiting=1").length;
  await page.advance(61_000);
  await page.flush(60);
  assert.equal(page.callsTo("/api/coins").filter((c) => c.path === "/api/coins?waiting=1").length, asked, "once the probe says the launchpad is on, the queue is not asked for");
  assert.equal(page.$("#coin-admin").hidden, true);
  assert.equal(page.$("#coin-admin-card").hidden, true);
  assert.equal(page.$("#coin-waiting").children.length, 0, "no Record or Reject buttons");
  assert.doesNotMatch(page.text("#today-list") || "", /coin contracts? to check/);
  assert.equal(page.calls.filter((c) => c.path === "/api/coins/mint/decide").length, 0);
});

test("launchpad settings off: the admins' queue is exactly as before (asked, shown with Record and Reject)", async () => {
  const page = await open({ me: adminMe(), gate: false });
  assert.ok(page.callsTo("/api/coins").some((c) => c.path === "/api/coins?waiting=1"));
  assert.equal(page.$("#coin-admin").hidden, false);
  assert.equal(page.$("#coin-admin-card").hidden, false);
  assert.match(page.text("#coin-waiting"), /New York City/);
  assert.match(page.text("#coin-waiting"), new RegExp(PENDING));
  assert.match(page.text("#coin-waiting"), /Record it/);
  assert.match(page.text("#coin-waiting"), /Reject/);
});

test("launchpad set up: a founder whose LaunchLab contract was sent before is told it is waiting and nothing can launch, not that an admin is checking it", async () => {
  const page = await open({ me: founderMe(), gate: true, coin: coinOf({ waiting: true }) });
  assert.equal(page.text("#fcard-note"), LEGACY);
  assert.match(page.text("#today-list"), new RegExp(LEGACY.replace(/[.']/g, (c) => `\\${c}`)));
  assert.doesNotMatch(page.text("#fcard-note") + page.text("#today-list"), /An admin (is checking|checks it)/);
  for (const e of page.$$("[data-launchlab-copy]")) assert.equal(e.hidden, true, "no 'add the contract' field");
});

test("launchpad settings off: the waiting founder's words are exactly as before", async () => {
  const page = await open({ me: founderMe(), gate: false, coin: coinOf({ waiting: true }) });
  assert.equal(page.text("#fcard-note"), "An admin is checking the contract. Once recorded, the design is locked and it becomes the one official coin.");
  assert.match(page.text("#today-list"), /An admin checks it on the blockchain\. Nothing to do\./);
  assert.doesNotMatch(page.text("#fcard-note") + page.text("#today-list"), /Nothing can launch until/);
});
