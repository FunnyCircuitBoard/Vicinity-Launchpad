/**
 * Checking a message signed by a Solana wallet (verify, sign in, claim a city).
 * Signing is free, is not a transaction and cannot move funds.
 */
import { json } from "./http.js";
import { isSolanaAddress, parseMessage, verifySignature } from "./solana.js";

export const MAX_AGE_MS = 10 * 60 * 1000; // a signed message is valid for 10 minutes
export const MAX_BODY = 4096;

export function base64ToBytes(b64) {
  if (typeof b64 !== "string" || b64.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("bad_b64");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Read a signed-message request and check it fully: format, this site, not expired,
 * and a real signature from the address. Returns { parsed, body } or { error: Response }.
 */
export async function readSigned(request, now, actions, errKey, maxBody = MAX_BODY) {
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
  return checkSigned(body, request, now, actions, bad);
}

export async function checkSigned(body, request, now, actions, bad) {
  const { address, message, signature } = body || {};
  if (!isSolanaAddress(address)) return bad("bad_address");

  const parsed = parseMessage(message);
  if (!parsed || !actions.includes(parsed.action)) return bad("bad_message");

  const host = new URL(request.url).host;
  if (parsed.host !== host) return bad("wrong_site");
  if (parsed.address !== address) return bad("address_mismatch");

  const issued = Date.parse(parsed.issuedAt);
  if (!Number.isFinite(issued) || issued > now + 60_000 || now - issued > MAX_AGE_MS) return bad("expired");

  let sig;
  try { sig = base64ToBytes(signature); } catch { return bad("bad_signature"); }

  let ok = false;
  try { ok = await verifySignature(address, message, sig); } catch { ok = false; }
  if (!ok) return bad("signature_mismatch", 401);
  return { parsed, body };
}
