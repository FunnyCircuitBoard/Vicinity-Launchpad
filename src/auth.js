/**
 * Accounts and sign-in. One person = ONE wallet + ONE Google login or ONE e-mail address, so the aim
 * is that nobody runs a crowd of accounts to spam their city. (X sign-in used to be the second option
 * and was removed.)
 *
 * New person:
 *   1. prove the wallet: sign a free message (or, for apps that can't sign, send yourself a tiny
 *      exact amount of SOL; or sign on your phone for this computer by scanning a code)
 *   2. sign in with Google, or type the 6-digit code we e-mail → the login is linked to the wallet
 *      for good → dashboard
 * Returning person: either the wallet OR the linked Google / e-mail login signs them straight in.
 *
 * Only a hash of the session cookie is stored. From Google we keep the account id and first name
 * (or the display name when there is no first name). For e-mail sign-in we keep the e-mail address
 * itself: it IS the account id. Every new account also gets a made-up username (autoUsername in
 * text.js). No password, ever.
 *
 * Settings (Cloudflare → Workers → vicinity-map → Settings → Variables and secrets):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   Google sign-in
 *   GMAIL_USER + GMAIL_APP_PASSWORD, or      sending the e-mail codes (see mail.js)
 *   RESEND_API_KEY (optional EMAIL_FROM)
 * Redirect address to register with Google: https://vicinity.city/api/auth/google/callback
 */
import { activeMint } from "./official.js";
import { b64url, clearCookie, cookie, getCookie, json, randomToken, readJson, redirect, sameSite, sha256 } from "./http.js";
import { isSolanaAddress } from "./solana.js";
import { checkSigned } from "./signed.js";
import { emailConfigured, sendMail, verificationEmail } from "./mail.js";
import { ensureSchema } from "./store.js";
import { findTransfer } from "./chain.js";
import { POLICY } from "./policy.js";
import { autoUsername } from "./text.js";

export const SESSION_COOKIE = "vs";
const OAUTH_COOKIE = "vo";
const SESSION_SECONDS = 30 * 86400;  // signed in for 30 days
const PENDING_SECONDS = 30 * 60;     // wallet proven, Google / e-mail still to link: 30 minutes
const PAIR_SECONDS = 10 * 60;        // "sign in with my phone" codes: 10 minutes

const iso = (ms) => new Date(ms).toISOString();
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);

function jwtPayload(token) {
  const part = String(token).split(".")[1] || "";
  const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

/**
 * The OAuth ("sign in with ...") providers. Only Google is left: the X entry was removed. Each entry
 * says whether it is configured, where to send the person, and how to turn the returned code into
 * an identity { id, handle, name }.
 */
export const PROVIDERS = {
  google: {
    configured: (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    authorize: (env, { redirectUri, state, challenge }) => "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: "openid profile",
      state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    }),
    async identity(env, { code, redirectUri, verifier }, fetchImpl) {
      const res = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
      });
      const tok = await res.json().catch(() => ({}));
      if (!res.ok || !tok.id_token) throw new Error("google_token_" + res.status);
      // The token comes straight from Google over https, so its contents can be trusted as is.
      const c = jwtPayload(tok.id_token);
      if (c.aud !== env.GOOGLE_CLIENT_ID || !["https://accounts.google.com", "accounts.google.com"].includes(c.iss) || !c.sub) throw new Error("google_bad_token");
      return { id: String(c.sub), handle: null, name: cleanName(c.given_name || c.name) || "Google member" };
    },
  },
};

/**
 * Which sign-in options the page may offer: { google, email }, each true when the server has what it
 * needs (Google keys; a Gmail or Resend mail setup). Sent along with /api/me.
 */
export const providers = (env) => ({
  google: Boolean(PROVIDERS.google.configured(env)),
  email: emailConfigured(env),
});

/* ---------------- sessions ---------------- */

async function createSession(env, { wallet = null, userId = null, proof = null, provenAt = null }, seconds, now) {
  const token = randomToken(32);
  await env.DB.prepare("INSERT INTO sessions (id, wallet, user_id, proof, created_at, expires_at, proven_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256(token), wallet, userId, proof, iso(now), iso(now + seconds * 1000), provenAt).run();
  if (Math.random() < 0.02) { // tidy up now and then
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(iso(now)),
      env.DB.prepare("DELETE FROM pairs WHERE expires_at < ?").bind(iso(now)),
    ]);
  }
  return cookie(SESSION_COOKIE, token, seconds);
}

/** The signed-in session for this request: { id, wallet, user_id, proof, user } or null. */
export async function getSession(env, request, now = Date.now()) {
  if (!env.DB) return null;
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  await ensureSchema(env.DB);
  const s = await env.DB.prepare("SELECT id, wallet, user_id, proof, expires_at, proven_at FROM sessions WHERE id = ?").bind(await sha256(token)).first();
  if (!s || Date.parse(s.expires_at) <= now) return null;
  const user = s.user_id ? await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(s.user_id).first() : null;
  if (s.user_id && !user) return null;
  return { ...s, user };
}
const dropSession = (env, id) => env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
async function dropCurrent(env, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token && token.length <= 100) await dropSession(env, await sha256(token));
}

/** The wallet is proven. A linked wallet signs straight in; a new one has 30 minutes to link Google or an e-mail address. */
async function signInWallet(env, wallet, now) {
  const user = await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(wallet).first();
  const provenAt = iso(now);
  if (user) return { cookie: await createSession(env, { wallet, userId: user.id, provenAt }, SESSION_SECONDS, now), next: "/dashboard" };
  return { cookie: await createSession(env, { wallet, provenAt }, PENDING_SECONDS, now), next: "social" };
}

/** Was the wallet proven in this session within the last 30 minutes? Sensitive actions need that. */
export const isFresh = (session, now = Date.now()) =>
  Boolean(session && session.proven_at && now - Date.parse(session.proven_at) <= POLICY.freshProofMinutes * 60_000);

/**
 * POST /api/auth/reprove { address, message, signature } → "it's still me": the signed-in person signs
 * a login message with THEIR wallet again, which unlocks sensitive actions for 30 minutes.
 */
export async function handleReprove(request, env, now = Date.now()) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const s = await getSession(env, request, now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const r = await checkSigned(body, request, now, ["login"], badSigned);
  if (r.error) return r.error;
  if (r.parsed.pin || r.parsed.address !== s.user.wallet) return json({ ok: false, error: "wrong_wallet" }, 403);
  await env.DB.prepare("UPDATE sessions SET proven_at = ? WHERE id = ?").bind(iso(now), s.id).run();
  return json({ ok: true, provenAt: iso(now) });
}

const guard = async (request, env) => {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  if (!env.DB) return json({ ok: false, error: "accounts_unavailable" }, 503);
  await ensureSchema(env.DB);
  return null;
};
const badSigned = (error, status = 400) => ({ error: json({ ok: false, error }, status) });

/* ---------------- 1. prove the wallet ---------------- */

/** POST /api/auth/wallet { address, message, signature, pair? } — a signed "login" message. */
export async function handleWalletLogin(request, env, now = Date.now()) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const r = await checkSigned(body, request, now, ["login"], badSigned);
  if (r.error) return r.error;
  const wallet = r.parsed.address;

  if (body.pair != null) {
    // a phone approving the sign-in of another device (the computer that showed the code)
    if (typeof body.pair !== "string" || body.pair.length > 64) return json({ ok: false, error: "bad_pair" }, 400);
    const pair = await env.DB.prepare("SELECT id, pin, wallet, expires_at FROM pairs WHERE id = ?").bind(await sha256(body.pair)).first();
    if (!pair || pair.wallet || Date.parse(pair.expires_at) <= now) return json({ ok: false, error: "pair_expired" }, 410);
    if (r.parsed.pin !== pair.pin) return json({ ok: false, error: "pin_mismatch" }, 400);
    await env.DB.prepare("UPDATE pairs SET wallet = ? WHERE id = ? AND wallet IS NULL").bind(wallet, pair.id).run();
    return json({ ok: true, paired: true });
  }
  if (r.parsed.pin) return json({ ok: false, error: "bad_message" }, 400);

  await dropCurrent(env, request);
  const { cookie: c, next } = await signInWallet(env, wallet, now);
  return json({ ok: true, wallet, next }, 200, { "Set-Cookie": c });
}

/** POST /api/pair → a code for the phone (shown as a QR code) and a 2-digit check number. */
export async function handlePairStart(request, env, now = Date.now()) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const code = randomToken(18);
  const pin = String(10 + (crypto.getRandomValues(new Uint8Array(1))[0] % 90));
  await env.DB.prepare("INSERT INTO pairs (id, pin, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(code), pin, iso(now), iso(now + PAIR_SECONDS * 1000)).run();
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM pairs WHERE expires_at < ?").bind(iso(now)).run();
  const origin = new URL(request.url).origin;
  return json({ ok: true, code, pin, url: `${origin}/connect?pair=${code}`, expiresAt: iso(now + PAIR_SECONDS * 1000) });
}

async function findPair(env, code, now) {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
  const p = await env.DB.prepare("SELECT id, pin, wallet, expires_at FROM pairs WHERE id = ?").bind(await sha256(code)).first();
  return p && Date.parse(p.expires_at) > now ? p : null;
}

/** GET /api/pair?code= → { status: waiting | ready | expired, pin } (no side effects: the phone reads the pin here). */
export async function handlePairStatus(request, env, now = Date.now()) {
  if (!env.DB) return json({ status: "expired" });
  await ensureSchema(env.DB);
  const p = await findPair(env, new URL(request.url).searchParams.get("code"), now);
  if (!p) return json({ status: "expired" });
  return json({ status: p.wallet ? "ready" : "waiting", pin: p.pin });
}

/** POST /api/pair/finish { code } → the computer takes over the sign-in the phone approved. */
export async function handlePairFinish(request, env, now = Date.now()) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const body = await readJson(request);
  const p = await findPair(env, body && body.code, now);
  if (!p) return json({ ok: false, status: "expired" }, 410);
  if (!p.wallet) return json({ ok: false, status: "waiting" });
  const del = await env.DB.prepare("DELETE FROM pairs WHERE id = ? AND wallet IS NOT NULL").bind(p.id).run();
  if (!del.meta?.changes) return json({ ok: false, status: "expired" }, 410); // someone was faster
  await dropCurrent(env, request);
  const { cookie: c, next } = await signInWallet(env, p.wallet, now);
  return json({ ok: true, status: "done", wallet: p.wallet, next }, 200, { "Set-Cookie": c });
}

/**
 * POST /api/auth/transfer { address } → "send exactly 0.00XXXX SOL to anyone (yourself is easiest)".
 * For wallets inside apps that can't sign messages (FOMO, exchange wallets...). Costs only the
 * network fee when sent to yourself.
 */
export async function handleTransferStart(request, env, now = Date.now()) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const body = await readJson(request);
  const address = body && body.address;
  if (!isSolanaAddress(address)) return json({ ok: false, error: "bad_address" }, 400);
  const r = crypto.getRandomValues(new Uint16Array(1))[0];
  const lamports = (1001 + (r % 8999)) * 1000; // 0.001001 – 0.009999 SOL, six decimals
  const proof = JSON.stringify({ address, lamports, since: now });
  const out = { ok: true, address, lamports, sol: (lamports / 1e9).toFixed(6), expiresAt: iso(now + PENDING_SECONDS * 1000) };
  // Already signed in and proving "it's still me" (app wallets can't sign): keep the session, add the proof.
  const current = body.reprove ? await getSession(env, request, now) : null;
  if (current && current.user) {
    if (address !== current.user.wallet) return json({ ok: false, error: "wrong_wallet" }, 403);
    await env.DB.prepare("UPDATE sessions SET proof = ? WHERE id = ?").bind(proof, current.id).run();
    return json({ ...out, reprove: true });
  }
  await dropCurrent(env, request);
  const c = await createSession(env, { proof }, PENDING_SECONDS, now);
  return json(out, 200, { "Set-Cookie": c });
}

/** POST /api/auth/transfer/check → looks for that exact transfer on the blockchain. */
export async function handleTransferCheck(request, env, now = Date.now(), fetchImpl = fetch) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const s = await getSession(env, request, now);
  if (!s || !s.proof) return json({ ok: false, error: "no_proof" }, 400);
  const p = JSON.parse(s.proof);
  // at most one blockchain look every 8 seconds per person (the page asks every 10)
  if (p.lastCheck && now - p.lastCheck < 8000) return json({ ok: false, error: "not_found_yet" });
  await env.DB.prepare("UPDATE sessions SET proof = ? WHERE id = ?").bind(JSON.stringify({ ...p, lastCheck: now }), s.id).run();
  let found;
  try { found = await findTransfer(env, p.address, p.lamports, p.since, fetchImpl); }
  catch (e) { console.error("transfer check failed", String(e)); return json({ ok: false, error: "chain_unavailable" }, 503); }
  if (!found) return json({ ok: false, error: "not_found_yet" });
  if (s.user) {
    await env.DB.prepare("UPDATE sessions SET proven_at = ?, proof = NULL WHERE id = ?").bind(iso(now), s.id).run();
    return json({ ok: true, wallet: p.address, reproven: true });
  }
  await dropSession(env, s.id);
  const { cookie: c, next } = await signInWallet(env, p.address, now);
  return json({ ok: true, wallet: p.address, next }, 200, { "Set-Cookie": c });
}

/* ---------------- 2. Google ---------------- */

/** GET /api/auth/:provider/start → off to Google (PKCE, with a one-time state). */
export async function handleOAuthStart(request, env, provider) {
  const p = PROVIDERS[provider];
  if (!p) return json({ error: "not_found" }, 404);
  if (!p.configured(env) || !env.DB) return redirect("/connect?error=login_unavailable");
  const state = randomToken(16), verifier = randomToken(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const redirectUri = `${new URL(request.url).origin}/api/auth/${provider}/callback`;
  return redirect(p.authorize(env, { redirectUri, state, challenge }), [cookie(OAUTH_COOKIE, `${provider}.${state}.${verifier}`, 600)]);
}

/**
 * GET /api/auth/:provider/callback → Google sent the person back: check the one-time state, ask Google
 * who they are, then hand over to linkIdentity (link the login to the proven wallet, or sign a returning
 * person in). Every failure redirects to /connect?error=<code>.
 */
export async function handleOAuthCallback(request, env, provider, fetchImpl = fetch, now = Date.now()) {
  const url = new URL(request.url);
  const p = PROVIDERS[provider];
  if (!p) return json({ error: "not_found" }, 404);
  const clear = clearCookie(OAUTH_COOKIE);
  const fail = (error) => redirect(`/connect?error=${error}`, [clear]);
  if (!p.configured(env) || !env.DB) return fail("login_unavailable");
  if (url.searchParams.get("error")) return fail("login_cancelled");
  const [cp, state, verifier] = (getCookie(request, OAUTH_COOKIE) || "").split(".");
  const code = url.searchParams.get("code");
  if (cp !== provider || !state || state !== url.searchParams.get("state") || !code || !verifier) return fail("login_expired");

  let who;
  try { who = await p.identity(env, { code, redirectUri: `${url.origin}/api/auth/${provider}/callback`, verifier }, fetchImpl); }
  catch (e) { console.error("login failed", provider, String(e)); return fail("login_failed"); }

  await ensureSchema(env.DB);
  const session = await getSession(env, request, now);
  const r = await linkIdentity(env, session, provider, who, now);
  if (r.error) return fail(r.error);
  return redirect(r.to, r.cookie ? [clear, r.cookie] : [clear]);
}

/**
 * A login (Google or e-mail) has been proven: decide what it means for this browser's session.
 * Shared by the Google callback and the e-mail code check. `who` is { id, handle, name }.
 * Returns { error } with a code for the page (social_taken, wallet_taken, wallet_first), or
 * { to, isNew, cookie }: where to send the person, whether the account was just created, and the new
 * session cookie (null when nothing changed).
 *
 *   - already signed in with an account: nothing to do, back to the dashboard
 *   - wallet proven in this browser: link the login to it for good, which creates the account (with a
 *     made-up username when the login has no handle, flagged "early" while no coin is live yet); or
 *     sign in, if this login is already linked to that same wallet. A login already linked to another
 *     wallet is refused (social_taken), and so is a wallet that already has an account (wallet_taken)
 *   - no wallet proven here: a returning person signs in with the login alone; a new one must prove
 *     a wallet first
 */
async function linkIdentity(env, session, provider, who, now) {
  const linked = await env.DB.prepare("SELECT id, wallet FROM users WHERE provider = ? AND provider_id = ?").bind(provider, who.id).first();
  // Signing in with Google / e-mail alone doesn't prove the wallet: sensitive actions will ask for it again.
  const start = async (userId, wallet, to, isNew) => {
    if (session) await dropSession(env, session.id);
    const provenAt = session && session.wallet === wallet ? session.proven_at : null;
    return { to, isNew, cookie: await createSession(env, { wallet, userId, provenAt }, SESSION_SECONDS, now) };
  };

  if (session && session.user) return { to: "/dashboard", isNew: false, cookie: null };

  if (session && session.wallet) {
    // The wallet was proven a moment ago: link this login to it, for good.
    if (linked) {
      if (linked.wallet !== session.wallet) return { error: "social_taken" };
      return start(linked.id, linked.wallet, "/dashboard", false);
    }
    if (await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(session.wallet).first()) return { error: "wallet_taken" };
    try {
      const ins = await env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, handle, name, early, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(session.wallet, provider, who.id, who.handle || await autoUsername(env.DB), who.name, activeMint(env) ? 0 : 1, iso(now)).run();
      console.log("account created", provider, session.wallet.slice(0, 4) + "…" + session.wallet.slice(-4));
      return start(ins.meta.last_row_id, session.wallet, "/dashboard?welcome=1", true);
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) return { error: "social_taken" };
      throw e;
    }
  }

  // No wallet proven in this browser: a returning person signs in with their login alone.
  if (linked) return start(linked.id, linked.wallet, "/dashboard", false);
  return { error: "wallet_first" };
}

/** POST /api/auth/logout */
export async function handleLogout(request, env) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  if (env.DB) { await ensureSchema(env.DB); await dropCurrent(env, request); }
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie(SESSION_COOKIE) });
}

/* ---------------- 3. e-mail codes ---------------- */

/*
 * The other way to sign in: type an e-mail address, get a 6-digit code by e-mail, type it back.
 * Only a hash of the code is stored, one row per address in the email_codes table (store.js).
 * That row also remembers how many wrong guesses were made and when mails were last sent, which
 * is what the limits below are counted from.
 */

/** A code works for 10 minutes. */
const CODE_SECONDS = 10 * 60;
/** At least 60 seconds between two mails to the same address. */
const CODE_RESEND_SECONDS = 60;
/** At most 5 mails per address per hour. */
const CODE_MAX_SENDS = 5;
/** After 5 wrong guesses the code is dead, even if the right one comes next. */
const CODE_MAX_ATTEMPTS = 5;

/** Tidy an address: trimmed, lower case, cut to 254 characters (the usual maximum length of an address). */
export const cleanEmail = (s) => String(s || "").trim().toLowerCase().slice(0, 254);
/** A loose shape check only (something@something.xx, no spaces): the code that arrives is the real proof. */
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

/**
 * Check a 6-digit code against the stored hash for this address. Returns { ok: true } and deletes the
 * code (it works once), or { ok: false, error } with error = code_expired (none stored, or too old),
 * too_many (5 wrong guesses already) or code_wrong (plus `left`, the guesses remaining). A wrong guess
 * is counted. Also used by me.js to confirm a contact e-mail.
 * Note: "deletes the code" means the whole row for the address (on success, on expiry and on too_many),
 * so the resend and hourly send counters kept in that row are forgotten too.
 */
export async function consumeEmailCode(db, email, code, now = Date.now()) {
  const row = await db.prepare("SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?").bind(email).first();
  const gone = async () => { await db.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run(); };
  if (!row) return { ok: false, error: "code_expired" };
  if (Date.parse(row.expires_at) <= now) { await gone(); return { ok: false, error: "code_expired" }; }
  if (row.attempts >= CODE_MAX_ATTEMPTS) { await gone(); return { ok: false, error: "too_many" }; }
  if (!safeEqual(await sha256(code), row.code_hash)) {
    await db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    return { ok: false, error: "code_wrong", left: CODE_MAX_ATTEMPTS - row.attempts - 1 };
  }
  await gone();
  return { ok: true };
}

/** Compare two strings (here: hex hashes) without stopping at the first difference, so timing reveals nothing. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** A random 6-digit code, 100000 – 999999 (never a leading zero), from the secure random generator. */
function sixDigits() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return String(100_000 + (b[0] * 65536 + b[1] * 256 + b[2]) % 900_000);
}

/**
 * Mail the code through mail.js. `mailer.smtpImpl` lets tests replace the real Gmail connection.
 * Returns { ok: true } or { ok: false, error }.
 */
async function sendCodeEmail(env, to, code, fetchImpl, mailer = {}) {
  const { subject, text, html } = verificationEmail(code);
  return sendMail(env, { to, subject, text, html }, { fetchImpl, smtpImpl: mailer.smtpImpl || null });
}

/**
 * POST /api/auth/email/start { email } → mails a fresh 6-digit code (valid 10 minutes).
 * Errors (besides wrong_origin / accounts_unavailable from guard): bad_email (400), email_unavailable
 * (503, no mail setup or the mail failed), too_soon (429, a mail went out less than a minute ago),
 * too_many (429, five mails to this address in the last hour).
 * The answer is the same whether or not the address already has an account. A new code replaces any
 * earlier one for the address and resets its wrong-guess count.
 */
export async function handleEmailStart(request, env, fetchImpl = fetch, now = Date.now(), mailer = {}) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const body = await readJson(request);
  const email = cleanEmail(body && body.email);
  if (!validEmail(email)) return json({ ok: false, error: "bad_email" }, 400);
  if (!emailConfigured(env)) return json({ ok: false, error: "email_unavailable" }, 503);
  const row = await env.DB.prepare("SELECT expires_at, attempts, send_count, window_start, last_sent_at FROM email_codes WHERE email = ?").bind(email).first();
  if (row && row.last_sent_at && now - Date.parse(row.last_sent_at) < CODE_RESEND_SECONDS * 1000)
    return json({ ok: false, error: "too_soon" }, 429);
  // the hourly count starts at the first mail and restarts an hour later
  const inWindow = row && row.window_start && now - Date.parse(row.window_start) < 3_600_000;
  if (inWindow && row.send_count >= CODE_MAX_SENDS) return json({ ok: false, error: "too_many" }, 429);
  const code = sixDigits();
  const sent = await sendCodeEmail(env, email, code, fetchImpl, mailer);
  if (!sent.ok) return json(sent, 503);
  const sendCount = inWindow ? row.send_count + 1 : 1;
  const windowStart = inWindow ? row.window_start : iso(now);
  await env.DB.prepare(`INSERT INTO email_codes (email, code_hash, created_at, expires_at, attempts, send_count, window_start, last_sent_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, created_at=excluded.created_at,
      expires_at=excluded.expires_at, attempts=0, send_count=excluded.send_count, window_start=excluded.window_start,
      last_sent_at=excluded.last_sent_at`).bind(email, await sha256(code), iso(now), iso(now + CODE_SECONDS * 1000), sendCount, windowStart, iso(now)).run();
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM email_codes WHERE expires_at < ?").bind(iso(now)).run();
  return json({ ok: true });
}

/**
 * POST /api/auth/email/verify { email, code } → the person typed the code back. A right code is used up
 * and the address is treated like a Google login: linkIdentity links it to the proven wallet (new
 * account), or signs a returning person in. Answers { ok: true, next, isNew } plus the session cookie.
 * Errors: bad_code (400, not an address plus six digits), the code errors of consumeEmailCode (with
 * `left` for a wrong guess), or the linkIdentity errors (400). Note that the code is used up before
 * linkIdentity runs, so a linkIdentity error still costs the person a new code.
 * (`fetchImpl` is not used here.)
 */
export async function handleEmailVerify(request, env, fetchImpl = fetch, now = Date.now()) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const body = await readJson(request);
  const email = cleanEmail(body && body.email);
  const code = String(body && body.code || "").replace(/\D/g, "").slice(0, 6);
  if (!validEmail(email) || code.length !== 6) return json({ ok: false, error: "bad_code" }, 400);
  const v = await consumeEmailCode(env.DB, email, code, now);
  if (!v.ok) return json({ ok: false, error: v.error, ...v.left != null ? { left: v.left } : {} }, v.error === "too_many" ? 429 : 400);
  await ensureSchema(env.DB);
  const session = await getSession(env, request, now);
  const r = await linkIdentity(env, session, "email", { id: email, handle: null, name: "E-mail member" }, now);
  if (r.error) return json({ ok: false, error: r.error }, 400);
  const headers = r.cookie ? { "Set-Cookie": r.cookie } : {};
  return json({ ok: true, next: r.to, isNew: r.isNew }, 200, headers);
}
