// Pay with anything / sell into anything, composed from RECORDED Jupiter
// /swap/v2/build responses (sdk/launchpad/fixtures, mainnet, 6 Oct 2026,
// taker = the throwaway devnet deployer's public address). No network, nothing
// signed or sent. The same composition runs for real against DBC in process in
// tests-launchpad/12-client-sdk.test.mjs (TJ07, TJ08).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import web3 from '@solana/web3.js';
import { coderFor, IDL } from './idl.mjs';
import { ADDRESSES, PROGRAM_IDS, ata, dbc, pdas } from './pda.mjs';
import { composePayWithAnything, composeSellIntoAnything, checkJupiterBuild, decodeJupiterSwap, jupiterBuildUrl, planPayWithAnything, jupiterBlockhash, simulatedCuLimit, buildBuyAfterSwap, JUPITER_PROGRAM, DEFAULT_PAY_CU } from './jupiter.mts';
import type { JupiterBuild, JupiterApiInstruction } from './jupiter.mts';
import { launchpadLookupTableAddresses, lookupTableFrom } from './lookup-table.mts';
import { MAX_TX_BYTES, MAX_PRIORITY_FEE_LAMPORTS, COMPUTE_BUDGET_PROGRAM, referralAccount, toV0Transaction, setComputeUnitPrice } from './trade.mts';
import { VICINITY_MINT, payAsset, payAssetsFor, mayOffer, PAY_ASSETS, STOCK_ALLOWED_COUNTRIES } from './pay-assets.mts';
import { vicinityConfigParams } from './config.mjs';
import type { CurveLike, PoolLike } from './quote.mts';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string): JupiterBuild => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));
const TAKER = '9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa';
const WSOL = ADDRESSES.wsol;
// a hypothetical Vicinity coin (any valid addresses: nothing is sent)
const P = pdas();
function coinFor(quoteMint: string) {
  const mint = P.coin(777001n), dbcConfig = P.coin(777002n);
  return { mint, quoteMint, dbcConfig, dbcPool: dbc.pool(dbcConfig, mint, quoteMint), cityId: 777001n };
}
const vicinityLut = (cfg: string, quote = WSOL) => lookupTableFrom('7UbiauZFTRXXy8zGMNYsZDPGu1NsDJTNVp7xX7sBQd6c', launchpadLookupTableAddresses({ dbcConfigs: [cfg], quoteMints: [quote] }));
const swap2 = (data: Uint8Array) => coderFor(IDL.dbc).instruction.decode(Buffer.from(data)) as { name: string; data: { params: { amount_0: { toString(): string }; amount_1: { toString(): string }; swap_mode: number } } };
// the default Vicinity curve at its start (what a fresh coin's pool looks like)
const big = (x: { toString(): string }) => BigInt(x.toString());
function defaultCurve(): CurveLike {
  const p = vicinityConfigParams();
  const curve = p.curve.map((c: { sqrt_price: unknown; liquidity: unknown }) => ({ sqrtPrice: big(c.sqrt_price as bigint), liquidity: big(c.liquidity as bigint) }));
  return { curve, sqrtStartPrice: big(p.sqrt_start_price), migrationSqrtPrice: curve[0].sqrtPrice, migrationQuoteThreshold: big(p.migration_quote_threshold), feeNumerator: big(p.pool_fees.base_fee.cliff_fee_numerator), creatorTradingFeePercentage: 50n };
}
const CFG = defaultCurve();
const START: PoolLike & { isMigrated: number } = { sqrtPrice: CFG.sqrtStartPrice, quoteReserve: 0n, baseReserve: 10n ** 15n, isMigrated: 0 };
// instruction helpers for hostile answers
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const meta = (pubkey: string, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const STRANGER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const api = (programId: string, accounts: ReturnType<typeof meta>[], data: Buffer): JupiterApiInstruction => ({ programId, accounts, data: data.toString('base64') });
const clone = (b: JupiterBuild): JupiterBuild => JSON.parse(JSON.stringify(b));

test('cbBTC -> SOL -> coin: one transaction, the buy spends exactly Jupiter\'s guaranteed minimum', () => {
  const build = load('jupiter-build-cbBTC-to-SOL-max40.json');
  const coin = coinFor(WSOL);
  const plan = composePayWithAnything({ build, trader: TAKER, coin, minCoinsOut: 1_000n });
  assert.equal(plan.mode, 'one-transaction');
  const t = plan.transactions[0];
  assert.ok(t.bytes <= MAX_TX_BYTES, `${t.bytes} bytes`);
  // order: price, the dev wallet's referral account (idempotent), Jupiter setup, Jupiter swap, coin account, DBC buy, Jupiter cleanup
  const programs = t.instructions.map((i) => i.programAddress);
  assert.deepEqual(programs, ['ComputeBudget111111111111111111111111111111', PROGRAM_IDS.ata, PROGRAM_IDS.ata, JUPITER_PROGRAM, PROGRAM_IDS.ata, PROGRAM_IDS.dbc, PROGRAM_IDS.token]);
  assert.equal(t.instructions[1].accounts[1].address, referralAccount(WSOL), 'the referral account is (re)created first if missing');
  const buy = swap2(t.instructions[5].data);
  assert.equal(buy.name, 'swap2');
  assert.equal(buy.data.params.amount_0.toString(), build.otherAmountThreshold, 'amount in = the guaranteed minimum');
  assert.equal(buy.data.params.amount_1.toString(), '1000');
  assert.equal(buy.data.params.swap_mode, 1, 'partial fill: the last buy of a curve refunds instead of failing');
  assert.equal(plan.buyMode, 1);
  assert.equal(t.instructions[5].accounts[3].address, ata(TAKER, WSOL), 'the buy (input_token_account) reads the WSOL account Jupiter paid into');
  assert.equal(plan.buyAmountIn, BigInt(build.otherAmountThreshold));
  assert.equal(plan.expectedSurplus, BigInt(build.outAmount) - BigInt(build.otherAmountThreshold));
  assert.equal(plan.surplusKept, 'SOL', 'Jupiter\'s cleanup unwraps the surplus');
  // the compiled transaction: compute limit first, one signer (the buyer), Jupiter's tables used
  const msg = t.tx.message;
  assert.equal(msg.header.numRequiredSignatures, 1);
  assert.equal(msg.staticAccountKeys[0].toBase58(), TAKER);
  assert.ok(msg.addressTableLookups.length >= 1);
  assert.equal(msg.recentBlockhash, jupiterBlockhash(build).blockhash);
  assert.ok(t.tx.signatures.every((s) => s.every((b) => b === 0)), 'unsigned');
  // with the Vicinity lookup table it is smaller still
  const withLut = composePayWithAnything({ build, trader: TAKER, coin, minCoinsOut: 1_000n, lookupTables: [vicinityLut(coin.dbcConfig)] });
  assert.ok(withLut.transactions[0].bytes < t.bytes);
  console.log(`cbBTC -> SOL -> coin: ${t.bytes} bytes (${withLut.transactions[0].bytes} with the Vicinity lookup table), route ${plan.route}`);
});

test('VICINITY-priced coin: cbBTC -> VICINITY (route size 64) plus the buy; any surplus stays as VICINITY', () => {
  const build = load('jupiter-build-cbBTC-to-VICINITY-max64.json');
  const coin = coinFor(VICINITY_MINT);
  const plan = composePayWithAnything({ build, trader: TAKER, coin, minCoinsOut: 1n, lookupTables: [vicinityLut(coin.dbcConfig, VICINITY_MINT)] });
  for (const t of plan.transactions) assert.ok(t.bytes <= MAX_TX_BYTES, `${t.label} ${t.bytes}`);
  assert.equal(plan.surplusKept, 'quote token', 'no SOL unwrap for a VICINITY-priced coin');
  console.log(`cbBTC -> VICINITY -> coin: ${plan.mode} (${plan.transactions.map((t) => t.bytes).join(' + ')} bytes), route ${plan.route}`);
  // forcing the fallback gives two transactions: Jupiter as returned, then a plain buy of the minimum
  const two = composePayWithAnything({ build, trader: TAKER, coin, minCoinsOut: 1n, maxBytes: 800 });
  assert.equal(two.mode, 'two-transactions');
  assert.equal(two.transactions[0].instructions.filter((i) => i.programAddress === PROGRAM_IDS.dbc).length, 0);
  const buy = two.transactions[1].instructions.find((i) => i.programAddress === PROGRAM_IDS.dbc);
  assert.equal(swap2(buy!.data).data.params.amount_0.toString(), build.otherAmountThreshold);
});

test('sell into anything: coin -> SOL (sell) -> cbBTC (Jupiter, exactly the sell\'s minimum), surplus unwrapped', () => {
  const build = load('jupiter-build-SOL-to-cbBTC-max40-nowrap.json');
  const coin = coinFor(WSOL);
  const plan = composeSellIntoAnything({ build, trader: TAKER, coin, coinAmountIn: 5_000_000_000n, minQuoteOut: BigInt(build.inAmount), lookupTables: [vicinityLut(coin.dbcConfig)] });
  for (const t of plan.transactions) assert.ok(t.bytes <= MAX_TX_BYTES);
  const all = plan.transactions.flatMap((t) => t.instructions);
  const sell = all.find((i) => i.programAddress === PROGRAM_IDS.dbc)!;
  const d = swap2(sell.data).data.params;
  assert.deepEqual([d.amount_0.toString(), d.amount_1.toString()], ['5000000000', build.inAmount]);
  assert.equal(all[all.length - 1].programAddress, PROGRAM_IDS.token, 'ends by unwrapping any SOL above the minimum');
  assert.equal(plan.minAssetOut, BigInt(build.otherAmountThreshold));
  console.log(`coin -> SOL -> cbBTC: ${plan.mode} (${plan.transactions.map((t) => t.bytes).join(' + ')} bytes)`);
  // a response that wraps native SOL would spend the seller's SOL instead of the sell's WSOL
  const wrapping = { ...build, setupInstructions: [...build.setupInstructions, { programId: PROGRAM_IDS.system, accounts: [], data: '' }] };
  assert.throws(() => composeSellIntoAnything({ build: wrapping, trader: TAKER, coin, coinAmountIn: 1n, minQuoteOut: BigInt(build.inAmount) }), /wrapAndUnwrapSol=false/);
});

test('the swap instruction is read by position and its amounts match the answer', () => {
  for (const [f, kind, dst] of [['jupiter-build-cbBTC-to-SOL-max40.json', 'shared_accounts_route_v2', WSOL], ['jupiter-build-cbBTC-to-VICINITY-max64.json', 'route_v2', VICINITY_MINT], ['jupiter-build-SOL-to-cbBTC-max40-nowrap.json', 'shared_accounts_route_v2', payAsset('cbBTC').mint]] as const) {
    const b = load(f);
    const d = decodeJupiterSwap(b.swapInstruction);
    assert.equal(d.kind, kind, f);
    assert.equal(d.authority, TAKER);
    assert.equal(d.source, ata(TAKER, b.inputMint));
    assert.deepEqual(d.destinations, [ata(TAKER, dst)]);
    assert.deepEqual([d.sourceMint, d.destinationMint], [b.inputMint, b.outputMint]);
    assert.deepEqual([d.inAmount, d.quotedOutAmount, d.slippageBps, d.minOut], [BigInt(b.inAmount), BigInt(b.outAmount), b.slippageBps, BigInt(b.otherAmountThreshold)], f);
    assert.deepEqual([d.platformFeeBps, d.positiveSlippageBps], [0, 0]);
    assert.doesNotThrow(() => checkJupiterBuild(b, { trader: TAKER, inputMint: b.inputMint, outputMint: b.outputMint, inAmount: BigInt(b.inAmount) }), f);
  }
});

test('hostile Jupiter answers are refused (review LP-ACPI-1): drains, approvals, closes to strangers, redirected output, wrong amounts', () => {
  const good = load('jupiter-build-cbBTC-to-SOL-max40.json');
  const coin = coinFor(WSOL);
  const sell = load('jupiter-build-SOL-to-cbBTC-max40-nowrap.json');
  const wsolAta = ata(TAKER, WSOL);
  const swapData = Buffer.from(good.swapInstruction.data, 'base64');
  const withData = (b: JupiterBuild, f: (d: Buffer) => void) => { const c = clone(b); const d = Buffer.from(c.swapInstruction.data, 'base64'); f(d); c.swapInstruction.data = d.toString('base64'); return c; };
  const cases: [string, (b: JupiterBuild) => void, RegExp][] = [
    // R1a: a System transfer of the buyer's SOL to a stranger
    ['SOL to a stranger', (b) => b.setupInstructions.push(api(PROGRAM_IDS.system, [meta(TAKER, true, true), meta(STRANGER, false, true)], Buffer.concat([u32(2), u64(10_000_000_000n)]))), /SOL/],
    // ... even into the trader's own WSOL account when the buyer pays with cbBTC
    ['SOL wrap when not paying in SOL', (b) => b.setupInstructions.push(api(PROGRAM_IDS.system, [meta(TAKER, true, true), meta(wsolAta, false, true)], Buffer.concat([u32(2), u64(1n)]))), /not in SOL/],
    ['system create-account', (b) => b.setupInstructions.push(api(PROGRAM_IDS.system, [meta(TAKER, true, true), meta(STRANGER, true, true)], Buffer.concat([u32(0), u64(1n), u64(0n), Buffer.alloc(32)]))), /unexpected signer|other than a transfer/],
    // R1b: an unlimited approval of the buyer's input token to a stranger (plain and checked)
    ['approve', (b) => b.setupInstructions.push(api(PROGRAM_IDS.token, [meta(ata(TAKER, b.inputMint), false, true), meta(STRANGER), meta(TAKER, true)], Buffer.concat([Buffer.from([4]), u64(2n ** 64n - 1n)]))), /token instruction 4/],
    ['approve checked', (b) => b.setupInstructions.push(api(PROGRAM_IDS.token, [meta(ata(TAKER, b.inputMint), false, true), meta(b.inputMint), meta(STRANGER), meta(TAKER, true)], Buffer.concat([Buffer.from([13]), u64(1n), Buffer.from([8])]))), /token instruction 13/],
    ['transfer', (b) => b.otherInstructions.push(api(PROGRAM_IDS.token, [meta(wsolAta, false, true), meta(ata(STRANGER, WSOL), false, true), meta(TAKER, true)], Buffer.concat([Buffer.from([3]), u64(1n)]))), /token instruction 3/],
    ['set authority', (b) => b.setupInstructions.push(api(PROGRAM_IDS.token, [meta(ata(TAKER, b.inputMint), false, true), meta(TAKER, true)], Buffer.from([6, 2, 1, ...Buffer.alloc(32)]))), /token instruction 6/],
    ['token-2022 program', (b) => b.setupInstructions.push(api(PROGRAM_IDS.token2022, [meta(ata(TAKER, b.inputMint, PROGRAM_IDS.token2022), false, true), meta(STRANGER), meta(TAKER, true)], Buffer.concat([Buffer.from([4]), u64(1n)]))), /helper instruction calls/],
    // R1c: the cleanup closes the WSOL account to a stranger
    ['close to a stranger', (b) => { b.cleanupInstruction = api(PROGRAM_IDS.token, [meta(wsolAta, false, true), meta(STRANGER, false, true), meta(TAKER, true)], Buffer.from([9])); }, /pays it to someone else/],
    ['close of another account', (b) => { b.cleanupInstruction = api(PROGRAM_IDS.token, [meta(ata(TAKER, b.inputMint), false, true), meta(TAKER, false, true), meta(TAKER, true)], Buffer.from([9])); }, /other than the trader's WSOL/],
    ['sync-native of a stranger', (b) => b.setupInstructions.push(api(PROGRAM_IDS.token, [meta(ata(STRANGER, WSOL), false, true)], Buffer.from([17]))), /sync-native/],
    ['account created for a stranger', (b) => b.setupInstructions.push(api(PROGRAM_IDS.ata, [meta(TAKER, true, true), meta(ata(STRANGER, WSOL), false, true), meta(STRANGER), meta(WSOL), meta(PROGRAM_IDS.system), meta(PROGRAM_IDS.token)], Buffer.from([1]))), /someone else/],
    ['account for a mint off the route', (b) => b.setupInstructions.push(api(PROGRAM_IDS.ata, [meta(TAKER, true, true), meta(ata(TAKER, VICINITY_MINT), false, true), meta(TAKER), meta(VICINITY_MINT), meta(PROGRAM_IDS.system), meta(PROGRAM_IDS.token)], Buffer.from([1]))), /not on the route/],
    ['ATA recover-nested', (b) => b.setupInstructions.push(api(PROGRAM_IDS.ata, b.setupInstructions[0].accounts, Buffer.from([2]))), /other than create-idempotent/],
    // V1: output redirected to a stranger, with the trader's account appended as a decoy
    ['output redirected by position', (b) => { b.swapInstruction.accounts[5] = meta(ata(STRANGER, WSOL), false, true); b.swapInstruction.accounts.push(meta(wsolAta, false, true)); }, /trader's own .* account/],
    ['input from a stranger', (b) => { b.swapInstruction.accounts[2] = meta(ata(STRANGER, b.inputMint), false, true); }, /spends from/],
    ['authorised by a stranger', (b) => { b.swapInstruction.accounts[1] = meta(STRANGER, false, false); }, /authorised by/],
    ['wrong mints by position', (b) => { b.swapInstruction.accounts[7] = meta(VICINITY_MINT); }, /delivers/],
    // amounts the instruction enforces must be what the JSON promises
    ['in amount', (b) => { const c = withData(b, (d) => d.writeBigUInt64LE(swapData.readBigUInt64LE(9) * 2n, 9)); b.swapInstruction = c.swapInstruction; }, /spends 200000/],
    ['slippage 100% in the instruction', (b) => { const c = withData(b, (d) => d.writeUInt16LE(10_000, 25)); b.swapInstruction = c.swapInstruction; }, /slippage/],
    ['quoted out', (b) => { const c = withData(b, (d) => d.writeBigUInt64LE(1n, 17)); b.swapInstruction = c.swapInstruction; }, /quotes 1/],
    ['platform fee', (b) => { const c = withData(b, (d) => d.writeUInt16LE(50, 27)); b.swapInstruction = c.swapInstruction; }, /platform fee/],
    ['positive-slippage cut', (b) => { const c = withData(b, (d) => d.writeUInt16LE(50, 29)); b.swapInstruction = c.swapInstruction; }, /positive-slippage/],
    ['JSON threshold above what the swap enforces', (b) => { b.otherAmountThreshold = String(BigInt(b.otherAmountThreshold) + 1n); }, /guarantees/],
    ['exact-out route', (b) => { const c = withData(b, (d) => Buffer.from('3560e5cad8bbfa18', 'hex').copy(d, 0)); b.swapInstruction = c.swapInstruction; }, /not an ExactIn route/],
    ['slippage above 50%', (b) => { b.slippageBps = 6000; }, /slippage 6000/],
  ];
  for (const [name, mutate, re] of cases) {
    const b = clone(good);
    mutate(b);
    assert.throws(() => composePayWithAnything({ build: b, trader: TAKER, coin, minCoinsOut: 1n }), re, name);
  }
  // the sell direction: a cleanup that closes the WSOL account to a stranger is refused, not mistaken for Jupiter's own unwrap (V1)
  const s2 = clone(sell);
  s2.cleanupInstruction = api(PROGRAM_IDS.token, [meta(wsolAta, false, true), meta(STRANGER, false, true), meta(TAKER, true)], Buffer.from([9]));
  assert.throws(() => composeSellIntoAnything({ build: s2, trader: TAKER, coin, coinAmountIn: 1n, minQuoteOut: BigInt(sell.inAmount) }), /someone else/);
  // paying with SOL: Jupiter's own wrap (create, transfer of exactly the amount into the trader's WSOL, sync) is accepted
  const solIn = clone(sell);
  solIn.setupInstructions.push(api(PROGRAM_IDS.system, [meta(TAKER, true, true), meta(wsolAta, false, true)], Buffer.concat([u32(2), u64(BigInt(sell.inAmount))])), api(PROGRAM_IDS.token, [meta(wsolAta, false, true)], Buffer.from([17])));
  assert.doesNotThrow(() => checkJupiterBuild(solIn, { trader: TAKER, inputMint: WSOL, outputMint: sell.outputMint }));
  solIn.setupInstructions[solIn.setupInstructions.length - 2] = api(PROGRAM_IDS.system, [meta(TAKER, true, true), meta(wsolAta, false, true)], Buffer.concat([u32(2), u64(BigInt(sell.inAmount) + 1n)]));
  assert.throws(() => checkJupiterBuild(solIn, { trader: TAKER, inputMint: WSOL, outputMint: sell.outputMint }), /wraps more SOL/);
});

test('Jupiter\'s priority fee is capped (R1d): 0.01 SOL at the compute limit, whatever the answer asks', () => {
  const b = clone(load('jupiter-build-cbBTC-to-SOL-max40.json'));
  const coin = coinFor(WSOL);
  b.computeBudgetInstructions = [api(COMPUTE_BUDGET_PROGRAM, [], Buffer.concat([Buffer.from([3]), u64(1_000_000_000_000n)])), api(COMPUTE_BUDGET_PROGRAM, [], Buffer.concat([Buffer.from([2]), u32(1_400_000)]))];
  for (const plan of [composePayWithAnything({ build: b, trader: TAKER, coin, minCoinsOut: 1n }), composePayWithAnything({ build: b, trader: TAKER, coin, minCoinsOut: 1n, maxBytes: 600 })]) {
    for (const t of plan.transactions) {
      const prices = t.instructions.filter((i) => i.programAddress === COMPUTE_BUDGET_PROGRAM).map((i) => { assert.equal(i.data[0], 3, 'only a price is kept; the limit is ours'); return Buffer.from(i.data).readBigUInt64LE(1); });
      for (const p of prices) assert.ok((p * BigInt(t.cuLimit)) / 1_000_000n <= MAX_PRIORITY_FEE_LAMPORTS, `${t.label}: fee ${(p * BigInt(t.cuLimit)) / 1_000_000n}`);
    }
  }
  // a normal price passes through unchanged
  const normal = composePayWithAnything({ build: load('jupiter-build-cbBTC-to-SOL-max40.json'), trader: TAKER, coin, minCoinsOut: 1n });
  assert.equal(Buffer.from(normal.transactions[0].instructions[0].data).readBigUInt64LE(1), 4_925n);
  // and a transaction builder refuses an uncapped price outright
  assert.throws(() => toV0Transaction({ payer: TAKER, instructions: [setComputeUnitPrice(1_000_000_000n)], cuLimit: 600_000 }), /priority fee/);
});

test('a finished or graduated curve is refused before the buyer\'s asset is touched; after the swap the buy is rebuilt from the live pool', async () => {
  const build = load('jupiter-build-cbBTC-to-SOL-max40.json');
  const coin = coinFor(WSOL);
  const full = { ...START, quoteReserve: CFG.migrationQuoteThreshold };
  assert.throws(() => composePayWithAnything({ build, trader: TAKER, coin, minCoinsOut: 1n, pool: full, config: CFG }), /full/);
  assert.throws(() => composePayWithAnything({ build, trader: TAKER, coin, minCoinsOut: 1n, pool: { ...START, isMigrated: 1 }, config: CFG }), /graduated/);
  let asked = 0;
  const fetchImpl = async () => { asked++; throw new Error('must not be called'); };
  await assert.rejects(planPayWithAnything({ payMint: payAsset('cbBTC').mint, amount: 100_000n, trader: TAKER, coin, pool: full, config: CFG, slippageBps: 100, fetchImpl: fetchImpl as never }), /full/);
  assert.equal(asked, 0, 'Jupiter is not even asked');
  // two-transaction mode: step 2 re-quotes the live pool as a partial fill, and refuses a curve that filled meanwhile
  const after = buildBuyAfterSwap({ trader: TAKER, coin, pool: START, config: CFG, amountIn: 700_000_000n, slippageBps: 100 });
  const dbcIx = after.instructions.find((i) => i.programAddress === PROGRAM_IDS.dbc)!;
  assert.equal(swap2(dbcIx.data).data.params.swap_mode, 1);
  assert.equal(swap2(dbcIx.data).data.params.amount_1.toString(), after.minOut.toString());
  assert.ok(after.expectedCoins > after.minOut && after.minOut > 0n);
  assert.throws(() => buildBuyAfterSwap({ trader: TAKER, coin, pool: full, config: CFG, amountIn: 700_000_000n }), /full/);
  const two = composePayWithAnything({ build, trader: TAKER, coin, minCoinsOut: 1n, maxBytes: 600 });
  assert.equal(two.mode, 'two-transactions');
  assert.match(two.notes.join(' '), /buildBuyAfterSwap/);
  assert.equal(swap2(two.transactions[1].instructions.find((i) => i.programAddress === PROGRAM_IDS.dbc)!.data).data.params.swap_mode, 1, 'the planned step 2 is a partial fill too');
});

test('a Jupiter response that does not do what was asked is refused', () => {
  const good = load('jupiter-build-cbBTC-to-SOL-max40.json');
  const coin = coinFor(WSOL);
  const tries: [string, JupiterBuild, RegExp][] = [
    ['exact out', { ...good, swapMode: 'ExactOut' }, /ExactIn/],
    ['other output', { ...good, outputMint: VICINITY_MINT }, /output mint/],
    ['zero minimum', { ...good, otherAmountThreshold: '0' }, /zero guaranteed/],
    ['minimum above quote', { ...good, otherAmountThreshold: String(BigInt(good.outAmount) + 1n) }, /above the quoted/],
    ['other swap program', { ...good, swapInstruction: { ...good.swapInstruction, programId: PROGRAM_IDS.dbc } }, /swap program/],
    ['extra signer', { ...good, setupInstructions: [{ ...good.setupInstructions[0], accounts: [...good.setupInstructions[0].accounts, { pubkey: ADDRESSES.feeRecipient, isSigner: true, isWritable: true }] }] }, /unexpected signer/],
    ['unknown helper', { ...good, setupInstructions: [{ ...good.setupInstructions[0], programId: PROGRAM_IDS.dbc }] }, /helper instruction/],
    ['tip', { ...good, tipInstruction: { programId: PROGRAM_IDS.system, accounts: [], data: '' } }, /tip/],
    ['output elsewhere', { ...good, swapInstruction: { ...good.swapInstruction, accounts: good.swapInstruction.accounts.filter((a) => a.pubkey !== ata(TAKER, WSOL)) } }, /trader's own|spends|delivers/],
  ];
  for (const [name, build, re] of tries) assert.throws(() => composePayWithAnything({ build, trader: TAKER, coin, minCoinsOut: 1n }), re, name);
  assert.throws(() => checkJupiterBuild(good, { trader: ADDRESSES.feeRecipient, inputMint: good.inputMint, outputMint: WSOL }), /unexpected signer/, 'built for another taker');
  assert.throws(() => composePayWithAnything({ build: good, trader: TAKER, coin, minCoinsOut: 0n }), /minCoinsOut/);
});

test('planPayWithAnything: smaller routes until it fits; paying with the quote token itself needs no swap', async () => {
  const coin = coinFor(WSOL);
  const fixture = load('jupiter-build-cbBTC-to-SOL-max40.json');
  const asked: string[] = [];
  const fakeFetch = async (url: string) => {
    asked.push(new URL(url).searchParams.get('maxAccounts')!);
    const body = asked.length === 1 ? JSON.stringify({ error: 'No routes found', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }) : JSON.stringify(fixture);
    return { ok: asked.length !== 1, status: asked.length === 1 ? 400 : 200, json: async () => JSON.parse(body), text: async () => body };
  };
  const r = await planPayWithAnything({ payMint: payAsset('cbBTC').mint, amount: 100_000n, trader: TAKER, coin, pool: START, config: CFG, slippageBps: 100, minCoinsOutFor: (q) => q * 30_000n, fetchImpl: fakeFetch });
  assert.deepEqual(asked, ['40', '32']);
  assert.equal(r.tried[0].result, 'no route');
  assert.equal(r.plan!.mode, 'one-transaction');
  const direct = await planPayWithAnything({ payMint: WSOL, amount: 1_000_000_000n, trader: TAKER, coin, pool: START, config: CFG, slippageBps: 100, fetchImpl: fakeFetch });
  const directBuy = direct.direct!.find((i) => i.programAddress === PROGRAM_IDS.dbc)!;
  assert.equal(swap2(directBuy.data).data.params.swap_mode, 1, 'the direct path is a partial fill too');
  assert.ok(BigInt(swap2(directBuy.data).data.params.amount_1.toString()) > 0n, 'default minimum from the live pool');
  assert.equal(asked.length, 2, 'no Jupiter call for SOL into a SOL-priced coin');
  // a VICINITY payment tries the small route sizes first, then 64 (review nit: VICINITY routes at 40 today)
  const sizes: string[] = [];
  const noRoute = async (url: string) => { sizes.push(new URL(url).searchParams.get('maxAccounts')!); const body = JSON.stringify({ error: 'No routes found' }); return { ok: false, status: 400, json: async () => JSON.parse(body), text: async () => body }; };
  const none = await planPayWithAnything({ payMint: VICINITY_MINT, amount: 1_000_000n, trader: TAKER, coin, pool: START, config: CFG, slippageBps: 100, fetchImpl: noRoute });
  assert.deepEqual(sizes, ['40', '32', '24', '64']);
  assert.equal(none.plan, null);
  // an answer for another amount than the buyer typed is refused (and reported), never composed
  const wrongAmount = async () => { const body = JSON.stringify(fixture); return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body }; };
  const w2 = await planPayWithAnything({ payMint: payAsset('cbBTC').mint, amount: 99_999n, trader: TAKER, coin, pool: START, config: CFG, slippageBps: 100, fetchImpl: wrongAmount });
  assert.equal(w2.plan, null);
  assert.match(w2.tried[0].result, /in amount/);
  const u = new URL(jupiterBuildUrl({ inputMint: 'a', outputMint: 'b', amount: 5n, taker: TAKER, slippageBps: 50 }));
  assert.equal(u.origin + u.pathname, 'https://api.jup.ag/swap/v2/build');
  assert.deepEqual(Object.fromEntries(u.searchParams), { inputMint: 'a', outputMint: 'b', amount: '5', taker: TAKER, slippageBps: '50', maxAccounts: '64', wrapAndUnwrapSol: 'true' });
});

test('the pay-with list: verified mainnet mints; stocks only on the allow-list, never where blocked or unknown (review F3)', () => {
  for (const a of PAY_ASSETS) assert.doesNotThrow(() => new web3.PublicKey(a.mint), a.symbol);
  assert.equal(new Set(PAY_ASSETS.map((a) => a.mint)).size, PAY_ASSETS.length);
  assert.deepEqual(PAY_ASSETS.filter((a) => a.kind === 'stock').map((a) => a.tokenProgram), Array(10).fill('token2022'));
  // the reviewer's list: sanctioned and other non-approved countries no longer see stocks (it used to be only US, UK, CA, AU)
  for (const c of ['US', 'gb', 'CA', 'AU', 'RU', 'IR', 'KP', 'CU', 'SY', 'BY', 'SG', 'HK', 'JP', 'IN', 'NG', 'BR', 'XX', 'T1', 'zz', null, '', ' ']) {
    assert.equal(payAssetsFor(c).some((a) => a.kind === 'stock'), false, String(c));
  }
  for (const c of ['DE', 'fr', 'CH', 'NO']) assert.equal(payAssetsFor(c).filter((a) => a.kind === 'stock').length, 10, c);
  assert.equal(STOCK_ALLOWED_COUNTRIES.length, 31);
  // everything that is not a stock stays on offer everywhere
  assert.equal(mayOffer(payAsset('cbBTC'), null), true);
  assert.equal(payAssetsFor('US').length, PAY_ASSETS.length - 10);
  assert.equal(payAsset('VICINITY').minMaxAccounts, 40);
  assert.throws(() => payAsset('DOGE'), /not on the Vicinity pay-with list/);
});

test('compute limit: 1.2x what a simulation used, capped at 1,400,000; a failed simulation is reported', async () => {
  const build = load('jupiter-build-cbBTC-to-SOL-max40.json');
  const plan = composePayWithAnything({ build, trader: TAKER, coin: coinFor(WSOL), minCoinsOut: 1n });
  assert.equal(plan.transactions[0].cuLimit, DEFAULT_PAY_CU, 'without a simulation, the default limit');
  const fake = (unitsConsumed: number, err: unknown = null) => ({ simulateTransaction: async () => ({ context: { slot: 1 }, value: { err, logs: ['Program log: x'], unitsConsumed, accounts: null, returnData: null } }) });
  assert.equal(await simulatedCuLimit(fake(250_001) as never, plan.transactions[0].tx), 300_002);
  assert.equal(await simulatedCuLimit(fake(1_300_000) as never, plan.transactions[0].tx), 1_400_000);
  await assert.rejects(simulatedCuLimit(fake(0, { InstructionError: [4, { Custom: 6017 }] }) as never, plan.transactions[0].tx), /simulation failed/);
});
