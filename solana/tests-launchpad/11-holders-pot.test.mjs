// TE10-TE13: the holders' share can only go where the design says, all the
// way to the holders' own wallets.
//
//   TE10 the per-transaction money-flow check (helpers.mjs assertMoneyFlows)
//        is live on every test and refuses every kind of forbidden movement
//   TE11 every token account that exists, tried as the destination of a
//        forward, a harvest and a founder claim: only the designed one works
//   TE12 every field of the city's rewards config, changed one at a time:
//        forward refuses exactly when a field it relies on is wrong
//   TE13 end to end with real holders: trades, graduation, harvest, forward,
//        a snapshot that leaves out pools, vaults, the dev wallet and the
//        founder, a funded round (fund_epoch_from_vault) and every holder's claim
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import anchor from '@coral-xyz/anchor';
import { address } from '@solana/kit';
import {
  World, C, IDL, R, ADDRESSES, PROGRAM_IDS, LAMPORTS, DAY, expectFail, assertInvariants, harvest, ata, buildIx,
  flowState, allowedFlows, checkTokenMoves, graduate, completeCurve, fakeConnection, mintData,
} from './helpers.mjs';
import web3 from '@solana/web3.js';
import { prepareRound, sampleBalances, ROUND_RULES } from '../sdk/launchpad/snapshot.mjs';
import { claimArgs } from '../sdk/merkle.mjs';

const WSOL = ADDRESSES.wsol;
const { BN } = anchor;
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

describe('11 holders pot', () => {
  let w, founder, coin, rewards;
  before(async () => {
    w = await World.create();
    founder = await w.signer();
    coin = await w.launchCoin({ cityId: 110001n, founder });
    // the SDK helper sets the city up exactly as forward requires (Holders, 0%, quote token)
    await w.send([C.initRewardsForCoin({ payer: w.payer.address, registryAdmin: w.admin.address, authority: w.admin.address, coin })], [w.admin], 'rewards init_city (initRewardsForCoin)');
    rewards = { config: R.city(coin.mint), vault: R.vault(R.city(coin.mint)) };
    const t = await w.signer();
    await w.trade(t, coin, { side: 'buy', amount0: 4n * LAMPORTS, amount1: 1n });
    await harvest(w, coin);
  });

  it('TE10 the money-flow check is live, and refuses every forbidden movement', async () => {
    const before = w.flows.length;
    await w.send([C.forwardHoldersFees({ coin })], [], 'forward_holders_fees');
    await w.send([C.claimFounderFees({ founder: founder.address, coin })], [founder], 'claim_founder_fees');
    const seen = w.flows.slice(before);
    assert.deepEqual(seen.map((f) => [f.source, f.destination]), [[coin.holdersPot, rewards.vault], [coin.founderVault, ata(founder.address, WSOL)]]);
    // the harvest in before() moved the founder's half pot -> vault
    assert.ok(w.flows.some((f) => f.source === coin.holdersPot && f.destination === coin.founderVault && f.amount === 10_000_000n));
    // the rule itself, fed forbidden movements directly
    const rules = allowedFlows(w, [flowState(w)]);
    const T = PROGRAM_IDS.token;
    const transfer = (src, dst, amt = 5n) => ({ program: T, accounts: [src, dst, coin.address], data: Buffer.concat([Buffer.from([3]), u64(amt)]), top: { program: PROGRAM_IDS.launchpad, accounts: [], data: Buffer.alloc(8) } });
    const adminAta = ata(w.admin.address, WSOL), devAta = ata(ADDRESSES.feeRecipient, WSOL);
    for (const [src, dst] of [[coin.holdersPot, adminAta], [coin.holdersPot, devAta], [coin.holdersPot, ata(founder.address, WSOL)], [coin.founderVault, adminAta], [coin.founderVault, rewards.vault], [rewards.vault, adminAta]]) {
      assert.throws(() => checkTokenMoves(rules, [transfer(src, dst)]), /does not allow|outside a holder's claim/, `${src} -> ${dst}`);
    }
    for (const tag of [4, 6, 8, 9, 10]) {
      assert.throws(() => checkTokenMoves(rules, [{ ...transfer(coin.holdersPot, adminAta), data: Buffer.concat([Buffer.from([tag]), u64(1)]) }]), /on watched account/);
    }
    // allowed ones pass, and a zero transfer moves nothing
    assert.equal(checkTokenMoves(rules, [transfer(coin.holdersPot, coin.founderVault), transfer(coin.holdersPot, rewards.vault)]).length, 2);
    assert.equal(checkTokenMoves(rules, [transfer(coin.holdersPot, adminAta, 0n)]).length, 0);
  });

  it('TE11 every token account that exists, as a destination: only the designed one is accepted', async () => {
    // a richer world: a second city with its own pot, vault and rewards vault, the
    // admin's and the dev wallet's own accounts, and an opted-in payout wallet
    const other = await w.launchCoin({ cityId: 110003n });
    await w.send([C.initRewardsForCoin({ payer: w.payer.address, registryAdmin: w.admin.address, authority: w.admin.address, coin: other })], [w.admin], 'rewards init_city');
    w.emptyTokenAccount(w.admin.address, WSOL);
    w.emptyTokenAccount(ADDRESSES.feeRecipient, WSOL);
    const payoutKey = await w.signer(), payoutWallet = await w.signer();
    await w.send([C.setPayoutConfig({ admin: w.admin.address, payoutAuthority: payoutKey.address, payoutDestination: payoutWallet.address })], [w.admin]);
    await w.send([C.optInPayout({ founder: founder.address, cityId: coin.cityId, expectedDestination: payoutWallet.address, refHash: new Uint8Array(32).fill(9) })], [founder]);
    w.emptyTokenAccount(payoutWallet.address, WSOL);
    const t = await w.signer();
    await w.trade(t, coin, { side: 'buy', amount0: 2n * LAMPORTS, amount1: 1n }); // fresh fees to harvest
    await w.trade(t, other, { side: 'buy', amount0: 2n * LAMPORTS, amount1: 1n });
    await harvest(w, other);
    w.donate(coin.holdersPot, 1_000n); // something to forward
    w.donate(coin.founderVault, 1_000n); // something to claim or pay out
    const all = w.svm.getProgramAccounts(address(PROGRAM_IDS.token)).filter((a) => a.data.length === 165).map((a) => String(a.address));
    const balances = () => all.map((a) => w.balance(a));
    const b0 = balances();
    let n = 0;
    for (const acct of all) {
      if (acct !== rewards.vault) { await expectFail(() => w.send([C.forwardHoldersFees({ coin, overrides: { rewards_vault: acct } })])); n++; }
      if (acct !== coin.founderVault) { await expectFail(() => w.send([C.harvestCurveFees({ payer: w.payer.address, coin, overrides: { founder_vault: acct } })])); n++; }
      if (acct !== ata(founder.address, WSOL)) { await expectFail(() => w.send([C.claimFounderFees({ founder: founder.address, coin, overrides: { founder_token_account: acct } })], [founder])); n++; }
      if (acct !== ata(payoutWallet.address, WSOL)) { await expectFail(() => w.send([C.payoutFounderFees({ payoutAuthority: payoutKey.address, coin, destination: payoutWallet.address, overrides: { destination_token_account: acct } })], [payoutKey])); n++; }
    }
    assert.deepEqual(balances(), b0, 'no refused attempt moved anything');
    console.log(`TE11 ${all.length} token accounts tried, ${n} substitutions refused`);
    // the designed destinations still work
    await harvest(w, coin);
    await w.send([C.forwardHoldersFees({ coin })], [], 'forward_holders_fees');
    await w.send([C.payoutFounderFees({ payoutAuthority: payoutKey.address, coin, destination: payoutWallet.address })], [payoutKey], 'payout_founder_fees');
    assert.equal(w.balance(coin.holdersPot), 0n);
    assert.equal(w.balance(coin.founderVault), 0n);
    assert.ok(w.balance(ata(payoutWallet.address, WSOL)) > 0n);
    await w.send([C.revokePayoutOptIn({ by: founder.address, cityId: coin.cityId, optInFounder: founder.address })], [founder]);
  });

  it('TE12 every rewards-config field changed one at a time: forward refuses exactly when it matters', async () => {
    const original = Buffer.from(w.account(rewards.config).data);
    assert.equal(original.length, 303);
    // CityConfig layout (Borsh after the 8-byte discriminator, sdk/idl/vicinity_rewards.json)
    const fields = [
      ['discriminator', 0, 8, true], ['authority', 8, 32, false], ['pending_authority', 40, 32, false], ['founder', 72, 32, false],
      ['city_coin_mint', 104, 32, true], ['reward_mint', 136, 32, true], ['vault', 168, 32, true], ['reward_model', 200, 1, true],
      ['founder_bps', 201, 2, true], ['locked', 203, 1, false], ['paused', 204, 1, false], ['paused_at', 205, 8, false],
      ['paused_total_secs', 213, 8, false], ['epoch_count', 221, 8, false], ['carry_over', 229, 8, false], ['total_funded', 237, 8, false],
      ['total_to_founder', 245, 8, false], ['total_to_holders', 253, 8, false], ['total_claimed', 261, 8, false], ['city_tag', 269, 32, false],
      ['bump', 301, 1, false], ['vault_bump', 302, 1, false],
    ];
    assert.equal(fields.reduce((s, f) => s + f[2], 0), 303, 'every byte covered');
    const variants = (name, at, len) => {
      if (name === 'reward_model') return [0, 2, 3].map((m) => { const b = Buffer.from(original); b[at] = m; return b; }); // Creator, Split, invalid
      if (name === 'founder_bps') return [1, 2500, 10000].map((v) => { const b = Buffer.from(original); b.writeUInt16LE(v, at); return b; });
      const b = Buffer.from(original);
      for (let i = 0; i < len; i++) b[at + i] ^= 0xa5;
      if (len === 1 && (name === 'locked' || name === 'paused')) b[at] = original[at] ? 0 : 1;
      return [b];
    };
    const cfgLamports = w.lamportsOf(rewards.config);
    let refused = 0, allowed = 0;
    for (const [name, at, len, relied] of fields) {
      for (const bytes of variants(name, at, len)) {
        w.setRaw(rewards.config, bytes, PROGRAM_IDS.rewards, cfgLamports);
        w.donate(coin.holdersPot, 100n);
        const send = () => w.send([C.forwardHoldersFees({ coin })], [], `forward with ${name} changed`);
        if (relied) { await expectFail(send, 'WrongRewardsConfig'); refused++; } else { await send(); allowed++; }
      }
      w.setRaw(rewards.config, original, PROGRAM_IDS.rewards, cfgLamports);
    }
    console.log(`TE12 ${refused} changes to relied-on fields refused; ${allowed} changes to the rewards authority's own fields accepted`);
    await w.send([C.forwardHoldersFees({ coin })], [], 'forward_holders_fees');
    assertInvariants(w);
  });

  it('TE13 end to end: real holders, graduation, snapshot (pools, vaults, dev wallet and founder left out), a funded round, every claim', async () => {
    const city = await w.launchCoin({ cityId: 110002n, founder });
    await w.send([C.initRewardsForCoin({ payer: w.payer.address, registryAdmin: w.admin.address, authority: w.admin.address, coin: city })], [w.admin], 'rewards init_city');
    const cfg = R.city(city.mint), vault = R.vault(cfg);
    // eight holders of different sizes, the founder buys too, someone sells part
    const holders = [];
    for (let i = 0; i < 8; i++) {
      const h = await w.signer(100n);
      await w.trade(h, city, { side: 'buy', amount0: BigInt(i + 1) * LAMPORTS, amount1: 1n });
      holders.push(h);
    }
    await w.trade(founder, city, { side: 'buy', amount0: 3n * LAMPORTS, amount1: 1n });
    await w.trade(holders[7], city, { side: 'sell', amount0: w.balance(ata(holders[7].address, city.mint)) / 3n, amount1: 0n });
    const filler = await completeCurve(w, city);
    holders.push(filler);
    const cranker = await w.signer(5n);
    await graduate(w, city, cranker);
    await w.send([C.createAtaIdempotent({ payer: w.payer.address, owner: ADDRESSES.feeRecipient, mint: city.mint }), C.withdrawLeftover({ dbcPool: city.dbcPool, dbcConfig: city.dbcConfig, coinMint: city.mint, receiverAccount: ata(ADDRESSES.feeRecipient, city.mint) })], [], 'withdraw_leftover');
    await harvest(w, city);
    await w.send([C.forwardHoldersFees({ coin: city })], [], 'forward_holders_fees');
    const pot = w.balance(vault);
    assert.ok(pot > 200_000_000n, `the holders' 0.25% of the whole curve: ${pot} lamports`);

    // the snapshot, through the code path of scripts/launchpad/snapshot.mjs (a
    // web3.js Connection, answered here from the VM), at the default rules first
    const conn = fakeConnection(w);
    // balance samples taken during the epoch (here: nothing changes between them)
    const samples = [];
    for (let i = 0; i < ROUND_RULES.minSamples; i++) samples.push(await sampleBalances(conn, city.mint));
    // a public RPC serves token-program scans only through the mint or owner index: the snapshot's query must keep
    // using it (dataSize 165 + the mint at offset 0), so it reads the same balances there
    const sorted = (s) => [...s.balances].sort((x, y) => (x.owner < y.owner ? -1 : 1));
    assert.deepEqual(sorted(await sampleBalances(fakeConnection(w, { publicRpc: true }), city.mint)), sorted(samples[0]));
    const dflt = await prepareRound(conn, city.mint, { samples });
    assert.equal(dflt.total, pot, 'the round total is what the vault can pay');
    assert.equal(dflt.round.fundable, false, 'nine holders: the default gate (20 holders at 0.01 SOL) says wait');
    const unsampled = await prepareRound(conn, city.mint, { rules: { ...ROUND_RULES, minHolders: 5 } });
    assert.equal(unsampled.round.fundable, false, 'without balance samples a round is never fundable');
    assert.match(unsampled.round.reason, /balance sample/);
    const r = await prepareRound(conn, city.mint, { rules: { ...ROUND_RULES, minHolders: 5 }, samples });
    const reasons = new Map(r.excluded.map((e) => [e.owner, e.reason]));
    assert.match(reasons.get(ADDRESSES.feeRecipient), /team or founder/, 'the dev wallet (leftover) is out');
    assert.match(reasons.get(founder.address), /team or founder/, 'the founder is out');
    assert.match(reasons.get(ADDRESSES.dammPoolAuthority), /program address/, 'the trading pool\'s vaults are out');
    assert.match(reasons.get(ADDRESSES.dbcPoolAuthority), /program address/, 'the curve\'s vaults are out');
    const holderSet = new Set(holders.map((h) => h.address));
    for (const e of r.eligible) assert.ok(holderSet.has(e.owner), `only real holders are eligible (${e.owner})`);
    assert.equal(r.eligible.length, holders.length);
    const { round, file, csv } = r;
    assert.ok(round.fundable, round.reason);
    for (const l of round.leaves) assert.ok(l.amount >= ROUND_RULES.minPayout);
    assert.equal(csv.trim().split('\n').length, round.leaves.length + 1);
    // the published file rebuilds the root that gets booked
    assert.equal(JSON.parse(file.text).merkleRoot, Buffer.from(file.tree.root).toString('hex'));
    const founderBefore = w.balance(ata(founder.address, WSOL));
    await w.send([buildIx(IDL.rewards, 'fund_epoch_from_vault', {
      merkle_root: Array.from(file.tree.root), num_leaves: round.leaves.length, snapshot_slot: new BN(1),
      snapshot_hash: Array.from(file.hash), claim_window_secs: new BN(String(30n * DAY)),
    }, {
      authority: w.admin.address, payer: w.payer.address, config: cfg, reward_mint: WSOL, vault, founder: founder.address,
      founder_token_account: ata(founder.address, WSOL), epoch: R.epoch(cfg, 0), token_program: PROGRAM_IDS.token,
    })], [w.admin], 'rewards fund_epoch_from_vault');
    const bySigner = new Map(holders.map((h) => [h.address, h]));
    const flows0 = w.flows.length;
    for (let i = 0; i < round.leaves.length; i++) {
      const leaf = round.leaves[i];
      const h = bySigner.get(String(leaf.claimant));
      const args = claimArgs(file.tree, i);
      const before = w.balance(ata(h.address, WSOL));
      await w.send([buildIx(IDL.rewards, 'claim', {
        epoch_index: new BN(0), leaf_index: i, amount: new BN(String(args.amount)), proof: args.proof.map((p) => Array.from(p)),
      }, {
        claimant: h.address, config: cfg, epoch: R.epoch(cfg, 0), claim_status: R.claim(R.epoch(cfg, 0), h.address), reward_mint: WSOL, vault,
        claimant_token_account: ata(h.address, WSOL), token_program: PROGRAM_IDS.token,
      })], [h], 'rewards claim', { feePayer: h });
      assert.equal(w.balance(ata(h.address, WSOL)) - before, leaf.amount);
    }
    // every movement out of the rewards vault was a holder's own claim, to that holder
    const claims = w.flows.slice(flows0);
    assert.equal(claims.length, round.leaves.length);
    for (const f of claims) assert.equal(f.source, vault);
    assert.equal(w.balance(vault), round.dust, 'only rounding dust stays for the next round');
    assert.equal(w.balance(ata(founder.address, WSOL)), founderBefore, 'the founder got nothing from the holders\' round');
    console.log(`TE13 holders' pot ${pot} lamports paid to ${round.leaves.length} of ${r.eligible.length} holders (min ${ROUND_RULES.minPayout}); dust ${round.dust}; excluded ${r.excluded.length} owners; snapshot hash ${Buffer.from(file.hash).toString('hex').slice(0, 16)}...`);
  });

  it('TE14 a wallet that holds only at the snapshot gets nothing; one that sold half mid-epoch counts with its average (review R3)', async () => {
    const city = await w.launchCoin({ cityId: 110010n, name: 'Flash Town', symbol: 'FLASH' });
    const conn = fakeConnection(w);
    const honest = [];
    for (let i = 0; i < 4; i++) { const h = await w.signer(5n); await w.trade(h, city, { side: 'buy', amount0: LAMPORTS, amount1: 1n }); honest.push(h); }
    const samples = [];
    for (let i = 0; i < 3; i++) samples.push(await sampleBalances(conn, city.mint));
    // one honest holder sells half in the middle of the epoch
    const half = w.balance(ata(honest[0].address, city.mint)) / 2n;
    await w.trade(honest[0], city, { side: 'sell', amount0: half, amount1: 1n });
    for (let i = 0; i < 3; i++) samples.push(await sampleBalances(conn, city.mint));
    // a flash holder buys big right before the cutoff (and would sell right after)
    const flash = await w.signer(50n);
    await w.trade(flash, city, { side: 'buy', amount0: 20n * LAMPORTS, amount1: 1n });
    const rules = { ...ROUND_RULES, minHolders: 1, minPayout: 1n };
    const weighted = await prepareRound(conn, city.mint, { total: 4n * LAMPORTS, rules, samples });
    const single = await prepareRound(conn, city.mint, { total: 4n * LAMPORTS, rules: { ...rules, minSamples: 0 } });
    const leafOf = (r, who) => r.round.leaves.find((l) => String(l.claimant) === who.address)?.amount ?? 0n;
    assert.ok(leafOf(single, flash) > 2n * LAMPORTS, `one slot only: the flash holder takes ${leafOf(single, flash)} of 4 SOL`);
    assert.equal(leafOf(weighted, flash), 0n, 'time-weighted: nothing for a wallet that was not there');
    assert.ok(!weighted.eligible.some((e) => e.owner === flash.address));
    // the half-seller counts with min(balance now, average) = its balance now; the others with their full balance
    const b0 = weighted.eligible.find((e) => e.owner === honest[0].address).balance;
    assert.equal(b0, w.balance(ata(honest[0].address, city.mint)));
    for (const h of honest.slice(1)) assert.equal(weighted.eligible.find((e) => e.owner === h.address).balance, w.balance(ata(h.address, city.mint)));
    assert.equal(weighted.round.allocated + weighted.round.dust, 4n * LAMPORTS, 'the whole pot goes to the honest holders');
    assert.ok(weighted.round.fundable);
    assert.deepEqual(JSON.parse(weighted.file.text).sampleSlots.length, 6);
    // a sample of another coin is refused
    const other = await w.launchCoin({ cityId: 110011n, name: 'Other', symbol: 'OTHER' });
    await assert.rejects(prepareRound(conn, other.mint, { total: 1n, rules, samples }), /balance sample of/);
    console.log(`TE14 flash holder: ${leafOf(single, flash)} lamports from a single-slot snapshot, ${leafOf(weighted, flash)} time-weighted`);
  });

  it('TE15 the airdrop CSV uses the reward token\'s own decimals, and a non-SOL reward needs its own minimum payout (review R4, N2)', async () => {
    // a 9-decimal classic SPL quote token with no authorities that is not WSOL passes rule 7.2(2)
    const Q = web3.Keypair.generate().publicKey.toBase58();
    w.setRaw(Q, mintData({ supply: 10n ** 18n, decimals: 9 }), PROGRAM_IDS.token);
    const cfg = await w.createDbcConfig({ quoteDecimals: 9 }, { quoteMint: Q });
    await w.send([C.addLaunchConfig({ admin: w.admin.address, dbcConfig: cfg, quoteMint: Q })], [w.admin], 'add_launch_config (9-decimal quote)');
    const city = await w.launchCoin({ cityId: 110012n, dbcConfig: cfg, quoteMint: Q, name: 'Nine', symbol: 'NINE' });
    for (let i = 0; i < 25; i++) await w.trade(await w.signer(1n), city, { side: 'buy', amount0: 1_000_000_000n, amount1: 1n });
    const conn = fakeConnection(w);
    const total = 25_000_000_000n; // 25 Q
    await assert.rejects(prepareRound(conn, city.mint, { total }), /minimum payout/, 'the 0.01 SOL default does not apply to Q');
    const r = await prepareRound(conn, city.mint, { total, minPayout: 100_000_000n, rules: { ...ROUND_RULES, minSamples: 0 } });
    assert.equal(r.rewardDecimals, 9);
    const leaf = r.round.leaves[0];
    const line = r.csv.split('\n').find((l) => l.startsWith(String(leaf.claimant)));
    const whole = line.split(',')[1];
    assert.equal(BigInt(whole.replace('.', '').padEnd(whole.includes('.') ? whole.indexOf('.') + 9 : whole.length + 9, '0')), BigInt(leaf.amount), `CSV ${whole} for ${leaf.amount} raw (9 decimals)`);
    const csvTotal = r.csv.trim().split('\n').slice(1).reduce((s, l) => s + Number(l.split(',')[1]), 0);
    assert.ok(Math.abs(csvTotal - Number(r.round.allocated) / 1e9) < 1e-6, `CSV total ${csvTotal}`);
    assert.equal(JSON.parse(r.file.text).rules.minPayout, '100000000');
  });
});
