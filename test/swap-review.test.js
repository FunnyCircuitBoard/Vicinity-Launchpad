// public/swap.js, the two taps of a trade, on a fake clock: "Review" builds the exact transaction and shows it (held 40 s, built
// again by itself at most 3 times while the page is looked at, never while it is hidden; a worse rebuild holds Approve 1.5 s), and
// "Approve in <wallet>" calls the wallet INSIDE the tap, nothing awaited first (a phone's browser opens the wallet app only straight
// from a tap). Also the quick wins around it: links that carry the trade (swap_in / swap_out / swap_amt / swap_slip / swap_open),
// the computer's QR code for the phone, Phantom's own swap on a phone without a wallet, and the words for a phone whose wallet app
// did not answer. The queue-timer tests of the whole panel are in test/swap-ui.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newEvent } from "./helpers/pagedom.js";
import { SOL, USDC, VIC, CITY, TAKER, CONFIG, QUOTE, TX, CURVE_QUOTE, walletOf, swapPage, byPath, click, text } from "./helpers/swappage.js";

const LATER = () => new Date(Date.now() + 3_600_000).toISOString(); // quotes that do not run out during a test (the fake clock moves minutes)
const BAL = { ok: true, sol: { lamports: 1e9, ui: 1 }, tokens: { [VIC]: { ui: 0, hasAccount: true } } };
const base = (over = {}) => ({ "/api/swap/config": CONFIG, "/api/swap/quote": () => QUOTE({ expiresAt: LATER() }), "/api/swap/balances": BAL, "/api/swap/tx": () => TX({ quote: QUOTE({ expiresAt: LATER() }) }), "/api/swap/status": { ok: true, status: "confirmed" }, ...over });
const type = async (P, value) => { const i = P.$(".swap__amt"); i.value = value; i.dispatchEvent(newEvent("input")); await P.advance(500); };
const go = (P) => P.$(".swap__go");
const txCalls = (P) => byPath(P.calls, "/api/swap/tx").length;
/** A /tx answer that waits for release(): the time a build takes, made visible. */
function gated(make) { const g = { open: false, n: 0, release: null }; g.answer = (body) => { g.n++; const d = make(g.n, body); if (!g.open) return d; return new Promise((r) => { g.release = () => r(d); }); }; return g; }
/** The token page's Buy panel, a wallet connected, 0.25 SOL quoted. */
async function ready({ wallet = walletOf(), answers = {}, ...rest } = {}) {
  const P = await swapPage({ clock: true, wallets: [wallet], answers: base(answers), ...rest });
  click(go(P)); await P.flush();
  click(P.$(".swap__wallets .wallet-option")); await P.flush();
  await type(P, "0.25");
  assert.match(text(go(P)), /^Review (buy|sale|swap)$/, "quoted, ready for Review");
  return P;
}

test("review: Review builds through /api/swap/tx with the usual body and shows the BUILD's numbers, what will be signed, the hold and Change; the wallet is not asked", async () => {
  const w = walletOf();
  const P = await ready({ wallet: w, answers: { "/api/swap/tx": () => TX({ quote: QUOTE({ outAmount: "89600000000", outUi: "89600", minOut: "88704000000", minOutUi: "88704", expiresAt: LATER() }) }) } });
  assert.deepEqual([text(go(P)), go(P).disabled, P.$(".swap__review").hidden], ["Review buy", false, true]);
  click(go(P));
  assert.deepEqual([text(P.$(".swap__state")), text(go(P)), go(P).disabled], ["Preparing…", "Preparing…", true], "Preparing at once");
  await P.flush();
  assert.deepEqual(byPath(P.calls, "/api/swap/tx")[0].body, { inputMint: SOL, outputMint: VIC, amount: "0.25", slippageBps: 100, taker: TAKER, quoteId: "q1" });
  assert.deepEqual(w.calls, [["connect"]], "Review never opens the wallet");
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__amt--out")), P.$$(".swap__details dd").map(text)[0]], ["Ready to approve", "89,600", "88,704 $VICINITY"], "the build's own numbers");
  assert.equal(text(P.$(".swap__status")), "You pay 0.25 SOL → you get 89,600 $VICINITY (at least 88,704). Check it, then approve in your wallet.");
  assert.equal(P.$(".swap__status").getAttribute("aria-live"), "polite", "the status line says it once");
  assert.deepEqual([text(go(P)), go(P).disabled], ["Approve in Test Wallet", false]);
  assert.deepEqual([P.$(".swap__review").hidden, text(P.$(".swap__held")), P.$(".swap__held").getAttribute("aria-live"), text(P.$(".swap__change"))], [false, "Price held 0:40", "off", "Change"], "the countdown is shown, never announced");
  await P.advance(2000);
  assert.equal(text(P.$(".swap__held")), "Price held 0:38");
  const quotes = byPath(P.calls, "/api/swap/quote").length;
  await P.advance(30_000);
  assert.equal(byPath(P.calls, "/api/swap/quote").length, quotes, "the 12-second quote refresh does not run while reviewing");
  assert.equal(text(P.$(".swap__held")), "Price held 0:08");
  assert.equal(txCalls(P), 1);
});

test("review: Approve calls signAndSendTransaction synchronously inside the tap (before any promise or timer), with the reviewed bytes and chain; then sending, confirming, done", async () => {
  const w = walletOf();
  const P = await ready({ wallet: w });
  click(go(P)); await P.flush();
  click(go(P));
  // nothing has been awaited since the click: the wallet already has the request
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls)), [["connect"], ["signAndSend", 300, "solana:mainnet", { preflightCommitment: "confirmed", maxRetries: 3 }]]);
  assert.deepEqual([text(P.$(".swap__state")), text(go(P)), P.$(".swap__review").hidden], ["Confirm in wallet", "Confirm in your wallet…", true]);
  click(go(P)); // a second tap while the wallet is open is ignored
  assert.equal(w.calls.length, 2);
  await P.flush(); await P.advance(1500);
  assert.equal(text(P.$(".swap__state")), "Swapped ✓");
  assert.equal(text(P.$(".swap__status")), "Swapped ✓ 0.25 SOL → 89,166.22 $VICINITY");
  assert.equal(txCalls(P), 1, "one build, one approval");
  // Enter in the amount field is the button: Review, then Approve (the keydown is a tap too)
  const K = await ready({ wallet: walletOf({ name: "Phantom" }) });
  const enter = () => K.$(".swap__amt").dispatchEvent(newEvent("keydown", { key: "Enter" }));
  enter(); await K.flush();
  assert.equal(text(go(K)), "Approve in Phantom");
  const kw = K.VSwap.wallet.adapter;
  enter();
  assert.equal(kw.calls[kw.calls.length - 1][0], "signAndSend");
  // a long or made-up wallet name: "your wallet"
  const G = await ready({ wallet: walletOf({ name: "Mobile Wallet Adapter" }) });
  click(go(G)); await G.flush();
  assert.equal(text(go(G)), "Approve in your wallet");
});

test("review: a wallet that only signs: Approve calls signTransaction synchronously and the relay gets the ticket of the build on the screen (a rebuild's new ticket after a rebuild)", async () => {
  const w = walletOf({ kind: "sign" });
  let n = 0;
  const P = await ready({ wallet: w, answers: { "/api/swap/tx": () => TX({ ticket: `ticket-${++n}`, lastValidBlockHeight: 4320 + n, quote: QUOTE({ expiresAt: LATER() }) }), "/api/swap/send": { ok: true, signature: "5ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk" } } });
  click(go(P)); await P.flush();
  await P.advance(40_000); // the hold ran out: built again (ticket-2)
  assert.equal(n, 2);
  click(go(P));
  assert.deepEqual(w.calls[w.calls.length - 1], ["sign", 300, "solana:mainnet"], "signTransaction inside the tap");
  await P.flush();
  const send = byPath(P.calls, "/api/swap/send")[0];
  assert.deepEqual([send.body.ticket, send.body.lastValidBlockHeight, send.body.cluster], ["ticket-2", 4322, "mainnet"]);
  await P.advance(1500);
  assert.equal(text(P.$(".swap__state")), "Swapped ✓");
});

test("review: at 0 the build is made again quietly (Approve off meanwhile), at most 3 times; then back to the quote with 'The review timed out'", async () => {
  const w = walletOf();
  const g = gated(() => TX({ quote: QUOTE({ expiresAt: LATER() }) }));
  const P = await ready({ wallet: w, answers: { "/api/swap/tx": (b) => g.answer(b) } });
  click(go(P)); await P.flush();
  assert.equal(g.n, 1);
  await P.advance(39_000);
  assert.deepEqual([g.n, text(P.$(".swap__held"))], [1, "Price held 0:01"]);
  g.open = true; // the next build takes its time
  await P.advance(1000);
  assert.equal(g.n, 2, "rebuilt at 0");
  assert.deepEqual([text(P.$(".swap__status")), text(P.$(".swap__state")), text(go(P)), go(P).disabled], ["Refreshing the price…", "Refreshing…", "Approve in Test Wallet", true]);
  click(go(P));
  assert.equal(w.calls.length, 1, "no wallet while the price is being refreshed");
  g.open = false; g.release(); await P.flush();
  assert.deepEqual([text(P.$(".swap__state")), go(P).disabled, text(P.$(".swap__held"))], ["Ready to approve", false, "Price held 0:40"]);
  assert.match(text(P.$(".swap__status")), /^You pay 0\.25 SOL → you get 89,166\.22 \$VICINITY/);
  await P.advance(40_000); assert.equal(g.n, 3);
  await P.advance(40_000); assert.equal(g.n, 4);
  await P.advance(40_000);
  assert.equal(g.n, 4, "three quiet rebuilds, no fourth");
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__status")), text(go(P)), P.$(".swap__review").hidden], ["Live", "The review timed out. Nothing was sent. Tap Review again.", "Review buy", true]);
  await P.advance(300_000);
  assert.equal(g.n, 4, "nothing more is built for an absent person");
  assert.equal(text(P.$(".swap__status")), "The review timed out. Nothing was sent. Tap Review again.");
  // Review again starts a new review (three quiet rebuilds again)
  click(go(P)); await P.flush();
  assert.deepEqual([g.n, text(P.$(".swap__state"))], [5, "Ready to approve"]);
});

test("review: a hidden page is never rebuilt; back on screen with the hold run out it is rebuilt at once (one of the 3); an Approve on a build that ran out never reaches the wallet", async () => {
  const w = walletOf();
  let n = 0;
  const P = await ready({ wallet: w, answers: { "/api/swap/tx": () => { n++; return TX({ ticket: `t${n}`, quote: QUOTE({ expiresAt: LATER() }) }); } } });
  click(go(P)); await P.flush();
  P.setHidden(true);
  await P.advance(120_000);
  assert.deepEqual([n, text(P.$(".swap__state")), text(P.$(".swap__held"))], [1, "Ready to approve", "Price held 0:00"], "nothing rebuilt while nobody looks");
  P.setHidden(false); await P.flush();
  assert.deepEqual([n, text(P.$(".swap__held"))], [2, "Price held 0:40"], "rebuilt the moment the page is back");
  await P.advance(40_000); await P.advance(40_000);
  assert.equal(n, 4);
  await P.advance(40_000);
  assert.equal(n, 4, "the visible rebuild counted: 3 in all");
  assert.equal(text(P.$(".swap__status")), "The review timed out. Nothing was sent. Tap Review again.");
  // a tap on a build that ran out (a phone that slept: the timer had not fired yet) rebuilds and says so; the wallet stays shut
  const Q = await ready({ wallet: walletOf() });
  click(go(Q)); await Q.flush();
  Q.setHidden(true); await Q.advance(45_000);
  const qw = Q.VSwap.wallet.adapter;
  click(go(Q));
  assert.equal(qw.calls.length, 1, "no wallet for a build that ran out");
  await Q.flush();
  assert.deepEqual([text(Q.$(".swap__status")), text(Q.$(".swap__held")), byPath(Q.calls, "/api/swap/tx").length], ["Price refreshed. Tap Approve again.", "Price held 0:40", 2]);
  click(go(Q));
  assert.equal(qw.calls[1][0], "signAndSend", "the fresh build goes to the wallet");
});

test("review: a rebuild that came out worse says 'The price changed …' and keeps Approve off for 1.5 s (a tap then does nothing); a better one just updates", async () => {
  const w = walletOf();
  const builds = [TX({ quote: QUOTE({ expiresAt: LATER() }) }), TX({ quote: QUOTE({ outAmount: "88000000000", outUi: "88000", minOut: "87120000000", minOutUi: "87120", expiresAt: LATER() }) }), TX({ quote: QUOTE({ outAmount: "90000000000", outUi: "90000", minOut: "89100000000", minOutUi: "89100", expiresAt: LATER() }) })];
  const P = await ready({ wallet: w, answers: { "/api/swap/tx": () => builds.shift() } });
  click(go(P)); await P.flush();
  await P.advance(40_000);
  assert.equal(text(P.$(".swap__status")), "The price changed: you would now get 88,000 $VICINITY (at least 87,120). Nothing was sent.");
  assert.ok(P.$(".swap__status").classList.contains("is-moved"));
  assert.deepEqual([text(P.$(".swap__amt--out")), go(P).disabled, text(go(P))], ["88,000", true, "Approve in Test Wallet"]);
  click(go(P));
  assert.equal(w.calls.length, 1, "no approval of numbers nobody had time to see");
  await P.advance(1400);
  assert.equal(go(P).disabled, true);
  await P.advance(100);
  assert.equal(go(P).disabled, false, "1.5 s later Approve is back");
  assert.equal(text(P.$(".swap__status")), "The price changed: you would now get 88,000 $VICINITY (at least 87,120). Nothing was sent.", "the line stays until the next change");
  await P.advance(38_500); // the next rebuild is better: no pause, the usual line
  assert.deepEqual([text(P.$(".swap__status")), go(P).disabled, P.$(".swap__status").classList.contains("is-moved")], ["You pay 0.25 SOL → you get 90,000 $VICINITY (at least 89,100). Check it, then approve in your wallet.", false, false]);
  click(go(P));
  assert.equal(w.calls[1][0], "signAndSend");
});

test("review: Change, Escape, a new amount, slippage, the pair, the flip and another wallet all drop the build (a build still on its way is ignored); the wallet is never asked", async () => {
  const w = walletOf();
  const g = gated(() => TX({ quote: QUOTE({ expiresAt: LATER() }) }));
  const P = await ready({ wallet: w, answers: { "/api/swap/tx": (b) => g.answer(b) } });
  const inReview = async () => { click(go(P)); await P.flush(); assert.equal(text(P.$(".swap__state")), "Ready to approve"); };
  await inReview();
  P.$(".swap__change").focus(); click(P.$(".swap__change"));
  assert.deepEqual([text(P.$(".swap__state")), text(go(P)), P.$(".swap__review").hidden, P.doc.activeElement === go(P)], ["Live", "Review buy", true, true], "Change: back to the quote, the keyboard on Review (Change is gone)");
  assert.ok(!P.pending().includes(40_000), "the hold's clock is gone");
  await P.advance(120_000);
  assert.equal(g.n, 1, "a dropped build is not rebuilt");
  await inReview();
  P.$(".swap__amt").dispatchEvent(newEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(text(P.$(".swap__state")), "Live", "Escape = Change");
  await inReview();
  await type(P, "0.3");
  assert.deepEqual([text(P.$(".swap__state")), text(go(P)), P.$(".swap__review").hidden], ["Live", "Review buy", true], "a new amount: a new quote, no build");
  await inReview();
  click(P.$$(".swap__chip")[2]); await P.advance(200);
  assert.deepEqual([text(P.$(".swap__state")), byPath(P.calls, "/api/swap/quote").pop().body.slippageBps], ["Live", 300], "slippage: quoted again");
  await inReview();
  click(P.$(".swap__flip")); await P.flush();
  assert.deepEqual([text(P.$(".swap__state")), P.$(".swap__amt").value], ["Ready", ""], "the flip starts over");
  await type(P, "0.25");
  // a build on its way when the slippage changes: its answer is ignored
  g.open = true;
  click(go(P)); await P.flush();
  assert.equal(text(P.$(".swap__state")), "Preparing…");
  click(P.$$(".swap__chip")[0]); await P.advance(200);
  g.release(); await P.flush();
  assert.deepEqual([text(P.$(".swap__state")), text(go(P))], ["Live", "Review sale"], "the late build is not shown");
  g.open = false;
  // another wallet connected (from another panel on the page): the build was not for it
  await inReview();
  const w2 = walletOf({ address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", name: "Other" });
  const other = P.doc.createElement("div"); P.doc.body.append(other);
  const second = await P.VSwap.mount(other, { mode: "swap", in: "SOL", out: USDC }); await P.flush();
  P.win.VW.list = () => [w2];
  second.connect(); click(other.querySelector(".swap__wallets .wallet-option")); await P.flush();
  assert.equal(P.VSwap.wallet.address, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  await P.advance(500);
  assert.equal(P.slot.querySelector(".swap__state").textContent, "Live", "the first panel dropped its build and quoted for the new wallet");
  assert.deepEqual(w.calls, [["connect"]], "the first wallet was never asked to sign");
});

test("review: the keyboard comes back to Approve after the build (the button was disabled meanwhile); in the sheet, Escape while reviewing is Change and the sheet stays open", async () => {
  const P = await ready();
  go(P).focus();
  click(go(P));
  assert.notEqual(P.doc.activeElement, go(P), "disabled while building: the keyboard falls back to the page");
  await P.flush();
  assert.deepEqual([P.doc.activeElement === go(P), text(go(P))], [true, "Approve in Test Wallet"]);
  // the sheet (a <dialog>): its own Escape is a "cancel" event, refused while a trade is under review
  const sp = await P.VSwap.open({ out: VIC }); await P.flush();
  sp.inAmt.value = "0.25"; sp.inAmt.dispatchEvent(newEvent("input")); await P.advance(500);
  click(sp.go); await P.flush();
  assert.equal(text(sp.state), "Ready to approve");
  const sheet = P.$(".swap-sheet");
  const cancel = newEvent("cancel", { bubbles: false });
  sheet.dispatchEvent(cancel);
  assert.deepEqual([cancel.defaultPrevented, text(sp.go), sheet.hasAttribute("open")], [true, "Review buy", true], "Change, not close");
  const again = newEvent("cancel", { bubbles: false });
  sheet.dispatchEvent(again);
  assert.equal(again.defaultPrevented, false, "not reviewing: Escape closes the sheet as before");
});

test("review: destroy() clears the hold, the countdown and Approve's pause; nothing is built or signed after", async () => {
  const builds = [TX({ quote: QUOTE({ expiresAt: LATER() }) }), TX({ quote: QUOTE({ outAmount: "80000000000", outUi: "80000", minOut: "79200000000", minOutUi: "79200", expiresAt: LATER() }) })];
  const w = walletOf();
  const P = await ready({ wallet: w, answers: { "/api/swap/tx": () => builds.shift() || TX() } });
  click(go(P)); await P.flush();
  await P.advance(40_000); // a worse rebuild: Approve paused
  const panel = [...P.VSwap._panels][0];
  assert.ok(panel.s.holding && P.pending().length >= 3, `the hold, the countdown and the pause are pending (${P.pending()})`);
  panel.destroy();
  assert.deepEqual(P.pending(), [], "no timer left behind");
  await P.advance(300_000);
  assert.deepEqual([byPath(P.calls, "/api/swap/tx").length, w.calls.length], [2, 1]);
});

test("review: the labels: Review buy, Review sale (a flipped Buy panel, a curve sale), Review swap; a curve coin is built by the launchpad route as before", async () => {
  const w = walletOf({ chains: ["solana:mainnet", "solana:devnet"] });
  const P = await ready({ wallet: w });
  assert.equal(text(go(P)), "Review buy");
  click(P.$(".swap__flip")); await P.flush(); await type(P, "100");
  assert.equal(text(go(P)), "Review sale");
  const S = await ready({ wallet: walletOf(), slot: `<div id="buy-slot" data-swap data-in="SOL" data-out="${USDC}" data-mode="swap"></div>` });
  assert.equal(text(go(S)), "Review swap");
  // a city coin on its curve: quoted and built by the launchpad routes, on devnet; sold: "Review sale"
  const sellQuote = CURVE_QUOTE({ side: "sell", inputMint: CITY, outputMint: SOL, inUi: "1000", outUi: "0.0004", minOutUi: "0.000396", outAmount: "400000", minOut: "396000", decimals: { in: 6, out: 9 } });
  const C = await ready({ wallet: w, slot: `<div id="buy-slot" data-swap data-out="${CITY}" data-in="SOL" data-mode="buy"></div>`, answers: {
    "/api/swap/quote": (b) => ({ ok: true, source: "curve", mint: CITY, side: b.inputMint === CITY ? "sell" : "buy", chain: "solana:devnet", cluster: "devnet", quoteMint: SOL }),
    "/api/launchpad/trade/quote": (b) => (b.side === "sell" ? sellQuote : CURVE_QUOTE()),
    "/api/launchpad/trade/tx": (b) => TX({ chain: "solana:devnet", cluster: "devnet", quote: b.side === "sell" ? sellQuote : CURVE_QUOTE(), quoteId: "c1" }),
  } });
  click(go(C)); await C.flush();
  assert.deepEqual(byPath(C.calls, "/api/launchpad/trade/tx")[0].body, { mint: CITY, side: "buy", amount: "0.25", slippageBps: 100, taker: TAKER, quoteId: "c1" });
  assert.equal(txCalls(C), 0, "never the Jupiter route for a curve coin");
  click(go(C));
  assert.deepEqual(w.calls[w.calls.length - 1].slice(0, 3), ["signAndSend", 300, "solana:devnet"]);
  await C.flush(); await C.advance(1500);
  click(go(C)); await C.flush(); // Swap again
  click(C.$(".swap__flip")); await C.flush(); await type(C, "1000");
  assert.deepEqual([text(go(C)), text(C.$(".swap__label"))], ["Review sale", "You sell"]);
});

/* ---------------------------------------------------------------- links that carry the trade */
const LINK = (q) => `https://vicinity.test/token?ref=abc&${q}#buy-slot`;

test("link: swap_in / swap_out / swap_amt / swap_slip fill the page's panel once (never reviewed), say so, and leave the address bar (its other params and hash kept)", async () => {
  const P = await swapPage({ clock: true, answers: base(), href: LINK(`swap_in=SOL&swap_out=${VIC}&swap_amt=0.5&swap_slip=250`) });
  await P.advance(500);
  assert.deepEqual([P.$(".swap__amt").value, P.$(".swap__chip--custom").value, text(P.$(".swap__note")), P.$(".swap__note").hidden], ["0.5", "2.5", "Filled in from your link. Check the amount.", false]);
  assert.deepEqual(byPath(P.calls, "/api/swap/quote")[0].body, { inputMint: SOL, outputMint: VIC, amount: "0.5", slippageBps: 250 });
  assert.deepEqual(P.calls.filter((c) => c.replace).map((c) => c.replace), ["/token?ref=abc#buy-slot"], "only the swap_* params went");
  assert.equal(P.location.href, "https://vicinity.test/token?ref=abc#buy-slot");
  assert.equal(txCalls(P), 0, "nothing is built: a link never reviews or approves");
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

test("link: anything not on the verified list, a bad amount or slippage, or the same token twice is ignored (and still taken out of the address)", async () => {
  const unknown = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const cases = [
    [`swap_in=SOL&swap_out=${unknown}&swap_amt=1`, "", null, "an unknown mint: nothing is filled"],
    [`swap_in=<script>&swap_out=${VIC}&swap_amt=1`, "", null, "not a token at all"],
    [`swap_in=SOL&swap_out=SOL&swap_amt=1`, "", null, "the same token twice"],
    [`swap_in=USDC&swap_out=${VIC}&swap_amt=1e9&swap_slip=0`, "", "USDC", "a bad amount and slippage are dropped, the pair stays"],
    [`swap_in=SOL&swap_out=${VIC}&swap_amt=12345678901234567&swap_slip=5001`, "", "SOL", "17 characters is too long; 5001 bps too much"],
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
  // a page with no panel at all (the Launchpad, a coin page) and a plain swap pair
  const R = await swapPage({ clock: true, answers: base(), slot: "", href: `https://vicinity.test/launchpad?swap_in=SOL&swap_out=USDC&swap_amt=2&swap_open=1` });
  await R.flush();
  assert.deepEqual([text(R.$(".swap__title")), R.$(".swap__amt").value, R.location.href], ["Swap", "2", "https://vicinity.test/launchpad"]);
});

test("link: the panel's own links carry its trade: Open in Phantom on a phone (swap_open=1 from the sheet), with the amount once there is one", async () => {
  const P = await swapPage({ clock: true, isMobile: true, answers: base(), href: "https://vicinity.test/token?ref=abc#top" });
  await type(P, "0.25");
  click(go(P)); await P.flush();
  const href = P.$(".swap__deeplinks a").getAttribute("href");
  assert.equal(href, `https://phantom.com/ul/browse/${encodeURIComponent(`https://vicinity.test/token?ref=abc&swap_in=SOL&swap_out=${VIC}&swap_amt=0.25&swap_slip=100#top`)}`);
  // the amount changes while the box is open: the links follow
  await type(P, "0.4");
  assert.match(decodeURIComponent(P.$(".swap__deeplinks a").getAttribute("href")), /swap_amt=0\.4&/);
  // in the sheet: swap_open=1
  const sp = await P.VSwap.open({ out: VIC }); await P.flush();
  click(sp.go); await P.flush();
  assert.match(decodeURIComponent(sp.walletBox.querySelector(".swap__deeplinks a").getAttribute("href")), /swap_slip=100&swap_open=1#top$/);
});

/* ---------------------------------------------------------------- a computer: the QR code for the phone */
function fakeQR() { const seen = []; const f = (type, level) => { const q = { level, data: "", addData(t) { q.data = t; seen.push(t); }, make() {}, getModuleCount: () => 25, isDark: (r, c) => (r * c) % 3 === 0 }; return q; }; f.seen = seen; return f; }

test("phone QR: a computer with no wallet shows the QR code of this page with the trade in it (drawn with qrcode.js), and redraws it when the amount changes", async () => {
  const qr = fakeQR();
  const P = await swapPage({ clock: true, canvas: true, qrcode: qr, answers: base(), href: "https://vicinity.test/token" });
  await type(P, "0.25");
  click(go(P)); await P.flush();
  assert.match(text(P.$(".swap__wallets")), /^No Solana wallet found in this browser\./);
  assert.equal(text(P.$(".swap__qr p")), "No wallet here? Scan with your phone's camera to finish there, with this amount filled in.");
  const canvas = P.$(".swap__qr canvas");
  assert.ok(canvas && canvas.drawn.length > 10, "drawn");
  assert.equal(canvas.getAttribute("role"), "img");
  assert.deepEqual(qr.seen, [`https://vicinity.test/token?swap_in=SOL&swap_out=${VIC}&swap_amt=0.25&swap_slip=100`]);
  assert.equal(P.$('script[src="/vendor/qrcode.js"]'), null, "the library was already there: nothing loaded");
  await type(P, "1.5");
  assert.equal(qr.seen.pop(), `https://vicinity.test/token?swap_in=SOL&swap_out=${VIC}&swap_amt=1.5&swap_slip=100`);
});

test("phone QR: without the library it is loaded once, on demand (a same-origin script); if that fails the address is shown as a link", async () => {
  const P = await swapPage({ clock: true, canvas: true, answers: base() });
  click(go(P)); await P.flush();
  const scripts = P.$$('script[src="/vendor/qrcode.js"]');
  assert.equal(scripts.length, 1, "asked for only now");
  assert.equal(text(P.$(".swap__qr p")), "No wallet here? Scan with your phone's camera to finish there.", "no amount yet: no promise of one");
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
  await type(P, "0.25");
  click(go(P)); await P.flush();
  const b = P.$(".swap__phone");
  assert.equal(text(b), "Use my phone instead");
  assert.equal(P.$(".swap__qr"), null);
  click(b); await P.flush();
  assert.equal(text(P.$(".swap__qr p")), "Scan with your phone's camera to finish there, with this amount filled in.");
  assert.ok(P.$(".swap__qr canvas").drawn.length > 0);
  assert.equal(qr.seen[0], `https://vicinity.test/token?swap_in=SOL&swap_out=${VIC}&swap_amt=0.25&swap_slip=100`);
  const M = await swapPage({ clock: true, isMobile: true, wallets: [walletOf()], answers: base() });
  click(go(M)); await M.flush();
  assert.equal(M.$(".swap__phone"), null);
});

/* ---------------------------------------------------------------- a phone: Phantom's own swap, and wallet apps that did not answer */
test("phone: 'Buy $X inside the Phantom app' (Phantom's fungible link) only while buying a mainnet coin: not a sale, not a devnet test coin, not SOL/USDC", async () => {
  const P = await swapPage({ clock: true, isMobile: true, answers: base() });
  click(go(P)); await P.flush();
  const a = P.$(".swap__phantom a");
  assert.equal(a.getAttribute("href"), `https://phantom.com/ul/v1/fungible?token=solana%3A101%2Faddress%3A${VIC}`);
  assert.equal(text(a), "PBuy $VICINITY inside the Phantom app↗");
  assert.equal(text(P.$(".swap__phantom p")), "Phantom's own swap. Vicinity is not involved.");
  const kids = P.$(".swap__wallets").children.map((e) => e.className);
  assert.ok(kids.indexOf("swap__phantom") === kids.indexOf("swap__deeplinks") + 1, "right under the Open-in-wallet links");
  click(P.$(".swap__flip")); await P.flush();
  assert.equal(P.$(".swap__phantom"), null, "selling: no link");
  const D = await swapPage({ clock: true, isMobile: true, answers: base(), slot: `<div id="buy-slot" data-swap data-out="${CITY}" data-in="SOL" data-mode="buy"></div>` });
  click(go(D)); await D.flush();
  assert.ok(D.$(".swap__deeplinks") && D.$(".swap__phantom") === null, "a devnet test coin: no link");
  const S = await swapPage({ clock: true, isMobile: true, answers: base(), slot: `<div id="buy-slot" data-swap data-out="${USDC}" data-in="SOL" data-mode="swap"></div>` });
  click(go(S)); await S.flush();
  assert.equal(S.$(".swap__phantom"), null, "buying USDC: no link");
});

test("phone: a wallet app that did not answer (wallet_not_found) or that Chrome blocked (local_network_blocked) gets plain words and the Open-in links with the trade", async () => {
  for (const [code, words] of [["wallet_not_found", "No wallet app answered on this phone. Open this page in your wallet app instead:"], ["local_network_blocked", "Chrome blocked the link to your wallet app. Allow it in Chrome's site settings, or open this page in your wallet app:"]]) {
    const w = walletOf({ name: "Mobile Wallet Adapter", connectError: { code } });
    const P = await swapPage({ clock: true, isMobile: true, wallets: [w], answers: base() });
    await type(P, "0.25");
    click(go(P)); await P.flush();
    click(P.$(".swap__wallets .wallet-option")); await P.flush();
    const why = P.$(".swap__wallets .swap__why");
    assert.deepEqual([text(why), why.getAttribute("role")], [words, "alert"], code);
    const links = P.$$(".swap__wallets .swap__deeplinks a");
    assert.deepEqual(links.map(text), ["POpen in Phantom↗", "SOpen in Solflare↗", "BOpen in Backpack↗"], code);
    assert.match(decodeURIComponent(links[1].getAttribute("href")), new RegExp(`^https://solflare\\.com/ul/v1/browse/https://vicinity\\.test/token\\?swap_in=SOL&swap_out=${VIC}&swap_amt=0\\.25&swap_slip=100$`));
    assert.equal(P.$(".swap__wallets").hidden, false);
    assert.equal(P.VSwap.words({ error: code }), words);
    assert.equal(P.VSwap.wallet.address, null, "not connected");
  }
});
