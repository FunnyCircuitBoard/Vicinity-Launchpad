// TW01-TW06: the Worker's own Solana modules (src/sol/*, src/lptrade.js: no web3.js, no anchor) against the SDK and the
// real programs, in process:
//   TW01 the generated layout (src/sol/layout.js) is what the IDLs say; every Worker decoder reads the World's accounts
//        exactly as the anchor-based SDK decoders do; every PDA / ATA the Worker derives equals the SDK's
//   TW02 the Worker's trade instruction lists equal the SDK's buildBuy / buildSell (program, accounts, roles, data)
//   TW03 message compiler parity: compileLegacy / compileV0 give the very bytes web3.js's TransactionMessage compiles,
//        with no table, with the Vicinity lookup table, with two tables and with a table that names a signer and a program
//        (which must stay static); decodeHeader reads them back
//   TW04 240 random buys and sells: the Worker's quotes equal quoteBuy / quoteSell to the raw unit, and the Worker-built
//        transactions, signed by the trader and run by litesvm against the real DBC program, move exactly the predicted
//        amounts (the last buy of the curve as a partial fill with its refund included)
//   TW05 the dev wallet closed its referral account: the Worker-built trade recreates it and goes through (TJ11's case)
//   TW06 RECORD=1 writes test/fixtures/launchpad-worker/world.json (account bytes, trades, expected quotes and message
//        bytes) for the root suite, which replays them without web3.js (test/lptrade.test.js)
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import web3 from '@solana/web3.js';
import { signBytes } from '@solana/kit';
import { World, ADDRESSES, PROGRAM_IDS, LAMPORTS, P, ata as sdkAta, dbc as sdkDbc } from './helpers.mjs';
import * as S from '../sdk/launchpad/index.mts';
import * as WB from '../../src/sol/bytes.js';
import * as WP from '../../src/sol/pda.js';
import * as WD from '../../src/sol/dbc.js';
import * as WQ from '../../src/sol/quote.js';
import * as WI from '../../src/sol/ix.js';
import * as WM from '../../src/sol/message.js';
import { tradeInstructions, curveQuote } from '../../src/lptrade.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { PublicKey, TransactionMessage } = web3;
const WSOL = ADDRESSES.wsol;
const STEPS = Number(process.env.WORKER_PARITY_STEPS ?? 240);
const SEED = BigInt(process.env.WORKER_PARITY_SEED ?? '777');
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const rng = (seed) => { let x = seed || 88172645463325252n; return () => { x ^= x << 13n; x &= (1n << 64n) - 1n; x ^= x >> 7n; x ^= x << 17n; x &= (1n << 64n) - 1n; return x; }; };
const hex = (u8) => Buffer.from(u8).toString('hex');
const asRpcAccount = (acc) => ({ owner: String(acc.programAddress), lamports: Number(acc.lamports), data: [Buffer.from(acc.data).toString('base64'), 'base64'] });
const plain = (ix) => ({ p: ix.programAddress, a: ix.accounts.map((x) => `${x.address}:${x.role}`), d: hex(ix.data) });
const web3Legacy = (payer, ixs, blockhash) => new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: ixs.map(S.toWeb3Instruction) }).compileToLegacyMessage().serialize();
const web3V0 = (payer, ixs, blockhash, luts) => Buffer.from(new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: ixs.map(S.toWeb3Instruction) }).compileToV0Message(luts).serialize());

describe('15 the Worker builder (src/sol, src/lptrade.js) against the SDK and the real programs', () => {
  let w, coin, trader, lut, lutAddrs, record;
  const market = () => ({ pool: WD.decodePool(asRpcAccount(w.account(coin.dbcPool))), config: WD.decodeConfig(asRpcAccount(w.account(coin.dbcConfig))) });
  const sdkMarket = () => ({ pool: S.decodeDbcPool(w.account(coin.dbcPool).data), config: S.decodeDbcConfig(w.account(coin.dbcConfig).data) });
  /** Sign the Worker's message with a kit signer and run it in litesvm; returns litesvm's result (throws on failure with logs). */
  async function run(message, signer, label) {
    const sig = await signBytes(signer.keyPair.privateKey, message);
    const res = w.svm.sendTransaction({ messageBytes: message, signatures: { [signer.address]: sig } });
    w.svm.expireBlockhash();
    if (typeof res.err === 'function') throw new Error(`${label} failed: ${JSON.stringify(res.err(), (k, v) => (typeof v === 'bigint' ? String(v) : v))}\n  ${res.meta().logs().slice(-8).join('\n  ')}`);
    return res;
  }
  const bh = () => w.svm.latestBlockhash();

  before(async () => {
    w = await World.create();
    w.emptyTokenAccount(ADDRESSES.feeRecipient, WSOL);
    const founder = await w.signer(200n);
    coin = await w.launchCoin({ cityId: 150001n, founder, name: 'Worker City', symbol: 'WRK' });
    trader = await w.signer(2_000n);
    lutAddrs = S.launchpadLookupTableAddresses({ dbcConfigs: [w.config] });
    lut = S.lookupTableFrom('7UbiauZFTRXXy8zGMNYsZDPGu1NsDJTNVp7xX7sBQd6c', lutAddrs);
    record = { recordedAt: new Date().toISOString(), programId: PROGRAM_IDS.launchpad, lookupTable: { key: '7UbiauZFTRXXy8zGMNYsZDPGu1NsDJTNVp7xX7sBQd6c', addresses: lutAddrs }, accounts: {}, trades: [] };
  });

  it('TW01 layout, decoders and PDAs equal the SDK', async () => {
    const chk = spawnSync(process.execPath, [join(here, '..', 'scripts', 'launchpad', 'idl-offsets.mjs'), '--check'], { encoding: 'utf8' });
    assert.equal(chk.status, 0, chk.stdout + chk.stderr);
    const { pool, config } = market();
    const sm = sdkMarket();
    for (const k of ['config', 'creator', 'baseMint', 'baseVault', 'quoteVault', 'baseReserve', 'quoteReserve', 'sqrtPrice', 'isMigrated', 'migrationProgress', 'protocolQuoteFee', 'partnerQuoteFee', 'creatorQuoteFee']) assert.equal(pool[k], sm.pool[k], `pool.${k}`);
    for (const k of ['quoteMint', 'feeClaimer', 'leftoverReceiver', 'feeNumerator', 'creatorTradingFeePercentage', 'swapBaseAmount', 'migrationQuoteThreshold', 'migrationBaseThreshold', 'migrationSqrtPrice', 'sqrtStartPrice', 'poolCreationFee', 'tokenDecimal', 'migratedPoolFeeBps']) assert.equal(config[k], sm.config[k], `config.${k}`);
    assert.deepEqual(config.curve, sm.config.curve, 'curve[20]');
    const c = WD.decodeCoin(asRpcAccount(w.account(coin.address)), PROGRAM_IDS.launchpad), sc = S.decodeCoin(w.account(coin.address).data);
    for (const k of ['cityId', 'founder', 'mint', 'quoteMint', 'dbcConfig', 'dbcPool', 'launchedAt', 'holdersAccrued', 'founderAccrued']) assert.equal(c[k], sc[k], `coin.${k}`);
    const lp = WD.decodeLaunchpad(asRpcAccount(w.account(P.launchpad())), PROGRAM_IDS.launchpad), slp = S.decodeLaunchpad(w.account(P.launchpad()).data);
    for (const k of ['admin', 'pendingAdmin', 'payoutAuthority', 'payoutDestination', 'rewardsProgram', 'launchesPaused', 'payoutsPaused']) assert.equal(lp[k], slp[k], `launchpad.${k}`);
    const lc = WD.decodeLaunchConfig(asRpcAccount(w.account(P.launchConfig(w.config))), PROGRAM_IDS.launchpad), slc = S.decodeLaunchConfig(w.account(P.launchConfig(w.config)).data);
    for (const k of ['dbcConfig', 'quoteMint', 'migrationQuoteThreshold', 'tradeFeeNumerator', 'poolCreationFee', 'enabled', 'addedAt']) assert.equal(lc[k], slc[k], `launchConfig.${k}`);
    // the wrong owner, size or discriminator is "not that account"
    assert.equal(WD.decodePool({ ...asRpcAccount(w.account(coin.dbcPool)), owner: PROGRAM_IDS.launchpad }), null);
    assert.equal(WD.decodePool(asRpcAccount(w.account(coin.dbcConfig))), null);
    assert.equal(WD.decodeCoin(asRpcAccount(w.account(P.launchpad())), PROGRAM_IDS.launchpad), null);
    // PDAs and ATAs
    const LP = WP.launchpad(PROGRAM_IDS.launchpad);
    assert.equal(await LP.coin(coin.cityId), P.coin(coin.cityId));
    assert.equal(await LP.launchpad(), P.launchpad());
    assert.equal(await LP.launchConfig(w.config), P.launchConfig(w.config));
    assert.equal(await LP.holdersPot(coin.address), P.holdersPot(coin.address));
    assert.equal(await WP.ata(trader.address, coin.mint), sdkAta(trader.address, coin.mint));
    assert.equal(await WP.ata(trader.address, WSOL, PROGRAM_IDS.token2022), sdkAta(trader.address, WSOL, PROGRAM_IDS.token2022));
    assert.equal(await WP.dbc.pool(w.config, coin.mint, WSOL), sdkDbc.pool(w.config, coin.mint, WSOL));
    assert.equal(await WP.dbc.pool(w.config, WSOL, coin.mint), sdkDbc.pool(w.config, coin.mint, WSOL), 'order of the mints does not matter');
    assert.equal(await WP.dbc.tokenVault(coin.mint, coin.dbcPool), sdkDbc.tokenVault(coin.mint, coin.dbcPool));
    assert.equal(await WP.dbc.eventAuthority(), sdkDbc.eventAuthority());
    assert.equal(await WP.programDataAddress(PROGRAM_IDS.launchpad), S.pda.programDataAddress(PROGRAM_IDS.launchpad));
    assert.deepEqual(WP.PROGRAM_IDS.dbc, S.pda.PROGRAM_IDS.dbc);
    assert.equal(WD.PROGRAM_CONSTANTS.FEE_RECIPIENT, S.FEE_RECIPIENT);
    for (const k of Object.keys(record.accounts)) delete record.accounts[k];
    for (const [name, addr] of [['pool', coin.dbcPool], ['config', coin.dbcConfig], ['coin', coin.address], ['launchpad', P.launchpad()], ['launchConfig', P.launchConfig(w.config)]]) record.accounts[name] = { address: addr, ...asRpcAccount(w.account(addr)) };
  });

  it('TW02 instruction lists equal buildBuy / buildSell', async () => {
    const amountIn = 3n * LAMPORTS;
    const { pool, config } = market();
    const q = WQ.quoteBuy(pool, config, { amountIn, slippageBps: 100 });
    const mine = await tradeInstructions({ side: 'buy', taker: trader.address, coin, amountIn, amountRaw: amountIn, minOut: q.minOut, cuLimit: WI.CU.swap });
    const sdk = [S.setComputeUnitLimit(S.CU.swap), ...S.buildBuy({ trader: trader.address, coin, amountIn, minOut: q.minOut })];
    assert.deepEqual(mine.map(plain), sdk.map(plain), 'buy instructions');
    const sell = await tradeInstructions({ side: 'sell', taker: trader.address, coin, amountRaw: 1_000_000n, minOut: 1n, cuLimit: WI.CU.swap });
    const sdkSell = [S.setComputeUnitLimit(S.CU.swap), ...S.buildSell({ trader: trader.address, coin, amountIn: 1_000_000n, minOut: 1n })];
    assert.deepEqual(sell.map(plain), sdkSell.map(plain), 'sell instructions');
    // the small instructions one by one
    assert.deepEqual(plain(WI.setComputeUnitPrice(1234n)), plain(S.setComputeUnitPrice(1234n)));
    assert.deepEqual(plain(WI.systemTransfer(trader.address, coin.address, 7n)), plain(S.systemTransfer(trader.address, coin.address, 7n)));
    assert.deepEqual((await WI.wrapSol(trader.address, 5n)).map(plain), S.wrapSol(trader.address, 5n).map(plain));
    assert.deepEqual(plain(await WI.unwrapSol(trader.address)), plain(S.unwrapSol(trader.address)));
    assert.deepEqual(plain(await WI.createAtaIdempotent({ payer: trader.address, owner: trader.address, mint: coin.mint })), plain(S.createAta(trader.address, trader.address, coin.mint)));
    const sw = await WI.swap2({ trader: trader.address, pool: coin.dbcPool, config: coin.dbcConfig, baseMint: coin.mint, quoteMint: WSOL, side: 'buy', mode: 2, amount0: 5n, amount1: 6n });
    assert.deepEqual(plain(sw), plain(S.client.swap({ trader: trader.address, pool: coin.dbcPool, config: coin.dbcConfig, baseMint: coin.mint, quoteMint: WSOL, side: 'buy', mode: 2, amount0: 5n, amount1: 6n })), 'swap2 without a referral = program id');
  });

  it('TW03 compiled messages equal web3.js byte for byte', async () => {
    const { pool, config } = market();
    const q = WQ.quoteBuy(pool, config, { amountIn: LAMPORTS, slippageBps: 50 });
    const ixs = await tradeInstructions({ side: 'buy', taker: trader.address, coin, amountRaw: LAMPORTS, minOut: q.minOut });
    const legacy = WM.compileLegacy({ payer: trader.address, instructions: ixs, blockhash: BLOCKHASH });
    assert.equal(hex(legacy), hex(web3Legacy(trader.address, ixs, BLOCKHASH)), 'legacy');
    const v0 = WM.compileV0({ payer: trader.address, instructions: ixs, blockhash: BLOCKHASH, lookupTables: [{ key: record.lookupTable.key, addresses: lutAddrs }] });
    assert.equal(hex(v0), hex(web3V0(trader.address, ixs, BLOCKHASH, [lut])), 'v0 with the Vicinity table');
    assert.ok(v0.length < legacy.length, `the table shrinks the message (${v0.length} < ${legacy.length})`);
    const v0none = WM.compileV0({ payer: trader.address, instructions: ixs, blockhash: BLOCKHASH });
    assert.equal(hex(v0none), hex(web3V0(trader.address, ixs, BLOCKHASH, [])), 'v0 without a table');
    // two tables; the second holds the trader (a signer), the DBC program (invoked) and the pool: only the pool may come from it
    const t2addrs = [trader.address, PROGRAM_IDS.dbc, coin.dbcPool, coin.mint];
    const t2 = S.lookupTableFrom('8VPvq3jZ8KUE7xQyeRo2fGTM6Yg9q1hAaKJHRxEzQWzN', t2addrs);
    const both = WM.compileV0({ payer: trader.address, instructions: ixs, blockhash: BLOCKHASH, lookupTables: [{ key: record.lookupTable.key, addresses: lutAddrs }, { key: '8VPvq3jZ8KUE7xQyeRo2fGTM6Yg9q1hAaKJHRxEzQWzN', addresses: t2addrs }] });
    assert.equal(hex(both), hex(web3V0(trader.address, ixs, BLOCKHASH, [lut, t2])), 'two tables');
    const dec = WM.decodeHeader(WM.wrapUnsigned(both));
    assert.equal(dec.version, 0);
    assert.equal(dec.header.numRequiredSignatures, 1);
    assert.ok(dec.staticKeys.includes(trader.address) && dec.staticKeys.includes(PROGRAM_IDS.dbc), 'signer and program stay static');
    assert.ok(!dec.staticKeys.includes(coin.dbcPool) && !dec.staticKeys.includes(coin.mint), 'pool and mint come from the second table');
    assert.deepEqual(dec.lookups.map((l) => l.key), [record.lookupTable.key, '8VPvq3jZ8KUE7xQyeRo2fGTM6Yg9q1hAaKJHRxEzQWzN']);
    assert.equal(dec.blockhash, BLOCKHASH);
    assert.equal(dec.instructions.length, ixs.length);
    assert.equal(WM.programOfInstruction(dec, dec.instructions.length - 2), PROGRAM_IDS.dbc, 'the swap is the second to last instruction (unwrap follows)');
    const legDec = WM.decodeHeader(WM.wrapUnsigned(legacy));
    assert.equal(legDec.version, 'legacy');
    assert.deepEqual(legDec.lookups, []);
    // the relay's refusals
    assert.throws(() => WM.decodeHeader(WM.wrapUnsigned(legacy).subarray(0, 40)), /truncated/);
    assert.throws(() => WM.decodeHeader(WB.concat([WM.wrapUnsigned(legacy), Uint8Array.of(1)])), /trailing_bytes/);
    // a web3.js-signed transaction decodes with its signature slot filled (a fresh payer whose key web3.js can sign with)
    const kp = web3.Keypair.generate();
    const kpIxs = await tradeInstructions({ side: 'buy', taker: kp.publicKey.toBase58(), coin, amountRaw: LAMPORTS, minOut: q.minOut });
    const vt = new web3.VersionedTransaction(web3.VersionedMessage.deserialize(WM.compileV0({ payer: kp.publicKey.toBase58(), instructions: kpIxs, blockhash: BLOCKHASH })));
    vt.sign([kp]);
    const d2 = WM.decodeHeader(vt.serialize());
    assert.deepEqual([d2.numSignatures, d2.signaturesFilled[0], d2.version, d2.staticKeys[0]], [1, true, 0, kp.publicKey.toBase58()]);
    assert.deepEqual([...WM.wrapUnsigned(WM.compileV0({ payer: kp.publicKey.toBase58(), instructions: kpIxs, blockhash: BLOCKHASH })).subarray(65)], [...vt.serialize().subarray(65)], 'same message after the signature slot');
    // compact-u16 edge cases
    for (const n of [0, 1, 127, 128, 255, 256, 16383, 16384, 65535]) {
      const b = WB.compactU16(n);
      assert.equal(WB.readCompactU16(b, 0).value, n);
      assert.equal(b.length, n < 128 ? 1 : n < 16384 ? 2 : 3);
    }
  });

  it(`TW04 ${STEPS} random trades: Worker quotes = SDK quotes = litesvm, and the Worker-built transactions execute`, async () => {
    const next = rng(SEED);
    const traderCoinAta = sdkAta(trader.address, coin.mint), traderWsol = sdkAta(trader.address, WSOL);
    let buys = 0, sells = 0, partial = 0;
    for (let i = 0; i < STEPS; i++) {
      const { pool, config } = market();
      const sm = sdkMarket();
      if (pool.quoteReserve >= config.migrationQuoteThreshold) break;
      const held = w.balance(traderCoinAta);
      const side = held > 0n && next() % 3n === 0n && i < STEPS - 3 ? 'sell' : 'buy';
      const slippage = Number(next() % 300n) + 1;
      let amountRaw;
      if (side === 'buy') {
        const left = config.migrationQuoteThreshold - pool.quoteReserve;
        const pick = next() % 10n;
        // mostly small buys (0.001 to 0.5 SOL), some medium ones (up to a 40th of what is left); near the end one that overshoots the curve: a partial fill
        amountRaw = i >= STEPS - 3 ? left + LAMPORTS : pick < 7n ? 1_000_000n + (next() % 500_000_000n) : (next() % (left / 40n + 1n)) + 10_000_000n;
      } else amountRaw = (next() % held) + 1n;
      let mine, sdk;
      try {
        mine = side === 'buy' ? WQ.quoteBuy(pool, config, { amountIn: amountRaw, slippageBps: slippage }) : WQ.quoteSell(pool, config, { amountIn: amountRaw, slippageBps: slippage });
        sdk = side === 'buy' ? S.quoteBuy(sm.pool, sm.config, { amountIn: amountRaw, slippageBps: slippage }) : S.quoteSell(sm.pool, sm.config, { amountIn: amountRaw, slippageBps: slippage });
      } catch (e) {
        if (e instanceof WQ.CurveError || e instanceof S.CurveError) { assert.throws(() => (side === 'buy' ? S.quoteBuy(sm.pool, sm.config, { amountIn: amountRaw, slippageBps: slippage }) : S.quoteSell(sm.pool, sm.config, { amountIn: amountRaw, slippageBps: slippage }))); continue; }
        throw e;
      }
      for (const k of ['side', 'mode', 'amountIn', 'amountOut', 'amount0', 'amount1', 'minOut', 'refund', 'completesCurve', 'sqrtPriceBefore', 'sqrtPriceAfter', 'priceImpactBps']) assert.equal(mine[k], sdk[k], `step ${i} ${side} ${k}`);
      assert.deepEqual(mine.fees, sdk.fees, `step ${i} fees`);
      const cq = curveQuote({ side, pool, config, amountRaw, slippageBps: slippage, quoteDecimals: 9, coin, chain: 'solana:devnet' });
      assert.equal(cq.outAmount, String(sdk.amountOut));
      assert.equal(cq.minOut, String(sdk.minOut));
      // build, compile, sign, run
      const ixs = await tradeInstructions({ side, taker: trader.address, coin, amountRaw, minOut: mine.minOut });
      const message = WM.compileLegacy({ payer: trader.address, instructions: ixs, blockhash: bh() });
      assert.ok(WM.wrapUnsigned(message).length <= WM.MAX_TX_BYTES);
      const poolBefore = asRpcAccount({ ...w.account(coin.dbcPool), data: Buffer.from(w.account(coin.dbcPool).data) });
      const coinBefore = w.balance(traderCoinAta), solBefore = w.lamportsOf(trader.address), hadCoinAta = w.exists(traderCoinAta), hadRef = w.exists(sdkAta(ADDRESSES.feeRecipient, WSOL));
      const res = await run(message, trader, `step ${i} ${side}`);
      const coinAfter = w.balance(traderCoinAta), solAfter = w.lamportsOf(trader.address);
      assert.equal(w.exists(traderWsol), false, 'no WSOL account left behind');
      const rent = (hadCoinAta ? 0n : w.svm.minimumBalanceForRentExemption(165n)) + (hadRef ? 0n : w.svm.minimumBalanceForRentExemption(165n));
      if (side === 'buy') {
        assert.equal(coinAfter - coinBefore, mine.amountOut, `step ${i} coins received`);
        assert.equal(solBefore - solAfter, mine.amountIn + 5_000n + rent, `step ${i} SOL spent = quoted in (refund kept) + fee + rent`);
        buys++; if (mine.mode === 1 && mine.refund > 0n) partial++;
      } else {
        assert.equal(coinBefore - coinAfter, amountRaw, `step ${i} coins sold`);
        assert.equal(solAfter - solBefore, mine.amountOut - 5_000n - rent, `step ${i} SOL received`);
        sells++;
      }
      // the pool after equals the quote's prediction
      const after = market().pool;
      assert.equal(after.sqrtPrice, mine.sqrtPriceAfter, `step ${i} sqrt price after`);
      assert.equal(after.quoteReserve, mine.poolAfter.quoteReserve, `step ${i} quote reserve after`);
      if (i < 6 || mine.mode === 1) record.trades.push({ side, amountRaw: String(amountRaw), slippageBps: slippage, taker: trader.address, blockhash: BLOCKHASH, pool: poolBefore, expected: { amountOut: String(mine.amountOut), minOut: String(mine.minOut), mode: mine.mode, refund: String(mine.refund), fees: Object.fromEntries(Object.entries(mine.fees).map(([k, v]) => [k, String(v)])), legacyHex: hex(WM.compileLegacy({ payer: trader.address, instructions: ixs, blockhash: BLOCKHASH })), v0Hex: hex(WM.compileV0({ payer: trader.address, instructions: ixs, blockhash: BLOCKHASH, lookupTables: [{ key: record.lookupTable.key, addresses: lutAddrs }] })) } });
      if (res) void res;
    }
    console.log(`TW04 ${buys} buys (${partial} partial fills), ${sells} sells; curve complete: ${market().pool.quoteReserve >= market().config.migrationQuoteThreshold}`);
    assert.ok(buys > 20 && sells > 5, 'enough of both');
    assert.ok(partial >= 1, 'the last buy of the curve was a partial fill with a refund');
  });

  it('TW05 the dev wallet closed its referral account: the Worker-built trade recreates it', async () => {
    const w2 = await World.create();
    const founder = await w2.signer(200n);
    const c2 = await w2.launchCoin({ cityId: 150002n, founder, name: 'Ref City', symbol: 'REF' });
    const t = await w2.signer(100n);
    const ref = sdkAta(ADDRESSES.feeRecipient, WSOL);
    assert.equal(w2.exists(ref), false, 'no referral account yet');
    const pool = WD.decodePool(asRpcAccount(w2.account(c2.dbcPool))), config = WD.decodeConfig(asRpcAccount(w2.account(c2.dbcConfig)));
    const q = WQ.quoteBuy(pool, config, { amountIn: LAMPORTS, slippageBps: 100 });
    const ixs = await tradeInstructions({ side: 'buy', taker: t.address, coin: c2, amountRaw: LAMPORTS, minOut: q.minOut });
    const msg = WM.compileLegacy({ payer: t.address, instructions: ixs, blockhash: w2.svm.latestBlockhash() });
    const sig = await signBytes(t.keyPair.privateKey, msg);
    const res = w2.svm.sendTransaction({ messageBytes: msg, signatures: { [t.address]: sig } });
    assert.equal(typeof res.err, 'undefined', 'the trade went through although the referral account was missing');
    assert.equal(w2.exists(ref), true, 'the referral account exists now');
    assert.equal(w2.balance(ref), q.fees.referral, 'and holds exactly the referral share');
    assert.equal(w2.balance(sdkAta(t.address, c2.mint)), q.amountOut);
  });

  it('TW06 fixtures for the root suite (RECORD=1)', () => {
    assert.ok(record.trades.length >= 6);
    if (process.env.RECORD === '1') {
      const dir = join(root, 'test', 'fixtures', 'launchpad-worker');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'world.json'), JSON.stringify({ ...record, coin: { address: coin.address, cityId: String(coin.cityId), mint: coin.mint, quoteMint: coin.quoteMint, dbcConfig: coin.dbcConfig, dbcPool: coin.dbcPool } }, null, 1));
      console.log(`TW06 wrote ${record.trades.length} trades to test/fixtures/launchpad-worker/world.json`);
    }
  });
});
