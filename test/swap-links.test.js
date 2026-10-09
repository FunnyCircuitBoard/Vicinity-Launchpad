// public/swap.js: phones buy inside the wallet app. A phone with no wallet in the page gets "Open in Phantom / Solflare / Backpack"
// with this page AND its trade in the address (swap_in / swap_out / swap_amt / swap_slip, swap_open=1 from the bottom sheet), the
// wallet app it opened last first ("vicinity.walletApp"), and for a mainnet coin Phantom's own swap, said to be Phantom's. Opened
// there, the page reads that trade ONCE, checks it against the verified list, fills in the panel that fits (or the sheet), says so,
// never builds or buys it by itself, and takes only the swap_* params out of the address. A computer shows the same address as a QR
// code for the phone's camera (/vendor/qrcode.js loaded only then). The one-tap price itself is in test/swap-ready.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newEvent } from "./helpers/pagedom.js";
import { SOL, USDC, VIC, CITY, CONFIG, QUOTE, TX, walletOf, swapPage, byPath, click, text } from "./helpers/swappage.js";

const LATER = () => new Date(Date.now() + 3_600_000).toISOString();
const BAL = { ok: true, sol: { lamports: 1e9, ui: 1 }, tokens: { [VIC]: { ui: 0, hasAccount: true } } };
const base = (over = {}) => ({ "/api/swap/config": CONFIG, "/api/swap/quote": () => QUOTE({ expiresAt: LATER() }), "/api/swap/balances": BAL, "/api/swap/tx": () => TX({ quote: QUOTE({ expiresAt: LATER() }) }), "/api/swap/status": { ok: true, status: "confirmed" }, ...over });
const type = async (P, value) => { const i = P.$(".swap__amt"); i.value = value; i.dispatchEvent(newEvent("input")); await P.advance(1000); };
const go = (P) => P.$(".swap__go");
const txCalls = (P) => byPath(P.calls, "/api/swap/tx").length;
const LINK = (q) => `https://vicinity.test/token?ref=abc&${q}#buy-slot`;

/* ---------------------------------------------------------------- a link that carries a trade, opened (in the wallet app) */
test("link: swap_in / swap_out / swap_amt / swap_slip fill the page's panel once (never built or bought by itself), say so, and leave the address bar (its other params and hash kept)", async () => {
  const P = await swapPage({ clock: true, answers: base(), href: LINK(`swap_in=SOL&swap_out=${VIC}&swap_amt=0.5&swap_slip=50`) });
  await P.advance(500);
  assert.deepEqual([P.$(".swap__amt").value, P.$(".swap__chip--custom").value, text(P.$(".swap__note")), P.$(".swap__note").hidden], ["0.5", "", "Filled in from your link. Check the amount.", false]);
  assert.deepEqual(P.$$(".swap__chip").filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.dataset.bps), ["50"], "a link may lower the slippage (0.5%)");
  assert.deepEqual(byPath(P.calls, "/api/swap/quote")[0].body, { inputMint: SOL, outputMint: VIC, amount: "0.5", slippageBps: 50 });
  assert.deepEqual(P.calls.filter((c) => c.replace).map((c) => c.replace), ["/token?ref=abc#buy-slot"], "only the swap_* params went");
  assert.equal(P.location.href, "https://vicinity.test/token?ref=abc#buy-slot");
  assert.equal(txCalls(P), 0, "nothing is built without a wallet");
  assert.equal(text(go(P)), "Connect wallet");
  // typing hides the note; a panel mounted later is not filled again (read once)
  P.$(".swap__amt").value = "0.7"; P.$(".swap__amt").dispatchEvent(newEvent("input"));
  assert.equal(P.$(".swap__note").hidden, true);
  const later = P.doc.createElement("div"); P.doc.body.append(later);
  const p2 = await P.VSwap.mount(later, { mode: "swap", in: "SOL", out: USDC }); await P.flush();
  assert.deepEqual([p2.inAmt.value, p2.note.hidden], ["", true]);
  // a sale (the coin in, SOL out): the coin's Buy panel takes it flipped
  const S = await swapPage({ clock: true, answers: base(), href: LINK(`swap_in=${VIC}&swap_out=SOL&swap_amt=1200`) });
  assert.deepEqual([S.$$(".swap__token").map((b) => [text(b).replace(/▾/, "").trim(), b.disabled]), S.$(".swap__amt").value], [[["V$VICINITY", true], ["SSOL", false]], "1200"]);
});

test("link: inside the wallet app the normal flow follows: Connect, the price is built, ONE tap buys; the link itself never builds or buys anything", async () => {
  const w = walletOf({ name: "Phantom" });
  const P = await swapPage({ clock: true, wallets: [w], answers: base(), href: LINK(`swap_in=SOL&swap_out=${VIC}&swap_amt=0.25&swap_slip=100`) });
  await P.advance(5000);
  assert.deepEqual([P.$(".swap__amt").value, text(go(P)), txCalls(P), w.calls.length], ["0.25", "Connect wallet", 0, 0], "filled in, nothing more");
  click(go(P)); await P.flush();
  click(P.$(".swap__wallets .wallet-option")); await P.advance(1000);
  assert.deepEqual([text(P.$(".swap__state")), text(go(P)), txCalls(P)], ["Price ready", "Buy $VICINITY", 1]);
  assert.deepEqual(w.calls, [["connect"]], "connecting is not buying");
  click(go(P));
  assert.equal(w.calls[1][0], "signAndSend", "the person's own tap opens Phantom's confirm sheet");
});

test("link: anything not on the verified list, a bad amount or slippage, or the same token twice is ignored (and still taken out of the address)", async () => {
  const unknown = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const cases = [
    [`swap_in=SOL&swap_out=${unknown}&swap_amt=1`, "", null, "an unknown mint: nothing is filled"],
    [`swap_in=<script>&swap_out=${VIC}&swap_amt=1`, "", null, "not a token at all"],
    [`swap_in=SOL&swap_out=SOL&swap_amt=1`, "", null, "the same token twice"],
    [`swap_in=USDC&swap_out=${VIC}&swap_amt=1e9&swap_slip=0`, "", "USDC", "a bad amount and slippage are dropped, the pair stays"],
    [`swap_in=SOL&swap_out=${VIC}&swap_amt=12345678901234567&swap_slip=5001`, "", "SOL", "17 characters is too long; 5001 bps too much"],
    [`swap_in=SOL&swap_out=${VIC}&swap_amt=x&swap_slip=300`, "", "SOL", "a link never raises the slippage, not even to a chip (3%)"],
    [`swap_in=SOL&swap_out=${VIC}&swap_amt=-1&swap_slip=2.5`, "", "SOL", "no sign, no fraction of a basis point"],
    [`swap_in=SOL&swap_out=${VIC}&swap_amt=0&swap_slip=50`, "", "SOL", "zero is no amount"],
  ];
  for (const [q, amt, pay, why] of cases) {
    const P = await swapPage({ clock: true, answers: base(), href: LINK(q) });
    await P.advance(3000);
    assert.equal(P.$(".swap__amt").value, amt, why);
    assert.equal(P.$(".swap-sheet"), null, `${why}: no sheet`);
    if (pay) assert.equal(text(P.$$(".swap__token")[0]).replace(/▾/, "").slice(1).trim(), pay, why);
    assert.equal(P.$(".swap__note").hidden, pay === null, why);
    const slip = P.$$(".swap__chip").filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.dataset.bps);
    assert.deepEqual(slip, /swap_slip=50$/.test(q) ? ["50"] : ["100"], `${why}: slippage`);
    assert.equal(P.location.href, "https://vicinity.test/token?ref=abc#buy-slot", `${why}: taken out of the address`);
  }
  // 16 characters is still an amount; a token on the verified list (a city coin) is taken
  const P = await swapPage({ clock: true, answers: base(), slot: `<div id="buy-slot" data-swap data-out="${CITY}" data-in="SOL" data-mode="buy"></div>`, href: LINK(`swap_in=SOL&swap_out=${CITY}&swap_amt=0.00000000000001`) });
  await P.advance(500);
  assert.equal(P.$(".swap__amt").value, "0.00000000000001");
});

test("link: no panel on the page that fits (or swap_open=1) opens the bottom sheet with the pair, filled in", async () => {
  // the token page's $VICINITY panel cannot buy DEMOV: after a moment the sheet opens with it
  const P = await swapPage({ clock: true, answers: base(), href: LINK(`swap_in=SOL&swap_out=${CITY}&swap_amt=0.005`) });
  await P.advance(1000);
  assert.equal(P.$(".swap-sheet"), null, "the page's own panels get their chance first");
  await P.advance(2000);
  const sheet = P.$(".swap-sheet");
  assert.ok(sheet && sheet.hasAttribute("open"));
  assert.deepEqual([text(sheet.querySelector(".swap__title")), sheet.querySelector(".swap__amt").value, text(sheet.querySelector(".swap__note"))], ["Buy $DEMOV", "0.005", "Filled in from your link. Check the amount."]);
  assert.equal(P.$("#buy-slot .swap__amt").value, "", "the page's panel is left alone");
  assert.ok(P.$('link[href="/swap.css"]'), "the sheet brings its styles to a page without them");
  // swap_open=1: the trade was in the sheet, it opens there at once (a fitting page panel is not filled)
  const Q = await swapPage({ clock: true, answers: base(), href: LINK(`swap_in=SOL&swap_out=${VIC}&swap_amt=0.1&swap_open=1`), head: '<link rel="stylesheet" href="/swap.css">' });
  await Q.flush();
  const s2 = Q.$(".swap-sheet");
  assert.ok(s2 && s2.hasAttribute("open"));
  assert.deepEqual([s2.querySelector(".swap__amt").value, Q.$("#buy-slot .swap__amt").value], ["0.1", ""]);
  assert.equal(Q.$$('link[href="/swap.css"]').length, 1, "styles already there: not added twice");
  // a page with no panel at all (the Launchpad, the home page) and a plain swap pair
  const R = await swapPage({ clock: true, answers: base(), slot: "", href: `https://vicinity.test/launchpad?swap_in=SOL&swap_out=USDC&swap_amt=2&swap_open=1` });
  await R.flush();
  assert.deepEqual([text(R.$(".swap__title")), R.$(".swap__amt").value, R.location.href], ["Swap", "2", "https://vicinity.test/launchpad"]);
});

test("link: a link can lower the slippage but never raise it: swap_slip=5000 (50%) is not applied, the note says so, and the quote, the build and the one tap all go out at 1%; 3% is still the person's own tap", async () => {
  const w = walletOf({ name: "Phantom" });
  const P = await swapPage({ clock: true, isMobile: true, wallets: [w], answers: base(), href: LINK(`swap_in=SOL&swap_out=${VIC}&swap_amt=1.5&swap_slip=5000`) });
  await P.advance(500);
  assert.deepEqual([P.$(".swap__amt").value, text(P.$(".swap__note")), P.$(".swap__chip--custom").value], ["1.5", "Filled in from your link. Check the amount. Slippage stays 1%: a link cannot raise it.", ""]);
  assert.deepEqual(P.$$(".swap__chip").filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.dataset.bps), ["100"]);
  click(go(P)); await P.flush();
  click(P.$(".swap__wallets .wallet-option")); await P.advance(1000);
  assert.equal(text(go(P)), "Buy $VICINITY");
  click(go(P));
  assert.equal(w.calls[1][0], "signAndSend");
  assert.deepEqual([...new Set(P.calls.filter((c) => c.body && c.body.slippageBps != null).map((c) => c.body.slippageBps))], [100], "50% never reached a quote or a build");
  // the person can still choose more, themselves
  const Q = await swapPage({ clock: true, answers: base(), href: LINK(`swap_in=SOL&swap_out=${VIC}&swap_amt=1&swap_slip=101`) });
  await Q.advance(500);
  assert.match(text(Q.$(".swap__note")), /Slippage stays 1%: a link cannot raise it\.$/, "even 1.01% is more than a link may set");
  click(Q.$$(".swap__chip")[2]); await Q.advance(500);
  assert.equal(byPath(Q.calls, "/api/swap/quote").pop().body.slippageBps, 300, "a tap on 3% is the person's choice");
  assert.equal(Q.$(".swap__note").hidden, true, "the note was about the link's trade: a change of slippage hides it");
});

test("link: the filled panel on the page itself is scrolled into view (it may sit screens below the top); on a computer the keyboard goes to its amount, on a phone it stays shut (it would cover the price)", async () => {
  const P = await swapPage({ clock: true, answers: base(), href: LINK(`swap_in=SOL&swap_out=${VIC}&swap_amt=0.5`) });
  await P.advance(100);
  const scrolled = (P.doc.scrolled || []).filter((x) => x.el === P.slot);
  assert.deepEqual(scrolled.map((x) => JSON.stringify(x.opts)), ['{"block":"start"}']);
  assert.equal(P.doc.activeElement, P.$(".swap__amt"));
  const M = await swapPage({ clock: true, isMobile: true, answers: base(), href: LINK(`swap_in=SOL&swap_out=${VIC}&swap_amt=0.5`) });
  await M.advance(100);
  assert.equal((M.doc.scrolled || []).filter((x) => x.el === M.slot).length, 1, "scrolled on a phone too");
  assert.equal(M.doc.activeElement, M.doc.body, "no keyboard popped over the price");
  // the sheet is its own view: nothing on the page is scrolled for it
  const S = await swapPage({ clock: true, answers: base(), href: LINK(`swap_in=SOL&swap_out=${VIC}&swap_amt=0.1&swap_open=1`), head: '<link rel="stylesheet" href="/swap.css">' });
  await S.advance(100);
  assert.equal((S.doc.scrolled || []).filter((x) => x.el === S.slot).length, 0);
});

test("dashboard: the Buy & swap card's links (and QR code) open the sheet at once (swap_open=1): the wallet app's browser has no session there, so the trade is shown over whatever the dashboard shows, never in a panel screens below or behind a sign-in", async () => {
  const dash = `<div id="tr-swap" data-swap data-out="${VIC}" data-in="SOL" data-mode="buy" data-title="Buy $VICINITY"></div>`;
  const P = await swapPage({ clock: true, isMobile: true, answers: base(), slot: dash, href: "https://vicinity.test/dashboard#home" });
  P.doc.body.dataset.page = "dashboard";
  const panel = [...P.VSwap._panels][0];
  P.$(".swap__amt").value = "0.1"; P.$(".swap__amt").dispatchEvent(newEvent("input")); await P.advance(1000);
  panel.connect(); await P.flush();
  const inner = decodeURIComponent(P.$(".swap__deeplinks a").getAttribute("href").replace("https://phantom.com/ul/browse/", ""));
  assert.equal(inner, `https://vicinity.test/dashboard?swap_in=SOL&swap_out=${VIC}&swap_amt=0.1&swap_slip=100&swap_open=1#home`);
  // opened in the wallet app: the sheet at once, filled; the dashboard's own panel is left alone
  const Q = await swapPage({ clock: true, answers: base(), slot: dash, href: inner, head: '<link rel="stylesheet" href="/swap.css">' });
  await Q.flush();
  const sheet = Q.$(".swap-sheet");
  assert.ok(sheet && sheet.hasAttribute("open"), "the sheet opened without waiting");
  assert.deepEqual([sheet.querySelector(".swap__amt").value, text(sheet.querySelector(".swap__note")), Q.$("#tr-swap .swap__amt").value, Q.location.href], ["0.1", "Filled in from your link. Check the amount.", "", "https://vicinity.test/dashboard#home"]);
  // the token page keeps its own panel (near the top), no sheet
  const T = await swapPage({ clock: true, isMobile: true, answers: base(), href: "https://vicinity.test/token" });
  T.$(".swap__amt").value = "0.1"; T.$(".swap__amt").dispatchEvent(newEvent("input")); await T.advance(1000);
  click(go(T)); await T.flush();
  assert.doesNotMatch(decodeURIComponent(T.$(".swap__deeplinks a").getAttribute("href")), /swap_open/);
});

/* ---------------------------------------------------------------- a phone without a wallet: the wallet apps, with the trade */
test("phone: Connect wallet says buying happens in the wallet app and offers Open in Phantom / Solflare / Backpack carrying the trade (swap_open=1 from the sheet); the links follow the amount", async () => {
  const P = await swapPage({ clock: true, isMobile: true, answers: base(), href: "https://vicinity.test/token?ref=abc#top" });
  await type(P, "0.25");
  click(go(P)); await P.flush();
  assert.equal(text(P.$(".swap__lead")), "Buying happens in your wallet app. Tap yours: Vicinity opens there with this amount filled in.");
  const href = P.$(".swap__deeplinks a").getAttribute("href");
  assert.equal(href, `https://phantom.com/ul/browse/${encodeURIComponent(`https://vicinity.test/token?ref=abc&swap_in=SOL&swap_out=${VIC}&swap_amt=0.25&swap_slip=100#top`)}`);
  assert.equal(txCalls(P), 0, "no wallet here: nothing is built");
  // the amount changes while the box is open: the links follow
  await type(P, "0.4");
  assert.match(decodeURIComponent(P.$(".swap__deeplinks a").getAttribute("href")), /swap_amt=0\.4&/);
  // cleared: the lead line no longer promises an amount
  await type(P, "");
  assert.equal(text(P.$(".swap__lead")), "Buying happens in your wallet app. Tap yours: Vicinity opens there.");
  assert.doesNotMatch(decodeURIComponent(P.$(".swap__deeplinks a").getAttribute("href")), /swap_amt/);
  // in the sheet: swap_open=1
  const sp = await P.VSwap.open({ out: VIC }); await P.flush();
  click(sp.go); await P.flush();
  assert.match(decodeURIComponent(sp.walletBox.querySelector(".swap__deeplinks a").getAttribute("href")), /swap_slip=100&swap_open=1#top$/);
  // flipped to sell: the links carry the sale
  const F = await swapPage({ clock: true, isMobile: true, answers: base() });
  click(F.$(".swap__flip")); await F.flush(); await type(F, "1200");
  click(go(F)); await F.flush();
  assert.match(decodeURIComponent(F.$(".swap__deeplinks a").getAttribute("href")), new RegExp(`swap_in=${VIC}&swap_out=SOL&swap_amt=1200`));
});

test("phone: a token found by search (not on the verified list) is not carried: the other side would drop it, so the links leave the trade out and the lead line promises no amount", async () => {
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const P = await swapPage({ clock: true, isMobile: true, answers: base({ "/api/swap/tokens": { ok: true, tokens: [{ mint: BONK, symbol: "Bonk", name: "Bonk", decimals: 5 }] } }) });
  click(P.$$(".swap__token")[0]); await P.flush();
  const search = P.$(".swap__search"); search.value = "bonk"; search.dispatchEvent(newEvent("input")); await P.advance(400);
  click(P.$$(".swap__picker .swap__opt").find((b) => /Bonk/.test(text(b)))); await P.flush();
  await type(P, "50000");
  click(go(P)); await P.flush();
  assert.equal(text(P.$(".swap__lead")), "Buying happens in your wallet app. Tap yours: Vicinity opens there.");
  const inner = decodeURIComponent(P.$(".swap__deeplinks a").getAttribute("href"));
  assert.doesNotMatch(inner, /swap_in|swap_out|swap_amt|swap_slip/, "nothing the wallet app would silently drop");
  // a verified pair again: carried, promised
  click(P.$$(".swap__token")[0]); await P.flush();
  click(P.$$(".swap__picker .swap__opt").find((b) => /^.SOL/.test(text(b)))); await P.flush();
  await type(P, "0.2");
  assert.equal(text(P.$(".swap__lead")), "Buying happens in your wallet app. Tap yours: Vicinity opens there with this amount filled in.");
  assert.match(decodeURIComponent(P.$(".swap__deeplinks a").getAttribute("href")), new RegExp(`swap_in=SOL&swap_out=${VIC}&swap_amt=0\\.2`));
});

test("chooser: a tap on Connect wallet always shows something: the box (below the footer, maybe below the screen) is scrolled into view and the keyboard / screen reader lands on its first line (a phone's lead, a computer's 'No wallet' line) or its first wallet", async () => {
  for (const [isMobile, wallets, first] of [[true, [], ".swap__lead"], [false, [], ".swap__wallets > p"], [true, "one", ".swap__wallets button.wallet-option"], [false, "one", ".swap__wallets button.wallet-option"]]) {
    const P = await swapPage({ clock: true, isMobile, wallets: wallets === "one" ? [walletOf()] : [], canvas: true, qrcode: () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: () => true }), answers: base() });
    click(go(P)); await P.flush();
    const box = P.$(".swap__wallets");
    assert.deepEqual((P.doc.scrolled || []).filter((x) => x.el === box).map((x) => JSON.stringify(x.opts)), ['{"block":"nearest"}'], `${isMobile ? "phone" : "computer"} ${wallets.length ? "with" : "without"} a wallet: scrolled`);
    assert.equal(P.doc.activeElement, P.$(first), `${isMobile ? "phone" : "computer"}: focus on ${first}`);
  }
  // the sheet puts the keyboard on its amount 50 ms after opening: a tap on Connect wallet before that keeps the box's focus (the
  // amount's focus would scroll the card back up, away from the wallet apps)
  const S = await swapPage({ clock: true, isMobile: true, answers: base(), slot: "" });
  const sp = await S.VSwap.open({ out: VIC });
  click(sp.go); await S.advance(100);
  assert.ok(S.doc.activeElement === sp.walletBox.querySelector(".swap__lead"), "the sheet's late focus did not take the keyboard away from the wallet box");
  const S2 = await swapPage({ clock: true, isMobile: true, answers: base(), slot: "" });
  const sp2 = await S2.VSwap.open({ out: VIC }); await S2.advance(100);
  assert.ok(S2.doc.activeElement === sp2.inAmt, "otherwise the sheet opens with the keyboard on its amount");
});

test("phone: the wallet app this person opened last comes first (vicinity.walletApp); tapping an Open-in link remembers it; storage that is off or full of junk changes nothing", async () => {
  const store = { "vicinity.walletApp": "solflare" };
  const P = await swapPage({ clock: true, isMobile: true, answers: base(), storage: store });
  click(go(P)); await P.flush();
  assert.deepEqual(P.$$(".swap__deeplinks a").map(text), ["SOpen in Solflare↗", "POpen in Phantom↗", "BOpen in Backpack↗"]);
  click(P.$$(".swap__deeplinks a")[2]);
  assert.equal(store["vicinity.walletApp"], "backpack", "remembered for next time");
  // another wallet app that can open pages (Trust Wallet): first, then the usual three
  const T = await swapPage({ clock: true, isMobile: true, answers: base(), storage: { "vicinity.walletApp": "trust" } });
  T.win.VW.KNOWN.push({ id: "trust", name: "Trust Wallet", color: "#0500FF", match: /trust/i, site: "https://trustwallet.com/download", open: (u) => `https://link.trustwallet.com/open_url?coin_id=501&url=${encodeURIComponent(u)}` });
  click(go(T)); await T.flush();
  assert.deepEqual(T.$$(".swap__deeplinks a").map(text), ["TOpen in Trust Wallet↗", "POpen in Phantom↗", "SOpen in Solflare↗", "BOpen in Backpack↗"]);
  assert.match(T.$(".swap__deeplinks a").getAttribute("href"), /^https:\/\/link\.trustwallet\.com\/open_url\?coin_id=501&url=https%3A%2F%2Fvicinity\.test%2Ftoken%3Fswap_in%3DSOL/);
  // an app that cannot open a page (no open link), junk, a blocked storage, no storage at all: the usual order, nothing breaks
  for (const storage of [{ "vicinity.walletApp": "jupiter" }, { "vicinity.walletApp": "<img src=x>" }, "throws", undefined]) {
    const Q = await swapPage({ clock: true, isMobile: true, answers: base(), storage });
    if (storage && storage["vicinity.walletApp"] === "jupiter") Q.win.VW.KNOWN.push({ id: "jupiter", name: "Jupiter", match: /jupiter/i, site: "https://jup.ag/mobile" });
    click(go(Q)); await Q.flush();
    assert.deepEqual(Q.$$(".swap__deeplinks a").map(text), ["POpen in Phantom↗", "SOpen in Solflare↗", "BOpen in Backpack↗"], JSON.stringify(storage));
    click(Q.$(".swap__deeplinks a")); // remembering may fail quietly
  }
});

test("phone: 'See $X in the Phantom app' (Phantom's documented fungible link: its token page, said to be Phantom's) only while buying a coin surely on mainnet: not a sale, not SOL/USDC, never a launchpad coin on devnet whatever its stage; tapping it remembers Phantom", async () => {
  const store = {};
  const P = await swapPage({ clock: true, isMobile: true, answers: base(), storage: store });
  click(go(P)); await P.flush();
  const a = P.$(".swap__phantom a");
  assert.equal(a.getAttribute("href"), `https://phantom.com/ul/v1/fungible?token=solana%3A101%2Faddress%3A${VIC}`);
  assert.equal(text(a), "PSee $VICINITY in the Phantom app↗", "Phantom's docs promise a token page, so the words promise no more");
  assert.equal(text(P.$(".swap__phantom p")), "Phantom's own page: buy it there with Phantom's swap. Vicinity is not involved.");
  const kids = P.$(".swap__wallets").children.map((e) => e.className);
  assert.ok(kids.indexOf("swap__phantom") === kids.indexOf("swap__deeplinks") + 1, "right under the Open-in-wallet links");
  click(a);
  assert.equal(store["vicinity.walletApp"], "phantom");
  click(P.$(".swap__flip")); await P.flush();
  assert.equal(P.$(".swap__phantom"), null, "selling: no link");
  const S = await swapPage({ clock: true, isMobile: true, answers: base(), slot: `<div id="buy-slot" data-swap data-out="${USDC}" data-in="SOL" data-mode="swap"></div>` });
  click(go(S)); await S.flush();
  assert.equal(S.$(".swap__phantom"), null, "buying USDC: no link");
  // a city coin: the link names Solana MAINNET, so a launchpad on devnet never gets it, whatever stage the coin's pool read gave
  // (curve, full, graduated, unknown); on a mainnet launchpad only a coin that trades on Jupiter (or has graduated) does
  const cityPage = async (stage, cluster) => {
    const cfg = { ...CONFIG, launchpad: { enabled: true, cluster }, tokens: CONFIG.tokens.map((t) => (t.mint === CITY ? { ...t, stage } : t)) };
    const D = await swapPage({ clock: true, isMobile: true, answers: base({ "/api/swap/config": cfg }), slot: `<div id="buy-slot" data-swap data-out="${CITY}" data-in="SOL" data-mode="buy"></div>` });
    click(go(D)); await D.flush();
    assert.ok(D.$(".swap__deeplinks"), "the wallet apps are always offered");
    return D.$(".swap__phantom a");
  };
  for (const stage of ["curve", "full", "graduated", "unknown", "jupiter"]) assert.equal(await cityPage(stage, "devnet"), null, `a devnet launchpad, stage ${stage}: no link`);
  for (const stage of ["curve", "full", "unknown"]) assert.equal(await cityPage(stage, "mainnet"), null, `a mainnet launchpad, stage ${stage}: still on its curve or unread: no link`);
  for (const stage of ["jupiter", "graduated"]) assert.equal((await cityPage(stage, "mainnet")).getAttribute("href"), `https://phantom.com/ul/v1/fungible?token=solana%3A101%2Faddress%3A${CITY}`, `a mainnet launchpad, stage ${stage}`);
  // a computer never gets it (it has the QR code)
  const C = await swapPage({ clock: true, answers: base() });
  click(go(C)); await C.flush();
  assert.equal(C.$(".swap__phantom"), null);
});

/* ---------------------------------------------------------------- a computer: the QR code for the phone */
function fakeQR() { const seen = []; const f = (type, level) => { const q = { level, data: "", addData(t) { q.data = t; seen.push(t); }, make() {}, getModuleCount: () => 25, isDark: (r, c) => (r * c) % 3 === 0 }; return q; }; f.seen = seen; return f; }

test("phone QR: a computer with no wallet shows the QR code of this page with the trade in it (drawn with qrcode.js), and redraws it when the amount changes", async () => {
  const qr = fakeQR();
  const P = await swapPage({ clock: true, canvas: true, qrcode: qr, answers: base(), href: "https://vicinity.test/token" });
  await type(P, "0.25");
  click(go(P)); await P.flush();
  assert.match(text(P.$(".swap__wallets")), /^No Solana wallet found in this browser\./);
  assert.equal(text(P.$(".swap__qr p")), "No wallet here? Scan with your phone's camera: Vicinity opens there with this amount filled in.");
  const canvas = P.$(".swap__qr canvas");
  assert.ok(canvas && canvas.drawn.length > 10, "drawn");
  assert.deepEqual([canvas.getAttribute("role"), canvas.drawn[0]], ["img", ["fill", "#fff"]], "dark on white, whatever the theme");
  assert.deepEqual(qr.seen, [`https://vicinity.test/token?swap_in=SOL&swap_out=${VIC}&swap_amt=0.25&swap_slip=100`]);
  assert.equal(P.$('script[src="/vendor/qrcode.js"]'), null, "the library was already there: nothing loaded");
  await type(P, "1.5");
  assert.equal(qr.seen.pop(), `https://vicinity.test/token?swap_in=SOL&swap_out=${VIC}&swap_amt=1.5&swap_slip=100`);
});

test("phone QR: without the library it is loaded once, on demand (a same-origin script); if that fails the address is shown as a link", async () => {
  const P = await swapPage({ clock: true, canvas: true, answers: base() });
  assert.equal(P.$('script[src="/vendor/qrcode.js"]'), null, "not loaded with the page");
  click(go(P)); await P.flush();
  const scripts = P.$$('script[src="/vendor/qrcode.js"]');
  assert.equal(scripts.length, 1, "asked for only now");
  assert.equal(text(P.$(".swap__qr p")), "No wallet here? Scan with your phone's camera: Vicinity opens there.", "no amount yet: no promise of one");
  scripts[0].dispatchEvent(newEvent("error")); await P.flush();
  const a = P.$(".swap__qr .swap__qr-link");
  assert.deepEqual([a.getAttribute("href"), text(a)], [`https://vicinity.test/token?swap_in=SOL&swap_out=${VIC}&swap_slip=100`, `https://vicinity.test/token?swap_in=SOL&swap_out=${VIC}&swap_slip=100`]);
  // it loads fine: drawn
  const Q = await swapPage({ clock: true, canvas: true, answers: base() });
  click(go(Q)); await Q.flush();
  const qr = fakeQR(); Q.win.qrcode = qr;
  Q.$('script[src="/vendor/qrcode.js"]').dispatchEvent(newEvent("load")); await Q.flush();
  assert.ok(Q.$(".swap__qr canvas").drawn.length > 10);
  // nothing answers at all: after 8 s, the link
  const R = await swapPage({ clock: true, canvas: true, answers: base() });
  click(go(R)); await R.flush(); await R.advance(8000);
  assert.ok(R.$(".swap__qr .swap__qr-link"));
});

test("phone QR: a computer WITH a wallet offers 'Use my phone instead' under the list (the same QR code); a phone never does", async () => {
  const qr = fakeQR();
  const P = await swapPage({ clock: true, canvas: true, qrcode: qr, wallets: [walletOf()], answers: base() });
  P.$(".swap__amt").value = "0.25"; P.$(".swap__amt").dispatchEvent(newEvent("input")); await P.advance(1000);
  click(go(P)); await P.flush();
  const b = P.$(".swap__phone");
  assert.equal(text(b), "Use my phone instead");
  assert.equal(P.$(".swap__qr"), null);
  const kids = P.$(".swap__wallets").children.map((e) => e.className);
  assert.ok(kids.indexOf("link-btn swap__phone") > kids.lastIndexOf("wallet-option"), "under the wallet list");
  click(b); await P.flush();
  assert.equal(text(P.$(".swap__qr p")), "Scan with your phone's camera: Vicinity opens there with this amount filled in.");
  assert.ok(P.$(".swap__qr canvas").drawn.length > 0);
  assert.equal(qr.seen[0], `https://vicinity.test/token?swap_in=SOL&swap_out=${VIC}&swap_amt=0.25&swap_slip=100`);
  assert.equal(P.doc.activeElement, P.$(".swap__qr"), "the keyboard moves to the code (the button is gone)");
  const M = await swapPage({ clock: true, isMobile: true, wallets: [walletOf()], answers: base() });
  click(go(M)); await M.flush();
  assert.equal(M.$(".swap__phone"), null);
});
