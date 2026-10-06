/**
 * The plumbing every outside market source shares (only while LAUNCHPAD_V2=on, see src/marketlive.js): one way to ask a JSON
 * API, and one per-key cache with a negative cache, so the Worker never asks a source more often than its limits allow.
 *
 * getJson    GET with our User-Agent (Raydium and Jupiter answer 403 to some default agents), a 3.5 s timeout, ONE retry
 *            after a network error or a timeout (never after an HTTP answer), a JSON content type required (a Cloudflare
 *            challenge page is HTML and is a failure, not data), at most 1 MB read. Failures throw a SourceError whose code is
 *            short and safe to log: it never carries a URL, an address or the body.
 * Source     answers for many keys at once (mints, pools): a key asked within `ttlMs` is answered from memory; the rest go
 *            to the source in ONE call. When that call fails, nothing is asked again for `negativeMs` (5 s, longer when the
 *            source sent Retry-After, at most 60 s), and each key gets its last good value for up to `staleMs`, marked stale.
 *            A value of null means "the source answered and has nothing for this key" (kept like any answer); undefined means
 *            "unknown: the source could not be asked". Callers running at the same time share one call.
 */
export const USER_AGENT = "vicinity.city/1.0 (+https://vicinity.city)";
const MAX_BYTES = 1_000_000;

export class SourceError extends Error {
  constructor(code, retryAfterMs = 0) { super(code); this.code = code; this.retryAfterMs = retryAfterMs; }
}
/** A short code for any error, safe for the log and for an answer: letters, digits and _ only, at most 40 characters, never an address. */
export const codeOf = (e) => String((e && (e.code || e.message)) || e || "error").replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, "address").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);

/** Retry-After in milliseconds (seconds or an HTTP date), 0 when missing or unreadable. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === "") return 0;
  if (/^\d{1,6}$/.test(String(value).trim())) return Number(value) * 1000;
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

export async function getJson(url, fetchImpl = fetch, { timeoutMs = 3_500, headers = {}, retries = 1 } = {}) {
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      break;
    } catch (e) {
      if (attempt >= retries) throw new SourceError(e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network");
    }
  }
  if (res.status === 429) throw new SourceError("http_429", retryAfterMs(res.headers.get("retry-after")));
  if (!res.ok) throw new SourceError(`http_${res.status}`);
  if (!/\bjson\b/i.test(res.headers.get("content-type") || "")) throw new SourceError("not_json");
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new SourceError("too_big");
  try { return JSON.parse(text); } catch { throw new SourceError("bad_json"); }
}

export class Source {
  constructor(name, { ttlMs, staleMs = 5 * 60_000, negativeMs = 5_000, max = 2_000 } = {}) {
    Object.assign(this, { name, ttlMs, staleMs, negativeMs, max });
    this.reset();
  }
  reset() { this.entries = new Map(); this.failedUntil = 0; this.lastError = null; this.inflight = null; this.calls = 0; }

  /**
   * Values for `keys`: { values: Map(key -> value | null | undefined), ok, stale, error, at: Map(key -> ms the value was got) }.
   * fetchMany(keysToAsk) resolves to a Map(key -> value | null); a key it leaves out is null. Never throws.
   */
  async get(keys, now, fetchMany) {
    while (this.inflight) { try { await this.inflight; } catch { /* the caller that started it handles the error */ } }
    const values = new Map(), at = new Map(), want = [];
    for (const k of new Set(keys)) {
      const e = this.entries.get(k);
      if (e && now - e.at < this.ttlMs && now >= e.at) { values.set(k, e.value); at.set(k, e.at); } else want.push(k);
    }
    let ok = true, stale = false, error = null;
    if (want.length) {
      if (now < this.failedUntil) { ok = false; error = this.lastError || "unavailable"; }
      else {
        this.calls++;
        const run = Promise.resolve().then(() => fetchMany(want));
        this.inflight = run;
        try {
          const got = await run;
          for (const k of want) {
            const v = got instanceof Map && got.has(k) ? got.get(k) : null;
            this.entries.delete(k); this.entries.set(k, { at: now, value: v });
            values.set(k, v); at.set(k, now);
          }
          while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
        } catch (e) {
          ok = false; error = codeOf(e); this.lastError = error;
          this.failedUntil = now + Math.min(60_000, Math.max(this.negativeMs, (e && e.retryAfterMs) || 0));
        } finally { this.inflight = null; }
      }
      if (!ok) {
        for (const k of want) {
          const e = this.entries.get(k);
          if (e && e.value != null && now - e.at < this.staleMs) { values.set(k, e.value); at.set(k, e.at); stale = true; }
          else values.set(k, undefined);
        }
      }
    }
    return { values, ok, stale, error, at };
  }
}
