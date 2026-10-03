// The switch: with PROFILES unset (or anything but "on") member profiles are simply not there and the site behaves exactly as it
// always has. These tests are the "dark launch" guarantee: every new path answers 404 not_enabled, /api/me has no new key, and
// not one new statement or object ever reaches the database. With the switch on, a failure of the new tables breaks only the new routes.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { IN_NYC, IN_UTICA, MINT, ORIGIN, V2, browser, loginBody, newWorld, person, realClock, reprove, setHolding, tick, useClock, wallet } from "./helpers/world.js";
import { PF, brokenProfilesDb, pfPerson, schemaOf, spyDb } from "./helpers/profiles.js";
import { PROFILES_MIGRATION, MIGRATIONS, ensureProfilesSchema, ensureSignupSchema } from "../src/store.js";
import { d1 } from "./helpers/d1.js";
import { profilesOn } from "../src/flags.js";
import { prodDb, seedProd } from "./helpers/prod-schema.js";

beforeEach(() => useClock("2026-10-01T12:00:00Z"));
after(() => realClock());

const OFF = [undefined, "", "off", "ON?", "true", "1", "yes", "onn", "o n", "v2"];
const ROUTES = [
  ["GET", "/api/profile?u=anyone"], ["GET", "/api/profile"], ["POST", "/api/profile/report"], ["GET", "/api/members/search?q=ab"],
  ["POST", "/api/follow"], ["GET", "/api/follows?list=followers"], ["POST", "/api/block"], ["GET", "/api/me/blocks"],
  ["POST", "/api/me/bio"], ["GET", "/api/me/portfolio"], ["POST", "/api/mod/bio/clear"],
];
const NEW_TABLES = ["follows", "blocks", "profile_reports", "auth_limits"];

test("profilesOn: exactly 'on', trimmed, any letter case", () => {
  for (const v of ["on", " on ", "ON", "On", "\ton\n"]) assert.equal(profilesOn({ PROFILES: v }), true, JSON.stringify(v));
  for (const v of OFF) assert.equal(profilesOn(v === undefined ? {} : { PROFILES: v }), false, JSON.stringify(v));
  assert.equal(profilesOn(undefined), false);
  assert.equal(profilesOn({ PROFILES: true }), false, "a boolean is not the word on");
});

test("flag off (unset, empty, typos): every new route answers 404 not_enabled, whoever asks and with any method", async () => {
  for (const flag of OFF) {
    const env = newWorld(flag === undefined ? {} : { PROFILES: flag });
    const out = browser(env);
    const member = await person(env, { home: IN_UTICA });
    for (const who of [out, member]) {
      for (const [method, path] of ROUTES) {
        for (const m of [method, method === "GET" ? "POST" : "GET", "DELETE", "PUT"]) {
          const r = await who.send(path, { method: m, body: m === "POST" || m === "PUT" ? {} : undefined });
          assert.equal(r.status, 404, `${flag} ${m} ${path}`);
          assert.deepEqual(await r.json(), { ok: false, error: "not_enabled" }, `${flag} ${m} ${path}`);
        }
        // even a POST from another site: the answer does not depend on anything the caller does
        const r = await who.send(path, { method: "POST", body: {}, origin: "https://evil.example" });
        assert.equal(r.status, 404);
      }
    }
  }
});

test("flag off: /api/me has exactly the keys it always had in all four shapes", async () => {
  const env = newWorld();
  const out = browser(env);
  assert.deepEqual(Object.keys(await out.get("/api/me")), ["signedIn", "providers"]);
  const pending = browser(env);
  await pending.post("/api/auth/wallet", await loginBody(await wallet()));
  assert.deepEqual(Object.keys(await pending.get("/api/me")), ["signedIn", "providers", "pending", "proof"]);
  const p = await person(env, { home: IN_UTICA });
  const lite = await p.get("/api/me?lite=1");
  assert.deepEqual(Object.keys(lite), ["signedIn", "user", "providers", "fresh"]);
  assert.deepEqual(Object.keys(lite.user), ["id", "wallet", "provider", "handle", "name", "contact_email", "phone", "home", "joined"]);
  const full = await p.get("/api/me");
  assert.ok(!("profilesFlag" in full) && !("counts" in full) && !("bio" in full.user), "the full answer has nothing new");
  for (const b of [out, pending, p]) {
    const text = JSON.stringify(await b.get("/api/me"));
    assert.ok(!/profilesFlag|"bio"|"counts"/.test(text));
  }
});

test("flag off: a whole journey (accounts, posts, votes, reports, the moderator's queue, the audit, the job) runs no new SQL and makes no new object", async () => {
  const env = newWorld();
  env.DB = spyDb(env.DB);
  const a = await person(env, { home: IN_UTICA }), b = await person(env, { home: IN_UTICA }), c = await person(env, { home: IN_NYC });
  env.ADMIN_WALLETS = c.w.address;
  const post = (await a.post("/api/posts", { scope: "city", kind: "meme", body: "hello Utica" })).post;
  await b.post("/api/posts/vote", { id: post.id });
  await b.post("/api/posts/report", { id: post.id, reason: "spam" });
  await b.get("/api/me"); await a.get("/api/me?lite=1"); await b.get("/api/posts?scope=city&kind=meme");
  await b.get("/api/audit"); await b.get("/api/members");
  await reprove(c);
  const queue = await c.get("/api/mod");
  assert.equal(queue.moderator, true);
  assert.ok(!("bios" in queue), "the moderator's queue has no bios key");
  await c.post("/api/mod/hide", { id: post.id, reason: "spam" });
  await tick(env); await tick(env, { sample: false });

  // the only statement that names a counter table is the job's sign-up tidy-up, which is older than profiles and shrugs at a missing table
  const sqlText = env.DB.log.map((x) => x.sql).filter((q) => q !== "DELETE FROM auth_limits WHERE window_start < ?").join("\n");
  assert.ok(env.DB.log.length > 100, "the spy really saw the journey (" + env.DB.log.length + " statements)");
  assert.ok(!/\b(follows|blocks|profile_reports|auth_limits)\b/i.test(sqlText), "no profile table is named in any statement");
  assert.ok(!/\bbio\b/i.test(sqlText), "no bio column is named in any statement");
  assert.ok(!env.DB.log.some((x) => x.params.some((v) => typeof v === "string" && /^pf-/.test(v))), "no profile counter is touched");
  const all = await schemaOf(env.DB);
  for (const t of NEW_TABLES) assert.ok(!all.tables.includes(t), `no table ${t}`);
  assert.ok(!all.columns.includes("bio"), "users has no bio column");
  assert.ok(!(await env.DB.prepare("SELECT id FROM schema_migrations").all()).results.some((r) => /profiles/.test(r.id)));
});

test("flag off: the audit and a moderator clearing a bio do nothing special; /api/mod/bio/clear is simply not there", async () => {
  const env = newWorld();
  const admin = await person(env, { home: IN_UTICA });
  env.ADMIN_WALLETS = admin.w.address;
  await reprove(admin);
  const r = await admin.send("/api/mod/bio/clear", { method: "POST", body: { handle: "x", reason: "spam" } });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "not_enabled");
});

test("the switch is read on every request: on makes the routes live, off makes them dark again at once (the data stays)", async () => {
  const env = newWorld({ PROFILES: " ON " });
  const a = await pfPerson(env, "Alice77", { home: IN_UTICA }), b = await pfPerson(env, "BobBrave", { home: IN_UTICA });
  assert.equal((await a.post("/api/follow", { handle: "BobBrave", follow: true })).ok, true);
  assert.equal((await a.post("/api/me/bio", { bio: "Hi there" })).ok, true);
  assert.equal((await b.get("/api/me")).profilesFlag, true);

  env.PROFILES = "off"; // flipped in the dashboard
  assert.equal((await a.send("/api/follows?list=following")).status, 404);
  const me = await b.get("/api/me");
  assert.ok(!("profilesFlag" in me) && !("counts" in me) && !("bio" in me.user), "dark again, in the very next answer");

  env.PROFILES = "on";
  const again = await a.get("/api/follows?list=following");
  assert.deepEqual(again.users.map((u) => u.handle), ["BobBrave"], "what was saved is still there");
  assert.equal((await a.get("/api/me?lite=1")).user.bio, "Hi there");
});

test("switch on: the first profile request creates exactly the new things, once, and the old tables are untouched", async () => {
  const env = PF();
  const before = await schemaOf(env.DB);
  const a = await person(env, { home: IN_UTICA });
  const mid = await schemaOf(env.DB);
  for (const t of NEW_TABLES) assert.ok(!mid.tables.includes(t), `still no ${t} before any profile request`);
  assert.ok(!mid.columns.includes("bio"));
  assert.equal((await a.get("/api/me")).profilesFlag, true);
  const after1 = await schemaOf(env.DB);
  for (const t of NEW_TABLES) assert.ok(after1.tables.includes(t), `table ${t} now exists`);
  assert.deepEqual(after1.columns.filter((c) => !mid.columns.includes(c)), ["bio"], "users gained only bio");
  assert.deepEqual(after1.tables.filter((t) => !mid.tables.includes(t)).sort(), [...NEW_TABLES].sort());
  assert.ok(before.tables.length <= mid.tables.length);
  const ids = (await env.DB.prepare("SELECT id FROM schema_migrations").all()).results.map((r) => r.id);
  assert.equal(ids.filter((id) => id === PROFILES_MIGRATION.id).length, 1);
  assert.ok(!MIGRATIONS.some((m) => m.id === PROFILES_MIGRATION.id), "never part of the migrations every request runs");
  assert.ok(!after1.tables.includes("signups") && !after1.columns.includes("password_hash"), "nothing of the sign-up v2 comes with it");
});

test("switch on: running the profile schema twice, at the same time, is safe and quiet", async () => {
  const env = PF();
  const results = await Promise.allSettled([ensureProfilesSchema(env.DB), ensureProfilesSchema(env.DB), ensureProfilesSchema(env.DB)]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled"]);
  await ensureProfilesSchema(env.DB);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(PROFILES_MIGRATION.id).first()).n, 1);
});

test("the profile tables upgrade the database exactly as production has it, and keep every row", async () => {
  const db = await prodDb();
  await seedProd(db);
  const before = JSON.stringify((await db.prepare("SELECT * FROM users ORDER BY id").all()).results);
  await ensureProfilesSchema(db);
  const cols = (await db.prepare("PRAGMA table_info(users)").all()).results.map((r) => r.name);
  assert.ok(cols.includes("bio"));
  const after = (await db.prepare("SELECT * FROM users ORDER BY id").all()).results.map((r) => { const { bio, ...rest } = r; assert.equal(bio, null); return rest; });
  assert.equal(JSON.stringify(after), before, "every existing row is exactly as it was (the new column is empty)");
  // a second server running it on the same database, and the sign-up's own tables after it, are both fine
  await ensureProfilesSchema(db);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'auth_limits'").first()).n, 1);
});

test("both switches on: the sign-up's counters table and the profile one are the same table, whichever is made first", async () => {
  const db1 = d1(), db2 = d1();
  await ensureProfilesSchema(db1); await ensureSignupSchema(db1);
  await ensureSignupSchema(db2); await ensureProfilesSchema(db2);
  for (const db of [db1, db2]) {
    const s = await schemaOf(db);
    for (const t of [...NEW_TABLES, "signups"]) assert.ok(s.tables.includes(t), t);
    assert.ok(s.columns.includes("bio") && s.columns.includes("password_hash"));
  }
  // and a world with both switches on serves both
  const env = V2({ PROFILES: "on" });
  assert.equal((await browser(env).get("/api/me")).profilesFlag, true);
  assert.equal((await browser(env).get("/api/me")).signupFlow, "v2");
});

test("switch on, tables cannot be made: only the profile routes answer 503, /api/me stays whole, and it recovers on its own", async () => {
  const env = PF();
  const broken = { on: true };
  env.DB = brokenProfilesDb(env.DB, broken);
  const a = await person(env, { home: IN_UTICA });
  const out = browser(env);
  // a signed-out visitor is told to sign in and never makes the database try
  assert.equal((await out.send("/api/profile?u=x")).status, 401);
  const noisy = console.error; const logged = [];
  console.error = (...args) => { logged.push(args.join(" ")); };
  try {
    for (const [method, path] of ROUTES.filter(([, p]) => !/portfolio|mod\/bio/.test(p))) {
      const r = await a.send(path, { method, body: method === "POST" ? { handle: "x", follow: true, block: true, bio: "hi" } : undefined });
      assert.equal(r.status, 503, `${method} ${path}`);
      assert.equal((await r.json()).error, "profiles_unavailable");
    }
    const me = await a.get("/api/me");
    assert.equal(me.signedIn, true, "the dashboard still works");
    assert.ok(!("profilesFlag" in me) && !("counts" in me) && !("bio" in me.user), "the page sees a site without profiles");
    assert.equal((await a.get("/api/me?lite=1")).user.bio, undefined);
  } finally { console.error = noisy; }
  assert.ok(logged.every((l) => !/[1-9A-HJ-NP-Za-km-z]{32,}/.test(l)), "no address in the log");
  assert.equal((await a.get("/api/me/portfolio")).ok, true, "the portfolio needs none of the new tables");
  assert.equal((await a.get("/api/posts?scope=city&kind=meme")).ok, true, "the feeds are not affected");
  broken.on = false; // the database is back
  assert.equal((await a.get("/api/follows?list=following")).ok, true, "the very next request makes the tables and works");
  assert.equal((await a.get("/api/me")).profilesFlag, true);
});

test("switch on: a POST from another site is refused before anything else, and a GET needs no Origin", async () => {
  const env = PF();
  const a = await pfPerson(env, "Alice77", { home: IN_UTICA });
  for (const path of ["/api/follow", "/api/block", "/api/me/bio", "/api/profile/report", "/api/mod/bio/clear"]) {
    for (const origin of [null, "https://evil.example", ORIGIN.replace("https", "http") + ".evil"]) {
      const r = await a.send(path, { method: "POST", body: {}, origin });
      assert.equal(r.status, 403, `${path} ${origin}`);
      assert.equal((await r.json()).error, "wrong_origin");
    }
  }
  for (const path of ["/api/profile?u=Alice77", "/api/members/search?q=al", "/api/follows?list=followers", "/api/me/blocks", "/api/me/portfolio"]) {
    assert.equal((await a.send(path, { origin: null })).status, 200, path);
  }
});

test("switch on: the wrong method gets 405, an unknown sub-path the old not_found", async () => {
  const env = PF();
  const a = await pfPerson(env, "Alice77", { home: IN_UTICA });
  for (const [method, path] of ROUTES) {
    const wrong = method === "GET" ? "POST" : "GET";
    const r = await a.send(path, { method: wrong, body: wrong === "POST" ? {} : undefined });
    assert.equal(r.status, 405, `${wrong} ${path}`);
    assert.deepEqual(await r.json(), { error: "method_not_allowed" });
  }
  for (const path of ["/api/profile/nothing", "/api/members/", "/api/follow/x", "/api/messages", "/api/dm", "/api/inbox", "/api/profile/message"]) {
    const r = await a.send(path);
    assert.equal(r.status, 404, path);
    assert.deepEqual(await r.json(), { error: "not_found" }, path + ": there is no messaging of any kind");
  }
});

test("sanity: the holder and chain helpers used by the other profile tests are wired (a launched world)", async () => {
  const env = PF({ VICINITY_MINT: MINT });
  const a = await pfPerson(env, "Alice77", { home: IN_NYC, holds: 5 });
  assert.ok(a.handle);
  setHolding(a.w.address, 7);
  assert.equal((await a.get("/api/me?lite=1")).user.handle, "Alice77");
});
