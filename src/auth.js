// src/auth.js: recovered from the code deployed on Cloudflare (Worker "vicinity-map", 2026-10-02).
// The original comments and formatting were lost in the bundle; the code is the deployed code, byte for byte after bundling.
import { activeMint } from "./official.js";
import { b64url, clearCookie, cookie, getCookie, json, randomToken, readJson, redirect, sameSite, sha256 } from "./http.js";
import { isSolanaAddress } from "./solana.js";
import { checkSigned } from "./signed.js";
import { emailConfigured, sendMail, verificationEmail } from "./mail.js";
import { ensureSchema } from "./store.js";
import { findTransfer } from "./chain.js";
import { POLICY } from "./policy.js";
import { autoUsername } from "./text.js";
var SESSION_COOKIE = "vs";
var OAUTH_COOKIE = "vo";
var SESSION_SECONDS = 30 * 86400;
var PENDING_SECONDS = 30 * 60;
var PAIR_SECONDS = 10 * 60;
var iso = (ms) => new Date(ms).toISOString();
var cleanName = (s) => String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
function jwtPayload(token) {
  const part = String(token).split(".")[1] || "";
  const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}
var PROVIDERS = {
  google: {
    configured: (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    authorize: (env, { redirectUri, state, challenge }) => "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account"
    }),
    async identity(env, { code, redirectUri, verifier }, fetchImpl) {
      const res = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: verifier
        })
      });
      const tok = await res.json().catch(() => ({}));
      if (!res.ok || !tok.id_token) throw new Error("google_token_" + res.status);
      const c = jwtPayload(tok.id_token);
      if (c.aud !== env.GOOGLE_CLIENT_ID || !["https://accounts.google.com", "accounts.google.com"].includes(c.iss) || !c.sub) throw new Error("google_bad_token");
      return { id: String(c.sub), handle: null, name: cleanName(c.given_name || c.name) || "Google member" };
    }
  }
};
var providers = (env) => ({
  google: Boolean(PROVIDERS.google.configured(env)),
  email: emailConfigured(env)
});
async function createSession(env, { wallet = null, userId = null, proof = null, provenAt = null }, seconds, now) {
  const token = randomToken(32);
  await env.DB.prepare("INSERT INTO sessions (id, wallet, user_id, proof, created_at, expires_at, proven_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(await sha256(token), wallet, userId, proof, iso(now), iso(now + seconds * 1e3), provenAt).run();
  if (Math.random() < 0.02) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(iso(now)),
      env.DB.prepare("DELETE FROM pairs WHERE expires_at < ?").bind(iso(now))
    ]);
  }
  return cookie(SESSION_COOKIE, token, seconds);
}
async function getSession(env, request, now = Date.now()) {
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
var dropSession = (env, id) => env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
async function dropCurrent(env, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token && token.length <= 100) await dropSession(env, await sha256(token));
}
async function signInWallet(env, wallet, now) {
  const user = await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(wallet).first();
  const provenAt = iso(now);
  if (user) return { cookie: await createSession(env, { wallet, userId: user.id, provenAt }, SESSION_SECONDS, now), next: "/dashboard" };
  return { cookie: await createSession(env, { wallet, provenAt }, PENDING_SECONDS, now), next: "social" };
}
var isFresh = (session, now = Date.now()) => Boolean(session && session.proven_at && now - Date.parse(session.proven_at) <= POLICY.freshProofMinutes * 6e4);
async function handleReprove(request, env, now = Date.now()) {
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
var guard = async (request, env) => {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  if (!env.DB) return json({ ok: false, error: "accounts_unavailable" }, 503);
  await ensureSchema(env.DB);
  return null;
};
var badSigned = (error, status = 400) => ({ error: json({ ok: false, error }, status) });
async function handleWalletLogin(request, env, now = Date.now()) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const r = await checkSigned(body, request, now, ["login"], badSigned);
  if (r.error) return r.error;
  const wallet = r.parsed.address;
  if (body.pair != null) {
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
async function handlePairStart(request, env, now = Date.now()) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const code = randomToken(18);
  const pin = String(10 + crypto.getRandomValues(new Uint8Array(1))[0] % 90);
  await env.DB.prepare("INSERT INTO pairs (id, pin, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(code), pin, iso(now), iso(now + PAIR_SECONDS * 1e3)).run();
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM pairs WHERE expires_at < ?").bind(iso(now)).run();
  const origin = new URL(request.url).origin;
  return json({ ok: true, code, pin, url: `${origin}/connect?pair=${code}`, expiresAt: iso(now + PAIR_SECONDS * 1e3) });
}
async function findPair(env, code, now) {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
  const p = await env.DB.prepare("SELECT id, pin, wallet, expires_at FROM pairs WHERE id = ?").bind(await sha256(code)).first();
  return p && Date.parse(p.expires_at) > now ? p : null;
}
async function handlePairStatus(request, env, now = Date.now()) {
  if (!env.DB) return json({ status: "expired" });
  await ensureSchema(env.DB);
  const p = await findPair(env, new URL(request.url).searchParams.get("code"), now);
  if (!p) return json({ status: "expired" });
  return json({ status: p.wallet ? "ready" : "waiting", pin: p.pin });
}
async function handlePairFinish(request, env, now = Date.now()) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const body = await readJson(request);
  const p = await findPair(env, body && body.code, now);
  if (!p) return json({ ok: false, status: "expired" }, 410);
  if (!p.wallet) return json({ ok: false, status: "waiting" });
  const del = await env.DB.prepare("DELETE FROM pairs WHERE id = ? AND wallet IS NOT NULL").bind(p.id).run();
  if (!del.meta?.changes) return json({ ok: false, status: "expired" }, 410);
  await dropCurrent(env, request);
  const { cookie: c, next } = await signInWallet(env, p.wallet, now);
  return json({ ok: true, status: "done", wallet: p.wallet, next }, 200, { "Set-Cookie": c });
}
async function handleTransferStart(request, env, now = Date.now()) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const body = await readJson(request);
  const address = body && body.address;
  if (!isSolanaAddress(address)) return json({ ok: false, error: "bad_address" }, 400);
  const r = crypto.getRandomValues(new Uint16Array(1))[0];
  const lamports = (1001 + r % 8999) * 1e3;
  const proof = JSON.stringify({ address, lamports, since: now });
  const out = { ok: true, address, lamports, sol: (lamports / 1e9).toFixed(6), expiresAt: iso(now + PENDING_SECONDS * 1e3) };
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
async function handleTransferCheck(request, env, now = Date.now(), fetchImpl = fetch) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const s = await getSession(env, request, now);
  if (!s || !s.proof) return json({ ok: false, error: "no_proof" }, 400);
  const p = JSON.parse(s.proof);
  if (p.lastCheck && now - p.lastCheck < 8e3) return json({ ok: false, error: "not_found_yet" });
  await env.DB.prepare("UPDATE sessions SET proof = ? WHERE id = ?").bind(JSON.stringify({ ...p, lastCheck: now }), s.id).run();
  let found;
  try {
    found = await findTransfer(env, p.address, p.lamports, p.since, fetchImpl);
  } catch (e) {
    console.error("transfer check failed", String(e));
    return json({ ok: false, error: "chain_unavailable" }, 503);
  }
  if (!found) return json({ ok: false, error: "not_found_yet" });
  if (s.user) {
    await env.DB.prepare("UPDATE sessions SET proven_at = ?, proof = NULL WHERE id = ?").bind(iso(now), s.id).run();
    return json({ ok: true, wallet: p.address, reproven: true });
  }
  await dropSession(env, s.id);
  const { cookie: c, next } = await signInWallet(env, p.address, now);
  return json({ ok: true, wallet: p.address, next }, 200, { "Set-Cookie": c });
}
async function handleOAuthStart(request, env, provider) {
  const p = PROVIDERS[provider];
  if (!p) return json({ error: "not_found" }, 404);
  if (!p.configured(env) || !env.DB) return redirect("/connect?error=login_unavailable");
  const state = randomToken(16), verifier = randomToken(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const redirectUri = `${new URL(request.url).origin}/api/auth/${provider}/callback`;
  return redirect(p.authorize(env, { redirectUri, state, challenge }), [cookie(OAUTH_COOKIE, `${provider}.${state}.${verifier}`, 600)]);
}
async function handleOAuthCallback(request, env, provider, fetchImpl = fetch, now = Date.now()) {
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
  try {
    who = await p.identity(env, { code, redirectUri: `${url.origin}/api/auth/${provider}/callback`, verifier }, fetchImpl);
  } catch (e) {
    console.error("login failed", provider, String(e));
    return fail("login_failed");
  }
  await ensureSchema(env.DB);
  const session = await getSession(env, request, now);
  const r = await linkIdentity(env, session, provider, who, now);
  if (r.error) return fail(r.error);
  return redirect(r.to, r.cookie ? [clear, r.cookie] : [clear]);
}
async function linkIdentity(env, session, provider, who, now) {
  const linked = await env.DB.prepare("SELECT id, wallet FROM users WHERE provider = ? AND provider_id = ?").bind(provider, who.id).first();
  const start = async (userId, wallet, to, isNew) => {
    if (session) await dropSession(env, session.id);
    const provenAt = session && session.wallet === wallet ? session.proven_at : null;
    return { to, isNew, cookie: await createSession(env, { wallet, userId, provenAt }, SESSION_SECONDS, now) };
  };
  if (session && session.user) return { to: "/dashboard", isNew: false, cookie: null };
  if (session && session.wallet) {
    if (linked) {
      if (linked.wallet !== session.wallet) return { error: "social_taken" };
      return start(linked.id, linked.wallet, "/dashboard", false);
    }
    if (await env.DB.prepare("SELECT id FROM users WHERE wallet = ?").bind(session.wallet).first()) return { error: "wallet_taken" };
    try {
      const ins = await env.DB.prepare("INSERT INTO users (wallet, provider, provider_id, handle, name, early, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(session.wallet, provider, who.id, who.handle || await autoUsername(env.DB), who.name, activeMint(env) ? 0 : 1, iso(now)).run();
      console.log("account created", provider, session.wallet.slice(0, 4) + "\u2026" + session.wallet.slice(-4));
      return start(ins.meta.last_row_id, session.wallet, "/dashboard?welcome=1", true);
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) return { error: "social_taken" };
      throw e;
    }
  }
  if (linked) return start(linked.id, linked.wallet, "/dashboard", false);
  return { error: "wallet_first" };
}
async function handleLogout(request, env) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  if (env.DB) {
    await ensureSchema(env.DB);
    await dropCurrent(env, request);
  }
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie(SESSION_COOKIE) });
}
var CODE_SECONDS = 10 * 60;
var CODE_RESEND_SECONDS = 60;
var CODE_MAX_SENDS = 5;
var CODE_MAX_ATTEMPTS = 5;
var cleanEmail = (s) => String(s || "").trim().toLowerCase().slice(0, 254);
var validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
async function consumeEmailCode(db, email, code, now = Date.now()) {
  const row = await db.prepare("SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?").bind(email).first();
  const gone = async () => {
    await db.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run();
  };
  if (!row) return { ok: false, error: "code_expired" };
  if (Date.parse(row.expires_at) <= now) {
    await gone();
    return { ok: false, error: "code_expired" };
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await gone();
    return { ok: false, error: "too_many" };
  }
  if (!safeEqual(await sha256(code), row.code_hash)) {
    await db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    return { ok: false, error: "code_wrong", left: CODE_MAX_ATTEMPTS - row.attempts - 1 };
  }
  await gone();
  return { ok: true };
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function sixDigits() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return String(1e5 + (b[0] * 65536 + b[1] * 256 + b[2]) % 9e5);
}
async function sendCodeEmail(env, to, code, fetchImpl, mailer = {}) {
  const { subject, text, html } = verificationEmail(code);
  return sendMail(env, { to, subject, text, html }, { fetchImpl, smtpImpl: mailer.smtpImpl || null });
}
async function handleEmailStart(request, env, fetchImpl = fetch, now = Date.now(), mailer = {}) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const body = await readJson(request);
  const email = cleanEmail(body && body.email);
  if (!validEmail(email)) return json({ ok: false, error: "bad_email" }, 400);
  if (!emailConfigured(env)) return json({ ok: false, error: "email_unavailable" }, 503);
  const row = await env.DB.prepare("SELECT expires_at, attempts, send_count, window_start, last_sent_at FROM email_codes WHERE email = ?").bind(email).first();
  if (row && row.last_sent_at && now - Date.parse(row.last_sent_at) < CODE_RESEND_SECONDS * 1e3)
    return json({ ok: false, error: "too_soon" }, 429);
  const inWindow = row && row.window_start && now - Date.parse(row.window_start) < 36e5;
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
      last_sent_at=excluded.last_sent_at`).bind(email, await sha256(code), iso(now), iso(now + CODE_SECONDS * 1e3), sendCount, windowStart, iso(now)).run();
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM email_codes WHERE expires_at < ?").bind(iso(now)).run();
  return json({ ok: true });
}
async function handleEmailVerify(request, env, fetchImpl = fetch, now = Date.now()) {
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
export { SESSION_COOKIE, cleanEmail, consumeEmailCode, getSession, handleEmailStart, handleEmailVerify, handleLogout, handleOAuthCallback, handleOAuthStart, handlePairFinish, handlePairStart, handlePairStatus, handleReprove, handleTransferCheck, handleTransferStart, handleWalletLogin, isFresh, providers, validEmail };
