// Onboarding v3 on the dashboard: a member whose account has no wallet yet. The welcome moment (/dashboard?welcome=1, once), the
// 2-of-3 setup ring on the pass and in the welcome card, the link card (#wallet-card) that leads to /connect?mode=link (or straight
// into the wallet app on a phone), "Skip for now", the poll that sees the wallet arrive from a wallet app, the "link a wallet" words
// on the tiles, the role card, the badges and the composer, the profile row with Link / Unlink, and "log in again" in place of a
// wallet proof. Static checks pin the markup, the stylesheet and dashboard-v2.js's order. Runs the real page (test/helpers/dashpage.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { ADDR, UA, memberMe, openDashboard } from "./helpers/dashpage.js";

const read = (p) => readFileSync(new URL("../public/" + p, import.meta.url), "utf8");
const html = read("dashboard.html"), css = read("onboard.css"), dash = read("dashboard.js"), v2 = read("dashboard-v2.js");

/* ---------- static ---------- */
test("the dashboard page holds the welcome card, the link card, the two rings, the pass link and the profile row, all hidden markup, nothing inline", () => {
  for (const id of ["welcome", "welcome-title", "welcome-line", "welcome-ring", "welcome-ring-num", "welcome-ring-tick-location", "welcome-ring-tick-account", "welcome-ring-tick-wallet", "welcome-close",
    "pass-ring", "pass-ring-num", "me-link", "wallet-card", "wcard-kicker", "wcard-title", "wcard-lead", "wcard-perks", "wcard-city", "wcard-go", "wcard-other", "wcard-skip", "wcard-wait", "wcard-wait-text", "wcard-tiny",
    "profile-link", "profile-unlink", "proof-login", "ob-wallet", "ob-wallet-title"]) assert.equal((html.match(new RegExp(`\\bid="${id}"`, "g")) || []).length, 1, id);
  for (const id of ["welcome", "wallet-card", "pass-ring", "me-link", "profile-link", "profile-unlink", "proof-login", "wcard-wait", "wcard-other"]) {
    assert.match(html, new RegExp(`<[a-z]+ [^>]*id="${id}"[^>]* hidden>`), `${id} is hidden until a member needs it`);
  }
  assert.doesNotMatch(html, /\sstyle="/); assert.doesNotMatch(html, /\son[a-z]+="/); assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/); assert.doesNotMatch(html, /<style/);
  // the ring is an inline SVG whose arc is driven by one CSS variable the script sets (no inline style attribute, so the strict policy holds)
  assert.match(html, /<svg class="ring__svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle class="ring__track" cx="32" cy="32" r="26"\/><circle class="ring__arc" cx="32" cy="32" r="26"\/>/);
  assert.match(css, /\.ring__arc \{[^}]*stroke-dasharray: calc\(var\(--ring-done, 0\) \* 163\) 163;[^}]*transition: stroke-dasharray \.6s ease;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.ring__arc \{ transition: none; \} \}/);
  assert.match(dash, /host\.style\.setProperty\("--ring-done"/);
  assert.doesNotMatch(dash, /innerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  // the card's words
  assert.match(html, /<p class="kicker" id="wcard-kicker">Complete your profile · 2 of 3<\/p>/);
  assert.match(html, /<h2 id="wcard-title">Link your wallet<\/h2>/);
  assert.match(html, /Free: one signature, not a transaction\. Vicinity never asks for your recovery phrase or private key\./);
  assert.match(html, /<li>Your \$VICINITY balance and your rank among all holders<\/li>/);
  assert.match(html, /<li>The founder path for <span id="wcard-city">your city<\/span> and your city coin<\/li>/);
  assert.match(html, /<li>Badges and holder rewards<\/li>/);
  assert.match(html, /<a class="btn btn--primary btn--lg" id="wcard-go" href="\/connect\?mode=link">Link my wallet<\/a>/);
  assert.match(html, /<button class="link-btn" type="button" id="wcard-skip">Skip for now<\/button>/);
  assert.match(html, /You can unlink it any time from Profile\./);
  assert.match(html, /<a class="link-btn link-btn--tiny" id="me-link" href="\/connect\?mode=link" hidden>Link<\/a>/);
  assert.match(html, /<button class="btn btn--primary btn--block" type="button" id="proof-login" hidden>Log in again to confirm it's you<\/button>/);
  // the signed-out teaser no longer says the wallet comes first
  assert.doesNotMatch(html, /Connect your wallet to see your live rank/);
  assert.match(html, /<a class="btn btn--primary btn--lg" href="\/connect">Join or log in →<\/a>/);
});

test("onboard.css is loaded by /connect and /dashboard only, and every rule in it is scoped to the new pieces", () => {
  for (const f of readdirSync(new URL("../public/", import.meta.url)).filter((x) => x.endsWith(".html"))) {
    const linked = read(f).includes('<link rel="stylesheet" href="/onboard.css">');
    assert.equal(linked, f === "connect.html" || f === "dashboard.html", `${f}: onboard.css ${linked ? "is" : "is not"} linked`);
  }
  const rules = css.split("\n").filter((l) => /^\.[a-z]/.test(l));
  assert.ok(rules.length > 30);
  for (const l of rules) assert.match(l, /^\.(su-later|su-alt|su-why|link-top|link-skip|link-in|no-account|welcome|ring|wcard|stepper--two|alt-ways|cstate\[data-state="su-account"\])/, l.slice(0, 60));
  for (const sel of [".wcard", ".wcard--folded", ".wcard.is-done", ".ring", ".ring--sm", ".ring--pass", ".ring-row", ".welcome", ".welcome__ring", ".welcome__close"]) assert.ok(css.includes(sel + " "), `${sel} is styled`);
  // colours come from the site's tokens (the light theme follows by itself); no hard-coded text colour on the card
  const wcard = css.slice(css.indexOf("\n.wcard {")); // the card's own block (the row-span rule above names .wcard too)
  assert.doesNotMatch(wcard, /color: #[0-9a-f]{3,6}/i, "no hard-coded text colour on the link card");
});

test("dashboard-v2.js: ORDER.home has the welcome card first after the alerts and the link card right after the pass, both as hash aliases of Home", () => {
  const window = { V: {}, addEventListener() {} };
  vm.runInNewContext(v2, { window });
  const home = [...window.VDash.ORDER.home];
  assert.deepEqual(home, ["#pf-notice", "#ban-notice", "#lost-alert", "#welcome", "#dash-top", "#wallet-card", "#today", "#role-home", "#portfolio", "#badges", "#trade"]);
  assert.equal(window.VDash.ALIAS["wallet-card"], "home"); assert.equal(window.VDash.ALIAS.welcome, "home");
  assert.match(v2, /if \(!u\.wallet\) add\("Link your wallet", "Free, one signature\. Unlocks your holdings, rank, badges and the founder path\.", "ok", "home", "#wallet-card", true\);/);
  assert.match(v2, /const fallback = !d\.user\.wallet \? "link a wallet"/);
});

/* ---------- the page, as a member without a wallet ---------- */
test("a member without a wallet: the link card, the pass says No wallet linked · Link with a 2-of-3 ring, the tiles and the role card point at the link, holder badges need a wallet", async () => {
  const p = await openDashboard({ me: memberMe() });
  assert.equal(p.$("#dash-main").hidden, false);
  assert.equal(p.$("#welcome").hidden, true, "no welcome without ?welcome=1");
  const card = p.$("#wallet-card");
  assert.equal(card.hidden, false);
  assert.equal(p.text("#wcard-kicker"), "Complete your profile · 2 of 3");
  assert.equal(p.text("#wcard-city"), "Utica");
  assert.equal(p.text("#wcard-go"), "Link my wallet"); assert.equal(p.$("#wcard-go").getAttribute("href"), "/connect?mode=link");
  assert.equal(p.$("#wcard-other").hidden, true); assert.equal(p.$("#wcard-wait").hidden, true, "nothing is waited for");
  assert.equal(card.classList.contains("wcard--folded"), false);
  // the pass
  assert.equal(p.$("[data-me-wallet]").textContent, "No wallet linked"); assert.equal(p.$("#pass .pass__bottom [data-me-wallet]").classList.contains("mono"), false);
  assert.equal(p.$("#me-copy").hidden, true); assert.equal(p.$("#me-link").hidden, false);
  assert.equal(p.$("#pass-ring").hidden, false); assert.equal(p.text("#pass-ring-num"), "2/3");
  assert.equal(p.$("#pass-ring").style.getPropertyValue("--ring-done"), "0.667");
  assert.equal(p.$("#pass-ring").getAttribute("aria-label"), "Profile 2 of 3 complete: location and account done, wallet not linked");
  // the tiles
  assert.equal(p.text("#d-amount"), "—"); assert.equal(p.text("#d-amount-sub"), "link a wallet");
  assert.equal(p.text("#d-rank"), "—"); assert.equal(p.text("#d-rank-sub"), "link a wallet");
  // Today: the link first
  const today = p.$$("#today-list a");
  assert.match(today[0].textContent, /^Link your walletFree, one signature\./);
  assert.equal(today[0].getAttribute("href"), "#home"); assert.equal(today[0].dataset.go, "#wallet-card");
  // the role card
  assert.match(p.text("#role-home"), /Member of Utica\. You are in\. Link a wallet to see your \$VICINITY, your rank and your road to founding Utica\./);
  assert.ok(p.$$("#role-home a").some((a) => a.textContent === "Link my wallet" && a.getAttribute("href") === "/connect?mode=link"), "the role card's tool");
  // the badges: the locked tab says which ones need a wallet
  await p.tap(p.$('[data-btab="locked"]'));
  const locked = p.$$("#badge-grid li").map((li) => li.textContent.replace(/\s+/g, " ").trim());
  assert.ok(locked.some((t) => /Wallet linked$/.test(t)), "the wallet badge is open");
  assert.ok(locked.some((t) => /Holderneeds a wallet/.test(t)) && locked.some((t) => /Founder-readyneeds a wallet/.test(t)) && locked.some((t) => /Top 100needs a wallet/.test(t)), JSON.stringify(locked));
  // the founder path's first step is the server's
  assert.match(p.text("#p-steps li"), /^Link a wallet/);
  // the Rankings tab's tiles
  assert.equal(p.text("#rk-global-sub"), "link a wallet");
  assert.deepEqual(p.assigned, []);
});

test("a member with a wallet: no card, the pass shows the masked address with Copy, no ring, no 'Link your wallet' row", async () => {
  const p = await openDashboard({ me: memberMe({ wallet: ADDR }) });
  assert.equal(p.$("#wallet-card").hidden, true);
  assert.equal(p.$("[data-me-wallet]").textContent, "7Np41*****4K2"); assert.equal(p.$("#me-copy").hidden, false); assert.equal(p.$("#me-link").hidden, true);
  assert.equal(p.$("#pass-ring").hidden, true);
  assert.ok(!p.$$("#today-list a").some((a) => /Link your wallet/.test(a.textContent)));
  assert.equal(p.text("#d-amount-sub"), "live at launch");
  await p.tap(p.$('[data-btab="locked"]'));
  assert.ok(!p.$$("#badge-grid li").some((li) => /needs a wallet/.test(li.textContent)));
});

test("/dashboard?welcome=1: the welcome card once (city, first name, member number), the ring sweeps to 2 of 3, the parameter leaves the address bar, Dismiss hides it", async () => {
  const p = await openDashboard({ search: "welcome=1", me: memberMe() });
  const w = p.$("#welcome");
  assert.equal(w.hidden, false);
  assert.equal(p.text("#welcome-title"), "Welcome to Utica, Sa.");
  assert.equal(p.text("#welcome-line"), "You are member #12 here. Two of three steps done: link a wallet whenever you like.");
  assert.equal(p.text("#welcome-disc"), "UTICA");
  assert.equal(p.text("#welcome-ring-num"), "2/3");
  assert.equal(p.$("#welcome-ring").style.getPropertyValue("--ring-done"), "0.667", "reduced motion in this DOM: set at once (a 600 ms sweep otherwise)");
  assert.equal(p.$("#welcome-ring").getAttribute("aria-label"), "Profile 2 of 3 complete: location and account done, wallet not linked");
  assert.deepEqual(p.$$("#welcome-ring .ring__ticks li").map((li) => [li.textContent, li.classList.contains("is-done")]), [["Location done", true], ["Account done", true], ["Wallet open", false]]);
  assert.ok(p.addressBar.includes("https://vicinity.test/dashboard"), "the parameter was taken off the address bar");
  assert.ok(!p.addressBar.slice(1).some((u) => u.includes("welcome=1")));
  assert.equal(p.$("#wallet-card").hidden, false, "the link card follows the welcome");
  await p.tap(p.$("#welcome-close"));
  assert.equal(w.hidden, true);
  // the old toast is gone: the card is the welcome
  assert.ok(!p.toasts.some((t) => /Welcome to Vicinity/.test(t)), JSON.stringify(p.toasts));
});

test("a link started in this tab: the card says it is waiting for the wallet app and asks /api/me?lite=1 every 4 s while on screen, at once when the tab comes back, then the wallet arrives", async () => {
  let wallet = null;
  const p = await openDashboard({ search: "welcome=1", me: () => memberMe({ wallet }), session: { "vl-started": "1", "su-carry": "Phantom" } });
  assert.equal(p.$("#wcard-wait").hidden, false);
  assert.equal(p.text("#wcard-wait-text"), "Waiting for Phantom…");
  const lite = () => p.callsTo("/api/me?lite=1").length;
  const n0 = lite();
  await p.advance(4000); assert.equal(lite(), n0 + 1, "one ask after 4 s");
  await p.advance(8000); assert.equal(lite(), n0 + 3, "every 4 s");
  await p.setHidden(true);
  await p.advance(12000); assert.equal(lite(), n0 + 3, "nothing while the tab is in the background");
  await p.setHidden(false);
  assert.equal(lite(), n0 + 4, "at once when the tab comes back");
  // the wallet app linked the wallet
  wallet = ADDR;
  const meBefore = p.callsTo("/api/me").filter((c) => c.path === "/api/me").length;
  await p.advance(4000);
  assert.ok(p.toasts.includes("Wallet linked ✓"), JSON.stringify(p.toasts));
  assert.equal(p.session.has("vl-started"), false, "the start note is spent");
  assert.ok(p.callsTo("/api/me").filter((c) => c.path === "/api/me").length > meBefore, "everything is drawn again from /api/me");
  const card = p.$("#wallet-card");
  assert.equal(card.hidden, false); assert.ok(card.classList.contains("is-done"));
  assert.equal(p.text("#wcard-kicker"), "Profile complete · 3 of 3"); assert.equal(p.text("#wcard-title"), "Wallet linked ✓");
  assert.match(p.text("#wcard-lead"), /^7Np4…T4K2 is the wallet of your account\./);
  assert.equal(p.$("#wcard-actions").hidden, true); assert.equal(p.$("#wcard-wait").hidden, true);
  assert.equal(p.text("#welcome-ring-num"), "3/3"); assert.equal(p.$("#welcome-ring").style.getPropertyValue("--ring-done"), "1");
  assert.equal(p.$("#welcome-ring").getAttribute("aria-label"), "Profile 3 of 3 complete: location, account and wallet done");
  assert.equal(p.$("#pass-ring").hidden, true); assert.equal(p.$("[data-me-wallet]").textContent, "7Np41*****4K2");
  const n1 = lite();
  await p.advance(20000); assert.equal(lite(), n1, "the poll stopped");
});

test("the poll gives up after 15 minutes without a wallet (the note is forgotten, the card stops waiting) and never runs without the note", async () => {
  const p = await openDashboard({ me: memberMe(), session: { "vl-started": "1" } });
  assert.equal(p.text("#wcard-wait-text"), "Waiting for your wallet…");
  await p.advance(15 * 60_000 + 5000);
  assert.equal(p.session.has("vl-started"), false); assert.equal(p.$("#wcard-wait").hidden, true);
  const n = p.callsTo("/api/me?lite=1").length;
  await p.advance(60_000); assert.equal(p.callsTo("/api/me?lite=1").length, n);
  const q = await openDashboard({ me: memberMe() });
  const m = q.callsTo("/api/me?lite=1").length;
  await q.advance(30_000); assert.equal(q.callsTo("/api/me?lite=1").length, m, "no poll without a link started in this tab");
});

test("Skip for now folds the card to one line for this viewer (localStorage), the pass keeps No wallet linked · Link; a later visit opens folded", async () => {
  const p = await openDashboard({ me: memberMe() });
  await p.tap(p.$("#wcard-skip"));
  const card = p.$("#wallet-card");
  assert.equal(card.hidden, false); assert.ok(card.classList.contains("wcard--folded"));
  assert.equal(p.$("#wcard-perks").hidden, true); assert.equal(p.$("#wcard-skip").hidden, true); assert.equal(p.$("#wcard-tiny").hidden, true);
  assert.equal(p.text("#wcard-kicker"), "Your profile · 2 of 3"); assert.equal(p.text("#wcard-go"), "Link my wallet");
  assert.equal(p.local.get("vicinity:wcard-skip"), "1");
  assert.equal(p.$("#me-link").hidden, false); assert.equal(p.$("[data-me-wallet]").textContent, "No wallet linked");
  assert.ok(p.toasts.some((t) => /Link is on your pass/.test(t)));
  const q = await openDashboard({ me: memberMe(), storage: { "vicinity:wcard-skip": "1" } });
  assert.ok(q.$("#wallet-card").classList.contains("wcard--folded")); assert.equal(q.$("#wallet-card").hidden, false);
});

test("/dashboard?linked=1 (back from /connect's link mode): the card stays as Profile complete, a toast, the parameter leaves the address bar", async () => {
  const p = await openDashboard({ search: "linked=1", me: memberMe({ wallet: ADDR }) });
  assert.ok(p.toasts.includes("Wallet linked ✓"), JSON.stringify(p.toasts));
  assert.equal(p.$("#wallet-card").hidden, false); assert.ok(p.$("#wallet-card").classList.contains("is-done"));
  assert.equal(p.text("#wcard-kicker"), "Profile complete · 3 of 3");
  assert.ok(!p.addressBar.slice(1).some((u) => u.includes("linked=1")));
  assert.equal(p.$("#welcome").hidden, true);
});

test("a phone's Safari (no wallet in the browser): the button names the wallet app chosen before and opens it from /connect; else 'your wallet app'", async () => {
  const p = await openDashboard({ ua: UA.iphone, me: memberMe(), session: { "su-carry": "Phantom" } });
  assert.equal(p.text("#wcard-go"), "Link with Phantom"); assert.equal(p.$("#wcard-go").getAttribute("href"), "/connect?mode=link&app=phantom");
  assert.equal(p.$("#wcard-other").hidden, false); assert.equal(p.text("#wcard-other"), "Other wallet apps"); assert.equal(p.$("#wcard-other").getAttribute("href"), "/connect?mode=link");
  const q = await openDashboard({ ua: UA.iphone, me: memberMe() });
  assert.equal(q.text("#wcard-go"), "Link with your wallet app"); assert.equal(q.$("#wcard-go").getAttribute("href"), "/connect?mode=link"); assert.equal(q.$("#wcard-other").hidden, true);
});

test("the Profile tab: No wallet linked · Link without a wallet; the masked address with Copy and Unlink with one; Unlink asks, needs the server's yes, and refuses plainly", async () => {
  const p = await openDashboard({ me: memberMe() });
  p.win.V.openProfile();
  await p.flush();
  assert.equal(p.text("#profile-wallet"), "No wallet linked"); assert.equal(p.$("#profile-wallet").classList.contains("mono"), false);
  assert.equal(p.$("#profile-copy").hidden, true); assert.equal(p.$("#profile-link").hidden, false); assert.equal(p.$("#profile-unlink").hidden, true);
  // with a wallet
  const answers = [];
  let unlinked = false;
  const q = await openDashboard({ me: () => memberMe({ wallet: unlinked ? null : ADDR }), api: async (path) => { if (path === "/api/me/wallet/unlink") { const a = answers.shift(); if (a.ok) unlinked = true; return a; } } });
  q.win.V.openProfile(); await q.flush();
  assert.equal(q.text("#profile-wallet"), "7Np41*****4K2"); assert.equal(q.$("#profile-copy").hidden, false); assert.equal(q.$("#profile-link").hidden, true); assert.equal(q.$("#profile-unlink").hidden, false);
  answers.push({ ok: false, error: "seat_or_application" });
  await q.tap(q.$("#profile-unlink"));
  assert.match(q.confirms[0], /^Unlink this wallet\? Your rank, badges and founder eligibility go with it until you link one again\./);
  assert.ok(q.toasts.includes("Resign or withdraw first."), JSON.stringify(q.toasts));
  assert.equal(q.text("#profile-wallet"), "7Np41*****4K2", "nothing changed");
  answers.push({ ok: true });
  await q.tap(q.$("#profile-unlink")); await q.advance(100);
  assert.ok(q.toasts.includes("Wallet unlinked"));
  assert.equal(q.callsTo("/api/me/wallet/unlink").length, 2);
  assert.equal(q.text("#profile-wallet"), "No wallet linked"); assert.equal(q.$("#profile-unlink").hidden, true); assert.equal(q.$("#profile-link").hidden, false);
  assert.equal(q.$("#wallet-card").hidden, false, "the link card is back");
  // the person said no: nothing is sent
  const r = await openDashboard({ me: memberMe({ wallet: ADDR }), confirm: false });
  r.win.V.openProfile(); await r.flush();
  await r.tap(r.$("#profile-unlink"));
  assert.equal(r.callsTo("/api/me/wallet/unlink").length, 0);
});

test("a sensitive action answered reprove for a member without a wallet offers 'Log in again to confirm it's you' (no wallet list, no transfer); taken, it logs out to the log-in page", async () => {
  const p = await openDashboard({ me: memberMe(), api: async (path) => (path === "/api/me/username" ? { ok: false, error: "reprove" } : undefined) });
  p.win.V.openProfile(); await p.flush();
  p.$("#username-input").value = "NewName";
  p.$("#username-form").dispatchEvent(Object.assign(new (p.win.CustomEvent)("submit"), { preventDefault() {} }));
  await p.flush();
  assert.equal(p.$("#proof-modal").hidden, false);
  assert.equal(p.$("#proof-login").hidden, false); assert.equal(p.$("#proof-transfer").hidden, true);
  assert.equal(p.$("#proof-none").hidden, false); assert.match(p.text("#proof-none"), /^Your account has no wallet yet, so there is nothing to sign with\. Log in again to confirm it's you\./);
  assert.equal(p.$$("#proof-wallets button").length, 0);
  await p.tap(p.$("#proof-login"));
  assert.equal(p.callsTo("/api/auth/logout").length, 1);
  assert.deepEqual(p.assigned, ["/connect?mode=login"]);
  // with a wallet the proof modal is what it was: the wallet list and the transfer
  const q = await openDashboard({ me: memberMe({ wallet: ADDR }), api: async (path) => (path === "/api/me/username" ? { ok: false, error: "reprove" } : undefined) });
  q.win.V.openProfile(); await q.flush();
  q.$("#username-input").value = "NewName";
  q.$("#username-form").dispatchEvent(Object.assign(new (q.win.CustomEvent)("submit"), { preventDefault() {} }));
  await q.flush();
  assert.equal(q.$("#proof-modal").hidden, false); assert.equal(q.$("#proof-login").hidden, true); assert.equal(q.$("#proof-transfer").hidden, false);
});

test("an action the server answers no_wallet points at the link card ('Link a wallet first'); after launch the composer says a wallet comes first", async () => {
  const p = await openDashboard({ me: memberMe({ launched: true }), api: async (path) => (path === "/api/me/username" ? { ok: false, error: "no_wallet" } : path === "/api/posts" ? { ok: false, error: "holders_only" } : undefined) });
  assert.equal(p.$("#c-text").getAttribute("placeholder") || p.$("#c-text").placeholder, "Link a wallet and hold any $VICINITY to post.");
  p.win.V.openProfile(); await p.flush();
  p.$("#username-input").value = "NewName";
  p.$("#username-form").dispatchEvent(Object.assign(new (p.win.CustomEvent)("submit"), { preventDefault() {} }));
  await p.flush();
  assert.ok(p.toasts.includes("Link a wallet first"), JSON.stringify(p.toasts));
  // posting: the server's holders_only, in this member's words
  p.$("#c-text").value = "hello";
  p.$("#composer").dispatchEvent(Object.assign(new (p.win.CustomEvent)("submit"), { preventDefault() {} }));
  await p.flush();
  assert.equal(p.text("#c-err"), "Link a wallet and hold any $VICINITY to post.");
});
