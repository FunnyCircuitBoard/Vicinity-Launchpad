#!/usr/bin/env node
// The owner's batch verifier, his confirmation and the monitor's check (VICINITY-CURVE-DESIGN.md 8.4 steps 2 and 3, 8.6,
// 14.1; NOTES 76, 78 to 80, 83 to 86). It reads the chain and the list files and prints; it never holds or asks for a
// key and never signs. Its only writes are the owner's own archive (below).
//
//   verify <list file>: the owner, on his own computer, before he signs. It re-reads `Launchpad`, `LaunchBatch`, each
//     listed city's `Coin`, `Approval` and `TickerLock`, the old program's `Coin` and `Approval`, the configs and every
//     pending per-city `Approval`; checks the file's schema and rebuilds the tree from its entries (review MK-1);
//     re-checks every entry as the program will at launch (sdk/curve/batch.mjs `entryProblems`), and refuses a ticker
//     another city can still launch with, from its pending approval or from the batch in force (T87, review R7-BA-2);
//     prints the day's changes; and, when nothing is wrong, prints the unsigned `publish_launch_batch` transaction with
//     its message hash, or, with `--tx <base64>`, checks that the transaction the website's batch page built is exactly
//     that publication and prints its message hash (review R7-CONF-1). The list then goes to the archive's `pending/`
//     folder with the window of the transaction, never a baseline (reviews R7-BA-1, R7-3).
//     The day's changes are computed only against lists the owner signed and confirmed (`signed/`): while the stored
//     `latest` batch can still let founders launch, its archived record (number, root, leaf count, window and publisher)
//     must equal the stored one, else no transaction: a publication he did not confirm (`LATEST_NOT_ARCHIVED`), and the
//     same for the batch in force while `latest` is pending (`IN_FORCE_NOT_ARCHIVED`). Only with an empty archive (the
//     first use on a computer) may `--previous` / `--in-force` stand in, matched on the chain read from two RPCs of
//     different providers (`--rpc` twice, review R7-4); their entries are then printed in full, never used to hide one,
//     and every entry of the new list is listed as added. A `--previous` or `--in-force` file the chain does not hold is a
//     problem. When `latest` has ended (cleared, expired or a former approver's), every entry is a new approval.
//   confirm <seq> <root>: the owner, within minutes of each publication he signed (8.4 step 3). The stored `latest` must
//     be exactly a list in `pending/` (number, root, leaf count, window, the current approver as publisher), not cleared;
//     only then does the list move to `signed/`, the next day's baseline. Several pending lists for that number (one he
//     refused) are refused unless `--discard-others` moves them to `refused/`. Any difference: page the guardian.
//   check <list or archive file>: the monitor, after a publication. The stored `latest` record must be the file's batch:
//     its number, root and leaf count (and, for an archive entry the owner exported, its window and approver), a window
//     the program would have accepted, published by the current approver.
// The archive (`--archive <dir>`, default $VICINITY_BATCH_ARCHIVE or ~/.vicinity-curve/launch-batches; `--no-archive` for
// none) keeps `<program id>/pending/`, `signed/` and `refused/`; each entry carries an HMAC under `archive.key`, a random
// key created there on first use, so a file copied in from elsewhere (the website's list, say) is ignored.
//
// Usage (from solana/):
//   node scripts/vcurve/batch.mjs verify <list file> --rpc <url> [--rpc <url of another provider>] --approver <key>
//     [--tx <base64 of the page's unsigned transaction>] [--previous <list file>] [--in-force <list file>]
//     [--archive <dir> | --no-archive] [--cluster mainnet|devnet] [--program-id <id>] [--valid-from <unix> --valid-until <unix>]
//   node scripts/vcurve/batch.mjs confirm <seq> <root> --rpc <url> [--rpc <url>] [--archive <dir>] [--discard-others]
//     [--cluster mainnet|devnet] [--program-id <id>]
//   node scripts/vcurve/batch.mjs check <list or archive file> --rpc <url> [--cluster mainnet|devnet] [--program-id <id>]
// Every --rpc must be a provider the website does not operate or relay (8.4). Exit status 1 when a problem is found,
// 2 on a usage error.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import web3 from '@solana/web3.js';
import {
  ADDRESSES, ACCOUNT_DISCRIMINATORS, CURVE_PROGRAM_ID, INSTRUCTION_DISCRIMINATORS, curvePdas, curveInstructions, decodeLaunchpad, decodeLaunchBatch,
  decodeLaunchConfig, decodeApproval, decodeCurveCoin, decodeTickerLock, parseLaunchBatchFile, launchBatchFile, entryProblems, diffLaunchBatches,
  preparePublishLaunchBatch, publishWindowOk, batchInForce, tickerHolders, BatchError,
} from '../../sdk/curve/index.mjs';
import { toHex } from '../../sdk/merkle.mjs';

const { PublicKey } = web3;
const ZERO = ADDRESSES.system;
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const exists = (a) => Boolean(a) && (String(a.owner?.toBase58?.() ?? a.owner) !== ZERO || (a.data?.length ?? 0) > 0);

/** Every address `verify` reads for a list of entries: the Launchpad, LaunchBatch, the configs, and per city its accounts. */
export function batchAddresses(entries, { programId = CURVE_PROGRAM_ID, cluster = 'mainnet' } = {}) {
  const P = curvePdas({ programId, cluster });
  const out = { launchpad: P.launchpad(), launchBatch: P.launchBatch(), configs: new Map(), cities: new Map(), tickers: new Map() };
  for (const e of entries) {
    const cityId = BigInt(e.cityId);
    out.configs.set(Number(e.configId), P.config(Number(e.configId)));
    out.cities.set(cityId, { coin: P.coin(cityId), approval: P.approval(cityId), legacyCoin: P.legacyCoin(cityId), legacyApproval: P.legacyApproval(cityId) });
    out.tickers.set(e.symbol, P.ticker(e.symbol));
  }
  return out;
}
/** Every address of `batchAddresses` as one list (what `verify` and `check` fetch). */
export const allAddresses = (A) => [A.launchpad, A.launchBatch, ...A.configs.values(), ...[...A.cities.values()].flatMap((c) => Object.values(c)), ...A.tickers.values()];

/** The `chain` argument of `entryProblems` from the fetched accounts (`accounts`: address -> account or null). */
export function chainOf(A, accounts, { programId = CURVE_PROGRAM_ID, heldTickers = null } = {}) {
  const get = (k) => accounts[k] ?? null;
  const chain = { coins: new Set(), legacyCoins: new Set(), legacyApprovals: new Set(), approvals: new Set(), tickers: new Set(), configs: new Map(), heldTickers };
  for (const [id, addr] of A.configs) { const a = get(addr); if (exists(a)) chain.configs.set(id, decodeLaunchConfig(a, { programId })); }
  for (const [cityId, c] of A.cities) {
    if (exists(get(c.coin))) { decodeCurveCoin(get(c.coin), { programId }); chain.coins.add(cityId); }
    if (exists(get(c.approval))) { decodeApproval(get(c.approval), { programId }); chain.approvals.add(cityId); }
    if (exists(get(c.legacyCoin))) chain.legacyCoins.add(cityId);
    if (exists(get(c.legacyApproval))) chain.legacyApprovals.add(cityId);
  }
  for (const [symbol, addr] of A.tickers) if (exists(get(addr))) { decodeTickerLock(get(addr), { programId }); chain.tickers.add(symbol); }
  return chain;
}

/**
 * Whether a stored batch record can still let a founder launch, now or later (8.6): published (`seq > 0`), not cleared,
 * by the current launch approver (a rotation clears both records) and not expired. A record that is not live never
 * takes force again, so none of its entries can launch.
 */
export function recordLive(record, launchpad, now) {
  return Boolean(record && launchpad) && record.seq !== 0n && !record.cleared && record.publisher === launchpad.launchApprover
    && launchpad.launchApprover !== ZERO && BigInt(now) <= record.validUntil;
}
const iso = (t) => new Date(Number(t) * 1000).toISOString();
const recordText = (r) => `batch ${r.seq} (root ${toHex(r.root)}, ${r.leafCount} entries)`;
/** A stored record with its window, publisher and time of publication (review R7-3: printed next to the archived one). */
const recordDetail = (r) => `${recordText(r)}, window ${iso(r.validFrom)} to ${iso(r.validUntil)}, published by ${r.publisher}${r.publishedAt ? ` at ${iso(r.publishedAt)}` : ''}`;
const listText = (b) => `batch ${b.batchSeq} (root ${toHex(b.root)}, ${b.leafCount} entries)`;
/** A built list is the stored record: the same number, root and leaf count. */
const sameRecord = (b, r) => b.batchSeq === r.seq && toHex(b.root) === toHex(r.root) && b.leafCount === r.leafCount;
/** An archive entry is the stored record: its list, and the window and publisher of the transaction it was prepared for (review R7-3). */
export const sameArchived = (entry, r) => sameRecord(entry.list, r) && entry.record.validFrom === r.validFrom && entry.record.validUntil === r.validUntil && entry.record.publisher === r.publisher;
const endedWhy = (r, launchpad) => (r.cleared ? 'cleared' : r.publisher !== launchpad.launchApprover ? 'a former approver\'s' : 'expired');

// ---------------------------------------------------------------- the owner's archive (reviews R7-BA-1, R7-3)
export const ARCHIVE_KINDS = Object.freeze({ pending: 'vicinity_curve launch batch: verified, not yet confirmed', signed: 'vicinity_curve launch batch: signed and confirmed on chain' });
/**
 * An archive entry (without its MAC): the list file and the record it was prepared for or stored as (number, root,
 * leaf count, window, publisher), plus `extra` (when it was prepared, the message hash, when it was confirmed...).
 */
export function archiveEntry({ kind, file, record, extra = {} }) {
  if (!ARCHIVE_KINDS[kind]) throw new TypeError(`unknown archive kind ${kind}`);
  const list = parseLaunchBatchFile(file);
  const f = typeof file === 'string' ? JSON.parse(file) : file;
  return {
    kind: ARCHIVE_KINDS[kind], version: 1, programId: list.programId,
    record: { seq: String(list.batchSeq), root: toHex(list.root), leafCount: list.leafCount, validFrom: String(record.validFrom), validUntil: String(record.validUntil), publisher: String(record.publisher) },
    list: f, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v])),
  };
}
/**
 * An archive entry read back: `{ kind: 'pending' | 'signed', list (built), record: { validFrom, validUntil, publisher },
 * raw }`. Throws unless its list parses and its record names that list.
 */
export function parseArchiveEntry(entry) {
  const o = typeof entry === 'string' ? JSON.parse(entry) : entry;
  const kind = Object.keys(ARCHIVE_KINDS).find((k) => ARCHIVE_KINDS[k] === o?.kind);
  if (!kind || o.version !== 1) throw new Error('not an archive entry of this verifier');
  const list = parseLaunchBatchFile(o.list);
  const r = o.record ?? {};
  if (r.seq !== String(list.batchSeq) || r.root !== toHex(list.root) || r.leafCount !== list.leafCount) throw new Error('its record does not name its list');
  return { kind, list, record: { validFrom: BigInt(r.validFrom), validUntil: BigInt(r.validUntil), publisher: String(r.publisher) }, raw: o };
}
const asEntries = (xs, kind) => (xs ?? []).map((x) => { try { const e = x?.list?.levels ? x : parseArchiveEntry(x); return e.kind === kind ? e : null; } catch { return null; } }).filter(Boolean);

/**
 * Why a live stored record the owner never confirmed must be stopped: its text names the pending list it matches, if
 * any (a list he verified and then refused, or signed and did not confirm), and never suggests a way around the alarm.
 */
function notConfirmedMessage(r, prepared, what) {
  const exact = prepared.find((e) => sameArchived(e, r));
  const sameList = prepared.find((e) => sameRecord(e.list, r));
  const head = `the stored ${what}, ${recordDetail(r)}, is not a list you signed and confirmed on this computer`;
  if (exact) {
    return `${head}: it is a list you verified (prepared ${exact.raw.preparedAt ? iso(exact.raw.preparedAt) : 'earlier'}, window ${iso(exact.record.validFrom)} to ${iso(exact.record.validUntil)}) but never confirmed. `
      + `If you signed exactly that transaction, run: node scripts/vcurve/batch.mjs confirm ${r.seq} ${toHex(r.root)}. If you did not sign it, the approver key is stolen: `
      + 'have a guardian member clear it with halt now (guardian-stop.mjs --clear, 8.4 step 5)';
  }
  if (sameList) {
    return `${head}: it has the root of a list you verified, but the window or the signer of another transaction (yours was ${iso(sameList.record.validFrom)} to ${iso(sameList.record.validUntil)} for ${sameList.record.publisher}): `
      + 'a publication you did not sign, perhaps of a list you refused: have a guardian member clear it with halt now (guardian-stop.mjs --clear, 8.4 step 5)';
  }
  return `${head}: a publication nobody prepared here; have a guardian member clear it with halt now (guardian-stop.mjs --clear, 8.4 step 5). `
    + 'A list the website sends is never a substitute for your archive';
}

/**
 * The verifier on a snapshot. `file` is the list file (3.12; parsed or text); `archive` the owner's signed and confirmed
 * lists and `pending` the lists he verified but has not confirmed (archive entries, parsed or not; `archive` null or
 * empty: no archive); `previous` / `inForce` list files that may stand in only while the archive is empty (`chainConfirmed`:
 * the LaunchBatch and Launchpad accounts were read identically from two RPCs of different providers); `approvals` every
 * pending per-city `Approval` of the program, decoded (required: a ticker they hold is refused); `accounts` the fetched
 * accounts of `batchAddresses` (and the Coin accounts of the cities of the stored batches in force); `approver` the key
 * that will sign; `now` the chain clock; `validFrom` / `validUntil` the window (the page's transaction, or the default).
 * Returns `{ batch, problems, warnings, changes, changesInForce, ended, baseline, unconfirmed, publish }`: `changes` against
 * the stored `latest` list while it is live (or against nothing), `changesInForce` against the batch in force when it is
 * another, `ended` `{ seq, why, changes }` against an ended `latest` list for reference, `baseline` `{ seq, source }`,
 * `unconfirmed` the lists of live stored batches this computer has no record of signing (first use, printed in full);
 * `publish` (from `preparePublishLaunchBatch`) only when nothing is wrong.
 */
export function verifyListFile({
  file, previous = null, inForce = null, archive = null, pending = null, approvals, accounts, approver, now, validFrom, validUntil,
  chainConfirmed = false, programId = CURVE_PROGRAM_ID, cluster = 'mainnet',
}) {
  const problems = []; const warnings = [];
  const bad = (code, message) => { if (!problems.some((p) => p.code === code && p.message === message)) problems.push({ code, message }); };
  const warn = (code, message) => warnings.push({ code, message });
  const none = { batch: null, problems, warnings, changes: null, changesInForce: null, ended: null, baseline: null, unconfirmed: [], publish: null };
  let batch;
  try { batch = parseLaunchBatchFile(file); } catch (e) { bad('BAD_FILE', e.message); return none; }
  if (batch.programId !== String(programId)) bad('WRONG_PROGRAM', `the list was built for ${batch.programId}, not ${programId}`);
  const P = curvePdas({ programId, cluster });
  const A = batchAddresses(batch.entries, { programId, cluster });
  const lpAcc = accounts[A.launchpad]; const lbAcc = accounts[A.launchBatch];
  const launchpad = lpAcc ? decodeLaunchpad(lpAcc, { programId }) : null;
  const launchBatch = lbAcc ? decodeLaunchBatch(lbAcc, { programId }) : null;
  if (!launchpad) bad('NO_LAUNCHPAD', 'vicinity_curve is not initialised');
  if (!launchBatch) bad('NO_LAUNCH_BATCH', 'LaunchBatch does not exist (init_launch_batch, 8.4)');
  if (launchpad && launchpad.launchApprover === ZERO) bad('NO_APPROVER', 'no launch approver is set');
  if (launchpad && approver && launchpad.launchApprover !== ZERO && String(approver) !== launchpad.launchApprover) bad('NOT_APPROVER', `${approver} is not the launch approver ${launchpad.launchApprover}`);
  if (launchBatch?.halted) bad('BATCHES_HALTED', 'publication is halted until the admin sets the launch approver again');
  if (launchBatch && batch.batchSeq !== launchBatch.latest.seq + 1n) bad('WRONG_SEQ', `the list was built for batch ${batch.batchSeq}, the next number is ${launchBatch.latest.seq + 1n}`);
  if (launchpad?.launchesPaused) warn('LAUNCHES_PAUSED', 'launches are paused: no founder can launch until the admin resumes them');
  if (launchpad?.buysHalted) warn('BUYS_HALTED', 'buys are halted: no founder can launch until the admin clears the halt');

  // the baselines of the day's changes: only lists the owner signed and confirmed (reviews R6-DIFF-1, R6-RT-1, R7-BA-1, R7-3)
  const readList = (f, code) => {
    try {
      const b = parseLaunchBatchFile(f);
      if (b.programId !== String(programId)) { bad(code, `the list was built for ${b.programId}, not ${programId}`); return null; }
      return b;
    } catch (e) { bad(code, e.message); return null; }
  };
  const prevList = previous ? readList(previous, 'BAD_PREVIOUS') : null;
  const forceList = inForce ? readList(inForce, 'BAD_IN_FORCE') : null;
  const ofProgram = (e) => e.list.programId === String(programId);
  const signed = asEntries(archive, 'signed').filter(ofProgram);
  const prepared = asEntries(pending, 'pending').filter(ofProgram);
  const confirmed = (r) => signed.find((e) => sameArchived(e, r)) ?? null;
  const fileFor = (list, r) => (list && sameRecord(list, r) ? list : null);
  const oneRpc = () => bad('ONE_RPC', 'this computer\'s archive holds no list you confirmed, so a list file stands in for the stored batch: read the chain from two RPCs of different providers that the website does not operate (--rpc twice) so that one lying RPC cannot choose it (8.4, review R7-4)');
  let changes = diffLaunchBatches(null, batch); let changesInForce = null; let ended = null; let baseline = null;
  const unconfirmed = []; const holderLists = [];
  if (launchpad && launchBatch) {
    const L = launchBatch.latest;
    const t = BigInt(now);
    if (prevList && L.seq === 0n) {
      bad('PREVIOUS_NOT_ON_CHAIN', `no batch has been published, so there is no previous list; --previous ${listText(prevList)} is not on chain, and changes against it would hide its entries: do not sign`);
    } else if (prevList && !sameRecord(prevList, L)) {
      bad('PREVIOUS_NOT_ON_CHAIN', `--previous ${listText(prevList)} is not the stored ${recordText(L)}: changes against a list the chain does not hold would let a wrong website choose what you see as new: do not sign (8.4)`);
    }
    if (L.seq !== 0n && !signed.length && !chainConfirmed) oneRpc();
    if (L.seq !== 0n && signed.length && !chainConfirmed) warn('ONE_RPC', 'the chain was read from one RPC; a second --rpc of another provider would confirm it (8.4)');
    if (L.seq !== 0n) {
      const archivedL = confirmed(L);
      if (recordLive(L, launchpad, t)) {
        if (archivedL) { changes = diffLaunchBatches(archivedL.list, batch); baseline = { seq: L.seq, source: 'the archive' }; } else if (signed.length) {
          changes = null;
          bad('LATEST_NOT_ARCHIVED', notConfirmedMessage(L, prepared, `batch ${t < L.validFrom ? '(pending)' : '(in force)'}`));
        } else {
          const pl = fileFor(prevList, L);
          if (pl) unconfirmed.push({ seq: L.seq, state: t < L.validFrom ? 'pending' : 'in force', source: '--previous', entries: pl.entries });
          else if (!prevList) {
            changes = null;
            bad('NO_PREVIOUS', `the stored ${recordText(L)} can still let founders launch (${t < L.validFrom ? 'pending' : 'in force'}) and this computer's archive holds no list you confirmed: pass --previous <its list file>, which must match the chain read from two RPCs; its entries are then printed in full (8.4)`);
          }
        }
        // a stored batch in force now keeps its tickers until this list takes force (review R7-BA-2)
        const latestList = archivedL?.list ?? fileFor(prevList, L);
        if (t >= L.validFrom && latestList) holderLists.push({ seq: L.seq, entries: latestList.entries });
        // the batch in force while `latest` is pending: this list replaces `latest`, and `previous` stays in force until this list's valid_from
        const force = t < L.validFrom ? batchInForce(launchBatch, launchpad, t) : null;
        const Pr = force && force.seq !== L.seq ? force.record : null;
        if (Pr) {
          if (forceList && !sameRecord(forceList, Pr)) bad('IN_FORCE_NOT_ON_CHAIN', `--in-force ${listText(forceList)} is not the batch in force, ${recordText(Pr)}: do not sign`);
          const archivedP = confirmed(Pr);
          if (archivedP) changesInForce = { seq: Pr.seq, source: 'the archive', changes: diffLaunchBatches(archivedP.list, batch) };
          else if (signed.length) bad('IN_FORCE_NOT_ARCHIVED', notConfirmedMessage(Pr, prepared, 'batch in force'));
          else {
            const fl = fileFor(forceList, Pr);
            if (fl) unconfirmed.push({ seq: Pr.seq, state: 'in force', source: '--in-force', entries: fl.entries });
            else if (!forceList) bad('NO_IN_FORCE', `the stored batch ${L.seq} is still pending and this list replaces it, while ${recordText(Pr)} is in force until this list's valid_from: pass --in-force <its list file>, which must match the chain, to see what founders can launch now (8.4)`);
          }
          const pList = archivedP?.list ?? fileFor(forceList, Pr);
          if (pList) holderLists.push({ seq: Pr.seq, entries: pList.entries });
        } else if (forceList) bad('IN_FORCE_NOT_ON_CHAIN', `no batch other than the stored latest is in force, so --in-force ${listText(forceList)} is not one the chain puts in force: do not sign`);
      } else {
        if (signed.length && !archivedL) warn('LATEST_NOT_ARCHIVED', `the stored ${recordDetail(L)} is not a list you confirmed (it is ${endedWhy(L, launchpad)} and can let nobody launch)`);
        warn('LATEST_ENDED', `the stored ${recordText(L)} is ${endedWhy(L, launchpad)}: none of its entries can launch, so every entry of this list is a new approval and is listed as added`);
        const list = archivedL?.list ?? fileFor(prevList, L);
        if (list) ended = { seq: L.seq, why: endedWhy(L, launchpad), source: archivedL ? 'the archive' : '--previous', changes: diffLaunchBatches(list, batch) };
        if (forceList) bad('IN_FORCE_NOT_ON_CHAIN', `no batch is in force or pending, so --in-force ${listText(forceList)} is not one the chain puts in force: do not sign`);
      }
    } else if (forceList) bad('IN_FORCE_NOT_ON_CHAIN', `no batch has been published, so --in-force ${listText(forceList)} is not on chain: do not sign`);
  }
  if (unconfirmed.length) changes = diffLaunchBatches(null, batch);

  // every entry as the program will check it at launch, with the tickers other cities hold (T87, review R7-BA-2)
  if (approvals === undefined || approvals === null) bad('APPROVALS_UNREAD', 'the pending per-city approvals were not read: a ticker one of them holds cannot be checked (T87)');
  const holderCoins = new Set();
  for (const b of holderLists) for (const e of b.entries) if (exists(accounts[P.coin(BigInt(e.cityId))])) holderCoins.add(BigInt(e.cityId));
  const heldTickers = tickerHolders({ approvals: approvals ?? [], batches: holderLists, coins: holderCoins, now });
  const chain = chainOf(A, accounts, { programId, heldTickers });
  batch.entries.forEach((e, i) => {
    const p = entryProblems(e, { launchpad, chain });
    if (p.length) bad('BAD_ENTRY', `entry ${i} (city ${e.cityId}, ${e.symbol}, founder ${e.founder}): ${p.join('; ')}`);
  });
  let publish = null;
  if (!problems.length) {
    try {
      publish = preparePublishLaunchBatch({ batch, launchBatch, launchpad, approver, now, validFrom, validUntil, programId, cluster, ix: curveInstructions({ programId, cluster }) });
    } catch (e) { if (e instanceof BatchError) bad(`PREPARE_${e.code ?? 'FAILED'}`, e.message); else throw e; }
  }
  return { batch, problems, warnings, changes, changesInForce, ended, baseline, unconfirmed, publish };
}

/** The cities, beyond the list's own, whose Coin `verify` reads: those of the stored lists that may be in force (archive entries or files). */
export function holderCandidateEntries({ launchBatch, archive = [], previous = null, inForce = null, programId = CURVE_PROGRAM_ID }) {
  if (!launchBatch) return [];
  const seqs = new Set([launchBatch.latest.seq, launchBatch.previous.seq].filter((s) => s !== 0n));
  const out = [];
  for (const e of asEntries(archive, 'signed')) if (e.list.programId === String(programId) && seqs.has(e.list.batchSeq)) out.push(...e.list.entries);
  for (const f of [previous, inForce]) { if (!f) continue; try { out.push(...parseLaunchBatchFile(f).entries); } catch { /* reported by verifyListFile */ } }
  return out;
}

/** One entry as the owner reads it: the city, ticker, name, founder, config and the full metadata hash (review R6-DIFF-2). */
export const formatEntry = (e) => `city ${e.cityId} ${e.symbol} ${JSON.stringify(e.name)} founder ${e.founder} config ${e.configId} meta ${toHex(e.metaHash)}`;
/** The printed lines of one set of changes under `title`; each changed row names the fields that differ. */
export function formatChanges(changes, title) {
  const out = [`${title}: ${changes.added.length} added, ${changes.removed.length} removed, ${changes.changed.length} changed`];
  for (const e of changes.added) out.push(`  + ${formatEntry(e)}`);
  for (const e of changes.removed) out.push(`  - ${formatEntry(e)}`);
  for (const c of changes.changed) out.push(`  ~ ${formatEntry(c.before)}`, `    -> ${formatEntry(c.after)}`, `    changed: ${c.fields.join(', ')}`);
  return out;
}
/** Every line `verify` prints about the day's changes for a result of `verifyListFile`. */
export function changeLines(r) {
  const out = [];
  for (const u of r.unconfirmed ?? []) {
    out.push(`the stored batch ${u.seq} (${u.state}) is not a list this computer confirmed; its list from ${u.source}, matched on the chain, every entry of which can launch until this list takes force: ${u.entries.length} entries`);
    for (const e of u.entries) out.push(`  = ${formatEntry(e)}`);
  }
  if (r.changes) {
    out.push(...formatChanges(r.changes, r.baseline ? `changes against the stored batch ${r.baseline.seq} (its list from ${r.baseline.source})`
      : r.unconfirmed?.length ? 'changes against no confirmed list (every entry is listed as a new approval)' : 'changes against no live batch (every entry is a new approval)'));
  }
  if (r.changesInForce) out.push(...formatChanges(r.changesInForce.changes, `changes against batch ${r.changesInForce.seq}, in force until this list's valid_from (its list from ${r.changesInForce.source})`));
  if (r.ended) out.push(...formatChanges(r.ended.changes, `for reference, changes against the ${r.ended.why} batch ${r.ended.seq} (none of its entries can launch)`));
  return out;
}

// ---------------------------------------------------------------- the website's transaction (review R7-CONF-1)
/** SHA-256 of a message, base58: what a Ledger shows as the message hash when it blind-signs. */
export const messageHash = (messageBytes) => new PublicKey(createHash('sha256').update(Buffer.from(messageBytes)).digest()).toBase58();
/**
 * A transaction as base64 (legacy or v0), read for `verify --tx`: its message bytes, keys, header and instructions, and
 * the fields of its `publish_launch_batch` of `programId` (`publish`: `{ seq, root, leafCount, validFrom, validUntil }`, or
 * null). Throws when it is not a transaction.
 */
export function decodePageTransaction(base64, { programId = CURVE_PROGRAM_ID } = {}) {
  const bytes = Buffer.from(String(base64).trim(), 'base64');
  let vt;
  try { vt = web3.VersionedTransaction.deserialize(bytes); } catch (e) { throw new Error(`not a transaction: ${e.message}`); }
  const msg = vt.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const h = msg.header;
  const writable = (i) => (i < h.numRequiredSignatures ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < keys.length - h.numReadonlyUnsignedAccounts);
  const instructions = msg.compiledInstructions.map((ix) => ({
    program: keys[ix.programIdIndex], data: Buffer.from(ix.data),
    accounts: ix.accountKeyIndexes.map((i) => ({ address: keys[i], role: (i < h.numRequiredSignatures ? 2 : 0) + (writable(i) ? 1 : 0) })),
  }));
  const disc = Buffer.from(INSTRUCTION_DISCRIMINATORS.publish_launch_batch);
  const pubs = instructions.filter((x) => x.program === String(programId) && x.data.length >= 8 && x.data.subarray(0, 8).equals(disc));
  let publish = null;
  if (pubs.length === 1 && pubs[0].data.length === 8 + 8 + 32 + 4 + 8 + 8) {
    const d = pubs[0].data;
    publish = { seq: d.readBigUInt64LE(8), root: Uint8Array.from(d.subarray(16, 48)), leafCount: d.readUInt32LE(48), validFrom: d.readBigInt64LE(52), validUntil: d.readBigInt64LE(60) };
  }
  return { messageBytes: Buffer.from(msg.serialize()), keys, header: h, lookups: msg.addressTableLookups?.length ?? 0, instructions, publish };
}
/**
 * Whether the website's transaction (`decodePageTransaction`) is exactly the verified publication (`publish` from
 * `verifyListFile`, prepared with the transaction's window): one `publish_launch_batch` with the same accounts, roles
 * and data, the approver its fee payer and only signer, no lookup table, and nothing else but at most one compute-unit
 * limit and one compute-unit price within caps. Returns `{ problems, messageHash }`.
 */
export function checkPageTransaction(tx, publish, { approver }) {
  const problems = [];
  const bad = (code, message) => problems.push({ code, message });
  if (tx.lookups) bad('TX_LOOKUP_TABLES', 'the transaction loads accounts from lookup tables: the verifier cannot see them');
  if (tx.header.numRequiredSignatures !== 1 || tx.keys[0] !== String(approver)) bad('TX_SIGNERS', `the transaction must be paid and signed by the approver ${approver} alone, not by ${tx.keys.slice(0, tx.header.numRequiredSignatures).join(', ')}`);
  let pub = 0; let limit = 0; let price = 0;
  for (const ix of tx.instructions) {
    if (ix.program === COMPUTE_BUDGET && ix.accounts.length === 0 && ix.data[0] === 2 && ix.data.length === 5 && limit === 0 && ix.data.readUInt32LE(1) <= 1_400_000) { limit++; continue; }
    if (ix.program === COMPUTE_BUDGET && ix.accounts.length === 0 && ix.data[0] === 3 && ix.data.length === 9 && price === 0 && ix.data.readBigUInt64LE(1) <= 1_000_000n) { price++; continue; }
    if (ix.program === publish.instruction.programAddress && pub === 0) {
      pub++;
      const want = publish.instruction;
      if (!Buffer.from(ix.data).equals(Buffer.from(want.data))) bad('TX_NOT_VERIFIED', 'its publish_launch_batch is not the verified one (number, root, leaf count or window differ): do not sign');
      // the same accounts with the same roles; the fee payer (the approver) is writable in any message that it pays for
      const roleOk = (a, w) => a.role === w.role || (a.address === tx.keys[0] && (a.role | 1) === (w.role | 1));
      if (ix.accounts.length !== want.accounts.length || ix.accounts.some((a, i) => a.address !== want.accounts[i].address || !roleOk(a, want.accounts[i]))) bad('TX_ACCOUNTS', 'its publish_launch_batch names other accounts or roles than the verified one: do not sign');
      continue;
    }
    bad('TX_OTHER_INSTRUCTION', `it carries another instruction (${ix.program}): do not sign`);
  }
  if (pub !== 1) bad('TX_NO_PUBLICATION', 'it carries no publish_launch_batch of this program');
  return { problems, messageHash: messageHash(tx.messageBytes) };
}

// ---------------------------------------------------------------- the owner's confirmation and the monitor's check
/**
 * The owner's confirmation (8.4 step 3; review R7-BA-1): the stored `latest` must be batch `seq` with root `root`,
 * exactly a list in `pending` (number, root, leaf count, window, the current approver), published by the current
 * approver within a window the program accepts, not cleared, the path not halted; other pending lists of that number
 * (ones he verified and did not sign) are a problem unless `discardOthers`. Returns `{ problems, entry, others, already }`.
 */
export function confirmPublication({ seq, root, pending = [], archive = [], accounts, discardOthers = false, programId = CURVE_PROGRAM_ID, cluster = 'mainnet' }) {
  const problems = [];
  const bad = (code, message) => problems.push({ code, message });
  const P = curvePdas({ programId, cluster });
  const lp = accounts[P.launchpad()] ? decodeLaunchpad(accounts[P.launchpad()], { programId }) : null;
  const lb = accounts[P.launchBatch()] ? decodeLaunchBatch(accounts[P.launchBatch()], { programId }) : null;
  if (!lp || !lb) { bad('NO_ACCOUNTS', 'Launchpad or LaunchBatch missing'); return { problems, entry: null, others: [], already: false }; }
  const want = BigInt(seq); const rootHex = String(root).toLowerCase();
  const prepared = asEntries(pending, 'pending').filter((e) => e.list.programId === String(programId));
  const signed = asEntries(archive, 'signed').filter((e) => e.list.programId === String(programId));
  const L = lb.latest;
  const mine = prepared.filter((e) => e.list.batchSeq === want && toHex(e.list.root) === rootHex);
  const others = prepared.filter((e) => e.list.batchSeq === want && toHex(e.list.root) !== rootHex);
  if (!mine.length) bad('NOT_PREPARED', `no list you verified has number ${want} and root ${rootHex}`);
  if (L.seq !== want) bad('SEQ', `the stored batch is ${L.seq}, not ${want}: your publication did not land, or another replaced it (${recordDetail(L)})`);
  else if (toHex(L.root) !== rootHex) bad('ROOT', `the stored batch ${want} has root ${toHex(L.root)}, not ${rootHex}: a publication you did not sign (${recordDetail(L)})`);
  const entry = mine.find((e) => sameArchived(e, L)) ?? null;
  if (mine.length && L.seq === want && toHex(L.root) === rootHex && !entry) {
    bad('WINDOW', `the stored ${recordDetail(L)} is not the transaction you verified (${mine.map((e) => `window ${iso(e.record.validFrom)} to ${iso(e.record.validUntil)} for ${e.record.publisher}`).join('; ')}): a publication you did not sign`);
  }
  if (L.publisher !== lp.launchApprover) bad('PUBLISHER', `published by ${L.publisher}, the approver is ${lp.launchApprover}`);
  if (L.seq !== 0n && !publishWindowOk(L.publishedAt, L.validFrom, L.validUntil)) bad('WINDOW_REFUSED', `window ${L.validFrom}..${L.validUntil} published at ${L.publishedAt}`);
  if (L.cleared) bad('CLEARED', 'the stored batch is cleared: nothing to confirm');
  if (lb.halted) bad('HALTED', 'the batch path is halted');
  if (others.length && !discardOthers) {
    bad('SEVERAL_PENDING', `you also verified other lists for number ${want} (roots ${others.map((e) => toHex(e.list.root)).join(', ')}): if you signed only ${rootHex}, run again with --discard-others, which moves them to refused/ (never a baseline)`);
  }
  const already = Boolean(entry && signed.some((e) => sameArchived(e, L)));
  return { problems, entry, others, already };
}

/**
 * The monitor's check of the stored `latest` record against a list file or an archive entry the owner exported (8.4
 * step 3): with an archive entry the window and the approver must be the ones the owner verified (review R7-CONF-1).
 * Returns `{ problems }`.
 */
export function checkStoredBatch({ file, accounts, programId = CURVE_PROGRAM_ID, cluster = 'mainnet' }) {
  const problems = [];
  const bad = (code, message) => problems.push({ code, message });
  let batch; let archived = null;
  try {
    const o = typeof file === 'string' ? JSON.parse(file) : file;
    if (o && typeof o === 'object' && o.kind !== undefined) { archived = parseArchiveEntry(o); batch = archived.list; } else batch = parseLaunchBatchFile(o);
  } catch (e) { bad('BAD_FILE', e.message); return { problems }; }
  const P = curvePdas({ programId, cluster });
  const lp = accounts[P.launchpad()] ? decodeLaunchpad(accounts[P.launchpad()], { programId }) : null;
  const lb = accounts[P.launchBatch()] ? decodeLaunchBatch(accounts[P.launchBatch()], { programId }) : null;
  if (!lp || !lb) { bad('NO_ACCOUNTS', 'Launchpad or LaunchBatch missing'); return { problems }; }
  const r = lb.latest;
  if (r.seq !== batch.batchSeq) bad('SEQ', `the stored batch is ${r.seq}, the list is ${batch.batchSeq}`);
  if (toHex(r.root) !== toHex(batch.root)) bad('ROOT', `the stored root ${toHex(r.root)} is not the list's ${toHex(batch.root)}: a publication nobody prepared, or a wrong list (clear it, 8.4)`);
  if (r.leafCount !== batch.leafCount) bad('LEAF_COUNT', `the stored leaf count ${r.leafCount} is not the list's ${batch.leafCount}`);
  if (archived && (r.validFrom !== archived.record.validFrom || r.validUntil !== archived.record.validUntil)) bad('NOT_THE_VERIFIED_WINDOW', `the stored window ${iso(r.validFrom)} to ${iso(r.validUntil)} is not the one the owner verified (${iso(archived.record.validFrom)} to ${iso(archived.record.validUntil)})`);
  if (archived && r.publisher !== archived.record.publisher) bad('NOT_THE_VERIFIED_SIGNER', `published by ${r.publisher}, the owner verified a publication by ${archived.record.publisher}`);
  if (r.publisher !== lp.launchApprover) bad('PUBLISHER', `published by ${r.publisher}, the approver is ${lp.launchApprover}`);
  if (!publishWindowOk(r.publishedAt, r.validFrom, r.validUntil)) bad('WINDOW', `window ${r.validFrom}..${r.validUntil} published at ${r.publishedAt}`);
  if (r.cleared) bad('CLEARED', 'the stored batch is cleared');
  if (lb.halted) bad('HALTED', 'the batch path is halted');
  return { problems };
}

// ---------------------------------------------------------------- the archive on disk
/** The archive directory: `--archive`, else $VICINITY_BATCH_ARCHIVE, else ~/.vicinity-curve/launch-batches; null with `--no-archive`. */
export const archiveDir = (o, env = process.env) => (o.noArchive ? null : (o.archive ?? env.VICINITY_BATCH_ARCHIVE ?? join(homedir(), '.vicinity-curve', 'launch-batches')));
/** The archive's MAC key (`<dir>/archive.key`, 32 random bytes in hex, created on first use when `create`), or null. */
export function archiveKey(dir, { create = false } = {}) {
  const p = join(dir, 'archive.key');
  if (!existsSync(p)) {
    if (!create) return null;
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  return Buffer.from(readFileSync(p, 'utf8').trim(), 'hex');
}
const macOf = (key, entry) => createHmac('sha256', key).update(JSON.stringify(entry)).digest('hex');
/** Read the archive of `programId`: `{ signed, pending, ignored: [{ name, why }] }`, each entry checked against the archive's key. */
export function readArchive(dir, programId) {
  const out = { signed: [], pending: [], ignored: [] };
  const key = archiveKey(dir);
  for (const sub of ['signed', 'pending']) {
    const d = join(dir, String(programId), sub);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d).filter((n) => n.endsWith('.json')).sort()) {
      try {
        const { mac, ...entry } = JSON.parse(readFileSync(join(d, name), 'utf8'));
        if (!key || typeof mac !== 'string' || mac !== macOf(key, entry)) throw new Error('not written by this archive (no valid MAC): a file copied in is never a baseline');
        const e = parseArchiveEntry(entry);
        if (e.kind !== sub) throw new Error(`a ${e.kind} entry in ${sub}/`);
        out[sub].push({ ...e, path: join(d, name) });
      } catch (e) { out.ignored.push({ name: join(sub, name), why: e.message }); }
    }
  }
  return out;
}
/** Write an archive entry under `<dir>/<program>/<sub>/<name>` with its MAC; returns the path. */
export function writeArchiveEntry(dir, sub, name, entry) {
  const key = archiveKey(dir, { create: true });
  const d = join(dir, entry.programId, sub);
  mkdirSync(d, { recursive: true });
  const path = join(d, name);
  writeFileSync(path, JSON.stringify({ ...entry, mac: macOf(key, entry) }, null, 1));
  return path;
}

// ---------------------------------------------------------------- the command line
async function fetchAccounts(connection, addresses) {
  const out = {};
  for (let i = 0; i < addresses.length; i += 100) {
    const part = addresses.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(part.map((k) => new PublicKey(k)));
    part.forEach((k, n) => { const a = infos[n]; out[k] = a ? { address: k, owner: a.owner.toBase58(), lamports: BigInt(a.lamports), data: Buffer.from(a.data) } : null; });
  }
  return out;
}
const sameAccount = (x, y) => (x === null || y === null ? x === y : x.owner === y.owner && Buffer.from(x.data).equals(Buffer.from(y.data)));
/** Every pending per-city `Approval` of the program (getProgramAccounts on its discriminator), decoded. */
async function fetchApprovals(connection, programId) {
  const rows = await connection.getProgramAccounts(new PublicKey(programId), { filters: [{ memcmp: { offset: 0, bytes: base58(ACCOUNT_DISCRIMINATORS.Approval) } }] });
  return rows.map((x) => decodeApproval({ owner: x.account.owner.toBase58(), data: Buffer.from(x.account.data) }, { programId }));
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = `1${s}`; }
  return s;
}
/** The Launchpad and LaunchBatch from every RPC: `{ accounts, agree }` (the first RPC's view, and whether all agree). */
async function readHeads(connections, P) {
  const head = [P.launchpad(), P.launchBatch()];
  const views = await Promise.all(connections.map((c) => fetchAccounts(c, head)));
  return { accounts: views[0], agree: views.every((v) => head.every((k) => sameAccount(v[k], views[0][k]))) };
}

const USAGE = 'usage: node scripts/vcurve/batch.mjs verify <list file> --rpc <url> [--rpc <url of another provider>] --approver <key> [--tx <base64>] '
  + '[--previous <list file>] [--in-force <list file>] [--archive <dir> | --no-archive] [--cluster mainnet|devnet] [--program-id <id>] [--valid-from <unix> --valid-until <unix>]\n'
  + '       node scripts/vcurve/batch.mjs confirm <seq> <root> --rpc <url> [--rpc <url>] [--archive <dir>] [--discard-others] [--cluster mainnet|devnet] [--program-id <id>]\n'
  + '       node scripts/vcurve/batch.mjs check <list or archive file> --rpc <url> [--cluster mainnet|devnet] [--program-id <id>]';
const FLAGS = new Map([['--rpc', 'rpc'], ['--approver', 'approver'], ['--previous', 'previous'], ['--in-force', 'inForce'], ['--archive', 'archive'], ['--cluster', 'cluster'],
  ['--program-id', 'programId'], ['--valid-from', 'validFrom'], ['--valid-until', 'validUntil'], ['--tx', 'tx']]);
const BOOL_FLAGS = new Map([['--no-archive', 'noArchive'], ['--discard-others', 'discardOthers']]);
const ALLOWED = {
  verify: new Set(['rpc', 'approver', 'previous', 'inForce', 'archive', 'noArchive', 'cluster', 'programId', 'validFrom', 'validUntil', 'tx']),
  confirm: new Set(['rpc', 'archive', 'discardOthers', 'cluster', 'programId']),
  check: new Set(['rpc', 'cluster', 'programId']),
};

/** The CLI's options, or `{ error }`. `rpc` is the list of RPC URLs (one or two). */
export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (!ALLOWED[mode]) return { error: 'a mode (verify, confirm or check) is required' };
  const nPos = mode === 'confirm' ? 2 : 1;
  const pos = rest.slice(0, nPos);
  if (pos.length < nPos || pos.some((x) => x.startsWith('--'))) return { error: mode === 'confirm' ? 'confirm takes the number and the root of the batch you signed' : `${mode} takes a file` };
  const o = mode === 'confirm' ? { mode, seq: pos[0], root: pos[1] } : { mode, file: pos[0] };
  const opts = rest.slice(nPos);
  for (let i = 0; i < opts.length; i++) {
    if (BOOL_FLAGS.has(opts[i])) { o[BOOL_FLAGS.get(opts[i])] = true; continue; }
    if (!FLAGS.has(opts[i])) return { error: `unknown option ${opts[i]}` };
    const v = opts[++i];
    if (v === undefined || v.startsWith('--')) return { error: `${opts[i - 1]} needs a value` };
    const k = FLAGS.get(opts[i - 1]);
    if (k === 'rpc') (o.rpc ??= []).push(v); else o[k] = v;
  }
  const extra = Object.keys(o).filter((k) => !['mode', 'file', 'seq', 'root'].includes(k) && !ALLOWED[mode].has(k));
  if (extra.length) return { error: `${mode} takes no ${extra.join(', ')}` };
  if (!o.rpc) return { error: '--rpc is required' };
  if (o.rpc.length > 2 || new Set(o.rpc).size !== o.rpc.length) return { error: '--rpc once, or twice with two different providers' };
  if (mode === 'verify' && !o.approver) return { error: 'verify needs --approver (the key that will sign)' };
  if ((o.validFrom === undefined) !== (o.validUntil === undefined)) return { error: '--valid-from and --valid-until go together' };
  if (o.tx !== undefined && o.validFrom !== undefined) return { error: '--tx carries its own window: no --valid-from or --valid-until' };
  if (o.archive !== undefined && o.noArchive) return { error: '--archive and --no-archive exclude each other' };
  if (mode === 'confirm' && (!/^[1-9][0-9]*$/.test(o.seq) || !/^[0-9a-fA-F]{64}$/.test(o.root))) return { error: 'confirm takes a batch number and a 64-digit hex root' };
  if (o.approver) { try { o.approver = new PublicKey(o.approver).toBase58(); } catch { return { error: `--approver: not a public key: ${o.approver}` }; } }
  return o;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.error) { console.error(`${o.error}\n${USAGE}`); return 2; }
  const cluster = o.cluster ?? 'mainnet'; const programId = o.programId ?? CURVE_PROGRAM_ID;
  const P = curvePdas({ programId, cluster });
  const connections = o.rpc.map((u) => new web3.Connection(u, 'confirmed'));
  const page = (n) => console.log(`${n} problem(s): page the guardian members; have one clear the batch with halt (guardian-stop.mjs --clear) if it is not the one you signed (8.4)`);

  if (o.mode === 'confirm') {
    const dir = archiveDir(o);
    const arch = readArchive(dir, programId);
    for (const x of arch.ignored) console.log(`warning ARCHIVE_IGNORED: ${x.name}: ${x.why}`);
    const heads = await readHeads(connections, P);
    if (!heads.agree) { console.log('PROBLEM RPC_DISAGREE: the RPCs return different Launchpad or LaunchBatch accounts: one of them is lying or behind; retry, then page the guardian members'); return 1; }
    const r = confirmPublication({ seq: o.seq, root: o.root, pending: arch.pending, archive: arch.signed, accounts: heads.accounts, discardOthers: Boolean(o.discardOthers), programId, cluster });
    for (const p of r.problems) console.log(`PROBLEM ${p.code}: ${p.message}`);
    if (r.problems.length) { page(r.problems.length); return 1; }
    const L = decodeLaunchBatch(heads.accounts[P.launchBatch()], { programId }).latest;
    if (!r.already) {
      const path = writeArchiveEntry(dir, 'signed', `${L.seq}-${toHex(L.root)}.json`, archiveEntry({ kind: 'signed', file: r.entry.raw.list, record: { ...r.entry.record },
        extra: { preparedAt: r.entry.raw.preparedAt, messageHash: r.entry.raw.messageHash, publishedAt: L.publishedAt, confirmedAt: BigInt(Math.floor(Date.now() / 1000)) } }));
      console.log(`confirmed: ${recordDetail(L)} is the list you verified; kept as the next baseline: ${path}`);
    } else console.log(`already confirmed: ${recordDetail(L)}`);
    for (const e of arch.pending.filter((x) => x.list.batchSeq === L.seq)) {
      if (toHex(e.list.root) === toHex(L.root)) unlinkSync(e.path);
      else { mkdirSync(join(dir, programId, 'refused'), { recursive: true }); renameSync(e.path, join(dir, programId, 'refused', e.path.split('/').pop())); console.log(`moved to refused/: batch ${e.list.batchSeq} root ${toHex(e.list.root)}`); }
    }
    return 0;
  }

  const file = readFileSync(o.file, 'utf8');
  if (o.mode === 'check') {
    let entries = [];
    try { const x = JSON.parse(file); entries = (x.kind !== undefined ? parseArchiveEntry(x).list : parseLaunchBatchFile(x)).entries; } catch { /* reported by checkStoredBatch */ }
    const accounts = await fetchAccounts(connections[0], allAddresses(batchAddresses(entries, { programId, cluster })));
    const { problems } = checkStoredBatch({ file, accounts, programId, cluster });
    for (const p of problems) console.log(`PROBLEM ${p.code}: ${p.message}`);
    if (problems.length) page(problems.length); else console.log('the stored batch is the list');
    return problems.length ? 1 : 0;
  }

  let parsed;
  try { parsed = parseLaunchBatchFile(file); } catch (e) {
    console.log(`PROBLEM BAD_FILE: ${e.message}`);
    console.log('1 problem(s): do not sign');
    return 1;
  }
  let pageTx = null;
  if (o.tx !== undefined) {
    try { pageTx = decodePageTransaction(o.tx, { programId }); } catch (e) { console.log(`PROBLEM BAD_TX: ${e.message}\n1 problem(s): do not sign`); return 1; }
    if (!pageTx.publish) { console.log('PROBLEM TX_NO_PUBLICATION: the transaction carries no single publish_launch_batch of this program\n1 problem(s): do not sign'); return 1; }
  }
  const dir = archiveDir(o);
  const arch = dir ? readArchive(dir, programId) : { signed: [], pending: [], ignored: [] };
  for (const x of arch.ignored) console.log(`warning ARCHIVE_IGNORED: ${x.name}: ${x.why}`);
  const heads = await readHeads(connections, P);
  if (!heads.agree) { console.log('PROBLEM RPC_DISAGREE: the RPCs return different Launchpad or LaunchBatch accounts: one of them is lying or behind; retry, and do not sign until they agree'); return 1; }
  const lb = heads.accounts[P.launchBatch()] ? decodeLaunchBatch(heads.accounts[P.launchBatch()], { programId }) : null;
  const previous = o.previous ? readFileSync(o.previous, 'utf8') : null;
  const inForce = o.inForce ? readFileSync(o.inForce, 'utf8') : null;
  const extra = holderCandidateEntries({ launchBatch: lb, archive: arch.signed, previous, inForce, programId });
  const accounts = { ...(await fetchAccounts(connections[0], allAddresses(batchAddresses([...parsed.entries, ...extra], { programId, cluster })))), ...heads.accounts };
  const approvals = await fetchApprovals(connections[0], programId);
  const now = BigInt(await connections[0].getBlockTime(await connections[0].getSlot('confirmed')));
  const r = verifyListFile({
    file, previous, inForce, archive: arch.signed, pending: arch.pending, approvals, accounts, approver: o.approver, now, chainConfirmed: connections.length >= 2,
    validFrom: pageTx ? pageTx.publish.validFrom : o.validFrom, validUntil: pageTx ? pageTx.publish.validUntil : o.validUntil, programId, cluster,
  });
  for (const w of r.warnings) console.log(`warning ${w.code}: ${w.message}`);
  for (const p of r.problems) console.log(`PROBLEM ${p.code}: ${p.message}`);
  for (const line of changeLines(r)) console.log(line);
  if (!r.publish) { console.log(`${r.problems.length} problem(s): do not sign`); return 1; }
  const p = r.publish;
  let hash; let text = null;
  if (pageTx) {
    const c = checkPageTransaction(pageTx, p, { approver: o.approver });
    for (const x of c.problems) console.log(`PROBLEM ${x.code}: ${x.message}`);
    if (c.problems.length) { console.log(`${c.problems.length} problem(s): do not sign`); return 1; }
    hash = c.messageHash;
  } else {
    const { blockhash } = await connections[0].getLatestBlockhash('confirmed');
    const ix = new web3.TransactionInstruction({ programId: new PublicKey(p.instruction.programAddress), data: Buffer.from(p.instruction.data),
      keys: p.instruction.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })) });
    const tx = new web3.Transaction({ feePayer: new PublicKey(o.approver), recentBlockhash: blockhash }).add(ix);
    hash = messageHash(tx.serializeMessage());
    text = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }
  if (dir) {
    const path = writeArchiveEntry(dir, 'pending', `${p.seq}-${toHex(p.root)}-${p.validFrom}.json`, archiveEntry({ kind: 'pending', file: launchBatchFile(r.batch),
      record: { validFrom: p.validFrom, validUntil: p.validUntil, publisher: o.approver }, extra: { preparedAt: now, messageHash: hash } }));
    console.log(`kept as pending (never a baseline until you confirm it): ${path}`);
  }
  console.log(`batch ${p.seq}, ${p.leafCount} entries, root ${toHex(p.root)}\nvalid from ${iso(p.validFrom)} until ${iso(p.validUntil)}`);
  console.log(`message hash ${hash}: sign only on a hardware wallet that shows this message hash (blind signing); any other hash is another transaction`);
  if (text) console.log(`unsigned publish_launch_batch for ${o.approver} (base64; valid for about a minute, until its blockhash expires):\n${text}`);
  else console.log('the website\'s transaction is exactly this publication');
  console.log(`within minutes of its landing, run: node scripts/vcurve/batch.mjs confirm ${p.seq} ${toHex(p.root)} --rpc <url>`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
