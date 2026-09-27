/**
 * Who is asking, and may they? Shared by every signed-in action.
 */
import { json, sameSite } from "./http.js";
import { getSession, isFresh } from "./auth.js";
import { ensureSchema } from "./store.js";
import { DAY, POLICY, iso } from "./policy.js";
import { activeBan } from "./roles.js";

/**
 * { s, u } for a signed-in person, or { error: Response }.
 *   write: the request changes something (must come from this site)
 *   fresh: a sensitive action (the wallet must have been proven in the last 30 minutes)
 */
export async function access(request, env, now = Date.now(), { write = true, fresh = false } = {}) {
  if (write && !sameSite(request)) return { error: json({ ok: false, error: "wrong_origin" }, 403) };
  const s = await getSession(env, request, now);
  if (!s || !s.user) return { error: json({ ok: false, error: "sign_in" }, 401) };
  await ensureSchema(env.DB);
  if (fresh && !isFresh(s, now)) return { error: json({ ok: false, error: "reprove" }, 403) };
  return { s, u: s.user };
}

/**
 * May this person vote (endorse a founder applicant, or elect a country manager) in a vote that opened
 * at `openedAt`? One person, one vote, and only real locals: an account and a home community set at
 * least 7 days before the vote opened, and at least one check-in there (being physically present).
 * Returns null if yes, or the reason why not.
 */
export async function voterProblem(env, u, { scope, place, openedAt, now = Date.now() }) {
  const since = Date.parse(openedAt) - POLICY.voters.minAccountDays * DAY;
  if (scope === "city" ? u.home_city !== place : u.home_country !== place) return "not_local";
  if (Date.parse(u.created_at) > since) return "account_too_new";
  if (!u.home_at || Date.parse(u.home_at) > Date.parse(openedAt) - POLICY.voters.minHomeDays * DAY) return "home_too_new";
  if (POLICY.voters.needsCheckin) {
    const c = await env.DB.prepare(`SELECT id FROM posts WHERE user_id = ? AND kind = 'checkin' AND hidden = 0 AND ${scope === "city" ? "place" : "country"} = ? LIMIT 1`)
      .bind(u.id, place).first();
    if (!c) return "needs_checkin";
  }
  if (await activeBan(env.DB, u.id, u.home_country, now)) return "banned";
  return null;
}

export const hoursFrom = (ms, h) => iso(ms + h * 3600_000);
