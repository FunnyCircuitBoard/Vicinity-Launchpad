// D01 devnet rehearsal helpers (scratchpad only). DEVNET ONLY: every connection is checked against the devnet
// genesis hash before anything is sent; keys are read from the throwaway key folder and never printed.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const SOL_DIR = '/tmp/claude-0/-home-user-Vicinity-Launchpad/259e7af3-62d7-56de-8406-76246b95043c/scratchpad/vcurve/solana';
export const KEYS = '/tmp/claude-0/-home-user-Vicinity-Launchpad/259e7af3-62d7-56de-8406-76246b95043c/scratchpad/solana-keys/devnet-d01';
export const OLD_KEYS = '/tmp/claude-0/-home-user-Vicinity-Launchpad/259e7af3-62d7-56de-8406-76246b95043c/scratchpad/solana-keys';
export const TOOLS = '/tmp/claude-0/-home-user-Vicinity-Launchpad/259e7af3-62d7-56de-8406-76246b95043c/scratchpad/d01-tools';
export const TARGET = process.env.D01_TARGET ?? 'local';
if (!['local', 'devnet'].includes(TARGET)) throw new Error(`D01_TARGET must be local or devnet: ${TARGET}`);
export const LOG = `${TOOLS}/d01-log-${TARGET}.jsonl`;
export const STATE = `${TOOLS}/d01-state-${TARGET}.json`;
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TESTNET_GENESIS = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';
export const RPCS = TARGET === 'devnet'
  ? ['https://api.devnet.solana.com', 'https://solana-devnet.gateway.tatum.io', 'https://solana-devnet.api.onfinality.io/public']
  : ['http://127.0.0.1:8899', 'http://127.0.0.2:8899'];
export const [RPC_A, RPC_B] = RPCS;

const require = createRequire(`${SOL_DIR}/package.json`);
export const web3 = require('@solana/web3.js');
const sqRequire = createRequire('/tmp/claude-0/-home-user-Vicinity-Launchpad/259e7af3-62d7-56de-8406-76246b95043c/scratchpad/cc-rehearsal/sqds/package.json');
export const squads = () => sqRequire('@sqds/multisig');
export const S = await import(`${SOL_DIR}/sdk/curve/index.mjs`);
const { PublicKey, Keypair, Connection, TransactionInstruction, TransactionMessage, VersionedTransaction } = web3;

export const kp = (name) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${KEYS}/${name}.json`, 'utf8'))));
export const oldKp = (file) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${OLD_KEYS}/${file}`, 'utf8'))));
export const pk = (a) => new PublicKey(String(a?.address ?? a));

const checked = new Map();
export async function devnet(url = RPC_A) {
  const c = new Connection(url, { commitment: 'confirmed' });
  if (!checked.get(url)) {
    const g = await withRetry(() => c.getGenesisHash(), `genesis ${new URL(url).host}`);
    const host = new URL(url).hostname;
    if (TARGET === 'devnet' && g !== DEVNET_GENESIS) throw new Error(`NOT DEVNET: ${host} genesis ${g}`);
    if (TARGET === 'local' && (!/^127\./.test(host) || g === MAINNET_GENESIS || g === DEVNET_GENESIS || g === TESTNET_GENESIS)) throw new Error(`NOT THE LOCAL VALIDATOR: ${host} genesis ${g}`);
    checked.set(url, true);
  }
  return c;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function withRetry(fn, what, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const msg = String(e?.message ?? e);
      if (/custom program error|InstructionError|Simulation failed|insufficient|NOT DEVNET/i.test(msg)) throw e;
      await sleep(1500 * 2 ** i);
    }
  }
  throw new Error(`${what}: ${last?.message ?? last}`);
}

/** A kit-shaped instruction of the SDK as a web3.js TransactionInstruction. */
export function toWeb3(ix) {
  if (ix instanceof TransactionInstruction) return ix;
  if (ix && ix.programId && ix.keys) return new TransactionInstruction({ programId: pk(ix.programId.toBase58()), data: Buffer.from(ix.data), keys: ix.keys.map((k) => ({ pubkey: pk(k.pubkey.toBase58()), isSigner: k.isSigner, isWritable: k.isWritable })) });
  return new TransactionInstruction({
    programId: pk(ix.programAddress),
    keys: ix.accounts.map((a) => ({ pubkey: pk(a.address), isSigner: a.role >= 2, isWritable: (a.role & 1) === 1 })),
    data: Buffer.from(ix.data),
  });
}

export function loadState() { return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}; }
export function saveState(s) { writeFileSync(STATE, JSON.stringify(s, null, 1)); }
export function record(entry) { appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n'); }

/** Per top-level program invocation: [{ program, consumed }] from the log lines (builtins log no "consumed" line). */
export function topLevelCu(logs = []) {
  const res = []; let depth = 0;
  for (const l of logs) {
    const inv = /^Program (\w+) invoke \[(\d+)\]$/.exec(l);
    if (inv) { depth = Number(inv[2]); continue; }
    const m = /^Program (\w+) consumed (\d+) of (\d+) compute units$/.exec(l);
    if (m) { if (depth === 1) res.push({ program: m[1], consumed: Number(m[2]) }); continue; }
    if (/^Program (\w+) (success|failed)/.test(l)) depth -= 1;
  }
  return res;
}

export function errorName(err, logs = []) {
  const code = S.programErrorOf ? null : null;
  const m = logs.map((l) => /Error Code: (\w+)/.exec(l)).find(Boolean);
  if (m) return m[1];
  const c = /"Custom":(\d+)/.exec(JSON.stringify(err ?? ''));
  if (c) {
    const n = Number(c[1]);
    const name = Object.entries(S.ERROR_CODES ?? {}).find(([, v]) => Number(v) === n)?.[0];
    return name ? `${name} (${n})` : `Custom ${n}`;
  }
  return JSON.stringify(err);
}

/**
 * Sends one transaction (v0, optional lookup tables) through `conn`, waits for it, reads it back and records the
 * signature, compute units (total and per top-level program), fee, size and the decoded vicinity_curve events.
 * `expectError` sends with skipPreflight so the failure lands on chain, and requires that error name.
 */
export async function send(conn, label, ixs, signers, { phase = '', cuLimit, cuPrice, expectError, lookupTables = [], note } = {}) {
  const payer = signers[0];
  const list = [];
  if (cuLimit) list.push(toWeb3(S.setComputeUnitLimit(cuLimit)));
  if (cuPrice) list.push(toWeb3(S.setComputeUnitPrice(cuPrice)));
  list.push(...ixs.map(toWeb3));
  for (let attempt = 0; attempt < 5; attempt++) {
    const { blockhash, lastValidBlockHeight } = await withRetry(() => conn.getLatestBlockhash('confirmed'), 'blockhash');
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: list }).compileToV0Message(lookupTables);
    const tx = new VersionedTransaction(msg);
    const need = new Set(msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58()));
    tx.sign(signers.filter((s, i, a) => need.has(s.publicKey.toBase58()) && a.findIndex((x) => x.publicKey.equals(s.publicKey)) === i));
    const bytes = tx.serialize().length;
    let sig;
    try {
      sig = await conn.sendTransaction(tx, { skipPreflight: Boolean(expectError), maxRetries: 3, preflightCommitment: 'confirmed' });
    } catch (e) {
      const logs = e?.logs ?? (typeof e?.getLogs === 'function' ? await e.getLogs(conn).catch(() => []) : []);
      if (/Blockhash not found|block height exceeded/i.test(String(e?.message))) { await sleep(2000); continue; }
      record({ phase, label, ok: false, preflight: true, error: errorName(null, logs) || String(e?.message).slice(0, 300), bytes, note });
      const err = new Error(`${label}: preflight refused: ${String(e?.message).slice(0, 400)}\n${(logs ?? []).slice(-12).join('\n')}`);
      err.logs = logs; throw err;
    }
    const res = await confirmSig(conn, sig, blockhash, lastValidBlockHeight);
    if (res === 'expired') { await sleep(1000); continue; }
    const got = await withRetry(async () => { const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); if (!t) throw new Error('not yet'); return t; }, `getTransaction ${sig}`, 8);
    const logs = got.meta?.logMessages ?? [];
    const err = got.meta?.err ?? null;
    let events = [];
    try { events = S.decodeTransactionEvents(got).map((e) => e.name); } catch { events = ['(decoder threw)']; }
    const entry = {
      phase, label, sig, slot: got.slot, ok: !err, error: err ? errorName(err, logs) : undefined,
      cu: got.meta?.computeUnitsConsumed, fee: got.meta?.fee, bytes, perProgram: topLevelCu(logs), events, note,
    };
    record(entry);
    if (expectError) {
      if (!err) throw new Error(`${label}: expected ${expectError} but it succeeded (${sig})`);
      if (!String(entry.error).includes(expectError)) throw new Error(`${label}: expected ${expectError}, got ${entry.error} (${sig})`);
    } else if (err) {
      const e2 = new Error(`${label}: failed on chain ${entry.error} (${sig})\n${logs.slice(-15).join('\n')}`); e2.logs = logs; throw e2;
    }
    console.log(`${label}: ${sig} cu=${entry.cu} fee=${entry.fee} bytes=${bytes}${err ? ` FAILED(as expected) ${entry.error}` : ''}`);
    return entry;
  }
  throw new Error(`${label}: blockhash kept expiring`);
}

async function confirmSig(conn, sig, blockhash, lastValidBlockHeight) {
  for (let i = 0; i < 90; i++) {
    const st = await conn.getSignatureStatuses([sig]).catch(() => null);
    const v = st?.value?.[0];
    if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) return 'ok';
    const h = await conn.getBlockHeight('confirmed').catch(() => 0);
    if (h > lastValidBlockHeight) return 'expired';
    await sleep(1000);
  }
  return 'expired';
}

export async function account(conn, address) { return withRetry(() => conn.getAccountInfo(pk(address), 'confirmed'), `account ${address}`); }
export const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
export const lamportsOf = async (conn, a) => BigInt(await withRetry(() => conn.getBalance(pk(a), 'confirmed'), 'balance'));
