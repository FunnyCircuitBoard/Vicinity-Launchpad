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
  address, generateKeyPairSigner, lamports, pipe, createTransactionMessage,
  setTransactionMessageFeePayerSigner, appendTransactionMessageInstructions,
  signTransactionMessageWithSigners, addSignersToTransactionMessage,
  getBase64EncodedWireTransaction,
} from '@solana/kit';
import web3 from '@solana/web3.js';
import * as C from '../sdk/launchpad/client.mjs';
import { IDL, coderFor, decodeAccount, buildIx, Role } from '../sdk/launchpad/idl.mjs';
import { ADDRESSES, PROGRAM_IDS, ata, dbc, damm, pdas, programDataAddress, rewardsPdas } from '../sdk/launchpad/pda.mjs';
import { vicinityConfigParams, createConfigIx } from '../sdk/launchpad/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const solanaDir = join(here, '..');
export const P = pdas();
export const R = rewardsPdas();
export { C, IDL, ADDRESSES, PROGRAM_IDS, ata, dbc, damm, Role, buildIx, decodeAccount };

export const SUPPLY = 10n ** 15n;
export const LAMPORTS = 1_000_000_000n;
export const DAY = 86_400n;
const FIX = join(here, 'fixtures');

function programPath(name) {
  const p = join(FIX, 'programs', name);
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
  async initRewardsCity(coin, { model = { holders: {} }, founderBps = 0, rewardMint = coin.quoteMint, authority = this.admin, founder } = {}) {
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
      const qv = w.balance(pool.quoteVault);
      assert.ok(qv >= pool.quoteReserve + pool.protocolQuoteFee + pool.partnerQuoteFee + pool.creatorQuoteFee, 'inv9 quote vault');
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
      assert.ok(pd !== pa && pd !== admin, 'inv12 payout wallet separate');
    }
  }
  return coins.length;
}

/** Run a harvest and keep the invariant-3 counter in step. */
export async function harvest(w, coin, kind = 'curve', extra = {}) {
  const ix = kind === 'curve'
    ? C.harvestCurveFees({ payer: w.payer.address, coin, ...extra })
    : C.harvestPoolFees({ payer: w.payer.address, coin, ...extra });
  const res = await w.send([ix], [], `harvest_${kind}_fees`);
  const ev = eventsNamed(res, 'FeesHarvested');
  if (ev.length) w.harvests.set(coin.address, (w.harvests.get(coin.address) ?? 0) + 1);
  return res;
}
