/**
 * Squads v4 (SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf), read only: the admin "City coins" tab hands both programs' upgrade
 * authority to the owner's Squads vault (setup step 2). The owner pastes the MULTISIG account (never the vault): this file decodes
 * it, checks it can really protect the programs, and derives the vault the page then names as the new upgrade authority. A pasted
 * vault, wallet or any other account is refused, so the multisig / vault mix-up cannot happen.
 *
 *   decodeMultisig(account)            the Multisig account (Anchor discriminator, borsh): threshold, members, time lock, ... | null
 *   vaultAddress(multisig, index = 0)  the vault PDA ["multisig", multisig, "vault", index (u8)] under the Squads v4 program
 *   checkMultisig(address, account)    { ok, multisig, vault, ... } or { ok: false, error, message } in plain words
 *
 * The layout and the seeds are checked against @sqds/multisig 2.1.4 (vectors made in a scratch directory, never a repo
 * dependency) and against a real mainnet multisig read read-only: test/fixtures/squads/vectors.json, test/squads.test.js.
 */
import { base58Decode, base58Encode, isSolanaAddress } from "../solana.js";
import { readU16, readU32, readU64 } from "./bytes.js";
import { accountBytes } from "./dbc.js";
import { findProgramAddress, PROGRAM_IDS } from "./pda.js";

export const SQUADS_V4_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
/** sha256("account:Multisig")[..8] */
export const MULTISIG_DISCRIMINATOR = Object.freeze([224, 116, 121, 186, 68, 161, 79, 236]);
/** A member's permission bits (Squads v4 Permission). */
export const PERMISSION = Object.freeze({ initiate: 1, vote: 2, execute: 4 });
const DEFAULT_KEY = "11111111111111111111111111111111";
const MAX_MEMBERS = 65_535;
const enc = new TextEncoder();

/** The Multisig account, or null when the bytes are not one (wrong discriminator, cut short, nonsense lengths). */
export function decodeMultisig(account) {
  const a = accountBytes(account);
  if (!a) return null;
  const b = a.bytes;
  if (b.length < 8 + 32 + 32 + 2 + 4 + 8 + 8 + 1 + 1 + 4 || !MULTISIG_DISCRIMINATOR.every((x, i) => b[i] === x)) return null;
  const key = (at) => base58Encode(b.subarray(at, at + 32));
  let at = 8;
  const createKey = key(at); at += 32;
  const configAuthority = key(at); at += 32;
  const threshold = readU16(b, at); at += 2;
  const timeLock = readU32(b, at); at += 4;
  const transactionIndex = readU64(b, at); at += 8;
  const staleTransactionIndex = readU64(b, at); at += 8;
  const tag = b[at]; at += 1;
  if (tag > 1) return null;
  let rentCollector = null;
  if (tag === 1) { if (at + 32 > b.length) return null; rentCollector = key(at); at += 32; }
  if (at + 1 + 4 > b.length) return null;
  const bump = b[at]; at += 1;
  const n = readU32(b, at); at += 4;
  if (n > MAX_MEMBERS || at + 33 * n > b.length) return null;
  const members = [];
  for (let i = 0; i < n; i++, at += 33) {
    const mask = b[at + 32];
    members.push({ key: key(at), mask, initiate: (mask & PERMISSION.initiate) !== 0, vote: (mask & PERMISSION.vote) !== 0, execute: (mask & PERMISSION.execute) !== 0 });
  }
  return { createKey, configAuthority, threshold, timeLock, transactionIndex, staleTransactionIndex, rentCollector, bump, members };
}

/** The vault of a multisig: the address that signs for it (what Squads' app shows as the vault). */
export async function vaultAddress(multisig, index = 0) {
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error("bad_vault_index");
  return (await findProgramAddress([enc.encode("multisig"), base58Decode(multisig), enc.encode("vault"), Uint8Array.of(index)], SQUADS_V4_PROGRAM))[0];
}

const fail = (error, message, extra = {}) => ({ ok: false, error, message, ...extra });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Is `address` (what the owner pasted) a Squads v4 multisig that can safely hold the programs' upgrade authority?
 * `account` is its RPC answer ({ owner, data: [base64, "base64"], executable } or null). Refused, in plain words: nothing there,
 * a wallet or a vault (owned by the System program), another program's account, a Squads account that is not the multisig itself,
 * a threshold below 2, a "controlled" multisig (a config authority can change its members without a vote), or fewer members who
 * can vote, or execute, than the threshold. On success: { ok, multisig, vault, threshold, members, timeLock, says } where `says`
 * is the line the page shows ("2 of 3: …; vault …").
 */
export async function checkMultisig(address, account) {
  const a = String(address || "").trim();
  if (!isSolanaAddress(a)) return fail("bad_address", "That is not a Solana address. Copy the multisig account address again from the Squads app.");
  if (!account) return fail("not_found", "Nothing exists at this address on this network. In the Squads app, open Settings and copy the “Multisig account” address again.");
  if (account.owner !== SQUADS_V4_PROGRAM) {
    if (account.owner === PROGRAM_IDS.system) return fail("not_multisig", "This is a wallet or a Squads vault, not the multisig account. In the Squads app, open Settings and copy the “Multisig account” address (not the vault address).");
    return fail("not_multisig", "This account belongs to another program, not to Squads v4. In the Squads app, open Settings and copy the “Multisig account” address.");
  }
  const m = decodeMultisig(account);
  if (!m) return fail("not_multisig", "This is a Squads account, but not the multisig itself (perhaps a proposal or a transaction). In the Squads app, open Settings and copy the “Multisig account” address.");
  const voters = m.members.filter((x) => x.vote).length, executors = m.members.filter((x) => x.execute).length;
  if (m.threshold < 2) return fail("threshold_too_low", `This multisig needs only ${m.threshold} approval, so one key alone could change the programs. Set its threshold to at least 2 in the Squads app, then check again.`, { threshold: m.threshold });
  if (m.configAuthority !== DEFAULT_KEY) return fail("controlled", `This multisig has a config authority (${m.configAuthority}), which can change its members without a vote. Create the multisig without one (the normal choice in app.squads.so), then check again.`);
  if (voters < m.threshold) return fail("too_few_voters", `Only ${plural(voters, "member")} can vote but ${m.threshold} approvals are needed, so nothing could ever be approved. Fix the members' permissions in the Squads app.`);
  if (executors < 1) return fail("no_executor", "No member can execute an approved transaction. Fix the members' permissions in the Squads app.");
  const vault = await vaultAddress(a, 0);
  const says = `${m.threshold} of ${m.members.length}: ${m.members.map((x) => x.key).join(", ")}; vault ${vault}`;
  return {
    ok: true, multisig: a, vault, threshold: m.threshold, timeLock: m.timeLock, members: m.members,
    voters, says,
    warnings: m.timeLock > 0 ? [`Each approved change waits ${m.timeLock} seconds before it can run (the multisig's time lock).`] : [],
  };
}
