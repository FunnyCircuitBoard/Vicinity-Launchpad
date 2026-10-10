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
 * Breaker (per server): an endpoint that failed that way is asked LAST for 60 s, so requests go to the backup first instead of
 * waiting on a dead provider; after that one request probes it again, and a good answer closes the breaker.
 *
 * sendTransaction: the same signed bytes may go to the backup once (the same signature: the chain lands a transaction at most
 * once). A node's verdict on the transaction (-32002 preflight failure, -32003 signature) is an answer and is never retried, and
 * nothing is ever re-signed or rebuilt here.
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
// -32429 Helius "max usage reached" / rate limit; -32005 "Too many requests" and Solana's "node is unhealthy / behind";
// -32601 method not found (this provider does not serve it); -32010 "excluded from account secondary indexes" (gPA not indexed here)
const PROVIDER_CODES = new Set([-32429, -32005, -32601, -32010]);
// -32603 internal error: a read is asked again elsewhere; for a transaction the node's answer stays the answer
const READ_ONLY_CODES = new Set([-32603]);
// answers about the transaction or the ledger, the same on any node: never a reason to ask another provider
const NODE_VERDICT = new Set([-32002, -32003, -32004, -32007, -32009, -32014, -32015, -32016, -32602]);
const PROVIDER_TEXT = /max usage|usage limit|rate.?limit|too many requests|credits|quota|api.?key|unauthori[sz]ed|forbidden|upgrade your plan/i;

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
function refusalOf(data, send) {
  if (Array.isArray(data)) {
    for (const r of data) { const why = r && providerRefusal(r.error, { send }); if (why) return why; }
    return null;
  }
  return data && typeof data === "object" ? providerRefusal(data.error, { send }) : null;
}

/** An error that carries no URL: the message is the short code, `status` the HTTP status when there was one. */
function rpcError(message, status = null) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ---------------------------------------------------------------- the breaker (per server) */
const health = new Map(); // role -> { openUntil, probing, lastFailureAt, lastReason, failures, failovers }
const stateOf = (role) => {
  let h = health.get(role);
  if (!h) { h = { openUntil: 0, probing: false, lastFailureAt: null, lastReason: null, failures: 0, failovers: 0 }; health.set(role, h); }
  return h;
};
const askedLast = (t, now) => { const h = health.get(t.role); return Boolean(h && (now < h.openUntil || h.probing)); };
export const _resetRpcHealth = () => health.clear();

/** What this server has seen, by role (never a URL): for /api/admin/config. */
export function rpcHealth(now = Date.now()) {
  const out = {};
  for (const [role, h] of health) {
    out[role] = { lastFailureAt: h.lastFailureAt ? new Date(h.lastFailureAt).toISOString() : null, lastReason: h.lastReason,
      askedLastUntil: h.openUntil > now ? new Date(h.openUntil).toISOString() : null, failures: h.failures, failovers: h.failovers };
  }
  return out;
}

async function attempt(t, body, fetchImpl, timeoutMs, send) {
  let res;
  try {
    res = await fetchImpl(t.url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // the original error is dropped on purpose: a runtime's "cannot load <url>" would carry the key
    const reason = e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network";
    return { ok: false, reason, error: rpcError(`rpc_${reason}`) };
  }
  if (!res.ok) {
    const err = rpcError(`rpc_http_${res.status}`, res.status);
    if (providerStatus(res.status)) return { ok: false, reason: `http_${res.status}`, error: err };
    throw err; // any other status is about the request itself: the same anywhere
  }
  let data;
  try { data = await res.json(); } catch { return { ok: false, reason: "bad_json", error: rpcError("rpc_bad_json") }; }
  const why = refusalOf(data, send);
  return why ? { ok: false, reason: why, data } : { ok: true, data };
}

/**
 * POST one JSON-RPC payload (a call or a batch) to the endpoints of `cluster`, failing over as described above.
 * Returns { data, role, failedOver } where data is the parsed answer (a provider's refusal too, when every endpoint refused:
 * the caller reads its error as before). Throws rpc_http_<status> / rpc_timeout / rpc_network / rpc_bad_json when no endpoint
 * gave a JSON answer, and at once on an HTTP status that is about the request (400 ...). `only` restricts the call to one role
 * (the swap status asks the block height of the node that answered the signature status).
 */
export async function rpcPost(env, payload, fetchImpl = fetch, { cluster = null, url = null, timeoutMs = null, send = false, only = null } = {}) {
  let targets = rpcTargets(env, { cluster, url });
  if (only) { const one = targets.filter((t) => t.role === only); if (one.length) targets = one; }
  const now = Date.now();
  const tries = targets.length < 2 ? targets : [...targets.filter((t) => !askedLast(t, now)), ...targets.filter((t) => askedLast(t, now))];
  const body = JSON.stringify(payload);
  const ms = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  let last = null;
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i], h = health.get(t.role);
    const probe = Boolean(h && h.openUntil && now >= h.openUntil && !h.probing);
    if (probe) h.probing = true;
    let out;
    try { out = await attempt(t, body, fetchImpl, ms, send); }
    finally { if (probe) h.probing = false; }
    if (out.ok) {
      if (h) h.openUntil = 0;
      return { data: out.data, role: t.role, failedOver: i > 0 };
    }
    const s = stateOf(t.role);
    s.lastFailureAt = Date.now(); s.lastReason = out.reason; s.failures++;
    if (tries.length > 1) s.openUntil = Date.now() + BREAKER_MS;
    last = { ...out, role: t.role };
    const next = tries[i + 1];
    if (next) { s.failovers++; console.warn("rpc failover", t.role, "->", next.role, "reason=" + out.reason); }
  }
  if (last.data !== undefined) return { data: last.data, role: last.role, failedOver: tries.length > 1 };
  throw last.error;
}
