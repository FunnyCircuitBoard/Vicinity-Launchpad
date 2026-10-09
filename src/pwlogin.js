/**
 * Password log-in for e-mail accounts (SIGNUP_FLOW=v2 only). Wired into routeV2 (src/signup.js).
 *
 *   POST /api/auth/email/login          { email, password }               → { ok, next: "/dashboard" }
 *   POST /api/auth/password/reset/start { email }                         → { ok } (the same for known and unknown addresses)
 *   POST /api/auth/password/reset       { email, code, password }         → { ok, next: "/dashboard" }
 *   POST /api/me/password               { current?, password }            → { ok }
 *
 * How they are called: routeV2 has already checked that the switch is on, that a POST comes from this site (Origin), that
 * the database is there and that the sign-up tables exist (guardV2 in src/signup-core.js: call it first when a handler is
 * called directly, as tests may). `x` is { fetchImpl, ctx, now, cf }: ctx.waitUntil (null in tests) sends mail in the background.
 *
 * What a reviewer will try, and what stops it:
 *   - Finding out which addresses have an account. Log-in answers the very same 401 for an unknown address, a wrong password and
 *     an account that has no password, and does exactly ONE password hash in all three cases (verifyPassword). Reset-start answers
 *     the same { ok: true } for every well-formed address, does the same database work, and only the mail itself differs: it is
 *     sent in the background (ctx.waitUntil), so the time taken says nothing either. A code for an address nobody owns is written
 *     and never mailed.
 *   - Guessing passwords. Every attempt is counted by ONE atomic statement BEFORE any hashing (src/limits.js), per connection
 *     (60 / 15 min), per address and connection (5 / 15 min) and per address (15 / 15 min): parallel guesses get distinct counts, so
 *     only the first few are ever compared and a flood cannot burn CPU. The attacker's own connection is locked first. The
 *     owner of the address is shut out of the PASSWORD route only if an attacker uses three or more connections against it, and
 *     only until the 15-minute window ends (fixed windows: there is no growing lock-out). The e-mail code, the wallet and Google
 *     still work meanwhile. A success gives its attempt back, so a person who gets it right never builds up a count.
 *   - Taking an account over with a reset. It needs a code that was mailed to that address. The code is filed under its OWN name
 *     ("reset@<address>", see resetKey), so a sign-in code can never be used as a reset code and the other way round, and a code for
 *     address A can never work for address B. The new password is checked BEFORE the code is used up (a rule failure burns nothing),
 *     the code is used up by one atomic statement (two requests with the right code cannot both win), and on success every other
 *     session of that person ends and their attempt counters are cleared.
 *   - A stolen session changing the password. /api/me/password needs the current password or a fresh wallet proof; setting a first
 *     password needs the wallet proof (the e-mail account that was made with a code has none). Other sessions end.
 * A password never proves the wallet: a session made by a password has no wallet proof (proven_at NULL), so anything sensitive
 * still asks the wallet to sign. Nothing here logs an address, a password, a code or a hash, and none is ever in an answer.
 */
import { cookie, json, randomToken, readJson, sha256 } from "./http.js";
import { SESSION_COOKIE, SESSION_SECONDS, cleanEmail, consumeEmailCode, createSession, dropCurrent, isFresh, isProven, sendEmailCode, validEmail } from "./auth.js";
import { access } from "./access.js";
import { emailConfigured } from "./mail.js";
import { check, clientKey, limitKey, refund } from "./limits.js";
import { PASSWORD_MAX, checkPassword, hashPassword, verifyPassword } from "./password.js";
import { HOUR, iso } from "./policy.js";
import { asText, endSignup } from "./signup-core.js";

const WINDOW = 15 * 60_000;     // attempt counters: fixed 15-minute windows
const MAX = {
  connection: 60,               // password tries per connection (log-in, reset and change share this one)
  pair: 5,                      // per address AND connection: the attacker is shut out first
  address: 15,                  // per address, all connections together: the cap on a spread-out attack
  user: 10,                     // password changes (and tries at the current password) per signed-in person
};
const RESET_START = { connection: 20, address: 5 };   // reset mails asked for: per connection / hour, per address / hour (the 20 a day per address is counted in sendEmailCode, for mails really sent)
const RAW_MAX = 1024;           // refuse absurd input before any work (the same cap password.js uses)

/**
 * The name a reset code is filed under in email_codes. Two '@' can never be a valid address (validEmail allows exactly one), so
 * no sign-in, sign-up or contact-e-mail code can ever sit under it and a reset code can never sit under a plain address. The
 * mail itself still goes to the plain address.
 */
export const resetKey = (email) => `reset@${email}`;

const badCredentials = () => json({ ok: false, error: "bad_credentials" }, 401);
const slowDown = () => json({ ok: false, error: "slow_down" }, 429);
const badJson = () => json({ ok: false, error: "bad_json" }, 400);

/** { fetchImpl, ctx, now } with defaults, so a handler also works when a test calls it directly. */
const inputs = (x) => ({ fetchImpl: (x && x.fetchImpl) || fetch, ctx: (x && x.ctx) || null, now: (x && x.now) || Date.now() });

/**
 * The attempt counters for one address on one connection. `kinds` names them: log-in uses pwa/pwp, reset uses rsa/rsp (its own,
 * so a person who typed a wrong password five times can still use "e-mail me a code"); the connection counter pwi is shared.
 * The pair counter is `<kind>:<hash of address>:<hash of connection>`, so every pair of one address can be found by prefix.
 * `own` are the counters of THIS connection (all of its tries, refused ones too), `shared` is the one all connections share.
 */
async function attemptCounters(env, request, email, kinds) {
  const address = await limitKey(env, kinds.address, email);
  const connection = await limitKey(env, "pwi", clientKey(request));
  const pair = `${kinds.pair}:${address.slice(kinds.address.length + 1)}:${connection.slice(4)}`;
  return {
    address, connection, pair,
    own: [{ key: connection, windowMs: WINDOW, max: MAX.connection }, { key: pair, windowMs: WINDOW, max: MAX.pair }],
    shared: [{ key: address, windowMs: WINDOW, max: MAX.address }],
    keys: [connection, pair, address],
  };
}
/**
 * Count one try, in two atomic steps. First this connection's own counters: a connection that is over its limit is refused
 * right there and the address is NOT counted, so one connection hammering away cannot use up the address for its owner.
 * Only a try that got through is counted on the address (all connections together). Each step is one atomic statement
 * batch, so parallel tries still get distinct counts: at most MAX.pair per connection ever reach the address counter.
 * Returns true when the try may go on.
 */
async function countTry(env, counters, now) {
  if (!(await check(env, counters.own, now)).ok) return false;
  return (await check(env, counters.shared, now)).ok;
}
const LOGIN_KINDS = { address: "pwa", pair: "pwp" }, RESET_KINDS = { address: "rsa", pair: "rsp" };

/** A password as typed by someone who could have chosen it: at most PASSWORD_MAX characters once normalized. Never throws. */
const plausible = (password) => typeof password === "string" && password.length <= RAW_MAX && Array.from(password.normalize("NFKC")).length <= PASSWORD_MAX;

/** The signed-in cookie for a person, as a Set-Cookie value, made in the SAME batch as other changes. */
async function newSessionStatement(env, user, now) {
  const token = randomToken(32);
  return {
    cookie: cookie(SESSION_COOKIE, token, SESSION_SECONDS),
    statement: env.DB.prepare("INSERT INTO sessions (id, wallet, user_id, proof, created_at, expires_at, proven_at) VALUES (?, ?, ?, NULL, ?, ?, NULL)")
      .bind(await sha256(token), user.wallet, user.id, iso(now), iso(now + SESSION_SECONDS * 1000)),
  };
}

const EMAIL_USER = "SELECT id, wallet, password_hash FROM users WHERE provider = 'email' AND provider_id = ?";

/* ---------------- log in ---------------- */

/** POST /api/auth/email/login { email, password } */
export async function handleEmailLogin(request, env, x) {
  const { now } = inputs(x);
  const body = await readJson(request);
  if (!body) return badJson();
  const email = cleanEmail(asText(body.email)), password = body.password;
  // The shape of the input does not depend on any account, so refusing it early tells nothing (and costs nothing).
  if (!validEmail(email) || !plausible(password)) return badCredentials();

  const counters = await attemptCounters(env, request, email, LOGIN_KINDS);
  if (!(await countTry(env, counters, now))) return slowDown(); // counted first, hashed never

  const user = await env.DB.prepare(EMAIL_USER).bind(email).first();
  const v = await verifyPassword(env, user && user.password_hash, password); // always exactly one hash
  if (!user || !v.ok) return badCredentials();

  await refund(env, counters.keys);
  if (v.rehash) { // made with fewer rounds, or before the pepper existed: write it again the way it would be made now
    try {
      await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?").bind(await hashPassword(env, password), user.id, user.password_hash).run();
    } catch (e) { console.error("password upgrade failed", String((e && e.message) || e)); }
  }
  await dropCurrent(env, request);
  const session = await createSession(env, { wallet: user.wallet, userId: user.id, provenAt: null }, SESSION_SECONDS, now);
  return json({ ok: true, next: "/dashboard" }, 200, { "Set-Cookie": [session, ...(await endSignup(env, request))] });
}

/* ---------------- forgot it, or never had one ---------------- */

/** POST /api/auth/password/reset/start { email } → { ok: true } for every well-formed address. */
export async function handleResetStart(request, env, x) {
  const { fetchImpl, ctx, now } = inputs(x);
  const body = await readJson(request);
  if (!body) return badJson();
  const email = cleanEmail(asText(body.email));
  if (!validEmail(email)) return json({ ok: false, error: "bad_email" }, 400);
  if (!emailConfigured(env)) return json({ ok: false, error: "email_unavailable" }, 503);

  // These count known and unknown addresses alike, so being over one says nothing about an account. This connection first:
  // one that is over its limit is refused before the address is counted (as in countTry).
  if (!(await check(env, [{ key: await limitKey(env, "rsi", clientKey(request)), windowMs: HOUR, max: RESET_START.connection }], now)).ok) return slowDown();
  if (!(await check(env, [{ key: await limitKey(env, "rss", email), windowMs: HOUR, max: RESET_START.address }], now)).ok) return slowDown();

  // Both kinds of address do the same database work from here (sendEmailCode: site cap, send slot, code row). The only
  // difference is the mail itself, which for a real account goes out in the background, after the answer.
  const user = await env.DB.prepare("SELECT id FROM users WHERE provider = 'email' AND provider_id = ?").bind(email).first();
  const pending = [];
  const waitUntil = (p) => (ctx && ctx.waitUntil ? ctx.waitUntil(p) : pending.push(p)); // ctx.waitUntil must be called on ctx
  const sent = await sendEmailCode(env, email, { fetchImpl, now, kind: "reset", codeKey: resetKey(email), waitUntil, noSend: !user });
  await Promise.all(pending); // only without a ctx (tests): so the mail has really gone when we answer
  if (!sent.ok) return json({ ok: false, error: sent.error }, sent.status);
  return json({ ok: true });
}

/** POST /api/auth/password/reset { email, code, password } → the person is signed in with the new password. */
export async function handleReset(request, env, x) {
  const { now } = inputs(x);
  const body = await readJson(request);
  if (!body) return badJson();
  const email = cleanEmail(asText(body.email));
  const code = asText(body.code).replace(/\D/g, "").slice(0, 6);
  if (!validEmail(email)) return json({ ok: false, error: "bad_email" }, 400);
  if (code.length !== 6) return json({ ok: false, error: "bad_code" }, 400);
  // The rules first: a password that is refused must not use up a code the person waited for.
  const bad = checkPassword(body.password, email);
  if (bad) return json({ ok: false, error: bad }, 400);

  const counters = await attemptCounters(env, request, email, RESET_KINDS);
  if (!(await countTry(env, counters, now))) return slowDown();

  const v = await consumeEmailCode(env.DB, resetKey(email), code, now);
  if (!v.ok) return json({ ok: false, error: v.error, ...(v.left != null ? { left: v.left } : {}) }, v.error === "too_many" ? 429 : 400);
  const user = await env.DB.prepare(EMAIL_USER).bind(email).first();
  if (!user) return json({ ok: false, error: "no_account" }, 404);

  const hash = await hashPassword(env, body.password);
  const session = await newSessionStatement(env, user, now);
  const loginAddress = await limitKey(env, "pwa", email);
  // One transaction: the new password, every old session gone, one new session, and the attempt counters of this address
  // cleared (both kinds, every connection: the person gets the password route back). A password change that did not end
  // the other sessions, or sessions ended without the new password, can not happen.
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    session.statement,
    env.DB.prepare(`DELETE FROM auth_limits WHERE key = ?1 OR key = ?2 OR substr(key, 1, length(?3)) = ?3 OR substr(key, 1, length(?4)) = ?4`)
      .bind(loginAddress, counters.address, `pwp:${loginAddress.slice(4)}:`, `rsp:${counters.address.slice(4)}:`),
  ]);
  await dropCurrent(env, request); // a wallet that was proven here while signing up, or a session of someone else in this browser
  return json({ ok: true, next: "/dashboard" }, 200, { "Set-Cookie": [session.cookie, ...(await endSignup(env, request))] });
}

/* ---------------- change it, or set the first one ---------------- */

/** POST /api/me/password { current?, password } */
export async function handleSetPassword(request, env, x) {
  const { now } = inputs(x);
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const { s, u } = a;
  if (u.provider !== "email") return json({ ok: false, error: "no_email_login" }, 403); // Google accounts have no address to log in with
  const body = await readJson(request);
  if (!body) return badJson();
  const bad = checkPassword(body.password, u.provider_id);
  if (bad) return json({ ok: false, error: bad }, 400);

  // Who may change it: the person who knows the current password, or whoever just proved the WALLET in this session (a stolen
  // session has neither). The 30 minutes an account without a wallet counts as fresh after its login (isFresh) never replace an
  // existing password: that login is what a stolen session IS. A first password (none yet) can come from any fresh session: a
  // wallet proof, or, without a wallet, the login itself.
  const typed = body.current == null || body.current === "" ? null : body.current;
  if (typed !== null && typeof typed !== "string") return badCredentials();
  const useCurrent = Boolean(u.password_hash) && typed !== null;
  if (!useCurrent && !(u.password_hash ? isProven(s, now) : isFresh(s, now))) return json({ ok: false, error: "reprove" }, 403);

  const keys = [await limitKey(env, "pwu", String(u.id)), await limitKey(env, "pwi", clientKey(request))];
  const specs = [{ key: keys[0], windowMs: WINDOW, max: MAX.user }, { key: keys[1], windowMs: WINDOW, max: MAX.connection }];
  if (!(await check(env, specs, now)).ok) return slowDown();

  if (useCurrent && !(await verifyPassword(env, u.password_hash, typed)).ok) return badCredentials();
  const hash = await hashPassword(env, body.password);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, u.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(u.id, s.id),
  ]);
  await refund(env, keys);
  return json({ ok: true });
}
