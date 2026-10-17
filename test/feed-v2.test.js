// Feed v2 behind FEED_V2 (src/flags.js feedV2On): the "update" post kind, deleting your own post, mute (and blocks hiding posts
// both ways), the author's city on every national row, and one confirmation before an account's first national post. With the
// switch off every answer and every page is exactly as before; with it on, every rule here goes through the real API and real SQL
// (test/helpers/world.js). The lazy migration (src/store.js FEED_MIGRATION) is additive and safe to repeat.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOUR, IN_NYC, IN_UTICA, MINT, advance, attest, browser, clock, loginBody, newWorld, person, realClock, useClock } from "./helpers/world.js";
import { expectStatus, pfPerson, schemaOf } from "./helpers/profiles.js";
import { d1 } from "./helpers/d1.js";
import { feedV2On } from "../src/flags.js";
import { FEED_MIGRATION, ensureFeedSchema, ensureProfilesSchema, ensureSchema, feedApplied } from "../src/store.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ON = (extra = {}) => newWorld({ FEED_V2: "on", ...extra });
const iso = (ms) => new Date(ms).toISOString();
const userId = async (env, p) => (await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(p.w.address).first()).id;
/** A live founder seat for `p` (active, or a Seed Steward); returns the seat id. */
const seat = async (env, p, { city = "5142056", name = "Utica", status = "active" } = {}) => {
  const at = iso(clock.now);
  const r = await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, ?, 'US', ?, ?, 5, 1, ?, ?, ?)")
    .bind(city, name, await userId(env, p), p.w.address, status, at, at).run();
  return r.meta.last_row_id;
};
/** The running manager term of the US for `p` (whose seat is `seatId`). */
const manager = async (env, p, seatId) => env.DB.prepare("INSERT INTO manager_terms (country, seat_id, user_id, wallet, starts_at, ends_at, consecutive, status) VALUES ('US', ?, ?, ?, ?, ?, 1, 'active')")
  .bind(seatId, await userId(env, p), p.w.address, iso(clock.now - 86400_000), iso(clock.now + 30 * 86400_000)).run();
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString("base64");
const post = (p, body) => p.send("/api/posts", { method: "POST", body });
const del = (p, id) => p.send("/api/posts/delete", { method: "POST", body: { id } });
const mute = (p, user, on = true) => p.send("/api/mute", { method: "POST", body: { user, on } });
const bodies = (d) => d.posts.map((p) => p.body);

beforeEach(() => useClock("2026-10-16T12:00:00Z"));
after(() => realClock());

/* ---------------- the switch ---------------- */

test("feedV2On: exactly 'on', trimmed, any letter case", () => {
  for (const v of ["on", " on ", "ON", "On", "\ton\n"]) assert.equal(feedV2On({ FEED_V2: v }), true, JSON.stringify(v));
  for (const v of [undefined, "", "off", "true", "1", "yes", "v2", "onn"]) assert.equal(feedV2On(v === undefined ? {} : { FEED_V2: v }), false, JSON.stringify(v));
  assert.equal(feedV2On(undefined), false);
  assert.equal(feedV2On({ FEED_V2: true }), false, "a boolean is not the word on");
  assert.match(read("wrangler.jsonc"), /\n    "FEED_V2": "(on|off)"\n/, "the switch is listed in wrangler.jsonc (off for this step; flipping it is that one word)");
});

test("switch off: the new paths answer exactly what an unknown path answers, kind=update is the memes, no city on national talk, no confirmation, no new key, nothing new in the database", async () => {
  const env = newWorld();
  const a = await person(env, { home: IN_UTICA });
  for (const [path, method] of [["/api/posts/delete", "POST"], ["/api/mute", "POST"], ["/api/mutes", "GET"], ["/api/mutes", "POST"], ["/api/no-such-thing", "GET"]]) {
    const r = await a.send(path, { method, body: method === "POST" ? { id: 1, user: "x", on: true } : undefined });
    assert.equal(r.status, 404, path);
    assert.deepEqual(await r.json(), { error: "not_found" }, path);
  }
  await expectStatus(await post(a, { scope: "city", kind: "update", body: "hi" }), 400, "bad_kind");
  const nat = await a.post("/api/posts", { scope: "country", kind: "talk", body: "to the whole country" });
  assert.equal(nat.ok, true, "no confirmation is asked");
  assert.equal("where" in nat.post, false);
  const list = await a.get("/api/posts?scope=country&kind=talk");
  assert.equal("where" in list.posts[0], false);
  assert.equal("handle" in list.posts[0].author, false, "no new key in the author (PROFILES off)");
  assert.equal((await a.get("/api/posts?scope=city&kind=update")).kind, "meme", "an unknown kind is the memes, as always");
  for (const d of [await a.get("/api/me?lite=1"), await a.get("/api/me"), await browser(env).get("/api/me")]) assert.ok(!("feedV2" in d) && !JSON.stringify(d).includes("feedV2"), "no new key");
  const { tables, columns } = await schemaOf(env.DB);
  assert.ok(!tables.includes("mutes") && !tables.includes("blocks") && !columns.includes("national_ack_at"), "nothing new was made");
  assert.ok(!(await env.DB.prepare("PRAGMA table_info(posts)").all()).results.some((c) => c.name === "deleted_at"));
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(FEED_MIGRATION.id).first("n"), 0);
});

test("switch on: /api/me says feedV2: true in every shape, and the very next answer after flipping it is dark again", async () => {
  const env = ON();
  const a = await person(env, { home: IN_UTICA });
  assert.equal((await browser(env).get("/api/me")).feedV2, true, "signed out");
  assert.equal((await a.get("/api/me?lite=1")).feedV2, true, "lite");
  assert.equal((await a.get("/api/me")).feedV2, true, "full");
  env.FEED_V2 = "off";
  assert.ok(!("feedV2" in (await a.get("/api/me"))));
});

/* ---------------- updates ---------------- */

test("updates: the city's active founder or steward writes them in the Local feed, the country's manager in the National one, an admin in both; everyone else reads and replies", async () => {
  const env = ON();
  const member = await person(env, { home: IN_UTICA }), founder = await person(env, { home: IN_UTICA }), steward = await person(env, { home: IN_NYC });
  const mgr = await person(env, { home: IN_NYC }), admin = await person(env, { home: IN_UTICA });
  await seat(env, founder);
  await seat(env, steward, { city: "5128581", name: "New York City", status: "steward" });
  await manager(env, mgr, await seat(env, mgr, { city: "5140405", name: "Syracuse" })); // the manager's seat is Syracuse, their home is NYC
  env.ADMIN_WALLETS = admin.w.address;
  const update = (p, scope, body = "Heads up") => post(p, { scope, kind: "update", body, ack: true });
  await expectStatus(await update(member, "city"), 403, "not_allowed");
  await expectStatus(await update(member, "country"), 403, "not_allowed");
  const local = await expectStatus(await update(founder, "city", "Meet at the park on Sunday"), 200);
  assert.equal(local.post.kind, "update");
  assert.equal(local.post.author.founder, "Utica");
  await expectStatus(await update(founder, "country"), 403, "not_allowed"); // a founder is not the country's manager
  await expectStatus(await update(steward, "city"), 200); // a Seed Steward has a founder's powers
  await expectStatus(await update(mgr, "country", "Hello United States"), 200);
  await expectStatus(await update(mgr, "city"), 403, "not_allowed"); // no local update in a city that is not their seat
  await expectStatus(await update(admin, "city"), 200);
  await expectStatus(await update(admin, "country"), 200);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE kind = 'update'").first("n"), 5);
  // read and reply like a discussion; sorted new and top like every kind
  const feed = await member.get("/api/posts?scope=city&kind=update");
  assert.equal(feed.kind, "update");
  assert.deepEqual(bodies(feed), ["Heads up", "Meet at the park on Sunday"], "newest first; the steward's NYC update is not Utica's");
  assert.equal((await member.post("/api/posts", { parent: local.post.id, body: "See you there" })).ok, true);
  assert.deepEqual(bodies(await member.get(`/api/posts?parent=${local.post.id}`)), ["See you there"]);
  assert.equal((await member.post("/api/posts/vote", { id: local.post.id })).voted, true);
  assert.deepEqual(bodies(await member.get("/api/posts?scope=city&kind=update&sort=top")), ["Meet at the park on Sunday", "Heads up"]);
  const nat = await member.get("/api/posts?scope=country&kind=update");
  assert.deepEqual(nat.posts.map((p) => [p.body, p.where, p.author.manager]), [["Heads up", "Utica", false], ["Hello United States", "New York City", true]]);
});

test("updates: 500 characters, words only (no picture, nothing stored), and they count towards the 12 posts an hour", async () => {
  const env = ON();
  const f = await person(env, { home: IN_UTICA });
  await seat(env, f);
  const r = await post(f, { scope: "city", kind: "update", body: "x".repeat(501) });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: "too_long", max: 500 });
  assert.equal((await f.post("/api/posts", { scope: "city", kind: "update", body: "y".repeat(500) })).ok, true);
  await expectStatus(await post(f, { scope: "city", kind: "update", body: "with a picture", image: PNG }), 400, "no_image");
  await expectStatus(await post(f, { scope: "city", kind: "update", body: "" }), 400, "empty");
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM media").first("n"), 0, "no picture was stored");
  for (let i = 1; i < 12; i++) assert.equal((await f.post("/api/posts", { scope: "city", kind: "update", body: `update ${i}` })).ok, true, `update ${i}`);
  await expectStatus(await post(f, { scope: "city", kind: "talk", body: "one more" }), 429, "slow_down");
  advance(HOUR + 1000); // the hour is over (a post made exactly an hour ago still counts: created_at >= now - 1 h)
  assert.equal((await f.post("/api/posts", { scope: "city", kind: "talk", body: "one more" })).ok, true);
});

/* ---------------- delete your own post ---------------- */

test("delete your own post: the author only; it and its replies leave every feed, list and count; votes, reports and replies find nothing; the picture answers 404; the moderators' queue alone keeps a reported one, marked deleted", async () => {
  const env = ON({ PROFILES: "on" });
  const a = await pfPerson(env, "AuthorAnn", { home: IN_UTICA }), b = await pfPerson(env, "BobBrave", { home: IN_UTICA }), admin = await pfPerson(env, "AdminAl", { home: IN_UTICA });
  const far = await pfPerson(env, "FarFred", { home: IN_NYC });
  env.ADMIN_WALLETS = admin.w.address;
  const meme = (await a.post("/api/posts", { scope: "city", kind: "meme", body: "Utica skyline", image: PNG })).post;
  const talk = (await a.post("/api/posts", { scope: "city", kind: "talk", body: "Best pizza?" })).post;
  const kept = (await b.post("/api/posts", { scope: "city", kind: "talk", body: "Bob's own" })).post;
  const reply = (await b.post("/api/posts", { parent: talk.id, body: "O'Scugnizzo" })).post;
  assert.equal((await b.post("/api/posts/vote", { id: meme.id })).voted, true);
  assert.equal((await b.post("/api/posts/report", { id: talk.id, reason: "spam" })).ok, true);
  assert.equal((await b.get("/api/posts?scope=city&kind=meme&sort=top")).posts[0].score, 1);
  assert.equal((await admin.get("/api/mod")).posts.length, 1, "the reported discussion is in the queue");
  assert.equal((await admin.get("/api/admin/reports")).reports.length, 1, "and in the admin console");
  assert.equal((await admin.get("/api/admin/overview")).pendingReports, 1);
  assert.equal((await b.get("/api/profile?u=AuthorAnn")).profile.posts.length, 2);
  // not the author: 403 and nothing changes (an admin's path stays the public, logged hide); a post you could not see in a feed: 404 like everywhere
  await expectStatus(await del(b, meme.id), 403, "not_allowed");
  await expectStatus(await del(admin, meme.id), 403, "not_allowed");
  await expectStatus(await del(far, meme.id), 404, "not_found"); // a NYC member and a Utica post: no door says whether it exists
  await expectStatus(await del(a, 999), 404, "not_found");
  await expectStatus(await a.send("/api/posts/delete", { method: "POST", body: {} }), 404, "not_found");
  await expectStatus(await browser(env).send("/api/posts/delete", { method: "POST", body: { id: meme.id } }), 401, "sign_in");
  await expectStatus(await a.send("/api/posts/delete", { method: "POST", body: { id: meme.id }, origin: "https://evil.example" }), 403, "wrong_origin");
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE deleted_at IS NOT NULL").first("n"), 0);
  assert.equal((await b.send(meme.image)).status, 200);
  // the author deletes both, once
  assert.deepEqual(await a.post("/api/posts/delete", { id: meme.id }), { ok: true, deleted: true });
  assert.deepEqual(await a.post("/api/posts/delete", { id: talk.id }), { ok: true, deleted: true });
  await expectStatus(await del(a, meme.id), 404, "not_found");
  for (const who of [a, b, admin]) {
    assert.equal((await who.get("/api/posts?scope=city&kind=meme")).posts.length, 0, "new");
    assert.equal((await who.get("/api/posts?scope=city&kind=meme&sort=top")).posts.length, 0, "top: its votes rank nothing any more");
    assert.deepEqual(bodies(await who.get("/api/posts?scope=city&kind=talk")), ["Bob's own"]);
    assert.equal((await who.send(`/api/posts?parent=${talk.id}`)).status, 404, "its replies went with it");
    assert.equal((await who.send(meme.image)).status, 404, "the picture is gone for everyone, the author included");
  }
  await expectStatus(await b.send("/api/posts/vote", { method: "POST", body: { id: meme.id } }), 404, "not_found");
  await expectStatus(await b.send("/api/posts/report", { method: "POST", body: { id: talk.id, reason: "spam" } }), 404, "not_found");
  await expectStatus(await post(b, { parent: talk.id, body: "too late" }), 404, "not_found");
  assert.deepEqual((await b.get("/api/profile?u=AuthorAnn")).profile.posts, [], "the profile no longer lists them");
  assert.equal((await browser(env).get("/api/audit?country=US")).actions.length, 0, "your own deletion is not moderation");
  // the moderators' queue keeps the reported one as evidence, marked; nobody can hide it (nothing to log about a post nobody sees), but a
  // ban can still be proposed from it (it names the person); the admin console's Reports table and count let it go
  const queue = (await admin.get("/api/mod")).posts;
  assert.deepEqual(queue.map((p) => [p.id, p.deleted, p.reports]), [[talk.id, true, 1]], "still in the queue, marked deleted");
  assert.deepEqual(bodies(await admin.get("/api/posts?scope=city&kind=talk")), ["Bob's own"], "but in no feed, even for a moderator");
  await expectStatus(await admin.send("/api/mod/hide", { method: "POST", body: { id: talk.id, reason: "spam" } }), 404, "not_found");
  const ban = await admin.post("/api/mod/ban", { postId: talk.id, reason: "spam" });
  assert.equal(ban.proposed, true);
  assert.deepEqual(await env.DB.prepare("SELECT target_type, target_id, target_user FROM mod_actions WHERE id = ?").bind(ban.actionId).first(), { target_type: "user", target_id: await userId(env, a), target_user: await userId(env, a) });
  assert.equal((await admin.get("/api/admin/reports")).reports.length, 0, "the admin console no longer lists it");
  assert.equal((await admin.get("/api/admin/overview")).pendingReports, 0);
  await expectStatus(await admin.send("/api/admin/reports/decide", { method: "POST", body: { id: talk.id, action: "hide" } }), 404, "not_found");
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit").first("n"), 0, "nothing was logged about it");
  // the rows and the picture stay (hidden) until a later step purges them; the reply carries the same mark; the 12-an-hour count still sees the posts
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE deleted_at IS NOT NULL").first("n"), 3);
  assert.equal(await env.DB.prepare("SELECT deleted_at FROM posts WHERE id = ?").bind(reply.id).first("deleted_at"), iso(clock.now), "the reply went with its parent");
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM media").first("n"), 1);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE post_id = ?").bind(meme.id).first("n"), 1, "the vote row is left alone");
  // 60 tries an hour, failures included: no reading the posts table number by number through this door
  const liz = await pfPerson(env, "LimitLiz", { home: IN_UTICA });
  for (let i = 0; i < 60; i++) await expectStatus(await del(liz, 100_000 + i), 404, "not_found");
  await expectStatus(await del(liz, 100_060), 429, "slow_down");
  await expectStatus(await del(liz, kept.id), 429, "slow_down");
  advance(HOUR + 1000);
  await expectStatus(await del(liz, kept.id), 403, "not_allowed");
});

test("a deletion sticks: posts deleted while the switch was on stay gone when it is turned off (the column exists, so it is honoured); nothing else of v2 shows", async () => {
  const env = ON({ PROFILES: "on" });
  const a = await pfPerson(env, "AuthorAnn", { home: IN_UTICA }), b = await pfPerson(env, "BobBrave", { home: IN_UTICA }), admin = await pfPerson(env, "AdminAl", { home: IN_UTICA });
  env.ADMIN_WALLETS = admin.w.address;
  const meme = (await a.post("/api/posts", { scope: "city", kind: "meme", body: "to delete", image: PNG })).post;
  const kept = (await a.post("/api/posts", { scope: "city", kind: "meme", body: "to keep" })).post;
  const talk = (await a.post("/api/posts", { scope: "city", kind: "talk", body: "thread" })).post;
  assert.equal((await b.post("/api/posts", { parent: talk.id, body: "reply" })).ok, true);
  assert.equal((await b.post("/api/posts/report", { id: meme.id, reason: "spam" })).ok, true);
  assert.deepEqual(await a.post("/api/posts/delete", { id: meme.id }), { ok: true, deleted: true });
  assert.deepEqual(await a.post("/api/posts/delete", { id: talk.id }), { ok: true, deleted: true });
  assert.deepEqual(await a.post("/api/mute", { user: "BobBrave", on: true }), { ok: true, muted: true });
  env.FEED_V2 = "off";
  for (const who of [a, b, admin]) {
    assert.deepEqual(bodies(await who.get("/api/posts?scope=city&kind=meme")), ["to keep"], "the deleted meme stays gone");
    assert.deepEqual(bodies(await who.get("/api/posts?scope=city&kind=meme&sort=top")), ["to keep"]);
    assert.equal((await who.get("/api/posts?scope=city&kind=talk")).posts.length, 0);
    assert.equal((await who.send(`/api/posts?parent=${talk.id}`)).status, 404);
    assert.equal((await who.send(meme.image)).status, 404, "its picture too");
  }
  await expectStatus(await b.send("/api/posts/vote", { method: "POST", body: { id: meme.id } }), 404, "not_found");
  await expectStatus(await admin.send("/api/mod/hide", { method: "POST", body: { id: meme.id, reason: "spam" } }), 404, "not_found");
  assert.deepEqual((await b.get("/api/profile?u=AuthorAnn")).profile.posts.map((p) => p.body), ["to keep"]);
  assert.equal((await admin.get("/api/admin/reports")).reports.length, 0);
  assert.deepEqual((await admin.get("/api/mod")).posts.map((p) => [p.id, p.deleted]), [[meme.id, true]], "the moderators' evidence stays, marked");
  // and everything else is the feed as it was: the mute no longer hides Bob, no new route, no new key
  assert.equal((await a.get("/api/posts?scope=city&kind=meme")).posts.length, 1);
  assert.equal((await b.post("/api/posts", { scope: "city", kind: "talk", body: "Bob" })).ok, true);
  assert.deepEqual(bodies(await a.get("/api/posts?scope=city&kind=talk")), ["Bob"], "a mute is not applied with the switch off");
  await expectStatus(await del(a, kept.id), 404, "not_found");
  assert.ok(!("feedV2" in (await a.get("/api/me"))));
  assert.ok(!("where" in (await a.get("/api/posts?scope=city&kind=meme")).posts[0]));
});

test("delete your own reply: the count a reader sees goes down and the thread shows the rest; the parent stays", async () => {
  const env = ON();
  const a = await person(env, { home: IN_UTICA }), b = await person(env, { home: IN_UTICA });
  const talk = (await a.post("/api/posts", { scope: "city", kind: "talk", body: "Thread" })).post;
  const r1 = (await b.post("/api/posts", { parent: talk.id, body: "one" })).post;
  assert.equal((await b.post("/api/posts", { parent: talk.id, body: "two" })).ok, true);
  assert.equal((await a.get("/api/posts?scope=city&kind=talk")).posts[0].replies, 2);
  await expectStatus(await del(a, r1.id), 403, "not_allowed");
  assert.deepEqual(await b.post("/api/posts/delete", { id: r1.id }), { ok: true, deleted: true });
  assert.equal((await a.get("/api/posts?scope=city&kind=talk")).posts[0].replies, 1);
  assert.deepEqual(bodies(await a.get(`/api/posts?parent=${talk.id}`)), ["two"]);
  assert.equal(await env.DB.prepare("SELECT replies FROM posts WHERE id = ?").bind(talk.id).first("replies"), 1, "the stored counter follows");
  assert.equal(await env.DB.prepare("SELECT deleted_at FROM posts WHERE id = ?").bind(talk.id).first("deleted_at"), null);
});

/* ---------------- mute ---------------- */

test("mute: by username, your own view only; not yourself, one row per pair, at most 1,000, admins too, the list is yours alone, letting go tells nothing", async () => {
  const env = ON();
  const a = await pfPerson(env, "Alice77", { home: IN_UTICA }), b = await pfPerson(env, "BobBrave", { home: IN_UTICA }), admin = await pfPerson(env, "AdminAl", { home: IN_UTICA });
  env.ADMIN_WALLETS = admin.w.address;
  for (const body of [{}, { user: "BobBrave" }, { user: "BobBrave", on: "yes" }, { on: true }, { user: 7, on: true }]) await expectStatus(await a.send("/api/mute", { method: "POST", body }), 400, "bad_request");
  await expectStatus(await browser(env).send("/api/mute", { method: "POST", body: { user: "BobBrave", on: true } }), 401, "sign_in");
  await expectStatus(await a.send("/api/mute", { method: "POST", body: { user: "BobBrave", on: true }, origin: "https://evil.example" }), 403, "wrong_origin");
  await expectStatus(await mute(a, "Alice77"), 400, "self");
  await expectStatus(await mute(a, "Nobody"), 404, "not_found");
  assert.deepEqual(await (await mute(a, "bobbrave")).json(), { ok: true, muted: true }, "case does not matter");
  assert.deepEqual(await (await mute(a, "BobBrave")).json(), { ok: true, muted: true }, "twice is a quiet yes");
  assert.deepEqual(await (await mute(a, "AdminAl")).json(), { ok: true, muted: true }, "an admin can be muted: it only changes your own view");
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM mutes").first("n"), 2, "one row per pair");
  assert.deepEqual(await a.get("/api/mutes"), { ok: true, users: [{ handle: "AdminAl" }, { handle: "BobBrave" }] }, "newest first");
  assert.deepEqual(await b.get("/api/mutes"), { ok: true, users: [] }, "nobody sees anybody else's list");
  assert.deepEqual(await (await mute(a, "BobBrave", false)).json(), { ok: true, muted: false });
  assert.deepEqual(await (await mute(a, "Nobody", false)).json(), { ok: true, muted: false }, "letting go answers the same for a name nobody has");
  assert.deepEqual(await a.get("/api/mutes"), { ok: true, users: [{ handle: "AdminAl" }] });
  // the cap, counted inside the one INSERT: with 1,000 rows nothing more is added
  const aId = await userId(env, a);
  await env.DB.batch(Array.from({ length: 999 }, (_, i) => env.DB.prepare("INSERT INTO mutes (muter_id, muted_id, created_at) VALUES (?, ?, ?)").bind(aId, 100_000 + i, iso(clock.now))));
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM mutes WHERE muter_id = ?").bind(aId).first("n"), 1000);
  await expectStatus(await mute(a, "BobBrave"), 409, "too_many_mutes");
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM mutes WHERE muter_id = ?").bind(aId).first("n"), 1000, "nothing was added");
  assert.deepEqual(await (await mute(a, "AdminAl")).json(), { ok: true, muted: true }, "one already muted is still a quiet yes");
  assert.equal((await a.get("/api/mutes")).users.length, 1, "the list shows members with a username only");
});

test("the feed hides what you muted, whom you blocked and who blocked you (replies, threads and counts too); everyone else's view is their own", async () => {
  const env = ON({ PROFILES: "on" });
  const a = await pfPerson(env, "Alice77", { home: IN_UTICA }), m = await pfPerson(env, "MutedMax", { home: IN_UTICA }), bl = await pfPerson(env, "BlockedBen", { home: IN_UTICA });
  const br = await pfPerson(env, "BlockerBea", { home: IN_UTICA }), c = await pfPerson(env, "CarolCalm", { home: IN_UTICA });
  const talk = async (p, body) => (await p.post("/api/posts", { scope: "city", kind: "talk", body })).post;
  const pa = await talk(a, "Alice asks");
  for (const [p, body] of [[m, "Max says"], [bl, "Ben says"], [br, "Bea says"], [c, "Carol says"]]) await talk(p, body);
  for (const p of [m, bl, br, c]) assert.equal((await p.post("/api/posts", { parent: pa.id, body: `reply by ${p.handle}` })).ok, true);
  assert.equal((await a.get("/api/posts?scope=city&kind=talk")).posts.length, 5, "before: everything");
  assert.deepEqual(await a.post("/api/mute", { user: "MutedMax", on: true }), { ok: true, muted: true });
  assert.deepEqual(await a.post("/api/block", { handle: "BlockedBen", block: true }), { ok: true, blocked: true });
  assert.deepEqual(await br.post("/api/block", { handle: "Alice77", block: true }), { ok: true, blocked: true });
  // Alice: no Max (muted), no Ben (she blocked him), no Bea (she blocked Alice); the count is what Alice sees
  const mine = await a.get("/api/posts?scope=city&kind=talk");
  assert.deepEqual(bodies(mine), ["Carol says", "Alice asks"]);
  assert.equal(mine.posts.find((p) => p.body === "Alice asks").replies, 1);
  assert.deepEqual(bodies(await a.get(`/api/posts?parent=${pa.id}`)), ["reply by CarolCalm"]);
  assert.deepEqual(bodies(await a.get("/api/posts?scope=city&kind=talk&sort=top")).sort(), ["Alice asks", "Carol says"]);
  // Max still sees everything (a mute is one way, and he is never told); Ben and Bea no longer see Alice (a block is both ways); Carol sees all
  assert.equal((await m.get("/api/posts?scope=city&kind=talk")).posts.length, 5);
  assert.equal((await m.get(`/api/posts?parent=${pa.id}`)).posts.length, 4);
  for (const p of [bl, br]) {
    assert.deepEqual(bodies(await p.get("/api/posts?scope=city&kind=talk")), ["Carol says", "Bea says", "Ben says", "Max says"], p.handle);
    assert.equal((await p.send(`/api/posts?parent=${pa.id}`)).status, 404, `${p.handle} cannot open Alice's thread by its number`);
    await expectStatus(await post(p, { parent: pa.id, body: "sneaky" }), 404, "not_found");
  }
  const carol = await c.get("/api/posts?scope=city&kind=talk");
  assert.equal(carol.posts.length, 5);
  assert.equal(carol.posts.find((p) => p.body === "Alice asks").replies, 4);
  // what the feed hides cannot be voted on or reported by its number, and the profile page lists the same posts the feed would
  for (const p of [bl, br]) {
    await expectStatus(await p.send("/api/posts/vote", { method: "POST", body: { id: pa.id } }), 404, "not_found");
    await expectStatus(await p.send("/api/posts/report", { method: "POST", body: { id: pa.id, reason: "spam" } }), 404, "not_found");
    assert.deepEqual((await p.get("/api/profile?u=Alice77")).profile.posts, [], `${p.handle} sees none of Alice's posts on her profile`);
  }
  assert.deepEqual((await a.get("/api/profile?u=MutedMax")).profile.posts, [], "nor Alice Max's (muted)");
  assert.deepEqual((await a.get("/api/profile?u=BlockedBen")).profile.posts, [], "nor Ben's (blocked)");
  assert.deepEqual((await a.get("/api/profile?u=BlockerBea")).profile.posts, [], "nor Bea's (she blocked Alice)");
  assert.equal((await a.get("/api/profile?u=CarolCalm")).profile.posts.length, 1);
  assert.equal((await m.get("/api/profile?u=Alice77")).profile.posts.length, 1, "Max still sees Alice's (a mute is one way)");
  // unmute and unblock: back
  assert.deepEqual(await a.post("/api/mute", { user: "MutedMax", on: false }), { ok: true, muted: false });
  assert.deepEqual(await a.post("/api/block", { handle: "BlockedBen", block: false }), { ok: true, blocked: false });
  assert.deepEqual(bodies(await a.get("/api/posts?scope=city&kind=talk")), ["Carol says", "Ben says", "Max says", "Alice asks"]);
  assert.equal((await bl.get("/api/posts?scope=city&kind=talk")).posts.length, 5);
});

test("nobody hides from a moderator by blocking them: the founder still sees (and can open) a post by someone who blocked them, while a plain member does not; the moderator's own block and mute are their own choice", async () => {
  const env = ON({ PROFILES: "on", VICINITY_MINT: MINT }); // launched, so the founder's seat is checked live (they hold their 1): everyone here holds
  const founder = await pfPerson(env, "FounderFay", { home: IN_UTICA, holds: 1 }), spammer = await pfPerson(env, "SpamSam", { home: IN_UTICA, holds: 1 });
  const plain = await pfPerson(env, "PlainPat", { home: IN_UTICA, holds: 1 }), mgr = await pfPerson(env, "ManagerMo", { home: IN_NYC, holds: 1 });
  await seat(env, founder);
  await manager(env, mgr, await seat(env, mgr, { city: "5128581", name: "New York City" }));
  const ask = (await founder.post("/api/posts", { scope: "city", kind: "talk", body: "Founder asks" })).post;
  const spam = (await spammer.post("/api/posts", { scope: "city", kind: "talk", body: "Spam" })).post;
  assert.equal((await spammer.post("/api/posts", { parent: ask.id, body: "spam reply" })).ok, true);
  const nat = (await spammer.post("/api/posts", { scope: "country", kind: "talk", body: "National spam", ack: true })).post;
  assert.deepEqual(await spammer.post("/api/block", { handle: "FounderFay", block: true }), { ok: true, blocked: true });
  assert.deepEqual(await spammer.post("/api/block", { handle: "PlainPat", block: true }), { ok: true, blocked: true });
  assert.deepEqual(await spammer.post("/api/block", { handle: "ManagerMo", block: true }), { ok: true, blocked: true });
  // the founder, in their city: everything, as before the block
  const f = await founder.get("/api/posts?scope=city&kind=talk");
  assert.equal(f.canModerate, true);
  assert.deepEqual(bodies(f), ["Spam", "Founder asks"]);
  assert.equal(f.posts.find((p) => p.id === ask.id).replies, 1, "the spam reply counts for the founder");
  assert.deepEqual(bodies(await founder.get(`/api/posts?parent=${ask.id}`)), ["spam reply"]);
  assert.deepEqual(bodies(await founder.get(`/api/posts?parent=${spam.id}`)), [], "the thread opens");
  assert.equal((await founder.post("/api/posts/report", { id: spam.id, reason: "spam" })).ok, true, "and can be reported");
  assert.equal((await founder.post("/api/mod/hide", { id: spam.id, reason: "spam" })).ok, true, "and hidden");
  // but not outside their city: the national feed is not theirs to moderate, so the block hides there
  assert.deepEqual(bodies(await founder.get("/api/posts?scope=country&kind=talk")), []);
  assert.equal((await founder.send(`/api/posts?parent=${nat.id}`)).status, 404);
  // the manager sees the national one (their country), the plain member sees neither
  assert.deepEqual(bodies(await mgr.get("/api/posts?scope=country&kind=talk")), ["National spam"]);
  assert.deepEqual(bodies(await plain.get("/api/posts?scope=city&kind=talk")), ["Founder asks"]);
  assert.equal((await plain.get("/api/posts?scope=city&kind=talk")).posts[0].replies, 0);
  assert.equal((await plain.send(`/api/posts?parent=${spam.id}`)).status, 404);
  await expectStatus(await plain.send("/api/posts/vote", { method: "POST", body: { id: spam.id } }), 404, "not_found");
  await expectStatus(await plain.send("/api/posts/report", { method: "POST", body: { id: spam.id, reason: "spam" } }), 404, "not_found");
  // the founder's own choice still counts: a mute (or a block) of theirs hides the spammer from them
  assert.deepEqual(await founder.post("/api/mute", { user: "SpamSam", on: true }), { ok: true, muted: true });
  assert.deepEqual(bodies(await founder.get("/api/posts?scope=city&kind=talk")), ["Founder asks"]);
  assert.equal((await founder.get("/api/posts?scope=city&kind=talk")).posts[0].replies, 0);
  assert.equal((await founder.get("/api/mod")).posts.length, 1, "the queue is not a feed: the reported post is still there for them");
});

test("with PROFILES off the feed still has a blocks table of the same shape (the feed migration makes it), so a later switch-on of profiles finds it", async () => {
  const env = ON();
  const a = await person(env, { home: IN_UTICA }), b = await person(env, { home: IN_UTICA });
  const pb = (await b.post("/api/posts", { scope: "city", kind: "talk", body: "Bob" })).post;
  assert.equal((await a.get("/api/posts?scope=city&kind=talk")).posts.length, 1);
  assert.deepEqual((await env.DB.prepare("PRAGMA table_info(blocks)").all()).results.map((c) => c.name), ["blocker_id", "blocked_id", "created_at"]);
  await env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)").bind(await userId(env, b), await userId(env, a), iso(clock.now)).run();
  assert.equal((await a.get("/api/posts?scope=city&kind=talk")).posts.length, 0, "a block hides the post from the blocked reader");
  assert.equal((await a.send(`/api/posts?parent=${pb.id}`)).status, 404);
  await ensureProfilesSchema(env.DB); // profiles switched on later: the same table, the row kept
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM blocks").first("n"), 1);
});

/* ---------------- the author's city on national rows ---------------- */

test("every national row says the author's city (where), replies included; local rows only on check-ins, as before", async () => {
  const env = ON();
  const u = await person(env, { home: IN_UTICA }), n = await person(env, { home: IN_NYC });
  const make = async (p, scope, kind, body) => (await p.post("/api/posts", { scope, kind, body, ack: true })).post;
  const nm = await make(u, "country", "meme", "US meme"), nt = await make(n, "country", "talk", "US talk");
  assert.equal(nm.where, "Utica");
  assert.equal(nt.where, "New York City");
  const reply = (await u.post("/api/posts", { parent: nt.id, body: "from Utica", ack: true })).post;
  assert.equal(reply.where, "Utica", "a reply in the national feed too");
  assert.deepEqual((await n.get("/api/posts?scope=country&kind=talk")).posts.map((p) => p.where), ["New York City"]);
  assert.deepEqual((await n.get("/api/posts?scope=country&kind=meme")).posts.map((p) => p.where), ["Utica"]);
  assert.deepEqual((await n.get(`/api/posts?parent=${nt.id}`)).posts.map((p) => p.where), ["Utica"]);
  const lt = await make(u, "city", "talk", "Utica talk"), lm = await make(u, "city", "meme", "Utica meme");
  assert.equal("where" in lt, false);
  assert.equal("where" in lm, false);
  assert.equal("where" in (await u.post("/api/posts", { parent: lt.id, body: "local reply" })).post, false);
  assert.ok((await u.get("/api/posts?scope=city&kind=talk")).posts.every((p) => !("where" in p)), "local rows unchanged");
  const ci = (await u.post("/api/posts", { kind: "checkin", attestation: await attest(u, IN_UTICA, "checkin") })).post;
  assert.equal(ci.where, "Utica", "check-ins as always");
  assert.equal((await n.get("/api/posts?scope=country&kind=checkin")).posts[0].where, "Utica");
});

/* ---------------- the first national post ---------------- */

test("the first national post asks once: 409 needs_ack with the country, then ack: true posts and records it on the account; never again, never for local posts", async () => {
  const env = ON();
  const u = await person(env, { home: IN_UTICA }), o = await person(env, { home: IN_NYC });
  assert.equal((await u.post("/api/posts", { scope: "city", kind: "talk", body: "local: no question asked" })).ok, true);
  assert.equal((await u.post("/api/posts", { kind: "checkin", attestation: await attest(u, IN_UTICA, "checkin") })).ok, true);
  const r = await post(u, { scope: "country", kind: "talk", body: "national" });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { ok: false, error: "needs_ack", country: "US" });
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE scope = 'country'").first("n"), 0, "nothing was posted");
  assert.equal(await env.DB.prepare("SELECT national_ack_at FROM users WHERE wallet = ?").bind(u.w.address).first("national_ack_at"), null);
  await expectStatus(await post(u, { scope: "country", kind: "talk", body: "national", ack: "yes" }), 409, "needs_ack"); // only true is a yes
  await expectStatus(await post(u, { scope: "country", kind: "talk", body: "x".repeat(1001), ack: true }), 400, "too_long"); // a refused post records nothing
  assert.equal(await env.DB.prepare("SELECT national_ack_at FROM users WHERE wallet = ?").bind(u.w.address).first("national_ack_at"), null);
  const ok = await u.post("/api/posts", { scope: "country", kind: "talk", body: "national", ack: true });
  assert.equal(ok.ok, true);
  assert.equal(await env.DB.prepare("SELECT national_ack_at FROM users WHERE wallet = ?").bind(u.w.address).first("national_ack_at"), iso(clock.now));
  advance(HOUR);
  assert.equal((await u.post("/api/posts", { scope: "country", kind: "meme", body: "again: no question" })).ok, true);
  assert.equal(await env.DB.prepare("SELECT national_ack_at FROM users WHERE wallet = ?").bind(u.w.address).first("national_ack_at"), iso(clock.now - HOUR), "recorded once");
  // a reply in the national feed is a national post too: the other account is asked once, then not
  await expectStatus(await post(o, { parent: ok.post.id, body: "hi" }), 409, "needs_ack");
  assert.equal((await o.post("/api/posts", { parent: ok.post.id, body: "hi", ack: true })).ok, true);
  assert.equal((await o.post("/api/posts", { parent: ok.post.id, body: "again" })).ok, true);
  // it is the account's, not the browser's: another sign-in of the same person is not asked
  const again = browser(env);
  assert.equal((await again.post("/api/auth/wallet", await loginBody(u.w))).ok, true);
  assert.equal((await again.post("/api/posts", { scope: "country", kind: "talk", body: "from another browser" })).ok, true);
});

/* ---------------- the lazy migration ---------------- */

test("the lazy migration: once, safe to repeat, on a database with or without the columns and the blocks table; nothing dropped or rewritten", async () => {
  const cols = async (db, t) => (await db.prepare(`PRAGMA table_info(${t})`).all()).results.map((c) => c.name);
  const recorded = (db) => db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?").bind(FEED_MIGRATION.id).first("n");
  // a fresh database, with rows: migrated once, every row and value kept, a second call is a no-op
  const fresh = d1();
  await ensureSchema(fresh);
  await fresh.prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES ('W1', 'google', 'g1', 'Ann', '2026-10-01T00:00:00Z')").run();
  await fresh.prepare("INSERT INTO posts (user_id, scope, place, country, kind, body, created_at) VALUES (1, 'city', '5142056', 'US', 'talk', 'kept', '2026-10-01T00:00:00Z')").run();
  await ensureFeedSchema(fresh);
  await ensureFeedSchema(fresh);
  assert.ok((await cols(fresh, "posts")).includes("deleted_at") && (await cols(fresh, "users")).includes("national_ack_at"));
  assert.deepEqual(await cols(fresh, "mutes"), ["muter_id", "muted_id", "created_at"]);
  assert.deepEqual(await cols(fresh, "blocks"), ["blocker_id", "blocked_id", "created_at"]);
  assert.deepEqual(await fresh.prepare("SELECT id, body, deleted_at FROM posts").first(), { id: 1, body: "kept", deleted_at: null });
  assert.deepEqual(await fresh.prepare("SELECT handle, national_ack_at FROM users").first(), { handle: "Ann", national_ack_at: null });
  assert.equal(await recorded(fresh), 1);
  // after the profile migration (blocks exists, with a row): the same table, untouched; and the profile migration after the feed one
  const withProfiles = d1();
  await ensureProfilesSchema(withProfiles);
  await withProfiles.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (1, 2, 'x')").run();
  await ensureFeedSchema(withProfiles);
  assert.equal(await withProfiles.prepare("SELECT COUNT(*) AS n FROM blocks").first("n"), 1);
  assert.equal(await recorded(withProfiles), 1);
  const feedFirst = d1();
  await ensureSchema(feedFirst);
  await ensureFeedSchema(feedFirst);
  await ensureProfilesSchema(feedFirst);
  assert.ok((await cols(feedFirst, "users")).includes("bio") && (await cols(feedFirst, "users")).includes("national_ack_at"));
  // the columns are there but the record is not (a crash right after the statements, or another server did part of it): no failure, recorded now
  const half = d1();
  await ensureSchema(half);
  await half.prepare("ALTER TABLE posts ADD COLUMN deleted_at TEXT").run();
  await half.prepare("CREATE TABLE mutes (muter_id INTEGER NOT NULL, muted_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (muter_id, muted_id))").run();
  await ensureFeedSchema(half);
  assert.ok((await cols(half, "users")).includes("national_ack_at"));
  assert.equal(await recorded(half), 1);
  // recorded already: not a single statement runs again (a database that lost a column by hand is a human's job, never guessed at)
  const done = d1();
  await ensureSchema(done);
  await done.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, 'x')").bind(FEED_MIGRATION.id).run();
  await ensureFeedSchema(done);
  assert.ok(!(await cols(done, "posts")).includes("deleted_at"));
  for (const s of FEED_MIGRATION.sql.split(";")) assert.doesNotMatch(s, /\b(DROP|DELETE|UPDATE|REPLACE|INSERT)\b/i, "additive only");
  // feedApplied (the readers' question: is the column there to honour?) only ever reads: no column, no table, no record from asking
  const asked = d1();
  await ensureSchema(asked);
  assert.equal(await feedApplied(asked), false);
  assert.equal(await feedApplied(asked), false);
  assert.ok(!(await cols(asked, "posts")).includes("deleted_at"));
  assert.ok(!(await asked.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mutes'").first()));
  assert.equal(await recorded(asked), 0);
  await ensureFeedSchema(asked);
  assert.equal(await feedApplied(asked), true);
  assert.equal(await feedApplied(fresh), true, "a database migrated earlier");
});

/* ---------------- the pages ---------------- */

test("the pages: the Updates chip and the hint start hidden (the flag-off page is unchanged), the per-row menu and the two confirmations are in the script, the rules sentence waits for /api/me, the profile has a hidden mutes list", () => {
  const dash = read("public/dashboard.html"), js = read("public/dashboard.js"), rules = read("public/rules.html"), site = read("public/site.js");
  const prof = read("public/profile.html"), pjs = read("public/profile.js"), css = read("public/style.css");
  assert.match(dash, /<button type="button" role="tab" data-kind="update" aria-selected="false" data-feed-v2 hidden>Updates<\/button>/);
  assert.match(dash, /<p class="tiny muted" id="c-hint" hidden><\/p>/);
  assert.ok(read("scripts/pages/src/dashboard.html").includes('data-kind="update" aria-selected="false" data-feed-v2 hidden'), "the source the page is built from");
  assert.ok(js.includes('const UPDATE_HINT = "Updates come from the city founder, the country manager or Vicinity."'));
  assert.ok(js.includes('confirm("Delete this post? It disappears for everyone.")'));
  assert.ok(js.includes("will see this. Post it?"));
  assert.match(js, /\$\$\("\.chips \[data-feed-v2\]"\)\.forEach\(\(b\) => \(b\.hidden = !feedV2\(\)\)\)/, "the chip shows only when /api/me says feedV2");
  assert.match(js, /\$\("#feed \.chips"\)\.classList\.toggle\("chips--4", feedV2\(\)\)/, "four equal kinds in the tabbed layout's grid");
  assert.match(read("public/polish-dash.css"), /\.dv2 \.feed \.chips\.chips--4 \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/);
  assert.match(read("public/polish-dash.css"), /@media \(max-width: 360px\) \{ \.dv2 \.feed \.chips\.chips--4 \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, "two rows of two on the narrowest phones");
  assert.match(js, /if \(p\.author && p\.author\.handle && me\.profilesFlag\) items\.push\(actBtn\("Mute"/, "Mute only where there is a profile to unmute from");
  assert.match(js, /api\("\/api\/mute", \{ user: p\.author\.handle, on: true \}\)/);
  assert.match(js, /api\("\/api\/posts\/delete", \{ id: p\.id \}\)/);
  assert.match(js, /if \(onDeleted\) onDeleted\(\);/, "deleting your own reply relabels the parent's count");
  assert.match(js, /const onDeleted = \(\) => \{ p\.replies = Math\.max\(0, p\.replies - 1\); relabel\(\); \};/);
  assert.match(js, /if \(p\.deleted\) meta\.append\(el\("span", "tag tag--no", "Deleted by the author"\)\);/, "the moderators' queue labels a deleted row");
  assert.match(js, /update \? 500 : 140/, "500 characters for an update");
  assert.ok(css.indexOf(".post__more") > 0 && css.indexOf(".post__more") < css.indexOf("/* ---- dashboard v2 ---- */"), "the menu's style sits with the feed's, not in the scoped v2 block");
  assert.match(css, /\.post__more \{[^}]*min-width: 44px; min-height: 44px;/, "a 44 px tap target");
  assert.match(rules, /<li data-feed-v2-only hidden><strong>Your own feed:<\/strong> you can delete your own posts, and you can mute people\. People you blocked, and people who blocked you, do not appear in your feed\. Updates come from the city founder, the country manager or Vicinity\.<\/li>/);
  assert.match(site, /if \(d && d\.feedV2\) \$\$\("\[data-feed-v2-only\]"\)\.forEach\(\(e\) => \(e\.hidden = false\)\)/);
  assert.match(prof, /<details class="card prof-blocks" id="pf-mutes" hidden>/);
  assert.equal((prof.match(/role="menuitem"/g) || []).length, 2, "the Mute item is added by the script only while the switch is on");
  assert.match(pjs, /api\("\/api\/mute", \{ user: cur\.handle, on \}\)/);
  assert.match(pjs, /api\("\/api\/mutes"\)/);
  assert.doesNotMatch(read("README.md") + read("docs/DEPLOY.md"), /notifications are sent|we notify|sends a notification/i, "still no notifications");
  assert.match(read("docs/DEPLOY.md"), /Switching it off after people used it: posts they deleted stay deleted/, "what switching off does is written down");
});

/* ---------------- the rows' layout (signed-in test of 17 Oct, F1) ---------------- */

/** The declarations of every rule (inside @media too) whose selector list names `sel` exactly, comments dropped. */
const bodiesOf = (css, sel) => [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(",").map((s) => s.trim()).includes(sel)).map((m) => m[2].trim());

test("the rows' layout (F1): a picture row keeps the text column as wide as a plain row's, the ··· menu open too; replies and the moderators' queue are one column", () => {
  const css = read("public/style.css"), js = read("public/dashboard.js");
  // a row is two columns, the vote then the text; the vote spans three rows (meta, body, actions)
  assert.ok(bodiesOf(css, ".post").some((b) => /display: grid; grid-template-columns: auto minmax\(0, 1fr\);/.test(b)), "the vote column (auto), then the text column");
  assert.ok(bodiesOf(css, ".post__vote").some((b) => /grid-row: span 3;/.test(b)));
  // a picture makes four children after the vote: auto-placed, the actions fell into the vote's column and their width (Reply, ···, the open
  // menu) set it: 109px of 282 at 390 (165px with the menu open, the caption on 3 lines); a plain row's vote column is 44px
  assert.deepEqual(bodiesOf(css, ".post__vote ~ .post__img"), ["grid-column: 2;"], "the picture stays in the text column");
  assert.deepEqual(bodiesOf(css, ".post__vote ~ .post__actions"), ["grid-column: 2;"], "the actions stay in the text column");
  for (const sheet of ["public/style.css", "public/polish-dash.css", "public/polish.css"]) {
    for (const m of read(sheet).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/grid-(column|area)/.test(m[2]) && /\.post__(img|actions|meta|body)\b/.test(m[1])) assert.match(m[1].trim(), /^\.post__vote ~ \.post__img, \.post__vote ~ \.post__actions$/, `${sheet}: nothing else moves a row's parts (${m[1].trim()})`);
    }
  }
  // rows without a vote (a reply, a row in the moderators' queue) are one column: in two, the meta took the first and squeezed the reply's
  // text to 0px at 320 (69px at 390, 26px with its menu open); the "~" rules above never reach them, so no implicit second column either
  assert.deepEqual(bodiesOf(css, ".post__replies > .post"), ["grid-template-columns: minmax(0, 1fr);"]);
  assert.deepEqual(bodiesOf(css, ".posts--compact .post"), ["grid-template-columns: minmax(0, 1fr);"]);
  // what the rules rely on (public/dashboard.js postEl): the vote first and only on top-level rows; then meta, body, picture, actions
  const start = js.indexOf("function postEl(");
  assert.ok(start > 0);
  const at = (s) => { const i = js.indexOf(s, start); assert.ok(i > start, s); return i; };
  const order = ["v.append(up, score); li.append(v);", "li.append(meta);", "li.append(img);", "if (actions.children.length) li.append(actions);"].map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "vote, meta, picture, actions in this order");
  assert.match(js, /if \(!reply\) \{\n\s+const v = el\("div", "post__vote"\);/, "only top-level rows have a vote");
  assert.match(js, /postEl\(p, \{ reply: true, queue: true \}\)/, "the queue's rows have none");
  assert.match(js, /const ul = el\("ul", "post__replies"\);/);
  assert.match(js, /postEl\(r, \{ reply: true, onDeleted \}\)/, "replies are .post rows inside .post__replies, without a vote");
});
