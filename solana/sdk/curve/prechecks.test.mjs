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
  assert.equal(S.solInFromSwapQuote({ swapMode: 'ExactIn', outAmount: 2_000_000_000n, otherAmountThreshold: '1980000000' }), 1_980_000_000n);
  assert.equal(S.solInFromSwapQuote({ swapMode: 'ExactOut', outAmount: '2000000000', otherAmountThreshold: 9n }), 2_000_000_000n);
  assert.throws(() => S.solInFromSwapQuote({ swapMode: 'ExactIn', outAmount: 1n, otherAmountThreshold: 2n }), /above outAmount/);
  assert.throws(() => S.solInFromSwapQuote({}), /unknown swapMode/);
  const user = key(); const mint = key(); const coin = key();
  const swapIx = { programAddress: key(), accounts: [], data: new Uint8Array([1]) };
  const { instructions, solIn, minTokensOut } = S.buyWithSwap({ ix: S.ix, user, coin, mint, swapInstructions: [swapIx], quote: { swapMode: 'ExactIn', outAmount: 500_000n, otherAmountThreshold: 400_000n }, minTokensOut: 7n });
  assert.equal(solIn, 400_000n);
  assert.equal(minTokensOut, 7n);
  assert.deepEqual(instructions.map((x) => x.programAddress), [swapIx.programAddress, S.ADDRESSES.associatedToken, S.CURVE_PROGRAM_ID]);
  assert.equal(Buffer.from(instructions[2].data).readBigUInt64LE(8), 400_000n, 'the buy\'s sol_in');
  assert.equal(Buffer.from(instructions[2].data).readBigUInt64LE(16), 7n, 'the buy\'s min_tokens_out');
  assert.equal(instructions[2].accounts[5].address, S.associatedTokenAddress(user, mint));
});

test('CLI-1 pay with any token: buyWithSwap never builds a buy without its own minimum (14.1)', () => {
  const user = key(); const coinKey = key();
  const swapIx = { programAddress: key(), accounts: [], data: new Uint8Array([1]) };
  const quote = { swapMode: 'ExactIn', outAmount: 1_010_000_000n, otherAmountThreshold: 1_000_000_000n };
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
  const q = S.quoteBuy(S.coinTerms(coin), S.coinState(coin), 1_000_000_000n);
  for (const bps of [0, 100, 200, 500]) {
    const r = S.buyWithSwap({ ...base, coinAccount: coin, slippageBps: bps });
    assert.equal(r.minTokensOut, S.withSlippage(q.tokensOut, bps));
    assert.equal(Buffer.from(r.instructions.at(-1).data).readBigUInt64LE(16), r.minTokensOut, `${bps} bps encoded`);
    assert.ok(r.minTokensOut > 0n);
  }
});
