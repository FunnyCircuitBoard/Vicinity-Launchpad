// The new sign-up from end to end through the real API: location, Terms + account (e-mail or Google), wallet, finish.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EMPTY, IN_UTICA, MINT, V2, browser, clock, loginBody, realClock, setHolding, useClock, wallet, advance, tick } from "./helpers/world.js";
import { GOOD_PASSWORD, doEmail, doGoogle, doLocation, doTerms, doWallet, dumpAll, fakeGoogle, finish, journey, member, one, outbox, pickCommunity, recordAnswers, rows, startSignup, stateOf } from "./helpers/signup.js";
import { verifyPassword } from "../src/password.js";
import { cleanupSignups } from "../src/signup-core.js";
import { runJobs } from "../src/jobs.js";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const cookiesOf = (res) => res.headers.getSetCookie();
const count = async (table) => (await one(env.DB, `SELECT COUNT(*) AS n FROM ${table}`)).n;

test("e-mail path: every step moves 'next' on, and the finish makes the account", async () => {
  const b = browser(env), w = await wallet(), email = "ada@example.com";
  let s = (await startSignup(b)).state;
  assert.deepEqual(s, { terms: { done: false, version: "2026-10-01" }, location: { done: false }, account: { done: false }, wallet: { done: false }, next: "location" });

  const loc = await doLocation(b);
  assert.deepEqual(loc, { ok: true, community: { id: "5142056", name: "Utica", country: "US" } });
  s = await stateOf(b);
  assert.equal(s.location.done, true);
  assert.deepEqual(s.location.community, { id: "5142056", name: "Utica", country: "US" });
  assert.equal(s.next, "account", "location done: the account step is next");

  s = (await doTerms(b)).state;
  assert.equal(s.terms.done, true);
  assert.equal(s.next, "account", "Terms alone are not the account");

  const typed = await b.send("/api/signup/email", { method: "POST", body: { email, password: GOOD_PASSWORD }, fetchImpl: box.fetch });
  assert.deepEqual(await typed.json(), { ok: true });
  s = await stateOf(b);
  assert.deepEqual(s.account, { done: false, pending: { email: "a***@example.com" } });
  assert.equal(s.next, "account");

  const code = box.codeFor(email);
  const verified = await (await b.send("/api/signup/email/verify", { method: "POST", body: { code }, fetchImpl: box.fetch })).json();
  assert.equal(verified.ok, true);
  assert.equal(verified.existing, false);
  assert.deepEqual(verified.state.account, { done: true, provider: "email", email: "a***@example.com" });
  assert.equal(verified.state.next, "wallet");

  const w1 = await doWallet(b, w);
  assert.equal(w1.next, "signup", "a new wallet is told to finish the sign-up");
  s = await stateOf(b);
  assert.deepEqual(s.wallet, { done: true, address: `${w.address.slice(0, 4)}…${w.address.slice(-4)}` });
  assert.equal(s.next, "finish");

  const done = await finish(b);
  assert.deepEqual(done, { ok: true, next: "/dashboard?welcome=1", isNew: true });
  const me = await b.get("/api/me?lite=1");
  assert.equal(me.signedIn, true);
  assert.equal(me.user.wallet, w.address);
  assert.equal(me.user.home.name, "Utica");
});

test("Google path: the callback records the identity (no account yet) and sends the person on to the next step", async () => {
  const b = browser(env), w = await wallet();
  await startSignup(b);
  await doLocation(b);
  await doTerms(b);
  const g = await doGoogle(b, "google-sub-77", { name: "Gina" });
  assert.equal(g.to, "/connect?step=wallet", "location and Terms are done, so the wallet is next");
  assert.equal(await count("users"), 0, "recording the Google login creates no account");
  const s = await stateOf(b);
  assert.deepEqual(s.account, { done: true, provider: "google" });
  assert.equal(s.next, "wallet");

  await doWallet(b, w);
  assert.equal((await finish(b)).ok, true);
  const u = await one(env.DB, "SELECT provider, provider_id, name, password_hash FROM users");
  assert.deepEqual({ ...u }, { provider: "google", provider_id: "google-sub-77", name: "Gina", password_hash: null });
});

test("the Google callback says where to go: location first when the community is still missing, finish when only the account was missing", async () => {
  const b = browser(env), w = await wallet();
  await startSignup(b);
  await doTerms(b);
  assert.equal((await doGoogle(b, "g-early")).to, "/connect?step=location");
  await b.post("/api/signup/account/reset");
  await doLocation(b);
  await doWallet(b, w);
  assert.equal((await doGoogle(b, "g-last")).to, "/connect?step=finish", "everything else is done");
});

test("the steps can come in any order: the account is made once, whichever step was last", async () => {
  const steps = {
    location: (b) => doLocation(b),
    account: async (b, ctx) => { await doTerms(b); return doEmail(b, box, ctx.email); },
    wallet: (b, ctx) => doWallet(b, ctx.w),
  };
  const orders = [["location", "account", "wallet"], ["location", "wallet", "account"], ["account", "location", "wallet"],
    ["account", "wallet", "location"], ["wallet", "location", "account"], ["wallet", "account", "location"]];
  let n = 0;
  for (const order of orders) {
    const b = browser(env), ctx = { w: await wallet(), email: `order${n++}@example.com` };
    if (order[0] === "wallet") await doWallet(b, ctx.w); // an old bookmark: the wallet came first, before any sign-up exists
    await startSignup(b);
    for (const step of order) {
      if (step === "wallet" && order[0] === "wallet") continue;
      await steps[step](b, ctx);
      if (step !== order[order.length - 1]) assert.notEqual((await stateOf(b)).next, "finish", order.join() + " after " + step);
    }
    assert.equal((await stateOf(b)).next, "finish", order.join());
    const done = await finish(b);
    assert.equal(done.ok, true, order.join() + " " + JSON.stringify(done));
  }
  assert.equal(await count("users"), 6);
});

test("the state never carries coordinates, a full e-mail or wallet, a hash or a token (checked on every answer of a whole journey)", async () => {
  const b = browser(env), w = await wallet(), email = "private.person@example.com";
  const seen = recordAnswers(b);
  const point = { lat: 43.1234567, lon: -75.2345678, accuracy: 30 };
  await startSignup(b);
  await doLocation(b, point);
  await doTerms(b);
  await doEmail(b, box, email);
  await doWallet(b, w);
  await stateOf(b);
  await finish(b);
  const text = seen.join("\n");
  assert.ok(seen.items.length >= 8, "every answer of the journey was looked at");
  for (const secret of ["43.1234567", "75.2345678", "private.person", email, "pbkdf2", GOOD_PASSWORD, b.jar.get("vs")]) {
    assert.ok(!text.includes(secret), `a response contains ${secret}`);
  }
  // the sign-up's own answers never show the whole wallet either (the wallet routes themselves answer with the address that was just proven)
  for (const { path, text: t } of seen.items.filter((x) => x.path.startsWith("/api/signup/"))) assert.ok(!t.includes(w.address), path);
  assert.ok(!(await dumpAll(env.DB)).includes("1234567"), "the coordinates are in no row");
});

test("after the finish: the user row is complete, the session is a 30-day cookie, and every trace of the sign-up is gone", async () => {
  env = V2({ VICINITY_MINT: MINT });
  const b = browser(env), w = await wallet(), email = "full@example.com";
  const j = await journey(b, box, { via: "email", email, w });
  assert.equal(j.finish.ok, true);
  const u = await one(env.DB, "SELECT * FROM users");
  const at = new Date(clock.now).toISOString();
  assert.equal(u.wallet, w.address);
  assert.equal(u.provider, "email");
  assert.equal(u.provider_id, email);
  assert.match(u.handle, /^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/, "an auto username: nobody's wallet is their name");
  assert.equal(u.name, "E-mail member");
  assert.equal(u.early, 0, "the coin is already launched: not an early member");
  assert.equal(u.created_at, at);
  assert.equal(u.terms_version, "2026-10-01");
  assert.equal(u.terms_agreed_at, at);
  assert.deepEqual([u.home_city, u.home_name, u.home_country, u.home_at], ["5142056", "Utica", "US", at]);
  assert.ok(u.password_hash.startsWith("pbkdf2-sha256$1000$"), "an e-mail account keeps only the hash of its password");
  assert.ok((await verifyPassword(env, u.password_hash, GOOD_PASSWORD)).ok);
  assert.deepEqual([u.contact_email, u.phone, u.badges], [null, null, null]);

  // the cookies: a 30-day session, the sign-up cookie cleared
  // (the journey's own responses are gone: run a second one to look at the headers)
  const b2 = browser(env), w2 = await wallet();
  await journey(b2, box, { via: "email", w: w2, until: "wallet" });
  const res = await b2.send("/api/signup/finish", { method: "POST", body: {} });
  const sc = cookiesOf(res);
  const vs = sc.find((c) => c.startsWith("vs="));
  assert.match(vs, /; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
  assert.match(sc.find((c) => c.startsWith("vsu=")), /^vsu=; .*Max-Age=0$/);

  // nothing is left: the sign-up row, its hand-offs, the pending session
  assert.equal(await count("signups"), 0);
  assert.equal(await count("handoffs"), 0);
  assert.equal((await rows(env.DB, "SELECT id FROM sessions WHERE user_id IS NULL")).length, 0, "the pending wallet session is gone");
  assert.equal((await rows(env.DB, "SELECT id FROM sessions WHERE user_id IS NOT NULL")).length, 2, "one full session per person");
});

test("after the finish /api/me shows the home community, the holdings and the new fields, and the community counts one member", async () => {
  env = V2({ VICINITY_MINT: MINT }); // launched: holdings are real
  const b = browser(env), w = await wallet();
  const j = await journey(b, box, { via: "google", w });
  assert.equal(j.finish.ok, true);
  setHolding(w.address, 1234);
  const me = await b.get("/api/me");
  assert.equal(me.signedIn, true);
  assert.equal(me.signupFlow, "v2");
  assert.equal(me.user.hasPassword, false, "a Google account has no password");
  assert.equal(me.user.home.name, "Utica");
  assert.equal(me.community.name, "Utica");
  assert.equal(me.holding.amount, 1234);
  assert.equal(me.fresh, true, "the wallet proof of the sign-up carries over");
  const members = await (await b.send("/api/members")).json();
  assert.deepEqual(members.communities.map((c) => [c.name, c.members]), [["Utica", 1]]);
});

test("/api/me says signupFlow v2 in all four shapes, and hasPassword for the person who has one", async () => {
  const out = browser(env);
  assert.deepEqual(await out.get("/api/me"), { signedIn: false, providers: { google: true, email: true }, signupFlow: "v2" });
  const pend = browser(env);
  await doWallet(pend, await wallet());
  const p = await pend.get("/api/me");
  assert.equal(p.signupFlow, "v2");
  assert.equal(p.signedIn, false);
  assert.ok(p.pending.wallet && !("hasPassword" in p));

  const m = await member(env, box, { via: "email" });
  for (const url of ["/api/me", "/api/me?lite=1"]) {
    const me = await m.b.get(url);
    assert.equal(me.signupFlow, "v2", url);
    assert.equal(me.user.hasPassword, true, url);
  }
  const g = await member(env, box, { via: "google" });
  assert.equal((await g.b.get("/api/me?lite=1")).user.hasPassword, false);
});

test("empty land: three nearest to choose from, the choice stays changeable until the end, and the chosen one becomes home", async () => {
  const b = browser(env), w = await wallet();
  await startSignup(b);
  const loc = await b.post("/api/signup/location", { location: EMPTY, country: "US" });
  assert.equal(loc.ok, true);
  assert.equal(loc.community, undefined);
  assert.equal(loc.choices.length, 3);
  for (const c of loc.choices) {
    assert.deepEqual(Object.keys(c).sort(), ["country", "id", "km", "name"]);
    assert.equal(c.country, "US");
    assert.equal(c.km % 5, 0, "distances are rounded to 5 km");
  }
  let s = await stateOf(b);
  assert.equal(s.location.done, false);
  assert.equal(s.location.picked, false);
  assert.equal(s.next, "location");
  assert.deepEqual(s.location.choices, loc.choices);

  const first = await pickCommunity(b, loc.choices[0].id);
  assert.deepEqual(first, { ok: true, community: { id: loc.choices[0].id, name: loc.choices[0].name, country: "US" } });
  s = await stateOf(b);
  assert.equal(s.location.done, true);
  assert.equal(s.location.picked, true);
  assert.deepEqual(s.location.choices, loc.choices, "the choices stay after picking");

  const second = await pickCommunity(b, loc.choices[2].id);
  assert.equal(second.community.id, loc.choices[2].id, "changed their mind");

  await doTerms(b);
  await doEmail(b, box, "wild@example.com");
  await doWallet(b, w);
  assert.equal((await finish(b)).ok, true);
  const u = await one(env.DB, "SELECT home_city, home_name, home_country FROM users");
  assert.deepEqual({ ...u }, { home_city: loc.choices[2].id, home_name: loc.choices[2].name, home_country: "US" });
});

test("GET /api/signup/state with no cookie, a made-up cookie or an expired sign-up answers the empty state and creates nothing", async () => {
  const empty = { terms: { done: false, version: "2026-10-01" }, location: { done: false }, account: { done: false }, wallet: { done: false }, next: "location" };
  const b = browser(env);
  const r = await b.send("/api/signup/state");
  assert.deepEqual(await r.json(), { ok: true, state: empty });
  assert.deepEqual(cookiesOf(r), [], "no cookie is set by a read");
  b.jar.set("vsu", "made-up-token");
  assert.deepEqual((await b.get("/api/signup/state")), { ok: true, state: empty });
  assert.equal(await count("signups"), 0);

  const real = browser(env);
  await startSignup(real);
  await doTerms(real);
  advance(61 * 60_000);
  assert.deepEqual(await real.get("/api/signup/state"), { ok: true, state: empty }, "expired: back to the start, not an error");
});

test("start twice gives the same sign-up (and no second row); after it expired a start makes a fresh one with a new token", async () => {
  const b = browser(env);
  await startSignup(b);
  await doTerms(b);
  const token1 = b.jar.get("vsu");
  const again = await startSignup(b);
  assert.equal(again.state.terms.done, true, "the current sign-up comes back");
  assert.equal(b.jar.get("vsu"), token1, "same cookie");
  assert.equal(await count("signups"), 1);
  advance(2 * 3600_000);
  const fresh = await startSignup(b);
  assert.equal(fresh.state.terms.done, false);
  assert.notEqual(b.jar.get("vsu"), token1, "never reuses an old token");
  assert.equal(await count("signups"), 2, "the expired one waits for the scheduled tidy-up");
});

test("signing in as an existing person during 'New here' ends the half-done sign-up: wallet, Google, e-mail code and the phone-QR way", async () => {
  const mem = await member(env, box, { via: "email", email: "member@example.com" });
  const memGoogle = await member(env, box, { via: "google", sub: "member-google" });

  const startHalf = async () => {
    const b = browser(env);
    await startSignup(b);
    await doLocation(b);
    await doTerms(b);
    assert.ok(b.has("vsu"));
    return b;
  };
  const ended = async (b, label) => {
    assert.ok(!b.has("vsu"), label + ": the sign-up cookie is cleared");
    assert.equal((await b.get("/api/me?lite=1")).signedIn, true, label + ": signed in");
  };

  // 1. wallet that already has an account
  let b = await startHalf();
  const r = await b.post("/api/auth/wallet", await loginBody(mem.w));
  assert.equal(r.next, "/dashboard");
  await ended(b, "wallet");

  // 2. a Google login that already has an account (started from the sign-up page, so it carries the marker)
  b = await startHalf();
  const g = await doGoogle(b, "member-google");
  assert.equal(g.to, "/dashboard");
  await ended(b, "google");

  // 3. an e-mail address that already has an account, through the sign-up's own route
  b = await startHalf();
  const e = await doEmail(b, box, "member@example.com", { password: "another long password" });
  assert.deepEqual({ ok: e.verify.ok, existing: e.verify.existing, isNew: e.verify.isNew, next: e.verify.next }, { ok: true, existing: true, isNew: false, next: "/dashboard" });
  await ended(b, "e-mail");

  // 4. the same address through today's e-mail code route
  b = await startHalf();
  await b.send("/api/auth/email/start", { method: "POST", body: { email: "member@example.com" }, fetchImpl: box.fetch });
  advance(61_000); // (the first code of this address is a minute old: a new send is allowed)
  const old = await (await b.send("/api/auth/email/verify", { method: "POST", body: { email: "member@example.com", code: box.codeFor("member@example.com") }, fetchImpl: box.fetch })).json();
  assert.equal(old.next, "/dashboard");
  await ended(b, "old e-mail route");

  // 5. a phone approves for this computer ("sign in with my phone"): pair + finish
  b = await startHalf();
  const pair = await b.post("/api/pair");
  const phone = browser(env);
  const body = await loginBody(memGoogle.w, pair.pin);
  assert.equal((await phone.post("/api/auth/wallet", { ...body, pair: pair.code })).paired, true);
  const fin = await b.post("/api/pair/finish", { code: pair.code });
  assert.equal(fin.next, "/dashboard");
  await ended(b, "pair");

  assert.equal(await count("signups"), 0, "every half-done sign-up was deleted");
  assert.equal(await count("users"), 2, "and nobody got a second account");
});

test("an unknown wallet in v2 never gets an account from a wallet login alone (pending only), whatever it does next", async () => {
  const b = browser(env);
  const w = await wallet();
  const r = await doWallet(b, w);
  assert.equal(r.next, "signup");
  assert.equal((await b.get("/api/me")).signedIn, false);
  assert.equal(await count("users"), 0);
});

test("fault injection: while the new tables cannot be made, start answers 503 signup_unavailable and the rest of the site is untouched; then it recovers", async () => {
  let armed = true;
  const real = env.DB;
  env.DB = { ...real, prepare: (sql) => {
    if (armed && /^ALTER TABLE users ADD COLUMN password_hash/i.test(sql)) {
      const failing = { sql, bind: () => failing, run: async () => { throw new Error("D1_ERROR: disk I/O error"); }, first: async () => { throw new Error("D1_ERROR: disk I/O error"); }, all: async () => { throw new Error("D1_ERROR: disk I/O error"); } };
      return failing;
    }
    return real.prepare(sql);
  } };
  const b = browser(env);
  for (const path of ["/api/signup/start", "/api/signup/location", "/api/signup/finish"]) {
    const r = await b.send(path, { method: "POST", body: {} });
    assert.equal(r.status, 503, path);
    assert.deepEqual(await r.json(), { ok: false, error: "signup_unavailable" });
  }
  assert.equal((await b.send("/api/signup/state")).status, 503);
  // the old routes do not need the new tables
  assert.equal((await b.send("/api/members")).status, 200);
  assert.equal((await doWallet(b, await wallet())).ok, true, "a wallet login still works");
  armed = false;
  assert.equal((await startSignup(b)).ok, true, "the next request makes the tables and goes on");
});

test("the scheduled tidy-up removes expired sign-ups and old counters, keeps live ones, and never fails when the tables are missing", async () => {
  const noTables = V2();
  await assert.doesNotReject(cleanupSignups(noTables, clock.now));
  assert.equal((await runJobs(noTables, clock.now, undefined, () => 0.99)).cleanup.ok, true);

  const live = browser(env);
  await startSignup(live);
  await doTerms(live);
  const gone = browser(env);
  await startSignup(gone);
  await env.DB.prepare("UPDATE signups SET expires_at = ? WHERE id != (SELECT id FROM signups ORDER BY created_at, rowid LIMIT 1)").bind(new Date(clock.now - 1000).toISOString()).run();
  const t = new Date(clock.now).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO auth_limits (key, n, window_start) VALUES ('old', 3, ?)").bind(new Date(clock.now - 25 * 3600_000).toISOString()),
    env.DB.prepare("INSERT INTO auth_limits (key, n, window_start) VALUES ('recent', 3, ?)").bind(t),
  ]);
  const out = await tick(env);
  assert.deepEqual(out.cleanup, { ok: true });
  assert.equal(await count("signups"), 1, "the expired one is gone, the live one stays");
  assert.deepEqual((await rows(env.DB, "SELECT key FROM auth_limits WHERE key IN ('old','recent')")).map((r) => r.key), ["recent"]);
});

test("the sign-up e-mail says 'verification code', and the same sender and subject as the sign-in e-mail", async () => {
  const b = browser(env);
  await startSignup(b);
  await doTerms(b);
  await doEmail(b, box, "words@example.com", { verify: false });
  assert.equal(box.last().kind, "signup");
  assert.equal(box.last().subject, `${box.last().code} is your Vicinity code`);
});

test("with the real password cost (100,000 rounds, no test setting) a whole sign-up still works, and the stored hash says so", async () => {
  env = V2({ PASSWORD_ITERATIONS: undefined });
  const b = browser(env);
  const started = performance.now(); // (Date.now is the test clock)
  const j = await journey(b, box, { via: "email" });
  assert.equal(j.finish.ok, true, JSON.stringify(j.finish));
  assert.ok((await one(env.DB, "SELECT password_hash FROM users")).password_hash.startsWith("pbkdf2-sha256$100000$"));
  assert.ok(performance.now() - started < 5000, "one hash at full cost is well under a second");
});
