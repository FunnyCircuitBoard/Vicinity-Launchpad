// Location hand-off: a wallet app's browser can't share GPS, so the phone's normal browser does it and the
// wallet app collects the result. The same location checks run; the coordinates are never stored.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EMPTY, IN_NYC, IN_UTICA, ORIGIN, browser, newWorld, person, realClock, useClock } from "./helpers/world.js";
import { handleHandoffComplete, handleHandoffStart } from "../src/handoff.js";

let env;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = newWorld(); });
after(() => realClock());

const start = (p, purpose = "home") => p.post("/api/locate/handoff", { purpose });
const codeOf = (url) => new URL(url).searchParams.get("code");
const req = (path, body) => new Request(ORIGIN + path, { method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify(body) });

test("hand-off: the phone's browser shares GPS, the wallet app collects a normal attestation and sets the home", async () => {
  const wallet = await person(env);             // signed in inside the wallet app's browser
  const phone = browser(env);                   // the phone's Safari / Chrome: no login at all
  const s = await start(wallet, "home");
  assert.equal(s.ok, true);
  assert.match(s.url, /^https:\/\/vicinity\.test\/locate\?code=[A-Za-z0-9_-]{16,}$/);
  const code = codeOf(s.url);

  assert.deepEqual(await wallet.post("/api/locate/handoff/claim", { code }), { ok: false, status: "waiting" });
  const info = await phone.post("/api/locate/handoff/info", { code });
  assert.equal(info.purpose, "home");

  const done = await phone.post("/api/locate/handoff/complete", { code, location: IN_UTICA, country: "US" });
  assert.deepEqual(done, { ok: true, city: "Utica", nearby: null });
  assert.equal(JSON.stringify(done).includes("43.1"), false, "no coordinates come back");

  const got = await wallet.post("/api/locate/handoff/claim", { code });
  assert.equal(got.ok, true);
  assert.equal(got.city.name, "Utica");
  const home = await wallet.post("/api/home", { attestation: got.attestation });
  assert.equal(home.ok, true);
  assert.equal(home.home.name, "Utica");

  assert.equal((await wallet.post("/api/locate/handoff/claim", { code })).status, "expired", "claimed once, then gone");
  const rows = await env.DB.prepare("SELECT * FROM handoffs").all();
  assert.equal(rows.results.length, 0, "nothing is kept");
});

test("hand-off: in empty land the wallet app gets the three nearest to choose from", async () => {
  const wallet = await person(env);
  const code = codeOf((await start(wallet)).url);
  const done = await browser(env).post("/api/locate/handoff/complete", { code, location: EMPTY, country: "US" });
  assert.equal(done.city, null);
  assert.equal(done.nearby.length, 3);
  const got = await wallet.post("/api/locate/handoff/claim", { code });
  assert.equal(got.nearby.length, 3);
  assert.equal((await wallet.post("/api/home", { attestation: got.attestation, choice: got.nearby[0].id })).ok, true);
});

test("hand-off safety: only the account that asked can collect, the link works once, and it expires", async () => {
  const a = await person(env), b = await person(env), phone = browser(env);
  assert.equal((await browser(env).post("/api/locate/handoff", { purpose: "home" })).error, "sign_in");
  assert.equal((await start(a, "teleport")).error, "bad_request");
  const code = codeOf((await start(a)).url);

  assert.equal((await phone.post("/api/locate/handoff/complete", { code, location: IN_UTICA, country: "US" })).ok, true);
  assert.equal((await phone.post("/api/locate/handoff/complete", { code, location: IN_NYC, country: "US" })).error, "already_done");
  assert.equal((await b.post("/api/locate/handoff/claim", { code })).status, "expired", "another account can't take it");
  assert.equal((await browser(env).post("/api/locate/handoff/claim", { code })).error, "sign_in");
  assert.equal((await a.post("/api/locate/handoff/claim", { code })).ok, true);

  const late = codeOf((await start(a)).url);
  useClock("2026-10-01T12:11:00Z");
  assert.equal((await phone.post("/api/locate/handoff/info", { code: late })).error, "expired");
  assert.equal((await phone.post("/api/locate/handoff/complete", { code: late, location: IN_UTICA, country: "US" })).error, "expired");
  assert.equal((await phone.post("/api/locate/handoff/info", { code: "x" })).error, "expired");
});

test("hand-off safety: the same risk checks as /api/locate, one generic answer, and the same connection", async () => {
  const a = await person(env), phone = browser(env);
  const code = codeOf((await start(a)).url);
  const bad = await phone.post("/api/locate/handoff/complete", { code, location: { ...IN_UTICA, accuracy: 50_000 }, country: "US" });
  assert.equal(bad.error, "location_unverified");
  assert.equal((await a.post("/api/locate/handoff/claim", { code })).status, "waiting", "a failed try leaves it open");

  // On Cloudflare: the phone's browser must be on the same network as the wallet app that asked
  const cf = (country, asn, lat = 43.1, lon = -75.2) => ({ country, asn, latitude: lat, longitude: lon, asOrganization: "Verizon" });
  // handleHandoffStart reads the session cookie, so build its request from the signed-in browser's cookies
  const withCookies = (path, body) => new Request(ORIGIN + path, { method: "POST", headers: { origin: ORIGIN, cookie: [...a.jar].map(([k, v]) => `${k}=${v}`).join("; ") }, body: JSON.stringify(body) });
  const started = await (await handleHandoffStart(withCookies("/api/locate/handoff", { purpose: "home" }), env, Date.now(), cf("US", 701))).json();
  const code2 = codeOf(started.url);
  const friend = await (await handleHandoffComplete(req("/api/locate/handoff/complete", { code: code2, location: IN_UTICA }), env, Date.now(), cf("US", 7922))).json();
  assert.equal(friend.error, "location_unverified", "a different network operator can't answer for you");
  const mine = await (await handleHandoffComplete(req("/api/locate/handoff/complete", { code: code2, location: IN_UTICA }), env, Date.now(), cf("US", 701))).json();
  assert.equal(mine.ok, true);
});
