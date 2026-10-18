// The owner's phone screenshot of 17 Oct 2026: the green-dot username pill and the small "G" avatar did the same thing, and the tabs
// were a row of words. Now:
//   * ONE avatar, top right, on every page (scripts/pages/build.mjs, public/site.js accountSheet): the member's initial in a 44 px button
//     (aria-haspopup, aria-expanded). No username pill: the username shows inside the account sheet the avatar opens, with the home
//     community, then Profile, Account and Settings (each an existing place of the dashboard) and Log out. A bottom sheet on a phone, a
//     small popover on a computer; the keyboard moves into it and stays there, Escape, the close button and a tap outside close it and
//     the keyboard goes back to the avatar. On the dashboard the three open in place (dashboard-v2.js V.accountGo).
//   * a phone's tab strip is icons (public/polish-dash.css D2c, dashboard-v2.js ICONS): one line icon per tab (24 viewBox, stroke 1.7),
//     each named (aria-label, said once: no title), the glass pill behind the chosen tab's icon and its name under it; the row scrolls
//     on its own with snap when the tabs do not fit, never the page. A computer keeps the words.
// The markup and the stylesheets are pinned here; the scripts run on the real built pages in the node DOMs of test/helpers. How it
// looks and moves (390 and 1440 px, both themes, reduced motion, a swipe down) is checked in real Chromium against the real Worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dispatch, newEvent, openPage } from "./helpers/pagedom.js";
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
    assert.match(header, /<button class="hdr-avatar" type="button" data-account-avatar aria-haspopup="dialog" aria-expanded="false" aria-controls="acct-panel" aria-label="Profile, account and settings" hidden><span class="hdr-avatar__face" data-account-initial aria-hidden="true"><\/span><\/button>/, f);
    assert.equal((h.match(/id="acct-sheet"/g) || []).length, 1, `${f}: one account sheet`);
    assert.equal((h.match(/id="acct-panel" role="dialog"/g) || []).length, 1, `${f}: the avatar controls the dialog itself, not its wrapper`);
    assert.doesNotMatch(h, /\sstyle="|<script>(?!<\/script>)|<style/, `${f}: nothing inline (the security policy)`);
  }
  assert.doesNotMatch(html, /dtab__av/, "the dashboard's strip has no second avatar");
});

test("the account sheet: a modal dialog named for what it is and whose (\"Your account, <username>\"), the username and home community at its top, then Profile, Account and Settings (existing places of the dashboard) and Log out; 44 px rows", () => {
  const sheet = html.match(/<div class="acct" id="acct-sheet" data-acct hidden>[\s\S]*?\n  <\/div>/)[0];
  assert.match(sheet, /<div class="acct__panel" id="acct-panel" role="dialog" aria-modal="true" aria-label="Your account" tabindex="-1">/, "named before /api/me answers too");
  assert.doesNotMatch(sheet, /aria-labelledby/, "never named by the username alone (a screen reader said only \"jo_utica, dialog\")");
  assert.match(sheet, /<p class="acct__name" data-acct-name>Your account<\/p>/);
  assert.match(sheet, /<nav class="acct__nav" aria-label="Account menu">/, "its links' landmark has a name of its own (not the dialog's again)");
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
  // and keeps the avatar's room unseen until the answer: !important, or style.css's [hidden] { display: none !important } wins and the
  // avatar pops in (the theme switch beside it moving 44 px on a computer)
  assert.match(polish, /:root:not\(\[data-guest\]\) \.hdr-avatar\[hidden\]:not\(\.is-off\) \{ display: inline-grid !important; visibility: hidden; \}/);
  assert.match(read("public/style.css"), /\[hidden\] \{ display: none !important; \}/, "(the rule it has to beat)");
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
  assert.equal(p.$("#acct-panel").getAttribute("aria-label"), "Your account, jo_utica", "the dialog's name");
  assert.equal(btn.getAttribute("aria-controls"), "acct-panel");
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
test("every tab has its line icon (24 viewBox, stroke 1.7, currentColor) and a name (aria-label), said once (no title), in today's order", () => {
  const ids = [...html.matchAll(/<a class="dtab" id="tab-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, TABS);
  const names = { home: "Home", wallet: "Wallet", city: "City", community: "Community feed", notify: "Notifications", rankings: "Rankings", founder: "Founder", moderate: "Moderate", profile: "Profile" };
  for (const id of TABS) {
    const t = tabTag(id);
    assert.match(t, new RegExp(`aria-label="${names[id]}"[ >]`), id);
    assert.doesNotMatch(t, /\stitle="/, `${id}: no title (review A11Y-2: a screen reader said the name again as its description)`);
    assert.match(t, /<span class="dtab__ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1\.7" stroke-linecap="round" stroke-linejoin="round" focusable="false">/, `${id}: the icon`);
    assert.match(t, /<span class="dtab__text( dtab__long)?">[^<]+<\/span>/, `${id}: its word (a computer, and under the icon when chosen on a phone)`);
  }
  // nine different icons
  const svgs = TABS.map((id) => tabTag(id).match(/<svg[\s\S]*?<\/svg>/)[0]);
  assert.equal(new Set(svgs).size, TABS.length);
});

test("polish-dash.css (a phone, up to 600 px): a floating opaque strip of icons on equal shares, 44 px+ targets, no Profile tab (the avatar), the chosen tab's name under its icon, the badge on the icon, the row scrolling on its own with snap; a computer keeps the words", () => {
  const phone = [...pdash.matchAll(/@media \(max-width: 600px\) \{\n[\s\S]*?\n\}/g)].map((m) => m[0]).find((b) => b.includes(".dtab__ico { display: grid;"));
  assert.ok(phone, "the D2c block");
  assert.match(v2, /const ICONS = "\(max-width: 600px\)";/, "the script's phone is the style's");
  assert.match(phone, /\.dv2 \.dtabs \{ top: calc\(var\(--header-h, 60px\) \+ 6px\); margin: 6px calc\(8px - var\(--wrap-pad, 16px\)\) var\(--dd-gap\); overflow: hidden; border: 0; border-radius: 16px;/, "inset and rounded like the header, sticky under it");
  // opaque: the strong glass colour laid on the page's own (an image layer over a colour), and no backdrop blur, so nothing scrolling
  // under it reads through (review: "Buy $VICINITY" and "Powered by Jupiter" showed through the icons in both themes)
  const stripRule = block(phone, ".dv2 .dtabs");
  assert.match(stripRule, /background: linear-gradient\(var\(--glass-bg-strong\), var\(--glass-bg-strong\)\), var\(--bg\);/);
  assert.match(stripRule, /-webkit-backdrop-filter: none; backdrop-filter: none;/);
  assert.doesNotMatch(stripRule, /background: var\(--glass-bg-strong\);|backdrop-filter: var\(--glass-blur\)/, "never the see-through glass");
  assert.match(phone, /\.dv2 #tab-profile \{ display: none; \}/, "Profile has no tab in a phone's strip: the header's avatar opens it");
  assert.match(phone, /box-shadow: inset 0 0 0 1px var\(--glass-border\), var\(--glass-hi\), 0 0 0 8px var\(--bg\), 0 -64px 0 8px var\(--bg\); \}/, "one calm band behind the header and the strip");
  assert.match(phone, /\.dv2 \.dtabs__list \{ gap: 0; padding: 4px; scroll-snap-type: x mandatory; scroll-padding-inline: 4px; \}/);
  assert.match(phone, /\.dv2 \.dtabs \.dtab \{ flex: 1 1 0; flex-direction: column; justify-content: flex-start; gap: 0; min-width: 44px; min-height: 52px;[^}]*scroll-snap-align: start; \}/);
  assert.match(phone, /\.dv2 \.dtabs\.is-scrollable \.dtab \{ flex: 0 0 44px; \}/, "a row that scrolls shows part of the next tab");
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
  // too many tabs for the row: the tight step, then the scroll step, never the words' steps
  Object.defineProperty(list, "clientWidth", { configurable: true, get: () => 374 });
  Object.defineProperty(list, "scrollWidth", { configurable: true, get: () => 420 });
  p.win.innerWidth = 391; p.win.dispatchEvent(newEvent("resize"));
  assert.deepEqual(["is-snug", "is-short", "is-compact", "is-flush", "is-scrollable"].filter((c) => strip.classList.contains(c)), ["is-flush", "is-scrollable"]);
  // the tight step is enough: no scroll step (and the strip is tight only while it has to be)
  let wide = 420;
  Object.defineProperty(list, "scrollWidth", { configurable: true, get: () => (strip.classList.contains("is-flush") ? 374 : wide) });
  p.win.innerWidth = 392; p.win.dispatchEvent(newEvent("resize"));
  assert.deepEqual(["is-flush", "is-scrollable"].filter((c) => strip.classList.contains(c)), ["is-flush"], "tight, and every tab fits");
  wide = 370;
  p.win.innerWidth = 393; p.win.dispatchEvent(newEvent("resize"));
  assert.deepEqual(["is-flush", "is-scrollable"].filter((c) => strip.classList.contains(c)), [], "they fit as they are: the strip stays lined up with the header");
  wide = 375; // one whole pixel too wide (a moderator's 8 tabs at a 375 px screen): flush, not a cut last tab
  p.win.innerWidth = 394; p.win.dispatchEvent(newEvent("resize"));
  assert.deepEqual(["is-flush", "is-scrollable"].filter((c) => strip.classList.contains(c)), ["is-flush"], "1 px over counts on a phone");
  // a computer: the whole tab again, and the words' steps (no phone step)
  wide = 420;
  phone = false;
  p.win.innerWidth = 1440; p.win.dispatchEvent(newEvent("resize"));
  assert.ok(strip.classList.contains("is-snug"), "a crowded computer strip tightens its words first");
  assert.equal(strip.classList.contains("is-flush"), false, "never a phone's step");
  assert.equal(ind.style.height, "52px", "the pill is the tab's box");
});

/* ---------- the review of 17 Oct 2026: fit at 360 px, the end fade, Profile only behind the avatar, one count, a still page ---------- */
test("narrow phones (.is-flush, only when the tabs do not fit as they are): 8 tabs of 44 px fit 375 and 360 px screens and 7 a 320 px one without the row scrolling (no inner padding; below 375 px the strip 4 px from the screen's edges)", () => {
  assert.match(pdash, /@media \(max-width: 600px\) \{ \.dv2 \.dtabs\.is-flush \.dtabs__list \{ padding-inline: 0; scroll-padding-inline: 0; \} \}/);
  const narrow = pdash.match(/@media \(max-width: 374px\) \{ \.dv2 \.dtabs\.is-flush \{ margin-inline: calc\(4px - var\(--wrap-pad, 16px\)\); \} \}/)[0];
  // the arithmetic from the rules themselves: the page's side padding on a phone (style.css .wrap, and the --wrap-pad it sets for it),
  // the strip's margin against it, the list's padding, and a tab's least width (its 44 px target)
  const style = read("public/style.css");
  const wrapPad = Number(style.match(/@media \(max-width: 480px\) \{ \.wrap \{ padding: 0 (\d+)px; \} \}/)[1]);
  assert.match(style, new RegExp(`@media \\(max-width: 480px\\) \\{ \\.wrap \\{ --wrap-pad: ${wrapPad}px; \\} \\}`), "--wrap-pad is the page's real side padding on a phone");
  const edge = wrapPad + Number(narrow.match(/calc\((\d+)px - var\(--wrap-pad, 16px\)\)/)[1]) - wrapPad; // the margin pulls the strip out of the padding
  const phone = [...pdash.matchAll(/@media \(max-width: 600px\) \{\n[\s\S]*?\n\}/g)].map((m) => m[0]).find((b) => b.includes(".dtab__ico { display: grid;"));
  const tabMin = Number(phone.match(/\.dv2 \.dtabs \.dtab \{[^}]*min-width: (\d+)px;/)[1]);
  assert.equal(tabMin, 44);
  const stripInset = Number(phone.match(/margin: 6px calc\((\d+)px - var\(--wrap-pad, 16px\)\)/)[1]), listPad = Number(phone.match(/\.dv2 \.dtabs__list \{ gap: 0; padding: (\d+)px;/)[1]);
  const row = (w) => w - 2 * stripInset - 2 * listPad, tight = (w) => (w < 375 ? w - 2 * edge : w - 2 * stripInset);
  assert.deepEqual([row(360), row(375), row(390)], [336, 351, 366]);
  assert.deepEqual([tight(320), tight(360), tight(375)], [312, 352, 359]);
  assert.ok(7 * tabMin <= row(360), `a member's 7 tabs at 360 px as they are (lined up with the header): ${7 * tabMin} of ${row(360)}`);
  assert.ok(7 * tabMin <= tight(320), `a member's 7 tabs at 320 px, tight: ${7 * tabMin} of ${tight(320)}`);
  assert.ok(8 * tabMin <= tight(360), `a moderator's 8 tabs at 360 px, tight: ${8 * tabMin} of ${tight(360)}`);
  assert.ok(8 * tabMin <= tight(375), `8 tabs at 375 px, tight (still lined up with the header): ${8 * tabMin} of ${tight(375)}`);
  assert.ok(8 * tabMin <= row(390), `8 tabs at 390 px as they are: ${8 * tabMin} of ${row(390)}`);
  // nothing pokes out of the last tab to make the row scroll: Moderate's badge is placed from the right, never past the tab's edge,
  // and 2 px clear of it (review UX-3: flush with the strip's edge at 320-375 px, its cap was cut by the strip's 16 px corner and
  // covered its border line; at 44 px the badge's left is at 24 px, beside the other badges' 50% + 4 px)
  assert.match(phone, /\.dv2 \.dtabs #tab-moderate \.dtab__badge \{ left: auto; right: max\(2px, calc\(50% - 22px\)\); \}/);
  assert.match(phone, /\.dv2 \.dtabs \.dtab__badge \{ position: absolute; top: 0; left: calc\(50% \+ 4px\); min-width: 18px;/);
  // and the name under the last tab, centred when it has room, pulled in from the right edge when it has not
  assert.match(phone, /\.dv2 \.dtabs #tab-founder \.dtab__text \{ right: max\(2px, calc\(50% - 2em\)\); \}/);
  assert.match(phone, /\.dv2 \.dtabs #tab-moderate \.dtab__text \{ right: max\(2px, calc\(50% - 2\.3em\)\); \}/);
});

test("dashboard-v2.js: a row that scrolls fades only the sides that have more (.is-scrolled on the left, no fade on the right at the end: .is-end)", async () => {
  const matchMedia = (q) => ({ matches: /reduce/.test(q) || /max-width: 600px/.test(q), addEventListener() {} });
  const p = await openDashboard({ me: memberMe({ wallet: ADDR }), storage: { vicinity_terms: "2026-10-01" }, globals: { matchMedia } });
  const list = p.$("#dash-tablist"), strip = p.$("#dash-tabs");
  let sl = 0;
  Object.defineProperty(list, "scrollLeft", { configurable: true, get: () => sl, set: (v) => { sl = v; } });
  Object.defineProperty(list, "clientWidth", { configurable: true, get: () => 312 });
  Object.defineProperty(list, "scrollWidth", { configurable: true, get: () => 352 });
  p.win.innerWidth = 320; p.win.dispatchEvent(newEvent("resize"));
  const fades = () => ["is-scrollable", "is-scrolled", "is-end"].filter((c) => strip.classList.contains(c));
  assert.deepEqual(fades(), ["is-scrollable"], "at the start: the right fade only");
  sl = 20; list.dispatchEvent(newEvent("scroll"));
  assert.deepEqual(fades(), ["is-scrollable", "is-scrolled"], "in the middle: both");
  sl = 38; list.dispatchEvent(newEvent("scroll"));
  assert.deepEqual(fades(), ["is-scrollable", "is-scrolled", "is-end"], "at the end (within 4 px): the left fade only, the last tab undimmed");
  assert.match(pdash, /\.dv2 \.dtabs\.is-scrollable\.is-end::after \{ opacity: 0; \}/);
  assert.match(v2, /\$\("#dash-tablist"\)\.addEventListener\("scroll", edges, \{ passive: true \}\);/);
});

test("a phone: Profile is not in the strip, the header's avatar opens it; on the Profile tab the pill leaves the strip, the avatar wears the current ring, the sheet's Profile row is the current place, the keys skip Profile and the strip's Tab stop is Home; a computer keeps its Profile tab", async () => {
  let phone = true;
  const matchMedia = (q) => ({ matches: /reduce/.test(q) || (phone && /max-width: 600px/.test(q)), addEventListener() {} });
  const p = await openDashboard({ me: memberMe({ wallet: ADDR, handle: "jo_utica" }), storage: { vicinity_terms: "2026-10-01" }, globals: { matchMedia } });
  const list = p.$("#dash-tablist"), strip = p.$("#dash-tabs"), av = p.$("[data-account-avatar]"), row = p.$('[data-acct-go="profile"]');
  const tabs = [...p.$$(".dtab")].filter((t) => !t.hidden && t.id !== "tab-profile");
  list.getBoundingClientRect = () => ({ left: 4, top: 70, width: 352, height: 60 });
  tabs.forEach((t, i) => {
    const left = 4 + i * 50;
    t.getBoundingClientRect = () => ({ left, top: 74, width: 50, height: 52 });
    t.querySelector(".dtab__ico").getBoundingClientRect = () => ({ left: left + 3, top: 77, width: 44, height: 30 });
  });
  const stops = () => [...p.$$(".dtab")].filter((t) => t.getAttribute("tabindex") === "0").map((t) => t.id);
  p.win.innerWidth = 360; p.win.dispatchEvent(newEvent("resize"));
  assert.ok(strip.classList.contains("has-ind"), "the pill behind Home");
  assert.deepEqual([av.classList.contains("is-current"), row.hasAttribute("aria-current"), stops()], [false, false, ["tab-home"]]);
  // the avatar's sheet: Profile
  av.click(); await p.flush();
  row.click(); await p.flush();
  assert.equal(p.win.VDash.active, "profile");
  assert.equal(p.$("#panel-profile").hidden, false);
  assert.equal(strip.classList.contains("has-ind"), false, "no pill left on a tab that is not chosen");
  assert.equal(av.classList.contains("is-current"), true, "the avatar wears the current ring");
  assert.equal(row.getAttribute("aria-current"), "true", "the sheet says where you are");
  assert.deepEqual(stops(), ["tab-home"], "the keyboard still reaches the strip (the chosen tab is not in it)");
  assert.equal(p.$("#tab-profile").getAttribute("aria-selected"), "true", "the tab semantics stay true for the panel");
  // the arrow keys and End never land on the tab that is not there
  p.$("#tab-home").focus();
  p.$("#dash-tablist").dispatchEvent(newEvent("keydown", { key: "End" })); await p.flush();
  assert.equal(p.doc.activeElement, tabs.at(-1), "End: the last tab in the strip");
  assert.notEqual(p.win.VDash.active, "profile");
  assert.deepEqual([av.classList.contains("is-current"), row.hasAttribute("aria-current")], [false, false], "another tab: the avatar is just the avatar again");
  // a computer (or a phone turned past 600 px): the Profile tab is in the strip again and is its own Tab stop
  phone = false;
  p.win.innerWidth = 1440; p.win.dispatchEvent(newEvent("resize"));
  p.win.VDash.go("profile"); await p.flush();
  assert.deepEqual([stops(), av.classList.contains("is-current"), row.getAttribute("aria-current")], [["tab-profile"], false, "true"]);
  assert.match(polish, /@media \(max-width: 600px\) \{\n  \.hdr-avatar\.is-current \.hdr-avatar__face \{ box-shadow: [^}]*0 0 0 4px var\(--pin\); \}/, "the ring: the chosen tab's ember");
});

test("the account sheet holds the page behind it still: html.acct-open from opening until it has gone (a phone: overflow hidden), and the dimmed page takes no finger-scroll", async () => {
  const p = await openPage("token.html", { agreed: "2026-10-01", me: ME });
  const root = p.doc.documentElement, btn = p.$("[data-account-avatar]");
  assert.equal(root.classList.contains("acct-open"), false);
  btn.click();
  assert.equal(root.classList.contains("acct-open"), true, "open: the page holds still");
  p.press("Escape");
  assert.equal(root.classList.contains("acct-open"), false, "closed (at once with reduced motion; else when the slide out ends): it scrolls again");
  btn.click(); p.$(".acct__scrim").click();
  assert.equal(root.classList.contains("acct-open"), false, "a tap outside too");
  assert.match(polish, /@media \(max-width: 600px\) \{ html\.acct-open \{ overflow: hidden; \} \}/);
  assert.match(polish, /\.acct__scrim \{[^}]*touch-action: none; \}/);
  assert.match(site, /move\(false, \(\) => \{ if \(state !== "closing"\) return; state = "closed"; sheet\.hidden = true; document\.documentElement\.classList\.remove\("acct-open"\); stopAnims\(\); \}\);/, "unlocked when the close has finished, not by a close that a new open overtook");
});

/* ---------- the recheck of 18 Oct 2026 (UX-2, UX-6, A11Y-1) ---------- */
test("leaving a page closes the account sheet at once (review A11Y-1): a page the browser keeps and brings back (the back/forward cache: an iPhone's swipe back, Android's Back) never comes back with the sheet up and the page held still", async () => {
  const p = await openPage("token.html", { agreed: "2026-10-01", me: ME });
  const root = p.doc.documentElement, btn = p.$("[data-account-avatar]"), sheet = p.$("#acct-sheet");
  const state = () => [sheet.hidden, btn.getAttribute("aria-expanded"), root.classList.contains("acct-open")];
  const fire = (type) => dispatch(p.window, newEvent(type, { bubbles: false, persisted: true }), p.window);
  btn.click();
  assert.deepEqual(state(), [false, "true", true], "open, the page held still");
  fire("pagehide"); // a link in the sheet (Profile, Account, Settings on another page), Log out, or Back
  assert.deepEqual(state(), [true, "false", false], "closed at once: no sheet, the avatar says so, the page scrolls");
  fire("pageshow");
  assert.deepEqual(state(), [true, "false", false], "and so it comes back");
  // the sheet works as before
  btn.click();
  assert.deepEqual(state(), [false, "true", true]);
  p.press("Escape");
  assert.deepEqual(state(), [true, "false", false]);
  fire("pagehide"); // a closed sheet: nothing to do
  assert.deepEqual(state(), [true, "false", false]);
  assert.match(site, /window\.addEventListener\("pagehide", \(\) => \{\n\s+if \(state === "closed"\) return;\n\s+stopAnims\(\); drag = null; panel\.style\.transform = "";\n\s+state = "closed"; sheet\.hidden = true;/, "a slide out on its way is stopped and finished too");
});

test("Log out, then Back to the page kept from before (review A11Y-1): it is drawn again for the signed-out person, never with the member's avatar and name; a page brought back otherwise is left as it was", async () => {
  const p = await openPage("token.html", { agreed: "2026-10-01", me: ME });
  const went = [];
  p.window.location = { assign: (u) => went.push(["assign", u]), reload: () => went.push(["reload"]) };
  const fire = (type) => dispatch(p.window, newEvent(type, { bubbles: false, persisted: true }), p.window);
  fire("pageshow");
  assert.deepEqual(went, [], "brought back without a Log out: as it was");
  p.$("[data-account-avatar]").click();
  p.$("[data-acct-logout]").click();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.ok(p.calls.some((c) => c.path === "/api/auth/logout"), "signed out");
  assert.deepEqual(went, [["assign", "/"]], "then the home page");
  fire("pagehide");
  assert.equal(p.$("#acct-sheet").hidden, true, "the sheet is not kept open");
  fire("pageshow");
  assert.deepEqual(went, [["assign", "/"], ["reload"]], "Back: the page loads again (signed out)");
});

test("a notched iPhone in a full-screen web view (review UX-2): the phone header sits under the status bar in the page as where it sticks, and --header-h (its bottom edge) follows, so the dashboard's strip, the anchors and the sheets stay under it; a Safari tab (inset 0) is unchanged", () => {
  const style = read("public/style.css");
  const phoneHeader = style.match(/@media \(max-width: 900px\) \{\n  :root \{ --header-h: [^}]+\}\n  \.site-header \{[^}]+\}/);
  assert.ok(phoneHeader, "the phone header's block sets --header-h with the header");
  assert.match(phoneHeader[0], /:root \{ --header-h: calc\(max\(8px, env\(safe-area-inset-top\)\) \+ 52px\); \}/);
  assert.match(phoneHeader[0], /\.site-header \{ top: max\(8px, env\(safe-area-inset-top\)\); width: auto; height: 52px; margin: max\(8px, env\(safe-area-inset-top\)\) 8px 0;/, "its place in the page is where it sticks (no overlap at the top of the page either)");
  // the arithmetic from the rules themselves, for a Safari tab (inset 0), an iPhone 14 (47 px) and an iPhone 15 Pro (59 px): where the
  // header sticks and how tall it is, against --header-h and the strip's sticky top (6 px under it; measured before: 33 and 45 px under)
  const [, varMin, varAdd] = phoneHeader[0].match(/--header-h: calc\(max\((\d+)px, env\(safe-area-inset-top\)\) \+ (\d+)px\)/).map(Number);
  const [, topMin] = phoneHeader[0].match(/\.site-header \{ top: max\((\d+)px, env\(safe-area-inset-top\)\);/).map(Number);
  const [, height] = phoneHeader[0].match(/\.site-header \{[^}]* height: (\d+)px;/).map(Number);
  const [, gap] = pdash.match(/\.dv2 \.dtabs \{ top: calc\(var\(--header-h, 60px\) \+ (\d+)px\);/).map(Number);
  for (const inset of [0, 47, 59]) {
    const headerBottom = Math.max(topMin, inset) + height, headerH = Math.max(varMin, inset) + varAdd;
    assert.equal(headerH, headerBottom, `inset ${inset}: --header-h is the header's bottom edge`);
    assert.equal(headerH + gap - headerBottom, 6, `inset ${inset}: the strip sticks 6 px under the header, never beneath it`);
  }
  assert.equal(Math.max(varMin, 0) + varAdd, 60, "a Safari tab: the same 60 px as before");
  assert.match(style, /--header-h: 60px; --sticky-top: calc\(var\(--header-h\) \+ 12px\);/, "(the token's value without an inset, and from 901 px 68)");
  // everything that sits under the header reads the variable
  assert.match(pdash, /\.dv2 \.dtabs \{ top: calc\(var\(--header-h, 60px\) \+ 6px\);/);
  assert.match(style, /scroll-padding-top: calc\(var\(--header-h\) \+ 16px\)/);
  assert.match(polish, /\.acct__panel \{ left: auto; bottom: auto; top: calc\(var\(--header-h\) \+ 8px\);/);
  assert.match(pdash, /\[data-page="dashboard"\] \.dv2-skel \.skel--tabs \{ height: 60px; margin: 6px calc\(8px - var\(--wrap-pad, 16px\)\) 0; border-radius: 16px; \}/, "the placeholder strip follows the header in the page too");
});

test("the phone tab bar is strong glass (review UX-6): page text scrolling under it never ghosts through its labels, like the dashboard's opaque strip and the scrolled header", () => {
  const style = read("public/style.css");
  const bar = style.match(/@media \(max-width: 900px\) \{\n  \.tabbar \{ display: grid;[^}]*\}/)[0];
  assert.match(bar, /background: var\(--glass-bg-strong\);/);
  assert.doesNotMatch(bar, /background: var\(--glass-bg\);/);
  assert.match(style, /\.site-header\.is-scrolled \{ background: var\(--glass-bg-strong\); \}/, "the same glass as the scrolled header");
});
