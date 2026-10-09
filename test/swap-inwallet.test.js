// public/swap.js inside a wallet app's own browser (integration finding INT-1): a person signed in to Vicinity with the wallet of the
// app they are in finds the Buy panel ALREADY connected, so the flow is: type the amount → "Getting your exact price…" → the price is
// ready → ONE tap on Buy → the wallet's own sheet. The panel asks the wallet SILENTLY (wallets.js connectSilently: never a prompt)
// once per page, only when exactly one wallet is on the page and it is that wallet app's own (site.js V.walletApp.here()), and takes
// the answer only when it is the signed-in person's wallet (V.ready, the /api/me?lite=1 every page reads) or the wallet this tab
// connected with a tap before (sessionStorage). Everything else keeps today's "Connect wallet": a computer, two wallets, another
// account's wallet, a wallet that shares nothing or fails, a person with no account and no tap in this tab, the switch off. A trade a
// link filled in is still never built by itself. The adapter side (wallets.js) is in test/wallets-silent.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newEvent } from "./helpers/pagedom.js";
import { VIC, TAKER, CONFIG, QUOTE, TX, walletOf, swapPage, byPath, click, text } from "./helpers/swappage.js";

const LATER = () => new Date(Date.now() + 3_600_000).toISOString();
const BAL = { ok: true, sol: { lamports: 1e9, ui: 1 }, tokens: { [VIC]: { ui: 0, hasAccount: true } } };
const base = (over = {}) => ({ "/api/swap/config": CONFIG, "/api/swap/quote": () => QUOTE({ expiresAt: LATER() }), "/api/swap/balances": BAL, "/api/swap/tx": () => TX({ quote: QUOTE({ expiresAt: LATER() }) }), "/api/swap/status": { ok: true, status: "confirmed" }, ...over });
const OTHER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const ME = (wallet = TAKER) => ({ signedIn: true, user: { id: 7, handle: "RobinJ3", wallet, walletApp: "phantom" } });
const VISITOR = { signedIn: false };
const TAB_KEY = "vicinity.swapWallet";
const go = (P) => P.$(".swap__go");
const txCalls = (P) => byPath(P.calls, "/api/swap/tx").length;
const kinds = (w) => w.calls.map((c) => c[0]);
const type = async (P, value) => { const i = P.$(".swap__amt"); i.value = value; i.dispatchEvent(newEvent("input")); await P.advance(1000); };
/** Inside Phantom's own browser (a phone; site.js says this is Phantom's), signed in as `me`. */
const inPhantom = (o = {}) => swapPage({ clock: true, isMobile: true, inWalletApp: true, here: "phantom", me: ME(), answers: base(), ...o });

test("in the wallet app, signed in with that wallet: the panel opens CONNECTED (asked silently, once, never a prompt), and the Buy is the first tap: amount → price ready → one tap → the wallet's own sheet → Swapped", async () => {
  const w = walletOf({ name: "Phantom", silent: "trusted" });
  const P = await inPhantom({ wallets: [w] });
  assert.deepEqual([text(go(P)), go(P).disabled, text(P.$(".swap__status"))], ["Buy $VICINITY", true, "Connected CnQM…zz6p"], "connected before anything is typed; nothing to buy yet");
  assert.deepEqual(w.calls, [["connectSilently"]], "asked silently once; never the connect that can prompt");
  assert.equal(P.$(".swap__wallets").hidden, true, "no wallet list to pick from");
  assert.equal(P.calls.filter((c) => c.toast).length, 0, "no toast: the panel simply starts connected");
  assert.equal(byPath(P.calls, "/api/swap/balances")[0].path.includes(`owner=${TAKER}`), true, "the balances of that wallet are read");
  // type → "Getting your exact price…" → ready
  const i = P.$(".swap__amt"); i.value = "0.25"; i.dispatchEvent(newEvent("input"));
  await P.advance(450);
  assert.deepEqual([text(P.$(".swap__status")), text(go(P))], ["Getting your exact price…", "Preparing…"]);
  await P.advance(600);
  assert.deepEqual([text(P.$(".swap__state")), text(go(P)), go(P).disabled, txCalls(P)], ["Price ready", "Buy $VICINITY", false, 1]);
  assert.equal(byPath(P.calls, "/api/swap/tx")[0].body.taker, TAKER, "built for the connected wallet");
  assert.deepEqual(kinds(w), ["connectSilently"], "building never opens the wallet");
  // the FIRST tap is the Buy: the wallet is asked inside it
  click(go(P));
  assert.deepEqual(kinds(w), ["connectSilently", "signAndSend"], "one tap → the wallet's own sheet");
  await P.flush(); await P.advance(1500);
  assert.equal(text(P.$(".swap__state")), "Swapped ✓");
});

test("in the wallet app: every panel of the page is connected (the dashboard's card, the sheet a Launchpad card opens), the wallet asked ONCE per page", async () => {
  const w = walletOf({ name: "Phantom", silent: "trusted" });
  const P = await inPhantom({ wallets: [w], href: "https://vicinity.test/dashboard", slot: `<div id="buy-slot" data-swap data-out="${VIC}" data-in="SOL" data-mode="buy"></div>` });
  assert.equal(text(go(P)), "Buy $VICINITY");
  const sheet = await P.VSwap.open({ out: VIC }); await P.flush();
  assert.deepEqual([text(sheet.go), sheet.connected], ["Buy $VICINITY", true], "the sheet opens connected too");
  const again = P.doc.createElement("div"); P.doc.body.append(again);
  const p3 = await P.VSwap.mount(again, { mode: "swap", in: "SOL", out: VIC }); await P.flush();
  assert.equal(p3.connected, true, "a slot mounted again (the dashboard's routes) is connected");
  assert.deepEqual(w.calls, [["connectSilently"]], "one silent question per page, whatever mounts");
});

test("in the wallet app, the answer is not the signed-in person's wallet (another account in that app): today's 'Connect wallet', and the tap path is today's", async () => {
  const w = walletOf({ name: "Phantom", silent: "trusted" });
  const P = await inPhantom({ wallets: [w], me: ME(OTHER) });
  assert.deepEqual([text(go(P)), text(P.$(".swap__status")), P.VSwap.wallet.address], ["Connect wallet", "You pay SOL, the market gives you $VICINITY; your own wallet asks you to confirm.", null]);
  assert.deepEqual(w.calls, [["connectSilently"]], "asked silently; the answer is not taken");
  await type(P, "0.25");
  assert.deepEqual([text(go(P)), txCalls(P)], ["Connect wallet", 0], "nothing built without a connected wallet");
  click(go(P)); await P.flush();
  assert.equal(P.$(".swap__wallets").hidden, false, "the wallet list, as today");
  click(P.$(".swap__wallets .wallet-option")); await P.advance(1000);
  assert.deepEqual([kinds(w), text(P.$(".swap__state"))], [["connectSilently", "connect"], "Price ready"], "the person's own tap connects, as today");
});

test("in the wallet app, a wallet that shares nothing, refuses, or throws: today's 'Connect wallet'; never a connect that can prompt without a tap", async () => {
  for (const silent of [null, "throw", undefined, 42, ""]) {
    const w = walletOf({ name: "Phantom", silent });
    const P = await inPhantom({ wallets: [w] });
    await P.advance(5000);
    assert.deepEqual([text(go(P)), P.VSwap.wallet.address, kinds(w)], ["Connect wallet", null, ["connectSilently"]], `silent answer ${String(silent)}`);
  }
  // an adapter without a silent connect (an older wallets.js): nothing is asked at all
  const old = walletOf({ name: "Phantom" }); delete old.connectSilently;
  const O = await inPhantom({ wallets: [old] });
  await O.advance(5000);
  assert.deepEqual([text(go(O)), old.calls], ["Connect wallet", []]);
});

test("in the wallet app, a silent answer that comes after the person tapped Connect wallet is dropped (their choice is on the screen); one after their own connect changes nothing", async () => {
  const w = walletOf({ name: "Phantom", silent: "hang" });
  const P = await inPhantom({ wallets: [w] });
  assert.equal(text(go(P)), "Connect wallet", "no answer yet: today's button");
  click(go(P)); await P.flush();
  assert.equal(P.$(".swap__wallets").hidden, false, "the person is choosing");
  w.answerSilent("trusted"); await P.flush();
  assert.deepEqual([P.$(".swap__wallets").hidden, P.VSwap.wallet.address], [false, null], "the late answer does not connect under the person's finger");
  click(P.$(".swap__wallets .wallet-option")); await P.flush();
  assert.deepEqual([kinds(w), P.VSwap.wallet.address], [["connectSilently", "connect"], TAKER]);
  // the person connected first (the box closed again), then the silent answer: nothing changes
  const v = walletOf({ name: "Phantom", silent: "hang" });
  const Q = await inPhantom({ wallets: [v] });
  click(go(Q)); await Q.flush(); click(Q.$(".swap__wallets .wallet-option")); await Q.flush();
  const before = Q.calls.length;
  v.answerSilent("trusted"); await Q.flush();
  assert.deepEqual([kinds(v), Q.calls.length], [["connectSilently", "connect"], before], "no second connect, no new request");
});

test("a computer (an extension wallet), even one that says it is a wallet app: no silent connect, today's 'Connect wallet'", async () => {
  const w = walletOf({ name: "Phantom", silent: "trusted" });
  const P = await swapPage({ clock: true, isMobile: false, inWalletApp: true, here: "phantom", me: ME(), wallets: [w], answers: base() });
  await P.advance(5000);
  assert.deepEqual([text(go(P)), w.calls], ["Connect wallet", []]);
  click(go(P)); await P.flush();
  assert.equal(text(P.$(".swap__phone")), "Use my phone instead", "the computer's wallet list, as today");
});

test("in the wallet app: two wallets on the page, a wallet that is not this app's own, or a page that is not a wallet app: nothing is asked", async () => {
  const a = walletOf({ name: "Phantom", silent: "trusted" }), b = walletOf({ name: "Solflare", silent: "trusted" });
  const P = await inPhantom({ wallets: [a, b] });
  await P.advance(5000);
  assert.deepEqual([text(go(P)), a.calls, b.calls], ["Connect wallet", [], []], "two wallets: the person chooses");
  const s = walletOf({ name: "Solflare", silent: "trusted" });
  const S = await inPhantom({ wallets: [s] }); // Phantom's browser (site.js), but the wallet on the page is Solflare's
  await S.advance(5000);
  assert.deepEqual([text(go(S)), s.calls], ["Connect wallet", []]);
  const u = walletOf({ name: "Unknown Wallet", silent: "trusted" });
  const U = await inPhantom({ wallets: [u] });
  await U.advance(5000);
  assert.deepEqual([text(go(U)), u.calls], ["Connect wallet", []], "a wallet that is not a known wallet app's");
  const n = walletOf({ name: "Phantom", silent: "trusted" });
  const N = await inPhantom({ wallets: [n], here: null }); // a phone browser site.js does not take for a wallet app's
  await N.advance(5000);
  assert.deepEqual([text(go(N)), n.calls], ["Connect wallet", []]);
  const f = walletOf({ name: "Phantom", silent: "trusted" });
  const F = await inPhantom({ wallets: [f], inWalletApp: false });
  await F.advance(5000);
  assert.deepEqual([text(go(F)), f.calls], ["Connect wallet", []], "VW.inWalletApp() says no");
});

test("a phone's Safari (no wallet on the page): nothing is asked, the chooser of wallet apps as today; a wallet app's wallet that turns up within 3 s is asked, one later than that is not", async () => {
  const P = await swapPage({ clock: true, isMobile: true, inWalletApp: false, here: null, me: ME(), answers: base() });
  await P.advance(5000);
  click(go(P)); await P.flush();
  assert.match(text(P.$(".swap__lead")), /^Buying happens in your wallet app\. Tap yours: Vicinity opens there/, "Safari: the wallet apps to open, as today");
  assert.equal(P.VSwap.wallet.address, null);
  // the wallet comes 2 s late (an in-app browser injecting after the page's scripts): asked then, connected
  const wallets = [];
  const L = await inPhantom({ wallets });
  await L.advance(2000);
  const w = walletOf({ name: "Phantom", silent: "trusted" });
  wallets.push(w); for (const f of [...L.listeners]) f();
  await L.flush();
  assert.deepEqual([text(go(L)), w.calls], ["Buy $VICINITY", [["connectSilently"]]]);
  // 4 s late: the page gave up at 3 s
  const later = [];
  const T = await inPhantom({ wallets: later });
  await T.advance(4000);
  const v = walletOf({ name: "Phantom", silent: "trusted" });
  later.push(v); for (const f of [...T.listeners]) f();
  await T.advance(5000);
  assert.deepEqual([text(go(T)), v.calls], ["Connect wallet", []]);
});

test("in the wallet app with no Vicinity account: nothing is asked (today's Connect); after the person's own connect, this TAB's next page starts connected with that wallet, and only that one", async () => {
  const session = {};
  const w = walletOf({ name: "Phantom", silent: "trusted" });
  const P = await inPhantom({ wallets: [w], me: VISITOR, session });
  await P.advance(5000);
  assert.deepEqual([text(go(P)), w.calls], ["Connect wallet", []], "a visitor: the wallet is not even asked");
  click(go(P)); await P.flush(); click(P.$(".swap__wallets .wallet-option")); await P.flush();
  assert.deepEqual(JSON.parse(session[TAB_KEY]), { address: TAKER, name: "Phantom" }, "this tab remembers the wallet it connected with a tap");
  // the next page in the same tab (a Launchpad card's sheet, /coin...): connected from the start
  const w2 = walletOf({ name: "Phantom", silent: "trusted" });
  const Q = await inPhantom({ wallets: [w2], me: VISITOR, session });
  assert.deepEqual([text(go(Q)), w2.calls], ["Buy $VICINITY", [["connectSilently"]]]);
  // the wallet app now shares ANOTHER account: not taken
  const w3 = walletOf({ name: "Phantom", silent: "trusted", address: OTHER });
  const R = await inPhantom({ wallets: [w3], me: VISITOR, session });
  assert.deepEqual([text(go(R)), w3.calls], ["Connect wallet", [["connectSilently"]]]);
  // junk in the tab's storage, or storage that throws: as if nothing was kept (and the person's own connect still works)
  for (const s of [{ [TAB_KEY]: "{not json" }, { [TAB_KEY]: JSON.stringify({ address: "<script>" }) }, "throws"]) {
    const x = walletOf({ name: "Phantom", silent: "trusted" });
    const X = await inPhantom({ wallets: [x], me: VISITOR, session: s });
    await X.advance(5000);
    assert.deepEqual([text(go(X)), x.calls], ["Connect wallet", []]);
    click(go(X)); await X.flush(); click(X.$(".swap__wallets .wallet-option")); await X.flush();
    assert.equal(X.VSwap.wallet.address, TAKER);
  }
  // /api/me unreachable: nobody to recognise
  const y = walletOf({ name: "Phantom", silent: "trusted" });
  const Y = await inPhantom({ wallets: [y], me: Promise.reject(new Error("offline")) });
  await Y.advance(5000);
  assert.deepEqual([text(go(Y)), y.calls], ["Connect wallet", []]);
});

test("in the wallet app, a trade a LINK filled in is never built by itself: connected, 'Tap Buy to get your price'; the tap builds, the next tap buys; a typed amount is built as usual", async () => {
  const w = walletOf({ name: "Phantom", silent: "trusted" });
  const P = await inPhantom({ wallets: [w], href: `https://vicinity.test/token?swap_in=SOL&swap_out=${VIC}&swap_amt=0.25&swap_slip=100` });
  await P.advance(5000);
  assert.deepEqual([P.$(".swap__amt").value, text(P.$(".swap__note")), text(go(P)), text(P.$(".swap__status")), txCalls(P)],
    ["0.25", "Filled in from your link. Check the amount.", "Buy $VICINITY", "Tap Buy to get your price.", 0], "filled in and connected; nothing built");
  assert.deepEqual(kinds(w), ["connectSilently"]);
  click(go(P)); await P.advance(1000);
  assert.deepEqual([text(P.$(".swap__state")), text(go(P)), txCalls(P), kinds(w)], ["Price ready", "Buy $VICINITY", 1, ["connectSilently"]], "the person's tap asked for the price; the wallet is still shut");
  click(go(P));
  assert.deepEqual(kinds(w), ["connectSilently", "signAndSend"], "the next tap buys");
  // the person types their own amount over the link's: built by itself as usual
  const v = walletOf({ name: "Phantom", silent: "trusted" });
  const Q = await inPhantom({ wallets: [v], href: `https://vicinity.test/token?swap_in=SOL&swap_out=${VIC}&swap_amt=0.25` });
  await Q.advance(5000);
  assert.equal(txCalls(Q), 0);
  await type(Q, "0.3");
  assert.deepEqual([text(Q.$(".swap__state")), txCalls(Q)], ["Price ready", 1]);
});

test("the swap switched off: no panel, and the wallet is never asked", async () => {
  const w = walletOf({ name: "Phantom", silent: "trusted" });
  const P = await inPhantom({ wallets: [w], answers: { "/api/swap/config": { ...CONFIG, swap: false } } });
  await P.advance(5000);
  assert.deepEqual([P.slot.hidden, P.$(".swap__go"), w.calls], [true, null, []]);
});
