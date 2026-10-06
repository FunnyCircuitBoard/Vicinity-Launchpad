// The light, world-wide city boundary layer of the map (/cities), so every city's outline shows from the very first view
// (the owner, 6 Oct 2026: "city boundaries without any zoom"). The detailed per-country files (public/data/bounds/<CC>.txt,
// 11 MB in all) are still what the map draws once you zoom in; this file is what it draws before that, for the whole world at once.
//
//   npm run bounds:overview         (after scripts/boundaries/3-build.mjs; test/map-overview.test.js fails while it is stale)
//
// Recipe, per city area of every <CC>.txt (kinds "r" and "n"; "p" and "o" lines carry no shape):
//   * the outer ring of each polygon (holes are invisible at world and continent zoom),
//   * Douglas-Peucker in plain degrees (the map is equirectangular, so a degree is the same on screen both ways) with TOL degrees,
//   * points snapped to a grid of 1/GRID degree, repeated points dropped,
//   * a ring that no longer encloses anything is dropped, unless it was the city's only one: then it becomes a one-cell square
//     around its centroid, so every city still has a visible outline,
//   * written as integers in grid units, delta-encoded (the first point absolute), the way the country files are.
// Output: public/data/bounds-overview.txt
//   line 1: "#vicinity-overview unit=<1/GRID> areas=<n> points=<n>"
//   then one line per area, in the order of the country files: "<id>\t<kind>\t<km²>\t[[x0,y0,dx1,dy1,…],…]"
//   kind: r = official boundary + nearest land, n = nearest land only (the country files' kinds);
//   km²: the area of the DETAILED boundary (holes taken out), computed exactly as public/cities.js does from the country file
//        (kmArea), so the map can say "2,986 km²" before it has loaded that country: an integer from 10 km² up, 3 decimals below;
//   the map computes each area's box itself.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GRID = 20;    // 1/20° ≈ 5.5 km at the equator: 0.25 px at the map's first view on a phone, about 1 px at zoom 5
export const TOL = 0.05;   // Douglas-Peucker tolerance in degrees
const SRC_UNIT = 1e-4;     // the country files store degrees × 1e4

/** Douglas-Peucker on an open polyline of [x, y] points (plain coordinates), keeping both ends. */
function dp(pts, tol) {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let best = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax, py = pts[i][1] - ay;
      const d = len > 1e-12 ? Math.abs(dx * py - dy * px) / len : Math.hypot(px, py);
      if (d > best) { best = d; at = i; }
    }
    if (best > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** A closed ring (first point repeated at the end or not), simplified: split at the point farthest from the first, so both halves are open lines. */
export function simplifyRing(ring, tol = TOL) {
  const pts = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring.slice();
  if (pts.length <= 3) return pts;
  let far = 1, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const a = dp(pts.slice(0, far + 1), tol), b = dp(pts.slice(far).concat([pts[0]]), tol);
  return a.concat(b.slice(1, -1));
}

/** Twice the signed area of a ring of integer grid points (shoelace). */
const area2 = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return s; };

/** Snap to the grid and drop repeats (also the closing repeat). */
export function quantize(ring, grid = GRID) {
  const out = [];
  for (const [x, y] of ring) {
    const q = [Math.round(x * grid), Math.round(y * grid)];
    const last = out.at(-1);
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  while (out.length > 1 && out[0][0] === out.at(-1)[0] && out[0][1] === out.at(-1)[1]) out.pop();
  return out;
}

const centroid = (ring) => { let x = 0, y = 0; for (const p of ring) { x += p[0]; y += p[1]; } return [x / ring.length, y / ring.length]; };

/** One city's area (polygons of rings in degrees) → its overview rings in grid units. Never empty for a non-empty area. */
export function overviewArea(area, { tol = TOL, grid = GRID } = {}) {
  const rings = [];
  let biggest = null, bigA = -1;
  for (const poly of area) {
    const outer = poly[0];
    if (!outer || outer.length < 3) continue;
    const a = Math.abs(area2(outer));
    if (a > bigA) { bigA = a; biggest = outer; }
    const q = quantize(simplifyRing(outer, tol), grid);
    if (q.length >= 3 && area2(q) !== 0) rings.push(q);
  }
  if (!rings.length && biggest) {
    const [cx, cy] = centroid(biggest), gx = Math.floor(cx * grid), gy = Math.floor(cy * grid);
    rings.push([[gx, gy], [gx + 1, gy], [gx + 1, gy + 1], [gx, gy + 1]]);
  }
  return rings;
}

/** The area in km² of a detailed city area, the same arithmetic as public/cities.js kmArea (so both print the same number). */
export const kmArea = (area) => { let s = 0; for (const poly of area) poly.forEach((r, i) => { let t = 0; for (let a = 0, b = r.length - 1; a < r.length; b = a++) t += (r[b][0] - r[a][0]) * (r[b][1] + r[a][1]); s += (i ? -1 : 1) * Math.abs(t / 2) * 111.32 * Math.cos((r[0][1] * Math.PI) / 180) * 110.57; }); return s; };
/** The stored form of an area: whole km² from 10 up (the map prints those rounded), 3 decimals below (it prints one). */
export const kmText = (km2) => (km2 >= 10 ? String(Math.round(km2)) : km2.toFixed(3));

const encode = (ring) => { const out = []; let px = 0, py = 0; for (const [x, y] of ring) { out.push(x - px, y - py); px = x; py = y; } return out; };
const decodeSrc = (flat) => { const r = new Array(flat.length / 2); let x = 0, y = 0; for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; r[i / 2] = [x * SRC_UNIT, y * SRC_UNIT]; } return r; };

/** The overview text for a folder of country files (sorted by file name, lines in file order: the output is deterministic). */
export function buildOverview(dir, opts = {}) {
  const grid = opts.grid || GRID;
  const lines = [];
  let points = 0;
  for (const file of readdirSync(dir).filter((f) => /^[A-Z]{2}\.txt$/.test(f)).sort()) {
    for (const line of readFileSync(new URL(file, dir), "utf8").split("\n")) {
      const [id, kind, , json] = line.split("\t");
      if (!json || (kind !== "r" && kind !== "n")) continue;
      const area = JSON.parse(json).map((poly) => poly.map(decodeSrc));
      const rings = overviewArea(area, opts);
      points += rings.reduce((n, r) => n + r.length, 0);
      lines.push(`${id}\t${kind}\t${kmText(kmArea(area))}\t${JSON.stringify(rings.map(encode))}`);
    }
  }
  return `#vicinity-overview unit=${1 / grid} areas=${lines.length} points=${points}\n${lines.join("\n")}\n`;
}

export const OVERVIEW_FILE = new URL("../../public/data/bounds-overview.txt", import.meta.url);
export const BOUNDS_DIR = new URL("../../public/data/bounds/", import.meta.url);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t0 = Date.now();
  const text = buildOverview(BOUNDS_DIR);
  writeFileSync(OVERVIEW_FILE, text);
  const { gzipSync } = await import("node:zlib");
  console.log(`${text.split("\n", 1)[0]} · ${text.length.toLocaleString("en-US")} bytes · ${gzipSync(text, { level: 9 }).length.toLocaleString("en-US")} gzipped · ${Date.now() - t0} ms`);
}
