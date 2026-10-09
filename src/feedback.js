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
 *     page     the path of the page the widget was opened on ("/cities?city=5128581"). Only the pathname and the few query keys
 *              that name a thing on this site (PAGE_KEYS: a city, a coin, a chart range, a profile, a tab) are kept; every other
 *              key is dropped here AND in the widget, because some of this site's addresses carry one-time sign-in codes
 *              (/connect?carry=, /locate?code=, /connect?pair=) or a wallet someone only looked up (/token?address=).
 *     website  the honeypot: people never see this field, so a filled one is a bot. Answered "ok" and stored nowhere.
 *     → { ok: true }  or  400 bad_json | bad_kind | bad_message | bad_email | bad_city, 403 wrong_origin,
 *       429 slow_down (+ Retry-After and retryAfter seconds in the body), 503 unavailable
 *
 * What is kept, and nothing more: the fields above, the signed-in user's id if any, and a COARSE browser description made here
 * from the User-Agent header (device and browser family, and whether it is a wallet app's own browser), never the raw header,
 * never an address. The message is never written to a log (errors are logged with a short code only). Nothing is kept for ever:
 * pruneFeedback (run by the 10-minute job) blanks the e-mail, page and browser of a message RETENTION.scrubDays after an admin
 * marked it done and deletes the row RETENTION.deleteDays after; an admin can delete one at once (POST /api/admin/feedback/delete).
 *
 * Abuse: same-site Origin like every other POST (src/http.js sameSite), a JSON body of at most 8,192 characters, the honeypot,
 * and the atomic counters of src/limits.js, counted BEFORE anything is written and in TWO steps like the sign-up (src/signup.js
 * handleStart): first the connection (5 an hour, 20 a day) and, for a signed-in member, the member (the same), and only a try
 * that passed those counts on the whole site (LIMITS.site.hour an hour, raised with FEEDBACK_MAX_PER_HOUR). So one connection
 * sending thousands of refused tries never uses up the site's allowance for everybody. The site count is a guard on how fast
 * the table can grow, not on one person: a signed-in member, who has their own counters, is not refused by it. A failed count
 * refuses the message (503), never "allow everything".
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
  site: { hour: 1000 },                   // visitors who are not signed in, the whole site; FEEDBACK_MAX_PER_HOUR raises it without a deploy
};
/** How long a message is kept once an admin marked it done: the contact details go first, the row later (both in days). */
export const RETENTION = { scrubDays: 30, deleteDays: 180 };
/** The query keys of this site's addresses that may travel with a message (they name a public thing, never a person or a code). */
export const PAGE_KEYS = ["city", "mint", "tf", "u", "tab", "step", "welcome"];
const BODY_MAX = 8192;                    // characters of JSON (readJson counts characters, so a multi-byte body may be a little larger in bytes)
// explicit bidi controls (U+202A-202E, U+2066-2069) can make a message read backwards in the Inbox; people never type them
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;

/** The whole site's ceiling on messages per hour from visitors who are not signed in (FEEDBACK_MAX_PER_HOUR, like SIGNUP_MAX_PER_HOUR). */
export const siteMax = (env) => (Number(env.FEEDBACK_MAX_PER_HOUR) > 0 ? Number(env.FEEDBACK_MAX_PER_HOUR) : LIMITS.site.hour);

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

/**
 * The path of one of this site's pages, as the widget sends it, or null: the pathname plus the PAGE_KEYS of its query string, in
 * the order given, nothing else (no other key, no hash, never another site's address, never anything odd). The widget does the
 * same before sending (public/feedback.js pagePath), so a code in the address bar never leaves the browser; this is the second guard.
 */
export function cleanPage(p) {
  if (typeof p !== "string") return null;
  const s = p.trim();
  if (!s.startsWith("/") || s.startsWith("//") || /[\s\u0000-\u001f\u007f<>"'`\\]/.test(s)) return null;
  const cut = s.search(/[?#]/);
  const path = cut < 0 ? s : s.slice(0, cut);
  const query = cut < 0 || s[cut] !== "?" ? "" : s.slice(cut + 1).split("#")[0];
  const kept = [];
  for (const part of query.split("&")) {
    const [k, ...rest] = part.split("=");
    if (PAGE_KEYS.includes(k) && rest.length && rest[0] !== "") kept.push(`${k}=${rest.join("=")}`);
  }
  return (path + (kept.length ? "?" + kept.join("&") : "")).slice(0, 200);
}

/** A text field people type (message, city, country): a string only, cleaned, without bidi controls; null when refused. */
const typed = (v, max) => (v == null ? "" : typeof v === "string" ? cleanText(v.replace(BIDI, ""), max) : null);

const slowDown = (seconds) => json({ ok: false, error: "slow_down", retryAfter: seconds }, 429, { "Retry-After": String(seconds) });

export async function handleFeedback(request, env, now = Date.now()) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  if (!env.DB) return json({ ok: false, error: "unavailable" }, 503);
  const body = await readJson(request, BODY_MAX);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);

  // the honeypot: nothing stored, nothing counted, and the bot is told it worked
  if (typeof body.website === "string" ? body.website.trim() : body.website) return json({ ok: true });

  const kind = KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) return json({ ok: false, error: "bad_kind" }, 400);
  const message = typed(body.message, MESSAGE_MAX);
  if (message === null || (kind !== "city" && message.length < 5)) return json({ ok: false, error: "bad_message" }, 400);
  let city = null, country = null;
  if (kind === "city") {
    city = (typed(body.city, 80) || "").replace(/\s+/g, " ");       // null (too long, not text) reads as empty: refused below
    country = (typed(body.country, 60) || "").replace(/\s+/g, " ");
    if (city.length < 2 || country.length < 2) return json({ ok: false, error: "bad_city" }, 400);
  }
  let email = null;
  if (body.email != null && String(body.email).trim() !== "") {
    email = typeof body.email === "string" ? cleanEmail(body.email) : "";
    if (!validEmail(email)) return json({ ok: false, error: "bad_email" }, 400);
  }
  const page = cleanPage(body.page);
  const ua = coarseUa(request.headers.get("user-agent"));

  let userId = null;
  try {
    const s = await getSession(env, request, now);
    if (s && s.user) userId = s.user.id;
  } catch (e) { console.error("feedback session lookup failed", String((e && e.message) || e).slice(0, 80)); }

  // Counted before anything is written, in two steps. First this connection and (signed in) this member: a try over one of those
  // is refused right here and does NOT touch the site's counter, else one connection could close the widget for everybody.
  // Then, for a visitor who is not signed in, the whole site: how fast the table may grow from people we cannot tell apart.
  try {
    await ensureLimitsSchema(env.DB);
    const own = [
      { key: await limitKey(env, "fbi:h", clientKey(request)), windowMs: HOUR, max: LIMITS.connection.hour },
      { key: await limitKey(env, "fbi:d", clientKey(request)), windowMs: DAY, max: LIMITS.connection.day },
    ];
    if (userId) own.push(
      { key: await limitKey(env, "fbu:h", userId), windowMs: HOUR, max: LIMITS.user.hour },
      { key: await limitKey(env, "fbu:d", userId), windowMs: DAY, max: LIMITS.user.day },
    );
    const r = await check(env, own, now);
    if (!r.ok) {
      const over = own.find((s, i) => r.n[i] > s.max);
      return slowDown(Math.ceil((over ? over.windowMs : HOUR) / 1000));
    }
    if (!userId) {
      const site = await check(env, [{ key: "fb:site", windowMs: HOUR, max: siteMax(env) }], now);
      if (!site.ok) return slowDown(HOUR / 1000);
    }
  } catch (e) {
    console.error("feedback count failed", String((e && e.message) || e).slice(0, 80));
    return json({ ok: false, error: "unavailable" }, 503);
  }

  try {
    await ensureFeedbackSchema(env.DB);
    const at = iso(now);
    await env.DB.prepare(
      "INSERT INTO feedback (kind, message, email, city, country, user_id, page, ua, status, admin_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL, ?, ?)")
      .bind(kind, message, email, city, country, userId, page, ua, at, at).run();
    // the same answer as the honeypot's: the row's number would tell a bot it was stored, and everyone the running total
    return json({ ok: true });
  } catch (e) {
    console.error("feedback store failed", String((e && e.message) || e).slice(0, 80));
    return json({ ok: false, error: "unavailable" }, 503);
  }
}

/**
 * Retention, run by the 10-minute job (src/jobs.js): a message an admin marked done loses its reply e-mail, page and browser
 * RETENTION.scrubDays after that change (the admin's note and the text stay for the team's memory), and the whole row goes
 * RETENTION.deleteDays after it. Messages still new or seen are kept: they are work to do. Never makes the table: with no
 * message ever sent there is nothing to prune, and the job must not create tables the site has not needed yet.
 */
export async function pruneFeedback(db, now = Date.now()) {
  const has = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feedback'").first();
  if (!has) return { skipped: "no table" };
  const [scrubbed, deleted] = await db.batch([
    db.prepare("UPDATE feedback SET email = NULL, page = NULL, ua = NULL WHERE status = 'done' AND updated_at < ? AND (email IS NOT NULL OR page IS NOT NULL OR ua IS NOT NULL)")
      .bind(iso(now - RETENTION.scrubDays * DAY)),
    db.prepare("DELETE FROM feedback WHERE status = 'done' AND updated_at < ?").bind(iso(now - RETENTION.deleteDays * DAY)),
  ]);
  return { scrubbed: scrubbed.meta.changes || 0, deleted: deleted.meta.changes || 0 };
}
