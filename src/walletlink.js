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
 *   POST /api/me/wallet/carry { app }                           phone Safari / Chrome: a one-time code that opens the link inside the
 *                                                               wallet app's browser (same phone, 10 minutes)
 *   POST /api/me/wallet/carry/info { code, opener? }            the wallet app's page, before the person confirms: check number, whose
 *                                                               account; the FIRST browser that asks becomes the code's only opener
 *   POST /api/me/wallet/carry/claim { code, address, message, signature, opener?, app? }   that browser links the wallet and gets its
 *                                                               own session: the person stays in the wallet app, on the dashboard
 *   GET  /api/me/wallet/carry/status?ref=                       Safari asks what became of its code: waiting | opened | linked |
 *                                                               expired | replaced | contested | refused
 *   POST /api/me/wallet/unlink                                  take the wallet off the account (a fresh proof by that wallet; not with a live seat)
 *   POST /api/me/wallet/disown                                  "Wasn't you? Remove it": the older browser takes a wallet linked from
 *                                                               another app off the account, and logs out every other browser (7 days)
 *
 * PHONES LIVE INSIDE THE WALLET APP (the owner's plan, 10 Oct 2026): Safari's "Connect Phantom" makes a code, Phantom opens Vicinity on
 * it, the person signs once, and Phantom's own browser is signed in on the dashboard. WHY a session in the wallet app adds nothing:
 * once a wallet is linked, whoever holds it can sign its owner in anywhere (POST /api/auth/wallet). The claimer has just proven they
 * hold the wallet being linked, so a second later they could have signed in anyway. The only real question is WHO MAY LINK a wallet
 * to this account with this code. A code is 192 random bits, kept only as a hash, used once, and bound to:
 *   - the FIRST browser that opens it (carry/info): the __Host-vlo cookie (HttpOnly, Secure, Path=/, no Domain: no other site or
 *     sub-domain can set it) and the same nonce handed back in the answer for wallet browsers that drop cookies. Only that browser
 *     gets the statement (/api/message) and may claim. A second browser presenting a bound code KILLS it ("contested": Safari says
 *     so and makes a new one), so someone who saw the link can never quietly win the race;
 *   - the CONNECTION (the IPv4 address or the IPv6 /64, as a salted hash: src/limits.js clientKey), except behind a relay. iCloud
 *     Private Relay (and Cloudflare WARP) hides Safari's connection and Phantom's browser is not on it, so nothing could match: such a
 *     code (net = 'relay') is bound instead to Safari's COUNTRY (a relay keeps it: a speed bump, not a proof; never opened from a server
 *     or a commercial VPN, src/network.js VPN_NETWORK_RE) and must be OPENED within 2 minutes. Only a relay network's own ASN qualifies
 *     (src/network.js RELAY_ASNS; a cloud server named "Akamai" does not), only for wallet apps with real app links (Phantom, Solflare,
 *     Backpack), and CARRY_RELAY=off (src/flags.js) switches it back to pairing, the relay codes already handed out included.
 * What nothing can prove behind a relay: that Safari and the wallet app are the same phone. Someone talked into forwarding their own
 * fresh link to a person in the same country, who opens it within 2 minutes, can link THEIR wallet to the account. So for 7 days an
 * older browser of the account (Safari) sees "Connected in Phantom. Wasn't you? Remove it" (handleDisown), e-mail accounts get an
 * e-mail, and the sessions that wallet made may not change the password, e-mail, username or home community, or unlink (linkLocked)
 * meanwhile; the owner's own logins can (a username change from an older browser needs only a fresh login then: ownerFresh).
 *
 * The statement a wallet signs names the account ("Link this wallet to my Vicinity account @handle", src/solana.js), so a
 * signature made for one account can never link the wallet to another, and a login statement never links (src/auth.js
 * walletProven answers use_link to one while signed in without a wallet). Nothing here logs an address, a code or a hash in clear.
 */
import { clearCookie, cookie, getCookie, json, randomToken, readJson, sameSite, sha256 } from "./http.js";
import { SESSION_COOKIE, SESSION_SECONDS } from "./session.js";
import { dropSession, getSession, isFresh } from "./auth.js";
import { checkSigned } from "./signed.js";
import { ensureOnboardSchema } from "./store.js";
import { RELAY_ASNS, VPN_NETWORK_RE, isRelayNetwork } from "./network.js";
import { check, clientKey, limitKey } from "./limits.js";
import { TERMS_VERSION } from "./signup-core.js";
import { carryRelayOn, v2On } from "./flags.js";
import { emailConfigured, sendMail, walletLinkedEmail } from "./mail.js";
import { DAY, HOUR, POLICY, iso } from "./policy.js";
import { clearPasswordSince, passwordSetSince } from "./pwlogin.js";

const MINUTES = 10; // an "Open app" code lives 10 minutes (like the location hand-off and a pairing code)
export const RELAY_OPEN_MS = 2 * 60_000; // a relay code must be OPENED within 2 minutes (then it can be claimed for the rest of its 10)
export const OPENER_COOKIE = "__Host-vlo"; // the first browser that opened a code (a random nonce; only its hash is stored)
export const NOTE_MS = 7 * DAY; // "Wasn't you? Remove it" works this long after a wallet came from another browser (app or pair)
// How many tries, per hour (counted BEFORE the work, atomically: src/limits.js).
const LIMITS = {
  link: { user: 10, ip: 30 },
  carry: { user: 10, ip: 30 },   // codes made (a relay code counts only per person: strangers share one relay exit)
  info: { ip: 60 },              // codes looked at (the wallet app's page asks once before the person confirms)
  claim: { ip: 30 },             // codes tried (a code is 192 random bits: this only keeps the noise down)
  disown: { user: 10 },
};
/** public/wallets.js KNOWN ids: the wallet app a link was made in is remembered by one of these (never free text). */
export const WALLET_APPS = new Set(["phantom", "solflare", "backpack", "okx", "coinbase", "trust", "bitget", "magiceden", "exodus", "jupiter",
  "binance", "nightly", "coin98", "tokenpocket", "safepal", "brave"]);
/** The wallet apps whose open() is a real universal / app link (a code in it never lands on a stranger's web page by design): relay codes only for these. */
const UL_APPS = new Set(["phantom", "solflare", "backpack"]);

const maskWallet = (w) => `${w.slice(0, 4)}…${w.slice(-4)}`;
/** A name as the wallet app's page may show it before the person confirms: enough to recognise their own ("Sa•••"), no more. */
export const maskName = (n) => { const a = Array.from(String(n || "").trim()); return a.length ? `${a.slice(0, a.length > 3 ? 2 : 1).join("")}•••` : "•••"; };
/** The account as the link statement names it: the username (every v2 account has one; an old account without one is named by its number). */
export const accountName = (u) => (u.handle && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(u.handle) ? u.handle : `member${u.id}`);
const appOf = (x) => (typeof x === "string" && WALLET_APPS.has(x) ? x : null);

const badJson = () => json({ ok: false, error: "bad_json" }, 400);
const badSigned = (error, status = 400) => ({ error: json({ ok: false, error }, status) });
const perHour = async (env, kind, value, max) => ({ key: await limitKey(env, kind, value), windowMs: HOUR, max });
/** Count one try on each counter (atomically, before the work). Returns a 429 Response when any is over its maximum, else null. */
async function limited(env, now, specs) {
  const r = await check(env, specs, now);
  return r.ok ? null : json({ ok: false, error: "slow_down" }, 429);
}

/* ---------------- after a link from another browser: the 7 days of "Wasn't you? Remove it" ---------------- */

/** The account's wallet came from ANOTHER browser (a wallet app's claim, or a pairing a wallet app approved) less than 7 days ago. */
export const linkWindow = (u, now) => Boolean(u && u.wallet && (u.wallet_via === "app" || u.wallet_via === "pair") && u.wallet_at && now - Date.parse(u.wallet_at) < NOTE_MS);
/**
 * May this session say "that wasn't me" about the account's wallet? A session made BEFORE the link, or never proven by a wallet (a Google,
 * e-mail or password login). That includes the browser that FINISHED a pairing (Safari's poll, a computer's QR screen): finishing proves
 * nothing about whose wallet approved it (whoever held the pair code could have approved first), and on a phone's pairing fallback that
 * Safari is the owner's only older browser: it keeps "Wasn't you? Remove it" (the masked wallet says which one).
 */
export const mayDisown = (s, u) => Boolean(s && u && u.wallet_at && (s.created_at < u.wallet_at || !s.proven_at));
/**
 * During those 7 days, the sessions the linked wallet made (the wallet app's claim session, and any wallet sign-in since) may not change
 * the password (without the current one), the e-mail, the username or the home community, or unlink: so a stranger who linked their
 * wallet with a forwarded link can't lock the owner out, take their name or move their home before the owner sees "Remove it" (and
 * can't unlink to hide the notice and link again quietly). A session made since the link by Google, e-mail or a password (never proven by
 * a wallet) is the owner's own: not locked. Answers 403 link_new where it applies (src/me.js, src/pwlogin.js, handleUnlink).
 */
export const linkLocked = (s, now) => Boolean(s && s.user && linkWindow(s.user, now) && s.created_at >= s.user.wallet_at && s.proven_at);
export const lockedAnswer = (u) => json({ ok: false, error: "link_new", until: iso(Date.parse(u.wallet_at) + NOTE_MS), ...(u.wallet_app ? { app: u.wallet_app } : {}) }, 403);
/**
 * The owner's way through those 7 days: an older browser of the account (mayDisown: Safari, where the person was logged in before) can't
 * prove the linked wallet (it may be a stranger's, and on a phone it lives in the wallet app, whose sessions are the locked ones), so a
 * login made there in the last 30 minutes (Google, the e-mail code or a password: the same rule as "Remove it") counts as fresh for a
 * username change instead. ownerCould: this browser could, once it logs in again (the page offers "Log in again", not the wallet app).
 */
export const ownerCould = (s, now) => Boolean(s && s.user && linkWindow(s.user, now) && mayDisown(s, s.user));
export const ownerFresh = (s, now) => ownerCould(s, now) && now - Date.parse(s.created_at) <= POLICY.freshProofMinutes * 60_000;

/**
 * Link `wallet` to the account of session `s`: ONE transaction. The account takes the wallet only while it has none and nobody
 * else has this one (the UNIQUE index is the last guard); then every session of that person carries the wallet (every open
 * dashboard sees it), and only THIS session, the one that proved it, gets the proof time. `via` says how ('page' | 'pair' | 'transfer')
 * and is kept with the time (users.wallet_at / wallet_via): a pairing approved in a wallet app gets the 7 days of "Remove it". Returns
 * { ok } (also when this very wallet was already the account's: idempotent, and the proof is renewed), or { error, status, wallet? }:
 * has_wallet (the account has another one; masked), wallet_taken (another account has this one). Logs the link, masked.
 */
export async function linkWallet(env, s, wallet, now, via = "page") {
  await ensureOnboardSchema(env.DB); // users.wallet_at / wallet_via (a transfer or a login route may be the first v2 request of a cold server)
  let r;
  try {
    r = await env.DB.batch([
      env.DB.prepare("UPDATE users SET wallet = ?1, wallet_at = ?3, wallet_via = ?4, wallet_app = NULL WHERE id = ?2 AND wallet IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE wallet = ?1)")
        .bind(wallet, s.user.id, iso(now), via),
      env.DB.prepare(`UPDATE sessions SET wallet = ?1, proven_at = CASE WHEN id = ?3 THEN ?4 ELSE proven_at END
          WHERE user_id = ?2 AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND wallet = ?1)`).bind(wallet, s.user.id, s.id, iso(now)),
    ]);
  } catch (e) {
    if (!/UNIQUE/i.test(String((e && e.message) || e))) throw e;
    return { error: "wallet_taken", status: 409 };
  }
  if (r[0].meta.changes === 1) {
    console.log("wallet linked", maskWallet(wallet), ...(via === "page" ? [] : [`(${via})`]));
    return { ok: true };
  }
  const u = await env.DB.prepare("SELECT wallet FROM users WHERE id = ?").bind(s.user.id).first();
  if (u && u.wallet === wallet) return { ok: true, already: true };
  if (u && u.wallet) return { error: "has_wallet", status: 409, wallet: maskWallet(u.wallet) };
  return { error: "wallet_taken", status: 409 };
}

/**
 * The short e-mail "Phantom (wallet Abcd…wxyz) was connected to your Vicinity account", for a link made in ANOTHER browser (app or
 * pair). The address is read here, inside the request, before the answer: an e-mail account's own address, else a verified contact
 * e-mail; a Google account without one gets only the dashboard notice. Only the sending runs after the answer (ctx.waitUntil; without a
 * ctx, in tests, it is awaited). A failed mail is logged without the address and never fails the link.
 */
export async function linkNotice(env, u, wallet, app, ctx = null, fetchImpl = fetch) {
  const to = u && (u.provider === "email" ? u.provider_id : u.contact_email);
  if (!to || !emailConfigured(env)) return;
  const { subject, text, html } = walletLinkedEmail(maskWallet(wallet), app);
  const p = sendMail(env, { to, subject, text, html }, { fetchImpl })
    .then((r) => { if (!r.ok) console.error("wallet link notice not sent", r.error); })
    .catch((e) => console.error("wallet link notice failed", String((e && e.message) || e).slice(0, 80)));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
}

/* ---------------- the "Open app" code: Safari → the wallet app's browser, same phone ---------------- */

/** The connection a code is bound to: a salted hash of the IPv4 address or of the IPv6 /64 (src/limits.js clientKey), never the address. */
const carryNet = (env, request) => limitKey(env, "carryip", clientKey(request));
/** The country of a relay connection, as Cloudflare saw it (two letters; not XX "unknown" or T1 Tor), or null. */
export const relayCountry = (cf) => { const c = String((cf && cf.country) || "").toUpperCase(); return /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : null; };
/**
 * A server or a commercial VPN (src/network.js VPN_NETWORK_RE: AWS, Datacamp, NordVPN...): never the wallet app's browser on the phone that
 * made a relay code (that one is on the phone's own mobile data or Wi-Fi, or on the same relay), but the easiest way for someone ELSE to
 * meet the country bind. A relay code refuses such an opener like one from another country.
 */
const hostedNetwork = (cf) => Boolean(cf && VPN_NETWORK_RE.test(String(cf.asOrganization || "")));
/** A relay by its OWN network number (iCloud Private Relay's Cloudflare / Akamai / Fastly exits, WARP): a cloud server merely named "Akamai" is not one. */
const relayAsn = (cf) => Boolean(cf && RELAY_ASNS.has(Number(cf.asn)));
/** The two-digit check number of a code (the same on both screens, derived from the code: nothing more to store). */
async function carryPin(code) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`carry-pin\n${code}`)));
  return String(10 + (((h[0] << 8) | h[1]) % 90));
}
/** A short handle on a code (a prefix of its stored hash), so Safari can ask what became of it and tell when another tab replaced it. */
const carryRef = (id) => String(id).slice(0, 12);
/** The opener nonces this browser presents: the HttpOnly cookie and the copy its page kept (wallet browsers that drop cookies), well-formed ones only. */
const NONCE = /^[A-Za-z0-9_-]{32}$/;
const presented = (request, kept) => [getCookie(request, OPENER_COOKIE), kept].filter((c, i, all) => typeof c === "string" && NONCE.test(c) && all.indexOf(c) === i);
const openerHash = (nonce) => sha256(`vlo\n${nonce}`);

const findCarry = async (env, code, now) => {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{32,64}$/.test(code)) return null;
  const row = await env.DB.prepare("SELECT * FROM handoffs WHERE id = ? AND kind = 'carry' AND purpose = 'link' AND (result IS NULL OR result = 'opened')").bind(await sha256(code)).first();
  return row && Date.parse(row.expires_at) > now ? row : null;
};

/**
 * A live code that this browser may use, and the account it links to: { row, owner, relay } or { error: Response }. In order: the code is
 * unknown, used, contested or old, or a relay code while CARRY_RELAY=off → carry_expired (410); another connection's (for a relay code:
 * another country's, or a server's or a commercial VPN's) → carry_network (403, relay: true for a relay code): nothing is bound, the code
 * stays usable from the right connection, and a code nobody opened yet is marked (refused_at) so Safari can say so (an ordinary code: the
 * wallet app is on another connection, the pairing becomes the button; a relay code: rarely the person, so a new link is the button and
 * the pairing stays the quiet way); the owner linked a wallet meanwhile → link_done (409); then the opener: a code another browser opened → carry_opened (403),
 * and that browser's code dies (contested); `mode` "use" (the statement, the claim) needs a code this very browser opened (carry_opened
 * otherwise); "open" (info) of a relay code nobody opened within 2 minutes → carry_expired.
 */
async function usableCarry(env, request, code, now, cf, mode, nonces) {
  const row = await findCarry(env, code, now);
  if (!row) return { error: json({ ok: false, error: "carry_expired" }, 410) };
  const relay = row.net === "relay";
  // CARRY_RELAY=off is the emergency stop: a relay code handed out before the switch is dead from the next request too, opened or not
  // (its look, its statement and its claim); Safari's status says it ran out, and a new tap pairs (handleCarryStart)
  if (relay && !carryRelayOn(env)) return { error: json({ ok: false, error: "carry_expired", relay: true }, 410) };
  if (relay ? relayCountry(cf) !== row.country || hostedNetwork(cf) : row.net !== await carryNet(env, request)) {
    if (!row.opener && !row.refused_at) await env.DB.prepare("UPDATE handoffs SET refused_at = ? WHERE id = ? AND opener IS NULL AND refused_at IS NULL").bind(iso(now), row.id).run();
    return { error: json({ ok: false, error: "carry_network", ...(relay ? { relay: true } : {}) }, 403) };
  }
  const owner = await env.DB.prepare("SELECT id, handle, name, wallet, home_name, home_country, provider, provider_id, contact_email FROM users WHERE id = ?").bind(row.user_id).first();
  if (!owner) return { error: json({ ok: false, error: "carry_expired" }, 410) };
  if (owner.wallet) return { error: json({ ok: false, error: "link_done" }, 409) };
  if (row.opener) {
    if (!(await Promise.all(nonces.map(openerHash))).includes(row.opener)) {
      await env.DB.prepare("UPDATE handoffs SET result = 'contested' WHERE id = ? AND result = 'opened'").bind(row.id).run();
      console.log("link code contested");
      return { error: json({ ok: false, error: "carry_opened" }, 403) };
    }
  } else if (mode === "use") return { error: json({ ok: false, error: "carry_opened" }, 403) };
  else if (relay && now - Date.parse(row.created_at) >= RELAY_OPEN_MS) return { error: json({ ok: false, error: "carry_expired", relay: true }, 410) };
  return { row, owner, relay };
}

/**
 * The account a "link" statement is for, for GET /api/message?action=link: the signed-in person's own (the dashboard), or, with
 * ?code= (the wallet app's browser), the owner of a live code THIS browser opened (cookie, or &opener=), or, with ?pair= (a wallet app
 * approving for another device), the owner of a live link pairing. Returns { handle } or { error, status } or { response }.
 */
export async function linkAccountFor(request, env, now = Date.now(), cf = request.cf) {
  if (!v2On(env)) return { error: "bad_request", status: 400 };
  try { await ensureOnboardSchema(env.DB); }
  catch (e) { console.error("wallet link tables unavailable", String((e && e.message) || e)); return { error: "link_unavailable", status: 503 }; }
  const q = new URL(request.url).searchParams;
  if (q.get("code")) {
    const u = await usableCarry(env, request, q.get("code"), now, cf, "use", presented(request, q.get("opener")));
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
  const linked = await linkWallet(env, s, r.parsed.address, x.now, "page");
  if (linked.error) return json({ ok: false, error: linked.error, ...(linked.wallet ? { wallet: linked.wallet } : {}) }, linked.status);
  return json({ ok: true, wallet: r.parsed.address, provenAt: iso(x.now), fresh: true });
}

/**
 * POST /api/me/wallet/carry { app }: phone Safari / Chrome asks for the one-time code that opens the link inside the wallet app `app` (a
 * KNOWN id). On an ordinary connection the code is bound to it; behind a relay (iCloud Private Relay, WARP: their own network numbers)
 * with a known country, for a wallet app with a real app link, it is a RELAY code instead (relay: true, openBy); otherwise 409
 * carry_relay and the page pairs ("approve in the wallet app, finish here"), as it always did.
 */
async function handleCarryStart(request, env, x) {
  const s = await getSession(env, request, x.now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  if (s.user.wallet) return json({ ok: false, error: "has_wallet", wallet: maskWallet(s.user.wallet) }, 409);
  const body = (await readJson(request)) || {};
  let relay = false, country = null;
  if (isRelayNetwork(x.cf)) {
    country = relayCountry(x.cf);
    if (!carryRelayOn(env) || !relayAsn(x.cf) || !country || !UL_APPS.has(appOf(body.app))) return json({ ok: false, error: "carry_relay" }, 409);
    relay = true;
  }
  const over = await limited(env, x.now, [
    await perHour(env, "wcs", s.user.id, LIMITS.carry.user),
    ...(relay ? [] : [await perHour(env, "wci", clientKey(request), LIMITS.carry.ip)]), // a relay exit is shared by strangers: per person only
  ]);
  if (over) return over;
  const code = randomToken(24), until = x.now + MINUTES * 60_000, id = await sha256(code);
  await env.DB.batch([
    // one live code per person: a new tap replaces the one before (a code already used stays: it tells Safari what happened)
    env.DB.prepare("DELETE FROM handoffs WHERE kind = 'carry' AND ((user_id = ? AND (result IS NULL OR result IN ('opened', 'contested'))) OR expires_at < ?)").bind(s.user.id, iso(x.now)),
    env.DB.prepare("INSERT INTO handoffs (id, kind, user_id, purpose, net, country, created_at, expires_at) VALUES (?, 'carry', ?, 'link', ?, ?, ?, ?)")
      .bind(id, s.user.id, relay ? "relay" : await carryNet(env, request), country, iso(x.now), iso(until)),
  ]);
  return json({ ok: true, code, pin: await carryPin(code), ref: carryRef(id), url: `${new URL(request.url).origin}/connect?link=${code}`, expiresAt: iso(until),
    ...(relay ? { relay: true, openBy: iso(x.now + RELAY_OPEN_MS) } : {}) });
}

/**
 * POST /api/me/wallet/carry/info { code, opener? }: what the wallet app's page shows BEFORE anything happens, so the person can tell it is
 * their own account: the check number Safari shows, the account (the name masked, the @username in full: only this browser can get the
 * statement that names it anyway) and its community, and `here` when this browser is logged in to SOMEONE ELSE's account (masked).
 * The first browser that asks is bound to the code, atomically, only after every check passed (its nonce: the __Host-vlo cookie and
 * `opener` in the answer); asking again from it is fine. A refusal sets no cookie.
 */
async function handleCarryInfo(request, env, x) {
  const body = await readJson(request);
  if (!body) return badJson();
  const over = await limited(env, x.now, [await perHour(env, "wcv", clientKey(request), LIMITS.info.ip)]);
  if (over) return over;
  const nonces = presented(request, body.opener);
  const u = await usableCarry(env, request, body.code, x.now, x.cf, "open", nonces);
  if (u.error) return u.error;
  const mine = nonces[0] || randomToken(24);
  if (!u.row.opener) {
    const h = await openerHash(mine);
    // the bind repeats the checks in its own WHERE (no opener yet, still live, a relay code within its 2 minutes): usableCarry checked them
    // with this same clock, so this only matters if that read was stale (a racing call, a read replica): then nothing is bound
    const bound = await env.DB.prepare(`UPDATE handoffs SET opener = ?1, result = COALESCE(result, 'opened') WHERE id = ?2 AND opener IS NULL AND (result IS NULL OR result = 'opened')
        AND expires_at > ?3 AND (net <> 'relay' OR created_at > ?4)`).bind(h, u.row.id, iso(x.now), iso(x.now - RELAY_OPEN_MS)).run();
    if (bound.meta.changes !== 1) {
      const now = await env.DB.prepare("SELECT opener FROM handoffs WHERE id = ?").bind(u.row.id).first();
      if (!now || !now.opener) return json({ ok: false, error: "carry_expired", ...(u.relay ? { relay: true } : {}) }, 410);
      if (now.opener !== h) { // another browser was faster by a hair: it is the opener, and two openers mean the link is out: dead
        await env.DB.prepare("UPDATE handoffs SET result = 'contested' WHERE id = ? AND result = 'opened'").bind(u.row.id).run();
        return json({ ok: false, error: "carry_opened" }, 403);
      }
    }
  }
  const s = await getSession(env, request, x.now);
  const shown = u.owner.name || u.owner.handle || "";
  const here = s && s.user && s.user.id !== u.owner.id ? maskName(s.user.handle || s.user.name) : null;
  return json({
    ok: true, pin: await carryPin(body.code),
    owner: { name: maskName(shown), handle: accountName(u.owner), initial: Array.from(String(shown).trim())[0] || "•" },
    community: u.owner.home_name ? { name: u.owner.home_name, country: u.owner.home_country } : null,
    terms: TERMS_VERSION, expiresAt: u.row.expires_at, relay: u.relay, here, opener: mine,
  }, 200, { "Set-Cookie": cookie(OPENER_COOKIE, mine, MINUTES * 60) });
}

/**
 * POST /api/me/wallet/carry/claim { code, address, message, signature, opener?, app? }: the browser that opened the code, after the person
 * confirmed and signed the link statement that names the owner's account. ONE transaction: the code is used (only by its opener, while
 * the owner still has no wallet and nobody has this one), the account takes the wallet (wallet_at, wallet_via 'app', the app), every
 * session of the owner carries it (Safari's dashboard updates by itself), and this browser gets its own 30-day session, proven now: the
 * person stays in the wallet app, on the dashboard. A browser signed in as somebody else is refused (already_signed_in) BEFORE the
 * signature is used: its page logs it out on an explicit tap and claims again with the same code. The owner's own earlier session in
 * this browser is replaced, but only once the link went through: a refused claim (wallet_taken, link_done, carry_*) leaves this browser
 * exactly as it was. E-mail accounts get a short e-mail.
 */
async function handleCarryClaim(request, env, x) {
  const session = await getSession(env, request, x.now);
  const body = await readJson(request);
  if (!body) return badJson();
  const over = await limited(env, x.now, [await perHour(env, "wcc", clientKey(request), LIMITS.claim.ip)]);
  if (over) return over;
  const u = await usableCarry(env, request, body.code, x.now, x.cf, "use", presented(request, body.opener));
  if (u.error) return u.error;
  if (session && session.user && session.user.id !== u.owner.id) return json({ ok: false, error: "already_signed_in" }, 409);
  const r = await checkSigned(body, request, x.now, ["link"], badSigned, env.DB);
  if (r.error) return r.error;
  if (r.parsed.pin || r.parsed.handle !== accountName(u.owner)) return json({ ok: false, error: "bad_message" }, 400);
  const wallet = r.parsed.address, app = appOf(body.app), at = iso(x.now);
  const token = randomToken(32), sid = await sha256(token);
  let res;
  try {
    res = await env.DB.batch([
      // 1. the code is used, once, by its opener, and only while the owner has no wallet and nobody has this one (otherwise nothing is consumed)
      env.DB.prepare(`UPDATE handoffs SET result = 'linked', wallet = ?1 WHERE id = ?2 AND kind = 'carry' AND result = 'opened' AND opener = ?5 AND expires_at > ?3
          AND EXISTS (SELECT 1 FROM users WHERE id = ?4 AND wallet IS NULL) AND NOT EXISTS (SELECT 1 FROM users WHERE wallet = ?1)`)
        .bind(wallet, u.row.id, at, u.owner.id, u.row.opener),
      // 2. the account takes the wallet, only if 1 happened (the UNIQUE index is the last guard), and remembers when, how and in which app
      env.DB.prepare(`UPDATE users SET wallet = ?1, wallet_at = ?4, wallet_via = 'app', wallet_app = ?5 WHERE id = ?2 AND wallet IS NULL
          AND EXISTS (SELECT 1 FROM handoffs WHERE id = ?3 AND result = 'linked' AND wallet = ?1)`).bind(wallet, u.owner.id, u.row.id, at, app),
      // 3. every session of the owner carries the wallet; none of them is a proof (only the browser that signed gets one: 4)
      env.DB.prepare("UPDATE sessions SET wallet = ?1 WHERE user_id = ?2 AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND wallet = ?1)").bind(wallet, u.owner.id),
      // 4. this browser's own 30-day session, proven now, made by the wallet (renewed while it is used: src/auth.js renewSession)
      env.DB.prepare(`INSERT INTO sessions (id, wallet, user_id, proof, created_at, expires_at, proven_at, made_by)
          SELECT ?1, ?2, ?3, NULL, ?4, ?5, ?4, 'wallet' WHERE EXISTS (SELECT 1 FROM users WHERE id = ?3 AND wallet = ?2)`)
        .bind(sid, wallet, u.owner.id, at, iso(x.now + SESSION_SECONDS * 1000)),
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
  if (session) await dropSession(env, session.id); // the owner's own earlier session here, or a pending proof: replaced by the one just made
  console.log("wallet linked", maskWallet(wallet), "(wallet app)");
  await linkNotice(env, u.owner, wallet, app, x.ctx, x.fetchImpl);
  return json({ ok: true, wallet, ...(app ? { app } : {}), next: "/dashboard?linked=1" }, 200,
    { "Set-Cookie": [cookie(SESSION_COOKIE, token, SESSION_SECONDS), clearCookie(OPENER_COOKIE)] });
}

/** GET /api/me/wallet/carry/status?ref= (Safari, signed in): what became of its code, and the wallet app that linked it. */
async function handleCarryStatus(request, env, x) {
  const s = await getSession(env, request, x.now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  const ref = String(new URL(request.url).searchParams.get("ref") || "");
  if (!/^[A-Za-z0-9_-]{12}$/.test(ref)) return json({ ok: false, error: "bad_ref" }, 400);
  if (s.user.wallet) return json({ ok: true, status: "linked", wallet: s.user.wallet, ...(s.user.wallet_app ? { app: s.user.wallet_app } : {}) });
  const row = await env.DB.prepare("SELECT id, result, wallet, net, opener, refused_at, created_at, expires_at FROM handoffs WHERE kind = 'carry' AND user_id = ? AND substr(id, 1, 12) = ?").bind(s.user.id, ref).first();
  if (!row) {
    const newer = await env.DB.prepare("SELECT id FROM handoffs WHERE kind = 'carry' AND user_id = ? AND (result IS NULL OR result = 'opened') AND expires_at > ?").bind(s.user.id, iso(x.now)).first();
    return json({ ok: true, status: newer ? "replaced" : "expired" });
  }
  if (row.result === "linked") return json({ ok: true, status: "linked", wallet: row.wallet });
  if (row.result === "contested") return json({ ok: true, status: "contested" });
  if (Date.parse(row.expires_at) <= x.now) return json({ ok: true, status: "expired" });
  if (row.net === "relay" && (!carryRelayOn(env) || (!row.opener && x.now - Date.parse(row.created_at) >= RELAY_OPEN_MS))) return json({ ok: true, status: "expired", relay: true }); // (CARRY_RELAY=off: usableCarry)
  // the wallet app opened it, but on another connection (Wi-Fi vs mobile data): still waiting, and Safari says why and offers the pairing
  // (it works on any connection) instead of "Phantom didn't open?". A relay code opened in another country or from a server or a VPN:
  // rarely the person, so Safari says so neutrally and offers a new link first (public/signup.js carryRefused)
  if (!row.opener && row.refused_at) return json({ ok: true, status: "refused", ...(row.net === "relay" ? { relay: true } : {}) });
  return json({ ok: true, status: row.result === "opened" ? "opened" : "waiting" });
}

/**
 * POST /api/me/wallet/unlink: take the wallet off the account. Needs a fresh proof by that very wallet (a login alone is not
 * enough once a wallet is linked), and refuses while the person holds a live founder seat, an open application or a squad
 * place (seat_or_application: resign or withdraw first). Every session of the person loses the wallet and its proof. In the 7 days after
 * a link from another browser, a session that wallet made may not (link_new): the owner's "Remove it" is the way then.
 */
async function handleUnlink(request, env, x) {
  const s = await getSession(env, request, x.now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  if (!s.user.wallet) return json({ ok: false, error: "no_wallet" }, 409);
  if (linkLocked(s, x.now)) return lockedAnswer(s.user);
  if (!(s.proven_at && isFresh(s, x.now) && s.wallet === s.user.wallet)) return json({ ok: false, error: "reprove" }, 403);
  const busy = await env.DB.prepare(`SELECT 1 AS x FROM seats WHERE user_id = ?1 AND status IN ('provisional', 'active', 'grace', 'steward')
      UNION ALL SELECT 1 FROM applications a JOIN windows w ON w.id = a.window_id WHERE a.user_id = ?1 AND a.withdrawn = 0 AND w.status = 'open'
      UNION ALL SELECT 1 FROM squad_members WHERE user_id = ?1 LIMIT 1`).bind(s.user.id).first();
  if (busy) return json({ ok: false, error: "seat_or_application" }, 409);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET wallet = NULL, wallet_at = NULL, wallet_via = NULL, wallet_app = NULL WHERE id = ? AND wallet = ?").bind(s.user.id, s.user.wallet),
    env.DB.prepare("UPDATE sessions SET wallet = NULL, proven_at = NULL WHERE user_id = ?").bind(s.user.id),
  ]);
  console.log("wallet unlinked");
  return json({ ok: true });
}

/**
 * POST /api/me/wallet/disown: "Wasn't you? Remove it". In the 7 days after a wallet joined the account from ANOTHER browser (a wallet
 * app's claim, or a pairing), an older browser of the account (made before the link, or by Google, e-mail or a password) takes it off
 * WITHOUT that wallet's proof, and with it what would let a stranger stay in or keep a hold on the account: every other session of the
 * account (the wallet app's, any wallet sign-in, a password login made with a password set meanwhile), a password set since the link, the
 * live link codes and link pairings, and whatever the account joined since the link (a seat is voided with a neutral public record and no
 * cooldown, an application withdrawn, a squad place left; a squad left empty is disbanded). What such a session merely SAID or did in
 * public meanwhile stays (posts, check-ins, votes, endorsements: the owner can delete their posts); the lock (linkLocked) is what keeps
 * the password, the e-mail, the home community and the wallet itself out of its reach. Only from a login made in the last 30 minutes (a stolen
 * old cookie can't): 403 relogin otherwise, and the page logs in again. Refused: too_late (more than 7 days, or the link was made in this
 * very way of the account's own: page or transfer), not_allowed (this session is the wallet's own), seat_or_application (a seat,
 * application or squad place from BEFORE the link: never on an account that had no wallet). Logs the masked wallet only.
 */
async function handleDisown(request, env, x) {
  const s = await getSession(env, request, x.now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  const u = s.user;
  if (!u.wallet) return json({ ok: false, error: "no_wallet" }, 409);
  if (!linkWindow(u, x.now)) return json({ ok: false, error: "too_late" }, 409);
  if (!mayDisown(s, u)) return json({ ok: false, error: "not_allowed" }, 403);
  if (x.now - Date.parse(s.created_at) > POLICY.freshProofMinutes * 60_000) return json({ ok: false, error: "relogin" }, 403);
  const over = await limited(env, x.now, [await perHour(env, "wdo", u.id, LIMITS.disown.user)]);
  if (over) return over;
  const wa = u.wallet_at;
  const older = await env.DB.prepare(`SELECT 1 AS x FROM seats WHERE user_id = ?1 AND status IN ('provisional', 'active', 'grace', 'steward') AND created_at < ?2
      UNION ALL SELECT 1 FROM applications a JOIN windows w ON w.id = a.window_id WHERE a.user_id = ?1 AND a.withdrawn = 0 AND w.status = 'open' AND a.created_at < ?2
      UNION ALL SELECT 1 FROM squad_members WHERE user_id = ?1 AND joined_at < ?2 LIMIT 1`).bind(u.id, wa).first();
  if (older) return json({ ok: false, error: "seat_or_application" }, 409);
  // every statement runs only while the account still has THIS wallet from THIS link (the users UPDATE is last): a second "Remove it" at
  // the same moment, or a link that changed meanwhile, changes nothing at all
  const still = "EXISTS (SELECT 1 FROM users WHERE id = ?1 AND wallet = ?2 AND wallet_at = ?3)";
  const now = iso(x.now);
  const q = (sql, ...more) => env.DB.prepare(sql).bind(u.id, u.wallet, wa, ...more);
  const res = await env.DB.batch([
    // a seat taken since the link: voided (no cooldown for the owner), with a public record like any ended seat. A NEUTRAL one: no actor
    // (the public log, /api/audit, never names the member as the victim of anything, and src/elections.js credits moderation service
    // by actor: nobody gains from it), and words that say only what happened to the seat
    q(`INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, target_user, country, place, reason, note, created_at, state)
        SELECT NULL, 'system', 'void_seat', 'seat', id, ?1, country, city_id, 'wallet_removed', 'Seat ended: the wallet was removed from the account.', ?4, 'done'
        FROM seats WHERE user_id = ?1 AND status IN ('provisional', 'active', 'grace', 'steward') AND created_at >= ?3 AND ${still}`, now),
    q(`UPDATE squads SET status = 'disbanded' WHERE status = 'seated' AND id IN (SELECT a.squad_id FROM seats st JOIN applications a ON a.id = st.application_id
        WHERE st.user_id = ?1 AND st.status IN ('provisional', 'active', 'grace', 'steward') AND st.created_at >= ?3) AND ${still}`),
    q(`UPDATE seats SET status = 'void', ended_at = ?4, end_reason = 'wallet_disowned' WHERE user_id = ?1 AND status IN ('provisional', 'active', 'grace', 'steward')
        AND created_at >= ?3 AND ${still}`, now),
    // squads joined since the link where nobody else is left: disbanded; then the places themselves, and the applications
    q(`UPDATE squads SET status = 'disbanded' WHERE status IN ('forming', 'ready', 'applied') AND id IN (SELECT squad_id FROM squad_members WHERE user_id = ?1 AND joined_at >= ?3)
        AND NOT EXISTS (SELECT 1 FROM squad_members m WHERE m.squad_id = squads.id AND m.user_id <> ?1) AND ${still}`),
    q(`DELETE FROM squad_members WHERE user_id = ?1 AND joined_at >= ?3 AND ${still}`),
    q(`UPDATE applications SET withdrawn = 1 WHERE user_id = ?1 AND withdrawn = 0 AND created_at >= ?3 AND ${still}`),
    // every other browser out; this one keeps its login, without the wallet; no live link code or link pairing survives
    q(`DELETE FROM sessions WHERE user_id = ?1 AND id <> ?4 AND ${still}`, s.id),
    q(`UPDATE sessions SET wallet = NULL, proven_at = NULL WHERE id = ?4 AND ${still}`, s.id),
    q(`DELETE FROM handoffs WHERE kind = 'carry' AND user_id = ?1 AND (result IS NULL OR result IN ('opened', 'contested')) AND ${still}`),
    q(`DELETE FROM pairs WHERE user_id = ?1 AND purpose = 'link' AND ${still}`),
    // a password set since the link goes (src/pwlogin.js: the owner uses Google, the e-mail code or a reset), then, last, the wallet
    clearPasswordSince(env.DB, u.id, u.wallet, wa),
    q("UPDATE users SET wallet = NULL, wallet_at = NULL, wallet_via = NULL, wallet_app = NULL WHERE id = ?1 AND wallet = ?2 AND wallet_at = ?3"),
  ]);
  if (res[res.length - 1].meta.changes !== 1) return json({ ok: false, error: "too_late" }, 409); // someone was faster: nothing changed
  console.log("wallet disowned", maskWallet(u.wallet));
  const cleared = passwordSetSince(u, wa); // the page says to set a new one (Forgot password)
  return json({ ok: true, ...(cleared ? { passwordCleared: true } : {}) });
}

const ROUTES = {
  "/api/me/wallet/link": ["POST", handleLink],
  "/api/me/wallet/carry": ["POST", handleCarryStart],
  "/api/me/wallet/carry/info": ["POST", handleCarryInfo],
  "/api/me/wallet/carry/claim": ["POST", handleCarryClaim],
  "/api/me/wallet/carry/status": ["GET", handleCarryStatus],
  "/api/me/wallet/unlink": ["POST", handleUnlink],
  "/api/me/wallet/disown": ["POST", handleDisown],
};

/** Every /api/me/wallet/* request (src/index.js, only while SIGNUP_FLOW=v2). ctx.waitUntil sends the link e-mail after the answer. */
export async function routeWalletLink(request, env, now = Date.now(), cf = request.cf, ctx = null, fetchImpl = fetch) {
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
  return route[1](request, env, { now, cf, ctx, fetchImpl });
}
