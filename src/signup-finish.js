/**
 * The end of the new sign-up (SIGNUP_FLOW=v2, onboarding v3): ONE atomic step creates the account the instant the login is
 * verified. Called in the same request as the Google callback (src/auth.js) and the e-mail code (src/signup.js), and by
 * POST /api/signup/finish (a reload or a retry). It lives in its own file so that auth.js can import it without a cycle
 * (src/signup.js imports auth.js).
 *
 * What finishCore needs to be true, all of it checked again INSIDE the transaction: the sign-up is alive, holds the current
 * Terms, a community and a verified identity (Google id or e-mail), that identity has no account yet, and the connection still
 * looks like the one the location was proven from (recheckLocation). The account is built ONLY from the sign-up row, never
 * from the request. It has NO wallet: the wallet is linked later, from the dashboard (src/walletlink.js). The session made
 * here carries no wallet proof (proven_at NULL): for an account without a wallet its login counts as fresh for 30 minutes
 * (isFresh in src/auth.js). Nothing here logs an identifier.
 */
import { clearCookie, cookie, randomToken, sha256 } from "./http.js";
import { SESSION_COOKIE, SESSION_SECONDS } from "./session.js";
import { SIGNUP_COOKIE, TERMS_VERSION, netOf } from "./signup-core.js";
import { isRelayNetwork, networkCheck } from "./network.js";
import { countryCities } from "./cities.js";
import { activeMint } from "./official.js";
import { autoUsername } from "./text.js";
import { check, limitKey } from "./limits.js";
import { HOUR, iso } from "./policy.js";

const FINISHES_PER_HOUR = 10; // finish tries per sign-up (counted before the work, atomically: src/limits.js)

/**
 * Four statements, one database transaction (D1 batch). Nothing is created unless EVERYTHING is still true at that moment; on any
 * failure nothing at all changed, so nothing the person proved is burned. Every value comes from database rows. The values, in
 * order: ?1 now, ?2 the sign-up, ?3 the Terms version, ?4 provider, ?5 provider id, ?6 the username, ?7 early member (0 or 1),
 * ?8 the new session's id (a hash), ?9 its end.
 *   1  the account, from the sign-up row alone, only while that row is alive with the Terms, a community and this very identity,
 *      and only if nobody has an account with this identity yet (the UNIQUE (provider, provider_id) index is the last guard)
 *   2  the 30-day session for the user statement 1 just made (found by identity, creation time and username: statement 1's row),
 *      with no wallet and no wallet proof
 *   3-4 the sign-up's hand-off rows and the sign-up itself go, only if statement 2 happened
 */
export const FINISH = [
  `INSERT INTO users (wallet, provider, provider_id, handle, name, early, created_at, terms_version, terms_agreed_at, home_city, home_name, home_country, home_at, password_hash)
   SELECT NULL, s.provider, s.provider_id, ?6, s.identity_name, ?7, ?1, s.terms_version, s.terms_at, s.loc_city, s.loc_name, s.loc_country, ?1,
          CASE WHEN s.provider = 'email' THEN s.pending_pw_hash ELSE NULL END
     FROM signups s
    WHERE s.id = ?2 AND s.expires_at > ?1 AND s.terms_version = ?3 AND s.loc_city IS NOT NULL AND s.identity_at IS NOT NULL
      AND s.provider = ?4 AND s.provider_id = ?5
      AND NOT EXISTS (SELECT 1 FROM users WHERE provider = ?4 AND provider_id = ?5)`,
  `INSERT INTO sessions (id, wallet, user_id, proof, created_at, expires_at, proven_at)
   SELECT ?8, NULL, u.id, NULL, ?1, ?9, NULL FROM users u WHERE u.provider = ?4 AND u.provider_id = ?5 AND u.created_at = ?1 AND u.handle = ?6`,
  "DELETE FROM handoffs WHERE signup_id = ?2 AND EXISTS (SELECT 1 FROM sessions WHERE id = ?8)",
  "DELETE FROM signups WHERE id = ?2 AND EXISTS (SELECT 1 FROM sessions WHERE id = ?8)",
];

/** Bind exactly as many values as the highest ?N of the statement uses (D1 refuses fewer or more). */
function bindFor(db, sql, values) {
  let top = 0;
  for (const m of sql.matchAll(/\?(\d+)/g)) top = Math.max(top, Number(m[1]));
  return db.prepare(sql).bind(...values.slice(0, top));
}

/**
 * Is the connection that finishes on the network the location was proven from (`stored` = loc_net, "country|asn")?
 * The same country and network operator; or, when BOTH are relays (iCloud Private Relay...: src/network.js isRelayNetwork) in the
 * same country, any relay: Private Relay leaves through Fastly, Cloudflare or Akamai and may switch between them while the person
 * stands still (between the location step and the finish), and the operator of a relay says nothing about where the person is
 * anyway. The stored value has only the ASN (no organisation name), so it counts as a relay only when that ASN is one of
 * RELAY_ASNS (the relays' own networks): a relay recognised by its name alone, a relay against an ordinary network, or another
 * country, still has to match exactly, as before. No new column: rows written before this change read the same way.
 */
export function sameLocationNetwork(stored, cf) {
  if (!stored || netOf(cf) === stored) return true;
  const [country, asn] = String(stored).split("|");
  return Boolean(country) && country === String(cf.country || "") && isRelayNetwork({ asn }) && isRelayNetwork(cf);
}

/**
 * The location must still look like the one that was proven: the same country and network operator as when it was checked
 * (a relay may hand over to another relay: sameLocationNetwork), and not Tor, a VPN or a hosting network. For a community that
 * contains the person, also within 500 km of its centre (the checks of /api/locate, applied to the connection that finishes).
 * The point itself was never kept, so a community chosen from the "three nearest" skips the distance part (it can be hundreds
 * of km from the person by design). Only where Cloudflare tells us the connection (cf): in local tests there is none.
 */
export async function recheckLocation(env, row, cf) {
  if (!cf) return true;
  if (!sameLocationNetwork(row.loc_net, cf)) return false;
  let centre = null;
  if (!row.loc_choices) {
    try {
      const c = ((await countryCities(env, row.loc_country)) || []).find((k) => k.id === row.loc_city);
      if (c) centre = { lat: c.lat, lon: c.lon };
    } catch { /* no city list: the distance part is skipped */ }
  }
  return !networkCheck(centre ? cf : { ...cf, latitude: null, longitude: null }, centre || {}, row.loc_country); // no centre: no distance part
}

/** Why a finish changed nothing: the first thing that is no longer true, in plain codes. { error, status }. */
async function whyNotFinished(env, row, now) {
  const sig = await env.DB.prepare("SELECT * FROM signups WHERE id = ? AND expires_at > ?").bind(row.id, iso(now)).first();
  if (!sig) {
    // gone: another tab of this browser just finished it, or it ran out
    const made = await env.DB.prepare("SELECT id FROM users WHERE provider = ? AND provider_id = ?").bind(row.provider, row.provider_id).first();
    return made ? { error: "already_finished", status: 409 } : { error: "no_signup", status: 401 };
  }
  if (await env.DB.prepare("SELECT id FROM users WHERE provider = ? AND provider_id = ?").bind(row.provider, row.provider_id).first()) return { error: "social_taken", status: 409 };
  if (sig.terms_version !== TERMS_VERSION) return { error: "terms_required", status: 400 };
  if (!sig.loc_city) return { error: "location_required", status: 400 };
  if (!sig.identity_at) return { error: "account_required", status: 400, pending: Boolean(sig.pending_email) };
  return { error: "changed_retry", status: 409 }; // something changed while we were working: nothing was lost, try again
}

/**
 * Create the account of this sign-up (`row`, alive, from getSignup) and sign this browser in.
 * Returns { ok: true, cookies: [the 30-day `vs` cookie, the cleared `vsu` cookie], welcome: { name, city, memberNumber }, userId }
 * or { error, status, pending? } with the plain codes the page knows: slow_down, terms_required, location_required,
 * account_required (+ pending: an e-mail was typed but not verified), location_unverified (only the location is forgotten),
 * social_taken, already_finished, no_signup, changed_retry.
 */
export async function finishCore(env, row, request, now = Date.now(), cf = request.cf) {
  const limit = await check(env, [{ key: await limitKey(env, "fins", row.id), windowMs: HOUR, max: FINISHES_PER_HOUR }], now);
  if (!limit.ok) return { error: "slow_down", status: 429 };
  // These checks only give precise answers: the transaction below checks everything again.
  if (row.terms_version !== TERMS_VERSION) return { error: "terms_required", status: 400 };
  if (!row.loc_city) return { error: "location_required", status: 400 };
  if (!row.identity_at) return { error: "account_required", status: 400, pending: Boolean(row.pending_email) };
  if (!(await recheckLocation(env, row, cf))) {
    // Generic, like /api/locate. Only the location is forgotten: the Terms and the account stay.
    await env.DB.prepare("UPDATE signups SET loc_city = NULL, loc_name = NULL, loc_country = NULL, loc_choices = NULL, loc_net = NULL, loc_at = NULL WHERE id = ?").bind(row.id).run();
    return { error: "location_unverified", status: 403 };
  }
  if (await env.DB.prepare("SELECT id FROM users WHERE provider = ? AND provider_id = ?").bind(row.provider, row.provider_id).first()) return { error: "social_taken", status: 409 };

  const early = activeMint(env) ? 0 : 1;
  const token = randomToken(32), sessionId = await sha256(token);
  // A username can collide with the (case-insensitive) unique index when someone takes it a moment before: not the person's
  // problem. The whole batch rolled back, so pick another name and go on. An identity collision is theirs (social_taken).
  for (let attempt = 0; ; attempt++) {
    const values = [iso(now), row.id, TERMS_VERSION, row.provider, row.provider_id, await autoUsername(env.DB), early, sessionId, iso(now + SESSION_SECONDS * 1000)];
    let r;
    try { r = await env.DB.batch(FINISH.map((sql) => bindFor(env.DB, sql, values))); }
    catch (e) {
      if (!/UNIQUE/i.test(String((e && e.message) || e))) throw e;
      const why = await whyNotFinished(env, row, now);
      if (why.error === "social_taken" || why.error === "already_finished") return why;
      if (attempt >= 4) return { error: "social_taken", status: 409 };
      continue;
    }
    if (r[0].meta.changes === 1 && r[1].meta.changes === 1) {
      const made = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?").bind(sessionId).first();
      const userId = made ? made.user_id : null;
      const nth = userId ? await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE home_city = ? AND id <= ? AND provider != 'testlab'").bind(row.loc_city, userId).first() : null;
      console.log("account created", row.provider); // no identifiers
      return {
        ok: true, userId,
        cookies: [cookie(SESSION_COOKIE, token, SESSION_SECONDS), clearCookie(SIGNUP_COOKIE)],
        // the first name Google gave (an e-mail account has no name yet: the card says "Welcome to <city>")
        welcome: { name: (row.provider === "email" ? null : row.identity_name) || null, city: row.loc_name || null, memberNumber: nth ? Number(nth.n) : null },
      };
    }
    return whyNotFinished(env, row, now);
  }
}
