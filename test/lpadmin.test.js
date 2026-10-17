// The admin "City coins" routes (src/lpadmin.js) through the real API with a fake chain: dark without the gate, the owner only,
// a stale proof gets "reprove", the page's cluster echo and the RPC's genesis hash, the fee payer is always the session wallet,
// each setup step's preconditions (step 1 needs the upgrade authority, step 2 needs step 1 and a real 2-of-3 Squads multisig,
// steps 3-7 come after the hand-over, step 7 is the dev wallet's), recording only what landed and was paid by this wallet, and
// the approval candidates (a SOL pair, a name of at most 32 bytes, the city ticker, a live seat whose wallet is the founder's,
// nothing on chain yet). Every transaction here is only built and simulated; solana/tests-launchpad/17 runs them for real.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { _resetLpKit, GENESIS } from "../src/lpkit.js";
import { _resetLpAdmin, configDiff, decodeApproval, nameProblem } from "../src/lpadmin.js";
import { base58Decode, base58Encode } from "../src/solana.js";
import { concat, u32le, u64le } from "../src/sol/bytes.js";
import { decodeHeader } from "../src/sol/message.js";
import { LAYOUT } from "../src/sol/layout.js";
import { ADDRESSES, PROGRAM_IDS, ata, launchpad as launchpadPdas, programDataAddress } from "../src/sol/pda.js";
import { DBC_PROGRAM_SHA256, EXPECTED_POOL_CONFIG } from "../src/sol/dbc-config-data.js";
import * as IX from "../src/sol/lpadmin-ix.js";
import { advance, browser, clock, newWorld, person, realClock, useClock } from "./helpers/world.js";
import { seedCoin, seedSeat } from "./helpers/launchpad.js";
import { addr, meteoraAsTested } from "./helpers/lpchain.js";

const VECTORS = JSON.parse(readFileSync(new URL("./fixtures/squads/vectors.json", import.meta.url), "utf8"));
// The live mainnet price curve EZVHCg… as read from the chain: made on 12 Oct 2026 with DBC 0.2.1, so PoolConfig.version 0.
const LIVE_CONFIG = JSON.parse(readFileSync(new URL("./fixtures/launchpad-worker/mainnet-pool-config.json", import.meta.url), "utf8")).accounts.EZVHCgxKZhvXmUGMXJMEw8tZHiTmoHPyM9mNNQ5u1kSP;
const PROGRAM = "Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7", REWARDS = "Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi";
const LP_ON = { LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_PROGRAM_ID: PROGRAM, LAUNCHPAD_REWARDS_PROGRAM_ID: REWARDS, LAUNCHPAD_RPC_URL: "https://lp-rpc.test/devnet" };
const DEV = ADDRESSES.feeRecipient, LOADER = PROGRAM_IDS.upgradeableLoader, SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const wranglerVars = () => JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "")).vars;
// The live settings without the three City-coins setup settings (production before PR-1, or any deploy that drops them):
// everything must stay dark there. The live settings themselves (setup on, trading off) are pinned in lpkit.test.js.
const darkVars = () => { const v = wranglerVars(); for (const k of ["LAUNCHPAD_CLUSTER", "LAUNCHPAD_PROGRAM_ID", "LAUNCHPAD_REWARDS_PROGRAM_ID", "LAUNCHPAD_DBC_CONFIGS", "LAUNCHPAD_LOOKUP_TABLE", "LAUNCHPAD_TRADING"]) delete v[k]; return v; };
const b64 = (u8) => Buffer.from(u8).toString("base64");

/* ---------------------------------------------------------------- accounts as the programs write them */
function layoutAccount(name, values) {
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
const programAccount = (programData) => ({ owner: LOADER, executable: true, data: b64(concat([u32le(2), base58Decode(programData)])) });
const programDataAccount = (authority, elf = new Uint8Array(64).fill(7), slot = 1234) => ({ owner: LOADER, data: b64(concat([u32le(3), u64le(BigInt(slot)), authority ? Uint8Array.of(1) : Uint8Array.of(0), authority ? base58Decode(authority) : new Uint8Array(32), elf])) });
const registryAccount = (admin) => ({ owner: REWARDS, data: b64(concat([Uint8Array.of(47, 174, 110, 246, 184, 182, 252, 218), base58Decode(admin), new Uint8Array(32), Uint8Array.of(255)])) });
const tokenAccount = (mint, owner, amount = 0n, program = PROGRAM_IDS.token) => ({ owner: program, data: b64(concat([base58Decode(mint), base58Decode(owner), u64le(amount), new Uint8Array(36), Uint8Array.of(1), new Uint8Array(12), u64le(0), new Uint8Array(36)])) });
function tableAccount(authority, addresses) {
  const head = new Uint8Array(56);
  head.set(u32le(1), 0); head.set(u64le((1n << 64n) - 1n), 4);
  head[21] = 1; head.set(base58Decode(authority), 22);
  return { owner: PROGRAM_IDS.lookupTable, data: b64(concat([head, ...addresses.map((a) => base58Decode(a))])) };
}
function approvalAccount({ cityId, founder, dbcConfig, rentPayer, name, symbol, expiresAt }) {
  const enc = new TextEncoder();
  const str = (s) => concat([u32le(enc.encode(s).length), enc.encode(s)]);
  const body = concat([Uint8Array.of(233, 9, 153, 49, 11, 222, 59, 130), u64le(cityId), base58Decode(founder), base58Decode(dbcConfig), base58Decode(rentPayer), str(name), str(symbol), u64le(1), u64le(expiresAt), Uint8Array.of(254)]);
  const out = new Uint8Array(179); out.set(body);
  return { owner: PROGRAM, data: b64(out) };
}

/* ---------------------------------------------------------------- a fake launchpad RPC */
function fakeChain({ genesis = GENESIS.devnet, accounts = {} } = {}) {
  const S = { genesis, accounts: { ...accounts }, log: [], landed: {}, simErr: null, delta: {}, slot: 5_000 };
  const acc = (k, slice) => {
    const a = S.accounts[k];
    if (!a) return null;
    let data = Buffer.from(a.data, "base64");
    const space = data.length; // the whole account, whatever the slice (as the real RPC answers)
    if (slice) data = data.subarray(slice.offset, slice.offset + slice.length);
    return { owner: a.owner, lamports: a.lamports ?? 2_000_000, data: [data.toString("base64"), "base64"], executable: Boolean(a.executable), rentEpoch: 0, space };
  };
  const one = ({ method, params }) => {
    switch (method) {
      case "getGenesisHash": return S.genesis;
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
      case "getTokenAccountsByOwner": return { context: { slot: 1 }, value: [] };
      case "getSlot": return S.slot;
      case "getMinimumBalanceForRentExemption": if (S.rentDown) throw new Error("down"); return (128 + params[0]) * 5_080; // mainnet's rate since 2026
      case "getBlocks": return [S.slot - 10];
      case "simulateTransaction": {
        const watched = params[1].accounts ? params[1].accounts.addresses : [];
        return { context: { slot: 1 }, value: { err: S.simErr, logs: ["Program log: ok"], unitsConsumed: 30_000, accounts: watched.map((k) => ({ lamports: (S.accounts[k] ? S.accounts[k].lamports ?? 2_000_000 : 0) + (S.delta[k] ?? -5_000), owner: "11111111111111111111111111111111", data: ["", "base64"] })) } };
      }
      case "getSignatureStatuses": return { context: { slot: 1 }, value: params[0].map((s) => (S.landed[s] ? { slot: 1, confirmations: null, err: S.landed[s].err || null, confirmationStatus: S.landed[s].status || "confirmed" } : null)) };
      case "getTransaction": { const l = S.landed[params[0]]; return l ? { slot: 1, transaction: { message: { accountKeys: l.keys } }, meta: { err: l.err || null } } : null; }
      default: throw new Error("unexpected " + method);
    }
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    S.log.push({ method: body.method, params: body.params });
    let result;
    try { result = one(body); } catch (e) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: String(e.message) } })); }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  return { S, fetchImpl, calls: (m) => S.log.filter((l) => l.method === m) };
}

/**
 * The owner signed in (ADMIN_WALLETS), both programs deployed with `authority` (default: the owner's wallet) as upgrade authority,
 * Meteora's two programs as the builds the team tested (test/helpers/lpchain.js meteoraAsTested), and `extra` accounts.
 * `call(path, body?)` adds the cluster echo unless `cluster` is given.
 */
async function world({ authority = "owner", extra = {}, env: envExtra = {}, genesis } = {}) {
  const env = { ...newWorld(), ...LP_ON, ...envExtra };
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  const auth = authority === "owner" ? owner.w.address : authority;
  const [pdLp, pdRw] = await Promise.all([programDataAddress(PROGRAM), programDataAddress(REWARDS)]);
  const chain = fakeChain({ genesis, accounts: { [PROGRAM]: programAccount(pdLp), [REWARDS]: programAccount(pdRw), [pdLp]: programDataAccount(auth), [pdRw]: programDataAccount(auth), ...extra } });
  const meteora = await meteoraAsTested(chain.S.accounts);
  const call = async (path, body, { who = owner, cluster = "devnet", origin } = {}) => {
    const sep = path.includes("?") ? "&" : "?";
    const url = body === undefined && cluster !== null ? `${path}${sep}cluster=${cluster}` : path;
    const r = await who.send(url, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : { ...(cluster !== null ? { cluster } : {}), ...body }, fetchImpl: chain.fetchImpl, ...(origin !== undefined ? { origin } : {}) });
    return { status: r.status, data: await r.json() };
  };
  return { env, owner, chain, call, pdLp, pdRw, wallet: owner.w.address, meteora };
}
/** What the City coins card sends with "Approve on chain": the city and the design it showed. */
const seenOf = (c) => ({ cityId: c.cityId, name: c.name, symbol: c.symbol, founder: c.founder, designAt: c.designAt });
const stepOf = async (w, id) => (await w.call("/api/admin/lp/status")).data.steps.find((s) => s.id === id);
/** The chain after steps 1 and 2: launchpad and registry started by `admin`, both programs under a Squads vault (recorded). */
async function afterHandoff(w) {
  const L = launchpadPdas(PROGRAM);
  const ms = VECTORS.synthetic[0];
  Object.assign(w.chain.S.accounts, {
    [await L.launchpad()]: { owner: PROGRAM, data: b64(layoutAccount("Launchpad", { admin: w.wallet, rewards_program: REWARDS })) },
    [await IX.rewards(REWARDS).registry()]: registryAccount(w.wallet),
    [ms.address]: { owner: SQUADS, data: ms.data },
    [w.pdLp]: programDataAccount(ms.expected.vaults[0]), [w.pdRw]: programDataAccount(ms.expected.vaults[0]),
  });
  const now = new Date().toISOString();
  const { ensureLpAdminSchema } = await import("../src/lpadmin.js");
  await ensureLpAdminSchema(w.env.DB);
  for (const [step, address] of [["squads", ms.address], ["handoff", ms.expected.vaults[0]]]) {
    await w.env.DB.prepare("INSERT INTO lp_setup (cluster, program_id, step, address, signature, by_wallet, at) VALUES ('devnet', ?, ?, ?, NULL, ?, ?)").bind(PROGRAM, step, address, w.wallet, now).run();
  }
  return ms;
}
/**
 * Step 3 compares Meteora's bonding-curve program with the build the expected curve bytes came from (DBC_PROGRAM_SHA256), which
 * made-up bytes can never hash to; so in test `t` the test world's stand-in (test/helpers/lpchain.js meteoraAsTested: 4096 bytes of
 * 0x11) stands for it: its SHA-256 is answered as DBC_PROGRAM_SHA256 (every other hash is the real one). Before world().
 * Returns the real SHA-256 (hex) of some bytes.
 */
function asCurveBuild(t) {
  const digest = SubtleCrypto.prototype.digest;
  t.mock.method(crypto.subtle, "digest", async function (alg, data) {
    const b = new Uint8Array(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    return b.length === 4096 && b.every((x) => x === 0x11) ? Uint8Array.from(Buffer.from(DBC_PROGRAM_SHA256, "hex")).buffer : digest.call(crypto.subtle, alg, data);
  });
  return async (bytes) => Buffer.from(await digest.call(crypto.subtle, "SHA-256", bytes)).toString("hex");
}
const UNCHECKED_CURVE = "Meteora's bonding-curve program could not be read, so its fingerprint is unknown and this step waits (a price curve is made only on the build the team checked). Nothing was spent; try again in a minute.";
const built = (w, from) => w.chain.S.log.slice(from).filter((l) => l.method === "simulateTransaction").length;

beforeEach(() => { _resetLpKit(); _resetLpAdmin(); realClock(); });

test("dark: with production-like settings every City coins route answers 404 not_enabled and reads nothing", async () => {
  const env = { ...newWorld(), ...darkVars() };
  const owner = await person(env);
  env.ADMIN_WALLETS = owner.w.address;
  const chain = fakeChain();
  for (const [path, method] of [["/api/admin/lp", "GET"], ["/api/admin/lp/status?cluster=mainnet", "GET"], ["/api/admin/lp/candidates", "GET"], ["/api/admin/lp/squads?address=x", "GET"],
    ["/api/admin/lp/tx", "POST"], ["/api/admin/lp/record", "POST"], ["/api/admin/lp/approve/tx", "POST"], ["/api/admin/lp/platform/tx", "POST"]]) {
    const r = await owner.send(path, { method, body: method === "POST" ? { cluster: "mainnet" } : undefined, fetchImpl: chain.fetchImpl });
    assert.deepEqual([r.status, (await r.json()).error], [404, "not_enabled"], path);
  }
  assert.equal(chain.S.log.length, 0);
  assert.equal(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'lp_setup'").first(), null, "no table made while dark");
});

test("the owner only: an admin or a moderator gets 403, signed out 401; a stale proof gets reprove; reading needs no fresh proof", async () => {
  useClock();
  const w = await world();
  const grant = async (role) => { const p = await person(w.env); await w.env.DB.prepare("INSERT INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, ?, 'x', ?)").bind(p.w.address, role, new Date(clock.now).toISOString()).run(); return p; };
  const admin = await grant("admin"), mod = await grant("moderator");
  for (const who of [admin, mod]) {
    assert.deepEqual((await w.call("/api/admin/lp/status", undefined, { who })).data, { ok: false, error: "forbidden", need: "owner" });
    assert.equal((await w.call("/api/admin/lp/tx", { step: "start" }, { who })).data.error, "forbidden");
  }
  assert.equal((await w.call("/api/admin/lp/status", undefined, { who: browser(w.env) })).data.error, "sign_in");
  assert.deepEqual((await w.call("/api/admin/lp")).data, { ok: true, on: true, cluster: "devnet", programId: PROGRAM, rewardsProgramId: REWARDS, wallet: w.wallet, isDevWallet: false, configsSet: false });
  assert.equal((await w.call("/api/admin/lp/tx", { step: "start" }, { origin: "https://evil.example" })).data.error, "wrong_origin");
  advance(31 * 60_000);
  assert.deepEqual((await w.call("/api/admin/lp/tx", { step: "start" })).data, { ok: false, error: "reprove" });
  assert.equal((await w.call("/api/admin/lp/status")).data.ok, true, "a read works without a fresh proof");
  realClock();
});

test("the cluster echo and the genesis hash: another cluster is refused before anything is read or built", async () => {
  const w = await world();
  for (const c of [null, "mainnet", "testnet"]) {
    const g = await w.call("/api/admin/lp/status", undefined, { cluster: c });
    assert.deepEqual([g.status, g.data.error], [409, "cluster_mismatch"], `GET with ${c}`);
    const p = await w.call("/api/admin/lp/tx", { step: "start", ...(c ? { cluster: c } : {}) }, { cluster: null });
    assert.deepEqual([p.status, p.data.error], [409, "cluster_mismatch"], `POST with ${c}`);
  }
  assert.equal(w.chain.S.log.length, 0);
  // the settings say mainnet but the node is devnet: nothing is built
  const m = await world({ env: { LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: addr(61), LAUNCHPAD_REWARDS_PROGRAM_ID: addr(62) } });
  const r = await m.call("/api/admin/lp/status", undefined, { cluster: "mainnet" });
  assert.deepEqual([r.status, r.data.error], [503, "wrong_cluster"]);
  assert.deepEqual(m.chain.S.log.map((l) => l.method), ["getGenesisHash"]);
});

test("step 1: refused unless both upgrade authorities are the session wallet; the payer is always the session wallet", async () => {
  const other = addr(71);
  const w = await world({ authority: other });
  let s = await w.call("/api/admin/lp/status");
  assert.equal(s.data.steps[0].state, "blocked");
  assert.match(s.data.steps[0].reason, new RegExp(`upgrade authority is ${other}, not the wallet you are signed in with`));
  assert.equal((await w.call("/api/admin/lp/tx", { step: "start" })).data.error, "step_not_ready");
  // a program deployed with the old loader, or missing, or final
  w.chain.S.accounts[PROGRAM] = { owner: "BPFLoader2111111111111111111111111111111111", executable: true, data: b64(new Uint8Array(8)) };
  assert.match((await stepOf(w, "start")).reason, /not deployed with the upgradeable loader/);
  delete w.chain.S.accounts[REWARDS];
  assert.match((await stepOf(w, "start")).reason, /rewards program is not on Solana devnet/);

  const ok = await world();
  s = await ok.call("/api/admin/lp/status");
  assert.equal(s.data.steps[0].state, "ready", s.data.steps[0].reason);
  assert.deepEqual(s.data.steps.slice(1).map((x) => x.state), ["blocked", "blocked", "blocked", "blocked", "blocked", "blocked"], "nothing else before step 1");
  assert.match(s.data.steps[1].reason, /Do step 1 first/);
  // whatever the body says, the payer is the session wallet
  const b = await ok.call("/api/admin/lp/tx", { step: "start", payer: other, wallet: other, params: { payer: other } });
  assert.equal(b.data.ok, true, JSON.stringify(b.data));
  const d = decodeHeader(Buffer.from(b.data.tx, "base64"));
  assert.deepEqual([d.staticKeys[0], d.header.numRequiredSignatures, b.data.signers], [ok.wallet, 1, [ok.wallet]]);
  assert.deepEqual(b.data.summary.filter((x) => x.programName.startsWith("Vicinity")).map((x) => x.ix), ["init_registry", "init_launchpad"]);
  assert.deepEqual(b.data.record, { step: "start", params: {} });
  assert.ok(b.data.solChange[ok.wallet] < 0);
  // the program data's SHA-256 and size (what `solana program dump` + shasum give)
  const elf = new Uint8Array(64).fill(7);
  assert.equal(s.data.programs.launchpad.sha256, Buffer.from(await crypto.subtle.digest("SHA-256", elf)).toString("hex"));
  assert.equal(s.data.programs.launchpad.size, 64);
  // half done: a registry that exists is skipped
  ok.chain.S.accounts[await IX.rewards(REWARDS).registry()] = registryAccount(ok.wallet);
  const half = await ok.call("/api/admin/lp/tx", { step: "start" });
  assert.deepEqual(half.data.summary.filter((x) => x.programName.startsWith("Vicinity")).map((x) => x.ix), ["init_launchpad"]);
  // a failed simulation is reported with the program's error, nothing to sign
  ok.chain.S.simErr = { InstructionError: [1, { Custom: 6001 }] };
  const bad = await ok.call("/api/admin/lp/tx", { step: "start" });
  assert.equal(bad.status, 409);
  assert.equal(bad.data.tx, undefined);
});

test("step 2: only a 2-of-3 Squads multisig, checked again at build time; a pasted vault, a wallet or another account is refused", async () => {
  const w = await world();
  const [good, oneOfTwo, controlled, padded, fewVoters] = VECTORS.synthetic;
  const L = launchpadPdas(PROGRAM);
  Object.assign(w.chain.S.accounts, {
    [await L.launchpad()]: { owner: PROGRAM, data: b64(layoutAccount("Launchpad", { admin: w.wallet, rewards_program: REWARDS })) },
    [await IX.rewards(REWARDS).registry()]: registryAccount(w.wallet),
    [good.address]: { owner: SQUADS, data: good.data }, [oneOfTwo.address]: { owner: SQUADS, data: oneOfTwo.data }, [controlled.address]: { owner: SQUADS, data: controlled.data },
    [padded.address]: { owner: SQUADS, data: padded.data }, [fewVoters.address]: { owner: SQUADS, data: fewVoters.data },
    [good.expected.vaults[0]]: { owner: "11111111111111111111111111111111", data: "" },
    [addr(80)]: { owner: SQUADS, data: b64(new Uint8Array(200)) },
  });
  assert.equal((await stepOf(w, "handoff")).state, "ready");
  const sq = async (a) => (await w.call(`/api/admin/lp/squads?address=${a}`)).data;
  const ok = await sq(good.address);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.vault, good.expected.vaults[0]);
  assert.equal(ok.says, `2 of 3: ${good.expected.members.map((m) => m.key).join(", ")}; vault ${good.expected.vaults[0]}`);
  assert.equal(ok.alreadyHandedOver, false);
  assert.equal((await sq(padded.address)).ok, true, "an account allocated larger than its members need");
  assert.equal((await sq(good.expected.vaults[0])).error, "not_multisig");
  assert.match((await sq(good.expected.vaults[0])).message, /wallet or a Squads vault, not the multisig account/);
  assert.equal((await sq(w.wallet)).error, "not_found");
  assert.equal((await sq(PROGRAM)).error, "not_multisig", "another program's account");
  assert.equal((await sq(addr(80))).error, "not_multisig", "a Squads account that is not a multisig");
  assert.equal((await sq(oneOfTwo.address)).error, "threshold_too_low");
  assert.equal((await sq(controlled.address)).error, "controlled");
  assert.equal((await sq(fewVoters.address)).error, "too_few_voters");
  assert.equal((await sq("not-an-address")).error, "bad_address");
  const tx = (params) => w.call("/api/admin/lp/tx", { step: "handoff", params });
  assert.equal((await tx({ multisig: good.address, vault: addr(1) })).data.error, "vault_mismatch", "the vault the page showed must be the derived one");
  assert.equal((await tx({ multisig: good.expected.vaults[0], vault: good.expected.vaults[0] })).data.error, "not_multisig");
  assert.equal((await tx({ multisig: oneOfTwo.address, vault: oneOfTwo.expected.vaults[0] })).data.error, "threshold_too_low");
  const b = await tx({ multisig: good.address, vault: ok.vault });
  assert.equal(b.data.ok, true, JSON.stringify(b.data));
  const sets = b.data.summary.filter((x) => x.ix === "set_authority");
  assert.deepEqual(sets.map((x) => x.accounts[0].address), [w.pdLp, w.pdRw]);
  assert.deepEqual(sets.map((x) => x.accounts.map((a) => a.role)), [["writable", "signer", "read-only"], ["writable", "signer", "read-only"]]);
  assert.ok(sets.every((x) => x.accounts[2].address === ok.vault));
  assert.deepEqual(b.data.record, { step: "handoff", params: { multisig: good.address } });
  // the hand-over landed: recording needs the transaction confirmed, paid by this wallet and naming the vault
  const sig = base58Encode(new Uint8Array(64).fill(9));
  const rec = (signature, params = { multisig: good.address }) => w.call("/api/admin/lp/record", { step: "handoff", signature, params });
  assert.equal((await rec(sig)).data.error, "not_confirmed");
  w.chain.S.landed[sig] = { keys: [addr(5), ok.vault] };
  Object.assign(w.chain.S.accounts, { [w.pdLp]: programDataAccount(ok.vault), [w.pdRw]: programDataAccount(ok.vault) });
  assert.equal((await rec(sig)).data.error, "not_yours");
  w.chain.S.landed[sig] = { keys: [w.wallet, ok.vault], err: { InstructionError: [0, "x"] } };
  assert.equal((await rec(sig)).data.error, "failed");
  w.chain.S.landed[sig] = { keys: [w.wallet, ok.vault] };
  assert.equal((await rec(sig)).data.ok, true);
  const st = (await w.call("/api/admin/lp/status")).data;
  assert.equal(st.steps[1].state, "done");
  assert.deepEqual(st.squads, { multisig: good.address, vault: ok.vault, threshold: 2, members: 3 });
  assert.equal((await w.call("/api/admin/lp/tx", { step: "start" })).data.error, "already_done");
  const audit = await w.env.DB.prepare("SELECT action, detail FROM admin_audit WHERE action LIKE 'lp/%'").all();
  assert.deepEqual(audit.results.map((r) => r.action), ["lp/handoff"]);
});

test("step 2 recorded from the chain: programs already under the vault are adopted without a transaction", async () => {
  const w = await world();
  const ms = VECTORS.synthetic[0];
  const L = launchpadPdas(PROGRAM);
  Object.assign(w.chain.S.accounts, {
    [await L.launchpad()]: { owner: PROGRAM, data: b64(layoutAccount("Launchpad", { admin: w.wallet, rewards_program: REWARDS })) },
    [await IX.rewards(REWARDS).registry()]: registryAccount(w.wallet), [ms.address]: { owner: SQUADS, data: ms.data },
    [w.pdLp]: programDataAccount(ms.expected.vaults[0]), [w.pdRw]: programDataAccount(ms.expected.vaults[0]),
  });
  const s2 = await stepOf(w, "handoff");
  assert.deepEqual([s2.state, s2.adoptable], ["blocked", true]);
  assert.equal((await w.call(`/api/admin/lp/squads?address=${ms.address}`)).data.alreadyHandedOver, true);
  assert.equal((await w.call("/api/admin/lp/record", { step: "handoff", signature: null, params: { multisig: VECTORS.synthetic[3].address } })).data.error, "not_found");
  assert.equal((await w.call("/api/admin/lp/record", { step: "handoff", signature: null, params: { multisig: ms.address } })).data.ok, true);
  assert.equal((await stepOf(w, "handoff")).state, "done");
  // adopting is for the hand-over only: every other step needs its transaction
  assert.equal((await w.call("/api/admin/lp/record", { step: "config", signature: null, params: {} })).data.error, "bad_signature");
});

test("steps 3-7 come after the hand-over; the price curve is a one-time key and must equal the defaults; step 7 is the dev wallet's", async (t) => {
  asCurveBuild(t); // Meteora's bonding-curve program is the build the expected curve bytes came from
  const w = await world();
  const L = launchpadPdas(PROGRAM);
  Object.assign(w.chain.S.accounts, {
    [await L.launchpad()]: { owner: PROGRAM, data: b64(layoutAccount("Launchpad", { admin: w.wallet, rewards_program: REWARDS })) },
    [await IX.rewards(REWARDS).registry()]: registryAccount(w.wallet),
  });
  let st = (await w.call("/api/admin/lp/status")).data;
  assert.deepEqual(st.steps.map((x) => x.state), ["done", "ready", "blocked", "blocked", "blocked", "blocked", "blocked"]);
  for (const id of ["config", "allow", "referral", "lookup"]) assert.match(st.steps.find((x) => x.id === id).reason, /Do step [23] first/);
  assert.match(st.steps[6].reason, new RegExp(`Only the dev wallet ${DEV}`));
  await afterHandoff(w);
  st = (await w.call("/api/admin/lp/status")).data;
  assert.deepEqual(st.steps.map((x) => x.state), ["done", "done", "ready", "blocked", "ready", "blocked", "blocked"]);
  assert.match(st.steps[5].reason, /Do step 3 first: the speed table holds the price curve/);
  // the rent named in each ready step is the cluster's own (5,080 lamports per byte now, not the old 6,960)
  assert.match(st.steps[2].reason, /about 0\.00597408 SOL of rent\)/);
  assert.match(st.steps[4].reason, /about 0\.00148844 SOL of rent, which anyone may pay\)/);
  _resetLpAdmin(); w.chain.S.rentDown = true; // (asCurveBuild still makes the world's DBC the build the curve bytes came from)
  assert.match((await stepOf(w, "config")).reason, /\(a little rent\)/, "no number rather than a wrong one");
  w.chain.S.rentDown = false;
  // 3: exactly one fresh one-time key
  const k = addr(91);
  assert.equal((await w.call("/api/admin/lp/tx", { step: "config" })).data.error, "bad_signers");
  assert.equal((await w.call("/api/admin/lp/tx", { step: "config", ephemeral: [k, addr(92)] })).data.error, "bad_signers");
  w.chain.S.accounts[addr(93)] = { owner: "11111111111111111111111111111111", data: "" };
  assert.equal((await w.call("/api/admin/lp/tx", { step: "config", ephemeral: [addr(93)] })).data.error, "bad_signers", "a key that is not fresh");
  const b = await w.call("/api/admin/lp/tx", { step: "config", ephemeral: [k] });
  assert.equal(b.data.ok, true, JSON.stringify(b.data));
  assert.deepEqual(b.data.signers, [w.wallet, k]);
  assert.deepEqual(b.data.record, { step: "config", params: { address: k } });
  // recorded only once it is on chain and equal to the defaults
  const sig = base58Encode(new Uint8Array(64).fill(3));
  w.chain.S.landed[sig] = { keys: [w.wallet, k] };
  assert.equal((await w.call("/api/admin/lp/record", { step: "config", signature: sig, params: { address: k } })).data.error, "config_differs");
  const changed = Buffer.from(EXPECTED_POOL_CONFIG, "base64");
  changed.writeBigUInt64LE(1_000_000_000n, LAYOUT.PoolConfig.fields.migration_quote_threshold.at);
  w.chain.S.accounts[k] = { owner: PROGRAM_IDS.dbc, data: changed.toString("base64") };
  const differs = (await w.call("/api/admin/lp/record", { step: "config", signature: sig, params: { address: k } })).data;
  assert.equal(differs.error, "config_differs");
  assert.match(differs.message, /migration_quote_threshold/);
  w.chain.S.accounts[k] = { owner: PROGRAM_IDS.dbc, data: EXPECTED_POOL_CONFIG };
  assert.equal((await w.call("/api/admin/lp/record", { step: "config", signature: sig, params: { address: addr(94) } })).data.error, "wrong_transaction");
  assert.equal((await w.call("/api/admin/lp/record", { step: "config", signature: sig, params: { address: k } })).data.ok, true);
  st = (await w.call("/api/admin/lp/status")).data;
  assert.equal(st.steps[2].state, "done");
  assert.deepEqual(st.config.diff, []);
  assert.equal(st.steps[3].state, "ready");
  // 4 waits while Meteora's programs cannot be read clearly: the page says so, and the build (which reads them for itself) refuses
  const damm = w.chain.S.accounts[w.meteora.pdDamm];
  delete w.chain.S.accounts[w.meteora.pdDamm];
  _resetLpAdmin(); // the pages' ten-minute answer
  const s4 = (await stepOf(w, "allow"));
  assert.equal(s4.state, "blocked");
  assert.match(s4.reason, /^Meteora's programs could not be checked against the builds the team tested just now, so nothing was built\. This step and approvals wait/);
  const a4 = await w.call("/api/admin/lp/tx", { step: "allow" });
  assert.deepEqual([a4.status, a4.data.error, a4.data.which, a4.data.step], [503, "program_check_unavailable", [], "allow"]);
  w.chain.S.accounts[w.meteora.pdDamm] = damm;
  // 4 needs the launchpad admin
  w.chain.S.accounts[await L.launchpad()] = { owner: PROGRAM, data: b64(layoutAccount("Launchpad", { admin: addr(95), rewards_program: REWARDS })) };
  st = (await w.call("/api/admin/lp/status")).data;
  assert.equal(st.steps[3].state, "blocked");
  assert.ok(st.problems.some((p) => /launchpad admin is .*not the wallet you are signed in with/.test(p)));
  w.chain.S.accounts[await L.launchpad()] = { owner: PROGRAM, data: b64(layoutAccount("Launchpad", { admin: w.wallet, rewards_program: addr(96) })) };
  assert.ok((await w.call("/api/admin/lp/status")).data.problems.some((p) => /started with the rewards program/.test(p)), "a launchpad started with another rewards program");
  // 6: a new speed table holds the shared addresses; 5 on devnet is the SOL account only. Only steps 3 and 4 read Meteora's programs
  // for their build: the others keep the pages' answer (no read of the deploy slots here)
  const heads = () => w.chain.S.log.filter((x) => x.method === "getMultipleAccounts" && x.params[0].includes(w.meteora.pdDbc) && x.params[1] && x.params[1].dataSlice).length;
  const h0 = heads();
  const t6 = await w.call("/api/admin/lp/tx", { step: "lookup" });
  assert.equal(t6.data.ok, true, JSON.stringify(t6.data));
  assert.equal(heads(), h0, "step 6's build did not read Meteora's programs");
  assert.deepEqual(t6.data.summary.filter((x) => x.program === PROGRAM_IDS.lookupTable).map((x) => x.ix), ["create_lookup_table", "extend_lookup_table", "extend_lookup_table"]);
  const table = (await IX.lookupTableAddress(w.wallet, 4990))[0];
  assert.deepEqual(t6.data.record, { step: "lookup", params: { address: table } });
  const want = await IX.lookupTableAddresses({ programId: PROGRAM, rewardsProgramId: REWARDS, dbcConfigs: [k] });
  w.chain.S.accounts[table] = tableAccount(w.wallet, want.slice(0, 20));
  const sig6 = base58Encode(new Uint8Array(64).fill(6));
  w.chain.S.landed[sig6] = { keys: [w.wallet, table] };
  assert.equal((await w.call("/api/admin/lp/record", { step: "lookup", signature: sig6, params: { address: table } })).data.ok, true);
  const s6 = await stepOf(w, "lookup");
  assert.equal(s6.state, "ready");
  assert.match(s6.reason, /Adds the 1 missing address/);
  const ext = await w.call("/api/admin/lp/tx", { step: "lookup" });
  assert.deepEqual(ext.data.summary.filter((x) => x.program === PROGRAM_IDS.lookupTable).map((x) => x.ix), ["extend_lookup_table"]);
  w.chain.S.accounts[table] = tableAccount(w.wallet, want);
  assert.equal((await stepOf(w, "lookup")).state, "done");
  const r5 = await w.call("/api/admin/lp/tx", { step: "referral" });
  assert.deepEqual(r5.data.summary.filter((x) => x.ix === "create_idempotent").map((x) => x.accounts[1].address), [await ata(DEV, ADDRESSES.wsol)]);
  // 7: only the dev wallet
  assert.equal((await w.call("/api/admin/lp/tx", { step: "partner" })).data.error, "step_not_ready");
});

test("step 3 waits when Meteora's bonding-curve program is not the build the team pinned: nothing is spent on a price curve that would be refused (devnet rehearsal)", async (t) => {
  asCurveBuild(t); // the world's stand-in DBC is the build the expected curve bytes came from (for the record step at the end)
  const w = await world();
  await afterHandoff(w);
  const pdDbc = await programDataAddress(PROGRAM_IDS.dbc);
  // Meteora's program as some newer build than the one pinned for this cluster (src/programpins.js; here the test world's stand-in
  // build, deployed at a later slot, as every upgrade is): on devnet the newer build wrote PoolConfig.version 1, and the curve it made
  // was refused at record time
  w.chain.S.accounts[pdDbc] = programDataAccount("JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd", new Uint8Array(4096).fill(9), 5678);
  const st = (await w.call("/api/admin/lp/status")).data;
  const s3 = st.steps.find((x) => x.id === "config");
  assert.equal(s3.state, "blocked");
  assert.match(s3.reason, /^Meteora has updated its bonding-curve program since the team checked it \(its fingerprint is now [0-9a-f]{12}…, the checked one e2bfc853c1a1…\)\. A price curve made now may differ from the tested one, so this step waits\. Nothing was spent; tell the team/);
  assert.deepEqual([st.meteora.state, st.meteora.which], ["changed", ["dbc"]], "the standing line says the same");
  const b = await w.call("/api/admin/lp/tx", { step: "config", ephemeral: [addr(91)] });
  assert.deepEqual([b.status, b.data.error, b.data.which, b.data.step], [409, "program_changed", ["dbc"], "config"], "the step is not even built");
  assert.equal(b.data.message, s3.reason, "the page and the build say the same");
  // the whole program was read for its fingerprint, once, together with DAMM v2's (src/programpins.js: one getMultipleAccounts; the
  // build read the deploy slot again and knew those bytes)
  const reads = () => w.chain.S.log.filter((x) => x.method === "getMultipleAccounts" && x.params[0].includes(pdDbc) && !(x.params[1] && x.params[1].dataSlice)).length;
  assert.equal(reads(), 1);
  // once a price curve exists (here: from the settings) step 3 is what the curve says; Meteora's program is not read again within those minutes
  const cfg = addr(95);
  w.chain.S.accounts[cfg] = { owner: PROGRAM_IDS.dbc, data: EXPECTED_POOL_CONFIG };
  w.env.LAUNCHPAD_DBC_CONFIGS = cfg;
  const before = reads();
  const st2 = (await w.call("/api/admin/lp/status")).data;
  assert.equal(st2.steps.find((x) => x.id === "config").state, "done");
  // the sentence's figures are the config's own (decoded from its bytes, the fee through src/fees.js), not literals
  assert.equal(st2.steps.find((x) => x.id === "config").reason, `The price curve ${cfg} matches Vicinity's defaults (85 SOL target, 1.25% fee, 0.05 SOL launch fee, fees to 13qR…sRiN).`);
  assert.equal(reads(), before);
  // Meteora's program unreadable (no such account, or the node did not answer): the step waits as well, it never goes ahead blind
  delete w.env.LAUNCHPAD_DBC_CONFIGS; delete w.chain.S.accounts[pdDbc];
  _resetLpAdmin(); // the pages' ten-minute memory of the check
  const s3u = (await w.call("/api/admin/lp/status")).data.steps.find((x) => x.id === "config");
  assert.equal(s3u.state, "blocked");
  assert.match(s3u.reason, /^Meteora's bonding-curve program could not be read, so its fingerprint is unknown and this step waits \(a price curve is made only on the build the team checked\)\. Nothing was spent/);
  assert.equal(s3u.reason, UNCHECKED_CURVE);
  const u = await w.call("/api/admin/lp/tx", { step: "config", ephemeral: [addr(91)] });
  assert.deepEqual([u.status, u.data.error, u.data.which, u.data.step, u.data.message], [503, "program_check_unavailable", [], "config", UNCHECKED_CURVE], "not built");
  // the record step checks the program too (read fresh, like the builds): the bytes (version 0 or 1) cannot tell a newer build that
  // writes the same account
  const k = addr(91), sig = base58Encode(new Uint8Array(64).fill(3));
  w.chain.S.landed[sig] = { keys: [w.wallet, k] };
  w.chain.S.accounts[k] = { owner: PROGRAM_IDS.dbc, data: EXPECTED_POOL_CONFIG };
  const rec = async () => (await w.call("/api/admin/lp/record", { step: "config", signature: sig, params: { address: k } })).data;
  let r = await rec();
  assert.deepEqual([r.error, r.message], ["dbc_unreadable", `Meteora's bonding-curve program could not be read, so the price curve ${k} was not recorded. Press Record again in a minute.`]);
  w.chain.S.accounts[pdDbc] = programDataAccount("JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd", new Uint8Array(4096).fill(9), 5678);
  r = await rec();
  assert.equal(r.error, "dbc_changed");
  assert.match(r.message, new RegExp(`^Meteora has updated its bonding-curve program since the team checked it \\(its fingerprint is now [0-9a-f]{12}…, the checked one e2bfc853c1a1…\\), so the price curve ${k} was not recorded\\.`));
  assert.equal((await stepOf(w, "config")).state, "blocked", "nothing recorded");
  // the record step reads the deploy slot itself, never the pages' ten-minute answer: the page saw the upgrade a moment ago, but
  // Meteora is back on the checked build now (a later deploy), and the record goes ahead at once
  w.chain.S.accounts[pdDbc] = programDataAccount("JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd", new Uint8Array(4096).fill(0x11), 9000);
  assert.equal((await rec()).ok, true);
  assert.equal((await stepOf(w, "config")).state, "done");
});

test("step 3 on a reading of Meteora's bonding-curve program that is not clear: 503 program_check_unavailable, never built (a node that lags behind an upgrade, the account missing, an RPC error on either read)", async (t) => {
  asCurveBuild(t);
  const w = await world();
  await afterHandoff(w);
  const pdDbc = w.meteora.pdDbc, tested = w.chain.S.accounts[pdDbc];
  const build = () => w.call("/api/admin/lp/tx", { step: "config", ephemeral: [addr(91)] });
  assert.equal((await build()).data.ok, true, "built while it is that build");
  // a node that answers some calls oddly: `hook(rpc body, init)` gives the answer to one call, or null for the chain's own
  const real = w.chain.fetchImpl;
  let hook = null;
  w.chain.fetchImpl = async (url, init) => (hook && hook(JSON.parse(init.body), init)) || real(url, init);
  const dbcRead = (b, sliced) => b.method === "getMultipleAccounts" && b.params[0].includes(pdDbc) && Boolean(b.params[1] && b.params[1].dataSlice) === sliced;
  const rpcError = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } }));
  /** the chain's answer had DBC's ProgramData been `account` (a node that has not seen the latest deploy) */
  const asIf = (account, init) => { w.chain.S.accounts[pdDbc] = account; const r = real(LP_ON.LAUNCHPAD_RPC_URL, init); w.chain.S.accounts[pdDbc] = UPGRADED; return r; };
  const UPGRADED = programDataAccount("JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd", new Uint8Array(4096).fill(9), 5678);
  const cases = {
    "the deploy slot says Meteora upgraded; the whole program comes from a node that still holds the tested build": () => {
      w.chain.S.accounts[pdDbc] = UPGRADED;
      hook = (b, init) => (dbcRead(b, false) ? asIf(tested, init) : null);
    },
    "DBC's ProgramData missing": () => { delete w.chain.S.accounts[pdDbc]; },
    "a JSON-RPC error on the deploy-slot read": () => { hook = (b) => (dbcRead(b, true) ? rpcError() : null); },
    "a JSON-RPC error on the whole-program read": () => { hook = (b) => (dbcRead(b, false) ? rpcError() : null); },
  };
  for (const [name, arm] of Object.entries(cases)) {
    _resetLpAdmin(); // nothing remembered: each case reads the program's bytes again
    w.chain.S.accounts[pdDbc] = tested; hook = null;
    arm();
    const before = w.chain.S.log.length;
    const r = await build();
    assert.deepEqual([r.status, r.data.error, r.data.which, r.data.step, r.data.message], [503, "program_check_unavailable", [], "config", UNCHECKED_CURVE], name);
    assert.equal(built(w, before), 0, `${name}: nothing built or simulated`);
  }
  w.chain.S.accounts[pdDbc] = tested; hook = null; _resetLpAdmin();
  assert.equal((await build()).data.ok, true, "built again once the reading is clear");
  // step 3 depends on DBC alone, by design (the curve is DBC's account): DAMM v2 unreadable does not hold it; step 4 and the
  // approvals, which need both programs, do wait (the "steps 3-7" test above)
  delete w.chain.S.accounts[w.meteora.pdDamm]; _resetLpAdmin();
  assert.equal((await build()).data.ok, true, "DAMM v2 missing: still built on a clear reading of DBC");
});

test("step 3's build reads Meteora's bonding-curve program again: offered on the page a minute ago, refused with 409 program_changed once Meteora upgraded since (never the page's ten-minute answer)", async (t) => {
  const sha = asCurveBuild(t);
  useClock("2026-10-20T12:00:00Z");
  const w = await world();
  await afterHandoff(w);
  const pdDbc = await programDataAddress(PROGRAM_IDS.dbc);
  const s3 = await stepOf(w, "config");
  assert.equal(s3.state, "ready", s3.reason);
  assert.equal((await w.call("/api/admin/lp/tx", { step: "config", ephemeral: [addr(91)] })).data.ok, true, "built while it is that build");
  // Meteora upgrades its bonding curve a minute later; the page still shows the step offered (its answer is kept ten minutes)...
  advance(60_000);
  const NEWER = new Uint8Array(4096).fill(9);
  w.chain.S.accounts[pdDbc] = programDataAccount("JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd", NEWER, 5678);
  assert.equal((await stepOf(w, "config")).state, "ready");
  // ...but the build reads the deploy slot again and refuses: no price curve from a build nobody tested
  const before = w.chain.S.log.length;
  const b = await w.call("/api/admin/lp/tx", { step: "config", ephemeral: [addr(91)] });
  assert.deepEqual([b.status, b.data.error, b.data.which, b.data.step], [409, "program_changed", ["dbc"], "config"], JSON.stringify(b.data));
  assert.equal(built(w, before), 0);
  const now = await sha(NEWER);
  assert.match(b.data.message, new RegExp(`^Meteora has updated its bonding-curve program since the team checked it \\(its fingerprint is now ${now.slice(0, 12)}…`));
  assert.equal((await stepOf(w, "config")).state, "blocked", "and the page shows what the build saw");
});

test("mainnet: step 5 makes the dev wallet's SOL and $VICINITY fee accounts", async () => {
  const VIC = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
  const pid = addr(61), rid = addr(62);
  const env = { LAUNCHPAD_CLUSTER: "mainnet", LAUNCHPAD_PROGRAM_ID: pid, LAUNCHPAD_REWARDS_PROGRAM_ID: rid, VICINITY_MINT: VIC };
  const w = await world({ env, genesis: GENESIS.mainnet });
  const [pdLp, pdRw] = await Promise.all([programDataAddress(pid), programDataAddress(rid)]);
  const L = launchpadPdas(pid);
  const ms = VECTORS.synthetic[0];
  Object.assign(w.chain.S.accounts, {
    [pid]: programAccount(pdLp), [rid]: programAccount(pdRw), [pdLp]: programDataAccount(ms.expected.vaults[0]), [pdRw]: programDataAccount(ms.expected.vaults[0]),
    [await L.launchpad()]: { owner: pid, data: b64(layoutAccount("Launchpad", { admin: w.wallet, rewards_program: rid })) },
    [await IX.rewards(rid).registry()]: { ...registryAccount(w.wallet), owner: rid },
    [VIC]: { owner: PROGRAM_IDS.token, data: b64(new Uint8Array(82)) },
  });
  const { ensureLpAdminSchema } = await import("../src/lpadmin.js");
  await ensureLpAdminSchema(w.env.DB);
  await w.env.DB.prepare("INSERT INTO lp_setup (cluster, program_id, step, address, signature, by_wallet, at) VALUES ('mainnet', ?, 'handoff', ?, NULL, ?, 'x')").bind(pid, ms.expected.vaults[0], w.wallet).run();
  const st = (await w.call("/api/admin/lp/status", undefined, { cluster: "mainnet" })).data;
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.deepEqual(st.referral.map((r) => [r.symbol, r.account, r.exists]), [["SOL", await ata(DEV, ADDRESSES.wsol), false], ["VICINITY", await ata(DEV, VIC), false]]);
  const b = await w.call("/api/admin/lp/tx", { step: "referral", cluster: "mainnet" }, { cluster: null });
  assert.equal(b.data.ok, true, JSON.stringify(b.data));
  assert.equal(b.data.cluster, "mainnet");
  assert.deepEqual(b.data.summary.filter((x) => x.ix === "create_idempotent").map((x) => x.accounts[1].address), [await ata(DEV, ADDRESSES.wsol), await ata(DEV, VIC)]);
});

test("approval candidates: SOL pair, name of at most 32 bytes, the ticker, a live seat whose wallet is the founder's; nothing on chain yet", async () => {
  useClock("2026-10-10T12:00:00Z");
  const config = addr(101);
  const w = await world({ env: { LAUNCHPAD_DBC_CONFIGS: config } });
  const L = launchpadPdas(PROGRAM);
  Object.assign(w.chain.S.accounts, {
    [await L.launchpad()]: { owner: PROGRAM, data: b64(layoutAccount("Launchpad", { admin: w.wallet, rewards_program: REWARDS })) },
    [await L.launchConfig(config)]: { owner: PROGRAM, data: b64(layoutAccount("LaunchConfig", { dbc_config: config, quote_mint: ADDRESSES.wsol, enabled: 1 })) },
  });
  const f = await Promise.all([1, 2, 3, 4, 5, 6].map(() => person(w.env)));
  const city = { NYC: 5128581, SYR: 5140405, ALB: 5106834, UTI: 5142056 };
  // ok: NYC, SOL, 12 bytes
  await seedCoin(w.env.DB, { city: city.NYC, name: "New York City", coin: "Big Apple 🍎", seat: await seedSeat(w.env, f[0], { city: city.NYC, name: "New York City", handle: "nyc" }) });
  // USDC pair
  await seedCoin(w.env.DB, { city: city.SYR, name: "Syracuse", coin: "Salt City", pair: "USDC", seat: await seedSeat(w.env, f[1], { city: city.SYR, name: "Syracuse" }) });
  // 33 bytes (accents count twice)
  const long = "Albany Coin of the Hudson Vallé!"; // 33 UTF-8 bytes (the é counts 2)
  assert.equal(new TextEncoder().encode(long).length, 33);
  await seedCoin(w.env.DB, { city: city.ALB, name: "Albany", coin: long, seat: await seedSeat(w.env, f[2], { city: city.ALB, name: "Albany" }) });
  // a seat in its grace period
  await seedCoin(w.env.DB, { city: city.UTI, name: "Utica", coin: "Utica Coin", seat: await seedSeat(w.env, f[3], { city: city.UTI, name: "Utica", status: "grace" }) });
  let r = (await w.call("/api/admin/lp/candidates")).data;
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = (id) => r.candidates.find((c) => c.cityId === String(id));
  assert.deepEqual([by(city.NYC).ok, by(city.NYC).symbol, by(city.NYC).founder, by(city.NYC).nameBytes, by(city.NYC).handle], [true, "NYC", f[0].w.address, 14, "nyc"]);
  // the picture's check is separate (src/logos.js): the card says whether a picture exists, where its check stands and whether an approved one shows
  assert.deepEqual([by(city.NYC).logo, by(city.NYC).logoStatus, by(city.NYC).approved], [false, null, false]);
  await w.env.DB.prepare("UPDATE city_coins SET media_id = 1, approved_media_id = 1, logo_hash = 'h', logo_status = 'approved' WHERE city_id = ?").bind(String(city.NYC)).run();
  await w.env.DB.prepare("UPDATE city_coins SET media_id = 2, logo_status = 'pending' WHERE city_id = ?").bind(String(city.NYC)).run(); // a replacement waits while the approved one shows
  r = (await w.call("/api/admin/lp/candidates")).data;
  assert.deepEqual([by(city.NYC).logo, by(city.NYC).logoStatus, by(city.NYC).approved], [true, "pending", true]);
  await w.env.DB.prepare("UPDATE city_coins SET media_id = NULL, approved_media_id = NULL, logo_hash = NULL, logo_status = NULL WHERE city_id = ?").bind(String(city.NYC)).run();
  r = (await w.call("/api/admin/lp/candidates")).data;
  assert.match(by(city.SYR).reasons.join(" "), /paired with USDC; only SOL-paired coins/);
  assert.match(by(city.ALB).reasons.join(" "), /33 bytes long; the most is 32/);
  assert.match(by(city.UTI).reasons.join(" "), /grace period/);
  // the founder's account moved to another wallet than the seat's
  await w.env.DB.prepare("UPDATE users SET wallet = ? WHERE wallet = ?").bind(addr(102), f[0].w.address).run();
  r = (await w.call("/api/admin/lp/candidates")).data;
  assert.match(by(city.NYC).reasons.join(" "), /now uses another wallet/);
  assert.equal((await w.call("/api/admin/lp/approve/tx", { cityId: String(city.NYC) })).data.error, "blocked");
  await w.env.DB.prepare("UPDATE users SET wallet = ? WHERE wallet = ?").bind(f[0].w.address, addr(102)).run();
  // the seat ended: no live seat
  await w.env.DB.prepare("UPDATE seats SET status = 'ended' WHERE city_id = ?").bind(String(city.UTI)).run();
  r = (await w.call("/api/admin/lp/candidates")).data;
  assert.match(by(city.UTI).reasons.join(" "), /no founder seat now/);
  // approve NYC: the founder, the on-chain name and ticker, 7 days by default; the admin pays. The page sends what its card showed.
  assert.equal((await w.call("/api/admin/lp/approve/tx", { cityId: String(city.NYC), expiryDays: 31 })).data.error, "bad_expiry");
  const seen = seenOf(by(city.NYC));
  assert.equal((await w.call("/api/admin/lp/approve/tx", { cityId: String(city.NYC) })).data.error, "design_changed", "a page that sends nothing it showed gets nothing built");
  const b = await w.call("/api/admin/lp/approve/tx", seen);
  assert.equal(b.data.ok, true, JSON.stringify(b.data));
  // what the owner's signature fixes is read back from the instruction's own bytes into the list the page shows
  const shown = b.data.summary.find((x) => x.ix === "approve_launch");
  assert.deepEqual(shown.fields, { cityId: String(city.NYC), founder: f[0].w.address, name: "Big Apple 🍎", symbol: "NYC", expiresAt: "2026-10-17T12:00:00.000Z" });
  assert.equal(shown.detail, `the coin "Big Apple 🍎", ticker $NYC, founder wallet ${f[0].w.address}, who can launch it until 2026-10-17 12:00 UTC`);
  assert.deepEqual([b.data.approve.name, b.data.approve.symbol, b.data.approve.founder, b.data.approve.days], ["Big Apple 🍎", "NYC", f[0].w.address, 7]);
  assert.equal(b.data.approve.expiresAt, "2026-10-17T12:00:00.000Z");
  assert.deepEqual(b.data.signers, [w.wallet]);
  const ix = await IX.approveLaunch({ programId: PROGRAM, admin: w.wallet, cityId: BigInt(city.NYC), founder: f[0].w.address, name: "Big Apple 🍎", symbol: "NYC", expiresAt: Date.parse("2026-10-17T12:00:00Z") / 1000, dbcConfig: config });
  const d = decodeHeader(Buffer.from(b.data.tx, "base64"));
  assert.deepEqual(Buffer.from(d.instructions[d.instructions.length - 1].data), Buffer.from(ix.data));
  const thirty = (await w.call("/api/admin/lp/approve/tx", { ...seen, expiryDays: 30 })).data;
  assert.equal(Date.parse(thirty.approve.expiresAt), clock.now + 30 * 86_400_000 - 600_000, "ten minutes inside the program's 30-day limit");
  // approved on chain: it moves to the approvals, with its own founder and expiry; a launched coin is out of both lists
  const ap = await L.approval(BigInt(city.NYC));
  w.chain.S.accounts[ap] = approvalAccount({ cityId: city.NYC, founder: f[0].w.address, dbcConfig: config, rentPayer: w.wallet, name: "Big Apple 🍎", symbol: "NYC", expiresAt: clock.now / 1000 + 86_400 });
  assert.deepEqual(decodeApproval(w.chain.S.accounts[ap] && { ...w.chain.S.accounts[ap], data: [w.chain.S.accounts[ap].data, "base64"] }, PROGRAM).symbol, "NYC");
  r = (await w.call("/api/admin/lp/candidates")).data;
  assert.equal(r.candidates.some((c) => c.cityId === String(city.NYC)), false);
  assert.deepEqual(r.approvals.map((a) => [a.cityId, a.approval.founder, a.approval.expired]), [[String(city.NYC), f[0].w.address, false]]);
  assert.equal((await w.call("/api/admin/lp/approve/tx", { cityId: String(city.NYC) })).data.error, "already_approved");
  const rv = await w.call("/api/admin/lp/revoke/tx", { cityId: String(city.NYC) });
  assert.equal(rv.data.ok, true, JSON.stringify(rv.data));
  assert.ok(rv.data.summary.some((x) => x.ix === "revoke_approval"));
  assert.equal((await w.call("/api/admin/lp/revoke/tx", { cityId: String(city.SYR) })).data.error, "no_approval");
  w.chain.S.accounts[await L.coin(BigInt(city.NYC))] = { owner: PROGRAM, data: b64(layoutAccount("Coin", { city_id: city.NYC, founder: f[0].w.address, mint: addr(103), quote_mint: ADDRESSES.wsol, dbc_config: config, dbc_pool: addr(104) })) };
  r = (await w.call("/api/admin/lp/candidates")).data;
  assert.equal(r.launched.some((c) => c.cityId === String(city.NYC)), true);
  realClock();
});

test("approval candidates: blocked for everyone until the trading settings exist; a warning when the founder is the admin", async () => {
  const w = await world();
  const L = launchpadPdas(PROGRAM);
  w.chain.S.accounts[await L.launchpad()] = { owner: PROGRAM, data: b64(layoutAccount("Launchpad", { admin: w.wallet, rewards_program: REWARDS })) };
  await seedCoin(w.env.DB, { city: 5128581, name: "New York City", coin: "Big Apple", seat: await seedSeat(w.env, w.owner, { city: 5128581, name: "New York City" }) });
  const r = (await w.call("/api/admin/lp/candidates")).data;
  assert.match(r.global.join(" "), /City-coin trading is not switched on yet: the team switches it on after your setup steps/);
  assert.equal(r.candidates[0].ok, false);
  assert.deepEqual(r.candidates[0].warnings, ["The founder is the launchpad admin's own wallet."]);
});

test("names: the program's own rule (1 to 32 UTF-8 bytes, no control or invisible characters)", () => {
  assert.equal(nameProblem("Amsterdam"), null);
  assert.equal(nameProblem("São Paulo Moedas ÁÉÍÓ Útil"), null, "32 bytes exactly");
  assert.match(nameProblem("São Paulo Moedas ÁÉÍÓ Útill"), /33 bytes/);
  assert.match(nameProblem(""), /no name/);
  assert.match(nameProblem("Ams​terdam"), /invisible/);
  assert.match(nameProblem("Ams‮terdam"), /invisible/);
  assert.match(nameProblem("Ams\nterdam"), /control/);
  // review FA-1: every default-ignorable code point (the Hangul fillers, the combining grapheme joiner, variation selectors...)
  // and every blank character, wherever it stands; the review's names looked exactly like "Paris"
  for (const cp of [0x34f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x2065, 0x3164, 0xfe00, 0xfe0f, 0xffa0, 0xfff0, 0xe0000, 0xe0100, 0xe0fff,
    0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x2800, 0x3000, 0x1d159]) {
    const c = String.fromCodePoint(cp);
    for (const name of [`Paris${c}`, `Pa${c}ris`, c]) assert.match(nameProblem(name), /invisible/, `U+${cp.toString(16)} in ${JSON.stringify(name)}`);
  }
  // spaces: a single U+0020 between two characters only
  for (const name of [" ", " Paris", "Paris ", "New  York"]) assert.match(nameProblem(name), /space/, JSON.stringify(name));
  for (const name of ["New York City", "Rio de Janeiro", "Xi'an", "Saint-Étienne"]) assert.equal(nameProblem(name), null, name);
});

test("the price curve check names the fields that differ from the defaults", () => {
  const ok = Buffer.from(EXPECTED_POOL_CONFIG, "base64");
  assert.deepEqual(configDiff({ owner: PROGRAM_IDS.dbc, data: [ok.toString("base64"), "base64"] }), []);
  const fee = Buffer.from(ok);
  fee.writeBigUInt64LE(20_000_000n, LAYOUT.PoolConfig.fields["pool_fees.base_fee.cliff_fee_numerator"].at);
  fee.set(base58Decode(addr(7)), LAYOUT.PoolConfig.fields.fee_claimer.at);
  assert.deepEqual(configDiff({ owner: PROGRAM_IDS.dbc, data: [fee.toString("base64"), "base64"] }), ["fee_claimer", "pool_fees.base_fee.cliff_fee_numerator"]);
  assert.deepEqual(configDiff({ owner: PROGRAM, data: [ok.toString("base64"), "base64"] }), ["not a Meteora DBC config"]);
});

test("the price curve check: the live mainnet curve (version 0) and one made on DBC 0.2.2 (version 1) pass; another version or a transfer fee differs", () => {
  const F = LAYOUT.PoolConfig.fields;
  const diff = (bytes, owner = PROGRAM_IDS.dbc) => configDiff({ owner, data: [Buffer.from(bytes).toString("base64"), "base64"] });
  const live = Buffer.from(LIVE_CONFIG.data, "base64"), v1 = Buffer.from(EXPECTED_POOL_CONFIG, "base64");
  assert.equal(LIVE_CONFIG.owner, PROGRAM_IDS.dbc);
  // the generated bytes are DBC 0.2.2's (version 1); the live curve is the same account but for its version byte
  assert.deepEqual([F.version.at, live[F.version.at], v1[F.version.at]], [236, 0, 1]);
  assert.deepEqual([...live.keys()].filter((i) => live[i] !== v1[i]), [F.version.at]);
  assert.deepEqual(diff(live), [], "the live curve EZVHCg… (version 0)");
  assert.deepEqual(diff(v1), [], "a curve made on DBC 0.2.2 (version 1)");
  for (const base of [live, v1]) {
    const v = base[F.version.at];
    for (const other of [2, 3, 255]) { const b = Buffer.from(base); b[F.version.at] = other; assert.deepEqual(diff(b), ["version"], `version ${other}`); }
    // DBC 0.2.2's transfer-fee fields (the old padding_0, bytes 216-229) stay zero: our coins have no transfer fee
    assert.deepEqual([F.transfer_fee_basis_points.at, F.transfer_fee_withheld_authority.at, F.migrated_transfer_fee_authority_option.at, F.transfer_fee_flag.at, F.padding_0.at, F.padding_0.count], [216, 218, 219, 220, 221, 9]);
    let b = Buffer.from(base); b[F.transfer_fee_flag.at] = 1;
    assert.deepEqual(diff(b), ["transfer_fee_flag"], `transfer_fee_flag 1 on version ${v}`);
    b = Buffer.from(base); b.writeUInt16LE(100, F.transfer_fee_basis_points.at);
    assert.deepEqual(diff(b), ["transfer_fee_basis_points"], `a 1% transfer fee on version ${v}`);
    b = Buffer.from(base); b.writeUInt16LE(1, F.transfer_fee_basis_points.at); b[F.transfer_fee_flag.at] = 1;
    assert.deepEqual(diff(b), ["transfer_fee_basis_points", "transfer_fee_flag"]);
    b = Buffer.from(base); b[F.transfer_fee_withheld_authority.at] = 1; b[F.migrated_transfer_fee_authority_option.at] = 1; b[F.padding_0.at + 8] = 1;
    assert.deepEqual(diff(b), ["transfer_fee_withheld_authority", "migrated_transfer_fee_authority_option", "padding_0"]);
    // the version byte is the only exception: a differing field and a bad version are both named
    b = Buffer.from(base); b.set(base58Decode(addr(7)), F.fee_claimer.at); b[F.version.at] = 2;
    assert.deepEqual(diff(b), ["fee_claimer", "version"]);
    b = Buffer.from(base); b[0] ^= 1;
    assert.deepEqual(diff(b), ["other bytes"], "the discriminator");
  }
  assert.deepEqual(diff(live.subarray(0, 1047)), ["size"]);
  assert.deepEqual(diff(live, PROGRAM), ["not a Meteora DBC config"]);
});

test("step 3 and its record step accept the live mainnet curve (version 0) and a version-1 curve; version 2 or a transfer fee is refused", async (t) => {
  asCurveBuild(t); // Meteora's bonding-curve program is the build the expected curve bytes came from
  const w = await world();
  await afterHandoff(w);
  const F = LAYOUT.PoolConfig.fields;
  const k = addr(91), sig = base58Encode(new Uint8Array(64).fill(3));
  w.chain.S.landed[sig] = { keys: [w.wallet, k] };
  const record = async (bytes) => {
    w.chain.S.accounts[k] = { owner: PROGRAM_IDS.dbc, data: Buffer.from(bytes).toString("base64") };
    return (await w.call("/api/admin/lp/record", { step: "config", signature: sig, params: { address: k } })).data;
  };
  const live = Buffer.from(LIVE_CONFIG.data, "base64");
  const v2 = Buffer.from(live); v2[F.version.at] = 2;
  const fee = Buffer.from(live); fee[F.transfer_fee_flag.at] = 1; fee.writeUInt16LE(100, F.transfer_fee_basis_points.at);
  let r = await record(v2);
  assert.deepEqual([r.error, r.message], ["config_differs", `The price curve ${k} differs from Vicinity's defaults in: version. It was not recorded.`]);
  r = await record(fee);
  assert.deepEqual([r.error, r.message], ["config_differs", `The price curve ${k} differs from Vicinity's defaults in: transfer_fee_basis_points, transfer_fee_flag. It was not recorded.`]);
  for (const bytes of [live, Buffer.from(EXPECTED_POOL_CONFIG, "base64")]) {
    assert.equal((await record(bytes)).ok, true, `version ${bytes[F.version.at]} is recorded`);
    const st = (await w.call("/api/admin/lp/status")).data;
    assert.deepEqual([st.steps[2].state, st.config.diff], ["done", []]);
    assert.match(st.steps[2].reason, /matches Vicinity's defaults/);
  }
  // a recorded curve whose version later reads as something else is "blocked", never done
  w.chain.S.accounts[k] = { owner: PROGRAM_IDS.dbc, data: v2.toString("base64") };
  const s3 = await stepOf(w, "config");
  assert.equal(s3.state, "blocked");
  assert.match(s3.reason, /differs from Vicinity's defaults in: version\. Tell the team; do not allow it\./);
});

test("launched coins: collect only when something waits; holder rewards need the registry admin; forward needs them; pause", async () => {
  const config = addr(111), mint = addr(112), pool = addr(113);
  const w = await world({ env: { LAUNCHPAD_DBC_CONFIGS: config } });
  const L = launchpadPdas(PROGRAM);
  const cityId = 5128581n;
  const coin = await L.coin(cityId);
  const poolBytes = layoutAccount("VirtualPool", { config, base_mint: mint, quote_reserve: 10_000_000_000n, creator_quote_fee: 0n });
  Object.assign(w.chain.S.accounts, {
    [await L.launchpad()]: { owner: PROGRAM, data: b64(layoutAccount("Launchpad", { admin: w.wallet, rewards_program: REWARDS })) },
    [await IX.rewards(REWARDS).registry()]: registryAccount(addr(114)),
    [coin]: { owner: PROGRAM, data: b64(layoutAccount("Coin", { city_id: cityId, founder: addr(115), mint, quote_mint: ADDRESSES.wsol, dbc_config: config, dbc_pool: pool })) },
    [pool]: { owner: PROGRAM_IDS.dbc, data: b64(poolBytes) },
    [config]: { owner: PROGRAM_IDS.dbc, data: EXPECTED_POOL_CONFIG },
    [await L.holdersPot(coin)]: tokenAccount(ADDRESSES.wsol, coin, 0n),
  });
  await seedCoin(w.env.DB, { city: cityId, name: "New York City", coin: "Big Apple" });
  const coins = (await w.call("/api/admin/lp/coins")).data;
  assert.equal(coins.ok, true, JSON.stringify(coins));
  assert.deepEqual(coins.coins.map((c) => [c.cityId, c.cityName, c.stage, c.progressPct, c.curveFees, c.rewards, c.coinPage]), [[String(cityId), "New York City", "curve", 11.76, "0", null, `/coin?mint=${mint}`]]);
  assert.equal((await w.call("/api/admin/lp/collect/tx", { cityId: String(cityId) })).data.error, "nothing_to_collect");
  w.chain.S.accounts[pool] = { owner: PROGRAM_IDS.dbc, data: b64(layoutAccount("VirtualPool", { config, base_mint: mint, quote_reserve: 10_000_000_000n, creator_quote_fee: 5_000n })) };
  const c = await w.call("/api/admin/lp/collect/tx", { cityId: String(cityId) });
  assert.equal(c.data.ok, true, JSON.stringify(c.data));
  assert.deepEqual(c.data.summary.filter((x) => x.programName === "Vicinity launchpad").map((x) => x.ix), ["harvest_curve_fees"]);
  assert.deepEqual(c.data.signers, [w.wallet], "anyone may pay: the session wallet does");
  assert.equal((await w.call("/api/admin/lp/collect/tx", { cityId: "5140405" })).data.error, "not_launched");
  assert.equal((await w.call("/api/admin/lp/init-city/tx", { cityId: String(cityId) })).data.error, "not_admin");
  w.chain.S.accounts[await IX.rewards(REWARDS).registry()] = registryAccount(w.wallet);
  const ic = await w.call("/api/admin/lp/init-city/tx", { cityId: String(cityId) });
  assert.equal(ic.data.ok, true, JSON.stringify(ic.data));
  assert.equal((await w.call("/api/admin/lp/forward/tx", { cityId: String(cityId) })).data.error, "no_rewards");
  assert.equal((await w.call("/api/admin/lp/pause/tx", { launches: "yes" })).data.error, "bad_request");
  assert.equal((await w.call("/api/admin/lp/pause/tx", { launches: false })).data.error, "already_done");
  const p = await w.call("/api/admin/lp/pause/tx", { launches: true });
  assert.deepEqual([p.data.ok, p.data.summary.find((x) => x.ix === "set_pause").programName], [true, "Vicinity launchpad"]);
  // the platform fees are the dev wallet's to collect
  assert.equal((await w.call("/api/admin/lp/platform/tx", {})).data.error, "dev_wallet_only");
});

test("step 3 compares Meteora's bonding-curve program with the build the expected curve bytes came from, on devnet too (devnet's own tested build writes another PoolConfig)", async () => {
  const w = await world(); // Meteora's programs as devnet's tested builds (stand-ins): the standing line says ok
  await afterHandoff(w);
  const st = (await w.call("/api/admin/lp/status")).data;
  assert.equal(st.meteora.state, "ok");
  const s3 = st.steps.find((x) => x.id === "config");
  assert.equal(s3.state, "blocked", "a curve made by this build would be refused at record time");
  assert.match(s3.reason, /the checked one e2bfc853c1a1…/);
  const b = await w.call("/api/admin/lp/tx", { step: "config", ephemeral: [addr(91)] });
  assert.deepEqual([b.status, b.data.error, b.data.which], [409, "program_changed", ["dbc"]]);
});
