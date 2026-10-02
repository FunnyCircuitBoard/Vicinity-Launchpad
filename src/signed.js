// src/signed.js: recovered from the code deployed on Cloudflare (Worker "vicinity-map", 2026-10-02).
// The original comments and formatting were lost in the bundle; the code is the deployed code, byte for byte after bundling.
import { json } from "./http.js";
import { isSolanaAddress, parseMessage, verifySignature } from "./solana.js";
var MAX_AGE_MS = 10 * 60 * 1e3;
var MAX_BODY = 4096;
function base64ToBytes(b642) {
  if (typeof b642 !== "string" || b642.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b642)) throw new Error("bad_b64");
  const bin = atob(b642);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function readSigned(request, now, actions, errKey, maxBody = MAX_BODY) {
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
async function checkSigned(body, request, now, actions, bad) {
  const { address, message, signature } = body || {};
  if (!isSolanaAddress(address)) return bad("bad_address");
  const parsed = parseMessage(message);
  if (!parsed || !actions.includes(parsed.action)) return bad("bad_message");
  const host = new URL(request.url).host;
  if (parsed.host !== host) return bad("wrong_site");
  if (parsed.address !== address) return bad("address_mismatch");
  const issued = Date.parse(parsed.issuedAt);
  if (!Number.isFinite(issued) || issued > now + 6e4 || now - issued > MAX_AGE_MS) return bad("expired");
  let sig;
  try {
    sig = base64ToBytes(signature);
  } catch {
    return bad("bad_signature");
  }
  let ok = false;
  try {
    ok = await verifySignature(address, message, sig);
  } catch {
    ok = false;
  }
  if (!ok) return bad("signature_mismatch", 401);
  return { parsed, body };
}
export { checkSigned, readSigned };
