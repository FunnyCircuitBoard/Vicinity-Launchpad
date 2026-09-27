import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { locate } from "../src/community.js";
import { _resetCityCache } from "../src/cities.js";
import { cityAt, decodeArea, encodeArea, findCityArea, inArea } from "../src/geo.js";
import { findOverlaps } from "../scripts/boundaries/overlaps.mjs";

// A square "Utica" (≈ 8 km across) with a hole, and a neighbourhood that is part of it.
const square = (lon, lat, d) => [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]];
const UTICA_AREA = [[square(-75.23, 43.1, 0.04), square(-75.2, 43.07, 0.005)]];
const line = (id, kind, area) => `${id}\t${kind}\t${[-75.27, 43.06, -75.19, 43.14].join(",")}\t${JSON.stringify(encodeArea(area))}`;
const US_BOUNDS = [line("5142056", "r", UTICA_AREA), "9999001\tp\t5142056"].join("\n") + "\n";

test("geometry: encode/decode round-trip, holes, one-line lookups", () => {
  const back = decodeArea(encodeArea(UTICA_AREA));
  assert.deepEqual(back[0][0][2], [-75.19, 43.14]);
  assert.equal(inArea(-75.23, 43.1, back), true);          // inside
  assert.equal(inArea(-75.2, 43.07, back), false);         // in the hole
  assert.equal(inArea(-75.35, 43.1, back), false);         // outside
  assert.equal(findCityArea(US_BOUNDS, "5142056").kind, "r");
  assert.deepEqual(findCityArea(US_BOUNDS, "9999001"), { id: "9999001", kind: "p", parent: "5142056" });
  assert.equal(findCityArea(US_BOUNDS, "514205"), null);   // no partial id matches
  assert.equal(cityAt(US_BOUNDS, -75.23, 43.1), "5142056");
  assert.equal(cityAt(US_BOUNDS, -74, 40.7), null);
});

// ---- the community a point is in uses the real boundary --------------------------------------
const TINY = { source: "test", countries: { US: "United States" }, admin: {}, byCountry: {
  US: [[5142056, "Utica", "NY", 43.1, -75.23, 61100], [9999001, "Downtown Utica", "NY", 43.1, -75.22, 5000]],
} };
const files = { "/data/cities.json": JSON.stringify(TINY), "/data/bounds/US.txt": US_BOUNDS };
const assets = { fetch: async (r) => { const f = files[new URL(r.url).pathname]; return f ? new Response(f) : new Response("", { status: 404 }); } };
let env;
beforeEach(() => { _resetCityCache(); env = { ASSETS: assets }; });

test("locate: inside the boundary is the city", async () => {
  assert.equal((await locate(env, "US", -75.25, 43.12)).city.id, "5142056");
});

test("locate: 10 km outside, or in a hole, is not the city (only the three nearest are offered)", async () => {
  const out = await locate(env, "US", -75.35, 43.1);
  assert.equal(out.city, null);
  assert.equal(out.nearby[0].id, "5142056");
  assert.equal(out.nearby.some((c) => c.id === "9999001"), false, "a neighbourhood that's part of a city is never offered on its own");
  assert.equal((await locate(env, "US", -75.2, 43.07)).city, null);
});

test("locate: standing in a neighbourhood that's part of a city means that city", async () => {
  assert.equal((await locate(env, "US", -75.22, 43.1)).city.id, "5142056");
  assert.equal(await locate(env, "ZZ", 0, 0), null);
});

// ---- the generated boundary files ------------------------------------------------------------
test("generated boundary files: every line is a listed city with a valid shape, parents exist", () => {
  const dir = new URL("../public/data/bounds/", import.meta.url);
  if (!existsSync(dir)) return; // not built yet
  const data = JSON.parse(readFileSync(new URL("../public/data/cities.json", import.meta.url), "utf8"));
  const index = JSON.parse(readFileSync(new URL("index.json", dir), "utf8"));
  const listed = new Set(Object.values(data.byCountry).flat().map((r) => String(r[0])));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".txt"))) {
    const cc = file.slice(0, 2);
    assert.ok(index.countries[cc], `${cc} in index`);
    for (const l of readFileSync(new URL(file, dir), "utf8").split("\n").filter(Boolean)) {
      const [id, kind, a] = l.split("\t");
      assert.ok(listed.has(id), `${cc}: ${id} is listed`);
      assert.ok(["r", "n", "p", "o"].includes(kind), `${cc}: ${id} kind`);
      if (kind === "p") { assert.ok(listed.has(a), `${cc}: parent of ${id}`); continue; }
      if (kind === "o") continue; // outside every community: no shape
      const row = findCityArea(l, id);
      assert.ok(row.area.length && row.area.every((poly) => poly.every((ring) => ring.length >= 4)), `${cc}: ${id} shape`);
    }
  }
  for (const [child, parent] of Object.entries(index.parts)) {
    assert.ok(listed.has(child) && listed.has(parent));
    assert.ok(!index.parts[parent], `one coin per big city: ${child} → ${parent} must point at the top city, not a chain`);
  }
  for (const id of index.joined || []) assert.ok(index.parts[id], `joined place ${id} is part of a city`);
});

test("generated boundary files: no two areas share more than 1 m² (exact geometry, all countries)", () => {
  const dir = new URL("../public/data/bounds/", import.meta.url);
  if (!existsSync(dir)) return;
  const items = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".txt")))
    for (const l of readFileSync(new URL(file, dir), "utf8").split("\n")) {
      const [id, kind, box, json] = l.split("\t");
      if (json) items.push({ id, kind, box: box.split(",").map(Number), area: decodeArea(JSON.parse(json)) });
    }
  const found = findOverlaps(items, 1e-6).map(({ a, b, km2 }) => `${a.id} × ${b.id}: ${km2 === null ? "unmeasurable" : km2.toFixed(4) + " km²"}`);
  assert.deepEqual(found.slice(0, 20), []);
});

test("generated boundary files: areas never overlap (no city's point is inside two areas)", () => {
  const dir = new URL("../public/data/bounds/", import.meta.url);
  if (!existsSync(dir)) return;
  const data = JSON.parse(readFileSync(new URL("../public/data/cities.json", import.meta.url), "utf8"));
  const clashes = [];
  for (const [cc, rows] of Object.entries(data.byCountry)) {
    const file = new URL(`${cc}.txt`, dir);
    if (!existsSync(file)) continue;
    const areas = readFileSync(file, "utf8").split("\n").filter((l) => l && ["r", "n"].includes(l.split("\t")[1])).map((l) => {
      const [id, , box] = l.split("\t");
      return { id, box: box.split(",").map(Number), line: l };
    });
    for (const [, name, , lat, lon] of rows) {
      const inside = areas.filter((a) => lon >= a.box[0] && lon <= a.box[2] && lat >= a.box[1] && lat <= a.box[3])
        .filter((a) => inArea(lon, lat, (a.area ||= findCityArea(a.line, a.id).area)));
      if (inside.length > 1) clashes.push(`${cc} ${name}: inside ${inside.map((a) => a.id).join(" + ")}`);
    }
  }
  assert.deepEqual(clashes, []);
});
