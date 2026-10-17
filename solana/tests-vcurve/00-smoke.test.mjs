// Stage 2 smoke test of vicinity_curve in litesvm (VICINITY-CURVE-DESIGN.md
// 4.10 to 4.20, 5.14, 6.5, 8.3; NOTES entries 20 and 21). One coin's life on the
// production build with default config #0: launch, the worked examples E1 to E3
// to the lamport and raw unit, a pool buy, a buyback, every outflow (withdraw,
// claim, forward with a top-level SyncNative, opted-in payout), the guardian
// halt; then the halt-all build deployed over the live state, where all eight
// outflow instructions refuse with TradingHalted and nothing changes, and the
// production build deployed back. I9 (the Coin holds exactly its rent plus its
// liabilities) is checked after every outflow. The full litesvm suites of
// section 12 (L, X, H, R) are stage 3.
//
// Needs: npm run vcurve:sbf (target/vcurve-builds/{production,halt-all}) and the
// Metaplex dump (npm run launchpad:fixtures, or VCURVE_METAPLEX_SO=<path>).
// Run: npm run test:vcurve
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { LiteSVM } from 'litesvm';
import {
  address, generateKeyPairSigner, lamports, pipe, createTransactionMessage,
  setTransactionMessageFeePayerSigner, appendTransactionMessageInstructions,
  signTransactionMessageWithSigners, addSignersToTransactionMessage,
} from '@solana/kit';
import web3 from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';

const { BorshCoder, BN } = anchorPkg;
const SOL = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROD = join(SOL, 'target', 'vcurve-builds', 'production', 'vicinity_curve.so');
const HALT = join(SOL, 'target', 'vcurve-builds', 'halt-all', 'vicinity_curve.so');
const META = process.env.VCURVE_METAPLEX_SO || join(SOL, 'tests-launchpad', 'fixtures', 'programs', 'mpl_token_metadata.so');
for (const [p, how] of [[PROD, 'npm run vcurve:sbf'], [HALT, 'npm run vcurve:sbf'], [META, 'npm run launchpad:fixtures']]) {
  if (!existsSync(p)) throw new Error(`missing ${p}: run "${how}" first`);
}
const idl = JSON.parse(readFileSync(`${SOL}/sdk/idl/vicinity_curve.json`, 'utf8'));
const coder = new BorshCoder(idl);

const PK = (s) => new web3.PublicKey(s);
const CURVE = PK(idl.address);
const IDS = {
  metaplex: PK('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
  legacy: PK('AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai'),
  legacyLaunchpad: PK('4g9KRZ76Mpw6HCCu713yEGzm1txdCod3S1SugL7M9GwN'),
  rewards: PK('EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG'),
  fee: PK('13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN'),
  token: PK('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  system: PK('11111111111111111111111111111111'),
  rent: PK('SysvarRent111111111111111111111111111111111'),
  loader: PK('BPFLoaderUpgradeab1e11111111111111111111111'),
  wsol: PK('So11111111111111111111111111111111111111112'),
};
const pda = (seeds, prog = CURVE) => web3.PublicKey.findProgramAddressSync(seeds, prog)[0];
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

const log = (...a) => { if (process.env.VCURVE_VERBOSE) console.log(...a); };
const svm = new LiteSVM();
svm.addProgramFromFile(address(IDS.metaplex.toBase58()), META);
const loadCurve = (path) => {
  svm.addProgramFromFile(address(CURVE.toBase58()), path);
};
loadCurve(PROD);

async function signer(sol = 1000n) {
  const s = await generateKeyPairSigner();
  svm.airdrop(s.address, lamports(sol * 1_000_000_000n));
  return s;
}
function setRaw(addr, data, owner, lam) {
  const d = new Uint8Array(data);
  svm.setAccount({
    address: address(addr.toBase58()), lamports: lamports(lam ?? svm.minimumBalanceForRentExemption(BigInt(d.length))),
    programAddress: address(owner.toBase58()), executable: false, data: d, space: BigInt(d.length),
  });
}
const acct = (pk) => { const a = svm.getAccount(address(pk.toBase58())); return a.exists ? a : null; };
const lam = (pk) => { const a = acct(pk); return a ? BigInt(a.lamports) : 0n; };
const tokenAmount = (pk) => Buffer.from(acct(pk).data).readBigUInt64LE(64);
const decode = (name, pk) => coder.accounts.decode(name, Buffer.from(acct(pk).data));

function ix(name, args, accounts) {
  const def = idl.instructions.find((i) => i.name === name);
  const metas = def.accounts.map((a) => {
    const v = accounts[a.name];
    if (!v) throw new Error(`${name}: account ${a.name}`);
    return { address: address(v.toBase58 ? v.toBase58() : String(v)), role: (a.writable ? 1 : 0) | (a.signer ? 2 : 0) };
  });
  return { programAddress: address(CURVE.toBase58()), accounts: metas, data: coder.instruction.encode(name, args) };
}
const EVENT_AUTH = pda([Buffer.from('__event_authority')]);
const ev = { event_authority: EVENT_AUTH, program: CURVE };
const EVENT_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

let feePayer;
async function send(ixs, signers, label) {
  const all = [feePayer, ...signers.filter((s) => s.address !== feePayer.address)];
  const budget = { programAddress: address('ComputeBudget111111111111111111111111111111'), accounts: [], data: new Uint8Array([2, ...u32(1_400_000)]) };
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions([budget, ...ixs], m),
    (m) => addSignersToTransactionMessage(all, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (typeof res.err === 'function') {
    const logs = res.meta().logs();
    const e = new Error(`${label} failed: ${JSON.stringify(res.err(), (k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n  ${logs.slice(-6).join('\n  ')}`);
    e.logs = logs;
    throw e;
  }
  // event CPIs: inner instructions to this program starting with the event tag
  const events = [];
  for (const group of res.innerInstructions()) {
    for (const ii of group) {
      const d = Buffer.from(ii.instruction().data());
      if (d.length >= 16 && d.subarray(0, 8).equals(EVENT_TAG)) {
        events.push(coder.events.decode(d.subarray(8).toString('base64')));
      }
    }
  }
  for (const l of res.logs()) {
    const m = /^Program data: (.+)$/.exec(l);
    if (m) { try { const e = coder.events.decode(m[1]); if (e) events.push({ ...e, log: true }); } catch { /* not ours */ } }
  }
  return { events, cu: Number(res.computeUnitsConsumed()) };
}
async function fails(fn, code) {
  try { await fn(); } catch (e) {
    const text = (e.logs ?? []).join('\n') + e.message;
    assert.ok(text.includes(code), `expected ${code}, got ${e.message}`);
    return;
  }
  throw new Error(`expected ${code}, but it succeeded`);
}
const warpSlots = (n) => { const c = svm.getClock(); c.slot += BigInt(n); c.unixTimestamp += BigInt(n); svm.setClock(c); };
const warpSecs = (n) => { const c = svm.getClock(); c.unixTimestamp += BigInt(n); c.slot += 1n; svm.setClock(c); };

test('vicinity_curve smoke: one coin, every outflow, guardian halt, halt-all over live state', async () => {
  // ---------------------------------------------------------------- setup
  const deployer = await signer();
  const admin = await signer();
  const guardian = await signer();
  const founder = await signer();
  const buyer = await signer(2000n);
  const payoutKey = await signer();
  const payoutWallet = await signer(1n);
  feePayer = await signer();
  svm.airdrop(address(IDS.fee.toBase58()), lamports(1_000_000_000n));
  { // the upgradeable program's ProgramData: set the upgrade authority
    const pd = pda([CURVE.toBuffer()], IDS.loader);
    const a = svm.getAccount(address(pd.toBase58()));
    const d = Buffer.from(a.data); d[12] = 1; PK(deployer.address).toBuffer().copy(d, 13);
    svm.setAccount({ ...a, address: address(pd.toBase58()), data: new Uint8Array(d) });
  }
  { // the old program's Launchpad, launches paused, administered by this program's admin (8.4, 8.5)
    const d = Buffer.alloc(171); Buffer.from([247, 20, 16, 242, 203, 38, 169, 160]).copy(d, 0); d[168] = 1;
    PK(admin.address).toBuffer().copy(d, 8);
    setRaw(IDS.legacyLaunchpad, d, IDS.legacy);
  }
  const c0 = svm.getClock(); c0.unixTimestamp = 1_800_000_000n; c0.slot = 1000n; svm.setClock(c0);

  const LAUNCHPAD = pda([Buffer.from('launchpad')]);
  const CONFIG0 = pda([Buffer.from('config'), u16(0)]);
  const CITY = 5_128_581n;
  const COIN = pda([Buffer.from('coin'), u64(CITY)]);
  const MINT = pda([Buffer.from('mint'), COIN.toBuffer()]);
  const VAULT = pda([Buffer.from('coin_vault'), COIN.toBuffer()]);
  const APPROVAL = pda([Buffer.from('approval'), u64(CITY)]);
  const TICKER = pda([Buffer.from('ticker'), Buffer.from('NYC')]);
  const METADATA = pda([Buffer.from('metadata'), IDS.metaplex.toBuffer(), MINT.toBuffer()], IDS.metaplex);
  const LEGACY_COIN = pda([Buffer.from('coin'), u64(CITY)], IDS.legacy);
  const LEGACY_APPROVAL = pda([Buffer.from('approval'), u64(CITY)], IDS.legacy);
  const A = (s) => PK(s.address);

  await send([ix('init_launchpad', { guardian: A(guardian) }, {
    payer: A(feePayer), admin: A(admin), upgrade_authority: A(deployer),
    program_data: pda([CURVE.toBuffer()], IDS.loader), launchpad: LAUNCHPAD, system_program: IDS.system,
  })], [admin, deployer], 'init_launchpad');
  const P = {
    liquidity_bps: 50, platform_bps: 70, founder_bps: 50, holders_bps: 50, buyback_bps: 30,
    virtual_sol: new BN('30000853639'), virtual_tokens: new BN('1073025598486615'), curve_supply: new BN('793099990000000'),
    pool_supply: new BN('206900000900000'), graduation_sol: new BN('85000000000'), launch_fee_lamports: new BN('50000000'),
  };
  await send([ix('add_launch_config', { p: P }, { admin: A(admin), payer: A(feePayer), launchpad: LAUNCHPAD, config: CONFIG0, system_program: IDS.system })], [admin], 'add_launch_config');
  const now = () => svm.getClock().unixTimestamp;
  const meta = Array.from({ length: 32 }, (_, i) => i + 1);
  await send([ix('approve_launch', {
    city_id: new BN(CITY.toString()), founder: A(founder), config_id: 0, name: 'New York', symbol: 'NYC', meta_hash: meta,
    expires_at: new BN((now() + 86_400n).toString()),
  }, {
    admin: A(admin), launchpad: LAUNCHPAD, config: CONFIG0, approval: APPROVAL, coin: COIN, ticker_lock: TICKER,
    legacy_coin: LEGACY_COIN, legacy_approval: LEGACY_APPROVAL, legacy_launchpad: IDS.legacyLaunchpad, system_program: IDS.system,
  })], [admin], 'approve_launch');

  const feeBefore = lam(IDS.fee);
  const launchAccounts = {
    founder: A(founder), payer: A(founder), launchpad: LAUNCHPAD, approval: APPROVAL, rent_payer: A(admin), config: CONFIG0,
    coin: COIN, mint: MINT, coin_vault: VAULT, ticker_lock: TICKER, metadata: METADATA, fee_recipient: IDS.fee,
    legacy_coin: LEGACY_COIN, legacy_approval: LEGACY_APPROVAL, legacy_launchpad: IDS.legacyLaunchpad,
    metadata_program: IDS.metaplex, token_program: IDS.token, system_program: IDS.system, rent: IDS.rent, ...ev,
  };
  const launched = await send([ix('launch', { city_id: new BN(CITY.toString()) }, launchAccounts)], [founder], 'launch');
  assert.equal(lam(IDS.fee) - feeBefore, 50_000_000n, 'launch fee');
  assert.equal(tokenAmount(VAULT), 793_099_990_000_000n + 206_900_000_900_000n, 'vault after the 9.1-coin burn');
  assert.ok(!acct(APPROVAL), 'approval closed');
  let coin = decode('CurveCoin', COIN);
  assert.equal(coin.phase, 0);
  const rentReserve = BigInt(coin.rent_reserve.toString());
  assert.equal(lam(COIN), rentReserve, 'Coin holds exactly its rent');
  assert.ok(launched.events.some((e) => e.name === 'CoinLaunched'), 'CoinLaunched by event CPI');
  log('launch ok, CU', launched.cu, 'events', launched.events.map((e) => e.name).join(','));

  // buyer's token account (classic SPL Token layout)
  const BUYER_TA = PK((await generateKeyPairSigner()).address);
  {
    const d = Buffer.concat([MINT.toBuffer(), A(buyer).toBuffer(), u64(0), Buffer.alloc(36), Buffer.from([1]), Buffer.alloc(12), u64(0), Buffer.alloc(36)]);
    setRaw(BUYER_TA, d, IDS.token);
  }
  const trade = { user: A(buyer), coin: COIN, launchpad: LAUNCHPAD, mint: MINT, coin_vault: VAULT, user_token_account: BUYER_TA, token_program: IDS.token, system_program: IDS.system, ...ev };
  const bn = (x) => new BN(x.toString());

  // E1: buy 1 SOL at launch
  let b0 = lam(A(buyer));
  let r = await send([ix('buy', { sol_in: bn(1_000_000_000n), min_tokens_out: bn(0) }, trade)], [buyer], 'buy E1');
  assert.equal(tokenAmount(BUYER_TA), 33_774_693_369_781n, 'E1 coins');
  assert.equal(b0 - lam(A(buyer)), 1_000_000_000n, 'E1 charged');
  assert.equal(lam(COIN), rentReserve + 1_000_000_000n);
  log('E1 ok, CU', r.cu, r.events.map((e) => e.name).join(','));

  // E2: sell them back
  b0 = lam(A(buyer));
  r = await send([ix('sell', { tokens_in: bn(33_774_693_369_781n), min_sol_out: bn(0) }, trade)], [buyer], 'sell E2');
  assert.equal(lam(A(buyer)) - b0, 950_625_000n, 'E2 paid');
  coin = decode('CurveCoin', COIN);
  assert.equal(coin.tokens_sold.toString(), '0');
  assert.equal(coin.curve_sol.toString(), '0');
  assert.equal(coin.liquidity_pending.toString(), '9875000');
  assert.equal(coin.platform_pending.toString(), '13825000');
  assert.equal(lam(COIN), rentReserve + 49_375_000n, 'E2: only the two fees remain');
  log('E2 ok, CU', r.cu, r.events.map((e) => e.name).join(','));

  // E3 on top of E2's buckets: fill the curve with 100 SOL (partial fill, graduation)
  b0 = lam(A(buyer));
  r = await send([ix('buy', { sol_in: bn(100_000_000_000n), min_tokens_out: bn(0) }, trade)], [buyer], 'buy E3');
  assert.equal(b0 - lam(A(buyer)), 87_179_487_179n, 'E3 charged');
  assert.equal(tokenAmount(BUYER_TA), 793_099_990_000_000n);
  coin = decode('CurveCoin', COIN);
  assert.equal(coin.phase, 1, 'graduated');
  assert.equal(coin.pool_sol.toString(), '85000000000');
  assert.equal(coin.pool_tokens.toString(), '206900000900000');
  assert.ok(r.events.some((e) => e.name === 'Graduated'));
  log('E3 ok (graduated), CU', r.cu, r.events.map((e) => e.name).join(','));

  // E4-like: pool buy of 1 SOL
  r = await send([ix('buy', { sol_in: bn(1_000_000_000n), min_tokens_out: bn(0) }, trade)], [buyer], 'pool buy');
  log('pool buy ok, CU', r.cu);

  const liabilities = (c) => ['pool_sol', 'liquidity_pending', 'platform_pending', 'founder_pending', 'holders_pending', 'buyback_pending']
    .reduce((s, k) => s + BigInt(c[k].toString()), 0n);
  const checkBacking = (label) => { const c = decode('CurveCoin', COIN); assert.equal(lam(COIN), rentReserve + liabilities(c), `I9 ${label}`); };
  checkBacking('after trades');

  // buyback (150 slots after launch have passed? launch at slot 1000; warp)
  warpSlots(200);
  const supplyBefore = Buffer.from(acct(MINT).data).readBigUInt64LE(36);
  r = await send([ix('buyback_burn', {}, { coin: COIN, launchpad: LAUNCHPAD, mint: MINT, coin_vault: VAULT, token_program: IDS.token, ...ev })], [], 'buyback');
  const supplyAfter = Buffer.from(acct(MINT).data).readBigUInt64LE(36);
  assert.ok(supplyAfter < supplyBefore, 'buyback burned coins');
  const bb = r.events.find((e) => e.name === 'BuybackBurned');
  assert.equal(bb.data.supply_after.toString(), supplyAfter.toString());
  checkBacking('after buyback');
  log('buyback ok, burned', (supplyBefore - supplyAfter).toString(), 'CU', r.cu);
  // second run in the same interval: no-op, no event
  r = await send([ix('buyback_burn', {}, { coin: COIN, launchpad: LAUNCHPAD, mint: MINT, coin_vault: VAULT, token_program: IDS.token, ...ev })], [], 'buyback no-op');
  assert.equal(r.events.length, 0, 'no-op emits nothing');

  // withdraw, claim
  coin = decode('CurveCoin', COIN);
  let before = lam(IDS.fee);
  r = await send([ix('withdraw_platform_fees', {}, { coin: COIN, fee_recipient: IDS.fee, ...ev })], [], 'withdraw');
  assert.equal(lam(IDS.fee) - before, BigInt(coin.platform_pending.toString()));
  checkBacking('after withdraw');
  log('withdraw ok', coin.platform_pending.toString(), 'CU', r.cu);
  before = lam(A(founder));
  r = await send([ix('claim_founder_fees', {}, { founder: A(founder), coin: COIN, ...ev })], [founder], 'claim');
  assert.equal(lam(A(founder)) - before, BigInt(coin.founder_pending.toString()));
  checkBacking('after claim');
  log('claim ok', coin.founder_pending.toString(), 'CU', r.cu);

  // forward to a vicinity_rewards WSOL vault (crafted CityConfig), then a top-level SyncNative
  const CITYCFG = pda([Buffer.from('city'), MINT.toBuffer()], IDS.rewards);
  const RVAULT = pda([Buffer.from('vault'), CITYCFG.toBuffer()], IDS.rewards);
  {
    const d = Buffer.alloc(300);
    Buffer.from([14, 136, 110, 28, 46, 68, 178, 115]).copy(d, 0);
    A(admin).toBuffer().copy(d, 8);
    MINT.toBuffer().copy(d, 104);
    IDS.wsol.toBuffer().copy(d, 136);
    RVAULT.toBuffer().copy(d, 168);
    d[200] = 1; // Holders
    setRaw(CITYCFG, d, IDS.rewards);
    const rent = svm.minimumBalanceForRentExemption(165n);
    const v = Buffer.concat([IDS.wsol.toBuffer(), CITYCFG.toBuffer(), u64(0), Buffer.alloc(36), Buffer.from([1]), u32(1), u64(rent), u64(0), Buffer.alloc(36)]);
    setRaw(RVAULT, v, IDS.token, rent);
  }
  const syncNative = { programAddress: address(IDS.token.toBase58()), accounts: [{ address: address(RVAULT.toBase58()), role: 1 }], data: new Uint8Array([17]) };
  const holders = BigInt(coin.holders_pending.toString());
  r = await send([ix('forward_holders_fees', {}, { launchpad: LAUNCHPAD, coin: COIN, rewards_city_config: CITYCFG, rewards_vault: RVAULT, ...ev }), syncNative], [], 'forward + SyncNative');
  assert.equal(tokenAmount(RVAULT), holders, 'vault amount after SyncNative');
  checkBacking('after forward');
  log('forward + SyncNative ok', holders.toString(), 'CU', r.cu);

  // payouts: configure, opt in, trade, pay out
  await send([ix('set_payout_config', { payout_authority: A(payoutKey), payout_destination: A(payoutWallet) }, { admin: A(admin), launchpad: LAUNCHPAD })], [admin], 'set_payout_config');
  const OPTIN = pda([Buffer.from('payout_opt_in'), COIN.toBuffer()]);
  await send([ix('opt_in_payout', { expected_destination: A(payoutWallet), ref_hash: meta }, { founder: A(founder), launchpad: LAUNCHPAD, coin: COIN, opt_in: OPTIN, system_program: IDS.system })], [founder], 'opt_in');
  await send([ix('buy', { sol_in: bn(2_000_000_000n), min_tokens_out: bn(0) }, trade)], [buyer], 'buy for payout');
  coin = decode('CurveCoin', COIN);
  before = lam(A(payoutWallet));
  const payoutAccounts = { payout_authority: A(payoutKey), launchpad: LAUNCHPAD, coin: COIN, opt_in: OPTIN, destination_wallet: A(payoutWallet), ...ev };
  r = await send([ix('payout_founder_fees', {}, payoutAccounts)], [payoutKey], 'payout');
  assert.equal(lam(A(payoutWallet)) - before, BigInt(coin.founder_pending.toString()));
  checkBacking('after payout');
  log('payout ok', coin.founder_pending.toString(), 'CU', r.cu);
  await send([ix('buy', { sol_in: bn(1_000_000_000n), min_tokens_out: bn(0) }, trade)], [buyer], 'buy');
  await fails(() => send([ix('payout_founder_fees', {}, payoutAccounts)], [payoutKey], 'payout too soon'), 'PayoutTooSoon');

  // guardian halt: buys and buybacks refuse, sells and claims work, only the admin clears
  await send([ix('set_pause', { launches: null, payouts: null, buys: true, buybacks: null }, { authority: A(guardian), launchpad: LAUNCHPAD })], [guardian], 'guardian halts');
  await fails(() => send([ix('buy', { sol_in: bn(1_000_000_000n), min_tokens_out: bn(0) }, trade)], [buyer], 'halted buy'), 'BuysHalted');
  await send([ix('sell', { tokens_in: bn(1_000_000n), min_sol_out: bn(0) }, trade)], [buyer], 'sell while halted');
  await send([ix('claim_founder_fees', {}, { founder: A(founder), coin: COIN, ...ev })], [founder], 'claim while halted');
  await fails(() => send([ix('set_pause', { launches: null, payouts: null, buys: false, buybacks: null }, { authority: A(guardian), launchpad: LAUNCHPAD })], [guardian], 'guardian clears'), 'Unauthorized');
  await send([ix('set_pause', { launches: null, payouts: null, buys: false, buybacks: null }, { authority: A(admin), launchpad: LAUNCHPAD })], [admin], 'admin clears');
  log('guardian halt ok');

  // halt-all build over the live state (H02, H03)
  const snapshot = Buffer.from(acct(COIN).data);
  const coinLamports = lam(COIN);
  loadCurve(HALT);
  warpSlots(400); warpSecs(2 * 86_400);
  const refuse = async (label, ixs, signers) => fails(() => send(ixs, signers, label), 'TradingHalted');
  await refuse('buy', [ix('buy', { sol_in: bn(1_000_000_000n), min_tokens_out: bn(0) }, trade)], [buyer]);
  await refuse('sell', [ix('sell', { tokens_in: bn(1_000_000n), min_sol_out: bn(0) }, trade)], [buyer]);
  await refuse('buyback', [ix('buyback_burn', {}, { coin: COIN, launchpad: LAUNCHPAD, mint: MINT, coin_vault: VAULT, token_program: IDS.token, ...ev })], []);
  await refuse('withdraw', [ix('withdraw_platform_fees', {}, { coin: COIN, fee_recipient: IDS.fee, ...ev })], []);
  await refuse('claim', [ix('claim_founder_fees', {}, { founder: A(founder), coin: COIN, ...ev })], [founder]);
  await refuse('forward', [ix('forward_holders_fees', {}, { launchpad: LAUNCHPAD, coin: COIN, rewards_city_config: CITYCFG, rewards_vault: RVAULT, ...ev })], []);
  await refuse('payout', [ix('payout_founder_fees', {}, payoutAccounts)], [payoutKey]);
  // launch of a second city
  const CITY2 = 2n;
  const COIN2 = pda([Buffer.from('coin'), u64(CITY2)]);
  const MINT2 = pda([Buffer.from('mint'), COIN2.toBuffer()]);
  await send([ix('approve_launch', {
    city_id: bn(CITY2), founder: A(founder), config_id: 0, name: 'Second', symbol: 'TWO', meta_hash: meta, expires_at: bn(now() + 86_400n),
  }, {
    admin: A(admin), launchpad: LAUNCHPAD, config: CONFIG0, approval: pda([Buffer.from('approval'), u64(CITY2)]), coin: COIN2,
    ticker_lock: pda([Buffer.from('ticker'), Buffer.from('TWO')]), legacy_coin: pda([Buffer.from('coin'), u64(CITY2)], IDS.legacy),
    legacy_approval: pda([Buffer.from('approval'), u64(CITY2)], IDS.legacy), legacy_launchpad: IDS.legacyLaunchpad, system_program: IDS.system,
  })], [admin], 'approve city 2 (settings still work under halt-all)');
  const launch2 = {
    ...launchAccounts, approval: pda([Buffer.from('approval'), u64(CITY2)]), coin: COIN2, mint: MINT2,
    coin_vault: pda([Buffer.from('coin_vault'), COIN2.toBuffer()]), ticker_lock: pda([Buffer.from('ticker'), Buffer.from('TWO')]),
    metadata: pda([Buffer.from('metadata'), IDS.metaplex.toBuffer(), MINT2.toBuffer()], IDS.metaplex),
    legacy_coin: pda([Buffer.from('coin'), u64(CITY2)], IDS.legacy), legacy_approval: pda([Buffer.from('approval'), u64(CITY2)], IDS.legacy),
  };
  await refuse('launch', [ix('launch', { city_id: bn(CITY2) }, launch2)], [founder]);
  assert.ok(Buffer.from(acct(COIN).data).equals(snapshot), 'Coin state unchanged under halt-all');
  assert.equal(lam(COIN), coinLamports, 'Coin lamports unchanged under halt-all');
  log('halt-all: all eight outflows refuse with TradingHalted; state unchanged');

  // back to the production build: everything works again
  loadCurve(PROD);
  await send([ix('buy', { sol_in: bn(1_000_000_000n), min_tokens_out: bn(0) }, trade)], [buyer], 'buy after restore');
  await send([ix('sell', { tokens_in: bn(1_000_000n), min_sol_out: bn(0) }, trade)], [buyer], 'sell after restore');
  await send([ix('launch', { city_id: bn(CITY2) }, launch2)], [founder], 'launch city 2 after restore');
  checkBacking('after restore');
  log('restored: trades and launch work; SMOKE OK');
});
