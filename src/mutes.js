/**
 * Mute (feed v2, only while FEED_V2=on; otherwise src/index.js answers "not found" as for any unknown path).
 *
 *   POST /api/mute  { user, on }   mute (on: true) or unmute (on: false) a member by username
 *   GET  /api/mutes                the members you muted (nobody else ever sees this)
 *
 * A mute is your own view and nothing more: the muted member's posts and replies leave YOUR feeds (src/social.js handlePosts),
 * they can still follow you, open your profile and reply to you, and they are never told. So, unlike a block, anybody can be
 * muted, admins included. Rules, kept here in one place:
 *   - signed in, a real member (not a test-lab row); 60 mute / unmute actions an hour (the same counter the profile routes use)
 *   - you cannot mute yourself; at most 1,000 people; muting someone twice is a quiet yes (one row per pair, the database enforces it)
 *   - muting needs a member you can see; unmuting works for anybody (also one hidden since) and answers the same whether the
 *     username is shown, hidden or nobody's, so letting go is never a way to find out (the same rule as a block)
 *   - the whole check and write is ONE statement, so parallel taps cannot pass the cap
 */
import { json, readJson } from "./http.js";
import { access } from "./access.js";
import { ensureFeedSchema, ensureLimitsSchema } from "./store.js";
import { iso } from "./policy.js";
import { SHOWN, parseHandle, within } from "./profile-core.js";

export const MAX_MUTES = 1000;

const MUTE = `INSERT INTO mutes (muter_id, muted_id, created_at)
  SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2) AND (SELECT COUNT(*) FROM mutes WHERE muter_id = ?1) < ?4
  ON CONFLICT (muter_id, muted_id) DO NOTHING`;

/**
 * The member called `handle` as a mute target: { id } when they exist and the viewer may see them (SHOWN: a username, not a test-lab
 * row, no active ban), else null. Only the id is read: the profile columns (users.bio) need not exist, PROFILES may be off.
 */
const target = (db, handle, viewerId, now) => db.prepare(`SELECT u.id FROM users u WHERE u.handle IS NOT NULL AND lower(u.handle) = lower(?1) AND (u.id = ?3 OR (${SHOWN("u", "?2")}))`)
  .bind(handle, iso(now), viewerId).first();

/** A signed-in, real member with the feed tables in place, or { error }. */
async function member(request, env, now, { write }) {
  const a = await access(request, env, now, { write });
  if (a.error) return a;
  if (a.u.provider === "testlab") return { error: json({ ok: false, error: "sign_in" }, 401) };
  try { await ensureFeedSchema(env.DB); await ensureLimitsSchema(env.DB); }
  catch (e) {
    console.error("feed tables unavailable", String((e && e.message) || e).slice(0, 80));
    return { error: json({ ok: false, error: "feed_unavailable" }, 503) };
  }
  return a;
}

/** POST /api/mute { user, on } */
export async function handleMute(request, env, now = Date.now()) {
  const g = await member(request, env, now, { write: true });
  if (g.error) return g.error;
  const { u } = g, db = env.DB;
  const body = await readJson(request);
  const h = parseHandle(body && body.user);
  if (!h || typeof body.on !== "boolean") return json({ ok: false, error: "bad_request" }, 400);
  if (!(await within(env, "mute", u.id, now))) return json({ ok: false, error: "slow_down" }, 429);
  const who = await target(db, h, u.id, now);
  if (who && who.id === u.id) return json({ ok: false, error: "self" }, 400);
  if (!body.on) {
    await db.prepare("DELETE FROM mutes WHERE muter_id = ?1 AND muted_id IN (SELECT u.id FROM users u WHERE u.handle IS NOT NULL AND lower(u.handle) = lower(?2))").bind(u.id, h).run();
    return json({ ok: true, muted: false });
  }
  if (!who) return json({ ok: false, error: "not_found" }, 404);
  const [, state] = await db.batch([
    db.prepare(MUTE).bind(u.id, who.id, iso(now), MAX_MUTES),
    db.prepare("SELECT EXISTS (SELECT 1 FROM mutes WHERE muter_id = ?1 AND muted_id = ?2) AS muted, (SELECT COUNT(*) FROM mutes WHERE muter_id = ?1) AS mine").bind(u.id, who.id),
  ]);
  const s = state.results[0];
  if (s.muted) return json({ ok: true, muted: true });
  if (s.mine >= MAX_MUTES) return json({ ok: false, error: "too_many_mutes" }, 409);
  return json({ ok: false, error: "not_found" }, 404);
}

/** GET /api/mutes → the members you muted, newest first (nobody else ever sees this). */
export async function handleMutes(request, env, now = Date.now()) {
  const g = await member(request, env, now, { write: false });
  if (g.error) return g.error;
  if (!(await within(env, "list", g.u.id, now))) return json({ ok: false, error: "slow_down" }, 429);
  const rows = (await env.DB.prepare(
    `SELECT u.handle FROM mutes m JOIN users u ON u.id = m.muted_id WHERE m.muter_id = ?1 AND u.handle IS NOT NULL
      ORDER BY m.created_at DESC, m.muted_id DESC LIMIT ${MAX_MUTES}`).bind(g.u.id).all()).results;
  return json({ ok: true, users: rows.map((r) => ({ handle: r.handle })) });
}
