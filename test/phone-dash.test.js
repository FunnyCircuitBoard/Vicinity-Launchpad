// The owner's phone screenshot of 17 Oct 2026: the green-dot username pill and the small "G" avatar did the same thing, and the tabs
// were a row of words. Now:
//   * ONE avatar, top right, on every page (scripts/pages/build.mjs, public/site.js accountSheet): the member's initial in a 44 px button
//     (aria-haspopup, aria-expanded). No username pill: the username shows inside the account sheet the avatar opens, with the home
//     community, then Profile, Account and Settings (each an existing place of the dashboard) and Log out. A bottom sheet on a phone, a
//     small popover on a computer; the keyboard moves into it and stays there, Escape, the close button and a tap outside close it and
//     the keyboard goes back to the avatar. On the dashboard the three open in place (dashboard-v2.js V.accountGo).
//   * a phone's tab strip is icons (public/polish-dash.css D2c, dashboard-v2.js ICONS): one line icon per tab (24 viewBox, stroke 1.7),
//     each named (aria-label) with a tooltip (title), the glass pill behind the chosen tab's icon and its name under it; the row scrolls
//     on its own with snap when the tabs do not fit, never the page. A computer keeps the words.
// The markup and the stylesheets are pinned here; the scripts run on the real built pages in the node DOMs of test/helpers. How it
// looks and moves (390 and 1440 px, both themes, reduced motion, a swipe down) is checked in real Chromium against the real Worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { newEvent, openPage } from "./helpers/pagedom.js";
import { ADDR, memberMe, openDashboard } from "./helpers/dashpage.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PAGES = readdirSync(new URL("../public/", import.meta.url)).filter((f) => f.endsWith(".html"));
const html = read("public/dashboard.html"), site = read("public/site.js"), v2 = read("public/dashboard-v2.js"), dash = read("public/dashboard.js");
const polish = read("public/polish.css"), pdash = read("public/polish-dash.css");
const TABS = ["home", "wallet", "city", "community", "notify", "rankings", "founder", "moderate", "profile"];
const ME = { ok: true, signedIn: true, user: { id: 2, handle: "jo_utica", name: "Jo", wallet: ADDR, home: { id: "5142056", name: "Utica", country: "US" } } };
const tabTag = (id) => html.match(new RegExp(`<a class="dtab" id="tab-${id}"[^>]*>[\\s\\S]*?</a>`))[0];
/** The text of a CSS block that starts with `head {` (one level of nested braces). */
const block = (css, head) => { const i = css.indexOf(head + " {"); assert.ok(i >= 0, head); let d = 0; for (let j = css.indexOf("{", i); j < css.length; j++) { if (css[j] === "{") d++; else if (css[j] === "}" && --d === 0) return css.slice(i, j + 1); } return ""; };

/* ---------- the header: one avatar, no username pill ---------- */
test("every page's header: Log in for a visitor, and one avatar button for a member (hidden until /api/me says so), wired to the account sheet; no second avatar, no inline style or script", () => {
  for (const f of PAGES) {
    const h = read("public/" + f), header = h.match(/<header class="site-header" data-header>[\s\S]*?<\/header>/)[0];
    assert.equal((header.match(/data-account-avatar/g) || []).length, 1, `${f}: one avatar`);
    assert.match(header, /<button class="hdr-avatar" type="button" data-account-avatar aria-haspopup="dialog" aria-expanded="false" aria-controls="acct-sheet" aria-label="Profile, account and settings" title="Profile, account and settings" hidden><span class="hdr-avatar__face" data-account-initial aria-hidden="true"><\/span><\/button>/, f);
    assert.equal((h.match(/id="acct-sheet"/g) || []).length, 1, `${f}: one account sheet`);
    assert.doesNotMatch(h, /\sstyle="|<script>(?!<\/script>)|<style/, `${f}: nothing inline (the security policy)`);
  }
  assert.doesNotMatch(html, /dtab__av/, "the dashboard's strip has no second avatar");
});

test("the account sheet: a modal dialog named by the username, the home community under it, then Profile, Account and Settings (existing places of the dashboard) and Log out; 44 px rows", () => {
  const sheet = html.match(/<div class="acct" id="acct-sheet" data-acct hidden>[\s\S]*?\n  <\/div>/)[0];
  assert.match(sheet, /<div class="acct__panel" role="dialog" aria-modal="true" aria-labelledby="acct-name" tabindex="-1">/);
  assert.match(sheet, /<p class="acct__name" id="acct-name" data-acct-name>Your account<\/p>/);
  assert.match(sheet, /<span data-acct-home><\/span>/);
  assert.match(sheet, /<button class="acct__x" type="button" data-acct-close aria-label="Close">/);
  assert.match(sheet, /<div class="acct__scrim" data-acct-close><\/div>/, "a tap outside (on the scrim) closes it");
  const links = [...sheet.matchAll(/<a class="acct__link" href="([^"]+)" data-acct-go="(\w+)">[\s\S]*?<strong>([^<]+)<\/strong><span>([^<]+)<\/span>/g)].map((m) => [m[2], m[1], m[3], m[4]]);
  assert.deepEqual(links, [
    ["profile", "/dashboard#profile", "Profile", "Username, bio and how members see you"],
    ["account", "/dashboard#profile-account", "Account", "Wallet, sign-in, e-mail and phone"],
    ["settings", "/dashboard#notice-prefs", "Settings", "Notifications: what you get told about"],
  ]);
  assert.match(sheet, /<button class="acct__out" type="button" data-acct-logout><svg [^>]*>[\s\S]*?<\/svg><span>Log out<\/span><\/button>/);
  // each place exists: the Profile tab, its Wallet (and sign-in) row, the notification settings
  assert.match(html, /<details class="fold profile__row" id="profile-account">\n\s*<summary><span class="fold__label" id="profile-account-h">Wallet<\/span>/);
  assert.match(html, /<section class="card nt-prefs" id="notice-prefs" aria-labelledby="ntp-title">/);
  assert.match(v2, /"profile-account": "profile" \};/, "the router knows the Account row's tab");
  // 44 px targets and the two shapes (polish.css)
  assert.match(polish, /\.hdr-avatar \{ position: relative; flex: none; display: inline-grid; place-items: center; width: 44px; height: 44px;/);
  assert.match(polish, /\.acct__link \{ display: flex; align-items: center; gap: 12px; min-height: 56px;/);
  assert.match(polish, /\.acct__x \{ flex: none; display: grid; place-items: center; width: 44px; height: 44px;/);
  assert.match(polish, /\.acct__out \{[^}]*min-height: 48px;/);
  assert.match(polish, /\.acct__panel \{ position: absolute; left: 0; right: 0; bottom: 0;/, "a phone: a bottom sheet");
  assert.match(block(polish, "@media (min-width: 601px)"), /\.acct__panel \{ left: auto; bottom: auto; top: calc\(var\(--header-h\) \+ 8px\); right: max\(var\(--gutter\), calc\(\(100% - 1152px\) \/ 2\)\); width: 360px;/, "a computer: a popover under the avatar");
  assert.match(site, /const SHEET_MQ = "\(max-width: 600px\)";/, "the script's phone is the style's");
  // a member's browser never flashes Log in before the avatar (theme.js data-guest, like Sign up)
  assert.match(polish, /:root:not\(\[data-guest\]\) \[data-account\]:not\(\.is-shown\) \{ display: none; \}/);
  assert.match(polish, /:root:not\(\[data-guest\]\) \.hdr-avatar\[hidden\]:not\(\.is-off\) \{ display: inline-grid; visibility: hidden; \}/);
  // motion: the Web Animations API, at once with reduced motion; site.js never names the tabbed dashboard (it hands over V.accountGo)
  assert.match(site, /if \(reducedNow\(\) \|\| typeof panel\.animate !== "function"\) \{ if \(done\) done\(\); return; \}/);
  assert.doesNotMatch(site, /VDash|dashboard-v2/);
});

test("site.js: signed in, the pill hides and the avatar shows the initial; it opens the sheet (the username, the home community, the keyboard on Profile), Tab stays inside, Escape, the close button and the scrim close it and the keyboard is back on the avatar", async () => {
  const p = await openPage("token.html", { agreed: "2026-10-01", me: ME });
  const pill = p.$("[data-account]"), btn = p.$("[data-account-avatar]"), sheet = p.$("#acct-sheet");
  assert.equal(pill.hidden, true, "no username pill");
  assert.equal(btn.hidden, false);
  assert.equal(p.$("[data-account-initial]").textContent, "J");
  assert.equal(btn.getAttribute("aria-label"), "Profile, account and settings (jo_utica)");
  assert.equal(p.$("[data-account-label]").textContent, "Log in", "the username is never written into the header");
  assert.equal(sheet.hidden, true);
  assert.deepEqual([p.$("[data-acct-name]").textContent, p.$("[data-acct-home]").textContent, p.$("[data-acct-initial]").textContent], ["jo_utica", "Utica, United States", "J"]);
  // open: the keyboard moves into the sheet
  btn.focus(); btn.click();
  assert.equal(sheet.hidden, false);
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  assert.equal(p.doc.activeElement, p.$('[data-acct-go="profile"]'), "the keyboard on Profile");
  // Tab from the last control (Log out) wraps to the first (Close); Shift+Tab from the first wraps to the last
  const stops = ["acct__x", "acct__link", "acct__link", "acct__link", "acct__out"];
  p.$("[data-acct-logout]").focus();
  p.press("Tab");
  assert.equal(p.doc.activeElement, p.$(".acct__x"), "wrapped to the first");
  p.press("Tab", { shift: true });
  assert.equal(p.doc.activeElement, p.$("[data-acct-logout]"), "and back to the last");
  const seen = [];
  for (let i = 0; i < stops.length; i++) { p.press("Tab"); seen.push(p.doc.activeElement.className.split(" ")[0]); }
  assert.deepEqual(seen, stops, "every stop is inside the sheet");
  // Escape closes, the keyboard is back on the avatar
  p.press("Escape");
  assert.equal(sheet.hidden, true);
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(p.doc.activeElement, btn);
  // the close button, the scrim (a tap outside), the avatar again
  btn.click(); p.$(".acct__x").click();
  assert.deepEqual([sheet.hidden, p.doc.activeElement === btn], [true, true], "the close button");
  btn.click(); p.$(".acct__scrim").click();
  assert.equal(sheet.hidden, true, "a tap outside");
  btn.click(); btn.click();
  assert.equal(sheet.hidden, true, "the avatar toggles it");
  // another page: the links are plain links to the dashboard (nothing intercepts them)
  btn.click();
  const ev = newEvent("click");
  p.$('[data-acct-go="account"]').dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, "the link goes to /dashboard#profile-account");
});

test("site.js: a visitor sees Log in (shown, for the pre-paint rule) and no avatar; a sign-in in progress says Finish sign-in", async () => {
  const out = await openPage("token.html", { agreed: "2026-10-01" });
  assert.equal(out.$("[data-account]").hidden, false);
  assert.ok(out.$("[data-account]").classList.contains("is-shown"));
  assert.equal(out.$("[data-account-avatar]").hidden, true);
  assert.ok(out.$("[data-account-avatar]").classList.contains("is-off"));
  const pending = await openPage("token.html", { agreed: "2026-10-01", me: { ok: true, signedIn: false, pending: { wallet: ADDR } } });
  assert.equal(pending.$("[data-account-label]").textContent, "Finish sign-in");
  assert.equal(pending.$("[data-account-avatar]").hidden, true);
});

test("the dashboard: the sheet's three open in place (no reload): Profile the Profile tab, Account its Wallet row (open), Settings the notification settings, or the Profile tab with notices off; the avatar follows a new username", async () => {
  const me = { ...memberMe({ wallet: ADDR, handle: "jo_utica" }), unread: 1 };
  let answer = me;
  const p = await openDashboard({ me: () => answer, storage: { vicinity_terms: "2026-10-01" } });
  const btn = p.$("[data-account-avatar]"), sheet = p.$("#acct-sheet");
  assert.equal(p.text("[data-account-initial]"), "J");
  assert.equal(p.$("[data-account]").hidden, true);
  const choose = async (k) => { btn.click(); await p.flush(); const ev = newEvent("click"); p.$(`[data-acct-go="${k}"]`).dispatchEvent(ev); await p.flush(); return ev; };
  let ev = await choose("account");
  assert.equal(ev.defaultPrevented, true, "in place");
  assert.equal(sheet.hidden, true, "the sheet closes");
  assert.equal(p.win.VDash.active, "profile");
  assert.equal(p.$("#profile-account").open, true, "the Wallet and sign-in row is open");
  assert.equal(p.doc.activeElement, p.$("#profile-account"), "the keyboard on it");
  ev = await choose("settings");
  assert.equal(p.win.VDash.active, "notify");
  assert.equal(p.doc.activeElement, p.$("#notice-prefs"));
  await choose("profile");
  assert.equal(p.win.VDash.active, "profile");
  assert.equal(p.doc.activeElement, p.$("#panel-profile"));
  // notices off (no `unread`): Settings is the Profile tab, never Home
  const q = await openDashboard({ me: memberMe({ wallet: ADDR, handle: "jo_utica" }), storage: { vicinity_terms: "2026-10-01" } });
  q.$("[data-account-avatar]").click(); await q.flush();
  q.$('[data-acct-go="settings"]').click(); await q.flush();
  assert.equal(q.win.VDash.active, "profile");
  // a new username (a refresh of /api/me): the avatar and the sheet follow
  answer = { ...me, user: { ...me.user, handle: "Morgan" } };
  await p.advance(61_000);
  assert.equal(p.text("[data-account-initial]"), "M");
  assert.equal(p.text("[data-acct-name]"), "Morgan");
  assert.match(dash, /if \(window\.V\.setAccount\) window\.V\.setAccount\(u\);/);
  assert.match(v2, /window\.V\.accountGo = \(hash\) => \{ if \(TABS\.includes\(hash\)\) \{ go\(hash\); byId\("panel-" \+ hash\)\.focus\(\{ preventScroll: true \}\); \} else goTo\("#" \+ hash\); \};/);
});

/* ---------- a phone's tabs: icons ---------- */
test("every tab has its line icon (24 viewBox, stroke 1.7, currentColor), a name (aria-label) and a tooltip (title), in today's order", () => {
  const ids = [...html.matchAll(/<a class="dtab" id="tab-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, TABS);
  const names = { home: "Home", wallet: "Wallet", city: "City", community: "Community feed", notify: "Notifications", rankings: "Rankings", founder: "Founder", moderate: "Moderate", profile: "Profile" };
  for (const id of TABS) {
    const t = tabTag(id);
    assert.match(t, new RegExp(`aria-label="${names[id]}" title="${names[id]}"`), id);
    assert.match(t, /<span class="dtab__ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1\.7" stroke-linecap="round" stroke-linejoin="round" focusable="false">/, `${id}: the icon`);
    assert.match(t, /<span class="dtab__text( dtab__long)?">[^<]+<\/span>/, `${id}: its word (a computer, and under the icon when chosen on a phone)`);
  }
  // nine different icons
  const svgs = TABS.map((id) => tabTag(id).match(/<svg[\s\S]*?<\/svg>/)[0]);
  assert.equal(new Set(svgs).size, TABS.length);
});

test("polish-dash.css (a phone, up to 600 px): a floating glass strip of icons on equal shares, 44 px+ targets, the chosen tab's name under its icon, the badge on the icon, the row scrolling on its own with snap; a computer keeps the words", () => {
  const phone = [...pdash.matchAll(/@media \(max-width: 600px\) \{\n[\s\S]*?\n\}/g)].map((m) => m[0]).find((b) => b.includes(".dtab__ico { display: grid;"));
  assert.ok(phone, "the D2c block");
  assert.match(v2, /const ICONS = "\(max-width: 600px\)";/, "the script's phone is the style's");
  assert.match(phone, /\.dv2 \.dtabs \{ top: calc\(var\(--header-h, 60px\) \+ 6px\); margin: 6px calc\(8px - var\(--wrap-pad, 16px\)\) var\(--dd-gap\); overflow: hidden; border: 0; border-radius: 16px;/, "inset and rounded like the header, sticky under it");
  assert.match(phone, /box-shadow: inset 0 0 0 1px var\(--glass-border\), var\(--glass-hi\), 0 0 0 8px var\(--bg\), 0 -64px 0 8px var\(--bg\); \}/, "one calm band behind the header and the strip");
  assert.match(phone, /\.dv2 \.dtabs__list \{ gap: 0; padding: 4px; scroll-snap-type: x mandatory; scroll-padding-inline: 4px; \}/);
  assert.match(phone, /\.dv2 \.dtabs \.dtab \{ flex: 1 1 0; flex-direction: column; justify-content: flex-start; gap: 0; min-width: 44px; min-height: 52px;[^}]*scroll-snap-align: start; \}/);
  assert.match(phone, /\.dv2 \.dtabs\.is-scrollable \.dtab \{ flex: 0 0 48px; \}/);
  assert.match(phone, /\.dv2 \.dtabs \.dtab__ico \{ display: grid; place-items: center; width: 44px; height: 30px; border-radius: 999px; \}/);
  assert.match(phone, /\.dv2 \.dtabs \.dtab__text \{ position: absolute; left: 50%; top: 35px;[^}]*opacity: 0;[^}]*\}/, "every name hidden under its icon");
  assert.match(phone, /\.dv2 \.dtabs \.dtab\[aria-selected="true"\] \.dtab__text \{ opacity: 1; transform: translate\(-50%, 0\); \}/, "but the chosen tab's");
  assert.match(phone, /\.dv2 \.dtabs \.dtab__short \{ display: none; \}/, "the whole name, never Rank or Mod");
  assert.match(phone, /\.dv2 \.dtabs \.dtab__badge \{ position: absolute; top: 0; left: calc\(50% \+ 4px\);/);
  // motion: the name's rise only when motion is welcome; a computer's strip is untouched (the icons hide from 601 px)
  assert.match(pdash, /@media \(prefers-reduced-motion: no-preference\) and \(max-width: 600px\) \{\n  \.dv2 \.dtabs \.dtab__text \{ transition: opacity/);
  assert.match(pdash, /\.dv2 \.dtab__ico \{ display: none; \}/);
  assert.match(pdash, /@media \(min-width: 1000px\) \{\n  \.dv2 \.dtabs \{ margin: 0 0 var\(--dd-gap\); border: 1px solid var\(--line\); border-radius: var\(--r-card, 18px\); \}/);
});

test("dashboard-v2.js on a phone: the glass pill sits behind the chosen tab's icon and follows it; the fit check only scrolls the row (no shortened words); a computer measures the whole tab", async () => {
  const ros = [];
  class RO { constructor(cb) { this.cb = cb; ros.push(this); } observe() {} }
  let phone = true;
  const matchMedia = (q) => ({ matches: /reduce/.test(q) || (phone && /max-width: 600px/.test(q)), addEventListener() {} });
  const p = await openDashboard({ me: memberMe({ wallet: ADDR }), storage: { vicinity_terms: "2026-10-01" }, globals: { ResizeObserver: RO, matchMedia } });
  const list = p.$("#dash-tablist"), strip = p.$("#dash-tabs"), ind = p.$("#dash-tablist .dtabs__ind");
  const tabs = [...p.$$(".dtab")].filter((t) => !t.hidden);
  // a 390 px phone: eight shares of 45.75 px, each icon 44 x 30 centred at the top of its tab
  list.getBoundingClientRect = () => ({ left: 8, top: 70, width: 374, height: 60 });
  tabs.forEach((t, i) => {
    const left = 12 + i * 45.75;
    t.getBoundingClientRect = () => ({ left, top: 74, width: 45.75, height: 52 });
    t.querySelector(".dtab__ico").getBoundingClientRect = () => ({ left: left + 0.875, top: 77, width: 44, height: 30 });
  });
  ros[0].cb();
  assert.equal(strip.classList.contains("has-ind"), true);
  assert.deepEqual({ t: ind.style.transform, w: ind.style.width, h: ind.style.height }, { t: "translate(4.88px, 7px)", w: "44px", h: "30px" }, "behind Home's icon");
  await p.tap(p.$("#tab-rankings"));
  const r = tabs.indexOf(p.$("#tab-rankings"));
  assert.equal(ind.style.transform, `translate(${Math.round((4.875 + r * 45.75) * 100) / 100}px, 7px)`, "behind Rankings' icon");
  // too many tabs for the row: only the scroll step, never the words' steps
  Object.defineProperty(list, "clientWidth", { configurable: true, get: () => 374 });
  Object.defineProperty(list, "scrollWidth", { configurable: true, get: () => 420 });
  p.win.innerWidth = 391; p.win.dispatchEvent(newEvent("resize"));
  assert.deepEqual(["is-snug", "is-short", "is-compact", "is-scrollable"].filter((c) => strip.classList.contains(c)), ["is-scrollable"]);
  // a computer: the whole tab again, and the words' steps
  phone = false;
  p.win.innerWidth = 1440; p.win.dispatchEvent(newEvent("resize"));
  assert.ok(strip.classList.contains("is-snug"), "a crowded computer strip tightens its words first");
  assert.equal(ind.style.height, "52px", "the pill is the tab's box");
});
