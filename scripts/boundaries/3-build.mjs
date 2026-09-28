// Step 3 of the boundary build: turn the downloaded shapes into city areas that never overlap.
//  1. Real boundaries (OpenStreetMap). A place inside a bigger city's boundary, near its centre, is part
//     of that city (one coin: Brooklyn → New York City). Otherwise, where two overlap, the smaller city
//     keeps the shared part.
//  2. A listed place without a boundary inside another city's boundary is part of it too (a Dhaka
//     neighbourhood), unless it's far out in a very large boundary: then it gets its own area there.
//     Also part of a city: places Wikidata says are located in it (Brooklyn → New York City, step 1b),
//     and places at (almost) the same spot as a bigger one (Financial District → New York City).
//  3. Every other city gets the leftover land nearest to it (Voronoi), up to 25 km (50 km for 1M+
//     cities), cut to its country's coastline/borders and around real boundaries.
//  4. Communities merge by "the bigger the place, the farther it reaches" (details in step 4b); the
//     county seat names a merged coin when sizes are close. Big cities keep their neighbours.
//  5. No overlaps: areas are rounded to the stored precision first, then any two that still share
//     more than 1 m² (any country) give the shared part to one of them (overlaps.mjs).
//  Hand corrections: scripts/boundaries/metro-overrides.json
// Output: public/data/bounds/XX.txt (one line per city; format described in src/geo.js)
//         public/data/bounds/index.json (per country: bounding box and file size, for the map)
//         public/data/world.json (simplified country outlines for the map background)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import pc from "polygon-clipping";
import { Delaunay } from "d3-delaunay";
import { encodeArea, inArea } from "../../src/geo.js";
import { simplify } from "./simplify.mjs";
import { findOverlaps, pairKey, removeOverlaps, repair, robust, sharedKm2, weld } from "./overlaps.mjs";
import { distanceKm, radiusFor } from "../../src/cities.js";

const CACHE = ".cache/boundaries";
const OUT = "public/data/bounds";
const OVERRIDES = "scripts/boundaries/metro-overrides.json";
// CITIES = the city list (default the site's), SHAPES = folder of downloaded shapes (default "shapes")
const data = JSON.parse(readFileSync(process.env.CITIES || "public/data/cities.json", "utf8"));
const SHAPES = process.env.SHAPES || "shapes";
// A community (a place with its own coin and area) needs this many people. Smaller places become part
// of the community around them, or are "outside" (empty land: people there pick a nearby community).
const MIN_COMMUNITY = 4000;

// ---- helpers --------------------------------------------------------------------------------
const bboxOf = (area) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const poly of area) for (const [x, y] of poly[0]) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
};
const inBox = (lon, lat, b) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
/** A 1° grid of boxes, to find what's at a point without checking everything. */
function gridOf(items, boxOfItem) {
  const g = new Map();
  for (const it of items) {
    const b = boxOfItem(it);
    for (let x = Math.floor(b[0]); x <= Math.floor(b[2]); x++)
      for (let y = Math.floor(b[1]); y <= Math.floor(b[3]); y++) { const k = x + "," + y; (g.get(k) ?? g.set(k, []).get(k)).push(it); }
  }
  return (lon, lat) => g.get(Math.floor(lon) + "," + Math.floor(lat)) || [];
}
const hits = (p, q) => p[0] <= q[2] && q[0] <= p[2] && p[1] <= q[3] && q[1] <= p[3];
const kmArea = (area) => {
  let s = 0;
  for (const [outer, ...holes] of area) for (const [i, r] of [outer, ...holes].entries()) {
    let t = 0;
    for (let k = 0, j = r.length - 1; k < r.length; j = k++) t += (r[j][0] - r[k][0]) * (r[j][1] + r[k][1]);
    const kx = 111.32 * Math.cos((r[0][1] * Math.PI) / 180);
    s += (i === 0 ? 1 : -1) * Math.abs(t / 2) * kx * 110.57;
  }
  return s;
};
/** polygon-clipping sometimes trips on near-duplicate points or collinear borders: retry on a slightly
 *  rounded copy, then with the other shapes shifted by a hair (see robust() in overlaps.mjs). */
function clip(op, subject, ...others) {
  try { return pc[op](subject, ...others); } catch {
    const r = (g) => g.map((poly) => poly.map((ring) => ring.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5])));
    try { return pc[op](r(subject), ...others.map(r)); } catch { /* next */ }
    for (const e of [1e-9, -1e-9, 1e-8]) {
      const s = (g) => g.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x + e, y + e * 0.7])));
      try { return pc[op](subject, ...others.map(s)); } catch { /* next */ }
    }
    return null;
  }
}
const circle = (lat, lon, km, n = 64) => {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    ring.push([lon + (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(t), lat + (km / 110.57) * Math.sin(t)]);
  }
  ring.push(ring[0]);
  return [[ring]];
};

// ---- country outlines (Natural Earth, public domain) ----------------------------------------
const NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson";
if (!existsSync(`${CACHE}/countries.geojson`)) {
  const res = await fetch(NE_URL);
  if (!res.ok) throw new Error(`couldn't download country outlines (${res.status})`);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(`${CACHE}/countries.geojson`, await res.text());
}
// territories Natural Earth draws as part of another country
const PARENT = { GF: "FR", GP: "FR", MQ: "FR", RE: "FR", YT: "FR", BQ: "NL", CC: "AU", CX: "AU", SJ: "NO" };
const outlines = new Map();
for (const f of JSON.parse(readFileSync(`${CACHE}/countries.geojson`, "utf8")).features) {
  const p = f.properties;
  const code = [p.ISO_A2_EH, p.ISO_A2, p.WB_A2].find((v) => v && v !== "-99");
  if (!code) continue;
  const g = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  outlines.set(code, [...(outlines.get(code) ?? []), ...g.map((poly) => ({ poly, box: bboxOf([poly]) }))]);
}

// light world map for the background: every country, heavily simplified (≈ 5 km), tiny islands dropped
{
  const world = {};
  for (const [code, parts] of outlines) {
    const polys = parts
      .map(({ poly, box }) => ((box[2] - box[0]) * (box[3] - box[1]) < 0.02 ? null : poly.map((r) => simplify(r, 0.05)).filter((r) => r.length >= 4)))
      .filter((p) => p?.length);
    // same delta encoding as the city files, but in 0.01° units
    const enc = (ring) => { let px = 0, py = 0; return ring.flatMap(([x, y]) => { const X = Math.round(x * 100), Y = Math.round(y * 100), d = [X - px, Y - py]; px = X; py = Y; return d; }); };
    if (polys.length) world[code] = polys.map((poly) => poly.map(enc));
  }
  writeFileSync("public/data/world.json", JSON.stringify({ source: "Natural Earth (public domain)", unit: 0.01, countries: world }));
}

// ---- 1. real boundaries, smaller wins ---------------------------------------------------------
const cities = [];
for (const [cc, rows] of Object.entries(data.byCountry))
  for (const [id, name, adm, lat, lon, pop, seat] of rows) cities.push({ id: String(id), name, cc, adm, lat, lon, pop: pop || 0, seat: seat === 1 });
const byId = new Map(cities.map((c) => [c.id, c]));
// communities: 4,000+ people, and every country's three biggest places (so small territories have one)
for (const rows of Object.values(data.byCountry)) rows.slice().sort((a, b) => b[5] - a[5]).slice(0, 3).forEach((r) => (byId.get(String(r[0])).community = true));
for (const c of cities) if (c.pop >= MIN_COMMUNITY) c.community = true;
console.log(`${cities.filter((c) => c.community).length.toLocaleString()} places are big enough to be a community (of ${cities.length.toLocaleString()} listed)`);

// Which of a city's matching boundaries is "the city"?
//  - a boundary tagged with the city's own Wikidata item beats a name match
//  - then the usual city level: municipality (8), then 7, 6, 9, 5, 4 (e.g. Antwerp the city at 8,
//    not the old-town district of the same name at 9; São Paulo the city at 8, not the state at 4)
//  - never a boundary where the city's population would be impossibly dense (> 60,000 per km²),
//    e.g. London must not become the 3 km² "City of London"
const LEVEL_RANK = [8, 7, 6, 9, 5, 4, 10, 3, 2];
const rank = (level) => { const i = LEVEL_RANK.indexOf(level); return i < 0 ? 99 : i; };
const MAX_DENSITY = 60_000;

// the same OSM boundary chosen by two listed places → the more populous place keeps it
const relOwner = new Map();
const missing = [];
let tooDense = 0;
for (const cc of Object.keys(data.byCountry)) {
  const file = `${CACHE}/${SHAPES}/${cc}.json`;
  if (!existsSync(file)) { missing.push(cc); continue; }
  const { cities: matches, shapes } = JSON.parse(readFileSync(file, "utf8"));
  for (const [id, list] of Object.entries(matches)) {
    const c = byId.get(id);
    if (!c?.community) continue; // only communities get an area of their own
    const ok = list
      .filter((m) => !c.pop || c.pop / Math.max(0.01, kmArea(shapes[m.rel])) <= MAX_DENSITY)
      .sort((a, b) => b.byQ - a.byQ || rank(a.level) - rank(b.level));
    if (!ok.length) { tooDense++; continue; }
    const rel = ok[0].rel, prev = relOwner.get(rel);
    if (!prev || (c.pop || 0) > (prev.city.pop || 0)) relOwner.set(rel, { city: c, area: shapes[rel] });
  }
}
if (tooDense) console.log(`${tooDense} cities matched only boundaries far too small for their population (they use nearest areas)`);
if (missing.length) console.warn(`no shapes yet for ${missing.length} countries (their cities use nearest areas): ${missing.join(" ")}`);
const real = [...relOwner.values()].map(({ city, area }) => ((city.real = area), (city.rbox = bboxOf(area)), city));

// Very large official boundaries (Chinese prefecture cities, Beijing's 16,000 km²) don't need 45 m
// detail: simplify them to ≈ 150 m (over 1,000 km²) to keep files small. Not coarser: 300 m made Hangzhou's
// border a few long straight lines that cut back and forth across Zhuji's, and the overlap never settled.
for (const c of real) {
  const km2 = kmArea(c.real), tol = km2 > 1_000 ? 0.0015 : 0;
  if (tol) { c.real = c.real.map((poly) => poly.map((ring) => simplify(ring, tol))); c.rbox = bboxOf(c.real); }
}

// Some official boundaries include a lot of sea (Ho Chi Minh City's reaches out to Côn Đảo island:
// 36,000 km², of which 6,400 km² is land). When more than a third of a boundary is water, keep the land.
let trimmed = 0;
for (const c of real) {
  const land = outlines.get(c.cc) ?? outlines.get(PARENT[c.cc]);
  const near = land?.filter((l) => hits(c.rbox, l.box)).map((l) => l.poly);
  if (!near?.length) continue;
  const onLand = clip("intersection", c.real, near);
  if (onLand?.length && kmArea(onLand) < (kmArea(c.real) * 2) / 3 && inArea(c.lon, c.lat, onLand)) {
    c.real = onLand; c.rbox = bboxOf(onLand); trimmed++;
  }
}
console.log(`${trimmed} official boundaries trimmed to the coastline`);

// ---- one coin per big city ---------------------------------------------------------------------
// A listed place inside a bigger city's official boundary, within that city's reach, is part of it
// (Brooklyn, Manhattan, East New York → New York City; Mirpur, Motijheel → Dhaka), even when it has
// an official boundary of its own. Far out in a very large boundary (Chongqing's districts, the towns
// of western Tokyo-to) a place keeps its own coin and area.
const BIG = 500_000;
const mergeInto = new Map(); // place with an area of its own → the city whose coin (and area) it joins
const reachKm = (c) => ((c.pop || 0) >= 5e6 ? 35 : (c.pop || 0) >= 1e6 ? 25 : 15);
const overrides = existsSync(OVERRIDES) ? JSON.parse(readFileSync(OVERRIDES, "utf8")) : {};
// Wikidata "located in" links between listed places (step 1b); optional
const locatedIn = existsSync(`${CACHE}/located-in.json`) ? JSON.parse(readFileSync(`${CACHE}/located-in.json`, "utf8")) : {};
const keepSeparate = new Set((overrides.keepSeparate || []).map(String));
// Cities that keep only their own official boundary: they never take in neighbouring communities by
// reach (step 4b), so the cities around them keep their own coins (New York City: the five boroughs).
const officialOnly = new Set((overrides.officialOnly || []).map(String));
const top = (c) => {
  for (let i = 0; i < 50; i++) { const n = c.parentCity || mergeInto.get(c); if (!n) return c; c = n; }
  throw new Error(`merge loop around ${c.name} (${c.id}): check scripts/boundaries/metro-overrides.json`);
};
const absorbs = (b, c) => b !== c && b.cc === c.cc && (b.pop || 0) > (c.pop || 0) && !keepSeparate.has(c.id)
  && distanceKm(c.lat, c.lon, b.lat, b.lon) <= reachKm(b);

const realBy = Map.groupBy(real, (c) => c.cc);
for (const c of real) {
  const owners = realBy.get(c.cc).filter((b) => absorbs(b, c) && inBox(c.lon, c.lat, b.rbox) && inArea(c.lon, c.lat, b.real));
  if (owners.length) c.parentCity = owners.sort((a, b) => b.pop - a.pop)[0];
}
const standalone = real.filter((c) => !c.parentCity);
standalone.sort((a, b) => kmArea(a.real) - kmArea(b.real));

// official boundaries that only partly overlap: the smaller city keeps the shared part
const placed = [];
for (const c of standalone) {
  const box = bboxOf(c.real);
  const over = placed.filter((p) => hits(box, p.box)).map((p) => p.area);
  const area = over.length ? clip("difference", c.real, ...over) : c.real;
  if (!area?.length) { delete c.real; continue; }
  c.area = area; c.kind = "r"; c.box = bboxOf(area);
  placed.push({ area, box: c.box, city: c });
}
console.log(`real boundaries: ${placed.length}`);

// ---- 2. places inside another city's real boundary -------------------------------------------
// within reach → part of that city; far inside a very large boundary → an "enclave" that gets its own
// nearest-land area, cut out of the big boundary in step 3
// (a place too small to be a community is part of the boundary it sits in, however far out)
const placedAt = gridOf(placed, (p) => p.box);
for (const c of cities) {
  if (c.kind || c.parentCity) continue;
  const owner = placedAt(c.lon, c.lat).find((p) => inBox(c.lon, c.lat, p.box) && inArea(c.lon, c.lat, p.area));
  if (!owner) continue;
  if (!c.community || absorbs(owner.city, c)) c.parentCity = owner.city;
  else c.enclaveOf = owner;
}

// ---- 2b. same spot, same coin; Wikidata "located in" ----------------------------------------
// A place that joins a city this way keeps its own nearest-land area in step 3, and that area goes to
// the city in step 4 (Staten Island's land becomes New York City's, not Elizabeth's).
for (const list of Map.groupBy(cities, (c) => c.cc).values()) {
  const free = list.filter((c) => !c.parentCity && !keepSeparate.has(c.id)).sort((a, b) => b.pop - a.pop);
  // Two communities at (almost) the same spot are one place: "New York City" and "Financial District"
  // share a point, so do "Queens" and "Ozone Park". The smaller one joins the bigger one.
  const cells = new Map(), cell = (c) => `${Math.floor(c.lon * 20)},${Math.floor(c.lat * 20)}`; // ≈ 5 km cells
  for (const c of free) {
    if (!c.community) continue;
    const [x, y] = cell(c).split(",").map(Number);
    let b = null;
    for (let dx = -1; dx <= 1 && !b; dx++) for (let dy = -1; dy <= 1 && !b; dy++)
      b = (cells.get(`${x + dx},${y + dy}`) || []).find((o) => !o.parentCity && distanceKm(c.lat, c.lon, o.lat, o.lon) < 1.5) || null;
    if (b && c.kind !== "r") { c.parentCity = top(b); continue; } // same point: no land of its own to bring
    (cells.get(cell(c)) ?? cells.set(cell(c), []).get(cell(c))).push(c);
  }
  // Wikidata says the place is located in a bigger listed city (Brooklyn → New York City,
  // Carabanchel → Madrid, Pinheiros → São Paulo), whether or not we have that city's official
  // boundary. Guarulhos is in São Paulo *state*, not the city, so it keeps its own coin.
  // The distance limit guards against far-flung districts of huge municipalities (and bad data).
  for (const c of free) {
    if (c.parentCity || mergeInto.has(c) || c.enclaveOf) continue;
    const owner = (locatedIn[c.id] || []).map((id) => byId.get(id))
      .filter((b) => b && b.cc === c.cc && b.pop > c.pop && distanceKm(c.lat, c.lon, b.lat, b.lon) <= reachKm(b))
      .sort((a, b) => b.pop - a.pop)[0];
    if (!owner || top(owner) === c) continue;
    if (c.community) mergeInto.set(c, owner); // brings its nearest land along (step 4)
    else c.parentCity = owner;                 // too small for land of its own
  }
}

// ---- 3. nearest land: fills the gaps between cities -------------------------------------------
// Every city gets the land nearest to it (Voronoi), cut to its country's coastline/borders and around
// official boundaries. Cities with an official boundary keep it as their core and add the land nearest
// to them up to about 25 km beyond its edge; cities without one get up to 25 km around their centre
// (50 km for 1M+ cities). Only land farther than that from every city stays empty.
const BEYOND_EDGE_KM = 25;
const citiesIn = Map.groupBy(cities, (c) => c.cc);
const edgeReachKm = (c) => {
  let far = 0;
  for (const [outer] of c.area) for (const [lon, lat] of outer) far = Math.max(far, distanceKm(c.lat, c.lon, lat, lon));
  return far + BEYOND_EDGE_KM;
};
for (const cc of Object.keys(data.byCountry)) {
  const rest = (citiesIn.get(cc) || []).filter((c) => c.community && !c.parentCity && (!c.kind || c.kind === "r"));
  if (!rest.length) continue;
  const kx = Math.cos(((rest.reduce((s, c) => s + c.lat, 0) / rest.length) * Math.PI) / 180);
  const pts = rest.map((c) => [c.lon * kx, c.lat]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const vor = Delaunay.from(pts).voronoi([Math.min(...xs) - 5, Math.min(...ys) - 5, Math.max(...xs) + 5, Math.max(...ys) + 5]);
  const land = outlines.get(cc) ?? outlines.get(PARENT[cc]) ?? null;
  rest.forEach((c, i) => {
    const cell = vor.cellPolygon(i);
    if (c.kind === "r") { // official boundary: add the nearest land around it
      if (!cell) return;
      let ext = clip("intersection", [[cell.map(([x, y]) => [x / kx, y])]], circle(c.lat, c.lon, edgeReachKm(c), 96));
      if (ext?.length && land) {
        const near = land.filter((l) => hits(bboxOf(ext), l.box)).map((l) => l.poly);
        ext = near.length ? clip("intersection", ext, near) : null;
      }
      if (ext?.length) {
        const over = placed.filter((p) => hits(bboxOf(ext), p.box)).map((p) => p.area);
        if (over.length) ext = clip("difference", ext, ...over);
      }
      const grown = ext?.length ? clip("union", c.area, ext) : null;
      if (grown?.length) {
        const p = placed.find((x) => x.city === c);
        c.core = c.area; // the official boundary itself: "hugging the city" is measured from this
        c.area = grown; c.box = bboxOf(grown);
        if (p) { p.area = grown; p.box = c.box; }
      }
      return;
    }
    if (!cell) { // same spot as a place kept separate by hand: share that place's coin
      c.parentCity = rest.filter((x) => x !== c).sort((a, b) => distanceKm(c.lat, c.lon, a.lat, a.lon) - distanceKm(c.lat, c.lon, b.lat, b.lon))[0];
      return;
    }
    let area = [[cell.map(([x, y]) => [x / kx, y])]];
    area = clip("intersection", area, circle(c.lat, c.lon, radiusFor(c)));
    if (area?.length && land) {
      const box = bboxOf(area);
      const near = land.filter((l) => hits(box, l.box)).map((l) => l.poly);
      // a city just off the Natural Earth coastline (small islands) keeps its circle rather than nothing
      const onLand = near.length ? clip("intersection", area, near) : null;
      if (onLand?.length) area = onLand;
    }
    if (area?.length && c.enclaveOf) {
      // an enclave's area is cut out of the big boundary it sits in (Voronoi cells never overlap,
      // so this can't clash with the other nearest-land areas)
      const e = c.enclaveOf;
      area = clip("intersection", area, e.area);
      const rest = area?.length ? clip("difference", e.area, area) : null;
      if (rest?.length) { e.area = e.city.area = rest; e.box = e.city.box = bboxOf(rest); }
      else area = null;
    } else if (area?.length) {
      const box = bboxOf(area);
      const over = placed.filter((p) => hits(box, p.box)).map((p) => p.area);
      if (over.length) area = clip("difference", area, ...over);
    }
    if (area?.length) { c.area = area; c.kind = "n"; c.box = bboxOf(area); }
    else if (c.enclaveOf) c.parentCity = c.enclaveOf.city; // nothing left to give it: it stays part of the big city
    else {
      // nothing left (its point is just off the coastline and a neighbour's official boundary covers
      // the land around it): part of the nearest official boundary within 5 km, if there is one
      const near = placed.filter((p) => p.city.cc === c.cc).map((p) => [p.city, kmToArea(c.lon, c.lat, p.area)]).sort((a, b) => a[1] - b[1])[0];
      if (near && near[1] <= 5) c.parentCity = near[0];
      else c.kind = "none";
    }
  });
}

// ---- 4. metro coins: a big city and its neighbouring cities and towns share one coin --------------
function kmToArea(lon, lat, area) {
  if (inArea(lon, lat, area)) return 0;
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180), ky = 110.57;
  let best = Infinity;
  for (const poly of area) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
    const ax = (ring[i - 1][0] - lon) * kx, ay = (ring[i - 1][1] - lat) * ky, dx = (ring[i][0] - lon) * kx - ax, dy = (ring[i][1] - lat) * ky - ay;
    const l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
/** Give each joining place's area to its city (union), and mark it part of that city. */
function applyMerges(pairs) {
  for (const [b, kids] of Map.groupBy(pairs, ([c]) => top(c))) {
    const shapes = [b.area, ...kids.map(([c]) => c !== b && c.area)].filter((x) => x?.length);
    const joined = shapes.length > 1 ? clip("union", ...shapes) : shapes[0];
    if (shapes.length > 1 && !joined?.length) { for (const [c] of kids) mergeInto.delete(c); continue; } // couldn't join: leave separate
    if (b.core) { // the city's core grows with the places that join it (their core, or their area)
      const cores = [b.core, ...kids.map(([c]) => c !== b && (c.core ?? c.area))].filter((x) => x?.length);
      b.core = (cores.length > 1 && clip("union", ...cores)) || b.core;
    }
    if (joined?.length) { b.area = joined; b.box = bboxOf(joined); if (b.kind !== "r") b.kind = "n"; }
    for (const [c] of kids) if (c !== b) { c.parentCity = b; delete c.area; }
  }
}
// 4a. joins decided above (Wikidata "located in") and hand-made ones (scripts/boundaries/metro-overrides.json)
for (const [childId, parentId] of Object.entries(overrides.merge || {})) {
  const c = byId.get(String(childId)), b = byId.get(String(parentId));
  if (c && b && c !== b) mergeInto.set(c, b);
}
applyMerges([...mergeInto]);

// 4b. "The bigger the place, the farther it reaches." Each community reaches out to
//     4 + 12 × log10(people / 5,000) km: about 4 km for 5,000 people, 16 km for 50,000, 20 km for
//     100,000, 28 km for 500,000 and 40 km for 5 million. Biggest first, a community joins the one
//     whose reach it is relatively deepest in, when:
//      - that one has 500k+ people and it has fewer (Denver keeps Aurora, Lakewood; Dhaka keeps
//        Narayanganj, Savar), unless that city is "official boundary only" (New York City), or
//      - it is at most half that one's size (Syracuse + Clay, Albany + Troy, Utica + Whitesboro), or
//      - it is right next door: within 40% of the reach, and at least 5 km (Herkimer + Ilion).
//     Otherwise it keeps its own coin (Rome, Herkimer, Little Falls next to Utica).
//     The county seat (or capital) names the coin when it is about as big as the biggest member
//     (within 25%): Herkimer + Ilion is "Herkimer". Nothing merges across a country border, and the
//     country manager can change any of it (scripts/boundaries/metro-overrides.json).
const reachOf = (pop) => (pop >= 5000 ? 4 + 12 * Math.log10(pop / 5000) : 3);
const metroJoined = new Set();
{
  const pairs = [];
  for (const list of Map.groupBy(cities.filter((c) => c.community && !c.parentCity && !mergeInto.has(c)), (c) => c.cc).values()) {
    const roots = [];
    for (const p of list.sort((a, b) => b.pop - a.pop)) {
      let best = null, bestRel = Infinity;
      if (!keepSeparate.has(p.id)) for (const b of roots) {
        if (officialOnly.has(b.id)) continue; // keeps only its official boundary
        if (Math.abs(b.lat - p.lat) > 0.5 || Math.abs(b.lon - p.lon) > 0.9) continue; // farther than any reach
        const d = distanceKm(p.lat, p.lon, b.lat, b.lon), r = reachOf(b.pop);
        if (d > r) continue;
        const ok = b.pop >= BIG ? p.pop < BIG : p.pop <= b.pop / 2 || d <= Math.max(0.4 * r, 5);
        if (ok && d / r < bestRel) { best = b; bestRel = d / r; }
      }
      if (best) best.members.push(p); else { p.members = []; roots.push(p); }
    }
    for (const root of roots) {
      if (!root.members.length) continue;
      const lead = [root, ...root.members].filter((x) => x.seat && x.pop >= 0.75 * root.pop).sort((a, b) => b.pop - a.pop)[0] || root;
      for (const m of [root, ...root.members]) if (m !== lead) { pairs.push([m, lead]); metroJoined.add(m); }
    }
  }
  for (const [m, lead] of pairs) mergeInto.set(m, lead);
  applyMerges(pairs);
}
for (const c of cities) if (c.parentCity) { c.kind = "p"; c.parent = top(c).id; }

// ---- 5. no overlaps, guaranteed ----------------------------------------------------------------
// The files store coordinates rounded to 1e-4° (≈ 11 m). Rounding each area on its own would make
// neighbours overlap in thin strips along every shared border, so round first, then cut: every pair of
// areas that still shares more than 1,000 m² (any country) gives the shared part to one of them.
// An official boundary beats a nearest-land area; otherwise the smaller area keeps it.
// Rounding can fold a ring back on itself (a → b → a: a zero-width spike lying on a neighbour's border).
// Remove corners where the ring doubles back, until none are left.
function despike(ring) {
  let r = ring.slice(0, -1), changed = true;
  while (changed && r.length > 3) {
    changed = false;
    for (let i = 0; i < r.length && r.length > 3; i++) {
      const p = r[(i - 1 + r.length) % r.length], c = r[i], n = r[(i + 1) % r.length];
      const ax = c[0] - p[0], ay = c[1] - p[1], bx = n[0] - c[0], by = n[1] - c[1];
      const same = (ax === 0 && ay === 0) || (bx === 0 && by === 0);
      const foldsBack = Math.abs(ax * by - ay * bx) < 1e-12 && ax * bx + ay * by < 0;
      if (same || foldsBack) { r.splice(i, 1); changed = true; i--; }
    }
  }
  return r.length >= 3 ? [...r, r[0]] : [];
}
const snap = (area) => area
  .map((poly) => poly.map((ring) => {
    const out = [];
    for (const [x, y] of ring) {
      const p = [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4], l = out[out.length - 1];
      if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p);
    }
    return despike(out);
  }))
  .filter((poly) => poly[0].length >= 4)
  .map((poly) => poly.filter((ring) => ring.length >= 4));
const withArea = cities.filter((c) => c.area?.length && c.kind !== "p");
// rounding can make an outline cross itself: rebuild those shapes cleanly (and round again)
const repairAll = (items) => {
  let n = 0;
  for (const c of items) { if (!c.area.length) continue; const fixed = repair(c.area); if (fixed !== c.area) { c.area = snap(fixed); c.box = bboxOf(c.area); n++; } }
  return n;
};
for (const c of withArea) { c.area = snap(c.area); c.box = bboxOf(c.area); }
console.log(`${repairAll(withArea)} self-crossing shapes rebuilt`);
// Cutting leaves a few vertices between grid points (where two borders cross). Rounding one of those
// tilts a long shared border and makes a thin wedge of overlap (Kiel × Neumünster: 37 km long,
// 0.06 km²). So each off-grid vertex goes to the nearest grid point that is outside every neighbour.
const onGrid = (v) => Math.abs(v * 1e4 - Math.round(v * 1e4)) < 1e-6;
function snapToFreeGrid(items) {
  const cells = new Map(), key = (x, y) => `${Math.floor(x)},${Math.floor(y)}`;
  for (const it of items) for (let x = Math.floor(it.box[0]); x <= Math.floor(it.box[2]); x++)
    for (let y = Math.floor(it.box[1]); y <= Math.floor(it.box[3]); y++) (cells.get(`${x},${y}`) ?? cells.set(`${x},${y}`, []).get(`${x},${y}`)).push(it);
  // strictly inside a neighbour: inside, and not just touching its border (shared borders are fine)
  const degToEdge = (a, b, area) => {
    let best = Infinity;
    for (const poly of area) for (const r of poly) for (let k = 1; k < r.length; k++) {
      const [x1, y1] = r[k - 1], dx = r[k][0] - x1, dy = r[k][1] - y1, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((a - x1) * dx + (b - y1) * dy) / l)) : 0;
      best = Math.min(best, Math.hypot(a - x1 - t * dx, b - y1 - t * dy));
    }
    return best;
  };
  const strictlyIn = (a, b, o) => inArea(a, b, o.area) && degToEdge(a, b, o.area) > 2e-7; // ≈ 2 cm
  let moved = 0;
  for (const it of items) for (const poly of it.area) for (const ring of poly) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x, y] = ring[i];
      if (onGrid(x) && onGrid(y)) continue;
      const others = (cells.get(key(x, y)) || []).filter((o) => o !== it && inBox(x, y, [o.box[0] - 1e-3, o.box[1] - 1e-3, o.box[2] + 1e-3, o.box[3] + 1e-3]));
      const prev = ring[(i - 1 + ring.length - 1) % (ring.length - 1)], next = ring[i + 1];
      const fx = Math.floor(x * 1e4), fy = Math.floor(y * 1e4);
      const cands = [[fx, fy], [fx + 1, fy], [fx, fy + 1], [fx + 1, fy + 1]].map(([a, b]) => [a / 1e4, b / 1e4])
        .sort((p, q) => Math.hypot(p[0] - x, p[1] - y) - Math.hypot(q[0] - x, q[1] - y));
      // the point, and the middle of both edges it touches, must stay out of every neighbour
      // the point, and points all along both edges it touches (a long edge can cross into a wiggly
      // neighbour away from its middle: Hangzhou × Zhuji), must stay out of every neighbour
      const along = (p, q) => [1, 2, 3, 4, 5, 6, 7].map((f) => [p[0] + ((q[0] - p[0]) * f) / 8, p[1] + ((q[1] - p[1]) * f) / 8]);
      const ok = (p) => !others.some((o) => [p, ...along(p, prev), ...along(p, next)].some(([a, b]) => strictlyIn(a, b, o)));
      const pick = cands.find(ok);
      ring[i] = pick ?? [NaN, NaN]; // no safe grid point: drop this corner (a hairline gap, never an overlap)
      moved++;
    }
    ring[ring.length - 1] = ring[0];
  }
  for (const it of items) it.area = it.area.map((poly) => poly.map((ring) => {
    const r = ring.filter(([x]) => !Number.isNaN(x));
    if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0]);
    return r;
  }));
  for (const it of items) { it.area = snap(it.area); it.box = it.area.length ? bboxOf(it.area) : [0, 0, 0, 0]; }
  return moved;
}
const MIN_OVERLAP_KM2 = 1e-6; // 1 m²: anything bigger is an overlap to remove
const seenPairs = new Map(), flip = new Set();
for (let round = 1; round <= 8; round++) {
  const live = withArea.filter((c) => c.area.length);
  const { removed, failed } = removeOverlaps(live, MIN_OVERLAP_KM2, flip);
  const moved = snapToFreeGrid(live);
  repairAll(live);
  const left = findOverlaps(live.filter((c) => c.area.length), MIN_OVERLAP_KM2);
  // Two versions of one long border that start at slightly different corners leave a hair-thin sliver
  // no rounding can fix: weld them (put the corner into the neighbour's edge) and check again.
  let welded = 0;
  for (const { a, b } of left) welded += weld(a, b, 2e-5);
  const still = welded ? findOverlaps(live.filter((c) => c.area.length), MIN_OVERLAP_KM2) : left;
  console.log(`overlap round ${round}: ${removed} removed, ${moved} border crossings snapped, ${welded} corners welded, ${still.length} left${failed.length ? `, couldn't cut ${failed.length}` : ""}`);
  if (!still.length) break;
  for (const { a, b } of still) { const k = pairKey(a, b), n = (seenPairs.get(k) || 0) + 1; seenPairs.set(k, n); if (n >= 2) flip.add(k); }
}
// Last resort for a pair whose sliver comes back after every rounding (Hangzhou × Zhuji): cut a small
// box, lined up with the rounding grid and ≈ 30 m wider than the sliver, out of the bigger area.
// Rounding can't reach back across that margin; it leaves a hairline gap, never an overlap.
{
  const g = 1e-4, m = 3e-4, down = (v) => Math.round(Math.floor(v / g) * g * 1e4) / 1e4 - m, up = (v) => Math.round(Math.ceil(v / g) * g * 1e4) / 1e4 + m;
  let notched = 0;
  for (const { a, b } of findOverlaps(withArea.filter((c) => c.area.length), MIN_OVERLAP_KM2)) {
    const shared = robust("intersection", a.area, b.area);
    if (!shared?.length) continue;
    const lose = a.kind !== b.kind ? (a.kind === "r" ? b : a) : kmArea(a.area) >= kmArea(b.area) ? a : b;
    const [x0, y0, x1, y1] = bboxOf(shared);
    const box = [[[[down(x0), down(y0)], [up(x1), down(y0)], [up(x1), up(y1)], [down(x0), up(y1)], [down(x0), down(y0)]]]];
    const rest = robust("difference", lose.area, box);
    if (!rest?.length) continue;
    // keep the cut only if it really shrinks the overlap
    const before = sharedKm2(a.area, b.area), old = [lose.area, lose.box];
    lose.area = snap(rest); lose.box = bboxOf(lose.area);
    const after = sharedKm2(a.area, b.area);
    if (after === null || (before !== null && after >= before)) [lose.area, lose.box] = old;
    else notched++;
  }
  const left = findOverlaps(withArea.filter((c) => c.area.length), MIN_OVERLAP_KM2);
  if (notched || left.length) console.log(`last resort: ${notched} stubborn slivers cut out with a small margin, ${left.length} left`);
}
// a city whose whole area went to a neighbour shares that neighbour's coin
for (const c of withArea) {
  if (c.area.length) continue;
  const owner = withArea.filter((o) => o !== c && o.area.length && o.cc === c.cc)
    .map((o) => [o, kmToArea(c.lon, c.lat, o.area)]).sort((a, b) => a[1] - b[1])[0];
  if (owner && owner[1] <= 5) { c.kind = "p"; c.parentCity = owner[0]; c.parent = top(owner[0]).id; delete c.area; }
  else c.kind = "none";
}

// tidy: drop tiny detached slivers (< 0.2 km²) left over from cutting and joining shapes
for (const c of cities) {
  if (!c.area || c.area.length < 2) continue;
  const kept = c.area.filter((poly) => kmArea([poly]) >= 0.2 || inArea(c.lon, c.lat, [poly]));
  if (kept.length) { c.area = kept; c.box = bboxOf(kept); }
}
// ---- 6. every smaller place: part of the community it sits in, or "outside" (empty land) ------------
{
  const areaAt = gridOf(cities.filter((c) => c.area?.length && c.kind !== "p"), (c) => c.box);
  for (const c of cities) {
    if (c.kind === "p" || c.area?.length) continue;
    const home = areaAt(c.lon, c.lat).find((o) => inBox(c.lon, c.lat, o.box) && inArea(c.lon, c.lat, o.area));
    if (home) { c.kind = "p"; c.parentCity = home; c.parent = top(home).id; }
    else c.kind = "o"; // people here pick one of the three nearest communities
  }
}
console.log(`one coin per community: ${cities.filter((c) => c.kind === "p").length.toLocaleString()} listed places are part of a community (${metroJoined.size} of them merged by reach), ${cities.filter((c) => c.kind === "o").length.toLocaleString()} are outside every community`);

// ---- output -----------------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const index = {};
const stats = { r: 0, n: 0, p: 0, o: 0, none: 0 };
for (const cc of Object.keys(data.byCountry)) {
  const list = citiesIn.get(cc) || [];
  const lines = [];
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of list) {
    stats[c.kind]++;
    if (c.kind === "r" || c.kind === "n") {
      const b = c.box.map((v, i) => (i < 2 ? Math.floor(v * 1e4) : Math.ceil(v * 1e4)) / 1e4).join(",");
      lines.push(`${c.id}\t${c.kind}\t${b}\t${JSON.stringify(encodeArea(c.area))}`);
      box = [Math.min(box[0], c.box[0]), Math.min(box[1], c.box[1]), Math.max(box[2], c.box[2]), Math.max(box[3], c.box[3])];
    } else if (c.kind === "p") lines.push(`${c.id}\tp\t${c.parent}`);
    else if (c.kind === "o") lines.push(`${c.id}\to\t-`);
  }
  if (!lines.length) continue;
  const text = lines.join("\n") + "\n";
  writeFileSync(`${OUT}/${cc}.txt`, text);
  index[cc] = { box: box.map((v) => Math.round(v * 100) / 100), bytes: text.length };
}
// parts: listed places that are neighbourhoods of another city (child id → parent id), so the city
// list can say "part of Dhaka" before any country file is loaded
const parts = Object.fromEntries(cities.filter((c) => c.kind === "p").map((c) => [c.id, c.parent]));
// joined: the parts that sat outside the big city's own area and were added to it (West New York),
// so the map can say "official boundary + nearby towns" instead of just "official boundary"
const joined = [...metroJoined].filter((c) => c.kind === "p").map((c) => c.id);
// outside: small places in empty land (their people are offered the three nearest communities)
const outside = cities.filter((c) => c.kind === "o").map((c) => c.id);
writeFileSync(`${OUT}/index.json`, JSON.stringify({ source: "OpenStreetMap contributors (ODbL); Natural Earth; GeoNames (CC BY 4.0)", countries: index, parts, joined, outside }));
const total = Object.values(index).reduce((s, x) => s + x.bytes, 0);
console.log(`cities: ${stats.r} real boundary, ${stats.n} nearest area, ${stats.p} part of a community, ${stats.o} outside, ${stats.none} without area`);
console.log(`files: ${Object.keys(index).length} countries, ${(total / 1e6).toFixed(1)} MB total, biggest ${Object.entries(index).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 3).map(([k, v]) => `${k} ${(v.bytes / 1e6).toFixed(1)} MB`).join(", ")}`);
