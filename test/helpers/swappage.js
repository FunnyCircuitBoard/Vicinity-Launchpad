// public/swap.js in node, for test/swap-ui.test.js, test/swap-ready.test.js and test/swap-links.test.js: the recorded shapes of
// the routes' answers, a wallet adapter as public/wallets.js shapes it, and a page with a [data-swap] slot running swap.js
// against canned answers. Timers come in two kinds:
//   queue (default)  every setTimeout is queued; flush() runs the short ones (< 10 s) in order and drops the rest, like a page
//                    nobody waits on (the 12 s refresh, the 40 s life of a built price)
//   clock: true      a fake clock: Date.now() and new Date() read it, timers fire when advance(ms) moves it past them, in time
//                    order; flush() only lets promises settle (the price's 40 s, its quiet rebuilds and the 1.5 s hold are about time)
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { Doc, Target, newEvent, parse } from "./pagedom.js";

const SWAP_JS = readFileSync(new URL("../../public/swap.js", import.meta.url), "utf8");
const WALLETS_JS = readFileSync(new URL("../../public/wallets.js", import.meta.url), "utf8");
export const SOL = "So11111111111111111111111111111111111111112", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", VIC = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
export const CITY = "EAXzD7eEJuFr8kfmqrrPBVuUNsd53PWHfsHuYFD8nPby", TAKER = "CnQMR167gRRXcPYrDZkwbW6moYKmxd7gZNGSN6BNzz6p";
export const CONFIG = { ok: true, swap: true, cluster: "mainnet", jupiter: { keyed: true, host: "api.jup.ag", rps: 10 }, maxSlippageBps: 5000, defaultSlippageBps: 100, platformFeeBps: 0,
  tokens: [{ mint: SOL, symbol: "SOL", name: "Solana", decimals: 9, kind: "sol" }, { mint: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, kind: "stable" }, { mint: VIC, symbol: "VICINITY", name: "Vicinity", decimals: 6, kind: "vicinity", stage: "jupiter" }, { mint: CITY, symbol: "DEMOV", name: "Demo Village", decimals: 6, kind: "city", stage: "curve", city: { name: "Demo Village" } }],
  launchpad: { enabled: true, cluster: "devnet" } };
export const QUOTE = (over = {}) => ({ ok: true, quoteId: "q1", source: "jupiter_build", estimate: false, inputMint: SOL, outputMint: VIC, decimals: { in: 9, out: 6 }, inAmount: "250000000", outAmount: "89166220238", minOut: "88274558036", inUi: "0.25", outUi: "89166.220238", minOutUi: "88274.558036", slippageBps: 100, priceImpactPct: "0.12", route: ["Raydium Launchlab"], routeText: "Routed by Jupiter · executed on Raydium Launchlab", inUsd: 37.56, outUsd: 37.45, fees: { networkLamports: 5000, priorityLamportsMax: 300, platformFeeBps: 0, rentLamports: 2039280 }, expiresAt: new Date(Date.now() + 12000).toISOString(), poweredBy: "Jupiter", chain: "solana:mainnet", cluster: "mainnet", ...over });
export const TX = (over = {}) => ({ ok: true, quoteId: "q1", tx: Buffer.from(new Uint8Array(300).fill(9)).toString("base64"), version: 0, bytes: 300, blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 4321, chain: "solana:mainnet", cluster: "mainnet", taker: TAKER, quote: QUOTE(), fees: { computeUnitLimit: 200000, computeUnitPrice: "1000", priorityLamports: 200, networkLamports: 5000, rentLamports: 2039280 }, ...over });
export const CURVE_QUOTE = (over = {}) => ({ ok: true, quoteId: "c1", source: "curve", side: "buy", inputMint: SOL, outputMint: CITY, decimals: { in: 9, out: 6 }, inAmount: "5000000", outAmount: "13286006275533", minOut: "13153146212777", inUi: "0.005", outUi: "13286006.275533", minOutUi: "13153146.212777", slippageBps: 100, priceImpactPct: "1.32", refund: "0", partialFill: false, route: ["Meteora bonding curve"], fees: { curveFeeBps: 125, networkLamports: 5000, split: {} }, chain: "solana:devnet", cluster: "devnet", poweredBy: "Meteora DBC", expiresAt: new Date(Date.now() + 12000).toISOString(), ...over });
export const SIG = new Uint8Array(64).fill(3);

/**
 * A wallet adapter as public/wallets.js shapes it. kind: send | sign | legacy. connectError: what connect() throws (an object's fields go on the Error).
 * silent: what connectSilently() answers (the account a wallet app already shares with this site, never a prompt): "trusted" (this
 * wallet's address), another address, null (nothing shared), "throw", or "hang" (no answer until answerSilent(value) is called).
 */
export function walletOf({ kind = "send", chains = ["solana:mainnet"], versions = ["legacy", 0], reject = false, address = TAKER, name = "Test Wallet", connectError = null, silent = null } = {}) {
  const calls = [];
  let late = null;
  return {
    name, icon: null, kind: kind === "legacy" ? "legacy" : "standard", chains, canSend: kind === "send", canSign: kind !== "legacy", txVersions: versions, calls,
    account: { address, chains },
    async connect() { calls.push(["connect"]); if (connectError) throw Object.assign(new Error(connectError.message || "no"), connectError); return address; },
    async connectSilently() {
      calls.push(["connectSilently"]);
      if (silent === "throw") throw new Error("User rejected the request.");
      if (silent === "hang") return new Promise((resolve) => { late = resolve; });
      return silent === "trusted" ? address : silent;
    },
    answerSilent(v) { if (late) late(v === "trusted" ? address : v); },
    async signAndSendTransaction(bytes, chain, options) { calls.push(["signAndSend", bytes.length, chain, options]); if (reject) throw new Error("User rejected the request"); return SIG; },
    async signTransaction(bytes, chain) { calls.push(["sign", bytes.length, chain]); if (reject) throw new Error("User rejected the request"); const out = new Uint8Array(bytes); out.fill(7, 1, 65); return out; },
  };
}

export const KNOWN = [{ id: "phantom", name: "Phantom", color: "#AB9FF2", match: /phantom/i, site: "https://phantom.com/download", open: (u) => `https://phantom.com/ul/browse/${encodeURIComponent(u)}` }, { id: "solflare", name: "Solflare", color: "#FC7227", match: /solflare/i, site: "https://solflare.com/download", open: (u) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(u)}` }, { id: "backpack", name: "Backpack", color: "#E33E3F", match: /backpack/i, site: "https://backpack.app/downloads", open: (u) => `https://backpack.app/ul/v1/browse/${encodeURIComponent(u)}` }];

/**
 * A page with `slot` (default: the token page's Buy panel) and swap.js running against `answers` (path -> body or (body, path) => body).
 *   wallets   the adapters wallets.js would list; isMobile: a phone
 *   href      the page's address (history.replaceState changes it; every replace is recorded in calls as { replace })
 *   clock     a fake clock (see above); canvas: canvases get a 2D context that records fillRect calls; qrcode: window.qrcode
 *   storage   window.localStorage: an object of its items (read and written in place), "throws" (every access throws, like a
 *             browser with site data blocked), or undefined (no localStorage at all); session: the same for window.sessionStorage
 *   here      inside a wallet app (site.js's V.walletApp.here()): the VW.KNOWN id of the app whose browser this is, null for none;
 *             left out: no V.walletApp at all (the panel's tests before wallet apps). inWalletApp: what VW.inWalletApp() says
 *   me        what site.js's V.ready (/api/me?lite=1) resolves to (left out: no V.ready)
 *   walletsJs { ua, touchPoints, webView, standard }: the REAL public/wallets.js runs (instead of the fake VW and `wallets`) in a
 *             browser with this user agent, and V.walletApp.here() is site.js's rule; `standard` = the Wallet Standard wallets already
 *             on the page when the scripts run; register(wallet) injects one later
 * Returns { doc, win, $, $$, calls, flush, advance, timers, pending, slot, VSwap, listeners, setHidden, location }.
 */
export async function swapPage({ answers = {}, wallets = [], isMobile = false, slot = `<div id="buy-slot" data-swap data-out="${VIC}" data-in="SOL" data-mode="buy" data-title="Buy $VICINITY"></div>`, href = "https://vicinity.test/token", clock = false, canvas = false, qrcode = undefined, head = "", storage = undefined, session = undefined, here = undefined, inWalletApp = false, me = undefined, walletsJs = null } = {}) {
  const doc = new Doc();
  doc.append(...parse(doc, `<html><body>${head}<div id="ca-links"></div>${slot}</body></html>`));
  const calls = [], timers = [], listeners = [];
  const answer = async (path, body) => { calls.push({ path, body }); const key = path.split("?")[0]; const a = answers[key] ?? answers[path]; if (a === undefined) return { ok: false, error: "not_found", _status: 404 }; return typeof a === "function" ? a(body, path) : a; };
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  if (canvas) {
    const make = doc.createElement.bind(doc);
    doc.createElement = (tag) => { const e = make(tag); if (String(tag).toLowerCase() === "canvas") { const ops = []; e.drawn = ops; e.getContext = () => ({ set fillStyle(v) { ops.push(["fill", v]); }, fillRect: (...a) => ops.push(["rect", ...a]) }); } return e; };
  }
  let hidden = false;
  Object.defineProperty(doc, "hidden", { get: () => hidden });
  const win = new Target();
  const location = { href, origin: new URL(href).origin };
  // the clock
  let now = Date.now();
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const DateFor = clock ? FakeDate : Date;
  const setT = (fn, ms = 0) => { timers.push({ fn, ms, due: now + Math.max(0, Number(ms) || 0) }); return timers.length; };
  const clearT = (id) => { if (timers[id - 1]) timers[id - 1] = null; };
  Object.assign(win, {
    document: doc, location, console, URL, URLSearchParams,
    history: { state: null, replaceState(state, title, url) { calls.push({ replace: url }); location.href = new URL(url, location.href).toString(); } },
    V: { $: (s, r = doc) => r.querySelector(s), $$: (s, r = doc) => r.querySelectorAll(s), el, api: (p) => answer(p), toast: (m) => calls.push({ toast: m }), copy: (t) => calls.push({ copy: t }), burst() {}, isAddr: (a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) },
    VW: { KNOWN, isMobile, isPhone: isMobile, inWalletApp: () => inWalletApp, list: () => wallets, onChange: (f) => { listeners.push(f); return () => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); }; }, knownFor: (n) => KNOWN.find((k) => k.match.test(n)) || null, safeIcon: () => null, mark: (n) => el("span", "wallet-mark", n[0]) },
    fetch: async (path, init) => { const body = init && init.body ? JSON.parse(init.body) : undefined; const d = await answer(path, body); const status = d && d._status ? d._status : d && d.ok === false ? 400 : 200; return { ok: status < 300, status, json: async () => d }; },
    setTimeout: setT, clearTimeout: clearT,
    AbortController, atob, btoa, Uint8Array, TextEncoder, Number, Math, JSON, Date: DateFor, Promise, Array, Object, String, Boolean, Error,
  });
  if (qrcode !== undefined) win.qrcode = qrcode;
  if (here !== undefined) win.V.walletApp = { here: () => (here ? KNOWN.find((k) => k.id === here) || null : null), remembered: () => null, remember() {} };
  if (me !== undefined) win.V.ready = me instanceof Promise ? me : Promise.resolve(me);
  const storageOf = (name, items) => {
    if (items === "throws") Object.defineProperty(win, name, { get() { throw new Error("SecurityError: the operation is insecure"); } });
    else if (items) win[name] = { getItem: (k) => (Object.prototype.hasOwnProperty.call(items, k) ? items[k] : null), setItem: (k, v) => { items[k] = String(v); }, removeItem: (k) => { delete items[k]; } };
  };
  storageOf("localStorage", storage); storageOf("sessionStorage", session);
  win.window = win;
  doc.defaultView = win;
  const ctx = vm.createContext(win);
  let register = null;
  if (walletsJs) {
    const { ua, touchPoints = /iPhone|Android/.test(ua) ? 5 : 0, webView = false, standard = [] } = walletsJs;
    win.navigator = { userAgent: ua, maxTouchPoints: touchPoints };
    win.V.webView = webView;
    delete win.VW;
    vm.runInContext(WALLETS_JS, ctx, { filename: "public/wallets.js" });
    // site.js's walletApp.here(): a phone with a known wallet on the page, or a wallet app that names itself in the user agent
    win.V.walletApp = { here() { const W = win.VW; if (!W || !W.isMobile) return null; for (const a of W.list()) { const k = W.knownFor(a.name); if (k) return k; } return webView ? W.KNOWN.find((k) => k.open && k.match.test(ua)) || null : null; }, remembered: () => null, remember() {} };
    register = (w) => { for (const l of win.listeners.filter((x) => x.type === "wallet-standard:register-wallet")) l.fn({ detail: (api) => api.register(w) }); };
    for (const w of standard) register(w);
  }
  vm.runInContext(SWAP_JS, ctx, { filename: "public/swap.js" });
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  /** Queue mode: runs the short timers (debounce, polls, the countdown) in order; anything of 10 s or more is dropped. Clock mode: promises settle, and timers already due run. */
  const flush = clock
    ? async () => { await settle(); await advance(0); }
    : async (n = 50) => { for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); const t = timers.findIndex(Boolean); if (t < 0) { if (i > 3) break; continue; } const { fn, ms } = timers[t]; timers[t] = null; if (ms < 10_000) fn(); } await settle(5); };
  /** Clock mode: moves the clock by `ms`, firing every timer that falls due on the way, in time order (promises settle after each). */
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      await settle();
      let next = -1;
      timers.forEach((t, i) => { if (t && t.due <= until && (next < 0 || t.due < timers[next].due)) next = i; });
      if (next < 0) break;
      const t = timers[next]; timers[next] = null;
      now = Math.max(now, t.due); t.fn();
    }
    now = until;
    await settle();
  }
  /** Pending timers, as their delays (ms), for asserting what is still scheduled. */
  const pending = () => timers.filter(Boolean).map((t) => t.ms);
  /** document.hidden, and the visibilitychange event a browser sends. */
  const setHidden = (v) => { hidden = v; doc.dispatchEvent(newEvent("visibilitychange")); };
  await flush();
  const $ = (s) => doc.querySelector(s);
  return { doc, win, $, $$: (s) => doc.querySelectorAll(s), calls, flush, advance, timers, pending, slot: $("#buy-slot"), VSwap: win.VSwap, listeners, setHidden, location, now: () => now, register };
}
export const paths = (calls) => calls.filter((c) => c.path).map((c) => c.path.split("?")[0]);
export const byPath = (calls, prefix) => calls.filter((c) => c.path && c.path.startsWith(prefix));
export const click = (e) => e.dispatchEvent(newEvent("click"));
export const text = (e) => (e ? e.textContent.trim() : null);
