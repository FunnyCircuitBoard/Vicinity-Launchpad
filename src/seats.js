/**
 * City founders: fair, stable, and never for sale in a minute.
 *
 *   1. Qualify   hold the city's founder amount — the Stake Ladder: 100K × (pop/10K)^(1/3),
 *                clamped 100K–1M — in EVERY balance sample for 7 days (src/ledger.js),
 *                with a home community set 7+ days ago. No seat can be bought with borrowed tokens.
 *   2. Apply     standing in the city (a location attestation).
 *   2a. Steward  a lone qualified claimer skips the election-of-one and becomes Seed Steward at
 *                once: provisional founder with the stake bonded for a 90-day probation.
 *                Two claims landing together fall back to a 72-hour window (step 3).
 *   3. Endorse   verified locals (one person, one endorsement) back the applicant they want.
 *   4. Select    when a window closes, everyone is scored by the published formula:
 *                  50% local endorsements · 30% contribution · 20% holdings (capped at 2× the amount)
 *                ties broken by a public hash. The full result and its hash are published.
 *                A lone applicant becomes Seed Steward; 2+ applicants elect a provisional founder.
 *   5. Object    48 hours for locals to object (fraud, not local). An admin reviews objections;
 *                an upheld objection passes the seat to the next applicant.
 *   5a. Challenge a steward's probation is challengeable: any verified local may apply, opening a
 *                72-hour election the steward defends in. A challenger needs 10 local endorsements
 *                to force the election. Probation confirms at 90 days or 50 verified local members.
 *   5b. Squads   3–5 verified locals may pool seasoned holdings as a squad; one founder wallet
 *                mints, everyone is recorded as a co-founder.
 *   6. Active    founder rights on. Holdings are re-checked at every sample and before every
 *                sensitive action.
 *   7. Grace     below the amount → 7 days to fix it (stewards: 48 hours); moderation powers pause
 *                at once. More than 2 graces in 90 days → the seat is released.
 *   8. Released  the city reopens; the former founder waits 30 days before applying anywhere.
 *                A city dark for 30 days can be steward-founded by any holder (locals keep priority).
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
import { LAUNCHPAD_OPENS_AT, activeMint } from "./official.js";
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
/** Find a city by id within a country (for dark-city adoption, where the applicant isn't local). */
async function cityById(env, cc, cityId) {
  const list = await countryCities(env, cc);
  return (list || []).find((c) => c.id === String(cityId)) || null;
}

/**
 * When did this city go dark (no live seat, no open window)? null when it isn't dark.
 * A city that never had a seat or window counts as dark since the launchpad opened —
 * locals get the first 30 days; after that any holder may steward-found it.
 */
export async function darkSince(db, cityId, now = Date.now()) {
  if (await liveSeatOfCity(db, cityId)) return null;
  if (await db.prepare("SELECT id FROM windows WHERE city_id = ? AND status = 'open'").bind(cityId).first()) return null;
  const lastSeat = await db.prepare("SELECT MAX(ended_at) AS t FROM seats WHERE city_id = ? AND ended_at IS NOT NULL").bind(cityId).first();
  const lastWin = await db.prepare("SELECT MAX(decided_at) AS t FROM windows WHERE city_id = ? AND status IN ('decided', 'empty')").bind(cityId).first();
  const last = Math.max(lastSeat && lastSeat.t ? Date.parse(lastSeat.t) : 0, lastWin && lastWin.t ? Date.parse(lastWin.t) : 0);
  return last || Date.parse(LAUNCHPAD_OPENS_AT);
}

/** Verified local members of a city (home set by location proof): the steward-confirmation quorum. */
export async function localMembers(db, cityId) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE home_city = ?").bind(cityId).first();
  return r ? r.n : 0;
}

export async function eligibility(env, u, now = Date.now(), fetchImpl = fetch, target = null, opts = {}) {
  const db = env.DB;
  // homeReadyAt is known before launch too, so the dashboard can tick "home set 7 days" early.
  const homeReadyAt = u.home_city && u.home_at ? iso(Date.parse(u.home_at) + F.localDays * DAY) : null;
  const out = { ok: false, threshold: null, tenure: null, amount: 0, cooldownUntil: null, homeReadyAt,
    cityId: null, cityName: null, country: null, challenging: null, darkAdoption: false };
  if (!activeMint(env)) return { ...out, error: "not_launched" };
  // Which city? Home by default; a different one only via dark-city adoption.
  const city = target && target.id ? target
    : u.home_city ? { id: u.home_city, name: u.home_name, country: u.home_country } : null;
  if (!city) return { ...out, error: "no_home" };
  out.cityId = city.id; out.cityName = city.name; out.country = city.country;
  out.darkAdoption = city.id !== u.home_city;
  out.threshold = await thresholdFor(env, city.country, city.id);
  out.tenure = await tenure(env, u.wallet, out.threshold, now);
  out.amount = (await amountsFor(env, [u.wallet], fetchImpl)).get(u.wallet) || 0;
  out.cooldownUntil = await cooldownUntil(db, u.id, now);
  if (!out.darkAdoption && Date.parse(homeReadyAt) > now) return { ...out, error: "home_too_new" };
  if (await liveSeatOfUser(db, u.id)) return { ...out, error: "has_seat" };
  if (await openApplicationOf(db, u.id)) return { ...out, error: "already_applied" };
  if (out.cooldownUntil) return { ...out, error: "cooldown" };
  const seat = await liveSeatOfCity(db, city.id);
  if (seat && !(seat.status === "steward" && seat.probation_until && Date.parse(seat.probation_until) > now))
    return { ...out, error: "city_taken" };
  if (seat) {
    // Challenging a Seed Steward inside probation: challengers must be verified locals.
    // (A verified local always has priority: anyone else can't even open the challenge.)
    if (u.home_city !== city.id) return { ...out, error: "city_taken" };
    const vp = await voterProblem(env, u, { scope: "city", place: city.id, openedAt: iso(now), now });
    if (vp) return { ...out, error: "city_taken", whyNot: vp };
    out.challenging = seat.id;
  }
  if (out.darkAdoption) {
    const since = await darkSince(db, city.id, now);
    if (since == null || now - since < F.darkCityDays * DAY) return { ...out, error: "not_dark" };
  }
  if (await activeBan(db, u.id, u.home_country, now)) return { ...out, error: "banned" };
  if (opts.skipStake) return { ...out, ok: true }; // squads bring pooled stake: validated as a unit, not per wallet
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

/**
 * A lone qualified claimer becomes Seed Steward at once — no 72-hour election of one.
 * The UNIQUE index on live seats arbitrates near-simultaneous claims: the loser's INSERT
 * fails and they fall into a standard window instead. Returns the seat row, or null.
 */
async function tryGrantSteward(env, e, u, pitch, squadId, now) {
  const db = env.DB;
  const probationUntil = iso(now + F.stewardProbationDays * DAY);
  try {
    const seat = await db.prepare(
      `INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, probation_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'steward', ?, ?) RETURNING id, probation_until`)
      .bind(e.cityId, e.cityName, e.country, u.id, u.wallet, POLICY.version, e.threshold, iso(now), probationUntil).first();
    const w = await db.prepare(
      `INSERT INTO windows (city_id, city_name, country, policy, threshold, opened_at, closes_at, status, kind, decided_at, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'decided', 'steward_direct', ?, ?) RETURNING id`)
      .bind(e.cityId, e.cityName, e.country, POLICY.version, e.threshold, iso(now), iso(now), iso(now),
        JSON.stringify({ steward: u.id, wallet: u.wallet, squad: squadId || null, reason: "sole_qualified_claimer", probationUntil })).first();
    const app = await db.prepare(
      "INSERT INTO applications (window_id, city_id, user_id, wallet, squad_id, pitch, created_at, valid, rank) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1) RETURNING id")
      .bind(w.id, e.cityId, u.id, u.wallet, squadId || null, pitch || null, iso(now)).first();
    await db.prepare("UPDATE seats SET window_id = ?, application_id = ? WHERE id = ?").bind(w.id, app.id, seat.id).run();
    if (squadId) await db.prepare("UPDATE squads SET status = 'seated', seated_at = ?, founder_wallet = ? WHERE id = ?").bind(iso(now), u.wallet, squadId).run();
    console.log("seed steward", e.cityId, "seat", seat.id, squadId ? `squad ${squadId}` : "");
    return seat;
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return null; // someone claimed it at the same moment → election
    throw err;
  }
}

/**
 * Open (or join) the 72-hour window where a verified local challenges a Seed Steward.
 * The steward is entered automatically and defends the seat in the same scoring.
 */
async function openChallengeWindow(env, e, u, now, fetchImpl) {
  const db = env.DB;
  let w = await db.prepare("SELECT * FROM windows WHERE city_id = ? AND status = 'open'").bind(e.cityId).first();
  if (w && Date.parse(w.closes_at) <= now) { await closeWindow(env, w, now, fetchImpl); w = null; }
  if (w) return w;
  const seat = await db.prepare("SELECT * FROM seats WHERE id = ? AND status = 'steward'").bind(e.challenging).first();
  if (!seat) return null; // the stewardship ended while the challenger was applying
  try {
    await db.prepare("INSERT INTO windows (city_id, city_name, country, policy, threshold, opened_at, closes_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'steward_challenge')")
      .bind(e.cityId, e.cityName, e.country, POLICY.version, e.threshold, iso(now), hoursFrom(now, F.windowHours)).run();
  } catch (err) { if (!/UNIQUE/i.test(String(err))) throw err; } // someone opened it at the same moment: use theirs
  w = await db.prepare("SELECT * FROM windows WHERE city_id = ? AND status = 'open'").bind(e.cityId).first();
  const orig = seat.application_id ? await db.prepare("SELECT pitch FROM applications WHERE id = ?").bind(seat.application_id).first() : null;
  try {
    await db.prepare("INSERT INTO applications (window_id, city_id, user_id, wallet, pitch, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(w.id, e.cityId, seat.user_id, seat.wallet, orig && orig.pitch ? orig.pitch : "Defending Seed Steward", iso(now)).run();
  } catch (err) { if (!/UNIQUE/i.test(String(err))) throw err; } // already entered
  return w;
}

/** POST /api/seats/apply { attestation, pitch, cityId?, country? } — apply to found a city. */
export async function handleApply(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await access(request, env, now, { fresh: true });
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  // Dark-city adoption: name a different city (it must have been dark 30+ days).
  let target = null;
  if (body.cityId && body.cityId !== u.home_city) {
    const cc = /^[A-Z]{2}$/.test(body.country || "") ? body.country : null;
    const found = cc ? await cityById(env, cc, body.cityId) : null;
    if (!found) return json({ ok: false, error: "unknown_city" }, 400);
    target = { id: found.id, name: found.name, country: found.country };
  }
  const e = await eligibility(env, u, now, fetchImpl, target);
  if (!e.ok) return json({ ok: false, error: e.error, tenure: e.tenure, threshold: e.threshold, cooldownUntil: e.cooldownUntil, homeReadyAt: e.homeReadyAt, whyNot: e.whyNot || null }, 403);
  const pitch = cleanText(body.pitch, 280);
  if (pitch == null) return json({ ok: false, error: "too_long", max: 280 }, 400);
  if (HAS_ADDRESS.test(pitch)) return json({ ok: false, error: "no_addresses" }, 400);
  const at = await useAttestation(env, body.attestation, { userId: u.id, purpose: "apply", now });
  if (!at.ok) return json({ ok: false, error: at.error }, 400);
  // Locals apply standing in the city; dark-city adopters prove liveness with any fresh attestation.
  if (!e.darkAdoption && at.att.city !== e.cityId) return json({ ok: false, error: "not_in_city", here: at.att.cityName || null }, 403);

  if (e.challenging) {
    const w = await openChallengeWindow(env, e, u, now, fetchImpl);
    if (!w) return json({ ok: false, error: "city_taken" }, 409);
    try {
      await db.prepare("INSERT INTO applications (window_id, city_id, user_id, wallet, pitch, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(w.id, w.city_id, u.id, u.wallet, pitch || null, iso(now)).run();
    } catch (err) {
      if (/UNIQUE/i.test(String(err))) return json({ ok: false, error: "already_applied" }, 409);
      throw err;
    }
    console.log("steward challenge", w.city_id, "window", w.id);
    return json({ ok: true, challenge: true, window: { id: w.id, cityId: w.city_id, closesAt: w.closes_at } });
  }

  // No live seat: a lone qualified claimer becomes Seed Steward at once.
  const seat = await tryGrantSteward(env, e, u, pitch, null, now);
  if (seat) return json({ ok: true, steward: true, seat: { id: seat.id, cityId: e.cityId, probationUntil: seat.probation_until } });

  // Lost the millisecond race: a standard 72-hour window decides instead.
  const w = await openWindow(env, { id: e.cityId, name: e.cityName, country: e.country, threshold: e.threshold }, now, fetchImpl);
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

/**
 * POST /api/seats/resign — walk away from your live seat. For a Seed Steward this releases the
 * bond at once; for a confirmed founder the normal cooldown applies to the next claim.
 */
export async function handleResign(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const db = env.DB;
  const seat = await liveSeatOfUser(db, a.u.id);
  if (!seat) return json({ ok: false, error: "no_seat" }, 404);
  const r = await db.prepare("UPDATE seats SET status = 'released', ended_at = ?, end_reason = 'resigned' WHERE id = ? AND status IN ('provisional', 'active', 'grace', 'steward')")
    .bind(iso(now), seat.id).run();
  if (!r.meta.changes) return json({ ok: false, error: "no_seat" }, 404);
  return json({ ok: true, cityId: seat.city_id });
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
 * Score every non-withdrawn application in a window by the published formula.
 * Squad applications are validated as a unit (pooled seasoned holdings); the steward's own
 * application in a challenge window is validated against their grandfathered threshold.
 * Returns { scored, valid, latest } with the shapes closeWindow has always produced.
 */
async function scoreWindow(env, db, w, stewardSeat, now, fetchImpl) {
  const apps = (await db.prepare("SELECT a.*, u.handle, u.name, u.home_city, u.created_at AS joined, u.home_country FROM applications a JOIN users u ON u.id = a.user_id WHERE a.window_id = ? AND a.withdrawn = 0 ORDER BY a.id").bind(w.id).all()).results;
  const squadWallets = [];
  for (const x of apps) if (x.squad_id) {
    const ms = await db.prepare("SELECT wallet FROM squad_members WHERE squad_id = ?").bind(x.squad_id).all();
    squadWallets.push(...ms.results.map((m) => m.wallet));
  }
  const latest = await latestBalances(env, now);
  const balances = latest ? latest.balances : Object.fromEntries(await amountsFor(env, [...apps.map((x) => x.wallet), ...squadWallets], fetchImpl));
  const endorse = new Map((await db.prepare("SELECT application_id, COUNT(*) AS n FROM endorsements WHERE window_id = ? GROUP BY application_id").bind(w.id).all()).results.map((r) => [r.application_id, r.n]));
  const avg = (await averages(env, dayOf(now), F.qualifyingDays, apps.map((x) => x.wallet))).averages;
  const T = w.threshold, cap = F.stakeCap * T;

  const scored = [];
  for (const x of apps) {
    let why = null;
    let basis = Math.min(balances[x.wallet] || 0, avg.get(x.wallet) || 0);
    if (x.squad_id) {
      // A squad stands or falls together: every member seasoned, pooled at the bar.
      const q = await qualifySquad(env, x.squad_id, T, now, fetchImpl, balances);
      if (!q.ok) why = q.error === "below_threshold" ? "below_threshold" : "squad_not_qualified";
      else basis = q.pooled;
    } else {
      const defending = stewardSeat && x.user_id === stewardSeat.user_id;
      const threshold = defending ? stewardSeat.threshold : T; // stewards keep the bar they claimed under
      if (x.home_city !== w.city_id) why = "moved_away";
      else if (!defending && await liveSeatOfUser(db, x.user_id)) why = "has_seat";
      else if (await activeBan(db, x.user_id, w.country, now)) why = "banned";
      else if (!(await tenure(env, x.wallet, threshold, now)).qualified) why = "not_qualified";
      else if ((balances[x.wallet] || 0) < threshold) why = "below_threshold";
    }
    const joinedDays = Math.max(0, (Date.parse(w.opened_at) - Date.parse(x.joined)) / DAY);
    const act = await db.prepare(`SELECT
        COUNT(DISTINCT CASE WHEN kind = 'checkin' AND place = ? THEN substr(created_at, 1, 10) END) AS checkins,
        COUNT(CASE WHEN kind <> 'checkin' THEN 1 END) AS posts
      FROM posts WHERE user_id = ? AND hidden = 0 AND created_at < ?`).bind(w.city_id, x.user_id, w.closes_at).first();
    const good = await db.prepare("SELECT COUNT(*) AS n FROM reports r JOIN posts p ON p.id = r.post_id WHERE r.user_id = ? AND p.hidden = 1 AND p.hide_confirmed = 1").bind(x.user_id).first();
    const contrib = (Math.min(joinedDays, 60) / 60) * 40 + (Math.min(act.checkins, 20) / 20) * 30 + (Math.min(act.posts, 20) / 20) * 20 + (Math.min(good.n, 10) / 10) * 10;
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
  return { scored, valid, latest };
}

/** Publish a window's scores and decision (the full result and its hash go on the record). */
async function publishWindow(db, w, scored, valid, winnerId, latest, extra, now) {
  const { kindOverride, ...rest } = extra || {};
  const result = {
    window: w.id, city: { id: w.city_id, name: w.city_name, country: w.country }, policy: w.policy, threshold: w.threshold,
    kind: kindOverride || w.kind, ...rest,
    openedAt: w.opened_at, closedAt: w.closes_at, weights: F.weights, stakeCap: F.stakeCap,
    balancesFrom: latest ? { sampledAt: latest.at, slot: latest.slot } : "live",
    applicants: scored.map((s) => ({
      application: s.app.id, name: s.app.handle || s.app.name || "Member", wallet: mask(s.app.wallet),
      squad: s.app.squad_id || null,
      valid: !s.why, excludedBecause: s.why, endorsements: s.endorsements,
      scores: { endorsement: +s.endorse.toFixed(4), contribution: +s.contrib.toFixed(4), stake: +s.stake.toFixed(4) },
      total: s.total == null ? null : +s.total.toFixed(4), tiebreak: s.tiebreak, rank: s.rank || null,
    })),
    winner: winnerId || null,
  };
  const text = JSON.stringify(result);
  const stmts = scored.map((s) => db.prepare("UPDATE applications SET valid = ?, endorse_score = ?, contrib_score = ?, stake_score = ?, total = ?, tiebreak = ?, rank = ? WHERE id = ?")
    .bind(s.why ? 0 : 1, s.endorse, s.contrib, s.stake, s.total, s.tiebreak, s.rank || null, s.app.id));
  stmts.push(db.prepare("UPDATE windows SET status = ?, kind = ?, decided_at = ?, result = ?, result_hash = ? WHERE id = ? AND status = 'open'")
    .bind(valid.length ? "decided" : "empty", kindOverride || w.kind, iso(now), text, await sha256hex(text), w.id));
  await db.batch(stmts);
  return result;
}

/**
 * Close a window: check every applicant again, score them with the published formula, and seat the
 * winner. A lone qualifier becomes Seed Steward at once (no election of one); 2+ elect a
 * provisional founder. Challenge windows follow the steward-challenge rules. The whole result
 * (and a hash of it) is stored for anyone to re-check.
 */
export async function closeWindow(env, w, now = Date.now(), fetchImpl = fetch) {
  const db = env.DB;
  if (w.status !== "open") return { closed: false };
  const stewardSeat = w.kind === "steward_challenge"
    ? await db.prepare("SELECT * FROM seats WHERE city_id = ? AND status = 'steward'").bind(w.city_id).first()
    : null;
  const { scored, valid, latest } = await scoreWindow(env, db, w, stewardSeat, now, fetchImpl);
  if (w.kind === "steward_challenge") return finishChallengeWindow(env, db, w, scored, valid, stewardSeat, latest, now, fetchImpl);
  if (valid.length <= 1) {
    const result = await publishWindow(db, w, scored, valid, valid[0] ? valid[0].app.id : null, latest,
      { decision: valid[0] ? "sole_qualifier_steward" : "no_valid_applicants", kindOverride: valid[0] ? "steward_direct" : undefined }, now);
    if (valid[0]) await grantStewardFromWindow(env, w, valid[0], now);
    return result;
  }
  const result = await publishWindow(db, w, scored, valid, valid[0].app.id, latest, { decision: "election" }, now);
  await grantProvisional(env, w, valid.map((s) => s.app), now);
  return result;
}

/** Seat a sole qualifying applicant as Seed Steward (e.g. their rival withdrew or never qualified). */
async function grantStewardFromWindow(env, w, s, now) {
  const db = env.DB;
  const x = s.app;
  try {
    const seat = await db.prepare(
      `INSERT INTO seats (city_id, city_name, country, user_id, wallet, window_id, application_id, policy, threshold, status, created_at, probation_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'steward', ?, ?) RETURNING id`)
      .bind(w.city_id, w.city_name, w.country, x.user_id, x.wallet, w.id, x.id, w.policy, w.threshold, iso(now), iso(now + F.stewardProbationDays * DAY)).first();
    if (x.squad_id) await db.prepare("UPDATE squads SET status = 'seated', seated_at = ?, founder_wallet = ? WHERE id = ?").bind(iso(now), x.wallet, x.squad_id).run();
    console.log("seed steward (window)", w.city_id, "seat", seat.id);
    return seat;
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return null;
    throw e;
  }
}

/**
 * Close a steward-challenge window. A challenger needs 10 verified local endorsements to force
 * the election; otherwise the steward keeps the seat without a contest. Past the quorum, the
 * same scoring decides — the steward defends as a candidate with their grandfathered threshold.
 */
async function finishChallengeWindow(env, db, w, scored, valid, stewardSeat, latest, now, fetchImpl) {
  const stewardEntry = stewardSeat ? valid.find((s) => s.app.user_id === stewardSeat.user_id) : null;
  const challengers = valid.filter((s) => s !== stewardEntry);
  const topChallengerEndorsements = challengers.length ? Math.max(...challengers.map((s) => s.endorsements)) : 0;

  let winner = null, decision;
  if (!stewardEntry) {
    // The steward failed their bond mid-challenge: best valid challenger takes the normal path.
    winner = challengers[0] || null;
    decision = winner ? "steward_bond_broken" : "no_valid_applicants";
  } else if (topChallengerEndorsements < F.stewardChallengeEndorsements) {
    winner = stewardEntry;
    decision = "challenge_quorum_not_met";
  } else {
    winner = valid[0];
    decision = winner === stewardEntry ? "steward_wins_election" : "challenger_wins_election";
  }
  const result = await publishWindow(db, w, scored, valid, winner ? winner.app.id : null, latest,
    { decision, challengeQuorum: F.stewardChallengeEndorsements }, now);

  if (stewardSeat && (!stewardEntry || (winner && winner !== stewardEntry))) {
    await db.prepare("UPDATE seats SET status = 'released', ended_at = ?, end_reason = ? WHERE id = ?")
      .bind(iso(now), !stewardEntry ? "bond_broken" : "lost_challenge", stewardSeat.id).run();
  }
  if (winner && winner !== stewardEntry) {
    await grantProvisional(env, w, [winner.app, ...challengers.filter((s) => s !== winner).map((s) => s.app)], now);
  } else if (winner && stewardSeat && Date.parse(stewardSeat.probation_until) <= now) {
    // The steward defended past probation end: confirm them on the spot.
    await db.prepare("UPDATE seats SET status = 'active', activated_at = ? WHERE id = ? AND status = 'steward'").bind(iso(now), stewardSeat.id).run();
  }
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
/** Wallets whose balances back a seat: the founder's, plus squad members' for squad seats. */
async function seatWallets(db, seat) {
  const app = seat.application_id
    ? await db.prepare("SELECT squad_id FROM applications WHERE id = ?").bind(seat.application_id).first()
    : null;
  if (app && app.squad_id) {
    const ms = await db.prepare("SELECT wallet FROM squad_members WHERE squad_id = ?").bind(app.squad_id).all();
    return ms.results.map((m) => m.wallet);
  }
  return [seat.wallet];
}

/** The effective backing balance of a seat (pooled across members for squads). */
async function seatBalance(db, seat, balances) {
  const wallets = await seatWallets(db, seat);
  return wallets.reduce((n, w) => n + (balances[w] || 0), 0);
}

export async function enterGrace(db, seat, now, reason = "balance") {
  const stewarding = seat.status === "steward";
  if (!stewarding && seat.status !== "active") return seat.status;
  const recent = JSON.parse(seat.graces || "[]").filter((t) => Date.parse(t) > now - F.graceWindowDays * DAY);
  recent.push(iso(now));
  if (recent.length > F.maxGraces) {
    await db.prepare("UPDATE seats SET status = 'released', ended_at = ?, end_reason = 'repeated_grace', graces = ? WHERE id = ? AND status IN ('active', 'steward')").bind(iso(now), JSON.stringify(recent), seat.id).run();
    return "released";
  }
  if (stewarding) {
    // Stewards stay stewards in grace (48 hours): their bond is shorter, like their leash.
    await db.prepare("UPDATE seats SET grace_until = ?, graces = ? WHERE id = ? AND status = 'steward'")
      .bind(iso(now + F.stewardGraceHours * 3600_000), JSON.stringify(recent), seat.id).run();
    console.log("steward seat in grace", seat.city_id, reason);
    return "steward_grace";
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
  if (!seat || (seat.status !== "active" && seat.status !== "steward")) return false;
  const wallets = await seatWallets(env.DB, seat);
  const balances = Object.fromEntries((await amountsFor(env, wallets, fetchImpl)).entries());
  const amount = await seatBalance(env.DB, seat, balances);
  if (amount >= seat.threshold) return true;
  await enterGrace(env.DB, seat, now, "live_check");
  return false;
}

/** The scheduled job's part: close windows, make seats final, confirm stewards, grace and release. */
export async function advanceSeats(env, now = Date.now(), fetchImpl = fetch) {
  const db = env.DB;
  const out = { closed: 0, activated: 0, confirmed: 0, grace: 0, restored: 0, released: 0 };
  for (const w of (await db.prepare("SELECT * FROM windows WHERE status = 'open' AND closes_at <= ?").bind(iso(now)).all()).results) {
    await closeWindow(env, w, now, fetchImpl); out.closed++;
  }
  // balance checks use the latest sample, and only if it's recent: never act on stale data
  const latest = await latestBalances(env, now);
  const balancesFresh = latest && now - Date.parse(latest.at) <= POLICY.sampling.maxGapMinutes * 60_000 * 2;

  // provisional → active, but only if the winner still holds the bar at activation time:
  // a winner who dumps during the appeal window must not become founder.
  for (const seat of (await db.prepare(`SELECT * FROM seats WHERE status = 'provisional' AND appeal_until <= ?
      AND NOT EXISTS (SELECT 1 FROM objections o WHERE o.seat_id = seats.id AND o.status = 'open')`).bind(iso(now)).all()).results) {
    if (!balancesFresh) continue; // fail closed: retry next run when the sample is fresh
    const amount = await seatBalance(db, seat, latest.balances);
    if (amount < seat.threshold) {
      await db.prepare("UPDATE seats SET status = 'released', ended_at = ?, end_reason = 'balance_at_activation' WHERE id = ? AND status = 'provisional'")
        .bind(iso(now), seat.id).run();
      out.released++;
      await db.prepare("INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, target_user, country, place, reason, note, created_at, state) VALUES ('system', 'system', 'release_provisional_balance', 'seat', ?, ?, ?, ?, 'balance', ?, ?, 'done')")
        .bind(seat.id, seat.user_id, seat.country, seat.city_id, `held ${amount} < ${seat.threshold} at activation`, iso(now)).run();
      // offer the seat to the next still-qualified applicant from the same window
      if (seat.window_id) {
        const w = await db.prepare("SELECT * FROM windows WHERE id = ?").bind(seat.window_id).first();
        const ranked = (await db.prepare("SELECT * FROM applications WHERE window_id = ? AND valid = 1 AND rank IS NOT NULL AND user_id <> ? ORDER BY rank").bind(seat.window_id, seat.user_id).all()).results;
        const still = [];
        for (const x of ranked) {
          const amt = latest.balances[x.wallet] || 0;
          if (w && amt >= w.threshold && (await tenure(env, x.wallet, w.threshold, now)).qualified) still.push(x);
        }
        if (w && still.length) await grantProvisional(env, w, still, now);
      }
      continue;
    }
    await db.prepare("UPDATE seats SET status = 'active', activated_at = ? WHERE id = ? AND status = 'provisional'").bind(iso(now), seat.id).run();
    out.activated++;
  }

  // steward confirmation: 90 days of good behavior, or 50 verified locals in the city — never mid-challenge
  for (const s of (await db.prepare("SELECT * FROM seats WHERE status = 'steward'").all()).results) {
    const challengeOpen = await db.prepare("SELECT id FROM windows WHERE city_id = ? AND status = 'open'").bind(s.city_id).first();
    if (challengeOpen) continue;
    const members = await localMembers(db, s.city_id);
    if (Date.parse(s.probation_until) <= now || members >= F.stewardQuorum) {
      const r = await db.prepare("UPDATE seats SET status = 'active', activated_at = ?, probation_until = NULL WHERE id = ? AND status = 'steward'").bind(iso(now), s.id).run();
      out.confirmed += r.meta.changes || 0;
    }
  }

  // balance checks use the latest sample (fetched above); never act on stale data
  if (!balancesFresh) return { ...out, balances: "stale" };
  for (const seat of (await db.prepare("SELECT * FROM seats WHERE status IN ('active', 'grace', 'steward')").all()).results) {
    const amount = await seatBalance(db, seat, latest.balances);
    if ((seat.status === "active" || (seat.status === "steward" && !seat.grace_until)) && amount < seat.threshold) {
      const s = await enterGrace(db, seat, now, "sample");
      if (s === "released") out.released++; else out.grace++;
    } else if (seat.status === "steward" && seat.grace_until) {
      if (amount >= seat.threshold) {
        await db.prepare("UPDATE seats SET grace_until = NULL WHERE id = ? AND status = 'steward'").bind(seat.id).run(); out.restored++;
      } else if (Date.parse(seat.grace_until) <= now) {
        await db.prepare("UPDATE seats SET status = 'released', ended_at = ?, end_reason = 'balance' WHERE id = ? AND status = 'steward'").bind(iso(now), seat.id).run(); out.released++;
      }
    } else if (seat.status === "grace" && amount >= seat.threshold && Date.parse(latest.at) > Date.parse(seat.grace_until) - F.graceDays * DAY) {
      await db.prepare("UPDATE seats SET status = 'active', grace_until = NULL WHERE id = ? AND status = 'grace'").bind(seat.id).run(); out.restored++;
    } else if (seat.status === "grace" && Date.parse(seat.grace_until) <= now) {
      await db.prepare("UPDATE seats SET status = 'released', ended_at = ?, end_reason = 'balance' WHERE id = ? AND status = 'grace'").bind(iso(now), seat.id).run(); out.released++;
    }
  }
  return out;
}

/* ---------------- squads ---------------- */

/** The squad with its members, or null. */
async function getSquad(db, squadId) {
  const squad = await db.prepare("SELECT * FROM squads WHERE id = ?").bind(squadId).first();
  if (!squad) return null;
  const members = (await db.prepare(
    `SELECT m.user_id, m.wallet, u.handle, u.name FROM squad_members m JOIN users u ON u.id = m.user_id WHERE m.squad_id = ? ORDER BY m.joined_at`)
    .bind(squadId).all()).results;
  return { ...squad, members };
}

/**
 * Does the squad meet the bar? Every member must be a verified local of the city whose own
 * holdings are seasoned 7 days, and the pooled balance must reach the threshold.
 * Each member's share counts at the 10K rung below their balance — the part balance history
 * can actually prove seasoned (tenure is tracked per rung).
 */
export async function qualifySquad(env, squadId, threshold, now, fetchImpl = fetch, balances = null) {
  const db = env.DB;
  const rung = F.ladder.rung;
  const squad = await getSquad(db, squadId);
  if (!squad) return { ok: false, error: "no_squad", pooled: 0, members: [] };
  const out = { ok: false, error: null, pooled: 0, members: [] };
  const bal = balances || Object.fromEntries((await amountsFor(env, squad.members.map((m) => m.wallet), fetchImpl)).entries());
  for (const m of squad.members) {
    const u = await db.prepare("SELECT * FROM users WHERE id = ?").bind(m.user_id).first();
    const balance = bal[m.wallet] || 0;
    const contribution = Math.floor(balance / rung) * rung;
    let whyNot = null;
    if (!u || u.home_city !== squad.city_id) whyNot = "not_local";
    else if (await liveSeatOfUser(db, u.id)) whyNot = "has_seat";
    else if (await activeBan(db, u.id, u.home_country, now)) whyNot = "banned";
    else if (contribution <= 0) whyNot = "no_balance";
    else if (!(await tenure(env, m.wallet, contribution, now)).qualified) whyNot = "not_qualified";
    out.members.push({ user_id: m.user_id, handle: m.handle, wallet: m.wallet, balance, contribution, qualified: !whyNot, whyNot });
    if (!whyNot) out.pooled += contribution;
  }
  if (squad.members.length < F.squadMin || squad.members.length > F.squadMax) out.error = "bad_size";
  else if (out.members.some((m) => !m.qualified)) out.error = "member_not_qualified";
  else if (out.pooled < threshold) out.error = "below_threshold";
  else { out.ok = true; }
  return out;
}

/** POST /api/seats/squad/create — start a squad for your home city (you're the first member). */
export async function handleSquadCreate(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  if (!activeMint(env)) return json({ ok: false, error: "not_launched" }, 403);
  if (!u.home_city) return json({ ok: false, error: "no_home" }, 403);
  if (await liveSeatOfCity(db, u.home_city)) return json({ ok: false, error: "city_taken" }, 409);
  if (await liveSeatOfUser(db, u.id)) return json({ ok: false, error: "has_seat" }, 403);
  const existing = await db.prepare("SELECT id FROM squads WHERE city_id = ? AND status IN ('forming', 'ready', 'applied')").bind(u.home_city).first();
  if (existing) return json({ ok: false, error: "squad_exists", squadId: existing.id }, 409);
  const vp = await voterProblem(env, u, { scope: "city", place: u.home_city, openedAt: iso(now), now });
  if (vp) return json({ ok: false, error: vp }, 403);
  const r = await db.prepare("INSERT INTO squads (city_id, city_name, country, created_by, status, created_at) VALUES (?, ?, ?, ?, 'forming', ?) RETURNING id")
    .bind(u.home_city, u.home_name, u.home_country, u.id, iso(now)).run();
  const id = r.meta.last_row_id;
  await db.prepare("INSERT INTO squad_members (squad_id, user_id, wallet, joined_at) VALUES (?, ?, ?, ?)")
    .bind(id, u.id, u.wallet, iso(now)).run();
  return json({ ok: true, squad: { id, cityId: u.home_city, city: u.home_name, country: u.home_country, members: 1 } });
}

/** POST /api/seats/squad/join { squadId } — a verified local joins a forming squad. */
export async function handleSquadJoin(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  const squad = body && await getSquad(db, Number(body.squadId) || 0);
  if (!squad || squad.status !== "forming") return json({ ok: false, error: "not_found" }, 404);
  if (squad.members.length >= F.squadMax) return json({ ok: false, error: "squad_full" }, 409);
  if (squad.members.some((m) => m.user_id === u.id)) return json({ ok: false, error: "already_member" }, 409);
  if (u.home_city !== squad.city_id) return json({ ok: false, error: "not_local" }, 403);
  if (await liveSeatOfUser(db, u.id)) return json({ ok: false, error: "has_seat" }, 403);
  if (await liveSeatOfCity(db, squad.city_id)) return json({ ok: false, error: "city_taken" }, 409);
  const vp = await voterProblem(env, u, { scope: "city", place: squad.city_id, openedAt: iso(now), now });
  if (vp) return json({ ok: false, error: vp }, 403);
  try {
    await db.prepare("INSERT INTO squad_members (squad_id, user_id, wallet, joined_at) VALUES (?, ?, ?, ?)")
      .bind(squad.id, u.id, u.wallet, iso(now)).run();
  } catch (e) { if (/UNIQUE/i.test(String(e))) return json({ ok: false, error: "already_member" }, 409); throw e; }
  return json({ ok: true, squad: { id: squad.id, members: squad.members.length + 1 } });
}

/** POST /api/seats/squad/leave { squadId } — leave a forming squad (empties disband it). */
export async function handleSquadLeave(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  const squad = body && await db.prepare("SELECT * FROM squads WHERE id = ?").bind(Number(body.squadId) || 0).first();
  if (!squad || squad.status !== "forming") return json({ ok: false, error: "not_found" }, 404);
  await db.prepare("DELETE FROM squad_members WHERE squad_id = ? AND user_id = ?").bind(squad.id, u.id).run();
  const left = await db.prepare("SELECT COUNT(*) AS n FROM squad_members WHERE squad_id = ?").bind(squad.id).first();
  if (!left.n) await db.prepare("UPDATE squads SET status = 'disbanded' WHERE id = ?").bind(squad.id).run();
  return json({ ok: true });
}

/** GET /api/seats/squad/:id — the squad, its members, pooled seasoned balance, readiness. */
export async function handleSquadGet(env, id, now = Date.now(), fetchImpl = fetch) {
  const db = env.DB;
  const squad = await getSquad(db, Number(id) || 0);
  if (!squad) return json({ error: "not_found" }, 404);
  const threshold = await thresholdFor(env, squad.country, squad.city_id);
  const q = await qualifySquad(env, squad.id, threshold, now, fetchImpl);
  return json({
    squad: {
      id: squad.id, cityId: squad.city_id, city: squad.city_name, country: squad.country, status: squad.status,
      members: q.members.map((m) => ({ name: m.handle || "Member", wallet: mask(m.wallet), balance: m.balance, contribution: m.contribution, qualified: m.qualified, whyNot: m.whyNot })),
      pooled: q.pooled, threshold, ready: q.ok, whyNot: q.error || null,
      min: F.squadMin, max: F.squadMax,
    },
  });
}

/**
 * POST /api/seats/squad/apply { squadId, pitch, attestation } — the squad applies as one.
 * The calling member becomes the designated founder (their wallet takes the seat and mints);
 * all members are recorded as co-founders.
 */
export async function handleSquadApply(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await access(request, env, now, { fresh: true });
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const squad = body && await getSquad(db, Number(body.squadId) || 0);
  if (!squad || squad.status !== "forming") return json({ ok: false, error: "not_found" }, 404);
  if (!squad.members.some((m) => m.user_id === u.id)) return json({ ok: false, error: "not_member" }, 403);
  const threshold = await thresholdFor(env, squad.country, squad.city_id);
  const q = await qualifySquad(env, squad.id, threshold, now, fetchImpl);
  if (!q.ok) return json({ ok: false, error: q.error, pooled: q.pooled, threshold, members: q.members.map((m) => ({ name: m.handle || "Member", qualified: m.qualified, whyNot: m.whyNot })) }, 403);
  // The squad stands in the city like any applicant; its pooled stake replaces the personal one.
  const e = await eligibility(env, u, now, fetchImpl, { id: squad.city_id, name: squad.city_name, country: squad.country }, { skipStake: true });
  if (!e.ok) return json({ ok: false, error: e.error, threshold: e.threshold, whyNot: e.whyNot || null }, 403);
  const pitch = cleanText(body.pitch, 280);
  if (pitch == null) return json({ ok: false, error: "too_long", max: 280 }, 400);
  if (HAS_ADDRESS.test(pitch)) return json({ ok: false, error: "no_addresses" }, 400);
  const at = await useAttestation(env, body.attestation, { userId: u.id, purpose: "apply", now });
  if (!at.ok) return json({ ok: false, error: at.error }, 400);
  if (at.att.city !== squad.city_id) return json({ ok: false, error: "not_in_city", here: at.att.cityName || null }, 403);

  if (e.challenging) {
    const w = await openChallengeWindow(env, e, u, now, fetchImpl);
    if (!w) return json({ ok: false, error: "city_taken" }, 409);
    await db.prepare("INSERT INTO applications (window_id, city_id, user_id, wallet, squad_id, pitch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(w.id, e.cityId, u.id, u.wallet, squad.id, pitch || null, iso(now)).run();
    await db.prepare("UPDATE squads SET status = 'applied' WHERE id = ?").bind(squad.id).run();
    return json({ ok: true, challenge: true, squad: squad.id, window: { id: w.id, cityId: w.city_id, closesAt: w.closes_at } });
  }
  // A lone qualified squad becomes Seed Steward at once (tryGrantSteward marks it seated).
  const seat = await tryGrantSteward(env, e, u, pitch, squad.id, now);
  if (seat) return json({ ok: true, steward: true, squad: squad.id, seat: { id: seat.id, cityId: e.cityId, probationUntil: seat.probation_until } });

  // Lost the millisecond race: a standard 72-hour window decides instead.
  if (await liveSeatOfCity(db, e.cityId)) return json({ ok: false, error: "city_taken" }, 409);
  const w = await openWindow(env, { id: e.cityId, name: e.cityName, country: e.country, threshold: e.threshold }, now, fetchImpl);
  if (!w) return json({ ok: false, error: "city_taken" }, 409);
  await db.prepare("INSERT INTO applications (window_id, city_id, user_id, wallet, squad_id, pitch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(w.id, w.city_id, u.id, u.wallet, squad.id, pitch || null, iso(now)).run();
  await db.prepare("UPDATE squads SET status = 'applied' WHERE id = ?").bind(squad.id).run();
  return json({ ok: true, squad: squad.id, window: { id: w.id, cityId: w.city_id, closesAt: w.closes_at } });
}

/* ---------------- objections ---------------- */

/** POST /api/seats/object { seatId, reason } — a local (or the country's manager) objects to a founder. */
export async function handleObject(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  const seat = body && await db.prepare("SELECT * FROM seats WHERE id = ? AND status IN ('provisional', 'active', 'grace', 'steward')").bind(Number(body.seatId) || 0).first();
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
    db.prepare("UPDATE seats SET status = 'revoked', ended_at = ?, end_reason = 'objection_upheld' WHERE id = ? AND status IN ('provisional', 'active', 'grace', 'steward')").bind(iso(now), seat.id),
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

/** The squad behind a seat (if any): every co-founder, in join order. */
async function cofoundersOf(db, seat) {
  if (!seat.application_id) return null;
  const app = await db.prepare("SELECT squad_id FROM applications WHERE id = ?").bind(seat.application_id).first();
  if (!app || !app.squad_id) return null;
  const members = (await db.prepare(`SELECT u.handle, u.name FROM squad_members m JOIN users u ON u.id = m.user_id WHERE m.squad_id = ? ORDER BY m.joined_at`).bind(app.squad_id).all()).results;
  return { squadId: app.squad_id, members: members.map((m) => m.handle || m.name || "Member") };
}

/** GET /api/seats → every live seat and every open window (the map uses this). */
export async function handleSeats(env, now = Date.now()) {
  const db = env.DB;
  const [seats, windows] = await db.batch([
    db.prepare(`SELECT s.id, s.city_id, s.city_name, s.country, s.wallet, s.status, s.created_at, s.activated_at, s.appeal_until, s.grace_until, s.probation_until, s.application_id, u.handle, u.name
      FROM seats s JOIN users u ON u.id = s.user_id WHERE s.status IN ('provisional', 'active', 'grace', 'steward') ORDER BY s.id DESC`),
    db.prepare(`SELECT w.id, w.city_id, w.city_name, w.country, w.opened_at, w.closes_at, w.threshold,
      (SELECT COUNT(*) FROM applications a WHERE a.window_id = w.id AND a.withdrawn = 0) AS applicants
      FROM windows w WHERE w.status = 'open' ORDER BY w.closes_at`),
  ]);
  const seatViews = [];
  for (const s of seats.results) {
    seatViews.push({ id: s.id, cityId: s.city_id, city: s.city_name, country: s.country, status: s.status,
      founder: s.handle || s.name || mask(s.wallet), wallet: s.wallet, since: s.activated_at || s.created_at,
      appealUntil: s.appeal_until, graceUntil: s.grace_until, probationUntil: s.probation_until,
      cofounders: await cofoundersOf(db, s) });
  }
  return json({
    launched: true,
    seats: seatViews,
    windows: windows.results.map((w) => ({ id: w.id, cityId: w.city_id, city: w.city_name, country: w.country, openedAt: w.opened_at, closesAt: w.closes_at, applicants: w.applicants, threshold: w.threshold })),
  });
}

/** A city's founder picture: the live seat, the open window (with applicants), the last result. */
export async function cityPicture(env, cityId, viewer, now = Date.now()) {
  const db = env.DB;
  const seat = await db.prepare("SELECT s.*, u.handle, u.name FROM seats s JOIN users u ON u.id = s.user_id WHERE s.city_id = ? AND s.status IN ('provisional', 'active', 'grace', 'steward')").bind(cityId).first();
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
      appealUntil: seat.appeal_until, graceUntil: seat.grace_until, probationUntil: seat.probation_until, you: Boolean(viewer && seat.user_id === viewer.id), openObjections: objections,
      threshold: seat.threshold, policy: seat.policy, cofounders: await cofoundersOf(db, seat) } : null,
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
