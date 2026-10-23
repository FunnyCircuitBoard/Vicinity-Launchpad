// The ready-made city coin on the real dashboard and the Launchpad (COIN_V2_READY=on) against the stage 1 recheck: a coin the server says
// Vicinity made (madeBy, src/coins.js) is never called the founder's design, launched or not, with a founder now or not, gated or not;
// an approval on chain that is not this coin's (another wallet's, an earlier design's) leaves the Founder tab no coin of its own to show,
// only why; the Launchpad's tag, Upcoming note, filter and sentence say "chosen" while the switch is on, and nothing changes with it off.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { ADDR, memberMe, openDashboard } from "./helpers/dashpage.js";

const HASH = "3f9a2c1b" + "a".repeat(56), ART = `/coin-meta/art/${"b".repeat(64)}.png`;
const CITY = { id: "5142056", name: "Utica", region: "New York", regionCode: "NY", country: "US", countryName: "United States" };
const COIN = { ticker: "UTICA", name: "Utica", description: "The city coin of Utica, New York, United States.", pair: "SOL", templateVersion: "t1", source: "Vicinity city list" };
const view = (over = {}) => ({ ok: true, mode: "founder", city: CITY, coin: { ...COIN, art: ART, contentHash: HASH, version: HASH.slice(0, 8) }, chosen: null, inUse: false, earlier: false, gate: null, preview: null, ...over });
const CHOSEN = { contentHash: HASH, version: HASH.slice(0, 8), at: "2026-10-18T10:00:00Z", current: true, art: ART, launched: false, ticker: "UTICA", name: "Utica", mine: true };
const MINT = "9yQNxyWbF1sYxXb7nq3zJ4sz2tnLoqa4v8bbWbAdwLBS";
/** /api/coins?city= of Utica: the ready-made coin's design row (madeBy vicinity), as "Use this coin" wrote it. */
const readyRow = (over = {}) => ({ ok: true, coin: { city: "5142056", cityName: "Utica", country: "US", name: "Utica", pitch: COIN.description, pair: "SOL", pairMint: "So11111111111111111111111111111111111111112",
  color: "ink", logo: null, mint: null, launched: false, waiting: false, by: "SwiftHarbor10", updatedAt: "2026-10-18T10:00:00Z", madeBy: "vicinity", ...over }, pairs: null, vicinity: null });

function founderMe() {
  const me = memberMe({ wallet: ADDR, launched: true, amount: 2_000_000, rank: 3 });
  const seat = { id: 7, cityId: "5142056", city: "Utica", country: "US", status: "active", since: "2026-10-01T12:00:00Z", appealUntil: null, graceUntil: null, probationUntil: null, threshold: 100000, policy: 5 };
  me.roles.founder = true; me.level = "founder";
  me.founder.seat = seat;
  me.community.seat = { id: 7, status: "active", name: "SwiftHarbor10", wallet: "7Np41*****4K2", since: seat.since, appealUntil: null, graceUntil: null, probationUntil: null, you: true, openObjections: 0, threshold: 100000, policy: 5, cofounders: [], quorum: null };
  me.coinV2Ready = true;
  return me;
}
function memberOf({ seat = true } = {}) {
  const me = memberMe({ wallet: ADDR });
  me.coinV2Ready = true;
  if (seat) me.community.seat = { id: 7, status: "active", name: "SwiftHarbor10", wallet: "7Np41*****4K2", since: "2026-10-01T12:00:00Z", appealUntil: null, graceUntil: null, probationUntil: null, you: false, openObjections: 0, threshold: 100000, policy: 5, cofounders: [], quorum: null };
  return me;
}
async function open({ me = founderMe(), ready, coin }) {
  const page = await openDashboard({
    me, official: { ok: true },
    api: async (path) => {
      if (path.startsWith("/api/coins/ready?")) return ready;
      if (path.startsWith("/api/lp/")) return { ok: false, error: "not_enabled", _status: 404 };
      if (path.startsWith("/api/coins?city=") && coin) return coin;
      return undefined;
    },
  });
  await page.advance(61_000);
  await page.flush(60);
  return page;
}

test("S1R-1: a launched ready-made coin is 'made by Vicinity' for a member and its founder alike, never 'designed by the City Founder'", async () => {
  const launched = readyRow({ mint: MINT, launched: true, launchedAt: "2026-10-20T12:00:00Z" });
  const m = await open({ me: memberOf(), ready: { ok: true, mode: "preview", preview: null }, coin: launched });
  assert.equal(m.text("#coin-kicker"), "City coin · made by Vicinity");
  assert.equal(m.text("#coin-status"), "● Live");
  assert.match(m.text("#coin-by"), /^Made by Vicinity from the city list · chosen /);
  assert.doesNotMatch(m.text("#coin") || "", /[Dd]esigned by/);
  const f = await open({ ready: view({ chosen: { ...CHOSEN, current: false, launched: true }, gate: { code: "launched", message: "This city's coin has launched. Its design is fixed for good." } }), coin: launched });
  assert.equal(f.text("#coin-kicker"), "City coin · made by Vicinity");
  assert.doesNotMatch(f.text("#coin") || "", /designed by the City Founder/);
});

test("S1R-1: a chosen coin whose founder seat was released is 'made by Vicinity', not launched, with no founder's design and no LaunchLab", async () => {
  const p = await open({ me: memberOf({ seat: false }), ready: { ok: true, mode: "preview", preview: null }, coin: readyRow() });
  assert.equal(p.text("#coin-kicker"), "City coin · made by Vicinity");
  assert.equal(p.text("#coin-status"), "Not launched");
  assert.equal(p.text("#coin-note"), "Made by Vicinity from the city list. Nothing has launched yet.");
  assert.doesNotMatch(p.text("#coin") || "", /Designed|Raydium LaunchLab/);
  // with a founder seated (their choice or a former founder's), the tag says it is chosen
  const q = await open({ me: memberOf(), ready: { ok: true, mode: "preview", preview: null }, coin: readyRow() });
  assert.deepEqual([q.text("#coin-kicker"), q.text("#coin-status")], ["City coin · made by Vicinity", "Chosen"]);
});

test("S1R-1: a founder whose chosen coin is gated (below the bar) is not told the founder designed it next to 'made by Vicinity'", async () => {
  const p = await open({ ready: view({ chosen: CHOSEN, inUse: true, gate: { code: "below_amount", message: "Your balance is below the founder amount." } }), coin: readyRow() });
  assert.equal(p.$("#coin-preview").hidden, true, "a gate: no preview stands in");
  assert.equal(p.text("#coin-kicker"), "City coin · made by Vicinity");
  assert.equal(p.text("#coin-note"), "Your city coin is the one made by Vicinity, in your Founder tab. Nothing has launched yet.");
  // a studio design the founder made before (no madeBy): still the founder's design, said as that
  const studio = await open({ me: memberOf(), ready: { ok: true, mode: "preview", preview: null }, coin: readyRow({ madeBy: undefined, name: "Utica Coin", pitch: "The Handshake City." }) });
  assert.equal(studio.text("#coin-kicker"), "City coin · designed by the City Founder");
  assert.equal(studio.text("#coin-status"), "Designed");
  assert.equal(studio.text("#coin-note"), "Designed by Utica's founder. Nothing has launched yet.");
});

test("S1R-2 / SEC-S1-5: an approval on chain that is not this coin's leaves the card no coin of its own: the gate's words only, and the Founder card says them", async () => {
  for (const gate of [
    { code: "approved_other", message: "This city's coin is approved on the blockchain for another wallet than yours (the founder's wallet when it was approved). Vicinity's owner must revoke that approval before you can choose and launch your coin." },
    { code: "approved_earlier", message: "Your city's coin is approved on the blockchain as “Utica Coin” ($UTICA), but not with the Vicinity coin shown here. It launches as approved, with the design it was approved with." },
  ]) {
    const p = await open({ ready: view({ chosen: { ...CHOSEN, mine: false }, gate, preview: { label: "Preview, not launched", ticker: "UTICA", name: "Utica", chosen: true, city: CITY, art: ART } }), coin: readyRow() });
    assert.equal(p.$("#coin-ready").hidden, false);
    assert.equal(p.$(".coin-ready__body").hidden, true, `${gate.code}: no picture or facts of a coin that is not the one approved`);
    assert.equal(p.$("#cr-version").hidden, true);
    assert.equal(p.text("#cr-gate"), gate.message);
    assert.equal(p.text("#cr-state"), "Not available now");
    assert.equal(p.$("#cr-use").disabled, true);
    assert.equal(p.$("#coin-preview").hidden, true, "never 'your city coin, approved on the blockchain'");
    assert.equal(p.text("#fcard-note"), gate.message);
    assert.doesNotMatch(p.text("body"), /It launches exactly as approved|This is your city coin, approved on the blockchain/);
  }
  // the founder's own approval: the coin is shown, as before
  const own = await open({ ready: view({ chosen: CHOSEN, inUse: true, gate: { code: "approved", message: "Your coin is approved on the blockchain with its current design. It launches exactly as approved." }, preview: { label: "Preview, not launched", ticker: "UTICA", name: "Utica", chosen: true, city: CITY, art: ART } }), coin: readyRow() });
  assert.equal(own.$(".coin-ready__body").hidden, false);
  assert.equal(own.$("#coin-preview").hidden, false);
});

/* ---------- the Launchpad ---------- */
const LP_SRC = readFileSync(new URL("../public/launchpad.js", import.meta.url), "utf8");
const LP_HTML = readFileSync(new URL("../public/launchpad.html", import.meta.url), "utf8");
// the page's pure helpers, as test/launchpad-ui.test.js runs them (no page)
const fakeEl = () => ({ textContent: "", classList: { toggle() {}, add() {}, remove() {} }, style: {}, offsetWidth: 0, addEventListener() {}, dataset: {}, hidden: false, replaceChildren() {} });
const lpWin = { V: { $: () => fakeEl(), $$: () => [], el: () => fakeEl(), official: Promise.resolve({ launchpadV2: true }), opensAt: () => 0, reduced: true, api: async () => ({}), fmt: String, isAddr: () => false } };
vm.runInNewContext(LP_SRC, { window: lpWin, Intl, URLSearchParams, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {} });
const P = lpWin.VLaunchpad.pure;
const plain = (x) => JSON.parse(JSON.stringify(x));

test("S1R-1: the Launchpad never calls a ready-made coin 'Designed': its tag says Chosen; the Upcoming note, the filter and the sentence say chosen while the switch is on", () => {
  assert.deepEqual(plain(P.statusLabel({ status: "designed", madeBy: "vicinity" })), ["Chosen", ""]);
  assert.deepEqual(plain(P.statusLabel({ status: "designed" })), ["Designed", ""], "a founder's own design is still that");
  assert.deepEqual(plain(P.statusLabel({ status: "live", madeBy: "vicinity" })), ["Live", "tag--ok"]);
  assert.equal(P.TAB_NOTE_READY.upcoming, "Upcoming: chosen or designed, not launched yet.");
  // the built page: with the switch off the sentence reads exactly as before (the second wording hidden)
  assert.match(LP_HTML, /the others are <span data-designed-copy>designed and waiting<\/span><span data-ready-copy hidden>chosen or designed, not launched yet<\/span>\./);
  // the page: the note, the filter and the sentence follow readyOn (/api/official coinV2Ready, read before the first card is drawn)
  assert.match(LP_SRC, /\$\("#lp-tabnote"\)\.textContent = \(readyOn && TAB_NOTE_READY\[state\.tab\]\) \|\| \(lpOn && TAB_NOTE_LP\[state\.tab\]\) \|\| TAB_NOTE\[state\.tab\];/);
  assert.match(LP_SRC, /if \(readyOn\) for \(const o of \$\$\("#lp-status option"\)\) if \(o\.value === "designed"\) o\.textContent = "Chosen or designed";\n\s+for \(const e of \$\$\("\[data-designed-copy\]"\)\) e\.hidden = readyOn;\n\s+for \(const e of \$\$\("\[data-ready-copy\]"\)\) e\.hidden = !readyOn;/);
});
