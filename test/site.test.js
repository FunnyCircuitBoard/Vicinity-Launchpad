import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { buildPages, buildStandalonePages } from "../scripts/pages/build.mjs";
import { openPage } from "./helpers/pagedom.js";
import { cityAt } from "../src/geo.js";

const read = (p) => readFileSync(new URL("../public/" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PAGES = ["index.html", "token.html", "cities.html", "launchpad.html", "coin.html", "connect.html", "locate.html", "dashboard.html", "rules.html", "terms.html", "404.html", "admin.html", "app.html", "credits.html", "official.html"];
const html = Object.fromEntries(PAGES.map((p) => [p, read(p)]));
const all = Object.values(html).join("\n");
const css = read("style.css");

test("every page is built from scripts/pages (edit those, then npm run pages)", () => {
  const built = new Map(buildPages());
  assert.deepEqual([...built.keys()].sort(), [...PAGES].sort());
  for (const [f, out] of built) assert.equal(html[f], out, `${f} is out of date: run npm run pages`);
});

test("pages load nothing from other websites (privacy + security)", () => {
  // Links people click are fine; files a page LOADS (scripts, styles, images, fonts) must be ours.
  for (const [f, h] of Object.entries(html)) {
    const loads = [...h.matchAll(/<(?:script|img|link|iframe|source)\b[^>]*>/g)].map((m) => m[0]);
    assert.deepEqual(loads.filter((tag) => /(src|href)="(https?:)?\/\//.test(tag)), [], f);
  }
});

test("no inline scripts or inline styles (blocked by our security policy), no links to the code", () => {
  assert.doesNotMatch(all, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(all, /\sstyle="/);
  assert.doesNotMatch(all, /<style[\s>]/, "an inline <style> block is blocked by the security policy: use a stylesheet file");
  assert.doesNotMatch(all, /\son[a-z]+="/);
  assert.doesNotMatch(all, /github\.com/i);
});

test("every local file a page references exists", () => {
  for (const [f, h] of Object.entries(html)) {
    for (const [, p] of h.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)) {
      if (p.startsWith("/api/") || p === "/official-coins.csv") continue; // answered by the Worker (wrangler.jsonc run_worker_first), not a file
      const file = p.endsWith("/") ? p + "index.html" : /\.[a-z0-9]+$/.test(p) ? p : p + ".html";
      assert.ok(existsSync(new URL("../public" + file, import.meta.url)), `${f}: missing ${p}`);
    }
  }
});

test("same menu on every page: the floating header for computers (4 links), the tab bar for phones (5 tabs), the theme toggle, Log in and Sign up", () => {
  // design v4 (prompt item 1): the header's links are only Launchpad, Live map, App preview, Dashboard; the phone tab bar keeps the five
  // tasks (Home, Launchpad, Map, Token, Me); the brand is the way home on a computer
  const headerLinks = ["/launchpad", "/cities", "/app", "/dashboard"], tabLinks = ["/", "/launchpad", "/cities", "/token", "/dashboard"];
  const inHeader = { "launchpad.html": "/launchpad", "coin.html": "/launchpad", "cities.html": "/cities", "app.html": "/app", "dashboard.html": "/dashboard" };
  const inTabs = { "index.html": "/", "launchpad.html": "/launchpad", "coin.html": "/launchpad", "cities.html": "/cities", "token.html": "/token", "dashboard.html": "/dashboard" };
  for (const [f, h] of Object.entries(html)) {
    const header = h.match(/<header class="site-header" data-header>[\s\S]*?<\/header>/)[0];
    const nav = header.match(/<nav class="nav" aria-label="Main">[\s\S]*?<\/nav>/)[0], tabs = h.match(/<nav class="tabbar" aria-label="Main \(phone\)">[\s\S]*?<\/nav>/)[0];
    assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), headerLinks, f);
    assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]), ["Launchpad", "Live map", "App preview", "Dashboard"], f);
    assert.deepEqual([...tabs.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), tabLinks, f);
    assert.deepEqual([...tabs.matchAll(/<span>([^<]+)<\/span><\/a>/g)].map((m) => m[1]), ["Home", "Launchpad", "Map", "Token", "Me"], f);
    assert.deepEqual([...nav.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((m) => m[1]), inHeader[f] ? [inHeader[f]] : [], `${f}: the current page in the header`);
    assert.deepEqual([...tabs.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((m) => m[1]), inTabs[f] ? [inTabs[f]] : [], `${f}: the current tab`);
    assert.equal((tabs.match(/class="tabbar__ind"/g) || []).length, inTabs[f] ? 1 : 0, `${f}: one glide pill, on the current tab only`);
    assert.match(header, /<a class="brand" href="\/" aria-label="Vicinity home">/, f);
    assert.doesNotMatch(header, /data-nav-launch|nav__soon|nav__open/, `${f}: the "Oct 10 / Open" chip is gone`);
    assert.match(h, /data-theme-toggle/);
    assert.match(h, /<script src="\/theme\.js"><\/script>\s*<\/head>/, `${f}: theme runs before paint`);
    assert.match(header, /<a class="btn btn--ghost btn--sm account-btn" href="\/connect\?mode=login" data-account><span class="btn__dot" aria-hidden="true"><\/span><span data-account-label>Log in<\/span><\/a>/, `${f}: signed-out visitors see a Log in button`);
    assert.match(header, /<a class="btn btn--primary btn--sm hdr-signup has-ring" href="\/connect" data-signup>Sign up<\/a>/, `${f}: and one orange Sign up (an account is made without a wallet: never "Connect wallet")`);
    assert.doesNotMatch(h, /data-logout|account-out/, `${f}: one account button in the header; Log out lives in the profile and in the avatar's account sheet`);
  }
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /\.tabbar \{ display: grid;/);
  // Sign up: hidden before the first paint for a browser that has shown a member here (theme.js data-guest), shown again by site.js once
  // signed out; hidden for a member and for a sign-in in progress; never on /connect (the page is the sign-up)
  assert.match(css, /:root:not\(\[data-guest\]\) \[data-signup\]:not\(\.is-shown\), body\[data-page="connect"\] \[data-signup\] \{ display: none; \}/);
  const site = read("site.js");
  assert.match(site, /signup\.hidden = Boolean\(d && \(d\.signedIn \|\| d\.pending\)\);\n\s+if \(!signup\.hidden\) signup\.classList\.add\("is-shown"\);/);
  // the floating header: a stronger glass once the page scrolls, from a 1 px marker (no scroll listener)
  assert.match(site, /new IntersectionObserver\(\(\[en\]\) => head\.classList\.toggle\("is-scrolled", !en\.isIntersecting\)\)\.observe\(mark\);/);
  assert.doesNotMatch(site, /addEventListener\("scroll"/);
  // the header's hairline is a shadow, not a border: polish-dash.css clears the header's bottom border on the dashboard, and the
  // floating pill must keep all four edges there
  const head = /\n\.site-header \{([^}]*)\}/.exec(css)[1];
  assert.match(head, /box-shadow: inset 0 0 0 1px var\(--glass-border\), var\(--glass-hi\);/);
  assert.doesNotMatch(head, /border(-bottom)?:/);
});

test("footer socials come from src/official.js (rule R3): a network added there shows as an icon on the next build, a link is https only", async () => {
  const { SOCIAL_PROFILES } = await import("../src/official.js");
  const footerOf = (pages) => new Map(pages).get("index.html").match(/<ul class="site-footer__social"[\s\S]*?<\/ul>/)[0];
  const before = footerOf(buildPages());
  assert.equal((before.match(/<li>/g) || []).length, SOCIAL_PROFILES.length, "one icon per official account, no placeholder");
  SOCIAL_PROFILES.push({ network: "Telegram", handle: "@vicinity_example", hosts: ["t.me", "telegram.me"] }, { network: "Mastodon", handle: "@vicinity", hosts: ["mastodon.social"] });
  try {
    const after = footerOf(buildPages());
    assert.match(after, /<a class="social-link" href="https:\/\/t\.me\/vicinity_example" target="_blank" rel="noopener me" aria-label="Vicinity on Telegram \(@vicinity_example\), opens in a new tab"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M11\.944 0A12/);
    assert.match(after, /aria-label="Vicinity on Mastodon \(@vicinity\), opens in a new tab"><span class="social-link__name">Mastodon<\/span><\/a>/, "a network without an icon shows its name, never dropped");
    SOCIAL_PROFILES.push({ network: "Web", handle: "@x", hosts: ["x.example"], url: "http://x.example/" });
    assert.throws(() => buildPages(), /needs an https:\/\/ address/);
  } finally { SOCIAL_PROFILES.splice(1); }
  assert.equal(footerOf(buildPages()), before);
});

test("the /app and /credits pages: an honest app teaser label, and every map data licence kept (R2)", () => {
  const app = html["app.html"], credits = html["credits.html"];
  assert.match(app, /<p class="app4-hero__tag"><span class="tag tag--gold">In development<\/span><\/p>/, "the app is never presented as available (test/home-v4.test.js pins the page)");
  assert.doesNotMatch(app, /App Store|Google Play|Download/i);
  assert.match(credits, /<h1 class="page-title">Data &amp; credits<\/h1>/, "the full credits: the next test");
});

test("/credits (R2): every licence the map's data asks for, with its version and change notices, the market sources, the fonts' licences; outside links open in a new tab and say so", () => {
  const c = html["credits.html"], main = c.slice(c.indexOf("<main"), c.indexOf("</main>"));
  const text = main.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
  // OpenStreetMap: ODbL 1.0, and the derived database this site serves (ODbL 4.4)
  assert.match(main, /© <a href="https:\/\/www\.openstreetmap\.org\/copyright" target="_blank" rel="noopener">OpenStreetMap contributors<span class="sr-only"> \(opens in a new tab\)<\/span><\/a>, available under the <a href="https:\/\/opendatacommons\.org\/licenses\/odbl\/" target="_blank" rel="noopener">Open Database License 1\.0/);
  assert.match(text, /\(ODbL 1\.0\)\. Vicinity simplifies these boundaries\. The simplified city boundaries this site serves \(\/data\/bounds\/\) are derived from OpenStreetMap and are available under the Open Database License 1\.0\./);
  // GeoNames: CC BY 4.0, a link to the licence, and what was changed
  assert.match(text, /GeoNames \(opens in a new tab\) \(geonames\.org\), licensed under Creative Commons Attribution 4\.0 \(opens in a new tab\) \(CC BY 4\.0\)\. Vicinity groups these places into communities\./);
  assert.match(main, /href="https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/"/);
  assert.match(text, /Country outlines Natural Earth \(opens in a new tab\) \(public domain\)\./);
  // the market sources (Jupiter's terms ask for "Powered by Jupiter" wherever its data shows)
  assert.match(text, /Prices, market caps and volumes Jupiter \(opens in a new tab\) \(Powered by Jupiter\), Raydium \(opens in a new tab\) and DEX Screener \(opens in a new tab\)\./);
  assert.match(text, /Holders and bonding curves The Solana chain, read and counted by vicinity\.city\./);
  // the fonts' own licence files (copied next to the fonts by copy-assets) and the QR library's
  assert.match(main, /SIL Open Font License 1\.1: <a href="\/fonts\/LICENSE-inter\.txt">Inter licence<\/a> · <a href="\/fonts\/LICENSE-space-grotesk\.txt">Space Grotesk licence<\/a>/);
  assert.match(read("../scripts/copy-assets.mjs"), /copyFileSync\(join\(dir, "LICENSE"\), join\(pub\("fonts\/"\), `LICENSE-\$\{name\}\.txt`\)\);/);
  assert.match(text, /qrcode-generator, © Kazuhiko Arase, under the MIT licence\./);
  // every outside link: https to the source itself, a new tab without an opener, and a screen reader is told
  const ext = [...main.matchAll(/<a href="(https:[^"]+)"([^>]*)>([\s\S]*?)<\/a>/g)];
  assert.equal(ext.length, 8);
  for (const [, href, attrs, inner] of ext) {
    assert.equal(attrs, ' target="_blank" rel="noopener"', href);
    assert.match(inner, /<span class="sr-only"> \(opens in a new tab\)<\/span>$/, href);
    assert.match(new URL(href).hostname, /^(www\.)?(openstreetmap\.org|opendatacommons\.org|geonames\.org|creativecommons\.org|naturalearthdata\.com|jup\.ag|raydium\.io|dexscreener\.com)$/, href);
  }
  // no risk warning here either; the page's own small sheet, last
  assert.doesNotMatch(text, /financial advice|afford to lose|very risky/i);
  assert.match(c, /<link rel="stylesheet" href="\/pages-credits\.css">\n  <script src="\/theme\.js"><\/script>/);
  const sheet = read("pages-credits.css");
  assert.doesNotMatch(sheet, /@import|@font-face|!important|https?:\/\/|animation|transition/, "a calm page: nothing loaded, nothing moves");
  assert.ok(sheet.length < 4000, "a small sheet");
});

test("V.burst: eight small accent dots, never emoji, nothing with reduced motion; the callers' signature stays", () => {
  const js = read("site.js");
  const burst = js.slice(js.indexOf("  const burst = (x, y) => {"), js.indexOf("  };", js.indexOf("  const burst = (x, y) => {")));
  assert.match(burst, /if \(reducedNow\(\)\) return;/);
  assert.match(burst, /for \(let i = 0; i < 8; i\+\+\) \{\n\s+const s = el\("span", "burst"\);/);
  assert.doesNotMatch(burst, /\p{Extended_Pictographic}/u, "no emoji confetti");
  assert.match(css, /\.burst \{ position: fixed; pointer-events: none; z-index: 80; width: 6px; height: 6px;[^}]*border-radius: 50%;[^}]*opacity: 0; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{ \.burst \{ animation: burst \.6s var\(--ease-out\) forwards; \} \}/);
  assert.match(js, /window\.V = \{[^}]*\bburst\b/, "V.burst(x, y) stays for connect.js, signup.js, dashboard.js and swap.js");
});

test("no site-entry Terms modal (design v4, the owner's ask): no page carries one, every page links the Terms, /terms keeps its inline agree", () => {
  for (const [f, h] of [...Object.entries(html), ...buildStandalonePages()]) {
    assert.doesNotMatch(h, /termsgate|Agree to the Terms of Use|Before you enter/, `${f}: no site-entry Terms modal`);
    assert.match(h, /<nav class="site-footer__links"[^>]*>\s*<a href="\/terms">Terms<\/a>/, `${f}: the footer links the Terms of Use (they bind every visit)`);
  }
  assert.match(html["terms.html"], /<button[^>]*id="terms-agree"/, "the Terms page keeps its inline agree button");
});

test("the Terms in site.js: no gate code left; V.termsGate keeps its two methods for signup.js and connect.js (open does nothing, agreed notes the version)", () => {
  const js = read("site.js");
  assert.doesNotMatch(js, /#termsgate|termsgate-|deferGate|gateLater|openGate|\.inert = true/, "no site-entry gate code, nothing made inert");
  assert.doesNotMatch(js, /style\.overflow\s*=\s*["']hidden["']/, "nothing freezes page scrolling");
  const gate = js.slice(js.indexOf("  const termsGate = {"), js.indexOf("  window.V = {"));
  assert.match(gate, /^  const termsGate = \{\n    open\(\) \{\},\n    agreed\(version\) \{ try \{ if \(version\) localStorage\.setItem\("vicinity_terms", version\); \} catch/);
  assert.match(js, /window\.V = \{[^}]*\btermsGate\b/, "V.termsGate stays: signup.js and connect.js call it unchanged");
  for (const f of ["signup.js", "connect.js"]) assert.match(read(f), /window\.V\.termsGate/, `${f} still tells it (no change there)`);
});

test("/terms: the inline 'I agree' notes the version in this browser and, for a member, records it on the account (/api/me/terms)", async () => {
  for (const signedIn of [false, true]) {
    const p = await openPage("terms.html", { me: signedIn ? { ok: true, signedIn, user: { id: 7, handle: "Sam", wallet: null } } : { ok: true, signedIn } });
    assert.equal(p.$("#termsgate"), null);
    const agree = p.$("#terms-agree");
    agree.click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(p.storage.get("vicinity_terms"), "2026-10-01", `${signedIn}: noted here`);
    assert.equal(agree.disabled, true); assert.equal(agree.textContent, "Agreed ✓");
    assert.deepEqual(p.calls.filter((c) => c.path === "/api/me/terms").map((c) => c.body), signedIn ? [{ version: "2026-10-01" }] : [], `${signedIn}: recorded on the account only for a member`);
  }
  // any other page: nothing pops up, nothing is noted, nothing is asked of the server
  const home = await openPage("index.html");
  assert.equal(home.storage.get("vicinity_terms"), undefined);
  assert.deepEqual(home.calls.filter((c) => c.path === "/api/me/terms"), []);
  assert.deepEqual(home.doc.body.children.filter((e) => e.inert).map((e) => e.id || e.tagName), [], "nothing inert");
  assert.equal(home.doc.activeElement, home.doc.body, "the keyboard starts at the top of the page, not in a dialog");
});

test("the sign-up still binds the Terms (R4): the box and the server's terms_required stay", () => {
  const connect = html["connect.html"];
  assert.match(connect, /id="su-terms"/, "the sign-up's own Terms box");
  for (const f of ["../src/signup.js", "../src/signup-finish.js"]) assert.match(readFileSync(new URL(f, import.meta.url), "utf8"), /terms_required/, `${f}: an account is never made without the Terms`);
});

test("terms page: the full Terms of Use", () => {
  const h = html["terms.html"];
  for (const s of ["1. Introduction", "4. Eligibility", "13. Warranty Disclaimer", "14. Limitation of Liability",
                   "16. Dispute Resolution", "Class Action Waiver", "19. Contact", "@VicinityCitySOL"]) {
    assert.ok(h.includes(s), `terms mention: ${s}`);
  }
  assert.doesNotMatch(css, /\.termsgate/, "the site-entry modal's styles are gone with it (design v4)");
  assert.match(css, /\.terms h2/, "terms page styles exist");
  assert.match(css, /\.terms \.agreebox \{/, "the Terms page's own agree box keeps its styles");
});

test("profile: the pass shows no real name, and the header's one avatar is the way to Profile, Account and Settings", () => {
  const js = read("dashboard.js");
  const loginLine = js.split("\n").find((l) => l.includes("[data-me-login]") && l.includes("textContent"));
  assert.ok(loginLine && !loginLine.includes("u.name"), "the sign-in line never interpolates the real name");
  assert.ok(js.includes("PROVIDER_LABEL"), "the pass shows the sign-in method label only");
  const h = html["dashboard.html"];
  assert.ok(!h.includes('id="profile-open"'), "no profile button on the pass — the header's avatar is the profile entry");
  assert.match(h, /id="profile-modal"/, "profile modal");
  assert.match(h, /id="username-form"/, "username change form");
  assert.match(h, /id="email-form"/, "e-mail add form");
  assert.match(h, /id="phone-form"/, "phone form");
  assert.match(h, /id="profile-logout"/, "log out in the profile section");
  assert.ok(h.includes("Help &amp; support"), "help & support section");
  // dashboard exposes the opener; the header button calls it on the dashboard
  assert.ok(js.includes("window.V.openProfile = openProfile"), "dashboard exposes openProfile");
  assert.ok(js.includes('"#profile"'), "dashboard opens the profile on the #profile hash");
  // the header (owner, 17 Oct 2026): one avatar, no username pill; its sheet goes to the profile (in place on the dashboard)
  const site = read("site.js");
  assert.match(h, /<a class="acct__link" href="\/dashboard#profile" data-acct-go="profile">/, "the account sheet points at the profile");
  assert.ok(site.includes("Profile, account and settings"), "the avatar is labeled as the way to the profile, the account and the settings");
  assert.ok(site.includes("window.V.openProfile"), "the sheet opens the profile in place on the dashboard");
  assert.doesNotMatch(site, /label\.textContent = who/, "the username is never written into the header");
  assert.match(css, /\.profile__sec/, "profile styles exist");
  assert.match(css, /\.icon-btn/, "profile icon button styles exist");
});

test("home (design v4): the hero, How it works, the app teaser, the FAQ; the honest launch story; no risk warning in the page", () => {
  const h = html["index.html"], main = h.slice(h.indexOf('<main id="main"'), h.indexOf("</main>"));
  for (const id of ["hero", "how", "app-teaser", "faq", "faq-tabs", "buy-faq", "why-launchlab"]) assert.ok(h.includes(`id="${id}"`), id);
  for (const gone of ["problem", "nyc", "nyc-map", "why-now", "why", "get", "roles", "roadmap"]) assert.ok(!h.includes(`id="${gone}"`), `#${gone} left with the old page (home.js sends its old links on)`);
  assert.match(h, /Why did \$VICINITY launch on Raydium LaunchLab and not on the Vicinity Launchpad\?/);
  assert.doesNotMatch(h, /stonkfun|stonfun/i, "launching on Raydium LaunchLab");
  assert.match(h, /How do I buy \$VICINITY\?/);
  assert.match(h, /href="\/token#buy-slot"/);
  assert.doesNotMatch(h, /pump\.fun/i, "not pump.fun");
  assert.doesNotMatch(h, /first to claim/i, "founders are chosen by locals, not a race");
  assert.match(h, /FOMO/);
  // the owner (12 Oct 2026): "remove the risk warnings ... and similar": none in the page (the Terms carry them)
  assert.doesNotMatch(main, /financial advice|afford to lose|very risky/i);
  assert.doesNotMatch(h, /financial advice|afford to lose|very risky/i, "nor anywhere in the built page: the site-entry modal is gone (track F)");
  assert.doesNotMatch(h, /Maple Falls|Port Jasper|Cedar Bay/, "no more fictional demo towns");
  // the New York example data stays (the build makes it, /cities?city=5128581 is where the old #nyc link lands)
  const nyc = JSON.parse(read("data/demo-nyc.json"));
  assert.ok(nyc.members.length > 30 && nyc.official.length && nyc.nyc.area.length && nyc.neighbors.length > 5);
  assert.ok(nyc.members.some(([name]) => name === "Brooklyn"));
  // New York City keeps only its five boroughs: nobody's city is folded into $NYC
  for (const n of ["Newark", "Jersey City", "Yonkers", "Paterson", "Hempstead"]) assert.ok(!nyc.members.some(([name]) => name === n), `${n} isn't part of $NYC`);
  for (const n of ["Newark", "Yonkers", "Paterson"]) assert.ok(nyc.neighbors.some((x) => x.name === n), `${n} has its own coin`);
  const stats = JSON.parse(read("data/stats.json"));
  assert.ok(stats.communities > 1000 && stats.countries > 200);
});

test("Long Island has a coin everywhere people live (no empty land from Hicksville to Montauk)", () => {
  const us = read("data/bounds/US.txt");
  const spots = { Hicksville: [-73.525, 40.768], Plainview: [-73.467, 40.776], Massapequa: [-73.474, 40.681], Bethpage: [-73.48, 40.744],
    Huntington: [-73.426, 40.868], Shirley: [-72.867, 40.801], Riverhead: [-72.662, 40.917], Southampton: [-72.39, 40.884], Montauk: [-71.95, 41.035] };
  for (const [name, [lon, lat]] of Object.entries(spots)) assert.ok(cityAt(us, lon, lat), `${name} has no community`);
});

test("token page: live facts on top, holders in a scrolling table with the rank check in its find box, official list, FAQ", () => {
  const h = html["token.html"];
  for (const id of ["token", "contract", "buy", "lnk-raydium", "verify", "lookup", "rank-pop", "holders", "holders-scroll", "holders-table", "check", "checker", "faq"]) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /No rug pull/);
  assert.match(h, /Buy on Raydium/);
  assert.doesNotMatch(h, /pump\.fun|stonkfun|stonfun/i, "launching on Raydium LaunchLab");
  assert.match(read("token.js"), /https:\/\/raydium\.io\/launchpad\/token\/\?mint=\$\{m\}/, "buy link goes to the real raydium.io");
  assert.match(css, /\.holders--live \.table-scroll \{ height: clamp\(320px, 60vh, 640px\); \}/, "the live holder list is a box of fixed height that scrolls on its own");
  assert.match(css, /\.holders__table thead th \{ position: sticky;/);
});

test("cities page: live map, claimed vs open, claiming sends you to the dashboard, rules stated plainly", () => {
  const h = html["cities.html"];
  // d3 (11 Oct 2026): one search on the page, the map's (#map-find-q; the list's #city-q is gone); "still open" (#cs-open) is gone
  for (const id of ["cities", "city-canvas", "map-in", "map-out", "map-reset", "map-locate", "map-find-q", "map-find-loc", "coin-preview", "coin-ticker", "claim-feed", "mod-row", "city-country", "cs-claimed", "cs-official", "wanted-list"]) assert.ok(h.includes(`id="${id}"`), id);
  for (const id of ["city-q", "cs-open"]) assert.ok(!h.includes(`id="${id}"`), `${id} is gone`);
  assert.match(h, /<a class="btn btn--primary btn--block" id="claim-btn" href="\/dashboard">/);
  assert.match(h, /One wallet\. One city\./);
  assert.match(h, /100,000 to 1,000,000 \$VICINITY/, "the Stake Ladder, not a flat 1M");
  assert.doesNotMatch(h, /Hold 1,000,000\+/);
  assert.match(h, /We never save it/);
  assert.match(h, /VPNs are blocked/);
  assert.match(h, /Sample only/);
  assert.match(h, /id="map-style"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(h, /satellite/i);
  const order = [...h.matchAll(/<script src="\/([a-z/]+)\.js"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["theme", "site", "ticker", "cities", "feedback"]);
});

test("launchpad: the tagline, one button that signs people up, the coins and the Founding Supporter checker (design v4: no countdown, no date)", () => {
  const h = html["launchpad.html"];
  for (const id of ["lp-create", "lp-coins", "lp-grid", "supporters", "snap-form"]) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /<a class="btn btn--primary btn--lg btn--cta-glow has-ring lp4-hero__cta" href="\/connect" id="lp-create" data-create-coin>Create your city coin<\/a>/);
  // the Launchpad opened on 10 Oct 2026: the countdown, its date line and the calendar file went with the owner's "get rid of the rest"
  for (const id of ["countdown", "lp-bar", "lp-cal", "lp-date"]) assert.ok(!h.includes(`id="${id}"`), id);
  assert.doesNotMatch(h, /data-cd=|October 10/);
  assert.match(h, /Founding Supporter snapshot/);
  const official = readFileSync(new URL("../src/official.js", import.meta.url), "utf8");
  assert.match(official, /LAUNCHPAD_OPENS_AT = "2026-10-10T10:10:10-04:00"/);
});

test("connect: every popular wallet, phone QR, app wallets like FOMO, then Google or e-mail", () => {
  const h = html["connect.html"];
  for (const id of ["wallets-detected", "wallets-known", "alt-phone", "alt-app", "qr", "tp-form", "go-google", "go-email", "email-form", "email-addr", "email-code", "stepper",
    "login-block", "login-google", "login-email", "login-inapp", "social-inapp"]) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /Log in with Google/);
  assert.match(h, /Log in with e-mail/);
  assert.doesNotMatch(h, /id="(go-x|login-x|link-start|link-url|lp-x|lp-google)"/, "no X sign-in, and no sign-up link hand-off (e-mail sign-in works inside wallet apps)");
  assert.match(h, /isn't a transaction/);
  assert.match(h, /never ask for your recovery phrase/);
  assert.match(h, /One account per wallet and per Google login or verified e-mail/);
  const order = [...h.matchAll(/<script src="\/([a-z/]+)\.js"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["theme", "site", "vendor/qrcode", "wallets", "connect", "feedback"]);
  const wallets = read("wallets.js");
  for (const w of ["Phantom", "Solflare", "Backpack", "OKX Wallet", "Coinbase Wallet", "Trust Wallet", "Bitget Wallet", "Magic Eden", "Exodus", "Jupiter", "Binance Wallet"]) assert.ok(wallets.includes(`name: "${w}"`), w);
});

test("dashboard: onboarding, live rank + badges, founder race, local/national feeds, roles now and at launch", () => {
  const h = html["dashboard.html"];
  for (const id of ["dash-out", "dash-onboard", "ob-locate", "dash-main", "d-rank", "d-crank", "d-nrank", "progress", "p-panel", "p-window", "feed", "composer", "posts", "community", "national", "nc-election", "badges", "badge-grid", "mod", "request", "roles", "lost-alert", "ban-notice", "proof-modal", "role-home", "squad", "locate-modal"]) assert.ok(h.includes(`id="${id}"`), id);
  for (const k of ["meme", "checkin", "talk"]) assert.ok(h.includes(`data-kind="${k}"`), k);
  for (const s of ["city", "country"]) assert.ok(h.includes(`data-scope="${s}"`), s);
  const order = [...h.matchAll(/<script src="\/([a-z/-]+)\.js"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["theme", "site", "wallets", "swap", "dashboard-roles", "lp-sign", "lp-launch", "dashboard", "feedback"], "the role panel script loads before the dashboard script; swap.js (the in-app swap) after wallets.js; no ticker.js (the ticker comes from /api/me)");
  const roles = h.match(/<section class="section section--panel" id="roles">[\s\S]*?<\/section>/)[0];
  for (const r of ["holder", "founder", "manager", "admin"]) assert.ok(roles.includes(`data-role="${r}"`), r);
  assert.equal((roles.match(/role-row__when">Any time</g) || []).length, 4);
  assert.equal((roles.match(/role-row__when">Since \$VICINITY launched</g) || []).length, 4);
});

test("locate: the phone's browser page for the location hand-off, and one shared location helper", () => {
  const h = html["locate.html"];
  for (const id of ["l-go", "l-purpose", "l-error"]) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /never saved/);
  const order = [...h.matchAll(/<script src="\/([a-z/]+)\.js"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["theme", "site", "locate", "feedback"]);
  assert.ok(html["dashboard.html"].includes('id="locate-modal"'), "the dashboard can start a hand-off");
  const geo = ["site.js", "cities.js", "dashboard.js", "locate.js", "connect.js"].filter((f) => /navigator\.geolocation/.test(read(f)));
  assert.deepEqual(geo, ["site.js"], "only site.js talks to the browser's geolocation");
  assert.match(read("site.js"), /enableHighAccuracy: false/, "a network-based position is the fallback when GPS doesn't answer");
});

test("rules page: every rule, the formulas and the never-list, filled from the live rules", () => {
  const h = html["rules.html"];
  for (const id of ["founders", "managers", "moderation", "supporters", "privacy", "never", "never-list", "founder-formula", "health"]) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /50% × endorsement share/);
  assert.ok(h.includes("the lower of (balance at the cutoff) and (average of the last 14 days)"));
  for (const k of ["qualifyingDays", "windowHours", "appealHours", "graceDays", "cooldownDays", "termDays", "hideHours", "banDays"]) assert.ok(h.includes(`data-rule="${k}"`), k);
  for (const p of PAGES) assert.ok(html[p].includes('<a href="/rules">Rules</a>'), `${p} links the rules in the footer`);
  assert.doesNotMatch(all, /first come, first served/i, "no races");
  assert.doesNotMatch(all, /= one person/i, "no overclaiming: accounts aren't proof of a unique person");
});

test("no page still says the founder amount is a flat 1,000,000 (policy v5: the Stake Ladder, 100K to 1M)", () => {
  for (const [f, h] of Object.entries(html)) assert.doesNotMatch(h, /(held|hold|holds|drops below|Held)\s+(the\s+)?1,000,000/, `${f} still shows the old flat founder amount`);
  assert.doesNotMatch(read("token.js"), /FOUNDER = 1_000_000/);
});

test("privacy statements match what is really stored (no X sign-in, no 'no e-mail', no unused purposes)", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rest = Object.entries(html).filter(([f]) => f !== "terms.html").map(([, h]) => h).join("\n"); // the Terms are the owner's lawyer's
  for (const [name, text] of [["site", rest], ["README", readme], ["dashboard.js", read("dashboard.js")]]) {
    assert.doesNotMatch(text, /\bX or Google\b|\bX \/ Google\b|from X the id|X_CLIENT|api\/auth\/x\//, `${name}: X sign-in is gone`);
    assert.doesNotMatch(text, /No e-mail, no passwords/i, `${name}: e-mail addresses are stored`);
    assert.doesNotMatch(text, /security alerts|city updates|only write when it matters|only used if we ever need to reach you/i, `${name}: nothing is sent to contact details yet`);
  }
  // the inventory, in the FAQ, on the rules page, on the connect page and in the README
  assert.match(html["index.html"], /With Google sign-in, only your Google account id and first name/);
  assert.match(html["index.html"], /the e-mail address itself \(it is your account id\) and a hash of the 6-digit code, which expires in 10 minutes/);
  assert.match(html["index.html"], /phone number is not verified and not used for anything yet/);
  assert.match(html["rules.html"], /the address itself \(it is your account id\) and a hash of the code/);
  assert.match(html["connect.html"], /we keep the address itself \(it is your account id\)/);
  assert.match(readme, /for e-mail sign-in the e-mail address itself \(it is your account id\) and a hash of the 6-digit code/);
  assert.match(readme, /Check-in coordinates are never stored/);
  // the profile modal: both contact details say what they are for and can be removed
  const modal = html["dashboard.html"], js = read("dashboard.js");
  assert.match(modal, /Not verified and not used for anything yet\. You can remove it any time/);
  assert.match(js, /\/api\/me\/contact\/email\/remove/);
  assert.match(js, /\/api\/me\/phone", \{ phone: "" \}/);
});

test("admin console: kept out of search engines, and destructive buttons ask first (Cancel on a ban bans nobody)", () => {
  assert.match(html["admin.html"], /<meta name="robots" content="noindex, nofollow">/);
  for (const [f, h] of Object.entries(html)) if (f !== "admin.html") assert.doesNotMatch(h, /name="robots"/, f);
  assert.doesNotMatch(html["admin.html"], /<meta (name|property)="(og:)?description" content="[^"]*test lab/i, "the public description does not advertise the test lab");
  const js = read("admin.js");
  assert.match(js, /if \(reason === null \|\| !reason\.trim\(\)\) return;/, "Cancel / empty reason stops the ban");
  assert.doesNotMatch(js, /prompt\([^)]*\)\s*\|\|\s*"spam"/, "no default reason that survives Cancel");
  for (const label of ["Approve", "Reject", "Hide", "Uphold", "Revoke", "Unban"]) assert.match(js, new RegExp(`btn\\("${label}[^"]*", async \\(\\) => \\{ if \\(sure\\(`), label);
});

test("connect: e-mail sign-in errors appear inside the e-mail form (it moves between the log-in block and the sign-up step)", () => {
  const h = html["connect.html"], js = read("connect.js");
  const form = h.match(/<form class="email-form" id="email-form"[\s\S]*?<\/form>/)[0];
  assert.match(form, /id="email-error"/);
  assert.match(js, /setEmailErr\(emailErr\(e\.message\)\)/);
  assert.doesNotMatch(js, /setErr\(emailErr/, "e-mail errors must not go to the far-away wallet error line");
});

test("the 'no rug pull' copy says minting is already off (the live mint's authority is null), never that it goes off when the curve fills", () => {
  // measured 3 Oct 2026: getAccountInfo(the real mint) -> mintAuthority null, freezeAuthority null, while the LaunchLab
  // curve was about a third full; the page said "Raydium switches minting off for good when the LaunchLab curve fills"
  for (const f of ["index.html", "token.html"]) {
    assert.doesNotMatch(html[f], /switch(es)? minting off|minting is switched off for good, and/i, f);
    assert.doesNotMatch(html[f], /when the (LaunchLab )?curve fills[^<.]*minting/i, f);
  }
  assert.match(html["token.html"], /<h3>Minting disabled<\/h3><p>[^<]*mint authority is already removed on-chain[^<]*<\/p>/);
  assert.match(html["index.html"], /Minting and freezing are already switched off for good/);
  assert.match(html["index.html"], /<summary>Is this a rug pull\?<\/summary><p>No\. There's no presale, minting and freezing are already switched off for good/);
});

test("home: no badge is offered to visitors (the Early member badge can't be earned since launch; design v4 removed its card)", () => {
  // src/signup-finish.js (the sign-up) and src/auth.js store early = 0 for every account made while VICINITY_MINT is set (since 3 Oct 2026)
  const h = html["index.html"];
  assert.doesNotMatch(h, /Join before \$VICINITY launches|Early member/);
  for (const f of ["../src/signup-finish.js", "../src/auth.js"]) assert.match(readFileSync(new URL(f, import.meta.url), "utf8"), /activeMint\(env\) \? 0 : 1/, `${f}: the rule the old card described`);
});

test("home: the FAQ speaks of the launch as past; nothing promises a city coin can launch now (design v4: the roadmap and the map left the page)", () => {
  // live 3 Oct 2026 after the launch: the launch was still the pulsing "next" step, "the contract address is published on this
  // site first", the FAQ said "it launches October 3", and the New York map said founder "claims open at launch"
  const h = html["index.html"];
  assert.doesNotMatch(h, /Every city can launch/, "no city coin can launch yet without its founder: the hero says each city can get one");
  assert.match(h, /Every real city can get one official coin/);
  assert.doesNotMatch(h, /published on this site first/);
  assert.doesNotMatch(h, /it launches October 3|so it launches a week earlier|Why is \$VICINITY launching/);
  assert.match(h, /it launched on October 3 on Raydium LaunchLab/);
  const home = read("home.js");
  assert.doesNotMatch(home, /claims open at launch/);
  assert.doesNotMatch(home, /m-flag|👑|📍/);
});

test("dashboard roles (public, signed out too) no longer present the rules in force since the launch as 'when Vicinity goes live'", () => {
  // live 3 Oct 2026 after the launch: "Who does what, now and when Vicinity goes live." with holders-only posting and voting,
  // founder applications (already enforced by src/social.js and src/seats.js once VICINITY_MINT is set) and "Publishes the
  // only official contract address" all listed as future
  const roles = html["dashboard.html"].match(/<section class="section section--panel" id="roles">[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(roles, /goes live|after launch/);
  assert.match(roles, /<h2>Who does what\.<\/h2>/);
  assert.match(roles, /Published the only official contract address: it is on the <a href="\/token">Token page<\/a>\./);
  assert.doesNotMatch(html["index.html"], /now and after launch/);
});

test("README (the public repo's front page) names the live official contract, the same one the site uses, and no longer says no token exists", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const mint = /"VICINITY_MINT":\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"))?.[1];
  assert.ok(mint, "the live mint is set in wrangler.jsonc");
  assert.doesNotMatch(readme, /No token exists yet|has not launched|will be published in this README|the moment it launches/);
  assert.ok(readme.split("\n").slice(0, 10).join("\n").includes(`\`${mint}\``), "the contract is at the top of the README, as promised there before the launch");
  assert.doesNotMatch(readme, /why \$VICINITY launches on Raydium LaunchLab/);
});

test("dashboard teaser: nothing in the signed-out preview is shifted sideways or pushed past its column, so it never reaches past the screen", () => {
  // measured live 3 Oct 2026 on /dashboard (signed out) at 320px: the second staggered card ran 40 to 328px, the page widened to 328px and
  // the bottom menu bar was laid out 8px past the screen edge. The staggered blur cards were replaced on 5 Oct 2026 by an example
  // dashboard (.dpv) that stays inside its column: no sideways shift, no negative side offset. Checked in Chromium at 320/390/1280 px.
  const dash = read("polish-dash.css"); // the preview's rules live in the dashboard's own sheet (review PERF-1)
  assert.doesNotMatch(css + dash, /\.blur-card|\.teaser__lock/, "the old staggered cards are gone");
  const rules = [...dash.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?<=^|[{}])(\s*)([^{}@]*\.dpv[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length >= 20, "the preview's rules");
  // the two light sweeps are larger than their card and slide across it, so their card clips them
  const clipped = { ".dpv__shine": ".dpv__pass", ".dpv__fill::after": ".dpv__fill" };
  for (const [sweep, box] of Object.entries(clipped)) {
    const r = rules.find(([, , sel]) => sel.trim() === box);
    assert.ok(r && /overflow:\s*hidden/.test(r[3]), `${box} clips ${sweep}`);
  }
  for (const [, , sel, body] of rules) {
    if (sel.trim() in clipped) continue;
    assert.doesNotMatch(body, /translateX\(/, `${sel.trim()}: no sideways shift`);
    assert.doesNotMatch(body, /(margin|inset|left|right)[^;]*:\s*[^;]*-\d/, `${sel.trim()}: no negative side offset`);
    assert.doesNotMatch(body, /(^|[;\s])(min-)?width:\s*\d{3,}px/, `${sel.trim()}: no fixed width wider than a phone (a max-width is fine)`);
  }
});
