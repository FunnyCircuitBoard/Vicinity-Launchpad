/**
 * The Worker's own transaction message compiler: a list of instructions becomes the exact bytes a wallet signs, without
 * @solana/web3.js. Byte-for-byte parity with web3.js's TransactionMessage.compileToLegacyMessage / compileToV0Message is
 * proven in solana/tests-launchpad/15-worker-builder.test.mjs (same instruction lists, same lookup tables, same bytes).
 *
 * Instructions are the SDK's @solana/kit shape: { programAddress, accounts: [{ address, role }], data }, role 0 read-only,
 * 1 writable, 2 read-only signer, 3 writable signer.
 *
 * Account ordering = web3.js CompiledKeys: the fee payer first, then every key in the order it is first met walking the
 * instructions (a program id before that instruction's accounts), merged by OR of signer / writable; then sorted into the
 * four groups writable signers, read-only signers, writable, read-only (insertion order kept inside a group). In a v0
 * message a key that signs or is invoked as a program always stays static; any other key found in a lookup table is taken
 * from the table (tables in the order given, the first index of the key in a table, writable then read-only per table).
 *
 * Wire formats (Solana docs "Transactions"): a transaction is compact-u16 signatures count, 64 bytes per signature, then
 * the message. Legacy message: header (3 bytes) + compact-u16 keys + 32 bytes each + blockhash + compact-u16 instructions,
 * each program index u8, compact-u16 account indexes (u8 each), compact-u16 data. A v0 message is the byte 0x80 then the
 * same, then compact-u16 lookups, each the table key + compact-u16 writable indexes + compact-u16 read-only indexes.
 */
import { base58Decode, base58Encode } from "../solana.js";
import { compactU16, concat, readCompactU16 } from "./bytes.js";

/** Solana's packet limit for one transaction, signatures included. */
export const MAX_TX_BYTES = 1232;

function compiledKeys(payer, instructions) {
  const meta = new Map(); // address -> { isSigner, isWritable, isInvoked }
  const get = (a) => { let m = meta.get(a); if (!m) { m = { isSigner: false, isWritable: false, isInvoked: false }; meta.set(a, m); } return m; };
  const p = get(payer); p.isSigner = true; p.isWritable = true;
  for (const ix of instructions) {
    get(ix.programAddress).isInvoked = true;
    for (const a of ix.accounts) { const m = get(a.address); m.isSigner ||= (a.role & 2) !== 0; m.isWritable ||= (a.role & 1) !== 0; }
  }
  return meta;
}
function components(meta) {
  const ws = [], rs = [], wn = [], rn = [];
  for (const [a, m] of meta) (m.isSigner ? (m.isWritable ? ws : rs) : m.isWritable ? wn : rn).push(a);
  const header = { numRequiredSignatures: ws.length + rs.length, numReadonlySignedAccounts: rs.length, numReadonlyUnsignedAccounts: rn.length };
  return { header, staticKeys: [...ws, ...rs, ...wn, ...rn] };
}
/** Drain the keys of `meta` that a table holds (never a signer or a program): web3.js extractTableLookup. */
function extractLookup(meta, table) {
  const drain = (filter) => {
    const indexes = [], keys = [];
    for (const [a, m] of [...meta]) {
      if (!filter(m)) continue;
      const i = table.addresses.indexOf(a);
      if (i < 0) continue;
      if (i > 255) throw new Error("lookup_index_too_large");
      indexes.push(i); keys.push(a); meta.delete(a);
    }
    return [indexes, keys];
  };
  const [wi, wk] = drain((m) => !m.isSigner && !m.isInvoked && m.isWritable);
  const [ri, rk] = drain((m) => !m.isSigner && !m.isInvoked && !m.isWritable);
  if (!wi.length && !ri.length) return null;
  return { lookup: { key: table.key, writableIndexes: wi, readonlyIndexes: ri }, writable: wk, readonly: rk };
}
function compileInstructions(instructions, keys) {
  const index = new Map(keys.map((k, i) => [k, i]));
  const at = (a) => { const i = index.get(a); if (i === undefined) throw new Error("unknown_account_" + a.slice(0, 6)); if (i > 255) throw new Error("account_index_overflow"); return i; };
  return instructions.map((ix) => ({ programIdIndex: at(ix.programAddress), accountKeyIndexes: ix.accounts.map((a) => at(a.address)), data: ix.data }));
}
const header3 = (h) => new Uint8Array([h.numRequiredSignatures, h.numReadonlySignedAccounts, h.numReadonlyUnsignedAccounts]);
function ixBytes(c) {
  return concat([Uint8Array.of(c.programIdIndex), compactU16(c.accountKeyIndexes.length), Uint8Array.from(c.accountKeyIndexes), compactU16(c.data.length), c.data]);
}

/** Legacy message bytes for `instructions` paid by `payer` with `blockhash` (base58). */
export function compileLegacy({ payer, instructions, blockhash }) {
  const { header, staticKeys } = components(compiledKeys(payer, instructions));
  const compiled = compileInstructions(instructions, staticKeys);
  return concat([header3(header), compactU16(staticKeys.length), ...staticKeys.map(base58Decode), base58Decode(blockhash), compactU16(compiled.length), ...compiled.map(ixBytes)]);
}
/** Version-0 message bytes; lookupTables: [{ key, addresses: [base58] }] in the order to try them. */
export function compileV0({ payer, instructions, blockhash, lookupTables = [] }) {
  const meta = compiledKeys(payer, instructions);
  const lookups = [], fromTables = { writable: [], readonly: [] };
  for (const t of lookupTables) {
    const r = extractLookup(meta, t);
    if (r) { lookups.push(r.lookup); fromTables.writable.push(...r.writable); fromTables.readonly.push(...r.readonly); }
  }
  const { header, staticKeys } = components(meta);
  const compiled = compileInstructions(instructions, [...staticKeys, ...fromTables.writable, ...fromTables.readonly]);
  return concat([
    Uint8Array.of(0x80), header3(header), compactU16(staticKeys.length), ...staticKeys.map(base58Decode), base58Decode(blockhash),
    compactU16(compiled.length), ...compiled.map(ixBytes),
    compactU16(lookups.length), ...lookups.map((l) => concat([base58Decode(l.key), compactU16(l.writableIndexes.length), Uint8Array.from(l.writableIndexes), compactU16(l.readonlyIndexes.length), Uint8Array.from(l.readonlyIndexes)])),
  ]);
}
/** The signers a message needs (header.numRequiredSignatures), from its bytes. */
export function numSignersOf(message) {
  const v0 = (message[0] & 0x80) !== 0;
  return message[v0 ? 1 : 0];
}
/** An unsigned transaction: zeroed signature slots in front of the message (what the wallet fills). */
export function wrapUnsigned(message, numSigners = numSignersOf(message)) {
  return concat([compactU16(numSigners), new Uint8Array(64 * numSigners), message]);
}
/** Every address a message holds statically (static keys; lookups are not resolved here). */
export function staticKeysOf(message) {
  const d = decodeHeader(message, { message: true });
  return d.staticKeys;
}

/**
 * Reads the envelope of a transaction (or, with { message: true }, of a bare message): signature count and whether each
 * slot is filled, the version (0 or "legacy"), the header, the static keys, the blockhash, the instructions (program and
 * account indexes, data) and the lookups. Throws a short code on anything malformed. Used by the relay to refuse what it
 * must never send, and by the simulation error mapping to name the program an error came from.
 */
export function decodeHeader(bytes, { message = false } = {}) {
  let at = 0;
  const out = { numSignatures: 0, signaturesFilled: [], version: "legacy" };
  if (!message) {
    const n = readCompactU16(bytes, at); at += n.size;
    out.numSignatures = n.value;
    if (n.value < 1 || n.value > 8) throw new Error("bad_signature_count");
    for (let i = 0; i < n.value; i++) {
      if (at + 64 > bytes.length) throw new Error("truncated");
      out.signaturesFilled.push(bytes.subarray(at, at + 64).some((x) => x !== 0));
      at += 64;
    }
    out.messageOffset = at;
  }
  if (at >= bytes.length) throw new Error("truncated");
  if ((bytes[at] & 0x80) !== 0) { out.version = bytes[at] & 0x7f; if (out.version !== 0) throw new Error("unknown_version"); at++; }
  if (at + 3 > bytes.length) throw new Error("truncated");
  out.header = { numRequiredSignatures: bytes[at], numReadonlySignedAccounts: bytes[at + 1], numReadonlyUnsignedAccounts: bytes[at + 2] }; at += 3;
  const nk = readCompactU16(bytes, at); at += nk.size;
  if (at + 32 * nk.value > bytes.length) throw new Error("truncated");
  out.staticKeys = [];
  for (let i = 0; i < nk.value; i++, at += 32) out.staticKeys.push(base58Encode(bytes.subarray(at, at + 32)));
  if (at + 32 > bytes.length) throw new Error("truncated");
  out.blockhash = base58Encode(bytes.subarray(at, at + 32)); at += 32;
  const ni = readCompactU16(bytes, at); at += ni.size;
  out.instructions = [];
  for (let i = 0; i < ni.value; i++) {
    if (at >= bytes.length) throw new Error("truncated");
    const programIdIndex = bytes[at++];
    const na = readCompactU16(bytes, at); at += na.size;
    if (at + na.value > bytes.length) throw new Error("truncated");
    const accountKeyIndexes = [...bytes.subarray(at, at + na.value)]; at += na.value;
    const nd = readCompactU16(bytes, at); at += nd.size;
    if (at + nd.value > bytes.length) throw new Error("truncated");
    out.instructions.push({ programIdIndex, accountKeyIndexes, data: bytes.slice(at, at + nd.value) }); at += nd.value;
  }
  out.lookups = [];
  if (out.version === 0) {
    const nl = readCompactU16(bytes, at); at += nl.size;
    for (let i = 0; i < nl.value; i++) {
      if (at + 32 > bytes.length) throw new Error("truncated");
      const key = base58Encode(bytes.subarray(at, at + 32)); at += 32;
      const nw = readCompactU16(bytes, at); at += nw.size;
      const writableIndexes = [...bytes.subarray(at, at + nw.value)]; at += nw.value;
      const nr = readCompactU16(bytes, at); at += nr.size;
      const readonlyIndexes = [...bytes.subarray(at, at + nr.value)]; at += nr.value;
      out.lookups.push({ key, writableIndexes, readonlyIndexes });
    }
  }
  if (at !== bytes.length) throw new Error("trailing_bytes");
  if (!message && out.numSignatures !== out.header.numRequiredSignatures) throw new Error("signature_count_mismatch");
  return out;
}
/** The program id of compiled instruction `i` when it is a static key (a program is always static), else null. */
export const programOfInstruction = (decoded, i) => decoded.staticKeys[decoded.instructions[i]?.programIdIndex] || null;
