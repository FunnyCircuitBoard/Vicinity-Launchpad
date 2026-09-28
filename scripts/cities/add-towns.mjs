// Adds the towns listed in scripts/cities/added-towns.json to the site's city list (public/data/cities.json),
// taking each row (id, name, region, position, population, county seat) from the full GeoNames list
// (.cache/cities-148k.json, made by build-list.mjs with LIST=.cache/cities-148k.json). Safe to repeat.
// Then rebuild the areas: node scripts/boundaries/3-build.mjs
//   node scripts/cities/add-towns.mjs
import { readFileSync, writeFileSync } from "node:fs";

const LIST = "public/data/cities.json";
const FULL = process.env.FULL || ".cache/cities-148k.json";
const { towns } = JSON.parse(readFileSync("scripts/cities/added-towns.json", "utf8"));
const list = JSON.parse(readFileSync(LIST, "utf8"));
const full = JSON.parse(readFileSync(FULL, "utf8"));

let added = 0;
for (const [cc, ids] of Object.entries(towns)) {
  const rows = list.byCountry[cc] || (list.byCountry[cc] = []);
  const have = new Set(rows.map((r) => String(r[0])));
  const source = new Map((full.byCountry[cc] || []).map((r) => [String(r[0]), r]));
  for (const id of ids.map(String)) {
    if (have.has(id)) continue;
    const row = source.get(id);
    if (!row) throw new Error(`${cc} ${id} isn't in ${FULL}`);
    rows.push(row); have.add(id); added++;
  }
  rows.sort((a, b) => b[5] - a[5] || String(a[0]).localeCompare(String(b[0])));
}
writeFileSync(LIST, JSON.stringify(list));
console.log(`${added} towns added to ${LIST}`);
