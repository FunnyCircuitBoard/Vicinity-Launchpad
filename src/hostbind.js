/**
 * Session and challenge host binding (Citycoin.dev master v5, stage S04; master section 05 BR-03 "Authentication handover" and
 * "Acceptance"; docs/citycoin-master/schema-and-api.md section 3.1 "Host binding"; docs/citycoin-master/domain-cutover.md section 1.3).
 *
 * WHEN IT COUNTS. Only once a second host may serve the site: SITE_ORIGINS (accepted by src/site-config.js) lists a host other than today's,
 * vicinity.city. A SITE_ORIGIN or SITE_ORIGINS that is set but refused counts too, with today's site (a broken setting fails closed: every
 * host outside the allowlist is refused instead of served unbound). With both unset, or naming only vicinity.city, nothing here changes an
 * answer, a header, a cookie or a D1 row: servedHost answers what the code used before (on vicinity.city that is the configuration's own
 * value, byte for byte), no host is written and no host is compared. Rolling back is unsetting SITE_ORIGINS: every session, pairing,
 * hand-off and sign-up row then works on any host again, as today.
 *
 * WHAT IT DOES WHILE IT COUNTS.
 *   - The request's host is looked up in the allowlist (SITE_ORIGINS plus the legacy hosts, src/site-config.js acceptedHost; exact, lower
 *     case, never a suffix match). The value used is the allowlist's own entry, never the request's text. A host outside the allowlist is
 *     refused (src/index.js answers 421 {"error":"wrong_host"}, before any route). A local development host (localhost, 127.0.0.1, [::1],
 *     *.localhost: `wrangler dev`, never a Cloudflare route) is served as its own host.
 *   - Every new session, pairing, hand-off (the wallet link's carry code, the location hand-offs) and sign-up row records that host
 *     (sessions.host, pairs.host, handoffs.host, signups.host: nullable columns added by a lazy additive migration, src/store.js
 *     ensureHostSchema). A row whose host is NULL was made before the binding counted, on vicinity.city: it reads as vicinity.city, so every
 *     member signed in today stays signed in there.
 *   - A row is found only on the host it records: a session cookie, a sign-up cookie, a pairing code or a hand-off code copied to another host
 *     is unknown there (signed out, expired). The cookies themselves are unchanged: host-only (no Domain attribute), Secure, HttpOnly,
 *     SameSite=Lax, today's names; they are never shared across domains.
 *   - Hand-off links, QR codes, pairing links and the Google return address are built on the allowlist entry's origin; the text a wallet
 *     signs names the allowlist entry, and a signed text is accepted only on the host it names (src/signed.js checkSigned): a signature
 *     made for vicinity.city is refused on citycoin.dev, and the other way round.
 *
 * Nothing here reads a header other than the request URL's host, and that only as a key into the allowlist.
 */
import { DEFAULT_SITE, LOCAL_HOST, acceptedHost, siteConfig } from "./site-config.js";

/** Does the binding count for this site configuration? SITE_ORIGINS lists a host other than vicinity.city, or a site setting was refused. */
export const hostBound = (site) => site.problems.length > 0 || (site.configured && site.hosts.some((h) => h !== DEFAULT_SITE.host));

/** The host a row made before the binding counted (host NULL) belongs to: today's canonical host, vicinity.city. */
export const NULL_HOST = DEFAULT_SITE.host;

/**
 * How this request is served: { bound, refused, origin, host, key }.
 *   bound    the binding counts (above)
 *   refused  bound, and the request's host is outside the allowlist (src/index.js answers 421 wrong_host before any route)
 *   origin   the origin hand-off, QR, pairing and Google return links are built on ("https://citycoin.dev")
 *   host     the host a wallet's signed text names, and must name ("citycoin.dev"; a local host keeps its port)
 *   key      the host a row is bound to (a host name, no port), or null while the binding does not count
 * While the binding does not count: today's values, the request URL's own origin and host (on vicinity.city, an allowlist entry: the
 * configuration's string); Cloudflare routes only the configured custom domains to this Worker (wrangler.jsonc routes, workers_dev and
 * preview_urls false), so in production no other host reaches this branch.
 */
export function servedHost(env, request) {
  const site = siteConfig(env);
  let url;
  try { url = new URL(request.url); } catch { return { bound: hostBound(site), refused: true, origin: null, host: null, key: null }; }
  if (!hostBound(site)) {
    const entry = url.protocol === "https:" ? site.hosts.find((h) => h === url.host) : undefined;
    return entry ? { bound: false, refused: false, origin: `https://${entry}`, host: entry, key: null }
      : { bound: false, refused: false, origin: url.origin, host: url.host, key: null };
  }
  const name = url.hostname.toLowerCase();
  if (LOCAL_HOST.test(name)) return { bound: true, refused: false, origin: url.origin, host: url.host, key: name };
  const entry = acceptedHost(site, name);
  if (!entry) return { bound: true, refused: true, origin: null, host: null, key: null };
  return { bound: true, refused: false, origin: `https://${entry}`, host: entry, key: entry };
}

/** May a row recording `rowHost` (NULL: made before the binding, on vicinity.city) be used on this request? Always, while not bound. */
export const onThisHost = (served, rowHost) => !served.bound || (!served.refused && served.key !== null && (rowHost == null ? NULL_HOST : rowHost) === served.key);

const BOUND_TABLES = new Set(["sessions", "pairs", "handoffs", "signups"]);
/**
 * The statement that records this request's host on the row `id` of `table` (one of the four), to run in the same D1 batch as the INSERT
 * that made the row (one transaction: a row never exists without its host), or null while the binding does not count. The caller has run
 * src/store.js ensureHostSchema (and ensureHostSignupSchema for signups). Never for a refused host: src/index.js refused it before any route.
 */
export function hostWrite(db, table, id, served) {
  if (!served || !served.bound) return null;
  if (!BOUND_TABLES.has(table)) throw new Error("host binding: unknown table");
  if (served.refused || !served.key) throw new Error("wrong_host");
  return db.prepare(`UPDATE ${table} SET host = ? WHERE id = ?`).bind(served.key, id);
}
