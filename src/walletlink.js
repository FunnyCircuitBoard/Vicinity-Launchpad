/**
 * The wallet link (onboarding v3, SIGNUP_FLOW=v2): an account is made with Google or an e-mail and holds no wallet; the
 * wallet is linked later, from the dashboard, with ONE free signature. Nothing here asks for a location, the Terms or a
 * Google login: the account already holds them.
 *
 * THE ONE RULE for a proven wallet lives in src/auth.js (walletProven): a browser logged in to an account WITHOUT a wallet
 * links it; logged in WITH the same wallet re-proves; WITH another wallet → wrong_wallet; not logged in → the wallet signs
 * its owner in, or there is no account for it (no_account: nothing is made, no cookie). This file holds the link itself
 * (linkWallet: one transaction) and the dashboard's routes, only while the switch is on (src/index.js):
 *
 *   POST /api/me/wallet/link { address, message, signature }   the signed "link" statement, in the browser that holds the dashboard
 *   POST /api/me/wallet/carry                                   phone Safari / Chrome: a one-time code that opens the link inside the
 *                                                               wallet app's browser (same phone, same internet connection, 10 minutes)
 *   POST /api/me/wallet/carry/info { code }                     the wallet app's page, before the person confirms: check number, whose account
 *   POST /api/me/wallet/carry/claim { code, address, message, signature }   the wallet app's browser links the wallet and gets its own session
 *   GET  /api/me/wallet/carry/status?ref=                       Safari asks what became of its code: waiting | opened | linked | expired | replaced
 *   POST /api/me/wallet/unlink                                  take the wallet off the account (a fresh proof by that wallet; not with a live seat)
 *
 * The statement a wallet signs names the account ("Link this wallet to my Vicinity account @handle", src/solana.js), so a
 * signature made for one account can never link the wallet to another, and a login statement never links. A code is 192
 * random bits, kept only as a hash, bound to the connection that made it (the IPv4 address or the IPv6 /64, as a salted
 * hash: src/limits.js clientKey), and works once. Nothing here logs an address, a code or a hash in clear.
 */
import { cookie, json, randomToken, readJson, sameSite, sha256 } from "./http.js";
import { SESSION_COOKIE, SESSION_SECONDS } from "./session.js";
import { dropSession, getSession, isFresh } from "./auth.js";
import { checkSigned } from "./signed.js";
import { ensureOnboardSchema } from "./store.js";
import { isRelayNetwork } from "./network.js";
import { check, clientKey, limitKey } from "./limits.js";
import { TERMS_VERSION } from "./signup-core.js";
import { v2On } from "./flags.js";
import { HOUR, iso } from "./policy.js";

const MINUTES = 10; // an "Open app" code lives 10 minutes (like the location hand-off and a pairing code)
// How many tries, per hour (counted BEFORE the work, atomically: src/limits.js).
const LIMITS = {
  link: { user: 10, ip: 30 },
  carry: { user: 10, ip: 30 },   // codes made
  info: { ip: 60 },              // codes looked at (the wallet app's page asks once before the person confirms)
  claim: { ip: 30 },             // codes tried (a code is 192 random bits: this only keeps the noise down)
};

const maskWallet = (w) => `${w.slice(0, 4)}…${w.slice(-4)}`;
/** A name as the wallet app's page may show it before the person confirms: enough to recognise their own ("Sa•••"), no more. */
export const maskName = (n) => { const a = Array.from(String(n || "").trim()); return a.length ? `${a.slice(0, a.length > 3 ? 2 : 1).join("")}•••` : "•••"; };
/** The account as the link statement names it: the username (every v2 account has one; an old account without one is named by its number). */
export const accountName = (u) => (u.handle && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(u.handle) ? u.handle : `member${u.id}`);

const badJson = () => json({ ok: false, error: "bad_json" }, 400);
const badSigned = (error, status = 400) => ({ error: json({ ok: false, error }, status) });
const perHour = async (env, kind, value, max) => ({ key: await limitKey(env, kind, value), windowMs: HOUR, max });
/** Count one try on each counter (atomically, before the work). Returns a 429 Response when any is over its maximum, else null. */
async function limited(env, now, specs) {
  const r = await check(env, specs, now);
  return r.ok ? null : json({ ok: false, error: "slow_down" }, 429);
}

/**
 * Link `wallet` to the account of session `s`: ONE transaction. The account takes the wallet only while it has none and nobody
 * else has this one (the UNIQUE index is the last guard); then every session of that person carries the wallet (every open
 * dashboard sees it), and only THIS session, the one that proved it, gets the proof time. Returns { ok } (also when this very
 * wallet was already the account's: idempotent, and the proof is renewed), or { error, status, wallet? }: has_wallet (the
 * account has another one; masked), wallet_taken (another account has this one). Logs the link, masked.
 */
export async function linkWallet(env, s, wallet, now) {
  let r;
  try {
    r = await env.DB.batch([
      env.DB.prepare("UPDATE users SET wallet = ?1 WHERE id = ?2 AND wallet IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE wallet = ?1)").bind(wallet, s.user.id),
      env.DB.prepare(`UPDATE sessions SET wallet = ?1, proven_at = CASE WHEN id = ?3 THEN ?4 ELSE proven_at END
          WHERE user_id = ?2 AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND wallet = ?1)`).bind(wallet, s.user.id, s.id, iso(now)),
    ]);
  } catch (e) {
    if (!/UNIQUE/i.test(String((e && e.message) || e))) throw e;
    return { error: "wallet_taken", status: 409 };
  }
  if (r[0].meta.changes === 1) {
    console.log("wallet linked", maskWallet(wallet));
    return { ok: true };
  }
  const u = await env.DB.prepare("SELECT wallet FROM users WHERE id = ?").bind(s.user.id).first();
  if (u && u.wallet === wallet) return { ok: true, already: true };
  if (u && u.wallet) return { error: "has_wallet", status: 409, wallet: maskWallet(u.wallet) };
  return { error: "wallet_taken", status: 409 };
}

/* ---------------- the "Open app" code: Safari → the wallet app's browser, same phone ---------------- */

/** The connection a code is bound to: a salted hash of the IPv4 address or of the IPv6 /64 (src/limits.js clientKey), never the address. */
const carryNet = (env, request) => limitKey(env, "carryip", clientKey(request));
/** The two-digit check number of a code (the same on both screens, derived from the code: nothing more to store). */
async function carryPin(code) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`carry-pin\n${code}`)));
  return String(10 + (((h[0] << 8) | h[1]) % 90));
}
/** A short handle on a code (a prefix of its stored hash), so Safari can ask what became of it and tell when another tab replaced it. */
const carryRef = (id) => String(id).slice(0, 12);

const findCarry = async (env, code, now) => {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{32,64}$/.test(code)) return null;
  const row = await env.DB.prepare("SELECT * FROM handoffs WHERE id = ? AND kind = 'carry' AND purpose = 'link' AND (result IS NULL OR result = 'opened')").bind(await sha256(code)).first();
  return row && Date.parse(row.expires_at) > now ? row : null;
};

/**
 * A live code that this connection may use, and the account it links to: { row, owner } or { error: Response }. The code is
 * unknown, used or old → carry_expired (410); another connection's → carry_network (403); the owner linked a wallet meanwhile →
 * link_done (409).
 */
async function usableCarry(env, request, code, now) {
  const row = await findCarry(env, code, now);
  if (!row) return { error: json({ ok: false, error: "carry_expired" }, 410) };
  if (row.net !== await carryNet(env, request)) return { error: json({ ok: false, error: "carry_network" }, 403) };
  const owner = await env.DB.prepare("SELECT id, handle, name, wallet, home_name, home_country FROM users WHERE id = ?").bind(row.user_id).first();
  if (!owner) return { error: json({ ok: false, error: "carry_expired" }, 410) };
  if (owner.wallet) return { error: json({ ok: false, error: "link_done" }, 409) };
  return { row, owner };
}

/**
 * The account a "link" statement is for, for GET /api/message?action=link: the signed-in person's own (the dashboard), or, with
 * ?code= (the wallet app's browser, no cookie), the owner of a live same-connection code, or, with ?pair= (a wallet app approving
 * for another device), the owner of a live link pairing. Returns { handle } or { error, status } or { response }.
 */
export async function linkAccountFor(request, env, now = Date.now()) {
  if (!v2On(env)) return { error: "bad_request", status: 400 };
  try { await ensureOnboardSchema(env.DB); }
  catch (e) { console.error("wallet link tables unavailable", String((e && e.message) || e)); return { error: "link_unavailable", status: 503 }; }
  const q = new URL(request.url).searchParams;
  if (q.get("code")) {
    const u = await usableCarry(env, request, q.get("code"), now);
    return u.error ? { response: u.error } : { handle: accountName(u.owner) };
  }
  if (q.get("pair")) {
    const code = q.get("pair");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) return { error: "pair_expired", status: 410 };
    const p = await env.DB.prepare("SELECT user_id FROM pairs WHERE id = ? AND purpose = 'link' AND wallet IS NULL AND expires_at > ?").bind(await sha256(code), iso(now)).first();
    const owner = p && p.user_id ? await env.DB.prepare("SELECT id, handle, wallet FROM users WHERE id = ?").bind(p.user_id).first() : null;
    if (!owner) return { error: "pair_expired", status: 410 };
    return { handle: accountName(owner) };
  }
  const s = await getSession(env, request, now);
  if (!s || !s.user) return { error: "sign_in", status: 401 };
  return { handle: accountName(s.user) };
}

/* ---------------- the routes ---------------- */

/** POST /api/me/wallet/link: the dashboard's browser signed the link statement itself. */
async function handleLink(request, env, x) {
  const s = await getSession(env, request, x.now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  const body = await readJson(request);
  if (!body) return badJson();
  const over = await limited(env, x.now, [
    await perHour(env, "wls", s.user.id, LIMITS.link.user),
    await perHour(env, "wli", clientKey(request), LIMITS.link.ip),
  ]);
  if (over) return over;
  const r = await checkSigned(body, request, x.now, ["link"], badSigned, env.DB); // a signed message works once
  if (r.error) return r.error;
  // the statement names THIS account, and the plain one (the check-number variant belongs to the pairing)
  if (r.parsed.pin || r.parsed.handle !== accountName(s.user)) return json({ ok: false, error: "bad_message" }, 400);
  const linked = await linkWallet(env, s, r.parsed.address, x.now);
  if (linked.error) return json({ ok: false, error: linked.error, ...(linked.wallet ? { wallet: linked.wallet } : {}) }, linked.status);
  return json({ ok: true, wallet: r.parsed.address, provenAt: iso(x.now), fresh: true });
}

/** POST /api/me/wallet/carry: phone Safari / Chrome asks for the one-time code that opens the link inside the wallet app. */
async function handleCarryStart(request, env, x) {
  const s = await getSession(env, request, x.now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  if (s.user.wallet) return json({ ok: false, error: "has_wallet", wallet: maskWallet(s.user.wallet) }, 409);
  // Behind a relay (iCloud Private Relay...) the wallet app's browser can't share this connection: no code, the page pairs instead.
  if (isRelayNetwork(x.cf)) return json({ ok: false, error: "carry_relay" }, 409);
  const over = await limited(env, x.now, [
    await perHour(env, "wcs", s.user.id, LIMITS.carry.user),
    await perHour(env, "wci", clientKey(request), LIMITS.carry.ip),
  ]);
  if (over) return over;
  const code = randomToken(24), until = x.now + MINUTES * 60_000, id = await sha256(code);
  await env.DB.batch([
    // one live code per person: a new tap replaces the one before (a code already used stays: it tells Safari what happened)
    env.DB.prepare("DELETE FROM handoffs WHERE kind = 'carry' AND ((user_id = ? AND (result IS NULL OR result = 'opened')) OR expires_at < ?)").bind(s.user.id, iso(x.now)),
    env.DB.prepare("INSERT INTO handoffs (id, kind, user_id, purpose, net, created_at, expires_at) VALUES (?, 'carry', ?, 'link', ?, ?, ?)")
      .bind(id, s.user.id, await carryNet(env, request), iso(x.now), iso(until)),
  ]);
  return json({ ok: true, code, pin: await carryPin(code), ref: carryRef(id), url: `${new URL(request.url).origin}/connect?link=${code}`, expiresAt: iso(until) });
}

/**
 * POST /api/me/wallet/carry/info { code }: what the wallet app's page shows BEFORE anything happens, so the person can tell it is
 * their own account: the check number Safari shows, the account (masked) and its community. Marks the code "opened" (Safari's
 * status says so); the code stays usable.
 */
async function handleCarryInfo(request, env, x) {
  const body = await readJson(request);
  if (!body) return badJson();
  const over = await limited(env, x.now, [await perHour(env, "wcv", clientKey(request), LIMITS.info.ip)]);
  if (over) return over;
  const u = await usableCarry(env, request, body.code, x.now);
  if (u.error) return u.error;
  await env.DB.prepare("UPDATE handoffs SET result = 'opened' WHERE id = ? AND result IS NULL").bind(u.row.id).run();
  const shown = u.owner.name || u.owner.handle || "";
  return json({
    ok: true, pin: await carryPin(body.code),
    owner: { name: maskName(shown), handle: maskName(u.owner.handle), initial: Array.from(String(shown).trim())[0] || "•" },
    community: u.owner.home_name ? { name: u.owner.home_name, country: u.owner.home_country } : null,
    terms: TERMS_VERSION, expiresAt: u.row.expires_at,
  });
}

/**
 * POST /api/me/wallet/carry/claim { code, address, message, signature }: the wallet app's browser, after the person confirmed and
 * signed the link statement that names the owner's account. ONE transaction: the code is used (only while the owner still has no
 * wallet and nobody has this one), the account takes the wallet, every session of the owner carries it (Safari's dashboard
 * updates by itself), and this browser gets its own 30-day session, proven now. A browser signed in as somebody else is refused
 * (already_signed_in); the owner's own earlier session in this browser is replaced.
 */
async function handleCarryClaim(request, env, x) {
  const session = await getSession(env, request, x.now);
  const body = await readJson(request);
  if (!body) return badJson();
  const over = await limited(env, x.now, [await perHour(env, "wcc", clientKey(request), LIMITS.claim.ip)]);
  if (over) return over;
  const u = await usableCarry(env, request, body.code, x.now);
  if (u.error) return u.error;
  if (session && session.user && session.user.id !== u.owner.id) return json({ ok: false, error: "already_signed_in" }, 409);
  const r = await checkSigned(body, request, x.now, ["link"], badSigned, env.DB);
  if (r.error) return r.error;
  if (r.parsed.pin || r.parsed.handle !== accountName(u.owner)) return json({ ok: false, error: "bad_message" }, 400);
  const wallet = r.parsed.address;
  if (session) await dropSession(env, session.id); // the owner's own earlier session here, or a pending proof: replaced by the one made below
  const token = randomToken(32), sid = await sha256(token);
  let res;
  try {
    res = await env.DB.batch([
      // 1. the code is used, once, and only while the owner has no wallet and nobody has this one (otherwise nothing is consumed)
      env.DB.prepare(`UPDATE handoffs SET result = 'linked', wallet = ?1 WHERE id = ?2 AND kind = 'carry' AND (result IS NULL OR result = 'opened') AND expires_at > ?3
          AND EXISTS (SELECT 1 FROM users WHERE id = ?4 AND wallet IS NULL) AND NOT EXISTS (SELECT 1 FROM users WHERE wallet = ?1)`)
        .bind(wallet, u.row.id, iso(x.now), u.owner.id),
      // 2. the account takes the wallet, only if 1 happened (the UNIQUE index is the last guard)
      env.DB.prepare("UPDATE users SET wallet = ?1 WHERE id = ?2 AND wallet IS NULL AND EXISTS (SELECT 1 FROM handoffs WHERE id = ?3 AND result = 'linked' AND wallet = ?1)")
        .bind(wallet, u.owner.id, u.row.id),
      // 3. every session of the owner carries the wallet; none of them is a proof (only the browser that signed gets one: 4)
      env.DB.prepare("UPDATE sessions SET wallet = ?1 WHERE user_id = ?2 AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND wallet = ?1)").bind(wallet, u.owner.id),
      // 4. this browser's own 30-day session, proven now
      env.DB.prepare(`INSERT INTO sessions (id, wallet, user_id, proof, created_at, expires_at, proven_at)
          SELECT ?1, ?2, ?3, NULL, ?4, ?5, ?4 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?3 AND wallet = ?2)`)
        .bind(sid, wallet, u.owner.id, iso(x.now), iso(x.now + SESSION_SECONDS * 1000)),
    ]);
  } catch (e) {
    if (!/UNIQUE/i.test(String((e && e.message) || e))) throw e;
    return json({ ok: false, error: "wallet_taken" }, 409);
  }
  if (res[0].meta.changes !== 1 || res[1].meta.changes !== 1 || res[3].meta.changes !== 1) {
    // nothing was consumed: say which it was
    const o = await env.DB.prepare("SELECT wallet FROM users WHERE id = ?").bind(u.owner.id).first();
    if (o && o.wallet) return json({ ok: false, error: "link_done" }, 409);
    if (await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(wallet).first()) return json({ ok: false, error: "wallet_taken" }, 409);
    return json({ ok: false, error: "carry_expired" }, 410);
  }
  console.log("wallet linked", maskWallet(wallet), "(wallet app)");
  return json({ ok: true, wallet, next: "/dashboard?linked=1" }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, token, SESSION_SECONDS) });
}

/** GET /api/me/wallet/carry/status?ref= (Safari, signed in): what became of its code. */
async function handleCarryStatus(request, env, x) {
  const s = await getSession(env, request, x.now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  const ref = String(new URL(request.url).searchParams.get("ref") || "");
  if (!/^[A-Za-z0-9_-]{12}$/.test(ref)) return json({ ok: false, error: "bad_ref" }, 400);
  if (s.user.wallet) return json({ ok: true, status: "linked", wallet: s.user.wallet });
  const row = await env.DB.prepare("SELECT id, result, wallet, expires_at FROM handoffs WHERE kind = 'carry' AND user_id = ? AND substr(id, 1, 12) = ?").bind(s.user.id, ref).first();
  if (!row) {
    const newer = await env.DB.prepare("SELECT id FROM handoffs WHERE kind = 'carry' AND user_id = ? AND (result IS NULL OR result = 'opened') AND expires_at > ?").bind(s.user.id, iso(x.now)).first();
    return json({ ok: true, status: newer ? "replaced" : "expired" });
  }
  if (row.result === "linked") return json({ ok: true, status: "linked", wallet: row.wallet });
  if (Date.parse(row.expires_at) <= x.now) return json({ ok: true, status: "expired" });
  return json({ ok: true, status: row.result === "opened" ? "opened" : "waiting" });
}

/**
 * POST /api/me/wallet/unlink: take the wallet off the account. Needs a fresh proof by that very wallet (a login alone is not
 * enough once a wallet is linked), and refuses while the person holds a live founder seat, an open application or a squad
 * place (seat_or_application: resign or withdraw first). Every session of the person loses the wallet and its proof.
 */
async function handleUnlink(request, env, x) {
  const s = await getSession(env, request, x.now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  if (!s.user.wallet) return json({ ok: false, error: "no_wallet" }, 409);
  if (!(s.proven_at && isFresh(s, x.now) && s.wallet === s.user.wallet)) return json({ ok: false, error: "reprove" }, 403);
  const busy = await env.DB.prepare(`SELECT 1 AS x FROM seats WHERE user_id = ?1 AND status IN ('provisional', 'active', 'grace', 'steward')
      UNION ALL SELECT 1 FROM applications a JOIN windows w ON w.id = a.window_id WHERE a.user_id = ?1 AND a.withdrawn = 0 AND w.status = 'open'
      UNION ALL SELECT 1 FROM squad_members WHERE user_id = ?1 LIMIT 1`).bind(s.user.id).first();
  if (busy) return json({ ok: false, error: "seat_or_application" }, 409);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET wallet = NULL WHERE id = ? AND wallet = ?").bind(s.user.id, s.user.wallet),
    env.DB.prepare("UPDATE sessions SET wallet = NULL, proven_at = NULL WHERE user_id = ?").bind(s.user.id),
  ]);
  console.log("wallet unlinked");
  return json({ ok: true });
}

const ROUTES = {
  "/api/me/wallet/link": ["POST", handleLink],
  "/api/me/wallet/carry": ["POST", handleCarryStart],
  "/api/me/wallet/carry/info": ["POST", handleCarryInfo],
  "/api/me/wallet/carry/claim": ["POST", handleCarryClaim],
  "/api/me/wallet/carry/status": ["GET", handleCarryStatus],
  "/api/me/wallet/unlink": ["POST", handleUnlink],
};

/** Every /api/me/wallet/* request (src/index.js, only while SIGNUP_FLOW=v2). */
export async function routeWalletLink(request, env, now = Date.now(), cf = request.cf) {
  const route = ROUTES[new URL(request.url).pathname];
  if (!route) return json({ ok: false, error: "not_found" }, 404);
  if (request.method !== route[0]) return json({ error: "method_not_allowed" }, 405);
  if (request.method !== "GET" && !sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  if (!env.DB) return json({ ok: false, error: "accounts_unavailable" }, 503);
  try { await ensureOnboardSchema(env.DB); }
  catch (e) {
    console.error("wallet link tables unavailable", String((e && e.message) || e));
    return json({ ok: false, error: "link_unavailable" }, 503);
  }
  return route[1](request, env, { now, cf });
}
