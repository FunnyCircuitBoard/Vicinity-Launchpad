// Google sign-in for an existing account (src/logins.js; src/auth.js handleGoogleAdd and the callback's link marker; src/me.js
// handleGoogleRemove) and the words of no_account (public/signup.js). The owner made his account with an e-mail, linked his wallet,
// saved his Gmail as a contact e-mail, then pressed "Log in with Google" and was told that no account uses "this wallet". Now the page
// names the login that found nobody and says what to do, and a member can add Google from the Profile ("Google sign-in"), after which
// "Log in with Google" signs in to that very account. Google gives an account number only (scope "openid profile"): nothing here is
// ever matched by an e-mail address.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { V2, advance, browser, loginBody, newWorld, person, realClock, useClock } from "./helpers/world.js";
import { GOOD_PASSWORD, fakeGoogle, finish, journey, linkDirect, member, memberWithWallet, one, outbox, rows, userOf } from "./helpers/signup.js";
import { ADDR, UA, memberMe, openDashboard } from "./helpers/dashpage.js";
import { fakeWallet } from "./helpers/connectpage.js";
import { sha256 } from "../src/http.js";
import { addGoogle, dropLogins } from "../src/logins.js";
import { d1 } from "./helpers/d1.js";
import { columnsOf, dumpTables, prodDb, seedProd, tablesOf } from "./helpers/prod-schema.js";
import { LOGINS_MIGRATION, ensureLoginsSchema } from "../src/store.js";

const signupPage = {};
vm.runInNewContext(readFileSync(new URL("../public/signup.js", import.meta.url), "utf8"), { window: signupPage });
const P = signupPage.VSignup.pure;
const plain = (x) => JSON.parse(JSON.stringify(x));

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const nowIso = () => new Date(Date.now()).toISOString();
const count = async (sql, ...p) => (await one(env.DB, `SELECT COUNT(*) AS n FROM ${sql}`, ...p)).n;
/** Every added sign-in (none while the table was never made). */
async function added(db = env.DB) {
  try { return (await rows(db, "SELECT user_id, provider, provider_id FROM user_logins ORDER BY user_id")).map((r) => ({ ...r })); }
  catch (e) { if (/no such table/.test(String(e))) return []; throw e; }
}
/** The Profile's Add: POST /api/me/google/add. { status, body, state } (state: the one in Google's address, when it answered one). */
async function startAdd(b) {
  const r = await b.send("/api/me/google/add", { method: "POST", body: {} });
  const body = await r.json();
  return { status: r.status, body, state: body.ok ? new URL(body.url).searchParams.get("state") : null };
}
/** Google sends the person back as Google account `sub`: where the callback lands. */
const backFromGoogle = async (b, state, sub) => (await b.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: fakeGoogle(sub) })).headers.get("location");
/** Add, then back from Google as `sub`. */
async function addVia(b, sub) {
  const s = await startAdd(b);
  return { ...s, to: s.state ? await backFromGoogle(b, s.state, sub) : null };
}
/** "Log in with Google" on the Log in tab (no marker): where Google's answer lands. */
async function googleLogin(b, sub) {
  const st = await b.send("/api/auth/google/start");
  return backFromGoogle(b, new URL(st.headers.get("location")).searchParams.get("state"), sub);
}
const passwordLogin = (b, email) => b.send("/api/auth/email/login", { method: "POST", body: { email, password: GOOD_PASSWORD } });
const logout = (b) => b.send("/api/auth/logout", { method: "POST", body: {} });
/** A browser edits its own OAuth cookie: a plain log-in trip made to look like "Add Google" for the session it holds. */
async function forgeMarker(b) {
  const st = await b.send("/api/auth/google/start");
  const tag = (await sha256(`google-link:${await sha256(b.jar.get("vs"))}`)).slice(0, 22);
  b.jar.set("vo", `${b.jar.get("vo")}.l.${tag}`);
  return new URL(st.headers.get("location")).searchParams.get("state");
}
/** The owner's account: made with an e-mail and a password, his wallet linked, his Gmail saved as the contact e-mail. Signed in, just now. */
async function owner(email = "owner@icloud.example") {
  const m = await member(env, box, { via: "email", email });
  await linkDirect(env, m);
  m.u = await userOf(env, m);
  await env.DB.prepare("UPDATE users SET contact_email = 'owner@gmail.example' WHERE id = ?").bind(m.u.id).run();
  return m;
}
function capture() {
  const lines = [], orig = { log: console.log, error: console.error };
  console.log = (...a) => lines.push(a.map(String).join(" ")); console.error = (...a) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => Object.assign(console, orig) };
}

/* ---------- the owner's case, end to end ---------- */

test("the owner's case: an e-mail account with a wallet adds Google from the Profile, and after logging out 'Log in with Google' lands in HIS account", async () => {
  const m = await owner();
  const log = capture();
  try {
    // before: Google finds nobody, and the page is told it was a GOOGLE login (its words are about the Google account, not a wallet)
    const before = browser(env);
    assert.equal(await googleLogin(before, "owner-sub"), "/connect?error=no_account&login=google");
    assert.equal(before.has("vs"), false, "nobody is signed in");
    assert.equal((await m.b.get("/api/me")).user.googleAdded, false, "the Profile row: not added yet");
    const users = await count("users");

    const r = await addVia(m.b, "owner-sub");
    assert.equal(r.status, 200);
    const google = new URL(r.body.url);
    assert.equal(google.origin + google.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(google.searchParams.get("scope"), "openid profile", "no e-mail address is asked of Google");
    assert.equal(r.to, "/dashboard?google=linked#profile", "back to the Profile, with a short success note");
    assert.deepEqual(await added(), [{ user_id: m.u.id, provider: "google", provider_id: "owner-sub" }]);
    assert.equal(await count("users"), users, "no account was made");
    assert.equal(m.b.has("vo"), false, "the OAuth cookie is spent");
    const me = await m.b.get("/api/me");
    assert.deepEqual([me.signedIn, me.user.id, me.user.googleAdded], [true, m.u.id, true], "the same session, the same account");
    assert.ok(!JSON.stringify(me).includes("owner-sub"), "/api/me says whether, never which Google account");

    // log out, then Log in with Google: his own account, his wallet, his e-mail login
    await logout(m.b);
    assert.equal((await m.b.get("/api/me?lite=1")).signedIn, false);
    assert.equal(await googleLogin(m.b, "owner-sub"), "/dashboard");
    const back = await m.b.get("/api/me?lite=1");
    assert.deepEqual([back.signedIn, back.user.id, back.user.wallet, back.user.provider], [true, m.u.id, m.w.address, "email"]);
    const elsewhere = browser(env);
    assert.equal(await googleLogin(elsewhere, "owner-sub"), "/dashboard", "from any browser");
    assert.equal((await elsewhere.get("/api/me?lite=1")).user.id, m.u.id);
    assert.equal(await count("users"), users, "still one account");
    assert.equal((await passwordLogin(browser(env), m.email)).status, 200, "the way the account was made still works");
  } finally { log.restore(); }
  assert.ok(log.lines.some((l) => l === "google sign-in added"), "the add is logged, plainly");
  assert.ok(!log.lines.some((l) => l.includes("owner-sub")), "no log line names the Google account: " + log.lines.join(" | "));
});

/* ---------- who may add ---------- */

test("Add is refused without a signed-in member, from another site, by a link (GET) and with the switch off: nothing is started", async () => {
  const anon = browser(env);
  const a = await startAdd(anon);
  assert.deepEqual([a.status, a.body.error], [401, "sign_in"]);
  assert.equal(anon.has("vo"), false);
  const m = await owner();
  const foreign = await m.b.send("/api/me/google/add", { method: "POST", body: {}, origin: "https://evil.example" });
  assert.deepEqual([foreign.status, (await foreign.json()).error], [403, "wrong_origin"]);
  assert.equal((await m.b.send("/api/me/google/add")).status, 405, "a link or an image can't start it");
  assert.equal(m.b.has("vo"), false, "no trip to Google was prepared");
  const off = browser(newWorld());
  for (const path of ["/api/me/google/add", "/api/me/google/remove"]) {
    const r = await off.send(path, { method: "POST", body: {} });
    assert.deepEqual([r.status, (await r.json()).error], [404, "not_enabled"], path);
  }
});

test("Add and Remove are refused to a session a wallet from another app made in the last 7 days (link_new); a marker forged into its own cookie adds nothing either", async () => {
  const m = await owner();
  // the wallet came from another app (src/walletlink.js linkWindow) and signed in to a browser since: that browser's session is locked
  await env.DB.prepare("UPDATE users SET wallet_via = 'app', wallet_at = ? WHERE id = ?").bind(nowIso(), m.u.id).run();
  advance(60_000);
  const app = browser(env);
  assert.equal((await app.post("/api/auth/wallet", await loginBody(m.w))).ok, true);
  const r = await startAdd(app);
  assert.deepEqual([r.status, r.body.error], [403, "link_new"]);
  assert.equal(app.has("vo"), false);
  assert.equal((await app.post("/api/me/google/remove")).error, "link_new");
  const state = await forgeMarker(app);
  assert.equal(await backFromGoogle(app, state, "stranger-sub"), "/dashboard?google=link_new#profile");
  assert.deepEqual(await added(), []);
  // the owner's own older browser is not locked
  assert.equal((await addVia(m.b, "owner-sub")).to, "/dashboard?google=linked#profile");
});

test("an old session (no login and no wallet proof in the last 30 minutes) logs in again first; the marker forged into a stale session's cookie adds nothing", async () => {
  const m = await owner();
  advance(45 * 60_000);
  const r = await startAdd(m.b);
  assert.deepEqual([r.status, r.body], [403, { ok: false, error: "reprove", relogin: true }]);
  assert.equal(m.b.has("vo"), false);
  const state = await forgeMarker(m.b);
  assert.equal(await backFromGoogle(m.b, state, "stranger-sub"), "/dashboard?google=reprove#profile", "the callback checks again (with the 10 minutes at Google)");
  assert.deepEqual(await added(), []);
  // a new login (the password here) is fresh: Add works for 30 minutes
  assert.equal((await passwordLogin(m.b, m.email)).status, 200);
  assert.equal((await addVia(m.b, "owner-sub")).to, "/dashboard?google=linked#profile");
  // and a wallet proof in the last 30 minutes counts too (another member, the same old session)
  const n = await owner("second@icloud.example");
  advance(45 * 60_000);
  assert.equal((await startAdd(n.b)).body.error, "reprove");
  assert.equal((await n.b.post("/api/auth/reprove", await loginBody(n.w))).ok, true);
  assert.equal((await addVia(n.b, "second-sub")).to, "/dashboard?google=linked#profile");
});

/* ---------- the rules ---------- */

test("a Google account that already logs in to ANOTHER account is refused (google_taken): as that account's main login, or added there", async () => {
  const bob = await member(env, box, { via: "google", sub: "bob-sub" });
  const carol = await member(env, box, { via: "email", email: "carol@example.com" });
  carol.u = await userOf(env, carol);
  const m = await owner();
  const users = await count("users");
  assert.equal((await addVia(m.b, "bob-sub")).to, "/dashboard?google=google_taken#profile", "bob made his account with it");
  assert.equal((await addVia(carol.b, "carol-sub")).to, "/dashboard?google=linked#profile");
  assert.equal((await addVia(m.b, "carol-sub")).to, "/dashboard?google=google_taken#profile", "carol added it to hers");
  assert.deepEqual(await added(), [{ user_id: carol.u.id, provider: "google", provider_id: "carol-sub" }]);
  assert.equal(await count("users"), users);
  // their logins still land in their own accounts
  const b1 = browser(env), b2 = browser(env);
  assert.equal(await googleLogin(b1, "bob-sub"), "/dashboard");
  assert.equal((await b1.get("/api/me?lite=1")).user.id, (await userOf(env, bob)).id);
  assert.equal(await googleLogin(b2, "carol-sub"), "/dashboard");
  assert.equal((await b2.get("/api/me?lite=1")).user.id, carol.u.id);
});

test("one Google sign-in per account: the same one again is a quiet success, another one is refused until the first is removed; an account made with Google has its own", async () => {
  const m = await owner();
  // three browsers of the same account start before any comes back (all fresh)
  const tab2 = browser(env), tab3 = browser(env);
  assert.equal((await passwordLogin(tab2, m.email)).status, 200);
  assert.equal((await passwordLogin(tab3, m.email)).status, 200);
  const s1 = await startAdd(m.b), s2 = await startAdd(tab2), s3 = await startAdd(tab3);
  assert.equal(await backFromGoogle(m.b, s1.state, "owner-sub"), "/dashboard?google=linked#profile");
  assert.equal(await backFromGoogle(tab2, s2.state, "owner-sub"), "/dashboard?google=already#profile", "the same Google account again: nothing to do");
  assert.equal(await backFromGoogle(tab3, s3.state, "other-sub"), "/dashboard?google=has_google#profile", "another one is never added beside it, nor swapped in quietly");
  assert.deepEqual(await added(), [{ user_id: m.u.id, provider: "google", provider_id: "owner-sub" }]);
  const again = await startAdd(m.b);
  assert.deepEqual([again.status, again.body.error], [409, "has_google"], "Add itself says so now");
  // remove it, then the other one can be added
  assert.deepEqual(await m.b.post("/api/me/google/remove"), { ok: true, removed: true });
  assert.equal((await addVia(m.b, "other-sub")).to, "/dashboard?google=linked#profile");
  assert.deepEqual(await added(), [{ user_id: m.u.id, provider: "google", provider_id: "other-sub" }]);
  // an account made with Google: Add has nothing to add
  const bob = await member(env, box, { via: "google", sub: "bob-sub" });
  const b = await startAdd(bob.b);
  assert.deepEqual([b.status, b.body.error], [409, "has_google"]);
});

test("two accounts adding the same Google account at the same moment: one wins, the other is told google_taken; one account adding two at once keeps one", async () => {
  const db = env.DB;
  const a = await owner("a@example.com"), b = await owner("b@example.com");
  const now = Date.now();
  const both = await Promise.all([addGoogle(db, a.u.id, "same-sub", now), addGoogle(db, b.u.id, "same-sub", now)]);
  assert.deepEqual(plain(both.map((r) => r.ok ? "ok" : r.error).sort()), ["google_taken", "ok"]);
  assert.equal((await added()).length, 1);
  const c = await owner("c@example.com");
  const two = await Promise.all([addGoogle(db, c.u.id, "c-1", now), addGoogle(db, c.u.id, "c-2", now)]);
  assert.deepEqual(plain(two.map((r) => r.ok ? "ok" : r.error).sort()), ["has_google", "ok"]);
  assert.equal((await added()).filter((r) => r.user_id === c.u.id).length, 1);
});

test("the INSERT itself refuses a Google account that became some account's MAIN login a moment after the look", async () => {
  const m = await owner();
  const real = env.DB;
  let fired = false;
  const wrap = (s) => ({ ...s, bind: (...p) => wrap(s.bind(...p)), first: async () => {
    const r = await s.first();
    if (!fired) { fired = true; await real.prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (NULL, 'google', 'raced-sub', 'Racer9', ?)").bind(nowIso()).run(); }
    return r;
  } });
  // the last look (does this account have a Google sign-in?) is followed by someone making an account with that Google account
  const db = { ...real, prepare: (sql) => (sql === "SELECT 1 AS x FROM user_logins WHERE user_id = ? AND provider = 'google'" ? wrap(real.prepare(sql)) : real.prepare(sql)) };
  const r = await addGoogle(db, m.u.id, "raced-sub", Date.now());
  assert.ok(fired, "the race happened");
  assert.deepEqual(plain(r), { error: "google_taken" });
  assert.deepEqual(await added(), []);
});

/* ---------- the callback adds nothing it should not ---------- */

test("the callback adds nothing without the marker, for a session that is not the one that asked, for another member on that browser, or once signed out", async () => {
  const m = await owner();
  const users = await count("users");
  // no marker: "Log in with Google" while signed in changes nothing (the dashboard, no row, nobody else's account)
  assert.equal(await googleLogin(m.b, "plain-sub"), "/dashboard");
  assert.equal((await m.b.get("/api/me?lite=1")).user.id, m.u.id);
  // logged out and in again between Add and Google's answer: another session, nothing is added
  const s1 = await startAdd(m.b);
  await logout(m.b);
  assert.equal((await passwordLogin(m.b, m.email)).status, 200);
  assert.equal(await backFromGoogle(m.b, s1.state, "owner-sub"), "/dashboard?google=login_expired#profile");
  // another member logs in on that browser meanwhile: nothing is added to either account
  const s2 = await startAdd(m.b);
  const dana = await member(env, box, { via: "email", email: "dana@example.com" });
  m.b.jar.set("vs", dana.b.jar.get("vs"));
  assert.equal(await backFromGoogle(m.b, s2.state, "owner-sub"), "/dashboard?google=login_expired#profile");
  // signed out meanwhile: the log-in page, nobody signed in, nothing added
  assert.equal((await passwordLogin(m.b, m.email)).status, 200);
  const s3 = await startAdd(m.b);
  await logout(m.b);
  assert.equal(await backFromGoogle(m.b, s3.state, "owner-sub"), "/connect?error=login_expired");
  assert.equal(m.b.has("vs"), false, "and no session was made");
  // Google said no, or the trip was tampered with: back to the Profile, nothing added
  assert.equal((await passwordLogin(m.b, m.email)).status, 200);
  await startAdd(m.b);
  assert.equal((await m.b.send("/api/auth/google/callback?error=access_denied")).headers.get("location"), "/dashboard?google=login_cancelled#profile");
  const s4 = await startAdd(m.b);
  assert.equal(await backFromGoogle(m.b, "not-" + s4.state, "owner-sub"), "/dashboard?google=login_expired#profile");
  assert.deepEqual(await added(), []);
  assert.equal(await count("users"), users + 1, "only dana's own sign-up made an account");
});

/* ---------- remove ---------- */

test("Remove takes the added Google sign-in off: 'Log in with Google' answers no_account with the Google words again; the account's own login stays", async () => {
  const m = await owner();
  assert.equal((await addVia(m.b, "owner-sub")).to, "/dashboard?google=linked#profile");
  const foreign = await m.b.send("/api/me/google/remove", { method: "POST", body: {}, origin: "https://evil.example" });
  assert.deepEqual([foreign.status, (await foreign.json()).error], [403, "wrong_origin"]);
  assert.equal((await browser(env).post("/api/me/google/remove")).error, "sign_in");
  assert.equal((await added()).length, 1, "neither of those removed anything");
  assert.deepEqual(await m.b.post("/api/me/google/remove"), { ok: true, removed: true });
  assert.deepEqual(await added(), []);
  assert.equal((await m.b.get("/api/me")).user.googleAdded, false);
  const to = await googleLogin(browser(env), "owner-sub");
  assert.equal(to, "/connect?error=no_account&login=google");
  const bounce = P.bounceFor(new URL(to, "https://x").searchParams.get("error"), new URL(to, "https://x").searchParams.get("login"));
  assert.match(bounce.text, /^No Vicinity account uses this Google account\./, "the page speaks of the Google account");
  assert.deepEqual(await m.b.post("/api/me/google/remove"), { ok: true, removed: false }, "nothing left to remove");
  assert.equal((await passwordLogin(browser(env), m.email)).status, 200, "the e-mail login is untouched");
  // an account made with Google: Remove never touches its main login
  const bob = await member(env, box, { via: "google", sub: "bob-sub" });
  assert.deepEqual(await bob.b.post("/api/me/google/remove"), { ok: true, removed: false });
  assert.equal(await googleLogin(browser(env), "bob-sub"), "/dashboard");
});

/* ---------- the new sign-up ---------- */

test("the new sign-up never makes a second account for a Google account a member added: Continue with Google signs in to that account, and a sign-up that recorded it earlier is refused", async () => {
  const m = await owner();
  // a sign-up that recorded this Google account BEFORE the owner added it, and stopped before the account was made
  const early = browser(env);
  await journey(early, box, { via: "google", until: "terms" });
  await env.DB.prepare("UPDATE signups SET provider = 'google', provider_id = 'owner-sub', identity_name = 'Sam', identity_at = ?").bind(nowIso()).run();
  assert.equal((await addVia(m.b, "owner-sub")).to, "/dashboard?google=linked#profile");
  const users = await count("users");
  const r = await finish(early);
  assert.deepEqual([r.ok, r.error], [false, "social_taken"]);
  assert.equal(await count("users"), users);
  // a new person's sign-up with that Google account ("Continue with Google" on New here): it signs in to the owner's account
  const late = browser(env);
  const j = await journey(late, box, { via: "google", sub: "owner-sub" });
  assert.equal(j.account.to, "/dashboard", "an existing person is signed in, not welcomed");
  assert.equal((await late.get("/api/me?lite=1")).user.id, m.u.id);
  assert.equal(await count("users"), users, "no second account");
});

test("the finish checks it again INSIDE its transaction: a Google account added a moment after the finish looked makes no account", async () => {
  const m = await owner();
  const b = browser(env);
  await journey(b, box, { via: "google", until: "terms" });
  await env.DB.prepare("UPDATE signups SET provider = 'google', provider_id = 'late-sub', identity_name = 'Sam', identity_at = ?").bind(nowIso()).run();
  const real = env.DB;
  let fired = false;
  const wrap = (s) => ({ ...s, bind: (...p) => wrap(s.bind(...p)), first: async () => {
    const r = await s.first();
    if (!fired) { fired = true; await real.prepare("INSERT INTO user_logins (user_id, provider, provider_id, created_at) VALUES (?, 'google', 'late-sub', ?)").bind(m.u.id, nowIso()).run(); }
    return r;
  } });
  env.DB = { ...real, prepare: (sql) => (sql === "SELECT user_id AS id FROM user_logins WHERE provider = 'google' AND provider_id = ?" ? wrap(real.prepare(sql)) : real.prepare(sql)) };
  const users = await count("users");
  let r;
  try { r = await finish(b); } finally { env.DB = real; }
  assert.ok(fired, "the member added it between the look and the transaction");
  assert.deepEqual([r.ok, r.error], [false, "social_taken"]);
  assert.equal(await count("users"), users);
  assert.equal(await count("sessions WHERE user_id IS NOT NULL AND user_id != ?", m.u.id), 0, "and nobody got a session for it");
});

/* ---------- the lifecycle ---------- */

test("an account that is deleted takes its added sign-ins with it (the admin test lab's reset); the audit trail never names the Google account", async () => {
  env = V2({ SITE_MODE: "preview" });
  const boss = await memberWithWallet(env, box, { via: "email", email: "boss@example.com" });
  env.ADMIN_WALLETS = boss.w.address;
  boss.u = await userOf(env, boss);
  assert.equal((await boss.b.post("/api/admin/test/seed")).ok, true);
  const lab = (await rows(env.DB, "SELECT row_id FROM admin_test WHERE table_name = 'users' ORDER BY row_id")).map((r) => r.row_id);
  assert.equal(lab.length, 8);
  for (const [i, id] of lab.entries()) assert.equal((await addGoogle(env.DB, id, `lab-sub-${i}`, Date.now())).ok, true);
  assert.equal((await addVia(boss.b, "boss-sub")).to, "/dashboard?google=linked#profile");
  assert.equal((await added()).length, 9);
  assert.equal((await boss.b.post("/api/admin/test/reset", { confirm: "RESET" })).ok, true);
  assert.deepEqual(await added(), [{ user_id: boss.u.id, provider: "google", provider_id: "boss-sub" }], "only the real member's stays");
  assert.ok(!JSON.stringify(await rows(env.DB, "SELECT * FROM admin_audit")).includes("-sub"), "no audit row names a Google account");
  // before the table exists there is nothing to delete, and nothing breaks
  const fresh = d1();
  await dropLogins(fresh, 1);
  assert.deepEqual(await added(fresh), []);
});

test("the table on a database shaped like production: made once, nothing else touched, safe to run again and from a second server", async () => {
  const db = await prodDb();
  await seedProd(db);
  const spec = { users: ["id", "wallet", "provider", "provider_id", "handle"], sessions: ["id", "user_id", "wallet"] };
  const before = { tables: await tablesOf(db), rows: await dumpTables(db, spec) };
  // a second server: another handle on the same database, with its own memory of what it already made (it finds the record)
  await ensureLoginsSchema(db);
  await ensureLoginsSchema(db);
  await ensureLoginsSchema({ ...db });
  assert.deepEqual(await tablesOf(db), [...before.tables, "user_logins"].sort());
  assert.deepEqual(await columnsOf(db, "user_logins"), ["user_id", "provider", "provider_id", "created_at"]);
  assert.equal(await dumpTables(db, spec), before.rows, "no existing row changed");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(LOGINS_MIGRATION.id).first()).n, 1);
  // production's Google member logs in exactly as before, and an e-mail member can add Google
  assert.equal((await addGoogle(db, 2, "bea-google", Date.now())).ok, true);
  assert.deepEqual(plain(await addGoogle(db, 2, "google-sub-1", Date.now())), { error: "google_taken" }, "Ann's Google account is Ann's");
  assert.deepEqual(plain(await addGoogle(db, 2, "bea-google-2", Date.now())), { error: "has_google" }, "one per account");
  assert.deepEqual(plain(await addGoogle(db, 1, "bea-google", Date.now())), { error: "has_google" }, "an account made with Google has its own");
});

test("with the switch off a Google log-in only reads: no user_logins table is ever made", async () => {
  env = newWorld();
  await person(env);
  const names = (await rows(env.DB, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
  assert.ok(!names.includes("user_logins"), names.join());
});

/* ---------- the words (public/signup.js) ---------- */

test("no_account: each login that finds nobody gets its own words, and each says what to do", () => {
  const google = plain(P.bounceFor("no_account", "google"));
  assert.equal(google.tab, "login", "the Google button is on the Log in tab: the person stays there, the way in is one tap away");
  assert.equal(google.text, P.ERR["no_account:google"]);
  assert.match(google.text, /^No Vicinity account uses this Google account\./);
  assert.match(google.text, /Made yours with e-mail or a wallet\? Log in that way here, then add Google sign-in in your Profile\./);
  assert.match(google.text, /A Gmail saved as a contact e-mail can't log you in\./, "the owner's exact confusion");
  const email = P.errText({ ok: false, error: "no_account", login: "email" }, "login");
  assert.equal(email, P.ERR["no_account:email"], "the server's login wins over the page's context");
  assert.match(email, /^No Vicinity account logs in with this e-mail\./);
  assert.match(email, /contact e-mail saved in a Profile can't log you in/);
  const wallet = P.errText({ ok: false, error: "no_account" });
  assert.equal(wallet, P.ERR.no_account, "without a login it is a wallet's answer, as the server always sent it");
  assert.match(wallet, /^No Vicinity account uses this wallet yet\./);
  assert.match(wallet, /link this wallet from your dashboard/);
  assert.equal(P.bounceFor("no_account").tab, "new", "a bare no_account still opens New here");
  assert.equal(P.errText("no_account", "something-else"), wallet, "an unknown login falls back to the wallet's words");
  const all = [google.text, email, wallet];
  assert.equal(new Set(all).size, 3);
  for (const t of all) {
    assert.ok(t.length < 200, t);
    assert.match(t, /[.!?]$/);
    assert.doesNotMatch(t, /<|>|\$\{|undefined|null|NaN/);
    assert.doesNotMatch(t, /\p{Extended_Pictographic}/u);
  }
  assert.doesNotMatch(google.text + email, /this wallet/, "only the wallet's own answer speaks of a wallet it can't find");
});

/* ---------- the Profile's row (public/dashboard.js) ---------- */

const emailMe = (o = {}) => { const me = memberMe({ wallet: ADDR }); Object.assign(me.user, { provider: "email", googleAdded: false, ...o }); return me; };
const GOOGLE_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=gid&state=s1";

test("the Profile's Google sign-in row: Add goes to Google; an old session is asked to log in again; Remove takes it off", async () => {
  const p = await openDashboard({ me: emailMe(), api: async (path) => (path === "/api/me/google/add" ? { ok: true, url: GOOGLE_URL } : undefined) });
  p.win.V.openProfile(); await p.flush();
  assert.equal(p.$("#google-sec").hidden, false);
  assert.equal(p.text("#profile-google-meta"), "Not added");
  assert.equal(p.text("#google-desc"), "Log in with Google too, as well as the way you made your account.");
  const add = p.$$("#google-view button");
  assert.deepEqual(add.map((b) => b.textContent), ["Add"]);
  await p.tap(add[0]);
  assert.deepEqual(p.callsTo("/api/me/google/add").map((c) => c.method), ["POST"]);
  assert.ok(p.assigned.includes(GOOGLE_URL), "off to Google's own page");

  const q = await openDashboard({ me: emailMe(), api: async (path) => (path === "/api/me/google/add" ? { ok: false, error: "reprove", relogin: true, _status: 403 } : undefined) });
  q.win.V.openProfile(); await q.flush();
  await q.tap(q.$$("#google-view button")[0]);
  assert.match(q.text("#google-err"), /^For your safety, adding a way to log in needs a fresh login\./);
  const again = q.$$("#google-err button");
  assert.deepEqual(again.map((b) => b.textContent), ["Log in again"]);
  await q.tap(again[0]);
  assert.equal(q.callsTo("/api/auth/logout").length, 1);
  assert.ok(q.assigned.includes("/connect?mode=login&error=relogin_confirm"));
  assert.ok(!q.assigned.some((u) => /accounts\.google\.com/.test(u)), "nowhere near Google");

  const r = await openDashboard({ me: emailMe({ googleAdded: true }), api: async (path) => (path === "/api/me/google/remove" ? { ok: true, removed: true } : undefined) });
  r.win.V.openProfile(); await r.flush();
  assert.equal(r.text("#profile-google-meta"), "Added");
  const remove = r.$$("#google-view button");
  assert.deepEqual(remove.map((b) => b.textContent), ["Remove"]);
  await r.tap(remove[0]);
  assert.match(r.confirms[0], /^Remove Google sign-in\?/);
  assert.deepEqual(r.callsTo("/api/me/google/remove").map((c) => c.method), ["POST"]);
  assert.equal(r.text("#profile-google-meta"), "Not added");
  assert.ok(r.toasts.includes("Google sign-in removed"));
});

test("the row for an account made with Google has nothing to add, it is not there with the old sign-up, Add is not offered inside a wallet app (Google refuses to run there), and the e-mail row says a contact e-mail is no login", async () => {
  const p = await openDashboard({ me: memberMe({ wallet: ADDR }) }); // provider google
  p.win.V.openProfile(); await p.flush();
  assert.equal(p.text("#profile-google-meta"), "On");
  assert.equal(p.$$("#google-view button").length, 0);
  assert.match(p.text("#email-desc"), /not a way to log in/);
  const old = memberMe({ wallet: ADDR }); delete old.signupFlow;
  const q = await openDashboard({ me: old });
  q.win.V.openProfile(); await q.flush();
  assert.equal(q.$("#google-sec").hidden, true);
  const app = await openDashboard({ ua: UA.phantomApp, me: emailMe(), wallets: [fakeWallet("Phantom").wallet], storage: { "vicinity:inapp-tip": "1" } });
  app.win.V.openProfile(); await app.flush();
  assert.equal(app.text("#profile-google-meta"), "Not added");
  assert.equal(app.$$("#google-view button").length, 0, "no Add: Google's page would refuse this browser");
  assert.equal(app.text("#google-desc"), "Google doesn't work inside a wallet app. To add it, open your dashboard in Safari or Chrome.");
});

test("back from Google (?google=): a success is a toast, a refusal is said in the row in plain words, and the note leaves the address bar", async () => {
  const ok = await openDashboard({ me: emailMe({ googleAdded: true }), search: "google=linked" });
  assert.ok(ok.toasts.includes("Google sign-in added. You can now log in with Google too."), ok.toasts.join());
  assert.ok(!ok.addressBar[ok.addressBar.length - 1].includes("google="), "read once, then gone");
  const taken = await openDashboard({ me: emailMe(), search: "google=google_taken" });
  assert.equal(taken.text("#google-err"), "That Google account already logs in to another Vicinity account, so it can't be added here. Pick another Google account.");
  assert.equal(taken.$("#google-err").hidden, false);
  assert.equal(taken.$("#google-sec").open, true, "the row is open on its note");
  const stale = await openDashboard({ me: emailMe(), search: "google=reprove" });
  assert.deepEqual(stale.$$("#google-err button").map((b) => b.textContent), ["Log in again"]);
  const odd = await openDashboard({ me: emailMe(), search: "google=%3Cb%3Ehi" });
  assert.equal(odd.$("#google-err").hidden, true, "a code the page does not know says nothing");
});
