// public/swap.js in node (no browser): the panel's states and copy, which route it calls with what, wallet feature detection
// (signAndSendTransaction, signTransaction + our relay, a wallet that can do neither), the legacy-version flag, a phone with no
// wallet (deep links, no sign-up), curve coins handed over to the launchpad routes with the devnet chain, the price-impact
// guards, a stale quote refreshed before building, the bottom sheet, and that the panel never calls a session route. The real
// pages are checked in Chromium by the all-e2e harness; this is for regressions in what the controller DOES.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Doc, Target, newEvent, parse } from "./helpers/pagedom.js";

const SWAP_JS = readFileSync(new URL("../public/swap.js", import.meta.url), "utf8");
const SOL = "So11111111111111111111111111111111111111112", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", VIC = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
const CITY = "EAXzD7eEJuFr8kfmqrrPBVuUNsd53PWHfsHuYFD8nPby", TAKER = "CnQMR167gRRXcPYrDZkwbW6moYKmxd7gZNGSN6BNzz6p";
const CONFIG = { ok: true, swap: true, cluster: "mainnet", jupiter: { keyed: true, host: "api.jup.ag", rps: 10 }, maxSlippageBps: 5000, defaultSlippageBps: 100, platformFeeBps: 0,
  tokens: [{ mint: SOL, symbol: "SOL", name: "Solana", decimals: 9, kind: "sol" }, { mint: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, kind: "stable" }, { mint: VIC, symbol: "VICINITY", name: "Vicinity", decimals: 6, kind: "vicinity", stage: "jupiter" }, { mint: CITY, symbol: "DEMOV", name: "Demo Village", decimals: 6, kind: "city", stage: "curve", city: { name: "Demo Village" } }],
  launchpad: { enabled: true, cluster: "devnet" } };
const QUOTE = (over = {}) => ({ ok: true, quoteId: "q1", source: "jupiter_build", estimate: false, inputMint: SOL, outputMint: VIC, decimals: { in: 9, out: 6 }, inAmount: "250000000", outAmount: "89166220238", minOut: "88274558036", inUi: "0.25", outUi: "89166.220238", minOutUi: "88274.558036", slippageBps: 100, priceImpactPct: "0.12", route: ["Raydium Launchlab"], routeText: "Routed by Jupiter · executed on Raydium Launchlab", inUsd: 37.56, outUsd: 37.45, fees: { networkLamports: 5000, priorityLamportsMax: 300, platformFeeBps: 0, rentLamports: 2039280 }, expiresAt: new Date(Date.now() + 12000).toISOString(), poweredBy: "Jupiter", chain: "solana:mainnet", cluster: "mainnet", ...over });
const TX = (over = {}) => ({ ok: true, quoteId: "q1", tx: Buffer.from(new Uint8Array(300).fill(9)).toString("base64"), version: 0, bytes: 300, blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 4321, chain: "solana:mainnet", cluster: "mainnet", taker: TAKER, quote: QUOTE(), fees: { computeUnitLimit: 200000, computeUnitPrice: "1000", priorityLamports: 200, networkLamports: 5000, rentLamports: 2039280 }, ...over });
const SIG = new Uint8Array(64).fill(3);

/** A wallet adapter as public/wallets.js shapes it. kind: send | sign | legacy. */
function walletOf({ kind = "send", chains = ["solana:mainnet"], versions = ["legacy", 0], reject = false, address = TAKER } = {}) {
  const calls = [];
  const a = {
    name: "Test Wallet", icon: null, kind: kind === "legacy" ? "legacy" : "standard", chains, canSend: kind === "send", canSign: kind !== "legacy", txVersions: versions, calls,
    account: { address, chains }, async connect() { calls.push(["connect"]); return address; },
    async signAndSendTransaction(bytes, chain, options) { calls.push(["signAndSend", bytes.length, chain, options]); if (reject) throw new Error("User rejected the request"); return SIG; },
    async signTransaction(bytes, chain) { calls.push(["sign", bytes.length, chain]); if (reject) throw new Error("User rejected the request"); const out = new Uint8Array(bytes); out.fill(7, 1, 65); return out; },
  };
  return a;
}

/**
 * A page with a <div id="buy-slot" data-swap ...> and swap.js running against `answers` (path -> body or (body, path) => body).
 * Returns { $, calls, flush, win, slot, VSwap }. Timers are a queue the test drains with flush().
 */
async function page({ answers = {}, wallets = [], isMobile = false, slot = `<div id="buy-slot" data-swap data-out="${VIC}" data-in="SOL" data-mode="buy" data-title="Buy $VICINITY"></div>`, href = "https://vicinity.test/token" } = {}) {
  const doc = new Doc();
  doc.append(...parse(doc, `<html><body><div id="ca-links"></div>${slot}</body></html>`));
  const calls = [], timers = [], listeners = [];
  const answer = async (path, body) => { calls.push({ path, body }); const key = path.split("?")[0]; const a = answers[key] ?? answers[path]; if (a === undefined) return { ok: false, error: "not_found", _status: 404 }; return typeof a === "function" ? a(body, path) : a; };
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const win = new Target();
  const KNOWN = [{ id: "phantom", name: "Phantom", color: "#AB9FF2", match: /phantom/i, site: "https://phantom.com/download", open: (u) => `https://phantom.com/ul/browse/${encodeURIComponent(u)}` }, { id: "solflare", name: "Solflare", color: "#FC7227", match: /solflare/i, site: "https://solflare.com/download", open: (u) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(u)}` }, { id: "backpack", name: "Backpack", color: "#E33E3F", match: /backpack/i, site: "https://backpack.app/downloads", open: (u) => `https://backpack.app/ul/v1/browse/${encodeURIComponent(u)}` }];
  Object.assign(win, {
    document: doc, location: { href, origin: "https://vicinity.test" }, console,
    V: { $: (s, r = doc) => r.querySelector(s), $$: (s, r = doc) => r.querySelectorAll(s), el, api: (p) => answer(p), toast: (m) => calls.push({ toast: m }), copy: (t) => calls.push({ copy: t }), burst() {}, isAddr: (a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) },
    VW: { KNOWN, isMobile, isPhone: isMobile, inWalletApp: () => false, list: () => wallets, onChange: (f) => listeners.push(f), safeIcon: () => null, mark: (n) => el("span", "wallet-mark", n[0]) },
    fetch: async (path, init) => { const body = init && init.body ? JSON.parse(init.body) : undefined; const d = await answer(path, body); const status = d && d._status ? d._status : d && d.ok === false ? 400 : 200; return { ok: status < 300, status, json: async () => d }; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1] = null; },
    AbortController, atob, btoa, Uint8Array, TextEncoder, Number, Math, JSON, Date, Promise, Array, Object, String, Boolean, Error,
  });
  win.window = win;
  doc.defaultView = win;
  vm.runInContext(SWAP_JS, vm.createContext(win), { filename: "public/swap.js" });
  // runs the short timers (debounce, polls) in order; the 12-second refresh and anything longer stays pending (dropped), like a page nobody waits on
  const flush = async (n = 50) => { for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); const t = timers.findIndex(Boolean); if (t < 0) { if (i > 3) break; continue; } const { fn, ms } = timers[t]; timers[t] = null; if (ms < 10_000) fn(); } for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  await flush();
  const $ = (s) => doc.querySelector(s);
  return { doc, win, $, $$: (s) => doc.querySelectorAll(s), calls, flush, timers, slot: $("#buy-slot"), VSwap: win.VSwap, listeners };
}
const paths = (calls) => calls.filter((c) => c.path).map((c) => c.path.split("?")[0]);
const byPath = (calls, prefix) => calls.filter((c) => c.path && c.path.startsWith(prefix));
const type = async (P, value) => { const i = P.$(".swap__amt"); i.value = value; i.dispatchEvent(newEvent("input")); await P.flush(); };
const click = (e) => e.dispatchEvent(newEvent("click"));
const text = (e) => (e ? e.textContent.trim() : null);

test("swap panel: with the switch off nothing mounts and the slot is hidden; nothing but /api/swap/config is asked", async () => {
  const P = await page({ answers: { "/api/swap/config": { ok: true, swap: false } } });
  assert.equal(P.slot.hidden, true);
  assert.deepEqual(paths(P.calls), ["/api/swap/config"]);
});

test("swap panel: mounts from data-swap, quotes while typing (no taker before a wallet), shows the details and the attribution", async () => {
  const P = await page({ answers: { "/api/swap/config": CONFIG, "/api/swap/quote": (b) => QUOTE({ source: "jupiter_quote", estimate: true, taker: b.taker }) } });
  assert.equal(P.slot.getAttribute("data-swap-mounted"), "1");
  assert.equal(text(P.$(".swap__title")), "Buy $VICINITY");
  assert.deepEqual(P.$$(".swap__token").map((b) => [text(b).replace(/▾/, "").trim(), b.disabled]), [["SSOL", false], ["V$VICINITY", true]], "SOL pickable, $VICINITY fixed");
  assert.equal(text(P.$(".swap__go")), "Connect wallet");
  assert.match(text(P.$(".swap__foot")), /Powered by Jupiter/);
  await type(P, "0.25");
  const q = P.calls.find((c) => c.path === "/api/swap/quote");
  assert.deepEqual(q.body, { inputMint: SOL, outputMint: VIC, amount: "0.25", slippageBps: 100 }, "no taker before a wallet is connected");
  assert.equal(text(P.$(".swap__state")), "Estimate");
  assert.equal(text(P.$(".swap__amt--out")), "89,166.220238");
  const dds = P.$$(".swap__details dd").map(text);
  assert.deepEqual(dds, ["88,274.558036 $VICINITY", "0.12%", "network ≈ 0.000005 SOL · no platform fee", "Routed by Jupiter · executed on Raydium Launchlab"]);
  assert.match(text(P.$(".swap__status")), /Estimate: the exact amount is fixed when you press Swap/);
  assert.ok(P.$(".swap__usd") && /≈ \$37\.56/.test(text(P.$(".swap__usd"))));
  // a changed amount re-quotes after the debounce; garbage is cleaned out of the field
  await type(P, "0,5abc");
  assert.equal(P.$(".swap__amt").value, "0.5");
  assert.equal(P.calls.filter((c) => c.path === "/api/swap/quote").length, 2);
  assert.ok(!paths(P.calls).some((p) => /\/api\/(me|auth|signup|session)/.test(p)), "never a session route");
});

test("swap panel: connect, quote with the taker, balances and MAX, then the whole buy with signAndSendTransaction, confirmed", async () => {
  const w = walletOf();
  const statuses = ["pending", "confirmed"];
  const P = await page({ wallets: [w], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": (b) => QUOTE({ source: b.taker ? "jupiter_build" : "jupiter_quote", estimate: !b.taker }), "/api/swap/balances": { ok: true, sol: { lamports: 1_500_000_000, ui: 1.5 }, tokens: { [VIC]: { ui: 12.5, hasAccount: true } } }, "/api/swap/tx": TX(), "/api/swap/status": () => ({ ok: true, status: statuses.shift() || "confirmed", solscan: "x" }) } });
  await type(P, "0.25");
  click(P.$(".swap__go"));
  await P.flush();
  const opts = P.$$(".swap__wallets .wallet-option");
  assert.equal(opts.length, 1);
  assert.equal(text(opts[0]), "TTest WalletConnect");
  click(opts[0]); await P.flush();
  assert.deepEqual(w.calls, [["connect"]]);
  assert.match(text(P.$(".swap__status")), /Connected CnQM…zz6p|Getting the best price|Price impact/);
  assert.equal(P.$(".swap__wallets").hidden, true);
  const bal = byPath(P.calls, "/api/swap/balances")[0];
  assert.match(bal.path, new RegExp(`owner=${TAKER}&mints=${VIC}&cluster=mainnet`));
  // the quote is asked again with the taker (a build, not an estimate)
  await type(P, "0.25");
  const last = P.calls.filter((c) => c.path === "/api/swap/quote").pop();
  assert.equal(last.body.taker, TAKER);
  assert.equal(text(P.$(".swap__state")), "Live");
  assert.equal(P.$(".swap__max").hidden, false);
  assert.equal(text(P.$(".swap__max")), "MAX · 1.5 SOL");
  assert.equal(text(P.$(".swap__bal")), "You hold 12.5");
  click(P.$(".swap__max")); await P.flush();
  assert.equal(P.$(".swap__amt").value, "1.49", "MAX keeps 0.01 SOL for fees");
  await type(P, "0.25");
  assert.equal(text(P.$(".swap__go")), "Buy $VICINITY");
  click(P.$(".swap__go")); await P.flush();
  const tx = P.calls.find((c) => c.path === "/api/swap/tx");
  assert.deepEqual(tx.body, { inputMint: SOL, outputMint: VIC, amount: "0.25", slippageBps: 100, taker: TAKER, quoteId: "q1" }, "no v: legacy for a wallet with version 0");
  const sent = w.calls.find((c) => c[0] === "signAndSend");
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), ["signAndSend", 300, "solana:mainnet", { preflightCommitment: "confirmed", maxRetries: 3 }], "the bytes of the Worker's transaction, the chain, the options");
  await P.flush(60);
  const st = byPath(P.calls, "/api/swap/status");
  assert.ok(st.length >= 2, "polled until confirmed");
  assert.match(st[0].path, /sig=[1-9A-HJ-NP-Za-km-z]{43,88}&lvbh=4321&cluster=mainnet/);
  assert.equal(text(P.$(".swap__state")), "Swapped ✓");
  assert.equal(text(P.$(".swap__status")), "Swapped ✓ 0.25 SOL → 89,166.220238 $VICINITY");
  assert.match(P.$(".swap__links a").getAttribute("href"), /^https:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(text(P.$(".swap__go")), "Swap again");
  assert.ok(!paths(P.calls).some((p) => /\/api\/(me|auth|signup)/.test(p)), "a swap needs no login");
  assert.ok(!paths(P.calls).includes("/api/swap/send"), "a wallet that sends needs no relay");
});

test("swap panel: a wallet that only signs goes through our relay; a wallet without version 0 asks for a legacy transaction", async () => {
  const w = walletOf({ kind: "sign", versions: ["legacy"] });
  const P = await page({ wallets: [w], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE(), "/api/swap/balances": { ok: true, sol: { lamports: 0, ui: 0 }, tokens: {} }, "/api/swap/tx": TX({ version: "legacy" }), "/api/swap/send": { ok: true, signature: "5ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk", solscan: "x" }, "/api/swap/status": { ok: true, status: "finalized" } } });
  click(P.$(".swap__go")); await P.flush(); click(P.$(".swap__wallets .wallet-option")); await P.flush();
  await type(P, "0.25");
  click(P.$(".swap__go")); await P.flush(60);
  assert.equal(P.calls.find((c) => c.path === "/api/swap/tx").body.v, "legacy");
  assert.deepEqual(w.calls.find((c) => c[0] === "sign"), ["sign", 300, "solana:mainnet"]);
  const send = P.calls.find((c) => c.path === "/api/swap/send");
  assert.deepEqual([send.body.lastValidBlockHeight, send.body.cluster, send.body.tx.length > 300], [4321, "mainnet", true]);
  assert.equal(text(P.$(".swap__state")), "Swapped ✓");
});

test("swap panel: plain words for every way it stops: cancelled, slippage, not enough SOL, no route, busy; a legacy provider is told what to do", async () => {
  const w = walletOf({ reject: true });
  let txAnswer = TX();
  let quoteAnswer = QUOTE();
  const P = await page({ wallets: [w], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": () => quoteAnswer, "/api/swap/balances": { ok: true, sol: { lamports: 0, ui: 0 }, tokens: {} }, "/api/swap/tx": () => txAnswer } });
  click(P.$(".swap__go")); await P.flush(); click(P.$(".swap__wallets .wallet-option")); await P.flush();
  await type(P, "0.25"); click(P.$(".swap__go")); await P.flush(30);
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__status")), text(P.$(".swap__go"))], ["Stopped", "Cancelled in your wallet. Nothing was sent.", "Try again"]);
  txAnswer = { ok: false, error: "slippage", name: "SlippageToleranceExceeded", _status: 409 };
  click(P.$(".swap__go")); await P.flush(30);
  assert.equal(text(P.$(".swap__status")), "The price moved more than your slippage allows. Nothing was spent. Try again or raise slippage.");
  txAnswer = { ok: false, error: "insufficient_sol", _status: 409 };
  click(P.$(".swap__go")); await P.flush(30);
  assert.match(text(P.$(".swap__status")), /^Not enough SOL for this plus the network fee/);
  txAnswer = { ok: false, error: "program_error", name: "InvalidPermission", _status: 409 };
  click(P.$(".swap__go")); await P.flush(30);
  assert.equal(text(P.$(".swap__status")), "The market refused this trade (InvalidPermission). Nothing was spent.");
  quoteAnswer = { ok: false, error: "no_route", _status: 404 };
  await type(P, "0.3");
  assert.deepEqual([text(P.$(".swap__status")), P.$(".swap__go").disabled], ["No market can trade this pair right now.", false]);
  quoteAnswer = { ok: false, error: "jupiter_busy", retryAfterS: 5, _status: 503 };
  await type(P, "0.31");
  assert.equal(text(P.$(".swap__status")), "The price service is busy. Try again in a few seconds.");
  // a wallet that can neither send nor sign a transaction here
  const legacy = walletOf({ kind: "legacy" });
  const L = await page({ wallets: [legacy], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE(), "/api/swap/balances": { ok: true, sol: { lamports: 0, ui: 0 }, tokens: {} } } });
  click(L.$(".swap__go")); await L.flush();
  assert.equal(text(L.$(".swap__wallets .wallet-option .go")), "No transactions");
  click(L.$(".swap__wallets .wallet-option")); await L.flush();
  assert.match(text(L.$(".swap__status")), /This wallet can sign messages here but not transactions: open this page in Phantom, Solflare or Backpack/);
  await type(L, "0.25"); click(L.$(".swap__go")); await L.flush(30);
  assert.equal(text(L.$(".swap__status")), "This wallet can sign messages here but not transactions: open this page in Phantom, Solflare or Backpack.");
  assert.ok(!paths(L.calls).includes("/api/swap/tx"), "nothing is built for it");
});

test("swap panel: a phone with no wallet gets Open in Phantom / Solflare / Backpack with this very page, and the address to copy; no sign-up", async () => {
  const P = await page({ isMobile: true, answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE({ estimate: true, source: "jupiter_quote" }) }, href: "https://vicinity.test/token#buy-slot" });
  click(P.$(".swap__go")); await P.flush();
  const links = P.$$(".swap__deeplinks a");
  assert.deepEqual(links.map(text), ["POpen in Phantom↗", "SOpen in Solflare↗", "BOpen in Backpack↗"]);
  assert.equal(links[0].getAttribute("href"), `https://phantom.com/ul/browse/${encodeURIComponent("https://vicinity.test/token#buy-slot")}`);
  assert.equal(text(P.$(".swap__ca code")), VIC);
  assert.ok(!paths(P.calls).some((p) => /\/api\/(me|auth|signup|connect)/.test(p)));
});

test("swap panel: a city coin on its curve is quoted and built by the launchpad routes on the devnet chain; a wallet without devnet is told to switch", async () => {
  const curveQuote = { ok: true, quoteId: "c1", source: "curve", side: "buy", inputMint: SOL, outputMint: CITY, decimals: { in: 9, out: 6 }, inAmount: "5000000", outAmount: "13286006275533", minOut: "13153146212777", inUi: "0.005", outUi: "13286006.275533", minOutUi: "13153146.212777", slippageBps: 100, priceImpactPct: "1.32", refund: "0", partialFill: false, route: ["Meteora bonding curve"], fees: { curveFeeBps: 125, networkLamports: 5000, split: {} }, chain: "solana:devnet", cluster: "devnet", poweredBy: "Meteora DBC", expiresAt: new Date(Date.now() + 12000).toISOString() };
  const mainnetOnly = walletOf({ chains: ["solana:mainnet"] });
  const answers = { "/api/swap/config": CONFIG, "/api/swap/quote": { ok: true, source: "curve", mint: CITY, side: "buy", chain: "solana:devnet", cluster: "devnet", quoteMint: SOL, useRoute: "/api/launchpad/trade" }, "/api/launchpad/trade/quote": curveQuote, "/api/launchpad/trade/tx": TX({ chain: "solana:devnet", cluster: "devnet", quote: curveQuote }), "/api/swap/balances": { ok: true, sol: { lamports: 1e9, ui: 1 }, tokens: {} }, "/api/swap/status": { ok: true, status: "confirmed" } };
  const P = await page({ wallets: [mainnetOnly], answers, slot: `<div id="buy-slot" data-swap data-out="${CITY}" data-in="SOL" data-mode="buy" data-title="Buy $DEMOV"></div>` });
  click(P.$(".swap__go")); await P.flush(); click(P.$(".swap__wallets .wallet-option")); await P.flush();
  await type(P, "0.005");
  assert.deepEqual(P.calls.find((c) => c.path === "/api/launchpad/trade/quote").body, { mint: CITY, side: "buy", amount: "0.005", slippageBps: 100, taker: TAKER });
  assert.deepEqual([text(P.$(".swap__state")), P.$$(".swap__details dd").map(text)[3]], ["Devnet test coin", "Executed on the Meteora bonding curve"]);
  assert.match(text(P.$(".swap__foot")), /Meteora bonding curve.*Devnet test coin/);
  click(P.$(".swap__go")); await P.flush(30);
  assert.equal(text(P.$(".swap__status")), "Switch your wallet to devnet for this test coin.");
  assert.ok(!paths(P.calls).includes("/api/launchpad/trade/tx"), "nothing is built for the wrong chain");
  // the same with a wallet whose account is on devnet too
  const both = walletOf({ chains: ["solana:mainnet", "solana:devnet"] });
  const Q = await page({ wallets: [both], answers, slot: `<div id="buy-slot" data-swap data-out="${CITY}" data-in="SOL" data-mode="buy"></div>` });
  click(Q.$(".swap__go")); await Q.flush(); click(Q.$(".swap__wallets .wallet-option")); await Q.flush();
  await type(Q, "0.005"); click(Q.$(".swap__go")); await Q.flush(60);
  assert.deepEqual(Q.calls.find((c) => c.path === "/api/launchpad/trade/tx").body, { mint: CITY, side: "buy", amount: "0.005", slippageBps: 100, taker: TAKER, quoteId: "c1" });
  assert.deepEqual(both.calls.find((c) => c[0] === "signAndSend").slice(0, 3), ["signAndSend", 300, "solana:devnet"]);
  assert.match(byPath(Q.calls, "/api/swap/status").pop().path, /cluster=devnet/);
  assert.match(Q.$(".swap__links a").getAttribute("href"), /\?cluster=devnet$/);
  assert.equal(text(Q.$(".swap__state")), "Swapped ✓");
});

test("swap panel: price impact above 3% tints, above 10% needs 'I understand'; slippage chips; a stale quote is refreshed before building; the flip", async () => {
  let impact = "4.5";
  const w = walletOf();
  let quotes = 0;
  const P = await page({ wallets: [w], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": () => { quotes++; return QUOTE({ priceImpactPct: impact, expiresAt: new Date(Date.now() - 1000).toISOString() }); }, "/api/swap/balances": { ok: true, sol: { lamports: 0, ui: 0 }, tokens: {} }, "/api/swap/tx": TX(), "/api/swap/status": { ok: true, status: "confirmed" } } });
  click(P.$(".swap__go")); await P.flush(); click(P.$(".swap__wallets .wallet-option")); await P.flush();
  await type(P, "2");
  assert.ok(P.slot.classList.contains("is-warn") && !P.slot.classList.contains("is-bad"));
  assert.equal(P.$(".swap__warn").hidden, true);
  impact = "12";
  await type(P, "20");
  assert.ok(P.slot.classList.contains("is-bad"));
  assert.deepEqual([P.$(".swap__warn").hidden, P.$(".swap__go").disabled], [false, true], "the button waits for the checkbox");
  const cb = P.$(".swap__warn input"); cb.checked = true; cb.dispatchEvent(newEvent("change")); await P.flush();
  assert.equal(P.$(".swap__go").disabled, false);
  const before = quotes;
  click(P.$(".swap__go")); await P.flush(60);
  assert.equal(quotes, before + 1, "the expired quote was refreshed before building");
  assert.ok(P.calls.some((c) => c.path === "/api/swap/tx"));
  // slippage chips
  const chips = P.$$(".swap__chip:not(.swap__chip--custom)");
  assert.deepEqual(chips.map((c) => c.getAttribute("aria-pressed")), ["false", "true", "false"]);
  click(P.$(".swap__go")); await P.flush(); // "Swap again" resets
  click(chips[2]); await P.flush();
  await type(P, "1");
  assert.equal(P.calls.filter((c) => c.path === "/api/swap/quote").pop().body.slippageBps, 300);
  const custom = P.$(".swap__chip--custom"); custom.value = "2.5"; custom.dispatchEvent(newEvent("change")); await P.flush();
  assert.equal(P.calls.filter((c) => c.path === "/api/swap/quote").pop().body.slippageBps, 250);
  // the flip sells
  click(P.$(".swap__flip")); await P.flush();
  assert.deepEqual(P.$$(".swap__token").map((b) => [text(b).replace(/▾/, "").trim(), b.disabled]), [["V$VICINITY", true], ["SSOL", false]]);
  assert.equal(text(P.$(".swap__go")), "Sell $VICINITY");
});

test("swap panel: open() shows the panel in a sheet over the page and closes on the ✕ or a tap outside", async () => {
  const P = await page({ answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE() }, slot: "" });
  const p = await P.VSwap.open({ out: VIC });
  await P.flush();
  const sheet = P.$(".swap-sheet");
  assert.ok(sheet && sheet.hasAttribute("open"));
  assert.equal(text(sheet.querySelector(".swap__title")), "Buy $VICINITY");
  assert.ok(p && p.root === sheet.querySelector(".swap-sheet__body"));
  click(sheet.querySelector(".swap-sheet__close"));
  assert.equal(sheet.hasAttribute("open"), false);
  await P.VSwap.open({ out: USDC, in: "SOL", mode: "swap", title: "Swap" }); await P.flush();
  assert.equal(text(sheet.querySelector(".swap__title")), "Swap");
  sheet.dispatchEvent(newEvent("click"));
  assert.equal(sheet.hasAttribute("open"), false, "a tap on the backdrop closes it");
});

/* ---------------------------------------------------------------- the words on the pages, behind the switch */
const HOME = `<body data-page="home"><ol class="buy-steps"><li class="card"><span class="buy-steps__n">2</span><h3>Add SOL</h3><p class="muted">Buy SOL in the wallet app.</p></li><li class="card"><span class="buy-steps__n">3</span><h3>Buy on Raydium</h3><p class="muted">On Raydium LaunchLab, only through the <strong>Buy on Raydium</strong> button on our <a href="/token#buy">Token page</a>, so you get the real $VICINITY.</p></li></ol><p class="scam-note"><strong>The only real Raydium is raydium.io.</strong> Look-alike addresses copy it to empty wallets.</p><details id="buy-faq"><summary>How do I buy $VICINITY?</summary><p>Get a Solana wallet (Phantom, Solflare or Backpack), add SOL, then use the <strong>Buy on Raydium</strong> button on the <a href="/token#buy">Token page</a>. It opens the official $VICINITY on Raydium LaunchLab (raydium.io). Look-alike sites that copy Raydium are scams that empty wallets.</p></details></body>`;
/** A page whose <body data-page> and markup are given, with /api/official already read by site.js (window.V.official). */
async function pageWith(body, { official, answers = {} }) {
  const doc = new Doc();
  doc.append(...parse(doc, `<html>${body}</html>`));
  const calls = [];
  const answer = async (path) => { calls.push(path); const a = answers[path.split("?")[0]]; return a === undefined ? { ok: false, error: "not_found", _status: 404 } : a; };
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const win = new Target();
  Object.assign(win, { document: doc, location: { href: "https://vicinity.test/" }, console,
    V: { $: (s, r = doc) => r.querySelector(s), $$: (s, r = doc) => r.querySelectorAll(s), el, api: answer, toast() {}, copy() {}, burst() {}, isAddr: (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a)), official: Promise.resolve(official) },
    VW: { KNOWN: [], isMobile: false, list: () => [], onChange() {}, safeIcon: () => null, mark: () => el("span") },
    fetch: async (path) => ({ ok: false, status: 404, json: async () => answer(path) }), setTimeout: () => 0, clearTimeout() {}, AbortController, atob, btoa, Uint8Array, TextEncoder, Promise, Array, Object, String, Number, Math, JSON, Date, Boolean, Error });
  win.window = win; doc.defaultView = win;
  vm.runInContext(SWAP_JS, vm.createContext(win), { filename: "public/swap.js" });
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  return { doc, win, calls, $: (s) => doc.querySelector(s), $$: (s) => doc.querySelectorAll(s) };
}

test("copy behind the switch: on the home page with the swap ON the 'Buy on Raydium' step and FAQ say Buy here (routed by Jupiter, executed on Raydium LaunchLab); no /api/swap/config is asked when nothing mounts", async () => {
  const P = await pageWith(HOME, { official: { swap: true, tokenContract: VIC } });
  assert.equal(text(P.$$(".buy-steps h3")[1]), "Buy here");
  assert.equal(text(P.$$(".buy-steps h3")[0]), "Add SOL", "the other steps are untouched");
  const step = P.$$(".buy-steps p")[1];
  assert.match(text(step), /^Right here, on our Token page: the Buy panel quotes through Jupiter and executes on Raydium LaunchLab, signed in your own wallet, so you get the real \$VICINITY without leaving vicinity\.city\.$/);
  assert.equal(step.querySelector("a").getAttribute("href"), "/token#buy-slot", "the link goes to the panel");
  assert.match(text(P.$("#buy-faq p")), /^Get a Solana wallet \(Phantom, Solflare or Backpack\), add SOL, then use the Buy panel on the Token page\. It quotes through Jupiter and executes on Raydium LaunchLab, signed in your own wallet; you never leave this site\. Look-alike sites that copy Raydium are scams that empty wallets\.$/);
  assert.doesNotMatch(text(P.$("#buy-faq p")), /raydium\.io/, "nobody is sent to raydium.io");
  assert.match(text(P.$(".scam-note")), /The only real Raydium is raydium\.io/, "the warning about look-alikes stays");
  assert.deepEqual(P.calls, [], "the switch came from /api/official, which the page reads anyway: nothing else was asked");
  assert.equal(P.$$(".buy-steps p")[1].dataset.swapCopy, "1", "marked, so a second sweep leaves it alone");
  P.win.VSwap.copySweep();
  assert.equal(P.$$(".buy-steps h3")[1].textContent, "Buy here");
});

test("copy behind the switch: with the swap OFF (no swap key in /api/official) every word stays exactly as it is and nothing is asked", async () => {
  const P = await pageWith(HOME, { official: { tokenContract: VIC } });
  assert.equal(text(P.$$(".buy-steps h3")[1]), "Buy on Raydium");
  assert.match(text(P.$("#buy-faq p")), /use the Buy on Raydium button on the Token page\. It opens the official \$VICINITY on Raydium LaunchLab \(raydium\.io\)/);
  assert.deepEqual(P.calls, []);
  const slot = await pageWith(`<body data-page="token"><div id="buy-slot" data-swap data-out="${VIC}"></div></body>`, { official: { tokenContract: VIC } });
  assert.equal(slot.$("#buy-slot").hidden, true, "a slot on a page is hidden without a request");
  assert.deepEqual(slot.calls, []);
});

test("copy behind the switch: the token page's FAQ step and the Launchpad's honesty line (its links kept) change; a slot on the page still mounts through /api/swap/config", async () => {
  const T = await pageWith(`<body data-page="token"><details id="buy"><ol class="faq__steps"><li><strong>Add SOL.</strong> Keep a little extra.</li><li><strong>Buy on Raydium.</strong> Use the <strong>Buy on Raydium</strong> button at the top of this page. It opens the official $VICINITY on Raydium LaunchLab (raydium.io); the contract address there must match the one here.</li></ol></details><div id="buy-slot" data-swap data-out="${VIC}" data-in="SOL" data-mode="buy"></div></body>`,
    { official: { swap: true, tokenContract: VIC }, answers: { "/api/swap/config": CONFIG } });
  const steps = T.$$("#buy li").map(text);
  assert.equal(steps[0], "Add SOL. Keep a little extra.");
  assert.equal(steps[1], "Buy here. Use the Buy panel under the contract address at the top of this page: it quotes through Jupiter and executes on Raydium LaunchLab, signed in your own wallet. You never leave vicinity.city.");
  assert.equal(T.$$("#buy li")[1].querySelector("strong").textContent, "Buy here.");
  assert.deepEqual(T.calls, ["/api/swap/config"], "the panel on the page needed the config, once");
  assert.equal(T.$("#buy-slot").getAttribute("data-swap-mounted"), "1");
  const L = await pageWith(`<body data-page="launchpad"><p class="tiny muted lp-honesty" id="lp-honesty">Prices from <a href="https://jup.ag">Powered by Jupiter</a>. They refresh every 30 seconds. You trade in your own wallet on Raydium or Jupiter; Vicinity never touches your funds.</p></body>`, { official: { swap: true } });
  assert.equal(text(L.$("#lp-honesty")), "Prices from Powered by Jupiter. They refresh every 30 seconds. You buy and sell here, in your own wallet (routed by Jupiter, executed on Raydium LaunchLab or the Meteora curve); Vicinity never touches your funds.");
  assert.equal(L.$("#lp-honesty a").getAttribute("href"), "https://jup.ag", "the attribution link survives the sweep");
  assert.equal(L.win.VSwap.tradeSentence, "You buy and sell here, in your own wallet (routed by Jupiter, executed on Raydium LaunchLab or the Meteora curve); Vicinity never touches your funds.");
  // launchpad.js writes the same sentence when it redraws the line with the answer's attribution (source check: the words live in swap.js)
  const lp = readFileSync(new URL("../public/launchpad.js", import.meta.url), "utf8");
  assert.match(lp, /const trade = swapOn && window\.VSwap && window\.VSwap\.tradeSentence \? window\.VSwap\.tradeSentence : "You trade in your own wallet on Raydium or Jupiter; Vicinity never touches your funds\.";/);
  assert.match(lp, /says how old its numbers are\. \$\{trade\}`\);/);
});
