// The ready-made city coin on the real dashboard (COIN_V2_READY=on) against the stage 1 review: the keyboard stays on the action while it
// saves and lands on the card after; a ticker never breaks inside at 360 px and the facts read as text, not inputs; the founder's preview
// stands in only for the coin that launches; with the launchpad set up (as in production) nothing sends a founder to the closed studio,
// and the Founder card points at "Use this coin" first; a city with no founder is not told someone will choose; the words follow the choice.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { ADDR, memberMe, openDashboard } from "./helpers/dashpage.js";

const CSS = readFileSync(new URL("../public/coin-ready.css", import.meta.url), "utf8");
const LP_LAUNCH = readFileSync(new URL("../public/lp-launch.js", import.meta.url), "utf8");
const HASH = "3f9a2c1b" + "a".repeat(56), ART = `/coin-meta/art/${"b".repeat(64)}.png`;
const CITY = { id: "5142056", name: "Utica", region: "New York", regionCode: "NY", country: "US", countryName: "United States" };
const COIN = { ticker: "UTICA", name: "Utica", description: "The city coin of Utica, New York, United States.", pair: "SOL", templateVersion: "t1", source: "Vicinity city list" };
const PREVIEW = (over = {}) => ({ label: "Preview, not launched", ticker: "UTICA", name: "Utica", description: COIN.description, chosen: false, city: { name: "Utica", region: "New York", countryName: "United States" }, art: ART, ...over });
const view = (over = {}) => ({ ok: true, mode: "founder", city: CITY, coin: { ...COIN, art: ART, contentHash: HASH, version: HASH.slice(0, 8) }, chosen: null, inUse: false, earlier: false, gate: null, preview: PREVIEW(), ...over });
const CHOSEN = { contentHash: HASH, version: HASH.slice(0, 8), at: "2026-10-18T10:00:00Z", current: true, art: ART, launched: false, ticker: "UTICA", name: "Utica", mine: true };
const designRow = (over = {}) => ({ ok: true, coin: { city: "5142056", cityName: "Utica", country: "US", name: "Utica Coin", pitch: "", pair: "USDC", pairMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", color: "gold", logo: null, mint: null, launched: false, waiting: false, by: "SwiftHarbor10", updatedAt: "2026-10-09T12:00:00Z", ...over }, pairs: null, vicinity: null });

function founderMe() {
  const me = memberMe({ wallet: ADDR, launched: true, amount: 2_000_000, rank: 3 });
  const seat = { id: 7, cityId: "5142056", city: "Utica", country: "US", status: "active", since: "2026-10-01T12:00:00Z", appealUntil: null, graceUntil: null, probationUntil: null, threshold: 100000, policy: 5 };
  me.roles.founder = true; me.level = "founder";
  me.founder.seat = seat;
  me.community.seat = { id: 7, status: "active", name: "SwiftHarbor10", wallet: "7Np41*****4K2", since: seat.since, appealUntil: null, graceUntil: null, probationUntil: null, you: true, openObjections: 0, threshold: 100000, policy: 5, cofounders: [], quorum: null };
  me.coinV2Ready = true;
  return me;
}
/** The dashboard; `lp`: the launchpad set up (as in production): /api/official cityCoins, the probe and a not-approved status. */
async function open({ me = founderMe(), ready, coin, lp = false, extra }) {
  const page = await openDashboard({
    me,
    official: lp ? { ok: true, cityCoins: { cluster: "mainnet" } } : { ok: true },
    api: async (path, body) => {
      if (path.startsWith("/api/coins/ready?")) return typeof ready === "function" ? ready() : ready;
      if (extra) { const x = await extra(path, body); if (x !== undefined) return x; }
      if (path.startsWith("/api/lp/")) return !lp ? { ok: false, error: "not_enabled", _status: 404 } : path.includes("city=") ? { ok: true, cluster: "mainnet", state: "not_approved", message: "An admin approves your coin on chain first; your pair must be SOL." } : { ok: true, on: true, cluster: "mainnet", configsSet: true, speedTable: true };
      if (path.startsWith("/api/coins?city=") && coin) return coin;
      return undefined;
    },
  });
  if (lp) {
    page.win.LP = { supported: async () => true, say: (c, x) => (x && x.message) || c, renderSummary() {}, prepare: async () => { throw new Error("not in this test"); } };
    vm.runInContext(LP_LAUNCH, page.win, { filename: "public/lp-launch.js" });
  }
  await page.advance(61_000);
  await page.flush(60);
  return page;
}

test("the keyboard stays on Use this coin while it saves (aria-disabled, its name says so), then lands on the card's state; a refusal keeps it on the button", async () => {
  let release, outcome = "ok", chosen = false;
  const chosenView = () => view({ inUse: true, chosen: CHOSEN, preview: PREVIEW({ chosen: true }) });
  const page = await open({ ready: () => (chosen ? chosenView() : view()), extra: async (path) => {
    if (path !== "/api/coins/ready/use") return undefined;
    await new Promise((r) => { release = r; });
    if (outcome !== "ok") return { ok: false, error: "slow_down", _status: 429 };
    chosen = true;
    return { ...chosenView(), used: true };
  } });
  page.win.VDash.go("founder"); await page.flush(10); // the card is in the Founder tab
  const use = page.$("#cr-use");
  use.focus();
  assert.equal(page.doc.activeElement, use);
  use.click(); await page.flush(10);
  assert.equal(page.doc.activeElement, use, "while saving, the focus stays on the button (not dropped to the page)");
  assert.deepEqual([use.disabled, use.getAttribute("aria-disabled"), use.textContent, use.getAttribute("aria-label")], [false, "true", "Saving…", "Saving your choice…"]);
  use.click(); await page.flush(5); // a second press while saving is ignored
  assert.equal(page.calls.filter((c) => c.path === "/api/coins/ready/use").length, 1);
  release(); await page.advance(200);
  assert.equal(use.hidden, true);
  assert.equal(page.doc.activeElement, page.$("#cr-state"), "the keyboard lands on the card's state, never back at the top of the page");
  assert.equal(page.text("#cr-state"), "Your coin");
  // a refusal: the keyboard stays on the action, next to its words
  outcome = "no";
  const page2 = await open({ ready: () => view(), extra: async (path) => {
    if (path !== "/api/coins/ready/use") return undefined;
    await new Promise((r) => { release = r; });
    return { ok: false, error: "slow_down", _status: 429 };
  } });
  page2.win.VDash.go("founder"); await page2.flush(10);
  const use2 = page2.$("#cr-use");
  use2.focus(); use2.click(); await page2.flush(10);
  release(); await page2.advance(200);
  assert.equal(page2.doc.activeElement, use2);
  assert.equal(use2.getAttribute("aria-disabled"), null);
  assert.equal(page2.$("#cr-err").hidden, false);
});

test("the facts read as text: no filled boxes; the lock caption right under the place; the ticker alone in its cell, never broken, a whole row on phones", () => {
  const facts = CSS.match(/\.coin-ready__facts > div \{[^}]*\}/)[0];
  assert.doesNotMatch(facts, /background|border-radius|border: 1px/, "no filled, bordered boxes");
  assert.match(facts, /border-bottom: 1px solid/);
  assert.match(CSS, /\.coin-ready__facts dd strong \{[^}]*white-space: nowrap;/, "a ticker is never broken inside");
  assert.match(CSS, /@media \(max-width: 440px\) \{ \.coin-ready__ticker \{ grid-column: 1 \/ -1; \} \}/, "on a phone the ticker has the whole row");
  const html = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");
  const card = html.slice(html.indexOf('id="coin-ready"'), html.indexOf("</section>", html.indexOf('id="coin-ready"')));
  assert.ok(card.indexOf("coin-ready__caption") < card.indexOf("coin-ready__facts"), "the lock caption sits under the place line, above the facts");
  assert.match(card, /<div class="coin-ready__ticker"><dt>Ticker<\/dt><dd><strong id="cr-ticker">\$—<\/strong><\/dd><\/div>/, "nothing else in the ticker's cell");
  assert.match(card, /<span class="tag" id="cr-state" tabindex="-1">/);
});

test("the founder's preview stands in only for the coin that launches: a waiting LaunchLab contract (or any gate) leaves the coin card as it was", async () => {
  const page = await open({ ready: view({ gate: { code: "legacy_contract", message: "A contract for this city is waiting for a check. Nothing can launch until that's settled." }, preview: PREVIEW() }),
    coin: designRow({ pair: "SOL", waiting: true }) });
  assert.equal(page.$("#coin-preview").hidden, true, "no 'Preview, not launched' over a city that may already have a LaunchLab coin");
  assert.equal(page.text("#coin-status"), "Contract being checked");
  assert.doesNotMatch(page.text("#coin") || "", /nothing has launched yet/);
  // approved with the chosen coin: that IS the coin that launches, and the note says so
  const p2 = await open({ ready: view({ inUse: true, chosen: CHOSEN, gate: { code: "approved", message: "Your coin is approved on the blockchain with its current design. It launches exactly as approved." }, preview: PREVIEW({ chosen: true }) }), coin: designRow({ name: "Utica", pair: "SOL" }) });
  assert.equal(p2.$("#coin-preview").hidden, false);
  assert.equal(p2.text("#coin-preview-note"), "This is your city coin, approved on the blockchain. It has not launched yet.");
  assert.match(p2.text("#cr-gate"), /It launches exactly as approved\.$/);
});

test("the launchpad set up (production): the launch card and the Founder card send a founder to Use this coin, never to the studio", async () => {
  // a founder with an earlier studio design paired with USDC, not chosen
  const page = await open({ lp: true, coin: designRow(), ready: view({ earlier: true }) });
  const launch = page.text("#lp-launch") || "";
  assert.doesNotMatch(launch, /coin studio/, "the studio is closed while the switch is on");
  // the launch card is below the coin card, the Founder card above it (dashboard-v2.js ORDER.founder): each points the right way (FS1-3)
  assert.match(launch, /Choose your city coin above \(Use this coin\); then Vicinity's owner approves it on the blockchain\./);
  assert.equal(page.text("#fcard-note"), "Choose your city coin below (Use this coin); then Vicinity's owner approves it on the blockchain.");
  const founder = [...page.$("#panel-founder").children].map((n) => n.id);
  assert.ok(founder.indexOf("fcard") < founder.indexOf("coin-ready") && founder.indexOf("coin-ready") < founder.indexOf("lp-launch"), founder.join(","));
  assert.equal(page.text("#fcard-go"), "See your city coin");
  assert.match(page.text("#cr-note"), /Your earlier coin design is kept, but it is not launched/);
  assert.match(page.text("#today-list") || "", /Choose Utica's coin/);
  // once the coin is chosen: the launch's own words (an admin approves it)
  const chosen = await open({ lp: true, coin: designRow({ name: "Utica", pair: "SOL" }), ready: view({ inUse: true, chosen: CHOSEN, preview: PREVIEW({ chosen: true }) }) });
  assert.match(chosen.text("#fcard-note"), /An admin approves your coin on chain first/);
  assert.doesNotMatch(chosen.text("#lp-launch") || "", /coin studio|Use this coin/);
  // no design at all: no studio line either
  const none = await open({ lp: true, ready: view() });
  assert.doesNotMatch(none.text("#lp-launch") || "", /coin studio/);
  assert.match(none.text("#fcard-note"), /Utica's coin is ready: the Vicinity design with its ticker, from the city list\. Check it, then use it\./);
});

test("a city the list has no ticker for: no 'coin is ready' line anywhere; the Founder card says why", async () => {
  const msg = "This city isn't in the Vicinity city list yet, so it has no registered ticker. Tell us and we'll add it.";
  const page = await open({ ready: { ok: true, mode: "founder", city: { id: "5142056", name: "Utica", country: "US" }, coin: null, chosen: null, inUse: false, earlier: false, gate: { code: "no_ticker", message: msg }, preview: null } });
  assert.doesNotMatch(page.text("#today-list") || "", /coin is ready/);
  assert.equal(page.text("#fcard-note"), msg);
});

test("with the switch on, nobody is told the founder designs the coin: the role panel, the roles list, the community card, the City header", async () => {
  const page = await open({ ready: view() });
  // the roles list: the line the switch speaks is shown, the founder-designs line hidden
  const designed = page.$("[data-coin-designed]"), ready = page.$("[data-coin-ready]");
  assert.deepEqual([designed.hidden, ready.hidden], [true, false]);
  assert.match(ready.textContent, /^Choose the city's coin: made by Vicinity from the city list/);
  // the switch off: the roles list exactly as before
  const offMe = founderMe(); delete offMe.coinV2Ready;
  const off = await open({ me: offMe, ready: view() });
  assert.deepEqual([off.$("[data-coin-designed]").hidden, off.$("[data-coin-ready]").hidden], [false, true]);
  assert.match(page.text("#role-home") || page.text("body"), /choose and launch its coin \(made by Vicinity from the city list\)/);
  assert.match(page.text("#cc-fomo"), /check and use Utica's coin/);
  // a member of a city with no founder: the header does not say "Ready to choose" (nobody can)
  const me = memberMe({ wallet: ADDR });
  me.coinV2Ready = true;
  const m = await open({ me, ready: { ok: true, mode: "preview", preview: null } });
  assert.match(m.text("#ch-coin-v") || "", /No founder yet/);
  assert.doesNotMatch(m.text("#ch-coin-v") || "", /Ready to choose/);
});

test("the preview keeps the coin card once the launchpad answers: no 'Not chosen yet' status or 'ready in your Founder tab' line under it", async () => {
  // production order: /api/coins, then the preview painted, then the launchpad probe answers and the coin card is drawn again
  for (const lp of [true, false]) {
    const page = await open({ lp, ready: view() });
    assert.equal(page.$("#coin-preview").hidden, false, `the preview stands in (launchpad ${lp})`);
    assert.equal(page.text("#coin-status"), "Not launched", `the card's status is the preview's (launchpad ${lp})`);
    assert.equal(page.text("#coin-note"), "", `no second line under the preview (launchpad ${lp})`);
    assert.equal(page.text("#coin-kicker"), "City coin · made by Vicinity");
    assert.equal(page.text("#coin-preview-note"), "This is what $UTICA will look like. You choose it in your Founder tab; nothing has launched yet.");
  }
  // no preview (a gate): the coin card's own words, as before
  const gated = await open({ lp: true, ready: view({ gate: { code: "ticker_taken", message: "Another coin already uses $UTICA." } }) });
  assert.equal(gated.$("#coin-preview").hidden, true);
  assert.equal(gated.text("#coin-status"), "Not chosen yet");
  assert.match(gated.text("#coin-note"), /coin is ready in your Founder tab/);
});

test("a review pause (COIN_V2_REVIEW) is said in the Founder card as the launch status says it, never 'launches are paused' nor 'opens after the next round'", async () => {
  const msg = "Launch is paused while your change request is reviewed. Cancelling the request ends the pause.";
  const status = (why, message) => async (path) => (path.startsWith("/api/lp/launch/status?city=") ? { ok: true, cluster: "mainnet", state: "paused", why, message } : undefined);
  const page = await open({ lp: true, coin: designRow({ name: "Utica", pair: "SOL" }), ready: view({ inUse: true, chosen: CHOSEN, preview: PREVIEW({ chosen: true }) }), extra: status("paused_request", msg) });
  assert.equal(page.text("#fcard-note"), msg);
  assert.match(page.text("#lp-launch") || "", /Launch is paused while your change request is reviewed/);
  // the owner's own pause keeps its words
  const owner = await open({ lp: true, coin: designRow({ name: "Utica", pair: "SOL" }), ready: view({ inUse: true, chosen: CHOSEN, preview: PREVIEW({ chosen: true }) }), extra: status("launches_paused", "Launches are paused for now. Your approval stays; try again later.") });
  assert.equal(owner.text("#fcard-note"), "Launches are paused for now. Your approval stays.");
});
