// The coin page (/coin?mint=<mint>, LAUNCHPAD_V2=on), browser side: public/coin.js's pure helpers run here in node, and the built
// page, the script and the stylesheet are checked against each other and against the honesty rules (every number with its source,
// "—" with a reason, no DEX Screener claim before a pool exists, nothing from another site, no markup from text).
// How it looks, the crosshair, the sticky bars and the live refresh are checked in Chromium on the real Worker.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildPages } from "../scripts/pages/build.mjs";

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
const src = read("coin.js"), html = read("coin.html"), css = read("style.css");
const win = {};
vm.runInNewContext(read("coinchart.js"), { window: win, Intl, Date, Math, Number, JSON });
vm.runInNewContext(src, { window: win, Intl, URLSearchParams, Date });
const P = win.VCoin.pure;
const plain = (x) => JSON.parse(JSON.stringify(x));
const MINT = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray", POOL = "3E32cHh3aA4KrAH1ShLbHcdTsTs2EyLKLtpWQNiNySZo";
const TX = "5Gxu1gBSDFAPLKUZihs9tRiFvHxrpgSfcZW8rgZGyfu5F96AWg13d9Czxz1sDxXKwW6DNnJ2x1nFRApqT9QJ788N";

/** An answer of GET /api/coin like the real Worker's (src/coin.js) for $VICINITY on its curve, 6 Oct 2026. */
const answer = (o = {}) => ({
  ok: true, asOf: "2026-10-06T18:35:01.923Z", mint: MINT,
  coin: { kind: "vicinity", ticker: "VICINITY", name: "Vicinity", city: null, pair: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" }, launchedAt: "2026-10-03T16:48:12.000Z", color: "gold", logo: null },
  facts: { supply: 1e9, decimals: 6, program: "SPL Token", mintingDisabled: true, freezingDisabled: true, mintHeldByProgram: false, source: "Solana blockchain, read by vicinity.city" },
  market: {
    priceUsd: 0.000007577217833193381, marketCapUsd: 7577.217833193381, fdvUsd: 7577.217833193381, liquidityUsd: 1787.1359760141286, volume24hUsd: 536.2005190420563, priceChange24hPct: -0.7440200264703254,
    pairAddress: null, dex: null, url: null, priceNative: 6.233650881956076e-8, nativeSymbol: "SOL", liquidityKind: "bonding_curve", traders24h: 18, stage: "curve",
    curve: { poolId: POOL, stage: "curve", symbol: "SOL", raised: 14.795544124, target: 85, progressPct: 17.406522498823527, tokensSold: 354403438.2, tokensForSale: 793100000, supply: 1e9, slot: 453948825 },
    sources: { curve: "Solana blockchain, read by vicinity.city", price: "Jupiter (last trade)", marketCap: "Jupiter", fdv: "Jupiter", liquidity: "SOL in the bonding curve (on-chain) × SOL price (Jupiter)", volume24h: "Jupiter", change24h: "Jupiter" },
    missing: {}, stale: false, ...(o.market || {}),
  },
  holders: { count: 37, asOf: "2026-10-06T18:30:00.000Z", source: "Counted by vicinity.city (pools and team wallets excluded)" },
  trades: { source: "Raydium LaunchLab", rows: [{ txid: TX, at: "2026-10-06T18:13:31.000Z", side: "buy", tokens: 158764.265017, amount: 0.009999621, symbol: "SOL", wallet: "DEBQR*****Q9R", url: `https://solscan.io/tx/${TX}` }] },
  samples: { since: "2026-10-04T06:20:00.000Z", change24hNativePct: -3.602423547901734, source: "vicinity.city samples" },
  links: { raydium: `https://raydium.io/launchpad/token/?mint=${MINT}`, jupiter: `https://jup.ag/swap/SOL-${MINT}`, dexscreener: null, solscan: `https://solscan.io/token/${MINT}`, pool: `https://solscan.io/account/${POOL}` },
  attribution: [{ text: "Price, market cap, 24 h volume & change: Jupiter · Powered by Jupiter", url: "https://jup.ag" }, { text: "Chart & trades: Raydium LaunchLab", url: "https://raydium.io/launchpad/" }],
  ...o.top,
});

test("address bar: only a real mint is used (never shown back), the chart's range, unit and style are kept, candles mean SOL", () => {
  assert.equal(P.mintFromUrl(`?mint=${MINT}`), MINT);
  for (const bad of ["?mint=<script>", "?mint=", "", "?mint=0OIl" + "1".repeat(40), null]) assert.equal(P.mintFromUrl(bad), null, String(bad));
  assert.deepEqual(plain(P.chartFromUrl("")), { range: "7d", unit: null, style: "line" });
  assert.deepEqual(plain(P.chartFromUrl("?range=30d&unit=mcap")), { range: "30d", unit: "MCAP", style: "line" });
  assert.deepEqual(plain(P.chartFromUrl("?range=nope&unit=EUR&style=bars")), { range: "7d", unit: null, style: "line" });
  assert.deepEqual(plain(P.chartFromUrl("?style=candles&unit=usd")), { range: "7d", unit: "SOL", style: "candles" }, "candles exist in SOL only");
  assert.equal(P.urlFor(MINT, { range: "7d", unit: null, style: "line" }), `/coin?mint=${MINT}`);
  assert.equal(P.urlFor(MINT, { range: "24h", unit: "SOL", style: "candles" }), `/coin?mint=${MINT}&range=24h&unit=sol&style=candles`);
  assert.equal(P.urlFor(null, { range: "all" }), "/coin?range=all"); assert.equal(P.urlFor("x<y", {}), "/coin");
});

test("states: listed, not listed (404, also for an address that is not one), switched off, offline, a broken answer", () => {
  assert.equal(P.stateOf(answer()), "ok");
  assert.equal(P.stateOf({ ok: false, error: "unknown_coin", _status: 404 }), "notfound");
  assert.equal(P.stateOf({ ok: false, error: "bad_mint", _status: 400 }), "notfound");
  assert.equal(P.stateOf({ ok: false, error: "not_enabled", _status: 404 }), "disabled");
  assert.equal(P.stateOf({ ok: false, error: "offline", _status: 0 }), "offline");
  assert.equal(P.stateOf({ ok: false, error: "coin_unavailable", _status: 503 }), "error");
  assert.equal(P.stateOf({ ok: true, coin: {}, mint: "nope" }), "error", "an answer without a real mint is not a coin");
  assert.equal(P.stateOf(null), "error");
});

test("numbers: a price keeps every digit that matters, an amount reads at a glance, a change is a signed chip, an age is words", () => {
  assert.equal(P.price(0.000007577217833193381), "$0.000007577"); assert.equal(P.price(6.233650881956076e-8, "SOL"), "0.00000006234 SOL"); assert.equal(P.price(1234.5), "$1,234.50");
  assert.equal(P.price(null), null); assert.equal(P.price(-1), null); assert.equal(P.price(0), "$0");
  assert.equal(P.shortZeros("0.00000006234 SOL"), "0.0₇6234 SOL"); assert.equal(P.shortZeros("$0.000007577"), "$0.0₅7577"); assert.equal(P.shortZeros("$0.0042"), "$0.0042");
  assert.equal(P.money(7577.2178), "$7.58K"); assert.equal(P.money(536.2), "$536.20"); assert.equal(P.money(null), null);
  assert.equal(P.fullMoney(7577.2178), "$7,577.22");
  assert.equal(P.count(37), "37"); assert.equal(P.count(12345), "12.35K"); assert.equal(P.tokens(158764.265017), "158.76K"); assert.equal(P.sol(0.009999621), "0.0100"); assert.equal(P.sol(14.795544124), "14.80");
  assert.deepEqual(plain(P.chip(-0.7440200264703254, " · 24h")), { text: "▼ 0.74% · 24h", cls: "is-down" });
  assert.deepEqual(plain(P.chip(41.2)), { text: "▲ 41.2%", cls: "is-up" }); assert.deepEqual(plain(P.chip(null, " · 24h")), { text: "— · 24h", cls: "is-flat" });
  assert.equal(P.ago(3), "just now"); assert.equal(P.ago(12), "12 s ago"); assert.equal(P.ago(190), "3 min ago"); assert.equal(P.ago(7300), "2 h ago"); assert.equal(P.ago(-1), "");
  const t = Date.parse("2026-10-06T18:35:10Z");
  assert.equal(P.ageSeconds("2026-10-06T18:35:01.923Z", t, t + 20000), 28, "since it arrived, plus what the server's copy had aged");
  assert.equal(P.ageSeconds("2020-01-01T00:00:00Z", t, t + 5000), 5, "a wrong clock cannot inflate it");
  assert.equal(P.firstReason("jupiter has no price for it (no trade in the last 7 days); no SOL price"), "Jupiter has no price for it (no trade in the last 7 days)");
  assert.equal(P.mask(MINT), "2aVkh*****ray"); assert.equal(P.mask("short"), "short");
});

test("tiles: every number with its source, the curve's holdings starred and explained, a missing one '—' with the server's reason", () => {
  const tiles = P.tilesOf(answer());
  const by = Object.fromEntries(tiles.map((t) => [t.key, t]));
  assert.deepEqual(plain(tiles.map((t) => t.key)), ["price", "change", "mcap", "fdv", "liq", "vol", "traders", "native", "change-native", "holders", "supply", "mintauth", "freeze"]);
  assert.deepEqual(plain([by.price.value, by.price.src]), ["$0.000007577", "Jupiter (last trade)"]);
  assert.deepEqual(plain([by.change.value, by.change.src]), ["▼ 0.74%", "Jupiter"]);
  assert.deepEqual(plain([by.mcap.value, by.mcap.title, by.mcap.src]), ["$7.58K", "$7,577.22", "Jupiter"]);
  assert.equal(by.fdv.sub, "= market cap: all of the supply exists", "said only because the chain says no one can mint more");
  assert.deepEqual(plain([by.liq.label, by.liq.value, by.liq.sub]), ["In the curve*", "$1.79K", "14.80 SOL"]);
  assert.match(by.liq.title, /What the bonding curve holds: 14\.80 SOL, valued at the SOL price\. It is not a trading pool\./);
  assert.deepEqual(plain([by.traders.value, by.traders.src]), ["18", "Jupiter"]);
  assert.deepEqual(plain([by.native.label, by.native.value, by.native.title, by.native.src]), ["Price in SOL", "0.0₇6234 SOL", "0.00000006234 SOL", "On-chain curve (Solana)"]);
  assert.deepEqual(plain([by["change-native"].value, by["change-native"].src]), ["▼ 3.60%", "vicinity.city samples"]);
  assert.deepEqual(plain([by.holders.value, by.holders.src]), ["37", "Counted by vicinity.city (pools and team wallets excluded)"]);
  assert.deepEqual(plain([by.supply.value, by.supply.sub]), ["1,000,000,000", "Fixed: no one can mint more"]);
  assert.equal(by.mintauth.value, "Disabled ✓"); assert.equal(by.freeze.value, "Disabled ✓");
  for (const t of tiles) assert.equal(t.missing, null, t.key);
  // the sources had nothing: "—" and the reason, never 0
  const bare = P.tilesOf(answer({ market: { priceUsd: null, marketCapUsd: null, fdvUsd: null, liquidityUsd: null, volume24hUsd: null, priceChange24hPct: null, traders24h: null, priceNative: null,
    missing: { price: "jupiter has no price for it (no trade in the last 7 days); no SOL price", marketCap: "no price to multiply", liquidity: "no SOL price", volume24h: "Jupiter could not be reached; Raydium could not be reached", change24h: "Jupiter could not be reached" } }, top: { holders: null, facts: null, samples: { since: null, change24hNativePct: null } } }));
  const b = Object.fromEntries(bare.map((t) => [t.key, t]));
  assert.deepEqual(plain([b.price.value, b.price.missing]), [null, "Jupiter has no price for it (no trade in the last 7 days)"]);
  assert.deepEqual(plain([b.liq.value, b.liq.missing]), [null, "No SOL price"]);
  assert.deepEqual(plain([b.vol.missing, b.change.missing, b.holders.missing, b.supply.missing]), ["Jupiter could not be reached", "Jupiter could not be reached", "Not counted yet: vicinity.city counts every 10 minutes", "The chain could not be read"]);
  assert.ok(!b.native && !b["change-native"], "no curve price, no samples yet: those tiles are left out rather than shown empty");
  const minting = Object.fromEntries(P.tilesOf(answer({ top: { facts: { supply: 1e9, mintingDisabled: false, freezingDisabled: false, mintHeldByProgram: true, source: "x" } } })).map((t) => [t.key, t]));
  assert.equal(minting.mintauth.value, "Held by the launch program"); assert.equal(minting.freeze.value, "Enabled ⚠"); assert.equal(minting.fdv.sub, null, "no 'all of the supply exists' while minting is possible");
  const pool = Object.fromEntries(P.tilesOf(answer({ market: { liquidityKind: "pool", sources: { liquidity: "DEX Screener" } } })).map((t) => [t.key, t]));
  assert.deepEqual(plain([pool.liq.label, pool.liq.src]), ["Liquidity", "DEX Screener"], "after graduation: a real pool's liquidity, unstarred");
});

test("curve, trade links and trades: SOL raised against the target, GeckoTerminal until DEX Screener lists a pool, each trade in two short lines", () => {
  assert.deepEqual(plain(P.curveOf(answer())), { graduated: false, value: 17.406522498823527, pct: "17.4%", of: "14.80 of 85.00 SOL raised",
    text: "When 85.00 SOL has been raised, $VICINITY moves to a Raydium pool and trades like any other token. Until then every buy and sell happens on the curve. (Raydium's own page shows a progress figure based on price, which reads lower.)" });
  assert.equal(P.curveOf(answer({ market: { curve: { poolId: POOL, stage: "graduated", symbol: "SOL" } } })).pct, "Graduated");
  assert.equal(P.curveOf(answer({ market: { curve: null } })), null);
  assert.deepEqual(plain(P.thirdLink(answer())), { name: "GeckoTerminal", href: `https://www.geckoterminal.com/solana/pools/${POOL}` }, "the pool the chain confirmed, on a site that lists it");
  assert.deepEqual(plain(P.thirdLink(answer({ top: { links: { dexscreener: "https://dexscreener.com/solana/abc" } } }))), { name: "DEX Screener", href: "https://dexscreener.com/solana/abc" }, "once DEX Screener lists a pool");
  assert.equal(P.thirdLink(answer({ top: { links: { dexscreener: "https://evil.example/" } }, market: { curve: null } })), null, "never a link to another site, never a made-up pool");
  assert.equal(P.safeLink(`https://raydium.io/launchpad/token/?mint=${MINT}`, "raydium.io"), `https://raydium.io/launchpad/token/?mint=${MINT}`);
  for (const bad of ["https://raydium.io.evil.example/", "javascript:alert(1)", 'https://raydium.io/" onclick="x', null]) assert.equal(P.safeLink(bad, "raydium.io"), null, String(bad));
  const tv = P.tradeView(answer().trades.rows[0], Date.parse("2026-10-06T18:30:31.000Z"), "VICINITY");
  assert.deepEqual(plain(tv), { side: "buy", sideText: "Buy", amount: "0.0100 SOL", tokens: "158.76K VICINITY", who: "DEBQR*****Q9R · 17 min ago", href: `https://solscan.io/tx/${TX}`, key: TX },
    "in SOL as traded: an old trade is never priced at today's SOL");
  assert.equal(P.tradeView({ ...answer().trades.rows[0], txid: "not-a-signature" }, 0, "X"), null);
  assert.equal(P.tradeView({ ...answer().trades.rows[0], side: "swap" }, 0, "X"), null);
});

test("chart words: the unit it opens in, and a footnote that says where the series comes from and how much history there is", () => {
  const pts = (n) => Array.from({ length: n }, (_, i) => [1000 + i * 600, 0.0000075, "j", null]);
  assert.equal(P.defaultUnit({ line: { points: pts(12) }, candles: { rows: [[1, 1, 1, 1, 1], [2, 1, 1, 1, 1]] } }), "USD", "a dozen readings: USD");
  assert.equal(P.defaultUnit({ line: { points: pts(3) }, candles: { rows: [[1, 1, 1, 1, 1], [2, 1, 1, 1, 1]] } }), "SOL", "a short USD record: Raydium's candles go back to the launch");
  assert.equal(P.defaultUnit({ line: { points: [] }, candles: { rows: [] } }), "USD"); assert.equal(P.defaultUnit(null), "USD");
  const C = win.VChart.pure;
  const chart = { candles: { interval: "1h", rows: [[1791200000, 6e-8, 7e-8, 6e-8, 7e-8]] }, line: { interval: "1h", points: pts(14), recordingSince: "2026-10-04T06:20:00.000Z" } };
  const usd = C.seriesFrom(chart, { unit: "USD" });
  const foot = P.chartFoot(usd, "7d", { x0: 1000, x1: 9000, short: true }, chart, "Europe/Paris");
  assert.match(foot, /^Price in USD: read by vicinity\.city \(Jupiter's last trade, or the on-chain curve × SOL\), a reading every hour · recorded since Oct 4, \d\d:20 · history in this range starts /);
  assert.match(foot, / · times in your time zone \(Europe\/Paris\)$/);
  assert.match(P.chartFoot(C.seriesFrom(chart, { unit: "SOL", style: "candles" }), "7d", null, chart, ""), /^Price in SOL: Raydium LaunchLab \(the curve's price after each trade\), 1-hour candles · times in your time zone$/);
  assert.match(P.chartFoot(C.seriesFrom(chart, { unit: "MCAP", supply: 1e9 }), "7d", null, chart, "", 1e9), /^Market cap = price × 1,000,000,000 \(the supply is fixed: minting is disabled on the chain\)\./);
  // the footnote names the supply the chart really multiplied by (a city coin with 500,000,000 said 1,000,000,000: review DATA-MCAP-FOOTNOTE)
  assert.match(P.chartFoot(C.seriesFrom(chart, { unit: "MCAP", supply: 5e8 }), "7d", null, chart, "", 5e8), /^Market cap = price × 500,000,000 \(/);
  assert.match(src, /const used = view\.unit === "MCAP" \? supply : SUPPLY;[^\n]*\n    const s = window\.VChart\.pure\.seriesFrom\(d, \{ unit: view\.unit, style: view\.unit === "SOL" \? view\.style : "line", supply: used \}\);/);
  assert.match(src, /chartFoot\(s, view\.range, dom, d, tz, used\)/, "the same number in the series and in its footnote");
  // plain words for every interval ("a reading every 4 hour" on the 30-day range: review OA-9)
  for (const [iv, words] of [["4h", "4 hours"], ["1d", "day"], ["1h", "hour"], ["10m", "10 minutes"]]) {
    const fake = { kind: "line", unit: "USD", interval: C.INTERVALS[iv], empty: null };
    assert.match(P.chartFoot(fake, "30d", null, {}, ""), new RegExp(`a reading every ${words} ·`), iv);
  }
  assert.doesNotMatch(P.chartFoot(C.seriesFrom({ candles: { rows: [] } }, { unit: "SOL" }), "24h", null, {}, ""), /candles as a line|minute/, "an empty range names no interval");
});

test("the built page: built from scripts/pages, the Launch tab is current, every id the script uses exists, its two scripts in order, nothing inline", () => {
  assert.equal(new Map(buildPages()).get("coin.html"), html, "public/coin.html is built from scripts/pages/src/coin.html (npm run pages)");
  assert.deepEqual([...html.matchAll(/<script src="\/([a-z/-]+)\.js"/g)].map((m) => m[1]), ["theme", "site", "coinchart", "wallets", "swap", "coin"], "wallets.js and swap.js (the in-app swap, SWAP=on) load before the page script");
  assert.match(html.match(/<nav class="nav"[\s\S]*?<\/nav>/)[0], /<a href="\/launchpad" aria-current="page">Launchpad/, "the coin page sits under the Launchpad");
  assert.match(html.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)[0], /<a href="\/launchpad" aria-current="page">/);
  assert.doesNotMatch(html, /\sstyle="|<style[\s>]|\son[a-z]+="/);
  const ids = [...new Set([...src.matchAll(/\$\("#([a-z0-9-]+)/g)].map((m) => m[1]))];
  assert.ok(ids.length >= 40, "the script addresses the page by ids: " + ids.length);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `page is missing #${id}`);
  for (const id of ["coin-range", "coin-unit", "coin-style"]) assert.match(html, new RegExp(`<div class="seg coin-seg[^"]*" role="group" aria-label="[^"]+" id="${id}">`), id);
  assert.equal((html.match(/data-range="/g) || []).length, 5); assert.match(html, /<button type="button" data-range="7d" aria-pressed="true">7D<\/button>/, "7 days by default");
  assert.match(html, /<canvas class="coin-chart__canvas" id="coin-canvas" tabindex="0" role="img" aria-label="Price chart"><\/canvas>/, "the keyboard reaches the chart");
  assert.match(html, /<progress class="lp-bar coin-curve__bar" id="coin-curve-bar" max="100" value="0" aria-labelledby="coin-curve-title"><\/progress>/);
  assert.match(html, /<div class="coin-mini" id="coin-mini" aria-hidden="true" inert>/); assert.match(html, /<div class="coin-buybar" id="coin-buybar" inert>/, "the slim bars are out of reach until they show");
  assert.match(html, /You trade in your own wallet\. Vicinity never touches your funds\./);
  // every link of the page that opens another site says so
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  assert.equal((main.match(/target="_blank"/g) || []).length, (main.match(/\(opens in a new tab\)/g) || []).length);
  assert.equal((main.match(/target="_blank"/g) || []).length, 7, "and the slim bar's Buy on a short phone");
});

test("the script keeps the rules: only this site's API, no markup from text, outside links only to the sites they name, 30 s refresh only while looked at", () => {
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|console\.|localStorage|sessionStorage|document\.cookie/);
  const calls = [...src.matchAll(/\bapi\(([^)]*)\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(calls, ['"/api/holders"', '"/api/official"', "`/api/coin/chart?mint=${encodeURIComponent(mint", "`/api/coin?mint=${encodeURIComponent(mint"], "our own API, nothing else");
  const hosts = [...new Set([...src.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(hosts, ["solscan.io", "www.geckoterminal.com", "x.com"], "links only (the trade links come from the server and are checked by safeLink)");
  assert.match(src, /const REFRESH_MS = 30000, BACKOFF = \[30000, 60000, 120000, 300000\], CHART_MS = 60000;/);
  assert.match(src, /if \(document\.visibilityState === "hidden"\) return;/, "no refresh while the tab is hidden");
  assert.match(src, /if \(!mint && new URLSearchParams\(location\.search\)\.has\("mint"\)\) \{ note\("notfound"\); return; \}/, "an address that is not one is never asked about");
  assert.match(src, /V\.liveNums\(\[\$\("#coin-price"\), \$\("#coin-mini-price"\), \$\("#coin-holders-n"\)\]\);/, "the live price eases (the crosshair writes into its own copy)");
  assert.match(src, /const logo = \/\^\\\/api\\\/media\\\/\[A-Za-z0-9_-\]\{1,64\}\$\/\.test\(str\(c\.logo\)\) \? c\.logo : null;/, "a logo only from our own media route");
  assert.doesNotMatch(src, /description|imgUrl|ipfs/, "no third-party description or image");
});

test("styles: the page's still part with the Launchpad block, every control at least 44 px, the chart lets a vertical swipe scroll, two columns from 1024 px", () => {
  const at = css.indexOf("/* the coin page (/coin)"), end = css.indexOf("/* ---- dashboard v2 ---- */");
  assert.ok(at > 0 && end > at);
  const block = css.slice(at, end);
  assert.doesNotMatch(block, /@keyframes|animation\s*:|transition\s*:/, "nothing moves by itself here");
  assert.match(block, /\.coin-seg button \{ min-height: 44px; min-width: 44px;/); assert.match(block, /\.coin-back \{[^}]*min-height: 44px;/);
  assert.match(block, /\.coin-chart__canvas \{[^}]*touch-action: pan-y;/); assert.match(block, /\.coin-chart__stage \{ position: relative; height: 260px;/);
  assert.match(block, /@media \(min-width: 1024px\) \{\n  \.coin-page \{ padding-top: 16px; \}\n  \.coin-grid \{ grid-template-columns: minmax\(0, 1fr\) 360px;/);
  assert.match(block, /\.coin-chart__stage \{ height: 380px; \}/);
  assert.match(block, /\.coin-mini \{ position: fixed; top: 66px;/, "the slim header sits under the site header");
  assert.match(block, /@media \(max-width: 900px\) \{ \.coin-buybar \{ bottom: var\(--tabbar-h, 67px\);/, "the Buy bar sits above the phone's tab bar");
  const mo = css.slice(css.indexOf("Launchpad live market: motion (LAUNCHPAD_V2=on"), css.indexOf("Member profiles (PROFILES=on)"));
  assert.match(mo, /\.coin-buybar \{ transition: transform \.22s cubic-bezier\(\.2,\.8,\.2,1\), visibility 0s linear \.22s; \}/, "the bar slides (transform), only when motion is welcome");
});

test("honesty (review): each figure in the header line names its own source, and a city coin is called a LaunchLab coin only when the chain or Jupiter says so", () => {
  // the curve's price with a market cap from the same source family, each named
  const d = answer({ market: { priceUsd: 7.53e-6, marketCapUsd: 7530, sources: { price: "On-chain curve × SOL price (Jupiter)", marketCap: "Price × on-chain supply" } } });
  assert.equal(P.priceLine(d.market, 8), "On-chain curve × SOL price (Jupiter) · Market cap $7.53K (Price × on-chain supply) · updated 8 s ago");
  assert.equal(P.priceLine({ priceUsd: null, missing: { price: "jupiter could not be reached; the chain could not be read" } }, 3), "No price right now: Jupiter could not be reached");
  assert.doesNotMatch(src, /sub\.push\(`Market cap \$\{money\(m\.marketCapUsd\)\}`\)/, "no market cap without its source next to it");
  // a city coin: no curve on the chain and no word from Jupiter: no venue named
  const city = (market) => answer({ top: { coin: { kind: "city", ticker: "UTICA", name: "Utica Coin", city: { id: "5142056", name: "Utica", country: "US" }, pair: { symbol: "SOL" } } }, market });
  assert.equal(P.cityAbout(city({ curve: null, launchpad: null })), "$UTICA is the one official coin of Utica, US: launched by its founder, paired with SOL, and recorded by Vicinity.");
  assert.match(P.cityAbout(city({ launchpad: "raydium-launchlab" })), /launched by its founder on Raydium LaunchLab, paired with SOL/);
  assert.match(P.cityAbout(city({})), /on Raydium LaunchLab/, "the curve the chain found is enough");
  assert.equal(P.onLaunchLab(city({ curve: null, launchpad: null })), false);
});

test("the chart legend names its source and is written only when it changes (a polite live region re-read it every 30 s: review A11Y-LEGEND-LIVE, OA-10)", () => {
  assert.equal(P.legendText({ unit: "USD" }, "▼ 3.16%", "24 hours"), "vicinity.city readings: ▼ 3.16% over 24 hours", "not to be mistaken for Jupiter's 24 h change in the header");
  assert.equal(P.legendText({ unit: "SOL" }, "▲ 1.20%", "7 days"), "Raydium LaunchLab: ▲ 1.20% over 7 days");
  const draw = src.slice(src.indexOf("  function drawChart(animate) {"), src.indexOf("  async function loadChart("));
  assert.doesNotMatch(draw, /leg\.textContent =|\$\("#coin-legend"\)\.textContent =|\$\("#coin-chart-foot"\)\.textContent =/, "no unconditional writes");
  assert.match(draw, /put\(leg, legendText\(s, c\.text, dom && dom\.short \? "the history shown" : RANGE_WORDS\[view\.range\]\)\);/);
  assert.match(draw, /if \(leg\.className !== cls\) leg\.className = cls;/);
});

test("phones keep at most two bars over the coin page while it scrolls, the curve card holds its place from the first paint, and a hidden bar never loops (review OA-4, PM-6, PM-9)", () => {
  // at 320 × 640 the site header, the slim bar, the Buy bar and the tab bar covered 250 px (39%): the slim bar now takes the header's
  // place, and on a short screen it carries Buy itself (measured: 119 px at 320 × 640, 183 px at 390 × 844)
  const bars = src.slice(src.indexOf("  function wireBars() {"), src.indexOf("  /* ----- loading:"));
  assert.match(bars, /const phone = window\.matchMedia\("\(max-width: 1023px\)"\), short = window\.matchMedia\("\(max-height: 700px\)"\);/);
  assert.match(bars, /document\.body\.classList\.toggle\("has-coin-mini", m\);/);
  assert.match(bars, /&& phone\.matches && !short\.matches;/, "no Buy bar on a short screen");
  assert.match(css, /@media \(max-width: 1023px\) \{\n  \.coin-mini \{ top: 0; \}\n  body\.has-coin-mini \.site-header:not\(:focus-within\) \{ transform: translateY\(-100%\); \}\n\}/, "the header comes back for the keyboard");
  assert.match(css, /@media \(max-width: 1023px\) and \(max-height: 700px\) \{\n  \.coin-mini__buy:not\(\[hidden\]\) \{ display: inline-flex;[^}]*min-height: 44px;/);
  assert.match(html, /<a class="btn btn--primary btn--sm coin-mini__buy" id="coin-mini-buy" href="\/launchpad" rel="noopener" target="_blank" hidden>Buy <span aria-hidden="true">↗<\/span><span class="sr-only"> on Raydium \(opens in a new tab\)<\/span><\/a>/);
  assert.match(src, /for \(const id of \["#coin-lnk-raydium", "#coin-head-buy", "#coin-buybar-buy", "#coin-mini-buy"\]\) set\(id, ray\);/, "the same safe Raydium link");
  assert.match(src, /put\(\$\("#coin-mini-price"\), p \? shortZeros\(p\) : "—"\);/);
  assert.match(css, /\.coin-buybar:not\(\.is-on\), \.coin-mini:not\(\.is-on\) \{ --lb-play: paused; \}/);
  // the curve card: there from the start with its room kept (CLS 0.068 on a computer when it appeared and pushed the contract card down)
  assert.match(html, /<section class="card coin-curve" id="coin-curve" aria-labelledby="coin-curve-title">/, "not hidden until the answer");
  assert.match(html, /id="coin-curve-text">Reading the bonding curve from the chain…<\/p>/);
  assert.match(css, /@media \(min-width: 1024px\) \{ \.coin-curve__text \{ min-height: 9\.9em; \} \.coin-curve__src \{ min-height: 2\.9em; \} \}/);
  assert.match(src, /function paintCurve\(d\) \{\n    const cv = curveOf\(d\);\n    show\("#coin-curve", Boolean\(cv\)\);/, "hidden only when the answer has no curve");
});
