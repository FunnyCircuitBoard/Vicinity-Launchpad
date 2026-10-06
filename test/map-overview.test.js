// The map on /cities after the owner's request of 6 Oct 2026: "make the map bigger and more interactive, a premium glowing animation
// based on the status", then "city boundaries without any zoom, no tapping required for a city on mobile to see its stats, just
// normally visible as zoomed in". What is pinned here:
// * the world-wide boundary layer (public/data/bounds-overview.txt) stays in step with the per-country files: the same cities with the
//   same ids and kinds, exactly what scripts/boundaries/overview.mjs makes from them, small enough to load with the page;
// * the page's pure map helpers (the "map helpers" block of public/cities.js): reading the file, the opening view, the scale bar,
//   fly-to timing, which city is in focus, and where chips go (never overlapping, never on the controls or the city card, the phone and
//   computer budgets);
// * the glow layer's battery rules, the stage and the city-in-focus card in the page and the style sheet.
// How it looks and how fast it draws (CPU throttled 4x on a 390 px phone) is checked in Chromium on the real Worker; this file pins the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import vm from "node:vm";
import { buildOverview, BOUNDS_DIR, OVERVIEW_FILE, overviewArea, simplifyRing, quantize, kmArea, kmText, GRID } from "../scripts/boundaries/overview.mjs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const js = read("public/cities.js"), css = read("public/style.css"), page = read("public/cities.html"), src = read("scripts/pages/src/cities.html");
const overview = readFileSync(OVERVIEW_FILE, "utf8");

/** The pure helpers of public/cities.js, run on their own (no page, no DOM). Answers come back as plain values of this realm. */
const H = (() => {
  const a = js.indexOf("  /* map helpers: start"), b = js.indexOf("  /* map helpers: end */");
  assert.ok(a > 0 && b > a, "the map helpers sit together in one block of cities.js");
  const raw = vm.runInNewContext(`${js.slice(a, b)}\n({ OV_UNIT, AREA_K, parseOverviewLine, inOverview, thinRing, thinFor, openingView, scaleBar, flightPlan, labelRank, byRank, placeLabels, chooseFocus, until })`, {});
  const here = (v) => (v == null || typeof v !== "object" ? v : ArrayBuffer.isView(v) ? [...v] : JSON.parse(JSON.stringify(v, (_, x) => (ArrayBuffer.isView(x) ? [...x] : x))));
  const out = { OV_UNIT: raw.OV_UNIT, AREA_K: raw.AREA_K, byRank: raw.byRank, inOverview: raw.inOverview };
  for (const f of ["parseOverviewLine", "thinRing", "thinFor", "openingView", "scaleBar", "flightPlan", "labelRank", "placeLabels", "chooseFocus", "until"]) out[f] = (...args) => here(raw[f](...args));
  out.raw = raw;
  return out;
})();

/* ---------------- the overview file ---------------- */

test("overview file: exactly what the generator makes from today's country files (run npm run bounds:overview after a boundary build)", () => {
  assert.equal(buildOverview(BOUNDS_DIR), overview, "public/data/bounds-overview.txt is stale: npm run bounds:overview");
});

test("overview file: the same cities as the country files, with the same ids and kinds, one line each", () => {
  const fromCountries = [];
  for (const f of readdirSync(BOUNDS_DIR).filter((x) => /^[A-Z]{2}\.txt$/.test(x)).sort())
    for (const l of readFileSync(new URL(f, BOUNDS_DIR), "utf8").split("\n")) { const [id, kind, , json] = l.split("\t"); if (json && (kind === "r" || kind === "n")) fromCountries.push(`${id}\t${kind}`); }
  const lines = overview.split("\n").filter(Boolean);
  const head = /^#vicinity-overview unit=([\d.]+) areas=(\d+) points=(\d+)$/.exec(lines[0]);
  assert.ok(head, lines[0]);
  assert.equal(Number(head[1]), 1 / GRID);
  const body = lines.slice(1);
  assert.deepEqual(body.map((l) => l.split("\t").slice(0, 2).join("\t")), fromCountries, "same cities, same order, same kinds");
  assert.equal(new Set(body.map((l) => l.split("\t")[0])).size, body.length, "one line per city");
  assert.equal(Number(head[2]), body.length);
  assert.ok(body.length >= 8000, `${body.length} areas: every community has an outline`);
  // every one of them has a visible outline: rings of 3+ points that enclose something
  let points = 0;
  for (const l of body) {
    const a = H.parseOverviewLine(l);
    assert.ok(a && a.rings.length >= 1, l.slice(0, 40));
    for (const r of a.rings) {
      assert.ok(r.length >= 6, `${a.id}: a ring of ${r.length / 2} points`);
      let s = 0; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) s += (r[j] - r[i]) * (r[j + 1] + r[i + 1]);
      assert.notEqual(s, 0, `${a.id}: a ring with no area`);
      points += r.length / 2;
    }
    assert.ok(a.km2 > 0, `${a.id}: km²`);
  }
  assert.equal(Number(head[3]), points);
  // every listed city with an outline is a city of cities.json (the page finds its country, status and ticker by id)
  const listed = new Set(Object.values(JSON.parse(read("public/data/cities.json")).byCountry).flat().map((r) => String(r[0])));
  for (const l of body) assert.ok(listed.has(l.split("\t")[0]), l.split("\t")[0]);
});

test("overview file: light enough to load with the page (aim under 400 KB gzipped)", () => {
  const raw = Buffer.byteLength(overview), gz = gzipSync(overview, { level: 9 }).length;
  assert.ok(raw < 700_000, `${raw} bytes raw`);
  assert.ok(gz < 400_000, `${gz} bytes gzipped`);
  // and far lighter than the detailed files the map used to need before it could draw a boundary (11 MB)
  const detailed = readdirSync(BOUNDS_DIR).filter((x) => x.endsWith(".txt")).reduce((n, f) => n + readFileSync(new URL(f, BOUNDS_DIR)).length, 0);
  assert.ok(raw * 10 < detailed, `${raw} vs ${detailed}`);
});

test("overview file: the km² it states prints exactly like the detailed boundary's on the map (\"2,986 km²\" for Utica)", () => {
  const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const shown = (km2) => (km2 >= 10 ? fmt(km2) : km2.toFixed(1)); // public/cities.js areaNote
  const stated = new Map(overview.split("\n").filter((l) => l && l[0] !== "#").map((l) => { const [id, , km] = l.split("\t"); return [id, Number(km)]; }));
  const decode = (flat) => { const r = []; let x = 0, y = 0; for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; r.push([x * 1e-4, y * 1e-4]); } return r; };
  let n = 0;
  for (const f of readdirSync(BOUNDS_DIR).filter((x) => /^[A-Z]{2}\.txt$/.test(x)))
    for (const l of readFileSync(new URL(f, BOUNDS_DIR), "utf8").split("\n")) {
      const [id, kind, , json] = l.split("\t");
      if (!json || (kind !== "r" && kind !== "n")) continue;
      const km = kmArea(JSON.parse(json).map((poly) => poly.map(decode)));
      assert.equal(shown(stated.get(id)), shown(km), id); n++;
    }
  assert.equal(n, stated.size);
  assert.equal(shown(stated.get("5142056")), "2,986", "Utica, as the computer's hover card says");
});

test("overview generator: simplify, snap to the grid, and never lose a city's outline", () => {
  // a big square stays a square (its corners survive), holes are dropped, the grid is 1/20 degree
  const sq = (x, y, d) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];
  const rings = overviewArea([[sq(10, 20, 1), sq(10.4, 20.4, 0.1)]]);
  assert.deepEqual(rings, [[[200, 400], [220, 400], [220, 420], [200, 420]]]);
  // a city smaller than a grid cell still gets a one-cell square around its middle
  assert.deepEqual(overviewArea([[sq(10.001, 20.001, 0.002)]]), [[[200, 400], [201, 400], [201, 401], [200, 401]]]);
  // a tiny island next to a big area is dropped (the big outline carries the city)
  assert.equal(overviewArea([[sq(10, 20, 1)], [sq(12.001, 20.001, 0.002)]]).length, 1);
  // Douglas-Peucker keeps a corner, drops a point on a straight edge; quantize drops repeats and the closing point
  const simplified = simplifyRing([[0, 0], [0.5, 0], [1, 0], [1, 1], [0, 1], [0, 0]], 0.05);
  assert.ok(!simplified.some(([x, y]) => x === 0.5 && y === 0), "the point on a straight edge goes");
  assert.equal(simplified.length, 4);
  assert.deepEqual(quantize([[0, 0], [0.01, 0.01], [1, 0], [1, 0], [0, 0]]), [[0, 0], [20, 0]]);
  assert.equal(kmText(2986.37), "2986"); assert.equal(kmText(9.96), "9.960");
});

/* ---------------- the page's pure helpers ---------------- */

test("helpers: an overview line → rings in grid units and a box in degrees; inside / outside", () => {
  const a = H.parseOverviewLine("5142056\tr\t2986\t[[-1505,862,1,0,0,1,-1,0]]");
  assert.equal(a.id, "5142056"); assert.equal(a.kind, "r"); assert.equal(a.km2, 2986);
  assert.deepEqual(a.rings[0], [-1505, 862, -1504, 862, -1504, 863, -1505, 863]);
  assert.deepEqual(a.box.map((v) => +v.toFixed(2)), [-75.25, 43.1, -75.2, 43.15]);
  const live = H.raw.parseOverviewLine("5142056\tr\t2986\t[[-1505,862,1,0,0,1,-1,0]]");
  assert.equal(H.inOverview(-75.23, 43.12, live), true);
  assert.equal(H.inOverview(-75.3, 43.12, live), false);
  assert.equal(H.parseOverviewLine("#vicinity-overview unit=0.05 areas=1 points=4"), null);
  assert.equal(H.parseOverviewLine("9\tp\t5142056"), null, "a 'part of' line has no shape");
  assert.equal(H.parseOverviewLine(""), null);
});

test("helpers: thinning for the zoom keeps about a point per pixel and never fewer than 3 points", () => {
  const ring = new Int16Array([0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 4, 4, 0, 4, 0, 2]);
  assert.deepEqual(H.thinRing(ring, 1), [...ring], "no thinning when a grid unit is a pixel or more");
  assert.deepEqual(H.thinRing(ring, 2), [0, 0, 2, 0, 4, 0, 4, 4, 0, 4, 0, 2]);
  assert.ok(H.thinRing(new Int16Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1]), 8).length >= 6, "a tiny city keeps its outline");
  assert.equal(H.thinFor(4.4), 4); assert.equal(H.thinFor(8), 2); assert.equal(H.thinFor(25), 1); // a phone at the first view, zoom 2, zoom 5
});

test("helpers: the opening view follows the time zone only (no location, no network)", () => {
  assert.deepEqual(H.openingView("America/New_York"), [-95, 38]);
  assert.deepEqual(H.openingView("Europe/Berlin"), [15, 50]);
  assert.deepEqual(H.openingView("Africa/Lagos"), [20, 5]);
  assert.deepEqual(H.openingView("Asia/Dhaka"), [100, 25]);
  assert.deepEqual(H.openingView("Australia/Sydney"), [135, -25]);
  assert.deepEqual(H.openingView("Pacific/Auckland"), [135, -25]);
  assert.deepEqual(H.openingView("UTC"), [10, 20]);
  assert.deepEqual(H.openingView(undefined), [10, 20]);
  assert.doesNotMatch(js.slice(js.indexOf("function openingView"), js.indexOf("function scaleBar")), /fetch|geolocation|getLocation/);
});

test("helpers: the scale bar is a round distance that fits", () => {
  assert.deepEqual(H.scaleBar(0.05, 96), { km: 1000, px: 50, text: "1,000 km" });
  assert.deepEqual(H.scaleBar(1, 96), { km: 50, px: 50, text: "50 km" });
  assert.deepEqual(H.scaleBar(400, 96), { km: 0.2, px: 80, text: "200 m" });
  for (const p of [0.01, 0.3, 3, 77, 2000]) { const b = H.scaleBar(p, 96); assert.ok(b.px <= 96 && b.px >= 96 / 5 - 1, `${p}: ${b.px}`); }
  assert.equal(H.scaleBar(0), null);
});

test("helpers: fly-to takes 0.6 to 1.6 s and dips out on a long trip", () => {
  assert.deepEqual(H.flightPlan(1, 1, 0), { ms: 600, dip: null });
  assert.equal(H.flightPlan(2, 10, 10).ms, Math.round(450 + 260 * Math.log2(5) + 30));
  assert.equal(H.flightPlan(1, 60, 10).ms, 1600, "a deep zoom takes the longest");
  assert.equal(H.flightPlan(1, 900, 200).ms, 1600);
  assert.deepEqual(H.flightPlan(6, 60, 80).dip, 6 / 2.5);
  assert.equal(H.flightPlan(1, 60, 80).dip, 1, "never below the whole world");
});

test("helpers: the city in focus is the area under the crosshair, else the nearest city within 56 px, and it does not flicker", () => {
  const c = (id, d) => ({ id, d });
  assert.equal(H.chooseFocus([c("a", 3)], "z", "a"), "z", "the area holding the crosshair wins");
  assert.equal(H.chooseFocus([c("a", 30), c("b", 12)], null, null), "b");
  assert.equal(H.chooseFocus([c("a", 60)], null, null), null, "nothing within 56 px");
  assert.equal(H.chooseFocus([c("a", 20), c("b", 14)], null, "a"), "a", "6 px closer is not enough to switch");
  assert.equal(H.chooseFocus([c("a", 20), c("b", 11)], null, "a"), "b", "9 px closer is");
  assert.equal(H.chooseFocus([c("a", 70), c("b", 50)], null, "a"), "b", "the current one left the 56 px");
  assert.equal(H.chooseFocus([c("b", 10), c("a", 10)], null, null), "a", "a tie is decided the same way every time");
});

test("helpers: label priority: yours, selected, in focus, founded (holders), choosing (applicants), members, population", () => {
  const list = [
    { id: "pop", pop: 9e6 }, { id: "mem", members: 3, pop: 10 }, { id: "cho", status: "choosing", applicants: 2 }, { id: "fou", status: "founded", holders: 5 },
    { id: "foc", focus: true }, { id: "sel", selected: true }, { id: "mine", mine: true, status: "founded" }, { id: "fou2", status: "founded", holders: 50 },
  ];
  assert.deepEqual(list.slice().sort(H.byRank).map((x) => x.id), ["mine", "sel", "foc", "fou2", "fou", "cho", "mem", "pop"]);
  // a label shown last time stays ahead of new ones of its own kind (no flicker), never ahead of a higher kind
  assert.deepEqual([{ id: "a", pop: 9 }, { id: "b", pop: 1, shown: true }, { id: "c", members: 1, pop: 1 }].sort(H.byRank).map((x) => x.id), ["c", "b", "a"]);
});

/** n chips scattered over a stage, in priority order, the sizes a phone draws. */
function scatter(n, W, H, seed = 7) {
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => ({ id: "c" + i, x: rnd() * W, y: rnd() * H, tierWish: i < 2 ? "A" : "B", focus: i === 1,
    size: { A: [110, 36], B: [70 + Math.round(rnd() * 80), 22], C: [40 + Math.round(rnd() * 30), 14] } }));
}
const overlap = (a, b, pad) => a.x - pad < b.x + b.w && b.x - pad < a.x + a.w && a.y - pad < b.y + b.h && b.y - pad < a.y + a.h;

test("chips: never overlapping, never on the controls, the city card or the crosshair, inside the map; the phone and computer budgets", () => {
  for (const [W, Hh, max] of [[320, 434, { A: 3, B: 10, C: 20 }], [390, 638, { A: 3, B: 10, C: 20 }], [1126, 714, { A: 3, B: 24, C: 60 }]]) {
    const rail = [W - 56, 0, 56, 300], card = [0, Hh - 134, W, 134], cross = [W / 2 - 20, (Hh - 134) / 2 - 20, 40, 40];
    const placed = H.placeLabels(scatter(600, W, Hh), { W, H: Hh, avoid: [rail, card], soft: [cross], max });
    const count = (t) => placed.filter((p) => p.tier === t).length;
    assert.ok(count("A") <= 3 && count("B") <= max.B && count("C") <= max.C, `${W}: ${count("A")}/${count("B")}/${count("C")}`);
    if (W >= 390) assert.ok(count("B") === max.B && count("C") === max.C, `${W}: a busy map fills every slot`);
    else assert.ok(count("B") >= 5 && count("C") === max.C, `${W}: the smallest phone still shows ${count("B")} chips and ${count("C")} names`);
    for (const p of placed) {
      assert.ok(p.x >= 6 && p.y >= 6 && p.x + p.w <= W - 6 && p.y + p.h <= Hh - 6, `${W}: ${p.id} inside the map`);
      for (const r of [rail, card]) assert.ok(!overlap(p, { x: r[0], y: r[1], w: r[2], h: r[3] }, 4), `${W}: ${p.id} clear of the controls and the card`);
      if (p.id !== "c1") assert.ok(!overlap(p, { x: cross[0], y: cross[1], w: 40, h: 40 }, 4), `${W}: ${p.id} clear of the crosshair`);
    }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.ok(!overlap(placed[i], placed[j], 4), `${W}: ${placed[i].id} × ${placed[j].id}`);
    // deterministic: the same view lays out the same way (no chip jumps on a redraw)
    assert.deepEqual(H.placeLabels(scatter(600, W, Hh), { W, H: Hh, avoid: [rail, card], soft: [cross], max }), placed);
  }
});

test("chips: a chip that fits nowhere as a chip becomes a plain name; farther spots get a leader line; the focus chip may sit by the crosshair", () => {
  const item = (id, x, y, extra = {}) => ({ id, x, y, tierWish: "B", size: { A: [100, 36], B: [120, 22], C: [40, 14] }, ...extra });
  const W = 300, Hh = 200;
  const placed = H.placeLabels([item("a", 150, 100), item("b", 150, 100)], { W, H: Hh, max: { A: 3, B: 10, C: 20 } });
  assert.deepEqual(placed.map((p) => [p.id, p.tier]), [["a", "B"], ["b", "B"]], "the second chip goes left of the same point");
  const three = H.placeLabels([item("a", 150, 100), item("b", 150, 100), item("c", 150, 100), item("d", 150, 100), item("e", 150, 100)], { W, H: Hh, max: { A: 3, B: 10, C: 20 } });
  assert.ok(three.some((p) => p.leader), "a farther spot, with a leader line");
  const cross = [160, 80, 40, 40], [x] = H.placeLabels([item("x", 150, 100)], { W, H: Hh, soft: [cross], max: { A: 3, B: 10, C: 20 } });
  assert.ok(x && !overlap(x, { x: 160, y: 80, w: 40, h: 40 }, 4) && x.x + x.w < 150, "a city by the crosshair gets its chip on the other side");
  const focus = H.placeLabels([item("f", 150, 100, { tierWish: "A", focus: true, size: { A: [100, 36] } })], { W, H: Hh, soft: [[140, 90, 20, 20], [100, 60, 100, 80]], max: { A: 3, B: 10, C: 20 } });
  assert.equal(focus.length, 1, "the city in focus keeps its chip right by the crosshair");
  const full = H.placeLabels([item("big", 150, 100, { size: { B: [400, 22], C: [40, 14] } })], { W, H: Hh, max: { A: 3, B: 10, C: 20 } });
  assert.deepEqual(full.map((p) => p.tier), ["C"], "too wide for a chip: its name");
});

test("helpers: how long until a window closes", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  assert.equal(H.until("2026-10-07T16:30:00Z", now), "1d 4h");
  assert.equal(H.until("2026-10-06T15:20:00Z", now), "3h 20m");
  assert.equal(H.until("2026-10-06T12:12:00Z", now), "12m");
  assert.equal(H.until("2026-10-06T11:00:00Z", now), "1m");
});

/* ---------------- the page: boundaries from the first view, stats without a tap, the glow's battery rules ---------------- */

test("map: every city's boundary from the first view (the overview loads with the page, not on zoom), the detailed files take over country by country", () => {
  const load = js.slice(js.indexOf("  async function load() {"));
  assert.ok(load.includes('fetch("/data/bounds-overview.txt")'), "fetched when the map loads");
  assert.ok(load.indexOf('fetch("/data/bounds-overview.txt")') < load.indexOf("await Promise.all(["), "in parallel with the city list and world.json");
  assert.equal((js.match(/fetch\("\/data\/bounds-overview\.txt"\)/g) || []).length, 1, "fetched once");
  const base = js.slice(js.indexOf("  function renderBase() {"), js.indexOf("  /* ---------- labels and chips"));
  assert.ok(base.includes("const fade = Math.max(0, Math.min(1, (k - (AREA_K - 0.5)) / 1));"), "the cross-fade over zoom 4.5–5.5");
  assert.ok(base.includes("const detail = fade > 0 && boundsDone.has(cc);") && base.includes("const ovAlpha = detail ? 1 - fade : 1;"), "a country whose file is not in yet keeps its overview: never a blank moment");
  assert.doesNotMatch(base, /if \(k >= AREA_K\) \{/, "no zoom gate in front of the boundaries any more");
  assert.equal(H.AREA_K, 5);
  // parsed a thousand lines at a time between frames, drawn as it arrives
  assert.match(js, /const end = Math\.min\(lines\.length, i \+ 1000\);/);
  assert.match(js, /window\.requestIdleCallback/);
  // the status colours of the spec's table
  for (const t of ["rgba(${pal.choosing},${0.18 * pal.a})", "rgba(${pal.founded},${0.32 * pal.a})", "rgba(${pal.mine},${0.3 * pal.a})", "dash: [3, 2]"]) assert.ok(base.includes(t), t);
});

test("map: on a phone the stats show with no tap: chips from the first view and the city-in-focus card, announced politely", () => {
  for (const h of [page, src]) {
    const stage = h.slice(h.indexOf('<div class="citymap__stage"'), h.indexOf('<p class="citymap__legend">'));
    for (const id of ["city-fx", "city-labels", "map-focus", "mf-name", "mf-where", "mf-ticker", "mf-status", "mf-amount", "mf-area", "mf-line", "mf-open", "mf-fold", "mf-say", "map-full", "map-exit", "map-scale"]) assert.ok(stage.includes(`id="${id}"`), id);
    assert.match(stage, /<canvas class="citymap__layer" id="city-fx"[^>]*aria-hidden="true"><\/canvas>/);
    assert.match(stage, /<canvas class="citymap__layer" id="city-labels"[^>]*aria-hidden="true"><\/canvas>/);
    assert.match(stage, /<p class="sr-only" id="mf-say" aria-live="polite"><\/p>/, "one polite announcement, once the map rests");
    assert.match(stage, /id="map-full" aria-label="Full-screen map" aria-pressed="false"/);
    assert.match(stage, /id="map-exit" aria-label="Close the full-screen map" hidden>/);
    assert.match(stage, /id="mf-fold" aria-expanded="true"/);
  }
  // the card follows the crosshair and says what the computer's hover card says
  const card = js.slice(js.indexOf("  function renderFocus() {"), js.indexOf("  /** Screen readers hear"));
  for (const t of ["Founder amount ${amt}", "Official boundary + nearest land", "Includes ${n} listed place", "No founder yet", "applying · closes in", "You founded ${c.name}", "No community here", "Nearest: "]) assert.ok(card.includes(t), t);
  assert.match(card, /tag\.className = `\$\{cls\} map-focus__status`; tag\.textContent = word; tag\.hidden = false;/, "the status pill shows (it is hidden only while no city is in focus)");
  assert.match(card, /setTimeout\(\(\) => \{ if \(turn !== swapping\) return; fill\(\);/, "a city that is no longer in focus never fills the card late");
  assert.match(js, /sayTimer = setTimeout\(\(\) => \{ const s = \$\("#mf-say"\);[^\n]*\}, 600\);/, "debounced to 600 ms");
  // chips from the first view: no zoom gate in front of the labels (they used to wait for zoom 2.5)
  assert.doesNotMatch(js, /if \(k >= 2\.5\)/);
  assert.match(js, /const max = \{ A: 3, B: phone \? 10 : 24, C: phone \? 20 : 60 \};/);
  // a tap still picks a city, but nothing needs one: the desktop hover card is unchanged
  assert.match(js, /if \(e\.pointerType === "mouse"\) \{/);
});

test("map: the glow is drawn from sprites, at most 30 frames a second, only when something moving is on screen", () => {
  assert.doesNotMatch(js, /shadowBlur/, "no blur on every frame");
  assert.match(js, /function glowSprite\(rgb\) \{/);
  assert.match(js, /gr\.addColorStop\(0, `rgba\(\$\{rgb\},\.9\)`\); gr\.addColorStop\(0\.4, `rgba\(\$\{rgb\},\.35\)`\); gr\.addColorStop\(1, `rgba\(\$\{rgb\},0\)`\);/);
  const frame = js.slice(js.indexOf("  function frame(now) {"), js.indexOf("  function kick()"));
  assert.match(frame, /if \(!onScreen \|\| document\.hidden \|\| !W\) \{ lastFrame = 0; return; \}/, "nothing off screen or in a hidden tab");
  assert.match(frame, /now - lastFx >= fxStep - 4/);
  assert.match(js, /fxStep = rings\.length \|\| over\.length \? 33 : 66;/, "30 frames a second at most, 15 for a slow breath");
  assert.match(js, /const fxAnimating = \(\) => !reduced && \(/, "with less motion, nothing loops");
  assert.match(js, /new IntersectionObserver\(\(es\) => \{ onScreen = es\.some\(\(x\) => x\.isIntersecting\);[^\n]*\.observe\(wrapEl\);/);
  assert.match(js, /window\.addEventListener\("vicinity:motion", motionChanged\);/, "the footer's Pause animations stops it at once");
  assert.match(js, /document\.documentElement\.dataset\.motion === "paused"/);
  assert.doesNotMatch(js, /setInterval\([^)]*draw/, "no timer-driven drawing");
  // the base layer is never drawn by the animation: only when the view changed (crisp at most every 100 ms while it moves)
  assert.match(js, /if \(dirty\.base\) \{ drawBase\(now\); dirty\.base = false; \}/);
  assert.match(js, /if \(moving && baseView && now - lastCrisp < 100\) \{/);
});

test("map stage CSS: big on every screen, full screen over the header and tab bar, the city card a fixed size; legend markers move only when welcome", () => {
  assert.match(css, /\.citymap__stage \{ position: relative; height: 560px; height: clamp\(560px, calc\(100vh - 186px\), 780px\);/);
  assert.match(css, /@media \(max-width: 1023px\) \{ \.citymap__stage \{ height: clamp\(480px, 70vh, 760px\); \} \}/);
  assert.match(css, /\.citymap__stage\.is-full \{ position: fixed; inset: 0; z-index: 90; height: 100vh; height: 100dvh; margin: 0; border-radius: 0; \}/);
  assert.match(css, /html\.map-is-full, html\.map-is-full body \{ overflow: hidden; \}/);
  assert.match(css, /\.map-focus \{ position: absolute; z-index: 2; left: 10px; right: 10px; bottom: 10px; height: 116px;/, "no layout shift");
  assert.match(css, /\.map-focus\.is-folded \{ height: 52px;/);
  assert.match(css, /\.map-focus__btn \{ width: 44px; height: 44px;/);
  assert.match(css, /\.map-exit \{[^}]*width: 44px; height: 44px;/);
  assert.match(css, /\.wrap \{ --wrap-pad: 24px; \}\n@media \(max-width: 480px\) \{ \.wrap \{ --wrap-pad: 16px; \} \}/);
  for (const t of ["--st-open: #7FA3D6", "--st-choosing: #FFC857", "--st-founded: #FF5A36", "--st-mine: #FFC857", "--chip-bg: rgba(7,14,25,.82)", "--st-open: #3F67A6", "--chip-bg: rgba(255,255,255,.92)"]) assert.ok(css.includes(t), t);
  // the legend's and the card's loops: inside the motion-welcome block, paused off screen / in a hidden tab (--lb-play)
  const block = css.slice(css.indexOf("  .map-focus__dot::after { animation:"), css.indexOf("}\n", css.indexOf("  .dot--mine::after { animation:")));
  const at = css.indexOf("  .map-focus__dot::after { animation:"), media = css.lastIndexOf("@media", at);
  assert.match(css.slice(media, at), /^@media \(prefers-reduced-motion: no-preference\) \{\n$/);
  for (const m of block.matchAll(/animation: (\w+) [^;]*;/g)) { assert.match(m[0], /var\(--lb-play, running\);$/, m[0]); assert.ok(["livePing", "shimmer", "lbBreath", "spin"].includes(m[1]), m[1]); }
});
