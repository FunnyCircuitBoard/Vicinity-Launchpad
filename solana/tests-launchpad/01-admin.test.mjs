// TA01-TA07: init, admin transfer, the dev-wallet constant, payout settings, pause.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import { World, C, IDL, P, Role, ADDRESSES, PROGRAM_IDS, expectFail, assertInvariants, eventsNamed, buildIx } from './helpers.mjs';
import { programDataAddress } from '../sdk/launchpad/pda.mjs';

const ZERO = PROGRAM_IDS.system;
const fresh = () => World.create({ initLaunchpad: false, addConfig: false, initRewards: false });

describe('01 admin', () => {
  it('TA01 init_launchpad refuses a signer that is not the upgrade authority', async () => {
    const w = await fresh();
    const impostor = await w.signer();
    await expectFail(() => w.send([C.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: impostor.address })], [w.admin, impostor]), 'NotUpgradeAuthority');
    assert.equal(w.exists(P.launchpad()), false);
  });

  it("TA02 init_launchpad refuses another program's real ProgramData (same upgrade authority)", async () => {
    const w = await fresh();
    // vicinity_rewards is also upgradeable with `deployer` as authority: only the
    // address binding can refuse its ProgramData.
    await expectFail(() => w.send([C.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, programData: programDataAddress(PROGRAM_IDS.rewards) })], [w.admin, w.deployer]), 'NotUpgradeAuthority');
    // and a random system account in its place
    const rnd = await w.signer();
    await expectFail(() => w.send([C.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, programData: rnd.address })], [w.admin, w.deployer]), 'NotUpgradeAuthority');
  });

  it('TA03 init_launchpad needs the admin signature and an executable rewards program; a second init fails', async () => {
    const w = await fresh();
    const ix = C.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address });
    ix.accounts[1].role = Role.R; // admin not signing
    await expectFail(() => w.send([ix], [w.deployer]), 'AccountNotSigner', /missing required signature/i);
    const notAProgram = await w.signer();
    await expectFail(() => w.send([C.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address, rewardsProgram: notAProgram.address })], [w.admin, w.deployer]), 'InvalidAddress');
    const res = await w.send([C.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address })], [w.admin, w.deployer]);
    const ev = eventsNamed(res, 'LaunchpadInitialized')[0];
    assert.equal(ev.data.admin.toBase58(), w.admin.address);
    assert.equal(ev.data.rewards_program.toBase58(), PROGRAM_IDS.rewards);
    const lp = w.launchpad();
    assert.equal(lp.admin.toBase58(), w.admin.address);
    assert.equal(lp.pending_admin.toBase58(), ZERO);
    assert.equal(lp.payout_authority.toBase58(), ZERO);
    assert.equal(lp.payout_destination.toBase58(), ZERO);
    assert.equal(lp.launches_paused, false);
    assert.equal(lp.payouts_paused, false);
    await expectFail(() => w.send([C.initLaunchpad({ payer: w.payer.address, admin: w.admin.address, upgradeAuthority: w.deployer.address })], [w.admin, w.deployer]), /already in use/);
    assertInvariants(w);
  });

  it('TA04 two-step admin transfer: only the admin proposes, only the proposed key accepts, zero cancels', async () => {
    const w = await World.create({ addConfig: false, initRewards: false });
    const next = await w.signer();
    const stranger = await w.signer();
    await expectFail(() => w.send([C.acceptAdmin({ newAdmin: next.address })], [next]), 'NoPendingAdmin');
    await expectFail(() => w.send([C.proposeAdmin({ admin: stranger.address, newAdmin: stranger.address })], [stranger]), 'Unauthorized');
    let res = await w.send([C.proposeAdmin({ admin: w.admin.address, newAdmin: next.address })], [w.admin]);
    assert.equal(eventsNamed(res, 'AdminProposed')[0].data.pending_admin.toBase58(), next.address);
    await expectFail(() => w.send([C.acceptAdmin({ newAdmin: stranger.address })], [stranger]), 'NotPendingAdmin');
    // zero cancels
    await w.send([C.proposeAdmin({ admin: w.admin.address, newAdmin: ZERO })], [w.admin]);
    await expectFail(() => w.send([C.acceptAdmin({ newAdmin: next.address })], [next]), 'NoPendingAdmin');
    await w.send([C.proposeAdmin({ admin: w.admin.address, newAdmin: next.address })], [w.admin]);
    res = await w.send([C.acceptAdmin({ newAdmin: next.address })], [next]);
    const ev = eventsNamed(res, 'AdminChanged')[0].data;
    assert.equal(ev.old_admin.toBase58(), w.admin.address);
    assert.equal(ev.new_admin.toBase58(), next.address);
    assert.equal(w.launchpad().admin.toBase58(), next.address);
    assert.equal(w.launchpad().pending_admin.toBase58(), ZERO);
    // the old admin has lost every power
    await expectFail(() => w.send([C.setPause({ authority: w.admin.address, launches: true })], [w.admin]), 'Unauthorized');
    assertInvariants(w);
  });

  it('TA05 the dev wallet is the program constant FEE_RECIPIENT, and no instruction can change it or withdraw', () => {
    const c = IDL.launchpad.constants.find((k) => k.name === 'FEE_RECIPIENT');
    assert.equal(c.value, ADDRESSES.feeRecipient);
    const names = IDL.launchpad.instructions.map((i) => i.name).sort();
    assert.deepEqual(names, [
      'accept_admin', 'add_launch_config', 'approve_launch', 'claim_founder_fees', 'forward_holders_fees',
      'harvest_curve_fees', 'harvest_pool_fees', 'init_launchpad', 'launch', 'opt_in_payout', 'payout_founder_fees',
      'propose_admin', 'revoke_approval', 'revoke_payout_opt_in', 'set_launch_config_enabled', 'set_pause',
      'set_payout_config', 'transfer_founder',
    ]);
    assert.ok(!names.some((n) => /fee_recipient|withdraw|sweep|drain|set_founder/.test(n)));
    const lpFields = IDL.launchpad.types.find((t) => t.name === 'Launchpad').type.fields.map((f) => f.name);
    assert.ok(!lpFields.includes('fee_recipient') && !lpFields.includes('coin_count'));
  });

  it('TA06 set_payout_config: admin only, keys kept separate, both or neither', async () => {
    const w = await World.create({ addConfig: false, initRewards: false });
    const key = await w.signer();
    const wallet = await w.signer();
    const stranger = await w.signer();
    const set = (a, d, s = w.admin) => w.send([C.setPayoutConfig({ admin: s.address, payoutAuthority: a, payoutDestination: d })], [s]);
    await expectFail(() => set(key.address, wallet.address, stranger), 'Unauthorized');
    await expectFail(() => set(w.admin.address, wallet.address), 'PayoutKeyNotSeparate');
    await expectFail(() => set(ADDRESSES.feeRecipient, wallet.address), 'PayoutKeyNotSeparate');
    await expectFail(() => set(key.address, key.address), 'PayoutKeyNotSeparate');
    await expectFail(() => set(key.address, w.admin.address), 'PayoutKeyNotSeparate');
    await expectFail(() => set(key.address, ZERO), 'InvalidAddress');
    await expectFail(() => set(ZERO, wallet.address), 'InvalidAddress');
    const res = await set(key.address, wallet.address);
    const ev = eventsNamed(res, 'PayoutConfigChanged')[0].data;
    assert.equal(ev.old_authority.toBase58(), ZERO);
    assert.equal(ev.new_authority.toBase58(), key.address);
    assert.equal(ev.new_destination.toBase58(), wallet.address);
    assert.equal(w.launchpad().payout_authority.toBase58(), key.address);
    assertInvariants(w);
    await set(ZERO, ZERO); // off again
    assert.equal(w.launchpad().payout_authority.toBase58(), ZERO);
    assert.equal(w.launchpad().payout_destination.toBase58(), ZERO);
  });

  it('TA07 set_pause: admin sets both flags; the payout key may only pause payouts', async () => {
    const w = await World.create({ addConfig: false, initRewards: false });
    const key = await w.signer();
    const wallet = await w.signer();
    const stranger = await w.signer();
    await w.send([C.setPayoutConfig({ admin: w.admin.address, payoutAuthority: key.address, payoutDestination: wallet.address })], [w.admin]);
    let res = await w.send([C.setPause({ authority: w.admin.address, launches: true, payouts: true })], [w.admin]);
    let ev = eventsNamed(res, 'PauseChanged')[0].data;
    assert.deepEqual([ev.launches_paused, ev.payouts_paused, ev.by.toBase58()], [true, true, w.admin.address]);
    await w.send([C.setPause({ authority: w.admin.address, launches: false, payouts: false })], [w.admin]);
    res = await w.send([C.setPause({ authority: key.address, payouts: true })], [key]);
    ev = eventsNamed(res, 'PauseChanged')[0].data;
    assert.deepEqual([ev.launches_paused, ev.payouts_paused, ev.by.toBase58()], [false, true, key.address]);
    await expectFail(() => w.send([C.setPause({ authority: key.address, payouts: false })], [key]), 'Unauthorized');
    await expectFail(() => w.send([C.setPause({ authority: key.address, launches: true })], [key]), 'Unauthorized');
    await expectFail(() => w.send([C.setPause({ authority: key.address, launches: true, payouts: true })], [key]), 'Unauthorized');
    await expectFail(() => w.send([C.setPause({ authority: stranger.address, payouts: true })], [stranger]), 'Unauthorized');
    assert.equal(w.launchpad().payouts_paused, true);
    await w.send([C.setPause({ authority: w.admin.address, payouts: false })], [w.admin]);
    assert.equal(w.launchpad().payouts_paused, false);
    // with payouts switched off, the old payout key is just a stranger
    await w.send([C.setPayoutConfig({ admin: w.admin.address, payoutAuthority: ZERO, payoutDestination: ZERO })], [w.admin]);
    await expectFail(() => w.send([C.setPause({ authority: key.address, payouts: true })], [key]), 'Unauthorized');
    assertInvariants(w);
  });
});
