/**
 * Local (your city) and national (your country) feeds: memes, check-ins and discussions, weekly votes
 * and reports. Moderation is in src/moderation.js.
 *
 * Rules, kept here in one place:
 *   - signed in, with a home community, to read or post; after launch, only holders can post and vote
 *   - 12 posts an hour at most; one check-in a day, and only from inside your community (a location attestation)
 *   - no contract addresses in posts (the only real one is on the Token page): stops fake-token scams
 *   - votes: 1 for everyone, 2 for city founders, 3 for country managers; "top" = this week (from Monday, UTC);
 *     60 votes an hour, on posts only (not on replies), and not while banned
 *   - replies are one level deep and never on a check-in
 *   - 3 reports confirm a moderator's hide; 5 reports hide a post until a moderator reviews it
 * Feed v2, only while FEED_V2=on (src/flags.js; off = every answer exactly as before):
 *   - a fourth kind, "update" (text, 500 characters, no picture): in the Local feed the city's active founder or steward, in the
 *     National feed the country's manager, admins in both; everyone reads and replies
 *   - you can delete your own post (POST /api/posts/delete): it and its replies leave every feed and count, its picture answers
 *     404; the rows stay (deleted_at) for a later purge, and nothing is logged publicly (your own deletion is not moderation).
 *     A deletion sticks: deleted_at is honoured whenever the column exists (store.js feedApplied), switch or no switch
 *   - you can mute people (src/mutes.js): their posts and replies leave YOUR feeds only; blocks hide posts both ways, except from a
 *     moderator of that feed (nobody hides from the founder or the manager by blocking them, just as they see hidden posts)
 *   - every national row carries the author's city (`where`); an account's first national post asks for one confirmation (ack)
 */
import { json, readJson } from "./http.js";
import { access } from "./access.js";
import { useAttestation, countRecent, noteEvent } from "./attest.js";
import { activeBan, canModerate, managerOf, powersOf } from "./roles.js";
import { ensureFeedSchema, ensureLimitsSchema, ensureLogoSchema, ensureSchema, feedApplied, feedReady } from "./store.js";
import { check, limitKey } from "./limits.js";
import { DAY, HOUR, POLICY, iso } from "./policy.js";
import { HAS_ADDRESS, cleanText } from "./text.js";
import { toBytes } from "./blobs.js";
import { feedV2On, profilesOn } from "./flags.js";
import { adminRoleOf } from "./admin.js";
import { PICTURE_MAX_AGE, bytesApproved } from "./logos.js";
import { notify, notifyReply } from "./notify.js";

export { cleanText };
const KINDS = ["meme", "checkin", "talk"];
const KINDS_V2 = [...KINDS, "update"]; // feed v2: announcements from the founder, the manager or Vicinity
const LIMITS = { meme: 280, checkin: 140, talk: 1000, reply: 500, update: 500 };
const kindsFor = (env) => (feedV2On(env) ? KINDS_V2 : KINDS);
const MAX_IMAGE = 200_000;
const POSTS_PER_HOUR = 12;
const VOTES_PER_HOUR = 60;
const DELETES_PER_HOUR = 60; // tries, not deletions: nobody reads the posts table number by number through /api/posts/delete

/** Monday 00:00 UTC of this week: weekly votes start here. */
export function weekStart(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

const placeFor = (u, scope) => (scope === "country" ? u.home_country : u.home_city);
/** Feed v2: may this person post an update here? The city's active founder or steward in the Local feed, the country's manager in the National one, an admin in both. */
const mayUpdate = (u, pw, scope) => Boolean(pw.admin || (scope === "city" ? pw.founderCity && pw.founderCity === u.home_city : pw.managerCountry && pw.managerCountry === u.home_country));
/**
 * Feed v2: the rows of `x` (a posts alias) this reader may see: not by someone they muted, not by someone they blocked, not by someone
 * who blocked them. Four binds (visBinds): the reader's id three times and, third, 1 when the reader moderates these rows: then a block
 * AGAINST them hides nothing, because nobody hides from the founder or the manager by blocking them (the same rule that shows them hidden
 * posts). Mutes are one way (your own view), and the reader's own blocks are their own choice, moderator or not.
 */
const VISIBLE = (x) => `NOT EXISTS (SELECT 1 FROM mutes m WHERE m.muter_id = ? AND m.muted_id = ${x}.user_id)
  AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = ${x}.user_id) OR (? = 0 AND b.blocker_id = ${x}.user_id AND b.blocked_id = ?))`;
const visBinds = (me, mod) => [me, me, mod ? 1 : 0, me];
/** Feed v2: may this reader (a moderator of it when `mod`) see this one row at all (VISIBLE)? Their own rows: always. */
const visibleTo = async (db, post, me, mod) => post.user_id === me || Boolean(await db.prepare(`SELECT 1 AS ok FROM posts p WHERE p.id = ? AND ${VISIBLE("p")}`).bind(post.id, ...visBinds(me, mod)).first());
/** The feed v2 tables, or a 503 the caller answers (a failing migration can only ever break the feed routes). */
async function feedTables(db) {
  try { await ensureFeedSchema(db); return null; }
  catch (e) { console.error("feed tables unavailable", String((e && e.message) || e).slice(0, 80)); return json({ ok: false, error: "feed_unavailable" }, 503); }
}
/** Can this person see this post? Your city's posts, your country's posts. */
const sees = (u, p, pw) => canModerate(pw, p) || (p.scope === "city" ? p.place === u.home_city : p.place === u.home_country);

export const COLS = "p.id, p.user_id, p.scope, p.place, p.country, p.kind, p.body, p.media_id, p.parent_id, p.score, p.reports, p.replies, p.hidden, p.hide_confirmed, p.hidden_until, p.created_at, u.handle, u.name, u.home_name AS author_home";
export const FROM = "FROM posts p JOIN users u ON u.id = p.user_id";

/** Posts as the page sees them: author name and live role, never their wallet. */
export async function present(env, rows, me, pw, fetchImpl = fetch, now = Date.now()) {
  if (!rows.length) return [];
  const db = env.DB;
  const ids = rows.map((r) => r.id);
  const v2 = feedV2On(env) && (await feedReady(db));
  // feed v2: the reply count a row shows is the number of replies THIS reader would see (not deleted, not from someone muted or blocked;
  // the rows of one feed, thread or queue share a scope, so one bind says whether the reader moderates them all)
  const modAll = rows.every((r) => canModerate(pw, r));
  const replyCounts = v2 ? new Map((await db.prepare(`SELECT r.parent_id AS id, COUNT(*) AS n FROM posts r WHERE r.parent_id IN (${ids.map(() => "?").join(",")})
    AND r.deleted_at IS NULL AND (r.hidden = 0 OR r.user_id = ?) AND ${VISIBLE("r")} GROUP BY r.parent_id`).bind(...ids, me.id, ...visBinds(me.id, modAll)).all()).results.map((r) => [r.id, Number(r.n)])) : null;
  const mine = new Set((await db.prepare(`SELECT post_id FROM votes WHERE user_id = ? AND post_id IN (${ids.map(() => "?").join(",")})`)
    .bind(me.id, ...ids).all()).results.map((r) => r.post_id));
  const authors = [...new Set(rows.map((r) => r.user_id))];
  // active founders and Seed Stewards (a steward has a founder's powers) carry the 👑
  const seatRows = (await db.prepare(`SELECT user_id, city_name, status FROM seats WHERE status IN ('active', 'steward') AND user_id IN (${authors.map(() => "?").join(",")})`)
    .bind(...authors).all()).results;
  const founders = new Map(seatRows.map((r) => [r.user_id, r.city_name]));
  const stewards = new Set(seatRows.filter((r) => r.status === "steward").map((r) => r.user_id));
  const managers = new Set();
  for (const cc of new Set(rows.map((r) => r.country))) { const m = await managerOf(env, cc, now); if (m) managers.add(m.userId); }
  const actions = new Map((await db.prepare(`SELECT target_id, id, state, reason FROM mod_actions WHERE target_type = 'post' AND action = 'hide' AND state IN ('pending', 'confirmed')
    AND target_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).bind(...ids).all()).results.map((r) => [r.target_id, r]));
  return rows.map((r) => {
    const mod = canModerate(pw, r), act = actions.get(r.id);
    return {
      id: r.id, kind: r.kind, body: r.body, image: r.media_id ? `/api/media/${r.media_id}` : null,
      score: r.score, replies: replyCounts ? replyCounts.get(r.id) || 0 : r.replies, at: r.created_at, hidden: Boolean(r.hidden),
      hiddenUntil: r.hidden && !r.hide_confirmed ? r.hidden_until : null,
      hideAction: r.hidden && act && (mod || r.user_id === me.id) ? { id: act.id, state: act.state, reason: act.reason } : null,
      reports: mod ? r.reports : undefined,
      // the moderators' queue keeps a reported post its author deleted (their evidence; it is in no feed and its picture answers 404)
      ...(mod && r.deleted_at ? { deleted: true } : {}),
      // the author's community: on check-ins, and (feed v2) on every national row, so a country-wide feed says which city is talking
      where: r.kind === "checkin" || (v2 && r.scope === "country") ? r.author_home : undefined,
      voted: mine.has(r.id), mine: r.user_id === me.id, canModerate: mod,
      // with member profiles on, `handle` says whether the name shown IS the author's username (null: a display name, never a profile link)
      author: { id: mod ? r.user_id : undefined, name: r.handle || r.name || "Member", ...(profilesOn(env) || v2 ? { handle: r.handle || null } : {}),
        founder: founders.get(r.user_id) || null, steward: stewards.has(r.user_id), manager: managers.has(r.user_id) },
    };
  });
}

/** GET /api/posts?scope=city|country&kind=meme|checkin|talk[|update]&sort=new|top&before=<id>  or  ?parent=<id> for replies */
export async function handlePosts(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await access(request, env, now, { write: false });
  if (a.error) return a.error;
  const u = a.u, q = new URL(request.url).searchParams, db = env.DB;
  const v2 = feedV2On(env);
  if (v2) { const bad = await feedTables(db); if (bad) return bad; }
  const pw = await powersOf(env, u, fetchImpl, now);
  // a deleted row is gone for everyone as soon as the column exists (a deletion sticks, switch or no switch); feed v2: rows by people this
  // reader muted / blocked / was blocked by are gone for them (VISIBLE; a moderator of the feed is not hidden from by a block)
  const gone = v2 || (await feedApplied(db, now)) ? " AND p.deleted_at IS NULL" : "";
  const visFor = (mod) => (v2 ? [` AND ${VISIBLE("p")}`, visBinds(u.id, mod)] : ["", []]);
  let rows;
  if (q.get("parent")) {
    const par = await db.prepare("SELECT * FROM posts WHERE id = ?").bind(Number(q.get("parent")) || 0).first();
    if (!par || par.deleted_at || !sees(u, par, pw) || (par.hidden && !canModerate(pw, par) && par.user_id !== u.id)) return json({ ok: false, error: "not_found" }, 404);
    const modHere = canModerate(pw, par);
    if (v2 && !(await visibleTo(db, par, u.id, modHere))) return json({ ok: false, error: "not_found" }, 404); // a thread you cannot see in the feed cannot be opened by its number either
    const [vis, binds] = visFor(modHere);
    rows = (await db.prepare(`SELECT ${COLS} ${FROM} WHERE p.parent_id = ? AND (p.hidden = 0 OR ? OR p.user_id = ?)${gone}${vis} ORDER BY p.id LIMIT 100`)
      .bind(par.id, modHere ? 1 : 0, u.id, ...binds).all()).results;
    return json({ ok: true, posts: await present(env, rows, u, pw, fetchImpl, now) });
  }
  const scope = q.get("scope") === "country" ? "country" : "city";
  const kind = kindsFor(env).includes(q.get("kind")) ? q.get("kind") : "meme";
  const place = placeFor(u, scope);
  if (!place) return json({ ok: false, error: "no_home" }, 409);
  const mod = canModerate(pw, { scope, place, country: u.home_country }) ? 1 : 0;
  // Check-ins are always local; the national tab shows every city's check-ins in the country.
  const nationalCheckins = scope === "country" && kind === "checkin";
  const where = nationalCheckins
    ? `p.country = ? AND ? <> '' AND p.kind = ? AND p.parent_id IS NULL AND (p.hidden = 0 OR ? OR p.user_id = ?)`
    : `p.scope = ? AND p.place = ? AND p.kind = ? AND p.parent_id IS NULL AND (p.hidden = 0 OR ? OR p.user_id = ?)`;
  const [a1, a2] = nationalCheckins ? [place, "x"] : [scope, place];
  const [vis, binds] = visFor(mod);
  if (q.get("sort") === "top") {
    rows = (await db.prepare(`SELECT ${COLS} ${FROM} WHERE ${where}${gone}${vis} AND p.created_at >= ? ORDER BY p.score DESC, p.id DESC LIMIT 30`)
      .bind(a1, a2, kind, mod, u.id, ...binds, weekStart(now)).all()).results;
  } else {
    const before = Number(q.get("before")) || 0;
    rows = (await db.prepare(`SELECT ${COLS} ${FROM} WHERE ${where}${gone}${vis} AND (? = 0 OR p.id < ?) ORDER BY p.id DESC LIMIT 20`)
      .bind(a1, a2, kind, mod, u.id, ...binds, before, before).all()).results;
  }
  return json({ ok: true, scope, kind, place, canModerate: Boolean(mod), weekStart: weekStart(now), posts: await present(env, rows, u, pw, fetchImpl, now) });
}

/** A meme picture: base64 of a JPEG, PNG or WebP the browser already shrank. Returns { type, bytes } or null. */
export function readImage(b64) {
  if (typeof b64 !== "string" || b64.length > Math.ceil(MAX_IMAGE / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (bytes.length > MAX_IMAGE || bytes.length < 16) return null;
  const is = (...sig) => sig.every((v, i) => v == null || bytes[i] === v);
  if (is(0xff, 0xd8, 0xff)) return { type: "image/jpeg", bytes };
  if (is(0x89, 0x50, 0x4e, 0x47)) return { type: "image/png", bytes };
  if (is(0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50)) return { type: "image/webp", bytes };
  return null;
}

/**
 * POST /api/posts { scope, kind, body, image?, parent?, attestation?, ack? }
 * kind: meme (caption and/or picture) · checkin (standing in your community: an attestation from
 * /api/locate, once a day) · talk (a discussion) · update (feed v2: founder / manager / Vicinity only) · parent: reply to a post.
 * Feed v2: an account's first post to the National feed answers 409 needs_ack unless the request says ack: true (asked once, recorded).
 */
export async function handleNewPost(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const v2 = feedV2On(env);
  if (v2) { const bad = await feedTables(db); if (bad) return bad; }
  const body = await readJson(request, 300_000);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  if (!u.home_city) return json({ ok: false, error: "no_home" }, 409);
  if (await activeBan(db, u.id, u.home_country, now)) return json({ ok: false, error: "banned" }, 403);
  const pw = await powersOf(env, u, fetchImpl, now);
  if (pw.launched && !pw.holder && !pw.admin) return json({ ok: false, error: "holders_only" }, 403);
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND created_at >= ?").bind(u.id, iso(now - 3600_000)).first();
  if ((recent?.n || 0) >= POSTS_PER_HOUR) return json({ ok: false, error: "slow_down" }, 429);

  let parent = null;
  if (body.parent != null) {
    parent = await db.prepare("SELECT * FROM posts WHERE id = ? AND parent_id IS NULL AND hidden = 0").bind(Number(body.parent) || 0).first();
    if (!parent || parent.deleted_at || !sees(u, parent, pw)) return json({ ok: false, error: "not_found" }, 404);
    if (v2 && !(await visibleTo(db, parent, u.id, canModerate(pw, parent)))) return json({ ok: false, error: "not_found" }, 404); // nor replied to
    if (parent.kind === "checkin") return json({ ok: false, error: "no_checkin_replies" }, 400); // a check-in is a fact, not a thread
  }
  const kind = parent ? "reply" : kindsFor(env).includes(body.kind) ? body.kind : null;
  if (!kind) return json({ ok: false, error: "bad_kind" }, 400);
  const scope = parent ? parent.scope : kind === "checkin" ? "city" : body.scope === "country" ? "country" : "city";
  if (kind === "update") {
    if (!mayUpdate(u, pw, scope)) return json({ ok: false, error: "not_allowed" }, 403);
    if (body.image != null) return json({ ok: false, error: "no_image" }, 400); // an update is words only
  }
  let text = cleanText(body.body, LIMITS[kind]);
  if (text == null) return json({ ok: false, error: "too_long", max: LIMITS[kind] }, 400);
  if (HAS_ADDRESS.test(text)) return json({ ok: false, error: "no_addresses" }, 400);
  const image = kind === "meme" && body.image != null ? readImage(body.image) : null;
  if (kind === "meme" && body.image != null && !image) return json({ ok: false, error: "bad_image" }, 400);

  if (kind === "checkin") {
    const today = iso(now).slice(0, 10);
    if (await db.prepare("SELECT id FROM posts WHERE user_id = ? AND kind = 'checkin' AND created_at >= ?").bind(u.id, today).first()) {
      return json({ ok: false, error: "checked_in_today" }, 409);
    }
    const at = await useAttestation(env, body.attestation, { userId: u.id, purpose: "checkin", now });
    if (!at.ok) return json({ ok: false, error: at.error }, 400);
    if (at.att.city !== u.home_city) return json({ ok: false, error: "not_in_city", here: at.att.cityName || null }, 403);
    if (!text) text = `Checked in to ${u.home_name}`;
  }
  if (!text && !image) return json({ ok: false, error: "empty" }, 400);

  const place = parent ? parent.place : placeFor(u, scope);
  const country = parent ? parent.country : u.home_country;
  // feed v2: the first time an account posts (or replies) in the National feed, it confirms once that the whole country sees it
  // (recorded in the same batch as the post, so a post that fails to land leaves the question open)
  let ackNow = false;
  if (v2 && scope === "country") {
    const acked = await db.prepare("SELECT national_ack_at FROM users WHERE id = ?").bind(u.id).first("national_ack_at");
    if (!acked) {
      if (body.ack !== true) return json({ ok: false, error: "needs_ack", country: u.home_country }, 409);
      ackNow = true;
    }
  }
  let mediaId = null;
  if (image) {
    const r = await db.prepare("INSERT INTO media (user_id, type, bytes, created_at) VALUES (?, ?, ?, ?)").bind(u.id, image.type, image.bytes, iso(now)).run();
    mediaId = r.meta.last_row_id;
  }
  const stmts = [db.prepare("INSERT INTO posts (user_id, scope, place, country, kind, body, media_id, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(u.id, scope, place, country, kind, text, mediaId, parent ? parent.id : null, iso(now))];
  if (ackNow) stmts.push(db.prepare("UPDATE users SET national_ack_at = ? WHERE id = ? AND national_ack_at IS NULL").bind(iso(now), u.id));
  const [ins] = await db.batch(stmts);
  if (parent) {
    await db.prepare("UPDATE posts SET replies = replies + 1 WHERE id = ?").bind(parent.id).run();
    await notifyReply(env, { parent, by: u, now }); // in-app notice to the parent's author (NOTIFY=on; best effort, never the replier)
  }
  const row = await db.prepare(`SELECT ${COLS} ${FROM} WHERE p.id = ?`).bind(ins.meta.last_row_id).first();
  return json({ ok: true, post: (await present(env, [row], u, pw, fetchImpl, now))[0] });
}

async function postFor(request, env, now, fetchImpl) {
  const a = await access(request, env, now);
  if (a.error) return a;
  const body = await readJson(request);
  if (!body) return { error: json({ ok: false, error: "bad_json" }, 400) };
  const post = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(Number(body.id) || 0).first();
  const pw = await powersOf(env, a.u, fetchImpl, now);
  if (!post || post.deleted_at || !sees(a.u, post, pw)) return { error: json({ ok: false, error: "not_found" }, 404) };
  // feed v2: a post the feed hides from this person (muted, blocked either way) cannot be voted on or reported by its number either
  if (feedV2On(env) && !(await visibleTo(env.DB, post, a.u.id, canModerate(pw, post)))) return { error: json({ ok: false, error: "not_found" }, 404) };
  return { u: a.u, body, post, pw };
}

/**
 * POST /api/posts/delete { id } (feed v2 only) → the author takes their own post or reply down. Soft: deleted_at is set on it and on its
 * replies (nobody could reach them any more; the same mark keeps every count honest and lets a later purge find them), the rows and the
 * picture stay for that purge, and from now on they are in no feed, no list and no count; the picture answers 404 (handleMedia). The
 * moderators' queue alone keeps a reported one, marked deleted: their evidence. Nobody else may do this here (an admin's path stays the
 * public, logged hide), and nothing goes to /api/audit: deleting your own words is not moderation. A post this person could not see in a
 * feed is "not found" like everywhere else, deleted or not, and 60 tries an hour: no door reads the posts table number by number.
 */
export async function handleDelete(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const db = env.DB, bad = await feedTables(db);
  if (bad) return bad;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  await ensureLimitsSchema(db);
  const rate = await check(env, [{ key: await limitKey(env, "delete", String(a.u.id)), windowMs: HOUR, max: DELETES_PER_HOUR }], now);
  if (!rate.ok) return json({ ok: false, error: "slow_down" }, 429);
  const post = await db.prepare("SELECT * FROM posts WHERE id = ?").bind(Number(body.id) || 0).first();
  const pw = await powersOf(env, a.u, fetchImpl, now);
  if (!post || post.deleted_at || !sees(a.u, post, pw)) return json({ ok: false, error: "not_found" }, 404);
  if (post.user_id !== a.u.id) return json({ ok: false, error: "not_allowed" }, 403);
  const stmts = [
    db.prepare("UPDATE posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(iso(now), post.id),
    db.prepare("UPDATE posts SET deleted_at = ? WHERE parent_id = ? AND deleted_at IS NULL").bind(iso(now), post.id),
  ];
  if (post.parent_id) stmts.push(db.prepare("UPDATE posts SET replies = replies - 1 WHERE id = ? AND replies > 0").bind(post.parent_id));
  await db.batch(stmts);
  return json({ ok: true, deleted: true });
}

/** POST /api/posts/vote { id } → vote, or take your vote back. Founders count 2, managers 3. */
export async function handleVote(request, env, fetchImpl = fetch, now = Date.now()) {
  const r = await postFor(request, env, now, fetchImpl);
  if (r.error) return r.error;
  const { u, post, pw } = r, db = env.DB;
  if (post.hidden) return json({ ok: false, error: "not_found" }, 404);
  if (post.parent_id) return json({ ok: false, error: "no_reply_votes" }, 400); // the weekly board ranks posts, not replies
  if (post.user_id === u.id) return json({ ok: false, error: "own_post" }, 400);
  if (await activeBan(db, u.id, post.country, now)) return json({ ok: false, error: "banned" }, 403);
  if (pw.launched && !pw.holder && !pw.admin) return json({ ok: false, error: "holders_only" }, 403);
  // 60 an hour, counted by one atomic statement before anything is written (src/limits.js), so a flood of parallel
  // votes cannot all read "59 so far" and pass. Taking a vote back counts too.
  await ensureLimitsSchema(db);
  const rate = await check(env, [{ key: await limitKey(env, "vote", String(u.id)), windowMs: HOUR, max: VOTES_PER_HOUR }], now);
  if (!rate.ok) return json({ ok: false, error: "slow_down" }, 429);
  const had = await db.prepare("SELECT weight FROM votes WHERE post_id = ? AND user_id = ?").bind(post.id, u.id).first();
  if (had) {
    await db.batch([
      db.prepare("DELETE FROM votes WHERE post_id = ? AND user_id = ?").bind(post.id, u.id),
      db.prepare("UPDATE posts SET score = score - ? WHERE id = ?").bind(had.weight, post.id),
    ]);
  } else {
    await db.batch([
      db.prepare("INSERT INTO votes (post_id, user_id, weight, created_at) VALUES (?, ?, ?, ?)").bind(post.id, u.id, pw.weight, iso(now)),
      db.prepare("UPDATE posts SET score = score + ? WHERE id = ?").bind(pw.weight, post.id),
    ]);
  }
  const s = await db.prepare("SELECT score FROM posts WHERE id = ?").bind(post.id).first();
  return json({ ok: true, voted: !had, score: s.score, weight: pw.weight });
}

/**
 * POST /api/posts/report { id, reason } → 3 reports confirm a moderator's hide; 5 reports hide the post
 * until a moderator reviews it (both logged publicly as "community reports").
 */
export async function handleReport(request, env, fetchImpl = fetch, now = Date.now()) {
  const r = await postFor(request, env, now, fetchImpl);
  if (r.error) return r.error;
  const { u, post, body } = r, db = env.DB;
  if (post.user_id === u.id) return json({ ok: false, error: "own_post" }, 400);
  if (await countRecent(env, u.id, "report", now - DAY) >= POLICY.limits.reportsPerDay) return json({ ok: false, error: "slow_down" }, 429);
  const reason = cleanText(body.reason, 140) || null;
  const ins = await db.prepare("INSERT OR IGNORE INTO reports (post_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)").bind(post.id, u.id, reason, iso(now)).run();
  if (!ins.meta.changes) return json({ ok: true });
  await noteEvent(env, u.id, "report", now);
  // One statement adds one to the counter, so two first reports at the same moment both land (neither writes a stale
  // "0 + 1"). It is NOT the number of report rows on purpose: a moderator who unhides a post sets the counter back to 0
  // (src/moderation.js) and the old reports stay on record, so hiding it again takes five people who have not reported
  // it before, as it always has. Counting rows would let one more report undo the moderator's decision.
  const counted = await db.prepare("UPDATE posts SET reports = reports + 1 WHERE id = ? RETURNING reports").bind(post.id).first();
  const n = counted ? Number(counted.reports) : post.reports + 1;
  const stmts = [];
  const log = (action, state) => db.prepare(`INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, target_user, country, place, reason, created_at, state)
    VALUES (NULL, 'community', ?, 'post', ?, ?, ?, ?, 'reports', ?, ?)`).bind(action, post.id, post.user_id, post.country, post.place, iso(now), state);
  const pending = await db.prepare("SELECT id FROM mod_actions WHERE target_type = 'post' AND target_id = ? AND action = 'hide' AND state = 'pending'").bind(post.id).first();
  if (post.hidden && !post.hide_confirmed && pending && n >= POLICY.moderation.reportsToConfirm) {
    stmts.push(db.prepare("UPDATE posts SET hide_confirmed = 1, hidden_until = NULL WHERE id = ?").bind(post.id));
    stmts.push(db.prepare("UPDATE mod_actions SET state = 'confirmed', second_at = ? WHERE id = ?").bind(iso(now), pending.id));
    stmts.push(log("confirm_hide", "confirmed"));
  } else if (!post.hidden && n >= POLICY.moderation.reportsToAutoHide) {
    stmts.push(db.prepare("UPDATE posts SET hidden = 1, hide_confirmed = 1, hidden_until = NULL WHERE id = ?").bind(post.id));
    stmts.push(log("hide", "confirmed"));
  }
  if (stmts.length) await db.batch(stmts);
  // in-app notice (NOTIFY=on): the author learns that reports hid their post (the public log says the same)
  if (!post.hidden && n >= POLICY.moderation.reportsToAutoHide) await notify(env, { to: post.user_id, kind: "moderation", ref: post.id, text: "Your post was hidden after reports from the community.", href: "/dashboard#community", now });
  return json({ ok: true });
}

/**
 * GET /api/media/:id → a picture.
 *   A city coin's APPROVED picture is public, like the coin itself, but only while its bytes still hash to the coin's logo_hash
 *   (src/logos.js): a swapped or tampered row is "not found". It may sit in caches an hour (not a year): a removed picture
 *   lingers at most that long.
 *   A coin's working picture (waiting for a check, or not approved) is only for its founder and the staff (owner, admin, moderator).
 *   A meme picture is only for people who may see its post (that city or country, or its moderators): a feed
 *   that says "only people from Utica see this" can't have pictures anyone can fetch by counting ids.
 *   A picture that isn't attached to anything is only for the person who uploaded it.
 *   A deleted post's picture (feed v2) is "not found" for everyone, its author included, switch or no switch once the column exists
 *   (the bytes stay until a later step purges them).
 * Ids are sequential and guessable, so a picture the viewer may not see answers "not found", never "forbidden".
 */
export async function handleMedia(request, env, id, fetchImpl = fetch, now = Date.now()) {
  if (!env.DB || !/^[0-9]{1,10}$/.test(id)) return json({ error: "not_found" }, 404);
  await ensureSchema(env.DB);
  await ensureLogoSchema(env.DB);
  const row = await env.DB.prepare(`SELECT m.type, m.bytes, m.user_id,
      (SELECT c.user_id FROM city_coins c WHERE c.media_id = m.id LIMIT 1) AS draft_of,
      (SELECT c.logo_hash FROM city_coins c WHERE c.approved_media_id = m.id LIMIT 1) AS approved_hash
    FROM media m WHERE m.id = ?`).bind(Number(id)).first();
  if (!row) return json({ error: "not_found" }, 404);
  let shared = false;
  if (row.approved_hash) {
    if (!(await bytesApproved(row.bytes, row.approved_hash))) return json({ error: "not_found" }, 404); // not the bytes the admin approved
    shared = true;
  } else {
    const a = await access(request, env, now, { write: false });
    if (a.error) return json({ error: "not_found" }, 404);
    if (row.draft_of != null) {
      if (row.draft_of !== a.u.id && !(await adminRoleOf(env, a.u.wallet))) return json({ error: "not_found" }, 404);
    } else {
      const post = await env.DB.prepare("SELECT * FROM posts WHERE media_id = ?").bind(Number(id)).first();
      if (!post) { if (row.user_id !== a.u.id) return json({ error: "not_found" }, 404); }
      else {
        if (post.deleted_at) return json({ error: "not_found" }, 404); // the author took the post down: its picture is gone for everyone
        const pw = await powersOf(env, a.u, fetchImpl, now);
        if (!sees(a.u, post, pw) || (post.hidden && !canModerate(pw, post) && post.user_id !== a.u.id)) return json({ error: "not_found" }, 404);
      }
    }
  }
  return new Response(toBytes(row.bytes), { headers: {
    "Content-Type": row.type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline",
    // an approved coin picture is the same for everyone (an hour in caches); a private picture must never sit in a shared cache
    "Cache-Control": shared ? `public, max-age=${PICTURE_MAX_AGE}` : "private, max-age=3600",
  } });
}
