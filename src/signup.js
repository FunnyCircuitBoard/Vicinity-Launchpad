/**
 * The new sign-up (SIGNUP_FLOW=v2): location → Terms + account (Google, or e-mail with a password) → wallet → dashboard.
 * Every route here exists only when the switch is on (src/index.js answers 404 not_enabled otherwise).
 *
 *   POST /api/signup/start                       a fresh sign-up (cookie `vsu`), or the current one
 *   GET  /api/signup/state                       { state } (never coordinates, a full e-mail or wallet, or a hash)
 *   POST /api/signup/location { location, country? }   same checks as /api/locate; keeps only the community
 *   POST /api/signup/location/choice { id }      one of the three nearest, when the person is in empty land
 *   POST /api/signup/location/handoff            a one-time link so a phone's own browser can read the location
 *        .../handoff/info | /complete (the phone's browser, no cookie) | /claim (the wallet app collects the result)
 *   POST /api/signup/carry                       phones: a one-time code that carries this sign-up (at its wallet step) into a wallet app's browser
 *        .../carry/info { code } (what the wallet app's page shows before the person confirms: check number, community, masked login)
 *        .../carry/claim { code } (the wallet app's browser, after the person confirmed: it gets its own cookie for the same sign-up)
 *   POST /api/signup/terms { version }           accept the Terms of Use (before ANY account step)
 *   POST /api/signup/account/reset               forget the account step only (to pick another Google / e-mail)
 *   POST /api/signup/email { email, password }   a 6-digit code to that address (the same answer for known and unknown ones)
 *   POST /api/signup/email/verify { email?, code }   a new address is recorded; a known one signs that person in
 *   POST /api/signup/finish                      ONE atomic step creates the account (Google: GET /api/auth/google/start?signup=1)
 *
 * The wallet step is today's (/api/auth/wallet, /api/pair*, /api/auth/transfer*): a new wallet gets the 30-minute pending
 * session and next: "signup". Only finish ever creates an account, and only from rows in the database (the Terms, the
 * community and the identity of this sign-up, the proven wallet of the pending session), never from anything the page says.
 * Nothing here logs an address, a code, a password or a coordinate.
 */
import { clearCookie, cookie, json, randomToken, readJson, sha256 } from "./http.js";
import { SESSION_COOKIE, SESSION_SECONDS, cleanEmail, consumeEmailCode, getSession, isFresh, linkIdentity, sendEmailCode, validEmail } from "./auth.js";
import { checkLocation, communityOf } from "./attest.js";
import { isRelayNetwork, networkCheck } from "./network.js";
import { communityById } from "./community.js";
import { countryCities } from "./cities.js";
import { activeMint } from "./official.js";
import { autoUsername } from "./text.js";
import { emailConfigured } from "./mail.js";
import { check, clientKey, limitKey } from "./limits.js";
import { checkPassword, hashPassword } from "./password.js";
import { HOUR, POLICY, iso } from "./policy.js";
import { v2On } from "./flags.js";
import { SIGNUP_COOKIE, TERMS_VERSION, asText, capFor, carriedFrom, endSignup, expiryFor, findHandoff, getSignup, guardV2, netOf, nextStep, startSignup, touchSignup } from "./signup-core.js";
import { handleEmailLogin, handleReset, handleResetStart, handleSetPassword } from "./pwlogin.js";

const MINUTES = 10;                       // a phone hand-off link and an "Open app" code live 10 minutes (like today's)
// How many tries, per window (counted BEFORE the work, atomically: src/limits.js).
const LIMITS = {
  start: { ip: 20, site: 5000 },          // new sign-ups per hour: per connection, whole site (the site's can be raised: SIGNUP_MAX_PER_HOUR)
  location: { signup: POLICY.limits.locatePerHour, ip: 60 },
  handoff: { signup: 10, ip: 30 },
  email: { signup: 5, ip: 20 },           // codes asked for per hour (per sign-up, per connection). The 20 a day per address is counted in sendEmailCode
  verify: { signup: 20, ip: 60 },         // codes tried per hour
  finish: { signup: 10 },
  carry: { signup: 10, ip: 30 },          // "Open app" codes made per hour (per sign-up, per connection)
  claim: { ip: 30 },                      // codes tried per hour, per connection (a code is 192 random bits: this only keeps the noise down)
  carryInfo: { ip: 60 },                  // codes looked at per hour, per connection (the wallet app's page asks once before the person confirms)
};

/** The whole site's ceiling on new sign-ups per hour. A launch-day crowd can raise it in the dashboard (SIGNUP_MAX_PER_HOUR) without a deploy, like EMAIL_MAX_PER_HOUR. */
const siteStarts = (env) => (Number(env.SIGNUP_MAX_PER_HOUR) > 0 ? Number(env.SIGNUP_MAX_PER_HOUR) : LIMITS.start.site);

const maskEmail = (e) => { const [local, domain] = String(e).split("@"); return `${local.slice(0, 1)}***@${domain}`; };
const maskWallet = (w) => `${w.slice(0, 4)}…${w.slice(-4)}`;
/** A first name as the wallet app's page may show it before the person confirms: enough to recognise their own ("Sa•••"), no more. */
const maskName = (n) => { const a = Array.from(String(n || "").trim()); return a.length ? `${a.slice(0, a.length > 3 ? 2 : 1).join("")}•••` : "•••"; };

const parseChoices = (text) => { try { const a = JSON.parse(text); return Array.isArray(a) ? a : null; } catch { return null; } };

/** Is a wallet proven in this browser (the pending `vs` session, 30 minutes) and still fresh? */
const walletOf = (session, now) => (session && session.wallet && !session.user && isFresh(session, now) ? session.wallet : null);

/** What the page may know about a sign-up: ticks and masked values only. Never coordinates, a full e-mail or wallet, or a hash. */
export function signupState(row, session, now = Date.now()) {
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
  const w = walletOf(session, now);
  return {
    terms: { done: termsDone, version: TERMS_VERSION },
    location, account,
    wallet: w ? { done: true, address: maskWallet(w) } : { done: false },
    next: nextStep(row, Boolean(w)),
  };
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
  if (row) return json({ ok: true, state: signupState(row, session, x.now) }, 200, { "Set-Cookie": await touchSignup(env, row, request, x.now) });
  // This connection first: one that is over its limit is refused right there and does NOT use up the site's allowance (else a single
  // connection sending thousands of tries would close sign-up for everybody). Only a start that got through counts on the site.
  const over = await limited(env, x.now, [await perHour(env, "sus", clientKey(request), LIMITS.start.ip)])
    || await limited(env, x.now, [{ key: "sus:site", windowMs: HOUR, max: siteStarts(env) }]);
  if (over) return over;
  const made = await startSignup(env, x.now);
  return json({ ok: true, state: signupState({}, session, x.now) }, 200, { "Set-Cookie": made.cookie });
}

async function handleState(request, env, x) {
  const row = await getSignup(env, request, x.now);
  const session = await getSession(env, request, x.now);
  if (row) {
    const state = signupState(row, session, x.now);
    // An "Open app" link of this sign-up that can still be used: the page that shows a link knows when another tab replaced it
    const live = await env.DB.prepare("SELECT id FROM handoffs WHERE kind = 'carry' AND signup_id = ? AND result IS NULL AND expires_at > ?").bind(row.id, iso(x.now)).first();
    if (live) state.carry = { ref: carryRef(live.id) };
    return json({ ok: true, state });
  }
  // No sign-up yet: nothing is done, except a wallet proven in this browser first (an old bookmark, or the Log in tab with a
  // new wallet), which counts as done exactly as the answer of /start says. Still creates nothing.
  const state = signupState({}, session, x.now);
  // ... or this browser's sign-up went on in a wallet app's browser ("Open app" on a phone): say what became of it there.
  const carried = await carriedFrom(env, request, x.now);
  if (carried) state.carried = carried;
  return json({ ok: true, state });
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

/* ---------------- 3b. phones: carry the sign-up into the wallet app's own browser ---------------- */

/**
 * On a phone, Safari or Chrome has no wallet in it, and "Open app" opens the page inside the wallet app (Phantom, Solflare...),
 * whose browser has its own cookies: without help the sign-up would start again there, where Google can't run. So "Open app"
 * carries it over, like the location hand-off, the other way round:
 *   1. Safari / Chrome (its sign-up cookie):  POST /api/signup/carry → a one-time code in the "Open app" link (only its hash is kept),
 *      and a two-digit check number Safari shows next to the link
 *   2. the wallet app's browser (no cookie):  POST /api/signup/carry/info { code } → the same check number, the community and the
 *      masked login, so the person can see it is THEIR sign-up. Nothing is taken over yet.
 *   3. the person confirms there:             POST /api/signup/carry/claim { code } → its own sign-up cookie for THE SAME sign-up,
 *      which moves there: Safari's cookie no longer opens it, so exactly one browser can carry on with it. A wallet proven in that
 *      browser BEFORE the claim never counts for it (its pending session is dropped, and finish wants a proof made after the claim).
 *   4. Safari / Chrome again:                 GET /api/signup/state → { carried: { done, live, provider, login? } }: what became of it
 * Only a sign-up whose location, Terms and account are all done can be carried, so the wallet app's browser starts at the wallet
 * step and nothing can be skipped. The code is 192 random bits, lives 10 minutes, works once, and only from the very connection of
 * the browser that made it (the same IPv4 address, or the same IPv6 /64: Safari and the wallet app of one phone share it; a
 * neighbour on the same internet provider does not). Behind iCloud Private Relay (or another relay) Safari has no such connection
 * in common with the wallet app, so no code is made: the page offers the pairing instead (sign in the wallet app, finish in Safari).
 * The code is never logged and never stored in clear; the connection is kept only as a salted hash.
 */
const findCarry = async (env, code, now) => {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{32,64}$/.test(code)) return null;
  const row = await env.DB.prepare("SELECT * FROM handoffs WHERE id = ? AND kind = 'carry' AND result IS NULL").bind(await sha256(code)).first();
  return row && Date.parse(row.expires_at) > now ? row : null;
};
/** The connection a code is bound to: a salted hash of the IPv4 address or of the IPv6 /64 (src/limits.js clientKey), never the address. */
const carryNet = (env, request) => limitKey(env, "carryip", clientKey(request));
/** The two-digit check number of a code (the same on both screens, derived from the code: nothing more to store). */
async function carryPin(code) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`carry-pin\n${code}`)));
  return String(10 + (((h[0] << 8) | h[1]) % 90));
}
/** A short handle on a live code (a prefix of its stored hash), so a page can tell when another tab replaced its link. */
const carryRef = (id) => String(id).slice(0, 12);

async function handleCarryStart(request, env, x) {
  const c = await needSignup(request, env, x.now);
  if (c.error) return c.error;
  // Only the wallet step can go on elsewhere: every step before it must be done here (nobody skips one by changing browsers).
  if (nextStep(c.row, false) !== "wallet") return json({ ok: false, error: "not_ready", state: signupState(c.row, c.session, x.now) }, 409);
  // Behind a relay (iCloud Private Relay...) the wallet app's browser can't share this connection: no code, the page pairs instead.
  if (isRelayNetwork(x.cf)) return json({ ok: false, error: "carry_relay" }, 409);
  const over = await limited(env, x.now, [
    await perHour(env, "cars", c.row.id, LIMITS.carry.signup),
    await perHour(env, "cari", clientKey(request), LIMITS.carry.ip),
  ]);
  if (over) return over;
  const code = randomToken(24), until = x.now + MINUTES * 60_000, id = await sha256(code);
  await env.DB.batch([
    // one live code per sign-up: a new tap replaces the one before (a code already used stays: it tells Safari what happened)
    env.DB.prepare("DELETE FROM handoffs WHERE kind = 'carry' AND ((signup_id = ? AND result IS NULL) OR expires_at < ?)").bind(c.row.id, iso(x.now)),
    env.DB.prepare("INSERT INTO handoffs (id, kind, user_id, signup_id, purpose, net, created_at, expires_at) VALUES (?, 'carry', NULL, ?, 'carry', ?, ?, ?)")
      .bind(id, c.row.id, await carryNet(env, request), iso(x.now), iso(until)),
  ]);
  return c.reply({ ok: true, code, pin: await carryPin(code), ref: carryRef(id), url: `${new URL(request.url).origin}/connect?carry=${code}`, expiresAt: iso(until) });
}

/** A live code that this connection may use: { row } or { error } (the code is unknown, used or old; or it is another connection's). */
async function usableCarry(env, request, code, now) {
  const row = await findCarry(env, code, now);
  if (!row) return { error: json({ ok: false, error: "carry_expired" }, 410) };
  // The same phone: the very connection of the browser that made the code (a link that reaches anyone else is useless).
  if (row.net !== await carryNet(env, request)) return { error: json({ ok: false, error: "carry_network" }, 403) };
  return { row };
}

/**
 * What the wallet app's page shows BEFORE anything is taken over, so the person can tell it is their own sign-up: the check number
 * Safari shows, the community and the login, masked. Changes nothing (the code stays unused).
 */
async function handleCarryInfo(request, env, x) {
  const body = await readJson(request);
  if (!body) return badJson();
  const over = await limited(env, x.now, [await perHour(env, "carv", clientKey(request), LIMITS.carryInfo.ip)]);
  if (over) return over;
  const u = await usableCarry(env, request, body.code, x.now);
  if (u.error) return u.error;
  const s = await env.DB.prepare("SELECT * FROM signups WHERE id = ? AND expires_at > ?").bind(u.row.signup_id, iso(x.now)).first();
  if (!s || nextStep(s, false) !== "wallet") return json({ ok: false, error: "carry_expired" }, 410);
  const login = s.provider === "email" ? { provider: "email", name: maskEmail(s.provider_id) } : { provider: s.provider, name: maskName(s.identity_name) };
  return json({ ok: true, pin: await carryPin(body.code), community: { name: s.loc_name, country: s.loc_country }, login, expiresAt: u.row.expires_at });
}

async function handleCarryClaim(request, env, x) {
  const session = await getSession(env, request, x.now);
  if (session && session.user) return json({ ok: false, error: "already_signed_in" }, 409); // signed in here already: the dashboard, the code stays unused
  const body = await readJson(request);
  if (!body) return badJson();
  const over = await limited(env, x.now, [await perHour(env, "carc", clientKey(request), LIMITS.claim.ip)]);
  if (over) return over;
  const u = await usableCarry(env, request, body.code, x.now);
  if (u.error) return u.error;
  const row = u.row;
  const sig = await env.DB.prepare("SELECT created_at FROM signups WHERE id = ?").bind(row.signup_id).first();
  if (!sig) return json({ ok: false, error: "carry_expired" }, 410);
  const token = randomToken(32), id = await sha256(token);
  const created = Date.parse(sig.created_at), exp = expiryFor(x.now, created);
  const r = await env.DB.batch([
    // 1. the code is used, once, and only while its sign-up is still alive with location, Terms and account done. From now on the
    //    row only remembers where the sign-up went (result = its new id) and WHEN (created_at = the claim: finish wants a wallet
    //    proven after it), for Safari's questions, as long as the sign-up could live.
    env.DB.prepare(`UPDATE handoffs SET result = ?, created_at = ?, expires_at = ? WHERE id = ? AND kind = 'carry' AND result IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM signups s WHERE s.id = handoffs.signup_id AND s.expires_at > ? AND s.loc_city IS NOT NULL
                    AND s.terms_version = ? AND s.identity_at IS NOT NULL)`)
      .bind(id, iso(x.now), iso(capFor(created)), row.id, iso(x.now), iso(x.now), TERMS_VERSION),
    // 2. the sign-up itself moves to the new token (another hour, never past its three hours): Safari's old cookie opens nothing now
    env.DB.prepare("UPDATE signups SET id = ?, expires_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM handoffs WHERE id = ? AND kind = 'carry' AND result = ?)")
      .bind(id, iso(exp), row.signup_id, row.id, id),
    // 3. a wallet this browser proved BEFORE (its pending session) never counts for the sign-up it just took over: the person
    //    connects and signs again, after seeing whose sign-up it is
    env.DB.prepare("DELETE FROM sessions WHERE id = ? AND user_id IS NULL AND EXISTS (SELECT 1 FROM handoffs WHERE id = ? AND kind = 'carry' AND result = ?)")
      .bind(session ? session.id : "", row.id, id),
  ]);
  if (r[0].meta.changes !== 1 || r[1].meta.changes !== 1) return json({ ok: false, error: "carry_expired" }, 410); // used a moment ago, or the sign-up ran out
  const cookies = [cookie(SIGNUP_COOKIE, token, Math.floor((exp - x.now) / 1000))];
  if (session) cookies.push(clearCookie(SESSION_COOKIE));
  return json({ ok: true, state: signupState(await reload(env, id), null, x.now) }, 200, { "Set-Cookie": cookies });
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
  return c.reply({ ok: true, state: signupState(await reload(env, c.row.id), c.session, x.now) });
}

/** Forget the account step only (who the person is and the e-mail + password they typed), so they can pick another way. */
async function handleAccountReset(request, env, x) {
  const c = await needSignup(request, env, x.now);
  if (c.error) return c.error;
  await env.DB.prepare(`UPDATE signups SET provider = NULL, provider_id = NULL, identity_name = NULL, identity_at = NULL, pending_email = NULL, pending_pw_hash = NULL
      WHERE id = ? AND expires_at > ?`).bind(c.row.id, iso(x.now)).run();
  return c.reply({ ok: true, state: signupState(await reload(env, c.row.id), c.session, x.now) });
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
  if (r.recorded) return c.reply({ ok: true, existing: false, state: signupState(await reload(env, c.row.id), c.session, x.now) });
  // The address belongs to an account: that person is signed in, as with today's e-mail code, and this sign-up is over. The typed password is ignored.
  return json({ ok: true, existing: true, isNew: false, next: r.to }, 200, { "Set-Cookie": [...(r.cookie ? [r.cookie] : []), ...await endSignup(env, request)] });
}

/* ---------------- 4. finish: the one atomic step that creates the account ---------------- */

/**
 * Eight statements, one database transaction (D1 batch). Nothing is created unless EVERYTHING is still true at that moment;
 * on any failure nothing at all changed, so nothing the person proved is burned. The values, in order: ?1 a one-time marker,
 * ?2 the pending session, ?3 its wallet, ?4 now, ?5 the oldest wallet proof still fresh, ?6 the sign-up, ?7 the Terms version,
 * ?8 provider, ?9 provider id, ?10 the username, ?11 early member (0 or 1), ?12 the new session id, ?13 its end.
 *   1  marks the pending wallet session with a one-time value, only if the session, the sign-up (Terms, community, identity)
 *      are all still good, neither the wallet nor the identity has an account, and, for a sign-up carried here from another
 *      browser ("Open app"), the wallet was proven AFTER it arrived (never a proof this browser held before)
 *   2  the account, built ONLY from database rows (the pending session's wallet, the sign-up), never from the request
 *   3  the full 30-day session for the user statement 2 just made, carrying the wallet proof time
 *   4  a sign-up that came here from another browser ("Open app" on a phone) notes the new account, so that browser can say it is done
 *   5-8 clean up, only if statement 3 happened
 */
const FINISH = [
  `UPDATE sessions SET proof = ?1
    WHERE id = ?2 AND user_id IS NULL AND wallet = ?3 AND expires_at > ?4 AND proven_at IS NOT NULL AND proven_at >= ?5
      AND EXISTS (SELECT 1 FROM signups s WHERE s.id = ?6 AND s.expires_at > ?4 AND s.terms_version = ?7
                  AND s.loc_city IS NOT NULL AND s.identity_at IS NOT NULL AND s.provider = ?8 AND s.provider_id = ?9)
      AND NOT EXISTS (SELECT 1 FROM users WHERE wallet = ?3)
      AND NOT EXISTS (SELECT 1 FROM users WHERE provider = ?8 AND provider_id = ?9)
      AND NOT EXISTS (SELECT 1 FROM handoffs c WHERE c.kind = 'carry' AND c.result = ?6 AND c.created_at > sessions.proven_at)`,
  `INSERT INTO users (wallet, provider, provider_id, handle, name, early, created_at,
                      terms_version, terms_agreed_at, home_city, home_name, home_country, home_at, password_hash)
   SELECT p.wallet, s.provider, s.provider_id, ?10, s.identity_name, ?11, ?4,
          s.terms_version, s.terms_at, s.loc_city, s.loc_name, s.loc_country, ?4,
          CASE WHEN s.provider = 'email' THEN s.pending_pw_hash ELSE NULL END
     FROM sessions p JOIN signups s ON s.id = ?6
    WHERE p.id = ?2 AND p.proof = ?1`,
  `INSERT INTO sessions (id, wallet, user_id, proof, created_at, expires_at, proven_at)
   SELECT ?12, u.wallet, u.id, NULL, ?4, ?13, p.proven_at
     FROM sessions p JOIN users u ON u.wallet = p.wallet WHERE p.id = ?2 AND p.proof = ?1`,
  "UPDATE handoffs SET user_id = (SELECT user_id FROM sessions WHERE id = ?12) WHERE kind = 'carry' AND result = ?6 AND EXISTS (SELECT 1 FROM sessions WHERE id = ?12)",
  "DELETE FROM handoffs WHERE signup_id = ?6 AND EXISTS (SELECT 1 FROM sessions WHERE id = ?12)",
  "DELETE FROM signups WHERE id = ?6 AND EXISTS (SELECT 1 FROM sessions WHERE id = ?12)",
  "DELETE FROM sessions WHERE id = ?2 AND proof = ?1 AND EXISTS (SELECT 1 FROM sessions WHERE id = ?12)",
  "UPDATE sessions SET proof = NULL WHERE id = ?2 AND proof = ?1",
];

/** Bind exactly as many values as the highest ?N of the statement uses (D1 refuses fewer or more). */
function bindFor(db, sql, values) {
  let top = 0;
  for (const m of sql.matchAll(/\?(\d+)/g)) top = Math.max(top, Number(m[1]));
  return db.prepare(sql).bind(...values.slice(0, top));
}

/**
 * The location must still look like the one that was proven: the same country and network operator as when it was checked,
 * and not Tor, a VPN or a hosting network. For a community that contains the person, also within 500 km of its centre (the
 * checks of /api/locate, applied to the connection that finishes). The point itself was never kept, so a community chosen
 * from the "three nearest" skips the distance part (it can be hundreds of km from the person by design).
 * Only where Cloudflare tells us the connection (cf): in local tests there is none.
 */
async function recheckLocation(env, row, cf) {
  if (!cf) return true;
  if (row.loc_net && netOf(cf) !== row.loc_net) return false;
  let centre = null;
  if (!row.loc_choices) {
    try {
      const c = ((await countryCities(env, row.loc_country)) || []).find((k) => k.id === row.loc_city);
      if (c) centre = { lat: c.lat, lon: c.lon };
    } catch { /* no city list: the distance part is skipped */ }
  }
  return !networkCheck(centre ? cf : { ...cf, latitude: null, longitude: null }, centre || {}, row.loc_country); // no centre: no distance part
}

/** A sign-up carried into this browser ("Open app") counts only a wallet proven after it arrived (the claim time is on its carry row). */
async function provenBeforeCarry(env, signupId, session) {
  const c = await env.DB.prepare("SELECT created_at FROM handoffs WHERE kind = 'carry' AND result = ?").bind(signupId).first();
  return Boolean(c && !(session.proven_at >= c.created_at));
}

/** Why a finish changed nothing: the first thing that is no longer true, in plain codes. */
async function whyNotFinished(env, row, session, now) {
  const sig = await env.DB.prepare("SELECT * FROM signups WHERE id = ? AND expires_at > ?").bind(row.id, iso(now)).first();
  if (!sig) {
    // gone: another tab of this browser just finished it, or it ran out
    const made = await env.DB.prepare("SELECT id FROM users WHERE wallet = ? AND provider = ? AND provider_id = ?").bind(session.wallet, row.provider, row.provider_id).first();
    return made ? json({ ok: false, error: "already_finished" }, 409) : json({ ok: false, error: "no_signup" }, 401);
  }
  const s = await env.DB.prepare("SELECT expires_at, proven_at FROM sessions WHERE id = ? AND user_id IS NULL AND wallet = ?").bind(session.id, session.wallet).first();
  if (!s || Date.parse(s.expires_at) <= now) return json({ ok: false, error: "wallet_required" }, 400);
  if (!isFresh(s, now)) return json({ ok: false, error: "wallet_expired" }, 403);
  if (await provenBeforeCarry(env, row.id, s)) return json({ ok: false, error: "wallet_required" }, 400);
  if (await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(session.wallet).first()) return json({ ok: false, error: "wallet_taken" }, 409);
  if (await env.DB.prepare("SELECT id FROM users WHERE provider = ? AND provider_id = ?").bind(row.provider, row.provider_id).first()) return json({ ok: false, error: "social_taken" }, 409);
  if (sig.terms_version !== TERMS_VERSION) return json({ ok: false, error: "terms_required" }, 400);
  if (!sig.loc_city) return json({ ok: false, error: "location_required" }, 400);
  if (!sig.identity_at) return json({ ok: false, error: "account_required" }, 400);
  return json({ ok: false, error: "changed_retry" }, 409); // something changed while we were working: nothing was lost, try again
}

/** POST /api/signup/finish → { ok, next: "/dashboard?welcome=1", isNew: true }. The body is ignored: everything comes from the database. */
export async function handleSignupFinish(request, env, now = Date.now(), cf = request.cf) {
  const session = await getSession(env, request, now);
  if (session && session.user) return json({ ok: false, error: "already_signed_in" }, 409);
  const row = await getSignup(env, request, now);
  if (!row) return json({ ok: false, error: "no_signup" }, 401);
  const over = await limited(env, now, [await perHour(env, "fins", row.id, LIMITS.finish.signup)]);
  if (over) return over;

  // These checks only give precise answers: the transaction below checks everything again.
  if (!session || !session.wallet) return json({ ok: false, error: "wallet_required" }, 400);
  if (!isFresh(session, now)) return json({ ok: false, error: "wallet_expired" }, 403);
  if (await provenBeforeCarry(env, row.id, session)) return json({ ok: false, error: "wallet_required" }, 400);
  if (row.terms_version !== TERMS_VERSION) return json({ ok: false, error: "terms_required" }, 400);
  if (!row.loc_city) return json({ ok: false, error: "location_required" }, 400);
  if (!row.identity_at) return json({ ok: false, error: "account_required", ...(row.pending_email ? { pending: true } : {}) }, 400);
  if (!(await recheckLocation(env, row, cf))) {
    // Generic, like /api/locate. Only the location is forgotten: the Terms, the account and the wallet stay.
    await env.DB.prepare("UPDATE signups SET loc_city = NULL, loc_name = NULL, loc_country = NULL, loc_choices = NULL, loc_net = NULL, loc_at = NULL WHERE id = ?").bind(row.id).run();
    return json({ ok: false, error: "location_unverified" }, 403);
  }
  const owner = await env.DB.prepare("SELECT provider, provider_id FROM users WHERE wallet = ?").bind(session.wallet).first();
  if (owner) {
    // this very sign-up finished a moment ago in another tab, or the wallet belongs to someone else
    const mine = owner.provider === row.provider && owner.provider_id === row.provider_id;
    return json({ ok: false, error: mine ? "already_finished" : "wallet_taken" }, 409);
  }
  if (await env.DB.prepare("SELECT id FROM users WHERE provider = ? AND provider_id = ?").bind(row.provider, row.provider_id).first()) return json({ ok: false, error: "social_taken" }, 409);

  const early = activeMint(env) ? 0 : 1;
  const token = randomToken(32);
  // A username can collide with the (case-insensitive) unique index when someone takes it a moment before: not the person's
  // problem. The whole batch rolled back, so pick another name and go on. A wallet or identity collision is theirs.
  for (let attempt = 0; ; attempt++) {
    const values = [randomToken(16), session.id, session.wallet, iso(now), iso(now - POLICY.freshProofMinutes * 60_000), row.id, TERMS_VERSION,
      row.provider, row.provider_id, await autoUsername(env.DB), early, await sha256(token), iso(now + SESSION_SECONDS * 1000)];
    let r;
    try { r = await env.DB.batch(FINISH.map((sql) => bindFor(env.DB, sql, values))); }
    catch (e) {
      if (!/UNIQUE/i.test(String((e && e.message) || e))) throw e;
      const taken = await whyNotFinished(env, row, session, now);
      const code = (await taken.clone().json()).error;
      if (code === "wallet_taken" || code === "social_taken" || code === "already_finished") return taken;
      if (attempt >= 4) return json({ ok: false, error: "social_taken" }, 409);
      continue;
    }
    if (r[0].meta.changes === 1 && r[1].meta.changes === 1 && r[2].meta.changes === 1) {
      console.log("account created", row.provider, session.wallet.slice(0, 4) + "…" + session.wallet.slice(-4));
      return json({ ok: true, next: "/dashboard?welcome=1", isNew: true }, 200, { "Set-Cookie": [cookie(SESSION_COOKIE, token, SESSION_SECONDS), clearCookie(SIGNUP_COOKIE)] });
    }
    return whyNotFinished(env, row, session, now);
  }
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
  "/api/signup/carry": ["POST", handleCarryStart],
  "/api/signup/carry/info": ["POST", handleCarryInfo],
  "/api/signup/carry/claim": ["POST", handleCarryClaim],
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
