// Seed Steward and Squad Founding, end to end through the real API:
// the 48-hour steward grace, the challenge quorum, resigning, and squads pooling to the bar.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { DAY, HOUR, IN_UTICA, MINT, attest, newWorld, passTime, person, realClock, reprove, setHolding, tick, useClock } from "./helpers/world.js";

let env;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = newWorld({ VICINITY_MINT: MINT }); });
after(() => realClock());

async function localWith(holds, point = IN_UTICA) {
  const p = await person(env, { home: point, holds });
  const c = await p.post("/api/posts", { kind: "checkin", attestation: await attest(p, point, "checkin") });
  assert.equal(c.ok, true, JSON.stringify(c));
  return p;
}
const apply = async (p, point = IN_UTICA, pitch = "I love this city") => { await reprove(p); return p.post("/api/seats/apply", { attestation: await attest(p, point, "apply"), pitch }); };
const seatOf = (cityId) => env.DB.prepare("SELECT * FROM seats WHERE city_id = ? ORDER BY id DESC LIMIT 1").bind(cityId).first();

test("steward grace: a dip gives 48 hours to fix, not 7 days; unfixed, the seat is released", async () => {
  const a = await localWith(2_000_000);
  const c = await localWith(10);
  await tick(env); await passTime(env, 15 * DAY);
  assert.equal((await apply(a)).steward, true);

  // a post to moderate, then the steward sells: the live check before any founder power trips grace
  const post = (await c.post("/api/posts", { scope: "city", kind: "talk", body: "spam spam spam" })).post;
  setHolding(a.w.address, 10);
  await reprove(a);
  assert.equal((await a.post("/api/mod/hide", { id: post.id, reason: "spam" })).error, "in_grace");
  const s = await seatOf("5142056");
  assert.equal(s.status, "steward", "a steward stays a steward in grace");
  assert.ok(s.grace_until, "grace_until is set");
  assert.ok(Date.parse(s.grace_until) - Date.now() <= 48 * HOUR + 60_000, "48 hours, not 7 days");

  await passTime(env, 49 * HOUR);
  const r = await seatOf("5142056");
  assert.equal(r.status, "released");
  assert.equal(r.end_reason, "balance");
});

test("challenge without the quorum: fewer than 10 endorsements, the steward keeps the seat", async () => {
  const a = await localWith(2_000_000);
  const challenger = await localWith(2_000_000);
  const supporters = [];
  for (let i = 0; i < 5; i++) supporters.push(await localWith(10));
  await tick(env); await passTime(env, 15 * DAY);
  assert.equal((await apply(a)).steward, true);
  const rw = await apply(challenger);
  assert.equal(rw.challenge, true, JSON.stringify(rw));

  const w = await env.DB.prepare("SELECT id FROM windows WHERE city_id = '5142056' AND kind = 'steward_challenge'").first();
  const app = await env.DB.prepare("SELECT id FROM applications WHERE window_id = ? AND user_id != ?").bind(w.id, (await seatOf("5142056")).user_id).first();
  for (const s of supporters) { await reprove(s); assert.equal((await s.post("/api/seats/endorse", { applicationId: app.id })).ok, true); }

  await passTime(env, 73 * HOUR);
  const seat = await seatOf("5142056");
  assert.equal(seat.status, "steward", "5 endorsements don't reach the quorum of 10");
  assert.equal(seat.wallet, a.w.address);
  const pub = await (await supporters[0].send(`/api/seats/results/${w.id}`)).json();
  assert.equal(pub.result.decision, "challenge_quorum_not_met");
});

test("steward resigns: the bond releases and the city reopens for someone else", async () => {
  const a = await localWith(2_000_000);
  const b = await localWith(2_000_000);
  await tick(env); await passTime(env, 15 * DAY);
  assert.equal((await apply(a)).steward, true);

  await reprove(a);
  assert.equal((await a.post("/api/seats/resign", {})).ok, true);
  const r = await seatOf("5142056");
  assert.equal(r.status, "released");
  assert.equal(r.end_reason, "resigned");

  // the city is open again; someone else can claim it
  assert.equal((await apply(b)).steward, true);
  assert.equal((await seatOf("5142056")).wallet, b.w.address);
});

test("squad founding: three locals pool to the bar, one mints, all are co-founders", async () => {
  // Utica's bar is 180K: 3 × 70K clears it, none could do it alone
  const members = [];
  for (let i = 0; i < 3; i++) members.push(await localWith(70_000));
  await tick(env); await passTime(env, 15 * DAY);

  const [founder] = members;
  await reprove(founder);
  const created = await founder.post("/api/seats/squad/create", {});
  assert.equal(created.ok, true, JSON.stringify(created));
  const squadId = created.squad.id;
  for (const m of members.slice(1)) {
    await reprove(m);
    assert.equal((await m.post("/api/seats/squad/join", { squadId })).ok, true);
  }

  const readiness = await founder.get(`/api/seats/squad/${squadId}`);
  assert.equal(readiness.squad.ready, true, JSON.stringify(readiness.squad));
  assert.equal(readiness.squad.pooled, 210_000);
  assert.equal(readiness.squad.threshold, 180_000);

  const r = await (async () => { await reprove(founder); return founder.post("/api/seats/squad/apply", { squadId, pitch: "Utica together", attestation: await attest(founder, IN_UTICA, "apply") }); })();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.steward, true, "a lone qualified squad becomes Seed Steward at once");
  assert.equal(r.squad, squadId);

  const seat = await seatOf("5142056");
  assert.equal(seat.status, "steward");
  assert.equal(seat.wallet, founder.w.address, "the designated founder's wallet takes the seat");
  const cofounders = await env.DB.prepare("SELECT user_id FROM squad_members WHERE squad_id = ?").bind(squadId).all();
  assert.equal(cofounders.results.length, 3, "all three recorded as co-founders");
});

test("squad apply below the bar: 3 × 50K doesn't reach 180K", async () => {
  const members = [];
  for (let i = 0; i < 3; i++) members.push(await localWith(50_000));
  await tick(env); await passTime(env, 15 * DAY);
  const [founder] = members;
  await reprove(founder);
  const created = await founder.post("/api/seats/squad/create", {});
  const squadId = created.squad.id;
  for (const m of members.slice(1)) { await reprove(m); await m.post("/api/seats/squad/join", { squadId }); }

  const readiness = await founder.get(`/api/seats/squad/${squadId}`);
  assert.equal(readiness.squad.ready, false);
  assert.equal(readiness.squad.pooled, 150_000);

  await reprove(founder);
  const r = await founder.post("/api/seats/squad/apply", { squadId, pitch: "short", attestation: await attest(founder, IN_UTICA, "apply") });
  assert.equal(r.error, "below_threshold", JSON.stringify(r));
});

test("squad leave: the last one out disbands it", async () => {
  const a = await localWith(70_000);
  const b = await localWith(70_000);
  await tick(env); await passTime(env, 15 * DAY);
  await reprove(a);
  const squadId = (await a.post("/api/seats/squad/create", {})).squad.id;
  await reprove(b);
  assert.equal((await b.post("/api/seats/squad/join", { squadId })).ok, true);
  assert.equal((await b.post("/api/seats/squad/leave", { squadId })).ok, true);
  await reprove(a);
  assert.equal((await a.post("/api/seats/squad/leave", { squadId })).ok, true);
  const s = await env.DB.prepare("SELECT status FROM squads WHERE id = ?").bind(squadId).first();
  assert.equal(s.status, "disbanded");
});

test("steward quorum counts verified local HOLDERS: 49 empty accounts can't confirm a steward early", async () => {
  const a = await localWith(2_000_000);
  await tick(env); await passTime(env, 15 * DAY);
  assert.equal((await apply(a)).steward, true);

  // 49 more accounts that live in Utica and checked in (only holders can post), then sold everything
  const crowd = [];
  for (let i = 0; i < 49; i++) { const p = await localWith(1); setHolding(p.w.address, 0); crowd.push(p); }
  await passTime(env, 12 * HOUR);
  assert.equal((await seatOf("5142056")).status, "steward", "accounts that hold nothing don't count");
  const before = await a.get("/api/me");
  assert.deepEqual(before.community.seat.quorum, { have: 1, need: 50 }, "only the steward holds so far");

  // once they hold something, the quorum is real
  for (const p of crowd) setHolding(p.w.address, 1);
  await passTime(env, 12 * HOUR);
  const seat = await seatOf("5142056");
  assert.equal(seat.status, "active", "50 verified local holders confirm the steward");
  assert.equal(seat.probation_until, null);
});

test("a Seed Steward is a founder everywhere: role flags, badge, crown on posts, progress, quorum", async () => {
  const a = await localWith(2_000_000);
  await tick(env); await passTime(env, 15 * DAY);
  assert.equal((await apply(a)).steward, true);

  const me = await a.get("/api/me");
  assert.equal(me.level, "founder");
  assert.equal(me.roles.founder, true, "roles.founder agrees with level");
  assert.equal(me.roles.steward, true);
  assert.equal(me.roles.weight, 2, "same vote weight as /api/posts/vote gives a founder");
  const badge = me.badges.find((b) => b.id === "city_founder");
  assert.equal(badge.earned, true);
  assert.equal(badge.name, "Seed Steward");
  assert.equal(me.founder.seat.status, "steward");
  assert.ok(me.founder.seat.probationUntil);
  const steps = Object.fromEntries(me.progress.steps.map((s) => [s.id, s]));
  assert.equal(steps.apply.done && steps.chosen.done, true);
  assert.equal(steps.founder.done, false, "confirmed founder comes after probation");
  assert.match(steps.founder.detail, /^probation until /);
  assert.deepEqual(me.community.seat.quorum, { have: 1, need: 50 });

  const posted = await a.post("/api/posts", { scope: "city", kind: "talk", body: "Hello Utica" });
  assert.equal(posted.post.author.founder, "Utica", "the 👑 shows for a steward");
  assert.equal(posted.post.author.steward, true);
});

test("squads on the dashboard: you can start one, others see it to join, members see the readiness", async () => {
  const a = await localWith(70_000);
  const b = await localWith(70_000);
  await tick(env); await passTime(env, 15 * DAY);

  assert.deepEqual(await a.get("/api/me").then((m) => m.squad), { mine: null, joinable: null, canCreate: true });
  await reprove(a);
  const squadId = (await a.post("/api/seats/squad/create", {})).squad.id;

  const mineA = (await a.get("/api/me")).squad;
  assert.equal(mineA.mine.id, squadId);
  assert.equal(mineA.mine.members.length, 1);
  assert.equal(mineA.mine.ready, false);
  assert.equal(mineA.canCreate, false);

  const seenByB = (await b.get("/api/me")).squad;
  assert.equal(seenByB.mine, null);
  assert.equal(seenByB.joinable.id, squadId);
  assert.equal(seenByB.joinable.full, false);

  await reprove(b);
  assert.equal((await b.post("/api/seats/squad/join", { squadId })).ok, true);
  const both = (await b.get("/api/me")).squad.mine;
  assert.equal(both.members.length, 2);
  assert.equal(both.pooled, 140_000);
  assert.ok(both.members.every((m) => m.qualified));
});
