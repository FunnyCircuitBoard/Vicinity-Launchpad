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
    assert.equal(count(h, /October 10/g), 1, "October 10 once: the FAQ's launch answer (the roadmap's next stop has no date)");
    assert.doesNotMatch(h, /class="numbers"|cta-band|hero__facts[\s\S]*?hero__facts/, "no numbers band, no closing band, one facts row");
    assert.match(h, /<ul class="hero__facts" aria-label="Vicinity in numbers">\s*<li><strong data-stat="communities">[\d,]+<\/strong><span>communities mapped<\/span><\/li>\s*<li><strong data-countdown-short>Oct 10<\/strong><span>until the Launchpad opens<\/span><\/li>\s*<li><strong data-stat="members">…<\/strong><span>verified members<\/span><\/li>\s*<li><strong data-stat="countries">[\d,]+<\/strong><span>countries<\/span><\/li>\s*<li><strong data-stat="officialBoundaries">[\d,]+<\/strong><span>official city boundaries<\/span><\/li>\s*<\/ul>/);
    const order = ["<section class=\"hero\" id=\"hero\">", "id=\"nyc\"", "id=\"problem\"", "id=\"why\"", "id=\"how\"", "id=\"roadmap\"", "id=\"faq\""].map((s) => h.indexOf(s));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "hero, the New York walkthrough, the problem, why, how, roadmap, FAQ");
    assert.ok(order.every((i) => i >= 0));
    assert.equal(count(h, /Open (on )?the live map/g), 1, "one map link (the hero figure's chip is hidden; the walkthrough's button is the one)");
    assert.equal(count(h, /Raydium/g), 7, "Raydium only where it is a fact: the launch story (roadmap, two FAQ answers); it was 19");
  }
  assert.match(polish, /\.hero-map \{ display: none; \}/, "on a phone the hero's own map is hidden: the walkthrough's bigger map comes right after the hero");
  assert.match(polish, /#nyc \.section-head \{ margin-bottom: 10px; \}\n  #nyc \.section-head p\.muted \{ display: none; \}/, "its kicker and title stay above the map; the hint under them goes (Previous · Pause · Next say it)");
  assert.doesNotMatch(polish, /#nyc \.nyc \{ order/, "nothing is reordered: a reader meets the title, then the map");
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
  const steps = [...home.matchAll(/<li class="flow__step reveal"(?: id="get")?><span class="flow__icon" aria-hidden="true">[^<]+<\/span><div><h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(steps, ["Find your community", "Sign in with Google or e-mail", "Your dashboard", "Connect a wallet when you like", "City coins on the Launchpad"]);
  // one sign-in story on the page (the FAQ says Google or e-mail; the step and the roadmap said Google only), and the measured claim about accounts
  assert.match(home, /<h3>Sign in with Google or e-mail<\/h3><p class="muted">One account per login makes fake accounts and spam harder \(it does not prove one person\)\.<\/p>/);
  assert.match(home, /<p>One account per login, live ranks and badges, local and national feeds, moderation\.<\/p>/);
  assert.doesNotMatch(home, /per Google login|keeps fake accounts and spam out/);
  // the pointer to the Token page is step 5's (the "Need $VICINITY?" box under the steps was the hero's call to buy a second time); /#get still lands
  assert.match(home, /<li class="flow__step reveal" id="get"><span class="flow__icon" aria-hidden="true">🚀<\/span><div><h3>City coins on the Launchpad<\/h3><p class="muted">Founders and \$VICINITY holders go first\. <a href="\/token#buy">How to get \$VICINITY →<\/a><\/p><\/div><\/li>/);
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
  // A-1: with mandatory snapping Chromium re-snapped the first card to the scrollport's edge (x=0 under a hero that starts at 16): the snap port starts at the gutter
  assert.match(polish, /\.hero__facts \{ display: flex; overflow-x: auto; scroll-snap-type: x mandatory; scroll-padding-inline: 16px;/);
  assert.match(polish, /\.timeline \{ display: flex; gap: 10px; padding: 12px 0 4px; overflow-x: auto; scroll-snap-type: x mandatory; scroll-padding-inline: 16px;/);
  // A-3: at 320 px "Jupiter" and "Solscan" broke mid-word inside 79 px links
  assert.match(polish, /\n  \.contract__ext span \{ overflow-wrap: normal; \}[^\n]*\n\}\n@media \(max-width: 360px\)/, "inside the phone block of the three links");
  assert.match(polish, /@media \(max-width: 360px\) \{ \.contract__ext \{ gap: 4px; padding: 0 4px; \} \.contract__ext svg \{ display: none; \} \}/);
  // A-7: Check rank (44 px, 10 px corners) and Check (48 px, pill) had the same job and two shapes
  assert.match(polish, /\.checker \.btn, \.snap-lookup \.btn \{ min-height: 44px; font-size: \.9rem; \}\n\.find-box \.find-box__go \{ border-radius: 999px; \}/);
  // A-8: one h2 size on a phone
  assert.match(polish, /  h2, \.h2--sm \{ font-size: clamp\(1\.4rem, 6vw, 1\.75rem\); max-width: none; \}/);
  assert.doesNotMatch(polish, /#nyc \.section-head h2 \{ font-size/);
  // F2: on a phone the Buy & sell card lost its Buy button while coin.js keeps the bar off for exactly that scroll range
  assert.doesNotMatch(polish, /\.coin-buy \.contract__buy \{ display: none/);
  assert.match(read("public/coin.js"), /const b = headBuyOut && !buyCardIn && Boolean\(data\)/, "the bar hides while the card is on screen, so the card must keep its button");
  // F4: the light theme's --pin-2 (#D4501F) is 4.2:1 on white and --pin (#E8431F) 3.7:1: the small orange texts this polish added use a darker orange
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const light = polish.match(/^:root\[data-theme="light"\] \.member-cloud__more, :root\[data-theme="light"\] \.problems \.problem__num, :root\[data-theme="light"\] \.flow--compact \.flow__step p a \{ color: (#[0-9A-Fa-f]{6}); \}$/m);
  assert.ok(light, "one light-theme rule for the three");
  for (const bg of ["#FFFFFF", "#F4F6FA"]) assert.ok(ratio(light[1], bg) >= 4.5, `${light[1]} on ${bg}: ${ratio(light[1], bg).toFixed(2)}:1`);
  // A-6: an inline-block link's baseline is its last line, so a wrapped entry's number sat on its second line
  assert.match(polish, /\.terms-toc a \{ display: block; padding: 6px 0;/);
  // nits: the dead footer rule; the safety links one-then-two; every place shown on a computer; the token page's placeholder and skip link; the official list's wording
  assert.doesNotMatch(polish, /\.footer-brand > p\.muted:not\(\.small\)/, "build.mjs no longer emits the tagline paragraph");
  assert.match(polish, /\.footer-links--safe a:first-of-type \{ grid-column: 1 \/ -1; \}/);
  assert.match(polish, /@media \(min-width: 900px\) \{ \.member-cloud li\.is-more \{ display: inline-flex; \} \.member-cloud li:has\(> \.member-cloud__more\) \{ display: none; \} \}/);
  assert.match(polish, /@media \(min-width: 901px\) \{ \.proof-grid \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\); \} \.proof \{ grid-column: span 2; \} \.proof:nth-child\(4\), \.proof:nth-child\(5\) \{ grid-column: span 3; \} \}/, "five proofs: three, then two, both rows full");
  for (const h of [tokenPage, read("scripts/pages/src/token.html")]) {
    assert.match(h, /<input id="check-input" name="q" type="text" autocomplete="off" spellcheck="false" maxlength="300" placeholder="Link, address or @handle">/, "a placeholder that never clips (the line above it says what to paste)");
    assert.match(h, /<a class="holders__skip" href="#proof">Skip the holder list<\/a>\n\s*<div class="table-scroll" id="holders-scroll"/, "a keyboard skips the 300 wallet links");
    assert.match(h, /<section class="section section--tight" id="proof" tabindex="-1">/);
  }
  assert.match(polish, /\.holders__skip \{ position: absolute; left: -999px; \}\n\.holders__skip:focus \{ position: static;/);
  assert.match(read("public/token.js"), /t\.symbol\.startsWith\("e\.g\."\) \? `\$\{t\.name\}, \$\{t\.symbol\}` : `\$\{t\.name\} \(\$\$\{t\.symbol\}\)`/, "'City coins (one per city), e.g. $UTICA': not two brackets in a row");
  assert.match(read("public/home.js"), /const coinBox = \[cx - 34, cy - 34, cx \+ 34, cy \+ 34\];[^\n]*\n\s+const tidy = \(\) => \{ declutter\(nbLabels, \[coinBox\]\); declutter\(memberLabels, \[coinBox\]\); \};/, "step 2: no borough label on the $NYC disc");
  assert.match(home, /<a class="btn btn--primary btn--sm" href="\/cities">Explore every city<\/a>/, "no arrow beside the Next button's arrow");
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
