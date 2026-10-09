/**
 * Solana helpers for "Verify wallet ownership".
 *
 * Verification = the visitor signs a plain text message with their wallet.
 * It is NOT a transaction: it cannot move funds and costs nothing.
 * We check the signature with the Ed25519 algorithm built into the platform.
 */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58].map((c, i) => [c, i]));

/** Decode a base58 string to bytes. Throws on invalid input. */
export function base58Decode(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > 128) throw new Error("bad_base58");
  const bytes = [];
  for (const ch of str) {
    const val = B58_MAP.get(ch);
    if (val === undefined) throw new Error("bad_base58");
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of str) { if (ch === "1") bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}

/** Encode bytes to base58. */
export function base58Encode(bytes) {
  const digits = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const b of bytes) { if (b === 0) out += "1"; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** True if the string looks like a Solana address (32 bytes in base58). */
export function isSolanaAddress(str) {
  if (typeof str !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(str)) return false;
  try { return base58Decode(str).length === 32; } catch { return false; }
}

export const MESSAGE_STATEMENT =
  "Verify wallet ownership for Vicinity. This is free, is not a transaction, and cannot move funds.";

const FREE = "Free, not a transaction, cannot move funds.";

/** A city name we accept: letters (any language), spaces and . ' - only. */
export const CITY_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,58}[\p{L}\p{M}.]$/u;

/**
 * The one line that says what the wallet is agreeing to.
 *   verify → prove you own the wallet
 *   claim  → claim a listed city (by id)
 *   add    → add a missing city and claim it
 *   login  → sign in to your dashboard (with a 2-digit check number when a phone signs in for a computer)
 *   link   → link this wallet to the account named in the statement (onboarding v3: the account exists first, the wallet comes
 *            later; with a check number when a wallet app approves for another device). A login statement never links and a
 *            link statement never signs anyone in: the two are different sentences.
 */
export function statementFor(action = "verify", { cityId, name, country, pin, handle } = {}) {
  if (action === "claim") return `Claim city #${cityId} (${country}) for this wallet on Vicinity. ${FREE}`;
  if (action === "add") return `Add the city "${name}" (${country}) and claim it for this wallet on Vicinity. ${FREE}`;
  if (action === "login" && pin) return `Sign in to Vicinity on my other device (check number ${pin}). ${FREE}`;
  if (action === "login") return `Sign in to Vicinity with this wallet. ${FREE}`;
  if (action === "link" && pin) return `Link this wallet to my Vicinity account @${handle} on my other device (check number ${pin}). ${FREE}`;
  if (action === "link") return `Link this wallet to my Vicinity account @${handle}. ${FREE}`;
  return MESSAGE_STATEMENT;
}

function parseStatement(line) {
  if (line === MESSAGE_STATEMENT) return { action: "verify" };
  if (line === statementFor("login")) return { action: "login" };
  const pin = line.match(/^Sign in to Vicinity on my other device \(check number ([0-9]{2})\)\. /);
  if (pin && line === statementFor("login", { pin: pin[1] })) return { action: "login", pin: pin[1] };
  const link = line.match(/^Link this wallet to my Vicinity account @([A-Za-z][A-Za-z0-9_]{0,39})(?: on my other device \(check number ([0-9]{2})\))?\. /);
  if (link && line === statementFor("link", { handle: link[1], pin: link[2] })) return { action: "link", handle: link[1], ...(link[2] ? { pin: link[2] } : {}) };
  let m = line.match(/^Claim city #([0-9]{1,10}|c[0-9]{1,9}) \(([A-Z]{2})\) for this wallet on Vicinity\. /);
  if (m && line === statementFor("claim", { cityId: m[1], country: m[2] })) return { action: "claim", cityId: m[1], country: m[2] };
  m = line.match(/^Add the city "(.+)" \(([A-Z]{2})\) and claim it for this wallet on Vicinity\. /);
  if (m && CITY_NAME_RE.test(m[1]) && line === statementFor("add", { name: m[1], country: m[2] }))
    return { action: "add", name: m[1], country: m[2] };
  return null;
}

/** Build the exact message the wallet signs. The browser and server must agree on this format. */
export function buildMessage({ host, address, nonce, issuedAt, statement = MESSAGE_STATEMENT }) {
  return [
    `${host} wants you to sign in with your Solana account:`,
    address,
    "",
    statement,
    "",
    `URI: https://${host}`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

/** Parse a message produced by buildMessage. Returns null if the format is wrong. */
export function parseMessage(message) {
  if (typeof message !== "string" || message.length > 1000) return null;
  const lines = message.split("\n");
  if (lines.length !== 10) return null;
  const m0 = lines[0].match(/^([a-z0-9.-]+(?::\d+)?) wants you to sign in with your Solana account:$/);
  const nonce = lines[8].match(/^Nonce: ([A-Za-z0-9]{16,64})$/);
  const issued = lines[9].match(/^Issued At: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/);
  if (!m0 || !nonce || !issued) return null;
  const st = parseStatement(lines[3]);
  if (!st) return null;
  const parsed = { host: m0[1], address: lines[1], nonce: nonce[1], issuedAt: issued[1], statement: lines[3], ...st };
  return buildMessage(parsed) === message ? parsed : null;
}

/** Verify an Ed25519 signature made by a Solana wallet. */
export async function verifySignature(addressB58, messageText, signatureBytes) {
  const pub = base58Decode(addressB58);
  if (pub.length !== 32 || signatureBytes.length !== 64) return false;
  const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, signatureBytes, new TextEncoder().encode(messageText));
}
