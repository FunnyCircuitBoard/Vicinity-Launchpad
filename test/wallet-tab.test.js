// The Wallet tab (wallet onboarding, step 1; DASHBOARD_V2=on): second in the strip. With no wallet linked it shows the wallet card itself
// (the one card of Home, with its connect and link paths, moved into the panel while the tab is open) and nothing else. With a wallet
// linked: RECEIVE (the full address in a monospace block, Copy with "Copied" and a live region, a QR code of the plain address drawn
// with the QR code library the pairing flow already ships, two plain lines about the network) and BALANCES (SOL, $VICINITY and the
// city coins held, from the two answers the site already has: GET /api/swap/balances for the amounts, GET /api/me/portfolio for the US
// dollar values and for where each city ticker came from; "—" where a value is not known), one line "Balances read from the Solana chain
// at HH:MM. Refresh", the loading, empty and unavailable states, Refresh at most once per 10 s on the page (the Worker's memo is 10 s),
// and a compact Buy & swap entry that opens the existing Buy card. Sending is not part of this step: nothing here signs or sends.
// Runs the real page in node (test/helpers/dashpage.js); static checks pin the markup, the sheet and the two scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ADDR, UA, memberMe, openDashboard } from "./helpers/dashpage.js";
import { handleApi } from "../src/index.js";
import { _resetRelay } from "../src/relay.js";
import { _resetSwap } from "../src/swap.js";
import { newWorld } from "./helpers/world.js";
import { REAL_VIC, fakeWorld } from "./helpers/jupfake.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const html = read("public/dashboard.html"), src = read("scripts/pages/src/dashboard.html"), v2 = read("public/dashboard-v2.js"), dash = read("public/dashboard.js");
const css = read("public/polish-dash.css"), relay = read("src/relay.js");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const VIC = REAL_VIC; // the live $VICINITY mint the fakes know
const UTICA = "CnQMR167gRRXcPYrDZkwbW6moYKmxd7gZNGSN6BNzz6p", OSWEGO = "47ugnHuxsmgNZu8KEv1VXW7wPVVwMWti8vVrK4ADDxWa", ROME = "G3aqFFHFeeWTYnnPPaNHUvgLj8XSUCN95fQtJQosdqWp";

/** dashboard-v2.js with a stub window (its top level only reads window.V and publishes window.VDash). */
function loadV2() {
  const window = { V: {}, addEventListener() {} };
  vm.runInNewContext(v2, { window });
  return window.VDash;
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const rowsOf = (p) => [...p.$$("#wt-rows .wtab-row")].map((li) => ({
  label: li.querySelector(".wtab-row__name strong").textContent, sub: li.querySelector(".wtab-row__sub").textContent,
  amount: li.querySelector(".wtab-row__amt strong").textContent, usd: li.querySelector(".wtab-row__usd").textContent,
}));
/** A console that remembers what the page logged (the page must log nothing). */
function quietConsole() { const out = []; const f = (k) => (...a) => out.push([k, ...a.map(String)]); return { out, console: { log: f("log"), info: f("info"), warn: f("warn"), error: f("error"), debug: f("debug") } }; }

// the server's two answers for a wallet that holds $VICINITY and three city coins: one ticker from the chain, one from the city list,
// one coin without a ticker (it goes by its name), and one without a price
const PORTFOLIO = { ok: true, portfolio: { asOf: "2026-10-09T14:04:50Z", totalUsd: 12.901, pricesComplete: false, items: [
  { kind: "vicinity", mint: VIC, symbol: "VICINITY", name: "Vicinity", amount: 25000, priceUsd: 0.0004, valueUsd: 10, sharePct: 77.5 },
  { kind: "city", mint: UTICA, symbol: "UTICA", name: "Utica Coin", tickerSource: "chain", city: { id: "5142056", name: "Utica", country: "US" }, amount: 1200.5, priceUsd: 0.002, valueUsd: 2.401, sharePct: 18.6 },
  { kind: "city", mint: ROME, symbol: "Rome Coin", name: "Rome Coin", tickerSource: null, city: { id: "5134295", name: "Rome", country: "US" }, amount: 0.5, priceUsd: 1, valueUsd: 0.5, sharePct: 3.9 },
  { kind: "city", mint: OSWEGO, symbol: "OSWEGO", name: "Oswego Coin", tickerSource: "registry", city: { id: "5129573", name: "Oswego", country: "US" }, amount: 3, priceUsd: null, valueUsd: null, sharePct: null },
] } };
const BALANCES = { ok: true, owner: ADDR, cluster: "mainnet", at: "2026-10-09T14:05:00Z", sol: { lamports: 1234567890, ui: 1.23456789 },
  tokens: { [VIC]: { ui: 25000, hasAccount: true }, [UTICA]: { ui: 1200.5, hasAccount: true }, [ROME]: { ui: 0.5, hasAccount: true }, [OSWEGO]: { ui: 3, hasAccount: true } } };
const PRICES = { ok: true, prices: { [SOL_MINT]: 150.25 } };
const COINS = { ok: true, coin: null, pairs: null, vicinity: VIC };
/** The server of a test: each answer a value or a function of the path (so a test can hold one back or count). */
function server({ portfolio = PORTFOLIO, balances = BALANCES, prices = PRICES, coins = COINS } = {}) {
  const pick = (a, path) => (typeof a === "function" ? a(path) : a);
  return async (path) => {
    const base = path.split("?")[0];
    if (base === "/api/coins") return pick(coins, path);
    if (base === "/api/me/portfolio") return pick(portfolio, path);
    if (base === "/api/swap/balances") return pick(balances, path);
    if (base === "/api/prices") return pick(prices, path);
    return undefined;
  };
}
const linked = (over = {}) => memberMe({ wallet: ADDR, launched: true, amount: 25000, rank: 12, ...over });

/* ---------- static ---------- */
test("the markup: the Wallet tab after Home, its panel with the Receive and Balances cards (hidden until a wallet is linked), the two plain network lines, a 44 px Copy with a live region, the QR code as a static svg, nothing inline", () => {
  for (const [name, page] of [["source", src], ["built page", html]]) {
    const tabs = [...page.matchAll(/<a class="dtab" id="tab-([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(tabs.slice(0, 3), ["home", "wallet", "city"], `${name}: after Home, before City`);
    const panels = [...page.matchAll(/<section class="dpanel" id="panel-([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(panels.slice(0, 3), ["home", "wallet", "city"], `${name}: the panels in the same order`);
  }
  assert.match(html, /<a class="dtab" id="tab-wallet" role="tab" href="#wallet" data-tab="wallet" aria-controls="panel-wallet" aria-selected="false" tabindex="-1" aria-label="Wallet"><span class="dtab__ico" aria-hidden="true"><svg [^>]*><rect /, "named Wallet, with an icon (a phone's strip, a crowded tablet strip)");
  assert.match(html, /<section class="dpanel" id="panel-wallet" role="tabpanel" aria-labelledby="tab-wallet" tabindex="0" hidden>/);
  // Receive
  assert.match(html, /<section class="card wtab" id="wt-receive" aria-labelledby="wt-receive-title" hidden>/);
  assert.match(html, /<p class="kicker">Receive<\/p><h2 class="h2--sm" id="wt-receive-title">Your wallet address<\/h2>/);
  assert.match(html, /<code class="wtab-addr mono" id="wt-addr">—<\/code>/, "the full address, monospace");
  assert.match(html, /<button class="btn btn--glass btn--sm wtab-copy" type="button" id="wt-copy">Copy<\/button>/);
  assert.match(html, /<span class="sr-only" id="wt-copy-live" role="status" aria-live="polite"><\/span>/, "the Copied feedback is read out");
  assert.match(html, /<figure class="wtab-qr" id="wt-qr" hidden>\s*<svg viewBox="0 0 29 29" width="180" height="180" role="img" aria-label="QR code of your wallet address" shape-rendering="crispEdges" focusable="false"><path id="wt-qr-path" fill="currentColor" d=""\/><\/svg>/, "the QR code is one static svg with one path the script fills (no markup from text)");
  assert.match(html, /<p class="small">Solana mainnet only\. Send SOL, \$VICINITY or Vicinity city coins to this address from another wallet or an exchange\.<\/p>/);
  assert.match(html, /<p class="small muted">Anything else sent here is still yours, but this page does not show it\.<\/p>/);
  assert.doesNotMatch(html, /solana:[A-Za-z0-9]/, "no payment URI: the QR code is the plain address");
  // Balances
  assert.match(html, /<section class="card wtab" id="wt-balances" aria-labelledby="wt-balances-title" hidden>/);
  assert.match(html, /<p class="kicker">Balances<\/p><h2 class="h2--sm" id="wt-balances-title">What this wallet holds<\/h2>/);
  assert.match(html, /<p class="small muted" id="wt-loading">Reading your balances…<\/p>/);
  assert.match(html, /<ul class="wtab-rows" id="wt-rows" hidden><\/ul>/);
  assert.match(html, /<div class="empty wtab-empty" id="wt-empty" hidden><strong>Nothing here yet<\/strong><span>Send SOL, \$VICINITY or a Vicinity city coin to the address above and it shows here\.<\/span><\/div>/);
  assert.match(html, /<p class="tiny muted wtab-read" id="wt-read" hidden><span id="wt-read-text"><\/span> <button class="link-btn wtab-refresh" type="button" id="wt-refresh">Refresh<\/button><\/p>/);
  assert.match(html, /<div class="dv2-actions"><a class="btn btn--primary btn--sm" id="wt-buy" href="#home" data-go="#trade">Buy &amp; swap<\/a><\/div>/, "the Buy & swap entry opens the existing Buy card, not a copy");
  // nothing presented as live that is not: no Send anywhere in the tab
  const panel = html.slice(html.indexOf('id="panel-wallet"'), html.indexOf('id="panel-city"'));
  assert.doesNotMatch(panel, /\bSend\b(?! SOL)/, "no Send button or Send card (a later step)");
  assert.doesNotMatch(panel, /In development|Coming soon|placeholder/i);
  assert.doesNotMatch(panel, /\sstyle="/); assert.doesNotMatch(panel, /\son[a-z]+="/);
  assert.doesNotMatch(panel, /risk|lose|warning/i, "no risk warnings in the chrome: one factual line about the network");
});

test("the sheet: the Copy button is 44 px, the code is dark on white in both themes, the address wraps, the Wallet tab becomes its icon in a crowded strip, every rule under .dv2", () => {
  const from = css.indexOf("/* ---------- the Wallet tab"), to = css.indexOf("/* ---------- the signed-out page");
  assert.ok(from > 0 && to > from, "the Wallet tab's block");
  const block = css.slice(from, to);
  for (const line of block.split("\n").filter((l) => /^\s*[.@\[a-z:]/.test(l) && !l.startsWith("/*"))) assert.match(line, /^(\.dv2 |@media )/, line.slice(0, 60));
  assert.match(block, /\.dv2 \.wtab-copy \{ min-height: 44px; min-width: 44px; \}/);
  assert.match(block, /\.dv2 \.wtab-refresh \{ min-height: 44px;/);
  assert.match(block, /\.dv2 \.wtab-qr svg \{[^}]*background: #fff; color: #0B1626; \}/, "a camera reads dark on white, whatever the theme");
  assert.match(block, /\.dv2 \.wtab-addr \{[^}]*overflow-wrap: anywhere; word-break: break-all;[^}]*\}/, "a 44-character address fits a 320 px phone");
  assert.match(block, /\.dv2 \.dtabs\.is-compact #tab-wallet \.dtab__text \{ display: none; \}\n\.dv2 \.dtabs\.is-compact #tab-wallet \.dtab__ico \{ display: block; \}/);
  assert.match(block, /\.dv2 \.wtab-row__amt \{[^}]*font-variant-numeric: tabular-nums;/);
  assert.doesNotMatch(block, /animation|transition/, "nothing moves on its own");
});

test("the scripts: dashboard-v2.js draws from the answers dashboard.js reads (it never fetches), the two answers are the existing ones, one read per 10 s, nothing is sent or signed", () => {
  // v2: the tab, the panel order, the rows from the two answers, the QR code from the library through ctx.qr, Copy through window.V.copy
  assert.match(v2, /const TABS = Object\.freeze\(\["home", "wallet", "city", "community", "notify", "rankings", "founder", "moderate", "profile"\]\);/, "Wallet second; Notifications (NOTIFY=on) after Feed");
  assert.match(v2, /wallet: \["#wt-receive", "#wt-balances"\],/);
  assert.doesNotMatch(v2, /\bfetch\(|XMLHttpRequest|\bapi\(/, "v2 never talks to the server");
  assert.match(v2, /if \(\(again \|\| !walletData\) && ctx\.readWallet\) ctx\.readWallet\(\);/, "the balances come through dashboard.js; after an /api/me only while nothing was read for this wallet yet");
  assert.match(v2, /if \(active === "wallet"\) enterWallet\(\{ again: false \}\);/, "the minute /api/me refresh does not poll the chain");
  assert.match(v2, /try \{ await navigator\.clipboard\.writeText\(w\); ok = true; \} catch \{ ok = false; \}/, "Copy writes the clipboard itself: the button and the live region are the one announcement (no toast)");
  assert.match(v2, /function walletOn\(\) \{ const m = me\(\); return !m \|\| Boolean\(m\.user && m\.user\.wallet\) \|\| m\.signupFlow === "v2"; \}/, "the tab only where it has something to show");
  assert.match(v2, /ctx\.qr\(\)\.then\(/, "so does the QR code library");
  assert.match(v2, /if \(typeof window\.qrcode !== "function"\) return null;/, "without the library the figure stays hidden, the address is still there");
  assert.match(v2, /\$\("#wt-qr-path"\)\.setAttribute\("d", q\.d\);/, "the code is one path of squares, numbers only");
  assert.match(v2, /if \(inWallet\) \$\("#panel-wallet"\)\.prepend\(card\);/, "no wallet linked: the Wallet tab shows the wallet card itself");
  assert.match(v2, /label: ticker \? `\$\$\{String\(ticker\)\.replace\(\/\^\\\$\/, ""\)\}` : name/, "a city coin's label is its ticker from the chain or the city list, else its name: never made up");
  assert.doesNotMatch(v2, /toUpperCase\(\)\.slice\(0, [3-6]\)|slice\(0, 4\)\.toUpperCase/, "no ticker invented from a name");
  assert.doesNotMatch(v2, /signTransaction|signAndSend|sendTransaction|\/api\/swap\/send|\/api\/swap\/tx/, "nothing is sent or signed from the Wallet tab");
  // dashboard.js: the two existing answers (and the Buy card's own SOL price), one read per 10 s per wallet
  assert.match(dash, /const pf = await api\("\/api\/me\/portfolio"\);/);
  assert.match(dash, /api\(`\/api\/swap\/balances\?owner=\$\{encodeURIComponent\(owner\)\}&mints=\$\{mints\.join\(","\)\}\$\{fresh\}`\)/, "the balances answer, with the Worker's memo");
  // fresh=1 only after a send was confirmed (public/wallet-send.js, step 2: the memo may still hold the balances from before it); the tab's own reads never pass it
  const rw = dash.slice(dash.indexOf("async function readWallet"), dash.indexOf("function loadWalletSend"));
  assert.match(rw, /const fresh = afterSend \? "&fresh=1" : "";/);
  assert.equal((rw.match(/fresh=1/g) || []).length, 1, "the one place");
  assert.match(dash, /const WALLET_READ_MS = 10_000;/);
  assert.match(dash, /const solUsd = pr && pr\.ok !== false && !pr\.stale && pr\.prices && Number\(pr\.prices\[SOL_MINT\]\) > 0 \? Number\(pr\.prices\[SOL_MINT\]\) : null;/, "never a stale SOL price (the portfolio's rule for the coins)");
  assert.match(dash, /portfolioOk: Boolean\(portfolio\), portfolioOff: Boolean\(pf && pf\._status === 404\), solUsd, at: balances \? balances\.at \|\| null : null \}\);/, "the page is told what is missing; the read time is the Worker's or none");
  // one read at a time, one per 10 s; after a send (afterSend, step 2) a running read is waited for and the chain asked again
  assert.match(dash, /if \(walletRead\.busy\) \{ if \(!afterSend\) return false; try \{ await walletRead\.promise; \} catch \{ [^}]* \} return readWallet\(\{ afterSend: true \}\); \}/);
  assert.match(dash, /if \(!afterSend && walletRead\.owner === owner && Date\.now\(\) - walletRead\.at < WALLET_READ_MS\) return false;/);
  assert.match(dash, /s\.src = "\/vendor\/qrcode\.js"/, "the QR code library the pairing flow already ships (scripts\/copy-assets.mjs)");
  assert.match(dash, /readWallet, qr: loadQR \}\);/, "both handed to v2 through ctx");
  // the Worker: the balances answer says when it was read (additive; every key it had stays)
  assert.match(relay, /json\(\{ ok: true, owner, cluster, at: new Date\(hit\.at\)\.toISOString\(\), \.\.\.\(await hit\.promise\) \}, 200, \{ "Cache-Control": "no-store" \}\)/);
  assert.match(relay, /GET  \/api\/swap\/balances\?owner=&mints=&fresh=1 -> \{ ok, at \(ISO: when the chain was read\), sol: \{ lamports, ui \}, tokens: \{ mint: \{ ui, hasAccount \} \} \}/);
});

test("walletRows (pure): SOL, $VICINITY, the city coins held with the ticker rule (chain, registry, none), amounts from the balances answer first, USD only where a price is known", () => {
  const VDash = loadV2();
  const ctx = { vicMint: VIC, coin: null, community: { name: "Utica", ticker: "UTICA", tickerSource: "chain" } };
  const rows = plain(VDash.walletRows({ balances: BALANCES, portfolio: PORTFOLIO.portfolio, solUsd: 150.25 }, ctx));
  assert.deepEqual(rows.map((r) => [r.label, r.sub]), [["SOL", "Solana"], ["$VICINITY", "Vicinity"], ["$UTICA", "Utica city coin · ticker on chain"], ["Rome Coin", "Rome city coin"], ["$OSWEGO", "Oswego city coin · ticker fixed by the map"]]);
  assert.deepEqual(rows.map((r) => r.amount), [1.23456789, 25000, 1200.5, 0.5, 3]);
  assert.deepEqual(rows.map((r) => (r.usd == null ? null : Math.round(r.usd * 1000) / 1000)), [185.494, 10, 2.401, 0.5, null], "no price: no value, never a made-up one");
  // the balances answer is the amount's source when it was asked; the portfolio's when it was not (a seventh coin the six-mint call left out)
  const bal = { ...BALANCES, tokens: { [VIC]: { ui: 24000, hasAccount: true } } };
  const r2 = plain(VDash.walletRows({ balances: bal, portfolio: PORTFOLIO.portfolio, solUsd: null }, ctx));
  assert.equal(r2[1].amount, 24000); assert.equal(Math.round(r2[1].usd * 100) / 100, 9.6, "the price times the amount shown");
  assert.equal(r2[2].amount, 1200.5, "from the portfolio"); assert.equal(r2[0].usd, null, "no SOL price: no value");
  // no portfolio (PROFILES off, or it failed): SOL and $VICINITY from the balances answer alone, no dollar values
  const r3 = plain(VDash.walletRows({ balances: BALANCES, portfolio: null, solUsd: 150.25 }, ctx));
  assert.deepEqual(r3.map((r) => [r.label, r.amount, r.usd == null]), [["SOL", 1.23456789, false], ["$VICINITY", 25000, true]]);
  // the home city's launched coin the wallet holds none of: shown at 0 with /api/me's ticker (never one made from the name)
  const home = { launched: true, mint: UTICA, name: "Utica Coin" };
  const r4 = plain(VDash.walletRows({ balances: { ...BALANCES, tokens: { [UTICA]: { ui: 0, hasAccount: false } } }, portfolio: { items: [] }, solUsd: null }, { ...ctx, coin: home }));
  assert.deepEqual(r4.map((r) => [r.label, r.sub, r.amount]), [["SOL", "Solana", 1.23456789], ["$VICINITY", "Vicinity", null], ["$UTICA", "Utica city coin · ticker on chain", 0]]);
  const r5 = plain(VDash.walletRows({ balances: BALANCES, portfolio: { items: [] }, solUsd: null }, { vicMint: null, coin: home, community: { name: "Utica", ticker: null } }));
  assert.deepEqual(r5.map((r) => r.label), ["SOL", "Utica Coin"], "no mint known: no $VICINITY row; a city without a ticker: the coin's name");
  // before launch: no $VICINITY mint, no row for it
  assert.deepEqual(plain(VDash.walletRows({ balances: BALANCES, portfolio: null, solUsd: null }, { vicMint: null, coin: null, community: null })).map((r) => r.label), ["SOL"]);
  // /api/coins gave no mint (that call failed, or the account has no community) but the portfolio lists $VICINITY: its row is there, from the portfolio's mint
  const r6 = plain(VDash.walletRows({ balances: BALANCES, portfolio: PORTFOLIO.portfolio, solUsd: null }, { vicMint: null, coin: null, community: null }));
  assert.deepEqual(r6.map((r) => r.label), ["SOL", "$VICINITY", "$UTICA", "Rome Coin", "$OSWEGO"]);
  assert.equal(r6[1].amount, 25000); assert.equal(r6[1].usd, 10); assert.equal(r6[1].key, VIC);
});

/* ---------- the page: no wallet linked ---------- */
test("no wallet linked: the Wallet tab shows the wallet card itself (its connect path), nothing else new, and asks the server for nothing; the card is back in Home when the person leaves", async () => {
  const q = quietConsole();
  const p = await openDashboard({ me: memberMe(), api: server(), globals: { console: q.console } });
  const home = p.$("#panel-home"), wallet = p.$("#panel-wallet"), card = p.$("#wallet-card");
  assert.equal(card.parentNode, home); assert.equal(card.hidden, false);
  assert.equal(p.$("#tab-wallet").hidden, false, "the tab is there for everyone signed in");
  await p.tap(p.$("#tab-wallet"));
  assert.equal(p.win.VDash.active, "wallet"); assert.equal(wallet.hidden, false);
  assert.equal(card.parentNode, wallet, "the one wallet card, in the Wallet tab");
  assert.equal(card.hidden, false); assert.equal(card.classList.contains("is-merged"), false);
  assert.equal(p.text("#wcard-title"), "Connect your wallet"); assert.equal(p.$("#wcard-go").getAttribute("href"), "/connect?mode=link");
  assert.equal(p.$("#wt-receive").hidden, true); assert.equal(p.$("#wt-balances").hidden, true);
  assert.deepEqual(wallet.children.filter((n) => !n.hidden).map((n) => n.id), ["wallet-card"], "nothing else: no placeholder for Receive or Balances");
  assert.equal(p.callsTo("/api/me/portfolio").length, 0); assert.equal(p.callsTo("/api/swap/balances").length, 0);
  assert.equal(typeof p.win.qrcode, "undefined", "no address to draw: the QR code library is not fetched");
  await p.tap(p.$("#tab-home"));
  assert.equal(card.parentNode, home, "back in Home");
  const kids = home.children.map((n) => n.id);
  assert.equal(kids.indexOf("wallet-card"), kids.indexOf("welcome") + 1, "right after the welcome, where it stood");
  assert.deepEqual(q.out, [], "nothing logged");
});

test("the wallet gets linked while the Wallet tab is open (the minute refresh sees it): the card leaves, Receive and Balances show and the balances are read", async () => {
  let wallet = null;
  const p = await openDashboard({ me: () => memberMe({ wallet }), api: server() });
  await p.tap(p.$("#tab-wallet"));
  assert.equal(p.$("#wallet-card").parentNode.id, "panel-wallet");
  wallet = ADDR;
  await p.advance(60_000);
  assert.equal(p.$("#wallet-card").parentNode.id, "panel-home", "the card is Home's again (hidden: nothing to ask)");
  assert.equal(p.$("#wt-receive").hidden, false); assert.equal(p.$("#wt-balances").hidden, false);
  assert.equal(p.text("#wt-addr"), ADDR);
  assert.equal(p.callsTo("/api/swap/balances").length, 1, "read once the wallet is there");
});

/* ---------- the page: a wallet linked ---------- */
test("a wallet linked: the address, Copy (Copied, read out), the QR code, the balance rows from the two answers with the ticker rule and dollar values, the time line, Refresh at most once per 10 s, Buy & swap opens the existing Buy card", async () => {
  const q = quietConsole();
  const p = await openDashboard({ me: linked(), api: server(), globals: { console: q.console } });
  assert.equal(p.callsTo("/api/swap/balances").length, 0, "nothing read until the tab is opened");
  assert.equal(p.callsTo("/api/me/portfolio").length, 0);
  assert.equal(p.$("#wt-receive").hidden, false, "the cards are ready in the (hidden) panel");
  assert.equal(p.text("#wt-addr"), ADDR, "the full address");
  assert.equal(p.$("#wallet-card").hidden, true, "a linked wallet on a computer: the card has nothing to ask");
  assert.equal(typeof p.win.qrcode, "undefined", "the QR code library is not loaded with the page");
  await p.tap(p.$("#tab-wallet"));
  assert.equal(p.win.VDash.active, "wallet");
  // the two answers, one call each; the balances call names the wallet and every mint the portfolio listed (the live $VICINITY mint first)
  assert.equal(p.callsTo("/api/me/portfolio").length, 1);
  const bal = p.callsTo("/api/swap/balances");
  assert.equal(bal.length, 1);
  const url = new URL(bal[0].path, "https://vicinity.test");
  assert.equal(url.searchParams.get("owner"), ADDR);
  assert.deepEqual(url.searchParams.get("mints").split(","), [VIC, UTICA, ROME, OSWEGO]);
  assert.equal(url.searchParams.get("fresh"), null, "the Worker's memo is honoured");
  assert.equal(p.callsTo("/api/prices").filter((c) => c.path.endsWith(`mints=${SOL_MINT}`)).length, 1, "SOL's dollar price, from the Buy card's own price source (which the Buy card asks for its pair too)");
  // the QR code: drawn with the shipped library into the static svg, the plain address, a quiet zone of two
  const fig = p.$("#wt-qr"), path = p.$("#wt-qr-path");
  assert.equal(fig.hidden, false);
  assert.equal(typeof p.win.qrcode, "function", "the library was fetched when the tab first showed an address (the harness runs /vendor/qrcode.js when the page asks for it)");
  const d = path.getAttribute("d");
  assert.match(d, /^M0 0h1v1h-1z/, "the top-left finder pattern starts the path");
  assert.ok(d.split("z").length > 300, `${d.split("z").length - 1} dark squares`);
  assert.match(fig.querySelector("svg").getAttribute("viewbox"), /^-2 -2 (\d+) \1$/, "(the node DOM keeps attribute names in lower case; a browser's svg takes viewBox as set)");
  assert.equal(fig.querySelector("svg").getAttribute("role"), "img");
  // the rows
  assert.equal(p.$("#wt-loading").hidden, true); assert.equal(p.$("#wt-empty").hidden, true); assert.equal(p.$("#wt-rows").hidden, false);
  assert.deepEqual(rowsOf(p), [
    { label: "SOL", sub: "Solana", amount: "1.2346", usd: "$185.49" },
    { label: "$VICINITY", sub: "Vicinity", amount: "25,000", usd: "$10.00" },
    { label: "$UTICA", sub: "Utica city coin · ticker on chain", amount: "1,200.5", usd: "$2.40" },
    { label: "Rome Coin", sub: "Rome city coin", amount: "0.5", usd: "$0.50" },
    { label: "$OSWEGO", sub: "Oswego city coin · ticker fixed by the map", amount: "3", usd: "—" },
  ]);
  // the time line: the Worker's read time, and Refresh resting
  assert.equal(p.$("#wt-read").hidden, false);
  assert.match(p.text("#wt-read-text"), /^Balances read from the Solana chain at \d{1,2}:\d{2}( [AP]M)?\.$/);
  assert.equal(p.text("#wt-refresh"), "Refresh");
  assert.equal(p.$("#wt-refresh").disabled, true, "rests 10 s after a read: the Worker's memo would answer the same");
  await p.tap(p.$("#wt-refresh"));
  assert.equal(p.callsTo("/api/swap/balances").length, 1, "a tap while it rests asks nothing");
  // leaving and coming back within 10 s asks nothing either
  await p.tap(p.$("#tab-home")); await p.tap(p.$("#tab-wallet"));
  assert.equal(p.callsTo("/api/swap/balances").length, 1);
  await p.advance(10_000);
  assert.equal(p.$("#wt-refresh").disabled, false);
  await p.tap(p.$("#wt-refresh"));
  assert.equal(p.callsTo("/api/swap/balances").length, 2, "the second read");
  assert.equal(p.callsTo("/api/me/portfolio").length, 2);
  assert.equal(p.$("#wt-refresh").disabled, true);
  await p.tap(p.$("#wt-refresh")); await p.tap(p.$("#wt-refresh"));
  assert.equal(p.callsTo("/api/swap/balances").length, 2, "no hammering");
  // the minute /api/me refresh (dashboard.js) draws the tab again but reads nothing from the chain: the tab entry and Refresh are the reads
  const meCalls = p.callsTo("/api/me").length;
  await p.advance(60_000);
  assert.ok(p.callsTo("/api/me").length > meCalls, "the page refreshed /api/me meanwhile");
  assert.equal(p.callsTo("/api/swap/balances").length, 2, "no read on the minute refresh"); assert.equal(p.callsTo("/api/me/portfolio").length, 2);
  assert.equal(p.$("#wt-refresh").disabled, false, "Refresh is the way to read again");
  // Copy: the clipboard, the button says Copied for two seconds, the live region reads it out; no toast (that would announce it twice)
  await p.tap(p.$("#wt-copy"));
  assert.equal(p.text("#wt-copy"), "Copied"); assert.equal(p.text("#wt-copy-live"), "Address copied");
  assert.deepEqual(p.toasts, [], "no toast: the button and the live region are the one announcement");
  await p.advance(2000);
  assert.equal(p.text("#wt-copy"), "Copy"); assert.equal(p.text("#wt-copy-live"), "");
  // Buy & swap: the existing Buy card on Home (the panel of public/swap.js mounts there), not a copy
  assert.equal(p.$("#wt-buy").getAttribute("data-go"), "#trade");
  await p.tap(p.$("#wt-buy"));
  assert.equal(p.win.VDash.active, "home");
  assert.equal(p.$("#panel-home").hidden, false);
  assert.ok(p.$("#trade").classList.contains("is-target"), "the Buy card is pointed at");
  assert.deepEqual(q.out, [], "nothing logged");
});

test("states: loading while the answers are on their way; Nothing here yet when every amount is 0; could not be read when the balances answer fails (Refresh asks again); no portfolio (PROFILES off, or it failed): the rows the balances answer gives and a line that says the city coins are missing; a stale SOL price is a dash; no read time from the Worker: no time stated", async () => {
  // loading: the balances answer is held back
  let release = null;
  const held = new Promise((r) => { release = r; });
  const p = await openDashboard({ me: linked(), api: server({ balances: () => held }) });
  await p.tap(p.$("#tab-wallet"));
  assert.equal(p.$("#wt-loading").hidden, false); assert.equal(p.text("#wt-loading"), "Reading your balances…");
  assert.equal(p.$("#wt-rows").hidden, true); assert.equal(p.$("#wt-empty").hidden, true); assert.equal(p.$("#wt-read").hidden, true);
  release(BALANCES); await p.flush();
  assert.equal(p.$("#wt-loading").hidden, true); assert.equal(p.$("#wt-rows").hidden, false);
  assert.equal(rowsOf(p).length, 5);
  // empty: a wallet holding nothing the site shows
  const zero = { ...BALANCES, sol: { lamports: 0, ui: 0 }, tokens: { [VIC]: { ui: 0, hasAccount: false } } };
  const e = await openDashboard({ me: linked(), api: server({ balances: zero, portfolio: { ok: true, portfolio: { asOf: BALANCES.at, totalUsd: 0, items: [], pricesComplete: true } } }) });
  await e.tap(e.$("#tab-wallet"));
  assert.equal(e.$("#wt-empty").hidden, false); assert.match(e.text("#wt-empty"), /^Nothing here yet/);
  assert.equal(e.$("#wt-rows").hidden, true); assert.equal(e.$("#wt-loading").hidden, true);
  assert.match(e.text("#wt-read-text"), /^Balances read from the Solana chain at /, "the time line stays: it was read, there is nothing");
  // unavailable: the chain could not be read (503), then it can
  let fail = true;
  const u = await openDashboard({ me: linked(), api: server({ balances: () => (fail ? { ok: false, error: "rpc_unavailable", _status: 503 } : BALANCES) }) });
  await u.tap(u.$("#tab-wallet"));
  assert.equal(u.text("#wt-read-text"), "Balances could not be read right now.");
  assert.equal(u.$("#wt-rows").hidden, true); assert.equal(u.$("#wt-empty").hidden, true); assert.equal(u.$("#wt-loading").hidden, true);
  assert.equal(u.$("#wt-refresh").disabled, true);
  await u.advance(10_000);
  fail = false;
  await u.tap(u.$("#wt-refresh"));
  assert.equal(u.$("#wt-rows").hidden, false); assert.equal(rowsOf(u).length, 5);
  assert.match(u.text("#wt-read-text"), /^Balances read from the Solana chain at /);
  // no portfolio: the route is not enabled (404), the rows are SOL and $VICINITY from the balances answer, dollar values only where known
  const n = await openDashboard({ me: linked(), api: server({ portfolio: { ok: false, error: "not_enabled", _status: 404 }, balances: { ...BALANCES, tokens: { [VIC]: { ui: 25000, hasAccount: true } } } }) });
  await n.tap(n.$("#tab-wallet"));
  assert.deepEqual(rowsOf(n), [{ label: "SOL", sub: "Solana", amount: "1.2346", usd: "$185.49" }, { label: "$VICINITY", sub: "Vicinity", amount: "25,000", usd: "—" }]);
  assert.deepEqual(new URL(n.callsTo("/api/swap/balances")[0].path, "https://vicinity.test").searchParams.get("mints").split(","), [VIC], "only the live mint to ask about");
  assert.match(n.text("#wt-read-text"), /^Balances read from the Solana chain at \d{1,2}:\d{2}( [AP]M)?\. City coins are not shown right now\.$/, "the list is not passed off as complete");
  // the portfolio route answered but could not read the chain ({ ok: true, portfolio: null }, src/portfolio.js handlePortfolio): the city coins
  // the wallet holds are missing from the list, and the line says so (a different sentence: they exist here, they could not be read)
  const c = await openDashboard({ me: linked(), api: server({ portfolio: { ok: true, portfolio: null }, balances: { ...BALANCES, tokens: { [VIC]: { ui: 25000, hasAccount: true } } } }) });
  await c.tap(c.$("#tab-wallet"));
  assert.deepEqual(rowsOf(c).map((r) => [r.label, r.amount, r.usd]), [["SOL", "1.2346", "$185.49"], ["$VICINITY", "25,000", "—"]]);
  assert.match(c.text("#wt-read-text"), /^Balances read from the Solana chain at \d{1,2}:\d{2}( [AP]M)?\. City coins could not be read right now\.$/);
  // the same with nothing in SOL or $VICINITY: not "Nothing here yet" (the city coins are unknown), the rows stand at 0 under that line
  const z = await openDashboard({ me: linked(), api: server({ portfolio: { ok: false, error: "rpc_unavailable", _status: 503 }, balances: zero }) });
  await z.tap(z.$("#tab-wallet"));
  assert.equal(z.$("#wt-empty").hidden, true); assert.equal(z.$("#wt-rows").hidden, false);
  assert.deepEqual(rowsOf(z).map((r) => [r.label, r.amount]), [["SOL", "0"], ["$VICINITY", "0"]]);
  assert.match(z.text("#wt-read-text"), /\. City coins could not be read right now\.$/);
  // no SOL price either: a dash, never a number made up
  const s = await openDashboard({ me: linked(), api: server({ prices: { ok: true, prices: {} } }) });
  await s.tap(s.$("#tab-wallet"));
  assert.equal(rowsOf(s)[0].usd, "—");
  // a stale SOL price (Jupiter failed; /api/prices answers the last good one, up to five minutes old, with stale: true): a dash too, the
  // portfolio's own rule for the coins, so the two columns of one list follow one rule; the portfolio's prices stand
  const st = await openDashboard({ me: linked(), api: server({ prices: { prices: { [SOL_MINT]: 150.25 }, stale: true } }) });
  await st.tap(st.$("#tab-wallet"));
  assert.equal(rowsOf(st)[0].usd, "—"); assert.equal(rowsOf(st)[1].usd, "$10.00");
  assert.match(st.text("#wt-read-text"), /^Balances read from the Solana chain at \d{1,2}:\d{2}( [AP]M)?\.$/, "the city coins were read: nothing missing");
  // a balances answer without `at` (an older Worker): the line states no time rather than this browser's clock
  const { at: _dropped, ...noAt } = BALANCES;
  const o = await openDashboard({ me: linked(), api: server({ balances: noAt }) });
  await o.tap(o.$("#tab-wallet"));
  assert.equal(rowsOf(o).length, 5);
  assert.equal(o.text("#wt-read-text"), "Balances read from the Solana chain.");
});

test("the old sign-up (SIGNUP_FLOW not v2) with no wallet linked: dashboard.js hides the wallet card the tab would show, so the tab is hidden too and the deep link #wallet lands on Home; a linked wallet has the tab; the wallet unlinked while the tab is open sends the person Home", async () => {
  const v1 = (over) => ({ ...memberMe(over), signupFlow: "v1" });
  const p = await openDashboard({ hash: "wallet", me: v1(), api: server() });
  assert.equal(p.$("#tab-wallet").hidden, true); assert.equal(p.$("#panel-wallet").hidden, true);
  assert.equal(p.win.VDash.active, "home"); assert.equal(p.$("#panel-home").hidden, false);
  assert.equal(p.$("#tab-home").getAttribute("aria-selected"), "true");
  assert.equal(p.$("#wallet-card").hidden, true, "the old /connect cannot link a wallet: no card (dashboard.js), so no empty tab");
  assert.equal(p.$("#wt-receive").hidden, true); assert.equal(p.$("#wt-balances").hidden, true);
  assert.equal(p.callsTo("/api/swap/balances").length, 0);
  const visible = [...p.$$("#dash-tablist .dtab")].filter((t) => !t.hidden).map((t) => t.dataset.tab);
  assert.deepEqual(visible, ["home", "city", "community", "rankings", "founder", "profile"]);
  // a wallet linked under the old sign-up: the tab, the address, the rows
  const l = await openDashboard({ me: v1({ wallet: ADDR }), api: server() });
  assert.equal(l.$("#tab-wallet").hidden, false);
  await l.tap(l.$("#tab-wallet"));
  assert.equal(l.win.VDash.active, "wallet"); assert.equal(l.text("#wt-addr"), ADDR); assert.equal(rowsOf(l).length, 5);
  // the wallet goes (a refresh says so) while the tab is open: the tab is hidden and the person is on Home
  let wallet = ADDR;
  const u = await openDashboard({ me: () => v1({ wallet }), api: server() });
  await u.tap(u.$("#tab-wallet"));
  assert.equal(u.win.VDash.active, "wallet");
  wallet = null;
  await u.advance(60_000);
  assert.equal(u.$("#tab-wallet").hidden, true); assert.equal(u.win.VDash.active, "home"); assert.equal(u.$("#panel-home").hidden, false);
  assert.equal(u.$("#panel-wallet").hidden, true);
});

test("the home city's launched coin the wallet holds none of is listed at 0 with /api/me's ticker; a phone's browser: Buy & swap leads to the wallet card, where that phone buys", async () => {
  const coins = { ok: true, vicinity: VIC, pairs: null, coin: { id: 7, city_id: "5142056", name: "Utica Coin", ticker: "UTICA", pair: "SOL", pairMint: SOL_MINT, color: "gold", pitch: "", mint: UTICA, launched: true, launchedAt: "2026-10-08T00:00:00Z", waiting: false, createdBy: 3 } };
  const me = linked(); me.community.tickerSource = "chain";
  const p = await openDashboard({ me, api: server({ coins, portfolio: { ok: true, portfolio: { asOf: BALANCES.at, totalUsd: 10, pricesComplete: true, items: [PORTFOLIO.portfolio.items[0]] } }, balances: { ...BALANCES, tokens: { [VIC]: { ui: 25000, hasAccount: true }, [UTICA]: { ui: 0, hasAccount: false } } } }) });
  await p.tap(p.$("#tab-wallet"));
  assert.deepEqual(new URL(p.callsTo("/api/swap/balances")[0].path, "https://vicinity.test").searchParams.get("mints").split(","), [VIC, UTICA], "the live mint, the home coin");
  assert.deepEqual(rowsOf(p).map((r) => [r.label, r.sub, r.amount]), [["SOL", "Solana", "1.2346"], ["$VICINITY", "Vicinity", "25,000"], ["$UTICA", "Utica city coin · ticker on chain", "0"]]);
  // a phone's Safari with the wallet linked: the Buy card steps back, the wallet card is where that phone buys; the entry leads there
  const f = await openDashboard({ ua: UA.iphone, me: linked(), api: server() });
  await f.tap(f.$("#tab-wallet"));
  assert.equal(f.$("#wt-receive").hidden, false); assert.equal(rowsOf(f).length, 5);
  assert.equal(f.$("#trade").hidden, true); assert.equal(f.$("#wallet-card").hidden, false); assert.equal(f.$("#wallet-card").dataset.place, "buy");
  await f.tap(f.$("#wt-buy"));
  assert.equal(f.win.VDash.active, "home");
  assert.ok(f.$("#wallet-card").classList.contains("is-target"), "the buy card of that phone");
  assert.equal(f.$("#wallet-card").parentNode.id, "panel-home");
});

/* ---------- the Worker: the balances answer says when it was read ---------- */
test("GET /api/swap/balances carries `at`, the time the chain was read (a memo's answer keeps the memo's time); every key it had is still there", async () => {
  _resetSwap(); _resetRelay();
  const TAKER = UTICA; // any wallet
  const W = fakeWorld({ rpc: { mints: { [REAL_VIC]: { decimals: 6 } }, lamports: { [TAKER]: 2_000_000_000 }, holdings: { [REAL_VIC]: { [TAKER]: 1234.5 } } } });
  const env = { ...newWorld(), SWAP: "on", VICINITY_MINT: REAL_VIC, SOLANA_RPC_URL: "https://rpc.test", JUPITER_API_KEY: "secret-key-123", JUPITER_RPS: "10" };
  const call = async () => {
    const res = await handleApi(new Request(`https://vicinity.test/api/swap/balances?owner=${TAKER}&mints=${REAL_VIC}`, { headers: { "cf-connecting-ip": "1.2.3.4", origin: "https://vicinity.test" } }), env, W.fetch);
    return { status: res.status, data: await res.json() };
  };
  const before = Date.now();
  const a = await call();
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.deepEqual(Object.keys(a.data), ["ok", "owner", "cluster", "at", "sol", "tokens"]);
  assert.match(a.data.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Date.parse(a.data.at) >= before - 1000 && Date.parse(a.data.at) <= Date.now() + 1000, a.data.at);
  assert.deepEqual([a.data.sol.ui, a.data.tokens[REAL_VIC].ui], [2, 1234.5]);
  const b = await call();
  assert.equal(b.data.at, a.data.at, "within 10 s the memo answers, with the memo's time: the page says when the chain was really read");
});
