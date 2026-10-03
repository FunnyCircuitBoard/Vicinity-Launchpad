// Follow and block (src/profiles.js): open follow for any signed-in member, the followed member can block, no messaging.
// The rules are checked one by one, and then again with a slow database so that parallel taps really overlap: counts stay exact,
// a block and a follow that meet cannot leave a follow behind a block, and the caps (1,000 followed, 1,000 blocked) hold.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { HOUR, advance, browser, clock, loginBody, realClock, useClock, wallet } from "./helpers/world.js";
import { PF, blockPairs, expectStatus, followPairs, one, quick, rawCounts, rows, seedUsers } from "./helpers/profiles.js";
import { slowDb } from "./helpers/slowdb.js";
import { countsOf } from "../src/profile-core.js";
import { ensureProfilesSchema } from "../src/store.js";

beforeEach(() => useClock("2026-10-01T12:00:00Z"));
after(() => realClock());

const follow = (p, handle, on = true) => p.send("/api/follow", { method: "POST", body: { handle, follow: on } });
const block = (p, handle, on = true) => p.send("/api/block", { method: "POST", body: { handle, block: on } });
const iso = (ms) => new Date(ms).toISOString();

/** A world with a few named members (made in the database: fast). */
async function world(names = ["Alice77", "BobBrave", "CarolCalm"], { slow = false } = {}) {
  const env = PF();
  if (slow) env.DB = slowDb(env.DB, 2);
  await ensureProfilesSchema(env.DB); // the tables are made by the first request: some tests write rows before that
  const people = [];
  for (const n of names) people.push(await quick(env, n));
  return { env, people };
}

/* ---------------- follow ---------------- */

test("follow and unfollow are idempotent; the answer carries the followed member's exact counts", async () => {
  const { env, people: [a, b] } = await world();
  assert.deepEqual(await (await follow(a, "BobBrave")).json(), { ok: true, following: true, counts: { followers: 1, following: 0 } });
  assert.deepEqual(await (await follow(a, "BobBrave")).json(), { ok: true, following: true, counts: { followers: 1, following: 0 } }, "again: nothing changes");
  assert.equal((await rows(env.DB, "SELECT * FROM follows")).length, 1);
  assert.equal((await a.get("/api/profile?u=BobBrave")).profile.viewer.following, true);
  const back = (await b.get("/api/profile?u=Alice77")).profile.viewer;
  assert.deepEqual([back.following, back.followedBy], [false, true]);

  assert.deepEqual(await (await follow(b, "Alice77")).json(), { ok: true, following: true, counts: { followers: 1, following: 1 } });
  assert.deepEqual((await a.get("/api/me")).counts, { followers: 1, following: 1 });
  assert.deepEqual((await b.get("/api/me")).counts, { followers: 1, following: 1 });

  assert.deepEqual(await (await follow(a, "BobBrave", false)).json(), { ok: true, following: false, counts: { followers: 0, following: 1 } });
  assert.deepEqual(await (await follow(a, "BobBrave", false)).json(), { ok: true, following: false, counts: { followers: 0, following: 1 } });
  assert.deepEqual(await followPairs(env.DB), ["BobBrave>Alice77"]);
});

test("the username is matched without regard to case or surrounding blanks, like the unique index does", async () => {
  const { env, people: [a] } = await world();
  for (const h of ["bobbrave", "BOBBRAVE", "  BobBrave ", "bObBrAvE"]) assert.equal((await follow(a, h)).status, 200, h);
  assert.deepEqual(await followPairs(env.DB), ["Alice77>BobBrave"]);
});

test("refusals: yourself, somebody who is not there, bad input, signed out, from another site, a half-made account", async () => {
  const { env, people: [a] } = await world();
  await expectStatus(await follow(a, "alice77"), 400, "self");
  await expectStatus(await follow(a, "Nobody"), 404, "not_found");
  for (const body of [{}, { handle: "BobBrave" }, { handle: "BobBrave", follow: "yes" }, { handle: "BobBrave", follow: 1 }, { handle: 5, follow: true }, { handle: "", follow: true }, { handle: "x".repeat(41), follow: true }, { handle: "a\nb", follow: true }]) {
    await expectStatus(await a.send("/api/follow", { method: "POST", body }), 400, "bad_request");
  }
  await expectStatus(await a.send("/api/follow", { method: "POST" }), 400, "bad_request");
  await expectStatus(await browser(env).send("/api/follow", { method: "POST", body: { handle: "BobBrave", follow: true } }), 401, "sign_in");
  await expectStatus(await a.send("/api/follow", { method: "POST", body: { handle: "BobBrave", follow: true }, origin: "https://evil.example" }), 403, "wrong_origin");
  const pending = browser(env);
  await pending.post("/api/auth/wallet", await loginBody(await wallet()));
  await expectStatus(await follow(pending, "BobBrave"), 401, "sign_in");
  assert.equal((await rows(env.DB, "SELECT * FROM follows")).length, 0);
  // SQL in a username is only ever text
  await expectStatus(await follow(a, "' OR 1=1 --"), 404, "not_found");
  await expectStatus(await follow(a, "%"), 404, "not_found");
  await expectStatus(await follow(a, "_"), 404, "not_found");
});

test("test-lab rows and members under an active ban cannot be found or followed; an expired or other-country ban hides nobody", async () => {
  const { env, people: [a, b, c, d] } = await world(["Alice77", "BobBrave", "CarolCalm", "DanDry"]);
  await env.DB.prepare("UPDATE users SET provider = 'testlab' WHERE handle = 'CarolCalm'").run();
  const ban = (id, country, expires) => env.DB.prepare("INSERT INTO bans (user_id, country, by_user, reason, created_at, expires_at) VALUES (?, ?, 1, 'x', ?, ?)").bind(id, country, iso(clock.now), expires).run();
  await ban(b.id, "US", iso(clock.now + 5 * HOUR));
  await expectStatus(await follow(a, "BobBrave"), 404, "not_found");
  await expectStatus(await follow(a, "CarolCalm"), 404, "not_found");
  await ban(d.id, "FR", iso(clock.now + 5 * HOUR)); // banned in another country: not hidden here
  assert.equal((await follow(a, "DanDry")).status, 200);
  await env.DB.prepare("DELETE FROM bans").run();
  await ban(b.id, "*", iso(clock.now + HOUR));
  await expectStatus(await follow(a, "BobBrave"), 404, "not_found");
  advance(2 * HOUR); // the ban ran out
  assert.equal((await follow(a, "BobBrave")).status, 200);
  assert.equal((await follow(b, "Alice77")).status, 200, "a banned member's own actions are not what is hidden");
  void c;
});

test("you can always let go: unfollowing works for a member who has been hidden since (banned or test-lab), following them does not", async () => {
  const { env, people: [a, b] } = await world();
  await follow(a, "BobBrave");
  await env.DB.prepare("INSERT INTO bans (user_id, country, by_user, reason, created_at, expires_at) VALUES (?, '*', 1, 'x', ?, ?)").bind(b.id, iso(clock.now), iso(clock.now + HOUR)).run();
  assert.deepEqual((await a.get("/api/follows?list=following")).users, [], "hidden from the list");
  await expectStatus(await follow(a, "BobBrave"), 404, "not_found");
  assert.deepEqual(await (await follow(a, "BobBrave", false)).json(), { ok: true, following: false, counts: { followers: 0, following: 0 } });
  assert.deepEqual(await followPairs(env.DB), [], "the row is gone");
});

test("a banned or test-lab follower is not in the counts or the lists (they are exact for what people can see); the rows stay", async () => {
  const { env, people: [a, b, c, d] } = await world(["Alice77", "BobBrave", "CarolCalm", "DanDry"]);
  for (const p of [b, c, d]) await follow(p, "Alice77");
  assert.equal((await countsOf(env.DB, a.id)).followers, 3);
  await env.DB.prepare("UPDATE users SET provider = 'testlab' WHERE handle = 'CarolCalm'").run();
  await env.DB.prepare("INSERT INTO bans (user_id, country, by_user, reason, created_at, expires_at) VALUES (?, '*', 1, 'x', ?, ?)").bind(d.id, iso(clock.now), iso(clock.now + HOUR)).run();
  assert.equal((await countsOf(env.DB, a.id)).followers, 1);
  assert.deepEqual((await a.get("/api/follows?list=followers")).users.map((u) => u.handle), ["BobBrave"]);
  assert.equal((await a.get("/api/profile")).profile.counts.followers, 1);
  assert.equal((await rawCounts(env.DB, a.id)).followers, 3, "nothing was deleted");
  advance(2 * HOUR);
  assert.equal((await countsOf(env.DB, a.id)).followers, 2, "the banned member counts again when the ban is over");
});

/* ---------------- block ---------------- */

test("a block: the blocked member cannot follow (and is never told it is a block), their follow of you goes, and so does yours of them", async () => {
  const { env, people: [a, b, c] } = await world();
  await follow(a, "BobBrave"); await follow(b, "Alice77"); await follow(c, "BobBrave"); await follow(b, "CarolCalm");
  assert.deepEqual(await followPairs(env.DB), ["Alice77>BobBrave", "BobBrave>Alice77", "BobBrave>CarolCalm", "CarolCalm>BobBrave"]);

  // Bob blocks Alice: Alice's follow of Bob goes (their follow of you), and Bob's follow of Alice goes (your follow of them)
  assert.deepEqual(await (await block(b, "alice77")).json(), { ok: true, blocked: true });
  assert.deepEqual(await followPairs(env.DB), ["BobBrave>CarolCalm", "CarolCalm>BobBrave"]);
  assert.deepEqual(await blockPairs(env.DB), ["BobBrave>Alice77"]);

  // Alice cannot follow Bob again, and the answer says nothing about a block
  const refused = await expectStatus(await follow(a, "BobBrave"), 403, "cannot_follow");
  assert.deepEqual(refused, { ok: false, error: "cannot_follow" });
  const view = (await a.get("/api/profile?u=BobBrave")).profile;
  assert.equal(view.viewer.blockedBy, false, "never shown");
  assert.deepEqual([view.counts.followers, view.counts.following], [1, 1], "and Bob's profile is still there to open");
  assert.deepEqual((await a.get("/api/me/blocks")).users, [], "Alice's own list is empty: it is not hers");
  assert.deepEqual((await b.get("/api/me/blocks")).users, [{ handle: "Alice77" }]);
  assert.equal((await b.get("/api/profile?u=Alice77")).profile.viewer.blocked, true);
  assert.equal(JSON.stringify(await a.get("/api/profile?u=BobBrave")).includes('"blockedBy":true'), false);
  // others are not affected
  assert.equal((await follow(c, "BobBrave")).status, 200);

  // idempotent
  assert.deepEqual(await (await block(b, "Alice77")).json(), { ok: true, blocked: true });
  assert.equal((await rows(env.DB, "SELECT * FROM blocks")).length, 1);
  assert.deepEqual(await rawCounts(env.DB, b.id), { followers: 1, following: 1, blocking: 1, blockedBy: 0 });
});

test("unblock: Alice may follow again (nothing is restored by itself); you cannot follow somebody you blocked until you unblock", async () => {
  const { env, people: [a, b] } = await world();
  await follow(a, "BobBrave"); await block(b, "Alice77");
  assert.deepEqual(await (await block(b, "Alice77", false)).json(), { ok: true, blocked: false });
  assert.deepEqual(await (await block(b, "Alice77", false)).json(), { ok: true, blocked: false }, "idempotent");
  assert.deepEqual(await followPairs(env.DB), [], "the follow that the block removed stays removed");
  assert.equal((await follow(a, "BobBrave")).status, 200);

  await block(b, "Alice77");
  await expectStatus(await follow(b, "Alice77"), 409, "unblock_first");
  assert.deepEqual(await followPairs(env.DB), []);
  await block(b, "Alice77", false);
  assert.equal((await follow(b, "Alice77")).status, 200);
});

test("block refusals: yourself, nobody, bad input, signed out, another site, an owner, an admin, a moderator", async () => {
  const { env, people: [a, b, owner, admin, mod] } = await world(["Alice77", "BobBrave", "OwnerOlga", "AdminAl", "ModMia"]);
  env.ADMIN_WALLETS = owner.w.address;
  const grant = (p, role) => env.DB.prepare("INSERT INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, ?, 'x', ?)").bind(p.w.address, role, iso(clock.now)).run();
  await grant(admin, "admin"); await grant(mod, "moderator");
  await expectStatus(await block(a, "alice77"), 400, "self");
  await expectStatus(await block(a, "Nobody"), 404, "not_found");
  for (const body of [{}, { handle: "BobBrave" }, { handle: "BobBrave", block: "yes" }, { block: true }]) await expectStatus(await a.send("/api/block", { method: "POST", body }), 400, "bad_request");
  await expectStatus(await browser(env).send("/api/block", { method: "POST", body: { handle: "BobBrave", block: true } }), 401, "sign_in");
  await expectStatus(await a.send("/api/block", { method: "POST", body: { handle: "BobBrave", block: true }, origin: "https://evil.example" }), 403, "wrong_origin");
  for (const h of ["OwnerOlga", "AdminAl", "ModMia"]) await expectStatus(await block(a, h), 409, "cannot_block");
  assert.deepEqual(await blockPairs(env.DB), [], "no row was made");
  assert.equal((await block(a, "BobBrave")).status, 200);
  // an admin can be unblocked-from (a block made before the role was given) and can block others
  assert.equal((await block(admin, "BobBrave")).status, 200);
  void b;
});

test("you can block only members you can see, but unblock anybody who exists (also one who is hidden since)", async () => {
  const { env, people: [a, b] } = await world();
  await block(a, "BobBrave");
  await env.DB.prepare("UPDATE users SET provider = 'testlab' WHERE handle = 'BobBrave'").run();
  await expectStatus(await block(a, "BobBrave"), 404, "not_found");
  assert.deepEqual(await (await block(a, "BobBrave", false)).json(), { ok: true, blocked: false });
  assert.deepEqual(await blockPairs(env.DB), []);
  void b;
});

test("the block list is private, newest first, only handles, and skips members who are gone", async () => {
  const { env, people: [a, b, c, d] } = await world(["Alice77", "BobBrave", "CarolCalm", "DanDry"]);
  await block(a, "BobBrave"); advance(1000); await block(a, "CarolCalm"); advance(1000); await block(a, "DanDry"); await block(b, "Alice77");
  const mine = await a.get("/api/me/blocks");
  assert.deepEqual(mine, { ok: true, users: [{ handle: "DanDry" }, { handle: "CarolCalm" }, { handle: "BobBrave" }] });
  assert.deepEqual((await b.get("/api/me/blocks")).users, [{ handle: "Alice77" }]);
  assert.deepEqual((await c.get("/api/me/blocks")).users, []);
  await env.DB.prepare("DELETE FROM users WHERE handle = 'CarolCalm'").run();
  assert.deepEqual((await a.get("/api/me/blocks")).users.map((u) => u.handle), ["DanDry", "BobBrave"]);
  await expectStatus(await browser(env).send("/api/me/blocks"), 401, "sign_in");
  void d;
});

/* ---------------- caps ---------------- */

/** n follow rows from `id` to people who do not exist (fast way to a nearly full follow list). */
const phantomFollows = (env, id, n) => env.DB.batch(Array.from({ length: n }, (_, i) => env.DB.prepare("INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)").bind(id, 1_000_000 + i, iso(clock.now))));
const phantomBlocks = (env, id, n) => env.DB.batch(Array.from({ length: n }, (_, i) => env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)").bind(id, 1_000_000 + i, iso(clock.now))));

test("a member follows at most 1,000: the 1,001st is too_many_following, following somebody again at the cap is fine, unfollowing makes room", async () => {
  const { env, people: [a, b, c] } = await world();
  await phantomFollows(env, a.id, 998);
  assert.equal((await follow(a, "BobBrave")).status, 200, "the 999th");
  assert.equal((await follow(a, "CarolCalm")).status, 200, "the 1,000th");
  assert.equal((await rawCounts(env.DB, a.id)).following, 1000);
  await seedUsers(env.DB, "Extra", 1);
  await expectStatus(await follow(a, "Extra0"), 409, "too_many_following");
  assert.equal((await follow(a, "BobBrave")).status, 200, "already followed: the same answer as always");
  assert.equal((await rawCounts(env.DB, a.id)).following, 1000);
  assert.equal((await follow(a, "BobBrave", false)).status, 200);
  assert.equal((await follow(a, "Extra0")).status, 200, "room again");
  assert.equal((await rawCounts(env.DB, a.id)).following, 1000);
  void b; void c;
});

test("the cap holds when six taps arrive together at 997 followed: exactly three get in", async () => {
  const { env, people: [a] } = await world(["Alice77"], { slow: true });
  await seedUsers(env.DB, "T", 6);
  await phantomFollows(env, a.id, 997);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => follow(a, "T" + i).then(async (r) => [r.status, (await r.json()).error])));
  assert.equal(results.filter(([s]) => s === 200).length, 3);
  assert.deepEqual(results.filter(([s]) => s !== 200).map(([, e]) => e), ["too_many_following", "too_many_following", "too_many_following"]);
  assert.equal((await rawCounts(env.DB, a.id)).following, 1000, "never 1,001");
});

test("a member blocks at most 1,000 (too_many_blocks), also with parallel taps, and a refused block removes no follow", async () => {
  const { env, people: [a, b] } = await world(["Alice77", "BobBrave"], { slow: true });
  await seedUsers(env.DB, "T", 5);
  await phantomBlocks(env, a.id, 998);
  await follow(b, "Alice77"); await follow(a, "BobBrave");
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => block(a, "T" + i).then(async (r) => [r.status, (await r.json()).error, i])));
  assert.equal(results.filter(([s]) => s === 200).length, 2);
  assert.ok(results.filter(([s]) => s !== 200).every(([s, e]) => s === 409 && e === "too_many_blocks"));
  const blocked = results.find(([s]) => s === 200)[2]; // which two got in depends on who arrived first
  assert.equal((await rawCounts(env.DB, a.id)).blocking, 1000);
  await expectStatus(await block(a, "BobBrave"), 409, "too_many_blocks");
  assert.deepEqual(await followPairs(env.DB), ["Alice77>BobBrave", "BobBrave>Alice77"], "the follows are untouched by a block that was refused");
  assert.equal((await block(a, "T" + blocked, false)).status, 200);
  assert.equal((await block(a, "BobBrave")).status, 200, "room again");
});

/* ---------------- limits ---------------- */

test("60 follow or unfollow actions an hour: the 61st is slow_down and changes nothing; refused ones count too; an hour later it is open again", async () => {
  const { env, people: [a, b, c] } = await world();
  for (let i = 0; i < 60; i++) assert.equal((await follow(a, "BobBrave", i % 2 === 0)).status, 200, "action " + (i + 1));
  assert.equal((await rawCounts(env.DB, b.id)).followers, 0, "the 60th was an unfollow");
  await expectStatus(await follow(a, "BobBrave", true), 429, "slow_down");
  await expectStatus(await follow(a, "BobBrave", true), 429, "slow_down");
  assert.equal((await rawCounts(env.DB, b.id)).followers, 0);
  assert.equal((await follow(c, "BobBrave")).status, 200, "somebody else has their own count");
  advance(HOUR + 1000);
  assert.equal((await follow(a, "BobBrave")).status, 200);
});

test("60 block or unblock actions an hour (follow actions have their own count)", async () => {
  const { env, people: [a, b] } = await world();
  for (let i = 0; i < 60; i++) assert.equal((await block(a, "BobBrave", i % 2 === 0)).status, 200);
  await expectStatus(await block(a, "BobBrave"), 429, "slow_down");
  assert.equal((await follow(a, "BobBrave")).status, 200, "following is not held back by blocking");
  assert.equal((await rawCounts(env.DB, a.id)).blocking, 0);
  void b;
});

/* ---------------- races ---------------- */

test("20 identical follows at once make one row and one count; 20 unfollows at once leave none", async () => {
  const { env, people: [a, b] } = await world(["Alice77", "BobBrave"], { slow: true });
  const ons = await Promise.all(Array.from({ length: 20 }, () => follow(a, "BobBrave").then((r) => r.json())));
  assert.ok(ons.every((r) => r.ok && r.following === true));
  assert.equal((await rows(env.DB, "SELECT * FROM follows")).length, 1);
  assert.deepEqual(await countsOf(env.DB, b.id), { followers: 1, following: 0 });
  const offs = await Promise.all(Array.from({ length: 20 }, () => follow(a, "BobBrave", false).then((r) => r.json())));
  assert.ok(offs.every((r) => r.ok && r.following === false));
  assert.equal((await rows(env.DB, "SELECT * FROM follows")).length, 0);
  const blocks = await Promise.all(Array.from({ length: 20 }, () => block(b, "Alice77").then((r) => r.json())));
  assert.ok(blocks.every((r) => r.ok && r.blocked === true));
  assert.equal((await rows(env.DB, "SELECT * FROM blocks")).length, 1, "one block, however many taps");
  const unblocks = await Promise.all(Array.from({ length: 20 }, () => block(b, "Alice77", false).then((r) => r.json())));
  assert.ok(unblocks.every((r) => r.ok && r.blocked === false));
  assert.equal((await rows(env.DB, "SELECT * FROM blocks")).length, 0);
});

test("30 follows and unfollows mixed up and sent together: every answer is fine and the counts equal the rows", async () => {
  const { env, people: [a, b] } = await world(["Alice77", "BobBrave"], { slow: true });
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => follow(a, "BobBrave", i % 3 !== 0)));
  assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join());
  const n = (await rows(env.DB, "SELECT * FROM follows")).length;
  assert.ok(n === 0 || n === 1);
  assert.deepEqual(await countsOf(env.DB, b.id), { followers: n, following: 0 });
  assert.deepEqual(await countsOf(env.DB, a.id), { followers: 0, following: n });
});

test("a block and a follow that meet, in any order, never leave a follow behind a block (24 pairs at once)", async () => {
  const { env, people } = await world(Array.from({ length: 48 }, (_, i) => "P" + i), { slow: true });
  const pairs = Array.from({ length: 24 }, (_, i) => [people[2 * i], people[2 * i + 1]]); // [blocker, follower]
  const out = await Promise.all(pairs.flatMap(([blocker, follower], i) => {
    const doBlock = () => block(blocker, follower.handle).then((r) => ["block", r.status]);
    const doFollow = () => follow(follower, blocker.handle).then(async (r) => ["follow", r.status, (await r.json()).error]);
    return i % 2 ? [doFollow(), doBlock()] : [doBlock(), doFollow()];
  }));
  for (const r of out) {
    if (r[0] === "block") assert.equal(r[1], 200);
    else assert.ok(r[1] === 200 || (r[1] === 403 && r[2] === "cannot_follow"), JSON.stringify(r));
  }
  for (const [blocker, follower] of pairs) {
    assert.deepEqual(await blockPairs(env.DB).then((l) => l.filter((x) => x === `${blocker.handle}>${follower.handle}`)), [`${blocker.handle}>${follower.handle}`]);
    const remaining = (await followPairs(env.DB)).filter((x) => x === `${follower.handle}>${blocker.handle}` || x === `${blocker.handle}>${follower.handle}`);
    assert.deepEqual(remaining, [], `no follow between ${blocker.handle} and ${follower.handle} once the block is in`);
  }
  // and the other way round: the block happens first, the follow comes later (never mind how soon)
  const [x, y] = [people[0], people[1]];
  await expectStatus(await follow(y, x.handle), 403, "cannot_follow");
});

test("25 members follow the same member at the same time: exactly 25 followers, listed once each; then half of them leave at once", async () => {
  const { env, people } = await world(["Star", ...Array.from({ length: 25 }, (_, i) => "Fan" + i)], { slow: true });
  const [star, ...fans] = people;
  const rs = await Promise.all(fans.map((f) => follow(f, "Star")));
  assert.ok(rs.every((r) => r.status === 200));
  assert.deepEqual(await countsOf(env.DB, star.id), { followers: 25, following: 0 });
  const listed = (await star.get("/api/follows?list=followers")).users.map((u) => u.handle);
  assert.equal(new Set(listed).size, 25);
  await Promise.all(fans.slice(0, 12).map((f) => follow(f, "Star", false)));
  assert.deepEqual(await countsOf(env.DB, star.id), { followers: 13, following: 0 });
  assert.equal((await star.get("/api/me")).counts.followers, 13);
  assert.equal((await rawCounts(env.DB, star.id)).followers, 13);
});

test("follow and unfollow by different people at once: the counts are the rows, for everybody", async () => {
  const { env, people } = await world(Array.from({ length: 12 }, (_, i) => "P" + i), { slow: true });
  const [target, ...rest] = people;
  for (const p of rest.slice(0, 6)) await follow(p, "P0");
  await Promise.all([...rest.slice(0, 6).map((p) => follow(p, "P0", false)), ...rest.slice(6).map((p) => follow(p, "P0"))]);
  assert.deepEqual(await countsOf(env.DB, target.id), { followers: 5, following: 0 });
  for (const p of rest) assert.deepEqual(await countsOf(env.DB, p.id), { followers: 0, following: rest.indexOf(p) >= 6 ? 1 : 0 });
});

/* ---------------- lists ---------------- */

/** n followers of `id`, each following at a time `step` ms apart, in groups of `ties` sharing one time. Returns the follower ids, oldest first. */
async function seedFollowers(env, id, prefix, n, { ties = 1, step = 1000 } = {}) {
  const ids = await seedUsers(env.DB, prefix, n);
  await env.DB.batch(ids.map((u, i) => env.DB.prepare("INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)").bind(u, id, iso(clock.now + Math.floor(i / ties) * step))));
  return ids;
}

test("followers come newest first, 50 a page, with a cursor; ties on the same moment are kept in a fixed order; nobody is skipped or repeated", async () => {
  const { env, people: [a] } = await world(["Alice77"]);
  const ids = await seedFollowers(env, a.id, "F", 120, { ties: 3 });
  const seen = [];
  let after = null, pages = 0;
  do {
    const r = await a.get("/api/follows?list=followers" + (after ? "&after=" + encodeURIComponent(after) : ""));
    assert.equal(r.ok, true);
    assert.ok(r.users.length <= 50);
    seen.push(...r.users.map((u) => u.handle));
    after = r.next; pages++;
    if (after) assert.equal(r.users.length, 50, "a full page when there is a next one");
  } while (after);
  assert.equal(pages, 3);
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120);
  // newest first: by time, and inside one moment by the larger id first
  const expected = ids.map((u, i) => ({ u, t: Math.floor(i / 3) })).sort((x, y) => y.t - x.t || y.u - x.u).map((x) => "F" + ids.indexOf(x.u));
  assert.deepEqual(seen, expected);
  assert.equal((await a.get("/api/follows?list=followers&after=" + encodeURIComponent("2000-01-01T00:00:00.000Z_1"))).next, null);
  assert.deepEqual((await a.get("/api/follows?list=followers&after=" + encodeURIComponent("2000-01-01T00:00:00.000Z_1"))).users, [], "past the oldest: an empty page");
});

test("exactly 50 followers is one page with no next; 51 makes a second page of one", async () => {
  const { env, people: [a] } = await world(["Alice77"]);
  await seedFollowers(env, a.id, "F", 50);
  let r = await a.get("/api/follows?list=followers");
  assert.deepEqual([r.users.length, r.next], [50, null]);
  const [g] = await seedFollowers(env, a.id, "G", 1);
  await env.DB.prepare("UPDATE follows SET created_at = ? WHERE follower_id = ?").bind(iso(clock.now - 5000), g).run(); // the oldest of all
  r = await a.get("/api/follows?list=followers");
  assert.equal(r.users.length, 50);
  assert.ok(r.next);
  const r2 = await a.get("/api/follows?list=followers&after=" + encodeURIComponent(r.next));
  assert.deepEqual([r2.users.length, r2.next, r2.users[0].handle], [1, null, "G0"]);
});

test("the following list works the same way; any member may read another member's lists; with no username you get your own", async () => {
  const { env, people: [a, b] } = await world(["Alice77", "BobBrave"]);
  const targets = await seedUsers(env.DB, "T", 60);
  await env.DB.batch(targets.map((t, i) => env.DB.prepare("INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)").bind(a.id, t, iso(clock.now + i * 1000))));
  let r = await b.get("/api/follows?u=ALICE77&list=following");
  assert.equal(r.users.length, 50);
  assert.equal(r.users[0].handle, "T59");
  r = await b.get("/api/follows?u=alice77&list=following&after=" + encodeURIComponent(r.next));
  assert.deepEqual([r.users.length, r.next, r.users[9].handle], [10, null, "T0"]);
  assert.equal((await a.get("/api/follows?list=following")).users.length, 50, "your own, without a username");
  assert.equal((await b.get("/api/follows?list=following")).users.length, 0, "Bob follows nobody");
  assert.deepEqual((await b.get("/api/follows?list=followers")).users, []);
});

test("a list row is only a username and a community; counts and lists skip members who are not there", async () => {
  const { env, people: [a] } = await world(["Alice77"]);
  const [x] = await seedFollowers(env, a.id, "F", 1);
  await seedUsers(env.DB, "NoHome", 1, { home: null });
  await env.DB.prepare("INSERT INTO follows (follower_id, followee_id, created_at) SELECT id, ?, ? FROM users WHERE handle = 'NoHome0'").bind(a.id, iso(clock.now + 5000)).run();
  await env.DB.prepare("INSERT INTO follows (follower_id, followee_id, created_at) VALUES (999999, ?, ?)").bind(a.id, iso(clock.now + 9000)).run(); // somebody who was deleted
  const r = await a.get("/api/follows?list=followers");
  assert.deepEqual(r.users, [{ handle: "NoHome0", home: null }, { handle: "F0", home: { name: "Utica", country: "US" } }]);
  assert.deepEqual(await countsOf(env.DB, a.id), { followers: 2, following: 0 }, "the deleted member is not counted");
  void x;
});

test("list refusals: no list name, a wrong one, a broken cursor, nobody there, signed out", async () => {
  const { env, people: [a] } = await world(["Alice77"]);
  await expectStatus(await a.send("/api/follows"), 400, "bad_request");
  await expectStatus(await a.send("/api/follows?list=friends"), 400, "bad_request");
  for (const after of ["x", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z_", "2026-10-01T00:00:00.000Z_abc", "_5", "2026-10-01T00:00:00.000Z_5; DROP TABLE follows", "2026-10-01 00:00:00_5", "2026-10-01T00:00:00.000Z_" + "9".repeat(20)]) {
    await expectStatus(await a.send("/api/follows?list=followers&after=" + encodeURIComponent(after)), 400, "bad_request");
  }
  await expectStatus(await a.send("/api/follows?u=Nobody&list=followers"), 404, "not_found");
  await expectStatus(await a.send("/api/follows?u=" + "x".repeat(41) + "&list=followers"), 400, "bad_request");
  await expectStatus(await browser(env).send("/api/follows?list=followers"), 401, "sign_in");
  assert.equal((await rows(env.DB, "SELECT name FROM sqlite_master WHERE name = 'follows'")).length, 1, "the table is still there");
});

test("120 list openings an hour (blocks included): the 121st is slow_down", async () => {
  const { env, people: [a] } = await world(["Alice77"]);
  for (let i = 0; i < 120; i++) assert.equal((await a.send("/api/follows?list=followers")).status, 200);
  await expectStatus(await a.send("/api/follows?list=followers"), 429, "slow_down");
  await expectStatus(await a.send("/api/me/blocks"), 429, "slow_down");
  advance(HOUR + 1000);
  assert.equal((await a.send("/api/follows?list=followers")).status, 200);
  void env;
});

test("the follow rows are what the database says: nothing about follow or block ever reaches the follower in a form that reveals a block", async () => {
  const { env, people: [a, b] } = await world(["Alice77", "BobBrave"]);
  await block(b, "Alice77");
  const seen = [];
  a.net.tap = async ({ response }) => { seen.push(await response.text()); };
  await follow(a, "BobBrave");
  await a.get("/api/profile?u=BobBrave");
  await a.get("/api/follows?u=BobBrave&list=followers");
  await a.get("/api/members/search?q=bo");
  await a.get("/api/me/blocks");
  const text = seen.join("\n");
  assert.ok(!/"blockedBy":true|you_blocked|blocked_you|"blocked":true|blocked you/i.test(text), text);
  void env;
});

test("a member who changes their username is the same member: follows, blocks and lists follow the new name, the old name is free", async () => {
  const { env, people: [a, b] } = await world();
  await follow(a, "BobBrave"); await follow(b, "Alice77"); await block(a, "BobBrave"); // Alice blocks Bob after all: the follows are gone
  await block(a, "BobBrave", false); await follow(a, "BobBrave");
  assert.equal((await b.post("/api/me/username", { username: "BobRenamed" })).ok, true);
  await expectStatus(await a.send("/api/profile?u=BobBrave"), 404, "not_found");
  assert.deepEqual((await a.get("/api/follows?list=following")).users.map((u) => u.handle), ["BobRenamed"]);
  assert.equal((await a.get("/api/profile?u=bobrenamed")).profile.viewer.following, true);
  assert.deepEqual(await countsOf(env.DB, b.id), { followers: 1, following: 0 });
  assert.deepEqual(await followPairs(env.DB), ["Alice77>BobRenamed"]);
});

test("a database error in the middle of a change is a plain 503 on these routes (nothing half done), and only a short reason is logged", async () => {
  const { env, people: [a] } = await world();
  const real = env.DB;
  const failing = { ...real, batch: async (list) => { if (list.some((s) => /INSERT INTO follows|INSERT INTO blocks/.test((s.inner || s).sql))) throw new Error("D1_ERROR: database is locked"); return real.batch(list.map((s) => s.inner || s)); } };
  env.DB = failing;
  const noisy = console.error; const logged = [];
  console.error = (...x) => { logged.push(x.join(" ")); };
  try {
    await expectStatus(await follow(a, "BobBrave"), 503, "unavailable");
    await expectStatus(await block(a, "BobBrave"), 503, "unavailable");
  } finally { console.error = noisy; }
  assert.equal(logged.length, 2);
  assert.ok(logged.every((l) => /profile route failed: ?D1_ERROR|profile route failed D1_ERROR/.test(l) && !l.includes(a.w.address) && l.length < 160), logged.join(" | "));
  env.DB = real;
  assert.equal((await follow(a, "BobBrave")).status, 200, "and it works again as soon as the database does");
});
