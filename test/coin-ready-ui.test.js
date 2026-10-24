// The ready-made city coin on the real dashboard (public/coin-ready.js through dashboard.js and dashboard-v2.js; COIN_V2_READY=on): with the
// switch off the page never asks for it and the studio is as before; on, the founder's Founder tab shows the coin read-only with ONE action,
// the picture is asked for once, "Use this coin" sends the exact version shown; a gate disables the action with its words; a member sees the
// preview labelled "Preview, not launched"; nothing is built from text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADDR, memberMe, openDashboard } from "./helpers/dashpage.js";

const JS = readFileSync(new URL("../public/coin-ready.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../public/coin-ready.css", import.meta.url), "utf8");
const HASH = "3f9a2c1b" + "a".repeat(56), ART = `/coin-meta/art/${"b".repeat(64)}.png`;
const CITY = { id: "5142056", name: "Utica", region: "New York", regionCode: "NY", country: "US", countryName: "United States" };
const COIN = { ticker: "UTICA", name: "Utica", description: "The city coin of Utica, New York, United States.", pair: "SOL", templateVersion: "t1", source: "Vicinity city list" };
const PREVIEW = (over = {}) => ({ label: "Preview, not launched", ticker: "UTICA", name: "Utica", description: COIN.description, chosen: false, city: { name: "Utica", region: "New York", countryName: "United States" }, art: null, ...over });
const founderView = (over = {}) => ({ ok: true, mode: "founder", city: CITY, coin: { ...COIN, art: null, contentHash: null, version: null }, chosen: null, inUse: false, earlier: false, gate: null, preview: PREVIEW(), ...over });
const drawn = (over = {}) => founderView({ coin: { ...COIN, art: ART, contentHash: HASH, version: HASH.slice(0, 8) }, preview: PREVIEW({ art: ART }), ...over });
const CHOSEN = { contentHash: HASH, version: HASH.slice(0, 8), at: "2026-10-18T10:00:00Z", current: true, art: ART, launched: false, ticker: "UTICA", name: "Utica", mine: true };

function founderMe({ ready = true } = {}) {
  const me = memberMe({ wallet: ADDR, launched: true, amount: 2_000_000, rank: 3 });
  const seat = { id: 7, cityId: "5142056", city: "Utica", country: "US", status: "active", since: "2026-10-01T12:00:00Z", appealUntil: null, graceUntil: null, probationUntil: null, threshold: 100000, policy: 5 };
  me.roles.founder = true; me.level = "founder";
  me.founder.seat = seat;
  me.community.seat = { id: 7, status: "active", name: "SwiftHarbor10", wallet: "7Np41*****4K2", since: seat.since, appealUntil: null, graceUntil: null, probationUntil: null, you: true, openObjections: 0, threshold: 100000, policy: 5, cofounders: [], quorum: null };
  if (ready) me.coinV2Ready = true;
  return me;
}

test("switch off: the page never asks for the ready coin (no script, no request); the studio and the coin card are as before", async () => {
  const page = await openDashboard({ me: founderMe({ ready: false }) });
  await page.advance(1000);
  assert.equal(page.calls.filter((c) => c.path.startsWith("/api/coins/ready")).length, 0);
  assert.equal(page.$("#coin-ready").hidden, true);
  assert.equal(page.$("#coin-preview").hidden, true);
  assert.equal(page.$("#coin-studio").hidden, false, "the founder's studio, as before");
  assert.ok(!page.doc.querySelectorAll('link[rel="stylesheet"]').some((l) => /coin-ready/.test(l.getAttribute("href") || "")), "no stylesheet either");
});

test("switch on, the founder: the coin read-only in the Founder tab, one action; the picture asked for once; Use this coin sends the exact version", async () => {
  const posts = [];
  let view = founderView();
  const page = await openDashboard({
    me: founderMe(),
    api: async (path, body) => {
      if (path.startsWith("/api/coins/ready?")) return view;
      if (path === "/api/coins/ready/art") { posts.push(["art", body]); view = drawn(); return view; }
      if (path === "/api/coins/ready/use") { posts.push(["use", body]); view = drawn({ inUse: true, chosen: CHOSEN, preview: PREVIEW({ art: ART, chosen: true, version: HASH.slice(0, 8) }), used: true }); return view; }
      return undefined;
    },
  });
  await page.advance(1000);
  const card = page.$("#coin-ready");
  assert.equal(card.hidden, false);
  assert.equal(card.parentNode.id, "panel-founder", "the tabbed dashboard puts it in the Founder tab");
  assert.equal(page.$("#coin-studio").hidden, true, "the old studio is closed while the switch is on");
  assert.equal(page.text("#fcard-coin"), "Ready to choose", "nobody designs a coin any more: the founder card says so");
  assert.deepEqual(posts, [["art", { cityId: "5142056" }]], "the picture is asked for once, by the founder's page");
  assert.deepEqual([page.text("#cr-ticker"), page.text("#cr-name"), page.text("#cr-city"), page.text("#cr-region"), page.text("#cr-country"), page.text("#cr-pair"), page.text("#cr-desc")],
    ["$UTICA", "Utica", "Utica", "New York", "United States", "SOL", "The city coin of Utica, New York, United States."]);
  assert.equal(page.text("#cr-place"), "Utica · New York · United States");
  assert.equal(page.$("#cr-art").getAttribute("src"), ART);
  assert.equal(page.$("#cr-art").alt, "$UTICA coin: the Vicinity city coin design");
  assert.equal(page.text("#cr-version"), `Design version ${HASH.slice(0, 8)}`);
  assert.match(page.text(".coin-ready__caption"), /Set by Vicinity\. Every city coin uses the same Vicinity design, filled in from the Vicinity city list, so nothing here can be edited\./);
  assert.equal(page.$$("#coin-ready input, #coin-ready textarea, #coin-ready select").length, 0, "nothing to type in: read-only facts");
  assert.equal(page.$$("#coin-ready button").length, 1, "one action");
  const use = page.$("#cr-use");
  assert.deepEqual([use.disabled, use.textContent, page.text("#cr-state")], [false, "Use this coin", "Ready to choose"]);
  // the preview in the city's coin card, labelled
  assert.equal(page.$("#coin-preview").hidden, false);
  assert.equal(page.text("#coin-preview-tag"), "Preview, not launched");
  await page.tap(use);
  await page.advance(100);
  assert.deepEqual(posts[1], ["use", { cityId: "5142056", contentHash: HASH }], "exactly the version on screen");
  assert.deepEqual([page.text("#cr-state"), use.hidden], ["Your coin", true]);
  assert.match(page.text("#cr-note"), /This is your coin's design now\. Next, Vicinity's owner approves it on the blockchain/);
  assert.equal(page.text("#coin-preview-note"), "This is the coin you chose. Nothing has launched yet.", "the City tab's note follows the choice");
  assert.ok(page.toasts.includes("$UTICA is your coin"));
  assert.ok(page.calls.filter((c) => c.path.startsWith("/api/coins?city=")).length >= 2, "the coin card reads the new design");
});

test("a gate says why and keeps the action off (no picture drawn); a changed version is shown before anything is used", async () => {
  const gated = drawn({ gate: { code: "legacy_contract", message: "A contract for this city is waiting for a check. Nothing can launch until that's settled." } });
  let page = await openDashboard({ me: founderMe(), api: async (p) => (p.startsWith("/api/coins/ready?") ? { ...gated, coin: { ...gated.coin, art: null, contentHash: null, version: null } } : undefined) });
  await page.advance(1000);
  assert.equal(page.$("#cr-gate").hidden, false);
  assert.match(page.text("#cr-gate"), /waiting for a check/);
  assert.equal(page.$("#cr-use").disabled, true);
  assert.equal(page.text("#cr-state"), "Not available now");
  assert.equal(page.calls.filter((c) => c.path === "/api/coins/ready/art").length, 0, "no picture is drawn for a coin that cannot be used");
  // the city list moved under the page: the server answers coin_changed with the current version, shown before any second try
  const NEW = "9" + HASH.slice(1);
  page = await openDashboard({ me: founderMe(), api: async (p) => {
    if (p.startsWith("/api/coins/ready?")) return drawn();
    if (p === "/api/coins/ready/use") return { ...drawn({ coin: { ...COIN, art: ART, contentHash: NEW, version: NEW.slice(0, 8) } }), ok: false, error: "coin_changed", _status: 409 };
    return undefined;
  } });
  await page.advance(1000);
  await page.tap(page.$("#cr-use"));
  await page.advance(100);
  assert.equal(page.$("#cr-err").hidden, false);
  assert.match(page.text("#cr-err"), /Your coin changed since this page loaded/);
  assert.equal(page.text("#cr-version"), `Design version ${NEW.slice(0, 8)}`);
  assert.equal(page.$("#cr-use").disabled, false, "the new version can be checked and used");
});

test("a member of a city with a founder sees the preview labelled; without a founder (or off) the coin card is as before", async () => {
  const me = memberMe({ wallet: ADDR });
  me.coinV2Ready = true;
  let preview = PREVIEW({ art: ART });
  let page = await openDashboard({ me, api: async (p) => (p.startsWith("/api/coins/ready?") ? { ok: true, mode: "preview", preview } : undefined) });
  await page.advance(1000);
  assert.equal(page.$("#coin-ready").hidden, true, "the founder's card is the founder's");
  assert.equal(page.$("#coin-preview").hidden, false);
  assert.deepEqual([page.text("#coin-preview-tag"), page.text("#coin-preview-ticker"), page.text("#coin-preview-name")], ["Preview, not launched", "$UTICA", "Utica · New York · United States"]);
  assert.match(page.text("#coin-preview-note"), /once Utica's founder launches it.*nothing has launched yet/);
  assert.equal(page.$("#coin-preview-art").getAttribute("src"), ART);
  assert.equal(page.text("#coin-status"), "Not launched");
  assert.equal(page.text("#coin-kicker"), "City coin · made by Vicinity", "the eyebrow says who made what the card shows");
  assert.equal(page.calls.filter((c) => c.path === "/api/coins/ready/art").length, 0, "a member never asks for a picture");
  preview = null;
  page = await openDashboard({ me, api: async (p) => (p.startsWith("/api/coins/ready?") ? { ok: true, mode: "preview", preview } : undefined) });
  await page.advance(1000);
  assert.equal(page.$("#coin-preview").hidden, true);
  assert.notEqual(page.text("#coin-status"), "Not launched");
  // no preview and no design (here: a city with no founder): with the switch on, the card says who makes the coin now, never that a
  // founder designs it
  assert.equal(page.text("#coin-kicker"), "City coin · made by Vicinity");
  assert.equal(page.text("#coin-status"), "No founder yet");
  assert.equal(page.text("#coin-note"), "Every city coin is made by Vicinity from the city list; the founder chooses it and launches it once Vicinity's owner approves it on the blockchain. The seat is still open: see the founder path.");
  assert.doesNotMatch(page.text("#coin") || "", /designs this coin|hasn't designed/);
  // the switch off: the card exactly as before
  const off = memberMe({ wallet: ADDR });
  page = await openDashboard({ me: off });
  await page.advance(1000);
  assert.equal(page.text("#coin-kicker"), "City coin · designed by the City Founder");
  assert.equal(page.text("#coin-status"), "Not designed yet");
  assert.match(page.text("#coin-note"), /founder designs this coin: its name, logo, colour and what it's paired with/);
});

test("coin-ready.js builds nothing from text, asks only its own routes, loads its own stylesheet; the CSS has no outside host", () => {
  assert.doesNotMatch(JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  const paths = [...JS.matchAll(/"(\/api\/[^"?]+)/g)].map((m) => m[1]).concat([...JS.matchAll(/`(\/api\/[^`?$]+)/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(paths)].sort(), ["/api/coins/ready", "/api/coins/ready/art", "/api/coins/ready/use"]);
  assert.match(JS, /setAttribute\("href", "\/coin-ready\.css"\)/);
  assert.doesNotMatch(CSS, /@import|url\(\s*["']?https?:/);
  assert.match(CSS, /min-height: 48px/, "a 48 px action");
});
