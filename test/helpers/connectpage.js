// The real /connect page in node: the built public/connect.html with site.js, wallets.js and connect.js (and signup.js, which
// connect.js loads when /api/me says the sign-up is v2) running on the just-enough DOM of pagedom.js. The test plays the server
// (`api`), the browser (its user agent and whether the tab is on screen), the clock (timers run only when the test moves it) and the
// wallet (a Wallet Standard wallet whose connect / signMessage answer, refuse, or never answer). It checks what the page DOES:
// which request, which words, and where they show. How it looks is checked in real Chromium (the end-to-end runs).
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { Doc, Target, newEvent, parse } from "./pagedom.js";

const read = (f) => readFileSync(new URL("../../public/" + f, import.meta.url), "utf8");
export const UA = {
  desktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  phantomApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", // an app's WKWebView: no "Safari/"
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15", // iPadOS asks for the desktop site (+ touch)
  androidTablet: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", // no "Mobile": a tablet
};
export const ADDR = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
export const MESSAGE = "vicinity.test wants you to sign in with your Solana account:\n" + ADDR + "\n\nNonce: n1";

/** States of GET /api/signup/state the tests need (onboarding v3: two steps, no wallet). */
export const STATE = {
  empty: () => ({ terms: { done: false, version: "2026-10-01" }, location: { done: false }, account: { done: false }, next: "location" }),
  account: () => ({ terms: { done: false, version: "2026-10-01" }, location: { done: true, community: { id: "5142056", name: "Utica", country: "US" } }, account: { done: false }, next: "account" }),
  finish: () => ({ ...STATE.account(), terms: { done: true, version: "2026-10-01" }, account: { done: true, provider: "google" }, next: "finish" }),
};
/** /api/me of a member whose account has no wallet yet: the page lands in the link mode. */
export const LINK_ME = { signedIn: true, user: { id: 12, handle: "SwiftHarbor10", name: "Sa", wallet: null, home: { id: "5142056", name: "Utica", country: "US" } }, fresh: true };

/**
 * A Wallet Standard wallet. ctl.connect / ctl.sign: "ok" | "hang" (never answers) | "reject" (the person said no) | a function that
 * returns the raw answer. While a request hangs, ctl.answerConnect() / ctl.answerSign() answer it (late).
 */
export function fakeWallet(name = "Phantom") {
  const ctl = { connect: "ok", sign: "ok", connects: 0, signs: 0, messages: [], answerSign: null, answerConnect: null };
  const account = { address: ADDR, publicKey: new Uint8Array(32), chains: ["solana:mainnet"], features: ["solana:signMessage"] };
  const signature = () => new Uint8Array(64).fill(7);
  const wallet = {
    version: "1.0.0", name, icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", chains: ["solana:mainnet"], accounts: [],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => {
        ctl.connects++;
        const ok = { accounts: [account] };
        if (ctl.connect === "hang") return new Promise((resolve) => { ctl.answerConnect = () => resolve(ok); });
        if (ctl.connect === "reject") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        return ok;
      } },
      "solana:signMessage": { version: "1.0.0", signMessage: async ({ message }) => {
        ctl.signs++; ctl.messages.push(new TextDecoder().decode(message));
        const ok = [{ signedMessage: message, signature: signature() }];
        if (typeof ctl.sign === "function") return ctl.sign(message, signature());
        if (ctl.sign === "hang") return new Promise((resolve) => { ctl.answerSign = () => resolve(ok); });
        if (ctl.sign === "reject") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        return ok;
      } },
    },
  };
  return { wallet, ctl };
}

/**
 * openConnect({ ua, search, api, me, state, storage, session, agreed, geolocation }) → the page and the controls a test needs.
 *   api(path, body)  the server's answer to anything but /api/me, /api/health, /api/official and GET /api/signup/state (default { ok: true })
 *   me               merged into the /api/me answer (default: a visitor, sign-up v2, Google and e-mail on); a function: asked each time
 *   state            GET /api/signup/state's state (a value, or a function called each time)
 *   agreed           the Terms version already agreed in this browser (null: a first visit, the gate shows)
 *   session          what this tab's sessionStorage already holds (a reloaded tab keeps it), or "throws" (storage blocked: every call throws)
 *   setup            ({ doc, win }) => void, run before the page's scripts (e.g. to give elements a layout, which this DOM has none of)
 *   net(path)        the network itself, asked before any request is answered: undefined = answer as usual, "offline" = the request fails
 *                    (fetch throws, as with no connection), a promise = the answer waits until it resolves (a slow phone network)
 *   noSignupJs       true: /signup.js does not load (its <script> fails)
 */
export async function openConnect({ ua = UA.desktop, search = "", api = async () => ({ ok: true }), me = {}, state = STATE.empty(), storage = {}, session: sessionStore = {},
  agreed = "2026-10-01", geolocation, wallets = [], touchPoints, setup, net, noSignupJs = false } = {}) {
  const doc = new Doc();
  doc.append(...parse(doc, read("connect.html")));
  // time: only what the test lets pass
  let now = 0, seq = 0, hidden = false;
  const timers = [];
  const setTimeout_ = (fn, ms = 0) => { const id = ++seq; timers.push({ id, at: now + Math.max(0, Number(ms) || 0), fn }); return id; };
  const clearTimeout_ = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const calls = [], assigned = [];
  const local = new Map(Object.entries({ ...(agreed ? { vicinity_terms: agreed } : {}), ...storage }));
  const session = new Map(sessionStore === "throws" ? [] : sessionStore instanceof Map ? sessionStore : Object.entries(sessionStore));
  const store = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
  const blocked = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); }, removeItem() { throw new Error("SecurityError"); } };
  const loc = {
    origin: "https://vicinity.test", protocol: "https:", host: "vicinity.test", pathname: "/connect", search: search ? `?${search}` : "", hash: "",
    get href() { return this.origin + this.pathname + this.search + this.hash; },
    assign: (u) => assigned.push(u), reload: () => assigned.push("reload"),
  };
  const addressBar = [loc.href];
  Object.defineProperty(doc, "hidden", { get: () => hidden, configurable: true });
  const win = new Target();
  const meAnswer = () => ({ ok: true, signedIn: false, signupFlow: "v2", providers: { google: true, email: true }, ...(typeof me === "function" ? me() : me) });
  Object.assign(win, {
    document: doc, location: loc,
    history: { state: null, replaceState: (st, title, url) => { const u = new URL(url, loc.origin); loc.pathname = u.pathname; loc.search = u.search; loc.hash = u.hash; addressBar.push(loc.href); } },
    navigator: { userAgent: ua, maxTouchPoints: touchPoints ?? (/iPhone|Android/.test(ua) ? 5 : 0), ...(geolocation ? { geolocation } : {}) },
    localStorage: store(local), sessionStorage: sessionStore === "throws" ? blocked : store(session),
    matchMedia: () => ({ matches: true, addEventListener() {} }), // reduced motion: nothing animates
    fetch: async (path, init = {}) => {
      path = String(path);
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path, method: init.method || "GET", body, at: now, addressBar: loc.href });
      await null;
      const wire = net ? net(path) : undefined;
      if (wire === "offline") throw new TypeError("Failed to fetch");
      if (wire) await wire;
      let d;
      if (path === "/api/me" || path.startsWith("/api/me?")) d = meAnswer();
      else if (path === "/api/health" || path === "/api/official") d = { ok: true };
      else if (path === "/api/signup/state") d = { ok: true, state: typeof state === "function" ? state() : state };
      else d = (await api(path, body)) ?? { ok: true };
      const status = d._status || (d.ok === false ? 400 : 200);
      return { ok: status < 400, status, json: async () => { const out = { ...d }; delete out._status; return out; } };
    },
    CustomEvent: function CustomEvent(type, init) { return newEvent(type, { detail: init && init.detail }); },
    URLSearchParams, URL, TextEncoder, TextDecoder, console, Date, Promise,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    setTimeout: setTimeout_, clearTimeout: clearTimeout_, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, innerHeight: 844,
  });
  win.window = win;
  win.addEventListener = Target.prototype.addEventListener.bind(win);
  win.removeEventListener = Target.prototype.removeEventListener.bind(win);
  win.dispatchEvent = (ev) => { for (const l of win.listeners.filter((x) => x.type === ev.type)) l.fn.call(win, ev); return true; };
  doc.defaultView = win;
  const ctx = vm.createContext(win);
  // connect.js loads /signup.js with a <script> it appends to <head>: run it here
  const head = doc.querySelector("head");
  head.append = (s) => {
    if (s.src === "/signup.js" && !noSignupJs) { vm.runInContext(read("signup.js"), ctx, { filename: "public/signup.js" }); Promise.resolve().then(() => s.onload && s.onload()); }
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
  if (setup) setup({ doc, win });
  for (const f of ["site.js", "wallets.js", "connect.js"]) vm.runInContext(read(f), ctx, { filename: `public/${f}` });
  const register = (w) => { for (const l of win.listeners.filter((x) => x.type === "wallet-standard:register-wallet")) l.fn({ detail: (a) => a.register(w) }); };
  for (const w of wallets) register(w);
  await flush();
  await advance(400); // the first look for older wallets (350 ms)

  const $ = (s) => doc.querySelector(s);
  const visible = (e) => Boolean(e && e.getClientRects().length);
  return {
    doc, win, $, $$: (s) => doc.querySelectorAll(s), calls, assigned, addressBar, local, session, timers, flush, advance, register,
    get now() { return now; },
    /** The tab goes to the background (another app is in front) or comes back. */
    setHidden: async (h) => { hidden = h; if (!h) for (const l of doc.listeners.filter((x) => x.type === "visibilitychange")) l.fn.call(doc, newEvent("visibilitychange")); await flush(); },
    visible,
    /** The screen on show (the .cstate that is not hidden). */
    screen: () => doc.querySelectorAll(".cstate").find((x) => !x.hidden)?.getAttribute("data-state"),
    tap: async (e) => { e.click(); await flush(); },
    callsTo: (p) => calls.filter((c) => c.path === p || c.path.startsWith(p + "?")),
    /** The element right after `e` among its parent's elements. */
    next: (e) => { const sib = e.parentNode.children; return sib[sib.indexOf(e) + 1] || null; },
    scrolledTo: (e) => (doc.scrolled || []).some((x) => x.el === e),
  };
}
