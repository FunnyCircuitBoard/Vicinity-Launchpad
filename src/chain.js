/**
 * Live, read-only Solana data for the website: token facts, top holders,
 * and "does this wallet hold $VICINITY?". Everything comes from the public
 * blockchain. Nothing is written, and no wallet address is ever stored.
 *
 * RPC: set the secret SOLANA_RPC_URL (e.g. a Helius key) in Cloudflare, and optionally SOLANA_RPC_URL_BACKUP (another
 * provider) for when it stops answering. Without SOLANA_RPC_URL we fall back to the public endpoint, which can't list holders.
 * Every request goes out through src/rpcpool.js (endpoints, failover, breaker; never a URL in an error or a log).
 */
import { OFFICIAL } from "./official.js";
import { base58Decode, base58Encode } from "./solana.js";
import { isOnCurve } from "./sol/oncurve.js";
import { rpcPost } from "./rpcpool.js";
import { getBlob, putBlob } from "./blobs.js";

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

/**
 * One JSON-RPC call: { result, role } (role: which endpoint answered, never its URL). `cluster` "devnet" asks the launchpad's devnet
 * node only; `url` is a caller's own first node (the launchpad's LAUNCHPAD_RPC_URL on mainnet, with SOLANA_RPC_URL_BACKUP behind it);
 * `only` keeps the call on one role. A JSON-RPC error throws rpc_<code>, as before.
 */
export async function rpcAnswer(env, method, params, fetchImpl = fetch, { timeoutMs = null, url = null, cluster = null, only = null } = {}) {
  const { data, role } = await rpcPost(env, { jsonrpc: "2.0", id: 1, method, params }, fetchImpl,
    { timeoutMs: timeoutMs > 0 ? timeoutMs : rpcTimeout(env), url, cluster, only });
  if (data && data.error) throw new Error(`rpc_${data.error.code || "error"}`);
  return { result: data ? data.result : undefined, role };
}
export async function rpc(env, method, params, fetchImpl = fetch, opts = {}) {
  return (await rpcAnswer(env, method, params, fetchImpl, opts)).result;
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
 * The same facts for the holder list, kept 10 minutes per server (a failure is not kept): it needs the decimals and the program,
 * which never change, and the supply (for percentages), which changes only on a burn. One credit less per holder-list read.
 * (The token page's own "No rug pull" facts are still read fresh: /api/token.)
 */
const FACTS_MS = 10 * 60_000;
const factsMemo = new Map(); // mint -> { at, promise }
export function cachedTokenFacts(env, mint, fetchImpl) {
  let hit = factsMemo.get(mint);
  if (!hit || Date.now() - hit.at >= FACTS_MS) {
    hit = { at: Date.now(), promise: getTokenFacts(env, mint, fetchImpl) };
    hit.promise.catch(() => { if (factsMemo.get(mint) === hit) factsMemo.delete(mint); });
    factsMemo.set(mint, hit);
    if (factsMemo.size > 500) factsMemo.delete(factsMemo.keys().next().value);
  }
  return hit.promise;
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
  const facts = await cachedTokenFacts(env, mint, fetchImpl);
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
  const out = new Map();
  for (let i = 0; i < owners.length; i += 25) {
    const chunk = owners.slice(i, i + 25);
    const body = chunk.map((o, j) => ({ jsonrpc: "2.0", id: j, method: "getTokenAccountsByOwner", params: [o, { mint }, { encoding: "jsonParsed" }] }));
    const { data } = await rpcPost(env, body, fetchImpl, { timeoutMs: rpcTimeout(env) });
    // a refusal for the whole batch (one error object, not a list) is an error, never "everyone holds 0"
    if (!Array.isArray(data)) throw new Error(data && data.error ? `rpc_${data.error.code || "error"}` : "rpc_bad_answer");
    for (const r of data) {
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
export async function getMintBalances(env, owner, mints, fetchImpl = fetch, { timeoutMs = 8000, cluster = null, url = null } = {}) {
  const list = [...new Set(mints)];
  const out = new Map();
  out.accounts = new Set();
  const chunks = [];
  for (let i = 0; i < list.length; i += 25) chunks.push(list.slice(i, i + 25));
  await Promise.all(chunks.map(async (chunk) => {
    const body = chunk.map((mint, j) => ({ jsonrpc: "2.0", id: j, method: "getTokenAccountsByOwner", params: [owner, { mint }, { encoding: "jsonParsed" }] }));
    const { data } = await rpcPost(env, body, fetchImpl, { timeoutMs, cluster, url });
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
  const facts = await cachedTokenFacts(env, mint, fetchImpl);
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
 * Every holder, read from the chain about once a minute WORLDWIDE, not once a minute per data centre (10 Oct 2026: the free
 * Helius plan ran out of credits; each Cloudflare location with an open token page or dashboard read its own list every minute,
 * 12 credits each, one of them a getProgramAccounts). Three copies, nearest first, each used while younger than maxAgeMs, so the
 * list is as fresh as before:
 *   this server        holderSnapshot's memo (below)
 *   this data centre   a private cache (caches.open, never seen by visitors)
 *   every data centre  one D1 row (blobs `holders:v1:<mint>`, the gzip-and-parts store of src/blobs.js)
 * An old copy is rebuilt by ONE caller at a time: a 30-second lease in the settings table (an atomic conditional upsert, like the
 * job's lease). While someone else holds it, the newest copy is used if it is at most 30 s past its age (the list a few seconds
 * older); without one the caller reads the chain itself, as before. A failed read is remembered in the data centre for 10 s, so its
 * other servers do not each try again at once, and the newest copy rides along on the error (e.stale) for the callers that would
 * rather show a slightly older list than an error (holderSnapshot's staleMs). Any cache or database hiccup just means a direct read.
 */
const SHARED_CACHE = "vicinity-holders", SHARED_URL = "https://cache.vicinity.internal/holders-snapshot/";
const SHARED_KEY = (mint) => `holders:v1:${mint}`, LEASE_KEY = (mint) => `holders_lease:${mint}`;
const KEEP_MS = 30 * 60_000, LEASE_MS = 30_000, COLO_FAILED_MS = 10_000;
// bumped only by _resetSnapshots (tests change their fake chain and expect a fresh read): a shared copy from before is not used.
// Every server of the live site stays at 0, so they all share.
let epoch = 0;
const usable = (d) => Boolean(d && Array.isArray(d.list) && Array.isArray(d.labels) && d.facts && Number.isFinite(d.builtAt));
const asCopy = (d) => ({ facts: d.facts, list: d.list, labels: new Map(d.labels), builtAt: d.builtAt, slot: d.slot ?? null });
const shortCode = (e) => String((e && e.message) || "rpc_unavailable").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);

async function coloCache() {
  try { return typeof caches !== "undefined" && typeof caches.open === "function" ? await caches.open(SHARED_CACHE) : null; } catch { return null; }
}
async function coloGet(cache, key) {
  if (!cache) return null;
  try { const hit = await cache.match(key); return hit ? await hit.json() : null; } catch { return null; }
}
async function coloPut(cache, key, value, ms) {
  if (!cache) return;
  try { await cache.put(key, new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "Cache-Control": `max-age=${Math.max(1, Math.ceil(ms / 1000))}` } })); }
  catch { /* not shared this time */ }
}
async function sharedGet(db, mint) {
  try { const d = await getBlob(db, SHARED_KEY(mint)); return usable(d) && (d.epoch || 0) === epoch ? d : null; } catch { return null; }
}
let shareWarned = false;
async function sharedPut(db, mint, plain) {
  try { await putBlob(db, SHARED_KEY(mint), { ...plain, epoch }); }
  catch (e) { if (!shareWarned) { shareWarned = true; console.error("holder list not shared through D1", shortCode(e)); } }
}
/** True = this caller rebuilds. A database that cannot answer (no settings table yet) means "yes": a direct read, as before. */
async function takeLease(db, mint, now) {
  try {
    const r = await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value < ?")
      .bind(LEASE_KEY(mint), new Date(now + LEASE_MS).toISOString(), new Date(now).toISOString()).run();
    return Boolean(r && r.meta && r.meta.changes === 1);
  } catch { return true; }
}
async function releaseLease(db, mint) {
  try { await db.prepare("UPDATE settings SET value = '' WHERE key = ?").bind(LEASE_KEY(mint)).run(); } catch { /* it expires by itself */ }
}
function withStale(e, stale) {
  if (stale && e && typeof e === "object" && !e.stale) e.stale = asCopy(stale);
  return e;
}
/** A list read from the chain anyway (the job's balance sample): every server and data centre may use it like their own read. */
async function shareFresh(env, mint, fresh, builtAt) {
  const plain = { facts: fresh.facts, list: fresh.list, labels: [...fresh.labels], builtAt, slot: fresh.slot ?? null };
  await coloPut(await coloCache(), SHARED_URL + mint, plain, KEEP_MS);
  if (env && env.DB) await sharedPut(env.DB, mint, plain);
}

async function sharedHolders(env, mint, fetchImpl, maxAgeMs) {
  const now = Date.now(), db = env && env.DB ? env.DB : null;
  const cache = await coloCache(), key = SHARED_URL + mint;
  let stale = null; // the newest copy seen that is too old for this caller
  const consider = (d) => { if (usable(d) && (!stale || d.builtAt > stale.builtAt)) stale = d; };
  const colo = await coloGet(cache, key);
  if (usable(colo) && now - colo.builtAt < maxAgeMs) return asCopy(colo);
  consider(colo);
  const failed = await coloGet(cache, key + "/failed");
  if (failed && now - failed.at < COLO_FAILED_MS) throw withStale(new Error(String(failed.code || "rpc_unavailable")), stale);
  let leased = false;
  if (db) {
    const shared = await sharedGet(db, mint);
    if (shared && now - shared.builtAt < maxAgeMs) { await coloPut(cache, key, shared, KEEP_MS); return asCopy(shared); }
    consider(shared);
    leased = await takeLease(db, mint, now);
    // somebody else is reading the chain right now (or failed to, less than 30 s ago): their last list, a few seconds past its age
    if (!leased && stale && now - stale.builtAt < maxAgeMs + LEASE_MS) return { ...asCopy(stale), late: true };
  }
  let fresh;
  try { fresh = await getAllHolders(env, mint, fetchImpl); }
  catch (e) {
    // the lease is not given back: for its 30 s the other data centres keep showing their last list when it is recent enough
    await coloPut(cache, key + "/failed", { at: Date.now(), code: shortCode(e) }, COLO_FAILED_MS);
    throw withStale(e, stale);
  }
  const builtAt = Date.now();
  await shareFresh(env, mint, fresh, builtAt);
  if (leased) await releaseLease(db, mint);
  return { ...fresh, builtAt };
}

/**
 * The holder list, ranked. Pools, bonding curves and team wallets are shown and labelled but not ranked: ranks are for people,
 * and `people` (the "of N holders" of every rank) counts only them.
 * Kept for 60 seconds (per server, and everywhere through sharedHolders), so a busy dashboard doesn't hammer the blockchain.
 *   { facts, rows: [{ owner, amount, percent, rank|null, label }], byOwner: Map(owner → row), people, at, stale? }
 * staleMs (only for answers that show the list WITH its time: /api/holders, /api/rank): when the chain cannot
 * be read, the newest list younger than that is answered instead of an error, with its real `at` and stale: true. Callers that
 * decide something (voting power, eligibility) never get an old list: they keep their own fallback.
 */
const snaps = new Map();
const lastGood = new Map(); // mint -> this server's last good snapshot (for staleMs)
// A failed snapshot is kept this long: every caller in that time gets the same error at once, instead of each
// firing its own getProgramAccounts at an RPC that is already in trouble.
const FAILED_FOR_MS = 5_000, LATE_RETRY_MS = 5_000;
/** How old a list the display routes may show while the chain cannot be read. */
export const SHOW_STALE_MS = 15 * 60_000;
function ranked({ facts, list, labels, builtAt }) {
  let rank = 0;
  const rows = list.map(([owner, amount]) => {
    const label = labels.get(owner) || (isTeamWallet(owner) ? TEAM_LABEL : null);
    return { owner, amount, percent: facts.supply ? (amount / facts.supply) * 100 : 0, rank: label ? null : ++rank, label };
  });
  return { facts, rows, byOwner: new Map(rows.map((r) => [r.owner, r])), people: rank, at: new Date(builtAt).toISOString() };
}
function strictSnapshot(env, mint, fetchImpl, maxAgeMs) {
  const hit = snaps.get(mint);
  if (hit && Date.now() < (hit.failedAt == null ? hit.at + maxAgeMs : hit.failedAt + FAILED_FOR_MS)) return hit.promise;
  const entry = { at: Date.now(), promise: null, failedAt: null };
  const promise = sharedHolders(env, mint, fetchImpl, maxAgeMs).then((copy) => {
    // a shared copy ages from when it was read, not from when this server picked it up; one used past its age while another
    // caller rebuilds is asked again after 5 s here (not at every call: each would read the database)
    entry.at = copy.late ? Date.now() - maxAgeMs + LATE_RETRY_MS : copy.builtAt;
    const snap = ranked(copy);
    lastGood.set(mint, snap);
    return snap;
  });
  entry.promise = promise;
  snaps.set(mint, entry);
  promise.catch(() => { if (snaps.get(mint) === entry) entry.failedAt = Date.now(); });
  return promise;
}
export function holderSnapshot(env, mint, fetchImpl = fetch, maxAgeMs = 60_000, { staleMs = 0 } = {}) {
  const p = strictSnapshot(env, mint, fetchImpl, maxAgeMs);
  if (!(staleMs > 0)) return p;
  return p.catch((e) => {
    const mine = lastGood.get(mint), theirs = e && e.stale ? ranked(e.stale) : null;
    const best = [mine, theirs].filter(Boolean).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (best && Date.now() - Date.parse(best.at) < staleMs) return { ...best, stale: true };
    throw e;
  });
}
/** A list the caller read from the chain itself (the job's balance sample): this server and every other one use it like a snapshot. */
export async function publishHolders(env, mint, fresh) {
  const builtAt = Date.now();
  await shareFresh(env, mint, fresh, builtAt);
  const snap = ranked({ ...fresh, builtAt });
  lastGood.set(mint, snap);
  snaps.set(mint, { at: builtAt, promise: Promise.resolve(snap), failedAt: null });
}
/** Tests: another server (its own memory empty, the shared copies still there). */
export const _forgetServerMemory = () => { snaps.clear(); lastGood.clear(); factsMemo.clear(); };
/** Tests: the fake chain changed, so nothing read before counts (the shared D1 copy included). */
export const _resetSnapshots = () => { _forgetServerMemory(); epoch++; };

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
