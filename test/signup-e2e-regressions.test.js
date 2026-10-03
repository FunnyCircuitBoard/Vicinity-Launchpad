// Defects found by the end-to-end run against the real Worker + Chromium (scratchpad su-e2e), each pinned here.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EMPTY, V2, browser, realClock, useClock, wallet } from "./helpers/world.js";
import { GOOD_PASSWORD, doEmail, doLocation, doTerms, doWallet, outbox, startSignup, stateOf } from "./helpers/signup.js";
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

// {"toString":1} is valid JSON, and String() of it throws: every route that turned a field into text with String() answered 500.
const ODD = { toString: 1 };
const call = async (b, path, body) => { const r = await b.send(path, { method: "POST", body }); return { status: r.status, data: await r.json() }; };

test("a field that is an object with a broken toString is refused like any other bad value on every v2 route (never a 500)", async () => {
  const b = browser(env), box = outbox();
  assert.deepEqual(await call(b, "/api/auth/email/login", { email: ODD, password: GOOD_PASSWORD }), { status: 401, data: { ok: false, error: "bad_credentials" } });
  assert.deepEqual(await call(b, "/api/auth/password/reset/start", { email: ODD }), { status: 400, data: { ok: false, error: "bad_email" } });
  assert.deepEqual(await call(b, "/api/auth/password/reset", { email: ODD, code: "123456", password: GOOD_PASSWORD }), { status: 400, data: { ok: false, error: "bad_email" } });
  assert.deepEqual(await call(b, "/api/auth/password/reset", { email: "odd@example.com", code: ODD, password: GOOD_PASSWORD }), { status: 400, data: { ok: false, error: "bad_code" } });

  await startSignup(b);
  await doTerms(b);
  assert.deepEqual(await call(b, "/api/signup/email", { email: ODD, password: GOOD_PASSWORD }), { status: 400, data: { ok: false, error: "bad_email" } });
  assert.deepEqual(await call(b, "/api/signup/email", { email: ["odd2@example.com"], password: GOOD_PASSWORD }), { status: 400, data: { ok: false, error: "bad_email" } }, "an array is not an address either");
  await doEmail(b, box, "odd@example.com", { verify: false });
  assert.deepEqual(await call(b, "/api/signup/email/verify", { email: ODD, code: "123456" }), { status: 400, data: { ok: false, error: "email_mismatch" } });
  assert.deepEqual(await call(b, "/api/signup/email/verify", { code: ODD }), { status: 400, data: { ok: false, error: "bad_code" } });
  assert.deepEqual(await call(b, "/api/signup/email/verify", { code: [123456] }), { status: 400, data: { ok: false, error: "bad_code" } });
  // a code typed as a NUMBER still works, as it always did
  const ok = await call(b, "/api/signup/email/verify", { code: Number(box.codeFor("odd@example.com")) });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);

  const c = browser(env);
  await startSignup(c);
  const loc = await doLocation(c, EMPTY);
  assert.equal(loc.choices.length, 3);
  for (const id of [ODD, ["x"], [], {}, null, true]) assert.deepEqual(await call(c, "/api/signup/location/choice", { id }), { status: 400, data: { ok: false, error: "bad_choice" } }, JSON.stringify(id));
  const picked = await call(c, "/api/signup/location/choice", { id: Number(loc.choices[0].id) });
  assert.equal(picked.status, 200, "an offered place sent as a number is still taken");
  assert.equal(picked.data.community.id, loc.choices[0].id);
});
