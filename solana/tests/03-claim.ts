// Spec 4.7 and 5: claim happy paths with exact balances, and every failure case.
// After each failing claim the vault balance is asserted unchanged.
import { Keypair } from "@solana/web3.js";
import {
  ANCHOR,
  City,
  Holders,
  accountExists,
  airdrop,
  assertInvariants,
  claim,
  claimStatusAddress,
  claimantAta,
  client,
  createCity,
  createTokenAccount,
  expect,
  expectEvent,
  expectError,
  fetchConfig,
  fetchEpoch,
  fundEpoch,
  fundedKeypair,
  makeHolders,
  nowOnChain,
  sha256,
  solBalance,
  tokenBalance,
  vaultBalance,
  getProof,
  big,
} from "./helpers";
import { getProof as sdkGetProof } from "./merkle-types";

describe("03 claim: exact payouts, double claim, wrong proofs, cap, pause", () => {
  let city: City;
  let h: Holders;
  let epochIndex: bigint;
  const DEPOSIT = 1_600n; // leaves total 1,500: 100 of dust stays for carry-over
  let vault: bigint;

  before(async () => {
    city = await createCity({ model: "holders", name: "claims" });
    h = makeHolders([100n, 200n, 300n, 400n, 500n]);
    for (const kp of h.keypairs) await airdrop(kp.publicKey, 1);
    const r = await fundEpoch(city, { amount: DEPOSIT, tree: h.tree });
    epochIndex = r.index;
    vault = DEPOSIT;
  });

  afterEach(async () => {
    await assertInvariants(city);
    expect(await vaultBalance(city), "vault balance tracked by the test").to.equal(vault);
  });

  it("holder 0 claims 100: ATA created and credited, vault debited, epoch and totals updated, status written, event emitted", async () => {
    const kp = h.keypairs[0];
    const ataAddr = claimantAta(city, kp.publicKey);
    expect(await accountExists(ataAddr)).to.equal(false);
    const solBefore = await solBalance(kp.publicKey);
    const now = await nowOnChain();

    const sig = await claim(city, { epochIndex, tree: h.tree, leafIndex: 0, claimant: kp });
    vault -= 100n;

    expect(await tokenBalance(ataAddr)).to.equal(100n);
    expect(await vaultBalance(city)).to.equal(vault);
    const e = await fetchEpoch(city, epochIndex);
    expect(e.claimedAmount).to.equal(100n);
    expect(e.state).to.equal("open");
    expect((await fetchConfig(city)).totalClaimed).to.equal(100n);

    const status = await client.fetchClaimStatus(claimStatusAddress(city, epochIndex, kp.publicKey));
    expect(status, "ClaimStatus exists").to.not.equal(null);
    expect(status!.claimant.equals(kp.publicKey)).to.equal(true);
    expect(status!.amount).to.equal(100n);
    expect(Math.abs(status!.claimedAt - now)).to.be.lessThan(120);

    const ev = expectEvent(await client.eventsOf(sig), "Claimed");
    expect(ev.claimant.equals(kp.publicKey)).to.equal(true);
    expect(Number(ev.leafIndex)).to.equal(0);
    expect(big(ev.amount)).to.equal(100n);
    expect(big(ev.epochClaimedAmount)).to.equal(100n);
    expect(big(ev.index)).to.equal(epochIndex);

    // the claimant paid rent for its ATA and ClaimStatus plus the fee
    expect(await solBalance(kp.publicKey)).to.be.lessThan(solBefore);
  });

  it("holder 3 claims 400 from the same epoch", async () => {
    const kp = h.keypairs[3];
    await claim(city, { epochIndex, tree: h.tree, leafIndex: 3, claimant: kp });
    vault -= 400n;
    expect(await tokenBalance(claimantAta(city, kp.publicKey))).to.equal(400n);
    expect((await fetchEpoch(city, epochIndex)).claimedAmount).to.equal(500n);
    expect((await fetchConfig(city)).totalClaimed).to.equal(500n);
  });

  it("double claim fails at account creation (ClaimStatus already exists)", async () => {
    await expectError(claim(city, { epochIndex, tree: h.tree, leafIndex: 0, claimant: h.keypairs[0] }), ANCHOR.AlreadyInUse);
    expect(await tokenBalance(claimantAta(city, h.keypairs[0].publicKey))).to.equal(100n);
  });

  it("wrong amount is rejected (InvalidProof)", async () => {
    await expectError(claim(city, { epochIndex, tree: h.tree, leafIndex: 1, claimant: h.keypairs[1], amount: 201n }), "InvalidProof");
    await expectError(claim(city, { epochIndex, tree: h.tree, leafIndex: 1, claimant: h.keypairs[1], amount: 199n }), "InvalidProof");
    await expectError(claim(city, { epochIndex, tree: h.tree, leafIndex: 1, claimant: h.keypairs[1], amount: 500n }), "InvalidProof");
  });

  it("another leaf's index with my own proof is rejected (InvalidProof)", async () => {
    // leaf 2 belongs to holder 2; holder 1 presents index 2 with leaf 2's amount and proof
    await expectError(claim(city, { epochIndex, tree: h.tree, leafIndex: 2, claimant: h.keypairs[1] }), "InvalidProof");
  });

  it("leaf index out of range is rejected before any hashing (LeafIndexOutOfRange)", async () => {
    const args = { amount: 200n, proof: getProof(h.tree, 1) };
    await expectError(claim(city, { epochIndex, leafIndex: 5, claimant: h.keypairs[1], ...args }), "LeafIndexOutOfRange");
    await expectError(claim(city, { epochIndex, leafIndex: 4_294_967_295, claimant: h.keypairs[1], ...args }), "LeafIndexOutOfRange");
  });

  it("another leaf's proof is rejected (InvalidProof)", async () => {
    await expectError(claim(city, { epochIndex, leafIndex: 1, claimant: h.keypairs[1], amount: 200n, proof: getProof(h.tree, 4) }), "InvalidProof");
  });

  it("another wallet cannot use my leaf (InvalidProof)", async () => {
    const thief = await fundedKeypair(1);
    await expectError(claim(city, { epochIndex, leafIndex: 1, claimant: thief, amount: 200n, proof: getProof(h.tree, 1) }), "InvalidProof");
    await expectError(claim(city, { epochIndex, leafIndex: 1, claimant: h.keypairs[2], amount: 200n, proof: getProof(h.tree, 1) }), "InvalidProof");
    expect(await accountExists(claimantAta(city, thief.publicKey))).to.equal(false);
  });

  it("truncated proof is rejected (InvalidProof)", async () => {
    const proof = getProof(h.tree, 1);
    await expectError(claim(city, { epochIndex, leafIndex: 1, claimant: h.keypairs[1], amount: 200n, proof: proof.slice(0, -1) }), "InvalidProof");
    await expectError(claim(city, { epochIndex, leafIndex: 1, claimant: h.keypairs[1], amount: 200n, proof: proof.slice(1) }), "InvalidProof");
    await expectError(claim(city, { epochIndex, leafIndex: 1, claimant: h.keypairs[1], amount: 200n, proof: [] }), "InvalidProof");
  });

  it("overlong proof is rejected: one extra element (InvalidProof), 33 elements (ProofTooLong)", async () => {
    const proof = getProof(h.tree, 1);
    await expectError(
      claim(city, { epochIndex, leafIndex: 1, claimant: h.keypairs[1], amount: 200n, proof: [...proof, sha256(Buffer.from("extra"))] }),
      "InvalidProof"
    );
    const long = Array.from({ length: 33 }, (_, i) => sha256(Buffer.from(`x${i}`)));
    await expectError(claim(city, { epochIndex, leafIndex: 1, claimant: h.keypairs[1], amount: 200n, proof: long }), "ProofTooLong");
    const long32 = long.slice(0, 32);
    await expectError(claim(city, { epochIndex, leafIndex: 1, claimant: h.keypairs[1], amount: 200n, proof: long32 }), "InvalidProof");
  });

  it("tampered sibling is rejected (InvalidProof)", async () => {
    const proof = getProof(h.tree, 1).map((p) => Uint8Array.from(p));
    proof[0][0] ^= 1;
    await expectError(claim(city, { epochIndex, leafIndex: 1, claimant: h.keypairs[1], amount: 200n, proof }), "InvalidProof");
  });

  it("amount 0 is rejected (ZeroClaimAmount)", async () => {
    await expectError(claim(city, { epochIndex, leafIndex: 1, claimant: h.keypairs[1], amount: 0n, proof: getProof(h.tree, 1) }), "ZeroClaimAmount");
  });

  it("claim while paused fails; after unpause the same claim succeeds", async () => {
    await client.pause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc();
    await expectError(claim(city, { epochIndex, tree: h.tree, leafIndex: 1, claimant: h.keypairs[1] }), "Paused");
    expect(await vaultBalance(city)).to.equal(vault);
    await client.unpause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc();
    await claim(city, { epochIndex, tree: h.tree, leafIndex: 1, claimant: h.keypairs[1] });
    vault -= 200n;
    expect(await tokenBalance(claimantAta(city, h.keypairs[1].publicKey))).to.equal(200n);
  });

  it("claim on an epoch index that does not exist fails (AccountNotInitialized)", async () => {
    await expectError(claim(city, { epochIndex: 9n, tree: h.tree, leafIndex: 2, claimant: h.keypairs[2] }), ANCHOR.AccountNotInitialized);
  });

  it("a claimant with an existing ATA keeps the old balance (init_if_needed does not re-create)", async () => {
    const kp = h.keypairs[4];
    const ataAddr = await createTokenAccount(city.rewardMint, kp.publicKey, 50n);
    expect(ataAddr.equals(claimantAta(city, kp.publicKey))).to.equal(true);
    await claim(city, { epochIndex, tree: h.tree, leafIndex: 4, claimant: kp });
    vault -= 500n;
    expect(await tokenBalance(ataAddr)).to.equal(550n);
  });

  it("claim status cannot be closed while the epoch is open (EpochStillOpen)", async () => {
    await expectError(
      client.closeClaimStatus({ claimant: h.keypairs[0].publicKey, cityCoinMint: city.cityCoinMint, epochIndex }).signers([h.keypairs[0]]).rpc(),
      "EpochStillOpen"
    );
    expect(await accountExists(claimStatusAddress(city, epochIndex, h.keypairs[0].publicKey))).to.equal(true);
  });

  it("the remaining leaf (holder 2) claims; dust of 100 stays in the vault for carry-over", async () => {
    await claim(city, { epochIndex, tree: h.tree, leafIndex: 2, claimant: h.keypairs[2] });
    vault -= 300n;
    expect(vault).to.equal(100n);
    const e = await fetchEpoch(city, epochIndex);
    expect(e.claimedAmount).to.equal(1_500n);
    expect(e.holdersAmount - e.claimedAmount).to.equal(100n);
  });

  describe("cap: a crafted root whose leaves exceed the deposit can never drain the vault", () => {
    let c2: City;
    let hh: Holders;
    before(async () => {
      c2 = await createCity({ model: "holders", name: "cap" });
      hh = makeHolders([600n, 600n, 600n]); // 1,800 promised, 1,000 deposited
      for (const kp of hh.keypairs) await airdrop(kp.publicKey, 1);
      await fundEpoch(c2, { amount: 1_000n, tree: hh.tree });
    });
    afterEach(async () => assertInvariants(c2));

    it("the first claim within the cap succeeds, the next one fails at the cap (ClaimExceedsHoldersAmount)", async () => {
      await claim(c2, { epochIndex: 0, tree: hh.tree, leafIndex: 0, claimant: hh.keypairs[0] });
      expect(await vaultBalance(c2)).to.equal(400n);
      await expectError(claim(c2, { epochIndex: 0, tree: hh.tree, leafIndex: 1, claimant: hh.keypairs[1] }), "ClaimExceedsHoldersAmount");
      await expectError(claim(c2, { epochIndex: 0, tree: hh.tree, leafIndex: 2, claimant: hh.keypairs[2] }), "ClaimExceedsHoldersAmount");
      expect(await vaultBalance(c2)).to.equal(400n);
      const e = await fetchEpoch(c2, 0);
      expect(e.claimedAmount).to.equal(600n);
      expect(e.holdersAmount).to.equal(1_000n);
      expect(await accountExists(claimStatusAddress(c2, 0, hh.keypairs[1].publicKey))).to.equal(false);
    });
  });

  describe("Creator epochs have nothing to claim", () => {
    it("claim on a Creator epoch fails (LeafIndexOutOfRange, num_leaves is 0)", async () => {
      const c3 = await createCity({ model: "creator", name: "creator-claim" });
      await fundEpoch(c3, { amount: 1_000n });
      const kp = await fundedKeypair(1);
      await expectError(claim(c3, { epochIndex: 0, leafIndex: 0, claimant: kp, amount: 1n, proof: [] }), "LeafIndexOutOfRange");
      expect(await vaultBalance(c3)).to.equal(0n);
      await assertInvariants(c3);
    });
  });

  it("a stranger cannot claim with a random proof on a real leaf index", async () => {
    const stranger = await fundedKeypair(1);
    const fake = Array.from({ length: 3 }, (_, i) => sha256(Buffer.from(`fake${i}`)));
    await expectError(claim(city, { epochIndex, leafIndex: 0, claimant: stranger, amount: 100n, proof: fake }), "InvalidProof");
    expect(sdkGetProof(h.tree, 0).length).to.be.greaterThan(0);
    expect(Keypair.generate().publicKey.equals(stranger.publicKey)).to.equal(false);
  });
});
