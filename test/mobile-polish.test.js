// The mobile-first polish of 9 Oct 2026 (the owner: "significantly reduce the vertical scrolling on the homepage... compact, visual,
// easy to navigate on phone screens... a design pass on the Token page... zero redundancy"). What it promises, pinned here:
// * every page loads public/polish.css after style.css, and polish.css publishes the height of the fixed bars at the bottom of a phone
//   (--bottom-bars on body: the tab bar, plus the coin page's Buy bar) for anything that floats in a corner;
// * the footer on every page: no link that the tab bar or the header already has (FAQ, Connect a wallet), status and "Pause animations"
//   on one line, the data credits in a closed fold, the legal line kept word for word;
// * the home page: one hero button (to the Token page's buy slot), one row of facts (one countdown, one communities count), the New York
//   walkthrough right after the hero, one tabbed block instead of four card walls, every FAQ question kept in three tabs, no closing band;
// * the token page: the Buy control in a marked slot (#buy-slot, where the in-app swap goes), the contract address printed once, five
//   proofs, no third /connect link, the FAQ's step 3 naming the Buy button rather than a venue;
// * the Launchpad draws $VICINITY once (not in "Live now" and again in the list) and hides the snapshot checker until there is a snapshot;
// * rules: a chip row to every rule and each rule a fold; terms: a contents fold; cities: one plain search placeholder.
// Heights (390 px: home 17,228 → under 4,400; token 6,150 → under 4,300) were measured in Chromium on the real Worker; this file pins the markup,
// the rules and the scripts. Nothing new moves by itself: polish.css keeps its one animation inside a prefers-reduced-motion: no-preference block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

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
  assert.match(polish, /^:root \{ --tabbar-h: 67px; --bottom-bars: 0px; \}$/m, "nothing fixed at the bottom on a computer");
  assert.match(polish, /@media \(max-width: 900px\) \{\n  body \{ --bottom-bars: calc\(var\(--tabbar-h\) \+ env\(safe-area-inset-bottom\)\); padding-bottom: calc\(var\(--bottom-bars\) \+ 8px\); \}\n  body\.has-coin-buybar \{ --bottom-bars: calc\(var\(--tabbar-h\) \+ 64px \+ env\(safe-area-inset-bottom\)\); \}/,
    "the tab bar on a phone, and the coin page's Buy bar above it (style.css puts that bar at var(--tabbar-h))");
  assert.match(style, /\.coin-buybar \{ bottom: var\(--tabbar-h, 67px\);/, "the variable polish.css sets is the one the Buy bar reads");
  assert.match(polish, /\.tabbar \{ height: calc\(var\(--tabbar-h\) \+ env\(safe-area-inset-bottom\)\);/, "the bar is exactly that tall");
  assert.match(polish, /\.tabbar a \{ font-size: \.75rem;/, "12 px labels (11.2 before)");
  for (const rule of [/\.brand \{ min-height: 44px;/, /\.theme-toggle \{ width: 44px; height: 44px; \}/, /\.account-btn\.btn--sm \{ min-height: 44px; \}/, /\.btn--sm \{ min-height: 44px; \}/, /\.faq summary \{ min-height: 44px;/, /\.footer-links a \{ min-height: 44px;/]) assert.match(polish, rule);
});

test("polish.css moves nothing by itself: its one animation sits in a no-preference block and uses transform and opacity only", () => {
  const body = polish.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [...body.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
  assert.equal(blocks.length, 1);
  const outside = body.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "").replace(/@keyframes [\s\S]*?\}\s*\}/g, "");
  assert.doesNotMatch(outside, /animation\s*:|transition\s*:/, "no animation or transition outside the block");
  for (const kf of body.matchAll(/@keyframes \w+ \{([\s\S]*?)\} \}/g)) for (const prop of kf[1].matchAll(/([a-z-]+):/g)) assert.ok(["transform", "opacity"].includes(prop[1]), prop[1]);
});

test("footer, every page: no duplicate of the tab bar or the header, status and Pause on one line, data credits folded, the legal line kept", () => {
  for (const f of pages) {
    const foot = html[f].match(/<footer class="site-footer">[\s\S]*?<\/footer>/)[0];
    assert.doesNotMatch(foot, /href="\/#faq"|href="\/connect"/, `${f}: FAQ and Connect a wallet are the header's and the tab bar's`);
    assert.doesNotMatch(foot, /One city\. One coin\. One community\./, `${f}: the tagline is the home page's headline`);
    assert.match(foot, /<div class="footer-meta">\s*<p class="muted small footer-status">System status: <span id="status">checking…<\/span><\/p>\s*<p class="muted small footer-motion"><button class="link-btn motion-toggle" type="button" data-motion-toggle>Pause animations<\/button><\/p>\s*<\/div>/, f);
    assert.match(foot, /<details class="footer-data">\s*<summary class="footer-title">Data credits<\/summary>\s*<p class="tiny muted">Places: <a href="https:\/\/www\.geonames\.org\/" target="_blank" rel="noopener">GeoNames<\/a> \(CC BY 4\.0\)\. City boundaries: © <a href="https:\/\/www\.openstreetmap\.org\/copyright" target="_blank" rel="noopener">OpenStreetMap contributors<\/a> \(ODbL\)\. Country outlines: Natural Earth\.<\/p>\s*<\/details>/, f);
    assert.match(foot, /<p class="wrap tiny muted footer-legal">vicinity\.city · Nothing here is financial advice\. Meme coins are very risky: only use money you can afford to lose\.<\/p>/, f);
    assert.match(foot, /<nav class="footer-links footer-links--explore" aria-label="Footer">/, f); assert.match(foot, /<nav class="footer-links footer-links--safe" aria-label="Safety">/, f);
    assert.match(foot, /href="\/rules">Rules &amp; fairness<\/a>/, f); assert.match(foot, /href="\/terms">Terms of Use<\/a>/, f);
  }
  assert.match(polish, /\.footer-links--explore \{ display: none; \}/, "on a phone the Explore links are the tab bar's five pages: hidden there");
  assert.match(polish, /\.footer-links--safe \{ grid-column: 1 \/ -1; display: grid; grid-template-columns: 1fr 1fr;/, "the safety links two by two on a phone");
});

test("home: one hero button to the buy slot, one row of facts with one countdown, no numbers band, no closing band, the map right after the hero", () => {
  for (const h of [home, homeSrc]) {
    assert.equal(count(h, /href="\/token#buy-slot"/g), 1, "the one call to buy");
    assert.equal(count(h, /data-countdown-short/g), 1, "the countdown once (it was in four places)");
    assert.equal(count(h, /data-stat="communities"/g), 1, "the communities count once (it was in three)");
    assert.equal(count(h, /October 10/g), 2, "October 10: the roadmap's next stop and the FAQ's launch answer");
    assert.doesNotMatch(h, /class="numbers"|cta-band|hero__facts[\s\S]*?hero__facts/, "no numbers band, no closing band, one facts row");
    assert.match(h, /<ul class="hero__facts" aria-label="Vicinity in numbers">\s*<li><strong data-stat="communities">[\d,]+<\/strong><span>communities mapped<\/span><\/li>\s*<li><strong data-countdown-short>Oct 10<\/strong><span>until the Launchpad opens<\/span><\/li>\s*<li><strong data-stat="members">…<\/strong><span>verified members<\/span><\/li>\s*<li><strong data-stat="countries">[\d,]+<\/strong><span>countries<\/span><\/li>\s*<li><strong data-stat="officialBoundaries">[\d,]+<\/strong><span>official city boundaries<\/span><\/li>\s*<\/ul>/);
    const order = ["<section class=\"hero\" id=\"hero\">", "id=\"nyc\"", "id=\"problem\"", "id=\"why\"", "id=\"how\"", "id=\"roadmap\"", "id=\"faq\""].map((s) => h.indexOf(s));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "hero, the New York walkthrough, the problem, why, how, roadmap, FAQ");
    assert.ok(order.every((i) => i >= 0));
    assert.equal(count(h, /Open (on )?the live map/g), 1, "one map link (the hero figure's chip is hidden; the walkthrough's button is the one)");
    assert.equal(count(h, /Raydium/g), 7, "Raydium only where it is a fact: the launch story (roadmap, two FAQ answers); it was 19");
  }
  assert.match(polish, /\.hero-map \{ display: none; \}/, "on a phone the hero's own map is hidden: the walkthrough's bigger map comes right after the hero");
  assert.match(polish, /#nyc \.nyc \{ order: 1; \}\n  #nyc \.section-head \{ order: 2;/, "and the map comes before its heading there");
  assert.match(polish, /\.steps li:not\(:has\(button\[aria-current="step"\]\)\) \{ display: none; \}/, "one step caption at a time on a phone");
});

test("home: the incentives are one tabbed block and the FAQ another; every panel reachable, every question kept, a link into a hidden panel opens it", () => {
  const lists = [...home.matchAll(/<div class="seg seg--tabs" role="tablist" aria-label="([^"]+)" id="([^"]+)">([\s\S]*?)<\/div>/g)];
  assert.deepEqual(lists.map((m) => m[2]), ["why-tabs", "faq-tabs"]);
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
  for (const id of ["why-now", "roles", "for-cities", "faq-basics", "faq-founders", "faq-safety"]) assert.equal(count(home, new RegExp(`id="${id}"`, "g")), 1, id);
  const faq = home.slice(home.indexOf('<section id="faq"'));
  const questions = [...faq.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.deepEqual(questions, [
    "What is Vicinity?", "How do I buy $VICINITY?", "Why did $VICINITY launch on Raydium LaunchLab and not on the Vicinity Launchpad?", "How do I get my dashboard?", "I use FOMO (or another app wallet). How do I connect?",
    "How do I become a City Founder?", "Who is the Country Manager?", "Can a whale take over?", "What happens if I sell?", "What if I don't live inside any city?",
    "Is this a rug pull?", "Which contract address is real?", "What do you store about me?", "Can someone fake their location?", "Is this financial advice?",
  ], "every question of 8 Oct 2026, five a tab");
  assert.match(home, /<details class="compare-details">\s*<summary>Random city coin vs Vicinity city coin<\/summary>/, "the six-row comparison, folded");
  assert.equal(count(home, /<tr><th scope="row">/g), 6);
  assert.match(home, /<details class="checks-details">\s*<summary><span class="live-dot" aria-hidden="true"><\/span>Checked live, all the time<\/summary>/);
  assert.equal(count(home, /<li><strong>[^<]+<\/strong><span>[^<]+<\/span><\/li>/g), 6, "the six live checks");
  const js = read("public/home.js");
  assert.match(js, /\$\$\('\[role="tablist"\]'\)\.map\(\(list\) => \{/);
  assert.match(js, /e\.key === "ArrowRight" \? i \+ 1 : e\.key === "ArrowLeft" \? i - 1 : e\.key === "Home" \? 0 : e\.key === "End" \? tabs\.length - 1 : null/, "arrow keys move between tabs");
  assert.match(js, /t\.setAttribute\("aria-selected", String\(on\)\); t\.tabIndex = on \? 0 : -1;/);
  assert.match(js, /function openFor\(hash\)/); assert.match(js, /window\.addEventListener\("hashchange", \(\) => openFor\(location\.hash\)\);/, "/#why-launchlab opens its tab, then lands");
  assert.match(js, /if \(target\.tagName === "DETAILS"\) target\.open = true;/);
  assert.match(js, /const SHOWN = 5;/); assert.match(js, /more\.textContent = `\+\$\{fmt\(hidden\)\} more`;/, "the member chips: the five boroughs and a +N more that unfolds the rest");
});

test("home: the roles and the founder amount stated once each, the five steps in the new order (location, Google, dashboard, wallet when you like, Launchpad)", () => {
  const roles = home.match(/<div class="tabpanel why-panel" id="roles"[\s\S]*?<\/div>\s*<div class="tabpanel/)[0];
  assert.deepEqual([...roles.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ["Holder", "City Founder", "Country Manager", "Admin"]);
  assert.equal(count(home, /100K to 1M/g), 1, "the Stake Ladder's range once (it was in five places)");
  assert.equal(count(home, /Founding Supporters/g), 3, "named in the first tab, the second fact and the roadmap");
  const steps = [...home.matchAll(/<li class="flow__step reveal"><span class="flow__icon" aria-hidden="true">[^<]+<\/span><div><h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(steps, ["Find your community", "Sign in with Google", "Your dashboard", "Connect a wallet when you like", "City coins on the Launchpad"]);
  assert.match(home, /<p class="get-line" id="get"><strong>Need \$VICINITY\?<\/strong> Four steps, about five minutes: <a href="\/token#buy">see how on the Token page<\/a>\.<\/p>/, "the four steps live on the Token page, once");
  assert.doesNotMatch(home, /class="buy-steps"|Buy on Raydium/, "no second copy of the steps, no venue in a button label");
});

test("style.css lost only the rules the old home page used: the numbers band, the bento, why-now, the buy steps, the roles grid, the closing band", () => {
  assert.doesNotMatch(style, /\.numbers__row|\.bento\b[^,]|\.why-now\b[^,]|\.buy-steps\b[^,]|\.roles-grid\b[^,]|\.cta-band|\.hero__cta--end/);
  assert.match(style, /\.role__icon \{ font-size: 1\.7rem;/, "the role icon stays (the dashboard's role panel and the home tabs)");
  assert.match(style, /\.scam-note \{/, "the scam note stays (the token page's FAQ)");
});

test("token: the Buy control in its slot, the address once, five proofs, no third /connect link, the official list points at the card", () => {
  for (const h of [tokenPage, read("scripts/pages/src/token.html")]) {
    assert.match(h, /<div class="contract__links" id="ca-links">\s*<div class="contract__slot" id="buy-slot"><a class="contract__buy" id="lnk-raydium"/, "the slot is the first thing in the links block");
    assert.equal(count(h, /id="buy-slot"/g), 1);
    assert.equal(count(h, /<div class="proof card">/g), 5, "Minting disabled, No freeze button, Liquidity can't be pulled, Team wallets public, No presale");
    assert.doesNotMatch(h, /supply-text|supply2|<h3>Fixed supply<\/h3>/, "the Supply fact above and the Minting proof already say the supply is fixed");
    assert.equal(count(h, /href="\/connect"/g), 1, "one link to /connect in the page, in the FAQ's step 4 (the holders footnote was the third; the header's button is /connect?mode=login)");
    assert.doesNotMatch(h, /If a token isn't on this list, it isn't Vicinity/, "the card's note says it once");
    assert.match(h, /<details><summary>Is this the only official \$VICINITY\?<\/summary><p>Yes: the contract address at the top of this page, and only that one\. The <a href="#check">checker<\/a> tells you whether any link, address or @handle is ours\.<\/p><\/details>/);
  }
  assert.match(polish, /\.contract__slot \{ grid-column: 1 \/ -1; display: grid; min-width: 0; \}/, "the slot spans the card on a phone, like the button did");
  assert.match(polish, /@media \(min-width: 640px\) \{ \.contract__slot \{ grid-column: auto; \} \}/);
  assert.match(polish, /@media \(min-width: 1180px\) \{ \.contract:has\(> \.contract__links:not\(\[hidden\]\)\) \.contract__slot \{ grid-column: 1 \/ -1; \} \}/);
  const js = read("public/token.js");
  assert.match(js, /if \(isAddr\(t\.contract\)\) \{ const a = el\("a", "registry__above", "Shown above ↑"\); a\.href = "#contract"; a\.title = t\.contract; ca\.append\(a\); \} else ca\.textContent = "—";/,
    "the official list prints no second copy of the address, and a token without one shows a dash (it printed 'Phase 3' in two cells)");
  assert.match(js, /const supplyText = \$\("#supply-text"\); if \(supplyText\) supplyText\.textContent = fmt\(f\.supply\);/);
  assert.match(polish, /\.holders__table a \{ display: inline-block; padding: 12px 0; margin: -12px 0; \}/, "a 44 px hit area on every wallet in the list");
});

test("launchpad: $VICINITY drawn once, the snapshot checker hidden until there is a snapshot, one date line, the calendar as a text link", () => {
  const js = read("public/launchpad.js"), h = html["launchpad.html"];
  assert.match(js, /const vic = data && data\.vicinity && isLive\(data\.vicinity\) \? data\.vicinity : null;\n\s+const rows = rowsFor\(vic \? cards\.filter\(\(c\) => c !== vic\) : cards, \{ \.\.\.state, now, countryNames \}\);/,
    "the featured card is left out of the list below it");
  assert.match(js, /const form = \$\("#snap-form"\); if \(form\) form\.hidden = !snap;/);
  assert.match(h, /Opening <strong id="lp-date">October 10, 2026 · 10:10:10 AM New York time<\/strong>\. <span class="lp-local muted small" id="lp-local"><\/span><\/p>/, "your local time in the same sentence");
  assert.match(h, /<button class="link-btn lp-cal-link" type="button" id="lp-cal">Add to my calendar<\/button>/);
  assert.equal(count(h.slice(h.indexOf("<main")), /October 10/g), 1, "the date once in the page");
  assert.match(polish, /\.lp-stats--live \.lp-stat:has\(> \.lp-stat__src\.is-why\) \{ display: none; \}/, "a number nobody has yet is not a tile on a phone");
  assert.match(polish, /\.coin-stack \{ display: none; \}/, "the sample tickers are decoration: not on a phone");
});

test("cities, rules, terms: a plain search placeholder; a chip row and folds on the rules; a contents fold on the terms", () => {
  assert.match(html["cities.html"], /<input id="city-q" type="search" autocomplete="off" spellcheck="false" maxlength="60" placeholder="Search a city">/);
  assert.match(html["cities.html"], /<div class="city-stats__claims"><strong id="cs-status">…<\/strong><span>claims<\/span><\/div>/);
  assert.match(polish, /\.city-stats \.is-open, \.city-stats \.city-stats__claims \{ display: none; \}/, "four facts on a phone: 'still open' is communities minus founded, 'claims' a word");
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
