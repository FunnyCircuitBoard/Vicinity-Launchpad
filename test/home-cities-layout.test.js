// Home: one hero button (Get $VICINITY, to the Token page's buy slot). Cities: the map comes first, then the numbers, then
// the page's title and description, with every id, aria attribute and text kept, and a tidy phone layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("public/style.css");
const both = (name) => [["public", read(`public/${name}.html`)], ["src", read(`scripts/pages/src/${name}.html`)]];
/** The body of the first `@media (max-width: <px>px) { ... }` block holding `needle` (balanced braces). */
const mediaWith = (px, needle) => {
  for (const m of css.matchAll(new RegExp(`@media \\(max-width: ${px}px\\) \\{`, "g"))) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < css.length && depth; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    const body = css.slice(m.index + m[0].length, i - 1);
    if (body.includes(needle)) return body;
  }
  return null;
};

test("home: one hero button, Get $VICINITY, straight to the buy slot of the Token page; no second button and no closing band (the header has Log in)", () => {
  // the mobile polish of 9 Oct 2026: the hero had "Get $VICINITY" + "My Dashboard" and the page closed with the same pair again
  for (const [where, h] of both("index")) {
    assert.doesNotMatch(h, /Find my city|>My Dashboard</, `${where}: the old second button is gone`);
    const ctas = [...h.matchAll(/<div class="hero__cta[^"]*">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
    assert.equal(ctas.length, 1, `${where}: one row of hero buttons`);
    assert.match(ctas[0], /^\s*<a class="btn btn--primary btn--lg" href="\/token#buy-slot">Get \$VICINITY <span aria-hidden="true">→<\/span><\/a>\s*$/, `${where}: one button, to the buy slot`);
    assert.doesNotMatch(h, /cta-band|class="numbers"/, `${where}: no closing band, no numbers band`);
    assert.equal((h.match(/Get \$VICINITY/g) || []).length, 1, `${where}: the call to buy is made once`);
  }
  for (const f of ["site.js", "home.js"]) assert.doesNotMatch(read(`public/${f}`), /Find my city|My Dashboard/, f);
});

test("home: on a phone the two hero buttons sit side by side when they fit and go full width when they don't", () => {
  const body = mediaWith(480, ".hero__cta .btn--lg");
  assert.ok(body, "a phone rule for the hero buttons");
  assert.match(body, /\.hero__cta \.btn--lg \{ flex: 1 1 auto; padding: 0 18px; \}/);
  assert.match(css, /\.btn--lg \{ min-height: 56px;/, "still a big touch target");
});

test("cities: the map first, then the numbers, then the description; every id, aria attribute and text kept", () => {
  for (const [where, h] of both("cities")) {
    const start = h.indexOf('<section class="page-hero page-hero--map" id="cities">');
    assert.ok(start >= 0, where);
    const sec = h.slice(start, h.indexOf("</section>", start));
    const at = (needle) => { const i = sec.indexOf(needle); assert.ok(i >= 0, `${where}: ${needle}`); return i; };
    const order = [
      at('<div class="citymap card">'), at('id="city-canvas"'), at('class="map-ctrl"'), at('id="map-hint"'), at('class="citymap__legend"'),
      at("Latest founders · live"), at('id="claim-feed"'),
      at('<div class="city-stats" aria-live="polite">'), at('id="cs-cities"'), at('id="cs-status"'),
      at('<div class="cities-intro">'), at(">Live map</p>"), at('<h1 class="page-title">Claim your city.</h1>'), at("One wallet. One city. Chosen by locals."),
    ];
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `${where}: map card (canvas, controls, hint, legend, live feed) → stats → kicker, h1, lead`);
    // the map is the very first thing in the section, so "scroll to the map" (Most wanted → the map) lands on it
    assert.match(sec, /^<section class="page-hero page-hero--map" id="cities">\s*<div class="wrap">\s*(<!--[^>]*-->\s*)?<div class="citymap card">/, `${where}: the map opens the section`);
    assert.equal((h.match(/<h1\b/g) || []).length, 1, `${where}: exactly one h1`);
    for (const id of ["cities", "city-canvas", "city-tip", "map-in", "map-out", "map-reset", "map-locate", "map-style", "map-zoom-level", "map-hint", "claim-feed", "cs-cities", "cs-countries", "cs-claimed", "cs-open", "cs-members", "cs-status"]) {
      assert.equal((h.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${where}: #${id} once`);
    }
    for (const a of ['role="img" tabindex="0" aria-label="Zoomable world map of every listed city.', 'role="group" aria-label="Map controls"', 'aria-label="Find the city I\'m in" title="Find the city I\'m in"', 'aria-label="Show the coloured map" aria-pressed="false"', '<span id="map-zoom-level" aria-live="polite">', '<ul class="claim-feed" id="claim-feed" aria-live="polite">']) assert.ok(sec.includes(a), `${where}: ${a}`);
    for (const t of ["communities", "countries", "founded", "still open", "verified members", "claims", "founder amount", '<a href="/rules#founders">How it works</a>']) assert.ok(sec.includes(t), `${where}: ${t}`);
    assert.doesNotMatch(sec, /100,000 to 1,000,000/, `${where}: the Stake Ladder's numbers are stated once on the page, in the Pick-a-city checklist (9 Oct 2026)`);
    assert.doesNotMatch(sec, /\breveal\b/, `${where}: nothing at the top waits for a script to become visible`);
  }
});

test("cities: public/cities.js finds everything by id, not by position", () => {
  const js = read("public/cities.js");
  assert.match(js, /const sec = document\.getElementById\("cities"\)/);
  assert.match(js, /sec\.scrollIntoView\(\{ behavior: reduced \? "auto" : "smooth" \}\)/, "Most wanted → the section, whose top is now the map; no smooth scroll with reduced motion");
  assert.match(js, /new URLSearchParams\(location\.search\)\.get\("city"\)/, "/cities?city=<id> still opens that city");
  assert.doesNotMatch(js, /firstElementChild|previousElementSibling|nextElementSibling|children\[/, "no reliance on the order of elements");
});

test("cities CSS: the map right under the header, the stats a tidy grid, the description after, 44 px map buttons", () => {
  assert.match(css, /\.page-hero--map \{ padding: 28px 0 10px; \}/);
  assert.match(mediaWith(600, ".page-hero--map") || "", /\.page-hero--map \{ padding-top: 12px; \}/, "on a phone the map starts right under the header");
  // the map is big (the owner, 6 Oct 2026: "make the map look bigger"): on a phone it runs edge to edge, from the header to just above the
  // tab bar, with the legend's first line still showing under it (it was a 1:1 square at 70% of the screen before)
  const phoneStage = mediaWith(600, ".citymap__stage") || "";
  assert.match(phoneStage, /\.citymap__stage \{ margin-inline: calc\(-1 \* var\(--wrap-pad\)\); border-radius: 0; height: clamp\(420px, calc\(100vh - 206px\), 820px\); height: clamp\(420px, calc\(100svh - 206px - env\(safe-area-inset-bottom\)\), 820px\); \}/, "a phone map from edge to edge, nearly the whole screen");
  assert.match(css, /\.city-stats \{ display: grid; grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);/);
  assert.match(mediaWith(900, ".city-stats") || "", /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/, "three by two on tablets and phones");
  assert.ok(!/repeat\(2, 1fr\)/.test(mediaWith(520, ".city-stats") || ""), "phones keep the three-column grid");
  assert.match(css, /\.cities-intro \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\);/, "computers: title left, description right");
  assert.match(mediaWith(1100, ".cities-intro") || "", /grid-template-columns: minmax\(0, 1fr\)/, "smaller screens: one column");
  // map buttons: 36 px on a phone, with an invisible 4 px ring = 44 px to tap; 38 px + 3 px ring on a computer
  assert.match(css, /\.map-ctrl button \{ position: relative; \}/);
  assert.match(css, /\.map-ctrl button::after \{ content: ""; position: absolute; inset: -3px;/);
  const phone = mediaWith(600, ".map-ctrl button");
  assert.match(phone, /\.map-ctrl \{ gap: 8px;/, "the rings don't overlap");
  assert.match(phone, /\.map-ctrl button \{ width: 36px; height: 36px;/);
  assert.match(phone, /\.map-ctrl button::after \{ inset: -4px; \}/);
  // nothing new moves: the blocks added here carry no animation (the global reduced-motion block covers the rest)
  for (const sel of [".cities-intro", ".city-stats"]) for (const m of css.matchAll(new RegExp(`\\${sel}[^{]*\\{([^}]*)\\}`, "g"))) assert.doesNotMatch(m[1], /animation|opacity: 0/, sel);
});

test("phones: the city stats keep their labels inside the cards and both rows even; the hero button on Home reaches both edges", () => {
  // review of 6 Oct 2026 at 320 and 390 px: "communities" ran into its card's padding, "verified members" (two lines) made the second
  // row taller than the first, and "Get $VICINITY →" / "My Dashboard" at the bottom of Home stopped 16 px short of the right edge
  const phone = css.slice(css.indexOf("@media (max-width: 520px) {\n  .city-stats {"));
  assert.match(phone, /^@media \(max-width: 520px\) \{\n  \.city-stats \{ gap: 8px; margin-bottom: 24px; grid-auto-rows: 1fr; \}/, "rows as tall as the tallest");
  assert.match(phone, /\n  \.city-stats div \{ padding: 10px 9px; border-radius: 14px; \}/, "a little less side padding");
  assert.match(css, /@media \(max-width: 360px\) \{ \.city-stats span \{ font-size: \.7rem; \} \}/, "and slightly smaller labels on the smallest phones");
  assert.doesNotMatch(css, /\.cta-band/, "the closing band and its rules are gone (9 Oct 2026)");
  assert.match(css, /@media \(max-width: 480px\) \{ \.hero__cta \.btn--lg \{ flex: 1 1 auto;/, "the hero button takes the full width");
});
