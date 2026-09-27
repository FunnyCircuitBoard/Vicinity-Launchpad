/**
 * Who may do what, from live data:
 *   Admin            → a wallet in the ADMIN_WALLETS setting (Cloudflare → Settings → Variables)
 *   Country manager  → elected for a 90-day term (src/elections.js), while their founder seat is active
 *   City founder     → holds an ACTIVE founder seat (src/seats.js); a seat in grace keeps its badge
 *                      but not its powers
 *   Holder           → holds any $VICINITY
 *   Member           → signed in, not holding (yet)
 */
import { activeMint } from "./official.js";
import { liveAmounts } from "./chain.js";
import { isSolanaAddress } from "./solana.js";
import { iso } from "./policy.js";

/** Weekly meme votes: founders and country managers have stronger votes (their "special voting rights"). */
export const VOTE_WEIGHT = { member: 1, holder: 1, founder: 2, manager: 3, admin: 1 };
export const LIVE = ["provisional", "active", "grace"];

export const adminWallets = (env) => String((env && env.ADMIN_WALLETS) || "").split(/[\s,]+/).filter(isSolanaAddress);
export const amountsFor = (env, wallets, fetchImpl = fetch, opts = {}) => liveAmounts(env, wallets, fetchImpl, { ...opts, mint: activeMint(env) });

export const liveSeatOfUser = (db, userId) =>
  db.prepare("SELECT * FROM seats WHERE user_id = ? AND status IN ('provisional', 'active', 'grace')").bind(userId).first();
export const liveSeatOfCity = (db, cityId) =>
  db.prepare("SELECT * FROM seats WHERE city_id = ? AND status IN ('provisional', 'active', 'grace')").bind(cityId).first();

/** The country's manager right now: { term, seat } when the term is running AND the manager's seat is active. */
export async function managerOf(env, cc, now = Date.now()) {
  if (!env.DB || !cc) return null;
  const term = await env.DB.prepare("SELECT * FROM manager_terms WHERE country = ? AND status = 'active' AND starts_at <= ? AND ends_at > ? ORDER BY id DESC LIMIT 1")
    .bind(cc, iso(now), iso(now)).first();
  if (!term) return null;
  const seat = await env.DB.prepare("SELECT * FROM seats WHERE id = ?").bind(term.seat_id).first();
  if (!seat || seat.status !== "active") return null;
  const user = await env.DB.prepare("SELECT handle, name FROM users WHERE id = ?").bind(term.user_id).first();
  return { term, seat, wallet: term.wallet, userId: term.user_id, city: seat.city_name, name: user?.handle || user?.name || "Manager" };
}

/**
 * Everything a person may do right now:
 *   { admin, launched, amount, holder, seat, founderCity, managerCountry, level, weight }
 */
export async function powersOf(env, user, fetchImpl = fetch, now = Date.now()) {
  const launched = Boolean(activeMint(env));
  const admin = adminWallets(env).includes(user.wallet);
  const amount = launched ? (await amountsFor(env, [user.wallet], fetchImpl)).get(user.wallet) || 0 : 0;
  const seat = await liveSeatOfUser(env.DB, user.id);
  const founderCity = seat && seat.status === "active" ? seat.city_id : null;
  let managerCountry = null;
  if (founderCity) {
    const m = await managerOf(env, seat.country, now);
    if (m && m.userId === user.id) managerCountry = seat.country;
  }
  const level = admin ? "admin" : managerCountry ? "manager" : founderCity ? "founder" : amount > 0 ? "holder" : "member";
  return {
    admin, launched, amount, holder: amount > 0, seat, founderCity, founderCountry: founderCity ? seat.country : null,
    managerCountry, level, weight: VOTE_WEIGHT[managerCountry ? "manager" : founderCity ? "founder" : "member"],
  };
}

/** May these powers moderate this post? Admin anywhere, a manager in their country, a founder in their city. */
export const canModerate = (p, post) =>
  Boolean(p.admin || (p.managerCountry && post.country === p.managerCountry) || (p.founderCity && post.scope === "city" && post.place === p.founderCity));

/** Is this person banned from posting here (a country, or everywhere)? */
export async function activeBan(db, userId, country, now = Date.now()) {
  return db.prepare("SELECT user_id, country, expires_at, action_id FROM bans WHERE user_id = ? AND (country = '*' OR country = ?) AND (expires_at IS NULL OR expires_at > ?) ORDER BY expires_at DESC LIMIT 1")
    .bind(userId, country || "", iso(now)).first();
}
