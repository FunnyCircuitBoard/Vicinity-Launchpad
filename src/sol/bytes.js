/**
 * Byte helpers for the Worker's own Solana code (src/sol/*): little-endian integers as BigInt, Solana's compact-u16 (the
 * short-vec length prefix of every message), base64 both ways, and concatenation. No dependencies; every function is pure.
 * Amounts are BigInt end to end so nothing is ever rounded through a JavaScript number.
 */

export const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const U64_MAX = (1n << 64n) - 1n;
/** n as 8 little-endian bytes; refuses anything outside u64. */
export function u64le(n) {
  const v = BigInt(n);
  if (v < 0n || v > U64_MAX) throw new Error("u64_out_of_range");
  const out = new Uint8Array(8);
  for (let i = 0, x = v; i < 8; i++, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
}
export function u32le(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error("u32_out_of_range");
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}
export function u16le(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error("u16_out_of_range");
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
}
/** Little-endian unsigned integer of `size` bytes at `at` as a BigInt. */
export function readUint(bytes, at, size) {
  if (at < 0 || at + size > bytes.length) throw new Error("read_out_of_range");
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
}
export const readU64 = (bytes, at) => readUint(bytes, at, 8);
export const readU128 = (bytes, at) => readUint(bytes, at, 16);
export const readU32 = (bytes, at) => Number(readUint(bytes, at, 4));
export const readU16 = (bytes, at) => Number(readUint(bytes, at, 2));
/** Little-endian signed 64-bit at `at`. */
export function readI64(bytes, at) {
  const v = readU64(bytes, at);
  return v >= 1n << 63n ? v - (1n << 64n) : v;
}

/** Solana's compact-u16 (short_vec): 1 to 3 bytes, 7 bits each, high bit = more. */
export function compactU16(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error("compact_u16_out_of_range");
  const out = [];
  let rem = n;
  for (;;) {
    let b = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) { out.push(b); break; }
    b |= 0x80;
    out.push(b);
  }
  return new Uint8Array(out);
}
/** Reads a compact-u16 at `at`: { value, size }. */
export function readCompactU16(bytes, at) {
  let value = 0, size = 0;
  for (;;) {
    if (at + size >= bytes.length || size >= 3) throw new Error("bad_compact_u16");
    const b = bytes[at + size];
    value |= (b & 0x7f) << (7 * size);
    size++;
    if ((b & 0x80) === 0) break;
  }
  return { value, size };
}

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error("bad_base64");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export const bytesEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
