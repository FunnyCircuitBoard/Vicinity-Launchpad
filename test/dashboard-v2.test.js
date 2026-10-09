// Dashboard v2 (DASHBOARD_V2=on): the tabbed dashboard. With the switch off nothing changes: the built page keeps every pinned id,
// the strip and the skeleton stay hidden, dashboard-v2.js is never a script of the page, and /api/me has no new key. With it on,
// /api/me says dashboardV2: true in every shape, and the page fetches dashboard-v2.js. The static checks pin the contract between
// the markup, dashboard-v2.js and dashboard.js: every card in exactly one tab, every id the v2 code uses present in the page,
// nothing inline, no markup built from text, a proper ARIA tab strip, and every hash the router knows has a panel.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { IN_UTICA, MINT, V2, browser, loginBody, newWorld, person, realClock, useClock, wallet } from "./helpers/world.js";
import { dashboardV2On } from "../src/flags.js";
import { POLICY } from "../src/policy.js";

const read = (p) => readFileSync(new URL("../public/" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const html = read("dashboard.html"), v2 = read("dashboard-v2.js"), dash = read("dashboard.js"), roles = read("dashboard-roles.js");
const idsOf = (h) => [...h.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const PAGE_IDS = idsOf(html);
const count = (id) => PAGE_IDS.filter((x) => x === id).length;

/** dashboard-v2.js loaded with a stub window: its top level only reads window.V and publishes window.VDash. */
function loadV2() {
  const window = { V: {}, addEventListener() {} };
  vm.runInNewContext(v2, { window });
  return window.VDash;
}

/** The direct children of the element whose start tag begins at `start`: { tag, id, cls, index }. A tiny walker, enough for our own markup. */
function children(h, start) {
  const VOID = new Set(["img", "input", "br", "hr", "meta", "link", "source"]);
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  re.lastIndex = start;
  let depth = 0; const out = [];
  for (let m; (m = re.exec(h)); ) {
    const [, close, tag, attrs, self] = m;
    if (close) { depth--; if (depth === 0) return out; continue; }
    if (depth === 1) out.push({ tag, id: (attrs.match(/\bid="([^"]+)"/) || [])[1] || null, cls: (attrs.match(/\bclass="([^"]+)"/) || [])[1] || "", index: m.index });
    if (!VOID.has(tag) && !self) depth++;
  }
  throw new Error("unclosed element at " + start);
}
const startOf = (id) => { const i = html.indexOf(`id="${id}"`); assert.ok(i > 0, id); return html.lastIndexOf("<", i); };

// The id-to-tab table (CONTRACT.md section 1): every id of the built dashboard page, each in exactly one place.
const LAYOUT = ["main", "status", "termsgate", "termsgate-title", "termsgate-agree", "termsgate-decline", "toast"];
const TABLE = {
  global: ["dash-skel", "dash-out", "dash-onboard", "ob-rank", "ob-rank-text", "ob-city", "ob-city-text", "ob-locate", "ob-nearby", "ob-error", "ob-enter",
    "proof-modal", "proof-title", "proof-wallets", "proof-none", "proof-transfer", "proof-code", "proof-sol", "proof-start", "proof-error", "proof-cancel",
    "locate-modal", "locate-title", "locate-link", "locate-copy", "locate-status", "locate-error", "locate-cancel", "dash-main", "ob-wallet", "ob-wallet-title", "proof-login"],
  retired: ["layout-edit", "layout-reset", "col-main", "col-side"],
  home: ["pf-notice", "pf-notice-open", "pf-notice-ok", "ban-notice", "lost-alert",
    "welcome", "welcome-disc", "welcome-title", "welcome-line", "welcome-ring", "welcome-ring-num", "welcome-ring-tick-location", "welcome-ring-tick-account", "welcome-ring-tick-wallet", "welcome-close",
    "dash-top", "pass", "pass-ring", "pass-ring-num", "me-role", "me-avatar", "me-home", "me-bio", "pass-coin", "me-copy", "me-link", "me-checked", "me-logout",
    "wallet-card", "wcard-kicker", "wcard-title", "wcard-lead", "wcard-perks", "wcard-city", "wcard-actions", "wcard-go", "wcard-other", "wcard-skip", "wcard-wait", "wcard-wait-text", "wcard-tiny",
    "d-amount", "d-amount-sub", "d-rank", "d-rank-sub", "d-city-label", "d-crank", "d-crank-sub", "d-country-label", "d-nrank", "d-nrank-sub",
    "today", "today-title", "today-list", "role-home", "portfolio", "pf-title", "pf-updated", "pf-refresh", "pf-body", "pf-msg", "pf-net", "pf-net-me", "pf-net-find",
    "badges", "bg-n-earned", "bg-n-locked", "badge-grid", "trade", "trade-title", "trade-state", "tr-amt", "tr-in", "tr-in-usd", "tr-flip", "tr-out", "tr-outk", "tr-rate", "tr-go", "tr-go-2", "tr-note"],
  city: ["city-subnav", "community", "cc-face", "cc-name", "cc-ticker", "ch-status", "cc-members", "cc-holders", "cc-founder", "ch-locals", "ch-locals-n", "ch-coin", "ch-coin-v", "cc-fomo", "cc-top", "cc-share",
    "coin", "coin-title", "coin-city", "coin-status", "coin-art", "coin-logo", "coin-art-face", "coin-name", "coin-ticker", "coin-pair", "coin-pitch", "coin-by", "coin-contract", "coin-mint", "coin-mint-copy", "coin-note",
    "city-about", "ca-title", "ca-city", "ca-ticker", "ca-country", "ca-threshold", "ca-map", "request", "req-form", "req-name", "req-mine", "req-err"],
  community: ["feed", "f-city", "f-country", "composer", "c-text", "c-pic-label", "c-pic", "c-preview", "c-count", "c-post", "c-err", "f-note", "posts", "f-more", "national", "nc-name", "nc-members", "nc-manager", "nc-election"],
  rankings: ["rankings-card", "rk-title", "rk-state", "rk-tiles", "rk-global", "rk-global-rank", "rk-global-sub", "rk-global-gap", "rk-country", "rk-country-label", "rk-country-rank", "rk-country-sub", "rk-country-note",
    "rk-city", "rk-city-label", "rk-city-rank", "rk-city-sub", "rk-city-note", "rk-note"],
  founder: ["fcard", "fcard-kicker", "fcard-state", "fcard-title", "fcard-who", "fcard-pick", "fcard-since-label", "fcard-since", "fcard-coin", "fcard-clock-row", "fcard-clock-label", "fcard-clock", "fcard-note", "fcard-go", "fcard-alt", "fcard-meter",
    "progress", "progress-title", "p-city", "p-pct", "fs-state", "p-bar", "p-steps", "fs-rank", "fs-rank-text", "fs-rank-note", "p-panel", "p-window", "p-error", "squad",
    "studio-card", "studio-title", "studio-city", "studio-state", "coin-studio", "studio-step-1", "cs-name", "cs-ticker", "cs-pitch", "cs-count", "studio-step-2", "studio-step-3", "cs-logo", "cs-logo-remove", "cs-save", "cs-err", "cs-mint", "cs-mint-send", "founder-foot"],
  moderate: ["mod", "mod-scope", "mod-sections", "coin-admin-card", "coin-admin", "coin-waiting"],
  profile: ["profile-modal", "profile-title", "profile-avatar", "profile-since", "profile-close", "profile-username-h", "username-form", "username-input", "username-err", "bio-sec", "profile-bio-h", "bio-form", "bio-input", "bio-count", "bio-hint", "bio-save", "bio-err",
    "profile-net-sec", "profile-net-h", "profile-net", "profile-net-link", "profile-account-h", "profile-wallet", "profile-copy", "profile-link", "profile-unlink", "profile-provider", "profile-home", "email-row", "email-desc", "email-view", "email-form", "email-input", "email-code-form", "email-code-input",
    "phone-row", "phone-view", "phone-form", "phone-input", "contact-err", "profile-public-note", "profile-help-h", "profile-logout", "profile-theme-note", "roles"],
  strip: ["dv2", "dash-tabs", "dash-tablist", "tab-home", "tab-city", "tab-community", "tab-rankings", "tab-founder", "tab-moderate", "tab-moderate-n", "tab-profile",
    "panel-home", "panel-city", "panel-community", "panel-rankings", "panel-founder", "panel-moderate", "panel-profile"],
};
const TABLE_IDS = Object.values(TABLE).flat();
const TABS = ["home", "city", "community", "rankings", "founder", "moderate", "profile"];

/* ---------- the switch ---------- */
test("dashboardV2On: exactly 'on', trimmed, any letter case", () => {
  for (const v of ["on", " on ", "ON", "On", "\ton\n"]) assert.equal(dashboardV2On({ DASHBOARD_V2: v }), true, JSON.stringify(v));
  for (const v of [undefined, "", "off", "ON?", "true", "1", "yes", "onn", "v2"]) assert.equal(dashboardV2On(v === undefined ? {} : { DASHBOARD_V2: v }), false, JSON.stringify(v));
  assert.equal(dashboardV2On(undefined), false);
  assert.equal(dashboardV2On({ DASHBOARD_V2: true }), false, "a boolean is not the word on");
});

beforeEach(() => useClock("2026-10-01T12:00:00Z"));
after(() => realClock());

async function shapes(env) {
  const out = browser(env);
  const pending = browser(env);
  await pending.post("/api/auth/wallet", await loginBody(await wallet()));
  const p = await person(env, { home: IN_UTICA });
  return { out: await out.get("/api/me"), pending: await pending.get("/api/me"), lite: await p.get("/api/me?lite=1"), full: await p.get("/api/me") };
}

test("flag off: /api/me has exactly the keys it always had, in all four shapes, whatever else is switched on", async () => {
  for (const env of [newWorld(), newWorld({ DASHBOARD_V2: "off" }), newWorld({ DASHBOARD_V2: "" }), newWorld({ PROFILES: "on", DASHBOARD_V2: "yes" })]) {
    const s = await shapes(env);
    for (const [name, d] of Object.entries(s)) assert.ok(!("dashboardV2" in d) && !JSON.stringify(d).includes("dashboardV2"), `${name}: no new key`);
  }
  // the sign-up v2 world (its own sign-in path): the signed-out shape, which is what the header asks for
  assert.deepEqual(Object.keys(await browser(V2({ PROFILES: "on", DASHBOARD_V2: "true" })).get("/api/me")), ["signedIn", "providers", "signupFlow", "profilesFlag"]);
  const plain = await shapes(newWorld());
  assert.deepEqual(Object.keys(plain.out), ["signedIn", "providers"]);
  assert.deepEqual(Object.keys(plain.pending), ["signedIn", "providers", "pending", "proof"]);
  assert.deepEqual(Object.keys(plain.lite), ["signedIn", "user", "providers", "fresh"]);
});

test("flag on: /api/me carries dashboardV2: true in all four shapes, next to the other switches, and nothing else changes", async () => {
  const s = await shapes(newWorld({ DASHBOARD_V2: " ON " }));
  for (const [name, d] of Object.entries(s)) assert.equal(d.dashboardV2, true, name);
  assert.deepEqual(Object.keys(s.out), ["signedIn", "providers", "dashboardV2"]);
  assert.deepEqual(Object.keys(s.pending), ["signedIn", "providers", "pending", "proof", "dashboardV2"]);
  assert.deepEqual(Object.keys(s.lite), ["signedIn", "user", "providers", "fresh", "dashboardV2"]);
  assert.deepEqual(Object.keys(s.lite.user), ["id", "wallet", "provider", "handle", "name", "contact_email", "phone", "home", "joined"], "the user object is untouched");
  assert.ok("progress" in s.full && "founder" in s.full && "community" in s.full, "the full answer is the same dashboard data");
  // with the other switches on too: every flag key is there, exactly once each
  assert.deepEqual(Object.keys(await browser(V2({ PROFILES: "on", DASHBOARD_V2: "on" })).get("/api/me")), ["signedIn", "providers", "signupFlow", "dashboardV2", "profilesFlag"]);
  const all = await shapes(newWorld({ PROFILES: "on", DASHBOARD_V2: "on" }));
  assert.deepEqual(Object.keys(all.out), ["signedIn", "providers", "dashboardV2", "profilesFlag"]);
  assert.equal(all.full.dashboardV2, true); assert.equal(all.full.profilesFlag, true); assert.equal(all.lite.dashboardV2, true); assert.equal(all.lite.profilesFlag, true);
  // flipped in the dashboard: the very next answer is dark again
  const env = newWorld({ DASHBOARD_V2: "on" });
  const p = await person(env, { home: IN_UTICA });
  assert.equal((await p.get("/api/me")).dashboardV2, true);
  env.DASHBOARD_V2 = "off";
  assert.ok(!("dashboardV2" in (await p.get("/api/me"))));
});

/* ---------- the built page ---------- */
test("every id of the dashboard page is in the id-to-tab table exactly once, and no id is duplicated", () => {
  const dup = PAGE_IDS.filter((id, i) => PAGE_IDS.indexOf(id) !== i);
  assert.deepEqual(dup, [], "duplicate ids in the built page");
  const tableDup = TABLE_IDS.filter((id, i) => TABLE_IDS.indexOf(id) !== i);
  assert.deepEqual(tableDup, [], "an id listed in two places of the table");
  for (const id of TABLE_IDS) assert.equal(count(id), 1, `id="${id}" must appear exactly once in the built page`);
  const known = new Set([...TABLE_IDS, ...LAYOUT]);
  assert.deepEqual(PAGE_IDS.filter((id) => !known.has(id)), [], "an id in the page that the table does not place");
});

test("flag off: the built page keeps every pinned id, the strip and the skeleton are hidden markup, and the scripts are unchanged", () => {
  for (const id of ["dash-out", "dash-onboard", "ob-locate", "dash-main", "d-rank", "d-crank", "d-nrank", "progress", "p-panel", "p-window", "feed", "composer", "posts", "community", "national",
    "nc-election", "badges", "badge-grid", "mod", "request", "roles", "lost-alert", "ban-notice", "proof-modal", "role-home", "squad", "locate-modal", "profile-modal", "coin", "coin-studio", "coin-admin", "trade"]) assert.equal(count(id), 1, id);
  assert.match(html, /<div class="dv2" id="dv2" hidden>/, "the strip and panels are hidden until v2 runs");
  assert.match(html, /<section class="dash dv2-skel" id="dash-skel" aria-hidden="true" hidden>/, "the skeleton is hidden until v2 asks for it");
  for (const id of ["today", "ch-status", "ch-locals", "ch-coin", "fs-state", "fs-rank", "studio-step-1", "studio-step-2", "studio-step-3", "fcard", "studio-card", "coin-admin-card", "tab-moderate", "tab-moderate-n", "welcome", "wallet-card", "pass-ring", "me-link", "proof-login"]) {
    assert.match(html, new RegExp(`<[a-z]+ [^>]*id="${id}"[^>]* hidden>`), `${id} is hidden markup with the switch off`);
  }
  assert.match(html, /<div class="dash-top" id="dash-top">/);
  const order = [...html.matchAll(/<script src="\/([a-z/-]+)\.js"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["theme", "site", "ticker", "wallets", "dashboard-roles", "dashboard"], "dashboard-v2.js is not a script tag of the page");
  assert.doesNotMatch(html, /\sstyle="/); assert.doesNotMatch(html, /\son[a-z]+="/); assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  // the roles accordion is still the whole section the site test reads
  assert.match(html, /<section class="section section--panel" id="roles">/);
});

test("the ARIA tab strip: one tablist, seven tabs that control seven panels, Moderate hidden until the data says so", () => {
  assert.match(html, /<div class="dtabs__list" id="dash-tablist" role="tablist" aria-label="Dashboard sections">/);
  const tabs = [...html.matchAll(/<a class="dtab" id="tab-([a-z]+)" role="tab" href="#([a-z]+)" data-tab="([a-z]+)" aria-controls="panel-([a-z]+)" aria-selected="(true|false)"([^>]*)>/g)];
  assert.deepEqual(tabs.map((m) => m[1]), TABS);
  for (const m of tabs) {
    assert.equal(m[2], m[1]); assert.equal(m[3], m[1]); assert.equal(m[4], m[1]);
    assert.equal(m[5], m[1] === "home" ? "true" : "false", `${m[1]} selected state`);
    assert.equal(/tabindex="-1"/.test(m[6]), m[1] !== "home", `${m[1]}: only the active tab is in the Tab order`);
    assert.equal(/\bhidden\b/.test(m[6]), m[1] === "moderate", `${m[1]}: Moderate is the one gated tab`);
  }
  const panels = [...html.matchAll(/<section class="dpanel" id="panel-([a-z]+)" role="tabpanel" aria-labelledby="tab-([a-z]+)" tabindex="0"( hidden)?>/g)];
  assert.deepEqual(panels.map((m) => m[1]), TABS);
  for (const m of panels) { assert.equal(m[2], m[1]); assert.equal(Boolean(m[3]), m[1] !== "home", `${m[1]} panel hidden state`); }
  assert.match(html, /<span class="dtab__badge" id="tab-moderate-n" hidden><\/span>/);
});

/* ---------- dashboard-v2.js against the page ---------- */
test("ORDER places every top-level node of #dash-main .wrap, #profile-modal and #roles exactly once, and the static blocks sit in their panels in that order", () => {
  const VDash = loadV2();
  assert.deepEqual([...VDash.TABS], TABS);
  assert.deepEqual(Object.keys(VDash.ORDER), TABS);
  const all = Object.values(VDash.ORDER).flat();
  assert.deepEqual(all.filter((s, i) => all.indexOf(s) !== i), [], "a selector listed twice");
  for (const s of all) { assert.match(s, /^#[a-z][\w-]*$/, s); assert.equal(count(s.slice(1)), 1, `${s} exists once in the page`); }
  const wrap = html.indexOf('<div class="wrap">', startOf("dash-main"));
  const top = children(html, wrap);
  const withId = top.filter((c) => c.id).map((c) => "#" + c.id);
  assert.deepEqual(top.filter((c) => !c.id).map((c) => c.cls), ["dash-tools", "dash-grid"], "the two retired blocks are the only unnamed children");
  for (const s of withId) if (s !== "#dv2") assert.ok(all.includes(s), `${s} is a top-level card with no tab`);
  for (const s of ["#profile-modal", "#roles"]) assert.ok(VDash.ORDER.profile.includes(s), `${s} moves into the Profile tab`);
  // whatever stands in a panel already (the v2 blocks) is listed for that panel, in the same order
  for (const tab of TABS) {
    const inPanel = children(html, startOf("panel-" + tab)).map((c) => "#" + c.id);
    for (const s of inPanel) assert.ok(VDash.ORDER[tab].includes(s), `${s} stands in #panel-${tab} but ORDER.${tab} does not list it`);
    const listed = [...VDash.ORDER[tab]].filter((s) => inPanel.includes(s)); // copied into this realm: the vm's arrays have another prototype
    assert.deepEqual(listed, inPanel, `#panel-${tab}: the static blocks are in ORDER's order`);
  }
  // the moved cards: the two columns hold exactly the cards that ORDER moves out of them, plus the two nested forms v2 re-homes
  const inCols = [...children(html, startOf("col-main")), ...children(html, startOf("col-side"))].map((c) => "#" + c.id);
  for (const s of inCols) assert.ok(all.includes(s), `${s} is a card of the old columns with no tab`);
  assert.ok(VDash.ORDER.founder.includes("#studio-card") && VDash.ORDER.moderate.includes("#coin-admin-card"), "the two wrapper cards v2 fills with #coin-studio and #coin-admin");
  assert.ok(VDash.ALIAS && Object.keys(VDash.ALIAS).every((k) => count(k) === 1 && TABS.includes(VDash.ALIAS[k])), "every legacy hash is a real card in a real tab");
});

test("every #id dashboard-v2.js names exists in the built page, and it creates no id, no markup from text, no request, no dialog", () => {
  const used = [...new Set([...v2.matchAll(/["'`]#([A-Za-z][\w-]*)/g)].map((m) => m[1]))];
  assert.ok(used.length > 60, "the v2 code selects by id");
  for (const id of used) assert.equal(count(id), 1, `dashboard-v2.js uses #${id}, which the built page does not have exactly once`);
  assert.doesNotMatch(v2, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|cssText|setAttribute\(["']style|\.style\./, "no markup from text, no inline style");
  assert.doesNotMatch(v2, /\bfetch\(|XMLHttpRequest|\bapi\(|navigator\.sendBeacon/, "v2 never talks to the server itself");
  assert.doesNotMatch(v2, /\bprompt\(|\bconfirm\(|\balert\(/, "no dialogs");
  assert.doesNotMatch(v2, /\.id\s*=[^=]|setAttribute\(["']id["']/, "no new element gets an id (every id is static markup)");
  assert.doesNotMatch(v2, /console\./, "never logs anything");
  assert.doesNotMatch(v2, /[\u{1F000}-\u{1FFFF}☀-⛿✅❌✨]/u, "no emoji in code");
  assert.doesNotMatch(v2, /https?:\/\//, "no other website");
  // honesty: the rank line is information, never a criterion; no invented thresholds
  assert.match(v2, /For information only: rank does not decide the founder\./);
  assert.match(v2, /The first qualified claimer becomes Seed Steward at once/);
  assert.doesNotMatch(v2, /100_000|1_000_000|100,000|1,000,000/, "the founder amount comes from the server, never from this file");
  for (const t of ["Founder confirmed", "Seed Steward · probation", "Chosen · objections open", "In grace", "Applied · window open", "Opens at launch", "Qualified to challenge", "Qualified", "Set your home", "Home too new", "Below the bar", "Cooling down", "City has a founder", "Banned"]) assert.ok(v2.includes(`"${t}"`), `state pill: ${t}`);
  // the clock's length is the server's (founder.tenure.needed, which is POLICY.founder.qualifyingDays), never a number written here
  assert.match(v2, /\[`\$\{f\.tenure\.needed\}-day clock running`, "tag--gold"\]/, "state pill: the N-day clock from tenure.needed");
  assert.doesNotMatch(v2, /\d-day clock/, "no hardcoded clock length");
  for (const t of ["Not designed yet", "Live", "Contract being checked", "Designed"]) assert.ok(v2.includes(`"${t}"`), `coin state: ${t}`);
  for (const t of ["Design the city coin", "Add the contract", "See the coin", "Manage city coin", "Founder path", "Buy & swap"]) assert.ok(v2.includes(`"${t}"`), `founder card button: ${t}`);
});

test("the router: every tab has a panel and a tab link, legacy hashes map to tabs, the URL hash is never read as an element", () => {
  const VDash = loadV2();
  for (const t of VDash.TABS) { assert.equal(count("panel-" + t), 1, t); assert.equal(count("tab-" + t), 1, t); }
  assert.match(v2, /if \(TABS\.includes\(h\)\) return \{ tab: h, target: null, ok: true \};/, "a hash is a tab name first");
  assert.match(v2, /if \(ALIAS\[h\]\) return \{ tab: ALIAS\[h\], target: "#" \+ h, ok: false \};/, "then a legacy card hash");
  assert.match(v2, /return \{ tab: "home", target: null, ok: false \};/, "anything else is Home");
  assert.match(v2, /history\.scrollRestoration = "manual"/);
  assert.match(v2, /history\.pushState\(null, "", url\)/); assert.match(v2, /history\.replaceState\(null, "", url\)/);
  assert.match(v2, /window\.addEventListener\("hashchange", onHash\)/);
  assert.match(v2, /params\.get\("claim"\)\) \{ go\("founder"/, "?claim= opens the Founder tab at the founder path");
  assert.match(v2, /window\.V\.openProfile = \(\) => go\("profile"\)/, "the header button opens the Profile tab");
  assert.match(v2, /if \(tab === "profile" && ctx\) ctx\.openProfile\(\)/, "dashboard.js's opener still fills the profile fields");
  assert.match(v2, /if \(tab === "moderate" && !modOn\(\)\) \{ pending = "moderate"; tab = "home";/, "Moderate without rights lands on Home and waits for /api/mod");
  for (const k of ["ArrowRight", "ArrowLeft", "Home", "End"]) assert.ok(v2.includes(`e.key === "${k}"`), `keyboard: ${k}`);
  assert.match(v2, /aria-selected", String\(on\)\); t\.setAttribute\("tabindex", on \? "0" : "-1"\)/, "roving tabindex");
  assert.equal(VDash.active, "home");
});

/* ---------- the hooks in dashboard.js and dashboard-roles.js ---------- */
test("dashboard.js fetches dashboard-v2.js only when /api/me says dashboardV2 === true, before the page shows, and runs nothing new otherwise", () => {
  assert.equal((dash.match(/\/dashboard-v2\.js/g) || []).length, 1, "named once");
  assert.match(dash, /const tabbed = d\.dashboardV2 === true && d\.signedIn && d\.user && d\.user\.home;/);
  const start = dash.slice(dash.indexOf("/* ---------- start ----------"));
  assert.ok(start.indexOf('s.src = "/dashboard-v2.js"') < start.indexOf('$("#dash-main").hidden = false;'), "v2 is loaded and set up before the dashboard is shown");
  assert.ok(start.indexOf("v2.init(") < start.indexOf("render(d);"), "init runs before the first render");
  assert.match(start, /if \(!v2\) layoutInit\(\);/, "the two-column layout customiser is retired under v2");
  assert.match(start, /if \(v2\) v2\.start\(\);\s*else if \(location\.hash === "#profile"\)/, "the old #profile branch stays for the flag-off path");
  assert.match(start, /if \(!v2 && params\.get\("claim"\)\) \$\("#progress"\)\.scrollIntoView/, "the old ?claim scroll stays for the flag-off path");
  assert.ok(dash.includes("window.V.openProfile = openProfile") && dash.includes('"#profile"'), "what test/site.test.js pins is still there");
  // every call into v2 is guarded, so with v2 === null (the flag off, or the script failing to load) the old code runs exactly as before
  for (const call of ["v2.render(d)", "v2.mod(d)", "v2.coinQueue(list.length)"]) assert.ok(dash.includes(`if (v2) ${call}`), call);
  assert.match(dash, /const v2Coin = \(\) => \{ if \(v2\) v2\.coin\(\{ coin: coinData, vicMint \}\); \};/);
  assert.equal((dash.match(/v2Coin\(\);/g) || []).length, 3, "after the coin loads, after a design is saved, after a contract is sent");
  assert.match(dash, /seat\.status === "active" \|\| \(v2 && seat\.status === "steward"\)/, "a Seed Steward gets the studio only under v2 (the server allows both)");
  assert.match(dash, /if \(!tabbed\) \{ \$\("#dash-skel"\)\.hidden = true; if \(d\.dashboardV2 !== true\) \{ try \{ localStorage\.removeItem\(V2_KEY\); \} catch \{\} \} \}/, "the skeleton hint is dropped the moment the switch is off");
  assert.match(dash, /setTimeout\(\(\) => done\(null\), 4000\)/, "a slow or failing script falls back to today's dashboard");
});

test("dashboard-roles.js jumps through the tab router only when it exists", () => {
  assert.match(roles, /const scrollTo = \(target\) => \{ if \(window\.VDash\) return window\.VDash\.goTo\(target\); const t = \$\(target\); if \(t\) t\.scrollIntoView/);
  assert.match(roles, /const jump = \(label, target, cls\) => tool\(label, \(\) => scrollTo\(target\), cls\);/);
  assert.match(roles, /scrollTo\("#roles"\);/);
  assert.equal((roles.match(/scrollIntoView/g) || []).length, 1, "one scroll helper");
  for (const other of ["site.js", "cities.js", "home.js", "token.js", "launchpad.js", "connect.js", "wallets.js", "profile.js"]) assert.doesNotMatch(read(other), /dashboard-v2|VDash/, `${other} knows nothing about v2`);
});

test("the N-day clock the Founder tab shows is the server's: /api/me founder.tenure.needed is POLICY.founder.qualifyingDays whenever tenure is known", async () => {
  const env = newWorld({ DASHBOARD_V2: "on", VICINITY_MINT: MINT });
  const p = await person(env, { home: IN_UTICA, holds: 300_000 });
  const d = await p.get("/api/me");
  assert.equal(d.dashboardV2, true);
  assert.ok(d.founder.tenure, "launched and at home: tenure is known");
  assert.equal(d.founder.tenure.needed, POLICY.founder.qualifyingDays);
  assert.equal(typeof d.founder.tenure.days, "number");
});

/* ---------- the owner's runbook ---------- */
test("docs/DEPLOY.md: an open dashboard follows a DASHBOARD_V2 flip on reload, not at its minute refresh (the page reads the key once, when it loads)", () => {
  const deploy = readFileSync(new URL("../docs/DEPLOY.md", import.meta.url), "utf8");
  const from = deploy.indexOf("## Dashboard v2 switch"), to = deploy.indexOf("\n## ", from + 1);
  assert.ok(from > 0 && to > from, "the Dashboard v2 section");
  const sec = deploy.slice(from, to);
  assert.doesNotMatch(sec, /next refresh|a minute later/, "refresh() only re-renders what is open; it never swaps the layout");
  assert.match(sec, /reload/, "the runbook says reload");
  // and that is what the code does: the key is read in the start IIFE only, refresh() just renders, nobody reloads
  assert.match(dash, /async function refresh\(\) \{\s*const d = await api\("\/api\/me"\);\s*if \(d\.signedIn && d\.user\.home\) render\(d\);\s*\}/);
  assert.doesNotMatch(dash, /location\.reload/); assert.doesNotMatch(v2, /location\.reload/);
});
