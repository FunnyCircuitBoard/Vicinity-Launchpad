// Design v2, the pages work (10 Oct 2026): the token, Launchpad, coin, cities, rules, terms, connect/locate, profile and 404 pages
// each load their own late stylesheet (public/pages-<page>.css; they were one 41 KB polish-pages.css every one of them loaded whole,
// review PERF-1). What this pins: every one of those pages loads its sheet last, and nothing else; the Buy card holds
// its room while it loads (no jump); motion only for those who want it, with the live strip still for everyone else; the honest
// lines that moved into folds are still on the page; no emoji as icons in those pages' sources; the 404 is one calm empty state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
// each page and its own sheet
const SHEETS = { token: ["pages-token"], launchpad: ["pages-launchpad"], coin: ["pages-coin"], cities: ["pages-cities"], rules: ["pages-docs"],
  terms: ["pages-docs"], connect: ["pages-connect"], locate: ["pages-connect"], profile: ["pages-profile"], 404: ["pages-404"] };
const OWN = Object.keys(SHEETS);
const CSS = [...new Set(Object.values(SHEETS).flat())].map((s) => read(`public/${s}.css`)).join("\n");

test("every page of the pages work loads its own sheet(s) last, and no other page's", () => {
  assert.throws(() => read("public/polish-pages.css"), "the one shared sheet is gone");
  for (const p of OWN) {
    for (const h of [read(`public/${p}.html`), read(`scripts/pages/src/${p}.html`)]) {
      const settings = h.match(/<!--(\{.*\})-->/);
      const sheets = settings ? JSON.parse(settings[1]).styles : [...h.matchAll(/<link rel="stylesheet" href="\/([a-z0-9-]+)\.css">/g)].map((m) => m[1]);
      assert.deepEqual(sheets.filter((s) => s.startsWith("pages-")), SHEETS[p], `${p}: ${sheets.join(", ")}`);
      assert.deepEqual(sheets.slice(-SHEETS[p].length), SHEETS[p], `${p}: its sheets come last`);
    }
  }
  // a page sheet never reaches past its page: the 404, rules, terms, profile and locate pages load only a few KB of their own
  for (const s of ["pages-404", "pages-docs", "pages-profile", "pages-connect"]) assert.ok(read(`public/${s}.css`).length < 8000, `${s}.css stays small`);
  // the coin avatar (.lp-ava) is the Launchpad's: the coin page carries the same block rather than loading the whole Launchpad sheet
  const ava = (s) => { const m = read(`public/${s}.css`).match(/\n:where\(\.lp-ava\)[\s\S]*?\n\.lp-ava--sm span \{[^}]*\}/); assert.ok(m, s); return m[0]; };
  assert.equal(ava("pages-coin"), ava("pages-launchpad"), "one avatar recipe, the same in both sheets");
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

test("no jump: the Launchpad's coins hold their room with still placeholders until the first answer, the coin page holds its Buy's room", () => {
  // design v4 (12 Oct 2026): the hero is the tagline and one button, so the grid is in the first screen. The section ships visible with two
  // placeholder cards (no shimmer) that the first answer swaps for the toolbar and the grid (new boxes: nothing on screen moves), and both
  // hold at least the rest of the first screen, so the sources, the snapshot fold and the footer never show and then jump away
  const lp = read("scripts/pages/src/launchpad.html");
  assert.match(lp, /<section class="lp-coins is-loading" id="lp-coins" aria-labelledby="lp-coins-title">/, "visible from the start (no hidden attribute)");
  assert.match(lp, /<div class="lp-skels" aria-hidden="true"><div class="lp-grid"><div class="card lp-card lp-skel lp-skel--featured">/);
  assert.match(CSS, /\.lp-skels, #lp-panel \{ min-height: calc\(100vh - 240px\); \}/);
  assert.match(CSS, /@media \(min-width: 901px\) \{ \.lp-skels, #lp-panel \{ min-height: calc\(100vh - 300px\); \} \}/);
  assert.match(CSS, /\.lp-coins:not\(\.is-loading\) \.lp-skels,\n\.lp-coins\.is-loading :is\(\.lp-tools, \.lp-filters, \.lp-meta, #lp-panel\),/);
  assert.match(CSS, /\.lp-card > \.lp-spark\.is-empty, \.lp-card > \.lp-spark\.is-loading \{ display: flex; \}/, "a card's chart keeps its room while it loads, on a phone too");
  const js = read("public/launchpad.js");
  assert.match(js, /sec\.classList\.remove\("is-loading"\); sec\.classList\.toggle\("is-nodata", !data\);/, "the first answer (or failure) swaps them");
  assert.match(js, /if \(o && o\.launchpadV2 === true\) start\(\); else sec\.hidden = true;/, "hidden only when the switch is off");
  assert.match(CSS, /\.coin-page\[aria-busy="true"\] \.coin-head__buy\[hidden\] \+ \.coin-head__safe \{ margin-top: 64px; \}/);
  assert.match(CSS, /\.coin-side > \.coin-ca \{ order: -1; \}/);
});


test("motion: only for those who want it; the Launchpad has no live strip, no Pause button and nothing that loops", () => {
  // every animation in the stylesheet sits inside prefers-reduced-motion: no-preference
  let depth = 0, inMotion = -1;
  const lines = CSS.split("\n");
  for (const line of lines) {
    if (/@media \(prefers-reduced-motion: no-preference\)/.test(line)) inMotion = depth;
    if (/\banimation(?:-name)?:\s*(?!none)[a-z]/.test(line) && !/animation-play-state/.test(line)) assert.ok(inMotion >= 0, `an animation outside no-preference: ${line.trim()}`);
    for (const ch of line) { if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === inMotion) inMotion = -1; } }
  }
  // design v4 (12 Oct 2026, the owner: "the pause-animation button must go"): the hero's gliding strip and its Pause button are gone; nothing
  // on the page loops (WCAG 2.2.2 then has nothing to pause). The cards rise in once (transform and opacity, 320 ms) when a list is drawn
  const lp = read("scripts/pages/src/launchpad.html"), sheet = read("public/pages-launchpad.css"), js = read("public/launchpad.js");
  assert.doesNotMatch(lp, /lp-live|Pause animations|aria-pressed/);
  assert.doesNotMatch(sheet, /infinite|lpMarquee|data-motion|--lb-play/);
  assert.doesNotMatch(js, /lp-live|paintLive|vicinity:motion|data-motion-toggle|\.inert = true/);
  assert.match(sheet, /@keyframes lpCardIn \{ from \{ opacity: 0; transform: translateY\(8px\); \} \}/);
  assert.match(sheet, /\.lp-coins:not\(\.is-loading\) \.lp-grid > \.lp-card \{ animation: lpCardIn var\(--dur-3, \.32s\) var\(--ease-out, ease-out\) backwards; \}/);
});


test("the honest lines that moved into folds are still on the page, word for word", () => {
  const lp = read("public/launchpad.html"), coin = read("public/coin.html"), token = read("public/token.html"), connect = read("public/connect.html");
  assert.ok(lp.includes("Powered by Jupiter") && lp.includes("Vicinity never touches your funds"), "the Launchpad's trust line, visible above its sources fold");
  assert.match(coin, /<p class="coin-foot coin-head__safe">You trade in your own wallet\. Vicinity never touches your funds\.<\/p>/, "under the coin page's one Buy");
  // design v4: the trust line keeps the attribution and the non-custody fact, and drops the risk warning (the Terms carry it)
  assert.match(coin, /<p class="coin-trust">Powered by Jupiter · Vicinity never touches your funds<\/p>/);
  const sources = read("public/coin.js").match(/function paintSources\(d\) \{[\s\S]*?\n  \}/)[0];
  assert.match(sources, /parts\.push\(el\("span", null, "Price history in USD: read by vicinity\.city every 10 minutes"\)\);\n    p\.replaceChildren/, "the sources line ends with where the history comes from");
  assert.ok(token.includes("Price: Jupiter (Powered by Jupiter)."), "the token facts name their sources");
  assert.match(connect, /<details class="fold su-keep"[^>]*>\s*<summary>What we keep and who sees it/, "the consent facts are one fold with its summary");
  const terms = read("public/terms.html");
  assert.match(terms, /Updated October 1, 2026 · Version 2026-10-01/);
  assert.ok((terms.match(/<details class="terms-sec"/g) || []).length >= 8, "the Terms read as folds");
});

test("no risk warning in the page chrome, pop-ups or scripts (design v4, the owner's ask): only the Terms of Use say it", () => {
  const RISK = /financial advice|afford to lose|very risky|can go to zero/i;
  for (const f of readdirSync(new URL("../public/", import.meta.url)).filter((x) => /\.(html|js)$/.test(x))) {
    const h = read(`public/${f}`);
    // the Terms of Use are the owner's document (R4). His #63 took the short warning line out of their top; their own risk
    // clause (Section 13's "at your sole risk") is what carries it now, and it must stay
    if (f === "terms.html") { assert.match(h, /your use of the Services is at your sole risk\./, "the Terms keep their own risk clause (R4)"); continue; }
    assert.doesNotMatch(h, RISK, f);
  }
  // a transaction's own facts are not disclaimers: they stay where the money moves
  assert.match(read("public/swap.js"), /You sign in your own wallet; Vicinity never touches your funds\$\{feeBps \? ` and takes a \$\{\(feeBps \/ 100\)\.toString\(\)\}% platform fee` : " and takes no fee"\}/);
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

test("404: one calm empty state with the pin, the line, Home and Live map, and the link checker kept", () => {
  for (const h of [read("public/404.html"), read("scripts/pages/src/404.html")]) {
    assert.match(h, /<div class="empty notfound__box">\s*<span class="ico notfound__ico" aria-hidden="true"><svg [^>]*><path d="M12 21s-6\.5-5\.6-6\.5-11a6\.5 6\.5 0 0 1 13 0c0 5\.4-6\.5 11-6\.5 11z"\/>/);
    assert.match(h, /<h1 class="notfound__title">This page isn't on the map\.<\/h1>/);
    // the map has one name everywhere: "Live map" (the header, the 404, the page title); the phone tab bar's "Map" is its short form
    assert.match(h, /<a class="btn btn--primary" href="\/">Home<\/a>\s*<a class="btn btn--glass" href="\/cities">Live map<\/a>/);
    assert.match(h, /Check it with the <a href="\/token#check">official link checker<\/a>\./);
  }
});

test("on a phone: a short hero (the tagline on two lines and one button), so the first coin starts in the first screen; $VICINITY in the Buy panel's own mark", () => {
  assert.match(CSS, /\.lp4-hero \{ position: relative; isolation: isolate; padding: 28px 0 24px; text-align: center; \}/, "phone first");
  assert.match(CSS, /@media \(min-width: 601px\) \{ \.lp4-hero \{ padding: 48px 0 36px; \}/);
  assert.match(CSS, /\.lp4-hero__title > span \{ display: inline-block; \}/, "'Every city gets' / 'its own coin.': never a lone word");
  assert.match(CSS, /\.lp-ava\[data-kind="vicinity"\] \{ color: #fff; background: linear-gradient\(135deg, #FF5A36, #FFC857\); \}/);
  assert.match(read("public/launchpad.js"), /if \(c\.kind === "vicinity"\) disc\.dataset\.kind = "vicinity";/);
  assert.match(read("public/coin.js"), /if \(c\.kind === "vicinity"\) disc\.dataset\.kind = "vicinity"; else delete disc\.dataset\.kind;/);
});


test("a computer: the stuck Buy card scrolls inside itself while the wallet list (and its QR code) shows, so nothing of it is out of reach", () => {
  assert.match(CSS, /\.token-hero__buy:has\(\.swap__wallets:not\(\[hidden\]\)\) \{ max-height: calc\(100vh - var\(--sticky-top, 79px\) - 16px\); overflow-y: auto;/);
});

test("the account step's place chip: the place, then 'Not right? Check again' under it on a phone (the dot between them hidden, not read out)", () => {
  for (const h of [read("public/connect.html"), read("scripts/pages/src/connect.html")]) {
    assert.match(h, /<span id="su-recap-city">—<\/span><span class="su-recap__sep" aria-hidden="true"> · <\/span><button class="link-btn link-btn--tiny" type="button" id="su-recap-redo">Not right\? Check again<\/button>/);
  }
  assert.match(CSS, /@media \(max-width: 600px\) \{ #su-recap \.su-recap__sep \{ display: none; \}/);
});

test("cities: the map's scale bar clears whichever card holds the slot, and the feedback button steps aside from the map, its card and its controls", () => {
  // d3 (11 Oct 2026): the slot's height is one variable (134 px, 52 px folded) the card and the scale bar both read (the bar used a
  // fixed bottom: 154px); the bar goes on the world view (a "2,000 km" bar is wrong at most latitudes of a whole-world map)
  assert.match(CSS, /#city-stage \{ --slot-h: 134px; \}\n#city-stage\.is-folded \{ --slot-h: 52px; \}/);
  assert.match(CSS, /\.map-focus \{ height: var\(--slot-h, 134px\); \}\n\.map-scale \{ bottom: calc\(var\(--slot-h, 134px\) \+ 20px\); \}\n#city-stage\[data-crosshair="off"\] \.map-scale \{ display: none; \}/);
  assert.doesNotMatch(CSS, /\.map-scale \{ bottom: 154px; \}/);
  for (const h of [read("public/cities.html"), read("scripts/pages/src/cities.html")]) {
    assert.match(h, /<div class="map-ctrl" role="group" aria-label="Map controls" data-fb-avoid>/);
    assert.match(h, /<div class="map-focus is-loading" id="map-focus" role="group" aria-label="The city at the centre of the map" data-fb-avoid hidden>/, "the card waits for a city: the first view is the find card");
    assert.match(h, /<form class="map-find" id="map-find" role="search" aria-label="Find your city" data-fb-avoid>/);
    assert.match(h, /<div class="citymap__stage" id="city-stage" data-crosshair="off" data-world-fit="0" data-fb-avoid>/, "a phone: the feedback button never sits on the map (feedback.js AVOID honours data-fb-avoid)");
  }
});

test("cities: the map carries its data credit (R2) in a bottom corner, full screen too, clear of the controls, the slot and the scale bar", () => {
  for (const h of [read("public/cities.html"), read("scripts/pages/src/cities.html")]) {
    const stage = h.slice(h.indexOf('<div class="citymap__stage" id="city-stage"'), h.indexOf('<p class="citymap__legend">'));
    // inside the stage (it goes full screen with it), the last thing in it (the keyboard reaches it after the map's own controls)
    assert.match(stage, /<p class="map-attrib"><a href="https:\/\/www\.openstreetmap\.org\/copyright" target="_blank" rel="noopener" title="Map data © OpenStreetMap contributors">© OpenStreetMap<span class="sr-only"> contributors \(opens in a new tab\)<\/span><\/a><span aria-hidden="true">·<\/span><a href="\/credits" title="Data sources and licences">Data<span class="sr-only"> sources and licences<\/span><\/a><\/p>\n          <\/div>\n/);
  }
  const rule = (sel) => { const m = CSS.match(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`)); assert.ok(m, sel); return m[2]; };
  // over the canvases, under the slot (find 4, card 2), the controls (3) and their menu
  assert.match(rule(".map-attrib"), /position: absolute; z-index: 1; left: 8px; bottom: calc\(var\(--slot-h, 134px\) \+ 48px\);/, "a phone, a picked city: above the scale bar on the left (the controls run down the right)");
  assert.match(rule(".map-attrib"), /font: 500 var\(--fs-xs, \.75rem\)\/1 var\(--body\); white-space: nowrap;/, "the type floor, one line");
  assert.match(rule(".map-attrib"), /background: var\(--glass\); background: color-mix\(in srgb, var\(--bg\) 72%, transparent\); color: var\(--text-2\);/, "readable over any land, water or dot (measured 6.7:1 and more)");
  assert.match(CSS, /#city-stage\[data-crosshair="off"\] \.map-attrib \{ bottom: 74px; \}/, "a phone, the find view: just above the pill");
  assert.match(CSS, /@media \(pointer: coarse\) \{ \.map-attrib a::after \{ content: ""; position: absolute; inset: -12px -6px; \} \}/, "a 44 px tall hit area for a finger");
  assert.match(CSS, /@media \(min-width: 720px\) \{\n  \.map-attrib \{ left: auto; right: 8px; bottom: 8px; \}\n  #city-stage\[data-crosshair="off"\] \.map-attrib \{ bottom: 72px; \}\n\}/, "a computer: the bottom-right corner, above the find bar when the stage is narrow");
  assert.match(CSS, /@container \(min-width: 960px\) \{ #city-stage\[data-crosshair="off"\] \.map-attrib \{ bottom: 8px; \} \}/, "beside the centred find bar once there is room");
  // full screen covers the floating header and the tab bar (the hero's isolated layer would keep the stage under them)
  assert.match(CSS, /html\.map-is-full #cities\.page-hero \{ isolation: auto; \}/);
  // a tap on it is never taken as a drag of the map
  assert.match(read("public/cities.js"), /\.closest\("\.map-ctrl, \.map-focus, \.map-find, \.map-exit, \.map-hint, \.map-attrib"\)/);
});

test("/cities: the map's \"How to use the map\" fold is a finger's 44 px tall (integration QA: it was 40)", () => {
  assert.match(read("public/pages-cities.css"), /#cities \.citymap__howto > summary \{ min-height: 44px; /);
});
