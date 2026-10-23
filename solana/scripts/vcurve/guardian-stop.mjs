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
// stopping. Each transaction carries a compute-unit limit and price (`--priority-fee` micro-lamports per compute unit,
// doubled each round), outside the vault message, so a thief paying priority fees for the multisig's next index does
// not win the slot for nothing (review R8-DIFF-7).
//
// Usage (from solana/):
//   node scripts/vcurve/guardian-stop.mjs --rpc <url> --rpc <url of another provider> --multisig <guardian multisig>
//     --keypair <member keypair file> [--clear] [--pause-launches] [--halt-buys] [--vault-index <n>] [--variants <n>]
//     [--rounds <n>] [--priority-fee <micro-lamports per compute unit>] [--cluster mainnet|devnet] [--program-id <id>]
//   With --member <key> instead of --keypair it only prints the unsigned transactions (base64) and their message hashes.
// The keypair is read from the file to sign and is never printed. Exit status 0 when both RPCs show the stop (and,
// after sending, one of this member's transactions is confirmed), 1 when they do not, 2 on a usage error.
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
const sameAccount = (x, y) => (!x || !y ? !x === !y : x.owner === y.owner && x.data.equals(y.data));

const USAGE = 'usage: node scripts/vcurve/guardian-stop.mjs --rpc <url> --rpc <url of another provider> --multisig <guardian multisig> (--keypair <member keypair file> | --member <key>) '
  + '[--clear] [--pause-launches] [--halt-buys] [--vault-index <n>] [--variants <n>] [--rounds <n>] [--priority-fee <micro-lamports per compute unit>] [--cluster mainnet|devnet] [--program-id <id>]';
const VALUE = new Map([['--rpc', 'rpc'], ['--multisig', 'multisig'], ['--keypair', 'keypair'], ['--member', 'member'], ['--vault-index', 'vaultIndex'], ['--variants', 'variants'],
  ['--rounds', 'rounds'], ['--priority-fee', 'priorityFee'], ['--cluster', 'cluster'], ['--program-id', 'programId']]);
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
  for (const [k, lo, hi, d] of [['vaultIndex', 0, 255, 0], ['variants', 1, 16, 4], ['rounds', 1, 50, 5], ['priorityFee', 0, MAX_PRIORITY_FEE, DEFAULT_PRIORITY_FEE]]) {
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
  const connections = o.rpc.map((u) => new web3.Connection(u, 'confirmed'));
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
  // review R8-OPS-2: every decision on both RPCs' views; the stop is seen only when both show it
  const read = async () => {
    const views = await Promise.all(connections.map(readOne));
    return { views, agree: views.every((v) => v.raw.every((a, i) => sameAccount(a, views[0].raw[i]))), done: views.every((v) => v.launchpad && stopDone(v, stop)) };
  };
  const confirmedOf = async (sigs) => {
    for (const c of connections) {
      try {
        const st = (await c.getSignatureStatuses(sigs)).value;
        const i = st.findIndex((x) => x && !x.err && (x.confirmationStatus === 'confirmed' || x.confirmationStatus === 'finalized'));
        if (i >= 0) return sigs[i];
      } catch { /* the other RPC may answer */ }
    }
    return null;
  };
  let s = await read();
  if (!s.agree) console.log('warning RPC_DISAGREE: the two RPCs return different accounts (the multisig, the Launchpad or LaunchBatch): one of them is lying or behind; the stop goes ahead, and counts only when both show it');
  const pres = s.views.map((v) => (v.launchpad ? stopPreconditions({ multisig: o.multisig, multisigAccount: v.multisigAccount, member, launchpad: v.launchpad, vaultIndex: o.vaultIndex }) : ['vicinity_curve\'s Launchpad was not found']));
  if (pres.every((p) => p.length)) { for (const p of pres[0]) console.log(`PROBLEM: ${p}`); return 1; }
  if (s.done) { console.log('both RPCs show the stop already (another member\'s, or an earlier one): nothing sent'); return 0; }
  const usable = () => s.views.filter((v) => { try { decodeSquadsMultisig(v.multisigAccount); return true; } catch { return false; } });
  const sigs = new Set();
  for (let round = 1; round <= o.rounds; round++) {
    // the next few indices as each RPC sees the multisig, so that one lying RPC's index cannot move every variant off the real one
    const indices = [...new Set(usable().flatMap((v) => { const n = decodeSquadsMultisig(v.multisigAccount).transactionIndex; return Array.from({ length: o.variants }, (_, k) => n + 1n + BigInt(k)); }).map(String))]
      .map(BigInt).sort((x, y) => (x < y ? -1 : 1));
    const microLamports = roundPriorityFee(o.priorityFee, round);
    // a blockhash from each RPC, so that one lying RPC's cannot spoil every variant
    const hashes = [...new Set((await Promise.all(connections.map((c) => c.getLatestBlockhash('confirmed').then((x) => x.blockhash, () => null)))).filter(Boolean))];
    if (!hashes.length) { console.log(`round ${round}: neither RPC gave a blockhash`); continue; }
    const txs = [];
    for (const blockhash of signer ? hashes : hashes.slice(0, 1)) {
      for (const index of indices) {
        const ixs = stopTransactionInstructions({ multisig: o.multisig, member, vaultIndex: o.vaultIndex, transactionIndex: index, stop, microLamports, programId, cluster });
        txs.push({ index, tx: new web3.Transaction({ feePayer: new PublicKey(member), recentBlockhash: blockhash }).add(...ixs.map((x) => new web3.TransactionInstruction({
          programId: new PublicKey(x.programAddress), data: Buffer.from(x.data),
          keys: x.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: isSigner(a.role), isWritable: isWritable(a.role) })),
        }))) });
      }
    }
    if (!signer) {
      txs.forEach(({ index, tx }) => console.log(`index ${index}: message hash ${messageHash(tx.serializeMessage())}\n${tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')}`));
      console.log(`unsigned, with a compute-unit limit of ${STOP_COMPUTE_UNITS} at ${microLamports} micro-lamports per unit: sign every variant with the member key and send them together within a minute through two RPCs of different providers (only the one at the multisig's next index executes)`);
      return 0;
    }
    let sent = 0;
    for (const { tx } of txs) {
      tx.sign(signer);
      const raw = tx.serialize();
      sigs.add(base58(tx.signature));
      for (const c of connections) {
        try { await c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 }); sent++; } catch (e) { console.log(`round ${round}: a variant was not sent through ${c.rpcEndpoint}: ${e.message}`); }
      }
    }
    console.log(`round ${round}: sent ${txs.length} variant(s) for indices ${indices.join(', ')} at ${microLamports} micro-lamports per compute unit (${sent} sends through ${connections.length} RPCs)`);
    for (let t = 0; t < 30; t++) {
      await new Promise((ok) => { setTimeout(ok, 1_000); });
      s = await read();
      const mine = s.done ? await confirmedOf([...sigs]) : null;
      if (s.done && mine) { console.log(`the stop is on chain: both RPCs show it, and this member's transaction ${mine} is confirmed`); return 0; }
    }
    if (s.done) break;
  }
  s = await read();
  const mine = s.done ? await confirmedOf([...sigs]) : null;
  if (s.done && mine) { console.log(`the stop is on chain: both RPCs show it, and this member's transaction ${mine} is confirmed`); return 0; }
  if (s.done) {
    console.log('PROBLEM: both RPCs show the stop, but none of this member\'s transactions is confirmed on them: it is another member\'s stop, or the RPCs are not to be trusted; check LaunchBatch through a third provider and tell the other members (8.4 step 5)');
    return 1;
  }
  console.log('PROBLEM: the stop is not on chain after every round (as both RPCs show it): another member, the owner (clear with the approver key) or the admin must act (8.4 step 5)');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
