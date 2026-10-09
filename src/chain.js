/**
 * Live, read-only Solana data for the website: token facts, top holders,
 * and "does this wallet hold $VICINITY?". Everything comes from the public
 * blockchain. Nothing is written, and no wallet address is ever stored.
 *
 * RPC: set the secret SOLANA_RPC_URL (e.g. a free Helius key) in Cloudflare.
 * Without it we fall back to the public endpoint, which can't list holders.
 */
import { OFFICIAL } from "./official.js";
import { base58Decode, base58Encode } from "./solana.js";
import { isOnCurve } from "./sol/oncurve.js";

const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const PROGRAM_LABELS = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun bonding curve",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "PumpSwap liquidity pool",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium liquidity pool",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "Raydium liquidity pool",
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj": "Raydium LaunchLab curve",
  "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE": "Raydium locked LP",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora liquidity pool",
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG": "Meteora liquidity pool",
};
const PROGRAM_ACCOUNT = "Pool or program account";

// isOnCurve lives in src/sol/oncurve.js (shared with the swap modules without an import cycle); kept exported from here for its callers
export { isOnCurve };
/** Every wallet the team publishes (src/official.js) is labelled with this in the holder list and, like a pool, never ranked. */
const TEAM_LABEL = "Team wallet (public)";
export const isTeamWallet = (owner) => (OFFICIAL.teamWallets || []).includes(owner);
/** A label for a big holder: a known pool program, or any program-controlled (off-curve) address. */
const poolLabel = (owner, ownerProgram) => {
  if (PROGRAM_LABELS[ownerProgram]) return PROGRAM_LABELS[ownerProgram];
  try { return isOnCurve(base58Decode(owner)) ? null : PROGRAM_ACCOUNT; } catch { return null; }
};

// A stuck RPC must not hold a request open: give up after 8 seconds (the Worker itself has 30). The setting
// RPC_TIMEOUT_MS (a number of milliseconds) changes it without a deploy, for the day a very long holder list
// needs more than that; anything that is not a positive number means the default.
const RPC_TIMEOUT_MS = 8000;
const rpcTimeout = (env) => { const n = Number(env && env.RPC_TIMEOUT_MS); return n > 0 ? n : RPC_TIMEOUT_MS; };

export async function rpc(env, method, params, fetchImpl = fetch, { timeoutMs = null, url: urlOverride = null } = {}) {
  // `url` overrides the RPC for one call: the launchpad's curve trades read their own cluster (src/cluster.js), everything else SOLANA_RPC_URL
  const url = urlOverride || (env && env.SOLANA_RPC_URL) || PUBLIC_RPC;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs > 0 ? timeoutMs : rpcTimeout(env)),
  });
  if (!res.ok) throw new Error(`rpc_http_${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`rpc_${data.error.code || "error"}`);
  return data.result;
}

const uiAmount = (raw, decimals) => Number(BigInt(raw)) / 10 ** decimals;

/** Mint facts that prove (or disprove) the token can't be rugged by minting/freezing. */
export async function getTokenFacts(env, mint, fetchImpl) {
  const info = await rpc(env, "getAccountInfo", [mint, { encoding: "jsonParsed" }], fetchImpl);
  const parsed = info?.value?.data?.parsed?.info;
  if (!parsed) throw new Error("not_a_mint");
  const decimals = parsed.decimals;
  return {
    mint,
    program: info.value.owner === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : "SPL Token",
    decimals,
    supply: uiAmount(parsed.supply, decimals),
    mintAuthority: parsed.mintAuthority || null,
    freezeAuthority: parsed.freezeAuthority || null,
    mintingDisabled: !parsed.mintAuthority,
    freezingDisabled: !parsed.freezeAuthority,
    // On a LaunchLab curve the launch program itself holds minting until the curve fills; that's a
    // program-controlled (off-curve) address, not a person's wallet.
    mintHeldByProgram: Boolean(parsed.mintAuthority) && !isOnCurve(base58Decode(parsed.mintAuthority)),
  };
}

/**
 * What the blockchain says an address is, before an admin records it as a city's coin: facts for a token mint
 * (SPL Token or Token-2022) that has a supply, or null for anything else (no account, a wallet, somebody's token
 * account, a mint nobody has minted). An RPC failure throws: "the chain could not be asked" is never "not a mint".
 */
export async function mintInfo(env, mint, fetchImpl = fetch) {
  const info = await rpc(env, "getAccountInfo", [mint, { encoding: "jsonParsed" }], fetchImpl);
  const v = info?.value, parsed = v?.data?.parsed, i = parsed?.info;
  if (!v || (v.owner !== TOKEN_PROGRAM && v.owner !== TOKEN_2022) || !i || (parsed.type && parsed.type !== "mint") || i.supply == null) return null;
  let raw;
  try { raw = BigInt(i.supply); } catch { return null; }
  const decimals = Number(i.decimals);
  if (raw <= 0n || !Number.isInteger(decimals)) return null;
  return { program: v.owner === TOKEN_2022 ? "Token-2022" : "SPL Token", supply: uiAmount(raw, decimals), decimals, mintAuthority: i.mintAuthority || null, freezeAuthority: i.freezeAuthority || null };
}

/** Top holders (up to 20), with owner wallets and labels for pools/curves/team. Labelled wallets are not ranked: ranks are for people. */
export async function getTopHolders(env, mint, fetchImpl) {
  const facts = await getTokenFacts(env, mint, fetchImpl);
  const largest = await rpc(env, "getTokenLargestAccounts", [mint], fetchImpl);
  const accounts = (largest?.value || []).filter((a) => a.amount !== "0");
  if (!accounts.length) return { facts, holders: [] };

  const tokenAccs = await rpc(env, "getMultipleAccounts", [accounts.map((a) => a.address), { encoding: "jsonParsed" }], fetchImpl);
  const owners = tokenAccs.value.map((acc) => acc?.data?.parsed?.info?.owner || null);
  const uniqueOwners = [...new Set(owners.filter(Boolean))];
  const ownerAccs = uniqueOwners.length
    ? await rpc(env, "getMultipleAccounts", [uniqueOwners, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }], fetchImpl)
    : { value: [] };
  const ownerProgram = Object.fromEntries(uniqueOwners.map((o, i) => [o, ownerAccs.value[i]?.owner || null]));

  const byOwner = new Map();
  accounts.forEach((a, i) => {
    const owner = owners[i] || a.address;
    const amt = uiAmount(a.amount, a.decimals ?? facts.decimals);
    byOwner.set(owner, (byOwner.get(owner) || 0) + amt);
  });

  let rank = 0;
  const holders = [...byOwner.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([owner, amount]) => {
      const label = isTeamWallet(owner) ? TEAM_LABEL : poolLabel(owner, ownerProgram[owner]);
      return { rank: label ? null : ++rank, owner, amount, percent: facts.supply ? (amount / facts.supply) * 100 : 0, label };
    });
  return { facts, holders };
}

/** How much $VICINITY does this wallet hold? (read-only, not stored) */
export async function getHolding(env, owner, mint, fetchImpl) {
  const res = await rpc(env, "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }], fetchImpl);
  let amount = 0;
  for (const acc of res?.value || []) amount += Number(acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
  return amount;
}

/**
 * $VICINITY balances of many wallets at once, using JSON-RPC batches (25 per request).
 * Returns Map(owner → amount). Read-only; nothing is stored.
 */
export async function getHoldings(env, owners, mint, fetchImpl = fetch) {
  const url = (env && env.SOLANA_RPC_URL) || PUBLIC_RPC;
  const out = new Map();
  for (let i = 0; i < owners.length; i += 25) {
    const chunk = owners.slice(i, i + 25);
    const body = chunk.map((o, j) => ({ jsonrpc: "2.0", id: j, method: "getTokenAccountsByOwner", params: [o, { mint }, { encoding: "jsonParsed" }] }));
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(rpcTimeout(env)) });
    if (!res.ok) throw new Error(`rpc_http_${res.status}`);
    const data = await res.json();
    for (const r of Array.isArray(data) ? data : []) {
      if (r.error) throw new Error(`rpc_${r.error.code || "error"}`);
      let amount = 0;
      for (const acc of r.result?.value || []) amount += Number(acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
      out.set(chunk[r.id], amount);
    }
  }
  return out;
}

/** What one token account holds, as a plain number: raw amount / 10^decimals, else the RPC's own uiAmountString / uiAmount. */
function accountAmount(ta) {
  if (!ta) return 0;
  let n = NaN;
  if (typeof ta.amount === "string" && /^\d{1,30}$/.test(ta.amount) && Number.isInteger(ta.decimals) && ta.decimals >= 0 && ta.decimals <= 30) n = uiAmount(ta.amount, ta.decimals);
  if (!Number.isFinite(n)) n = Number(ta.uiAmountString ?? ta.uiAmount);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * What ONE wallet holds of a short list of SPECIFIC mints, and nothing else. One getTokenAccountsByOwner per mint with
 * the {mint} filter (never a programId filter, which would list every token the wallet owns), JSON-RPC batched 25 per
 * HTTP request like getHoldings. A mint filter finds Token and Token-2022 accounts alike; a wallet can have several
 * accounts of one mint (they are summed); an account the RPC returns for a different mint is ignored.
 * Returns Map(mint → amount) with an entry for EVERY asked mint (0 when the wallet has none). Unlike getHoldings it
 * THROWS on anything odd (HTTP error, rate-limit answer that is not a list, an id missing from the answer, a per-call
 * error), because a half answer would be shown as "you hold nothing". Read-only; nothing is stored.
 */
export async function getMintBalances(env, owner, mints, fetchImpl = fetch, { timeoutMs = 8000 } = {}) {
  const url = (env && env.SOLANA_RPC_URL) || PUBLIC_RPC;
  const list = [...new Set(mints)];
  const out = new Map();
  out.accounts = new Set();
  const chunks = [];
  for (let i = 0; i < list.length; i += 25) chunks.push(list.slice(i, i + 25));
  await Promise.all(chunks.map(async (chunk) => {
    const body = chunk.map((mint, j) => ({ jsonrpc: "2.0", id: j, method: "getTokenAccountsByOwner", params: [owner, { mint }, { encoding: "jsonParsed" }] }));
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`rpc_http_${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(data && data.error ? `rpc_${data.error.code || "error"}` : "rpc_bad_answer");
    const byId = new Map(data.map((r) => [r && r.id, r]));
    chunk.forEach((mint, j) => {
      const r = byId.get(j);
      if (!r) throw new Error("rpc_missing_answer");
      if (r.error) throw new Error(`rpc_${r.error.code || "error"}`);
      let amount = 0, accounts = 0;
      for (const acc of Array.isArray(r.result?.value) ? r.result.value : []) {
        const info = acc?.account?.data?.parsed?.info;
        if (info && info.mint && info.mint !== mint) continue;
        amount += accountAmount(info?.tokenAmount);
        accounts++;
      }
      out.set(mint, amount);
      if (accounts) out.accounts.add(mint); // the mints the wallet has a token account for, even an empty one (the swap panel's rent note)
    });
  }));
  return out;
}

const b64bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * EVERY holder of the token, biggest first: [[owner, amount], ...]. Uses getProgramAccounts and only
 * downloads the owner + amount of each token account (40 bytes each), so it stays fast with
 * thousands of holders. Needs an RPC that allows it (Helius does; the public endpoint may refuse).
 */
export async function getAllHolders(env, mint, fetchImpl = fetch) {
  const facts = await getTokenFacts(env, mint, fetchImpl);
  const program = facts.program === "Token-2022" ? TOKEN_2022 : TOKEN_PROGRAM;
  const filters = [{ memcmp: { offset: 0, bytes: mint } }];
  if (program === TOKEN_PROGRAM) filters.unshift({ dataSize: 165 });
  const res = await rpc(env, "getProgramAccounts", [program, { encoding: "base64", dataSlice: { offset: 32, length: 40 }, filters, withContext: true }], fetchImpl);
  const accs = Array.isArray(res) ? res : res?.value || [];
  const slot = Array.isArray(res) ? null : res?.context?.slot ?? null;
  const byOwner = new Map();
  for (const a of accs) {
    const data = a?.account?.data;
    const bytes = b64bytes(Array.isArray(data) ? data[0] : "");
    if (bytes.length < 40) continue;
    let raw = 0n;
    for (let i = 7; i >= 0; i--) raw = (raw << 8n) | BigInt(bytes[32 + i]);
    if (raw === 0n) continue;
    const owner = base58Encode(bytes.subarray(0, 32));
    byOwner.set(owner, (byOwner.get(owner) || 0n) + raw);
  }
  const list = [...byOwner].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0)).map(([o, raw]) => [o, uiAmount(raw, facts.decimals)]);

  // label pools / bonding curves (program-owned wallets) among the biggest holders, and team wallets
  const top = list.slice(0, 50).map(([o]) => o);
  const labels = new Map();
  if (top.length) {
    const acc = await rpc(env, "getMultipleAccounts", [top, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }], fetchImpl);
    top.forEach((o, i) => { const l = poolLabel(o, acc?.value?.[i]?.owner); if (l) labels.set(o, l); });
  }
  for (const w of OFFICIAL.teamWallets || []) labels.set(w, TEAM_LABEL);
  return { facts, list, labels, slot };
}

/**
 * Every holder, read at most once a minute per data centre: the servers of one Cloudflare location share the last read through a
 * private cache (caches.open, never seen by visitors). Before, each server read it for itself every minute it was busy, from
 * /api/me, profiles, founder checks and votes too, with no cap (3 RPC calls each, one of them getProgramAccounts). A copy is used
 * only while it is younger than maxAgeMs, so the list is as fresh as before; a cache hiccup just means a direct read.
 */
const SHARED_CACHE = "vicinity-holders", SHARED_URL = "https://cache.vicinity.internal/holders-snapshot/";
async function sharedHolders(env, mint, fetchImpl, maxAgeMs) {
  let cache = null;
  try { cache = typeof caches !== "undefined" && typeof caches.open === "function" ? await caches.open(SHARED_CACHE) : null; } catch { cache = null; }
  const key = SHARED_URL + mint;
  if (cache) {
    try {
      const hit = await cache.match(key);
      const d = hit ? await hit.json() : null;
      if (d && Array.isArray(d.list) && Date.now() - d.builtAt < maxAgeMs) return { facts: d.facts, list: d.list, labels: new Map(d.labels), builtAt: d.builtAt };
    } catch { /* unreadable copy: read the chain */ }
  }
  const fresh = await getAllHolders(env, mint, fetchImpl);
  const builtAt = Date.now();
  if (cache) {
    try {
      await cache.put(key, new Response(JSON.stringify({ facts: fresh.facts, list: fresh.list, labels: [...fresh.labels], builtAt }),
        { headers: { "content-type": "application/json", "Cache-Control": `max-age=${Math.max(1, Math.ceil(maxAgeMs / 1000))}` } }));
    } catch { /* not shared this time */ }
  }
  return { ...fresh, builtAt };
}

/**
 * The holder list, ranked. Pools, bonding curves and team wallets are shown and labelled but not ranked: ranks are for people,
 * and `people` (the "of N holders" of every rank) counts only them.
 * Kept for 60 seconds (per server, and per data centre through sharedHolders), so a busy dashboard doesn't hammer the blockchain.
 *   { facts, rows: [{ owner, amount, percent, rank|null, label }], byOwner: Map(owner → row), people, at }
 */
const snaps = new Map();
// A failed snapshot is kept this long: every caller in that time gets the same error at once, instead of each
// firing its own getProgramAccounts at an RPC that is already in trouble.
const FAILED_FOR_MS = 5_000;
export function holderSnapshot(env, mint, fetchImpl = fetch, maxAgeMs = 60_000) {
  const hit = snaps.get(mint);
  if (hit && Date.now() < (hit.failedAt == null ? hit.at + maxAgeMs : hit.failedAt + FAILED_FOR_MS)) return hit.promise;
  const entry = { at: Date.now(), promise: null, failedAt: null };
  const promise = sharedHolders(env, mint, fetchImpl, maxAgeMs).then(({ facts, list, labels, builtAt }) => {
    entry.at = builtAt; // a shared copy ages from when it was read, not from when this server picked it up
    let rank = 0;
    const rows = list.map(([owner, amount]) => {
      const label = labels.get(owner) || (isTeamWallet(owner) ? TEAM_LABEL : null);
      return { owner, amount, percent: facts.supply ? (amount / facts.supply) * 100 : 0, rank: label ? null : ++rank, label };
    });
    return { facts, rows, byOwner: new Map(rows.map((r) => [r.owner, r])), people: rank, at: new Date(builtAt).toISOString() };
  });
  entry.promise = promise;
  snaps.set(mint, entry);
  promise.catch(() => { if (snaps.get(mint) === entry) entry.failedAt = Date.now(); });
  return promise;
}
export const _resetSnapshots = () => snaps.clear();

/**
 * Where does this wallet stand? Rank among people (pools and team wallets excluded), how many hold more,
 * and how much more it takes to pass the wallet just above. A team wallet (`team: true`) has no rank and nothing to pass.
 */
export function rankOf(snap, owner) {
  const row = snap.byOwner.get(owner), team = isTeamWallet(owner);
  const out = { amount: row ? row.amount : 0, rank: row ? row.rank : null, total: snap.people, label: row ? row.label : null,
    percent: row ? row.percent : 0, percentile: null, next: null, team };
  if (row && row.rank) {
    out.percentile = Math.max(0.01, (row.rank / Math.max(1, snap.people)) * 100);
    const above = snap.rows.find((r) => r.rank === row.rank - 1);
    if (above) out.next = { rank: above.rank, amount: above.amount, gap: Math.max(0, above.amount - row.amount) };
  } else if (!team) {
    const last = [...snap.rows].reverse().find((r) => r.rank);
    if (last) out.next = { rank: last.rank, amount: last.amount, gap: last.amount };
  }
  return out;
}

/**
 * Proof of wallet ownership for apps that can't sign messages (FOMO, exchanges' web wallets...):
 * the wallet sends an exact, unusual amount of SOL to anyone (itself is easiest). Only the owner
 * can make a transfer leave the wallet, so finding it proves ownership. Looks at the wallet's
 * latest transactions after `sinceMs`. Returns true or false.
 */
export async function findTransfer(env, address, lamports, sinceMs, fetchImpl = fetch) {
  const sigs = await rpc(env, "getSignaturesForAddress", [address, { limit: 20 }], fetchImpl);
  const recent = (sigs || []).filter((s) => !s.err && (!s.blockTime || s.blockTime * 1000 >= sinceMs - 120_000)).slice(0, 10);
  for (const s of recent) {
    const tx = await rpc(env, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], fetchImpl);
    if (!tx || tx.meta?.err) continue;
    const all = [...(tx.transaction?.message?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap((x) => x.instructions || [])];
    for (const ix of all) {
      const p = ix.parsed;
      if (ix.program === "system" && p && (p.type === "transfer" || p.type === "transferWithSeed") &&
          p.info?.source === address && Number(p.info?.lamports) === lamports) return true;
    }
  }
  return false;
}

/**
 * Live $VICINITY amounts for some wallets: from the one-minute holder snapshot when the RPC allows it,
 * otherwise a direct lookup (only for short lists). Before launch everyone holds 0.
 */
export async function liveAmounts(env, wallets, fetchImpl = fetch, { maxDirect = 200, mint = null } = {}) {
  const out = new Map();
  if (!mint || !wallets.length) return out;
  try {
    const snap = await holderSnapshot(env, mint, fetchImpl);
    for (const w of wallets) out.set(w, snap.byOwner.get(w)?.amount || 0);
    return out;
  } catch {
    if (wallets.length > maxDirect) return out;
    return getHoldings(env, wallets, mint, fetchImpl);
  }
}
