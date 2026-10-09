// The city map after the owner's ask of 9 Oct 2026: "city text labels must remain hidden when zoomed out so they do not obstruct status
// indicators; text labels should only render when a user zooms in directly on a specific city; a distinct colour indicator for cities
// that have verified holders, even if a city founder has not been designated yet". Pinned here:
// * the label rule (public/cities.js labelFilter, a pure helper): nothing below zoom LABEL_K; from there the city in focus (yours, the
//   selected one) once its boundary is big enough on screen, and the cities whose boundary spans LABEL_PX px around the crosshair, a
//   handful at a time; the page applies it and keeps every status marker clear of the chips;
// * the "active" status: verified holders (the per-city count /api/members sends: src/me.js handleMembers, team wallets not counted)
//   and no founder yet; founded and choosing come first; its colour has contrast in both themes and is never colour alone (a ring);
//   the legend, the marker, the glow layer, the city card, the tooltip, the panel, the list and the Most wanted list all say it;
// * the stats still show without a tap: the city card follows the crosshair at every zoom.
// How it looks is checked in Chromium against a mock /api (both viewports, both themes); this file pins the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { IN_NYC, IN_UTICA, MINT, browser, clock, newWorld, person, realClock, tick, useClock } from "./helpers/world.js";
import { ensureSchema } from "../src/store.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const js = read("public/cities.js"), css = read("public/style.css"), polish = read("public/polish-map.css"), page = read("public/cities.html"), src = read("scripts/pages/src/cities.html");

/** The pure helpers of public/cities.js (the "map helpers" block), run on their own. */
const H = (() => {
  const a = js.indexOf("  /* map helpers: start"), b = js.indexOf("  /* map helpers: end */");
  assert.ok(a > 0 && b > a);
  return vm.runInNewContext(`${js.slice(a, b)}\n({ LABEL_K, LABEL_PX, labelFilter, labelRank, byRank, placeLabels })`, {});
})();
const item = (id, x, y, span, extra = {}) => ({ id, x, y, span, ...extra });
const plain = (o) => JSON.parse(JSON.stringify(o)); // answers come from another realm: compared as plain values
const DESK = { phone: false, fx: 640, fy: 350, W: 1280, H: 700 }, PHONE = { phone: true, fx: 195, fy: 250, W: 390, H: 638 };

/* ---------------- the label rule ---------------- */

test("labels: none below zoom 8, whatever the city (the world, a continent, a country: markers and rings alone)", () => {
  assert.equal(H.LABEL_K, 8);
  const items = [item("focus", 640, 350, 400, { focus: true }), item("mine", 600, 300, 400, { mine: true }), item("sel", 700, 300, 400, { selected: true }), item("big", 650, 360, 900)];
  for (const k of [1, 1.5, 3, 5, 7.99]) {
    const r = H.labelFilter(items, k, DESK);
    assert.equal(r.ids.size, 0, `zoom ${k}`);
    assert.deepEqual(plain(r.max), { A: 0, B: 0, C: 0 });
  }
  assert.equal(H.labelFilter(items, NaN, DESK).ids.size, 0, "no zoom yet: nothing");
});

test("labels: from zoom 8 the city in focus (yours, the selected one) shows once its boundary spans 28 px on screen; a neighbour needs 56 px and the middle of the map", () => {
  assert.equal(H.LABEL_PX, 56);
  const near = (span) => H.labelFilter([item("f", 640, 350, span, { focus: true })], 8, DESK).ids.has("f");
  assert.equal(near(27), false, "a speck under the crosshair is not a city you zoomed in on");
  assert.equal(near(28), true);
  for (const flag of ["focus", "mine", "selected"]) assert.ok(H.labelFilter([item("x", 20, 20, 40, { [flag]: true })], 8, DESK).ids.has("x"), `${flag}: anywhere on the map`);
  const r = H.labelFilter([item("a", 700, 350, 56), item("b", 700, 350, 55), item("c", 640 + 400, 350, 300)], 8, DESK);
  assert.deepEqual([...r.ids], ["a"], "big enough and near the crosshair; b is too small; c is too far out (radius 175 px at zoom 8 on this stage)");
  assert.equal(r.radius, 175);
  // a city with a status is worth naming sooner: half the span (Utica, founded with 31 holders, stayed unnamed at 13× while open Buffalo got a chip)
  for (const st of ["founded", "choosing", "active", "mine"]) assert.ok(H.labelFilter([item("s", 700, 350, 28, { status: st })], 8, DESK).ids.has("s"), st);
  assert.equal(H.labelFilter([item("s", 700, 350, 27, { status: "founded" })], 8, DESK).ids.size, 0);
  assert.equal(H.labelFilter([item("o", 700, 350, 40, { status: "open" })], 8, DESK).ids.size, 0, "an open city needs the full 56 px");
});

test("labels: the budget grows with the zoom and stays a handful: 1 chip + 1 name on a phone at zoom 8, 4 + 6 from zoom 128; 2 + 2 to 8 + 12 on a computer", () => {
  const at = (k, v) => plain(H.labelFilter([], k, v).max);
  assert.deepEqual(at(8, PHONE), { A: 3, B: 1, C: 1 });
  assert.deepEqual(at(32, PHONE), { A: 3, B: 3, C: 4 });
  assert.deepEqual(at(128, PHONE), { A: 3, B: 4, C: 6 });
  assert.deepEqual(at(900, PHONE), { A: 3, B: 4, C: 6 }, "never more, however close");
  assert.deepEqual(at(8, DESK), { A: 3, B: 2, C: 2 });
  assert.deepEqual(at(128, DESK), { A: 3, B: 8, C: 12 });
  // the middle of the map widens with the zoom: a quarter of the shorter side at zoom 8, 45% from zoom 128
  assert.equal(H.labelFilter([], 8, PHONE).radius, 390 * 0.25);
  assert.equal(+H.labelFilter([], 128, PHONE).radius.toFixed(6), +(390 * 0.45).toFixed(6));
  assert.ok(H.labelFilter([], 32, DESK).radius > 175 && H.labelFilter([], 32, DESK).radius < 315);
});

test("labels: a wall of 600 cities around the crosshair comes out as a handful of chips and names, never overlapping, never on a status marker, and the same way every time", () => {
  let s = 11; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const W = 1280, Hh = 700;
  const items = Array.from({ length: 600 }, (_, i) => ({ id: "c" + i, x: 640 + (rnd() - 0.5) * 500, y: 350 + (rnd() - 0.5) * 500, span: 40 + rnd() * 200, focus: i === 0, status: i % 7 === 0 ? "active" : i % 11 === 0 ? "founded" : "open", holders: i % 7 === 0 ? 10 - (i % 10) : 0, pop: 1e6 - i }));
  const { ids, max } = H.labelFilter(items, 64, DESK);
  assert.ok(ids.size > 100, `${ids.size} cities qualify`);
  const want = items.filter((it) => ids.has(it.id)).sort(H.byRank);
  assert.equal(want[0].id, "c0", "the city in focus first");
  assert.ok(want.slice(1, 10).every((it) => it.status === "active" || it.status === "founded"), "then the cities with a status");
  const markers = items.filter((it) => it.status !== "open").map((it) => [it.x - 10, it.y - 10, 20, 20]);
  const placed = H.placeLabels(want.map((it) => ({ id: it.id, x: it.x, y: it.y, tierWish: it.focus ? "A" : "B", focus: it.focus, size: { A: [120, 36], B: [90, 22], C: [50, 14] } })),
    { W, H: Hh, core: [[640 - 16, 350 - 16, 32, 32], ...markers], max });
  const count = (t) => placed.filter((p) => p.tier === t).length;
  assert.equal(count("A"), 1); assert.ok(count("B") <= max.B && count("C") <= max.C, `${count("B")} chips, ${count("C")} names (budget ${max.B} + ${max.C})`);
  assert.ok(count("B") + count("C") >= 8, "the budget is used");
  const hit = (p, r) => p.x < r[0] + r[2] && r[0] < p.x + p.w && p.y < r[1] + r[3] && r[1] < p.y + p.h;
  for (const p of placed) for (const m of markers) assert.ok(!hit(p, m), `${p.id} covers a status marker at ${m[0] + 10},${m[1] + 10}`);
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.ok(!hit(placed[i], [placed[j].x - 4, placed[j].y - 4, placed[j].w + 8, placed[j].h + 8]), `${placed[i].id} × ${placed[j].id}`);
  assert.deepEqual(plain({ ...H.labelFilter(items, 64, DESK), ids: [...ids] }), plain({ ...H.labelFilter(items, 64, DESK), ids: [...H.labelFilter(items, 64, DESK).ids] }), "deterministic");
});

test("labels: the chip of the city in focus finds a place on a phone when its sides are off the stage and the near spots sit on the crosshair (Albany at 89×, 390 px)", () => {
  // the geometry Chromium showed: a 237 px chip for Albany ("Choosing its founder · $ALBANY · 210K"), the marker 8 px above the crosshair
  // (a fly-to centres the boundary, not the marker), Schenectady's marker up and left, the control rail on the right: no chip at all before
  // (the numbers the page passed, read with a probe: the near spot above ends at y 240 and the marker's own core starts at 239.75)
  const W = 390, Hh = 638, albany = { id: "albany", x: 185.5208288205249, y: 247.75468787901445, tierWish: "A", focus: true, size: { A: [235, 36] } };
  const opts = { W, H: Hh, avoid: [[336, 2, 52, 272], [2, 504, 386, 132], [10, 476.8125, 88, 29.1875]], soft: [[175, 236, 40, 40]],
    core: [[179, 240, 32, 32], [177.5208288205249, 239.75468787901445, 16, 16], [107.01459690710908, 177.08248173374523, 16, 16]], max: { A: 3, B: 4, C: 5 } };
  const [a] = H.placeLabels([albany], opts);
  assert.ok(a, "placed");
  assert.equal(a.tier, "A"); assert.equal(a.leader, true, "farther out, with a leader line");
  assert.deepEqual([a.x, a.y], [68, 288], "below the crosshair, 40 px down: the only free spot");
  assert.ok(a.y >= 272 || a.y + a.h <= 239.75, `clear of the crosshair: ${JSON.stringify(a)}`);
  assert.ok(a.x >= 6 && a.x + a.w <= W - 6, "inside the stage");
  for (const c of opts.core) assert.ok(!(a.x < c[0] + c[2] && c[0] < a.x + a.w && a.y < c[1] + c[3] && c[1] < a.y + a.h), `clear of the marker at ${c}`);
  // a B chip tries the corners a little farther out too; a plain name never moves away from its marker
  // a band above, a block on each side and one below the marker, with room only at the bottom left corner
  const corner = H.placeLabels([{ id: "b", x: 100, y: 100, tierWish: "B", size: { B: [60, 22], C: [30, 14] } }], { W: 300, H: 300, avoid: [[0, 0, 300, 78], [0, 78, 100, 40], [104, 78, 196, 40], [86, 122, 214, 178]], max: { A: 3, B: 2, C: 2 } });
  assert.deepEqual(plain(corner.map((p) => [p.id, p.tier, p.leader, p.x, p.y])), [["b", "B", true, 18, 122]], "the near sides and the far sides are taken: a corner");
  assert.match(js, /for \(const g of tier === "C" \? \[8\] : tier === "A" \? \[8, 22, 40\] : \[8, 22\]\) \{/);
});

test("labels: the rule is fast enough for hundreds of cities on every layout (a layout runs at most 10 times a second while the map moves)", () => {
  const items = Array.from({ length: 5000 }, (_, i) => item("c" + i, (i * 37) % 1280, (i * 91) % 700, 20 + (i % 300), { focus: i === 7 }));
  const t0 = performance.now();
  for (let n = 0; n < 20; n++) H.labelFilter(items, 40, DESK);
  const ms = (performance.now() - t0) / 20;
  assert.ok(ms < 25, `${ms.toFixed(2)} ms for 5,000 cities`);
});

test("labels: the page applies the rule: the stage's size, the crosshair, the phone budget; nothing is placed when nothing may show; every status marker is a core no chip covers", () => {
  const layout = js.slice(js.indexOf("  function layoutLabels(now) {"), js.indexOf("  // text widths measured before the site's fonts arrive"));
  assert.match(layout, /const \{ ids, max \} = labelFilter\(cands, k, \{ phone, fx: fcx, fy: fcy, W, H \}\);/);
  assert.match(layout, /const want = cands\.filter\(\(it\) => ids\.has\(it\.id\)\)\.sort\(/, "only the cities the rule allows, in priority order");
  assert.match(layout, /if \(st !== "open"\) markers\.push\(\[x - 10, y - 10, 20, 20\]\);/, "active, choosing, founded, yours: 20 px around the dot, the whole ring (choosing ends at r 9, active at 8.25: a 16 px core let a chip touch the ring's outer pixel)");
  assert.match(layout, /const placed = items\.length \? placeLabels\(items, \{ W, H, avoid, soft: \[\[fcx - 20, fcy - 20, 40, 40\]\], core: \[\[fcx - 16, fcy - 16, 32, 32\], \.\.\.markers\], max \}\) : \[\];/);
  assert.match(layout, /span: spanOf\(c\)/);
  assert.match(js, /const spanOf = \(c\) => \{ const a = ov\.byId\.get\(c\.id\) \|\| areas\.get\(c\.id\); return \(a \? Math\.max\(a\.box\[2\] - a\.box\[0\], a\.box\[3\] - a\.box\[1\]\) : \(2 \* radiusOf\(c\)\) \/ 111\.32\) \* s0 \* k; \};/, "the boundary's longer side in pixels (the overview's box from the first view, the detailed one later, a 25/50 km circle for a city with no outline)");
  assert.match(layout, /if \(wrapEl\.dataset\.labels !== n\) wrapEl\.dataset\.labels = n;/, "the stage says how many labels it carries (the Chromium check reads it)");
  // the stats without a tap: the city card at the bottom follows the crosshair at every zoom (unchanged), the hint says when names show
  assert.match(js, /function updateFocus\(\) \{/);
  for (const h of [page, src]) assert.match(h, /names show once you zoom in on a city/, "the legend's hint");
});

test("labels: priority: yours, selected, in focus, founded (by holders), choosing (by applicants), active (by holders), members, population", () => {
  const list = [{ id: "pop", pop: 9e6 }, { id: "mem", members: 3, pop: 10 }, { id: "act", status: "active", holders: 2 }, { id: "cho", status: "choosing", applicants: 2 }, { id: "fou", status: "founded", holders: 5 },
    { id: "act2", status: "active", holders: 9 }, { id: "foc", focus: true }, { id: "sel", selected: true }, { id: "mine", mine: true, status: "founded" }];
  assert.deepEqual(list.slice().sort(H.byRank).map((x) => x.id), ["mine", "sel", "foc", "fou", "cho", "act2", "act", "mem", "pop"]);
});

/* ---------------- the "active" status ---------------- */

/** statusOf, run with the page's maps. */
function status(c, { claims = new Map(), windows = new Map(), activeIds = new Set(), mine = () => false } = {}) {
  const line = js.slice(js.indexOf("  const statusOf = (c) =>"), js.indexOf("\n", js.indexOf("  const statusOf = (c) =>")));
  return vm.runInNewContext(`${line}\nstatusOf(c)`, { c, claims, windows, activeIds, isMine: mine });
}

test("active: verified holders and no founder yet; a founder or an open window comes first; yours first of all", () => {
  const c = { id: "5140405" };
  assert.equal(status(c), "open");
  assert.equal(status(c, { activeIds: new Set(["5140405"]) }), "active");
  assert.equal(status(c, { activeIds: new Set(["5140405"]), windows: new Map([["5140405", { applicants: 2 }]]) }), "choosing", "Albany: 9 holders and a window open: choosing");
  assert.equal(status(c, { activeIds: new Set(["5140405"]), claims: new Map([["5140405", { wallet: "x" }]]) }), "founded", "Utica: 31 holders and a founder: founded");
  assert.equal(status(c, { activeIds: new Set(["5140405"]), claims: new Map([["5140405", { wallet: "x" }]]), mine: () => true }), "mine");
  // where the ids come from: /api/members' per-city holders (members whose linked wallet holds $VICINITY; src/me.js leaves team wallets out)
  assert.match(js, /activeIds = new Set\(d\.communities\.filter\(\(c\) => c\.holders > 0\)\.map\(\(c\) => String\(c\.id\)\)\);/);
  const me = read("src/me.js");
  assert.match(me, /if \(holders && \(balances\[u\.wallet\] \|\| 0\) > 0 && !isTeamWallet\(u\.wallet\)\) holders\.set\(u\.home_city/, "the server's count: a positive balance, never a team wallet");
  assert.match(me, /communities: list\.map\(\(c\) => \(\{ \.\.\.c, holders: holders \? holders\.get\(c\.id\) \|\| 0 : null \}\)\)/, "null, unknown, while there is no balance sample (never 0)");
});

test("active: the marker always shows, has its own core dot, boundary fill, glow and a solid ring that stays with reduced motion (the shape, not the colour alone)", () => {
  assert.match(js, /const s = new Set\(\[\.\.\.claims\.keys\(\), \.\.\.windows\.keys\(\), \.\.\.activeIds\]\);/, "specialIds: drawn whatever the city's size, like founded and choosing");
  const base = js.slice(js.indexOf("  function renderBase() {"), js.indexOf("  /* ---------- labels and chips"));
  assert.match(base, /active: \{ fill: `rgba\(\$\{pal\.active\},\$\{0\.2 \* pal\.a\}\)`, line: `rgba\(\$\{pal\.active\},\$\{0\.85 \* pal\.a\}\)`, w: 1 \},/, "its boundary: a teal fill and a solid line (choosing is dashed)");
  assert.match(base, /st === "choosing" \? 3 : st === "active" \? 3\.2 : d \/ 2 \+ 0\.6/, "a core dot a little bigger than an open city's");
  const fx = js.slice(js.indexOf("  function drawFx(now, rest = false) {"), js.indexOf("  let fxStep = 33;"));
  assert.match(fx, /else if \(it\.st === "active"\) \{ a = still \? 0\.6 : 0\.45 \+ 0\.3 \* wave\(3\.2, it\.ph\); size = 34; \}/, "a glow that breathes slowly");
  const ring = /else if \(it\.st === "active"\) rings\.push\(\[0, 0, 0, 0, \(\) => \{\n\s*g\.strokeStyle = `rgba\(\$\{pal\.active\},\.95\)`; g\.lineWidth = 1\.5; g\.beginPath\(\); g\.arc\(x, y, 7\.5, 0, Math\.PI \* 2\); g\.stroke\(\);\n\s*\}\]\);/;
  assert.match(fx, ring, "a thin solid ring of radius 7.5 px");
  assert.doesNotMatch(fx.slice(fx.indexOf('else if (it.st === "active") rings.push')).split("\n")[0], /!still/, "drawn still or not: a founded city's ping and yours stop with reduced motion, this ring does not");
  assert.match(fx, /it\.st === "choosing" \? 11 : it\.st === "active" \? 10 : 0\) \+ 2;/, "the damage rectangle covers the ring");
  assert.match(js, /for \(const s of \["open", "choosing", "founded", "mine", "active"\]\) sprites\[s\] = glowSprite\(pal\[s\]\);/);
});

test("active: its colour comes from --st-active (polish-map.css, both themes), reads at 3:1 or more on the map's land and water of each theme, and the chips' text at 4.5:1", () => {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const dark = /^:root \{ --st-active: (#[0-9A-Fa-f]{6}); \}$/m.exec(polish), light = /^:root\[data-theme="light"\] \{ --st-active: (#[0-9A-Fa-f]{6}); \}$/m.exec(polish);
  assert.ok(dark && light, "defined for both themes");
  // the map's surfaces (style.css --map-land / --map-water of each theme) and the darkest and lightest ends of the map's background
  for (const s of ["#1b2e4d", "#0B1A2E", "#10203a", "#060c16"]) assert.ok(ratio(dark[1], s) >= 3, `dark ${dark[1]} on ${s}: ${ratio(dark[1], s).toFixed(2)}:1`);
  for (const s of ["#FFFFFF", "#D7E6F5", "#EAF1FA", "#DCE6F2"]) assert.ok(ratio(light[1], s) >= 3, `light ${light[1]} on ${s}: ${ratio(light[1], s).toFixed(2)}:1`);
  assert.match(css, /--map-land: #1b2e4d; --map-land-line/); assert.match(css, /--map-water: #0B1A2E;/); assert.match(css, /--map-land: #FFFFFF;/); assert.match(css, /--map-water: #D7E6F5;/);
  // a hue of its own in both themes: teal, at least 30° from open (steel blue), choosing and yours (gold) and founded (orange)
  const hue = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min; return d === 0 ? 0 : ((max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60) % 360; };
  for (const [theme, hex] of [["dark", dark[1]], ["light", light[1]]]) {
    const others = theme === "dark" ? ["#7FA3D6", "#FFC857", "#FF5A36"] : ["#3F67A6", "#B57F00", "#E8431F"];
    for (const o of others) { const d = Math.abs(hue(hex) - hue(o)); assert.ok(Math.min(d, 360 - d) >= 30, `${theme}: ${hex} (${hue(hex).toFixed(0)}°) vs ${o} (${hue(o).toFixed(0)}°)`); }
  }
  // the page reads it, with the same fallbacks, and the chips' text colours
  assert.match(js, /active: st\("--st-active", light \? "#0E7C63" : "#2ED3B7"\),/);
  assert.equal(dark[1].toUpperCase(), "#2ED3B7"); assert.equal(light[1].toUpperCase(), "#0E7C63");
  assert.match(js, /activeText: light \? "#0E7C63" : "#7CF0C5"/);
  assert.ok(ratio("#7CF0C5", "#070E19") >= 4.5 && ratio("#0E7C63", "#FFFFFF") >= 4.5, "on the chips' backgrounds");
  // the Open pill's text (--st-open, style.css) on the dark card and the light one, and apart from the Active pill's: the two used to be 7° and 1.2:1 apart
  assert.ok(ratio("#7FA3D6", "#0B1A2E") >= 4.5 && ratio("#3F67A6", "#FFFFFF") >= 4.5, `open pill text: ${ratio("#7FA3D6", "#0B1A2E").toFixed(1)}:1 dark, ${ratio("#3F67A6", "#FFFFFF").toFixed(1)}:1 light`);
  for (const [a, b] of [["#7FA3D6", "#2ED3B7"], ["#3F67A6", "#0E7C63"]]) { const d = Math.abs(hue(a) - hue(b)); assert.ok(Math.min(d, 360 - d) >= 40, `open vs active: ${a} ${hue(a).toFixed(0)}° vs ${b} ${hue(b).toFixed(0)}°`); }
  for (const t of ['l.st === "active" ? pal.activeText : pal.choosingText; g.fillText(l.t.name', 'l.st === "active" ? pal.activeText : pal.choosingText; g.fillText(l.t.a2']) assert.ok(js.includes(t), t);
  // the page loads the sheet after style.css (built from scripts/pages/src, where the setting lives)
  assert.match(src, /^<!--\{[^\n]*"styles": \["polish-map"\]\}-->/);
  // polish.css (the mobile-first polish of 9 Oct 2026) sits between the two on every page; polish-map.css still comes after style.css
  assert.match(page, /<link rel="stylesheet" href="\/style\.css">\n(  <link rel="stylesheet" href="\/polish\.css">\n)?  <link rel="stylesheet" href="\/polish-map\.css">/);
  assert.doesNotMatch(css, /st-active|dot--active|tag--active/, "nothing of it in style.css (a parallel branch edits that file)");
});

test("active: the legend, the city card, the tags and the tooltip carry the colour and the ring; the words say what it means", () => {
  for (const h of [page, src]) {
    assert.match(h, /<span><span class="dot dot--open" aria-hidden="true"><\/span> Open<\/span><span><span class="dot dot--active" aria-hidden="true"><\/span> Active: verified holders, no founder yet<\/span><span><span class="dot dot--choosing"/, "between Open and Choosing: the order a community moves through");
  }
  assert.match(polish, /\.dot--active \{ background: var\(--st-active\); box-shadow: 0 0 6px var\(--st-active\); \}/);
  assert.match(polish, /\.dot--active::before, \.map-focus\[data-status="active"\] \.map-focus__dot::before \{ content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var\(--st-active\); pointer-events: none; \}/, "the ring on the legend's dot and the card's dot");
  assert.match(css, /\.dot \{ position: relative; \}/); assert.match(css, /\.map-focus__dot \{ position: relative;/);
  assert.match(polish, /\.map-focus\[data-status="active"\] \{ --focus: var\(--st-active\); \}/, "the card's 3 px bar and dot");
  assert.match(polish, /\.tag--active \{ background: rgba\(46,211,183,\.14\); border-color: var\(--st-active\); color: var\(--st-active\); \}/);
  // the pills wear the legend's colours: Open steel blue (it shared the green of "Seat open" / "Join", 7° from the teal), and the Active pill carries the marker's ring as a glyph
  assert.match(polish, /^\.tag--open \{ background: rgba\(127,163,214,\.14\); border-color: rgba\(127,163,214,\.5\); color: var\(--st-open\); \}$/m);
  assert.match(polish, /^:root\[data-theme="light"\] \.tag--open \{ background: rgba\(63,103,166,\.1\); border-color: rgba\(63,103,166,\.45\); \}$/m);
  assert.match(polish, /^\.tag--active::before \{ content: ""; display: inline-block; box-sizing: border-box; width: 8px; height: 8px; [^\n]*border-radius: 50%; border: 1\.5px solid currentColor; background: radial-gradient\(circle, currentColor 1\.2px, transparent 1\.8px\); \}$/m, "a ring with a dot, in the pill's own colour");
  assert.match(polish, /^\.tag--open, \.tag--active \{ white-space: nowrap; \}/m, "a Most wanted row on a phone squeezes its pill: the glyph and the word stay on one line (the glyph is a break opportunity)");
  // Most wanted: style.css's `.wanted span { color: var(--muted) }` (0,1,1) used to grey every pill there; `.wanted li > .tag--x` (0,2,1) keeps their colour
  assert.match(css, /^\.wanted span \{ font-size: \.82rem; color: var\(--muted\); \}$/m);
  assert.match(polish, /^\.wanted li > \.tag--open \{ color: var\(--st-open\); \} \.wanted li > \.tag--active \{ color: var\(--st-active\); \} \.wanted li > \.tag--gold \{ color: var\(--gold-text\); \} \.wanted li > \.tag--no \{ color: var\(--bad-text\); \}$/m);
  assert.match(polish, /\.tip-active \{ color: var\(--st-active\); font-weight: 600; \}/);
  // the card
  assert.match(js, /const FOCUS_TAG = \{ open: \["tag tag--open", "Open"\], active: \["tag tag--active", "Active"\], choosing:/, "the card's pills: open in the open marker's blue, not the green of tag--ok");
  assert.match(js, /else if \(st === "active"\) l4 = `\$\{fmt\(h\)\} holder\$\{h === 1 \? "" : "s"\} · \$\{fmt\(m\)\} member\$\{m === 1 \? "" : "s"\} · no founder yet`;/, "the numbers first: a 320 px card cut the members count off the end of the old line");
  assert.doesNotMatch(js, /"tag tag--ok", mine \? "Yours"|"tag tag--ok", cl \? "Founded"|open: \["tag tag--ok"/, "no status pill is green any more (the nearby list's Join is an action, it keeps tag--ok)");
  assert.match(js, /const STATUS_WORD = \{ open: "Open", active: "Active", choosing: "Choosing its founder", founded: "Founded", mine: "Yours" \};/, "the chips and the announcement");
  // the tooltip, the panel, the list, Most wanted
  assert.match(js, /el\("span", cl \? "tip-claimed" : st === "active" \? "tip-active" : "tip-open",/);
  assert.ok(js.includes('st === "active" ? `Active: ${fmt(h)} verified holder${h === 1 ? "" : "s"}, no founder yet` : "Open")'));
  assert.ok(js.includes('activeIds.has(selected.id) ? "Active · verified holders, no founder yet" : "Open city"'), "the panel's kicker");
  assert.ok(js.includes('activeIds.has(c.id) ? "tag tag--active" : "tag tag--open", mine ? "Yours" : cl ? "Founded" : windows.has(c.id) ? "Choosing" : activeIds.has(c.id) ? "Active" : "Open"'), "the list's rows");
  assert.ok(js.includes('cl ? "tag tag--no" : win ? "tag tag--gold" : act ? "tag tag--active" : "tag tag--open", cl ? "Founded" : win ? "Choosing" : act ? "Active" : "Seat open"'), "Most wanted: Active instead of Seat open, in the map's order (founded, choosing, active)");
  assert.match(js, /win = windows\.has\(String\(c\.id\)\), h = holderCount\.get\(String\(c\.id\)\) \|\| 0, act = !cl && !win && h > 0;/, "Most wanted reads the counts the map keeps (the last known ones while the server has no sample), not the row's own");
  assert.ok(js.includes("${h ? ` · ${fmt(h)} holder${h === 1 ? \"\" : \"s\"}` : \"\"}"), "Most wanted: the holders next to the members");
});

/* ---------------- the city card test page (test/map-focus-card.test.js) still covers the card; here: the card for an active city ---------------- */

test("active: the card's fourth line for an active city, and a founded city's line is unchanged", () => {
  const slice = (from, to) => { const a = js.indexOf(from), b = js.indexOf(to, a); assert.ok(a > 0 && b > a, from); return js.slice(a, b); };
  const RENDER = slice("  function renderFocus() {", "  /** Screen readers hear");
  const node = () => ({ textContent: "", hidden: false, className: "", disabled: false, dataset: {}, setAttribute() {}, replaceChildren(...k) { this.textContent = k.map((x) => x.textContent).join(""); }, append(...k) { this.textContent += k.map((x) => x.textContent).join(""); } });
  const els = Object.fromEntries(["#mf-name", "#mf-where", "#mf-mini", "#mf-status", "#mf-ticker", "#mf-amount", "#mf-area", "#mf-line", "#mf-open", "#mf-say"].map((s) => [s, node()]));
  const focusEl = { dataset: {}, classList: { add() {}, remove() {}, contains: () => false } };
  const city = { id: "5140405", name: "Syracuse", cc: "US", pop: 144000 };
  const ctx = { focusEl, $: (s) => els[s], document: { createTextNode: (t) => ({ textContent: t }) }, el: (tag, c, t) => ({ textContent: t || "", href: "" }),
    byId: new Map([[city.id, city]]), claims: new Map(), windows: new Map(), members: new Map(), memberCount: new Map([[city.id, 12]]), holderCount: new Map([[city.id, 7]]), joined: new Set(),
    ov: { failed: false }, compact: new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }), fmt: (n) => Number(n).toLocaleString("en-US"), placeOf: () => "New York, United States",
    tickerOf: () => "SYRACUSE", founderMin: () => 240000, until: () => "1h", toLonLat: () => [0, 0], nearestCommunities: () => [], fcx: 0, fcy: 0,
    FOCUS_TAG: { open: ["tag tag--open", "Open"], active: ["tag tag--active", "Active"], founded: ["tag tag--no", "Founded"] }, STATUS_WORD: { open: "Open", active: "Active", founded: "Founded" },
    setTimeout: (f) => { f(); return 1; }, clearTimeout() {}, Date: { now: () => 0 } };
  vm.createContext(ctx);
  vm.runInContext(`let focusId = "5140405", focusSig = "", nearestGo = null, swapping = 0, sayTimer = 0, reduced = true, membersKnown = true, st0 = "active";
    const statusOf = () => st0; const areaFacts = () => null; const areaNote = () => ""; const announce = (t) => { $("#mf-say").textContent = t; };
    ${RENDER}
    this.api = { renderFocus, set: (s) => { st0 = s; focusSig = ""; } };`, ctx);
  ctx.api.renderFocus();
  assert.equal(focusEl.dataset.status, "active");
  assert.equal(els["#mf-status"].className, "tag tag--active map-focus__status"); assert.equal(els["#mf-status"].textContent, "Active");
  assert.equal(els["#mf-line"].textContent, "7 holders · 12 members · no founder yet", "the numbers first (a 320 px card cuts the end of the line); the pill above says Active");
  assert.match(els["#mf-say"].textContent, /^In focus: Syracuse, New York, United States\. Active\. \$SYRACUSE\. Founder amount 240K \$VICINITY\. 7 holders · 12 members · no founder yet\.$/);
  assert.equal(els["#mf-line"].textContent.length, 39, "fits a 320 px card at 12 px (the old 47-character line was cut after 'members' there)");
  ctx.api.set("open"); ctx.api.renderFocus();
  assert.equal(els["#mf-line"].textContent, "No founder yet · 12 members");
  ctx.claims.set("5140405", { status: "active", founder: "Sam" }); ctx.api.set("founded"); ctx.api.renderFocus();
  assert.equal(els["#mf-line"].textContent, "Founder @Sam · 7 holders");
});

/* ---------------- new data: the map says "active" the moment /api/members says so (M1 / F1 of the review, 9 Oct 2026) ---------------- */

/** refreshMembers, run with the page's state and stubs that record what it asks for. */
function membersPage() {
  const SLICE = js.slice(js.indexOf('  let membersSig = "", activeSig = "";'), js.indexOf("  function renderFeed(fresh = new Set()) {"));
  assert.ok(SLICE.includes("async function refreshMembers()") && SLICE.length < 4000, "the refreshMembers block");
  const ctx = { calls: [], tags: [], answer: null, $: () => ({ replaceChildren() {} }), byId: new Map(), claims: new Map(), windows: new Map(), countries: { US: "United States" }, fmt: (n) => String(n), sec: {}, reduced: true, select() {} };
  ctx.el = (tag, cls, txt) => { if (cls && /\btag\b/.test(cls)) ctx.tags.push(`${cls}|${txt}`); return { className: cls || "", textContent: txt || "", style: {}, append() {}, addEventListener() {} }; };
  ctx.V = () => ({ api: async () => ctx.answer });
  vm.createContext(ctx);
  vm.runInContext(`
    let memberCount = new Map(), holderCount = new Map(), activeIds = new Set(), totalMembers = 0, membersKnown = false, focusSig = "x";
    const dirty = { base: false, labels: false, layout: false, focus: false, fx: false };
    const log = (n) => () => calls.push(n);
    const kick = () => { dirty.fx = true; calls.push("kick"); };
    function markAll() { dirty.base = dirty.labels = dirty.layout = dirty.focus = true; calls.push("markAll"); kick(); }
    const renderFocus = log("renderFocus"), renderList = log("renderList"), refreshPanel = log("refreshPanel"), updateStats = log("updateStats");
    const chipCache = { clear: log("chipCache.clear") };
    ${SLICE}
    this.api = { refreshMembers, dirty, state: () => JSON.stringify({ active: [...activeIds].sort(), holders: Object.fromEntries(holderCount), members: Object.fromEntries(memberCount), total: totalMembers, known: membersKnown }), // a string: parsed in this realm (deepEqual minds the prototypes)
      reset: () => { for (const key of Object.keys(dirty)) dirty[key] = false; calls.length = 0; tags.length = 0; } };`, ctx);
  const run = async (communities, members = 100) => { ctx.api.reset(); ctx.answer = { members, communities }; await ctx.api.refreshMembers(); return { dirty: JSON.parse(JSON.stringify(ctx.api.dirty)), calls: ctx.calls.slice(), tags: ctx.tags.slice(), ...JSON.parse(ctx.api.state()) }; };
  return { run, ctx };
}
const SYR = { id: 5140405, name: "Syracuse", country: "US", members: 12, holders: 7 }, BUF = { id: 5110629, name: "Buffalo", country: "US", members: 5, holders: 0 };
const ALL = { base: true, labels: true, layout: true, focus: true, fx: true }, NONE = { base: false, labels: false, layout: false, focus: false, fx: false };

test("active: the first answer with holders marks the base (teal cores), the layout (rings, chips), the labels and the card dirty, clears the chip cache and re-renders the list and the panel: nothing waits for a gesture", async () => {
  const { run } = membersPage();
  const r = await run([SYR, BUF]);
  assert.deepEqual(r.active, ["5140405"]); assert.deepEqual(r.holders, { 5140405: 7, 5110629: 0 }); assert.equal(r.known, true);
  assert.deepEqual(r.dirty, ALL, "the same path refreshClaims takes for a new founder (markAll)");
  assert.deepEqual(r.calls.slice(0, 5), ["chipCache.clear", "markAll", "kick", "renderList", "refreshPanel"]);
  assert.ok(!r.calls.includes("renderFocus"), "the card is drawn by the frame (dirty.focus), not twice");
  assert.deepEqual(r.tags, ["tag tag--active|Active", "tag tag--open|Seat open"], "Most wanted: Syracuse active, Buffalo open, in the legend's colours");
});

test("active: the same answer again leaves the map alone (its glow may be resting): the card alone is written; new member counts with the same active cities wake the card only", async () => {
  const { run } = membersPage();
  await run([SYR, BUF]);
  const same = await run([SYR, BUF]);
  assert.deepEqual(same.dirty, NONE, "no kick: the resting glow stays asleep");
  assert.deepEqual(same.calls, ["renderFocus", "updateStats"]);
  const grew = await run([{ ...SYR, members: 13 }, { ...BUF, members: 6 }]);
  assert.deepEqual(grew.dirty, { ...NONE, focus: true, fx: true }, "the card follows the numbers; the base is not drawn again for a member count");
  assert.deepEqual(grew.calls, ["kick", "updateStats"]);
  assert.deepEqual(grew.members, { 5140405: 13, 5110629: 6 });
});

test("active: a city's first holder (the page's 30 s refresh) and the last one gone both redraw everything, as the data says", async () => {
  const { run } = membersPage();
  await run([SYR, BUF]);
  const buffalo = await run([SYR, { ...BUF, holders: 3 }]);
  assert.deepEqual(buffalo.active, ["5110629", "5140405"]); assert.deepEqual(buffalo.dirty, ALL);
  assert.ok(buffalo.calls.includes("markAll") && buffalo.calls.includes("renderList") && buffalo.calls.includes("refreshPanel"));
  assert.deepEqual(buffalo.tags, ["tag tag--active|Active", "tag tag--active|Active"]);
  const gone = await run([{ ...SYR, holders: 0 }, { ...BUF, holders: 0 }]);
  assert.deepEqual(gone.active, []); assert.deepEqual(gone.dirty, ALL, "back to open: the teal cores and rings must go too");
  assert.deepEqual(gone.tags, ["tag tag--open|Seat open", "tag tag--open|Seat open"]);
});

test("active: an answer with holders null on every row (the server had no balance sample) keeps the counts seen last: no city turns open, the map is not redrawn, Most wanted agrees with the map", async () => {
  const { run } = membersPage();
  const first = await run([{ ...SYR, holders: null }, { ...BUF, holders: null }]);
  assert.deepEqual(first.active, []); assert.deepEqual(first.holders, {}); assert.deepEqual(first.dirty, { ...NONE, focus: true, fx: true }, "nothing known yet: nothing active, the card alone");
  assert.deepEqual(first.tags, ["tag tag--open|Seat open", "tag tag--open|Seat open"]);
  await run([SYR, { ...BUF, holders: 3 }]);
  const unknown = await run([{ ...SYR, holders: null }, { ...BUF, holders: null }]);
  assert.deepEqual(unknown.active, ["5110629", "5140405"], "kept"); assert.deepEqual(unknown.holders, { 5140405: 7, 5110629: 3 });
  assert.deepEqual(unknown.dirty, { ...NONE, focus: true, fx: true }, "the set did not change: no redraw of the base");
  assert.deepEqual(unknown.tags, ["tag tag--active|Active", "tag tag--active|Active"], "Most wanted reads the kept counts, not the row's null");
  const back = await run([SYR, { ...BUF, holders: 3 }]);
  assert.deepEqual(back.dirty, { ...NONE, focus: true, fx: true }, "the sample is back with the same cities: still no redraw");
});

test("active: /api/members (the Worker) lists every community with a holder beyond the 300 largest, and says holders null (unknown) while there is no balance sample", async () => {
  useClock();
  try {
    const env = newWorld({ VICINITY_MINT: MINT });
    await ensureSchema(env.DB);
    // 300 communities of three people, written straight into users (throwaway values), as test/launchpad.test.js does
    const t = new Date(clock.now).toISOString(), rows = [];
    for (let i = 1; i <= 300; i++) for (let k = 0; k < 3; k++) {
      rows.push(env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, name, home_city, home_name, home_country, home_at, created_at) VALUES (?, 'google', ?, 'Someone', ?, ?, 'US', ?, ?)")
        .bind(`test-wallet-${i}-${k}`, `test-${i}-${k}`, `c${i}`, `Community ${i}`, t, t));
    }
    await env.DB.batch(rows);
    await person(env, { home: IN_UTICA, holds: 50 }); // Utica: two members, one holder
    await person(env, { home: IN_UTICA });
    await person(env, { home: IN_NYC });               // one member, no holder
    const b = browser(env);
    let m = await b.get("/api/members");
    assert.equal(m.members, 903);
    assert.equal(m.communities.length, 300, "no sample yet: the 300 largest alone");
    assert.ok(m.communities.every((c) => c.holders === null), "holders unknown, not 0");
    assert.deepEqual(m.communities[0], { id: "c1", name: "Community 1", country: "US", members: 3, holders: null });
    await tick(env); // the balance sample
    m = await b.get("/api/members");
    assert.equal(m.communities.length, 301);
    assert.ok(m.communities.slice(0, 300).every((c) => c.members === 3 && c.holders === 0), "the 300 largest first, as before");
    assert.deepEqual(m.communities[300], { id: "5142056", name: "Utica", country: "US", members: 2, holders: 1 }, "then the small community with a holder: the map paints it active");
    assert.equal(m.communities.some((c) => c.members === 1), false, "a small community without a holder is still not listed");
  } finally { realClock(); }
});
