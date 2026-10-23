#!/usr/bin/env node
// The deploy checklist of VICINITY-CURVE-DESIGN.md 8.4 and 8.5, read from the
// chain (reviews OPS-1 and OPS-4: 8.4 said "the deploy checklist checks each
// on chain", but no checklist existed). Read-only: it fetches accounts and
// prints what is not ready; it never signs anything.
//
// Checked (each a problem unless noted):
//   * vicinity_curve: the Launchpad exists, its admin is the vault with no
//     admin transfer pending, the program's upgrade authority is the vault, a
//     guardian is set, is not the admin, the vault or the proposed admin (its
//     halt must not wait for the admin's time lock; review R5-CONS-1), and is
//     neither the payout key nor the payout wallet, config #0 exists (a
//     warning when its fields differ from the default config #0);
//   * vicinity_rewards: the registry's admin is the vault with no transfer
//     pending (OPS-1; approve_launch and launch also refuse otherwise), the
//     program's upgrade authority is the vault;
//   * the old vicinity_launchpad: its admin is the vault with no transfer
//     pending (GOV-1), its upgrade authority is the vault or none (an
//     immutable old program meets 8.5's purpose; a warning says so, review
//     R5-DIFF-3), its launches are paused, every LaunchConfig is disabled (8.5);
//   * the old program's Approval accounts (OPS-4): before `solana program
//     close` of the old program (`--before-legacy-close`) every one is a
//     problem, since a closed program can no longer revoke it and its city
//     would be refused here forever (LegacyApprovalExists); otherwise each is
//     a warning (its city is refused here until it is revoked or used);
//   * no Coin's founder and no pending Approval's founder is FEE_RECIPIENT,
//     the guardian, the payout key or the launch approver (8.4's operating
//     rule, R2-DIFF-1, SPEC-1, 4.24); the launch approver holds no other seat;
//   * a proposed key (reviews R5-DIFF-2, R5-CONS-2): before a set_guardian or
//     set_payout_config proposal is signed, `--proposed-guardian`,
//     `--proposed-payout-authority` (alias `--proposed-payout-key`) and
//     `--proposed-payout-destination` check the key against every Coin's and
//     pending Approval's founder (the program cannot list the coins when those
//     settings change) and against the keys the program keeps it apart from;
//     before a set_launch_approver proposal, `--proposed-launch-approver` does
//     the same for the launch approver (8.4, 8.6; NOTES 76): never a founder,
//     FEE_RECIPIENT, the admin, the vault, the proposed admin, the guardian or
//     a payout key, and a proposed guardian or payout key is never the approver.
//   * the guardian's Squads multisig (`--guardian-multisig`, required once a
//     guardian is set; review R6-RT-2): the guardian (or the proposed
//     guardian) is one of its vaults, it has no time lock (its stops must be
//     fast), and it is a controlled multisig whose config authority is the
//     admin vault, so no member, nor any threshold of members, can change its
//     members or threshold: in an autonomous 1-of-3 guardian one stolen member
//     key removes the other members by a config transaction, and their clears
//     and pauses then fail; its threshold is 1 and at least two members hold
//     Initiate, Vote and Execute, so every stop survives the loss or theft of
//     any one member key (review R7-2); the launch approver (and a proposed
//     one) is none of its member keys and none of its vaults (any index;
//     review R7-CONF-3);
//   * the vault's Squads multisig (`--vault-multisig`, optional): the vault is
//     one of its vaults; the launch approver (and a proposed one) is none of
//     its member keys and none of its vaults; a warning while it has no time
//     lock (O11);
//   * an approver that is not a wallet key (off the ed25519 curve) can only be
//     a multisig vault (O32 (a)), which the batch verifier cannot check a
//     publication of (it refuses such an approver), so it is not ready (review
//     R8-DIFF-6); `--approver-multisig` is required, the approver must be one
//     of its vaults, it has no time lock and it shares no member key with the
//     guardian's or the vault's multisig (review R7-CONF-3); no member of it is
//     the guardian, the admin vault, any vault of the guardian's or the vault's
//     multisig or any other program address, its config authority is none or
//     the admin vault, and a threshold of 1 is a warning (review R8-DIFF-3).
// Not checkable here: the published program metadata, that the approver key
// shares no seed or device with a member key (8.4, O32), and, without
// `--vault-multisig`, the vault's time lock and members; the operator confirms
// them by hand.
//
// Usage (from solana/):
//   node scripts/vcurve/preflight.mjs --rpc <url> --vault <squads vault>
//     --guardian-multisig <squads multisig> [--vault-multisig <squads multisig>]
//     [--approver-multisig <squads multisig>]
//     [--cluster mainnet|devnet] [--program-id <vicinity_curve id>]
//     [--before-legacy-close] [--proposed-guardian <key>]
//     [--proposed-payout-authority <key>] [--proposed-payout-destination <key>]
//     [--proposed-launch-approver <key>]
// Exit status 1 when any problem is found, 2 on a usage error (an unknown
// option included).
import web3 from '@solana/web3.js';
import {
  ADDRESSES, CLUSTERS, CURVE_PROGRAM_ID, DEFAULT_CONFIG, LEGACY_LAUNCHPAD_DISCRIMINATOR, LEGACY_LAUNCHPAD_LEN, LEGACY_LAUNCHES_PAUSED_AT,
  LEGACY_ADMIN_AT, LEGACY_PENDING_ADMIN_AT, curvePdas, findPda, decodeLaunchpad, decodeLaunchConfig, decodeCurveCoin,
  decodeApproval, accountType, configParamsOf,
} from '../../sdk/curve/index.mjs';

const { PublicKey } = web3;
const ZERO = ADDRESSES.system;
const keyAt = (data, at) => new PublicKey(Buffer.from(data).subarray(at, at + 32)).toBase58();
const sameBytes = (data, want) => want.every((x, i) => data[i] === x);

/** `sha256("account:<Name>")[..8]` of the old vicinity_launchpad (its committed IDL), and the byte of `LaunchConfig.enabled`. */
export const LEGACY_ACCOUNTS = Object.freeze({
  Approval: [233, 9, 153, 49, 11, 222, 59, 130],
  Coin: [215, 195, 53, 238, 217, 196, 213, 51],
  LaunchConfig: [18, 161, 9, 224, 102, 145, 29, 94],
  launchConfigEnabledAt: 96, // 8 + dbc_config, quote_mint, three u64
});
/** vicinity_rewards' `Registry`: discriminator, size, `admin` and `pending_admin` offsets (OPS-1). */
export const REWARDS_REGISTRY = Object.freeze({ discriminator: [47, 174, 110, 246, 184, 182, 252, 218], len: 73, adminAt: 8, pendingAdminAt: 40 });

/** Squads v4 (`SQDS4ep65...`): the program, the `Multisig` account discriminator (`sha256("account:Multisig")[..8]`), the PDA seeds. */
export const SQUADS = Object.freeze({
  programId: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
  multisigDiscriminator: [224, 116, 121, 186, 68, 161, 79, 236],
  permissions: Object.freeze({ initiate: 1, vote: 2, execute: 4 }),
});
const enc = new TextEncoder();
/** The Squads vault `index` of `multisig`: PDA of `["multisig", multisig, "vault", index]` under the Squads program. */
export const squadsVaultPda = (multisig, index = 0) => findPda([enc.encode('multisig'), new PublicKey(String(multisig)).toBuffer(), enc.encode('vault'), Uint8Array.of(index)], SQUADS.programId)[0];
/**
 * A Squads v4 `Multisig` account (`{ owner, data }`): `{ createKey, configAuthority, threshold, timeLock, transactionIndex,
 * staleTransactionIndex, rentCollector, bump, members: [{ key, permissions }] }` (Borsh, in the program's field order:
 * discriminator, create_key, config_authority, threshold u16, time_lock u32, transaction_index u64,
 * stale_transaction_index u64, rent_collector Option<Pubkey>, bump u8, members Vec<{ key, permissions u8 }>). Throws
 * unless it is one.
 */
export function decodeSquadsMultisig(account) {
  if (!account) throw new Error('no account');
  if (String(account.owner) !== SQUADS.programId) throw new Error(`owned by ${account.owner}, not the Squads program`);
  const d = Buffer.from(account.data);
  if (d.length < 8 || !sameBytes(d, SQUADS.multisigDiscriminator)) throw new Error('not a Squads Multisig account');
  let at = 8;
  const need = (n) => { if (at + n > d.length) throw new Error('Multisig data too short'); };
  const key = () => { need(32); const k = keyAt(d, at); at += 32; return k; };
  const createKey = key(); const configAuthority = key();
  need(2 + 4 + 8 + 8); const threshold = d.readUInt16LE(at); const timeLock = d.readUInt32LE(at + 2);
  const transactionIndex = d.readBigUInt64LE(at + 6); const staleTransactionIndex = d.readBigUInt64LE(at + 14); at += 22;
  need(1); const hasCollector = d[at]; at += 1;
  if (hasCollector > 1) throw new Error('bad rent_collector option');
  const rentCollector = hasCollector ? key() : null;
  need(1); const bump = d[at]; at += 1;
  need(4); const n = d.readUInt32LE(at); at += 4;
  const members = [];
  for (let i = 0; i < n; i++) { const k = key(); need(1); members.push({ key: k, permissions: d[at] }); at += 1; }
  return { createKey, configAuthority, threshold, timeLock, transactionIndex, staleTransactionIndex, rentCollector, bump, members };
}
/**
 * The bytes of a Squads v4 `Multisig` account (the layout `decodeSquadsMultisig` reads; for tests and dry runs), as the
 * Squads program allocates it: `Multisig::size` always reserves 33 bytes for `rent_collector`, so an account without one
 * ends with 32 zero bytes after its members (checked against accounts the real program created,
 * `tests-curve/fixtures/squads-v4-multisigs.json`).
 */
export function encodeSquadsMultisig({ createKey, configAuthority = ZERO, threshold = 1, timeLock = 0, transactionIndex = 0n, staleTransactionIndex = 0n, rentCollector = null, bump = 255, members }) {
  const k = (a) => new PublicKey(String(a)).toBuffer();
  const head = Buffer.alloc(2 + 4 + 8 + 8);
  head.writeUInt16LE(threshold, 0); head.writeUInt32LE(timeLock, 2); head.writeBigUInt64LE(BigInt(transactionIndex), 6); head.writeBigUInt64LE(BigInt(staleTransactionIndex), 14);
  const n = Buffer.alloc(4); n.writeUInt32LE(members.length);
  return Buffer.concat([Buffer.from(SQUADS.multisigDiscriminator), k(createKey), k(configAuthority), head, rentCollector ? Buffer.concat([Buffer.from([1]), k(rentCollector)]) : Buffer.from([0]),
    Buffer.from([bump]), n, ...members.map((m) => Buffer.concat([k(m.key ?? m), Buffer.from([m.permissions ?? 7])])), Buffer.alloc(rentCollector ? 0 : 32)]);
}
/** The vault index (0 to 255) of `multisig` whose PDA is `key`, or null. */
export function squadsVaultIndexOf(multisig, key) {
  for (let i = 0; i < 256; i++) if (squadsVaultPda(multisig, i) === String(key)) return i;
  return null;
}

/**
 * What a ProgramData account says about its program's upgrades: `{ state: 'closed' }` (missing or under 45 bytes,
 * what a loader Close leaves), `{ state: 'immutable' }` (a ProgramData whose authority option is None),
 * `{ state: 'upgradeable', authority }`, or `{ state: 'invalid' }` (not a ProgramData account).
 */
export function programDataState(programData) {
  if (!programData) return { state: 'closed' };
  const d = Buffer.from(programData.data);
  if (d.length < 45) return { state: 'closed' };
  if (d.readUInt32LE(0) !== 3) return { state: 'invalid' };
  if (d[12] === 0) return { state: 'immutable' };
  if (d[12] === 1) return { state: 'upgradeable', authority: keyAt(d, 13) };
  return { state: 'invalid' };
}
/** The upgrade authority of a ProgramData account (`null` when none or not a ProgramData account). */
export function upgradeAuthorityOf(programData) {
  const s = programDataState(programData);
  return s.state === 'upgradeable' ? s.authority : null;
}

/** The accounts the checklist reads, as `{ address, owner, lamports, data }` or null. */
export function checklistAddresses({ programId = CURVE_PROGRAM_ID, cluster = 'mainnet' } = {}) {
  const P = curvePdas({ programId, cluster });
  const ids = CLUSTERS[cluster];
  const programData = (id) => findPda([new PublicKey(id).toBuffer()], ADDRESSES.upgradeableLoader)[0];
  return {
    P,
    ids,
    curveLaunchpad: P.launchpad(),
    curveProgramData: P.programData(),
    curveConfig0: P.config(0),
    rewardsRegistry: findPda([Buffer.from('registry')], ids.rewardsProgram)[0],
    rewardsProgramData: programData(ids.rewardsProgram),
    legacyLaunchpad: ids.legacyLaunchpad,
    legacyProgramData: programData(ids.legacyProgram),
  };
}

/** Every founder vicinity_curve's accounts name: `[{ founder, what }]` for each Coin and each pending Approval. */
export function foundersOf(curveAccounts, { programId = CURVE_PROGRAM_ID } = {}) {
  const out = [];
  for (const a of curveAccounts) {
    const type = accountType(a, { programId });
    if (type === 'CurveCoin') { const c = decodeCurveCoin(a, { programId }); out.push({ founder: c.founder, what: `the coin of city ${c.cityId}` }); }
    if (type === 'Approval') { const p = decodeApproval(a, { programId }); out.push({ founder: p.founder, what: `the approval of city ${p.cityId}` }); }
  }
  return out;
}

const ROLES = Object.freeze({ guardian: 'the guardian', payoutAuthority: 'the payout key', payoutDestination: 'the payout wallet', launchApprover: 'the launch approver' });
/**
 * The problems of a proposed role key, before the set_guardian or set_payout_config proposal that names it is signed
 * (8.4's operating rule; reviews SPEC-1, R5-DIFF-2, R5-CONS-2), or the set_launch_approver proposal (4.24, 8.4).
 * `role` is 'guardian', 'payoutAuthority', 'payoutDestination' or 'launchApprover'; `lp` the decoded Launchpad (with any other proposed key of the same proposal applied);
 * `curveAccounts` vicinity_curve's accounts. The program refuses a founder as guardian or payout key only at approve_launch,
 * launch and transfer_founder, and cannot list the coins when these settings change; it refuses FEE_RECIPIENT and the
 * keys a role must stay apart from itself, which this repeats so that nothing is proposed that would fail or mislead.
 * Returns `{ problems, warnings }`.
 */
export function checkProposedRoleKey({ role, key, lp, curveAccounts = [], vault, programId = CURVE_PROGRAM_ID }) {
  if (!ROLES[role]) throw new TypeError(`unknown role ${role}`);
  key = String(key);
  const problems = []; const warnings = [];
  const name = ROLES[role];
  const bad = (code, message) => problems.push({ code, message: `proposed ${name} ${key}: ${message}` });
  if (key === ZERO) {
    if (role === 'guardian') warnings.push({ code: 'PROPOSED_NO_GUARDIAN', message: 'the proposal removes the guardian: the only brake would then wait for the time lock (O9)' });
    if (role === 'launchApprover') warnings.push({ code: 'PROPOSED_NO_LAUNCH_APPROVER', message: 'the proposal removes the launch approver: the stored batches are cleared and batch launches stop; the per-city path remains (4.24)' });
    return { problems, warnings };
  }
  if (role === 'launchApprover') {
    // the approver holds no other seat and is never a founder (4.24, I25): the program refuses the keys of its seats at
    // set_launch_approver and refuses the approver as a founder from then on, but cannot list the coins it founded before
    for (const { founder, what } of foundersOf(curveAccounts, { programId })) {
      if (founder === key) bad('PROPOSED_KEY_IS_FOUNDER', `${what} names it as founder, so the approver would hold that founder seat and its claim (4.24, I25); the program cannot see this when the approver is set`);
    }
    if (key === ADDRESSES.feeRecipient) bad('PROPOSED_KEY_FEE_RECIPIENT', 'it is FEE_RECIPIENT, which holds no role (GOV-2); the program refuses it');
    const seats = [['the vault', String(vault ?? '')], ['the admin', lp?.admin], ['the proposed admin', lp?.pendingAdmin], ['the guardian', lp?.guardian], ['the payout key', lp?.payoutAuthority], ['the payout wallet', lp?.payoutDestination]];
    const held = seats.filter(([, k]) => k && k !== ZERO && k === key).map(([what]) => what);
    if (held.length) bad('PROPOSED_APPROVER_HOLDS_ROLE', `it is ${held.join(' and ')}; the launch approver holds no other seat (4.24, ApproverHoldsRole); the program refuses it`);
    return { problems, warnings };
  }
  if (lp && lp.launchApprover && lp.launchApprover !== ZERO && lp.launchApprover === key) bad('PROPOSED_KEY_IS_APPROVER', 'it is the launch approver, which holds no other seat (4.24, ApproverHoldsRole); the program refuses it');
  for (const { founder, what } of foundersOf(curveAccounts, { programId })) {
    if (founder !== key) continue;
    if (role === 'payoutDestination') warnings.push({ code: 'PROPOSED_KEY_IS_FOUNDER', message: `proposed ${name} ${key} is the founder of ${what.replace(/^the /, '')}: it would receive the payouts of the founders who opt in, its own included` });
    else bad('PROPOSED_KEY_IS_FOUNDER', `${what} names it as founder, so it would hold that founder seat and its claim (8.1, I20, I21); the program cannot see this when the setting changes`);
  }
  if (key === ADDRESSES.feeRecipient) bad('PROPOSED_KEY_FEE_RECIPIENT', 'it is FEE_RECIPIENT, which holds no role (GOV-2); the program refuses it');
  const admins = [...new Set([String(vault ?? ''), lp?.admin, lp?.pendingAdmin].filter((k) => k && k !== ZERO))];
  if (admins.includes(key)) {
    if (role === 'guardian') bad('PROPOSED_GUARDIAN_IS_ADMIN', 'it is the admin (or the vault, or the proposed admin): its halt would wait for the admin\'s time lock (8.1, review R5-CONS-1); the program refuses it');
    else bad('PROPOSED_PAYOUT_IS_ADMIN', 'it is the admin (or the vault, or the proposed admin); the payout keys stay apart from the admin (4.5); the program refuses it');
  }
  if (lp) {
    if (role === 'guardian' && [lp.payoutAuthority, lp.payoutDestination].includes(key)) bad('PROPOSED_GUARDIAN_PAYOUT', 'it is the payout key or the payout wallet (GOV-2); the program refuses it');
    if (role !== 'guardian' && lp.guardian === key) bad('PROPOSED_PAYOUT_IS_GUARDIAN', 'it is the guardian, which cannot touch money (GOV-2); the program refuses it');
    if (role === 'payoutAuthority' && lp.payoutDestination === key) bad('PROPOSED_PAYOUT_SAME', 'it is the payout wallet; the payout key and wallet are two keys (4.5); the program refuses it');
    if (role === 'payoutDestination' && lp.payoutAuthority === key) bad('PROPOSED_PAYOUT_SAME', 'it is the payout key; the payout key and wallet are two keys (4.5); the program refuses it');
  }
  return { problems, warnings };
}

const OPTIONS = new Set(['accounts', 'legacyAccounts', 'curveAccounts', 'vault', 'programId', 'cluster', 'beforeLegacyClose', 'proposed', 'guardianMultisig', 'vaultMultisig', 'approverMultisig']);
const PROPOSED = new Set(['guardian', 'payoutAuthority', 'payoutDestination', 'launchApprover']);

/** Squads v4 permissions a member needs to start, approve and execute a vault transaction alone (Initiate, Vote, Execute). */
export const SQUADS_ALL_PERMISSIONS = SQUADS.permissions.initiate | SQUADS.permissions.vote | SQUADS.permissions.execute;
/** Whether `key` is an ed25519 point, so a wallet key; a program address (a Squads vault, any PDA) is not. */
export const isWalletKey = (key) => PublicKey.isOnCurve(new PublicKey(String(key)).toBytes());

/**
 * The Squads multisigs behind the guardian, the vault and the launch approver (reviews R6-RT-2, R7-2, R7-CONF-3).
 * `guardian` and `approver` are the keys after the proposal (the proposed ones where given); `guardianMultisig`,
 * `vaultMultisig` and `approverMultisig` the multisig addresses (or null) and `accounts` the snapshot holding their
 * accounts. The guardian must be a vault of its multisig, which has no time lock, whose config authority is the admin
 * vault (a controlled multisig: no member and no threshold of members can change its members, threshold or time lock;
 * only the time-locked vault can), whose threshold is 1 and in which at least two members can each start, approve and
 * execute a stop alone (so the stops survive the loss or theft of any one member key, review R7-2). The approver is no
 * member key and no vault (any index) of the guardian's or the vault's multisig, so the key that signs batches is never
 * the key that stops them (4.4, O32; review R7-CONF-3); an approver that is not a wallet key can only be a multisig
 * vault, which the batch verifier cannot check a publication of (`APPROVER_NOT_VERIFIABLE`, review R8-DIFF-6), so
 * `approverMultisig` is then required: the approver must be one of its vaults, it has no time lock and shares no
 * member key with the guardian's or the vault's multisig; none of its members is the guardian, the admin vault, a vault
 * of the guardian's or the vault's multisig or any other program address, its config authority is none or the admin
 * vault, and a threshold of 1 is a warning (review R8-DIFF-3). Returns `{ problems, warnings }`.
 */
export function checkSquadsRoles({ guardian, approver, vault, guardianMultisig = null, vaultMultisig = null, approverMultisig = null, accounts = {} }) {
  const problems = []; const warnings = [];
  const bad = (code, message) => problems.push({ code, message });
  const read = (addr, code, what) => {
    try { return decodeSquadsMultisig(accounts[String(addr)] ?? null); } catch (e) { bad(code, `${what} ${addr} is not a Squads v4 multisig: ${e.message}`); return null; }
  };
  const approverSet = approver && approver !== ZERO;
  if (guardian && guardian !== ZERO) {
    if (!guardianMultisig) {
      bad('GUARDIAN_MULTISIG_UNCHECKED', 'pass --guardian-multisig <its Squads multisig>: the checklist must read the guardian multisig\'s members, threshold, time lock and config authority (review R6-RT-2)');
    } else {
      const ms = read(guardianMultisig, 'GUARDIAN_MULTISIG_INVALID', 'the guardian multisig');
      if (ms) {
        const index = squadsVaultIndexOf(guardianMultisig, guardian);
        if (index === null) bad('GUARDIAN_NOT_MULTISIG_VAULT', `the guardian ${guardian} is not a vault of the multisig ${guardianMultisig}`);
        if (ms.timeLock !== 0) bad('GUARDIAN_TIME_LOCK', `the guardian multisig has a time lock of ${ms.timeLock} seconds: its clears and pauses would wait for it (8.1, 8.3)`);
        if (ms.configAuthority !== String(vault)) {
          const who = ms.configAuthority === ZERO
            ? `it is autonomous: any ${ms.threshold} of its ${ms.members.length} members can change its members, threshold and time lock by a config transaction; ${ms.threshold === 1 ? 'one stolen member key removes the other members, whose clears and pauses then fail' : 'that many members acting together can remove the others'}`
            : `its config authority ${ms.configAuthority} can change its members, threshold and time lock alone`;
          bad('GUARDIAN_MULTISIG_NOT_CONTROLLED', `the guardian multisig must be a controlled multisig whose config authority is the admin vault ${vault}, so that no member can lock the others out of the guardian's stops (review R6-RT-2); ${who}`);
        }
        if (approverSet && ms.members.some((m) => m.key === approver)) bad('APPROVER_IS_GUARDIAN_MEMBER', `the launch approver ${approver} is a member key of the guardian multisig: one stolen key would publish batches and act as the guardian (8.4, O32, review R6-RT-2)`);
        // review R7-2: every stop is one member's vault transaction (scripts/vcurve/guardian-stop.mjs), so it must need one
        // approval and be open to at least two members who each hold every permission it uses
        if (ms.threshold !== 1) bad('GUARDIAN_THRESHOLD', `the guardian multisig's threshold is ${ms.threshold}: every clear and pause would need ${ms.threshold} members, so one member unavailable or stolen could stop the guardian (O35: 1 of 3)`);
        const actors = ms.members.filter((m) => (m.permissions & SQUADS_ALL_PERMISSIONS) === SQUADS_ALL_PERMISSIONS);
        if (actors.length < 2) {
          bad('GUARDIAN_TOO_FEW_ACTORS', `only ${actors.length} of the guardian multisig's ${ms.members.length} members can start, approve and execute a stop alone (Initiate, Vote and Execute): the loss or theft of ${actors.length ? 'that one key' : 'no key'} would leave no guardian stop (review R7-2)`);
        }
      }
    }
  }
  const vaultMs = vaultMultisig ? read(vaultMultisig, 'VAULT_MULTISIG_INVALID', 'the vault multisig') : null;
  if (vaultMs) {
    if (squadsVaultIndexOf(vaultMultisig, vault) === null) bad('VAULT_NOT_MULTISIG_VAULT', `the vault ${vault} is not a vault of the multisig ${vaultMultisig}`);
    if (approverSet && vaultMs.members.some((m) => m.key === approver)) bad('APPROVER_IS_VAULT_MEMBER', `the launch approver ${approver} is a member key of the vault's multisig (8.4, O32)`);
    if (vaultMs.timeLock === 0) warnings.push({ code: 'VAULT_TIME_LOCK_UNSET', message: 'the vault\'s multisig has no time lock: O11 sets 48 hours from the first coin launch, unless the owner chose its alternative' });
  }
  // the approver is never a vault of the guardian's or the vault's multisig (review R7-CONF-3): the program compares exact
  // keys only, so vault 1 of the guardian multisig would let any guardian member publish batches alone
  if (approverSet) {
    for (const [ms, code, what] of [[guardianMultisig, 'APPROVER_IS_GUARDIAN_VAULT', 'the guardian multisig'], [vaultMultisig, 'APPROVER_IS_VAULT_MULTISIG_VAULT', 'the vault\'s multisig']]) {
      if (!ms) continue;
      const index = squadsVaultIndexOf(ms, approver);
      if (index !== null) bad(code, `the launch approver ${approver} is vault ${index} of ${what} ${ms}: its members could publish batches, and the key that stops a wrong batch would be the key that signs it (4.4, O32; review R7-CONF-3)`);
    }
    if (!isWalletKey(approver) || approverMultisig) {
      // review R8-DIFF-6: the batch verifier cannot build or check a publication made through a multisig
      if (!isWalletKey(approver)) {
        bad('APPROVER_NOT_VERIFIABLE', `the launch approver ${approver} is not a wallet key (a multisig vault, O32 (a)): the batch verifier refuses it, since it cannot check a publication made through Squads (verify --tx covers only a transaction the approver itself signs), so the members would approve proposals whose root nothing checks before they sign; until the verifier has a Squads mode the approver must be a wallet key (O32's default; review R8-DIFF-6)`);
      }
      if (!approverMultisig) {
        bad('APPROVER_MULTISIG_UNCHECKED', `the launch approver ${approver} is not a wallet key (it is off the ed25519 curve), so it can only sign as a program address, a multisig vault: pass --approver-multisig <its Squads multisig> (O32 (a); review R7-CONF-3)`);
      } else {
        const ams = read(approverMultisig, 'APPROVER_MULTISIG_INVALID', 'the approver multisig');
        if (ams) {
          if (squadsVaultIndexOf(approverMultisig, approver) === null) bad('APPROVER_NOT_MULTISIG_VAULT', `the launch approver ${approver} is not a vault of the multisig ${approverMultisig}`);
          if (ams.timeLock !== 0) bad('APPROVER_TIME_LOCK', `the approver multisig has a time lock of ${ams.timeLock} seconds: a publication would execute later than it was prepared, with a window the program may refuse (O32 (a): no time lock)`);
          const guardianMs = guardianMultisig ? (() => { try { return decodeSquadsMultisig(accounts[String(guardianMultisig)] ?? null); } catch { return null; } })() : null;
          for (const [other, what] of [[guardianMs, 'the guardian multisig'], [vaultMs, 'the vault\'s multisig']]) {
            if (!other) continue;
            const shared = ams.members.filter((m) => other.members.some((o) => o.key === m.key)).map((m) => m.key);
            if (shared.length) bad('APPROVER_MULTISIG_SHARES_MEMBER', `the approver multisig shares member key(s) ${shared.join(', ')} with ${what}: one stolen key would both sign batches and ${what === 'the guardian multisig' ? 'act as the guardian' : 'vote as the admin'} (O32 (a); review R7-CONF-3)`);
          }
          // review R8-DIFF-3: a member that is itself a role or a program address, and a config authority other than none or
          // the admin vault, would let a guardian member (or whoever controls that key) sign batches alone
          const roleOf = (k) => {
            if (guardian && guardian !== ZERO && k === String(guardian)) return 'the guardian';
            if (k === String(vault)) return 'the admin vault';
            for (const [msAddr, name] of [[guardianMultisig, 'the guardian multisig'], [vaultMultisig, 'the vault\'s multisig']]) {
              const i = msAddr ? squadsVaultIndexOf(msAddr, k) : null;
              if (i !== null) return `vault ${i} of ${name}`;
            }
            return null;
          };
          for (const m of ams.members) {
            const role = roleOf(m.key);
            if (role) bad('APPROVER_MULTISIG_MEMBER_IS_ROLE', `member ${m.key} of the approver multisig is ${role}: any one member of that multisig could create, approve and execute a publication through it, so one stolen guardian member key would sign batches (O32 (a); review R8-DIFF-3)`);
            else if (!isWalletKey(m.key)) bad('APPROVER_MULTISIG_PROGRAM_MEMBER', `member ${m.key} of the approver multisig is not a wallet key (a program address, such as another multisig's vault): whoever controls that program would vote on batches; every member must be a wallet key (review R8-DIFF-3)`);
          }
          if (ams.configAuthority !== ZERO && ams.configAuthority !== String(vault)) {
            const role = roleOf(ams.configAuthority);
            bad('APPROVER_MULTISIG_CONFIG_AUTHORITY', `the approver multisig's config authority ${ams.configAuthority}${role ? ` (${role})` : ''} can add members and lower its threshold alone, and then publish through it: it must be none (only its own members change it) or the admin vault ${vault} (review R8-DIFF-3)`);
          }
          if (ams.threshold <= 1) warnings.push({ code: 'APPROVER_MULTISIG_THRESHOLD_ONE', message: `the approver multisig's threshold is ${ams.threshold}: any one of its members publishes alone, so one stolen device still publishes a batch, which O32 (a) is meant to prevent: use at least 2 (review R8-DIFF-3)` });
        }
      }
    }
  }
  return { problems, warnings };
}

/**
 * The checklist on a snapshot: `accounts` maps each address of `checklistAddresses` to its account (or null), and the
 * Squads multisigs named by `guardianMultisig` and `vaultMultisig` to theirs; `legacyAccounts` are the old program's
 * accounts (getProgramAccounts) and `curveAccounts` vicinity_curve's; `proposed` = `{ guardian, payoutAuthority,
 * payoutDestination, launchApprover }` (any of them) checks the keys a proposal would set (checkProposedRoleKey, and
 * checkSquadsRoles with the proposed guardian and approver). Unknown options are refused, so a misspelt check is never
 * skipped silently. Returns `{ problems, warnings }`, each a list of `{ code, message }`.
 */
export function checkDeployPreconditions(opts) {
  for (const k of Object.keys(opts ?? {})) if (!OPTIONS.has(k)) throw new TypeError(`checkDeployPreconditions: unknown option ${k}`);
  const { accounts, legacyAccounts = [], curveAccounts = [], programId = CURVE_PROGRAM_ID, cluster = 'mainnet', beforeLegacyClose = false, proposed = {}, guardianMultisig = null, vaultMultisig = null, approverMultisig = null } = opts;
  for (const k of Object.keys(proposed)) if (!PROPOSED.has(k)) throw new TypeError(`checkDeployPreconditions: unknown proposed key ${k}`);
  const vault = String(opts.vault);
  const A = checklistAddresses({ programId, cluster });
  const get = (k) => accounts[A[k]] ?? null;
  const problems = []; const warnings = [];
  const bad = (code, message) => problems.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });
  // vicinity_curve
  let lp = null;
  try { lp = get('curveLaunchpad') && decodeLaunchpad(get('curveLaunchpad'), { programId }); } catch (e) { bad('CURVE_LAUNCHPAD', `vicinity_curve's Launchpad does not decode: ${e.message}`); }
  if (!lp) bad('CURVE_LAUNCHPAD', 'vicinity_curve is not initialised (no Launchpad)');
  else {
    if (lp.admin !== vault || lp.pendingAdmin !== ZERO) bad('CURVE_ADMIN', `vicinity_curve's admin is ${lp.admin} (pending ${lp.pendingAdmin}), not the vault ${vault} with nothing pending`);
    if (lp.guardian === ZERO) bad('GUARDIAN_UNSET', 'no guardian is set (8.4)');
    else {
      if ([lp.payoutAuthority, lp.payoutDestination].includes(lp.guardian)) bad('GUARDIAN_PAYOUT', 'the guardian is the payout key or the payout wallet');
      if ([lp.admin, vault, lp.pendingAdmin].includes(lp.guardian)) {
        bad('GUARDIAN_IS_ADMIN', `the guardian ${lp.guardian} is the admin, the vault or the proposed admin: its halt would wait for the admin's time lock, so the fast brake of 8.3 would not exist (8.1, 8.4, review R5-CONS-1)`);
      }
    }
  }
  if (upgradeAuthorityOf(get('curveProgramData')) !== vault) bad('CURVE_UPGRADE_AUTHORITY', `vicinity_curve's upgrade authority is ${upgradeAuthorityOf(get('curveProgramData'))}, not the vault`);
  let config0 = null;
  try { config0 = get('curveConfig0') && decodeLaunchConfig(get('curveConfig0'), { programId }); } catch { config0 = null; }
  if (!config0) bad('CONFIG0', 'config #0 is not added');
  else {
    const p = configParamsOf(config0);
    const differs = Object.keys(DEFAULT_CONFIG).filter((k) => BigInt(p[k]) !== BigInt(DEFAULT_CONFIG[k]));
    if (differs.length) warn('CONFIG0_NOT_DEFAULT', `config #0 differs from the default config #0 of 5.9 in ${differs.join(', ')}: confirm that the owner chose these values (13)`);
  }
  // vicinity_rewards
  const reg = get('rewardsRegistry');
  const R = REWARDS_REGISTRY;
  if (!reg || reg.owner !== A.ids.rewardsProgram || reg.data.length !== R.len || !sameBytes(reg.data, R.discriminator)) {
    bad('REWARDS_REGISTRY', 'vicinity_rewards\' registry is missing or not a Registry');
  } else if (keyAt(reg.data, R.adminAt) !== vault || keyAt(reg.data, R.pendingAdminAt) !== ZERO) {
    bad('REWARDS_REGISTRY_ADMIN', `vicinity_rewards' registry admin is ${keyAt(reg.data, R.adminAt)} (pending ${keyAt(reg.data, R.pendingAdminAt)}), not the vault with nothing pending: that key alone could create a new coin's rewards config with wrong economics (OPS-1); approve_launch and launch refuse with RewardsRegistryAdminMismatch`);
  }
  if (upgradeAuthorityOf(get('rewardsProgramData')) !== vault) bad('REWARDS_UPGRADE_AUTHORITY', `vicinity_rewards' upgrade authority is ${upgradeAuthorityOf(get('rewardsProgramData'))}, not the vault`);
  // the old vicinity_launchpad
  const old = get('legacyLaunchpad');
  if (!old || old.owner !== A.ids.legacyProgram || old.data.length !== LEGACY_LAUNCHPAD_LEN || !sameBytes(old.data, LEGACY_LAUNCHPAD_DISCRIMINATOR)) {
    bad('LEGACY_LAUNCHPAD', 'the old vicinity_launchpad\'s Launchpad is missing or not a Launchpad');
  } else {
    if (keyAt(old.data, LEGACY_ADMIN_AT) !== vault || keyAt(old.data, LEGACY_PENDING_ADMIN_AT) !== ZERO) {
      bad('LEGACY_ADMIN', `the old program's admin is ${keyAt(old.data, LEGACY_ADMIN_AT)} (pending ${keyAt(old.data, LEGACY_PENDING_ADMIN_AT)}), not the vault with nothing pending (GOV-1)`);
    }
    if (old.data[LEGACY_LAUNCHES_PAUSED_AT] !== 1) bad('LEGACY_LAUNCHES_OPEN', 'the old program\'s launches are not paused (8.5)');
  }
  const oldPd = programDataState(get('legacyProgramData'));
  const oldClosed = oldPd.state === 'closed';
  if (oldPd.state === 'immutable') {
    // review R5-DIFF-3, R5-CONS-3: what 8.5 and O19 recommend instead of a close; nobody can change the old code, and
    // its instructions stay callable (its admin can still revoke old approvals and keep its launches paused)
    warn('LEGACY_IMMUTABLE', 'the old program is immutable (no upgrade authority): its code can never change, which meets 8.4 and 8.5; its admin seat still moves only by its own propose_admin and accept_admin');
  } else if (oldPd.state === 'upgradeable') {
    if (oldPd.authority !== vault) bad('LEGACY_UPGRADE_AUTHORITY', `the old program's upgrade authority is ${oldPd.authority}, not the vault`);
  } else if (!oldClosed) bad('LEGACY_UPGRADE_AUTHORITY', 'the old program\'s ProgramData account is not a ProgramData account');
  for (const a of legacyAccounts) {
    if (a.owner !== A.ids.legacyProgram) continue;
    if (sameBytes(a.data, LEGACY_ACCOUNTS.LaunchConfig) && a.data[LEGACY_ACCOUNTS.launchConfigEnabledAt] !== 0) {
      bad('LEGACY_CONFIG_ENABLED', `the old program's LaunchConfig ${a.address} is enabled (8.5)`);
    }
    if (sameBytes(a.data, LEGACY_ACCOUNTS.Approval)) {
      const city = Buffer.from(a.data).readBigUInt64LE(8);
      const text = `the old program still holds an Approval for city ${city} (${a.address}): approve_launch and launch refuse that city here (LegacyApprovalExists)`;
      if (beforeLegacyClose || oldClosed) bad('LEGACY_APPROVAL', `${text}, and after a close of the old program nothing can ever revoke it; revoke it with the old revoke_approval first (OPS-4)`);
      else warn('LEGACY_APPROVAL', `${text} until it is revoked or used; revoke it before closing the old program (OPS-4)`);
    }
  }
  // founders holding a role
  if (lp) {
    const roles = [['FEE_RECIPIENT', ADDRESSES.feeRecipient], ['the guardian', lp.guardian], ['the payout key', lp.payoutAuthority], ['the launch approver', lp.launchApprover]].filter(([, k]) => k && k !== ZERO);
    for (const { founder, what } of foundersOf(curveAccounts, { programId })) {
      for (const [name, k] of roles) if (founder === k) bad('FOUNDER_HOLDS_ROLE', `${what} names ${name} (${k}) as founder (8.4)`);
    }
    // the launch approver holds no other seat (4.24, I25; the program keeps this both ways, the checklist reads it again)
    if (lp.launchApprover && lp.launchApprover !== ZERO) {
      const held = [['the vault', vault], ['the admin', lp.admin], ['the proposed admin', lp.pendingAdmin], ['the guardian', lp.guardian], ['the payout key', lp.payoutAuthority], ['the payout wallet', lp.payoutDestination], ['FEE_RECIPIENT', ADDRESSES.feeRecipient]]
        .filter(([, k]) => k && k !== ZERO && k === lp.launchApprover).map(([name]) => name);
      if (held.length) bad('APPROVER_HOLDS_ROLE', `the launch approver ${lp.launchApprover} is ${held.join(' and ')} (4.24)`);
    }
  }
  // the keys a proposal would set (reviews R5-DIFF-2, R5-CONS-2): each against the Launchpad with the proposal's other keys applied
  const after = lp ? { ...lp, ...Object.fromEntries(Object.entries(proposed).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])) } : null;
  for (const role of ['guardian', 'payoutAuthority', 'payoutDestination', 'launchApprover']) {
    if (proposed[role] === undefined || proposed[role] === null) continue;
    const r = checkProposedRoleKey({ role, key: proposed[role], lp: after, curveAccounts, vault, programId });
    problems.push(...r.problems); warnings.push(...r.warnings);
  }
  // the Squads multisigs behind the guardian and the vault, with the proposal's keys applied (review R6-RT-2)
  if (after) {
    const r = checkSquadsRoles({ guardian: after.guardian, approver: after.launchApprover, vault, guardianMultisig, vaultMultisig, approverMultisig, accounts });
    problems.push(...r.problems); warnings.push(...r.warnings);
  }
  return { problems, warnings };
}

/** The snapshot `checkDeployPreconditions` reads, from a web3.js Connection (with the given Squads multisigs' accounts). */
export async function fetchChecklistSnapshot(connection, { programId = CURVE_PROGRAM_ID, cluster = 'mainnet', guardianMultisig = null, vaultMultisig = null, approverMultisig = null } = {}) {
  const A = checklistAddresses({ programId, cluster });
  const keys = [...['curveLaunchpad', 'curveProgramData', 'curveConfig0', 'rewardsRegistry', 'rewardsProgramData', 'legacyLaunchpad', 'legacyProgramData'].map((k) => A[k]),
    ...[...new Set([guardianMultisig, vaultMultisig, approverMultisig].filter(Boolean).map(String))]];
  const infos = await connection.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)));
  const shape = (address, i) => (i ? { address, owner: i.owner.toBase58(), lamports: BigInt(i.lamports), data: Buffer.from(i.data) } : null);
  const accounts = Object.fromEntries(keys.map((k, n) => [k, shape(k, infos[n])]));
  const list = async (program) => (await connection.getProgramAccounts(new PublicKey(program))).map((x) => shape(x.pubkey.toBase58(), x.account));
  return { accounts, legacyAccounts: await list(A.ids.legacyProgram), curveAccounts: await list(programId) };
}

const USAGE = 'usage: node scripts/vcurve/preflight.mjs --rpc <url> --vault <squads vault> --guardian-multisig <squads multisig> [--vault-multisig <squads multisig>] [--approver-multisig <squads multisig>] '
  + '[--cluster mainnet|devnet] [--program-id <id>] [--before-legacy-close] '
  + '[--proposed-guardian <key>] [--proposed-payout-authority <key>] [--proposed-payout-destination <key>] [--proposed-launch-approver <key>]';
const KEY_FLAGS = new Set(['guardianMultisig', 'vaultMultisig', 'approverMultisig']);
const VALUE_FLAGS = new Map([['--rpc', 'rpc'], ['--vault', 'vault'], ['--guardian-multisig', 'guardianMultisig'], ['--vault-multisig', 'vaultMultisig'], ['--approver-multisig', 'approverMultisig'], ['--cluster', 'cluster'], ['--program-id', 'programId'], ['--proposed-guardian', 'guardian'],
  ['--proposed-payout-authority', 'payoutAuthority'], ['--proposed-payout-key', 'payoutAuthority'], ['--proposed-payout-destination', 'payoutDestination'],
  ['--proposed-launch-approver', 'launchApprover']]);
const BOOL_FLAGS = new Map([['--before-legacy-close', 'beforeLegacyClose']]);

/** The CLI's options, or `{ error }` (an unknown option, a missing value, an invalid key). */
export function parseArgs(argv) {
  const o = { proposed: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.has(a)) { o[BOOL_FLAGS.get(a)] = true; continue; }
    if (!VALUE_FLAGS.has(a)) return { error: `unknown option ${a}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
    const k = VALUE_FLAGS.get(a);
    if (PROPOSED.has(k)) {
      try { o.proposed[k] = new PublicKey(v).toBase58(); } catch { return { error: `${a}: not a public key: ${v}` }; }
    } else if (KEY_FLAGS.has(k)) {
      try { o[k] = new PublicKey(v).toBase58(); } catch { return { error: `${a}: not a public key: ${v}` }; }
    } else o[k] = v;
  }
  if (!o.rpc || !o.vault) return { error: '--rpc and --vault are required' };
  return o;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.error) { console.error(`${o.error}\n${USAGE}`); return 2; }
  const cluster = o.cluster ?? 'mainnet';
  const programId = o.programId ?? CURVE_PROGRAM_ID;
  const ms = { guardianMultisig: o.guardianMultisig ?? null, vaultMultisig: o.vaultMultisig ?? null, approverMultisig: o.approverMultisig ?? null };
  const snapshot = await fetchChecklistSnapshot(new web3.Connection(o.rpc, 'confirmed'), { programId, cluster, ...ms });
  const { problems, warnings } = checkDeployPreconditions({ ...snapshot, vault: o.vault, programId, cluster, beforeLegacyClose: Boolean(o.beforeLegacyClose), proposed: o.proposed, ...ms });
  for (const w of warnings) console.log(`warning ${w.code}: ${w.message}`);
  for (const p of problems) console.log(`NOT READY ${p.code}: ${p.message}`);
  console.log(problems.length ? `${problems.length} problem(s): not ready`
    : `every checked precondition holds (confirm by hand: the program metadata, that the approver key shares no seed or device with any Squads member key${o.vaultMultisig ? '' : ', and the vault\'s time lock and members (or pass --vault-multisig)'})`);
  return problems.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
