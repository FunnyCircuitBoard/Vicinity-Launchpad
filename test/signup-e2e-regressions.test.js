// Defects found by the end-to-end run against the real Worker + Chromium (scratchpad su-e2e), each pinned here.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, browser, realClock, useClock, wallet } from "./helpers/world.js";
import { doLocation, doWallet, startSignup, stateOf } from "./helpers/signup.js";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let env;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); });
after(() => realClock());

test("a wallet connected FIRST shows as done in GET /api/signup/state even before the sign-up row exists (same as start)", async () => {
  const b = browser(env), w = await wallet();
  await doWallet(b, w); // an old bookmark, or the Log in tab with a new wallet: no sign-up has been started yet
  const masked = `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;
  const before = await stateOf(b);
  assert.deepEqual(before.wallet, { done: true, address: masked }, "the page counts the wallet as one of the three steps already done");
  assert.equal(before.next, "location", "the first open step is still the location");
  assert.equal(before.location.done, false);
  assert.equal(before.terms.done, false);
  assert.equal(before.account.done, false);
  // it must create nothing, and say the same as start does once the sign-up exists
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM signups").first()).n, 0);
  const started = (await startSignup(b)).state;
  assert.deepEqual(started, before);
  await doLocation(b);
  assert.equal((await stateOf(b)).wallet.done, true);
});

test("the state of a browser with no wallet proven and no sign-up is still the plain empty one", async () => {
  const b = browser(env);
  const s = await stateOf(b);
  assert.deepEqual(s, { terms: { done: false, version: "2026-10-01" }, location: { done: false }, account: { done: false }, wallet: { done: false }, next: "location" });
});

test("the page does not say '0 tries left': the last wrong guess says the code is used up and what to do", () => {
  const win = {};
  vm.runInNewContext(readFileSync(new URL("../public/signup.js", import.meta.url), "utf8"), { window: win });
  const P = win.VSignup.pure;
  assert.equal(P.errText({ error: "code_wrong", left: 1 }), "That code doesn't match. 1 try left.");
  const last = P.errText({ error: "code_wrong", left: 0 });
  assert.doesNotMatch(last, /0 tries/);
  assert.match(last, /Send a new code/);
  assert.equal(P.errText({ error: "code_wrong", left: 0 }, "code"), last, "the same in the reset form");
  assert.equal(P.errText({ error: "code_wrong" }), "That code doesn't match. Please check it and try again.");
});
