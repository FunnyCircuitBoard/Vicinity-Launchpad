// TQ01-TQ03: the owner's daily launch-approval round (COIN_V2_BATCH, src/lpbatch.js) against the REAL launchpad program, in process.
// The Worker's routes list the round and build it UNSIGNED; every transaction is taken from the route's answer, signed by the launchpad
// admin (the owner's wallet: the only signer, the Worker holds no key) and run by litesvm; the chain is then read back and the route
// records it. The program is the build that runs on devnet, which differs from the live mainnet program only by its address
// (solana/release/mainnet-2026-10-10/BUILD.md), so this is the live program's behaviour.
//   TQ01 six founders whose chosen coins pass every check: two transactions (5 + 1), each within 1,232 bytes, every approval on chain
//        with the founder, name, ticker and a 14-day expiry; recorded; a founder then launches with no per-launch admin step
//   TQ02 under 48 hours left: renew = revoke_approval + approve_launch for the same city in ONE transaction (the program accepts the
//        re-created account in the same transaction), packed by measured size; every approval renewed for 14 days
//   TQ03 a founder who lost the seat: revoked, its rent back to the owner; nothing else touched
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner, signBytes } from '@solana/kit';
import { World, ADDRESSES, PROGRAM_IDS, P, C, IDL, decodeAccount, programSha256 } from './helpers.mjs';
import { d1 } from '../../test/helpers/d1.js';
import { chain, setHolding, MINT } from '../../test/helpers/world.js';
import { ensureSchema } from '../../src/store.js';
import { handleLpAdmin, _resetLpAdmin } from '../../src/lpadmin.js';
import { _resetLpKit, GENESIS } from '../../src/lpkit.js';
import { _resetLpCoins } from '../../src/lpcoins.js';
import { _setProgramPinsForTests } from '../../src/programpins.js';
import { base58Encode } from '../../src/solana.js';
import { decodeHeader, MAX_TX_BYTES } from '../../src/sol/message.js';
import { _resetTickers } from '../../src/tickers.js';
import { ensureReadySchema } from '../../src/coinart-store.js';
import { sha256Hex } from '../../src/coinart.js';

const asRpc = (acc) => (acc ? { owner: String(acc.programAddress), lamports: Number(acc.lamports), data: [Buffer.from(acc.data).toString('base64'), 'base64'], executable: Boolean(acc.executable), rentEpoch: 0, space: Number(acc.space ?? acc.data.length) } : null);
// six cities with long names and 10-character tickers: what the size limit is measured on
const CITIES = [
  [220001n, 'Saratoga Springs', 'SARATOGASP'], [220002n, 'Poughkeepsie', 'POUGHKEEPS'], [220003n, 'Niagara Falls', 'NIAGARAFAL'],
  [220004n, 'New Rochelle', 'NEWROCHELL'], [220005n, 'Mount Vernon', 'MOUNTVERNO'], [220006n, 'Schenectady', 'SCHENECTAD'],
];

/** A JSON-RPC stand-in over the World for the round's reads, the builds' simulations and the record's confirmations. */
function worldRpc(w, known) {
  const landed = new Map();
  const fetchImpl = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    let result;
    switch (method) {
      case 'getGenesisHash': result = GENESIS.devnet; break;
      case 'getLatestBlockhash': result = { context: { slot: 1 }, value: { blockhash: String(w.svm.latestBlockhash()), lastValidBlockHeight: 1_000_000 } }; break;
      case 'getAccountInfo': result = { context: { slot: 1 }, value: asRpc(w.account(params[0])) }; break;
      case 'getMultipleAccounts': result = { context: { slot: 1 }, value: params[0].map((a) => asRpc(w.account(a))) }; break;
      case 'getProgramAccounts': {
        const [program, cfg] = params;
        result = [...known].filter((a) => { const x = w.account(a); return x && String(x.programAddress) === program && (cfg.filters || []).every((f) => (f.dataSize != null ? x.data.length === f.dataSize : true)); })
          .map((a) => ({ pubkey: a, account: asRpc(w.account(a)) }));
        break;
      }
      case 'simulateTransaction': {
        const tx = Buffer.from(params[0], 'base64');
        const d = decodeHeader(tx);
        const signatures = Object.fromEntries(d.staticKeys.slice(0, d.header.numRequiredSignatures).map((k) => [k, new Uint8Array(64)]));
        w.svm.withSigverify(false);
        let res;
        try { res = w.svm.simulateTransaction({ messageBytes: tx.subarray(d.messageOffset), signatures }); } finally { w.svm.withSigverify(true); }
        const watched = params[1].accounts ? params[1].accounts.addresses : [];
        if (typeof res.err === 'function') result = { context: { slot: 1 }, value: { err: { InstructionError: [0, 'Custom'] }, logs: res.meta().logs(), unitsConsumed: 0, accounts: null } };
        else {
          const post = new Map(res.postAccounts().map((a) => [String(a.address), a]));
          result = { context: { slot: 1 }, value: { err: null, logs: res.meta().logs(), unitsConsumed: Number(res.meta().computeUnitsConsumed()), accounts: watched.map((a) => { const x = post.get(a) || w.account(a); return x ? { lamports: Number(x.lamports), owner: String(x.programAddress), data: ['', 'base64'] } : null; }) } };
        }
        break;
      }
      case 'getMinimumBalanceForRentExemption': result = Number(w.svm.minimumBalanceForRentExemption(BigInt(params[0]))); break;
      case 'getSignatureStatuses': result = { context: { slot: 1 }, value: params[0].map((s) => (landed.has(s) ? { slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' } : null)) }; break;
      case 'getTransaction': { const keys = landed.get(params[0]); result = keys ? { slot: 1, transaction: { message: { accountKeys: keys } }, meta: { err: null, loadedAddresses: { writable: [], readonly: [] } } } : null; break; }
      default: throw new Error(`unexpected ${method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  return { fetchImpl, landed };
}

describe('22 the owner\'s daily approval round against the real launchpad program', () => {
  let w, rpc, env, owner, now;
  const founders = [], known = new Set();
  const holders = chain();
  const ctxOf = (wallet) => ({ session: {}, user: { id: 1, wallet }, wallet, role: 'owner', db: env.DB, now, env, fetchImpl: (url, init) => (String(url).startsWith('https://litesvm.test') ? rpc.fetchImpl(url, init) : holders(url, init)) });
  async function call(sub, body) {
    const get = body === undefined;
    const req = new Request(`https://vicinity.city/api/admin/lp/${sub}${get ? '?cluster=devnet' : ''}`, get ? {} : { method: 'POST', body: JSON.stringify({ cluster: 'devnet', ...body }), headers: { 'content-type': 'application/json' } });
    const r = await handleLpAdmin(req, ctxOf(owner.address), sub, now);
    return { status: r.status, data: await r.json() };
  }
  /** The owner's wallet signs the Worker's unsigned bytes (it is their only signer); litesvm runs them; the route records them. */
  async function signAndRecord(t) {
    const tx = Buffer.from(t.tx, 'base64');
    assert.ok(tx.length <= MAX_TX_BYTES, `${tx.length} bytes`);
    const d = decodeHeader(tx);
    assert.deepEqual(d.staticKeys.slice(0, d.header.numRequiredSignatures), [owner.address], 'the owner is the only signer');
    const message = tx.subarray(d.messageOffset);
    // (every transaction of one build carries the same blockhash, as on chain: the round's are sent one after the other, then it expires)
    const res = w.svm.sendTransaction({ messageBytes: message, signatures: { [owner.address]: await signBytes(owner.keyPair.privateKey, message) } });
    if (typeof res.err === 'function') throw new Error(`failed: ${JSON.stringify(res.err(), (k, v) => (typeof v === 'bigint' ? String(v) : v))}\n  ${res.meta().logs().slice(-12).join('\n  ')}`);
    const sig = base58Encode(res.signature());
    rpc.landed.set(sig, d.staticKeys);
    const rec = await call('record', { step: 'batch', signature: sig, params: t.record.params });
    assert.equal(rec.data.ok, true, JSON.stringify(rec.data));
    return sig;
  }
  const approvalOf = (city) => (w.exists(P.approval(city)) ? decodeAccount(IDL.launchpad, 'Approval', w.account(P.approval(city)).data) : null);

  before(async () => {
    _resetLpKit(); _resetLpAdmin(); _resetLpCoins(); _resetTickers();
    _setProgramPinsForTests({ devnet: { dbc: programSha256('dbc.so'), dammV2: programSha256('damm_v2.so') } });
    w = await World.create();
    owner = w.admin; // the launchpad's admin: the owner's wallet
    now = Date.now();
    rpc = worldRpc(w, known);
    const tickers = Object.fromEntries(CITIES.map(([id, , t]) => [String(id), t]));
    env = {
      DB: d1(), ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/data/tickers.json' ? new Response(JSON.stringify(tickers)) : new Response('', { status: 404 })) },
      LAUNCHPAD_CLUSTER: 'devnet', LAUNCHPAD_PROGRAM_ID: PROGRAM_IDS.launchpad, LAUNCHPAD_REWARDS_PROGRAM_ID: PROGRAM_IDS.rewards, LAUNCHPAD_RPC_URL: 'https://litesvm.test',
      LAUNCHPAD_DBC_CONFIGS: w.config, COIN_V2_READY: 'on', COIN_V2_BATCH: 'on', VICINITY_MINT: MINT,
    };
    await ensureSchema(env.DB);
    await ensureReadySchema(env.DB);
    const at = new Date(now).toISOString();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const art = await sha256Hex(png);
    await env.DB.prepare("INSERT INTO coin_art (sha256, svg_sha256, template_version, type, bytes, created_at) VALUES (?, ?, 't1', 'image/png', ?, ?)").bind(art, 'b'.repeat(64), png, at).run();
    // each city: an active founder holding the bar, and their chosen Vicinity coin (the ready-made version, src/coinready.js)
    for (let i = 0; i < CITIES.length; i++) {
      const [city, name, ticker] = CITIES[i];
      const f = await w.signer(5n);
      founders.push(f);
      setHolding(f.address, 10);
      await env.DB.prepare("INSERT INTO users (id, wallet, provider, provider_id, handle, created_at) VALUES (?, ?, 'wallet', ?, ?, ?)").bind(100 + i, f.address, f.address, `f${i}`, at).run();
      await env.DB.prepare("INSERT INTO seats (id, city_id, city_name, country, user_id, wallet, policy, threshold, status, created_at) VALUES (?, ?, ?, 'US', ?, ?, 1, 1, 'active', ?)").bind(i + 1, String(city), name, 100 + i, f.address, at).run();
      const description = `The city coin of ${name}.`;
      await env.DB.prepare("INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, updated_at, created_at) VALUES (?, ?, 'US', ?, ?, ?, ?, 'SOL', 'ink', ?, ?)").bind(String(city), name, i + 1, 100 + i, name, description, at, at).run();
      const content = JSON.stringify({ v: 1, city: { id: String(city), name, region: 'New York', country: 'US', countryName: 'United States' }, name, symbol: ticker, description, image: { sha256: art, template: 't1' }, pair: 'SOL' });
      const hash = await sha256Hex(new TextEncoder().encode(content));
      const v = await env.DB.prepare("INSERT INTO coin_versions (city_id, origin, content_json, content_hash, name, symbol, description, art_sha256, template_version, created_at) VALUES (?, 'default', ?, ?, ?, ?, ?, ?, 't1', ?)").bind(String(city), content, hash, name, ticker, description, art, at).run();
      await env.DB.prepare("INSERT INTO coin_ready (city_id, version_id, content_hash, symbol, design_at, seat_id, user_id, chosen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(String(city), v.meta.last_row_id, hash, ticker, at, i + 1, 100 + i, at).run();
      known.add(String(P.approval(city)));
    }
  });

  it('TQ01 six chosen coins: two transactions (5 + 1) within 1,232 bytes signed by the owner alone; every approval on chain for 14 days; a founder then launches', async () => {
    const r = (await call('batch')).data;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.global, []);
    assert.deepEqual(r.groups.approve.map((x) => x.symbol).sort(), CITIES.map(([, , t]) => t).sort(), JSON.stringify(r.groups.blocked));
    const b = (await call('batch/tx', { rows: r.groups.approve.map(({ cityId, action, founder, name, symbol, contentHash }) => ({ cityId, action, founder, name, symbol, contentHash })) })).data;
    assert.equal(b.ok, true, JSON.stringify(b).slice(0, 800));
    assert.deepEqual(b.transactions.map((t) => t.cities.length), [5, 1]);
    for (const t of b.transactions) await signAndRecord(t);
    w.svm.expireBlockhash();
    const nowS = Math.floor(now / 1000);
    for (let i = 0; i < CITIES.length; i++) {
      const [city, name, ticker] = CITIES[i];
      const ap = approvalOf(city);
      assert.ok(ap, `approval of ${name}`);
      assert.deepEqual([ap.founder.toBase58(), ap.name, ap.symbol], [founders[i].address, name, ticker]);
      assert.ok(Math.abs(Number(ap.expires_at) - (nowS + 14 * 86_400)) < 5, 'a 14-day approval');
      assert.equal(ap.rent_payer.toBase58(), owner.address);
    }
    const log = (await env.DB.prepare("SELECT action, COUNT(*) AS n FROM lp_approvals_log GROUP BY action").all()).results;
    assert.deepEqual(log.map((x) => [x.action, x.n]), [['approve', 6]]);
    // nothing more to do today
    const again = (await call('batch')).data;
    assert.deepEqual([again.groups.approve.length, again.groups.renew.length, again.groups.revoke.length, again.settled], [0, 0, 0, 6]);
    // the founder launches with no per-launch admin step (their own wallet signs; the approval's rent comes back to the owner)
    const mint = await generateKeyPairSigner();
    const ownerBefore = w.lamportsOf(owner.address);
    await w.send([C.launch({ founder: founders[5].address, baseMint: mint.address, cityId: CITIES[5][0], dbcConfig: w.config, quoteMint: ADDRESSES.wsol, rentPayer: owner.address })], [founders[5], mint], 'launch', { feePayer: founders[5], cu: 400_000 });
    assert.equal(approvalOf(CITIES[5][0]), null, 'the approval is used up by the launch');
    assert.ok(w.lamportsOf(owner.address) > ownerBefore, 'its rent came back to the owner');
    known.add(String(P.coin(CITIES[5][0])));
  });

  it('TQ02 under 48 hours left: revoke + approve for the same city in ONE transaction, packed by measured size; every approval renewed for 14 days', async () => {
    now += Math.round(12.5 * 86_400_000);
    w.setClock(BigInt(Math.floor(now / 1000)));
    const r = (await call('batch')).data;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.groups.renew.length, 5, JSON.stringify(r.groups));
    assert.ok(r.groups.renew.every((x) => /^It ends in 36 hours/.test(x.why)));
    const b = (await call('batch/tx', { rows: r.groups.renew.map(({ cityId, action, founder, name, symbol, contentHash }) => ({ cityId, action, founder, name, symbol, contentHash })) })).data;
    assert.equal(b.ok, true, JSON.stringify(b).slice(0, 800));
    // five renewals of these names (each a revoke and an approve) still fit one transaction: measured, not assumed (signAndRecord checks
    // every transaction against the 1,232 bytes)
    assert.ok(b.transactions.every((t) => t.cities.length <= 5));
    assert.equal(b.transactions.flatMap((t) => t.cities).length, 5);
    for (const t of b.transactions) {
      const ixs = t.summary.filter((x) => x.ix === 'revoke_approval' || x.ix === 'approve_launch');
      for (const c of t.cities) {
        const at = ixs.findIndex((x) => x.ix === 'revoke_approval' && x.fields.cityId === c.cityId);
        assert.deepEqual([ixs[at + 1].ix, ixs[at + 1].fields.cityId], ['approve_launch', c.cityId], 'revoke then approve, same city, same transaction');
      }
      await signAndRecord(t);
    }
    w.svm.expireBlockhash();
    const nowS = Math.floor(now / 1000);
    for (let i = 0; i < 5; i++) {
      const ap = approvalOf(CITIES[i][0]);
      assert.ok(ap && Math.abs(Number(ap.expires_at) - (nowS + 14 * 86_400)) < 5, `renewed: ${CITIES[i][1]}`);
      assert.equal(ap.founder.toBase58(), founders[i].address);
    }
    const lines = (await env.DB.prepare("SELECT action FROM lp_approvals_log WHERE city_id = ? ORDER BY id").bind(String(CITIES[0][0])).all()).results.map((x) => x.action);
    assert.deepEqual(lines, ['approve', 'revoke', 'approve']);
  });

  it('TQ03 a founder who lost the seat: revoked on chain, its rent back to the owner; nothing else touched', async () => {
    await env.DB.prepare("UPDATE seats SET status = 'released' WHERE id = 1").run();
    const r = (await call('batch')).data;
    assert.deepEqual(r.groups.revoke.map((x) => x.cityId), [String(CITIES[0][0])]);
    assert.deepEqual([r.groups.approve.length, r.groups.renew.length], [0, 0]);
    const b = (await call('batch/tx', { rows: r.groups.revoke.map(({ cityId, action, founder, name, symbol }) => ({ cityId, action, founder, name, symbol, contentHash: null })) })).data;
    assert.equal(b.ok, true, JSON.stringify(b).slice(0, 800));
    assert.ok(b.transactions[0].solChange[owner.address] > 0, 'the page shows the rent coming back');
    const before = w.lamportsOf(owner.address);
    await signAndRecord(b.transactions[0]);
    w.svm.expireBlockhash();
    assert.equal(approvalOf(CITIES[0][0]), null);
    assert.ok(w.lamportsOf(owner.address) > before);
    for (let i = 1; i < 5; i++) assert.ok(approvalOf(CITIES[i][0]), 'the others stand');
  });
});
