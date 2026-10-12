// Google sign-in for an existing account (src/logins.js; src/auth.js handleGoogleAdd and the callback's link marker; src/me.js
// handleGoogleRemove) and the words of no_account (public/signup.js). The owner made his account with an e-mail, linked his wallet,
// saved his Gmail as a contact e-mail, then pressed "Log in with Google" and was told that no account uses "this wallet". Now the page
// names the login that found nobody and says what to do, and a member can add Google from the Profile ("Google sign-in"), after which
// "Log in with Google" signs in to that very account. Google gives an account number only (scope "openid profile"): nothing here is
// ever matched by an e-mail address. Adding a way to log in follows the rule of a password change (the current password, or a fresh
// wallet proof; the login alone only for an account with neither): a session left open on a shared computer never adds one on its own.
// The owner is e-mailed when one is added; a new password, and Remove, log the other browsers out and leave no added Google behind.
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
import { googleAddedEmail } from "../src/mail.js";
import { page as connectPage, submit, tap as tapFake } from "./helpers/fakedom.js";
import { newEvent } from "./helpers/pagedom.js";

const signupPage = {};
vm.runInNewContext(readFileSync(new URL("../public/signup.js", import.meta.url), "utf8"), { window: signupPage });
const P = signupPage.VSignup.pure;
const plain = (x) => JSON.parse(JSON.stringify(x));

let env, box, mails;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); mails = []; });
after(() => realClock());
/** Google's token endpoint answers as `sub`; a mail the server sends meanwhile (the "Google sign-in was added" notice) lands in `mails`. */
const googleAs = (sub) => async (url, init) => {
  if (String(url) !== "https://api.resend.com/emails") return fakeGoogle(sub)(url, init);
  const b = JSON.parse(init.body);
  mails.push({ to: b.to[0], subject: b.subject, text: b.text, html: b.html });
  return new Response("{}", { status: 200 });
};

const nowIso = () => new Date(Date.now()).toISOString();
const count = async (sql, ...p) => (await one(env.DB, `SELECT COUNT(*) AS n FROM ${sql}`, ...p)).n;
/** Every added sign-in (none while the table was never made). */
async function added(db = env.DB) {
  try { return (await rows(db, "SELECT user_id, provider, provider_id FROM user_logins ORDER BY user_id")).map((r) => ({ ...r })); }
  catch (e) { if (/no such table/.test(String(e))) return []; throw e; }
}
/**
 * The Profile's Add: POST /api/me/google/add. { status, body, state } (state: the one in Google's address, when it answered one). `body`
 * is what the page sends: by default the member's current password typed in (every e-mail member of these tests has GOOD_PASSWORD);
 * {} is a bare tap on Add.
 */
async function startAdd(b, body = { current: GOOD_PASSWORD }) {
  const r = await b.send("/api/me/google/add", { method: "POST", body });
  const out = await r.json();
  return { status: r.status, body: out, state: out.ok ? new URL(out.url).searchParams.get("state") : null };
}
/** Google sends the person back as Google account `sub`: where the callback lands. */
const backFromGoogle = async (b, state, sub) => (await b.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: googleAs(sub) })).headers.get("location");
/** Add, then back from Google as `sub`. */
async function addVia(b, sub, body) {
  const s = await startAdd(b, body);
  return { ...s, to: s.state ? await backFromGoogle(b, s.state, sub) : null };
}
/** "Log in with Google" on the Log in tab (no marker): where Google's answer lands. */
async function googleLogin(b, sub) {
  const st = await b.send("/api/auth/google/start");
  return backFromGoogle(b, new URL(st.headers.get("location")).searchParams.get("state"), sub);
}
const passwordLogin = (b, email) => b.send("/api/auth/email/login", { method: "POST", body: { email, password: GOOD_PASSWORD } });
const logout = (b) => b.send("/api/auth/logout", { method: "POST", body: {} });
/**
 * A browser edits its own OAuth cookie: a plain log-in trip made to look like "Add Google" for the session it holds, with a grant made up
 * the way the first version tagged a session (a hash anyone can compute from their own cookie) and a fresh time. Only the server can make
 * a real grant (an HMAC under its secret salt).
 */
async function forgeMarker(b) {
  const st = await b.send("/api/auth/google/start");
  const tag = (await sha256(`google-link:${await sha256(b.jar.get("vs"))}`)).slice(0, 22);
  b.jar.set("vo", `${b.jar.get("vo")}.l.${Date.now().toString(36)}.${tag}`);
  return new URL(st.headers.get("location")).searchParams.get("state");
}
/** POST /api/me/password { current?, password } from that browser: { status, body }. */
const changePassword = async (b, body) => { const r = await b.send("/api/me/password", { method: "POST", body }); return { status: r.status, body: await r.json() }; };
/** The e-mail code log-in (the old route, which signs existing members in): a new session in `b`. */
async function codeLogin(b, email) {
  advance(61_000); // (a second code for the same address waits a minute)
  await b.send("/api/auth/email/start", { method: "POST", body: { email }, fetchImpl: box.fetch });
  const r = await b.send("/api/auth/email/verify", { method: "POST", body: { email, code: box.codeFor(email) }, fetchImpl: box.fetch });
  assert.equal(r.status, 200, await r.clone().text());
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

    // a bare tap on Add is not enough, even right after logging in: the password is asked for, exactly as for a password change
    const bare = await startAdd(m.b, {});
    assert.deepEqual([bare.status, bare.body], [403, { ok: false, error: "reprove", password: true }]);
    assert.equal(m.b.has("vo"), false, "no trip to Google was prepared");
    const wrong = await startAdd(m.b, { current: "not my password at all" });
    assert.deepEqual([wrong.status, wrong.body], [401, { ok: false, error: "bad_credentials" }]);
    assert.equal(m.b.has("vo"), false);

    const r = await addVia(m.b, "owner-sub");
    assert.equal(r.status, 200);
    const google = new URL(r.body.url);
    assert.equal(google.origin + google.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(google.searchParams.get("scope"), "openid profile", "no e-mail address is asked of Google");
    assert.equal(r.to, "/dashboard?google=linked#profile", "back to the Profile, with a short success note");
    assert.deepEqual(await added(), [{ user_id: m.u.id, provider: "google", provider_id: "owner-sub" }]);
    // the owner hears of it, at the address he logs in with; the mail names no Google account
    assert.deepEqual(mails.map((x) => [x.to, x.subject]), [[m.email, "Google sign-in was added to your Vicinity account"]]);
    assert.match(mails[0].text, /If it wasn't you, set a new password/);
    assert.ok(!JSON.stringify(mails).includes("owner-sub"));
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

test("Add and Remove are refused to a session a wallet from another app made in the last 7 days (link_new), with the password too; a marker forged into its own cookie adds nothing either", async () => {
  const m = await owner();
  // the wallet came from another app (src/walletlink.js linkWindow) and signed in to a browser since: that browser's session is locked
  await env.DB.prepare("UPDATE users SET wallet_via = 'app', wallet_at = ? WHERE id = ?").bind(nowIso(), m.u.id).run();
  advance(60_000);
  const app = browser(env);
  assert.equal((await app.post("/api/auth/wallet", await loginBody(m.w))).ok, true);
  const r = await startAdd(app);
  assert.deepEqual([r.status, r.body.error], [403, "link_new"], "the lock comes first: the password does not open it");
  assert.equal(app.has("vo"), false);
  assert.equal((await app.post("/api/me/google/remove")).error, "link_new");
  const state = await forgeMarker(app);
  assert.equal(await backFromGoogle(app, state, "stranger-sub"), "/dashboard?google=login_expired#profile", "a made-up grant is no grant");
  assert.deepEqual(await added(), []);
  // the owner's own older browser is not locked
  assert.equal((await addVia(m.b, "owner-sub")).to, "/dashboard?google=linked#profile");
});

test("the rule of a password change (finding TO-1): the session that may not change the password without it may not add Google without it either", async () => {
  // the reviewer's case: e-mail + password + linked wallet; the owner logs in with his password on a shared computer and walks away
  const m = await owner();
  const shared = browser(env);
  assert.equal((await passwordLogin(shared, m.email)).status, 200);
  advance(10 * 60_000); // someone else sits down ten minutes later
  assert.deepEqual(await changePassword(shared, { password: "a whole new secret phrase" }), { status: 403, body: { ok: false, error: "reprove" } });
  const add = await startAdd(shared, {});
  assert.deepEqual([add.status, add.body], [403, { ok: false, error: "reprove", password: true }], "the same answer: type the password (or prove the wallet)");
  const state = await forgeMarker(shared);
  assert.equal(await backFromGoogle(shared, state, "stranger-sub"), "/dashboard?google=login_expired#profile");
  assert.deepEqual(await added(), [], "nothing was added for the stranger");
  // the owner, who knows the password, can (however old the session): the password is the proof, as for a change
  advance(60 * 60_000);
  assert.equal((await addVia(shared, "owner-sub")).to, "/dashboard?google=linked#profile");
  // a wallet proof in this browser in the last 30 minutes counts instead of the password (another member, a bare tap)
  const n = await owner("second@icloud.example");
  assert.equal((await startAdd(n.b, {})).body.error, "reprove");
  assert.equal((await n.b.post("/api/auth/reprove", await loginBody(n.w))).ok, true);
  assert.equal((await addVia(n.b, "second-sub", {})).to, "/dashboard?google=linked#profile");
});

test("an account with a wallet and no password confirms with the wallet; one with neither counts its login of the last 30 minutes, then logs in again", async () => {
  // a wallet, no password: the login alone never counts (a wallet proof does), and the page is told to ask the wallet (no password, no relogin)
  const w = await owner("wallet-only@example.com");
  await env.DB.prepare("UPDATE users SET password_hash = NULL, password_at = NULL WHERE id = ?").bind(w.u.id).run();
  const fresh = browser(env);
  await codeLogin(fresh, w.email);
  const r1 = await startAdd(fresh);
  assert.deepEqual([r1.status, r1.body], [403, { ok: false, error: "reprove" }], "a typed password is no use to an account without one");
  assert.equal((await fresh.post("/api/auth/reprove", await loginBody(w.w))).ok, true);
  assert.equal((await addVia(fresh, "wallet-only-sub", {})).to, "/dashboard?google=linked#profile");

  // neither a wallet nor a password (an e-mail account made with a code): its own login of the last 30 minutes, nothing else proves it
  const plain = await member(env, box, { via: "email", email: "plain@example.com" });
  plain.u = await userOf(env, plain);
  await env.DB.prepare("UPDATE users SET password_hash = NULL, password_at = NULL WHERE id = ?").bind(plain.u.id).run();
  advance(45 * 60_000);
  const old = await startAdd(plain.b, {});
  assert.deepEqual([old.status, old.body], [403, { ok: false, error: "reprove", relogin: true }], "the page offers Log in again");
  const state = await forgeMarker(plain.b);
  assert.equal(await backFromGoogle(plain.b, state, "stranger-sub"), "/dashboard?google=login_expired#profile");
  await logout(plain.b); // ("Log in again" logs out first, then the person logs in: here with the e-mail code)
  await codeLogin(plain.b, plain.email);
  assert.equal((await addVia(plain.b, "plain-sub", {})).to, "/dashboard?google=linked#profile");
  assert.deepEqual((await added()).map((r) => r.provider_id).sort(), ["plain-sub", "wallet-only-sub"]);
});

test("the grant in the OAuth cookie: only the server makes one, for one session and one trip, and it lasts the 10 minutes of the trip", async () => {
  const m = await owner();
  // a real grant, back after 11 minutes at Google: too old
  const s1 = await startAdd(m.b);
  advance(11 * 60_000);
  assert.equal(await backFromGoogle(m.b, s1.state, "owner-sub"), "/dashboard?google=login_expired#profile");
  // a real grant moved onto another trip (the state of a plain log-in): it names the trip it was made for
  const s2 = await startAdd(m.b);
  const vo = m.b.jar.get("vo").split(".");
  const st = await m.b.send("/api/auth/google/start");
  const other = new URL(st.headers.get("location")).searchParams.get("state");
  const plainTrip = m.b.jar.get("vo").split(".");
  m.b.jar.set("vo", [plainTrip[0], plainTrip[1], plainTrip[2], ...vo.slice(3)].join("."));
  assert.notEqual(other, s2.state);
  assert.equal(await backFromGoogle(m.b, other, "owner-sub"), "/dashboard?google=login_expired#profile");
  // a real grant whose time was edited (to make it look new): the time is part of what the server signed
  const s3 = await startAdd(m.b);
  advance(11 * 60_000);
  const parts = m.b.jar.get("vo").split(".");
  parts[4] = Date.now().toString(36);
  m.b.jar.set("vo", parts.join("."));
  assert.equal(await backFromGoogle(m.b, s3.state, "owner-sub"), "/dashboard?google=login_expired#profile");
  assert.deepEqual(await added(), []);
  assert.equal(mails.length, 0, "nothing added, nothing mailed");
  // and the same Add, back in time, works
  assert.equal((await addVia(m.b, "owner-sub")).to, "/dashboard?google=linked#profile");
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

test("Remove takes the added Google sign-in off and logs out the other browsers (a phone that logged in with it too): 'Log in with Google' answers no_account with the Google words again; the account's own login stays", async () => {
  const m = await owner();
  assert.equal((await addVia(m.b, "owner-sub")).to, "/dashboard?google=linked#profile");
  // somewhere else, someone logged in with that Google account (the wrong one was added, or it was not the owner who added it)
  const phone = browser(env), laptop = browser(env);
  assert.equal(await googleLogin(phone, "owner-sub"), "/dashboard");
  assert.equal((await passwordLogin(laptop, m.email)).status, 200);
  const foreign = await m.b.send("/api/me/google/remove", { method: "POST", body: {}, origin: "https://evil.example" });
  assert.deepEqual([foreign.status, (await foreign.json()).error], [403, "wrong_origin"]);
  assert.equal((await browser(env).post("/api/me/google/remove")).error, "sign_in");
  assert.equal((await added()).length, 1, "neither of those removed anything");
  assert.equal((await phone.get("/api/me?lite=1")).signedIn, true);
  assert.deepEqual(await m.b.post("/api/me/google/remove"), { ok: true, removed: true });
  assert.deepEqual(await added(), []);
  assert.equal((await phone.get("/api/me?lite=1")).signedIn, false, "the session that Google account made is over");
  assert.equal((await laptop.get("/api/me?lite=1")).signedIn, false, "every other browser too (sessions don't say which login made them)");
  assert.equal((await m.b.get("/api/me?lite=1")).user.id, m.u.id, "the browser that removed it stays in");
  assert.equal((await m.b.get("/api/me")).user.googleAdded, false);
  const to = await googleLogin(browser(env), "owner-sub");
  assert.equal(to, "/connect?error=no_account&login=google");
  const bounce = P.bounceFor(new URL(to, "https://x").searchParams.get("error"), new URL(to, "https://x").searchParams.get("login"));
  assert.match(bounce.text, /^No Vicinity account uses this Google account\./, "the page speaks of the Google account");
  const again = browser(env);
  assert.equal((await passwordLogin(again, m.email)).status, 200, "the e-mail login is untouched");
  assert.deepEqual(await m.b.post("/api/me/google/remove"), { ok: true, removed: false }, "nothing left to remove");
  assert.equal((await again.get("/api/me?lite=1")).signedIn, true, "a Remove with nothing to remove logs nobody out");
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

test("a new password takes the added Google sign-in off (finding LC-1 / TO-2): after the reset by e-mail code, the Google account someone else added answers no_account", async () => {
  // an attacker with a phished password adds THEIR Google account (the password rule lets whoever knows the password do that)
  const m = await owner();
  const attacker = browser(env);
  assert.equal((await passwordLogin(attacker, m.email)).status, 200);
  assert.equal((await addVia(attacker, "attacker-sub")).to, "/dashboard?google=linked#profile");
  assert.deepEqual(mails.map((x) => x.to), [m.email], "the owner is told the same minute");
  // the owner resets the password with a code mailed to him: every browser out, and the added Google sign-in with them
  await m.b.send("/api/auth/password/reset/start", { method: "POST", body: { email: m.email }, fetchImpl: box.fetch });
  const r = await m.b.send("/api/auth/password/reset", { method: "POST", body: { email: m.email, code: box.codeFor(m.email), password: "a brand new passphrase" } });
  assert.deepEqual([r.status, await r.json()], [200, { ok: true, next: "/dashboard", googleRemoved: true }], "the page is told, so it can say so");
  assert.deepEqual(await added(), []);
  assert.equal((await attacker.get("/api/me?lite=1")).signedIn, false);
  assert.equal(await googleLogin(browser(env), "attacker-sub"), "/connect?error=no_account&login=google", "five days later, from a fresh browser: nothing");
  // a reset with no Google sign-in to take off says nothing about one
  advance(61_000);
  await m.b.send("/api/auth/password/reset/start", { method: "POST", body: { email: m.email }, fetchImpl: box.fetch });
  const r2 = await m.b.send("/api/auth/password/reset", { method: "POST", body: { email: m.email, code: box.codeFor(m.email), password: "another fresh passphrase" } });
  assert.deepEqual([r2.status, await r2.json()], [200, { ok: true, next: "/dashboard" }]);
});

test("the reset page says so when the new password took an added Google sign-in off (the owner adds his own again from the Profile)", async () => {
  for (const removed of [true, false]) {
    const answer = { ok: true, next: "/dashboard", ...(removed ? { googleRemoved: true } : {}) };
    const p = await connectPage({ mode: "login", api: async (path) => (path === "/api/auth/password/reset" ? answer : { ok: true }) });
    await tapFake(p.$("#lg-forgot"));
    p.$("#rs-email").value = "owner@icloud.example";
    await submit(p.$("#rs-form1"));
    p.$("#rs-code").value = "123456";
    p.$("#rs-pw").value = GOOD_PASSWORD;
    await submit(p.$("#rs-form2"));
    assert.equal(p.shown[p.shown.length - 1], "done", String(removed));
    if (removed) assert.match(p.$("#done-sub").textContent, /The Google sign-in added to your account was removed: if it was yours, add it again in your Profile\.$/);
    else assert.equal(p.$("#done-sub").textContent, "Taking you to your dashboard…", "no Google sign-in to take off: nothing about one");
  }
});

test("a password change (with the current password) also takes the added Google sign-in off, with the other browsers; the notice goes out only for a real add", async () => {
  const m = await owner();
  // two browsers of the owner start Add before either comes back: the second one back finds the same Google account there already
  const tab = browser(env);
  assert.equal((await passwordLogin(tab, m.email)).status, 200);
  const late = await startAdd(tab);
  assert.equal((await addVia(m.b, "owner-sub")).to, "/dashboard?google=linked#profile");
  assert.equal(mails.length, 1);
  assert.equal(await backFromGoogle(tab, late.state, "owner-sub"), "/dashboard?google=already#profile");
  assert.equal(mails.length, 1, "nothing new was added, nothing new is mailed");
  const ch = await changePassword(m.b, { current: GOOD_PASSWORD, password: "a whole new secret phrase" });
  assert.deepEqual(ch, { status: 200, body: { ok: true, googleRemoved: true } });
  assert.deepEqual(await added(), []);
  assert.equal((await tab.get("/api/me?lite=1")).signedIn, false);
  assert.equal((await m.b.get("/api/me")).user.googleAdded, false);
  assert.equal(await googleLogin(browser(env), "owner-sub"), "/connect?error=no_account&login=google");
  // the notice itself: plain words, no Google account, the two ways to take it off
  const n = googleAddedEmail();
  assert.equal(n.subject, "Google sign-in was added to your Vicinity account");
  assert.match(n.text, /“Forgot or never set a password\?”/);
  assert.match(n.text, /tap “Remove”/);
  assert.doesNotMatch(n.html, /\$\{|undefined/);
});

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
  assert.match(google.text, /Have one\? Log in with your e-mail or wallet, then add Google in your Profile\./, "the way in for a member: their own login, or the wallet on the account");
  assert.match(google.text, /A Gmail saved as contact e-mail can't log you in\./, "the owner's exact confusion");
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
  // (finding UX-2) the Google answer keeps the person on the Log in tab: someone new who pressed the wrong button is told where to go too
  for (const t of all) assert.match(t, /New here\?/, t);
  for (const t of all) {
    assert.ok(t.length < 200, t);
    assert.match(t, /[.!?]$/);
    assert.doesNotMatch(t, /<|>|\$\{|undefined|null|NaN/);
    assert.doesNotMatch(t, /\p{Extended_Pictographic}/u);
  }
  assert.doesNotMatch(google.text + email, /this wallet/, "only the wallet's own answer speaks of a wallet it can't find");
});

test("a wallet nobody owns (finding UX-1): its own screen says what a member whose account has no wallet yet does, and what someone new does", async () => {
  // what a wallet's log-in, pairing or transfer shows (src/auth.js answers no_account, connect.js shows the screen: noAccountCopy)
  const web = plain(P.noAccountCopy(false, null));
  assert.equal(web.body, "Made your account with Google or e-mail? Log in that way, then connect this wallet from your dashboard. New here? Create one with Google in a minute.");
  assert.equal(web.login, "Log in with Google or your e-mail, then connect this wallet.");
  const app = plain(P.noAccountCopy(true, "Phantom"));
  assert.match(app.body, /^Vicinity accounts start with Google or e-mail\./);
  assert.equal(app.login, "Log in with the wallet on your account, or with your e-mail and password.", "Google can't run inside a wallet app");
  for (const t of [web.body, web.login, app.body, app.login]) { assert.ok(t.length < 200, t); assert.doesNotMatch(t, /undefined|null/); }
  // the screen itself: the "Already a member?" line is there on a computer too, and leads to the Log in tab
  const p = await connectPage({ mode: "login", api: async (path) => (path === "/api/auth/wallet" ? { ok: false, error: "no_account" } : { ok: true }) });
  await p.ctrl.walletProven({ ok: false, error: "no_account" });
  assert.equal(p.$("#na-body").textContent, web.body);
  assert.equal(p.$("#na-tiny").hidden, false);
  assert.equal(p.$("#na-login").textContent, web.login);
  await tapFake(p.$("#na-login"));
  assert.equal(p.shown[p.shown.length - 1], "pick");
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
  assert.equal(r.confirms[0], "Remove Google sign-in? You will log in the way you made your account, and your other browsers are logged out.");
  assert.deepEqual(r.callsTo("/api/me/google/remove").map((c) => c.method), ["POST"]);
  assert.equal(r.text("#profile-google-meta"), "Not added");
  assert.ok(r.toasts.includes("Google sign-in removed. Other browsers are logged out."), r.toasts.join());
});

test("the Profile's Add asks for the password (an account with one), then goes to Google; a wrong one is said in the row; a wallet can confirm instead", async () => {
  const sent = [];
  const api = async (path, body) => {
    if (path !== "/api/me/google/add") return undefined;
    sent.push(body);
    if (!body || !body.current) return { ok: false, error: "reprove", password: true, _status: 403 };
    return body.current === "right one" ? { ok: true, url: GOOGLE_URL } : { ok: false, error: "bad_credentials", _status: 401 };
  };
  const p = await openDashboard({ me: emailMe({ hasPassword: true }), api });
  p.win.V.openProfile(); await p.flush();
  assert.equal(p.$("#google-pw-form").hidden, true, "nothing to type until Add is tapped");
  await p.tap(p.$$("#google-view button")[0]);
  assert.equal(p.$("#google-pw-form").hidden, false, "the password step opens under the row");
  assert.equal(p.text("#google-err"), "For your safety, type your password to add Google.");
  assert.equal(p.$("#google-pw-alt").hidden, false, "this account has a wallet: it may confirm with it instead");
  assert.ok(!p.assigned.some((u) => /accounts\.google\.com/.test(u)), "not to Google yet");
  const submitForm = async () => { p.$("#google-pw-form").dispatchEvent(newEvent("submit", { cancelable: true })); await p.flush(); };
  p.$("#google-pw").value = "wrong one";
  await submitForm();
  assert.match(p.text("#google-err"), /^That password isn't right\./);
  assert.equal(p.$("#google-pw-form").hidden, false, "the step stays open, empty, for another try");
  assert.equal(p.$("#google-pw").value, "");
  p.$("#google-pw").value = "right one";
  await submitForm();
  assert.deepEqual(plain(sent), [{}, { current: "wrong one" }, { current: "right one" }]);
  assert.ok(p.assigned.includes(GOOGLE_URL), "off to Google's own page");
  // an account with a password and no wallet: no "Confirm with my wallet instead"
  const q = await openDashboard({ me: (() => { const me = emailMe({ hasPassword: true }); me.user.wallet = null; return me; })(), api });
  q.win.V.openProfile(); await q.flush();
  await q.tap(q.$$("#google-view button")[0]);
  assert.equal(q.$("#google-pw-form").hidden, false);
  assert.equal(q.$("#google-pw-alt").hidden, true);
});

test("the Profile's Add for an account with a wallet and no password: the wallet's 'confirm it's you' sheet, then once more", async () => {
  let n = 0;
  const p = await openDashboard({ me: emailMe(), api: async (path) => (path === "/api/me/google/add" ? (++n === 1 ? { ok: false, error: "reprove", _status: 403 } : { ok: true, url: GOOGLE_URL }) : undefined) });
  p.win.V.openProfile(); await p.flush();
  await p.tap(p.$$("#google-view button")[0]);
  assert.equal(p.$("#proof-modal").hidden, false, "the sheet that signs with the wallet (or a tiny transfer)");
  assert.equal(p.$("#google-pw-form").hidden, true, "no password to type: the account has none");
  await p.tap(p.$("#proof-cancel"));
  assert.equal(p.text("#google-err"), "For your safety, confirm it's you with your wallet first, then tap Add again.");
  assert.equal(p.callsTo("/api/me/google/add").length, 1, "cancelled: not asked again");
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
  const odd = await openDashboard({ me: emailMe(), search: "google=%3Cb%3Ehi" });
  assert.equal(odd.$("#google-err").hidden, true, "a code the page does not know says nothing");
  // (findings N-1 / UI-1) names every object has are not codes: the page says nothing and finishes starting (the wallet toast after it shows)
  for (const code of ["valueOf", "constructor", "hasOwnProperty", "__proto__", "toString"]) {
    const x = await openDashboard({ me: emailMe(), search: `google=${code}&linked=1` });
    assert.equal(x.$("#google-err").hidden, true, code);
    assert.ok(x.toasts.some((t) => /connected ✓|Wallet linked ✓/.test(t)), `${code}: the start-up went on to the end (${x.toasts.join()})`);
  }
  // (finding UX-3) the note is about that moment: the next visit to the Profile starts clean
  taken.win.V.openProfile(); await taken.flush();
  assert.equal(taken.$("#google-err").hidden, true);
});
