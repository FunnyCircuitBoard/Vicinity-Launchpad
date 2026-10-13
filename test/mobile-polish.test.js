// The mobile-first polish of 9 Oct 2026 (the owner: "significantly reduce the vertical scrolling on the homepage... compact, visual,
// easy to navigate on phone screens... a design pass on the Token page... zero redundancy"). What it promises, pinned here:
// * every page loads public/polish.css after style.css, and polish.css publishes the height of the fixed bars at the bottom of a phone
//   (--bottom-bars on body: the tab bar, plus the coin page's Buy bar) for anything that floats in a corner;
// * the footer on every page (design v4): one calm line, the copyright, Terms / Privacy / Rules / Data / Check a link, the official social
//   accounts; no status, no Pause, no credits block (they live on /credits and at the map's corner), no risk line;
// * the home page (design v4, 12 Oct 2026, the owner's own words: no New York map, "One city. One coin." centred at the top, Sign up beside
//   Get $VICINITY): one call to buy, no countdown, no numbers band, How it works, the app teaser and the FAQ in three tabs, no closing band
//   (test/home-v4.test.js pins the page itself);
// * the token page: the Buy control in a marked slot (#buy-slot, where the in-app swap goes), the contract address printed once, five
//   proofs, no third /connect link, the FAQ's step 3 naming the Buy button rather than a venue;
// * the Launchpad draws $VICINITY once (not in "Live now" and again in the list) and hides the snapshot checker until there is a snapshot;
// * rules: a chip row to every rule and each rule a fold; terms: a contents fold; cities: one plain search placeholder.
// Heights (390 px: home 17,228 → under 4,400; token 6,150 → under 4,300) were measured in Chromium on the real Worker; this file pins the markup,
// the rules and the scripts. Nothing new moves by itself: polish.css keeps its one animation inside a prefers-reduced-motion: no-preference block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as officialMod from "../src/official.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const pages = readdirSync(new URL("../public/", import.meta.url)).filter((f) => f.endsWith(".html"));
const html = Object.fromEntries(pages.map((f) => [f, read("public/" + f)]));
const polish = read("public/polish.css"), style = read("public/style.css"), build = read("scripts/pages/build.mjs");
const home = html["index.html"], homeSrc = read("scripts/pages/src/index.html"), tokenPage = html["token.html"];
const count = (s, re) => (s.match(re) || []).length;

test("every page loads polish.css right after style.css; polish.css publishes the bottom bars and the 44 px header controls", () => {
  assert.ok(pages.length >= 13);
  for (const f of pages) assert.match(html[f], /<link rel="stylesheet" href="\/style\.css">\n  <link rel="stylesheet" href="\/polish\.css">/, f);
  assert.match(build, /<link rel="stylesheet" href="\/polish\.css">/);
  assert.match(polish, /^:root \{ --tabbar-h: 64px; --bottom-bars: 0px; \}$/m, "nothing fixed at the bottom on a computer (design v4: a 64 px tab bar)");
  assert.match(polish, /@media \(max-width: 900px\) \{\n  body \{ --bottom-bars: calc\(var\(--tabbar-h\) \+ env\(safe-area-inset-bottom\)\); padding-bottom: calc\(var\(--bottom-bars\) \+ 8px\); \}\n  body\.has-coin-buybar \{ --bottom-bars: calc\(var\(--tabbar-h\) \+ 64px \+ env\(safe-area-inset-bottom\)\); \}/,
    "the tab bar on a phone, and the coin page's Buy bar above it (style.css puts that bar at var(--tabbar-h))");
  assert.match(style, /\.coin-buybar \{ bottom: var\(--tabbar-h, 67px\);/, "the variable polish.css sets is the one the Buy bar reads");
  assert.match(polish, /\.tabbar \{ height: calc\(var\(--tabbar-h\) \+ env\(safe-area-inset-bottom\)\);/, "the bar is exactly that tall");
  assert.match(polish, /\.tabbar a \{ font-size: \.75rem;/, "12 px labels (11.2 before)");
  for (const rule of [/\.brand \{ min-height: 44px;/, /\.theme-toggle \{ width: 44px; height: 44px; \}/, /\.account-btn\.btn--sm \{ min-height: 44px; \}/, /\.btn--sm \{ min-height: 44px; \}/, /\.faq summary \{ min-height: 44px;/, /\.site-footer__links a, \.social-link \{ min-height: 44px; \}/, /\.site-footer__theme \{ width: 44px; height: 44px; \}/]) assert.match(polish, rule);
  // under a mouse the floating header's controls are 40 px (a finger keeps 44 everywhere)
  assert.match(polish, /@media \(hover: hover\) and \(pointer: fine\) \{ \.site-header \.btn--sm \{ min-height: 40px; \} \.site-header \.theme-toggle \{ width: 40px; height: 40px; \} \}/);
});

test("polish.css moves nothing by itself: its one animation sits in a no-preference block and uses transform and opacity only", () => {
  const body = polish.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [...body.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
  assert.equal(blocks.length, 1);
  const outside = body.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "").replace(/@keyframes [\s\S]*?\}\s*\}/g, "");
  assert.doesNotMatch(outside, /animation\s*:|transition\s*:/, "no animation or transition outside the block");
  for (const kf of body.matchAll(/@keyframes \w+ \{([\s\S]*?)\} \}/g)) for (const prop of kf[1].matchAll(/([a-z-]+):/g)) assert.ok(["transform", "opacity"].includes(prop[1]), prop[1]);
});

test("footer, every page (design v4): the copyright line, Terms / Rules / Data / Check a link, the official socials, one security line; no status, Pause, credits block or risk line", () => {
  const { SOCIAL_PROFILES } = officialMod;
  for (const f of pages) {
    const foot = html[f].match(/<footer class="site-footer">[\s\S]*?<\/footer>/)[0];
    assert.doesNotMatch(foot, /href="\/#faq"|href="\/connect"/, `${f}: FAQ and Sign up are the header's and the tab bar's`);
    assert.doesNotMatch(foot, /One city\. One coin\. One community\./, `${f}: the tagline is the home page's headline`);
    assert.match(foot, /<p class="site-footer__copy"><img src="\/logo\.svg" alt="" width="20" height="20"> Vicinity\.city © 2026\. All rights reserved\.<\/p>/, f);
    const links = [...foot.match(/<nav class="site-footer__links" aria-label="Legal and data">([\s\S]*?)<\/nav>/)[1].matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => `${m[2]} ${m[1]}`);
    // review of 13 Oct 2026: no "Privacy" link (it opened the Rules' location card: the site has no privacy notice of that name yet)
    assert.deepEqual(links, ["Terms /terms", "Rules /rules", "Data /credits", "Check a link /token#check"], f);
    // the one line kept: a security fact against phishing (not a risk warning), once per page
    assert.equal(foot.match(/<p class="site-footer__safe">Vicinity never asks for your recovery phrase or private key\.<\/p>/g).length, 1, f);
    // the official accounts, from src/official.js (rule R3: real ones only; a network added there shows on the next build)
    const social = foot.match(/<ul class="site-footer__social" aria-label="Vicinity on social media" data-fb-avoid>([\s\S]*?)<\/ul>/);
    assert.ok(social, `${f}: the social list, kept clear of the feedback button`);
    const hrefs = [...social[1].matchAll(/<a class="social-link" href="([^"]+)" target="_blank" rel="noopener me" aria-label="Vicinity on ([^"]+), opens in a new tab">/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(hrefs.map((x) => x[0]), SOCIAL_PROFILES.map((p) => p.url || `https://${p.hosts[0]}/${p.handle.replace(/^@/, "")}`), `${f}: one icon per official account`);
    for (const [href, label] of hrefs) { assert.match(href, /^https:\/\//); assert.match(label, /^\w+ \(@\w+\)$/); }
    assert.doesNotMatch(foot, /href="#"|\sstyle="/, `${f}: no dead link, no inline style`);
    assert.match(foot, /<button class="theme-toggle site-footer__theme" type="button" data-theme-toggle aria-label="Switch to light mode" aria-pressed="false">/, `${f}: the phone's theme switch`);
    // gone from the footer: the status line, Pause, the Explore / Stay safe columns, the credits fold, the risk line
    assert.doesNotMatch(foot, /System status|id="status"|Pause animations|footer-data|Data credits|footer-legal|financial advice|afford to lose|very risky|Stay safe/, f);
  }
  assert.match(html["index.html"], /href="https:\/\/x\.com\/VicinityCitySOL"/, "today: X, @VicinityCitySOL");
  // the credits are never lost (licences R2): /credits keeps every one, linked as "Data" from every footer
  const credits = html["credits.html"];
  for (const host of ["https://www.geonames.org/", "https://www.openstreetmap.org/copyright"]) assert.ok(credits.includes(`href="${host}"`), host);
  assert.match(credits, /Natural Earth/);
  assert.match(style, /\.site-footer__theme \{ display: none; \}/); assert.match(style, /@media \(max-width: 480px\) \{ \.site-footer__theme \{ display: grid; \} \}/, "the footer's theme switch only on a phone (the header's leaves it there)");
});

test("home (design v4): one call to buy, no countdown, no numbers band, no closing band; hero, How it works, the app teaser, the FAQ", () => {
  for (const h of [home, homeSrc]) {
    assert.equal(count(h, /href="\/token#buy-slot"/g), 1, "the one call to buy");
    assert.equal(count(h, /data-countdown-short|data-countdown-label/g), 0, "no countdown fact (site.js keeps the code for other pages)");
    assert.equal(count(h, /October 10/g), 1, "October 10 once: the FAQ's launch answer");
    assert.doesNotMatch(h, /class="numbers"|cta-band|hero__facts|data-stat=/, "no numbers band, no closing band, no fact tiles: the live numbers bar says it (home.js)");
    assert.doesNotMatch(h, /data-stat="members"|\bLive\b<|Launchpad is open/, "no members placeholder, nothing that reads like trading");
    const order = ['<section class="hero4" id="hero">', 'id="how"', 'id="app-teaser"', 'id="faq"'].map((x) => h.indexOf(x));
    assert.ok(order.every((i) => i >= 0));
    assert.deepEqual(order, [...order].sort((x, y) => x - y), "hero, How it works, the app teaser, the FAQ");
    assert.equal(count(h, /Open the live map/g), 1, "one map link: How it works' first card");
    assert.equal(count(h, /Raydium/g), 6, "Raydium only where it is a fact: the launch story in two FAQ answers (it was 19, then 7)");
    assert.doesNotMatch(h.slice(h.indexOf('<section class="hero4"')), /[\u{1F300}-\u{1FAFF}\u2699\u26A1]/u, "no emoji as icons in the page: the shared SVG set in .ico");
    // the measured claims about accounts stay measured where the page still speaks of sign-in (the FAQ): never "one person", never "keeps out"
    assert.doesNotMatch(h, /per Google login|keeps fake accounts and spam out|= one person|proves? (you are )?one person/i);
  }
});

test("home (design v4): the FAQ is one tabbed block; every panel reachable, every question but the risk one kept, a link into a hidden panel opens it", () => {
  const lists = [...home.matchAll(/<div class="seg seg--tabs" role="tablist" aria-label="([^"]+)" id="([^"]+)">([\s\S]*?)<\/div>/g)];
  assert.deepEqual(lists.map((m) => m[2]), ["faq-tabs"], "the incentives block left with the rest of the old page");
  for (const [, , id, inner] of lists) {
    const tabs = [...inner.matchAll(/<button type="button" role="tab" id="([^"]+)" aria-selected="(true|false)" aria-controls="([^"]+)"( tabindex="-1")?>/g)];
    assert.equal(tabs.length, 3, id);
    assert.deepEqual(tabs.map((t) => t[2]), ["true", "false", "false"], `${id}: the first tab is chosen`);
    assert.deepEqual(tabs.map((t) => Boolean(t[4])), [false, true, true], `${id}: the chosen tab is the only Tab stop`);
    tabs.forEach((t, i) => {
      const panel = home.match(new RegExp(`<div class="tabpanel[^"]*" id="${t[3]}" role="tabpanel" aria-labelledby="${t[1]}"( hidden)?>`));
      assert.ok(panel, `${id}: panel ${t[3]}`);
      assert.equal(Boolean(panel[1]), i > 0, `${id}: only the panels behind the other tabs start hidden`);
    });
  }
  for (const id of ["faq-basics", "faq-founders", "faq-safety"]) assert.equal(count(home, new RegExp(`id="${id}"`, "g")), 1, id);
  const faq = home.slice(home.indexOf('<section id="faq"'));
  const questions = [...faq.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.equal(questions.length, 14, "every question of 8 Oct 2026 but one");
  assert.ok(!questions.includes("Is this financial advice?"), "the owner: remove the risk warnings (the Terms carry it)");
  const js = read("public/home.js");
  assert.match(js, /\$\$\('\[role="tablist"\]'\)\.map\(\(list\) => \{/);
  assert.match(js, /e\.key === "ArrowRight" \? i \+ 1 : e\.key === "ArrowLeft" \? i - 1 : e\.key === "Home" \? 0 : e\.key === "End" \? tabs\.length - 1 : null/, "arrow keys move between tabs");
  assert.match(js, /t\.setAttribute\("aria-selected", String\(on\)\); t\.tabIndex = on \? 0 : -1;/);
  assert.match(js, /function openFor\(hash\)/); assert.match(js, /window\.addEventListener\("hashchange", \(\) => \{ if \(!oldLink\(\)\) openFor\(location\.hash\); \}\);/, "/#why-launchlab opens its tab, then lands");
  assert.match(js, /if \(target\.tagName === "DETAILS"\) target\.open = true;/);
});

test("style.css lost only the rules the old home page used: the numbers band, the bento, why-now, the buy steps, the roles grid, the closing band", () => {
  assert.doesNotMatch(style, /\.numbers__row|\.bento\b[^,]|\.why-now\b[^,]|\.buy-steps\b[^,]|\.roles-grid\b[^,]|\.cta-band|\.hero__cta--end/);
  assert.match(style, /\.role__icon \{ font-size: 1\.7rem;/, "the role icon stays (the dashboard's role panel and the home tabs)");
  assert.match(style, /\.scam-note \{/, "the scam note stays (the token page's FAQ)");
});

test("token: the Buy control in its slot, the address once, five proofs, no third /connect link, the official list points at the card", () => {
  for (const h of [tokenPage, read("scripts/pages/src/token.html")]) {
    // design v2 (10 Oct 2026): the slot is the page's Buy card, out of the contract card (owner item 3; test/token-ui.test.js pins the hero)
    assert.match(h, /<div class="token-hero__buy">\s*<div class="contract__slot buy-slot is-pending" id="buy-slot"><a class="contract__buy" id="lnk-raydium"/, "the slot is the Buy card, above the contract card");
    assert.equal(count(h, /id="buy-slot"/g), 1);
    assert.equal(count(h, /<div class="proof card">/g), 5, "Minting disabled, No freeze button, Liquidity can't be pulled, Team wallets public, No presale");
    assert.doesNotMatch(h, /supply-text|supply2|<h3>Fixed supply<\/h3>/, "the Supply fact above and the Minting proof already say the supply is fixed");
    const main = h.includes('<main id="main"') ? h.slice(h.indexOf('<main id="main"'), h.indexOf("</main>")) : h; // the page itself, not the header's Sign up (design v4)
    assert.equal(count(main, /href="\/connect"/g), 1, "one link to /connect in the page, in the FAQ's step 4 (the holders footnote was the third)");
    assert.doesNotMatch(h, /If a token isn't on this list, it isn't Vicinity/, "the card's note says it once");
    assert.match(h, /<details><summary>Is this the only official \$VICINITY\?<\/summary><p>Yes: the contract address at the top of this page, and only that one\. The <a href="#check">checker<\/a> tells you whether any link, address or @handle is ours\.<\/p><\/details>/);
  }
  assert.match(polish, /\.contract__slot \{ grid-column: 1 \/ -1; display: grid; min-width: 0; \}/, "the slot spans the card on a phone, like the button did");
  assert.match(polish, /@media \(min-width: 640px\) \{ \.contract__slot \{ grid-column: auto; \} \}/);
  // design v2 (10 Oct 2026): the Buy card left the contract card (its own column on a computer), so the wide-card slot rule is gone
  assert.doesNotMatch(polish, /\.contract:has\(> \.contract__links:not\(\[hidden\]\)\) \.contract__slot/);
  const js = read("public/token.js");
  assert.match(js, /if \(isAddr\(t\.contract\)\) \{ const a = el\("a", "registry__above", "Shown above ↑"\); a\.href = "#contract"; a\.title = t\.contract; ca\.append\(a\); \}/,
    "the official list prints no second copy of the address");
  // the city coins (one contract per city, each on the Launchpad once it launches) point at the Launchpad's live list; anything else
  // without a contract shows a dash (review of 13 Oct 2026: "Phase 3" read as if no city coin could exist yet)
  assert.match(js, /else if \(t\.platform === "Vicinity Launchpad"\) \{ const a = el\("a", "registry__above", "On the Launchpad →"\); a\.href = "\/launchpad"; ca\.append\(a\); \}\n\s+else ca\.textContent = "—";/);
  assert.doesNotMatch(read("src/official.js"), /status: "Phase 3"/);
  assert.match(js, /const supplyText = \$\("#supply-text"\); if \(supplyText\) supplyText\.textContent = fmt\(f\.supply\);/);
  assert.match(polish, /\.holders__table a \{ display: inline-block; padding: 12px 0; margin: -12px 0; \}/, "a 44 px hit area on every wallet in the list");
});

test("launchpad: $VICINITY drawn once and counted as drawn, the snapshot checker hidden until there is a snapshot, no date or calendar left", () => {
  const js = read("public/launchpad.js"), h = html["launchpad.html"];
  // design v4 (12 Oct 2026): one grid, $VICINITY its first card (it was a "Live now" card above the list, and before 9 Oct also the
  // list's first card: drawn twice). A tab's count is the cards that tab draws, with the search and the filters ("Live 6" over "5 coins")
  assert.match(js, /const now = Date\.now\(\), cards = data \? \[data\.vicinity, \.\.\.\(data\.coins \|\| \[\]\)\]\.filter\(Boolean\) : \[\];/);
  assert.match(js, /const n = Object\.fromEntries\(TABS\.map\(\(t\) => \[t, rowsFor\(cards, \{ \.\.\.opts, tab: t \}\)\.length\]\)\);/, "each tab counts what it draws");
  assert.match(js, /const rows = rowsFor\(cards, opts\);/, "and the list is drawn from the same cards");
  assert.match(js, /place\(grid, rows, now\);/); assert.equal((js.match(/\bplace\(/g) || []).length, 2, "one grid, placed in one place (and defined once)");
  assert.doesNotMatch(js, /counts\(cards, now\)|lp-featured/);
  assert.doesNotMatch(h, /id="lp-featured"/);
  assert.match(js, /const form = \$\("#snap-form"\); if \(form\) form\.hidden = !snap;/);
  assert.doesNotMatch(h, /id="lp-date"|id="lp-local"|id="lp-cal"|Add to my calendar/, "the opening is past: no date line, no calendar file");
  assert.equal(count(h.slice(h.indexOf("<main")), /October 10/g), 0);
  assert.match(polish, /\.lp-stats--live \.lp-stat__src\.is-why \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/, "a number nobody has yet keeps its tile: its reason on one line, so the four tiles stay two by two");
  assert.doesNotMatch(polish, /\.lp-stat:has\(> \.lp-stat__src\.is-why\) \{ display: none/, "hiding the tile left a blank cell in every card");
  assert.match(polish, /\.lp-tabs \{ flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; \}\n  \.lp-tabs::-webkit-scrollbar \{ display: none; \}\n  \.lp-tabs button \{ flex: 1 1 auto; padding: 0 6px; gap: 4px; font-size: \.8rem; \}\n  \.lp-tabs__n \{ min-width: 0; padding: 1px 6px; \}/, "Live · New · Upcoming · Trending on one row at 390 (Trending sat alone on a second)");
  assert.doesNotMatch(h, /coin-stack|Sample tickers/, "the sample tickers left with the 'Why a city launchpad' section");
});


test("review fixes of 9 Oct 2026: the strips keep their gutter, no mid-word break in the outside links, one button shape, the Buy card keeps its button, light-theme contrast, the terms numbers", () => {
  // A-1 (superseded by design v2, 10 Oct 2026): the facts and the roadmap no longer scroll sideways on a phone (the owner's screenshots:
  // "3 verified mem..." and "Accounts and dashbo..." cut at the screen's edge); test "home on a phone" pins what replaced them
  assert.doesNotMatch(polish, /\.(hero__facts|timeline) \{[^}]*overflow-x: auto/);
  // A-3: at 320 px "Jupiter" and "Solscan" broke mid-word inside 79 px links
  // design v2 (10 Oct 2026): the three links are pills (pages-token.css, pages-coin.css), each label kept whole on one line
  const pagesCss = read("public/pages-token.css") + read("public/pages-coin.css");
  assert.match(pagesCss, /\.token-hero \.contract__ext span \{ overflow-wrap: normal; white-space: nowrap; \}/, "the token page's three links");
  assert.match(pagesCss, /\.coin-ca__links \.contract__ext span \{ white-space: nowrap; overflow-wrap: normal; \}/, "the coin page's three links");
  assert.match(polish, /@media \(max-width: 360px\) \{ \.contract__ext \{ gap: 4px; padding: 0 4px; \} \.contract__ext svg \{ display: none; \} \}/);
  // A-7: Check rank (44 px, 10 px corners) and Check (48 px, pill) had the same job and two shapes
  assert.match(polish, /\.checker \.btn, \.snap-lookup \.btn \{ min-height: 44px; font-size: \.9rem; \}\n\.find-box \.find-box__go \{ border-radius: 999px; \}/);
  // A-8: one h2 size on a phone
  assert.match(polish, /  h2, \.h2--sm \{ font-size: var\(--fs-xl\); max-width: none; \}/, "design v2: the h2 token (22.4 px at 320, 23.8 at 390)");
  assert.match(style, /--fs-xl: clamp\(1\.5rem, 1\.15rem \+ 1\.6vw, 2\.25rem\);/, "design v4: 24 px on a phone, 36 on a computer");
  assert.doesNotMatch(polish, /#nyc \.section-head h2 \{ font-size/);
  // F2: on a phone the Buy & sell card lost its Buy button while coin.js keeps the bar off for exactly that scroll range
  assert.doesNotMatch(polish, /\.coin-buy \.contract__buy \{ display: none/);
  assert.match(read("public/coin.js"), /const b = headBuyOut && Boolean\(data\)/, "design v2: the Buy card is gone (one Buy in the hero); the bar brings it back once the hero's has scrolled away");
  // F4: the light theme's old --pin-2 (#D4501F) was 4.2:1 on white and --pin (#E8431F) 3.7:1. Design v2 (10 Oct 2026) darkened the light
  // accent text token itself, so the three small orange texts (and every kicker and link) read at 4.5:1 or more with no override of their own
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const lightBlock = style.slice(style.indexOf(':root[data-theme="light"] {'));
  const light = /--pin-2: (#[0-9A-Fa-f]{6})/.exec(lightBlock);
  assert.ok(light, "the light theme sets its own accent text colour");
  for (const bg of ["#FFFFFF", "#F4F6FA", "#EEF2F7"]) assert.ok(ratio(light[1], bg) >= 4.5, `${light[1]} on ${bg}: ${ratio(light[1], bg).toFixed(2)}:1`);
  assert.match(polish, /\.member-cloud__more \{[^}]*color: var\(--pin-2\);/, "the +N more chip: the accent text token");
  assert.match(style, /\.problem__num \{[^}]*color: var\(--pin-2\);/, "the problem numbers: accent text, not the accent fill (3.7:1 in light)");
  assert.doesNotMatch(polish, /#B8430F/, "no hard-coded override left: the token covers the three");
  // A-6: an inline-block link's baseline is its last line, so a wrapped entry's number sat on its second line
  assert.match(polish, /\.terms-toc a \{ display: block; padding: 11px 0;/, "each contents entry a 44 px row");
  // nits: the dead footer rule; the safety links one-then-two; every place shown on a computer; the token page's placeholder and skip link; the official list's wording
  assert.doesNotMatch(polish, /\.footer-brand > p\.muted:not\(\.small\)/, "build.mjs no longer emits the tagline paragraph");
  assert.doesNotMatch(polish, /\.footer-links|\.footer-grid|\.footer-meta|\.footer-data/, "design v4: the old footer's columns and folds went with them");
  // d3 (11 Oct 2026): "Inside $NYC" shows the five boroughs and "+41 more" on a computer too (all 46 made the column twice the map's height)
  assert.doesNotMatch(polish, /\.member-cloud li\.is-more \{ display: inline-flex; \} \.member-cloud li:has\(> \.member-cloud__more\) \{ display: none; \}/);
  assert.match(polish, /@media \(min-width: 901px\) \{ \.proof-grid \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\); \} \.proof \{ grid-column: span 2; \} \.proof:nth-child\(4\), \.proof:nth-child\(5\) \{ grid-column: span 3; \} \}/, "five proofs: three, then two, both rows full");
  for (const h of [tokenPage, read("scripts/pages/src/token.html")]) {
    assert.match(h, /<input id="check-input" name="q" type="text" autocomplete="off" spellcheck="false" maxlength="300" placeholder="Link or address">/, "a placeholder that never clips, even on a 320 px phone (the line above it says what to paste, @handles too)");
    assert.match(h, /<a class="holders__skip" href="#proof">Skip the holder list<\/a>\n\s*<div class="table-scroll" id="holders-scroll"/, "a keyboard skips the 300 wallet links");
    assert.match(h, /<section class="section section--tight" id="proof" tabindex="-1">/);
  }
  assert.match(polish, /\.holders__skip \{ position: absolute; left: -999px; \}\n\.holders__skip:focus \{ position: static;/);
  assert.match(read("public/token.js"), /t\.symbol\.startsWith\("e\.g\."\) \? `\$\{t\.name\}, \$\{t\.symbol\}` : `\$\{t\.name\} \(\$\$\{t\.symbol\}\)`/, "'City coins (one per city), e.g. $UTICA': not two brackets in a row");
  // design v4: the New York walkthrough (its label layout and its "Explore every city" button) left the home page with the map
});

test("cities, rules, terms: a plain search placeholder; a chip row and folds on the rules; a contents fold on the terms", () => {
  // d3 (11 Oct 2026): one search on /cities, the map's "Find your city" (the list's own field is gone), with a plain placeholder; the
  // application status is a pill ("Founder applications open"), not the word "Open" set as a number beside "claims"
  assert.match(html["cities.html"], /<input id="map-find-q" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="map-find-list" aria-describedby="map-find-hint" autocomplete="off" spellcheck="false" maxlength="60" enterkeyhint="go" placeholder="Search a city or town">/);
  assert.doesNotMatch(html["cities.html"], /id="city-q"|city-stats__claims|<span>claims<\/span>/);
  assert.match(html["cities.html"], /<p class="city-status" id="cs-status" hidden>.*Founder applications open<\/p>/);
  assert.match(read("public/cities.js"), /\$\("#cs-status"\)\.hidden = !open;/, "shown while founder applications are open (/api/seats launched)");
  const rules = html["rules.html"];
  const toc = rules.match(/<nav class="rules-toc" aria-label="Rules">([\s\S]*?)<\/nav>/)[1];
  const anchors = [...toc.matchAll(/href="#([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(anchors, ["founders", "ladder", "steward", "squads", "managers", "moderation", "supporters", "privacy", "never"]);
  for (const id of anchors) assert.match(rules, new RegExp(`<details class="card" id="${id}">\\s*<summary><span class="kicker">[^<]+</span><h3>[^<]+</h3></summary>\\s*<div class="rule-body">`), id);
  assert.equal(count(rules, /<article class="card"/g), 0);
  const rjs = read("public/rules.js");
  assert.match(rjs, /if \(window\.matchMedia && window\.matchMedia\("\(min-width: 800px\)"\)\.matches\) folds\.forEach\(\(d\) => \(d\.open = true\)\);/, "open on a computer, closed on a phone");
  assert.match(rjs, /openTarget\(\); window\.addEventListener\("hashchange", openTarget\);/, "/rules#founders opens its fold");
  const terms = html["terms.html"];
  const links = [...terms.match(/<details class="terms-toc">[\s\S]*?<\/details>/)[0].matchAll(/href="#s(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(links, Array.from({ length: 19 }, (_, i) => i + 1));
  for (const n of links) assert.match(terms, new RegExp(`<h2 id="s${n}">${n}\\. `), `section ${n} has its id`);
  assert.match(terms, /<summary>Contents \(19 sections\)<\/summary>/);
});

test("design v2 tokens: the contract the other sheets read (names fixed), with their phone steps and light values; the shared components", () => {
  const names = ["--fs-xs", "--fs-sm", "--fs-base", "--fs-md", "--fs-lg", "--fs-xl", "--fs-2xl", "--fs-num", "--fs-kicker", "--ls-kicker", "--lh-tight", "--lh-snug", "--lh-body",
    "--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6", "--sp-7", "--sp-8", "--gutter", "--card-pad", "--section-y",
    "--r-xs", "--r-chip", "--r-card", "--r-hero", "--r-pill", "--surface-1", "--surface-2", "--surface-inset", "--accent-soft", "--ok-soft", "--warn-soft", "--gold-soft",
    "--shadow-1", "--shadow-2", "--header-h", "--sticky-top", "--dur-1", "--dur-2", "--dur-3", "--ease-out"];
  const root = style.slice(0, style.indexOf("/* ---------- base ---------- */"));
  for (const n of names) assert.match(root, new RegExp(`${n}: [^;]+;`), n);
  assert.match(root, /--fs-xs: \.75rem;/, "12 px is the floor");
  // design v4: --header-h is the floating header's bottom edge: 8 + 52 px on a phone, 12 + 56 px from 901 px
  assert.match(root, /--header-h: 60px; --sticky-top: calc\(var\(--header-h\) \+ 12px\);/);
  assert.match(root, /@media \(min-width: 481px\) \{ :root \{ --gutter: 24px; \} \}\n@media \(min-width: 601px\) \{ :root \{ --card-pad: 24px; --section-y: 72px; \} \}\n@media \(min-width: 901px\) \{ :root \{ --section-y: 96px; --header-h: 68px; \} \}\n@media \(min-width: 1280px\) \{ :root \{ --gutter: 32px; \} \}/);
  for (const n of ["--e1", "--e2", "--e3", "--glass-bg", "--glass-bg-strong", "--glass-border", "--glass-blur", "--grad-ink", "--grad-accent", "--grad-glow", "--grad-ring", "--glow-cta", "--glow-cta-hover", "--field-line", "--r-lg", "--fs-display", "--dur-4", "--ease-in-out", "--ease-spring", "--chart-1", "--chart-2"]) assert.match(root, new RegExp(`${n}: [^;]+;`), n);
  for (const sel of [".ico {", ".ico--sm {", ".ico--ok {", ".ico--gold {", ".ico--muted {", ".fold > summary {", ".fold > summary::after {", ".fold__meta {", ".empty {", ".skel {", ".tnum {"]) assert.ok(style.includes(sel), sel);
  // the placeholder is still: nothing gives .skel a shimmer, and the coin page's inline ticker placeholder is its own rule
  assert.doesNotMatch(style, /[,{]\s*\.skel\s*\{[^}]*animation/);
  assert.doesNotMatch(style, /\.skel \{ animation|, \.skel \{ animation/);
  assert.match(style, /\.coin-head__ticker > \.skel \{ display: inline-block; min-height: 1em; \}/);
  // tokens and components sit before the profiles block (nothing after it may move) and outside the dashboard v2 block
  assert.ok(style.indexOf("Design v2: the shared components") < style.indexOf("Member profiles (PROFILES=on)"));
});

test("the guard against anything wider than a phone: buttons, media, code and grids fit their column; html never scrolls on its own", () => {
  assert.match(style, /\.btn \{[^}]*max-width: 100%;/, "no button is wider than its column");
  assert.match(style, /\.btn--lg, \.btn--block, \.btn--social \{ white-space: normal; text-wrap: balance; text-align: center; line-height: 1\.25; padding-block: 8px; \}/, "a long label wraps, centred");
  assert.match(style, /main :where\(img, svg, video, canvas, iframe, table, pre\) \{ max-width: 100%; \}/);
  assert.match(style, /p code \{ overflow-wrap: anywhere; \}/);
  // d3 (11 Oct 2026): the root clips too, so iOS Safari and full-page screenshot tools never see a page wider than the screen (the
  // owner's desktop captures showed the layout left-aligned beside an empty band). The pair is deliberate: body clips with "clip",
  // never "hidden" — html clip + body hidden makes body the scroll container and the sticky header stopped sticking (measured:
  // -1500 px after scrolling 1500); with body clip it stays at 0. "hidden" stays first as the fallback for browsers without clip.
  assert.match(style, /\nhtml \{[^}]*overflow-x: clip; \}/, "html clips sideways");
  assert.match(style, /\nbody \{[^}]*overflow-x: hidden; overflow-x: clip; \}/, "body clips (hidden only as the fallback)");
  assert.doesNotMatch(style + polish, /(^|[}\s])html \{[^}]*overflow(-x)?: (hidden|auto|scroll)/, "never hidden/auto/scroll on html");
  assert.doesNotMatch(style + polish, /(^|[}\s])body \{[^}]*overflow-x: hidden; \}/, "never body hidden alone (with html clip, sticky would break)");
  // every grid that applies on a phone uses minmax(0, ...) tracks (a bare 1fr track grows to its longest word or input), outside the
  // Launchpad / coin and dashboard v2 blocks that their own tests pin
  const shared = style.slice(0, style.indexOf("/* ---------- Launchpad city coins (LAUNCHPAD_V2=on)")) + polish;
  const bare = [...shared.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/grid-template-columns:\s*([^;}]+)/g)].map((m) => m[1]).filter((v) => /(^|[\s(,])\d*\.?\d+fr\b/.test(v.replace(/minmax\([^()]*(\([^()]*\))?[^()]*\)/g, "")));
  assert.deepEqual(bare, [], "no bare fr track left");
});

test("the Launchpad's opening still flips a countdown fact on a page that has one; the home page has none since d3, and no roadmap since design v4", () => {
  // after 10:10:10 New York time: site.js flips a countdown fact to "Live / Launchpad is open" on any page that has one (the home page has
  // none since d3); design v4 removed the home page's roadmap (its "Open now" Launchpad stop) and its fact tiles with the rest of the old page
  const site = read("public/site.js"), homeJs = read("public/home.js");
  assert.doesNotMatch(site, /Open now|until the Launchpad opens/);
  assert.match(site, /if \(e\.textContent !== "Live"\) e\.textContent = "Live";/);
  assert.match(site, /label\.textContent = "Launchpad is open";/);
  assert.match(site, /if \(fact\) fact\.classList\.add\("is-live"\);/);
  assert.match(site, /document\.dispatchEvent\(new CustomEvent\("vicinity:launchpad-open"\)\);/, "a page left open across the opening flips too");
  assert.doesNotMatch(homeJs, /timeline|launchpadLive|status\.textContent = "Live now"/, "no roadmap on the home page");
  for (const h of [home, homeSrc]) assert.doesNotMatch(h, /id="timeline"|class="timeline/);
  assert.doesNotMatch(polish, /margin: 0 -16px/, "no negative side margins: nothing reaches past the gutter");
});

test("design v2 rhythm: sections, cards, kickers and page titles use the tokens (one place to tune them)", () => {
  assert.match(style, /\.section \{ padding: var\(--section-y\) 0; position: relative; \}/);
  assert.match(style, /\.card \{[^}]*border-radius: var\(--r-card\); padding: var\(--card-pad\); box-shadow: var\(--shadow-1\); \}/);
  assert.match(style, /\.kicker \{[^}]*font-size: var\(--fs-kicker\);[^}]*letter-spacing: var\(--ls-kicker\);/);
  assert.match(style, /\.page-title \{ font-size: var\(--fs-2xl\);/);
  assert.doesNotMatch(polish, /(^|[\s}])(\.section|\.card|\.kicker) \{ (padding|font-size)/m, "the old values went with the tokens");
});
