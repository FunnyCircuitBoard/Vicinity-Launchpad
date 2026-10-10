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
import { getCookie, json } from "./http.js";
import { check, clientKey, limitKey } from "./limits.js";
import { ensureLimitsSchema } from "./store.js";
import { SESSION_COOKIE } from "./auth.js";

const MIN = 60_000;
export const PUBLIC_LIMITS = {
  verify:         { max: 30, windowMs: 10 * MIN },  // POST /api/verify: one RPC call each
  // POST /api/auth/transfer: one pending session each. 30 and not 10 because the transfer proof is the sign-in path
  // for wallet-app browsers, i.e. phones, and hundreds of phones share one address on a mobile network.
  transfer:       { max: 30, windowMs: 10 * MIN },
  // POST /api/auth/transfer/check: up to 11 RPC calls each, but at most one blockchain look per 8 seconds per session
  // (src/auth.js). Counted per SESSION (the proof it checks lives in the session), so two people behind one address
  // do not use up each other's polls: the page asks every 10 seconds, 60 times in the 10 minutes. Without a session
  // cookie the connection is counted (such a check answers "no proof" and costs nothing).
  transfer_check: { max: 90, windowMs: 10 * MIN, by: "session" },
  pair:           { max: 20, windowMs: 10 * MIN },  // POST /api/pair: one row each
  rank:           { max: 60, windowMs: MIN },       // GET /api/rank: an RPC call when the snapshot is down (a cache hit is not counted)
  // GET /api/coin and /api/coin/chart (LAUNCHPAD_V2=on): outside sources and the database on an edge-cache miss (a hit is not counted)
  coin:           { max: 60, windowMs: MIN },
  coin_chart:     { max: 60, windowMs: MIN },
  // the in-app swap (SWAP=on, src/swap.js, src/relay.js): a Jupiter call (quote, tx), an RPC call (send, status, balances), a token search.
  // A mobile network puts dozens of phones behind one address: an open panel re-quotes every 12 s (5 a minute), so 180 a
  // minute per connection leaves room for a crowd; Jupiter itself is protected by the per-server budget (JUPITER_RPS), not here.
  swap_quote:     { max: 180, windowMs: MIN },
  swap_tx:        { max: 20, windowMs: MIN },
  // the Buy panel's own builds, made BEFORE the tap so the exact price is on the screen (public/swap.js, `?auto=1`): counted
  // apart from the taps, so a crowd behind one address (a carrier, iCloud Private Relay) that is only reading its prices can
  // never use up the builds a Buy tap needs. One browser builds by itself at most 8 times a minute, about 2 a minute while a
  // price just sits there and none after 3 quiet rebuilds: 60 is two or three dozen people reading, or seven typing at once.
  // Past it a page simply waits for the tap ("Tap Buy to get your price").
  swap_tx_auto:   { max: 60, windowMs: MIN },
  swap_send:      { max: 20, windowMs: MIN },
  // the status poll is counted per SIGNATURE first (STATUS_LIMIT below: one person's polling never consumes another's);
  // the per-connection number is the brake on a flood of invented signatures: each poll is one RPC credit (the block height is
  // shared for 2 s per server). 600 let one connection spend about 860K credits a day; 120 is four trades confirming at once
  // behind one address (a page polls 30 times a minute), and a page that meets the limit waits and says "Still checking…"
  // without losing its trade (public/swap.js watch)
  swap_status:    { max: 120, windowMs: MIN },
  swap_balances:  { max: 60, windowMs: MIN },
  swap_tokens:    { max: 30, windowMs: MIN },
  // curve trades on our launchpad (LAUNCHPAD_TRADING=on, src/lptrade.js): the launchpad RPC on every call
  lp_quote:       { max: 60, windowMs: MIN },
  lp_tx:          { max: 20, windowMs: MIN },
  lp_tx_auto:     { max: 60, windowMs: MIN }, // the curve's builds before the tap, apart from the taps (see swap_tx_auto)
};
/**
 * A per-WALLET counter on top of the per-connection one (src/swap.js, src/lptrade.js): one wallet cannot burn the Jupiter or RPC
 * budget from many connections. The automatic builds have their own (`<kind>_auto_wallet`, the same 15 a minute), so a person's
 * own taps never find their wallet's builds used up by the prices their pages made by themselves.
 */
export const WALLET_LIMIT = { max: 15, windowMs: MIN };
/** The counter of a transaction build: `kind` for a tap, `kind_auto` for a build the page made by itself (`?auto=1` on the route). */
export const buildKind = (request, kind) => { try { return new URL(request.url).searchParams.get("auto") === "1" ? `${kind}_auto` : kind; } catch { return kind; } };
/** Per SIGNATURE for GET /api/swap/status: a page polls every 2 seconds (30 a minute); two tabs watching one trade still fit. */
export const STATUS_LIMIT = { max: 60, windowMs: MIN };

/**
 * Count one attempt of `kind` for `value` (a wallet, a signature: whatever the route is really spending on), with its own
 * ceiling. Returns a 429 { ok: false, error: "slow_down" } Response when it is over its limit, otherwise null (go on).
 * Null too without a database, or when counting itself failed. The value is HMAC'd like every other key: never stored.
 */
export async function keyLimit(env, kind, value, spec, now = Date.now()) {
  if (!env || !env.DB || !value) return null;
  try {
    await ensureLimitsSchema(env.DB);
    const key = await limitKey(env, "pub:" + kind, value);
    const r = await check(env, [{ key, windowMs: spec.windowMs, max: spec.max }], now);
    if (r.ok) return null;
    return json({ ok: false, error: "slow_down" }, 429, { "Retry-After": String(Math.ceil(spec.windowMs / 1000)) });
  } catch (e) {
    console.error("limit skipped", kind, String((e && e.message) || e).slice(0, 80));
    return null;
  }
}
/** The per-wallet counter of a kind (`<kind>_wallet`): WALLET_LIMIT attempts a minute, from however many connections. */
export const walletLimit = (env, kind, wallet, now = Date.now()) => keyLimit(env, kind + "_wallet", wallet, WALLET_LIMIT, now);

export async function publicLimit(env, request, kind, now = Date.now()) {
  const spec = PUBLIC_LIMITS[kind];
  if (!spec) throw new Error("unknown public limit: " + kind);
  if (!env || !env.DB) return null;
  try {
    await ensureLimitsSchema(env.DB);
    const session = spec.by === "session" ? getCookie(request, SESSION_COOKIE) : null;
    const key = session ? await limitKey(env, "pub:" + kind, "session", session) : await limitKey(env, "pub:" + kind, clientKey(request));
    const r = await check(env, [{ key, windowMs: spec.windowMs, max: spec.max }], now);
    if (r.ok) return null;
    return json({ ok: false, error: "slow_down" }, 429, { "Retry-After": String(Math.ceil(spec.windowMs / 1000)) });
  } catch (e) {
    // a short code only: never the request, never an address
    console.error("public limit skipped", kind, String((e && e.message) || e).slice(0, 80));
    return null;
  }
}
