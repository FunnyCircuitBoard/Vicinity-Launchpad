// The dashboard's first-paint hold and its ways out (the final site-wide check of 18 Oct 2026: SW-1, SW-2, EDGE-1..4).
// theme.js (in <head>, before the first paint) marks what this browser remembers; style.css then holds the page: a returning member's
// public roles wait for /api/me, a tabbed-dashboard browser shows its placeholders, the page is a screen tall. dashboard.js lifts the hold
// with what takes its place. These tests RUN the pieces: theme.js on the real built page (pagedom.js), the stylesheets' own rules on that
// page's state (minicss.js: their selectors, !important, specificity and order), and dashboard.js / dashboard-v2.js on the real page
// (dashpage.js); then they check what a browser would draw. How it looks is checked in real Chromium against the real Worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Doc, Target, dispatch, newEvent, parse } from "./helpers/pagedom.js";
import { computed, rulesOf } from "./helpers/minicss.js";
import { UA, memberMe, openDashboard } from "./helpers/dashpage.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const theme = read("public/theme.js");
const RULES = rulesOf(read("public/style.css") + "\n" + read("public/polish.css"));
const KEY = "vicinity:dash-v2", ACCOUNT = "vicinity-account";

/** What the stylesheets draw for an element of the page as it is now: "none", "unseen" (laid out, invisible) or "shown". */
const look = (el) => (computed(el, RULES, "display", "block") === "none" ? "none" : computed(el, RULES, "visibility", "visible") === "hidden" ? "unseen" : "shown");
/** The dashboard's first paint: the signed-out room, the placeholders, the public roles, and whether the page is held a screen tall. */
const paint = (doc) => {
  const $ = (s) => doc.querySelector(s);
  return { out: look($("#dash-out")), skel: look($("#dash-skel")), roles: look($("#roles")), screenTall: computed($("main"), RULES, "min-height", "auto") === "100vh" };
};
const REAL = { roles: "shown", skel: "none", screenTall: false }; // today's page: the roles, nothing held

/**
 * A built page in the browser's first moments: its markup parsed, theme.js run from <head> with this browser's storage, and nothing else
 * (no other script has run yet, or none ever will). The page's clock moves only when the test says so.
 */
function firstPaint(file, { stored = {}, throws = false, js = true } = {}) {
  const doc = new Doc();
  doc.append(...parse(doc, read(`public/${file}`)));
  const win = new Target();
  win.dispatchEvent = () => true;
  const store = new Map(Object.entries(stored)), timers = [];
  let now = 0;
  const localStorage = {
    getItem: (k) => { if (throws) throw new Error("blocked"); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { if (throws) throw new Error("blocked"); store.set(k, String(v)); },
    removeItem: (k) => { if (throws) throw new Error("blocked"); store.delete(k); },
  };
  if (js) vm.runInNewContext(theme, { document: doc, window: win, localStorage, CustomEvent: function CustomEvent(type, init) { return newEvent(type, init); },
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; } });
  return {
    doc, $: (s) => doc.querySelector(s), paint: () => paint(doc),
    flags: () => [...doc.documentElement.attrs.keys()].filter((k) => k.startsWith("data-")).map((k) => k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())).sort().join(","),
    /** Page time passes: every timer that falls due runs. */
    advance(ms) { now += ms; for (const t of timers) if (!t.done && t.at <= now) { t.done = true; t.fn(); } },
    /** An event on an element (capture from the window down, as a browser sends an element's error), or on the window itself. */
    fire(target, type, init = {}) {
      const ev = newEvent(type, { bubbles: false, ...init });
      if (target !== win) return dispatch(target, ev, win);
      ev.target = win; for (const l of win.listeners.filter((x) => x.type === type)) l.fn.call(win, ev); return true;
    },
    win,
  };
}

/* ---------- what the first paint holds (theme.js + style.css), and for whom ---------- */
test("the first paint, run (theme.js on the real page, style.css's rules on its state): a guest's signed-out room is held unseen over the roles; a returning member's roles wait and the page is a screen tall; a tabbed-dashboard browser shows its placeholders; storage that cannot be read and a page without JavaScript hold nothing (review EDGE-2)", () => {
  const cases = [
    ["a first visit", { stored: {} }, "guest", { out: "unseen", skel: "none", roles: "shown", screenTall: false }],
    ["a returning browser (signed in here before)", { stored: { [ACCOUNT]: "1" } }, "returning", { out: "none", skel: "none", roles: "none", screenTall: true }],
    ["the tabbed dashboard last time", { stored: { [ACCOUNT]: "1", [KEY]: "1" } }, "dashV2,returning", { out: "none", skel: "shown", roles: "none", screenTall: true }],
    ["only the tabbed key", { stored: { [KEY]: "1" } }, "dashV2,returning", { out: "none", skel: "shown", roles: "none", screenTall: true }],
    // storage blocked (site data off): nothing is known, so nothing is held: today's page, not a blank screen until /api/me answers
    ["storage that throws", { throws: true }, "", { out: "none", skel: "none", roles: "shown", screenTall: false }],
    ["no JavaScript", { stored: { [ACCOUNT]: "1", [KEY]: "1" }, js: false }, null, { out: "none", skel: "none", roles: "shown", screenTall: false }],
  ];
  for (const [name, opts, flags, want] of cases) {
    const p = firstPaint("dashboard.html", opts);
    if (flags !== null) assert.equal(p.flags(), flags ? `${flags},theme` : "theme", `${name}: what theme.js marks`);
    else assert.equal(p.flags(), "", `${name}: nothing marked`);
    assert.deepEqual(p.paint(), want, name);
  }
});

/* ---------- EDGE-1: every way out of the hold that does not depend on dashboard.js ---------- */
test("the hold always ends on real content (review EDGE-1): a page script that failed to load or threw, a promise nobody caught, no answer within 5 s, and Back to a page that left while held all give the roles back and drop the placeholders; a picture that failed to load does not", () => {
  const held = { out: "none", skel: "shown", roles: "none", screenTall: true };
  const stored = { [ACCOUNT]: "1", [KEY]: "1" };
  for (const script of ["/site.js", "/wallets.js", "/dashboard.js"]) {
    const p = firstPaint("dashboard.html", { stored });
    assert.deepEqual(p.paint(), held, "held before");
    p.fire(p.$(`script[src="${script}"]`), "error"); // its request failed (the element's error, which only the capture phase sees at the window)
    assert.deepEqual(p.paint(), { out: "none", ...REAL }, `${script} did not load: the roles, at once`);
    assert.equal(p.$("#dash-out").classList.contains("is-pending"), false);
  }
  {
    const p = firstPaint("dashboard.html", { stored });
    p.fire(p.win, "error", { message: "Cannot destructure property '$' of 'window.V'" }); // a script that threw (dashboard.js without site.js)
    assert.deepEqual(p.paint(), { out: "none", ...REAL }, "a script threw");
  }
  {
    const p = firstPaint("dashboard.html", { stored });
    p.fire(p.win, "unhandledrejection", { reason: new TypeError("W is undefined") }); // dashboard.js's start threw after an await
    assert.deepEqual(p.paint(), { out: "none", ...REAL }, "a rejection nobody caught");
  }
  {
    const p = firstPaint("dashboard.html", { stored });
    p.advance(4999);
    assert.deepEqual(p.paint(), held, "/api/me slow: still held at 4.999 s");
    p.advance(1);
    assert.deepEqual(p.paint(), { out: "none", ...REAL }, "no answer at 5 s: the roles");
  }
  {
    const p = firstPaint("dashboard.html", { stored });
    p.fire(p.win, "pageshow", { persisted: false });
    assert.deepEqual(p.paint(), held, "a normal load is not a way out");
    p.fire(p.win, "pageshow", { persisted: true }); // Back to a page the browser kept, left while it was held (the pending sign-in's redirect)
    assert.deepEqual(p.paint(), { out: "none", ...REAL }, "brought back by Back: the roles");
  }
  {
    const p = firstPaint("dashboard.html", { stored });
    const img = p.doc.createElement("img"); p.$("main").append(img);
    p.fire(img, "error");
    assert.deepEqual(p.paint(), held, "a picture that did not load changes nothing");
  }
  // a guest's held room gives way the same way (no answer: the roles at the top, not under a screen of nothing)
  {
    const p = firstPaint("dashboard.html", { stored: {} });
    p.advance(5000);
    assert.deepEqual(p.paint(), { out: "none", ...REAL }, "a guest, no answer");
  }
  // once dashboard.js has decided, the way out does nothing: the placeholders it shows while the tabbed code loads stay
  {
    const p = firstPaint("dashboard.html", { stored });
    p.$("#dash-skel").hidden = false; p.$("#dash-out").classList.remove("is-pending"); // dashboard.js: tabbed, in one task
    p.advance(5000); p.fire(p.win, "error"); p.fire(p.win, "pageshow", { persisted: true });
    assert.deepEqual(p.paint(), { out: "none", skel: "shown", roles: "none", screenTall: true }, "the dashboard's own placeholders, untouched");
  }
  // every page carries theme.js; one without the dashboard is left alone
  {
    const p = firstPaint("token.html", { stored });
    assert.doesNotThrow(() => { p.advance(5000); p.fire(p.win, "error"); p.fire(p.win, "pageshow", { persisted: true }); });
  }
});

test("dashboard.js: whatever throws on the way, the page is not left held (review EDGE-1): wallets.js missing, a broken answer, and the pending sign-in's redirect all end on the roles, never the placeholders or a blank screen", async () => {
  const stored = { [ACCOUNT]: "1", [KEY]: "1" };
  // (what theme.js marked before the first paint: these runs start after it)
  const asTheme = (p) => { p.doc.documentElement.dataset.theme = "dark"; p.doc.documentElement.dataset.returning = ""; p.doc.documentElement.dataset.dashV2 = ""; };
  const logged = [], globals = { console: { ...console, error: (e) => logged.push(e) } }; // the error still reaches the console
  // wallets.js did not load: dashboard.js throws at W.onChange, inside its start
  const a = await openDashboard({ ua: UA.iphone, storage: stored, without: ["wallets.js"], globals });
  asTheme(a);
  assert.deepEqual(paint(a.doc), { out: "none", ...REAL }, "wallets.js missing: the roles");
  assert.match(String(logged.at(-1)), /onChange/);
  // a signed-in answer the page cannot read (no user): it throws after the answer, before the dashboard shows
  const b = await openDashboard({ ua: UA.iphone, storage: stored, me: { ...memberMe(), user: null }, globals });
  asTheme(b);
  assert.deepEqual(paint(b.doc), { out: "none", ...REAL }, "a broken answer: the roles");
  assert.equal(logged.length, 2);
  // a sign-in in progress: off to /connect, and the page left behind is not held (Back brings it back as it was)
  const c = await openDashboard({ ua: UA.iphone, storage: stored, me: { ok: true, signedIn: false, pending: true, dashboardV2: true }, globals });
  asTheme(c);
  assert.deepEqual(c.assigned, ["/connect"]);
  assert.deepEqual(paint(c.doc), { out: "none", ...REAL }, "the redirect: unheld");
  assert.equal(logged.length, 2, "(nothing went wrong there)");
});

/* ---------- EDGE-4: the tabbed key, decided on a real answer ---------- */
test("the tabbed dashboard's key (review EDGE-4): forgotten on a real signed-out answer (a guest on a browser a member used gets no member placeholders next time), kept through an answer that failed (a member's next visit still starts with them)", async () => {
  const stored = { [ACCOUNT]: "1", [KEY]: "1" };
  const guest = await openDashboard({ storage: stored, me: { ok: true, signedIn: false, dashboardV2: true } });
  assert.equal(guest.local.get(KEY), undefined, "signed out (200): forgotten");
  assert.equal(guest.local.get(ACCOUNT), "1", "(site.js's own memory is not this key's business)");
  for (const failed of [{ ok: false, error: "server", _status: 500 }, { ok: false, error: "sign_in", _status: 401 }]) {
    const p = await openDashboard({ storage: stored, me: failed });
    assert.equal(p.local.get(KEY), "1", `an answer that failed (${failed._status}): kept`);
  }
  const off = await openDashboard({ storage: stored, me: memberMe({ dashboardV2: false }) });
  assert.equal(off.local.get(KEY), undefined, "the switch off: forgotten, as before");
  const on = await openDashboard({ storage: {}, me: memberMe() });
  assert.equal(on.local.get(KEY), "1", "a member on the tabbed dashboard: remembered");
});

/* ---------- EDGE-3: every Log out ---------- */
test("every Log out goes one way (review EDGE-3): the dashboard's Profile tab, its 'Log in again' and the account sheet sign out, forget the tabbed key, leave, and a page Back brings back is drawn again signed out", async () => {
  const p = await openDashboard({ ua: UA.iphone, storage: { [ACCOUNT]: "1" } });
  assert.equal(p.local.get(KEY), "1");
  const fire = (persisted) => { for (const l of p.win.listeners.filter((x) => x.type === "pageshow")) l.fn.call(p.win, newEvent("pageshow", { persisted })); };
  fire(true);
  assert.deepEqual(p.assigned, [], "brought back without a Log out: as it was");
  await p.tap(p.$("#profile-logout"));
  assert.equal(p.callsTo("/api/auth/logout").length, 1, "signed out");
  assert.deepEqual(p.assigned, ["/"], "then the home page");
  assert.equal(p.local.get(KEY), undefined, "the tabbed key is forgotten: the next person here gets no member placeholders");
  fire(false);
  assert.deepEqual(p.assigned, ["/"]);
  fire(true);
  assert.deepEqual(p.assigned, ["/", "reload"], "Back to this page: drawn again, signed out (it was the member's whole dashboard)");
  // the other ways out are the same call (the account sheet's Log out: test/phone-dash.test.js)
  const dash = read("public/dashboard.js"), site = read("public/site.js");
  assert.doesNotMatch(dash, /api\("\/api\/auth\/logout"/, "dashboard.js never signs out on its own");
  assert.equal((dash.match(/\blogout\(/g) || []).length, 4, "the Profile tab, the two 'Log in again', the wallet removal that needs a fresh login");
  assert.equal((site.match(/api\("\/api\/auth\/logout"/g) || []).length, 1, "one request in site.js: V.logout");
});

/* ---------- SW-1: jumps under a notched iPhone's status bar ---------- */
test("jumps land below the strip wherever the header is (review SW-1): a notched iPhone in a full-screen web view (header 59..111, strip stuck at 117..177): the account sheet's Account and Settings, VDash.goTo and a tab switch from far down", async () => {
  const p = await openDashboard({ ua: UA.iphone, me: { ...memberMe(), unread: 0 } }); // (unread: NOTIFY on, so Settings has its card)
  const header = p.$(".site-header"), strip = p.$("#dash-tabs"), dv2 = p.$("#dv2");
  assert.ok(header && strip && dv2);
  const rect = (top, h) => ({ top, bottom: top + h, left: 0, right: 430, width: 430, height: h, x: 0, y: top });
  header.getBoundingClientRect = () => rect(59, 52); // its place in the page is where it sticks (style.css): the same at any scroll
  Object.defineProperty(strip, "offsetHeight", { get: () => 60 });
  p.win.getComputedStyle = (e) => (e === strip ? { top: "117px", transform: "none" } : { transform: "none" });
  const scrolls = [];
  p.win.scrollTo = (o) => { scrolls.push(o); };
  // a card in a tab: its top lands 12 px under the strip's bottom (117 + 60)
  for (const sel of ["#profile-account", "#notice-prefs", "#roles-fold"]) {
    const target = p.$(sel);
    target.getBoundingClientRect = () => rect(1000, 300); // 1000 px down the page (scrollY 0)
    scrolls.length = 0;
    p.win.VDash.goTo(sel, { focus: false }); await p.flush();
    const top = scrolls.at(-1).top;
    assert.equal(1000 - top, 117 + 60 + 12, `${sel}: 12 px under the strip, not under it (the old 67 px header put it at 139, under the strip)`);
  }
  // the account sheet's Account and Settings go the same way (V.accountGo)
  for (const [row, place] of [["Account", "profile-account"], ["Settings", "notice-prefs"]]) {
    scrolls.length = 0;
    p.win.V.accountGo(place); await p.flush();
    assert.equal(1000 - scrolls.at(-1).top, 189, `the sheet's ${row}`);
    assert.equal(p.win.VDash.active, place === "notice-prefs" ? "notify" : "profile");
  }
  // a tab switch from far down: the dashboard's top comes back 8 px under the header (111), never under it
  p.win.scrollY = 1400;
  dv2.getBoundingClientRect = () => rect(500 - 1400, 3000); // #dv2 at 500 px in the page
  scrolls.length = 0;
  p.win.VDash.go("city"); await p.flush();
  assert.equal(500 - scrolls.at(-1).top, 111 + 8, "the tab switch");
  // no inset (a Safari tab: the header 8..60, the strip at 66): the same rules, the same 12 px
  header.getBoundingClientRect = () => rect(8, 52);
  p.win.getComputedStyle = (e) => (e === strip ? { top: "66px", transform: "none" } : { transform: "none" });
  p.win.scrollY = 0; scrolls.length = 0;
  p.win.VDash.goTo("#profile-account", { focus: false }); await p.flush();
  assert.equal(1000 - scrolls.at(-1).top, 66 + 60 + 12);
});

/* ---------- SW-2: without JavaScript ---------- */
test("without JavaScript the header keeps Log in (review SW-2): the rules that hold it back for a returning member apply only once theme.js has run; with it, a returning member's header holds the avatar's room unseen and no Log in until the answer", () => {
  for (const file of ["index.html", "token.html", "dashboard.html"]) {
    const off = firstPaint(file, { stored: { [ACCOUNT]: "1" }, js: false });
    assert.equal(look(off.$("[data-account]")), "shown", `${file}, no JavaScript: Log in`);
    assert.equal(look(off.$("[data-account-avatar]")), "none", `${file}, no JavaScript: no avatar room`);
    const back = firstPaint(file, { stored: { [ACCOUNT]: "1" } });
    assert.deepEqual([look(back.$("[data-account]")), look(back.$("[data-account-avatar]"))], ["none", "unseen"], `${file}, a returning member before the answer`);
    back.$("[data-account]").classList.add("is-shown"); back.$("[data-account-avatar]").classList.add("is-off"); // site.js: signed out after all
    assert.deepEqual([look(back.$("[data-account]")), look(back.$("[data-account-avatar]"))], ["shown", "none"], `${file}, the answer: signed out`);
    const guest = firstPaint(file, { stored: {} });
    assert.deepEqual([look(guest.$("[data-account]")), look(guest.$("[data-account-avatar]"))], ["shown", "none"], `${file}, a guest: Log in from the first paint`);
  }
});
