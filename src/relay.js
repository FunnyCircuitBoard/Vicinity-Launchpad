/**
 * The RPC relay behind the swap panel (only while SWAP=on or LAUNCHPAD_TRADING=on): the few JSON-RPC methods a trade needs,
 * each with a timeout, a plain error code and a rate limit, so the page (whose security policy allows only this site) never
 * talks to a blockchain node itself and the Worker never holds a key.
 *   POST /api/swap/send      { tx (base64, SIGNED by the wallet), ticket, lastValidBlockHeight, cluster? }  -> { ok, signature }
 *                            the fallback for wallets that sign but do not send; the header is checked (exactly one signer, the fee
 *                            payer's slot filled, version 0 or legacy, <= 1232 bytes), the TICKET proves this Worker built the
 *                            very message being sent (an HMAC over the message bytes, issued by /api/swap/tx and
 *                            /api/launchpad/trade/tx, 10 minutes; the relay is not an open sendTransaction proxy), and the
 *                            node's preflight error is mapped
 *   GET  /api/swap/status?sig=&lvbh=&cluster=  -> { ok, status: pending|confirmed|finalized|failed|expired, err, slot, solscan }
 *                            counted per SIGNATURE (60 a minute), so phones behind one carrier address never use up each other's polls
 *   GET  /api/swap/balances?owner=&mints=&fresh=1 -> { ok, sol: { lamports, ui }, tokens: { mint: { ui, hasAccount } } }
 *                            10 s memo per wallet; a send through the relay forgets the payer's memo; fresh=1 reads the chain now
 * cluster=devnet is honoured only while LAUNCHPAD_TRADING is on (devnet test coins); otherwise everything is mainnet.
 * Also here, shared with the builders: simulate() and simulationError(), which turn a node's answer into insufficient_sol,
 * slippage, insufficient_balance, program_error { program, name } BEFORE the wallet opens.
 */
import { json } from "./http.js";
import { getMintBalances, rpc } from "./chain.js";
import { isSolanaAddress } from "./solana.js";
import { codeOf } from "./sources.js";
import { fromBase64, hex, toBase64 } from "./sol/bytes.js";
import { MAX_TX_BYTES, decodeHeader, programOfInstruction } from "./sol/message.js";
import { PROGRAM_IDS } from "./sol/pda.js";
import { dbcErrorName, launchpadErrorName } from "./sol/dbc.js";
import { checkTaker } from "./sol/input.js";
import { launchpadCluster, launchpadTradingOn, solscanTx, swapCluster } from "./cluster.js";
import { STATUS_LIMIT, keyLimit, publicLimit } from "./guards.js";
import { limitKey } from "./limits.js";
import { readJson } from "./http.js";

const TIMEOUT_MS = 8000;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
/** The RPC url of a cluster name: the launchpad's for devnet (its own setting), SOLANA_RPC_URL (the site's) for mainnet. */
export const rpcUrlFor = (env, cluster) => (cluster === "devnet" ? launchpadCluster({ ...env, LAUNCHPAD_CLUSTER: "devnet" }).rpc : null);
/** "devnet" only while the launchpad's curve trades are ON and run on devnet (test coins); a site without them never reaches a devnet node. */
const clusterOf = (env, v) => (v === "devnet" && launchpadTradingOn(env) && launchpadCluster(env).cluster === "devnet" ? "devnet" : "mainnet");

/* ---------------------------------------------------------------- the relay ticket: "this Worker built these very bytes" */
const TICKET_MS = 10 * 60_000;
const TICKET = /^(\d{10,16})\.([A-Za-z0-9_-]{22})$/;
const messageHex = (txBytes) => hex(txBytes.subarray(decodeHeader(txBytes).messageOffset));
/**
 * A ticket for an unsigned transaction this Worker just built: `<expiresAt>.<22 chars>`, the 22 chars being an HMAC (the
 * limits salt, src/limits.js) over the MESSAGE bytes and the expiry. A wallet's signature changes only the signature section,
 * so the signed bytes carry the same message and the same ticket verifies. Null without a database (nothing to key with).
 */
export async function issueTicket(env, txBytes, now = Date.now()) {
  if (!env || !env.DB) return null;
  const exp = now + TICKET_MS;
  return `${exp}.${(await limitKey(env, "relay", messageHex(txBytes), String(exp))).slice("relay:".length)}`;
}
/** True when `ticket` was issued by this Worker for the message inside `txBytes` and has not expired. Without a database there is nothing to verify with (like the limits): true. */
export async function checkTicket(env, txBytes, ticket, now = Date.now()) {
  if (!env || !env.DB) return true;
  const m = TICKET.exec(String(ticket || ""));
  if (!m || !(Number(m[1]) > now)) return false;
  const want = (await limitKey(env, "relay", messageHex(txBytes), m[1])).slice("relay:".length);
  let diff = want.length ^ m[2].length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (m[2].charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * One JSON-RPC call that keeps the node's error envelope (sendTransaction's preflight failure carries `data.err` and `data.logs`,
 * which rpc() in src/chain.js would flatten to a code). { result } or { error: { code, message, data } }. Throws on transport.
 */
export async function rpcRaw(env, method, params, fetchImpl = fetch, { url = null, timeoutMs = TIMEOUT_MS } = {}) {
  const target = url || (env && env.SOLANA_RPC_URL) || "https://api.mainnet-beta.solana.com";
  const res = await fetchImpl(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 429) { const e = new Error("rpc_http_429"); e.code = "rpc_busy"; throw e; }
  if (!res.ok) throw new Error(`rpc_http_${res.status}`);
  const d = await res.json();
  return d && typeof d === "object" ? d : { error: { code: -32700, message: "bad answer" } };
}

/* ---------------------------------------------------------------- simulation and plain-word errors */
const CUSTOM = /custom program error: 0x([0-9a-f]+)/i;
/**
 * A node's error (sendTransaction preflight or simulateTransaction) as a plain code: { error, program?, name?, code? }.
 *   insufficient_sol      the wallet cannot pay the lamports (fee, rent, the SOL being wrapped)
 *   insufficient_balance  a token account holds less than the trade spends (SPL Token error 1)
 *   slippage              Jupiter 6001 SlippageToleranceExceeded, Meteora DBC 6002 ExceededSlippage
 *   program_error         any other custom error, with the program and the error's name when the IDL knows it
 *   blockhash_expired     the blockhash is no longer valid
 * `decoded` (decodeHeader of the transaction) names the program of the failing instruction.
 */
/**
 * A simulation / landing error in a plain code. `decoded` (the transaction) names the failing instruction's program; without it,
 * `swapProgram` (the route's top-level swap program: Jupiter or Meteora DBC, from the status poll's `via`) stands in for the
 * swap instruction's own codes, the way the simulation path reads them.
 */
export function simulationError(err, logs = [], decoded = null, { launchpadProgramId = null, swapProgram = null } = {}) {
  if (err == null) return null;
  const text = `${typeof err === "string" ? err : JSON.stringify(err)}\n${(logs || []).join("\n")}`;
  if (/InsufficientFundsForFee|InsufficientFundsForRent|insufficient lamports|insufficient funds for rent|found no record of a prior credit|Attempt to debit an account but/i.test(text)) return { error: "insufficient_sol" };
  if (/BlockhashNotFound|Blockhash not found/i.test(text)) return { error: "blockhash_expired" };
  if (/AccountNotFound/.test(text) && !/InstructionError/.test(text)) return { error: "insufficient_sol" };
  const ie = err && typeof err === "object" && Array.isArray(err.InstructionError) ? err.InstructionError : null;
  if (ie) {
    const [index, detail] = ie;
    const program = decoded ? programOfInstruction(decoded, index) : swapProgram && [PROGRAM_IDS.jupiter, PROGRAM_IDS.dbc].includes(swapProgram) ? swapProgram : null;
    const custom = detail && typeof detail === "object" && Number.isInteger(detail.Custom) ? detail.Custom : null;
    if (custom != null) {
      if (program === PROGRAM_IDS.token && custom === 1) return { error: "insufficient_balance", program, code: custom };
      if (program === PROGRAM_IDS.jupiter && custom === 6001) return { error: "slippage", program, code: custom, name: "SlippageToleranceExceeded" };
      if (program === PROGRAM_IDS.dbc && custom === 6002) return { error: "slippage", program, code: custom, name: "ExceededSlippage" };
      if (program === PROGRAM_IDS.system && custom === 1) return { error: "insufficient_sol", program, code: custom };
      const name = program === PROGRAM_IDS.dbc ? dbcErrorName(custom) : program === PROGRAM_IDS.token ? ({ 1: "InsufficientFunds", 3: "InvalidMint" })[custom] || null : launchpadProgramId && program === launchpadProgramId ? launchpadErrorName(custom) : null;
      // the Token program's own 'insufficient funds' and the System program's, however the logs name the program
      if (custom === 1 && /insufficient funds|insufficient lamports/i.test(text)) return { error: program === PROGRAM_IDS.system || /Transfer: insufficient lamports/.test(text) ? "insufficient_sol" : "insufficient_balance", program, code: custom };
      return { error: "program_error", program, code: custom, name: name || (CUSTOM.exec(text) ? `0x${CUSTOM.exec(text)[1]}` : String(custom)) };
    }
    if (typeof detail === "string") return { error: /InsufficientFunds/.test(detail) ? "insufficient_sol" : "program_error", program, name: detail };
    return { error: "program_error", program, name: "InstructionError" };
  }
  return { error: "rejected_by_network", name: typeof err === "string" ? err.slice(0, 40) : Object.keys(err || {})[0] || "unknown" };
}
/** simulateTransaction of an (unsigned or signed) transaction: { ok, unitsConsumed, err, logs } or throws (transport). */
export async function simulate(env, txBytes, fetchImpl = fetch, { url = null } = {}) {
  const d = await rpcRaw(env, "simulateTransaction", [toBase64(txBytes), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }], fetchImpl, { url });
  if (d.error) throw new Error(`rpc_${d.error.code || "error"}`);
  const v = d.result && d.result.value ? d.result.value : {};
  return { ok: v.err == null, err: v.err ?? null, logs: Array.isArray(v.logs) ? v.logs.slice(-40) : [], unitsConsumed: Number.isFinite(Number(v.unitsConsumed)) ? Number(v.unitsConsumed) : null };
}

/* ---------------------------------------------------------------- the routes */
/** POST /api/swap/send: relay a wallet-signed transaction. The route has checked the switch, the method and the Origin. */
export async function handleSend(request, env, fetchImpl = fetch, now = Date.now()) {
  const slow = await publicLimit(env, request, "swap_send");
  if (slow) return slow;
  const body = await readJson(request, 8192);
  if (!body || typeof body.tx !== "string") return json({ ok: false, error: "bad_json" }, 400);
  let bytes, decoded;
  try { bytes = fromBase64(body.tx); } catch { return json({ ok: false, error: "bad_tx" }, 400); }
  if (bytes.length > MAX_TX_BYTES) return json({ ok: false, error: "tx_too_large" }, 400);
  try { decoded = decodeHeader(bytes); } catch (e) { return json({ ok: false, error: "bad_tx", reason: codeOf(e) }, 400); }
  // the Worker only ever builds one-signer transactions (the person's wallet pays and signs): the relay's contract says so too
  if (decoded.numSignatures !== 1 || decoded.header.numRequiredSignatures !== 1) return json({ ok: false, error: "bad_tx", reason: "one_signer_only" }, 400);
  if (!decoded.signaturesFilled[0]) return json({ ok: false, error: "unsigned" }, 400);
  // only what THIS Worker built goes to the owner's RPC: a signed transaction from anywhere else is refused before any node is asked
  if (!(await checkTicket(env, bytes, body.ticket, now))) return json({ ok: false, error: "bad_ticket", message: "Only a transaction built on this site can be relayed. Press Swap again." }, 400);
  const cluster = clusterOf(env, body.cluster);
  let d;
  try {
    d = await rpcRaw(env, "sendTransaction", [body.tx, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }], fetchImpl, { url: rpcUrlFor(env, cluster) });
  } catch (e) { console.error("relay send failed", codeOf(e)); return json({ ok: false, error: e.code === "rpc_busy" ? "rpc_busy" : "rpc_unavailable" }, 503); }
  if (d.error) {
    const data = d.error.data || {};
    const mapped = simulationError(data.err ?? d.error.message, data.logs || [], decoded) || { error: "rejected_by_network" };
    console.error("relay send refused", mapped.error, mapped.name || "", mapped.program ? mapped.program.slice(0, 6) : "");
    return json({ ok: false, ...mapped, program: mapped.program || undefined }, 409);
  }
  const signature = typeof d.result === "string" && SIG.test(d.result) ? d.result : null;
  if (!signature) return json({ ok: false, error: "rpc_unavailable" }, 503);
  forgetBalances(decoded.staticKeys[0]); // the payer's balances are about to change: the next read is the chain's, not the 10 s memo
  return json({ ok: true, signature, solscan: solscanTx(signature, cluster), cluster });
}

/** GET /api/swap/status?sig=&lvbh=&cluster=&via=jupiter|curve (via: which swap program the transaction went through, for plain words on a landed failure) */
const VIA = { jupiter: PROGRAM_IDS.jupiter, curve: PROGRAM_IDS.dbc };
export async function handleStatus(request, env, fetchImpl = fetch) {
  const q = new URL(request.url).searchParams;
  const sig = q.get("sig") || "";
  if (!SIG.test(sig)) return json({ ok: false, error: "bad_signature" }, 400); // free: nothing is asked of a node, so nothing is counted
  // counted per signature first (one trade's polls never use up another person's), then the connection's own flood brake
  const slow = (await keyLimit(env, "swap_status_sig", sig, STATUS_LIMIT)) || (await publicLimit(env, request, "swap_status"));
  if (slow) return slow;
  const lvbh = /^\d{1,12}$/.test(q.get("lvbh") || "") ? Number(q.get("lvbh")) : null;
  const cluster = clusterOf(env, q.get("cluster"));
  const url = rpcUrlFor(env, cluster);
  try {
    const st = await rpc(env, "getSignatureStatuses", [[sig], { searchTransactionHistory: true }], fetchImpl, { url });
    const v = st && Array.isArray(st.value) ? st.value[0] : null;
    const out = { ok: true, signature: sig, solscan: solscanTx(sig, cluster), cluster, slot: v ? v.slot ?? null : null };
    if (v) {
      if (v.err) { const m = simulationError(v.err, [], null, { swapProgram: VIA[q.get("via")] || null }); return json({ ...out, status: "failed", err: m ? m.error : "failed", name: m && m.name }); }
      const c = v.confirmationStatus;
      return json({ ...out, status: c === "finalized" ? "finalized" : c === "confirmed" || Number(v.confirmations) > 0 ? "confirmed" : "pending" });
    }
    if (lvbh != null) {
      const height = await rpc(env, "getBlockHeight", [{ commitment: "confirmed" }], fetchImpl, { url });
      if (Number.isFinite(height) && height > lvbh) return json({ ...out, status: "expired" });
    }
    return json({ ...out, status: "pending" });
  } catch (e) {
    console.error("status failed", codeOf(e));
    return json({ ok: false, error: "rpc_unavailable" }, 503);
  }
}

const balances = new Map(); // owner|cluster|mints -> { at, promise }: 10 s per server, so a page polling after a swap costs one call per owner
const BAL_MS = 10_000;
export const _resetRelay = () => balances.clear();
/** Forget every memo of one owner (after a trade of theirs went out: the next read is the chain's). */
export function forgetBalances(owner) { for (const k of [...balances.keys()]) if (k.startsWith(owner + "|")) balances.delete(k); }
/** GET /api/swap/balances?owner=&mints=&cluster=&fresh=1 : SOL and up to 6 mints of one wallet; fresh=1 skips the memo (counted like a miss). */
export async function handleBalances(request, env, fetchImpl = fetch) {
  const q = new URL(request.url).searchParams;
  const owner = checkTaker(q.get("owner") || "");
  if (!owner) return json({ ok: false, error: "bad_wallet" }, 400);
  const mints = [...new Set(String(q.get("mints") || "").split(",").filter(isSolanaAddress))].slice(0, 6);
  const cluster = clusterOf(env, q.get("cluster"));
  const key = `${owner}|${cluster}|${mints.slice().sort().join(",")}`;
  let hit = balances.get(key);
  if (!hit || q.get("fresh") === "1" || Date.now() - hit.at > BAL_MS) {
    const slow = await publicLimit(env, request, "swap_balances");
    if (slow) return slow;
    hit = { at: Date.now(), promise: readBalances(env, owner, mints, cluster, fetchImpl) };
    hit.promise.catch(() => { if (balances.get(key) === hit) balances.delete(key); });
    balances.set(key, hit);
    if (balances.size > 2000) balances.delete(balances.keys().next().value);
  }
  try { return json({ ok: true, owner, cluster, ...(await hit.promise) }, 200, { "Cache-Control": "no-store" }); }
  catch (e) { console.error("balances failed", codeOf(e)); return json({ ok: false, error: "rpc_unavailable" }, 503); }
}
async function readBalances(env, owner, mints, cluster, fetchImpl) {
  const url = rpcUrlFor(env, cluster);
  const envAt = url ? { ...env, SOLANA_RPC_URL: url } : env;
  const [sol, tok] = await Promise.all([
    rpc(env, "getBalance", [owner, { commitment: "confirmed" }], fetchImpl, { url }),
    mints.length ? getMintBalances(envAt, owner, mints, fetchImpl) : new Map(),
  ]);
  const lamports = Number(sol && sol.value != null ? sol.value : sol) || 0;
  const tokens = {};
  for (const m of mints) {
    const ui = tok.get(m) || 0;
    // hasAccount: true when the wallet holds a token account for the mint (even an empty one), false when it has none, so the
    // page can say whether about 0.002 SOL of rent will be asked for; null when the read could not say
    tokens[m] = { ui, hasAccount: tok.accounts ? tok.accounts.has(m) : ui > 0 ? true : null };
  }
  return { sol: { lamports, ui: lamports / 1e9 }, tokens };
}
