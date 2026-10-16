/**
 * In-app notices, only while NOTIFY=on (src/flags.js notifyOn; otherwise src/index.js answers "not found" as for any unknown path, and
 * no hook below writes a row). One plain sentence per event, shown on the dashboard's Notifications tab. No e-mail, no push, no messaging.
 *
 *   GET  /api/notices                 → { ok, unread, notices: [{ id, kind, text, href, at, read }] }  the newest 50
 *   POST /api/notices/read            { ids: [..] } or { all: true }  → { ok, unread }
 *   GET  /api/notices/prefs           → { ok, prefs: { reply, moderation, picture, founder, election } }  (all true until changed)
 *   POST /api/notices/prefs           { reply?, moderation?, picture?, founder?, election? } booleans → the same shape
 *   /api/me carries `unread` (a count) while the switch is on (src/me.js).
 *
 * Kinds, and who writes them (every hook is best effort: a notice that cannot be written is dropped and logged, the action it tells
 * about never fails for it; with the switch off no hook touches the database):
 *   reply       someone replied to your post (src/social.js): never yourself, never when the replier is someone you muted or blocked or
 *               who blocked you (when those tables exist), never for a deleted or hidden parent. One unread row per post: a second
 *               reply before you read the first bumps that row ("New replies to your post.") instead of adding one, so nobody can
 *               flood your list with replies
 *   moderation  your post was hidden (with the public reason) or shown again, a ban against you was applied, your appeal was decided
 *               (src/moderation.js, and the five-report hide in src/social.js)
 *   picture     your coin picture was approved, not approved (with the reason: the note stays on the coin card) or taken down
 *               (src/admin.js, src/coins.js)
 *   founder     a claim or challenge window opened in your home city, a verdict in a window you applied to, an objection against
 *               your seat was decided, your Seed Steward probation ended (src/seats.js, src/admin.js)
 *   election    a Country Manager election opened or closed in your home country (src/elections.js)
 * Rules kept here, in one place:
 *   - the text is built by the server from facts the person could already see on the site (usernames, cities, the rules' reasons in
 *     the site's own words); never a display name or any other free text, never a wallet address, never HTML; at most 200 characters
 *     (line)
 *   - a kind the person switched off (users.notice_prefs) writes nothing for them; a fan-out (a city, a country) is ONE statement that
 *     writes at most BATCH_MAX rows (5,000) and skips test-lab rows
 *   - at most KEEP (200) notices per person: beyond that, read notices go before unread ones, the oldest first, in the same write
 *     (so an unread verdict or ban is never pushed out by what the person already saw)
 *   - signed in, a real member; the list 120 times an hour, marking read and the controls 60 times an hour each (src/limits.js counters)
 */
import { json, readJson } from "./http.js";
import { access } from "./access.js";
import { notifyOn } from "./flags.js";
import { ensureLimitsSchema, ensureNotifySchema } from "./store.js";
import { check, limitKey } from "./limits.js";
import { HOUR, iso } from "./policy.js";

export const KINDS = Object.freeze(["reply", "moderation", "picture", "founder", "election"]);
export const KEEP = 200;        // notices kept per person
export const BATCH_MAX = 5000;  // rows one fan-out (an election, a claim window) writes at most
export const PAGE = 50;         // notices one GET lists
export const TEXT_MAX = 200;    // characters of one notice
/** ids one "mark read" may name: one page, and well under D1's limit of 100 bound parameters per statement (each id is one; do not raise). */
export const READ_MAX = PAGE;
/** The reply row's text once a second reply lands before the first was read. */
export const REPLIES_TEXT = "New replies to your post.";

/** Tries per hour and per member, counted BEFORE the work. */
const LIMITS = { list: { max: 120, windowMs: HOUR }, read: { max: 60, windowMs: HOUR }, prefs: { max: 60, windowMs: HOUR } };

/** One plain line: control characters and line breaks become spaces, runs of spaces one space, at most TEXT_MAX characters (counted as code points, so a two-unit character is kept whole or not at all). */
export const line = (s) => Array.from(String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim()).slice(0, TEXT_MAX).join("");
/**
 * The rules' reason codes (POLICY.moderation.reasons) in the words the site already uses for them, so a notice and the card or feed
 * tag it points at say the same thing: the feed's words for a post, the coin card's words for a picture. An unknown code reads as "other".
 */
export const POST_REASON = Object.freeze({ spam: "spam", scam: "scam or fake token", abuse: "abuse", illegal: "illegal content", off_topic: "off topic", other: "it breaks the rules" });
export const PICTURE_REASON = Object.freeze({ spam: "spam", scam: "scam or impersonation", abuse: "abuse or hate", illegal: "illegal", off_topic: "not about the city", other: "it breaks the rules" });
export const postReason = (r) => POST_REASON[r] || POST_REASON.other;
export const pictureReason = (r) => PICTURE_REASON[r] || PICTURE_REASON.other;
/** A ref column value: an id as text, or null. */
const refOf = (v) => (v == null ? null : String(v).slice(0, 64));
/** The JSON path of a kind in notice_prefs, and the SQL that says "this member wants this kind" (NULL or a missing key = yes). */
const WANTS = "COALESCE(json_extract(u.notice_prefs, ?), 1) <> 0";
const prefPath = (kind) => `$.${kind}`;

/** The stored preferences as the five booleans (every kind on until switched off; anything unreadable counts as on). */
export function prefsOf(text) {
  let stored = null;
  try { stored = text ? JSON.parse(text) : null; } catch { stored = null; }
  const out = {};
  for (const k of KINDS) out[k] = !(stored && typeof stored === "object" && stored[k] === false);
  return out;
}

/** Binds ?1 to, ?2 kind, ?3 ref, ?4 text, ?5 href, ?6 now, ?7 the kind's path in notice_prefs (the reply hook adds ?8 and ?9). */
const INSERT_ONE = `INSERT INTO notices (user_id, kind, ref, text, href, created_at)
  SELECT u.id, ?2, ?3, ?4, ?5, ?6 FROM users u WHERE u.id = ?1 AND ${WANTS.replace("?", "?7")}`;
/** What one person keeps: KEEP rows, unread before read, the newest first (the list shows them in this order too). */
const KEPT = "(read_at IS NULL) DESC, created_at DESC, id DESC";
/** Everything of one person beyond what they keep (nothing when they have fewer). Binds ?1 the person, ?2 KEEP. */
const TRIM_ONE = `DELETE FROM notices WHERE user_id = ?1 AND id NOT IN (SELECT id FROM notices WHERE user_id = ?1 ORDER BY ${KEPT} LIMIT ?2)`;

/** Tables that may or may not exist (the feed v2 / profile migrations): a "yes" is kept for the life of the server, a "no" for a minute. */
const tablesKnown = new WeakMap();
async function hasTable(db, name, now) {
  let m = tablesKnown.get(db);
  if (!m) tablesKnown.set(db, (m = new Map()));
  const k = m.get(name);
  if (k === true) return true;
  if (typeof k === "number" && now >= k && now - k < 60_000) return false;
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first();
  m.set(name, row ? true : now);
  return Boolean(row);
}

const fail = (what, e) => { console.error(`notice not written (${what})`, String((e && e.message) || e).slice(0, 80)); return 0; };
/** Runs a hook's own lookups and notice as one best-effort step: whatever throws is logged as a notice not written, never rethrown. */
export async function attempt(kind, fn) {
  try { return await fn(); } catch (e) { return fail(kind, e); }
}
/** The statements of one notice as one batch, after the schema is in place; returns the rows changed before the trim. Never throws. */
async function write(env, kind, stmts) {
  try {
    const db = env.DB;
    await ensureNotifySchema(db);
    const out = await db.batch(stmts(db));
    return out.slice(0, -1).reduce((n, r) => n + Number((r && r.meta && r.meta.changes) || 0), 0);
  } catch (e) { return fail(kind, e); }
}

/** One notice to one person: { to (user id), kind, ref?, text, href, now? }. Returns the number of rows written (0 or 1); never throws. */
export async function notify(env, { to, kind, ref = null, text, href, now = Date.now() }) {
  if (!notifyOn(env) || !env.DB || !to || !KINDS.includes(kind)) return 0;
  const words = line(text);
  if (!words) return 0;
  return write(env, kind, (db) => [
    db.prepare(INSERT_ONE).bind(to, kind, refOf(ref), words, String(href), iso(now), prefPath(kind)),
    db.prepare(TRIM_ONE).bind(to, KEEP),
  ]);
}

/**
 * One notice to every member of a city (column "home_city") or a country ("home_country"): ONE statement, at most BATCH_MAX rows (the
 * oldest accounts first), never a test-lab row, never a member who switched the kind off; then one statement trims the people in that
 * group who now hold more than KEEP (read before unread, the oldest first). Returns { written, capped }; never throws.
 */
export async function notifyMany(env, { column, value, kind, ref = null, text, href, now = Date.now() }) {
  const none = { written: 0, capped: false };
  if (!notifyOn(env) || !env.DB || !value || !KINDS.includes(kind) || !["home_city", "home_country"].includes(column)) return none;
  const words = line(text);
  if (!words) return none;
  try {
    const db = env.DB;
    await ensureNotifySchema(db);
    const [ins] = await db.batch([
      db.prepare(`INSERT INTO notices (user_id, kind, ref, text, href, created_at)
        SELECT u.id, ?2, ?3, ?4, ?5, ?6 FROM users u WHERE u.${column} = ?1 AND u.provider != 'testlab' AND ${WANTS.replace("?", "?7")} ORDER BY u.id LIMIT ?8`)
        .bind(String(value), kind, refOf(ref), words, String(href), iso(now), prefPath(kind), BATCH_MAX),
      db.prepare(`DELETE FROM notices WHERE id IN (
          SELECT n.id FROM notices n
          WHERE n.user_id IN (SELECT user_id FROM notices WHERE user_id IN (SELECT id FROM users WHERE ${column} = ?1) GROUP BY user_id HAVING COUNT(*) > ?2)
            AND n.id NOT IN (SELECT m.id FROM notices m WHERE m.user_id = n.user_id ORDER BY ${KEPT.replace(/\b(read_at|created_at|id)\b/g, "m.$1")} LIMIT ?2))`)
        .bind(String(value), KEEP),
    ]);
    const written = Number((ins && ins.meta && ins.meta.changes) || 0);
    return { written, capped: written >= BATCH_MAX };
  } catch (e) { fail(kind, e); return none; }
}

/** A reply to a post that already has an unread reply notice bumps that row to now with REPLIES_TEXT (?9), under the same rules. */
const BUMP_REPLY = `UPDATE notices SET created_at = ?6, text = ?9 WHERE user_id = ?1 AND kind = ?2 AND ref = ?3 AND read_at IS NULL
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?1 AND ${WANTS.replace("?", "?7")}`;
/** ... and a new row is written only when no unread reply notice for that post is there. */
const NO_UNREAD_REPLY = " AND NOT EXISTS (SELECT 1 FROM notices x WHERE x.user_id = u.id AND x.kind = ?2 AND x.ref = ?3 AND x.read_at IS NULL)";

/**
 * Someone replied: the parent post's author is told, unless they are the replier, or they muted the replier, or a block stands between
 * the two either way (when those tables exist). The caller has already refused a deleted or hidden parent. The replier is named by
 * username only ("A member" without one): never a display name, which is free text. Returns the rows written or bumped (0 or 1).
 */
export async function notifyReply(env, { parent, by, now = Date.now() }) {
  if (!notifyOn(env) || !env.DB || !parent || parent.user_id === by.id || parent.hidden || parent.deleted_at) return 0;
  let unless = ""; // ?8 is the replier (one bind, used by both conditions)
  try {
    if (await hasTable(env.DB, "mutes", now)) unless += " AND NOT EXISTS (SELECT 1 FROM mutes x WHERE x.muter_id = u.id AND x.muted_id = ?8)";
    if (await hasTable(env.DB, "blocks", now)) unless += " AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = u.id AND b.blocked_id = ?8) OR (b.blocker_id = ?8 AND b.blocked_id = u.id))";
  } catch (e) { return fail("reply", e); }
  const who = by.handle || "A member";
  const binds = [parent.user_id, "reply", refOf(parent.id), line(`${who} replied to your post.`), "/dashboard#community", iso(now), prefPath("reply"), by.id, REPLIES_TEXT];
  return write(env, "reply", (db) => [
    db.prepare(BUMP_REPLY + unless + ")").bind(...binds),
    db.prepare(INSERT_ONE + unless + NO_UNREAD_REPLY).bind(...binds.slice(0, unless ? 8 : 7)), // exactly the binds the statement names
    db.prepare(TRIM_ONE).bind(parent.user_id, KEEP),
  ]);
}

/** Unread notices of one person (the dashboard's badge). The schema must be in place. */
export async function unreadCount(db, userId) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND read_at IS NULL").bind(userId).first();
  return Number((r && r.n) || 0);
}

/* ---------------- the routes ---------------- */

/** A signed-in, real member with the notice tables in place, or { error }. */
async function member(request, env, now, { write }) {
  const a = await access(request, env, now, { write });
  if (a.error) return a;
  if (a.u.provider === "testlab") return { error: json({ ok: false, error: "sign_in" }, 401) };
  try { await ensureNotifySchema(env.DB); await ensureLimitsSchema(env.DB); }
  catch (e) {
    console.error("notice tables unavailable", String((e && e.message) || e).slice(0, 80));
    return { error: json({ ok: false, error: "notices_unavailable" }, 503) };
  }
  return a;
}
/** One atomic hit on this member's counter for `kind`. true = still within the limit. */
async function within(env, kind, userId, now) {
  const L = LIMITS[kind];
  return (await check(env, [{ key: await limitKey(env, `nt-${kind}`, userId), windowMs: L.windowMs, max: L.max }], now)).ok;
}

/** GET /api/notices → the newest PAGE notices (a bumped reply row counts from its bump) and the unread count. */
export async function handleNotices(request, env, now = Date.now()) {
  const g = await member(request, env, now, { write: false });
  if (g.error) return g.error;
  const { u } = g, db = env.DB;
  if (!(await within(env, "list", u.id, now))) return json({ ok: false, error: "slow_down" }, 429);
  const rows = (await db.prepare(`SELECT id, kind, text, href, created_at, read_at FROM notices WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ${PAGE}`).bind(u.id).all()).results;
  return json({ ok: true, unread: await unreadCount(db, u.id), notices: rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, href: r.href, at: r.created_at, read: Boolean(r.read_at) })) });
}

/** POST /api/notices/read { ids: [..] } or { all: true } → marks them read (only your own; a stranger's id changes nothing). */
export async function handleNoticesRead(request, env, now = Date.now()) {
  const g = await member(request, env, now, { write: true });
  if (g.error) return g.error;
  const { u } = g, db = env.DB;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const all = body.all === true;
  const ids = Array.isArray(body.ids) ? body.ids : null;
  if (!all && (!ids || !ids.length || ids.length > READ_MAX || !ids.every((x) => Number.isInteger(x) && x > 0))) return json({ ok: false, error: "bad_request" }, 400);
  if (!(await within(env, "read", u.id, now))) return json({ ok: false, error: "slow_down" }, 429);
  if (all) await db.prepare("UPDATE notices SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(iso(now), u.id).run();
  else await db.prepare(`UPDATE notices SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`).bind(iso(now), u.id, ...ids).run();
  return json({ ok: true, unread: await unreadCount(db, u.id) });
}

/** GET /api/notices/prefs → the five booleans · POST { reply?, moderation?, picture?, founder?, election? } → saves and answers the same. */
export async function handleNoticesPrefs(request, env, write, now = Date.now()) {
  const g = await member(request, env, now, { write });
  if (g.error) return g.error;
  const { u } = g, db = env.DB;
  if (!(await within(env, "prefs", u.id, now))) return json({ ok: false, error: "slow_down" }, 429);
  const row = await db.prepare("SELECT notice_prefs FROM users WHERE id = ?").bind(u.id).first();
  const prefs = prefsOf(row && row.notice_prefs);
  if (!write) return json({ ok: true, prefs });
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  for (const k of KINDS) if (k in body && typeof body[k] !== "boolean") return json({ ok: false, error: "bad_request" }, 400);
  for (const k of KINDS) if (k in body) prefs[k] = body[k];
  await db.prepare("UPDATE users SET notice_prefs = ? WHERE id = ?").bind(JSON.stringify(prefs), u.id).run();
  return json({ ok: true, prefs });
}
