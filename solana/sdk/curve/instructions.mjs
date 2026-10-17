// Instruction builders for all 21 vicinity_curve instructions, with the exact
// fixed account lists of VICINITY-CURVE-DESIGN.md section 4 written out below
// (no IDL lookup at run time; sdk/curve/instructions.test.mjs checks every list,
// flag, discriminator and argument encoding against the committed IDL and
// Anchor's own encoder).
//
// Instructions come back in @solana/kit's shape
//   { programAddress, accounts: [{ address, role }], data: Uint8Array }
// with role 0 read-only, 1 writable, 2 read-only signer, 3 writable signer.
// Addresses may be base58 strings, kit addresses or web3.js PublicKeys;
// amounts BigInt, number or decimal string. Nothing here touches the network.
//
// `curveInstructions({ programId, cluster })` builds for one deployment (the
// throwaway localnet/devnet id and the mainnet ids of vicinity_rewards and the
// old program by default). Every builder takes `overrides`, a map from an
// account name to an address or `{ address, role }`, for attack tests that put
// a wrong account into a slot.
import {
  ADDRESSES, CURVE_PROGRAM_ID, INSTRUCTION_DISCRIMINATORS,
} from './constants.mjs';
import { associatedTokenAddress, curvePdas, metadataAddress, toKey, u16le, u64le } from './pda.mjs';

export const Role = Object.freeze({ R: 0, W: 1, RS: 2, WS: 3 });

/**
 * The account table of each instruction: `[name, role]` in order (section 4;
 * `#[event_cpi]` appends `event_authority` and `program`). `buy` and `sell`
 * share one list of 10 accounts (4.11, 4.12).
 */
const TRADE_ACCOUNTS = [['user', Role.WS], ['coin', Role.W], ['launchpad', Role.R], ['mint', Role.R], ['coin_vault', Role.W],
  ['user_token_account', Role.W], ['token_program', Role.R], ['system_program', Role.R], ['event_authority', Role.R], ['program', Role.R]];
export const ACCOUNT_TABLES = Object.freeze({
  init_launchpad: [['payer', Role.WS], ['admin', Role.RS], ['upgrade_authority', Role.RS], ['program_data', Role.R], ['launchpad', Role.W], ['system_program', Role.R]],
  propose_admin: [['admin', Role.RS], ['launchpad', Role.W]],
  accept_admin: [['new_admin', Role.RS], ['launchpad', Role.W]],
  set_pause: [['authority', Role.RS], ['launchpad', Role.W]],
  set_guardian: [['admin', Role.RS], ['launchpad', Role.W]],
  set_payout_config: [['admin', Role.RS], ['launchpad', Role.W]],
  add_launch_config: [['admin', Role.RS], ['payer', Role.WS], ['launchpad', Role.W], ['config', Role.W], ['system_program', Role.R]],
  set_launch_config_enabled: [['admin', Role.RS], ['launchpad', Role.R], ['config', Role.W]],
  approve_launch: [['admin', Role.WS], ['launchpad', Role.R], ['config', Role.R], ['approval', Role.W], ['coin', Role.R], ['ticker_lock', Role.R],
    ['legacy_coin', Role.R], ['legacy_approval', Role.R], ['legacy_launchpad', Role.R], ['system_program', Role.R]],
  revoke_approval: [['by', Role.RS], ['launchpad', Role.R], ['approval', Role.W], ['rent_payer', Role.W]],
  launch: [['founder', Role.RS], ['payer', Role.WS], ['launchpad', Role.R], ['approval', Role.W], ['rent_payer', Role.W], ['config', Role.R],
    ['coin', Role.W], ['mint', Role.W], ['coin_vault', Role.W], ['ticker_lock', Role.W], ['metadata', Role.W], ['fee_recipient', Role.W],
    ['legacy_coin', Role.R], ['legacy_approval', Role.R], ['legacy_launchpad', Role.R], ['metadata_program', Role.R], ['token_program', Role.R],
    ['system_program', Role.R], ['rent', Role.R], ['event_authority', Role.R], ['program', Role.R]],
  buy: TRADE_ACCOUNTS,
  sell: TRADE_ACCOUNTS,
  buyback_burn: [['coin', Role.W], ['launchpad', Role.R], ['mint', Role.W], ['coin_vault', Role.W], ['token_program', Role.R],
    ['event_authority', Role.R], ['program', Role.R]],
  withdraw_platform_fees: [['coin', Role.W], ['fee_recipient', Role.W], ['event_authority', Role.R], ['program', Role.R]],
  forward_holders_fees: [['launchpad', Role.R], ['coin', Role.W], ['rewards_city_config', Role.R], ['rewards_vault', Role.W],
    ['event_authority', Role.R], ['program', Role.R]],
  claim_founder_fees: [['founder', Role.WS], ['coin', Role.W], ['event_authority', Role.R], ['program', Role.R]],
  transfer_founder: [['founder', Role.RS], ['new_founder', Role.RS], ['coin', Role.W]],
  opt_in_payout: [['founder', Role.WS], ['launchpad', Role.R], ['coin', Role.R], ['opt_in', Role.W], ['system_program', Role.R]],
  revoke_payout_opt_in: [['by', Role.RS], ['coin', Role.R], ['opt_in', Role.W], ['opt_in_founder', Role.W]],
  payout_founder_fees: [['payout_authority', Role.RS], ['launchpad', Role.R], ['coin', Role.W], ['opt_in', Role.R],
    ['destination_wallet', Role.W], ['event_authority', Role.R], ['program', Role.R]],
});

// ---------------------------------------------------------------- Borsh writer
class Writer {
  constructor(discriminator) { this.parts = [Uint8Array.from(discriminator)]; }
  raw(b) { this.parts.push(b); return this; }
  u8(n) { const v = Number(n); if (!Number.isInteger(v) || v < 0 || v > 255) throw new RangeError(`u8: ${n}`); return this.raw(Uint8Array.of(v)); }
  bool(b) { if (typeof b !== 'boolean') throw new TypeError(`bool expected, got ${b}`); return this.raw(Uint8Array.of(b ? 1 : 0)); }
  optBool(b) { return b === null || b === undefined ? this.raw(Uint8Array.of(0)) : this.raw(Uint8Array.of(1, b ? 1 : 0)); }
  u16(n) { return this.raw(u16le(n)); }
  u64(n) { return this.raw(u64le(n)); }
  i64(n) {
    const v = BigInt(n);
    if (v < -(1n << 63n) || v >= 1n << 63n) throw new RangeError(`i64: ${n}`);
    const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, true); return this.raw(b);
  }
  pubkey(k) { return this.raw(toKey(k).toBytes()); }
  bytes32(b) {
    const x = Uint8Array.from(b);
    if (x.length !== 32) throw new RangeError(`32 bytes expected, got ${x.length}`);
    return this.raw(x);
  }
  string(s) {
    const b = new TextEncoder().encode(String(s));
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, b.length, true);
    return this.raw(len).raw(b);
  }
  done() {
    const n = this.parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

/** Encode `ConfigParams` (4.6): five u16 shares, then six u64. */
function writeConfigParams(w, p) {
  for (const k of ['liquidityBps', 'platformBps', 'founderBps', 'holdersBps', 'buybackBps']) {
    if (p[k] === undefined) throw new Error(`params.${k} missing`);
    w.u16(p[k]);
  }
  for (const k of ['virtualSol', 'virtualTokens', 'curveSupply', 'poolSupply', 'graduationSol', 'launchFeeLamports']) {
    if (p[k] === undefined) throw new Error(`params.${k} missing`);
    w.u64(p[k]);
  }
}

const ZERO = ADDRESSES.system;

/**
 * Builders for one deployment. `pdas` may pass the deployment's PDA helpers
 * (for example a memoised `curvePdas({ programId, cluster })`) so that the
 * builders do not derive the same addresses again.
 */
export function curveInstructions({ programId = CURVE_PROGRAM_ID, cluster = 'mainnet', pdas } = {}) {
  const P = pdas ?? curvePdas({ programId, cluster });
  const program = P.programId;
  const evt = { event_authority: P.eventAuthority(), program };

  function make(name, accounts, data, overrides = {}) {
    const metas = ACCOUNT_TABLES[name].map(([acc, role]) => {
      const o = overrides[acc];
      if (o !== undefined && o !== null && typeof o === 'object' && 'address' in o) return { address: String(o.address), role: o.role ?? role };
      const addr = o ?? accounts[acc];
      if (addr === undefined || addr === null) throw new Error(`${name}: account ${acc} missing`);
      return { address: toKey(addr).toBase58(), role };
    });
    return { programAddress: program, accounts: metas, data };
  }
  const W = (name) => new Writer(INSTRUCTION_DISCRIMINATORS[name]);
  /** A coin's address from `{ coin }` or `{ cityId }`, with its mint and vault PDAs. */
  function coinOf({ coin, cityId }) {
    if (coin === undefined && cityId === undefined) throw new Error('coin or cityId required');
    const c = coin !== undefined ? toKey(coin).toBase58() : P.coin(cityId);
    return { coin: c, mint: P.mint(c), vault: P.coinVault(c) };
  }
  const forwardHoldersFees = ({ coin, cityId, overrides }) => {
    const c = coinOf({ coin, cityId });
    const r = P.rewardsAccounts(c.mint);
    return make('forward_holders_fees', { launchpad: P.launchpad(), coin: c.coin, rewards_city_config: r.config, rewards_vault: r.vault, ...evt },
      W('forward_holders_fees').done(), overrides);
  };
  const need = (v, what) => { if (v === undefined || v === null) throw new Error(`${what} missing`); return v; };
  const legacy = (cityId) => ({ legacy_coin: P.legacyCoin(cityId), legacy_approval: P.legacyApproval(cityId), legacy_launchpad: P.cluster.legacyLaunchpad });

  return Object.freeze({
    programId: program,
    pdas: P,

    // ------------------------------------------------ 4.1 to 4.7: admin and configs (emit!)
    /** 4.1: one time, signed by the admin and the program's upgrade authority. */
    initLaunchpad: ({ payer, admin, upgradeAuthority, guardian = ZERO, overrides }) =>
      make('init_launchpad', {
        payer, admin, upgrade_authority: upgradeAuthority, program_data: P.programData(), launchpad: P.launchpad(), system_program: ADDRESSES.system,
      }, W('init_launchpad').pubkey(guardian).done(), overrides),
    /** 4.2: `newAdmin` zero cancels. */
    proposeAdmin: ({ admin, newAdmin, overrides }) =>
      make('propose_admin', { admin, launchpad: P.launchpad() }, W('propose_admin').pubkey(newAdmin).done(), overrides),
    /** 4.3. */
    acceptAdmin: ({ newAdmin, overrides }) => make('accept_admin', { new_admin: newAdmin, launchpad: P.launchpad() }, W('accept_admin').done(), overrides),
    /** 4.4: each flag `true`, `false` or `null` (unchanged). */
    setPause: ({ authority, launches = null, payouts = null, buys = null, overrides }) =>
      make('set_pause', { authority, launchpad: P.launchpad() }, W('set_pause').optBool(launches).optBool(payouts).optBool(buys).done(), overrides),
    /** 4.4: zero = no guardian. */
    setGuardian: ({ admin, guardian, overrides }) => make('set_guardian', { admin, launchpad: P.launchpad() }, W('set_guardian').pubkey(guardian).done(), overrides),
    /** 4.5: two zeros switch payouts off. */
    setPayoutConfig: ({ admin, payoutAuthority, payoutDestination, overrides }) =>
      make('set_payout_config', { admin, launchpad: P.launchpad() },
        W('set_payout_config').pubkey(payoutAuthority).pubkey(payoutDestination).done(), overrides),
    /** 4.6: `configId` is the launchpad's `next_config_id` (it seeds the new account). */
    addLaunchConfig: ({ admin, payer = admin, configId, params, overrides }) => {
      const w = W('add_launch_config'); writeConfigParams(w, params);
      return make('add_launch_config', { admin, payer, launchpad: P.launchpad(), config: P.config(configId), system_program: ADDRESSES.system }, w.done(), overrides);
    },
    /** 4.7. */
    setLaunchConfigEnabled: ({ admin, configId, enabled, overrides }) =>
      make('set_launch_config_enabled', { admin, launchpad: P.launchpad(), config: P.config(configId) }, W('set_launch_config_enabled').bool(enabled).done(), overrides),

    // ------------------------------------------------ 4.8 to 4.10: city gate and launch
    /** 4.8: the admin pays the approval's rent (refunded on close). */
    approveLaunch: ({ admin, cityId, founder, configId, name, symbol, metaHash, expiresAt, overrides }) =>
      make('approve_launch', {
        admin, launchpad: P.launchpad(), config: P.config(configId), approval: P.approval(cityId), coin: P.coin(cityId),
        ticker_lock: overrides?.ticker_lock ? null : P.ticker(symbol), ...legacy(cityId), system_program: ADDRESSES.system,
      }, W('approve_launch').u64(cityId).pubkey(founder).u16(configId).string(name).string(symbol).bytes32(metaHash).i64(expiresAt).done(), overrides),
    /** 4.9: the admin any time, anyone after expiry; `rentPayer` is the approval's. */
    revokeApproval: ({ by, cityId, rentPayer, overrides }) =>
      make('revoke_approval', { by, launchpad: P.launchpad(), approval: P.approval(cityId), rent_payer: rentPayer }, W('revoke_approval').u64(cityId).done(), overrides),
    /**
     * 4.10: `configId`, `symbol` and `rentPayer` are the approval's (they seed
     * the config and ticker-lock accounts). The founder may append a `buy`.
     */
    launch: ({ founder, payer = founder, cityId, configId, symbol, rentPayer, overrides }) => {
      const { coin, mint, vault } = P.coinAccounts(cityId);
      return make('launch', {
        founder, payer, launchpad: P.launchpad(), approval: P.approval(cityId), rent_payer: rentPayer, config: P.config(configId),
        coin, mint, coin_vault: vault, ticker_lock: overrides?.ticker_lock ? null : P.ticker(symbol), metadata: metadataAddress(mint), fee_recipient: ADDRESSES.feeRecipient,
        ...legacy(cityId), metadata_program: ADDRESSES.metaplex, token_program: ADDRESSES.token, system_program: ADDRESSES.system,
        rent: ADDRESSES.rentSysvar, ...evt,
      }, W('launch').u64(cityId).done(), overrides);
    },

    // ------------------------------------------------ 4.11 to 4.13: trading and buyback (the same 10 accounts for buy and sell)
    /** 4.11: exact-in buy; `userTokenAccount` defaults to the user's associated token account. */
    buy: ({ user, coin, cityId, userTokenAccount, solIn, minTokensOut, overrides }) => {
      const c = coinOf({ coin, cityId });
      return make('buy', {
        user, coin: c.coin, launchpad: P.launchpad(), mint: c.mint, coin_vault: c.vault,
        user_token_account: userTokenAccount ?? associatedTokenAddress(need(user, 'buy: user'), c.mint), token_program: ADDRESSES.token,
        system_program: ADDRESSES.system, ...evt,
      }, W('buy').u64(solIn).u64(minTokensOut).done(), overrides);
    },
    /** 4.12: exact-in sell from the user's own token account. */
    sell: ({ user, coin, cityId, userTokenAccount, tokensIn, minSolOut, overrides }) => {
      const c = coinOf({ coin, cityId });
      return make('sell', {
        user, coin: c.coin, launchpad: P.launchpad(), mint: c.mint, coin_vault: c.vault,
        user_token_account: userTokenAccount ?? associatedTokenAddress(need(user, 'sell: user'), c.mint), token_program: ADDRESSES.token,
        system_program: ADDRESSES.system, ...evt,
      }, W('sell').u64(tokensIn).u64(minSolOut).done(), overrides);
    },
    /** 4.13: permissionless crank; no signer besides the fee payer. */
    buybackBurn: ({ coin, cityId, overrides }) => {
      const c = coinOf({ coin, cityId });
      return make('buyback_burn', { coin: c.coin, launchpad: P.launchpad(), mint: c.mint, coin_vault: c.vault, token_program: ADDRESSES.token, ...evt },
        W('buyback_burn').done(), overrides);
    },

    // ------------------------------------------------ 4.14 to 4.20: outflows, founder and payouts
    /** 4.14: anyone; pays only FEE_RECIPIENT. */
    withdrawPlatformFees: ({ coin, cityId, overrides }) =>
      make('withdraw_platform_fees', { coin: coinOf({ coin, cityId }).coin, fee_recipient: ADDRESSES.feeRecipient, ...evt }, W('withdraw_platform_fees').done(), overrides),
    /**
     * 4.15: anyone; credits the city's vicinity_rewards WSOL vault. Send
     * `syncNative({ account: rewardsVault })` right after it in the same
     * transaction (forwardHoldersFeesWithSync does both).
     */
    forwardHoldersFees,
    /** 4.15 as the SDK and the keeper send it: `[forward_holders_fees, SyncNative(rewards vault)]`. */
    forwardHoldersFeesWithSync: ({ coin, cityId, overrides }) => {
      const f = forwardHoldersFees({ coin, cityId, overrides });
      return [f, syncNative({ account: f.accounts[3].address })];
    },
    /** 4.16: the founder; works whatever is paused. */
    claimFounderFees: ({ founder, coin, cityId, overrides }) =>
      make('claim_founder_fees', { founder, coin: coinOf({ coin, cityId }).coin, ...evt }, W('claim_founder_fees').done(), overrides),
    /** 4.17: both keys sign. */
    transferFounder: ({ founder, newFounder, coin, cityId, overrides }) =>
      make('transfer_founder', { founder, new_founder: newFounder, coin: coinOf({ coin, cityId }).coin }, W('transfer_founder').done(), overrides),
    /** 4.18: `expectedDestination` must be the configured payout wallet. */
    optInPayout: ({ founder, coin, cityId, expectedDestination, refHash, overrides }) => {
      const c = coinOf({ coin, cityId }).coin;
      return make('opt_in_payout', { founder, launchpad: P.launchpad(), coin: c, opt_in: P.payoutOptIn(c), system_program: ADDRESSES.system },
        W('opt_in_payout').pubkey(expectedDestination).bytes32(refHash).done(), overrides);
    },
    /** 4.19: the coin's founder or the founder who signed the opt-in; rent to `optInFounder` (the opt-in's founder). */
    revokePayoutOptIn: ({ by, coin, cityId, optInFounder, overrides }) => {
      const c = coinOf({ coin, cityId }).coin;
      return make('revoke_payout_opt_in', { by, coin: c, opt_in: P.payoutOptIn(c), opt_in_founder: optInFounder }, W('revoke_payout_opt_in').done(), overrides);
    },
    /** 4.20: the payout key, to the configured payout wallet `destination`. */
    payoutFounderFees: ({ payoutAuthority, coin, cityId, destination, overrides }) => {
      const c = coinOf({ coin, cityId }).coin;
      return make('payout_founder_fees', {
        payout_authority: payoutAuthority, launchpad: P.launchpad(), coin: c, opt_in: P.payoutOptIn(c), destination_wallet: destination, ...evt,
      }, W('payout_founder_fees').done(), overrides);
    },
  });
}

// ---------------------------------------------------------------- other programs' instructions a client sends with ours
/** SPL Token `SyncNative` (tag 17): makes a WSOL account's token amount include lamports credited directly (4.15). */
export const syncNative = ({ account }) => ({
  programAddress: ADDRESSES.token, accounts: [{ address: toKey(account).toBase58(), role: Role.W }], data: Uint8Array.of(17),
});
/** Associated Token Account `CreateIdempotent` (tag 1): the buyer's token account of a classic SPL mint. */
export function createAssociatedTokenAccountIdempotent({ payer, owner, mint }) {
  return {
    programAddress: ADDRESSES.associatedToken,
    accounts: [
      { address: toKey(payer).toBase58(), role: Role.WS },
      { address: associatedTokenAddress(owner, mint), role: Role.W },
      { address: toKey(owner).toBase58(), role: Role.R },
      { address: toKey(mint).toBase58(), role: Role.R },
      { address: ADDRESSES.system, role: Role.R },
      { address: ADDRESSES.token, role: Role.R },
    ],
    data: Uint8Array.of(1),
  };
}
/** Compute Budget `SetComputeUnitLimit` (11.1 suggests limits per instruction). */
export function setComputeUnitLimit(units) {
  const d = new Uint8Array(5); d[0] = 2; new DataView(d.buffer).setUint32(1, Number(units), true);
  return { programAddress: ADDRESSES.computeBudget, accounts: [], data: d };
}
/** Compute Budget `SetComputeUnitPrice` (micro-lamports per unit). */
export function setComputeUnitPrice(microLamports) {
  const d = new Uint8Array(9); d[0] = 3; new DataView(d.buffer).setBigUint64(1, BigInt(microLamports), true);
  return { programAddress: ADDRESSES.computeBudget, accounts: [], data: d };
}

/** The builders of the default deployment (throwaway program id, mainnet ids of the other programs). */
export const ix = curveInstructions();
