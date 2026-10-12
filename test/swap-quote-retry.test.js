// public/swap.js on a fake clock: a price that did not load because the price service had a hiccup (Jupiter busy or out of
// reach behind /api/swap/quote, or no answer at all) is asked again QUIETLY ("Still getting the best price…" instead of an
// error) after 1.5 s, 4 s and 8 s (the answer's Retry-After when longer; one past 10 s is not waited out), only while the page
// is looked at and the trade is the same, each retry spent from the page's budget of automatic requests (every panel and tab
// together: a broken Jupiter never makes every open panel hammer the Worker). When the retries are spent the error shows ONCE,
// in calm words, and nothing more is asked by itself: Try again asks again. Builds and sends are not retried here (their own
// rules: test/swap-ready.test.js). The Worker's side (the keyed host standing in for the lite one) is in test/swap-api.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newEvent } from "./helpers/pagedom.js";
import { VIC, CONFIG, QUOTE, TX, TAKER, walletOf, swapPage, byPath, click, text } from "./helpers/swappage.js";

const LATER = () => new Date(Date.now() + 3_600_000).toISOString();
const DOWN = { ok: false, error: "jupiter_unavailable", retryAfterS: 5, _status: 503 }; // what the Worker answers when Jupiter could not be reached
const ERROR = "Prices are not loading right now. Tap Try again in a moment.";
const input = (P, value) => { const i = P.$(".swap__amt"); i.value = value; i.dispatchEvent(newEvent("input")); };
const asks = (P, amount) => byPath(P.calls, "/api/swap/quote").filter((c) => amount === undefined || c.body.amount === amount).length;
const view = (P) => ({ tag: text(P.$(".swap__state")), line: text(P.$(".swap__status")), out: text(P.$(".swap__amt--out")), bad: P.$(".swap__status").classList.contains("is-bad"), button: text(P.$(".swap__go")) });
/** Every write of the status line (what a screen reader announces), to prove what was, and was not, ever on the screen. */
function writes(P) {
  const st = P.$(".swap__status"), seen = [];
  let proto = Object.getPrototypeOf(st), d = null;
  while (proto && !(d = Object.getOwnPropertyDescriptor(proto, "textContent"))) proto = Object.getPrototypeOf(proto);
  Object.defineProperty(st, "textContent", { configurable: true, get() { return d.get.call(this); }, set(v) { seen.push(String(v)); d.set.call(this, v); } });
  return seen;
}
/** /api/swap/quote answering from a script: each entry is used once (the last one stays). */
function script(...answers) { const list = [...answers]; return (body) => { const a = list.length > 1 ? list.shift() : list[0]; return typeof a === "function" ? a(body) : a; }; }
const estimate = () => QUOTE({ source: "jupiter_quote", estimate: true, expiresAt: LATER() });
/** The token page's Buy panel, nobody connected (the owner's case: typed 1 SOL with no wallet in the browser). */
const panel = (quote, rest = {}) => swapPage({ clock: true, storage: {}, ...rest, answers: { "/api/swap/config": CONFIG, "/api/swap/quote": quote, ...(rest.answers || {}) } });

test("quote retry (pure): which answers are a passing hiccup, and how long each quiet retry waits", async () => {
  const P = await panel(estimate);
  const { quoteDown, retryWait } = P.VSwap;
  for (const d of [DOWN, { ok: false, error: "jupiter_busy", _status: 503 }, { ok: false, error: "swap_unavailable", _status: 0 }, { ok: false, error: "swap_unavailable", _status: 502, _empty: true }, null]) assert.equal(quoteDown(d), true, JSON.stringify(d));
  for (const d of [{ ok: false, error: "no_route", _status: 404 }, { ok: false, error: "amount_too_small", _status: 400 }, { ok: false, error: "jupiter_refused", _status: 502 }, { ok: false, error: "slow_down", _status: 429 }, { ok: false, error: "swap_unavailable", _status: 503 }, { ok: false, error: "rpc_unavailable", _status: 503 }, estimate()]) assert.equal(quoteDown(d), false, JSON.stringify(d));
  const plain = { ok: false, error: "jupiter_unavailable", _status: 503 };
  assert.deepEqual([0, 1, 2, 3].map((n) => retryWait(plain, n)), [1500, 4000, 8000, null], "three retries, then none");
  assert.deepEqual([0, 1, 2].map((n) => retryWait({ ...plain, retryAfterS: 5 }, n)), [5000, 5000, 8000], "the Worker's Retry-After when it is longer");
  assert.equal(retryWait({ ...plain, retryAfterS: 30 }, 0), null, "a wait past 10 s is not hidden behind a spinner");
  assert.equal(retryWait({ ok: false, error: "no_route", _status: 404 }, 0), null);
  assert.equal(retryWait(plain, -1), null);
});

test("quote retry: ONE failure then the price: no error is ever on the screen ('Still getting the best price…' meanwhile), the retry waits the Worker's Retry-After and is spent from the page's budget", async () => {
  const P = await panel(script(DOWN, estimate));
  const seen = writes(P);
  input(P, "1"); await P.advance(450);
  assert.equal(asks(P), 1);
  assert.deepEqual(view(P), { tag: "Quoting…", line: "Still getting the best price…", out: "…", bad: false, button: "Quoting…" }, "the hiccup: still getting the price, no error");
  await P.advance(4_999);
  assert.equal(asks(P), 1, "the Worker said Retry-After 5: not asked before");
  await P.advance(1);
  assert.equal(asks(P, "1"), 2, "asked again, quietly");
  assert.deepEqual(view(P), { tag: "Estimate", line: "Estimate: the exact amount is shown before your wallet opens.", out: "89,166.22", bad: false, button: "Connect wallet" });
  assert.ok(!seen.some((l) => /not loading|could not|busy|went wrong/i.test(l)), `never an error: ${JSON.stringify(seen)}`);
  assert.equal(JSON.parse(P.win.localStorage.getItem("vicinity.swapAuto")).log.length, 1, "the retry counted in this browser's budget of automatic requests");
  // no answer at all (the request itself failed: offline for a moment): the same, after 1.5 s
  const Q = await panel(script(() => { throw new TypeError("Failed to fetch"); }, estimate));
  const seenQ = writes(Q);
  input(Q, "1"); await Q.advance(450);
  await Q.advance(1_500);
  assert.equal(asks(Q), 2);
  assert.equal(view(Q).tag, "Estimate");
  assert.ok(!seenQ.some((l) => /not loading|could not|went wrong|not available/i.test(l)), JSON.stringify(seenQ));
});

test("quote retry: the first ask and its THREE quiet retries all fail: the calm error is written ONCE, after the last; nothing more is asked by itself; Try again asks again", async () => {
  const plain = { ok: false, error: "jupiter_unavailable", _status: 503 };
  let answer = plain;
  const P = await panel(() => answer);
  const seen = writes(P);
  input(P, "1"); await P.advance(450);
  for (const [wait, n] of [[1500, 2], [4000, 3], [8000, 4]]) {
    assert.deepEqual([view(P).line, view(P).bad], ["Still getting the best price…", false], `no error after failure ${n - 1}`);
    await P.advance(wait - 1); assert.equal(asks(P), n - 1, `retry ${n - 1} not before ${wait} ms`);
    await P.advance(1); assert.equal(asks(P), n, `retry ${n - 1} at ${wait} ms`);
  }
  assert.deepEqual(view(P), { tag: "Try again", line: ERROR, out: "—", bad: false, button: "Try again" }, "the retries are spent: calm words in the calm colour (not the red of an error), a neutral tag, and the button asks again");
  assert.equal(seen.filter((l) => l === ERROR).length, 1, "the error was written once");
  assert.ok(!seen.some((l) => /could not be reached/.test(l)), "never the old words");
  await P.advance(120_000);
  assert.equal(asks(P), 4, "nothing more is asked by itself (the words do not promise it)");
  answer = estimate();
  click(P.$(".swap__go")); await P.advance(0);
  assert.equal(asks(P), 5, "Try again asks for the price (no wallet: it does not open the wallet chooser first)");
  assert.deepEqual([view(P).tag, view(P).out, P.$(".swap__wallets").hidden], ["Estimate", "89,166.22", true]);
  assert.equal(seen.filter((l) => l === ERROR).length, 1);
});

test("quote retry: a new amount (or slippage, or the flip) while a retry waits drops the old retry: only the new trade is asked, once", async () => {
  const P = await panel((b) => (b.amount === "1" && b.slippageBps === 100 ? DOWN : estimate()));
  input(P, "1"); await P.advance(450);
  assert.equal(view(P).line, "Still getting the best price…");
  await P.advance(1_000);
  input(P, "2"); await P.advance(450);
  assert.deepEqual([asks(P, "1"), asks(P, "2"), view(P).tag], [1, 1, "Estimate"]);
  await P.advance(11_000);
  assert.deepEqual([asks(P), view(P).tag, view(P).bad], [2, "Estimate", false], "the old retry is gone: nothing is asked again before the new price's own 12 s refresh");
  await P.advance(30_000);
  assert.equal(asks(P, "1"), 1, "the old amount was never asked again");
  // the slippage changed while a retry waits: the same
  input(P, "1"); await P.advance(450);
  assert.equal(view(P).line, "Still getting the best price…");
  const before = asks(P);
  click(P.$$(".swap__chip")[2]); await P.advance(100);
  assert.deepEqual([asks(P) - before, byPath(P.calls, "/api/swap/quote").pop().body.slippageBps, view(P).tag], [1, 300, "Estimate"]);
  await P.advance(11_000);
  assert.equal(asks(P) - before, 1, "no retry of the old trade, and none of the new one");
  // the flip clears the trade: nothing is asked, no error, and the retry's budget is not spent
  const store = {};
  const Q = await swapPage({ clock: true, storage: store, answers: { "/api/swap/config": CONFIG, "/api/swap/quote": () => DOWN } });
  input(Q, "1"); await Q.advance(450);
  click(Q.$(".swap__flip")); await Q.advance(30_000);
  assert.deepEqual([asks(Q), view(Q).bad, store["vicinity.swapAuto"]], [1, false, undefined]);
});

test("quote retry: a hidden page holds its retry back and asks when it is looked at again; past the page's budget (or a Retry-After past 10 s) the calm error shows at once; a 429 on a retry pauses the automatic builds", async () => {
  const P = await panel(script(DOWN, estimate));
  input(P, "1"); await P.advance(450);
  P.setHidden(true);
  await P.advance(60_000);
  assert.deepEqual([asks(P), view(P).line], [1, "Still getting the best price…"], "nothing asked while nobody looks");
  P.setHidden(false); await P.advance(0);
  assert.deepEqual([asks(P), view(P).tag], [2, "Estimate"], "asked once the page is looked at again");
  // this browser's automatic requests of the minute are spent (8: builds and retries of every tab): no quiet retry
  const full = { "vicinity.swapAuto": JSON.stringify({ log: Array.from({ length: 8 }, () => Date.now()), slowUntil: 0 }) };
  const Q = await swapPage({ clock: true, storage: full, answers: { "/api/swap/config": CONFIG, "/api/swap/quote": () => DOWN } });
  input(Q, "1"); await Q.advance(450);
  assert.deepEqual([view(Q).line, asks(Q)], [ERROR, 1], "the budget is spent: the error at once, no retry");
  await Q.advance(30_000);
  assert.equal(asks(Q), 1);
  // a Retry-After longer than a quiet wait: told at once
  const R = await panel(() => ({ ok: false, error: "jupiter_busy", retryAfterS: 30, _status: 503 }));
  input(R, "1"); await R.advance(450);
  assert.deepEqual([view(R).line, asks(R)], [ERROR, 1]);
  // a retry that gets a 429 from the Worker pauses this browser's automatic requests (every panel, every tab) like a build's 429
  const store = {};
  const S = await swapPage({ clock: true, storage: store, answers: { "/api/swap/config": CONFIG, "/api/swap/quote": script(DOWN, { ok: false, error: "slow_down", _status: 429, retryAfterS: 60 }) } });
  input(S, "1"); await S.advance(450); await S.advance(5_000);
  assert.equal(asks(S), 2);
  assert.equal(view(S).line, "Too many tries from your network right now. Wait a minute and try again.", "a refusal is not retried");
  assert.ok(JSON.parse(store["vicinity.swapAuto"]).slowUntil >= S.now() + 55_000, "automatic requests paused for the Retry-After");
});

test("quote retry: the 12 s refresh that hits a hiccup keeps its numbers on the screen while it asks again; a connected wallet's price is built as usual once the retry brings the quote", async () => {
  let down = false;
  const P = await panel(() => (down ? DOWN : estimate()));
  const seen = writes(P);
  input(P, "1"); await P.advance(450);
  assert.equal(view(P).tag, "Estimate");
  down = true;
  await P.advance(12_000);
  assert.equal(asks(P), 2, "the refresh asked");
  assert.deepEqual([view(P).tag, view(P).out, view(P).bad], ["Estimate", "89,166.22", false], "the numbers stay while it asks again");
  down = false;
  await P.advance(5_000);
  assert.deepEqual([asks(P), view(P).tag, view(P).bad], [3, "Estimate", false]);
  assert.ok(!seen.some((l) => /not loading|could not/.test(l)));
  // connected: the typed amount's quote fails once, the retry brings it, the exact price is built (one tap still buys)
  const w = walletOf();
  const C = await swapPage({ clock: true, storage: {}, wallets: [w], answers: { "/api/swap/config": CONFIG, "/api/swap/quote": script(DOWN, () => QUOTE({ expiresAt: LATER() })), "/api/swap/balances": { ok: true, sol: { lamports: 1e9, ui: 1 }, tokens: { [VIC]: { ui: 0, hasAccount: true } } }, "/api/swap/tx": () => TX({ quote: QUOTE({ expiresAt: LATER() }) }) } });
  click(C.$(".swap__go")); await C.advance(0); click(C.$(".swap__wallets .wallet-option")); await C.advance(0);
  input(C, "0.25"); await C.advance(450);
  assert.equal(view(C).line, "Still getting the best price…");
  assert.equal(byPath(C.calls, "/api/swap/tx").length, 0, "nothing is built without a quote");
  await C.advance(6_000);
  assert.deepEqual([view(C).tag, view(C).button], ["Price ready", "Buy $VICINITY"]);
  assert.equal(byPath(C.calls, "/api/swap/quote").pop().body.taker, TAKER);
  assert.deepEqual(w.calls, [["connect"]], "the wallet is not asked to sign by itself");
});
