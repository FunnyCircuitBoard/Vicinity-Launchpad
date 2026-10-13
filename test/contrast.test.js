// Text contrast on the main buttons (review of 6 Oct 2026, measured in Chromium with reduced motion): white on the old --pin to #FF7A45
// gradient read 2.9:1 (dark) and 3.3:1 (light) on "Buy on Raydium" (16 px bold: normal text, AA needs 4.5:1), 3.0 to 3.2:1 on
// "Get $VICINITY". The main buttons now share one darker orange whose every stop gives white text 4.5:1 or more, in both themes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const dashCss = readFileSync(new URL("../public/polish-dash.css", import.meta.url), "utf8").replace(/\r\n/g, "\n"); // the dashboard preview's rules
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** Every value a custom property gets anywhere in the style sheet (both themes). */
const values = (name) => [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`, "g"))].map((m) => m[1]);

test("main buttons: white text on every stop of their gradient reads at 4.5:1 or more (WCAG AA), in both themes", () => {
  for (const name of ["--cta-a", "--cta-b"]) {
    const v = values(name);
    assert.ok(v.length >= 1, `${name} is defined`);
    for (const hex of v) assert.ok(ratio(hex, "#FFFFFF") >= 4.5, `${name} ${hex}: ${ratio(hex, "#FFFFFF").toFixed(2)}:1`);
  }
  // a gradient between two sRGB colours is never lighter than its lighter end (each channel moves one way), so the stops are enough
  assert.match(css, /\.btn--primary \{ background: linear-gradient\(135deg, var\(--cta-a\), var\(--cta-b\)\); color: #fff;/, "every main button");
  assert.match(css, /\.contract__buy \{[^}]*color: #fff;[^}]*background: linear-gradient\(135deg, var\(--cta-a\), var\(--cta-b\)\);/, "Buy on Raydium");
  assert.match(css, /\.su-tab\[aria-pressed="true"\] \{ background: linear-gradient\(135deg, var\(--cta-a\), var\(--cta-b\)\); color: #fff;/, "the sign-up's chosen tab");
  assert.doesNotMatch(css, /linear-gradient\(135deg, var\(--pin\), #FF7A45\)/, "the old light orange is gone from white-text buttons");
});

test("the accent headlines (gradient text): every stop of each theme's accent gradient reads at 3:1 or more on its page (large text)", () => {
  // the contrast sweep skips gradient text (its fill is transparent), so the stops are checked here (review VUX-06: #D99A1A was 2.26:1).
  // Design v4: .accent is still (no colour shift any more) and reads one token, --grad-accent, set per theme.
  const at = css.indexOf(':root[data-theme="light"] {'), dark = css.slice(0, at), light = css.slice(at);
  const stops = (block) => { const g = /--grad-accent: linear-gradient\(100deg, ([^;]+)\);/.exec(block); assert.ok(g, "the theme sets --grad-accent"); return [...g[1].matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0]); };
  const lightStops = stops(light), darkStops = stops(dark);
  assert.equal(lightStops.length, 3); assert.equal(darkStops.length, 3);
  for (const hex of lightStops) for (const bg of ["#F4F6FA", "#FFFFFF"]) assert.ok(ratio(hex, bg) >= 3, `light ${hex} on ${bg}: ${ratio(hex, bg).toFixed(2)}:1`);
  for (const hex of darkStops) for (const bg of ["#060C17", "#0A1322"]) assert.ok(ratio(hex, bg) >= 3, `dark ${hex} on ${bg}: ${ratio(hex, bg).toFixed(2)}:1`);
  assert.match(css, /\.accent \{ background-image: var\(--grad-accent\); -webkit-background-clip: text; background-clip: text; color: transparent; \}/, "the headline words use that one gradient");
  assert.match(css, /@media \(forced-colors: active\) \{ \.text-ink, \.accent \{ background: none; color: CanvasText; \} \}/, "and read as plain text in forced colours");
});

test("the example dashboard's smallest text reads clearly: the 'Your community' kicker and the coin's label", () => {
  // the 9.9 px kicker was var(--pin-2) #D4501F, 4.2:1 on white (light); design v2: a calm sentence-case kicker in var(--muted), as on the
  // real dashboard; the coin's 9.6 px label #0B3B2C was near the line on its green
  assert.match(dashCss, /\.dpv__kicker \{ display: block; font: 600 \.74rem\/1\.4 var\(--body\); color: var\(--muted\); \}/);
  const light = css.slice(css.indexOf(':root[data-theme="light"] {'));
  const muted = /--muted: (#[0-9A-Fa-f]{6})/.exec(light)[1];
  assert.ok(ratio(muted, "#FFFFFF") >= 4.5, `light --muted ${muted} on white: ${ratio(muted, "#FFFFFF").toFixed(2)}:1`);
  assert.match(dashCss, /\.dpv__coin, \.dpv__disc \{[^}]*color: #062A1F;/);
  assert.ok(ratio("#062A1F", "#37C29A") >= 6, "on the coin's green, where the label sits");
});

test("the small text that carries each number's source, age and reason reads at 4.5:1 or more in both themes (review A11Y-CONTRAST-SOURCES)", () => {
  // measured at 390 px: in var(--faint) these read 3.36 to 4.42:1 (light #7A869C, dark #6E7B92) on the tiles' surfaces
  const SURFACES = { dark: ["#1B212A", "#141A24", "#060C17"], light: ["#F3F5F6", "#FFFFFF", "#F4F6FA"] }; // a tile, a card, the page
  const [dark, light] = values("--muted");
  for (const s of SURFACES.dark) assert.ok(ratio(dark, s) >= 4.5, `dark --muted ${dark} on ${s}: ${ratio(dark, s).toFixed(2)}:1`);
  for (const s of SURFACES.light) assert.ok(ratio(light, s) >= 4.5, `light --muted ${light} on ${s}: ${ratio(light, s).toFixed(2)}:1`);
  for (const sel of [".lp-src", ".coin-foot", ".coin-tile__src", ".coin-trade__who", ".coin-sources"]) {
    const rule = new RegExp(`\\n${sel.replace(/[.]/g, "\\.")} \\{[^}]*\\}`).exec(css);
    assert.ok(rule, sel);
    assert.match(rule[0], /color: var\(--muted\);/, `${sel}: ${rule[0]}`);
    assert.doesNotMatch(rule[0], /--faint/, sel);
  }
});

test("the floating header's links and labels read at 4.5:1 or more on its glass, in both themes, at rest and scrolled", () => {
  // design v4: the header is translucent glass (--glass-bg, then --glass-bg-strong once the page scrolls) over the page; its links and Log
  // in are --muted and --text-2. The glass is composited over --bg (what is under the header at the top of every page). The header's
  // "Oct 10 / Open" launch chip is gone (the Launchpad opened on 10 Oct), and its contrast pin with it.
  const at = css.indexOf(':root[data-theme="light"] {');
  const hexOf = (b, n) => new RegExp(`${n}: (#[0-9A-Fa-f]{6})`).exec(b)[1];
  const rgbaOf = (b, n) => { const m = new RegExp(`${n}: rgba\\((\\d+),(\\d+),(\\d+),(\\.\\d+)\\)`).exec(b); assert.ok(m, n); return m.slice(1).map(Number); };
  const over = ([r, g, b, a], bg) => { const n = parseInt(bg.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255]; return "#" + [r, g, b].map((v, i) => Math.round(v * a + c[i] * (1 - a)).toString(16).padStart(2, "0")).join(""); };
  for (const [name, b] of [["dark", css.slice(0, at)], ["light", css.slice(at)]]) {
    const bg = hexOf(b, "--bg");
    for (const glass of ["--glass-bg", "--glass-bg-strong"]) {
      const surface = over(rgbaOf(b, glass), bg);
      for (const text of ["--muted", "--text-2", "--text"]) assert.ok(ratio(hexOf(b, text), surface) >= 4.5, `${name} ${text} on ${glass} (${surface}): ${ratio(hexOf(b, text), surface).toFixed(2)}:1`);
    }
  }
  assert.doesNotMatch(css, /\.nav__open|\.nav__soon/, "no launch chip in the header any more");
});

test("form fields: their border reads 3:1 or more on the page, a card and an opaque layer, in both themes (WCAG 1.4.11)", () => {
  // design v4 review: a --line-2 border (.14) measured 1.44:1 (dark) and 1.35:1 (light), so inputs vanished as components
  const at = css.indexOf(':root[data-theme="light"] {');
  const alpha = (b) => Number(/--field-line: rgba\(.*?,(\.\d+)\);/.exec(b)[1]);
  const over = (ink, a, bg) => { const n = parseInt(bg.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255]; return "#" + c.map((v, i) => Math.round(ink[i] * a + v * (1 - a)).toString(16).padStart(2, "0")).join(""); };
  for (const bg of ["#060C17", "#0A1322", "#0F1C31"]) { const line = over([255, 255, 255], alpha(css.slice(0, at)), bg); assert.ok(ratio(line, bg) >= 3, `dark field line on ${bg}: ${ratio(line, bg).toFixed(2)}:1`); }
  for (const bg of ["#F4F6FA", "#FFFFFF", "#EEF2F7"]) { const line = over([11, 22, 38], alpha(css.slice(at)), bg); assert.ok(ratio(line, bg) >= 3, `light field line on ${bg}: ${ratio(line, bg).toFixed(2)}:1`); }
  for (const sel of [".su-field input {", ".lp-search input {", ".lp-field select {", ".find-box {", ".prof-search input {", ".snap-lookup input {"]) {
    const rule = css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
    assert.match(rule, /border: 1px solid var\(--field-line\)/, sel);
  }
});
