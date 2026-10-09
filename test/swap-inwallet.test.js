// public/swap.js inside a wallet app's own browser (integration finding INT-1): a person signed in to Vicinity with the wallet of the
// app they are in finds the Buy panel ALREADY connected, so the flow is: type the amount → "Getting your exact price…" → the price is
// ready → ONE tap on Buy → the wallet's own sheet. The panel asks the wallet SILENTLY (wallets.js connectSilently: never a prompt)
// once per page (as soon as the switch is known on, on a page that shows a Buy), only when exactly one wallet is on the page and it
// stayed alone for a moment (a second one, even a moment later, means the person chooses), and takes the answer only when it is the
// signed-in person's wallet (V.ready, the /api/me?lite=1 every page reads) or the wallet this tab connected with a tap before
// (sessionStorage). While the answer may still connect, the button says "Checking your wallet…" and does nothing (never an active
// "Connect wallet" that a tap would turn into the one-wallet list). Everything else keeps today's "Connect wallet": a computer, two
// wallets, another account's wallet, a wallet that shares nothing or fails, a person with no account and no tap in this tab, the switch
// off. A trade a link filled in is still never built by itself. The adapter side (wallets.js), the real site.js rule for "this app's own
// wallet" and the real wallets.js timing are in test/wallets-silent.test.js.
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
const CHECKING = "Checking your wallet…";
const SETTLE = 450; // past the page's wait (400 ms) after the first wallet is on the page
/** Inside Phantom's own browser (a phone; site.js says this is Phantom's), signed in as `me`, at the very first moment. */
const inPhantomNow = (o = {}) => swapPage({ clock: true, isMobile: true, inWalletApp: true, here: "phantom", me: ME(), answers: base(), ...o });
/** The same, once the page's short wait after the wallet appeared is over (the silent answer has come, if the wallet answers at once). */
const inPhantom = async (o = {}) => { const P = await inPhantomNow(o); await P.advance(SETTLE); return P; };
/** The wallet app's listeners after a wallet was added to `list` (wallets.js tells the page). */
const announce = (P) => { for (const f of [...P.listeners]) f(); };

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

test("in the wallet app, while the silent answer is on its way the button says 'Checking your wallet…' and a tap does nothing; with no answer within 4 s it is today's 'Connect wallet', and an answer after the person tapped it is dropped", async () => {
  const w = walletOf({ name: "Phantom", silent: "hang" });
  const P = await inPhantom({ wallets: [w] });
  assert.deepEqual([text(go(P)), go(P).disabled, kinds(w)], [CHECKING, true, ["connectSilently"]], "the wallet is answering: a still button, not an active Connect wallet");
  click(go(P)); await P.flush();
  const enter = newEvent("keydown"); enter.key = "Enter"; P.$(".swap__amt").dispatchEvent(enter); await P.flush();
  assert.deepEqual([P.$(".swap__wallets").hidden, kinds(w)], [true, ["connectSilently"]], "a tap (or Enter) in those moments opens no wallet list");
  await P.advance(4000);
  assert.deepEqual([text(go(P)), go(P).disabled], ["Connect wallet", false], "no answer within 4 s: today's button");
  click(go(P)); await P.flush();
  assert.equal(P.$(".swap__wallets").hidden, false, "the person is choosing");
  w.answerSilent("trusted"); await P.flush();
  assert.deepEqual([P.$(".swap__wallets").hidden, P.VSwap.wallet.address], [false, null], "the late answer does not connect under the person's finger");
  click(P.$(".swap__wallets .wallet-option")); await P.flush();
  assert.deepEqual([kinds(w), P.VSwap.wallet.address], [["connectSilently", "connect"], TAKER]);
  // the person connected first (the box closed again), then the silent answer: nothing changes
  const v = walletOf({ name: "Phantom", silent: "hang" });
  const Q = await inPhantom({ wallets: [v] });
  await Q.advance(4000);
  click(go(Q)); await Q.flush(); click(Q.$(".swap__wallets .wallet-option")); await Q.flush();
  const before = Q.calls.length;
  v.answerSilent("trusted"); await Q.flush();
  assert.deepEqual([kinds(v), Q.calls.length], [["connectSilently", "connect"], before], "no second connect, no new request");
});

test("in the wallet app, the first moments: 'Checking your wallet…' (still) while /api/me is on its way and while the wallet answers, then 'Buy' as soon as it is connected; an answer of nothing, or a visitor, is today's 'Connect wallet' at once", async () => {
  // /api/me still on its way
  let answerMe; const me = new Promise((r) => { answerMe = r; });
  const w = walletOf({ name: "Phantom", silent: "trusted" });
  const P = await inPhantomNow({ wallets: [w], me });
  assert.deepEqual([text(go(P)), go(P).disabled, go(P).classList.contains("is-busy"), w.calls], [CHECKING, true, true, []], "who is here is not known yet: not asked, a still button");
  click(go(P)); await P.flush();
  assert.equal(P.$(".swap__wallets").hidden, true);
  answerMe(ME()); await P.flush();
  assert.deepEqual([text(go(P)), w.calls], [CHECKING, []], "the page still waits a moment for a second wallet");
  await P.advance(SETTLE);
  assert.deepEqual([text(go(P)), text(P.$(".swap__status")), w.calls], ["Buy $VICINITY", "Connected CnQM…zz6p", [["connectSilently"]]], "never an active Connect wallet on the way");
  // the wallet shares nothing: today's button as soon as it says so
  const n = walletOf({ name: "Phantom", silent: null });
  const N = await inPhantomNow({ wallets: [n] });
  assert.equal(text(go(N)), CHECKING);
  await N.advance(SETTLE);
  assert.deepEqual([text(go(N)), go(N).disabled, go(N).classList.contains("is-busy")], ["Connect wallet", false, false]);
  // a visitor (no account, no tap in this tab): never 'Checking', not even for a moment
  const v = walletOf({ name: "Phantom", silent: "trusted" });
  const V = await inPhantomNow({ wallets: [v], me: VISITOR });
  assert.deepEqual([text(go(V)), go(V).disabled, v.calls], ["Connect wallet", false, []]);
  // a phone's Safari (no wallet on the page, no wallet app named): today's button from the start
  const S = await swapPage({ clock: true, isMobile: true, inWalletApp: false, here: null, me: ME(), answers: base() });
  assert.deepEqual([text(go(S)), go(S).disabled], ["Connect wallet", false]);
});

test("a computer (an extension wallet), even one that says it is a wallet app: no silent connect, today's 'Connect wallet'", async () => {
  const w = walletOf({ name: "Phantom", silent: "trusted" });
  const P = await swapPage({ clock: true, isMobile: false, inWalletApp: true, here: "phantom", me: ME(), wallets: [w], answers: base() });
  await P.advance(5000);
  assert.deepEqual([text(go(P)), w.calls], ["Connect wallet", []]);
  click(go(P)); await P.flush();
  assert.equal(text(P.$(".swap__phone")), "Use my phone instead", "the computer's wallet list, as today");
});

test("in the wallet app: two wallets on the page, a wallet that is not a known wallet app's, or a page that is not a wallet app: nothing is asked", async () => {
  const a = walletOf({ name: "Phantom", silent: "trusted" }), b = walletOf({ name: "Solflare", silent: "trusted" });
  const P = await inPhantom({ wallets: [a, b] });
  await P.advance(5000);
  assert.deepEqual([text(go(P)), a.calls, b.calls], ["Connect wallet", [], []], "two wallets: the person chooses");
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
  wallets.push(w); announce(L);
  await L.flush();
  assert.deepEqual([text(go(L)), w.calls], [CHECKING, []], "the page waits a moment for a second wallet before it asks");
  await L.advance(SETTLE);
  assert.deepEqual([text(go(L)), w.calls], ["Buy $VICINITY", [["connectSilently"]]]);
  // 4 s late: the page gave up at 3 s
  const later = [];
  const T = await inPhantom({ wallets: later });
  await T.advance(4000);
  const v = walletOf({ name: "Phantom", silent: "trusted" });
  later.push(v); announce(T);
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

test("two wallets, even when the second comes a moment after the first: never connected by itself (the person chooses between both)", async () => {
  // the second wallet a moment after the first (within the page's short wait)
  const list = [], a = walletOf({ name: "Phantom", silent: "trusted" }), b = walletOf({ name: "Solflare", silent: "trusted" });
  const P = await inPhantomNow({ wallets: list });
  await P.advance(1800); list.push(a); announce(P); await P.flush();
  await P.advance(150); list.push(b); announce(P); await P.flush();
  assert.equal(text(go(P)), "Connect wallet", "two wallets: no 'Checking' either");
  await P.advance(5000);
  assert.deepEqual([text(go(P)), P.VSwap.wallet.address, a.calls, b.calls], ["Connect wallet", null, [], []], "neither wallet asked");
  click(go(P)); await P.flush();
  assert.deepEqual(Array.from(P.$$(".swap__wallets .wallet-option")).map((o) => text(o).slice(1).replace(/(Connect|Signs)$/, "")), ["Phantom", "Solflare"], "the person's tap offers both"); // (each option: the mark's letter, the name, what it does)
  // the second wallet while /api/me is still on its way
  let answerMe; const me = new Promise((r) => { answerMe = r; });
  const c = walletOf({ name: "Phantom", silent: "trusted" }), d = walletOf({ name: "Solflare", silent: "trusted" });
  const two = [c];
  const Q = await inPhantomNow({ wallets: two, me });
  await Q.advance(200); two.push(d); announce(Q); await Q.flush();
  answerMe(ME()); await Q.advance(5000);
  assert.deepEqual([text(go(Q)), Q.VSwap.wallet.address, c.calls, d.calls], ["Connect wallet", null, [], []]);
  // the second wallet while the first is answering silently: its answer is not taken
  const e = walletOf({ name: "Phantom", silent: "hang" }), f = walletOf({ name: "Solflare", silent: "trusted" });
  const late = [e];
  const R = await inPhantom({ wallets: late });
  assert.deepEqual(kinds(e), ["connectSilently"]);
  late.push(f); announce(R); await R.flush();
  assert.equal(text(go(R)), "Connect wallet", "no longer 'Checking': the person will choose");
  e.answerSilent("trusted"); await R.advance(5000);
  assert.deepEqual([text(go(R)), R.VSwap.wallet.address, f.calls], ["Connect wallet", null, []]);
});

test("a connection the page made by itself lasts only while that wallet is the page's only one: a second wallet turning up later means 'Connect wallet' again (the built price goes), but never in the middle of a trade", async () => {
  const list = [], a = walletOf({ name: "Phantom", silent: "trusted" });
  list.push(a);
  const P = await inPhantom({ wallets: list });
  await type(P, "0.25");
  assert.deepEqual([text(P.$(".swap__state")), text(go(P))], ["Price ready", "Buy $VICINITY"]);
  list.push(walletOf({ name: "Solflare", silent: "trusted" })); announce(P); await P.flush();
  assert.deepEqual([P.VSwap.wallet.address, text(go(P)), go(P).disabled], [null, "Connect wallet", false], "the person chooses now; nothing is signed");
  assert.deepEqual(kinds(a), ["connectSilently"]);
  // the same, with the trade already in the wallet's hands: it goes on
  const two = [], b = walletOf({ name: "Phantom", silent: "trusted" });
  two.push(b);
  const Q = await inPhantom({ wallets: two });
  await type(Q, "0.25");
  click(go(Q));
  assert.deepEqual(kinds(b), ["connectSilently", "signAndSend"]);
  two.push(walletOf({ name: "Solflare", silent: "trusted" })); announce(Q);
  await Q.flush(); await Q.advance(1500);
  assert.deepEqual([Q.VSwap.wallet.address, text(Q.$(".swap__state"))], [TAKER, "Swapped ✓"]);
  // a wallet the person connected with their own tap stays, whatever turns up
  const three = [], c = walletOf({ name: "Phantom", silent: null });
  three.push(c);
  const R = await inPhantom({ wallets: three });
  click(go(R)); await R.flush(); click(R.$(".swap__wallets .wallet-option")); await R.flush();
  three.push(walletOf({ name: "Solflare" })); announce(R); await R.flush();
  assert.equal(R.VSwap.wallet.address, TAKER);
});

test("as soon as the switch is known on, a page that shows a Buy asks the wallet app (once): a Launchpad or /coin sheet opened later is CONNECTED on its very first render, so is the dashboard's card of a signed-in person; the home page, a signed-out dashboard and the switch off never ask", async () => {
  for (const page of ["launchpad", "coin"]) {
    const w = walletOf({ name: "Phantom", silent: "trusted" });
    const P = await inPhantom({ wallets: [w], official: { swap: true }, page, slot: "", href: `https://vicinity.test/${page}` });
    assert.deepEqual(w.calls, [["connectSilently"]], `${page}: asked before any panel exists`);
    const sheet = await P.VSwap.open({ out: VIC }); // no flush: what the sheet shows the moment it opens
    assert.deepEqual([text(sheet.go), text(sheet.status), sheet.connected], ["Buy $VICINITY", "Connected CnQM…zz6p", true], `${page}: the sheet's first render`);
    assert.deepEqual(w.calls, [["connectSilently"]], `${page}: once per page`);
  }
  // /token with its panel: connected at its first render too, and the panel's own mount asks nothing more
  const t = walletOf({ name: "Phantom", silent: "trusted" });
  const T = await inPhantom({ wallets: [t], official: { swap: true }, page: "token" });
  assert.deepEqual([text(go(T)), t.calls], ["Buy $VICINITY", [["connectSilently"]]]);
  // the dashboard (its Buy card is a signed-in person's, mounted by dashboard.js): signed in, asked before the card mounts; signed out
  // (a visitor with this tab's note), not asked by the page itself, only once a panel does mount
  const d = walletOf({ name: "Phantom", silent: "trusted" });
  const D = await inPhantom({ wallets: [d], official: { swap: true }, page: "dashboard", slot: "", href: "https://vicinity.test/dashboard" });
  assert.deepEqual(d.calls, [["connectSilently"]], "signed in: asked before the card exists");
  const card = D.doc.createElement("div"); D.doc.body.append(card);
  const p = await D.VSwap.mount(card, { mode: "buy", in: "SOL", out: VIC });
  assert.deepEqual([text(p.go), d.calls.length], ["Buy $VICINITY", 1], "the card's first render is connected");
  const session = { "vicinity.swapWallet": JSON.stringify({ address: TAKER, name: "Phantom" }) };
  const g = walletOf({ name: "Phantom", silent: "trusted" });
  const G = await inPhantom({ wallets: [g], me: VISITOR, session, official: { swap: true }, page: "dashboard", slot: "", href: "https://vicinity.test/dashboard" });
  await G.advance(5000);
  assert.deepEqual(g.calls, [], "signed out: no Buy card, the wallet is not asked");
  const sheet = await G.VSwap.open({ out: VIC }); await G.advance(SETTLE);
  assert.deepEqual([g.calls, text(sheet.go)], [[["connectSilently"]], "Buy $VICINITY"], "a panel that mounts after all (a link's sheet): asked then, as before");
  // the home page (its words only): never asked, even signed in with the app's wallet
  const h = walletOf({ name: "Phantom", silent: "trusted" });
  const H = await inPhantom({ wallets: [h], official: { swap: true }, page: "home", slot: "", href: "https://vicinity.test/" });
  await H.advance(5000);
  assert.deepEqual(h.calls, []);
  // the switch off (/api/official, or the swap's own config): no panel, never asked
  const o = walletOf({ name: "Phantom", silent: "trusted" });
  const O = await inPhantom({ wallets: [o], official: { swap: false }, page: "launchpad", slot: "" });
  await O.advance(5000);
  assert.deepEqual([o.calls, await O.VSwap.open({ out: VIC }) === null || o.calls.length === 0], [[], true]);
  const c = walletOf({ name: "Phantom", silent: "trusted" });
  const C = await inPhantom({ wallets: [c], official: { swap: true }, page: "launchpad", slot: "", answers: base({ "/api/swap/config": { ...CONFIG, swap: false } }) });
  await C.advance(5000);
  assert.deepEqual(c.calls, []);
});
