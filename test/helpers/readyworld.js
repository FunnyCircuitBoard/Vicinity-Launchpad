// The test world of the ready-made coin through the EXISTING approval and launch path (COIN_V2_READY, src/coinready.js): the owner
// with a started launchpad and the SOL curve allowed, Utica's active founder holding the bar, the city list with region names, and a
// fake launchpad RPC (accounts by address, getProgramAccounts with filters, a simulation; every call logged). Shared by
// test/coin-ready-launch.test.js and test/coin-ready-recheck.test.js (each sets the art renderer and resets the modules itself).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BOUNDS, CITIES, IN_UTICA, MINT, newWorld, person, useClock, chain } from "./world.js";
import { GENESIS } from "../../src/lpkit.js";
import { _resetCityCache } from "../../src/cities.js";
import { _resetTickers } from "../../src/tickers.js";
import { handleCoinMeta } from "../../src/coinmeta.js";
import { base58Decode, base58Encode } from "../../src/solana.js";
import { concat, u32le, u64le } from "../../src/sol/bytes.js";
import { LAYOUT } from "../../src/sol/layout.js";
import { ADDRESSES, PROGRAM_IDS, launchpad as launchpadPdas, programDataAddress } from "../../src/sol/pda.js";
import { metadataAddress } from "../../src/sol/metaplex.js";
import { meteoraAsTested } from "./lpchain.js";

export const PROGRAM = "Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7", REWARDS = "Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi";
export const LOADER = PROGRAM_IDS.upgradeableLoader, WSOL = ADDRESSES.wsol, METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
export const UTICA = "5142056";
export const b64 = (u8) => Buffer.from(u8).toString("base64");
export let n = 0;
export const fresh = () => base58Encode(Uint8Array.from({ length: 32 }, (_, j) => (++n * 37 + j * 11 + 5) & 255));
export const CONFIG = fresh();
// the price curve's bytes are the live mainnet one's (EZVHCg…, made with DBC 0.2.1: PoolConfig.version 0), which approvals name
export const LIVE_CONFIG = JSON.parse(readFileSync(new URL("../fixtures/launchpad-worker/mainnet-pool-config.json", import.meta.url), "utf8")).accounts.EZVHCgxKZhvXmUGMXJMEw8tZHiTmoHPyM9mNNQ5u1kSP;
export const enc = new TextEncoder();
export const s32 = (s) => concat([u32le(enc.encode(s).length), enc.encode(s)]);

export function layoutAccount(name, values) {
  const L = LAYOUT[name], out = new Uint8Array(L.size);
  out.set(L.discriminator, 0);
  for (const [k, v] of Object.entries(values)) {
    const f = L.fields[k];
    if (f.type === "pubkey") out.set(base58Decode(v), f.at);
    else if (f.type === "u64" || f.type === "i64") out.set(u64le(BigInt.asUintN(64, BigInt(v))), f.at);
    else out[f.at] = Number(v);
  }
  return out;
}
export const programAccount = (pd) => ({ owner: LOADER, executable: true, data: b64(concat([u32le(2), base58Decode(pd)])) });
export const programDataAccount = (authority) => ({ owner: LOADER, data: b64(concat([u32le(3), u64le(1234), Uint8Array.of(1), base58Decode(authority), new Uint8Array(64).fill(7)])) });
export function approvalAccount({ cityId, founder, rentPayer, name, symbol, expiresAt }) {
  const body = concat([Uint8Array.of(233, 9, 153, 49, 11, 222, 59, 130), u64le(cityId), base58Decode(founder), base58Decode(CONFIG), base58Decode(rentPayer), s32(name), s32(symbol), u64le(1), u64le(expiresAt), Uint8Array.of(254)]);
  const out = new Uint8Array(179); out.set(body);
  return { owner: PROGRAM, data: b64(out) };
}
export const metadataAccount = (mint, name, symbol, uri) => ({ owner: METAPLEX, data: b64(concat([Uint8Array.of(4), new Uint8Array(32), base58Decode(mint), s32(name), s32(symbol), s32(uri), Uint8Array.of(0, 0, 0, 0, 0)])) });

/** The launchpad's RPC: accounts by address, getProgramAccounts with filters, a simulation; every call logged. */
export function fakeChain(accounts = {}) {
  const S = { accounts: { ...accounts }, log: [], down: false };
  const acc = (k, slice) => {
    const a = S.accounts[k];
    if (!a) return null;
    let data = Buffer.from(a.data, "base64");
    const space = data.length; // the whole account, whatever the slice (as the real RPC answers)
    if (slice) data = data.subarray(slice.offset, slice.offset + slice.length);
    return { owner: a.owner, lamports: a.lamports ?? 2_000_000, data: [data.toString("base64"), "base64"], executable: Boolean(a.executable), rentEpoch: 0, space };
  };
  const one = ({ method, params }) => {
    if (S.down && method !== "getGenesisHash") throw new Error("down");
    switch (method) {
      case "getGenesisHash": return GENESIS.devnet;
      case "getLatestBlockhash": return { context: { slot: 1 }, value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000 } };
      case "getAccountInfo": return { context: { slot: 1 }, value: acc(params[0], params[1] && params[1].dataSlice) };
      case "getMultipleAccounts": return { context: { slot: 1 }, value: params[0].map((k) => acc(k, params[1] && params[1].dataSlice)) };
      case "getProgramAccounts": {
        const [program, cfg] = params;
        return Object.entries(S.accounts).filter(([, a]) => a.owner === program).filter(([, a]) => {
          const d = Buffer.from(a.data, "base64");
          return (cfg.filters || []).every((f) => (f.dataSize != null ? d.length === f.dataSize : Buffer.from(base58Decode(f.memcmp.bytes)).equals(d.subarray(f.memcmp.offset, f.memcmp.offset + 32))));
        }).map(([k]) => ({ pubkey: k, account: acc(k) }));
      }
      case "getSignaturesForAddress": return [];
      case "simulateTransaction": return { context: { slot: 1 }, value: { err: null, logs: ["Program log: ok"], unitsConsumed: 30_000, accounts: (params[1].accounts ? params[1].accounts.addresses : []).map(() => ({ lamports: 1_995_000, owner: PROGRAM_IDS.system, data: ["", "base64"] })) } };
      default: throw new Error("unexpected " + method);
    }
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    S.log.push({ method: body.method, params: body.params });
    try { return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: one(body) })); }
    catch (e) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: String(e.message) } })); }
  };
  return { S, fetchImpl, count: (m, at) => S.log.filter((l) => l.method === m && (at === undefined || l.params[0] === at)).length };
}

export const LP_ON = { LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_PROGRAM_ID: PROGRAM, LAUNCHPAD_REWARDS_PROGRAM_ID: REWARDS, LAUNCHPAD_RPC_URL: "https://lp-rpc.test/devnet", LAUNCHPAD_DBC_CONFIGS: CONFIG };
export const SYRACUSE = "5140405";
// what the City coins card sends with "Approve on chain" (public/admin-lp.js): with the ready-made coin, the exact version it showed too
export const seenOf = (c) => ({ cityId: c.cityId, name: c.name, symbol: c.symbol, founder: c.founder, designAt: c.designAt, ...(c.ready ? { contentHash: c.ready.contentHash } : {}) });


/** The owner with a started launchpad and the SOL curve allowed; Utica's active founder holding the bar; the list with region names. */
export async function world({ ready = "on" } = {}) {
  useClock("2026-10-20T12:00:00Z");
  const env = { ...newWorld({ VICINITY_MINT: MINT, ...(ready ? { COIN_V2_READY: ready } : {}) }), ...LP_ON };
  _resetCityCache(); _resetTickers();
  const files = { "/data/cities.json": JSON.stringify({ ...CITIES, admin: { "US.NY": "New York" } }), "/data/bounds/US.txt": BOUNDS,
    "/data/tickers.json": JSON.stringify({ 5128581: "NYC", 5140405: "SYRACUSE", 5106834: "ALBANY", 5142056: "UTICA" }) };
  env.ASSETS = { fetch: async (r) => { const f = files[new URL(r.url).pathname]; return f ? new Response(f) : new Response("", { status: 404 }); } };
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  const L = launchpadPdas(PROGRAM);
  const [pdLp, pdRw] = await Promise.all([programDataAddress(PROGRAM), programDataAddress(REWARDS)]);
  const lp = fakeChain({
    [PROGRAM]: programAccount(pdLp), [REWARDS]: programAccount(pdRw), [pdLp]: programDataAccount(owner.w.address), [pdRw]: programDataAccount(owner.w.address),
    [await L.launchpad()]: { owner: PROGRAM, data: b64(layoutAccount("Launchpad", { admin: owner.w.address, rewards_program: REWARDS })) },
    [await L.launchConfig(CONFIG)]: { owner: PROGRAM, data: b64(layoutAccount("LaunchConfig", { dbc_config: CONFIG, quote_mint: WSOL, enabled: 1 })) },
    [CONFIG]: { owner: PROGRAM_IDS.dbc, data: LIVE_CONFIG.data },
  });
  await meteoraAsTested(lp.S.accounts);
  const main = chain();
  const both = (url, init) => (String(url).startsWith("https://lp-rpc.test") ? lp.fetchImpl(url, init) : main(url, init));
  const f = await person(env, { home: IN_UTICA, holds: 2_000_000 });
  const u = await env.DB.prepare("SELECT id, wallet FROM users WHERE wallet = ?").bind(f.w.address).first();
  const at = new Date(Date.now()).toISOString();
  await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, 'Utica', 'US', ?, ?, 3, 1000000, 'active', ?, ?)").bind(UTICA, u.id, u.wallet, at, at).run();
  const post = async (who, path, body) => { const r = await who.send(path, { method: "POST", body, fetchImpl: both }); return { status: r.status, ...(await r.json()) }; };
  const get = async (who, path) => (await who.send(path, { fetchImpl: both })).json();
  const card = async () => (await get(owner, "/api/admin/lp/candidates?cluster=devnet")).candidates.find((c) => c.cityId === UTICA);
  /** The founder takes the ready-made coin: the picture, then "Use this coin" with the version shown. */
  const useCoin = async () => {
    const a = await post(f, "/api/coins/ready/art", { cityId: UTICA });
    assert.equal(a.ok, true, JSON.stringify(a));
    const r = await post(f, "/api/coins/ready/use", { cityId: UTICA, contentHash: a.coin.contentHash });
    assert.equal(r.ok, true, JSON.stringify(r));
    return a.coin;
  };
  return { env, owner, f, lp, both, post, get, card, L, useCoin };
}
export const meta = (env, path, method = "GET") => handleCoinMeta(new Request(`https://vicinity.city${path}`, { method, headers: { "cf-connecting-ip": "198.51.100.8" } }), env, chain());

/** The founder's coin approved and launched on the fake chain (the program copies the approved name and symbol into the metadata). */
export async function launchOnChain(w, { name = "Utica", symbol = "UTICA" } = {}) {
  const mint = fresh();
  w.lp.S.accounts[await w.L.coin(BigInt(UTICA))] = { owner: PROGRAM, data: b64(layoutAccount("Coin", { city_id: UTICA, founder: w.f.w.address, mint, quote_mint: WSOL, dbc_config: CONFIG, dbc_pool: fresh() })) };
  w.lp.S.accounts[await metadataAddress(mint)] = metadataAccount(mint, name, symbol, `https://vicinity.city/coin-meta/${mint}.json`);
  return mint;
}
