/**
 * The shared kit of the city-coin launch on the website (setup, approving a city, launching, graduating, collecting fees), used by
 * src/lpadmin.js, src/lplaunch.js and src/lpcoins.js. Nothing here holds a key or sends anything: the Worker builds an UNSIGNED
 * transaction, simulates it, and hands it to the page, where any one-time keys made in the browser sign first (public/lp-sign.js),
 * then the person's wallet signs and sends it, or, a wallet that only signs, signs and the relay (src/relay.js, /api/swap/send)
 * forwards it.
 *
 *   lpSetup(env)          the gate (src/cluster.js): explicit LAUNCHPAD_CLUSTER, LAUNCHPAD_PROGRAM_ID, LAUNCHPAD_REWARDS_PROGRAM_ID
 *   checkGenesis(env)     the RPC's genesis hash must be the cluster's (a "mainnet" label in front of a devnet node, or the other
 *                         way round, is refused before anything is built); memoised per server once it matched
 *   buildTx(env, opts)    compile (v0 with a lookup table, legacy otherwise), refuse more than 1232 bytes, read the watched
 *                         accounts, simulate (sigVerify off) with their post-state, and answer the exact SOL change per address,
 *                         the decoded instruction list in plain words and a relay ticket
 *   checkCluster(env, v)  the page echoes the cluster it shows; a request for another cluster is refused
 *   respond(result)       a buildTx (or any { ok, error }) result as an HTTP answer with the right status
 *   programNames(env)     program id -> plain name, with this site's launchpad and rewards ids
 *   lpRoute / lpRpc / readAccounts  JSON-RPC on the launchpad cluster, always through src/rpcpool.js (never a fetch of its own):
 *                         devnet = the launchpad's one devnet node; mainnet = LAUNCHPAD_RPC_URL (else SOLANA_RPC_URL) first, then
 *                         SOLANA_RPC_URL_BACKUP; no URL ever appears in an error or a log line
 */
import { json } from "./http.js";
import { rpc, rpcAnswer } from "./chain.js";
import { rpcTargets } from "./rpcpool.js";
import { base58Encode, isSolanaAddress } from "./solana.js";
import { codeOf } from "./sources.js";
import { lpSetup } from "./cluster.js";
import { issueTicket, rpcRaw, simulationError } from "./relay.js";
import { MAX_TX_BYTES, compileLegacy, compileV0, decodeHeader, wrapUnsigned } from "./sol/message.js";
import { readI64, readU32, readU64, toBase64 } from "./sol/bytes.js";
import { ADDRESSES, PROGRAM_IDS } from "./sol/pda.js";
import { maxCuPrice, priorityFeeLamports, setComputeUnitLimit, setComputeUnitPrice } from "./sol/ix.js";
import { accountBytes, decodeLookupTable } from "./sol/dbc.js";

export { lpSetup };

/** The genesis hash of each cluster (what getGenesisHash answers). */
export const GENESIS = Object.freeze({
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
});
export const METAPLEX_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
export const SQUADS_V4_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
/** The most compute a transaction may ask for, and the most signers the relay takes (the wallet plus up to 3 browser keys). */
export const MAX_CU = 1_400_000;
export const MAX_SIGNERS = 4;
const NETWORK_FEE_PER_SIGNATURE = 5_000;

/** Fixed programs, in plain names (the same on both clusters). */
export const PROGRAM_NAMES = Object.freeze({
  [PROGRAM_IDS.dbc]: "Meteora DBC (bonding curve)",
  [PROGRAM_IDS.damm]: "Meteora DAMM v2 (pool)",
  [METAPLEX_PROGRAM]: "Metaplex (token names)",
  [PROGRAM_IDS.token]: "Token program",
  [PROGRAM_IDS.token2022]: "Token-2022 program",
  [PROGRAM_IDS.ata]: "Associated token accounts",
  [PROGRAM_IDS.system]: "System program",
  [PROGRAM_IDS.computeBudget]: "Compute budget",
  [PROGRAM_IDS.lookupTable]: "Address lookup table",
  [PROGRAM_IDS.upgradeableLoader]: "Program loader (upgradeable)",
  [SQUADS_V4_PROGRAM]: "Squads v4",
});
/** program id -> plain name, with this site's own launchpad and rewards programs (only while the gate is on). */
export function programNames(env) {
  const s = lpSetup(env);
  return { ...PROGRAM_NAMES, ...(s.on ? { [s.programId]: "Vicinity launchpad", [s.rewardsProgramId]: "Vicinity rewards" } : {}) };
}
const SYSVARS = {
  SysvarRent111111111111111111111111111111111: "Rent sysvar",
  SysvarC1ock11111111111111111111111111111111: "Clock sysvar",
  Sysvar1nstructions1111111111111111111111111: "Instructions sysvar",
  SysvarS1otHashes111111111111111111111111111: "Slot hashes sysvar",
};

/* ---------------------------------------------------------------- instruction names */
/** Anchor instruction names of the programs the site builds for (the discriminator is sha256("global:<name>")[..8]). */
export const ANCHOR_NAMES = Object.freeze({
  launchpad: ["init_launchpad", "propose_admin", "accept_admin", "set_payout_config", "set_pause", "add_launch_config", "set_launch_config_enabled",
    "approve_launch", "revoke_approval", "launch", "harvest_curve_fees", "harvest_pool_fees", "forward_holders_fees", "claim_founder_fees",
    "transfer_founder", "opt_in_payout", "revoke_payout_opt_in", "payout_founder_fees"],
  rewards: ["init_registry", "init_city", "propose_admin", "accept_admin", "propose_authority", "accept_authority", "fund_epoch", "fund_epoch_from_vault",
    "claim", "cancel_epoch", "sweep_epoch", "close_claim_status", "lock_config", "pause", "unpause", "set_founder"],
  dbc: ["create_config", "create_partner_metadata", "swap", "swap2", "migration_damm_v2", "migration_damm_v2_create_metadata", "withdraw_leftover",
    "claim_trading_fee", "claim_partner_pool_creation_fee", "partner_withdraw_surplus", "initialize_virtual_pool_with_spl_token", "create_locker",
    "withdraw_migration_fee", "claim_creator_trading_fee", "creator_withdraw_surplus"],
  damm: ["claim_position_fee", "swap", "swap2", "create_position", "add_liquidity", "remove_liquidity", "lock_position", "permanent_lock_position"],
});
/** What an instruction does, in plain words (the raw name is shown next to it). */
const SAY = {
  init_launchpad: "start the launchpad", init_registry: "start the rewards registry", propose_admin: "propose a new admin", accept_admin: "accept the admin role",
  set_pause: "pause or resume", add_launch_config: "allow a price curve", set_launch_config_enabled: "turn a price curve on or off",
  approve_launch: "approve a city coin", revoke_approval: "withdraw an approval", launch: "launch a city coin", harvest_curve_fees: "collect city fees from the curve",
  harvest_pool_fees: "collect city fees from the pool", forward_holders_fees: "forward the holders' share", claim_founder_fees: "the founder collects their fees",
  init_city: "set up holder rewards for a city", create_config: "create the price curve", create_partner_metadata: "name Vicinity on Meteora",
  swap: "trade", swap2: "trade", migration_damm_v2: "move the coin to the open market", withdraw_leftover: "return the curve's leftover coins",
  claim_trading_fee: "collect the platform's trading fees", claim_partner_pool_creation_fee: "collect the launch fees", partner_withdraw_surplus: "collect the curve's surplus",
  claim_position_fee: "collect pool fees", set_compute_unit_limit: "set the compute limit", set_compute_unit_price: "set the priority fee",
  create_account: "create an account", transfer: "send SOL", create: "create a token account", create_idempotent: "create a token account if missing",
  sync_native: "wrap SOL", close_account: "close a token account (its SOL comes back)", create_lookup_table: "create a speed table", extend_lookup_table: "add addresses to the speed table",
  set_authority: "hand over control of a program",
};
let anchorIndex = null; // Promise<Map("<program key>|<hex8>" -> name)>
async function anchorNames() {
  if (!anchorIndex) {
    anchorIndex = (async () => {
      const m = new Map();
      for (const [prog, names] of Object.entries(ANCHOR_NAMES)) {
        for (const n of names) {
          const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${n}`))).subarray(0, 8);
          m.set(`${prog}|${[...d].map((b) => b.toString(16).padStart(2, "0")).join("")}`, n);
        }
      }
      return m;
    })();
  }
  return anchorIndex;
}
const SYSTEM_IX = { 0: "create_account", 1: "assign", 2: "transfer", 3: "create_account_with_seed", 8: "allocate" };
const TOKEN_IX = { 1: "initialize_account", 3: "transfer", 7: "mint_to", 8: "burn", 9: "close_account", 12: "transfer_checked", 17: "sync_native", 18: "initialize_account3", 20: "initialize_mint2" };
const ALT_IX = { 0: "create_lookup_table", 1: "freeze_lookup_table", 2: "extend_lookup_table", 3: "deactivate_lookup_table", 4: "close_lookup_table" };
const LOADER_IX = { 0: "initialize_buffer", 1: "write", 2: "deploy_with_max_data_len", 3: "upgrade", 4: "set_authority", 5: "close", 6: "extend_program", 7: "set_authority_checked" };
const sol = (lamports) => `${(Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL`;

/**
 * approve_launch's arguments, read back from the instruction's own bytes (city id u64, founder pubkey, name and symbol as Borsh
 * strings, expires_at i64): what the owner's signature fixes for ever, so the page shows it before the wallet opens (a wallet does
 * not decode our program). null when the bytes do not parse.
 */
export function decodeApproveLaunch(d) {
  try {
    let at = 8;
    const cityId = readU64(d, at).toString(); at += 8;
    if (d.length < at + 32) return null;
    const founder = base58Encode(d.subarray(at, at + 32)); at += 32;
    const text = () => {
      const n = readU32(d, at); at += 4;
      if (n > 64 || at + n > d.length) throw new Error("bad");
      const v = new TextDecoder("utf-8", { fatal: true }).decode(d.subarray(at, at + n)); at += n; return v;
    };
    const name = text(), symbol = text();
    if (at + 8 !== d.length) return null;
    const expiresAt = Number(readI64(d, at));
    return { cityId, founder, name, symbol, expiresAt: new Date(expiresAt * 1000).toISOString() };
  } catch { return null; }
}
const utcMinute = (isoString) => `${isoString.slice(0, 10)} ${isoString.slice(11, 16)} UTC`;

/** { ix, say, detail, fields? } of one instruction ({ programAddress, data }) under the site's programs. */
export async function nameInstruction(env, ix) {
  const s = lpSetup(env), p = ix.programAddress, d = ix.data || new Uint8Array(0);
  const out = (name, detail = null, fields = null) => ({ ix: name, say: (name && SAY[name]) || (name ? name.replace(/_/g, " ") : "unknown instruction"), detail, ...(fields ? { fields } : {}) });
  try {
    const key = p === s.programId ? "launchpad" : p === s.rewardsProgramId ? "rewards" : p === PROGRAM_IDS.dbc ? "dbc" : p === PROGRAM_IDS.damm ? "damm" : null;
    if (key) {
      if (d.length < 8) return out(null);
      const hex8 = [...d.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const name = (await anchorNames()).get(`${key}|${hex8}`) || null;
      if (key === "launchpad" && name === "approve_launch") {
        const a = decodeApproveLaunch(d);
        if (a) return out(name, `the coin "${a.name}", ticker $${a.symbol}, founder wallet ${a.founder}, who can launch it until ${utcMinute(a.expiresAt)}`, a);
      }
      return out(name);
    }
    switch (p) {
      case PROGRAM_IDS.computeBudget:
        if (d[0] === 2 && d.length >= 5) return out("set_compute_unit_limit", `${readU32(d, 1).toLocaleString("en-US")} units`);
        if (d[0] === 3 && d.length >= 9) return out("set_compute_unit_price", `${readU64(d, 1).toString()} micro-lamports per unit`);
        return out(null);
      case PROGRAM_IDS.system: {
        const n = d.length >= 4 ? readU32(d, 0) : -1;
        if (n === 2 && d.length >= 12) return out("transfer", sol(readU64(d, 4)));
        if (n === 0 && d.length >= 12) return out("create_account", `${sol(readU64(d, 4))} of rent`);
        return out(SYSTEM_IX[n] || null);
      }
      case PROGRAM_IDS.token: case PROGRAM_IDS.token2022: return out(TOKEN_IX[d[0]] || null);
      case PROGRAM_IDS.ata: return out(d.length === 0 || d[0] === 0 ? "create" : d[0] === 1 ? "create_idempotent" : null);
      case PROGRAM_IDS.lookupTable: return out(d.length >= 4 ? ALT_IX[readU32(d, 0)] || null : null);
      case PROGRAM_IDS.upgradeableLoader: return out(d.length >= 4 ? LOADER_IX[readU32(d, 0)] || null : null);
      default: return out(null);
    }
  } catch { return out(null); }
}
const ROLE = ["read-only", "writable", "signer", "writable signer"];
/** The decoded instruction list a page shows before the wallet opens. */
export async function summarize(env, instructions, labels = {}) {
  const names = programNames(env);
  const label = (a) => labels[a] || names[a] || SYSVARS[a] || (a === ADDRESSES.feeRecipient ? "Vicinity dev wallet (platform fees)" : a === ADDRESSES.wsol ? "Wrapped SOL" : null);
  const out = [];
  for (const ix of instructions) {
    const n = await nameInstruction(env, ix);
    out.push({ program: ix.programAddress, programName: names[ix.programAddress] || "Unknown program", ix: n.ix, say: n.say, detail: n.detail, ...(n.fields ? { fields: n.fields } : {}),
      accounts: ix.accounts.map((a) => ({ address: a.address, role: ROLE[a.role & 3], label: label(a.address) })) });
  }
  return out;
}

/* ---------------------------------------------------------------- RPC on the launchpad cluster */
/**
 * Where the launchpad cluster's calls go (src/rpcpool.js): { cluster, url }. Devnet asks its one node (never a mainnet node, never
 * a failover); mainnet asks lpSetup(env).rpc (LAUNCHPAD_RPC_URL, else SOLANA_RPC_URL) first and SOLANA_RPC_URL_BACKUP behind it,
 * with the pool's breaker. Like src/lptrade.js lpRoute.
 */
export const lpRoute = (env) => { const s = lpSetup(env); return { cluster: s.cluster, url: s.rpc }; };
/**
 * One JSON-RPC call on the launchpad cluster, through the pool (lpRoute; `route` adds `only` when buildTx is pinned to the node
 * whose genesis hash was checked). Throws a short code (never a URL).
 */
export const lpRpc = (env, method, params, fetchImpl = fetch, route = null) => rpc(env, method, params, fetchImpl, route || lpRoute(env));
/** Map(address -> account | null) for up to any number of addresses (100 per call), base64 data. Throws on a broken answer. */
export async function readAccounts(env, addresses, fetchImpl = fetch, { commitment = "confirmed", route = null } = {}) {
  const out = new Map();
  const list = [...new Set(addresses)];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const r = await lpRpc(env, "getMultipleAccounts", [chunk, { encoding: "base64", commitment }], fetchImpl, route);
    const v = r && Array.isArray(r.value) ? r.value : null;
    if (!v || v.length !== chunk.length) throw new Error("rpc_bad_answer");
    chunk.forEach((a, j) => out.set(a, v[j] || null));
  }
  return out;
}

/* ---------------------------------------------------------------- the cluster guards */
const genesisOk = new Map(); // "<cluster>|<rpc>" -> true once the first node's genesis hash matched (per server; never shown)
export const _resetLpKit = () => { genesisOk.clear(); anchorIndex = null; };
/**
 * Is the node behind lpSetup(env).rpc really the cluster the settings name? { ok: true, cluster, only? } | { ok: false, error:
 * "wrong_cluster" | "rpc_unavailable" | "not_enabled" }. A match of that first node is remembered for the life of the server; a
 * failure is asked again next time. When the pool answered from SOLANA_RPC_URL_BACKUP instead (the first node failed, perhaps only
 * once: a plain 429 moves that one call and benches nothing), a matching hash lets this request go on (the pool uses that backup
 * only once it proved to be a mainnet node, src/rpcpool.js) but is not remembered, and `only` names the node that WAS checked:
 * buildTx then reads, takes its blockhash and simulates on that node alone, so a first node nobody checked (a devnet URL behind a
 * "mainnet" label) never feeds a summary the person signs. The first node is asked again by the next request.
 */
export async function checkGenesis(env, fetchImpl = fetch) {
  const s = lpSetup(env);
  if (!s.on) return { ok: false, error: "not_enabled" };
  const key = `${s.cluster}|${s.rpc}`;
  if (genesisOk.get(key)) return { ok: true, cluster: s.cluster };
  const route = lpRoute(env);
  let got, role;
  try { ({ result: got, role } = await rpcAnswer(env, "getGenesisHash", [], fetchImpl, route)); } catch (e) { console.error("genesis check failed", codeOf(e)); return { ok: false, error: "rpc_unavailable" }; }
  if (got !== GENESIS[s.cluster]) {
    console.error("genesis mismatch: the launchpad RPC is not", s.cluster);
    return { ok: false, error: "wrong_cluster", cluster: s.cluster, message: `The blockchain node in the settings is not Solana ${s.cluster}. Nothing was built.` };
  }
  if (role === rpcTargets(env, route)[0].role) { genesisOk.set(key, true); return { ok: true, cluster: s.cluster }; }
  return { ok: true, cluster: s.cluster, only: role };
}
/** The page sends the cluster it shows ("mainnet" / "devnet"); null when it is this Worker's, else the error to answer. */
export function checkCluster(env, value) {
  const s = lpSetup(env);
  if (!s.on) return { ok: false, error: "not_enabled" };
  if (value !== s.cluster) return { ok: false, error: "cluster_mismatch", cluster: s.cluster, message: `This site works on Solana ${s.cluster}. Reload the page.` };
  return null;
}

/* ---------------------------------------------------------------- building */
async function tableOf(env, lookupTable, fetchImpl, route) {
  if (!lookupTable) return null;
  if (typeof lookupTable === "object" && isSolanaAddress(lookupTable.key) && Array.isArray(lookupTable.addresses)) return lookupTable;
  if (!isSolanaAddress(lookupTable)) throw Object.assign(new Error("bad_lookup_table"), { code: "bad_lookup_table" });
  const r = await lpRpc(env, "getAccountInfo", [lookupTable, { encoding: "base64", commitment: "confirmed" }], fetchImpl, route);
  const t = decodeLookupTable(r && r.value);
  if (!t) throw Object.assign(new Error("lookup_table_missing"), { code: "lookup_table_missing" });
  return { key: lookupTable, addresses: t.addresses };
}
const lamportsOf = (acc) => (acc && Number.isFinite(Number(acc.lamports)) ? Number(acc.lamports) : 0);

/**
 * Build, check and simulate one transaction for the page to sign.
 *   payer         the fee payer: ALWAYS the session wallet (the route passes it; never a wallet from the request body)
 *   instructions  [{ programAddress, accounts: [{ address, role }], data }] WITHOUT compute-budget instructions (added here)
 *   extraSigners  public keys of one-time keys made in the browser (public/lp-sign.js); every signer of the instructions must be
 *                 the payer or one of these, or nothing is built (the Worker never builds what needs somebody else's key)
 *   lookupTable   an address (read from the chain) or { key, addresses }: version 0; none: legacy
 *   cuLimit       a fixed compute limit; without it the simulation measures one (+15%, at least 50,000), and the transaction with
 *                 that limit is simulated again (the bytes handed out are always simulated bytes)
 *   cuPrice       micro-lamports per unit (default the LAUNCHPAD_CU_PRICE setting, capped so the priority fee stays <= 0.01 SOL)
 *   watch         addresses whose SOL change is reported (default: the payer)
 *   labels        { address: "plain words" } for the summary
 * { ok: true, tx (base64, unsigned), ticket, lastValidBlockHeight, blockhash, cluster, chain, version, bytes, signers,
 *   simulation: { ok, err, logs, unitsConsumed }, solChange: { address: lamports }, summary, fees }
 * or { ok: false, error, ... } (simulation failures carry name/program/logs and the summary of what would have been sent).
 */
export async function buildTx(env, { payer, instructions, extraSigners = [], lookupTable = null, cuLimit = null, cuPrice = env && env.LAUNCHPAD_CU_PRICE, watch = null, labels = {} } = {}, fetchImpl = fetch, now = Date.now()) {
  const s = lpSetup(env);
  if (!s.on) return { ok: false, error: "not_enabled" };
  if (!isSolanaAddress(payer)) return { ok: false, error: "bad_wallet" };
  if (!Array.isArray(instructions) || !instructions.length) return { ok: false, error: "bad_request" };
  if (!Array.isArray(extraSigners) || extraSigners.length > MAX_SIGNERS - 1 || !extraSigners.every(isSolanaAddress) || extraSigners.includes(payer) || new Set(extraSigners).size !== extraSigners.length) return { ok: false, error: "bad_signers" };
  if (instructions.some((ix) => ix.programAddress === PROGRAM_IDS.computeBudget)) return { ok: false, error: "bad_request" };
  const g = await checkGenesis(env, fetchImpl);
  if (!g.ok) return g;
  // every call of this build on the node whose genesis hash was checked: the first node once it matched (then the backup behind
  // it, itself checked by the pool), or only the backup when the first node did not answer the check (checkGenesis `only`)
  const route = g.only ? { ...lpRoute(env), only: g.only } : lpRoute(env);
  const watched = [...new Set([payer, ...(Array.isArray(watch) ? watch.filter(isSolanaAddress) : [])])];
  const fixedLimit = Number.isInteger(cuLimit) && cuLimit > 0 ? Math.min(MAX_CU, cuLimit) : null;
  const priceSetting = /^\d{1,12}$/.test(String(cuPrice ?? "")) ? BigInt(cuPrice) : 0n;
  const priceFor = (limit) => (priceSetting > 0n ? (priceSetting < maxCuPrice(limit) ? priceSetting : maxCuPrice(limit)) : 0n);
  const withBudget = (limit) => [setComputeUnitLimit(limit), ...(priceFor(limit) > 0n ? [setComputeUnitPrice(priceFor(limit))] : []), ...instructions];

  let table, bh, pre;
  try {
    [table, bh, pre] = await Promise.all([
      tableOf(env, lookupTable, fetchImpl, route),
      lpRpc(env, "getLatestBlockhash", [{ commitment: "confirmed" }], fetchImpl, route),
      readAccounts(env, watched, fetchImpl, { route }),
    ]);
  } catch (e) {
    if (e.code === "lookup_table_missing" || e.code === "bad_lookup_table") return { ok: false, error: e.code };
    console.error("lp build read failed", codeOf(e));
    return { ok: false, error: "rpc_unavailable" };
  }
  const blockhash = bh && bh.value;
  if (!blockhash || !isSolanaAddress(blockhash.blockhash)) return { ok: false, error: "rpc_unavailable" };
  const compile = (limit) => {
    const ixs = withBudget(limit);
    let message;
    try { message = table ? compileV0({ payer, instructions: ixs, blockhash: blockhash.blockhash, lookupTables: [table] }) : compileLegacy({ payer, instructions: ixs, blockhash: blockhash.blockhash }); }
    catch (e) { return { error: codeOf(e) === "account_index_overflow" || codeOf(e) === "lookup_index_too_large" ? "tx_too_large" : "bad_request" }; }
    const tx = wrapUnsigned(message);
    const d = decodeHeader(tx);
    const signers = d.staticKeys.slice(0, d.header.numRequiredSignatures);
    const want = new Set([payer, ...extraSigners]);
    if (signers.length !== want.size || !signers.every((k) => want.has(k))) return { error: "unexpected_signer" };
    if (tx.length > MAX_TX_BYTES) return { error: "tx_too_large", bytes: tx.length };
    return { tx, ixs, decoded: d, signers };
  };
  const simulateWith = async (built) => {
    const d = await rpcRaw(env, "simulateTransaction", [toBase64(built.tx), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: watched } }], fetchImpl, route);
    if (d.error) throw new Error(`rpc_${d.error.code || "error"}`);
    const v = d.result && d.result.value ? d.result.value : {};
    return { ok: v.err == null, err: v.err ?? null, logs: Array.isArray(v.logs) ? v.logs.slice(-30) : [], unitsConsumed: Number.isFinite(Number(v.unitsConsumed)) ? Number(v.unitsConsumed) : null, accounts: Array.isArray(v.accounts) ? v.accounts : null };
  };

  let limit = fixedLimit || MAX_CU;
  let built = compile(limit);
  if (built.error) return { ok: false, error: built.error, ...(built.bytes ? { bytes: built.bytes, max: MAX_TX_BYTES } : {}) };
  let sim;
  try {
    sim = await simulateWith(built);
    if (sim.ok && !fixedLimit && sim.unitsConsumed) {
      const tuned = Math.min(MAX_CU, Math.max(50_000, Math.ceil(sim.unitsConsumed * 1.15)));
      if (tuned !== limit) {
        // the bytes handed to the wallet are always the bytes simulated last: the tuned limit is tried once more (the priority fee
        // is charged on the limit, so the SOL change is read again too); if the tuned limit is too low, the full-limit bytes that
        // already passed are kept
        const again = compile(tuned);
        if (!again.error) {
          const sim2 = await simulateWith(again);
          if (sim2.ok) { limit = tuned; built = again; sim = sim2; }
        }
      }
    }
  } catch (e) { console.error("lp simulation failed", codeOf(e)); return { ok: false, error: "rpc_unavailable" }; }
  const summary = await summarize(env, built.ixs, { [payer]: "your wallet (pays)", ...Object.fromEntries(extraSigners.map((k) => [k, "a one-time key made in this browser"])), ...labels });
  const simulation = { ok: sim.ok, err: sim.err, logs: sim.logs, unitsConsumed: sim.unitsConsumed };
  if (!sim.ok) {
    const m = simulationError(sim.err, sim.logs, built.decoded, { launchpadProgramId: s.programId }) || { error: "program_error" };
    return { ok: false, ...m, program: m.program || undefined, programName: m.program ? programNames(env)[m.program] || null : undefined, stage: "simulation", simulation, summary };
  }
  const solChange = {};
  watched.forEach((a, i) => {
    const post = sim.accounts && sim.accounts[i] !== undefined ? sim.accounts[i] : undefined;
    solChange[a] = post === undefined ? null : lamportsOf(post) - lamportsOf(pre.get(a)); // null: the node did not report it
  });
  const price = priceFor(limit);
  return {
    ok: true, tx: toBase64(built.tx), ticket: await issueTicket(env, built.tx, now), blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight,
    cluster: s.cluster, chain: s.chain, version: table ? 0 : "legacy", bytes: built.tx.length, signers: built.signers,
    simulation, solChange, summary,
    fees: { computeUnitLimit: limit, computeUnitPrice: price.toString(), priorityLamports: Number(priorityFeeLamports(price, limit)), networkLamports: NETWORK_FEE_PER_SIGNATURE * built.signers.length },
  };
}

/* ---------------------------------------------------------------- answers */
const STATUS = {
  not_enabled: 404, bad_request: 400, bad_json: 400, bad_wallet: 400, bad_signers: 400, bad_lookup_table: 400, tx_too_large: 400,
  cluster_mismatch: 409, wrong_cluster: 503, rpc_unavailable: 503, rpc_busy: 503, lookup_table_missing: 409, unexpected_signer: 500,
  sign_in: 401, forbidden: 403, reprove: 403, slow_down: 429,
};
/** A kit result as an HTTP answer: 200 when ok, the error's own status otherwise (a failed simulation is 409). Never cached. */
export function respond(result, extraHeaders = {}) {
  const status = result && result.ok ? 200 : STATUS[result && result.error] || (result && result.stage === "simulation" ? 409 : 400);
  return json(result, status, { "Cache-Control": "no-store", ...extraHeaders });
}
/** The address of the Metaplex metadata account of a mint is in src/sol/metaplex.js; the ProgramData account in src/sol/pda.js. */
export { accountBytes };
