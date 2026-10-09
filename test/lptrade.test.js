// Curve trades built by the Worker (LAUNCHPAD_TRADING=on, src/lptrade.js and src/sol/*), without web3.js:
//   * the golden fixtures solana/tests-launchpad/15-worker-builder.test.mjs recorded from litesvm (RECORD=1) replay exactly:
//     the same quotes, the same legacy and version-0 message bytes;
//   * the devnet accounts recorded on 9 Oct 2026 (DEMOV's pool, the SOL config, its Coin record, the global account, the
//     lookup table, the dev wallet's referral account) decode to the values LAUNCHPAD-DEVNET.md lists, and every PDA derives;
//   * the routes /api/launchpad/trade/quote and /tx against a FAKE launchpad RPC answering those accounts: the switch, the
//     cluster settings (mainnet without a program id is off), validation, the stage (curve / full / graduated), the
//     registry (a row whose Coin record names another mint is never traded), simulation errors in plain words, legacy / v0,
//     the attempt limits, and /api/swap/quote handing a curve coin over to these routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleApi } from "../src/index.js";
import { _resetLpTrade, curveQuote, launchpadMisconfigured, tradeInstructions } from "../src/lptrade.js";
import { OFFICIAL } from "../src/official.js";
import { _resetSwap } from "../src/swap.js";
import { decodeCoin, decodeConfig, decodeLaunchpad, decodeLookupTable, decodePool, decodeTokenAccount } from "../src/sol/dbc.js";
import { LAYOUT } from "../src/sol/layout.js";
import { ADDRESSES, PROGRAM_IDS, ata, dbc, launchpad } from "../src/sol/pda.js";
import { compileLegacy, compileV0, decodeHeader } from "../src/sol/message.js";
import { fromBase64, hex, toBase64, u64le } from "../src/sol/bytes.js";
import { feeBpsOf } from "../src/sol/quote.js";
import { launchpadCluster } from "../src/cluster.js";
import { newWorld, POOL } from "./helpers/world.js";
import { seedCoin } from "./helpers/launchpad.js";
import { REAL_VIC, SOL, USDC, fakeWorld } from "./helpers/jupfake.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/launchpad-worker/world.json", import.meta.url), "utf8"));
const dev = JSON.parse(readFileSync(new URL("./fixtures/launchpad-worker/devnet-accounts.json", import.meta.url), "utf8"));
const DEMOV = "EAXzD7eEJuFr8kfmqrrPBVuUNsd53PWHfsHuYFD8nPby", DEMOV_POOL = "GCr3j1bQXJapUQFjxmnVCoPc7ciE1L2UxvKKRwtHpinA", SOL_CONFIG = "4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7";
const DEMOV_COIN = "DcCDswmYyzh4ZXkXHLenxGGcjq1WGSXpEgiuPc4pwZCw", GLOBAL = "ppX3a7oUKmZg2aAmxct8LnKdxNAcoGFDowcyzvbTsbw", TABLE = "5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe", REF = "FGdoiYmovw4J7sAy8a657kWH2QUSBLxup59kkfUeMHa";
const TRADER = "AAMTJL8EUMJq8noHmgaahN57hXio5iMZCjZa3dPew1Th";
const ORIGIN = "https://vicinity.test";
const rpcAcc = (a) => ({ owner: a.owner, lamports: a.lamports, data: [a.data, "base64"] });
const devAccounts = () => Object.fromEntries(Object.entries(dev.accounts).map(([k, a]) => [k, rpcAcc(a)]));

test("lptrade: the litesvm fixtures replay exactly (quotes to the raw unit, legacy and v0 message bytes)", async () => {
  const config = decodeConfig(fx.accounts.config);
  assert.ok(config && config.feeClaimer === ADDRESSES.feeRecipient);
  const coin = decodeCoin(fx.accounts.coin, fx.programId);
  assert.deepEqual([coin.mint, coin.dbcPool, coin.dbcConfig], [fx.coin.mint, fx.coin.dbcPool, fx.coin.dbcConfig]);
  assert.ok(fx.trades.length >= 6);
  let partial = 0;
  for (const t of fx.trades) {
    const pool = decodePool(t.pool);
    const q = curveQuote({ side: t.side, pool, config, amountRaw: BigInt(t.amountRaw), slippageBps: t.slippageBps, quoteDecimals: 9, coin, chain: "solana:devnet" });
    assert.deepEqual([q.outAmount, q.minOut, q.mode, q.refund], [t.expected.amountOut, t.expected.minOut, t.expected.mode, t.expected.refund], `${t.side} ${t.amountRaw}`);
    assert.deepEqual({ total: q.fees.feeRaw, ...q.fees.split }, { total: t.expected.fees.total, meteora: t.expected.fees.meteora, referral: t.expected.fees.referral, devWallet: t.expected.fees.devWallet, city: t.expected.fees.city, holders: t.expected.fees.holders, founder: t.expected.fees.founder });
    if (t.expected.mode === 1) partial++;
    const ixs = await tradeInstructions({ side: t.side, taker: t.taker, coin, amountRaw: BigInt(t.amountRaw), minOut: BigInt(t.expected.minOut) });
    assert.equal(hex(compileLegacy({ payer: t.taker, instructions: ixs, blockhash: t.blockhash })), t.expected.legacyHex, "legacy bytes");
    assert.equal(hex(compileV0({ payer: t.taker, instructions: ixs, blockhash: t.blockhash, lookupTables: [fx.lookupTable] })), t.expected.v0Hex, "v0 bytes");
  }
  assert.ok(partial >= 1, "the recorded last buy of the curve is a partial fill");
  assert.equal(feeBpsOf(config), 125);
});

test("lptrade: the recorded devnet accounts decode to what LAUNCHPAD-DEVNET.md lists, and every address derives", async () => {
  const A = devAccounts();
  const pool = decodePool(A[DEMOV_POOL]), config = decodeConfig(A[SOL_CONFIG]), coin = decodeCoin(A[DEMOV_COIN], PROGRAM_IDS.launchpadDevnet), lp = decodeLaunchpad(A[GLOBAL], PROGRAM_IDS.launchpadDevnet);
  assert.deepEqual([pool.config, pool.baseMint, pool.isMigrated, pool.migrationProgress], [SOL_CONFIG, DEMOV, 0, 0]);
  assert.ok(pool.quoteReserve > 0n && pool.quoteReserve < config.migrationQuoteThreshold, "DEMOV is still on its curve");
  assert.deepEqual([config.quoteMint, config.feeClaimer, config.leftoverReceiver, config.migrationQuoteThreshold, config.poolCreationFee, Number(config.creatorTradingFeePercentage), config.tokenDecimal, feeBpsOf(config)], [SOL, ADDRESSES.feeRecipient, ADDRESSES.feeRecipient, 1_000_000_000n, 10_000_000n, 50, 6, 125]);
  assert.deepEqual([String(coin.cityId), coin.mint, coin.quoteMint, coin.dbcConfig, coin.dbcPool, coin.founder], ["999000003", DEMOV, SOL, SOL_CONFIG, DEMOV_POOL, "91WeAyurya1sKGLmLoAbCyD7o5cRhh5UGm24xKvxwGgr"]);
  assert.deepEqual([lp.admin, lp.launchesPaused, lp.payoutsPaused, lp.rewardsProgram], ["9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa", false, false, "Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi"]);
  const table = decodeLookupTable(A[TABLE]);
  assert.equal(table.addresses.length, 25);
  assert.ok(table.addresses.includes(SOL_CONFIG) && table.addresses.includes(GLOBAL) && table.addresses.includes(REF) && table.addresses.includes(ADDRESSES.feeRecipient));
  const ref = decodeTokenAccount(A[REF]);
  assert.deepEqual([ref.owner, ref.mint], [ADDRESSES.feeRecipient, SOL]);
  const P = launchpad(PROGRAM_IDS.launchpadDevnet);
  assert.equal(await P.coin(999000003n), DEMOV_COIN);
  assert.equal(await P.launchpad(), GLOBAL);
  assert.equal(await dbc.pool(SOL_CONFIG, DEMOV, SOL), DEMOV_POOL);
  assert.equal(await ata(ADDRESSES.feeRecipient, SOL), REF);
  assert.equal(decodeCoin(A[DEMOV_COIN], "Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi"), null, "another program's record is not ours");
  assert.deepEqual(launchpadCluster({}).missing, []);
  assert.deepEqual(launchpadCluster({ LAUNCHPAD_CLUSTER: "mainnet" }).missing, ["LAUNCHPAD_PROGRAM_ID", "LAUNCHPAD_DBC_CONFIGS"], "mainnet has no defaults");
});

/** A world with LAUNCHPAD_TRADING on devnet, DEMOV recorded as a city coin, and the fake devnet RPC answering the recorded accounts. */
async function tradeWorld(extraEnv = {}, { mutatePool = null, coinMint = DEMOV } = {}) {
  _resetLpTrade(); _resetSwap();
  const W = fakeWorld({ rpc: { mints: { [REAL_VIC]: { decimals: 6 } }, lamports: { [TRADER]: 1_000_000_000 } } });
  Object.assign(W.rpc.accounts, devAccounts());
  if (mutatePool) { const b = fromBase64(dev.accounts[DEMOV_POOL].data); mutatePool(b); W.rpc.accounts[DEMOV_POOL] = { ...W.rpc.accounts[DEMOV_POOL], data: [toBase64(b), "base64"] }; }
  W.rpc.sim = () => ({ err: null, logs: [], unitsConsumed: 69_728 });
  const env = { ...newWorld(), LAUNCHPAD_TRADING: "on", LAUNCHPAD_CLUSTER: "devnet", VICINITY_MINT: REAL_VIC, SOLANA_RPC_URL: "https://rpc.test", ...extraEnv };
  await seedCoin(env.DB, { city: 999000003, name: "Demo Village", coin: "Demo Village", pair: "SOL", mint: coinMint, user: 0 });
  const call = async (path, body, { ip = "1.2.3.4", origin = ORIGIN } = {}) => {
    const headers = new Headers({ "cf-connecting-ip": ip, "content-type": "application/json" });
    if (origin) headers.set("origin", origin);
    const res = await handleApi(new Request(ORIGIN + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, W.fetch);
    return { status: res.status, data: await res.json(), headers: res.headers };
  };
  return { W, env, call };
}
const buy = (over = {}) => ({ mint: DEMOV, side: "buy", amount: "0.005", slippageBps: 100, ...over });

test("lptrade: the switch and the cluster settings: off is 404; mainnet without a program id is off (and /api/official says nothing)", async () => {
  const off = await tradeWorld({ LAUNCHPAD_TRADING: "off" });
  assert.deepEqual((await off.call("/api/launchpad/trade/quote", buy())).data, { ok: false, error: "not_enabled" });
  assert.equal((await off.call("/api/official")).data.launchpadTrading, undefined);
  const main = await tradeWorld({ LAUNCHPAD_CLUSTER: "mainnet" });
  assert.deepEqual((await main.call("/api/launchpad/trade/quote", buy())).data, { ok: false, error: "not_enabled" });
  assert.equal((await main.call("/api/official")).data.launchpadTrading, undefined);
  const on = await tradeWorld();
  assert.deepEqual((await on.call("/api/official")).data.launchpadTrading, { cluster: "devnet" });
  assert.deepEqual((await on.call("/api/launchpad/trade/quote", buy(), { origin: null })).data, { ok: false, error: "bad_origin" });
  assert.equal((await on.call("/api/launchpad/trade/quote")).data.error, "method_not_allowed");
  // the relay routes open with this switch alone (a devnet trade needs send / status / balances)
  assert.equal((await on.call("/api/swap/status?sig=zzz")).data.error, "bad_signature");
  assert.equal((await on.call("/api/swap/quote", buy())).data.error, "not_enabled", "but not the Jupiter routes");
});

test("lptrade: quote and tx of a DEMOV buy and sell against the recorded devnet state", async () => {
  const { W, call } = await tradeWorld();
  const q = await call("/api/launchpad/trade/quote", buy());
  assert.equal(q.status, 200, JSON.stringify(q.data));
  assert.deepEqual([q.data.source, q.data.side, q.data.inputMint, q.data.outputMint, q.data.inAmount, q.data.inUi, q.data.outAmount, q.data.minOut, q.data.outUi, q.data.chain, q.data.cluster, q.data.poweredBy, q.data.partialFill],
    ["curve", "buy", SOL, DEMOV, "5000000", "0.005", "13286006275533", "13153146212777", "13286006.275533", "solana:devnet", "devnet", "Meteora DBC", false]);
  assert.deepEqual(q.data.fees.split, { meteora: "10000", referral: "2500", devWallet: "25000", city: "25000", holders: "12500", founder: "12500" });
  assert.deepEqual([q.data.fees.curveFeeBps, q.data.priceImpactPct, q.data.route, q.data.coin.cityId, q.data.coin.city.cityName, q.data.coin.curve.target], [125, "1.32", ["Meteora bonding curve"], "999000003", "Demo Village", "1000000000"]);
  assert.equal(q.headers.get("Cache-Control"), "no-store");
  assert.ok(q.data.quoteId.length === 22 && Date.parse(q.data.expiresAt) > Date.now());
  const s = await call("/api/launchpad/trade/quote", buy({ side: "sell", amount: "13286006.275533", slippageBps: 300 }));
  assert.deepEqual([s.status, s.data.side, s.data.inputMint, s.data.outputMint, s.data.inAmount, s.data.outUi], [200, "sell", DEMOV, SOL, "13286006275533", "0.004749928"]);
  // the transaction: version 0 with the devnet lookup table, the taker pays, unsigned, simulated
  const tx = await call("/api/launchpad/trade/tx", buy({ taker: TRADER }));
  assert.equal(tx.status, 200, JSON.stringify(tx.data));
  const d = decodeHeader(fromBase64(tx.data.tx));
  assert.deepEqual([tx.data.version, tx.data.chain, tx.data.cluster, d.version, d.numSignatures, d.signaturesFilled[0], d.staticKeys[0], d.lookups.map((l) => l.key)], [0, "solana:devnet", "devnet", 0, 1, false, TRADER, [TABLE]]);
  assert.ok(tx.data.bytes < 700 && tx.data.bytes === fromBase64(tx.data.tx).length);
  assert.equal(tx.data.fees.computeUnitLimit, 83_674, "1.2 x the simulated 69,728 units");
  assert.deepEqual([tx.data.fees.priorityLamports, tx.data.fees.networkLamports, tx.data.fees.rentLamports], [0, 5000, 2_039_280]);
  assert.equal(tx.data.quote.outAmount, q.data.outAmount);
  assert.ok(d.instructions.some((i) => d.staticKeys[i.programIdIndex] === PROGRAM_IDS.dbc), "the DBC swap is in it");
  assert.ok(W.rpc.log.some((l) => l.url.startsWith("https://api.devnet.solana.com")), "the launchpad cluster's RPC was asked");
  assert.ok(!W.rpc.log.some((l) => l.url.startsWith("https://rpc.test")), "never the site's mainnet RPC for a devnet trade");
  const leg = await call("/api/launchpad/trade/tx", buy({ taker: TRADER, v: "legacy", amount: "0.006" }));
  assert.deepEqual([leg.status, leg.data.version, decodeHeader(fromBase64(leg.data.tx)).version], [200, "legacy", "legacy"]);
  assert.ok(leg.data.bytes > tx.data.bytes, "the table shrinks the message");
  const sell = await call("/api/launchpad/trade/tx", buy({ taker: TRADER, side: "sell", amount: "1000" }));
  assert.equal(sell.status, 200, JSON.stringify(sell.data));
  assert.equal(sell.data.quote.side, "sell");
});

test("lptrade: validation, the stage and the registry refuse in plain codes", async () => {
  const { call } = await tradeWorld();
  const bad = async (body, code, status = 400) => { const r = await call("/api/launchpad/trade/quote", body); assert.deepEqual([r.status, r.data.error], [status, code], JSON.stringify(r.data)); };
  await bad(buy({ side: "hold" }), "bad_side");
  await bad(buy({ mint: "x" }), "bad_mint");
  await bad(buy({ amount: "abc" }), "bad_amount");
  await bad(buy({ amount: "0.0000000001" }), "amount_too_small");
  await bad(buy({ slippageBps: 0 }), "bad_slippage");
  await bad(buy({ taker: POOL }), "bad_wallet");
  await bad(buy({ mint: REAL_VIC }), "curve_not_found", 404);
  await bad(buy({ amount: "0.000000001" }), "amount_too_small");
  const tx = await call("/api/launchpad/trade/tx", buy());
  assert.deepEqual([tx.status, tx.data.error], [400, "bad_wallet"], "a transaction needs the taker");
  // a city_coins row whose Coin record names another mint: never traded here
  const other = await tradeWorld({}, { coinMint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" });
  const r = await other.call("/api/launchpad/trade/quote", buy({ mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" }));
  assert.deepEqual([r.status, r.data.error], [404, "curve_not_found"]);
  // graduated and full curves
  const grad = await tradeWorld({}, { mutatePool: (b) => { b[LAYOUT.VirtualPool.fields.is_migrated.at] = 1; } });
  const g = await grad.call("/api/launchpad/trade/quote", buy());
  assert.deepEqual([g.status, g.data.error], [409, "stage_graduated"]);
  const full = await tradeWorld({}, { mutatePool: (b) => { b.set(u64le(1_000_000_000n), LAYOUT.VirtualPool.fields.quote_reserve.at); } });
  const f = await full.call("/api/launchpad/trade/quote", buy());
  assert.deepEqual([f.status, f.data.error], [409, "curve_full"]);
});

test("lptrade: the simulation stops a trade that would fail: slippage (DBC 6002), not enough SOL; the RPC down is rpc_unavailable", async () => {
  const { W, call } = await tradeWorld();
  W.rpc.sim = (txB64) => { const d = decodeHeader(fromBase64(txB64)); const i = d.instructions.findIndex((x) => d.staticKeys[x.programIdIndex] === PROGRAM_IDS.dbc); return { err: { InstructionError: [i, { Custom: 6002 }] }, logs: ["Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN failed: custom program error: 0x1772"] }; };
  let r = await call("/api/launchpad/trade/tx", buy({ taker: TRADER }));
  assert.deepEqual([r.status, r.data.error, r.data.name, r.data.program], [409, "slippage", "ExceededSlippage", PROGRAM_IDS.dbc]);
  W.rpc.sim = () => ({ err: { InstructionError: [3, { Custom: 1 }] }, logs: ["Transfer: insufficient lamports 0, need 5000000"] });
  r = await call("/api/launchpad/trade/tx", buy({ taker: TRADER, amount: "0.0051" }));
  assert.deepEqual([r.status, r.data.error], [409, "insufficient_sol"]);
  W.rpc.sim = (txB64) => { const d = decodeHeader(fromBase64(txB64)); const i = d.instructions.findIndex((x) => d.staticKeys[x.programIdIndex] === PROGRAM_IDS.dbc); return { err: { InstructionError: [i, { Custom: 6013 }] }, logs: [] }; };
  r = await call("/api/launchpad/trade/tx", buy({ taker: TRADER, amount: "0.0052" }));
  assert.deepEqual([r.data.error, r.data.name], ["program_error", "PoolIsCompleted"]);
  W.rpc.sim = () => { throw { code: -32005, message: "down" }; };
  r = await call("/api/launchpad/trade/tx", buy({ taker: TRADER, amount: "0.0053" }));
  assert.deepEqual([r.status, r.data.error], [503, "rpc_unavailable"]);
});

test("lptrade: /api/swap/quote hands a curve coin over to these routes, refuses a pair against anything but the coin's quote token", async () => {
  const { call } = await tradeWorld({ SWAP: "on" });
  const q = await call("/api/swap/quote", { inputMint: SOL, outputMint: DEMOV, amount: "0.005", slippageBps: 100 });
  assert.deepEqual([q.status, q.data.source, q.data.useRoute, q.data.side, q.data.mint, q.data.chain], [200, "curve", "/api/launchpad/trade", "buy", DEMOV, "solana:devnet"]);
  const s = await call("/api/swap/quote", { inputMint: DEMOV, outputMint: SOL, amount: "100", slippageBps: 100 });
  assert.deepEqual([s.data.source, s.data.side], ["curve", "sell"]);
  const u = await call("/api/swap/quote", { inputMint: USDC, outputMint: DEMOV, amount: "5", slippageBps: 100 });
  assert.deepEqual([u.status, u.data.error, u.data.quoteMint], [409, "curve_quote_only", SOL]);
  const t = await call("/api/swap/tx", { inputMint: SOL, outputMint: DEMOV, amount: "0.005", slippageBps: 100, taker: TRADER });
  assert.deepEqual([t.data.source, t.data.useRoute], ["curve", "/api/launchpad/trade"]);
  const cfg = await call("/api/swap/config");
  assert.equal(cfg.data.tokens.find((x) => x.mint === DEMOV).stage, "curve");
  assert.deepEqual([cfg.data.launchpad.enabled, cfg.data.launchpad.cluster, cfg.data.launchpad.programId], [true, "devnet", PROGRAM_IDS.launchpadDevnet]);
});

test("lptrade: the 21st /tx from one connection answers 429 slow_down, and so does the 16th of one WALLET from many connections", async () => {
  const { call } = await tradeWorld();
  let last;
  for (let i = 0; i < 21; i++) last = await call("/api/launchpad/trade/tx", buy({ taker: TRADER, amount: String(0.005 + i / 10000) }), { ip: "9.9.9.9" });
  assert.deepEqual([last.status, last.data.error], [429, "slow_down"]);
  const other = "CnQMR167gRRXcPYrDZkwbW6moYKmxd7gZNGSN6BNzz6p";
  for (let i = 0; i < 16; i++) last = await call("/api/launchpad/trade/tx", buy({ taker: other, amount: (0.005 + i / 10000).toFixed(4) }), { ip: `10.1.0.${i + 1}` });
  assert.deepEqual([last.status, last.data.error], [429, "slow_down"], "one wallet cannot burn the launchpad RPC from many connections");
});

test("lptrade: the fee-recipient check no longer throws at import time: it is false today (CI catches a reorder), and the routes would answer 503 misconfigured", async () => {
  assert.equal(launchpadMisconfigured(), false, "the program constant, src/sol/pda.js and a published team wallet agree");
  assert.ok(OFFICIAL.teamWallets.includes(ADDRESSES.feeRecipient));
  const src = readFileSync(new URL("../src/lptrade.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^if \(.*throw new Error\("fee recipient mismatch/m, "no throw at module evaluation: a mismatch must never take every route of the site down");
  assert.match(src, /error: "misconfigured" \}, 503/);
});

test("lptrade: the quote says when the dev wallet's referral account is missing (that rent is the trader's and not returned); present = 0; the /tx answer carries a relay ticket and the build's own quote", async () => {
  const { W, call } = await tradeWorld();
  const q = await call("/api/launchpad/trade/quote", buy());
  assert.deepEqual([q.data.fees.referralRentLamports, q.data.fees.referralNote, q.data.fees.rentLamports], [0, null, 2_039_280], "the recorded devnet referral account exists");
  assert.match(q.data.fees.rentNote, /returned when you close that account/);
  // the dev wallet closed it (it unwrapped SOL): the next quote names the rent the trader will pay
  _resetLpTrade();
  delete W.rpc.accounts[REF];
  const q2 = await call("/api/launchpad/trade/quote", buy());
  assert.equal(q2.data.fees.referralRentLamports, 2_039_280);
  assert.match(q2.data.fees.referralNote, /^about 0\.002 SOL re-creates the platform's fee account for this coin's pair token and is not returned to you$/);
  const reads = () => W.rpc.log.filter((e) => e.methods.includes("getAccountInfo")).length;
  const n = reads();
  await call("/api/launchpad/trade/quote", buy({ amount: "0.006" }));
  assert.equal(reads(), n, "the referral fact is kept a minute: no second read");
  const tx = await call("/api/launchpad/trade/tx", buy({ taker: TRADER }));
  assert.equal(tx.status, 200, JSON.stringify(tx.data));
  assert.deepEqual([tx.data.fees.referralRentLamports, tx.data.fees.referralNote != null, tx.data.quote.fees.referralRentLamports], [2_039_280, true, 2_039_280]);
  assert.match(tx.data.ticket, /^\d{13}\.[A-Za-z0-9_-]{22}$/, "the relay ticket for a wallet that only signs");
  assert.equal(tx.data.quote.quoteId, tx.data.quoteId);
  assert.deepEqual([tx.data.quote.outAmount, tx.data.quote.minOut, tx.data.quote.priceImpactPct], [q.data.outAmount, q.data.minOut, q.data.priceImpactPct], "the quote of the very build");
  // the relay accepts it (devnet, because trading is on there) and refuses the same bytes without the ticket
  const signedTx = (() => { const b = fromBase64(tx.data.tx); b.fill(7, 1, 65); return toBase64(b); })();
  assert.equal((await call("/api/swap/send", { tx: signedTx, cluster: "devnet" })).data.error, "bad_ticket");
  const sent = await call("/api/swap/send", { tx: signedTx, ticket: tx.data.ticket, cluster: "devnet" });
  assert.deepEqual([sent.status, sent.data.cluster, /cluster=devnet$/.test(sent.data.solscan)], [200, "devnet", true], JSON.stringify(sent.data));
  assert.ok(W.rpc.log.filter((l) => l.methods.includes("sendTransaction")).every((l) => l.url.startsWith("https://api.devnet.solana.com")), "sent to the launchpad cluster's node");
});

test("lptrade: a built trade forgets the pool's 5 s copy, so the next quote reads the chain again (the person who just traded sees the true numbers)", async () => {
  const { W, call } = await tradeWorld();
  const reads = () => W.rpc.log.filter((e) => e.methods.includes("getAccountInfo")).length;
  assert.equal((await call("/api/launchpad/trade/quote", buy())).status, 200);
  const afterFirst = reads();
  assert.equal((await call("/api/launchpad/trade/quote", buy())).status, 200);
  assert.equal(reads(), afterFirst, "a second quote within 5 s is served from the copy (no read)");
  const tx = await call("/api/launchpad/trade/tx", buy({ taker: TRADER }));
  assert.equal(tx.status, 200, JSON.stringify(tx.data));
  // the pool graduates on the chain right after the trade was built: a quote that read the copy would still say "curve"
  const b = fromBase64(dev.accounts[DEMOV_POOL].data); b[LAYOUT.VirtualPool.fields.is_migrated.at] = 1;
  W.rpc.accounts[DEMOV_POOL] = { ...W.rpc.accounts[DEMOV_POOL], data: [toBase64(b), "base64"] };
  const afterTx = reads();
  const q = await call("/api/launchpad/trade/quote", buy());
  assert.deepEqual([q.status, q.data.error], [409, "stage_graduated"], "the quote after a built trade read the chain again");
  assert.equal(reads(), afterTx + 1, "exactly one read: the pool (the config, the table and the decimals keep their long copies)");
  assert.equal((await call("/api/launchpad/trade/quote", buy())).status, 409);
  assert.equal(reads(), afterTx + 1, "and the fresh copy serves the next 5 s again");
});
