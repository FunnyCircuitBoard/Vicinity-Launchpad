import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { buildPages } from "../scripts/pages/build.mjs";
import { cityAt } from "../src/geo.js";

const read = (p) => readFileSync(new URL("../public/" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PAGES = ["index.html", "token.html", "cities.html", "launchpad.html", "coin.html", "connect.html", "locate.html", "dashboard.html", "rules.html", "terms.html", "404.html", "admin.html"];
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
      if (p.startsWith("/api/")) continue;
      const file = p.endsWith("/") ? p + "index.html" : /\.[a-z0-9]+$/.test(p) ? p : p + ".html";
      assert.ok(existsSync(new URL("../public" + file, import.meta.url)), `${f}: missing ${p}`);
    }
  }
});

test("same menu on every page: top menu for computers, bottom menu bar for phones, theme toggle", () => {
  const links = ["/", "/token", "/cities", "/launchpad", "/dashboard"];
  for (const [f, h] of Object.entries(html)) {
    const nav = h.match(/<nav class="nav"[\s\S]*?<\/nav>/)[0], tabs = h.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)[0];
    assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), links, f);
    assert.deepEqual([...tabs.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), links, f);
    assert.equal((nav.match(/aria-current="page"/g) || []).length, ["404.html", "connect.html", "locate.html", "rules.html", "terms.html", "admin.html"].includes(f) ? 0 : 1, f);
    assert.match(h, /data-theme-toggle/);
    assert.match(h, /<script src="\/theme\.js"><\/script>\s*<\/head>/, `${f}: theme runs before paint`);
    assert.match(h, /data-account/);
    assert.match(h, /<span data-account-label>Log in<\/span>/, `${f}: signed-out visitors see a Log in button`);
    assert.doesNotMatch(h, /data-logout|account-out/, `${f}: one account button in the header; Log out lives in the profile modal`);
  }
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /\.tabbar \{ display: grid;/);
});

test("terms gate: every page (except /terms) asks for agreement before entry", () => {
  for (const [f, h] of Object.entries(html)) {
    if (f === "terms.html") continue;
    assert.match(h, /id="termsgate"[^>]*data-terms-version="2026-10-01"/, `${f}: gate modal with version`);
    assert.match(h, /id="termsgate-agree"/, `${f}: agree button`);
    assert.match(h, /id="termsgate-decline"/, `${f}: decline button`);
    assert.match(h, /href="\/terms"/, `${f}: link to the full terms`);
  }
  assert.doesNotMatch(html["terms.html"], /id="termsgate"/, "terms page itself stays readable (inline agree instead)");
  assert.match(html["terms.html"], /id="terms-agree"/, "terms page has an inline agree button");
});

test("terms gate script: the inline agree button is wired even when the modal is absent", () => {
  const js = read("site.js");
  const gateLookup = js.indexOf('$("#termsgate")');
  const termsBranch = js.indexOf('dataset.page === "terms"');
  assert.ok(termsBranch !== -1 && gateLookup !== -1 && termsBranch < gateLookup,
    "the terms-page branch must run before the gate-missing early return, or the inline button stays dead");
  assert.ok(js.includes('$("#terms-agree")'), "inline agree button is wired");
  assert.doesNotMatch(js, /style\.overflow\s*=\s*["']hidden["']/, "the gate never freezes page scrolling");
});

test("terms page: the full Terms of Use", () => {
  const h = html["terms.html"];
  for (const s of ["1. Introduction", "4. Eligibility", "13. Warranty Disclaimer", "14. Limitation of Liability",
                   "16. Dispute Resolution", "Class Action Waiver", "19. Contact", "@VicinityCitySOL"]) {
    assert.ok(h.includes(s), `terms mention: ${s}`);
  }
  assert.match(css, /\.termsgate\s*\{/, "gate styles exist");
  assert.match(css, /\.terms h2/, "terms page styles exist");
});

test("profile: the pass shows no real name, and the header username button is the profile button", () => {
  const js = read("dashboard.js");
  const loginLine = js.split("\n").find((l) => l.includes("[data-me-login]") && l.includes("textContent"));
  assert.ok(loginLine && !loginLine.includes("u.name"), "the sign-in line never interpolates the real name");
  assert.ok(js.includes("PROVIDER_LABEL"), "the pass shows the sign-in method label only");
  const h = html["dashboard.html"];
  assert.ok(!h.includes('id="profile-open"'), "no profile button on the pass — the header button is the profile entry");
  assert.match(h, /id="profile-modal"/, "profile modal");
  assert.match(h, /id="username-form"/, "username change form");
  assert.match(h, /id="email-form"/, "e-mail add form");
  assert.match(h, /id="phone-form"/, "phone form");
  assert.match(h, /id="profile-logout"/, "log out in the profile section");
  assert.ok(h.includes("Help &amp; support"), "help & support section");
  // dashboard exposes the opener; the header button calls it on the dashboard
  assert.ok(js.includes("window.V.openProfile = openProfile"), "dashboard exposes openProfile");
  assert.ok(js.includes('"#profile"'), "dashboard opens the profile on the #profile hash");
  const site = read("site.js");
  assert.ok(site.includes("/dashboard#profile"), "the header account button points at the profile");
  assert.ok(site.includes("Profile and settings"), "the header button is labeled as the profile button");
  assert.ok(site.includes("window.V.openProfile"), "the header button opens the profile in place on the dashboard");
  assert.match(css, /\.profile__sec/, "profile styles exist");
  assert.match(css, /\.icon-btn/, "profile icon button styles exist");
});

test("home: the problem, the real New York City map, how it works, incentives, roles, FAQ", () => {
  const h = html["index.html"];
  for (const id of ["problem", "nyc", "nyc-map", "why-now", "how", "why", "get", "roles", "roadmap", "faq"]) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /Real map, real data · New York City/);
  assert.match(h, /Why did \$VICINITY launch on Raydium LaunchLab and not on the Vicinity Launchpad\?/);
  assert.match(h, /<a class="hero-map__link" href="\/cities\?city=5128581"/, "the New York map opens the map page");
  assert.doesNotMatch(h, /stonkfun|stonfun/i, "launching on Raydium LaunchLab");
  assert.match(h, /How do I buy \$VICINITY\?/);
  assert.match(h, /href="\/token#buy"/);
  assert.doesNotMatch(h, /pump\.fun/i, "not pump.fun");
  assert.doesNotMatch(h, /first to claim/i, "founders are chosen by locals, not a race");
  assert.match(h, /FOMO/);
  assert.match(h, /Nothing here is financial advice/);
  assert.doesNotMatch(h, /Maple Falls|Port Jasper|Cedar Bay/, "no more fictional demo towns");
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
  for (const id of ["cities", "city-canvas", "map-in", "map-out", "map-reset", "map-locate", "coin-preview", "coin-ticker", "claim-feed", "mod-row", "city-q", "cs-claimed", "cs-open", "wanted-list"]) assert.ok(h.includes(`id="${id}"`), id);
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

test("launchpad: countdown to October 10, 10:10:10 AM New York time, and who gets in first", () => {
  const h = html["launchpad.html"];
  for (const id of ["countdown", "lp-bar", "lp-cal"]) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /October 10, 2026 · 10:10:10 AM New York time/);
  assert.match(h, /data-cd="seconds"/);
  assert.match(h, /Founding Supporters/);
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
  assert.deepEqual(order, ["theme", "site", "ticker", "wallets", "swap", "dashboard-roles", "dashboard", "feedback"], "the role panel script loads before the dashboard script; swap.js (the in-app swap) after wallets.js");
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
  for (const p of PAGES) assert.ok(html[p].includes('href="/rules">Rules &amp; fairness</a>'), `${p} links the rules in the footer`);
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

test("home: the Early member card no longer invites visitors to join for a badge new sign-ups can't get since launch", () => {
  // src/signup-finish.js (the sign-up) and src/auth.js store early = 0 for every account made while VICINITY_MINT is set (since 3 Oct 2026)
  const h = html["index.html"];
  assert.doesNotMatch(h, /Join before \$VICINITY launches/);
  assert.match(h, /<h3>Proof you were early<\/h3><p class="muted">Members who joined before \$VICINITY launched on October 3 carry the <strong>Early member<\/strong> badge for good\. Nobody can earn it any more\.<\/p>/);
  for (const f of ["../src/signup-finish.js", "../src/auth.js"]) assert.match(readFileSync(new URL(f, import.meta.url), "utf8"), /activeMint\(env\) \? 0 : 1/, `${f}: the rule the card describes`);
});

test("home: the roadmap shows the October 3 launch as done and the Launchpad as next; the FAQ and the map speak of the launch as past", () => {
  // live 3 Oct 2026 after the launch: the launch was still the pulsing "next" step, "the contract address is published on this
  // site first", the FAQ said "it launches October 3", and the New York map said founder "claims open at launch"
  const h = html["index.html"];
  const items = [...h.matchAll(/<li class="timeline__item([^"]*)"><span class="timeline__status">([^<]+)<\/span><h3>([^<]+)<\/h3>/g)].map((m) => [m[1].trim(), m[2], m[3]]);
  assert.deepEqual(items.slice(0, 4), [["is-done reveal", "Done", "The real map"], ["is-done reveal", "Done", "Accounts and dashboards"],
    ["is-done reveal", "Done", "$VICINITY launched"], ["is-next reveal", "Next", "Vicinity Launchpad"]]);
  assert.doesNotMatch(h, /Every city can launch/, "no city coin can launch yet: the roadmap says each city launches once its founder qualifies");
  assert.equal((h.match(/timeline__item is-next/g) || []).length, 1, "one next step");
  assert.doesNotMatch(h, /published on this site first/);
  assert.doesNotMatch(h, /it launches October 3|so it launches a week earlier|Why is \$VICINITY launching/);
  assert.match(h, /it launched on October 3 on Raydium LaunchLab/);
  const home = read("home.js");
  assert.doesNotMatch(home, /claims open at launch/);
  assert.match(home, /"👑 City Founder: seat open · hold 7 days, then apply"/);
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
  assert.doesNotMatch(css, /\.blur-card|\.teaser__lock/, "the old staggered cards are gone");
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?<=^|[{}])(\s*)([^{}@]*\.dpv[^{}]*)\{([^}]*)\}/g)];
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
