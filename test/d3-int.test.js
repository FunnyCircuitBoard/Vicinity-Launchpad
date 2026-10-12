// d3 integration (12 Oct 2026): the home track (design3/home) and the Claim a city track (design3/cities) merged on feat/design-v3.
// What only shows once both are together, pinned here (checked in Chromium against the real Worker at 320-430 and 1024-1920 px, dark
// and light: SCRATCH/d3-shots-int/index.html):
// * /cities inherits the home track's shared CSS (root clip, wordmark on every phone, balanced headings) and still keeps its own map
//   page rules (pages-cities.css loads last);
// * the "Pick your city on the map" panel says each rule once: the note under its button no longer repeats "Locals decide".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const style = read("public/style.css"), cities = read("public/cities.html"), js = read("public/cities.js");

test("d3 integration: /cities gets the shared root clip, wordmark and balanced headings, with its own sheet last", () => {
  assert.match(style, /\nhtml \{[^}]*overflow-x: clip; \}/, "the page never gets wider than the screen");
  assert.match(style, /h1, h2, h3, \.page-title \{[^}]*text-wrap: balance/, "balanced headings site-wide");
  const sheets = [...cities.matchAll(/<link rel="stylesheet" href="\/([^"?]+)/g)].map((m) => m[1]);
  assert.ok(sheets.includes("style.css") && sheets.includes("polish.css") && sheets.includes("pages-cities.css"), sheets.join(" "));
  assert.ok(sheets.indexOf("pages-cities.css") > sheets.indexOf("polish.css"), "the page's own sheet overrides the shared ones");
});

test("d3 integration: the Pick-a-city panel says the Seed Steward rule once (the note under its button no longer repeats it)", () => {
  const rule = "72-hour window";
  const markup = cities.slice(cities.indexOf('id="claim-reqs"'), cities.indexOf('id="claim-note"'));
  assert.ok(markup.includes(rule), '"Locals decide" in the steps above the button gives the rule');
  const note = js.slice(js.indexOf('const note = $("#claim-note");'), js.indexOf("function select(c, fly = false)"));
  // the default (applications open, no other home city): the last branch of the note
  const dflt = (note.match(/\n      : "([^"]*)";[^\n]*\n  \}\s*$/) || [])[1];
  assert.equal(dflt, "Apply, or endorse a neighbour who applied, in your dashboard: it checks your wallet, holding time and location together.");
  assert.ok(!dflt.includes(rule) && !dflt.includes("Seed Steward"), "the note adds the next step instead of the rule again");
  assert.doesNotMatch(dflt, /\blive\b|launch/i, "honest copy: nothing about city coins being live or launching");
});
