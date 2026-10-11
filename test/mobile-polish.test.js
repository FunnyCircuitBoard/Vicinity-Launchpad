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
  assert.match(polish, /\.footer-links--safe \{ grid-column: 1 \/ -1; display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/, "the safety links two by two on a phone");
});

test("home: one hero button to the buy slot, one row of facts with one countdown, no numbers band, no closing band, the map right after the hero", () => {
  for (const h of [home, homeSrc]) {
    assert.equal(count(h, /href="\/token#buy-slot"/g), 1, "the one call to buy");
    // d3 (11 Oct 2026): no countdown on the home page any more. Since the Launchpad opened, its tile read "Live / Launchpad is open" (teal,
    // live dot), which reads as if city coins trade; none can launch yet. The tile is a plain link: "Launchpad · Open · city coins come next"
    assert.equal(count(h, /data-countdown-short|data-countdown-label/g), 0, "no countdown fact (site.js keeps the code for other pages)");
    assert.equal(count(h, /data-stat="communities"/g), 1, "the communities count once (it was in three)");
    assert.equal(count(h, /October 10/g), 1, "October 10 once: the FAQ's launch answer (the roadmap's next stop has no date)");
    assert.doesNotMatch(h, /class="numbers"|cta-band|hero__facts[\s\S]*?hero__facts/, "no numbers band, no closing band, one facts row");
    // d3 (11 Oct 2026): strong facts only, as tiles. A phone shows the first three (communities, countries, official boundaries), a
    // computer the Launchpad link tile too. No members tile in the markup: home.js adds one only at 100 verified members or more (the
    // owner circled "2 verified members"), never "…"; the numbers are /data/stats.json's (8,008 / 5,831 / 73 were stale and flashed)
    assert.match(h, /<ul class="hero__facts" aria-label="Vicinity in numbers">\s*<li><strong data-stat="communities">8,029<\/strong><span>communities mapped<\/span><\/li>\s*<li class="hero__fact--countries"><strong data-stat="countries">244<\/strong><span>countries &amp; territories<\/span><\/li>\s*<li><strong data-stat="officialBoundaries">5,838<\/strong><span>official<span class="fact__wide"> city<\/span> boundaries<\/span><\/li>\s*<li class="hero__fact--launch"><a class="hero__fact-link" href="\/launchpad"><strong><span class="ico ico--sm" aria-hidden="true"><svg [^>]+>[^]*?<\/svg><\/span>Launchpad<\/strong><span>Open · city coins come next <span aria-hidden="true">→<\/span><\/span><\/a><\/li>\s*<\/ul>/);
    assert.doesNotMatch(h, /data-stat="members"|\bLive\b<|Launchpad is open/, "no members placeholder, nothing that reads like trading");
    assert.doesNotMatch(h, /data-stat="communities">8,008<|data-stat="officialBoundaries">5,831<|hero-chip--2"><b data-stat="nycMembers">73</, "no stale fallback numbers");
    const order = ["<section class=\"hero\" id=\"hero\">", "id=\"nyc\"", "id=\"problem\"", "id=\"why\"", "id=\"how\"", "id=\"roadmap\"", "id=\"faq\""].map((s) => h.indexOf(s));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "hero, the New York walkthrough, the problem, why, how, roadmap, FAQ");
    assert.ok(order.every((i) => i >= 0));
    assert.equal(count(h, /Open (on )?the live map/g), 1, "one map link (the hero figure's chip is hidden; the walkthrough's button is the one)");
    assert.equal(count(h, /Raydium/g), 7, "Raydium only where it is a fact: the launch story (roadmap, two FAQ answers); it was 19");
  }
  assert.match(polish, /\.hero-map \{ display: none; \}/, "on a phone the hero's own map is hidden: the walkthrough's bigger map comes right after the hero");
  assert.match(polish, /#nyc \.section-head \{ margin-bottom: 10px; \}\n  #nyc \.section-head p\.muted \{ display: none; \}/, "its kicker and title stay above the map; the hint under them goes (Previous · Pause · Next say it)");
  assert.doesNotMatch(polish, /#nyc \.nyc \{ order/, "nothing is reordered: a reader meets the title, then the map");
  // one step caption at a time on a phone; d3: the four sit in one grid cell and only the current one shows, so the card is as tall as the
  // tallest step and the controls under it never jump while it plays (95 px at every step before)
  assert.match(polish, /  \.steps \{ display: grid; gap: 0; margin-bottom: 10px; \}\n  \.steps li \{ grid-area: 1 \/ 1; display: grid; \}\n  \.steps button:not\(\[aria-current="step"\]\) \{ visibility: hidden; \}/);
  assert.doesNotMatch(polish, /\.steps li:not\(:has\(button\[aria-current="step"\]\)\) \{ display: none; \}/, "not display: none (the card's height changed every step)");
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
  const steps = [...home.matchAll(/<li class="flow__step reveal"(?: id="get")?><span class="flow__icon ico ico--sm" aria-hidden="true"><svg [^>]+>(?:<(?:path|circle|rect) [^>]+\/>)+<\/svg><\/span><div><h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(steps, ["Find your community", "Sign in with Google or e-mail", "Your dashboard", "Connect a wallet when you like", "City coins on the Launchpad"]);
  // one sign-in story on the page (the FAQ says Google or e-mail; the step and the roadmap said Google only), and the measured claim about accounts
  assert.match(home, /<h3>Sign in with Google or e-mail<\/h3><p class="muted">One account per login makes fake accounts and spam harder \(it does not prove one person\)\.<\/p>/);
  assert.match(home, /<p>One account per login, live ranks and badges, local and national feeds, moderation\.<\/p>/);
  assert.doesNotMatch(home, /per Google login|keeps fake accounts and spam out/);
  // the pointer to the Token page is step 5's (the "Need $VICINITY?" box under the steps was the hero's call to buy a second time); /#get still lands
  assert.match(home, /<li class="flow__step reveal" id="get"><span class="flow__icon ico ico--sm" aria-hidden="true"><svg [^>]+>[^]*?<\/svg><\/span><div><h3>City coins on the Launchpad<\/h3><p class="muted">Founders and \$VICINITY holders get in before the public\. <a href="\/token#buy">How to get \$VICINITY →<\/a><\/p><\/div><\/li>/);
  assert.equal(count(home, /go first/g), 1, "said once: the first tab's heading");
  assert.doesNotMatch(home.slice(home.indexOf("<main")), /[\u{1F300}-\u{1FAFF}\u2699\u26A1]/u, "no emoji as icons in the page: the shared SVG set in .ico");
  assert.doesNotMatch(home, /get-line|Need \$VICINITY\?/); assert.doesNotMatch(polish, /\.get-line/);
  assert.equal(count(home, /href="\/token#buy(-slot)?"/g), 2, "the hero's button to the buy slot and step 5's link to the how-to: no third pointer to the token (the FAQ's closed fold links the page itself)");
  assert.doesNotMatch(home, /class="buy-steps"|Buy on Raydium/, "no second copy of the steps, no venue in a button label");
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
    assert.equal(count(h, /href="\/connect"/g), 1, "one link to /connect in the page, in the FAQ's step 4 (the holders footnote was the third; the header's button is /connect?mode=login)");
    assert.doesNotMatch(h, /If a token isn't on this list, it isn't Vicinity/, "the card's note says it once");
    assert.match(h, /<details><summary>Is this the only official \$VICINITY\?<\/summary><p>Yes: the contract address at the top of this page, and only that one\. The <a href="#check">checker<\/a> tells you whether any link, address or @handle is ours\.<\/p><\/details>/);
  }
  assert.match(polish, /\.contract__slot \{ grid-column: 1 \/ -1; display: grid; min-width: 0; \}/, "the slot spans the card on a phone, like the button did");
  assert.match(polish, /@media \(min-width: 640px\) \{ \.contract__slot \{ grid-column: auto; \} \}/);
  // design v2 (10 Oct 2026): the Buy card left the contract card (its own column on a computer), so the wide-card slot rule is gone
  assert.doesNotMatch(polish, /\.contract:has\(> \.contract__links:not\(\[hidden\]\)\) \.contract__slot/);
  const js = read("public/token.js");
  assert.match(js, /if \(isAddr\(t\.contract\)\) \{ const a = el\("a", "registry__above", "Shown above ↑"\); a\.href = "#contract"; a\.title = t\.contract; ca\.append\(a\); \} else ca\.textContent = "—";/,
    "the official list prints no second copy of the address, and a token without one shows a dash (it printed 'Phase 3' in two cells)");
  assert.match(js, /const supplyText = \$\("#supply-text"\); if \(supplyText\) supplyText\.textContent = fmt\(f\.supply\);/);
  assert.match(polish, /\.holders__table a \{ display: inline-block; padding: 12px 0; margin: -12px 0; \}/, "a 44 px hit area on every wallet in the list");
});

test("launchpad: $VICINITY drawn once, the snapshot checker hidden until there is a snapshot, one date line, the calendar as a text link", () => {
  const js = read("public/launchpad.js"), h = html["launchpad.html"];
  assert.match(js, /const vic = data && data\.vicinity && isLive\(data\.vicinity\) \? data\.vicinity : null;\n\s+const listed = vic \? cards\.filter\(\(c\) => c !== vic\) : cards;\n\s+const n = counts\(listed, now\);/,
    "the featured card is left out of the tab counts (they said 'Live 6' over '5 coins')");
  assert.match(js, /const rows = rowsFor\(listed, \{ \.\.\.state, now, countryNames \}\);/, "and out of the list below it: counts and list from the same cards");
  assert.doesNotMatch(js, /counts\(cards, now\)/);
  assert.match(js, /const form = \$\("#snap-form"\); if \(form\) form\.hidden = !snap;/);
  assert.match(h, /Opening <strong id="lp-date">October 10, 2026 · 10:10:10 AM New York time<\/strong>\. <span class="lp-local muted small" id="lp-local"><\/span><\/p>/, "your local time in the same sentence");
  assert.match(h, /<button class="link-btn lp-cal-link" type="button" id="lp-cal">Add to my calendar<\/button>/);
  assert.equal(count(h.slice(h.indexOf("<main")), /October 10/g), 1, "the date once in the page");
  assert.match(polish, /\.lp-stats--live \.lp-stat__src\.is-why \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/, "a number nobody has yet keeps its tile: its reason on one line, so the four tiles stay two by two");
  assert.doesNotMatch(polish, /\.lp-stat:has\(> \.lp-stat__src\.is-why\) \{ display: none/, "hiding the tile left a blank cell in every card");
  assert.match(polish, /\.lp-tabs \{ flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; \}\n  \.lp-tabs::-webkit-scrollbar \{ display: none; \}\n  \.lp-tabs button \{ flex: 1 1 auto; padding: 0 6px; gap: 4px; font-size: \.8rem; \}\n  \.lp-tabs__n \{ min-width: 0; padding: 1px 6px; \}/, "Live · New · Upcoming · Trending on one row at 390 (Trending sat alone on a second)");
  assert.match(js, /That is \$\{d\.toLocaleString\(undefined, \{ weekday: "long", hour: "numeric", minute: "2-digit", second: "2-digit" \}\)\} where you are\./, "the date is said once; the local line is only the visitor's clock");
  assert.match(polish, /\.coin-stack \{ display: none; \}/, "the sample tickers are decoration: not on a phone");
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
  assert.match(style, /--fs-xl: clamp\(1\.375rem, 1rem \+ 2vw, 2\.25rem\);/);
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
  assert.match(polish, /\.footer-links--safe a:first-of-type \{ grid-column: 1 \/ -1; \}/);
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
  // d3: every label is laid out against the coin, New York City's own label (placed first), the labels already kept and the map's edge
  // (before, the city's label was added after the others and "Parsippany · $PARSIPPANY" ran into it at every width)
  const hjs = read("public/home.js");
  assert.match(hjs, /const cr = coinPx\(\) \* u \+ m, taken = \[\[cx - cr, cy - cr, cx \+ cr, cy \+ cr\]\];\n\s+const bb = area\(big\); taken\.push\(\[bb\[0\] - m, bb\[1\] - m, bb\[2\] \+ m, bb\[3\] \+ m\]\);/, "the coin, then the city's own label");
  assert.match(hjs, /if \(b\[0\] < edge\[0\] \|\| b\[1\] < edge\[1\] \|\| b\[2\] > edge\[2\] \|\| b\[3\] > edge\[3\]\) continue;\n\s+if \(taken\.some\(\(k\) => hit\(b, k\)\)\) continue;/, "inside the map, touching nothing taken");
  assert.match(home, /<a class="btn btn--glass btn--sm nyc__explore" href="\/cities">Explore every city<\/a>/, "no arrow beside the Next button's arrow; glass: the hero's Get $VICINITY is the page's one orange button");
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

test("design v2 tokens: the contract the other sheets read (names fixed), with their phone steps and light values; the shared components", () => {
  const names = ["--fs-xs", "--fs-sm", "--fs-base", "--fs-md", "--fs-lg", "--fs-xl", "--fs-2xl", "--fs-num", "--fs-kicker", "--ls-kicker", "--lh-tight", "--lh-snug", "--lh-body",
    "--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6", "--sp-7", "--sp-8", "--gutter", "--card-pad", "--section-y",
    "--r-xs", "--r-chip", "--r-card", "--r-hero", "--r-pill", "--surface-1", "--surface-2", "--surface-inset", "--accent-soft", "--ok-soft", "--warn-soft", "--gold-soft",
    "--shadow-1", "--shadow-2", "--header-h", "--sticky-top", "--dur-1", "--dur-2", "--dur-3", "--ease-out"];
  const root = style.slice(0, style.indexOf("/* ---------- base ---------- */"));
  for (const n of names) assert.match(root, new RegExp(`${n}: [^;]+;`), n);
  assert.match(root, /--fs-xs: \.75rem;/, "12 px is the floor");
  assert.match(root, /--header-h: 67px;/, "the header stays 66 + 1 px");
  assert.match(root, /@media \(min-width: 481px\) \{ :root \{ --gutter: 24px; \} \}\n@media \(min-width: 601px\) \{ :root \{ --card-pad: 22px; \} \}\n@media \(min-width: 901px\) \{ :root \{ --section-y: 72px; \} \}/);
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

test("home on a phone (the owner's screenshots 2 and 3): three facts that fit, a vertical roadmap, the Launchpad live state, nothing that scrolls sideways", () => {
  const phone = polish.slice(polish.indexOf("@media (max-width: 600px) {\n  .hero__cta--one .btn { flex: 1 1 auto; }"));
  // d3: the same tiles on every screen (one row of four on a computer, three on a phone); the Launchpad tile is a computer's
  assert.match(polish, /\.hero__facts \{ list-style: none; display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\) minmax\(0, 1\.3fr\); gap: var\(--sp-2\); margin: 0; padding: 0; \}/);
  assert.match(polish, /\.hero__facts > li \{ display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: var\(--sp-3\); border-radius: var\(--r-chip\); background: var\(--surface-1\); border: 1px solid var\(--line\); box-shadow: var\(--shadow-1\); \}/);
  assert.match(phone, /\.hero__facts \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}\n  \.hero__facts > li\.hero__fact--launch, \.hero__facts \.fact__wide \{ display: none; \}/, "three tiles on a phone");
  const shown = [...homeSrc.match(/<ul class="hero__facts"[\s\S]*?<\/ul>/)[0].matchAll(/<li[^>]*>[\s\S]*?<\/li>/g)].slice(0, 3).map((m) => (/data-stat="(\w+)"/.exec(m[0]) || [])[1] || "?");
  assert.deepEqual(shown, ["communities", "countries", "officialBoundaries"], "exactly these three show on a phone");
  assert.doesNotMatch(polish, /margin: 0 -16px/, "no negative side margins: nothing reaches past the gutter");
  // the roadmap: the horizontal row only from 900 px; below it the vertical rail of style.css, every stop stacked
  const wide = polish.match(/@media \(min-width: 900px\) \{\n  \.timeline \{ display: flex;[\s\S]*?\n\}/);
  assert.ok(wide, "the row is a computer's");
  assert.equal((polish.match(/\.timeline \{/g) || []).length, 1, "and the only .timeline rule in polish.css");
  assert.match(style, /\.timeline__item \{ position: relative; padding: 0 0 18px 10px; \}/);
  assert.match(style, /\.timeline::before \{[^}]*linear-gradient\(var\(--moss\), var\(--moss\) var\(--rail-done, 48%\), var\(--pin\) var\(--rail-at, 66%\)/, "green to the last stop done, orange at the next");
  // after 10:10:10 New York time: site.js still flips a countdown fact to "Live / Launchpad is open" on any page that has one (the home page
  // has none since d3), the roadmap's Launchpad stop reads "Open now", the Passport next
  const site = read("public/site.js"), homeJs = read("public/home.js");
  assert.doesNotMatch(site, /Open now|until the Launchpad opens/);
  assert.match(site, /if \(e\.textContent !== "Live"\) e\.textContent = "Live";/);
  assert.match(site, /label\.textContent = "Launchpad is open";/);
  assert.match(site, /if \(fact\) fact\.classList\.add\("is-live"\);/);
  assert.match(site, /document\.dispatchEvent\(new CustomEvent\("vicinity:launchpad-open"\)\);/, "a page left open across the opening flips too");
  assert.match(homeJs, /stop\.classList\.remove\("is-next"\); stop\.classList\.add\("is-done", "is-now"\);/);
  // the stop says the page is open, not "Live now": no city coin can launch until its founder qualifies (honest copy, 10 Oct 2026)
  assert.match(homeJs, /status\.textContent = "Open now";/);
  assert.doesNotMatch(homeJs, /status\.textContent = "Live now"/);
  assert.match(homeJs, /go\.href = "\/launchpad"; go\.textContent = "Open the Launchpad →";/);
  assert.match(homeJs, /later\.classList\.add\("is-next"\);/);
  assert.match(homeJs, /document\.addEventListener\("vicinity:launchpad-open", launchpadLive\);/);
  // the headline: "One city. One coin." then "One community." (a space before every <br>, the first one hidden on a phone)
  assert.match(homeSrc, /<h1 class="hero__title">One city\. <br>One coin\. <br><span class="accent">One community\.<\/span><\/h1>/);
  assert.match(polish, /\.hero__title br:first-of-type \{ display: none; \}/);
});

test("design v2 rhythm: sections, cards, kickers and page titles use the tokens (one place to tune them)", () => {
  assert.match(style, /\.section \{ padding: var\(--section-y\) 0; position: relative; \}/);
  assert.match(style, /\.card \{[^}]*border-radius: var\(--r-card\); padding: var\(--card-pad\); box-shadow: var\(--shadow-1\); \}/);
  assert.match(style, /\.kicker \{[^}]*font-size: var\(--fs-kicker\);[^}]*letter-spacing: var\(--ls-kicker\);/);
  assert.match(style, /\.page-title \{ font-size: var\(--fs-2xl\);/);
  assert.doesNotMatch(polish, /(^|[\s}])(\.section|\.card|\.kicker) \{ (padding|font-size)/m, "the old values went with the tokens");
});
