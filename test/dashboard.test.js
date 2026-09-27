// Dashboard: home community, live position and badges, local + national feeds, check-ins,
// "add my town" requests, and the public numbers.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { DAY, EMPTY, IN_NYC, IN_UTICA, MINT, attest, browser, newWorld, passTime, person, realClock, reprove, setHolding, tick, useClock, wallet } from "./helpers/world.js";
import { weekStart } from "../src/social.js";

let env;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = newWorld(); });
after(() => realClock());
const launch = () => { env.VICINITY_MINT = MINT; };

test("home community: inside one → it's home; in empty land → one of the three nearest; then locked for a week", async () => {
  const a = await person(env);
  let d = await a.post("/api/home", { attestation: await attest(a, IN_UTICA, "home") });
  assert.deepEqual(d.home, { id: "5142056", name: "Utica", country: "US" });
  assert.equal((await a.post("/api/home", { attestation: await attest(a, IN_NYC, "home") })).error, "home_locked");

  const b = await person(env);
  const att = await attest(b, EMPTY, "home");
  d = await b.post("/api/home", { attestation: att });
  assert.equal(d.error, "choose_nearby");
  assert.equal(d.nearby.length, 3);
  assert.equal(d.nearby[0].name, "Utica");
  const again = await attest(b, EMPTY, "home");
  assert.equal((await b.post("/api/home", { attestation: again, choice: "5128581" })).error, "choose_nearby", "only the three nearest");
  d = await b.post("/api/home", { attestation: await attest(b, EMPTY, "home"), choice: d.nearby[1].id });
  assert.equal(d.ok, true);
  assert.equal(d.joinedNearby, true);

  const c = await person(env);
  assert.equal((await c.post("/api/locate", { location: { ...IN_UTICA, accuracy: 50_000 }, purpose: "home", country: "US" })).error, "location_unverified");
  assert.equal((await browser(env).post("/api/locate", { location: IN_UTICA, purpose: "home", country: "US" })).error, "sign_in");
});

test("dashboard before launch: early member, verified, local; the founder path waits for launch", async () => {
  const a = await person(env, { home: IN_UTICA });
  const me = await a.get("/api/me");
  assert.equal(me.signedIn, true);
  assert.equal(me.launched, false);
  assert.equal(me.level, "member");
  assert.deepEqual(me.badges.filter((b) => b.earned).map((b) => b.id), ["early", "verified", "local"]);
  assert.equal(me.community.name, "Utica");
  assert.equal(me.community.members, 1);
  assert.equal(me.community.seat, null);
  assert.equal(me.founder.why, "not_launched");
  assert.equal(me.progress.steps.find((s) => s.id === "hold").detail, "starts at launch");
  assert.equal((await browser(env).get("/api/me")).signedIn, false);
});

test("live after launch: ranks, and the 14-day holding clock towards founder-ready", async () => {
  launch();
  const a = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  const b = await person(env, { home: IN_UTICA, holds: 5_000 });
  await person(env, { home: IN_NYC, holds: 50_000_000 });
  await tick(env);
  let me = await a.get("/api/me");
  assert.equal(me.level, "holder");
  assert.equal(me.holding.rank, 2);
  assert.equal(me.holding.total, 3);
  assert.equal(me.holding.next.gap, 48_000_000);
  assert.equal(me.community.rank, 1);
  assert.equal(me.community.holders, 2);
  assert.equal(me.founder.why, "home_too_new");
  assert.equal(me.founder.tenure.qualified, false);
  await passTime(env, 15 * DAY);
  await reprove(a);
  me = await a.get("/api/me");
  assert.equal(me.founder.eligible, true, JSON.stringify(me.founder));
  assert.ok(me.badges.find((x) => x.id === "founder_ready").earned);
  assert.equal((await b.get("/api/me")).founder.why, "not_qualified");
  setHolding(a.w.address, 10);
  me = await a.get("/api/me");
  assert.equal(me.founder.eligible, false);
  assert.ok(me.lost.includes("founder_ready"), "selling takes the badge away on the next check");
});

test("feeds: post, see only your city (and your country), vote, reply; moderators hide with a reason", async () => {
  const a = await person(env, { home: IN_UTICA }), b = await person(env, { home: IN_UTICA }), n = await person(env, { home: IN_NYC });
  let d = await a.post("/api/posts", { scope: "city", kind: "meme", body: "The Boilermaker hill has a name 😂" });
  assert.equal(d.ok, true);
  const id = d.post.id;
  assert.equal(d.post.author.name, a.name);
  assert.equal((await a.post("/api/posts", { scope: "city", kind: "meme", body: "Buy EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm now" })).error, "no_addresses");
  assert.equal((await a.post("/api/posts", { scope: "city", kind: "talk", body: "x".repeat(1001) })).error, "too_long");
  await a.post("/api/posts", { scope: "country", kind: "talk", body: "Which NY city has the best pizza?" });

  let feed = await b.get("/api/posts?scope=city&kind=meme");
  assert.equal(feed.posts.length, 1);
  assert.equal(feed.posts[0].author.wallet, undefined, "feeds never show wallets");
  assert.equal((await n.get("/api/posts?scope=city&kind=meme")).posts.length, 0, "NYC doesn't see Utica's local feed");
  assert.equal((await n.get("/api/posts?scope=country&kind=talk")).posts.length, 1, "the whole country shares the national feed");

  d = await b.post("/api/posts/vote", { id });
  assert.deepEqual([d.voted, d.score, d.weight], [true, 1, 1]);
  assert.equal((await a.post("/api/posts/vote", { id })).error, "own_post");
  assert.equal((await n.post("/api/posts/vote", { id })).error, "not_found");
  feed = await b.get("/api/posts?scope=city&kind=meme&sort=top");
  assert.equal(feed.posts[0].voted, true);
  assert.equal((await b.post("/api/posts/vote", { id })).voted, false);

  await b.post("/api/posts", { parent: id, body: "Every local knows it" });
  assert.equal((await a.get(`/api/posts?parent=${id}`)).posts.length, 1);
  assert.equal((await a.get("/api/posts?scope=city&kind=meme")).posts[0].replies, 1);

  await reprove(b);
  assert.equal((await b.post("/api/mod/hide", { id, reason: "spam" })).error, "not_allowed");
  env.ADMIN_WALLETS = n.w.address;
  await reprove(n);
  const h = await n.post("/api/mod/hide", { id, reason: "off_topic", note: "wrong feed" });
  assert.equal(h.hidden, true);
  assert.ok(h.until, "one moderator's hide lasts 24 hours");
  assert.equal((await b.get("/api/posts?scope=city&kind=meme")).posts.length, 0);
  const own = (await a.get("/api/posts?scope=city&kind=meme")).posts[0];
  assert.equal(own.hidden, true, "the author still sees their hidden post");
  assert.equal(own.hideAction.reason, "off_topic", "and why, so they can appeal");
  assert.equal((await n.get("/api/mod")).moderator, true);
  assert.equal((await b.get("/api/mod")).moderator, false);
  assert.match(weekStart(Date.parse("2026-09-26T12:00:00Z")), /^2026-09-21T00:00:00/);
});

test("reports: five hide a post until a moderator reviews it; after launch only holders post", async () => {
  const author = await person(env, { home: IN_UTICA });
  const id = (await author.post("/api/posts", { scope: "city", kind: "talk", body: "spam spam" })).post.id;
  for (let i = 0; i < 5; i++) { const p = await person(env, { home: IN_UTICA }); await p.post("/api/posts/report", { id, reason: "spam" }); }
  const other = await person(env, { home: IN_UTICA });
  assert.equal((await other.get("/api/posts?scope=city&kind=talk")).posts.length, 0);
  const log = await (await other.send("/api/audit")).json();
  assert.equal(log.actions[0].by, "Community reports");

  launch();
  assert.equal((await other.post("/api/posts", { scope: "city", kind: "talk", body: "gm" })).error, "holders_only");
  setHolding(other.w.address, 10);
  assert.equal((await other.post("/api/posts", { scope: "city", kind: "talk", body: "gm" })).ok, true);
});

test("check-ins: only from inside your community, once a day; pictures are checked and served", async () => {
  const a = await person(env, { home: IN_UTICA });
  assert.equal((await a.post("/api/posts", { kind: "checkin", attestation: await attest(a, IN_NYC, "checkin") })).error, "not_in_city");
  const d = await a.post("/api/posts", { kind: "checkin", attestation: await attest(a, IN_UTICA, "checkin") });
  assert.equal(d.ok, true);
  assert.equal(d.post.body, "Checked in to Utica");
  assert.equal((await a.post("/api/posts", { kind: "checkin", attestation: await attest(a, IN_UTICA, "checkin") })).error, "checked_in_today");
  const n = await person(env, { home: IN_NYC });
  const nat = await n.get("/api/posts?scope=country&kind=checkin");
  assert.equal(nat.posts.length, 1, "the national tab shows every city's check-ins");
  assert.equal(nat.posts[0].where, "Utica");

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString("base64");
  const m = await a.post("/api/posts", { scope: "city", kind: "meme", body: "", image: png });
  assert.equal(m.ok, true);
  const img = await a.send(m.post.image);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal((await img.arrayBuffer()).byteLength, 48);
  assert.equal((await a.post("/api/posts", { scope: "city", kind: "meme", image: Buffer.from("<svg onload=alert(1)>").toString("base64") })).error, "bad_image");
});

test("add-my-town: you must be there, one at a time; the manager advises, an admin decides; no coordinates kept", async () => {
  const a = await person(env, { home: IN_UTICA });
  let d = await a.post("/api/towns", { name: "New Hartford", attestation: await attest(a, { lat: 43.07, lon: -75.29, accuracy: 20 }, "request") });
  assert.equal(d.ok, true);
  assert.equal(d.request.near, "inside Utica");
  assert.equal((await a.post("/api/towns", { name: "Whitesboro", attestation: await attest(a, IN_UTICA, "request") })).error, "one_at_a_time");
  const row = await env.DB.prepare("SELECT * FROM town_requests").first();
  assert.equal("lat" in row || "lon" in row, false, "no coordinates stored");

  const other = await person(env, { home: IN_NYC });
  await reprove(other);
  assert.equal((await other.post("/api/towns/decide", { id: d.request.id, decision: "approve" })).error, "not_allowed");
  env.ADMIN_WALLETS = other.w.address;
  await reprove(other);
  assert.equal((await other.get("/api/mod")).towns.length, 1);
  assert.equal((await other.post("/api/towns/decide", { id: d.request.id, decision: "approve", note: "Welcome!" })).status, "approved");
  assert.equal((await a.get("/api/towns")).requests[0].status, "approved");
});

test("public: member counts per community, live holder list and anyone's rank (nothing stored)", async () => {
  await person(env, { home: IN_UTICA }); await person(env, { home: IN_UTICA }); await person(env, { home: IN_NYC });
  const m = await browser(env).get("/api/members");
  assert.equal(m.members, 3);
  assert.deepEqual(m.communities[0], { id: "5142056", name: "Utica", country: "US", members: 2 });

  const x = await wallet(), y = await wallet();
  assert.equal((await browser(env).get(`/api/rank?address=${x.address}`)).launched, false);
  launch(); setHolding(x.address, 3_000_000); setHolding(y.address, 1_000);
  const h = await browser(env).get("/api/holders");
  assert.equal(h.full, true);
  assert.equal(h.total, 2);
  assert.equal(h.holders[0].owner, x.address);
  const r = await browser(env).get(`/api/rank?address=${y.address}`);
  assert.equal(r.rank, 2);
  assert.equal(r.next.gap, 2_999_000);
  assert.equal((await browser(env).get("/api/rank?address=nope")).error, "bad_address");
  const seats = await browser(env).get("/api/seats");
  assert.deepEqual([seats.seats, seats.windows], [[], []]);
});
