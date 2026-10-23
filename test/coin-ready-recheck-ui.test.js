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

test("S1R-3 / F1: a choice the city list moved away from (chosen: false) is never 'Chosen' nor 'chosen <date>' on the City tab, for a member or its founder", async () => {
  const stale = (me) => { me.community.ticker = "UTICA2"; return me; };
  // a member, the founder seated: Vicinity's design, not chosen
  const m = await open({ me: stale(memberOf()), ready: { ok: true, mode: "preview", preview: null }, coin: readyRow({ chosen: false }) });
  assert.deepEqual([m.text("#coin-kicker"), m.text("#coin-status"), m.text("#coin-ticker")], ["City coin · made by Vicinity", "Not chosen yet", "$UTICA2"]);
  assert.equal(m.text("#coin-by"), "Made by Vicinity from the city list");
  assert.equal(m.text("#coin-note"), "Made by Vicinity from the city list. Nothing has launched yet.");
  assert.doesNotMatch(m.text("#coin") || "", /Chosen|chosen Oct/);
  // no founder now: not launched, as before
  const n = await open({ me: stale(memberOf({ seat: false })), ready: { ok: true, mode: "preview", preview: null }, coin: readyRow({ chosen: false }) });
  assert.deepEqual([n.text("#coin-status"), n.text("#coin-by")], ["Not launched", "Made by Vicinity from the city list"]);
  // the founder: their card offers the new version ($UTICA2, not in use); the coin card does not call $UTICA2 chosen
  const f = await open({ me: stale(founderMe()), ready: view({ coin: { ...COIN, ticker: "UTICA2", art: ART, contentHash: "c".repeat(64), version: "cccccccc" }, chosen: CHOSEN, inUse: false }), coin: readyRow({ chosen: false }) });
  assert.equal(f.text("#coin-status"), "Not chosen yet");
  assert.equal(f.text("#coin-by"), "Made by Vicinity from the city list");
  assert.equal(f.text("#coin-note"), "Your city coin is made by Vicinity, and the city list changed since it was chosen: see your Founder tab. Nothing has launched yet.");
  assert.match(f.text("#cr-note"), /Vicinity's design or the city list changed since you chose your coin/);
  // the choice holds (chosen: true): chosen, with its date
  const ok = await open({ me: memberOf(), ready: { ok: true, mode: "preview", preview: null }, coin: readyRow({ chosen: true }) });
  assert.equal(ok.text("#coin-status"), "Chosen");
  assert.match(ok.text("#coin-by"), /^Made by Vicinity from the city list · chosen Oct 18, 2026$/);
});

test("F2: the Today line that sends the founder to Use this coin says what the server says: a new version of their choice, a former founder's choice, their earlier design, or a coin ready", async () => {
  const today = async (ready, coin) => (await open({ ready, coin })).text("#today-list") || "";
  const EARLIER = /Your earlier design is kept/;
  // (a) their own choice, still the design row, with a new version since (a renamed region, or the S1R-3 stale ticker): never "earlier"
  for (const coin of [{ ...COIN, description: "The city coin of Utica, New York State, United States." }, { ...COIN, ticker: "UTICA2" }]) {
    const t = await today(view({ coin: { ...coin, art: ART, contentHash: "c".repeat(64), version: "cccccccc" }, chosen: CHOSEN, inUse: false, earlier: false, preview: null }), readyRow({ chosen: coin.ticker === "UTICA" }));
    assert.match(t, /Choose Utica's coin again/);
    assert.match(t, /Vicinity's design or the city list changed since you chose\. Check the new version, then use it\./);
    assert.doesNotMatch(t, EARLIER);
  }
  // (b) a former founder's choice, looked at by the new founder (who never designed anything)
  const b = await today(view({ chosen: { ...CHOSEN, mine: false }, inUse: false, earlier: false, preview: null }), readyRow());
  assert.match(b, /Choose Utica's coin/);
  assert.match(b, /A former founder chose this coin\. Use it to make it yours\./);
  assert.doesNotMatch(b, EARLIER);
  // (c) their own choice whose design row changed since
  const c = await today(view({ chosen: { ...CHOSEN, current: false }, inUse: false, earlier: true, preview: null }), readyRow({ madeBy: undefined, name: "Utica Coin" }));
  assert.match(c, /Your coin's design was changed since you chose it\. Check it, then use it again\./);
  assert.doesNotMatch(c, EARLIER);
  // (d) an earlier studio design, kept aside by the server (earlier): said as that
  const d = await today(view({ chosen: null, inUse: false, earlier: true, preview: null }), readyRow({ madeBy: undefined, name: "Utica Coin", pitch: "The Handshake City." }));
  assert.match(d, /Choose Utica's coin/);
  assert.match(d, /Your earlier design is kept, but city coins are made by Vicinity now\. Check yours, then use it\./);
  // (e) no design at all: the coin is ready
  const e = await today(view({ chosen: null, inUse: false, earlier: false }), null);
  assert.match(e, /Utica's coin is ready/);
  assert.match(e, /The Vicinity design with your city's ticker, from the city list\. Check it, then use it\./);
  // in use: no line
  assert.doesNotMatch(await today(view({ chosen: CHOSEN, inUse: true, preview: null }), readyRow()), /Choose Utica's coin|coin is ready/);
});

test("FS1-2: a FORMER founder's studio design (earlierOther) is never 'your earlier design' to the new founder, on the Today line or the card", async () => {
  const EARLIER = /Your earlier (coin )?design/;
  const FORMER_TODAY = /A former founder's design is kept, but city coins are made by Vicinity now\. Check this coin, then use it\./;
  const FORMER_CARD = "A former founder's coin design is kept, but it is not launched: city coins are made by Vicinity now. Use this coin to choose yours.";
  // (a) nothing chosen; the design row is the former founder's studio design (the common live case after a seat change)
  const a = await open({ ready: view({ chosen: null, inUse: false, earlier: false, earlierOther: true }), coin: readyRow({ madeBy: undefined, name: "Utica Coin", pitch: "The Handshake City." }) });
  const ta = a.text("#today-list") || "";
  assert.match(ta, /Choose Utica's coin/);
  assert.match(ta, FORMER_TODAY);
  assert.doesNotMatch(ta, EARLIER);
  assert.equal(a.text("#cr-note"), FORMER_CARD);
  // (b) a former founder's choice whose design row changed since: never "your coin's design was changed since you chose it"
  const b = await open({ ready: view({ chosen: { ...CHOSEN, current: false, mine: false }, inUse: false, earlier: false, earlierOther: true }), coin: readyRow({ madeBy: undefined, name: "Utica Coin" }) });
  const tb = b.text("#today-list") || "";
  assert.match(tb, FORMER_TODAY);
  assert.doesNotMatch(tb, /since you chose it|Your earlier design/);
  assert.equal(b.text("#cr-note"), FORMER_CARD);
  // (c) the founder's OWN earlier design (earlier) is still said as theirs
  const c = await open({ ready: view({ chosen: null, inUse: false, earlier: true, earlierOther: false }), coin: readyRow({ madeBy: undefined, name: "Utica Coin", pitch: "The Handshake City." }) });
  assert.match(c.text("#today-list") || "", /Your earlier design is kept, but city coins are made by Vicinity now\. Check yours, then use it\./);
  assert.match(c.text("#cr-note"), /^Your earlier coin design is kept, but it is not launched/);
});

test("FS1-1: after a seat change, the new founder's coin card never calls a former founder's choice 'the coin you chose'", async () => {
  const preview = { label: "Preview, not launched", ticker: "UTICA", name: "Utica", description: COIN.description, chosen: true, version: HASH.slice(0, 8), city: CITY, art: ART };
  // the server's preview.chosen is true for the city's current choice, whoever's seat made it; chosen.mine says whose
  const p = await open({ ready: view({ chosen: { ...CHOSEN, mine: false }, inUse: false, preview }), coin: readyRow() });
  assert.equal(p.$("#coin-preview").hidden, false);
  assert.equal(p.text("#coin-preview-note"), "A former founder of this city chose this coin: use it in your Founder tab to make it yours. Nothing has launched yet.");
  assert.doesNotMatch(p.text("#coin-preview-note"), /coin you chose/);
  assert.match(p.text("#cr-note"), /^A former founder of this city chose this coin\./, "the card and the coin card agree");
  // their own choice, in use: as before
  const own = await open({ ready: view({ chosen: CHOSEN, inUse: true, preview }), coin: readyRow() });
  assert.equal(own.text("#coin-preview-note"), "This is the coin you chose. Nothing has launched yet.");
  // approved for them: as before
  const ap = await open({ ready: view({ chosen: CHOSEN, inUse: true, preview, gate: { code: "approved", message: "Your coin is approved on the blockchain with its current design. It launches exactly as approved." } }), coin: readyRow() });
  assert.equal(ap.text("#coin-preview-note"), "This is your city coin, approved on the blockchain. It has not launched yet.");
});

test("N-new-1: the founder's own coin, approved on chain or being approved, is tagged as theirs, never 'Not available now'", async () => {
  const preview = { label: "Preview, not launched", ticker: "UTICA", name: "Utica", chosen: true, city: CITY, art: ART };
  const ap = await open({ ready: view({ chosen: CHOSEN, inUse: true, preview, gate: { code: "approved", message: "Your coin is approved on the blockchain with its current design. It launches exactly as approved." } }), coin: readyRow() });
  assert.deepEqual([ap.text("#cr-state"), ap.$("#cr-state").className], ["Approved", "tag tag--ok"]);
  const held = await open({ ready: view({ chosen: CHOSEN, inUse: true, preview, gate: { code: "held", message: "The owner is approving your coin right now, so its design is fixed for a few minutes. Try again in 5 minutes." } }), coin: readyRow() });
  assert.deepEqual([held.text("#cr-state"), held.$("#cr-state").className], ["Your coin", "tag tag--ok"]);
  // any other gate (or an approval that is not this founder's coin): as before
  const low = await open({ ready: view({ chosen: CHOSEN, inUse: true, gate: { code: "below_amount", message: "Your balance is below the founder amount." } }), coin: readyRow() });
  assert.equal(low.text("#cr-state"), "Not available now");
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
  // S1R-3 / F1: a choice the city list moved away from (chosen: false) is not called chosen
  assert.deepEqual(plain(P.statusLabel({ status: "designed", madeBy: "vicinity", chosen: true })), ["Chosen", ""]);
  assert.deepEqual(plain(P.statusLabel({ status: "designed", madeBy: "vicinity", chosen: false, founder: { handle: "SwiftHarbor10", wallet: "7Np4…4K2", status: "active" } })), ["Not chosen yet", ""]);
  assert.deepEqual(plain(P.statusLabel({ status: "designed", madeBy: "vicinity", chosen: false, founder: null })), ["Not launched", ""]);
  assert.deepEqual(plain(P.statusLabel({ status: "live", madeBy: "vicinity", chosen: true })), ["Live", "tag--ok"]);
  assert.equal(P.TAB_NOTE_READY.upcoming, "Upcoming: chosen or designed, not launched yet.");
  // the built page: with the switch off the sentence reads exactly as before (the second wording hidden)
  assert.match(LP_HTML, /the others are <span data-designed-copy>designed and waiting<\/span><span data-ready-copy hidden>chosen or designed, not launched yet<\/span>\./);
  // the page: the note, the filter and the sentence follow readyOn (/api/official coinV2Ready, read before the first card is drawn)
  assert.match(LP_SRC, /\$\("#lp-tabnote"\)\.textContent = \(readyOn && TAB_NOTE_READY\[state\.tab\]\) \|\| \(lpOn && TAB_NOTE_LP\[state\.tab\]\) \|\| TAB_NOTE\[state\.tab\];/);
  assert.match(LP_SRC, /if \(readyOn\) for \(const o of \$\$\("#lp-status option"\)\) if \(o\.value === "designed"\) o\.textContent = "Chosen or designed";\n\s+for \(const e of \$\$\("\[data-designed-copy\]"\)\) e\.hidden = readyOn;\n\s+for \(const e of \$\$\("\[data-ready-copy\]"\)\) e\.hidden = !readyOn;/);
});
