// IDLs and a small, framework-neutral instruction builder.
//
// Instructions are returned in @solana/kit's shape
//   { programAddress, accounts: [{ address, role }], data: Uint8Array }
// (role: 0 read-only, 1 writable, 2 read-only signer, 3 writable signer), which
// converts one-to-one to a web3.js TransactionInstruction. Data is encoded from
// the IDL with @coral-xyz/anchor's BorshCoder; nothing here touches the network.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import anchor from '@coral-xyz/anchor';

const { BorshCoder } = anchor;
const here = dirname(fileURLToPath(import.meta.url));
const solanaDir = join(here, '..', '..');

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * Our IDL: VICINITY_LAUNCHPAD_IDL overrides; otherwise the IDL of the last
 * `anchor build` (target/idl), falling back to the committed copy (sdk/idl).
 */
export function launchpadIdlPath() {
  if (process.env.VICINITY_LAUNCHPAD_IDL) return process.env.VICINITY_LAUNCHPAD_IDL;
  const built = join(solanaDir, 'target', 'idl', 'vicinity_launchpad.json');
  return existsSync(built) ? built : join(solanaDir, 'sdk', 'idl', 'vicinity_launchpad.json');
}

export const IDL = {
  launchpad: loadJson(launchpadIdlPath()),
  dbc: loadJson(join(solanaDir, 'idls', 'dynamic_bonding_curve.json')),
  damm: loadJson(join(solanaDir, 'idls', 'cp_amm.json')),
  rewards: loadJson(join(solanaDir, 'sdk', 'idl', 'vicinity_rewards.json')),
};

const coders = new Map();
export function coderFor(idl) {
  let c = coders.get(idl);
  if (!c) {
    c = new BorshCoder(idl);
    coders.set(idl, c);
  }
  return c;
}

export const Role = Object.freeze({ R: 0, W: 1, RS: 2, WS: 3 });

const snake = (s) => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/**
 * Build one instruction of `idl` named `name` (snake_case, as in the IDL).
 * `accounts` maps account names (snake_case or camelCase) to base58 addresses.
 * Accounts with a fixed address in the IDL may be omitted. Optional accounts
 * that are omitted are passed as the program id (Anchor's "None").
 * `overrides` lets tests force a role, e.g. { payer: Role.W } (attack tests).
 */
export function buildIx(idl, name, args = {}, accounts = {}, overrides = {}) {
  const def = idl.instructions.find((i) => i.name === name);
  if (!def) throw new Error(`no instruction ${name} in ${idl.metadata?.name}`);
  // BorshCoder silently encodes a missing argument as zero (for example a
  // camelCase key for a snake_case argument), so insist on every argument.
  for (const a of def.args) {
    if (!(a.name in args)) throw new Error(`${name}: missing argument ${a.name}`);
  }
  const programAddress = idl.address;
  const metas = def.accounts.map((a) => {
    let addr = accounts[a.name] ?? accounts[camel(a.name)];
    if (addr === undefined && a.address) addr = a.address;
    if (addr === undefined && a.optional) addr = programAddress;
    if (addr === undefined) throw new Error(`${name}: missing account ${a.name}`);
    let role = (a.writable ? 1 : 0) | (a.signer ? 2 : 0);
    if (a.optional && addr === programAddress) role = 0;
    const o = overrides[a.name] ?? overrides[camel(a.name)];
    if (o !== undefined) role = o;
    return { address: String(addr), role };
  });
  const data = coderFor(idl).instruction.encode(name, args);
  return { programAddress, accounts: metas, data: new Uint8Array(data) };
}

/** Decode an account of `idl` (type name as in the IDL, e.g. "Coin"). */
export function decodeAccount(idl, typeName, data) {
  return coderFor(idl).accounts.decode(typeName, Buffer.from(data));
}

export function constant(idl, name) {
  const c = idl.constants?.find((k) => k.name === name);
  if (!c) throw new Error(`no constant ${name}`);
  return c.value;
}

export { snake, camel };
