/**
 * City founders: fair, stable, and never for sale in a minute.
 *
 *   1. Qualify   hold the city's founder amount in EVERY balance sample for 14 days (src/ledger.js),
 *                with a home community set 7+ days ago. No seat can be bought with borrowed tokens.
 *   2. Apply     standing in the city (a location attestation). The first application opens a 72-hour
 *                window for that city; being first gives no advantage, so there's nothing to race for.
 *   3. Endorse   verified locals (one person, one endorsement) back the applicant they want.
 *   4. Select    when the window closes, everyone is scored by the published formula:
 *                  50% local endorsements · 30% contribution · 20% holdings (capped at 2× the amount)
 *                ties broken by a public hash. The full result and its hash are published.
 *   5. Object    48 hours for locals to object (fraud, not local). An admin reviews objections;
 *                an upheld objection passes the seat to the next applicant.
 *   6. Active    founder rights on. Holdings are re-checked at every sample and before every
 *                sensitive action.
 *   7. Grace     below the amount → 7 days to fix it; moderation powers pause at once. More than
 *                2 graces in 90 days → the seat is released.
 *   8. Released  the city reopens; the former founder waits 30 days before applying anywhere.
 *
 * The database allows only one live seat per city and per person, and one open window per city,
 * so two people can never both win, even at the same millisecond.
 */
import { json, readJson } from "./http.js";
import { access, voterProblem, hoursFrom } from "./access.js";
import { useAttestation } from "./attest.js";
import { DAY, POLICY, founderAmount, iso } from "./policy.js";
import { averages, dayOf, latestBalances, tenure } from "./ledger.js";
import { LIVE, activeBan, adminWallets, amountsFor, liveSeatOfCity, liveSeatOfUser } from "./roles.js";
import { activeMint } from "./official.js";
import { countryCities } from "./cities.js";
import { sha256hex } from "./blobs.js";
import { HAS_ADDRESS, cleanText } from "./text.js";

const F = POLICY.founder;
const mask = (w) => (w ? `${w.slice(0, 5)}*****${w.slice(-3)}` : null);
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));

/** A community's population (for the founder amount tier). */
async function populationOf(env, cc, cityId) {
  const list = await countryCities(env, cc).catch(() => null);
  const c = list && list.find((x) => x.id === String(cityId));
  return c ? c.pop || 0 : 0;
}
export const thresholdFor = async (env, cc, cityId) => founderAmount(await populationOf(env, cc, cityId));

/** When may this person apply again after losing a seat? (iso or null) */
export async function cooldownUntil(db, userId, now) {
  const r = await db.prepare("SELECT MAX(ended_at) AS t FROM seats WHERE user_id = ? AND status IN ('released', 'revoked')").bind(userId).first();
  if (!r || !r.t) return null;
  const until = Date.parse(r.t) + F.cooldownDays * DAY;
  return until > now ? iso(until) : null;
}

const openApplicationOf = (db, userId) =>
  db.prepare("SELECT a.*, w.closes_at FROM applications a JOIN windows w ON w.id = a.window_id WHERE a.user_id = ? AND a.withdrawn = 0 AND w.status = 'open'").bind(userId).first();

/**
 * Can this person apply for their home community right now?
 * { ok, error?, threshold, tenure, amount, cooldownUntil, homeReadyAt }
 */
export async function eligibility(env, u, now = Date.now(), fetchImpl = fetch) {
  const db = env.DB;
  // homeReadyAt is known before launch too, so the dashboard can tick "home set 7 days" early.
  const homeReadyAt = u.home_city && u.home_at ? iso(Date.parse(u.home_at) + F.localDays * DAY) : null;
  const out = { ok: false, threshold: null, tenure: null, amount: 0, cooldownUntil: null, homeReadyAt };
  if (!activeMint(env)) return { ...out, error: "not_launched" };
  if (!u.home_city) return { ...out, error: "no_home" };
  out.threshold = await thresholdFor(env, u.home_country, u.home_city);
  out.tenure = await tenure(env, u.wallet, out.threshold, now);
  out.amount = (await amountsFor(env, [u.wallet], fetchImpl)).get(u.wallet) || 0;
  out.cooldownUntil = await cooldownUntil(db, u.id, now);
  if (Date.parse(out.homeReadyAt) > now) return { ...out, error: "home_too_new" };
  if (await liveSeatOfUser(db, u.id)) return { ...out, error: "has_seat" };
  if (await openApplicationOf(db, u.id)) return { ...out, error: "already_applied" };
  if (out.cooldownUntil) return { ...out, error: "cooldown" };
  if (await liveSeatOfCity(db, u.home_city)) return { ...out, error: "city_taken" };
  if (await activeBan(db, u.id, u.home_country, now)) return { ...out, error: "banned" };
  if (!out.tenure.qualified) return { ...out, error: "not_qualified" };
  if (out.amount < out.threshold) return { ...out, error: "below_threshold" };
  return { ...out, ok: true };
}

/** The open window for a city (creating it if needed). Closes an expired one first. */
async function openWindow(env, city, now, fetchImpl) {
  const db = env.DB;
  let w = await db.prepare("SELECT * FROM windows WHERE city_id = ? AND status = 'open'").bind(city.id).first();
  if (w && Date.parse(w.closes_at) <= now) { await closeWindow(env, w, now, fetchImpl); w = null; }
  if (w) return w;
  if (await liveSeatOfCity(db, city.id)) return null;
  try {
    await db.prepare("INSERT INTO windows (city_id, city_name, country, policy, threshold, opened_at, closes_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(city.id, city.name, city.country, POLICY.version, city.threshold, iso(now), hoursFrom(now, F.windowHours)).run();
  } catch (e) { if (!/UNIQUE/i.test(String(e))) throw e; } // someone opened it at the same moment: use theirs
  return db.prepare("SELECT * FROM windows WHERE city_id = ? AND status = 'open'").bind(city.id).first();
}

/** POST /api/seats/apply { attestation, pitch } — apply to found your home community. */
export async function handleApply(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await access(request, env, now, { fresh: true });
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const e = await eligibility(env, u, now, fetchImpl);
  if (!e.ok) return json({ ok: false, error: e.error, tenure: e.tenure, threshold: e.threshold, cooldownUntil: e.cooldownUntil, homeReadyAt: e.homeReadyAt }, 403);
  const pitch = cleanText(body.pitch, 280);
  if (pitch == null) return json({ ok: false, error: "too_long", max: 280 }, 400);
  if (HAS_ADDRESS.test(pitch)) return json({ ok: false, error: "no_addresses" }, 400);
  const at = await useAttestation(env, body.attestation, { userId: u.id, purpose: "apply", now });
  if (!at.ok) return json({ ok: false, error: at.error }, 400);
  if (at.att.city !== u.home_city) return json({ ok: false, error: "not_in_city", here: at.att.cityName || null }, 403);

  const w = await openWindow(env, { id: u.home_city, name: u.home_name, country: u.home_country, threshold: e.threshold }, now, fetchImpl);
  if (!w) return json({ ok: false, error: "city_taken" }, 409);
  try {
    await db.prepare("INSERT INTO applications (window_id, city_id, user_id, wallet, pitch, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(w.id, w.city_id, u.id, u.wallet, pitch || null, iso(now)).run();
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return json({ ok: false, error: "already_applied" }, 409);
    throw err;
  }
  console.log("founder application", w.city_id, "window", w.id);
  return json({ ok: true, window: { id: w.id, cityId: w.city_id, closesAt: w.closes_at } });
}

/** POST /api/seats/withdraw — take back your application while the window is open. */
export async function handleWithdraw(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const app = await openApplicationOf(env.DB, a.u.id);
  if (!app) return json({ ok: false, error: "not_found" }, 404);
  await env.DB.batch([
    env.DB.prepare("UPDATE applications SET withdrawn = 1 WHERE id = ?").bind(app.id),
    env.DB.prepare("DELETE FROM endorsements WHERE application_id = ?").bind(app.id),
  ]);
  return json({ ok: true });
}

/** POST /api/seats/endorse { applicationId } — one endorsement per verified local per window (can be changed). */
export async function handleEndorse(request, env, now = Date.now()) {
  const a = await access(request, env, now, { fresh: true });
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  const app = body && await db.prepare("SELECT * FROM applications WHERE id = ? AND withdrawn = 0").bind(Number(body.applicationId) || 0).first();
  if (!app) return json({ ok: false, error: "not_found" }, 404);
  const w = await db.prepare("SELECT * FROM windows WHERE id = ?").bind(app.window_id).first();
  if (!w || w.status !== "open" || Date.parse(w.closes_at) <= now) return json({ ok: false, error: "window_closed" }, 409);
  if (app.user_id === u.id) return json({ ok: false, error: "own_application" }, 400);
  if (await db.prepare("SELECT id FROM applications WHERE window_id = ? AND user_id = ? AND withdrawn = 0").bind(w.id, u.id).first()) {
    return json({ ok: false, error: "applicants_cant_endorse" }, 403);
  }
  const why = await voterProblem(env, u, { scope: "city", place: w.city_id, openedAt: w.opened_at, now });
  if (why) return json({ ok: false, error: why }, 403);
  await db.prepare("INSERT INTO endorsements (window_id, user_id, application_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (window_id, user_id) DO UPDATE SET application_id = excluded.application_id, created_at = excluded.created_at")
    .bind(w.id, u.id, app.id, iso(now)).run();
  return json({ ok: true, applicationId: app.id });
}

/* ---------------- choosing the founder ---------------- */

/**
 * Close a window: check every applicant again, score them with the published formula, and give the
 * winner a provisional seat. The whole result (and a hash of it) is stored for anyone to re-check.
 */
export async function closeWindow(env, w, now = Date.now(), fetchImpl = fetch) {
  const db = env.DB;
  const apps = (await db.prepare("SELECT a.*, u.handle, u.name, u.home_city, u.created_at AS joined, u.home_country FROM applications a JOIN users u ON u.id = a.user_id WHERE a.window_id = ? AND a.withdrawn = 0 ORDER BY a.id").bind(w.id).all()).results;
  const latest = await latestBalances(env, now);
  const balances = latest ? latest.balances : Object.fromEntries(await amountsFor(env, apps.map((x) => x.wallet), fetchImpl));
  const endorse = new Map((await db.prepare("SELECT application_id, COUNT(*) AS n FROM endorsements WHERE window_id = ? GROUP BY application_id").bind(w.id).all()).results.map((r) => [r.application_id, r.n]));
  const avg = (await averages(env, dayOf(now), F.qualifyingDays, apps.map((x) => x.wallet))).averages;
  const T = w.threshold, cap = F.stakeCap * T;

  const scored = [];
  for (const x of apps) {
    let why = null;
    if (x.home_city !== w.city_id) why = "moved_away";
    else if (await liveSeatOfUser(db, x.user_id)) why = "has_seat";
    else if (await activeBan(db, x.user_id, w.country, now)) why = "banned";
    else if (!(await tenure(env, x.wallet, T, now)).qualified) why = "not_qualified";
    else if ((balances[x.wallet] || 0) < T) why = "below_threshold";
    const joinedDays = Math.max(0, (Date.parse(w.opened_at) - Date.parse(x.joined)) / DAY);
    const act = await db.prepare(`SELECT
        COUNT(DISTINCT CASE WHEN kind = 'checkin' AND place = ? THEN substr(created_at, 1, 10) END) AS checkins,
        COUNT(CASE WHEN kind <> 'checkin' THEN 1 END) AS posts
      FROM posts WHERE user_id = ? AND hidden = 0 AND created_at < ?`).bind(w.city_id, x.user_id, w.closes_at).first();
    const good = await db.prepare("SELECT COUNT(*) AS n FROM reports r JOIN posts p ON p.id = r.post_id WHERE r.user_id = ? AND p.hidden = 1 AND p.hide_confirmed = 1").bind(x.user_id).first();
    const contrib = (Math.min(joinedDays, 60) / 60) * 40 + (Math.min(act.checkins, 20) / 20) * 30 + (Math.min(act.posts, 20) / 20) * 20 + (Math.min(good.n, 10) / 10) * 10;
    const basis = Math.min(balances[x.wallet] || 0, avg.get(x.wallet) || 0);
    const stake = cap > T ? clamp(((Math.min(basis, cap) - T) / (cap - T)) * 100) : 0;
    scored.push({ app: x, why, endorsements: endorse.get(x.id) || 0, contrib: clamp(contrib), stake, tiebreak: await sha256hex(`vicinity-seat|${w.id}|${x.wallet}`) });
  }
  const valid = scored.filter((s) => !s.why);
  const totalEndorse = valid.reduce((n, s) => n + s.endorsements, 0);
  for (const s of scored) {
    s.endorse = !s.why && totalEndorse ? (s.endorsements / totalEndorse) * 100 : 0;
    s.total = s.why ? null : F.weights.endorsement * s.endorse + F.weights.contribution * s.contrib + F.weights.stake * s.stake;
  }
  valid.sort((p, q) => q.total - p.total || (p.tiebreak < q.tiebreak ? -1 : 1));
  valid.forEach((s, i) => (s.rank = i + 1));

  const result = {
    window: w.id, city: { id: w.city_id, name: w.city_name, country: w.country }, policy: w.policy, threshold: T,
    openedAt: w.opened_at, closedAt: w.closes_at, weights: F.weights, stakeCap: F.stakeCap,
    balancesFrom: latest ? { sampledAt: latest.at, slot: latest.slot } : "live",
    applicants: scored.map((s) => ({
      application: s.app.id, name: s.app.handle || s.app.name || "Member", wallet: mask(s.app.wallet),
      valid: !s.why, excludedBecause: s.why, endorsements: s.endorsements,
      scores: { endorsement: +s.endorse.toFixed(4), contribution: +s.contrib.toFixed(4), stake: +s.stake.toFixed(4) },
      total: s.total == null ? null : +s.total.toFixed(4), tiebreak: s.tiebreak, rank: s.rank || null,
    })),
    winner: valid[0] ? valid[0].app.id : null,
  };
  const text = JSON.stringify(result);
  const stmts = scored.map((s) => db.prepare("UPDATE applications SET valid = ?, endorse_score = ?, contrib_score = ?, stake_score = ?, total = ?, tiebreak = ?, rank = ? WHERE id = ?")
    .bind(s.why ? 0 : 1, s.endorse, s.contrib, s.stake, s.total, s.tiebreak, s.rank || null, s.app.id));
  stmts.push(db.prepare("UPDATE windows SET status = ?, decided_at = ?, result = ?, result_hash = ? WHERE id = ? AND status = 'open'")
    .bind(valid.length ? "decided" : "empty", iso(now), text, await sha256hex(text), w.id));
  await db.batch(stmts);
  if (valid.length) await grantProvisional(env, w, valid.map((s) => s.app), now);
  return result;
}

/** Give the best still-eligible applicant (in rank order) a provisional seat with a 48-hour objection period. */
async function grantProvisional(env, w, ranked, now) {
  const db = env.DB;
  for (const x of ranked) {
    if (await liveSeatOfUser(db, x.user_id)) continue;
    try {
      await db.prepare(`INSERT INTO seats (city_id, city_name, country, user_id, wallet, window_id, application_id, policy, threshold, status, created_at, appeal_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisional', ?, ?)`)
        .bind(w.city_id, w.city_name, w.country, x.user_id, x.wallet, w.id, x.id, w.policy, w.threshold, iso(now), hoursFrom(now, F.appealHours)).run();
      console.log("founder chosen (provisional)", w.city_id, "window", w.id);
      return true;
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) { if (await liveSeatOfCity(db, w.city_id)) return false; continue; }
      throw e;
    }
  }
  return false;
}

/** Enter grace (or release, after too many graces). Used by the scheduled job and before sensitive actions. */
export async function enterGrace(db, seat, now, reason = "balance") {
  if (seat.status !== "active") return seat.status;
  const recent = JSON.parse(seat.graces || "[]").filter((t) => Date.parse(t) > now - F.graceWindowDays * DAY);
  recent.push(iso(now));
  if (recent.length > F.maxGraces) {
    await db.prepare("UPDATE seats SET status = 'released', ended_at = ?, end_reason = 'repeated_grace', graces = ? WHERE id = ? AND status = 'active'").bind(iso(now), JSON.stringify(recent), seat.id).run();
    return "released";
  }
  await db.prepare("UPDATE seats SET status = 'grace', grace_until = ?, graces = ? WHERE id = ? AND status = 'active'")
    .bind(iso(now + F.graceDays * DAY), JSON.stringify(recent), seat.id).run();
  console.log("founder seat in grace", seat.city_id, reason);
  return "grace";
}

/**
 * Before any founder / manager power is used: the live balance must still be at the founder amount.
 * If not, the seat goes into grace right now and the action is refused.
 */
export async function stillFounder(env, seat, now, fetchImpl = fetch) {
  if (!seat || seat.status !== "active") return false;
  const amount = (await amountsFor(env, [seat.wallet], fetchImpl)).get(seat.wallet) || 0;
  if (amount >= seat.threshold) return true;
  await enterGrace(env.DB, seat, now, "live_check");
  return false;
}

/** The scheduled job's part: close windows, make seats final, grace and release. */
export async function advanceSeats(env, now = Date.now(), fetchImpl = fetch) {
  const db = env.DB;
  const out = { closed: 0, activated: 0, grace: 0, restored: 0, released: 0 };
  for (const w of (await db.prepare("SELECT * FROM windows WHERE status = 'open' AND closes_at <= ?").bind(iso(now)).all()).results) {
    await closeWindow(env, w, now, fetchImpl); out.closed++;
  }
  const act = await db.prepare(`UPDATE seats SET status = 'active', activated_at = ?
    WHERE status = 'provisional' AND appeal_until <= ? AND NOT EXISTS (SELECT 1 FROM objections o WHERE o.seat_id = seats.id AND o.status = 'open')`).bind(iso(now), iso(now)).run();
  out.activated = act.meta.changes || 0;

  // balance checks use the latest sample, and only if it's recent: never act on stale data
  const latest = await latestBalances(env, now);
  if (!latest || now - Date.parse(latest.at) > POLICY.sampling.maxGapMinutes * 60_000 * 2) return { ...out, balances: "stale" };
  for (const seat of (await db.prepare("SELECT * FROM seats WHERE status IN ('active', 'grace')").all()).results) {
    const amount = latest.balances[seat.wallet] || 0;
    if (seat.status === "active" && amount < seat.threshold) { const s = await enterGrace(db, seat, now, "sample"); if (s === "grace") out.grace++; else out.released++; }
    else if (seat.status === "grace" && amount >= seat.threshold && Date.parse(latest.at) > Date.parse(seat.grace_until) - F.graceDays * DAY) {
      await db.prepare("UPDATE seats SET status = 'active', grace_until = NULL WHERE id = ? AND status = 'grace'").bind(seat.id).run(); out.restored++;
    } else if (seat.status === "grace" && Date.parse(seat.grace_until) <= now) {
      await db.prepare("UPDATE seats SET status = 'released', ended_at = ?, end_reason = 'balance' WHERE id = ? AND status = 'grace'").bind(iso(now), seat.id).run(); out.released++;
    }
  }
  return out;
}

/* ---------------- objections ---------------- */

/** POST /api/seats/object { seatId, reason } — a local (or the country's manager) objects to a founder. */
export async function handleObject(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  const seat = body && await db.prepare("SELECT * FROM seats WHERE id = ? AND status IN ('provisional', 'active', 'grace')").bind(Number(body.seatId) || 0).first();
  if (!seat) return json({ ok: false, error: "not_found" }, 404);
  const reason = cleanText(body.reason, 500);
  if (!reason || reason.length < 10) return json({ ok: false, error: "reason_required" }, 400);
  if (seat.user_id === u.id) return json({ ok: false, error: "own_seat" }, 400);
  if (u.home_city !== seat.city_id && u.home_country !== seat.country) return json({ ok: false, error: "not_local" }, 403);
  try {
    await db.prepare("INSERT INTO objections (seat_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)").bind(seat.id, u.id, reason, iso(now)).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return json({ ok: false, error: "already_objected" }, 409);
    throw e;
  }
  return json({ ok: true });
}

/**
 * POST /api/seats/objections/decide { id, uphold, note } — an admin (not the objector) decides.
 * Upheld: the seat is revoked and the next applicant from the same window gets a provisional seat.
 */
export async function handleDecideObjection(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await access(request, env, now, { fresh: true });
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  if (!adminWallets(env).includes(u.wallet)) return json({ ok: false, error: "not_allowed" }, 403);
  const body = await readJson(request);
  const o = body && await db.prepare("SELECT * FROM objections WHERE id = ? AND status = 'open'").bind(Number(body.id) || 0).first();
  if (!o) return json({ ok: false, error: "not_found" }, 404);
  if (o.user_id === u.id) return json({ ok: false, error: "own_objection" }, 403);
  const note = cleanText(body.note, 300) || null;
  const seat = await db.prepare("SELECT * FROM seats WHERE id = ?").bind(o.seat_id).first();
  if (!body.uphold) {
    await db.prepare("UPDATE objections SET status = 'dismissed', decided_by = ?, decided_at = ?, note = ? WHERE id = ?").bind(u.id, iso(now), note, o.id).run();
    await logSeatAction(db, u, "dismiss_objection", seat, note, now);
    return json({ ok: true, status: "dismissed" });
  }
  await db.batch([
    db.prepare("UPDATE objections SET status = 'upheld', decided_by = ?, decided_at = ?, note = ? WHERE id = ?").bind(u.id, iso(now), note, o.id),
    db.prepare("UPDATE objections SET status = 'closed' WHERE seat_id = ? AND status = 'open'").bind(seat.id),
    db.prepare("UPDATE seats SET status = 'revoked', ended_at = ?, end_reason = 'objection_upheld' WHERE id = ? AND status IN ('provisional', 'active', 'grace')").bind(iso(now), seat.id),
  ]);
  await logSeatAction(db, u, "revoke_seat", seat, note, now);
  // the next applicant from the same window, if they still qualify
  let next = false;
  if (seat.window_id) {
    const w = await db.prepare("SELECT * FROM windows WHERE id = ?").bind(seat.window_id).first();
    const ranked = (await db.prepare("SELECT * FROM applications WHERE window_id = ? AND valid = 1 AND rank IS NOT NULL AND user_id <> ? ORDER BY rank").bind(seat.window_id, seat.user_id).all()).results;
    const latest = await latestBalances(env, now);
    const still = [];
    for (const x of ranked) {
      const amt = latest ? latest.balances[x.wallet] || 0 : (await amountsFor(env, [x.wallet], fetchImpl)).get(x.wallet) || 0;
      if (amt >= w.threshold && (await tenure(env, x.wallet, w.threshold, now)).qualified) still.push(x);
    }
    if (w && still.length) next = await grantProvisional(env, w, still, now);
  }
  return json({ ok: true, status: "upheld", nextApplicant: next });
}

const logSeatAction = (db, u, action, seat, note, now) =>
  db.prepare("INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, target_user, country, place, reason, note, created_at, state) VALUES (?, 'admin', ?, 'seat', ?, ?, ?, ?, 'objection', ?, ?, 'done')")
    .bind(u.id, action, seat.id, seat.user_id, seat.country, seat.city_id, note, iso(now)).run();

/* ---------------- public views ---------------- */

/** GET /api/seats → every live seat and every open window (the map uses this). */
export async function handleSeats(env, now = Date.now()) {
  const db = env.DB;
  const [seats, windows] = await db.batch([
    db.prepare(`SELECT s.id, s.city_id, s.city_name, s.country, s.wallet, s.status, s.created_at, s.activated_at, s.appeal_until, s.grace_until, u.handle, u.name
      FROM seats s JOIN users u ON u.id = s.user_id WHERE s.status IN ('provisional', 'active', 'grace') ORDER BY s.id DESC`),
    db.prepare(`SELECT w.id, w.city_id, w.city_name, w.country, w.opened_at, w.closes_at, w.threshold,
      (SELECT COUNT(*) FROM applications a WHERE a.window_id = w.id AND a.withdrawn = 0) AS applicants
      FROM windows w WHERE w.status = 'open' ORDER BY w.closes_at`),
  ]);
  return json({
    launched: true,
    seats: seats.results.map((s) => ({ id: s.id, cityId: s.city_id, city: s.city_name, country: s.country, status: s.status,
      founder: s.handle || s.name || "Founder", wallet: s.wallet, since: s.activated_at || s.created_at, appealUntil: s.appeal_until, graceUntil: s.grace_until })),
    windows: windows.results.map((w) => ({ id: w.id, cityId: w.city_id, city: w.city_name, country: w.country, openedAt: w.opened_at, closesAt: w.closes_at, applicants: w.applicants, threshold: w.threshold })),
  });
}

/** A city's founder picture: the live seat, the open window (with applicants), the last result. */
export async function cityPicture(env, cityId, viewer, now = Date.now()) {
  const db = env.DB;
  const seat = await db.prepare("SELECT s.*, u.handle, u.name FROM seats s JOIN users u ON u.id = s.user_id WHERE s.city_id = ? AND s.status IN ('provisional', 'active', 'grace')").bind(cityId).first();
  const w = await db.prepare("SELECT * FROM windows WHERE city_id = ? AND status = 'open'").bind(cityId).first();
  let windowView = null;
  if (w) {
    const apps = (await db.prepare(`SELECT a.id, a.user_id, a.pitch, a.created_at, u.handle, u.name,
      (SELECT COUNT(*) FROM endorsements e WHERE e.application_id = a.id) AS endorsements
      FROM applications a JOIN users u ON u.id = a.user_id WHERE a.window_id = ? AND a.withdrawn = 0 ORDER BY a.id`).bind(w.id).all()).results;
    const mine = viewer ? await db.prepare("SELECT application_id FROM endorsements WHERE window_id = ? AND user_id = ?").bind(w.id, viewer.id).first() : null;
    const applicant = viewer && apps.some((x) => x.user_id === viewer.id);
    const why = viewer ? (applicant ? "applicant" : await voterProblem(env, viewer, { scope: "city", place: cityId, openedAt: w.opened_at, now })) : "sign_in";
    windowView = {
      id: w.id, openedAt: w.opened_at, closesAt: w.closes_at, threshold: w.threshold,
      applicants: apps.map((x) => ({ id: x.id, name: x.handle || x.name || "Member", pitch: x.pitch, endorsements: x.endorsements, you: Boolean(viewer && x.user_id === viewer.id) })),
      myEndorsement: mine ? mine.application_id : null, canEndorse: !why && Boolean(viewer), whyNot: why,
    };
  }
  const last = await db.prepare("SELECT id, status, decided_at, result_hash FROM windows WHERE city_id = ? AND status IN ('decided', 'empty') ORDER BY id DESC LIMIT 1").bind(cityId).first();
  const objections = seat ? (await db.prepare("SELECT COUNT(*) AS n FROM objections WHERE seat_id = ? AND status = 'open'").bind(seat.id).first()).n : 0;
  return {
    seat: seat ? { id: seat.id, status: seat.status, name: seat.handle || seat.name || "Founder", wallet: mask(seat.wallet), since: seat.activated_at || seat.created_at,
      appealUntil: seat.appeal_until, graceUntil: seat.grace_until, you: Boolean(viewer && seat.user_id === viewer.id), openObjections: objections,
      threshold: seat.threshold, policy: seat.policy } : null,
    window: windowView,
    lastResult: last ? { windowId: last.id, status: last.status, decidedAt: last.decided_at, hash: last.result_hash } : null,
  };
}

/** GET /api/seats/results/:windowId → the full published result of a window, and its hash. */
export async function handleResult(env, id) {
  const w = await env.DB.prepare("SELECT id, city_id, city_name, country, status, decided_at, result, result_hash FROM windows WHERE id = ?").bind(Number(id)).first();
  if (!w || !w.result) return json({ error: "not_found" }, 404);
  return json({ window: w.id, city: w.city_name, country: w.country, status: w.status, decidedAt: w.decided_at, hash: w.result_hash, result: JSON.parse(w.result),
    howToCheck: "sha256 of the exact `result` text equals `hash`. Scores follow /api/policy (founder.weights)." });
}
