// Home: the second hero button is "My Dashboard" (to /dashboard). Cities: the map comes first, then the numbers, then
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

test("home: both 'Find my city' buttons are now 'My Dashboard' and open /dashboard", () => {
  for (const [where, h] of both("index")) {
    assert.doesNotMatch(h, /Find my city/i, `${where}: the old label is gone`);
    const ctas = [...h.matchAll(/<div class="hero__cta[^"]*">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
    const withDash = ctas.filter((c) => c.includes("My Dashboard"));
    assert.equal(withDash.length, 2, `${where}: the hero and the closing band`);
    for (const c of withDash) {
      assert.match(c, /<a class="btn btn--glass btn--lg" href="\/dashboard">My Dashboard<\/a>/, `${where}: a plain link to the dashboard`);
      assert.ok(c.indexOf("Get $VICINITY") < c.indexOf("My Dashboard"), `${where}: buying stays the first button`);
    }
    assert.equal((h.match(/>My Dashboard</g) || []).length, 2, `${where}: no third copy`);
  }
  // no script renames the button afterwards (a signed-in visitor also lands on their dashboard through /dashboard)
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
    for (const t of ["communities", "countries", "founded", "still open", "verified members", "claims", "100,000 to 1,000,000 $VICINITY", '<a href="/rules#founders">How it works</a>']) assert.ok(sec.includes(t), `${where}: ${t}`);
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
  assert.match(mediaWith(600, ".citymap canvas") || "", /aspect-ratio: 1 \/ 1; max-height: 70vh; max-height: 70svh;/, "a square map on a phone that never fills the whole screen");
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

test("phones: the city stats keep their labels inside the cards and both rows even; the closing buttons on Home reach both edges", () => {
  // review of 6 Oct 2026 at 320 and 390 px: "communities" ran into its card's padding, "verified members" (two lines) made the second
  // row taller than the first, and "Get $VICINITY →" / "My Dashboard" at the bottom of Home stopped 16 px short of the right edge
  const phone = css.slice(css.indexOf("@media (max-width: 520px) {\n  .city-stats {"));
  assert.match(phone, /^@media \(max-width: 520px\) \{\n  \.city-stats \{ gap: 8px; margin-bottom: 24px; grid-auto-rows: 1fr; \}/, "rows as tall as the tallest");
  assert.match(phone, /\n  \.city-stats div \{ padding: 10px 9px; border-radius: 14px; \}/, "a little less side padding");
  assert.match(css, /@media \(max-width: 360px\) \{ \.city-stats span \{ font-size: \.7rem; \} \}/, "and slightly smaller labels on the smallest phones");
  assert.match(css, /@media \(max-width: 480px\) \{ \.cta-band \.hero__cta--end \{ flex: 1 1 100%; \} \}/);
  assert.match(css, /@media \(max-width: 480px\) \{ \.hero__cta \.btn--lg \{ flex: 1 1 auto;/, "the buttons inside it share the full width");
});
