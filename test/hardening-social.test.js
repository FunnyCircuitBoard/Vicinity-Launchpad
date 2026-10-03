// Launch-week hardening, community side: votes (ban check, an atomic hourly limit, posts only), replies (never on a
// check-in), the report counter (the number of report rows, set in one statement), and what the public sees of seats.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { slowDb } from "./helpers/slowdb.js";
import { HOUR, IN_UTICA, advance, attest, browser, newWorld, person, realClock, reprove, useClock } from "./helpers/world.js";

let env;
beforeEach(() => { useClock("2026-10-03T12:00:00Z"); env = newWorld(); });
after(() => realClock());

const reportsOf = async (id) => (await env.DB.prepare("SELECT reports, hidden FROM posts WHERE id = ?").bind(id).first());
const banned = (userId, country = "US") => env.DB.prepare("INSERT INTO bans (user_id, country, by_user, reason, created_at) VALUES (?, ?, 0, 'spam', ?)").bind(userId, country, new Date(Date.now()).toISOString()).run();
const userId = async (p) => (await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(p.w.address).first()).id;

/* ---------------- votes ---------------- */

test("votes go on posts, not on replies (the page never offered it; now the server refuses it too)", async () => {
  const a = await person(env, { home: IN_UTICA }), b = await person(env, { home: IN_UTICA });
  const post = (await a.post("/api/posts", { scope: "city", kind: "talk", body: "Best bakery?" })).post;
  const reply = (await a.post("/api/posts", { parent: post.id, body: "Florentine's" })).post;
  const r = await b.send("/api/posts/vote", { method: "POST", body: { id: reply.id } });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: "no_reply_votes" });
  assert.equal((await b.post("/api/posts/vote", { id: post.id })).voted, true, "the post itself is fine");
  assert.equal((await env.DB.prepare("SELECT score FROM posts WHERE id = ?").bind(reply.id).first("score")), 0);
});

test("a banned person cannot vote (as they cannot post); the ban can be in the post's country or everywhere", async () => {
  const a = await person(env, { home: IN_UTICA }), b = await person(env, { home: IN_UTICA }), c = await person(env, { home: IN_UTICA });
  const id = (await a.post("/api/posts", { scope: "city", kind: "meme", body: "ok" })).post.id;
  await banned(await userId(b));
  const r = await b.send("/api/posts/vote", { method: "POST", body: { id } });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, error: "banned" });
  await banned(await userId(c), "*");
  assert.equal((await c.post("/api/posts/vote", { id })).error, "banned");
  assert.equal((await env.DB.prepare("SELECT score FROM posts WHERE id = ?").bind(id).first("score")), 0, "nothing was counted");
  // an expired ban is no ban
  await env.DB.prepare("UPDATE bans SET expires_at = ? WHERE user_id = ?").bind(new Date(Date.now() - 1000).toISOString(), await userId(b)).run();
  assert.equal((await b.post("/api/posts/vote", { id })).voted, true);
});

test("60 votes an hour per person (taking one back counts too), then 429 slow_down until the hour is over", async () => {
  const a = await person(env, { home: IN_UTICA }), b = await person(env, { home: IN_UTICA });
  const id = (await a.post("/api/posts", { scope: "city", kind: "talk", body: "vote me" })).post.id;
  for (let i = 0; i < 60; i++) assert.equal((await b.post("/api/posts/vote", { id })).ok, true, `vote ${i + 1}`);
  const r = await b.send("/api/posts/vote", { method: "POST", body: { id } });
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { ok: false, error: "slow_down" });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE post_id = ?").bind(id).first("n")), 0, "60 toggles: the refused 61st did not add a vote");
  const other = await person(env, { home: IN_UTICA });
  assert.equal((await other.post("/api/posts/vote", { id })).voted, true, "someone else's counter is their own");
  advance(HOUR);
  assert.equal((await b.post("/api/posts/vote", { id })).voted, true);
  const keys = (await env.DB.prepare("SELECT key FROM auth_limits").all()).results.map((r) => r.key);
  assert.equal(keys.length, 2);
  for (const k of keys) assert.match(k, /^vote:[A-Za-z0-9_-]{22}$/, "an HMAC of the user id, nothing readable");
});

test("the vote limit is counted before the vote and atomically: 70 parallel votes on 70 posts land exactly 60 times", async () => {
  const slow = { ...env, DB: slowDb(env.DB) };
  const a = await person(slow, { home: IN_UTICA }), b = await person(slow, { home: IN_UTICA });
  const aId = await userId(a), at = new Date(Date.now()).toISOString();
  const ids = [];
  for (let i = 0; i < 70; i++) {
    const r = await env.DB.prepare("INSERT INTO posts (user_id, scope, place, country, kind, body, created_at) VALUES (?, 'city', '5142056', 'US', 'talk', ?, ?)").bind(aId, "post " + i, at).run();
    ids.push(r.meta.last_row_id);
  }
  const results = await Promise.all(ids.map((id) => b.post("/api/posts/vote", { id })));
  assert.equal(results.filter((r) => r.ok).length, 60);
  assert.equal(results.filter((r) => r.error === "slow_down").length, 10);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM votes").first("n")), 60);
});

/* ---------------- replies ---------------- */

test("no replies to a check-in (the page never offered it; the server now refuses it with a clear code)", async () => {
  const a = await person(env, { home: IN_UTICA }), b = await person(env, { home: IN_UTICA });
  const checkin = (await a.post("/api/posts", { kind: "checkin", attestation: await attest(a, IN_UTICA, "checkin") })).post;
  const r = await b.send("/api/posts", { method: "POST", body: { parent: checkin.id, body: "welcome!" } });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: "no_checkin_replies" });
  assert.equal((await env.DB.prepare("SELECT replies FROM posts WHERE id = ?").bind(checkin.id).first("replies")), 0);
  const talk = (await a.post("/api/posts", { scope: "city", kind: "talk", body: "hello" })).post;
  assert.equal((await b.post("/api/posts", { parent: talk.id, body: "hi" })).ok, true, "replies to a discussion are as before");
});

/* ---------------- reports ---------------- */

test("the report counter is the number of report rows: two first reports at the same moment both count", async () => {
  const slow = { ...env, DB: slowDb(env.DB) };
  const author = await person(slow, { home: IN_UTICA });
  const id = (await author.post("/api/posts", { scope: "city", kind: "talk", body: "hmm" })).post.id;
  const r1 = await person(slow, { home: IN_UTICA }), r2 = await person(slow, { home: IN_UTICA });
  await Promise.all([r1.post("/api/posts/report", { id, reason: "spam" }), r2.post("/api/posts/report", { id, reason: "spam" })]);
  assert.equal((await reportsOf(id)).reports, 2);
  assert.equal((await r1.post("/api/posts/report", { id, reason: "spam" })).ok, true, "reporting twice is a quiet yes");
  assert.equal((await reportsOf(id)).reports, 2, "and does not count twice");
});

test("a stale counter is corrected by the next report (the rows are the truth), and five rows hide the post as before", async () => {
  const author = await person(env, { home: IN_UTICA });
  const id = (await author.post("/api/posts", { scope: "city", kind: "talk", body: "spam spam" })).post.id;
  const reporters = [];
  for (let i = 0; i < 3; i++) { const p = await person(env, { home: IN_UTICA }); reporters.push(p); await p.post("/api/posts/report", { id, reason: "spam" }); }
  assert.equal((await reportsOf(id)).reports, 3);
  await env.DB.prepare("UPDATE posts SET reports = 0 WHERE id = ?").bind(id).run(); // as an unhide leaves it today
  const fourth = await person(env, { home: IN_UTICA });
  await fourth.post("/api/posts/report", { id, reason: "spam" });
  assert.deepEqual(await reportsOf(id), { reports: 4, hidden: 0 });
  const fifth = await person(env, { home: IN_UTICA });
  await fifth.post("/api/posts/report", { id, reason: "spam" });
  assert.deepEqual(await reportsOf(id), { reports: 5, hidden: 1 });
  const log = await (await fifth.send("/api/audit")).json();
  assert.deepEqual([log.actions[0].by, log.actions[0].action, log.actions[0].state], ["Community reports", "hide", "confirmed"]);
});

test("after a moderator unhides a post with five reports, one more report hides it again: the count never forgets who reported", async () => {
  const author = await person(env, { home: IN_UTICA });
  const id = (await author.post("/api/posts", { scope: "city", kind: "talk", body: "contested" })).post.id;
  for (let i = 0; i < 5; i++) { const p = await person(env, { home: IN_UTICA }); await p.post("/api/posts/report", { id, reason: "spam" }); }
  assert.equal((await reportsOf(id)).hidden, 1);
  const admin = await person(env, { home: IN_UTICA });
  env.ADMIN_WALLETS = admin.w.address;
  await reprove(admin);
  assert.equal((await admin.post("/api/mod/unhide", { id, note: "it is fine" })).hidden, false);
  assert.deepEqual(await reportsOf(id), { reports: 0, hidden: 0 });
  const sixth = await person(env, { home: IN_UTICA });
  await sixth.post("/api/posts/report", { id, reason: "spam" });
  assert.deepEqual(await reportsOf(id), { reports: 6, hidden: 1 });
});

test("three reports still confirm a moderator's pending hide", async () => {
  const author = await person(env, { home: IN_UTICA });
  const id = (await author.post("/api/posts", { scope: "city", kind: "talk", body: "borderline" })).post.id;
  const admin = await person(env, { home: IN_UTICA });
  env.ADMIN_WALLETS = admin.w.address;
  await reprove(admin);
  const h = await admin.post("/api/mod/hide", { id, reason: "spam" });
  assert.equal(h.confirmed, false);
  for (let i = 0; i < 2; i++) { const p = await person(env, { home: IN_UTICA }); await p.post("/api/posts/report", { id, reason: "spam" }); }
  assert.equal((await env.DB.prepare("SELECT hide_confirmed FROM posts WHERE id = ?").bind(id).first("hide_confirmed")), 0);
  const third = await person(env, { home: IN_UTICA });
  await third.post("/api/posts/report", { id, reason: "spam" });
  assert.equal((await env.DB.prepare("SELECT hide_confirmed FROM posts WHERE id = ?").bind(id).first("hide_confirmed")), 1);
  assert.equal((await reportsOf(id)).reports, 3);
});

/* ---------------- what the public sees of a seat ---------------- */

test("/api/seats (the map polls it) shows a founder's wallet masked, never the full address", async () => {
  const f = await person(env, { home: IN_UTICA });
  const id = await userId(f), at = new Date(Date.now()).toISOString();
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES ('5142056', 'Utica', 'US', ?, ?, 5, 180000, 'active', ?, ?)")
    .bind(id, f.w.address, at, at).run();
  const res = await browser(env).send("/api/seats");
  const text = await res.text();
  assert.ok(!text.includes(f.w.address), "the full wallet is not in the answer");
  const d = JSON.parse(text);
  assert.equal(d.seats.length, 1);
  assert.match(d.seats[0].wallet, /^.{5}\*{5}.{3}$/);
  assert.equal(d.seats[0].wallet, `${f.w.address.slice(0, 5)}*****${f.w.address.slice(-3)}`, "the same masking the dashboard and the admin console use");
  assert.equal(d.seats[0].founder, (await f.get("/api/me?lite=1")).user.handle);
  const old = await browser(env).send("/api/claims");
  assert.ok(!(await old.text()).includes(f.w.address), "the old name of the route too");
});
