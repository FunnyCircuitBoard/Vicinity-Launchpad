// Which displayed names are usernames. With PROFILES=on the feeds, the city picture and the country picture say so next to every
// name (`handle`: the member's username, or null for a member without one), so that the dashboard links a name to /profile?u=
// only when it really is that member's username. A display name that happens to look like a username (a Google first name such
// as "Quentin") is never a link: it would open a stranger's profile, or none. With the switch off these keys do not exist and the
// answers are exactly what they have always been.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { clock, newWorld, realClock, useClock } from "./helpers/world.js";
import { PF, keysOf, quick } from "./helpers/profiles.js";
import { ensureSchema } from "../src/store.js";

beforeEach(() => useClock("2026-10-01T12:00:00Z"));
after(() => realClock());
const iso = (ms) => new Date(ms).toISOString();

/** Quentin (no username, first name "Quentin"), BobBrave (a username), a viewer in Utica; Quentin founds Utica, Bob manages the US from Syracuse. */
async function cast(env) {
  await ensureSchema(env.DB);
  const q = await quick(env, "Quentin"), b = await quick(env, "BobBrave", { home: { id: "5140405", name: "Syracuse", country: "US" } }), v = await quick(env, "Viewer1");
  await env.DB.prepare("UPDATE users SET handle = NULL, name = 'Quentin' WHERE id = ?").bind(q.id).run();
  const at = iso(clock.now);
  const seat = (p, city, name) => env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, ?, 'US', ?, ?, 5, 1, 'active', ?, ?)")
    .bind(city, name, p.id, p.w.address, at, at).run();
  await seat(q, "5142056", "Utica");
  const bobSeat = (await seat(b, "5140405", "Syracuse")).meta.last_row_id;
  await env.DB.prepare("INSERT INTO manager_terms (country, seat_id, user_id, wallet, starts_at, ends_at, consecutive, status) VALUES ('US', ?, ?, ?, ?, ?, 1, 'active')")
    .bind(bobSeat, b.id, b.w.address, iso(clock.now - 86400_000), iso(clock.now + 30 * 86400_000)).run();
  assert.equal((await q.post("/api/posts", { scope: "city", kind: "talk", body: "hello from Quentin" })).ok, true);
  assert.equal((await v.post("/api/posts", { scope: "city", kind: "talk", body: "hello from the viewer" })).ok, true);
  return { q, b, v };
}

test("switch on: every feed author, the city's founder and the country's manager carry `handle`: the username, or null for a member without one", async () => {
  const env = PF();
  const { v } = await cast(env);
  const posts = (await v.get("/api/posts?scope=city&kind=talk")).posts;
  const by = (name) => posts.find((p) => p.author.name === name).author;
  assert.deepEqual(by("Quentin"), { name: "Quentin", handle: null, founder: "Utica", steward: false, manager: false }, "a display name: handle is null, the page shows plain text");
  assert.deepEqual(by("Viewer1"), { name: "Viewer1", handle: "Viewer1", founder: null, steward: false, manager: false }, "a username: the page may link it");
  const me = await v.get("/api/me");
  assert.deepEqual([me.community.seat.name, me.community.seat.handle, me.community.seat.you], ["Quentin", null, false]);
  assert.deepEqual([me.national.manager.name, me.national.manager.handle, me.national.manager.you], ["BobBrave", "BobBrave", false]);
  // the trap: "Quentin" is a well-formed username that somebody else may own, so a link made from the name alone opens a stranger
  const stranger = await quick(env, "quentin");
  assert.equal((await v.get("/api/profile?u=Quentin")).profile.wallet, stranger.w.address, "/profile?u=Quentin is the stranger's profile, not the author's");
});

test("switch off: no `handle` key anywhere; the feeds, the city picture and the country picture are exactly what they always were", async () => {
  const env = newWorld();
  const { v } = await cast(env);
  const posts = (await v.get("/api/posts?scope=city&kind=talk")).posts;
  assert.equal(posts.length, 2);
  for (const p of posts) assert.deepEqual(Object.keys(p.author), ["name", "founder", "steward", "manager"], JSON.stringify(p.author));
  const me = await v.get("/api/me");
  assert.deepEqual([me.community.seat.name, me.national.manager.name], ["Quentin", "BobBrave"]);
  assert.ok(!keysOf(me.community).has("handle") && !keysOf(me.national).has("handle") && !keysOf(posts).has("handle"), "not one new key with the switch off");
});
