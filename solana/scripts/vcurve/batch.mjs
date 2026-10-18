#!/usr/bin/env node
// The owner's batch verifier and the monitor's check (VICINITY-CURVE-DESIGN.md 8.4 steps 2 and 3, 8.6, 14.1; NOTES 76).
// Read-only: it reads the chain and the list file and prints; it never holds or asks for a key and never signs.
//
//   verify <list file>: the owner, on his own computer, before he signs. It re-reads `Launchpad`, `LaunchBatch`, each
//     listed city's `Coin`, `Approval` and `TickerLock`, the old program's `Coin` and `Approval`, and the configs;
//     rebuilds the tree from the file's entries and refuses a file whose root is not its entries'; re-checks every entry
//     as the program will at launch (sdk/curve/batch.mjs `entryProblems`: the founder key against every role, the name,
//     the ticker, the metadata hash, the config enabled, no coin here or in the old program, no pending approval, no
//     locked ticker); prints the day's changes against `--previous` (the list in force); and, when nothing is wrong,
//     prints the unsigned `publish_launch_batch` transaction (`seq = latest.seq + 1`, the window of O31 unless given)
//     for the approver's wallet, with the root, number and window to compare.
//   check <list file>: the monitor, after a publication. The stored `latest` record must be the file's batch: its
//     number, root and leaf count, a window the program would have accepted, published by the current approver.
//
// Usage (from solana/):
//   node scripts/vcurve/batch.mjs verify <list file> --rpc <url> --approver <key> [--previous <list file>]
//     [--cluster mainnet|devnet] [--program-id <id>] [--valid-from <unix seconds> --valid-until <unix seconds>]
//   node scripts/vcurve/batch.mjs check <list file> --rpc <url> [--cluster mainnet|devnet] [--program-id <id>]
// Exit status 1 when a problem is found, 2 on a usage error.
import { readFileSync } from 'node:fs';
import web3 from '@solana/web3.js';
import {
  ADDRESSES, CURVE_PROGRAM_ID, curvePdas, curveInstructions, decodeLaunchpad, decodeLaunchBatch, decodeLaunchConfig, decodeApproval,
  decodeCurveCoin, decodeTickerLock, parseLaunchBatchFile, entryProblems, diffLaunchBatches, preparePublishLaunchBatch, publishWindowOk,
  BatchError,
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
 * The verifier on a snapshot. `file` is the list file (3.12; parsed or text), `previous` the list in force (optional),
 * `accounts` the fetched accounts of `batchAddresses`, `approver` the key that will sign, `now` the chain clock.
 * Returns `{ batch, problems, warnings, changes, publish }`; `publish` (from `preparePublishLaunchBatch`) only when
 * nothing is wrong.
 */
export function verifyListFile({ file, previous = null, accounts, approver, now, validFrom, validUntil, programId = CURVE_PROGRAM_ID, cluster = 'mainnet' }) {
  const problems = []; const warnings = [];
  const bad = (code, message) => problems.push({ code, message });
  let batch;
  try { batch = parseLaunchBatchFile(file); } catch (e) { bad('BAD_FILE', e.message); return { batch: null, problems, warnings, changes: null, publish: null }; }
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
  if (launchpad?.launchesPaused) warnings.push({ code: 'LAUNCHES_PAUSED', message: 'launches are paused: no founder can launch until the admin resumes them' });
  if (launchpad?.buysHalted) warnings.push({ code: 'BUYS_HALTED', message: 'buys are halted: no founder can launch until the admin clears the halt' });
  const chain = chainOf(A, accounts, { programId });
  batch.entries.forEach((e, i) => {
    const p = entryProblems(e, { launchpad, chain });
    if (p.length) bad('BAD_ENTRY', `entry ${i} (city ${e.cityId}, ${e.symbol}, founder ${e.founder}): ${p.join('; ')}`);
  });
  const changes = diffLaunchBatches(previous ? parseLaunchBatchFile(previous) : null, batch);
  let publish = null;
  if (!problems.length) {
    try {
      publish = preparePublishLaunchBatch({ batch, launchBatch, launchpad, approver, now, validFrom, validUntil, programId, cluster, ix: curveInstructions({ programId, cluster }) });
    } catch (e) { if (e instanceof BatchError) bad(`PREPARE_${e.code ?? 'FAILED'}`, e.message); else throw e; }
  }
  return { batch, problems, warnings, changes, publish };
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

const USAGE = 'usage: node scripts/vcurve/batch.mjs verify <list file> --rpc <url> --approver <key> [--previous <list file>] [--cluster mainnet|devnet] [--program-id <id>] '
  + '[--valid-from <unix> --valid-until <unix>]\n       node scripts/vcurve/batch.mjs check <list file> --rpc <url> [--cluster mainnet|devnet] [--program-id <id>]';
const FLAGS = new Map([['--rpc', 'rpc'], ['--approver', 'approver'], ['--previous', 'previous'], ['--cluster', 'cluster'], ['--program-id', 'programId'], ['--valid-from', 'validFrom'], ['--valid-until', 'validUntil']]);

/** The CLI's options, or `{ error }`. */
export function parseArgs(argv) {
  const [mode, file, ...rest] = argv;
  if (!['verify', 'check'].includes(mode) || !file || file.startsWith('--')) return { error: 'a mode (verify or check) and a list file are required' };
  const o = { mode, file };
  for (let i = 0; i < rest.length; i++) {
    if (!FLAGS.has(rest[i])) return { error: `unknown option ${rest[i]}` };
    const v = rest[++i];
    if (v === undefined || v.startsWith('--')) return { error: `${rest[i - 1]} needs a value` };
    o[FLAGS.get(rest[i - 1])] = v;
  }
  if (!o.rpc) return { error: '--rpc is required' };
  if (mode === 'verify' && !o.approver) return { error: 'verify needs --approver (the key that will sign)' };
  if (o.approver) { try { o.approver = new PublicKey(o.approver).toBase58(); } catch { return { error: `--approver: not a public key: ${o.approver}` }; } }
  if ((o.validFrom === undefined) !== (o.validUntil === undefined)) return { error: '--valid-from and --valid-until go together' };
  return o;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.error) { console.error(`${o.error}\n${USAGE}`); return 2; }
  const cluster = o.cluster ?? 'mainnet'; const programId = o.programId ?? CURVE_PROGRAM_ID;
  const connection = new web3.Connection(o.rpc, 'confirmed');
  const file = readFileSync(o.file, 'utf8');
  const entries = JSON.parse(file).entries ?? [];
  const A = batchAddresses(entries, { programId, cluster });
  const accounts = await fetchAccounts(connection, allAddresses(A));
  if (o.mode === 'check') {
    const { problems } = checkStoredBatch({ file, accounts, programId, cluster });
    for (const p of problems) console.log(`PROBLEM ${p.code}: ${p.message}`);
    console.log(problems.length ? `${problems.length} problem(s): page the owner and the guardian members; clear the batch if it is not the prepared one (8.4)` : 'the stored batch is the list');
    return problems.length ? 1 : 0;
  }
  const now = BigInt(await connection.getBlockTime(await connection.getSlot('confirmed')));
  const r = verifyListFile({ file, previous: o.previous ? readFileSync(o.previous, 'utf8') : null, accounts, approver: o.approver, now, validFrom: o.validFrom, validUntil: o.validUntil, programId, cluster });
  for (const w of r.warnings) console.log(`warning ${w.code}: ${w.message}`);
  for (const p of r.problems) console.log(`PROBLEM ${p.code}: ${p.message}`);
  if (r.changes) {
    const show = (e) => `city ${e.cityId} ${e.symbol} "${e.name}" founder ${e.founder} config ${e.configId}`;
    console.log(`changes: ${r.changes.added.length} added, ${r.changes.removed.length} removed, ${r.changes.changed.length} changed`);
    for (const e of r.changes.added) console.log(`  + ${show(e)}`);
    for (const e of r.changes.removed) console.log(`  - ${show(e)}`);
    for (const c of r.changes.changed) console.log(`  ~ ${show(c.before)}\n    -> ${show(c.after)}`);
  }
  if (!r.publish) { console.log(`${r.problems.length} problem(s): do not sign`); return 1; }
  const p = r.publish;
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const ix = new web3.TransactionInstruction({ programId: new PublicKey(p.instruction.programAddress), data: Buffer.from(p.instruction.data),
    keys: p.instruction.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })) });
  const tx = new web3.Transaction({ feePayer: new PublicKey(o.approver), recentBlockhash: blockhash }).add(ix);
  console.log(`batch ${p.seq}, ${p.leafCount} entries, root ${toHex(p.root)}\nvalid from ${new Date(Number(p.validFrom) * 1000).toISOString()} until ${new Date(Number(p.validUntil) * 1000).toISOString()}`);
  console.log(`unsigned publish_launch_batch for ${o.approver} (base64; sign it in the approver's own wallet, compare the root, number and window first):\n${tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
