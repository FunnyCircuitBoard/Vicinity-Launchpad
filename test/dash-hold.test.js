// The dashboard's first-paint hold and its ways out (the final site-wide check of 18 Oct 2026: SW-1, SW-2, EDGE-1..4; the final
// verification: FS-1, the hold's clock counts from DOMContentLoaded and a late answer never brings the placeholders back; HDR-1, the
// header's hold has the same way out; EDGE1-R, the page left for /connect stays held until it has left).
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
test("the hold always ends on real content (review EDGE-1): a page script that failed to load or threw, a promise nobody caught, no answer 12 s after the page's scripts ran, or scripts that never finish loading (20 s) give the roles back and drop the placeholders; a picture that failed to load does not", () => {
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
    p.advance(2000); p.fire(p.doc, "DOMContentLoaded"); // the page's scripts have run: dashboard.js has asked
    p.advance(11999);
    assert.deepEqual(p.paint(), held, "/api/me slow: still held 11.999 s after the scripts ran");
    p.advance(1);
    assert.deepEqual(p.paint(), { out: "none", ...REAL }, "no answer 12 s after they ran: the roles");
  }
  {
    const p = firstPaint("dashboard.html", { stored });
    p.advance(19999);
    assert.deepEqual(p.paint(), held, "scripts still loading at 19.999 s (DOMContentLoaded waits for them): held");
    p.advance(1);
    assert.deepEqual(p.paint(), { out: "none", ...REAL }, "scripts that never finish loading: the roles at 20 s");
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
    p.fire(p.doc, "DOMContentLoaded"); p.advance(12000);
    assert.deepEqual(p.paint(), { out: "none", ...REAL }, "a guest, no answer");
  }
  // once dashboard.js has decided, the way out does nothing: the placeholders it shows while the tabbed code loads stay
  {
    const p = firstPaint("dashboard.html", { stored });
    p.$("#dash-skel").hidden = false; p.$("#dash-out").classList.remove("is-pending"); // dashboard.js: tabbed, in one task
    p.fire(p.doc, "DOMContentLoaded"); p.advance(20000); p.fire(p.win, "error"); p.fire(p.win, "pageshow", { persisted: true }); p.advance(20000);
    assert.deepEqual(p.paint(), { out: "none", skel: "shown", roles: "none", screenTall: true }, "the dashboard's own placeholders, untouched");
  }
  // every page carries theme.js; one without the dashboard is left alone
  {
    const p = firstPaint("token.html", { stored });
    assert.doesNotThrow(() => { p.fire(p.doc, "DOMContentLoaded"); p.advance(20000); p.fire(p.win, "error"); p.fire(p.win, "pageshow", { persisted: true }); p.advance(20000); });
  }
});

/* ---------- FS-1: the clock counts the answer, not the page's download ---------- */
test("the hold's clock (final check FS-1): 12 s from DOMContentLoaded, when dashboard.js has asked, so a slow network's download of the page's scripts never counts (DevTools Slow 3G: DOMContentLoaded at 12.68 s, the old 5 s clock from <head> fired before dashboard.js ran); 20 s from <head> while the scripts still load; Back to a page left while held starts it again", () => {
  const stored = { [ACCOUNT]: "1", [KEY]: "1" };
  const held = { out: "none", skel: "shown", roles: "none", screenTall: true }, given = { out: "none", ...REAL };
  // Slow 3G, cold: the scripts finish at 12.68 s; the answer is then on its way, and the clock counts from there
  {
    const p = firstPaint("dashboard.html", { stored });
    p.advance(12680);
    assert.deepEqual(p.paint(), held, "12.68 s, the scripts just ran: held (the old clock had given up at 5 s)");
    p.fire(p.doc, "DOMContentLoaded");
    p.advance(7320);
    assert.deepEqual(p.paint(), held, "20 s from <head>: the cap no longer counts once the scripts have run");
    p.advance(4679);
    assert.deepEqual(p.paint(), held, "24.679 s: 11.999 s after the scripts ran");
    p.advance(1);
    assert.deepEqual(p.paint(), given, "24.68 s: 12 s after the scripts ran, no answer: the roles");
  }
  // a healthy but slow answer (a member's holder list rebuilt over RPC, 8 s at most): 6 s or 11 s after the page's scripts ran, held
  for (const ms of [6000, 11000]) {
    const p = firstPaint("dashboard.html", { stored });
    p.advance(1500); p.fire(p.doc, "DOMContentLoaded"); p.advance(ms);
    assert.deepEqual(p.paint(), held, `${ms / 1000} s after the scripts ran: still held`);
  }
  // Back to a page left while held (its answer still on its way): the clock starts again from the moment it shows, and the clock
  // from before no longer counts
  {
    const p = firstPaint("dashboard.html", { stored });
    p.fire(p.doc, "DOMContentLoaded"); p.advance(11000);
    p.fire(p.win, "pageshow", { persisted: false });
    assert.deepEqual(p.paint(), held, "a normal load is not a way out");
    p.fire(p.win, "pageshow", { persisted: true });
    assert.deepEqual(p.paint(), held, "brought back by Back: still held, not the roles at once");
    p.advance(1000);
    assert.deepEqual(p.paint(), held, "12 s after the scripts ran: the old clock was replaced");
    p.advance(10999);
    assert.deepEqual(p.paint(), held);
    p.advance(1);
    assert.deepEqual(p.paint(), given, "12 s after it showed again, no answer: the roles");
  }
});

/** What fills the top of the dashboard: the dashboard, the signed-out page, the placeholders, the roles (under a guest's held room), or nothing. */
const phase = (doc) => {
  if (!doc.querySelector("#dash-main").hidden) return "dashboard";
  const p = paint(doc);
  if (p.out === "shown") return "signed-out";
  if (p.skel === "shown") return "placeholders";
  if (p.roles === "shown") return p.out === "unseen" ? "held-room+roles" : "roles";
  return "blank";
};
/** The dashboard opened with theme.js and the stylesheets' rules, its /api/me answering after `meDelay`: the phases the top of the page goes through until `until` (ms), each with the page time it began. */
async function timeline(opts, until = 24000) {
  const p = await openDashboard({ ua: UA.iphone, theme: true, v2Delay: 800, ...opts });
  const seen = [[phase(p.doc), p.now]];
  while (p.now < until) {
    await p.advance(50);
    const now = phase(p.doc);
    if (now !== seen.at(-1)[0]) seen.push([now, p.now]);
  }
  return { p, phases: seen.map((x) => x[0]), at: Object.fromEntries(seen.map(([k, t]) => [k, t])) };
}

test("a late answer never brings the roles back after the placeholders, or the placeholders back after the roles (final check FS-1: 'placeholders -> roles -> placeholders -> dashboard', a guest's two full-screen jumps, CLS 1.86): theme.js, dashboard.js, dashboard-v2.js and the stylesheets' rules run together, /api/me answering at 6 s, 14 s or never", async () => {
  const signedOut = { ok: true, signedIn: false, dashboardV2: true };
  const runs = [
    // [who, storage, /api/me, its delay, the phases]
    // answered at 6 s (the old 5 s clock fired first): held until the answer, then what it opens; the placeholders while the tabbed code loads
    ["tabbed, answered at 6 s", { [ACCOUNT]: "1", [KEY]: "1" }, memberMe(), 6000, ["placeholders", "dashboard"]],
    ["account only, answered at 6 s", { [ACCOUNT]: "1" }, memberMe(), 6000, ["blank", "placeholders", "dashboard"]],
    ["a guest, answered at 6 s", {}, signedOut, 6000, ["held-room+roles", "signed-out"]],
    // answered after the clock (12 s from the scripts): the roles, then straight to what the answer opens, never the placeholders again
    ["tabbed, answered at 14 s", { [ACCOUNT]: "1", [KEY]: "1" }, memberMe(), 14000, ["placeholders", "roles", "dashboard"]],
    ["account only, answered at 14 s", { [ACCOUNT]: "1" }, memberMe(), 14000, ["blank", "roles", "dashboard"]],
    ["a guest, answered at 14 s", {}, signedOut, 14000, ["held-room+roles", "roles", "signed-out"]],
    // never answered: the roles, and they stay
    ["tabbed, never answered", { [ACCOUNT]: "1", [KEY]: "1" }, memberMe(), Infinity, ["placeholders", "roles"]],
  ];
  for (const [who, storage, me, meDelay, want] of runs) {
    const { phases, at } = await timeline({ storage, me, meDelay });
    assert.deepEqual(phases, want, who);
    const roles = phases.indexOf("roles");
    if (roles >= 0) {
      assert.equal(at.roles, 12000, `${who}: the roles at 12 s after the page's scripts ran, not before`);
      assert.ok(!phases.slice(roles).includes("placeholders"), `${who}: never the placeholders after the roles`);
    }
    if (meDelay === 6000) assert.equal(phases.includes("roles"), false, `${who}: never the roles`);
  }
  // theme.js gave up before dashboard.js ran (its 20 s cap: scripts that took longer to load): dashboard.js does not raise the
  // placeholders again over the roles; the answer goes from the roles to the dashboard
  {
    const { p, phases } = await timeline({ storage: { [ACCOUNT]: "1", [KEY]: "1" }, me: memberMe(), meDelay: 3000, atDefer: (doc) => {
      doc.querySelector("#dash-out").classList.remove("is-pending"); doc.querySelector("#dash-skel").hidden = true; // theme.js giveUp()
    } });
    assert.deepEqual(phases, ["roles", "dashboard"], "the cap fired first: the roles, then the dashboard");
    assert.equal(p.$("#dash-skel").hidden, true);
  }
});

/* ---------- EDGE1-R: the page left for /connect ---------- */
test("a sign-in in progress (final check EDGE1-R): the page stays held while it leaves for /connect (never the public roles at the top for as long as the navigation takes), lets go once it has left, and a page Back brings back shows the roles", async () => {
  for (const storage of [{ [ACCOUNT]: "1", [KEY]: "1" }, { [ACCOUNT]: "1" }]) {
    const p = await openDashboard({ ua: UA.iphone, theme: true, storage, me: { ok: true, signedIn: false, pending: true, dashboardV2: true } });
    assert.deepEqual(p.assigned, ["/connect"]);
    const tabbed = KEY in storage;
    assert.deepEqual(paint(p.doc), { out: "none", skel: tabbed ? "shown" : "none", roles: "none", screenTall: true }, "on the way out: held as it was");
    const fire = (type, init) => { for (const l of p.win.listeners.filter((x) => x.type === type)) l.fn.call(p.win, newEvent(type, init)); };
    fire("pagehide", { persisted: true });
    assert.deepEqual(paint(p.doc), { out: "none", ...REAL }, "left: unheld (what the back/forward cache keeps)");
    fire("pageshow", { persisted: true }); await p.advance(30000);
    assert.deepEqual(paint(p.doc), { out: "none", ...REAL }, "brought back by Back: the roles");
  }
});

/* ---------- HDR-1: the header's hold has the same way out ---------- */
test("the header's hold ends too (final check HDR-1): a returning browser that is signed out gets Log in when site.js did not load or threw, or its answer never comes (12 s after the page's scripts, 20 s while they load); another script's failure, or an answer already given, change nothing; a guest's header is never touched", () => {
  const stored = { [ACCOUNT]: "1" };
  const header = (p) => [look(p.$("[data-account]")), look(p.$("[data-account-avatar]"))];
  const HELD = ["none", "unseen"], LOGIN = ["shown", "none"];
  for (const file of ["token.html", "dashboard.html", "index.html"]) {
    {
      const p = firstPaint(file, { stored });
      assert.deepEqual(header(p), HELD, `${file}: held before the answer`);
      p.fire(p.doc, "DOMContentLoaded"); p.advance(11999);
      assert.deepEqual(header(p), HELD, `${file}: still held 11.999 s after the scripts ran`);
      p.advance(1);
      assert.deepEqual(header(p), LOGIN, `${file}: no answer: Log in, and the avatar's room goes`);
    }
    {
      const p = firstPaint(file, { stored });
      p.advance(20000);
      assert.deepEqual(header(p), LOGIN, `${file}: scripts that never finish loading: Log in at 20 s`);
    }
    {
      const p = firstPaint(file, { stored });
      p.fire(p.$('script[src="/site.js"]'), "error");
      assert.deepEqual(header(p), LOGIN, `${file}: site.js did not load: Log in at once`);
    }
    {
      const p = firstPaint(file, { stored });
      p.fire(p.win, "error", { filename: "https://vicinity.city/site.js", message: "boom" });
      assert.deepEqual(header(p), LOGIN, `${file}: site.js threw: Log in at once`);
    }
    {
      const p = firstPaint(file, { stored });
      p.fire(p.$('script[src="/swap.js"]'), "error"); p.fire(p.win, "error", { filename: "https://vicinity.city/swap.js" }); p.fire(p.win, "unhandledrejection");
      assert.deepEqual(header(p), HELD, `${file}: another script failed: site.js still answers, nothing flashes`);
    }
    {
      const p = firstPaint(file, { stored });
      p.$("[data-account]").hidden = true; p.$("[data-account-avatar]").hidden = false; // site.js: a member, the avatar
      p.fire(p.doc, "DOMContentLoaded"); p.advance(30000); p.fire(p.$('script[src="/site.js"]'), "error");
      assert.deepEqual(header(p), ["none", "shown"], `${file}: the member's avatar stays`);
      assert.equal(p.$("[data-account]").classList.contains("is-shown"), false);
    }
    {
      const p = firstPaint(file, { stored: {} });
      p.fire(p.doc, "DOMContentLoaded"); p.advance(30000);
      assert.deepEqual(header(p), LOGIN, `${file}: a guest: Log in from the first paint`);
      assert.deepEqual([p.$("[data-account]").classList.contains("is-shown"), p.$("[data-account-avatar]").classList.contains("is-off")], [false, false], `${file}: a guest's header untouched`);
    }
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
  // a sign-in in progress: off to /connect, and the page left behind is not held (Back brings it back as it was; held until it has
  // left: EDGE1-R below)
  const c = await openDashboard({ ua: UA.iphone, storage: stored, me: { ok: true, signedIn: false, pending: true, dashboardV2: true }, globals });
  asTheme(c);
  assert.deepEqual(c.assigned, ["/connect"]);
  for (const l of c.win.listeners.filter((x) => x.type === "pagehide")) l.fn.call(c.win, newEvent("pagehide", { persisted: true }));
  assert.deepEqual(paint(c.doc), { out: "none", ...REAL }, "the redirect, once the page has left: unheld");
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
