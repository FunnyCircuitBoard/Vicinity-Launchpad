#!/usr/bin/env node
// The owner's batch verifier and the monitor's check (VICINITY-CURVE-DESIGN.md 8.4 steps 2 and 3, 8.6, 14.1; NOTES 76,
// 78 to 80). It reads the chain and the list files and prints; it never holds or asks for a key and never signs. Its only write
// is the owner's own archive of the lists he verified (below).
//
//   verify <list file>: the owner, on his own computer, before he signs. It re-reads `Launchpad`, `LaunchBatch`, each
//     listed city's `Coin`, `Approval` and `TickerLock`, the old program's `Coin` and `Approval`, and the configs;
//     checks the file's schema and rebuilds the tree from its entries, refusing a file whose root is not its entries'
//     (review MK-1: a missing or misspelt field is refused, never filled in); re-checks every entry as the program will
//     at launch (sdk/curve/batch.mjs `entryProblems`: the founder key against every role, the name, the ticker, the
//     metadata hash, the config enabled, no coin here or in the old program, no pending approval, no locked ticker);
//     prints the day's changes; and, when nothing is wrong, prints the unsigned `publish_launch_batch` transaction
//     (`seq = latest.seq + 1`, the window of O31 unless given) for the approver's wallet, with the root, number and
//     window to compare, and keeps the list in the archive.
//     The day's changes are computed only against lists the chain holds (reviews R6-DIFF-1, R6-RT-1): while the stored
//     `latest` batch can still let founders launch (not cleared, by the current approver, not expired), its list is
//     required, from the archive or `--previous`, and must have its number, root and leaf count; when `latest` is still
//     pending and the batch in force is `previous`, the changes against that list are shown too (from the archive or
//     `--in-force`, which must match `previous`). A `--previous` or `--in-force` file the chain does not hold is a
//     problem, never a baseline, so a compromised website cannot choose what the owner sees as new. When `latest` has
//     ended (cleared, expired or a former approver's), every entry is a new approval and is listed as added.
//     The archive (`--archive <dir>`, default $VICINITY_BATCH_ARCHIVE or ~/.vicinity-curve/launch-batches; `--no-archive`
//     to go without) holds every list this computer verified, by program, number and root; once it holds any list, a
//     live stored batch it does not hold is a problem (a publication nobody prepared here: clear it, 8.4).
//   check <list file>: the monitor, after a publication. The stored `latest` record must be the file's batch: its
//     number, root and leaf count, a window the program would have accepted, published by the current approver.
//
// Usage (from solana/):
//   node scripts/vcurve/batch.mjs verify <list file> --rpc <url> --approver <key> [--previous <list file>]
//     [--in-force <list file>] [--archive <dir> | --no-archive] [--cluster mainnet|devnet] [--program-id <id>]
//     [--valid-from <unix seconds> --valid-until <unix seconds>]
//   node scripts/vcurve/batch.mjs check <list file> --rpc <url> [--cluster mainnet|devnet] [--program-id <id>]
// Exit status 1 when a problem is found, 2 on a usage error.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import web3 from '@solana/web3.js';
import {
  ADDRESSES, CURVE_PROGRAM_ID, curvePdas, curveInstructions, decodeLaunchpad, decodeLaunchBatch, decodeLaunchConfig, decodeApproval,
  decodeCurveCoin, decodeTickerLock, parseLaunchBatchFile, entryProblems, diffLaunchBatches, preparePublishLaunchBatch, publishWindowOk,
  batchInForce, BatchError,
} from '../../sdk/curve/index.mjs';
import { toHex } from '../../sdk/merkle.mjs';

const { PublicKey } = web3;
const ZERO = ADDRESSES.system;
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
export function chainOf(A, accounts, { programId = CURVE_PROGRAM_ID } = {}) {
  const get = (k) => accounts[k] ?? null;
  const chain = { coins: new Set(), legacyCoins: new Set(), legacyApprovals: new Set(), approvals: new Set(), tickers: new Set(), configs: new Map() };
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
const recordText = (r) => `batch ${r.seq} (root ${toHex(r.root)}, ${r.leafCount} entries)`;
const listText = (b) => `batch ${b.batchSeq} (root ${toHex(b.root)}, ${b.leafCount} entries)`;
/** A built list is the stored record: the same number, root and leaf count. */
const sameRecord = (b, r) => b.batchSeq === r.seq && toHex(b.root) === toHex(r.root) && b.leafCount === r.leafCount;
const endedWhy = (r, launchpad) => (r.cleared ? 'cleared' : r.publisher !== launchpad.launchApprover ? 'a former approver\'s' : 'expired');

/**
 * The verifier on a snapshot. `file` is the list file (3.12; parsed or text); `previous` the list of the stored `latest`
 * batch and `inForce` the list of the stored `previous` batch while it is in force and `latest` pending (each optional,
 * and refused unless the chain holds it); `archive` the lists this computer verified before (files or built batches;
 * null or empty: no archive); `accounts` the fetched accounts of `batchAddresses`; `approver` the key that will sign;
 * `now` the chain clock. Returns `{ batch, problems, warnings, changes, changesInForce, ended, baseline, publish }`:
 * `changes` against the stored `latest` list while it is live (or against nothing), `changesInForce` against the batch in
 * force when it is another, `ended` `{ seq, why, changes }` against an ended `latest` list for reference, `baseline`
 * `{ seq, source }`; `publish` (from `preparePublishLaunchBatch`) only when nothing is wrong.
 */
export function verifyListFile({ file, previous = null, inForce = null, archive = null, accounts, approver, now, validFrom, validUntil, programId = CURVE_PROGRAM_ID, cluster = 'mainnet' }) {
  const problems = []; const warnings = [];
  const bad = (code, message) => problems.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });
  const none = { batch: null, problems, warnings, changes: null, changesInForce: null, ended: null, baseline: null, publish: null };
  let batch;
  try { batch = parseLaunchBatchFile(file); } catch (e) { bad('BAD_FILE', e.message); return none; }
  if (batch.programId !== String(programId)) bad('WRONG_PROGRAM', `the list was built for ${batch.programId}, not ${programId}`);
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
  const chain = chainOf(A, accounts, { programId });
  batch.entries.forEach((e, i) => {
    const p = entryProblems(e, { launchpad, chain });
    if (p.length) bad('BAD_ENTRY', `entry ${i} (city ${e.cityId}, ${e.symbol}, founder ${e.founder}): ${p.join('; ')}`);
  });

  // The baselines of the day's changes, anchored to the chain (reviews R6-DIFF-1, R6-RT-1).
  const readList = (f, code) => {
    try {
      const b = parseLaunchBatchFile(f);
      if (b.programId !== String(programId)) { bad(code, `the list was built for ${b.programId}, not ${programId}`); return null; }
      return b;
    } catch (e) { bad(code, e.message); return null; }
  };
  const prevList = previous ? readList(previous, 'BAD_PREVIOUS') : null;
  const forceList = inForce ? readList(inForce, 'BAD_IN_FORCE') : null;
  const archived = [];
  for (const f of archive ?? []) {
    try { const b = f?.levels ? f : parseLaunchBatchFile(f); if (b.programId === String(programId)) archived.push(b); } catch { /* not a list of this program */ }
  }
  const fromArchive = (r) => archived.find((b) => sameRecord(b, r)) ?? null;
  let changes = diffLaunchBatches(null, batch); let changesInForce = null; let ended = null; let baseline = null;
  if (launchpad && launchBatch) {
    const L = launchBatch.latest;
    const t = BigInt(now);
    if (prevList && L.seq === 0n) {
      bad('PREVIOUS_NOT_ON_CHAIN', `no batch has been published, so there is no previous list; --previous ${listText(prevList)} is not on chain, and changes against it would hide its entries: do not sign`);
    } else if (prevList && !sameRecord(prevList, L)) {
      bad('PREVIOUS_NOT_ON_CHAIN', `--previous ${listText(prevList)} is not the stored ${recordText(L)}: changes against a list the chain does not hold would let a wrong website choose what you see as new: do not sign (8.4)`);
    }
    if (L.seq !== 0n) {
      const list = prevList && sameRecord(prevList, L) ? prevList : fromArchive(L);
      const source = list === prevList && list ? '--previous' : 'the archive';
      if (archived.length && !fromArchive(L)) {
        const text = `the stored ${recordText(L)} is not a list this computer verified`;
        if (recordLive(L, launchpad, t)) bad('LATEST_NOT_ARCHIVED', `${text}: if nobody prepared it on another computer, it is a publication nobody prepared: clear it (8.4); if it was prepared elsewhere, put its list file in the archive or run with --no-archive`);
        else warn('LATEST_NOT_ARCHIVED', `${text} (it is ${endedWhy(L, launchpad)} and can let nobody launch)`);
      }
      if (recordLive(L, launchpad, t)) {
        if (list) { changes = diffLaunchBatches(list, batch); baseline = { seq: L.seq, source }; } else {
          changes = null;
          if (!prevList) bad('NO_PREVIOUS', `the stored ${recordText(L)} can still let founders launch (${t < L.validFrom ? 'pending' : 'in force'}): the day's changes need its list: pass --previous <its list file>, which must match the chain (8.4)`);
        }
        // the batch in force while `latest` is pending: this list replaces `latest`, and `previous` stays in force until this list's valid_from
        const force = t < L.validFrom ? batchInForce(launchBatch, launchpad, t) : null;
        const P = force && force.seq !== L.seq ? force.record : null;
        if (P) {
          if (forceList && !sameRecord(forceList, P)) bad('IN_FORCE_NOT_ON_CHAIN', `--in-force ${listText(forceList)} is not the batch in force, ${recordText(P)}: do not sign`);
          const pl = forceList && sameRecord(forceList, P) ? forceList : fromArchive(P);
          if (pl) changesInForce = { seq: P.seq, source: pl === forceList ? '--in-force' : 'the archive', changes: diffLaunchBatches(pl, batch) };
          else if (!forceList) bad('NO_IN_FORCE', `the stored batch ${L.seq} is still pending and this list replaces it, while ${recordText(P)} is in force until this list's valid_from: pass --in-force <its list file>, which must match the chain, to see the changes against what founders can launch now (8.4)`);
        } else if (forceList) bad('IN_FORCE_NOT_ON_CHAIN', `no batch other than the stored latest is in force, so --in-force ${listText(forceList)} is not one the chain puts in force: do not sign`);
      } else {
        warn('LATEST_ENDED', `the stored ${recordText(L)} is ${endedWhy(L, launchpad)}: none of its entries can launch, so every entry of this list is a new approval and is listed as added`);
        if (list) ended = { seq: L.seq, why: endedWhy(L, launchpad), source, changes: diffLaunchBatches(list, batch) };
        if (forceList) bad('IN_FORCE_NOT_ON_CHAIN', `no batch is in force or pending, so --in-force ${listText(forceList)} is not one the chain puts in force: do not sign`);
      }
    } else if (forceList) bad('IN_FORCE_NOT_ON_CHAIN', `no batch has been published, so --in-force ${listText(forceList)} is not on chain: do not sign`);
  }
  let publish = null;
  if (!problems.length) {
    try {
      publish = preparePublishLaunchBatch({ batch, launchBatch, launchpad, approver, now, validFrom, validUntil, programId, cluster, ix: curveInstructions({ programId, cluster }) });
    } catch (e) { if (e instanceof BatchError) bad(`PREPARE_${e.code ?? 'FAILED'}`, e.message); else throw e; }
  }
  return { batch, problems, warnings, changes, changesInForce, ended, baseline, publish };
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
  if (r.changes) out.push(...formatChanges(r.changes, r.baseline ? `changes against the stored batch ${r.baseline.seq} (its list from ${r.baseline.source})` : 'changes against no live batch (every entry is a new approval)'));
  if (r.changesInForce) out.push(...formatChanges(r.changesInForce.changes, `changes against batch ${r.changesInForce.seq}, in force until this list's valid_from (its list from ${r.changesInForce.source})`));
  if (r.ended) out.push(...formatChanges(r.ended.changes, `for reference, changes against the ${r.ended.why} batch ${r.ended.seq} (none of its entries can launch)`));
  return out;
}

/** The monitor's check of the stored `latest` record against the list file (8.4 step 3). Returns `{ problems }`. */
export function checkStoredBatch({ file, accounts, programId = CURVE_PROGRAM_ID, cluster = 'mainnet' }) {
  const problems = [];
  const bad = (code, message) => problems.push({ code, message });
  let batch;
  try { batch = parseLaunchBatchFile(file); } catch (e) { bad('BAD_FILE', e.message); return { problems }; }
  const P = curvePdas({ programId, cluster });
  const lp = accounts[P.launchpad()] ? decodeLaunchpad(accounts[P.launchpad()], { programId }) : null;
  const lb = accounts[P.launchBatch()] ? decodeLaunchBatch(accounts[P.launchBatch()], { programId }) : null;
  if (!lp || !lb) { bad('NO_ACCOUNTS', 'Launchpad or LaunchBatch missing'); return { problems }; }
  const r = lb.latest;
  if (r.seq !== batch.batchSeq) bad('SEQ', `the stored batch is ${r.seq}, the list is ${batch.batchSeq}`);
  if (toHex(r.root) !== toHex(batch.root)) bad('ROOT', `the stored root ${toHex(r.root)} is not the list's ${toHex(batch.root)}: a publication nobody prepared, or a wrong list (clear it, 8.4)`);
  if (r.leafCount !== batch.leafCount) bad('LEAF_COUNT', `the stored leaf count ${r.leafCount} is not the list's ${batch.leafCount}`);
  if (r.publisher !== lp.launchApprover) bad('PUBLISHER', `published by ${r.publisher}, the approver is ${lp.launchApprover}`);
  if (!publishWindowOk(r.publishedAt, r.validFrom, r.validUntil)) bad('WINDOW', `window ${r.validFrom}..${r.validUntil} published at ${r.publishedAt}`);
  if (r.cleared) bad('CLEARED', 'the stored batch is cleared');
  if (lb.halted) bad('HALTED', 'the batch path is halted');
  return { problems };
}

async function fetchAccounts(connection, addresses) {
  const out = {};
  for (let i = 0; i < addresses.length; i += 100) {
    const part = addresses.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(part.map((k) => new PublicKey(k)));
    part.forEach((k, n) => { const a = infos[n]; out[k] = a ? { address: k, owner: a.owner.toBase58(), lamports: BigInt(a.lamports), data: Buffer.from(a.data) } : null; });
  }
  return out;
}

const USAGE = 'usage: node scripts/vcurve/batch.mjs verify <list file> --rpc <url> --approver <key> [--previous <list file>] [--in-force <list file>] '
  + '[--archive <dir> | --no-archive] [--cluster mainnet|devnet] [--program-id <id>] [--valid-from <unix> --valid-until <unix>]\n'
  + '       node scripts/vcurve/batch.mjs check <list file> --rpc <url> [--cluster mainnet|devnet] [--program-id <id>]';
const FLAGS = new Map([['--rpc', 'rpc'], ['--approver', 'approver'], ['--previous', 'previous'], ['--in-force', 'inForce'], ['--archive', 'archive'], ['--cluster', 'cluster'],
  ['--program-id', 'programId'], ['--valid-from', 'validFrom'], ['--valid-until', 'validUntil']]);
const BOOL_FLAGS = new Map([['--no-archive', 'noArchive']]);
const VERIFY_ONLY = ['approver', 'previous', 'inForce', 'archive', 'noArchive', 'validFrom', 'validUntil'];

/** The CLI's options, or `{ error }`. */
export function parseArgs(argv) {
  const [mode, file, ...rest] = argv;
  if (!['verify', 'check'].includes(mode) || !file || file.startsWith('--')) return { error: 'a mode (verify or check) and a list file are required' };
  const o = { mode, file };
  for (let i = 0; i < rest.length; i++) {
    if (BOOL_FLAGS.has(rest[i])) { o[BOOL_FLAGS.get(rest[i])] = true; continue; }
    if (!FLAGS.has(rest[i])) return { error: `unknown option ${rest[i]}` };
    const v = rest[++i];
    if (v === undefined || v.startsWith('--')) return { error: `${rest[i - 1]} needs a value` };
    o[FLAGS.get(rest[i - 1])] = v;
  }
  if (!o.rpc) return { error: '--rpc is required' };
  if (mode === 'verify' && !o.approver) return { error: 'verify needs --approver (the key that will sign)' };
  if ((o.validFrom === undefined) !== (o.validUntil === undefined)) return { error: '--valid-from and --valid-until go together' };
  if (mode === 'check') { const extra = VERIFY_ONLY.filter((k) => o[k] !== undefined); if (extra.length) return { error: `check takes no ${extra.join(', ')}` }; }
  if (o.archive !== undefined && o.noArchive) return { error: '--archive and --no-archive exclude each other' };
  if (o.approver) { try { o.approver = new PublicKey(o.approver).toBase58(); } catch { return { error: `--approver: not a public key: ${o.approver}` }; } }
  return o;
}

/** The archive directory `verify` uses: `--archive`, else $VICINITY_BATCH_ARCHIVE, else ~/.vicinity-curve/launch-batches; null with `--no-archive`. */
export const archiveDir = (o, env = process.env) => (o.noArchive ? null : (o.archive ?? env.VICINITY_BATCH_ARCHIVE ?? join(homedir(), '.vicinity-curve', 'launch-batches')));
/** The list files kept in the archive for `programId` (texts; unreadable files are skipped by `verifyListFile`). */
export function readArchive(dir, programId) {
  const d = join(dir, String(programId));
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((n) => n.endsWith('.json')).sort().map((n) => readFileSync(join(d, n), 'utf8'));
}
/** Keep a verified list in the archive as `<dir>/<program id>/<seq>-<root>.json`; returns its path. */
export function archiveList(dir, batch, text) {
  const d = join(dir, batch.programId);
  mkdirSync(d, { recursive: true });
  const path = join(d, `${batch.batchSeq}-${toHex(batch.root)}.json`);
  if (!existsSync(path)) writeFileSync(path, text);
  return path;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.error) { console.error(`${o.error}\n${USAGE}`); return 2; }
  const cluster = o.cluster ?? 'mainnet'; const programId = o.programId ?? CURVE_PROGRAM_ID;
  const connection = new web3.Connection(o.rpc, 'confirmed');
  const file = readFileSync(o.file, 'utf8');
  let parsed;
  try { parsed = parseLaunchBatchFile(file); } catch (e) {
    console.log(`PROBLEM BAD_FILE: ${e.message}`);
    console.log(o.mode === 'check' ? '1 problem(s): page the owner and the guardian members' : '1 problem(s): do not sign');
    return 1;
  }
  const A = batchAddresses(parsed.entries, { programId, cluster });
  const accounts = await fetchAccounts(connection, allAddresses(A));
  if (o.mode === 'check') {
    const { problems } = checkStoredBatch({ file, accounts, programId, cluster });
    for (const p of problems) console.log(`PROBLEM ${p.code}: ${p.message}`);
    console.log(problems.length ? `${problems.length} problem(s): page the owner and the guardian members; clear the batch if it is not the prepared one (8.4)` : 'the stored batch is the list');
    return problems.length ? 1 : 0;
  }
  const dir = archiveDir(o);
  const now = BigInt(await connection.getBlockTime(await connection.getSlot('confirmed')));
  const r = verifyListFile({
    file, previous: o.previous ? readFileSync(o.previous, 'utf8') : null, inForce: o.inForce ? readFileSync(o.inForce, 'utf8') : null,
    archive: dir ? readArchive(dir, programId) : null, accounts, approver: o.approver, now, validFrom: o.validFrom, validUntil: o.validUntil, programId, cluster,
  });
  for (const w of r.warnings) console.log(`warning ${w.code}: ${w.message}`);
  for (const p of r.problems) console.log(`PROBLEM ${p.code}: ${p.message}`);
  for (const line of changeLines(r)) console.log(line);
  if (!r.publish) { console.log(`${r.problems.length} problem(s): do not sign`); return 1; }
  const p = r.publish;
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const ix = new web3.TransactionInstruction({ programId: new PublicKey(p.instruction.programAddress), data: Buffer.from(p.instruction.data),
    keys: p.instruction.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })) });
  const tx = new web3.Transaction({ feePayer: new PublicKey(o.approver), recentBlockhash: blockhash }).add(ix);
  if (dir) console.log(`kept in the archive: ${archiveList(dir, r.batch, file)}`);
  console.log(`batch ${p.seq}, ${p.leafCount} entries, root ${toHex(p.root)}\nvalid from ${new Date(Number(p.validFrom) * 1000).toISOString()} until ${new Date(Number(p.validUntil) * 1000).toISOString()}`);
  console.log(`unsigned publish_launch_batch for ${o.approver} (base64; sign it in the approver's own wallet, compare the root, number and window first):\n${tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
