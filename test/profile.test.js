// Profile: username changes, contact e-mail verification, phone number.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { newWorld, person, realClock, useClock } from "./helpers/world.js";

let env;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = newWorld({ RESEND_API_KEY: "rk-test" }); });
after(() => realClock());

// Resend stand-in: captures the code out of the e-mail text.
const sentCodes = [];
const resendFetch = () => async (url, init) => {
  const body = JSON.parse(init.body);
  const code = body.text.match(/code is (\d{6})/)[1];
  sentCodes.push({ to: body.to[0], code });
  return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
};
const startCode = (p, email) => p.send("/api/auth/email/start", { method: "POST", body: { email }, fetchImpl: resendFetch() });

test("username: change it, uniqueness is case-insensitive and first-come-first-served", async () => {
  const a = await person(env);
  const r = await a.post("/api/me/username", { username: "BrightBeacon77" });
  assert.equal(r.ok, true);
  assert.equal(r.username, "BrightBeacon77");
  const row = await env.DB.prepare("SELECT handle FROM users WHERE wallet = ?").bind(a.w.address).first();
  assert.equal(row.handle, "BrightBeacon77");
  // ...and /api/me shows it right away
  assert.equal((await a.get("/api/me")).user.handle, "BrightBeacon77");

  const b = await person(env);
  assert.equal((await b.post("/api/me/username", { username: "brightbeacon77" })).error, "username_taken");
  assert.equal((await b.post("/api/me/username", { username: "BRIGHTBEACON77" })).error, "username_taken");

  // keeping your own (even recased) is a no-op, not an error
  assert.equal((await a.post("/api/me/username", { username: "brightbeacon77" })).ok, true);
});

test("username: bad formats rejected, anonymous rejected", async () => {
  const a = await person(env);
  for (const bad of ["ab", "1abc", "_abc", "a".repeat(21), "has space", "dots.bad", "", "éclair"]) {
    assert.equal((await a.post("/api/me/username", { username: bad })).error, "bad_username", bad);
  }
  const { browser } = await import("./helpers/world.js");
  assert.equal((await browser(env).post("/api/me/username", { username: "ValidName1" })).error, "sign_in");
});

test("contact e-mail: verify a code → stored on the account", async () => {
  const a = await person(env);
  await startCode(a, "me@example.com");
  assert.equal(sentCodes.length, 1);
  const r = await a.post("/api/me/contact/email/verify", { email: "me@example.com", code: sentCodes[0].code });
  assert.equal(r.ok, true);
  assert.equal(r.email, "me@example.com");
  assert.equal((await a.get("/api/me")).user.contact_email, "me@example.com");

  // wrong code burns an attempt, garbage is rejected
  await startCode(a, "other@example.com");
  assert.equal((await a.post("/api/me/contact/email/verify", { email: "other@example.com", code: "000000" })).error, "code_wrong");
  assert.equal((await a.post("/api/me/contact/email/verify", { email: "other@example.com", code: "12" })).error, "bad_code");
});

test("contact e-mail: cannot take someone else's sign-in e-mail", async () => {
  const a = await person(env);
  await env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (?, 'email', ?, 'TakenLogin1', ?) ")
    .bind("11111111111111111111111111111111", "taken@example.com", new Date(Date.now()).toISOString()).run();
  await startCode(a, "taken@example.com");
  const code = sentCodes[sentCodes.length - 1].code;
  assert.equal((await a.post("/api/me/contact/email/verify", { email: "taken@example.com", code })).error, "email_taken");
});

test("phone: set, clear, and bad formats", async () => {
  const a = await person(env);
  assert.equal((await a.post("/api/me/phone", { phone: "+1 (555) 123-4567" })).ok, true);
  assert.equal((await a.get("/api/me")).user.phone, "+1 (555) 123-4567");
  assert.equal((await a.post("/api/me/phone", { phone: "" })).phone, null);
  for (const bad of ["12", "not-a-phone", "+12345678901234567890123"]) {
    assert.equal((await a.post("/api/me/phone", { phone: bad })).error, "bad_phone", bad);
  }
  const { browser } = await import("./helpers/world.js");
  assert.equal((await browser(env).post("/api/me/phone", { phone: "+15551234567" })).error, "sign_in");
});
