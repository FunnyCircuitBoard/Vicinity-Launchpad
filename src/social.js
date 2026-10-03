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
 */
import { json, readJson } from "./http.js";
import { access } from "./access.js";
import { useAttestation, countRecent, noteEvent } from "./attest.js";
import { activeBan, canModerate, managerOf, powersOf } from "./roles.js";
import { ensureLimitsSchema, ensureSchema } from "./store.js";
import { check, limitKey } from "./limits.js";
import { DAY, HOUR, POLICY, iso } from "./policy.js";
import { HAS_ADDRESS, cleanText } from "./text.js";
import { toBytes } from "./blobs.js";

export { cleanText };
const KINDS = ["meme", "checkin", "talk"];
const LIMITS = { meme: 280, checkin: 140, talk: 1000, reply: 500 };
const MAX_IMAGE = 200_000;
const POSTS_PER_HOUR = 12;
const VOTES_PER_HOUR = 60;

/** Monday 00:00 UTC of this week: weekly votes start here. */
export function weekStart(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

const placeFor = (u, scope) => (scope === "country" ? u.home_country : u.home_city);
/** Can this person see this post? Your city's posts, your country's posts. */
const sees = (u, p, pw) => canModerate(pw, p) || (p.scope === "city" ? p.place === u.home_city : p.place === u.home_country);

export const COLS = "p.id, p.user_id, p.scope, p.place, p.country, p.kind, p.body, p.media_id, p.parent_id, p.score, p.reports, p.replies, p.hidden, p.hide_confirmed, p.hidden_until, p.created_at, u.handle, u.name, u.home_name AS author_home";
export const FROM = "FROM posts p JOIN users u ON u.id = p.user_id";

/** Posts as the page sees them: author name and live role, never their wallet. */
export async function present(env, rows, me, pw, fetchImpl = fetch, now = Date.now()) {
  if (!rows.length) return [];
  const db = env.DB;
  const ids = rows.map((r) => r.id);
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
      score: r.score, replies: r.replies, at: r.created_at, hidden: Boolean(r.hidden),
      hiddenUntil: r.hidden && !r.hide_confirmed ? r.hidden_until : null,
      hideAction: r.hidden && act && (mod || r.user_id === me.id) ? { id: act.id, state: act.state, reason: act.reason } : null,
      reports: mod ? r.reports : undefined,
      where: r.kind === "checkin" ? r.author_home : undefined,
      voted: mine.has(r.id), mine: r.user_id === me.id, canModerate: mod,
      author: { id: mod ? r.user_id : undefined, name: r.handle || r.name || "Member", founder: founders.get(r.user_id) || null, steward: stewards.has(r.user_id), manager: managers.has(r.user_id) },
    };
  });
}

/** GET /api/posts?scope=city|country&kind=meme|checkin|talk&sort=new|top&before=<id>  or  ?parent=<id> for replies */
export async function handlePosts(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await access(request, env, now, { write: false });
  if (a.error) return a.error;
  const u = a.u, q = new URL(request.url).searchParams, db = env.DB;
  const pw = await powersOf(env, u, fetchImpl, now);
  let rows;
  if (q.get("parent")) {
    const par = await db.prepare("SELECT * FROM posts WHERE id = ?").bind(Number(q.get("parent")) || 0).first();
    if (!par || !sees(u, par, pw) || (par.hidden && !canModerate(pw, par) && par.user_id !== u.id)) return json({ ok: false, error: "not_found" }, 404);
    rows = (await db.prepare(`SELECT ${COLS} ${FROM} WHERE p.parent_id = ? AND (p.hidden = 0 OR ? OR p.user_id = ?) ORDER BY p.id LIMIT 100`)
      .bind(par.id, canModerate(pw, par) ? 1 : 0, u.id).all()).results;
    return json({ ok: true, posts: await present(env, rows, u, pw, fetchImpl, now) });
  }
  const scope = q.get("scope") === "country" ? "country" : "city";
  const kind = KINDS.includes(q.get("kind")) ? q.get("kind") : "meme";
  const place = placeFor(u, scope);
  if (!place) return json({ ok: false, error: "no_home" }, 409);
  const mod = canModerate(pw, { scope, place, country: u.home_country }) ? 1 : 0;
  // Check-ins are always local; the national tab shows every city's check-ins in the country.
  const nationalCheckins = scope === "country" && kind === "checkin";
  const where = nationalCheckins
    ? `p.country = ? AND ? <> '' AND p.kind = ? AND p.parent_id IS NULL AND (p.hidden = 0 OR ? OR p.user_id = ?)`
    : `p.scope = ? AND p.place = ? AND p.kind = ? AND p.parent_id IS NULL AND (p.hidden = 0 OR ? OR p.user_id = ?)`;
  const [a1, a2] = nationalCheckins ? [place, "x"] : [scope, place];
  if (q.get("sort") === "top") {
    rows = (await db.prepare(`SELECT ${COLS} ${FROM} WHERE ${where} AND p.created_at >= ? ORDER BY p.score DESC, p.id DESC LIMIT 30`)
      .bind(a1, a2, kind, mod, u.id, weekStart(now)).all()).results;
  } else {
    const before = Number(q.get("before")) || 0;
    rows = (await db.prepare(`SELECT ${COLS} ${FROM} WHERE ${where} AND (? = 0 OR p.id < ?) ORDER BY p.id DESC LIMIT 20`)
      .bind(a1, a2, kind, mod, u.id, before, before).all()).results;
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
 * POST /api/posts { scope, kind, body, image?, parent?, attestation? }
 * kind: meme (caption and/or picture) · checkin (standing in your community: an attestation from
 * /api/locate, once a day) · talk (a discussion) · parent: reply to a post.
 */
export async function handleNewPost(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
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
    if (!parent || !sees(u, parent, pw)) return json({ ok: false, error: "not_found" }, 404);
    if (parent.kind === "checkin") return json({ ok: false, error: "no_checkin_replies" }, 400); // a check-in is a fact, not a thread
  }
  const kind = parent ? "reply" : KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) return json({ ok: false, error: "bad_kind" }, 400);
  const scope = parent ? parent.scope : kind === "checkin" ? "city" : body.scope === "country" ? "country" : "city";
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
  let mediaId = null;
  if (image) {
    const r = await db.prepare("INSERT INTO media (user_id, type, bytes, created_at) VALUES (?, ?, ?, ?)").bind(u.id, image.type, image.bytes, iso(now)).run();
    mediaId = r.meta.last_row_id;
  }
  const ins = await db.prepare("INSERT INTO posts (user_id, scope, place, country, kind, body, media_id, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(u.id, scope, place, country, kind, text, mediaId, parent ? parent.id : null, iso(now)).run();
  if (parent) await db.prepare("UPDATE posts SET replies = replies + 1 WHERE id = ?").bind(parent.id).run();
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
  if (!post || !sees(a.u, post, pw)) return { error: json({ ok: false, error: "not_found" }, 404) };
  return { u: a.u, body, post, pw };
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
  return json({ ok: true });
}

/**
 * GET /api/media/:id → a picture.
 *   A city coin's logo is public, like the coin itself.
 *   A meme picture is only for people who may see its post (that city or country, or its moderators): a feed
 *   that says "only people from Utica see this" can't have pictures anyone can fetch by counting ids.
 *   A picture that isn't attached to anything is only for the person who uploaded it.
 * Ids are sequential and guessable, so a picture the viewer may not see answers "not found", never "forbidden".
 */
export async function handleMedia(request, env, id, fetchImpl = fetch, now = Date.now()) {
  if (!env.DB || !/^[0-9]{1,10}$/.test(id)) return json({ error: "not_found" }, 404);
  await ensureSchema(env.DB);
  const row = await env.DB.prepare("SELECT m.type, m.bytes, m.user_id, (SELECT 1 FROM city_coins c WHERE c.media_id = m.id LIMIT 1) AS is_logo FROM media m WHERE m.id = ?").bind(Number(id)).first();
  if (!row) return json({ error: "not_found" }, 404);
  let shared = Boolean(row.is_logo);
  if (!shared) {
    const a = await access(request, env, now, { write: false });
    if (a.error) return json({ error: "not_found" }, 404);
    const post = await env.DB.prepare("SELECT * FROM posts WHERE media_id = ?").bind(Number(id)).first();
    if (!post) { if (row.user_id !== a.u.id) return json({ error: "not_found" }, 404); }
    else {
      const pw = await powersOf(env, a.u, fetchImpl, now);
      if (!sees(a.u, post, pw) || (post.hidden && !canModerate(pw, post) && post.user_id !== a.u.id)) return json({ error: "not_found" }, 404);
    }
  }
  return new Response(toBytes(row.bytes), { headers: {
    "Content-Type": row.type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline",
    // logos are the same for everyone; a private picture must never sit in a shared cache
    "Cache-Control": shared ? "public, max-age=31536000, immutable" : "private, max-age=3600",
  } });
}
