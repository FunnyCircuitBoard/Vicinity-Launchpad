/**
 * The page footer's official social links, from one source (owner amendment 01, stage S02A; amendment section 6). The page build
 * (scripts/pages/build.mjs) writes them into every page from these functions; that is where visitors get them. In production the Worker
 * serves no page at all: wrangler.jsonc run_worker_first lists only /api/*, /coin-meta/* and /official-coins.csv, and not_found_handling
 * "404-page" serves the 404 page from the assets without calling the Worker (an explicit list also opts out of the navigation-request
 * handling). So the footers follow MAIN_TOKEN_V5 only through the build, and the Worker counts the switch only when the deployed pages
 * were built with it (src/pages-built.js, src/v5policy.js mainTokenV5). officialLinksInPage below is a safety net for HTML the Worker does
 * fetch from the assets itself (none in production today), with the same markup for the same configuration.
 *
 *   socialList(profiles, L)       the footer's <ul class="site-footer__social"> block for a list of profiles (src/official.js
 *                                 socialProfiles), or nothing at all for an empty list (an unset link is not shown, and an empty list
 *                                 is not announced to a screen reader). With MAIN_TOKEN_V5 off the profiles are today's, and the block
 *                                 is byte for byte the one the layout wrote before (test/build-parity.test.js).
 *   rewriteSocialLinks(html, profiles, L)   the same block put into a built page, plus the page's other links to the former X account
 *                                 (the dashboard's "Contact us on X"): pointed at the configured X account, or removed when none is
 *                                 configured. The former account is never shown as the official one.
 *   officialLinksInPage(res, env) the Worker's hook: while MAIN_TOKEN_V5 does not count the response is returned untouched (the same
 *                                 object); while it counts an HTML response gets rewriteSocialLinks with the configured links.
 *
 * Every value written into markup is escaped; the links themselves come from the policy's shape check (src/maintoken.js
 * officialLinks), and an address that is not a plain https:// link stops the page build (and is refused at response time).
 */
import { mainTokenV5 } from "./v5policy.js";
import { socialProfiles } from "./official.js";
import { brandLabels, brandOf } from "./brand.js";
import { LEGACY_X_URL } from "./maintoken.js";

// The paths are Simple Icons' (CC0), drawn in the text colour. A network without an icon here shows its name.
export const SOCIAL_ICON = {
  x: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
  telegram: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
  discord: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
  youtube: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
  instagram: "M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.668 1.0745-1.3367 1.3795-2.1272.2957-.7637.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077",
  tiktok: "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z",
};

/** Text written into markup: escaped, so an entry with a quote or "<" cannot break the page. */
export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A label set of src/brand.js with every string escaped (the layout's labels are made from it, so each is safe in markup as it is). */
export const escBrand = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === "string" ? esc(v) : v]));
const SAFE_URL = /^https:\/\/[^\s"'<>]+$/;
const urlOf = (p) => p.url || `https://${p.hosts[0]}/${p.handle.replace(/^@/, "")}`;

/** One round icon link per profile: the <li> lines of the footer list. An address that is not a plain https:// link throws. */
export function socialItems(profiles, L) {
  return profiles.map((p) => {
    const url = urlOf(p);
    if (!SAFE_URL.test(url)) throw new Error(`SOCIAL_PROFILES: ${p.network} needs an https:// address (${url})`);
    const path = SOCIAL_ICON[p.network.toLowerCase()];
    const face = path ? `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="${path}"/></svg>` : `<span class="social-link__name">${esc(p.network)}</span>`;
    return `        <li><a class="social-link" href="${url}" target="_blank" rel="noopener me" aria-label="${L.socialLink(esc(p.network), esc(p.handle))}">${face}</a></li>`;
  }).join("\n");
}

/** The footer's social block, with its line break; "" for no profile at all. */
export const socialList = (profiles, L) => (profiles.length
  ? `      <ul class="site-footer__social" aria-label="${L.socialList}" data-fb-avoid>\n${socialItems(profiles, L)}\n      </ul>\n`
  : "");

const FOOTER_BLOCK = /^[ \t]*<ul class="site-footer__social"[^>]*>[\s\S]*?<\/ul>[ \t]*\n/m;
const LEGACY_HREF = `href="${LEGACY_X_URL}"`;
const LEGACY_ITEM = new RegExp(`^[ \\t]*<li><a ${LEGACY_HREF.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}[^>]*>[^<]*</a></li>[ \\t]*\\n`, "gm");
const LEGACY_ANCHOR = new RegExp(`<a ${LEGACY_HREF.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([^>]*)>([^<]*)</a>`, "g");
const LEGACY_HANDLE = `@${LEGACY_X_URL.split("/").pop()}`;

/**
 * A built page with its footer's social block made from `profiles`, and every other link to the former X account pointed at the
 * configured X account (its words name the configured handle) or, with no X account configured, taken out (a list item that holds
 * only that link goes with it; any other such link keeps its words without the link).
 */
export function rewriteSocialLinks(html, profiles, L) {
  let out = FOOTER_BLOCK.test(html) ? html.replace(FOOTER_BLOCK, () => socialList(profiles, L)) : html;
  const x = profiles.find((p) => p.network === "X") || null;
  if (x) {
    const url = urlOf(x);
    if (!SAFE_URL.test(url)) throw new Error("the configured X address is not a plain https:// link");
    out = out.replace(LEGACY_ANCHOR, (_, attrs, text) => `<a href="${esc(url)}"${attrs}>${text.split(LEGACY_HANDLE).join(esc(x.handle))}</a>`);
  } else {
    out = out.replace(LEGACY_ITEM, "").replace(LEGACY_ANCHOR, (_, attrs, text) => text);
  }
  return out;
}

/** The labels a page is built with, for this environment (BRAND; an unknown value keeps today's labels, src/brand.js). */
const pageLabels = (env) => brandLabels(escBrand(brandOf(env)));

/**
 * The Worker's response-time hook for HTML it fetches from the assets itself (src/index.js, the static-asset fallback; no page in
 * production, see the top of this file). MAIN_TOKEN_V5 not counting: `res` itself, untouched. Counting: the page with the configured links
 * (rewriteSocialLinks); its length and ETag change with its bytes, so they are dropped. A page that cannot be rewritten loses its social
 * links rather than showing the former account.
 */
export async function officialLinksInPage(res, env) {
  if (!mainTokenV5(env) || !res || !/^text\/html\b/i.test(res.headers.get("content-type") || "")) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("etag");
  if (!res.body) return new Response(null, { status: res.status, statusText: res.statusText, headers });
  const html = await res.text();
  let out;
  try { out = rewriteSocialLinks(html, socialProfiles(env), pageLabels(env)); }
  catch { out = rewriteSocialLinks(html, [], pageLabels(env)); }
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
}
