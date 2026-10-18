// The SDK against the program's committed IDL (sdk/idl/vicinity_curve.json) and
// Anchor's own Borsh coder: every constant, discriminator and error code; the
// fixed account list of each of the 26 builders (names, order, signer and
// writable flags, the PDAs and fixed addresses they fill in); the argument
// encoding of each builder; the seven account decoders on accounts Anchor
// encodes; the event decoders on events Anchor encodes. The SDK itself does
// not read the IDL at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import anchorPkg from '@coral-xyz/anchor';
import web3 from '@solana/web3.js';
import * as S from './index.mjs';

const { BorshCoder, BN } = anchorPkg;
const here = dirname(fileURLToPath(import.meta.url));
const SOL = join(here, '..', '..');
const idl = JSON.parse(readFileSync(join(SOL, 'sdk', 'idl', 'vicinity_curve.json'), 'utf8'));
const coder = new BorshCoder(idl);
const sha8 = (s) => [...createHash('sha256').update(s).digest().subarray(0, 8)];
const key = () => web3.Keypair.generate().publicKey;
const rnd64 = () => BigInt(`0x${randomBytes(8).toString('hex')}`);
const rnd128 = () => BigInt(`0x${randomBytes(16).toString('hex')}`);
const rnd16 = () => randomBytes(2).readUInt16LE(0);
const bytes32 = () => [...randomBytes(32)];

test('program id, cluster ids, constants and discriminators equal the IDL and the math crate', () => {
  assert.equal(S.CURVE_PROGRAM_ID, idl.address);
  const c = Object.fromEntries(idl.constants.map((k) => [k.name, k.value]));
  const num = (n) => BigInt(c[n]);
  for (const [n, v] of Object.entries({
    COIN_SUPPLY: S.COIN_SUPPLY, BPS: S.BPS, MAX_TOTAL_FEE_BPS: S.MAX_TOTAL_FEE_BPS, MIN_TOTAL_FEE_BPS: S.MIN_TOTAL_FEE_BPS,
    MAX_PLATFORM_FEE_BPS: S.MAX_PLATFORM_FEE_BPS, MAX_FOUNDER_FEE_BPS: S.MAX_FOUNDER_FEE_BPS, MIN_TRADE_LAMPORTS: S.MIN_TRADE_LAMPORTS,
    BUYBACK_CAP_DIVISOR: S.BUYBACK_CAP_DIVISOR, BUYBACK_INTERVAL_SLOTS: S.BUYBACK_INTERVAL_SLOTS,
    BUYBACK_MIN_HORIZON_RUNS: S.BUYBACK_MIN_HORIZON_RUNS, BUYBACK_MIN_HORIZON_RUNS_FOUNDER: S.BUYBACK_MIN_HORIZON_RUNS_FOUNDER,
    MEV_MAX_PERCENT: S.MEV_MAX_PERCENT, MAX_DUST_RAW: S.MAX_DUST_RAW, MAX_VIRTUAL: S.MAX_VIRTUAL,
    MIN_GRADUATION_LAMPORTS: S.MIN_GRADUATION_LAMPORTS, MAX_GRADUATION_LAMPORTS: S.MAX_GRADUATION_LAMPORTS,
    CONTINUITY_PPB: S.CONTINUITY_PPB, MAX_LAUNCH_FEE_LAMPORTS: S.MAX_LAUNCH_FEE_LAMPORTS, APPROVAL_MAX_SECS: S.APPROVAL_MAX_SECS,
    PAYOUT_COOLDOWN_SECS: S.PAYOUT_COOLDOWN_SECS,
    // the batch launch approval (3.2)
    BATCH_REVIEW_SECS: S.BATCH_REVIEW_SECS, BATCH_MAX_LEAD_SECS: S.BATCH_MAX_LEAD_SECS, BATCH_MAX_VALIDITY_SECS: S.BATCH_MAX_VALIDITY_SECS,
    MAX_BATCH_LEAVES: BigInt(S.MAX_BATCH_LEAVES), MAX_BATCH_PROOF_LEN: BigInt(S.MAX_BATCH_PROOF_LEN), LAUNCH_LEAF_VERSION: BigInt(S.LAUNCH_LEAF_VERSION),
    MERKLE_LEAF_PREFIX: BigInt(S.MERKLE_LEAF_PREFIX), MERKLE_NODE_PREFIX: BigInt(S.MERKLE_NODE_PREFIX),
  })) assert.equal(num(n), v, n);
  assert.deepEqual(JSON.parse(c.LAUNCH_LEAF_TAG), [...Buffer.from(S.LAUNCH_LEAF_TAG)]);
  assert.equal(S.LAUNCH_LEAF_TAG.length, 26);
  assert.equal(Number(c.COIN_DECIMALS), S.COIN_DECIMALS);
  assert.equal(Number(c.MAX_NAME_LEN), S.MAX_NAME_LEN);
  assert.equal(Number(c.MAX_SYMBOL_LEN), S.MAX_SYMBOL_LEN);
  assert.equal(JSON.parse(c.METADATA_URI_PREFIX), S.METADATA_URI_PREFIX);
  assert.equal(c.FEE_RECIPIENT, S.ADDRESSES.feeRecipient);
  assert.equal(c.METAPLEX_PROGRAM_ID, S.ADDRESSES.metaplex);
  assert.equal(c.NATIVE_MINT, S.ADDRESSES.nativeMint);
  // the committed IDL is the default (mainnet ids) build's
  assert.equal(c.REWARDS_PROGRAM_ID, S.CLUSTERS.mainnet.rewardsProgram);
  assert.equal(c.LEGACY_PROGRAM_ID, S.CLUSTERS.mainnet.legacyProgram);
  assert.equal(c.LEGACY_LAUNCHPAD, S.CLUSTERS.mainnet.legacyLaunchpad);
  assert.deepEqual(JSON.parse(c.LEGACY_LAUNCHPAD_DISCRIMINATOR), [...S.LEGACY_LAUNCHPAD_DISCRIMINATOR]);
  assert.equal(Number(c.LEGACY_LAUNCHPAD_LEN), S.LEGACY_LAUNCHPAD_LEN);
  assert.equal(Number(c.LEGACY_LAUNCHES_PAUSED_AT), S.LEGACY_LAUNCHES_PAUSED_AT);
  assert.equal(Number(c.LEGACY_ADMIN_AT), S.LEGACY_ADMIN_AT);
  assert.equal(Number(c.LEGACY_PENDING_ADMIN_AT), S.LEGACY_PENDING_ADMIN_AT);
  // OPS-1: vicinity_rewards' registry
  assert.equal(c.REWARDS_REGISTRY, S.CLUSTERS.mainnet.rewardsRegistry);
  assert.deepEqual(JSON.parse(c.REWARDS_REGISTRY_DISCRIMINATOR), [...S.REWARDS_REGISTRY_DISCRIMINATOR]);
  assert.deepEqual([...S.REWARDS_REGISTRY_DISCRIMINATOR], sha8('account:Registry'));
  assert.equal(Number(c.REWARDS_REGISTRY_LEN), S.REWARDS_REGISTRY_LEN);
  assert.equal(Number(c.REWARDS_REGISTRY_ADMIN_AT), S.REWARDS_REGISTRY_ADMIN_AT);
  assert.equal(Number(c.REWARDS_REGISTRY_PENDING_ADMIN_AT), S.REWARDS_REGISTRY_PENDING_ADMIN_AT);
  for (const cl of ['mainnet', 'devnet']) {
    const ids = S.CLUSTERS[cl];
    assert.equal(S.findPda([Buffer.from('launchpad')], ids.legacyProgram)[0], ids.legacyLaunchpad, `${cl} LEGACY_LAUNCHPAD (U12)`);
    assert.equal(S.findPda([Buffer.from('registry')], ids.rewardsProgram)[0], ids.rewardsRegistry, `${cl} REWARDS_REGISTRY (U12)`);
    assert.equal(S.curvePdas({ cluster: cl }).rewardsRegistry(), ids.rewardsRegistry);
  }
  // discriminators
  // Anchor's EVENT_IX_TAG is sha256("anchor:event")[..8] read as a big-endian u64 and written little-endian
  assert.deepEqual([...S.EVENT_IX_TAG], sha8('anchor:event').reverse());
  for (const i of idl.instructions) {
    assert.deepEqual(S.INSTRUCTION_DISCRIMINATORS[i.name], i.discriminator, i.name);
    assert.deepEqual(i.discriminator, sha8(`global:${i.name}`));
  }
  assert.equal(Object.keys(S.INSTRUCTION_DISCRIMINATORS).length, 26);
  for (const a of idl.accounts) {
    assert.deepEqual(S.ACCOUNT_DISCRIMINATORS[a.name], a.discriminator, a.name);
    assert.deepEqual(a.discriminator, sha8(`account:${a.name}`));
  }
  assert.deepEqual(S.LEGACY_LAUNCHPAD_DISCRIMINATOR, sha8('account:Launchpad'));
  assert.deepEqual(S.REWARDS_CITY_CONFIG_DISCRIMINATOR, sha8('account:CityConfig'));
  for (const e of idl.events) {
    assert.deepEqual(S.EVENT_DISCRIMINATORS[e.name], e.discriminator, e.name);
    assert.deepEqual(e.discriminator, sha8(`event:${e.name}`));
  }
  assert.equal(Object.keys(S.EVENT_DISCRIMINATORS).length, 26);
  // errors
  assert.equal(idl.errors.length, S.ERROR_NAMES.length);
  for (const e of idl.errors) assert.equal(S.ERROR_CODES[e.name], e.code, e.name);
  assert.equal(S.errorName(6049), 'BuysHalted');
  assert.deepEqual([S.errorName(6054), S.errorName(6055)], ['BuybacksHalted', 'BuybackHaltWithoutBuyHalt']);
  assert.deepEqual([S.errorName(6058), S.errorName(6065), S.errorName(6070), S.errorName(6071)], ['LaunchApproverNotSet', 'BatchSuperseded', 'InvalidProof', 'ApprovalPending']);
  assert.equal(S.ERROR_NAMES.length, 72);
  // the math crate's PROGRAM_ID and CurveCoin discriminator (decode_coin)
  const rs = readFileSync(join(SOL, 'crates', 'vicinity-curve-math', 'src', 'constants.rs'), 'utf8');
  const grab = (name) => {
    const m = new RegExp(`pub const ${name}: \\[u8; \\d+\\] = \\[([^\\]]*)\\]`).exec(rs);
    return m[1].split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  };
  assert.deepEqual(grab('PROGRAM_ID'), [...new web3.PublicKey(S.CURVE_PROGRAM_ID).toBytes()]);
  assert.deepEqual(grab('CURVE_COIN_DISCRIMINATOR'), S.ACCOUNT_DISCRIMINATORS.CurveCoin);
});

// Sample arguments per instruction: [sdk builder args, Anchor args].
function samples() {
  const city = 5_128_581n;
  const k = {
    payer: key(), admin: key(), up: key(), guardian: key(), newAdmin: key(), founder: key(), user: key(), uta: key(),
    pa: key(), pd: key(), rentPayer: key(), newFounder: key(), by: key(), dest: key(), approver: key(),
  };
  const root = bytes32();
  const proof = [bytes32(), bytes32(), bytes32()];
  const meta = bytes32();
  const params = {
    liquidityBps: 50, platformBps: 70, founderBps: 50, holdersBps: 50, buybackBps: 30, virtualSol: 30_000_853_639n,
    virtualTokens: 1_073_025_598_486_615n, curveSupply: 793_099_990_000_000n, poolSupply: 206_900_000_900_000n,
    graduationSol: 85_000_000_000n, launchFeeLamports: 50_000_000n,
  };
  const P = {
    liquidity_bps: 50, platform_bps: 70, founder_bps: 50, holders_bps: 50, buyback_bps: 30, virtual_sol: new BN('30000853639'),
    virtual_tokens: new BN('1073025598486615'), curve_supply: new BN('793099990000000'), pool_supply: new BN('206900000900000'),
    graduation_sol: new BN('85000000000'), launch_fee_lamports: new BN('50000000'),
  };
  return {
    k,
    city,
    cases: {
      init_launchpad: [{ payer: k.payer, admin: k.admin, upgradeAuthority: k.up, guardian: k.guardian }, { guardian: k.guardian }],
      propose_admin: [{ admin: k.admin, newAdmin: k.newAdmin }, { new_admin: k.newAdmin }],
      accept_admin: [{ newAdmin: k.newAdmin }, {}],
      set_pause: [{ authority: k.admin, launches: true, payouts: null, buys: false, buybacks: true }, { launches: true, payouts: null, buys: false, buybacks: true }],
      set_guardian: [{ admin: k.admin, guardian: k.guardian }, { guardian: k.guardian }],
      set_payout_config: [{ admin: k.admin, payoutAuthority: k.pa, payoutDestination: k.pd }, { payout_authority: k.pa, payout_destination: k.pd }],
      add_launch_config: [{ admin: k.admin, payer: k.payer, configId: 3, params }, { p: P }],
      set_launch_config_enabled: [{ admin: k.admin, configId: 7, enabled: false }, { enabled: false }],
      approve_launch: [{ admin: k.admin, cityId: city, founder: k.founder, configId: 0, name: 'New York', symbol: 'NYC', metaHash: meta, expiresAt: 1_800_086_400n },
        { city_id: new BN(city.toString()), founder: k.founder, config_id: 0, name: 'New York', symbol: 'NYC', meta_hash: meta, expires_at: new BN('1800086400') }],
      revoke_approval: [{ by: k.by, cityId: city, rentPayer: k.rentPayer }, { city_id: new BN(city.toString()) }],
      launch: [{ founder: k.founder, payer: k.payer, cityId: city, configId: 0, symbol: 'NYC', rentPayer: k.rentPayer }, { city_id: new BN(city.toString()) }],
      buy: [{ user: k.user, cityId: city, userTokenAccount: k.uta, solIn: 1_000_000_000n, minTokensOut: 33n }, { sol_in: new BN('1000000000'), min_tokens_out: new BN(33) }],
      sell: [{ user: k.user, cityId: city, userTokenAccount: k.uta, tokensIn: 123_456n, minSolOut: 7n }, { tokens_in: new BN(123456), min_sol_out: new BN(7) }],
      buyback_burn: [{ cityId: city }, {}],
      withdraw_platform_fees: [{ cityId: city }, {}],
      forward_holders_fees: [{ cityId: city }, {}],
      claim_founder_fees: [{ founder: k.founder, cityId: city }, {}],
      transfer_founder: [{ founder: k.founder, newFounder: k.newFounder, cityId: city }, {}],
      opt_in_payout: [{ founder: k.founder, cityId: city, expectedDestination: k.dest, refHash: meta }, { expected_destination: k.dest, ref_hash: meta }],
      revoke_payout_opt_in: [{ by: k.by, cityId: city, optInFounder: k.founder }, {}],
      payout_founder_fees: [{ payoutAuthority: k.pa, cityId: city, destination: k.dest }, {}],
      init_launch_batch: [{ admin: k.admin, payer: k.payer }, {}],
      set_launch_approver: [{ admin: k.admin, approver: k.approver }, { approver: k.approver }],
      publish_launch_batch: [{ approver: k.approver, seq: 7n, root, leafCount: 512, validFrom: 1_800_043_200n, validUntil: 1_800_172_800n },
        { seq: new BN(7), root, leaf_count: 512, valid_from: new BN('1800043200'), valid_until: new BN('1800172800') }],
      clear_launch_batch: [{ authority: k.guardian, halt: true }, { halt: true }],
      launch_from_batch: [{ founder: k.founder, payer: k.payer, cityId: city, batchSeq: 7n, configId: 0, name: 'New York', symbol: 'NYC', metaHash: meta, proof },
        { city_id: new BN(city.toString()), batch_seq: new BN(7), config_id: 0, name: 'New York', symbol: 'NYC', meta_hash: meta, proof }],
    },
  };
}
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

test('every builder: the account list of section 4 (names, order, flags) and the IDL argument encoding', () => {
  const { k, city, cases } = samples();
  assert.equal(Object.keys(cases).length, 26);
  assert.deepEqual(Object.keys(S.ACCOUNT_TABLES).sort(), idl.instructions.map((i) => i.name).sort());
  const P = S.curvePdas();
  const { coin, mint, vault } = P.coinAccounts(city);
  const rewards = P.rewardsAccounts(mint);
  const expectAt = {
    program_data: P.programData(), launchpad: P.launchpad(), approval: P.approval(city), ticker_lock: P.ticker('NYC'),
    legacy_coin: P.legacyCoin(city), legacy_approval: P.legacyApproval(city), legacy_launchpad: S.CLUSTERS.mainnet.legacyLaunchpad, rewards_registry: S.CLUSTERS.mainnet.rewardsRegistry,
    metadata: S.metadataAddress(mint), fee_recipient: S.ADDRESSES.feeRecipient, metadata_program: S.ADDRESSES.metaplex,
    token_program: S.ADDRESSES.token, system_program: S.ADDRESSES.system, rent: S.ADDRESSES.rentSysvar,
    event_authority: P.eventAuthority(), program: S.CURVE_PROGRAM_ID, mint, coin_vault: vault, rewards_city_config: rewards.config,
    rewards_vault: rewards.vault, opt_in: P.payoutOptIn(coin), user_token_account: k.uta.toBase58(), launch_batch: P.launchBatch(),
  };
  for (const def of idl.instructions) {
    const [args, anchorArgs] = cases[def.name];
    const built = S.ix[camel(def.name)](args);
    assert.equal(built.programAddress, S.CURVE_PROGRAM_ID);
    assert.deepEqual(S.ACCOUNT_TABLES[def.name].map(([n]) => n), def.accounts.map((a) => a.name), `${def.name} account names`);
    assert.equal(built.accounts.length, def.accounts.length, def.name);
    def.accounts.forEach((a, i) => {
      const role = (a.writable ? 1 : 0) | (a.signer ? 2 : 0);
      assert.equal(built.accounts[i].role, role, `${def.name}.${a.name} flags`);
      if (a.address) assert.equal(built.accounts[i].address, a.address, `${def.name}.${a.name} fixed address`);
      const want = a.name === 'coin' ? coin : a.name === 'config' ? P.config(args.configId) : expectAt[a.name];
      if (want !== undefined && !(def.name === 'approve_launch' && a.name === 'coin')) assert.equal(built.accounts[i].address, want, `${def.name}.${a.name}`);
    });
    const data = coder.instruction.encode(def.name, anchorArgs);
    assert.deepEqual([...built.data], [...data], `${def.name} data`);
  }
  // the batch launch: the city's (empty) approval PDA, the config named in the call, the call's ticker
  const lfb = S.ix.launchFromBatch(cases.launch_from_batch[0]);
  assert.equal(lfb.accounts[4].address, P.approval(city));
  assert.equal(lfb.accounts[5].address, P.config(0));
  assert.equal(lfb.accounts[9].address, P.ticker('NYC'));
  assert.equal(S.ACCOUNT_TABLES.launch_from_batch.length, S.ACCOUNT_TABLES.launch.length, '4.27: the same 22 accounts as launch');
  assert.equal(P.launchBatch(), S.findPda([Buffer.from('launch_batch')], S.CURVE_PROGRAM_ID)[0]);
  // approve_launch's coin slot is the city's Coin PDA too
  assert.equal(S.ix.approveLaunch(cases.approve_launch[0]).accounts[4].address, coin);
  // buy and sell share one list of 10 accounts
  assert.deepEqual(S.ACCOUNT_TABLES.buy, S.ACCOUNT_TABLES.sell);
  assert.equal(S.ACCOUNT_TABLES.buy.length, 10);
  // the user's associated token account by default
  const b = S.ix.buy({ user: k.user, cityId: city, solIn: 100_000n, minTokensOut: 0n });
  assert.equal(b.accounts[5].address, S.associatedTokenAddress(k.user, mint));
  // the devnet build's legacy ids
  const dv = S.curveInstructions({ cluster: 'devnet' }).approveLaunch(cases.approve_launch[0]);
  assert.equal(dv.accounts[8].address, S.CLUSTERS.devnet.legacyLaunchpad);
  assert.equal(dv.accounts[9].address, S.CLUSTERS.devnet.rewardsRegistry);
  // overrides put another account into a slot
  const o = S.ix.buy({ ...cases.buy[0], overrides: { mint: k.payer, coin_vault: { address: k.admin, role: S.Role.R } } });
  assert.equal(o.accounts[3].address, k.payer.toBase58());
  assert.deepEqual(o.accounts[4], { address: k.admin.toBase58(), role: 0 });
  // forward plus the top-level SyncNative of 4.15
  const [f, sync] = S.ix.forwardHoldersFeesWithSync({ cityId: city });
  assert.equal(f.accounts[3].address, rewards.vault);
  assert.deepEqual(sync, { programAddress: S.ADDRESSES.token, accounts: [{ address: rewards.vault, role: 1 }], data: Uint8Array.of(17) });
  // missing accounts and arguments are refused
  assert.throws(() => S.ix.buy({ cityId: city, solIn: 1n, minTokensOut: 0n }), /user/);
  assert.throws(() => S.ix.withdrawPlatformFees({}), /coin or cityId/);
  assert.throws(() => S.ix.setLaunchConfigEnabled({ admin: k.admin, configId: 0, enabled: 'yes' }), TypeError);
});

/** Offsets of an IDL struct's fields (Borsh, fixed types only). */
function idlOffsets(name) {
  const def = idl.types.find((t) => t.name === name).type.fields;
  const size = (t) => (typeof t === 'string' ? { u8: 1, bool: 1, u16: 2, u32: 4, u64: 8, i64: 8, u128: 16, pubkey: 32 }[t]
    : t.defined ? idl.types.find((x) => x.name === t.defined.name).type.fields.reduce((n, f) => n + size(f.type), 0) : t.array[1] * size(t.array[0]));
  const out = {};
  let at = 8;
  for (const f of def) { out[f.name] = at; at += size(f.type); }
  return { out, end: at };
}

test('account decoders equal Anchor decoding; owner, length and discriminator are checked', () => {
  // CurveCoin offsets of 3.7 equal the IDL layout
  const { out: offs, end } = idlOffsets('CurveCoin');
  assert.equal(end, S.ACCOUNT_LEN.CurveCoin);
  for (const [f, at] of Object.entries(offs)) {
    const camelName = f === '_reserved' ? 'reserved' : camel(f);
    assert.equal(S.COIN_OFFSETS[camelName], at, `CurveCoin.${f}`);
  }
  assert.equal(idlOffsets('Launchpad').end, S.ACCOUNT_LEN.Launchpad);
  assert.equal(idlOffsets('LaunchConfig').end, S.ACCOUNT_LEN.LaunchConfig);
  assert.equal(idlOffsets('TickerLock').end, S.ACCOUNT_LEN.TickerLock);
  assert.equal(idlOffsets('PayoutOptIn').end, S.ACCOUNT_LEN.PayoutOptIn);
  assert.equal(idlOffsets('LaunchBatch').end, S.ACCOUNT_LEN.LaunchBatch);
  assert.deepEqual(idlOffsets('LaunchBatch').out, { bump: 8, halted: 9, latest: 10, previous: 119, _reserved: 228 });
  assert.equal(idlOffsets('Launchpad').out.launch_approver, 175);

  const owner = S.CURVE_PROGRAM_ID;
  const enc = async (name, obj, len) => {
    const b = await coder.accounts.encode(name, obj);
    const full = Buffer.alloc(len ?? b.length); b.copy(full);
    return { owner, data: full };
  };
  const check = (decoded, obj, map = {}) => {
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      const got = decoded[map[k] ?? camel(k)];
      if (v instanceof web3.PublicKey) assert.equal(got, v.toBase58(), k);
      else if (BN.isBN(v)) assert.equal(BigInt(got), BigInt(v.toString()), k);
      else if (Array.isArray(v)) assert.deepEqual([...got], v, k);
      else if (typeof v === 'number' && typeof got === 'bigint') assert.equal(got, BigInt(v), k);
      else assert.equal(got, v, k);
    }
  };
  return (async () => {
    for (let round = 0; round < 25; round++) {
      const lp = {
        admin: key(), pending_admin: key(), payout_authority: key(), payout_destination: key(), guardian: key(), launches_paused: round % 2 === 0,
        payouts_paused: round % 3 === 0, buys_halted: round % 5 === 0, next_config_id: rnd16(), bump: round, buybacks_halted: round % 10 === 0,
        launch_approver: key(), _reserved: Array(31).fill(0),
      };
      check(S.decodeLaunchpad(await enc('Launchpad', lp)), lp);
      const rec = () => ({
        seq: new BN(rnd64().toString()), root: bytes32(), leaf_count: randomBytes(4).readUInt32LE(0), valid_from: new BN(String(BigInt.asIntN(64, rnd64()))),
        valid_until: new BN(String(BigInt.asIntN(64, rnd64()))), published_at: new BN(1_800_000_000 + round), published_slot: new BN(rnd64().toString()),
        publisher: key(), cleared: round % 2 === 0,
      });
      const lbObj = { bump: round, halted: round % 3 === 1, latest: rec(), previous: rec(), _reserved: Array(32).fill(0) };
      const lbAcc = await enc('LaunchBatch', lbObj);
      const lb = S.decodeLaunchBatch(lbAcc);
      assert.equal(lb.bump, lbObj.bump); assert.equal(lb.halted, lbObj.halted);
      for (const which of ['latest', 'previous']) check(lb[which], lbObj[which]);
      assert.equal(S.decodeAny(lbAcc).type, 'LaunchBatch');
      const cfg = {
        config_id: rnd16(), enabled: round % 2 === 1, bump: 255 - round, liquidity_bps: rnd16(), platform_bps: rnd16(), founder_bps: rnd16(),
        holders_bps: rnd16(), buyback_bps: rnd16(), total_fee_bps: rnd16(), virtual_sol: new BN(rnd64().toString()),
        virtual_tokens: new BN(rnd64().toString()), curve_supply: new BN(rnd64().toString()), pool_supply: new BN(rnd64().toString()),
        graduation_sol: new BN(rnd64().toString()), launch_fee_lamports: new BN(rnd64().toString()), created_at: new BN(-12345 + round), _reserved: Array(64).fill(0),
      };
      check(S.decodeLaunchConfig(await enc('LaunchConfig', cfg)), cfg);
      const names = ['A', 'New York', 'São Paulo', 'x'.repeat(32)];
      const ap = {
        city_id: new BN(rnd64().toString()), founder: key(), config_id: rnd16(), rent_payer: key(), meta_hash: bytes32(),
        name: names[round % names.length], symbol: ['NYC', 'A', 'ABCDEFGHIJ', 'SP0'][round % 4], approved_at: new BN(1_800_000_000 + round),
        expires_at: new BN(1_800_086_400 + round), bump: round,
      };
      check(S.decodeApproval(await enc('Approval', ap, S.ACCOUNT_LEN.Approval)), ap);
      const coinObj = {
        layout_version: 1, phase: round % 2, bump: round, mint_bump: 200, vault_bump: 201, config_id: rnd16(), city_id: new BN(rnd64().toString()),
        mint: key(), vault: key(), founder: key(), symbol: [...Buffer.from('NYC'), 0, 0, 0, 0, 0, 0, 0],
      };
      const u64f = ['virtual_sol', 'virtual_tokens', 'curve_supply', 'pool_supply', 'graduation_sol', 'dust_burned', 'tokens_sold', 'curve_sol', 'pool_sol',
        'pool_tokens', 'liquidity_pending', 'platform_pending', 'founder_pending', 'holders_pending', 'buyback_pending', 'launch_slot', 'graduation_slot',
        'last_buyback_slot', 'payout_seq', 'trade_seq', 'buyback_count', 'tokens_burned', 'rent_reserve'];
      const i64f = ['launched_at', 'graduated_at', 'last_payout_at'];
      const u128f = ['buy_volume', 'sell_volume', 'fees_total', 'liquidity_earned', 'liquidity_added', 'platform_earned', 'platform_withdrawn', 'founder_earned',
        'founder_claimed', 'founder_paid_out', 'holders_earned', 'holders_forwarded', 'buyback_earned', 'buyback_spent'];
      for (const f of ['liquidity_bps', 'platform_bps', 'founder_bps', 'holders_bps', 'buyback_bps', 'total_fee_bps']) coinObj[f] = rnd16();
      for (const f of u64f) coinObj[f] = new BN(rnd64().toString());
      for (const f of i64f) coinObj[f] = new BN(String(BigInt.asIntN(64, rnd64())));
      for (const f of u128f) coinObj[f] = new BN(rnd128().toString());
      coinObj.meta_hash = bytes32();
      coinObj._reserved = Array(88).fill(0);
      const coinAcc = await enc('CurveCoin', coinObj);
      const d = S.decodeCurveCoin(coinAcc);
      check(d, coinObj, { symbol: 'symbolBytes' });
      assert.equal(d.symbol, 'NYC');
      // the decoded coin feeds the math port
      assert.equal(S.coinTerms(d).virtualSol, BigInt(coinObj.virtual_sol.toString()));
      assert.equal(S.coinState(d).buybackSpent, BigInt(coinObj.buyback_spent.toString()));
      const tl = { city_id: new BN(rnd64().toString()), mint: key(), bump: round };
      check(S.decodeTickerLock(await enc('TickerLock', tl)), tl);
      const oi = { coin: key(), founder: key(), agreed_destination: key(), ref_hash: bytes32(), opted_in_at: new BN(1_800_000_000), bump: round };
      check(S.decodePayoutOptIn(await enc('PayoutOptIn', oi)), oi);
      assert.equal(S.decodeAny(coinAcc).type, 'CurveCoin');
    }
    // refusals: owner, length, discriminator, layout version, phase
    const good = await enc('TickerLock', { city_id: new BN(1), mint: key(), bump: 1 });
    assert.throws(() => S.decodeTickerLock({ ...good, owner: S.CLUSTERS.mainnet.legacyProgram }), (e) => e.code === 'WrongOwner');
    assert.throws(() => S.decodeTickerLock({ ...good, data: good.data.subarray(0, 48) }), (e) => e.code === 'WrongLength');
    const bad = Buffer.from(good.data); bad[0] ^= 1;
    assert.throws(() => S.decodeTickerLock({ owner, data: bad }), (e) => e.code === 'WrongDiscriminator');
    const lpBytes = await enc('Launchpad', {
      admin: key(), pending_admin: key(), payout_authority: key(), payout_destination: key(), guardian: key(), launches_paused: false,
      payouts_paused: false, buys_halted: false, next_config_id: 0, bump: 1, buybacks_halted: false, launch_approver: key(), _reserved: Array(31).fill(0),
    });
    // the old program's Launchpad has the same discriminator: the owner tells them apart (3.7)
    assert.throws(() => S.decodeLaunchpad({ owner: S.CLUSTERS.mainnet.legacyProgram, data: lpBytes.data }), (e) => e.code === 'WrongOwner');
    assert.throws(() => S.decodeLaunchpad({ ...lpBytes, owner: 'Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi' }), (e) => e.code === 'WrongOwner');
    assert.doesNotThrow(() => S.decodeLaunchpad(lpBytes, { programId: owner }));
    assert.throws(() => S.decodeLaunchpad(lpBytes, { programId: S.CLUSTERS.devnet.legacyProgram }), (e) => e.code === 'WrongOwner');
    const coinBytes = Buffer.alloc(693); Buffer.from(S.ACCOUNT_DISCRIMINATORS.CurveCoin).copy(coinBytes); coinBytes[8] = 2;
    assert.throws(() => S.decodeCurveCoin({ owner, data: coinBytes }), (e) => e.code === 'WrongLayoutVersion');
    coinBytes[8] = 1; coinBytes[9] = 2;
    assert.throws(() => S.decodeCurveCoin({ owner, data: coinBytes }), (e) => e.code === 'InvalidPhase');
    // the old program's Coin bytes (discriminator sha256("account:Coin")) are not a CurveCoin
    const oldCoin = Buffer.alloc(693); Buffer.from(sha8('account:Coin')).copy(oldCoin); oldCoin[8] = 1;
    assert.throws(() => S.decodeCurveCoin({ owner, data: oldCoin }), (e) => e.code === 'WrongDiscriminator');
    assert.equal(S.accountType({ owner, data: oldCoin }), null);
  })();
});

test('event decoders equal Anchor encoding for all 26 events; event CPIs need the event authority', () => {
  const types = Object.fromEntries(idl.types.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(S.EVENT_FIELDS).sort(), idl.events.map((e) => e.name).sort());
  const tmap = (t) => (typeof t === 'string' ? t : t.array ? 'bytes32' : JSON.stringify(t));
  for (const e of idl.events) {
    assert.deepEqual(S.EVENT_FIELDS[e.name], types[e.name].type.fields.map((f) => [f.name, tmap(f.type)]), e.name);
  }
  const sample = (type) => ({
    u8: 3, bool: true, u16: rnd16(), u32: randomBytes(4).readUInt32LE(0), u64: new BN(rnd64().toString()), i64: new BN(-7), u128: new BN(rnd128().toString()),
    pubkey: key(), string: 'Zürich', bytes32: bytes32(),
  })[type];
  for (const [name, fields] of Object.entries(S.EVENT_FIELDS)) {
    const obj = Object.fromEntries(fields.map(([f, t]) => [f, sample(t)]));
    const body = coder.types.encode(name, obj);
    const bytes = Buffer.concat([Buffer.from(S.EVENT_DISCRIMINATORS[name]), body]);
    const dec = S.decodeEventBytes(bytes);
    assert.equal(dec.name, name);
    for (const [f, t] of fields) {
      const v = obj[f]; const got = dec.data[f];
      if (t === 'pubkey') assert.equal(got, v.toBase58());
      else if (BN.isBN(v)) assert.equal(BigInt(got), BigInt(v.toString()), `${name}.${f}`);
      else if (t === 'bytes32') assert.deepEqual([...got], v);
      else if (t === 'u16' || t === 'u32') assert.equal(got, BigInt(v));
      else assert.equal(got, v, `${name}.${f}`);
    }
    // the same bytes decoded by Anchor
    const viaAnchor = coder.events.decode(bytes.toString('base64'));
    assert.equal(viaAnchor.name, name);
    // event CPI: only from vicinity_curve with the event authority as its single account
    const cpiData = Buffer.concat([Buffer.from(S.EVENT_IX_TAG), bytes]);
    const ea = S.curvePdas().eventAuthority();
    assert.equal(S.decodeEventCpi({ programId: S.CURVE_PROGRAM_ID, accounts: [ea], data: cpiData }).name, name);
    assert.equal(S.decodeEventCpi({ programId: S.CURVE_PROGRAM_ID, accounts: [key().toBase58()], data: cpiData }), null);
    assert.equal(S.decodeEventCpi({ programId: S.CLUSTERS.mainnet.legacyProgram, accounts: [ea], data: cpiData }), null);
    assert.equal(S.decodeEventCpi({ programId: S.CURVE_PROGRAM_ID, accounts: [ea], data: bytes }), null);
  }
  assert.equal(S.CPI_EVENTS.length, 9);
  // emit! logs: only from vicinity_curve's own frames
  const pc = Buffer.concat([Buffer.from(S.EVENT_DISCRIMINATORS.ApprovalRevoked), coder.types.encode('ApprovalRevoked', { city_id: new BN(9), by: key() })]).toString('base64');
  const logs = [`Program ${S.CURVE_PROGRAM_ID} invoke [1]`, `Program data: ${pc}`, `Program ${S.ADDRESSES.token} invoke [2]`, `Program data: ${pc}`,
    `Program ${S.ADDRESSES.token} success`, `Program ${S.CURVE_PROGRAM_ID} success`];
  const got = S.decodeEventLogs(logs);
  assert.equal(got.length, 1);
  assert.equal(got[0].data.city_id, 9n);
});
