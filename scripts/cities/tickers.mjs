// Builds public/data/tickers.json: the ONE ticker for every community, so the map, the dashboard and the server
// can never disagree about a city coin's name (a test fails if this file is out of date).
//   npm run tickers
// A community is every listed place that isn't "part of" a bigger one (public/data/bounds/index.json → parts).
// Tickers come from public/ticker.js (the rules are in its header). A place with a name of its own is just its ticker;
// a name shared with other places is [ticker, plain ticker, how many places share the name].
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "../../public/ticker.js";

const pub = (p) => fileURLToPath(new URL(`../../public/${p}`, import.meta.url));

export function buildTickers() {
  const cities = JSON.parse(readFileSync(pub("data/cities.json"), "utf8"));
  const parts = JSON.parse(readFileSync(pub("data/bounds/index.json"), "utf8")).parts || {};
  const rows = [];
  for (const [cc, list] of Object.entries(cities.byCountry))
    for (const [id, name, adm, , , pop] of list) if (!parts[String(id)]) rows.push({ id: String(id), name, adm, cc, pop });
  const out = {};
  for (const [id, t] of globalThis.vicinityTicker.assign(rows)) out[id] = t.shared === 1 && t.ticker === t.base ? t.ticker : [t.ticker, t.base, t.shared];
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = buildTickers();
  writeFileSync(pub("data/tickers.json"), JSON.stringify(out));
  console.log("tickers ready:", Object.keys(out).length, "communities");
}
