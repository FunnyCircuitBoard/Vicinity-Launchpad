#!/usr/bin/env node
// The deploy checklist of VICINITY-CURVE-DESIGN.md 8.4 and 8.5, read from the
// chain (reviews OPS-1 and OPS-4: 8.4 said "the deploy checklist checks each
// on chain", but no checklist existed). Read-only: it fetches accounts and
// prints what is not ready; it never signs anything.
//
// Checked (each a problem unless noted):
//   * vicinity_curve: the Launchpad exists, its admin is the vault with no
//     admin transfer pending, the program's upgrade authority is the vault, a
//     guardian is set (and is neither the payout key nor the payout wallet),
//     config #0 exists;
//   * vicinity_rewards: the registry's admin is the vault with no transfer
//     pending (OPS-1; approve_launch and launch also refuse otherwise), the
//     program's upgrade authority is the vault;
//   * the old vicinity_launchpad: its admin is the vault with no transfer
//     pending (GOV-1), its upgrade authority is the vault, its launches are
//     paused, every LaunchConfig is disabled (8.5);
//   * the old program's Approval accounts (OPS-4): before `solana program
//     close` of the old program (`--before-legacy-close`) every one is a
//     problem, since a closed program can no longer revoke it and its city
//     would be refused here forever (LegacyApprovalExists); otherwise each is
//     a warning (its city is refused here until it is revoked or used);
//   * no Coin's founder and no pending Approval's founder is FEE_RECIPIENT,
//     the guardian or the payout key (8.4's operating rule, R2-DIFF-1, SPEC-1).
// Not checkable here: the Squads time lock (a property of the multisig) and
// the published program metadata; the operator confirms both by hand.
//
// Usage (from solana/):
//   node scripts/vcurve/preflight.mjs --rpc <url> --vault <squads vault>
//     [--cluster mainnet|devnet] [--program-id <vicinity_curve id>]
//     [--before-legacy-close]
// Exit status 1 when any problem is found.
import web3 from '@solana/web3.js';
import {
  ADDRESSES, CLUSTERS, CURVE_PROGRAM_ID, LEGACY_LAUNCHPAD_DISCRIMINATOR, LEGACY_LAUNCHPAD_LEN, LEGACY_LAUNCHES_PAUSED_AT,
  LEGACY_ADMIN_AT, LEGACY_PENDING_ADMIN_AT, curvePdas, findPda, decodeLaunchpad, decodeLaunchConfig, decodeCurveCoin,
  decodeApproval, accountType,
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

/** The upgrade authority of a ProgramData account (`null` when none or not a ProgramData account). */
export function upgradeAuthorityOf(programData) {
  if (!programData) return null;
  const d = Buffer.from(programData.data);
  if (d.length < 45 || d.readUInt32LE(0) !== 3) return null;
  return d[12] === 1 ? keyAt(d, 13) : null;
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

/**
 * The checklist on a snapshot: `accounts` maps each address of `checklistAddresses` to its account (or null);
 * `legacyAccounts` are the old program's accounts (getProgramAccounts) and `curveAccounts` vicinity_curve's.
 * Returns `{ problems, warnings }`, each a list of `{ code, message }`.
 */
export function checkDeployPreconditions({ accounts, legacyAccounts = [], curveAccounts = [], vault, programId = CURVE_PROGRAM_ID, cluster = 'mainnet', beforeLegacyClose = false }) {
  const A = checklistAddresses({ programId, cluster });
  const get = (k) => accounts[A[k]] ?? null;
  const problems = []; const warnings = [];
  const bad = (code, message) => problems.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });
  vault = String(vault);
  // vicinity_curve
  let lp = null;
  try { lp = get('curveLaunchpad') && decodeLaunchpad(get('curveLaunchpad'), { programId }); } catch (e) { bad('CURVE_LAUNCHPAD', `vicinity_curve's Launchpad does not decode: ${e.message}`); }
  if (!lp) bad('CURVE_LAUNCHPAD', 'vicinity_curve is not initialised (no Launchpad)');
  else {
    if (lp.admin !== vault || lp.pendingAdmin !== ZERO) bad('CURVE_ADMIN', `vicinity_curve's admin is ${lp.admin} (pending ${lp.pendingAdmin}), not the vault ${vault} with nothing pending`);
    if (lp.guardian === ZERO) bad('GUARDIAN_UNSET', 'no guardian is set (8.4)');
    else if ([lp.payoutAuthority, lp.payoutDestination].includes(lp.guardian)) bad('GUARDIAN_PAYOUT', 'the guardian is the payout key or the payout wallet');
  }
  if (upgradeAuthorityOf(get('curveProgramData')) !== vault) bad('CURVE_UPGRADE_AUTHORITY', `vicinity_curve's upgrade authority is ${upgradeAuthorityOf(get('curveProgramData'))}, not the vault`);
  let config0 = null;
  try { config0 = get('curveConfig0') && decodeLaunchConfig(get('curveConfig0'), { programId }); } catch { config0 = null; }
  if (!config0) bad('CONFIG0', 'config #0 is not added');
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
  const oldPd = get('legacyProgramData');
  const oldClosed = !oldPd || Buffer.from(oldPd.data).length < 45;
  if (!oldClosed && upgradeAuthorityOf(oldPd) !== vault) bad('LEGACY_UPGRADE_AUTHORITY', `the old program's upgrade authority is ${upgradeAuthorityOf(oldPd)}, not the vault`);
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
    for (const a of curveAccounts) {
      let founder = null; let what = '';
      const type = accountType(a, { programId });
      if (type === 'CurveCoin') { const c = decodeCurveCoin(a, { programId }); founder = c.founder; what = `the coin of city ${c.cityId}`; }
      if (type === 'Approval') { const p = decodeApproval(a, { programId }); founder = p.founder; what = `the approval of city ${p.cityId}`; }
      if (!founder) continue;
      for (const [name, k] of roles) if (founder === k) bad('FOUNDER_HOLDS_ROLE', `${what} names ${name} (${k}) as founder (8.4)`);
    }
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

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const rpc = arg('--rpc'); const vault = arg('--vault');
  if (!rpc || !vault) {
    console.error('usage: node scripts/vcurve/preflight.mjs --rpc <url> --vault <squads vault> [--cluster mainnet|devnet] [--program-id <id>] [--before-legacy-close]');
    return 2;
  }
  const cluster = arg('--cluster') ?? 'mainnet';
  const programId = arg('--program-id') ?? CURVE_PROGRAM_ID;
  const snapshot = await fetchChecklistSnapshot(new web3.Connection(rpc, 'confirmed'), { programId, cluster });
  const { problems, warnings } = checkDeployPreconditions({ ...snapshot, vault, programId, cluster, beforeLegacyClose: argv.includes('--before-legacy-close') });
  for (const w of warnings) console.log(`warning ${w.code}: ${w.message}`);
  for (const p of problems) console.log(`NOT READY ${p.code}: ${p.message}`);
  console.log(problems.length ? `${problems.length} problem(s): not ready` : 'every checked precondition holds (confirm the time lock and the program metadata by hand)');
  return problems.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
