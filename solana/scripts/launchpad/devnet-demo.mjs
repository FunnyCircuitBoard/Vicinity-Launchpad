#!/usr/bin/env node
// The launchpad, end to end, on DEVNET (LAUNCHPAD-DESIGN.md section 19).
// It refuses to run on mainnet. Every step is recorded in a state file (public
// data only: addresses, signatures, amounts), so a run can be resumed and the
// record copied into LAUNCHPAD-DEVNET.md.
//
// Usage, from solana/ (after deploying the program, see LAUNCHPAD-DEVNET.md):
//   node scripts/launchpad/devnet-demo.mjs --keys <dir> --state <file> [--rpc <url>] [--only a,b] [--from step]
//
// <dir> must hold these throwaway keypair files (create each with
//   solana-keygen new --no-bip39-passphrase --silent --outfile <dir>/<name>-keypair.json):
//   devnet-deployer.json (program upgrade authority, launchpad admin, rewards registry admin, payer)
//   demo-founder-a, demo-founder-b, demo-trader-1, demo-trader-2, demo-payout-authority,
//   demo-payout-wallet, demo-quote-mint, demo-dbc-config-sol, demo-dbc-config-tvic,
//   demo-mint-a, demo-mint-b, demo-mint-c, demo-nft-1, demo-nft-2
// Keys are read from files and never printed.
//
// What it does: a test quote token "tVIC" standing in for $VICINITY (classic
// SPL, 6 decimals, 1,000,000,000 minted to the demo wallets, then the mint
// authority removed, as the config rules require); two Meteora configs (SOL,
// target 1 SOL; tVIC, target 25,000,000 tVIC; launch fee 0.01 SOL; every fee
// to the dev wallet 13qRam…); init and allow-list them; the Vicinity lookup
// table; approve and launch three demo cities (two priced in tVIC, one in SOL),
// with Vicinity metadata; buys, sells, exact out, coin to coin; graduation of
// DEMO into a Meteora DAMM v2 pool and trades there; the keeper's pass; a
// holders' rewards round and a claim; a push to all holders; the founder's
// claim; the opt-in payout (and its refusal 24 hours early); payouts switched
// off again; leftover SOL swept back to the deployer.
import { join } from 'node:path';
import web3 from '@solana/web3.js';
import * as spl from '@solana/spl-token';
import * as S from '../../sdk/launchpad/index.mts';
import * as C from '../../sdk/launchpad/client.mjs';
import { vicinityConfigParams, createConfigIx } from '../../sdk/launchpad/config.mjs';
import { buildIx, IDL } from '../../sdk/launchpad/idl.mjs';
import { ADDRESSES, PROGRAM_IDS, ata, dbc, damm, pdas, rewardsPdas } from '../../sdk/launchpad/pda.mjs';
import { connectionReader, runKeeper } from '../../sdk/launchpad/keeper.mjs';
import { prepareRound, ROUND_RULES } from '../../sdk/launchpad/snapshot.mjs';
import { connect, loadKeypair, send, simulate, stateFile, explorer, json } from './lib.mjs';

const { PublicKey, SystemProgram } = web3;
const P = pdas();
const R = rewardsPdas();
const WSOL = ADDRESSES.wsol;
const SOL = 1_000_000_000n;
const TVIC = 1_000_000n; // 1 tVIC in raw units (6 decimals)

function parseArgs(argv) {
  const a = { rpc: 'https://api.devnet.solana.com', only: null, from: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--rpc') a.rpc = argv[++i];
    else if (k === '--keys') a.keys = argv[++i];
    else if (k === '--state') a.state = argv[++i];
    else if (k === '--only') a.only = argv[++i].split(',');
    else if (k === '--from') a.from = argv[++i];
    else throw new Error(`unknown option ${k}`);
  }
  if (!a.keys || !a.state) throw new Error('usage: devnet-demo.mjs --keys <dir> --state <file> [--rpc <url>] [--only a,b] [--from step]');
  return a;
}

const args = parseArgs(process.argv.slice(2));
const { connection, cluster } = await connect(args.rpc);
if (cluster === 'mainnet') throw new Error('devnet-demo refuses to run on mainnet');
const key = (name) => loadKeypair(join(args.keys, name.endsWith('.json') ? name : `${name}-keypair.json`));
const deployer = key('devnet-deployer.json');
const k = {
  founderA: key('demo-founder-a'), founderB: key('demo-founder-b'), trader1: key('demo-trader-1'), trader2: key('demo-trader-2'),
  payoutAuthority: key('demo-payout-authority'), payoutWallet: key('demo-payout-wallet'), quoteMint: key('demo-quote-mint'),
  cfgSol: key('demo-dbc-config-sol'), cfgTvic: key('demo-dbc-config-tvic'), mintA: key('demo-mint-a'), mintB: key('demo-mint-b'),
  mintC: key('demo-mint-c'), nft1: key('demo-nft-1'), nft2: key('demo-nft-2'),
};
const addr = (kp) => kp.publicKey.toBase58();
const TVIC_MINT = addr(k.quoteMint);
const { state, save } = stateFile(args.state);
state.cluster = cluster;
state.rpc = args.rpc;
Object.assign(state.addresses, {
  launchpadProgram: PROGRAM_IDS.launchpad, rewardsProgram: PROGRAM_IDS.rewards, launchpad: P.launchpad(), deployer: addr(deployer),
  devWallet: ADDRESSES.feeRecipient, testQuoteMint: TVIC_MINT, dbcConfigSol: addr(k.cfgSol), dbcConfigTvic: addr(k.cfgTvic),
  founderA: addr(k.founderA), founderB: addr(k.founderB), trader1: addr(k.trader1), trader2: addr(k.trader2),
  payoutAuthority: addr(k.payoutAuthority), payoutWallet: addr(k.payoutWallet),
});
save();

const CITIES = {
  A: { cityId: 999000001n, name: 'Demo City', symbol: 'DEMO', founder: k.founderA, mint: k.mintA, cfg: () => addr(k.cfgTvic), quote: TVIC_MINT },
  B: { cityId: 999000002n, name: 'Demo Town', symbol: 'DEMOT', founder: k.founderB, mint: k.mintB, cfg: () => addr(k.cfgTvic), quote: TVIC_MINT },
  C: { cityId: 999000003n, name: 'Demo Village', symbol: 'DEMOV', founder: k.founderB, mint: k.mintC, cfg: () => addr(k.cfgSol), quote: WSOL },
};
const coinOf = async (city) => S.fetchCoin(connection, city.cityId);
const market = async (coin) => S.fetchCoinMarket(connection, coin);
const lamportsOf = async (a) => BigInt(await connection.getBalance(new PublicKey(a), 'confirmed'));
const tokenBal = (a) => S.tokenBalance(connection, a);

let lut = null;
async function lookupTables() {
  if (lut) return [lut];
  const a = state.steps['lookup-table']?.lookupTable;
  if (!a) return [];
  const r = await connection.getAddressLookupTable(new PublicKey(a));
  lut = r.value;
  return lut ? [lut] : [];
}

const order = [];
const steps = {};
const def = (name, fn) => { order.push(name); steps[name] = fn; };
const tx = async (label, opts) => {
  const r = await send(connection, { label, ...opts });
  console.log(`  ${label}: ${r.signature} (${r.bytes} bytes)`);
  return { label, signature: r.signature, bytes: r.bytes, explorer: explorer('tx', r.signature, cluster) };
};

// ------------------------------------------------------------------ steps
def('preflight', async () => {
  const prog = await connection.getAccountInfo(new PublicKey(PROGRAM_IDS.launchpad));
  if (!prog?.executable) throw new Error(`vicinity_launchpad ${PROGRAM_IDS.launchpad} is not deployed on this cluster`);
  for (const p of [PROGRAM_IDS.rewards, PROGRAM_IDS.dbc, PROGRAM_IDS.damm, PROGRAM_IDS.metaplex]) {
    if (!(await connection.getAccountInfo(new PublicKey(p)))?.executable) throw new Error(`${p} is not deployed on this cluster`);
  }
  const reg = await connection.getAccountInfo(new PublicKey(R.registry()));
  if (!reg) throw new Error('the vicinity_rewards registry is not initialised on this cluster');
  return { deployerBalance: String(await lamportsOf(addr(deployer))), rewardsRegistry: R.registry() };
});

def('fund-wallets', async () => {
  const plan = [[k.founderA, 120_000_000n], [k.founderB, 200_000_000n], [k.trader1, 60_000_000n], [k.trader2, 50_000_000n], [k.payoutAuthority, 15_000_000n]];
  const ixs = plan.map(([kp, lam]) => S.fromWeb3Instruction(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: lam })));
  return { txs: [await tx('fund demo wallets', { payer: deployer, ixs })], amounts: Object.fromEntries(plan.map(([kp, l]) => [addr(kp), String(l)])) };
});

def('quote-mint', async () => {
  const rent = await spl.getMinimumBalanceForRentExemptMint(connection);
  const ixs = [
    S.fromWeb3Instruction(SystemProgram.createAccount({ fromPubkey: deployer.publicKey, newAccountPubkey: k.quoteMint.publicKey, lamports: rent, space: spl.MINT_SIZE, programId: spl.TOKEN_PROGRAM_ID })),
    S.fromWeb3Instruction(spl.createInitializeMint2Instruction(k.quoteMint.publicKey, 6, deployer.publicKey, null)),
  ];
  const holders = [[deployer, 780_000_000n], [k.founderA, 10_000_000n], [k.founderB, 10_000_000n], [k.trader1, 100_000_000n], [k.trader2, 100_000_000n]];
  const t1 = await tx('create tVIC mint', { payer: deployer, signers: [k.quoteMint], ixs });
  const mintIxs = holders.flatMap(([kp, whole]) => [
    S.createAta(addr(deployer), addr(kp), TVIC_MINT),
    S.fromWeb3Instruction(spl.createMintToInstruction(k.quoteMint.publicKey, new PublicKey(ata(addr(kp), TVIC_MINT)), deployer.publicKey, whole * TVIC)),
  ]);
  const t2 = await tx('mint 1,000,000,000 tVIC to the demo wallets', { payer: deployer, ixs: mintIxs, cuLimit: 300_000 });
  const t3 = await tx('remove the tVIC mint authority', { payer: deployer, ixs: [S.fromWeb3Instruction(spl.createSetAuthorityInstruction(k.quoteMint.publicKey, deployer.publicKey, spl.AuthorityType.MintTokens, null))] });
  const m = S.decodeMint((await connection.getAccountInfo(k.quoteMint.publicKey)).data);
  if (m.mintAuthority !== null || m.freezeAuthority !== null || m.supply !== 1_000_000_000n * TVIC) throw new Error('tVIC mint not as required');
  return { txs: [t1, t2, t3], mint: TVIC_MINT, supply: String(m.supply), decimals: 6 };
});

def('dbc-configs', async () => {
  const sol = vicinityConfigParams({ migrationQuoteThreshold: 1, poolCreationFeeSol: 0.01 });
  const tvic = vicinityConfigParams({ migrationQuoteThreshold: 25_000_000, quoteDecimals: 6, poolCreationFeeSol: 0.01 });
  const t1 = await tx('Meteora DBC config: SOL, target 1 SOL', { payer: deployer, signers: [k.cfgSol], ixs: [createConfigIx({ config: addr(k.cfgSol), quoteMint: WSOL, payer: addr(deployer), params: sol })], cuLimit: 100_000 });
  const t2 = await tx('Meteora DBC config: tVIC, target 25,000,000 tVIC', { payer: deployer, signers: [k.cfgTvic], ixs: [createConfigIx({ config: addr(k.cfgTvic), quoteMint: TVIC_MINT, payer: addr(deployer), params: tvic })], cuLimit: 100_000 });
  const out = { txs: [t1, t2] };
  for (const [name, a] of [['sol', addr(k.cfgSol)], ['tvic', addr(k.cfgTvic)]]) {
    const c = S.decodeDbcConfig((await connection.getAccountInfo(new PublicKey(a))).data);
    out[name] = { address: a, quoteMint: c.quoteMint, feeClaimer: c.feeClaimer, leftoverReceiver: c.leftoverReceiver, target: String(c.migrationQuoteThreshold), feeBps: S.feeBpsOf(c), launchFeeLamports: String(c.poolCreationFee), swapBaseAmount: String(c.swapBaseAmount), migrationBaseThreshold: String(c.migrationBaseThreshold) };
  }
  return out;
});

def('init-launchpad', async () => {
  const existing = await S.fetchLaunchpad(connection);
  if (existing) return { note: 'already initialised', admin: existing.admin };
  return { txs: [await tx('init_launchpad', { payer: deployer, ixs: [C.initLaunchpad({ payer: addr(deployer), admin: addr(deployer), upgradeAuthority: addr(deployer) })] })] };
});

def('add-configs', async () => {
  const txs = [];
  for (const [cfg, q] of [[addr(k.cfgSol), WSOL], [addr(k.cfgTvic), TVIC_MINT]]) {
    if (await S.fetchLaunchConfig(connection, cfg)) continue;
    txs.push(await tx(`add_launch_config ${cfg}`, { payer: deployer, ixs: [C.addLaunchConfig({ admin: addr(deployer), dbcConfig: cfg, quoteMint: q })] }));
  }
  return { txs };
});

def('referral-accounts', async () => {
  // the dev wallet's accounts that receive the vicinity.city referral share (anyone may create them)
  return { txs: [await tx('dev wallet referral accounts (WSOL, tVIC)', { payer: deployer, ixs: [S.createReferralAccount(addr(deployer), WSOL), S.createReferralAccount(addr(deployer), TVIC_MINT)] })], wsol: S.referralAccount(WSOL), tvic: S.referralAccount(TVIC_MINT) };
});

def('lookup-table', async () => {
  const slot = await connection.getSlot('finalized');
  const addresses = S.launchpadLookupTableAddresses({ dbcConfigs: [addr(k.cfgSol), addr(k.cfgTvic)], quoteMints: [WSOL, TVIC_MINT] });
  const t = S.buildCreateLookupTable({ authority: addr(deployer), recentSlot: slot, addresses });
  const txs = [await tx('create the Vicinity lookup table', { payer: deployer, ixs: [t.create] })];
  for (const [i, e] of t.extends.entries()) txs.push(await tx(`extend the lookup table (${i + 1}/${t.extends.length})`, { payer: deployer, ixs: [e] }));
  // a table is usable one slot after its last extension
  const start = await connection.getSlot('confirmed');
  while ((await connection.getSlot('confirmed')) <= start + 1) await new Promise((r) => setTimeout(r, 500));
  return { txs, lookupTable: t.lookupTable, addresses: addresses.length };
});

def('approve', async () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const txs = [];
  for (const c of Object.values(CITIES)) {
    if (await S.fetchApproval(connection, c.cityId) || await coinOf(c)) continue;
    txs.push(await tx(`approve_launch ${c.symbol}`, { payer: deployer, ixs: [C.approveLaunch({ admin: addr(deployer), cityId: c.cityId, founder: addr(c.founder), name: c.name, symbol: c.symbol, expiresAt: now + 7n * 86_400n, dbcConfig: c.cfg() })] }));
  }
  return { txs };
});

async function launchCity(c, firstBuyAmount) {
  if (await coinOf(c)) return { note: 'already launched' };
  const cfg = S.decodeDbcConfig((await connection.getAccountInfo(new PublicKey(c.cfg()))).data);
  const params = { founder: addr(c.founder), baseMint: addr(c.mint), cityId: c.cityId, dbcConfig: c.cfg(), quoteMint: c.quote, rentPayer: addr(deployer) };
  let quote = null;
  if (firstBuyAmount) {
    quote = S.quoteBuy({ sqrtPrice: cfg.sqrtStartPrice, quoteReserve: 0n }, cfg, { amountIn: firstBuyAmount, slippageBps: 100 });
    params.firstBuy = { amountIn: firstBuyAmount, minOut: quote.minOut };
  }
  const luts = await lookupTables();
  const plan = S.planLaunch(params, luts);
  const txs = [];
  for (const p of plan) txs.push(await tx(`${p.label} ${c.symbol}`, { payer: c.founder, signers: [c.mint], ixs: p.instructions, cuLimit: p.cuLimit, luts }));
  const coin = await coinOf(c);
  const md = S.decodeMetaplexMetadata((await connection.getAccountInfo(new PublicKey(dbc.metadata(coin.mint)))).data);
  const json = S.coinMetadataJson({ mint: coin.mint, name: md.name, symbol: md.symbol, city: { id: c.cityId, name: c.name, ticker: c.symbol } });
  return {
    txs, coin: coin.address, mint: coin.mint, dbcPool: coin.dbcPool, quoteMint: coin.quoteMint, holdersPot: coin.holdersPot, founderVault: coin.founderVault,
    metadata: { address: dbc.metadata(coin.mint), name: md.name, symbol: md.symbol, uri: md.uri, isMutable: md.isMutable, updateAuthority: md.updateAuthority, problems: S.checkMetadataAgainstChain(json, { mint: coin.mint, ...md }) },
    firstBuy: quote ? { amountIn: String(quote.amountIn), quotedCoins: String(quote.amountOut), received: String(await tokenBal(ata(addr(c.founder), coin.mint))) } : null,
  };
}
def('launch-a', () => launchCity(CITIES.A, 1_000_000n * TVIC));
def('launch-b', () => launchCity(CITIES.B, null));
def('launch-c', () => launchCity(CITIES.C, 20_000_000n));

/** One trade, quoted by the SDK first; returns quote vs result (parity on a real cluster). */
async function trade(label, trader, coin, kind, amount, slippageBps = 100) {
  const { pool, config } = await market(coin);
  let q, ixs;
  const common = { trader: addr(trader), coin };
  if (kind === 'buy') { q = S.quoteBuy(pool, config, { amountIn: amount, slippageBps }); ixs = S.buildBuy({ ...common, amountIn: amount, minOut: q.minOut, mode: q.mode }); }
  else if (kind === 'buyExactOut') { q = S.quoteBuyExactOut(pool, config, { amountOut: amount, slippageBps }); ixs = S.buildBuyExactOut({ ...common, amountOut: amount, maxIn: q.maxIn }); }
  else { q = S.quoteSell(pool, config, { amountIn: amount, slippageBps }); ixs = S.buildSell({ ...common, amountIn: amount, minOut: q.minOut }); }
  const coinAta = ata(addr(trader), coin.mint);
  const b = await tokenBal(coinAta);
  const t = await tx(label, { payer: trader, ixs, cuLimit: 150_000, luts: await lookupTables() });
  const a = await tokenBal(coinAta);
  const got = kind === 'sell' ? b - a : a - b;
  const expected = kind === 'sell' ? q.amountIn : q.amountOut;
  if (got !== expected) throw new Error(`${label}: coins moved ${got}, the SDK quoted ${expected}`);
  return { ...t, kind, quoteIn: String(q.amountIn), quoteOut: String(q.amountOut), fee: String(q.fees.total), devWallet: String(q.fees.devWallet), city: String(q.fees.city), meteora: String(q.fees.meteora), referral: String(q.fees.referral), matchesQuote: true };
}

def('trades', async () => {
  const A = await coinOf(CITIES.A), Cc = await coinOf(CITIES.C);
  const txs = [];
  txs.push(await trade('buy DEMO with 2,000,000 tVIC (exact in)', k.trader1, A, 'buy', 2_000_000n * TVIC));
  const held = await tokenBal(ata(addr(k.trader1), A.mint));
  txs.push(await trade('sell half of it (exact in)', k.trader1, A, 'sell', held / 2n));
  txs.push(await trade('buy exactly 5,000,000 DEMO (exact out)', k.trader1, A, 'buyExactOut', 5_000_000n * 1_000_000n));
  txs.push(await trade('buy DEMOV with 0.01 SOL (SOL wrapped and unwrapped)', k.trader1, Cc, 'buy', 10_000_000n));
  const heldC = await tokenBal(ata(addr(k.trader1), Cc.mint));
  txs.push(await trade('sell all DEMOV back to SOL', k.trader1, Cc, 'sell', heldC));
  return { txs };
});

def('coin-to-coin', async () => {
  const A = await coinOf(CITIES.A), B = await coinOf(CITIES.B);
  const held = await tokenBal(ata(addr(k.trader1), A.mint));
  const q = S.quoteCoinToCoin(await market(A), await market(B), { amountIn: held / 4n, slippageBps: 100 });
  const ixs = S.buildCoinToCoin({ trader: addr(k.trader1), from: A, to: B, amountIn: held / 4n, quoteMin: q.quoteMin, minOut: q.minOut });
  const b0 = await tokenBal(ata(addr(k.trader1), B.mint));
  const t = await tx('coin to coin: DEMO -> DEMOT in one transaction', { payer: k.trader1, ixs, cuLimit: 200_000, luts: await lookupTables() });
  const got = (await tokenBal(ata(addr(k.trader1), B.mint))) - b0;
  if (got !== q.buy.amountOut) throw new Error(`coin to coin: got ${got}, quoted ${q.buy.amountOut}`);
  return { txs: [t], sold: String(held / 4n), quoteMin: String(q.quoteMin), demotReceived: String(got) };
});

def('rewards-init', async () => {
  const txs = [];
  for (const c of [CITIES.A, CITIES.B]) {
    const coin = await coinOf(c);
    if (await S.fetchRewards(connection, coin)) continue;
    txs.push(await tx(`vicinity_rewards init_city for ${c.symbol} (Holders, 0% founder, paid in tVIC)`, { payer: deployer, ixs: [C.initRewardsForCoin({ payer: addr(deployer), registryAdmin: addr(deployer), authority: addr(deployer), coin })] }));
  }
  const A = await coinOf(CITIES.A);
  const r = await S.fetchRewards(connection, A);
  return { txs, config: r.configAddress, vault: r.vault, model: r.config.rewardModel, founderBps: r.config.founderBps };
});

def('graduate-a', async () => {
  let A = await coinOf(CITIES.A);
  const txs = [];
  let m = await market(A);
  if (!m.complete) {
    const fill = S.quoteFillCurve(m.pool, m.config, { referral: true });
    txs.push(await tx('fill the DEMO curve (partial fill, the rest refunded)', { payer: k.trader2, ixs: S.buildBuy({ trader: addr(k.trader2), coin: A, amountIn: fill.amount0, minOut: fill.minOut, mode: fill.mode }), cuLimit: 150_000, luts: await lookupTables() }));
  }
  txs.push(await tx('harvest_curve_fees DEMO (fees + the city\'s surplus share)', { payer: deployer, ixs: [C.harvestCurveFees({ payer: addr(deployer), coin: A })], cuLimit: 200_000 }));
  m = await market(A);
  if (!m.graduated) {
    txs.push(await tx('graduate DEMO: Meteora migration_damm_v2 (permissionless)', { payer: deployer, signers: [k.nft1, k.nft2], ixs: S.buildGraduate({ payer: addr(deployer), coin: A, firstNftMint: addr(k.nft1), secondNftMint: addr(k.nft2) }), cuLimit: S.CU.graduate }));
  }
  m = await market(A);
  if (!m.pool.isWithdrawLeftover) txs.push(await tx('withdraw_leftover: unsold dust to the dev wallet', { payer: deployer, ixs: S.buildWithdrawLeftover({ payer: addr(deployer), coin: A }), cuLimit: 100_000 }));
  const dammPool = damm.pool(ADDRESSES.dammCustomizableConfig, A.mint, TVIC_MINT);
  const vaultA = await tokenBal(damm.tokenVault(A.mint, dammPool)), vaultB = await tokenBal(damm.tokenVault(TVIC_MINT, dammPool));
  return {
    txs, dammPool, poolCoins: String(vaultA), poolTvic: String(vaultB), firstPosition: damm.position(addr(k.nft1)), secondPosition: damm.position(addr(k.nft2)),
    leftoverToDevWallet: String(await tokenBal(ata(ADDRESSES.feeRecipient, A.mint))),
  };
});

def('pool-trades', async () => {
  const A = await coinOf(CITIES.A);
  const dammPool = damm.pool(ADDRESSES.dammCustomizableConfig, A.mint, TVIC_MINT);
  const t1 = await tx('buy DEMO on its DAMM v2 pool (1,000,000 tVIC)', { payer: k.trader1, ixs: S.buildPoolSwap({ trader: addr(k.trader1), coin: A, dammPool, side: 'buy', amountIn: 1_000_000n * TVIC, minOut: 1n }), cuLimit: 150_000 });
  const held = await tokenBal(ata(addr(k.trader1), A.mint));
  const t2 = await tx('sell some DEMO on the pool', { payer: k.trader1, ixs: S.buildPoolSwap({ trader: addr(k.trader1), coin: A, dammPool, side: 'sell', amountIn: held / 10n, minOut: 1n }), cuLimit: 150_000 });
  return { txs: [t1, t2], dammPool };
});

def('keeper', async () => {
  const sigs = [];
  const sendKeeper = async (ixs, signers, { cu, label }) => {
    if (signers.length) throw new Error('the demo keeper never graduates (it would need fresh NFT keys)');
    const r = await tx(`keeper: ${label}`, { payer: deployer, ixs, cuLimit: cu });
    sigs.push(r);
    return r.signature;
  };
  const report = await runKeeper({ reader: connectionReader(connection), payer: addr(deployer), newSigner: async () => { throw new Error('no graduation expected'); }, send: sendKeeper, daily: true });
  return { txs: sigs, steps: report.steps, notes: report.notes, failed: report.results.filter((r) => !r.ok) };
});

def('rewards-round', async () => {
  const A = await coinOf(CITIES.A);
  const rw = await S.fetchRewards(connection, A);
  const pot = await tokenBal(A.holdersPot);
  const total = rw.vaultBalance - (rw.config.totalToHolders - rw.config.totalClaimed) + rw.config.carryOver + pot;
  const rules = { ...ROUND_RULES, minPayout: TVIC, minHolders: 1 }; // devnet: 1 tVIC minimum, any number of holders
  const r = await prepareRound(connection, A.mint, { total, rules });
  if (!r.round.fundable) throw new Error(r.round.reason);
  const ixs = S.buildFundRound({ authority: addr(deployer), coin: A, rewardsConfig: rw.config, round: { root: r.file.tree.root, numLeaves: r.round.leaves.length, slot: BigInt(r.slot), snapshotHash: r.file.hash } });
  const t1 = await tx('forward the holders pot + fund_epoch_from_vault (a rewards round)', { payer: deployer, ixs, cuLimit: 200_000 });
  const leaves = r.round.leaves.map((l) => ({ claimant: String(l.claimant), amount: String(l.amount) }));
  const signerFor = { [addr(k.trader1)]: k.trader1, [addr(k.trader2)]: k.trader2 };
  const claims = [];
  for (let i = 0; i < r.round.leaves.length; i++) {
    const who = signerFor[String(r.round.leaves[i].claimant)];
    if (!who) continue;
    claims.push(await tx(`claim leaf ${i} by ${String(r.round.leaves[i].claimant).slice(0, 6)}…`, { payer: who, ixs: S.buildClaim({ claimant: addr(who), coin: A, epochIndex: rw.config.epochCount, tree: r.file.tree, leafIndex: i }), cuLimit: 120_000 }));
  }
  return {
    txs: [t1, ...claims], epochIndex: String(rw.config.epochCount), epoch: R.epoch(R.city(A.mint), rw.config.epochCount), total: String(total), leaves,
    merkleRoot: Buffer.from(r.file.tree.root).toString('hex'), snapshotHash: Buffer.from(r.file.hash).toString('hex'), slot: r.slot,
    excluded: r.excluded.map((e) => ({ owner: e.owner, reason: e.reason })),
  };
});

def('push-to-holders', async () => {
  // "send to all holders": 1,000 tVIC to every holder of DEMO the snapshot counts, from the deployer's own account
  const A = await coinOf(CITIES.A);
  const r = await prepareRound(connection, A.mint, { total: 1_000_000n * TVIC, rules: { ...ROUND_RULES, minPayout: 1n, minHolders: 0 } }); // only the holder list is used
  const recipients = r.eligible.map((e) => ({ owner: e.owner, amount: 1_000n * TVIC }));
  const plan = S.buildAirdropBatches({ sender: addr(deployer), mint: TVIC_MINT, decimals: 6, recipients });
  const txs = [];
  for (const b of plan.batches) txs.push(await tx(`push batch ${b.index + 1}/${plan.batches.length} (${b.recipients.length} holders)`, { payer: deployer, ixs: b.instructions, cuLimit: b.cuLimit }));
  return { txs, recipients: recipients.map((x) => ({ owner: x.owner, amount: String(x.amount) })), batches: plan.batches.length };
});

def('founder-claim', async () => {
  const A = await coinOf(CITIES.A);
  const owed = await tokenBal(A.founderVault);
  const t = await tx('claim_founder_fees DEMO (founder A, paid in tVIC)', { payer: k.founderA, ixs: S.buildFounderClaim({ founder: addr(k.founderA), coin: A }), cuLimit: 100_000 });
  return { txs: [t], claimed: String(owed) };
});

def('payout', async () => {
  const B = await coinOf(CITIES.B);
  const txs = [];
  // the city of DEMOT has fees from the coin-to-coin buy: harvest them into its founder vault
  txs.push(await tx('harvest_curve_fees DEMOT', { payer: deployer, ixs: [C.harvestCurveFees({ payer: addr(deployer), coin: B })], cuLimit: 200_000 }));
  txs.push(await tx('set_payout_config (payout key + the one payout wallet)', { payer: deployer, ixs: [C.setPayoutConfig({ admin: addr(deployer), payoutAuthority: addr(k.payoutAuthority), payoutDestination: addr(k.payoutWallet) })] }));
  const ref = S.refHash('devnet-demo-partner-customer-0001', Buffer.from('vicinity-devnet-demo-salt-0001'));
  txs.push(await tx('opt_in_payout (founder B, signed, revocable)', { payer: k.founderB, ixs: [S.buildOptIn({ founder: addr(k.founderB), cityId: B.cityId, expectedDestination: addr(k.payoutWallet), ref })] }));
  const lp = await S.fetchLaunchpad(connection);
  const { candidates } = await S.loadPayoutCandidates(connection);
  const plan = S.planPayouts({ launchpad: lp, candidates, now: BigInt(Math.floor(Date.now() / 1000)), payoutAuthority: addr(k.payoutAuthority) });
  const vault = await tokenBal(B.founderVault);
  txs.push(await tx('payout_founder_fees (payout key -> the fixed payout wallet only)', { payer: k.payoutAuthority, ixs: [S.buildPayout({ payoutAuthority: addr(k.payoutAuthority), coin: B, destination: addr(k.payoutWallet) })], cuLimit: 100_000 }));
  const received = await tokenBal(S.payoutReceivingAccount(addr(k.payoutWallet), TVIC_MINT));
  // a second payout within 24 hours is refused (simulated, nothing sent)
  const again = await simulate(connection, { payer: k.payoutAuthority, ixs: [S.buildPayout({ payoutAuthority: addr(k.payoutAuthority), coin: B, destination: addr(k.payoutWallet) })] });
  txs.push(await tx('revoke_payout_opt_in (founder B)', { payer: k.founderB, ixs: [S.buildRevokeOptIn({ founder: addr(k.founderB), cityId: B.cityId })] }));
  txs.push(await tx('set_payout_config(zero, zero): payouts switched off again', { payer: deployer, ixs: [C.setPayoutConfig({ admin: addr(deployer), payoutAuthority: PROGRAM_IDS.system, payoutDestination: PROGRAM_IDS.system })] }));
  return {
    txs, planned: plan.map((d) => ({ ...d, cityId: String(d.cityId), amount: String(d.amount) })), vaultPaid: String(vault), payoutWalletReceived: String(received),
    refHash: Buffer.from(ref).toString('hex'), secondPayoutWithin24h: { err: again.err, logs: again.logs },
  };
});

def('sweep', async () => {
  const txs = [];
  for (const kp of [k.founderA, k.founderB, k.trader1, k.trader2, k.payoutAuthority]) {
    const bal = await lamportsOf(addr(kp));
    if (bal <= 10_000n) continue;
    txs.push(await tx(`return leftover SOL from ${addr(kp).slice(0, 6)}… to the deployer`, { payer: kp, ixs: [S.fromWeb3Instruction(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: deployer.publicKey, lamports: bal - 5_000n }))], cuLimit: 10_000 }));
  }
  return { txs, deployerBalance: String(await lamportsOf(addr(deployer))) };
});

// ------------------------------------------------------------------ run
let started = !args.from;
for (const name of order) {
  if (args.from === name) started = true;
  if (!started || (args.only && !args.only.includes(name))) continue;
  if (state.steps[name]?.done && !args.only) { console.log(`= ${name}: done before`); continue; }
  console.log(`> ${name}`);
  const before = await lamportsOf(addr(deployer));
  const r = await steps[name]();
  state.steps[name] = { done: true, at: new Date().toISOString(), deployerSpent: String(before - (await lamportsOf(addr(deployer)))), ...r };
  save();
}
console.log(json({ cluster, addresses: state.addresses, steps: Object.keys(state.steps) }));
