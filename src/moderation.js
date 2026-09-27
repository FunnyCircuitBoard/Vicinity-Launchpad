/**
 * Moderation that no single person can abuse:
 *   Hide     a founder (their city), a manager (their country) or an admin hides a post with a reason.
 *            It comes back after 24 hours unless a SECOND moderator confirms it, or 3+ people reported it.
 *   Unhide   any moderator in scope can undo a pending hide; a confirmed hide needs a manager or admin.
 *   Ban      a manager (their country) or an admin PROPOSES; a DIFFERENT person approves (an admin, or
 *            the country's manager). Bans last 30 days. Proposals expire after 72 hours.
 *   Appeal   the person affected can appeal once; someone who wasn't involved decides.
 *   Log      every action is public at /api/audit: who (role and name), what, why, and what happened.
 * Founders and managers must still hold their founder amount (checked live) to act, and must have
 * proven their wallet in the last 30 minutes.
 */
import { json, readJson } from "./http.js";
import { access } from "./access.js";
import { useAttestation } from "./attest.js";
import { POLICY, HOUR, DAY, iso } from "./policy.js";
import { adminWallets, canModerate, managerOf, powersOf } from "./roles.js";
import { stillFounder } from "./seats.js";
import { CITY_NAME_RE } from "./solana.js";
import { cleanText } from "./text.js";
import { COLS, FROM, present } from "./social.js";

const MOD = POLICY.moderation;

/** A moderator for this request: fresh proof, and founders / managers must still hold (live). */
async function moderator(request, env, now, fetchImpl) {
  const a = await access(request, env, now, { fresh: true });
  if (a.error) return a;
  const pw = await powersOf(env, a.u, fetchImpl, now);
  if (!pw.admin && pw.founderCity && !(await stillFounder(env, pw.seat, now, fetchImpl))) {
    return { error: json({ ok: false, error: "in_grace" }, 403) };
  }
  return { u: a.u, pw };
}
const roleFor = (pw, country) => (pw.admin ? "admin" : pw.managerCountry && pw.managerCountry === country ? "manager" : "founder");
const reasonOf = (r) => (MOD.reasons.includes(r) ? r : null);

function logAction(db, a) {
  return db.prepare(`INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, target_user, country, place, reason, note, created_at, expires_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(a.actor ?? null, a.role, a.action, a.type, a.id ?? null, a.user ?? null, a.country ?? null, a.place ?? null, a.reason, a.note ?? null, a.at, a.expires ?? null, a.state || "done");
}

/** POST /api/mod/hide { id, reason, note } — hide a post (or confirm another moderator's hide). */
export async function handleHide(request, env, fetchImpl = fetch, now = Date.now()) {
  const m = await moderator(request, env, now, fetchImpl);
  if (m.error) return m.error;
  const { u, pw } = m, db = env.DB;
  const body = await readJson(request);
  const post = body && await db.prepare("SELECT * FROM posts WHERE id = ?").bind(Number(body.id) || 0).first();
  if (!post) return json({ ok: false, error: "not_found" }, 404);
  if (!canModerate(pw, post)) return json({ ok: false, error: "not_allowed" }, 403);
  if (post.user_id === u.id) return json({ ok: false, error: "own_post" }, 400);
  const reason = reasonOf(body.reason);
  if (!reason) return json({ ok: false, error: "reason_required" }, 400);
  const note = cleanText(body.note, 200) || null;
  const role = roleFor(pw, post.country);
  const pending = await db.prepare("SELECT * FROM mod_actions WHERE target_type = 'post' AND target_id = ? AND action = 'hide' AND state = 'pending' ORDER BY id DESC LIMIT 1").bind(post.id).first();

  if (post.hidden && pending) {
    if (pending.actor_id === u.id) return json({ ok: false, error: "needs_second_moderator" }, 409);
    await db.batch([
      db.prepare("UPDATE posts SET hide_confirmed = 1, hidden_until = NULL WHERE id = ?").bind(post.id),
      db.prepare("UPDATE mod_actions SET state = 'confirmed', second_id = ?, second_at = ? WHERE id = ?").bind(u.id, iso(now), pending.id),
      logAction(db, { actor: u.id, role, action: "confirm_hide", type: "post", id: post.id, user: post.user_id, country: post.country, place: post.place, reason, note, at: iso(now) }),
    ]);
    return json({ ok: true, hidden: true, confirmed: true });
  }
  if (post.hidden) return json({ ok: false, error: "already_hidden" }, 409);
  const byReports = post.reports >= MOD.reportsToConfirm;
  const until = byReports ? null : iso(now + MOD.hideHours * HOUR);
  await db.batch([
    db.prepare("UPDATE posts SET hidden = 1, hide_confirmed = ?, hidden_until = ? WHERE id = ?").bind(byReports ? 1 : 0, until, post.id),
    logAction(db, { actor: u.id, role, action: "hide", type: "post", id: post.id, user: post.user_id, country: post.country, place: post.place, reason, note, at: iso(now), expires: until, state: byReports ? "confirmed" : "pending" }),
  ]);
  return json({ ok: true, hidden: true, confirmed: byReports, until });
}

/** POST /api/mod/unhide { id, note } */
export async function handleUnhide(request, env, fetchImpl = fetch, now = Date.now()) {
  const m = await moderator(request, env, now, fetchImpl);
  if (m.error) return m.error;
  const { u, pw } = m, db = env.DB;
  const body = await readJson(request);
  const post = body && await db.prepare("SELECT * FROM posts WHERE id = ?").bind(Number(body.id) || 0).first();
  if (!post || !post.hidden) return json({ ok: false, error: "not_found" }, 404);
  if (!canModerate(pw, post)) return json({ ok: false, error: "not_allowed" }, 403);
  const role = roleFor(pw, post.country);
  if (post.hide_confirmed && role === "founder") return json({ ok: false, error: "needs_manager" }, 403);
  await db.batch([
    db.prepare("UPDATE posts SET hidden = 0, hide_confirmed = 0, hidden_until = NULL, reports = 0 WHERE id = ?").bind(post.id),
    db.prepare("UPDATE mod_actions SET state = 'reversed' WHERE target_type = 'post' AND target_id = ? AND action = 'hide' AND state IN ('pending', 'confirmed')").bind(post.id),
    logAction(db, { actor: u.id, role, action: "unhide", type: "post", id: post.id, user: post.user_id, country: post.country, place: post.place, reason: "review", note: cleanText(body.note, 200) || null, at: iso(now) }),
  ]);
  return json({ ok: true, hidden: false });
}

/** POST /api/mod/ban { postId | userId, reason, note, everywhere } — PROPOSE a 30-day ban. */
export async function handleProposeBan(request, env, fetchImpl = fetch, now = Date.now()) {
  const m = await moderator(request, env, now, fetchImpl);
  if (m.error) return m.error;
  const { u, pw } = m, db = env.DB;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  let target = null, post = null;
  if (body.postId != null) {
    post = await db.prepare("SELECT * FROM posts WHERE id = ?").bind(Number(body.postId) || 0).first();
    if (post) target = await db.prepare("SELECT * FROM users WHERE id = ?").bind(post.user_id).first();
  } else target = await db.prepare("SELECT * FROM users WHERE id = ?").bind(Number(body.userId) || 0).first();
  if (!target) return json({ ok: false, error: "not_found" }, 404);
  if (target.id === u.id) return json({ ok: false, error: "own_account" }, 400);
  const reason = reasonOf(body.reason);
  if (!reason) return json({ ok: false, error: "reason_required" }, 400);
  const country = pw.admin && body.everywhere ? "*" : (post ? post.country : target.home_country);
  if (!pw.admin && !(pw.managerCountry && pw.managerCountry === country)) return json({ ok: false, error: "not_allowed" }, 403);
  const open = await db.prepare("SELECT id FROM mod_actions WHERE action = 'ban' AND state = 'proposed' AND target_user = ? AND country = ?").bind(target.id, country).first();
  if (open) return json({ ok: false, error: "already_proposed", actionId: open.id }, 409);
  const r = await logAction(db, { actor: u.id, role: roleFor(pw, country), action: "ban", type: post ? "post" : "user", id: post ? post.id : target.id, user: target.id,
    country, place: post ? post.place : null, reason, note: cleanText(body.note, 200) || null, at: iso(now), expires: iso(now + MOD.proposalHours * HOUR), state: "proposed" }).run();
  return json({ ok: true, proposed: true, actionId: r.meta.last_row_id, needs: "a second moderator (an admin or this country's manager) to approve" });
}

/** May this person be the second approver / decider of an action? (never someone already involved) */
async function canSecond(env, u, pw, action, now) {
  if ([action.actor_id, action.second_id, action.target_user].includes(u.id)) return false;
  if (pw.admin) return true;
  if (action.country === "*") return false;
  const mgr = await managerOf(env, action.country, now);
  return Boolean(mgr && mgr.userId === u.id);
}

/** POST /api/mod/ban/approve { actionId } · POST /api/mod/ban/reject { actionId } */
export async function handleBanDecision(request, env, approve, fetchImpl = fetch, now = Date.now()) {
  const m = await moderator(request, env, now, fetchImpl);
  if (m.error) return m.error;
  const { u, pw } = m, db = env.DB;
  const body = await readJson(request);
  const act = body && await db.prepare("SELECT * FROM mod_actions WHERE id = ? AND action = 'ban'").bind(Number(body.actionId) || 0).first();
  if (!act || act.state !== "proposed") return json({ ok: false, error: "not_found" }, 404);
  if (act.expires_at && Date.parse(act.expires_at) <= now) return json({ ok: false, error: "proposal_expired" }, 409);
  if (!(await canSecond(env, u, pw, act, now))) return json({ ok: false, error: act.actor_id === u.id ? "needs_second_moderator" : "not_allowed" }, 403);
  if (!approve) {
    await db.prepare("UPDATE mod_actions SET state = 'rejected', second_id = ?, second_at = ? WHERE id = ?").bind(u.id, iso(now), act.id).run();
    return json({ ok: true, banned: false });
  }
  const until = iso(now + MOD.banDays * DAY);
  const stmts = [
    db.prepare("INSERT OR REPLACE INTO bans (user_id, country, by_user, reason, created_at, expires_at, action_id) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(act.target_user, act.country, act.actor_id, act.reason, iso(now), until, act.id),
    db.prepare("UPDATE mod_actions SET state = 'approved', second_id = ?, second_at = ?, expires_at = ? WHERE id = ?").bind(u.id, iso(now), until, act.id),
  ];
  if (act.target_type === "post") stmts.push(db.prepare("UPDATE posts SET hidden = 1, hide_confirmed = 1, hidden_until = NULL WHERE id = ?").bind(act.target_id));
  await db.batch(stmts);
  return json({ ok: true, banned: true, until, country: act.country });
}

/** POST /api/appeals { actionId, text } — the person affected appeals a hide or a ban, once. */
export async function handleAppeal(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  const act = body && await db.prepare("SELECT * FROM mod_actions WHERE id = ?").bind(Number(body.actionId) || 0).first();
  if (!act || act.target_user !== u.id || !["hide", "ban"].includes(act.action) || !["pending", "confirmed", "approved"].includes(act.state)) {
    return json({ ok: false, error: "not_found" }, 404);
  }
  const text = cleanText(body.text, 1000);
  if (!text || text.length < 10) return json({ ok: false, error: "reason_required" }, 400);
  try {
    await db.prepare("INSERT INTO appeals (action_id, user_id, text, created_at) VALUES (?, ?, ?, ?)").bind(act.id, u.id, text, iso(now)).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return json({ ok: false, error: "already_appealed" }, 409);
    throw e;
  }
  return json({ ok: true });
}

/** POST /api/appeals/decide { id, overturn, note } — decided by someone not involved in the action. */
export async function handleDecideAppeal(request, env, fetchImpl = fetch, now = Date.now()) {
  const m = await moderator(request, env, now, fetchImpl);
  if (m.error) return m.error;
  const { u, pw } = m, db = env.DB;
  const body = await readJson(request);
  const ap = body && await db.prepare("SELECT * FROM appeals WHERE id = ? AND status = 'open'").bind(Number(body.id) || 0).first();
  if (!ap) return json({ ok: false, error: "not_found" }, 404);
  const act = await db.prepare("SELECT * FROM mod_actions WHERE id = ?").bind(ap.action_id).first();
  if (!(await canSecond(env, u, pw, act, now))) return json({ ok: false, error: "not_allowed" }, 403);
  const note = cleanText(body.note, 300) || null;
  const stmts = [db.prepare("UPDATE appeals SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?").bind(body.overturn ? "overturned" : "upheld", u.id, iso(now), note, ap.id)];
  if (body.overturn) {
    stmts.push(db.prepare("UPDATE mod_actions SET state = 'overturned' WHERE id = ?").bind(act.id));
    if (act.action === "ban") stmts.push(db.prepare("DELETE FROM bans WHERE action_id = ?").bind(act.id));
    if (act.target_type === "post") stmts.push(db.prepare("UPDATE posts SET hidden = 0, hide_confirmed = 0, hidden_until = NULL, reports = 0 WHERE id = ?").bind(act.target_id));
  }
  stmts.push(logAction(db, { actor: u.id, role: pw.admin ? "admin" : "manager", action: body.overturn ? "overturn" : "uphold", type: "appeal", id: ap.id, user: ap.user_id, country: act.country, reason: "appeal", note, at: iso(now) }));
  await db.batch(stmts);
  return json({ ok: true, status: body.overturn ? "overturned" : "upheld" });
}

/** The scheduled job's part: unconfirmed hides come back after 24 h; unapproved ban proposals expire. */
export async function expireModeration(env, now = Date.now()) {
  const db = env.DB;
  const due = (await db.prepare("SELECT id FROM posts WHERE hidden = 1 AND hide_confirmed = 0 AND hidden_until IS NOT NULL AND hidden_until <= ?").bind(iso(now)).all()).results;
  const stmts = [];
  for (const p of due) {
    stmts.push(db.prepare("UPDATE posts SET hidden = 0, hidden_until = NULL WHERE id = ? AND hide_confirmed = 0").bind(p.id));
    stmts.push(db.prepare("UPDATE mod_actions SET state = 'expired' WHERE target_type = 'post' AND target_id = ? AND action = 'hide' AND state = 'pending'").bind(p.id));
  }
  stmts.push(db.prepare("UPDATE mod_actions SET state = 'expired' WHERE action = 'ban' AND state = 'proposed' AND expires_at <= ?").bind(iso(now)));
  await db.batch(stmts);
  return { restored: due.length };
}

/** GET /api/mod — a moderator's to-do list, only for their area. */
export async function handleModQueue(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await access(request, env, now, { write: false });
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const pw = await powersOf(env, u, fetchImpl, now);
  if (!pw.admin && !pw.managerCountry && !pw.founderCity) return json({ ok: true, moderator: false });
  const [scope, args] = pw.admin ? ["1 = 1", []] : pw.managerCountry ? ["p.country = ?", [pw.managerCountry]] : ["p.scope = 'city' AND p.place = ?", [pw.founderCity]];
  const reported = (await db.prepare(`SELECT ${COLS} ${FROM} WHERE (p.reports > 0 OR (p.hidden = 1 AND p.hide_confirmed = 0)) AND ${scope} ORDER BY p.hidden DESC, p.reports DESC, p.id DESC LIMIT 50`).bind(...args).all()).results;
  const pendingBy = new Map((await db.prepare("SELECT target_id, actor_id FROM mod_actions WHERE target_type = 'post' AND action = 'hide' AND state = 'pending'").all()).results.map((r) => [r.target_id, r.actor_id]));
  const acts = (await db.prepare(`SELECT m.*, a.handle AS actor_handle, a.name AS actor_name, t.handle AS target_handle, t.name AS target_name FROM mod_actions m
    LEFT JOIN users a ON a.id = m.actor_id LEFT JOIN users t ON t.id = m.target_user
    WHERE m.action = 'ban' AND m.state = 'proposed' AND (? = 1 OR m.country = ?) ORDER BY m.id DESC LIMIT 50`).bind(pw.admin ? 1 : 0, pw.managerCountry || "").all()).results;
  const proposals = [];
  for (const x of acts) proposals.push({ id: x.id, target: x.target_handle || x.target_name || "Member", country: x.country, reason: x.reason, note: x.note,
    by: x.actor_handle || x.actor_name || x.actor_role, at: x.created_at, expiresAt: x.expires_at, canApprove: await canSecond(env, u, pw, x, now) });
  const aps = (await db.prepare(`SELECT ap.*, m.action, m.reason, m.country, m.actor_id, m.second_id, m.target_user, m.target_type, m.target_id, us.handle, us.name FROM appeals ap
    JOIN mod_actions m ON m.id = ap.action_id JOIN users us ON us.id = ap.user_id WHERE ap.status = 'open' AND (? = 1 OR m.country = ?) ORDER BY ap.id LIMIT 50`).bind(pw.admin ? 1 : 0, pw.managerCountry || "").all()).results;
  const appeals = [];
  for (const x of aps) if (await canSecond(env, u, pw, x, now)) appeals.push({ id: x.id, by: x.handle || x.name || "Member", action: x.action, reason: x.reason, text: x.text, at: x.created_at });
  const objections = pw.admin ? (await db.prepare(`SELECT o.id, o.reason, o.created_at, o.user_id, s.city_name, s.country, s.status, u.handle, u.name FROM objections o
    JOIN seats s ON s.id = o.seat_id JOIN users u ON u.id = s.user_id WHERE o.status = 'open' ORDER BY o.id LIMIT 50`).all()).results
    .filter((o) => o.user_id !== u.id).map((o) => ({ id: o.id, city: o.city_name, country: o.country, founder: o.handle || o.name, seatStatus: o.status, reason: o.reason, at: o.created_at })) : [];
  const towns = pw.admin || pw.managerCountry ? (await db.prepare(`SELECT r.*, us.handle, us.name AS by_name FROM town_requests r JOIN users us ON us.id = r.user_id
    WHERE r.status IN ('waiting', 'recommended', 'not_recommended') AND (? = 1 OR r.country = ?) ORDER BY r.id LIMIT 100`).bind(pw.admin ? 1 : 0, pw.managerCountry || "").all()).results
    .map((r) => ({ id: r.id, name: r.name, country: r.country, near: r.inside ? `inside ${r.near_name}` : r.near_name ? `about ${r.near_km} km from ${r.near_name}` : null, status: r.status, by: r.handle || r.by_name, at: r.created_at })) : [];
  const posts = await present(env, reported, u, pw, fetchImpl, now);
  for (const p of posts) p.pendingBy = pendingBy.has(p.id) ? (pendingBy.get(p.id) === u.id ? "you" : "another moderator") : null;
  return json({ ok: true, moderator: true, role: pw.admin ? "admin" : pw.managerCountry ? "manager" : "founder",
    scope: pw.admin ? "everywhere" : pw.managerCountry ? `country ${pw.managerCountry}` : `city ${pw.seat.city_name}`,
    reasons: MOD.reasons, posts, proposals, appeals, objections, towns });
}

/** GET /api/audit?country=XX — every moderation and seat decision, public. */
export async function handleAudit(env, url) {
  const cc = url.searchParams.get("country");
  const where = /^[A-Z]{2}$/.test(cc || "") ? "WHERE m.country = ? OR m.country = '*'" : "";
  const rows = (await env.DB.prepare(`SELECT m.id, m.actor_role, m.action, m.target_type, m.target_id, m.country, m.reason, m.note, m.created_at, m.state, m.second_at,
    a.handle, a.name FROM mod_actions m LEFT JOIN users a ON a.id = m.actor_id ${where} ORDER BY m.id DESC LIMIT 100`).bind(...(where ? [cc] : [])).all()).results;
  return json({ actions: rows.map((r) => ({ id: r.id, at: r.created_at, by: r.actor_role === "community" ? "Community reports" : `${r.handle || r.name || "Moderator"} (${r.actor_role})`,
    action: r.action, target: `${r.target_type} #${r.target_id}`, country: r.country, reason: r.reason, note: r.note, state: r.state, secondAt: r.second_at })) });
}

/* ---------------- "add my town" ---------------- */

/** POST /api/towns { name, attestation } — standing in the town. Stores the nearest community, never coordinates. */
export async function handleTownRequest(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const name = String(body.name || "").trim().replace(/\s+/g, " ");
  if (!CITY_NAME_RE.test(name)) return json({ ok: false, error: "bad_name" }, 400);
  if (await db.prepare("SELECT id FROM town_requests WHERE user_id = ? AND status IN ('waiting', 'recommended', 'not_recommended')").bind(u.id).first()) {
    return json({ ok: false, error: "one_at_a_time" }, 409);
  }
  const at = await useAttestation(env, body.attestation, { userId: u.id, purpose: "request", now });
  if (!at.ok) return json({ ok: false, error: at.error }, 400);
  const att = at.att, near = att.city ? { id: att.city, name: att.cityName, km: 0 } : att.nearby && att.nearby[0];
  const r = await db.prepare("INSERT INTO town_requests (user_id, name, country, near_id, near_name, near_km, inside, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(u.id, name, att.country, near ? near.id : null, near ? near.name : null, near ? near.km : null, att.city ? 1 : 0, iso(now)).run();
  return json({ ok: true, request: { id: r.meta.last_row_id, name, country: att.country, near: near ? (att.city ? `inside ${near.name}` : `about ${near.km} km from ${near.name}`) : null, status: "waiting" } });
}

/** GET /api/towns → your requests. */
export async function handleMyTowns(request, env, now = Date.now()) {
  const a = await access(request, env, now, { write: false });
  if (a.error) return a.error;
  const rows = (await env.DB.prepare("SELECT id, name, country, near_name, near_km, inside, status, note, created_at, decided_at FROM town_requests WHERE user_id = ? ORDER BY id DESC LIMIT 10").bind(a.u.id).all()).results;
  return json({ ok: true, requests: rows });
}

/**
 * POST /api/towns/decide { id, decision, note }
 *   the country's manager: "recommend" | "not_recommend"  (advice)
 *   an admin:              "approve" | "decline"            (final; boundaries are checked at the next map build)
 */
export async function handleTownDecision(request, env, fetchImpl = fetch, now = Date.now()) {
  const m = await moderator(request, env, now, fetchImpl);
  if (m.error) return m.error;
  const { u, pw } = m, db = env.DB;
  const body = await readJson(request);
  const r = body && await db.prepare("SELECT * FROM town_requests WHERE id = ?").bind(Number(body.id) || 0).first();
  if (!r) return json({ ok: false, error: "not_found" }, 404);
  if (["approved", "declined"].includes(r.status)) return json({ ok: false, error: "already_decided" }, 409);
  if (r.user_id === u.id) return json({ ok: false, error: "own_request" }, 403);
  const d = body.decision;
  const allowed = pw.admin ? ["approve", "decline", "recommend", "not_recommend"] : pw.managerCountry === r.country ? ["recommend", "not_recommend"] : [];
  if (!allowed.includes(d)) return json({ ok: false, error: "not_allowed" }, 403);
  const status = { approve: "approved", decline: "declined", recommend: "recommended", not_recommend: "not_recommended" }[d];
  const note = cleanText(body.note, 200) || null;
  await db.batch([
    db.prepare("UPDATE town_requests SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ?").bind(status, u.id, note, iso(now), r.id),
    logAction(db, { actor: u.id, role: pw.admin ? "admin" : "manager", action: `town_${d}`, type: "town", id: r.id, user: r.user_id, country: r.country, reason: "town_request", note, at: iso(now) }),
  ]);
  return json({ ok: true, status });
}

export const isAdmin = (env, u) => adminWallets(env).includes(u.wallet);
