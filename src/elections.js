// src/elections.js: recovered from the code deployed on Cloudflare (Worker "vicinity-map", 2026-10-02).
// The original comments and formatting were lost in the bundle; the code is the deployed code, byte for byte after bundling.
import { json, readJson } from "./http.js";
import { DAY, POLICY, iso } from "./policy.js";
import { activeBan, amountsFor } from "./roles.js";
import { sha256hex } from "./blobs.js";
import { averages, dayOf, latestBalances } from "./ledger.js";
import { access, voterProblem } from "./access.js";
var M = POLICY.manager;
var F = POLICY.founder;
var clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
async function candidates(env, cc, now) {
  const db = env.DB;
  const seats = (await db.prepare(`SELECT s.*, u.handle, u.name FROM seats s JOIN users u ON u.id = s.user_id
    WHERE s.country = ? AND s.status = 'active' AND s.activated_at <= ?`).bind(cc, iso(now - M.minFounderDays * DAY)).all()).results;
  const lastTerm = await db.prepare("SELECT * FROM manager_terms WHERE country = ? AND status IN ('active', 'ended') ORDER BY starts_at DESC LIMIT 1").bind(cc).first();
  const out = [];
  for (const s of seats) {
    if (await activeBan(db, s.user_id, cc, now)) continue;
    if (lastTerm && lastTerm.user_id === s.user_id && lastTerm.consecutive >= M.maxConsecutiveTerms) continue;
    out.push(s);
  }
  return out;
}
async function advanceElections(env, now = Date.now(), fetchImpl = fetch) {
  const db = env.DB;
  const out = { opened: 0, decided: 0, started: 0, ended: 0 };
  const start = await db.prepare("UPDATE manager_terms SET status = 'active' WHERE status = 'upcoming' AND starts_at <= ?").bind(iso(now)).run();
  out.started = start.meta.changes || 0;
  const done = await db.prepare("UPDATE manager_terms SET status = 'ended', ended_reason = 'term_end' WHERE status = 'active' AND ends_at <= ?").bind(iso(now)).run();
  const lost = await db.prepare(`UPDATE manager_terms SET status = 'ended', ended_reason = 'lost_seat'
    WHERE status IN ('active', 'upcoming') AND seat_id IN (SELECT id FROM seats WHERE status IN ('released', 'revoked'))`).run();
  out.ended = (done.meta.changes || 0) + (lost.meta.changes || 0);
  for (const e of (await db.prepare("SELECT * FROM elections WHERE status = 'open' AND closes_at <= ?").bind(iso(now)).all()).results) {
    await decideElection(env, e, now, fetchImpl);
    out.decided++;
  }
  const countries = (await db.prepare("SELECT DISTINCT country FROM seats WHERE status = 'active'").all()).results.map((r) => r.country);
  for (const cc of countries) {
    if (await db.prepare("SELECT id FROM elections WHERE country = ? AND status = 'open'").bind(cc).first()) continue;
    const active = await db.prepare("SELECT * FROM manager_terms WHERE country = ? AND status = 'active'").bind(cc).first();
    const upcoming = await db.prepare("SELECT id FROM manager_terms WHERE country = ? AND status = 'upcoming'").bind(cc).first();
    const due = !upcoming && (!active || Date.parse(active.ends_at) - now <= M.electionDays * DAY);
    if (!due || !(await candidates(env, cc, now)).length) continue;
    try {
      await db.prepare("INSERT INTO elections (country, policy, opened_at, closes_at) VALUES (?, ?, ?, ?)").bind(cc, POLICY.version, iso(now), iso(now + M.electionDays * DAY)).run();
      out.opened++;
    } catch (err) {
      if (!/UNIQUE/i.test(String(err))) throw err;
    }
  }
  return out;
}
async function decideElection(env, e, now, fetchImpl) {
  const db = env.DB;
  const cands = await candidates(env, e.country, now);
  const votes = new Map((await db.prepare("SELECT seat_id, COUNT(*) AS n FROM election_votes WHERE election_id = ? GROUP BY seat_id").bind(e.id).all()).results.map((r) => [r.seat_id, r.n]));
  const totalVotes = cands.reduce((n, c) => n + (votes.get(c.id) || 0), 0);
  const latest = await latestBalances(env, now);
  const balances = latest ? latest.balances : Object.fromEntries(await amountsFor(env, cands.map((c) => c.wallet), fetchImpl));
  const avg = (await averages(env, dayOf(now), F.qualifyingDays, cands.map((c) => c.wallet))).averages;
  const scored = [];
  for (const c of cands) {
    const days = (now - Date.parse(c.activated_at)) / DAY;
    const mod = await db.prepare(`SELECT
        COUNT(CASE WHEN state IN ('confirmed', 'approved', 'done') THEN 1 END) AS good,
        COUNT(CASE WHEN state = 'overturned' THEN 1 END) AS bad
      FROM mod_actions WHERE actor_id = ?`).bind(c.user_id).first();
    const service = clamp(Math.min(days, 180) / 180 * 60 + Math.min(mod.good, 20) / 20 * 40 - mod.bad * 10);
    const T = c.threshold, cap = F.stakeCap * T;
    const basis = Math.min(balances[c.wallet] || 0, avg.get(c.wallet) || 0);
    const stake = cap > T ? clamp((Math.min(basis, cap) - T) / (cap - T) * 100) : 0;
    const vote = totalVotes ? (votes.get(c.id) || 0) / totalVotes * 100 : 0;
    const total = M.weights.vote * vote + M.weights.service * service + M.weights.stake * stake;
    scored.push({ c, votes: votes.get(c.id) || 0, vote, service, stake, total, tiebreak: await sha256hex(`vicinity-election|${e.id}|${c.wallet}`) });
  }
  scored.sort((p, q2) => q2.total - p.total || (p.tiebreak < q2.tiebreak ? -1 : 1));
  const win = scored[0];
  const result = {
    election: e.id,
    country: e.country,
    policy: e.policy,
    openedAt: e.opened_at,
    closedAt: e.closes_at,
    weights: M.weights,
    candidates: scored.map((s, i) => ({
      seat: s.c.id,
      name: s.c.handle || s.c.name || "Founder",
      city: s.c.city_name,
      votes: s.votes,
      scores: { vote: +s.vote.toFixed(4), service: +s.service.toFixed(4), stake: +s.stake.toFixed(4) },
      total: +s.total.toFixed(4),
      tiebreak: s.tiebreak,
      rank: i + 1
    })),
    winner: win ? win.c.id : null
  };
  const text = JSON.stringify(result);
  await db.prepare("UPDATE elections SET status = ?, decided_at = ?, result = ?, result_hash = ? WHERE id = ? AND status = 'open'").bind(win ? "decided" : "empty", iso(now), text, await sha256hex(text), e.id).run();
  if (!win) return result;
  const active = await db.prepare("SELECT * FROM manager_terms WHERE country = ? AND status = 'active'").bind(e.country).first();
  const startsAt = active ? Math.max(now, Date.parse(active.ends_at)) : now;
  const prev = active || await db.prepare("SELECT * FROM manager_terms WHERE country = ? AND status = 'ended' ORDER BY starts_at DESC LIMIT 1").bind(e.country).first();
  const back2back = prev && prev.user_id === win.c.user_id && Math.abs(Date.parse(prev.ends_at) - startsAt) < DAY;
  await db.prepare(`INSERT INTO manager_terms (country, seat_id, user_id, wallet, election_id, starts_at, ends_at, consecutive, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    e.country,
    win.c.id,
    win.c.user_id,
    win.c.wallet,
    e.id,
    iso(startsAt),
    iso(startsAt + M.termDays * DAY),
    back2back ? prev.consecutive + 1 : 1,
    startsAt <= now ? "active" : "upcoming"
  ).run();
  console.log("country manager elected", e.country, "election", e.id);
  return result;
}
async function handleElectionVote(request, env, now = Date.now()) {
  const a = await access(request, env, now, { fresh: true });
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  const e = body && await db.prepare("SELECT * FROM elections WHERE id = ?").bind(Number(body.electionId) || 0).first();
  if (!e || e.status !== "open" || Date.parse(e.closes_at) <= now) return json({ ok: false, error: "election_closed" }, 409);
  const cand = (await candidates(env, e.country, now)).find((c) => c.id === Number(body.seatId));
  if (!cand) return json({ ok: false, error: "not_a_candidate" }, 400);
  const why = await voterProblem(env, u, { scope: "country", place: e.country, openedAt: e.opened_at, now });
  if (why) return json({ ok: false, error: why }, 403);
  await db.prepare("INSERT INTO election_votes (election_id, user_id, seat_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (election_id, user_id) DO UPDATE SET seat_id = excluded.seat_id, created_at = excluded.created_at").bind(e.id, u.id, cand.id, iso(now)).run();
  return json({ ok: true, seatId: cand.id });
}
async function countryPicture(env, cc, viewer, now = Date.now()) {
  const db = env.DB;
  const term = await db.prepare(`SELECT t.*, u.handle, u.name, s.city_name, s.status AS seat_status FROM manager_terms t
    JOIN users u ON u.id = t.user_id JOIN seats s ON s.id = t.seat_id WHERE t.country = ? AND t.status = 'active'`).bind(cc).first();
  const e = await db.prepare("SELECT * FROM elections WHERE country = ? AND status = 'open'").bind(cc).first();
  let election = null;
  if (e) {
    const cands = await candidates(env, cc, now);
    const votes = new Map((await db.prepare("SELECT seat_id, COUNT(*) AS n FROM election_votes WHERE election_id = ? GROUP BY seat_id").bind(e.id).all()).results.map((r) => [r.seat_id, r.n]));
    const mine = viewer ? await db.prepare("SELECT seat_id FROM election_votes WHERE election_id = ? AND user_id = ?").bind(e.id, viewer.id).first() : null;
    const why = viewer ? await voterProblem(env, viewer, { scope: "country", place: cc, openedAt: e.opened_at, now }) : "sign_in";
    election = {
      id: e.id,
      openedAt: e.opened_at,
      closesAt: e.closes_at,
      myVote: mine ? mine.seat_id : null,
      canVote: !why,
      whyNot: why,
      candidates: cands.map((c) => ({ seatId: c.id, name: c.handle || c.name || "Founder", city: c.city_name, votes: votes.get(c.id) || 0, you: Boolean(viewer && c.user_id === viewer.id) }))
    };
  }
  return {
    manager: term ? {
      name: term.handle || term.name || "Manager",
      city: term.city_name,
      startsAt: term.starts_at,
      endsAt: term.ends_at,
      paused: term.seat_status !== "active",
      you: Boolean(viewer && term.user_id === viewer.id),
      term: term.consecutive
    } : null,
    election
  };
}
async function handleElectionResult(env, id) {
  const e = await env.DB.prepare("SELECT id, country, status, decided_at, result, result_hash FROM elections WHERE id = ?").bind(Number(id)).first();
  if (!e || !e.result) return json({ error: "not_found" }, 404);
  return json({ election: e.id, country: e.country, status: e.status, decidedAt: e.decided_at, hash: e.result_hash, result: JSON.parse(e.result) });
}
export { advanceElections, countryPicture, handleElectionResult, handleElectionVote };
