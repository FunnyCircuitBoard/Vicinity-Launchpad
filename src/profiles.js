/**
 * Member profiles, only while PROFILES=on (otherwise every route here answers 404 not_enabled: src/index.js). Everything
 * is for SIGNED-IN members only; a signed-out visitor and a test-lab row get "sign_in" and see nothing.
 *
 *   GET  /api/profile?u=<handle>              a member's public profile (no handle = your own)
 *   GET  /api/members/search?q=<text>         find members by the start of their username
 *   POST /api/follow  { handle, follow }      follow or unfollow (open follow; the followed member may block)
 *   GET  /api/follows?u=&list=&after=         who follows a member / whom a member follows, newest first, 50 a page
 *   POST /api/block   { handle, block }       block or unblock (a blocked member can no longer follow you)
 *   GET  /api/me/blocks                       your own block list (private)
 *   POST /api/me/bio  { bio }                 your bio, at most 100 characters (empty clears it)
 *   POST /api/profile/report { handle, reason }   report someone's bio for the moderators
 *   GET  /api/me/portfolio                    your own portfolio (src/portfolio.js)
 *   POST /api/mod/bio/clear                   a moderator clears a bio (src/moderation.js)
 * There is NO messaging of any kind, and no notifications.
 *
 * What other members see of a member: username, member since, level, badges, home community, bio, wallet address, exact
 * $VICINITY amount with rank and percentile, exact city-coin holdings with live dollar values, follower and following
 * counts, and the posts the feeds already show them. NEVER: real name, sign-in method, contact e-mail, phone, IP, location,
 * sessions, anybody's block list, anything from the admin tools. Each answer is built field by field (no table row is ever
 * passed through), and test/profile-view.test.js scans every answer for what must not be in it.
 *
 * Rules kept here, in one place:
 *   - every counter is atomic and counted BEFORE the work (src/profile-core.js LIMITS, src/limits.js)
 *   - follow, unfollow, block and unblock are single statements (or one batch): parallel taps cannot break the rules
 *     (a block removes the follows both ways in the same transaction, a follow is refused inside its own INSERT when a
 *     block exists or 1,000 people are already followed), and the counts are counted from the rows
 *   - test-lab rows and members under an active ban are not found, not listed, not counted; and letting go of one
 *     (unfollow, unblock) answers exactly like letting go of a username nobody has, so no route tells the two apart
 *   - a failure of the new tables only ever answers 503 profiles_unavailable on these routes
 */
import { json, readJson } from "./http.js";
import { access } from "./access.js";
import { ensureProfilesSchema } from "./store.js";
import { iso } from "./policy.js";
import { activeMint } from "./official.js";
import { getHolding, holderSnapshot, rankOf } from "./chain.js";
import { adminWallets, liveSeatOfUser, managerOf } from "./roles.js";
import { badgesFor } from "./me.js";
import { adminRoleOf } from "./admin.js";
import { handlePortfolio, portfolioOf } from "./portfolio.js";
import { handleClearBio } from "./moderation.js";
import { cleanText } from "./text.js";
import { MAX_BLOCKS, MAX_FOLLOWING, PAGE, SEARCH_MAX, SHOWN, cleanBio, countsOf, countsStatement, findMember, memberById, parseHandle, within } from "./profile-core.js";

const bad = () => json({ ok: false, error: "bad_request" }, 400);
const slow = () => json({ ok: false, error: "slow_down" }, 429);
const notFound = () => json({ ok: false, error: "not_found" }, 404);
const home = (name, country) => (name ? { name, country } : null);

/** A signed-in, real member (not a test-lab row) with the profile tables in place, or { error }. */
async function member(request, env, now, { write }) {
  const a = await access(request, env, now, { write });
  if (a.error) return a;
  if (a.u.provider === "testlab") return { error: json({ ok: false, error: "sign_in" }, 401) };
  try { await ensureProfilesSchema(env.DB); }
  catch (e) {
    console.error("profile tables unavailable", String((e && e.message) || e).slice(0, 80));
    return { error: json({ ok: false, error: "profiles_unavailable" }, 503) };
  }
  return a;
}

/* ---------------- a profile ---------------- */

/** Level and badges as the Vicinity pass computes them, from the viewed member's own data. */
async function standing(env, m, { launched, position, amount, now }) {
  const db = env.DB;
  const admin = adminWallets(env).includes(m.wallet);
  const seat = await liveSeatOfUser(db, m.id);
  const mgr = seat && seat.status === "active" ? await managerOf(env, seat.country, now) : null;
  const isManager = Boolean(mgr && mgr.userId === m.id);
  const founderLive = Boolean(seat && (seat.status === "active" || seat.status === "steward"));
  const level = admin ? "admin" : isManager ? "manager" : founderLive ? "founder" : amount > 0 ? "holder" : "member";
  const act = await db.prepare(
    "SELECT COUNT(*) AS posts, COUNT(DISTINCT CASE WHEN kind = 'checkin' THEN substr(created_at, 1, 10) END) AS days FROM posts WHERE user_id = ? AND hidden = 0",
  ).bind(m.id).first();
  let stored = [];
  try { const s = JSON.parse(m.badges || "[]"); if (Array.isArray(s)) stored = s; } catch {}
  // Founder-ready needs the balance history, which is only worked out on the member's own dashboard: the last answer
  // they got there counts, and only while they still hold something.
  const badges = badgesFor({ u: m, launched, amount, position, seat, manager: isManager, admin, checkins: act?.days || 0, posts: act?.posts || 0, tenure: null })
    .map((b) => ({ id: b.id, icon: b.icon, name: b.name, earned: b.id === "founder_ready" ? stored.includes("founder_ready") && amount > 0 : Boolean(b.earned) }));
  return { level, badges };
}

/** The viewed member's latest feed posts that THIS viewer may see (same rule as the feeds: your own city or country, not hidden). */
async function recentPosts(db, m, viewer) {
  const rows = (await db.prepare(
    `SELECT id, kind, body, media_id, score, replies, created_at FROM posts
      WHERE user_id = ?1 AND hidden = 0 AND parent_id IS NULL AND ((scope = 'city' AND place = ?2) OR (scope = 'country' AND place = ?3))
      ORDER BY id DESC LIMIT 5`).bind(m.id, viewer.home_city, viewer.home_country).all()).results;
  return rows.map((r) => ({ id: r.id, kind: r.kind, body: r.body, image: r.media_id ? `/api/media/${r.media_id}` : null, at: r.created_at, score: r.score, replies: r.replies }));
}

/** GET /api/profile?u=<handle> */
async function handleProfile(request, env, x) {
  const g = await member(request, env, x.now, { write: false });
  if (g.error) return g.error;
  const { u } = g, db = env.DB, now = x.now;
  if (!(await within(env, "view", u.id, now))) return slow();
  const q = new URL(request.url).searchParams.get("u");
  let m;
  if (q == null || q === "") m = await memberById(db, u.id); // your own, whatever the state of your account
  else {
    const h = parseHandle(q);
    if (!h) return bad();
    m = await findMember(db, h, { now, viewerId: u.id });
  }
  if (!m) return notFound();

  const mint = activeMint(env), launched = Boolean(mint);
  const snapP = launched ? holderSnapshot(env, mint, x.fetchImpl).catch(() => null) : Promise.resolve(null);
  const portP = portfolioOf(env, m.wallet, { fetchImpl: x.fetchImpl, now });
  const [counts, rel, posts, snap] = await Promise.all([
    countsOf(db, m.id, now),
    db.prepare(`SELECT EXISTS(SELECT 1 FROM follows WHERE follower_id = ?1 AND followee_id = ?2) AS following,
                       EXISTS(SELECT 1 FROM follows WHERE follower_id = ?2 AND followee_id = ?1) AS followed_by,
                       EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ?1 AND blocked_id = ?2) AS blocked`).bind(u.id, m.id).first(),
    recentPosts(db, m, u),
    snapP,
  ]);

  let position = null, amount = 0, holding = null;
  if (launched) {
    if (snap) {
      position = rankOf(snap, m.wallet);
      amount = position.amount;
      holding = { amount, rank: position.rank, total: position.total, percentile: position.percentile };
    } else {
      try { amount = await getHolding(env, m.wallet, mint, x.fetchImpl); holding = { amount, rank: null, total: null, percentile: null }; }
      catch { holding = null; }
    }
  }
  const { level, badges } = await standing(env, m, { launched, position, amount, now });
  return json({ ok: true, profile: {
    handle: m.handle, since: m.created_at, level, badges, home: m.home_city ? { id: m.home_city, name: m.home_name, country: m.home_country } : null,
    bio: m.bio || "", wallet: m.wallet, holding, portfolio: await portP, counts, posts,
    // blockedBy is always false: a member who was blocked is never told (a follow is simply refused with cannot_follow)
    viewer: { self: m.id === u.id, following: Boolean(rel?.following), followedBy: Boolean(rel?.followed_by), blocked: Boolean(rel?.blocked), blockedBy: false },
  } });
}

/* ---------------- search ---------------- */

/** GET /api/members/search?q=<text> */
async function handleSearch(request, env, x) {
  const g = await member(request, env, x.now, { write: false });
  if (g.error) return g.error;
  const text = (new URL(request.url).searchParams.get("q") || "").trim();
  if ([...text].length < 2 || text.length > 40 || /[\u0000-\u001f\u007f]/.test(text)) return bad();
  if (!(await within(env, "search", g.u.id, x.now))) return slow();
  // a range on lower(handle) (the unique index), from the text up to the text followed by the largest character
  const rows = (await env.DB.prepare(
    `SELECT u.handle, u.home_name, u.home_country FROM users u
      WHERE u.handle IS NOT NULL AND lower(u.handle) >= lower(?1) AND lower(u.handle) < lower(?1) || char(1114111) AND u.id != ?2 AND ${SHOWN("u", "?3")}
      ORDER BY lower(u.handle) LIMIT ${SEARCH_MAX}`).bind(text, g.u.id, iso(x.now)).all()).results;
  return json({ ok: true, results: rows.map((r) => ({ handle: r.handle, home: home(r.home_name, r.home_country) })) });
}

/* ---------------- follow ---------------- */

// ONE statement does the checking and the writing, so nothing can slip in between: no row when the other member blocked
// you, when you blocked them, or when you already follow 1,000 (?4); an existing row is left alone (it is idempotent).
const FOLLOW = `INSERT INTO follows (follower_id, followee_id, created_at)
  SELECT ?1, ?2, ?3
   WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)
     AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = ?2 AND blocked_id = ?1)
     AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = ?1 AND blocked_id = ?2)
     AND (SELECT COUNT(*) FROM follows WHERE follower_id = ?1) < ?4
  ON CONFLICT (follower_id, followee_id) DO NOTHING`;
// what is true right after it, read in the same transaction
const FOLLOW_STATE = `SELECT EXISTS(SELECT 1 FROM follows WHERE follower_id = ?1 AND followee_id = ?2) AS following,
  EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ?2 AND blocked_id = ?1) AS blocked_you,
  EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ?1 AND blocked_id = ?2) AS you_blocked,
  (SELECT COUNT(*) FROM follows WHERE follower_id = ?1) AS mine,
  EXISTS(SELECT 1 FROM users WHERE id = ?2) AS there`;

/** Read { handle, <flag>: boolean } from the request. Returns { h, on } or { error }. */
async function target(request, flag) {
  const body = await readJson(request);
  const h = parseHandle(body && body.handle);
  if (!h || typeof body[flag] !== "boolean") return { error: bad() };
  return { h, on: body[flag] };
}

/** POST /api/follow { handle, follow } */
async function handleFollow(request, env, x) {
  const g = await member(request, env, x.now, { write: true });
  if (g.error) return g.error;
  const { u } = g, db = env.DB, now = x.now;
  const t = await target(request, "follow");
  if (t.error) return t.error;
  if (!(await within(env, "follow", u.id, now))) return slow();
  // Following needs a member you can see. Letting go works for anybody (you must be able to unfollow a member who has been
  // hidden since), and answers exactly the same whether the username is shown, hidden (banned, test-lab) or nobody's: the
  // row goes by username in one statement, and counts come back only for a member you can see. So unfollowing never tells
  // you whether a username exists or is hidden, which GET /api/profile keeps from you as well.
  const who = await findMember(db, t.h, { now, viewerId: u.id });
  if (who && who.id === u.id) return json({ ok: false, error: "self" }, 400);
  if (!t.on) {
    const stmts = [db.prepare(`DELETE FROM follows WHERE follower_id = ?1 AND followee_id IN (SELECT u.id FROM users u WHERE u.handle IS NOT NULL AND lower(u.handle) = lower(?2))`).bind(u.id, t.h)];
    if (who) stmts.push(countsStatement(db, who.id, now));
    const [, counts] = await db.batch(stmts);
    return json({ ok: true, following: false, ...(who ? { counts: shapeCounts(counts) } : {}) });
  }
  if (!who) return notFound();
  const [, state, counts] = await db.batch([
    db.prepare(FOLLOW).bind(u.id, who.id, iso(now), MAX_FOLLOWING),
    db.prepare(FOLLOW_STATE).bind(u.id, who.id),
    countsStatement(db, who.id, now),
  ]);
  const s = state.results[0];
  if (!s.there) return notFound();
  if (s.following) return json({ ok: true, following: true, counts: shapeCounts(counts) });
  // Refused. Your own block is always the explanation when there is one (so the answer never changes with the other side's
  // choice); a block by the other member is never named: "cannot_follow" is all their choice ever shows.
  if (s.you_blocked) return json({ ok: false, error: "unblock_first" }, 409);
  if (s.blocked_you) return json({ ok: false, error: "cannot_follow" }, 403);
  if (s.mine >= MAX_FOLLOWING) return json({ ok: false, error: "too_many_following" }, 409);
  return json({ ok: false, error: "unavailable" }, 503);
}
const shapeCounts = (r) => ({ followers: Number(r.results[0]?.followers) || 0, following: Number(r.results[0]?.following) || 0 });

/* ---------------- lists ---------------- */

// "<time of the follow>_<username of that row>": the page's last row, nothing the list did not show already (never a member's id)
const CURSOR = /^(\d{4}-\d{2}-\d{2}T[0-9:.]{8,16}Z)_([A-Za-z0-9_]{1,40})$/;

/** GET /api/follows?u=<handle>&list=followers|following&after=<cursor> */
async function handleFollows(request, env, x) {
  const g = await member(request, env, x.now, { write: false });
  if (g.error) return g.error;
  const { u } = g, db = env.DB, now = x.now;
  const q = new URL(request.url).searchParams;
  const list = q.get("list");
  if (list !== "followers" && list !== "following") return bad();
  const after = q.get("after");
  const cur = after ? CURSOR.exec(after) : null;
  if (after && !cur) return bad();
  const h = q.get("u") ? parseHandle(q.get("u")) : null;
  if (q.get("u") && !h) return bad();
  if (!(await within(env, "list", u.id, now))) return slow();
  const who = h ? await findMember(db, h, { now, viewerId: u.id }) : u; // no username: your own lists
  if (!who) return notFound();

  const [mine, theirs] = list === "followers" ? ["f.followee_id", "f.follower_id"] : ["f.follower_id", "f.followee_id"];
  // newest first; follows of the same moment in a fixed order by username (the cursor must never carry a member's id)
  const rows = (await db.prepare(
    `SELECT s.handle, s.home_name, s.home_country, f.created_at FROM follows f JOIN users s ON s.id = ${theirs}
      WHERE ${mine} = ?1 AND ${SHOWN("s", "?2")}${cur ? ` AND (f.created_at, lower(s.handle)) < (?3, lower(?4))` : ""}
      ORDER BY f.created_at DESC, lower(s.handle) DESC LIMIT ${PAGE + 1}`).bind(...[who.id, iso(now), ...(cur ? [cur[1], cur[2]] : [])]).all()).results;
  const page = rows.slice(0, PAGE);
  const last = page[page.length - 1];
  return json({ ok: true, users: page.map((r) => ({ handle: r.handle, home: home(r.home_name, r.home_country) })),
    next: rows.length > PAGE && last ? `${last.created_at}_${last.handle}` : null });
}

/* ---------------- block ---------------- */

// A block removes the follow of the blocked member AND your own follow of them, in the same transaction, and is refused
// (nothing at all changes) when you already block 1,000 members.
const BLOCK = `INSERT INTO blocks (blocker_id, blocked_id, created_at)
  SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2) AND (SELECT COUNT(*) FROM blocks WHERE blocker_id = ?1) < ?4
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING`;
const IF_BLOCKED = "EXISTS (SELECT 1 FROM blocks WHERE blocker_id = ?1 AND blocked_id = ?2)";

/** POST /api/block { handle, block } */
async function handleBlock(request, env, x) {
  const g = await member(request, env, x.now, { write: true });
  if (g.error) return g.error;
  const { u } = g, db = env.DB, now = x.now;
  const t = await target(request, "block");
  if (t.error) return t.error;
  if (!(await within(env, "block", u.id, now))) return slow();
  // Blocking needs a member you can see. Unblocking works for anybody (also a member who is hidden since) and answers the
  // same whether the username is shown, hidden or nobody's: letting go is never a way to find out (see handleFollow).
  const who = await findMember(db, t.h, { now, viewerId: u.id });
  if (who && who.id === u.id) return json({ ok: false, error: "self" }, 400);
  if (!t.on) {
    await db.prepare("DELETE FROM blocks WHERE blocker_id = ?1 AND blocked_id IN (SELECT u.id FROM users u WHERE u.handle IS NOT NULL AND lower(u.handle) = lower(?2))").bind(u.id, t.h).run();
    return json({ ok: true, blocked: false });
  }
  if (!who) return notFound();
  // admins and moderators answer to everybody: they cannot be blocked (and never learn who tried)
  if (await adminRoleOf(env, who.wallet)) return json({ ok: false, error: "cannot_block" }, 409);
  const [, , , state] = await db.batch([
    db.prepare(BLOCK).bind(u.id, who.id, iso(now), MAX_BLOCKS),
    db.prepare(`DELETE FROM follows WHERE follower_id = ?2 AND followee_id = ?1 AND ${IF_BLOCKED}`).bind(u.id, who.id),
    db.prepare(`DELETE FROM follows WHERE follower_id = ?1 AND followee_id = ?2 AND ${IF_BLOCKED}`).bind(u.id, who.id),
    db.prepare(`SELECT ${IF_BLOCKED} AS blocked, (SELECT COUNT(*) FROM blocks WHERE blocker_id = ?1) AS mine`).bind(u.id, who.id),
  ]);
  const s = state.results[0];
  if (s.blocked) return json({ ok: true, blocked: true });
  if (s.mine >= MAX_BLOCKS) return json({ ok: false, error: "too_many_blocks" }, 409);
  return notFound();
}

/** GET /api/me/blocks → the members you blocked (nobody else ever sees this). */
async function handleBlocks(request, env, x) {
  const g = await member(request, env, x.now, { write: false });
  if (g.error) return g.error;
  if (!(await within(env, "list", g.u.id, x.now))) return slow();
  const rows = (await env.DB.prepare(
    `SELECT u.handle FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?1 AND u.handle IS NOT NULL
      ORDER BY b.created_at DESC, b.blocked_id DESC LIMIT ${MAX_BLOCKS}`).bind(g.u.id).all()).results;
  return json({ ok: true, users: rows.map((r) => ({ handle: r.handle })) });
}

/* ---------------- the bio ---------------- */

/** POST /api/me/bio { bio } → your bio (at most 100 characters; "" clears it). 10 changes a day. */
async function handleBio(request, env, x) {
  const g = await member(request, env, x.now, { write: true });
  if (g.error) return g.error;
  const { u } = g;
  const body = await readJson(request);
  if (!body) return bad();
  const r = cleanBio(body.bio);
  if (!r.ok) return json({ ok: false, error: r.error }, 400);
  if (r.bio === (u.bio || "")) return json({ ok: true, bio: r.bio }); // nothing to change, nothing counted
  if (!(await within(env, "bio", u.id, x.now))) return slow();
  // Reports are about a text: a new text starts with a clean slate.
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET bio = ? WHERE id = ?").bind(r.bio || null, u.id),
    env.DB.prepare("DELETE FROM profile_reports WHERE user_id = ?").bind(u.id),
  ]);
  return json({ ok: true, bio: r.bio });
}

/** POST /api/profile/report { handle, reason } → a report about this member's bio. The moderators read them (GET /api/mod). */
async function handleReport(request, env, x) {
  const g = await member(request, env, x.now, { write: true });
  if (g.error) return g.error;
  const { u } = g, now = x.now;
  const body = await readJson(request);
  const h = parseHandle(body && body.handle);
  if (!h) return bad();
  if (!(await within(env, "report", u.id, now))) return slow();
  const who = await findMember(env.DB, h, { now, viewerId: u.id });
  if (!who) return notFound();
  if (who.id === u.id) return json({ ok: false, error: "self" }, 400);
  if (!who.bio) return json({ ok: false, error: "no_bio" }, 409);
  const reason = cleanText(body.reason, 140) || null;
  await env.DB.prepare("INSERT OR IGNORE INTO profile_reports (user_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)").bind(who.id, u.id, reason, iso(now)).run();
  return json({ ok: true });
}

/* ---------------- routes ---------------- */

const ROUTES = {
  "/api/profile": ["GET", handleProfile],
  "/api/profile/report": ["POST", handleReport],
  "/api/members/search": ["GET", handleSearch],
  "/api/follow": ["POST", handleFollow],
  "/api/follows": ["GET", handleFollows],
  "/api/block": ["POST", handleBlock],
  "/api/me/blocks": ["GET", handleBlocks],
  "/api/me/bio": ["POST", handleBio],
  "/api/me/portfolio": ["GET", (request, env, x) => handlePortfolio(request, env, x.fetchImpl, x.now)],
  "/api/mod/bio/clear": ["POST", (request, env, x) => handleClearBio(request, env, x.fetchImpl, x.now)],
};
/** Every path that exists only while PROFILES=on (src/index.js answers 404 not_enabled for them otherwise). */
export const PROFILE_PATHS = new Set(Object.keys(ROUTES));

/** All the profile routes (index.js calls this only when the switch is on). */
export async function routeProfiles(request, env, fetchImpl = fetch, ctx = null, now = Date.now()) {
  const route = ROUTES[new URL(request.url).pathname];
  if (!route) return json({ error: "not_found" }, 404);
  if (request.method !== route[0]) return json({ error: "method_not_allowed" }, 405);
  if (!env.DB) return json({ ok: false, error: "unavailable" }, 503);
  try {
    return await route[1](request, env, { fetchImpl, ctx, now });
  } catch (e) {
    // a failing database answers 503 on these routes only; what is logged is the short reason, never a name or an address
    console.error("profile route failed", String((e && e.message) || e).slice(0, 80));
    return json({ ok: false, error: "unavailable" }, 503);
  }
}
