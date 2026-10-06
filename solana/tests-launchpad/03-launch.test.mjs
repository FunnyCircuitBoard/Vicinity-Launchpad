// TC01-TC11: the city gate (one coin per city, approved founder only) and launch.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import { generateKeyPairSigner, address, lamports } from '@solana/kit';
import {
  World, C, IDL, P, ADDRESSES, PROGRAM_IDS, DAY, SUPPLY, expectFail, assertInvariants, eventsNamed,
  decodeAccount, readMetadata, readU64, readKey, buildIx, dbc, ata,
} from './helpers.mjs';

const ZERO = PROGRAM_IDS.system;

describe('03 city gate and launch', () => {
  let w;
  before(async () => { w = await World.create(); });

  it('TC01 approve_launch is admin-only and stores its fields', async () => {
    const founder = await w.signer();
    const stranger = await w.signer();
    await expectFail(() => w.approve({ cityId: 5128581n, founder, admin: stranger }), 'Unauthorized');
    const expiresAt = w.now() + 3n * DAY;
    const res = await w.send([C.approveLaunch({ admin: w.admin.address, cityId: 5128581n, founder: founder.address, name: 'New York City Coin', symbol: 'NYC', expiresAt, dbcConfig: w.config })], [w.admin]);
    const a = decodeAccount(IDL.launchpad, 'Approval', w.account(P.approval(5128581n)).data);
    assert.equal(a.city_id.toString(), '5128581');
    assert.equal(a.founder.toBase58(), founder.address);
    assert.equal(a.dbc_config.toBase58(), w.config);
    assert.equal(a.rent_payer.toBase58(), w.admin.address);
    assert.equal(a.name, 'New York City Coin');
    assert.equal(a.symbol, 'NYC');
    assert.equal(a.expires_at.toString(), expiresAt.toString());
    const ev = eventsNamed(res, 'LaunchApproved')[0].data;
    assert.equal(ev.symbol, 'NYC');
    assert.equal(ev.founder.toBase58(), founder.address);
    // a second approval for the same city fails until the first is used or revoked
    await expectFail(() => w.approve({ cityId: 5128581n, founder }), /already in use/);
    assertInvariants(w);
  });

  it('TC02 refuses a bad expiry, a bad symbol, a bad name and a zero founder', async () => {
    const f = await w.signer();
    const send = (o) => w.send([C.approveLaunch({ admin: w.admin.address, cityId: 77n, founder: f.address, name: 'Ok', symbol: 'OK', expiresAt: w.now() + DAY, dbcConfig: w.config, ...o })], [w.admin]);
    await expectFail(() => send({ expiresAt: w.now() }), 'BadExpiry');
    await expectFail(() => send({ expiresAt: w.now() - 1n }), 'BadExpiry');
    await expectFail(() => send({ expiresAt: w.now() + 30n * DAY + 1n }), 'BadExpiry');
    await expectFail(() => send({ symbol: 'nyc' }), 'BadSymbol');
    await expectFail(() => send({ symbol: 'ABCDEFGHIJK' }), 'BadSymbol');
    await expectFail(() => send({ symbol: '' }), 'BadSymbol');
    await expectFail(() => send({ symbol: 'NY-C' }), 'BadSymbol');
    await expectFail(() => send({ name: 'x'.repeat(33) }), 'BadName');
    await expectFail(() => send({ name: '' }), 'BadName');
    await expectFail(() => send({ name: 'bad\nname' }), 'BadName');
    await expectFail(() => send({ founder: ZERO }), 'InvalidAddress');
    await send({ expiresAt: w.now() + 30n * DAY, name: 'x'.repeat(32), symbol: 'ABCDEFGHIJ' }); // the limits themselves are fine
    await w.send([C.revokeApproval({ admin: w.admin.address, cityId: 77n })], [w.admin]);
  });

  it('TC03 refuses a city that already has a coin; a coin address holding only lamports is fine', async () => {
    const coin = await w.launchCoin({ cityId: 1001n });
    const late = await w.signer();
    await expectFail(() => w.approve({ cityId: 1001n, founder: late }), 'CoinAlreadyLaunched');
    // someone pre-funds the coin address of another city: approval and launch still work
    w.svm.airdrop(address(P.coin(1002n)), lamports(5_000_000n));
    await w.launchCoin({ cityId: 1002n });
    assert.ok(coin.mint);
    assertInvariants(w);
  });

  it('TC04 revoke_approval closes it, refunds the rent, and launch then fails', async () => {
    const founder = await w.signer();
    await w.approve({ cityId: 1003n, founder });
    const rent = w.lamportsOf(P.approval(1003n));
    const before = w.lamportsOf(w.admin.address);
    const stranger = await w.signer();
    await expectFail(() => w.send([C.revokeApproval({ admin: stranger.address, cityId: 1003n })], [stranger]), 'Unauthorized');
    await expectFail(() => w.send([C.revokeApproval({ admin: w.admin.address, cityId: 1003n, rentPayer: stranger.address })], [w.admin]), 'InvalidAddress');
    const res = await w.send([C.revokeApproval({ admin: w.admin.address, cityId: 1003n })], [w.admin], 'revoke', { feePayer: w.payer });
    assert.equal(eventsNamed(res, 'ApprovalRevoked')[0].data.city_id.toString(), '1003');
    assert.equal(w.exists(P.approval(1003n)), false);
    assert.equal(w.lamportsOf(w.admin.address), before + rent);
    await expectFail(() => w.launchCoin({ cityId: 1003n, founder, approved: true }), 'AccountNotInitialized');
  });

  it('TC05 only the approved founder can launch', async () => {
    const founder = await w.signer();
    const other = await w.signer();
    await w.approve({ cityId: 1005n, founder });
    await expectFail(() => w.launchCoin({ cityId: 1005n, founder: other, approved: true }), 'WrongFounder');
    await w.launchCoin({ cityId: 1005n, founder, approved: true });
    assertInvariants(w);
  });

  it('TC06 a launch after the approval expired is refused', async () => {
    const w2 = await World.create();
    const founder = await w2.signer();
    await w2.approve({ cityId: 1006n, founder, ttl: DAY });
    w2.warp(DAY + 1n);
    await expectFail(() => w2.launchCoin({ cityId: 1006n, founder, approved: true }), 'ApprovalExpired');
  });

  it('TC07 launch is refused while launches are paused; approving still works', async () => {
    const w2 = await World.create();
    const founder = await w2.signer();
    await w2.send([C.setPause({ authority: w2.admin.address, launches: true })], [w2.admin]);
    await w2.approve({ cityId: 1007n, founder });
    await expectFail(() => w2.launchCoin({ cityId: 1007n, founder, approved: true }), 'LaunchesPaused');
    await w2.send([C.setPause({ authority: w2.admin.address, launches: false })], [w2.admin]);
    await w2.launchCoin({ cityId: 1007n, founder, approved: true });
    assertInvariants(w2);
  });

  it('TC08 a successful launch: Coin PDA creator, fixed supply, no authorities, immutable Vicinity metadata, accounts, rent, launch fee', async () => {
    const founder = await w.signer();
    await w.approve({ cityId: 5128582n, founder, name: 'New York City Coin', symbol: 'NYC' });
    const approvalRent = w.lamportsOf(P.approval(5128582n));
    const adminBefore = w.lamportsOf(w.admin.address);
    const mint = await generateKeyPairSigner();
    const ix = C.launch({ founder: founder.address, baseMint: mint.address, cityId: 5128582n, dbcConfig: w.config, quoteMint: ADDRESSES.wsol, rentPayer: w.admin.address });
    const founderBefore = w.lamportsOf(founder.address);
    const res = await w.send([ix], [founder, mint], 'launch', { feePayer: w.payer, cu: 400_000 });
    const coin = w.coin(5128582n, founder);
    // event
    const ev = eventsNamed(res, 'CoinLaunched')[0].data;
    assert.equal(ev.mint.toBase58(), mint.address);
    assert.equal(ev.dbc_pool.toBase58(), coin.dbcPool);
    // pool creator = Coin PDA
    const pool = w.pool(coin.dbcPool);
    assert.equal(pool.creator, coin.address);
    assert.equal(pool.config, w.config);
    assert.equal(pool.baseMint, mint.address);
    // mint: supply 10^15, 6 decimals, no mint or freeze authority, all of it in DBC's vault
    const m = Buffer.from(w.account(mint.address).data);
    assert.equal(m.readUInt32LE(0), 0);
    assert.equal(readU64(m, 36), SUPPLY);
    assert.equal(m[44], 6);
    assert.equal(m.readUInt32LE(46), 0);
    assert.equal(w.balance(pool.baseVault), SUPPLY);
    // metadata: exact name, symbol and mint-keyed URI, immutable, System program as update authority
    const md = readMetadata(w.account(dbc.metadata(mint.address)).data);
    assert.equal(md.name, 'New York City Coin');
    assert.equal(md.symbol, 'NYC');
    assert.equal(md.uri, `https://vicinity.city/coin-meta/${mint.address}.json`);
    assert.equal(md.isMutable, false);
    assert.equal(md.updateAuthority, ZERO);
    assert.equal(md.mint, mint.address);
    assert.equal(md.creators, 0);
    // pot and vault: WSOL token accounts owned by the Coin PDA
    for (const a of [coin.holdersPot, coin.founderVault]) {
      const d = w.account(a);
      assert.equal(String(d.programAddress), PROGRAM_IDS.token);
      assert.equal(readKey(d.data, 0), ADDRESSES.wsol);
      assert.equal(readKey(d.data, 32), coin.address);
    }
    // Coin record
    assert.equal(coin.founder, founder.address);
    assert.equal(coin.quoteMint, ADDRESSES.wsol);
    assert.equal(coin.dbcConfig, w.config);
    // approval closed, its rent back to the admin
    assert.equal(w.exists(P.approval(5128582n)), false);
    assert.equal(w.lamportsOf(w.admin.address), adminBefore + approvalRent);
    // the 0.05 SOL launch fee sits on the DBC pool account (claimable by the dev wallet, TE09)
    const poolRent = w.svm.minimumBalanceForRentExemption(BigInt(w.account(coin.dbcPool).data.length));
    assert.equal(w.lamportsOf(coin.dbcPool) - poolRent, 50_000_000n);
    // the founder paid every rent and the fee: about 0.075 SOL in total
    const spent = founderBefore - w.lamportsOf(founder.address);
    assert.ok(spent > 50_000_000n && spent < 90_000_000n, `founder spent ${spent}`);
    w.launchCost = spent;
    assertInvariants(w);
  });

  it('TC09 a second launch for the same city fails, even with a fresh approval attempt', async () => {
    const founder = await w.signer();
    await w.launchCoin({ cityId: 1009n, founder });
    await expectFail(() => w.launchCoin({ cityId: 1009n, founder, approved: true }), 'AccountNotInitialized');
    await expectFail(() => w.approve({ cityId: 1009n, founder }), 'CoinAlreadyLaunched');
  });

  it("TC10 a launch with a config other than the approval's is refused", async () => {
    const other = await w.cloneConfig(() => {});
    await w.send([C.addLaunchConfig({ admin: w.admin.address, dbcConfig: other, quoteMint: ADDRESSES.wsol })], [w.admin]);
    const founder = await w.signer();
    await w.approve({ cityId: 1010n, founder });
    const mint = await generateKeyPairSigner();
    const ix = C.launch({ founder: founder.address, baseMint: mint.address, cityId: 1010n, dbcConfig: other, quoteMint: ADDRESSES.wsol, rentPayer: w.admin.address });
    await expectFail(() => w.send([ix], [founder, mint], 'launch', { cu: 400_000 }), 'LaunchConfigMismatch', 'ConstraintSeeds');
  });

  it('TC11 a stranger can create a pool directly under the Vicinity config, but it never becomes a Vicinity coin', async () => {
    const stranger = await w.signer();
    const mint = await generateKeyPairSigner();
    const pool = dbc.pool(w.config, mint.address, ADDRESSES.wsol);
    const ix = buildIx(IDL.dbc, 'initialize_virtual_pool_with_spl_token', { params: { name: 'New York City Coin', symbol: 'NYC', uri: 'https://vicinity.city/coin-meta/fake.json' } }, {
      config: w.config, creator: stranger.address, base_mint: mint.address, quote_mint: ADDRESSES.wsol, pool,
      base_vault: dbc.tokenVault(mint.address, pool), quote_vault: dbc.tokenVault(ADDRESSES.wsol, pool),
      mint_metadata: dbc.metadata(mint.address), payer: stranger.address, token_quote_program: PROGRAM_IDS.token,
      event_authority: dbc.eventAuthority(), program: PROGRAM_IDS.dbc,
    });
    await w.send([ix], [stranger, mint], 'stranger direct pool', { cu: 400_000 });
    assert.equal(w.pool(pool).creator, stranger.address);
    // no Coin for it: the registry is the only source of truth
    const coins = w.svm.getProgramAccounts(address(PROGRAM_IDS.launchpad))
      .filter((a) => Buffer.from(a.data).subarray(0, 8).equals(Buffer.from(IDL.launchpad.accounts.find((x) => x.name === 'Coin').discriminator)))
      .map((a) => decodeAccount(IDL.launchpad, 'Coin', a.data));
    assert.equal(C.isVicinityCoin(coins, pool), false);
    const real = coins[0];
    assert.equal(C.isVicinityCoin(coins, real.dbc_pool.toBase58()), true);
    // harvesting the stranger's pool through a real coin is impossible
    const realCoin = w.coin(BigInt(real.city_id.toString()));
    await expectFail(() => w.send([C.harvestCurveFees({ payer: w.payer.address, coin: { ...realCoin, dbcPool: pool } })]), 'PoolCreatorMismatch');
    assertInvariants(w);
  });
});
