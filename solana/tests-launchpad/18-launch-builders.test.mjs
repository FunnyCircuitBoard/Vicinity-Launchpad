// TO01-TO05: the founder's "Launch your city coin" and "Move to the open market" (src/lplaunch.js, src/sol/lplaunch-ix.js) against
// the REAL programs, in process. Every transaction is taken from the Worker route's answer (the unsigned bytes, built for the
// signed-in session's wallet), signed by that wallet and the one-time keys a browser would make, and run by litesvm, through the
// Vicinity speed table (a v0 transaction whose accounts litesvm loads from the table account); the chain is then read back.
//   TO01 the builders equal the SDK's anchor-built instructions: launch (+ the first buy = trade.mts buildLaunch), claim_founder_fees,
//        migration_damm_v2, the leftover (= buildWithdrawLeftover)
//   TO02 the founder's status is "ready" from the chain; the launch without a buy: the Coin record, the pool, the immutable metadata
//        (name, ticker, the /coin-meta URI), the approval closed with its rent back to the admin; the SOL change the page showed is
//        exactly what the founder's wallet paid
//   TO03 the launch with a first buy in the same transaction (at most 1232 bytes through the table): the founder gets exactly the
//        quoted coins and no wrapped SOL is left behind; the status says "launched"
//   TO04 graduation: refused on the curve; once the curve is full anyone signed in moves the coin to its DAMM v2 pool (the payer and
//        two one-time NFT keys); then the leftover; then nothing is left to do
//   TO05 the founder's fees: only the coin's founder; the city's share on the curve is collected first, the vault is emptied into
//        the founder's wallet as SOL
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { address as kitAddress, generateKeyPairSigner, signBytes } from '@solana/kit';
import { World, ADDRESSES, PROGRAM_IDS, LAMPORTS, P, C, IDL, decodeAccount, ata as sdkAta, damm as sdkDamm, completeCurve, readMetadata, assertInvariants, programSha256 } from './helpers.mjs';
import { launchpadLookupTableAddresses, buildCreateLookupTable } from '../sdk/launchpad/lookup-table.mts';
import { buildLaunch, buildWithdrawLeftover } from '../sdk/launchpad/trade.mts';
import { d1 } from '../../test/helpers/d1.js';
import { ensureSchema } from '../../src/store.js';
import { createSession } from '../../src/auth.js';
import { handleLaunchApi } from '../../src/lplaunch.js';
import { _resetLpKit, GENESIS } from '../../src/lpkit.js';
import { _resetLpCoins } from '../../src/lpcoins.js';
import { _setProgramPinsForTests } from '../../src/programpins.js';
import { base58Decode } from '../../src/solana.js';
import { metadataAddress } from '../../src/sol/metaplex.js';
import { decodeHeader } from '../../src/sol/message.js';
import { _resetTickers } from '../../src/tickers.js';
import { metadataUriFor } from '../../src/coinmeta.js';
import * as LX from '../../src/sol/lplaunch-ix.js';

const DEV = ADDRESSES.feeRecipient;
const SITE = 'https://vicinity.city';
const plain = (ix) => ({ p: String(ix.programAddress), a: ix.accounts.map((x) => `${x.address}:${x.role}`), d: Buffer.from(ix.data).toString('hex') });
const asRpc = (acc, slice) => {
  if (!acc) return null;
  let data = Buffer.from(acc.data);
  if (slice) data = data.subarray(slice.offset, slice.offset + slice.length);
  return { owner: String(acc.programAddress), lamports: Number(acc.lamports), data: [data.toString('base64'), 'base64'], executable: Boolean(acc.executable), rentEpoch: 0, space: Number(acc.space ?? data.length) };
};

/** A JSON-RPC stand-in over the World: the reads and the simulation the founder routes make. */
function worldRpc(w) {
  return async (url, init) => {
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
        result = w.svm.getProgramAccounts(kitAddress(program)).filter((x) => {
          const d = Buffer.from(x.data);
          return (cfg.filters || []).every((f) => (f.dataSize != null ? d.length === f.dataSize : Buffer.from(base58Decode(f.memcmp.bytes)).equals(d.subarray(f.memcmp.offset, f.memcmp.offset + 32))));
        }).map((x) => ({ pubkey: String(x.address), account: asRpc(x) }));
        break;
      }
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
      default: throw new Error(`unexpected ${method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
}
describe('18 the founder launch and graduation against the real programs', () => {
  let w, rpc, env, table, founderA, founderB, crowd, coinA, coinB;
  const cityA = 180001n, cityB = 180002n;
  const cookies = new Map(); // wallet -> "vs=<token>"

  /** One route of src/lplaunch.js as the signed-in `wallet` (a session cookie made the way a login makes it). */
  async function call(wallet, path, body) {
    const get = body === undefined;
    const url = `${SITE}${path}${get ? `${path.includes('?') ? '&' : '?'}cluster=devnet` : ''}`;
    const headers = { cookie: cookies.get(wallet) || '', origin: SITE, 'content-type': 'application/json' };
    const req = new Request(url, get ? { headers } : { method: 'POST', headers, body: JSON.stringify({ cluster: 'devnet', ...body }) });
    const r = await handleLaunchApi(req, env, rpc, Date.now());
    return { status: r.status, data: await r.json() };
  }
  /** Sign the Worker's unsigned transaction (the session wallet, then the one-time keys) and run it. */
  async function exec(built, signers) {
    assert.equal(built.ok, true, JSON.stringify(built));
    const tx = Buffer.from(built.tx, 'base64');
    const d = decodeHeader(tx);
    const message = tx.subarray(d.messageOffset);
    assert.deepEqual(d.staticKeys.slice(0, d.header.numRequiredSignatures), signers.map((s) => s.address), 'the signers the Worker asked for, in order');
    const signatures = {};
    for (const s of signers) signatures[s.address] = await signBytes(s.keyPair.privateKey, message);
    const res = w.svm.sendTransaction({ messageBytes: message, signatures });
    w.svm.expireBlockhash();
    if (typeof res.err === 'function') throw new Error(`failed: ${JSON.stringify(res.err(), (k, v) => (typeof v === 'bigint' ? String(v) : v))}\n  ${res.meta().logs().slice(-12).join('\n  ')}`);
    if (w.autoInvariants) assertInvariants(w);
    return { tx, decoded: d, cu: Number(res.computeUnitsConsumed()) };
  }
  async function signIn(signer, id, { city = null, name = null } = {}) {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO users (id, wallet, provider, provider_id, handle, created_at) VALUES (?, ?, 'wallet', ?, ?, ?)").bind(id, signer.address, signer.address, `p${id}`, now).run();
    if (city) {
      await env.DB.prepare("INSERT INTO seats (city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at, activated_at) VALUES (?, ?, 'NL', ?, ?, 1, 0, 'active', ?, ?)").bind(String(city), name, id, signer.address, now, now).run();
    }
    const c = await createSession(env, { wallet: signer.address, userId: id, provenAt: now }, 3600, Date.now());
    cookies.set(signer.address, c.split(';')[0]);
  }

  before(async () => {
    _resetLpKit(); _resetLpCoins(); _resetTickers();
    // the routes run as devnet on the Meteora dumps this World loads: those are the builds the suite tests, so they are this
    // process's devnet pins (src/programpins.js; a launch from the site waits while Meteora's programs are not the tested builds)
    _setProgramPinsForTests({ devnet: { dbc: programSha256('dbc.so'), dammV2: programSha256('damm_v2.so') } });
    w = await World.create();
    rpc = worldRpc(w);
    founderA = await w.signer(50n);
    founderB = await w.signer(50n);
    crowd = await w.signer(20n);
    const tickers = { [String(cityA)]: 'ALPHA', [String(cityB)]: 'BETA' };
    env = {
      DB: d1(), ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/data/tickers.json' ? new Response(JSON.stringify(tickers)) : new Response('', { status: 404 })) },
      LAUNCHPAD_CLUSTER: 'devnet', LAUNCHPAD_PROGRAM_ID: PROGRAM_IDS.launchpad, LAUNCHPAD_REWARDS_PROGRAM_ID: PROGRAM_IDS.rewards, LAUNCHPAD_RPC_URL: 'https://litesvm.test',
      LAUNCHPAD_DBC_CONFIGS: w.config,
    };
    await ensureSchema(env.DB);
    await signIn(founderA, 1, { city: cityA, name: 'Alpha City' });
    await signIn(founderB, 2, { city: cityB, name: 'Beta Town' });
    await signIn(crowd, 3);
    // the Vicinity speed table (what setup step 6 makes): created at a slot in SlotHashes, then used one slot later
    const clock = w.svm.getClock(), hashes = w.svm.getSlotHashes();
    const h = hashes[0]; h.slot = clock.slot - 10n; w.svm.setSlotHashes([h]);
    const t = buildCreateLookupTable({ authority: w.admin.address, recentSlot: clock.slot - 10n, addresses: launchpadLookupTableAddresses({ dbcConfigs: [w.config] }) });
    await w.send([t.create, ...t.extends.slice(0, 1)], [w.admin], 'lookup table create');
    for (const x of t.extends.slice(1)) await w.send([x], [w.admin], 'lookup table extend');
    w.warp(2);
    table = t.lookupTable;
    env.LAUNCHPAD_LOOKUP_TABLE = table;
  });

  it('TO01 the builders equal the SDK', async () => {
    const L = PROGRAM_IDS.launchpad, f = founderA.address, m = crowd.address, cfg = w.config;
    const a = await LX.launchAccounts({ programId: L, cityId: 7n, baseMint: m, dbcConfig: cfg, quoteMint: ADDRESSES.wsol });
    const mine = [await LX.launch({ programId: L, founder: f, baseMint: m, cityId: 7n, dbcConfig: cfg, quoteMint: ADDRESSES.wsol, rentPayer: w.admin.address }),
      ...(await LX.firstBuy({ founder: f, mint: m, pool: a.pool, dbcConfig: cfg, amountIn: 2n * LAMPORTS, minOut: 5n }))];
    const sdk = buildLaunch({ founder: f, baseMint: m, cityId: 7n, dbcConfig: cfg, quoteMint: ADDRESSES.wsol, rentPayer: w.admin.address, firstBuy: { amountIn: 2n * LAMPORTS, minOut: 5n } });
    assert.deepEqual(mine.map(plain), sdk.map(plain), 'launch + first buy = trade.mts buildLaunch');
    const coin = { cityId: 9n, mint: m, quoteMint: ADDRESSES.wsol, dbcPool: f, dbcConfig: cfg };
    assert.deepEqual(plain(await LX.claimFounderFees({ programId: L, founder: f, coin })), plain(C.claimFounderFees({ founder: f, coin })));
    const [n1, n2] = [w.admin.address, w.payer.address];
    assert.deepEqual(plain(await LX.migrateToDammV2({ payer: f, dbcPool: crowd.address, dbcConfig: cfg, coinMint: m, quoteMint: ADDRESSES.wsol, firstNftMint: n1, secondNftMint: n2 })),
      plain(C.migrateToDammV2({ payer: f, dbcPool: crowd.address, dbcConfig: cfg, coinMint: m, quoteMint: ADDRESSES.wsol, firstNftMint: n1, secondNftMint: n2 })));
    assert.deepEqual((await LX.leftoverInstructions({ payer: f, coin: { mint: m, dbcPool: crowd.address, dbcConfig: cfg } })).map(plain), buildWithdrawLeftover({ payer: f, coin: { mint: m, dbcPool: crowd.address, dbcConfig: cfg, quoteMint: ADDRESSES.wsol } }).map(plain));
  });

  it('TO02 status "ready" from the chain; the launch without a buy, through the speed table; the SOL change is exact', async () => {
    assert.equal((await call(founderA.address, `/api/lp/launch/status?city=${cityA}`)).data.state, 'not_approved');
    await w.approve({ cityId: cityA, founder: founderA, name: 'Alpha City', symbol: 'ALPHA' });
    await w.approve({ cityId: cityB, founder: founderB, name: 'Beta Town', symbol: 'BETA' });
    const st = (await call(founderA.address, `/api/lp/launch/status?city=${cityA}`)).data;
    assert.deepEqual([st.state, st.coin.name, st.coin.symbol, st.ticker, st.fees.totalPct, st.fees.founderPct], ['ready', 'Alpha City', 'ALPHA', 'ALPHA', 1.25, 0.25], JSON.stringify(st));
    assert.equal((await call(founderB.address, `/api/lp/launch/tx`, { cityId: String(cityA), mint: crowd.address })).data.error, 'not_founder', 'another city\'s founder');
    const mint = await generateKeyPairSigner();
    const built = (await call(founderA.address, '/api/lp/launch/tx', { cityId: String(cityA), mint: mint.address })).data;
    assert.equal(built.version, 0);
    assert.equal(decodeHeader(Buffer.from(built.tx, 'base64')).lookups[0].key, table);
    const adminBefore = w.lamportsOf(w.admin.address), before = w.lamportsOf(founderA.address);
    const ran = await exec(built, [founderA, mint]);
    console.log(`TO02 launch through the table: ${built.bytes} bytes, ${ran.cu} compute units, the founder paid ${-built.solChange[founderA.address] / 1e9} SOL`);
    assert.equal(w.lamportsOf(founderA.address) - before, BigInt(built.solChange[founderA.address]), 'exactly the SOL change the page showed');
    assert.ok(w.lamportsOf(w.admin.address) > adminBefore, 'the approval\'s rent went back to the admin');
    assert.equal(w.exists(P.approval(cityA)), false);
    coinA = w.coin(cityA, founderA);
    assert.deepEqual([coinA.founder, coinA.mint, coinA.dbcConfig, coinA.dbcPool], [founderA.address, mint.address, w.config, built.pool]);
    const md = readMetadata(w.account(await metadataAddress(mint.address)).data);
    assert.deepEqual([md.name, md.symbol, md.uri, md.isMutable], ['Alpha City', 'ALPHA', metadataUriFor(mint.address), false]);
    assert.equal(w.pool(coinA.dbcPool).baseMint, mint.address);
    const after = (await call(founderA.address, `/api/lp/launch/status?city=${cityA}`)).data;
    assert.deepEqual([after.state, after.mint, after.yours], ['launched', mint.address, true]);
    assert.equal((await call(founderA.address, '/api/lp/launch/tx', { cityId: String(cityA), mint: crowd.address })).data.error, 'already_launched');
  });

  it('TO03 the launch with a first buy in the same transaction: the exact quoted coins, nothing wrapped left behind', async () => {
    const buy = 2n * LAMPORTS;
    const q = (await call(founderB.address, `/api/lp/launch/status?city=${cityB}&buy=${buy}`)).data.quote;
    const mint = await generateKeyPairSigner();
    const built = (await call(founderB.address, '/api/lp/launch/tx', { cityId: String(cityB), mint: mint.address, firstBuyLamports: String(buy) })).data;
    assert.equal(built.ok, true, JSON.stringify(built));
    assert.ok(built.bytes <= 1232, `${built.bytes} bytes`);
    assert.equal(built.version, 0);
    assert.deepEqual([built.quote.coinsOut, built.quote.minOut], [q.coinsOut, q.minOut], 'the build quotes what the status quoted');
    const before = w.lamportsOf(founderB.address);
    const ran = await exec(built, [founderB, mint]);
    console.log(`TO03 launch + first buy through the table: ${built.bytes} bytes, ${ran.cu} compute units`);
    assert.equal(w.lamportsOf(founderB.address) - before, BigInt(built.solChange[founderB.address]), 'exactly the SOL change the page showed');
    coinB = w.coin(cityB, founderB);
    assert.equal(w.balance(sdkAta(founderB.address, mint.address)), BigInt(q.coinsOut), 'exactly the quoted coins');
    assert.equal(w.exists(sdkAta(founderB.address, ADDRESSES.wsol)), false, 'no wrapped SOL left');
    assert.ok(w.exists(sdkAta(DEV, ADDRESSES.wsol)), 'the dev wallet\'s referral account exists');
    assert.equal((await call(founderB.address, `/api/lp/launch/status?city=${cityB}`)).data.state, 'launched');
  });

  it('TO04 graduation: only on a full curve; anyone signed in pays; two one-time keys; then the leftover; then nothing', async () => {
    const nft = async () => [await generateKeyPairSigner(), await generateKeyPairSigner()];
    let [n1, n2] = await nft();
    let st = (await call(crowd.address, `/api/lp/graduate/status?mint=${coinB.mint}`)).data;
    assert.deepEqual([st.stage, st.canMigrate], ['curve', false]);
    assert.equal((await call(crowd.address, '/api/lp/graduate/tx', { mint: coinB.mint, step: 'migrate', nft1: n1.address, nft2: n2.address })).data.error, 'not_full');
    await completeCurve(w, coinB);
    st = (await call(crowd.address, `/api/lp/graduate/status?mint=${coinB.mint}`)).data;
    assert.deepEqual([st.stage, st.canMigrate, st.leftoverDue], ['full', true, true], JSON.stringify(st));
    [n1, n2] = await nft();
    const built = (await call(crowd.address, '/api/lp/graduate/tx', { mint: coinB.mint, step: 'migrate', nft1: n1.address, nft2: n2.address })).data;
    assert.equal(built.fees.computeUnitLimit, 400_000);
    const before = w.lamportsOf(crowd.address);
    const ran = await exec(built, [crowd, n1, n2]);
    console.log(`TO04 migration through the table: ${built.bytes} bytes, ${ran.cu} compute units, the payer paid ${Number(before - w.lamportsOf(crowd.address)) / 1e9} SOL`);
    assert.equal(w.lamportsOf(crowd.address) - before, BigInt(built.solChange[crowd.address]));
    assert.equal(w.pool(coinB.dbcPool).isMigrated, 1);
    const dpool = sdkDamm.pool(ADDRESSES.dammCustomizableConfig, coinB.mint, coinB.quoteMint);
    assert.equal(built.pool, dpool);
    assert.ok(w.exists(dpool), 'the DAMM v2 pool exists');
    st = (await call(crowd.address, `/api/lp/graduate/status?mint=${coinB.mint}`)).data;
    assert.deepEqual([st.stage, st.canMigrate, st.leftoverDue], ['graduated', false, true]);
    assert.equal((await call(crowd.address, '/api/lp/graduate/tx', { mint: coinB.mint, step: 'migrate', nft1: n1.address, nft2: n2.address })).data.error, 'already_graduated');
    const lo = (await call(crowd.address, '/api/lp/graduate/tx', { mint: coinB.mint, step: 'leftover' })).data;
    await exec(lo, [crowd]);
    assert.equal(w.pool(coinB.dbcPool).isWithdrawLeftover, 1);
    assert.ok(w.exists(sdkAta(DEV, coinB.mint)), 'the dev wallet\'s coin account (the leftover receiver)');
    st = (await call(crowd.address, `/api/lp/graduate/status?mint=${coinB.mint}`)).data;
    assert.deepEqual([st.stage, st.canMigrate, st.leftoverDue], ['graduated', false, false]);
    assert.equal((await call(crowd.address, '/api/lp/graduate/tx', { mint: coinB.mint, step: 'leftover' })).data.error, 'nothing_left');
  });

  it('TO05 the founder\'s fees: only the coin\'s founder; the curve\'s city share first; paid out as SOL', async () => {
    const trader = await w.signer(100n);
    for (let i = 0; i < 3; i++) await w.trade(trader, coinA, { side: 'buy', amount0: 2n * LAMPORTS });
    assert.ok(w.pool(coinA.dbcPool).creatorQuoteFee > 0n);
    assert.equal((await call(crowd.address, '/api/lp/founder-claim/tx', { cityId: String(cityA) })).data.error, 'founder_mismatch');
    const built = (await call(founderA.address, '/api/lp/founder-claim/tx', { cityId: String(cityA) })).data;
    assert.deepEqual(built.summary.map((x) => x.ix), ['set_compute_unit_limit', 'harvest_curve_fees', 'claim_founder_fees', 'close_account']);
    const before = w.lamportsOf(founderA.address);
    await exec(built, [founderA]);
    const after = w.coin(cityA, founderA);
    assert.ok(after.founderClaimed > 0n, 'claimed');
    assert.equal(after.founderClaimed, after.founderAccrued, 'everything accrued is claimed');
    assert.equal(w.balance(coinA.founderVault), 0n, 'the vault is empty');
    assert.equal(w.exists(sdkAta(founderA.address, ADDRESSES.wsol)), false, 'unwrapped: the founder holds SOL, not wrapped SOL');
    assert.equal(w.lamportsOf(founderA.address) - before, BigInt(built.solChange[founderA.address]), 'exactly the SOL change the page showed');
    assert.ok(w.lamportsOf(founderA.address) > before, 'the founder got SOL');
    assert.equal((await call(founderA.address, '/api/lp/founder-claim/tx', { cityId: String(cityA) })).data.error, 'nothing_to_claim');
  });
});
