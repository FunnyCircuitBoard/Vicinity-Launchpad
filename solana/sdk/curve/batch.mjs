// The batch launch approval on the client side (VICINITY-CURVE-DESIGN.md 3.11, 3.12, 4.23 to 4.27, 8.4, 8.6, 14.1):
// the launch leaf byte for byte, the sorted-pair tree (vicinity_rewards' node hash and odd-node promotion,
// sdk/merkle.mjs), proofs and their verification, the checks the program will run on each entry, the canonical list
// file and the day's changes, which stored batch is in force, and the owner's unsigned `publish_launch_batch`.
//
// The website computes the list and prepares the unsigned publication; the owner signs it with the launch approver
// key from his own wallet. Nothing here holds or asks for a key, and nothing here touches the network: chain state is
// passed in (decoded accounts, or sets of what exists).
//
//   leaf = SHA-256( 0x00 || "vicinity_curve/launch_leaf" || 0x01 || program_id || batch_seq u64 LE || city_id u64 LE
//                   || founder || config_id u16 LE || meta_hash || name_len u8 || name || symbol_len u8 || symbol )
//   node = SHA-256( 0x01 || min(a, b) || max(a, b) )
//
// The program's twin is programs/vicinity-curve/src/batch.rs; sdk/fixtures/launch-batch.json (written by
// sdk/curve/gen-launch-batch-fixture.mjs) is checked by both.
import { bytesEqual, fromHex, hashNode, sha256, toHex } from '../merkle.mjs';
import {
  ADDRESSES, BATCH_MAX_LEAD_SECS, BATCH_MAX_VALIDITY_SECS, BATCH_REVIEW_SECS, CURVE_PROGRAM_ID, LAUNCH_LEAF_TAG, LAUNCH_LEAF_VERSION,
  MAX_BATCH_LEAVES, MAX_BATCH_PROOF_LEN, MAX_NAME_LEN, MAX_SYMBOL_LEN, MERKLE_LEAF_PREFIX,
} from './constants.mjs';
import { toKey as pdaKey, u16le, u64le } from './pda.mjs';
import { curveInstructions } from './instructions.mjs';
import web3 from '@solana/web3.js';

/** A key from base58, a PublicKey, a kit address or 32 raw bytes. */
const toKey = (k) => (k instanceof Uint8Array || Array.isArray(k) ? new web3.PublicKey(Uint8Array.from(k)) : pdaKey(k));

const enc = new TextEncoder();
const ZERO = ADDRESSES.system;
const U64_MAX = (1n << 64n) - 1n;

/** The SDK's default window (8.4 step 2, O31): `valid_from = now + 12 hours + 10 minutes`, `valid_until = valid_from + 36 hours`. */
export const DEFAULT_REVIEW_MARGIN_SECS = 600n;
export const DEFAULT_VALIDITY_SECS = 36n * 3_600n;

export class BatchError extends Error {
  constructor(code, detail = '') {
    super(`BatchError::${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'BatchError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- the program's checks on an entry (4.8, 4.27)
// Invisible characters (Unicode default-ignorable code points and the other format characters) and blank characters:
// the ranges of helpers.rs `is_format_char` and `is_blank_char` (review FA-1).
const FORMAT_CHARS = [[0xad, 0xad], [0x34f, 0x34f], [0x600, 0x605], [0x61c, 0x61c], [0x6dd, 0x6dd], [0x70f, 0x70f], [0x890, 0x891], [0x8e2, 0x8e2],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x13430, 0x1343f], [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a], [0xe0000, 0xe0fff]];
const BLANK_CHARS = [[0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x2800, 0x2800],
  [0x3000, 0x3000], [0x1d159, 0x1d159]];
const inRanges = (c, ranges) => ranges.some(([lo, hi]) => c >= lo && c <= hi);
/** helpers.rs `check_name`: null when the program accepts the name, else the reason. */
export function checkName(name) {
  if (typeof name !== 'string') return 'not a string';
  const n = enc.encode(name).length;
  if (n === 0 || n > MAX_NAME_LEN) return `${n} bytes (1 to ${MAX_NAME_LEN})`;
  for (const ch of name) {
    const c = ch.codePointAt(0);
    // Rust's char::is_control is the Cc category: U+0000 to U+001F and U+007F to U+009F
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return `control character U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
    if (inRanges(c, FORMAT_CHARS)) return `invisible character U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
    if (inRanges(c, BLANK_CHARS)) return `blank character U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  if (name.startsWith(' ') || name.endsWith(' ') || name.includes('  ')) return 'a space at an end or two in a row';
  return null;
}
/** helpers.rs `check_symbol`: null when the program accepts the ticker (1 to 10 bytes of A-Z0-9), else the reason. */
export function checkSymbol(symbol) {
  if (typeof symbol !== 'string') return 'not a string';
  if (!/^[A-Z0-9]+$/.test(symbol) || symbol.length > MAX_SYMBOL_LEN) return `ticker ${JSON.stringify(symbol)} is not 1 to ${MAX_SYMBOL_LEN} characters of A-Z0-9`;
  return null;
}

// ---------------------------------------------------------------- leaves
// Every leaf field is taken exactly as given or refused, never filled in or coerced (review MK-1): a missing, null or
// misspelt field would otherwise build a valid leaf for the wrong name ("undefined") or the wrong config (#0), and the
// owner's verifier, which runs this same code, could not tell.
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const isByte = (x) => Number.isInteger(x) && x >= 0 && x <= 255;
const shown = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'string' ? JSON.stringify(v) : `${typeof v} ${String(v)}`);
/** An integer field: a bigint, a safe integer or a string of decimal digits, from 0 to `max`; nothing else (no default, boolean, blank, spaced or fractional value). */
function intField(v, what, max) {
  let n = null;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === 'string' && DECIMAL.test(v)) n = BigInt(v);
  if (n === null) throw new BatchError('BadField', `${what} must be an integer (a bigint, a safe integer or a string of decimal digits), not ${shown(v)}`);
  if (n < 0n || n > max) throw new BatchError('BadField', `${what} ${n} out of range (0 to ${max})`);
  return n;
}
/** 32 bytes: 64 hex digits, a Uint8Array of 32 or an array of 32 bytes. */
function bytes32Of(h, what) {
  if (typeof h === 'string' && HEX64.test(h)) return fromHex(h);
  if (h instanceof Uint8Array && h.length === 32) return Uint8Array.from(h);
  if (Array.isArray(h) && h.length === 32 && h.every(isByte)) return Uint8Array.from(h);
  throw new BatchError('BadField', `${what} must be 32 bytes (64 hex digits, a Uint8Array or an array of bytes), not ${shown(h)}`);
}
/** A key: base58 text, a PublicKey (or anything with `toBase58`) or 32 bytes. */
function keyField(k, what) {
  const bytes = k instanceof Uint8Array || Array.isArray(k);
  const ok = typeof k === 'string' || (bytes && k.length === 32 && [...k].every(isByte)) || (!bytes && k !== null && typeof k === 'object' && typeof k.toBase58 === 'function');
  if (!ok) throw new BatchError('BadField', `${what} must be a key (base58, a PublicKey or 32 bytes), not ${shown(k)}`);
  try { return toKey(k).toBase58(); } catch { throw new BatchError('BadField', `${what} is not a key: ${shown(k)}`); }
}
const textField = (v, what) => {
  if (typeof v !== 'string') throw new BatchError('BadField', `${what} must be a string, not ${shown(v)}`);
  return v;
};
const u64Of = (v, what) => intField(v, what, U64_MAX);
/**
 * An entry in canonical form: `{ cityId: bigint, founder: base58, configId: number, metaHash: Uint8Array, name, symbol }`.
 * Every field is required and taken exactly (review MK-1); a BatchError names the first one that is missing or malformed.
 */
export function normalizeEntry(e) {
  if (e === null || typeof e !== 'object') throw new BatchError('BadField', `an entry must be an object, not ${shown(e)}`);
  return {
    cityId: u64Of(e.cityId, 'city id'), founder: keyField(e.founder, 'founder'), configId: Number(intField(e.configId, 'config id', 0xffffn)),
    metaHash: bytes32Of(e.metaHash, 'meta_hash'), name: textField(e.name, 'name'), symbol: textField(e.symbol, 'symbol'),
  };
}
/** The leaf preimage of 3.12 (146 to 186 bytes for entries the program accepts). */
export function launchLeafPreimage({ programId = CURVE_PROGRAM_ID, batchSeq, ...entry }) {
  const e = normalizeEntry(entry);
  const name = enc.encode(e.name); const symbol = enc.encode(e.symbol);
  if (name.length > 255 || symbol.length > 255) throw new BatchError('BadField', 'a string longer than 255 bytes');
  const parts = [Uint8Array.of(MERKLE_LEAF_PREFIX), enc.encode(LAUNCH_LEAF_TAG), Uint8Array.of(LAUNCH_LEAF_VERSION), toKey(programId).toBytes(),
    u64le(u64Of(batchSeq, 'batch_seq')), u64le(e.cityId), toKey(e.founder).toBytes(), u16le(e.configId), e.metaHash,
    Uint8Array.of(name.length), name, Uint8Array.of(symbol.length), symbol];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
/** The launch leaf of 3.12: what `launch_from_batch` builds from its arguments and signer. */
export const launchLeaf = (args) => sha256(launchLeafPreimage(args));

/** `ceil(log2(n))` for n >= 1 (0 for one leaf): the most siblings a leaf of an n-leaf tree has. */
export function treeDepth(n) {
  let d = 0;
  while ((1 << d) < n) d++;
  return d;
}
/** The longest proof the program accepts for a batch of `leafCount` leaves: `min(9, depth(leafCount))`. */
export const maxProofLen = (leafCount) => Math.min(MAX_BATCH_PROOF_LEN, treeDepth(Number(leafCount)));

/** Every level of the tree, leaves first, root last (odd last node promoted unchanged). */
export function buildLevels(leaves) {
  if (!leaves.length) throw new BatchError('Empty', 'a tree needs at least one leaf');
  const levels = [leaves.map((l) => Uint8Array.from(l))];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashNode(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  return levels;
}
/** The siblings from leaf `index` up, without direction bits. */
export function proofAt(levels, index) {
  const out = [];
  let i = index;
  for (let d = 0; d < levels.length - 1; d++) {
    const s = i ^ 1;
    if (s < levels[d].length) out.push(levels[d][s]);
    i >>= 1;
  }
  return out;
}
/** The program's verification (4.27 checks 8 and 9): the proof no longer than `maxProofLen(leafCount)`, folded to `root`. */
export function verifyLaunchProof({ root, leaf, proof, leafCount }) {
  if (proof.length > maxProofLen(leafCount)) return false;
  let node = Uint8Array.from(leaf);
  for (const s of proof) node = hashNode(node, Uint8Array.from(s));
  return bytesEqual(node, Uint8Array.from(root));
}

// ---------------------------------------------------------------- building a batch (8.4 step 1, 14.1)
/**
 * Why the program would refuse `entry` at its launch today (4.8, 4.10, 4.27), as a list of reasons. `launchpad` is a
 * decoded `Launchpad` (its guardian, payout key and launch approver are refused as founders); `chain` optionally says
 * what exists: `{ coins, legacyCoins, legacyApprovals, approvals: Set of city ids (BigInt or string), tickers: Set of
 * symbols, configs: Map(configId -> decoded LaunchConfig) }`.
 */
export function entryProblems(entry, { launchpad = null, chain = null } = {}) {
  const out = [];
  let e;
  try { e = normalizeEntry(entry); } catch (x) { return [x.message]; }
  if (e.cityId < 1n) out.push('city id 0');
  if (e.founder === ZERO) out.push('founder is zero');
  if (e.founder === ADDRESSES.feeRecipient) out.push('founder is FEE_RECIPIENT');
  if (launchpad) {
    for (const [what, k] of [['the guardian', launchpad.guardian], ['the payout key', launchpad.payoutAuthority], ['the launch approver', launchpad.launchApprover]]) {
      if (k && k !== ZERO && k === e.founder) out.push(`founder is ${what}`);
    }
  }
  const nameErr = checkName(e.name); if (nameErr) out.push(`name: ${nameErr}`);
  const symErr = checkSymbol(e.symbol); if (symErr) out.push(`symbol: ${symErr}`);
  if (e.metaHash.every((x) => x === 0)) out.push('meta_hash is all zeros');
  if (chain) {
    const has = (set, k) => Boolean(set && (set.has(k) || set.has(String(k))));
    if (has(chain.coins, e.cityId)) out.push('the city has a coin');
    if (has(chain.legacyCoins, e.cityId)) out.push('the city has a coin in the old program');
    if (has(chain.legacyApprovals, e.cityId)) out.push('the city has an approval in the old program');
    if (has(chain.approvals, e.cityId)) out.push('the city has a pending per-city approval (it wins, ApprovalPending)');
    if (chain.tickers && chain.tickers.has(e.symbol)) out.push('the ticker is locked');
    if (chain.configs) {
      const c = chain.configs.get(e.configId) ?? chain.configs.get(String(e.configId));
      if (!c) out.push(`config ${e.configId} does not exist`); else if (!c.enabled) out.push(`config ${e.configId} is disabled`);
    }
  }
  return out;
}

/**
 * A launch batch from the day's entries: every entry checked as the program will check it (`entryProblems`), a
 * duplicate city or ticker refused, 1 to 512 entries, sorted by city id, leaves and tree built for `batchSeq` of
 * `programId`. Throws a BatchError listing every problem. Returns `{ version, programId, batchSeq, entries, leaves,
 * levels, root, leafCount, depth }`.
 */
export function buildLaunchBatch(entries, { programId = CURVE_PROGRAM_ID, batchSeq, launchpad = null, chain = null } = {}) {
  if (batchSeq === undefined) throw new BatchError('BadField', 'batchSeq missing (latest.seq + 1)');
  const seq = u64Of(batchSeq, 'batch_seq');
  if (seq === 0n) throw new BatchError('BadField', 'batch 0 is no batch');
  if (!Array.isArray(entries) || entries.length === 0) throw new BatchError('Empty', 'an empty list is not a batch (clear instead)');
  if (entries.length > MAX_BATCH_LEAVES) throw new BatchError('TooMany', `${entries.length} entries (at most ${MAX_BATCH_LEAVES}; the rest wait a day or take the per-city path)`);
  const problems = [];
  const norm = [];
  const cities = new Map(); const tickers = new Map();
  entries.forEach((raw, i) => {
    const p = entryProblems(raw, { launchpad, chain });
    let e = null;
    try { e = normalizeEntry(raw); } catch { /* reported by entryProblems */ }
    if (e) {
      if (cities.has(e.cityId)) p.push(`city ${e.cityId} named twice (entries ${cities.get(e.cityId)} and ${i})`); else cities.set(e.cityId, i);
      if (tickers.has(e.symbol)) p.push(`ticker ${e.symbol} named twice (entries ${tickers.get(e.symbol)} and ${i})`); else tickers.set(e.symbol, i);
    }
    if (p.length) problems.push(`entry ${i} (city ${raw.cityId}): ${p.join('; ')}`);
    if (e) norm.push(e);
  });
  if (problems.length) throw new BatchError('BadEntries', problems.join('\n'));
  norm.sort((a, b) => (a.cityId < b.cityId ? -1 : a.cityId > b.cityId ? 1 : 0));
  const pid = toKey(programId).toBase58();
  const leaves = norm.map((e) => launchLeaf({ programId: pid, batchSeq: seq, ...e }));
  const levels = buildLevels(leaves);
  return { version: 1, programId: pid, batchSeq: seq, entries: norm, leaves, levels, root: levels[levels.length - 1][0], leafCount: norm.length, depth: treeDepth(norm.length) };
}

/** The proof of a city's entry in a built batch. */
export function launchBatchProof(batch, cityId) {
  const i = batch.entries.findIndex((e) => e.cityId === BigInt(cityId));
  if (i < 0) throw new BatchError('NotInBatch', `city ${cityId}`);
  return proofAt(batch.levels, i);
}
/** Everything `ix.launchFromBatch` needs for one city's founder: his entry's fields, the batch number and his proof. */
export function launchBatchArgs(batch, cityId) {
  const e = batch.entries.find((x) => x.cityId === BigInt(cityId));
  if (!e) throw new BatchError('NotInBatch', `city ${cityId}`);
  return { cityId: e.cityId, batchSeq: batch.batchSeq, configId: e.configId, name: e.name, symbol: e.symbol, metaHash: e.metaHash, proof: launchBatchProof(batch, cityId), founder: e.founder };
}

// ---------------------------------------------------------------- the list file (3.12) and the day's changes (8.4)
/** The canonical list file of a batch: version, program id, seq, the entries in city order with every leaf field, the root. */
export function launchBatchFile(batch) {
  return {
    version: batch.version ?? 1, programId: batch.programId, seq: batch.batchSeq.toString(), leafCount: batch.leafCount, root: toHex(batch.root),
    entries: batch.entries.map((e) => ({ cityId: e.cityId.toString(), founder: e.founder, configId: e.configId, metaHash: toHex(e.metaHash), name: e.name, symbol: e.symbol })),
  };
}
const FILE_KEYS = Object.freeze(['entries', 'leafCount', 'programId', 'root', 'seq', 'version']);
const ENTRY_KEYS = Object.freeze(['cityId', 'configId', 'founder', 'metaHash', 'name', 'symbol']);
const HEX64_LOWER = /^[0-9a-f]{64}$/;
/** `o` is an object with exactly `keys` (none missing, none extra), else BadFile. */
function exactKeys(o, keys, what) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new BatchError('BadFile', `${what} is not an object`);
  const have = Object.keys(o);
  const missing = keys.filter((k) => !Object.hasOwn(o, k)); const extra = have.filter((k) => !keys.includes(k));
  if (missing.length || extra.length) {
    throw new BatchError('BadFile', `${what}: ${[missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `unexpected ${extra.join(', ')}` : ''].filter(Boolean).join('; ')}`);
  }
}
/**
 * The schema of a list file (review MK-1): exactly the fields `launchBatchFile` writes, each of its type: `version` 1,
 * `programId` text, `seq` decimal text, `leafCount` an integer, `root` 64 lower-case hex digits, `entries` an array of
 * objects with exactly the six leaf fields (`cityId` decimal text, `founder` text, `configId` an integer, `metaHash` 64
 * lower-case hex digits, `name` and `symbol` text). A missing, null, misspelt or extra field is refused, so a field lost
 * before the root was computed cannot turn into a default.
 */
export function checkLaunchBatchFileSchema(f) {
  exactKeys(f, FILE_KEYS, 'the list file');
  if (f.version !== 1) throw new BatchError('BadFile', `version ${shown(f.version)} (1 expected)`);
  if (typeof f.programId !== 'string') throw new BatchError('BadFile', `programId must be text, not ${shown(f.programId)}`);
  if (typeof f.seq !== 'string' || !DECIMAL.test(f.seq)) throw new BatchError('BadFile', `seq must be decimal text, not ${shown(f.seq)}`);
  if (!Number.isSafeInteger(f.leafCount)) throw new BatchError('BadFile', `leafCount must be an integer, not ${shown(f.leafCount)}`);
  if (typeof f.root !== 'string' || !HEX64_LOWER.test(f.root)) throw new BatchError('BadFile', `root must be 64 lower-case hex digits, not ${shown(f.root)}`);
  if (!Array.isArray(f.entries)) throw new BatchError('BadFile', `entries must be an array, not ${shown(f.entries)}`);
  f.entries.forEach((e, i) => {
    exactKeys(e, ENTRY_KEYS, `entry ${i}`);
    const bad = (field, want) => { throw new BatchError('BadFile', `entry ${i}: ${field} must be ${want}, not ${shown(e[field])}`); };
    if (typeof e.cityId !== 'string' || !DECIMAL.test(e.cityId)) bad('cityId', 'decimal text');
    if (typeof e.founder !== 'string') bad('founder', 'base58 text');
    if (!Number.isSafeInteger(e.configId)) bad('configId', 'an integer');
    if (typeof e.metaHash !== 'string' || !HEX64_LOWER.test(e.metaHash)) bad('metaHash', '64 lower-case hex digits');
    if (typeof e.name !== 'string') bad('name', 'text');
    if (typeof e.symbol !== 'string') bad('symbol', 'text');
  });
}
/**
 * A list file read back: its schema checked (`checkLaunchBatchFileSchema`), the tree rebuilt from its entries, refused
 * unless it gives the file's root and leaf count (no chain checks; see `buildLaunchBatch`).
 */
export function parseLaunchBatchFile(file) {
  let f = file;
  if (typeof file === 'string') {
    try { f = JSON.parse(file); } catch (e) { throw new BatchError('BadFile', `not JSON: ${e.message}`); }
  }
  checkLaunchBatchFileSchema(f);
  const batch = buildLaunchBatch(f.entries, { programId: f.programId, batchSeq: f.seq });
  if (toHex(batch.root) !== f.root) throw new BatchError('BadFile', `root ${f.root} is not the entries' ${toHex(batch.root)}`);
  if (f.leafCount !== batch.leafCount) throw new BatchError('BadFile', `leaf count ${f.leafCount} is not the entries' ${batch.leafCount}`);
  return batch;
}
/** The leaf fields other than the city, in the order the day's changes name them. */
export const LEAF_FIELDS = Object.freeze(['founder', 'configId', 'name', 'symbol', 'metaHash']);
/**
 * The day's changes from batch `prev` (a built batch, a list file, or null) to `next`, by city: added, removed and changed
 * entries; each changed row `{ before, after, fields }` names the leaf fields that differ (review R6-DIFF-2: a change of
 * the metadata hash alone is a change the owner must see).
 */
export function diffLaunchBatches(prev, next) {
  const rows = (b) => {
    if (!b) return new Map();
    const list = b.entries.map((e) => normalizeEntry(e));
    return new Map(list.map((e) => [e.cityId, e]));
  };
  const a = rows(prev); const b = rows(next);
  const differ = (x, y) => LEAF_FIELDS.filter((k) => (k === 'metaHash' ? !bytesEqual(x.metaHash, y.metaHash) : x[k] !== y[k]));
  const added = []; const removed = []; const changed = [];
  for (const [k, e] of b) {
    if (!a.has(k)) { added.push(e); continue; }
    const fields = differ(a.get(k), e);
    if (fields.length) changed.push({ before: a.get(k), after: e, fields });
  }
  for (const [k, e] of a) if (!b.has(k)) removed.push(e);
  const byCity = (x, y) => ((x.cityId ?? x.after.cityId) < (y.cityId ?? y.after.cityId) ? -1 : 1);
  return { added: added.sort(byCity), removed: removed.sort(byCity), changed: changed.sort(byCity) };
}

// ---------------------------------------------------------------- which batch is in force (8.6)
/**
 * The program's check 3 of 4.27 (and 2): the error `launch_from_batch` would return for `batchSeq` at `now`, in its
 * order, or null when that batch is in force. `launchBatch` and `launchpad` are decoded accounts.
 */
export function batchRefusal(launchBatch, launchpad, batchSeq, now) {
  const approver = launchpad.launchApprover;
  if (!approver || approver === ZERO) return 'LaunchApproverNotSet';
  if (launchBatch.halted) return 'BatchesHalted';
  const seq = BigInt(batchSeq); const t = BigInt(now);
  const { latest, previous } = launchBatch;
  let b = null;
  if (seq === latest.seq) b = latest;
  else if (seq === previous.seq && t < latest.validFrom) b = previous;
  if (!b || seq === 0n || b.publisher !== approver) return 'BatchSuperseded';
  if (b.cleared) return 'BatchCleared';
  if (t < b.validFrom) return 'BatchNotYetValid';
  if (t > b.validUntil) return 'BatchExpired';
  return null;
}
/** The batch in force at `now` (8.6): `{ seq, record }` or null. */
export function batchInForce(launchBatch, launchpad, now) {
  for (const record of [launchBatch.latest, launchBatch.previous]) {
    if (batchRefusal(launchBatch, launchpad, record.seq, now) === null) return { seq: record.seq, record };
  }
  return null;
}

// ---------------------------------------------------------------- the owner's unsigned publication (4.25, 8.4 step 2)
/** 4.25 check 6: the window the program accepts at `now` (seconds). */
export function publishWindowOk(now, validFrom, validUntil) {
  const t = BigInt(now); const f = BigInt(validFrom); const u = BigInt(validUntil);
  return t + BATCH_REVIEW_SECS <= f && f <= t + BATCH_MAX_LEAD_SECS && f < u && u <= f + BATCH_MAX_VALIDITY_SECS;
}
/** The SDK's window: from `now + 12 h + reviewMarginSecs` for `validitySecs` (defaults 10 minutes and 36 hours, O31). */
export function defaultPublishWindow(now, { reviewMarginSecs = DEFAULT_REVIEW_MARGIN_SECS, validitySecs = DEFAULT_VALIDITY_SECS } = {}) {
  const validFrom = BigInt(now) + BATCH_REVIEW_SECS + BigInt(reviewMarginSecs);
  return { validFrom, validUntil: validFrom + BigInt(validitySecs) };
}
/**
 * The unsigned `publish_launch_batch` for the owner (8.4 step 2): `seq` must be `latest.seq + 1` of the account read,
 * the batch built for that number, the signer the launch approver of the `Launchpad` read, the path not halted, and the
 * window one the program accepts at `now` (the default window unless one is given). Returns `{ instruction, seq, root,
 * leafCount, validFrom, validUntil }`; throws a BatchError otherwise. The owner compares the root, `seq` and window his
 * own verifier shows before signing.
 */
export function preparePublishLaunchBatch({ batch, launchBatch, launchpad, approver, now, validFrom, validUntil, programId = CURVE_PROGRAM_ID, cluster = 'mainnet', ix }) {
  const builders = ix ?? curveInstructions({ programId, cluster });
  if (!launchpad.launchApprover || launchpad.launchApprover === ZERO) throw new BatchError('NoApprover', 'no launch approver is set');
  if (toKey(approver).toBase58() !== launchpad.launchApprover) throw new BatchError('NotApprover', `${toKey(approver).toBase58()} is not the launch approver ${launchpad.launchApprover}`);
  if (launchBatch.halted) throw new BatchError('Halted', 'publication is halted until the admin sets the launch approver again');
  const seq = launchBatch.latest.seq + 1n;
  if (batch.batchSeq !== seq) throw new BatchError('WrongSeq', `the batch was built for ${batch.batchSeq}, the next number is ${seq}`);
  if (toKey(programId).toBase58() !== batch.programId) throw new BatchError('WrongProgram', `the batch was built for ${batch.programId}`);
  const w = validFrom === undefined ? defaultPublishWindow(now) : { validFrom: BigInt(validFrom), validUntil: BigInt(validUntil) };
  if (!publishWindowOk(now, w.validFrom, w.validUntil)) throw new BatchError('BadWindow', `${w.validFrom}..${w.validUntil} at ${now}: 12 to 48 hours ahead, at most 48 hours long`);
  const instruction = builders.publishLaunchBatch({ approver, seq, root: batch.root, leafCount: batch.leafCount, validFrom: w.validFrom, validUntil: w.validUntil });
  return { instruction, seq, root: batch.root, leafCount: batch.leafCount, ...w };
}
