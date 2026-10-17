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
//     old program's approvals and launches, the pinned Meteora DBC dump;
//   * SPL Token and the associated token program of litesvm, the WSOL mint, and
//     the clock at a fixed time.
// Signature checks are on. Every transaction goes through `send`, which runs the
// invariant checker and money-flow tracer of invariants.mjs after every
// successful transaction and checks that a failed one moved nothing.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { LiteSVM } from 'litesvm';
import {
  address, generateKeyPairSigner, lamports, pipe, createTransactionMessage, setTransactionMessageFeePayerSigner,
  appendTransactionMessageInstructions, signTransactionMessageWithSigners, addSignersToTransactionMessage,
  getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, compressTransactionMessageUsingAddressLookupTables,
} from '@solana/kit';
import web3 from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
import * as S from '../sdk/curve/index.mjs';
import { buildIx } from '../sdk/launchpad/idl.mjs';
import { createConfigIx, vicinityConfigParams } from '../sdk/launchpad/config.mjs';
import { dbc } from '../sdk/launchpad/pda.mjs';
import {
  snapshot, decodeTransaction, checkTransaction, checkFailedTransaction, probeLiveness, tokenAccountInfo, mintInfo, readMetadata,
  compiledIdsProblems, PROGRAM_DATA_HEADER,
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
});
/** Pinned SHA-256 of the dumps (scripts/launchpad/fetch-fixtures.sh, mainnet). */
const PINS = {
  'mpl_token_metadata.so': '31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011',
  'dbc.so': 'e2bfc853c1a1778dd8ee40ea9a0f3edf5587442360c57c685e7e3024ad0cad47',
};
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
const stringify = (v) => {
  if (typeof v === 'number' && FIELDLESS[v]) return `TransactionError ${FIELDLESS[v]} (${v})`;
  const json = JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));
  // litesvm's transaction errors are class instances (e.g. TransactionErrorInsufficientFundsForRent): keep the name
  const name = v && typeof v === 'object' && v.constructor && v.constructor !== Object ? v.constructor.name : '';
  return name ? `${name} ${json}` : json;
};

// ---------------------------------------------------------------- results
export class TxError extends Error {
  constructor(label, logs, err) {
    super(`${label} failed: ${err}\n  ${logs.slice(-14).join('\n  ')}`);
    this.logs = logs;
    this.errText = String(err);
  }
}
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
    return [this.admin, this.guardian, this.payoutKey, this.deployer, this.keeper].filter(Boolean).map((s) => String(s.address));
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
    const tx = await this.buildTx(ixs, signers, o);
    const messageBytes = tx.messageBytes;
    const loaded = o.lookupTables ? this.loadedAddresses(messageBytes, o.lookupTables) : [];
    const msg = getCompiledTransactionMessageDecoder().decode(messageBytes);
    const keys = [...msg.staticAccounts.map(String), ...loaded];
    const read = () => new Map(keys.map((k) => { const a = this.accountInfo(k); return [k, a ?? { address: k, lamports: 0n, exists: false, data: Buffer.alloc(0), owner: null }]; }));
    const preAccounts = read();
    const keySet = new Set(keys);
    const pre = this.checks ? snapshot(this, keySet) : null;
    const size = Buffer.from(getBase64EncodedWireTransaction(tx), 'base64').length;
    const res = this.svm.sendTransaction(tx);
    this.svm.expireBlockhash();
    this.txs++;
    const postAccounts = read();
    if (typeof res.err === 'function') {
      const logs = res.meta().logs();
      if (this.checks) {
        checkFailedTransaction(this, { pre, post: snapshot(this, keySet), preAccounts, postAccounts, feePayer: keys[0], nSignatures: msg.header.numSignerAccounts, label });
      }
      throw new TxError(label, logs, stringify(res.err()));
    }
    const logs = res.logs();
    const decoded = decodeTransaction(this, { messageBytes, inner: res.innerInstructions(), logs, lookupAddresses: loaded });
    if (this.checks) {
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
  /** The city's rewards config by the real `init_city` (model Holders, 0% founder, WSOL, authority the admin by default). */
  async initRewardsCity(h, { model = 'Holders', founderBps = 0, authority = this.admin, rewardMint = S.ADDRESSES.nativeMint, founder } = {}) {
    const R = this.rewardsPdas();
    const config = R.city(h.mint);
    await this.send([this.rewardsIx('init_city', { reward_model: { [model]: {} }, founder_bps: founderBps, city_tag: Array(32).fill(0) }, {
      payer: this.payer.address, admin: this.admin.address, registry: R.registry, authority: authority.address,
      founder: String(founder ?? h.founder.address), city_coin_mint: h.mint, reward_mint: rewardMint, config, vault: R.vault(config),
      token_program: S.ADDRESSES.token, system_program: S.ADDRESSES.system,
    })], authority.address === this.admin.address ? [this.admin] : [this.admin, authority], 'rewards init_city');
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
