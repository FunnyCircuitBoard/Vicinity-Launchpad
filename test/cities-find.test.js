// /cities after the owner's screenshots of 11 Oct 2026 ("the claim a city page in both phone and desktop version: there are significant
// design issues"). Pinned here, on a pretend page (the page's own code run in a sandbox, as test/map-labels.test.js does):
// * nothing is picked for the visitor: the map's bottom slot says "Find your city" (a search with suggestions and "Use my location");
//   the crosshair and the city card take the slot once you zoom in on a region (FOCUS_K) or a city is pinned (a ?city= link, a pick,
//   a member's home city), and #city-stage[data-crosshair] says which;
// * the search is a combobox: suggestions as you type (names that start with the letters first, the biggest first), ↑ ↓, Enter picks
//   the highlighted place or the first, Escape closes; "Use my location" runs the same code as the map menu's ◎;
// * the facts above the map: never a number that makes the site look empty (founded from 1, choosing a founder from 1, verified members
//   from 100), the strong ones always, as many as fit on one line (4 on a computer, 3 on a phone, 2 on the smallest);
// * no empty blocks: the founders feed and Most wanted wait for something to show; the list opens on the visitor's country.
// How it looks at every width (dark and light) is checked in Chromium on the real Worker (d3-spec/accept.cjs); this file pins the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const js = read("public/cities.js"), css = read("public/pages-cities.css"), page = read("public/cities.html"), src = read("scripts/pages/src/cities.html");
const slice = (from, to) => { const a = js.indexOf(from), b = js.indexOf(to, a); assert.ok(a > 0 && b > a, from); return js.slice(a, b); };
const HELPERS = slice("  /* map helpers: start", "  /* map helpers: end */");

/** A pretend element: attributes, listeners, children, focus. */
function node(id, extra = {}) {
  return { id, hidden: false, value: "", className: "", textContent: "", dataset: {}, attrs: {}, children: [], on: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { (this.on[t] ||= []).push(f); }, fire(t, e = {}) { for (const f of this.on[t] || []) f({ preventDefault() {}, stopPropagation() {}, ...e }); },
    replaceChildren(...k) { this.children = k; }, append(...k) { this.children.push(...k); }, scrollIntoView() {}, contains() { return false; },
    focus() { focus.focused = this.id; }, ...extra };
}
const focus = { focused: null };

/** The slot and the search, run with the page's state (the block between "the map's bottom slot" and the first view's own line). */
function findPage({ cities = [], k = 1, s0 = 3.4, pinned = null, moved = false } = {}) {
  const els = Object.fromEntries(["#map-find", "#map-focus", "#city-stage", "#map-find-q", "#map-find-list", "#map-search", "#city-find", "#city-canvas"].map((s) => [s, node(s.slice(1))]));
  const picked = [];
  const ctx = {
    els, picked, cities,
    $: (s) => els[s] || els["#map-find-list"].children.find((c) => "#" + c.id === s) || null,
    el: (tag, cls, text) => node("", { tag, className: cls || "", textContent: text == null ? "" : String(text) }),
    norm: (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}]+/gu, ""),
    placeOf: (c) => c.where, rowTag: (c) => node("", { className: "tag tag--open", textContent: "Open" }),
    select: (c, fly) => picked.push([c.name, fly]), ripple() {}, kick() {}, measureOverlays() {},
    window: { matchMedia: () => ({ matches: false }) }, document: { addEventListener() {}, querySelector: () => null }, Node: function Node() {}, Element: function Element() {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${HELPERS}
    let s0 = ${s0}, k = ${k}, W = 1000, focusPinned = ${JSON.stringify(pinned)}, userMoved = ${moved}, focusSig = "x", reduced = true, loaded = true;
    const dirty = { labels: false, layout: false, base: false, focus: false };
    const kg = () => (s0 * k) / KREF;
    const findEl = $("#map-find"), focusEl = $("#map-focus"), wrapEl = $("#city-stage"), canvas = $("#city-canvas");
    ${slice("  /* ---------- the map's bottom slot", "  // the first view: a ?city= link opens")}
    this.api = { inFind, setFind, openFind, endFinding, set: (o) => { if ("k" in o) k = o.k; if ("pinned" in o) focusPinned = o.pinned; if ("moved" in o) userMoved = o.moved; },
      state: () => ({ findOn, finding, opts: opts.map((c) => c.name), active }) };`, ctx);
  return { ...ctx.api, state: () => JSON.parse(JSON.stringify(ctx.api.state())), els, picked }; // answers from the sandbox's realm, compared as plain values
}
const CITIES = [
  { name: "New York City", n: "newyorkcity", where: "New York, United States" }, { name: "Los Angeles", n: "losangeles", where: "California, United States" },
  { name: "East New York", n: "eastnewyork", where: "New York, United States" }, { name: "West New York", n: "westnewyork", where: "New Jersey, United States" },
  { name: "Newark", n: "newark", where: "New Jersey, United States" }, { name: "New York Mills", n: "newyorkmills", where: "Minnesota, United States" },
];

test("the first view picks nothing: the find state below a region's zoom with nothing pinned; the city card from FOCUS_K or for a pinned city", () => {
  const P = findPage();
  assert.equal(P.inFind(), true, "the whole world (or a phone's region) with nothing pinned: Find your city");
  P.set({ k: 3.99 }); assert.equal(P.inFind(), true, "still further out than a region (kg 3.99 < FOCUS_K 4)");
  P.set({ k: 4 }); assert.equal(P.inFind(), false, "from FOCUS_K the card follows the crosshair (the owner, 6 Oct 2026: no tap needed for a city's stats)");
  P.set({ k: 1, pinned: "5128581", moved: false }); assert.equal(P.inFind(), false, "a ?city= link, a pick or a home city: its card at any zoom");
  P.set({ moved: true }); assert.equal(P.inFind(), true, "the visitor moved the map out again: back to the search");
  // the same distance on any stage: real map scale (s0 × k ÷ KREF), not the raw zoom
  assert.equal(findPage({ s0: 2.42, k: 5.6 }).inFind(), true, "a whole-world computer at zoom 5.6 is still a continent");
  assert.equal(findPage({ s0: 3.85, k: 3.6 }).inFind(), false, "a phone at zoom 3.6 is already a region");
});

test("the slot: one card at a time, and #city-stage[data-crosshair] says which (no crosshair on the find view)", () => {
  const P = findPage();
  P.setFind(true);
  assert.equal(P.els["#map-find"].hidden, false); assert.equal(P.els["#map-focus"].hidden, true); assert.equal(P.els["#city-stage"].dataset.crosshair, "off");
  P.setFind(false);
  assert.equal(P.els["#map-find"].hidden, true); assert.equal(P.els["#map-focus"].hidden, false); assert.equal(P.els["#city-stage"].dataset.crosshair, "on");
  // the crosshair is drawn only while the city card follows it
  assert.match(js, /\/\/ the crosshair: a ring and four ticks at the focus point, only while the city card follows it[^\n]*\n    if \(findOn === false\) \{/);
  assert.match(js, /const find = inFind\(\);\n    setFind\(find\);\n    if \(find\) \{ if \(focusId !== null\) \{ focusId = null;/, "updateFocus: no city in focus on the find view");
  // the first view before the map loads: a ?city= link shows its card (loading), everything else the search
  assert.match(js, /findOn = !new URLSearchParams\(location\.search\)\.get\("city"\);\n  showSlot\(findOn\);/);
  // CSS: the magnifier and the scale bar go on the find view
  assert.match(css, /#city-stage\[data-crosshair="off"\] \.map-search \{ display: none; \}/);
  assert.match(css, /#city-stage\[data-crosshair="off"\] \.map-scale \{ display: none; \}/);
});

test("the search: suggestions as you type (starts first, the biggest first), ↑ ↓ and Enter pick, Escape closes; a pick flies there and opens the card", () => {
  const P = findPage({ cities: CITIES });
  const q = P.els["#map-find-q"], list = P.els["#map-find-list"];
  P.setFind(true);
  q.value = "new y"; q.fire("input");
  assert.equal(list.hidden, false); assert.equal(q.getAttribute("aria-expanded"), "true");
  assert.deepEqual(P.state().opts, ["New York City", "New York Mills", "East New York", "West New York"], "names that start with it first, then names that hold it");
  assert.equal(list.children[0].getAttribute("role"), "option"); assert.equal(list.children[0].id, "map-find-o0");
  assert.equal(list.children[0].children[0].children.map((c) => c.textContent).join(" · "), "New York City · New York, United States", "\"Name · Region, Country\" and its status pill");
  q.fire("keydown", { key: "ArrowDown" }); q.fire("keydown", { key: "ArrowDown" });
  assert.equal(q.getAttribute("aria-activedescendant"), "map-find-o1"); assert.equal(list.children[1].getAttribute("aria-selected"), "true");
  q.fire("keydown", { key: "ArrowUp" }); q.fire("keydown", { key: "ArrowUp" });
  assert.equal(q.getAttribute("aria-activedescendant"), "map-find-o3", "↑ from the first wraps to the last");
  q.fire("keydown", { key: "Escape" });
  assert.equal(list.hidden, true); assert.equal(q.getAttribute("aria-expanded"), "false");
  // Enter with nothing highlighted: the first suggestion
  q.fire("keydown", { key: "Enter" });
  assert.deepEqual(P.picked, [["New York City", true]], "select(c, true): fly there and pin its card");
  assert.equal(q.value, ""); assert.equal(focus.focused, "city-canvas", "the keyboard goes to the map (the find card makes way for the city card)");
  // a click on a suggestion picks it too; a name that matches nothing says so
  q.value = "angel"; q.fire("input"); list.children[0].fire("click");
  assert.deepEqual(P.picked.at(-1), ["Los Angeles", true]);
  q.value = "zzzz"; q.fire("input");
  assert.equal(list.children.length, 1); assert.match(list.children[0].textContent, /^No place by that name yet/);
  q.fire("keydown", { key: "Enter" });
  assert.equal(P.picked.length, 2, "Enter with no suggestion picks nothing");
});

test("the magnifier (zoomed in) opens the search; Escape on an empty search, or the keyboard leaving it empty, brings the card back", () => {
  const P = findPage({ cities: CITIES, k: 9 });
  assert.equal(P.inFind(), false);
  P.setFind(false);
  P.els["#map-search"].fire("click");
  assert.equal(P.state().finding, true); assert.equal(P.inFind(), true); assert.equal(P.els["#city-stage"].dataset.crosshair, "off"); assert.equal(focus.focused, "map-find-q");
  P.els["#map-find-q"].fire("keydown", { key: "Escape" });
  assert.equal(P.state().finding, false); assert.equal(P.inFind(), false);
  P.openFind(); P.els["#map-find"].fire("focusout", { relatedTarget: null });
  assert.equal(P.state().finding, false, "the keyboard left an empty search: the card comes back");
  // the list's "Search on the map ↑" opens it too, scrolling the map into view
  assert.match(js, /\$\("#city-find"\)\.addEventListener\("click", \(\) => openFind\(true\)\);/);
  assert.match(js, /if \(e\.key !== "\/" \|\| e\.ctrlKey/, "\"/\" puts the keyboard in the search");
});

test("\"Use my location\" on the find card is the map menu's ◎: one function, location used on the device only", () => {
  assert.match(js, /\$\("#map-locate"\)\.addEventListener\("click", \(\) => locateMe\(\$\("#map-locate"\)\)\);\n  \$\("#map-find-loc"\)\.addEventListener\("click", \(\) => locateMe\(\$\("#map-find-loc"\)\)\);/);
  const fn = slice("  async function locateMe(b) {", "  $(\"#map-locate\").addEventListener");
  assert.match(fn, /const loc = await V\(\)\.getLocation\(\);/);
  assert.doesNotMatch(fn, /fetch\(/, "never sent anywhere");
  assert.equal((js.match(/V\(\)\.getLocation\(\)/g) || []).length, 1, "one place asks for the location");
});

test("the find card's markup: a search landmark, a labelled combobox, a listbox opening upward, a 44 px location button; the hint for screen readers", () => {
  for (const h of [page, src]) {
    const form = h.slice(h.indexOf('<form class="map-find"'), h.indexOf("</form>", h.indexOf('<form class="map-find"')));
    assert.match(form, /^<form class="map-find" id="map-find" role="search" aria-label="Find your city" data-fb-avoid>/);
    assert.match(form, /<label class="map-find__title" for="map-find-q">Find your city<\/label>/);
    assert.match(form, /<input id="map-find-q" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="map-find-list" aria-describedby="map-find-hint" autocomplete="off" spellcheck="false" maxlength="60" enterkeyhint="go" placeholder="Search a city or town">/);
    assert.match(form, /<button type="button" class="map-find__loc" id="map-find-loc" aria-label="Use my location" title="Use my location"><svg [^>]*aria-hidden="true"/);
    assert.match(form, /<ul class="map-find__list" id="map-find-list" role="listbox" aria-label="Places" hidden><\/ul>/);
    assert.match(form, /<p class="sr-only" id="map-find-hint">8,029 communities, one founder seat each\./);
    assert.ok(h.indexOf('<form class="map-find"') < h.indexOf('<canvas id="city-canvas"'), "first in the stage: the keyboard reaches the search before the map");
    assert.doesNotMatch(form, /\sstyle="/);
  }
  // opens upward inside the map; 4 suggestions on a phone, 6 on a computer, the list never taller than the map allows
  assert.match(css, /\.map-find__list \{ position: absolute; left: 0; right: 0; bottom: calc\(100% \+ 8px\);[^}]*max-height: calc\(var\(--stage-h, 280px\) - 80px\); overflow-y: auto;/);
  assert.match(js, /opts = matchPlaces\(cities, q, window\.matchMedia\("\(max-width: 600px\)"\)\.matches \? 4 : 6\);/);
  assert.match(js, /wrapEl\.style\.setProperty\("--stage-h", `\$\{Math\.round\(H\)\}px`\);/, "the stage's height for the list's limit (CSSOM, never a style attribute)");
  // a phone: one pill, 56 px; the field 16 px (no zoom on focus in iOS Safari); a computer: one bar under the world, 640 px at most
  assert.match(css, /\.map-find \{ position: absolute; z-index: 4; left: 10px; right: 10px; bottom: 10px; display: flex; align-items: center; gap: 6px; height: 56px;/);
  assert.match(css, /\.map-find input \{ width: 100%; height: 44px; min-height: 44px;[^}]*font: 500 16px\/1\.2 var\(--body\);/);
  assert.match(css, /@media \(min-width: 720px\) \{\n[^\n]*\n  \.map-find \{ left: 12px; right: 68px; bottom: 8px; max-width: 640px; margin: 0 auto;/);
  assert.match(js, /const onMap = \(e\) => !\(e\.target instanceof Element\) \|\| !e\.target\.closest\("\.map-ctrl, \.map-focus, \.map-find, \.map-exit, \.map-hint"\);/, "a drag never starts on the find card");
});

/** fitFacts, run on pretend facts laid out in a row of the given width (each fact's width, a wrap when the row is full). */
function factsPage({ width, screen, n }) {
  const ids = ["cs-claimed", "cs-choosing", "cs-cities", "cs-countries", "cs-official", "cs-members"];
  const min = { "cs-claimed": 1, "cs-choosing": 1, "cs-members": 100 };
  const w = { "cs-claimed": 80, "cs-choosing": 150, "cs-cities": 130, "cs-countries": 200, "cs-official": 180, "cs-members": 170 };
  const ul = { children: [], clientWidth: width, get scrollWidth() { return width; } };
  const lis = ids.map((id) => {
    const li = { id, hidden: id in min, dataset: id in min ? { min: String(min[id]) } : {}, getBoundingClientRect() {
      let x = 0, top = 0;
      for (const o of ul.children) { if (o.hidden) continue; if (x && x + w[o.id] > width) { x = 0; top += 20; } x += w[o.id] + 16; if (o === li) return { top }; }
      return { top: 0 };
    } };
    return li;
  });
  ul.children = lis;
  const strong = Object.fromEntries(ids.map((id, i) => [id, { textContent: "", closest: () => lis[i] }]));
  const ctx = { $: (s) => (s === "#cities .city-stats" ? ul : strong[s.slice(1)]), window: { innerWidth: screen }, fmt: (x) => Number(x).toLocaleString("en-US") };
  vm.createContext(ctx);
  vm.runInContext(`${slice("  const FACTS = [", "  function updateStats() {")}\nthis.api = { setFact, fitFacts };`, ctx);
  for (const [id, v] of Object.entries(n)) ctx.api.setFact(id, v);
  ctx.api.fitFacts();
  return lis.filter((li) => !li.hidden).map((li) => li.id.slice(3));
}
const LIVE = { "cs-claimed": 0, "cs-choosing": 0, "cs-cities": 8029, "cs-countries": 244, "cs-official": 5838, "cs-members": 2 };
const RICH = { "cs-claimed": 2, "cs-choosing": 1, "cs-cities": 8029, "cs-countries": 244, "cs-official": 5838, "cs-members": 150 };

test("the facts: never a number that makes the site look empty; the strong ones always; as many as fit on one line (4, 3 on a phone, 2 on the smallest)", () => {
  assert.deepEqual(factsPage({ width: 700, screen: 1440, n: LIVE }), ["cities", "countries", "official"], "today: no \"0 founded\", no \"2 verified members\"");
  assert.deepEqual(factsPage({ width: 900, screen: 1440, n: RICH }), ["claimed", "choosing", "cities", "members"], "with founders, a window and 150 members: the live signals first, at most 4");
  assert.deepEqual(factsPage({ width: 330, screen: 390, n: LIVE }), ["cities", "official"], "a phone: what fits on one line (countries & territories is too long after communities here, official boundaries is not)");
  assert.deepEqual(factsPage({ width: 340, screen: 360, n: RICH }), ["claimed", "choosing"], "a phone with founders: founded and choosing first");
  assert.deepEqual(factsPage({ width: 2000, screen: 390, n: RICH }), ["claimed", "choosing", "cities"], "never more than 3 on a phone");
  assert.deepEqual(factsPage({ width: 2000, screen: 320, n: LIVE }), ["cities", "countries"], "2 on the smallest");
  assert.deepEqual(factsPage({ width: 900, screen: 1440, n: { ...LIVE, "cs-members": 99 } }), ["cities", "countries", "official"], "99 members: still hidden");
  // the page wires it: the official boundaries counted from the overview, the status pill only about founder applications
  assert.match(js, /if \(a\.kind === "r"\) officialCount\+\+;/);
  assert.match(js, /\$\("#cs-status"\)\.hidden = !open; \/\/ about founder applications, never about coins/);
  assert.doesNotMatch(js, /cs-open|still open|"At launch"/);
});

test("no empty-looking blocks: the founders feed waits for a founder, Most wanted for three communities with members; the list opens on the visitor's country", () => {
  assert.match(js, /const wrap = \$\("\.claim-feed-wrap"\);\n    if \(wrap\) wrap\.hidden = !list\.length;/);
  assert.match(js, /if \(wanted\) wanted\.hidden = d\.communities\.filter\(\(c\) => c\.members > 0\)\.length < 3;/);
  for (const h of [page, src]) {
    assert.match(h, /<div class="claim-feed-wrap" hidden>/);
    assert.match(h, /<section class="section section--panel" id="wanted" hidden>/);
  }
  // the visitor's country: the home city's, else the place the time zone is named after, never the middle of the world view
  const vc = slice("  function visitorCountry() {", "  function defaultCountry() {");
  assert.match(vc, /const h = myHome\(\), home = h && byId\.get\(String\(h\)\);\n    if \(home\) return home\.cc;/);
  assert.match(vc, /const p = tzPlace\(tz\);/);
  const run = (tz, home = null) => {
    const cities = [{ id: "1", n: "newyorkcity", cc: "US" }, { id: "2", n: "london", cc: "GB" }, { id: "3", n: "berlin", cc: "DE" }, { id: "4", n: "newyorkmills", cc: "US" }];
    const ctx = { cities, byId: new Map(cities.map((c) => [c.id, c])), myHome: () => home, Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: tz }) }) },
      openingView: () => [0, 0], nearestCommunities: () => [[cities[2], 10]] };
    vm.createContext(ctx);
    return vm.runInContext(`${HELPERS.slice(HELPERS.indexOf("  function tzPlace"), HELPERS.indexOf("  /** Up to n places"))}\n${vc}\nvisitorCountry()`, ctx);
  };
  assert.equal(run("America/New_York"), "US", "a New York visitor's list starts with US cities");
  assert.equal(run("Europe/London"), "GB");
  assert.equal(run("Europe/Somewhere"), "DE", "an unknown place: the community nearest the time zone's region");
  assert.equal(run("UTC"), null, "UTC says nothing: all countries");
  assert.equal(run("America/New_York", "2"), "GB", "signed in: the home city's country");
  assert.match(js, /\$\("#city-count"\)\.textContent = total > 60 \? `Showing 60 of \$\{fmt\(total\)\} \$\{noun\}\$\{where\}`/, "the count says what it counts");
});
