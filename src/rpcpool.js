/**
 * The Worker's one way to a Solana node. Every JSON-RPC request goes out through rpcPost(): rpc(), getHoldings() and
 * getMintBalances() in src/chain.js, rpcRaw() in src/relay.js (simulateTransaction, sendTransaction), and through them the
 * holder list, the swap, the launchpad's curve trades and the scheduled job. So no path keeps asking a provider that stopped
 * answering (10 Oct 2026: the free Helius key ran out and every chain read of the site failed at once).
 *
 * Endpoints (rpcTargets), in the order they are normally asked:
 *   mainnet  SOLANA_RPC_URL (else the public endpoint, as before), then SOLANA_RPC_URL_BACKUP when it is set and different.
 *            The launchpad's curve trades on mainnet put LAUNCHPAD_RPC_URL first when it is set; their backup is the same one.
 *   devnet   one node only (the launchpad's devnet RPC). Devnet never fails over, and never to a mainnet node (or back).
 *   Without SOLANA_RPC_URL_BACKUP every request goes to one node, exactly as before.
 *
 * The next endpoint is asked only when the PROVIDER fails: the fetch throws or times out, the answer is not JSON, HTTP 401 402
 * 403 404 408 410 429 or 5xx, or a JSON-RPC error that means "this provider will not serve you": -32429 (Helius: credits or rate),
 * -32005 (too many requests / node unhealthy), -32601 (method not served here), -32010 (not indexed here), -32603 for reads, or a
 * message about usage, credits, rate limits or the key. Never on an answer every node would give: bad params, a simulation or
 * preflight failure (data.err, logs), a missing account (null is an answer), a blockhash that is not found.
 *
 * Breaker (per server): an endpoint whose provider as a whole failed (key or credits refused, unreachable or too slow, 5xx) is
 * asked LAST for 60 s, so requests go to the backup first instead of waiting on a dead provider; a passing hiccup of one request
 * (a plain rate limit, a method not served, any failed send) moves only that request, and benches the endpoint only after 3
 * within 10 s. After the 60 s one request probes it again (with a deadline), and a good answer closes the breaker.
 * The backup is asked for its genesis hash before its first use (once per server): a node of another cluster is never used.
 *
 * sendTransaction: the same signed bytes may go to the backup once (the same signature: the chain lands a transaction at most
 * once). A node's verdict on the transaction (-32002 preflight failure, -32003 signature) is an answer and is never retried, and
 * nothing is ever re-signed or rebuilt here. rpcPost says when an attempt failed in a way after which the bytes may still have
 * gone out (`ambiguous`): src/relay.js then lets the chain decide instead of telling the person that nothing was spent.
 *
 * Secrets: provider keys live in the URL, so a URL is never in an error or a log line. Transport errors are rpc_http_<status>,
 * rpc_timeout, rpc_network or rpc_bad_json, and logs name an endpoint by its role only (primary, launchpad, backup, devnet).
 */
export const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
export const DEVNET_RPC = "https://api.devnet.solana.com";
/** How long an endpoint that failed is asked last (per server). */
export const BREAKER_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 8000;

const str = (v) => (v == null ? "" : String(v).trim());

/**
 * The endpoints of one request: [{ url, role }]. `cluster` is "mainnet" (the default) or "devnet"; `url` is the caller's own first
 * node (the launchpad's LAUNCHPAD_RPC_URL). A url with no cluster is asked alone, like before (nothing in src/ does that any more).
 */
export function rpcTargets(env = {}, { cluster = null, url = null } = {}) {
  const own = str(url);
  if (cluster === "devnet") return [{ url: own || DEVNET_RPC, role: "devnet" }];
  if (own && cluster !== "mainnet") return [{ url: own, role: "custom" }];
  const site = str(env && env.SOLANA_RPC_URL) || PUBLIC_MAINNET_RPC;
  const first = own || site;
  const out = [{ url: first, role: first === site ? "primary" : "launchpad" }];
  const backup = str(env && env.SOLANA_RPC_URL_BACKUP);
  if (backup && backup !== first) out.push({ url: backup, role: "backup" });
  return out;
}

/* ---------------------------------------------------------------- what counts as "the provider failed" */
const PROVIDER_STATUS = new Set([401, 402, 403, 404, 408, 410, 429]);
const providerStatus = (s) => PROVIDER_STATUS.has(s) || s >= 500;
// statuses that say the KEY or the account is refused (not this one request): asked last at once
const ACCOUNT_STATUS = new Set([401, 402, 403, 404, 410]);
// -32429 Helius "max usage reached" / rate limit; -32005 "Too many requests" and Solana's "node is unhealthy / behind";
// -32601 method not found (this provider does not serve it); -32010 "excluded from account secondary indexes" (gPA not indexed here)
const PROVIDER_CODES = new Set([-32429, -32005, -32601, -32010]);
// -32603 internal error: a read is asked again elsewhere; for a transaction the node's answer stays the answer
const READ_ONLY_CODES = new Set([-32603]);
// answers about the transaction or the ledger, the same on any node: never a reason to ask another provider
const NODE_VERDICT = new Set([-32002, -32003, -32004, -32007, -32009, -32014, -32015, -32016, -32602]);
const PROVIDER_TEXT = /max usage|usage limit|rate.?limit|too many requests|credits|quota|api.?key|unauthori[sz]ed|forbidden|upgrade your plan/i;
// the words of a refusal of the whole ACCOUNT (out of credits, the key refused), as opposed to "too fast right now"
const ACCOUNT_TEXT = /max usage|usage limit|credits|quota|api.?key|unauthori[sz]ed|forbidden|upgrade your plan|payment/i;

/** "rpc_<code>" when a JSON-RPC error object means the provider refuses, else null. */
export function providerRefusal(error, { send = false } = {}) {
  if (!error || typeof error !== "object") return null;
  const code = Number(error.code);
  const data = error.data && typeof error.data === "object" ? error.data : null;
  if (NODE_VERDICT.has(code) || (data && (data.err != null || Array.isArray(data.logs)))) return null;
  if (PROVIDER_CODES.has(code) || (!send && READ_ONLY_CODES.has(code))) return `rpc_${code}`;
  if (PROVIDER_TEXT.test(String(error.message || ""))) return `rpc_${Number.isFinite(code) && code ? code : "refused"}`;
  return null;
}
/** The first refusing error object of an answer (a call or a batch), or null. */
function refusingError(data, send) {
  const list = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  for (const r of list) if (r && providerRefusal(r.error, { send })) return r.error;
  return null;
}

/** An error that carries no URL: the message is the short code, `status` the HTTP status when there was one. */
function rpcError(message, status = null) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * The first bytes of a refused answer's body (a 429 says whether the account is out of credits or the request came too fast),
 * then the rest is released unread. Never more than `max` bytes, and nothing of it is logged or returned.
 */
async function peek(res, max = 2048) {
  try {
    if (!res.body || typeof res.body.getReader !== "function") return "";
    const reader = res.body.getReader(), dec = new TextDecoder();
    let text = "";
    while (text.length < max) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return text.slice(0, max);
  } catch { return ""; }
}
function release(res) {
  try { if (res.body && typeof res.body.cancel === "function") res.body.cancel().catch(() => {}); } catch { /* already read or closed */ }
}

/* ---------------------------------------------------------------- the breaker (per server) */
/**
 * Two kinds of failure (attempt() below says which):
 *   down  the provider as a whole: its key or account refused (401 402 403 404 410, "max usage reached", credits, quota), it
 *         cannot be reached or does not answer in time, a 5xx, an answer that is not JSON. Asked LAST at once, for BREAKER_MS.
 *         (Nobody can make a provider slow or unreachable from outside; a flood CAN make it answer 429, which is why a plain
 *         429 is "busy".)
 *   busy  this request or this moment: a plain rate limit (429 or -32429 / -32005 without words about the account), a method this
 *         provider does not serve (-32601, -32010), an internal error on a read (408 too), and every failure of a
 *         sendTransaction that does not say the account is out (Helius allows 1 or 5 sends a second: two buyers in the same
 *         second must never move every read of the server to the backup). This call goes to the next endpoint; the endpoint is
 *         asked last only after BUSY_TRIPS such failures within BUSY_WINDOW_MS with no good answer in between.
 * A probe (the first request after BREAKER_MS) that fails asks it last again. Without a backup there is no breaker at all.
 */
const BUSY_TRIPS = 3, BUSY_WINDOW_MS = 10_000;
const health = new Map(); // role -> { openUntil, probeUntil, busy, busyFrom, lastFailureAt, lastReason, failures, failovers }
const stateOf = (role) => {
  let h = health.get(role);
  if (!h) { h = { openUntil: 0, probeUntil: 0, busy: 0, busyFrom: 0, lastFailureAt: null, lastReason: null, failures: 0, failovers: 0 }; health.set(role, h); }
  return h;
};
// a probe in flight has a deadline, not a flag: a request cancelled mid-probe (the visitor left, so its `finally` never runs)
// must not leave its endpoint asked last for the life of the server
const askedLast = (t, now) => { const h = health.get(t.role); return Boolean(h && (now < h.openUntil || now < h.probeUntil)); };
function tripBusy(h, now) {
  if (now - h.busyFrom > BUSY_WINDOW_MS) { h.busyFrom = now; h.busy = 0; }
  h.busy += 1;
  return h.busy >= BUSY_TRIPS;
}
export const _resetRpcHealth = () => { health.clear(); genesisOf.clear(); };

/** What this server has seen, by role (never a URL): for /api/admin/config. */
export function rpcHealth(now = Date.now()) {
  const out = {};
  for (const [role, h] of health) {
    out[role] = { lastFailureAt: h.lastFailureAt ? new Date(h.lastFailureAt).toISOString() : null, lastReason: h.lastReason,
      askedLastUntil: h.openUntil > now ? new Date(h.openUntil).toISOString() : null,
      probingUntil: h.probeUntil > now ? new Date(h.probeUntil).toISOString() : null, failures: h.failures, failovers: h.failovers };
  }
  return out;
}

/* ---------------------------------------------------------------- the backup must be a mainnet node */
/**
 * SOLANA_RPC_URL_BACKUP serves MAINNET reads only, so before it is first asked (once per server) it is asked for its genesis
 * hash. A node of another cluster (a devnet URL pasted by mistake) would answer every mainnet read with plausible emptiness
 * ("this wallet holds 0", "no such blockhash"), so it is never used, and the log says so once (without its URL). When the check
 * itself gets no answer the backup is used anyway for that request (better a backup than none) and the check runs again later.
 */
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const GENESIS_RETRY_MS = 30_000;
const genesisOf = new Map(); // backup url -> { verdict: true | false | null, until, promise } (in memory only; never shown)
function backupUsable(t, fetchImpl, ms) {
  const now = Date.now();
  const c = genesisOf.get(t.url);
  if (c && c.verdict != null) return c.verdict;
  if (c && now < c.until) return c.promise;
  const next = { verdict: null, until: now + GENESIS_RETRY_MS, promise: null };
  next.promise = (async () => {
    let res;
    try {
      res = await fetchImpl(t.url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }), signal: AbortSignal.timeout(Math.min(ms, 5000)) });
    } catch { return true; }
    if (!res.ok) { release(res); return true; }
    let d = null;
    try { d = await res.json(); } catch { return true; }
    if (!d || typeof d.result !== "string") return true;
    next.verdict = d.result === MAINNET_GENESIS;
    if (!next.verdict) {
      const s = stateOf(t.role);
      s.lastFailureAt = Date.now(); s.lastReason = "not_mainnet";
      console.error("rpc backup is not a mainnet node: it is never used (set SOLANA_RPC_URL_BACKUP to a mainnet URL)");
    }
    return next.verdict;
  })();
  genesisOf.set(t.url, next);
  return next.promise;
}

/* ---------------------------------------------------------------- one attempt */
// a failure after which a transaction MAY have gone out: the node got the bytes, or might have, and then no answer came back
const AMBIGUOUS = (reason) => reason === "timeout" || reason === "network" || reason === "bad_json" || reason === "http_408" || /^http_5\d\d$/.test(reason);

async function attempt(t, body, fetchImpl, timeoutMs, send) {
  let res;
  try {
    res = await fetchImpl(t.url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // the original error is dropped on purpose: a runtime's "cannot load <url>" would carry the key
    const reason = e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network";
    return { ok: false, reason, kind: send ? "busy" : "down", ambiguous: true, error: rpcError(`rpc_${reason}`) };
  }
  if (!res.ok) {
    const status = res.status, reason = `http_${status}`;
    const words = status === 429 ? await peek(res) : (release(res), "");
    const err = rpcError(`rpc_${reason}`, status);
    if (!providerStatus(status)) throw err; // any other status is about the request itself: the same anywhere
    const account = ACCOUNT_STATUS.has(status) || ACCOUNT_TEXT.test(words);
    const kind = account ? "down" : status === 429 || status === 408 || send ? "busy" : "down";
    return { ok: false, reason, kind, ambiguous: AMBIGUOUS(reason), error: err };
  }
  let data;
  try { data = await res.json(); } catch { return { ok: false, reason: "bad_json", kind: send ? "busy" : "down", ambiguous: true, error: rpcError("rpc_bad_json") }; }
  const refused = refusingError(data, send);
  if (!refused) return { ok: true, data };
  const why = providerRefusal(refused, { send });
  return { ok: false, reason: why, kind: ACCOUNT_TEXT.test(String(refused.message || "")) ? "down" : "busy", ambiguous: false, data };
}

/**
 * POST one JSON-RPC payload (a call or a batch) to the endpoints of `cluster`, failing over as described above.
 * Returns { data, role, failedOver, ambiguous } where data is the parsed answer (a provider's refusal too, when every endpoint
 * refused: the caller reads its error as before), failedOver says another endpoint than the first one asked answered, and
 * ambiguous says an earlier attempt failed in a way after which a transaction may still have gone out (a timeout, a network
 * error, a 408 or 5xx, an answer that was not JSON). Throws rpc_http_<status> / rpc_timeout / rpc_network / rpc_bad_json when no
 * endpoint gave a JSON answer (with `ambiguous` on the error the same way), and at once on an HTTP status that is about the
 * request (400 ...). `only` restricts the call to one role (the swap status asks the block height of the node that answered the
 * signature status).
 */
export async function rpcPost(env, payload, fetchImpl = fetch, { cluster = null, url = null, timeoutMs = null, send = false, only = null } = {}) {
  let targets = rpcTargets(env, { cluster, url });
  if (only) { const one = targets.filter((t) => t.role === only); if (one.length) targets = one; }
  const now = Date.now();
  const tries = targets.length < 2 ? targets : [...targets.filter((t) => !askedLast(t, now)), ...targets.filter((t) => askedLast(t, now))];
  const body = JSON.stringify(payload);
  const ms = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  let last = null, asked = 0, ambiguous = false;
  for (const t of tries) {
    if (t.role === "backup" && !(await backupUsable(t, fetchImpl, ms))) continue;
    if (last) { stateOf(last.role).failovers++; console.warn("rpc failover", last.role, "->", t.role, "reason=" + last.reason); }
    const h = health.get(t.role), at = Date.now();
    const probe = Boolean(h && h.openUntil && at >= h.openUntil && at >= h.probeUntil);
    if (probe) h.probeUntil = at + ms + 1000;
    let out;
    asked++;
    try { out = await attempt(t, body, fetchImpl, ms, send); }
    finally { if (probe) h.probeUntil = 0; }
    if (out.ok) {
      if (h) { h.openUntil = 0; h.busy = 0; }
      return { data: out.data, role: t.role, failedOver: asked > 1, ambiguous };
    }
    if (out.ambiguous) ambiguous = true;
    const s = stateOf(t.role), when = Date.now();
    s.lastFailureAt = when; s.lastReason = out.reason; s.failures++;
    if (tries.length > 1 && (probe || out.kind === "down" || tripBusy(s, when))) s.openUntil = when + BREAKER_MS;
    last = { ...out, role: t.role };
  }
  if (!last) throw rpcError("rpc_unavailable");
  if (last.data !== undefined) return { data: last.data, role: last.role, failedOver: asked > 1, ambiguous };
  if (ambiguous) last.error.ambiguous = true;
  throw last.error;
}
