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
import { composePayWithAnything, composeSellIntoAnything, checkJupiterBuild, jupiterBuildUrl, planPayWithAnything, jupiterBlockhash, JUPITER_PROGRAM } from './jupiter.mts';
import type { JupiterBuild } from './jupiter.mts';
import { launchpadLookupTableAddresses, lookupTableFrom } from './lookup-table.mts';
import { MAX_TX_BYTES } from './trade.mts';
import { VICINITY_MINT, payAsset, payAssetsFor, mayOffer, PAY_ASSETS } from './pay-assets.mts';

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

test('cbBTC -> SOL -> coin: one transaction, the buy spends exactly Jupiter\'s guaranteed minimum', () => {
  const build = load('jupiter-build-cbBTC-to-SOL-max40.json');
  const coin = coinFor(WSOL);
  const plan = composePayWithAnything({ build, trader: TAKER, coin, minCoinsOut: 1_000n });
  assert.equal(plan.mode, 'one-transaction');
  const t = plan.transactions[0];
  assert.ok(t.bytes <= MAX_TX_BYTES, `${t.bytes} bytes`);
  // order: price, Jupiter setup, Jupiter swap, coin account, DBC buy, Jupiter cleanup
  const programs = t.instructions.map((i) => i.programAddress);
  assert.deepEqual(programs, ['ComputeBudget111111111111111111111111111111', PROGRAM_IDS.ata, JUPITER_PROGRAM, PROGRAM_IDS.ata, PROGRAM_IDS.dbc, PROGRAM_IDS.token]);
  const buy = swap2(t.instructions[4].data);
  assert.equal(buy.name, 'swap2');
  assert.equal(buy.data.params.amount_0.toString(), build.otherAmountThreshold, 'amount in = the guaranteed minimum');
  assert.equal(buy.data.params.amount_1.toString(), '1000');
  assert.equal(buy.data.params.swap_mode, 0);
  assert.equal(t.instructions[4].accounts[3].address, ata(TAKER, WSOL), 'the buy (input_token_account) reads the WSOL account Jupiter paid into');
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
    ['output elsewhere', { ...good, swapInstruction: { ...good.swapInstruction, accounts: good.swapInstruction.accounts.filter((a) => a.pubkey !== ata(TAKER, WSOL)) } }, /trader's own/],
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
  const r = await planPayWithAnything({ payMint: payAsset('cbBTC').mint, amount: 100_000n, trader: TAKER, coin, slippageBps: 100, minCoinsOutFor: (q) => q * 30_000n, fetchImpl: fakeFetch });
  assert.deepEqual(asked, ['40', '32']);
  assert.equal(r.tried[0].result, 'no route');
  assert.equal(r.plan!.mode, 'one-transaction');
  const direct = await planPayWithAnything({ payMint: WSOL, amount: 1_000_000_000n, trader: TAKER, coin, slippageBps: 100, minCoinsOutFor: () => 1n, fetchImpl: fakeFetch });
  assert.ok(direct.direct && direct.direct.some((i) => i.programAddress === PROGRAM_IDS.dbc));
  assert.equal(asked.length, 2, 'no Jupiter call for SOL into a SOL-priced coin');
  const u = new URL(jupiterBuildUrl({ inputMint: 'a', outputMint: 'b', amount: 5n, taker: TAKER, slippageBps: 50 }));
  assert.equal(u.origin + u.pathname, 'https://api.jup.ag/swap/v2/build');
  assert.deepEqual(Object.fromEntries(u.searchParams), { inputMint: 'a', outputMint: 'b', amount: '5', taker: TAKER, slippageBps: '50', maxAccounts: '64', wrapAndUnwrapSol: 'true' });
});

test('the pay-with list: verified mainnet mints, stocks hidden in the US, UK, Canada and Australia (and when unknown)', () => {
  for (const a of PAY_ASSETS) assert.doesNotThrow(() => new web3.PublicKey(a.mint), a.symbol);
  assert.equal(new Set(PAY_ASSETS.map((a) => a.mint)).size, PAY_ASSETS.length);
  assert.deepEqual(PAY_ASSETS.filter((a) => a.kind === 'stock').map((a) => a.tokenProgram), Array(10).fill('token2022'));
  for (const c of ['US', 'gb', 'CA', 'AU', null, '']) assert.equal(payAssetsFor(c).some((a) => a.kind === 'stock'), false, String(c));
  assert.equal(payAssetsFor('DE').filter((a) => a.kind === 'stock').length, 10);
  assert.equal(mayOffer(payAsset('cbBTC'), null), true);
  assert.equal(payAsset('VICINITY').minMaxAccounts, 64);
  assert.throws(() => payAsset('DOGE'), /not on the Vicinity pay-with list/);
});
