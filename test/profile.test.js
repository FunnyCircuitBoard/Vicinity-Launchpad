// Profile: username changes, contact e-mail verification, phone number.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/index.js";
import { IN_UTICA, advance, browser, newWorld, person, realClock, reprove, useClock } from "./helpers/world.js";

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

test("username: names that pass for the project or its staff are refused, whatever the casing or look-alike letters", async () => {
  const a = await person(env);
  for (const bad of ["Admin", "vicinity", "Vicinity_Official", "V1c1n1ty", "VICINITY", "TeamVicinity", "Team_Vicinity", "MyVicinity", "admin_", "Administrator1",
    "Moderator", "M0derator", "Support", "SupportTeam", "Official", "TheOfficial", "Staff", "Owner", "System", "Security", "Mod", "MODS", "Help", "Founder", "r00t", "Root"]) {
    const r = await a.post("/api/me/username", { username: bad });
    assert.equal(r.error, "username_reserved", bad);
  }
  assert.notEqual((await a.get("/api/me")).user.handle, "Admin");
  // ordinary names that merely contain or start like those are fine
  for (const ok of ["Modest77", "Helpful77", "Rootsy77"]) assert.equal((await a.post("/api/me/username", { username: ok })).ok, true, ok);
});

test("username: a look-alike of someone else's name is refused; existing members keep what they have", async () => {
  const a = await person(env), b = await person(env);
  assert.equal((await a.post("/api/me/username", { username: "Alice77" })).ok, true);
  for (const bad of ["AIice77", "A1ice77", "Al_ice77", "alice_77", "Aliice77"]) assert.equal((await b.post("/api/me/username", { username: bad })).error, "username_taken", bad);
  // your own look-alike is yours to take
  assert.equal((await a.post("/api/me/username", { username: "AIice77" })).ok, true);

  // someone who already has a staff-like name (set before the rule existed) keeps it
  await env.DB.prepare("UPDATE users SET handle = 'Admin_Old' WHERE wallet = ?").bind(b.w.address).run();
  assert.equal((await b.post("/api/me/username", { username: "admin_old" })).ok, true);
  assert.equal((await b.get("/api/me?lite=1")).user.handle, "Admin_Old");
});

test("username: three changes a day, then slow_down; refused names do not count; it frees up a day later", async () => {
  const a = await person(env);
  assert.equal((await a.post("/api/me/username", { username: "Admin" })).error, "username_reserved");
  assert.equal((await a.post("/api/me/username", { username: "FirstName1" })).ok, true);
  assert.equal((await a.post("/api/me/username", { username: "SecondName2" })).ok, true);
  assert.equal((await a.post("/api/me/username", { username: "SecondName2" })).ok, true, "keeping the current name is not a change");
  assert.equal((await a.post("/api/me/username", { username: "ThirdName3" })).ok, true);
  const r = await a.send("/api/me/username", { method: "POST", body: { username: "FourthName4" } });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, "slow_down");
  assert.equal((await a.get("/api/me?lite=1")).user.handle, "ThirdName3");
  // another person is not affected
  assert.equal((await (await person(env)).post("/api/me/username", { username: "FourthName4" })).ok, true);
  advance(25 * 3600_000);
  await reprove(a);
  assert.equal((await a.post("/api/me/username", { username: "FourthName4x" })).ok, true);
});

test("contact e-mail: it can be removed (and only by its owner, from this site)", async () => {
  const a = await person(env), b = await person(env);
  await startCode(a, "me@example.com");
  assert.equal((await a.post("/api/me/contact/email/verify", { email: "me@example.com", code: sentCodes[sentCodes.length - 1].code })).ok, true);
  await b.post("/api/me/phone", { phone: "+1 555 123 4567" });
  assert.equal((await a.get("/api/me?lite=1")).user.contact_email, "me@example.com");

  assert.equal((await browser(env).post("/api/me/contact/email/remove")).error, "sign_in");
  // a request from another site is refused, even with the right cookie
  const foreign = await handleApi(new Request("https://vicinity.test/api/me/contact/email/remove", { method: "POST",
    headers: { origin: "https://evil.example", cookie: [...a.jar].map(([k, v]) => `${k}=${v}`).join("; ") } }), env);
  assert.equal(foreign.status, 403);
  assert.equal((await a.get("/api/me?lite=1")).user.contact_email, "me@example.com", "still there");

  const r = await a.post("/api/me/contact/email/remove");
  assert.equal(r.ok, true);
  assert.equal(r.email, null);
  assert.equal((await a.get("/api/me?lite=1")).user.contact_email, null);
  const row = await env.DB.prepare("SELECT contact_email, phone FROM users WHERE wallet = ?").bind(a.w.address).first();
  assert.equal(row.contact_email, null);
  // removing it again is harmless, and it did not touch anybody else's data
  assert.equal((await a.post("/api/me/contact/email/remove")).ok, true);
  assert.equal((await b.get("/api/me?lite=1")).user.phone, "+1 555 123 4567");
  // GET is not accepted
  assert.equal((await a.send("/api/me/contact/email/remove")).status, 405);
});

test("phone: clearing it really empties the column", async () => {
  const a = await person(env);
  await a.post("/api/me/phone", { phone: "+15551234567" });
  assert.equal((await env.DB.prepare("SELECT phone FROM users WHERE wallet = ?").bind(a.w.address).first()).phone, "+15551234567");
  assert.equal((await a.post("/api/me/phone", { phone: "" })).ok, true);
  assert.equal((await env.DB.prepare("SELECT phone FROM users WHERE wallet = ?").bind(a.w.address).first()).phone, null);
  assert.equal((await a.get("/api/me?lite=1")).user.phone, null);
});

test("public member counts do not include test-lab accounts", async () => {
  const a = await person(env, { home: IN_UTICA });
  const seed = (i, city) => env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, handle, name, home_city, home_name, home_country, created_at) VALUES (?, 'testlab', ?, ?, ?, ?, ?, 'XX', ?)")
    .bind(`TestLab${i}`.padEnd(32, "1"), `seed-${i}`, `@testlab${i}`, `Test Lab ${i}`, city, city === "5142056" ? "Utica" : "Testville", new Date().toISOString()).run();
  await seed(0, "5142056"); await seed(1, "5142056"); await seed(2, "testlab-nyc");
  const m = await browser(env).get("/api/members");
  assert.equal(m.members, 1);
  assert.deepEqual(m.communities.map((c) => [c.id, c.members]), [["5142056", 1]]);
  const me = await a.get("/api/me");
  assert.equal(me.community.members, 1);
  assert.equal(me.national.members, 1);
});
