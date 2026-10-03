/**
 * Accounts and sign-in. One person = ONE wallet + ONE Google login or verified e-mail, so
 * nobody can run a crowd of accounts to spam their city.
 *
 * New person (today's flow, SIGNUP_FLOW unset):
 *   1. prove the wallet: sign a free message (or, for apps that can't sign, send yourself a tiny
 *      exact amount of SOL; or sign on your phone for this computer by scanning a code)
 *   2. sign in with Google or verify an e-mail address with a code → the two are linked for
 *      good → dashboard
 * New person (SIGNUP_FLOW=v2, src/signup.js): location → Terms + Google or e-mail with a password →
 *   wallet → one atomic step creates the account. In v2 this file can no longer create an account:
 *   an unknown Google id or e-mail answers "no_account" here, and only signs people in.
 * Returning person: either the wallet OR the linked Google login / verified e-mail signs them
 * straight in (and, in v2, an e-mail account may also use its password: src/pwlogin.js).
 *
 * Only a hash of the session cookie is stored. From Google we keep the account id and first
 * name; from e-mail we keep the address (a code proves it). A password exists only in v2, only
 * for e-mail accounts, and only as a salted hash (src/password.js). Passwords are never logged.
 *
 * Settings (Cloudflare → Workers → vicinity-map → Settings → Variables and secrets):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   Google sign-in
 *   GMAIL_USER, GMAIL_APP_PASSWORD            e-mail codes, sent straight from Gmail (simplest);
 *                                             or RESEND_API_KEY (Resend); EMAIL_FROM sets the sender
 * Redirect address to register with Google: https://vicinity.city/api/auth/google/callback
 */
import { b64url, clearCookie, cookie, getCookie, json, randomToken, readJson, redirect, sameSite, sha256 } from "./http.js";
import { checkSigned } from "./signed.js";
import { isSolanaAddress } from "./solana.js";
import { emailConfigured, sendMail, verificationEmail } from "./mail.js";
import { ensureSchema, ensureSignupSchema } from "./store.js";
import { findTransfer } from "./chain.js";
import { activeMint } from "./official.js";
import { POLICY } from "./policy.js";
import { autoUsername } from "./text.js";
import { v2On } from "./flags.js";
import { TERMS_VERSION, endSignup, getSignup, recordIdentity } from "./signup-core.js";

export const SESSION_COOKIE = "vs";
const OAUTH_COOKIE = "vo";
export const SESSION_SECONDS = 30 * 86400;  // signed in for 30 days
export const PENDING_SECONDS = 30 * 60;     // wallet proven, Google / e-mail still to link: 30 minutes
const PAIR_SECONDS = 10 * 60;        // "sign in with my phone" codes: 10 minutes

const iso = (ms) => new Date(ms).toISOString();
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);

function jwtPayload(token) {
  const part = String(token).split(".")[1] || "";
  const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

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
export const providers = (env) => ({
  google: Boolean(PROVIDERS.google.configured(env)),
  email: emailConfigured(env),
});

/* ---------------- sessions ---------------- */

export async function createSession(env, { wallet = null, userId = null, proof = null, provenAt = null }, seconds, now) {
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
export const dropSession = (env, id) => env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
export async function dropCurrent(env, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token && token.length <= 100) await dropSession(env, await sha256(token));
}

/**
 * The wallet is proven. A linked wallet signs straight in; a new one has 30 minutes to link Google or an e-mail
 * (next: "social") or, in the v2 sign-up, to finish it (next: "signup").
 */
async function signInWallet(env, wallet, now) {
  const user = await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(wallet).first();
  const provenAt = iso(now);
  if (user) return { cookie: await createSession(env, { wallet, userId: user.id, provenAt }, SESSION_SECONDS, now), next: "/dashboard" };
  return { cookie: await createSession(env, { wallet, provenAt }, PENDING_SECONDS, now), next: v2On(env) ? "signup" : "social" };
}

/**
 * The Set-Cookie value(s) for a finished wallet sign-in. In v2, a wallet that already has an account signs straight
 * in and the half-done sign-up of this browser is discarded with it (its cookie is cleared). With the switch off, or for a
 * new wallet, this is the plain session cookie, exactly as before.
 */
async function walletCookies(env, request, c, next) {
  if (!v2On(env) || !next.startsWith("/dashboard")) return c;
  const clear = await endSignup(env, request);
  return clear.length ? [c, ...clear] : c;
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

export const guard = async (request, env) => {
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
  return json({ ok: true, wallet, next }, 200, { "Set-Cookie": await walletCookies(env, request, c, next) });
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
  return json({ ok: true, status: "done", wallet: p.wallet, next }, 200, { "Set-Cookie": await walletCookies(env, request, c, next) });
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
  return json({ ok: true, wallet: p.address, next }, 200, { "Set-Cookie": await walletCookies(env, request, c, next) });
}

/* ---------------- 2. Google ---------------- */

/**
 * GET /api/auth/google/start → off to Google (PKCE, with a one-time state).
 * With ?signup=1 (v2 only) the person is creating an account: the Terms must be accepted in their sign-up first, and the
 * cookie gets a 4th part "s" so the callback records the Google login in that sign-up. Without it, the callback only
 * signs existing people in.
 */
export async function handleOAuthStart(request, env, provider) {
  const p = PROVIDERS[provider];
  if (!p) return json({ error: "not_found" }, 404);
  if (!p.configured(env) || !env.DB) return redirect("/connect?error=login_unavailable");
  let marker = "";
  if (v2On(env) && new URL(request.url).searchParams.get("signup") === "1") {
    let row;
    try { await ensureSignupSchema(env.DB); row = await getSignup(env, request); }
    catch (e) { console.error("sign-up lookup failed", String((e && e.message) || e)); return redirect("/connect?error=login_unavailable"); }
    if (!row || row.terms_version !== TERMS_VERSION) return redirect("/connect?error=terms_required");
    marker = ".s";
  }
  const state = randomToken(16), verifier = randomToken(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const redirectUri = `${new URL(request.url).origin}/api/auth/${provider}/callback`;
  return redirect(p.authorize(env, { redirectUri, state, challenge }), [cookie(OAUTH_COOKIE, `${provider}.${state}.${verifier}${marker}`, 600)]);
}

/**
 * GET /api/auth/google/callback → link the login to the proven wallet (or sign a returning person in).
 * v2: it never creates an account. A known Google id signs in; an unknown one is recorded in the sign-up (when the person
 * started from the sign-up page) or refused with "no_account" (a login attempt).
 */
export async function handleOAuthCallback(request, env, provider, fetchImpl = fetch, now = Date.now()) {
  const url = new URL(request.url);
  const p = PROVIDERS[provider];
  if (!p) return json({ error: "not_found" }, 404);
  const clear = clearCookie(OAUTH_COOKIE);
  const fail = (error) => redirect(`/connect?error=${error}`, [clear]);
  if (!p.configured(env) || !env.DB) return fail("login_unavailable");
  if (url.searchParams.get("error")) return fail("login_cancelled");
  const [cp, state, verifier, marker] = (getCookie(request, OAUTH_COOKIE) || "").split(".");
  const code = url.searchParams.get("code");
  if (cp !== provider || !state || state !== url.searchParams.get("state") || !code || !verifier) return fail("login_expired");

  let who;
  try { who = await p.identity(env, { code, redirectUri: `${url.origin}/api/auth/${provider}/callback`, verifier }, fetchImpl); }
  catch (e) { console.error("login failed", provider, String(e)); return fail("login_failed"); }

  await ensureSchema(env.DB);
  const session = await getSession(env, request, now);
  const v2 = v2On(env) ? { onNew: marker === "s"
    ? () => recordIdentity(env, request, provider, who, now, { walletDone: Boolean(session && session.wallet && !session.user && isFresh(session, now)) })
    : () => ({ error: "no_account" }) } : null;
  const r = await linkIdentity(env, session, provider, who, now, v2);
  if (r.error) return fail(r.error);
  const cookies = r.cookie ? [clear, r.cookie] : [clear];
  // An existing person signed in: any half-done sign-up in this browser is over.
  if (v2 && r.cookie && !r.recorded) cookies.push(...await endSignup(env, request));
  return redirect(r.to, cookies);
}

/**
 * The shared "this login is verified" step: link it to the proven wallet (creating the
 * account), or sign a returning person straight in. Returns { to, cookie, isNew } or { error }.
 *
 * v2 = { onNew() } (the sign-up v2): an identity that belongs to nobody yet is handed to onNew() instead of creating an
 * account here, so this function can only ever SIGN IN in v2 (the account is made by finish in src/signup.js, after
 * the Terms and the location). With v2 === null (the switch off) it is exactly the original.
 */
export async function linkIdentity(env, session, provider, who, now, v2 = null) {
  const linked = await env.DB.prepare("SELECT id, wallet FROM users WHERE provider = ? AND provider_id = ?").bind(provider, who.id).first();
  // Signing in with Google / e-mail alone doesn't prove the wallet: sensitive actions ask for it again.
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
    if (v2) return v2.onNew();
    // A handle can collide with the (case-insensitive) unique index when someone takes it between the check and the
    // INSERT: that is not the person's problem, so pick another name and go on. wallet / provider_id collisions are.
    for (let attempt = 0; ; attempt++) {
      const handle = attempt === 0 && who.handle ? who.handle : await autoUsername(env.DB);
      try {
        const ins = await env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, handle, name, early, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(session.wallet, provider, who.id, handle, who.name, activeMint(env) ? 0 : 1, iso(now)).run();
        console.log("account created", provider, session.wallet.slice(0, 4) + "…" + session.wallet.slice(-4));
        return start(ins.meta.last_row_id, session.wallet, "/dashboard?welcome=1", true);
      } catch (e) {
        if (!/UNIQUE/i.test(String(e))) throw e;
        const handleTaken = await env.DB.prepare("SELECT id FROM users WHERE lower(handle) = lower(?)").bind(handle).first();
        if (!handleTaken || attempt >= 4) return { error: "social_taken" };
      }
    }
  }

  // No wallet proven in this browser: a returning person signs in with their login alone.
  if (linked) return start(linked.id, linked.wallet, "/dashboard", false);
  return v2 ? v2.onNew() : { error: "wallet_first" };
}

/** POST /api/auth/logout */
export async function handleLogout(request, env) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  if (env.DB) { await ensureSchema(env.DB); await dropCurrent(env, request); }
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie(SESSION_COOKIE) });
}

/* ---------------- 3. e-mail codes ---------------- */

const CODE_SECONDS = 10 * 60;       // a code lives 10 minutes
const CODE_RESEND_SECONDS = 60;     // wait a minute between sends to the same address
const CODE_MAX_SENDS = 5;           // sends per rolling hour, per address
const CODE_MAX_ATTEMPTS = 5;        // wrong guesses before the code is thrown away
const GLOBAL_MAX_SENDS = 2000;      // codes mailed per rolling hour across the whole site (override: EMAIL_MAX_PER_HOUR)
const HOUR_MS = 3600_000;

const cleanEmail = (s) => String(s || "").trim().toLowerCase().slice(0, 254);
// Loose shape check (the code that arrives is the real proof) that also refuses control characters and
// angle brackets, so nothing odd can ever reach the mail server.
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && !/[\u0000-\u001f\u007f-\u009f<>]/.test(e);
export { cleanEmail, validEmail };

/**
 * Check a 6-digit e-mail code and burn it. Returns { ok: true } or
 * { ok: false, error, left? }. Shared by sign-in and contact-e-mail verification.
 *
 * Every guess is counted by ONE atomic statement before it is compared, so a flood of parallel guesses
 * can't all read "0 attempts so far": only the first CODE_MAX_ATTEMPTS guesses on a live code ever get
 * compared. A dead code (expired or out of guesses) keeps its row so the resend limits below survive;
 * a used code is deleted by a single DELETE, so two requests carrying the right code can't both win.
 */
export async function consumeEmailCode(db, email, code, now = Date.now()) {
  const row = await db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND attempts < ? AND expires_at > ? RETURNING code_hash, attempts")
    .bind(email, CODE_MAX_ATTEMPTS, iso(now)).first();
  if (!row) {
    const old = await db.prepare("SELECT expires_at, attempts FROM email_codes WHERE email = ?").bind(email).first();
    if (old && Date.parse(old.expires_at) > now && old.attempts >= CODE_MAX_ATTEMPTS) return { ok: false, error: "too_many" };
    return { ok: false, error: "code_expired" };
  }
  if (!safeEqual(await sha256(code), row.code_hash)) return { ok: false, error: "code_wrong", left: CODE_MAX_ATTEMPTS - row.attempts };
  const used = await db.prepare("DELETE FROM email_codes WHERE email = ? AND code_hash = ?").bind(email, row.code_hash).run();
  return used.meta.changes ? { ok: true } : { ok: false, error: "code_expired" };
}

/** Constant-time compare for hex digests (no timing leak on wrong guesses). */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function sixDigits() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return String(100000 + ((b[0] * 65536 + b[1] * 256 + b[2]) % 900000));
}

async function sendCodeEmail(env, to, code, fetchImpl, mailer = {}, kind = "signin") {
  const { subject, text, html } = verificationEmail(code, kind);
  return sendMail(env, { to, subject, text, html }, { fetchImpl, smtpImpl: mailer.smtpImpl || null });
}

/**
 * Claim a send slot for this address and e-mail it a 6-digit code (shared by /api/auth/email/start and the v2 routes).
 * The slot (one a minute, five an hour per address) is claimed by ONE atomic statement BEFORE the mail goes out, so
 * parallel requests can't all pass the checks and mail the same person dozens of times. A site-wide hourly cap
 * (EMAIL_MAX_PER_HOUR, default 2000) keeps one caller from burning the mail quota. If the mail never left, the slot is
 * given back and the code is killed, so a mail-service hiccup doesn't lock the person out.
 *   kind     what the e-mail says the code is for: "signin" (default), "signup" or "reset"
 *   waitUntil  (optional) a function that keeps a promise alive after the answer is sent, like ctx.waitUntil: the mail is then
 *            sent (and the slot given back on failure) in the background, so the answer does not wait for the mail server
 *   noSend   (optional) claim the slot and write the code, but send nothing: the same database work as a real send
 * Returns { ok: true } or { ok: false, error: "bad_email" | "email_unavailable" | "too_many" | "too_soon", status }.
 */
export async function sendEmailCode(env, email, { fetchImpl = fetch, now = Date.now(), mailer = {}, kind = "signin", waitUntil = null, noSend = false } = {}) {
  if (!validEmail(email)) return { ok: false, error: "bad_email", status: 400 };
  if (!emailConfigured(env)) return { ok: false, error: "email_unavailable", status: 503 };

  const hourAgo = iso(now - HOUR_MS);
  const cap = Number(env.EMAIL_MAX_PER_HOUR) > 0 ? Number(env.EMAIL_MAX_PER_HOUR) : GLOBAL_MAX_SENDS;
  const total = await env.DB.prepare("SELECT COALESCE(SUM(send_count), 0) AS n FROM email_codes WHERE window_start > ?").bind(hourAgo).first();
  if (total && total.n >= cap) return { ok: false, error: "too_many", status: 429 };

  const code = sixDigits();
  const hash = await sha256(code);
  const claimed = await env.DB.prepare(`INSERT INTO email_codes (email, code_hash, created_at, expires_at, attempts, send_count, window_start, last_sent_at)
      VALUES (?, ?, ?, ?, 0, 1, ?, ?)
      ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at,
        expires_at = excluded.expires_at, attempts = 0,
        send_count = CASE WHEN window_start IS NOT NULL AND window_start > ? THEN send_count + 1 ELSE 1 END,
        window_start = CASE WHEN window_start IS NOT NULL AND window_start > ? THEN window_start ELSE excluded.window_start END,
        last_sent_at = excluded.last_sent_at
      WHERE (last_sent_at IS NULL OR last_sent_at <= ?) AND (window_start IS NULL OR window_start <= ? OR send_count < ?)
      RETURNING send_count`)
    .bind(email, hash, iso(now), iso(now + CODE_SECONDS * 1000), iso(now), iso(now), hourAgo, hourAgo, iso(now - CODE_RESEND_SECONDS * 1000), hourAgo, CODE_MAX_SENDS).first();
  if (!claimed) {
    const row = await env.DB.prepare("SELECT last_sent_at FROM email_codes WHERE email = ?").bind(email).first();
    const soon = row && row.last_sent_at && now - Date.parse(row.last_sent_at) < CODE_RESEND_SECONDS * 1000;
    return { ok: false, error: soon ? "too_soon" : "too_many", status: 429 };
  }

  // The mail never left: give the slot back (and kill the code nobody received).
  const giveBack = () => env.DB.prepare("UPDATE email_codes SET last_sent_at = NULL, send_count = MAX(send_count - 1, 0), expires_at = ? WHERE email = ? AND code_hash = ?").bind(iso(now), email, hash).run();
  const deliver = async () => {
    const sent = await sendCodeEmail(env, email, code, fetchImpl, mailer, kind);
    if (!sent.ok) await giveBack();
    return sent;
  };
  if (noSend) { /* nothing is sent */ }
  else if (waitUntil) {
    waitUntil(deliver().catch(async (e) => {
      console.error("code e-mail failed", String((e && e.message) || e));
      try { await giveBack(); } catch { /* the slot frees itself after a minute anyway */ }
    }));
  } else {
    const sent = await deliver();
    if (!sent.ok) return { ...sent, status: 503 };
  }
  // Tidy now and then: only rows whose code AND hourly counters are both over.
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM email_codes WHERE expires_at < ? AND (window_start IS NULL OR window_start < ?)").bind(iso(now), hourAgo).run();
  return { ok: true };
}

/** POST /api/auth/email/start { email } → send a 6-digit code. */
export async function handleEmailStart(request, env, fetchImpl = fetch, now = Date.now(), mailer = {}) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const body = await readJson(request);
  const r = await sendEmailCode(env, cleanEmail(body && body.email), { fetchImpl, now, mailer });
  if (!r.ok) return json({ ok: false, error: r.error }, r.status);
  return json({ ok: true });
}

/**
 * POST /api/auth/email/verify { email, code } → link the e-mail to the proven wallet, or sign in.
 * v2: this route only signs existing e-mail accounts in. An unknown address answers "no_account" (the sign-up page
 * has its own route, /api/signup/email/verify, which needs the Terms and the location first).
 */
export async function handleEmailVerify(request, env, fetchImpl = fetch, now = Date.now()) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const body = await readJson(request);
  const email = cleanEmail(body && body.email);
  const code = String((body && body.code) || "").replace(/\D/g, "").slice(0, 6);
  if (!validEmail(email) || code.length !== 6) return json({ ok: false, error: "bad_code" }, 400);

  const v = await consumeEmailCode(env.DB, email, code, now);
  if (!v.ok) return json({ ok: false, error: v.error, ...(v.left != null ? { left: v.left } : {}) }, v.error === "too_many" ? 429 : 400);

  await ensureSchema(env.DB);
  const session = await getSession(env, request, now);
  const v2 = v2On(env) ? { onNew: () => ({ error: "no_account" }) } : null;
  const r = await linkIdentity(env, session, "email", { id: email, handle: null, name: "E-mail member" }, now, v2);
  if (r.error) return json({ ok: false, error: r.error }, 400);
  const headers = r.cookie ? { "Set-Cookie": r.cookie } : {};
  if (v2 && r.cookie) { // signed in as an existing person: a half-done sign-up in this browser is over
    const clear = await endSignup(env, request);
    if (clear.length) headers["Set-Cookie"] = [r.cookie, ...clear];
  }
  return json({ ok: true, next: r.to, isNew: r.isNew }, 200, headers);
}
