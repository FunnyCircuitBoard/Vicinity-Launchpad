#!/usr/bin/env node
// The owner's batch verifier, his confirmation and the monitor's check (VICINITY-CURVE-DESIGN.md 8.4 steps 2, 3 and 5,
// 8.6, 14.1; NOTES 76, 78 to 80, 83 to 86, 91 to 94, 96). It reads the chain and the list files and prints; it never
// holds or asks for a key and never signs. Its only writes are the owner's own archive and its key (below).
//
//   verify <list file>: the owner, on his own computer, before he signs. It re-reads `Launchpad`, `LaunchBatch`, each
//     listed city's `Coin`, `Approval` and `TickerLock`, the old program's `Coin` and `Approval`, the configs, every
//     pending per-city `Approval` and the Clock sysvar (the time it judges by); with `--rpc` twice every one of them
//     must agree on both RPCs (the clocks within a minute; review R8-DIFF-1); checks the file's schema and rebuilds the
//     tree from its entries (review MK-1); re-checks every entry as the program will at launch (sdk/curve/batch.mjs
//     `entryProblems`), and refuses a ticker another city can still launch with, from its pending approval or from the
//     batch in force (T87, review R7-BA-2); prints the day's changes; and, when nothing is wrong, prints the unsigned
//     `publish_launch_batch` transaction with its message hash, or, with `--tx <base64>`, checks that the transaction
//     the website's batch page built is exactly that publication, with the default window (review R8-DIFF-2), and
//     prints its message hash (review R7-CONF-1). With `--correct` the transaction first clears the stored batches
//     (`clear_launch_batch(halt = false)`, then the publication, in one transaction: 8.4 step 5's correction of a batch
//     in force; review R8-OPS-1), and the changes are shown as they stand once the clear has landed. The list then goes
//     to the archive's `pending/` folder with the window and message hash of the transaction, never a baseline
//     (reviews R7-BA-1, R7-3). An approver that is not a wallet key (a multisig vault, O32 (a)) is refused: the
//     verifier cannot check a publication made through Squads (review R8-DIFF-6).
//     The day's changes are computed only against lists the owner signed and confirmed (`signed/`): while the stored
//     `latest` batch can still let founders launch, its archived record (number, root, leaf count, window and publisher)
//     must equal the stored one, else no transaction: a publication he did not confirm (`LATEST_NOT_ARCHIVED`), and the
//     same for the batch in force while `latest` is pending (`IN_FORCE_NOT_ARCHIVED`); when such a record has the
//     window of a list he verified, the transaction that wrote it is read and compared with the one he verified. Only
//     with an empty archive (the first use on a computer) may `--previous` / `--in-force` stand in, matched on the chain
//     read from two RPCs of different providers (`--rpc` twice, review R7-4); their entries are then printed in full,
//     never used to hide one, and every entry of the new list is listed as added. A `--previous` or `--in-force` file
//     the chain does not hold is a problem. When `latest` has ended (cleared, expired or a former approver's), every
//     entry is a new approval.
//   confirm <seq> <root>: the owner, within minutes of each publication he signed (8.4 step 3). The stored `latest` must
//     be exactly a list in `pending/` (number, root, leaf count, window, the current approver as publisher), not
//     cleared, and the transaction that wrote it must be the one he verified, by its message hash, on every RPC (review
//     R8-DIFF-2); only then does the list move to `signed/`, the next day's baseline. Several pending lists for that
//     number (one he refused) are refused unless `--discard-others` moves them to `refused/`. Any difference: page the
//     guardian.
//   check <list or archive file>: the monitor, after a publication. The stored `latest` record must be the file's batch:
//     its number, root and leaf count (and, for an archive entry the owner exported, its window and approver), a window
//     the program would have accepted, published by the current approver; with `--rpc` twice both RPCs must agree
//     (review R8-DIFF-4).
// The archive (`--archive <dir>`, default $VICINITY_BATCH_ARCHIVE or ~/.vicinity-curve/launch-batches; `--no-archive` for
// none) keeps `<program id>/pending/`, `signed/` and `refused/`; each entry carries an HMAC under this computer's key,
// `~/.vicinity-curve/archive.key` (32 random bytes created on first use, never inside an archive folder, so a folder
// handed over with its own key proves nothing; review R8-DIFF-5), so a file copied in from elsewhere is ignored. Every
// run prints the archive folder and the key's fingerprint, and warns when the folder is not the one used last.
//
// Usage (from solana/):
//   node scripts/vcurve/batch.mjs verify <list file> --rpc <url> [--rpc <url of another provider>] --approver <key>
//     [--tx <base64 of the page's unsigned transaction>] [--correct] [--previous <list file>] [--in-force <list file>]
//     [--archive <dir> | --no-archive] [--cluster mainnet|devnet] [--program-id <id>] [--valid-from <unix> --valid-until <unix>]
//   node scripts/vcurve/batch.mjs confirm <seq> <root> --rpc <url> [--rpc <url>] [--archive <dir>] [--discard-others]
//     [--cluster mainnet|devnet] [--program-id <id>]
//   node scripts/vcurve/batch.mjs check <list or archive file> --rpc <url> [--rpc <url>] [--cluster mainnet|devnet] [--program-id <id>]
// Every --rpc must be a provider the website does not operate or relay (8.4); two must be of different providers (by
// host: their IP addresses, or the last two labels of their host names, differ). Exit status 1 when a problem is
// found, 2 on a usage error.
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import web3 from '@solana/web3.js';
import {
  ADDRESSES, ACCOUNT_DISCRIMINATORS, BATCH_REVIEW_SECS, CURVE_PROGRAM_ID, DEFAULT_REVIEW_MARGIN_SECS, DEFAULT_VALIDITY_SECS, INSTRUCTION_DISCRIMINATORS,
  curvePdas, curveInstructions, decodeLaunchpad, decodeLaunchBatch, decodeLaunchConfig, decodeApproval, decodeCurveCoin, decodeTickerLock,
  parseLaunchBatchFile, launchBatchFile, entryProblems, diffLaunchBatches, preparePublishLaunchBatch, publishWindowOk, batchInForce, tickerHolders,
  BatchError,
} from '../../sdk/curve/index.mjs';
import { toHex } from '../../sdk/merkle.mjs';

const { PublicKey } = web3;
const ZERO = ADDRESSES.system;
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const exists = (a) => Boolean(a) && (String(a.owner?.toBase58?.() ?? a.owner) !== ZERO || (a.data?.length ?? 0) > 0);
/** Whether `key` is an ed25519 point, so a wallet key that can sign; a program address (a Squads vault, any PDA) is not. */
const isWalletKey = (key) => PublicKey.isOnCurve(new PublicKey(String(key)).toBytes());

// ---------------------------------------------------------------- the RPCs (reviews R7-4, R8-DIFF-1, R8-DIFF-4)
/** The Clock sysvar, read in the same request as the accounts it judges (review R8-DIFF-1). */
export const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';
/** How far apart two RPCs' clocks may be (seconds); the earlier one is used. */
export const CLOCK_TOLERANCE_SECS = 60n;
/** The Clock sysvar account: `{ slot, unixTimestamp }`; throws unless it is one. */
export function decodeClock(account) {
  if (!account || String(account.owner) !== SYSVAR_OWNER || (account.data?.length ?? 0) < 40) throw new Error('not the Clock sysvar');
  const d = Buffer.from(account.data);
  return { slot: d.readBigUInt64LE(0), unixTimestamp: d.readBigInt64LE(32) };
}
/**
 * The provider of an RPC URL (review R8-DIFF-4): its IP address, or the last two labels of its host name
 * (`helius-rpc.com` for `https://mainnet.helius-rpc.com/?api-key=...`), so two keys or two paths of one provider count
 * as one. Throws unless the URL is http or https.
 */
export function rpcProvider(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error(`not a URL: ${url}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`not an http or https URL: ${url}`);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return host;
  return host.split('.').filter(Boolean).slice(-2).join('.');
}
/** Why a list of `--rpc` URLs is refused (`min` to `max` of them, each http(s), no two of one provider), or null. */
export function rpcUrlsProblem(urls, { min = 1, max = 2 } = {}) {
  const n = urls?.length ?? 0;
  if (n < min || n > max) return min === max ? `--rpc ${min === 2 ? 'twice, two different providers' : `${min} times`}` : `--rpc once, or twice with two different providers`;
  let providers;
  try { providers = urls.map(rpcProvider); } catch (e) { return `--rpc: ${e.message}`; }
  if (new Set(providers).size !== providers.length) return `--rpc twice must name two different providers: ${urls.join(' and ')} are both ${providers[0]} (review R8-DIFF-4)`;
  return null;
}

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
/** How far past the default valid_from (now + 12 h + 10 min) the website's window may lie (review R8-DIFF-2): its clock and the delay before the owner verifies. */
export const PAGE_WINDOW_SLACK_SECS = 600n;
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
 * `landed` (the message hashes of the transactions that wrote the record, read from every RPC, or undefined when not
 * read) decides whether the record with a verified window is the transaction he verified (review R8-DIFF-2): a
 * republication by someone else has another message, and then `confirm` is not suggested.
 */
function notConfirmedMessage(r, prepared, what, landed) {
  const exact = prepared.find((e) => sameArchived(e, r));
  const sameList = prepared.find((e) => sameRecord(e.list, r));
  const head = `the stored ${what}, ${recordDetail(r)}, is not a list you signed and confirmed on this computer`;
  const stop = 'have a guardian member clear it with halt now (guardian-stop.mjs --clear, 8.4 step 5)';
  if (exact) {
    const verified = `a list you verified (prepared ${exact.raw.preparedAt ? iso(exact.raw.preparedAt) : 'earlier'}, window ${iso(exact.record.validFrom)} to ${iso(exact.record.validUntil)}, message hash ${exact.raw.messageHash ?? 'not kept'})`;
    if (Array.isArray(landed) && !landed.includes(exact.raw.messageHash)) {
      return `${head}: it has the list, window and signer of ${verified}, but the transaction that wrote it is another one (message hash ${landed.join(', ') || 'none found'}): `
        + `a republication by someone holding the approver key, not the transaction you verified, so the key is stolen: ${stop} (review R8-DIFF-2)`;
    }
    if (Array.isArray(landed)) {
      return `${head}: the transaction that wrote it is byte for byte the one you verified, ${verified}, and you never confirmed it. `
        + `If you signed it, run: node scripts/vcurve/batch.mjs confirm ${r.seq} ${toHex(r.root)}. If you refused it, whoever holds the approver key signed that same message: ${stop}`;
    }
    return `${head}: it is ${verified} but never confirmed. `
      + `If you signed exactly that transaction, run: node scripts/vcurve/batch.mjs confirm ${r.seq} ${toHex(r.root)}. If you did not sign it, the approver key is stolen: ${stop}. `
      + 'confirm takes it as a baseline only if the transaction that wrote it is the one you verified (its message hash; review R8-DIFF-2)';
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
 * every account and the clock were read alike from two RPCs of different providers); `approvals` every pending per-city
 * `Approval` of the program, decoded (required: a ticker they hold is refused); `accounts` the fetched accounts of
 * `batchAddresses` (and the Coin accounts of the cities of the stored batches in force); `approver` the key that will
 * sign (a wallet key: review R8-DIFF-6); `now` the chain clock (the Clock sysvar); `validFrom` / `validUntil` the window
 * (the page's transaction, or the default), with `pageWindow` when it is the page's (only the default window is accepted
 * then, review R8-DIFF-2); `correct` when the transaction first clears the stored batches (8.4 step 5, review R8-OPS-1);
 * `landed` a Map from a batch number to the message hashes of the transactions that wrote that stored record (read only
 * for a live record that has the window of a pending list, `needLanded`).
 * Returns `{ batch, problems, warnings, changes, changesInForce, ended, cleared, baseline, unconfirmed, needLanded, correct,
 * publish }`: `changes` against the stored `latest` list while it is live (or against nothing; with `correct`, always
 * against nothing), `changesInForce` against the batch in force when it is another, `ended` `{ seq, why, changes }`
 * against an ended `latest` list for reference, `cleared` (with `correct`) `{ seq, state, source, changes }` for each live
 * record the transaction clears, `baseline` `{ seq, source }`, `unconfirmed` the lists of live stored batches this
 * computer has no record of signing (first use, printed in full); `needLanded` the live records whose landed transaction
 * must be read before the alarm can say whether it is the one the owner verified; `publish` (from
 * `preparePublishLaunchBatch`, plus `clear` with `correct`) only when nothing is wrong.
 */
export function verifyListFile({
  file, previous = null, inForce = null, archive = null, pending = null, approvals, accounts, approver, now, validFrom, validUntil,
  chainConfirmed = false, correct = false, pageWindow = false, landed = null, programId = CURVE_PROGRAM_ID, cluster = 'mainnet',
}) {
  const problems = []; const warnings = [];
  const bad = (code, message) => { if (!problems.some((p) => p.code === code && p.message === message)) problems.push({ code, message }); };
  const warn = (code, message) => warnings.push({ code, message });
  const none = { batch: null, problems, warnings, changes: null, changesInForce: null, ended: null, cleared: [], baseline: null, unconfirmed: [], needLanded: [], correct, publish: null };
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
  // review R8-DIFF-6: a program address (a Squads vault, O32 (a)) can neither pay for nor sign a top-level transaction,
  // and a publication through Squads is a vault transaction whose inner publish_launch_batch this verifier cannot check
  if (approver && !isWalletKey(approver)) {
    bad('APPROVER_NOT_WALLET_KEY', `${approver} is not a wallet key (it is off the ed25519 curve: a multisig vault, O32 (a)): it can neither pay for nor sign a transaction itself, and this verifier cannot check a publication made through Squads, so nothing it prints could be signed and no Squads proposal is covered by it: do not sign one on its strength (review R8-DIFF-6)`);
  }
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
  // review R8-DIFF-2: a live record with the window of a pending list is checked against the transaction that wrote it
  const needLanded = [];
  const landedFor = (r) => landed?.get(String(r.seq));
  const alarm = (r, what) => {
    if (prepared.some((e) => sameArchived(e, r)) && landedFor(r) === undefined) needLanded.push(r);
    return notConfirmedMessage(r, prepared, what, landedFor(r));
  };
  let changes = diffLaunchBatches(null, batch); let changesInForce = null; let ended = null; let baseline = null;
  const unconfirmed = []; const holderLists = [];
  const live = []; // the stored records that can still let founders launch, with their lists where known (review R8-OPS-1)
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
        const stateL = t < L.validFrom ? 'pending' : 'in force';
        const latestList = archivedL?.list ?? fileFor(prevList, L);
        live.push({ seq: L.seq, state: stateL, list: latestList, source: archivedL ? 'the archive' : '--previous' });
        if (archivedL) { changes = diffLaunchBatches(archivedL.list, batch); baseline = { seq: L.seq, source: 'the archive' }; } else if (signed.length) {
          changes = null;
          bad('LATEST_NOT_ARCHIVED', alarm(L, `batch (${stateL})`));
        } else {
          const pl = fileFor(prevList, L);
          if (pl) unconfirmed.push({ seq: L.seq, state: stateL, source: '--previous', entries: pl.entries });
          else if (!prevList && !correct) {
            changes = null;
            bad('NO_PREVIOUS', `the stored ${recordText(L)} can still let founders launch (${stateL}) and this computer's archive holds no list you confirmed: pass --previous <its list file>, which must match the chain read from two RPCs; its entries are then printed in full (8.4)`);
          }
        }
        // a stored batch in force now keeps its tickers until this list takes force (review R7-BA-2)
        if (t >= L.validFrom && latestList) holderLists.push({ seq: L.seq, entries: latestList.entries });
        // the batch in force while `latest` is pending: this list replaces `latest`, and `previous` stays in force until this list's valid_from
        const force = t < L.validFrom ? batchInForce(launchBatch, launchpad, t) : null;
        const Pr = force && force.seq !== L.seq ? force.record : null;
        if (Pr) {
          if (forceList && !sameRecord(forceList, Pr)) bad('IN_FORCE_NOT_ON_CHAIN', `--in-force ${listText(forceList)} is not the batch in force, ${recordText(Pr)}: do not sign`);
          const archivedP = confirmed(Pr);
          const pList = archivedP?.list ?? fileFor(forceList, Pr);
          live.push({ seq: Pr.seq, state: 'in force', list: pList, source: archivedP ? 'the archive' : '--in-force' });
          if (archivedP) changesInForce = { seq: Pr.seq, source: 'the archive', changes: diffLaunchBatches(archivedP.list, batch) };
          else if (signed.length) bad('IN_FORCE_NOT_ARCHIVED', alarm(Pr, 'batch in force'));
          else {
            const fl = fileFor(forceList, Pr);
            if (fl) unconfirmed.push({ seq: Pr.seq, state: 'in force', source: '--in-force', entries: fl.entries });
            else if (!forceList && !correct) bad('NO_IN_FORCE', `the stored batch ${L.seq} is still pending and this list replaces it, while ${recordText(Pr)} is in force until this list's valid_from: pass --in-force <its list file>, which must match the chain, to see what founders can launch now (8.4)`);
          }
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

  // review R8-OPS-1: the correction of 8.4 step 5 clears the stored batches in the same transaction, so once it lands no
  // stored batch lets anyone launch: every entry of this list is a new approval, each cleared list is shown for
  // reference, and none holds a ticker any more. Without it, an entry removed from or changed in the batch in force can
  // still launch as that batch lists it until this list's valid_from.
  let cleared = [];
  if (correct) {
    if (!live.length) warn('NOTHING_TO_CLEAR', 'no stored batch can let founders launch now or later, so --correct clears nothing: a lone publication does the same (8.4 step 5)');
    cleared = live.map((x) => ({ seq: x.seq, state: x.state, source: x.list ? x.source : null, changes: x.list ? diffLaunchBatches(x.list, batch) : null }));
    if (changes) changes = diffLaunchBatches(null, batch);
    baseline = null; changesInForce = null; unconfirmed.length = 0; holderLists.length = 0;
  } else {
    const inForce = [];
    if (baseline && launchBatch && BigInt(now) >= launchBatch.latest.validFrom) inForce.push([launchBatch.latest.seq, changes]);
    if (changesInForce) inForce.push([changesInForce.seq, changesInForce.changes]);
    for (const [seq, c] of inForce) {
      if (c.removed.length || c.changed.length) {
        warn('STILL_IN_FORCE', `batch ${seq} stays in force until this list's valid_from: the ${c.removed.length} removed and ${c.changed.length} changed entries above can still launch as that batch lists them until then; to stop them now, run verify again with --correct, which clears the stored batches in the same transaction (batch launches then pause for everyone until this list takes force; 8.4 step 5, review R8-OPS-1)`);
      }
    }
  }

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
  // review R8-DIFF-2: the website's transaction carries only the default window, so a list refused today cannot be
  // published with the verified window hours later (the window is part of what `confirm` and the alarm compare)
  if (pageWindow && validFrom !== undefined && validUntil !== undefined) {
    const f = BigInt(validFrom); const u = BigInt(validUntil); const latestFrom = BigInt(now) + BATCH_REVIEW_SECS + DEFAULT_REVIEW_MARGIN_SECS + PAGE_WINDOW_SLACK_SECS;
    if (f > latestFrom || u - f !== DEFAULT_VALIDITY_SECS) {
      bad('TX_WINDOW_NOT_DEFAULT', `the website's transaction takes force at ${iso(f)} for ${Number(u - f) / 3_600} hours; only the default window is accepted (valid_from at most ${Number(DEFAULT_REVIEW_MARGIN_SECS + PAGE_WINDOW_SLACK_SECS) / 60} minutes past now + 12 hours, ${iso(latestFrom)}, and ${Number(DEFAULT_VALIDITY_SECS) / 3_600} hours long), so that a list you refuse cannot be published with the window you verified hours later (review R8-DIFF-2): do not sign`);
    }
  }
  let publish = null;
  if (!problems.length) {
    try {
      const I = curveInstructions({ programId, cluster });
      publish = preparePublishLaunchBatch({ batch, launchBatch, launchpad, approver, now, validFrom, validUntil, programId, cluster, ix: I });
      if (correct) publish = { ...publish, clear: I.clearLaunchBatch({ authority: approver, halt: false }) };
    } catch (e) { if (e instanceof BatchError) bad(`PREPARE_${e.code ?? 'FAILED'}`, e.message); else throw e; }
  }
  return { batch, problems, warnings, changes, changesInForce, ended, cleared, baseline, unconfirmed, needLanded, correct, publish };
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
      : r.correct ? 'changes once this transaction has cleared the stored batches (every entry is a new approval)'
        : r.unconfirmed?.length ? 'changes against no confirmed list (every entry is listed as a new approval)' : 'changes against no live batch (every entry is a new approval)'));
  }
  if (r.changesInForce) out.push(...formatChanges(r.changesInForce.changes, `changes against batch ${r.changesInForce.seq}, in force until this list's valid_from (its list from ${r.changesInForce.source})`));
  if (r.ended) out.push(...formatChanges(r.ended.changes, `for reference, changes against the ${r.ended.why} batch ${r.ended.seq} (none of its entries can launch)`));
  // review R8-OPS-1: what the correction stops
  for (const c of r.cleared ?? []) {
    const what = `batch ${c.seq} (${c.state}; this transaction clears it first, so none of its entries can launch once it lands`;
    if (c.changes) out.push(...formatChanges(c.changes, `for reference, changes against ${what}; its list from ${c.source})`));
    else out.push(`${what}; its list is not in this computer's archive)`);
  }
  return out;
}

// ---------------------------------------------------------------- the website's transaction (review R7-CONF-1)
/** SHA-256 of a message, base58: what a Ledger shows as the message hash when it blind-signs. */
export const messageHash = (messageBytes) => new PublicKey(createHash('sha256').update(Buffer.from(messageBytes)).digest()).toBase58();
/** The message of a transaction on the wire, byte for byte: what follows its signatures (a compact-u16 count, 64 bytes each). */
export function wireMessageBytes(bytes) {
  const b = Buffer.from(bytes);
  let n = 0; let i = 0;
  for (let shift = 0; ; shift += 7) {
    if (i >= b.length || i > 2) throw new Error('not a transaction: bad signature count');
    const x = b[i++]; n |= (x & 0x7f) << shift;
    if (!(x & 0x80)) break;
  }
  if (i + 64 * n >= b.length) throw new Error('not a transaction: too short');
  return b.subarray(i + 64 * n);
}
/**
 * A transaction as base64 (legacy or v0), read for `verify --tx`: its message bytes (as on the wire), keys, header and
 * instructions, and the fields of its `publish_launch_batch` of `programId` (`publish`: `{ seq, root, leafCount,
 * validFrom, validUntil }`, or null). Throws when it is not a transaction.
 */
export function decodePageTransaction(base64, { programId = CURVE_PROGRAM_ID } = {}) {
  const bytes = Buffer.from(String(base64).trim(), 'base64');
  let vt; let messageBytes;
  try { vt = web3.VersionedTransaction.deserialize(bytes); messageBytes = Buffer.from(wireMessageBytes(bytes)); } catch (e) { throw new Error(`not a transaction: ${e.message}`); }
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
  return { messageBytes, keys, header: h, lookups: msg.addressTableLookups?.length ?? 0, instructions, publish };
}
const KIND = Object.freeze({ publish: Buffer.from(INSTRUCTION_DISCRIMINATORS.publish_launch_batch), clear: Buffer.from(INSTRUCTION_DISCRIMINATORS.clear_launch_batch) });
const kindOf = (ix) => { const d = Buffer.from(ix.data).subarray(0, 8); return d.equals(KIND.publish) ? 'publish' : d.equals(KIND.clear) ? 'clear' : 'other'; };
/**
 * Whether the website's transaction (`decodePageTransaction`) is exactly the verified publication (`publish` from
 * `verifyListFile`, prepared with the transaction's window): its instructions of this program are exactly the verified
 * `publish_launch_batch`, preceded by the verified `clear_launch_batch(halt = false)` when `publish.clear` is set (the
 * correction of 8.4 step 5, `--correct`; review R8-OPS-1) and by nothing else, each with the same accounts, roles and
 * data; the approver its fee payer and only signer; no lookup table; and nothing else but at most one compute-unit limit
 * and one compute-unit price within caps. Returns `{ problems, messageHash }`.
 */
export function checkPageTransaction(tx, publish, { approver }) {
  const problems = [];
  const bad = (code, message) => problems.push({ code, message });
  if (tx.lookups) bad('TX_LOOKUP_TABLES', 'the transaction loads accounts from lookup tables: the verifier cannot see them');
  if (tx.header.numRequiredSignatures !== 1 || tx.keys[0] !== String(approver)) bad('TX_SIGNERS', `the transaction must be paid and signed by the approver ${approver} alone, not by ${tx.keys.slice(0, tx.header.numRequiredSignatures).join(', ')}`);
  const program = publish.instruction.programAddress;
  const want = publish.clear ? [['clear', publish.clear], ['publish', publish.instruction]] : [['publish', publish.instruction]];
  let limit = 0; let price = 0; const ours = [];
  for (const ix of tx.instructions) {
    if (ix.program === COMPUTE_BUDGET && ix.accounts.length === 0 && ix.data[0] === 2 && ix.data.length === 5 && limit === 0 && ix.data.readUInt32LE(1) <= 1_400_000) { limit++; continue; }
    if (ix.program === COMPUTE_BUDGET && ix.accounts.length === 0 && ix.data[0] === 3 && ix.data.length === 9 && price === 0 && ix.data.readBigUInt64LE(1) <= 1_000_000n) { price++; continue; }
    if (ix.program === program) { ours.push(ix); continue; }
    bad('TX_OTHER_INSTRUCTION', `it carries another instruction (${ix.program}): do not sign`);
  }
  const kinds = ours.map(kindOf); const wantKinds = want.map(([k]) => k);
  if (kinds.join() !== wantKinds.join()) {
    if (!kinds.includes('publish')) bad('TX_NO_PUBLICATION', 'it carries no publish_launch_batch of this program');
    else if (publish.clear && !kinds.includes('clear')) {
      bad('TX_NO_CLEAR', 'you asked for a correction (--correct), which clears the stored batches before it publishes; this transaction does not clear, so the batch in force would keep running until this list\'s valid_from: do not sign (8.4 step 5)');
    } else if (!publish.clear && kinds.includes('clear')) {
      bad('TX_CLEAR_NOT_ASKED', 'it clears the stored batches before it publishes (8.4 step 5\'s correction, which pauses batch launches for everyone until this list takes force): if that is what you want, run verify again with --correct, which shows the changes as they stand after the clear and checks the clear too (review R8-OPS-1)');
    } else bad('TX_OTHER_INSTRUCTION', `its instructions of this program are ${kinds.join(', ')}, not exactly ${wantKinds.join(' then ')}: do not sign`);
  } else {
    // the same accounts with the same roles; the fee payer (the approver) is writable in any message that it pays for
    const roleOk = (a, w) => a.role === w.role || (a.address === tx.keys[0] && (a.role | 1) === (w.role | 1));
    want.forEach(([kind, w], i) => {
      const ix = ours[i];
      if (!Buffer.from(ix.data).equals(Buffer.from(w.data))) {
        bad('TX_NOT_VERIFIED', kind === 'publish' ? 'its publish_launch_batch is not the verified one (number, root, leaf count or window differ): do not sign'
          : 'its clear_launch_batch is not the verified one (halt = false): a halt would refuse the publication itself and every later one until the admin acts: do not sign');
      }
      if (ix.accounts.length !== w.accounts.length || ix.accounts.some((a, k) => a.address !== w.accounts[k].address || !roleOk(a, w.accounts[k]))) bad('TX_ACCOUNTS', `its ${kind}_launch_batch names other accounts or roles than the verified one: do not sign`);
    });
  }
  return { problems, messageHash: messageHash(tx.messageBytes) };
}

// ---------------------------------------------------------------- the owner's confirmation and the monitor's check
/**
 * The owner's confirmation (8.4 step 3; review R7-BA-1): the stored `latest` must be batch `seq` with root `root`,
 * exactly a list in `pending` (number, root, leaf count, window, the current approver), published by the current
 * approver within a window the program accepts, not cleared, the path not halted; other pending lists of that number
 * (ones he verified and did not sign) are a problem unless `discardOthers`. `landed` (the message hashes of the
 * successful transactions that wrote this record, read from every RPC by `landedPublicationHashes`) must hold the
 * pending list's message hash: the same list and window published by anyone else is another message (another
 * blockhash), so a thief's republication of a refused list is never confirmed (review R8-DIFF-2); the CLI always reads
 * it, and only a caller that leaves it undefined skips the check. Returns `{ problems, entry, others, already }`.
 */
export function confirmPublication({ seq, root, pending = [], archive = [], accounts, landed, discardOthers = false, programId = CURVE_PROGRAM_ID, cluster = 'mainnet' }) {
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
  if (entry && landed !== undefined) {
    const mine = entry.raw.messageHash;
    if (!mine) bad('NO_MESSAGE_HASH', 'the list you verified was kept without the message hash of its transaction, so the transaction that wrote it cannot be compared: verify it again and sign the new transaction');
    else if (!landed?.length) bad('TX_NOT_FOUND', `no successful transaction at slot ${L.publishedSlot} carries this publication on the RPCs read: retry in a minute; if it persists, page the guardian members`);
    else if (!landed.includes(mine)) {
      bad('NOT_YOUR_TRANSACTION', `batch ${want} was written by the transaction with message hash ${landed.join(', ')}, not the one you verified (${mine}): the same list and window published by someone holding the approver key, so the key is stolen: have a guardian member clear it with halt now (guardian-stop.mjs --clear, 8.4 step 5; review R8-DIFF-2)`);
    }
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

// ---------------------------------------------------------------- the archive on disk (reviews R7-BA-1, R8-DIFF-5)
/** The archive directory: `--archive`, else $VICINITY_BATCH_ARCHIVE, else ~/.vicinity-curve/launch-batches; null with `--no-archive`. */
export const archiveDir = (o, env = process.env) => (o.noArchive ? null : (o.archive ?? env.VICINITY_BATCH_ARCHIVE ?? join(homedir(), '.vicinity-curve', 'launch-batches')));
/**
 * This computer's archive MAC key: `~/.vicinity-curve/archive.key`, never inside an archive folder, so an archive
 * folder someone hands over (`--archive`, $VICINITY_BATCH_ARCHIVE) with entries MAC'd under its own key proves nothing
 * (review R8-DIFF-5).
 */
export const archiveKeyPath = () => join(homedir(), '.vicinity-curve', 'archive.key');
/** Where the archive folder used last is noted (review R8-DIFF-5). */
export const lastArchivePath = () => join(homedir(), '.vicinity-curve', 'last-archive');
/** A key file that is not exactly 32 bytes of hex: the archive cannot be trusted (review R8-DIFF-5). */
export class ArchiveKeyError extends Error {}
/**
 * The archive's MAC key (32 random bytes in hex at `path`, created on first use when `create`, atomically and never
 * over an existing file), or null when there is none. Throws ArchiveKeyError unless the file holds exactly 64 hex digits:
 * an empty or short key would let anyone write a valid MAC (review R8-DIFF-5).
 */
export function archiveKey({ create = false, path = archiveKeyPath() } = {}) {
  if (!existsSync(path)) {
    if (!create) return null;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    try { linkSync(tmp, path); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { unlinkSync(tmp); }
  }
  const text = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) {
    throw new ArchiveKeyError(`the archive key ${path} is not 32 bytes of hex (it holds ${text.length} characters): no archived list can be trusted; restore the key from your backup, or move the file away, which makes every archived list unreadable (a first use, 8.4)`);
  }
  return Buffer.from(text, 'hex');
}
/** A short fingerprint of the archive key (the first 16 hex digits of its SHA-256), printed on every run. */
export const keyFingerprint = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);
/** Note `dir` as the archive folder used last; returns `{ dir, last, moved }` (`moved`: another folder was used last). */
export function noteArchiveDir(dir, { path = lastArchivePath() } = {}) {
  const abs = resolve(dir);
  let last = null;
  try { last = readFileSync(path, 'utf8').trim() || null; } catch { last = null; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, abs, { mode: 0o600 });
  return { dir: abs, last, moved: Boolean(last && last !== abs) };
}
const macOf = (key, entry) => createHmac('sha256', key).update(JSON.stringify(entry)).digest('hex');
/**
 * Read the archive of `programId`: `{ signed, pending, ignored: [{ name, why }] }`, each entry checked against this
 * computer's key (`keyPath`). Throws ArchiveKeyError when the key file is not a key.
 */
export function readArchive(dir, programId, { keyPath = archiveKeyPath() } = {}) {
  const out = { signed: [], pending: [], ignored: [] };
  const key = archiveKey({ path: keyPath });
  for (const sub of ['signed', 'pending']) {
    const d = join(dir, String(programId), sub);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d).filter((n) => n.endsWith('.json')).sort()) {
      try {
        const { mac, ...entry } = JSON.parse(readFileSync(join(d, name), 'utf8'));
        if (!key || typeof mac !== 'string' || mac !== macOf(key, entry)) throw new Error('not written with this computer\'s archive key (no valid MAC): a file copied in, or an archive made elsewhere, is never a baseline');
        const e = parseArchiveEntry(entry);
        if (e.kind !== sub) throw new Error(`a ${e.kind} entry in ${sub}/`);
        out[sub].push({ ...e, path: join(d, name) });
      } catch (e) { out.ignored.push({ name: join(sub, name), why: e.message }); }
    }
  }
  return out;
}
/** Write an archive entry under `<dir>/<program>/<sub>/<name>` with its MAC under this computer's key; returns the path. */
export function writeArchiveEntry(dir, sub, name, entry, { keyPath = archiveKeyPath() } = {}) {
  const key = archiveKey({ create: true, path: keyPath });
  const d = join(dir, entry.programId, sub);
  mkdirSync(d, { recursive: true });
  const path = join(d, name);
  writeFileSync(path, JSON.stringify({ ...entry, mac: macOf(key, entry) }, null, 1));
  return path;
}

// ---------------------------------------------------------------- reading the chain (reviews R7-4, R8-DIFF-1, R8-DIFF-2, R8-DIFF-4)
async function fetchAccounts(connection, addresses) {
  const out = {};
  for (let i = 0; i < addresses.length; i += 100) {
    const part = addresses.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(part.map((k) => new PublicKey(k)));
    part.forEach((k, n) => { const a = infos[n]; out[k] = a ? { address: k, owner: a.owner.toBase58(), lamports: BigInt(a.lamports), data: Buffer.from(a.data) } : null; });
  }
  return out;
}
const sameAccount = (x, y) => (!x || !y ? !x === !y : x.owner === y.owner && Buffer.from(x.data).equals(Buffer.from(y.data)));
/**
 * The accounts at `addresses` and the Clock sysvar as each RPC returned them (`views`, one map per RPC) compared: every
 * account must be the same on every RPC (owner and data), and the clocks within CLOCK_TOLERANCE_SECS; `now` is the
 * earliest clock (review R8-DIFF-1). Returns `{ accounts (the first RPC's), now, problems }`.
 */
export function compareChainViews(views, addresses) {
  const problems = [];
  const keys = addresses.map(String);
  const differ = keys.filter((k) => views.some((v) => !sameAccount(v[k] ?? null, views[0][k] ?? null)));
  if (differ.length) problems.push({ code: 'RPC_DISAGREE', message: `the RPCs return different accounts (${differ.slice(0, 4).join(', ')}${differ.length > 4 ? ` and ${differ.length - 4} more` : ''}): one of them is lying or behind` });
  let now = null;
  try {
    const ts = views.map((v) => decodeClock(v[CLOCK_SYSVAR]).unixTimestamp);
    now = ts.reduce((a, b) => (b < a ? b : a));
    const max = ts.reduce((a, b) => (b > a ? b : a));
    if (max - now > CLOCK_TOLERANCE_SECS) problems.push({ code: 'RPC_CLOCK_DISAGREE', message: `the RPCs' clocks (the Clock sysvar) are ${max - now} seconds apart (${ts.map(iso).join(', ')}): one of them is lying or behind (review R8-DIFF-1)` });
  } catch (e) { problems.push({ code: 'NO_CLOCK', message: `the Clock sysvar was not read: ${e.message}` }); }
  return { accounts: Object.fromEntries(keys.map((k) => [k, views[0][k] ?? null])), now, problems };
}
/** `compareChainViews` of the accounts at `addresses` (and the Clock sysvar, in the same request) read from every RPC. */
async function readChainView(connections, addresses) {
  const keys = [...new Set([...addresses.map(String), CLOCK_SYSVAR])];
  return compareChainViews(await Promise.all(connections.map((c) => fetchAccounts(c, keys))), addresses);
}
/** Every pending per-city `Approval` of the program (getProgramAccounts on its discriminator) from every RPC, compared (review R8-DIFF-1): `{ approvals, problems }`. */
async function readApprovals(connections, programId) {
  const views = await Promise.all(connections.map((c) => c.getProgramAccounts(new PublicKey(programId), { filters: [{ memcmp: { offset: 0, bytes: base58(ACCOUNT_DISCRIMINATORS.Approval) } }] })));
  const text = (rows) => rows.map((x) => `${x.pubkey.toBase58()}:${x.account.owner.toBase58()}:${Buffer.from(x.account.data).toString('hex')}`).sort().join('\n');
  if (views.some((v) => text(v) !== text(views[0]))) {
    return { approvals: null, problems: [{ code: 'RPC_DISAGREE', message: `the RPCs return different pending per-city approvals (${views.map((v) => v.length).join(' and ')} accounts): one of them is lying or behind, and a ticker an approval holds could be hidden (review R8-DIFF-1)` }] };
  }
  return { approvals: views[0].map((x) => decodeApproval({ owner: x.account.owner.toBase58(), data: Buffer.from(x.account.data) }, { programId })), problems: [] };
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = `1${s}`; }
  return s;
}
/** One JSON-RPC call (the raw encodings web3.js does not expose). */
async function rpcCall(url, method, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}
/** The data of the `publish_launch_batch` that wrote a stored record. */
const publishData = (r) => {
  const d = Buffer.alloc(8 + 8 + 32 + 4 + 8 + 8);
  KIND.publish.copy(d, 0); d.writeBigUInt64LE(r.seq, 8); Buffer.from(r.root).copy(d, 16); d.writeUInt32LE(r.leafCount, 48); d.writeBigInt64LE(r.validFrom, 52); d.writeBigInt64LE(r.validUntil, 60);
  return d;
};
/**
 * The message hashes of the successful transactions that wrote the stored `record` (review R8-DIFF-2), read from one RPC:
 * those in the record's `published_slot` that name `LaunchBatch` and carry exactly its `publish_launch_batch` (number,
 * root, leaf count and window). Pages back through `getSignaturesForAddress` until that slot is passed.
 */
export async function landedPublicationHashes(url, { launchBatch, record, programId = CURVE_PROGRAM_ID }) {
  const want = publishData(record);
  const out = new Set();
  let before;
  for (let page = 0; page < 20; page++) {
    const sigs = await rpcCall(url, 'getSignaturesForAddress', [String(launchBatch), { limit: 1000, commitment: 'confirmed', ...(before ? { before } : {}) }]);
    for (const s of sigs) {
      if (BigInt(s.slot) !== record.publishedSlot || s.err) continue;
      const tx = await rpcCall(url, 'getTransaction', [s.signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      if (!tx || tx.meta?.err || BigInt(tx.slot) !== record.publishedSlot) continue;
      const wire = Buffer.from(tx.transaction[0], 'base64');
      const d = decodePageTransaction(wire.toString('base64'), { programId });
      if (d.instructions.some((ix) => ix.program === String(programId) && Buffer.from(ix.data).equals(want))) out.add(messageHash(d.messageBytes));
    }
    if (sigs.length < 1000 || BigInt(sigs[sigs.length - 1].slot) < record.publishedSlot) break;
    before = sigs[sigs.length - 1].signature;
  }
  return [...out].sort();
}
/** `landedPublicationHashes` from every RPC, compared: `{ hashes, problems }`. */
async function readLanded(urls, args) {
  const views = await Promise.all(urls.map((u) => landedPublicationHashes(u, args)));
  if (views.some((v) => v.join() !== views[0].join())) {
    return { hashes: null, problems: [{ code: 'RPC_DISAGREE', message: `the RPCs name different transactions as the one that wrote batch ${args.record.seq} (${views.map((v) => v.join(', ') || 'none').join(' and ')}): one of them is lying or behind` }] };
  }
  return { hashes: views[0], problems: [] };
}

// ---------------------------------------------------------------- the command line
const USAGE = 'usage: node scripts/vcurve/batch.mjs verify <list file> --rpc <url> [--rpc <url of another provider>] --approver <key> [--tx <base64>] [--correct] '
  + '[--previous <list file>] [--in-force <list file>] [--archive <dir> | --no-archive] [--cluster mainnet|devnet] [--program-id <id>] [--valid-from <unix> --valid-until <unix>]\n'
  + '       node scripts/vcurve/batch.mjs confirm <seq> <root> --rpc <url> [--rpc <url>] [--archive <dir>] [--discard-others] [--cluster mainnet|devnet] [--program-id <id>]\n'
  + '       node scripts/vcurve/batch.mjs check <list or archive file> --rpc <url> [--rpc <url>] [--cluster mainnet|devnet] [--program-id <id>]';
const FLAGS = new Map([['--rpc', 'rpc'], ['--approver', 'approver'], ['--previous', 'previous'], ['--in-force', 'inForce'], ['--archive', 'archive'], ['--cluster', 'cluster'],
  ['--program-id', 'programId'], ['--valid-from', 'validFrom'], ['--valid-until', 'validUntil'], ['--tx', 'tx']]);
const BOOL_FLAGS = new Map([['--no-archive', 'noArchive'], ['--discard-others', 'discardOthers'], ['--correct', 'correct']]);
const ALLOWED = {
  verify: new Set(['rpc', 'approver', 'previous', 'inForce', 'archive', 'noArchive', 'cluster', 'programId', 'validFrom', 'validUntil', 'tx', 'correct']),
  confirm: new Set(['rpc', 'archive', 'discardOthers', 'cluster', 'programId']),
  check: new Set(['rpc', 'cluster', 'programId']),
};

/** The CLI's options, or `{ error }`. `rpc` is the list of RPC URLs (one, or two of different providers: review R8-DIFF-4). */
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
  const rpcProblem = rpcUrlsProblem(o.rpc);
  if (rpcProblem) return { error: rpcProblem };
  if (mode === 'verify' && !o.approver) return { error: 'verify needs --approver (the key that will sign)' };
  if ((o.validFrom === undefined) !== (o.validUntil === undefined)) return { error: '--valid-from and --valid-until go together' };
  if (o.tx !== undefined && o.validFrom !== undefined) return { error: '--tx carries its own window: no --valid-from or --valid-until' };
  if (o.archive !== undefined && o.noArchive) return { error: '--archive and --no-archive exclude each other' };
  if (mode === 'confirm' && (!/^[1-9][0-9]*$/.test(o.seq) || !/^[0-9a-fA-F]{64}$/.test(o.root))) return { error: 'confirm takes a batch number and a 64-digit hex root' };
  if (o.approver) { try { o.approver = new PublicKey(o.approver).toBase58(); } catch { return { error: `--approver: not a public key: ${o.approver}` }; } }
  return o;
}

/** Open the archive for a run: its entries, and the lines that name it (folder, key fingerprint, a moved folder). */
function openArchive(dir, programId) {
  const arch = readArchive(dir, programId);
  const key = archiveKey();
  const where = noteArchiveDir(dir);
  const lines = [`archive ${where.dir} (key ${archiveKeyPath()}, ${key ? `fingerprint ${keyFingerprint(key)}` : 'not created yet: the first list you verify creates it'})`];
  if (where.moved) {
    lines.push(`warning ARCHIVE_MOVED: this archive folder is not the one this computer used last (${where.last}): a folder someone handed you, or one named in the environment, is not your archive; only lists this computer's key wrote count (review R8-DIFF-5)`);
  }
  for (const x of arch.ignored) lines.push(`warning ARCHIVE_IGNORED: ${x.name}: ${x.why}`);
  return { arch, lines };
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.error) { console.error(`${o.error}\n${USAGE}`); return 2; }
  const cluster = o.cluster ?? 'mainnet'; const programId = o.programId ?? CURVE_PROGRAM_ID;
  const P = curvePdas({ programId, cluster });
  const connections = o.rpc.map((u) => new web3.Connection(u, 'confirmed'));
  const page = (n) => console.log(`${n} problem(s): page the guardian members; have one clear the batch with halt (guardian-stop.mjs --clear) if it is not the one you signed (8.4)`);
  const report = (problems, tail) => { for (const p of problems) console.log(`PROBLEM ${p.code}: ${p.message}`); tail(problems.length); return 1; };
  const retry = (n) => console.log(`${n} problem(s): retry; if the RPCs keep disagreeing, page the guardian members (8.4)`);
  const dontSign = (n) => console.log(`${n} problem(s): do not sign`);
  const open = (dir) => {
    try { const x = openArchive(dir, programId); for (const l of x.lines) console.log(l); return x.arch; } catch (e) {
      if (e instanceof ArchiveKeyError) { console.log(`PROBLEM ARCHIVE_KEY: ${e.message}`); return null; }
      throw e;
    }
  };

  if (o.mode === 'confirm') {
    const dir = archiveDir(o);
    const arch = open(dir);
    if (!arch) { page(1); return 1; }
    const heads = await readChainView(connections, [P.launchpad(), P.launchBatch()]);
    if (heads.problems.length) return report(heads.problems, retry);
    const args = { seq: o.seq, root: o.root, pending: arch.pending, archive: arch.signed, accounts: heads.accounts, discardOthers: Boolean(o.discardOthers), programId, cluster };
    let r = confirmPublication(args);
    const lbAcc = heads.accounts[P.launchBatch()];
    const L = lbAcc ? decodeLaunchBatch(lbAcc, { programId }).latest : null;
    if (!r.problems.length && r.entry && L) {
      // review R8-DIFF-2: the transaction that wrote the record must be the one he verified, on every RPC
      const landedView = await readLanded(o.rpc, { launchBatch: P.launchBatch(), record: L, programId });
      if (landedView.problems.length) return report(landedView.problems, retry);
      r = confirmPublication({ ...args, landed: landedView.hashes });
    }
    if (r.problems.length) return report(r.problems, page);
    if (!r.already) {
      const path = writeArchiveEntry(dir, 'signed', `${L.seq}-${toHex(L.root)}.json`, archiveEntry({ kind: 'signed', file: r.entry.raw.list, record: { ...r.entry.record },
        extra: { preparedAt: r.entry.raw.preparedAt, messageHash: r.entry.raw.messageHash, publishedAt: L.publishedAt, confirmedAt: BigInt(Math.floor(Date.now() / 1000)) } }));
      console.log(`confirmed: ${recordDetail(L)} is the list you verified, written by the transaction you verified (message hash ${r.entry.raw.messageHash}); kept as the next baseline: ${path}`);
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
    // review R8-DIFF-4: with two RPCs, both are read and must agree
    const view = await readChainView(connections, allAddresses(batchAddresses(entries, { programId, cluster })));
    if (view.problems.length) return report(view.problems, retry);
    const { problems } = checkStoredBatch({ file, accounts: view.accounts, programId, cluster });
    for (const p of problems) console.log(`PROBLEM ${p.code}: ${p.message}`);
    if (problems.length) page(problems.length); else console.log(`the stored batch is the list${connections.length > 1 ? ' (both RPCs agree)' : ''}`);
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
  const arch = dir ? open(dir) : { signed: [], pending: [], ignored: [] };
  if (!arch) { dontSign(1); return 1; }
  // review R8-DIFF-1: every account, the clock and the pending approvals from every RPC, compared
  const heads = await readChainView(connections, [P.launchpad(), P.launchBatch()]);
  if (heads.problems.length) return report(heads.problems, dontSign);
  const lb = heads.accounts[P.launchBatch()] ? decodeLaunchBatch(heads.accounts[P.launchBatch()], { programId }) : null;
  const previous = o.previous ? readFileSync(o.previous, 'utf8') : null;
  const inForce = o.inForce ? readFileSync(o.inForce, 'utf8') : null;
  const extra = holderCandidateEntries({ launchBatch: lb, archive: arch.signed, previous, inForce, programId });
  const rest = await readChainView(connections, allAddresses(batchAddresses([...parsed.entries, ...extra], { programId, cluster })));
  if (rest.problems.length) return report(rest.problems, dontSign);
  const accounts = { ...rest.accounts, ...heads.accounts };
  const ap = await readApprovals(connections, programId);
  if (ap.problems.length) return report(ap.problems, dontSign);
  const args = {
    file, previous, inForce, archive: arch.signed, pending: arch.pending, approvals: ap.approvals, accounts, approver: o.approver, now: heads.now, chainConfirmed: connections.length >= 2,
    correct: Boolean(o.correct), pageWindow: Boolean(pageTx), validFrom: pageTx ? pageTx.publish.validFrom : o.validFrom, validUntil: pageTx ? pageTx.publish.validUntil : o.validUntil, programId, cluster,
  };
  let r = verifyListFile(args);
  if (r.needLanded.length) {
    // review R8-DIFF-2: a live record with the window of a pending list: the transaction that wrote it decides what the alarm says
    const landed = new Map();
    for (const rec of r.needLanded) {
      const x = await readLanded(o.rpc, { launchBatch: P.launchBatch(), record: rec, programId });
      if (x.problems.length) return report(x.problems, dontSign);
      landed.set(String(rec.seq), x.hashes);
    }
    r = verifyListFile({ ...args, landed });
  }
  for (const w of r.warnings) console.log(`warning ${w.code}: ${w.message}`);
  for (const p of r.problems) console.log(`PROBLEM ${p.code}: ${p.message}`);
  for (const line of changeLines(r)) console.log(line);
  if (!r.publish) { dontSign(r.problems.length); return 1; }
  const p = r.publish;
  let hash; let text = null;
  if (pageTx) {
    const c = checkPageTransaction(pageTx, p, { approver: o.approver });
    for (const x of c.problems) console.log(`PROBLEM ${x.code}: ${x.message}`);
    if (c.problems.length) { dontSign(c.problems.length); return 1; }
    hash = c.messageHash;
  } else {
    const { blockhash } = await connections[0].getLatestBlockhash('confirmed');
    const toWeb3 = (x) => new web3.TransactionInstruction({ programId: new PublicKey(x.programAddress), data: Buffer.from(x.data),
      keys: x.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })) });
    const tx = new web3.Transaction({ feePayer: new PublicKey(o.approver), recentBlockhash: blockhash }).add(...[p.clear, p.instruction].filter(Boolean).map(toWeb3));
    hash = messageHash(tx.serializeMessage());
    text = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }
  if (dir) {
    const path = writeArchiveEntry(dir, 'pending', `${p.seq}-${toHex(p.root)}-${p.validFrom}.json`, archiveEntry({ kind: 'pending', file: launchBatchFile(r.batch),
      record: { validFrom: p.validFrom, validUntil: p.validUntil, publisher: o.approver }, extra: { preparedAt: heads.now, messageHash: hash, clears: Boolean(p.clear) } }));
    console.log(`kept as pending (never a baseline until you confirm it): ${path}`);
  }
  console.log(`batch ${p.seq}, ${p.leafCount} entries, root ${toHex(p.root)}\nvalid from ${iso(p.validFrom)} until ${iso(p.validUntil)}`);
  if (p.clear) console.log('this transaction first clears the stored batches (clear_launch_batch, halt = false): no stored batch lets anyone launch once it lands, and batch launches pause for everyone until this list takes force (8.4 step 5)');
  console.log(`message hash ${hash}: sign only on a hardware wallet that shows this message hash (blind signing); any other hash is another transaction`);
  if (text) console.log(`unsigned ${p.clear ? 'clear_launch_batch and ' : ''}publish_launch_batch for ${o.approver} (base64; valid for about a minute, until its blockhash expires):\n${text}`);
  else console.log('the website\'s transaction is exactly this publication');
  console.log(`within minutes of its landing, run: node scripts/vcurve/batch.mjs confirm ${p.seq} ${toHex(p.root)} --rpc <url> [--rpc <url of another provider>]`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
