// In-process test harness for vicinity_launchpad (no validator, no ports).
//
// One `World` = one LiteSVM instance with:
//   * our program and vicinity_rewards, both loaded through the upgradeable
//     loader with `deployer` as upgrade authority (so init_launchpad and
//     init_registry are tested for real);
//   * mainnet dumps of Meteora DBC, DAMM v2 and Metaplex Token Metadata
//     (scripts/launchpad/fetch-fixtures.sh, pinned SHA-256);
//   * the WSOL mint, the DAMM v2 customizable config (mainnet JSON fixture),
//     DBC's pool authority funded for flash rent, and the clock at real time.
// Signature checks are ON, except inside `sendAsDevWallet` (the dev wallet is a
// program constant and the tests have no key for it).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { LiteSVM } from 'litesvm';
import {
  address, generateKeyPairSigner, lamports, pipe, createTransactionMessage, getCompiledTransactionMessageDecoder,
  setTransactionMessageFeePayerSigner, appendTransactionMessageInstructions,
  signTransactionMessageWithSigners, addSignersToTransactionMessage,
  getBase64EncodedWireTransaction,
} from '@solana/kit';
import web3 from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
import * as C from '../sdk/launchpad/client.mjs';
import { IDL, coderFor, decodeAccount, buildIx, Role } from '../sdk/launchpad/idl.mjs';
import { ADDRESSES, PROGRAM_IDS, ata, dbc, damm, pdas, programDataAddress, rewardsPdas } from '../sdk/launchpad/pda.mjs';
import { vicinityConfigParams, createConfigIx } from '../sdk/launchpad/config.mjs';
import { surplusShares } from '../sdk/launchpad/curve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const solanaDir = join(here, '..');
export const P = pdas();
export const R = rewardsPdas();
export { C, IDL, ADDRESSES, PROGRAM_IDS, ata, dbc, damm, Role, buildIx, decodeAccount };

export const SUPPLY = 10n ** 15n;
export const LAMPORTS = 1_000_000_000n;
export const DAY = 86_400n;
const FIX = join(here, 'fixtures');

/**
 * Where the Meteora and Metaplex dumps come from. Default: the pinned mainnet
 * dumps. LAUNCHPAD_PROGRAMS_DIR points at another set, e.g. the devnet
 * binaries (`scripts/launchpad/fetch-fixtures.sh` with NETWORK=devnet), to
 * check that the devnet programs behave the same before a devnet demo.
 */
const PROGRAMS_DIR = process.env.LAUNCHPAD_PROGRAMS_DIR || join(FIX, 'programs');
function programPath(name) {
  const p = join(PROGRAMS_DIR, name);
  if (!existsSync(p)) {
    throw new Error(`missing ${p}: run "npm run launchpad:fixtures" (dumps Meteora and Metaplex from mainnet and checks their pinned hashes)`);
  }
  return p;
}

// ---------------------------------------------------------------- byte helpers
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pkb = (a) => new web3.PublicKey(a).toBuffer();
const opt = (a) => (a ? Buffer.concat([u32(1), pkb(a)]) : Buffer.alloc(36));

export function mintData({ supply = 0n, decimals = 6, mintAuthority = null, freezeAuthority = null }) {
  return Buffer.concat([opt(mintAuthority), u64(supply), Buffer.from([decimals, 1]), opt(freezeAuthority)]);
}
export function tokenAccountData({ mint, owner, amount = 0n, native = null }) {
  return Buffer.concat([
    pkb(mint), pkb(owner), u64(amount), Buffer.alloc(36), Buffer.from([1]),
    native === null ? Buffer.alloc(12) : Buffer.concat([u32(1), u64(native)]),
    u64(0), Buffer.alloc(36),
  ]);
}
export const readU64 = (data, at) => Buffer.from(data).readBigUInt64LE(at);
export const readKey = (data, at) => new web3.PublicKey(Buffer.from(data).subarray(at, at + 32)).toBase58();

// ---------------------------------------------------------------- results
export class TxError extends Error {
  constructor(label, logs, err) {
    super(`${label} failed: ${err}\n  ${logs.slice(-12).join('\n  ')}`);
    this.logs = logs;
    this.errText = String(err);
  }
}

/** Assert that `fn` (sync or async) fails with one of `codes` (error names, or RegExps over the logs). */
export async function expectFail(fn, ...codes) {
  let e;
  try { await fn(); } catch (x) { e = x; }
  assert.ok(e, `expected failure (${codes.join(' | ')}), but it succeeded`);
  if (!(e instanceof TxError)) throw e;
  if (codes.length === 0) return e;
  const text = e.logs.join('\n') + '\n' + e.errText;
  const ok = codes.some((c) => (c instanceof RegExp ? c.test(text) : new RegExp(`\\b${c}\\b`).test(text)));
  assert.ok(ok, `expected one of [${codes.join(', ')}], got:\n${e.message}`);
  return e;
}

// ---------------------------------------------------------------- the world
export class World {
  static async create(opts = {}) {
    const w = new World();
    await w.init(opts);
    return w;
  }

  async init({ config = {}, initLaunchpad = true, addConfig = true, initRewards = true } = {}) {
    this.svm = new LiteSVM();
    this.events = [];
    this.harvests = new Map(); // coin -> number of non-empty harvests
    this.flows = []; // every token movement out of a watched account (assertMoneyFlows)
    this.cu = {};
    const svm = this.svm;
    svm.addProgramFromFile(address(PROGRAM_IDS.dbc), programPath('dbc.so'));
    svm.addProgramFromFile(address(PROGRAM_IDS.damm), programPath('damm_v2.so'));
    svm.addProgramFromFile(address(PROGRAM_IDS.metaplex), programPath('mpl_token_metadata.so'));

    this.deployer = await this.signer();
    this.admin = await this.signer();
    this.payer = await this.signer();
    this.loadUpgradeable(PROGRAM_IDS.launchpad, join(solanaDir, 'target', 'deploy', 'vicinity_launchpad.so'), this.deployer.address);
    this.loadUpgradeable(PROGRAM_IDS.rewards, join(solanaDir, 'target', 'deploy', 'vicinity_rewards.so'), this.deployer.address);

    // WSOL mint (the native mint: 9 decimals, no authorities)
    this.setRaw(ADDRESSES.wsol, mintData({ decimals: 9 }), PROGRAM_IDS.token);
    // DAMM v2 customizable config (mainnet fixture) and DBC flash-rent funding
    const fx = JSON.parse(readFileSync(join(FIX, 'accounts', `${ADDRESSES.dammCustomizableConfig}.json`), 'utf8')).account;
    this.setRaw(ADDRESSES.dammCustomizableConfig, Buffer.from(fx.data[0], 'base64'), fx.owner, BigInt(fx.lamports));
    svm.airdrop(address(ADDRESSES.dbcPoolAuthority), lamports(10n * LAMPORTS));
    this.setClock(BigInt(Math.floor(Date.now() / 1000)));

    if (initLaunchpad) await this.send([C.initLaunchpad({ payer: this.payer.address, admin: this.admin.address, upgradeAuthority: this.deployer.address })], [this.admin, this.deployer], 'init_launchpad');
    if (initRewards) {
      await this.send([buildIx(IDL.rewards, 'init_registry', {}, {
        payer: this.payer.address, upgrade_authority: this.deployer.address, admin: this.admin.address,
        program_data: programDataAddress(PROGRAM_IDS.rewards), registry: R.registry(),
      })], [this.deployer, this.admin], 'rewards init_registry');
    }
    if (addConfig) {
      this.config = await this.createDbcConfig(config);
      await this.send([C.addLaunchConfig({ admin: this.admin.address, dbcConfig: this.config, quoteMint: ADDRESSES.wsol })], [this.admin], 'add_launch_config');
    }
    this.autoInvariants = process.env.INVARIANTS !== 'off';
  }

  // ------------------------------------------------ keys, accounts, clock
  async signer(sol = 1_000n) {
    const s = await generateKeyPairSigner();
    this.svm.airdrop(s.address, lamports(sol * LAMPORTS));
    return s;
  }
  setRaw(addr, data, owner, lam) {
    const d = new Uint8Array(data);
    this.svm.setAccount({
      address: address(String(addr)),
      lamports: lamports(lam ?? this.svm.minimumBalanceForRentExemption(BigInt(d.length))),
      programAddress: address(String(owner)), executable: false, data: d, space: BigInt(d.length),
    });
  }
  loadUpgradeable(programId, path, authority) {
    this.svm.addProgramFromFile(address(programId), path);
    const pd = programDataAddress(programId);
    const acc = this.svm.getAccount(address(pd));
    const data = Buffer.from(acc.data);
    data[12] = 1;
    pkb(authority).copy(data, 13);
    this.svm.setAccount({ ...acc, address: address(pd), data: new Uint8Array(data) });
  }
  account(addr) {
    const a = this.svm.getAccount(address(String(addr)));
    return a.exists ? a : null;
  }
  exists(addr) { return this.account(addr) !== null; }
  lamportsOf(addr) { const a = this.account(addr); return a ? BigInt(a.lamports) : 0n; }
  balance(tokenAccount) { const a = this.account(tokenAccount); return a ? readU64(a.data, 64) : 0n; }
  now() { return this.svm.getClock().unixTimestamp; }
  setClock(ts) { const c = this.svm.getClock(); c.unixTimestamp = BigInt(ts); this.svm.setClock(c); }
  warp(secs) { const c = this.svm.getClock(); c.unixTimestamp += BigInt(secs); c.slot += BigInt(secs) * 2n; this.svm.setClock(c); }

  /** Mint-less token balance helpers: give `owner` an ATA with `amount` of `mint` (WSOL is a native account). */
  fundToken(owner, mint, amount) {
    const a = ata(owner, mint);
    const amt = BigInt(amount) + (this.exists(a) ? this.balance(a) : 0n);
    if (String(mint) === ADDRESSES.wsol) {
      const rent = this.svm.minimumBalanceForRentExemption(165n);
      this.setRaw(a, tokenAccountData({ mint, owner, amount: amt, native: rent }), PROGRAM_IDS.token, rent + amt);
    } else {
      this.setRaw(a, tokenAccountData({ mint, owner, amount: amt }), PROGRAM_IDS.token);
    }
    return a;
  }
  emptyTokenAccount(owner, mint) {
    const a = ata(owner, mint);
    if (!this.exists(a)) {
      const native = String(mint) === ADDRESSES.wsol ? this.svm.minimumBalanceForRentExemption(165n) : null;
      this.setRaw(a, tokenAccountData({ mint, owner, amount: 0n, native }), PROGRAM_IDS.token);
    }
    return a;
  }
  /** Increase the balance of an existing token account in place (a "donation"). */
  donate(tokenAccount, amount) {
    const acc = this.account(tokenAccount);
    const d = Buffer.from(acc.data);
    const newAmt = readU64(d, 64) + BigInt(amount);
    d.writeBigUInt64LE(newAmt, 64);
    const native = d.readUInt32LE(109) === 1;
    this.svm.setAccount({ ...acc, address: address(String(tokenAccount)), data: new Uint8Array(d),
      lamports: lamports(BigInt(acc.lamports) + (native ? BigInt(amount) : 0n)) });
  }

  // ------------------------------------------------ transactions
  async send(ixs, signers = [], label = 'tx', { feePayer = this.payer, cu = 1_400_000 } = {}) {
    const all = [feePayer, ...signers.filter((s) => s.address !== feePayer.address)];
    const budget = { programAddress: address('ComputeBudget111111111111111111111111111111'), accounts: [],
      data: new Uint8Array([2, ...u32(cu)]) };
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
      (m) => appendTransactionMessageInstructions([budget, ...ixs.map(toKitIx)], m),
      (m) => addSignersToTransactionMessage(all, m),
    );
    const tx = await signTransactionMessageWithSigners(msg);
    const flowPre = this.autoInvariants ? flowState(this) : null;
    this.lastTxBytes = Buffer.from(getBase64EncodedWireTransaction(tx), 'base64').length;
    const res = this.svm.sendTransaction(tx);
    this.svm.expireBlockhash();
    if (typeof res.err === 'function') {
      const meta = res.meta();
      throw new TxError(label, meta.logs(), stringifyErr(res.err()));
    }
    const logs = res.logs();
    const events = parseEvents(logs);
    this.events.push(...events);
    this.lastCu = Number(res.computeUnitsConsumed());
    this.cu[label] = this.lastCu;
    // invariant 3 counts non-empty harvests per coin
    for (const e of events) {
      if (e.name === 'FeesHarvested') {
        const coin = P.coin(BigInt(e.data.city_id.toString()));
        this.harvests.set(coin, (this.harvests.get(coin) ?? 0) + 1);
      }
    }
    // LAUNCHPAD-DESIGN.md section 15: every invariant after every successful transaction
    if (this.autoInvariants) {
      // invariant 8, per transaction: every token movement out of a pot, a
      // founder vault or a Holders rewards vault went where the design says
      this.flows.push(...assertMoneyFlows(this, tx.messageBytes, res.innerInstructions(), [flowPre, flowState(this)], label));
      assertInvariants(this);
    }
    return { logs, events, cu: this.lastCu };
  }
  /** Same as send, with litesvm's signature check off for this one transaction (dev wallet steps). */
  async sendAsDevWallet(ixs, label) {
    const fake = {
      address: address(ADDRESSES.feeRecipient),
      signTransactions: async (txs) => txs.map(() => ({ [ADDRESSES.feeRecipient]: new Uint8Array(64) })),
    };
    this.svm.withSigverify(false);
    try { return await this.send(ixs, [fake], label); } finally { this.svm.withSigverify(true); }
  }

  // ------------------------------------------------ DBC config and launches
  async createDbcConfig(opts = {}, { quoteMint = ADDRESSES.wsol, feeClaimer, leftoverReceiver, params } = {}) {
    const cfg = await generateKeyPairSigner();
    const p = params ?? vicinityConfigParams(opts);
    await this.send([createConfigIx({ config: cfg.address, quoteMint, payer: this.payer.address, params: p, feeClaimer, leftoverReceiver })], [cfg], 'dbc create_config');
    return cfg.address;
  }
  decodeConfig(cfg = this.config) { return decodeAccount(IDL.dbc, 'PoolConfig', this.account(cfg).data); }
  /**
   * Copy a DBC config to a new address with fields rewritten in its raw bytes:
   * `mutate` receives a byte-level view (`c.pool_fees.base_fee.first_factor = 1`),
   * so the result is exactly what the on-chain check would read.
   */
  cloneConfig(mutate, { from = this.config, owner = PROGRAM_IDS.dbc } = {}) {
    const buf = Buffer.from(this.account(from).data);
    mutate(byteView(IDL.dbc, 'PoolConfig', buf, 8));
    const addr = web3.Keypair.generate().publicKey.toBase58();
    this.setRaw(addr, buf, owner);
    return addr;
  }

  async approve({ cityId, founder, name = 'Demo City', symbol = 'DEMO', ttl = 7n * DAY, dbcConfig = this.config, admin = this.admin }) {
    await this.send([C.approveLaunch({ admin: admin.address, cityId, founder: founder.address ?? founder, name, symbol, expiresAt: this.now() + BigInt(ttl), dbcConfig })], [admin], 'approve_launch');
  }

  /** Approve (unless `approved`) and launch a coin; returns a coin handle. */
  async launchCoin({ cityId, founder, name = 'Demo City', symbol = 'DEMO', dbcConfig = this.config, quoteMint = ADDRESSES.wsol, approved = false, payer } = {}) {
    founder = founder ?? await this.signer();
    if (!approved) await this.approve({ cityId, founder, name, symbol, dbcConfig });
    const mint = await generateKeyPairSigner();
    const signers = [founder, mint];
    if (payer) signers.push(payer);
    await this.send([C.launch({ founder: founder.address, payer: (payer ?? founder).address, baseMint: mint.address, cityId, dbcConfig, quoteMint, rentPayer: this.admin.address })], signers, 'launch', { cu: 400_000 });
    return this.coin(cityId, founder);
  }

  /** Read a launched coin back as a plain handle (addresses are base58 strings, amounts bigint). */
  coin(cityId, founder) {
    const addr = P.coin(cityId);
    const d = decodeAccount(IDL.launchpad, 'Coin', this.account(addr).data);
    const big = (x) => BigInt(x.toString());
    return {
      cityId: BigInt(cityId), address: addr, founderSigner: founder,
      founder: d.founder.toBase58(), mint: d.mint.toBase58(), quoteMint: d.quote_mint.toBase58(),
      dbcConfig: d.dbc_config.toBase58(), dbcPool: d.dbc_pool.toBase58(),
      holdersPot: P.holdersPot(addr), founderVault: P.founderVault(addr),
      holdersAccrued: big(d.holders_accrued), holdersForwarded: big(d.holders_forwarded),
      founderAccrued: big(d.founder_accrued), founderClaimed: big(d.founder_claimed), founderPaidOut: big(d.founder_paid_out),
      payoutSeq: big(d.payout_seq), lastPayoutAt: big(d.last_payout_at), launchedAt: big(d.launched_at),
    };
  }
  launchpad() { return decodeAccount(IDL.launchpad, 'Launchpad', this.account(P.launchpad()).data); }

  // ------------------------------------------------ DBC pool state
  pool(dbcPool) {
    const d = Buffer.from(this.account(dbcPool).data);
    // VirtualPool = 8-byte discriminator + PoolState (bytemuck, see the IDL)
    const ps = decodeAccount(IDL.dbc, 'VirtualPool', d).pool_state;
    const big = (x) => BigInt(x.toString());
    return {
      config: ps.config.toBase58(), creator: ps.creator.toBase58(), baseMint: ps.base_mint.toBase58(),
      baseVault: ps.base_vault.toBase58(), quoteVault: ps.quote_vault.toBase58(),
      baseReserve: big(ps.base_reserve), quoteReserve: big(ps.quote_reserve), sqrtPrice: big(ps.sqrt_price),
      protocolQuoteFee: big(ps.protocol_quote_fee), partnerQuoteFee: big(ps.partner_quote_fee), creatorQuoteFee: big(ps.creator_quote_fee),
      protocolBaseFee: big(ps.protocol_base_fee), partnerBaseFee: big(ps.partner_base_fee), creatorBaseFee: big(ps.creator_base_fee),
      isMigrated: ps.is_migrated, migrationProgress: ps.migration_progress, isWithdrawLeftover: ps.is_withdraw_leftover,
      isCreatorWithdrawSurplus: ps.is_creator_withdraw_surplus, isPartnerWithdrawSurplus: ps.is_partner_withdraw_surplus,
      isProtocolWithdrawSurplus: ps.is_protocol_withdraw_surplus,
      protocolMigrationBaseFee: big(ps.protocol_migration_base_fee_amount), protocolMigrationQuoteFee: big(ps.protocol_migration_quote_fee_amount),
    };
  }
  /** The decoded DBC config in the shape sdk/launchpad/curve.mjs expects. */
  curveConfig(cfg = this.config) {
    const c = this.decodeConfig(cfg);
    const big = (x) => BigInt(x.toString());
    return {
      curve: c.curve.map((p) => ({ sqrtPrice: big(p.sqrt_price), liquidity: big(p.liquidity) })),
      sqrtStartPrice: big(c.sqrt_start_price), migrationSqrtPrice: big(c.migration_sqrt_price),
      migrationQuoteThreshold: big(c.migration_quote_threshold), feeNumerator: big(c.pool_fees.base_fee.cliff_fee_numerator),
      creatorTradingFeePercentage: BigInt(c.creator_trading_fee_percentage),
      swapBaseAmount: big(c.swap_base_amount), migrationBaseThreshold: big(c.migration_base_threshold),
    };
  }

  /** A DBC swap by `trader` on `coin`; funds the trader's input first when `fund` is set. */
  async trade(trader, coin, { side, mode = 0, amount0, amount1 = 0n, referral, fund = true, label = 'swap2' }) {
    if (fund && side === 'buy' && mode !== 2) this.fundToken(trader.address, coin.quoteMint, amount0);
    if (fund && side === 'buy' && mode === 2) this.fundToken(trader.address, coin.quoteMint, amount1);
    this.emptyTokenAccount(trader.address, coin.mint);
    this.emptyTokenAccount(trader.address, coin.quoteMint);
    return this.send([C.swap({ trader: trader.address, pool: coin.dbcPool, config: coin.dbcConfig, baseMint: coin.mint, quoteMint: coin.quoteMint, side, mode, amount0, amount1, referral })], [trader], label);
  }

  // ------------------------------------------------ rewards
  async initRewardsCity(coin, { model = { Holders: {} }, founderBps = 0, rewardMint = coin.quoteMint, authority = this.admin, founder } = {}) {
    const cfg = R.city(coin.mint);
    await this.send([buildIx(IDL.rewards, 'init_city', { reward_model: model, founder_bps: founderBps, city_tag: Array(32).fill(0) }, {
      payer: this.payer.address, admin: this.admin.address, registry: R.registry(), authority: authority.address,
      founder: founder ?? coin.founder, city_coin_mint: coin.mint, reward_mint: rewardMint, config: cfg, vault: R.vault(cfg),
      token_program: PROGRAM_IDS.token,
    })], [this.admin, authority], 'rewards init_city');
    return { config: cfg, vault: R.vault(cfg) };
  }
}

// ---------------------------------------------------------------- byte-level views of bytemuck accounts
const PRIM = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };
function typeSize(idl, ty) {
  if (typeof ty === 'string') return PRIM[ty];
  if (ty.array) return typeSize(idl, ty.array[0]) * ty.array[1];
  if (ty.defined) return structSize(idl, ty.defined.name);
  throw new Error(`unsupported type ${JSON.stringify(ty)}`);
}
function structSize(idl, name) {
  const def = idl.types.find((x) => x.name === name);
  return def.type.fields.reduce((s, f) => s + typeSize(idl, f.type), 0);
}
function writePrim(buf, at, ty, v) {
  if (ty === 'pubkey') { new web3.PublicKey(v.toString()).toBuffer().copy(buf, at); return; }
  const n = BigInt(v.toString());
  const size = PRIM[ty];
  for (let i = 0; i < size; i++) buf[at + i] = Number((n >> BigInt(8 * i)) & 0xffn);
}
/** A Proxy over `buf` laid out as IDL type `name` (bytemuck, explicit padding) starting at `base`. */
export function byteView(idl, name, buf, base) {
  const def = idl.types.find((x) => x.name === name);
  const offsets = {};
  let at = base;
  for (const f of def.type.fields) { offsets[f.name] = [at, f.type]; at += typeSize(idl, f.type); }
  const view = (ty, off) => {
    if (typeof ty === 'string') return null;
    if (ty.defined) return byteView(idl, ty.defined.name, buf, off);
    if (ty.array) {
      const [inner, len] = ty.array;
      const sz = typeSize(idl, inner);
      return new Proxy({}, {
        get: (_, k) => view(inner, off + Number(k) * sz),
        set: (_, k, v) => { if (Number(k) >= len) throw new Error('index'); writePrim(buf, off + Number(k) * sz, inner, v); return true; },
      });
    }
    return null;
  };
  return new Proxy({}, {
    get: (_, k) => { const o = offsets[k]; if (!o) throw new Error(`no field ${String(k)} in ${name}`); return view(o[1], o[0]); },
    set: (_, k, v) => { const o = offsets[k]; if (!o) throw new Error(`no field ${String(k)} in ${name}`); writePrim(buf, o[0], o[1], v); return true; },
  });
}

function toKitIx(ix) {
  return { programAddress: address(ix.programAddress), accounts: ix.accounts.map((a) => ({ address: address(a.address), role: a.role })), data: ix.data };
}
function stringifyErr(e) {
  try { return JSON.stringify(e, (k, v) => (typeof v === 'bigint' ? v.toString() : v)); } catch { return String(e); }
}

/** Decode Anchor events ("Program data: ...") of our program and DBC from logs. */
export function parseEvents(logs) {
  const out = [];
  for (const l of logs) {
    const m = /^Program data: (.+)$/.exec(l);
    if (!m) continue;
    for (const idl of [IDL.launchpad]) {
      try {
        const e = coderFor(idl).events.decode(m[1]);
        if (e) { out.push(e); break; }
      } catch { /* not ours */ }
    }
  }
  return out;
}
export const eventsNamed = (res, name) => res.events.filter((e) => e.name === name);

// ---------------------------------------------------------------- Metaplex metadata
export function readMetadata(data) {
  const b = Buffer.from(data);
  let o = 1;
  const updateAuthority = readKey(b, o); o += 32;
  const mint = readKey(b, o); o += 32;
  const str = () => { const n = b.readUInt32LE(o); o += 4; const s = b.subarray(o, o + n).toString('utf8').replace(/\0+$/, ''); o += n; return s; };
  const name = str(); const symbol = str(); const uri = str();
  o += 2; // seller fee
  const hasCreators = b[o++];
  let creators = 0;
  if (hasCreators) { creators = b.readUInt32LE(o); o += 4 + creators * 34; }
  o += 1; // primary sale happened
  const isMutable = b[o] === 1;
  return { updateAuthority, mint, name, symbol, uri, creators, isMutable };
}

// ---------------------------------------------------------------- invariants (LAUNCHPAD-DESIGN.md section 15)
export function assertInvariants(w) {
  const lpProgram = address(PROGRAM_IDS.launchpad);
  const coinDisc = Buffer.from(IDL.launchpad.accounts.find((a) => a.name === 'Coin').discriminator);
  const accounts = w.svm.getProgramAccounts(lpProgram);
  const coins = accounts.filter((a) => Buffer.from(a.data).subarray(0, 8).equals(coinDisc));
  const lp = w.exists(P.launchpad()) ? w.launchpad() : null;
  for (const raw of coins) {
    const d = decodeAccount(IDL.launchpad, 'Coin', raw.data);
    const big = (x) => BigInt(x.toString());
    const coin = String(raw.address);
    const pot = w.balance(P.holdersPot(coin));
    const vault = w.balance(P.founderVault(coin));
    const ha = big(d.holders_accrued), hf = big(d.holders_forwarded), fa = big(d.founder_accrued);
    const fc = big(d.founder_claimed), fp = big(d.founder_paid_out);
    // 1, 2
    assert.ok(pot >= ha - hf, `inv1 ${coin}: pot ${pot} < ${ha} - ${hf}`);
    assert.ok(vault >= fa - fc - fp, `inv2 ${coin}: vault ${vault} < ${fa} - ${fc} - ${fp}`);
    // 3
    const n = BigInt(w.harvests.get(coin) ?? 0);
    assert.ok(fa <= ha && ha <= fa + n, `inv3 ${coin}: founder ${fa} holders ${ha} harvests ${n}`);
    // 4: base fees never arrive (only donations recorded by the test)
    const baseAcc = ata(coin, d.mint.toBase58());
    if (w.exists(baseAcc)) assert.equal(w.balance(baseAcc), w.baseDonations?.get(coin) ?? 0n, `inv4 ${coin}`);
    // 5
    const pool = w.pool(d.dbc_pool.toBase58());
    assert.equal(pool.creator, coin, 'inv5 creator');
    assert.equal(pool.config, d.dbc_config.toBase58(), 'inv5 config');
    assert.equal(pool.baseMint, d.mint.toBase58(), 'inv5 base mint');
    // 6
    const m = Buffer.from(w.account(d.mint.toBase58()).data);
    assert.equal(m.readUInt32LE(0), 0, 'inv6 mint authority');
    assert.equal(readU64(m, 36), SUPPLY, 'inv6 supply');
    assert.equal(m[44], 6, 'inv6 decimals');
    assert.equal(m.readUInt32LE(46), 0, 'inv6 freeze authority');
    const md = readMetadata(w.account(dbc.metadata(d.mint.toBase58())).data);
    assert.equal(md.isMutable, false, 'inv6 metadata immutable');
    // 7
    assert.equal(w.exists(P.approval(big(d.city_id))), false, 'inv7 approval and coin together');
    // 9 (before graduation; donations only add)
    if (pool.isMigrated === 0) {
      // surplus shares already paid out (each side once, after completion) left the vault
      const cfg = w.decodeConfig(d.dbc_config.toBase58());
      const sh = surplusShares(pool.quoteReserve, BigInt(cfg.migration_quote_threshold.toString()), BigInt(cfg.creator_trading_fee_percentage));
      const paid = (pool.isCreatorWithdrawSurplus ? sh.creator : 0n) + (pool.isPartnerWithdrawSurplus ? sh.partner : 0n) + (pool.isProtocolWithdrawSurplus ? sh.protocol : 0n);
      const qv = w.balance(pool.quoteVault);
      assert.ok(qv + paid >= pool.quoteReserve + pool.protocolQuoteFee + pool.partnerQuoteFee + pool.creatorQuoteFee, 'inv9 quote vault');
      assert.equal(pool.protocolBaseFee + pool.partnerBaseFee + pool.creatorBaseFee, 0n, 'inv9 no base fees');
      // 10
      const tokenAccounts = w.svm.getProgramAccounts(address(PROGRAM_IDS.token))
        .filter((a) => a.data.length >= 165 && readKey(a.data, 0) === d.mint.toBase58());
      const total = tokenAccounts.reduce((s, a) => s + readU64(a.data, 64), 0n);
      assert.equal(total, SUPPLY, 'inv10 all coins accounted for');
    }
  }
  // 12
  if (lp) {
    assert.equal(lp.rewards_program.toBase58(), PROGRAM_IDS.rewards, 'inv12 rewards program');
    const zero = PROGRAM_IDS.system;
    const pa = lp.payout_authority.toBase58(), pd = lp.payout_destination.toBase58(), admin = lp.admin.toBase58();
    if (pa !== zero) {
      assert.ok(pa !== admin && pa !== ADDRESSES.feeRecipient, 'inv12 payout key separate');
      assert.ok(pd !== pa && pd !== admin && pd !== ADDRESSES.feeRecipient, 'inv12 payout wallet separate');
    }
  }
  return coins.length;
}

// ---------------------------------------------------------------- invariant 8: where money may go
//
// LAUNCHPAD-DESIGN.md section 15, invariant 8, checked on every successful
// transaction of every test from the token instructions that actually ran
// (top level and inside CPIs), not from what the program says it did:
//   holders pot of a coin   -> that coin's founder vault (the founder's half in a harvest),
//                              or the derived vicinity_rewards vault of a config that passes
//                              the Holders-only / 0% founder / quote token / vault check;
//   founder vault of a coin -> ATA(coin.founder), or ATA(payout_destination) while an opt-in
//                              signed by the current founder agrees to that destination;
//   rewards vault of a Holders-only city -> only inside vicinity_rewards `claim`, to that
//                              claim's claimant_token_account.
// Any other transfer, or any approve, set-authority, burn, close, freeze or thaw on those
// accounts, fails the test. Zero-amount transfers move nothing and are ignored.
const TOKEN_PROGRAMS = new Set([PROGRAM_IDS.token, PROGRAM_IDS.token2022]);
const FORBIDDEN_TOKEN_IX = new Map([[4, 'Approve'], [5, 'Revoke'], [6, 'SetAuthority'], [8, 'Burn'], [9, 'CloseAccount'], [10, 'FreezeAccount'], [11, 'ThawAccount'], [13, 'ApproveChecked'], [15, 'BurnChecked']]);
const disc8 = (idl, kind, name) => Buffer.from(idl[kind].find((a) => a.name === name).discriminator);

/** The launchpad state that decides allowed destinations (read before and after each transaction). */
export function flowState(w) {
  const coinDisc = disc8(IDL.launchpad, 'accounts', 'Coin'), optDisc = disc8(IDL.launchpad, 'accounts', 'PayoutOptIn');
  const coins = [], optIns = new Map();
  for (const a of w.svm.getProgramAccounts(address(PROGRAM_IDS.launchpad))) {
    const d = Buffer.from(a.data);
    try {
      if (d.subarray(0, 8).equals(coinDisc)) {
        const c = decodeAccount(IDL.launchpad, 'Coin', d);
        coins.push({ address: String(a.address), founder: c.founder.toBase58(), mint: c.mint.toBase58(), quoteMint: c.quote_mint.toBase58() });
      } else if (d.subarray(0, 8).equals(optDisc)) {
        const o = decodeAccount(IDL.launchpad, 'PayoutOptIn', d);
        optIns.set(o.coin.toBase58(), { founder: o.founder.toBase58(), agreed: o.agreed_destination.toBase58() });
      }
    } catch { /* a forged or truncated account planted by an attack test: not a real coin */ }
  }
  const lp = w.exists(P.launchpad()) ? w.launchpad() : null;
  return { coins, optIns, payoutDestination: lp ? lp.payout_destination.toBase58() : null };
}

/** The program's own rewards-config rule (math.rs check_rewards_config) on raw bytes. */
export function rewardsConfigPasses(data, coin, vault) {
  const d = Buffer.from(data);
  return d.length >= 203 && d.subarray(0, 8).equals(disc8(IDL.rewards, 'accounts', 'CityConfig'))
    && readKey(d, 104) === coin.mint && readKey(d, 136) === coin.quoteMint && readKey(d, 168) === vault
    && d[200] === 1 && d.readUInt16LE(201) === 0;
}

/** Allowed (source -> destinations) and the Holders rewards vaults, from the given states. */
export function allowedFlows(w, states) {
  const allow = new Map();
  const holdersVaults = new Set();
  const add = (src, dst) => { if (!allow.has(src)) allow.set(src, new Set()); if (dst) allow.get(src).add(dst); };
  for (const st of states.filter(Boolean)) {
    for (const c of st.coins) {
      const pot = P.holdersPot(c.address), vault = P.founderVault(c.address);
      add(pot, vault);
      const cfg = R.city(c.mint), rv = R.vault(cfg), acc = w.account(cfg);
      if (acc && String(acc.programAddress) === PROGRAM_IDS.rewards && rewardsConfigPasses(acc.data, c, rv)) { add(pot, rv); holdersVaults.add(rv); }
      add(vault, ata(c.founder, c.quoteMint));
      const o = st.optIns.get(c.address);
      if (o && st.payoutDestination && st.payoutDestination !== PROGRAM_IDS.system && o.founder === c.founder && o.agreed === st.payoutDestination) add(vault, ata(st.payoutDestination, c.quoteMint));
    }
  }
  return { allow, holdersVaults };
}

/**
 * Check every token movement of one transaction. `messageBytes` is the
 * compiled message (no lookup tables in tests) and `inner` litesvm's inner
 * instructions per top-level instruction. Returns the watched movements.
 */
export function assertMoneyFlows(w, messageBytes, inner, states, label = 'tx') {
  const msg = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const keys = msg.staticAccounts.map(String);
  const top = msg.instructions.map((ix) => ({ program: keys[ix.programAddressIndex], accounts: (ix.accountIndices ?? []).map((i) => keys[i]), data: Buffer.from(ix.data ?? []) }));
  const moves = [];
  top.forEach((t, i) => {
    moves.push({ ...t, top: t });
    for (const ii of inner[i] ?? []) {
      const c = ii.instruction();
      moves.push({ program: keys[c.programIdIndex()], accounts: Array.from(c.accounts()).map((k) => keys[k]), data: Buffer.from(c.data()), top: t });
    }
  });
  return checkTokenMoves(allowedFlows(w, states), moves, label);
}

const CLAIM_DISC = disc8(IDL.rewards, 'instructions', 'claim');
const CLAIMANT_TOKEN_ACCOUNT_AT = IDL.rewards.instructions.find((i) => i.name === 'claim').accounts.findIndex((a) => a.name === 'claimant_token_account');

/** The rule itself, separated so a test can feed it forbidden movements directly. */
export function checkTokenMoves({ allow, holdersVaults }, moves, label = 'tx') {
  const seen = [];
  for (const m of moves) {
    if (!TOKEN_PROGRAMS.has(m.program) || m.data.length === 0) continue;
    const tag = m.data[0];
    const src = m.accounts[0];
    const watched = allow.has(src) || holdersVaults.has(src);
    if (!watched) continue;
    if (FORBIDDEN_TOKEN_IX.has(tag)) assert.fail(`${label}: ${FORBIDDEN_TOKEN_IX.get(tag)} on watched account ${src}`);
    if (tag !== 3 && tag !== 12) continue; // InitializeAccount, SyncNative and the like move nothing
    const dst = tag === 3 ? m.accounts[1] : m.accounts[2];
    const amount = m.data.readBigUInt64LE(1);
    if (amount === 0n) continue;
    if (holdersVaults.has(src)) {
      const inClaim = m.top.program === PROGRAM_IDS.rewards && m.top.data.subarray(0, 8).equals(CLAIM_DISC);
      assert.ok(inClaim && m.top.accounts[CLAIMANT_TOKEN_ACCOUNT_AT] === dst, `${label}: rewards vault ${src} paid ${amount} to ${dst} outside a holder's claim`);
    } else {
      assert.ok(allow.get(src).has(dst), `${label}: ${amount} moved from ${src} to ${dst}, which the design does not allow`);
    }
    seen.push({ label, source: src, destination: dst, amount });
  }
  return seen;
}

/** Permissionless DBC graduation of `coin` by `cranker` (fresh position NFT mints); returns the DAMM v2 pool and NFT mints. */
export async function graduate(w, coin, cranker, { cu = 400_000, label = 'migration_damm_v2' } = {}) {
  const n1 = await generateKeyPairSigner(), n2 = await generateKeyPairSigner();
  const ix = C.migrateToDammV2({ payer: cranker.address, dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, quoteMint: coin.quoteMint, firstNftMint: n1.address, secondNftMint: n2.address });
  const res = await w.send([ix], [cranker, n1, n2], label, { feePayer: cranker, cu });
  return { res, n1: n1.address, n2: n2.address, pool: damm.pool(ADDRESSES.dammCustomizableConfig, coin.mint, coin.quoteMint) };
}

/**
 * Trade `coin` back and forth `trades` times with three traders (deterministic
 * pseudo-random sizes), staying below the raise target. Every trade rounds in
 * the pool's favour, which is what builds DBC's completion surplus.
 */
export async function churn(w, coin, { trades = 200, seed = 1, stopBelow = 80n * LAMPORTS } = {}) {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const ts = [await w.signer(5_000n), await w.signer(5_000n), await w.signer(5_000n)];
  for (let k = 0; k < trades; k++) {
    const t = ts[k % 3];
    if (w.pool(coin.dbcPool).quoteReserve > stopBelow) break;
    const bal = w.exists(ata(t.address, coin.mint)) ? w.balance(ata(t.address, coin.mint)) : 0n;
    if (rnd() < 0.6 || bal < 10n) await w.trade(t, coin, { side: 'buy', amount0: BigInt(Math.floor(rnd() * 3e9)) + 1n, amount1: 1n, label: 'churn buy' });
    else await w.trade(t, coin, { side: 'sell', amount0: (bal * BigInt(Math.floor(rnd() * 100))) / 100n + 1n, amount1: 0n, label: 'churn sell' });
  }
  return ts;
}

/** Buy the rest of the curve with one partial-fill buy (it stops exactly at the graduation price). */
export async function completeCurve(w, coin, buyer) {
  buyer = buyer ?? await w.signer(500n);
  await w.trade(buyer, coin, { side: 'buy', mode: 1, amount0: 200n * LAMPORTS, amount1: 1n, label: 'partial fill to graduation' });
  return buyer;
}

// ---------------------------------------------------------------- keeper readers over the test VM
const bs58 = anchorPkg.utils.bytes.bs58;
const memcmpOk = (data, { offset, bytes }) => {
  const b = Buffer.from(typeof bytes === 'string' ? bs58.decode(bytes) : bytes);
  return data.length >= offset + b.length && Buffer.from(data.subarray(offset, offset + b.length)).equals(b);
};
/** The keeper's reader interface (sdk/launchpad/keeper.mjs) over the in-process VM. */
export function svmReader(w) {
  const toAcc = (addr, a) => ({ address: String(addr), owner: String(a.programAddress), lamports: BigInt(a.lamports), data: Buffer.from(a.data) });
  return {
    async getProgramAccounts(programId, { memcmp = [], dataSize } = {}) {
      return w.svm.getProgramAccounts(address(String(programId))).map((a) => toAcc(a.address, a))
        .filter((a) => (dataSize === undefined || a.data.length === dataSize) && memcmp.every((m) => memcmpOk(a.data, m)));
    },
    async getMultipleAccounts(addrs) { return addrs.map((x) => { const a = w.account(x); return a ? toAcc(x, a) : null; }); },
  };
}
/**
 * The @solana/web3.js `Connection` read methods the SDK uses, answered from
 * the in-process VM, so tests also run `connectionReader` (the code path of
 * scripts/launchpad/crank.mjs) including its RPC filter encoding.
 */
export function fakeConnection(w) {
  const info = (a) => ({ owner: new web3.PublicKey(String(a.programAddress)), lamports: Number(a.lamports), data: Buffer.from(a.data), executable: false });
  return {
    async getProgramAccounts(programId, { filters = [] } = {}) {
      return w.svm.getProgramAccounts(address(programId.toBase58()))
        .filter((a) => filters.every((f) => (f.dataSize !== undefined ? a.data.length === f.dataSize : memcmpOk(Buffer.from(a.data), f.memcmp))))
        .map((a) => ({ pubkey: new web3.PublicKey(String(a.address)), account: info(a) }));
    },
    async getMultipleAccountsInfo(keys) { return keys.map((k) => { const a = w.account(k.toBase58()); return a ? info(a) : null; }); },
    async getAccountInfo(k) { const a = w.account(k.toBase58()); return a ? info(a) : null; },
    async getSlot() { return Number(w.svm.getClock().slot); },
  };
}

/** Run a harvest and keep the invariant-3 counter in step. */
export async function harvest(w, coin, kind = 'curve', extra = {}) {
  const ix = kind === 'curve'
    ? C.harvestCurveFees({ payer: w.payer.address, coin, ...extra })
    : C.harvestPoolFees({ payer: w.payer.address, coin, ...extra });
  return w.send([ix], [], `harvest_${kind}_fees`);
}
