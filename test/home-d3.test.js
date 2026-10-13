// d3 (11 Oct 2026), the owner: "i shared with you the home page and the claim a city page in both phone and desktop version. there are
// significant design issues". What the home track fixed, pinned here (measured in Chromium at 320-430 and 1024-1920 px, dark and light,
// against the real Worker with the d3 acceptance script):
// * the page never gets wider than the screen for any browser or screenshot tool: html and body clip sideways (body with clip, never
//   hidden: that broke the sticky header);
// * the "Vicinity" wordmark shows on every phone (it was hidden at 380 px and under); a long signed-in name is cut to fit beside it;
// * the hero: no glow blobs at the screen's edges (light anchored to the copy and the map card), the map card's chips in its corners (one
//   of them covered the $NYC coin), honest facts as tiles (no "Live / Launchpad is open", no member count under 100);
// * the New York walkthrough: no SVG flags over the map, a legend under it, one view per step (zoomed in on the city, then out to its
//   neighbours), labels that never collide and are 12 px or more on screen, the feedback button steps aside from the map;
// * headings: balanced wrapping and no single word on a last line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const style = read("public/style.css"), polish = read("public/polish.css");

test("d3 root clip: html and body clip sideways, body with clip (hidden only as the fallback) so the sticky header keeps sticking", () => {
  // design v4: an anchor lands 16 px under the floating header's bottom edge (--header-h: 60 px on a phone, 68 px from 901 px)
  assert.match(style, /\nhtml \{ scroll-behavior: smooth; -webkit-text-size-adjust: 100%; scroll-padding-top: calc\(var\(--header-h\) \+ 16px\); overflow-x: clip; \}/);
  assert.match(style, /\nbody \{[^}]*overflow-x: hidden; overflow-x: clip; \}/);
});

test("d3 wordmark: never hidden on a phone; a long account label is cut with an ellipsis instead", () => {
  assert.doesNotMatch(style + polish, /\.brand span \{ display: none; \}/, "the 380 px rule that hid 'Vicinity' is gone");
  // design v4: on a phone the theme switch is in the footer, so the room beside the wordmark is the bar minus its padding and the brand
  assert.match(style, /@media \(max-width: 440px\) \{ \.account-btn \[data-account-label\] \{ display: inline-block; max-width: max\(3\.2em, calc\(100vw - 232px\)\); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; \} \}/,
    "'Finish sign-in' or a 16-character name stays clear of the wordmark at 320-440 px ('Log in' is never cut)");
  assert.match(style, /@media \(max-width: 480px\) \{ \.site-header \.theme-toggle \{ display: none; \} \}/, "the theme switch leaves the phone's header (the footer has one)");
  assert.doesNotMatch(polish, /only the logo shows/);
});

// Design v4 (12 Oct 2026, track B; the owner: "no NYC map on the home page", "One city. One coin." centred at the top): the hero's map card,
// its chips, the fact tiles and the New York walkthrough are gone, so the d3 pins on them went with them (their style.css / polish.css
// rules are dead CSS on the integration cleanup's list, SPEC A.9). What d3 fixed and still applies is pinned here; test/home-v4.test.js
// pins the new page.
const homeSrc = read("scripts/pages/src/index.html"), home = read("public/index.html"), js = read("public/home.js"), homeCss = read("public/pages-home.css");
const heroOf = (h) => h.slice(h.indexOf('<section class="hero4" id="hero">'), h.indexOf("</section>", h.indexOf('<section class="hero4" id="hero">')));

test("d3 hero (design v4): no glow blobs at the screen's edges: one still light at the hero's top, clipped by the hero", () => {
  for (const h of [homeSrc, home]) { assert.ok(heroOf(h).length > 100, "the hero"); assert.doesNotMatch(heroOf(h), /class="orb|hero__bg|grid-floor/, "no orbs, no grid floor"); }
  assert.match(homeCss, /\.hero4 \{ position: relative; isolation: isolate; overflow: hidden;/, "the hero clips its own light");
  const glow = homeCss.match(/\.hero4::before \{([^}]*)\}/)[1];
  assert.match(glow, /background: var\(--grad-glow\);/);
  assert.doesNotMatch(glow, /animation|filter:/, "still, no blur filter");
  assert.doesNotMatch(style, /@keyframes drift \{|animation: drift/, "design v4: the Launchpad hero's orbs stay still too (nothing loops)");
});

test("d3 facts (design v4: the live numbers bar): members only from 100, no countdown, nothing that reads like trading", () => {
  for (const h of [homeSrc, home]) {
    assert.doesNotMatch(h, /data-countdown-short|data-countdown-label/);
    assert.doesNotMatch(heroOf(h), />\s*Live( now)?\s*<|Launchpad is open|data-stat="members"/, "no \"Live\" badge (the bar's own name, \"Live numbers\", is its label)");
  }
  assert.match(js, /const MEMBERS_MIN = 100;/);
  assert.match(js, /if \(members != null && members >= MEMBERS_MIN\)/, "below 100: no members item at all");
  assert.match(js, /label: "Countries & territories"/, "244 country codes include territories");
});

test("d3 map (design v4): no map on the home page at all, so no flags, labels or emoji to collide", () => {
  for (const h of [homeSrc, home]) assert.doesNotMatch(h.slice(h.indexOf("<section")), /nyc-map|hero-map|id="nyc"|m-flag|data-stat="nycMembers"/);
  assert.doesNotMatch(js, /m-flag|flag\(|demo-nyc|[\u{1F300}-\u{1FAFF}]/u, "no map drawing, no emoji");
});

test("d3 headings: balanced, no single word on a last line, one section-title size on the home page", () => {
  assert.match(style, /\nh1, h2, h3, \.page-title \{ text-wrap: balance; \}/);
  assert.match(polish, /\[data-page="home"\] \.section-head h2 \{ font-size: var\(--fs-xl\); max-width: none; \}/, "36 px on a computer (no 48 px exceptions)");
  for (const h of [homeSrc, home]) {
    const main = h.slice(h.indexOf('<section class="hero4"'), h.indexOf("</main>") > 0 ? h.indexOf("</main>") : undefined); // the page's own titles (the layout's gate is build.mjs's)
    const titles = [...main.matchAll(/<h([23])[^>]*>(.*?)<\/h\1>/g)];
    assert.ok(titles.length >= 5, "How it works, its three cards, the app teaser");
    for (const m of titles) {
      const words = m[2].replace(/<[^>]+>/g, "").trim().split(/ +/);
      if (words.length > 1) assert.match(words[words.length - 1], /&nbsp;/, `"${m[2]}": the last two words are tied (browsers without text-wrap: balance)`);
    }
  }
});
