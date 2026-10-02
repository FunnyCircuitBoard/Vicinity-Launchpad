/**
 * Hand-offs: finish one step in the phone's normal browser when a wallet app's own browser can't.
 *
 * Wallet apps open web pages in an embedded browser that often can't share GPS with the page. So:
 *   1. In the wallet app (signed in):  POST /api/locate/handoff { purpose }       → a one-time link
 *   2. In Safari / Chrome (no sign-in): the link opens /locate, which reads GPS and sends it with
 *      POST /api/locate/handoff/complete { code, location }. The same checks as /api/locate run.
 *   3. Back in the wallet app:          POST /api/locate/handoff/claim { code }   → the 5-minute city attestation
 *
 * Safety: the code is random and lasts 10 minutes. Only the account that started it can claim the result, and
 * the result is deleted when claimed. The browser that completes it must come from the same internet connection
 * (same country and network operator) as the one that started it, so the link can't be handed to a friend in
 * another town to answer for you. The coordinates are never stored: only the attestation (a community) is.
 */
import { json, randomToken, readJson, sameSite, sha256 } from "./http.js";
import { getSession } from "./auth.js";
import { PURPOSES, checkLocation, countRecent, makeAttestation, noteEvent } from "./attest.js";
import { HOUR, POLICY, iso } from "./policy.js";

const MINUTES = 10;
/** Where the person's connection is, coarsely: country and network operator. null off Cloudflare (local tests). */
const netOf = (cf) => (cf ? `${cf.country || ""}|${cf.asn || ""}` : null);

async function find(env, code, now) {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
  const row = await env.DB.prepare("SELECT * FROM handoffs WHERE id = ? AND kind = 'locate'").bind(await sha256(code)).first();
  return row && Date.parse(row.expires_at) > now ? row : null;
}

/** POST /api/locate/handoff { purpose } → { code, url, expiresAt } (signed in). */
export async function handleHandoffStart(request, env, now = Date.now(), cf = request.cf) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  const s = await getSession(env, request, now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  const body = await readJson(request);
  if (!body || !PURPOSES.includes(body.purpose)) return json({ ok: false, error: "bad_request" }, 400);
  if (await countRecent(env, s.user.id, "handoff", now - HOUR) >= 10) return json({ ok: false, error: "slow_down" }, 429);
  await noteEvent(env, s.user.id, "handoff", now);
  const code = randomToken(18);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM handoffs WHERE kind = 'locate' AND (user_id = ? OR expires_at < ?)").bind(s.user.id, iso(now)),
    env.DB.prepare("INSERT INTO handoffs (id, kind, user_id, purpose, net, created_at, expires_at) VALUES (?, 'locate', ?, ?, ?, ?, ?)")
      .bind(await sha256(code), s.user.id, body.purpose, netOf(cf), iso(now), iso(now + MINUTES * 60_000)),
  ]);
  return json({ ok: true, code, url: `${new URL(request.url).origin}/locate?code=${code}`, expiresAt: iso(now + MINUTES * 60_000) });
}

/** POST /api/locate/handoff/info { code } → what the link is for (the page in the phone's browser; no sign-in). */
export async function handleHandoffInfo(request, env, now = Date.now()) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  const body = await readJson(request);
  const row = body && await find(env, body.code, now);
  if (!row) return json({ ok: false, error: "expired" }, 410);
  return json({ ok: true, purpose: row.purpose, done: Boolean(row.result), expiresAt: row.expires_at });
}

/** POST /api/locate/handoff/complete { code, location, country? } → runs the usual checks, keeps only the attestation. */
export async function handleHandoffComplete(request, env, now = Date.now(), cf = request.cf) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  const body = await readJson(request);
  const row = body && await find(env, body.code, now);
  if (!row) return json({ ok: false, error: "expired" }, 410);
  if (row.result) return json({ ok: false, error: "already_done" }, 409);
  // Same connection as the wallet app that asked: the phone's own network (one generic answer when it differs).
  if (cf && row.net && netOf(cf) !== row.net) return json({ ok: false, error: "location_unverified" }, 403);
  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(row.user_id).first();
  if (!u) return json({ ok: false, error: "expired" }, 410);
  if (await countRecent(env, u.id, "locate", now - HOUR) >= POLICY.limits.locatePerHour) return json({ ok: false, error: "slow_down" }, 429);
  await noteEvent(env, u.id, "locate", now);
  const checked = await checkLocation(env, body.location, body, cf);
  if (checked.error) return checked.error;
  const made = await makeAttestation(env, u, row.purpose, checked, now);
  const stored = await env.DB.prepare("UPDATE handoffs SET result = ? WHERE id = ? AND result IS NULL").bind(JSON.stringify(made), row.id).run();
  if (!stored.meta.changes) return json({ ok: false, error: "already_done" }, 409);
  // The phone's browser only learns the community, so it can say "you're in Utica ✓". The attestation stays on the server.
  return json({ ok: true, city: made.city ? made.city.name : null, nearby: made.nearby ? made.nearby.map((c) => c.name) : null });
}

/** POST /api/locate/handoff/claim { code } → { ok, attestation… } once the phone's browser has answered, else { status: "waiting" }. */
export async function handleHandoffClaim(request, env, now = Date.now()) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  const s = await getSession(env, request, now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  const body = await readJson(request);
  const row = body && await find(env, body.code, now);
  if (!row || row.user_id !== s.user.id) return json({ ok: false, status: "expired" }, 410);
  if (!row.result) return json({ ok: false, status: "waiting" });
  const gone = await env.DB.prepare("DELETE FROM handoffs WHERE id = ? AND result IS NOT NULL").bind(row.id).run();
  if (!gone.meta.changes) return json({ ok: false, status: "expired" }, 410); // claimed a moment ago by another tab
  return json({ ok: true, ...JSON.parse(row.result) });
}
