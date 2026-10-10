// A fake launchpad RPC for the city-coin tests (src/lpkit.js, src/lpcoins.js, src/coinmeta.js, the relay): accounts in memory
// (the recorded devnet accounts of test/fixtures/launchpad-worker/devnet-accounts.json by default, plus whatever a test adds),
// getProgramAccounts with dataSize / memcmp filters, simulateTransaction with the watched accounts' post-state, sendTransaction
// and getSignatureStatuses. Every call is logged ({ url, method, params }).
import { readFileSync } from "node:fs";
import { base58Decode, base58Encode } from "../../src/solana.js";
import { decodeHeader } from "../../src/sol/message.js";
import { fromBase64 } from "../../src/sol/bytes.js";
import { GENESIS } from "../../src/lpkit.js";

export const DEV = JSON.parse(readFileSync(new URL("../fixtures/launchpad-worker/devnet-accounts.json", import.meta.url), "utf8"));
export const PROGRAM = "Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7", REWARDS = "Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi";
export const DEMOV = "EAXzD7eEJuFr8kfmqrrPBVuUNsd53PWHfsHuYFD8nPby", DEMOV_COIN = "DcCDswmYyzh4ZXkXHLenxGGcjq1WGSXpEgiuPc4pwZCw", DEMOV_CITY = "999000003";
export const DEMOV_POOL = "GCr3j1bQXJapUQFjxmnVCoPc7ciE1L2UxvKKRwtHpinA", SOL_CONFIG = "4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7";
export const METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
/** The settings that turn the city-coin gate on, on devnet with the recorded programs. */
export const LP_ON = { LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_PROGRAM_ID: PROGRAM, LAUNCHPAD_REWARDS_PROGRAM_ID: REWARDS, LAUNCHPAD_RPC_URL: "https://lp-rpc.test/devnet" };
/** A different valid-looking address for each number. */
export const addr = (i) => base58Encode(Uint8Array.from({ length: 32 }, (_, j) => (i * 31 + j * 7 + 3) & 255));

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
    signatures: {}, sendError: null, down: false,
    accounts: { ...Object.fromEntries(Object.entries(DEV.accounts).map(([k, a]) => [k, { owner: a.owner, lamports: a.lamports, data: a.data }])), ...accounts },
  };
  const acc = (k) => { const a = S.accounts[k]; return a ? { owner: a.owner, lamports: a.lamports ?? 1_000_000, data: [a.data, "base64"], executable: false, rentEpoch: 0 } : null; };
  const one = ({ method, params }) => {
    switch (method) {
      case "getGenesisHash": return S.genesis;
      case "getLatestBlockhash": return { context: { slot: 1 }, value: { blockhash: S.blockhash, lastValidBlockHeight: 1000 } };
      case "getAccountInfo": return { context: { slot: 1 }, value: acc(params[0]) };
      case "getMultipleAccounts": return { context: { slot: 1 }, value: params[0].map(acc) };
      case "getProgramAccounts": {
        const [program, cfg] = params;
        const out = [];
        for (const [k, a] of Object.entries(S.accounts)) {
          if (a.owner !== program) continue;
          const bytes = Buffer.from(a.data, "base64");
          const ok = (cfg.filters || []).every((f) => (f.dataSize != null ? bytes.length === f.dataSize : f.memcmp ? Buffer.from(base58Decode(f.memcmp.bytes)).equals(bytes.subarray(f.memcmp.offset, f.memcmp.offset + 32)) : true));
          if (ok) out.push({ pubkey: k, account: acc(k) });
        }
        return out;
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
