/**
 * Extra sign-ins for an existing account (SIGNUP_FLOW=v2): the Profile's "Google sign-in" row. A member who made their account
 * with an e-mail (or, before onboarding v3, with a wallet and an e-mail) adds Google there, and from then on "Log in with Google"
 * signs them in to THAT account. Why it is needed: Google tells us only an account number (the scope is "openid profile", on
 * purpose: no e-mail address is asked for), so a Google login can never be matched to an account by its Gmail address. A Gmail
 * saved as the contact e-mail (src/me.js) is not a way to log in, and stays that way.
 *
 *   POST /api/me/google/add      → { ok, url }: off to Google with the link marker in the OAuth cookie (src/auth.js handleGoogleAdd),
 *                                  and the callback adds the Google account Google answers with (src/auth.js finishGoogleAdd)
 *   POST /api/me/google/remove   → { ok, removed }: the added Google sign-in goes (src/me.js handleGoogleRemove). The account's main
 *                                  login (users.provider / provider_id: what it was made with) is never touched
 *
 * The rules, all of them checked again inside the INSERT or by a UNIQUE constraint of user_logins (src/store.js LOGINS_MIGRATION):
 *   - one account per Google account: a Google account that already logs in to ANOTHER account, as its main login or as a sign-in
 *     added there, is refused (google_taken). Adding the one that already logs in to THIS account changes nothing and is a success
 *   - one Google sign-in per account: an account made with Google has its Google sign-in already, and an account that added one must
 *     remove it before it adds another (has_google). Nothing is ever replaced quietly
 *   - the Google log-in (src/auth.js linkIdentity) finds an account through its main login first, then through user_logins; the new
 *     sign-up (src/signup-finish.js) makes no account for a Google account that is in user_logins (social_taken)
 *   - an account that is deleted takes its user_logins rows with it (src/admin.js)
 * Only Google's account number is kept (the same "sub" users.provider_id holds for an account made with Google), and nothing here
 * logs it or puts it in an answer: /api/me says only WHETHER a Google sign-in was added (googleAdded).
 */
import { ensureLoginsSchema } from "./store.js";
import { iso } from "./policy.js";

/** "no such table": user_logins is made the first time a sign-in is added, so before that nobody has added one. */
const noTable = (e) => /no such table/i.test(String((e && e.message) || e));

/**
 * The account a verified login belongs to: { id, wallet } or null (wallet is NULL for an account with no wallet linked yet: the log-in
 * takes that as it always did). Its main login first (users.provider / provider_id, the one statement the log-in always used), then,
 * for Google only, a Google sign-in a member added (user_logins). Only READS user_logins, so a log-in never creates a table, with the
 * switch off too.
 */
export async function findAccount(db, provider, id) {
  const main = await db.prepare("SELECT id, wallet FROM users WHERE provider = ? AND provider_id = ?").bind(provider, id).first();
  if (main || provider !== "google") return main;
  try {
    return await db.prepare("SELECT u.id, u.wallet FROM user_logins l JOIN users u ON u.id = l.user_id WHERE l.provider = 'google' AND l.provider_id = ?").bind(id).first();
  } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
}

/**
 * Did any member add this login to their account as an extra sign-in? { id } of that account, or null. Only Google can be added; the
 * new sign-up asks this before it makes an account (src/signup-finish.js: social_taken), so one Google account never gets two.
 */
export async function addedBy(db, provider, id) {
  if (provider !== "google") return null;
  try {
    return await db.prepare("SELECT user_id AS id FROM user_logins WHERE provider = 'google' AND provider_id = ?").bind(id).first();
  } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
}

/** Did this account add a Google sign-in? true / false, never which one. */
export async function googleAdded(db, userId) {
  try {
    return Boolean(await db.prepare("SELECT 1 AS x FROM user_logins WHERE user_id = ? AND provider = 'google'").bind(userId).first());
  } catch (e) {
    if (noTable(e)) return false;
    throw e;
  }
}

/**
 * Add Google account `googleId` (Google's account number, from a verified Google login) as a way to log in to account `userId`.
 * Returns { ok: true } (added), { ok: true, already: true } (this Google account logs in to this very account already: nothing
 * changed), or { error }: google_taken (it logs in to another account), has_google (this account has a Google sign-in already),
 * sign_in (the account is gone), changed_retry (something changed at that very moment: try again).
 * The answers come from a look first, so they are precise; the INSERT checks again inside the statement that the account's own main
 * login is not Google and that no account has this Google account as its main login, and the two UNIQUE constraints of user_logins
 * stop the rest (two tabs adding at once, or two accounts adding the same Google account): whatever lost, nothing was written.
 */
export async function addGoogle(db, userId, googleId, now) {
  await ensureLoginsSchema(db);
  const verdict = async () => {
    const me = await db.prepare("SELECT id, provider, provider_id FROM users WHERE id = ?").bind(userId).first();
    if (!me) return { error: "sign_in" };
    if (me.provider === "google") return me.provider_id === googleId ? { ok: true, already: true } : { error: "has_google" };
    const owner = await findAccount(db, "google", googleId);
    if (owner) return owner.id === userId ? { ok: true, already: true } : { error: "google_taken" };
    if (await googleAdded(db, userId)) return { error: "has_google" };
    return null; // free: add it
  };
  const first = await verdict();
  if (first) return first;
  try {
    const r = await db.prepare(`INSERT INTO user_logins (user_id, provider, provider_id, created_at)
       SELECT ?1, 'google', ?2, ?3
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1 AND provider != 'google')
          AND NOT EXISTS (SELECT 1 FROM users WHERE provider = 'google' AND provider_id = ?2)`).bind(userId, googleId, iso(now)).run();
    if (r.meta.changes === 1) return { ok: true };
  } catch (e) {
    if (!/UNIQUE/i.test(String((e && e.message) || e))) throw e;
  }
  return (await verdict()) || { error: "changed_retry" }; // lost a race: say what is true now
}

/** Take the Google sign-in this account ADDED off it. The account's main login lives in users and is never touched here. Returns true when there was one. */
export async function removeGoogle(db, userId) {
  try {
    return (await db.prepare("DELETE FROM user_logins WHERE user_id = ? AND provider = 'google'").bind(userId).run()).meta.changes > 0;
  } catch (e) {
    if (noTable(e)) return false;
    throw e;
  }
}

/** An account is being deleted: every sign-in it added goes with it (src/admin.js). Nothing to do while the table was never made. */
export async function dropLogins(db, userId) {
  try {
    await db.prepare("DELETE FROM user_logins WHERE user_id = ?").bind(userId).run();
  } catch (e) {
    if (!noTable(e)) throw e;
  }
}
