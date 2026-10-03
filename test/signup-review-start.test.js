// Found by the independent review of sign-up v2 (each test fails without its fix): refused tries from ONE connection still counted
// on the site-wide start counter, so one script could close sign-up for every new visitor; and the site-wide ceiling could not be
// raised for a launch-day crowd without a deploy.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, browser, realClock, useClock } from "./helpers/world.js";
import { one } from "./helpers/signup.js";

let env;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); });
after(() => realClock());

const ip = (n) => `198.51.100.${n}`;

test("refused tries from one connection do not count on the site-wide sign-up allowance", async () => {
  const site = async () => (await one(env.DB, "SELECT n FROM auth_limits WHERE key = 'sus:site'"))?.n ?? 0;
  for (let i = 0; i < 60; i++) await browser(env, { ip: ip(90) }).send("/api/signup/start", { method: "POST", body: {} });
  assert.equal(await site(), 20, "60 tries from one connection: 20 got through, 40 were refused and counted nowhere else");
});

test("one connection cannot close sign-up for everybody: after its tries are refused, a real person still gets in", async () => {
  for (let i = 0; i < 5000; i++) await browser(env, { ip: ip(91) }).send("/api/signup/start", { method: "POST", body: {} }); // one script, no cookies kept
  const person = await browser(env, { ip: "203.0.113.5" }).send("/api/signup/start", { method: "POST", body: {} });
  assert.equal(person.status, 200, JSON.stringify(await person.json()));
});

test("the site-wide ceiling on new sign-ups can be raised without a deploy (SIGNUP_MAX_PER_HOUR); nonsense falls back to 5,000", async () => {
  const starts = async (e, n) => { const out = []; for (let i = 0; i < n; i++) out.push((await browser(e, { ip: `203.0.113.${i + 1}` }).send("/api/signup/start", { method: "POST", body: {} })).status); return out; };
  assert.deepEqual(await starts(V2({ SIGNUP_MAX_PER_HOUR: "3" }), 5), [200, 200, 200, 429, 429]);
  assert.deepEqual(await starts(V2({ SIGNUP_MAX_PER_HOUR: "100" }), 5), [200, 200, 200, 200, 200]);
  for (const bad of ["", "abc", "0", "-5"]) assert.deepEqual(await starts(V2({ SIGNUP_MAX_PER_HOUR: bad }), 3), [200, 200, 200], `"${bad}" means the default`);
  const e = V2();
  await browser(e, { ip: ip(95) }).send("/api/signup/start", { method: "POST", body: {} });
  await e.DB.prepare("UPDATE auth_limits SET n = 5000 WHERE key = 'sus:site'").run();
  assert.equal((await browser(e, { ip: ip(96) }).send("/api/signup/start", { method: "POST", body: {} })).status, 429, "the default ceiling is still 5,000");
});

