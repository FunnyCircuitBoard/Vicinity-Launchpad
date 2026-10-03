// Spec 4.6 and 5: fund_epoch economics for Creator / Holders / Split 25/50/75,
// exact rounding, auto-lock, window bounds, funder checks, immutability.
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ANCHOR,
  City,
  accountExists,
  assertInvariants,
  ata,
  client,
  createCity,
  createMint,
  createTokenAccount,
  economicsOf,
  epochAddress,
  expect,
  expectEvent,
  expectError,
  fetchConfig,
  fetchEpoch,
  founderAta,
  founderBalance,
  fundEpoch,
  fundEpochTx,
  fundedKeypair,
  makeHolders,
  nowOnChain,
  splitAmount,
  tokenBalance,
  vaultBalance,
  windowBounds,
  big,
  bytesOf,
} from "./helpers";

describe("02 fund_epoch: amounts, rounding, carry-over, auto-lock, window, funder checks", () => {
  const cities: City[] = [];
  afterEach(async () => {
    for (const c of cities) await assertInvariants(c);
  });

  it("Creator: the whole amount goes to the founder; an empty epoch is recorded as audit trail", async () => {
    const city = await createCity({ model: "creator" });
    cities.push(city);
    const amount = 1_000_000n;
    const funderBefore = await tokenBalance(city.funderTokenAccount);
    const now = await nowOnChain();
    const { signature, epochView: e, config: cfg } = await fundEpoch(city, { amount });

    expect(await founderBalance(city)).to.equal(amount);
    expect(await vaultBalance(city)).to.equal(0n);
    expect(await tokenBalance(city.funderTokenAccount)).to.equal(funderBefore - amount);

    expect(e.index).to.equal(0n);
    expect(e.state).to.equal("open");
    expect(e.holdersAmount).to.equal(0n);
    expect(e.claimedAmount).to.equal(0n);
    expect(e.numLeaves).to.equal(0);
    expect(bytesOf(e.merkleRoot).equals(Buffer.alloc(32))).to.equal(true);
    expect(e.depositAmount).to.equal(amount);
    expect(e.founderAmount).to.equal(amount);
    expect(e.claimDeadline - e.fundedAt).to.equal(windowBounds().min);
    expect(Math.abs(e.fundedAt - now)).to.be.lessThan(120);

    expect(cfg.locked, "auto-lock on first fund").to.equal(true);
    expect(cfg.epochCount).to.equal(1n);
    expect(cfg.carryOver).to.equal(0n);
    expect(cfg.totalFunded).to.equal(amount);
    expect(cfg.totalToFounder).to.equal(amount);
    expect(cfg.totalToHolders).to.equal(0n);
    expect(cfg.totalClaimed).to.equal(0n);

    const ev = expectEvent(await client.eventsOf(signature), "EpochFunded");
    expect(big(ev.index)).to.equal(0n);
    expect(big(ev.depositAmount)).to.equal(amount);
    expect(big(ev.founderAmount)).to.equal(amount);
    expect(big(ev.holdersDeposit)).to.equal(0n);
    expect(big(ev.carryIn)).to.equal(0n);
    expect(big(ev.holdersAmount)).to.equal(0n);
    expect(Number(ev.numLeaves)).to.equal(0);
    expect(ev.epoch.equals(epochAddress(city, 0))).to.equal(true);
  });

  it("Creator: a root or leaves are rejected (CreatorModelHasTree)", async () => {
    const city = await createCity({ model: "creator" });
    cities.push(city);
    const h = makeHolders([5n]);
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree }), "CreatorModelHasTree");
    await expectError(fundEpoch(city, { amount: 100n, numLeaves: 1 }), "CreatorModelHasTree");
    await expectError(fundEpoch(city, { amount: 100n, root: h.tree.root, numLeaves: 0 }), "CreatorModelHasTree");
    expect((await fetchConfig(city)).epochCount).to.equal(0n);
    expect(await accountExists(epochAddress(city, 0))).to.equal(false);
  });

  it("Holders: everything goes to the vault; the founder ATA is created but stays empty", async () => {
    const city = await createCity({ model: "holders" });
    cities.push(city);
    const h = makeHolders([1n, 2n, 3n]);
    const amount = 1_000_003n;
    const slot = 12_345n;
    const hash = new Uint8Array(32).fill(7);
    const { signature, epochView: e, config: cfg } = await fundEpoch(city, { amount, tree: h.tree, snapshotSlot: slot, snapshotHash: hash });
    expect(await vaultBalance(city)).to.equal(amount);
    expect(await accountExists(founderAta(city))).to.equal(true);
    expect(await founderBalance(city)).to.equal(0n);
    expect(e.holdersAmount).to.equal(amount);
    expect(e.founderAmount).to.equal(0n);
    expect(e.depositAmount).to.equal(amount);
    expect(e.numLeaves).to.equal(3);
    expect(bytesOf(e.merkleRoot).equals(bytesOf(h.tree.root))).to.equal(true);
    expect(e.snapshotSlot).to.equal(slot);
    expect(bytesOf(e.snapshotHash).equals(bytesOf(hash))).to.equal(true);
    expect(cfg.totalToHolders).to.equal(amount);
    expect(cfg.totalToFounder).to.equal(0n);
    const ev = expectEvent(await client.eventsOf(signature), "EpochFunded");
    expect(big(ev.holdersDeposit)).to.equal(amount);
    expect(big(ev.holdersAmount)).to.equal(amount);
    expect(bytesOf(ev.merkleRoot).equals(bytesOf(h.tree.root))).to.equal(true);
  });

  it("Holders / Split: zero root or zero leaves are rejected", async () => {
    const city = await createCity({ model: "holders" });
    cities.push(city);
    const h = makeHolders([1n, 2n, 3n]);
    await expectError(fundEpoch(city, { amount: 100n, numLeaves: 3 }), "MissingMerkleRoot");
    await expectError(fundEpoch(city, { amount: 100n, root: h.tree.root, numLeaves: 0 }), "MissingLeaves");
    await expectError(fundEpoch(city, { amount: 100n }), "MissingMerkleRoot");
    const split = await createCity({ model: "split", founderBps: 5_000 });
    cities.push(split);
    await expectError(fundEpoch(split, { amount: 100n, numLeaves: 3 }), "MissingMerkleRoot");
    await expectError(fundEpoch(split, { amount: 100n, root: h.tree.root, numLeaves: 0 }), "MissingLeaves");
    expect((await fetchConfig(city)).epochCount).to.equal(0n);
    expect((await fetchConfig(split)).epochCount).to.equal(0n);
  });

  for (const bps of [2_500, 5_000, 7_500]) {
    it(`Split ${bps / 100}%: founder share is floored, remainder goes to holders; two epochs add up exactly`, async () => {
      const city = await createCity({ model: "split", founderBps: bps });
      cities.push(city);
      const h = makeHolders([10n, 20n, 30n]);

      const a1 = 1_000_003n;
      const s1 = splitAmount(a1, bps);
      const r1 = await fundEpoch(city, { amount: a1, tree: h.tree });
      expect(await founderBalance(city)).to.equal(s1.founder);
      expect(await vaultBalance(city)).to.equal(s1.holders);
      expect(r1.epochView.founderAmount).to.equal(s1.founder);
      expect(r1.epochView.holdersAmount).to.equal(s1.holders);
      expect(s1.founder + s1.holders).to.equal(a1);
      // exact expectations, not just the formula
      const expected: Record<number, [bigint, bigint]> = { 2_500: [250_000n, 750_003n], 5_000: [500_001n, 500_002n], 7_500: [750_002n, 250_001n] };
      expect([s1.founder, s1.holders]).to.deep.equal(expected[bps]);

      const a2 = 7n;
      const s2 = splitAmount(a2, bps);
      const r2 = await fundEpoch(city, { amount: a2, tree: h.tree });
      const tiny: Record<number, [bigint, bigint]> = { 2_500: [1n, 6n], 5_000: [3n, 4n], 7_500: [5n, 2n] };
      expect([s2.founder, s2.holders]).to.deep.equal(tiny[bps]);
      expect(r2.index).to.equal(1n);
      expect(r2.epochView.founderAmount).to.equal(s2.founder);
      expect(r2.epochView.holdersAmount, "no carry-over yet, so holders_amount == holders deposit").to.equal(s2.holders);
      expect(await founderBalance(city)).to.equal(s1.founder + s2.founder);
      expect(await vaultBalance(city)).to.equal(s1.holders + s2.holders);
      const cfg = await fetchConfig(city);
      expect(cfg.epochCount).to.equal(2n);
      expect(cfg.totalFunded).to.equal(a1 + a2);
      expect(cfg.totalToFounder).to.equal(s1.founder + s2.founder);
      expect(cfg.totalToHolders).to.equal(s1.holders + s2.holders);
    });
  }

  it("tiny amounts: a founder share below one base unit floors to zero and holders get everything", async () => {
    const city = await createCity({ model: "split", founderBps: 2_500 });
    cities.push(city);
    const h = makeHolders([1n]);
    const r = await fundEpoch(city, { amount: 3n, tree: h.tree });
    expect(r.epochView.founderAmount).to.equal(0n);
    expect(r.epochView.holdersAmount).to.equal(3n);
    expect(await founderBalance(city)).to.equal(0n);
    expect(await vaultBalance(city)).to.equal(3n);
  });

  it("auto-lock: lock_config afterwards fails and no later instruction changes the economics", async () => {
    const city = await createCity({ model: "split", founderBps: 5_000 });
    cities.push(city);
    expect((await fetchConfig(city)).locked).to.equal(false);
    const h = makeHolders([1n, 2n]);
    await fundEpoch(city, { amount: 1_000n, tree: h.tree });
    const after = await fetchConfig(city);
    expect(after.locked).to.equal(true);
    await expectError(client.lockConfig({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc(), "AlreadyLocked");

    const auth = { authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint };
    await client.setFounder({ ...auth, newFounder: Keypair.generate().publicKey }).signers([city.authority]).rpc();
    await client.proposeAuthority({ ...auth, newAuthority: Keypair.generate().publicKey }).signers([city.authority]).rpc();
    await client.proposeAuthority({ ...auth, newAuthority: PublicKey.default }).signers([city.authority]).rpc();
    await client.pause(auth).signers([city.authority]).rpc();
    await client.unpause(auth).signers([city.authority]).rpc();
    await fundEpoch(city, { amount: 10n, tree: h.tree });
    expect(economicsOf(await fetchConfig(city))).to.deep.equal(economicsOf(after));
  });

  it("claim window must be within [MIN_CLAIM_WINDOW, MAX_CLAIM_WINDOW]; both bounds are accepted", async () => {
    const city = await createCity({ model: "holders" });
    cities.push(city);
    const h = makeHolders([1n, 2n]);
    const { min, max } = windowBounds();
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree, window: min - 1 }), "ClaimWindowOutOfRange");
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree, window: max + 1 }), "ClaimWindowOutOfRange");
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree, window: 0 }), "ClaimWindowOutOfRange");
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree, window: -1 }), "ClaimWindowOutOfRange");
    const rMin = await fundEpoch(city, { amount: 100n, tree: h.tree, window: min });
    expect(rMin.epochView.claimDeadline - rMin.epochView.fundedAt).to.equal(min);
    const rMax = await fundEpoch(city, { amount: 100n, tree: h.tree, window: max });
    expect(rMax.epochView.claimDeadline - rMax.epochView.fundedAt).to.equal(max);
  });

  it("amount 0 with no carry-over is rejected (NothingToDistribute)", async () => {
    const city = await createCity({ model: "holders" });
    cities.push(city);
    const h = makeHolders([1n]);
    await expectError(fundEpoch(city, { amount: 0n, tree: h.tree }), "NothingToDistribute");
    const creator = await createCity({ model: "creator" });
    cities.push(creator);
    await expectError(fundEpoch(creator, { amount: 0n }), "NothingToDistribute");
  });

  it("paused blocks funding; unpause restores it", async () => {
    const city = await createCity({ model: "holders" });
    cities.push(city);
    const h = makeHolders([1n]);
    await client.pause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc();
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree }), "Paused");
    expect(await vaultBalance(city)).to.equal(0n);
    await client.unpause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc();
    await fundEpoch(city, { amount: 100n, tree: h.tree });
    expect(await vaultBalance(city)).to.equal(100n);
  });

  it("non-authority cannot fund even with a willing funder", async () => {
    const city = await createCity({ model: "holders" });
    cities.push(city);
    const h = makeHolders([1n]);
    const stranger = await fundedKeypair(1);
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree, authority: stranger }), "Unauthorized");
    expect((await fetchConfig(city)).epochCount).to.equal(0n);
  });

  it("the funder may be the authority itself (one signer)", async () => {
    const ops = await fundedKeypair(2);
    const city = await createCity({ model: "holders", authority: ops, funder: ops });
    cities.push(city);
    const h = makeHolders([1n]);
    const r = await fundEpoch(city, { amount: 55n, tree: h.tree });
    expect(r.epochView.holdersAmount).to.equal(55n);
    expect(await vaultBalance(city)).to.equal(55n);
  });

  it("funder token account must hold the reward mint and belong to the funder", async () => {
    const city = await createCity({ model: "holders" });
    cities.push(city);
    const h = makeHolders([1n]);
    const otherMint = await createMint();
    const wrongMintAccount = await createTokenAccount(otherMint, city.funder.publicKey, 1_000_000n);
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree, funderTokenAccount: wrongMintAccount }), ANCHOR.ConstraintTokenMint);
    const other = await fundedKeypair(1);
    const othersAccount = await createTokenAccount(city.rewardMint, other.publicKey, 1_000_000n);
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree, funderTokenAccount: othersAccount }), ANCHOR.ConstraintTokenOwner);
    expect(await vaultBalance(city)).to.equal(0n);
    expect(await tokenBalance(othersAccount)).to.equal(1_000_000n);
  });

  it("insufficient funder balance fails inside the token program and records nothing", async () => {
    const city = await createCity({ model: "holders", funderBalance: 10n });
    cities.push(city);
    const h = makeHolders([1n]);
    await expectError(fundEpoch(city, { amount: 11n, tree: h.tree }), ANCHOR.InsufficientFunds);
    expect((await fetchConfig(city)).epochCount).to.equal(0n);
    expect(await accountExists(epochAddress(city, 0))).to.equal(false);
    expect(await vaultBalance(city)).to.equal(0n);
    await fundEpoch(city, { amount: 10n, tree: h.tree });
    expect(await vaultBalance(city)).to.equal(10n);
  });

  it("the epoch account must be the PDA for the current epoch_count", async () => {
    const city = await createCity({ model: "holders" });
    cities.push(city);
    const h = makeHolders([1n]);
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree, overrides: { epoch: epochAddress(city, 7) } }), ANCHOR.ConstraintSeeds);
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree, overrides: { epoch: Keypair.generate().publicKey } }), ANCHOR.ConstraintSeeds);
    await fundEpoch(city, { amount: 100n, tree: h.tree });
    // after one epoch the next index is 1; index 0 exists and cannot be re-created
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree, overrides: { epoch: epochAddress(city, 0) } }), ANCHOR.ConstraintSeeds);
  });

  it("founder token account must be the founder's ATA of the reward mint", async () => {
    const city = await createCity({ model: "split", founderBps: 5_000 });
    cities.push(city);
    const h = makeHolders([1n]);
    const stranger = await fundedKeypair(1);
    const strangersAta = await createTokenAccount(city.rewardMint, stranger.publicKey, 0n);
    await expectError(
      fundEpoch(city, { amount: 100n, tree: h.tree, overrides: { founderTokenAccount: strangersAta } }),
      ANCHOR.ConstraintAssociated,
      ANCHOR.ConstraintTokenOwner,
      ANCHOR.AccountNotAssociatedTokenAccount,
      ANCHOR.ConstraintSeeds
    );
    // a non-ATA token account owned by the founder is not accepted either (must be the ATA)
    await expectError(
      fundEpoch(city, { amount: 100n, tree: h.tree, overrides: { founderTokenAccount: city.funderTokenAccount } }),
      ANCHOR.ConstraintAssociated,
      ANCHOR.ConstraintTokenOwner,
      ANCHOR.AccountNotAssociatedTokenAccount,
      ANCHOR.ConstraintSeeds
    );
    expect(await tokenBalance(strangersAta)).to.equal(0n);
    expect(await vaultBalance(city)).to.equal(0n);
    // the founder account passed must be config.founder
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree, founder: stranger.publicKey }), ANCHOR.ConstraintHasOne);
    // and with the real founder it works
    await fundEpoch(city, { amount: 100n, tree: h.tree });
    expect(await tokenBalance(ata(city.rewardMint, city.founder.publicKey))).to.equal(50n);
  });

  it("reward mint account must be config.reward_mint", async () => {
    const city = await createCity({ model: "holders" });
    cities.push(city);
    const h = makeHolders([1n]);
    const otherMint = await createMint();
    await expectError(fundEpoch(city, { amount: 100n, tree: h.tree, rewardMint: otherMint }), ANCHOR.ConstraintHasOne, ANCHOR.ConstraintTokenMint);
  });

  it("epoch fields are write-once: a second fund creates a new epoch and leaves epoch 0 untouched", async () => {
    const city = await createCity({ model: "holders" });
    cities.push(city);
    const h1 = makeHolders([1n, 2n]);
    const h2 = makeHolders([3n, 4n, 5n]);
    const r0 = await fundEpoch(city, { amount: 100n, tree: h1.tree });
    await fundEpoch(city, { amount: 200n, tree: h2.tree });
    const e0 = await fetchEpoch(city, 0);
    expect(bytesOf(e0.merkleRoot).equals(bytesOf(h1.tree.root))).to.equal(true);
    expect(e0.numLeaves).to.equal(2);
    expect(e0.holdersAmount).to.equal(100n);
    expect(e0.fundedAt).to.equal(r0.epochView.fundedAt);
    expect(e0.claimDeadline).to.equal(r0.epochView.claimDeadline);
    const e1 = await fetchEpoch(city, 1);
    expect(bytesOf(e1.merkleRoot).equals(bytesOf(h2.tree.root))).to.equal(true);
    expect(e1.numLeaves).to.equal(3);
    expect(e1.holdersAmount).to.equal(200n);
    expect((await fetchConfig(city)).epochCount).to.equal(2n);
  });

  it("fund_epoch via the raw builder: payer of the founder ATA rent is the funder", async () => {
    const city = await createCity({ model: "creator" });
    cities.push(city);
    const funderSolBefore = await client.connection.getBalance(city.funder.publicKey, "confirmed");
    const tx = await fundEpochTx(city, { amount: 1n });
    await tx.signers([city.authority, city.funder]).rpc();
    const funderSolAfter = await client.connection.getBalance(city.funder.publicKey, "confirmed");
    // the founder ATA (rent about 0.002 SOL) was paid by the funder
    expect(funderSolBefore - funderSolAfter).to.be.greaterThan(1_000_000);
  });
});
