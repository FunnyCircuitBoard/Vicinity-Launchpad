// "Wasn't you? Remove it" (src/walletlink.js handleDisown) and the safety net around a link made in ANOTHER browser (a wallet app's
// claim, or a pairing a wallet app approved): for 7 days an older browser of the account may take the wallet off WITHOUT that wallet's
// proof, and with it every browser that wallet signed in and everything it did since; meanwhile the sessions that wallet made may not
// change the password, the e-mail, the username, or unlink (linkLocked). E-mail accounts get a short e-mail. Plus: a session a wallet
// made is renewed while it is used (src/auth.js renewSession).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { DAY, HOUR, V2, advance, browser, linkBody, loginBody, realClock, useClock } from "./helpers/world.js";
import { GOOD_PASSWORD, member, one, outbox, userOf } from "./helpers/signup.js";
import { buildMessage, parseMessage } from "../src/solana.js";
import { walletLinkedEmail } from "../src/mail.js";

let env, box;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

const near = { country: "US", latitude: 43.1, longitude: -75.2 };
const PHONE = { ip: "198.51.100.7", cf: { ...near, asn: 21928, asOrganization: "T-Mobile USA, Inc." } };
const ELSEWHERE = { ip: "203.0.113.9", cf: { ...near, asn: 7922, asOrganization: "Comcast Cable" } };
const NEW_PASSWORD = "another long passphrase here";

async function safari(opts = {}) {
  const m = await member(env, box, { via: "google", net: PHONE, ...opts });
  m.u = await userOf(env, m);
  return m;
}
/** Every mail Resend was asked to send (the link notices carry no code). */
function mailbox() {
  const sent = [];
  return { sent, fetch: async (url, init) => { if (String(url) === "https://api.resend.com/emails") { const b = JSON.parse(init.body); sent.push({ to: b.to[0], subject: b.subject, text: b.text, html: b.html }); return new Response("{}", { status: 200 }); } return new Response("{}", { status: 404 }); } };
}
/** The wallet app's browser links `w` to the account of Safari `m` with a code: info, the statement, the claim. Returns that browser. */
async function linkInApp(m, w = m.w, { app = "phantom", fetchImpl } = {}) {
  const made = await (await m.b.send("/api/me/wallet/carry", { method: "POST", body: { app } })).json();
  const b = browser(env, PHONE);
  assert.equal((await b.send("/api/me/wallet/carry/info", { method: "POST", body: { code: made.code } })).status, 200);
  const got = await b.get(`/api/message?address=${w.address}&action=link&code=${made.code}`);
  const message = buildMessage({ ...parseMessage(got.message), issuedAt: new Date(Date.now()).toISOString() });
  const r = await b.send("/api/me/wallet/carry/claim", { method: "POST", body: { code: made.code, address: w.address, message, signature: await w.sign(message), app }, ...(fetchImpl ? { fetchImpl } : {}) });
  assert.equal(r.status, 200, await r.clone().text());
  return b;
}
const disown = (b) => b.send("/api/me/wallet/disown", { method: "POST", body: {} });
const err = async (r) => [r.status, (await r.clone().json()).error];
const count = async (sql, ...p) => (await one(env.DB, `SELECT COUNT(*) AS n FROM ${sql}`, ...p)).n;
function capture() {
  const lines = [], orig = { log: console.log, error: console.error };
  console.log = (...a) => lines.push(a.map(String).join(" ")); console.error = (...a) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => Object.assign(console, orig) };
}

test("Remove it: Safari (its session older than the link) takes the wallet off: the wallet app's session and the wallet's later sign-ins are gone, Safari stays in without a wallet, no live code survives, and the wallet can be linked again", async () => {
  const m = await safari();
  advance(60_000);
  const app = await linkInApp(m);
  advance(60_000);
  const later = browser(env, ELSEWHERE); // the same wallet signs in somewhere else afterwards
  assert.equal((await later.post("/api/auth/wallet", await loginBody(m.w))).ok, true);
  await m.b.post("/api/pair", { purpose: "link" }).catch(() => null); // (has_wallet: nothing made)
  const saf = await m.b.get("/api/me");
  assert.equal(saf.walletNew.notMe, true);
  const logs = capture();
  let r;
  try { r = await disown(m.b); } finally { logs.restore(); }
  assert.deepEqual([r.status, await r.json()], [200, { ok: true }]);
  assert.deepEqual(await one(env.DB, "SELECT wallet, wallet_at, wallet_via, wallet_app FROM users WHERE id = ?", m.u.id), { wallet: null, wallet_at: null, wallet_via: null, wallet_app: null });
  assert.equal((await app.get("/api/me?lite=1")).signedIn, false, "the wallet app is logged out");
  assert.equal((await later.get("/api/me?lite=1")).signedIn, false, "so is every sign-in that wallet made");
  const me = await m.b.get("/api/me?lite=1");
  assert.deepEqual([me.signedIn, me.user.wallet], [true, null], "Safari stays in, without the wallet");
  assert.equal(await count("sessions WHERE user_id = ?", m.u.id), 1);
  assert.equal(await count("handoffs WHERE kind = 'carry' AND user_id = ? AND (result IS NULL OR result = 'opened')", m.u.id), 0);
  assert.ok(logs.lines.some((l) => l.startsWith("wallet disowned ") && l.includes(`${m.w.address.slice(0, 4)}…${m.w.address.slice(-4)}`)));
  assert.ok(!logs.lines.some((l) => l.includes(m.w.address)), "never the whole address in a log");
  // the same wallet can be linked again (it is the person's own after all, or another one)
  advance(60_000);
  await linkInApp(m);
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", m.u.id)).wallet, m.w.address);
});

test("who may: an older session or a never-proven login made after the link (Google) may; the wallet app's session, a later wallet sign-in, a link made in this very browser (page) or by a transfer may not; after 7 days nobody; a session older than 30 minutes logs in again first", async () => {
  // the wallet's own sessions
  const m = await safari();
  const app = await linkInApp(m);
  assert.deepEqual(await err(await disown(app)), [403, "not_allowed"]);
  const signin = browser(env, ELSEWHERE);
  await signin.post("/api/auth/wallet", await loginBody(m.w));
  assert.deepEqual(await err(await disown(signin)), [403, "not_allowed"]);
  assert.equal((await signin.get("/api/me")).walletNew.notMe, false);
  // Safari is older than 30 minutes now: log in again (a new Google session: never proven) and it works
  advance(31 * 60_000);
  assert.deepEqual(await err(await disown(m.b)), [403, "relogin"]);
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", m.u.id)).wallet, m.w.address, "nothing changed");
  await m.b.send("/api/auth/logout", { method: "POST", body: {} });
  const g = await m.b.send("/api/auth/google/start");
  const state = new URL(g.headers.get("location")).searchParams.get("state");
  const google = async () => new Response(JSON.stringify({ id_token: "x." + Buffer.from(JSON.stringify({ iss: "accounts.google.com", aud: "gid", sub: m.sub, given_name: "Sam" })).toString("base64url") + ".y" }));
  await m.b.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: google });
  assert.equal((await m.b.get("/api/me")).walletNew.notMe, true, "a Google login made AFTER the link may say it");
  assert.equal((await disown(m.b)).status, 200);
  assert.equal((await signin.get("/api/me?lite=1")).signedIn, false);
  // 7 days later: too late
  const n = await safari({ sub: "g-week" });
  await linkInApp(n);
  advance(7 * DAY);
  assert.deepEqual(await err(await disown(n.b)), [409, "too_late"]);
  // linked in this very browser (the page's own signature): nothing to disown
  const p = await safari({ sub: "g-page" });
  const r = await p.b.send("/api/me/wallet/link", { method: "POST", body: await linkBody(p.w, p.u.handle) });
  assert.equal(r.status, 200);
  assert.equal((await one(env.DB, "SELECT wallet_via FROM users WHERE id = ?", p.u.id)).wallet_via, "page");
  assert.deepEqual(await err(await disown(p.b)), [409, "too_late"]);
  assert.equal((await p.b.get("/api/me")).walletNew, undefined, "no notice for a link made here");
  // a signed-out browser and an account without a wallet
  assert.deepEqual(await err(await disown(browser(env, PHONE))), [401, "sign_in"]);
  const q = await safari({ sub: "g-none" });
  assert.deepEqual(await err(await disown(q.b)), [409, "no_wallet"]);
});

test("a pairing a wallet app approved (via 'pair') gets the same: Safari may remove it; the browser that finished the pairing itself is not asked", async () => {
  const m = await safari();
  const p = await m.b.post("/api/pair", { purpose: "link" });
  const phone = browser(env, PHONE); // the wallet app approving
  const approve = await phone.post("/api/auth/wallet", { ...(await linkBody(m.w, m.u.handle, p.pin)), pair: p.code });
  assert.equal(approve.paired, true);
  const fin = await m.b.post("/api/pair/finish", { code: p.code });
  assert.equal(fin.linked, true);
  assert.equal((await one(env.DB, "SELECT wallet_via FROM users WHERE id = ?", m.u.id)).wallet_via, "pair");
  assert.equal((await m.b.get("/api/me")).walletNew.notMe, false, "Safari finished the link itself (its proof IS the link): it is not asked 'was this you?'");
  // a computer that was logged in before (another older session) is asked, and may remove it
  const g = await m.b.send("/api/auth/google/start"); // (a second login of the same Google account, on a computer)
  const comp = browser(env, ELSEWHERE);
  const st = await comp.send("/api/auth/google/start");
  const state = new URL(st.headers.get("location")).searchParams.get("state");
  const google = async () => new Response(JSON.stringify({ id_token: "x." + Buffer.from(JSON.stringify({ iss: "accounts.google.com", aud: "gid", sub: m.sub, given_name: "Sam" })).toString("base64url") + ".y" }));
  await comp.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: google });
  assert.ok(g.status >= 300);
  assert.equal((await comp.get("/api/me")).walletNew.notMe, true);
  assert.equal((await disown(comp)).status, 200);
  assert.equal(await count("pairs WHERE user_id = ? AND purpose = 'link'", m.u.id), 0);
});

test("the attack the lock stops: the wallet app's session (a stranger with a forwarded link) can't set a password, change the e-mail or the username, or unlink; the owner's Remove it then clears a password set since the link and logs out every other browser", async () => {
  const m = await member(env, box, { via: "email", net: PHONE, email: "owner@example.com" });
  m.u = await userOf(env, m);
  const thief = await linkInApp(m);
  // (the claim session is proven: without the lock it could set a password without the current one and log everyone else out)
  const pw = await thief.send("/api/me/password", { method: "POST", body: { password: NEW_PASSWORD } });
  assert.deepEqual(await err(pw), [403, "link_new"]);
  assert.match((await pw.json()).until, /^2026-10-08T12:00:00/);
  assert.deepEqual(await err(await thief.send("/api/me/username", { method: "POST", body: { username: "ThiefName" } })), [403, "link_new"]);
  assert.deepEqual(await err(await thief.send("/api/me/contact/email/remove", { method: "POST", body: {} })), [403, "link_new"]);
  assert.deepEqual(await err(await thief.send("/api/me/contact/email/verify", { method: "POST", body: { email: "x@example.com", code: "123456" } })), [403, "link_new"]);
  assert.deepEqual(await err(await thief.send("/api/me/wallet/unlink", { method: "POST", body: {} })), [403, "link_new"]);
  assert.equal((await m.b.get("/api/me?lite=1")).signedIn, true, "the owner is still in");
  // with the CURRENT password (only the owner knows it) a change is fine, and is recorded as set since the link
  const known = await thief.send("/api/me/password", { method: "POST", body: { current: GOOD_PASSWORD, password: NEW_PASSWORD } });
  assert.equal(known.status, 200, "(this is what knowing the password allows: the owner, in practice)");
  assert.equal((await one(env.DB, "SELECT password_at FROM users WHERE id = ?", m.u.id)).password_at, new Date(Date.now()).toISOString());
  // ... it logged out the owner's Safari (a password change does): the owner logs in again with the e-mail code, and removes the wallet
  const owner = browser(env, PHONE);
  await owner.send("/api/auth/email/start", { method: "POST", body: { email: "owner@example.com" }, fetchImpl: box.fetch });
  assert.equal((await owner.send("/api/auth/email/verify", { method: "POST", body: { email: "owner@example.com", code: box.codeFor("owner@example.com") } })).status, 200);
  const r = await disown(owner);
  assert.deepEqual([r.status, await r.json()], [200, { ok: true, passwordCleared: true }]);
  assert.equal((await thief.get("/api/me?lite=1")).signedIn, false, "every other browser is out");
  assert.deepEqual(await one(env.DB, "SELECT password_hash, password_at, wallet FROM users WHERE id = ?", m.u.id), { password_hash: null, password_at: null, wallet: null });
  const again = await browser(env, ELSEWHERE).send("/api/auth/email/login", { method: "POST", body: { email: "owner@example.com", password: NEW_PASSWORD } });
  assert.equal(again.status, 401, "the password set since the link no longer logs anyone in");
  assert.equal((await owner.get("/api/me?lite=1")).signedIn, true);
});

test("the lock lasts the 7 days only, and never touches the owner's own logins: a Google session made after the link may change things; after 7 days the wallet's session may unlink with a fresh proof", async () => {
  const m = await safari();
  const app = await linkInApp(m);
  assert.deepEqual(await err(await app.send("/api/me/username", { method: "POST", body: { username: "NewName1" } })), [403, "link_new"]);
  advance(7 * DAY + 1000);
  await app.post("/api/auth/reprove", await loginBody(m.w));
  const u = await app.send("/api/me/username", { method: "POST", body: { username: "NewName1" } });
  assert.equal(u.status, 200, await u.clone().text());
  assert.equal((await app.send("/api/me/wallet/unlink", { method: "POST", body: {} })).status, 200);
});

test("whatever the wallet joined since the link goes with it: a seat taken since is voided (a public record, no cooldown), an open application withdrawn, a squad place left (an emptied squad disbanded); one from BEFORE the link refuses", async () => {
  const m = await safari();
  const app = await linkInApp(m);
  advance(60_000);
  const at = new Date(Date.now()).toISOString();
  const db = env.DB;
  const w = await db.prepare("INSERT INTO windows (city_id, city_name, country, policy, threshold, opened_at, closes_at, status) VALUES ('5142056', 'Utica', 'US', 5, 1, ?, ?, 'open') RETURNING id").bind(at, new Date(Date.now() + DAY).toISOString()).first();
  await db.prepare("INSERT INTO applications (window_id, city_id, user_id, wallet, created_at) VALUES (?, '5142056', ?, ?, ?)").bind(w.id, m.u.id, m.w.address, at).run();
  const sq = await db.prepare("INSERT INTO squads (city_id, city_name, country, created_by, status, created_at) VALUES ('5140405', 'Syracuse', 'US', ?, 'forming', ?) RETURNING id").bind(m.u.id, at).first();
  await db.prepare("INSERT INTO squad_members (squad_id, user_id, wallet, joined_at) VALUES (?, ?, ?, ?)").bind(sq.id, m.u.id, m.w.address, at).run();
  const seat = await db.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at) VALUES ('5106834', 'Albany', 'US', ?, ?, 5, 1, 'steward', ?) RETURNING id").bind(m.u.id, m.w.address, at).first();
  assert.equal((await disown(m.b)).status, 200, "a seat or squad place made with that wallet never blocks Remove it");
  assert.deepEqual(await one(env.DB, "SELECT status, end_reason FROM seats WHERE id = ?", seat.id), { status: "void", end_reason: "wallet_disowned" });
  const rec = await one(env.DB, "SELECT action, target_type, target_id, reason FROM mod_actions WHERE target_id = ?", seat.id);
  assert.deepEqual(rec, { action: "void_seat", target_type: "seat", target_id: seat.id, reason: "wallet_disowned" });
  assert.equal((await one(env.DB, "SELECT withdrawn FROM applications WHERE user_id = ?", m.u.id)).withdrawn, 1);
  assert.equal(await count("squad_members WHERE user_id = ?", m.u.id), 0);
  assert.equal((await one(env.DB, "SELECT status FROM squads WHERE id = ?", sq.id)).status, "disbanded");
  assert.equal((await m.b.get("/api/me")).founder.cooldownUntil, null, "no founder cooldown for the owner");
  assert.equal((await app.get("/api/me?lite=1")).signedIn, false);
  // a squad place from BEFORE the link (an older account that had a wallet, unlinked, then linked again from an app): refused
  const n = await safari({ sub: "g-old" });
  const before = new Date(Date.now() - HOUR).toISOString();
  const sq2 = await db.prepare("INSERT INTO squads (city_id, city_name, country, created_by, status, created_at) VALUES ('5128581', 'New York City', 'US', ?, 'forming', ?) RETURNING id").bind(n.u.id, before).first();
  await db.prepare("INSERT INTO squad_members (squad_id, user_id, wallet, joined_at) VALUES (?, ?, 'OldWallet1111111111111111111111111111111111', ?)").bind(sq2.id, n.u.id, before).run();
  await linkInApp(n);
  assert.deepEqual(await err(await disown(n.b)), [409, "seat_or_application"]);
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", n.u.id)).wallet, n.w.address, "nothing changed");
});

test("two Remove its at the same moment: one wins, the other changes nothing", async () => {
  const m = await safari();
  await linkInApp(m);
  const rs = await Promise.all([disown(m.b), disown(m.b)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await count("sessions WHERE user_id = ?", m.u.id), 1);
});

test("the e-mail: an e-mail account linked in a wallet app gets exactly one short mail with the app and the wallet masked; a Google account with a verified contact e-mail gets it there; without one, none; a link made on the page sends none; a mail that fails never fails the link", async () => {
  const mb = mailbox();
  const e = await member(env, box, { via: "email", net: PHONE, email: "erin@example.com" });
  e.u = await userOf(env, e);
  await linkInApp(e, e.w, { fetchImpl: mb.fetch });
  assert.equal(mb.sent.length, 1);
  assert.equal(mb.sent[0].to, "erin@example.com");
  assert.equal(mb.sent[0].subject, "A wallet was connected to your Vicinity account");
  const masked = `${e.w.address.slice(0, 4)}…${e.w.address.slice(-4)}`;
  assert.ok(mb.sent[0].text.startsWith(`Phantom (wallet ${masked}) was connected to your Vicinity account.`), mb.sent[0].text);
  assert.ok(/Remove it/.test(mb.sent[0].text) && /7 days/.test(mb.sent[0].text));
  assert.ok(!mb.sent[0].text.includes(e.w.address) && !mb.sent[0].html.includes(e.w.address), "never the whole address");
  // Google with a verified contact e-mail
  const g = await safari({ sub: "g-contact" });
  await env.DB.prepare("UPDATE users SET contact_email = 'gina@example.com' WHERE id = ?").bind(g.u.id).run();
  await linkInApp(g, g.w, { fetchImpl: mb.fetch });
  assert.deepEqual(mb.sent.map((x) => x.to), ["erin@example.com", "gina@example.com"]);
  // Google without one: nothing
  const h = await safari({ sub: "g-plain" });
  await linkInApp(h, h.w, { fetchImpl: mb.fetch });
  assert.equal(mb.sent.length, 2);
  // the page's own link (via page): nothing
  const p = await member(env, box, { via: "email", net: PHONE, email: "pat@example.com" });
  p.u = await userOf(env, p);
  await p.b.send("/api/me/wallet/link", { method: "POST", body: await linkBody(p.w, p.u.handle), fetchImpl: mb.fetch });
  assert.equal(mb.sent.length, 2);
  // Resend down: the link still goes through
  const f = await member(env, box, { via: "email", net: PHONE, email: "fay@example.com" });
  f.u = await userOf(env, f);
  const logs = capture();
  try { await linkInApp(f, f.w, { fetchImpl: async () => new Response("{}", { status: 500 }) }); } finally { logs.restore(); }
  assert.equal((await one(env.DB, "SELECT wallet FROM users WHERE id = ?", f.u.id)).wallet, f.w.address);
  assert.ok(logs.lines.some((l) => /wallet link notice not sent/.test(l)) && !logs.lines.some((l) => l.includes("fay@example.com")), "logged without the address");
  // the words, on their own
  assert.match(walletLinkedEmail("Abcd…wxyz", null).text, /^The wallet Abcd…wxyz was connected/);
});

test("a session a wallet made is renewed while it is used (15 of its 30 days left → 30 again, the same cookie with a fresh Max-Age); a Google session is not", async () => {
  const m = await safari();
  const app = await linkInApp(m);
  const sid = async (b) => (await one(env.DB, "SELECT expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC", m.u.id));
  advance(10 * DAY);
  let r = await app.send("/api/me?lite=1");
  assert.deepEqual(r.headers.getSetCookie(), [], "20 days left: nothing to do");
  advance(6 * DAY);
  const token = app.jar.get("vs");
  r = await app.send("/api/me?lite=1");
  const set = r.headers.getSetCookie();
  assert.equal(set.length, 1);
  assert.equal(set[0], `vs=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  const exp = await env.DB.prepare("SELECT expires_at FROM sessions WHERE wallet IS NOT NULL AND proven_at IS NOT NULL").first();
  assert.equal(exp.expires_at, new Date(Date.now() + 30 * DAY).toISOString());
  assert.ok(await sid(app));
  // Safari's Google session: never renewed
  const s = await m.b.send("/api/me?lite=1");
  assert.deepEqual(s.headers.getSetCookie(), []);
  advance(15 * DAY);
  assert.equal((await m.b.get("/api/me?lite=1")).signedIn, false, "it ran out after its 30 days");
  assert.equal((await app.get("/api/me?lite=1")).signedIn, true, "the wallet app's is still good");
});
