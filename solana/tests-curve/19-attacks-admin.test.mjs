// Attacks by and around the privileged keys and the city gate (sections 8 and
// 10): X34 approval and launch for a launched city, a city the old program
// launched, a city with an old-program approval and while old launches are
// open, at approval and again at launch; X35 ticker reuse under another city;
// X43 every admin instruction run against live coins moves no money, and the
// admin cannot reach any bucket; X43b the guardian; X44 hostile configs from a
// stolen admin key; X45 a stolen admin key approving itself (closest shape:
// expiry, one approval per city, events); X46 a malicious upgrade (closest
// shape: only the upgrade authority can upgrade); X47 fake rewards configs and
// vaults (every field of the real CityConfig and vault edited in turn, the same
// bytes under the other cluster's rewards program id), with X48 and X49's
// models, founder shares and authorities; X50 payout destination games; X51 the
// payout key's cooldown and pause; X52 a stolen founder key; X53 a lost founder
// key.
import test from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import { generateKeyPairSigner } from '@solana/kit';
import { World, S, expectFail, metaHash, tokenAccountInfo, LAMPORTS, DAY } from './helpers.mjs';

const { PublicKey } = web3;
const pkb = (a) => new PublicKey(String(a)).toBuffer();
const fingerprint = (w, addrs) => addrs.map((a) => { const x = w.accountInfo(a); return x ? `${a}:${x.lamports}:${x.owner}:${x.data.toString('hex')}` : `${a}:none`; });
async function refuse(w, watch, fn, ...codes) {
  const before = fingerprint(w, watch);
  const e = await expectFail(fn, ...codes);
  assert.deepEqual(fingerprint(w, watch), before, 'an attacked account changed');
  return e;
}
const moneyOf = (w, coins) => [...coins.flatMap((h) => [h.coin, h.vault, h.mint]), S.ADDRESSES.feeRecipient];
const ref = (n) => Array(32).fill(n);

async function liveCoins(w) {
  const u = await w.signer(500n);
  const curve = await w.launchCoin({ cityId: 1900n, symbol: 'LIVEC' });
  const pool = await w.launchCoin({ cityId: 1901n, symbol: 'LIVEP' });
  await w.buy(u, curve, 20n * LAMPORTS, { label: 'curve buy' });
  await w.buy(u, pool, 100n * LAMPORTS, { label: 'pool graduates' });
  for (const h of [curve, pool]) await w.initRewardsCity(h);
  return { u, curve, pool };
}

// ---------------------------------------------------------------- X34
test('X34 approval and launch for a launched city, a city launched by the old program, a city with an old approval, and while old launches are open: refused at approval and again at launch', async () => {
  const w = await World.create({ dbcProgram: true });
  const founder = await w.signer(20n); const old = await w.signer(20n);
  // a city launched here
  await w.launchCoin({ cityId: 1910n, founder, symbol: 'HERE' });
  await refuse(w, [w.P.approval(1910n)], () => w.approve({ cityId: 1910n, founder, symbol: 'HERE2' }), 'CoinAlreadyLaunched');
  // approvals made here first, then the old program acts on the same cities
  for (const [city, sym] of [[1911n, 'LGCOIN'], [1912n, 'LGAPPR'], [1913n, 'LGOPEN']]) await w.approve({ cityId: city, founder, symbol: sym });
  await w.legacyPause(false);
  await refuse(w, [w.P.approval(1914n)], () => w.approve({ cityId: 1914n, founder, symbol: 'OPEN' }), 'LegacyLaunchesOpen');
  await refuse(w, Object.values(w.P.coinAccounts(1913n)), () => w.launch({ cityId: 1913n, founder, label: 'launch while old launches are open' }), 'LegacyLaunchesOpen');
  await w.legacyApprove({ cityId: 1911n, founder: old, symbol: 'OLDC' });
  await w.legacyLaunch({ cityId: 1911n, founder: old });
  await w.legacyApprove({ cityId: 1912n, founder: old, symbol: 'OLDA' });
  await w.legacyApprove({ cityId: 1915n, founder: old, symbol: 'OLDB' });
  await w.legacyLaunch({ cityId: 1915n, founder: old });
  await w.legacyApprove({ cityId: 1916n, founder: old, symbol: 'OLDD' });
  await w.legacyPause(true);
  // at launch: the old Coin and the old Approval block the cities approved here first
  await refuse(w, Object.values(w.P.coinAccounts(1911n)), () => w.launch({ cityId: 1911n, founder, label: 'launch, the old program launched the city' }), 'LegacyCoinExists');
  await refuse(w, Object.values(w.P.coinAccounts(1912n)), () => w.launch({ cityId: 1912n, founder, label: 'launch, the old program approved the city' }), 'LegacyApprovalExists');
  // at approval: the same checks for fresh cities
  await refuse(w, [w.P.approval(1915n)], () => w.approve({ cityId: 1915n, founder, symbol: 'NEWB' }), 'LegacyCoinExists');
  await refuse(w, [w.P.approval(1916n)], () => w.approve({ cityId: 1916n, founder, symbol: 'NEWD' }), 'LegacyApprovalExists');
  // the old launches paused again: the untouched city launches
  await w.launch({ cityId: 1913n, founder });
  await w.finish();
});

// ---------------------------------------------------------------- X35
test('X35 a ticker can never be reused under another city: refused at approval once locked, at launch if approved before the lock; look-alike spellings are refused', async () => {
  const w = await World.create();
  const f1 = await w.signer(20n); const f2 = await w.signer(20n); const f3 = await w.signer(20n);
  await w.approve({ cityId: 1920n, founder: f1, symbol: 'TKR' });
  await w.approve({ cityId: 1921n, founder: f2, symbol: 'TKR' });
  const h = await w.launch({ cityId: 1920n, founder: f1 });
  const lock = w.accountInfo(w.P.ticker('TKR')).data;
  await refuse(w, [w.P.ticker('TKR')], () => w.approve({ cityId: 1922n, founder: f3, symbol: 'TKR' }), 'TickerTaken');
  await refuse(w, [w.P.ticker('TKR'), ...Object.values(w.P.coinAccounts(1921n))], () => w.launch({ cityId: 1921n, founder: f2, label: 'second city, same ticker' }), /already in use/);
  for (const s of ['tkr', 'TKR ', ' TKR', 'TKR\u0000', 'ТКR', 'TKR​']) await refuse(w, [w.P.ticker('TKR')], () => w.approve({ cityId: 1923n, founder: f3, symbol: s }), 'BadSymbol', /seed|MaxSeedLength/i);
  assert.ok(w.accountInfo(w.P.ticker('TKR')).data.equals(lock));
  assert.equal(S.decodeTickerLock(w.accountInfo(w.P.ticker('TKR')), { programId: w.programId }).mint, h.mint);
  // a different ticker is a different lock
  await w.approve({ cityId: 1923n, founder: f3, symbol: 'TKR2' });
  await w.launch({ cityId: 1923n, founder: f3 });
  await w.finish();
});

// ---------------------------------------------------------------- X43, X43b
test('X43, X43b every admin and guardian instruction run against live coins moves no money and changes no coin; neither key can reach any bucket', async () => {
  const w = await World.create();
  const { u, curve, pool } = await liveCoins(w);
  const money = moneyOf(w, [curve, pool]);
  const coinsOnly = [curve.coin, pool.coin, curve.vault, pool.vault, curve.mint, pool.mint];
  const unchanged = async (label, fn) => {
    const before = fingerprint(w, coinsOnly);
    const fr = w.lamportsOf(S.ADDRESSES.feeRecipient);
    await fn();
    assert.deepEqual(fingerprint(w, coinsOnly), before, `${label}: no coin byte, lamport or vault moved`);
    assert.equal(w.lamportsOf(S.ADDRESSES.feeRecipient), fr, `${label}: no money moved`);
  };
  const A = () => w.admin;
  const next = await w.signer(5n); const pk = await w.signer(1n); const wallet = await w.signer(1n); const g2 = await w.signer(1n);
  await unchanged('set_pause (all on, all off)', async () => {
    await w.send([w.ix.setPause({ authority: A().address, launches: true, payouts: true, buys: true, buybacks: true })], [A()], 'pause all');
    await w.send([w.ix.setPause({ authority: A().address, launches: false, payouts: false, buys: false, buybacks: false })], [A()], 'resume all');
  });
  await unchanged('set_guardian', () => w.send([w.ix.setGuardian({ admin: A().address, guardian: g2.address })], [A()], 'set_guardian'));
  const oldGuardian = w.guardian; w.guardian = g2;
  await unchanged('set_payout_config', () => w.send([w.ix.setPayoutConfig({ admin: A().address, payoutAuthority: pk.address, payoutDestination: wallet.address })], [A()], 'set_payout_config'));
  w.payoutKey = pk;
  await unchanged('add_launch_config', () => w.addConfig({ ...S.DEFAULT_CONFIG, platformBps: 120n, liquidityBps: 0n }));
  await unchanged('set_launch_config_enabled', async () => {
    await w.send([w.ix.setLaunchConfigEnabled({ admin: A().address, configId: 0, enabled: false })], [A()], 'disable #0');
    await w.send([w.ix.setLaunchConfigEnabled({ admin: A().address, configId: 0, enabled: true })], [A()], 'enable #0');
  });
  const f = await w.signer(5n);
  await unchanged('approve_launch and revoke_approval', async () => {
    await w.approve({ cityId: 1930n, founder: f, symbol: 'APRV' });
    await w.send([w.ix.revokeApproval({ by: A().address, cityId: 1930n, rentPayer: A().address })], [A()], 'revoke');
  });
  // what the admin cannot do: take the founder's, the platform's or the holders' money, sell holders' coins, change a founder, redirect payouts
  const watch = money;
  await refuse(w, watch, () => w.send([w.ix.claimFounderFees({ founder: A().address, coin: curve.coin })], [A()], 'admin claims the founder share'), 'WrongFounder');
  await refuse(w, watch, () => w.send([w.ix.transferFounder({ founder: A().address, newFounder: A().address, coin: curve.coin })], [A()], 'admin takes the seat'), 'WrongFounder');
  await refuse(w, watch, () => w.send([w.ix.withdrawPlatformFees({ coin: curve.coin, overrides: { fee_recipient: A().address } })], [], 'withdraw to the admin', { feePayer: A() }), 'InvalidAddress');
  await refuse(w, watch, () => w.send([w.ix.sell({ user: A().address, coin: curve.coin, userTokenAccount: S.associatedTokenAddress(u.address, curve.mint), tokensIn: 1_000_000n, minSolOut: 0n })], [A()], 'admin sells a holder\'s coins'), 'WrongTokenAccount');
  await refuse(w, watch, () => w.send([w.ix.optInPayout({ founder: A().address, coin: curve.coin, expectedDestination: wallet.address, refHash: ref(1) })], [A()], 'admin opts the founder in'), 'WrongFounder');
  await refuse(w, [w.P.launchpad()], () => w.send([w.ix.setPayoutConfig({ admin: A().address, payoutAuthority: pk.address, payoutDestination: A().address })], [A()], 'payout wallet = the admin'), 'PayoutKeyNotSeparate');
  // the admin's own payout key and wallet (separate keys he controls): without the founder's opt-in nothing can be paid
  await refuse(w, watch, () => w.payout(curve, { destination: wallet.address, label: 'payout without an opt-in' }), 'AccountNotInitialized');
  // the guardian (X43b): may halt buys, buybacks and launches, nothing else
  const g = w.guardian;
  await w.send([w.ix.setPause({ authority: g.address, buys: true, launches: true, buybacks: true })], [g], 'guardian halts');
  for (const [label, ix] of [['clear the halt', w.ix.setPause({ authority: g.address, buys: false })], ['resume buybacks', w.ix.setPause({ authority: g.address, buybacks: false })],
    ['pause payouts', w.ix.setPause({ authority: g.address, payouts: true })],
    ['replace itself', w.ix.setGuardian({ admin: g.address, guardian: g.address })], ['set payouts', w.ix.setPayoutConfig({ admin: g.address, payoutAuthority: g.address, payoutDestination: wallet.address })],
    ['add a config', w.ix.addLaunchConfig({ admin: g.address, payer: g.address, configId: w.launchpad().nextConfigId, params: S.DEFAULT_CONFIG })],
    ['disable a config', w.ix.setLaunchConfigEnabled({ admin: g.address, configId: 0, enabled: false })], ['propose an admin', w.ix.proposeAdmin({ admin: g.address, newAdmin: g.address })]]) {
    await refuse(w, [w.P.launchpad(), w.P.config(0)], () => w.send([ix], [g], `guardian: ${label}`), 'Unauthorized');
  }
  // while halted, every exit works: sells, claims, withdrawals, forwards
  await unchanged('nothing (control)', async () => {});
  await w.sell(u, curve, w.balanceOf(u, curve.mint) / 3n, { label: 'sell while halted' });
  await w.sell(u, pool, w.balanceOf(u, pool.mint) / 3n, { label: 'pool sell while halted' });
  await w.claim(curve, curve.founder, { label: 'claim while halted' });
  await w.withdraw(pool, { label: 'withdraw while halted' });
  await w.forward(pool, { label: 'forward while halted' });
  await w.send([w.ix.setPause({ authority: A().address, buys: false, launches: false, buybacks: false })], [A()], 'the admin clears');
  await unchanged('propose_admin and accept_admin', async () => {
    await w.send([w.ix.proposeAdmin({ admin: A().address, newAdmin: next.address })], [A()], 'propose');
    await w.send([w.ix.acceptAdmin({ newAdmin: next.address })], [next], 'accept');
  });
  const formerAdmin = w.admin; w.admin = next;
  await refuse(w, money, () => w.send([w.ix.claimFounderFees({ founder: formerAdmin.address, coin: pool.coin })], [formerAdmin], 'the former admin claims'), 'WrongFounder');
  void oldGuardian;
  await w.finish();
});

// ---------------------------------------------------------------- X44, X45
test('X44, X45 a stolen admin key: hostile configs are refused (V1 to V11), live coins keep their terms, a pending approval cannot be switched to another config; approvals expire within 30 days and are announced', async () => {
  const w = await World.create();
  const live = await w.launchCoin({ cityId: 1940n, symbol: 'KEEP' });
  const frozen = w.accountInfo(live.coin).data.subarray(119, 189);
  const D = S.DEFAULT_CONFIG;
  const want = { V1: 'ConfigFeeTotal', V2: 'ConfigFeeShareCap', V3: 'ConfigSupply', V4: 'ConfigCurveBounds', V5: 'ConfigGraduation', V6: 'ConfigAbsorption', V7: 'ConfigContinuity',
    V8: 'ConfigBuybackMev', V9: 'ConfigLaunchFee', V10: 'ConfigDripFarmable', V11: 'ConfigBuybackHorizon' };
  const shares = (l, p, f, h, b) => ({ ...D, liquidityBps: BigInt(l), platformBps: BigInt(p), founderBps: BigInt(f), holdersBps: BigInt(h), buybackBps: BigInt(b) });
  const hostile = [
    ['fees above 2.5%', shares(50, 70, 50, 50, 31)], ['platform above 1.2%', shares(0, 121, 50, 50, 29)], ['founder above 1.0%', shares(0, 50, 101, 50, 49)],
    ['revision 1\'s founder split (50, 0, 170, 0, 30)', shares(50, 0, 170, 0, 30)], ['a founder-favouring buyback split (50, 0, 100, 0, 30)', shares(50, 0, 100, 0, 30)],
    ['a buyback a founder can sandwich (0, 20, 100, 0, 30)', shares(0, 20, 100, 0, 30)], ['a farmable drip (100, 50, 50, 50, 0)', shares(100, 50, 50, 50, 0)],
    ['all to liquidity (250, 0, 0, 0, 0)', shares(250, 0, 0, 0, 0)], ['a launch fee of 0.5 SOL + 1', { ...D, launchFeeLamports: 500_000_001n }],
    // review ECON-1 (V2b): without a buyback share V8 and V11 do not run; the founder (or a holder of the float) credited the whole fee
    ['the founder takes the whole fee (0, 0, 100, 0, 0)', shares(0, 0, 100, 0, 0)], ['the holders take the whole fee (0, 0, 0, 250, 0)', shares(0, 0, 0, 250, 0)],
    ['a 0.01% fee all to the founder (0, 0, 1, 0, 0)', shares(0, 0, 1, 0, 0)],
    // review R3-DIFF-1 (V2b as a sum): a founder who also holds the float is credited both shares, so together they leave 1 bp
    ['the founder and the holders take the whole fee (0, 0, 50, 50, 0)', shares(0, 0, 50, 50, 0)], ['a 1% founder share and 0.01% to holders (0, 0, 100, 1, 0)', shares(0, 0, 100, 1, 0)],
    ['the founder and the holders take 2.5% (0, 0, 100, 150, 0)', shares(0, 0, 100, 150, 0)], ['a 0.02% fee to the founder and the holders (0, 0, 1, 1, 0)', shares(0, 0, 1, 1, 0)],
    ['a curve that leaves dust', { ...D, virtualTokens: D.virtualTokens + 10_000_000_000_000n }], ['a pool that opens above the curve', { ...D, virtualSol: D.virtualSol - 50_000_000n }],
  ];
  for (const [label, p] of hostile) {
    const rule = S.configRule(p);
    assert.ok(rule, `${label}: refused by the model`);
    await refuse(w, [w.P.launchpad(), w.P.config(1)], () => w.addConfig(p), want[rule]);
  }
  // a legitimate new config and the old one disabled: the live coin keeps its frozen terms and trades on
  const id = await w.addConfig(shares(0, 120, 50, 50, 30));
  await w.send([w.ix.setLaunchConfigEnabled({ admin: w.admin.address, configId: 0, enabled: false })], [w.admin], 'disable #0');
  assert.ok(w.accountInfo(live.coin).data.subarray(119, 189).equals(frozen), 'the live coin\'s terms are frozen');
  await w.buy(await w.signer(10n), live, LAMPORTS, { label: 'the live coin trades on' });
  await w.send([w.ix.setLaunchConfigEnabled({ admin: w.admin.address, configId: 0, enabled: true })], [w.admin], 'enable #0');
  // a pending approval names its config: the launch cannot be pointed at another one
  const founder = await w.signer(10n);
  await w.approve({ cityId: 1941n, founder, symbol: 'PEND', configId: 0 });
  await refuse(w, Object.values(w.P.coinAccounts(1941n)), () => w.send([w.ix.launch({ founder: founder.address, cityId: 1941n, configId: id, symbol: 'PEND', rentPayer: w.admin.address })], [founder], 'launch under another config'), 'ConstraintSeeds');
  // X45: approvals expire within 30 days; an expired one cannot be launched and anyone may clean it up; each approval is announced
  await refuse(w, [w.P.approval(1942n)], () => w.approve({ cityId: 1942n, founder, symbol: 'LONG', expiresAt: w.now() + S.APPROVAL_MAX_SECS + 1n }), 'BadExpiry');
  const evs = [];
  for (let i = 0n; i < 5n; i++) {
    const r = await w.send([w.ix.approveLaunch({ admin: w.admin.address, cityId: 1950n + i, founder: w.admin.address, configId: 0, name: 'Mine', symbol: `MINE${i}`, metaHash: metaHash(`m${i}`), expiresAt: w.now() + DAY })], [w.admin], `self-approval ${i}`);
    evs.push(r.events.find((e) => e.name === 'LaunchApproved'));
  }
  assert.equal(evs.filter(Boolean).length, 5, 'every approval emits LaunchApproved for monitoring');
  w.warpSecs(DAY + 1n);
  await refuse(w, Object.values(w.P.coinAccounts(1950n)), () => w.send([w.ix.launch({ founder: w.admin.address, cityId: 1950n, configId: 0, symbol: 'MINE0', rentPayer: w.admin.address })], [w.admin], 'launch an expired self-approval'), 'ApprovalExpired');
  const cleaner = await w.signer(1n);
  for (let i = 0n; i < 5n; i++) await w.send([w.ix.revokeApproval({ by: cleaner.address, cityId: 1950n + i, rentPayer: w.admin.address })], [cleaner], `anyone revokes ${i}`);
  await w.launch({ cityId: 1941n, founder });
  await w.finish();
});

// ---------------------------------------------------------------- X46
test('X46 a malicious upgrade (closest shape): a stranger can neither upgrade vicinity_curve nor take its upgrade authority; the upgrade path exists only for the upgrade authority', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1960n, symbol: 'UPGR' });
  const stranger = await w.signer(10n);
  const pd = w.P.programData();
  const code = w.accountInfo(pd).data.subarray(45);
  const loader = S.ADDRESSES.upgradeableLoader;
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  /** A buffer account holding `elf`, with `authority` (set out of band: writing 588 KB through Write instructions only costs time). */
  const buffer = async (authority, elf) => {
    const addr = (await generateKeyPairSigner()).address;
    w.setRaw(addr, Buffer.concat([u32(1), Buffer.from([1]), pkb(authority), elf]), loader);
    return addr;
  };
  const upgradeIx = (buf, authority, spill) => ({ programAddress: loader, accounts: [
    { address: pd, role: S.Role.W }, { address: w.programId, role: S.Role.W }, { address: buf, role: S.Role.W }, { address: spill, role: S.Role.W },
    { address: S.ADDRESSES.rentSysvar, role: S.Role.R }, { address: 'SysvarC1ock11111111111111111111111111111111', role: S.Role.R }, { address: authority, role: S.Role.RS }],
  data: new Uint8Array(u32(3)) });
  const setAuthorityIx = (current, next) => ({ programAddress: loader, accounts: [{ address: pd, role: S.Role.W }, { address: current, role: S.Role.RS }, { address: next, role: S.Role.R }], data: new Uint8Array(u32(4)) });
  const watch = [pd, w.programId, h.coin];
  const evil = await buffer(stranger.address, code);
  await refuse(w, watch, () => w.send([upgradeIx(evil, stranger.address, stranger.address)], [stranger], 'a stranger upgrades'), /IncorrectAuthority|Incorrect authority|authority/i);
  await refuse(w, watch, () => w.send([setAuthorityIx(stranger.address, stranger.address)], [stranger], 'a stranger takes the upgrade authority'), /IncorrectAuthority|Incorrect authority|authority/i);
  // a buffer the deployer controls, upgraded by a stranger: still refused (the program's authority must sign)
  const ok = await buffer(w.deployer.address, code);
  await refuse(w, watch, () => w.send([upgradeIx(ok, stranger.address, stranger.address)], [stranger], 'a stranger upgrades with the authority\'s buffer'), /IncorrectAuthority|Incorrect authority|authority|MissingRequiredSignature/i);
  // the upgrade authority can (with the same audited code here; on mainnet the Squads 2-of-3 and the time lock of 8.4 govern it)
  w.warpSlots(1n);
  const spill = (await generateKeyPairSigner()).address;
  await w.send([upgradeIx(ok, w.deployer.address, spill)], [w.deployer], 'the upgrade authority redeploys the same code');
  w.warpSlots(1n);
  assert.ok(w.accountInfo(pd).data.subarray(45).equals(code));
  await w.buy(await w.signer(10n), h, LAMPORTS, { label: 'trading after the redeploy' });
  await w.finish();
});

// ---------------------------------------------------------------- X47, X48, X49
test('X47 to X49 fake rewards configs and vaults: every field of the real CityConfig and vault edited in turn, the same bytes under the other cluster\'s rewards program id, a vault elsewhere: all refused; nothing moves', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1970n, symbol: 'RWDX' });
  const other = await w.launchCoin({ cityId: 1971n, symbol: 'RWDY' });
  const u = await w.signer(100n);
  await w.buy(u, h, 20n * LAMPORTS);
  const { config, vault } = await w.initRewardsCity(h);
  const cfg = w.accountInfo(config); const vlt = w.accountInfo(vault);
  const stranger = (await generateKeyPairSigner()).address;
  const watch = [h.coin, config, vault];
  const forward = (label, overrides) => w.send([w.ix.forwardHoldersFees({ coin: h.coin, overrides })], [], label, { feePayer: w.keeper });
  const withConfig = async (label, data, owner, ...codes) => {
    w.setRaw(config, data, owner, cfg.lamports);
    await refuse(w, watch, () => forward(label), ...codes);
    w.setRaw(config, cfg.data, cfg.owner, cfg.lamports);
  };
  const edit = (at, bytes) => { const d = Buffer.from(cfg.data); Buffer.from(bytes).copy(d, at); return d; };
  // X47: the very bytes of the right config, owned by the other cluster's vicinity_rewards
  await withConfig('config owned by the devnet rewards program', cfg.data, S.CLUSTERS.devnet.rewardsProgram, 'WrongRewardsConfig');
  await withConfig('wrong discriminator', edit(0, [0, 0, 0, 0, 0, 0, 0, 0]), cfg.owner, 'WrongRewardsConfig');
  await withConfig('truncated to 202 bytes', cfg.data.subarray(0, 202), cfg.owner, 'WrongRewardsConfig');
  await withConfig('another coin\'s mint', edit(104, pkb(other.mint)), cfg.owner, 'WrongRewardsConfig');
  await withConfig('reward mint not WSOL', edit(136, pkb(h.mint)), cfg.owner, 'WrongRewardsConfig');
  await withConfig('another vault named', edit(168, pkb(stranger)), cfg.owner, 'WrongRewardsConfig');
  // X48: the models that pay a founder, and a Holders config with a founder share
  await withConfig('model Creator', edit(200, [0]), cfg.owner, 'WrongRewardsConfig');
  await withConfig('model Split', edit(200, [2]), cfg.owner, 'WrongRewardsConfig');
  await withConfig('Holders with founder_bps 1', edit(201, [1, 0]), cfg.owner, 'WrongRewardsConfig');
  // X49: a stranger as root publisher, or a pending transfer
  await withConfig('authority a stranger', edit(8, pkb(stranger)), cfg.owner, 'WrongRewardsConfig');
  await withConfig('authority transfer pending', edit(40, pkb(stranger)), cfg.owner, 'WrongRewardsConfig');
  // fake vaults: elsewhere, another mint, another owner, Token-2022
  const fakeVault = (await generateKeyPairSigner()).address;
  w.setRaw(fakeVault, vlt.data, S.ADDRESSES.token, vlt.lamports);
  await refuse(w, watch, () => forward('a WSOL account of the config at another address', { rewards_vault: fakeVault }), 'WrongRewardsVault');
  const withVault = async (label, data, owner, ...codes) => {
    w.setRaw(vault, data, owner, vlt.lamports);
    await refuse(w, watch, () => forward(label), ...codes);
    w.setRaw(vault, vlt.data, vlt.owner, vlt.lamports);
  };
  const vedit = (at, bytes) => { const d = Buffer.from(vlt.data); Buffer.from(bytes).copy(d, at); return d; };
  await withVault('vault of another mint', vedit(0, pkb(h.mint)), vlt.owner, 'WrongRewardsVault');
  await withVault('vault owned by a stranger', vedit(32, pkb(stranger)), vlt.owner, 'WrongRewardsVault');
  await withVault('vault under Token-2022', vlt.data, S.ADDRESSES.token2022, 'AccountOwnedByWrongProgram', /owned by a different program|0xbbf/i);
  // restored: the forward pays exactly the holders' bucket into the real vault
  const pending = w.coinView(h).holdersPending;
  const v0 = tokenAccountInfo(w.accountInfo(vault)).amount;
  await w.forward(h);
  assert.equal(tokenAccountInfo(w.accountInfo(vault)).amount - v0, pending);
  await w.finish();
});

// ---------------------------------------------------------------- X50, X51
test('X50, X51 payout destination games and the payout key: never redirected, at most daily whatever is re-opted, changed or handed over, pausable but not resumable by the payout key', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1980n, symbol: 'PAYG' });
  const u = await w.signer(200n);
  await w.buy(u, h, 20n * LAMPORTS);
  const pk = await w.signer(5n); const w1 = await w.signer(1n); const w2 = await w.signer(1n);
  const cfgSet = (a, d, label) => w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: a, payoutDestination: d })], [w.admin], label);
  for (const [a, d, label] of [[pk.address, w.admin.address, 'wallet = admin'], [pk.address, pk.address, 'wallet = payout key'], [pk.address, S.ADDRESSES.feeRecipient, 'wallet = FEE_RECIPIENT'],
    [w.admin.address, w1.address, 'key = admin'], [S.ADDRESSES.feeRecipient, w1.address, 'key = FEE_RECIPIENT']]) {
    await refuse(w, [w.P.launchpad()], () => cfgSet(a, d, label), 'PayoutKeyNotSeparate');
  }
  await cfgSet(pk.address, w1.address, 'payouts to W1');
  w.payoutKey = pk;
  await w.send([w.ix.optInPayout({ founder: h.founder.address, coin: h.coin, expectedDestination: w1.address, refHash: ref(1) })], [h.founder], 'opt in to W1');
  const watch = [h.coin, w1.address, w2.address, h.founder.address];
  // only to the configured wallet, which the founder agreed to
  await refuse(w, watch, () => w.payout(h, { destination: h.founder.address, label: 'payout to the founder\'s own key' }), 'DestinationMismatch');
  await refuse(w, watch, () => w.payout(h, { destination: w2.address, label: 'payout to another wallet' }), 'DestinationMismatch');
  await w.payout(h, { destination: w1.address });
  const t0 = w.coinView(h).lastPayoutAt;
  await w.buy(u, h, 5n * LAMPORTS);
  // the admin switches the wallet: the old opt-in never pays the new wallet, nor the old one
  await cfgSet(pk.address, w2.address, 'payouts to W2');
  await refuse(w, watch, () => w.payout(h, { destination: w2.address, label: 'payout to W2 under an opt-in for W1' }), 'DestinationMismatch');
  await refuse(w, watch, () => w.payout(h, { destination: w1.address, label: 'payout to W1 while W2 is configured' }), 'DestinationMismatch');
  // ... and back to W1: the opt-in names W1, so it works again (the founder's agreement never changed)
  await cfgSet(pk.address, w1.address, 'payouts back to W1');
  // X51: the cooldown lives on the Coin: re-opting, handing over, or changing the config cannot reset it
  await w.send([w.ix.revokePayoutOptIn({ by: h.founder.address, coin: h.coin, optInFounder: h.founder.address })], [h.founder], 'revoke');
  await w.send([w.ix.optInPayout({ founder: h.founder.address, coin: h.coin, expectedDestination: w1.address, refHash: ref(2) })], [h.founder], 're-opt in');
  await refuse(w, watch, () => w.payout(h, { destination: w1.address, label: 'payout after re-opting, inside 24 h' }), 'PayoutTooSoon');
  assert.equal(w.coinView(h).lastPayoutAt, t0);
  w.warpSecs(t0 + DAY - 1n - w.now());
  await refuse(w, watch, () => w.payout(h, { destination: w1.address, label: 'payout 86,399 s after' }), 'PayoutTooSoon');
  w.warpSecs(1n);
  await w.payout(h, { destination: w1.address, label: 'payout exactly 86,400 s after' });
  // the payout key may pause, never resume; claims still work; it cannot touch its own settings
  await w.buy(u, h, 5n * LAMPORTS);
  w.warpSecs(DAY);
  await w.send([w.ix.setPause({ authority: pk.address, payouts: true })], [pk], 'payout key pauses');
  await refuse(w, watch, () => w.payout(h, { destination: w1.address, label: 'payout while paused' }), 'PayoutsPaused');
  await refuse(w, [w.P.launchpad()], () => w.send([w.ix.setPause({ authority: pk.address, payouts: false })], [pk], 'payout key resumes'), 'Unauthorized');
  await refuse(w, [w.P.launchpad()], () => w.send([w.ix.setPayoutConfig({ admin: pk.address, payoutAuthority: pk.address, payoutDestination: w2.address })], [pk], 'payout key moves its wallet'), 'Unauthorized');
  await refuse(w, watch, () => w.send([w.ix.claimFounderFees({ founder: pk.address, coin: h.coin })], [pk], 'payout key claims'), 'WrongFounder');
  await w.claim(h, h.founder, { label: 'the founder claims while payouts are paused' });
  await w.send([w.ix.setPause({ authority: w.admin.address, payouts: false })], [w.admin], 'admin resumes');
  // a handed-over seat: the old founder's opt-in stops; the new founder's opt-in keeps the same cooldown
  const nf = await w.signer(1n);
  await w.send([w.ix.transferFounder({ founder: h.founder.address, newFounder: nf.address, coin: h.coin })], [h.founder, nf], 'hand over');
  await w.buy(u, h, 5n * LAMPORTS);
  await refuse(w, watch, () => w.payout(h, { destination: w1.address, label: 'payout under the old founder\'s opt-in' }), 'OptInFounderMismatch');
  await w.send([w.ix.revokePayoutOptIn({ by: nf.address, coin: h.coin, optInFounder: h.founder.address })], [nf], 'new founder revokes the old opt-in');
  await w.send([w.ix.optInPayout({ founder: nf.address, coin: h.coin, expectedDestination: w1.address, refHash: ref(3) })], [nf], 'new founder opts in');
  await w.payout(h, { destination: w1.address, label: 'payout for the new founder' });
  await w.buy(u, h, 5n * LAMPORTS);
  await refuse(w, watch, () => w.payout(h, { destination: w1.address, label: 'second payout the same day' }), 'PayoutTooSoon');
  await w.finish();
});

// ---------------------------------------------------------------- X52, X53
test('X52, X53 a stolen founder key reaches only founder_pending; a lost one leaves the share claimable by nobody else, and the coin works on', async () => {
  const w = await World.create();
  const h = await w.launchCoin({ cityId: 1990n, symbol: 'THIEF' });
  const u = await w.signer(300n);
  await w.buy(u, h, 30n * LAMPORTS);
  await w.initRewardsCity(h);
  const thief = h.founder; // the stolen key
  const c0 = w.coinView(h);
  const t0 = w.lamportsOf(thief.address);
  await w.claim(h, thief, { label: 'the thief claims' });
  assert.equal(w.lamportsOf(thief.address) - t0, c0.founderPending, 'exposure: exactly founder_pending');
  const c1 = w.coinView(h);
  assert.deepEqual([c1.platformPending, c1.holdersPending, c1.buybackPending, c1.liquidityPending], [c0.platformPending, c0.holdersPending, c0.buybackPending, c0.liquidityPending], 'no other bucket moved');
  const watch = [h.coin, h.vault, S.ADDRESSES.feeRecipient];
  await refuse(w, watch, () => w.send([w.ix.withdrawPlatformFees({ coin: h.coin, overrides: { fee_recipient: thief.address } })], [], 'thief withdraws platform fees to himself', { feePayer: thief }), 'InvalidAddress');
  await refuse(w, watch, () => w.send([w.ix.sell({ user: thief.address, coin: h.coin, userTokenAccount: S.associatedTokenAddress(u.address, h.mint), tokensIn: 1_000_000n, minSolOut: 0n })], [thief], 'thief sells a holder\'s coins'), 'WrongTokenAccount');
  // the thief moves the seat to his own second key; the admin cannot move it back (only the seat's holder can, with both signatures)
  const thief2 = await w.signer(1n);
  await w.send([w.ix.transferFounder({ founder: thief.address, newFounder: thief2.address, coin: h.coin })], [thief, thief2], 'thief moves the seat');
  await refuse(w, [h.coin], () => w.send([w.ix.transferFounder({ founder: w.admin.address, newFounder: w.admin.address, coin: h.coin })], [w.admin], 'the admin reassigns the seat'), 'WrongFounder');
  // opted-in payouts never pay the founder's own key: the thief gains nothing more through them
  const pk = await w.signer(1n); const wallet = await w.signer(1n);
  await w.send([w.ix.setPayoutConfig({ admin: w.admin.address, payoutAuthority: pk.address, payoutDestination: wallet.address })], [w.admin], 'set_payout_config');
  w.payoutKey = pk;
  await w.send([w.ix.optInPayout({ founder: thief2.address, coin: h.coin, expectedDestination: wallet.address, refHash: ref(9) })], [thief2], 'thief opts in');
  await w.buy(u, h, 5n * LAMPORTS);
  const tt = w.lamportsOf(thief2.address);
  await w.payout(h, { destination: wallet.address, label: 'payout goes to the Vicinity wallet' });
  assert.equal(w.lamportsOf(thief2.address), tt);
  // X53: the key is lost now (nobody signs for thief2): the share accrues and nobody else can take it
  await w.send([w.ix.revokePayoutOptIn({ by: thief2.address, coin: h.coin, optInFounder: thief2.address })], [thief2], 'last act before the key is lost');
  for (let k = 0; k < 3; k++) await w.buy(u, h, 3n * LAMPORTS, { label: `trade ${k} after the loss` });
  const lost = w.coinView(h).founderPending;
  assert.ok(lost > 0n);
  for (const s of [w.admin, pk, u, thief]) await refuse(w, watch, () => w.send([w.ix.claimFounderFees({ founder: s.address, coin: h.coin })], [s], `claim by ${s.address.slice(0, 6)}`), 'WrongFounder');
  await refuse(w, watch, () => w.payout(h, { destination: wallet.address, label: 'payout without an opt-in' }), 'AccountNotInitialized');
  assert.equal(w.coinView(h).founderPending, lost, 'the share waits for its key');
  // the coin works on: trades, buybacks, withdrawals, forwards, graduation
  await w.sell(u, h, w.balanceOf(u, h.mint) / 4n, { label: 'sell after the loss' });
  w.warpSlots(150n);
  await w.buyback(h); await w.withdraw(h); await w.forward(h);
  await w.buy(u, h, 100n * LAMPORTS, { label: 'graduation after the loss' });
  await w.finish();
});

// ---------------------------------------------------------------- X44b: hostile but valid configs
test('X44 the most hostile configs V1 to V11 still accept (10,000 SOL graduation, a 999-coin pool, a 0.01% fee, a 1.5% buyback with a 1% founder share, a 1% founder share with 0.01% or 0.2% left, founder and holders shares with 0.01% left) run a whole life with every invariant, round trips lose, wash trades by the founder lose (also credited the holders\' share), the founder cannot sandwich his buyback, and the buyback cap never reaches 0 (T69)', async () => {
  const w = await World.create();
  const D = S.DEFAULT_CONFIG;
  const derive = (S_, P, R) => { const [x0, y0] = S.deriveCurve(S_, P, R, 64n); return { virtualSol: x0, virtualTokens: y0, curveSupply: S_, poolSupply: P, graduationSol: R }; };
  const configs = [
    ['10,000 SOL graduation', { ...D, ...derive(D.curveSupply, D.poolSupply, 10_000_000_000_000n) }],
    ['a 999-coin pool', { ...D, ...derive(999_000_000_000_000n, 999_000_000_000n, 85_000_000_000n) }],
    ['a 0.01% fee to the platform only', { ...D, liquidityBps: 0n, platformBps: 1n, founderBps: 0n, holdersBps: 0n, buybackBps: 0n }],
    ['a 1.5% buyback and a 1% founder share', { ...D, liquidityBps: 0n, platformBps: 0n, founderBps: 100n, holdersBps: 0n, buybackBps: 150n }],
    // review ECON-1: the smallest net fee V2b leaves a founder (0.01%), and the review's second config (0.2%)
    ['a 1% founder share with 0.01% left (0, 1, 100, 0, 0)', { ...D, liquidityBps: 0n, platformBps: 1n, founderBps: 100n, holdersBps: 0n, buybackBps: 0n }],
    ['a 1% founder share with 0.2% left (0, 20, 100, 0, 0)', { ...D, liquidityBps: 0n, platformBps: 20n, founderBps: 100n, holdersBps: 0n, buybackBps: 0n }],
    // review R3-DIFF-1: the smallest net fee V2b leaves a founder who also holds the float (0.01% after both shares)
    ['founder and holders shares with 0.01% left (0, 1, 50, 50, 0)', { ...D, liquidityBps: 0n, platformBps: 1n, founderBps: 50n, holdersBps: 50n, buybackBps: 0n }],
  ];
  let city = 1995n;
  const report = [];
  for (const [label, p] of configs) {
    assert.equal(S.configRule(p), null, `${label} passes V1 to V11`);
    const id = await w.addConfig(p);
    const founder = await w.signer(0n);
    w.setRaw(founder.address, Buffer.alloc(0), S.ADDRESSES.system, 30_000n * LAMPORTS);
    const h = await w.launchCoin({ cityId: city, symbol: `HOST${city}`, configId: id, founder });
    city++;
    const terms = S.coinTerms(w.coinView(h));
    const u = await w.signer(0n);
    w.setRaw(u.address, Buffer.alloc(0), S.ADDRESSES.system, 30_000n * LAMPORTS);
    // curve: a round trip loses exactly the fees
    const b = await w.buy(u, h, 5n * LAMPORTS, { label: `${label}: buy` });
    const s = await w.sell(u, h, b.q.tokensOut, { label: `${label}: sell back` });
    assert.equal(b.q.charged - s.q.solOut, b.q.split.fee + s.q.split.fee);
    // the founder sandwiches his own coin's buyback, credited his share
    if (terms.buybackBps > 0n) {
      await w.buy(u, h, 50n * LAMPORTS, { label: `${label}: volume for a backlog` });
      w.warpSlots(150n);
      await w.claim(h, founder, { label: 'empty bucket' });
      const l0 = w.lamportsOf(founder.address);
      const fb = await w.buy(founder, h, 10n * LAMPORTS, { label: `${label}: founder front-runs` });
      await w.buyback(h, { label: `${label}: the run` });
      await w.sell(founder, h, fb.q.tokensOut, { label: `${label}: founder back-runs` });
      await w.claim(h, founder, { label: 'claim his shares' });
      const pnl = w.lamportsOf(founder.address) - l0 + w.svm.minimumBalanceForRentExemption(165n);
      assert.ok(pnl < 0n, `${label}: founder sandwich ${pnl}`);
      report.push(`${label}: founder sandwich ${(Number(pnl) / 1e9).toFixed(4)} SOL`);
    }
    // 7.4 and V2b (review ECON-1): the founder's own wash trade on the curve loses, his share of both legs credited
    // back, by at least MIN_TOTAL_FEE_BPS of each leg (with or without a buyback share)
    await w.claim(h, founder, { label: `${label}: claim before the wash trade` });
    const hadAta = w.exists(w.ata(founder.address, h.mint));
    const f0 = w.lamportsOf(founder.address);
    const fw = await w.buy(founder, h, 10n * LAMPORTS, { label: `${label}: founder wash buy` });
    const fs = await w.sell(founder, h, fw.q.tokensOut, { label: `${label}: founder wash sell` });
    await w.claim(h, founder, { label: `${label}: the founder claims his shares of the wash trade` });
    const wash = w.lamportsOf(founder.address) - f0 + (hadAta ? 0n : w.svm.minimumBalanceForRentExemption(165n));
    assert.equal(-wash, fw.q.split.fee - fw.q.split.founder + fs.q.split.fee - fs.q.split.founder, `${label}: the founder pays his net fee`);
    assert.ok(-wash >= (fw.q.charged + fs.q.solOut) * S.MIN_TOTAL_FEE_BPS / S.BPS - 2n, `${label}: at least 0.01% of each leg (${wash})`);
    // V2b as a sum (review R3-DIFF-1): even credited the whole holders' share of both legs as well (a founder holding
    // the whole float, whose wallets the rewards rounds pay), he still pays at least 0.01% of each leg
    const both = fw.q.split.fee - fw.q.split.founder - fw.q.split.holders + fs.q.split.fee - fs.q.split.founder - fs.q.split.holders;
    assert.ok(both >= (fw.q.charged + fs.q.solOut) * S.MIN_TOTAL_FEE_BPS / S.BPS - 2n, `${label}: at least 0.01% of each leg after both shares (${both})`);
    report.push(`${label}: founder wash 10 SOL ${(Number(wash) / 1e9).toFixed(6)} SOL`);
    // graduation at exactly R, then the pool: a round trip within 5.15, buybacks, every exit
    const g = await w.buy(u, h, S.maxQuoteIn(terms, S.coinState(w.coinView(h))), { label: `${label}: graduating buy` });
    assert.equal(g.q.graduates, true);
    const c = w.coinView(h);
    assert.deepEqual([c.poolSol, c.poolTokens], [terms.graduationSol, terms.poolSupply]);
    const v = await w.signer(500n);
    const pb = await w.buy(v, h, 2n * LAMPORTS, { label: `${label}: pool buy` });
    const ps = await w.sell(v, h, pb.q.tokensOut, { label: `${label}: pool sell` });
    const bound = (pb.q.charged * (S.BPS - terms.totalFeeBps) * (S.BPS - terms.totalFeeBps + 2n * terms.liquidityBps)) / (S.BPS * S.BPS) + 6n;
    assert.ok(ps.q.solOut <= bound && ps.q.solOut < pb.q.charged, `${label}: pool round trip ${ps.q.solOut} of ${pb.q.charged}`);
    w.warpSlots(150n);
    await w.buyback(h, { label: `${label}: pool buyback` });
    // the whole float sold back into the pool: the reserves stay positive and every bucket can be paid
    await w.sell(u, h, w.balanceOf(u, h.mint), { label: `${label}: everything sold back` });
    await w.withdraw(h, { label: `${label}: withdraw` });
    await w.claim(h, founder, { label: `${label}: claim` });
    const end = w.coinView(h);
    assert.ok(end.poolSol >= 1n && end.poolTokens >= 1n);
    // T69: the pool never falls below R * P / 10^15, so V4 keeps a buyback cap of at least one lamport (no stuck bucket)
    assert.ok(end.poolSol * S.COIN_SUPPLY >= terms.graduationSol * terms.poolSupply, 'pool SOL above R * P / 10^15');
    assert.ok(S.buybackCap(terms, S.coinState(end)) >= 1n, 'T69: a cap of at least one lamport');
    report.push(`${label}: pool after the float came back ${end.poolSol} lamports / ${end.poolTokens} raw units`);
  }
  console.log(`X44 hostile configs: ${report.join(' | ')}`);
  await w.finish();
});
