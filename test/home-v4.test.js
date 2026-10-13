// Design v4, track B (12 Oct 2026): the home page and the app preview (/app). The owner: "remove the risk warnings", "the pause-animation
// button must go", "the website does not look that premium", "no NYC map on the home page", "bring the 'One city. One coin.' text to the
// centre top", "next to the 'Get $VICINITY' button add a similar button (Sign up)"; his pasted prompt items 2 (hero + live ticker) and 6
// (a glass/3D preview of the upcoming app). The lead's rules: R1 every number is real and comes from an existing API (a number nobody
// answered for is left out; the app is labelled in development, never available), R7 premium, fast, no layout shift, reduced motion.
// What is pinned here: the markup and copy of both pages, the ticker's sources and its no-shift drawing, the old links' redirects, the
// sheets' motion rules. How it looks at 320-1920 px in both themes, signed in and out, is checked in Chromium on the real Worker
// (scratchpad v4/b-run/shots.cjs: overflow, 44 px targets, CLS, the ticker against the API answers of the same session, loops, CSP).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const homeSrc = read("scripts/pages/src/index.html"), home = read("public/index.html"), js = read("public/home.js");
const appSrc = read("scripts/pages/src/app.html"), app = read("public/app.html"), appJs = read("public/app.js");
const homeCss = read("public/pages-home.css"), appCss = read("public/pages-app.css"), phoneCss = read("public/app-phone.css");
/** The page's own content: inside <main> of a built page; a source minus its settings line. */
const mainOf = (h) => (h.includes('<main id="main"') ? h.slice(h.indexOf('<main id="main"'), h.indexOf("</main>")) : h.replace(/^<!--\{.*\}-->\n/, ""));
const settings = (src) => JSON.parse(src.match(/^<!--(\{.*\})-->/)[1]);
const count = (s, re) => (s.match(re) || []).length;

test("home hero: \"One city. One coin.\" centred at the top on two lines, one honest line, Get $VICINITY beside Sign up, then the live numbers", () => {
  for (const h of [homeSrc, home]) {
    const main = mainOf(h);
    assert.match(main.replace(/^<main id="main">/, "").trimStart(), /^(<!--[\s\S]*?-->\s*)?<section class="hero4" id="hero">/, "the hero opens the page: no pill, no map, nothing above the headline");
    assert.match(h, /<h1 class="hero4__title"><span class="text-ink">One city\.<\/span> <span class="accent">One coin\.<\/span><\/h1>/, "the owner's words, exactly, the second line in the accent");
    // critique 18 (R1): "can get" (no city coin is live yet) and the holders' head start
    assert.match(h, /<p class="lead hero4__lead">Every real city can get one official coin, run by the people who live there\. \$VICINITY holders get in&nbsp;first\.<\/p>/);
    const cta = h.match(/<div class="hero4__cta" data-fb-avoid>([\s\S]*?)<\/div>/);
    assert.ok(cta, "one row of hero buttons, kept clear of the feedback button");
    const btns = [...cta[1].matchAll(/<a class="([^"]+)" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1], m[2], m[3].replace(/<[^>]+>/g, "|")]);
    assert.deepEqual(btns.map((b) => b[1]), ["/token#buy-slot", "/connect"], "Get $VICINITY to the buy slot (unchanged), Sign up to the sign-up");
    assert.equal(btns[0][0], "btn btn--primary btn--lg has-ring", "the page's one orange button, its ring under a mouse");
    assert.match(btns[0][2], /^Get \$VICINITY \|→\|$/);
    assert.equal(btns[1][0], "btn btn--glass btn--lg hero4__second", "the second button: glass, the same size");
    assert.match(cta[1], /<a class="btn btn--glass btn--lg hero4__second" href="\/connect" data-hero-second><span class="hero4__as-guest">Sign up<\/span><span class="hero4__as-member">My dashboard<\/span><\/a>/,
      "both labels in the button (a member sees My dashboard): it never changes width when /api/me answers");
    assert.equal(count(h, /href="\/token#buy-slot"/g), 1, "the call to buy is made once");
    assert.match(h, /<div class="tk" data-fb-avoid>\s*<div class="tk__pill">\s*<ul class="tk__bar" id="tk" aria-label="Live numbers" aria-live="off" aria-busy="true">/, "the bar is in the page from the first paint (its height reserved)");
    assert.equal(count(h, /<li class="tk__skel" aria-hidden="true"><span class="skel"><\/span><\/li>/g), 5, "five still placeholders until it is drawn");
    assert.match(h, /<p class="tk__src" id="tk-src"><\/p>/);
  }
  // centred, two lines at every width, one glow at the top, the entrance once and only with motion welcome
  assert.match(homeCss, /\.hero4 \{ position: relative; isolation: isolate; overflow: hidden; text-align: center;/);
  assert.match(homeCss, /\.hero4::before \{ content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var\(--grad-glow\); \}/);
  assert.match(homeCss, /\.hero4__title \{ font-size: var\(--fs-display\);/);
  assert.match(homeCss, /\.hero4__title > span \{ display: block; width: fit-content; margin: 0 auto;/, "each line its own box, as wide as its words");
  // the buttons stay side by side from 320 px (measured: the arrow leaves at 360 px and under), equally tall
  assert.match(homeCss, /\.hero4__cta \{ display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; width: 100%; \}/);
  assert.match(homeCss, /@media \(max-width: 360px\) \{ \.hero4__cta \.btn \{ padding-inline: 14px; font-size: \.95rem; \} \.hero4__cta \.btn > \[aria-hidden="true"\] \{ display: none; \} \}/);
  assert.match(homeCss, /\.hero4__second \{ display: inline-grid; place-items: center; \}\n\.hero4__second > span \{ grid-area: 1 \/ 1; \}/);
  assert.match(homeCss, /:root\[data-guest\] \.hero4__as-member, :root:not\(\[data-guest\]\) \.hero4__as-guest \{ visibility: hidden; \}/, "theme.js's guest mark picks the label before the first paint");
  assert.match(js, /window\.V\.ready\.then\(\(d\) => member\(Boolean\(d && d\.signedIn\)\)\);/);
  assert.match(js, /second\.href = yes \? "\/dashboard" : "\/connect";/, "the link goes where its label says");
});

test("home: no New York map, no pause control, no risk warning, no countdown, no sample coins (the owner's asks)", () => {
  for (const h of [homeSrc, home]) {
    const main = mainOf(h);
    assert.doesNotMatch(main, /hero-map|id="nyc"|nyc-map|<svg[^>]+role="img"[^>]+map|class="nyc|Open the live map on|grid-floor|hero__bg/, "no map card, no walkthrough, no grid floor");
    assert.doesNotMatch(main, /nyc-play|Pause|Play\b|data-motion/, "no pause / play anywhere on the page");
    assert.doesNotMatch(main, /financial advice|afford to lose|very risky|go to zero/i, "no risk warning in the home page (the Terms carry it; the site-entry modal is track F's)");
    assert.doesNotMatch(main, /data-countdown|Launchpad is open|\bLive\b</, "no countdown, nothing that reads like trading");
    assert.doesNotMatch(main, /coin-disc|LAGOS|TOKYO/, "no sample tickers presented as coins");
    assert.doesNotMatch(main, /class="orb|stars/);
  }
  assert.doesNotMatch(js, /demo-nyc|nyc-map|hero-map|setPlaying|vicinityTicker|innerHTML/, "home.js draws no map and writes no markup from data");
  assert.deepEqual(settings(homeSrc).scripts, ["home", "swap"], "the map's ticker helper is not loaded any more (swap.js keeps the FAQ's Buy wording)");
  assert.deepEqual(settings(homeSrc).styles, ["app-phone", "pages-home"]);
  assert.match(home, /<link rel="stylesheet" href="\/app-phone\.css">\n  <link rel="stylesheet" href="\/pages-home\.css">/, "the page's own sheet last");
});

test("home ticker (R1): every number from an existing API, an item without a value left out, drawn once with no shift, sources under it", () => {
  // the sources, and nothing else: the Launchpad list's $VICINITY card and coins, the token page's price while that list is off, the
  // members count, the build's stats file
  assert.deepEqual([...js.matchAll(/(?:api|get)\("([^"]+)"\)/g)].map((m) => m[1]).sort(), ["/api/launchpad", "/api/members", "/api/token", "/data/stats.json"]);
  assert.match(js, /const lp = await api\("\/api\/launchpad"\);\n\s+if \(lp && lp\.ok\) \{ answers\.lp = lp; answers\.lpAt = Date\.now\(\); return; \}/);
  for (const [key, re] of [
    ["price", /const price = lp \? num\(mk\.priceUsd\) : num\(tok && tok\.price\);\n\s+if \(price != null\) out\.push\(\{ key: "price", label: "\$VICINITY", text: money\(price\), chg: lp \? change\(mk\.priceChange24hPct\) : null, stale,/],
    ["mcap", /const mcap = lp \? num\(mk\.marketCapUsd\) : num\(tok && tok\.marketCap\);\n\s+if \(mcap != null\)/],
    ["vol", /const vol = lp \? num\(mk\.volume24hUsd\) : null;\n\s+if \(vol != null\)/],
    ["holders", /const holders = num\(vic && vic\.holders && vic\.holders\.count\);\n\s+if \(holders != null\)/],
    ["coins", /const live = lp && Array\.isArray\(lp\.coins\) \? lp\.coins\.filter\(\(c\) => c && c\.status === "live"\)\.length : null;\n\s+if \(live\)/],
    ["members", /const MEMBERS_MIN = 100;[\s\S]*if \(members != null && members >= MEMBERS_MIN\)/],
    ["communities", /if \(num\(st\.communities\)\) out\.push\(\{ key: "communities"/],
    ["countries", /if \(num\(st\.countries\)\) out\.push\(\{ key: "countries", label: "Countries & territories"/],
  ]) assert.match(js, re, key);
  assert.doesNotMatch(js, /\|\| 0\b|\?\? 0\b/, "never a 0 invented for a missing value");
  // the Launchpad cards' money rule ($0.000123 with three significant digits, $45.3K, $1.2M) and an arrow with the change (never colour alone)
  assert.match(js, /if \(a >= 1000\) return `\$\{sign\}\$\$\{compactFmt\.format\(a\)\}`;/);
  assert.match(js, /text: `\$\{n > 0 \? "▲ " : n < 0 \? "▼ " : ""\}\$\{a\.toFixed\(a >= 10 \? 1 : 2\)\}%`/);
  assert.match(js, /\(stale \? " · last good copy" : ""\)/, "a stale answer says so in the title, and shows the Delayed tag");
  // review of 13 Oct 2026: a source that keeps failing leaves its last answer up; past 3 minutes it is marked Delayed like a stale copy
  assert.match(js, /const STALE_MS = 3 \* 60 \* 1000;/);
  assert.match(js, /const at = lp \? a\.lpAt : tok \? a\.tokenAt : null, old = num\(at\) != null && Date\.now\(\) - at > STALE_MS;\n\s+const stale = Boolean\(\(lp && mk\.stale\) \|\| old\);/);
  // the market numbers are $VICINITY's own, not the network's: their titles and screen-reader labels name it; "live" is a recorded
  // contract, not a trade
  assert.match(js, /label: "Market cap", sr: "\$VICINITY ", text: money\(mcap\), title: said\(`\$VICINITY market cap /);
  assert.match(js, /label: "24h volume", sr: "\$VICINITY ", text: money\(vol\), title: said\(`\$VICINITY 24 h volume /);
  assert.match(js, /city \$\{live === 1 \? "coin" : "coins"\} live on the Vicinity Launchpad/);
  assert.doesNotMatch(js, /coins trade on the Vicinity Launchpad/);
  // drawn once (every source answered, or 2.5 s), never an item removed or added after that; a refresh only rewrites values
  assert.match(js, /Promise\.race\(\[Promise\.allSettled\(sources\), new Promise\(\(r\) => setTimeout\(r, 2500\)\)\]\)\.then\(\(\) => \{\n\s+draw\(\);/);
  assert.match(js, /if \(drawn \|\| !bar\) return;/);
  assert.match(js, /bar\.replaceChildren\(dot, \.\.\.lis\);/);
  const paint = js.slice(js.indexOf("function paint("), js.indexOf("const get = "));
  assert.doesNotMatch(paint, /remove\(|replaceChildren|append/, "a refresh never adds or removes an item: nothing moves");
  assert.match(js, /li\.className = `tk__item tk__item--\$\{it\.key\}` \+ \(i >= 5 \? " tk__item--more" : ""\) \+ \(i >= 4 \? " tk__item--p5" : ""\)/, "a computer shows the first five with a value, a phone the first four");
  assert.match(homeCss, /@media \(min-width: 768px\) \{ \.tk__item--more \{ display: none; \} \}/);
  // the counts count up once: followed by site.js's motion layer before the first value is written ("—" first; a price never counts from $0)
  assert.match(js, /val\.textContent = "—";/);
  assert.match(js, /if \(window\.V\.liveNums\) window\.V\.liveNums\(\[\.\.\.cells\.values\(\)\]\.map\(\(c\) => c\.val\)\);[^\n]*\n\s+paint\(list\);/);
  // only the API answers refresh, every 60 s, never in a hidden tab
  assert.match(js, /const refresh = \(\) => \{ if \(!drawn \|\| document\.hidden\) return;/);
  assert.match(js, /setInterval\(\(\) => \{ if \(Date\.now\(\) - last >= 59000\) refresh\(\); \}, 60000\);/);
  assert.doesNotMatch(js.slice(js.indexOf("const refresh")), /stats\.json/, "the stats file is fetched once");
  // the market sources' own attribution (Jupiter's terms), links only to the three market hosts, and every other source one tap away
  assert.match(js, /\/\^https:\\\/\\\/\(jup\\\.ag\|raydium\\\.io\|dexscreener\\\.com\)\(\\\/\|\$\)\/\.test\(x\.url\)/);
  assert.match(js, /all\.href = "\/credits"; all\.textContent = "All sources";/);
  assert.match(js, /else if \(market\) named\.push\(link\("Powered by Jupiter", "https:\/\/jup\.ag"\)\);/, "the token page's Jupiter price says Powered by Jupiter too");
  assert.match(js, /lead\.textContent = "\$VICINITY market data: ";/, "one short line that says whose market numbers these are");
  assert.match(js, /const SHORT = \{ "Jupiter": "Powered by Jupiter",/, "Jupiter's attribution, once (it named Jupiter twice)");
  // no layout shift: a fixed bar height from the first paint (the cells arrive all at once), the sources line holds its room
  assert.match(homeCss, /\.tk__bar \{ list-style: none; margin: 0; padding: 0 8px; display: flex; align-items: center; height: 54px; \}/);
  // a phone (review of 13 Oct 2026: the swiped strip cut "24h volu…" at its edge and took a focus it never showed): four numbers two by
  // two, nothing scrolls, nothing is cut; its height fixed from the first paint (two rows of 56 px)
  assert.match(homeCss, /\.tk__bar \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); grid-auto-rows: minmax\(56px, auto\); align-content: center; height: auto; min-height: 112px; padding: 0; \}/);
  assert.match(homeCss, /\.tk__skel:nth-child\(n\+6\), \.tk__item--p5 \{ display: none; \}/);
  assert.doesNotMatch(homeCss, /scroll-snap-type|overflow-x: auto/, "nothing on the home hero scrolls sideways");
  assert.match(homeCss, /\.tk__src \{ min-height: 3em;/);
  assert.doesNotMatch(homeCss + js, /marquee|scrollLeft\s*[+=]|scrollBy\(/, "no auto-scrolling marquee");
});

test("home: How it works (three cards, each one link), the app teaser (in development), the FAQ without the risk question", () => {
  for (const h of [homeSrc, home]) {
    const order = ['<section class="hero4" id="hero">', '<section class="section how4" id="how">', '<section class="section teaser4" id="app-teaser">', '<section id="faq" class="section faq4">'].map((s) => h.indexOf(s));
    assert.ok(order.every((i) => i >= 0), "every section");
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "hero, how it works, the app teaser, the FAQ");
    const how = h.slice(order[1], order[2]);
    const cards = [...how.matchAll(/<li class="card card--link how4__card">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    assert.equal(cards.length, 3);
    const pick = (c) => [c.match(/<h3>(.*?)<\/h3>/)[1].replace(/&nbsp;/g, " "), c.match(/<a class="how4__link" href="([^"]+)">/)[1]];
    assert.deepEqual(cards.map(pick), [["Find your city", "/cities"], ["Get in first", "/rules#supporters"], ["Launch its coin", "/launchpad"]]);
    // critique 18: the head start has a condition (the Launchpad snapshot), and the card says it
    assert.match(cards[1], /<p>Hold \$VICINITY through the Launchpad snapshot to buy new city coins before the public\.<\/p>/);
    assert.doesNotMatch(how.replace(/<[^>]+>/g, "").replace(/\b0[1-3]\b/g, ""), /\d/, "no number in the cards (the 01-03 are decoration)");
    const teaser = h.slice(order[2], order[3]);
    assert.match(teaser, /<span class="tag tag--gold">In development<\/span>/, "never presented as available");
    assert.match(teaser, /<p class="teaser4__line">Coming: send and receive city coins and \$VICINITY from your phone\.<\/p>/, "critique 19");
    assert.match(teaser, /<a class="teaser4__link" href="\/app">See the preview/);
    assert.match(teaser, /<div class="teaser4__stage" aria-hidden="true">/, "the phone is decoration here");
    assert.doesNotMatch(teaser.replace(/<[^>]+>/g, ""), /\d/, "no number on the teaser's phone (R1)");
    assert.doesNotMatch(teaser, /App Store|Google Play|Download/i);
  }
  // the FAQ: three tabs, every question of before but "Is this financial advice?" (the owner; the Terms carry it), the ids links use
  const faq = home.slice(home.indexOf('<section id="faq"'));
  const questions = [...faq.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.deepEqual(questions, [
    "What is Vicinity?", "How do I buy $VICINITY?", "Why did $VICINITY launch on Raydium LaunchLab and not on the Vicinity Launchpad?", "How do I get my dashboard?", "I use FOMO (or another app wallet). How do I connect?",
    "How do I become a City Founder?", "Who is the Country Manager?", "Can a whale take over?", "What happens if I sell?", "What if I don't live inside any city?",
    "Is this a rug pull?", "Which contract address is real?", "What do you store about me?", "Can someone fake their location?",
  ]);
  for (const id of ["faq-tabs", "buy-faq", "why-launchlab", "faq-basics", "faq-founders", "faq-safety"]) assert.equal(count(home, new RegExp(`id="${id}"`, "g")), 1, id);
  assert.match(js, /e\.key === "ArrowRight" \? i \+ 1 : e\.key === "ArrowLeft" \? i - 1 : e\.key === "Home" \? 0 : e\.key === "End" \? tabs\.length - 1 : null/, "arrow keys move between tabs");
  assert.match(js, /window\.addEventListener\("hashchange", \(\) => \{ if \(!oldLink\(\)\) openFor\(location\.hash\); \}\);/, "/#why-launchlab opens its tab, then the question");
  assert.match(homeCss, /\.faq4 \.faq \{ max-width: 760px; margin: 0 auto; \}/, "one calm column");
});

test("home: old one-page links land where the thing lives now, never on a dead anchor", () => {
  assert.match(js, /const NYC = "\/cities\?city=5128581";/);
  assert.match(js, /"#nyc": NYC, "#story": NYC, "#demo": NYC, "#roles": "\/dashboard#roles", "#get": "\/token#buy-slot" \};/, "critique 21");
  for (const [from, to] of [["#token", "/token"], ["#holders", "/token#holders"], ["#wallet", "/connect"], ["#cities", "/cities"], ["#launchpad", "/launchpad"], ["#check", "/token#check"]]) assert.ok(js.includes(`"${from}": "${to}"`), from);
  assert.match(js, /const GONE = \["#why", "#why-now", "#for-cities", "#problem", "#roadmap"\];/);
  assert.match(js, /if \(GONE\.includes\(location\.hash\)\) \{ history\.replaceState\(history\.state, "", location\.pathname \+ location\.search\); return true; \}/);
  assert.match(js, /if \(oldLink\(\) && location\.hash\) return;/, "a link that moved leaves before anything else runs");
  assert.match(js, /window\.addEventListener\("hashchange", \(\) => \{ if \(!oldLink\(\)\) openFor\(location\.hash\); \}\);/, "an old link typed into the open page too");
  assert.ok(home.includes('id="how"'), "#how is this page's How it works");
});

test("/app (prompt item 6): an early look at the app, labelled in development first, no number, no store, no date (R1)", () => {
  assert.deepEqual(settings(appSrc), { title: "App preview", description: "The Vicinity mobile app is in development: an early look at sending and receiving city coins and $VICINITY on your phone.", page: "app", scripts: ["app"], styles: ["app-phone", "pages-app"] });
  for (const h of [appSrc, app]) {
    const main = mainOf(h);
    const tag = main.indexOf('<p class="app4-hero__tag"><span class="tag tag--gold">In development</span></p>'), h1 = main.indexOf("<h1");
    assert.ok(tag > 0 && tag < h1, "\"In development\" is the first thing the page says");
    assert.match(main, /<h1 class="page-title app4-hero__title"><span class="text-ink">Vicinity,<\/span> <span class="accent">in your pocket\.<\/span><\/h1>/);
    assert.match(main, /<p class="lead app4-hero__lead">Send and receive city coins and \$VICINITY from your phone\. We're building the app now; this page is an early look at the design\.<\/p>/);
    assert.doesNotMatch(main.replace(/<[^>]+>/g, " "), /App Store|Google Play|Play Store|Download|Install|coming (soon|in|on) [A-Z0-9]|20\d\d/i, "no store badge, no download, no date (in the words people read)");
    assert.doesNotMatch(main, /apps\.apple\.com|play\.google\.com|\.apk\b/i, "no store link");
    // three phones, each a labelled picture (never controls), a caption that says what it is
    const phones = [...main.matchAll(/<div class="phone4" role="img" aria-label="(Design preview of the (\w+) screen[^"]*)">([\s\S]*?)<\/figure>/g)];
    assert.deepEqual(phones.map((m) => m[2]), ["Wallet", "Send", "Receive"]);
    for (const [, , name, body] of phones) {
      assert.doesNotMatch(body.replace(/<[^>]+>/g, " "), /\d/, `${name}: no number on the screen (an amount is a still bar)`);
      assert.doesNotMatch(body, /<(a|button|input|select|textarea)\b|tabindex/, `${name}: nothing to focus or press`);
      assert.match(body, new RegExp(`<figcaption>Design preview · ${name}</figcaption>`));
    }
    assert.match(main, /<span class="pm-field pm-field--ph">Wallet address<\/span>/, "critique 19: sending to a @username is not decided");
    assert.doesNotMatch(main, /@username/);
    assert.match(main, /<div class="pm-qr"><svg viewBox="0 0 25 25" aria-hidden="true"/, "a decorative pattern, hidden from screen readers");
    assert.match(main, /<div class="app4-dots" aria-hidden="true">/);
    // what it is for (two lines, nothing undecided), and what works today
    assert.deepEqual([...main.matchAll(/<li class="card"><span class="ico" aria-hidden="true">[\s\S]*?<\/span><span>(.*?)<\/span><\/li>/g)].map((m) => m[1].replace(/&nbsp;/g, " ")),
      ["Send and receive city coins and $VICINITY", "Your city's coin, one tap away"]);
    // critique 19: nothing sends or receives today; review of 13 Oct 2026: no city coin may be live yet (each is bought as it launches),
    // and a computer is not a phone
    assert.match(main, /<p>Until then, buy \$VICINITY right here in your browser, and each city coin as it launches\.<\/p>/, "critique 19: nothing sends or receives today");
    assert.doesNotMatch(main, /phone's browser/);
    assert.doesNotMatch(main, /everything works in your phone|Two minutes/);
    assert.match(main, /<a class="btn btn--primary btn--lg has-ring app4-hero__first" href="\/connect" data-app-first><span class="app4__as-guest">Sign up<\/span><span class="app4__as-member">My dashboard<\/span><\/a>/);
  }
  // a computer fans the phones out in 3D; the middle one leans toward a mouse only (rAF, transform only, never with reduced motion)
  assert.match(appCss, /\.app4-fig--l \.app4-tilt \{ transform: perspective\(1200px\) rotateY\(18deg\) translateZ\(-60px\);/);
  assert.match(appCss, /\.app4-fig--r \.app4-tilt \{ transform: perspective\(1200px\) rotateY\(-18deg\) translateZ\(-60px\);/);
  assert.match(appCss, /scroll-snap-type: x mandatory;/, "a phone swipes through them");
  assert.match(appJs, /const fine = window\.matchMedia\("\(hover: hover\) and \(pointer: fine\) and \(min-width: 1024px\)"\);/);
  assert.match(appJs, /if \(!fine\.matches \|\| still\.matches \|\| e\.pointerType !== "mouse"\) return;/);
  assert.match(appJs, /if \(!frame\) frame = requestAnimationFrame\(put\);/);
  assert.doesNotMatch(appJs, /innerHTML|setInterval/);
});

test("the phone mock-up is one recipe for both pages, and the three sheets keep the rules (no import, no outside address, motion only when welcome, nothing loops)", () => {
  for (const [name, css] of [["pages-home.css", homeCss], ["pages-app.css", appCss], ["app-phone.css", phoneCss]]) {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(body, /@import|@font-face|!important|url\(/, `${name}: self-contained`);
    assert.doesNotMatch(body, /https?:\/\//, name);
    assert.doesNotMatch(body, /infinite/, `${name}: nothing loops`);
    // every animation and transition sits in a block that asks for motion
    const outside = body.replace(/@media [^{]*prefers-reduced-motion: no-preference[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").replace(/@keyframes \w+ \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    assert.doesNotMatch(outside, /animation\s*:|transition\s*:/, `${name}: motion only with prefers-reduced-motion: no-preference`);
    for (const kf of body.matchAll(/@keyframes \w+ \{([\s\S]*?\})\s*\}/g)) for (const p of kf[1].matchAll(/([a-z-]+)\s*:/g)) assert.ok(["transform", "opacity"].includes(p[1]), `${name}: ${p[1]} in a keyframe`);
  }
  assert.match(phoneCss, /\.phone4 \{ --pw: 280px;/);
  assert.doesNotMatch(homeCss + appCss, /(^|\n)\.phone4 \{|(^|\n)\.pm-[a-z-]+ \{/, "the frame and the screens are drawn in app-phone.css only (the pages only size them)");
  assert.match(home, /<div class="phone4 teaser4__phone">/);
  assert.equal(count(app, /<div class="phone4" role="img"/g), 3);
});
