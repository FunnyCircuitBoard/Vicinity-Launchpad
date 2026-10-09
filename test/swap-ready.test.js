// public/swap.js on a fake clock: the exact price is built BEFORE the tap and one tap buys. With a wallet connected, a quote that
// settled (the amount unchanged 600 ms) is built in the background ("Getting your exact price…", the button "Preparing…" and off),
// then the panel shows the BUILD's numbers and "Buy $X"; the tap calls the wallet inside the click, nothing awaited first (a
// phone's browser opens the wallet app only straight from a tap). A build lives 40 s, is built again quietly at most 3 times while
// the page is looked at and nobody touches the panel (then "Refresh price"), never while it is hidden; a worse rebuild says so and
// holds the button 1.5 s; any change drops it; a 429 or the page's own budget stops the automatic builds ("Tap Buy to get your
// price"). The queue-timer tests of the whole panel are in test/swap-ui.test.js, the links in test/swap-links.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newEvent } from "./helpers/pagedom.js";
import { SOL, USDC, VIC, CITY, TAKER, CONFIG, QUOTE, TX, CURVE_QUOTE, walletOf, swapPage, byPath, click, text } from "./helpers/swappage.js";

const LATER = () => new Date(Date.now() + 3_600_000).toISOString(); // quotes that do not run out during a test (the fake clock moves minutes)
const BAL = { ok: true, sol: { lamports: 1e9, ui: 1 }, tokens: { [VIC]: { ui: 0, hasAccount: true } } };
const base = (over = {}) => ({ "/api/swap/config": CONFIG, "/api/swap/quote": () => QUOTE({ expiresAt: LATER() }), "/api/swap/balances": BAL, "/api/swap/tx": () => TX({ quote: QUOTE({ expiresAt: LATER() }) }), "/api/swap/status": { ok: true, status: "confirmed" }, ...over });
const input = (P, value) => { const i = P.$(".swap__amt"); i.value = value; i.dispatchEvent(newEvent("input")); };
/** Types an amount and lets it settle: the quote (450 ms), then the build (600 ms after the keystroke). */
const type = async (P, value) => { input(P, value); await P.advance(1000); };
const go = (P) => P.$(".swap__go");
const txCalls = (P) => byPath(P.calls, "/api/swap/tx").length;
const quoteCalls = (P) => byPath(P.calls, "/api/swap/quote").length;
const panelOf = (P) => [...P.VSwap._panels][0];
/** A /tx answer that waits for release() while open: the time a build takes, made visible. */
function gated(make) { const g = { open: false, n: 0, release: null }; g.answer = (body) => { g.n++; const d = make(g.n, body); if (!g.open) return d; return new Promise((r) => { g.release = () => r(d); }); }; return g; }
/** The token page's Buy panel with a wallet connected (nothing typed yet). */
async function connected({ wallet = walletOf(), answers = {}, ...rest } = {}) {
  const P = await swapPage({ clock: true, wallets: [wallet], answers: base(answers), ...rest });
  click(go(P)); await P.flush();
  click(P.$(".swap__wallets .wallet-option")); await P.flush();
  return P;
}
/** Counts every write of the status line (a screen reader announces each one). */
function writes(P) {
  const st = P.$(".swap__status"), seen = [];
  let proto = Object.getPrototypeOf(st), d = null;
  while (proto && !(d = Object.getOwnPropertyDescriptor(proto, "textContent"))) proto = Object.getPrototypeOf(proto);
  Object.defineProperty(st, "textContent", { configurable: true, get() { return d.get.call(this); }, set(v) { seen.push(String(v)); d.set.call(this, v); } });
  return seen;
}

test("ready: a settled quote is built in the background ('Getting your exact price…', 'Preparing…' off, the amount still open), then the BUILD's numbers, the exact line and 'Buy $VICINITY'; the wallet is not asked; no 12 s preview refresh while the price is ready", async () => {
  const w = walletOf();
  const g = gated(() => TX({ quote: QUOTE({ outAmount: "89600000000", outUi: "89600", minOut: "88704000000", minOutUi: "88704", expiresAt: LATER() }) }));
  const P = await connected({ wallet: w, answers: { "/api/swap/tx": (b) => g.answer(b) } });
  g.open = true;
  input(P, "0.25");
  await P.advance(450); // the quote
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__status")), text(go(P)), go(P).disabled], ["Preparing…", "Getting your exact price…", "Preparing…", true], "the button is off while the exact price is on its way");
  assert.equal(g.n, 0, "not built before the amount has settled for 600 ms");
  await P.advance(150);
  assert.equal(g.n, 1, "built 600 ms after the last keystroke");
  assert.deepEqual(byPath(P.calls, "/api/swap/tx")[0].body, { inputMint: SOL, outputMint: VIC, amount: "0.25", slippageBps: 100, taker: TAKER, quoteId: "q1" }, "today's body");
  assert.deepEqual([P.$(".swap__amt").disabled, P.$(".swap__flip").disabled], [false, false], "typing on is never blocked by a build");
  g.release(); await P.flush();
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__amt--out")), P.$$(".swap__details dd").map(text)[0]], ["Price ready", "89,600", "88,704 $VICINITY"], "the build's own numbers replace the preview");
  assert.equal(text(P.$(".swap__status")), "You pay 0.25 SOL → you get 89,600 $VICINITY (at least 88,704).");
  assert.equal(P.$(".swap__status").getAttribute("aria-live"), "polite");
  assert.deepEqual([text(go(P)), go(P).disabled], ["Buy $VICINITY", false]);
  assert.deepEqual(w.calls, [["connect"]], "building never opens the wallet");
  const quotes = quoteCalls(P);
  await P.advance(30_000);
  assert.deepEqual([quoteCalls(P), g.n], [quotes, 1], "no 12-second preview refresh while the price is ready: the build is the truth");
  // no wallet: only the preview, refreshed every 12 s as before; nothing is built
  const N = await swapPage({ clock: true, answers: base() });
  await type(N, "0.25");
  assert.deepEqual([text(go(N)), txCalls(N)], ["Connect wallet", 0]);
  await N.advance(12_000);
  assert.equal(quoteCalls(N), 2, "the preview refresh runs while nothing is built");
});

test("ready: ONE tap calls signAndSendTransaction synchronously (in the calls right after the click, before anything settles) with the built bytes and chain; extra taps are ignored; then sending, confirming, done; Enter in the amount is the same tap", async () => {
  const w = walletOf();
  const P = await connected({ wallet: w });
  await type(P, "0.25");
  click(go(P));
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls)), [["connect"], ["signAndSend", 300, "solana:mainnet", { preflightCommitment: "confirmed", maxRetries: 3 }]], "the wallet already has the request: nothing was awaited since the click");
  assert.deepEqual([text(P.$(".swap__state")), text(go(P)), go(P).disabled, P.$(".swap__amt").disabled], ["Confirm in wallet", "Confirm in your wallet…", true, true]);
  click(go(P)); P.$(".swap__amt").dispatchEvent(newEvent("keydown", { key: "Enter" }));
  assert.equal(w.calls.length, 2, "taps while the wallet is open are ignored");
  await P.flush(); await P.advance(1500);
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__status"))], ["Swapped ✓", "Swapped ✓ 0.25 SOL → 89,166.22 $VICINITY"]);
  assert.equal(txCalls(P), 1, "one build, one tap");
  await P.advance(1000); // the balances, read again a second after the trade
  assert.deepEqual(P.pending(), [], "nothing left ticking after a trade");
  // Enter in the amount field
  const kw = walletOf({ name: "Phantom" });
  const K = await connected({ wallet: kw });
  await type(K, "0.25");
  K.$(".swap__amt").dispatchEvent(newEvent("keydown", { key: "Enter" }));
  assert.equal(kw.calls[kw.calls.length - 1][0], "signAndSend", "Enter is the button, inside the key press");
  // a tap while the price is still being built does nothing
  const g = gated(() => TX({ quote: QUOTE({ expiresAt: LATER() }) }));
  const bw = walletOf();
  const B = await connected({ wallet: bw, answers: { "/api/swap/tx": (b) => g.answer(b) } });
  g.open = true; await type(B, "0.25");
  click(go(B)); B.$(".swap__amt").dispatchEvent(newEvent("keydown", { key: "Enter" }));
  assert.deepEqual([bw.calls.length, g.n], [1, 1], "no wallet and no second build while preparing");
  g.release(); await B.flush();
  assert.equal(text(go(B)), "Buy $VICINITY");
});

test("ready: a wallet that only signs: the tap calls signTransaction synchronously and the relay gets the stored ticket of the build on the screen (a rebuild's new ticket after a rebuild)", async () => {
  const w = walletOf({ kind: "sign" });
  let n = 0;
  const P = await connected({ wallet: w, answers: { "/api/swap/tx": () => TX({ ticket: `ticket-${++n}`, lastValidBlockHeight: 4320 + n, quote: QUOTE({ expiresAt: LATER() }) }), "/api/swap/send": { ok: true, signature: "5ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk" } } });
  await type(P, "0.25");
  await P.advance(40_000); // the price ran out: built again (ticket-2)
  assert.equal(n, 2);
  click(go(P));
  assert.deepEqual(w.calls[w.calls.length - 1], ["sign", 300, "solana:mainnet"], "signTransaction inside the tap");
  await P.flush();
  const send = byPath(P.calls, "/api/swap/send")[0];
  assert.deepEqual([send.body.ticket, send.body.lastValidBlockHeight, send.body.cluster, typeof send.body.tx], ["ticket-2", 4322, "mainnet", "string"]);
  await P.advance(1500);
  assert.equal(text(P.$(".swap__state")), "Swapped ✓");
});

test("ready: a Cancel in the wallet ('Try again') never carries over to a later trade: one the network could not confirm, or that failed on the chain, says 'Start over' and a tap clears the amount; no second build, no second wallet request", async () => {
  for (const status of [{ ok: true, status: "pending" }, { ok: true, status: "failed", err: "slippage" }]) {
    const w = walletOf();
    let cancel = true;
    const send = w.signAndSendTransaction.bind(w);
    w.signAndSendTransaction = (...a) => { if (cancel) { cancel = false; w.calls.push(["cancelled"]); return Promise.reject(new Error("User rejected the request")); } return send(...a); };
    const P = await connected({ wallet: w, answers: { "/api/swap/status": status } });
    await type(P, "0.25");
    click(go(P)); await P.flush();
    assert.deepEqual([text(go(P)), text(P.$(".swap__status"))], ["Try again", "Cancelled in your wallet. Nothing was sent."], "a Cancel is soft: Try again");
    click(go(P)); await P.advance(1000); // Try again: the price is built again
    click(go(P)); await P.flush(); // the tap: this time the wallet sends
    assert.deepEqual(w.calls.map((c) => c[0]), ["connect", "cancelled", "signAndSend"]);
    await P.advance(100_000); // past the 90 s watch (pending), or the chain's "failed" at the first poll
    const words = status.status === "pending" ? /^We could not confirm it in time\./ : /^The price moved more than your slippage allows\./;
    assert.match(text(P.$(".swap__status")), words);
    assert.equal(text(go(P)), "Start over", `${status.status}: the earlier Cancel does not turn this into 'Try again' (which would buy the same amount a second time)`);
    const builds = txCalls(P);
    click(go(P)); await P.advance(1000);
    assert.deepEqual([P.$(".swap__amt").value, text(P.$(".swap__state")), txCalls(P), w.calls.length], ["", "Ready", builds, 3], "Start over clears the amount: nothing built, the wallet not asked again");
  }
});

test("ready: at 40 s the price is built again quietly (a fresh quote, then the build; the line stays, the button off and busy), at most 3 times without anyone touching the panel; then 'Refresh price' (tap = a new price, the next tap buys); nothing is asked for an absent person", async () => {
  const w = walletOf();
  const g = gated(() => TX({ quote: QUOTE({ expiresAt: LATER() }) }));
  const P = await connected({ wallet: w, answers: { "/api/swap/tx": (b) => g.answer(b) } });
  await type(P, "0.25");
  assert.equal(g.n, 1);
  const line = text(P.$(".swap__status"));
  const said = writes(P);
  const q0 = quoteCalls(P);
  await P.advance(39_000);
  assert.equal(g.n, 1);
  g.open = true;
  await P.advance(1000);
  assert.deepEqual([quoteCalls(P), g.n], [q0 + 1, 2], "a fresh quote first, then the build (the Worker reuses that quote's Jupiter build)");
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__status")), text(go(P)), go(P).disabled, go(P).classList.contains("is-busy")], ["Refreshing…", line, "Buy $VICINITY", true, true], "quiet: the line stays, the button waits");
  g.open = false; g.release(); await P.flush();
  assert.deepEqual([text(P.$(".swap__state")), go(P).disabled, text(P.$(".swap__status"))], ["Price ready", false, line]);
  assert.deepEqual(said, [], "the same price is not announced again");
  await P.advance(40_000); assert.equal(g.n, 3);
  await P.advance(40_000); assert.equal(g.n, 4);
  await P.advance(40_000);
  assert.equal(g.n, 4, "three quiet rebuilds, no fourth");
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__status")), text(go(P)), go(P).disabled], ["Live", "Prices change, so this one has run out. Tap Refresh price for a new one.", "Refresh price", false]);
  const q1 = quoteCalls(P);
  await P.advance(300_000);
  assert.deepEqual([g.n, quoteCalls(P)], [4, q1], "nothing more is asked while nobody is there (no 12 s refresh either)");
  click(go(P)); await P.flush(); // Refresh price
  assert.deepEqual([g.n, quoteCalls(P), text(P.$(".swap__state")), text(go(P)), text(P.$(".swap__status"))], [5, q1 + 1, "Price ready", "Buy $VICINITY", line]);
  assert.equal(w.calls.length, 1, "Refresh price only builds");
  click(go(P));
  assert.equal(w.calls[1][0], "signAndSend", "the next tap buys");
});

test("ready: somebody touching the panel (a tap, a key, a change) starts the count of quiet rebuilds again", async () => {
  let n = 0;
  const P = await connected({ answers: { "/api/swap/tx": () => { n++; return TX({ quote: QUOTE({ expiresAt: LATER() }) }); } } });
  await type(P, "0.25");
  await P.advance(80_000);
  assert.equal(n, 3, "two quiet rebuilds so far");
  click(P.$(".swap__help")); // a tap anywhere on the panel
  await P.advance(120_000);
  assert.equal(n, 6, "three more after the touch");
  await P.advance(40_000);
  assert.deepEqual([n, text(go(P))], [6, "Refresh price"]);
  // a key in the amount field (not a new amount: an arrow key) counts too
  const Q = await connected({ answers: { "/api/swap/tx": () => TX({ quote: QUOTE({ expiresAt: LATER() }) }) } });
  await type(Q, "0.25");
  await Q.advance(80_000);
  Q.$(".swap__amt").dispatchEvent(newEvent("keydown", { key: "ArrowLeft" }));
  await Q.advance(120_000);
  assert.equal(txCalls(Q), 6);
});

test("ready: a hidden page is never rebuilt; back on screen with the price run out it is rebuilt once at once; back before that nothing is asked; a tap on a price that ran out never reaches the wallet: built again, 'Price refreshed. Tap Buy again.'", async () => {
  const w = walletOf();
  let n = 0;
  const P = await connected({ wallet: w, answers: { "/api/swap/tx": () => { n++; return TX({ ticket: `t${n}`, quote: QUOTE({ expiresAt: LATER() }) }); } } });
  await type(P, "0.25");
  const quotes = quoteCalls(P);
  P.setHidden(true);
  await P.advance(300_000);
  assert.deepEqual([n, quoteCalls(P), text(P.$(".swap__state"))], [1, quotes, "Price ready"], "nothing built or quoted while nobody looks");
  P.setHidden(false); await P.flush();
  assert.equal(n, 2, "rebuilt the moment the page is back");
  P.setHidden(true); await P.advance(10_000); P.setHidden(false); await P.flush();
  assert.equal(n, 2, "back within the 40 s: the price still stands");
  await P.advance(30_000);
  assert.equal(n, 3, "and its own clock still runs");
  // a tap on a price that ran out (a phone that slept: the 40 s timer had not fired yet)
  const Q = await connected({ wallet: walletOf() });
  await type(Q, "0.25");
  Q.setHidden(true); await Q.advance(45_000);
  const qw = Q.VSwap.wallet.adapter;
  click(go(Q));
  assert.equal(qw.calls.length, 1, "no wallet for a price that ran out");
  assert.deepEqual([text(go(Q)), go(Q).disabled], ["Preparing…", true]);
  await Q.flush();
  assert.deepEqual([text(Q.$(".swap__status")), text(go(Q)), txCalls(Q)], ["Price refreshed. Tap Buy again.", "Buy $VICINITY", 2]);
  click(go(Q));
  assert.equal(qw.calls[1][0], "signAndSend", "the fresh build goes to the wallet");
});

test("ready: a rebuild that came out WORSE says 'The price changed: you would now get …' (is-moved) and keeps the button off 1.5 s (a tap then does nothing); a better one just updates; the first build is judged against the preview the same way", async () => {
  const w = walletOf();
  const builds = [TX({ quote: QUOTE({ expiresAt: LATER() }) }), TX({ quote: QUOTE({ outAmount: "88000000000", outUi: "88000", minOut: "87120000000", minOutUi: "87120", expiresAt: LATER() }) }), TX({ quote: QUOTE({ outAmount: "90000000000", outUi: "90000", minOut: "89100000000", minOutUi: "89100", expiresAt: LATER() }) })];
  const P = await connected({ wallet: w, answers: { "/api/swap/tx": () => builds.shift() } });
  await type(P, "0.25"); // built 600 ms after the keystroke; type() ends at 1000 ms
  await P.advance(39_600); // the 40 s are up: rebuilt, worse
  assert.equal(text(P.$(".swap__status")), "The price changed: you would now get 88,000 $VICINITY (at least 87,120). Nothing was sent.");
  assert.ok(P.$(".swap__status").classList.contains("is-moved"));
  assert.deepEqual([text(P.$(".swap__amt--out")), go(P).disabled, text(go(P))], ["88,000", true, "Buy $VICINITY"]);
  click(go(P));
  assert.equal(w.calls.length, 1, "no wallet for numbers nobody had time to see");
  await P.advance(1400);
  assert.equal(go(P).disabled, true);
  await P.advance(100);
  assert.equal(go(P).disabled, false, "1.5 s later the button is back");
  assert.equal(text(P.$(".swap__status")), "The price changed: you would now get 88,000 $VICINITY (at least 87,120). Nothing was sent.", "the line stays until the next price");
  await P.advance(38_500); // the next rebuild is better: no pause, the usual line
  assert.deepEqual([text(P.$(".swap__status")), go(P).disabled, P.$(".swap__status").classList.contains("is-moved")], ["You pay 0.25 SOL → you get 90,000 $VICINITY (at least 89,100).", false, false]);
  click(go(P));
  assert.equal(w.calls[1][0], "signAndSend");
  // the first build against the preview on the screen
  const F = await connected({ answers: { "/api/swap/tx": () => TX({ quote: QUOTE({ outAmount: "80000000000", outUi: "80000", minOut: "79200000000", minOutUi: "79200", expiresAt: LATER() }) }) } });
  await type(F, "0.25");
  assert.deepEqual([text(F.$(".swap__status")), go(F).disabled], ["The price changed: you would now get 80,000 $VICINITY (at least 79,200). Nothing was sent.", true]);
  await F.advance(1500);
  assert.equal(go(F).disabled, false);
});

test("ready: a new amount, slippage, the pair, the flip and another wallet all drop the price and quote again (a build still on its way is ignored); the wallet is never asked", async () => {
  const w = walletOf();
  const g = gated(() => TX({ quote: QUOTE({ expiresAt: LATER() }) }));
  const P = await connected({ wallet: w, answers: { "/api/swap/tx": (b) => g.answer(b) } });
  const isReady = () => assert.equal(text(P.$(".swap__state")), "Price ready");
  await type(P, "0.25"); isReady();
  input(P, "0.3");
  assert.deepEqual([text(P.$(".swap__state")), text(go(P)), go(P).disabled], ["Quoting…", "Quoting…", true], "a new amount: the old price is gone at once");
  await P.advance(1000); isReady();
  assert.equal(byPath(P.calls, "/api/swap/tx").pop().body.amount, "0.3");
  click(P.$$(".swap__chip")[2]);
  assert.equal(text(P.$(".swap__state")), "Quoting…", "slippage");
  await P.advance(1000); isReady();
  assert.deepEqual([byPath(P.calls, "/api/swap/quote").pop().body.slippageBps, byPath(P.calls, "/api/swap/tx").pop().body.slippageBps], [300, 300]);
  click(P.$(".swap__flip")); await P.flush();
  assert.deepEqual([text(P.$(".swap__state")), P.$(".swap__amt").value, text(go(P))], ["Ready", "", "Sell $VICINITY"], "the flip starts over");
  await type(P, "1000"); isReady();
  assert.deepEqual([text(go(P)), byPath(P.calls, "/api/swap/tx").pop().body.inputMint], ["Sell $VICINITY", VIC]);
  click(P.$(".swap__flip")); await P.flush(); await type(P, "0.25");
  // a build on its way when the amount changes: its answer is never shown
  g.open = true;
  input(P, "0.4"); await P.advance(600);
  assert.equal(text(P.$(".swap__state")), "Preparing…");
  const before = g.n;
  input(P, "0.5");
  g.release(); await P.flush();
  assert.equal(text(P.$(".swap__state")), "Quoting…", "the late build for 0.4 is not shown");
  g.open = false;
  await P.advance(1000); isReady();
  assert.equal(g.n, before + 1);
  assert.equal(byPath(P.calls, "/api/swap/tx").pop().body.amount, "0.5");
  // the pair (a swap panel's picker)
  const S = await connected({ slot: `<div id="buy-slot" data-swap data-in="SOL" data-out="${USDC}" data-mode="swap"></div>`, answers: { "/api/swap/tx": () => TX({ quote: QUOTE({ outputMint: USDC, expiresAt: LATER() }) }) } });
  await type(S, "0.25");
  assert.deepEqual([text(S.$(".swap__state")), text(go(S))], ["Price ready", "Swap"]);
  click(S.$$(".swap__token")[1]); await S.flush();
  click(S.$$(".swap__picker .swap__opt").find((b) => /VICINITY/.test(text(b)))); await S.flush();
  assert.equal(text(S.$(".swap__state")), "Quoting…", "another token: the price for the old pair is gone");
  await S.advance(1000);
  assert.equal(byPath(S.calls, "/api/swap/tx").pop().body.outputMint, VIC);
  // another wallet connected (from another panel on the page): the price was not built for it
  await P.advance(61_000); // (the page's own budget of 8 automatic builds a minute is spent by now: a minute later it is back)
  await type(P, "0.25"); isReady();
  const w2 = walletOf({ address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", name: "Other" });
  const other = P.doc.createElement("div"); P.doc.body.append(other);
  const second = await P.VSwap.mount(other, { mode: "swap", in: "SOL", out: USDC }); await P.flush();
  P.win.VW.list = () => [w2];
  second.connect(); click(other.querySelector(".swap__wallets .wallet-option")); await P.flush();
  assert.equal(P.VSwap.wallet.address, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  await P.advance(1000);
  isReady();
  assert.equal(byPath(P.calls, "/api/swap/tx").filter((c) => c.body.amount === "0.25").pop().body.taker, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "built again for the new wallet");
  assert.deepEqual(w.calls, [["connect"]], "the first wallet was never asked to sign");
});

test("ready: a 429 on an automatic build stops them ('Tap Buy to get your price', the numbers kept, no error); the tap builds and the next tap buys; a tapped build that gets a 429 says today's words; automatic builds come back after the pause", async () => {
  const w = walletOf();
  let slow = true;
  const P = await connected({ wallet: w, answers: { "/api/swap/tx": () => (slow ? { ok: false, error: "slow_down", _status: 429, retryAfterS: 60 } : TX({ quote: QUOTE({ expiresAt: LATER() }) })) } });
  await type(P, "0.25");
  assert.deepEqual([text(P.$(".swap__state")), text(P.$(".swap__status")), text(go(P)), go(P).disabled, text(P.$(".swap__amt--out"))], ["Live", "Tap Buy to get your price.", "Buy $VICINITY", false, "89,166.22"]);
  assert.ok(!P.$(".swap__status").classList.contains("is-bad"), "not an error: nobody did anything wrong");
  const builds = txCalls(P);
  await type(P, "0.3");
  assert.deepEqual([txCalls(P), text(P.$(".swap__status"))], [builds, "Tap Buy to get your price."], "a new amount within the pause is not built by itself");
  await P.advance(12_000);
  assert.equal(txCalls(P), builds, "the 12 s preview refresh never builds by itself meanwhile");
  click(go(P)); await P.flush();
  assert.deepEqual([text(P.$(".swap__status")), text(P.$(".swap__state"))], ["Too many tries from your network right now. Wait a minute and try again.", "Stopped"], "a tapped build that gets a 429: today's words");
  slow = false;
  click(go(P)); await P.flush(); // Try again
  assert.deepEqual([text(P.$(".swap__state")), text(go(P))], ["Price ready", "Buy $VICINITY"]);
  assert.equal(w.calls.length, 1, "the tap only built");
  click(go(P));
  assert.equal(w.calls[1][0], "signAndSend", "the following tap buys");
  await P.flush(); await P.advance(1500);
  click(go(P)); await P.flush(); // Swap again
  await P.advance(60_000);
  await type(P, "0.2");
  assert.equal(text(P.$(".swap__state")), "Price ready", "a minute later the price is built by itself again");
});

test("ready: the page builds by itself at most 8 times a minute (every panel together); past that 'Tap Buy to get your price'; a minute later by itself again", async () => {
  const P = await connected();
  for (let i = 1; i <= 8; i++) { await type(P, `0.${i}`); assert.equal(text(P.$(".swap__state")), "Price ready", `amount ${i}`); }
  assert.equal(txCalls(P), 8);
  await type(P, "0.9");
  assert.deepEqual([txCalls(P), text(P.$(".swap__status")), text(go(P)), go(P).disabled], [8, "Tap Buy to get your price.", "Buy $VICINITY", false], "the ninth within the minute waits for a tap");
  click(go(P)); await P.flush();
  assert.equal(text(P.$(".swap__state")), "Price ready", "a tap always gets the price");
  await P.advance(40_000);
  assert.deepEqual([txCalls(P), text(P.$(".swap__status"))], [9, "Tap Buy to get your price."], "its 40 s ran out with the minute's budget still spent: no quiet rebuild either");
  await P.advance(20_000);
  await type(P, "1.1");
  assert.deepEqual([text(P.$(".swap__state")), txCalls(P)], ["Price ready", 10], "the minute passed: built by itself again");
});

test("ready: a city coin on its curve: the price is built by the launchpad route with today's body, the tap signs on devnet; sold, the button says 'Sell $DEMOV'", async () => {
  const w = walletOf({ chains: ["solana:mainnet", "solana:devnet"] });
  const sellQuote = CURVE_QUOTE({ side: "sell", inputMint: CITY, outputMint: SOL, inUi: "1000", outUi: "0.0004", minOutUi: "0.000396", outAmount: "400000", minOut: "396000", decimals: { in: 6, out: 9 }, expiresAt: LATER() });
  const C = await connected({ wallet: w, slot: `<div id="buy-slot" data-swap data-out="${CITY}" data-in="SOL" data-mode="buy"></div>`, answers: {
    "/api/swap/quote": (b) => ({ ok: true, source: "curve", mint: CITY, side: b.inputMint === CITY ? "sell" : "buy", chain: "solana:devnet", cluster: "devnet", quoteMint: SOL }),
    "/api/launchpad/trade/quote": (b) => (b.side === "sell" ? sellQuote : CURVE_QUOTE({ expiresAt: LATER() })),
    "/api/launchpad/trade/tx": (b) => TX({ chain: "solana:devnet", cluster: "devnet", quote: b.side === "sell" ? sellQuote : CURVE_QUOTE({ expiresAt: LATER() }), quoteId: "c1" }),
  } });
  await type(C, "0.25");
  assert.deepEqual(byPath(C.calls, "/api/launchpad/trade/tx")[0].body, { mint: CITY, side: "buy", amount: "0.25", slippageBps: 100, taker: TAKER, quoteId: "c1" });
  assert.equal(txCalls(C), 0, "never the Jupiter route for a curve coin");
  assert.deepEqual([text(C.$(".swap__state")), text(go(C))], ["Devnet test coin", "Buy $DEMOV"]);
  click(go(C));
  assert.deepEqual(w.calls[w.calls.length - 1].slice(0, 3), ["signAndSend", 300, "solana:devnet"]);
  await C.flush(); await C.advance(1500);
  click(go(C)); await C.flush(); // Swap again
  click(C.$(".swap__flip")); await C.flush(); await type(C, "1000");
  assert.deepEqual([text(go(C)), text(C.$(".swap__label")), byPath(C.calls, "/api/launchpad/trade/tx").pop().body.side], ["Sell $DEMOV", "You sell", "sell"]);
  // a curve rebuild asks both quotes again, then the launchpad build
  const before = [byPath(C.calls, "/api/swap/quote").length, byPath(C.calls, "/api/launchpad/trade/quote").length, byPath(C.calls, "/api/launchpad/trade/tx").length];
  await C.advance(40_000);
  assert.deepEqual([byPath(C.calls, "/api/swap/quote").length, byPath(C.calls, "/api/launchpad/trade/quote").length, byPath(C.calls, "/api/launchpad/trade/tx").length], before.map((n) => n + 1));
});

test("ready: destroy() clears every timer (the settle wait, the 40 s, the 1.5 s hold, the preview refresh); nothing is built or signed after", async () => {
  const builds = [TX({ quote: QUOTE({ expiresAt: LATER() }) }), TX({ quote: QUOTE({ outAmount: "80000000000", outUi: "80000", minOut: "79200000000", minOutUi: "79200", expiresAt: LATER() }) })];
  const w = walletOf();
  const P = await connected({ wallet: w, answers: { "/api/swap/tx": () => builds.shift() || TX() } });
  await type(P, "0.25");
  await P.advance(40_000); // a worse rebuild: the button held
  const panel = panelOf(P);
  assert.ok(panel.s.holding && P.pending().includes(40_000) && P.pending().includes(1500), `the 40 s and the hold are pending (${P.pending()})`);
  panel.destroy();
  assert.deepEqual(P.pending(), [], "no timer left behind");
  await P.advance(300_000);
  assert.deepEqual([txCalls(P), w.calls.length], [2, 1]);
  // destroyed while waiting for the amount to settle, or while a build is on its way
  const Q = await connected();
  input(Q, "0.25"); await Q.advance(500);
  assert.equal(text(Q.$(".swap__state")), "Preparing…");
  panelOf(Q).destroy();
  assert.deepEqual(Q.pending(), []);
  await Q.advance(60_000);
  assert.equal(txCalls(Q), 0);
});

test("ready: a trade in the wallet's or the network's hands keeps its watch: MAX is off, a token list left open closes and its options do nothing, so the trade still ends in 'Swapped ✓' with its Solscan link and a second tap never reaches the wallet", async () => {
  // MAX while the network confirms
  let polls = 0;
  const w = walletOf();
  const P = await connected({ wallet: w, answers: { "/api/swap/balances": { ok: true, sol: { lamports: 2e9, ui: 2 }, tokens: { [VIC]: { ui: 0, hasAccount: true } } }, "/api/swap/status": () => (++polls < 3 ? { ok: true, status: "pending" } : { ok: true, status: "confirmed" }) } });
  await type(P, "0.25");
  click(go(P)); await P.flush();
  assert.equal(text(P.$(".swap__state")), "Confirming…");
  assert.deepEqual([P.$(".swap__max").disabled, P.$(".swap__flip").disabled, P.$(".swap__amt").disabled], [true, true, true], "nothing on the panel changes a trade on its way");
  click(P.$(".swap__max")); await P.advance(2000);
  assert.deepEqual([text(P.$(".swap__state")), P.$(".swap__amt").value, txCalls(P)], ["Confirming…", "0.25", 1], "MAX did nothing: no new quote, no build");
  await P.advance(4000);
  assert.deepEqual([text(P.$(".swap__state")), /View on Solscan/.test(text(P.$(".swap__links")))], ["Swapped ✓", true], "the trade that was sent is still watched to the end");
  // MAX while the wallet is still open, then a second tap
  let release;
  const w2 = walletOf();
  w2.signAndSendTransaction = (bytes, chain) => { w2.calls.push(["signAndSend", bytes.length, chain]); return new Promise((r) => { release = () => r(new Uint8Array(64).fill(3)); }); };
  const Q = await connected({ wallet: w2, answers: { "/api/swap/balances": { ok: true, sol: { lamports: 2e9, ui: 2 }, tokens: {} } } });
  await type(Q, "0.25");
  click(go(Q)); await Q.flush();
  click(Q.$(".swap__max")); await Q.advance(2000);
  click(go(Q)); Q.$(".swap__amt").dispatchEvent(newEvent("keydown", { key: "Enter" })); await Q.flush();
  assert.deepEqual(w2.calls.map((c) => c[0]), ["connect", "signAndSend"], "one wallet request at a time");
  assert.deepEqual([text(Q.$(".swap__state")), Q.$(".swap__amt").value], ["Confirm in wallet", "0.25"]);
  release(); await Q.flush(); await Q.advance(1500);
  assert.equal(text(Q.$(".swap__state")), "Swapped ✓");
  // a token list opened before the tap: closed by the tap; an option tapped anyway changes nothing
  const S = await connected({ slot: `<div id="buy-slot" data-swap data-in="SOL" data-out="${USDC}" data-mode="swap"></div>`, answers: { "/api/swap/tx": () => TX({ quote: QUOTE({ outputMint: USDC, expiresAt: LATER() }) }), "/api/swap/status": { ok: true, status: "pending" } } });
  await type(S, "0.25");
  click(S.$$(".swap__token")[0]); await S.flush();
  const opt = S.$$(".swap__picker .swap__opt").find((b) => /USDC/.test(text(b)));
  assert.equal(S.$(".swap__picker").hidden, false);
  click(go(S)); await S.flush();
  assert.equal(S.$(".swap__picker").hidden, true, "the tap closed the token list");
  click(opt); await S.advance(5000);
  assert.deepEqual([text(S.$(".swap__state")), text(S.$$(".swap__token")[0]).replace(/▾/, "").slice(1).trim(), byPath(S.calls, "/api/swap/status").length > 1], ["Confirming…", "SOL", true], "the pair stayed and the watch goes on");
});

test("ready: automatic builds ask the route with ?auto=1 (the Worker counts them apart from taps), a tap never does; the budget of 8 a minute is this browser's, shared by its tabs and kept over a reload; a 429 in one tab pauses them in the others", async () => {
  const store = {};
  const P = await connected({ storage: store });
  await type(P, "0.25");
  click(go(P)); await P.flush(); await P.advance(1500); // bought: Swapped ✓
  click(go(P)); await P.flush(); // Swap again
  await type(P, "0.3");
  await P.advance(40_000); // a quiet rebuild
  P.setHidden(true); await P.advance(45_000); P.setHidden(false); await P.flush(); // back with the price run out
  const urls = byPath(P.calls, "/api/swap/tx").map((c) => c.path);
  assert.deepEqual(urls, ["/api/swap/tx?auto=1", "/api/swap/tx?auto=1", "/api/swap/tx?auto=1", "/api/swap/tx?auto=1"], "built by itself, after a settle, a rebuild, a return");
  const Q = await connected({ storage: {}, answers: { "/api/swap/tx": () => ({ ok: false, error: "slow_down", _status: 429 }) } });
  await type(Q, "0.25");
  click(go(Q)); await Q.flush(); // "Tap Buy to get your price": the tap
  assert.deepEqual(byPath(Q.calls, "/api/swap/tx").map((c) => c.path), ["/api/swap/tx?auto=1", "/api/swap/tx"], "the tap is a tap");
  // two tabs (two pages on one storage): 5 automatic builds in one, then only 3 more in the other within the minute
  const shared = {};
  const A = await connected({ storage: shared });
  for (let i = 1; i <= 5; i++) await type(A, `0.${i}`);
  assert.equal(txCalls(A), 5);
  // (each page here has its own fake clock: a later tab's starts where the earlier one's is, like one computer's clock)
  const sameClock = async (X, Y) => { const d = Y.now() - X.now(); if (d > 0) await X.advance(d); };
  const B = await connected({ storage: shared });
  await sameClock(B, A);
  for (let i = 1; i <= 4; i++) await type(B, `1.${i}`);
  assert.deepEqual([txCalls(B), text(B.$(".swap__status"))], [3, "Tap Buy to get your price."], "8 for the browser, not 8 per tab");
  // a reload (a new page on the same storage) starts with what is already spent
  const R = await connected({ storage: shared });
  await sameClock(R, B);
  await type(R, "2");
  assert.deepEqual([txCalls(R), text(R.$(".swap__status"))], [0, "Tap Buy to get your price."]);
  // junk in storage is ignored; storage that throws leaves each page counting alone
  const J = await connected({ storage: { "vicinity.swapAuto": "{not json" } });
  await type(J, "0.25");
  assert.equal(text(J.$(".swap__state")), "Price ready");
  const T = await connected({ storage: "throws" });
  for (let i = 1; i <= 9; i++) await type(T, `0.${i}`);
  assert.equal(txCalls(T), 8);
});

test("ready: a 429 seen in one tab pauses the automatic builds of the other tabs too (they wait for a tap)", async () => {
  const shared = {};
  const A = await connected({ storage: shared, answers: { "/api/swap/tx": () => ({ ok: false, error: "slow_down", _status: 429, retryAfterS: 60 }) } });
  await type(A, "0.25");
  assert.equal(text(A.$(".swap__status")), "Tap Buy to get your price.");
  const B = await connected({ storage: shared });
  const d = A.now() - B.now(); if (d > 0) await B.advance(d);
  await type(B, "0.25");
  assert.deepEqual([txCalls(B), text(B.$(".swap__status"))], [0, "Tap Buy to get your price."]);
});

test("ready: a retired panel leaves no listener on a reused element (the sheet's body, a dashboard slot mounted again)", async () => {
  const P = await swapPage({ answers: base(), slot: "<div></div>" });
  for (let i = 1; i <= 20; i++) { await P.VSwap.open({ out: i % 2 ? VIC : CITY }); await P.flush(); }
  const body = P.doc.querySelector(".swap-sheet__body");
  const count = (e) => { const c = {}; for (const l of e.listeners) c[l.type] = (c[l.type] || 0) + 1; return JSON.stringify(c); };
  assert.equal(count(body), JSON.stringify({ click: 1, input: 1, keydown: 1, change: 1 }), "one live panel's own four");
  assert.equal(P.VSwap._panels.size, 1);
  const slot = P.doc.createElement("div"); P.doc.body.append(slot);
  for (let i = 1; i <= 10; i++) { slot.removeAttribute("data-swap-mounted"); slot.replaceChildren(); await P.VSwap.mount(slot, { mode: "buy", in: "SOL", out: i % 2 ? VIC : USDC }); await P.flush(); }
  assert.equal(count(slot), JSON.stringify({ click: 1, input: 1, keydown: 1, change: 1 }));
});

test("ready: the keyboard is never lost: after picking a wallet with it (a computer) it is on the amount; after a trade by Enter it is on the button, so Enter again is 'Swap again'", async () => {
  const w = walletOf();
  const P = await swapPage({ clock: true, wallets: [w], answers: base() });
  click(go(P)); await P.flush();
  const opt = P.$(".swap__wallets .wallet-option");
  assert.equal(P.doc.activeElement, opt, "the box opened with the keyboard on its first wallet");
  click(opt); await P.flush();
  assert.equal(P.doc.activeElement, P.$(".swap__amt"), "the box is gone: the keyboard is on the amount");
  P.$(".swap__amt").value = "0.25"; P.$(".swap__amt").dispatchEvent(newEvent("input")); await P.advance(1000);
  P.$(".swap__amt").dispatchEvent(newEvent("keydown", { key: "Enter" }));
  assert.equal(w.calls[1][0], "signAndSend");
  await P.flush(); await P.advance(1500);
  assert.deepEqual([text(P.$(".swap__state")), P.doc.activeElement], ["Swapped ✓", go(P)], "the amount was off while the wallet was open: the keyboard is back on the button");
  P.doc.activeElement.dispatchEvent(newEvent("click")); await P.flush(); // Enter on a focused button is its click
  assert.deepEqual([text(P.$(".swap__state")), P.$(".swap__amt").value], ["Ready", ""], "Swap again");
  // a keyboard elsewhere on the page is never taken back
  const Q = await connected();
  await type(Q, "0.25");
  click(go(Q));
  const other = Q.doc.createElement("button"); Q.doc.body.append(other); other.focus();
  await Q.flush(); await Q.advance(1500);
  assert.equal(Q.doc.activeElement, other);
  // a phone: connecting does not pop the keyboard
  const M = await swapPage({ clock: true, isMobile: true, wallets: [walletOf()], answers: base() });
  click(M.$(".swap__go")); await M.flush();
  click(M.$(".swap__wallets .wallet-option")); await M.flush();
  assert.notEqual(M.doc.activeElement, M.$(".swap__amt"));
});

test("link note: 'Filled in from your link' goes once the trade is not the link's any more (typing, the flip, slippage, another token)", async () => {
  const href = `https://vicinity.test/token?swap_in=SOL&swap_out=${VIC}&swap_amt=0.5`;
  const P = await swapPage({ clock: true, answers: base(), href });
  await P.advance(500);
  assert.equal(P.$(".swap__note").hidden, false);
  click(P.$(".swap__flip")); await P.flush();
  assert.equal(P.$(".swap__note").hidden, true, "the flip");
  const S = await swapPage({ clock: true, answers: base(), slot: `<div id="buy-slot" data-swap data-in="SOL" data-out="${USDC}" data-mode="swap"></div>`, href: `https://vicinity.test/token?swap_in=SOL&swap_out=USDC&swap_amt=1` });
  await S.advance(500);
  assert.equal(S.$(".swap__note").hidden, false);
  click(S.$$(".swap__token")[1]); await S.flush();
  click(S.$$(".swap__picker .swap__opt").find((b) => /VICINITY/.test(text(b)))); await S.flush();
  assert.equal(S.$(".swap__note").hidden, true, "another token");
});
