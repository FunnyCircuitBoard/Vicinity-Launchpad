/**
 * Location, handled in exactly one place (POST /api/locate):
 *   GPS point + internet-connection check → which community you're in → a signed "city attestation"
 *   that lasts 5 minutes and works once, for one purpose. The coordinates are then thrown away:
 *   they're never stored, logged, or passed to any other part of the site. Everything else
 *   (home community, founder applications, check-ins, town requests) only ever sees the attestation.
 *
 * Risk checks (VPN / proxy / far-away network / imprecise GPS) all return the same generic answer,
 * so nobody can probe which signal they tripped.
 */
import { json, readJson, sameSite, b64url } from "./http.js";
import { getSession } from "./auth.js";
import { ensureSchema } from "./store.js";
import { MAX_LOCATION_ACCURACY_M, cleanLocation } from "./cities.js";
import { networkCheck } from "./network.js";
import { locate } from "./community.js";
import { POLICY, HOUR, iso } from "./policy.js";

const PURPOSES = ["home", "apply", "checkin", "request"];
let keyCache = null;

/** The signing key: the ATTEST_KEY setting, or one made once and kept in the database. */
async function signingKey(env) {
  if (keyCache && keyCache.env === env) return keyCache.key;
  let secret = env.ATTEST_KEY;
  if (!secret) {
    await ensureSchema(env.DB);
    const fresh = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('attest_key', ?)").bind(fresh).run();
    secret = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'attest_key'").first()).value;
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  keyCache = { env, key };
  return key;
}
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
const dec = (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))));

export async function issueAttestation(env, payload) {
  const body = enc(payload);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

/**
 * Check an attestation for this person and purpose, and use it up (it works once).
 * Returns { ok: true, att } or { ok: false, error }.
 */
export async function useAttestation(env, token, { userId, purpose, now = Date.now() }) {
  if (typeof token !== "string" || token.length > 3000 || !token.includes(".")) return { ok: false, error: "location_required" };
  const [body, sig] = token.split(".");
  let good = false;
  try {
    const bytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((sig.length + 3) % 4)), (c) => c.charCodeAt(0));
    good = await crypto.subtle.verify("HMAC", await signingKey(env), bytes, new TextEncoder().encode(body));
  } catch { good = false; }
  if (!good) return { ok: false, error: "location_required" };
  let att;
  try { att = dec(body); } catch { return { ok: false, error: "location_required" }; }
  if (att.v !== 1 || att.uid !== userId || att.purpose !== purpose) return { ok: false, error: "location_required" };
  if (Date.parse(att.exp) <= now) return { ok: false, error: "location_expired" };
  await ensureSchema(env.DB);
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO used_nonces (nonce, expires_at) VALUES (?, ?)").bind(att.nonce, att.exp).run();
  if (!ins.meta.changes) return { ok: false, error: "location_expired" };
  return { ok: true, att };
}

/** How many times did this person do `kind` since `sinceMs`? (for rate limits) */
export async function countRecent(env, userId, kind, sinceMs) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE user_id = ? AND kind = ? AND at >= ?").bind(userId, kind, iso(sinceMs)).first();
  return r?.n || 0;
}
export const noteEvent = (env, userId, kind, now) =>
  env.DB.prepare("INSERT INTO rate_events (user_id, kind, at) VALUES (?, ?, ?)").bind(userId, kind, iso(now)).run();

/**
 * POST /api/locate { location: { lat, lon, accuracy }, purpose, country? }
 * → { ok, city: { id, name, country } | null, nearby: [...] | null, attestation, expiresAt }
 */
export async function handleLocate(request, env, now = Date.now(), cf = request.cf) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  const s = await getSession(env, request, now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  const body = await readJson(request);
  if (!body || !PURPOSES.includes(body.purpose)) return json({ ok: false, error: "bad_request" }, 400);
  const u = s.user;
  if (await countRecent(env, u.id, "locate", now - HOUR) >= POLICY.limits.locatePerHour) return json({ ok: false, error: "slow_down" }, 429);
  await noteEvent(env, u.id, "locate", now);

  const loc = cleanLocation(body.location);
  if (!loc) return json({ ok: false, error: "location_required" }, 400);
  // One generic answer for every risk signal (imprecise GPS, VPN, proxy, far-away network).
  const unverified = json({ ok: false, error: "location_unverified" }, 403);
  if (loc.accuracy > MAX_LOCATION_ACCURACY_M) return unverified;
  const cc = (cf && /^[A-Z]{2}$/.test(cf.country || "") && cf.country) || (!cf && /^[A-Z]{2}$/.test(body.country || "") ? body.country : null);
  if (!cc) return unverified;
  if (networkCheck(cf, loc, cc)) return unverified;

  let found;
  try { found = await locate(env, cc, loc.lon, loc.lat); } catch { return json({ ok: false, error: "cities_unavailable" }, 503); }
  if (!found) return unverified;
  // From here on only the community is used. The coordinates are not kept anywhere.
  const exp = iso(now + POLICY.attestation.minutes * 60_000);
  const att = {
    v: 1, uid: u.id, wallet: u.wallet, purpose: body.purpose, country: cc,
    city: found.city ? found.city.id : null, cityName: found.city ? found.city.name : null,
    nearby: found.city ? null : found.nearby.map((c) => ({ id: c.id, name: c.name, km: Math.round(c.km / 5) * 5 })),
    nonce: b64url(crypto.getRandomValues(new Uint8Array(12))), iat: iso(now), exp,
  };
  return json({ ok: true, city: found.city, nearby: att.nearby, attestation: await issueAttestation(env, att), expiresAt: exp });
}
