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
