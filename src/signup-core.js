/**
 * The small pieces of the new sign-up (SIGNUP_FLOW=v2) that src/auth.js needs as well. They live here, and not in
 * src/signup.js, so that auth.js never imports the handlers that import auth.js (no import cycle).
 *
 * A sign-up is ONE row in `signups`, found through the `vsu` cookie (a random token: only its SHA-256 is stored).
 * It holds what the person has proven so far: Terms version, community (never coordinates), a verified Google id or
 * e-mail (+ the password hash), and nothing else. The account itself is only created at the very end, in one
 * atomic step (finish in src/signup.js). The row lives 60 minutes from the last request, and never longer than
 * 3 hours in all, and is deleted when the account is made or when the person signs in to an existing account.
 */
import { clearCookie, cookie, getCookie, json, randomToken, sameSite, sha256 } from "./http.js";
import { ensureSignupSchema } from "./store.js";
import { DAY, iso } from "./policy.js";

export const SIGNUP_COOKIE = "vsu";
/** The Terms of Use version a person accepts at sign-up. One constant (a test checks it is the version shown on /terms). */
export const TERMS_VERSION = "2026-10-01";
const SLIDE_SECONDS = 3600;        // the sign-up lives an hour from the last request ...
const CAP_SECONDS = 3 * 3600;      // ... and never more than three hours from the first

/**
 * What every v2 route checks first: a request that changes something must come from this site (Origin), the database
 * must be there, and the sign-up tables must exist (they are created the first time they are needed: a failure there
 * answers 503 and breaks only the new sign-up, never the rest of the site). Returns a Response to send, or null.
 */
export async function guardV2(request, env) {
  if (request.method !== "GET" && !sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  if (!env.DB) return json({ ok: false, error: "accounts_unavailable" }, 503);
  try { await ensureSignupSchema(env.DB); }
  catch (e) {
    console.error("sign-up tables unavailable", String((e && e.message) || e));
    return json({ ok: false, error: "signup_unavailable" }, 503);
  }
  return null;
}

/**
 * A request field as text: strings and numbers only. Anything else (null, an array, an object, even one whose toString is not a
 * function, which makes String() throw) becomes "", so it fails the ordinary checks (bad_email, bad_code, bad_choice) and never a 500.
 */
export const asText = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

/** Where the person's connection is, coarsely: country and network operator ("US|7922"). null off Cloudflare (local tests). */
export const netOf = (cf) => (cf ? `${cf.country || ""}|${cf.asn || ""}` : null);

const expiryFor = (now, createdMs) => Math.min(now + SLIDE_SECONDS * 1000, createdMs + CAP_SECONDS * 1000);

/** The live sign-up of this browser (its `vsu` cookie), or null. Callers have run ensureSignupSchema. */
export async function getSignup(env, request, now = Date.now()) {
  const token = getCookie(request, SIGNUP_COOKIE);
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare("SELECT * FROM signups WHERE id = ?").bind(await sha256(token)).first();
  return row && Date.parse(row.expires_at) > now ? row : null;
}

/** A new, empty sign-up with a fresh random token (never reuses a token the browser sent: no fixation). Returns { id, cookie }. */
export async function startSignup(env, now = Date.now()) {
  const token = randomToken(32);
  const id = await sha256(token);
  const exp = expiryFor(now, now);
  await env.DB.prepare("INSERT INTO signups (id, created_at, expires_at) VALUES (?, ?, ?)").bind(id, iso(now), iso(exp)).run();
  return { id, cookie: cookie(SIGNUP_COOKIE, token, Math.floor((exp - now) / 1000)) };
}

/** Another hour from now (capped at three hours from the start). Returns the refreshed cookie to send back. */
export async function touchSignup(env, row, request, now = Date.now()) {
  const exp = expiryFor(now, Date.parse(row.created_at));
  await env.DB.prepare("UPDATE signups SET expires_at = ? WHERE id = ? AND expires_at > ?").bind(iso(exp), row.id, iso(now)).run();
  return cookie(SIGNUP_COOKIE, getCookie(request, SIGNUP_COOKIE) || "", Math.max(0, Math.floor((exp - now) / 1000)));
}

/**
 * Throw away this browser's half-done sign-up (and any hand-off bound to it). Returns the Set-Cookie values that clear the
 * `vsu` cookie ([] when the request carried none). Never throws: a person who just signed in must not fail on tidying up.
 */
export async function endSignup(env, request) {
  const token = getCookie(request, SIGNUP_COOKIE);
  if (!token) return [];
  if (token.length <= 100) {
    try {
      await ensureSignupSchema(env.DB);
      const id = await sha256(token);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM handoffs WHERE signup_id = ?").bind(id),
        env.DB.prepare("DELETE FROM signups WHERE id = ?").bind(id),
      ]);
    } catch (e) { console.error("ending the sign-up failed", String((e && e.message) || e)); }
  }
  return [clearCookie(SIGNUP_COOKIE)];
}

/**
 * The first step still open, in the order the page asks for them: location, then terms + account, then the wallet,
 * then "finish". `walletDone` = a wallet was proven in this browser in the last 30 minutes (the pending `vs` session).
 */
export function nextStep(row, walletDone) {
  if (!row.loc_city) return "location";
  if (!(row.terms_version === TERMS_VERSION && row.identity_at)) return "account";
  return walletDone ? "finish" : "wallet";
}

/**
 * A verified Google login belongs to this sign-up now. No account is made here. Needs the Terms to be accepted
 * first. Returns { recorded, to, cookie } (to = the /connect step the page continues with) or { error }.
 * Errors are the /connect?error= codes of the Google callback, so a sign-up that ran out of time reads "expired".
 */
export async function recordIdentity(env, request, provider, who, now, { walletDone = false } = {}) {
  try { await ensureSignupSchema(env.DB); }
  catch (e) { console.error("sign-up tables unavailable", String((e && e.message) || e)); return { error: "login_unavailable" }; }
  const row = await getSignup(env, request, now);
  if (!row) return { error: "login_expired" };
  if (row.terms_version !== TERMS_VERSION) return { error: "terms_required" };
  const r = await env.DB.prepare(
    `UPDATE signups SET provider = ?, provider_id = ?, identity_name = ?, identity_at = ?, pending_email = NULL, pending_pw_hash = NULL
      WHERE id = ? AND terms_version = ? AND expires_at > ?`)
    .bind(provider, who.id, who.name, iso(now), row.id, TERMS_VERSION, iso(now)).run();
  if (!r.meta.changes) return { error: "login_expired" };
  const next = nextStep({ ...row, provider, provider_id: who.id, identity_at: iso(now) }, walletDone);
  return { recorded: true, to: `/connect?step=${next}`, cookie: await touchSignup(env, row, request, now) };
}

/** A phone-browser hand-off row by its code (the same lookup src/handoff.js does, without importing it). */
export async function findHandoff(env, code, now) {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
  const row = await env.DB.prepare("SELECT * FROM handoffs WHERE id = ? AND kind = 'locate'").bind(await sha256(code)).first();
  return row && Date.parse(row.expires_at) > now ? row : null;
}

/**
 * The scheduled tidy-up: expired sign-ups and old attempt counters. The job calls it only while the switch is on (with it off
 * no sign-up statement may run: the tables may not exist), so rows left by a switch-off wait for the next switch-on, or for the
 * two DELETEs in docs/DEPLOY.md. Stays silent when the tables were never created. Never throws.
 */
export async function cleanupSignups(env, now) {
  // One statement at a time: member profiles make `auth_limits` without making `signups`, and a table that is missing
  // must never stop the other one from being tidied.
  for (const stmt of [
    env.DB.prepare("DELETE FROM signups WHERE expires_at < ?").bind(iso(now)),
    env.DB.prepare("DELETE FROM auth_limits WHERE window_start < ?").bind(iso(now - DAY)),
  ]) {
    try {
      await stmt.run();
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!/no such table/i.test(msg)) console.error("signup cleanup failed", msg);
    }
  }
}
