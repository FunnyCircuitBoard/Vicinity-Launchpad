// decodeTransactionEvents (VICINITY-CURVE-DESIGN.md 4.21, 14.1, T56; NOTES 45, CLI-2)
// over the shapes an RPC's getTransaction returns: a failed transaction yields
// nothing; an event CPI counts only at stack height 2 or more, called by
// vicinity_curve itself, with the event authority as its only account; money
// events never come from logs. tests-curve checks the same decoder against
// every transaction of the litesvm suites (successful and failed).
import test from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import * as S from './index.mjs';

const key = () => web3.Keypair.generate().publicKey.toBase58();
const P = S.curvePdas({});
const EA = P.eventAuthority();
const PROGRAM = S.CURVE_PROGRAM_ID;
const ROUTER = key();
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
// PlatformFeesWithdrawn { city_id u64, amount u64, total_withdrawn u128 } as an event CPI
const withdrawn = (city, amount) => Buffer.concat([Buffer.from(S.EVENT_IX_TAG), Buffer.from(S.EVENT_DISCRIMINATORS.PlatformFeesWithdrawn), u64(city), u64(amount), u64(amount), u64(0)]);
// ConfigEnabled { config_id u16, enabled bool } as an emit! log line
const configEnabledLog = () => `Program data: ${Buffer.concat([Buffer.from(S.EVENT_DISCRIMINATORS.ConfigEnabled), Buffer.from([3, 0, 1])]).toString('base64')}`;
const moneyLog = () => `Program data: ${withdrawn(9, 1).subarray(8).toString('base64')}`;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = `1${s}`; }
  return s;
}

/** A v0 transaction: [vicinity_curve withdraw] (index 0) and [router] (index 1), keys = static + loaded. */
function tx({ err = null, inner, logs = [], encode = (d) => b58(d) } = {}) {
  const staticKeys = [key(), PROGRAM, ROUTER, EA];
  const loaded = { writable: [key()], readonly: [] };
  const keys = [...staticKeys, ...loaded.writable];
  const idx = (k) => keys.indexOf(k);
  return {
    meta: {
      err, logMessages: logs, loadedAddresses: loaded,
      innerInstructions: inner.map(({ index, instructions }) => ({
        index, instructions: instructions.map(({ program, accounts, data, stackHeight }) => ({ programIdIndex: idx(program), accounts: accounts.map(idx), data: encode(data), stackHeight })),
      })),
    },
    transaction: { message: { accountKeys: staticKeys, instructions: [{ programIdIndex: 1, accounts: [0], data: b58(Buffer.from(S.INSTRUCTION_DISCRIMINATORS.withdraw_platform_fees)) }, { programIdIndex: 2, accounts: [], data: '' }] } },
  };
}
const eventCpi = (data = withdrawn(7, 1_000), stackHeight = 2) => ({ program: PROGRAM, accounts: [EA], data, stackHeight });

test('a successful transaction: the event CPI of a top-level vicinity_curve instruction, and emit! logs', () => {
  const t = tx({ inner: [{ index: 0, instructions: [eventCpi()] }], logs: [`Program ${PROGRAM} invoke [1]`, configEnabledLog(), `Program ${PROGRAM} success`] });
  const out = S.decodeTransactionEvents(t);
  assert.deepEqual(out.map((e) => [e.name, e.source]), [['PlatformFeesWithdrawn', 'cpi'], ['ConfigEnabled', 'log']]);
  assert.deepEqual([out[0].data.city_id, out[0].data.amount, out[0].index, out[0].stackHeight], [7n, 1_000n, 0, 2]);
  assert.deepEqual(out[1].data, { config_id: 3n, enabled: true });
});

test('CLI-2: a failed transaction yields nothing, although its metadata carries a genuine event CPI and log', () => {
  const inner = [{ index: 0, instructions: [eventCpi()] }];
  const logs = [`Program ${PROGRAM} invoke [1]`, configEnabledLog(), `Program ${PROGRAM} success`];
  for (const err of [{ InstructionError: [1, { Custom: 1 }] }, 'InsufficientFundsForRent', 0]) {
    const t = tx({ err, inner, logs });
    assert.deepEqual(S.decodeTransactionEvents(t), [], JSON.stringify(err));
    // the single-instruction decoder alone cannot tell: it accepts the CPI (which is why indexers use the transaction-level one)
    const ii = t.meta.innerInstructions[0].instructions[0];
    const keys = [...t.transaction.message.accountKeys, ...t.meta.loadedAddresses.writable];
    assert.equal(S.decodeEventCpi({ programId: keys[ii.programIdIndex], accounts: ii.accounts.map((k) => keys[k]), data: Buffer.from(withdrawn(7, 1_000)) })?.name, 'PlatformFeesWithdrawn');
  }
  // a success with err explicitly null or absent decodes
  assert.equal(S.decodeTransactionEvents(tx({ err: null, inner, logs })).length, 2);
  const noErr = tx({ inner, logs }); delete noErr.meta.err;
  assert.equal(S.decodeTransactionEvents(noErr).length, 2);
});

test('the enclosing call must be vicinity_curve: a router calling the program is fine (depth 3), anything else is not an event', () => {
  // the router (index 1) CPIs vicinity_curve (height 2), which emits (height 3): accepted
  const routed = tx({ inner: [{ index: 1, instructions: [{ program: PROGRAM, accounts: [], data: Buffer.from(S.INSTRUCTION_DISCRIMINATORS.buy), stackHeight: 2 }, eventCpi(withdrawn(8, 5), 3)] }] });
  assert.deepEqual(S.decodeTransactionEvents(routed).map((e) => [e.name, e.stackHeight, e.index]), [['PlatformFeesWithdrawn', 3, 1]]);
  // the same instruction directly under the router (height 2, parent = the router): refused
  assert.deepEqual(S.decodeTransactionEvents(tx({ inner: [{ index: 1, instructions: [eventCpi(withdrawn(8, 5), 2)] }] })), []);
  // under a program the router called, not under vicinity_curve: refused
  const other = key();
  const t = tx({ inner: [{ index: 1, instructions: [{ program: PROGRAM, accounts: [], data: Buffer.from([1]), stackHeight: 2 }, { program: ROUTER, accounts: [], data: Buffer.from([2]), stackHeight: 3 }, eventCpi(withdrawn(8, 5), 4)] }] });
  assert.deepEqual(S.decodeTransactionEvents(t), []);
  void other;
  // a sibling after a deeper call still has vicinity_curve as its caller
  const sib = tx({ inner: [{ index: 0, instructions: [{ program: S.ADDRESSES.system, accounts: [], data: Buffer.from([2, 0, 0, 0]), stackHeight: 2 }, { program: S.ADDRESSES.token, accounts: [], data: Buffer.from([3]), stackHeight: 3 }, eventCpi(withdrawn(9, 9), 2)] }] });
  assert.equal(S.decodeTransactionEvents(sib).length, 1);
});

test('an event CPI must name only the event authority and carry the event tag; money events never come from logs', () => {
  const bad = [
    { ...eventCpi(), accounts: [EA, EA] },
    { ...eventCpi(), accounts: [key()] },
    { ...eventCpi(), data: withdrawn(7, 1).subarray(8) }, // no EVENT_IX_TAG
    { ...eventCpi(), program: key() },
  ];
  for (const b of bad) assert.deepEqual(S.decodeTransactionEvents(tx({ inner: [{ index: 0, instructions: [b] }] })), [], JSON.stringify(b.accounts));
  // a money event in a log line (only an event CPI can carry one) is ignored
  const t = tx({ inner: [], logs: [`Program ${PROGRAM} invoke [1]`, moneyLog(), configEnabledLog(), `Program ${PROGRAM} success`] });
  assert.deepEqual(S.decodeTransactionEvents(t).map((e) => e.name), ['ConfigEnabled']);
  // a log line of another program is not ours
  const t2 = tx({ inner: [], logs: [`Program ${ROUTER} invoke [1]`, configEnabledLog(), `Program ${ROUTER} success`] });
  assert.deepEqual(S.decodeTransactionEvents(t2), []);
});

test('shapes: web3.js objects, raw bytes and base64 data, jsonParsed keys; the metadata must prove the call stack', () => {
  // data as bytes, keys as PublicKey objects, a v0 message with compiledInstructions
  const t = tx({ inner: [{ index: 0, instructions: [eventCpi()] }], encode: (d) => Uint8Array.from(d) });
  const keys = t.transaction.message.accountKeys;
  t.transaction.message = { staticAccountKeys: keys.map((k) => new web3.PublicKey(k)), compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: new Uint8Array(8) }, { programIdIndex: 2, accountKeyIndexes: [], data: new Uint8Array(0) }] };
  assert.equal(S.decodeTransactionEvents(t).length, 1);
  // base64 data tuples, jsonParsed account keys ({ pubkey })
  const t3 = tx({ inner: [{ index: 0, instructions: [eventCpi()] }], encode: (d) => [Buffer.from(d).toString('base64'), 'base64'] });
  t3.transaction.message.accountKeys = t3.transaction.message.accountKeys.map((pubkey) => ({ pubkey, signer: false, writable: false }));
  assert.equal(S.decodeTransactionEvents(t3).length, 1);
  // jsonParsed inner instructions name their program and accounts directly
  const t4 = tx({ inner: [] });
  t4.meta.innerInstructions = [{ index: 0, instructions: [{ programId: PROGRAM, accounts: [EA], data: b58(withdrawn(1, 2)), stackHeight: 2 }, { programId: S.ADDRESSES.system, parsed: { type: 'transfer' }, stackHeight: 2 }] }];
  assert.deepEqual(S.decodeTransactionEvents(t4).map((e) => e.data.amount), [2n]);
  // no stack heights (an old RPC): the caller cannot be proven, so it throws rather than guess
  const t5 = tx({ inner: [{ index: 0, instructions: [{ ...eventCpi(), stackHeight: undefined }] }] });
  t5.meta.innerInstructions[0].instructions[0].stackHeight = null;
  assert.throws(() => S.decodeTransactionEvents(t5), /stackHeight/);
  assert.throws(() => S.decodeTransactionEvents({ transaction: t.transaction }), /meta/);
});
