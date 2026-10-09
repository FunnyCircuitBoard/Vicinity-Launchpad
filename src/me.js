/**
 * The dashboard's data, recomputed from live data on every call (the page asks every minute).
 *
 *   GET  /api/me          → who you are, your live position, roles, badges, your founder path,
 *                           your city's seat / application window, your country's manager / election
 *   GET  /api/me?lite=1   → just who you are (for the header on every page)
 *   POST /api/home        → set your home community from a location attestation (never the location)
 */
import { json, readJson } from "./http.js";
import { cleanEmail, consumeEmailCode, getSession, isFresh, providers, validEmail } from "./auth.js";
import { access } from "./access.js";
import { countRecent, noteEvent, useAttestation } from "./attest.js";
import { activeMint } from "./official.js";
import { getHolding, holderSnapshot, isTeamWallet, rankOf } from "./chain.js";
import { DAY, HOUR, POLICY, iso } from "./policy.js";
import { VOTE_WEIGHT, activeBan, adminWallets, amountsFor, liveSeatOfUser, managerOf } from "./roles.js";
import { cityPicture, cooldownUntil, eligibility, squadPicture } from "./seats.js";
import { countryPicture } from "./elections.js";
import { ensureProfilesSchema, ensureSchema } from "./store.js";
import { communityById } from "./community.js";
import { tickerOf } from "./tickers.js";
import { latestBalances } from "./ledger.js";
import { dashboardV2On, profilesOn, v2On } from "./flags.js";
import { countsOf } from "./profile-core.js";

const HOME_LOCK_DAYS = 7; // a home community can be changed once a week
const mask = (w) => (w ? `${w.slice(0, 5)}*****${w.slice(-3)}` : null);

export const publicUser = (u) => ({
  id: u.id, wallet: u.wallet, provider: u.provider, handle: u.handle, name: u.name,
  contact_email: u.contact_email || null, phone: u.phone || null,
  home: u.home_city ? { id: u.home_city, name: u.home_name, country: u.home_country, since: u.home_at } : null,
  joined: u.created_at,
});

/** Badges that depend on holding: these can be lost by selling. */
const HOLDING_BADGES = new Set(["holder", "founder_ready", "whale", "top100", "top10", "city_founder", "country_manager"]);

export function badgesFor({ u, launched, amount, position, seat, manager, admin, checkins, posts, tenure, threshold }) {
  const pct = (v, of) => Math.max(0, Math.min(1, v / of));
  const T = threshold || POLICY.founder.ladder.base;
  const list = [
    { id: "early", icon: "🌱", name: "Early member", detail: "Joined before $VICINITY launched. This one can never be earned again.", earned: Boolean(u.early) },
    { id: "verified", icon: "✅", name: "Verified account", detail: "A verified Google login or e-mail.", earned: true },
    { id: "wallet", icon: "🔗", name: "Wallet linked", detail: "A Solana wallet linked to your account with one free signature. It unlocks holdings, rank, badges and the founder path.", earned: Boolean(u.wallet) },
    { id: "local", icon: "📍", name: "Local", detail: "Home community confirmed by location.", earned: Boolean(u.home_city) },
    { id: "holder", icon: "🏅", name: "Holder", detail: launched ? "Hold any $VICINITY." : "Hold $VICINITY once it launches.", earned: amount > 0, progress: amount > 0 ? 1 : 0 },
    { id: "founder_ready", icon: "🔑", name: "Founder-ready", detail: `Held ${T.toLocaleString("en-US")}+ $VICINITY for ${POLICY.founder.qualifyingDays} days: may apply to found your city.`,
      earned: Boolean(tenure && tenure.qualified && amount >= T), progress: tenure ? pct(tenure.days, tenure.needed) : 0 },
    { id: "whale", icon: "🐋", name: "Big holder", detail: "Hold 10,000,000+ $VICINITY.", earned: amount >= 10_000_000, progress: pct(amount, 10_000_000) },
    { id: "top100", icon: "💯", name: "Top 100", detail: "One of the 100 biggest holders (pools and team wallets not counted).", earned: Boolean(position?.rank && position.rank <= 100) },
    { id: "top10", icon: "🏆", name: "Top 10", detail: "One of the 10 biggest holders (pools and team wallets not counted).", earned: Boolean(position?.rank && position.rank <= 10) },
    { id: "city_founder", icon: "👑", name: seat && seat.status === "steward" ? "Seed Steward" : "City Founder",
      detail: seat && seat.status === "grace" ? "In grace: hold the founder amount again to keep the seat."
        : seat && seat.status === "steward" ? "Founded your city first and is on probation: confirmed after 90 days or when 50 verified local holders back it."
        : "Chosen by your city and still holding the founder amount.",
      earned: Boolean(seat && ["active", "grace", "steward"].includes(seat.status)), grace: Boolean(seat && seat.status === "grace") },
    { id: "country_manager", icon: "🛡️", name: "Country Manager", detail: "Elected by your country for 90 days.", earned: manager },
    { id: "voice", icon: "💬", name: "Local voice", detail: "Posted in your city or country feed.", earned: posts > 0 },
    { id: "streak", icon: "🔥", name: "On the streets", detail: "Checked in on 3 different days.", earned: checkins >= 3, progress: pct(checkins, 3) },
  ];
  if (admin) list.unshift({ id: "admin", icon: "⚙️", name: "Admin", detail: "Runs Vicinity, within the published rules.", earned: true });
  return list;
}


/**
 * A community's (or country's) holders, ranked (team wallets are not ranked: ranks are for people, as on the token page).
 * Building it reads every member and looks up every balance, so it's
 * built once per holder snapshot (about a minute) and shared by everyone's dashboard: a launch-week crowd asking every
 * minute costs one ranking, not one per person. The member count is asked every time (cheap), and a change in it
 * (someone joined) builds a fresh ranking.
 */
const rankings = new WeakMap(); // holder snapshot → Map("column:value:members" → [[wallet, amount], …] biggest first)
async function leaderboard(env, column, value, snap, fetchImpl) {
  const members = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${column} = ? AND provider != 'testlab'`).bind(value).first())?.n || 0;
  let list = null;
  if (snap) {
    let byKey = rankings.get(snap);
    if (!byKey) rankings.set(snap, (byKey = new Map()));
    const key = `${column}:${value}:${members}`;
    if (!byKey.has(key)) {
      const wallets = (await env.DB.prepare(`SELECT wallet FROM users WHERE ${column} = ? AND provider != 'testlab' AND wallet IS NOT NULL LIMIT 20000`).bind(value).all()).results.map((r) => r.wallet);
      const amounts = await amountsFor(env, wallets, fetchImpl);
      byKey.set(key, wallets.map((w) => [w, amounts.get(w) || 0]).filter(([w, a]) => a > 0 && !isTeamWallet(w)).sort((a, b) => b[1] - a[1]));
    }
    list = byKey.get(key);
  }
  return { members, list };
}

async function liveStatus(env, s, fetchImpl, now) {
  const u = s.user, db = env.DB;
  // An account without a wallet (onboarding v3: the wallet is linked later, from the dashboard) holds nothing, ranks nowhere and
  // can be nobody's admin: no blockchain look at all for it. The leaderboards below skip such members too.
  const mint = activeMint(env), launched = Boolean(mint), wallet = u.wallet || null, team = Boolean(wallet) && isTeamWallet(wallet);
  let snap = null, chain = launched ? "live" : "prelaunch";
  if (launched) { try { snap = await holderSnapshot(env, mint, fetchImpl); } catch { chain = "partial"; } }
  let amount = 0, position = null;
  if (!wallet) { /* nothing to look up */ }
  else if (snap) { position = rankOf(snap, wallet); amount = position.amount; }
  else if (launched) { try { amount = await getHolding(env, wallet, mint, fetchImpl); } catch { chain = "unavailable"; } }

  const admin = Boolean(wallet) && adminWallets(env).includes(wallet);
  const seat = await liveSeatOfUser(db, u.id);
  const mgr = seat && seat.status === "active" ? await managerOf(env, seat.country, now) : null;
  const isManager = Boolean(mgr && mgr.userId === u.id);
  const founderLive = Boolean(seat && (seat.status === "active" || seat.status === "steward")); // a steward has a founder's powers
  const level = admin ? "admin" : isManager ? "manager" : founderLive ? "founder" : amount > 0 ? "holder" : "member";
  const ban = await activeBan(db, u.id, u.home_country, now);
  const appealed = ban && ban.action_id ? await db.prepare("SELECT id FROM appeals WHERE action_id = ?").bind(ban.action_id).first() : null;

  // the founder path
  const elig = await eligibility(env, u, now, fetchImpl);
  const app = await db.prepare("SELECT a.id, a.window_id, a.city_id, a.created_at, w.closes_at FROM applications a JOIN windows w ON w.id = a.window_id WHERE a.user_id = ? AND a.withdrawn = 0 AND w.status = 'open'").bind(u.id).first();
  const founder = {
    threshold: elig.threshold, tenure: elig.tenure, amount, eligible: elig.ok, why: elig.ok ? null : elig.error, whyNot: elig.whyNot || null,
    // a qualified local may challenge a Seed Steward during probation (needs 10 local endorsements to force an election)
    challenging: elig.ok && elig.challenging ? { seatId: elig.challenging } : null,
    homeReadyAt: elig.homeReadyAt, cooldownUntil: elig.cooldownUntil || (await cooldownUntil(db, u.id, now)),
    application: app ? { id: app.id, windowId: app.window_id, cityId: app.city_id, since: app.created_at, closesAt: app.closes_at } : null,
    seat: seat ? { id: seat.id, cityId: seat.city_id, city: seat.city_name, country: seat.country, status: seat.status, since: seat.activated_at || seat.created_at,
      appealUntil: seat.appeal_until, graceUntil: seat.grace_until, probationUntil: seat.probation_until, threshold: seat.threshold, policy: seat.policy } : null,
  };

  // your community and your country: members, where you rank among them
  const ranked = (board) => {
    if (!launched || !snap || !board.list) return { rank: null, holders: null, top: [] };
    if (!wallet) return { rank: null, holders: board.list.length, top: board.list.slice(0, 5).map(([w, a]) => ({ wallet: mask(w), amount: a, you: false })) };
    const i = board.list.findIndex(([w]) => w === wallet);
    return { rank: i >= 0 ? i + 1 : null, holders: board.list.length, top: board.list.slice(0, 5).map(([w, a]) => ({ wallet: mask(w), amount: a, you: w === wallet })) };
  };
  let community = null, national = null;
  if (u.home_city) {
    const board = await leaderboard(env, "home_city", u.home_city, snap, fetchImpl);
    // "you are member #N here": people (not test-lab rows) who made this community their home before or with this account
    const nth = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE home_city = ? AND id <= ? AND provider != 'testlab'").bind(u.home_city, u.id).first();
    community = { id: u.home_city, name: u.home_name, country: u.home_country, ticker: (await tickerOf(env, u.home_city))?.ticker || null,
      members: board.members, memberNumber: nth ? Number(nth.n) : null, ...ranked(board), ...(await cityPicture(env, u.home_city, u, now, fetchImpl)) };
  }
  if (u.home_country) {
    const board = await leaderboard(env, "home_country", u.home_country, snap, fetchImpl);
    national = { country: u.home_country, members: board.members, ...ranked(board), ...(await countryPicture(env, u.home_country, u, now)) };
  }

  const act = await db.prepare(
    "SELECT COUNT(*) AS posts, COUNT(DISTINCT CASE WHEN kind = 'checkin' THEN substr(created_at, 1, 10) END) AS days FROM posts WHERE user_id = ? AND hidden = 0",
  ).bind(u.id).first();
  const badges = badgesFor({ u, launched, amount, position, seat, manager: isManager, admin, checkins: act?.days || 0, posts: act?.posts || 0, tenure: elig.tenure, threshold: elig.threshold });
  const earned = badges.filter((b) => b.earned).map((b) => b.id);
  let lost = [];
  try { lost = JSON.parse(u.badges || "[]").filter((id) => HOLDING_BADGES.has(id) && !earned.includes(id)); } catch {}
  if (team) lost = lost.filter((id) => id !== "top10" && id !== "top100"); // not ranked, so not a top holder: nothing was sold
  if (JSON.stringify(earned) !== (u.badges || "")) await db.prepare("UPDATE users SET badges = ? WHERE id = ?").bind(JSON.stringify(earned), u.id).run();

  // progress towards founding your home city
  const days = elig.tenure ? Math.floor(elig.tenure.days) : 0;
  const steps = [
    { id: "account", label: u.wallet ? "Account verified, wallet linked" : "Link a wallet", done: Boolean(u.wallet) },
    { id: "home", label: u.home_city ? `Home: ${u.home_name} (${POLICY.founder.localDays} days before applying)` : "Set your home community",
      done: Boolean(u.home_city) && Date.parse(elig.homeReadyAt || iso(now + DAY)) <= now, detail: u.home_city && elig.homeReadyAt && Date.parse(elig.homeReadyAt) > now ? `ready ${elig.homeReadyAt.slice(0, 10)}` : null },
    // a seated founder qualified when they claimed, under the bar they claimed with (the ladder may have moved since)
    { id: "hold", label: `Hold ${((seat && seat.threshold) || elig.threshold || POLICY.founder.ladder.base).toLocaleString("en-US")}+ for ${POLICY.founder.qualifyingDays} days`,
      done: Boolean(seat) || Boolean(elig.tenure && elig.tenure.qualified), progress: elig.tenure ? Math.min(1, elig.tenure.days / elig.tenure.needed) : 0,
      detail: seat ? null : launched ? `${Math.min(days, POLICY.founder.qualifyingDays)} / ${POLICY.founder.qualifyingDays} days` : "starts at launch" },
    { id: "apply", label: "Claim your city: the first qualified claimer becomes Seed Steward at once", done: Boolean(app || seat) },
    { id: "chosen", label: "Seated: Seed Steward now, or chosen by locals if several claim together", done: Boolean(seat) },
    { id: "founder", label: seat && seat.status === "grace" ? "Founder: in grace, top up to keep it"
        : seat && seat.status === "steward" ? `Confirmed founder: after ${POLICY.founder.stewardProbationDays} days, or ${POLICY.founder.stewardQuorum} verified local holders`
        : seat && seat.status === "provisional" ? "Confirmed founder: after the 48-hour objection period" : "Confirmed founder",
      done: Boolean(seat && seat.status === "active"),
      detail: seat && seat.status === "steward" && seat.probation_until ? `probation until ${seat.probation_until.slice(0, 10)}` : null },
  ];
  const done = steps.filter((x) => x.done).length;
  // the profile ring: location and account are done by every member (the sign-up makes sure), the wallet may still be open
  const setup = { percent: u.wallet ? 100 : 67, steps: [{ id: "location", done: true }, { id: "account", done: true }, { id: "wallet", done: Boolean(u.wallet) }] };

  return {
    launched, chain, checkedAt: iso(now), level, fresh: isFresh(s, now), policyVersion: POLICY.version, setup,
    roles: { admin, manager: isManager, founder: founderLive, steward: Boolean(seat && seat.status === "steward"), holder: amount > 0,
      weight: VOTE_WEIGHT[isManager ? "manager" : founderLive ? "founder" : "member"] }, // the same weight powersOf gives for feed votes
    holding: { amount, rank: position ? position.rank : null, total: position ? position.total : null, percent: position ? position.percent : null,
      percentile: position ? position.percentile : null, next: position ? position.next : null, team },
    founder, badges, lost, community, national, squad: await squadPicture(env, u, now, fetchImpl),
    ban: ban ? { country: ban.country, until: ban.expires_at, actionId: ban.action_id, appealed: Boolean(appealed) } : null,
    progress: { percent: Math.round((done / steps.length) * 100), steps },
  };
}

export async function handleMe(request, env, fetchImpl = fetch, now = Date.now()) {
  const s = await getSession(env, request, now);
  const prov = providers(env);
  // The new sign-up (SIGNUP_FLOW=v2) says so in every answer, and tells a signed-in person whether they have a password.
  // Member profiles (PROFILES=on) say so too: profilesFlag, and for a signed-in member their bio (and, in the full answer,
  // their follower counts). The tabbed dashboard (DASHBOARD_V2=on) only says so: dashboardV2, and the page fetches its own code.
  // With a switch off there is no new key at all: the answers are exactly what they have always been.
  const v2 = v2On(env), pf = profilesOn(env), dv2 = dashboardV2On(env);
  const v2Flag = { ...(v2 ? { signupFlow: "v2" } : {}), ...(dv2 ? { dashboardV2: true } : {}) };
  const flag = pf ? { ...v2Flag, profilesFlag: true } : v2Flag;
  if (!s) return json({ signedIn: false, providers: prov, ...flag });
  if (!s.user) {
    let proof = null;
    try { if (s.proof) { const p = JSON.parse(s.proof); proof = { address: p.address, lamports: p.lamports, sol: (p.lamports / 1e9).toFixed(6) }; } } catch {}
    return json({ signedIn: false, providers: prov, pending: s.wallet ? { wallet: s.wallet } : null, proof, ...flag });
  }
  // A signed-in member only gets the profile keys when the profile tables are there; if they cannot be made, the page
  // simply sees a site without profiles (and the profile routes answer 503), never a broken dashboard.
  let ready = false;
  if (pf) {
    try { await ensureProfilesSchema(env.DB); ready = true; }
    catch (e) { console.error("profile tables unavailable", String((e && e.message) || e).slice(0, 80)); }
  }
  const myFlag = pf && !ready ? v2Flag : flag;
  const base = v2 ? { ...publicUser(s.user), hasPassword: Boolean(s.user.password_hash) } : publicUser(s.user);
  const user = ready ? { ...base, bio: s.user.bio || "" } : base;
  if (new URL(request.url).searchParams.get("lite") === "1") return json({ signedIn: true, user, providers: prov, fresh: isFresh(s, now), ...myFlag });
  const counts = ready ? { counts: await countsOf(env.DB, s.user.id, now) } : {};
  return json({ signedIn: true, user, providers: prov, ...myFlag, ...counts, ...(await liveStatus(env, s, fetchImpl, now)) });
}

/**
 * POST /api/me/terms { version } → record that the signed-in user agreed to the Terms of Use.
 * The frontend also keeps a local copy so anonymous visitors are gated before entry.
 */
export async function handleTermsAgree(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const body = await readJson(request);
  const version = typeof body?.version === "string" ? body.version.slice(0, 32) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) return json({ ok: false, error: "bad_version" }, 400);
  await ensureSchema(env.DB);
  await env.DB.prepare("UPDATE users SET terms_version = ?, terms_agreed_at = ? WHERE id = ?")
    .bind(version, new Date(now).toISOString(), a.u.id).run();
  return json({ ok: true, version });
}

/** Usernames: 3–20 chars, start with a letter, letters/digits/underscore. Unique, case-insensitively. */
export const validUsername = (s) => /^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(String(s || ""));

const RENAMES_PER_DAY = 3; // username changes per person per rolling day (rate_events kind "rename")
const RENAME_TRIES_PER_HOUR = 20; // attempts per person per hour, refused ones included (rate_events kind "rename_try")

/**
 * What a name "looks like": lower-case, look-alike digits mapped to letters (and i to l, so I / l / 1 are one
 * letter), everything that is not a letter or digit dropped (_ and -). Repeated letters are NOT merged:
 * Aaron and Aron are different names. "V1c1nity" and "vicinity_" come out as the same skeleton.
 */
export function nameSkeleton(s) {
  return String(s || "").toLowerCase()
    .replace(/[013457i]/g, (c) => ({ 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t", i: "l" })[c])
    .replace(/[^a-z0-9]/g, "");
}

// Names that pass for the project or its staff are refused. Deliberately narrow, so ordinary names stay free
// (Staffan, Supporter, Sysadmin and homeowner are fine):
//   · anything with "vicinity" in it, look-alike letters included
//   · exactly one of these words, with or without trailing digits (Admin, admin_, Support77, r00t)
//   · one of the staff words as the first or last WORD of the name (Admin_Sakib, SupportTeam, TheOfficial)
//   · starting with admin / administrator / moderator
//   · member followed by digits only (member12): the name the wallet link statement gives an account without a username
const STAFF_WORDS = ["admin", "administrator", "moderator", "mod", "mods", "support", "official", "staff", "owner", "system", "security", "help", "founder", "root", "team"];
const STAFF_AS_WORD = ["admin", "administrator", "moderator", "mod", "mods", "support", "official", "staff"].map(nameSkeleton);
const STAFF_SKELETONS = STAFF_WORDS.map(nameSkeleton);
const STAFF_PREFIXES = ["admin", "administrator", "moderator"].map(nameSkeleton);
const STAFF_EXACT = new RegExp(`^(${STAFF_WORDS.join("|")})[0-9]*$`);
export const reservedUsername = (s) => {
  if (/^member\d+$/i.test(String(s))) return true; // "member<id>" is how the wallet link statement names an account that has no username (src/walletlink.js accountName)
  const k = nameSkeleton(s);
  if (k.includes(nameSkeleton("vicinity"))) return true;
  if (STAFF_EXACT.test(String(s).toLowerCase().replace(/[^a-z0-9]/g, "")) || STAFF_SKELETONS.includes(k)) return true;
  const words = String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(nameSkeleton);
  if (words.length > 1 && (STAFF_AS_WORD.includes(words[0]) || STAFF_AS_WORD.includes(words[words.length - 1]))) return true;
  return STAFF_PREFIXES.some((r) => k.startsWith(r));
};

/**
 * POST /api/me/username { username } → change the public username.
 * First come, first served: it must not match any existing username (any casing), nor look like one
 * (I / l / 1, O / 0, underscores), nor pass for the project or its staff. At most 3 changes a day.
 * Needs a fresh wallet proof, like other identity changes.
 */
export async function handleUsername(request, env, now = Date.now()) {
  const a = await access(request, env, now, { fresh: true });
  if (a.error) return a.error;
  const body = await readJson(request);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  if (!validUsername(username)) return json({ ok: false, error: "bad_username" }, 400);
  await ensureSchema(env.DB);
  if (a.u.handle && a.u.handle.toLowerCase() === username.toLowerCase()) return json({ ok: true, username: a.u.handle });
  const taken = await env.DB.prepare("SELECT id FROM users WHERE lower(handle) = lower(?) AND id != ?").bind(username, a.u.id).first();
  if (taken) return json({ ok: false, error: "username_taken" }, 409);
  if (reservedUsername(username)) return json({ ok: false, error: "username_reserved" }, 400);
  // Limits first: the look-alike check below reads every username, so it must not be repeatable at will.
  if (await countRecent(env, a.u.id, "rename", now - DAY) >= RENAMES_PER_DAY) return json({ ok: false, error: "slow_down" }, 429);
  if (await countRecent(env, a.u.id, "rename_try", now - HOUR) >= RENAME_TRIES_PER_HOUR) return json({ ok: false, error: "slow_down" }, 429);
  await noteEvent(env, a.u.id, "rename_try", now);
  // Existing members keep their names, but nobody new may take a look-alike of another member's name.
  const skeleton = nameSkeleton(username);
  const others = (await env.DB.prepare("SELECT handle FROM users WHERE handle IS NOT NULL AND id != ?").bind(a.u.id).all()).results;
  if (others.some((o) => nameSkeleton(o.handle) === skeleton)) return json({ ok: false, error: "username_similar" }, 409);
  try {
    await env.DB.prepare("UPDATE users SET handle = ? WHERE id = ?").bind(username, a.u.id).run();
    await noteEvent(env, a.u.id, "rename", now);
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message ? e.message : e))) return json({ ok: false, error: "username_taken" }, 409);
    throw e;
  }
  return json({ ok: true, username });
}

/**
 * POST /api/me/contact/email/verify { email, code } → verify the code (sent by the
 * shared /api/auth/email/start) and store it as the account's contact e-mail.
 * A verified contact e-mail is not a sign-in method; someone else's sign-in e-mail can't be taken.
 */
export async function handleContactEmailVerify(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const body = await readJson(request);
  const email = cleanEmail(body && body.email);
  const code = String((body && body.code) || "").replace(/\D/g, "").slice(0, 6);
  if (!validEmail(email) || code.length !== 6) return json({ ok: false, error: "bad_code" }, 400);
  const v = await consumeEmailCode(env.DB, email, code, now);
  if (!v.ok) return json({ ok: false, error: v.error, ...(v.left != null ? { left: v.left } : {}) }, v.error === "too_many" ? 429 : 400);
  await ensureSchema(env.DB);
  const other = await env.DB.prepare("SELECT id FROM users WHERE provider = 'email' AND provider_id = ? AND id != ?").bind(email, a.u.id).first();
  if (other) return json({ ok: false, error: "email_taken" }, 409);
  await env.DB.prepare("UPDATE users SET contact_email = ? WHERE id = ?").bind(email, a.u.id).run();
  return json({ ok: true, email });
}

/** POST /api/me/contact/email/remove → clear the contact e-mail (the sign-in e-mail of an e-mail account is not touched). */
export async function handleContactEmailRemove(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  await env.DB.prepare("UPDATE users SET contact_email = NULL WHERE id = ?").bind(a.u.id).run();
  return json({ ok: true, email: null });
}

const validPhone = (s) => {
  const t = String(s || "").trim();
  const digits = t.replace(/\D/g, "");
  return /^\+?[0-9\s\-().]{7,24}$/.test(t) && digits.length >= 7 && digits.length <= 15;
};

/**
 * POST /api/me/phone { phone } → set (or clear, with "") the contact phone number.
 * Stored for future notifications; not verified.
 */
export async function handlePhone(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const body = await readJson(request);
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  if (phone && !validPhone(phone)) return json({ ok: false, error: "bad_phone" }, 400);
  await ensureSchema(env.DB);
  await env.DB.prepare("UPDATE users SET phone = ? WHERE id = ?").bind(phone || null, a.u.id).run();
  return json({ ok: true, phone: phone || null });
}

/**
 * POST /api/home { attestation, choice? }
 * Inside a community → that's home. In empty land → pick one of the three nearest (send `choice`).
 * Locked for a week after setting it, and while you hold or are applying for a founder seat.
 */
export async function handleHome(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  if (u.home_at && now - Date.parse(u.home_at) < HOME_LOCK_DAYS * DAY) {
    return json({ ok: false, error: "home_locked", until: iso(Date.parse(u.home_at) + HOME_LOCK_DAYS * DAY) }, 409);
  }
  if (await liveSeatOfUser(db, u.id)) return json({ ok: false, error: "founder_home_locked" }, 409);
  if (await db.prepare("SELECT a.id FROM applications a JOIN windows w ON w.id = a.window_id WHERE a.user_id = ? AND a.withdrawn = 0 AND w.status = 'open'").bind(u.id).first()) {
    return json({ ok: false, error: "founder_home_locked" }, 409);
  }
  const at = await useAttestation(env, body.attestation, { userId: u.id, purpose: "home", now });
  if (!at.ok) return json({ ok: false, error: at.error }, 400);
  const att = at.att;
  let home = null;
  if (att.city) home = { id: att.city, name: att.cityName, country: att.country };
  else {
    const pick = body.choice != null && (att.nearby || []).find((c) => c.id === String(body.choice));
    if (!pick) return json({ ok: false, error: "choose_nearby", nearby: att.nearby || [] }, 400);
    home = await communityById(env, att.country, pick.id);
  }
  if (!home) return json({ ok: false, error: "unknown_city" }, 400);
  await db.prepare("UPDATE users SET home_city = ?, home_name = ?, home_country = ?, home_at = ? WHERE id = ?").bind(home.id, home.name, home.country, iso(now), u.id).run();
  return json({ ok: true, home, joinedNearby: !att.city });
}

/** GET /api/members → how many people call each community home (public, no names or wallets). Test-lab accounts are not people and are not counted. */
export async function handleMembers(env) {
  if (!env.DB) return json({ members: 0, communities: [] });
  await ensureSchema(env.DB);
  const [total, top, placed] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE provider != 'testlab'"),
    env.DB.prepare("SELECT home_city AS id, home_name AS name, home_country AS country, COUNT(*) AS members FROM users WHERE home_city IS NOT NULL AND provider != 'testlab' GROUP BY home_city ORDER BY members DESC LIMIT 300"),
    env.DB.prepare("SELECT wallet, home_city, home_name, home_country FROM users WHERE home_city IS NOT NULL AND provider != 'testlab'"),
  ]);
  // Holders per city: members whose wallet holds > 0 in the latest balance sample (a member without a wallet holds nothing, but still
  // counts as a member of their community). A team wallet is not one of the people (as on the token page and the dashboard's "Holders
  // here"), so it is not counted. No sample to count from (none taken yet, or unreadable): holders is null on every row, "unknown",
  // never 0, so the map keeps the counts it saw last instead of turning every active city open until the next answer.
  let balances = null;
  try { balances = (await latestBalances(env, Date.now()))?.balances || null; } catch { balances = null; }
  const holders = balances ? new Map() : null, counts = new Map();
  for (const u of placed.results) {
    const c = counts.get(u.home_city) || { id: u.home_city, name: u.home_name, country: u.home_country, members: 0 };
    c.members++; counts.set(u.home_city, c);
    if (holders && u.wallet && (balances[u.wallet] || 0) > 0 && !isTeamWallet(u.wallet)) holders.set(u.home_city, (holders.get(u.home_city) || 0) + 1);
  }
  // The 300 largest communities, then every smaller one with a holder (most holders first): the map paints those "active", and a town
  // with its first holder must show whatever its size.
  const list = top.results.slice(), listed = new Set(list.map((c) => c.id));
  if (holders) for (const id of [...holders.keys()].sort((a, b) => holders.get(b) - holders.get(a) || (a < b ? -1 : a > b ? 1 : 0))) if (!listed.has(id) && counts.has(id)) { listed.add(id); list.push(counts.get(id)); }
  return json({ members: total.results[0]?.n || 0,
    communities: list.map((c) => ({ ...c, holders: holders ? holders.get(c.id) || 0 : null })) });
}
