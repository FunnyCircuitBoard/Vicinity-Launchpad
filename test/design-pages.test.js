// Design v2, the pages work (10 Oct 2026): the token, Launchpad, coin, cities, rules, terms, connect/locate, profile and 404 pages
// share one late stylesheet (public/polish-pages.css). What this pins: every one of those pages loads it last; the Buy card holds
// its room while it loads (no jump); motion only for those who want it, with the live strip still for everyone else; the honest
// lines that moved into folds are still on the page; no emoji as icons in those pages' sources; the 404 is one calm empty state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CSS = read("public/polish-pages.css");
const OWN = ["token", "cities", "launchpad", "coin", "profile", "connect", "locate", "rules", "terms", "404"];

test("every page of the pages work loads polish-pages.css, as its last stylesheet", () => {
  for (const p of OWN) {
    for (const h of [read(`public/${p}.html`), read(`scripts/pages/src/${p}.html`)]) {
      const settings = h.match(/<!--(\{.*\})-->/);
      if (settings) { assert.equal(JSON.parse(settings[1]).styles.at(-1), "polish-pages", `${p}: the last "styles" entry`); continue; }
      const sheets = [...h.matchAll(/<link rel="stylesheet" href="\/([a-z-]+)\.css">/g)].map((m) => m[1]);
      assert.equal(sheets.at(-1), "polish-pages", `${p}: ${sheets.join(", ")}`);
    }
  }
});

test("the stylesheet keeps the rules: no import, no outside address, no !important, tokens with a fallback where they are new", () => {
  assert.doesNotMatch(CSS, /@import|@font-face/);
  assert.doesNotMatch(CSS.replace(/url\("data:image\/svg\+xml,[^"]*"\)/g, ""), /https?:\/\//, "the only address is the SVG namespace inside inline icon data");
  assert.doesNotMatch(CSS, /!important/);
  for (const t of ["--surface-2", "--r-pill", "--fs-xs", "--surface-inset"]) {
    for (const m of CSS.matchAll(new RegExp(`var\\(${t}([,)])`, "g"))) assert.equal(m[1], ",", `${t} always has a fallback (the tokens arrive with the home work)`);
  }
});

test("no jump while the token page loads: the Buy card's room is held until token.js knows what it shows", () => {
  assert.match(CSS, /\.buy-slot\.is-pending \{ min-height: 518px; \}/);
  assert.match(CSS, /@media \(max-width: 360px\) \{ \.buy-slot\.is-pending \{ min-height: 555px; \} \}/);
  assert.match(CSS, /\.buy-slot\.is-pending \{ min-height: 530px; \}/, "and on a computer");
  const js = read("public/token.js");
  assert.match(js, /setTimeout\(\(\) => settleBuy\("link"\), 4000\)/, "never more than 4 s");
  assert.match(js, /Promise\.resolve\(window\.VSwap\.mount\(slot\)\)\.then\(\(p\) => settleBuy\(p \? "panel" : "none"\), \(\) => settleBuy\("link"\)\)/);
});

test("no jump on a computer either: the Launchpad hero starts open and fills the first screen, the coin page holds its Buy's room", () => {
  const lp = read("scripts/pages/src/launchpad.html");
  assert.match(lp, /<section class="launch-hero is-open" id="launchpad">/, "opened on 10 Oct 2026: the page ships open");
  const js = read("public/launchpad.js");
  assert.match(js, /hero\.classList\.toggle\("is-open", ms === 0\); hero\.dataset\.clock = ms === 0 \? "open" : "soon";/, "the clock still decides");
  assert.match(CSS, /\.launch-hero:not\(\[data-clock="open"\]\) \.lp-live__open \{ visibility: hidden; \}/, "and it says 'open' only once the clock has");
  assert.match(CSS, /@media \(min-width: 900px\) \{ \.launch-hero \{ min-height: calc\(100vh - var\(--header-h, 67px\)\);/);
  assert.match(CSS, /\.coin-page\[aria-busy="true"\] \.coin-head__buy\[hidden\] \+ \.coin-head__safe \{ margin-top: 64px; \}/);
  assert.match(CSS, /\.coin-side > \.coin-ca \{ order: -1; \}/);
});

test("motion: the live strip moves only for those who want motion, stops on hover, focus and Pause, and is never read out as it moves", () => {
  // every animation in the stylesheet sits inside prefers-reduced-motion: no-preference
  let depth = 0, inMotion = -1;
  const lines = CSS.split("\n");
  for (const line of lines) {
    if (/@media \(prefers-reduced-motion: no-preference\)/.test(line)) inMotion = depth;
    if (/\banimation(?:-name)?:\s*(?!none)[a-z]/.test(line) && !/animation-play-state/.test(line)) assert.ok(inMotion >= 0, `an animation outside no-preference: ${line.trim()}`);
    for (const ch of line) { if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === inMotion) inMotion = -1; } }
  }
  assert.match(CSS, /\.lp-live\.is-marquee \.lp-live__view:hover \.lp-live__track, \.lp-live\.is-marquee \.lp-live__view:focus-within \.lp-live__track \{ animation-play-state: paused; \}/);
  assert.match(CSS, /:root\[data-motion="paused"\] \.lp-live__item\.is-copy \{ display: none; \}/, "Pause animations: one still row");
  const lp = read("scripts/pages/src/launchpad.html");
  const strip = lp.slice(lp.indexOf('<div class="lp-live" id="lp-live">'), lp.indexOf("</div>", lp.indexOf('id="lp-live-track"')));
  assert.doesNotMatch(strip, /aria-live/, "a moving strip is never a live region");
  assert.match(lp, /<button class="lp-live__pause" type="button" id="lp-live-pause" aria-pressed="false" aria-label="Pause animations">/);
  assert.match(CSS, /\.lp-live__pause \{[^}]*width: 44px; height: 44px;/);
  const js = read("public/launchpad.js");
  assert.match(js, /setAttribute\("aria-hidden", "true"\)/); assert.match(js, /\.inert = true/);
});

test("the honest lines that moved into folds are still on the page, word for word", () => {
  const lp = read("public/launchpad.html"), coin = read("public/coin.html"), token = read("public/token.html"), connect = read("public/connect.html");
  assert.ok(lp.includes("Powered by Jupiter") && lp.includes("Vicinity never touches your funds"), "the Launchpad's trust line, visible above its sources fold");
  assert.match(coin, /<p class="coin-foot coin-head__safe">You trade in your own wallet\. Vicinity never touches your funds\.<\/p>/, "under the coin page's one Buy");
  assert.ok(token.includes("Price: Jupiter (Powered by Jupiter)."), "the token facts name their sources");
  assert.match(connect, /<details class="fold su-keep"[^>]*>\s*<summary>What we keep and who sees it/, "the consent facts are one fold with its summary");
  const terms = read("public/terms.html");
  assert.match(terms, /Updated October 1, 2026 · Version 2026-10-01/);
  assert.ok((terms.match(/<details class="terms-sec"/g) || []).length >= 8, "the Terms read as folds");
});

test("icons, not emoji: the pages' sources carry no pictographic emoji", () => {
  for (const p of OWN) {
    const h = read(`scripts/pages/src/${p}.html`);
    const hit = h.match(/[\u{1F300}-\u{1FAFF}]/u);
    assert.equal(hit, null, `${p}.html: ${hit && hit[0]}`);
  }
  const cities = read("public/cities.js");
  assert.doesNotMatch(cities, /el\("span", "mod-row__icon", "[^"]+"\)/, "the moderator row's shield is drawn by the stylesheet");
  assert.match(read("public/polish-map.css"), /\.mod-row__icon \{ --ico-mask: url\("data:image\/svg\+xml,/);
});

test("404: one calm empty state with the pin, the line, Home and Cities, and the link checker kept", () => {
  for (const h of [read("public/404.html"), read("scripts/pages/src/404.html")]) {
    assert.match(h, /<div class="empty notfound__box">\s*<span class="ico notfound__ico" aria-hidden="true"><svg [^>]*><path d="M12 21s-6\.5-5\.6-6\.5-11a6\.5 6\.5 0 0 1 13 0c0 5\.4-6\.5 11-6\.5 11z"\/>/);
    assert.match(h, /<h1 class="notfound__title">This page isn't on the map\.<\/h1>/);
    assert.match(h, /<a class="btn btn--primary" href="\/">Home<\/a>\s*<a class="btn btn--glass" href="\/cities">Cities<\/a>/);
    assert.match(h, /Check it with the <a href="\/token#check">official link checker<\/a>\./);
  }
});

test("after the opening on a phone: a tighter hero (the first live coin in an iPhone's first screen with Safari's bars), $VICINITY in the Buy panel's own mark", () => {
  assert.match(CSS, /@media \(max-width: 600px\) \{\n  \.launch-hero\.is-open \{ padding-bottom: 20px; \}/);
  assert.match(CSS, /\.launch-hero\.is-open ~ \.lp-coins \{ padding-top: 20px; \}/);
  assert.match(CSS, /\.lp-ava\[data-kind="vicinity"\] \{ color: #fff; background: linear-gradient\(135deg, #FF5A36, #FFC857\); \}/);
  assert.match(read("public/launchpad.js"), /if \(c\.kind === "vicinity"\) disc\.dataset\.kind = "vicinity";/);
  assert.match(read("public/launchpad.js"), /if \(c\.kind === "vicinity"\) ava\.dataset\.kind = "vicinity";/);
  assert.match(read("public/coin.js"), /if \(c\.kind === "vicinity"\) disc\.dataset\.kind = "vicinity"; else delete disc\.dataset\.kind;/);
});
