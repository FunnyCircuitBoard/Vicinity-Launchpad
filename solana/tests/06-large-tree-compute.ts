// Spec 5: a 2,000-leaf tree (depth 11) with several claims, a 1-leaf tree, and
// the compute-unit measurement of `claim` at proof depth 11, 20 and 32 (cap).
// The CU lines are printed as "CU_RESULT ..." for AUDIT.md.
import { Transaction } from "@solana/web3.js";
import {
  City,
  airdrop,
  assertInvariants,
  claim,
  claimTx,
  claimantAta,
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
  tokenBalance,
  vaultBalance,
  getProof,
} from "./helpers";
import { parseComputeUnits } from "../sdk/client";

const CU_LIMIT = 200_000;
const cuResults: Array<{ depth: number; simulated?: number; executed?: number }> = [];

async function measure(city: City, o: Parameters<typeof claimTx>[1], depth: number): Promise<{ simulated: number; executed: number }> {
  const builder = await claimTx(city, o);
  const tx: Transaction = await builder.transaction();
  tx.feePayer = o.claimant.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(o.claimant);
  const sim = await connection.simulateTransaction(tx);
  expect(sim.value.err, `simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).join("\n")}`).to.equal(null);
  const simulated = sim.value.unitsConsumed ?? parseComputeUnits(sim.value.logs ?? [], client.programId) ?? -1;
  const sig = await builder.signers([o.claimant]).rpc();
  const executed = (await client.computeUnitsOf(sig)) ?? -1;
  cuResults.push({ depth, simulated, executed });
  console.log(`      CU_RESULT claim depth=${depth} simulated=${simulated} executed=${executed} limit=${CU_LIMIT}`);
  return { simulated, executed };
}

describe("06 large tree, single leaf, compute units", () => {
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
      expect(getProof(h.tree, i).length).to.be.at.most(11);
      const { executed } = await measure(city, { epochIndex: 0, tree: h.tree, leafIndex: i, claimant: kp }, getProof(h.tree, i).length);
      expect(executed).to.be.greaterThan(0);
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

  for (const depth of [20, 32]) {
    it(`claim at proof depth ${depth} stays under ${CU_LIMIT} CU (simulated and executed)`, async () => {
      const city = await createCity({ model: "holders", name: `depth-${depth}` });
      const claimant = await fundedKeypair(1);
      const leafIndex = depth === 32 ? 4_294_967_294 : 777_777;
      const numLeaves = depth === 32 ? 4_294_967_295 : 1 << 20;
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

  after(() => {
    if (cuResults.length) {
      console.log("\n      CU summary (copy into AUDIT.md):");
      for (const r of cuResults) console.log(`      depth ${String(r.depth).padStart(2)}: simulated ${r.simulated} CU, executed ${r.executed} CU`);
    }
  });
});
