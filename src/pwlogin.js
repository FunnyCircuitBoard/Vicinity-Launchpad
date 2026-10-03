/**
 * Password log-in for e-mail accounts (SIGNUP_FLOW=v2 only). SKELETON: the four handlers below are wired into
 * routeV2 (src/signup.js) and answer 501 until they are filled in.
 *
 *   POST /api/auth/email/login          { email, password }               → { ok, next: "/dashboard" }
 *   POST /api/auth/password/reset/start { email }                         → { ok } (the same for known and unknown addresses)
 *   POST /api/auth/password/reset       { email, code, password }         → { ok, next: "/dashboard" }
 *   POST /api/me/password               { current?, password }            → { ok }
 *
 * How they are called: routeV2 has already checked that the switch is on, that a POST comes from this site (Origin), that
 * the database is there and that the sign-up tables exist (guardV2 in src/signup-core.js: call it first when a handler is
 * called directly, as tests may). `x` is { fetchImpl, ctx, now, cf }: ctx.waitUntil (null in tests) is for sending mail in
 * the background (see `waitUntil` and `noSend` of sendEmailCode in src/auth.js). Building blocks: src/password.js
 * (hash, verify, policy), src/limits.js (atomic counters), createSession / dropCurrent / isFresh / consumeEmailCode in
 * src/auth.js, endSignup in src/signup-core.js.
 */
import { json } from "./http.js";

const notImplemented = () => json({ ok: false, error: "not_implemented" }, 501);

export const handleEmailLogin = async (request, env, x) => notImplemented();
export const handleResetStart = async (request, env, x) => notImplemented();
export const handleReset = async (request, env, x) => notImplemented();
export const handleSetPassword = async (request, env, x) => notImplemented();
