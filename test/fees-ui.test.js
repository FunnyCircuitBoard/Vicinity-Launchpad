// The fee displays in the browser (no browser: the real scripts in the just-enough DOM of test/helpers/pagedom.js, or in a stand-in
// window), fed the real answers src/fees.js builds from the live config's bytes:
//   * the coin page's Fees card (public/coin.js): shown for a coin of the Vicinity launchpad only, its three sentences verbatim with the
//     accurate labels, the source line with the coin's config and the read time; asked once per coin; hidden for $VICINITY and when
//     the answer does not come (nothing is said that was not read)
//   * the Launchpad's Fees card (public/launchpad.js): only while the city-coin launch is on (/api/official cityCoins), from GET /api/fees
//   * the coin page of a coin that has moved to its pool: the pool's fee first, the curve's after it in the past tense
//   * the Buy panel's "Pool fee" line (public/swap.js): for a city coin that has moved to its pool and a route whose every hop is a
//     Meteora DAMM v2 pool, from /api/fees?mint=, with Meteora's 20% sourced and the read time, said as the fee of the coin's own pool
//     "if the route uses it" (the quote names venues, not pools: another DAMM v2 pool for the coin, or two DAMM v2 hops, read the
//     same); on a route with such a hop the footer says, as conditionally, that Vicinity's locked share of the coin's own pool earns
//     part of that pool's fee, whether the figure has loaded or not (never "takes no fee" there), a route split with another venue
//     included (no Pool fee row then: one figure would not be the whole trade's); a failed
//     answer is asked again after half a minute; never for a coin on its curve (its fee line carries the quote's own curve fee, the
//     schedule's text, with its source)
// The launch card's figure is checked where that card is tested (test/lp-launch-ui.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { openPage } from "./helpers/pagedom.js";
import { feeSchedule, feeWords } from "../src/fees.js";
import { decodeConfig } from "../src/sol/dbc.js";
import { EXPECTED_POOL_CONFIG } from "../src/sol/dbc-config-data.js";
import { fromBase64 } from "../src/sol/bytes.js";
import { CITY, CONFIG, CURVE_QUOTE, QUOTE, SOL, swapPage, text } from "./helpers/swappage.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const COIN_JS = read("public/coin.js"), LAUNCHPAD_JS = read("public/launchpad.js"), COIN_HTML = read("public/coin.html"), LP_HTML = read("public/launchpad.html");
const MINT = "M1nt1111111111111111111111111111111111111111";
const LIVE_CONFIG = "EZVHCgxKZhvXmUGMXJMEw8tZHiTmoHPyM9mNNQ5u1kSP";
const READ_AT = "2026-10-16T14:03:00.000Z";
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
/** The read time as the page writes it: the viewer's own clock (this machine's zone here). */
const hhmm = (iso) => { const d = new Date(Date.parse(iso)); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
/** The live config's short address as the pages write it: a word joiner after the ellipsis, so it never breaks in two. */
const SHORT = "EZVH…\u20601kSP";

/** What GET /api/fees answers for the live config (src/fees.js handleFees), for the live curve or for `mint`'s own config. */
function feesAnswer({ mint = null, scope = mint ? "coin" : "live" } = {}) {
  const S = feeSchedule(decodeConfig(fromBase64(EXPECTED_POOL_CONFIG)), { address: LIVE_CONFIG, readAt: Date.parse(READ_AT) });
  return JSON.parse(JSON.stringify({ ok: true, cluster: "mainnet", config: LIVE_CONFIG, ...(mint ? { coin: { mint, cityId: "5142056", symbol: "UTICA" } } : {}), readAt: S.source.readAt, ...S, words: feeWords(S, scope) }));
}
const WORDS = feesAnswer().words;

/* ---------------------------------------------------------------- the coin page */
const coinAnswer = ({ launchpad = "vicinity", stage = "curve", kind = "city" } = {}) => ({
  ok: true, asOf: new Date().toISOString(), mint: MINT,
  coin: { kind, ticker: kind === "vicinity" ? "VICINITY" : "UTICA", name: kind === "vicinity" ? "Vicinity" : "Utica Coin", city: kind === "vicinity" ? null : { name: "Utica", country: "US" }, pair: { symbol: "SOL", mint: SOL }, color: "gold", logo: null },
  facts: null, holders: null, trades: { rows: [] }, samples: [],
  market: launchpad === "vicinity"
    ? { launchpad: "vicinity", curve: null, lpCurve: { stage, symbol: "SOL", raised: 21.25, target: 85, progressPct: 25, pool: MINT }, sources: {}, missing: {} }
    : { launchpad: null, curve: null, lpCurve: null, sources: {}, missing: {} },
  links: { raydium: null, jupiter: null, dexscreener: null, solscan: `https://solscan.io/token/${MINT}`, here: `/coin?mint=${MINT}` },
});
/** The built coin page with the real coin.js; `fees` is what /api/fees?mint= answers (a function of the call count), `coin` what /api/coin answers. */
async function coinPage({ fees = () => feesAnswer({ mint: MINT }), coin = coinAnswer() } = {}) {
  const page = await openPage("coin.html", { agreed: "2026-10-01" });
  const win = page.window;
  const timers = [];
  win.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  win.clearTimeout = () => {}; win.setInterval = () => 0;
  win.location = { href: `https://vicinity.city/coin?mint=${MINT}`, pathname: "/coin", search: `?mint=${MINT}` };
  win.history = { replaceState() {} };
  win.Intl = Intl;
  const calls = [];
  let feeCalls = 0;
  win.fetch = async (path) => {
    const p = String(path).split("?")[0];
    calls.push(String(path));
    const body = p === "/api/coin" ? coin : p === "/api/fees" ? fees(feeCalls++, String(path)) : p === "/api/official" ? { ok: true, swap: true } : { ok: false, error: "not_found" };
    return { ok: body.ok !== false, status: body.ok === false ? 404 : 200, json: async () => body };
  };
  win.V.official = Promise.resolve({ ok: true, swap: true, cityCoins: { cluster: "mainnet" } });
  win.VSwap = { open() {} };
  const chart = new Proxy({}, { get: () => () => undefined });
  win.VChart = { create: () => chart, pure: { INTERVALS: {} } };
  vm.runInContext(COIN_JS, win, { filename: "public/coin.js" });
  await tick(40);
  const refresh = async () => { const due = timers.splice(0); for (const fn of due) fn(); await tick(40); };
  return { page, calls, refresh, feeCalls: () => feeCalls };
}

test("coin page: the Fees card of a launchpad coin, from the coin's own config: the figures and labels verbatim, the separate-steps line, the transfer line, the source line with the config and the read time", async () => {
  const p = await coinPage();
  const card = p.page.$("#coin-fees");
  assert.equal(card.hidden, false);
  assert.equal(text(p.page.$("#coin-fees-title")), "Fees");
  assert.equal(text(p.page.$("#coin-fees-curve")), "Every buy and sell on the price curve pays 1.25%: Meteora protocol fee 0.25% (20% of the fee, set by Meteora's program, which sends a fifth of that to Vicinity on trades made here), Vicinity 0.5%, the city's founder 0.25%, the city's holder pot 0.25%. After graduation, this coin's pool fee is 1.25%, split the same way, except that none of the Meteora protocol fee goes to Vicinity (anyone who adds liquidity to the pool later takes part of everything but the Meteora protocol fee).");
  assert.equal(text(p.page.$("#coin-fees-steps")), "On curve trades made here, only Vicinity's part of the Meteora protocol fee reaches a wallet during the trade. The rest waits on chain until collected: Meteora collects its own, the founder collects theirs, Vicinity claims its own, and the holders' share stays on chain for holder reward rounds. Those rounds are not on the site yet and are not a promise (see the Terms).");
  assert.equal(text(p.page.$("#coin-fees-oneoff")), "Launch fee: 0.05 SOL, paid once by the founder (90% Vicinity, 10% Meteora, as Meteora's program splits it). At graduation Meteora's program keeps 0.2% of the SOL and of the coins moved into the pool, once. No Vicinity fee on wallet transfers; only Solana's network fee and, for a first-time recipient, one-time account rent.");
  // the short address and the time never break across lines (a word joiner after the ellipsis, a no-break space before the time)
  assert.equal(text(p.page.$("#coin-fees-src")), `Read from this coin's price-curve settings on Solana (${SHORT}) at\u00a0${hhmm(READ_AT)}. Vicinity's program splits the city's share evenly between the founder and the holder pot.`);
  assert.equal(p.calls.filter((c) => c.startsWith("/api/fees")).length, 1);
  assert.equal(p.calls.find((c) => c.startsWith("/api/fees")), `/api/fees?mint=${MINT}`);
  // the 30-second refresh repaints the page: the schedule is not asked again (a coin keeps its config), the card stays
  await p.refresh();
  assert.deepEqual([p.feeCalls(), card.hidden], [1, false]);
  for (const id of ["coin-fees", "coin-fees-title", "coin-fees-curve", "coin-fees-steps", "coin-fees-oneoff", "coin-fees-src"]) assert.ok(COIN_HTML.includes(`id="${id}"`), id);
  assert.match(COIN_HTML, /<section class="card coin-fees" id="coin-fees" aria-labelledby="coin-fees-title" hidden>\s*<h2 class="coin-card__title" id="coin-fees-title">Fees<\/h2>/, "hidden until the answer is here");
});

test("coin page: a coin that has moved to its pool leads with the pool's fee (its own figures, Meteora's 20% sourced) and says the curve's in the past tense; nothing reaches a wallet in the site's pool trades", async () => {
  const p = await coinPage({ coin: coinAnswer({ stage: "graduated" }) });
  const G = feesAnswer({ mint: MINT }).words.graduated;
  assert.equal(p.page.$("#coin-fees").hidden, false);
  assert.equal(text(p.page.$("#coin-fees-curve")), G.curve);
  assert.ok(G.curve.startsWith("This coin has graduated. Every buy and sell in its pool pays 1.25%: Meteora protocol fee 0.25% (20% of the fee, set by Meteora's program), Vicinity 0.5%,"), G.curve);
  assert.ok(G.curve.endsWith("Before graduation, every buy and sell on the price curve paid 1.25%, split the same way, except that Meteora's program sent a fifth of the Meteora protocol fee to Vicinity on trades made here."), G.curve);
  assert.equal(text(p.page.$("#coin-fees-steps")), G.steps);
  assert.ok(G.steps.startsWith("Each share waits on chain until collected:"), G.steps);
  assert.ok(!/reaches a wallet during the trade/.test(G.steps), "nothing is said about Jupiter's routing");
  assert.equal(text(p.page.$("#coin-fees-oneoff")), feesAnswer({ mint: MINT }).words.oneOff);
  // a coin whose curve is full (not yet moved) keeps the curve-first words
  const full = await coinPage({ coin: coinAnswer({ stage: "full" }) });
  assert.ok(text(full.page.$("#coin-fees-curve")).startsWith("Every buy and sell on the price curve pays 1.25%:"));
});

test("coin page: no Fees card for $VICINITY (not a coin of our launchpad: nothing of ours to claim) and none while /api/fees does not answer; an answer for another coin is not shown", async () => {
  const vic = await coinPage({ coin: coinAnswer({ launchpad: null, kind: "vicinity" }) });
  assert.equal(vic.page.$("#coin-fees").hidden, true);
  assert.equal(vic.calls.some((c) => c.startsWith("/api/fees")), false, "not even asked");
  const down = await coinPage({ fees: (n) => (n === 0 ? { ok: false, error: "rpc_unavailable" } : feesAnswer({ mint: MINT })) });
  assert.equal(down.page.$("#coin-fees").hidden, true);
  assert.equal(text(down.page.$("#coin-fees-curve")), "", "nothing written that was not read");
  // the answer that did not come is asked again at the next refresh (and once it comes, kept)
  await down.refresh();
  assert.deepEqual([down.feeCalls(), down.page.$("#coin-fees").hidden], [2, false]);
  await down.refresh();
  assert.equal(down.feeCalls(), 2);
  const other = await coinPage({ fees: () => feesAnswer({ mint: CITY }) });
  assert.equal(other.page.$("#coin-fees").hidden, true, "an answer about another coin's config is not this coin's");
  // pure: the source line and the clock
  const P = vic.page.window.VCoin.pure;
  assert.equal(P.feesSource({ config: LIVE_CONFIG, readAt: READ_AT }), `Read from this coin's price-curve settings on Solana (${SHORT}) at\u00a0${hhmm(READ_AT)}`);
  assert.equal(P.feesSource({ config: "nope", readAt: "garbage" }), "Read from this coin's price-curve settings on Solana");
  // the halving sentence is the answer's (src/fees.js halvesWords), after the source: Vicinity's program's rule, not the settings'
  assert.equal(P.feesSource({ config: LIVE_CONFIG, readAt: READ_AT, words: { halves: "Vicinity's program splits the city's share evenly between the founder and the holder pot." } }), `Read from this coin's price-curve settings on Solana (${SHORT}) at\u00a0${hhmm(READ_AT)}. Vicinity's program splits the city's share evenly between the founder and the holder pot.`);
  assert.equal(P.hhmm("2026-10-16T00:07:00Z"), hhmm("2026-10-16T00:07:00Z"));
});

/* ---------------------------------------------------------------- the Launchpad */
/** launchpad.js in a stand-in window: elements by selector (textContent and hidden remembered), /api answers, what /api/official says. */
function launchpadPage({ official, fees = feesAnswer() }) {
  const els = {}, calls = [];
  const fakeEl = () => ({ textContent: "", hidden: false, classList: { toggle() {}, add() {}, remove() {} }, style: {}, offsetWidth: 0, addEventListener() {}, dataset: {}, replaceChildren() {}, setAttribute() {}, append() {}, querySelector: () => null, querySelectorAll: () => [], focus() {}, value: "" });
  const $ = (sel) => (els[sel] ||= fakeEl());
  const V = { $, $$: () => [], el: () => fakeEl(), official: Promise.resolve(official), opensAt: () => 0, reduced: true, fmt: String, isAddr: () => false,
    api: async (path) => { calls.push(path); return path === "/api/fees" ? fees : {}; } };
  const win = { V, addEventListener() {}, getSelection: () => "", open() {} };
  vm.runInNewContext(LAUNCHPAD_JS, { window: win, document: { addEventListener() {}, visibilityState: "visible", hidden: false, activeElement: null, createElementNS: () => fakeEl() }, location: { search: "", hash: "" }, history: { replaceState() {} }, Intl, URLSearchParams, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {} });
  return { els, calls, pure: win.VLaunchpad.pure };
}

test("Launchpad: the Fees card only while the city-coin launch is on, from GET /api/fees: the sentences verbatim and the live config as the source; nothing without the setting, nothing when the answer does not come", async () => {
  const p = launchpadPage({ official: { ok: true, launchpadV2: false, cityCoins: { cluster: "mainnet" } } });
  await tick();
  assert.deepEqual(p.calls.filter((c) => c === "/api/fees"), ["/api/fees"], "asked once (the snapshot checker's own call is the page's as before)");
  assert.equal(p.els["#lp-fees"].hidden, false);
  assert.equal(p.els["#lp-fees-curve"].textContent, WORDS.curve);
  assert.equal(p.els["#lp-fees-steps"].textContent, WORDS.steps);
  assert.equal(p.els["#lp-fees-oneoff"].textContent, WORDS.oneOff);
  assert.equal(p.els["#lp-fees-src"].textContent, `Read from the price-curve settings on Solana (${SHORT}) at\u00a0${hhmm(READ_AT)}. Vicinity's program splits the city's share evenly between the founder and the holder pot.`);
  assert.match(p.els["#lp-fees-curve"].textContent, /Meteora protocol fee 0\.25% \(20% of the fee, set by Meteora's program, which sends a fifth of that to Vicinity on trades made here\)/);
  assert.match(p.els["#lp-fees-curve"].textContent, /\. After a coin graduates, its pool fee is 1\.25%, split the same way, except that none of the Meteora protocol fee goes to Vicinity \(anyone who adds liquidity to the pool later takes part of everything but the Meteora protocol fee\)\.$/, "a Launchpad sentence about any coin");
  const off = launchpadPage({ official: { ok: true, launchpadV2: false } });
  await tick();
  assert.deepEqual([off.calls.includes("/api/fees"), off.els["#lp-fees"] && off.els["#lp-fees"].hidden], [false, undefined], "not asked, not touched");
  const down = launchpadPage({ official: { ok: true, launchpadV2: false, cityCoins: { cluster: "mainnet" } }, fees: { ok: false, error: "rpc_unavailable", _status: 503 } });
  await tick();
  assert.deepEqual([down.els["#lp-fees"].hidden, down.els["#lp-fees-curve"] && down.els["#lp-fees-curve"].textContent], [false, undefined], "the card stays as the page shipped it (hidden markup), nothing written");
  assert.equal(p.pure.feesSource({ config: LIVE_CONFIG, readAt: READ_AT }), `Read from the price-curve settings on Solana (${SHORT}) at\u00a0${hhmm(READ_AT)}`);
  // the markup: one hidden card between the coins and the snapshot fold, its ids the script's
  for (const id of ["lp-fees", "lp-fees-title", "lp-fees-curve", "lp-fees-steps", "lp-fees-oneoff", "lp-fees-src"]) assert.ok(LP_HTML.includes(`id="${id}"`), id);
  assert.match(LP_HTML, /<section class="lp-fees" id="lp-fees" aria-labelledby="lp-fees-title" hidden>/);
  assert.ok(LP_HTML.indexOf('id="lp-fees"') > LP_HTML.indexOf('id="lp-coins"') && LP_HTML.indexOf('id="lp-fees"') < LP_HTML.indexOf('id="supporters"'));
});

/* ---------------------------------------------------------------- the Buy panel */
const graduatedConfig = { ...CONFIG, tokens: CONFIG.tokens.map((t) => (t.mint === CITY ? { ...t, stage: "graduated" } : t)) };
const slot = `<div id="buy-slot" data-swap data-out="${CITY}" data-in="SOL" data-mode="buy"></div>`;
const type = async (P, value) => { const i = P.$(".swap__amt"); i.value = value; const { newEvent } = await import("./helpers/pagedom.js"); i.dispatchEvent(newEvent("input")); await P.flush(); };

const POOL_ROUTE = { route: ["Meteora DAMM v2"], routeText: "Routed by Jupiter · executed on Meteora DAMM v2" };

test("Buy panel: a graduated city coin on a Meteora DAMM v2 route shows 'Pool fee 1.25% in this coin's own Meteora pool, if the route uses it' from the coin's own config (/api/fees?mint=) with the read time, and the footer says, as conditionally, that Vicinity's locked share of that pool earns part of its fee; a coin on its curve shows the quote's curve fee and no pool line", async () => {
  // POOL_ROUTE's one label is also what a route through a second DAMM v2 pool for the coin, or through two DAMM v2 pools, reads as
  // (src/swap.js labelsOf names venues, de-duplicated): the row and the footer below are worded to be true for each
  const P = await swapPage({ slot, answers: { "/api/swap/config": graduatedConfig, "/api/swap/quote": QUOTE({ outputMint: CITY, source: "jupiter_quote", estimate: true, ...POOL_ROUTE }), "/api/fees": feesAnswer({ mint: CITY }) } });
  await type(P, "0.25");
  await P.flush();
  const dts = P.$$(".swap__details dt"), dds = P.$$(".swap__details dd");
  assert.equal(text(dts[5]), "Pool fee");
  // the coin's own pool's fee, not the trade's: the route may use another DAMM v2 pool (anyone can make one) or two of them
  assert.deepEqual([dds[5].hidden, text(dds[5])], [false, `1.25% in this coin's own Meteora pool, if the route uses it (Meteora protocol fee 0.25% included: 20% of the fee, set by Meteora's program) · from the coin's price-curve settings ${SHORT} · read\u00a0${hhmm(READ_AT)}`]);
  assert.equal(text(dds[2]), "network ≈ 0.000005 SOL · priority ≤ 0.0000003 SOL · no platform fee", "the Jupiter fee line as before: Vicinity's platform fee is a different thing and is off");
  assert.deepEqual(P.calls.filter((c) => c.path.startsWith("/api/fees")).map((c) => c.path), [`/api/fees?mint=${CITY}`], "asked once");
  // never "takes no fee" next to a pool fee Vicinity's locked position earns part of
  assert.match(text(P.$(".swap__foot")), /Vicinity never touches your funds and adds no platform fee; if the route uses this coin's own Meteora pool, Vicinity's locked share of it earns part of that pool's fee\./);
  assert.doesNotMatch(text(P.$(".swap__foot")), /takes no fee/);
  // a route that does not go through a Meteora pool (another venue): the coin's pool fee is not this trade's, so no line, and the
  // footer is the plain Jupiter one
  const R = await swapPage({ slot, answers: { "/api/swap/config": graduatedConfig, "/api/swap/quote": QUOTE({ outputMint: CITY, source: "jupiter_quote", estimate: true }), "/api/fees": feesAnswer({ mint: CITY }) } });
  await type(R, "0.25");
  await R.flush();
  assert.equal(R.$$(".swap__details dd")[5].hidden, true);
  assert.equal(R.calls.some((c) => c.path.startsWith("/api/fees")), false, "not asked for a route that does not use the pool");
  assert.match(text(R.$(".swap__foot")), /Vicinity never touches your funds and takes no fee\./);
  // on the curve: the quote's own curve fee (the config's figure through the quote), no pool line
  const C = await swapPage({ slot, answers: { "/api/swap/config": CONFIG, "/api/swap/quote": { ok: true, source: "curve", mint: CITY, side: "buy", chain: "solana:devnet", cluster: "devnet", quoteMint: SOL }, "/api/launchpad/trade/quote": CURVE_QUOTE(), "/api/fees": feesAnswer({ mint: CITY }) } });
  await type(C, "0.005");
  await C.flush();
  assert.equal(text(C.$$(".swap__details dd")[2]), "1.25% curve fee (from the coin's price-curve settings) · network ≈ 0.000005 SOL");
  assert.equal(C.$$(".swap__details dd")[5].hidden, true);
  assert.equal(C.calls.some((c) => c.path.startsWith("/api/fees")), false, "a curve coin's fee is in its quote already");
  // no schedule for it (the route is dark or the coin unknown): no line, nothing made up; the trade still goes through the coin's
  // pool, so the footer still says Vicinity's locked position earns part of the pool fee (decided by the route and the coin's stage,
  // never by whether the figure loaded)
  const N = await swapPage({ slot, answers: { "/api/swap/config": graduatedConfig, "/api/swap/quote": QUOTE({ outputMint: CITY, ...POOL_ROUTE }) } });
  await type(N, "0.25");
  await N.flush();
  assert.equal(N.$$(".swap__details dd")[5].hidden, true);
  assert.match(text(N.$(".swap__foot")), /Vicinity never touches your funds and adds no platform fee; if the route uses this coin's own Meteora pool, Vicinity's locked share of it earns part of that pool's fee\./);
  assert.doesNotMatch(text(N.$(".swap__foot")), /takes no fee/);
  // a coin still on its curve whose quote names a DAMM hop anyway (not this coin's pool): not a pool trade of ours, the footer as before
  const S2 = await swapPage({ slot, answers: { "/api/swap/config": CONFIG, "/api/swap/quote": QUOTE({ outputMint: CITY, ...POOL_ROUTE }) } });
  await type(S2, "0.25");
  await S2.flush();
  assert.match(text(S2.$(".swap__foot")), /Vicinity never touches your funds and takes no fee\./);
});

test("Buy panel: a route split between a Meteora DAMM v2 pool and another venue gets no Pool fee row (one figure would not be the whole trade's), and its footer still never says 'takes no fee'", async () => {
  const P = await swapPage({ slot, answers: { "/api/swap/config": graduatedConfig, "/api/swap/quote": QUOTE({ outputMint: CITY, source: "jupiter_quote", estimate: true, route: ["Meteora DAMM v2", "Raydium CLMM"], routeText: "Routed by Jupiter · executed on Meteora DAMM v2 → Raydium CLMM" }), "/api/fees": feesAnswer({ mint: CITY }) } });
  await type(P, "0.25");
  await P.flush();
  assert.equal(P.$$(".swap__details dd")[5].hidden, true);
  assert.equal(P.calls.some((c) => c.path.startsWith("/api/fees")), false, "not asked");
  assert.match(text(P.$(".swap__foot")), /adds no platform fee; if the route uses this coin's own Meteora pool, Vicinity's locked share of it earns part of that pool's fee\./);
  assert.doesNotMatch(text(P.$(".swap__foot")), /takes no fee/);
});

test("Buy panel: a pool-fee answer that did not come (the limiter) is asked again after half a minute, not kept for the life of the page; a good one is kept", async () => {
  let n = 0;
  const fees = () => (n++ === 0 ? { ok: false, error: "slow_down", _status: 429 } : feesAnswer({ mint: CITY }));
  const P = await swapPage({ clock: true, slot, answers: { "/api/swap/config": graduatedConfig, "/api/swap/quote": QUOTE({ outputMint: CITY, source: "jupiter_quote", estimate: true, ...POOL_ROUTE }), "/api/fees": fees } });
  await type(P, "0.25");
  await P.advance(1000);
  assert.deepEqual([n, P.$$(".swap__details dd")[5].hidden], [1, true], "the 429: no line");
  // the trade goes through the coin's pool either way: the footer never says "takes no fee", with or without the figure
  const foot = () => text(P.$(".swap__foot"));
  assert.match(foot(), /adds no platform fee; if the route uses this coin's own Meteora pool, Vicinity's locked share of it earns part of that pool's fee\./);
  assert.doesNotMatch(foot(), /takes no fee/, "while the answer is a 429");
  await P.advance(31_000); // the failed answer is forgotten; the next render (the price's own refresh) asks again
  await type(P, "0.3");
  await P.advance(1000);
  assert.equal(n, 2);
  assert.equal(P.$$(".swap__details dd")[5].hidden, false);
  assert.doesNotMatch(foot(), /takes no fee/, "once the figure is here");
  await P.advance(60_000);
  await type(P, "0.35");
  await P.advance(1000);
  assert.equal(n, 2, "a good answer is kept");
});

test("Buy panel: the curve fee line names the schedule's own text (src/fees.js through the quote), 'about' included, never a rounded whole basis point", async () => {
  const C = await swapPage({ slot, answers: { "/api/swap/config": CONFIG, "/api/swap/quote": { ok: true, source: "curve", mint: CITY, side: "buy", chain: "solana:devnet", cluster: "devnet", quoteMint: SOL }, "/api/launchpad/trade/quote": CURVE_QUOTE({ fees: { curveFeeBps: 123, curveFeeText: "about 1.233%", networkLamports: 5000, split: {} } }) } });
  await type(C, "0.005");
  await C.flush();
  assert.equal(text(C.$$(".swap__details dd")[2]), "about 1.233% curve fee (from the coin's price-curve settings) · network ≈ 0.000005 SOL");
  assert.match(text(C.$(".swap__more-meta")), /Curve fee about 1\.233%/);
});
