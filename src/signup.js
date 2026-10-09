/**
 * The new sign-up (SIGNUP_FLOW=v2, onboarding v3): location → Terms + account (Google, or e-mail with a password) → the
 * account exists the instant the login is verified → dashboard. The wallet is linked later, from the dashboard
 * (src/walletlink.js). Every route here exists only when the switch is on (src/index.js answers 404 not_enabled otherwise).
 *
 *   POST /api/signup/start                       a fresh sign-up (cookie `vsu`), or the current one
 *   GET  /api/signup/state                       { state } (never coordinates, a full e-mail, or a hash)
 *   POST /api/signup/location { location, country? }   same checks as /api/locate; keeps only the community
 *   POST /api/signup/location/choice { id }      one of the three nearest, when the person is in empty land
 *   POST /api/signup/location/handoff            a one-time link so a phone's own browser can read the location
 *        .../handoff/info | /complete (the phone's browser, no cookie) | /claim (the wallet app collects the result)
 *   POST /api/signup/terms { version }           accept the Terms of Use (before ANY account step)
 *   POST /api/signup/account/reset               forget the account step only (to pick another Google / e-mail)
 *   POST /api/signup/email { email, password }   a 6-digit code to that address (the same answer for known and unknown ones)
 *   POST /api/signup/email/verify { email?, code }   a new address finishes the sign-up in the same call (the account is made,
 *                                                this browser is signed in); a known one signs that person in
 *   POST /api/signup/finish                      the same atomic step, for a page that reloads or retries (Google: the callback
 *                                                in src/auth.js runs it itself after GET /api/auth/google/start?signup=1)
 *
 * Only finishCore (src/signup-finish.js) ever creates an account, and only from rows in the database (the Terms, the
 * community and the identity of this sign-up), never from anything the page says. Nothing here logs an address, a code, a
 * password or a coordinate.
 */
import { json, randomToken, readJson, sha256 } from "./http.js";
import { cleanEmail, consumeEmailCode, getSession, linkIdentity, sendEmailCode, validEmail } from "./auth.js";
import { checkLocation, communityOf } from "./attest.js";
import { communityById } from "./community.js";
import { emailConfigured } from "./mail.js";
import { check, clientKey, limitKey } from "./limits.js";
import { checkPassword, hashPassword } from "./password.js";
import { HOUR, POLICY, iso } from "./policy.js";
import { v2On } from "./flags.js";
import { TERMS_VERSION, asText, endSignup, findHandoff, getSignup, guardV2, netOf, nextStep, startSignup, touchSignup } from "./signup-core.js";
import { finishCore, sameLocationNetwork } from "./signup-finish.js";
import { handleEmailLogin, handleReset, handleResetStart, handleSetPassword } from "./pwlogin.js";

export { sameLocationNetwork }; // (tested and used from here before the finish moved to src/signup-finish.js)

const MINUTES = 10;                       // a phone hand-off link lives 10 minutes (like today's)
// How many tries, per window (counted BEFORE the work, atomically: src/limits.js). The finish's own limit is in src/signup-finish.js.
const LIMITS = {
  start: { ip: 20, site: 5000 },          // new sign-ups per hour: per connection, whole site (the site's can be raised: SIGNUP_MAX_PER_HOUR)
  location: { signup: POLICY.limits.locatePerHour, ip: 60 },
  handoff: { signup: 10, ip: 30 },
  email: { signup: 5, ip: 20 },           // codes asked for per hour (per sign-up, per connection). The 20 a day per address is counted in sendEmailCode
  verify: { signup: 20, ip: 60 },         // codes tried per hour
};

/** The whole site's ceiling on new sign-ups per hour. A launch-day crowd can raise it in the dashboard (SIGNUP_MAX_PER_HOUR) without a deploy, like EMAIL_MAX_PER_HOUR. */
const siteStarts = (env) => (Number(env.SIGNUP_MAX_PER_HOUR) > 0 ? Number(env.SIGNUP_MAX_PER_HOUR) : LIMITS.start.site);

const maskEmail = (e) => { const [local, domain] = String(e).split("@"); return `${local.slice(0, 1)}***@${domain}`; };

const parseChoices = (text) => { try { const a = JSON.parse(text); return Array.isArray(a) ? a : null; } catch { return null; } };

/** What the page may know about a sign-up: ticks and masked values only. Never coordinates, a full e-mail, or a hash. */
export function signupState(row) {
  const termsDone = row.terms_version === TERMS_VERSION;
  const choices = row.loc_choices ? parseChoices(row.loc_choices) : null;
  const location = { done: Boolean(row.loc_city) };
  if (row.loc_city) location.community = { id: row.loc_city, name: row.loc_name, country: row.loc_country };
  if (choices) {
    location.choices = choices.map((c) => ({ id: c.id, name: c.name, country: row.loc_country, km: c.km }));
    location.picked = Boolean(row.loc_city);
  }
  const accountDone = Boolean(row.identity_at) && termsDone;
  const account = { done: accountDone };
  if (accountDone) {
    account.provider = row.provider;
    if (row.provider === "email") account.email = maskEmail(row.provider_id);
  } else if (row.pending_email) account.pending = { email: maskEmail(row.pending_email) };
  return { terms: { done: termsDone, version: TERMS_VERSION }, location, account, next: nextStep(row) };
}

/**
 * Who is asking, for the routes that change a sign-up: { row, session, reply } or { error }. A person who is already
 * signed in gets 409 already_signed_in (the page treats it as success); a missing or expired sign-up gets 401 no_signup
 * (the page calls start again). The sign-up gets another hour, and `reply` puts the refreshed cookie on a good answer.
 */
async function needSignup(request, env, now) {
  const session = await getSession(env, request, now);
  if (session && session.user) return { error: json({ ok: false, error: "already_signed_in" }, 409) };
  const row = await getSignup(env, request, now);
  if (!row) return { error: json({ ok: false, error: "no_signup" }, 401) };
  const refreshed = await touchSignup(env, row, request, now);
  const reply = (data, status = 200, extra = {}) => json(data, status, status < 300 ? { "Set-Cookie": refreshed, ...extra } : extra);
  return { row, session, reply };
}

const reload = (env, id) => env.DB.prepare("SELECT * FROM signups WHERE id = ?").bind(id).first();
const slowDown = () => json({ ok: false, error: "slow_down" }, 429);
const badJson = () => json({ ok: false, error: "bad_json" }, 400);
const communityOut = (row) => ({ id: row.loc_city, name: row.loc_name, country: row.loc_country });

/** Count one try on each counter (atomically, before the work). Returns a 429 Response when any is over its maximum, else null. */
async function limited(env, now, specs) {
  const r = await check(env, specs, now);
  return r.ok ? null : slowDown();
}
const perHour = async (env, kind, value, max) => ({ key: await limitKey(env, kind, value), windowMs: HOUR, max });

/* ---------------- start, state ---------------- */

async function handleStart(request, env, x) {
  const session = await getSession(env, request, x.now);
  if (session && session.user) return json({ ok: false, error: "already_signed_in" }, 409);
  const row = await getSignup(env, request, x.now);
  if (row) return json({ ok: true, state: signupState(row) }, 200, { "Set-Cookie": await touchSignup(env, row, request, x.now) });
  // This connection first: one that is over its limit is refused right there and does NOT use up the site's allowance (else a single
  // connection sending thousands of tries would close sign-up for everybody). Only a start that got through counts on the site.
  const over = await limited(env, x.now, [await perHour(env, "sus", clientKey(request), LIMITS.start.ip)])
    || await limited(env, x.now, [{ key: "sus:site", windowMs: HOUR, max: siteStarts(env) }]);
  if (over) return over;
  const made = await startSignup(env, x.now);
  return json({ ok: true, state: signupState({}) }, 200, { "Set-Cookie": made.cookie });
}

/** No sign-up yet: nothing is done (the same answer /start gives for a fresh one). Creates nothing. */
async function handleState(request, env, x) {
  const row = await getSignup(env, request, x.now);
  return json({ ok: true, state: signupState(row || {}) });
}

/* ---------------- 1. location ---------------- */

/** Keep a checked location in the sign-up: only the community (or the three nearest to choose from), never the point. */
function locationColumns(found, cc, net, now) {
  const { city, nearby } = communityOf(found);
  return {
    sql: "loc_city = ?, loc_name = ?, loc_country = ?, loc_choices = ?, loc_net = ?, loc_at = ?",
    values: [city ? city.id : null, city ? city.name : null, cc, nearby ? JSON.stringify(nearby) : null, net, iso(now)],
  };
}

async function handleLocation(request, env, x) {
  const c = await needSignup(request, env, x.now);
  if (c.error) return c.error;
  const body = await readJson(request);
  if (!body) return badJson();
  const over = await limited(env, x.now, [
    await perHour(env, "locs", c.row.id, LIMITS.location.signup),
    await perHour(env, "loci", clientKey(request), LIMITS.location.ip),
  ]);
  if (over) return over;
  const checked = await checkLocation(env, body.location, body, x.cf);
  if (checked.error) return checked.error;
  // From here on only the community is used. The coordinates are not kept anywhere.
  const { found, cc } = checked;
  if (!found.city && !found.nearby.length) return json({ ok: false, error: "location_unverified" }, 403);
  const cols = locationColumns(found, cc, netOf(x.cf), x.now);
  const r = await env.DB.prepare(`UPDATE signups SET ${cols.sql} WHERE id = ? AND expires_at > ?`).bind(...cols.values, c.row.id, iso(x.now)).run();
  if (!r.meta.changes) return json({ ok: false, error: "no_signup" }, 401);
  return c.reply(locationAnswer(await reload(env, c.row.id)));
}

/** { ok, community } or { ok, choices } from a sign-up row that has a location. */
function locationAnswer(row) {
  if (row.loc_city) return { ok: true, community: communityOut(row) };
  return { ok: true, choices: (parseChoices(row.loc_choices) || []).map((n) => ({ id: n.id, name: n.name, country: row.loc_country, km: n.km })) };
}

async function handleChoice(request, env, x) {
  const c = await needSignup(request, env, x.now);
  if (c.error) return c.error;
  const body = await readJson(request);
  if (!body) return badJson();
  const choices = c.row.loc_choices ? parseChoices(c.row.loc_choices) : null;
  if (!choices) return json({ ok: false, error: "no_choices" }, 409);
  const pick = (typeof body.id === "string" || typeof body.id === "number") && choices.find((n) => n.id === String(body.id));
  if (!pick) return json({ ok: false, error: "bad_choice" }, 400);
  let community;
  try { community = await communityById(env, c.row.loc_country, pick.id); }
  catch { return json({ ok: false, error: "cities_unavailable" }, 503); }
  if (!community) return json({ ok: false, error: "bad_choice" }, 400);
  const r = await env.DB.prepare("UPDATE signups SET loc_city = ?, loc_name = ? WHERE id = ? AND loc_choices IS NOT NULL AND expires_at > ?")
    .bind(community.id, community.name, c.row.id, iso(x.now)).run();
  if (!r.meta.changes) return json({ ok: false, error: "no_signup" }, 401);
  return c.reply({ ok: true, community });
}

/* ---------------- 1b. the hand-off to the phone's own browser ---------------- */

async function handleHandoffStart(request, env, x) {
  const c = await needSignup(request, env, x.now);
  if (c.error) return c.error;
  const over = await limited(env, x.now, [
    await perHour(env, "hands", c.row.id, LIMITS.handoff.signup),
    await perHour(env, "handi", clientKey(request), LIMITS.handoff.ip),
  ]);
  if (over) return over;
  const code = randomToken(18);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM handoffs WHERE kind = 'locate' AND (signup_id = ? OR expires_at < ?)").bind(c.row.id, iso(x.now)),
    env.DB.prepare("INSERT INTO handoffs (id, kind, user_id, signup_id, purpose, net, created_at, expires_at) VALUES (?, 'locate', NULL, ?, 'signup', ?, ?, ?)")
      .bind(await sha256(code), c.row.id, netOf(x.cf), iso(x.now), iso(x.now + MINUTES * 60_000)),
  ]);
  return c.reply({ ok: true, code, url: `${new URL(request.url).origin}/locate?code=${code}`, expiresAt: iso(x.now + MINUTES * 60_000) });
}

/** What the link is for (the phone's browser, no cookie): the same answer today's /api/locate/handoff/info gives, for sign-up links only. */
async function handleHandoffInfo(request, env, x) {
  const body = await readJson(request);
  const row = body && await findHandoff(env, body.code, x.now);
  if (!row || !row.signup_id) return json({ ok: false, error: "expired" }, 410);
  return json({ ok: true, purpose: row.purpose, done: Boolean(row.result), expiresAt: row.expires_at });
}

/**
 * The phone's own browser (no cookie) answers a sign-up hand-off: the same checks as /api/locate, on the same connection as the
 * wallet app that asked. Only the community is kept (on the hand-off row, until the wallet app collects it). Called by today's
 * /api/locate/handoff/complete when the row belongs to a sign-up (the page /locate uses that route), and by the alias below.
 */
export async function handleSignupHandoffComplete(request, env, row, body, now = Date.now(), cf = request.cf) {
  if (!v2On(env)) return json({ ok: false, error: "expired" }, 410); // a link made under v2 is dead once the switch is off
  if (row.result) return json({ ok: false, error: "already_done" }, 409);
  if (cf && row.net && netOf(cf) !== row.net) return json({ ok: false, error: "location_unverified" }, 403);
  const over = await limited(env, now, [
    await perHour(env, "locs", row.signup_id, LIMITS.location.signup),
    await perHour(env, "loci", clientKey(request), LIMITS.location.ip),
  ]);
  if (over) return over;
  const checked = await checkLocation(env, body.location, body, cf);
  if (checked.error) return checked.error;
  const { found, cc } = checked;
  if (!found.city && !found.nearby.length) return json({ ok: false, error: "location_unverified" }, 403);
  const made = communityOf(found);
  const stored = await env.DB.prepare("UPDATE handoffs SET result = ? WHERE id = ? AND result IS NULL")
    .bind(JSON.stringify({ country: cc, ...made, net: row.net, at: iso(now) }), row.id).run();
  if (!stored.meta.changes) return json({ ok: false, error: "already_done" }, 409);
  // The phone's browser only learns the community, so it can say "you're in Utica".
  return json({ ok: true, city: made.city ? made.city.name : null, nearby: made.nearby ? made.nearby.map((n) => n.name) : null });
}

async function handleHandoffCompleteAlias(request, env, x) {
  const body = await readJson(request);
  const row = body && await findHandoff(env, body.code, x.now);
  if (!row || !row.signup_id) return json({ ok: false, error: "expired" }, 410);
  return handleSignupHandoffComplete(request, env, row, body, x.now, x.cf);
}

/** The wallet app collects what the phone's browser found. Only the sign-up that asked can take it, once. */
async function handleHandoffClaim(request, env, x) {
  const c = await needSignup(request, env, x.now);
  if (c.error) return c.error;
  const body = await readJson(request);
  const row = body && await findHandoff(env, body.code, x.now);
  if (!row || row.signup_id !== c.row.id) return json({ ok: false, status: "expired" }, 410);
  if (!row.result) return c.reply({ ok: false, status: "waiting" });
  let res;
  try { res = JSON.parse(row.result); } catch { return json({ ok: false, status: "expired" }, 410); }
  const r = await env.DB.batch([
    env.DB.prepare(`UPDATE signups SET loc_city = ?, loc_name = ?, loc_country = ?, loc_choices = ?, loc_net = ?, loc_at = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM handoffs WHERE id = ? AND result IS NOT NULL)`)
      .bind(res.city ? res.city.id : null, res.city ? res.city.name : null, res.country, res.nearby ? JSON.stringify(res.nearby) : null, res.net, res.at, c.row.id, row.id),
    env.DB.prepare("DELETE FROM handoffs WHERE id = ? AND result IS NOT NULL AND signup_id = ?").bind(row.id, c.row.id),
  ]);
  if (!r[1].meta.changes) return json({ ok: false, status: "expired" }, 410); // collected a moment ago by another tab
  return c.reply(locationAnswer(await reload(env, c.row.id)));
}

/* ---------------- 2. terms and account ---------------- */

async function handleTerms(request, env, x) {
  const c = await needSignup(request, env, x.now);
  if (c.error) return c.error;
  const body = await readJson(request);
  if (!body) return badJson();
  if (body.version !== TERMS_VERSION) return json({ ok: false, error: "bad_version" }, 400);
  await env.DB.prepare("UPDATE signups SET terms_version = ?, terms_at = CASE WHEN terms_version = ? THEN terms_at ELSE ? END WHERE id = ? AND expires_at > ?")
    .bind(TERMS_VERSION, TERMS_VERSION, iso(x.now), c.row.id, iso(x.now)).run();
  return c.reply({ ok: true, state: signupState(await reload(env, c.row.id)) });
}

/** Forget the account step only (who the person is and the e-mail + password they typed), so they can pick another way. */
async function handleAccountReset(request, env, x) {
  const c = await needSignup(request, env, x.now);
  if (c.error) return c.error;
  await env.DB.prepare(`UPDATE signups SET provider = NULL, provider_id = NULL, identity_name = NULL, identity_at = NULL, pending_email = NULL, pending_pw_hash = NULL
      WHERE id = ? AND expires_at > ?`).bind(c.row.id, iso(x.now)).run();
  return c.reply({ ok: true, state: signupState(await reload(env, c.row.id)) });
}

/**
 * The e-mail and password the person wants. The password is hashed for EVERY address (known or not: no timing difference),
 * only the hash is kept, and the same { ok: true } comes back whether the address is an account already or not.
 */
async function handleEmail(request, env, x) {
  const c = await needSignup(request, env, x.now);
  if (c.error) return c.error;
  if (c.row.terms_version !== TERMS_VERSION) return json({ ok: false, error: "terms_required" }, 403);
  const body = await readJson(request);
  if (!body) return badJson();
  const email = cleanEmail(asText(body.email));
  if (!validEmail(email)) return json({ ok: false, error: "bad_email" }, 400);
  if (!emailConfigured(env)) return json({ ok: false, error: "email_unavailable" }, 503);
  const bad = checkPassword(body.password, email);
  if (bad) return json({ ok: false, error: bad }, 400); // the code only: the password is never echoed
  const over = await limited(env, x.now, [
    await perHour(env, "sues", c.row.id, LIMITS.email.signup),
    await perHour(env, "suei", clientKey(request), LIMITS.email.ip),
  ]);
  if (over) return over;
  const hash = await hashPassword(env, body.password);
  // A new attempt voids any earlier identity, so a password and a verified address can never come from different attempts.
  const r = await env.DB.prepare(`UPDATE signups SET pending_email = ?, pending_pw_hash = ?, provider = NULL, provider_id = NULL, identity_name = NULL, identity_at = NULL
      WHERE id = ? AND terms_version IS NOT NULL AND expires_at > ?`).bind(email, hash, c.row.id, iso(x.now)).run();
  if (!r.meta.changes) return json({ ok: false, error: "no_signup" }, 401);
  const sent = await sendEmailCode(env, email, { fetchImpl: x.fetchImpl, now: x.now, kind: "signup" });
  if (!sent.ok) return json({ ok: false, error: sent.error }, sent.status);
  return c.reply({ ok: true });
}

/** The code proved the mailbox: this sign-up now has a verified e-mail (the password hash is already in it). */
async function markEmailVerified(env, row, email, now) {
  const r = await env.DB.prepare(`UPDATE signups SET provider = 'email', provider_id = pending_email, identity_name = 'E-mail member', identity_at = ?
      WHERE id = ? AND pending_email = ? AND terms_version = ? AND expires_at > ?`).bind(iso(now), row.id, email, TERMS_VERSION, iso(now)).run();
  if (r.meta.changes) return { recorded: true };
  return { error: (await reload(env, row.id)) ? "email_mismatch" : "no_signup" };
}

const LINK_STATUS = { no_signup: 401, email_mismatch: 400, social_taken: 409, wallet_taken: 409 };

async function handleEmailVerify(request, env, x) {
  const c = await needSignup(request, env, x.now);
  if (c.error) return c.error;
  const body = await readJson(request);
  if (!body) return badJson();
  const email = c.row.pending_email;
  // The code is for the address of THIS sign-up: checked before the code is used up.
  if (!email || (body.email != null && cleanEmail(asText(body.email)) !== email)) return json({ ok: false, error: "email_mismatch" }, 400);
  const code = asText(body.code).replace(/\D/g, "").slice(0, 6);
  if (code.length !== 6) return json({ ok: false, error: "bad_code" }, 400);
  const over = await limited(env, x.now, [
    await perHour(env, "sves", c.row.id, LIMITS.verify.signup),
    await perHour(env, "svei", clientKey(request), LIMITS.verify.ip),
  ]);
  if (over) return over;
  const v = await consumeEmailCode(env.DB, email, code, x.now);
  if (!v.ok) return json({ ok: false, error: v.error, ...(v.left != null ? { left: v.left } : {}) }, v.error === "too_many" ? 429 : 400);

  const r = await linkIdentity(env, c.session, "email", { id: email, handle: null, name: "E-mail member" }, x.now, { onNew: () => markEmailVerified(env, c.row, email, x.now) });
  if (r.error) return json({ ok: false, error: r.error }, LINK_STATUS[r.error] || 400);
  if (r.recorded) {
    // the mailbox is proven and in the sign-up: the account is made now, in this very call, and this browser is signed in
    const row = await reload(env, c.row.id);
    const fin = await finishCore(env, row, request, x.now, x.cf);
    if (fin.ok) return json({ ok: true, existing: false, isNew: true, next: "/dashboard?welcome=1", welcome: fin.welcome }, 200, { "Set-Cookie": fin.cookies });
    // the identity is recorded (the state says so); the page shows why the finish waits, or goes to the step the server cleared
    return c.reply({ ok: true, existing: false, state: signupState(await reload(env, c.row.id)), finishError: fin.error, ...(fin.pending ? { pending: true } : {}) });
  }
  // The address belongs to an account: that person is signed in, as with today's e-mail code, and this sign-up is over. The typed password is ignored.
  return json({ ok: true, existing: true, isNew: false, next: r.to }, 200, { "Set-Cookie": [...(r.cookie ? [r.cookie] : []), ...await endSignup(env, request)] });
}

/* ---------------- 4. finish: the one atomic step that creates the account (src/signup-finish.js) ---------------- */

/**
 * POST /api/signup/finish → { ok, next: "/dashboard?welcome=1", isNew: true, welcome }. The body is ignored: everything comes from the
 * database. The Google callback and the e-mail code run the very same step themselves; this route is for a page that reloads or
 * retries (a passing failure, "Try again").
 */
export async function handleSignupFinish(request, env, now = Date.now(), cf = request.cf) {
  const session = await getSession(env, request, now);
  if (session && session.user) return json({ ok: false, error: "already_signed_in" }, 409);
  const row = await getSignup(env, request, now);
  if (!row) return json({ ok: false, error: "no_signup" }, 401);
  const fin = await finishCore(env, row, request, now, cf);
  if (fin.ok) return json({ ok: true, next: "/dashboard?welcome=1", isNew: true, welcome: fin.welcome }, 200, { "Set-Cookie": fin.cookies });
  return json({ ok: false, error: fin.error, ...(fin.pending ? { pending: true } : {}) }, fin.status);
}

/* ---------------- routing ---------------- */

const ROUTES = {
  "/api/signup/start": ["POST", handleStart],
  "/api/signup/state": ["GET", handleState],
  "/api/signup/location": ["POST", handleLocation],
  "/api/signup/location/choice": ["POST", handleChoice],
  "/api/signup/location/handoff": ["POST", handleHandoffStart],
  "/api/signup/location/handoff/info": ["POST", handleHandoffInfo],
  "/api/signup/location/handoff/complete": ["POST", handleHandoffCompleteAlias],
  "/api/signup/location/handoff/claim": ["POST", handleHandoffClaim],
  "/api/signup/terms": ["POST", handleTerms],
  "/api/signup/account/reset": ["POST", handleAccountReset],
  "/api/signup/email": ["POST", handleEmail],
  "/api/signup/email/verify": ["POST", handleEmailVerify],
  "/api/signup/finish": ["POST", (request, env, x) => handleSignupFinish(request, env, x.now, x.cf)],
  "/api/auth/email/login": ["POST", handleEmailLogin],
  "/api/auth/password/reset/start": ["POST", handleResetStart],
  "/api/auth/password/reset": ["POST", handleReset],
  "/api/me/password": ["POST", handleSetPassword],
};

/** All the v2 routes (index.js calls this only when the switch is on). x = { fetchImpl, ctx, now, cf }. */
export async function routeV2(request, env, fetchImpl = fetch, ctx = null, now = Date.now()) {
  const route = ROUTES[new URL(request.url).pathname];
  if (!route) return json({ error: "not_found" }, 404);
  if (request.method !== route[0]) return json({ error: "method_not_allowed" }, 405);
  const blocked = await guardV2(request, env);
  if (blocked) return blocked;
  return route[1](request, env, { fetchImpl, ctx, now, cf: request.cf });
}
