// A fake launchpad RPC for the city-coin tests (src/lpkit.js, src/lpcoins.js, src/coinmeta.js, the relay): accounts in memory
// (the recorded devnet accounts of test/fixtures/launchpad-worker/devnet-accounts.json by default, plus whatever a test adds),
// getProgramAccounts with dataSize / memcmp filters (any length of bytes), withContext and minContextSlot, getMultipleAccounts with
// minContextSlot (a node at S.slot refuses a later one, like Solana's -32016), simulateTransaction with the watched accounts' post-state,
// sendTransaction and getSignatureStatuses. Every call is logged ({ url, method, params }).
import { readFileSync } from "node:fs";
import { base58Decode, base58Encode } from "../../src/solana.js";
import { decodeHeader } from "../../src/sol/message.js";
import { concat, fromBase64, u32le, u64le } from "../../src/sol/bytes.js";
import { GENESIS } from "../../src/lpkit.js";
import { PROGRAM_IDS, programDataAddress } from "../../src/sol/pda.js";
import { _setProgramPinsForTests } from "../../src/programpins.js";
import { LAYOUT } from "../../src/sol/layout.js";

export const DEV = JSON.parse(readFileSync(new URL("../fixtures/launchpad-worker/devnet-accounts.json", import.meta.url), "utf8"));
export const PROGRAM = "Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7", REWARDS = "Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi";
export const DEMOV = "EAXzD7eEJuFr8kfmqrrPBVuUNsd53PWHfsHuYFD8nPby", DEMOV_COIN = "DcCDswmYyzh4ZXkXHLenxGGcjq1WGSXpEgiuPc4pwZCw", DEMOV_CITY = "999000003";
export const DEMOV_POOL = "GCr3j1bQXJapUQFjxmnVCoPc7ciE1L2UxvKKRwtHpinA", SOL_CONFIG = "4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7";
export const METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
/** The settings that turn the city-coin gate on, on devnet with the recorded programs. */
export const LP_ON = { LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_PROGRAM_ID: PROGRAM, LAUNCHPAD_REWARDS_PROGRAM_ID: REWARDS, LAUNCHPAD_RPC_URL: "https://lp-rpc.test/devnet" };
/** A different valid-looking address for each number. */
export const addr = (i) => base58Encode(Uint8Array.from({ length: 32 }, (_, j) => (i * 31 + j * 7 + 3) & 255));
/**
 * A ProgramData account as the upgradeable loader writes it: the deploy `slot` (default 1234), `authority` (null: final), then the
 * program bytes. A test that "upgrades" a program gives it a later slot, as every real upgrade does (src/programpins.js relies on it).
 */
export const programDataAccount = (authority, elf = new Uint8Array(64).fill(7), slot = 1234) => ({ owner: PROGRAM_IDS.upgradeableLoader, data: Buffer.from(concat([u32le(3), u64le(BigInt(slot)), authority ? Uint8Array.of(1) : Uint8Array.of(0), authority ? base58Decode(authority) : new Uint8Array(32), elf])).toString("base64") });
export const sha256Hex = async (bytes) => Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
/** Meteora's upgrade authority of both programs on devnet (solana/scripts/launchpad/fetch-fixtures.sh). */
export const METEORA_AUTHORITY = "DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX";
/**
 * Meteora's two programs on a fake chain AS THE BUILDS THE TEAM TESTED (src/programpins.js): their ProgramData accounts with stand-in
 * program bytes in `accounts` (an lpChain's S.accounts, or any fake chain's), and the pins of `cluster` set to those bytes'
 * fingerprints for this test process (made-up bytes can never hash to the real pins; test/program-pins.test.js checks the real ones).
 * A test that wants "Meteora upgraded" overwrites one of the two accounts with other bytes at a later slot afterwards. Returns the
 * addresses and hashes.
 */
export async function meteoraAsTested(accounts, { dbc = new Uint8Array(4096).fill(0x11), dammV2 = new Uint8Array(2048).fill(0x22), cluster = "devnet" } = {}) {
  const [pdDbc, pdDamm] = await Promise.all([programDataAddress(PROGRAM_IDS.dbc), programDataAddress(PROGRAM_IDS.damm)]);
  accounts[pdDbc] = programDataAccount(METEORA_AUTHORITY, dbc);
  accounts[pdDamm] = programDataAccount(METEORA_AUTHORITY, dammV2);
  const hashes = { dbc: await sha256Hex(dbc), dammV2: await sha256Hex(dammV2) };
  _setProgramPinsForTests({ [cluster]: hashes });
  return { pdDbc, pdDamm, hashes };
}

/**
 * The bytes of one of our or Meteora's accounts (src/sol/layout.js: "Coin", "VirtualPool", ...): its discriminator, then each named
 * field at its offset (pubkey, u64/i64, or a byte), zeros elsewhere. Base64, as the fake chain keeps account data.
 */
export function layoutData(name, values) {
  const L = LAYOUT[name], out = new Uint8Array(L.size);
  out.set(L.discriminator, 0);
  for (const [k, v] of Object.entries(values)) {
    const f = L.fields[k];
    if (!f) throw new Error(`${name} has no field ${k}`);
    if (f.type === "pubkey") out.set(base58Decode(v), f.at);
    else if (f.type === "u64" || f.type === "i64") new DataView(out.buffer).setBigUint64(f.at, BigInt.asUintN(64, BigInt(v)), true);
    else out[f.at] = Number(v);
  }
  return Buffer.from(out).toString("base64");
}

/** Metaplex MetadataV1 bytes as the program writes them (name padded to 32, symbol to 10, uri to 200 with NULs). */
export function metaplexData({ updateAuthority = "11111111111111111111111111111111", mint, name, symbol, uri }) {
  const enc = new TextEncoder();
  const str = (s, pad) => { const b = enc.encode(s); const out = new Uint8Array(4 + pad); new DataView(out.buffer).setUint32(0, pad, true); out.set(b, 4); return out; };
  const parts = [Uint8Array.of(4), base58Decode(updateAuthority), base58Decode(mint), str(name, 32), str(symbol, 10), str(uri, 200), new Uint8Array(2), Uint8Array.of(0), Uint8Array.of(0), Uint8Array.of(0)];
  const body = new Uint8Array(679);
  let o = 0; for (const p of parts) { body.set(p, o); o += p.length; }
  return Buffer.from(body).toString("base64");
}

export function lpChain({ genesis = GENESIS.devnet, accounts = {} } = {}) {
  const S = {
    genesis, log: [], sent: [], statuses: {}, simErr: null, simLogs: ["Program log: ok"], units: 42_000, delta: {}, blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
    signatures: {}, sendError: null, down: false, slot: 1,
    accounts: { ...Object.fromEntries(Object.entries(DEV.accounts).map(([k, a]) => [k, { owner: a.owner, lamports: a.lamports, data: a.data }])), ...accounts },
  };
  // `space`: the account's whole length, as the real RPC says it (src/programpins.js fingerprint needs it)
  const acc = (k) => { const a = S.accounts[k]; return a ? { owner: a.owner, lamports: a.lamports ?? 1_000_000, data: [a.data, "base64"], executable: false, rentEpoch: 0, space: Buffer.from(a.data, "base64").length } : null; };
  const one = ({ method, params }) => {
    switch (method) {
      case "getGenesisHash": return S.genesis;
      case "getLatestBlockhash": return { context: { slot: 1 }, value: { blockhash: S.blockhash, lastValidBlockHeight: 1000 } };
      case "getAccountInfo": return { context: { slot: 1 }, value: acc(params[0]) };
      case "getMultipleAccounts": {
        const min = params[1] && params[1].minContextSlot;
        if (min != null && min > S.slot) return { __error: { code: -32016, message: "Minimum context slot has not been reached", data: { contextSlot: S.slot } } };
        return { context: { slot: S.slot }, value: params[0].map(acc) };
      }
      case "getProgramAccounts": {
        const [program, cfg] = params;
        if (cfg.minContextSlot != null && cfg.minContextSlot > S.slot) return { __error: { code: -32016, message: "Minimum context slot has not been reached", data: { contextSlot: S.slot } } };
        const out = [];
        for (const [k, a] of Object.entries(S.accounts)) {
          if (a.owner !== program) continue;
          const bytes = Buffer.from(a.data, "base64");
          const match = (m) => { const want = Buffer.from(base58Decode(m.bytes)); return want.equals(bytes.subarray(m.offset, m.offset + want.length)); };
          const ok = (cfg.filters || []).every((f) => (f.dataSize != null ? bytes.length === f.dataSize : f.memcmp ? match(f.memcmp) : true));
          if (ok) out.push({ pubkey: k, account: acc(k) });
        }
        return cfg.withContext ? { context: { slot: S.slot }, value: out } : out;
      }
      case "getSignaturesForAddress": return S.signatures[params[0]] || [];
      case "simulateTransaction": {
        const tx = fromBase64(params[0]);
        const d = decodeHeader(tx);
        const watched = params[1].accounts ? params[1].accounts.addresses : [];
        return { context: { slot: 1 }, value: { err: S.simErr, logs: S.simLogs, unitsConsumed: S.units, accounts: watched.map((k) => { const a = acc(k); const lam = (a ? a.lamports : 0) + (S.delta[k] || 0); return { lamports: lam, owner: a ? a.owner : "11111111111111111111111111111111", data: ["", "base64"] }; }), _keys: d.staticKeys.length } };
      }
      case "sendTransaction": {
        if (S.sendError) return { __error: S.sendError };
        const tx = fromBase64(params[0]);
        S.sent.push(tx);
        const sig = base58Encode(tx.subarray(1, 65));
        S.statuses[sig] = { slot: 5, confirmations: null, err: null, confirmationStatus: "confirmed" };
        return sig;
      }
      case "getSignatureStatuses": return { context: { slot: 6 }, value: params[0].map((s) => S.statuses[s] || null) };
      case "getBlockHeight": return 10;
      case "getMinimumBalanceForRentExemption": return (128 + params[0]) * 5_080; // mainnet's rate since 2026 (the admin status asks once)
      default: throw new Error("unexpected " + method);
    }
  };
  const fetchImpl = async (url, init) => {
    if (S.down) throw new Error("network down");
    const body = JSON.parse(init.body);
    S.log.push({ url: String(url), method: body.method, params: body.params });
    let result;
    try { result = one(body); } catch (e) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: String(e.message) } })); }
    if (result && result.__error) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: result.__error }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  return { S, fetchImpl, calls: (m) => S.log.filter((l) => l.method === m) };
}
