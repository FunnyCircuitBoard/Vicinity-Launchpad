// Design v3, the review of 12 Oct 2026 (after the owner's "significant design issues" on the home page and Claim a city, phone and
// desktop). The camera's own rules (mapFrame, coreBox, the crosshair, the opened city's chip, the quiet focus) are pinned with the map's
// tests (test/map-overview.test.js, test/map-labels.test.js, test/cities-find.test.js) and the phone step card with the walkthrough's
// (test/home-d3.test.js). This file pins the rest of the fixes:
// * /cities on a phone: the first screen ends on the whole legend line, 10 px above the tab bar (it ended on a line cut by the see-through
//   tab bar), and what follows starts below the tab bar;
// * /cities on a tablet: the whole world fits from a 600 px stage, in a stage no taller than the world needs;
// * home: the city coins in a row, every name inside its coin ("LOND", "TOKY", "ARIS" before); the walkthrough's $NYC inside its disc and
//   readable on the light theme; no lone word at the end of the hero's lead or a fact tile;
// * glows stay inside the content (the Why section's ran off a wide screen's right edge; /launchpad kept the top-right smudge).
// How it all looks at every width, dark and light, is checked in Chromium on the real Worker (the d3 fixer's probes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const style = read("public/style.css"), polish = read("public/polish.css"), cities = read("public/pages-cities.css"), lp = read("public/pages-launchpad.css");
const js = read("public/cities.js"), homeSrc = read("scripts/pages/src/index.html"), home = read("public/index.html");
const citySrc = read("scripts/pages/src/cities.html"), cityPage = read("public/cities.html");

test("/cities on a phone: the stage leaves room for a one-line legend above the tab bar; the fold starts below the tab bar", () => {
  const ph = cities.match(/@media \(max-width: 600px\) \{\n  #city-stage \{ --legend-room: 40px;[^\n]*\n\}/);
  assert.ok(ph, "the phone's stage rule");
  assert.match(ph[0], /height: calc\(100svh - var\(--stage-top, 220px\) - var\(--bottom-bars, 67px\) - var\(--legend-room\)\); min-height: 236px;/);
  // 12 px margin + an 18 px line + 10 px to the tab bar = 40 px
  assert.match(cities, /#cities \.citymap__legend \{ flex-wrap: nowrap; justify-content: space-between; gap: 0 10px; height: 18px; margin: 12px 0 0; overflow: hidden; line-height: 18px; white-space: nowrap; \}/);
  assert.match(cities, /#cities \.citymap__legend \.citymap__more, #cities \.citymap__legend \.citymap__yours, #cities \.citymap__legend \.citymap__keys \{ display: none; \}/, "four short words on a phone");
  assert.match(cities, /#cities \.citymap \.citymap__howto \{ margin-top: calc\(var\(--bottom-bars, 67px\) \+ 24px\); \}/, "nothing ghosts under the tab icons on the first screen");
  for (const h of [citySrc, cityPage]) {
    assert.match(h, /<span class="citymap__yours"><span class="dot dot--mine" aria-hidden="true"><\/span> Yours<\/span>/);
    assert.match(h, /<span>Choosing<span class="citymap__more"> its founder<\/span><\/span>/, "the word and its tail in one span: one flex item, no gap before the tail on a computer");
    assert.match(h, /<span class="citymap__how citymap__how--key">Active: verified holders, no founder yet · Choosing: its founder · Yours: a city you founded · a solid outline: official boundary \+ nearest land; dashed: nearest land only<\/span>/, "the fold says what the short words mean");
  }
  assert.match(cities, /\.citymap__how--key \{ display: none; \}/, "a computer's legend says it in full");
});

test("/cities on a tablet: the whole world from a 600 px stage, in a stage no taller than the world needs", () => {
  assert.match(js, /\n    wide = W >= 600;\n/);
  assert.match(cities, /@media \(min-width: 601px\) and \(max-width: 900px\) \{\n  #cities \.citymap \{ container-type: inline-size; \}\n  #city-stage \{ height: min\(calc\(100svh - var\(--stage-top, 220px\) - var\(--bottom-bars, 67px\) - 8px\), calc\(100cqw \/ 1\.75\)\); min-height: 360px; \}\n\}/);
});

test("home: the city coins in a row, apart, each name inside its coin", () => {
  for (const h of [homeSrc, home]) assert.match(h, /<span class="coin-disc"><span>LONDON<\/span><\/span>\s*<span class="coin-disc"><span>TOKYO<\/span><\/span>\s*<span class="coin-disc coin-disc--lg"><span>NYC<\/span><\/span>\s*<span class="coin-disc"><span>PARIS<\/span><\/span>\s*<span class="coin-disc"><span>LAGOS<\/span><\/span>/);
  assert.match(polish, /\.why-panel \.early__coins \{ gap: 18px; padding: 10px 0 18px; \}/);
  assert.match(polish, /\.why-panel \.early__coins \.coin-disc \{ width: 72px; height: 72px; margin: 0; \}/, "no overlap (a coin covered its neighbour's name)");
  assert.match(polish, /\.why-panel \.early__coins \.coin-disc span \{ max-width: none; overflow: visible; font-size: \.68rem; letter-spacing: \.04em; \}/, "the name is never cut (LONDON fits a 72 px coin at .68rem)");
  assert.doesNotMatch(polish, /\.why-panel \.early__coins \.coin-disc[^{]*\{[^}]*scale\(/, "no shrunken coins");
});

test("home: the walkthrough's $NYC inside its disc on a 320 px phone, and readable on the light theme", () => {
  assert.match(style, /#nyc-map \.m-coin text \{ font-size: 21px; \}/);
  assert.match(style, /:root\[data-theme="light"\] \.m-coin circle \{ fill: #FFC857; stroke: #B9780F; stroke-width: 2\.5; \}\n:root\[data-theme="light"\] \.m-coin text \{ fill: #3F2702; \}/);
});

test("home: no lone word at the end of the hero's lead or a fact tile", () => {
  assert.match(polish, /\.hero \.lead, \.hero__facts > li > span, \.hero__fact-link > span \{ text-wrap: pretty; \}/, "the tiles' own lines only: text-wrap would undo the .nowrap inside them");
  for (const h of [homeSrc, home]) {
    assert.match(h, /<strong>\$VICINITY<\/strong> is the key to all of&nbsp;them<span class="lead__tail">/, "a phone's lead ended on \"them.\" alone");
    assert.match(h, /<span>Open · city coins <span class="nowrap">come next <span aria-hidden="true">→<\/span><\/span><\/span>/, "\"next →\" alone at 1024 px");
  }
});

test("glows stay inside the content: the Why section's light, /launchpad's orbs", () => {
  assert.match(style, /\.section--glow \{ background: radial-gradient\(min\(440px, 40%\) min\(300px, 45%\) at calc\(50% \+ min\(240px, 20%\)\) 55%, rgba\(255,90,54,\.075\), transparent 72%\), var\(--bg\); \}/);
  assert.doesNotMatch(style, /\.section--glow \{ background: radial-gradient\(ellipse 60% 50% at 80% 50%/, "a 60%-wide glow at 80% ran off the right edge");
  const wide = lp.match(/@media \(min-width: 900px\) \{\n  \.launch-hero \.orb--a \{[^\n]*\n[^\n]*\n[^\n]*\n\}/);
  assert.ok(wide, "the launchpad hero's orbs on a computer");
  assert.match(wide[0], /\.launch-hero \.orb--a \{ width: 520px; height: 340px; top: 10%; right: auto; left: calc\(50% - 470px\); opacity: \.17; \}/, "anchored to the centred title, not the screen's top right corner");
  assert.match(wide[0], /\.launch-hero \.orb--b \{ width: 460px; height: 300px; bottom: 8%; left: calc\(50% - 20px\); opacity: \.14; \}/);
});
