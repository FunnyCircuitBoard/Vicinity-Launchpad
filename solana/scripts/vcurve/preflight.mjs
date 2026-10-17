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
//     the guardian or the payout key (8.4's operating rule, R2-DIFF-1, SPEC-1);
//   * a proposed key (reviews R5-DIFF-2, R5-CONS-2): before a set_guardian or
//     set_payout_config proposal is signed, `--proposed-guardian`,
//     `--proposed-payout-authority` (alias `--proposed-payout-key`) and
//     `--proposed-payout-destination` check the key against every Coin's and
//     pending Approval's founder (the program cannot list the coins when those
//     settings change) and against the keys the program keeps it apart from.
// Not checkable here: the Squads time lock (a property of the multisig), that
// the guardian multisig has no time lock of its own, and the published program
// metadata; the operator confirms them by hand.
//
// Usage (from solana/):
//   node scripts/vcurve/preflight.mjs --rpc <url> --vault <squads vault>
//     [--cluster mainnet|devnet] [--program-id <vicinity_curve id>]
//     [--before-legacy-close] [--proposed-guardian <key>]
//     [--proposed-payout-authority <key>] [--proposed-payout-destination <key>]
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

const ROLES = Object.freeze({ guardian: 'the guardian', payoutAuthority: 'the payout key', payoutDestination: 'the payout wallet' });
/**
 * The problems of a proposed role key, before the set_guardian or set_payout_config proposal that names it is signed
 * (8.4's operating rule; reviews SPEC-1, R5-DIFF-2, R5-CONS-2). `role` is 'guardian', 'payoutAuthority' or
 * 'payoutDestination'; `lp` the decoded Launchpad (with any other proposed key of the same proposal applied);
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
    return { problems, warnings };
  }
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

const OPTIONS = new Set(['accounts', 'legacyAccounts', 'curveAccounts', 'vault', 'programId', 'cluster', 'beforeLegacyClose', 'proposed']);
const PROPOSED = new Set(['guardian', 'payoutAuthority', 'payoutDestination']);

/**
 * The checklist on a snapshot: `accounts` maps each address of `checklistAddresses` to its account (or null);
 * `legacyAccounts` are the old program's accounts (getProgramAccounts) and `curveAccounts` vicinity_curve's;
 * `proposed` = `{ guardian, payoutAuthority, payoutDestination }` (any of them) checks the keys a proposal would set
 * (checkProposedRoleKey). Unknown options are refused, so a misspelt check is never skipped silently.
 * Returns `{ problems, warnings }`, each a list of `{ code, message }`.
 */
export function checkDeployPreconditions(opts) {
  for (const k of Object.keys(opts ?? {})) if (!OPTIONS.has(k)) throw new TypeError(`checkDeployPreconditions: unknown option ${k}`);
  const { accounts, legacyAccounts = [], curveAccounts = [], programId = CURVE_PROGRAM_ID, cluster = 'mainnet', beforeLegacyClose = false, proposed = {} } = opts;
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
    const roles = [['FEE_RECIPIENT', ADDRESSES.feeRecipient], ['the guardian', lp.guardian], ['the payout key', lp.payoutAuthority]].filter(([, k]) => k && k !== ZERO);
    for (const { founder, what } of foundersOf(curveAccounts, { programId })) {
      for (const [name, k] of roles) if (founder === k) bad('FOUNDER_HOLDS_ROLE', `${what} names ${name} (${k}) as founder (8.4)`);
    }
  }
  // the keys a proposal would set (reviews R5-DIFF-2, R5-CONS-2): each against the Launchpad with the proposal's other keys applied
  const after = lp ? { ...lp, ...Object.fromEntries(Object.entries(proposed).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])) } : null;
  for (const role of ['guardian', 'payoutAuthority', 'payoutDestination']) {
    if (proposed[role] === undefined || proposed[role] === null) continue;
    const r = checkProposedRoleKey({ role, key: proposed[role], lp: after, curveAccounts, vault, programId });
    problems.push(...r.problems); warnings.push(...r.warnings);
  }
  return { problems, warnings };
}

/** The snapshot `checkDeployPreconditions` reads, from a web3.js Connection. */
export async function fetchChecklistSnapshot(connection, { programId = CURVE_PROGRAM_ID, cluster = 'mainnet' } = {}) {
  const A = checklistAddresses({ programId, cluster });
  const keys = ['curveLaunchpad', 'curveProgramData', 'curveConfig0', 'rewardsRegistry', 'rewardsProgramData', 'legacyLaunchpad', 'legacyProgramData'].map((k) => A[k]);
  const infos = await connection.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)));
  const shape = (address, i) => (i ? { address, owner: i.owner.toBase58(), lamports: BigInt(i.lamports), data: Buffer.from(i.data) } : null);
  const accounts = Object.fromEntries(keys.map((k, n) => [k, shape(k, infos[n])]));
  const list = async (program) => (await connection.getProgramAccounts(new PublicKey(program))).map((x) => shape(x.pubkey.toBase58(), x.account));
  return { accounts, legacyAccounts: await list(A.ids.legacyProgram), curveAccounts: await list(programId) };
}

const USAGE = 'usage: node scripts/vcurve/preflight.mjs --rpc <url> --vault <squads vault> [--cluster mainnet|devnet] [--program-id <id>] [--before-legacy-close] '
  + '[--proposed-guardian <key>] [--proposed-payout-authority <key>] [--proposed-payout-destination <key>]';
const VALUE_FLAGS = new Map([['--rpc', 'rpc'], ['--vault', 'vault'], ['--cluster', 'cluster'], ['--program-id', 'programId'], ['--proposed-guardian', 'guardian'],
  ['--proposed-payout-authority', 'payoutAuthority'], ['--proposed-payout-key', 'payoutAuthority'], ['--proposed-payout-destination', 'payoutDestination']]);
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
    if (['guardian', 'payoutAuthority', 'payoutDestination'].includes(k)) {
      try { o.proposed[k] = new PublicKey(v).toBase58(); } catch { return { error: `${a}: not a public key: ${v}` }; }
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
  const snapshot = await fetchChecklistSnapshot(new web3.Connection(o.rpc, 'confirmed'), { programId, cluster });
  const { problems, warnings } = checkDeployPreconditions({ ...snapshot, vault: o.vault, programId, cluster, beforeLegacyClose: Boolean(o.beforeLegacyClose), proposed: o.proposed });
  for (const w of warnings) console.log(`warning ${w.code}: ${w.message}`);
  for (const p of problems) console.log(`NOT READY ${p.code}: ${p.message}`);
  console.log(problems.length ? `${problems.length} problem(s): not ready`
    : 'every checked precondition holds (confirm by hand: the time lock, that the guardian is a separate multisig without a time lock of its own, and the program metadata)');
  return problems.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
