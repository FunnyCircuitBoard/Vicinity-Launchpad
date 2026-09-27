import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { buildPages } from "../scripts/pages/build.mjs";

const read = (p) => readFileSync(new URL("../public/" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PAGES = ["index.html", "token.html", "cities.html", "launchpad.html", "connect.html", "dashboard.html", "rules.html", "404.html"];
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
    assert.equal((nav.match(/aria-current="page"/g) || []).length, ["404.html", "connect.html", "rules.html"].includes(f) ? 0 : 1, f);
    assert.match(h, /data-theme-toggle/);
    assert.match(h, /<script src="\/theme\.js"><\/script>\s*<\/head>/, `${f}: theme runs before paint`);
    assert.match(h, /data-account/);
  }
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /\.tabbar \{ display: grid;/);
});

test("home: the problem, the real New York City map, how it works, incentives, roles, FAQ", () => {
  const h = html["index.html"];
  for (const id of ["problem", "nyc", "nyc-map", "how", "why", "roles", "roadmap", "faq"]) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /Real map, real data · New York City/);
  assert.match(h, /Why did \$VICINITY launch on pump\.fun and not on the Vicinity Launchpad\?/);
  assert.match(h, /FOMO/);
  assert.match(h, /Nothing here is financial advice/);
  assert.doesNotMatch(h, /Maple Falls|Port Jasper|Cedar Bay/, "no more fictional demo towns");
  const nyc = JSON.parse(read("data/demo-nyc.json"));
  assert.ok(nyc.members.length > 50 && nyc.official.length && nyc.nyc.area.length && nyc.neighbors.length > 5);
  assert.ok(nyc.members.some(([name]) => name === "Brooklyn"));
  const stats = JSON.parse(read("data/stats.json"));
  assert.ok(stats.communities > 1000 && stats.countries > 200);
});

test("token page: live facts on top, verify a wallet, holders in a scrolling table, official list", () => {
  const h = html["token.html"];
  for (const id of ["token", "contract", "verify", "lookup", "rank-card", "holders", "holders-scroll", "holders-table", "check", "checker"]) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /No rug pull/);
  assert.match(css, /\.table-scroll \{ max-height: 560px; overflow: auto;/);
  assert.match(css, /\.holders__table thead th \{ position: sticky;/);
});

test("cities page: live map, claimed vs open, claiming sends you to the dashboard, rules stated plainly", () => {
  const h = html["cities.html"];
  for (const id of ["cities", "city-canvas", "map-in", "map-out", "map-reset", "map-locate", "coin-preview", "coin-ticker", "claim-feed", "mod-row", "city-q", "cs-claimed", "cs-open", "wanted-list"]) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /<a class="btn btn--primary btn--block" id="claim-btn" href="\/dashboard">/);
  assert.match(h, /One wallet\. One city\./);
  assert.match(h, /1,000,000\+ \$VICINITY/);
  assert.match(h, /We never save it/);
  assert.match(h, /VPNs are blocked/);
  assert.match(h, /Sample only/);
  assert.match(h, /id="map-style"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(h, /satellite/i);
  const order = [...h.matchAll(/<script src="\/([a-z/]+)\.js"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["theme", "site", "ticker", "cities"]);
});

test("launchpad: countdown to November 10 and who gets in first", () => {
  const h = html["launchpad.html"];
  for (const id of ["countdown", "lp-bar", "lp-cal"]) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /November 10, 2026/);
  assert.match(h, /data-cd="seconds"/);
  assert.match(h, /Founding Supporters/);
  const official = readFileSync(new URL("../src/official.js", import.meta.url), "utf8");
  assert.match(official, /LAUNCHPAD_OPENS_AT = "2026-11-10T/);
});

test("connect: every popular wallet, phone QR, app wallets like FOMO, then X or Google", () => {
  const h = html["connect.html"];
  for (const id of ["wallets-detected", "wallets-known", "alt-phone", "alt-app", "qr", "tp-form", "go-x", "go-google", "stepper"]) assert.ok(h.includes(`id="${id}"`), id);
  assert.match(h, /isn't a transaction/);
  assert.match(h, /never ask for your recovery phrase/);
  assert.match(h, /One account per wallet and per X or Google login/);
  const order = [...h.matchAll(/<script src="\/([a-z/]+)\.js"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["theme", "site", "vendor/qrcode", "wallets", "connect"]);
  const wallets = read("wallets.js");
  for (const w of ["Phantom", "Solflare", "Backpack", "OKX Wallet", "Coinbase Wallet", "Trust Wallet", "Bitget Wallet", "Magic Eden", "Exodus", "Jupiter", "Binance Wallet"]) assert.ok(wallets.includes(`name: "${w}"`), w);
});

test("dashboard: onboarding, live rank + badges, founder race, local/national feeds, roles now and at launch", () => {
  const h = html["dashboard.html"];
  for (const id of ["dash-out", "dash-onboard", "ob-locate", "dash-main", "d-rank", "d-crank", "d-nrank", "progress", "p-panel", "p-window", "feed", "composer", "posts", "community", "national", "nc-election", "badges", "badge-grid", "mod", "request", "roles", "lost-alert", "ban-notice", "proof-modal"]) assert.ok(h.includes(`id="${id}"`), id);
  for (const k of ["meme", "checkin", "talk"]) assert.ok(h.includes(`data-kind="${k}"`), k);
  for (const s of ["city", "country"]) assert.ok(h.includes(`data-scope="${s}"`), s);
  const roles = h.match(/<section class="section section--panel" id="roles">[\s\S]*?<\/section>/)[0];
  for (const r of ["holder", "founder", "manager", "admin"]) assert.ok(roles.includes(`data-role="${r}"`), r);
  assert.equal((roles.match(/role-row__when">Now</g) || []).length, 4);
  assert.equal((roles.match(/role-row__when">When Vicinity goes live</g) || []).length, 4);
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
