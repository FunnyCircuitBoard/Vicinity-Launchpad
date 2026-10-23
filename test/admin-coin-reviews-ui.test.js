// The admin's "Coin reviews" queue (public/admin.js; COIN_V2_REVIEW=on, src/coinreview.js) in the just-enough DOM: with the switch off
// (no coinReviews on /api/admin/me) the page never asks for it and Moderation and the Overview are exactly as before; on, the queue sits
// in Moderation with its count, each request shows its version and full hash, what changes (pictures side by side), the checks the
// server ran and the founder's why; admins approve that exact version (the hash goes back) or ask for changes with a reason and an
// optional note, each behind a question; moderators look only; approved tickers waiting for the city list show the line to add.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { openPage } from "./helpers/pagedom.js";

const ADMIN_JS = readFileSync(new URL("../public/admin.js", import.meta.url), "utf8");
const CHARTS_JS = readFileSync(new URL("../public/admin-charts.js", import.meta.url), "utf8");
const tick = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const W = "Own3r1111111111111111111111111111111111111";
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const HASH = "3f9a2c1b" + "a".repeat(56);
const REVIEWS = {
  ok: true, pending: 1,
  reasons: [{ code: "ticker_taken", text: "That ticker already belongs to another city or is reserved." }, { code: "name_misleading", text: "The name could be mistaken for another city, a company, a public body or Vicinity." }],
  waitingRegistry: [{ id: 3, city: { id: "5140405", name: "Syracuse" }, ticker: "SALTCITY", registryPatch: { 5140405: "SALTCITY" } }],
  reviews: [
    { id: 7, kind: "change", status: "pending", label: "Pending", city: { id: "5142056", name: "Utica", region: "New York", country: "US", countryName: "United States" },
      founder: { handle: "uticafounder", wallet: "7Np41*****4K2" }, submittedAt: ago(90), decidedAt: null, version: HASH.slice(0, 8), contentHash: HASH,
      current: { name: "Utica", symbol: "UTICA", art: "/coin-meta/art/" + "b".repeat(64) + ".png" }, proposed: { name: "Utica Falls", symbol: "UTICANY", art: "/api/admin/coins/reviews/art?id=7", upload: true },
      diff: [{ field: "picture", from: "/coin-meta/art/" + "b".repeat(64) + ".png", to: "/api/admin/coins/reviews/art?id=7" }, { field: "ticker", from: "$UTICA", to: "$UTICANY" }, { field: "name", from: "Utica", to: "Utica Falls" }],
      checks: [{ check: "founder", ok: true, text: "The founder still holds the seat." }, { check: "name_screening", ok: false, text: "The checks flagged the name.", issues: [{ code: "staff", message: "This sounds like it comes from Vicinity or its staff. Only Vicinity speaks for Vicinity." }] }],
      why: "Locals call it the falls city.", decision: null, registryState: null, registryPatch: null },
    { id: 3, kind: "change", status: "approved", label: "Approved", city: { id: "5140405", name: "Syracuse", country: "US" }, founder: { handle: null, wallet: "Abcde*****xyz" }, submittedAt: ago(3000), decidedAt: ago(600),
      version: "77aa11bb", contentHash: "77aa11bb" + "c".repeat(56), current: null, proposed: null, diff: [], checks: [], why: null, decision: { reasonCode: null, reason: null, note: null },
      registryState: "waiting", registryPatch: { 5140405: "SALTCITY" } },
  ],
};

async function open(role, { reviews = true, hash = "#moderation" } = {}) {
  const page = await openPage("admin.html", { agreed: "2026-10-01" });
  const win = page.window, doc = page.doc, calls = [], posts = [];
  const A = {
    "/api/me": { ok: true, signedIn: true, user: { handle: "boss", wallet: W } },
    "/api/admin/me": { ok: true, wallet: W, role, ...(reviews ? { coinReviews: true } : {}) },
    "/api/admin/config": { ok: true, siteMode: "live", flags: {} },
    "/api/admin/lp": { ok: false, error: "not_enabled" },
    "/api/admin/overview": { ok: true, users: 10, seats: {}, openElections: 0, pendingReports: 0, pendingObjections: 0, pendingLogos: 0, registeredTokens: 0, launchedCityCoins: 0, snapshots: 0, latestSnapshot: null, ...(reviews ? { pendingCoinReviews: 1 } : {}) },
    "/api/admin/feedback/count": { ok: true, new: 0, counts: {} },
    "/api/official": { launchpadV2: false },
    "/api/admin/audit": { ok: true, audit: [] },
    "/api/admin/claims": { ok: true, claims: [] }, "/api/admin/reports": { ok: true, reports: [] }, "/api/admin/logos": { ok: true, waiting: 0, logos: [] },
    "/api/admin/objections": { ok: true, objections: [] }, "/api/admin/appeals": { ok: true, appeals: [] },
    "/api/admin/coins/reviews": REVIEWS,
    "/api/admin/coins/reviews/decide": { ok: true, id: 7, status: "approved" },
  };
  win.fetch = async (path, init = {}) => {
    const p = String(path).split("?")[0];
    calls.push(String(path));
    if (init && init.method === "POST") posts.push([p, JSON.parse(init.body || "{}")]);
    const body = A[p] ?? { ok: false, error: "not_found" };
    return { ok: body.ok !== false, status: body.ok === false ? 404 : 200, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  win.setTimeout = (fn) => { setImmediate(fn); return 0; };
  win.location = { hash, pathname: "/admin", href: `https://vicinity.test/admin${hash}` };
  win.VW = { list: () => [], isMobile: false, KNOWN: [], onChange() {}, safeIcon: () => null, mark: () => doc.createElement("span") };
  doc.createElementNS = (_ns, tag) => doc.createElement(tag);
  const asked = [];
  win.confirm = (m) => { asked.push(m); return true; };
  vm.runInContext(CHARTS_JS, win, { filename: "public/admin-charts.js" });
  vm.runInContext(ADMIN_JS, win, { filename: "public/admin.js" });
  await tick();
  return { doc, win, calls, posts, asked };
}

test("switch off: no queue, no count, no request for it; Moderation is as before", async () => {
  const t = await open("admin", { reviews: false });
  assert.equal(t.calls.some((c) => c.startsWith("/api/admin/coins/reviews")), false);
  assert.deepEqual(t.doc.querySelectorAll(".adm-subtab").map((b) => b.id), ["mod-tab-claims", "mod-tab-reports", "mod-tab-logos", "mod-tab-objections", "mod-tab-appeals"]);
});

test("switch on: the queue in Moderation with its count; version and full hash, what changes, the checks, the why; approve the exact version or ask for changes, each asked first", async () => {
  const t = await open("admin");
  assert.deepEqual(t.doc.querySelectorAll(".adm-subtab").map((b) => b.id), ["mod-tab-claims", "mod-tab-reports", "mod-tab-logos", "mod-tab-coinreviews", "mod-tab-objections", "mod-tab-appeals"]);
  assert.equal(t.doc.querySelector("#mod-tab-coinreviews .adm-count").textContent, "1");
  assert.equal(t.doc.querySelector("#mod-tab-coinreviews").getAttribute("aria-selected"), "true", "the first queue with something waiting");
  const card = t.doc.querySelectorAll(".adm-coinrev__item")[0];
  assert.match(card.textContent, /Change · Utica · New York · United States/);
  assert.match(card.textContent, /@uticafounder · 7Np41\*\*\*\*\*4K2 · waiting/);
  assert.equal(card.querySelector(".adm-coinrev__hash").textContent, HASH, "the full hash, to compare");
  const imgs = card.querySelectorAll("img");
  assert.deepEqual(imgs.map((i) => i.getAttribute("src") || i.src), ["/coin-meta/art/" + "b".repeat(64) + ".png", "/api/admin/coins/reviews/art?id=7"]);
  assert.deepEqual(imgs.map((i) => i.alt), ["Current picture of Utica's coin", "Proposed picture of Utica's coin"]);
  assert.match(card.textContent, /Ticker\$UTICA\$UTICANY/);
  assert.match(card.textContent, /The founder's why: Locals call it the falls city\./);
  assert.match(card.textContent, /! The checks flagged the name\. This sounds like it comes from Vicinity or its staff/);
  const approve = card.querySelectorAll("button").find((b) => b.textContent === "Approve this version");
  approve.click(); await tick();
  assert.match(t.asked.at(-1), /^Approve version 3f9a2c1b exactly as shown\?/);
  assert.deepEqual(t.posts.at(-1), ["/api/admin/coins/reviews/decide", { id: 7, action: "approve", contentHash: HASH }]);
  // ask for changes: the reason the founder reads; the note is optional
  const card2 = t.doc.querySelectorAll(".adm-coinrev__item")[0];
  card2.querySelector("select").value = "name_misleading";
  card2.querySelector("input").value = "Drop the word Official.";
  card2.querySelectorAll("button").find((b) => b.textContent === "Ask for changes").click(); await tick();
  assert.deepEqual(t.posts.at(-1), ["/api/admin/coins/reviews/decide", { id: 7, action: "changes_needed", contentHash: HASH, reasonCode: "name_misleading", note: "Drop the word Official." }]);
  // the approved ticker waiting for the city list: the line to add
  assert.match(t.doc.querySelector(".adm-coinrev__registry").textContent, /Syracuse · \{"5140405":"SALTCITY"\}/);
  assert.match(t.doc.querySelectorAll(".adm-coinrev__item")[1].textContent, /Add to scripts\/cities\/ticker-overrides\.json: \{"5140405":"SALTCITY"\}/);
});

test("a moderator looks only; the Overview counts what waits", async () => {
  const t = await open("moderator");
  const card = t.doc.querySelectorAll(".adm-coinrev__item")[0];
  assert.equal(card.querySelectorAll("button").length, 0);
  assert.match(card.textContent, /admin only/);
  // the Overview: what waits, from the server's own count (and nothing of it with the switch off)
  const card2 = (o, label) => o.doc.querySelectorAll(".adm-metric").find((c) => c.querySelector(".adm-metric__label").textContent === label);
  const on = await open("owner", { hash: "" });
  assert.equal(card2(on, "Coin reviews").querySelector(".adm-metric__num").textContent, "1");
  assert.equal(card2(on, "Coin reviews").querySelector(".adm-metric__src").textContent, "Coin change requests and descriptions waiting for a reviewer");
  const off = await open("owner", { hash: "", reviews: false });
  assert.equal(card2(off, "Coin reviews"), undefined);
});

test("phone width: the card's one column never grows past the card (the table, the hash and the reason form stay inside it)", () => {
  const css = readFileSync(new URL("../public/admin.css", import.meta.url), "utf8");
  assert.match(css, /\.adm-coinrev__item, \.adm-coinrev__registry \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.adm-coinrev__item > \*, \.adm-coinrev__registry > \* \{ min-width: 0; max-width: 100%; \}/);
  assert.match(css, /\.adm-coinrev__diff :is\(th, td\) \{ padding: 8px; white-space: normal; overflow-wrap: anywhere; \}/);
  // every new rule is scoped to the coin-review classes: with the switch off no element carries them
  const added = css.slice(css.indexOf("/* City-coin reviews"));
  for (const sel of added.match(/^[^\s/@}][^{]*\{/gm) || []) assert.match(sel, /adm-coinrev/, sel);
});

test("the reason is picked on purpose, from the reasons that fit the request, and the question names it; the card shows the whole version; an approved upload can be taken down", async () => {
  const kinds = { ticker_taken: ["change"], name_misleading: ["change"], financial_claim: ["description"], offensive: ["change", "description"], other: ["change", "description"] };
  const text = { ticker_taken: "That ticker already belongs to another city or is reserved.", name_misleading: "The name could be mistaken for another city, a company, a public body or Vicinity.",
    financial_claim: "It promises returns or price moves. City coins can't promise money.", offensive: "It contains hateful, sexual, violent or abusive content.", other: "It doesn't meet the coin rules. See the reviewer's note." };
  const SHA = "d".repeat(64);
  REVIEWS.reasons = Object.keys(kinds).map((code) => ({ code, text: text[code], kinds: kinds[code] }));
  REVIEWS.reviews = [
    { id: 9, kind: "description", status: "pending", label: "Pending", city: { id: "5142056", name: "Utica", country: "US" }, founder: { handle: "uticafounder", wallet: "7Np41*****4K2" },
      submittedAt: ago(30), decidedAt: null, version: HASH.slice(0, 8), contentHash: HASH,
      current: { name: "Utica", symbol: "UTICA", description: "The city coin of Utica, New York, United States.", art: "/coin-meta/art/" + "b".repeat(64) + ".png" },
      proposed: { name: "Utica", symbol: "UTICA", description: "Guaranteed profit, 100x soon.", art: "/coin-meta/art/" + "b".repeat(64) + ".png", upload: false },
      diff: [{ field: "description", from: "The city coin of Utica, New York, United States.", to: "Guaranteed profit, 100x soon." }],
      checks: [{ check: "description_screening", ok: false, text: "The checks flagged the description.", issues: [{ code: "financial", message: "This sounds like a promise about price or profit. City coins can't promise returns." }, { code: "financial", message: "This sounds like a promise about price or profit. City coins can't promise returns." }] }],
      why: null, decision: null, registryState: null, registryPatch: null },
    { id: 4, kind: "change", status: "approved", label: "Approved", city: { id: "5140405", name: "Syracuse", country: "US" }, founder: { handle: null, wallet: "Abcde*****xyz" }, submittedAt: ago(3000), decidedAt: ago(60),
      version: "11aa22bb", contentHash: "11aa22bb" + "c".repeat(56), current: { name: "Syracuse", symbol: "SYRACUSE", description: "The Salt City.", art: "/coin-meta/art/" + "e".repeat(64) + ".png" },
      proposed: { name: "Syracuse", symbol: "SYRACUSE", description: "The Salt City.", art: `/coin-meta/art/${SHA}.png`, upload: true },
      diff: [{ field: "picture", from: "/coin-meta/art/" + "e".repeat(64) + ".png", to: `/coin-meta/art/${SHA}.png` }], checks: [], why: null, decision: { reasonCode: null, reason: null, note: null }, registryState: null, registryPatch: null },
  ];
  const t = await open("admin");
  const [desc, appr] = t.doc.querySelectorAll(".adm-coinrev__item");
  // the whole version: every field, the unchanged ones marked "same"
  const rows = desc.querySelectorAll("tbody tr").map((tr) => tr.querySelector("th").textContent);
  assert.deepEqual(rows, ["Picture", "Ticker", "Coin name", "Description"]);
  assert.match(desc.querySelectorAll("tbody tr")[3].textContent, /The city coin of Utica, New York, United States\.Guaranteed profit, 100x soon\./);
  assert.match(desc.querySelectorAll("tbody tr")[1].textContent, /\$UTICAsame/);
  // one sentence per kind of issue
  assert.equal(desc.querySelectorAll(".adm-coinrev__issue").length, 1);
  // the reasons: a placeholder first, then only those that fit a description
  const sel = desc.querySelector("select");
  assert.deepEqual(sel.querySelectorAll("option").map((o) => o.value), ["", "financial_claim", "offensive", "other"]);
  assert.equal(sel.value, "");
  const before = t.posts.length;
  desc.querySelectorAll("button").find((b) => b.textContent === "Ask for changes").click(); await tick();
  assert.equal(t.posts.length, before, "no reason picked: nothing is sent");
  sel.value = "financial_claim";
  desc.querySelectorAll("button").find((b) => b.textContent === "Ask for changes").click(); await tick();
  assert.match(t.asked.at(-1), /They read: “It promises returns or price moves\. City coins can't promise money\.”/);
  assert.deepEqual(t.posts.at(-1), ["/api/admin/coins/reviews/decide", { id: 9, action: "changes_needed", contentHash: HASH, reasonCode: "financial_claim" }]);
  // decided: before and approved; an approved upload of the founder's own can be taken down (a public note is required)
  assert.deepEqual(appr.querySelectorAll("thead th").map((h) => h.textContent), ["", "Before", "Approved"]);
  const down = appr.querySelectorAll("button").find((b) => b.textContent === "Take the picture down");
  assert.ok(down);
  appr.querySelector(".adm-coinrev__takedown input").value = "A logo they don't own.";
  down.click(); await tick();
  assert.deepEqual(t.posts.at(-1), ["/api/coins/takedown", { city: "5140405", what: "art", sha: SHA, reason: "abuse", note: "A logo they don't own." }]);
});

test("NEW-1: every founder's own words and picture in use are listed with their takedown; the answer's words stay above the queue", async () => {
  const SHA = "f".repeat(64);
  REVIEWS.reviews = [];
  REVIEWS.inUse = [
    { city: { id: "5142056", name: "Utica", country: "US" }, launched: true, mint: "Mint1111111111111111111111111111111111111111", name: "Utica", symbol: "UTICA",
      description: "Utica is the Handshake City.", ownDescription: true, ownName: false, upload: false, art: "/coin-meta/art/" + "b".repeat(64) + ".png", version: "1234abcd", chosenAt: ago(60) },
    { city: { id: "5140405", name: "Syracuse", country: "US" }, launched: false, mint: null, name: "Salt City", symbol: "SYRACUSE", description: "The city coin of Syracuse, New York, United States.",
      ownDescription: false, ownName: true, upload: true, art: `/coin-meta/art/${SHA}.png`, version: "99aa88bb", chosenAt: ago(120) },
  ];
  const t = await open("admin");
  const said = "Taken down: the founder's description of $UTICA. The coin's page, the Launchpad and its metadata show Vicinity's own sentence now.";
  t.win.fetch = ((orig) => async (path, init = {}) => (String(path) === "/api/coins/takedown"
    ? (t.posts.push([String(path), JSON.parse(init.body || "{}")]), { ok: true, status: 200, json: async () => ({ ok: true, changed: [said], message: said, coin: {} }) })
    : orig(path, init)))(t.win.fetch);
  const box = t.doc.querySelector(".adm-coinrev__inuse");
  assert.match(box.textContent, /Founders' own words and pictures in use/);
  assert.match(box.textContent, /Each one here is public on its coin now \(a reviewer approved it\)/);
  const [ut, sy] = box.querySelectorAll(".adm-coinrev__use");
  assert.match(ut.textContent, /Utica \(US\) · \$UTICA “Utica” · launched · version 1234abcd/);
  assert.match(ut.textContent, /“Utica is the Handshake City\.”/);
  assert.deepEqual(ut.querySelectorAll("button").map((b) => b.textContent), ["Take the description down"]);
  assert.deepEqual(sy.querySelectorAll("button").map((b) => b.textContent), ["Take the name and words down", "Take the picture down"]);
  assert.match(sy.textContent, /The coin name is the founder's own \(a reviewer approved it\)\./);
  // a note first (it goes to the staff log, never public)
  const before = t.posts.length;
  ut.querySelectorAll("button")[0].click(); await tick();
  assert.equal(t.posts.length, before, "no note: nothing sent");
  ut.querySelector("input").value = "Copied from a rival coin.";
  assert.match(ut.querySelector("input").placeholder, /staff log only/);
  ut.querySelectorAll("button")[0].click(); await tick();
  assert.match(t.asked.at(-1), /^Take the founder's description down\? Every page and the coin's metadata show Vicinity's own sentence instead\./);
  assert.deepEqual(t.posts.at(-1), ["/api/coins/takedown", { city: "5142056", what: "text", reason: "abuse", note: "Copied from a rival coin." }]);
  await tick(80);
  const msg = t.doc.querySelector(".adm-coinrev__said");
  assert.equal(msg.textContent, said, "the server's own words, kept above the queue after it is drawn again");
  assert.equal(msg.getAttribute("role"), "status");
  // the picture: its sha goes with it
  const sy2 = t.doc.querySelectorAll(".adm-coinrev__use")[1];
  sy2.querySelector("input").value = "A logo they don't own.";
  sy2.querySelectorAll("button").find((b) => b.textContent === "Take the picture down").click(); await tick();
  assert.match(t.asked.at(-1), /the coin goes back to Vicinity's coin for the city on every page/);
  assert.deepEqual(t.posts.at(-1), ["/api/coins/takedown", { city: "5140405", what: "art", sha: SHA, reason: "abuse", note: "A logo they don't own." }]);
  delete REVIEWS.inUse;
});
