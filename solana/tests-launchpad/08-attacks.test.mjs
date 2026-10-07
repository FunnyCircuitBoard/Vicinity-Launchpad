// TH01-TH12: the Sealevel attack classes, table-driven over every instruction.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import { generateKeyPairSigner, address, lamports } from '@solana/kit';
import { World, C, IDL, P, R, ADDRESSES, PROGRAM_IDS, LAMPORTS, DAY, expectFail, assertInvariants, harvest, ata, Role, decodeAccount, tokenAccountData } from './helpers.mjs';
import { programDataAddress } from '../sdk/launchpad/pda.mjs';

const WSOL = ADDRESSES.wsol;
const rnd = () => web3.Keypair.generate().publicKey.toBase58();
const REF = new Uint8Array(32).fill(3);

describe('08 attack classes', () => {
  let w, founder, coin, coinB, payoutKey, payoutWallet, stranger, ix;
  before(async () => {
    w = await World.create();
    founder = await w.signer();
    coin = await w.launchCoin({ cityId: 800001n, founder });
    coinB = await w.launchCoin({ cityId: 800002n });
    await w.initRewardsCity(coin);
    await w.initRewardsCity(coinB);
    const t = await w.signer();
    await w.trade(t, coin, { side: 'buy', amount0: 4n * LAMPORTS, amount1: 1n });
    await w.trade(t, coinB, { side: 'buy', amount0: 4n * LAMPORTS, amount1: 1n });
    await harvest(w, coin);
    await harvest(w, coinB);
    payoutKey = await w.signer();
    payoutWallet = await w.signer();
    stranger = await w.signer();
    await w.send([C.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: payoutWallet.address })], [w.admin]);
    await w.send([C.optInPayout({ founder: founder.address, cityId: coin.cityId, expectedDestination: payoutWallet.address, refHash: REF })], [founder]);
    await w.approve({ cityId: 800003n, founder });
    // one builder per instruction, with the legitimate signer(s)
    ix = {
      propose_admin: () => [C.proposeAdmin({ admin: w.admin.address, newAdmin: stranger.address }), [w.admin]],
      set_payout_config: () => [C.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: payoutWallet.address }), [w.admin]],
      set_pause: () => [C.setPause({ authority: w.admin.address, payouts: false }), [w.admin]],
      set_launch_config_enabled: () => [C.setLaunchConfigEnabled({ admin: w.admin.address, dbcConfig: w.config, enabled: true }), [w.admin]],
      approve_launch: () => [C.approveLaunch({ admin: w.admin.address, cityId: 800099n, founder: founder.address, name: 'X', symbol: 'X', expiresAt: w.now() + DAY, dbcConfig: w.config }), [w.admin]],
      revoke_approval: () => [C.revokeApproval({ admin: w.admin.address, cityId: 800003n }), [w.admin]],
      claim_founder_fees: () => [C.claimFounderFees({ founder: founder.address, coin }), [founder]],
      transfer_founder: () => [C.transferFounder({ founder: founder.address, newFounder: stranger.address, cityId: coin.cityId }), [founder, stranger]],
      opt_in_payout: () => [C.optInPayout({ founder: founder.address, cityId: coin.cityId, expectedDestination: payoutWallet.address, refHash: REF }), [founder]],
      revoke_payout_opt_in: () => [C.revokePayoutOptIn({ by: founder.address, cityId: coin.cityId, optInFounder: founder.address }), [founder]],
      payout_founder_fees: () => [C.payoutFounderFees({ payoutAuthority: payoutKey.address, coin, destination: payoutWallet.address }), [payoutKey]],
    };
  });

  it('TH01 signer authorization: every signer-gated instruction fails when its signer does not sign', async () => {
    let n = 0;
    for (const [name, make] of Object.entries(ix)) {
      const [instr, signers] = make();
      for (let i = 0; i < instr.accounts.length; i++) {
        const a = instr.accounts[i];
        if (a.role < 2 || a.address === w.payer.address) continue;
        const forged = { ...instr, accounts: instr.accounts.map((x, j) => (j === i ? { ...x, role: x.role & 1 } : x)) };
        const others = signers.filter((s) => s.address !== a.address);
        await expectFail(() => w.send([forged], others, name), 'AccountNotSigner', /missing required signature/i);
        n++;
      }
    }
    // the same with the right shape but the wrong key signing
    await expectFail(() => w.send([C.proposeAdmin({ admin: stranger.address, newAdmin: stranger.address })], [stranger]), 'Unauthorized');
    await expectFail(() => w.send([C.claimFounderFees({ founder: stranger.address, coin })], [stranger]), 'WrongFounder');
    await expectFail(() => w.send([C.payoutFounderFees({ payoutAuthority: stranger.address, coin, destination: payoutWallet.address })], [stranger]), 'Unauthorized');
    const m0 = await generateKeyPairSigner();
    await expectFail(() => w.send([C.launch({ founder: stranger.address, baseMint: m0.address, cityId: 800003n, dbcConfig: w.config, quoteMint: WSOL, rentPayer: w.admin.address })], [stranger, m0], 'launch', { cu: 400_000 }), 'WrongFounder');
    assert.ok(n >= 12, `${n} signer cases`);
    assertInvariants(w);
  });

  it('TH02 account data matching: wrong mint, quote, pool, config, vault, position', async () => {
    const h = (overrides) => w.send([C.harvestCurveFees({ payer: w.payer.address, coin, overrides })]);
    await expectFail(() => h({ base_mint: coinB.mint }), 'PoolCreatorMismatch', 'ConstraintTokenMint');
    await expectFail(() => h({ quote_mint: coin.mint }), 'LaunchConfigMismatch');
    await expectFail(() => h({ dbc_pool: coinB.dbcPool }), 'PoolCreatorMismatch');
    await expectFail(() => h({ dbc_quote_vault: R.vault(R.city(coin.mint)) }), /ConstraintHasOne|ConstraintTokenMint|2001|Error/);
    // (Anchor creates a missing associated token account before checking the
    // other accounts, so these may also stop at the ATA creation; either way
    // nothing moves)
    const vaultBefore = w.balance(coin.founderVault);
    await expectFail(() => w.send([C.claimFounderFees({ founder: founder.address, coin, overrides: { quote_mint: coin.mint } })], [founder]), 'LaunchConfigMismatch', 'ConstraintAssociated', /account required by the instruction is missing/);
    await expectFail(() => w.send([C.payoutFounderFees({ payoutAuthority: payoutKey.address, coin, destination: payoutWallet.address, overrides: { quote_mint: coin.mint } })], [payoutKey]), 'LaunchConfigMismatch', 'ConstraintAssociated', /account required by the instruction is missing/);
    assert.equal(w.balance(coin.founderVault), vaultBefore);
    await expectFail(() => w.send([C.forwardHoldersFees({ coin, overrides: { quote_mint: coin.mint } })]), 'LaunchConfigMismatch', 'ConstraintTokenMint');
    // launch with a quote mint other than the config's
    const m = await generateKeyPairSigner();
    const l = C.launch({ founder: founder.address, baseMint: m.address, cityId: 800003n, dbcConfig: w.config, quoteMint: coin.mint, rentPayer: w.admin.address });
    await expectFail(() => w.send([l], [founder, m], 'launch', { cu: 400_000 }), 'LaunchConfigMismatch', 'ConstraintTokenMint');
    // add_launch_config with the wrong quote mint
    const cfg = await w.cloneConfig(() => {});
    await expectFail(() => w.send([C.addLaunchConfig({ admin: w.admin.address, dbcConfig: cfg, quoteMint: coin.mint })], [w.admin]), 'LaunchConfigMismatch');
  });

  it('TH03 owner checks: look-alike accounts owned by another program are refused', async () => {
    // a Coin-shaped account at a fresh address owned by the token program cannot be used (seeds and owner)
    const fake = rnd();
    w.setRaw(fake, Buffer.from(w.account(coin.address).data), PROGRAM_IDS.token);
    await expectFail(() => w.send([C.claimFounderFees({ founder: founder.address, coin, overrides: { coin: fake } })], [founder]), 'ConstraintSeeds', 'AccountOwnedByWrongProgram');
    // the real Launchpad PDA rewritten with a foreign owner is refused by Anchor's owner check
    const lp = w.account(P.launchpad());
    w.setRaw(P.launchpad(), Buffer.from(lp.data), PROGRAM_IDS.token, BigInt(lp.lamports));
    const [sp, spSigners] = ix.set_pause();
    await expectFail(() => w.send([sp], spSigners), 'AccountOwnedByWrongProgram');
    w.setRaw(P.launchpad(), Buffer.from(lp.data), PROGRAM_IDS.launchpad, BigInt(lp.lamports));
    // DAMM accounts must be owned by DAMM (AccountLoader)
    await expectFail(() => w.send([C.harvestPoolFees({ payer: w.payer.address, coin, dammPool: coin.dbcPool, positionNftMint: rnd() })]), 'AccountOwnedByWrongProgram', 'AccountNotInitialized');
  });

  it('TH04 type cosplay: one of our accounts placed where another type is expected', async () => {
    const coinData = Buffer.from(w.account(coin.address).data);
    const optIn = P.payoutOptIn(coinB.address);
    // a Coin's bytes at coin B's PayoutOptIn address (owned by us): the discriminator refuses it
    w.setRaw(optIn, coinData.subarray(0, 145), PROGRAM_IDS.launchpad);
    await expectFail(() => w.send([C.payoutFounderFees({ payoutAuthority: payoutKey.address, coin: coinB, destination: payoutWallet.address })], [payoutKey]), 'AccountDiscriminatorMismatch');
    w.svm.setAccount({ ...w.account(optIn), address: address(optIn), lamports: lamports(0n), data: new Uint8Array(0), space: 0n, programAddress: address(PROGRAM_IDS.system) });
    // a Coin as the Approval of a city
    w.setRaw(P.approval(800004n), coinData.subarray(0, 179), PROGRAM_IDS.launchpad);
    const m = await generateKeyPairSigner();
    await expectFail(() => w.send([C.launch({ founder: founder.address, baseMint: m.address, cityId: 800004n, dbcConfig: w.config, quoteMint: WSOL, rentPayer: w.admin.address })], [founder, m], 'launch', { cu: 400_000 }), 'AccountDiscriminatorMismatch');
    // a Coin as a LaunchConfig
    w.setRaw(P.launchConfig(coin.address), coinData.subarray(0, 106), PROGRAM_IDS.launchpad);
    await expectFail(() => w.send([C.setLaunchConfigEnabled({ admin: w.admin.address, dbcConfig: coin.address, enabled: true })], [w.admin]), 'AccountDiscriminatorMismatch');
    // remove the planted look-alikes again
    for (const a of [P.approval(800004n), P.launchConfig(coin.address)]) {
      w.svm.setAccount({ address: address(a), lamports: lamports(0n), data: new Uint8Array(0), space: 0n, programAddress: address(PROGRAM_IDS.system), executable: false });
    }
  });

  it('TH05 re-initialisation is impossible', async () => {
    await expectFail(() => w.send([C.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address })], [w.admin, w.deployer]), /already in use/);
    await expectFail(() => w.send([C.addLaunchConfig({ admin: w.admin.address, dbcConfig: w.config, quoteMint: WSOL })], [w.admin]), /already in use/);
    const [oi, oiSigners] = ix.opt_in_payout();
    await expectFail(() => w.send([oi], oiSigners), /already in use/);
    await expectFail(() => w.approve({ cityId: 800003n, founder }), /already in use/);
  });

  it('TH06 arbitrary CPI: fake DBC, DAMM v2, Metaplex or token program ids are refused', async () => {
    const swapProg = (instr, name, to) => ({ ...instr, accounts: instr.accounts.map((a, i) => (IDL.launchpad.instructions.find((x) => x.name === name).accounts[i].name === to.field ? { ...a, address: to.addr } : a)) });
    const hv = C.harvestCurveFees({ payer: w.payer.address, coin });
    await expectFail(() => w.send([swapProg(hv, 'harvest_curve_fees', { field: 'dbc_program', addr: PROGRAM_IDS.damm })]), 'InvalidProgramId');
    await expectFail(() => w.send([swapProg(hv, 'harvest_curve_fees', { field: 'token_program', addr: PROGRAM_IDS.token2022 })]), 'InvalidProgramId');
    const m = await generateKeyPairSigner();
    const l = C.launch({ founder: founder.address, baseMint: m.address, cityId: 800003n, dbcConfig: w.config, quoteMint: WSOL, rentPayer: w.admin.address });
    await expectFail(() => w.send([swapProg(l, 'launch', { field: 'dbc_program', addr: PROGRAM_IDS.launchpad })], [founder, m], 'launch', { cu: 400_000 }), 'InvalidProgramId');
    await expectFail(() => w.send([swapProg(l, 'launch', { field: 'metadata_program', addr: PROGRAM_IDS.token })], [founder, m], 'launch', { cu: 400_000 }), 'InvalidAddress');
    const hp = C.harvestPoolFees({ payer: w.payer.address, coin, dammPool: coin.dbcPool, positionNftMint: rnd() });
    await expectFail(() => w.send([swapProg(hp, 'harvest_pool_fees', { field: 'damm_program', addr: PROGRAM_IDS.dbc })]), 'InvalidProgramId', 'AccountOwnedByWrongProgram', 'AccountNotInitialized');
  });

  it('TH07 duplicate mutable accounts: the pot as the vault, the vault as a destination', async () => {
    await expectFail(() => w.send([C.harvestCurveFees({ payer: w.payer.address, coin, overrides: { founder_vault: coin.holdersPot } })]), 'ConstraintSeeds');
    await expectFail(() => w.send([C.harvestCurveFees({ payer: w.payer.address, coin, overrides: { holders_pot: coin.founderVault } })]), 'ConstraintSeeds');
    await expectFail(() => w.send([C.claimFounderFees({ founder: founder.address, coin, overrides: { founder_token_account: coin.founderVault } })], [founder]), 'ConstraintAssociated', /AccountNotAssociatedTokenAccount|ConstraintTokenOwner/);
    await expectFail(() => w.send([C.payoutFounderFees({ payoutAuthority: payoutKey.address, coin, destination: payoutWallet.address, overrides: { destination_token_account: coin.founderVault } })], [payoutKey]), 'ConstraintAssociated', /AccountNotAssociatedTokenAccount|ConstraintTokenOwner/);
    await expectFail(() => w.send([C.forwardHoldersFees({ coin, overrides: { rewards_vault: coin.holdersPot } })]), 'WrongRewardsVault');
  });

  it('TH08 every stored bump is the canonical one', () => {
    const c = decodeAccount(IDL.launchpad, 'Coin', w.account(coin.address).data);
    const pk = (s) => new web3.PublicKey(s);
    const prog = pk(PROGRAM_IDS.launchpad);
    const u = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
    assert.equal(c.bump, web3.PublicKey.findProgramAddressSync([Buffer.from('coin'), u(coin.cityId)], prog)[1]);
    assert.equal(c.holders_pot_bump, web3.PublicKey.findProgramAddressSync([Buffer.from('holders_pot'), pk(coin.address).toBuffer()], prog)[1]);
    assert.equal(c.founder_vault_bump, web3.PublicKey.findProgramAddressSync([Buffer.from('founder_vault'), pk(coin.address).toBuffer()], prog)[1]);
    assert.equal(w.launchpad().bump, web3.PublicKey.findProgramAddressSync([Buffer.from('launchpad')], prog)[1]);
    const o = decodeAccount(IDL.launchpad, 'PayoutOptIn', w.account(P.payoutOptIn(coin.address)).data);
    assert.equal(o.bump, web3.PublicKey.findProgramAddressSync([Buffer.from('payout_opt_in'), pk(coin.address).toBuffer()], prog)[1]);
  });

  it("TH09 PDA sharing: one coin's PDA and accounts cannot act for another", async () => {
    const other = { ...coinB };
    await expectFail(() => w.send([C.claimFounderFees({ founder: founder.address, coin: { ...coin, cityId: coinB.cityId } })], [founder]), 'WrongFounder', 'ConstraintSeeds');
    await expectFail(() => w.send([C.claimFounderFees({ founder: founder.address, coin, overrides: { founder_vault: other.founderVault } })], [founder]), 'ConstraintSeeds');
    await expectFail(() => w.send([C.forwardHoldersFees({ coin, overrides: { holders_pot: other.holdersPot } })]), 'ConstraintSeeds');
    await expectFail(() => w.send([C.payoutFounderFees({ payoutAuthority: payoutKey.address, coin: other, destination: payoutWallet.address, overrides: { opt_in: P.payoutOptIn(coin.address) } })], [payoutKey]), 'ConstraintSeeds');
  });

  it('TH10 closed accounts cannot be revived by sending them lamports', async () => {
    await w.send([C.revokeApproval({ admin: w.admin.address, cityId: 800003n })], [w.admin]);
    w.svm.airdrop(address(P.approval(800003n)), lamports(10_000_000n));
    const m = await generateKeyPairSigner();
    await expectFail(() => w.send([C.launch({ founder: founder.address, baseMint: m.address, cityId: 800003n, dbcConfig: w.config, quoteMint: WSOL, rentPayer: w.admin.address })], [founder, m], 'launch', { cu: 400_000 }), 'AccountNotInitialized', 'AccountOwnedByWrongProgram');
  });

  it('TH11 no sysvar accounts are accepted anywhere (time comes from Clock::get)', () => {
    for (const i of IDL.launchpad.instructions) {
      for (const a of i.accounts) {
        assert.ok(!/sysvar|^rent$|^clock$|instructions/i.test(a.name), `${i.name}.${a.name}`);
        assert.ok(!String(a.address ?? '').startsWith('Sysvar'), `${i.name}.${a.name}`);
      }
    }
  });

  it('TH12 no instruction can pay the admin or the dev wallet: review table and substitution tests', async () => {
    // (1) review table over the IDL: every account a signed transfer could reach
    const destinations = {
      harvest_curve_fees: ['founder_vault'], harvest_pool_fees: ['founder_vault'], forward_holders_fees: ['rewards_vault'],
      claim_founder_fees: ['founder_token_account'], payout_founder_fees: ['destination_token_account'],
    };
    for (const i of IDL.launchpad.instructions) {
      const writableTokenish = i.accounts.filter((a) => a.writable && /vault|pot|token_account|_account$/.test(a.name)).map((a) => a.name);
      for (const n of writableTokenish) {
        const allowed = ['holders_pot', 'founder_vault', 'rewards_vault', 'founder_token_account', 'destination_token_account', 'coin_base_account', 'dbc_base_vault', 'dbc_quote_vault', 'token_a_vault', 'token_b_vault'];
        assert.ok(allowed.includes(n), `${i.name}.${n} is a writable token account outside the review table`);
      }
      if (destinations[i.name]) for (const d of destinations[i.name]) assert.ok(i.accounts.some((a) => a.name === d), `${i.name} has ${d}`);
    }
    // (2) substitutions: the admin's and the dev wallet's own token accounts in every destination slot
    for (const owner of [w.admin.address, ADDRESSES.feeRecipient]) {
      const acct = w.emptyTokenAccount(owner, WSOL);
      await expectFail(() => w.send([C.harvestCurveFees({ payer: w.payer.address, coin, overrides: { founder_vault: acct } })]), 'ConstraintSeeds');
      await expectFail(() => w.send([C.harvestCurveFees({ payer: w.payer.address, coin, overrides: { holders_pot: acct } })]), 'ConstraintSeeds');
      await expectFail(() => w.send([C.forwardHoldersFees({ coin, overrides: { rewards_vault: acct } })]), 'WrongRewardsVault');
      await expectFail(() => w.send([C.claimFounderFees({ founder: founder.address, coin, overrides: { founder_token_account: acct } })], [founder]), 'ConstraintAssociated', /AccountNotAssociatedTokenAccount|ConstraintTokenOwner/);
      await expectFail(() => w.send([C.payoutFounderFees({ payoutAuthority: payoutKey.address, coin, destination: payoutWallet.address, overrides: { destination_token_account: acct } })], [payoutKey]), 'ConstraintAssociated', /AccountNotAssociatedTokenAccount|ConstraintTokenOwner/);
      await expectFail(() => w.send([C.payoutFounderFees({ payoutAuthority: payoutKey.address, coin, destination: owner })], [payoutKey]), 'DestinationMismatch');
    }
    // the payout wallet itself can never be set to the admin or the payout key (TA06), and the
    // money that did move only ever went to the founder, the city vault or the payout wallet
    assertInvariants(w);
  });
});
