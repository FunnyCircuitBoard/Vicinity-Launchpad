// The real /dashboard page in node: the built public/dashboard.html with site.js, wallets.js, ticker.js, dashboard-roles.js and
// dashboard.js (and dashboard-v2.js, which dashboard.js loads when /api/me says dashboardV2) running on the just-enough DOM of
// pagedom.js. The test plays the server (`me` for /api/me, `api` for everything else), the browser (its user agent, whether the tab
// is on screen, its storage), the clock (timers and intervals run only when the test moves it) and the wallets in the browser.
// It checks what the page DOES: which request, which words, which element shows. How it looks is checked in real Chromium (the
// end-to-end runs). Modelled on connectpage.js.
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { Doc, Target, newEvent, parse } from "./pagedom.js";

const read = (f) => readFileSync(new URL("../../public/" + f, import.meta.url), "utf8");
export const UA = {
  desktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  phantomApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
};
export const ADDR = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const HOME = { id: "5142056", name: "Utica", country: "US", since: "2026-10-09T12:00:00Z" };

/** /api/me of a member (what src/me.js answers before launch), with every key the page reads. `wallet` null = onboarding v3, no wallet yet. */
export function memberMe({ wallet = null, handle = "SwiftHarbor10", name = "Sa Noyon", memberNumber = 12, launched = false, dashboardV2 = true, amount = 0, rank = null } = {}) {
  const linked = Boolean(wallet);
  return {
    ok: true, signedIn: true, signupFlow: "v2", ...(dashboardV2 ? { dashboardV2: true } : {}), providers: { google: true, email: true },
    user: { id: 12, wallet, provider: "google", handle, name, contact_email: null, phone: null, home: HOME, joined: "2026-10-09T12:00:00Z", hasPassword: false },
    launched, chain: launched ? "live" : "prelaunch", checkedAt: "2026-10-09T12:00:00Z", level: amount > 0 ? "holder" : "member", fresh: true, policyVersion: 5,
    setup: { percent: linked ? 100 : 67, steps: [{ id: "location", done: true }, { id: "account", done: true }, { id: "wallet", done: linked }] },
    roles: { admin: false, manager: false, founder: false, steward: false, holder: amount > 0, weight: 1 },
    holding: { amount, rank, total: rank ? 40 : null, percent: null, percentile: rank ? 5 : null, next: null, team: false },
    founder: { threshold: 100000, tenure: null, amount, eligible: false, why: linked ? "not_qualified" : "no_wallet", whyNot: null, challenging: null, homeReadyAt: null, cooldownUntil: null, application: null, seat: null },
    badges: [
      { id: "early", icon: "🌱", name: "Early member", detail: "Joined before launch.", earned: true },
      { id: "verified", icon: "✅", name: "Verified account", detail: "A verified Google login or e-mail.", earned: true },
      { id: "wallet", icon: "🔗", name: "Wallet linked", detail: "A Solana wallet linked to your account.", earned: linked },
      { id: "local", icon: "📍", name: "Local", detail: "Home community confirmed by location.", earned: true },
      { id: "holder", icon: "🏅", name: "Holder", detail: "Hold any $VICINITY.", earned: amount > 0, progress: 0 },
      { id: "founder_ready", icon: "🔑", name: "Founder-ready", detail: "Held the founder amount for 7 days.", earned: false, progress: 0 },
      { id: "top100", icon: "💯", name: "Top 100", detail: "One of the 100 biggest holders.", earned: false },
    ],
    lost: [],
    community: { id: HOME.id, name: HOME.name, country: "US", ticker: "UTICA", members: 12, memberNumber, rank: null, holders: null, top: [], seat: null, window: null, lastResult: null },
    national: { country: "US", members: 40, rank: null, holders: null, top: [], manager: null, election: null },
    squad: null, ban: null,
    progress: { percent: linked ? 33 : 17, steps: [
      { id: "account", label: linked ? "Account verified, wallet linked" : "Link a wallet", done: linked },
      { id: "home", label: "Home: Utica (7 days before applying)", done: true },
      { id: "hold", label: "Hold 100,000+ for 7 days", done: false, progress: 0, detail: "starts at launch" },
      { id: "apply", label: "Claim your city", done: false }, { id: "chosen", label: "Seated", done: false }, { id: "founder", label: "Confirmed founder", done: false }] },
  };
}

/**
 * openDashboard({ ua, search, me, api, storage, session, wallets, hidden }) → the page and the controls a test needs.
 *   me               what /api/me (and /api/me?lite=1) answers: a value, or a function called on every request (so a test can change it)
 *   api(path, body)  the server's answer to any other request (defaults below: empty feed, no moderator, no towns, no coin)
 *   storage/session  what this browser's localStorage / sessionStorage already hold
 *   wallets          Wallet Standard wallets in this browser ([] = none, like a phone's Safari)
 *   confirm          the answer to window.confirm (default true)
 */
export async function openDashboard({ ua = UA.desktop, search = "", me = memberMe(), api = async () => undefined, storage = {}, session: sessionStore = {}, wallets = [], confirm = true, touchPoints } = {}) {
  const doc = new Doc();
  doc.append(...parse(doc, read("dashboard.html")));
  let now = 0, seq = 0, hidden = false;
  const timers = [];
  const setTimeout_ = (fn, ms = 0) => { const id = ++seq; timers.push({ id, at: now + Math.max(0, Number(ms) || 0), fn }); return id; };
  const clearTimeout_ = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  // an interval is a timer that puts itself back when it runs (so advance() drives the page's polls)
  const setInterval_ = (fn, ms = 1000) => { const id = ++seq; const t = { id, at: now + Math.max(1, Number(ms) || 1), fn: () => { fn(); t.at = now + Math.max(1, Number(ms) || 1); timers.push(t); } }; timers.push(t); return id; };
  const replaced = [];
  const calls = [], assigned = [], toasts = [], confirms = [];
  // the page's clock follows page time (advance), so "15 minutes later" in a test is 15 minutes to the page too
  const base = Date.now();
  class PageDate extends Date { constructor(...a) { super(...(a.length ? a : [base + now])); } static now() { return base + now; } }
  const local = new Map(Object.entries(storage));
  const session = new Map(Object.entries(sessionStore));
  const store = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
  const loc = {
    origin: "https://vicinity.test", protocol: "https:", host: "vicinity.test", pathname: "/dashboard", search: search ? `?${search}` : "", hash: "",
    get href() { return this.origin + this.pathname + this.search + this.hash; },
    assign: (u) => assigned.push(u), reload: () => assigned.push("reload"),
    replace: (u) => { assigned.push(u); replaced.push(u); }, // a navigation that leaves no history entry (Back skips it): in `assigned` too, and in `replaced`
  };
  const addressBar = [loc.href];
  Object.defineProperty(doc, "hidden", { get: () => hidden, configurable: true });
  Object.defineProperty(doc, "visibilityState", { get: () => (hidden ? "hidden" : "visible"), configurable: true });
  const win = new Target();
  const meAnswer = () => (typeof me === "function" ? me() : me);
  const DEFAULT = {
    "/api/posts": { ok: true, posts: [], weekStart: "2026-10-05T00:00:00Z" }, "/api/mod": { ok: true, moderator: false }, "/api/towns": { ok: true, requests: [] },
    "/api/coins": { ok: true, coin: null, pairs: null, vicinity: null }, "/api/prices": { ok: true, prices: {} }, "/api/auth/logout": { ok: true },
  };
  Object.assign(win, {
    document: doc, location: loc,
    history: { state: null, scrollRestoration: "auto",
      replaceState: (st, title, url) => { const u = new URL(url, loc.origin); loc.pathname = u.pathname; loc.search = u.search; loc.hash = u.hash; addressBar.push(loc.href); },
      pushState: (st, title, url) => { const u = new URL(url, loc.origin); loc.pathname = u.pathname; loc.search = u.search; loc.hash = u.hash; addressBar.push(loc.href); } },
    navigator: { userAgent: ua, maxTouchPoints: touchPoints ?? (/iPhone|Android/.test(ua) ? 5 : 0), clipboard: { writeText: async () => {} } },
    localStorage: store(local), sessionStorage: store(session),
    matchMedia: () => ({ matches: true, addEventListener() {} }), // reduced motion: nothing animates, the ring is set at once
    fetch: async (path, init = {}) => {
      path = String(path);
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path, method: init.method || "GET", body, at: now });
      await null;
      let d;
      if (path === "/api/me" || path.startsWith("/api/me?")) d = meAnswer();
      else if (path === "/api/health" || path === "/api/official") d = { ok: true };
      else d = (await api(path, body)) ?? DEFAULT[path.split("?")[0]] ?? { ok: true };
      const status = d._status || (d.ok === false ? 400 : 200);
      return { ok: status < 400, status, json: async () => { const out = { ...d }; delete out._status; return out; } };
    },
    confirm: (q) => { confirms.push(q); return confirm; }, prompt: () => null,
    CustomEvent: function CustomEvent(type, init) { return newEvent(type, { detail: init && init.detail }); },
    URLSearchParams, URL, TextEncoder, TextDecoder, console, Date: PageDate, Promise, Intl,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    setTimeout: setTimeout_, clearTimeout: clearTimeout_, setInterval: setInterval_, clearInterval: clearTimeout_,
    requestAnimationFrame: (fn) => setTimeout_(fn, 16), performance: { now: () => now }, innerHeight: 844, scrollY: 0, scrollTo() {}, scrollBy() {},
  });
  win.window = win;
  win.addEventListener = Target.prototype.addEventListener.bind(win);
  win.removeEventListener = Target.prototype.removeEventListener.bind(win);
  win.dispatchEvent = (ev) => { for (const l of win.listeners.filter((x) => x.type === ev.type)) l.fn.call(win, ev); return true; };
  doc.defaultView = win;
  const ctx = vm.createContext(win);
  // dashboard.js loads /dashboard-v2.js and /profile.js with a <script> it appends to <head>: v2 runs here, profiles do not (the switch is off in these tests)
  const head = doc.querySelector("head");
  head.append = (s) => {
    if (s.src === "/dashboard-v2.js") { vm.runInContext(read("dashboard-v2.js"), ctx, { filename: "public/dashboard-v2.js" }); Promise.resolve().then(() => s.onload && s.onload()); }
    else Promise.resolve().then(() => s.onerror && s.onerror(new Error("not here")));
  };
  Object.defineProperty(doc, "head", { value: head });
  const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  /** Let `ms` of page time pass: every timer that falls due runs, in order (and what it starts, if it falls due too). */
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift(); now = t.at; t.fn(); await flush(5);
    }
    now = until; await flush();
  }
  for (const f of ["site.js", "wallets.js", "ticker.js", "dashboard-roles.js", "dashboard.js"]) vm.runInContext(read(f), ctx, { filename: `public/${f}` });
  const register = (w) => { for (const l of win.listeners.filter((x) => x.type === "wallet-standard:register-wallet")) l.fn({ detail: (a) => a.register(w) }); };
  for (const w of wallets) register(w);
  await flush();
  await advance(500); // the first look for older wallets (350 ms), the first animation frames
  // the toast's words, as they were shown (site.js hides the toast after 3 s of page time)
  const toastEl = doc.querySelector("#toast");
  const seen = new Set();
  const noteToast = () => { const t = toastEl.textContent; if (t && !toastEl.hidden && !seen.has(t + now)) { seen.add(t + now); toasts.push(t); } };
  const $ = (s) => doc.querySelector(s);
  const visible = (e) => Boolean(e && e.getClientRects().length);
  return {
    doc, win, $, $$: (s) => doc.querySelectorAll(s), calls, assigned, replaced, addressBar, local, session, timers, flush, confirms,
    advance: async (ms) => { await advance(ms); noteToast(); },
    get now() { return now; },
    get toasts() { noteToast(); return toasts; },
    /** The tab goes to the background (another app is in front) or comes back. */
    setHidden: async (h) => { hidden = h; for (const l of doc.listeners.filter((x) => x.type === "visibilitychange")) l.fn.call(doc, newEvent("visibilitychange")); await flush(); noteToast(); },
    visible,
    text: (s) => { const e = $(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : null; },
    tap: async (e) => { e.click(); await flush(); noteToast(); },
    callsTo: (p) => calls.filter((c) => c.path === p || c.path.startsWith(p + "?")),
  };
}
