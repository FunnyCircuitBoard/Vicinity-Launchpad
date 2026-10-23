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
// Usage (from solana/):
//   node scripts/vcurve/guardian-stop.mjs --rpc <url> --multisig <guardian multisig> --keypair <member keypair file>
//     [--clear] [--pause-launches] [--halt-buys] [--vault-index <n>] [--variants <n>] [--rounds <n>]
//     [--cluster mainnet|devnet] [--program-id <id>]
//   With --member <key> instead of --keypair it only prints the unsigned transactions (base64) and their message hashes.
// The keypair is read from the file to sign and is never printed. Exit status 0 when the chain shows the stop, 1 when
// it does not, 2 on a usage error.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import web3 from '@solana/web3.js';
import { ADDRESSES, CURVE_PROGRAM_ID, curveInstructions, curvePdas, decodeLaunchpad, decodeLaunchBatch, findPda } from '../../sdk/curve/index.mjs';
import { SQUADS, SQUADS_ALL_PERMISSIONS, decodeSquadsMultisig, squadsVaultIndexOf, squadsVaultPda } from './preflight.mjs';

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

const USAGE = 'usage: node scripts/vcurve/guardian-stop.mjs --rpc <url> --multisig <guardian multisig> (--keypair <member keypair file> | --member <key>) '
  + '[--clear] [--pause-launches] [--halt-buys] [--vault-index <n>] [--variants <n>] [--rounds <n>] [--cluster mainnet|devnet] [--program-id <id>]';
const VALUE = new Map([['--rpc', 'rpc'], ['--multisig', 'multisig'], ['--keypair', 'keypair'], ['--member', 'member'], ['--vault-index', 'vaultIndex'], ['--variants', 'variants'],
  ['--rounds', 'rounds'], ['--cluster', 'cluster'], ['--program-id', 'programId']]);
const BOOL = new Map([['--clear', 'clear'], ['--pause-launches', 'pauseLaunches'], ['--halt-buys', 'haltBuys']]);
/** The CLI's options, or `{ error }`. */
export function parseArgs(argv) {
  const o = { clear: false, pauseLaunches: false, haltBuys: false };
  for (let i = 0; i < argv.length; i++) {
    if (BOOL.has(argv[i])) { o[BOOL.get(argv[i])] = true; continue; }
    if (!VALUE.has(argv[i])) return { error: `unknown option ${argv[i]}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) return { error: `${argv[i - 1]} needs a value` };
    o[VALUE.get(argv[i - 1])] = v;
  }
  if (!o.rpc || !o.multisig) return { error: '--rpc and --multisig are required' };
  if (Boolean(o.keypair) === Boolean(o.member)) return { error: 'give --keypair (sign and send) or --member (print only), not both' };
  if (!o.clear && !o.pauseLaunches && !o.haltBuys) return { error: 'name the stop: --clear, --pause-launches and/or --halt-buys' };
  for (const [k, lo, hi, d] of [['vaultIndex', 0, 255, 0], ['variants', 1, 16, 4], ['rounds', 1, 50, 5]]) {
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
  const connection = new web3.Connection(o.rpc, 'confirmed');
  const signer = o.keypair ? web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(o.keypair, 'utf8')))) : null;
  const member = signer ? signer.publicKey.toBase58() : o.member;
  const P = curvePdas({ programId, cluster });
  const stop = { clear: o.clear, pauseLaunches: o.pauseLaunches, haltBuys: o.haltBuys };
  const read = async () => {
    const [msAcc, lpAcc, lbAcc] = await connection.getMultipleAccountsInfo([o.multisig, P.launchpad(), P.launchBatch()].map((k) => new PublicKey(k)));
    const shape = (a) => (a ? { owner: a.owner.toBase58(), lamports: BigInt(a.lamports), data: Buffer.from(a.data) } : null);
    return { multisigAccount: shape(msAcc), launchpad: decodeLaunchpad(shape(lpAcc), { programId }), launchBatch: lbAcc ? decodeLaunchBatch(shape(lbAcc), { programId }) : null };
  };
  let s = await read();
  const pre = stopPreconditions({ multisig: o.multisig, multisigAccount: s.multisigAccount, member, launchpad: s.launchpad, vaultIndex: o.vaultIndex });
  for (const p of pre) console.log(`PROBLEM: ${p}`);
  if (pre.length) return 1;
  for (let round = 1; round <= o.rounds; round++) {
    if (stopDone(s, stop)) { console.log('the chain shows the stop'); return 0; }
    const next = decodeSquadsMultisig(s.multisigAccount).transactionIndex + 1n;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const txs = [];
    for (let v = 0; v < o.variants; v++) {
      const ixs = guardianStopInstructions({ multisig: o.multisig, member, vaultIndex: o.vaultIndex, transactionIndex: next + BigInt(v), stop, programId, cluster });
      const tx = new web3.Transaction({ feePayer: new PublicKey(member), recentBlockhash: blockhash }).add(...ixs.map((x) => new web3.TransactionInstruction({
        programId: new PublicKey(x.programAddress), data: Buffer.from(x.data),
        keys: x.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: isSigner(a.role), isWritable: isWritable(a.role) })),
      })));
      txs.push(tx);
    }
    if (!signer) {
      txs.forEach((tx, v) => console.log(`index ${next + BigInt(v)}: message hash ${messageHash(tx.serializeMessage())}\n${tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')}`));
      console.log('unsigned: sign every variant with the member key and send them together within a minute (only the one at the multisig\'s next index executes)');
      return 0;
    }
    const sigs = [];
    for (const tx of txs) {
      tx.sign(signer);
      try { sigs.push(await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 })); } catch (e) { console.log(`round ${round}: a variant was not sent: ${e.message}`); }
    }
    console.log(`round ${round}: sent ${sigs.length} variant(s) for indices ${next} to ${next + BigInt(o.variants - 1)}: ${sigs.join(', ')}`);
    for (let t = 0; t < 30; t++) {
      await new Promise((ok) => { setTimeout(ok, 1_000); });
      s = await read();
      if (stopDone(s, stop)) break;
    }
  }
  s = await read();
  if (stopDone(s, stop)) { console.log('the chain shows the stop'); return 0; }
  console.log('PROBLEM: the stop is not on chain after every round: another member, the owner (clear with the approver key) or the admin must act (8.4 step 5)');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
