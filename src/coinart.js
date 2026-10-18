/**
 * The city-coin picture (COIN_V2_READY, src/coinready.js): the navy-and-orange Vicinity coin with the city's registry ticker and its
 * name, as a deterministic SVG. Pure JavaScript, no I/O: the Worker (src/coinart-wasm.js renders it to PNG with resvg-wasm), the
 * tests and any reviewer get the same bytes from the same inputs, so anyone can re-render a coin and check its hash.
 *
 *   coinSvg({ ticker, city, templateVersion })   the SVG text. `ticker` is the city's ticker from the registry
 *                                                (public/data/tickers.json via src/tickers.js) and nothing else; `city` is the
 *                                                registry city name, drawn upper-case by artText.
 *   fitCoin({ ticker, city, templateVersion })   the sizes and lines coinSvg draws (for tests and the fitting statistics).
 *   artText(name)                                the city name as the coin draws it: upper-case, composed, and any letter the
 *                                                font lacks drawn without its accent (Ḑ → D); a mark left on its own is dropped.
 *
 * TEMPLATE VERSIONS ARE IMMUTABLE. A version fixes the geometry, the colours, the fonts (FONT_SHA256), the width table and the
 * renderer (resvg-wasm 2.6.2). Anything that would change one pixel of a coin is a NEW version ("t2"), never an edit of an existing
 * one: the picture of a coin that launched with "t1" is stored by the hash of its bytes (src/coinready.js coin_art) and named by it
 * (/coin-meta/art/<sha256>.png), and test/coinart.test.js pins the SVG and PNG hashes of t1 so an edit fails the build.
 *
 * Two kinds of base, so the owner's painted coin can become a later version without touching t1:
 *   base: "vector"   t1: the rings, the field and the pin drawn as shapes (the owner's picture of the template, redrawn).
 *   base: "painted"  a later version: a blank painted coin (the owner's artwork without the text, a PNG committed with its SHA-256)
 *                    embedded as a data: image, with the same text layers drawn on top. coinSvg refuses one whose bytes do not
 *                    hash to the version's baseSha256.
 *
 * The SVG never contains a script, a style element, an external reference or an <image> other than a painted base; every text is
 * XML-escaped; every number is written with toFixed(2).
 */
import METRICS from "./coinart-metrics.js";

/** The coin fonts (src/assets/fonts, built by scripts/coin-art/fonts.mjs --check). A change here is a new template version. */
export const FONT_SHA256 = Object.freeze({
  bold: "b640c8d301313064c5e8b3328769160c403d385edfaf09288537dfce11c4d92b",
  medium: "6dcc1460c1b324410c787292f2ce6948f0f64ff9cfe1856c341e37641dba70ba",
});
/** The renderer every version so far is drawn with (package.json pins it exactly). */
export const RESVG_VERSION = "2.6.2";
export const ART_SIZE = 512;

const COLORS = Object.freeze({
  navyIn: "#16243A", navyOut: "#070D18", copperHi: "#F08A4B", copper: "#D4561F", copperLo: "#9E2D08", gap: "#0B0F18",
  orange: "#F25C24", cream: "#FBEBCE", creamHi: "#FFF6E2", creamLo: "#F3D9AE", edge: "#C4501C",
});

/**
 * Every template version, frozen. `t1` is the vector redraw of the owner's picture (DESIGN 2.1-2.4): ticker caps centred on y 264,
 * at most 330 px wide, cap height 80 at most; the city between two rules on y 339 (or on two lines around y 335); "VICINITY CITY" on
 * the bottom arc. The text-fitting numbers live in the version, so a later version can move or resize the text without moving t1's.
 */
export const TEMPLATES = Object.freeze({
  t1: Object.freeze({
    version: "t1", base: "vector", fonts: FONT_SHA256, resvg: RESVG_VERSION,
    ticker: Object.freeze({ start: 80 / 0.7, maxWidth: 330, min: 40, track: 0.01, centerY: 264 }),
    city: Object.freeze({ start: 30, track: 0.22, centerY: 339, band: 340, rule: 64, ruleMin: 18, gap: 12, min: 18,
      twoLineMax: 24, twoLineWidth: 300, twoLineCenterY: 335, lineHeight: 1.15, floor: 14 }),
    arc: Object.freeze({ r: 158, size: 19, spacing: 6, text: "VICINITY CITY" }),
  }),
});
/** The version new coins are made with. Changing it changes the defaults of coins not launched yet, never a launched coin. */
export const TEMPLATE_VERSION = "t1";

const n2 = (x) => Number(x).toFixed(2);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const MARK = /\p{M}/u;

/** The city name as the coin draws it (see the header). Only characters of the Medium font survive. */
export function artText(name, widths = METRICS.medium) {
  let out = "";
  for (const ch of String(name ?? "").toUpperCase().normalize("NFC")) {
    if (MARK.test(ch)) continue; // a lone combining mark: without the font's positioning it would sit beside its letter
    if (widths[ch] != null) { out += ch; continue; }
    for (const d of ch.normalize("NFD")) if (!MARK.test(d) && widths[d] != null) out += d;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Width in px of `text` at `size` with tracking `track` (em): the sum of the advances plus the spacing between characters. */
export function textWidth(text, widths, size, track) {
  const chars = [...text];
  let units = 0;
  for (const ch of chars) {
    const w = widths[ch];
    if (w == null) throw new Error(`no glyph for U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
    units += w;
  }
  return (units / METRICS.unitsPerEm) * size + track * size * Math.max(0, chars.length - 1);
}

const tickerOk = (t) => typeof t === "string" && /^[A-Z0-9]{1,10}$/.test(t);
const templateOf = (v) => {
  const t = TEMPLATES[v];
  if (!t) throw new Error(`unknown template version ${v}`);
  return t;
};

/** Sizes and lines for one coin (pure). Throws on a ticker that is not 1-10 of A-Z0-9 or a city with nothing drawable. */
export function fitCoin({ ticker, city, templateVersion = TEMPLATE_VERSION, template = null } = {}) {
  const t = template || templateOf(templateVersion);
  if (!tickerOk(ticker)) throw new Error("the ticker must be 1 to 10 characters of A-Z and 0-9");
  const text = `$${ticker}`;
  const T = t.ticker;
  let ts = T.start;
  const tw = textWidth(text, METRICS.bold, ts, T.track);
  if (tw > T.maxWidth) ts = (ts * T.maxWidth) / tw;
  ts = Math.max(T.min, ts);

  const C = t.city;
  const name = artText(city);
  if (!name) throw new Error("the city name has nothing the coin font can draw");
  const w1 = (s) => textWidth(s, METRICS.medium, 1, C.track); // width at 1 px: widths scale with the size, tracking included
  const avail = (rule) => C.band - 2 * (rule + C.gap);
  let lines = [name], cs = C.start, rule = C.rule, centerY = C.centerY;
  const full = w1(name);
  if (full * cs > avail(rule)) {
    rule = Math.max(C.ruleMin, Math.min(C.rule, (C.band - full * cs) / 2 - C.gap)); // shorten the rules first
    if (full * cs > avail(rule)) cs = avail(rule) / full; // then the size
    if (cs < C.min) {
      // two lines, broken at the space or hyphen that makes the longer line shortest (a hyphen stays on the first line)
      let best = null;
      for (let i = 1; i < name.length; i++) {
        const prev = name[i - 1], here = name[i];
        if (here !== " " && prev !== "-") continue;
        const a = name.slice(0, i).trim(), b = name.slice(i).trim();
        if (!a || !b) continue;
        const longest = Math.max(w1(a), w1(b));
        if (!best || longest < best.longest) best = { a, b, longest };
      }
      rule = 0;
      if (best) { lines = [best.a, best.b]; cs = Math.min(C.twoLineMax, C.twoLineWidth / best.longest); centerY = C.twoLineCenterY; }
      else cs = Math.min(C.min, C.twoLineWidth / full); // one word too long for two lines: one line that fits
      cs = Math.max(C.floor, cs);
    }
  }
  return { template: t.version, ticker: text, tickerSize: ts, tickerWidth: textWidth(text, METRICS.bold, ts, T.track), city: name, lines, citySize: cs, rule, centerY };
}

/** The base of a vector version: the rings, the navy field and the map pin, as in the owner's picture (DESIGN 2.1). */
function vectorBase() {
  const c = COLORS;
  return [
    `<circle cx="256" cy="256" r="228" fill="url(#copper)"/>`,
    `<circle cx="256" cy="256" r="213" fill="${c.gap}"/>`,
    `<circle cx="256" cy="256" r="204" fill="${c.orange}"/>`,
    `<circle cx="256" cy="256" r="196" fill="url(#navy)"/>`,
    `<path d="M256 206C241 180 216 166 216 142.50A40 40 0 1 1 296 142.50C296 166 271 180 256 206Z" fill="${c.orange}"/>`,
    `<circle cx="256" cy="142.50" r="18" fill="${c.cream}"/>`,
  ].join("\n");
}
/** The base of a painted version: the blank coin artwork as an embedded PNG, full size. */
function paintedBase(dataUri) {
  return `<image x="0" y="0" width="512" height="512" preserveAspectRatio="none" xlink:href="${dataUri}" href="${dataUri}"/>`;
}

/** The text layers every version draws on its base: the ticker, the city line (with or without rules) and the arc. */
function textLayers(f, t) {
  const c = COLORS, C = t.city;
  const out = [];
  const tb = t.ticker.centerY + 0.35 * f.tickerSize; // caps (0.7 em) centred on centerY
  out.push(`<text x="256" y="${n2(tb)}" text-anchor="middle" font-family="Space Grotesk" font-weight="700" font-size="${n2(f.tickerSize)}" letter-spacing="${n2(t.ticker.track * f.tickerSize)}" fill="url(#cream)" stroke="${c.edge}" stroke-width="1.20" paint-order="stroke">${esc(f.ticker)}</text>`);
  const cityText = (line, y) => `<text x="256" y="${n2(y)}" text-anchor="middle" font-family="Space Grotesk" font-weight="500" font-size="${n2(f.citySize)}" letter-spacing="${n2(C.track * f.citySize)}" fill="${c.cream}">${esc(line)}</text>`;
  if (f.lines.length === 1) {
    if (f.rule > 0) {
      const half = textWidth(f.lines[0], METRICS.medium, f.citySize, C.track) / 2 + C.gap;
      out.push(`<path d="M${n2(256 - half - f.rule)} ${n2(f.centerY)}H${n2(256 - half)}M${n2(256 + half)} ${n2(f.centerY)}H${n2(256 + half + f.rule)}" stroke="${c.orange}" stroke-width="2.50" stroke-linecap="round" fill="none"/>`);
    }
    out.push(cityText(f.lines[0], f.centerY + 0.35 * f.citySize));
  } else {
    const step = C.lineHeight * f.citySize;
    f.lines.forEach((line, i) => out.push(cityText(line, f.centerY + (i - 0.5) * step + 0.35 * f.citySize)));
  }
  out.push(`<text font-family="Space Grotesk" font-weight="500" font-size="${n2(t.arc.size)}" letter-spacing="${n2(t.arc.spacing)}" fill="${c.orange}"><textPath xlink:href="#arc" href="#arc" startOffset="50%" text-anchor="middle">${esc(t.arc.text)}</textPath></text>`);
  return out.join("\n");
}

/**
 * The SVG of one coin. A painted version needs `baseImage` ({ type: "image/png", bytes, sha256 }): its sha256 must be the
 * version's baseSha256 (the caller hashed the bytes; this module stays synchronous and free of I/O).
 */
export function coinSvg({ ticker, city, templateVersion = TEMPLATE_VERSION, template = null, baseImage = null } = {}) {
  const t = template || templateOf(templateVersion);
  const f = fitCoin({ ticker, city, template: t });
  const c = COLORS, r = t.arc.r;
  let base;
  if (t.base === "vector") base = vectorBase();
  else if (t.base === "painted") {
    if (!baseImage || baseImage.type !== "image/png" || baseImage.sha256 !== t.baseSha256 || !(baseImage.bytes instanceof Uint8Array)) throw new Error(`template ${t.version} needs its base image (sha256 ${t.baseSha256})`);
    base = paintedBase(`data:image/png;base64,${base64(baseImage.bytes)}`);
  } else throw new Error(`template ${t.version} has an unknown base`);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="512" height="512" viewBox="0 0 512 512">
<defs>
<radialGradient id="navy" cx="50%" cy="42%" r="60%"><stop offset="0" stop-color="${c.navyIn}"/><stop offset="1" stop-color="${c.navyOut}"/></radialGradient>
<linearGradient id="copper" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.copperHi}"/><stop offset=".5" stop-color="${c.copper}"/><stop offset="1" stop-color="${c.copperLo}"/></linearGradient>
<linearGradient id="cream" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.creamHi}"/><stop offset="1" stop-color="${c.creamLo}"/></linearGradient>
<path id="arc" d="M${n2(256 - r)} 256A${n2(r)} ${n2(r)} 0 0 0 ${n2(256 + r)} 256"/>
</defs>
${base}
${textLayers(f, t)}
</svg>
`;
}

function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Lower-case hex SHA-256 of a string (UTF-8) or bytes, with Web Crypto (the Worker and Node alike). */
export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
