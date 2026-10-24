// The dashboard while the Vicinity launchpad is set up (/api/official cityCoins, then the probe GET /api/lp/launch/status answers on):
// the old Raydium LaunchLab path is closed on the server (test/launchlab-closed.test.js): a contract can't be sent or recorded, and one
// sent before can only be rejected. The founder's "add the contract" field already hides then (test/lp-launch-ui.test.js); here: the
// admins' queue of contracts waiting for a check shows Reject only (no Record), with one line saying why, and a founder whose contract
// was sent before the launchpad was set up is told it waits and nothing can launch until an admin settles it, not that an admin is
// checking it. The page takes the old path's state from the server's own word in the coin's answer (GET /api/coins launchLabClosed), so
// a status call still on its way or a probe that failed never brings the old path's words back; a rejection in the queue asks for no
// reason (the server logs fixed, neutral words); the words say what is true now
// ("Old contract waiting", "old contract to settle", the Buy & swap card's note). With the settings off the page is exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { ADDR, memberMe, openDashboard } from "./helpers/dashpage.js";
import { LEGACY_REJECTED } from "../src/coins.js";
import { LEGACY_CONTRACT_WAITING } from "../src/lplaunch.js";

const LP_LAUNCH = readFileSync(new URL("../public/lp-launch.js", import.meta.url), "utf8");
const PENDING = "PendMint1111111111111111111111111111111111111";
const WAITING = { ok: true, waiting: [{ city: "5128581", cityName: "New York City", country: "US", name: "Big Apple", pair: "SOL", pendingMint: PENDING, pendingAt: "2026-10-09T12:00:00Z", designerId: 3 }] };
const coinOf = (over = {}) => ({ ok: true, coin: { city: "5142056", cityName: "Utica", country: "US", name: "Utica Coin", pitch: "", pair: "SOL", pairMint: "So11111111111111111111111111111111111111112", color: "gold", logo: null, mint: null, launched: false, waiting: false, by: "SwiftHarbor10", updatedAt: "2026-10-09T12:00:00Z", ...over }, pairs: null, vicinity: null });
const LEGACY = "Nothing can launch until an admin settles the contract sent for this city through the old Raydium LaunchLab path.";
const LP_PENDING = "Your coin launches on the Vicinity launchpad, after an admin approves it on chain.";
const NOT_APPROVED = "An admin approves your coin on chain first; your pair must be SOL. Then you launch it here.";
const VIC = "DmsT8fDJx5KuToivsKUwFErpSWosdWHRBfNyRTugYKiw";
// every word of the old path the dashboard has: none may show while the launchpad is set up
const OLD_PATH = /Raydium LaunchLab, then add the contract|Add the contract|Add your coin's contract|Launched it on Raydium LaunchLab|An admin (is checking|checks it)|records? (it|its contract|the contract)/;

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
/**
 * The real dashboard with the real lp-launch.js (the built page loads it before dashboard.js; here it joins on the next refresh). The
 * server's answers carry launchLabClosed: true exactly when the launchpad is set up (src/coins.js), as the real one does. `status`: the launch
 * card's status (a promise holds it back); `probe`: the no-city probe's answer (null: it fails with a 503).
 */
async function open({ me, gate, coin = coinOf(), status = null, probe = undefined, decide = null, official }) {
  const closed = gate ? { launchLabClosed: true } : {}; // the key exists only while the launchpad is set up
  const page = await openDashboard({
    me,
    official: official !== undefined ? official : gate ? { ok: true, cityCoins: { cluster: "mainnet" } } : { ok: true },
    api: async (path, body) => {
      if (path.startsWith("/api/lp/")) {
        if (!gate) return { ok: false, error: "not_enabled", _status: 404 };
        if (path.includes("city=")) return status ? await status : { ok: true, cluster: "mainnet", state: "not_approved", message: "Not approved yet." };
        return probe === null ? { ok: false, error: "unavailable", _status: 503 } : { ok: true, on: true, cluster: "mainnet", configsSet: true, speedTable: true };
      }
      if (path === "/api/coins?waiting=1") return { ...WAITING, ...closed };
      if (path === "/api/coins/mint/decide") return decide ? decide(body) : { ok: true, coin: null };
      if (path.startsWith("/api/coins")) return { ...coin, ...closed };
      return undefined;
    },
  });
  page.win.LP = { supported: async () => true, say: (c, x) => (x && x.message) || c, renderSummary() {}, prepare: async () => { throw new Error("not in this test"); } };
  vm.runInContext(LP_LAUNCH, page.win, { filename: "public/lp-launch.js" });
  await page.advance(61_000);
  await page.flush(60);
  return page;
}

test("launchpad set up: the admins' queue of waiting LaunchLab contracts shows Reject only (recording is closed), and says why", async () => {
  const page = await open({ me: adminMe(), gate: true });
  assert.ok(page.callsTo("/api/coins").some((c) => c.path === "/api/coins?waiting=1"), "the queue is asked for: a waiting contract still needs settling");
  assert.equal(page.$("#coin-admin").hidden, false);
  assert.match(page.text("#coin-waiting"), /New York City/);
  assert.match(page.text("#coin-waiting"), new RegExp(PENDING));
  assert.doesNotMatch(page.text("#coin-waiting"), /Record it/, "no Record: the server refuses it");
  assert.match(page.text("#coin-waiting"), /Reject/);
  assert.match(page.text("#coin-waiting"), /can't be recorded as the city's coin\. Reject it to settle the city/);
  assert.equal(page.calls.filter((c) => c.path === "/api/coins/mint/decide").length, 0, "nothing is sent until an admin acts");
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

const visibleOldPath = (page) => page.$$("[data-launchlab-copy]").filter((e) => !e.hidden).map((e) => e.textContent.trim());
const words = (page) => [page.text("#fcard-note"), page.text("#fcard-go"), page.text("#today-list"), page.text("#fcard-coin")].join(" | ");

test("launchpad set up, the launch card's status still on its way: the founder never sees the old path's words meanwhile, only true launchpad words", async () => {
  for (const waiting of [false, true]) {
    let release;
    const held = new Promise((r) => { release = r; });
    const page = await open({ me: founderMe(), gate: true, coin: coinOf({ waiting }), status: held.then(() => ({ ok: true, cluster: "mainnet", state: "not_approved", message: "Not approved yet." })) });
    const during = words(page);
    assert.doesNotMatch(during, OLD_PATH, `waiting=${waiting}: ${during}`);
    assert.deepEqual(visibleOldPath(page), [], "no LaunchLab line, no 'add the contract' field");
    if (waiting) {
      assert.equal(page.text("#fcard-note"), LEGACY);
      assert.equal(page.text("#fcard-coin"), "Old contract waiting");
    } else {
      assert.equal(page.text("#fcard-note"), LP_PENDING, "true whatever the status will say");
      assert.equal(page.$("#fcard-go").hidden, true, "no button to a card that is not filled yet");
    }
    release();
    await page.advance(2000);
    await page.flush(60);
    assert.equal(page.text("#fcard-note"), waiting ? LEGACY : NOT_APPROVED);
    assert.doesNotMatch(words(page), OLD_PATH);
  }
  // the status could not be read (the chain did not answer: the launch card says so): the launchpad's own true words, not "not approved"
  const failed = await open({ me: founderMe(), gate: true, status: Promise.resolve({ ok: false, error: "rpc_unavailable", message: "The blockchain could not be reached just now.", _status: 503 }) });
  assert.equal(failed.text("#fcard-note"), LP_PENDING);
  assert.equal(failed.text("#fcard-go"), "See the launch", "the card says what went wrong");
  assert.doesNotMatch(words(failed), OLD_PATH);
});

test("launchpad set up, the probe fails (a 503): the server's word in the coin's own answer keeps the launchpad's words; never the old path's instructions", async () => {
  const page = await open({ me: founderMe(), gate: true, probe: null });
  assert.equal(page.callsTo("/api/lp/launch/status").length, 1, "the probe was asked and failed");
  assert.deepEqual(visibleOldPath(page), [], "no ', on Raydium LaunchLab', no 'Launched it on Raydium LaunchLab? Add the contract'");
  assert.doesNotMatch(words(page), OLD_PATH, words(page));
  assert.equal(page.text("#fcard-note"), LP_PENDING);
  assert.equal(page.$("#fcard-go").hidden, true);
  // nothing was sent to the closed path
  assert.equal(page.calls.filter((c) => c.path === "/api/coins/mint").length, 0);
  // /api/official failing too: the coin's answer alone is enough
  const alone = await open({ me: founderMe(), gate: true, official: null });
  assert.deepEqual(visibleOldPath(alone), []);
  assert.doesNotMatch(words(alone), OLD_PATH, words(alone));
  assert.equal(alone.text("#fcard-note"), LP_PENDING);
});

test("launchpad set up: Reject asks for no moderation reason: one confirm that shows the fixed, neutral words, and the decision sends no note", async () => {
  const sent = [];
  const page = await open({ me: adminMe(), gate: true, decide: (body) => { sent.push(body); return { ok: true, coin: null }; } });
  const acts = page.$("#coin-waiting .coin-check__actions");
  assert.ok(acts.classList.contains("coin-check__actions--one"), "the lone Reject is sized to its words");
  assert.deepEqual([...acts.querySelectorAll("button")].map((b) => b.textContent), ["Reject"]);
  await page.tap(acts.querySelector("button"));
  const form = page.$("#coin-waiting .reason-form");
  assert.ok(form, "a confirm opens");
  assert.equal(form.querySelector("select"), null, "no Spam / Scam / Other picker");
  assert.equal(form.querySelector("input"), null, "no note");
  assert.ok(form.textContent.includes(LEGACY_REJECTED), "it shows the words the server logs and tells the founder");
  assert.equal(sent.length, 0, "nothing sent before the confirm");
  assert.deepEqual([...form.querySelectorAll("button")].map((b) => b.textContent), ["Reject it", "Cancel"]);
  // "Reject it" submits the form (pagedom does not turn a submit button's click into a submit: the event is sent the way the browser would)
  form.dispatchEvent(Object.assign({ type: "submit", bubbles: true, target: form, preventDefault() {}, stopPropagation() {} }));
  await page.flush(30);
  assert.deepEqual(sent, [{ city: "5128581", mint: PENDING, approve: false }]);
  assert.ok(page.toasts.includes("Rejected: New York City is settled"), JSON.stringify(page.toasts));
});

test("launchpad set up: the words say what is true now: 'Old contract waiting' for the founder (what it means first), 'old contract to settle' for the admin, the queue's own title", async () => {
  const f = await open({ me: founderMe(), gate: true, coin: coinOf({ waiting: true }) });
  assert.equal(LEGACY, LEGACY_CONTRACT_WAITING, "the founder card and the launch card say the same words");
  assert.equal(f.text("#fcard-coin"), "Old contract waiting");
  assert.equal(f.text("#coin-status"), "Old contract waiting");
  const card = f.$$("#today-list .today__card").find((a) => a.querySelector(".today__title").textContent === "Old contract waiting");
  assert.ok(card, f.text("#today-list"));
  assert.ok(card.querySelector(".today__sub").textContent.startsWith("Nothing can launch until an admin settles"), "what it means first: a cut line still says it");
  const a = await open({ me: adminMe(), gate: true });
  assert.match(a.text("#today-list"), /1 waiting for you ?1 old contract to settle/);
  assert.doesNotMatch(a.text("#today-list"), /to check/);
  assert.match(a.text("#role-queue"), /1 old contract to settle/);
  assert.equal(a.text("#coin-admin-title"), "Old LaunchLab contracts to settle");
  assert.equal(a.$("#coin-admin-card").getAttribute("aria-label"), "Old LaunchLab contracts to settle");
  // with the settings off: as before
  const off = await open({ me: adminMe(), gate: false });
  assert.match(off.text("#today-list"), /1 coin contract to check/);
  assert.equal(off.text("#coin-admin-title"), "Contracts waiting for a check");
});

test("Buy & swap, the city coin's route: with the launchpad set up the note says how a city coin comes to trade now (an on-chain approval, the founder's launch), not that an admin records it", async () => {
  for (const gate of [true, false]) {
    const me = memberMe({ wallet: ADDR, launched: true, amount: 10, rank: 3 });
    const page = await open({ me, gate, coin: { ok: true, coin: null, pairs: null, vicinity: VIC } });
    const tab = page.$('#trade [data-route="city"]');
    await page.tap(tab);
    await page.flush(20);
    assert.equal(page.text("#tr-note"), gate
      ? "$UTICA trades once an admin approves it on chain and Utica's founder launches it on the Vicinity launchpad."
      : "$UTICA trades once Utica's founder launches it and an admin records its contract.", `gate ${gate}`);
  }
});
