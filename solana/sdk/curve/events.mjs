// Decoders of the 21 vicinity_curve events (VICINITY-CURVE-DESIGN.md 4.21).
//
// Money movements are emitted by event CPI (`emit_cpi!`): an inner instruction
// to vicinity_curve whose only account is the event authority PDA
// `["__event_authority"]` (signed by the program) and whose data is
// EVENT_IX_TAG, the event discriminator and the Borsh fields. Settings changes
// are emitted with `emit!`, a "Program data: <base64>" log line holding the
// discriminator and the fields.
//
// Indexers decode a whole confirmed transaction with `decodeTransactionEvents`
// (4.21, T56; CLI-2), which accepts events only:
//   * from a transaction that succeeded (`meta.err` null). The runtime records
//     the inner instructions and logs of FAILED transactions too, and a failed
//     transaction reverts everything: a genuine Trade event CPI from a buy that
//     was then made to fail costs its sender only the fee and changed nothing;
//   * for money events, from an inner instruction (stack height 2 or more) of
//     vicinity_curve, called by vicinity_curve itself (the enclosing call), with
//     the event authority PDA as its only account;
//   * for settings events, from "Program data:" lines logged while
//     vicinity_curve was the running program.
// `decodeEventCpi` and `decodeEventLogs` check one instruction or one log list
// only, never the transaction's status: never feed them a failed transaction.
// Indexers also read at `finalized` commitment (or re-check at it), and never
// keep the first event seen for a (coin, trade_seq) and drop later ones: after
// confirmation they reconcile each coin's events with `Coin.trade_seq` and the
// counters of the account (14.1).
import web3 from '@solana/web3.js';
import { CURVE_PROGRAM_ID, EVENT_DISCRIMINATORS, EVENT_IX_TAG } from './constants.mjs';
import { curvePdas } from './pda.mjs';

const { PublicKey } = web3;

/** Field lists in Borsh order (equal to the IDL, checked by events.test.mjs). */
export const EVENT_FIELDS = Object.freeze({
  LaunchpadInitialized: [['admin', 'pubkey'], ['upgrade_authority', 'pubkey'], ['guardian', 'pubkey']],
  AdminProposed: [['admin', 'pubkey'], ['pending_admin', 'pubkey']],
  AdminChanged: [['old_admin', 'pubkey'], ['new_admin', 'pubkey']],
  PauseChanged: [['launches_paused', 'bool'], ['payouts_paused', 'bool'], ['buys_halted', 'bool'], ['buybacks_halted', 'bool'], ['by', 'pubkey']],
  GuardianChanged: [['old', 'pubkey'], ['new', 'pubkey']],
  PayoutConfigChanged: [['old_authority', 'pubkey'], ['new_authority', 'pubkey'], ['old_destination', 'pubkey'], ['new_destination', 'pubkey']],
  ConfigAdded: [['config_id', 'u16'], ['liquidity_bps', 'u16'], ['platform_bps', 'u16'], ['founder_bps', 'u16'], ['holders_bps', 'u16'],
    ['buyback_bps', 'u16'], ['total_fee_bps', 'u16'], ['virtual_sol', 'u64'], ['virtual_tokens', 'u64'], ['curve_supply', 'u64'],
    ['pool_supply', 'u64'], ['graduation_sol', 'u64'], ['launch_fee_lamports', 'u64'], ['enabled', 'bool'], ['created_at', 'i64']],
  ConfigEnabled: [['config_id', 'u16'], ['enabled', 'bool']],
  LaunchApproved: [['city_id', 'u64'], ['founder', 'pubkey'], ['config_id', 'u16'], ['name', 'string'], ['symbol', 'string'],
    ['meta_hash', 'bytes32'], ['expires_at', 'i64']],
  ApprovalRevoked: [['city_id', 'u64'], ['by', 'pubkey']],
  CoinLaunched: [['city_id', 'u64'], ['founder', 'pubkey'], ['mint', 'pubkey'], ['vault', 'pubkey'], ['config_id', 'u16'],
    ['name', 'string'], ['symbol', 'string'], ['uri', 'string'], ['meta_hash', 'bytes32'], ['supply_minted', 'u64'],
    ['dust_burned', 'u64'], ['curve_supply', 'u64'], ['pool_supply', 'u64'], ['graduation_sol', 'u64'], ['virtual_sol', 'u64'],
    ['virtual_tokens', 'u64'], ['liquidity_bps', 'u16'], ['platform_bps', 'u16'], ['founder_bps', 'u16'], ['holders_bps', 'u16'],
    ['buyback_bps', 'u16'], ['total_fee_bps', 'u16'], ['launch_fee', 'u64'], ['slot', 'u64'], ['timestamp', 'i64']],
  Trade: [['city_id', 'u64'], ['mint', 'pubkey'], ['user', 'pubkey'], ['is_buy', 'bool'], ['phase', 'u8'], ['sol_in', 'u64'],
    ['sol_amount', 'u64'], ['sol_net', 'u64'], ['token_amount', 'u64'], ['fee', 'u64'], ['fee_liquidity', 'u64'],
    ['fee_platform', 'u64'], ['fee_founder', 'u64'], ['fee_holders', 'u64'], ['fee_buyback', 'u64'], ['liquidity_dripped', 'u64'],
    ['partial', 'bool'], ['graduated', 'bool'], ['virtual_sol_after', 'u64'], ['virtual_tokens_after', 'u64'],
    ['tokens_sold', 'u64'], ['curve_sol', 'u64'], ['pool_sol', 'u64'], ['pool_tokens', 'u64'], ['liquidity_pending', 'u64'],
    ['trade_seq', 'u64'], ['slot', 'u64'], ['timestamp', 'i64']],
  Graduated: [['city_id', 'u64'], ['mint', 'pubkey'], ['pool_sol', 'u64'], ['pool_tokens', 'u64'], ['liquidity_pending', 'u64'],
    ['last_virtual_sol', 'u64'], ['last_virtual_tokens', 'u64'], ['slot', 'u64'], ['timestamp', 'i64']],
  BuybackBurned: [['city_id', 'u64'], ['mint', 'pubkey'], ['phase', 'u8'], ['sol_spent', 'u64'], ['tokens_burned', 'u64'],
    ['cap', 'u64'], ['buyback_pending_after', 'u64'], ['tokens_burned_total', 'u64'], ['supply_after', 'u64'],
    ['virtual_sol_after', 'u64'], ['virtual_tokens_after', 'u64'], ['slot', 'u64'], ['timestamp', 'i64']],
  PlatformFeesWithdrawn: [['city_id', 'u64'], ['amount', 'u64'], ['total_withdrawn', 'u128']],
  HoldersFeesForwarded: [['city_id', 'u64'], ['amount', 'u64'], ['rewards_vault', 'pubkey'], ['total_forwarded', 'u128']],
  FounderFeesClaimed: [['city_id', 'u64'], ['founder', 'pubkey'], ['amount', 'u64'], ['total_claimed', 'u128']],
  FounderTransferred: [['city_id', 'u64'], ['old', 'pubkey'], ['new', 'pubkey']],
  PayoutOptedIn: [['city_id', 'u64'], ['founder', 'pubkey'], ['destination', 'pubkey'], ['ref_hash', 'bytes32']],
  PayoutOptInRevoked: [['city_id', 'u64'], ['founder', 'pubkey'], ['by', 'pubkey']],
  FounderPaidOut: [['city_id', 'u64'], ['founder', 'pubkey'], ['destination', 'pubkey'], ['amount', 'u64'], ['seq', 'u64'],
    ['ref_hash', 'bytes32'], ['total_paid_out', 'u128']],
});

/** Events emitted by event CPI (money movements); the other thirteen are `emit!` logs. */
export const CPI_EVENTS = Object.freeze(['CoinLaunched', 'Trade', 'Graduated', 'BuybackBurned', 'PlatformFeesWithdrawn',
  'HoldersFeesForwarded', 'FounderFeesClaimed', 'FounderPaidOut']);

const sameBytes = (a, b, at = 0) => b.every((x, i) => a[at + i] === x);

function decodeFields(fields, bytes, start) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = start;
  const need = (n) => { if (at + n > bytes.length) throw new Error('event data too short'); };
  const out = {};
  for (const [name, type] of fields) {
    switch (type) {
      case 'u8': need(1); out[name] = bytes[at]; at += 1; break;
      case 'bool': need(1); if (bytes[at] > 1) throw new Error(`bad bool ${name}`); out[name] = bytes[at] === 1; at += 1; break;
      case 'u16': need(2); out[name] = BigInt(v.getUint16(at, true)); at += 2; break;
      case 'u64': need(8); out[name] = v.getBigUint64(at, true); at += 8; break;
      case 'i64': need(8); out[name] = v.getBigInt64(at, true); at += 8; break;
      case 'u128': need(16); out[name] = v.getBigUint64(at, true) + (v.getBigUint64(at + 8, true) << 64n); at += 16; break;
      case 'pubkey': need(32); out[name] = new PublicKey(bytes.subarray(at, at + 32)).toBase58(); at += 32; break;
      case 'bytes32': need(32); out[name] = Uint8Array.from(bytes.subarray(at, at + 32)); at += 32; break;
      case 'string': {
        need(4); const n = v.getUint32(at, true); at += 4; need(n);
        out[name] = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at, at + n)); at += n; break;
      }
      default: throw new Error(`unknown type ${type}`);
    }
  }
  if (at !== bytes.length) throw new Error(`event data has ${bytes.length - at} extra bytes`);
  return out;
}

/** Decode `discriminator ++ fields` (the payload of a log line or of an event CPI after its tag): `{ name, data }` or null. */
export function decodeEventBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 8) return null;
  for (const [name, disc] of Object.entries(EVENT_DISCRIMINATORS)) {
    if (sameBytes(b, disc)) return { name, data: decodeFields(EVENT_FIELDS[name], b, 8) };
  }
  return null;
}

/**
 * Decode an event CPI: `ix` = `{ programId, accounts: [base58...], data }` of an
 * inner instruction. Returns `{ name, data }` only when it is a vicinity_curve
 * instruction whose single account is the event authority PDA and whose data
 * starts with EVENT_IX_TAG; null otherwise. It checks this one instruction
 * only: whether the transaction succeeded and who called the program are
 * `decodeTransactionEvents`' checks (a failed transaction carries genuine
 * event CPIs of trades that never happened, CLI-2).
 */
export function decodeEventCpi(ix, { programId = CURVE_PROGRAM_ID } = {}) {
  if (String(ix.programId) !== String(programId)) return null;
  const accounts = (ix.accounts ?? []).map(String);
  if (accounts.length !== 1 || accounts[0] !== curvePdas({ programId }).eventAuthority()) return null;
  const d = ix.data instanceof Uint8Array ? ix.data : new Uint8Array(ix.data);
  if (d.length < 16 || !sameBytes(d, EVENT_IX_TAG)) return null;
  return decodeEventBytes(d.subarray(8));
}

/**
 * The `emit!` events in a transaction's logs ("Program data: <base64>" lines of
 * vicinity_curve). The logs of failed transactions are recorded too: use
 * `decodeTransactionEvents`, which reads them only from a successful one.
 */
export function decodeEventLogs(logs, { programId = CURVE_PROGRAM_ID } = {}) {
  const out = [];
  const stack = [];
  for (const line of logs) {
    let m = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (m) { stack.push(m[1]); continue; }
    m = /^Program (\S+) (success|failed)/.exec(line);
    if (m) { stack.pop(); continue; }
    m = /^Program data: (.+)$/.exec(line);
    if (m && stack[stack.length - 1] === String(programId)) {
      const e = decodeEventBytes(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
      if (e) out.push(e);
    }
  }
  return out;
}

// ---------------------------------------------------------------- whole transactions (CLI-2)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 to bytes (instruction data of RPC "json" encoding). */
function fromBase58(str) {
  let n = 0n;
  for (const ch of str) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`not base58: ${ch}`);
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of str) { if (ch !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
const keyString = (k) => (typeof k === 'string' ? k : k instanceof PublicKey ? k.toBase58() : k?.pubkey !== undefined ? keyString(k.pubkey) : String(k));
const dataBytes = (d) => (d instanceof Uint8Array ? d : typeof d === 'string' ? fromBase58(d) : Array.isArray(d) && typeof d[0] === 'string' && d[1] === 'base64' ? Uint8Array.from(atob(d[0]), (c) => c.charCodeAt(0)) : new Uint8Array(d ?? []));

/** The full account list of a transaction message: its static keys, then the addresses loaded from lookup tables (writable, then read-only). */
function transactionKeys(message, meta) {
  const statics = (message.staticAccountKeys ?? message.accountKeys ?? []).map(keyString);
  const loaded = meta?.loadedAddresses ?? {};
  return [...statics, ...(loaded.writable ?? []).map(keyString), ...(loaded.readonly ?? []).map(keyString)];
}
/** `{ program, accounts, data }` of a compiled or parsed instruction. */
function instructionOf(ix, keys) {
  const program = ix.programIdIndex !== undefined ? keys[ix.programIdIndex] : keyString(ix.programId);
  const idx = ix.accountKeyIndexes ?? ix.accounts ?? [];
  const accounts = idx.map((a) => (typeof a === 'number' ? keys[a] : keyString(a)));
  return { program, accounts, data: dataBytes(ix.data) };
}

/**
 * Every vicinity_curve event of one confirmed transaction, the way indexers
 * must accept them (4.21, T56, 14.1; CLI-2). `tx` is what getTransaction
 * returns: `{ meta, transaction: { message } }` (or `{ meta, message }`), with
 * a legacy or v0 message, "json" or "jsonParsed" instructions, or web3.js
 * objects. Returns `[]` when the transaction failed (`meta.err` set): its
 * events describe nothing that happened. Otherwise, in order:
 *   * each event CPI: an inner instruction of vicinity_curve at stack height 2
 *     or more whose enclosing call (the nearest instruction one level up) is
 *     vicinity_curve, whose only account is the event authority PDA and whose
 *     data starts with EVENT_IX_TAG, as `{ name, data, source: 'cpi', index,
 *     stackHeight }` (`index`: the top-level instruction it ran under);
 *   * each `emit!` event logged while vicinity_curve was running, as
 *     `{ name, data, source: 'log' }` (never a money event: those are CPIs).
 * Throws when the metadata cannot prove where an event CPI came from (no
 * `meta`, or inner instructions without `stackHeight`).
 */
export function decodeTransactionEvents(tx, { programId = CURVE_PROGRAM_ID } = {}) {
  const meta = tx?.meta;
  if (!meta) throw new Error('decodeTransactionEvents: no transaction metadata (meta)');
  if (meta.err !== null && meta.err !== undefined) return [];
  const message = tx.transaction?.message ?? tx.message;
  if (!message) throw new Error('decodeTransactionEvents: no message');
  const program = String(programId);
  const eventAuthority = curvePdas({ programId }).eventAuthority();
  const keys = transactionKeys(message, meta);
  const top = (message.compiledInstructions ?? message.instructions ?? []).map((ix) => instructionOf(ix, keys));
  const out = [];
  for (const group of meta.innerInstructions ?? []) {
    const parent = top[group.index];
    if (!parent) throw new Error(`decodeTransactionEvents: inner instructions of a missing instruction ${group.index}`);
    const stack = [null, parent.program]; // stack[h] = the program of the latest instruction at stack height h
    for (const raw of group.instructions ?? []) {
      const h = raw.stackHeight;
      if (!Number.isInteger(h)) throw new Error('decodeTransactionEvents: inner instruction without stackHeight: the enclosing call cannot be checked');
      const ii = instructionOf(raw, keys);
      const caller = h >= 2 ? stack[h - 1] : null;
      stack[h] = ii.program; stack.length = h + 1;
      if (ii.program !== program || h < 2 || caller !== program) continue;
      if (ii.accounts.length !== 1 || ii.accounts[0] !== eventAuthority) continue;
      if (ii.data.length < 16 || !sameBytes(ii.data, EVENT_IX_TAG)) continue;
      const e = decodeEventBytes(ii.data.subarray(8));
      if (e) out.push({ ...e, source: 'cpi', index: group.index, stackHeight: h });
    }
  }
  for (const e of decodeEventLogs(meta.logMessages ?? [], { programId })) {
    if (!CPI_EVENTS.includes(e.name)) out.push({ ...e, source: 'log' });
  }
  return out;
}
