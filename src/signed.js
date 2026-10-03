/**
 * Checking a message signed by a Solana wallet (verify, sign in, claim a city).
 * Signing is free, is not a transaction and cannot move funds.
 */
import { json, sha256 } from "./http.js";
import { isSolanaAddress, parseMessage, verifySignature } from "./solana.js";
import { ensureSchema } from "./store.js";

export const MAX_AGE_MS = 10 * 60 * 1000; // a signed message is valid for 10 minutes
export const MAX_BODY = 4096;
const CLOCK_SLACK_MS = 60_000;            // a message may be dated up to a minute ahead of this server's clock

export function base64ToBytes(b64) {
  if (typeof b64 !== "string" || b64.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("bad_b64");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Read a signed-message request and check it fully: format, this site, not expired,
 * and a real signature from the address. Returns { parsed, body } or { error: Response }.
 * With `db`, the message also works only once (see checkSigned).
 */
export async function readSigned(request, now, actions, errKey, maxBody = MAX_BODY, db = null) {
  const bad = (error, status = 400) => ({ error: json({ [errKey]: false, error }, status) });
  const len = Number(request.headers.get("content-length") || 0);
  if (len > maxBody) return bad("too_large", 413);
  let body;
  try {
    const text = await request.text();
    if (text.length > maxBody) return bad("too_large", 413);
    body = JSON.parse(text);
  } catch {
    return bad("bad_json");
  }
  return checkSigned(body, request, now, actions, bad, db);
}

/**
 * Check a signed message. With `db`, a message that passed once is refused the next time ("replayed", 409): a
 * captured { address, message, signature } cannot open a second session or re-prove a wallet during the 10
 * minutes it would otherwise stay valid. Without `db` the check is exactly as before.
 */
export async function checkSigned(body, request, now, actions, bad, db = null) {
  const { address, message, signature } = body || {};
  if (!isSolanaAddress(address)) return bad("bad_address");

  const parsed = parseMessage(message);
  if (!parsed || !actions.includes(parsed.action)) return bad("bad_message");

  const host = new URL(request.url).host;
  if (parsed.host !== host) return bad("wrong_site");
  if (parsed.address !== address) return bad("address_mismatch");

  const issued = Date.parse(parsed.issuedAt);
  if (!Number.isFinite(issued) || issued > now + CLOCK_SLACK_MS || now - issued > MAX_AGE_MS) return bad("expired");

  let sig;
  try { sig = base64ToBytes(signature); } catch { return bad("bad_signature"); }

  let ok = false;
  try { ok = await verifySignature(address, message, sig); } catch { ok = false; }
  if (!ok) return bad("signature_mismatch", 401);
  if (db && (await noteMessage(db, message, issued)) === false) return bad("replayed", 409);
  return { parsed, body };
}

/**
 * Remember that this signed message was used. The row is a digest of the whole message (the nonce, the address, the
 * time and the statement together), kept in used_nonces until the moment the message would be too old anyway; the
 * scheduled job sweeps the table (src/jobs.js). Returns false when the message was already there, true when it was
 * new, and null when the database could not say. Then the message is accepted as it always was: a session or a
 * re-proof needs that same database a moment later, so a broken database never lets a replay in through this gap,
 * and the public verify route is covered by its attempt limit (src/guards.js).
 */
async function noteMessage(db, message, issued) {
  try {
    await ensureSchema(db);
    const expires = new Date(issued + MAX_AGE_MS + CLOCK_SLACK_MS).toISOString();
    const ins = await db.prepare("INSERT OR IGNORE INTO used_nonces (nonce, expires_at) VALUES (?, ?)").bind("msg:" + await sha256(message), expires).run();
    return Boolean(ins.meta && ins.meta.changes);
  } catch (e) {
    console.error("used message store failed", String((e && e.message) || e).slice(0, 80)); // the reason only, never the message
    return null;
  }
}
