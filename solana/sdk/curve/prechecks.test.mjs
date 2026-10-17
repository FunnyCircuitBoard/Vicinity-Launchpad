// sdk/curve/prechecks.mjs and sdk/curve/rewards.mjs without a chain: the
// 14.3 pre-checks on account snapshots (each refusal, each edge), the
// vicinity_rewards init_city builder against Anchor's own encoder and the
// committed vicinity_rewards IDL, and initRewardsForCoin over a fake chain
// (every reason a config would be refused, an existing correct or wrong
// config, a failed simulation, simulateWithConnection over a fake
// Connection). tests-curve/21-sdk-prechecks.test.mjs checks the same
// predictions against the real programs in litesvm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import anchorPkg from '@coral-xyz/anchor';
import web3 from '@solana/web3.js';
import * as S from './index.mjs';

const { BorshCoder } = anchorPkg;
const here = dirname(fileURLToPath(import.meta.url));
const rewardsIdl = JSON.parse(readFileSync(join(here, '..', 'idl', 'vicinity_rewards.json'), 'utf8'));
const key = () => web3.Keypair.generate().publicKey.toBase58();
const RENT0 = 890_880n;
const sys = (lamports, data = 0) => ({ owner: S.ADDRESSES.system, lamports: BigInt(lamports), data: new Uint8Array(data) });
const code = (fn) => { try { fn(); } catch (e) { if (e instanceof S.PrecheckError) return e.code; throw e; } return null; };
/** A Jupiter quote from some token to native SOL (the only shape buyWithSwap takes, review SDK4-5). */
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const swapQuote = (q) => ({ inputMint: BONK, outputMint: S.ADDRESSES.nativeMint, ...q });

/** A decoded coin on default config #0 after one 1-SOL buy (founder_pending > 0). */
function sampleCoin() {
  const t = S.DEFAULT_TERMS;
  const q = S.quoteBuy(t, S.stateAtLaunch(0n), 1_000_000_000n);
  return { ...t, ...q.newState, mint: key(), founder: key(), cityId: 1n };
}

test('14.3 condition 1: the buyer must be a system-owned account without data that can pay', () => {
  assert.equal(code(() => S.precheckBuyer({ userAccount: sys(2_000_000_000n), charged: 1_000_000_000n })), null);
  assert.equal(code(() => S.precheckBuyer({ userAccount: null, charged: 1n })), 'BuyerHoldsNoSol');
  assert.equal(code(() => S.precheckBuyer({ userAccount: sys(0n), charged: 1n })), 'BuyerHoldsNoSol');
  assert.equal(code(() => S.precheckBuyer({ userAccount: { owner: key(), lamports: 5_000_000_000n, data: new Uint8Array(0) }, charged: 1n })), 'BuyerNotSystemAccount');
  assert.equal(code(() => S.precheckBuyer({ userAccount: { owner: S.ADDRESSES.token, lamports: 5_000_000_000n, data: new Uint8Array(165) }, charged: 1n })), 'BuyerNotSystemAccount');
  assert.equal(code(() => S.precheckBuyer({ userAccount: sys(5_000_000_000n, 8), charged: 1n })), 'BuyerCarriesData', 'a router PDA with data');
  assert.equal(code(() => S.precheckBuyer({ userAccount: sys(1_000_000_000n), charged: 1_000_000_000n, extraLamports: 1n })), 'BuyerCannotPay');
  // condition 3: what is left is 0 or at least rent_min(0)
  assert.equal(code(() => S.precheckBuyer({ userAccount: sys(1_000_000_000n), charged: 1_000_000_000n, rentExemptMinimum: RENT0 })), null, 'everything spent: the account closes');
  assert.equal(code(() => S.precheckBuyer({ userAccount: sys(1_000_000_000n), charged: 1_000_000_000n - RENT0, rentExemptMinimum: RENT0 })), null, 'exactly the minimum left');
  assert.equal(code(() => S.precheckBuyer({ userAccount: sys(1_000_000_000n), charged: 1_000_000_000n - RENT0 + 1n, rentExemptMinimum: RENT0 })), 'BuyerLeftBelowRent');
  assert.equal(code(() => S.precheckBuyer({ userAccount: sys(1_000_000_000n), charged: 1_000_000_000n - 1n, rentExemptMinimum: RENT0 })), 'BuyerLeftBelowRent');
  // precheckBuy quotes first (the math refuses what the program refuses), then checks the buyer
  const c = sampleCoin();
  const q = S.precheckBuy({ coin: c, userAccount: sys(10_000_000_000n), solIn: 1_000_000_000n, firstBuyRent: 2_039_280n, rentExemptMinimum: RENT0 });
  assert.equal(q.charged, 1_000_000_000n);
  assert.throws(() => S.precheckBuy({ coin: c, userAccount: sys(10_000_000_000n), solIn: 99_999n }), /TradeTooSmall/);
  assert.equal(code(() => S.precheckBuy({ coin: c, userAccount: sys(1_001_000_000n), solIn: 1_000_000_000n, firstBuyRent: 2_039_280n })), 'BuyerCannotPay');
});

test('14.3 condition 2: lamports(destination) > 0 or amount >= rent_min(0), for sells, claims and payouts', () => {
  const ok = (a, amount) => code(() => S.precheckSolCredit({ destinationAccount: a, amount, rentExemptMinimum: RENT0 }));
  assert.equal(ok(sys(1n), 1n), null, 'a funded account takes any amount');
  assert.equal(ok(null, RENT0), null, 'an empty account takes at least the minimum');
  assert.equal(ok(null, RENT0 - 1n), 'BelowRentExemptMinimum');
  assert.equal(ok(sys(0n), 1n), 'BelowRentExemptMinimum');
  assert.equal(ok(null, 0n), null, 'nothing to pay');
  const c = sampleCoin();
  // a sell's output
  const small = 10_000_000n;
  const qs = S.quoteSell(S.coinTerms(c), S.coinState(c), small);
  assert.ok(qs.solOut < RENT0);
  assert.equal(code(() => S.precheckSell({ coin: c, userAccount: null, tokensIn: small, rentExemptMinimum: RENT0 })), 'BelowRentExemptMinimum');
  assert.equal(S.precheckSell({ coin: c, userAccount: sys(1n), tokensIn: small, rentExemptMinimum: RENT0 }).solOut, qs.solOut);
  assert.throws(() => S.precheckSell({ coin: c, userAccount: sys(1n), tokensIn: 0n, rentExemptMinimum: RENT0 }), /ZeroAmount/);
  // a claim and a payout of founder_pending (5,000,000 lamports after 1 SOL at 0.5%)
  assert.equal(c.founderPending, 5_000_000n);
  assert.equal(S.precheckClaim({ coin: c, founderAccount: null, rentExemptMinimum: RENT0 }), 5_000_000n);
  assert.equal(code(() => S.precheckClaim({ coin: c, founderAccount: null, rentExemptMinimum: 5_000_001n })), 'BelowRentExemptMinimum');
  assert.equal(code(() => S.precheckPayout({ coin: c, destinationAccount: sys(0n), rentExemptMinimum: 5_000_001n })), 'BelowRentExemptMinimum');
  assert.equal(S.precheckPayout({ coin: c, destinationAccount: sys(1n), rentExemptMinimum: 5_000_001n }), 5_000_000n);
});

test('init_city: the builder encodes exactly what Anchor encodes from the committed vicinity_rewards IDL, with its account table', () => {
  const coder = new BorshCoder(rewardsIdl);
  const def = rewardsIdl.instructions.find((i) => i.name === 'init_city');
  assert.deepEqual([...S.REWARDS_INIT_CITY_DISCRIMINATOR], def.discriminator);
  assert.deepEqual(rewardsIdl.types.find((t) => t.name === 'RewardModel').type.variants.map((v) => v.name), Object.keys(S.REWARD_MODELS));
  const p = { payer: key(), registryAdmin: key(), authority: key(), founder: key(), mint: key() };
  for (const [model, bps] of [['Holders', 0], ['Creator', 10_000], ['Split', 2_500]]) {
    const tag = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const ix = S.initCityInstruction({ ...p, rewardModel: model, founderBps: bps, cityTag: tag });
    const want = coder.instruction.encode('init_city', { reward_model: { [model]: {} }, founder_bps: bps, city_tag: [...tag] });
    assert.deepEqual(Buffer.from(ix.data), Buffer.from(want), `${model} data`);
    assert.deepEqual(ix.accounts.map((a) => [a.role >= 2, a.role === 1 || a.role === 3]), def.accounts.map((a) => [!!a.signer, !!a.writable]), 'flags');
  }
  const ix = S.initCityInstruction(p);
  const a = S.rewardsCityAccounts({ mint: p.mint });
  assert.equal(ix.programAddress, S.CLUSTERS.mainnet.rewardsProgram);
  assert.deepEqual(ix.accounts.map((m) => m.address), [p.payer, p.registryAdmin, a.registry, p.authority, p.founder, p.mint, S.ADDRESSES.nativeMint, a.config, a.vault, S.ADDRESSES.token, S.ADDRESSES.system]);
  const P = S.curvePdas({});
  assert.deepEqual([a.config, a.vault], [P.rewardsAccounts(p.mint).config, P.rewardsAccounts(p.mint).vault]);
  assert.equal(S.initCityInstruction({ ...p, cluster: 'devnet' }).programAddress, S.CLUSTERS.devnet.rewardsProgram);
});

/** CityConfig bytes as vicinity_rewards writes them (the fields the program reads, 4.15). */
function cityConfigBytes({ authority, pending = S.ADDRESSES.system, founder, mint, rewardMint = S.ADDRESSES.nativeMint, vault, model = 1, founderBps = 0 }) {
  const b = Buffer.alloc(240);
  Buffer.from(S.REWARDS_CITY_CONFIG_DISCRIMINATOR).copy(b, 0);
  for (const [k, at] of [[authority, 8], [pending, 40], [founder, 72], [mint, 104], [rewardMint, 136], [vault, 168]]) new web3.PublicKey(k).toBuffer().copy(b, at);
  b[200] = model; b.writeUInt16LE(founderBps, 201);
  return b;
}

test('initRewardsForCoin proposes only a config forward_holders_fees accepts; it refuses every wrong one before proposing, and reports an existing wrong one as unfixable', async () => {
  const admin = key(); const coin = { mint: key(), founder: key() };
  const { config, vault } = S.rewardsCityAccounts({ mint: coin.mint });
  const rewardsProgram = S.CLUSTERS.mainnet.rewardsProgram;
  const chain = new Map();
  const getAccount = async (k) => chain.get(String(k)) ?? null;
  // a fake vicinity_rewards: init_city writes what its arguments and accounts say
  const simulate = async (ixs, addresses) => {
    assert.deepEqual(addresses, [config]);
    const ix = ixs[0];
    const models = Object.keys(S.REWARD_MODELS);
    const acc = (i) => ix.accounts[i].address;
    const data = cityConfigBytes({ authority: acc(3), founder: acc(4), mint: acc(5), rewardMint: acc(6), vault: acc(8), model: ix.data[8], founderBps: ix.data[9] | (ix.data[10] << 8) });
    assert.ok(models[ix.data[8]]);
    return { ok: true, account: (k) => (String(k) === config ? { owner: rewardsProgram, lamports: 1n, data } : null) };
  };
  const base = { getAccount, simulate, payer: key(), registryAdmin: admin, authority: admin, coin, admin };
  const r = await S.initRewardsForCoin(base);
  assert.equal(r.instructions.length, 1); assert.equal(r.already, false);
  assert.deepEqual([r.config, r.vault, r.view.authority, r.view.rewardModel, r.view.founderBps], [config, vault, admin, 1, 0]);
  const refused = async (o, problem) => {
    await assert.rejects(() => S.initRewardsForCoin({ ...base, ...o }), (e) => e instanceof S.RewardsConfigError && e.code === 'WouldBeWrong' && e.problems.some((p) => p.includes(problem)));
  };
  await refused({ rewardModel: 'Creator', founderBps: 10_000 }, 'model is not Holders');
  await refused({ rewardModel: 'Split', founderBps: 2_500 }, 'founder_bps is not 0');
  await refused({ rewardModel: 'Holders', founderBps: 1 }, 'founder_bps is not 0');
  await refused({ rewardMint: key() }, 'reward mint is not WSOL');
  await refused({ authority: key() }, 'authority is not the vicinity_curve admin');
  // the admin by default comes from the Launchpad account
  const lpData = Buffer.alloc(S.ACCOUNT_LEN.Launchpad); Buffer.from(S.ACCOUNT_DISCRIMINATORS.Launchpad).copy(lpData, 0); new web3.PublicKey(admin).toBuffer().copy(lpData, 8);
  chain.set(S.curvePdas({}).launchpad(), { owner: S.CURVE_PROGRAM_ID, lamports: 1n, data: lpData });
  assert.equal((await S.initRewardsForCoin({ ...base, admin: undefined })).instructions.length, 1);
  await assert.rejects(() => S.initRewardsForCoin({ ...base, admin: undefined, authority: key() }), /authority is not the vicinity_curve admin/);
  // a failed simulation is refused
  await assert.rejects(() => S.initRewardsForCoin({ ...base, simulate: async () => ({ ok: false, error: 'custom program error: 0x1782' }) }), (e) => e.code === 'SimulationFailed');
  // an existing config: a correct one needs nothing, a wrong one can never be fixed
  chain.set(config, { owner: rewardsProgram, lamports: 1n, data: cityConfigBytes({ authority: admin, founder: coin.founder, mint: coin.mint, vault }) });
  const again = await S.initRewardsForCoin(base);
  assert.deepEqual([again.instructions.length, again.already], [0, true]);
  chain.set(config, { owner: rewardsProgram, lamports: 1n, data: cityConfigBytes({ authority: admin, founder: coin.founder, mint: coin.mint, vault, model: 0, founderBps: 10_000 }) });
  await assert.rejects(() => S.initRewardsForCoin(base), (e) => e.code === 'ExistsWrong' && /can.?not change or close it/.test(e.message));
  // CLI-3: problems of the authority alone are fixable (propose_authority / accept_authority), never O26
  chain.set(config, { owner: rewardsProgram, lamports: 1n, data: cityConfigBytes({ authority: admin, pending: key(), founder: coin.founder, mint: coin.mint, vault }) });
  await assert.rejects(() => S.initRewardsForCoin(base), (e) => e.code === 'AuthorityNotAdmin' && e.fixable === true && e.problems.includes('an authority transfer is pending') && !/O26/.test(e.message));
  chain.set(config, { owner: rewardsProgram, lamports: 1n, data: cityConfigBytes({ authority: key(), founder: coin.founder, mint: coin.mint, vault }) });
  await assert.rejects(() => S.initRewardsForCoin(base), (e) => e.code === 'AuthorityNotAdmin' && /propose_authority/.test(e.message));
  // wrong economics and a wrong authority together: unfixable
  chain.set(config, { owner: rewardsProgram, lamports: 1n, data: cityConfigBytes({ authority: key(), founder: coin.founder, mint: coin.mint, vault, model: 2, founderBps: 5_000 }) });
  await assert.rejects(() => S.initRewardsForCoin(base), (e) => e.code === 'ExistsWrong' && e.fixable === false && e.problems.includes('model is not Holders'));
  // an account owned by another program at the address is no CityConfig, and not an empty System account either
  chain.set(config, { owner: S.CLUSTERS.devnet.rewardsProgram, lamports: 1n, data: cityConfigBytes({ authority: admin, founder: coin.founder, mint: coin.mint, vault }) });
  await assert.rejects(() => S.initRewardsForCoin(base), (e) => e.code === 'NotACityConfig');
  chain.set(config, { owner: S.ADDRESSES.system, lamports: 1n, data: Buffer.alloc(8) });
  await assert.rejects(() => S.initRewardsForCoin(base), (e) => e.code === 'NotACityConfig');
});

test('CLI-3 initRewardsForCoin: lamports sent to the config address (a System account without data) are not a config; init_city is proposed as usual', async () => {
  const admin = key(); const coin = { mint: key(), founder: key() };
  const { config } = S.rewardsCityAccounts({ mint: coin.mint });
  const rewardsProgram = S.CLUSTERS.mainnet.rewardsProgram;
  let simulated = 0;
  const simulate = async (ixs) => {
    simulated++;
    const ix = ixs[0]; const acc = (i) => ix.accounts[i].address;
    const data = cityConfigBytes({ authority: acc(3), founder: acc(4), mint: acc(5), rewardMint: acc(6), vault: acc(8), model: ix.data[8], founderBps: ix.data[9] | (ix.data[10] << 8) });
    return { ok: true, account: (k) => (String(k) === config ? { owner: rewardsProgram, lamports: 890_880n, data } : null) };
  };
  for (const prefunded of [
    { owner: S.ADDRESSES.system, lamports: 890_880n, data: Buffer.alloc(0) }, // rent_min(0), the grief of the review
    { owner: S.ADDRESSES.system, lamports: 1n, data: new Uint8Array(0) },
    { programAddress: S.ADDRESSES.system, lamports: 5_000_000_000n, data: Buffer.alloc(0) }, // kit's shape
  ]) {
    const getAccount = async (k) => (String(k) === config ? prefunded : null);
    const r = await S.initRewardsForCoin({ getAccount, simulate, payer: key(), registryAdmin: admin, authority: admin, coin, admin });
    assert.deepEqual([r.instructions.length, r.already, r.view.authority], [1, false, admin]);
  }
  assert.equal(simulated, 3);
});

test('simulateWithConnection: a v0 transaction simulated without signatures, returning the accounts asked for', async () => {
  const config = key(); const payer = key();
  let seen;
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    simulateTransaction: async (tx, opts) => {
      seen = { tx, opts };
      return { value: { err: null, logs: [], accounts: [{ owner: S.CLUSTERS.mainnet.rewardsProgram, lamports: 7, data: [Buffer.from([1, 2, 3]).toString('base64'), 'base64'] }] } };
    },
  };
  const sim = S.simulateWithConnection(connection, { feePayer: payer });
  const ix = S.initCityInstruction({ payer, registryAdmin: key(), authority: key(), founder: key(), mint: key() });
  const r = await sim([ix], [config]);
  assert.equal(r.ok, true);
  assert.deepEqual([...r.account(config).data], [1, 2, 3]);
  assert.equal(r.account(config).lamports, 7n);
  assert.deepEqual([seen.opts.sigVerify, seen.opts.replaceRecentBlockhash, seen.opts.accounts.addresses], [false, true, [config]]);
  assert.equal(seen.tx.message.staticAccountKeys[0].toBase58(), payer);
  const failing = S.simulateWithConnection({ ...connection, simulateTransaction: async () => ({ value: { err: { InstructionError: [0, { Custom: 1 }] }, logs: ['x'] } }) }, { feePayer: payer });
  assert.equal((await failing([ix], [config])).ok, false);
});

test('pay with any token (14.1, G03): sol_in is the swap\'s guaranteed output, never the quoted one', () => {
  assert.equal(S.solInFromSwapQuote(swapQuote({ swapMode: 'ExactIn', outAmount: 2_000_000_000n, otherAmountThreshold: '1980000000' })), 1_980_000_000n);
  assert.equal(S.solInFromSwapQuote(swapQuote({ swapMode: 'ExactOut', outAmount: '2000000000', otherAmountThreshold: 9n })), 2_000_000_000n);
  assert.throws(() => S.solInFromSwapQuote(swapQuote({ swapMode: 'ExactIn', outAmount: 1n, otherAmountThreshold: 2n })), /above outAmount/);
  assert.throws(() => S.solInFromSwapQuote(swapQuote({})), /unknown swapMode/);
  const user = key(); const mint = key(); const coin = key();
  const swapIx = { programAddress: key(), accounts: [], data: new Uint8Array([1]) };
  const coinAccount = { ...S.DEFAULT_TERMS, ...S.stateAtLaunch(0n), mint };
  const given = S.withSlippage(S.quoteBuy(S.DEFAULT_TERMS, S.stateAtLaunch(0n), 400_000n).tokensOut, 100);
  const { instructions, solIn, minTokensOut, swapSolIn } = S.buyWithSwap({ ix: S.ix, user, coin, mint, swapInstructions: [swapIx], quote: swapQuote({ swapMode: 'ExactIn', outAmount: 500_000n, otherAmountThreshold: 400_000n }), coinAccount, minTokensOut: given });
  assert.equal(solIn, 400_000n);
  assert.equal(swapSolIn, 400_000n);
  assert.equal(minTokensOut, given);
  assert.deepEqual(instructions.map((x) => x.programAddress), [swapIx.programAddress, S.ADDRESSES.associatedToken, S.CURVE_PROGRAM_ID]);
  assert.equal(Buffer.from(instructions[2].data).readBigUInt64LE(8), 400_000n, 'the buy\'s sol_in');
  assert.equal(Buffer.from(instructions[2].data).readBigUInt64LE(16), given, 'the buy\'s min_tokens_out');
  assert.equal(instructions[2].accounts[5].address, S.associatedTokenAddress(user, mint));
});

test('CLI-1 pay with any token: buyWithSwap never builds a buy without its own minimum (14.1)', () => {
  const user = key(); const coinKey = key();
  const swapIx = { programAddress: key(), accounts: [], data: new Uint8Array([1]) };
  // 0.35 SOL: below config #0's sandwich threshold at launch (0.39 SOL), so up to 5% is allowed (MATH3-1, SDK4-4)
  const quote = swapQuote({ swapMode: 'ExactIn', outAmount: 354_000_000n, otherAmountThreshold: 350_000_000n });
  // a coin snapshot at launch on config #0
  const coin = { ...S.DEFAULT_TERMS, ...S.stateAtLaunch(1000n), mint: key() };
  const base = { ix: S.ix, user, coin: coinKey, mint: coin.mint, swapInstructions: [swapIx], quote };
  // the default the review found: no minimum at all (it used to encode min_tokens_out = 0)
  assert.throws(() => S.buyWithSwap(base), (e) => e instanceof S.ComposeError && /needs its own minimum/.test(e.message));
  assert.throws(() => S.buyWithSwap({ ...base, minTokensOut: 0n }), /at least 1/);
  assert.throws(() => S.buyWithSwap({ ...base, minTokensOut: 5n, slippageBps: 100 }), /not both/);
  assert.throws(() => S.buyWithSwap({ ...base, slippageBps: 100 }), /needs coinAccount/);
  assert.throws(() => S.buyWithSwap({ ...base, coinAccount: coin, slippageBps: S.MAX_SWAP_SLIPPAGE_BPS + 1 }), /0 to 500/);
  assert.throws(() => S.buyWithSwap({ ...base, coinAccount: coin, slippageBps: 1.5 }), /integer/);
  assert.throws(() => S.buyWithSwap({ ...base, mint: key(), coinAccount: coin, slippageBps: 100 }), /not .*mint|coin of mint/);
  // from the snapshot: the quote of the guaranteed sol_in, less the slippage
  const q = S.quoteBuy(S.coinTerms(coin), S.coinState(coin), 350_000_000n);
  for (const bps of [0, 100, 200, 500]) {
    const r = S.buyWithSwap({ ...base, coinAccount: coin, slippageBps: bps });
    assert.equal(r.minTokensOut, S.withSlippage(q.tokensOut, bps));
    assert.equal(Buffer.from(r.instructions.at(-1).data).readBigUInt64LE(16), r.minTokensOut, `${bps} bps encoded`);
    assert.ok(r.minTokensOut > 0n);
  }
});

test('R3-CLI-1 a buy that completes the curve offers only its charge: buyLeg caps sol_in at the partial quote\'s charge (max_quote_in) and takes the minimum from that quote; buyLegMinimum refuses the uncapped pair', () => {
  const t = S.DEFAULT_TERMS;
  const st = S.quoteBuy(t, S.stateAtLaunch(0n), S.grossFor(t, 84n * 10n ** 9n)).newState;
  const coin = { ...t, ...st, mint: key() };
  const solIn = 20n * 10n ** 9n;
  const q = S.quoteBuy(t, st, solIn);
  assert.deepEqual([q.partial, q.graduates], [true, true]);
  const leg = S.buyLeg({ solIn, coinAccount: coin, slippageBps: 200 });
  assert.equal(leg.solIn, q.charged, 'capped at the charge');
  assert.equal(leg.solIn, S.maxQuoteIn(t, st), '= max_quote_in');
  assert.equal(leg.minTokensOut, S.withSlippage(q.tokensOut, 200), 'the minimum of the same quote');
  assert.deepEqual([leg.quote.partial, leg.quote.graduates, leg.quote.tokensOut, leg.quote.charged], [false, true, q.tokensOut, q.charged]);
  // with an explicit minimum the cap applies too
  assert.equal(S.buyLeg({ solIn, coinAccount: coin, minTokensOut: S.withSlippage(q.tokensOut, 100) }).solIn, q.charged);
  // buyLegMinimum: the uncapped sol_in is refused, the capped one accepted
  assert.throws(() => S.buyLegMinimum({ solIn, coinAccount: coin, slippageBps: 200 }), (e) => e instanceof S.ComposeError && /completes the curve/.test(e.message) && e.message.includes(String(q.charged)));
  assert.equal(S.buyLegMinimum({ solIn: q.charged, coinAccount: coin, slippageBps: 200 }), leg.minTokensOut);
  // buyWithSwap: the buy offers the charge, the swap still delivers its 20 SOL (the rest stays in the wallet)
  const user = key();
  const r = S.buyWithSwap({ ix: S.ix, user, coin: key(), mint: coin.mint, swapInstructions: [], quote: swapQuote({ swapMode: 'ExactOut', outAmount: solIn, otherAmountThreshold: solIn * 2n }), coinAccount: coin, slippageBps: 200 });
  assert.deepEqual([r.solIn, r.swapSolIn, r.minTokensOut], [q.charged, solIn, leg.minTokensOut]);
  const data = Buffer.from(r.instructions.at(-1).data);
  assert.deepEqual([data.readBigUInt64LE(8), data.readBigUInt64LE(16)], [q.charged, leg.minTokensOut]);
  // below the remainder, and in the pool, nothing is capped
  for (const [label, state, amount] of [['a buy below the remainder', st, 10n ** 9n / 2n], ['a pool buy', S.quoteBuy(t, st, solIn).newState, 10n ** 9n]]) {
    const c = { ...t, ...state, mint: coin.mint };
    const l = S.buyLeg({ solIn: amount, coinAccount: c, slippageBps: 100 });
    assert.equal(l.solIn, amount, label);
    assert.equal(S.buyLegMinimum({ solIn: amount, coinAccount: c, slippageBps: 100 }), l.minTokensOut, label);
  }
  // the cap reads the coin: coinAccount is required, also with an explicit minimum
  assert.throws(() => S.buyLeg({ solIn, minTokensOut: 5n }), /needs coinAccount/);
});

test('MATH3-1 the buy leg\'s slippage depends on its size: at most 5% up to the coin\'s sandwich threshold, at most 0.3% above it, for a minimum given or derived; the threshold is the cheapest credited attacker\'s', () => {
  const t = S.DEFAULT_TERMS;
  const st0 = S.stateAtLaunch(0n);
  const coin = { ...t, ...st0, mint: key() };
  // config #0: t - max(b_F + b_H, b_P) = 250 - 100 = 150 bps, less one buyback run's 2t/C = 20 bps (SDK4-4): 130 bps
  // of the depth (x0 at launch: 0.39 SOL)
  assert.equal(S.cheapestAttackerCostBps(t), 150n);
  assert.equal(S.buybackRunMarginBps(t), 20n);
  assert.equal(S.sandwichCostBps(t), 130n);
  const thr = S.sandwichThreshold(t, st0);
  assert.equal(thr, (t.virtualSol * 130n) / 10_000n);
  assert.equal(thr, 390_011_097n);
  // the review's case: a 1 SOL buy at the website's 1% or 2% is refused, 0.3% is built
  for (const bps of [100, 200, S.LARGE_BUY_MAX_SLIPPAGE_BPS + 1]) {
    assert.throws(() => S.buyLeg({ solIn: 1_000_000_000n, coinAccount: coin, slippageBps: bps }), (e) => e instanceof S.ComposeError && /sandwich threshold/.test(e.message) && e.message.includes(String(thr)));
  }
  const q1 = S.quoteBuy(t, st0, 1_000_000_000n);
  const big = S.buyLeg({ solIn: 1_000_000_000n, coinAccount: coin, slippageBps: S.LARGE_BUY_MAX_SLIPPAGE_BPS });
  assert.deepEqual([big.large, big.threshold, big.minTokensOut], [true, thr, S.withSlippage(q1.tokensOut, 30)]);
  // a given minimum is judged the same way (its slippage rounded up)
  assert.throws(() => S.buyLeg({ solIn: 1_000_000_000n, coinAccount: coin, minTokensOut: S.withSlippage(q1.tokensOut, 100) }), /sandwich threshold/);
  assert.throws(() => S.buyLeg({ solIn: 1_000_000_000n, coinAccount: coin, minTokensOut: S.withSlippage(q1.tokensOut, 30) - 1n }), /sandwich threshold/);
  assert.equal(S.buyLeg({ solIn: 1_000_000_000n, coinAccount: coin, minTokensOut: S.withSlippage(q1.tokensOut, 30) }).minTokensOut, S.withSlippage(q1.tokensOut, 30));
  assert.equal(S.buyLeg({ solIn: 1_000_000_000n, coinAccount: coin, minTokensOut: q1.tokensOut + 5n }).minTokensOut, q1.tokensOut + 5n, 'a minimum above the quote allows no slippage');
  // and so is buyWithSwap
  assert.throws(() => S.buyWithSwap({ ix: S.ix, user: key(), coin: key(), mint: coin.mint, swapInstructions: [], quote: swapQuote({ swapMode: 'ExactOut', outAmount: 1_000_000_000n, otherAmountThreshold: 2_000_000_000n }), coinAccount: coin, slippageBps: 100 }), /sandwich threshold/);
  // at the threshold up to 5%; one lamport above it, 0.3%
  const at = S.buyLeg({ solIn: thr, coinAccount: coin, slippageBps: S.MAX_SWAP_SLIPPAGE_BPS });
  assert.equal(at.large, false);
  assert.throws(() => S.buyLeg({ solIn: thr + 1n, coinAccount: coin, slippageBps: 31 }), /sandwich threshold/);
  // the website's default (14.1)
  assert.deepEqual(S.buySlippagePolicy(coin, thr), { maxSlippageBps: 500, defaultSlippageBps: 100, threshold: thr, charged: thr, large: false });
  const p1 = S.buySlippagePolicy(coin, 1_000_000_000n);
  assert.deepEqual([p1.maxSlippageBps, p1.defaultSlippageBps, p1.large], [30, 30, true]);
  // the threshold follows the depth: 40 SOL raised (70 SOL deep), a fresh pool (85 SOL deep)
  const st40 = S.quoteBuy(t, st0, S.grossFor(t, 40n * 10n ** 9n)).newState;
  assert.equal(S.sandwichThreshold(t, st40), (S.depth(t, st40) * 130n) / 10_000n);
  assert.equal(S.sandwichThreshold(t, st40), 910_011_097n);
  const pool = S.quoteBuy(t, st0, S.maxQuoteIn(t, st0)).newState;
  assert.equal(S.sandwichThreshold(t, pool), 1_105_000_000n);
  // the cheapest attacker under other configs: the platform's key (review HR-1), a founder holding the float (R3-DIFF-1)
  const cfg = (l, p, f, h, b) => S.termsFromParams({ ...S.DEFAULT_CONFIG, liquidityBps: l, platformBps: p, founderBps: f, holdersBps: h, buybackBps: b });
  assert.equal(S.cheapestAttackerCostBps(cfg(0n, 120n, 0n, 1n, 1n)), 2n);
  assert.equal(S.cheapestAttackerCostBps(cfg(0n, 1n, 50n, 50n, 0n)), 1n);
  assert.equal(S.cheapestAttackerCostBps(cfg(0n, 1n, 0n, 0n, 0n)), 0n, 'X44\'s platform-only 0.01% config: the platform\'s key trades for free');
  const free = { ...cfg(0n, 1n, 0n, 0n, 0n), ...st0, mint: coin.mint };
  assert.equal(S.sandwichThreshold(S.coinTerms(free), st0), 0n);
  assert.equal(S.buyLeg({ solIn: S.MIN_TRADE_LAMPORTS, coinAccount: free, slippageBps: 30 }).large, true, 'every buy is above a threshold of 0');
});

// ---------------------------------------------------------------- review round 4
const L = 1_000_000_000n;
const T0 = S.DEFAULT_TERMS;
/** The state after one buy that leaves about `rem` lamports before graduation (the actual remainder may differ by a few lamports). */
const stateNearEnd = (rem) => S.quoteBuy(T0, S.stateAtLaunch(0n), S.grossFor(T0, T0.graduationSol - rem)).newState;
const remOf = (st) => T0.graduationSol - st.curveSol;

test('R4-DIFF-1, SM-1, SDK4-1 near graduation every SDK buy works: buyLeg caps sol_in at max_quote_in (at least MIN_TRADE_LAMPORTS), and the capped buy may stay a partial fill of the last raw units', () => {
  // rem 1: the state a curve buyback leaves (s = S - 1, r = f(S - 1) = R - 1; 5.4, X23, I22)
  const sEnd = T0.curveSupply - 1n;
  const states = [{ ...S.stateAtLaunch(0n), tokensSold: sEnd, curveSol: S.curveValue(T0, sEnd) }];
  for (const rem of [1_000n, 50_000n, 97_000n, 97_400n, 97_499n, 97_500n, 97_600n, 200_000n]) states.push(stateNearEnd(rem));
  assert.equal(remOf(states[0]), 1n, 'the buyback\'s end state is 1 lamport short of graduation');
  for (const st of states) {
    const rem = remOf(st);
    const coin = { ...T0, ...st, mint: key() };
    const mqi = S.maxQuoteIn(T0, st);
    const lastUnits = S.grossFor(T0, rem) < S.MIN_TRADE_LAMPORTS;
    assert.equal(mqi, lastUnits ? S.MIN_TRADE_LAMPORTS : S.grossFor(T0, rem), `rem ${rem}: max_quote_in (5.4)`);
    for (const solIn of [S.MIN_TRADE_LAMPORTS, mqi, L, 20n * L]) {
      const q = S.quoteBuy(T0, st, solIn);
      if (!q.partial) continue; // only at rem 97,500 and MIN_TRADE_LAMPORTS: an exact fill, nothing to cap
      for (const bps of [0, 100, 500]) {
        const leg = S.buyLeg({ solIn, coinAccount: coin, slippageBps: bps });
        assert.equal(leg.solIn, mqi, `rem ${rem}, ${solIn}: capped at max_quote_in`);
        assert.deepEqual(leg.quote, S.quoteBuy(T0, st, mqi), 'the quote of max_quote_in');
        assert.ok(leg.quote.graduates && leg.quote.charged <= mqi && leg.quote.charged >= q.charged);
        assert.equal(leg.quote.tokensOut, T0.curveSupply - st.tokensSold, 'the rest of the curve, S - s');
        if (!lastUnits) assert.equal(leg.quote.partial, false, 'an exact fill above MIN_TRADE_LAMPORTS (R3-CLI-1)');
        const want = S.withSlippage(leg.quote.tokensOut, bps);
        assert.equal(leg.minTokensOut, want < 1n ? 1n : want, 'the quote less the slippage, at least 1');
        assert.ok(leg.minTokensOut >= 1n && leg.minTokensOut <= leg.quote.tokensOut);
      }
      // an explicit minimum, buyLegMinimum at max_quote_in, buyWithSwap
      const exact = S.buyLeg({ solIn, coinAccount: coin, minTokensOut: T0.curveSupply - st.tokensSold });
      assert.deepEqual([exact.solIn, exact.minTokensOut], [mqi, T0.curveSupply - st.tokensSold], 'an explicit minimum of the whole rest');
      assert.equal(S.buyLegMinimum({ solIn: mqi, coinAccount: coin, slippageBps: 100 }), S.buyLeg({ solIn, coinAccount: coin, slippageBps: 100 }).minTokensOut);
      if (solIn !== mqi) assert.throws(() => S.buyLegMinimum({ solIn, coinAccount: coin, slippageBps: 100 }), /completes the curve/);
      const r = S.buyWithSwap({ ix: S.ix, user: key(), coin: key(), mint: coin.mint, swapInstructions: [], quote: swapQuote({ swapMode: 'ExactOut', outAmount: solIn, otherAmountThreshold: solIn }), coinAccount: coin, slippageBps: 100 });
      assert.deepEqual([r.solIn, r.swapSolIn], [mqi, solIn]);
      assert.equal(Buffer.from(r.instructions.at(-1).data).readBigUInt64LE(8), mqi, 'the buy offers max_quote_in');
    }
  }
  // the exposure the cap leaves: if someone graduates the coin first, the capped buy is charged at most MIN_TRADE_LAMPORTS in the pool
  const st = stateNearEnd(50_000n);
  const pool = S.quoteBuy(T0, st, S.maxQuoteIn(T0, st)).newState;
  const leg = S.buyLeg({ solIn: L, coinAccount: { ...T0, ...st, mint: key() }, slippageBps: 100 });
  const inPool = S.quoteBuy(T0, pool, leg.solIn);
  assert.equal(inPool.charged, S.MIN_TRADE_LAMPORTS);
  assert.ok(inPool.tokensOut >= leg.minTokensOut, 'and it still gets at least its minimum there (the pool opens at the curve\'s last price)');
});

test('R4-DIFF-3, SDK4-2 near graduation the threshold is judged at the depth of the pool the buy can be pushed into: min(x0 + curve_sol, graduation_sol)', () => {
  const st = stateNearEnd(1_700_000_000n); // 83.3 SOL raised: 113.3 SOL of curve depth, the pool opens at 85 SOL
  assert.equal(S.depth(T0, st), T0.virtualSol + st.curveSol);
  assert.equal(S.sandwichDepth(T0, st), T0.graduationSol);
  const thr = S.sandwichThreshold(T0, st);
  assert.equal(thr, (T0.graduationSol * 130n) / 10_000n);
  assert.equal(thr, 1_105_000_000n);
  // the review's victim: 1,699,512,804 lamports at 5% (the old curve-depth threshold at 150 bps) is now above the threshold
  const coin = { ...T0, ...st, mint: key() };
  const V = 1_699_512_804n;
  assert.equal(S.quoteBuy(T0, st, V).graduates, false, 'a buy that does not complete the curve');
  for (const bps of [500, 400, 100]) assert.throws(() => S.buyLeg({ solIn: V, coinAccount: coin, slippageBps: bps }), /sandwich threshold/);
  assert.equal(S.buyLeg({ solIn: V, coinAccount: coin, slippageBps: 30 }).large, true);
  assert.equal(S.buySlippagePolicy(coin, V).maxSlippageBps, 30);
  // far from graduation the curve depth is the smaller one and nothing changes
  const st40 = stateNearEnd(45n * L);
  assert.equal(S.sandwichDepth(T0, st40), S.depth(T0, st40));
  // the pool: pool_sol
  const pool = S.quoteBuy(T0, st, S.maxQuoteIn(T0, st)).newState;
  assert.equal(S.sandwichDepth(T0, pool), pool.poolSol);
  // the straddle (someone graduates the coin, the attacker buys in the new pool, the victim's curve-quoted buy runs
  // there, the attacker sells; or the attacker graduates the coin himself), in the model, which equals the program
  // (G01): at the old curve-depth threshold (150 bps of x0 + curve_sol) with 5% the founder holding the float
  // profits; at the new threshold no class profits at any remainder from 1.5 to 3 SOL
  const classes = { outsider: [], founder: ['founder'], founderFloat: ['founder', 'holders'], platform: ['platform'] };
  const credit = (legs, keys) => legs.reduce((x, q) => x + keys.reduce((y, k) => y + q.split[k], 0n), 0n);
  const bestStraddle = (s0, V, min) => {
    const grad = S.quoteBuy(T0, s0, S.maxQuoteIn(T0, s0));
    let best = null;
    for (const self of [false, true]) {
      for (const keys of Object.values(classes)) {
        for (let A = 10_000_000n; A < 20n * L; A += 10_000_000n) {
          const f = S.quoteBuy(T0, grad.newState, A);
          const v = S.quoteBuy(T0, f.newState, V);
          if (v.tokensOut < min) break;
          const b = S.quoteSell(T0, v.newState, self ? f.tokensOut + grad.tokensOut : f.tokensOut);
          const p = b.solOut - f.charged - (self ? grad.charged : 0n) + credit(self ? [grad, f, b] : [f, b], keys);
          if (best === null || p > best) best = p;
        }
      }
    }
    return best;
  };
  let oldProfits = 0;
  for (const rem of [1_500_000_000n, 1_700_000_000n, 2_000_000_000n, 2_500_000_000n, 3_000_000_000n]) {
    const s0 = stateNearEnd(rem);
    const c0 = { ...T0, ...s0, mint: key() };
    const leg = S.buyLeg({ solIn: S.sandwichThreshold(T0, s0), coinAccount: c0, slippageBps: 500 });
    const now = bestStraddle(s0, leg.solIn, leg.minTokensOut);
    assert.ok(now === null || now < 0n, `rem ${rem}: the best straddle at the new threshold loses (${now})`);
    const oldV = ((T0.virtualSol + s0.curveSol) * 150n) / 10_000n;
    const before = bestStraddle(s0, oldV, S.withSlippage(S.quoteBuy(T0, s0, oldV).tokensOut, 500));
    if (before !== null && before > 0n) oldProfits += 1;
  }
  assert.ok(oldProfits >= 3, `at the old threshold the straddle profits at most of these remainders (${oldProfits}; review R4-DIFF-3)`);
});

test('SDK4-4 one due buyback run inside the sandwich: the threshold\'s cost leaves 2t/C for it, and at the threshold with 5% every class loses with the run', () => {
  const cfg = (l, p, f, h, b) => S.termsFromParams({ ...S.DEFAULT_CONFIG, liquidityBps: l, platformBps: p, founderBps: f, holdersBps: h, buybackBps: b });
  assert.equal(S.buybackRunMarginBps(T0), 20n);
  assert.equal(S.buybackRunMarginBps(cfg(100n, 70n, 50n, 30n, 0n)), 0n, 'no buyback share, no run');
  assert.equal(S.sandwichCostBps(cfg(100n, 70n, 50n, 30n, 0n)), 170n, '250 - (50 + 30)');
  assert.equal(S.sandwichCostBps(cfg(0n, 120n, 0n, 1n, 1n)), 0n, 'never below 0');
  const classes = { outsider: [], founder: ['founder'], founderFloat: ['founder', 'holders'], platform: ['platform'] };
  const credit = (legs, keys) => legs.reduce((x, q) => x + keys.reduce((y, k) => y + q.split[k], 0n), 0n);
  let best = null; let bestOld = null;
  for (const raised of [0n, 40n, 'pool']) {
    let st = S.stateAtLaunch(0n);
    if (raised === 'pool') st = S.quoteBuy(T0, st, S.maxQuoteIn(T0, st)).newState;
    else if (raised > 0n) st = S.quoteBuy(T0, st, S.grossFor(T0, raised * L)).newState;
    // a 60 SOL round trip fills buyback_pending above one cap; a run is due
    const w = S.quoteBuy(T0, st, 60n * L); st = S.quoteSell(T0, w.newState, w.tokensOut).newState;
    for (const [label, V] of [['new', S.sandwichThreshold(T0, st)], ['old', (S.depth(T0, st) * S.cheapestAttackerCostBps(T0)) / 10_000n]]) {
      const min = S.withSlippage(S.quoteBuy(T0, st, V).tokensOut, 500);
      for (const keys of Object.values(classes)) {
        for (let A = 5_000_000n; A < 30n * L; A += 5_000_000n) {
          const f = S.quoteBuy(T0, st, A); if (f.graduates) break;
          const v = S.quoteBuy(T0, f.newState, V); if (v.tokensOut < min) break;
          const bb = S.quoteBuyback(T0, v.newState, v.newState.lastBuybackSlot + S.BUYBACK_INTERVAL_SLOTS);
          assert.ok(bb && bb.spent > 0n, 'the run is due');
          const b = S.quoteSell(T0, bb.newState, f.tokensOut);
          const p = b.solOut - f.charged + credit([f, b], keys);
          if (label === 'new' && (best === null || p > best)) best = p;
          if (label === 'old' && (bestOld === null || p > bestOld)) bestOld = p;
        }
      }
    }
  }
  assert.ok(bestOld > 0n, `at the old 150 bps threshold the founder holding the float profits with the run (${bestOld}, review SDK4-4)`);
  assert.ok(best < 0n, `at the new threshold every class loses (${best})`);
});

test('R4-DIFF-5, SDK4-3 the sell leg: the buy rule on the sell\'s gross (5% at or below the threshold, 0.3% above it), for a minimum given or derived', () => {
  const st = stateNearEnd(25n * L); // 60 SOL raised: the threshold is 1.3% of min(90, 85) SOL
  const coin = { ...T0, ...st, mint: key() };
  const thr = S.sandwichThreshold(T0, st);
  assert.equal(thr, 1_105_000_000n);
  // the review's victim: coins worth about 4.4 SOL gross, sold at the buy default of 1%
  const tokens = S.quoteBuy(T0, stateNearEnd(30n * L), S.grossFor(T0, 4_400_000_000n)).tokensOut;
  const q = S.quoteSell(T0, st, tokens);
  assert.ok(q.gross > thr);
  for (const bps of [100, 200, 31]) assert.throws(() => S.sellLeg({ tokensIn: tokens, coinAccount: coin, slippageBps: bps }), (e) => e instanceof S.ComposeError && /sandwich threshold/.test(e.message) && e.message.includes(String(thr)) && /sell/.test(e.message));
  const leg = S.sellLeg({ tokensIn: tokens, coinAccount: coin, slippageBps: 30 });
  assert.deepEqual([leg.tokensIn, leg.minSolOut, leg.large, leg.threshold], [tokens, S.withSlippage(q.solOut, 30), true, thr]);
  assert.throws(() => S.sellLeg({ tokensIn: tokens, coinAccount: coin, minSolOut: S.withSlippage(q.solOut, 100) }), /sandwich threshold/);
  assert.equal(S.sellLeg({ tokensIn: tokens, coinAccount: coin, minSolOut: S.withSlippage(q.solOut, 30) }).minSolOut, S.withSlippage(q.solOut, 30));
  // a sell at or below the threshold may allow 5%
  let small = tokens / 4n; while (S.quoteSell(T0, st, small).gross > thr) small -= small / 50n;
  const sq = S.quoteSell(T0, st, small);
  const sl = S.sellLeg({ tokensIn: small, coinAccount: coin, slippageBps: 500 });
  assert.deepEqual([sl.large, sl.minSolOut], [false, S.withSlippage(sq.solOut, 500)]);
  assert.throws(() => S.sellLeg({ tokensIn: small, coinAccount: coin, minSolOut: S.withSlippage(sq.solOut, 501) }), /more than 500/);
  // the policy the website shows
  assert.deepEqual(S.sellSlippagePolicy(coin, small), { maxSlippageBps: 500, defaultSlippageBps: 100, threshold: thr, gross: sq.gross, large: false });
  assert.deepEqual(S.sellSlippagePolicy(coin, tokens), { maxSlippageBps: 30, defaultSlippageBps: 30, threshold: thr, gross: q.gross, large: true });
  // the same guards as the buy leg
  assert.throws(() => S.sellLeg({ tokensIn: tokens, coinAccount: coin }), /needs its own minimum/);
  assert.throws(() => S.sellLeg({ tokensIn: tokens, coinAccount: coin, minSolOut: 0n }), /at least 1/);
  assert.throws(() => S.sellLeg({ tokensIn: tokens, coinAccount: coin, minSolOut: 5n, slippageBps: 30 }), /not both/);
  assert.throws(() => S.sellLeg({ tokensIn: tokens, minSolOut: 5n }), /needs coinAccount/);
  assert.throws(() => S.sellLeg({ tokensIn: tokens, coinAccount: coin, slippageBps: 501 }), /0 to 500/);
  assert.throws(() => S.sellLeg({ tokensIn: tokens, coinAccount: coin, slippageBps: 30, mint: key() }), /coin of mint/);
  // a tiny sell: the minimum is at least 1 lamport (withSlippage would give 0)
  const sells = (a) => { try { return S.quoteSell(T0, st, a).solOut >= 1n; } catch (e) { if (e.code === 'ZeroOutput') return false; throw e; } };
  let lo = 1n; let hi = 1n; while (!sells(hi)) { lo = hi; hi *= 2n; }
  while (hi - lo > 1n) { const m = (lo + hi) / 2n; if (sells(m)) hi = m; else lo = m; }
  const tiny = hi;
  assert.equal(S.withSlippage(S.quoteSell(T0, st, tiny).solOut, 500), 0n);
  assert.equal(S.sellLeg({ tokensIn: tiny, coinAccount: coin, slippageBps: 500 }).minSolOut, 1n);
  // in the pool too
  const pool = S.quoteBuy(T0, st, S.maxQuoteIn(T0, st)).newState;
  assert.throws(() => S.sellLeg({ tokensIn: tokens, coinAccount: { ...T0, ...pool, mint: coin.mint }, slippageBps: 100 }), /sandwich threshold/);
});

test('R4-DIFF-2 splitting is no defence: the refusal no longer offers it, and a piece of a larger order is judged by the order\'s total', () => {
  const st = S.stateAtLaunch(0n);
  const coin = { ...T0, ...st, mint: key() };
  const thr = S.sandwichThreshold(T0, st);
  let msg = '';
  try { S.buyLeg({ solIn: 5n * L, coinAccount: coin, slippageBps: 100 }); } catch (e) { msg = e.message; }
  assert.match(msg, /sandwich threshold/);
  assert.doesNotMatch(msg, /split it into buys of at most/, 'the old advice is gone');
  assert.match(msg, /does not help: an attacker can hold his position across separate transactions/);
  // a 5 SOL order split into threshold-size pieces: each piece is judged by the order (0.3%), not by its own size (5%)
  assert.equal(S.buyLeg({ solIn: thr, coinAccount: coin, slippageBps: 500 }).large, false, 'alone, a threshold-size buy may allow 5%');
  assert.throws(() => S.buyLeg({ solIn: thr, coinAccount: coin, slippageBps: 100, orderSolIn: 5n * L }), (e) => /part of an order of 5000000000 lamports/.test(e.message));
  assert.equal(S.buyLeg({ solIn: thr, coinAccount: coin, slippageBps: 30, orderSolIn: 5n * L }).large, true);
  assert.deepEqual([S.buySlippagePolicy(coin, thr, { orderSolIn: 5n * L }).maxSlippageBps, S.buySlippagePolicy(coin, thr, { orderSolIn: thr }).maxSlippageBps], [30, 500]);
  assert.throws(() => S.buyWithSwap({ ix: S.ix, user: key(), coin: key(), mint: coin.mint, swapInstructions: [], quote: swapQuote({ swapMode: 'ExactOut', outAmount: thr, otherAmountThreshold: thr }), coinAccount: coin, slippageBps: 100, orderSolIn: 5n * L }), /sandwich threshold/);
  // and sells
  const st60 = stateNearEnd(25n * L);
  const c60 = { ...T0, ...st60, mint: coin.mint };
  const tokens = 1_000_000_000_000n;
  assert.equal(S.sellLeg({ tokensIn: tokens, coinAccount: c60, slippageBps: 500 }).large, false);
  assert.throws(() => S.sellLeg({ tokensIn: tokens, coinAccount: c60, slippageBps: 100, orderGross: 10n * L }), /part of an order/);
});

test('SDK4-5 the swap must deliver native SOL: solInFromSwapQuote and buyWithSwap refuse any other output mint (or a SOL input)', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const ok = { swapMode: 'ExactIn', outAmount: '400000000', otherAmountThreshold: '398000000' };
  assert.equal(S.solInFromSwapQuote(swapQuote(ok)), 398_000_000n);
  assert.throws(() => S.solInFromSwapQuote({ ...swapQuote(ok), outputMint: USDC }), (e) => e instanceof S.ComposeError && /native SOL/.test(e.message) && e.message.includes(USDC));
  assert.throws(() => S.solInFromSwapQuote({ ...ok, inputMint: BONK }), /native SOL/, 'no outputMint at all');
  assert.throws(() => S.solInFromSwapQuote({ ...swapQuote(ok), inputMint: S.ADDRESSES.nativeMint }), /inputMint must be another token/);
  assert.throws(() => S.solInFromSwapQuote({ ...ok, outputMint: S.ADDRESSES.nativeMint }), /inputMint must be another token/);
  const coin = { ...T0, ...S.stateAtLaunch(0n), mint: key() };
  assert.throws(() => S.buyWithSwap({ ix: S.ix, user: key(), coin: key(), mint: coin.mint, swapInstructions: [], quote: { ...swapQuote(ok), outputMint: USDC }, coinAccount: coin, slippageBps: 100 }), /native SOL/);
});

test('SDK4-6 the README\'s direct buy runs as written (its slippage from buySlippagePolicy), and the docs give the SDK\'s threshold', () => {
  const readme = readFileSync(join(here, 'README.md'), 'utf8');
  assert.match(readme, /const policy = buySlippagePolicy\(coin, 1_000_000_000n\);/);
  assert.match(readme, /buyLeg\(\{ solIn: 1_000_000_000n, coinAccount: coin, slippageBps: policy\.defaultSlippageBps \}\)/);
  assert.doesNotMatch(readme, /buyLeg\(\{ solIn: 1_000_000_000n, coinAccount: coin, slippageBps: 100 \}\)/);
  // the README's two lines on a fresh coin, at 40 SOL raised and near graduation
  for (const st of [S.stateAtLaunch(0n), stateNearEnd(45n * L), stateNearEnd(1_000_000_000n), stateNearEnd(50_000n)]) {
    const coin = { ...T0, ...st, mint: key() };
    const policy = S.buySlippagePolicy(coin, 1_000_000_000n);
    const leg = S.buyLeg({ solIn: 1_000_000_000n, coinAccount: coin, slippageBps: policy.defaultSlippageBps });
    assert.ok(leg.minTokensOut >= 1n);
  }
  const spec = readFileSync(join(here, '..', '..', 'VICINITY-CURVE-DESIGN.md'), 'utf8');
  const s74 = spec.slice(spec.indexOf('### 7.4 Ordinary sandwiches'), spec.indexOf('### 7.5 '));
  assert.doesNotMatch(s74, /2% to 2\.5%/);
  assert.match(s74, /1\.3% of the market's SOL depth/);
  const clients = readFileSync(join(here, '..', '..', 'tests-curve', '29-clients.test.mjs'), 'utf8');
  assert.doesNotMatch(clients.slice(0, 3000), /2% to\s*\/\/\s*2\.5%|2% to 2\.5%/);
});

test('OPS-2 coinRentTopUp: liabilities + the live minimum - lamports, or 0; it counts lamports donated earlier', () => {
  const c = sampleCoin();
  const L = S.liabilities(S.coinState(c));
  assert.ok(L > 0n);
  const live = 6_285_576n;
  assert.equal(S.coinRentTopUp({ coin: c, coinLamports: 5_714_160n + L, rentExemptMinimum: live }), live - 5_714_160n, 'the rent raise d');
  assert.equal(S.coinRentTopUp({ coin: c, coinLamports: live, rentExemptMinimum: live }), L, 'topped up only to the minimum: the liabilities are still missing');
  assert.equal(S.coinRentTopUp({ coin: c, coinLamports: live + L, rentExemptMinimum: live }), 0n);
  assert.equal(S.coinRentTopUp({ coin: c, coinLamports: live + L + 7n, rentExemptMinimum: live }), 0n, 'a surplus needs nothing');
  assert.throws(() => S.coinRentTopUp({ coin: c, coinLamports: 1n }), /rentExemptMinimum missing/);
});

test('R4-DIFF-4, OPS-3 guardianRecovery: [set_guardian, set_pause] whose flags after it satisfy !buybacks_halted || buys_halted whatever the guardian set', () => {
  const admin = key(); const g = key();
  const [sg, sp] = S.ix.guardianRecovery({ admin, guardian: g, launches: false });
  assert.deepEqual([...sg.data], [...S.ix.setGuardian({ admin, guardian: g }).data]);
  assert.deepEqual([...sp.data], [...S.ix.setPause({ authority: admin, launches: false, buybacks: false }).data], 'buys untouched, buybacks resumed');
  const [, keep] = S.ix.guardianRecovery({ admin, guardian: g, keepBuybacksHalted: true });
  assert.deepEqual([...keep.data], [...S.ix.setPause({ authority: admin, buys: true }).data], 'buys halted explicitly, buybacks untouched');
  // the rule after the call, for every combination of flags the guardian may have set before it
  const after = (args, f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, args[k] ?? v]));
  for (const buys of [false, true]) for (const buybacks of [false, true]) {
    if (buybacks && !buys) continue; // never stored (LL-1)
    for (const args of [{ launches: false, buybacks: false }, { buys: true }]) {
      const f = after(args, { launches: true, buys, buybacks });
      assert.ok(!f.buybacks || f.buys, JSON.stringify({ buys, buybacks, args }));
    }
    // the trap: buys reopened with buybacks left unset
    const f = after({ launches: false, buys: false }, { launches: true, buys, buybacks });
    if (buybacks) assert.ok(f.buybacks && !f.buys, 'the one-proposal recovery leaves the forbidden state, so set_pause fails');
  }
});
