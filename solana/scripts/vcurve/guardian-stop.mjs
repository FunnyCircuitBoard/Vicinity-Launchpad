#!/usr/bin/env node
// A guardian member's stop through the guardian's Squads v4 multisig, in one transaction (VICINITY-CURVE-DESIGN.md 4.4,
// 4.26, 8.1, 8.4 step 5, O35; NOTES 87; review R7-1).
//
// The guardian is a vault of a controlled 1-of-3 Squads multisig with no time lock (O35). A vault call goes through four
// Squads instructions: vault_transaction_create, proposal_create, proposal_approve and vault_transaction_execute. Done
// in two transactions (create, propose and approve, then execute, as the Squads app and most scripts do), it leaves an
// approved proposal on chain between them, and with a threshold of 1 any one member can cancel it
// (proposal_cancel_v2): a thief holding one member key cancels each stop the other members prepare, and their executes
// fail (InvalidProposalStatus). This tool puts all four instructions in one transaction, signed by one member, so no
// approved proposal ever waits to be executed and nothing can be cancelled.
//
// What a thief with a member key can still do is race the multisig's transaction index: a vault transaction is created
// at `transaction_index + 1`, so a create of his landing first makes ours fail. The tool therefore sends variants for
// the next few indices at once (`--variants`, default 4) and repeats with fresh indices (`--rounds`) until the chain
// shows the stop; every index the thief skips costs him the rent of a vault transaction he cannot close.
//
// The stop is `clear_launch_batch(halt = true)` (`--clear`: ends both stored batches and refuses publications until the
// admin's set_launch_approver), `set_pause(launches = true)` (`--pause-launches`, both launch paths) and
// `set_pause(buys = true)` (`--halt-buys`), in that order: pause first, then clear, as 8.4 step 5 says.
//
// The chain is read through two RPCs of different providers that the website does not operate or relay (`--rpc`
// twice), each transaction is sent through both, and the stop counts only when both RPCs show it and one of this
// member's transactions is confirmed: one lying or failing RPC can neither report a stop that is not on chain nor
// drop the stop unseen (review R8-OPS-2). A precondition seen unmet by one RPC only does not keep the member from
// stopping. Each RPC is asked on its own, every call within `--timeout` seconds (default 8): an RPC that fails (an HTTP
// 503) or does not answer is reported and the stop goes ahead through the one that answers; each RPC's blockhash is
// used the moment it arrives and its variants are sent through every RPC at once, so no send waits for a bad RPC
// (the residual of review R8-OPS-2). Everything an RPC returns is checked on its own (review R9-TOOLS-1): a multisig
// transaction index with no room for the variants below 2^64, or a blockhash that is not 32 bytes in base58, is that
// RPC's failure (reported by name), and an exception from one RPC's data is caught where that RPC's work runs, so it
// never stops the other RPC's variants from being printed or sent. When both RPCs answer and disagree on the stop, the
// rounds end once one shows it and one of this member's transactions is confirmed on both (`PROBLEM RPC_DISAGREE`;
// a liar alone that shows the stop and calls every transaction confirmed never ends them; review R9-TOOLS-3). Each
// round's report names every RPC's state. Each transaction carries a
// compute-unit limit and price (`--priority-fee` micro-lamports per compute unit, doubled each round), outside the
// vault message, so a thief paying priority fees for the multisig's next index does not win the slot for nothing
// (review R8-DIFF-7).
//
// Usage (from solana/):
//   node scripts/vcurve/guardian-stop.mjs --rpc <url> --rpc <url of another provider> --multisig <guardian multisig>
//     --keypair <member keypair file> [--clear] [--pause-launches] [--halt-buys] [--vault-index <n>] [--variants <n>]
//     [--rounds <n>] [--priority-fee <micro-lamports per compute unit>] [--timeout <seconds>] [--cluster mainnet|devnet]
//     [--program-id <id>]
//   With --member <key> instead of --keypair it only prints the unsigned transactions (base64) and their message hashes,
//   on every blockhash the RPCs gave.
// The keypair is read from the file to sign and is never printed; an RPC is named by its host only (an API key in its
// path or query is never printed). Exit status 0 when both RPCs show the stop (and, after sending, one of this member's
// transactions is confirmed), 1 when they do not, disagree, or one of them failed or did not answer (the stop is then
// sent through the other, and the output says what each one shows), 2 on a usage error.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import web3 from '@solana/web3.js';
import { ADDRESSES, CURVE_PROGRAM_ID, curveInstructions, curvePdas, decodeLaunchpad, decodeLaunchBatch, findPda } from '../../sdk/curve/index.mjs';
import { SQUADS, SQUADS_ALL_PERMISSIONS, decodeSquadsMultisig, squadsVaultIndexOf, squadsVaultPda } from './preflight.mjs';
import { rpcUrlsProblem } from './batch.mjs';

const { PublicKey } = web3;
const enc = new TextEncoder();
const key = (a) => new PublicKey(String(a?.address ?? a));
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
/** The largest u64: a Squads transaction index is one, and the variants' indices must stay at or below it. */
const MAX_U64 = 2n ** 64n - 1n;

/** Anchor discriminators (`sha256("global:<name>")[..8]`) of the Squads v4 instructions the stop uses. */
export const SQUADS_IX = Object.freeze({
  vault_transaction_create: [48, 250, 78, 168, 208, 226, 218, 211],
  proposal_create: [220, 60, 73, 224, 30, 108, 79, 159],
  proposal_approve: [144, 37, 164, 136, 188, 216, 42, 248],
  proposal_cancel_v2: [205, 41, 194, 61, 220, 139, 16, 247],
  vault_transaction_execute: [194, 8, 161, 87, 153, 164, 25, 171],
});

/** A Squads multisig's address: PDA of `["multisig", "multisig", create_key]`; `[address, bump]`. */
export const squadsMultisigPda = (createKey) => findPda([enc.encode('multisig'), enc.encode('multisig'), key(createKey).toBuffer()], SQUADS.programId);
/** The vault transaction `index` of `multisig`: PDA of `["multisig", multisig, "transaction", index u64 LE]`. */
export const squadsTransactionPda = (multisig, index) => findPda([enc.encode('multisig'), key(multisig).toBuffer(), enc.encode('transaction'), u64(index)], SQUADS.programId)[0];
/** Its proposal: PDA of `["multisig", multisig, "transaction", index u64 LE, "proposal"]`. */
export const squadsProposalPda = (multisig, index) => findPda([enc.encode('multisig'), key(multisig).toBuffer(), enc.encode('transaction'), u64(index), enc.encode('proposal')], SQUADS.programId)[0];

const isSigner = (role) => role >= 2;
const isWritable = (role) => role === 1 || role === 3;
/**
 * The vault's message as Squads stores it (`TransactionMessage`, its compact "small vec" layout), compiled as the Squads
 * SDK compiles it: the vault first (the payer: a writable signer), then each instruction's program (not invoked, so it
 * may stay a plain key) and accounts in order, grouped into writable signers, read-only signers, writable and read-only
 * others. `instructions` are `{ programAddress, accounts: [{ address, role }], data }` (role 0 to 3 as @solana/kit).
 * Returns `{ bytes, keys: [{ address, signer, writable }] }`; no address lookup tables.
 */
export function squadsVaultMessage(vault, instructions) {
  const meta = new Map();
  const touch = (a) => { const k = key(a).toBase58(); if (!meta.has(k)) meta.set(k, { signer: false, writable: false }); return meta.get(k); };
  Object.assign(touch(vault), { signer: true, writable: true });
  for (const ix of instructions) {
    touch(ix.programAddress);
    for (const a of ix.accounts) { const m = touch(a.address); m.signer ||= isSigner(a.role); m.writable ||= isWritable(a.role); }
  }
  const all = [...meta.entries()];
  const group = (s, w) => all.filter(([, m]) => m.signer === s && m.writable === w);
  const ordered = [...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  if (ordered.length > 255) throw new Error('too many accounts for one vault transaction');
  const index = new Map(ordered.map(([k], i) => [k, i]));
  const out = [Buffer.from([group(true, true).length + group(true, false).length, group(true, true).length, group(false, true).length, ordered.length]),
    ...ordered.map(([k]) => key(k).toBuffer()), Buffer.from([instructions.length])];
  for (const ix of instructions) {
    const data = Buffer.from(ix.data);
    if (data.length > 0xffff || ix.accounts.length > 255) throw new Error('an instruction too large for a vault transaction');
    const len = Buffer.alloc(2); len.writeUInt16LE(data.length);
    out.push(Buffer.from([index.get(key(ix.programAddress).toBase58()), ix.accounts.length, ...ix.accounts.map((a) => index.get(key(a.address).toBase58()))]), len, data);
  }
  out.push(Buffer.from([0])); // no address table lookups
  return { bytes: Buffer.concat(out), keys: ordered.map(([address, m]) => ({ address, ...m })) };
}

const ix = (programAddress, accounts, data) => ({ programAddress, accounts: accounts.map(([address, role]) => ({ address: key(address).toBase58(), role })), data: new Uint8Array(data) });
const SYSTEM = ADDRESSES.system;

/**
 * The four Squads instructions of one vault call at `transactionIndex` (which must be the multisig's
 * `transaction_index + 1` when they execute): create, propose, approve and execute, signed by `member` (who pays the
 * rent of the vault transaction and of the proposal unless `rentPayer` is given). `instructions` run as vault
 * `vaultIndex` of `multisig`. Returns `{ create, propose, approve, execute, transaction, proposal, vault }`.
 */
export function squadsVaultCall({ multisig, member, rentPayer = member, vaultIndex = 0, transactionIndex, instructions }) {
  const vault = squadsVaultPda(multisig, vaultIndex);
  const transaction = squadsTransactionPda(multisig, transactionIndex);
  const proposal = squadsProposalPda(multisig, transactionIndex);
  const message = squadsVaultMessage(vault, instructions);
  const msgLen = Buffer.alloc(4); msgLen.writeUInt32LE(message.bytes.length);
  const P = SQUADS.programId;
  return {
    vault, transaction, proposal,
    // VaultTransactionCreateArgs { vault_index u8, ephemeral_signers u8, transaction_message bytes, memo Option<String> }
    create: ix(P, [[multisig, 1], [transaction, 1], [member, 2], [rentPayer, 3], [SYSTEM, 0]],
      Buffer.concat([Buffer.from(SQUADS_IX.vault_transaction_create), Buffer.from([vaultIndex, 0]), msgLen, message.bytes, Buffer.from([0])])),
    // ProposalCreateArgs { transaction_index u64, draft bool }
    propose: ix(P, [[multisig, 0], [proposal, 1], [member, 2], [rentPayer, 3], [SYSTEM, 0]], Buffer.concat([Buffer.from(SQUADS_IX.proposal_create), u64(transactionIndex), Buffer.from([0])])),
    // ProposalVoteArgs { memo Option<String> }
    approve: ix(P, [[multisig, 0], [member, 3], [proposal, 1]], [...SQUADS_IX.proposal_approve, 0]),
    // the vault's message accounts follow, with their writability; the vault itself signs by the program's seeds
    execute: ix(P, [[multisig, 0], [proposal, 1], [transaction, 0], [member, 2], ...message.keys.map((k) => [k.address, k.writable ? 1 : 0])], SQUADS_IX.vault_transaction_execute),
  };
}
/** `proposal_cancel_v2` of a member (any member can cancel an approved proposal in a 1-of-n multisig: what the stop avoids). */
export const squadsProposalCancel = ({ multisig, member, transactionIndex }) =>
  ix(SQUADS.programId, [[multisig, 0], [member, 3], [squadsProposalPda(multisig, transactionIndex), 1], [SYSTEM, 0]], [...SQUADS_IX.proposal_cancel_v2, 0]);

/**
 * The guardian's stop as vicinity_curve instructions signed by the guardian vault: `set_pause(launches = true)` and/or
 * `set_pause(buys = true)` first (one call), then `clear_launch_batch(halt = true)` (4.4, 4.26, 8.4 step 5).
 */
export function guardianStopInner({ guardian, clear = true, pauseLaunches = false, haltBuys = false, programId = CURVE_PROGRAM_ID, cluster = 'mainnet' }) {
  if (!clear && !pauseLaunches && !haltBuys) throw new Error('a stop needs --clear, --pause-launches or --halt-buys');
  const I = curveInstructions({ programId, cluster });
  const out = [];
  if (pauseLaunches || haltBuys) out.push(I.setPause({ authority: guardian, launches: pauseLaunches ? true : null, buys: haltBuys ? true : null }));
  if (clear) out.push(I.clearLaunchBatch({ authority: guardian, halt: true }));
  return out;
}
/**
 * One transaction's instructions for a guardian member's stop at `transactionIndex`: create, propose, approve and
 * execute together (review R7-1), so no approved proposal waits where another member could cancel it.
 */
export function guardianStopInstructions({ multisig, member, vaultIndex = 0, transactionIndex, stop = {}, programId = CURVE_PROGRAM_ID, cluster = 'mainnet' }) {
  const guardian = squadsVaultPda(multisig, vaultIndex);
  const c = squadsVaultCall({ multisig, member, vaultIndex, transactionIndex, instructions: guardianStopInner({ guardian, ...stop, programId, cluster }) });
  return [c.create, c.propose, c.approve, c.execute];
}
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
/** The compute units a stop transaction asks for: a stop costs about 90,000 (NOTES 87), so this leaves a margin and keeps the price per unit high. */
export const STOP_COMPUTE_UNITS = 150_000;
/** The default compute-unit price of the first round (micro-lamports per unit; 0.00015 SOL per transaction), and the most any round pays. */
export const DEFAULT_PRIORITY_FEE = 1_000_000;
export const MAX_PRIORITY_FEE = 50_000_000;
/** `SetComputeUnitLimit(units)` and `SetComputeUnitPrice(microLamports)` (review R8-DIFF-7). */
export function computeBudgetInstructions({ units = STOP_COMPUTE_UNITS, microLamports = DEFAULT_PRIORITY_FEE } = {}) {
  const limit = Buffer.alloc(5); limit[0] = 2; limit.writeUInt32LE(units, 1);
  const price = Buffer.alloc(9); price[0] = 3; price.writeBigUInt64LE(BigInt(microLamports), 1);
  return [ix(COMPUTE_BUDGET, [], limit), ix(COMPUTE_BUDGET, [], price)];
}
/** The compute-unit price of round `round` (from 1): the first round's doubled each round, at most MAX_PRIORITY_FEE. */
export const roundPriorityFee = (base, round) => Math.min(MAX_PRIORITY_FEE, base * 2 ** (round - 1));
/** The instructions of one stop transaction: the compute budget (outside the vault message), then the four Squads instructions. */
export function stopTransactionInstructions({ microLamports = DEFAULT_PRIORITY_FEE, ...args }) {
  return [...computeBudgetInstructions({ microLamports }), ...guardianStopInstructions(args)];
}
/** Whether the chain shows the stop asked for (`launchpad`, `launchBatch` decoded). */
export function stopDone({ launchpad, launchBatch }, { clear = true, pauseLaunches = false, haltBuys = false } = {}) {
  return (!clear || Boolean(launchBatch?.halted && launchBatch.latest.cleared && launchBatch.previous.cleared))
    && (!pauseLaunches || launchpad.launchesPaused) && (!haltBuys || launchpad.buysHalted);
}
/**
 * What must hold before a member's stop can work, from the multisig and the Launchpad: the vault is the guardian,
 * the member holds Initiate, Vote and Execute, the threshold is 1 and there is no time lock (review R7-2). A list of
 * problems (empty when the stop can run).
 */
export function stopPreconditions({ multisig, multisigAccount, member, launchpad, vaultIndex = 0 }) {
  const out = [];
  let ms;
  try { ms = decodeSquadsMultisig(multisigAccount); } catch (e) { return [`${multisig} is not a Squads v4 multisig: ${e.message}`]; }
  const vault = squadsVaultPda(multisig, vaultIndex);
  if (launchpad.guardian !== vault) out.push(`vault ${vaultIndex} of ${multisig} (${vault}) is not the guardian ${launchpad.guardian}${squadsVaultIndexOf(multisig, launchpad.guardian) !== null ? ` (the guardian is vault ${squadsVaultIndexOf(multisig, launchpad.guardian)})` : ''}`);
  const m = ms.members.find((x) => x.key === key(member).toBase58());
  if (!m) out.push(`${key(member).toBase58()} is not a member of ${multisig}`);
  else if ((m.permissions & SQUADS_ALL_PERMISSIONS) !== SQUADS_ALL_PERMISSIONS) out.push(`member ${m.key} lacks a permission (holds ${m.permissions}; Initiate, Vote and Execute are 7)`);
  if (ms.threshold !== 1) out.push(`the threshold is ${ms.threshold}: one member cannot approve alone`);
  if (ms.timeLock !== 0) out.push(`the time lock is ${ms.timeLock} seconds: the execute would wait`);
  return out;
}

/** SHA-256 of a message, base58: what a Ledger shows as the message hash when it blind-signs. */
export const messageHash = (messageBytes) => new PublicKey(createHash('sha256').update(Buffer.from(messageBytes)).digest()).toBase58();

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = (bytes) => {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let t = ''; while (n > 0n) { t = B58[Number(n % 58n)] + t; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; t = `1${t}`; }
  return t;
};
/** The bytes of a base58 string, or null when it is not one. */
const unbase58 = (text) => {
  let n = 0n;
  for (const ch of text) { const i = B58.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of text) { if (ch !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
};
/** Whether an RPC's blockhash is one: a string of 32 bytes in base58, written canonically (review R9-TOOLS-1). */
export function validBlockhash(h) {
  if (typeof h !== 'string' || h.length < 32 || h.length > 44) return false;
  const bytes = unbase58(h);
  return Boolean(bytes) && bytes.length === 32 && base58(bytes) === h;
}
const sameAccount = (x, y) => (!x || !y ? !x === !y : x.owner === y.owner && x.data.equals(y.data));

// ---------------------------------------------------------------- the RPCs (reviews R8-OPS-2 and its residual)
/** How long one RPC call may take before that RPC counts as not answering (seconds; `--timeout`). */
export const DEFAULT_RPC_TIMEOUT_SECS = 8;
/** How long each round waits for the stop to show before the next round sends again (seconds). */
export const ROUND_WAIT_SECS = 30;
/** `promise`, or a rejection "no answer within N s" after `ms` milliseconds: an RPC that never answers cannot hold the stop. */
export function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`no answer within ${ms / 1000} s`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
/** An RPC as the tool names it: its number and host, never its path or query (where an API key lives). */
export function rpcLabel(url, i) {
  let host = '?';
  try { host = new URL(String(url)).host; } catch { /* named by number only */ }
  return `RPC ${i + 1} (${host})`;
}
/** The first line of an error, at most 160 characters, for the per-RPC report. */
const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);
/**
 * The RPCs' views (one per RPC, in `--rpc` order: `{ ok: true, raw, multisigAccount, launchpad, launchBatch }`, or
 * `{ ok: false, error }` for an RPC that failed or did not answer in time) summed up: `answered` (the views that
 * answered), `failed` (the indices of the others), `all` (every RPC answered), `agree` (the answered views hold the same
 * accounts) and `shown` (every answered view shows the stop asked for). The stop is proven only when `all && shown`
 * (review R8-OPS-2): one RPC alone, the other failing, is never proof.
 */
export function summarizeViews(views, stop) {
  const answered = views.filter((v) => v.ok);
  return {
    views, answered, failed: views.map((v, i) => (v.ok ? null : i)).filter((i) => i !== null), all: answered.length === views.length,
    agree: answered.every((v) => v.raw.every((a, i) => sameAccount(a, answered[0].raw[i]))),
    shown: answered.length > 0 && answered.every((v) => v.launchpad && stopDone(v, stop)),
    // review R9-TOOLS-3: at least one answered view shows it (with `all && !shown`, the two RPCs disagree on the stop)
    someShown: answered.some((v) => v.launchpad && stopDone(v, stop)),
  };
}
/**
 * The transaction indices the variants cover (review R9-TOOLS-1): for each RPC's latest view (`known[i]`, or null), the
 * next `variants` indices after the multisig's `transaction_index` as that RPC shows it, so one lying RPC cannot move
 * every variant off the real index; at most `variants` per RPC. A view whose multisig does not decode, or whose index
 * leaves no room for `variants` more below 2^64, is ignored (`ignored`: `{ i, why }`), never thrown on. Returns
 * `{ indices (sorted bigints), ignored }`.
 */
export function nextIndices(known, variants) {
  const out = new Set(); const ignored = [];
  known.forEach((v, i) => {
    if (!v) return;
    let n;
    try { n = decodeSquadsMultisig(v.multisigAccount).transactionIndex; } catch (e) { ignored.push({ i, why: `no Squads multisig (${short(e)})` }); return; }
    if (typeof n !== 'bigint' || n < 0n || n + BigInt(variants) > MAX_U64) { ignored.push({ i, why: `shows the multisig at transaction index ${n}, which leaves no room for ${variants} more below 2^64` }); return; }
    for (let k = 1n; k <= BigInt(variants); k++) out.add(n + k);
  });
  return { indices: [...out].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)), ignored };
}
/** One RPC's state as the tool reports it. */
export function viewLine(v, label, stop) {
  if (!v.ok) return `${label}: failed: ${v.error}`;
  let ms = 'no Squads multisig';
  try { ms = `multisig transaction index ${decodeSquadsMultisig(v.multisigAccount).transactionIndex}`; } catch { /* reported as such */ }
  return `${label}: answered (${ms}; ${!v.launchpad ? 'no Launchpad' : stopDone(v, stop) ? 'shows the stop' : 'does not show the stop'})`;
}
/** The blockhashes the RPCs gave (`got[i]`: a blockhash, or anything else for none), each with the RPCs that gave it. */
export function blockhashGroups(got) {
  const out = new Map();
  got.forEach((h, i) => { if (typeof h === 'string') { if (!out.has(h)) out.set(h, []); out.get(h).push(i); } });
  return out;
}

const USAGE = 'usage: node scripts/vcurve/guardian-stop.mjs --rpc <url> --rpc <url of another provider> --multisig <guardian multisig> (--keypair <member keypair file> | --member <key>) '
  + '[--clear] [--pause-launches] [--halt-buys] [--vault-index <n>] [--variants <n>] [--rounds <n>] [--priority-fee <micro-lamports per compute unit>] [--timeout <seconds>] [--cluster mainnet|devnet] [--program-id <id>]';
const VALUE = new Map([['--rpc', 'rpc'], ['--multisig', 'multisig'], ['--keypair', 'keypair'], ['--member', 'member'], ['--vault-index', 'vaultIndex'], ['--variants', 'variants'],
  ['--rounds', 'rounds'], ['--priority-fee', 'priorityFee'], ['--timeout', 'timeout'], ['--cluster', 'cluster'], ['--program-id', 'programId']]);
const BOOL = new Map([['--clear', 'clear'], ['--pause-launches', 'pauseLaunches'], ['--halt-buys', 'haltBuys']]);
/** The CLI's options, or `{ error }`; `rpc` is the two RPC URLs (two providers, review R8-OPS-2). */
export function parseArgs(argv) {
  const o = { clear: false, pauseLaunches: false, haltBuys: false };
  for (let i = 0; i < argv.length; i++) {
    if (BOOL.has(argv[i])) { o[BOOL.get(argv[i])] = true; continue; }
    if (!VALUE.has(argv[i])) return { error: `unknown option ${argv[i]}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) return { error: `${argv[i - 1]} needs a value` };
    const k = VALUE.get(argv[i - 1]);
    if (k === 'rpc') (o.rpc ??= []).push(v); else o[k] = v;
  }
  if (!o.rpc || !o.multisig) return { error: '--rpc (twice) and --multisig are required' };
  const rpcProblem = rpcUrlsProblem(o.rpc, { min: 2, max: 2 });
  if (rpcProblem) return { error: `${rpcProblem}: the stop is read and sent through two RPCs of different providers that the website does not operate (review R8-OPS-2)` };
  if (Boolean(o.keypair) === Boolean(o.member)) return { error: 'give --keypair (sign and send) or --member (print only), not both' };
  if (!o.clear && !o.pauseLaunches && !o.haltBuys) return { error: 'name the stop: --clear, --pause-launches and/or --halt-buys' };
  for (const [k, lo, hi, d] of [['vaultIndex', 0, 255, 0], ['variants', 1, 16, 4], ['rounds', 1, 50, 5], ['priorityFee', 0, MAX_PRIORITY_FEE, DEFAULT_PRIORITY_FEE], ['timeout', 1, 60, DEFAULT_RPC_TIMEOUT_SECS]]) {
    const n = o[k] === undefined ? d : Number(o[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) return { error: `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be an integer from ${lo} to ${hi}` };
    o[k] = n;
  }
  try { o.multisig = new PublicKey(o.multisig).toBase58(); if (o.member) o.member = new PublicKey(o.member).toBase58(); } catch { return { error: 'not a public key' }; }
  return o;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.error) { console.error(`${o.error}\n${USAGE}`); return 2; }
  const cluster = o.cluster ?? 'mainnet'; const programId = o.programId ?? CURVE_PROGRAM_ID;
  const ms = o.timeout * 1000;
  // a rate-limited RPC fails at once rather than retrying for seconds: the polls retry anyway
  const connections = o.rpc.map((u) => new web3.Connection(u, { commitment: 'confirmed', disableRetryOnRateLimit: true }));
  const labels = o.rpc.map(rpcLabel);
  const names = (is) => is.map((i) => labels[i]).join(' and ');
  const signer = o.keypair ? web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(o.keypair, 'utf8')))) : null;
  const member = signer ? signer.publicKey.toBase58() : o.member;
  const P = curvePdas({ programId, cluster });
  const stop = { clear: o.clear, pauseLaunches: o.pauseLaunches, haltBuys: o.haltBuys };
  const shape = (a) => (a ? { owner: a.owner.toBase58(), lamports: BigInt(a.lamports), data: Buffer.from(a.data) } : null);
  const readOne = async (c) => {
    const raw = (await c.getMultipleAccountsInfo([o.multisig, P.launchpad(), P.launchBatch()].map((k) => new PublicKey(k)))).map(shape);
    let launchpad = null; let launchBatch = null;
    try { launchpad = raw[1] ? decodeLaunchpad(raw[1], { programId }) : null; launchBatch = raw[2] ? decodeLaunchBatch(raw[2], { programId }) : null; } catch { launchpad = null; }
    return { raw, multisigAccount: raw[0], launchpad, launchBatch };
  };
  // review R8-OPS-2: every RPC read on its own, each within the timeout; one that fails or does not answer is reported
  // and never holds the others (its residual: a 503 used to end the run before anything was sent, a silent RPC to hang it)
  const read = async () => summarizeViews(await Promise.all(connections.map((c) => withTimeout(readOne(c), ms).then((v) => ({ ok: true, ...v }), (e) => ({ ok: false, error: short(e) })))), stop);
  const report = (s) => s.views.forEach((v, i) => console.log(viewLine(v, labels[i], stop)));
  /**
   * Which of `sigs` each RPC reports confirmed without error (each asked at once, within the timeout): per RPC a list,
   * or null when it failed. `any`: one confirmed on some RPC; `every`: one confirmed on every RPC (review R9-TOOLS-3).
   */
  const confirmations = async (sigs) => {
    if (!sigs.length) return { any: null, every: null };
    const chunks = []; for (let i = 0; i < sigs.length; i += 256) chunks.push(sigs.slice(i, i + 256));
    const ok = (x) => Boolean(x) && typeof x === 'object' && !x.err && (x.confirmationStatus === 'confirmed' || x.confirmationStatus === 'finalized');
    const per = await Promise.all(connections.map((c) => withTimeout(Promise.all(chunks.map((x) => c.getSignatureStatuses(x).then((r) => r.value))), ms)
      .then((x) => { const st = x.flat(); return sigs.filter((_, i) => ok(st[i])); }, () => null)));
    return { any: per.find((l) => l?.length)?.[0] ?? null, every: sigs.find((sig) => per.every((l) => l?.includes(sig))) ?? null };
  };
  const sleep = (t) => new Promise((ok) => { setTimeout(ok, t); });

  let s = await read();
  report(s);
  if (!s.answered.length) { console.log('PROBLEM: neither RPC answered: nothing can be built; run the stop again at once through two other providers, and tell the other members (8.4 step 5)'); return 1; }
  if (!s.agree) console.log('warning RPC_DISAGREE: the two RPCs return different accounts (the multisig, the Launchpad or LaunchBatch): one of them is lying or behind; the stop goes ahead, and counts only when both show it');
  if (s.failed.length) console.log(`warning RPC_FAILED: ${names(s.failed)} failed or did not answer: the stop goes ahead through the RPC that answers, and counts only when both show it (review R8-OPS-2)`);
  // each RPC's view is checked on its own; whatever its data throws is that view's problem (review R9-TOOLS-1)
  const pres = s.answered.map((v) => {
    if (!v.launchpad) return ['vicinity_curve\'s Launchpad was not found'];
    try { return stopPreconditions({ multisig: o.multisig, multisigAccount: v.multisigAccount, member, launchpad: v.launchpad, vaultIndex: o.vaultIndex }); } catch (e) { return [`the preconditions could not be checked: ${short(e)}`]; }
  });
  if (pres.every((p) => p.length)) { for (const p of pres[0]) console.log(`PROBLEM: ${p}`); return 1; }
  if (s.all && s.shown) { console.log('both RPCs show the stop already (another member\'s, or an earlier one): nothing sent'); return 0; }
  if (s.shown) console.log(`the RPC that answers shows the stop already, but ${names(s.failed)} failed or did not answer: the stop is sent anyway (a repeated stop changes nothing)`);
  // the latest view of each RPC that has answered: the variants cover the next indices as each of them sees the multisig
  const known = s.views.map((v) => (v.ok ? v : null));
  const remember = (x) => x.views.forEach((v, i) => { if (v.ok) known[i] = v; });
  const variantsFor = (blockhash, indices, microLamports) => indices.map((index) => {
    const ixs = stopTransactionInstructions({ multisig: o.multisig, member, vaultIndex: o.vaultIndex, transactionIndex: index, stop, microLamports, programId, cluster });
    return { index, tx: new web3.Transaction({ feePayer: new PublicKey(member), recentBlockhash: blockhash }).add(...ixs.map((x) => new web3.TransactionInstruction({
      programId: new PublicKey(x.programAddress), data: Buffer.from(x.data),
      keys: x.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: isSigner(a.role), isWritable: isWritable(a.role) })),
    }))) };
  });
  const sigs = new Set();
  // the rounds end early when one RPC alone shows the stop with the member's transaction confirmed and the other failed
  // (R8-OPS-2 residual), or when both answer, disagree on the stop, and both confirm the member's transaction (R9-TOOLS-3)
  let ended = false;
  for (let round = 1; round <= o.rounds && !ended; round++) {
    // review R9-TOOLS-1: the next few indices as each RPC sees the multisig, each RPC's checked on its own, so that one
    // lying RPC's index can neither move every variant off the real one nor overflow them
    const { indices, ignored } = nextIndices(known, o.variants);
    for (const x of ignored) console.log(`warning RPC_BAD_INDEX: ${labels[x.i]} ${x.why}: its view is not used for the indices`);
    if (!indices.length) { console.log('PROBLEM: no RPC that answered shows the guardian multisig at a usable transaction index: nothing can be built'); return 1; }
    const microLamports = roundPriorityFee(o.priorityFee, round);
    const hashOf = (r, i) => {
      if (validBlockhash(r?.blockhash)) return r.blockhash;
      throw new Error(`${labels[i]} gave no blockhash: not a blockhash (32 bytes in base58)`);
    };
    if (!signer) {
      // print only: the variants on every blockhash an RPC gave, so that one lying RPC's blockhash cannot spoil them all;
      // each group is built on its own, so an error in one never hides another (review R9-TOOLS-1)
      const got = await Promise.all(connections.map((c, i) => withTimeout(c.getLatestBlockhash('confirmed'), ms).then((x) => {
        try { return hashOf(x, i); } catch { return { error: 'not a blockhash (32 bytes in base58)' }; }
      }, (e) => ({ error: short(e) }))));
      got.forEach((g, i) => { if (typeof g !== 'string') console.log(`${labels[i]}: no blockhash: ${g.error}`); });
      const groups = blockhashGroups(got);
      let printedGroups = 0;
      for (const [blockhash, from] of groups) {
        let text;
        try {
          text = variantsFor(blockhash, indices, microLamports).map(({ index, tx }) => `index ${index}: message hash ${messageHash(tx.serializeMessage())}\n${tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')}`);
        } catch (e) { console.log(`blockhash from ${names(from)}: the variants could not be built: ${short(e)}`); continue; }
        console.log(`blockhash ${blockhash} (from ${names(from)}):`);
        for (const t of text) console.log(t);
        printedGroups++;
      }
      if (!printedGroups) { console.log('PROBLEM: neither RPC gave a blockhash the variants could be built on: nothing can be printed; run it again'); return 1; }
      console.log(`unsigned, with a compute-unit limit of ${STOP_COMPUTE_UNITS} at ${microLamports} micro-lamports per unit: sign every variant with the member key and send them together within a minute through two RPCs of different providers (only the one at the multisig's next index executes; a variant on a blockhash the chain does not know never lands)`);
      return 0;
    }
    // each RPC's blockhash is used as soon as it arrives: its variants are signed and sent through every RPC at once, so
    // no send waits for an RPC that fails or does not answer; whatever one RPC's data throws is that RPC's failure and
    // never rejects the other's work (review R9-TOOLS-1)
    const seen = new Map(); const noHash = []; let variants = 0;
    const sends = connections.map(() => ({ ok: 0, n: 0, error: null }));
    await Promise.all(connections.map((c, i) => withTimeout(c.getLatestBlockhash('confirmed'), ms).then(async (r) => {
      const blockhash = hashOf(r, i);
      if (seen.has(blockhash)) { seen.get(blockhash).push(i); return; }
      seen.set(blockhash, [i]);
      let raws;
      try {
        raws = variantsFor(blockhash, indices, microLamports).map(({ tx }) => { tx.sign(signer); return { raw: tx.serialize(), sig: base58(tx.signature) }; });
      } catch (e) { seen.delete(blockhash); throw new Error(`${labels[i]}'s blockhash: the variants could not be built: ${short(e)}`); }
      for (const x of raws) sigs.add(x.sig);
      variants += raws.length;
      await Promise.all(raws.flatMap(({ raw }) => connections.map((c2, j) => withTimeout(c2.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 }), ms)
        .then(() => { sends[j].ok++; sends[j].n++; }, (e) => { sends[j].n++; sends[j].error = short(e); }))));
    }, (e) => { throw new Error(`${labels[i]} gave no blockhash: ${short(e)}`); }).catch((e) => { noHash.push(short(e)); })));
    for (const x of noHash) console.log(`round ${round}: ${x}`);
    if (!seen.size) {
      console.log(`round ${round}: no RPC gave a blockhash the variants could be built on`);
      await sleep(1_000); s = await read(); remember(s);
      continue;
    }
    console.log(`round ${round}: sent ${variants} variant(s) for indices ${indices.join(', ')} on ${seen.size} blockhash(es) at ${microLamports} micro-lamports per compute unit; `
      + sends.map((x, j) => `${labels[j]} accepted ${x.ok} of ${x.n}${x.error ? ` (${x.error})` : ''}`).join('; '));
    const until = Date.now() + ROUND_WAIT_SECS * 1_000;
    while (Date.now() < until) {
      await sleep(1_000);
      s = await read(); remember(s);
      const mine = s.someShown ? await confirmations([...sigs]) : { any: null, every: null };
      if (s.all && s.shown && mine.any) { report(s); console.log(`the stop is on chain: both RPCs show it, and this member's transaction ${mine.any} is confirmed`); return 0; }
      // the RPC that answers shows it with this member's transaction confirmed, the other does not answer: no further
      // round makes it surer, and one RPC alone is never proof
      if (!s.all && s.shown && mine.any) { ended = true; break; }
      // both answer, one shows the stop, and both confirm this member's transaction: the stop executed, the other RPC
      // lies or lags; a further round would only repeat it (review R9-TOOLS-3). One RPC's confirmation alone ends nothing
      if (s.all && s.someShown && mine.every) { ended = true; break; }
    }
    if (s.all && s.shown) break;
  }
  if (!ended) s = await read();
  report(s);
  const mine = s.someShown ? await confirmations([...sigs]) : { any: null, every: null };
  if (s.all && s.shown && mine.any) { console.log(`the stop is on chain: both RPCs show it, and this member's transaction ${mine.any} is confirmed`); return 0; }
  const answeredNames = names(s.views.map((v, i) => (v.ok ? i : null)).filter((i) => i !== null));
  if (s.shown && !s.all) {
    console.log(`PROBLEM RPC_FAILED: ${answeredNames} shows the stop${mine.any ? ` and this member's transaction ${mine.any} confirmed` : ', but none of this member\'s transactions confirmed'}, and ${names(s.failed)} failed or did not answer: one RPC is no proof (it may lie); check LaunchBatch (halted, both records cleared) through a third provider and tell the other members (8.4 step 5; review R8-OPS-2)`);
    return 1;
  }
  if (s.shown) {
    console.log('PROBLEM: both RPCs show the stop, but none of this member\'s transactions is confirmed on them: it is another member\'s stop, or the RPCs are not to be trusted; check LaunchBatch through a third provider and tell the other members (8.4 step 5)');
    return 1;
  }
  if (s.all && s.someShown) {
    // review R9-TOOLS-3: both answered and they disagree on the stop
    const showing = s.views.map((v, i) => (v.launchpad && stopDone(v, stop) ? i : null)).filter((i) => i !== null);
    const notShowing = s.views.map((_, i) => i).filter((i) => !showing.includes(i));
    const tx = mine.every ? `this member's transaction ${mine.every} is confirmed on both RPCs`
      : mine.any ? `this member's transaction ${mine.any} is confirmed on one RPC only` : 'none of this member\'s transactions is confirmed';
    console.log(`PROBLEM RPC_DISAGREE: ${names(showing)} shows the stop and ${names(notShowing)} does not; ${tx}: one of them is lying or behind; check LaunchBatch (halted, both records cleared) through a third provider and tell the other members (8.4 step 5; review R9-TOOLS-3)`);
    return 1;
  }
  console.log(`PROBLEM: the stop is not on chain after every round (as ${s.all ? 'both RPCs show it' : `${answeredNames || 'no RPC'} shows it; ${names(s.failed)} failed or did not answer`}): another member, the owner (clear with the approver key) or the admin must act (8.4 step 5)`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
