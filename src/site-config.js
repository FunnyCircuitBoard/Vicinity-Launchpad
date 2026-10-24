/**
 * The site's own addresses, in one place (Citycoin.dev master v5, stage S02; rebrand-inventory.md U01, U05, C02):
 *
 *   SITE_ORIGIN    the canonical origin, e.g. "https://vicinity.city" (a bare https origin: no path, no port, no trailing slash)
 *   SITE_ORIGINS   the origins this Worker serves in place (a list, or one string of origins separated by commas or spaces);
 *                  SITE_ORIGIN must be one of them
 *
 * Unset (or blank) means today's hard-coded values, byte for byte: canonical https://vicinity.city, accepted [https://vicinity.city],
 * and the three old names that forward there (www.vicinity.city, vicinitycity.net, www.vicinitycity.net; they were the literals
 * CANONICAL_HOST and FORWARD_HOSTS in src/index.js). A setting that is malformed, or a SITE_ORIGIN outside SITE_ORIGINS, is never used
 * in part: the whole answer falls back to today's values and `problems` names what was refused (SITE_ORIGIN_INVALID,
 * SITE_ORIGINS_INVALID, SITE_ORIGIN_NOT_ALLOWED, the same names the v5 configuration check uses).
 *
 * Nothing here reads a request: no Host header, no request URL. A trusted address (a redirect target, a link in a mail, our User-Agent)
 * is built from this configuration only. The redirect itself (308, 421 and the HOST_REDIRECT switch) is stage S03; session and hand-off
 * host binding is stage S04.
 */

export const DEFAULT_SITE_ORIGIN = "https://vicinity.city";
export const DEFAULT_SITE_ORIGINS = Object.freeze(["https://vicinity.city"]);
/** The old names that forward to the canonical host (compatibility, rebrand-inventory.md C02). Never served in place unless listed. */
export const LEGACY_FORWARD_HOSTS = Object.freeze(["www.vicinity.city", "vicinitycity.net", "www.vicinitycity.net"]);

const blank = (v) => v == null || (typeof v === "string" && v.trim() === "");

/** A bare https origin ("https://host"), lower case, with no path, query, fragment, port, user part or trailing slash; else null. */
export function normalizeOrigin(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!/^https:\/\/[^\s/?#@\\]+$/i.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(u.hostname) || u.hostname.split(".").some((l) => !l || l.startsWith("-") || l.endsWith("-"))) return null;
  if (u.origin.toLowerCase() !== s.toLowerCase()) return null;
  return u.origin;
}

/** SITE_ORIGINS as a list of origins, or null when any entry is not a bare https origin (or the list is empty). */
function parseOrigins(value) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : null;
  if (!items || !items.length) return null;
  const out = [];
  for (const item of items) {
    const o = normalizeOrigin(item);
    if (!o) return null;
    if (!out.includes(o)) out.push(o);
  }
  return out;
}

const build = (origin, origins, problems) => {
  const host = new URL(origin).hostname;
  const hosts = origins.map((o) => new URL(o).hostname);
  return Object.freeze({
    origin,
    host,
    origins: Object.freeze([...origins]),
    hosts: Object.freeze(hosts),
    forwardHosts: Object.freeze(LEGACY_FORWARD_HOSTS.filter((h) => h !== host && !hosts.includes(h))),
    configured: problems === null,
    problems: Object.freeze(problems || []),
  });
};

/** Today's answer, used whenever nothing (or nothing valid) is configured. */
export const DEFAULT_SITE = build(DEFAULT_SITE_ORIGIN, DEFAULT_SITE_ORIGINS, []);

let memo = { key: null, value: DEFAULT_SITE };

/**
 * The site configuration of a Worker environment: { origin, host, origins, hosts, forwardHosts, configured, problems }, frozen.
 * `configured` is true only when at least one of the two settings is set and every set value was accepted.
 */
export function siteConfig(env) {
  const rawOrigin = env ? env.SITE_ORIGIN : undefined, rawOrigins = env ? env.SITE_ORIGINS : undefined;
  if (blank(rawOrigin) && (blank(rawOrigins) || (Array.isArray(rawOrigins) && !rawOrigins.length))) return DEFAULT_SITE;
  const key = JSON.stringify([rawOrigin ?? null, rawOrigins ?? null]);
  if (memo.key === key) return memo.value;
  const problems = [];
  const origin = blank(rawOrigin) ? DEFAULT_SITE_ORIGIN : normalizeOrigin(rawOrigin);
  if (!origin) problems.push("SITE_ORIGIN_INVALID");
  const origins = blank(rawOrigins) || (Array.isArray(rawOrigins) && !rawOrigins.length) ? [...DEFAULT_SITE_ORIGINS] : parseOrigins(rawOrigins);
  if (!origins) problems.push("SITE_ORIGINS_INVALID");
  if (origin && origins && !origins.includes(origin)) problems.push("SITE_ORIGIN_NOT_ALLOWED");
  const value = problems.length ? build(DEFAULT_SITE_ORIGIN, DEFAULT_SITE_ORIGINS, problems) : build(origin, origins, null);
  memo = { key, value };
  return value;
}

/** Is `hostname` one this Worker serves in place (SITE_ORIGINS)? Exact, lower-case match; never a suffix match. */
export const isAcceptedHost = (site, hostname) => typeof hostname === "string" && site.hosts.includes(hostname.toLowerCase());
/** Is `hostname` an old name that forwards to the canonical host? */
export const isForwardHost = (site, hostname) => typeof hostname === "string" && site.forwardHosts.includes(hostname.toLowerCase());

/** How the Worker names itself to outside APIs (Raydium and Jupiter answer 403 to some default agents): "<host>/1.0 (+<origin>)". */
export const userAgent = (site = DEFAULT_SITE) => `${site.host}/1.0 (+${site.origin})`;
/** The User-Agent of calls made without an environment at hand: today's value, "vicinity.city/1.0 (+https://vicinity.city)". */
export const USER_AGENT = userAgent(DEFAULT_SITE);
