// The city's vicinity_rewards config for a vicinity_curve coin, proposed only
// after it has been checked (VICINITY-CURVE-DESIGN.md 4.15, 12.5 R03, 14.1,
// T70).
//
// `forward_holders_fees` pays the holders' share only into a rewards config
// that pays holders only (model Holders, founder share 0, reward mint WSOL,
// the derived vault) and whose root publisher is the vicinity_curve admin with
// no transfer pending. vicinity_rewards writes a config's economics only in
// `init_city` and has no close instruction, so a config made with the wrong
// values makes forwarding fail for that coin forever (only an upgrade could
// route the money elsewhere, O26). `initRewardsForCoin` therefore builds the
// `init_city` instruction, simulates it, decodes the CityConfig bytes the
// simulation would write and runs the program's own two rules on them
// (`rewardsConfigProblems`: check_rewards_config and the authority rule)
// before it returns anything to propose. A config that already exists (an
// account owned by vicinity_rewards at the config address) is checked the
// same way: a correct one needs nothing; one whose only problems are its
// authority (not the admin, or a transfer pending) is fixable with
// propose_authority / accept_authority (`AuthorityNotAdmin`); one with wrong
// economics is unfixable (`ExistsWrong`, O26). A System-owned account without
// data at the config address is not a config: anyone can pre-fund the address
// (CLI-3), and init_city creates the config over it (Anchor `init`, T55).
//
// The chain is reached only through the two functions the caller passes:
//   getAccount(address)       -> { owner, lamports, data } | null
//   simulate(instructions, addresses)
//                             -> { ok: true, account(address) -> { owner, data } | null }
//                              | { ok: false, error }
// (`simulateWithConnection` adapts a @solana/web3.js Connection; the litesvm
// suites pass the World's simulator.) Plain ESM, BigInt, no Anchor.
import web3 from '@solana/web3.js';
import { ADDRESSES } from './constants.mjs';
import { decodeLaunchpad, decodeRewardsCityConfig, ownerOf, rewardsConfigProblems } from './accounts.mjs';
import { clusterIds, curvePdas, findPda, toKey } from './pda.mjs';
import { Role } from './instructions.mjs';

/** `sha256("global:init_city")[..8]` of vicinity_rewards. */
export const REWARDS_INIT_CITY_DISCRIMINATOR = Object.freeze([178, 113, 156, 92, 100, 81, 140, 222]);
/** vicinity_rewards `RewardModel` variants in Borsh order. */
export const REWARD_MODELS = Object.freeze({ Creator: 0, Holders: 1, Split: 2 });

export class RewardsConfigError extends Error {
  constructor(code, message, problems = []) {
    super(`RewardsConfigError::${code}: ${message}${problems.length ? ` (${problems.join('; ')})` : ''}`);
    this.name = 'RewardsConfigError';
    this.code = code;
    this.problems = problems;
  }
}

/** The vicinity_rewards accounts of a coin's city: registry, config `["city", mint]`, vault `["vault", config]`. */
export function rewardsCityAccounts({ mint, cluster = 'mainnet' }) {
  const id = clusterIds(cluster).rewardsProgram;
  const registry = findPda([new TextEncoder().encode('registry')], id)[0];
  const P = curvePdas({ cluster });
  const { config, vault } = P.rewardsAccounts(mint);
  return { program: id, registry, config, vault };
}

/**
 * vicinity_rewards `init_city` for a coin. The defaults are the only values
 * `forward_holders_fees` accepts (model Holders, founder share 0, WSOL);
 * the other parameters exist so that a wrong config can be built on purpose
 * and refused by `initRewardsForCoin`. `registryAdmin` is the rewards
 * registry admin, `authority` the root publisher (both the Squads vault on
 * mainnet); both sign.
 */
export function initCityInstruction({
  payer, registryAdmin, authority, founder, mint, rewardModel = 'Holders', founderBps = 0, rewardMint = ADDRESSES.nativeMint,
  cityTag = new Uint8Array(32), cluster = 'mainnet',
}) {
  const a = rewardsCityAccounts({ mint, cluster });
  if (!(rewardModel in REWARD_MODELS)) throw new Error(`unknown reward model ${rewardModel}`);
  const tag = Uint8Array.from(cityTag);
  if (tag.length !== 32) throw new RangeError('cityTag must be 32 bytes');
  const bps = Number(founderBps);
  if (!Number.isInteger(bps) || bps < 0 || bps > 0xffff) throw new RangeError(`founderBps: ${founderBps}`);
  const data = new Uint8Array(8 + 1 + 2 + 32);
  data.set(REWARDS_INIT_CITY_DISCRIMINATOR, 0);
  data[8] = REWARD_MODELS[rewardModel];
  data[9] = bps & 0xff; data[10] = bps >> 8;
  data.set(tag, 11);
  const k = (x) => toKey(x).toBase58();
  return {
    programAddress: a.program,
    accounts: [
      { address: k(payer), role: Role.WS },
      { address: k(registryAdmin), role: Role.RS },
      { address: a.registry, role: Role.R },
      { address: k(authority), role: Role.RS },
      { address: k(founder), role: Role.R },
      { address: k(mint), role: Role.R },
      { address: k(rewardMint), role: Role.R },
      { address: a.config, role: Role.W },
      { address: a.vault, role: Role.W },
      { address: ADDRESSES.token, role: Role.R },
      { address: ADDRESSES.system, role: Role.R },
    ],
    data,
  };
}

/** The holders' destination rules of 4.15 on a CityConfig account, or the decode failure as a problem. */
export function cityConfigProblems(account, { mint, admin, cluster = 'mainnet' }) {
  const { vault } = rewardsCityAccounts({ mint, cluster });
  let view;
  try { view = decodeRewardsCityConfig(account, { cluster }); } catch (e) { return { view: null, problems: [`not a vicinity_rewards CityConfig: ${e.message}`] }; }
  return { view, problems: rewardsConfigProblems(view, { mint, vault, admin }) };
}

/** The problems an existing config's authority can fix (propose_authority / accept_authority, 4.15); every other problem is in the economics, written once by init_city. */
export const FIXABLE_CONFIG_PROBLEMS = Object.freeze(['authority is not the vicinity_curve admin', 'an authority transfer is pending']);

/**
 * Build, simulate and check the city's rewards config for a launched coin
 * before anything is proposed (R03, 4.15, 14.1). Returns
 * `{ instructions, config, vault, view, already }`:
 *   * no config yet (no account, or a System-owned account without data that
 *     someone pre-funded): `instructions` is the one `init_city` whose
 *     simulated CityConfig passes check_rewards_config and the authority rule;
 *   * a correct config exists: `instructions` is empty and `already` true;
 * and throws RewardsConfigError otherwise, listing the problems:
 *   * `AuthorityNotAdmin` (`fixable` true): the config's economics are right
 *     but its authority is not the admin or a transfer is pending; the current
 *     authority proposes the admin (or zero, to cancel) and the admin accepts;
 *   * `ExistsWrong` (`fixable` false): wrong economics, which vicinity_rewards
 *     can never change (O26);
 *   * `NotACityConfig`: the address holds an account that is neither a
 *     vicinity_rewards account nor an empty System account;
 *   * `WouldBeWrong`, `SimulationFailed`, `NoLaunchpad`.
 * `admin` defaults to the vicinity_curve Launchpad's admin, read through
 * `getAccount`.
 */
export async function initRewardsForCoin({
  getAccount, simulate, payer, registryAdmin, authority, coin, admin, cluster = 'mainnet', programId,
  rewardModel = 'Holders', founderBps = 0, rewardMint = ADDRESSES.nativeMint, cityTag,
}) {
  if (typeof getAccount !== 'function' || typeof simulate !== 'function') throw new TypeError('getAccount and simulate are required');
  const mint = String(coin.mint);
  let curveAdmin = admin;
  if (!curveAdmin) {
    const P = curvePdas({ programId, cluster });
    const lp = await getAccount(P.launchpad());
    if (!lp) throw new RewardsConfigError('NoLaunchpad', 'the vicinity_curve Launchpad does not exist');
    curveAdmin = decodeLaunchpad(lp, { programId: P.programId }).admin;
  }
  const { config, vault, program: rewardsProgram } = rewardsCityAccounts({ mint, cluster });
  const existing = await getAccount(config);
  const owner = existing ? ownerOf(existing) : null;
  const dataLen = existing?.data?.length ?? 0;
  if (existing && owner === rewardsProgram) {
    const { view, problems } = cityConfigProblems(existing, { mint, admin: curveAdmin, cluster });
    if (problems.length && problems.every((p) => FIXABLE_CONFIG_PROBLEMS.includes(p))) {
      const e = new RewardsConfigError('AuthorityNotAdmin', `the city's rewards config ${config} has the right economics, but forward_holders_fees refuses it until its authority is the vicinity_curve admin ${curveAdmin} with no transfer pending: the current authority ${view.authority} proposes the admin (propose_authority; or proposes zero to cancel a pending transfer) and the admin accepts (accept_authority); the holders' share waits in holders_pending until then (4.15)`, problems);
      e.fixable = true; e.view = view;
      throw e;
    }
    if (problems.length) {
      const e = new RewardsConfigError('ExistsWrong', `the city's rewards config ${config} already exists with economics forward_holders_fees refuses; vicinity_rewards cannot change or close it, so the holders' share of this coin waits until a program upgrade (O26)`, problems);
      e.fixable = false; e.view = view;
      throw e;
    }
    return { instructions: [], config, vault, view, already: true };
  }
  if (existing && !(owner === ADDRESSES.system && dataLen === 0)) {
    throw new RewardsConfigError('NotACityConfig', `the account at the city's rewards config address ${config} is owned by ${owner} with ${dataLen} bytes: neither a vicinity_rewards CityConfig nor an empty System account`);
  }
  // no config yet: nothing there, or lamports someone sent to the address (a System account without data, which
  // init_city creates the config over, T55)
  const ix = initCityInstruction({ payer, registryAdmin, authority, founder: coin.founder, mint, rewardModel, founderBps, rewardMint, cityTag, cluster });
  const sim = await simulate([ix], [config]);
  if (!sim?.ok) throw new RewardsConfigError('SimulationFailed', `init_city does not simulate: ${sim?.error ?? 'no result'}`);
  const after = sim.account(config);
  if (!after) throw new RewardsConfigError('SimulationFailed', `the simulation returned no account at ${config}`);
  const { view, problems } = cityConfigProblems(after, { mint, admin: curveAdmin, cluster });
  if (problems.length) {
    throw new RewardsConfigError('WouldBeWrong', 'refusing to propose: the config this init_city creates would make forward_holders_fees fail forever (4.15, T70)', problems);
  }
  return { instructions: [ix], config, vault, view, already: false };
}

/**
 * `simulate` for initRewardsForCoin over a @solana/web3.js Connection: a v0
 * transaction paid by `feePayer`, simulated without signature checks and with
 * a fresh blockhash (a Squads vault cannot sign; the proposal's instruction is
 * what is simulated), returning the post-simulation state of `addresses`.
 */
export function simulateWithConnection(connection, { feePayer }) {
  return async (instructions, addresses) => {
    const { blockhash } = await connection.getLatestBlockhash();
    const ixs = instructions.map((x) => new web3.TransactionInstruction({
      programId: new web3.PublicKey(x.programAddress),
      keys: x.accounts.map((a) => ({ pubkey: new web3.PublicKey(a.address), isSigner: a.role >= 2, isWritable: a.role === 1 || a.role === 3 })),
      data: Buffer.from(x.data),
    }));
    const msg = new web3.TransactionMessage({ payerKey: new web3.PublicKey(String(feePayer)), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const r = await connection.simulateTransaction(new web3.VersionedTransaction(msg), {
      sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: addresses.map(String) },
    });
    if (r.value.err) return { ok: false, error: `${JSON.stringify(r.value.err)}\n${(r.value.logs ?? []).slice(-6).join('\n')}` };
    const out = new Map(addresses.map((a, i) => [String(a), r.value.accounts?.[i] ?? null]));
    return {
      ok: true,
      account: (addr) => {
        const a = out.get(String(addr));
        return a ? { owner: a.owner, lamports: BigInt(a.lamports), data: Buffer.from(a.data[0], 'base64') } : null;
      },
    };
  };
}
