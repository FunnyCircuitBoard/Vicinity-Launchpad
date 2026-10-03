/**
 * Passwords for e-mail accounts: the rules, the hash, and the check.
 *
 * Stored as  pbkdf2-sha256$100000$<salt>$<hash>[$p1]  (salt 16 random bytes, hash 32 bytes, both base64url).
 * The hash is PBKDF2 with SHA-256, the strongest the Workers runtime allows (it refuses more than 100,000 rounds,
 * which is 6 times below today's guideline of 600,000). To make up for that:
 *   - an optional site-wide secret, PASSWORD_PEPPER, is mixed in first (HMAC), so a stolen copy of the database
 *     alone cannot be attacked offline. The `$p1` field says "this hash used pepper number 1". Unset = no pepper,
 *     and there is deliberately no default: a pepper added later upgrades old hashes at the next successful log-in.
 *     A hash made WITH a pepper never verifies without it (fail closed, never a silent downgrade);
 *   - a blocklist of common passwords, a 10 character minimum (no composition rules), strict attempt limits (src/limits.js).
 * One hash costs about 50 ms of CPU (the Workers Paid plan allows it, the Free plan's 10 ms does not).
 * PASSWORD_ITERATIONS can only LOWER the cost (tests, emergencies): never above 100,000, never below 1,000.
 * Nothing here logs a password, a hash or an address.
 */
import { b64url } from "./http.js";
import { COMMON } from "./common-passwords.js";

export const PASSWORD_MIN = 10, PASSWORD_MAX = 128;
export const PBKDF2_ROUNDS = 100_000;          // the most the Workers runtime accepts
const MIN_ROUNDS = 1_000;                      // below this a stored value is treated as corrupt
const SALT_BYTES = 16, HASH_BYTES = 32;
const VERIFY_MAX_CHARS = 1024;                 // refuse absurd input before any work

/** Test hook: how many PBKDF2 derivations ran (tests compare CPU work, not wall-clock time). */
export const _stats = { derives: 0 };

/** Rounds for NEW hashes: 100,000, or the (lower) PASSWORD_ITERATIONS. Anything unusable falls back to 100,000. */
export function currentRounds(env) {
  const n = Number(env && env.PASSWORD_ITERATIONS);
  return Number.isInteger(n) && n >= MIN_ROUNDS ? Math.min(n, PBKDF2_ROUNDS) : PBKDF2_ROUNDS;
}

const enc = (s) => new TextEncoder().encode(s);
const pepperOf = (env) => (env && typeof env.PASSWORD_PEPPER === "string" && env.PASSWORD_PEPPER.length > 0 ? env.PASSWORD_PEPPER : null);

function unb64url(s, bytes) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    return out.length === bytes && b64url(out) === s ? out : null; // exact length and the canonical spelling only
  } catch { return null; }
}

/** The text that goes into PBKDF2: the NFKC-normalized password (same text from any keyboard), or its HMAC under the pepper. */
async function secretFor(password, pepper) {
  const text = password.normalize("NFKC");
  if (pepper == null) return text;
  const key = await crypto.subtle.importKey("raw", enc(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc(text))));
}

async function derive(secret, salt, rounds) {
  _stats.derives++;
  const key = await crypto.subtle.importKey("raw", enc(secret), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, key, HASH_BYTES * 8));
}

/** Compare two byte arrays in time that does not depend on where they differ. */
export function constantTimeEqual(a, b) {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] | 0) ^ (b[i] | 0);
  return diff === 0;
}

export async function hashPassword(env, password) {
  if (typeof password !== "string") throw new TypeError("password must be a string");
  if (password.length > VERIFY_MAX_CHARS) throw new RangeError("password too long"); // it could never be verified
  const pepper = pepperOf(env), rounds = currentRounds(env);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(await secretFor(password, pepper), salt, rounds);
  return `pbkdf2-sha256$${rounds}$${b64url(salt)}$${b64url(hash)}${pepper == null ? "" : "$p1"}`;
}

/** A stored value as { rounds, salt, hash, peppered }, or null if it is not exactly what hashPassword writes. */
function parse(stored) {
  if (typeof stored !== "string" || stored.length > 200) return null;
  const f = stored.split("$");
  if ((f.length !== 4 && f.length !== 5) || f[0] !== "pbkdf2-sha256" || (f.length === 5 && f[4] !== "p1")) return null;
  if (!/^\d{4,6}$/.test(f[1])) return null;
  const rounds = Number(f[1]);
  if (String(rounds) !== f[1] || rounds < MIN_ROUNDS || rounds > PBKDF2_ROUNDS) return null;
  const salt = unb64url(f[2], SALT_BYTES), hash = unb64url(f[3], HASH_BYTES);
  return salt && hash ? { rounds, salt, hash, peppered: f.length === 5 } : null;
}

const ZERO_SALT = new Uint8Array(SALT_BYTES);

/**
 * Check a password against a stored value. ALWAYS exactly one PBKDF2 derivation, whatever the input: an unknown
 * address (stored null), an account without a password, a corrupt value and a wrong password all cost the same,
 * so the time taken says nothing about which one it was. A value that cannot be checked is simply "not ok".
 * Returns { ok, rehash }: rehash is true after a successful check when the stored value should be rewritten
 * (made with fewer rounds than now, or before a pepper was configured).
 */
export async function verifyPassword(env, stored, password) {
  const pepper = pepperOf(env);
  const text = typeof password === "string" && password.length <= VERIFY_MAX_CHARS ? password : "";
  const parsed = typeof password === "string" && password.length <= VERIFY_MAX_CHARS ? parse(stored) : null;
  if (parsed && parsed.peppered && pepper == null) {
    console.error("pepper missing"); // a peppered hash cannot be checked without the pepper: fail closed
    await derive(await secretFor(text, null), ZERO_SALT, currentRounds(env));
    return { ok: false, rehash: false };
  }
  if (!parsed) { // nothing to compare with: do the same work and say no
    await derive(await secretFor(text, pepper), ZERO_SALT, currentRounds(env));
    return { ok: false, rehash: false };
  }
  const got = await derive(await secretFor(text, parsed.peppered ? pepper : null), parsed.salt, parsed.rounds);
  const ok = constantTimeEqual(got, parsed.hash);
  return { ok, rehash: ok && (parsed.rounds < currentRounds(env) || (!parsed.peppered && pepper != null)) };
}

// ---- the rules ----

const TRAILING = /[0-9!@#$%^&*._-]+$/;

/** One short unit repeated (1212121212, 123123123123, aaaaaaaaaa), or a longer common word repeated (passwordpassword). */
function repeated(chars) {
  const n = chars.length;
  for (let u = 1; u <= n / 2; u++) {
    if (n % u) continue;
    let same = true;
    for (let i = u; i < n && same; i++) same = chars[i] === chars[i - u];
    if (same && (u <= 3 || COMMON.has(chars.slice(0, u).join("")))) return true;
  }
  return false;
}

/** Every character one step after (or before) the last: abcdefghij, 9876543210, and digits that wrap round (1234567890123). */
function run(chars) {
  const code = (c) => c.codePointAt(0);
  const digits = chars.every((c) => c >= "0" && c <= "9");
  const diff = (i) => (digits ? (code(chars[i]) - code(chars[i - 1]) + 10) % 10 : code(chars[i]) - code(chars[i - 1]));
  const step = digits ? (diff(1) === 1 ? 1 : diff(1) === 9 ? 9 : 0) : diff(1);
  if (digits ? step === 0 : Math.abs(step) !== 1) return false;
  for (let i = 2; i < chars.length; i++) if (diff(i) !== step) return false;
  return true;
}

/** The password, then the password with its trailing digits and symbols taken off one at a time ("trustno11234" -> "trustno1" -> "trustno"). */
function* bases(lower) {
  yield lower;
  const tail = lower.match(TRAILING);
  if (!tail) return;
  for (let cut = 1; cut <= tail[0].length; cut++) yield lower.slice(0, lower.length - cut);
}

/**
 * null when the password is acceptable, else the reason as a short code (the page turns each into one plain
 * sentence): bad_password (not text), password_short, password_long, password_common, password_is_email.
 * Length counts what the person sees (characters after NFKC), not bytes. No "must contain a number" rules.
 */
export function checkPassword(password, email) {
  if (typeof password !== "string") return "bad_password";
  if (password.length > 4096) return "password_long"; // before any work on it
  const nfkc = password.normalize("NFKC");
  const chars = Array.from(nfkc);
  if (chars.length < PASSWORD_MIN) return "password_short";
  if (chars.length > PASSWORD_MAX) return "password_long";

  const lower = nfkc.toLowerCase();
  const lowerChars = Array.from(lower);
  // Spaces, tabs and invisible characters make a guess no harder to try ("password  " is 10 characters), so the rules also look at the
  // password without them. A passphrase with real words in it is not touched: "correct horse battery staple" stays one.
  const bare = lower.replace(/[\p{Z}\p{C}]/gu, "");
  const padded = bare !== lower && bare !== "";
  const bareChars = padded ? Array.from(bare) : lowerChars;
  if (repeated(lowerChars) || run(lowerChars) || (padded && (repeated(bareChars) || run(bareChars)))) return "password_common";
  for (const base of bases(lower)) if (base && COMMON.has(base)) return "password_common";
  if (padded) for (const base of bases(bare)) if (COMMON.has(base)) return "password_common";

  if (typeof email === "string" && email) {
    const address = email.normalize("NFKC").trim().toLowerCase();
    const local = address.split("@")[0];
    if (lower === address || (local && lower === local) || (padded && (bare === address || (local && bare === local)))) return "password_is_email";
  }
  return null;
}
