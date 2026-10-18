// The city-coin renderer in Node, built from the same files the Worker imports (src/coinart-wasm.js): resvg-wasm 2.6.2 from
// node_modules and the two committed fonts. Used by the tests (golden hashes; the Worker must give the same bytes) and to look at
// coins on a computer:
//   node scripts/coin-art/render.mjs <out-dir> <cityId> [<cityId> ...]     writes <TICKER>.svg and <TICKER>.png from the registry
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { makeRenderer } from "../../src/coinart-render.js";
import { coinSvg, sha256Hex } from "../../src/coinart.js";

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
let renderer = null;

/** One renderer per process (the wasm is instantiated once). */
export async function nodeRenderer() {
  if (renderer) return renderer;
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm");
  const { initWasm, Resvg } = await import("@resvg/resvg-wasm");
  const wasm = await WebAssembly.compile(readFileSync(wasmPath));
  const fonts = ["src/assets/fonts/SpaceGrotesk-Bold.ttf", "src/assets/fonts/SpaceGrotesk-Medium.ttf"].map((p) => new Uint8Array(readFileSync(root(p))));
  renderer = makeRenderer({ initWasm, Resvg, wasm, fonts });
  return renderer;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [out, ...ids] = process.argv.slice(2);
  if (!out || !ids.length) { console.error("usage: node scripts/coin-art/render.mjs <out-dir> <cityId> [...]"); process.exit(2); }
  mkdirSync(out, { recursive: true });
  const tickers = JSON.parse(readFileSync(root("public/data/tickers.json"), "utf8"));
  const cities = JSON.parse(readFileSync(root("public/data/cities.json"), "utf8"));
  const names = new Map();
  for (const list of Object.values(cities.byCountry)) for (const r of list) names.set(String(r[0]), r[1]);
  const render = await nodeRenderer();
  for (const id of ids) {
    const v = tickers[id];
    if (!v || !names.has(id)) { console.log(id, "not in the registry"); continue; }
    const ticker = typeof v === "string" ? v : v[0];
    const svg = coinSvg({ ticker, city: names.get(id) });
    const t0 = performance.now();
    const png = await render(svg);
    writeFileSync(`${out}/${ticker}.svg`, svg);
    writeFileSync(`${out}/${ticker}.png`, png);
    console.log(id, ticker, names.get(id), `${png.length} B`, `${(performance.now() - t0).toFixed(0)} ms`, "png", await sha256Hex(png), "svg", await sha256Hex(svg));
  }
}
