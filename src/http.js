/**
 * Small HTTP helpers shared by every API route: JSON answers with the security headers,
 * cookies, reading a JSON body safely, redirects, and a same-site check for requests
 * that change something.
 */
export const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self)",
  // Browsers remember to use https:// for a year (ignored on http:// and on this computer).
  "Strict-Transport-Security": "max-age=31536000",
  "Cache-Control": "no-store",
};

export function json(data, status = 200, headers = {}) {
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) for (const x of v) h.append(k, x);
    else h.set(k, v);
  }
  return new Response(JSON.stringify(data), { status, headers: h });
}

/** 302 to a page on this site or to a login provider. Extra Set-Cookie values can ride along. */
export function redirect(location, cookies = []) {
  const h = new Headers({ Location: location, ...SECURITY_HEADERS });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers: h });
}

/** Read a JSON body of at most `max` bytes. Returns the object, or null if it's missing, too big or broken. */
export async function readJson(request, max = 4096) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > max) return null;
  try {
    const text = await request.text();
    if (text.length > max) return null;
    const body = JSON.parse(text);
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

export function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

/**
 * A cookie only this site can read, only over https, never readable by page scripts.
 * (Browsers treat http://localhost as secure, so local development works too.)
 */
export function cookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}
export const clearCookie = (name) => cookie(name, "", 0);

/**
 * Requests that change something must come from this site's own pages. Browsers always send
 * Origin on POST, so a missing or foreign Origin means another website (or a script) is trying.
 */
export function sameSite(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

export const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return b64url(d);
}
