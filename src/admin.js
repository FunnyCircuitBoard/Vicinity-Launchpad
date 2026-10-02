/**
 * The admin API behind the /admin dashboard (public/admin.html + public/admin.js). Staff sign in with a
 * wallet and use these routes to look at the community, make decisions, and manage who else has access.
 * Everything lives under /api/admin/ and is routed by handleAdmin() at the bottom of this file.
 *
 * Roles, lowest to highest (a higher role can do everything a lower one can):
 *   moderator  look at every list; decide objections to seats and reported posts
 *   admin      ban / unban, decide seat claims and appeals, open elections, create snapshots,
 *              register tokens, read the config summary
 *   owner      grant / revoke roles, and use the test lab (seed, reset, preview role)
 * A wallet in the ADMIN_WALLETS setting is always an owner. Anyone else needs a row in admin_roles,
 * which an owner grants from the dashboard.
 *
 * Rules every route except "me" follows (guard / postGuard):
 *   - needs the database (503 "unavailable"), a signed-in person (401 "sign_in") and a high enough
 *     role (403 "forbidden", with the role that was needed);
 *   - POST routes also need the browser's Origin to be this site (403 "wrong_origin");
 *   - routes marked "fresh" need the wallet proven again in the last POLICY.freshProofMinutes
 *     minutes (403 "reprove");
 *   - every change is written to admin_audit (who, what, target, detail). This trail is separate from
 *     the public moderation log in src/moderation.js: only moderators and above can read it.
 *
 * Routes (role needed; "fresh" = recent wallet proof):
 *   GET  me                  any signed-in person   who am I, and which role do I have (null = none)
 *   GET  overview            moderator              counts for the dashboard tiles
 *   GET  users               moderator              search people by wallet / handle / name
 *   POST users/ban           admin, fresh           site-wide ban for 30 days
 *   POST users/unban         admin                  lift a site-wide ban
 *   GET  seats               moderator              founder seats, optional ?status=
 *   GET  claims              moderator              seat applications in windows that are still open
 *   POST seats/decide        admin                  approve / reject one application
 *   GET  objections          moderator              objections to seats (open, or ?status=all)
 *   POST objections/decide   moderator              uphold (revokes the seat) or dismiss
 *   GET  elections           moderator              country elections
 *   POST elections/create    admin                  open a country election
 *   GET  tokens              moderator              registered tokens, launched city coins, official tokens
 *   POST tokens/register     admin                  record a token mint in the registry
 *   GET  reports             moderator              reported posts that are still visible
 *   POST reports/decide      moderator              hide a post for good, or dismiss its reports
 *   GET  appeals             moderator              open appeals
 *   POST appeals/decide      admin                  uphold (lifts the ban) or reject
 *   GET  snapshots           moderator              supporter snapshots
 *   POST snapshots/create    admin                  add a placeholder snapshot row
 *   GET  config              admin                  site mode and which settings are present
 *   GET  roles               owner                  who holds which role
 *   POST roles/grant         owner, fresh           give a wallet a role
 *   POST roles/revoke        owner, fresh           take a granted role away
 *   GET  audit               moderator              the admin audit trail
 *   POST test/seed           owner                  add clearly marked test data
 *   POST test/reset          owner, fresh           delete exactly the rows the seed added
 *   POST test/preview-role   owner                  set / clear the "preview the site as" cookie
 */
import { OFFICIAL } from "./official.js";
import { clearCookie, cookie, getCookie, json, readJson, sameSite, sha256 } from "./http.js";
import { isSolanaAddress } from "./solana.js";
import { ensureSchema } from "./store.js";
import { DAY, POLICY, iso } from "./policy.js";
import { autoUsername, cleanText } from "./text.js";
import { SESSION_COOKIE, getSession, isFresh } from "./auth.js";
import { adminWallets } from "./roles.js";

/** The roles an admin_roles row may hold, and how they rank (a route needs at least its minimum level). */
const ROLES = ["moderator", "admin", "owner"];
const LEVEL = { moderator: 1, admin: 2, owner: 3 };
/** Cookie set by the test lab's "preview the site as" tool, and the roles it accepts. */
const PREVIEW_COOKIE = "vicinity_preview_role";
const PREVIEW_ROLES = ["visitor", "holder", "founder", "cm"];
/** How long an admin ban lasts. */
const BAN_DAYS = 30;

/* ---------------- roles, audit trail and request guards ---------------- */

/**
 * The admin role of a wallet, or null. Wallets in the ADMIN_WALLETS setting are always "owner" (they
 * cannot be demoted from the dashboard); everyone else is looked up in admin_roles. A row holding
 * a value that is not in ROLES counts as no role.
 */
async function adminRoleOf(env, wallet) {
  if (!wallet) return null;
  if (adminWallets(env).includes(wallet)) return "owner";
  const r = await env.DB.prepare("SELECT role FROM admin_roles WHERE wallet = ?").bind(wallet).first();
  return r && ROLES.includes(r.role) ? r.role : null;
}

/**
 * Builds (does not run) the INSERT for one admin_audit row, so a handler can put it in the same
 * db.batch as the change it records. `detail` is cut to 500 characters. Some handlers instead call
 * .run() on it right after the change (they first need the new row's id or a change count), so in
 * those the change and its audit line are two separate writes, not one batch.
 */
function logAudit(db, { actor, action, target = null, detail = null }, now = Date.now()) {
  return db
    .prepare("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(actor, action, target, detail == null ? null : String(detail).slice(0, 500), iso(now));
}

/**
 * Builds the INSERT that notes a row created by the test lab in admin_test (table, id and, for rows
 * with a two-part key, a second id), so test/reset knows exactly which rows it may delete.
 */
const track = (db, table, id, id2 = null) =>
  db.prepare("INSERT INTO admin_test (table_name, row_id, row_id2) VALUES (?, ?, ?)").bind(table, id, id2);

/**
 * Who is calling: { s: session, user: account row, wallet } or null when nobody is signed in or there
 * is no account.
 * One special case: an owner wallet from ADMIN_WALLETS that signed in with its wallet only (no account
 * yet) gets an account created on the spot (provider "wallet", a random handle, audited as
 * admin/bootstrap) and the session is attached to it. That lets the first owner open /admin without
 * going through the normal sign-up. Anyone else without an account gets null.
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
      const r = await db
        .prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (?, 'wallet', ?, ?, ?)")
        .bind(wallet, wallet, await autoUsername(db), iso(now))
        .run();
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
 * The check in front of every route except "me". Returns { res } (an error response to send back as
 * is) or { ctx } (the caller's details for the handler: session, user, wallet, role, db, now, env).
 * Order of the checks: database present (503), signed in (401), role at least `minRole` (403 with
 * `need`), and, when `fresh` is set, a wallet proof from the last POLICY.freshProofMinutes minutes
 * (403 "reprove").
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

/**
 * guard() for routes that change something: the request must also come from this site's own pages
 * (sameSite: a missing or foreign Origin header is refused with 403 "wrong_origin"). Returns a plain
 * object in that case and a promise otherwise, so callers always `await` it.
 */
const postGuard = (request, env, minRole, opts = {}) =>
  !sameSite(request) ? { res: json({ ok: false, error: "wrong_origin" }, 403) } : guard(request, env, minRole, opts);

/**
 * A text value from the query string, cleaned (see cleanText) and at most `max` characters. A value
 * that is missing or too long comes back as "" (it is not shortened).
 */
const q = (url, name, max = 60) => cleanText(url.searchParams.get(name) || "", max) || "";

/** The ?limit= of a list request: a number from 1 up to `max`; `dflt` when it is missing, zero or not a number. */
const limitOf = (url, dflt = 50, max = 200) => Math.min(max, Math.max(1, Number(url.searchParams.get("limit")) || dflt));

/* ---------------- dashboard: me and overview ---------------- */

/**
 * GET me: which wallet is signed in and which admin role it has (null when it has none). Needs only
 * a session, not a role, so the dashboard can tell "not signed in" and "signed in but not staff"
 * apart. It goes through adminCaller, so an owner wallet's account is created here on first visit.
 */
async function handleMe(request, env, now) {
  if (!env.DB) return json({ ok: false, error: "unavailable" }, 503);
  await ensureSchema(env.DB);
  const c = await adminCaller(request, env, now);
  if (!c) return json({ ok: false, error: "sign_in" }, 401);
  return json({ ok: true, wallet: c.wallet, role: await adminRoleOf(env, c.wallet) });
}

/**
 * GET overview: the numbers on the dashboard's front page. People, seats per status, open elections,
 * pending reports (report rows on posts that are still visible, so one post reported three times
 * counts three), open objections, registered tokens, city coins that have a mint, and how many
 * snapshots exist (plus when the latest was created).
 */
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
    db.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM snapshots").first()
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
    latestSnapshot: snaps.latest
  });
}

/* ---------------- users and bans ---------------- */

/**
 * GET users?q=&limit=: the newest accounts first (limit 50 by default, 200 at most). `q` searches
 * wallet, handle and name (a partial match; % and _ are ignored); without it everyone is listed.
 * Each row has a `banned` count: how many site-wide ban rows (country "*") the person has. It does
 * not look at expires_at, so a ban that has run out still counts until its row is removed.
 */
async function handleUsers(ctx, url) {
  const like = `%${q(url, "q", 40).replace(/[%_]/g, "")}%`;
  const rows = (await ctx.db.prepare(
    `SELECT u.id, u.wallet, u.handle, u.name, u.home_name, u.home_country, u.created_at,
            (SELECT COUNT(*) FROM bans b WHERE b.user_id = u.id AND b.country = '*') AS banned
     FROM users u WHERE ? = '%%' OR u.wallet LIKE ? OR u.handle LIKE ? OR u.name LIKE ?
     ORDER BY u.id DESC LIMIT ?`
  ).bind(like, like, like, like, limitOf(url)).all()).results;
  return json({ ok: true, users: rows });
}

/**
 * POST users/ban and users/unban { wallet, reason? }: ban or unban a person site-wide (country "*").
 * A ban lasts BAN_DAYS days and replaces any ban the person already has. You cannot ban or unban
 * yourself ("own_account"); the wallet must belong to an existing account ("not_found").
 * Both directions are audited. Unlike the bans in src/moderation.js this one does not create a
 * mod_actions row, so it has no action_id: it is not in the public log and the person has nothing to
 * appeal (appeals attach to mod_actions rows).
 */
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
      logAudit(ctx.db, { actor: ctx.wallet, action: "users/unban", target: wallet }, now)
    ]);
    return json({ ok: true, unbanned: true });
  }
  const reason = cleanText(body.reason, 200) || "admin";
  await ctx.db.batch([
    ctx.db
      .prepare("INSERT OR REPLACE INTO bans (user_id, country, by_user, reason, created_at, expires_at) VALUES (?, '*', ?, ?, ?, ?)")
      .bind(target.id, ctx.user.id, reason, iso(now), iso(now + BAN_DAYS * DAY)),
    logAudit(ctx.db, { actor: ctx.wallet, action: "users/ban", target: wallet, detail: reason }, now)
  ]);
  return json({ ok: true, banned: true, days: BAN_DAYS });
}

/* ---------------- seats: claims and objections ---------------- */

/**
 * GET seats?status=: founder seats, newest first, at most 200 (?limit is not used here), with the
 * holder's handle, name and wallet. `status` filters on the exact seat status.
 */
async function handleSeats(ctx, url) {
  const status = q(url, "status", 20);
  const rows = (await ctx.db.prepare(
    `SELECT s.id, s.city_id, s.city_name, s.country, s.status, s.created_at, s.activated_at, s.ended_at, s.end_reason,
            u.handle, u.name, u.wallet
     FROM seats s LEFT JOIN users u ON u.id = s.user_id
     ${status ? "WHERE s.status = ?" : ""} ORDER BY s.id DESC LIMIT 200`
  ).bind(...status ? [status] : []).all()).results;
  return json({ ok: true, seats: rows });
}

/**
 * GET claims: applications for a founder seat whose window is still open and that have not been
 * withdrawn, newest first (200 at most), with the applicant, the pitch and the score so far.
 */
async function handleClaims(ctx) {
  const rows = (await ctx.db.prepare(
    `SELECT a.id, a.city_id, a.pitch, a.created_at, a.valid, a.total, a.rank, w.city_name, w.country, w.closes_at,
            u.handle, u.name, u.wallet
     FROM applications a JOIN windows w ON w.id = a.window_id JOIN users u ON u.id = a.user_id
     WHERE a.withdrawn = 0 AND w.status = 'open' ORDER BY a.id DESC LIMIT 200`
  ).all()).results;
  return json({ ok: true, claims: rows });
}

/**
 * POST seats/decide { id, decision: "approve" | "reject" }: an admin's call on one application.
 * Approve sets valid = 1. Reject sets withdrawn = 1, the same flag the applicant sets when they
 * withdraw, so a rejected claim looks withdrawn and cannot be decided again (409 "already_decided").
 * It does not look at whether the window is still open. When src/seats.js closes a window it
 * re-scores every application that is not withdrawn and rewrites `valid` itself.
 */
async function handleSeatDecide(request, ctx) {
  const body = await readJson(request);
  const app = body && await ctx.db.prepare("SELECT * FROM applications WHERE id = ?").bind(Number(body.id) || 0).first();
  if (!app) return json({ ok: false, error: "not_found" }, 404);
  if (app.withdrawn) return json({ ok: false, error: "already_decided" }, 409);
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) return json({ ok: false, error: "bad_decision" }, 400);
  await ctx.db.batch([
    ctx.db
      .prepare(decision === "approve" ? "UPDATE applications SET valid = 1 WHERE id = ?" : "UPDATE applications SET withdrawn = 1 WHERE id = ?")
      .bind(app.id),
    logAudit(ctx.db, { actor: ctx.wallet, action: "seats/decide", target: `application:${app.id}`, detail: decision }, ctx.now)
  ]);
  return json({ ok: true, decision });
}

/**
 * GET objections?status=: objections people filed against a founder seat, newest first (200 at most),
 * with the seat's city and the objector's handle and name. Only open ones, unless ?status=all.
 */
async function handleObjections(ctx, url) {
  const only = url.searchParams.get("status") === "all" ? "" : "WHERE o.status = 'open'";
  const rows = (await ctx.db.prepare(
    `SELECT o.id, o.reason, o.created_at, o.status, s.city_name, s.country, s.status AS seat_status,
            u.handle, u.name FROM objections o
     JOIN seats s ON s.id = o.seat_id JOIN users u ON u.id = o.user_id
     ${only} ORDER BY o.id DESC LIMIT 200`
  ).all()).results;
  return json({ ok: true, objections: rows });
}

/**
 * POST objections/decide { id, uphold: true | false, note? }: decide an open objection. Upholding
 * marks it "upheld" and revokes the seat at once (end_reason "objection_upheld"; only a seat that is
 * provisional, active, grace or steward is touched). Anything else dismisses it. Audited with the note.
 * Compared with the same decision in src/seats.js (handleDecideObjection), this one is open to
 * moderators (seats.js: only ADMIN_WALLETS), needs no fresh wallet proof, does not stop the person who
 * filed the objection from deciding it, writes only to admin_audit (not to mod_actions), does not close
 * the seat's other open objections, and does not offer the seat to the next applicant.
 */
async function handleObjectionDecide(request, ctx) {
  const body = await readJson(request);
  const o = body && await ctx.db.prepare("SELECT * FROM objections WHERE id = ? AND status = 'open'").bind(Number(body.id) || 0).first();
  if (!o) return json({ ok: false, error: "not_found" }, 404);
  const uphold = body.uphold === true;
  const note = cleanText(body.note, 300);
  const stmts = [
    ctx.db
      .prepare("UPDATE objections SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?")
      .bind(uphold ? "upheld" : "dismissed", ctx.user.id, iso(ctx.now), note, o.id)
  ];
  if (uphold) stmts.push(ctx.db.prepare(
    "UPDATE seats SET status = 'revoked', ended_at = ?, end_reason = 'objection_upheld' WHERE id = ? AND status IN ('provisional', 'active', 'grace', 'steward')"
  ).bind(iso(ctx.now), o.seat_id));
  stmts.push(logAudit(ctx.db, { actor: ctx.wallet, action: "objections/decide", target: `objection:${o.id}`, detail: `${uphold ? "upheld" : "dismissed"}${uphold ? " (seat revoked)" : ""}${note ? " — " + note : ""}` }, ctx.now));
  await ctx.db.batch(stmts);
  return json({ ok: true, upheld: uphold });
}

/* ---------------- elections ---------------- */

/** GET elections: the 100 newest country elections, every column plus how many votes each has. */
async function handleElections(ctx) {
  const rows = (await ctx.db.prepare(
    `SELECT e.*, (SELECT COUNT(*) FROM election_votes v WHERE v.election_id = e.id) AS votes
     FROM elections e ORDER BY e.id DESC LIMIT 100`
  ).all()).results;
  return json({ ok: true, elections: rows });
}

/**
 * POST elections/create { country, seats, closesInDays }: open a country election. `country` is a
 * two-letter code, `seats` 1 to 10, `closesInDays` 1 to 90. Only one election per country can be open
 * (409 "already_open"). The election row stores the country, the policy version and the dates;
 * `seats` is only echoed back and written to the audit line, it is not stored on the election.
 */
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
  const r = await ctx.db
    .prepare("INSERT INTO elections (country, policy, opened_at, closes_at, status) VALUES (?, ?, ?, ?, 'open')")
    .bind(country, POLICY.version, iso(ctx.now), closesAt)
    .run();
  const id = r.meta.last_row_id;
  await logAudit(ctx.db, { actor: ctx.wallet, action: "elections/create", target: `election:${id}`, detail: `${country}, ${seats} seat(s), closes ${closesAt}` }, ctx.now).run();
  return json({ ok: true, id, country, seats, closesAt });
}

/* ---------------- tokens ---------------- */

/**
 * GET tokens: the hand-kept registry (admin_tokens, newest first), the city coins that have been
 * minted (src/coins.js), and the official token list from src/official.js.
 */
async function handleTokens(ctx) {
  const registered = (await ctx.db.prepare("SELECT * FROM admin_tokens ORDER BY created_at DESC LIMIT 200").all()).results;
  const cityCoins = (await ctx.db.prepare(
    "SELECT city_id, city_name, country, name, mint, launched_at FROM city_coins WHERE mint IS NOT NULL ORDER BY launched_at DESC LIMIT 200"
  ).all()).results;
  return json({ ok: true, registered, cityCoins, official: OFFICIAL.tokens || [] });
}

/**
 * POST tokens/register { mint, city, founderWallet?, platform? }: write a token's mint address into the
 * registry. `mint` (and `founderWallet`, when given) must look like Solana addresses, `city` is up to 80
 * characters, `platform` is raydium, launchlab, jupiter or other (anything else becomes "other"). A mint
 * can be registered once (409 "already_registered"). It is a record only: nothing is checked on chain,
 * and no other code in the Worker reads this table.
 */
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
      ctx.db
        .prepare("INSERT INTO admin_tokens (mint, city, founder_wallet, platform, registered_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(mint, city, founderWallet, platform, ctx.wallet, iso(ctx.now)),
      logAudit(ctx.db, { actor: ctx.wallet, action: "tokens/register", target: mint, detail: `${city} via ${platform}` }, ctx.now)
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return json({ ok: false, error: "already_registered" }, 409);
    throw e;
  }
  return json({ ok: true, mint, city, platform });
}

/* ---------------- reports and appeals ---------------- */

/**
 * GET reports: posts that people reported and that are still visible (hidden = 0), most recently
 * reported first (100 at most), one row per post with the report count, the time of the last report
 * and one of the reasons (MAX over the reason text, so it is the alphabetically last one, not the
 * most common). A post that is already hidden, for example one the community reports auto-hid, is
 * not listed.
 */
async function handleReports(ctx) {
  const rows = (await ctx.db.prepare(
    `SELECT p.id AS post_id, p.body, p.kind, p.scope, p.place, p.country, p.created_at, u.handle, u.name,
            COUNT(r.user_id) AS reports, MAX(r.created_at) AS last_report, MAX(r.reason) AS reason
     FROM reports r JOIN posts p ON p.id = r.post_id JOIN users u ON u.id = p.user_id
     WHERE p.hidden = 0 GROUP BY p.id ORDER BY last_report DESC LIMIT 100`
  ).all()).results;
  return json({ ok: true, reports: rows });
}

/**
 * POST reports/decide { id: post id, action: "hide" | "dismiss", note? }.
 * Hide: the post is hidden and confirmed for good in one step (hidden_until cleared), so the usual
 * 24-hour / second-moderator rule from src/moderation.js does not apply to it.
 * Dismiss: every report row on the post is deleted (the posts.reports counter is left alone).
 * Neither writes a mod_actions row, so neither appears in the public log; both are in admin_audit.
 */
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
      logAudit(ctx.db, { actor: ctx.wallet, action: "reports/hide", target: `post:${postId}`, detail: note }, ctx.now)
    ]);
    return json({ ok: true, hidden: true });
  }
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM reports WHERE post_id = ?").bind(postId),
    logAudit(ctx.db, { actor: ctx.wallet, action: "reports/dismiss", target: `post:${postId}`, detail: note }, ctx.now)
  ]);
  return json({ ok: true, dismissed: true });
}

/** GET appeals: open appeals (100 at most, newest first), every appeals column plus the appellant's handle and name. */
async function handleAppeals(ctx) {
  const rows = (await ctx.db.prepare(
    `SELECT ap.*, u.handle, u.name FROM appeals ap JOIN users u ON u.id = ap.user_id
     WHERE ap.status = 'open' ORDER BY ap.id DESC LIMIT 100`
  ).all()).results;
  return json({ ok: true, appeals: rows });
}

/**
 * POST appeals/decide { id, decision: "uphold" | "reject", note? }. Here "uphold" means the APPEAL
 * succeeds: the appeal is marked "upheld" and every ban row with the appealed action's action_id is
 * deleted. "reject" marks it "rejected" and leaves everything as it was. Note that src/moderation.js
 * uses the word the other way round ("upheld" = the original action stands, "overturned" = the appeal
 * won). This handler does not touch mod_actions or the post, so appealing a hide changes only the
 * appeal's own status.
 */
async function handleAppealDecide(request, ctx) {
  const body = await readJson(request);
  const ap = body && await ctx.db.prepare("SELECT * FROM appeals WHERE id = ? AND status = 'open'").bind(Number(body.id) || 0).first();
  if (!ap) return json({ ok: false, error: "not_found" }, 404);
  const decision = body.decision === "uphold" ? "uphold" : body.decision === "reject" ? "reject" : null;
  if (!decision) return json({ ok: false, error: "bad_decision" }, 400);
  const note = cleanText(body.note, 300);
  const stmts = [ctx.db.prepare("UPDATE appeals SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?").bind(decision === "uphold" ? "upheld" : "rejected", ctx.user.id, iso(ctx.now), note, ap.id)];
  if (decision === "uphold") stmts.push(ctx.db.prepare("DELETE FROM bans WHERE action_id = ?").bind(ap.action_id));
  stmts.push(logAudit(ctx.db, { actor: ctx.wallet, action: "appeals/decide", target: `appeal:${ap.id}`, detail: decision }, ctx.now));
  await ctx.db.batch(stmts);
  return json({ ok: true, decision });
}

/* ---------------- snapshots ---------------- */

/** GET snapshots: the 50 newest supporter snapshots (src/snapshot.js) with their status, size and dates. */
async function handleSnapshots(ctx) {
  const rows = (await ctx.db.prepare(
    "SELECT id, cutoff_at, status, holders, total, created_at, activates_at, note FROM snapshots ORDER BY id DESC LIMIT 50"
  ).all()).results;
  return json({ ok: true, snapshots: rows });
}

/**
 * POST snapshots/create { cutoff }: add a snapshot row by hand. `cutoff` is a date/time (up to 32
 * characters) that is not more than an hour in the future; past dates are fine. The row is a
 * placeholder: status "provisional", 0 holders, 0 total, 0 samples, and the text "admin-manual" in
 * place of the input hash and Merkle root. activates_at is the cutoff plus 7 days. No holder data is
 * computed here (the note says so). The scheduled job in src/snapshot.js turns any provisional
 * snapshot whose activates_at has passed into "active", and it skips computing the scheduled
 * snapshot when a non-cancelled row with the same cutoff already exists.
 */
async function handleSnapshotCreate(request, ctx) {
  const body = await readJson(request);
  const cutoff = cleanText(body && body.cutoff, 32);
  const at = cutoff && Date.parse(cutoff);
  if (!at || Number.isNaN(at)) return json({ ok: false, error: "bad_cutoff" }, 400);
  if (at > ctx.now + 36e5) return json({ ok: false, error: "cutoff_future" }, 400);
  const r = await ctx.db.prepare(
    `INSERT INTO snapshots (cutoff_at, policy, created_at, status, activates_at, holders, total, samples, input_hash, merkle_root, note)
     VALUES (?, ?, ?, 'provisional', ?, 0, 0, 0, 'admin-manual', 'admin-manual', ?)`
  ).bind(
    new Date(at).toISOString(),
    POLICY.version,
    iso(ctx.now),
    new Date(at + 7 * DAY).toISOString(),
    "Created from the admin dashboard; holder data not computed yet."
  ).run();
  const id = r.meta.last_row_id;
  await logAudit(ctx.db, { actor: ctx.wallet, action: "snapshots/create", target: `snapshot:${id}`, detail: `cutoff ${new Date(at).toISOString()}` }, ctx.now).run();
  return json({ ok: true, id });
}

/* ---------------- config, roles and audit trail ---------------- */

/**
 * GET config: a safe summary of the setup. The site mode (SITE_MODE, "live" when unset), the policy
 * version, which settings are present (true / false only, never their values), and how many granted
 * roles and audit rows there are. It lists the Google, X, mint, RPC, admin-wallet and snapshot
 * settings; it does not list the e-mail settings used by src/mail.js.
 */
async function handleConfig(ctx) {
  const env = ctx.env;
  const [roles, audit] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM admin_roles").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit").first()
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
      SNAPSHOT_CUTOFF: Boolean(env.SNAPSHOT_CUTOFF)
    },
    grantedRoles: roles.n,
    auditRows: audit.n
  });
}

/**
 * GET roles: granted roles (admin_roles, newest first) plus the owners that come from the
 * ADMIN_WALLETS setting (source "env", which cannot be changed from here).
 */
async function handleRoles(ctx) {
  const rows = (await ctx.db.prepare("SELECT wallet, role, granted_by, granted_at FROM admin_roles ORDER BY granted_at DESC").all()).results;
  const envOwners = adminWallets(ctx.env).map((w) => ({ wallet: w, role: "owner", source: "env" }));
  return json({ ok: true, roles: rows.map((r) => ({ ...r, source: "granted" })), envOwners });
}

/**
 * POST roles/grant { wallet, role }: give a wallet the role moderator, admin or owner (replacing any
 * role it already had). The wallet does not need an account yet. You cannot change your own role
 * ("own_account").
 */
async function handleRoleGrant(request, ctx) {
  const body = await readJson(request);
  const wallet = body && body.wallet;
  const role = body && body.role;
  if (!isSolanaAddress(wallet)) return json({ ok: false, error: "bad_wallet" }, 400);
  if (!["moderator", "admin", "owner"].includes(role)) return json({ ok: false, error: "bad_role" }, 400);
  if (wallet === ctx.wallet) return json({ ok: false, error: "own_account" }, 400);
  await ctx.db.batch([
    ctx.db
      .prepare("INSERT OR REPLACE INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, ?, ?, ?)")
      .bind(wallet, role, ctx.wallet, iso(ctx.now)),
    logAudit(ctx.db, { actor: ctx.wallet, action: "roles/grant", target: wallet, detail: role }, ctx.now)
  ]);
  return json({ ok: true, wallet, role });
}

/**
 * POST roles/revoke { wallet }: delete a granted role (404 "not_found" when the wallet has none).
 * This never removes an owner that comes from ADMIN_WALLETS: adminRoleOf() always gives them "owner",
 * whatever is in admin_roles. You cannot revoke your own role ("own_account").
 */
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

/** GET audit?limit=: the admin audit trail, newest first (100 rows by default, 500 at most). */
async function handleAudit(ctx, url) {
  const rows = (await ctx.db.prepare("SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?").bind(limitOf(url, 100, 500)).all()).results;
  return json({ ok: true, audit: rows });
}

/* ---------------- test lab ---------------- */

/**
 * The wallet address given to test user number i: "TestLab", two digits, then 35 ones. The text is
 * not valid base58 (it has "0" and "l"), so isSolanaAddress() rejects it and the dashboard's
 * wallet-based actions (ban, role grant) cannot be pointed at a test user.
 */
const seedAddr = (i) => `TestLab${String(i).padStart(2, "0")}${"1".repeat(35)}`;

/**
 * POST test/seed: add a small, clearly marked set of fake data to the database the Worker is
 * connected to: 8 users (provider "testlab", handles @testlab0 to @testlab7, home city "Testville",
 * country XX), 3 seats in fake cities (active, steward, grace), 5 posts ("[TESTLAB seed] ... safe to
 * delete"), 2 reports, 1 objection and 1 open election for country XX. Every row it creates is noted
 * in admin_test so that test/reset can remove exactly these. Only one seed at a time (409
 * "already_seeded").
 */
async function handleTestSeed(ctx) {
  const { db, now } = ctx;
  if ((await db.prepare("SELECT COUNT(*) AS n FROM admin_test").first()).n)
    return json({ ok: false, error: "already_seeded" }, 409);
  const at = iso(now);
  const userIds = [];
  for (let i = 0; i < 8; i++) {
    const r = await db.prepare(
      "INSERT INTO users (wallet, provider, provider_id, handle, name, home_city, home_name, home_country, created_at) VALUES (?, 'testlab', ?, ?, ?, 'testlab-nyc', 'Testville', 'XX', ?)"
    ).bind(seedAddr(i), `seed-${i}`, `@testlab${i}`, `Test Lab ${i}`, at).run();
    userIds.push(r.meta.last_row_id);
    await track(db, "users", r.meta.last_row_id).run();
  }
  const cities = [["testlab-nyc", "Testville"], ["testlab-la", "Mockburg"], ["testlab-chi", "Faketown"]];
  const statuses = ["active", "steward", "grace"];
  const seatIds = [];
  for (let i = 0; i < 3; i++) {
    const r = await db.prepare(
      "INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at) VALUES (?, ?, 'XX', ?, ?, 5, 0.5, ?, ?)"
    ).bind(cities[i][0], cities[i][1], userIds[i], seedAddr(i), statuses[i], at).run();
    seatIds.push(r.meta.last_row_id);
    await track(db, "seats", r.meta.last_row_id).run();
  }
  const postIds = [];
  for (let i = 0; i < 5; i++) {
    const r = await db.prepare(
      "INSERT INTO posts (user_id, scope, place, country, kind, body, created_at) VALUES (?, 'city', 'testlab-nyc', 'XX', 'meme', ?, ?)"
    ).bind(userIds[i % 8], `[TESTLAB seed] test post ${i + 1} — safe to delete`, at).run();
    postIds.push(r.meta.last_row_id);
    await track(db, "posts", r.meta.last_row_id).run();
  }
  for (const [pi, ui] of [[0, 6], [1, 7]]) {
    await db.prepare("INSERT OR IGNORE INTO reports (post_id, user_id, reason, created_at) VALUES (?, ?, 'spam', ?)").bind(postIds[pi], userIds[ui], at).run();
    await track(db, "reports", postIds[pi], userIds[ui]).run();
  }
  const or = await db.prepare("INSERT INTO objections (seat_id, user_id, reason, created_at) VALUES (?, ?, 'testlab objection', ?)").bind(seatIds[1], userIds[3], at).run();
  await track(db, "objections", or.meta.last_row_id).run();
  const er = await db.prepare("INSERT INTO elections (country, policy, opened_at, closes_at, status) VALUES ('XX', 5, ?, ?, 'open')").bind(at, iso(now + 7 * DAY)).run();
  await track(db, "elections", er.meta.last_row_id).run();
  await logAudit(db, { actor: ctx.wallet, action: "test/seed", detail: "8 users, 3 seats, 5 posts, 2 reports, 1 objection, 1 election" }, now).run();
  return json({ ok: true, seeded: { users: 8, seats: 3, posts: 5, reports: 2, objections: 1, elections: 1 } });
}

/**
 * The order test/reset deletes tracked rows in (rows that point at others first, users last), and the
 * DELETE for each table. The reports DELETE needs both ids (post and user); the others need one.
 */
const RESET_ORDER = ["reports", "objections", "posts", "seats", "elections", "users"];
const resetSql = {
  reports: "DELETE FROM reports WHERE post_id = ? AND user_id = ?",
  objections: "DELETE FROM objections WHERE id = ?",
  posts: "DELETE FROM posts WHERE id = ?",
  seats: "DELETE FROM seats WHERE id = ?",
  elections: "DELETE FROM elections WHERE id = ?",
  users: "DELETE FROM users WHERE id = ?"
};

/**
 * POST test/reset { confirm: "RESET" }: delete exactly the rows listed in admin_test (see
 * handleTestSeed), in RESET_ORDER, then empty admin_test and audit how many rows went. Anything else
 * that refers to the test users (sessions, votes, rows made while trying things out) is not
 * removed.
 */
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

/**
 * POST test/preview-role { role }: set the "preview the site as" cookie (vicinity_preview_role, 30
 * days, HttpOnly) to visitor, holder, founder or cm, or clear it with role: null. The change is
 * audited. Nothing else in the recovered Worker code or site files reads this cookie, so what it is
 * meant to switch is unclear.
 */
async function handlePreviewRole(request, ctx) {
  const body = await readJson(request);
  const role = body && body.role;
  if (role !== null && !PREVIEW_ROLES.includes(role)) return json({ ok: false, error: "bad_role" }, 400);
  await logAudit(ctx.db, { actor: ctx.wallet, action: "test/preview-role", detail: role || "cleared" }, ctx.now).run();
  const set = role === null ? clearCookie(PREVIEW_COOKIE) : cookie(PREVIEW_COOKIE, role, 30 * DAY / 1e3);
  return json({ ok: true, previewRole: role }, 200, { "Set-Cookie": set });
}

/* ---------------- router ---------------- */

/**
 * Entry point for everything under /api/admin/ (called from src/index.js). Picks the handler from the
 * path after /api/admin/ and runs it behind the right guard: the method is checked first (405
 * "method_not_allowed"), then the guard for the route (see the table at the top), then the handler.
 * An unknown path gives 404 "not_found".
 * Helpers inside: only(m) answers 405 unless the method is m; need() / needPost() build the guard
 * for a read / write route; run(guard, fn) sends the guard's error or calls fn with the caller's context.
 */
export async function handleAdmin(request, env, now = Date.now()) {
  const url = new URL(request.url);
  const method = request.method;
  const rel = url.pathname.replace(/^\/api\/admin\/?/, "");
  const only = (m) => method === m ? null : json({ ok: false, error: "method_not_allowed" }, 405);
  const need = (minRole, opts) => guard(request, env, minRole, { ...opts, now });
  const needPost = (minRole, opts) => postGuard(request, env, minRole, { ...opts, now });
  const run = async (g, fn) => {
    const r = await g;
    return r.res || fn(r.ctx);
  };
  switch (rel) {
    case "me": {
      const b = only("GET");
      return b || handleMe(request, env, now);
    }
    case "overview": {
      const b = only("GET");
      return b || run(need("moderator"), handleOverview);
    }
    case "users": {
      const b = only("GET");
      return b || run(need("moderator"), (c) => handleUsers(c, url));
    }
    case "users/ban": {
      const b = only("POST");
      return b || run(await needPost("admin", { fresh: true }), (c) => handleBan(request, c, false));
    }
    case "users/unban": {
      const b = only("POST");
      return b || run(await needPost("admin"), (c) => handleBan(request, c, true));
    }
    case "seats": {
      const b = only("GET");
      return b || run(need("moderator"), (c) => handleSeats(c, url));
    }
    case "claims": {
      const b = only("GET");
      return b || run(need("moderator"), handleClaims);
    }
    case "seats/decide": {
      const b = only("POST");
      return b || run(await needPost("admin"), (c) => handleSeatDecide(request, c));
    }
    case "objections": {
      const b = only("GET");
      return b || run(need("moderator"), (c) => handleObjections(c, url));
    }
    case "objections/decide": {
      const b = only("POST");
      return b || run(await needPost("moderator"), (c) => handleObjectionDecide(request, c));
    }
    case "elections": {
      const b = only("GET");
      return b || run(need("moderator"), handleElections);
    }
    case "elections/create": {
      const b = only("POST");
      return b || run(await needPost("admin"), (c) => handleElectionCreate(request, c));
    }
    case "tokens": {
      const b = only("GET");
      return b || run(need("moderator"), handleTokens);
    }
    case "tokens/register": {
      const b = only("POST");
      return b || run(await needPost("admin"), (c) => handleTokenRegister(request, c));
    }
    case "reports": {
      const b = only("GET");
      return b || run(need("moderator"), handleReports);
    }
    case "reports/decide": {
      const b = only("POST");
      return b || run(await needPost("moderator"), (c) => handleReportDecide(request, c));
    }
    case "appeals": {
      const b = only("GET");
      return b || run(need("moderator"), handleAppeals);
    }
    case "appeals/decide": {
      const b = only("POST");
      return b || run(await needPost("admin"), (c) => handleAppealDecide(request, c));
    }
    case "snapshots": {
      const b = only("GET");
      return b || run(need("moderator"), handleSnapshots);
    }
    case "snapshots/create": {
      const b = only("POST");
      return b || run(await needPost("admin"), (c) => handleSnapshotCreate(request, c));
    }
    case "config": {
      const b = only("GET");
      return b || run(need("admin"), (c) => handleConfig({ ...c, env }));
    }
    case "roles": {
      const b = only("GET");
      return b || run(need("owner"), (c) => handleRoles({ ...c, env }));
    }
    case "roles/grant": {
      const b = only("POST");
      return b || run(await needPost("owner", { fresh: true }), (c) => handleRoleGrant(request, c));
    }
    case "roles/revoke": {
      const b = only("POST");
      return b || run(await needPost("owner", { fresh: true }), (c) => handleRoleRevoke(request, c));
    }
    case "audit": {
      const b = only("GET");
      return b || run(need("moderator"), (c) => handleAudit(c, url));
    }
    case "test/seed": {
      const b = only("POST");
      return b || run(await needPost("owner"), handleTestSeed);
    }
    case "test/reset": {
      const b = only("POST");
      return b || run(await needPost("owner", { fresh: true }), (c) => handleTestReset(request, c));
    }
    case "test/preview-role": {
      const b = only("POST");
      return b || run(await needPost("owner"), (c) => handlePreviewRole(request, c));
    }
    default:
      return json({ ok: false, error: "not_found" }, 404);
  }
}
