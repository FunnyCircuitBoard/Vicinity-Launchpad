/**
 * Big JSON values in the database (balance history, snapshot lists): gzip-compressed and split
 * into parts, because one database row holds at most 2 MB.
 */
const PART = 500_000; // bytes per row, compressed

export const toBytes = (v) => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : Array.isArray(v) ? Uint8Array.from(v) : new Uint8Array(v || 0));

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzip = (bytes) => pipe(bytes, new CompressionStream("gzip"));
export const gunzip = (bytes) => pipe(bytes, new DecompressionStream("gzip"));

export async function putBlob(db, key, value) {
  const bytes = await gzip(new TextEncoder().encode(JSON.stringify(value)));
  const stmts = [db.prepare("DELETE FROM blobs WHERE key = ?").bind(key)];
  for (let i = 0, part = 0; i < bytes.length || part === 0; i += PART, part++) {
    stmts.push(db.prepare("INSERT INTO blobs (key, part, data) VALUES (?, ?, ?)").bind(key, part, bytes.subarray(i, i + PART)));
  }
  await db.batch(stmts);
}

export async function getBlob(db, key) {
  const { results } = await db.prepare("SELECT data FROM blobs WHERE key = ? ORDER BY part").bind(key).all();
  if (!results.length) return null;
  const parts = results.map((r) => toBytes(r.data));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return JSON.parse(new TextDecoder().decode(await gunzip(all)));
}

export const deleteBlobs = (db, prefix, before) =>
  db.prepare("DELETE FROM blobs WHERE key >= ? AND key < ?").bind(prefix, prefix + before);

export async function sha256hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", typeof text === "string" ? new TextEncoder().encode(text) : text));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
