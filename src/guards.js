/**
 * Attempt limits for the public routes that cost a blockchain call or a database row for anyone who asks:
 * verify a wallet, the tiny-transfer proof (start and check), "sign in with my phone" codes, a wallet's rank.
 *
 * One connection (cf-connecting-ip: an IPv4 address, or an IPv6 address cut to its /64, see clientKey in
 * src/limits.js) gets a fixed number of attempts per fixed window. The attempt is counted BEFORE the work, with the
 * atomic counters of src/limits.js, so a flood cannot all pass. Keys are HMACs: no address is ever stored.
 * The numbers are the same as the Cloudflare WAF rules the owner sets (they are the second line, this is the first).
 *
 * These are public read paths at launch, so unlike the sign-up counters a database failure here does NOT refuse the
 * request: it is logged with a short code and the request goes through. Nobody should be unable to check their
 * wallet because a counter table hiccuped.
 *
 * Wiring (src/index.js): `const slow = await publicLimit(env, request, "verify"); if (slow) return slow;`
 */
import { json } from "./http.js";
import { check, clientKey, limitKey } from "./limits.js";
import { ensureLimitsSchema } from "./store.js";

const MIN = 60_000;
export const PUBLIC_LIMITS = {
  verify:         { max: 30, windowMs: 10 * MIN },  // POST /api/verify: one RPC call each
  transfer:       { max: 10, windowMs: 10 * MIN },  // POST /api/auth/transfer: one pending session each
  transfer_check: { max: 60, windowMs: 10 * MIN },  // POST /api/auth/transfer/check: up to 11 RPC calls each
  pair:           { max: 20, windowMs: 10 * MIN },  // POST /api/pair: one row each
  rank:           { max: 60, windowMs: MIN },       // GET /api/rank: an RPC call when the snapshot is down
};

/**
 * Count one attempt of `kind` for this connection. Returns a 429 { ok: false, error: "slow_down" } Response when the
 * connection is over its limit, otherwise null (go on). Null too without a database, or when counting itself failed.
 */
export async function publicLimit(env, request, kind, now = Date.now()) {
  const spec = PUBLIC_LIMITS[kind];
  if (!spec) throw new Error("unknown public limit: " + kind);
  if (!env || !env.DB) return null;
  try {
    await ensureLimitsSchema(env.DB);
    const key = await limitKey(env, "pub:" + kind, clientKey(request));
    const r = await check(env, [{ key, windowMs: spec.windowMs, max: spec.max }], now);
    if (r.ok) return null;
    return json({ ok: false, error: "slow_down" }, 429, { "Retry-After": String(Math.ceil(spec.windowMs / 1000)) });
  } catch (e) {
    // a short code only: never the request, never an address
    console.error("public limit skipped", kind, String((e && e.message) || e).slice(0, 80));
    return null;
  }
}
