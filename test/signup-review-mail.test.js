// Found by the independent review of sign-up v2 (each test fails without its fix):
//  - the old e-mail-code routes still gave about 600 code guesses a day at one address while v2 was on (the 20-a-day cap was only on the new routes)
//  - a burst of refused tries burned the 24-hour counter of an address (20 anonymous requests shut it out for a day)
// Flag off, none of this is counted or created: the old routes answer exactly as before.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, advance, browser, newWorld, realClock, useClock } from "./helpers/world.js";
import { GOOD_PASSWORD, doLocation, doTerms, member, one, outbox, rows, startSignup } from "./helpers/signup.js";
import { limitKey } from "../src/limits.js";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const ip = (n) => `198.51.100.${n}`;
const ALICE = "alice@example.com";
const post = (b, path, body, fetchImpl = box.fetch) => b.send(path, { method: "POST", body, fetchImpl });
const error = async (r) => (await r.json()).error;
const dayCount = async (email) => (await one(env.DB, "SELECT n FROM auth_limits WHERE key = ?", await limitKey(env, "mail", email)))?.n ?? 0;

test("v2: the old sign-in-by-code routes give an attacker at most 100 guesses a day at one address, not 600", async () => {
  env = V2({ EMAIL_MAX_PER_HOUR: "100000" });
  await member(env, box, { via: "email", email: ALICE });
  const attacker = browser(env, { ip: ip(7) });
  let guesses = 0;
  for (let hour = 0; hour < 24; hour++) {
    for (let k = 0; k < 5; k++) {
      advance(61_000);
      await post(attacker, "/api/auth/email/start", { email: ALICE });
      for (let g = 0; g < 5; g++) if (await error(await post(attacker, "/api/auth/email/verify", { email: ALICE, code: String(100000 + guesses) })) === "code_wrong") guesses++;
    }
    advance(3600_000 - 5 * 61_000);
  }
  assert.ok(guesses > 0 && guesses <= 100, `${guesses} guesses reached a live code in 24 hours`);
  assert.equal(await dayCount(ALICE), 20, "20 mails really sent, then the address is closed for the day");
});

test("v2: the old e-mail routes count tries per connection (20 mails and 60 code tries an hour), like the new sign-up routes", async () => {
  const b = browser(env, { ip: ip(11) });
  let last;
  for (let i = 0; i < 21; i++) { advance(1000); last = await post(b, "/api/auth/email/start", { email: `person${i}@example.com` }); }
  assert.deepEqual([last.status, await error(last)], [429, "slow_down"], "the 21st mail asked for by one connection");
  assert.equal((await post(browser(env, { ip: ip(12) }), "/api/auth/email/start", { email: "someone@example.com" })).status, 200, "another connection is not affected");
  let seen;
  const c = browser(env, { ip: ip(13) });
  for (let i = 0; i < 61; i++) seen = await post(c, "/api/auth/email/verify", { email: "nobody@example.com", code: "000000" });
  assert.deepEqual([seen.status, await error(seen)], [429, "slow_down"], "the 61st code tried by one connection");
});

test("flag off: the old e-mail routes count nothing and create nothing (no limits table, no refusal after 25 mails from one connection)", async () => {
  const off = newWorld({ RESEND_API_KEY: "rk-test" });
  const b = browser(off, { ip: ip(14) });
  for (let i = 0; i < 25; i++) { advance(1000); assert.equal((await post(b, "/api/auth/email/start", { email: `p${i}@example.com` })).status, 200, `mail ${i}`); }
  for (let i = 0; i < 70; i++) assert.equal(await error(await post(b, "/api/auth/email/verify", { email: "p1@example.com", code: "000000" })), i < 5 ? "code_wrong" : "too_many", `try ${i}`);
  const names = (await rows(off.DB, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
  assert.ok(!names.includes("auth_limits") && !names.includes("signups"), names.join());
});

test("a burst of refused requests does not use up an address's 24-hour allowance: the owner can still reset and sign up two hours later", async () => {
  const victim = "victim@example.com";
  const attacker = browser(env, { ip: ip(80) });
  const answers = [];
  for (let i = 0; i < 20; i++) answers.push((await post(attacker, "/api/auth/password/reset/start", { email: victim })).status);
  assert.equal(answers.filter((s) => s === 200).length, 1, "one mail went out, the rest were refused");
  assert.equal(await dayCount(victim), 1, "only the mail that was really sent is counted");
  advance(2 * 3600_000);
  const owner = browser(env, { ip: ip(81) });
  assert.equal((await post(owner, "/api/auth/password/reset/start", { email: victim })).status, 200, "password reset");
  await startSignup(owner); await doLocation(owner); await doTerms(owner);
  assert.equal((await post(owner, "/api/signup/email", { email: victim, password: GOOD_PASSWORD })).status, 200, "e-mail sign-up with the same address");
});

test("20 mails really sent to one address in a day close it, whatever they were for (reset, sign-up and sign-in share the allowance)", async () => {
  const target = "busy@example.com", b = browser(env, { ip: ip(82) });
  const kinds = ["/api/auth/password/reset/start", "/api/auth/email/start"];
  let sent = 0;
  for (let hour = 0; hour < 4; hour++) {
    for (let k = 0; k < 5; k++) {
      advance(61_000);
      const r = await post(b, kinds[sent % 2], { email: target });
      assert.equal(r.status, 200, `mail ${sent + 1}: ${JSON.stringify(await r.clone().json())}`);
      sent++;
    }
    advance(3600_000 - 5 * 61_000);
  }
  assert.equal(await dayCount(target), 20);
  const refused = await post(b, "/api/auth/email/start", { email: target });
  assert.deepEqual([refused.status, await error(refused)], [429, "slow_down"]);
  assert.equal(box.sent.filter((m) => m.to === target).length, 10, "20 codes were asked for, 10 of them went out: reset codes for an address with no account are never mailed");
  advance(24 * 3600_000);
  assert.equal((await post(b, "/api/auth/email/start", { email: target })).status, 200, "a day later it opens again");
});

test("a mail that could not be sent does not use up the allowance", async () => {
  box.failing = true;
  for (let i = 0; i < 25; i++) { advance(61_000); assert.equal((await post(browser(env, { ip: ip(100 + i) }), "/api/auth/email/start", { email: "flaky@example.com" })).status, 503, `try ${i}`); }
  assert.equal(await dayCount("flaky@example.com"), 0);
  box.failing = false;
  advance(61_000);
  assert.equal((await post(browser(env, { ip: ip(83) }), "/api/auth/email/start", { email: "flaky@example.com" })).status, 200);
});
