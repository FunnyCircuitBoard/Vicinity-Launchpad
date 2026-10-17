// In-app notices behind NOTIFY (src/flags.js notifyOn, src/notify.js): one plain sentence per event on the dashboard's Notifications tab,
// per-kind controls, no e-mail, no push. With the switch off every answer, page and table is exactly as before; with it on, every rule
// here goes through the real API and real SQL (test/helpers/world.js), and the page through the dashboard harness (test/helpers/dashpage.js).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DAY, HOUR, IN_NYC, IN_UTICA, MINT, advance, attest, browser, clock, newWorld, passTime, person, realClock, reprove, tick, useClock } from "./helpers/world.js";
import { expectStatus, pfPerson, schemaOf, seedUsers } from "./helpers/profiles.js";
import { d1 } from "./helpers/d1.js";
import { ADDR, memberMe, openDashboard } from "./helpers/dashpage.js";
import { newEvent } from "./helpers/pagedom.js";
import { notifyOn } from "../src/flags.js";
import { NOTIFY_MIGRATION, ensureNotifySchema, ensureSchema } from "../src/store.js";
import { BATCH_MAX, KEEP, KINDS, PAGE, PICTURE_REASON, POST_REASON, READ_MAX, REPLIES_TEXT, line, notify, notifyMany, notifyReply, prefsOf } from "../src/notify.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ON = (extra = {}) => newWorld({ NOTIFY: "on", ...extra });
const iso = (ms) => new Date(ms).toISOString();
const UTICA = "5142056";
const userId = async (env, p) => (await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(p.w.address).first()).id;
/** A seat for `p` (active by default; a Seed Steward on probation, a provisional founder...). Returns the seat id. */
async function seat(env, p, { city = UTICA, name = "Utica", status = "active", activatedAt = iso(clock.now), probationUntil = null, appealUntil = null, threshold = 1 } = {}) {
  const r = await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at, probation_until, appeal_until) VALUES (?, ?, 'US', ?, ?, 5, ?, ?, ?, ?, ?, ?)")
    .bind(city, name, await userId(env, p), p.w.address, threshold, status, iso(clock.now), activatedAt, probationUntil, appealUntil).run();
  return r.meta.last_row_id;
}
/** The notice rows of `p`, oldest first: what the database really holds (none at all while no notice was ever written: no table yet). */
async function rowsOf(env, p) {
  const id = await userId(env, p);
  try { return (await env.DB.prepare("SELECT kind, ref, text, href, read_at FROM notices WHERE user_id = ? ORDER BY id").bind(id).all()).results; }
  catch (e) { if (/no such table/.test(String(e))) return []; throw e; }
}
const texts = async (env, p) => (await rowsOf(env, p)).map((r) => r.text);
const post = (p, body) => p.send("/api/posts", { method: "POST", body });
const reply = (p, parent, body = "Same here") => p.post("/api/posts", { parent, body });
/** n admins (ADMIN_WALLETS lists them all), living in NYC: moderation needs a second and a third person who were not involved. */
async function admins(env, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await person(env, { home: IN_NYC }));
  env.ADMIN_WALLETS = out.map((p) => p.w.address).join(",");
  return out;
}
/** A staff role from the admin console's own table (the /api/admin/* routes). */
async function staff(env, role) {
  const p = await person(env, { home: IN_NYC });
  await env.DB.prepare("INSERT INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, ?, 'test', ?)").bind(p.w.address, role, iso(clock.now)).run();
  return p;
}
// a 1×1 PNG and one that differs in its last bytes (both pass readImage's magic-byte check)
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c63f8ffff3f0005fe02fea7d6a3f40000000049454e44ae426082", "hex").toString("base64");
const PNG2 = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c63f8ffff3f0005fe02fea7d6a3f40000000049454e44ae426083", "hex").toString("base64");

beforeEach(() => useClock("2026-10-16T12:00:00Z"));
after(() => realClock());

/* ---------------- the switch ---------------- */

test("notifyOn: exactly 'on', trimmed, any letter case; the switch is listed in wrangler.jsonc", () => {
  for (const v of ["on", " on ", "ON", "On", "\ton\n"]) assert.equal(notifyOn({ NOTIFY: v }), true, JSON.stringify(v));
  for (const v of [undefined, "", "off", "true", "1", "yes", "v2", "onn"]) assert.equal(notifyOn(v === undefined ? {} : { NOTIFY: v }), false, JSON.stringify(v));
  assert.equal(notifyOn(undefined), false);
  assert.equal(notifyOn({ NOTIFY: true }), false, "a boolean is not the word on");
  assert.match(read("wrangler.jsonc"), /\n    "NOTIFY": "(on|off)",?\n/, "the switch is listed in wrangler.jsonc (on since 17 Oct 2026; flipping it is that one word)");
  assert.deepEqual([...KINDS], ["reply", "moderation", "picture", "founder", "election"]);
});

test("switch off = today: the three paths answer exactly what an unknown path answers, /api/me has no unread key in any shape, a reply and a hide write nothing, no table, column or migration row", async () => {
  const env = newWorld();
  const [m] = await admins(env, 1);
  const a = await pfPerson(env, "ann", { home: IN_UTICA }), b = await pfPerson(env, "bob", { home: IN_UTICA });
  for (const [path, method] of [["/api/notices", "GET"], ["/api/notices", "POST"], ["/api/notices/read", "POST"], ["/api/notices/prefs", "GET"], ["/api/notices/prefs", "POST"], ["/api/no-such-thing", "GET"]]) {
    const r = await a.send(path, { method, body: method === "POST" ? { all: true, reply: false } : undefined });
    assert.equal(r.status, 404, path);
    assert.deepEqual(await r.json(), { error: "not_found" }, `${method} ${path}`);
  }
  const p = await a.post("/api/posts", { scope: "city", kind: "talk", body: "Hello Utica" });
  assert.equal((await reply(b, p.post.id)).ok, true);
  assert.equal((await m.post("/api/mod/hide", { id: p.post.id, reason: "off_topic" })).ok, true);
  for (const d of [await a.get("/api/me?lite=1"), await a.get("/api/me"), await browser(env).get("/api/me")]) assert.ok(!("unread" in d) && !JSON.stringify(d).includes("unread"), "no new key");
  // the admin console's objection decision: not even the hook's seat lookup runs (the one statement the switch-on path adds)
  const f = await pfPerson(env, "fay", { home: IN_UTICA }), o = await pfPerson(env, "obj", { home: IN_UTICA });
  const sid = await seat(env, f, { status: "provisional", appealUntil: iso(clock.now + DAY) });
  assert.equal((await o.post("/api/seats/object", { seatId: sid, reason: "Not a local person at all, I think." })).ok, true);
  const oid = (await env.DB.prepare("SELECT id FROM objections WHERE seat_id = ?").bind(sid).first()).id;
  const console_ = await staff(env, "admin");
  const realPrepare = env.DB.prepare; let lookups = 0;
  env.DB.prepare = (sql) => { if (/SELECT user_id, city_name FROM seats/.test(sql)) lookups++; return realPrepare(sql); };
  try { assert.equal((await console_.post("/api/admin/objections/decide", { id: oid, uphold: false, note: "No evidence." })).upheld, false); }
  finally { env.DB.prepare = realPrepare; }
  assert.equal(lookups, 0, "the hook's lookup never runs with the switch off");
  const { tables, columns } = await schemaOf(env.DB);
  assert.ok(!tables.includes("notices") && !columns.includes("notice_prefs"), "nothing new was made");
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(NOTIFY_MIGRATION.id).first("n"), 0);
});

test("switch on: the full /api/me carries unread (0 to start), the lite and signed-out shapes do not; the routes answer; the migration ran once and is additive; flipped off, the very next answer is dark", async () => {
  const env = ON();
  const a = await person(env, { home: IN_UTICA });
  assert.equal((await a.get("/api/me")).unread, 0);
  assert.ok(!("unread" in (await a.get("/api/me?lite=1"))), "lite: the header's shape is untouched");
  assert.ok(!("unread" in (await browser(env).get("/api/me"))), "signed out: untouched");
  assert.deepEqual(await a.get("/api/notices"), { ok: true, unread: 0, notices: [] });
  assert.deepEqual(await a.get("/api/notices/prefs"), { ok: true, prefs: { reply: true, moderation: true, picture: true, founder: true, election: true } });
  const { tables, columns } = await schemaOf(env.DB);
  assert.ok(tables.includes("notices") && columns.includes("notice_prefs"));
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(NOTIFY_MIGRATION.id).first("n"), 1);
  assert.equal((await browser(env).send("/api/notices")).status, 401, "signed out: sign in (never a list)");
  env.NOTIFY = "off";
  assert.ok(!("unread" in (await a.get("/api/me"))));
  assert.equal((await a.send("/api/notices")).status, 404);
});

test("migration: idempotent, with and without the column and the table already there; nothing is dropped or rewritten", async () => {
  const db = d1();
  await ensureSchema(db);
  await ensureNotifySchema(db);
  assert.equal(await ensureNotifySchema(db), undefined, "repeat: a no-op");
  assert.ok(await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(NOTIFY_MIGRATION.id).first(), "recorded once");
  // a second server whose column and table are already there (the ALTER says "duplicate column", the CREATEs are IF NOT EXISTS): nothing breaks
  const db2 = d1();
  await ensureSchema(db2);
  for (const s of NOTIFY_MIGRATION.sql.split(";").map((x) => x.trim()).filter(Boolean)) await db2.prepare(s).run();
  await db2.prepare("INSERT INTO users (wallet, provider, provider_id, name, created_at, notice_prefs) VALUES ('W', 'google', 'g', 'N', 't', '{\"reply\":false}')").run();
  await db2.prepare("INSERT INTO notices (user_id, kind, ref, text, href, created_at) VALUES (1, 'reply', '7', 'x', '/dashboard#community', 't')").run();
  await ensureNotifySchema(db2);
  assert.deepEqual(await db2.prepare("SELECT text FROM notices").all().then((r) => r.results), [{ text: "x" }], "the row is untouched");
  assert.equal(await db2.prepare("SELECT notice_prefs FROM users").first("notice_prefs"), '{"reply":false}');
  assert.ok(await db2.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(NOTIFY_MIGRATION.id).first());
  // the helpers: one plain line of at most 200 characters; the controls read with every kind on unless switched off
  assert.equal(line("  a\u0000b\n\nc   d  "), "a b c d");
  assert.equal(line("x".repeat(300)).length, 200);
  // counted as code points: a two-unit character at the edge is kept whole or not at all, never half of it
  const smile = String.fromCodePoint(0x1f600);
  assert.equal(Array.from(line(smile.repeat(201))).length, 200);
  const edge = line("a".repeat(199) + smile + smile);
  assert.deepEqual([Array.from(edge).length, edge.codePointAt(199), edge.length], [200, 0x1f600, 201]);
  // the rules' reason codes in the site's own words (the feed's for a post, the coin card's for a picture), every code covered
  assert.deepEqual(Object.keys(POST_REASON).sort(), ["abuse", "illegal", "off_topic", "other", "scam", "spam"]);
  assert.deepEqual(Object.keys(PICTURE_REASON).sort(), Object.keys(POST_REASON).sort());
  assert.deepEqual(prefsOf(null), { reply: true, moderation: true, picture: true, founder: true, election: true });
  assert.deepEqual(prefsOf('{"reply":false,"junk":1}'), { reply: false, moderation: true, picture: true, founder: true, election: true });
  assert.deepEqual(prefsOf("not json"), { reply: true, moderation: true, picture: true, founder: true, election: true });
});

/* ---------------- replies ---------------- */

test("reply: the parent's author is told by username (\"A member\" without one), never the replier, never for a reply to your own post; a second reply before the first was read bumps that row instead of adding one; the row's shape; a hidden parent cannot be replied to", async () => {
  const env = ON();
  const a = await pfPerson(env, "ann", { home: IN_UTICA }), b = await pfPerson(env, "jo_utica", { home: IN_UTICA }), c = await person(env, { home: IN_UTICA });
  const [m] = await admins(env, 1);
  await env.DB.prepare("UPDATE users SET handle = NULL WHERE id = ?").bind(await userId(env, c)).run(); // an account from before usernames: a display name only
  const p = await a.post("/api/posts", { scope: "city", kind: "talk", body: "Hello Utica" });
  const q = await a.post("/api/posts", { scope: "city", kind: "talk", body: "Second post" });
  assert.equal((await reply(b, p.post.id)).ok, true);
  assert.equal((await reply(a, p.post.id, "Replying to myself")).ok, true);
  assert.equal((await reply(c, q.post.id)).ok, true); // no username: the notice never carries the display name (free text from Google)
  assert.deepEqual(await texts(env, a), ["jo_utica replied to your post.", "A member replied to your post."]);
  assert.deepEqual(await texts(env, b), [], "the replier is told nothing");
  const rows = await rowsOf(env, a);
  assert.deepEqual(rows[0], { kind: "reply", ref: String(p.post.id), text: "jo_utica replied to your post.", href: "/dashboard#community", read_at: null });
  // the route's shape: newest first, unread, the time
  const d = await a.get("/api/notices");
  assert.equal(d.unread, 2);
  assert.deepEqual(d.notices.map((n) => [n.kind, n.text, n.href, n.read, n.at]), [["reply", "A member replied to your post.", "/dashboard#community", false, iso(clock.now)], ["reply", "jo_utica replied to your post.", "/dashboard#community", false, iso(clock.now)]]);
  assert.ok(d.notices.every((n) => Number.isInteger(n.id)));
  assert.deepEqual(Object.keys(d.notices[0]).sort(), ["at", "href", "id", "kind", "read", "text"]);
  assert.equal((await a.get("/api/me")).unread, 2);
  assert.ok(!JSON.stringify(d).includes(a.w.address) && !JSON.stringify(d).includes(b.w.address), "no wallet anywhere");
  // a second reply to the first post before ann read the notice: the same row, bumped to now with the plain text, first in the list
  advance(60_000);
  assert.equal((await reply(c, p.post.id)).ok, true);
  assert.deepEqual(await texts(env, a), [REPLIES_TEXT, "A member replied to your post."], "two rows still");
  const d2 = await a.get("/api/notices");
  assert.deepEqual(d2.notices.map((n) => [n.text, n.at, n.read]), [[REPLIES_TEXT, iso(clock.now), false], ["A member replied to your post.", iso(clock.now - 60_000), false]]);
  assert.equal(d2.unread, 2);
  // once read, the next reply is a new row again
  assert.deepEqual(await a.post("/api/notices/read", { all: true }), { ok: true, unread: 0 });
  assert.equal((await reply(b, p.post.id)).ok, true);
  assert.deepEqual(await texts(env, a), [REPLIES_TEXT, "A member replied to your post.", "jo_utica replied to your post."]);
  assert.equal((await a.get("/api/me")).unread, 1);
  // a hidden parent takes no reply at all (so nothing to tell); the hide itself is a moderation notice
  assert.equal((await m.post("/api/mod/hide", { id: p.post.id, reason: "spam" })).ok, true);
  await expectStatus(await b.send("/api/posts", { method: "POST", body: { parent: p.post.id, body: "late" } }), 404, "not_found");
  assert.equal((await texts(env, a)).length, 4);
  assert.equal((await texts(env, a))[3], "Your post was hidden: spam.");
});

test("flood: 250 replies to one post are one unread row for its author, so an unread ban notice stays; a muted replier bumps nothing; at the cap, read rows go before unread ones", async () => {
  const env = ON({ FEED_V2: "on" });
  const a = await pfPerson(env, "ann", { home: IN_UTICA }), b = await pfPerson(env, "bob", { home: IN_UTICA }), c = await pfPerson(env, "cat", { home: IN_UTICA });
  const aid = await userId(env, a), bid = await userId(env, b), cid = await userId(env, c);
  const p = await a.post("/api/posts", { scope: "city", kind: "talk", body: "Hello" });
  const ban = "You were banned for 30 days: spam. The Home tab shows until when, and how to appeal.";
  assert.equal(await notify(env, { to: aid, kind: "moderation", ref: 9, text: ban, href: "/dashboard#home" }), 1);
  const parent = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(p.post.id).first();
  for (let i = 0; i < 250; i++) { advance(1000); assert.equal(await notifyReply(env, { parent, by: { id: bid, handle: "bob" } }), 1, `reply ${i}`); }
  assert.deepEqual((await rowsOf(env, a)).map((r) => [r.text, r.read_at]), [[ban, null], [REPLIES_TEXT, null]], "one reply row, the ban still there");
  const bumped = await env.DB.prepare("SELECT created_at FROM notices WHERE user_id = ? AND kind = 'reply'").bind(aid).first("created_at");
  assert.equal(bumped, iso(clock.now), "bumped to the latest reply");
  assert.equal((await a.get("/api/me")).unread, 2);
  // a muted replier: no row, no bump
  assert.equal((await a.post("/api/mute", { user: "cat", on: true })).muted, true);
  advance(1000);
  assert.equal(await notifyReply(env, { parent, by: { id: cid, handle: "cat" } }), 0);
  assert.equal(await env.DB.prepare("SELECT created_at FROM notices WHERE user_id = ? AND kind = 'reply'").bind(aid).first("created_at"), bumped);
  assert.equal((await rowsOf(env, a)).length, 2);
  // the cap keeps unread notices before read ones: the two are read, then 199 unread arrive: 201 rows, and the oldest READ row goes
  assert.deepEqual(await a.post("/api/notices/read", { all: true }), { ok: true, unread: 0 });
  for (let i = 1; i <= KEEP - 1; i++) { advance(1000); assert.equal(await notify(env, { to: aid, kind: "founder", ref: i, text: `f${i}`, href: "/dashboard#founder" }), 1); }
  const left = (await env.DB.prepare("SELECT text, read_at FROM notices WHERE user_id = ? ORDER BY id").bind(aid).all()).results;
  assert.equal(left.length, KEEP);
  assert.deepEqual(left.filter((r) => r.read_at).map((r) => r.text), [REPLIES_TEXT], "the older read row (the ban) went, the newer read row stayed");
  assert.equal(left.filter((r) => !r.read_at).length, KEEP - 1, "no unread row went");
  assert.equal((await a.get("/api/me")).unread, KEEP - 1);
});
test("reply: nobody you muted (FEED_V2) or blocked, or who blocked you (PROFILES), is announced; a deleted parent takes no reply", async () => {
  // mutes: feed v2 on (the muted member can still reply; the notice stays away)
  const env = ON({ FEED_V2: "on", PROFILES: "on" });
  const a = await pfPerson(env, "ann", { home: IN_UTICA }), b = await pfPerson(env, "bob", { home: IN_UTICA }), c = await pfPerson(env, "cat", { home: IN_UTICA });
  const p = await a.post("/api/posts", { scope: "city", kind: "talk", body: "Hello" });
  assert.equal((await a.post("/api/mute", { user: "bob", on: true })).muted, true);
  assert.equal((await reply(b, p.post.id)).ok, true, "a muted member can still reply");
  assert.equal((await reply(c, p.post.id)).ok, true);
  assert.deepEqual(await texts(env, a), ["cat replied to your post."]);
  // a deleted parent (feed v2): no reply, so nothing to tell
  assert.equal((await a.post("/api/posts/delete", { id: p.post.id })).deleted, true);
  await expectStatus(await c.send("/api/posts", { method: "POST", body: { parent: p.post.id, body: "late" } }), 404, "not_found");
  // blocks: profiles on, feed v2 off (the feed does not hide the post, so the reply lands; the notice stays away either way round)
  const env2 = ON({ PROFILES: "on" });
  const x = await pfPerson(env2, "xan", { home: IN_UTICA }), y = await pfPerson(env2, "yul", { home: IN_UTICA }), z = await pfPerson(env2, "zed", { home: IN_UTICA }), w = await pfPerson(env2, "wim", { home: IN_UTICA });
  const q = await x.post("/api/posts", { scope: "city", kind: "talk", body: "Hello" });
  assert.equal((await x.post("/api/block", { handle: "yul", block: true })).ok, true, "x blocked y");
  assert.equal((await z.post("/api/block", { handle: "xan", block: true })).ok, true, "z blocked x");
  assert.equal((await reply(y, q.post.id)).ok, true);
  assert.equal((await reply(z, q.post.id)).ok, true);
  assert.equal((await reply(w, q.post.id)).ok, true);
  assert.deepEqual(await texts(env2, x), ["wim replied to your post."]);
  // without those tables (no profiles, no feed v2) every reply is announced
  const env3 = ON();
  const s = await pfPerson(env3, "sam", { home: IN_UTICA }), t = await pfPerson(env3, "tom", { home: IN_UTICA });
  const r = await s.post("/api/posts", { scope: "city", kind: "talk", body: "Hello" });
  assert.equal((await reply(t, r.post.id)).ok, true);
  assert.deepEqual(await texts(env3, s), ["tom replied to your post."]);
  const { tables } = await schemaOf(env3.DB);
  assert.ok(!tables.includes("mutes") && !tables.includes("blocks"), "no mute or block table was made for it");
});

/* ---------------- the controls ---------------- */

test("controls: five trues to start; POST saves booleans (partial, unknown keys ignored, a non-boolean is 400); a kind switched off writes nothing for that person; stored as JSON on users.notice_prefs", async () => {
  const env = ON();
  const a = await pfPerson(env, "ann", { home: IN_UTICA }), b = await pfPerson(env, "bob", { home: IN_UTICA });
  const p = await a.post("/api/posts", { scope: "city", kind: "talk", body: "Hello" });
  assert.deepEqual((await a.post("/api/notices/prefs", { reply: false, junk: 1 })).prefs, { reply: false, moderation: true, picture: true, founder: true, election: true });
  assert.equal(await env.DB.prepare("SELECT notice_prefs FROM users WHERE id = ?").bind(await userId(env, a)).first("notice_prefs"), '{"reply":false,"moderation":true,"picture":true,"founder":true,"election":true}');
  assert.equal((await reply(b, p.post.id)).ok, true);
  assert.deepEqual(await texts(env, a), [], "a kind switched off writes nothing");
  await expectStatus(await a.send("/api/notices/prefs", { method: "POST", body: { moderation: "no" } }), 400, "bad_request");
  await expectStatus(await a.send("/api/notices/prefs", { method: "POST", body: "x" }), 400, "bad_json");
  assert.deepEqual((await a.get("/api/notices/prefs")).prefs.reply, false, "a refused change changed nothing");
  assert.deepEqual((await a.post("/api/notices/prefs", { reply: true })).prefs.reply, true);
  assert.equal((await reply(b, p.post.id)).ok, true);
  assert.deepEqual(await texts(env, a), ["bob replied to your post."]);
  assert.equal((await b.get("/api/notices/prefs")).prefs.reply, true, "one person's choice is theirs alone");
});

/* ---------------- moderation ---------------- */

test("moderation: hidden with the public reason, shown again, banned (30 days, the reason), the appeal decided either way, the five-report hide; the moderators get nothing", async () => {
  const env = ON();
  const [m1, m2, m3] = await admins(env, 3);
  const a = await pfPerson(env, "ann", { home: IN_UTICA });
  const p = await a.post("/api/posts", { scope: "city", kind: "talk", body: "Hello" });
  assert.equal((await m1.post("/api/mod/hide", { id: p.post.id, reason: "off_topic", note: "secret note" })).ok, true);
  assert.equal((await m1.post("/api/mod/unhide", { id: p.post.id })).ok, true);
  assert.deepEqual(await texts(env, a), ["Your post was hidden: off topic.", "Your post is shown again."]);
  assert.ok(!(await texts(env, a)).join(" ").includes("secret note"), "never the moderator's note");
  assert.deepEqual((await rowsOf(env, a)).map((r) => [r.kind, r.ref, r.href]), [["moderation", String(p.post.id), "/dashboard#community"], ["moderation", String(p.post.id), "/dashboard#community"]]);
  // a ban: proposed by one admin, approved by another; then the appeal, decided by a third
  const prop = await m1.post("/api/mod/ban", { postId: p.post.id, reason: "spam" });
  assert.equal(prop.proposed, true, JSON.stringify(prop));
  assert.deepEqual((await texts(env, a)).length, 2, "a proposal alone tells nobody");
  assert.equal((await m2.post("/api/mod/ban/approve", { actionId: prop.actionId })).banned, true);
  assert.equal((await texts(env, a))[2], "You were banned for 30 days: spam. The Home tab shows until when, and how to appeal.");
  assert.equal((await rowsOf(env, a))[2].href, "/dashboard#home");
  assert.equal((await a.post("/api/appeals", { actionId: prop.actionId, text: "I was only saying hello to my neighbours." })).ok, true);
  const ap = await env.DB.prepare("SELECT id FROM appeals WHERE action_id = ?").bind(prop.actionId).first();
  assert.equal((await m3.post("/api/appeals/decide", { id: ap.id, overturn: false })).status, "upheld");
  assert.equal((await texts(env, a))[3], "Your appeal was declined: the decision stands.");
  // a second case, overturned
  const b = await pfPerson(env, "bob", { home: IN_UTICA });
  const q = await b.post("/api/posts", { scope: "city", kind: "talk", body: "Hi" });
  assert.equal((await m1.post("/api/mod/hide", { id: q.post.id, reason: "abuse" })).ok, true);
  const act = await env.DB.prepare("SELECT id FROM mod_actions WHERE target_id = ? AND action = 'hide'").bind(q.post.id).first();
  assert.equal((await b.post("/api/appeals", { actionId: act.id, text: "Please look again, it was a greeting." })).ok, true);
  const ap2 = await env.DB.prepare("SELECT id FROM appeals WHERE action_id = ?").bind(act.id).first();
  assert.equal((await m2.post("/api/appeals/decide", { id: ap2.id, overturn: true })).status, "overturned");
  assert.deepEqual(await texts(env, b), ["Your post was hidden: abuse.", "Your appeal was accepted: the decision was reversed."]);
  // five reports hide a post: the author is told once
  const c = await pfPerson(env, "cat", { home: IN_UTICA });
  const r = await c.post("/api/posts", { scope: "city", kind: "talk", body: "Report me" });
  for (let i = 0; i < 5; i++) assert.equal((await (await person(env, { home: IN_UTICA })).post("/api/posts/report", { id: r.post.id, reason: "spam" })).ok, true);
  assert.deepEqual(await texts(env, c), ["Your post was hidden after reports from the community."]);
  for (const m of [m1, m2, m3]) assert.deepEqual(await texts(env, m), [], "a moderator is told nothing of their own acts");
  assert.equal((await a.get("/api/me")).unread, 4);
});

/* ---------------- the coin picture ---------------- */

test("picture: approved, not approved with the reason (the note stays on the coin card), taken down; the admin gets nothing", async () => {
  const env = ON({ VICINITY_MINT: MINT });
  const f = await pfPerson(env, "fay", { home: IN_UTICA, holds: 2_000_000 });
  await seat(env, f, { threshold: 1_000_000 });
  const adm = await staff(env, "admin");
  const [owner] = await admins(env, 1);
  assert.equal((await f.post("/api/coins/design", { name: "Utica Coin", pitch: "The Handshake City.", pair: "SOL", color: "emerald", image: PNG })).ok, true);
  assert.equal((await adm.post("/api/admin/logos/decide", { city: UTICA, action: "approve" })).ok, true);
  assert.deepEqual(await texts(env, f), ["Your coin picture was approved."]);
  assert.deepEqual((await rowsOf(env, f))[0], { kind: "picture", ref: UTICA, text: "Your coin picture was approved.", href: "/dashboard#founder", read_at: null });
  // a replacement, not approved: the reason in the notice, the note on the card alone
  assert.equal((await f.post("/api/coins/design", { name: "Utica Coin", pitch: "The Handshake City.", pair: "SOL", color: "emerald", image: PNG2 })).ok, true);
  assert.equal((await adm.post("/api/admin/logos/decide", { city: UTICA, action: "reject", reason: "other", note: "Too small to read." })).ok, true);
  assert.equal((await texts(env, f))[1], "Your coin picture was not approved: it breaks the rules. The note is on your coin card.", "the coin card's own words for the reason");
  assert.equal((await f.get(`/api/coins?city=${UTICA}`)).coin.logoNote, "Too small to read.", "the note is on the card");
  assert.ok(!(await texts(env, f)).join(" ").includes("Too small"), "never the note in a notice");
  // a takedown by the owner (src/coins.js)
  assert.equal((await owner.post("/api/coins/takedown", { city: UTICA, what: "logo", reason: "scam", note: "Copies another coin." })).ok, true);
  assert.equal((await texts(env, f))[2], "Your coin picture was taken down: scam or impersonation.");
  assert.deepEqual([await texts(env, adm), await texts(env, owner)], [[], []]);
});

/* ---------------- founder ---------------- */

test("founder: a challenge window opened in your home city (every member, nobody elsewhere), the verdict to every applicant (the chosen one told so); a standard window's verdict; probation ended", async () => {
  const env = ON({ VICINITY_MINT: MINT });
  const a = await pfPerson(env, "ann", { home: IN_UTICA, holds: 2_000_000 }), whale = await pfPerson(env, "wal", { home: IN_UTICA, holds: 100_000_000 });
  const local = await pfPerson(env, "loc", { home: IN_UTICA }), away = await pfPerson(env, "nyc", { home: IN_NYC });
  await tick(env);
  await passTime(env, 15 * DAY);
  for (const p of [a, whale]) assert.equal((await p.post("/api/posts", { kind: "checkin", attestation: await attest(p, IN_UTICA, "checkin") })).ok, true);
  const apply = async (p) => { await reprove(p); return p.post("/api/seats/apply", { attestation: await attest(p, IN_UTICA, "apply"), pitch: "For Utica" }); };
  const ra = await apply(a);
  assert.equal(ra.steward, true, JSON.stringify(ra));
  assert.deepEqual(await texts(env, local), [], "a lone claimer becomes steward at once: no window opened");
  const rw = await apply(whale);
  assert.equal(rw.challenge, true, JSON.stringify(rw));
  const opened = "A challenge to Utica's Seed Steward opened. The window closes in 72 hours.";
  for (const p of [a, whale, local]) assert.deepEqual(await texts(env, p), [opened], p.handle);
  assert.deepEqual(await texts(env, away), [], "another city hears nothing");
  const w = await env.DB.prepare("SELECT id FROM windows WHERE city_id = ? AND kind = 'steward_challenge'").bind(UTICA).first();
  assert.deepEqual((await rowsOf(env, local))[0], { kind: "founder", ref: String(w.id), text: opened, href: "/dashboard#founder", read_at: null });
  // the window closes (no endorsements: the steward keeps the seat); both applicants are told, the steward that the seat stays theirs
  await passTime(env, 73 * HOUR);
  assert.deepEqual(await texts(env, a), [opened, "The challenge to Utica's Seed Steward was decided: you keep the seat."]);
  assert.deepEqual(await texts(env, whale), [opened, "The challenge to Utica's Seed Steward was decided. The result is on your Founder tab."]);
  assert.equal(await env.DB.prepare("SELECT status FROM seats WHERE user_id = ?").bind(await userId(env, a)).first("status"), "steward");
  assert.deepEqual(await texts(env, local), [opened], "a bystander hears of the opening only");
  // a standard window that closes with no valid applicant: every applicant is told
  const env2 = ON({ VICINITY_MINT: MINT });
  const p1 = await pfPerson(env2, "pat", { home: IN_NYC }), p2 = await pfPerson(env2, "quinn", { home: IN_NYC });
  await tick(env2);
  const win = await env2.DB.prepare("INSERT INTO windows (city_id, city_name, country, policy, threshold, opened_at, closes_at) VALUES ('5128581', 'New York City', 'US', 5, 1000000, ?, ?)").bind(iso(clock.now - 73 * HOUR), iso(clock.now - HOUR)).run();
  for (const p of [p1, p2]) await env2.DB.prepare("INSERT INTO applications (window_id, city_id, user_id, wallet, pitch, created_at) VALUES (?, '5128581', ?, ?, 'x', ?)").bind(win.meta.last_row_id, await userId(env2, p), p.w.address, iso(clock.now - 72 * HOUR)).run();
  await tick(env2);
  assert.equal(await env2.DB.prepare("SELECT status FROM windows WHERE id = ?").bind(win.meta.last_row_id).first("status"), "empty");
  for (const p of [p1, p2]) assert.deepEqual(await texts(env2, p), ["The claim window in New York City was decided. The result is on your Founder tab."], p.handle);
  // a Seed Steward's probation ends in the job: confirmed, and told
  const env3 = ON({ VICINITY_MINT: MINT });
  const s = await pfPerson(env3, "sue", { home: IN_UTICA, holds: 2_000_000 });
  await seat(env3, s, { status: "steward", probationUntil: iso(clock.now - HOUR), threshold: 1 });
  await tick(env3);
  assert.equal(await env3.DB.prepare("SELECT status FROM seats WHERE user_id = ?").bind(await userId(env3, s)).first("status"), "active");
  assert.deepEqual(await texts(env3, s), ["Your Seed Steward probation ended: you are Utica's confirmed founder."]);
  await tick(env3);
  assert.equal((await texts(env3, s)).length, 1, "told once");
});

test("founder verdict: \"you were chosen\" goes only to the applicant whose seat was really created; when the city's seat is taken by the time a window with two valid applicants closes, nobody is seated and nobody reads it", async () => {
  const env = ON({ VICINITY_MINT: MINT });
  const NYC = "5128581";
  const p1 = await pfPerson(env, "pat", { home: IN_NYC, holds: 2_000_000 }), p2 = await pfPerson(env, "quinn", { home: IN_NYC, holds: 2_000_000 });
  const other = await pfPerson(env, "oth", { home: IN_NYC });
  await tick(env);
  await passTime(env, 15 * DAY); // balance samples: both applicants qualify
  const win = await env.DB.prepare("INSERT INTO windows (city_id, city_name, country, policy, threshold, opened_at, closes_at) VALUES (?, 'New York City', 'US', 5, 1000000, ?, ?)").bind(NYC, iso(clock.now - 73 * HOUR), iso(clock.now - HOUR)).run();
  for (const p of [p1, p2]) await env.DB.prepare("INSERT INTO applications (window_id, city_id, user_id, wallet, pitch, created_at) VALUES (?, ?, ?, ?, 'x', ?)").bind(win.meta.last_row_id, NYC, await userId(env, p), p.w.address, iso(clock.now - 72 * HOUR)).run();
  await seat(env, other, { city: NYC, name: "New York City" }); // the city's one live seat is somebody else's by the time the window closes
  await tick(env);
  const w = await env.DB.prepare("SELECT status, result FROM windows WHERE id = ?").bind(win.meta.last_row_id).first();
  assert.equal(w.status, "decided");
  assert.equal(JSON.parse(w.result).applicants.filter((x) => x.valid).length, 2, "both applicants were valid");
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM seats WHERE user_id IN (?, ?)").bind(await userId(env, p1), await userId(env, p2)).first("n"), 0, "nobody was seated");
  for (const p of [p1, p2]) assert.deepEqual(await texts(env, p), ["The claim window in New York City was decided. The result is on your Founder tab."], p.handle);
  assert.deepEqual(await texts(env, other), [], "the seat holder applied to nothing");
});

test("founder: an objection against your seat decided, dismissed or upheld, by the site's route and by the admin console; the objector and the admin get nothing", async () => {
  const env = ON();
  const f = await pfPerson(env, "fay", { home: IN_UTICA }), o = await pfPerson(env, "obj", { home: IN_UTICA });
  const [adm] = await admins(env, 1);
  const sid = await seat(env, f, { status: "provisional", appealUntil: iso(clock.now + DAY) });
  assert.equal((await o.post("/api/seats/object", { seatId: sid, reason: "Not a local person at all, I think." })).ok, true);
  const o1 = await env.DB.prepare("SELECT id FROM objections WHERE seat_id = ?").bind(sid).first();
  assert.equal((await adm.post("/api/seats/objections/decide", { id: o1.id, uphold: false, note: "No evidence." })).status, "dismissed");
  assert.deepEqual(await texts(env, f), ["An objection against your seat in Utica was dismissed."]);
  // the same person may not object twice; a second local does, and this one is upheld through the admin console
  const o2p = await pfPerson(env, "two", { home: IN_UTICA });
  assert.equal((await o2p.post("/api/seats/object", { seatId: sid, reason: "The pitch copies another city's words." })).ok, true);
  const o2 = await env.DB.prepare("SELECT id FROM objections WHERE seat_id = ? AND status = 'open'").bind(sid).first();
  const console_ = await staff(env, "admin");
  assert.equal((await console_.post("/api/admin/objections/decide", { id: o2.id, uphold: true, note: "Agreed." })).upheld, true);
  assert.deepEqual(await texts(env, f), ["An objection against your seat in Utica was dismissed.", "An objection against your seat in Utica was upheld: the seat ended."]);
  assert.deepEqual((await rowsOf(env, f)).map((r) => [r.kind, r.ref, r.href]), [["founder", String(sid), "/dashboard#founder"], ["founder", String(sid), "/dashboard#founder"]]);
  for (const p of [o, o2p, adm, console_]) assert.deepEqual(await texts(env, p), [], p.handle || "admin");
  assert.ok(!(await texts(env, f)).join(" ").includes("Agreed") && !(await texts(env, f)).join(" ").includes("evidence"), "never a note");
  // the site's route, upheld
  const g = await pfPerson(env, "gil", { home: IN_NYC }), o3 = await pfPerson(env, "thr", { home: IN_NYC });
  const sid2 = await seat(env, g, { city: "5128581", name: "New York City", status: "provisional", appealUntil: iso(clock.now + DAY) });
  assert.equal((await o3.post("/api/seats/object", { seatId: sid2, reason: "Lives somewhere else entirely." })).ok, true);
  const o3r = await env.DB.prepare("SELECT id FROM objections WHERE seat_id = ?").bind(sid2).first();
  assert.equal((await adm.post("/api/seats/objections/decide", { id: o3r.id, uphold: true })).status, "upheld");
  assert.deepEqual(await texts(env, g), ["An objection against your seat in New York City was upheld: the seat ended."]);
});

/* ---------------- elections ---------------- */

test("election: opened and closed, one notice per member of the country (a test-lab row none, another country none), through the job; the fan-out is one statement capped at 5,000 rows and the job says so", async () => {
  const env = ON({ VICINITY_MINT: MINT });
  const f = await pfPerson(env, "fay", { home: IN_UTICA, holds: 2_000_000 }), a = await pfPerson(env, "ann", { home: IN_NYC }), b = await pfPerson(env, "bob", { home: IN_UTICA });
  await env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, handle, name, home_city, home_name, home_country, created_at) VALUES ('TestLabWallet111111111111111111111111111111', 'testlab', 'seed-1', '@testlab1', 'Test Lab 1', ?, 'Utica', 'US', ?)").bind(UTICA, iso(clock.now)).run();
  await seat(env, f, { activatedAt: iso(clock.now - 31 * DAY), threshold: 1 });
  const r = await tick(env); // the job opens the election (a founder active for 30+ days stands) and tells the country
  assert.equal(r.elections.opened, 1, JSON.stringify(r.elections));
  assert.equal(r.elections.notified, 3);
  assert.ok(!r.elections.capped);
  const e = await env.DB.prepare("SELECT id FROM elections WHERE country = 'US'").first();
  const opened = "A Country Manager election opened in your country. Voting is open for 7 days.";
  for (const p of [f, a, b]) assert.deepEqual(await rowsOf(env, p), [{ kind: "election", ref: String(e.id), text: opened, href: "/dashboard#community", read_at: null }], p.handle);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM notices WHERE kind = 'election'").first("n"), 3, "the test-lab row got none");
  await passTime(env, 8 * DAY);
  assert.equal(await env.DB.prepare("SELECT status FROM elections WHERE id = ?").bind(e.id).first("status"), "decided");
  for (const p of [f, a, b]) assert.deepEqual(await texts(env, p), [opened, "The Country Manager election in your country closed. The result is on the Community tab, under your country."], p.handle);
  // the cap: a country of more than 5,000 members gets 5,000 rows from the one statement (the oldest accounts first), and the job says so
  const env2 = ON({ VICINITY_MINT: MINT });
  const g = await pfPerson(env2, "gil", { home: IN_UTICA, holds: 2_000_000 });
  await seedUsers(env2.DB, "u", BATCH_MAX + 2);
  await seat(env2, g, { activatedAt: iso(clock.now - 31 * DAY), threshold: 1 });
  const r2 = await tick(env2);
  assert.deepEqual([r2.elections.opened, r2.elections.notified, r2.elections.capped], [1, BATCH_MAX, true], JSON.stringify(r2.elections));
  assert.equal(await env2.DB.prepare("SELECT COUNT(*) AS n FROM notices").first("n"), BATCH_MAX);
  assert.deepEqual(await texts(env2, g), ["A Country Manager election opened in your country. Voting is open for 7 days."], "the oldest account is among the 5,000");
  // a fan-out skips a member who switched the kind off
  const env3 = ON();
  const h = await pfPerson(env3, "hal", { home: IN_UTICA }), i = await pfPerson(env3, "ida", { home: IN_UTICA });
  assert.equal((await h.post("/api/notices/prefs", { founder: false })).ok, true);
  const n = await notifyMany(env3, { column: "home_city", value: UTICA, kind: "founder", ref: 1, text: "A founder claim window opened in Utica. It closes in 72 hours.", href: "/dashboard#founder" });
  assert.deepEqual(n, { written: 1, capped: false });
  assert.deepEqual([await texts(env3, h), await texts(env3, i)], [[], ["A founder claim window opened in Utica. It closes in 72 hours."]]);
});

/* ---------------- the cap, the list, marking read ---------------- */

test("cap: at most 200 notices per person, the oldest go in the same write; a fan-out trims too", async () => {
  const env = ON();
  const a = await pfPerson(env, "ann", { home: IN_UTICA });
  const id = await userId(env, a);
  for (let i = 1; i <= KEEP + 3; i++) assert.equal(await notify(env, { to: id, kind: "reply", ref: i, text: `n${i}`, href: "/dashboard#community" }), 1);
  const rows = (await env.DB.prepare("SELECT text FROM notices WHERE user_id = ? ORDER BY id").bind(id).all()).results.map((r) => r.text);
  assert.equal(rows.length, KEEP);
  assert.deepEqual([rows[0], rows.at(-1)], ["n4", `n${KEEP + 3}`], "the three oldest went");
  const n = await notifyMany(env, { column: "home_city", value: UTICA, kind: "founder", text: "A founder claim window opened in Utica.", href: "/dashboard#founder" });
  assert.equal(n.written, 1);
  const after = (await env.DB.prepare("SELECT text FROM notices WHERE user_id = ? ORDER BY id").bind(id).all()).results.map((r) => r.text);
  assert.equal(after.length, KEEP);
  assert.deepEqual([after[0], after.at(-1)], ["n5", "A founder claim window opened in Utica."]);
  // a wrong kind, an empty text or a missing person writes nothing and never throws
  assert.equal(await notify(env, { to: id, kind: "spam", text: "x", href: "/" }), 0);
  assert.equal(await notify(env, { to: id, kind: "reply", text: "   ", href: "/" }), 0);
  assert.equal(await notify(env, { to: 999999, kind: "reply", text: "x", href: "/" }), 0);
  assert.equal(await notify(newWorld(), { to: id, kind: "reply", text: "x", href: "/" }), 0, "switch off: nothing");
});

test("the list is the newest 50 with the unread count; marking read by ids and all (only your own); unread follows on /api/me; bad bodies; 60 an hour", async () => {
  const env = ON();
  const a = await pfPerson(env, "ann", { home: IN_UTICA }), b = await pfPerson(env, "bob", { home: IN_UTICA });
  const id = await userId(env, a), bid = await userId(env, b);
  for (let i = 1; i <= 60; i++) { advance(1000); await notify(env, { to: id, kind: "reply", ref: i, text: `n${i}`, href: "/dashboard#community" }); }
  await notify(env, { to: bid, kind: "reply", ref: 1, text: "for bob", href: "/dashboard#community" });
  const d = await a.get("/api/notices");
  assert.equal(d.notices.length, PAGE);
  assert.deepEqual([d.notices[0].text, d.notices.at(-1).text, d.unread], ["n60", "n11", 60]);
  assert.equal((await a.get("/api/me")).unread, 60);
  // by ids: two of them (and a stranger's, which changes nothing for anybody)
  const bobs = (await env.DB.prepare("SELECT id FROM notices WHERE user_id = ?").bind(bid).first()).id;
  const r1 = await a.post("/api/notices/read", { ids: [d.notices[0].id, d.notices[1].id, bobs] });
  assert.deepEqual(r1, { ok: true, unread: 58 });
  assert.equal((await b.get("/api/notices")).unread, 1, "bob's stays unread");
  assert.deepEqual((await a.get("/api/notices")).notices.slice(0, 3).map((n) => n.read), [true, true, false]);
  assert.equal((await a.get("/api/me")).unread, 58);
  // all
  assert.deepEqual(await a.post("/api/notices/read", { all: true }), { ok: true, unread: 0 });
  assert.equal((await a.get("/api/me")).unread, 0);
  assert.ok((await a.get("/api/notices")).notices.every((n) => n.read));
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND read_at IS NULL").bind(id).first("n"), 0);
  // bad bodies (READ_MAX ids at most: one page, and under D1's 100 bound parameters per statement)
  assert.ok(READ_MAX <= 98 && READ_MAX >= PAGE, String(READ_MAX));
  for (const body of [{}, { ids: [] }, { ids: ["1"] }, { ids: [0] }, { ids: [1.5] }, { ids: Array.from({ length: READ_MAX + 1 }, (_, i) => i + 1) }, { all: "yes" }]) {
    await expectStatus(await a.send("/api/notices/read", { method: "POST", body }), 400, "bad_request");
  }
  await expectStatus(await a.send("/api/notices/read", { method: "POST", body: { all: true }, origin: null }), 403, "wrong_origin");
  // 60 marks an hour (the two above count): the 61st is refused, and an hour later it works again
  for (let i = 2; i < 60; i++) assert.equal((await a.post("/api/notices/read", { all: true })).ok, true, `mark ${i}`);
  await expectStatus(await a.send("/api/notices/read", { method: "POST", body: { all: true } }), 429, "slow_down");
  advance(HOUR + 1000);
  assert.equal((await a.post("/api/notices/read", { all: true })).ok, true);
});

test("best effort: when the notice table cannot be written, the reply still lands and the answer is as always", async () => {
  const env = ON();
  const a = await pfPerson(env, "ann", { home: IN_UTICA }), b = await pfPerson(env, "bob", { home: IN_UTICA });
  const p = await a.post("/api/posts", { scope: "city", kind: "talk", body: "Hello" });
  const real = env.DB;
  env.DB = { ...real, prepare: real.prepare, batch: (list) => (list.some((s) => /INSERT INTO notices/.test(s.sql)) ? Promise.reject(new Error("D1_ERROR: disk I/O error")) : real.batch(list)) };
  const quiet = console.error; const logged = [];
  console.error = (...x) => logged.push(x.join(" "));
  try {
    const r = await reply(b, p.post.id);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.post.body, "Same here");
  } finally { console.error = quiet; }
  assert.ok(logged.some((l) => l.startsWith("notice not written (reply)")), logged.join("\n"));
  env.DB = real;
  assert.deepEqual(await texts(env, a), []);
  assert.equal((await a.get("/api/me")).unread, 0);
});

/* ---------------- the page (dashboard v2 harness) ---------------- */

const NOTICES = [
  { id: 31, kind: "reply", text: "jo_utica replied to your post.", href: "/dashboard#community", at: "2026-10-16T11:58:00Z", read: false },
  { id: 30, kind: "picture", text: "Your coin picture was approved.", href: "/dashboard#founder", at: "2026-10-16T10:00:00Z", read: false },
  { id: 12, kind: "election", text: "A Country Manager election opened in your country. Voting is open for 7 days.", href: "/dashboard#community", at: "2026-10-15T10:00:00Z", read: true },
];
/** The page with the switch on: /api/me carries unread, the notice routes answer; every request is recorded. */
async function noticesPage({ notices = NOTICES, unread = 2, prefs = { reply: true, moderation: true, picture: true, founder: true, election: false } } = {}) {
  const errors = [];
  const me = { ...memberMe({ wallet: ADDR, handle: "jo_utica" }), unread };
  const api = async (path, body) => {
    if (path === "/api/notices") return { ok: true, unread, notices };
    if (path === "/api/notices/read") return { ok: true, unread: body.all ? 0 : Math.max(0, unread - body.ids.length) };
    if (path === "/api/notices/prefs") { if (body) Object.assign(prefs, body); return { ok: true, prefs }; }
    return undefined;
  };
  const p = await openDashboard({ me, api, storage: { vicinity_terms: "2026-10-01" }, globals: { console: { ...console, error: (...a) => errors.push(a.map(String).join(" ")) } } });
  return { ...p, errors };
}

test("page: the Notifications tab shows with the switch on (after Feed, the bell, the unread count in its badge, its name and the header), the list opens with unread rows marked and links to the right tab, the shown rows count as read after 2 s, Mark all read, the five controls save on change; no console errors", async () => {
  const p = await noticesPage();
  const tab = p.$("#tab-notify");
  assert.equal(tab.hidden, false, "the tab shows");
  assert.deepEqual([...p.$$(".dtab")].map((t) => t.id).slice(3, 6), ["tab-community", "tab-notify", "tab-rankings"], "right after Feed (Home, Wallet, City before)");
  assert.ok(tab.querySelector(".dtab__ico svg"), "a bell");
  assert.deepEqual([p.text("#tab-notify-n"), p.$("#tab-notify-n").hidden, tab.getAttribute("aria-label")], ["2", false, "Notifications, 2 unread"]);
  assert.equal(p.text("[data-account-avatar] .hdr-n"), "2", "the header's avatar carries the count");
  assert.equal(p.callsTo("/api/notices").length, 0, "nothing is asked until the tab opens");
  assert.equal(p.$("#panel-notify").hidden, true);
  // open the tab
  await p.tap(tab);
  assert.equal(p.win.VDash.active, "notify");
  assert.equal(p.$("#panel-notify").hidden, false);
  assert.equal(p.callsTo("/api/notices").length, 1);
  assert.equal(p.callsTo("/api/notices/prefs").length, 1, "the controls are read once");
  const rows = [...p.$$("#nt-list .nt-row")];
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.classList.contains("is-unread")), [true, true, false]);
  assert.deepEqual(rows.map((r) => r.querySelector(".nt-row__link").getAttribute("href")), ["#community", "#founder", "#community"], "a dashboard place opens in place");
  assert.equal(rows[0].querySelector(".nt-row__text").textContent, "Unread: jo_utica replied to your post.", "unread is said, not only coloured");
  assert.equal(rows[2].querySelector(".nt-row__text").textContent, "A Country Manager election opened in your country. Voting is open for 7 days.");
  assert.ok(rows[0].querySelector("time").getAttribute("datetime"));
  assert.equal(p.$("#nt-empty").hidden, true);
  assert.equal(p.$("#nt-all").hidden, false, "Mark all read shows while something is unread");
  assert.equal(p.text("#nt-all"), "Mark all read");
  assert.equal(p.$("#nt-err").hidden, true);
  // the controls: four on, Elections off (what the server said), each a switch with a label
  for (const [k, on] of [["reply", true], ["moderation", true], ["picture", true], ["founder", true], ["election", false]]) {
    const inp = p.$(`#ntp-${k}`);
    assert.deepEqual([inp.checked, inp.getAttribute("role"), inp.getAttribute("aria-checked"), inp.getAttribute("type")], [on, "switch", String(on), "checkbox"], k);
    assert.ok(p.$(`label[for="ntp-${k}"]`), `${k} has a label`);
  }
  // 2 s on the tab: the two unread rows are marked read, the badge and the header count go, the button hides
  assert.equal(p.callsTo("/api/notices/read").length, 0);
  await p.advance(1900);
  assert.equal(p.callsTo("/api/notices/read").length, 0, "not yet");
  await p.advance(200);
  const reads = p.callsTo("/api/notices/read");
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].body, { ids: [31, 30] });
  assert.deepEqual([...p.$$("#nt-list .nt-row")].map((r) => r.classList.contains("is-unread")), [false, false, false]);
  assert.equal(p.$("#nt-list .sr-only"), null, "the spoken 'Unread' goes with it");
  assert.deepEqual([p.$("#tab-notify-n").hidden, tab.getAttribute("aria-label"), p.$("[data-account-avatar] .hdr-n").hidden], [true, "Notifications", true]);
  assert.equal(p.$("#nt-all").hidden, true);
  // Mark all read (a later visit with new rows): one POST { all: true }
  p.$("#nt-all").hidden = false;
  await p.tap(p.$("#nt-all"));
  assert.deepEqual(p.callsTo("/api/notices/read").at(-1).body, { all: true });
  // a control changes: saved at once, aria follows
  const el = p.$("#ntp-reply");
  el.checked = false; el.dispatchEvent(newEvent("change")); await p.advance(10); // (advance notes the toast)
  const saves = p.callsTo("/api/notices/prefs").filter((c) => c.method === "POST");
  assert.deepEqual(saves.map((c) => c.body), [{ reply: false }]);
  assert.equal(el.getAttribute("aria-checked"), "false");
  assert.ok(p.toasts.some((t) => /^Off/.test(t)), p.toasts.join(" | "));
  assert.deepEqual(p.errors, [], "no console errors");
});

test("page: Mark all read before the 2 seconds are up cancels the pending mark (one request, not two); a notice's link is a dashboard tab, another in-site path, or Home for anything else", async () => {
  const p = await noticesPage();
  await p.tap(p.$("#tab-notify"));
  await p.advance(500);
  await p.tap(p.$("#nt-all"));
  await p.advance(2500);
  assert.deepEqual(p.callsTo("/api/notices/read").map((c) => c.body), [{ all: true }], "the 2-second mark never fires after Mark all read");
  assert.deepEqual([p.$("#nt-all").hidden, p.$("#tab-notify-n").hidden], [true, true]);
  assert.deepEqual(p.errors, []);
  // the href guard (today only the server writes hrefs, all constants; this is for a bad row one day)
  const at = "2026-10-16T10:00:00Z";
  const q = await noticesPage({ unread: 0, notices: [
    { id: 5, kind: "founder", text: "a", href: "/dashboard#founder", at, read: true },
    { id: 4, kind: "founder", text: "b", href: "/rules", at, read: true },
    { id: 3, kind: "founder", text: "c", href: "//evil.example/x", at, read: true },
    { id: 2, kind: "founder", text: "d", href: "/" + "\\" + "evil.example/x", at, read: true },
    { id: 1, kind: "founder", text: "e", href: "https://evil.example/x", at, read: true },
    { id: 0, kind: "founder", text: "f", href: 7, at, read: true },
  ] });
  await q.tap(q.$("#tab-notify"));
  assert.deepEqual([...q.$$("#nt-list .nt-row__link")].map((x) => x.getAttribute("href")), ["#founder", "/rules", "#home", "#home", "#home", "#home"]);
  assert.deepEqual(q.errors, []);
});

test("page: the empty state; the switch off is today's page (no tab, no request, no header count); a #notify link with the switch off lands on Home", async () => {
  const e = await noticesPage({ notices: [], unread: 0 });
  assert.deepEqual([e.$("#tab-notify").hidden, e.$("#tab-notify-n").hidden, e.$("[data-account-avatar] .hdr-n") === null], [false, true, true], "shown with 0 unread; no badge, no header count");
  await e.tap(e.$("#tab-notify"));
  assert.equal(e.$("#nt-empty").hidden, false);
  assert.equal(e.text("#nt-empty"), "Nothing yet. Replies, moderation outcomes, your coin picture's review, founder windows and elections show here.");
  assert.equal(e.$("#nt-all").hidden, true);
  assert.equal(e.$$("#nt-list .nt-row").length, 0);
  await e.advance(2500);
  assert.equal(e.callsTo("/api/notices/read").length, 0, "nothing to mark");
  assert.deepEqual(e.errors, [], "no console errors");
  // the switch off: /api/me has no unread key
  const errors = [];
  const off = await openDashboard({ me: memberMe({ wallet: ADDR, handle: "jo_utica" }), storage: { vicinity_terms: "2026-10-01" }, globals: { console: { ...console, error: (...a) => errors.push(a.map(String).join(" ")) } } });
  assert.equal(off.$("#tab-notify").hidden, true);
  assert.equal(off.$("#panel-notify").hidden, true);
  assert.equal(off.$("[data-account-avatar] .hdr-n") === null, true, "no header count");
  off.win.VDash.go("notify");
  assert.equal(off.win.VDash.active, "home", "a #notify link with the switch off: Home");
  assert.equal(off.callsTo("/api/notices").length + off.callsTo("/api/notices/prefs").length, 0, "no new request");
  assert.deepEqual(errors, []);
  // the markup is hidden until the switch is on, and dashboard-v2.js names only ids the page has
  const html = read("public/dashboard.html");
  assert.match(html, /<a class="dtab" id="tab-notify" role="tab" href="#notify" data-tab="notify" aria-controls="panel-notify" aria-selected="false" tabindex="-1" aria-label="Notifications" title="Notifications" hidden>/);
  assert.match(html, /<section class="dpanel" id="panel-notify" role="tabpanel" aria-labelledby="tab-notify" tabindex="0" hidden>/);
  assert.match(html, /<button class="btn btn--glass btn--sm" type="button" id="nt-all" hidden>Mark all read<\/button>/);
  const css = read("public/polish-dash.css");
  assert.match(css, /\.dv2 \.dtabs\.is-compact #tab-notify \.dtab__text \{ display: none; \}/, "the compact step shows the bell alone");
  assert.match(css, /\.dv2 \.dtabs\.is-compact #tab-notify \.dtab__ico \{ display: block; \}/);
  assert.match(css, /\.dv2 \.nt-switch \{[^}]*height: 44px/, "a 44 px switch");
  assert.match(css, /\.dv2 \.nt-row__link \{[^}]*min-height: 44px/, "44 px rows");
});

test("copy: the README, docs/DEPLOY.md and src/profiles.js say no messaging and describe the in-app notices behind NOTIFY; the Terms are untouched", () => {
  const readme = read("README.md"), deploy = read("docs/DEPLOY.md"), profiles = read("src/profiles.js");
  for (const [name, text] of [["README", readme], ["DEPLOY", deploy], ["profiles.js", profiles]]) {
    assert.doesNotMatch(text, /no notifications/i, `${name}: the old sentence is gone`);
    assert.match(text, /NOTIFY/, `${name}: names the switch`);
    assert.match(text, /no e-mail, no push/i, `${name}: says what the notices are not`);
  }
  assert.match(readme, /\| `NOTIFY` \|/, "a switch row in the README");
  assert.match(deploy, /\| `NOTIFY` \|/, "a switch row in DEPLOY");
  assert.doesNotMatch(readme + deploy + read("src/elections.js"), /National card/, "the card is headed by the country's name on the Community tab; nothing calls it the National card");
  assert.match(deploy, /section 18 Miscellaneous, the "Notices" paragraph/);
  assert.match(readme, /no messaging of any kind/i);
  // the Terms already carry consent to electronic notices (section 18 Miscellaneous, the "Notices" paragraph): nothing there changes for this step
  const terms = read("scripts/pages/src/terms.html");
  assert.match(terms, /<strong>Notices\.<\/strong> Notices from us under these Terms will be posted on the Website, in the Services, or sent electronically\. You consent to receive all communications electronically\./);
  assert.doesNotMatch(terms, /in-app notice|Notifications tab/i, "no new Terms wording for the tab");
});
