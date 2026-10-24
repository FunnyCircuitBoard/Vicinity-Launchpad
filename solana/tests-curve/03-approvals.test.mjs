// L04: approve_launch (each check and error, in the order of 4.8), revoke_approval
// by the admin and by anyone after expiry (refused before expiry for others),
// the coin and ticker checks, and the checks against the old program (8.5): an
// old-program Approval and Coin created by the real old vicinity_launchpad (its
// mainnet binary), its launches open or paused, and a wrong-owner, wrong-size or
// missing account at LEGACY_LAUNCHPAD, or one whose admin is not this program's admin
// (GOV-1; tests-curve/28-governance.test.mjs runs the real old program's hand-over).
import test from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import { World, S, expectFail, metaHash, DAY } from './helpers.mjs';

const pkb = (a) => new web3.PublicKey(String(a)).toBuffer();

const ZERO = S.ADDRESSES.system;

function approveIx(w, o) {
  return w.ix.approveLaunch({
    admin: w.admin.address, cityId: 7n, founder: o.founder, configId: 0, name: 'Paris', symbol: 'PAR', metaHash: metaHash('paris'), expiresAt: w.now() + DAY, ...o,
  });
}

test('L04 approve_launch: every check and its error; the approval written; one per city', async () => {
  const w = await World.create();
  const founder = await w.signer(); const stranger = await w.signer();
  const send = (o, signers = [w.admin], label = 'approve') => w.send([approveIx(w, { founder: founder.address, ...o })], signers, label);
  await expectFail(() => send({ admin: stranger.address }, [stranger], 'by a stranger'), 'Unauthorized');
  await expectFail(() => send({ cityId: 0n }), 'BadCityId');
  await expectFail(() => send({ founder: ZERO }), 'InvalidAddress');
  for (const name of ['', 'x'.repeat(33), 'Bad\nName', 'Par‮is', 'Pa​ris', '\u0000']) {
    await expectFail(() => send({ name }, [w.admin], `name ${JSON.stringify(name)}`), 'BadName');
  }
  for (const symbol of ['', 'par', 'PA R', 'ABCDEFGHIJK', 'P-R', 'PÄR']) {
    await expectFail(() => send({ symbol }, [w.admin], `symbol ${JSON.stringify(symbol)}`), 'BadSymbol');
  }
  // a symbol longer than 32 bytes fails the ticker seed before check_symbol (4.8 notes): still refused
  await expectFail(() => send({ symbol: 'A'.repeat(33), overrides: { ticker_lock: S.findPda([Buffer.from('ticker'), Buffer.from('A'.repeat(32))], w.programId)[0] } }),
    /MaxSeedLengthExceeded|ConstraintSeeds|seed/i);
  await expectFail(() => send({ metaHash: Array(32).fill(0) }), 'BadMetaHash');
  await expectFail(() => send({ expiresAt: w.now() }), 'BadExpiry');
  await expectFail(() => send({ expiresAt: w.now() - 1n }), 'BadExpiry');
  await expectFail(() => send({ expiresAt: w.now() + S.APPROVAL_MAX_SECS + 1n }), 'BadExpiry');
  // the edge: exactly 30 days
  const expiresAt = w.now() + S.APPROVAL_MAX_SECS;
  const r = await send({ expiresAt, name: 'Paris', symbol: 'PAR' });
  const ap = w.approval(7n);
  assert.deepEqual([ap.cityId, ap.founder, ap.configId, ap.rentPayer, ap.name, ap.symbol, ap.approvedAt, ap.expiresAt],
    [7n, founder.address, 0, w.admin.address, 'Paris', 'PAR', w.now(), expiresAt]);
  assert.deepEqual([...ap.metaHash], metaHash('paris'));
  assert.equal(w.accountInfo(w.P.approval(7n)).data.length, S.ACCOUNT_LEN.Approval);
  const ev = r.events.find((e) => e.name === 'LaunchApproved').data;
  assert.deepEqual([ev.city_id, ev.founder, ev.config_id, ev.name, ev.symbol, ev.expires_at], [7n, founder.address, 0n, 'Paris', 'PAR', expiresAt]);
  // a second approval for the same city fails at init until the first is used or revoked
  await expectFail(() => send({ founder: stranger.address, symbol: 'PAR2' }), /already in use/);
  // two pending approvals may name the same ticker; only the first launch takes the ticker lock
  const founder2 = await w.signer();
  await send({ cityId: 8n, founder: founder2.address, name: 'Paris, Texas', symbol: 'PAR' }, [w.admin], 'same ticker, another city');
  await w.launch({ cityId: 8n, founder: founder2 });
  await expectFail(() => w.launch({ cityId: 7n, founder }), /already in use/);
  // now the ticker and the city are taken for good
  await expectFail(() => send({ cityId: 9n, symbol: 'PAR' }), 'TickerTaken');
  await expectFail(() => send({ cityId: 8n, symbol: 'NEW' }), 'CoinAlreadyLaunched');
  await w.finish();
});

test('L04 revoke_approval: the admin any time; anyone only after expiry; rent to rent_payer; a launch after expiry refused', async () => {
  const w = await World.create();
  const founder = await w.signer(); const stranger = await w.signer();
  await w.approve({ cityId: 11n, founder, symbol: 'AAA', ttl: DAY });
  const rent = w.lamportsOf(w.P.approval(11n));
  await expectFail(() => w.send([w.ix.revokeApproval({ by: stranger.address, cityId: 11n, rentPayer: w.admin.address })], [stranger], 'stranger before expiry'), 'ApprovalNotExpired');
  // the rent goes only to the stored rent payer
  await expectFail(() => w.send([w.ix.revokeApproval({ by: w.admin.address, cityId: 11n, rentPayer: stranger.address })], [w.admin], 'rent to a stranger'), 'InvalidAddress');
  const before = w.lamportsOf(w.admin.address);
  let r = await w.send([w.ix.revokeApproval({ by: w.admin.address, cityId: 11n, rentPayer: w.admin.address })], [w.admin], 'admin revokes');
  assert.equal(w.approval(11n), null);
  assert.equal(w.lamportsOf(w.admin.address) - before, rent, 'rent back to the admin (the fee payer pays the fee)');
  assert.deepEqual(r.events[0], { name: 'ApprovalRevoked', data: { city_id: 11n, by: w.admin.address } });
  // expiry: the founder can no longer launch; anyone may clean up
  await w.approve({ cityId: 12n, founder, symbol: 'BBB', ttl: DAY });
  w.warpSecs(DAY + 1n);
  await expectFail(() => w.launch({ cityId: 12n, founder }), 'ApprovalExpired');
  r = await w.send([w.ix.revokeApproval({ by: stranger.address, cityId: 12n, rentPayer: w.admin.address })], [stranger], 'anyone after expiry');
  assert.equal(r.events[0].data.by, stranger.address);
  // at exactly expires_at a non-admin is still refused, and the founder may still launch
  await w.approve({ cityId: 13n, founder, symbol: 'CCC', ttl: DAY });
  w.warpSecs(DAY);
  await expectFail(() => w.send([w.ix.revokeApproval({ by: stranger.address, cityId: 13n, rentPayer: w.admin.address })], [stranger], 'at expires_at'), 'ApprovalNotExpired');
  await w.launch({ cityId: 13n, founder });
  await w.finish();
});

test('L04 the old program: its Approval, its Coin and its launches block approvals here (real old vicinity_launchpad)', async () => {
  const w = await World.create({ dbcProgram: true });
  const founder = await w.signer(); const oldFounder = await w.signer();
  // its launches open: nothing can be approved here
  await w.legacyPause(false);
  await expectFail(() => w.approve({ cityId: 21n, founder, symbol: 'OPEN' }), 'LegacyLaunchesOpen');
  // an Approval created by the old program for the city
  await w.legacyApprove({ cityId: 22n, founder: oldFounder });
  await w.legacyPause(true);
  assert.equal(w.accountInfo(w.P.legacyApproval(22n)).owner, S.CLUSTERS.mainnet.legacyProgram);
  await expectFail(() => w.approve({ cityId: 22n, founder, symbol: 'OLDAP' }), 'LegacyApprovalExists');
  // a Coin launched by the old program through Meteora DBC
  await w.legacyPause(false);
  await w.legacyApprove({ cityId: 23n, founder: oldFounder, symbol: 'OLDC' });
  await w.legacyLaunch({ cityId: 23n, founder: oldFounder });
  await w.legacyPause(true);
  assert.equal(w.accountInfo(w.P.legacyCoin(23n)).owner, S.CLUSTERS.mainnet.legacyProgram);
  await expectFail(() => w.approve({ cityId: 23n, founder, symbol: 'OLDCN' }), 'LegacyCoinExists');
  // a revoked old approval no longer blocks; a city untouched by the old program is fine
  await w.legacyRevoke(22n);
  await w.approve({ cityId: 22n, founder, symbol: 'NEWAP' });
  await w.approve({ cityId: 24n, founder, symbol: 'FRESH' });
  // the legacy accounts are pinned to their derivations
  await expectFail(() => w.send([approveIx(w, { cityId: 25n, founder: founder.address, symbol: 'PIN', overrides: { legacy_coin: w.P.legacyCoin(26n) } })], [w.admin], 'another city\'s legacy coin'), 'InvalidAddress');
  await expectFail(() => w.send([approveIx(w, { cityId: 25n, founder: founder.address, symbol: 'PIN', overrides: { legacy_approval: w.P.legacyApproval(26n) } })], [w.admin], 'another city\'s legacy approval'), 'InvalidAddress');
  await expectFail(() => w.send([approveIx(w, { cityId: 25n, founder: founder.address, symbol: 'PIN', overrides: { legacy_launchpad: S.CLUSTERS.devnet.legacyLaunchpad } })], [w.admin], 'the devnet legacy launchpad'), 'InvalidAddress');
  await w.finish();
});

test('L04 a wrong-owner, wrong-size, wrong-discriminator or missing account at LEGACY_LAUNCHPAD is refused; so is one whose admin is not this program\'s admin or has a transfer pending (GOV-1)', async () => {
  const w = await World.create({ legacy: 'none' });
  const founder = await w.signer();
  const at = S.CLUSTERS.mainnet.legacyLaunchpad;
  const good = Buffer.alloc(171); Buffer.from(S.LEGACY_LAUNCHPAD_DISCRIMINATOR).copy(good); good[168] = 1;
  pkb(w.admin.address).copy(good, S.LEGACY_ADMIN_AT);
  // missing (a System account with no data)
  await expectFail(() => w.approve({ cityId: 31n, founder, symbol: 'MISS' }), 'InvalidAddress');
  // right bytes, wrong owner (the devnet build of the old program, and vicinity_rewards)
  w.setRaw(at, good, S.CLUSTERS.devnet.legacyProgram);
  await expectFail(() => w.approve({ cityId: 31n, founder, symbol: 'OWN' }), 'InvalidAddress');
  w.setRaw(at, good, S.CLUSTERS.mainnet.rewardsProgram);
  await expectFail(() => w.approve({ cityId: 31n, founder, symbol: 'OWN' }), 'InvalidAddress');
  // right owner, wrong size
  w.setRaw(at, Buffer.concat([good, Buffer.alloc(1)]), S.CLUSTERS.mainnet.legacyProgram);
  await expectFail(() => w.approve({ cityId: 31n, founder, symbol: 'SIZE' }), 'InvalidAddress');
  w.setRaw(at, good.subarray(0, 170), S.CLUSTERS.mainnet.legacyProgram);
  await expectFail(() => w.approve({ cityId: 31n, founder, symbol: 'SIZE' }), 'InvalidAddress');
  // right owner and size, wrong discriminator (the old Coin's)
  const bad = Buffer.from(good); bad[0] ^= 0xff;
  w.setRaw(at, bad, S.CLUSTERS.mainnet.legacyProgram);
  await expectFail(() => w.approve({ cityId: 31n, founder, symbol: 'DISC' }), 'InvalidAddress');
  // paused byte 0: launches open
  const open = Buffer.from(good); open[168] = 0;
  w.setRaw(at, open, S.CLUSTERS.mainnet.legacyProgram);
  await expectFail(() => w.approve({ cityId: 31n, founder, symbol: 'OPEN' }), 'LegacyLaunchesOpen');
  // paused, but administered by another key, by nobody (zero), or with a transfer pending to anyone (GOV-1)
  const stranger = await w.signer(0n);
  for (const [what, edit] of [
    ['another admin', (d) => pkb(stranger.address).copy(d, S.LEGACY_ADMIN_AT)],
    ['a zero admin', (d) => d.fill(0, S.LEGACY_ADMIN_AT, S.LEGACY_ADMIN_AT + 32)],
    ['a transfer pending to a stranger', (d) => pkb(stranger.address).copy(d, S.LEGACY_PENDING_ADMIN_AT)],
    ['a transfer pending to this admin', (d) => pkb(w.admin.address).copy(d, S.LEGACY_PENDING_ADMIN_AT)],
  ]) {
    const d = Buffer.from(good); edit(d);
    w.setRaw(at, d, S.CLUSTERS.mainnet.legacyProgram);
    await expectFail(() => w.approve({ cityId: 31n, founder, symbol: 'ADMN' }), 'LegacyAdminMismatch');
    void what;
  }
  // the old program's own account, launches paused, administered by this program's admin
  w.setRaw(at, good, S.CLUSTERS.mainnet.legacyProgram);
  await w.approve({ cityId: 31n, founder, symbol: 'GOOD' });
  await w.launch({ cityId: 31n, founder });
  await w.finish();
});
