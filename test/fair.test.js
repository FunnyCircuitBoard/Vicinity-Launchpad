// The fair-launch rules, end to end through the real API, with time moving forward:
// qualifying time, application windows, endorsements, capped holdings, objections, grace, release,
// cooldown, elections, two-person moderation, and the Founding Supporter snapshot.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { DAY, HOUR, IN_NYC, IN_UTICA, MINT, POOL, advance, attest, clock, loginBody, newWorld, passTime, person, realClock, reprove, setHolding, tick, useClock, wallet } from "./helpers/world.js";
import { sha256hex } from "../src/blobs.js";
import { verifyProof } from "../src/snapshot.js";

let env;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = newWorld({ VICINITY_MINT: MINT }); });
after(() => realClock());

/** Verified locals who can vote: holding a little, checked in, account and home older than 7 days by the time it matters. */
async function locals(n, point = IN_UTICA) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = await person(env, { home: point, holds: 10 });
    const c = await p.post("/api/posts", { kind: "checkin", attestation: await attest(p, point, "checkin") });
    assert.equal(c.ok, true, JSON.stringify(c));
    out.push(p);
  }
  return out;
}
const apply = async (p, point = IN_UTICA, pitch = "I love this city") => { await reprove(p); return p.post("/api/seats/apply", { attestation: await attest(p, point, "apply"), pitch }); };
const endorse = async (p, applicationId) => { await reprove(p); return p.post("/api/seats/endorse", { applicationId }); };
const appId = async (env_, windowCity) => (await env_.DB.prepare("SELECT id, user_id, window_id, wallet FROM applications WHERE city_id = ? AND withdrawn = 0 ORDER BY id").bind(windowCity).all()).results;
const seatOf = (cityId) => env.DB.prepare("SELECT * FROM seats WHERE city_id = ? ORDER BY id DESC LIMIT 1").bind(cityId).first();

test("qualifying: 7 days of holding in every sample, home set 7 days before — borrowed tokens can't found a city", async () => {
  const a = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  await tick(env);
  let r = await apply(a);
  assert.equal(r.error, "home_too_new");
  await passTime(env, 8 * DAY);

  // one sample below the line restarts the clock (Utica's bar is 180K on the ladder)
  setHolding(a.w.address, 179_999); advance(10 * 60_000); await tick(env);
  setHolding(a.w.address, 2_000_000); await passTime(env, 4 * DAY);
  r = await apply(a);
  assert.equal(r.error, "not_qualified", "the dip restarted the 7 days");
  assert.ok(r.tenure.days >= 3.5 && r.tenure.days < 5, JSON.stringify(r.tenure));
  await passTime(env, 4 * DAY);

  // a flash-buy right now doesn't help someone who didn't hold before
  const flash = await person(env, { home: IN_UTICA, holds: 0 });
  await passTime(env, 8 * DAY);
  setHolding(flash.w.address, 50_000_000); advance(10 * 60_000); await tick(env);
  assert.equal((await apply(flash)).error, "not_qualified");

  // sensitive: needs the wallet proven in the last 30 minutes, and the attestation must be for this purpose and city
  await a.post("/api/auth/wallet", await loginBody(a.w)); // signed in again (the test spans days)
  advance(HOUR);
  assert.equal((await a.post("/api/seats/apply", { attestation: await attest(a, IN_UTICA, "apply") })).error, "reprove");
  await reprove(a);
  assert.equal((await a.post("/api/seats/apply", { attestation: await attest(a, IN_UTICA, "checkin") })).error, "location_required", "wrong purpose");
  assert.equal((await a.post("/api/seats/apply", { attestation: await attest(a, IN_NYC, "apply") })).error, "not_in_city");
  const att = await attest(a, IN_UTICA, "apply");
  r = await a.post("/api/seats/apply", { attestation: att, pitch: "Let's go Utica" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.steward, true, "a lone qualified claimer becomes Seed Steward at once");
  assert.equal(r.seat.probationUntil, new Date(clock.now + 90 * DAY).toISOString());
  assert.equal((await seatOf("5142056")).status, "steward");
  assert.equal((await a.post("/api/seats/apply", { attestation: att })).error, "has_seat");
});

test("steward → challenge: 10 local endorsements force an election; a whale's extra tokens are capped", async () => {
  const [a, whale] = [await person(env, { home: IN_UTICA, holds: 2_000_000 }), await person(env, { home: IN_UTICA, holds: 100_000_000 })];
  const supporters = await locals(21);
  const n = (await locals(1, IN_NYC))[0];
  await tick(env);
  await passTime(env, 15 * DAY);
  for (const p of [a, whale]) {
    const c = await p.post("/api/posts", { kind: "checkin", attestation: await attest(p, IN_UTICA, "checkin") });
    assert.equal(c.ok, true, JSON.stringify(c));
  }

  // the first qualified claimer becomes Seed Steward at once — being first wins nothing final
  const ra = await apply(a);
  assert.equal(ra.ok, true, JSON.stringify(ra));
  assert.equal(ra.steward, true);
  assert.equal((await seatOf("5142056")).status, "steward");

  // a verified local challenger opens a 72-hour challenge window; the steward is entered to defend
  const rw = await apply(whale);
  assert.equal(rw.ok, true, JSON.stringify(rw));
  assert.equal(rw.challenge, true);
  const apps = await appId(env, "5142056");
  const chw = await env.DB.prepare("SELECT id FROM windows WHERE city_id = '5142056' AND kind = 'steward_challenge'").first();
  const chApps = apps.filter((x) => x.window_id === chw.id);
  assert.equal(chApps.length, 2, "steward auto-entered plus the challenger");
  const appA = chApps.find((x) => x.wallet === a.w.address);
  const appW = chApps.find((x) => x.wallet === whale.w.address);
  assert.equal((await endorse(n, appW.id)).error, "not_local");

  // 10 endorsements force the election; the rest decide it — locals overrule the whale
  for (let i = 0; i < 10; i++) assert.equal((await endorse(supporters[i], appW.id)).ok, true);
  for (let i = 10; i < 21; i++) assert.equal((await endorse(supporters[i], appA.id)).ok, true);
  assert.equal((await endorse(a, appW.id)).error, "applicants_cant_endorse");

  const view = await supporters[20].get("/api/me");
  assert.equal(view.community.window.applicants.length, 2);

  await passTime(env, 73 * HOUR);
  const seat = await seatOf("5142056");
  assert.equal(seat.user_id, appA.user_id, "11 local endorsements beat 10, even against 50× the tokens");
  assert.equal(seat.status, "steward", "the steward keeps the seat and the probation");

  // the full result is published, and its hash checks out
  const w = await env.DB.prepare("SELECT id FROM windows WHERE city_id = '5142056' AND kind = 'steward_challenge'").first();
  const pub = await (await supporters[0].send(`/api/seats/results/${w.id}`)).json();
  assert.equal(await sha256hex(JSON.stringify(pub.result)), pub.hash);
  assert.equal(pub.result.decision, "steward_wins_election");
  const [sa, sw] = pub.result.applicants;
  assert.equal(sa.scores.stake, sw.scores.stake, "holdings count only up to 2× the founder amount");
  assert.ok(sa.total > sw.total);
  assert.equal(sa.wallet.includes("*****"), true, "applicant wallets are masked");

  await passTime(env, 90 * DAY);
  assert.equal((await seatOf("5142056")).status, "active", "90 days of good behavior confirms the steward");
  await reprove(a); // the test spans 100+ days: sign in again
  assert.equal((await a.get("/api/me")).level, "founder");
});

test("objections: an admin who didn't object decides; upheld passes the seat to the runner-up", async () => {
  const [a, b] = [await person(env, { home: IN_UTICA, holds: 2_000_000 }), await person(env, { home: IN_UTICA, holds: 1_500_000 })];
  const supporters = await locals(11);
  const [c, d] = supporters;
  const admin = await person(env, { home: IN_NYC });
  env.ADMIN_WALLETS = admin.w.address;
  await tick(env); await passTime(env, 15 * DAY);
  for (const p of [a, b]) {
    const ck = await p.post("/api/posts", { kind: "checkin", attestation: await attest(p, IN_UTICA, "checkin") });
    assert.equal(ck.ok, true, JSON.stringify(ck));
  }
  assert.equal((await apply(a)).steward, true);
  const rb = await apply(b);
  assert.equal(rb.challenge, true, JSON.stringify(rb));
  const apps = await appId(env, "5142056");
  const appB = apps.find((x) => x.wallet === b.w.address);
  assert.ok(appB, "the challenger is in the window");
  for (const s of supporters) assert.equal((await endorse(s, appB.id)).ok, true);
  await passTime(env, 73 * HOUR);
  let seat = await seatOf("5142056");
  assert.equal(seat.wallet, b.w.address, "the challenger won the election");
  assert.equal(seat.status, "provisional");

  assert.equal((await d.post("/api/seats/object", { seatId: seat.id, reason: "short" })).error, "reason_required");
  assert.equal((await d.post("/api/seats/object", { seatId: seat.id, reason: "They don't live here, I've never seen them" })).ok, true);
  await passTime(env, 49 * HOUR);
  assert.equal((await seatOf("5142056")).status, "provisional", "an open objection holds the seat back");

  const o = await env.DB.prepare("SELECT id FROM objections").first();
  assert.equal((await c.post("/api/seats/objections/decide", { id: o.id, uphold: true })).error, "reprove");
  await reprove(c);
  assert.equal((await c.post("/api/seats/objections/decide", { id: o.id, uphold: true })).error, "not_allowed");
  await reprove(admin);
  const r = await admin.post("/api/seats/objections/decide", { id: o.id, uphold: true, note: "confirmed not local" });
  assert.equal(r.nextApplicant, true);
  seat = await seatOf("5142056");
  assert.equal(seat.status, "provisional");
  assert.equal(seat.wallet, a.w.address, "the runner-up (the former steward)");
  const revoked = await env.DB.prepare("SELECT * FROM seats WHERE status = 'revoked'").first();
  assert.equal(revoked.wallet, b.w.address);
  const audit = await (await admin.send("/api/audit")).json();
  assert.equal(audit.actions[0].action, "revoke_seat");
  assert.equal((await apply(b)).error, "cooldown", "the ousted founder waits 30 days before applying again");
});

test("grace: selling pauses powers at once, 7 days to fix it, then the seat reopens; too many graces release it", async () => {
  const a = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  const [c] = await locals(1);
  await tick(env); await passTime(env, 15 * DAY);
  assert.equal((await apply(a)).steward, true);
  await passTime(env, 91 * DAY); // steward confirmed after 90 days of good behavior
  assert.equal((await seatOf("5142056")).status, "active");

  // a post to moderate
  await reprove(c); // the 91 days outlasted the 30-day session
  const post = (await c.post("/api/posts", { scope: "city", kind: "talk", body: "spam spam spam" })).post;
  setHolding(a.w.address, 10);  // sells; no sample yet
  await reprove(a);
  assert.equal((await a.post("/api/mod/hide", { id: post.id, reason: "spam" })).error, "in_grace", "checked live before any power is used");
  assert.equal((await seatOf("5142056")).status, "grace");
  assert.equal((await a.get("/api/me")).level, "holder", "no founder powers in grace");

  setHolding(a.w.address, 2_000_000); await passTime(env, 1 * DAY);
  assert.equal((await seatOf("5142056")).status, "active", "fixed within 7 days");

  setHolding(a.w.address, 10); await passTime(env, 1 * DAY);
  assert.equal((await seatOf("5142056")).status, "grace");
  setHolding(a.w.address, 2_000_000); await passTime(env, 1 * DAY);
  setHolding(a.w.address, 10); await passTime(env, 1 * DAY);
  const s = await seatOf("5142056");
  assert.equal(s.status, "released", "a third grace within 90 days releases the seat");
  assert.equal(s.end_reason, "repeated_grace");

  // the city is open again for others; the former founder waits 30 days
  setHolding(a.w.address, 2_000_000); await passTime(env, 15 * DAY);
  assert.equal((await apply(a)).error, "cooldown", "30 days before applying anywhere again");
});

test("grace that isn't fixed: released after 7 days; home can't be changed while holding a seat", async () => {
  const a = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  await tick(env); await passTime(env, 15 * DAY);
  assert.equal((await apply(a)).steward, true);
  await passTime(env, 91 * DAY); // steward confirmed after 90 days
  await reprove(a); // the 91 days outlasted the 30-day session
  assert.equal((await a.post("/api/home", { attestation: await attest(a, IN_NYC, "home") })).error, "founder_home_locked");
  await passTime(env, 5 * DAY);
  setHolding(a.w.address, 100); await passTime(env, 6 * DAY);
  assert.equal((await seatOf("5142056")).status, "grace");
  await passTime(env, 2 * DAY);
  assert.equal((await seatOf("5142056")).status, "released");
  assert.equal((await seatOf("5142056")).end_reason, "balance");
});

test("country manager: elected for 90 days by locals, not handed to the richest founder", async () => {
  const [u1, n1] = [await person(env, { home: IN_UTICA, holds: 2_000_000 }), await person(env, { home: IN_NYC, holds: 90_000_000 })];
  const voters = [...(await locals(2)), ...(await locals(1, IN_NYC))];
  await tick(env); await passTime(env, 15 * DAY);
  await apply(u1); await apply(n1, IN_NYC);
  await passTime(env, 91 * DAY); // stewards confirmed after 90 days of good behavior
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM seats WHERE status = 'active'").first()).n, 2);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM elections").first()).n, 0, "candidates need 30 days as founder");

  await passTime(env, 31 * DAY, 12 * HOUR);
  const e = await env.DB.prepare("SELECT * FROM elections WHERE status = 'open'").first();
  assert.ok(e, "an election opened");
  const uSeat = await env.DB.prepare("SELECT s.id FROM seats s JOIN users u ON u.id = s.user_id WHERE u.wallet = ? AND s.status = 'active'").bind(u1.w.address).first();
  for (const v of voters) { await reprove(v); assert.equal((await v.post("/api/elections/vote", { electionId: e.id, seatId: uSeat.id })).ok, true); }
  await passTime(env, 8 * DAY, 12 * HOUR);
  const term = await env.DB.prepare("SELECT * FROM manager_terms WHERE status = 'active'").first();
  assert.equal(term.seat_id, uSeat.id, "3 votes beat 45× the tokens");
  assert.equal(Math.round((Date.parse(term.ends_at) - Date.parse(term.starts_at)) / DAY), 90);
  await reprove(u1); // the test spans 60+ days: sign in again
  const me = await u1.get("/api/me");
  assert.equal(me.level, "manager");
  assert.equal(me.national.manager.you, true);
  const mod = await (await u1.send("/api/moderator?country=US")).json();
  assert.equal(mod.manager.city, "Utica");
});

test("moderation: hides expire unless a second person (or 3 reports) confirms; bans need two people; appeals", async () => {
  const [author, r1, r2, r3] = await locals(4);
  const [admin1, admin2] = [await person(env, { home: IN_NYC }), await person(env, { home: IN_NYC })];
  env.ADMIN_WALLETS = `${admin1.w.address},${admin2.w.address}`;
  const post = (await author.post("/api/posts", { scope: "city", kind: "talk", body: "buy my thing" })).post;

  await reprove(admin1);
  assert.equal((await admin1.post("/api/mod/hide", { id: post.id })).error, "reason_required");
  let r = await admin1.post("/api/mod/hide", { id: post.id, reason: "spam", note: "ad" });
  assert.equal(r.confirmed, false);
  assert.equal((await admin1.post("/api/mod/hide", { id: post.id, reason: "spam" })).error, "needs_second_moderator");
  advance(25 * HOUR); await tick(env, { sample: false });
  assert.equal((await env.DB.prepare("SELECT hidden FROM posts WHERE id = ?").bind(post.id).first()).hidden, 0, "back after 24 h: one person isn't enough");

  await reprove(admin1);
  await admin1.post("/api/mod/hide", { id: post.id, reason: "spam" });
  for (const p of [r1, r2, r3]) await p.post("/api/posts/report", { id: post.id, reason: "spam" });
  advance(25 * HOUR); await tick(env, { sample: false });
  assert.equal((await env.DB.prepare("SELECT hidden, hide_confirmed FROM posts WHERE id = ?").bind(post.id).first()).hide_confirmed, 1, "3 reports confirmed it");

  // bans: proposed by one, approved by another, 30 days, appealable
  await reprove(admin1);
  const prop = await admin1.post("/api/mod/ban", { postId: post.id, reason: "scam" });
  assert.equal(prop.proposed, true);
  assert.equal((await admin1.post("/api/mod/ban/approve", { actionId: prop.actionId })).error, "needs_second_moderator");
  assert.equal((await author.post("/api/posts", { scope: "city", kind: "talk", body: "still here" })).ok, true, "not banned by one person");
  await reprove(admin2);
  r = await admin2.post("/api/mod/ban/approve", { actionId: prop.actionId });
  assert.equal(r.banned, true);
  assert.equal(Math.round((Date.parse(r.until) - clock.now) / DAY), 30);
  assert.equal((await author.post("/api/posts", { scope: "city", kind: "talk", body: "hello?" })).error, "banned");
  assert.equal((await author.get("/api/me")).ban.actionId, prop.actionId);

  assert.equal((await author.post("/api/appeals", { actionId: prop.actionId, text: "I was selling my own art, not a scam" })).ok, true);
  await reprove(admin2);
  assert.equal((await admin2.post("/api/appeals/decide", { id: 1, overturn: true })).error, "not_allowed", "the approver can't judge their own ban");
  const third = await person(env, { home: IN_NYC });
  env.ADMIN_WALLETS += `,${third.w.address}`;
  await reprove(third);
  assert.equal((await third.post("/api/appeals/decide", { id: 1, overturn: true, note: "fair point" })).status, "overturned");
  assert.equal((await author.post("/api/posts", { scope: "city", kind: "talk", body: "thanks!" })).ok, true);

  const log = await (await third.send("/api/audit?country=US")).json();
  const kinds = log.actions.map((x) => x.action);
  for (const k of ["hide", "ban", "overturn"]) assert.ok(kinds.includes(k), k);
});

test("Founding Supporters: the lower of the cutoff balance and the 14-day average; pools out; Merkle proofs", async () => {
  const [steady, late, seller] = [await wallet(), await wallet(), await wallet()];
  setHolding(steady.address, 1_000); setHolding(seller.address, 1_000); setHolding(POOL, 500_000_000);
  useClock("2026-10-01T00:00:00Z");
  env.SNAPSHOT_CUTOFF = "2026-10-16T00:00:00Z";
  await passTime(env, 14 * DAY, 6 * HOUR);
  setHolding(late.address, 50_000);          // buys the day before the cutoff
  setHolding(seller.address, 10);            // sells the day before
  await passTime(env, 1 * DAY, 6 * HOUR);
  advance(20 * 60_000); await tick(env);     // past the cutoff: computed
  const list = await (await (await person(env)).send("/api/snapshots")).json();
  const snap = list.snapshots[0];
  assert.equal(snap.status, "provisional");
  const data = await (await (await person(env)).send(`/api/snapshots/${snap.id}/data`)).json();
  const amount = (w) => (data.rows.find((r) => r[0] === w) || [null, 0])[1] / 1e6;
  assert.ok(Math.abs(amount(steady.address) - 1_000) < 1e-6, "steady holder keeps everything");
  assert.ok(amount(late.address) < 50_000 * 0.2, "a last-minute buy counts only its share of the 14 days");
  assert.equal(amount(seller.address), 10, "selling before the cutoff counts");
  assert.equal(amount(POOL), 0, "pools are excluded");

  const proof = await (await (await person(env)).send(`/api/snapshots/${snap.id}/proof?wallet=${steady.address}`)).json();
  assert.equal(proof.verified, true);
  assert.equal(await verifyProof(proof.leaf, proof.proof, snap.merkleRoot), true);
  assert.equal(await verifyProof(proof.leaf, proof.proof, "00".repeat(32)), false);
  advance(49 * HOUR); await tick(env, { sample: false });
  assert.equal((await (await (await person(env)).send("/api/snapshots")).json()).snapshots[0].status, "active", "final after the 48-hour challenge period");
});

test("location attestations: signed, single-use, bound to one person and purpose, never the coordinates", async () => {
  const a = await person(env, { home: IN_UTICA, holds: 5 });
  const b = await person(env, { home: IN_UTICA, holds: 5 });
  const res = await a.post("/api/locate", { location: IN_UTICA, purpose: "checkin", country: "US" });
  assert.equal(res.city.name, "Utica");
  assert.equal(JSON.stringify(res).includes("43.1"), false, "no coordinates in the answer");
  const decoded = Buffer.from(res.attestation.split(".")[0], "base64url").toString();
  assert.equal(decoded.includes("43.1") || decoded.includes("-75.23"), false, "no coordinates inside the attestation");
  assert.equal((await b.post("/api/posts", { kind: "checkin", attestation: res.attestation })).error, "location_required", "someone else's");
  const [body, sig] = res.attestation.split(".");
  const forged = Buffer.from(body, "base64url").toString().replace('"purpose":"checkin"', '"purpose":"apply"');
  assert.equal((await a.post("/api/posts", { kind: "checkin", attestation: `${Buffer.from(forged).toString("base64url")}.${sig}` })).error, "location_required", "tampered");
  assert.equal((await a.post("/api/posts", { kind: "checkin", attestation: res.attestation })).ok, true);
  advance(DAY);
  assert.equal((await a.post("/api/posts", { kind: "checkin", attestation: res.attestation })).error, "location_expired", "used, and old");
  const late = await attest(a, IN_UTICA, "checkin");
  advance(6 * 60_000);
  assert.equal((await a.post("/api/posts", { kind: "checkin", attestation: late })).error, "location_expired", "5 minutes");
  // risk signals all look the same from outside
  assert.equal((await a.post("/api/locate", { location: { ...IN_UTICA, accuracy: 50_000 }, purpose: "checkin", country: "US" })).error, "location_unverified");
});

test("re-proving: signing in with X / Google alone can't do sensitive things; only your own wallet re-proves", async () => {
  const a = await person(env, { home: IN_UTICA });
  const other = await wallet();
  assert.equal((await a.post("/api/auth/reprove", await loginBody(other))).error, "wrong_wallet");
  assert.equal((await a.post("/api/auth/reprove", await loginBody(a.w))).ok, true);
  assert.equal((await a.get("/api/me?lite=1")).fresh, true);
  advance(31 * 60_000);
  assert.equal((await a.get("/api/me?lite=1")).fresh, false);
});
