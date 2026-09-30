/**
 * Admin dashboard API: /api/admin/* — the founder's mission control for managing and testing
 * the whole site before (and after) the Oct 10 launch.
 *
 * Tiers (owner > admin > moderator):
 *   owner      → a wallet in the ADMIN_WALLETS setting (or granted in admin_roles). Everything,
 *                including roles, the test lab and anything destructive.
 *   admin      → everything except granting/revoking roles and test-lab reset.
 *   moderator  → content moderation and objection triage only (read + decide).
 *
 * Sign-in is the site's own wallet session (the vs cookie, src/auth.js). The four sensitive
 * actions (user ban, role grant/revoke, test reset) need a fresh wallet proof (last 30 min),
 * like the site's other sensitive actions.
 *
 * Every mutating call is appended to admin_audit. The test lab seeds rows tagged in admin_test
 * and reset deletes ONLY those rows, never real data.
 *
 * Wiring (src/index.js, in handleApi before the switch):
 *   import { handleAdmin } from "./admin.js";
 *   if (path.startsWith("/api/admin/")) return handleAdmin(request, env);
 */
import { getSession, isFresh, SESSION_COOKIE } from "./auth.js";
import { adminWallets } from "./roles.js";
import { clearCookie, cookie, getCookie, json, readJson, sameSite, sha256 } from "./http.js";
import { ensureSchema } from "./store.js";
import { cleanText } from "./text.js";
import { isSolanaAddress } from "./solana.js";
import { POLICY, DAY, iso } from "./policy.js";
import { OFFICIAL } from "./official.js";

const ROLES = ["moderator", "admin", "owner"];
const LEVEL = { moderator: 1, admin: 2, owner: 3 };
export const PREVIEW_COOKIE = "vicinity_preview_role";
const PREVIEW_ROLES = ["visitor", "holder", "founder", "cm"];
const BAN_DAYS = 30;

/** A wallet's admin role: owner via ADMIN_WALLETS, otherwise the admin_roles table. */
export async function adminRoleOf(env, wallet) {
  if (!wallet) return null;
  if (adminWallets(env).includes(wallet)) return "owner";
  const r = await env.DB.prepare("SELECT role FROM admin_roles WHERE wallet = ?").bind(wallet).first();
  return r && ROLES.includes(r.role) ? r.role : null;
}

function logAudit(db, { actor, action, target = null, detail = null }, now = Date.now()) {
  return db.prepare("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(actor, action, target, detail == null ? null : String(detail).slice(0, 500), iso(now));
}
const track = (db, table, id, id2 = null) =>
  db.prepare("INSERT INTO admin_test (table_name, row_id, row_id2) VALUES (?, ?, ?)").bind(table, id, id2);

/**
 * Signed-in admin check. Returns { ctx } or { res } with the 401/403 to send.
 * minRole: the lowest tier allowed. fresh: also require a wallet proof from the last 30 minutes.
 */
/**
 * Resolve the admin caller: session -> user, with owner bootstrap (see guard).
 * Returns { s, user, wallet } or null when not signed in / not provisionable.
 */
async function adminCaller(request, env, now = Date.now()) {
  const db = env.DB;
  const s = await getSession(env, request, now);
  if (!s) return null;
  let user = s.user;
  const wallet = user ? user.wallet : s.wallet;
  if (!user && wallet && adminWallets(env).includes(wallet)) {
    user = await db.prepare("SELECT * FROM users WHERE wallet = ?").bind(wallet).first();
    if (!user) {
      const r = await db.prepare("INSERT INTO users (wallet, provider, provider_id, created_at) VALUES (?, 'wallet', ?, ?)")
        .bind(wallet, wallet, iso(now)).run();
      user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(r.meta.last_row_id).first();
      await logAudit(db, { actor: wallet, action: "admin/bootstrap", detail: "owner user row provisioned from wallet signature" }, now).run();
    }
    const token = getCookie(request, SESSION_COOKIE);
    if (token && token.length <= 100) await db.prepare("UPDATE sessions SET user_id = ? WHERE id = ?").bind(user.id, await sha256(token)).run();
  }
  if (!user) return null;
  return { s, user, wallet: user.wallet };
}

/**
 * Signed-in admin check. Returns { ctx } or { res } with the 401/403 to send.
 * minRole: the lowest tier allowed. fresh: also require a wallet proof from the last 30 minutes.
 */
async function guard(request, env, minRole, { fresh = false, now = Date.now() } = {}) {
  if (!env.DB) return { res: json({ ok: false, error: "unavailable" }, 503) };
  await ensureSchema(env.DB);
  const c = await adminCaller(request, env, now);
  if (!c) return { res: json({ ok: false, error: "sign_in" }, 401) };
  const role = await adminRoleOf(env, c.wallet);
  if (!role || LEVEL[role] < LEVEL[minRole]) return { res: json({ ok: false, error: "forbidden", need: minRole }, 403) };
  if (fresh && !isFresh(c.s, now)) return { res: json({ ok: false, error: "reprove" }, 403) };
  return { ctx: { session: c.s, user: c.user, wallet: c.wallet, role, db: env.DB, now, env } };
}
/** Same, but the request changes something: it must come from this site's own pages. */
const postGuard = (request, env, minRole, opts = {}) =>
  !sameSite(request) ? { res: json({ ok: false, error: "wrong_origin" }, 403) } : guard(request, env, minRole, opts);

const q = (url, name, max = 60) => cleanText(url.searchParams.get(name) || "", max) || "";
const limitOf = (url, dflt = 50, max = 200) => Math.min(max, Math.max(1, Number(url.searchParams.get("limit")) || dflt));

/* ---------------- me / overview ---------------- */

async function handleMe(request, env, now) {
  if (!env.DB) return json({ ok: false, error: "unavailable" }, 503);
  await ensureSchema(env.DB);
  const c = await adminCaller(request, env, now);
  if (!c) return json({ ok: false, error: "sign_in" }, 401);
  return json({ ok: true, wallet: c.wallet, role: await adminRoleOf(env, c.wallet) });
}

async function handleOverview(ctx) {
  const { db } = ctx;
  const [users, seats, elections, reports, objections, tokens, coins, snaps] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM users").first(),
    db.prepare("SELECT status, COUNT(*) AS n FROM seats GROUP BY status").all(),
    db.prepare("SELECT COUNT(*) AS n FROM elections WHERE status = 'open'").first(),
    db.prepare("SELECT COUNT(*) AS n FROM reports r JOIN posts p ON p.id = r.post_id WHERE p.hidden = 0").first(),
    db.prepare("SELECT COUNT(*) AS n FROM objections WHERE status = 'open'").first(),
    db.prepare("SELECT COUNT(*) AS n FROM admin_tokens").first(),
    db.prepare("SELECT COUNT(*) AS n FROM city_coins WHERE mint IS NOT NULL").first(),
    db.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM snapshots").first(),
  ]);
  return json({
    ok: true,
    users: users.n,
    seats: Object.fromEntries(seats.results.map((r) => [r.status, r.n])),
    openElections: elections.n,
    pendingReports: reports.n,
    pendingObjections: objections.n,
    registeredTokens: tokens.n,
    launchedCityCoins: coins.n,
    snapshots: snaps.n,
    latestSnapshot: snaps.latest,
  });
}

/* ---------------- users ---------------- */

async function handleUsers(ctx, url) {
  const like = `%${q(url, "q", 40).replace(/[%_]/g, "")}%`;
  const rows = (await ctx.db.prepare(
    `SELECT u.id, u.wallet, u.handle, u.name, u.home_name, u.home_country, u.created_at,
            (SELECT COUNT(*) FROM bans b WHERE b.user_id = u.id AND b.country = '*') AS banned
     FROM users u WHERE ? = '%%' OR u.wallet LIKE ? OR u.handle LIKE ? OR u.name LIKE ?
     ORDER BY u.id DESC LIMIT ?`)
    .bind(like, like, like, like, limitOf(url)).all()).results;
  return json({ ok: true, users: rows });
}

async function handleBan(request, ctx, unban) {
  const body = await readJson(request);
  const wallet = body && body.wallet;
  if (!isSolanaAddress(wallet)) return json({ ok: false, error: "bad_wallet" }, 400);
  const target = await ctx.db.prepare("SELECT id FROM users WHERE wallet = ?").bind(wallet).first();
  if (!target) return json({ ok: false, error: "not_found" }, 404);
  if (target.id === ctx.user.id) return json({ ok: false, error: "own_account" }, 400);
  const now = ctx.now;
  if (unban) {
    await ctx.db.batch([
      ctx.db.prepare("DELETE FROM bans WHERE user_id = ? AND country = '*'").bind(target.id),
      logAudit(ctx.db, { actor: ctx.wallet, action: "users/unban", target: wallet }, now),
    ]);
    return json({ ok: true, unbanned: true });
  }
  const reason = cleanText(body.reason, 200) || "admin";
  await ctx.db.batch([
    ctx.db.prepare("INSERT OR REPLACE INTO bans (user_id, country, by_user, reason, created_at, expires_at) VALUES (?, '*', ?, ?, ?, ?)")
      .bind(target.id, ctx.user.id, reason, iso(now), iso(now + BAN_DAYS * DAY)),
    logAudit(ctx.db, { actor: ctx.wallet, action: "users/ban", target: wallet, detail: reason }, now),
  ]);
  return json({ ok: true, banned: true, days: BAN_DAYS });
}

/* ---------------- seats & claims ---------------- */

async function handleSeats(ctx, url) {
  const status = q(url, "status", 20);
  const rows = (await ctx.db.prepare(
    `SELECT s.id, s.city_id, s.city_name, s.country, s.status, s.created_at, s.activated_at, s.ended_at, s.end_reason,
            u.handle, u.name, u.wallet
     FROM seats s LEFT JOIN users u ON u.id = s.user_id
     ${status ? "WHERE s.status = ?" : ""} ORDER BY s.id DESC LIMIT 200`)
    .bind(...(status ? [status] : [])).all()).results;
  return json({ ok: true, seats: rows });
}

/** Founder claims waiting on a human: applications in open windows. */
async function handleClaims(ctx) {
  const rows = (await ctx.db.prepare(
    `SELECT a.id, a.city_id, a.pitch, a.created_at, a.valid, a.total, a.rank, w.city_name, w.country, w.closes_at,
            u.handle, u.name, u.wallet
     FROM applications a JOIN windows w ON w.id = a.window_id JOIN users u ON u.id = a.user_id
     WHERE a.withdrawn = 0 AND w.status = 'open' ORDER BY a.id DESC LIMIT 200`).all()).results;
  return json({ ok: true, claims: rows });
}

/**
 * Approve / reject a founder claim (an application). Approve marks it valid for the normal
 * scoring flow; reject withdraws it. Seats themselves are decided by the site's own flow.
 */
async function handleSeatDecide(request, ctx) {
  const body = await readJson(request);
  const app = body && await ctx.db.prepare("SELECT * FROM applications WHERE id = ?").bind(Number(body.id) || 0).first();
  if (!app) return json({ ok: false, error: "not_found" }, 404);
  if (app.withdrawn) return json({ ok: false, error: "already_decided" }, 409);
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) return json({ ok: false, error: "bad_decision" }, 400);
  await ctx.db.batch([
    ctx.db.prepare(decision === "approve" ? "UPDATE applications SET valid = 1 WHERE id = ?" : "UPDATE applications SET withdrawn = 1 WHERE id = ?").bind(app.id),
    logAudit(ctx.db, { actor: ctx.wallet, action: "seats/decide", target: `application:${app.id}`, detail: decision }, ctx.now),
  ]);
  return json({ ok: true, decision });
}

/* ---------------- objections ---------------- */

async function handleObjections(ctx, url) {
  const only = url.searchParams.get("status") === "all" ? "" : "WHERE o.status = 'open'";
  const rows = (await ctx.db.prepare(
    `SELECT o.id, o.reason, o.created_at, o.status, s.city_name, s.country, s.status AS seat_status,
            u.handle, u.name FROM objections o
     JOIN seats s ON s.id = o.seat_id JOIN users u ON u.id = o.user_id
     ${only} ORDER BY o.id DESC LIMIT 200`).all()).results;
  return json({ ok: true, objections: rows });
}

async function handleObjectionDecide(request, ctx) {
  const body = await readJson(request);
  const o = body && await ctx.db.prepare("SELECT * FROM objections WHERE id = ? AND status = 'open'").bind(Number(body.id) || 0).first();
  if (!o) return json({ ok: false, error: "not_found" }, 404);
  const uphold = body.uphold === true;
  const note = cleanText(body.note, 300);
  const stmts = [
    ctx.db.prepare("UPDATE objections SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?")
      .bind(uphold ? "upheld" : "dismissed", ctx.user.id, iso(ctx.now), note, o.id),
  ];
  // An upheld objection ends the seat right away — including a Seed Steward's, which the
  // site's own objection flow cannot revoke (admin override, recorded in the audit trail).
  if (uphold) stmts.push(ctx.db.prepare(
    "UPDATE seats SET status = 'revoked', ended_at = ?, end_reason = 'objection_upheld' WHERE id = ? AND status IN ('provisional', 'active', 'grace', 'steward')")
    .bind(iso(ctx.now), o.seat_id));
  stmts.push(logAudit(ctx.db, { actor: ctx.wallet, action: "objections/decide", target: `objection:${o.id}`, detail: `${uphold ? "upheld" : "dismissed"}${uphold ? " (seat revoked)" : ""}${note ? " — " + note : ""}` }, ctx.now));
  await ctx.db.batch(stmts);
  return json({ ok: true, upheld: uphold });
}

/* ---------------- elections ---------------- */

async function handleElections(ctx) {
  const rows = (await ctx.db.prepare(
    `SELECT e.*, (SELECT COUNT(*) FROM election_votes v WHERE v.election_id = e.id) AS votes
     FROM elections e ORDER BY e.id DESC LIMIT 100`).all()).results;
  return json({ ok: true, elections: rows });
}

async function handleElectionCreate(request, ctx) {
  const body = await readJson(request);
  const country = (cleanText(body && body.country, 4) || "").toUpperCase();
  const seats = Math.floor(Number(body && body.seats)) || 0;
  const days = Math.floor(Number(body && body.closesInDays)) || 0;
  if (!/^[A-Z]{2}$/.test(country)) return json({ ok: false, error: "bad_country" }, 400);
  if (seats < 1 || seats > 10) return json({ ok: false, error: "bad_seats" }, 400);
  if (days < 1 || days > 90) return json({ ok: false, error: "bad_dates" }, 400);
  if (await ctx.db.prepare("SELECT id FROM elections WHERE country = ? AND status = 'open'").bind(country).first())
    return json({ ok: false, error: "already_open" }, 409);
  const closesAt = iso(ctx.now + days * DAY);
  const r = await ctx.db.prepare("INSERT INTO elections (country, policy, opened_at, closes_at, status) VALUES (?, ?, ?, ?, 'open')")
    .bind(country, POLICY.version, iso(ctx.now), closesAt).run();
  const id = r.meta.last_row_id;
  await logAudit(ctx.db, { actor: ctx.wallet, action: "elections/create", target: `election:${id}`, detail: `${country}, ${seats} seat(s), closes ${closesAt}` }, ctx.now).run();
  return json({ ok: true, id, country, seats, closesAt });
}

/* ---------------- token registry ---------------- */

async function handleTokens(ctx) {
  const registered = (await ctx.db.prepare("SELECT * FROM admin_tokens ORDER BY created_at DESC LIMIT 200").all()).results;
  const cityCoins = (await ctx.db.prepare(
    "SELECT city_id, city_name, country, name, mint, launched_at FROM city_coins WHERE mint IS NOT NULL ORDER BY launched_at DESC LIMIT 200").all()).results;
  return json({ ok: true, registered, cityCoins, official: OFFICIAL.tokens || [] });
}

async function handleTokenRegister(request, ctx) {
  const body = await readJson(request);
  const mint = body && body.mint;
  const city = cleanText(body && body.city, 80);
  const founderWallet = body && body.founderWallet ? body.founderWallet : null;
  const platform = ["raydium", "launchlab", "jupiter", "other"].includes(body && body.platform) ? body.platform : "other";
  if (!isSolanaAddress(mint)) return json({ ok: false, error: "bad_mint" }, 400);
  if (!city) return json({ ok: false, error: "bad_city" }, 400);
  if (founderWallet && !isSolanaAddress(founderWallet)) return json({ ok: false, error: "bad_wallet" }, 400);
  try {
    await ctx.db.batch([
      ctx.db.prepare("INSERT INTO admin_tokens (mint, city, founder_wallet, platform, registered_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(mint, city, founderWallet, platform, ctx.wallet, iso(ctx.now)),
      logAudit(ctx.db, { actor: ctx.wallet, action: "tokens/register", target: mint, detail: `${city} via ${platform}` }, ctx.now),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return json({ ok: false, error: "already_registered" }, 409);
    throw e;
  }
  return json({ ok: true, mint, city, platform });
}

/* ---------------- content: reports & appeals ---------------- */

async function handleReports(ctx) {
  const rows = (await ctx.db.prepare(
    `SELECT p.id AS post_id, p.body, p.kind, p.scope, p.place, p.country, p.created_at, u.handle, u.name,
            COUNT(r.user_id) AS reports, MAX(r.created_at) AS last_report, MAX(r.reason) AS reason
     FROM reports r JOIN posts p ON p.id = r.post_id JOIN users u ON u.id = p.user_id
     WHERE p.hidden = 0 GROUP BY p.id ORDER BY last_report DESC LIMIT 100`).all()).results;
  return json({ ok: true, reports: rows });
}

async function handleReportDecide(request, ctx) {
  const body = await readJson(request);
  const postId = Number(body && body.id) || 0;
  const action = body && body.action;
  if (!postId || !["hide", "dismiss"].includes(action)) return json({ ok: false, error: "bad_request" }, 400);
  const post = await ctx.db.prepare("SELECT id, hidden FROM posts WHERE id = ?").bind(postId).first();
  if (!post) return json({ ok: false, error: "not_found" }, 404);
  const note = cleanText(body.note, 200);
  if (action === "hide") {
    await ctx.db.batch([
      ctx.db.prepare("UPDATE posts SET hidden = 1, hide_confirmed = 1, hidden_until = NULL WHERE id = ?").bind(postId),
      logAudit(ctx.db, { actor: ctx.wallet, action: "reports/hide", target: `post:${postId}`, detail: note }, ctx.now),
    ]);
    return json({ ok: true, hidden: true });
  }
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM reports WHERE post_id = ?").bind(postId),
    logAudit(ctx.db, { actor: ctx.wallet, action: "reports/dismiss", target: `post:${postId}`, detail: note }, ctx.now),
  ]);
  return json({ ok: true, dismissed: true });
}

async function handleAppeals(ctx) {
  const rows = (await ctx.db.prepare(
    `SELECT ap.*, u.handle, u.name FROM appeals ap JOIN users u ON u.id = ap.user_id
     WHERE ap.status = 'open' ORDER BY ap.id DESC LIMIT 100`).all()).results;
  return json({ ok: true, appeals: rows });
}

async function handleAppealDecide(request, ctx) {
  const body = await readJson(request);
  const ap = body && await ctx.db.prepare("SELECT * FROM appeals WHERE id = ? AND status = 'open'").bind(Number(body.id) || 0).first();
  if (!ap) return json({ ok: false, error: "not_found" }, 404);
  const decision = body.decision === "uphold" ? "uphold" : body.decision === "reject" ? "reject" : null;
  if (!decision) return json({ ok: false, error: "bad_decision" }, 400);
  const note = cleanText(body.note, 300);
  const stmts = [ctx.db.prepare("UPDATE appeals SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?")
    .bind(decision === "uphold" ? "upheld" : "rejected", ctx.user.id, iso(ctx.now), note, ap.id)];
  if (decision === "uphold") stmts.push(ctx.db.prepare("DELETE FROM bans WHERE action_id = ?").bind(ap.action_id));
  stmts.push(logAudit(ctx.db, { actor: ctx.wallet, action: "appeals/decide", target: `appeal:${ap.id}`, detail: decision }, ctx.now));
  await ctx.db.batch(stmts);
  return json({ ok: true, decision });
}

/* ---------------- snapshots ---------------- */

async function handleSnapshots(ctx) {
  const rows = (await ctx.db.prepare(
    "SELECT id, cutoff_at, status, holders, total, created_at, activates_at, note FROM snapshots ORDER BY id DESC LIMIT 50").all()).results;
  return json({ ok: true, snapshots: rows });
}

async function handleSnapshotCreate(request, ctx) {
  const body = await readJson(request);
  const cutoff = cleanText(body && body.cutoff, 32);
  const at = cutoff && Date.parse(cutoff);
  if (!at || Number.isNaN(at)) return json({ ok: false, error: "bad_cutoff" }, 400);
  if (at > ctx.now + 3600_000) return json({ ok: false, error: "cutoff_future" }, 400);
  const r = await ctx.db.prepare(
    `INSERT INTO snapshots (cutoff_at, policy, created_at, status, activates_at, holders, total, samples, input_hash, merkle_root, note)
     VALUES (?, ?, ?, 'provisional', ?, 0, 0, 0, 'admin-manual', 'admin-manual', ?)`)
    .bind(new Date(at).toISOString(), POLICY.version, iso(ctx.now), new Date(at + 7 * DAY).toISOString(),
      "Created from the admin dashboard; holder data not computed yet.").run();
  const id = r.meta.last_row_id;
  await logAudit(ctx.db, { actor: ctx.wallet, action: "snapshots/create", target: `snapshot:${id}`, detail: `cutoff ${new Date(at).toISOString()}` }, ctx.now).run();
  return json({ ok: true, id });
}

/* ---------------- config & roles ---------------- */

async function handleConfig(ctx) {
  const env = ctx.env;
  const [roles, audit] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM admin_roles").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit").first(),
  ]);
  return json({
    ok: true,
    siteMode: env.SITE_MODE || "live",
    policyVersion: POLICY.version,
    // Presence only — secret values never leave the server.
    flags: {
      GOOGLE_CLIENT_ID: Boolean(env.GOOGLE_CLIENT_ID),
      GOOGLE_CLIENT_SECRET: Boolean(env.GOOGLE_CLIENT_SECRET),
      X_CLIENT_ID: Boolean(env.X_CLIENT_ID),
      X_CLIENT_SECRET: Boolean(env.X_CLIENT_SECRET),
      VICINITY_MINT: Boolean(env.VICINITY_MINT),
      SOLANA_RPC_URL: Boolean(env.SOLANA_RPC_URL),
      ADMIN_WALLETS: Boolean(env.ADMIN_WALLETS),
      SNAPSHOT_CUTOFF: Boolean(env.SNAPSHOT_CUTOFF),
    },
    grantedRoles: roles.n,
    auditRows: audit.n,
  });
}

async function handleRoles(ctx) {
  const rows = (await ctx.db.prepare("SELECT wallet, role, granted_by, granted_at FROM admin_roles ORDER BY granted_at DESC").all()).results;
  const envOwners = adminWallets(ctx.env).map((w) => ({ wallet: w, role: "owner", source: "env" }));
  return json({ ok: true, roles: rows.map((r) => ({ ...r, source: "granted" })), envOwners });
}

async function handleRoleGrant(request, ctx) {
  const body = await readJson(request);
  const wallet = body && body.wallet;
  const role = body && body.role;
  if (!isSolanaAddress(wallet)) return json({ ok: false, error: "bad_wallet" }, 400);
  if (!["moderator", "admin", "owner"].includes(role)) return json({ ok: false, error: "bad_role" }, 400);
  if (wallet === ctx.wallet) return json({ ok: false, error: "own_account" }, 400);
  await ctx.db.batch([
    ctx.db.prepare("INSERT OR REPLACE INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, ?, ?, ?)")
      .bind(wallet, role, ctx.wallet, iso(ctx.now)),
    logAudit(ctx.db, { actor: ctx.wallet, action: "roles/grant", target: wallet, detail: role }, ctx.now),
  ]);
  return json({ ok: true, wallet, role });
}

async function handleRoleRevoke(request, ctx) {
  const body = await readJson(request);
  const wallet = body && body.wallet;
  if (!isSolanaAddress(wallet)) return json({ ok: false, error: "bad_wallet" }, 400);
  if (wallet === ctx.wallet) return json({ ok: false, error: "own_account" }, 400);
  const r = await ctx.db.prepare("DELETE FROM admin_roles WHERE wallet = ?").bind(wallet).run();
  if (!r.meta.changes) return json({ ok: false, error: "not_found" }, 404);
  await logAudit(ctx.db, { actor: ctx.wallet, action: "roles/revoke", target: wallet }, ctx.now).run();
  return json({ ok: true, revoked: true });
}

async function handleAudit(ctx, url) {
  const rows = (await ctx.db.prepare("SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?").bind(limitOf(url, 100, 500)).all()).results;
  return json({ ok: true, audit: rows });
}

/* ---------------- test lab (owner only) ---------------- */

const seedAddr = (i) => `TestLab${String(i).padStart(2, "0")}${"1".repeat(35)}`;

async function handleTestSeed(ctx) {
  const { db, now } = ctx;
  if ((await db.prepare("SELECT COUNT(*) AS n FROM admin_test").first()).n)
    return json({ ok: false, error: "already_seeded" }, 409);
  const at = iso(now);
  const userIds = [];
  for (let i = 0; i < 8; i++) {
    const r = await db.prepare(
      "INSERT INTO users (wallet, provider, provider_id, handle, name, home_city, home_name, home_country, created_at) VALUES (?, 'testlab', ?, ?, ?, 'testlab-nyc', 'Testville', 'XX', ?)")
      .bind(seedAddr(i), `seed-${i}`, `@testlab${i}`, `Test Lab ${i}`, at).run();
    userIds.push(r.meta.last_row_id);
    await track(db, "users", r.meta.last_row_id).run();
  }
  const cities = [["testlab-nyc", "Testville"], ["testlab-la", "Mockburg"], ["testlab-chi", "Faketown"]];
  const statuses = ["active", "steward", "grace"];
  const seatIds = [];
  for (let i = 0; i < 3; i++) {
    const r = await db.prepare(
      "INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at) VALUES (?, ?, 'XX', ?, ?, 5, 0.5, ?, ?)")
      .bind(cities[i][0], cities[i][1], userIds[i], seedAddr(i), statuses[i], at).run();
    seatIds.push(r.meta.last_row_id);
    await track(db, "seats", r.meta.last_row_id).run();
  }
  const postIds = [];
  for (let i = 0; i < 5; i++) {
    const r = await db.prepare(
      "INSERT INTO posts (user_id, scope, place, country, kind, body, created_at) VALUES (?, 'city', 'testlab-nyc', 'XX', 'meme', ?, ?)")
      .bind(userIds[i % 8], `[TESTLAB seed] test post ${i + 1} — safe to delete`, at).run();
    postIds.push(r.meta.last_row_id);
    await track(db, "posts", r.meta.last_row_id).run();
  }
  for (const [pi, ui] of [[0, 6], [1, 7]]) {
    await db.prepare("INSERT OR IGNORE INTO reports (post_id, user_id, reason, created_at) VALUES (?, ?, 'spam', ?)")
      .bind(postIds[pi], userIds[ui], at).run();
    await track(db, "reports", postIds[pi], userIds[ui]).run();
  }
  const or = await db.prepare("INSERT INTO objections (seat_id, user_id, reason, created_at) VALUES (?, ?, 'testlab objection', ?)")
    .bind(seatIds[1], userIds[3], at).run();
  await track(db, "objections", or.meta.last_row_id).run();
  const er = await db.prepare("INSERT INTO elections (country, policy, opened_at, closes_at, status) VALUES ('XX', 5, ?, ?, 'open')")
    .bind(at, iso(now + 7 * DAY)).run();
  await track(db, "elections", er.meta.last_row_id).run();
  await logAudit(db, { actor: ctx.wallet, action: "test/seed", detail: "8 users, 3 seats, 5 posts, 2 reports, 1 objection, 1 election" }, now).run();
  return json({ ok: true, seeded: { users: 8, seats: 3, posts: 5, reports: 2, objections: 1, elections: 1 } });
}

const RESET_ORDER = ["reports", "objections", "posts", "seats", "elections", "users"];
const resetSql = {
  reports: "DELETE FROM reports WHERE post_id = ? AND user_id = ?",
  objections: "DELETE FROM objections WHERE id = ?",
  posts: "DELETE FROM posts WHERE id = ?",
  seats: "DELETE FROM seats WHERE id = ?",
  elections: "DELETE FROM elections WHERE id = ?",
  users: "DELETE FROM users WHERE id = ?",
};

async function handleTestReset(request, ctx) {
  const body = await readJson(request);
  if (!body || body.confirm !== "RESET") return json({ ok: false, error: "need_confirm" }, 400);
  const { db, now } = ctx;
  const rows = (await db.prepare("SELECT table_name, row_id, row_id2 FROM admin_test ORDER BY id DESC").all()).results;
  let deleted = 0;
  for (const table of RESET_ORDER) {
    for (const r of rows.filter((x) => x.table_name === table)) {
      const args = r.row_id2 == null ? [r.row_id] : [r.row_id, r.row_id2];
      const out = await db.prepare(resetSql[table]).bind(...args).run();
      deleted += out.meta.changes || 0;
    }
  }
  await db.prepare("DELETE FROM admin_test").run();
  await logAudit(db, { actor: ctx.wallet, action: "test/reset", detail: `removed ${deleted} seeded row(s)` }, now).run();
  return json({ ok: true, deleted });
}

async function handlePreviewRole(request, ctx) {
  const body = await readJson(request);
  const role = body && body.role;
  if (role !== null && !PREVIEW_ROLES.includes(role)) return json({ ok: false, error: "bad_role" }, 400);
  await logAudit(ctx.db, { actor: ctx.wallet, action: "test/preview-role", detail: role || "cleared" }, ctx.now).run();
  const set = role === null ? clearCookie(PREVIEW_COOKIE) : cookie(PREVIEW_COOKIE, role, 30 * DAY / 1000);
  return json({ ok: true, previewRole: role }, 200, { "Set-Cookie": set });
}

/* ---------------- router ---------------- */

export async function handleAdmin(request, env, now = Date.now()) {
  const url = new URL(request.url);
  const method = request.method;
  const rel = url.pathname.replace(/^\/api\/admin\/?/, "");
  const only = (m) => (method === m ? null : json({ ok: false, error: "method_not_allowed" }, 405));
  const need = (minRole, opts) => guard(request, env, minRole, { ...opts, now });
  const needPost = (minRole, opts) => postGuard(request, env, minRole, { ...opts, now });
  const run = async (g, fn) => { const r = await g; return r.res || fn(r.ctx); };

  switch (rel) {
    case "me": { const b = only("GET"); return b || handleMe(request, env, now); }
    case "overview": { const b = only("GET"); return b || run(need("moderator"), handleOverview); }
    case "users": { const b = only("GET"); return b || run(need("moderator"), (c) => handleUsers(c, url)); }
    case "users/ban": { const b = only("POST"); return b || run(await needPost("admin", { fresh: true }), (c) => handleBan(request, c, false)); }
    case "users/unban": { const b = only("POST"); return b || run(await needPost("admin"), (c) => handleBan(request, c, true)); }
    case "seats": { const b = only("GET"); return b || run(need("moderator"), (c) => handleSeats(c, url)); }
    case "claims": { const b = only("GET"); return b || run(need("moderator"), handleClaims); }
    case "seats/decide": { const b = only("POST"); return b || run(await needPost("admin"), (c) => handleSeatDecide(request, c)); }
    case "objections": { const b = only("GET"); return b || run(need("moderator"), (c) => handleObjections(c, url)); }
    case "objections/decide": { const b = only("POST"); return b || run(await needPost("moderator"), (c) => handleObjectionDecide(request, c)); }
    case "elections": { const b = only("GET"); return b || run(need("moderator"), handleElections); }
    case "elections/create": { const b = only("POST"); return b || run(await needPost("admin"), (c) => handleElectionCreate(request, c)); }
    case "tokens": { const b = only("GET"); return b || run(need("moderator"), handleTokens); }
    case "tokens/register": { const b = only("POST"); return b || run(await needPost("admin"), (c) => handleTokenRegister(request, c)); }
    case "reports": { const b = only("GET"); return b || run(need("moderator"), handleReports); }
    case "reports/decide": { const b = only("POST"); return b || run(await needPost("moderator"), (c) => handleReportDecide(request, c)); }
    case "appeals": { const b = only("GET"); return b || run(need("moderator"), handleAppeals); }
    case "appeals/decide": { const b = only("POST"); return b || run(await needPost("admin"), (c) => handleAppealDecide(request, c)); }
    case "snapshots": { const b = only("GET"); return b || run(need("moderator"), handleSnapshots); }
    case "snapshots/create": { const b = only("POST"); return b || run(await needPost("admin"), (c) => handleSnapshotCreate(request, c)); }
    case "config": { const b = only("GET"); return b || run(need("admin"), (c) => handleConfig({ ...c, env })); }
    case "roles": { const b = only("GET"); return b || run(need("owner"), (c) => handleRoles({ ...c, env })); }
    case "roles/grant": { const b = only("POST"); return b || run(await needPost("owner", { fresh: true }), (c) => handleRoleGrant(request, c)); }
    case "roles/revoke": { const b = only("POST"); return b || run(await needPost("owner", { fresh: true }), (c) => handleRoleRevoke(request, c)); }
    case "audit": { const b = only("GET"); return b || run(need("moderator"), (c) => handleAudit(c, url)); }
    case "test/seed": { const b = only("POST"); return b || run(await needPost("owner"), handleTestSeed); }
    case "test/reset": { const b = only("POST"); return b || run(await needPost("owner", { fresh: true }), (c) => handleTestReset(request, c)); }
    case "test/preview-role": { const b = only("POST"); return b || run(await needPost("owner"), (c) => handlePreviewRole(request, c)); }
    default: return json({ ok: false, error: "not_found" }, 404);
  }
}
