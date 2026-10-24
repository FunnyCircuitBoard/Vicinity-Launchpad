/**
 * Host-safe routing (Citycoin.dev master v5, stage S03; master section 04 BR-02 "Provision and validate" and "Route contract";
 * docs/citycoin-master/rebrand-inventory.md U01, C01, C02, C04, C05, C09 and C10; docs/citycoin-master/domain-cutover.md).
 *
 * Read only while HOST_REDIRECT counts (src/v5policy.js hostRedirect: the switch is on, the v5 configuration check accepts the deployment,
 * SITE_ORIGIN is https://citycoin.dev, and the deployed wrangler.jsonc sends every page through the Worker). Otherwise src/index.js never
 * calls hostAnswer and answers exactly as before: www.vicinity.city, vicinitycity.net and www.vicinitycity.net answer 301 to vicinity.city
 * and plain http answers 301 to https, for every method; every other host is served in place.
 *
 * hostAnswer(request, url, site, local) runs before any route and returns the answer, or null to serve the request as usual:
 *
 *   the canonical origin (https and SITE_ORIGIN's host)             null: served exactly as today
 *   a local development host (localhost, 127.0.0.1, *.localhost)    null: `wrangler dev` on this computer, never a Cloudflare route
 *   an unknown host (not in SITE_ORIGINS and not a legacy host)     421 wrong_host: refused, never served, never a redirect target
 *   an accepted host, any method but GET and HEAD                   421 wrong_host: a signed POST, an API write or a webhook delivery is
 *                                                                   never forwarded to another origin (a 308 would replay it there)
 *   an accepted host, GET or HEAD of an immutable legacy file       null: served in place, the same bytes on every accepted host
 *     (/coin-meta/*, /brand/vicinity-512.png, /official-coins.csv)  (over plain http: 308 to https on the same host, never another host)
 *   an accepted host, GET or HEAD of a wallet challenge, sign-in,   421 wrong_host: bound to the origin that issued it (the signed text
 *     pairing or other hand-off, a callback or a webhook            and the provider's return address name that host)
 *   an accepted host, GET or HEAD of any other /api route           null: read-only answers keep working through the window (over plain
 *                                                                   http: 308 to https on the same host)
 *   an accepted host, GET or HEAD of anything else (the pages and   308 to SITE_ORIGIN + the same path + only the safe query keys
 *     their files)
 *
 * The accepted hosts are SITE_ORIGINS and the legacy hosts (vicinity.city and its three old names, src/site-config.js LEGACY_HOSTS): those
 * stay attached for at least 12 months after the cutover, so their immutable files and read-only API keep answering whatever SITE_ORIGINS
 * lists. Plain http is never an accepted origin of its own: on the canonical host it is a "non-canonical" request like any other.
 *
 * Nothing here builds an address from the request's Host header. A redirect target is SITE_ORIGIN (validated by src/site-config.js and the
 * v5 check), or, for plain http to an accepted host, that host's own allowlist entry over https; the path is appended as text, never
 * resolved against the origin, and the result is checked to have the intended origin before it is sent.
 */
import { SECURITY_HEADERS, json } from "./http.js";
import { LOCAL_HOST, acceptedHost } from "./site-config.js";
import { OFFICIAL_CSV_PATH } from "./officialcoins.js";

/** Hosts of this computer (`wrangler dev`), and the accepted host's allowlist entry: kept in src/site-config.js since stage S04 (the session
 *  and challenge binding, src/hostbind.js, uses the same two), re-exported here unchanged. */
export { LOCAL_HOST, acceptedHost };
/** A visit from this computer: a local host name, or `wrangler dev` presenting a route's host (http://vicinity.city) from a local address. */
export const isLocal = (request, url) =>
  LOCAL_HOST.test(url.hostname) || ["127.0.0.1", "::1"].includes(request.headers.get("cf-connecting-ip"));

/** The immutable legacy files: exact bytes on every accepted host, never redirected (inventory C04 the partner logo named on chain, C05 the
 *  metadata URI prefix compiled into the live launchpad program, C09 the official list a tracker may fetch without following redirects). */
export const IMMUTABLE_PREFIXES = Object.freeze(["/coin-meta/"]);
export const IMMUTABLE_PATHS = Object.freeze(["/brand/vicinity-512.png", OFFICIAL_CSV_PATH]);
export const isImmutable = (path) => IMMUTABLE_PATHS.includes(path) || IMMUTABLE_PREFIXES.some((p) => path.startsWith(p));

/** Routes bound to the origin that issued them, refused on any other host even for GET: the wallet challenge (the text a wallet signs names
 *  the host, src/signed.js), sign-in (the Google start's return address names the host, src/hostbind.js; the callback carries the provider's
 *  one-time code), phone pairing, the sign-up and its location hand-off, the wallet link and its carry code, the location check, and any
 *  callback or webhook path (none is inbound today; a later one is refused here by its name until it is migrated explicitly). */
export const ORIGIN_BOUND = Object.freeze([
  /^\/api\/message$/,
  /^\/api\/auth\//,
  /^\/api\/pair(\/|$)/,
  /^\/api\/signup\//,
  /^\/api\/me\/wallet\//,
  /^\/api\/locate(\/|$)/,
  /(^|\/)(callbacks?|webhooks?)(\/|$)/i,
]);
export const isOriginBound = (path) => ORIGIN_BOUND.some((re) => re.test(path));

/**
 * The query keys a moved page keeps: each names a public thing or a view of this site (a city, a coin, a member's public profile, a looked-up
 * wallet, a tab, a search, a chart range, a sign-in screen, a swap prefill) or a campaign tag, never a secret. Every other key is dropped,
 * unknown keys included, so a code never travels to another origin in a redirect.
 */
export const SAFE_QUERY_KEYS = Object.freeze([
  "city", "mint", "u", "address", "tab", "q", "tf", "range", "unit", "style", "mode", "step", "welcome", "claim",
  "swap_in", "swap_out", "swap_amt", "swap_slip", "swap_open",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
]);
/** Keys this site uses for a hand-off, sign-in or one-time code (inventory C02 and the sign-in callbacks' own): never kept. They are not in
 *  SAFE_QUERY_KEYS (a test pins it); the list exists so the tests name each one. */
export const HANDOFF_QUERY_KEYS = Object.freeze(["link", "pair", "code", "register", "carry", "state", "ref", "next", "error", "login", "google",
  "linked", "token", "pin", "on", "app", "with"]);
const SAFE = new Set(SAFE_QUERY_KEYS);

/** The query string (with its "?", or "") with only the SAFE_QUERY_KEYS pairs, each kept byte for byte and in order. */
export function safeQuery(search) {
  const s = String(search || "").replace(/^\?/, "");
  if (!s) return "";
  const kept = [];
  for (const part of s.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    let key;
    try { key = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, " ")); } catch { continue; }
    if (SAFE.has(key)) kept.push(part);
  }
  return kept.length ? `?${kept.join("&")}` : "";
}

/** 421 Misdirected Request: this answer belongs to another origin. JSON, no Location, never cached. */
export const wrongHost = () => json({ error: "wrong_host" }, 421);

/** 308 with today's redirect headers (the security headers and one hour of caching, so HOST_REDIRECT=off undoes it within the hour). */
const moved = (location) => new Response(null, { status: 308, headers: { Location: location, ...SECURITY_HEADERS, "Cache-Control": "public, max-age=3600" } });

/** `origin` + the request's path (+ `query`), as text: an absolute address on `origin`, or null if it would name any other origin (a parsed
 *  request path always starts with "/", so this is the last guard, not the rule). */
export function onOrigin(origin, url, query) {
  let target;
  try { target = new URL(origin + url.pathname + query); } catch { return null; }
  return target.origin === origin ? target.href : null;
}

/** The answer for a request while HOST_REDIRECT counts (see the top of this file), or null to serve it as usual. */
export function hostAnswer(request, url, site, local = false) {
  const host = String(url.hostname).toLowerCase();
  if (LOCAL_HOST.test(host)) return null;
  const secure = url.protocol === "https:" || local; // `wrangler dev` presents local visits as http, as src/index.js has always allowed
  if (secure && host === site.host) return null;
  const entry = acceptedHost(site, host);
  if (!entry) return wrongHost();
  if (request.method !== "GET" && request.method !== "HEAD") return wrongHost();
  const path = url.pathname;
  if (isImmutable(path) || (path.startsWith("/api/") && !isOriginBound(path))) {
    if (secure) return null;
    const same = onOrigin(`https://${entry}`, url, url.search);
    return same ? moved(same) : wrongHost();
  }
  if (isOriginBound(path)) return wrongHost();
  const target = onOrigin(site.origin, url, safeQuery(url.search));
  return target ? moved(target) : wrongHost();
}
