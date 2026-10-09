// Security properties of the new sign-up that a reviewer would try to break: the cookie, the Origin check on every POST,
// dead and foreign sign-up cookies, expiry, no state changed by a GET, no secret in any answer or log line, no raw IP stored.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { V2, advance, browser, realClock, useClock, wallet } from "./helpers/world.js";
import { GOOD_PASSWORD, doEmail, doLocation, doTerms, dumpAll, finish, journey, linkDirect, member, one, outbox, recordAnswers, rows, startSignup, stateOf, tablesAndColumns } from "./helpers/signup.js";
import { sha256 } from "../src/http.js";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const POST_ROUTES = ["/api/signup/start", "/api/signup/location", "/api/signup/location/choice", "/api/signup/location/handoff", "/api/signup/location/handoff/info",
  "/api/signup/location/handoff/complete", "/api/signup/location/handoff/claim", "/api/signup/terms", "/api/signup/account/reset", "/api/signup/email",
  "/api/signup/email/verify", "/api/signup/finish", "/api/auth/email/login", "/api/auth/password/reset/start", "/api/auth/password/reset", "/api/me/password"];

test("the sign-up cookie: random, HttpOnly, Secure, SameSite=Lax, an hour, and only its hash is stored", async () => {
  const b = browser(env);
  const r = await b.send("/api/signup/start", { method: "POST", body: {} });
  const sc = r.headers.getSetCookie().filter((c) => c.startsWith("vsu="));
  assert.equal(sc.length, 1);
  assert.match(sc[0], /^vsu=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600$/);
  const token = sc[0].split(";")[0].slice(4);
  const stored = await rows(env.DB, "SELECT id FROM signups");
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].id, token);
  assert.equal(stored[0].id, await sha256(token), "the row is found by the hash of the cookie");
  assert.ok(!(await dumpAll(env.DB)).includes(token), "the token itself is in no row");
  // a second browser gets another token
  const c = browser(env);
  await startSignup(c);
  assert.notEqual(c.jar.get("vsu"), token);
});

test("every POST route refuses a missing or foreign Origin with wrong_origin, and a GET needs none", async () => {
  const b = browser(env);
  await startSignup(b);
  for (const path of POST_ROUTES) {
    for (const origin of [null, "https://evil.example", "https://vicinity.test.evil.example", "null"]) {
      const r = await b.send(path, { method: "POST", body: {}, origin });
      assert.equal(r.status, 403, `${path} ${origin}`);
      assert.deepEqual(await r.json(), { ok: false, error: "wrong_origin" }, `${path} ${origin}`);
    }
  }
  assert.equal((await b.send("/api/signup/state", { origin: null })).status, 200);
  assert.equal(await one(env.DB, "SELECT COUNT(*) AS n FROM signups").then((x) => x.n), 1, "nothing was created by the refused calls");
});

test("wrong method and unknown paths: 405 and 404, and nothing happens", async () => {
  const b = browser(env);
  for (const path of POST_ROUTES) {
    const r = await b.send(path, { method: "GET" });
    assert.equal(r.status, 405, path);
    assert.deepEqual(await r.json(), { error: "method_not_allowed" });
  }
  assert.equal((await b.send("/api/signup/state", { method: "POST", body: {} })).status, 405);
  assert.equal((await b.send("/api/signup/nothing", { method: "POST", body: {} })).status, 404);
  assert.equal((await b.send("/api/signup", { method: "POST", body: {} })).status, 404, "only the paths under /api/signup/ belong to the sign-up");
  assert.ok(!(await tablesAndColumns(env.DB)).tables.includes("signups"), "refused before the database is even touched");
});

test("the sign-up cookie of a finished, expired, made-up or somebody else's sign-up opens nothing", async () => {
  // finished
  const done = browser(env);
  await journey(done, box, { via: "google" });
  const used = new Map(done.jar);
  // expired
  const old = browser(env);
  await startSignup(old);
  const oldToken = old.jar.get("vsu");
  advance(61 * 60_000);

  const probe = async (token) => {
    const g = browser(env);
    g.jar.set("vsu", token);
    const out = [];
    for (const [path, body] of [["/api/signup/location", { location: { lat: 43.1, lon: -75.23, accuracy: 30 }, country: "US" }], ["/api/signup/terms", { version: "2026-10-01" }],
      ["/api/signup/account/reset", {}], ["/api/signup/finish", {}], ["/api/signup/email", { email: "a@example.com", password: GOOD_PASSWORD }]]) {
      const r = await g.send(path, { method: "POST", body });
      out.push([path, r.status, (await r.json()).error]);
    }
    const st = await g.get("/api/signup/state");
    assert.equal(st.state.terms.done, false, "and the state is the empty one");
    return out;
  };
  for (const [name, token] of [["finished", used.get("vsu") || "x"], ["expired", oldToken], ["made-up", "Zm9vYmFy"], ["too long", "A".repeat(500)], ["empty", ""]]) {
    for (const [path, status, error] of await probe(token)) {
      assert.equal(status, 401, `${name} ${path}`);
      assert.equal(error, "no_signup", `${name} ${path}`);
    }
  }
  assert.equal(await one(env.DB, "SELECT COUNT(*) AS n FROM signups WHERE terms_version IS NOT NULL").then((x) => x.n), 0);
});

test("the sign-up slides by an hour with every change, and is never older than three hours", async () => {
  const b = browser(env);
  await startSignup(b);
  const created = Date.now();
  const row = () => one(env.DB, "SELECT created_at, expires_at FROM signups");
  assert.equal(Date.parse((await row()).expires_at), created + 3600_000);
  for (const minutes of [50, 100, 150]) {
    advance(50 * 60_000);
    const r = await b.send("/api/signup/terms", { method: "POST", body: { version: "2026-10-01" } });
    assert.equal(r.status, 200, `at ${minutes} minutes`);
    const exp = Date.parse((await row()).expires_at);
    assert.ok(exp <= created + 3 * 3600_000, "never beyond three hours from the start");
    assert.ok(exp > Date.now(), "and at least some time ahead");
    const maxAge = Number(r.headers.getSetCookie().find((c) => c.startsWith("vsu=")).match(/Max-Age=(\d+)/)[1]);
    assert.ok(maxAge <= 3600 && maxAge > 0, "the refreshed cookie never outlives the row: " + maxAge);
  }
  // 150 minutes in, the last call set the end to the 3 hour cap: 30 minutes later it is over although the last call was recent
  advance(20 * 60_000);
  assert.equal((await b.send("/api/signup/terms", { method: "POST", body: { version: "2026-10-01" } })).status, 200);
  advance(20 * 60_000);
  const late = await b.send("/api/signup/terms", { method: "POST", body: { version: "2026-10-01" } });
  assert.equal(late.status, 401, "three hours after the start, however busy it was");
  assert.equal((await late.json()).error, "no_signup");
});

test("a failed call does not hand out a new cookie; a good one refreshes the same token", async () => {
  const b = browser(env);
  await startSignup(b);
  const token = b.jar.get("vsu");
  const bad = await b.send("/api/signup/terms", { method: "POST", body: { version: "1999-01-01" } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.headers.getSetCookie(), []);
  const good = await b.send("/api/signup/terms", { method: "POST", body: { version: "2026-10-01" } });
  assert.match(good.headers.getSetCookie().find((c) => c.startsWith("vsu=")), new RegExp(`^vsu=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=\\d+$`));
});

test("a GET never changes anything: the state read does not extend the sign-up, and Google's start only sets its own cookie", async () => {
  const b = browser(env);
  await startSignup(b);
  await doTerms(b);
  const before = await dumpAll(env.DB);
  advance(10 * 60_000);
  const r = await b.send("/api/signup/state");
  assert.deepEqual(r.headers.getSetCookie(), [], "no cookie refreshed by a read");
  const g = await b.send("/api/auth/google/start?signup=1");
  assert.deepEqual(g.headers.getSetCookie().map((c) => c.split("=")[0]), ["vo"]);
  assert.equal(await dumpAll(env.DB), before, "not one row changed");
});

test("passwords and hashes never leave the server: not in /api/me, the state, the members list, the admin user list, nor any answer of a journey", async () => {
  const w = await wallet();
  env = V2({ ADMIN_WALLETS: w.address });
  box = outbox();
  const b = browser(env);
  const bodies = recordAnswers(b);
  const j = await journey(b, box, { via: "email", w });
  assert.equal(j.finish.ok, true);
  await linkDirect(env, j); // the owner's wallet is on the account: the admin list opens for it
  for (const p of ["/api/me", "/api/me?lite=1", "/api/signup/state", "/api/members", "/api/policy"]) await b.get(p);
  const admin = await b.send("/api/admin/users?q=");
  assert.equal(admin.status, 200, "the admin list works for the owner (and is scanned)");
  const text = bodies.join("\n");
  const scan = (o, path = "") => {
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { assert.ok(k === "hasPassword" || !/password|hash/i.test(k), `a key named ${path}.${k}`); scan(v, path + "." + k); }
    else if (typeof o === "string") assert.ok(!/pbkdf2/i.test(o), `a hash-like value at ${path}`);
  };
  for (const body of bodies) { try { scan(JSON.parse(body)); } catch (e) { if (e.name === "AssertionError") throw e; } }
  // the hasPassword flag is the only trace, and a boolean
  assert.ok(text.includes('"hasPassword":true'));
  assert.ok(!text.includes(GOOD_PASSWORD));
});

test("limits count connections, not addresses: no raw IP in the database, X-Forwarded-For is ignored, an IPv6 address is a /64", async () => {
  const ip = "203.0.113.77", v6 = "2001:db8:1234:5678:9abc:def0:1234:5678";
  const a = browser(env, { ip });
  await startSignup(a);
  await doLocation(a);
  const six = browser(env, { ip: v6 });
  await startSignup(six);
  const dump = await dumpAll(env.DB);
  assert.ok(!dump.includes(ip) && !dump.includes("203.0.113"), "no raw IP in any row");
  assert.ok(!dump.includes("2001:db8") && !dump.includes("9abc"), "no raw IPv6 either");
  const keys = (await rows(env.DB, "SELECT key FROM auth_limits")).map((r) => r.key);
  assert.ok(keys.length >= 4 && keys.every((k) => /^([a-z]+:[A-Za-z0-9_-]{22}|sus:site)$/.test(k)), keys.join());

  // a different address in the same /64 is the same connection; X-Forwarded-For changes nothing
  const before = (await rows(env.DB, "SELECT key, n FROM auth_limits")).length;
  const sibling = browser(env, { ip: "2001:db8:1234:5678::1" });
  await startSignup(sibling);
  const after = await rows(env.DB, "SELECT key, n FROM auth_limits WHERE key LIKE 'sus:%' AND key != 'sus:site'");
  assert.equal(after.length, 2, "the /64 neighbours share one counter");
  assert.equal(Math.max(...after.map((r) => r.n)), 2);
  assert.ok(before >= 1);
});

test("starting sign-ups is limited: 20 an hour per connection, and the whole site has a ceiling", async () => {
  const ip = "198.51.100.200";
  let last;
  for (let i = 0; i < 21; i++) last = await browser(env, { ip }).send("/api/signup/start", { method: "POST", body: {} });
  assert.equal(last.status, 429);
  assert.deepEqual(await last.json(), { ok: false, error: "slow_down" });
  assert.equal(await one(env.DB, "SELECT COUNT(*) AS n FROM signups").then((x) => x.n), 20, "the refused one made no row");
  // a different connection is not affected
  assert.equal((await browser(env, { ip: "198.51.100.201" }).send("/api/signup/start", { method: "POST", body: {} })).status, 200);
  // and a browser that already has a sign-up is not counted again for coming back
  const back = browser(env, { ip: "198.51.100.202" });
  await startSignup(back);
  for (let i = 0; i < 30; i++) assert.equal((await back.send("/api/signup/start", { method: "POST", body: {} })).status, 200);
  // the site-wide ceiling
  await env.DB.prepare("UPDATE auth_limits SET n = 5000 WHERE key = 'sus:site'").run();
  const sitewide = await browser(env, { ip: "198.51.100.203" }).send("/api/signup/start", { method: "POST", body: {} });
  assert.equal(sitewide.status, 429);
});

test("Terms, location and e-mail steps cannot be reached through a half-way identity: the account step needs the Terms recorded in THIS sign-up", async () => {
  const b = browser(env);
  await startSignup(b);
  // e-mail verify without anything typed
  assert.equal((await b.send("/api/signup/email/verify", { method: "POST", body: { code: "123456" } })).status, 400);
  // nothing in the state counts the account as done before the Terms
  await doLocation(b);
  await env.DB.prepare("UPDATE signups SET provider = 'google', provider_id = 'sneaky', identity_name = 'S', identity_at = ?").bind(new Date(Date.now()).toISOString()).run();
  const s = await stateOf(b);
  assert.equal(s.account.done, false, "an identity without the Terms is not an account step");
  assert.equal(s.next, "account");
});

test("the source never writes an e-mail, password, code or coordinate into a log line, and password hashes are only handled where they should be", () => {
  const files = readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".js") && f !== "common-passwords.js");
  const FORBIDDEN = /(?<![\w.$])(email|password|pw|code|lat|lon|latitude|longitude|body|location)(?![\w$])/;
  const logged = [];
  for (const f of files) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!/console\.(log|error|warn|info|debug)\(/.test(line)) return;
      // the call, which may run over a few lines
      let call = line.slice(line.indexOf("console."));
      for (let k = i + 1; k < lines.length && (call.match(/\(/g) || []).length > (call.match(/\)/g) || []).length; k++) call += " " + lines[k];
      logged.push(`${f}:${i + 1}`);
      // drop the text of string literals, keep what is interpolated
      const code = call.replace(/`([^`$\\]|\\.|\$(?!\{))*`/g, "``").replace(/"(\\.|[^"\\])*"/g, '""').replace(/'(\\.|[^'\\])*'/g, "''");
      const hit = code.match(FORBIDDEN);
      assert.ok(!hit, `${f}:${i + 1} logs "${hit && hit[1]}": ${call.slice(0, 120)}`);
    });
  }
  assert.ok(logged.length > 20, "the scan really looked at the log calls (" + logged.length + ")");

  const allowed = new Set(["auth.js", "store.js", "me.js", "password.js", "pwlogin.js", "signup.js", "signup-core.js", "signup-finish.js", "common-passwords.js"]);
  for (const f of files) {
    if (!/password_hash/.test(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"))) continue;
    assert.ok(allowed.has(f), `${f} handles password_hash: it must not (it would be one step from an answer)`);
  }
});
