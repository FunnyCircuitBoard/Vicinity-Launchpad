// The switch: with SIGNUP_FLOW unset (or anything but "v2") the new sign-up is simply not there and the site behaves exactly as
// it always has. These tests are the "dark launch" guarantee: no new routes, no new keys, no new tables.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN, browser, loginBody, newWorld, person, realClock, useClock, V2, wallet, tick } from "./helpers/world.js";
import { outbox, tablesAndColumns } from "./helpers/signup.js";
import { verificationEmail } from "../src/mail.js";

beforeEach(() => useClock("2026-10-01T12:00:00Z"));
after(() => realClock());

const OFF = [undefined, "", "v1", "V1", "off", "v2x", " v 2", "true"];
const NEW_ROUTES = [
  ["POST", "/api/auth/email/login"], ["POST", "/api/auth/password/reset/start"], ["POST", "/api/auth/password/reset"], ["POST", "/api/me/password"],
  ["POST", "/api/signup/start"], ["GET", "/api/signup/state"], ["POST", "/api/signup/location"], ["POST", "/api/signup/location/choice"],
  ["POST", "/api/signup/location/handoff"], ["POST", "/api/signup/location/handoff/claim"], ["POST", "/api/signup/terms"],
  ["POST", "/api/signup/email"], ["POST", "/api/signup/email/verify"], ["POST", "/api/signup/account/reset"], ["POST", "/api/signup/finish"],
  ["GET", "/api/signup/nothing-here"], ["GET", "/api/signup/"],
];

test("flag off (unset, empty, v1, typos): every new route answers 404 not_enabled, even with the wrong method", async () => {
  for (const flag of OFF) {
    const env = newWorld(flag === undefined ? {} : { SIGNUP_FLOW: flag });
    const b = browser(env);
    for (const [method, path] of NEW_ROUTES) {
      for (const m of [method, method === "GET" ? "POST" : "GET", "DELETE"]) {
        const r = await b.send(path, { method: m, body: m === "POST" ? {} : undefined });
        assert.equal(r.status, 404, `${flag} ${m} ${path}`);
        assert.deepEqual(await r.json(), { ok: false, error: "not_enabled" }, `${flag} ${m} ${path}`);
      }
    }
  }
});

test("flag off: a new wallet still gets next 'social', and Google's ?signup=1 is ignored", async () => {
  const env = newWorld();
  const b = browser(env);
  const w = await wallet();
  assert.equal((await b.post("/api/auth/wallet", await loginBody(w))).next, "social");

  // no sign-up, no Terms: ?signup=1 does nothing special, the redirect and the cookie are today's
  const fresh = browser(env);
  const start = await fresh.send("/api/auth/google/start?signup=1");
  assert.match(start.headers.get("location"), /^https:\/\/accounts\.google\.com\//);
  const vo = decodeURIComponent(start.headers.getSetCookie().find((c) => c.startsWith("vo=")).split(";")[0].slice(3));
  assert.equal(vo.split(".").length, 3, "no signup marker in the OAuth cookie: " + vo.replace(/[^.]/g, ""));
});

test("flag off: /api/me has no new key in any of its four shapes, and no hasPassword", async () => {
  const env = newWorld();
  const out = browser(env);
  const me1 = await out.get("/api/me");
  assert.deepEqual(Object.keys(me1), ["signedIn", "providers"]);

  const pending = browser(env);
  await pending.post("/api/auth/wallet", await loginBody(await wallet()));
  assert.deepEqual(Object.keys(await pending.get("/api/me")), ["signedIn", "providers", "pending", "proof"]);

  const p = await person(env);
  const lite = await p.get("/api/me?lite=1");
  assert.deepEqual(Object.keys(lite), ["signedIn", "user", "providers", "fresh"]);
  assert.ok(!("hasPassword" in lite.user));
  const full = await p.get("/api/me");
  assert.ok(!("signupFlow" in full) && !("hasPassword" in full.user), "the full answer has no new key");
  for (const b of [out, pending, p]) assert.ok(!JSON.stringify(await b.get("/api/me")).includes("signupFlow"));
});

test("flag off: a whole v1 journey (wallet, Google, an e-mail account, a hand-off) leaves the database without any new object", async () => {
  const env = newWorld({ RESEND_API_KEY: "rk-test" });
  const p = await person(env, { home: { lat: 43.1, lon: -75.23, accuracy: 30 } });
  const box = outbox();
  // an e-mail account the old way
  const b = browser(env);
  await b.post("/api/auth/wallet", await loginBody(await wallet()));
  await b.send("/api/auth/email/start", { method: "POST", body: { email: "old@example.com" }, fetchImpl: box.fetch });
  const v = await (await b.send("/api/auth/email/verify", { method: "POST", body: { email: "old@example.com", code: box.codeFor("old@example.com") }, fetchImpl: box.fetch })).json();
  assert.equal(v.isNew, true, "today's flow still creates the account on the e-mail code");
  // a hand-off and a run of the scheduled job
  const s = await p.post("/api/locate/handoff", { purpose: "home" });
  assert.equal(s.ok, true);
  await tick(env);
  await tick(env, { sample: false });

  const all = await tablesAndColumns(env.DB);
  assert.ok(!all.tables.includes("signups") && !all.tables.includes("auth_limits"), "no new tables: " + all.tables.join());
  assert.ok(!all.columns.users.includes("password_hash"), "users has no password_hash");
  assert.ok(!all.columns.handoffs.includes("signup_id"), "handoffs has no signup_id");
  const ids = (await env.DB.prepare("SELECT id FROM schema_migrations").all()).results.map((r) => r.id);
  assert.ok(!ids.some((id) => /signup/.test(id)));
});

test("flag off: the scheduled job answers as before and does not mind that the sign-up tables do not exist", async () => {
  const env = newWorld();
  const out = await tick(env);
  assert.deepEqual(Object.keys(out), ["sample", "seats", "elections", "moderation", "snapshot", "cleanup"]);
  assert.deepEqual(out.cleanup, { ok: true });
  assert.ok(!(await tablesAndColumns(env.DB)).tables.includes("signups"));
});

test("flag off: the code e-mail is the one it has always been (sign-in wording), for any caller", () => {
  const code = "123456";
  assert.deepEqual(verificationEmail(code), verificationEmail(code, "signin"));
  const v1 = verificationEmail(code);
  assert.equal(v1.subject, "123456 is your Vicinity code");
  assert.match(v1.text, /^Your Vicinity sign-in code is 123456\./);
  assert.ok(v1.html.includes("Your sign-in code") && v1.html.includes("to finish signing in."));
  // the other kinds change only the wording, never the subject
  for (const kind of ["signup", "reset"]) {
    const m = verificationEmail(code, kind);
    assert.equal(m.subject, v1.subject);
    assert.ok(!m.text.includes("sign-in code"), kind);
  }
});

test("SIGNUP_FLOW is read from the environment on every request, trimmed and in any letter case", async () => {
  const env = V2({ SIGNUP_FLOW: " V2 " });
  const b = browser(env);
  const r = await b.send("/api/signup/start", { method: "POST", body: {} });
  assert.equal(r.status, 200);
  assert.equal((await b.get("/api/me")).signupFlow, "v2");
  env.SIGNUP_FLOW = "v1"; // flipped back in the dashboard: the very next request is dark again
  assert.equal((await b.send("/api/signup/state")).status, 404);
  assert.equal((await b.get("/api/me")).signupFlow, undefined);
  env.SIGNUP_FLOW = "v2";
  assert.equal((await b.send("/api/signup/state")).status, 200);
});

test("the 4 password routes are wired with the switch on: an empty call gets each route's own plain refusal (the real tests are in pwlogin.test.js)", async () => {
  const env = V2();
  const b = browser(env);
  const refusals = { "/api/auth/email/login": [401, "bad_credentials"], "/api/auth/password/reset/start": [400, "bad_email"], "/api/auth/password/reset": [400, "bad_email"], "/api/me/password": [401, "sign_in"] };
  for (const [path, [status, error]] of Object.entries(refusals)) {
    const r = await b.send(path, { method: "POST", body: {} });
    assert.equal(r.status, status, path);
    assert.deepEqual(await r.json(), { ok: false, error });
  }
});

test("the origin of the page is never needed for GET, and a POST from elsewhere is refused before anything else (switch on)", async () => {
  const env = V2();
  const b = browser(env);
  assert.equal((await b.send("/api/signup/state", { origin: null })).status, 200);
  for (const origin of [null, "https://evil.example", ORIGIN.replace("https", "http") + ".evil"]) {
    const r = await b.send("/api/signup/start", { method: "POST", body: {}, origin });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, "wrong_origin");
  }
});
