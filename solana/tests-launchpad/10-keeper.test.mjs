// TI01-TI08: the keeper (scripts/launchpad/crank.mjs, sdk/launchpad/keeper.mjs)
// against the real Meteora programs and the real rewards program.
//
//   TI01 it plans only what is due; a coin whose rewards config would make
//        forward fail is reported, never sent, so it cannot break a batch
//   TI02 a whole life cycle: the minute pass graduates, sends the leftover to
//        the dev wallet, collects fees and the surplus and forwards; the next
//        pass finds nothing; the daily pass collects the pool fees
//   TI03 it finds the city's position after a stranger ran the graduation
//   TI04 the keeper wallet has no power: it only signs as fee payer (plus the
//        fresh position-NFT keys of a graduation) and receives nothing
//   TI05 many coins are packed into few transactions, each within 1,232 bytes
//   TI06 the RPC code path the script uses plans exactly the same
//   TI07 it recreates the dev wallet's referral account and ignores positions
//        outside the coin's own pool
//   TI08 on a public RPC, which refuses to scan the token programs, it finds
//        the same pool positions and plans the same
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner } from '@solana/kit';
import web3 from '@solana/web3.js';
import { World, C, IDL, ADDRESSES, PROGRAM_IDS, LAMPORTS, R, assertInvariants, ata, damm, graduate, churn, completeCurve, svmReader, fakeConnection, readKey, byteView, tokenAccountData } from './helpers.mjs';
import { runKeeper, loadState, planKeeper, connectionReader, canonicalPool, MAX_TX_BYTES } from '../sdk/launchpad/keeper.mjs';

const WSOL = ADDRESSES.wsol;

describe('10 keeper', () => {
  let w, keeper, sent;
  const coins = {};
  /** One keeper pass in the test VM; every instruction sent is recorded for TI04. */
  async function pass(daily, reader = svmReader(w)) {
    const report = await runKeeper({
      reader, payer: keeper.address, daily, newSigner: generateKeyPairSigner,
      send: async (ixs, signers, { cu, label }) => {
        sent.push({ ixs, signers: signers.map((s) => s.address) });
        return w.send(ixs, signers, label, { feePayer: keeper, cu });
      },
    });
    for (const r of report.results) assert.ok(r.ok, `${r.label}: ${r.error}`);
    return report;
  }
  const kinds = (report, cityId) => report.steps.filter((s) => s.cityId === cityId).map((s) => s.kind);
  async function buy(coin, lamports) {
    const t = await w.signer();
    await w.trade(t, coin, { side: 'buy', amount0: lamports, amount1: 1n });
  }

  before(async () => {
    w = await World.create();
    keeper = await w.signer(20n);
    sent = [];
  });

  it('TI01 plans only what is due; a coin with a missing or wrong rewards config is reported, not sent', async () => {
    coins.A = await w.launchCoin({ cityId: 100001n }); // nothing happened
    coins.B = await w.launchCoin({ cityId: 100002n }); // fees, good rewards config
    coins.C = await w.launchCoin({ cityId: 100003n }); // fees, no rewards config yet
    coins.D = await w.launchCoin({ cityId: 100004n }); // fees, Split rewards config
    await w.initRewardsCity(coins.B);
    await w.initRewardsCity(coins.D, { model: { Split: {} }, founderBps: 2500 });
    for (const c of [coins.B, coins.C, coins.D]) await buy(c, LAMPORTS);
    const vaultB = R.vault(R.city(coins.B.mint));
    const r = await pass(true);
    assert.deepEqual(kinds(r, 100001n), []);
    assert.deepEqual(kinds(r, 100002n), ['harvestCurve', 'forward']);
    assert.deepEqual(kinds(r, 100003n), ['harvestCurve']);
    assert.deepEqual(kinds(r, 100004n), ['harvestCurve']);
    assert.match(r.notes.find((n) => n.cityId === 100003n).note, /no rewards config/);
    assert.match(r.notes.find((n) => n.cityId === 100004n).note, /not Holders-only/);
    assert.equal(w.balance(vaultB), 2_500_000n, 'B: harvested and forwarded in one pass');
    assert.equal(w.balance(coins.B.holdersPot), 0n);
    for (const c of [coins.C, coins.D]) assert.equal(w.balance(c.holdersPot), 2_500_000n, 'C, D: harvested; the pot keeps the holders\' half');
    // nothing new: the next pass sends nothing, and still reports C and D
    const r2 = await pass(true);
    assert.equal(r2.transactions.length, 0);
    assert.equal(r2.notes.length, 2);
    // once C gets a correct rewards config, the keeper forwards its waiting pot
    await w.initRewardsCity(coins.C);
    const r3 = await pass(true);
    assert.deepEqual(kinds(r3, 100003n), ['forward']);
    assert.equal(w.balance(R.vault(R.city(coins.C.mint))), 2_500_000n);
  });

  it('TI02 life cycle: minute pass graduates, sends the leftover to the dev wallet, collects fees and surplus, forwards; daily pass collects pool fees', async () => {
    const E = coins.E = await w.launchCoin({ cityId: 100005n });
    await w.initRewardsCity(E);
    await churn(w, E, { trades: 120, seed: 5 });
    await completeCurve(w, E);
    const vault = R.vault(R.city(E.mint));
    const v0 = w.balance(vault);
    const cityFees = w.pool(E.dbcPool).creatorQuoteFee;
    const devAta = ata(ADDRESSES.feeRecipient, E.mint);
    assert.equal(w.exists(devAta), false);
    const r = await pass(false);
    assert.deepEqual(kinds(r, 100005n), ['migrate', 'withdrawLeftover', 'harvestCurve', 'forward']);
    const p = w.pool(E.dbcPool);
    assert.equal(p.isMigrated, 1);
    assert.equal(p.isWithdrawLeftover, 1);
    assert.equal(p.isCreatorWithdrawSurplus, 1);
    assert.equal(p.creatorQuoteFee, 0n);
    assert.ok(w.balance(devAta) > 0n, 'the unsold dust went to the dev wallet (the keeper created its coin account)');
    assert.ok(w.balance(vault) - v0 >= cityFees / 2n, 'the holders\' half reached the rewards vault');
    assert.equal(w.balance(E.holdersPot), 0n);
    // the minute pass leaves the other coins alone (no harvest, no forward)
    for (const id of [100001n, 100002n, 100003n, 100004n]) assert.deepEqual(kinds(r, id), []);
    // nothing left to do for E
    assert.deepEqual(kinds(await pass(false), 100005n), []);
    // trading on the graduated pool, then the daily pass
    const t = await w.signer();
    w.fundToken(t.address, WSOL, 10n * LAMPORTS);
    w.emptyTokenAccount(t.address, E.mint);
    const pool = damm.pool(ADDRESSES.dammCustomizableConfig, E.mint, WSOL);
    for (let i = 0; i < 2; i++) {
      await w.send([C.dammSwap({ trader: t.address, pool, mintA: E.mint, mintB: WSOL, aToB: false, amountIn: 2n * LAMPORTS, minOut: 1n })], [t], 'damm swap buy');
      await w.send([C.dammSwap({ trader: t.address, pool, mintA: E.mint, mintB: WSOL, aToB: true, amountIn: w.balance(ata(t.address, E.mint)) / 2n, minOut: 1n })], [t], 'damm swap sell');
    }
    const v1 = w.balance(vault);
    const r2 = await pass(true);
    assert.deepEqual(kinds(r2, 100005n), ['harvestPool', 'forward']);
    const gained = w.balance(vault) - v1;
    assert.ok(gained > 0n, 'pool fees: the holders\' half reached the rewards vault');
    assert.ok(w.balance(E.founderVault) > 0n);
    console.log(`TI02 minute pass: ${r.transactions.length} transactions (${r.transactions.map((x) => `${x.label} ${x.bytes} B`).join('; ')}); daily pool-fee forward ${gained} lamports`);
    // again: harvest_pool is a no-op that cannot fail
    const r3 = await pass(true);
    assert.deepEqual(kinds(r3, 100005n), ['harvestPool', 'forward']);
  });

  it('TI03 finds the city\'s position when a stranger ran the graduation with its own keys', async () => {
    const F = coins.F = await w.launchCoin({ cityId: 100006n });
    await w.initRewardsCity(F);
    await completeCurve(w, F);
    const stranger = await w.signer(5n);
    const g = await graduate(w, F, stranger);
    const state = await loadState(svmReader(w));
    const f = state.coins.find((c) => c.cityId === 100006n);
    assert.equal(f.positions.length, 1, 'exactly one position: the city\'s (the dev wallet\'s is not the city\'s)');
    const cityNft = readKey(w.account(damm.positionNftAccount(g.n1)).data, 32) === F.address ? g.n1 : g.n2;
    assert.equal(f.positions[0].nftMint, cityNft);
    assert.equal(f.positions[0].pool, g.pool);
    const t = await w.signer();
    w.fundToken(t.address, WSOL, 3n * LAMPORTS);
    w.emptyTokenAccount(t.address, F.mint);
    await w.send([C.dammSwap({ trader: t.address, pool: g.pool, mintA: F.mint, mintB: WSOL, aToB: false, amountIn: 2n * LAMPORTS, minOut: 1n })], [t], 'damm swap buy');
    const potBefore = w.coin(100006n).holdersAccrued;
    const r = await pass(true);
    assert.ok(kinds(r, 100006n).includes('harvestPool'));
    assert.ok(w.coin(100006n).holdersAccrued > potBefore);
  });

  it('TI04 the keeper wallet signs only as fee payer (and the fresh NFT keys of a graduation) and receives nothing', async () => {
    assert.ok(sent.length > 0);
    for (const { ixs, signers } of sent) {
      for (const ix of ixs) {
        for (const a of ix.accounts.filter((x) => x.role >= 2)) {
          assert.ok(a.address === keeper.address || signers.includes(a.address), `${ix.programAddress} signer ${a.address}`);
        }
        for (const forbidden of [w.admin.address, ADDRESSES.feeRecipient, w.deployer.address]) {
          assert.ok(!ix.accounts.some((a) => a.address === forbidden && a.role >= 2), 'never a privileged signer');
        }
      }
    }
    // every graduation key is fresh and used once
    const nft = sent.flatMap((s) => s.signers);
    assert.equal(new Set(nft).size, nft.length);
    // the keeper owns no token account at all: nothing was ever paid to it
    const owned = w.svm.getProgramAccounts(PROGRAM_IDS.token).filter((a) => readKey(a.data, 32) === keeper.address);
    assert.equal(owned.length, 0);
    console.log(`TI04 keeper spent ${Number(20n * LAMPORTS - w.lamportsOf(keeper.address)) / 1e9} SOL on fees and rent over ${sent.length} transactions`);
  });

  it('TI05 many coins are packed into few transactions, each within 1,232 bytes, with the same effect', async () => {
    const many = [];
    for (let i = 0; i < 10; i++) {
      const c = await w.launchCoin({ cityId: 100100n + BigInt(i) });
      await w.initRewardsCity(c);
      await buy(c, LAMPORTS);
      many.push(c);
    }
    const r = await pass(true);
    const mine = r.transactions.filter((t) => /city 1001\d\d/.test(t.label));
    const stepsMine = r.steps.filter((x) => x.cityId >= 100100n).length;
    for (const t of r.transactions) assert.ok(t.bytes <= MAX_TX_BYTES, `${t.label}: ${t.bytes} bytes`);
    assert.ok(mine.length < stepsMine / 2, `${mine.length} transactions for ${stepsMine} steps of ${many.length} coins`);
    for (const c of many) {
      assert.equal(w.balance(c.holdersPot), 0n);
      assert.equal(w.balance(R.vault(R.city(c.mint))), 2_500_000n);
      assert.equal(w.balance(c.founderVault), 2_500_000n);
    }
    console.log(`TI05 ${many.length} coins harvested and forwarded in ${mine.length} transactions of ${mine.map((t) => t.bytes).join(', ')} bytes`);
    assertInvariants(w);
  });

  it('TI06 the RPC code path of the script (connectionReader) plans exactly what the test reader plans', async () => {
    // give two coins something to do, and one a pending graduation
    await buy(coins.B, LAMPORTS);
    const G = await w.launchCoin({ cityId: 100007n });
    await completeCurve(w, G);
    const a = planKeeper(await loadState(svmReader(w)), { daily: true });
    const b = planKeeper(await loadState(connectionReader(fakeConnection(w))), { daily: true });
    const view = (p) => ({ steps: p.steps.map((s) => `${s.coin ? s.coin.cityId : s.quoteMint}:${s.kind}:${s.position?.nftMint ?? ''}`), notes: p.notes.map((n) => `${n.cityId}:${n.note}`) });
    assert.deepEqual(view(b), view(a));
    assert.ok(view(a).steps.includes('100007:migrate:'));
    assert.ok(view(a).steps.includes('100002:harvestCurve:'));
    // and running it through that path works too
    const r = await pass(true, connectionReader(fakeConnection(w)));
    assert.ok(r.results.length > 0);
    assert.equal(w.pool(G.dbcPool).isMigrated, 1);
  });

  it('TI07 the keeper recreates the dev wallet\'s referral account, and ignores positions that are not in the coin\'s own pool', async () => {
    // (a) the dev wallet closed (unwrapped) its WSOL account: every site trade would fail until it is back
    const ref = ata(ADDRESSES.feeRecipient, WSOL);
    if (!w.exists(ref)) await w.send([C.createAtaIdempotent({ payer: keeper.address, owner: ADDRESSES.feeRecipient, mint: WSOL })], [keeper], 'make it exist first', { feePayer: keeper });
    await w.sendAsDevWallet([{ programAddress: PROGRAM_IDS.token, accounts: [{ address: ref, role: 1 }, { address: ADDRESSES.feeRecipient, role: 1 }, { address: ADDRESSES.feeRecipient, role: 2 }], data: new Uint8Array([9]) }], 'dev wallet unwraps its WSOL');
    assert.equal(w.exists(ref), false);
    let r = await pass(false); // even the minute pass
    assert.ok(r.steps.some((s) => s.kind === 'referralAccount' && s.quoteMint === WSOL));
    assert.equal(w.exists(ref), true, 'recreated');
    r = await pass(false);
    assert.ok(!r.steps.some((s) => s.kind === 'referralAccount'), 'nothing to do once it exists');
    // (b) someone opens another pool for the same pair and sends its position NFT to the Coin PDA (simulated by copying accounts)
    const F = coins.F;
    const real = (await loadState(svmReader(w))).coins.find((c) => c.cityId === 100006n).positions[0];
    assert.equal(real.pool, canonicalPool(F));
    const strangersPool = web3.Keypair.generate().publicKey;
    w.setRaw(strangersPool.toBase58(), Buffer.from(w.account(real.pool).data), PROGRAM_IDS.damm);
    const nft = web3.Keypair.generate().publicKey;
    w.setRaw(web3.Keypair.generate().publicKey.toBase58(), tokenAccountData({ mint: nft.toBase58(), owner: F.address, amount: 1n }), PROGRAM_IDS.token2022);
    const posBuf = Buffer.from(w.account(real.position).data);
    const v = byteView(IDL.damm, 'Position', posBuf, 8);
    v.nft_mint = nft;
    v.pool = strangersPool;
    w.setRaw(damm.position(nft.toBase58()), posBuf, PROGRAM_IDS.damm);
    const st = await loadState(svmReader(w));
    const f = st.coins.find((c) => c.cityId === 100006n);
    assert.deepEqual(f.positions.map((p) => p.nftMint), [real.nftMint], 'only the city\'s position in its own pool');
    assert.equal(f.ignoredPositions, 1);
    const p = planKeeper(st, { daily: true });
    assert.equal(p.steps.filter((s) => s.kind === 'harvestPool' && s.coin.cityId === 100006n).length, 1);
    assert.match(p.notes.find((n) => n.cityId === 100006n).note, /1 position NFT\(s\).*ignored/);
  });

  it('TI08 on a public RPC, which refuses to scan the token programs, the keeper finds the city\'s pool positions and plans the same', async () => {
    const pub = fakeConnection(w, { publicRpc: true });
    await assert.rejects(pub.getProgramAccounts(new web3.PublicKey(PROGRAM_IDS.token2022)), /secondary indexes/);
    // the keeper's old query (owner memcmp only, no size or state filter) is exactly what the public RPC refuses
    const someCoin = (await loadState(svmReader(w))).coins[0].address;
    await assert.rejects(pub.getProgramAccounts(new web3.PublicKey(PROGRAM_IDS.token2022), { filters: [{ memcmp: { offset: 32, bytes: someCoin } }] }), /secondary indexes/);
    const a = await loadState(svmReader(w));
    const b = await loadState(connectionReader(pub));
    const positions = (st) => st.coins.map((c) => `${c.cityId}:${c.positions.map((p) => p.nftMint).join(',')}:${c.ignoredPositions}`);
    assert.deepEqual(positions(b), positions(a));
    assert.ok(a.coins.some((c) => c.positions.length > 0), 'a graduated coin holds its locked pool position');
    const view = (p) => ({ steps: p.steps.map((s) => `${s.coin ? s.coin.cityId : s.quoteMint}:${s.kind}:${s.position?.nftMint ?? ''}`), notes: p.notes.map((n) => `${n.cityId}:${n.note}`) });
    assert.deepEqual(view(planKeeper(b, { daily: true })), view(planKeeper(a, { daily: true })));
  });
});
