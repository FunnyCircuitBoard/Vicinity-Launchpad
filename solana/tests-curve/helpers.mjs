// In-process test harness for vicinity_curve (no validator, no ports), modelled
// on tests-launchpad/helpers.mjs.
//
// One `World` = one LiteSVM instance with:
//   * vicinity_curve: target/deploy/vicinity_curve.so (the production build of
//     `anchor build`; VCURVE_SO overrides), loaded through the upgradeable loader
//     with `deployer` as upgrade authority, so init_launchpad is tested for real;
//   * vicinity_rewards and the old vicinity_launchpad as deployed on mainnet: the
//     committed release binaries (release/mainnet-2026-10-10, SHA-256 checked
//     against its SHA256SUMS) at their mainnet addresses, which the production
//     build of vicinity_curve compiles in (3.2; NOTES entry 27);
//   * the pinned Metaplex Token Metadata mainnet dump
//     (scripts/launchpad/fetch-fixtures.sh, SHA-256 checked here too) and, for the
//     old program's approvals and launches, the pinned Meteora DBC dump; the pinned
//     Squads v4 dump where a test loads it (the guardian's stop, review R7-1);
//   * SPL Token and the associated token program of litesvm, the WSOL mint, and
//     the clock at a fixed time.
// Signature checks are on. Every transaction goes through `send`, which runs the
// invariant checker and money-flow tracer of invariants.mjs after every
// successful transaction and checks that a failed one moved nothing.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { LiteSVM } from 'litesvm';
import {
  address, generateKeyPairSigner, lamports, pipe, createTransactionMessage, setTransactionMessageFeePayerSigner,
  appendTransactionMessageInstructions, signTransactionMessageWithSigners, addSignersToTransactionMessage,
  getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, compressTransactionMessageUsingAddressLookupTables,
  getTransactionDecoder, partiallySignTransaction, getSignatureFromTransaction,
} from '@solana/kit';
import web3 from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
import * as S from '../sdk/curve/index.mjs';
import { buildIx } from '../sdk/launchpad/idl.mjs';
import { createConfigIx, vicinityConfigParams } from '../sdk/launchpad/config.mjs';
import { dbc } from '../sdk/launchpad/pda.mjs';
import {
  snapshot, decodeTransaction, checkTransaction, checkFailedTransaction, probeLiveness, tokenAccountInfo, mintInfo, readMetadata,
  compiledIdsProblems, PROGRAM_DATA_HEADER, priorityFeeOf,
} from './invariants.mjs';

const { BN } = anchorPkg;
const { PublicKey } = web3;
export { S, tokenAccountInfo, mintInfo, readMetadata };

const here = dirname(fileURLToPath(import.meta.url));
export const SOL = join(here, '..');
export const LAMPORTS = 1_000_000_000n;
export const DAY = 86_400n;
export const START_TS = 1_800_000_000n;
export const START_SLOT = 1_000n;
const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

// ---------------------------------------------------------------- binaries
const RELEASE = join(SOL, 'release', 'mainnet-2026-10-10');
const FIXTURES = process.env.LAUNCHPAD_PROGRAMS_DIR || join(SOL, 'tests-launchpad', 'fixtures', 'programs');
export const PATHS = Object.freeze({
  curve: process.env.VCURVE_SO || join(SOL, 'target', 'deploy', 'vicinity_curve.so'),
  curveHaltAll: process.env.VCURVE_HALT_ALL_SO || join(SOL, 'target', 'vcurve-builds', 'halt-all', 'vicinity_curve.so'),
  rewards: join(RELEASE, 'vicinity_rewards.so'),
  legacy: join(RELEASE, 'vicinity_launchpad.so'),
  metaplex: process.env.VCURVE_METAPLEX_SO || join(FIXTURES, 'mpl_token_metadata.so'),
  dbc: join(FIXTURES, 'dbc.so'),
  // the guardian's Squads v4 program (SQDS4ep65...; immutable on mainnet: its ProgramData has no upgrade authority), for the
  // guardian's stop through a vault transaction (34-guardian-stop, review R7-1); always the mainnet dump
  squads: process.env.VCURVE_SQUADS_SO || join(SOL, 'tests-launchpad', 'fixtures', 'programs', 'squads_v4.so'),
});
/** Pinned SHA-256 of the dumps (scripts/launchpad/fetch-fixtures.sh, mainnet). */
const PINS = {
  'mpl_token_metadata.so': '31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011',
  'dbc.so': 'e2bfc853c1a1778dd8ee40ea9a0f3edf5587442360c57c685e7e3024ad0cad47',
  'squads_v4.so': 'dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c',
};
/** The pinned Squads v4 dump (review R7-1): its path, the SHA-256 checked unless VCURVE_SQUADS_SO names another file. */
export function squadsProgramPath() {
  const p = need(PATHS.squads, 'run "npm run launchpad:fixtures" (dumps Squads v4 from mainnet and checks its pinned hash)');
  if (!process.env.VCURVE_SQUADS_SO) assert.equal(sha256File(p), PINS['squads_v4.so'], `${p} is not the pinned squads_v4.so`);
  return p;
}
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
function need(p, how) {
  if (!existsSync(p)) throw new Error(`missing ${p}: ${how}`);
  return p;
}
function pinned(p, name) {
  need(p, 'run "npm run launchpad:fixtures" (dumps Metaplex and Meteora from mainnet and checks their pinned hashes)');
  if (!process.env.VCURVE_METAPLEX_SO && !process.env.LAUNCHPAD_PROGRAMS_DIR) assert.equal(sha256File(p), PINS[name], `${p} is not the pinned ${name}`);
  return p;
}
function release(p) {
  need(p, 'the committed mainnet release binaries');
  const sums = Object.fromEntries(readFileSync(join(RELEASE, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/).reverse()));
  const name = p.split('/').pop();
  assert.equal(sha256File(p), sums[name], `${name} differs from release/mainnet-2026-10-10/SHA256SUMS`);
  return p;
}

// ---------------------------------------------------------------- the other programs' IDLs at their mainnet ids
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const LEGACY_IDL = { ...readJson(join(SOL, 'sdk', 'idl', 'vicinity_launchpad.json')), address: S.CLUSTERS.mainnet.legacyProgram };
export const REWARDS_IDL = { ...readJson(join(SOL, 'sdk', 'idl', 'vicinity_rewards.json')), address: S.CLUSTERS.mainnet.rewardsProgram };

// ---------------------------------------------------------------- byte helpers
const u64b = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32b = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pkb = (a) => new PublicKey(String(a)).toBuffer();
const opt = (a) => (a ? Buffer.concat([u32b(1), pkb(a)]) : Buffer.alloc(36));
export function mintData({ supply = 0n, decimals = 6, mintAuthority = null, freezeAuthority = null }) {
  return Buffer.concat([opt(mintAuthority), u64b(supply), Buffer.from([decimals, 1]), opt(freezeAuthority)]);
}
export const metaHash = (s) => [...createHash('sha256').update(String(s)).digest()];
/**
 * A key whose holder signs off-line (a Phantom wallet such as FEE_RECIPIENT, for which the suite has no private
 * key): it "signs" with zeros, so only a World with signature checks switched off
 * (`w.svm.withSigverify(false)`) accepts its transactions. Used to show what such a key could do.
 */
export const offlineKey = (addr) => ({ address: address(String(addr)), signTransactions: async (txs) => txs.map(() => ({ [String(addr)]: new Uint8Array(64) })) });
// litesvm's TransactionErrorFieldless is a const enum (no runtime object): its names, in order
const FIELDLESS = ['AccountInUse', 'AccountLoadedTwice', 'AccountNotFound', 'ProgramAccountNotFound', 'InsufficientFundsForFee', 'InvalidAccountForFee',
  'AlreadyProcessed', 'BlockhashNotFound', 'CallChainTooDeep', 'MissingSignatureForFee', 'InvalidAccountIndex', 'SignatureFailure', 'InvalidProgramForExecution',
  'SanitizeFailure', 'ClusterMaintenance', 'AccountBorrowOutstanding', 'WouldExceedMaxBlockCostLimit', 'UnsupportedVersion', 'InvalidWritableAccount',
  'WouldExceedMaxAccountCostLimit', 'WouldExceedAccountDataBlockLimit', 'TooManyAccountLocks', 'AddressLookupTableNotFound', 'InvalidAddressLookupTableOwner',
  'InvalidAddressLookupTableData', 'InvalidAddressLookupTableIndex', 'InvalidRentPayingAccount', 'WouldExceedMaxVoteCostLimit', 'WouldExceedAccountDataTotalLimit',
  'MaxLoadedAccountsDataSizeExceeded', 'ResanitizationNeeded', 'InvalidLoadedAccountsDataSizeLimit', 'UnbalancedTransaction', 'ProgramCacheHitMaxLimit', 'CommitCancelled'];
/**
 * Transactions the runtime refuses before executing them: the fee payer is missing or cannot pay, a signature,
 * the blockhash or the message itself is invalid, an account is loaded twice or locked. They pay no fee and
 * change nothing; every other failure ran (an instruction error, the rent-state rule after execution) and pays
 * its fee (L2).
 */
export const REFUSED_BEFORE_EXECUTION = Object.freeze(new Set(['AccountInUse', 'AccountLoadedTwice', 'AccountNotFound', 'InsufficientFundsForFee',
  'InvalidAccountForFee', 'AlreadyProcessed', 'BlockhashNotFound', 'MissingSignatureForFee', 'InvalidAccountIndex', 'SignatureFailure', 'SanitizeFailure',
  'UnsupportedVersion', 'InvalidWritableAccount', 'TooManyAccountLocks', 'AddressLookupTableNotFound', 'InvalidAddressLookupTableOwner',
  'InvalidAddressLookupTableData', 'InvalidAddressLookupTableIndex', 'ResanitizationNeeded']));
/** Whether litesvm's error `v` (a fieldless index or an error object) is one of REFUSED_BEFORE_EXECUTION. */
export const refusedBeforeExecution = (v) => typeof v === 'number' && REFUSED_BEFORE_EXECUTION.has(FIELDLESS[v]);
const stringify = (v) => {
  if (typeof v === 'number' && FIELDLESS[v]) return `TransactionError ${FIELDLESS[v]} (${v})`;
  const json = JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));
  // litesvm's transaction errors are class instances (e.g. TransactionErrorInsufficientFundsForRent): keep the name
  const name = v && typeof v === 'object' && v.constructor && v.constructor !== Object ? v.constructor.name : '';
  return name ? `${name} ${json}` : json;
};

// ---------------------------------------------------------------- results
export class TxError extends Error {
  constructor(label, logs, err, rpc = null) {
    super(`${label} failed: ${err}\n  ${logs.slice(-14).join('\n  ')}`);
    this.logs = logs;
    this.errText = String(err);
    this.rpc = rpc; // the failed transaction as getTransaction would return it (rpcTransaction)
  }
}

/**
 * A transaction as an RPC's getTransaction returns it (`{ slot, meta, transaction: { message } }`, v0 message
 * with compiled instructions, inner instructions with their stack heights, logs, loaded addresses), built from
 * litesvm's result: what `S.decodeTransactionEvents` reads (CLI-2). `err` is null for a success.
 */
export function rpcTransaction(messageBytes, { err = null, inner, logs, loaded = [] }) {
  const msg = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const compiled = (ix) => ({ programIdIndex: ix.programAddressIndex, accountKeyIndexes: [...(ix.accountIndices ?? [])], data: Uint8Array.from(ix.data ?? []) });
  // loaded addresses come in runtime order (World.loadedAddresses): the writable ones of every table, then the read-only ones
  const nW = (msg.addressTableLookups ?? []).reduce((n, l) => n + (l.writableIndexes ?? l.writableIndices ?? []).length, 0);
  return {
    meta: {
      err,
      logMessages: logs,
      loadedAddresses: { writable: loaded.slice(0, nW).map(String), readonly: loaded.slice(nW).map(String) },
      innerInstructions: inner.map((list, index) => ({
        index,
        instructions: list.map((ii) => { const c = ii.instruction(); return { programIdIndex: c.programIdIndex(), accounts: Array.from(c.accounts()), data: Uint8Array.from(c.data()), stackHeight: ii.stackHeight() }; }),
      })).filter((g) => g.instructions.length),
    },
    transaction: { message: { staticAccountKeys: msg.staticAccounts.map(String), compiledInstructions: msg.instructions.map(compiled) } },
  };
}
/** Events as a sorted list of `name:fields` strings (to compare two decoders' results as multisets). */
const eventKeys = (events) => events.map((e) => `${e.name}:${JSON.stringify(e.data, (k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? [...v] : v))}`).sort();
/** Assert that `fn` fails with one of `codes` (error names, or RegExps over logs and error). */
export async function expectFail(fn, ...codes) {
  let e;
  try { await fn(); } catch (x) { e = x; }
  assert.ok(e, `expected failure (${codes.join(' | ')}), but it succeeded`);
  if (!(e instanceof TxError)) throw e;
  if (codes.length === 0) return e;
  const text = `${e.logs.join('\n')}\n${e.errText}`;
  const ok = codes.some((c) => (c instanceof RegExp ? c.test(text) : new RegExp(`\\b${c}\\b`).test(text)));
  assert.ok(ok, `expected one of [${codes.join(', ')}], got:\n${e.message}`);
  return e;
}

// ---------------------------------------------------------------- the world
export class World {
  static async create(opts = {}) {
    const w = new World();
    await w.init(opts);
    return w;
  }

  async init({ legacy = 'paused', rewards = true, initLaunchpad = true, config0 = true, dbcProgram = false, curveSo = PATHS.curve, guardian = true } = {}) {
    this.svm = new LiteSVM();
    this.programId = S.CURVE_PROGRAM_ID;
    this.cluster = 'mainnet';
    this.P = memoPdas(S.curvePdas({ programId: this.programId, cluster: this.cluster }));
    this.ix = S.curveInstructions({ programId: this.programId, cluster: this.cluster, pdas: this.P });
    this.ataCache = new Map();
    this.signers = new Map();
    this.holders = new Map(); // mint -> Map(address -> signer)
    this.lamportDonations = new Map();
    this.tokenDonations = new Map();
    this.holderBurns = new Map();
    this.coinMeta = new Map();
    this.frozen = new Map();
    this.cu = {};
    this.txs = 0;
    this.history = []; // every transaction sent, as an RPC would keep it (rpcStub's getSignaturesForAddress, getTransaction)
    this.haltAllLoaded = false;
    this.checks = process.env.VCURVE_INVARIANTS !== 'off';
    // I22: the liveness probe runs after every successful transaction (VCURVE_PROBE=end: only at the end of each test)
    this.probeEach = this.checks && process.env.VCURVE_PROBE !== 'end';
    this.probes = 0;
    const svm = this.svm;
    svm.addProgramFromFile(address(S.ADDRESSES.metaplex), pinned(PATHS.metaplex, 'mpl_token_metadata.so'));
    if (dbcProgram) svm.addProgramFromFile(address(DBC_PROGRAM_ID), pinned(PATHS.dbc, 'dbc.so'));
    this.deployer = await this.signer();
    this.curveSo = need(curveSo, 'run "anchor build" (or set VCURVE_SO)');
    this.loadUpgradeable(this.programId, this.curveSo, this.deployer.address);
    this.loadUpgradeable(S.CLUSTERS.mainnet.rewardsProgram, release(PATHS.rewards), this.deployer.address);
    this.loadUpgradeable(S.CLUSTERS.mainnet.legacyProgram, release(PATHS.legacy), this.deployer.address);
    this.recordPrograms();
    this.setRaw(S.ADDRESSES.nativeMint, mintData({ decimals: 9 }), S.ADDRESSES.token);
    const c = svm.getClock(); c.unixTimestamp = START_TS; c.slot = START_SLOT; svm.setClock(c);
    this.admin = await this.signer();
    this.guardian = await this.signer();
    this.payer = await this.signer(10_000n);
    this.keeper = await this.signer();
    this.payoutKey = null;
    // the launch approver (4.24): a key of its own, set only by initBatchPath / set_launch_approver
    this.approver = null;
    svm.airdrop(address(S.ADDRESSES.feeRecipient), lamports(LAMPORTS)); // a funded wallet on mainnet (6.5)
    if (legacy !== 'none') await this.legacyInit({ paused: legacy === 'paused' });
    if (rewards) {
      await this.send([this.rewardsIx('init_registry', {}, {
        payer: this.payer.address, upgrade_authority: this.deployer.address, admin: this.admin.address,
        program: S.CLUSTERS.mainnet.rewardsProgram, program_data: S.findPda([pkb(S.CLUSTERS.mainnet.rewardsProgram)], S.ADDRESSES.upgradeableLoader)[0],
        registry: S.findPda([Buffer.from('registry')], S.CLUSTERS.mainnet.rewardsProgram)[0],
      })], [this.deployer, this.admin], 'rewards init_registry');
    }
    if (initLaunchpad) {
      await this.send([this.ix.initLaunchpad({
        payer: this.payer.address, admin: this.admin.address, upgradeAuthority: this.deployer.address, guardian: guardian ? this.guardian.address : S.ADDRESSES.system,
      })], [this.admin, this.deployer], 'init_launchpad');
    }
    if (initLaunchpad && config0) await this.addConfig(S.DEFAULT_CONFIG);
  }

  // ------------------------------------------------ keys, accounts, clock
  async signer(sol = 1_000n) {
    const s = await generateKeyPairSigner();
    if (sol > 0n) this.svm.airdrop(s.address, lamports(BigInt(sol) * LAMPORTS));
    this.signers.set(String(s.address), s);
    return s;
  }
  /** A funded signer for liveness simulations (never used to send). */
  async probeSigner(lam) {
    const s = await generateKeyPairSigner();
    this.svm.airdrop(s.address, lamports(BigInt(lam)));
    return s;
  }
  signerOf(addr) { return this.signers.get(String(addr)) ?? null; }
  roleKeys() {
    return [this.admin, this.guardian, this.payoutKey, this.deployer, this.keeper, this.approver].filter(Boolean).map((s) => String(s.address));
  }
  setRaw(addr, data, owner, lam) {
    const d = new Uint8Array(data);
    this.svm.setAccount({
      address: address(String(addr)), lamports: lamports(lam ?? this.svm.minimumBalanceForRentExemption(BigInt(d.length))),
      programAddress: address(String(owner)), executable: false, data: d, space: BigInt(d.length),
    });
  }
  loadUpgradeable(programId, path, authority) {
    this.svm.addProgramFromFile(address(programId), path);
    const pd = S.findPda([pkb(programId)], S.ADDRESSES.upgradeableLoader)[0];
    const acc = this.svm.getAccount(address(pd));
    const data = Buffer.from(acc.data);
    data[12] = 1;
    pkb(authority).copy(data, 13);
    this.svm.setAccount({ ...acc, address: address(pd), data: new Uint8Array(data) });
  }
  /** Deploy another build of vicinity_curve over the live state (H02, H03): an upgrade, so the checker's record of the program bytes follows. */
  loadCurve(path) {
    this.svm.addProgramFromFile(address(this.programId), path);
    this.haltAllLoaded = path === PATHS.curveHaltAll;
    this.recordPrograms();
  }
  /**
   * I20 at run time: the program data of vicinity_curve and of the two programs it
   * reads, as loaded; the checker compares them before and after every
   * transaction. The vicinity_curve binary must carry the compiled ids of this
   * World's cluster and none of the other cluster's.
   */
  recordPrograms() {
    this.programBytes = new Map();
    for (const id of [this.programId, S.CLUSTERS.mainnet.rewardsProgram, S.CLUSTERS.mainnet.legacyProgram]) {
      const pd = this.accountInfo(S.findPda([pkb(id)], S.ADDRESSES.upgradeableLoader)[0]);
      assert.ok(pd, `no program data for ${id}`);
      this.programBytes.set(id, Buffer.from(pd.data.subarray(PROGRAM_DATA_HEADER))); // the ELF after the ProgramData header
    }
    const problems = compiledIdsProblems(this.programBytes.get(this.programId), { programId: this.programId, cluster: this.cluster });
    assert.deepEqual(problems, [], `I20: the loaded vicinity_curve binary does not carry the ${this.cluster} ids`);
  }
  accountInfo(addr) {
    const a = this.svm.getAccount(address(String(addr)));
    return a.exists ? { address: String(addr), owner: String(a.programAddress), lamports: BigInt(a.lamports), data: Buffer.from(a.data), exists: true } : null;
  }
  exists(addr) { return this.accountInfo(addr) !== null; }
  lamportsOf(addr) { return this.accountInfo(addr)?.lamports ?? 0n; }
  tokenBalance(ta) { return tokenAccountInfo(this.accountInfo(ta))?.amount ?? 0n; }
  balanceOf(owner, mint) { return this.tokenBalance(this.ata(owner.address ?? owner, mint)); }
  /** The associated token account of `owner` for `mint` (memoised). */
  ata(owner, mint) {
    const k = `${owner}:${mint}`;
    let a = this.ataCache.get(k);
    if (!a) { a = S.associatedTokenAddress(owner, mint); this.ataCache.set(k, a); }
    return a;
  }
  now() { return BigInt(this.svm.getClock().unixTimestamp); }
  slot() { return BigInt(this.svm.getClock().slot); }
  /** Advance `n` slots (and n * 0.4 s, at least 1 s). */
  warpSlots(n) { const c = this.svm.getClock(); c.slot += BigInt(n); c.unixTimestamp += BigInt(Math.max(1, Math.floor(Number(n) * 0.4))); this.svm.setClock(c); }
  /** Advance `n` seconds (and n * 2.5 slots, at least 1). */
  warpSecs(n) { const c = this.svm.getClock(); c.unixTimestamp += BigInt(n); c.slot += BigInt(Math.max(1, Math.floor(Number(n) * 2.5))); this.svm.setClock(c); }

  // ------------------------------------------------ state readers
  launchpad() { return S.decodeLaunchpad(this.accountInfo(this.P.launchpad()), { programId: this.programId }); }
  launchBatch() { const a = this.accountInfo(this.P.launchBatch()); return a ? S.decodeLaunchBatch(a, { programId: this.programId }) : null; }
  config(id) { return S.decodeLaunchConfig(this.accountInfo(this.P.config(id)), { programId: this.programId }); }
  approval(cityId) { const a = this.accountInfo(this.P.approval(cityId)); return a ? S.decodeApproval(a, { programId: this.programId }) : null; }
  coinView(h) { return S.decodeCurveCoin(this.accountInfo(h.coin ?? h.address ?? h), { programId: this.programId }); }
  mint(h) { return mintInfo(this.accountInfo(h.mint)); }
  holdersOf(mint) { return [...(this.holders.get(String(mint))?.values() ?? [])]; }
  addHolder(mint, s) {
    const m = this.holders.get(String(mint)) ?? new Map();
    m.set(String(s.address), s);
    this.holders.set(String(mint), m);
  }

  // ------------------------------------------------ transactions
  async buildTx(ixs, signers, { feePayer = this.payer, cu = 1_400_000, lookupTables, budget = true } = {}) {
    const all = [feePayer, ...signers.filter((s) => s.address !== feePayer.address)];
    const list = budget ? [S.setComputeUnitLimit(cu), ...ixs] : ixs;
    const kitIxs = list.map((x) => ({ programAddress: address(x.programAddress), accounts: x.accounts.map((a) => ({ address: address(a.address), role: a.role })), data: x.data }));
    let msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
      (m) => appendTransactionMessageInstructions(kitIxs, m),
    );
    if (lookupTables) {
      const tables = Object.fromEntries(Object.entries(lookupTables).map(([k, v]) => [address(k), v.map((a) => address(String(a)))]));
      msg = compressTransactionMessageUsingAddressLookupTables(msg, tables);
    }
    msg = addSignersToTransactionMessage(all, msg);
    return signTransactionMessageWithSigners(msg);
  }
  /** Addresses a v0 message loads from lookup tables, in runtime order (writable of each table, then read-only). */
  loadedAddresses(messageBytes, lookupTables) {
    const msg = getCompiledTransactionMessageDecoder().decode(messageBytes);
    const w = []; const r = [];
    for (const l of msg.addressTableLookups ?? []) {
      const table = lookupTables[String(l.lookupTableAddress)];
      for (const i of l.writableIndexes ?? l.writableIndices ?? []) w.push(String(table[i]));
      for (const i of l.readonlyIndexes ?? l.readonlyIndices ?? []) r.push(String(table[i]));
    }
    return [...w, ...r];
  }

  /**
   * Send one transaction. After a success: invariant checker and money-flow
   * tracer (invariants.mjs). After a failure: nothing moved but the fee; throws
   * TxError. `opts` declares out-of-band intentions to the tracer (donations,
   * holder burns).
   */
  async send(ixs, signers = [], label = 'tx', o = {}) {
    return this.sendBuilt(await this.buildTx(ixs, signers, o), label, o);
  }
  /**
   * Send a transaction exactly as it came over the wire (a client's printed or signed transaction, legacy or v0), signed
   * here by `signers` where its signatures are empty: the same message bytes, so the same message hash.
   */
  async sendWire(bytes, label = 'wire tx', { signers = [], ...o } = {}) {
    let tx = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(bytes)));
    if (signers.length) tx = await partiallySignTransaction(signers.map((x) => x.keyPair), tx);
    return this.sendBuilt(tx, label, o);
  }
  async sendBuilt(tx, label, o = {}) {
    const messageBytes = tx.messageBytes;
    const loaded = o.lookupTables ? this.loadedAddresses(messageBytes, o.lookupTables) : [];
    const msg = getCompiledTransactionMessageDecoder().decode(messageBytes);
    const keys = [...msg.staticAccounts.map(String), ...loaded];
    const read = () => new Map(keys.map((k) => { const a = this.accountInfo(k); return [k, a ?? { address: k, lamports: 0n, exists: false, data: Buffer.alloc(0), owner: null }]; }));
    const preAccounts = read();
    const keySet = new Set(keys);
    const pre = this.checks ? snapshot(this, keySet) : null;
    const size = Buffer.from(getBase64EncodedWireTransaction(tx), 'base64').length;
    const slotSent = this.slot();
    const res = this.svm.sendTransaction(tx);
    this.svm.expireBlockhash();
    this.txs++;
    let signature = null;
    try { signature = getSignatureFromTransaction(tx); } catch { signature = null; }
    this.history.push({ signature, slot: slotSent, blockTime: this.now(), wire: Buffer.from(getBase64EncodedWireTransaction(tx), 'base64'), keys, err: typeof res.err === 'function' ? stringify(res.err()) : null });
    const postAccounts = read();
    if (typeof res.err === 'function') {
      const logs = res.meta().logs();
      const rpc = rpcTransaction(messageBytes, { err: stringify(res.err()), inner: res.meta().innerInstructions(), logs, loaded });
      if (this.checks) {
        checkFailedTransaction(this, { pre, post: snapshot(this, keySet), preAccounts, postAccounts, feePayer: keys[0], nSignatures: msg.header.numSignerAccounts, priorityFee: priorityFeeOf(messageBytes), label, charged: !refusedBeforeExecution(res.err()) });
        // 4.21, T56 (CLI-2): a failed transaction yields no events to an indexer, whatever its metadata carries
        assert.deepEqual(S.decodeTransactionEvents(rpc, { programId: this.programId }), [], `${label} (failed): decodeTransactionEvents returned events`);
      }
      throw new TxError(label, logs, stringify(res.err()), rpc);
    }
    const logs = res.logs();
    const decoded = decodeTransaction(this, { messageBytes, inner: res.innerInstructions(), logs, lookupAddresses: loaded });
    if (this.checks) {
      // the SDK's transaction-level decoder (what indexers use, CLI-2) finds exactly the events the checker found
      const rpc = rpcTransaction(messageBytes, { inner: res.innerInstructions(), logs, loaded });
      assert.deepEqual(eventKeys(S.decodeTransactionEvents(rpc, { programId: this.programId })), eventKeys(decoded.top.flatMap((t) => t.events)),
        `${label}: decodeTransactionEvents disagrees with the checker`);
      const ctx = { pre, post: snapshot(this, keySet), tx: decoded, preAccounts, postAccounts, label, opts: o };
      this.lastCtx = ctx; // what the checker saw (tests of the checker replay it with edits)
      checkTransaction(this, ctx);
      if (this.probeEach && !o.noProbe) this.probes += (await probeLiveness(this, { label: `after ${label}` })).probes;
    }
    const events = decoded.top.flatMap((t) => t.events);
    const cu = Number(res.computeUnitsConsumed());
    const ixCu = decoded.top.filter((t) => t.program === this.programId).map((t) => ({ name: t.name, cu: t.cu }));
    this.cu[label] = { cu, ixCu, size };
    this.lastTx = { cu, ixCu, size, logs, events };
    return { logs, events, cu, ixCu, size, top: decoded.top };
  }
  /** Simulate without committing: `{ ok, error, logs, account(addr), coin(addr) }` (I22 probes, the SDK's simulations). */
  async simulate(ixs, signers = [], o = {}) {
    // the first signer pays, unless it cannot (a 0-lamport founder or seller): then the world's payer does
    const feePayer = o.feePayer ?? signers.find((s) => this.lamportsOf(s.address) >= 1_000_000n) ?? this.payer;
    const tx = await this.buildTx(ixs, signers, { ...o, feePayer });
    const r = this.svm.simulateTransaction(tx);
    if (typeof r.err === 'function') return { ok: false, error: `${stringify(r.err())}\n${r.meta().logs().slice(-6).join('\n')}` };
    const accounts = new Map(r.postAccounts().map((a) => [String(a.address), a]));
    return {
      ok: true,
      logs: r.meta().logs(),
      account: (addr) => {
        const a = accounts.get(String(addr));
        return a ? { address: String(addr), owner: String(a.programAddress), lamports: BigInt(a.lamports), data: Buffer.from(a.data) } : null;
      },
      coin: (addr) => {
        const a = accounts.get(String(addr));
        return S.decodeCurveCoin({ owner: String(a.programAddress), data: a.data }, { programId: this.programId });
      },
    };
  }
  /** I22 liveness probe (by simulation) from the current state. */
  async probe(label) { return probeLiveness(this, { label }); }
  /** End of a test: the liveness probe. */
  async finish(label = 'end of test') { return this.probe(label); }

  // ------------------------------------------------ configs, approvals, launches
  async addConfig(params, { admin = this.admin } = {}) {
    const configId = this.launchpad().nextConfigId;
    await this.send([this.ix.addLaunchConfig({ admin: admin.address, payer: this.payer.address, configId, params })], [admin], 'add_launch_config');
    return configId;
  }
  async approve({ cityId, founder, configId = 0, name = 'Demo City', symbol = 'DEMO', hash, ttl = 7n * DAY, admin = this.admin, expiresAt }) {
    await this.send([this.ix.approveLaunch({
      admin: admin.address, cityId, founder: founder.address ?? founder, configId, name, symbol, metaHash: hash ?? metaHash(`${cityId}:${symbol}`),
      expiresAt: expiresAt ?? this.now() + BigInt(ttl),
    })], [admin], 'approve_launch');
  }
  launchIx({ cityId, founder, payer }) {
    const ap = this.approval(cityId);
    assert.ok(ap, `no approval for city ${cityId}`);
    return this.ix.launch({ founder: founder.address, payer: (payer ?? founder).address, cityId, configId: ap.configId, symbol: ap.symbol, rentPayer: ap.rentPayer });
  }
  /** Launch an approved city; returns the coin handle. */
  async launch({ cityId, founder, payer, label = 'launch' }) {
    const ix = this.launchIx({ cityId, founder, payer });
    const signers = [founder]; if (payer) signers.push(payer);
    const res = await this.send([ix], signers, label);
    return { ...this.handle(cityId, founder), res };
  }
  // ------------------------------------------------ the batch launch approval (4.23 to 4.27)
  /** `init_launch_batch` (once) and `set_launch_approver(approver)` by the admin; returns the approver. */
  async initBatchPath({ approver, admin = this.admin } = {}) {
    approver = approver ?? this.approver ?? await this.signer(5n);
    if (!this.launchBatch()) await this.send([this.ix.initLaunchBatch({ admin: admin.address, payer: this.payer.address })], [admin], 'init_launch_batch');
    await this.send([this.ix.setLaunchApprover({ admin: admin.address, approver: approver.address })], [admin], 'set_launch_approver');
    this.approver = approver;
    return approver;
  }
  /** Entries for a batch: `{ cityId, founder (signer or key), name?, symbol, configId?, metaHash? }`, with the World's defaults. */
  batchEntries(list) {
    return list.map((e) => ({ name: 'Demo City', configId: 0, ...e, founder: String(e.founder.address ?? e.founder), metaHash: e.metaHash ?? metaHash(`${e.cityId}:${e.symbol}`) }));
  }
  /**
   * Build a batch with the SDK for the next number and publish it, signed by `approver` (the World's by default), with the
   * SDK's default window (or `validFrom` / `validUntil`, or `leadSecs` / `validitySecs` from now). Returns the built batch.
   */
  async publishBatch(list, { approver = this.approver, seq, validFrom, validUntil, leadSecs, validitySecs, leafCount, root, label = 'publish_launch_batch', feePayer } = {}) {
    const lb = this.launchBatch();
    const batchSeq = seq ?? (lb ? lb.latest.seq + 1n : 1n);
    const batch = S.buildLaunchBatch(this.batchEntries(list), { programId: this.programId, batchSeq });
    let w;
    if (validFrom !== undefined) w = { validFrom: BigInt(validFrom), validUntil: BigInt(validUntil) };
    else if (leadSecs !== undefined) { const f = this.now() + BigInt(leadSecs); w = { validFrom: f, validUntil: f + BigInt(validitySecs ?? 36n * 3_600n) }; }
    else w = S.defaultPublishWindow(this.now());
    const ix = this.ix.publishLaunchBatch({ approver: approver.address, seq: batchSeq, root: root ?? batch.root, leafCount: leafCount ?? batch.leafCount, ...w });
    const res = await this.send([ix], [approver], label, feePayer ? { feePayer } : { feePayer: approver });
    return { ...batch, ...w, res };
  }
  /** Warp the clock to `t` (seconds), moving slots by 2.5 per second. */
  warpTo(t) { const d = BigInt(t) - this.now(); if (d > 0n) this.warpSecs(d); }
  /** `launch_from_batch` for a city of a built batch, signed by `founder` (and `payer`); `edit` changes the call's arguments. */
  launchFromBatchIx({ batch, cityId, founder, payer, edit = {}, overrides }) {
    const args = S.launchBatchArgs(batch, cityId);
    return this.ix.launchFromBatch({ ...args, ...edit, founder: founder.address, payer: (payer ?? founder).address, overrides });
  }
  async launchFromBatch({ batch, cityId, founder, payer, edit, label = 'launch_from_batch', extra = [], o = {} }) {
    const signers = [founder]; if (payer) signers.push(payer);
    const res = await this.send([this.launchFromBatchIx({ batch, cityId, founder, payer, edit }), ...extra], signers, label, o);
    return { ...this.handle(cityId, founder), res };
  }

  /** Approve and launch a coin. */
  async launchCoin({ cityId, founder, name = 'Demo City', symbol = 'DEMO', configId = 0 } = {}) {
    founder = founder ?? await this.signer();
    await this.approve({ cityId, founder, name, symbol, configId });
    return this.launch({ cityId, founder });
  }
  handle(cityId, founder) {
    const { coin, mint, vault } = this.P.coinAccounts(cityId);
    return { cityId: BigInt(cityId), coin, mint, vault, founder };
  }

  // ------------------------------------------------ trading
  /** `[create ATA (idempotent) if missing, buy]`: the website's buy transaction (14.1). */
  buyIxs(user, h, solIn, minTokensOut = 0n, { userTokenAccount } = {}) {
    const mint = h.mint;
    const ata = this.ata(user.address, mint);
    const out = [];
    if (!userTokenAccount && !this.exists(ata)) out.push(S.createAssociatedTokenAccountIdempotent({ payer: user.address, owner: user.address, mint }));
    out.push(this.ix.buy({ user: user.address, coin: h.coin ?? h.address, userTokenAccount: userTokenAccount ?? ata, solIn, minTokensOut }));
    return out;
  }
  /** A buy by `user`; the SDK quote from the state before must equal what happened (the checker replays it too). */
  async buy(user, h, solIn, { min = 0n, label = 'buy', userTokenAccount } = {}) {
    const before = this.coinView(h);
    const q = S.quoteBuy(S.coinTerms(before), S.coinState(before), BigInt(solIn));
    const lam0 = this.lamportsOf(user.address);
    const ta = userTokenAccount ?? this.ata(user.address, h.mint);
    const tok0 = this.tokenBalance(ta);
    const res = await this.send(this.buyIxs(user, h, BigInt(solIn), BigInt(min), { userTokenAccount }), [user], label);
    assert.equal(this.tokenBalance(ta) - tok0, q.tokensOut, `${label}: coins received = the SDK quote`);
    if (!userTokenAccount) this.addHolder(h.mint, user);
    return { res, q, paid: lam0 - this.lamportsOf(user.address) };
  }
  async sell(user, h, tokensIn, { min = 0n, label = 'sell' } = {}) {
    const before = this.coinView(h);
    const q = S.quoteSell(S.coinTerms(before), S.coinState(before), BigInt(tokensIn));
    const lam0 = this.lamportsOf(user.address);
    const res = await this.send([this.ix.sell({ user: user.address, coin: h.coin, userTokenAccount: this.ata(user.address, h.mint), tokensIn: BigInt(tokensIn), minSolOut: BigInt(min) })], [user], label);
    assert.equal(this.lamportsOf(user.address) - lam0, q.solOut, `${label}: lamports received = the SDK quote`);
    return { res, q };
  }
  async buyback(h, { label = 'buyback_burn', feePayer = this.keeper } = {}) {
    return this.send([this.ix.buybackBurn({ coin: h.coin })], [], label, { feePayer });
  }
  async withdraw(h, { label = 'withdraw_platform_fees', feePayer = this.keeper } = {}) {
    return this.send([this.ix.withdrawPlatformFees({ coin: h.coin })], [], label, { feePayer });
  }
  async claim(h, founder = h.founder, { label = 'claim_founder_fees' } = {}) {
    return this.send([this.ix.claimFounderFees({ founder: founder.address, coin: h.coin })], [founder], label);
  }
  /** `forward_holders_fees` followed by the top-level SyncNative of 4.15, in one transaction. */
  async forward(h, { label = 'forward_holders_fees + SyncNative', feePayer = this.keeper, sync = true } = {}) {
    const ixs = sync ? this.ix.forwardHoldersFeesWithSync({ coin: h.coin }) : [this.ix.forwardHoldersFees({ coin: h.coin })];
    return this.send(ixs, [], label, { feePayer });
  }
  async payout(h, { payoutKey = this.payoutKey, destination, label = 'payout_founder_fees' } = {}) {
    return this.send([this.ix.payoutFounderFees({ payoutAuthority: payoutKey.address, coin: h.coin, destination })], [payoutKey], label);
  }

  // ------------------------------------------------ vicinity_rewards (mainnet binary)
  rewardsIx(name, args, accounts) { return buildIx(REWARDS_IDL, name, args, accounts); }
  rewardsPdas() {
    const id = S.CLUSTERS.mainnet.rewardsProgram;
    return {
      registry: S.findPda([Buffer.from('registry')], id)[0],
      city: (mint) => S.findPda([Buffer.from('city'), pkb(mint)], id)[0],
      vault: (config) => S.findPda([Buffer.from('vault'), pkb(config)], id)[0],
      epoch: (config, index) => S.findPda([Buffer.from('epoch'), pkb(config), u64b(index)], id)[0],
      claim: (epoch, claimant) => S.findPda([Buffer.from('claim'), pkb(epoch), pkb(claimant)], id)[0],
    };
  }
  /** vicinity_rewards' registry `admin` and `pending_admin` (bytes 8..40 and 40..72; OPS-1: they must be this program's admin and zero at every approval and launch). */
  registryAdmins() {
    const d = this.accountInfo(this.rewardsPdas().registry).data;
    return { admin: new PublicKey(d.subarray(S.REWARDS_REGISTRY_ADMIN_AT, S.REWARDS_REGISTRY_ADMIN_AT + 32)).toBase58(),
      pendingAdmin: new PublicKey(d.subarray(S.REWARDS_REGISTRY_PENDING_ADMIN_AT, S.REWARDS_REGISTRY_PENDING_ADMIN_AT + 32)).toBase58() };
  }
  /** The registry's two-step admin transfer: `propose_admin` by its current admin, then `accept_admin` by `to` (unless `accept` is false). */
  async registryHandOver(to, { from = this.signerOf(this.registryAdmins().admin), accept = true } = {}) {
    const registry = this.rewardsPdas().registry;
    await this.send([this.rewardsIx('propose_admin', { new_admin: new PublicKey(String(to.address ?? to)) }, { admin: from.address, registry })], [from], 'rewards registry propose_admin');
    if (!accept) return;
    await this.send([this.rewardsIx('accept_admin', {}, { new_admin: to.address, registry })], [to], 'rewards registry accept_admin');
  }
  /** This program's admin hand-over with every seat that must follow it (4.2, 8.2): the old program's admin and the rewards registry's admin. */
  async adminHandOver(next) {
    const old = this.admin;
    await this.send([this.ix.proposeAdmin({ admin: old.address, newAdmin: next.address })], [old], 'propose_admin');
    await this.send([this.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept_admin');
    this.admin = next;
    if (this.legacyAdmins().admin === String(old.address)) await this.legacyHandOver(next, { from: old });
    if (this.registryAdmins().admin === String(old.address)) await this.registryHandOver(next, { from: old });
  }
  /** The city's rewards config by the real `init_city` (model Holders, 0% founder, WSOL, authority the admin by default). */
  async initRewardsCity(h, { model = 'Holders', founderBps = 0, authority = this.admin, rewardMint = S.ADDRESSES.nativeMint, founder } = {}) {
    const R = this.rewardsPdas();
    const config = R.city(h.mint);
    await this.send([this.rewardsIx('init_city', { reward_model: { [model]: {} }, founder_bps: founderBps, city_tag: Array(32).fill(0) }, {
      payer: this.payer.address, admin: (this.signerOf(this.registryAdmins().admin) ?? this.admin).address, registry: R.registry, authority: authority.address,
      founder: String(founder ?? h.founder.address), city_coin_mint: h.mint, reward_mint: rewardMint, config, vault: R.vault(config),
      token_program: S.ADDRESSES.token, system_program: S.ADDRESSES.system,
    })], [...new Map([this.signerOf(this.registryAdmins().admin) ?? this.admin, authority].map((k) => [String(k.address), k])).values()], 'rewards init_city');
    return { config, vault: R.vault(config) };
  }

  // ------------------------------------------------ the old vicinity_launchpad (mainnet binary)
  legacyIx(name, args, accounts) { return buildIx(LEGACY_IDL, name, args, accounts); }
  legacyPdas() {
    const id = S.CLUSTERS.mainnet.legacyProgram;
    return {
      launchpad: S.CLUSTERS.mainnet.legacyLaunchpad,
      launchConfig: (dbcConfig) => S.findPda([Buffer.from('launch_config'), pkb(dbcConfig)], id)[0],
      approval: (cityId) => S.findPda([Buffer.from('approval'), u64b(cityId)], id)[0],
      coin: (cityId) => S.findPda([Buffer.from('coin'), u64b(cityId)], id)[0],
      holdersPot: (coin) => S.findPda([Buffer.from('holders_pot'), pkb(coin)], id)[0],
      founderVault: (coin) => S.findPda([Buffer.from('founder_vault'), pkb(coin)], id)[0],
    };
  }
  /**
   * The old program's real `init_launchpad`, then (by default) its launches paused, as 8.5 requires before the
   * first approval here. Its admin is this World's admin (8.4: the same Squads vault administers both programs,
   * GOV-1) unless `admin` names another key.
   */
  async legacyInit({ paused = true, admin = this.admin } = {}) {
    const L = this.legacyPdas();
    this.legacyAdmin = admin;
    await this.send([this.legacyIx('init_launchpad', {}, {
      payer: this.payer.address, admin: admin.address, upgrade_authority: this.deployer.address,
      program_data: S.findPda([pkb(S.CLUSTERS.mainnet.legacyProgram)], S.ADDRESSES.upgradeableLoader)[0],
      rewards_program: S.CLUSTERS.mainnet.rewardsProgram, launchpad: L.launchpad,
    })], [admin, this.deployer], 'legacy init_launchpad');
    if (paused) await this.legacyPause(true);
  }
  async legacyPause(launches, { by = this.legacyAdmin ?? this.admin } = {}) {
    await this.send([this.legacyIx('set_pause', { launches, payouts: null }, { authority: by.address, launchpad: this.legacyPdas().launchpad })], [by], `legacy set_pause ${launches}`);
  }
  /** The old program's `admin` and `pending_admin` (its Launchpad bytes 8..40 and 40..72). */
  legacyAdmins() {
    const d = this.accountInfo(this.legacyPdas().launchpad).data;
    return { admin: new PublicKey(d.subarray(8, 40)).toBase58(), pendingAdmin: new PublicKey(d.subarray(40, 72)).toBase58() };
  }
  /** The old program's two-step admin transfer: `propose_admin` by its current admin, then `accept_admin` by `to` (unless `accept` is false). */
  async legacyHandOver(to, { from = this.legacyAdmin ?? this.admin, accept = true } = {}) {
    const launchpad = this.legacyPdas().launchpad;
    await this.send([this.legacyIx('propose_admin', { new_admin: new PublicKey(String(to.address ?? to)) }, { admin: from.address, launchpad })], [from], 'legacy propose_admin');
    if (!accept) return;
    await this.send([this.legacyIx('accept_admin', {}, { new_admin: to.address, launchpad })], [to], 'legacy accept_admin');
    this.legacyAdmin = to;
  }
  /** A Meteora DBC config and its old-program launch config (needs `dbcProgram: true`). */
  async legacyConfig() {
    if (this.legacyDbcConfig) return this.legacyDbcConfig;
    const cfg = await generateKeyPairSigner();
    await this.send([createConfigIx({ config: cfg.address, quoteMint: S.ADDRESSES.nativeMint, payer: this.payer.address, params: vicinityConfigParams() })], [cfg], 'dbc create_config');
    const L = this.legacyPdas();
    const A = this.legacyAdmin ?? this.admin;
    await this.send([this.legacyIx('add_launch_config', {}, {
      admin: A.address, payer: this.payer.address, launchpad: L.launchpad, dbc_config: cfg.address, quote_mint: S.ADDRESSES.nativeMint,
      launch_config: L.launchConfig(cfg.address),
    })], [A], 'legacy add_launch_config');
    this.legacyDbcConfig = String(cfg.address);
    return this.legacyDbcConfig;
  }
  /** The old program's `set_launch_config_enabled` on its DBC launch config (8.5: disabled before the first approval here). */
  async legacyEnable(enabled, { by = this.legacyAdmin ?? this.admin } = {}) {
    const cfg = await this.legacyConfig();
    const L = this.legacyPdas();
    await this.send([this.legacyIx('set_launch_config_enabled', { enabled }, { admin: by.address, launchpad: L.launchpad, launch_config: L.launchConfig(cfg) })], [by], `legacy set_launch_config_enabled ${enabled}`);
  }
  /** An `Approval` for `cityId` created by the old program itself. */
  async legacyApprove({ cityId, founder, name = 'Old City', symbol = 'OLD', ttl = 7n * DAY }) {
    const cfg = await this.legacyConfig();
    const L = this.legacyPdas();
    const A = this.legacyAdmin ?? this.admin;
    await this.send([this.legacyIx('approve_launch', {
      city_id: new BN(String(cityId)), founder: new PublicKey(String(founder.address ?? founder)), name, symbol, expires_at: new BN(String(this.now() + ttl)),
    }, { admin: A.address, launchpad: L.launchpad, launch_config: L.launchConfig(cfg), approval: L.approval(cityId), coin: L.coin(cityId) })], [A], 'legacy approve_launch');
    (this.legacyRentPayers ??= new Map()).set(String(cityId), String(A.address));
  }
  async legacyRevoke(cityId) {
    const L = this.legacyPdas();
    const A = this.legacyAdmin ?? this.admin;
    await this.send([this.legacyIx('revoke_approval', { city_id: new BN(String(cityId)) }, {
      admin: A.address, launchpad: L.launchpad, approval: L.approval(cityId), rent_payer: this.legacyRentPayers?.get(String(cityId)) ?? A.address,
    })], [A], 'legacy revoke_approval');
  }
  /** A `Coin` for `cityId` launched through the old program and Meteora DBC (its launches must be open). */
  async legacyLaunch({ cityId, founder }) {
    const cfg = await this.legacyConfig();
    const L = this.legacyPdas();
    const base = await generateKeyPairSigner();
    const coin = L.coin(cityId);
    const pool = dbc.pool(cfg, base.address, S.ADDRESSES.nativeMint);
    await this.send([this.legacyIx('launch', { city_id: new BN(String(cityId)) }, {
      founder: founder.address, payer: founder.address, base_mint: base.address, launchpad: L.launchpad, approval: L.approval(cityId),
      rent_payer: this.legacyRentPayers?.get(String(cityId)) ?? (this.legacyAdmin ?? this.admin).address, launch_config: L.launchConfig(cfg), coin, holders_pot: L.holdersPot(coin), founder_vault: L.founderVault(coin),
      dbc_config: cfg, dbc_pool: pool, dbc_base_vault: dbc.tokenVault(base.address, pool), dbc_quote_vault: dbc.tokenVault(S.ADDRESSES.nativeMint, pool),
      mint_metadata: dbc.metadata(base.address), quote_mint: S.ADDRESSES.nativeMint, dbc_event_authority: dbc.eventAuthority(),
    })], [founder, base], 'legacy launch', { cu: 400_000 });
  }
}

/** The PDA helpers of a deployment with every derivation memoised (the checker derives the same addresses after every transaction). */
function memoPdas(P) {
  const cache = new Map();
  const out = {};
  for (const [k, v] of Object.entries(P)) {
    out[k] = typeof v !== 'function' ? v : (...args) => {
      const key = `${k}:${args.map(String).join(',')}`;
      let r = cache.get(key);
      if (r === undefined) { r = v(...args); cache.set(key, r); }
      return r;
    };
  }
  return Object.freeze(out);
}

/** Shorthand for the default amounts of 5.14. */
export const SOL_ = (x) => BigInt(Math.round(Number(x) * 1e9));

/**
 * A JSON-RPC stub serving a World's accounts, clock and transaction history, for the scripts' real command lines
 * (scripts/vcurve): the methods they call (getMultipleAccounts, getAccountInfo, getProgramAccounts with memcmp filters,
 * getSlot, getBlockTime, getLatestBlockhash (the World's own, so a printed transaction can be signed and sent as it is),
 * getSignaturesForAddress, getTransaction (base64), sendTransaction (run in the World, with the checker) and
 * getSignatureStatuses). `lie(address, account)` may return another account (or null) for an address, as a malicious or
 * compromised RPC would (reviews R7-BA-1, R7-4); `rpc(request)` may return a whole answer for any method (anything but
 * undefined; `{ drop: true }` for sendTransaction answers the signature without sending; review R8-DIFF-1, R8-OPS-2);
 * `host` is the loopback address it listens on (two stubs on 127.0.0.1 and 127.0.0.2 are two providers, review
 * R8-DIFF-4). Returns `{ url, close, calls }`.
 */
export async function rpcStub(w, { lie = (addr, a) => a, rpc = () => undefined, host = '127.0.0.1' } = {}) {
  const calls = [];
  const view = (k) => lie(String(k), w.accountInfo(String(k)));
  const wire = (a) => ({ data: [Buffer.from(a.data).toString('base64'), 'base64'], executable: false, lamports: Number(a.lamports), owner: String(a.owner), rentEpoch: 0, space: a.data.length });
  const bytesOf = (f) => (f.encoding === 'base64' ? Buffer.from(f.bytes, 'base64') : Buffer.from(bs58decode(f.bytes)));
  const status = (h) => (h ? { slot: Number(h.slot), confirmations: null, err: h.err ? { stub: h.err } : null, confirmationStatus: 'confirmed' } : null);
  const one = async (m) => {
    calls.push(m.method);
    const slot = Number(w.svm.getClock().slot);
    const over = rpc(m);
    if (over !== undefined && !(m.method === 'sendTransaction' && over?.drop)) return { jsonrpc: '2.0', id: m.id, result: over };
    let result;
    if (m.method === 'getMultipleAccounts') result = { context: { slot }, value: m.params[0].map((k) => { const a = view(k); return a ? wire(a) : null; }) };
    else if (m.method === 'getAccountInfo') { const a = view(m.params[0]); result = { context: { slot }, value: a ? wire(a) : null }; }
    else if (m.method === 'getProgramAccounts') {
      const filters = m.params[1]?.filters ?? [];
      result = w.svm.getProgramAccounts(address(m.params[0])).map((x) => String(x.address)).map((k) => [k, view(k)]).filter(([, a]) => a && filters.every((f) => {
        if (f.dataSize !== undefined) return a.data.length === f.dataSize;
        const want = bytesOf(f.memcmp);
        return Buffer.from(a.data).subarray(f.memcmp.offset, f.memcmp.offset + want.length).equals(want);
      })).map(([k, a]) => ({ pubkey: k, account: wire(a) }));
    } else if (m.method === 'getSlot') result = slot;
    else if (m.method === 'getBlockTime') result = Number(w.now());
    else if (m.method === 'getLatestBlockhash') result = { context: { slot }, value: { blockhash: String(w.svm.latestBlockhash()), lastValidBlockHeight: slot + 150 } };
    else if (m.method === 'getSignaturesForAddress') {
      const [addr, o = {}] = m.params;
      let list = w.history.filter((h) => h.signature && h.keys.includes(String(addr))).reverse();
      if (o.before) { const i = list.findIndex((h) => h.signature === o.before); list = i < 0 ? [] : list.slice(i + 1); }
      result = list.slice(0, o.limit ?? 1000).map((h) => ({ signature: h.signature, slot: Number(h.slot), err: h.err ? { stub: h.err } : null, memo: null, blockTime: Number(h.blockTime), confirmationStatus: 'confirmed' }));
    } else if (m.method === 'getTransaction') {
      const h = w.history.find((x) => x.signature === m.params[0]);
      result = h ? { slot: Number(h.slot), blockTime: Number(h.blockTime), transaction: [h.wire.toString('base64'), 'base64'], meta: { err: h.err ? { stub: h.err } : null, fee: 5000, logMessages: [] }, version: 'legacy' } : null;
    } else if (m.method === 'sendTransaction') {
      const bytes = (m.params[1]?.encoding ?? 'base58') === 'base64' ? Buffer.from(m.params[0], 'base64') : Buffer.from(bs58decode(m.params[0]));
      const tx = getTransactionDecoder().decode(Uint8Array.from(bytes));
      const signature = getSignatureFromTransaction(tx);
      if (!over?.drop) { try { await w.sendBuilt(tx, `rpc sendTransaction ${signature.slice(0, 8)}`); } catch { /* a failed transaction is still sent, as with skipPreflight */ } }
      result = signature;
    } else if (m.method === 'getSignatureStatuses') {
      result = { context: { slot }, value: m.params[0].map((sig) => status(w.history.find((x) => x.signature === sig))) };
    } else return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `stub: ${m.method}` } };
    return { jsonrpc: '2.0', id: m.id, result };
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const m = JSON.parse(body);
      const out = Array.isArray(m) ? await Promise.all(m.map(one)) : await one(m);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((ok) => { server.listen(0, host, ok); });
  return { url: `http://${host}:${server.address().port}`, close: () => new Promise((ok) => { server.close(ok); }), calls };
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58decode(text) {
  let n = 0n;
  for (const ch of text) { const i = B58.indexOf(ch); if (i < 0) throw new Error(`not base58: ${text}`); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const ch of text) { if (ch !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
