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
  assert.match(style, /\nhtml \{ scroll-behavior: smooth; -webkit-text-size-adjust: 100%; scroll-padding-top: 84px; overflow-x: clip; \}/);
  assert.match(style, /\nbody \{[^}]*overflow-x: hidden; overflow-x: clip; \}/);
});

test("d3 wordmark: never hidden on a phone; a long account label is cut with an ellipsis instead", () => {
  assert.doesNotMatch(style + polish, /\.brand span \{ display: none; \}/, "the 380 px rule that hid 'Vicinity' is gone");
  assert.match(style, /@media \(max-width: 440px\) \{ \.account-btn \[data-account-label\] \{ display: inline-block; max-width: max\(3\.2em, calc\(100vw - 262px\)\); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; \} \}/,
    "'Finish sign-in' or a 16-character name stays 8 px or more from the theme button at 320-430 px ('Log in' is never cut)");
  assert.doesNotMatch(polish, /only the logo shows/);
});

const homeSrc = read("scripts/pages/src/index.html"), home = read("public/index.html"), js = read("public/home.js");
const hero = (h) => h.slice(h.indexOf('<section class="hero" id="hero">'), h.indexOf("</section>", h.indexOf('<section class="hero" id="hero">')));

test("d3 hero: no glow blobs at the screen's edges; the light is anchored to the copy and the map card, still, inside the hero", () => {
  for (const h of [homeSrc, home]) assert.doesNotMatch(hero(h), /class="orb/, "the two .orb blobs are gone from the home hero (the Launchpad hero keeps its own)");
  assert.match(style, /\.hero \{ position: relative; padding: 56px 0 70px; overflow: hidden; isolation: isolate; \}/, "the hero clips its own light");
  assert.match(style, /\.hero-map::before \{ content: ""; position: absolute; inset: -16% -14% -10%; z-index: -1; pointer-events: none; background: radial-gradient\(closest-side, rgba\(255,90,54,\.30\)/);
  assert.match(style, /\.hero__copy::before \{ content: ""; position: absolute; z-index: -1; pointer-events: none;[^}]*rgba\(43,91,255,\.14\)/);
  for (const sel of [".hero-map::before", ".hero__copy::before"]) for (const m of style.matchAll(new RegExp(`${sel.replace(/[.:]/g, "\\$&")} \\{([^}]*)\\}`, "g"))) assert.doesNotMatch(m[1], /animation|filter:/, `${sel}: still, no blur filter`);
  assert.match(style, /@keyframes drift \{/, "drift stays: the Launchpad hero's orbs use it");
});

test("d3 hero chips: in the map card's corners, 16 px in, floating 6 px at most and only when motion is welcome", () => {
  assert.match(style, /\.hero-map__link \{ position: relative; display: block;/, "the card (not the figure with its caption) is the chips' containing block");
  assert.match(style, /\.hero-chip--1 \{ top: 16px; left: 16px; \} \.hero-chip--3 \{ top: 16px; right: 16px; \} \.hero-chip--2 \{ bottom: 16px; right: 16px; \}/, "no chip on the $NYC coin (the old one sat at 40 % right -4 %)");
  assert.match(style, /\n\.hero-chip \{ position: absolute;[^}]*\}/);
  assert.doesNotMatch(style.match(/\n\.hero-chip \{ position: absolute;[^}]*\}/)[0], /animation/, "the float is not in the base rule");
  assert.match(style, /@media \(prefers-reduced-motion: no-preference\) \{ \.hero-chip \{ animation: float 6s ease-in-out infinite; \}/);
  assert.match(style, /@keyframes float \{ 50% \{ transform: translateY\(-6px\); \} \}/);
  assert.match(style, /\.mo-off \.hero-chip/, "it pauses off screen");
  for (const h of [homeSrc, home]) assert.match(h, /<figcaption class="tiny muted">Real map data\. \$NYC isn't launched yet: it can only launch on the Vicinity Launchpad\.<\/figcaption>/, "no 'Real data' beside a $NYC chip");
});

test("d3 facts: strong facts only, members at 100 or more, no countdown, nothing that reads like trading", () => {
  for (const h of [homeSrc, home]) {
    assert.doesNotMatch(h, /data-countdown-short|data-countdown-label/);
    assert.doesNotMatch(hero(h), /\bLive\b|Launchpad is open|data-stat="members"/);
    assert.match(hero(h), /<span>Open · city coins come next <span aria-hidden="true">→<\/span><\/span>/);
    assert.match(hero(h), /countries &amp; territories/, "244 country codes include territories");
  }
  assert.match(js, /const MEMBERS_MIN = 100;/);
  assert.match(js, /if \(!m \|\| typeof m\.members !== "number" \|\| m\.members < MEMBERS_MIN\) return;/, "below 100: no tile at all");
  assert.match(js, /const countries = \$\("\.hero__fact--countries"\); if \(!countries\) return;[\s\S]*?countries\.replaceWith\(li\);/, "the members tile takes the countries tile's place (three / four tiles stay)");
});

test("d3 NYC walkthrough: no flags, a legend under the map, one view per step, labels sized on screen and laid out without collisions", () => {
  assert.doesNotMatch(js, /m-flag|flag\(|[\u{1F300}-\u{1FAFF}]/u, "no SVG flags, no emoji");
  assert.doesNotMatch(style, /\.m-flag/);
  for (const h of [homeSrc, home]) {
    assert.match(h, /<div class="nyc__map" data-fb-avoid>\s*<svg id="nyc-map" viewBox="290 255 440 440"/, "the feedback button steps aside from the map; the first view in the markup (no jump)");
    assert.match(h, /<ul class="nyc__legend" aria-label="Map key">\s*<li class="nyc__key nyc__key--official">[^]*?Official boundary[^]*?<li class="nyc__key nyc__key--member">[^]*?Part of \$NYC \(<b data-stat="nycMembers">46<\/b>&nbsp;places\)[^]*?<li class="nyc__key nyc__key--nb">[^]*?Neighbour: gets its own coin/);
    assert.match(h, /Yonkers, Paterson and Hempstead each get their own coin/, "no city coin exists yet");
    assert.match(h, /<span class="steps__fact"><span class="ico ico--sm ico--gold" aria-hidden="true"><svg [^>]+>[^]*?<\/svg><\/span><span>City Founder seat: open/);
    assert.match(h, /The Launchpad opened on October 10/);
  }
  assert.match(js, /const VIEW_CITY = \[290, 255, 440, 440\], VIEW_REGION = \[250, 170, 560, 560\];/);
  assert.match(js, /const viewFor = \(s\) => \(s <= 2 \? VIEW_CITY : VIEW_REGION\);/);
  assert.match(js, /svg\.style\.setProperty\("--u", u\.toFixed\(4\)\);/, "through the CSSOM (style-src 'self': no style attribute in markup)");
  assert.match(js, /const NAMED = \["Newark", "Yonkers", "Paterson", "Hempstead"\]/, "the neighbours the copy names come first");
  assert.match(js, /max: phone \? 5 : 6/, "six neighbour labels at most (the four named, then the biggest)");
  assert.match(js, /if \(document\.fonts && document\.fonts\.ready\) document\.fonts\.ready\.then\(layout\);/, "measured again once the fonts load");
  assert.match(js, /window\.V\.reduced \|\| box\.classList\.contains\("mo-off"\)/, "the view jumps (no glide) with reduced motion, Pause animations or off screen");
  assert.match(style, /\.m-label \{ font-family: var\(--body\); font-weight: 600; font-size: calc\(13px \* var\(--u, 1\.6\)\);[^}]*stroke-width: calc\(4px \* var\(--u, 1\.6\)\);/, "13 px on screen at every width");
  assert.match(style, /\.m-label--big \{[^}]*font-size: calc\(15px \* var\(--u, 1\.6\)\);/);
  assert.match(style, /\.nyc__map svg \{ display: block; width: 100%; height: auto; aspect-ratio: 1 \/ 1; \}/, "square: a view change never moves the page");
  assert.doesNotMatch(style, /\.m-label \{ font-size: 30px/, "the 30-unit phone size (9.8 px on screen) is gone");
});

test("d3 headings: balanced, no single word on a last line, one section-title size on the home page", () => {
  assert.match(style, /\nh1, h2, h3, \.page-title \{ text-wrap: balance; \}/);
  assert.match(polish, /\[data-page="home"\] \.section-head h2 \{ font-size: var\(--fs-xl\); max-width: none; \}/, "36 px on a computer (no 48 px exceptions), the NYC title on one line");
  for (const h of [homeSrc, home]) {
    const main = h.slice(h.indexOf('<section class="hero"'), h.indexOf("</main>") > 0 ? h.indexOf("</main>") : undefined); // the page's own titles (the layout's gate is build.mjs's)
    for (const m of main.matchAll(/<h([23])[^>]*>(.*?)<\/h\1>/g)) {
      const words = m[2].replace(/<[^>]+>/g, "").trim().split(/ +/);
      if (words.length > 1) assert.match(words[words.length - 1], /&nbsp;/, `"${m[2]}": the last two words are tied (browsers without text-wrap: balance)`);
    }
  }
  assert.match(homeSrc, /<h3>Sign in with Google or&nbsp;<span class="nowrap">e-mail<\/span><\/h3>/);
});

test("d3 phone step card: the four steps share one cell, so the controls under them never jump while it plays", () => {
  assert.match(polish, /  \.steps \{ display: grid; gap: 0; margin-bottom: 10px; \}\n  \.steps li \{ grid-area: 1 \/ 1; display: grid; \}\n  \.steps button:not\(\[aria-current="step"\]\) \{ visibility: hidden; \}/);
  assert.match(polish, /  \.steps em, \.steps button\[aria-current="step"\] em \{ max-height: none; margin-top: 4px; \}/, "each step at its full height");
  assert.match(polish, /\.nyc__ctrl \{ margin-top: auto; \}/, "a computer: the controls and the member card at the column's foot, level with the map's bottom");
  assert.doesNotMatch(polish, /\.member-cloud li\.is-more \{ display: inline-flex; \} \.member-cloud li:has/, "five boroughs and +41 more on every screen");
});

test("d3 walkthrough layout: a wide computer shows the whole story at once; a phone's step card shows where the story is", () => {
  const wide = polish.match(/@media \(min-width: 1200px\) \{\n[\s\S]*?\n\}/)[0];
  assert.match(wide, /\.nyc \{ grid-template-columns: minmax\(0, 1\.05fr\) minmax\(0, \.95fr\); grid-template-rows: auto 1fr auto; grid-template-areas: "map steps" "map ctrl" "facts facts"; gap: 0 32px; \}/);
  assert.match(wide, /\.steps em, \.steps button\[aria-current="step"\] em \{ max-height: none;/, "every step's text shows: nothing changes height while it plays");
  assert.match(wide, /\.nyc__steps \.nyc__ctrl \{ grid-area: ctrl; align-self: end;/, "the controls level with the map's foot");
  assert.match(wide, /\.nyc__steps \.nyc__facts \{ grid-area: facts;/, "Inside $NYC as one band under both columns");
  assert.match(polish, /\.nyc\[data-step="2"\] \.steps \{ --steps-done: 50%; \} \.nyc\[data-step="3"\] \.steps \{ --steps-done: 75%; \} \.nyc\[data-step="4"\] \.steps \{ --steps-done: 100%; \}/, "four segments along a phone's step card");
  assert.doesNotMatch(polish.match(/\.steps::after \{[^}]*\}/)[0], /animation|transition/, "still");
});
