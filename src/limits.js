/**
 * Attempt counters for people who are not signed in yet (sign-up, e-mail codes, password log-in).
 *
 * Why not the existing countRecent/noteEvent (src/attest.js): that is check-then-insert, so 60 requests that
 * arrive together all read "0" and all pass, and it is keyed by a user id, which an anonymous visitor does not have.
 * Here every hit is ONE atomic statement (insert-or-increment, returning the new count): parallel requests get
 * distinct counts 1, 2, 3 ... and the first ones over the maximum are refused. The attempt is counted BEFORE the
 * work it guards, so a flood cannot all pass and cannot burn CPU (hashing happens after the check).
 *
 * Nothing identifying is kept: a key is a kind plus the first 22 characters of an HMAC (secret salt) of the
 * thing counted (a connection, an e-mail address, a sign-up id). A raw IP address or e-mail is never stored.
 * Fixed windows: a burst of twice the maximum is possible right at a window edge, and is accepted.
 * A database failure throws (the caller answers an error): never "allow everything because counting failed".
 */
import { b64url } from "./http.js";
import { ensureSchema } from "./store.js";
import { iso } from "./policy.js";

// One atomic counter hit: ?1 key, ?2 now, ?3 now minus the window. A row older than its window restarts at 1.
const HIT = `INSERT INTO auth_limits (key, n, window_start) VALUES (?1, 1, ?2)
 ON CONFLICT(key) DO UPDATE SET
   n = CASE WHEN window_start <= ?3 THEN 1 ELSE n + 1 END,
   window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
 RETURNING n`;
// Give one hit back after a success, so a person who gets it right never builds up a count.
const REFUND = "UPDATE auth_limits SET n = MAX(n - 1, 0) WHERE key = ?1";

const hmacKeys = new WeakMap();

/** The HMAC key for limit keys: the LIMIT_SALT setting, or a random one made once and kept in the database (same pattern as attest_key). */
function saltKey(env) {
  if (!hmacKeys.has(env)) {
    hmacKeys.set(env, (async () => {
      let secret = env.LIMIT_SALT;
      if (!secret) {
        await ensureSchema(env.DB);
        await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('limit_salt', ?)").bind(b64url(crypto.getRandomValues(new Uint8Array(32)))).run();
        secret = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'limit_salt'").first()).value;
      }
      return crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })().catch((e) => { hmacKeys.delete(env); throw e; }));
  }
  return hmacKeys.get(env);
}

/**
 * `kind:<22 characters>`: the counter's name, safe to store. `parts` (an address, an IP, a sign-up id ...) are
 * joined with a newline before the HMAC, so ("a", "bc") and ("ab", "c") never collide.
 */
export async function limitKey(env, kind, ...parts) {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await saltKey(env), new TextEncoder().encode(`${kind}\n${parts.join("\n")}`)));
  return `${kind}:${b64url(mac).slice(0, 22)}`;
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const v4ok = (m) => m && m.slice(1).every((x) => Number(x) <= 255);

/** First 64 bits of an IPv6 address as "a:b:c:d::/64", or null if it is not an IPv6 address. IPv4-mapped (::ffff:1.2.3.4) gives the IPv4 address. */
function v6prefix(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const tail4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail4) {
    const m = tail4[2].match(V4);
    if (!v4ok(m)) return null;
    if (/^::(ffff:)?$/.test(tail4[1])) return tail4[2]; // IPv4 in an IPv6 wrapper: same person as plain IPv4
    const [a, b, c, d] = m.slice(1).map(Number);
    s = tail4[1] + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups;
  if (halves.length === 2) {
    if (head.length + rest.length > 7) return null;
    groups = [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest];
  } else groups = head;
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/**
 * Who is connecting: Cloudflare's cf-connecting-ip (set by Cloudflare, a visitor cannot forge it), with an IPv6
 * address cut to its /64 (one home or phone gets a whole /64, so rotating inside it must not escape a limit),
 * or "none" when there is no usable address. This is only ever an INPUT to limitKey, never stored.
 */
export function clientKey(request) {
  const raw = (request.headers.get("cf-connecting-ip") || "").trim();
  if (!raw || raw.length > 64) return "none";
  const m = raw.match(V4);
  if (m) return v4ok(m) ? raw : "none";
  return v6prefix(raw) || "none";
}

/** Count one attempt on each counter, in ONE database batch. specs: [{ key, windowMs }]. Returns the new count of each, in order. */
export async function hits(env, specs, now = Date.now()) {
  if (!specs.length) return [];
  const r = await env.DB.batch(specs.map((s) => env.DB.prepare(HIT).bind(s.key, iso(now), iso(now - s.windowMs))));
  return r.map((x) => Number(x.results[0].n));
}

/** hits() and compare: ok is false as soon as any counter is over its maximum. specs: [{ key, windowMs, max }]. */
export async function check(env, specs, now = Date.now()) {
  const n = await hits(env, specs, now);
  return { ok: n.every((c, i) => c <= specs[i].max), n };
}

/** What one counter says right now, without counting a try (0 when it has no row or its window is over). For caps that count only what really happened. */
export async function peek(env, key, windowMs, now = Date.now()) {
  const row = await env.DB.prepare("SELECT n FROM auth_limits WHERE key = ? AND window_start > ?").bind(key, iso(now - windowMs)).first();
  return row ? Number(row.n) : 0;
}

/** Give one attempt back on each counter (after a success). Never goes below zero. */
export async function refund(env, keys) {
  if (!keys.length) return;
  await env.DB.batch(keys.map((k) => env.DB.prepare(REFUND).bind(k)));
}
