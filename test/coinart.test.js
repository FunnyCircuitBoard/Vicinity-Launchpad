// The city-coin picture (src/coinart.js, src/coinart-render.js; COIN_V2_READY): the template SVG and its fitting over every city of the
// registry, the safety of the SVG, the committed fonts and width table, and the PNG: deterministic, 512 x 512, pinned by golden hashes
// (template t1 is immutable: a change of one pixel is a new version, never an edit of t1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { FONT_SHA256, TEMPLATES, TEMPLATE_VERSION, artText, coinSvg, fitCoin, sha256Hex, textWidth } from "../src/coinart.js";
import METRICS from "../src/coinart-metrics.js";
import { metricsSource } from "../scripts/coin-art/metrics.mjs";
import { readTtf } from "../scripts/coin-art/ttf.mjs";
import { nodeRenderer } from "../scripts/coin-art/render.mjs";
import { makeRenderer } from "../src/coinart-render.js";

const file = (p) => readFileSync(new URL(`../${p}`, import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const tickers = JSON.parse(file("public/data/tickers.json"));
const cities = JSON.parse(file("public/data/cities.json"));
const registry = [];
for (const list of Object.values(cities.byCountry)) for (const r of list) { const v = tickers[String(r[0])]; if (v) registry.push({ id: String(r[0]), name: r[1], ticker: typeof v === "string" ? v : v[0] }); }
const byId = (id) => registry.find((r) => r.id === String(id));

// UTICA, NYC, KUALALUM (two words, one line), Greifswald (two lines), Herāt (a mark), MOHAMMADPU (the smallest ticker of all)
const GOLDEN = {
  5142056: { svg: "a72121c72cbe7270f7b8bbc3aa0fb5854b130763237254f240806f8d8ec1ec41", png: "8108d332deaaf1cfd28dfe94a1fa3c14d7a227815384114e3227ef55a63ab34e" },
  5128581: { svg: "4a5f02542f0a28450545c1d963d5a783e9ae80f28cd3d81bbf67ad26415fdec9", png: "1869a20eb700f51b866b0b9e0b6ffa26c83a5513198ae2563ce8f13ec8dc96fa" },
  1735161: { svg: "1a60c69e283ed7c009654a17a00c75f1b9489b850a0912d8546c01252f34845b", png: "06923d5e2930f6ace43ab01fe97af274aa1d1e0754ae8e6b41b36dd4d0284618" },
  2917788: { svg: "32f511799a54bb2a4538cfbe93434ed72354539e4208765d88b8786ffba91cc8", png: "694f958c154fec468265c26bb5db42a4a33b94ecdf94216077b68297f525f2be" },
  1140026: { svg: "3ea11bf5ddaa110ed4964e48567e264811dcad12fc6bff9bdb4d95ca0de8287d", png: "c16b1e715f5bffc279ff20d217aff8766d0907b0cd867fee0aa568d92f5891b9" },
  1194041: { svg: "8827a8110092f04506b05c8f693bedbc4f5b3522f726510eff1ad4b95891aa0d", png: "66f82ed6d81320a16b4e3f1156158d1354b97d24018d6c3eeccdfd9a15212011" },
};

test("the committed fonts are the pinned ones, and the width table is exactly what they hold (regenerated and compared)", () => {
  assert.equal(sha(file("src/assets/fonts/SpaceGrotesk-Bold.ttf")), FONT_SHA256.bold);
  assert.equal(sha(file("src/assets/fonts/SpaceGrotesk-Medium.ttf")), FONT_SHA256.medium);
  assert.equal(readFileSync(new URL("../src/coinart-metrics.js", import.meta.url), "utf8"), metricsSource(), "run: node scripts/coin-art/metrics.mjs");
  assert.deepEqual(METRICS.fonts, FONT_SHA256);
  const bold = readTtf(file("src/assets/fonts/SpaceGrotesk-Bold.ttf")), medium = readTtf(file("src/assets/fonts/SpaceGrotesk-Medium.ttf"));
  assert.deepEqual([bold.weightClass, medium.weightClass, bold.unitsPerEm, bold.capHeight], [700, 500, 1000, 700], "static Bold and Medium instances, not the variable font");
  assert.match(readFileSync(new URL("../src/assets/fonts/OFL.txt", import.meta.url), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.ok(TEMPLATES.t1.fonts === FONT_SHA256 && Object.isFrozen(TEMPLATES) && Object.isFrozen(TEMPLATES.t1) && Object.isFrozen(TEMPLATES.t1.city));
  assert.equal(TEMPLATE_VERSION, "t1");
});

test("fitting over all 8,030 registry cities: every ticker above the floor, every name drawable with no letter lost, 108 on two lines", () => {
  assert.equal(registry.length, 8030);
  let two = 0, minTicker = Infinity, smallest = "", minCity = Infinity;
  const L = /[\p{L}\p{N}]/u;
  for (const r of registry) {
    const f = fitCoin({ ticker: r.ticker, city: r.name });
    if (f.tickerSize < minTicker) { minTicker = f.tickerSize; smallest = r.ticker; }
    assert.ok(f.tickerWidth <= 330.01, `${r.ticker} fits 330 px`);
    if (f.lines.length === 2) two++;
    else assert.ok(f.rule >= 18 && f.citySize >= 18, `${r.name}: one line between rules at 18 px or more`);
    assert.ok(f.citySize > 14, `${r.name} never reaches the 14 px floor`);
    minCity = Math.min(minCity, f.citySize);
    for (const line of f.lines) assert.ok(textWidth(line, METRICS.medium, f.citySize, 0.22) <= (f.lines.length === 2 ? 300.01 : 340 - 2 * (f.rule + 12) + 0.01), `${r.name}: ${line} fits`);
    // every glyph is in the Medium font, and no letter or digit of the name is lost (a missing accent is drawn without it)
    for (const ch of artText(r.name)) assert.ok(METRICS.medium[ch] != null, `${r.name}: ${ch}`);
    const want = [...r.name.toUpperCase().normalize("NFD")].filter((ch) => L.test(ch)).join("");
    const got = [...artText(r.name).normalize("NFD")].filter((ch) => L.test(ch)).join("");
    assert.equal(got, want, r.name);
  }
  assert.ok(minTicker > 40, "no ticker reaches the 40 px floor");
  assert.equal(smallest, "MOHAMMADPU");
  assert.equal(two, 108);
  assert.ok(minCity > 17);
  assert.equal(fitCoin({ ticker: "UTICA", city: "Utica" }).tickerSize.toFixed(1), "95.4", "UTICA as measured in the design");
});

test("artText: upper-case, composed; a letter the font lacks loses only its mark; lone marks dropped; spaces tidied", () => {
  assert.equal(artText("Herāt"), "HERĀT");
  assert.equal(artText("Ḑaugavpils"), "DAUGAVPILS", "Ḑ is not in Space Grotesk: D");
  assert.equal(artText("i\u0307stanbul"), "İSTANBUL", "i + combining dot composes to İ, which the font has");
  assert.equal(artText("Istanbul\u0332"), "ISTANBUL", "a combining mark left on its own is dropped");
  assert.equal(artText("  São   Paulo "), "SÃO PAULO");
  assert.equal(artText("Straße"), "STRASSE");
  assert.equal(artText("北京"), "", "nothing drawable");
  assert.throws(() => fitCoin({ ticker: "BEIJING", city: "北京" }), /nothing the coin font can draw/);
});

test("the SVG: the registry ticker only, XML-escaped text, no script, style, image or outside reference, numbers to 2 decimals", () => {
  const svg = coinSvg({ ticker: "UTICA", city: `Utica & <script>alert("x")</script> 'q'` });
  assert.doesNotMatch(svg, /<script|<style|<image|<foreignObject|on[a-z]+=/i);
  assert.match(svg, />UTICA &amp;<\/text>/);
  assert.match(svg, />&lt;SCRIPT&gt;ALERT\(&quot;X&quot;\)&lt;\/SCRIPT&gt; &#39;Q&#39;<\/text>/);
  const refs = [...svg.matchAll(/(?:xlink:)?href="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(refs)], ["#arc"], "the only reference is the arc's own path");
  assert.ok([...svg.matchAll(/url\(#([a-z]+)\)/g)].every((m) => ["navy", "copper", "cream"].includes(m[1])));
  assert.match(svg, />\$UTICA</);
  assert.match(svg, /VICINITY CITY/);
  for (const n of svg.matchAll(/="(-?\d+\.\d+)"/g)) assert.match(n[1], /^-?\d+\.\d{2}$/, n[1]);
  for (const bad of ["utica", "UTICA!", "", "ABCDEFGHIJK", null, 12]) assert.throws(() => coinSvg({ ticker: bad, city: "Utica" }), /ticker/);
  assert.throws(() => coinSvg({ ticker: "UTICA", city: "Utica", templateVersion: "t9" }), /unknown template version/);
  assert.equal(coinSvg({ ticker: "UTICA", city: "Utica" }), coinSvg({ ticker: "UTICA", city: "Utica", templateVersion: "t1" }), "t1 is the default");
});

test("t1 is pinned: the SVG bytes of six cities never change", async () => {
  for (const [id, g] of Object.entries(GOLDEN)) {
    const r = byId(id);
    assert.equal(await sha256Hex(coinSvg({ ticker: r.ticker, city: r.name })), g.svg, `${r.ticker} ${r.name}`);
  }
  const two = fitCoin({ ticker: byId(2917788).ticker, city: byId(2917788).name });
  assert.deepEqual(two.lines, ["UNIVERSITÄTS- UND", "HANSESTADT GREIFSWALD"]);
  assert.equal(fitCoin({ ticker: "HERAT", city: "Herāt" }).lines[0], "HERĀT");
});

test("the PNG: resvg-wasm 2.6.2 with the two fonts, 512 x 512, under 150 KB, byte-identical on every render, pinned by golden hashes", async () => {
  const render = await nodeRenderer();
  for (const [id, g] of Object.entries(GOLDEN)) {
    const r = byId(id);
    const svg = coinSvg({ ticker: r.ticker, city: r.name });
    const png = await render(svg);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dv = new DataView(png.buffer, png.byteOffset);
    assert.deepEqual([dv.getUint32(16), dv.getUint32(20)], [512, 512]);
    assert.ok(png.length < 150_000, `${png.length} bytes`);
    assert.equal(sha(png), g.png, `${r.ticker}: t1 renders exactly these bytes (a change is a new template version)`);
    assert.equal(sha(await render(svg)), g.png, "the same bytes again");
  }
  assert.equal(JSON.parse(file("node_modules/@resvg/resvg-wasm/package.json")).version, "2.6.2");
  assert.equal(JSON.parse(file("package.json")).dependencies["@resvg/resvg-wasm"], "2.6.2", "pinned exactly");
});

test("the renderer: the wasm starts once, on the first picture only; a failed start is tried again; not an SVG is refused", async () => {
  let starts = 0, fail = true;
  class FakeResvg { constructor(svg) { this.svg = svg; } render() { return { width: 512, height: 512, asPng: () => new Uint8Array([1, 2, 3]), free() {} }; } free() {} }
  const render = makeRenderer({ initWasm: async () => { starts++; if (fail) { fail = false; throw new Error("boom"); } }, Resvg: FakeResvg, wasm: {}, fonts: [new Uint8Array(1), new Uint8Array(1)] });
  assert.equal(starts, 0, "nothing at creation");
  await assert.rejects(render("<svg/>"), /boom/);
  assert.deepEqual([...(await render("<svg/>"))], [1, 2, 3]);
  await render("<svg/>");
  assert.equal(starts, 2, "one failed start, one good one, then never again");
  await assert.rejects(render("<html>"), /not an SVG/);
  const already = makeRenderer({ initWasm: async () => { throw new Error("Already initialized"); }, Resvg: FakeResvg, wasm: {}, fonts: [new Uint8Array(1), new Uint8Array(1)] });
  assert.deepEqual([...(await already("<svg/>"))], [1, 2, 3], "a second renderer in the same isolate reuses the module");
  const wrong = makeRenderer({ initWasm: async () => {}, Resvg: class { render() { return { width: 10, height: 10, asPng: () => new Uint8Array(1) }; } }, wasm: {}, fonts: [new Uint8Array(1), new Uint8Array(1)] });
  await assert.rejects(wrong("<svg/>"), /not 512x512/);
});

test("a later painted version layers the same text on the owner's blank coin, and never changes t1", async () => {
  const before = await sha256Hex(coinSvg({ ticker: "UTICA", city: "Utica" }));
  const base = new Uint8Array(file("public/brand/vicinity-512.png")); // any PNG stands in for the owner's blank painted coin here
  const baseSha = sha(base);
  const t2 = Object.freeze({ ...TEMPLATES.t1, version: "t2-test", base: "painted", baseSha256: baseSha });
  const svg = coinSvg({ ticker: "UTICA", city: "Utica", template: t2, baseImage: { type: "image/png", bytes: base, sha256: baseSha } });
  assert.match(svg, /<image x="0" y="0" width="512" height="512" preserveAspectRatio="none" xlink:href="data:image\/png;base64,/);
  assert.doesNotMatch(svg, /<circle/, "no drawn rings: the painting is the base");
  assert.match(svg, />\$UTICA</);
  assert.throws(() => coinSvg({ ticker: "UTICA", city: "Utica", template: t2 }), /needs its base image/);
  assert.throws(() => coinSvg({ ticker: "UTICA", city: "Utica", template: t2, baseImage: { type: "image/png", bytes: base, sha256: "0".repeat(64) } }), /needs its base image/);
  const png = await (await nodeRenderer())(svg);
  assert.equal(new DataView(png.buffer, png.byteOffset).getUint32(16), 512);
  assert.equal(await sha256Hex(coinSvg({ ticker: "UTICA", city: "Utica" })), before, "t1 is untouched");
  assert.deepEqual(Object.keys(TEMPLATES), ["t1"], "only t1 is published");
});
