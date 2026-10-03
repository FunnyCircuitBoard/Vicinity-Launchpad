/**
 * The small pieces of member profiles (PROFILES=on) that more than one file needs. They live here, and not in
 * src/profiles.js, so that src/me.js (follower counts) and src/moderation.js (clearing a bio) never import the handlers
 * that import them (no import cycle; the same split as src/signup-core.js).
 *
 *   SHOWN         which members other people may see: not a test-lab row, no active ban, and a username
 *   countsOf      a member's exact follower and following counts, from the rows themselves (never a stored number)
 *   findMember    a member by username, case-insensitively, through the unique index on lower(handle)
 *   cleanBio      the bio rules (100 characters, one line, no links, addresses, e-mail addresses or phone numbers)
 *   within        one atomic rate-limit hit (src/limits.js) for a signed-in member
 */
import { HOUR, DAY, iso } from "./policy.js";
import { check, limitKey } from "./limits.js";
import { HAS_ADDRESS, cleanText } from "./text.js";

export const MAX_BIO = 100;          // characters, counted as Unicode code points
export const MAX_FOLLOWING = 1000;   // people one member may follow
export const MAX_BLOCKS = 1000;      // people one member may block
export const PAGE = 50;              // a page of followers / following
export const SEARCH_MAX = 8;         // results of a member search

/** Tries per window and per member, counted BEFORE the work (so a refused one counts too). */
export const LIMITS = {
  view:   { max: 120, windowMs: HOUR },   // profiles opened
  search: { max: 60,  windowMs: HOUR },   // searches
  follow: { max: 60,  windowMs: HOUR },   // follow + unfollow actions
  block:  { max: 60,  windowMs: HOUR },   // block + unblock actions
  list:   { max: 120, windowMs: HOUR },   // follower, following and block lists opened
  bio:    { max: 10,  windowMs: DAY },    // bio changes
  report: { max: 30,  windowMs: DAY },    // bio reports (the same number as post reports: POLICY.limits.reportsPerDay)
};

/**
 * One atomic hit on this member's counter for `kind`. true = still within the limit. A database failure throws:
 * the caller answers an error, never "allowed because counting failed".
 */
export async function within(env, kind, userId, now) {
  const L = LIMITS[kind];
  return (await check(env, [{ key: await limitKey(env, `pf-${kind}`, userId), windowMs: L.windowMs, max: L.max }], now)).ok;
}

/**
 * SQL for "a member other people may see", for table alias `u` and a placeholder `p` that holds the time (an ISO text).
 * Test-lab rows are not people, a member under an active ban (in their own country, or everywhere) is hidden like in
 * the feeds, and a row without a username cannot be addressed at all.
 */
export const SHOWN = (u, p) => `${u}.handle IS NOT NULL AND ${u}.provider != 'testlab' AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.user_id = ${u}.id AND (b.country = '*' OR b.country = ${u}.home_country) AND (b.expires_at IS NULL OR b.expires_at > ${p}))`;

/** The counts as a prepared statement (so a handler can run it in the same batch as a change). */
export const countsStatement = (db, userId, now) => db.prepare(
  `SELECT
     (SELECT COUNT(*) FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ?1 AND ${SHOWN("u", "?2")}) AS followers,
     (SELECT COUNT(*) FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ?1 AND ${SHOWN("u", "?2")}) AS following`).bind(userId, iso(now));

/** { followers, following } of one member: exact, and counting only members that the lists would show as well. */
export async function countsOf(db, userId, now = Date.now()) {
  const r = await countsStatement(db, userId, now).first();
  return { followers: Number(r?.followers) || 0, following: Number(r?.following) || 0 };
}

/** A username from a query or a request body: 1 to 40 characters, no control characters. null if it is not one. */
export function parseHandle(v) {
  if (typeof v !== "string") return null;
  const h = v.trim();
  return h && h.length <= 40 && !/[\u0000-\u001f\u007f]/.test(h) ? h : null;
}

const MEMBER_COLUMNS = "u.id, u.wallet, u.handle, u.provider, u.home_city, u.home_name, u.home_country, u.early, u.badges, u.bio, u.created_at";

/**
 * A member by username. Case does not matter, and the lookup goes through the unique index (lower(handle) where handle
 * is not null: the `handle IS NOT NULL` is what lets SQLite use that partial index).
 *   viewerId  this member is always found (you can open your own profile), others only when they are SHOWN
 *   any       found whatever they are (moderators)
 * Returns the row (never a name, e-mail, phone or provider id in it) or null.
 */
export async function findMember(db, handle, { now = Date.now(), viewerId = 0, any = false } = {}) {
  const where = any ? "" : ` AND (u.id = ?3 OR (${SHOWN("u", "?2")}))`;
  const stmt = db.prepare(`SELECT ${MEMBER_COLUMNS} FROM users u WHERE u.handle IS NOT NULL AND lower(u.handle) = lower(?1)${where}`);
  return (any ? stmt.bind(handle) : stmt.bind(handle, iso(now), viewerId)).first();
}

/** A member by id (always found, any state). */
export const memberById = (db, id) => db.prepare(`SELECT ${MEMBER_COLUMNS} FROM users u WHERE u.id = ?`).bind(id).first();

/* ---------------- the bio ---------------- */

const URL_SCHEME = /(?:^|[^a-z0-9])(?:https?|ftp|wss?|sftp)\s*:|\/\/|\bwww\s*\./i;
// name.suffix with a letters-only suffix of 2+ characters: vicinity.city, t.me/x, bit.ly, linktr.ee. A dot followed by a digit (v1.2) or one letter (e.g.) is not a link.
const DOMAIN = /(?:^|[^a-z0-9])[a-z0-9][a-z0-9-]*\.[a-z]{2,}(?![a-z0-9])/i;
// "vicinity (dot) city", "vicinity [dot] city", and the word "dot" in front of a common ending ("vicinity dot city")
const SPELLED_DOT = /[\(\[\{]\s*dot\s*[\)\]\}]|\bdot\s+(?:com|net|org|io|xyz|app|city|me|co|gg|ly|sol|fun|pro|dev|link|ai|info|biz|online|site|club|top|cc|tv)\b/i;
const EMAIL = /[^\s@]+@[^\s@]+|[\(\[\{]\s*at\s*[\)\]\}]|\b[a-z0-9._-]+\s+at\s+[a-z0-9-]+\s+dot\s+[a-z]{2,}\b/i;
// seven or more digits in a row, with spaces, dots, dashes or brackets between them: a phone number (a big number such as 10M is written short)
const PHONE = /\+?\p{Nd}(?:[\s().\-]*\p{Nd}){6,}/u;
// a wallet address on any chain: Solana (base58), Ethereum (0x + hex), anything else that is one long unbroken word
const ADDRESS_LIKE = /(?<![A-Za-z0-9])0x[0-9a-fA-F]{16,}|[A-Za-z0-9]{26,}/;
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const BAD_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// characters that show nothing and are dropped: zero-width space and non-joiner (not U+200D, the joiner that makes one emoji of a family),
// the word joiner and the invisible operators U+2060-2064, the byte-order mark, the soft hyphen, the Mongolian vowel separator, the C1
// controls U+0080-009F and the TAG block U+E0000-E007F (invisible in every browser: a known way to hide text in a bio)
const INVISIBLE = /[\u200B\u200C\u2060-\u2064\uFEFF\u00AD\u180E\u0080-\u009F\u{E0000}-\u{E007F}]/gu;

/**
 * The bio rules, in one place. Returns { ok: true, bio } (bio is "" to clear it) or { ok: false, error }:
 *   bad_request      not text
 *   bio_too_long     more than 100 characters (counted as Unicode code points: an emoji is one)
 *   bio_not_allowed  a link, a wallet address, an e-mail address, a phone number, text that reads backwards (right-to-left
 *                    overrides), a pile of stacked accents, or broken characters
 * Hygiene is the posts' (cleanText: control characters out) plus: any line break or tab becomes a space, runs of spaces
 * become one, invisible characters are removed, the text is stored in normal form (NFC). Links, addresses and the like are
 * looked for in the compatibility form of the text (NFKC), so full-width letters and look-alike dots cannot hide them.
 */
export function cleanBio(raw) {
  if (typeof raw !== "string") return { ok: false, error: "bad_request" };
  if (raw.length > 2000) return { ok: false, error: "bio_too_long" };
  let t = raw.normalize("NFC").replace(/[\r\n\t\u0085\u2028\u2029]+/g, " ");
  t = cleanText(t, 2000);
  if (t == null) return { ok: false, error: "bio_too_long" };
  t = t.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if ([...t].length > MAX_BIO) return { ok: false, error: "bio_too_long" };
  if (!t) return { ok: true, bio: "" };
  if (BIDI.test(t) || BAD_SURROGATE.test(t) || /\p{M}{4,}/u.test(t)) return { ok: false, error: "bio_not_allowed" };
  const k = t.normalize("NFKC").replace(/[\u3002\uFF61\u2024\uFE52]/g, ".");
  if (URL_SCHEME.test(k) || DOMAIN.test(k) || SPELLED_DOT.test(k) || EMAIL.test(k) || PHONE.test(k) || HAS_ADDRESS.test(k) || ADDRESS_LIKE.test(k)) {
    return { ok: false, error: "bio_not_allowed" };
  }
  return { ok: true, bio: t };
}
