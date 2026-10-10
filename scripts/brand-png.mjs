#!/usr/bin/env node
/**
 * public/brand/vicinity-512.png: the Vicinity mark (public/logo.svg) as a 512 x 512 PNG on the site's solid dark background, for
 * wallets and explorers (they do not render SVG): the image Meteora's partner metadata names and the fallback of
 * /coin-meta/<mint>.png (src/coinmeta.js). The mark sits in the middle with room around it, so a round crop keeps it whole.
 *
 *   node scripts/brand-png.mjs            render it (Playwright's Chromium; PLAYWRIGHT=<path to the playwright package> if it is
 *                                         not resolvable from here) and print its size and SHA-256
 *   node scripts/brand-png.mjs --check    only check the committed file: 512 x 512, PNG, at most 60 KB
 * The PNG is committed; the site never renders it at run time.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const OUT = new URL("public/brand/vicinity-512.png", root);
const SIZE = 512, MAX_BYTES = 60 * 1024;
const BACKGROUND = "#060C17"; // --bg of the site's dark theme (public/style.css), the default look

/** { width, height, colorType } from a PNG's IHDR, or throws. */
export function pngInfo(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => bytes[i] === b) || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") throw new Error("not a PNG");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20), colorType: bytes[25] };
}
function check(bytes) {
  const info = pngInfo(bytes);
  const problems = [];
  if (info.width !== SIZE || info.height !== SIZE) problems.push(`${info.width} x ${info.height}, not ${SIZE} x ${SIZE}`);
  if (bytes.length > MAX_BYTES) problems.push(`${bytes.length} bytes, more than ${MAX_BYTES}`);
  return { info, problems };
}

async function render() {
  const req = createRequire(import.meta.url);
  let pw;
  try { pw = req(process.env.PLAYWRIGHT || "playwright"); } catch { pw = req("/opt/node22/lib/node_modules/playwright"); }
  const svg = readFileSync(new URL("public/logo.svg", root), "utf8").replace(/<svg /, `<svg width="400" height="400" `);
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:${BACKGROUND};overflow:hidden}
      body{display:flex;align-items:center;justify-content:center}svg{display:block}</style></head><body>${svg}</body></html>`);
    return new Uint8Array(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: SIZE, height: SIZE }, omitBackground: false }));
  } finally { await browser.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv.includes("--check");
  const bytes = only ? new Uint8Array(readFileSync(OUT)) : await render();
  const { info, problems } = check(bytes);
  if (problems.length) { console.error(`brand PNG refused: ${problems.join("; ")}`); process.exit(1); }
  if (!only) { mkdirSync(new URL("public/brand/", root), { recursive: true }); writeFileSync(OUT, bytes); }
  console.log(`${only ? "checked" : "wrote"} public/brand/vicinity-512.png: ${info.width} x ${info.height}, ${bytes.length} bytes, colour type ${info.colorType}, sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
}
