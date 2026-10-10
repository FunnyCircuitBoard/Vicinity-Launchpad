// TN01-TN07: the admin "City coins" tab (src/lpadmin.js, src/sol/lpadmin-ix.js, src/sol/squads.js) against the REAL programs, in
// process. Every transaction the Worker builds for the tab is taken from the route's answer (the unsigned bytes), signed by the
// session wallet (and the one-time browser keys where the step has them), and run by litesvm; the chain is then read back.
//   TN01 the builders equal the SDK's anchor-built instructions (programs, accounts, roles, data), the generated create_config
//        data equals createConfigIx() and src/sol/dbc-config-data.js is current
//   TN02 step 1: refused while the upgrade authority is not the session wallet; then init_registry + init_launchpad in one
//        transaction (the loader's ProgramData authority check passes for the real authority and fails for anyone else, even if
//        the Worker were bypassed); a registry that exists already is skipped
//   TN03 step 2: a pasted vault, a wallet, a 1-of-2 and a controlled multisig are refused; a 2-of-3 Squads multisig's vault gets
//        both upgrade authorities through SetAuthority x2; recorded; step 1 can never run again
//   TN04 steps 3-7: the price curve from a one-time key equals Meteora's account for the defaults byte for byte; allowed; the
//        dev wallet's fee account; the speed table (create + extend in one transaction) holds the SDK's address list; Vicinity's
//        partner entry (signed as the dev wallet); the summary for the team is complete
//   TN05 approve on chain (founder, name, ticker, expiry) and revoke (the rent comes back); the founder launches
//   TN06 a launched coin: collect city fees, set up holder rewards (Holders, 0 bps, the city tag), forward the holders' share,
//        pause and resume launches; after graduation the city's pool fees through its own position
//   TN07 the dev wallet's platform fees: the plan finds the trading fee, the launch fee, the surplus and its pool position, and
//        every claim transaction goes through
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { address as kitAddress, generateKeyPairSigner, signBytes } from '@solana/kit';
import { World, ADDRESSES, PROGRAM_IDS, LAMPORTS, P, R, C, IDL, buildIx, decodeAccount, ata as sdkAta, dbc as sdkDbc, completeCurve, graduate, expectFail } from './helpers.mjs';
import { vicinityConfigParams, createConfigIx } from '../sdk/launchpad/config.mjs';
import { launchpadLookupTableAddresses, buildCreateLookupTable } from '../sdk/launchpad/lookup-table.mts';
import { buildPartnerMetadata } from '../sdk/launchpad/metadata.mts';
import { createReferralAccount } from '../sdk/launchpad/trade.mts';
import { d1 } from '../../test/helpers/d1.js';
import { ensureSchema } from '../../src/store.js';
import { handleLpAdmin, _resetLpAdmin, configDiff } from '../../src/lpadmin.js';
import { _resetLpKit, GENESIS } from '../../src/lpkit.js';
import { base58Decode, base58Encode } from '../../src/solana.js';
import { decodeHeader } from '../../src/sol/message.js';
import { _resetTickers } from '../../src/tickers.js';
import * as WX from '../../src/sol/lpadmin-ix.js';
import { CREATE_CONFIG_DATA, EXPECTED_POOL_CONFIG } from '../../src/sol/dbc-config-data.js';
import { generate } from '../scripts/launchpad/worker-config-bytes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const solanaDir = join(here, '..');
const ROOT = join(solanaDir, '..');
const VECTORS = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'squads', 'vectors.json'), 'utf8'));
const SQUADS = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const DEV = ADDRESSES.feeRecipient;
const plain = (ix) => ({ p: String(ix.programAddress), a: ix.accounts.map((x) => `${x.address}:${x.role}`), d: Buffer.from(ix.data).toString('hex') });
const asRpc = (acc, slice) => {
  if (!acc) return null;
  let data = Buffer.from(acc.data);
  if (slice) data = data.subarray(slice.offset, slice.offset + slice.length);
  return { owner: String(acc.programAddress), lamports: Number(acc.lamports), data: [data.toString('base64'), 'base64'], executable: Boolean(acc.executable), rentEpoch: 0, space: Number(acc.space ?? data.length) };
};

/** A JSON-RPC stand-in over the World: the reads, the simulation and the confirmations the admin routes make. */
function worldRpc(w) {
  const known = new Set(); // addresses getProgramAccounts / getTokenAccountsByOwner may return
  const landed = new Map(); // signature -> { keys }
  const fetchImpl = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    let result;
    const acc = (a) => w.account(a);
    switch (method) {
      case 'getGenesisHash': result = GENESIS.devnet; break;
      case 'getLatestBlockhash': result = { context: { slot: 1 }, value: { blockhash: String(w.svm.latestBlockhash()), lastValidBlockHeight: 1_000_000 } }; break;
      case 'getAccountInfo': result = { context: { slot: 1 }, value: asRpc(acc(params[0]), params[1] && params[1].dataSlice) }; break;
      case 'getMultipleAccounts': result = { context: { slot: 1 }, value: params[0].map((a) => asRpc(acc(a), params[1] && params[1].dataSlice)) }; break;
      case 'getProgramAccounts': {
        const [program, cfg] = params;
        result = [...known].filter((a) => {
          const x = acc(a);
          if (!x || String(x.programAddress) !== program) return false;
          const d = Buffer.from(x.data);
          return (cfg.filters || []).every((f) => (f.dataSize != null ? d.length === f.dataSize : Buffer.from(base58Decode(f.memcmp.bytes)).equals(d.subarray(f.memcmp.offset, f.memcmp.offset + 32))));
        }).map((a) => ({ pubkey: a, account: asRpc(acc(a)) }));
        break;
      }
      case 'getTokenAccountsByOwner': {
        const [owner, { programId }] = params;
        result = { context: { slot: 1 }, value: [...known].filter((a) => { const x = acc(a); return x && String(x.programAddress) === programId && x.data.length >= 165 && base58Encode(Uint8Array.from(x.data).subarray(32, 64)) === owner; }).map((a) => ({ pubkey: a, account: asRpc(acc(a)) })) };
        break;
      }
      case 'getSlot': result = Number(w.svm.getClock().slot); break;
      case 'getBlocks': result = w.svm.getSlotHashes().map((h) => Number(h.slot)).filter((s) => s >= params[0] && s <= params[1]).sort((a, b) => a - b); break;
      case 'simulateTransaction': {
        const tx = Buffer.from(params[0], 'base64');
        const d = decodeHeader(tx);
        const message = tx.subarray(d.messageOffset);
        const signatures = Object.fromEntries(d.staticKeys.slice(0, d.header.numRequiredSignatures).map((k) => [k, new Uint8Array(64)]));
        w.svm.withSigverify(false);
        let res;
        try { res = w.svm.simulateTransaction({ messageBytes: message, signatures }); } finally { w.svm.withSigverify(true); }
        const watched = params[1].accounts ? params[1].accounts.addresses : [];
        if (typeof res.err === 'function') {
          result = { context: { slot: 1 }, value: { err: { InstructionError: [0, 'Custom'] }, logs: res.meta().logs(), unitsConsumed: Number(res.meta().computeUnitsConsumed()), accounts: null } };
        } else {
          const post = new Map(res.postAccounts().map((a) => [String(a.address), a]));
          result = { context: { slot: 1 }, value: { err: null, logs: res.meta().logs(), unitsConsumed: Number(res.meta().computeUnitsConsumed()), accounts: watched.map((a) => { const x = post.get(a) || acc(a); return x ? { lamports: Number(x.lamports), owner: String(x.programAddress), data: ['', 'base64'] } : null; }) } };
        }
        break;
      }
      case 'getSignatureStatuses': result = { context: { slot: 1 }, value: params[0].map((s) => (landed.has(s) ? { slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' } : null)) }; break;
      case 'getTransaction': { const l = landed.get(params[0]); result = l ? { slot: 1, transaction: { message: { accountKeys: l.keys } }, meta: { err: null, loadedAddresses: { writable: [], readonly: [] } } } : null; break; }
      default: throw new Error(`unexpected ${method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  return { fetchImpl, known, landed };
}

describe('17 the admin City coins tab against the real programs', () => {
  let w, rpc, env, owner, stranger, cfgSigner, config, table;
  const cityA = 170001n, cityB = 170002n;
  let founderA, coinA;
  const ctxOf = (wallet) => ({ session: {}, user: { id: 1, wallet }, wallet, role: 'owner', db: env.DB, now: Date.now(), env, fetchImpl: rpc.fetchImpl });
  async function call(wallet, sub, body) {
    const get = body === undefined;
    const req = new Request(`https://vicinity.city/api/admin/lp/${sub}${get ? `${sub.includes('?') ? '&' : '?'}cluster=devnet` : ''}`, get ? {} : { method: 'POST', body: JSON.stringify({ cluster: 'devnet', ...body }), headers: { 'content-type': 'application/json' } });
    const r = await handleLpAdmin(req, ctxOf(wallet), sub.split('?')[0], Date.now());
    return { status: r.status, data: await r.json() };
  }
  /** Sign the Worker's unsigned transaction (the session wallet, then the one-time keys) and run it; returns the signature. */
  async function exec(built, signers = [], { dev = false } = {}) {
    assert.equal(built.ok, true, JSON.stringify(built));
    const tx = Buffer.from(built.tx, 'base64');
    const d = decodeHeader(tx);
    const message = tx.subarray(d.messageOffset);
    const signatures = {};
    for (const s of signers) signatures[s.address] = await signBytes(s.keyPair.privateKey, message);
    if (dev) { signatures[DEV] = new Uint8Array(64); w.svm.withSigverify(false); }
    let res;
    try { res = w.svm.sendTransaction({ messageBytes: message, signatures }); } finally { if (dev) w.svm.withSigverify(true); }
    w.svm.expireBlockhash();
    if (typeof res.err === 'function') throw new Error(`failed: ${JSON.stringify(res.err(), (k, v) => (typeof v === 'bigint' ? String(v) : v))}\n  ${res.meta().logs().slice(-10).join('\n  ')}`);
    const sig = base58Encode(res.signature());
    rpc.landed.set(sig, { keys: d.staticKeys });
    return sig;
  }
  const status = async (wallet = owner.address) => (await call(wallet, 'status')).data;
  const stepOf = async (id, wallet) => (await status(wallet)).steps.find((s) => s.id === id);

  before(async () => {
    _resetLpKit(); _resetLpAdmin(); _resetTickers();
    w = await World.create({ initLaunchpad: false, addConfig: false, initRewards: false });
    owner = await w.signer(200n);
    stranger = await w.signer(10n);
    w.svm.airdrop(kitAddress(DEV), 100n * LAMPORTS);
    rpc = worldRpc(w);
    const tickers = { [String(cityA)]: 'ALPHA', [String(cityB)]: 'BETA' };
    env = {
      DB: d1(), ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/data/tickers.json' ? new Response(JSON.stringify(tickers)) : new Response('', { status: 404 })) },
      LAUNCHPAD_CLUSTER: 'devnet', LAUNCHPAD_PROGRAM_ID: PROGRAM_IDS.launchpad, LAUNCHPAD_REWARDS_PROGRAM_ID: PROGRAM_IDS.rewards, LAUNCHPAD_RPC_URL: 'https://litesvm.test',
    };
    await ensureSchema(env.DB);
  });

  it('TN01 the builders equal the SDK, and the generated price-curve data is current and right', async () => {
    const L = PROGRAM_IDS.launchpad, RW = PROGRAM_IDS.rewards, a = owner.address, cfg = stranger.address;
    assert.deepEqual(plain(await WX.initLaunchpad({ programId: L, rewardsProgramId: RW, payer: a, admin: a, upgradeAuthority: a })), plain(C.initLaunchpad({ payer: a, admin: a, upgradeAuthority: a })));
    assert.deepEqual(plain(await WX.initRegistry({ rewardsProgramId: RW, payer: a, upgradeAuthority: a, admin: a })),
      plain(buildIx(IDL.rewards, 'init_registry', {}, { payer: a, upgrade_authority: a, admin: a, program_data: (await import('../sdk/launchpad/pda.mjs')).programDataAddress(RW), registry: R.registry() })));
    const params = vicinityConfigParams();
    assert.deepEqual(plain(await WX.createConfig({ config: cfg, payer: a })), plain(createConfigIx({ config: cfg, quoteMint: ADDRESSES.wsol, payer: a, params })));
    assert.deepEqual(plain(await WX.addLaunchConfig({ programId: L, admin: a, dbcConfig: cfg })), plain(C.addLaunchConfig({ admin: a, dbcConfig: cfg, quoteMint: ADDRESSES.wsol })));
    assert.deepEqual(plain(await WX.createPartnerMetadata({ payer: DEV })), plain(buildPartnerMetadata({ payer: DEV })));
    const exp = BigInt(Math.floor(Date.now() / 1000) + 86_400);
    assert.deepEqual(plain(await WX.approveLaunch({ programId: L, admin: a, cityId: 5n, founder: cfg, name: 'São Paulo', symbol: 'SAO', expiresAt: exp, dbcConfig: cfg })),
      plain(C.approveLaunch({ admin: a, cityId: 5n, founder: cfg, name: 'São Paulo', symbol: 'SAO', expiresAt: exp, dbcConfig: cfg })));
    assert.deepEqual(plain(await WX.revokeApproval({ programId: L, admin: a, cityId: 5n, rentPayer: cfg })), plain(C.revokeApproval({ admin: a, cityId: 5n, rentPayer: cfg })));
    for (const [launches, payouts] of [[true, null], [false, null], [null, true], [true, false]]) {
      assert.deepEqual(plain(await WX.setPause({ programId: L, authority: a, launches, payouts })), plain(C.setPause({ authority: a, launches, payouts })));
    }
    const coin = { cityId: 9n, mint: cfg, quoteMint: ADDRESSES.wsol, dbcPool: owner.address, dbcConfig: stranger.address, founder: a };
    assert.deepEqual(plain(await WX.harvestCurveFees({ programId: L, payer: a, coin })), plain(C.harvestCurveFees({ payer: a, coin })));
    assert.deepEqual(plain(await WX.harvestPoolFees({ programId: L, payer: a, coin, dammPool: a, positionNftMint: cfg })), plain(C.harvestPoolFees({ payer: a, coin, dammPool: a, positionNftMint: cfg })));
    assert.deepEqual(plain(await WX.forwardHoldersFees({ programId: L, rewardsProgramId: RW, coin })), plain(C.forwardHoldersFees({ coin })));
    const tag = Buffer.concat([Buffer.from('vicinity:city:9'), Buffer.alloc(17)]);
    assert.deepEqual(Buffer.from(WX.cityTag(9n)), tag);
    assert.equal(Buffer.from(WX.cityTag(18446744073709551614n)).toString().replace(/\0+$/, ''), 'city:18446744073709551614', 'an id too long for the long form');
    assert.deepEqual(plain(await WX.initCity({ rewardsProgramId: RW, payer: a, admin: a, authority: a, founder: coin.founder, mint: coin.mint, rewardMint: ADDRESSES.wsol, cityId: 9n })),
      plain(C.initRewardsForCoin({ payer: a, registryAdmin: a, authority: a, coin, cityTag: tag })));
    assert.deepEqual(plain(await WX.claimTradingFee({ pool: a, config: cfg, baseMint: coin.mint, quoteMint: ADDRESSES.wsol, baseAccount: a, quoteAccount: cfg })),
      plain(C.claimPartnerTradingFee({ dbcPool: a, dbcConfig: cfg, coinMint: coin.mint, quoteMint: ADDRESSES.wsol, baseAccount: a, quoteAccount: cfg })));
    assert.deepEqual(plain(await WX.claimPartnerPoolCreationFee({ pool: a, config: cfg })), plain(C.claimPartnerPoolCreationFee({ dbcPool: a, dbcConfig: cfg })));
    assert.deepEqual(plain(await WX.partnerWithdrawSurplus({ pool: a, config: cfg, quoteMint: ADDRESSES.wsol, quoteAccount: a })), plain(C.partnerWithdrawSurplus({ dbcPool: a, dbcConfig: cfg, quoteMint: ADDRESSES.wsol, quoteAccount: a })));
    assert.deepEqual(plain(await WX.dammClaimPositionFee({ owner: DEV, pool: a, nftMint: cfg, mintA: coin.mint, mintB: ADDRESSES.wsol, accountA: a, accountB: cfg })),
      plain(C.dammClaimPositionFee({ owner: DEV, pool: a, nftMint: cfg, mintA: coin.mint, mintB: ADDRESSES.wsol, accountA: a, accountB: cfg })));
    // the speed table: the SDK's address list (devnet ids are the SDK's defaults) and web3.js's create / extend
    assert.deepEqual(await WX.lookupTableAddresses({ programId: L, rewardsProgramId: RW, dbcConfigs: [cfg] }), launchpadLookupTableAddresses({ dbcConfigs: [cfg] }));
    const sdkT = buildCreateLookupTable({ authority: a, recentSlot: 12345, addresses: launchpadLookupTableAddresses({ dbcConfigs: [cfg] }) });
    const mine = await WX.createLookupTable({ authority: a, recentSlot: 12345 });
    assert.equal(mine.table, sdkT.lookupTable);
    assert.deepEqual(plain(mine.ix), plain(sdkT.create));
    assert.deepEqual(plain(WX.extendLookupTable({ table: mine.table, authority: a, addresses: launchpadLookupTableAddresses({ dbcConfigs: [cfg] }).slice(0, 20) })), plain(sdkT.extends[0]));
    // every discriminator is the IDL's
    for (const [name, d] of Object.entries(WX.DISCRIMINATORS)) {
      const idl = [IDL.launchpad, IDL.rewards, IDL.dbc, IDL.damm].find((x) => x.instructions.some((i) => i.name === name));
      assert.deepEqual(idl.instructions.find((i) => i.name === name).discriminator, d, name);
    }
    // the generated file: create_config data, and the PoolConfig account it makes (checked again in TN04 against a real create)
    assert.equal(CREATE_CONFIG_DATA, Buffer.from(createConfigIx({ config: cfg, quoteMint: ADDRESSES.wsol, payer: a, params }).data).toString('base64'));
    assert.equal(await generate(), readFileSync(join(ROOT, 'src', 'sol', 'dbc-config-data.js'), 'utf8'), 'src/sol/dbc-config-data.js is stale: run node scripts/launchpad/worker-config-bytes.mjs');
  });

  it('TN02 step 1: refused unless the session wallet is the upgrade authority; then one transaction starts both, a registry that exists is skipped', async () => {
    // the Mac's set-upgrade-authority: both programs now under the owner's wallet
    w.loadUpgradeable(PROGRAM_IDS.launchpad, join(solanaDir, 'target', 'deploy', 'vicinity_launchpad.so'), owner.address);
    w.loadUpgradeable(PROGRAM_IDS.rewards, join(solanaDir, 'target', 'deploy', 'vicinity_rewards.so'), owner.address);
    const s1 = await stepOf('start', stranger.address);
    assert.equal(s1.state, 'blocked');
    assert.match(s1.reason, /upgrade authority is .*not the wallet you are signed in with/);
    const refused = await call(stranger.address, 'tx', { step: 'start' });
    assert.deepEqual([refused.status, refused.data.error], [409, 'step_not_ready']);
    // the program's own check, even if the Worker were bypassed: a stranger signing as the upgrade authority fails
    await expectFail(() => w.send([C.initLaunchpad({ payer: stranger.address, admin: stranger.address, upgradeAuthority: stranger.address })], [stranger], 'forged init', { feePayer: stranger }), 'NotUpgradeAuthority');
    const st = await status();
    assert.equal(st.programs.launchpad.upgradeAuthority, owner.address);
    assert.equal(st.programs.launchpad.size, readFileSync(join(solanaDir, 'target', 'deploy', 'vicinity_launchpad.so')).length);
    assert.equal(st.programs.launchpad.sha256, createHash('sha256').update(readFileSync(join(solanaDir, 'target', 'deploy', 'vicinity_launchpad.so'))).digest('hex'));
    assert.equal(st.steps[0].state, 'ready');
    const built = (await call(owner.address, 'tx', { step: 'start' })).data;
    assert.deepEqual(built.summary.filter((x) => x.programName.startsWith('Vicinity')).map((x) => x.ix), ['init_registry', 'init_launchpad']);
    assert.deepEqual(built.signers, [owner.address]);
    assert.ok(built.solChange[owner.address] < 0);
    const sig = await exec(built, [owner]);
    const lp = w.launchpad();
    assert.deepEqual([lp.admin.toBase58(), lp.rewards_program.toBase58()], [owner.address, PROGRAM_IDS.rewards]);
    assert.equal(decodeAccount(IDL.rewards, 'Registry', w.account(R.registry()).data).admin.toBase58(), owner.address);
    assert.deepEqual((await call(owner.address, 'record', { step: 'start', signature: sig })).data.ok, true);
    assert.equal((await stepOf('start')).state, 'done');
    assert.equal((await call(owner.address, 'tx', { step: 'start' })).data.error, 'already_done');

    // a registry that exists already: only init_launchpad is built
    const w2 = await World.create({ initLaunchpad: false, addConfig: false, initRewards: true });
    const o2 = w2.deployer;
    const rpc2 = worldRpc(w2);
    const env2 = { ...env, DB: d1() };
    await ensureSchema(env2.DB);
    const r = await handleLpAdmin(new Request('https://vicinity.city/api/admin/lp/tx', { method: 'POST', body: JSON.stringify({ cluster: 'devnet', step: 'start' }) }), { wallet: o2.address, env: env2, fetchImpl: rpc2.fetchImpl, db: env2.DB }, 'tx', Date.now());
    const b2 = await r.json();
    assert.equal(b2.ok, true, JSON.stringify(b2));
    assert.deepEqual(b2.summary.filter((x) => x.programName.startsWith('Vicinity')).map((x) => x.ix), ['init_launchpad']);
  });

  it('TN03 step 2: only a real 2-of-3 Squads multisig; its vault gets both upgrade authorities in one transaction', async () => {
    const [good, oneOfTwo, controlled] = VECTORS.synthetic;
    for (const v of [good, oneOfTwo, controlled]) w.setRaw(v.address, Buffer.from(v.data, 'base64'), SQUADS);
    const ok = (await call(owner.address, `squads?address=${good.address}`)).data;
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.vault, good.expected.vaults[0]);
    assert.match(ok.says, /^2 of 3: /);
    const refusedAs = async (a) => (await call(owner.address, `squads?address=${a}`)).data.error;
    assert.equal(await refusedAs(good.expected.vaults[0]), 'not_found', 'a vault that holds nothing yet');
    w.svm.airdrop(kitAddress(good.expected.vaults[0]), 1_000_000n);
    assert.equal(await refusedAs(good.expected.vaults[0]), 'not_multisig', 'a funded vault');
    assert.equal(await refusedAs(owner.address), 'not_multisig', 'a wallet');
    assert.equal(await refusedAs(R.registry()), 'not_multisig', 'another program\'s account');
    assert.equal(await refusedAs(oneOfTwo.address), 'threshold_too_low');
    assert.equal(await refusedAs(controlled.address), 'controlled');
    assert.equal((await call(owner.address, 'tx', { step: 'handoff', params: { multisig: good.address, vault: owner.address } })).data.error, 'vault_mismatch');
    assert.equal((await call(owner.address, 'tx', { step: 'handoff', params: { multisig: oneOfTwo.address, vault: oneOfTwo.expected.vaults[0] } })).data.error, 'threshold_too_low');
    const built = (await call(owner.address, 'tx', { step: 'handoff', params: { multisig: good.address, vault: ok.vault } })).data;
    assert.equal(built.ok, true, JSON.stringify(built));
    assert.deepEqual(built.summary.filter((x) => x.ix === 'set_authority').map((x) => x.accounts.map((a) => a.role)), [['writable', 'signer', 'read-only'], ['writable', 'signer', 'read-only']]);
    const sig = await exec(built, [owner]);
    const st = await status();
    assert.deepEqual([st.programs.launchpad.upgradeAuthority, st.programs.rewards.upgradeAuthority], [ok.vault, ok.vault]);
    assert.deepEqual([st.steps[1].state, st.steps[1].adoptable], ['blocked', true], 'not recorded yet: the page offers to record it from the chain');
    assert.equal((await call(owner.address, 'record', { step: 'handoff', signature: sig, params: { multisig: good.address } })).data.ok, true);
    const after = await status();
    assert.equal(after.steps[1].state, 'done');
    assert.equal(after.squads.vault, ok.vault);
    assert.equal(after.steps[0].state, 'done');
    assert.equal((await call(owner.address, 'tx', { step: 'handoff', params: { multisig: good.address, vault: ok.vault } })).data.error, 'already_done');
    // the old authority has no power left: the loader refuses its SetAuthority
    const takeBack = await WX.setUpgradeAuthority({ programId: PROGRAM_IDS.launchpad, currentAuthority: owner.address, newAuthority: owner.address });
    await expectFail(() => w.send([takeBack], [owner], 'take back', { feePayer: owner }));
  });

  it('TN04 steps 3-7: the price curve, its allow-list entry, the fee account, the speed table, the partner entry; the summary', async () => {
    // 3: one-time browser key
    cfgSigner = await generateKeyPairSigner();
    const s3 = await stepOf('config');
    assert.equal(s3.state, 'ready', s3.reason);
    assert.equal((await call(owner.address, 'tx', { step: 'config', ephemeral: [] })).data.error, 'bad_signers');
    const b3 = (await call(owner.address, 'tx', { step: 'config', ephemeral: [cfgSigner.address] })).data;
    assert.deepEqual(b3.signers, [owner.address, cfgSigner.address]);
    const sig3 = await exec(b3, [owner, cfgSigner]);
    config = cfgSigner.address;
    assert.deepEqual(Buffer.from(w.account(config).data), Buffer.from(EXPECTED_POOL_CONFIG, 'base64'), 'Meteora wrote exactly the expected account');
    assert.deepEqual(configDiff(asRpc(w.account(config))), []);
    rpc.known.add(config);
    assert.equal((await call(owner.address, 'record', { step: 'config', signature: sig3, params: { address: stranger.address } })).data.error, 'wrong_transaction');
    assert.equal((await call(owner.address, 'record', { step: 'config', signature: sig3, params: { address: config } })).data.ok, true);
    assert.equal((await stepOf('config')).state, 'done');
    // a changed field is named
    const cloned = w.cloneConfig((c) => { c.migration_quote_threshold = 1n * LAMPORTS; }, { from: config });
    assert.deepEqual(configDiff(asRpc(w.account(cloned))), ['migration_quote_threshold']);
    // 4
    const sig4 = await exec((await call(owner.address, 'tx', { step: 'allow' })).data, [owner]);
    rpc.known.add(P.launchConfig(config));
    assert.equal(decodeAccount(IDL.launchpad, 'LaunchConfig', w.account(P.launchConfig(config)).data).enabled, true);
    assert.equal((await call(owner.address, 'record', { step: 'allow', signature: sig4 })).data.ok, true);
    // 5 (devnet: the SOL account only)
    const b5 = (await call(owner.address, 'tx', { step: 'referral' })).data;
    assert.deepEqual(b5.summary.filter((x) => x.ix === 'create_idempotent').length, 1);
    assert.deepEqual(b5.summary.find((x) => x.ix === 'create_idempotent').accounts.map((a) => a.address), createReferralAccount(owner.address, ADDRESSES.wsol).accounts.map((a) => a.address));
    const sig5 = await exec(b5, [owner]);
    assert.ok(w.exists(sdkAta(DEV, ADDRESSES.wsol)));
    assert.equal((await call(owner.address, 'record', { step: 'referral', signature: sig5 })).data.ok, true);
    // 6: the lookup-table program takes only a slot in SlotHashes; the Worker picks the newest produced slot 8+ behind the tip
    const clock = w.svm.getClock();
    const hashes = w.svm.getSlotHashes();
    const h = hashes[0]; h.slot = clock.slot - 10n; w.svm.setSlotHashes([h]);
    const b6 = (await call(owner.address, 'tx', { step: 'lookup' })).data;
    assert.equal(b6.ok, true, JSON.stringify(b6));
    assert.deepEqual(b6.summary.filter((x) => x.program === 'AddressLookupTab1e1111111111111111111111111').map((x) => x.ix), ['create_lookup_table', 'extend_lookup_table', 'extend_lookup_table']);
    const sig6 = await exec(b6, [owner]);
    table = b6.summary.find((x) => x.ix === 'create_lookup_table').accounts[0].address;
    const t = w.account(table);
    const addrs = []; for (let at = 56; at < t.data.length; at += 32) addrs.push(base58Encode(Uint8Array.from(t.data).subarray(at, at + 32)));
    assert.deepEqual(addrs, launchpadLookupTableAddresses({ dbcConfigs: [config] }));
    assert.equal((await call(owner.address, 'record', { step: 'lookup', signature: sig6, params: { address: table } })).data.ok, true);
    assert.equal((await stepOf('lookup')).state, 'done');
    // 7: only the dev wallet; signed as it here (litesvm's signature check off for that one transaction)
    assert.equal((await stepOf('partner')).state, 'blocked');
    const b7 = (await call(DEV, 'tx', { step: 'partner' })).data;
    const sig7 = await exec(b7, [], { dev: true });
    const pm = decodeAccount(IDL.dbc, 'PartnerMetadata', w.account(sdkDbc.partnerMetadata(DEV)).data);
    assert.deepEqual([pm.name, pm.website, pm.logo], ['Vicinity', 'https://vicinity.city', 'https://vicinity.city/brand/vicinity-512.png']);
    assert.equal((await call(DEV, 'record', { step: 'partner', signature: sig7 })).data.ok, true);
    // 8: the summary for the team (PLAN C5)
    const sum = (await call(owner.address, 'summary')).data;
    assert.equal(sum.complete, true, JSON.stringify(sum.steps));
    const vault = VECTORS.synthetic[0].expected.vaults[0];
    assert.deepEqual({ ...sum.summary, signatures: undefined }, {
      cluster: 'devnet', launchpadProgram: PROGRAM_IDS.launchpad, rewardsProgram: PROGRAM_IDS.rewards, squadsMultisig: VECTORS.synthetic[0].address, squadsVault: vault,
      admin: owner.address, registryAdmin: owner.address, dbcConfig: config, launchConfig: P.launchConfig(config), lookupTable: table,
      referralAccounts: { wsol: sdkAta(DEV, ADDRESSES.wsol), vicinity: null }, partnerMetadata: sdkDbc.partnerMetadata(DEV), signatures: undefined,
    });
    assert.deepEqual(sum.summary.signatures, { init: sum.summary.signatures.init, handoff: sum.summary.signatures.handoff, config: sig3, allow: sig4, referral: sig5, lookupCreate: sig6, lookupExtend: [], partner: sig7 });
    assert.ok(sum.summary.signatures.init && sum.summary.signatures.handoff);
  });

  it('TN05 approve on chain and revoke; the founder launches', async () => {
    env.LAUNCHPAD_DBC_CONFIGS = config;
    env.LAUNCHPAD_LOOKUP_TABLE = table;
    founderA = await w.signer(50n);
    const founderB = await w.signer(5n);
    const now = new Date().toISOString();
    for (const [i, f, city, name] of [[1, founderA, cityA, 'Alpha City'], [2, founderB, cityB, 'Beta Town']]) {
      await env.DB.prepare('INSERT INTO users (id, wallet, provider, provider_id, handle, created_at) VALUES (?, ?, \'wallet\', ?, ?, ?)').bind(i + 10, f.address, f.address, `f${i}`, now).run();
      await env.DB.prepare(`INSERT INTO seats (id, city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at) VALUES (?, ?, ?, 'NL', ?, ?, 1, 1, 'active', ?)`).bind(i, String(city), name, i + 10, f.address, now).run();
      await env.DB.prepare(`INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, updated_at, created_at) VALUES (?, ?, 'NL', ?, ?, ?, 'p', 'SOL', 'gold', ?, ?)`).bind(String(city), name, i, i + 10, name, now, now).run();
    }
    const cands = (await call(owner.address, 'candidates')).data;
    assert.deepEqual(new Map(cands.candidates.map((c) => [c.cityId, [c.ok, c.symbol, c.founder]])), new Map([[String(cityA), [true, 'ALPHA', founderA.address]], [String(cityB), [true, 'BETA', founderB.address]]]), JSON.stringify(cands));
    for (const city of [cityA, cityB]) {
      const b = (await call(owner.address, 'approve/tx', { cityId: String(city), expiryDays: 7 })).data;
      assert.equal(b.ok, true, JSON.stringify(b));
      const sig = await exec(b, [owner]);
      const ap = decodeAccount(IDL.launchpad, 'Approval', w.account(P.approval(city)).data);
      assert.equal(ap.founder.toBase58(), city === cityA ? founderA.address : founderB.address);
      assert.equal(ap.symbol, city === cityA ? 'ALPHA' : 'BETA');
      assert.ok(Math.abs(Number(ap.expires_at) - (Math.floor(Date.now() / 1000) + 7 * 86_400)) < 120);
      assert.equal((await call(owner.address, 'record', { step: 'approve', signature: sig, params: { cityId: String(city) } })).data.ok, true);
    }
    assert.equal((await call(owner.address, 'approve/tx', { cityId: String(cityA) })).data.error, 'already_approved');
    const listed = (await call(owner.address, 'candidates')).data;
    assert.deepEqual(listed.approvals.map((a) => a.cityId).sort(), [String(cityA), String(cityB)].sort());
    // revoke B: the rent comes back to the owner
    const before = w.lamportsOf(owner.address);
    const rb = (await call(owner.address, 'revoke/tx', { cityId: String(cityB) })).data;
    assert.ok(rb.solChange[owner.address] > 0, 'the approval\'s rent comes back');
    const sigR = await exec(rb, [owner]);
    assert.equal(w.exists(P.approval(cityB)), false);
    assert.ok(w.lamportsOf(owner.address) > before);
    assert.equal((await call(owner.address, 'record', { step: 'revoke', signature: sigR, params: { cityId: String(cityB) } })).data.ok, true);
    const log = (await env.DB.prepare('SELECT city_id, action FROM lp_approvals_log ORDER BY id').all()).results.map((r) => `${r.action}:${r.city_id}`);
    assert.deepEqual(log, [`approve:${cityA}`, `approve:${cityB}`, `revoke:${cityB}`]);
    // the founder launches A (the founder track's route; here the SDK builder with the approval's rent payer)
    const mint = await generateKeyPairSigner();
    await w.send([C.launch({ founder: founderA.address, baseMint: mint.address, cityId: cityA, dbcConfig: config, quoteMint: ADDRESSES.wsol, rentPayer: owner.address })], [founderA, mint], 'launch', { feePayer: founderA, cu: 400_000 });
    coinA = w.coin(cityA, founderA);
    rpc.known.add(coinA.address); rpc.known.add(coinA.dbcPool);
    assert.equal((await call(owner.address, 'candidates')).data.launched.some((x) => x.cityId === String(cityA)), true);
  });

  it('TN06 a launched coin: collect, holder rewards, forward, pause; pool fees after graduation', async () => {
    const trader = await w.signer(400n);
    for (let i = 0; i < 4; i++) await w.trade(trader, coinA, { side: 'buy', amount0: 3n * LAMPORTS });
    let coins = (await call(owner.address, 'coins')).data.coins;
    assert.equal(coins.length, 1);
    assert.equal(coins[0].stage, 'curve');
    assert.ok(BigInt(coins[0].curveFees) > 0n);
    assert.equal(coins[0].rewards, null);
    const pot0 = w.balance(coinA.holdersPot);
    await exec((await call(owner.address, 'collect/tx', { cityId: String(cityA) })).data, [owner]);
    assert.ok(w.balance(coinA.holdersPot) > pot0, 'the holders pot got the city\'s half');
    assert.equal((await call(owner.address, 'forward/tx', { cityId: String(cityA) })).data.error, 'no_rewards');
    await exec((await call(owner.address, 'init-city/tx', { cityId: String(cityA) })).data, [owner]);
    const cc = decodeAccount(IDL.rewards, 'CityConfig', w.account(R.city(coinA.mint)).data);
    assert.deepEqual([Object.keys(cc.reward_model)[0], cc.founder_bps, cc.reward_mint.toBase58(), Buffer.from(cc.city_tag).toString('hex')],
      ['Holders', 0, ADDRESSES.wsol, Buffer.concat([Buffer.from(`vicinity:city:${cityA}`), Buffer.alloc(32 - `vicinity:city:${cityA}`.length)]).toString('hex')]);
    assert.equal((await call(owner.address, 'init-city/tx', { cityId: String(cityA) })).data.error, 'already_done');
    const inPot = w.balance(coinA.holdersPot);
    await exec((await call(owner.address, 'forward/tx', { cityId: String(cityA) })).data, [owner]);
    assert.equal(w.balance(coinA.holdersPot), 0n);
    assert.equal(w.balance(R.vault(R.city(coinA.mint))), inPot);
    // pause and resume launches
    await exec((await call(owner.address, 'pause/tx', { launches: true })).data, [owner]);
    assert.equal(w.launchpad().launches_paused, true);
    assert.equal((await call(owner.address, 'pause/tx', { launches: true })).data.error, 'already_done');
    await exec((await call(owner.address, 'pause/tx', { launches: false })).data, [owner]);
    assert.equal(w.launchpad().launches_paused, false);
    assert.equal((await call(stranger.address, 'pause/tx', { launches: true })).data.error, 'not_admin');
    // fill the curve and graduate (the founder track's button; here the SDK), then the city's pool fees through its own position
    await completeCurve(w, coinA, trader);
    const g = await graduate(w, coinA, trader);
    for (const n of [g.n1, g.n2]) rpc.known.add((await WX.damm.positionNftAccount(n)));
    coins = (await call(owner.address, 'coins')).data.coins;
    assert.equal(coins[0].stage, 'graduated');
    const built = (await call(owner.address, 'collect/tx', { cityId: String(cityA) })).data;
    assert.equal(built.ok, true, JSON.stringify(built));
    assert.ok(built.summary.some((x) => x.ix === 'harvest_pool_fees'));
    await exec(built, [owner]);
  });

  it('TN07 the dev wallet\'s platform fees: planned and every claim goes through', async () => {
    assert.equal((await call(owner.address, 'platform/tx', {})).data.error, 'dev_wallet_only');
    const plan = (await call(DEV, 'platform/plan')).data;
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const kinds = new Set(plan.claims.map((c) => c.kind));
    for (const k of ['tradingFee', 'poolCreationFee', 'poolPositionFee']) assert.ok(kinds.has(k), `${k} in ${[...kinds]}`);
    let rounds = 0;
    for (;;) {
      const b = (await call(DEV, 'platform/tx', {})).data;
      if (b.error === 'nothing_to_collect') break;
      assert.equal(b.ok, true, JSON.stringify(b));
      const devBefore = w.lamportsOf(DEV);
      await exec(b, [], { dev: true });
      assert.ok(++rounds < 6);
      assert.ok(w.lamportsOf(DEV) > 0n && devBefore > 0n);
      if (!b.claims.some((c) => c.kind !== 'poolPositionFee')) break; // a position's fees are only known when claimed: it stays in the plan
    }
    assert.ok(rounds >= 1);
    const left = (await call(DEV, 'platform/plan')).data.claims.filter((c) => c.kind !== 'poolPositionFee');
    assert.deepEqual(left, [], 'every fee with an amount was collected');
  });
});
