// Spec 5: a 2,000-leaf tree (depth 11) with several claims, a 1-leaf tree, and
// the compute-unit measurement of `claim` at proof depth 11, 20 and 22.
//
// 22 is the deepest proof a legacy transaction can carry (1232-byte runtime
// limit; see MAX_PROOF_DEPTH_LEGACY_TX in helpers.ts), i.e. trees of up to
// 2^22 = 4,194,304 leaves. The on-chain cap of 32 is never reachable and is
// defence in depth. The CU lines are printed as "CU_RESULT ..." for AUDIT.md.
import {
  City,
  MAX_LEGACY_TX_BYTES,
  MAX_PROOF_DEPTH_LEGACY_TX,
  airdrop,
  assertInvariants,
  claim,
  claimTx,
  claimantAta,
  claimantTransaction,
  client,
  connection,
  craftDeepProof,
  createCity,
  expect,
  fetchEpoch,
  fundEpoch,
  fundedKeypair,
  hashLeaf,
  makeHolders,
  sendSigned,
  tokenBalance,
  vaultBalance,
  getProof,
} from "./helpers";
import { parseComputeUnits } from "../sdk/client";

const CU_LIMIT = 200_000;
const cuResults: Array<{ depth: number; bytes: number; simulated: number; executed: number }> = [];

// Simulates and then executes the claim as a wallet would send it: one legacy
// transaction, the claimant as the only signer and fee payer.
async function measure(city: City, o: Parameters<typeof claimTx>[1], depth: number): Promise<{ simulated: number; executed: number; bytes: number }> {
  const ix = await (await claimTx(city, o)).instruction();
  const tx = await claimantTransaction([ix], o.claimant);
  const bytes = tx.serialize().length;
  expect(bytes).to.be.at.most(MAX_LEGACY_TX_BYTES);
  const sim = await connection.simulateTransaction(tx);
  expect(sim.value.err, `simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`).to.equal(null);
  const simulated = sim.value.unitsConsumed ?? parseComputeUnits(sim.value.logs ?? [], client.programId) ?? -1;
  const sig = await sendSigned(tx);
  const executed = (await client.computeUnitsOf(sig)) ?? -1;
  cuResults.push({ depth, bytes, simulated, executed });
  console.log(`      CU_RESULT claim depth=${depth} tx_bytes=${bytes} simulated=${simulated} executed=${executed} limit=${CU_LIMIT}`);
  return { simulated, executed, bytes };
}

describe("06 large tree, single leaf, compute units, transaction size", () => {
  it("2,000 leaves: depth 11, several claims pay exact amounts, proofs never longer than 11", async function () {
    this.timeout(600_000);
    const city = await createCity({ model: "holders", name: "large" });
    const amounts = Array.from({ length: 2_000 }, (_, i) => BigInt(i + 1));
    const h = makeHolders(amounts);
    expect(h.tree.depth).to.equal(11);
    expect(h.total).to.equal(2_001_000n);
    await fundEpoch(city, { amount: h.total, tree: h.tree });
    expect((await fetchEpoch(city, 0)).numLeaves).to.equal(2_000);

    const picks = [0, 1, 999, 1_000, 1_998, 1_999, 1_337, 42];
    let vault = h.total;
    for (const i of picks) {
      const kp = h.keypairs[i];
      await airdrop(kp.publicKey, 1);
      const depth = getProof(h.tree, i).length;
      expect(depth).to.be.at.most(11);
      const { executed } = await measure(city, { epochIndex: 0, tree: h.tree, leafIndex: i, claimant: kp }, depth);
      expect(executed).to.be.greaterThan(0).and.lessThan(CU_LIMIT);
      vault -= amounts[i];
      expect(await tokenBalance(claimantAta(city, kp.publicKey))).to.equal(amounts[i]);
      expect(await vaultBalance(city)).to.equal(vault);
    }
    const e = await fetchEpoch(city, 0);
    expect(e.claimedAmount).to.equal(picks.reduce((s, i) => s + amounts[i], 0n));
    await assertInvariants(city);
  });

  it("1-leaf tree: root equals the leaf hash and an empty proof claims", async () => {
    const city = await createCity({ model: "holders", name: "one-leaf" });
    const h = makeHolders([777n]);
    expect(h.tree.depth).to.equal(0);
    expect(Buffer.from(h.tree.root).equals(Buffer.from(hashLeaf(0, h.keypairs[0].publicKey.toBytes(), 777n)))).to.equal(true);
    expect(getProof(h.tree, 0)).to.deep.equal([]);
    await fundEpoch(city, { amount: 777n, tree: h.tree });
    await airdrop(h.keypairs[0].publicKey, 1);
    await claim(city, { epochIndex: 0, tree: h.tree, leafIndex: 0, claimant: h.keypairs[0] });
    expect(await tokenBalance(claimantAta(city, h.keypairs[0].publicKey))).to.equal(777n);
    expect(await vaultBalance(city)).to.equal(0n);
    await assertInvariants(city);
  });

  for (const depth of [20, MAX_PROOF_DEPTH_LEGACY_TX]) {
    it(`claim at proof depth ${depth} stays under ${CU_LIMIT} CU (simulated and executed)`, async () => {
      const city = await createCity({ model: "holders", name: `depth-${depth}` });
      const claimant = await fundedKeypair(1);
      const numLeaves = 2 ** depth;
      const leafIndex = numLeaves - 1;
      const amount = 123_456n;
      const crafted = craftDeepProof(leafIndex, claimant.publicKey, amount, depth);
      await fundEpoch(city, { amount: 1_000_000n, root: crafted.root, numLeaves });
      const { simulated, executed } = await measure(city, { epochIndex: 0, leafIndex, amount, proof: crafted.proof, claimant }, depth);
      expect(simulated).to.be.lessThan(CU_LIMIT);
      expect(executed).to.be.lessThan(CU_LIMIT);
      expect(await tokenBalance(claimantAta(city, claimant.publicKey))).to.equal(amount);
      await assertInvariants(city);
    });
  }

  it(`depth ${MAX_PROOF_DEPTH_LEGACY_TX + 1} does not fit in a legacy transaction (practical limit, documented for the snapshot job)`, async () => {
    const city = await createCity({ model: "holders", name: "depth-limit" });
    const claimant = await fundedKeypair(1);
    const depth = MAX_PROOF_DEPTH_LEGACY_TX + 1;
    const crafted = craftDeepProof(0, claimant.publicKey, 1n, depth);
    await fundEpoch(city, { amount: 1_000n, root: crafted.root, numLeaves: 2 ** depth });
    const ix = await (await claimTx(city, { epochIndex: 0, leafIndex: 0, amount: 1n, proof: crafted.proof, claimant })).instruction();
    const tx = await claimantTransaction([ix], claimant);
    expect(() => tx.serialize()).to.throw(/Transaction too large/);
    await assertInvariants(city);
  });

  after(() => {
    if (cuResults.length) {
      console.log("\n      CU summary (copy into AUDIT.md):");
      for (const r of cuResults) console.log(`      depth ${String(r.depth).padStart(2)}: tx ${r.bytes} bytes, simulated ${r.simulated} CU, executed ${r.executed} CU`);
      console.log(`      deepest proof in one legacy transaction: ${MAX_PROOF_DEPTH_LEGACY_TX} (2^${MAX_PROOF_DEPTH_LEGACY_TX} = ${(2 ** MAX_PROOF_DEPTH_LEGACY_TX).toLocaleString("en-US")} leaves)`);
    }
  });
});
