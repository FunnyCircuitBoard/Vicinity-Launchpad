// Stages S03 and S04, review fixes (Citycoin.dev master v5; src/hostbind.js, src/hostroute.js, src/index.js, src/http.js sameSite, src/store.js
// ensureHostSchema). Each test names the review finding it pins. With SITE_ORIGIN, SITE_ORIGINS and HOST_REDIRECT unset, every host that
// reaches the Worker today answers exactly as before (test/host-redirect.test.js and test/host-binding.test.js compare the whole matrix);
// the one deliberate unset change is that the cutover's own hosts (citycoin.dev and www.citycoin.dev, not attached today) are refused
// instead of served unbound. citycoin.dev is not attached to the Worker; no request here leaves this process.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import worker, { handleApi, withSecurityHeaders } from "../src/index.js";
import * as W from "./helpers/world.js";
import { journey, one, outbox, rows } from "./helpers/signup.js";
import { base58Encode, buildMessage, statementFor } from "../src/solana.js";
import { hostBound, servedHost, sessionDelete, signupDelete } from "../src/hostbind.js";
import { CUTOVER_HOSTS, localDevAllowed, siteConfig } from "../src/site-config.js";
import { HOST_MIGRATIONS } from "../src/store.js";
import { SECURITY_HEADERS, sameSite, sha256 } from "../src/http.js";
import { AUTH_TRIP, SIGN_OUT_PATH, hostAnswer, wrongHost } from "../src/hostroute.js";
import { _pagesBuiltForTests } from "../src/v5policy.js";
import { MASTER_POLICY } from "../src/masterpolicy.js";
import { pageRouting } from "../scripts/pages/build.mjs";

beforeEach(() => W.useClock("2026-10-20T12:00:00Z"));
after(() => W.realClock());

const VC = "https://vicinity.city", CC = "https://citycoin.dev";
/** S06: citycoin.dev attached and listed, vicinity.city still canonical, HOST_REDIRECT off (domain-cutover.md section 3). */
const S06 = Object.freeze({ SITE_ORIGINS: "https://citycoin.dev https://vicinity.city" });
/** S55: citycoin.dev canonical. */
const S55 = Object.freeze({ SITE_ORIGIN: "https://citycoin.dev", SITE_ORIGINS: "https://citycoin.dev https://vicinity.city", DEPLOYMENT_ENV: "production" });
const ctx = { waitUntil() {}, passThroughOnException() {} };

function at(env, origin, { jar = new Map(), from = origin, ip } = {}) {
  const send = async (path, { method = "GET", body, entry = false, fetchImpl = W.chain() } = {}) => {
    const headers = new Headers();
    if (from) headers.set("origin", from);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (ip) headers.set("cf-connecting-ip", ip);
    const request = new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = entry ? await worker.fetch(request, env, ctx) : await handleApi(request, env, fetchImpl, null);
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split("; "); const i = pair.indexOf("="); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return res;
  };
  return { env, jar, send, get: async (p) => (await send(p)).json(), post: async (p, body = {}) => (await send(p, { method: "POST", body })).json() };
}
async function signedFor(w, host, statement = statementFor("login")) {
  const nonce = base58Encode(crypto.getRandomValues(new Uint8Array(16)));
  const message = buildMessage({ host, address: w.address, nonce, issuedAt: new Date(Date.now()).toISOString(), statement });
  return { address: w.address, message, signature: await w.sign(message) };
}
/** A member made before the settings changed (today's rows: host NULL). */
async function oldMember(env) {
  const saved = { ...env };
  for (const k of ["SITE_ORIGIN", "SITE_ORIGINS", "HOST_REDIRECT", "DEPLOYMENT_ENV"]) delete env[k];
  try { return await W.person(env, { home: W.IN_UTICA }); } finally { Object.assign(env, saved); }
}
const signedIn = async (b) => (await b.get("/api/me?lite=1")).signedIn;
const sessionCount = async (env) => (await one(env.DB, "SELECT COUNT(*) AS n FROM sessions")).n;
/** A D1 whose statements matching `re` fail (a lost connection), while `state.fail` holds. */
function failing(db, re, state) {
  return new Proxy(db, { get(t, k) {
    if (k === "prepare") return (sql) => (state.fail && re.test(sql) ? { bind() { return this; }, run: async () => { throw new Error("D1_ERROR: Network connection lost."); } } : t.prepare(sql));
    const v = t[k];
    return typeof v === "function" ? v.bind(t) : v;
  } });
}

/* ---------------------------------------------------------------- R2H-02: a copied cookie never ends the original */

test("R2H-02: a vicinity.city cookie copied to citycoin.dev signs out, or signs in, there without deleting the vicinity.city session", async () => {
  const env = W.newWorld({ ...S06 });
  const p = await oldMember(env);
  const vc = at(env, VC, { jar: new Map(p.jar) });
  assert.equal(await signedIn(vc), true);
  // logout on citycoin.dev with the copied cookie: the browser's citycoin.dev cookie is cleared, the vicinity.city row is untouched
  const n = await sessionCount(env);
  const lo = await at(env, CC, { jar: new Map(p.jar) }).send("/api/auth/logout", { method: "POST", body: {} });
  assert.equal(lo.status, 200);
  assert.match(lo.headers.getSetCookie()[0], /^vs=; .*Max-Age=0$/);
  assert.equal(await sessionCount(env), n, "nothing of vicinity.city's was deleted");
  assert.equal(await signedIn(vc), true, "still signed in on vicinity.city");
  // a wallet sign-in on citycoin.dev (it ends this browser's current session first) with the copied cookie: the old row stays too
  const other = await W.wallet();
  const signIn = await at(env, CC, { jar: new Map(p.jar) }).send("/api/auth/wallet", { method: "POST", body: await signedFor(other, "citycoin.dev") });
  assert.equal(signIn.status, 200);
  assert.equal(await signedIn(vc), true);
  // on its own host the logout ends it, as always
  assert.equal((await vc.send("/api/auth/logout", { method: "POST", body: {} })).status, 200);
  assert.equal(await signedIn(at(env, VC, { jar: new Map(p.jar) })), false);
});

test("R2H-02: a copied sign-up cookie (vsu) ends nothing on the host that made it; the scoped deletes are today's statements while unbound", async () => {
  const env = W.V2({ ...S06 });
  const box = outbox();
  // a sign-up started on citycoin.dev
  const s = at(env, CC);
  assert.equal((await s.post("/api/signup/start")).ok, true);
  assert.equal((await one(env.DB, "SELECT host FROM signups")).host, "citycoin.dev");
  // a member signs in on vicinity.city with a password, carrying the citycoin.dev vsu cookie by hand: endSignup clears it and deletes nothing
  const m = at(env, CC);
  const j = await journey(m, box, { via: "email" });
  assert.equal(j.finish.ok, true, JSON.stringify(j.finish));
  const vc = at(env, VC, { jar: new Map([["vsu", s.jar.get("vsu")]]) });
  const login = await vc.send("/api/auth/email/login", { method: "POST", body: { email: j.email, password: "correct horse battery staple" } });
  assert.equal(login.status, 200, JSON.stringify(await login.clone().json()));
  assert.ok(login.headers.getSetCookie().some((c) => /^vsu=; .*Max-Age=0$/.test(c)), "the copied cookie is cleared on vicinity.city");
  assert.notEqual(await one(env.DB, "SELECT id FROM signups WHERE id = ? AND host = 'citycoin.dev'", await sha256(decodeURIComponent(s.jar.get("vsu")))), null, "citycoin.dev's sign-up is still there");
  assert.equal((await s.post("/api/signup/terms", { version: "2026-10-01" })).ok, true, "and goes on there");
  // the statements: unbound, exactly today's text; bound, scoped to the host (NULL is vicinity.city); refused, nothing
  const db = { prepare: (sql) => ({ sql, bind: (...a) => ({ sql, a }) }) };
  assert.deepEqual(sessionDelete(db, "h", servedHost({}, new Request(`${VC}/`))), { sql: "DELETE FROM sessions WHERE id = ?", a: ["h"] });
  assert.deepEqual(signupDelete(db, "h", servedHost({}, new Request(`${VC}/`))).map((x) => x.sql), ["DELETE FROM handoffs WHERE signup_id = ?", "DELETE FROM signups WHERE id = ?"]);
  assert.deepEqual(sessionDelete(db, "h", servedHost(S06, new Request(`${VC}/`))).a, ["h", "vicinity.city", "vicinity.city"]);
  assert.deepEqual(sessionDelete(db, "h", servedHost(S06, new Request(`${CC}/`))).a, ["h", "vicinity.city", "citycoin.dev"]);
  assert.equal(sessionDelete(db, "h", servedHost(S06, new Request("https://evil.example/"))), null);
  assert.deepEqual(signupDelete(db, "h", servedHost(S06, new Request("https://evil.example/"))), []);
});

/* ---------------------------------------------------------------- R2H-03, SEC-3: refused before the 301 */

test("R2H-03, SEC-3: while bound, plain http to a host outside the allowlist is refused before the 301 (no Location from the Host header)", async () => {
  for (const sites of [S06, S55]) {
    const env = W.newWorld({ ...sites });
    for (const url of ["http://evil.example/api/health", "http://evil.example/coin-meta/x.json", "http://citycoin.dev./api/me", "http://www.citycoin.dev/api/me",
      "http://citycoin.dev.evil.example/", "http://vicinity.test/api/health"]) {
      for (const method of ["GET", "POST"]) {
        const r = await worker.fetch(new Request(url, { method, body: method === "POST" ? "{}" : undefined }), env, ctx);
        assert.deepEqual([r.status, r.headers.get("location")], [421, null], `${method} ${url}`);
      }
    }
    // an accepted host over http: today's 301 to https, on the allowlist entry (the same name, lower case, no port)
    for (const [url, to] of [["http://citycoin.dev/api/health?a=1", "https://citycoin.dev/api/health?a=1"], ["http://VICINITY.CITY:8080/api/me", "https://vicinity.city/api/me"],
      ["http://www.vicinity.city/api/me", "https://vicinity.city/api/me"]]) {
      const r = await worker.fetch(new Request(url), env, ctx);
      assert.deepEqual([r.status, r.headers.get("location")], [301, to], url);
    }
  }
  // unset: today's 301 for every host that reaches the Worker, built as always (the cutover's own hosts aside: refused)
  const env = W.newWorld();
  for (const [url, to] of [["http://evil.example/api/health", "https://evil.example/api/health"], ["http://vicinity.city/x?y=1", "https://vicinity.city/x?y=1"],
    ["http://vicinitycity.net/api/me", "https://vicinity.city/api/me"]]) {
    const r = await worker.fetch(new Request(url), env, ctx);
    assert.deepEqual([r.status, r.headers.get("location")], [301, to], url);
  }
  assert.equal((await worker.fetch(new Request("http://citycoin.dev/api/health"), env, ctx)).status, 421);
});

/* ---------------------------------------------------------------- R2H-04: sign-out in place under HOST_REDIRECT */

test("R2H-04, SEC-5: under HOST_REDIRECT, sign-out is served in place on every accepted host over https; every other write stays refused", () => {
  const ON = { HOST_REDIRECT: "on", ...S55 };
  const site = siteConfig(ON);
  assert.equal(SIGN_OUT_PATH, "/api/auth/logout");
  for (const host of ["vicinity.city", "www.vicinity.city", "vicinitycity.net"]) {
    const url = new URL(`https://${host}${SIGN_OUT_PATH}`);
    assert.equal(hostAnswer(new Request(url, { method: "POST" }), url, site), null, host);
    for (const method of ["PUT", "DELETE", "PATCH"]) assert.equal(hostAnswer(new Request(url, { method }), url, site).status, 421, `${method} ${host}`);
    const http = new URL(`http://${host}${SIGN_OUT_PATH}`);
    assert.equal(hostAnswer(new Request(http, { method: "POST" }), http, site).status, 421, `http ${host}`);
    const other = new URL(`https://${host}/api/auth/logoutx`);
    assert.equal(hostAnswer(new Request(other, { method: "POST" }), other, site).status, 421);
  }
  const unknown = new URL(`https://evil.example${SIGN_OUT_PATH}`);
  assert.equal(hostAnswer(new Request(unknown, { method: "POST" }), unknown, site).status, 421, "an unknown host is never served");
});

/* ---------------------------------------------------------------- R2H-05: a clear answer */

test("R2H-05: every 421 names the canonical origin from the configuration (never the request); a sign-in trip on an old host lands on the new sign-in page", async () => {
  assert.deepEqual(await wrongHost(siteConfig(S55)).json(), { error: "wrong_host", origin: CC });
  for (const [sites, origin] of [[S06, VC], [S55, CC], [{ SITE_ORIGIN: "https://citycoin.dev" }, VC], [{}, VC]]) {
    const env = W.newWorld({ ...sites });
    // (unset, a host outside the allowlist is served in place as today: only the cutover's own hosts are refused)
    for (const url of [...(hostBound(siteConfig(sites)) ? ["https://evil.example/api/health"] : []), "https://www.citycoin.dev/api/me"]) {
      const r = await worker.fetch(new Request(url, { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } }), env, ctx);
      assert.deepEqual([r.status, await r.json()], [421, { error: "wrong_host", origin }], `${JSON.stringify(sites)} ${url}`);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers.get(k), v, k);
    }
  }
  _pagesBuiltForTests({ pagesReachWorker: true });
  try {
    const env = W.newWorld({ HOST_REDIRECT: "on", ...S55, GOOGLE_CLIENT_ID: "gid" });
    for (const path of ["/api/auth/google/callback?code=C&state=S", "/api/auth/google/start?signup=1", "/api/auth/google/start"]) {
      for (const host of ["vicinity.city", "www.vicinity.city"]) for (const method of ["GET", "HEAD"]) {
        const r = await worker.fetch(new Request(`https://${host}${path}`, { method }), env, ctx);
        assert.deepEqual([r.status, r.headers.get("location"), r.headers.get("cache-control"), r.headers.getSetCookie().length],
          [302, `${CC}/connect?error=login_expired`, "no-store", 0], `${method} ${host}${path}`);
      }
    }
    assert.ok(AUTH_TRIP.test("/api/auth/google/start") && AUTH_TRIP.test("/api/auth/google/callback"));
    for (const p of ["/api/auth/wallet", "/api/auth/google", "/api/auth/google/start/x", "/api/auth/email/verify"]) assert.ok(!AUTH_TRIP.test(p), p);
    // the other origin-bound reads stay a plain 421, and the canonical host is served as before
    assert.equal((await worker.fetch(new Request("https://vicinity.city/api/pair?code=abc"), env, ctx)).status, 421);
    const start = await worker.fetch(new Request(`${CC}/api/auth/google/start`), env, ctx);
    assert.equal(new URL(start.headers.get("location")).origin, "https://accounts.google.com");
  } finally { _pagesBuiltForTests(null); }
});

/* ---------------------------------------------------------------- R2H-06, SEC-2: never served unbound */

test("R2H-06, SEC-2: until SITE_ORIGINS lists citycoin.dev, citycoin.dev and www.citycoin.dev are refused before any route; nothing is written; other hosts unchanged", async () => {
  // the cutover hosts are the policy's canonical host and its www
  assert.deepEqual([...CUTOVER_HOSTS], [new URL(MASTER_POLICY.policy.pairs_and_branding.canonical_origin).hostname, `www.${new URL(MASTER_POLICY.policy.pairs_and_branding.canonical_origin).hostname}`]);
  for (const sites of [{}, { SITE_ORIGINS: "https://vicinity.city" }, { SITE_ORIGIN: "https://vicinity.city" }, { SITE_ORIGINS: "nonsense" }]) {
    const env = W.newWorld({ ...sites });
    const p = await oldMember(env);
    const dump = async () => JSON.stringify([await rows(env.DB, "SELECT * FROM sessions ORDER BY id"), await rows(env.DB, "SELECT * FROM pairs ORDER BY id"), await rows(env.DB, "SELECT * FROM handoffs ORDER BY id")]);
    const before = await dump();
    for (const host of CUTOVER_HOSTS) for (const proto of ["https", "http"]) {
      for (const [method, path, body] of [["GET", `/api/message?address=${p.w.address}&action=login`], ["POST", "/api/pair", {}], ["GET", "/api/auth/google/start"],
        ["POST", "/api/auth/wallet", await signedFor(p.w, host)], ["GET", "/api/me"], ["GET", "/"], ["GET", "/coin-meta/x.json"], ["GET", "/official-coins.csv"]]) {
        const cookie = [...p.jar].map(([k, v]) => `${k}=${v}`).join("; ");
        const r = await worker.fetch(new Request(`${proto}://${host}${path}`, { method, headers: { origin: `${proto}://${host}`, cookie }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
        assert.deepEqual([r.status, r.headers.get("location"), r.headers.getSetCookie().length], [421, null, 0], `${JSON.stringify(sites)} ${method} ${proto}://${host}${path}`);
      }
    }
    assert.equal(await dump(), before, "no session, pairing or hand-off was made, and no host column added");
  }
  // listed: served (and bound)
  const env = W.newWorld({ ...S06 });
  assert.equal((await worker.fetch(new Request(`${CC}/api/health`), env, ctx)).status, 200);
});

/* ---------------------------------------------------------------- SEC-1: one record per table */

test("SEC-1: a failing hand-off column never stops a session from being read or made; a failing session column answers 500 before the signature is used up", async () => {
  const env = W.newWorld({ ...S06 });
  const p = await oldMember(env);
  const state = { fail: true };
  const broken = { ...env, DB: failing(env.DB, /ALTER TABLE handoffs ADD COLUMN host/, state) };
  const vc = at(broken, VC, { jar: new Map(p.jar) });
  assert.equal((await vc.send("/api/me?lite=1", { entry: true })).status, 200);
  assert.equal(await signedIn(vc), true);
  const w = await W.wallet();
  assert.equal((await at(broken, VC).send("/api/auth/wallet", { method: "POST", body: await signedFor(w, "vicinity.city"), entry: true })).status, 200);
  // the hand-off route itself answers 500 while its column cannot be added, and works once it can
  assert.equal((await vc.send("/api/locate/handoff", { method: "POST", body: { purpose: "home" }, entry: true })).status, 500);
  state.fail = false;
  assert.equal((await vc.send("/api/locate/handoff", { method: "POST", body: { purpose: "home" }, entry: true })).status, 200);

  const env2 = W.newWorld({ ...S06 });
  const q = await oldMember(env2);
  const st2 = { fail: true };
  const broken2 = { ...env2, DB: failing(env2.DB, /ALTER TABLE sessions ADD COLUMN host/, st2) };
  const body = await signedFor(q.w, "vicinity.city");
  const fresh = at(broken2, VC);
  assert.equal((await fresh.send("/api/auth/wallet", { method: "POST", body, entry: true })).status, 500);
  st2.fail = false;
  const retry = await fresh.send("/api/auth/wallet", { method: "POST", body, entry: true });
  assert.equal(retry.status, 200, "the same signed text still works: it was not used up by the failed attempt");
  assert.notEqual((await retry.json()).error, "replayed");
});

test("SEC-1: while bound, sign-out always clears the cookie even when the database fails; unbound, a failure answers as before", async () => {
  const env = W.V2({ ...S06 });
  const box = outbox();
  const m = at(env, VC);
  const j = await journey(m, box, { via: "google" });
  assert.equal(j.finish.ok, true, JSON.stringify(j.finish));
  const state = { fail: true };
  const broken = { ...env, DB: failing(env.DB, /^SELECT id, wallet, user_id, proof, created_at, expires_at, proven_at, host FROM sessions/, state) };
  const lo = await at(broken, VC, { jar: new Map(m.jar) }).send("/api/auth/logout", { method: "POST", body: {}, entry: true });
  assert.equal(lo.status, 200);
  assert.match(lo.headers.getSetCookie()[0], /^vs=; .*Max-Age=0$/);
  // unbound: the same failure is a 500, as today
  const off = W.V2();
  const n = at(off, VC);
  const k = await journey(n, box, { via: "google" });
  assert.equal(k.finish.ok, true);
  const brokenOff = { ...off, DB: failing(off.DB, /^SELECT id, wallet, user_id, proof, created_at, expires_at, proven_at FROM sessions/, state) };
  assert.equal((await at(brokenOff, VC, { jar: new Map(n.jar) }).send("/api/auth/logout", { method: "POST", body: {}, entry: true })).status, 500);
  // the records: one per table
  assert.deepEqual(Object.keys(HOST_MIGRATIONS), ["sessions", "pairs", "handoffs"]);
  assert.equal(new Set(Object.values(HOST_MIGRATIONS).map((m) => m.id)).size, 3);
  for (const [t, m] of Object.entries(HOST_MIGRATIONS)) assert.deepEqual(m.columns, [`ALTER TABLE ${t} ADD COLUMN host TEXT`]);
});

/* ---------------------------------------------------------------- SEC-4: the exact origin while bound */

test("SEC-4: while bound, a write must carry the allowlist entry's origin exactly (scheme and host); unbound, today's host comparison", async () => {
  const req = (url, origin) => new Request(url, { method: "POST", headers: origin ? { origin } : {} });
  for (const [url, origin, unbound, bound] of [
    [`${CC}/api/auth/wallet`, CC, true, true],
    [`${CC}/api/auth/wallet`, "http://citycoin.dev", true, false],
    [`${VC}/api/auth/wallet`, "http://vicinity.city", true, false],
    ["https://vicinity.city:8443/api/x", "http://vicinity.city:8443", true, false],
    ["https://vicinity.city:8443/api/x", "https://vicinity.city:8443", true, false],
    ["https://vicinity.city:8443/api/x", VC, false, true],
    [`${VC}/api/x`, CC, false, false],
    [`${VC}/api/x`, null, false, false],
    [`${VC}/api/x`, "null", false, false],
    ["http://localhost:8787/api/x", "http://localhost:8787", true, true],
  ]) {
    assert.equal(sameSite(req(url, origin)), unbound, `no env: ${origin} -> ${url}`);
    assert.equal(sameSite(req(url, origin), {}), unbound, `unset: ${origin} -> ${url}`);
    assert.equal(sameSite(req(url, origin), S06), bound, `bound: ${origin} -> ${url}`);
  }
  // through a route: an http Origin on the https endpoint is refused while bound, and nothing is made
  const env = W.newWorld({ ...S06 });
  const r = await at(env, CC, { from: "http://citycoin.dev" }).send("/api/pair", { method: "POST", body: {} });
  assert.deepEqual([r.status, (await r.json()).error], [403, "wrong_origin"]);
  assert.equal((await rows(env.DB, "SELECT id FROM pairs")).length, 0);
  assert.equal((await at(env, CC).post("/api/pair")).ok, true);
});

/* ---------------------------------------------------------------- SEC-7, PARITY-2: this computer, outside production only */

test("SEC-7, PARITY-2: this computer's hosts are honoured only outside production; wrangler dev's http visit keeps http in its links", async () => {
  assert.equal(localDevAllowed({}), true);
  assert.equal(localDevAllowed({ DEPLOYMENT_ENV: "test" }), true);
  assert.equal(localDevAllowed({ DEPLOYMENT_ENV: "production" }), false);
  assert.equal(localDevAllowed({ DEPLOYMENT_ENV: " PRODUCTION " }), false);
  // production (S55): a local host name is refused like any other host outside the allowlist, before any route
  const prod = W.newWorld({ ...S55 });
  for (const url of ["http://localhost:8787/api/health", "https://evil.localhost/api/health", "http://127.0.0.1/api/me", "http://[::1]/api/health"]) {
    assert.equal((await worker.fetch(new Request(url), prod, ctx)).status, 421, url);
  }
  // a visit from a local address in production (Cloudflare never sets one) changes nothing: the links name the https entry
  const g = await worker.fetch(new Request("http://vicinity.city/api/auth/google/start", { headers: { "cf-connecting-ip": "127.0.0.1" } }), prod, ctx);
  assert.equal(new URL(g.headers.get("location")).searchParams.get("redirect_uri"), `${VC}/api/auth/google/callback`);
  // outside production (S06 without DEPLOYMENT_ENV): wrangler dev's visit of a route's name over http keeps http in the Google return
  // address and the QR link, as it did before the binding
  const dev = W.newWorld({ ...S06 });
  const local = { ip: "127.0.0.1", from: "http://vicinity.city" };
  const start = await at(dev, "http://vicinity.city", local).send("/api/auth/google/start", { entry: true });
  assert.equal(new URL(start.headers.get("location")).searchParams.get("redirect_uri"), "http://vicinity.city/api/auth/google/callback");
  assert.match((await at(dev, "http://vicinity.city", local).post("/api/pair")).url, /^http:\/\/vicinity\.city\/connect\?pair=/);
  assert.equal((await one(dev.DB, "SELECT host FROM pairs")).host, "vicinity.city", "its rows are bound to the allowlist entry");
  assert.equal((await worker.fetch(new Request("http://localhost:8787/api/health"), dev, ctx)).status, 200);
});

/* ---------------------------------------------------------------- PARITY-1: a refused setting fails closed (deliberate, pinned) */

test("PARITY-1: a SITE_ORIGIN or SITE_ORIGINS that is set but refused turns the binding on with today's site (fail closed, deliberately)", async () => {
  for (const sites of [{ SITE_ORIGIN: "https://citycoin.dev" }, { SITE_ORIGINS: "nonsense" }, { SITE_ORIGIN: "http://vicinity.city" }]) {
    const site = siteConfig(sites);
    assert.ok(site.problems.length > 0 && site.origin === VC && hostBound(site), JSON.stringify(sites));
    const env = W.newWorld({ ...sites });
    const p = await oldMember(env);
    // today's members stay signed in on vicinity.city; any host outside the allowlist answers 421; the additive migration runs on first use
    assert.equal(await signedIn(at(env, VC, { jar: new Map(p.jar) })), true);
    assert.equal((await worker.fetch(new Request("https://evil.example/api/health"), env, ctx)).status, 421);
    assert.ok((await rows(env.DB, "PRAGMA table_info(sessions)")).some((c) => c.name === "host"));
    const made = await at(env, VC).send("/api/auth/wallet", { method: "POST", body: await signedFor(p.w, "vicinity.city") });
    const c = made.headers.getSetCookie()[0];
    assert.equal((await one(env.DB, "SELECT host FROM sessions WHERE id = ?", await sha256(decodeURIComponent(c.slice(3).split(";")[0])))).host, "vicinity.city");
  }
});

/* ---------------------------------------------------------------- R2H-07, PARITY-4 */

test("R2H-07: an asset the Worker fetches keeps its own Content-Security-Policy (public/_headers' font-src); without one it gets the Worker's", () => {
  const own = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
  const kept = withSecurityHeaders(new Response("x", { headers: { "Content-Security-Policy": own, "Cache-Control": "public, max-age=31536000, immutable" } }));
  assert.equal(kept.headers.get("content-security-policy"), own);
  assert.equal(kept.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(kept.headers.get("x-frame-options"), "DENY");
  const plain = withSecurityHeaders(new Response("x"));
  assert.equal(plain.headers.get("content-security-policy"), SECURITY_HEADERS["Content-Security-Policy"]);
});

test("PARITY-4: the page build reads run_worker_first true, or a list holding \"/*\" with no negative pattern, as every page reaching the Worker", () => {
  assert.deepEqual(pageRouting({}, { run_worker_first: true }), { pagesReachWorker: true });
  assert.deepEqual(pageRouting({}, { run_worker_first: ["/*"] }), { pagesReachWorker: true });
  assert.deepEqual(pageRouting({}, { run_worker_first: ["/api/*", "/*"] }), { pagesReachWorker: true });
  for (const first of [["/*", "!/fonts/*"], ["/api/*", "/coin-meta/*", "/official-coins.csv"], ["/"], ["*"], false, undefined, "true"]) {
    assert.deepEqual(pageRouting({}, { run_worker_first: first }), { pagesReachWorker: false }, JSON.stringify(first));
  }
});
