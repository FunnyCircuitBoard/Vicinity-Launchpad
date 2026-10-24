/**
 * Session and challenge host binding (Citycoin.dev master v5, stage S04; master section 05 BR-03 "Authentication handover" and
 * "Acceptance"; docs/citycoin-master/schema-and-api.md section 3.1 "Host binding"; docs/citycoin-master/domain-cutover.md section 1.2).
 *
 * WHEN IT COUNTS. Only once a second host may serve the site: SITE_ORIGINS (accepted by src/site-config.js) lists a host other than today's,
 * vicinity.city. A SITE_ORIGIN or SITE_ORIGINS that is set but refused counts too, with today's site (a broken setting fails closed: every
 * host outside the allowlist is refused instead of served unbound; it also runs the additive migration below). With both unset, or naming
 * only vicinity.city, nothing here changes an answer, a header, a cookie or a D1 row on any host that reaches the Worker today: servedHost
 * answers what the code used before (on vicinity.city that is the configuration's own value, byte for byte), no host is written and no host
 * is compared. The one exception is the cutover's own two hosts (src/site-config.js CUTOVER_HOSTS: citycoin.dev and www.citycoin.dev, not
 * attached today): they are refused until SITE_ORIGINS lists citycoin.dev, so a custom domain attached ahead of its setting is never served
 * unbound. Rolling back is unsetting SITE_ORIGINS: every session, pairing, hand-off and sign-up row then works on any host again, as today.
 *
 * WHAT IT DOES WHILE IT COUNTS.
 *   - The request's host is looked up in the allowlist (SITE_ORIGINS plus the legacy hosts, src/site-config.js acceptedHost; exact, lower
 *     case, never a suffix match). The value used is the allowlist's own entry, never the request's text. A host outside the allowlist is
 *     refused (src/index.js answers 421 {"error":"wrong_host"}, before any route and before the http and old-name 301s). Outside production
 *     only (src/site-config.js localDevAllowed), a local development host (localhost, 127.0.0.1, [::1], *.localhost: `wrangler dev`, never a
 *     Cloudflare route) is served as its own host, and `wrangler dev`'s visit of a route's name over http from this computer keeps its http.
 *   - Every new session, pairing, hand-off (the wallet link's carry code, the location hand-offs) and sign-up row records that host
 *     (sessions.host, pairs.host, handoffs.host, signups.host: nullable columns added by lazy additive migrations, one per table, src/store.js
 *     ensureHostSchema). A row whose host is NULL was made before the binding counted, on vicinity.city: it reads as vicinity.city, so every
 *     member signed in today stays signed in there.
 *   - A row is found, and ended, only on the host it records: a session cookie, a sign-up cookie, a pairing code or a hand-off code copied to
 *     another host is unknown there (signed out, expired), and signing out or signing in there deletes nothing of the other host's
 *     (sessionDelete, signupDelete). The cookies themselves are unchanged: host-only (no Domain attribute), Secure, HttpOnly, SameSite=Lax,
 *     today's names; they are never shared across domains.
 *   - Hand-off links, QR codes, pairing links and the Google return address are built on the allowlist entry's origin; the text a wallet
 *     signs names the allowlist entry, and a signed text is accepted only on the host it names (src/signed.js checkSigned): a signature
 *     made for vicinity.city is refused on citycoin.dev, and the other way round. A request that changes something must carry that origin
 *     exactly (src/http.js sameSite: scheme and host).
 *
 * Nothing here reads a header other than the request URL's host, and that only as a key into the allowlist (and, outside production, the
 * cf-connecting-ip Cloudflare sets, to recognise `wrangler dev` on this computer).
 */
import { CUTOVER_HOSTS, DEFAULT_SITE, LOCAL_HOST, acceptedHost, localDevAllowed, siteConfig } from "./site-config.js";

/** Does the binding count for this site configuration? SITE_ORIGINS lists a host other than vicinity.city, or a site setting was refused. */
export const hostBound = (site) => site.problems.length > 0 || (site.configured && site.hosts.some((h) => h !== DEFAULT_SITE.host));

/** The host a row made before the binding counted (host NULL) belongs to: today's canonical host, vicinity.city. */
export const NULL_HOST = DEFAULT_SITE.host;

/** A visit from this computer: `wrangler dev` sets cf-connecting-ip to a local address (Cloudflare sets it to the real client's address, so
 *  in production it never is one). src/hostroute.js isLocal adds the local host names to it. */
export const fromThisComputer = (request) => ["127.0.0.1", "::1"].includes(request.headers.get("cf-connecting-ip"));

const REFUSED = Object.freeze({ refused: true, origin: null, host: null, key: null });
/**
 * How this request is served: { bound, refused, origin, host, key }.
 *   bound    the binding counts (above)
 *   refused  the request's host is outside the allowlist (bound), or is one of the cutover's own hosts while the binding does not count
 *            (src/index.js answers 421 wrong_host before any route)
 *   origin   the origin hand-off, QR, pairing and Google return links are built on ("https://citycoin.dev"), and the Origin a request that
 *            changes something must carry while bound (src/http.js sameSite)
 *   host     the host a wallet's signed text names, and must name ("citycoin.dev"; a local host keeps its port)
 *   key      the host a row is bound to (a host name, no port), or null while the binding does not count
 * While the binding does not count: today's values, the request URL's own origin and host (on vicinity.city, an allowlist entry: the
 * configuration's string); Cloudflare routes only the configured custom domains to this Worker (wrangler.jsonc routes, workers_dev and
 * preview_urls false), so in production no other host reaches this branch, and the cutover's own hosts are refused should one be attached
 * before SITE_ORIGINS lists it.
 */
export function servedHost(env, request) {
  const site = siteConfig(env);
  let url;
  try { url = new URL(request.url); } catch { return { bound: hostBound(site), ...REFUSED }; }
  if (!hostBound(site)) {
    if (CUTOVER_HOSTS.includes(url.hostname.toLowerCase())) return { bound: false, ...REFUSED };
    const entry = url.protocol === "https:" ? site.hosts.find((h) => h === url.host) : undefined;
    return entry ? { bound: false, refused: false, origin: `https://${entry}`, host: entry, key: null }
      : { bound: false, refused: false, origin: url.origin, host: url.host, key: null };
  }
  const name = url.hostname.toLowerCase();
  const dev = localDevAllowed(env);
  if (dev && LOCAL_HOST.test(name)) return { bound: true, refused: false, origin: url.origin, host: url.host, key: name };
  const entry = acceptedHost(site, name);
  if (!entry) return { bound: true, ...REFUSED };
  // `wrangler dev` presents a route's name over http from this computer (http://vicinity.city): its links keep the http (and any port) it is
  // served on, like a local host's; its rows are bound to the entry
  if (dev && url.protocol === "http:" && fromThisComputer(request)) {
    const port = url.port ? `:${url.port}` : "";
    return { bound: true, refused: false, origin: `http://${entry}${port}`, host: `${entry}${port}`, key: entry };
  }
  return { bound: true, refused: false, origin: `https://${entry}`, host: entry, key: entry };
}

/** May a row recording `rowHost` (NULL: made before the binding, on vicinity.city) be used on this request? Always, while not bound (except
 *  on a refused host, which never reaches a route). */
export const onThisHost = (served, rowHost) => !served.refused && (!served.bound || (served.key !== null && (rowHost == null ? NULL_HOST : rowHost) === served.key));

const BOUND_TABLES = new Set(["sessions", "pairs", "handoffs", "signups"]);
/**
 * The statement that records this request's host on the row `id` of `table` (one of the four), to run in the same D1 batch as the INSERT
 * that made the row (one transaction: a row never exists without its host), or null while the binding does not count. The caller has run
 * src/store.js ensureHostSchema(db, table) (ensureHostSignupSchema for signups). Never for a refused host: src/index.js refused it before any
 * route.
 */
export function hostWrite(db, table, id, served) {
  if (!served || !served.bound) return null;
  if (!BOUND_TABLES.has(table)) throw new Error("host binding: unknown table");
  if (served.refused || !served.key) throw new Error("wrong_host");
  return db.prepare(`UPDATE ${table} SET host = ? WHERE id = ?`).bind(served.key, id);
}

/**
 * The statement that deletes the session `id` (a hash of the token this request presented), or the sign-up `id`, only if it belongs to this
 * request's host while the binding counts (a cookie copied to another host never ends the original there: the same rule as onThisHost, with
 * NULL read as vicinity.city), or null when nothing may be deleted (a refused host). While the binding does not count: today's statement,
 * by the id alone. The caller has run src/store.js ensureHostSchema(db, "sessions") (ensureHostSignupSchema for signups) while bound.
 */
export function sessionDelete(db, id, served) {
  if (!served || !served.bound) return db.prepare("DELETE FROM sessions WHERE id = ?").bind(id);
  if (served.refused || !served.key) return null;
  return db.prepare("DELETE FROM sessions WHERE id = ? AND COALESCE(host, ?) = ?").bind(id, NULL_HOST, served.key);
}
/** The two statements that end the sign-up `id` and its hand-offs (src/signup-core.js endSignup), scoped the same way; [] on a refused host. */
export function signupDelete(db, id, served) {
  if (!served || !served.bound) return [db.prepare("DELETE FROM handoffs WHERE signup_id = ?").bind(id), db.prepare("DELETE FROM signups WHERE id = ?").bind(id)];
  if (served.refused || !served.key) return [];
  return [
    db.prepare("DELETE FROM handoffs WHERE signup_id = ?1 AND EXISTS (SELECT 1 FROM signups WHERE id = ?1 AND COALESCE(host, ?2) = ?3)").bind(id, NULL_HOST, served.key),
    db.prepare("DELETE FROM signups WHERE id = ? AND COALESCE(host, ?) = ?").bind(id, NULL_HOST, served.key),
  ];
}
