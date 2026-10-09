/**
 * "Feedback / Support": the floating widget on every page (public/feedback.js) posts here. A question, a bug report or a
 * request for a city, with an optional e-mail for a reply. No login needed; a signed-in member's user id is noted so an answer
 * can reach the right account. The admin console's Inbox (src/admin.js, /api/admin/feedback) reads and manages the messages.
 *
 *   POST /api/feedback { kind, message, email?, city?, country?, page?, website? }
 *     kind     "question" | "bug" | "city"
 *     message  at most 1,000 characters (a city request may leave it empty: the city and country say it all)
 *     email    optional, for a reply; a loose shape check, stored lower-case
 *     city, country  a city request only: the city's name and its country, as typed
 *     page     the path of the page the widget was opened on ("/cities?city=5128581"); anything else is dropped
 *     website  the honeypot: people never see this field, so a filled one is a bot. Answered "ok" and stored nowhere.
 *     → { ok: true, id }  or  400 bad_json | bad_kind | bad_message | bad_email | bad_city, 403 wrong_origin, 429 slow_down, 503 unavailable
 *
 * What is kept, and nothing more: the fields above, the signed-in user's id if any, and a COARSE browser description made here
 * from the User-Agent header (device and browser family, and whether it is a wallet app's own browser), never the raw header,
 * never an address. The message is never written to a log (errors are logged with a short code only).
 *
 * Abuse: same-site Origin like every other POST (src/http.js sameSite), a JSON body of at most 8 KB, the honeypot, and the atomic
 * counters of src/limits.js, counted BEFORE anything is written: 5 an hour and 20 a day per connection, the same per signed-in
 * member, and 300 an hour for the whole site. A failed count refuses the message (503), never "allow everything".
 * Table: FEEDBACK_MIGRATION in src/store.js, made on the first message.
 */
import { getSession, cleanEmail, validEmail } from "./auth.js";
import { json, readJson, sameSite } from "./http.js";
import { check, clientKey, limitKey } from "./limits.js";
import { ensureFeedbackSchema, ensureLimitsSchema } from "./store.js";
import { cleanText } from "./text.js";
import { DAY, HOUR, iso } from "./policy.js";

export const KINDS = ["question", "bug", "city"];
export const STATUSES = ["new", "seen", "done"];
export const MESSAGE_MAX = 1000;
export const LIMITS = {
  connection: { hour: 5, day: 20 },
  user: { hour: 5, day: 20 },
  site: { hour: 300 },
};
const BODY_MAX = 8192;

/**
 * A short, coarse description of the browser from its User-Agent header: "iPhone · Safari", "Android · Chrome · Phantom app",
 * "Windows · Firefox". Never the raw header (which carries exact versions, and on some phones the device model).
 */
export function coarseUa(ua) {
  const s = String(ua || "");
  if (!s.trim()) return null;
  const has = (re) => re.test(s);
  const device = has(/iPad/) ? "iPad" : has(/iPhone|iPod/) ? "iPhone" : has(/Android/) ? "Android" : has(/Windows/) ? "Windows"
    : has(/Macintosh|Mac OS X/) ? "Mac" : has(/CrOS/) ? "ChromeOS" : has(/Linux/) ? "Linux" : "Other";
  // a wallet app's own browser: Android says "wv", an iPhone app's WebView has no "Safari/" at all
  const inApp = has(/\bwv\b/) || (has(/iPhone|iPad|iPod/) && !has(/Safari\//));
  const browser = has(/Edg(e|A|iOS)?\//) ? "Edge" : has(/OPR\/|Opera/) ? "Opera" : has(/SamsungBrowser/) ? "Samsung Internet"
    : has(/Firefox|FxiOS/) ? "Firefox" : inApp ? "in-app browser" : has(/CriOS|Chrome\//) ? "Chrome" : has(/Safari\//) && has(/Version\//) ? "Safari" : "Other";
  const app = (s.match(/\b(Phantom|Solflare|Backpack|OKX|Coinbase|Trust|Bitget|MagicEden|Exodus|Jupiter|Binance)\b/i) || [])[1];
  return [device, browser, app ? `${app} app` : null].filter(Boolean).join(" · ").slice(0, 60);
}

/** The path of one of this site's pages, as the widget sends it, or null. Never another site's address, never anything odd. */
export function cleanPage(p) {
  if (typeof p !== "string") return null;
  const s = p.trim();
  if (!s.startsWith("/") || s.startsWith("//") || /[\s\u0000-\u001f\u007f<>"'`\\]/.test(s)) return null;
  return s.slice(0, 200);
}

const slowDown = (seconds) => json({ ok: false, error: "slow_down" }, 429, { "Retry-After": String(seconds) });

export async function handleFeedback(request, env, now = Date.now()) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  if (!env.DB) return json({ ok: false, error: "unavailable" }, 503);
  const body = await readJson(request, BODY_MAX);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);

  // the honeypot: nothing stored, nothing counted, and the bot is told it worked
  if (typeof body.website === "string" ? body.website.trim() : body.website) return json({ ok: true });

  const kind = KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) return json({ ok: false, error: "bad_kind" }, 400);
  const message = cleanText(body.message, MESSAGE_MAX);
  if (message === null || (kind !== "city" && message.length < 5)) return json({ ok: false, error: "bad_message" }, 400);
  let city = null, country = null;
  if (kind === "city") {
    city = (cleanText(body.city, 80) || "").replace(/\s+/g, " ");       // null (too long) reads as empty: refused below
    country = (cleanText(body.country, 60) || "").replace(/\s+/g, " ");
    if (city.length < 2 || country.length < 2) return json({ ok: false, error: "bad_city" }, 400);
  }
  let email = null;
  if (body.email != null && String(body.email).trim() !== "") {
    email = cleanEmail(body.email);
    if (!validEmail(email)) return json({ ok: false, error: "bad_email" }, 400);
  }
  const page = cleanPage(body.page);
  const ua = coarseUa(request.headers.get("user-agent"));

  let userId = null;
  try {
    const s = await getSession(env, request, now);
    if (s && s.user) userId = s.user.id;
  } catch (e) { console.error("feedback session lookup failed", String((e && e.message) || e).slice(0, 80)); }

  // counted before anything is written: the connection, the member, the whole site
  try {
    await ensureLimitsSchema(env.DB);
    const specs = [
      { key: await limitKey(env, "fbi:h", clientKey(request)), windowMs: HOUR, max: LIMITS.connection.hour },
      { key: await limitKey(env, "fbi:d", clientKey(request)), windowMs: DAY, max: LIMITS.connection.day },
      { key: "fb:site", windowMs: HOUR, max: LIMITS.site.hour },
    ];
    if (userId) specs.push(
      { key: await limitKey(env, "fbu:h", userId), windowMs: HOUR, max: LIMITS.user.hour },
      { key: await limitKey(env, "fbu:d", userId), windowMs: DAY, max: LIMITS.user.day },
    );
    const r = await check(env, specs, now);
    if (!r.ok) {
      const over = specs.find((s, i) => r.n[i] > s.max);
      return slowDown(Math.ceil((over ? over.windowMs : HOUR) / 1000));
    }
  } catch (e) {
    console.error("feedback count failed", String((e && e.message) || e).slice(0, 80));
    return json({ ok: false, error: "unavailable" }, 503);
  }

  try {
    await ensureFeedbackSchema(env.DB);
    const at = iso(now);
    const r = await env.DB.prepare(
      "INSERT INTO feedback (kind, message, email, city, country, user_id, page, ua, status, admin_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL, ?, ?)")
      .bind(kind, message, email, city, country, userId, page, ua, at, at).run();
    return json({ ok: true, id: r.meta.last_row_id });
  } catch (e) {
    console.error("feedback store failed", String((e && e.message) || e).slice(0, 80));
    return json({ ok: false, error: "unavailable" }, 503);
  }
}
