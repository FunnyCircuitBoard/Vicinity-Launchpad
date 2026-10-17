// TM01-TM02: the site's /coin-meta (src/coinmeta.js, src/lpcoins.js, src/sol/metaplex.js) against a REAL launch, in process:
//   TM01 a coin launched by our program in litesvm: the Worker's Metaplex decoder reads exactly what the SDK's reads (name,
//        symbol, uri, immutable, no update authority), the Worker finds the coin by getProgramAccounts(dataSize 243, memcmp mint
//        at 48) over the World's accounts, records it, and serves a JSON that passes checkMetadataAgainstChain; the logo URL
//        redirects to the brand PNG; an unknown mint is 404
//   TM02 a name of 32 UTF-8 bytes with accents (the longest the program allows) comes back byte for byte (NUL padding stripped)
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { World, ADDRESSES, PROGRAM_IDS, P, C } from './helpers.mjs';
import * as S from '../sdk/launchpad/index.mts';
import { d1 } from '../../test/helpers/d1.js';
import { ensureSchema } from '../../src/store.js';
import { handleCoinMeta, metadataUriFor } from '../../src/coinmeta.js';
import { _resetLpCoins } from '../../src/lpcoins.js';
import { decodeMetadata, metadataAddress } from '../../src/sol/metaplex.js';
import { decodeCoin } from '../../src/sol/dbc.js';
import { base58Decode } from '../../src/solana.js';

const asRpcAccount = (acc) => (acc ? { owner: String(acc.programAddress), lamports: Number(acc.lamports), data: [Buffer.from(acc.data).toString('base64'), 'base64'], executable: false, rentEpoch: 0 } : null);

/** A JSON-RPC stand-in over the World: the reads /coin-meta makes (getProgramAccounts scans the accounts the test names). */
function worldRpc(w, known) {
  const log = [];
  const fetchImpl = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    log.push(method);
    let result;
    if (method === 'getAccountInfo') result = { context: { slot: 1 }, value: asRpcAccount(w.account(params[0])) };
    else if (method === 'getMultipleAccounts') result = { context: { slot: 1 }, value: params[0].map((a) => asRpcAccount(w.account(a))) };
    else if (method === 'getSignaturesForAddress') result = [];
    else if (method === 'getProgramAccounts') {
      const [program, cfg] = params;
      result = known().filter((a) => {
        const acc = w.account(a);
        if (!acc || String(acc.programAddress) !== program) return false;
        const d = Buffer.from(acc.data);
        return (cfg.filters || []).every((f) => (f.dataSize != null ? d.length === f.dataSize : ((want) => want.equals(d.subarray(f.memcmp.offset, f.memcmp.offset + want.length)))(Buffer.from(base58Decode(f.memcmp.bytes)))));
      }).map((a) => ({ pubkey: a, account: asRpcAccount(w.account(a)) }));
    } else throw new Error('unexpected ' + method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  return { fetchImpl, log };
}

describe('16 /coin-meta against a real launch', () => {
  let w, env, rpc, coins = [];
  before(async () => {
    w = await World.create();
    env = { DB: d1(), LAUNCHPAD_CLUSTER: 'devnet', LAUNCHPAD_PROGRAM_ID: PROGRAM_IDS.launchpad, LAUNCHPAD_REWARDS_PROGRAM_ID: PROGRAM_IDS.rewards, LAUNCHPAD_RPC_URL: 'https://litesvm.test' };
    await ensureSchema(env.DB);
    rpc = worldRpc(w, () => coins);
    _resetLpCoins();
  });
  const get = (path) => handleCoinMeta(new Request(`https://vicinity.city${path}`, { headers: { 'cf-connecting-ip': '198.51.100.1' } }), env, rpc.fetchImpl);

  it('TM01 a launched coin: the Worker reads the chain like the SDK and serves a JSON that matches it', async () => {
    const cityId = 160001n;
    const coin = await w.launchCoin({ cityId, name: 'Meta City', symbol: 'META' });
    coins.push(coin.address);
    await env.DB.prepare(`INSERT INTO city_coins (city_id, city_name, country, seat_id, user_id, name, pitch, pair, color, updated_at, created_at)
      VALUES (?, 'Meta City', 'NL', 1, 1, 'A design name', 'Canals and coins.', 'SOL', 'gold', ?, ?)`).bind(String(cityId), new Date().toISOString(), new Date().toISOString()).run();

    // the metadata account: the Worker's address and decoder equal the SDK's
    const mdAddr = C.launchAccounts({ cityId, baseMint: coin.mint, dbcConfig: w.config, quoteMint: ADDRESSES.wsol }).metadata;
    assert.equal(await metadataAddress(coin.mint), mdAddr);
    const raw = w.account(mdAddr);
    const sdk = S.decodeMetaplexMetadata(raw.data);
    const mine = decodeMetadata(asRpcAccount(raw));
    assert.deepEqual(mine, { ...sdk });
    assert.deepEqual([mine.name, mine.symbol, mine.uri, mine.isMutable, mine.updateAuthority, mine.mint], ['Meta City', 'META', metadataUriFor(coin.mint), false, PROGRAM_IDS.system, coin.mint]);
    assert.equal(decodeMetadata({ ...asRpcAccount(raw), owner: PROGRAM_IDS.launchpad }), null, 'another owner is not Metaplex metadata');
    const c = decodeCoin(asRpcAccount(w.account(coin.address)), PROGRAM_IDS.launchpad);
    assert.deepEqual([c.mint, c.dbcPool, String(c.cityId)], [coin.mint, coin.dbcPool, String(cityId)]);
    assert.equal(await P.coin(cityId), coin.address);

    const r = await get(`/coin-meta/${coin.mint}.json`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const json = await r.json();
    assert.deepEqual(S.checkMetadataAgainstChain(json, { mint: coin.mint, ...sdk }), [], 'the JSON agrees with the chain');
    assert.deepEqual(json, S.coinMetadataJson({ mint: coin.mint, name: sdk.name, symbol: sdk.symbol, pitch: 'Canals and coins.', city: { id: cityId, name: 'Meta City', country: 'NL', ticker: 'META' } }));
    assert.equal(json.external_url, `https://vicinity.city/coin?mint=${coin.mint}`);
    assert.ok(rpc.log.includes('getProgramAccounts'));
    // recorded: the city's design now carries the mint (locked), and a second answer needs no chain read
    assert.equal((await env.DB.prepare('SELECT mint FROM city_coins WHERE city_id = ?').bind(String(cityId)).first()).mint, coin.mint);
    const n = rpc.log.length;
    assert.deepEqual(await (await get(`/coin-meta/${coin.mint}.json`)).json(), json);
    assert.equal(rpc.log.length, n);
    const png = await get(`/coin-meta/${coin.mint}.png`);
    assert.deepEqual([png.status, png.headers.get('location')], [302, '/brand/vicinity-512.png']);
    assert.equal((await get(`/coin-meta/${ADDRESSES.wsol}.json`)).status, 404, 'not one of our coins');
  });

  it('TM02 the longest name the program takes (32 UTF-8 bytes, accents) round-trips exactly', async () => {
    const cityId = 160002n;
    const name = 'São Paulo Moedas ÁÉÍÓ Útil'; // 32 bytes in UTF-8
    assert.equal(Buffer.byteLength(name), 32);
    const coin = await w.launchCoin({ cityId, name, symbol: 'SAO' });
    coins.push(coin.address);
    const json = await (await get(`/coin-meta/${coin.mint}.json`)).json();
    assert.equal(json.name, name);
    assert.equal(json.symbol, 'SAO');
    assert.equal(json.city.name, name, 'no design row: the coin\'s own name stands for the city');
    const md = S.decodeMetaplexMetadata(w.account(C.launchAccounts({ cityId, baseMint: coin.mint, dbcConfig: w.config, quoteMint: ADDRESSES.wsol }).metadata).data);
    assert.deepEqual(S.checkMetadataAgainstChain(json, { mint: coin.mint, ...md }), []);
  });
});
