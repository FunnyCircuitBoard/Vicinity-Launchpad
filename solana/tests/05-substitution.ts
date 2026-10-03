// Spec 5: account substitution attacks. Two cities A and B share a reward mint;
// city C has another reward mint. Every wrong account must be refused by a
// constraint, and no balance may move.
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ANCHOR,
  City,
  Holders,
  accountExists,
  airdrop,
  assertInvariants,
  ata,
  claim,
  claimStatusAddress,
  claimantAta,
  client,
  createCity,
  createMint,
  createTokenAccount,
  createTransferFeeMint,
  createClosableMint,
  epochAddress,
  expect,
  expectError,
  fetchConfig,
  fundEpoch,
  fundedKeypair,
  initCityTx,
  makeHolders,
  tokenBalance,
  vaultBalance,
} from "./helpers";

describe("05 account substitution attacks", () => {
  let A: City;
  let B: City;
  let C: City;
  let hA: Holders;
  let hB: Holders;
  let balances: Record<string, bigint> = {};

  async function snapshot() {
    balances = {
      vaultA: await vaultBalance(A),
      vaultB: await vaultBalance(B),
      vaultC: await vaultBalance(C),
    };
  }
  async function unchanged() {
    expect(await vaultBalance(A)).to.equal(balances.vaultA);
    expect(await vaultBalance(B)).to.equal(balances.vaultB);
    expect(await vaultBalance(C)).to.equal(balances.vaultC);
    for (const c of [A, B, C]) await assertInvariants(c);
  }

  before(async () => {
    A = await createCity({ model: "holders", name: "A" });
    B = await createCity({ model: "holders", name: "B", rewardMint: A.rewardMint });
    C = await createCity({ model: "split", founderBps: 5_000, name: "C" });
    hA = makeHolders([100n, 200n, 300n]);
    hB = makeHolders([1_000n, 2_000n]);
    for (const kp of [...hA.keypairs, ...hB.keypairs]) await airdrop(kp.publicKey, 1);
    await fundEpoch(A, { amount: 1_000n, tree: hA.tree });
    await fundEpoch(B, { amount: 5_000n, tree: hB.tree });
    await fundEpoch(C, { amount: 2_000n, tree: hA.tree });
    await snapshot();
  });
  afterEach(unchanged);

  describe("claim", () => {
    it("vault of another city (same reward mint) is refused", async () => {
      await expectError(claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 0, claimant: hA.keypairs[0], overrides: { vault: B.vault } }), ANCHOR.ConstraintSeeds, ANCHOR.ConstraintHasOne);
    });

    it("config of another city is refused (epoch and vault seeds no longer match)", async () => {
      await expectError(
        claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 0, claimant: hA.keypairs[0], overrides: { config: B.config } }),
        ANCHOR.ConstraintSeeds,
        ANCHOR.ConstraintHasOne
      );
    });

    it("epoch of another city with the same index is refused", async () => {
      await expectError(
        claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 0, claimant: hA.keypairs[0], overrides: { epoch: epochAddress(B, 0) } }),
        ANCHOR.ConstraintSeeds
      );
    });

    it("the whole account set of city B with a leaf of city A is refused (proof does not verify)", async () => {
      // claimant is in A's tree; presenting A's proof against B's root fails on the proof, not on accounts
      await expectError(
        claim(B, { epochIndex: 0, leafIndex: 0, claimant: hA.keypairs[0], amount: 100n, proof: hA.tree.layers.length > 1 ? [hA.tree.leafHashes[1], hA.tree.leafHashes[2]] : [] }),
        "InvalidProof"
      );
    });

    it("claim status PDA of another claimant is refused", async () => {
      await expectError(
        claim(A, {
          epochIndex: 0,
          tree: hA.tree,
          leafIndex: 0,
          claimant: hA.keypairs[0],
          overrides: { claimStatus: claimStatusAddress(A, 0, hA.keypairs[1].publicKey) },
        }),
        ANCHOR.ConstraintSeeds
      );
    });

    it("someone else's token account as destination is refused", async () => {
      const stranger = await fundedKeypair(1);
      const strangersAta = await createTokenAccount(A.rewardMint, stranger.publicKey, 0n);
      await expectError(
        claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 0, claimant: hA.keypairs[0], overrides: { claimantTokenAccount: strangersAta } }),
        ANCHOR.ConstraintAssociated,
        ANCHOR.ConstraintTokenOwner,
        ANCHOR.AccountNotAssociatedTokenAccount,
        ANCHOR.ConstraintSeeds
      );
      expect(await tokenBalance(strangersAta)).to.equal(0n);
    });

    it("a token account of another mint as destination is refused", async () => {
      const otherMint = await createMint();
      const wrong = await createTokenAccount(otherMint, hA.keypairs[0].publicKey, 0n);
      await expectError(
        claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 0, claimant: hA.keypairs[0], overrides: { claimantTokenAccount: wrong } }),
        ANCHOR.ConstraintAssociated,
        ANCHOR.ConstraintTokenMint,
        ANCHOR.AccountNotAssociatedTokenAccount,
        ANCHOR.ConstraintSeeds
      );
    });

    it("the reward mint of another city is refused (has_one), with a consistent or an inconsistent destination", async () => {
      // consistent attacker set: C's mint and the claimant's ATA for C's mint -> the config's has_one fires
      await expectError(
        claim(A, {
          epochIndex: 0,
          tree: hA.tree,
          leafIndex: 0,
          claimant: hA.keypairs[0],
          overrides: { rewardMint: C.rewardMint, claimantTokenAccount: ata(C.rewardMint, hA.keypairs[0].publicKey) },
        }),
        ANCHOR.ConstraintHasOne
      );
      // inconsistent set (C's mint, ATA for A's mint): the ATA program refuses first (init_if_needed runs before has_one)
      await expectError(
        claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 0, claimant: hA.keypairs[0], overrides: { rewardMint: C.rewardMint } }),
        ANCHOR.ConstraintHasOne,
        ANCHOR.UnknownAccount,
        ANCHOR.IncorrectProgramId
      );
      expect(await accountExists(ata(C.rewardMint, hA.keypairs[0].publicKey)), "the failed transaction left no ATA behind").to.equal(false);
    });

    it("a forged config account (random key, PDA of other seeds, another program's account) is refused", async () => {
      const random = Keypair.generate().publicKey;
      await expectError(
        claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 0, claimant: hA.keypairs[0], overrides: { config: random } }),
        ANCHOR.AccountNotInitialized,
        ANCHOR.ConstraintSeeds,
        ANCHOR.AccountOwnedByWrongProgram
      );
      const [otherSeeds] = PublicKey.findProgramAddressSync([Buffer.from("town"), A.cityCoinMint.toBuffer()], client.programId);
      await expectError(
        claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 0, claimant: hA.keypairs[0], overrides: { config: otherSeeds } }),
        ANCHOR.AccountNotInitialized,
        ANCHOR.ConstraintSeeds
      );
      // a real account owned by another program (the reward mint) in the config slot
      await expectError(
        claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 0, claimant: hA.keypairs[0], overrides: { config: A.rewardMint } }),
        ANCHOR.AccountOwnedByWrongProgram,
        ANCHOR.ConstraintSeeds,
        ANCHOR.AccountDiscriminatorMismatch
      );
    });

    it("the vault slot must be the vault PDA: a plain token account owned by the config is refused", async () => {
      await expectError(
        claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 0, claimant: hA.keypairs[0], overrides: { vault: A.funderTokenAccount } }),
        ANCHOR.ConstraintSeeds,
        ANCHOR.ConstraintHasOne
      );
    });

    it("wrong token program: Token-2022 for a classic mint, or the system program", async () => {
      // Token-2022 passed for a classic mint: the ATA program's CPI into Token-2022 refuses the classic mint
      // (init_if_needed runs before Anchor's mint::token_program check), so the refusal comes from the token program.
      await expectError(
        claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 0, claimant: hA.keypairs[0], tokenProgram: TOKEN_2022_PROGRAM_ID }),
        ANCHOR.ConstraintMintTokenProgram,
        ANCHOR.ConstraintTokenTokenProgram,
        ANCHOR.InvalidProgramId,
        ANCHOR.AccountOwnedByWrongProgram,
        ANCHOR.IncorrectProgramId
      );
      // with an already existing ATA (no init needed) the program's own constraint is what fires:
      // the claimant ATA's associated_token::token_program (classic) does not match the passed Token-2022
      await createTokenAccount(A.rewardMint, hA.keypairs[1].publicKey, 0n);
      await expectError(
        claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 1, claimant: hA.keypairs[1], overrides: { tokenProgram: TOKEN_2022_PROGRAM_ID } }),
        ANCHOR.ConstraintAssociatedTokenTokenProgram,
        ANCHOR.ConstraintMintTokenProgram,
        ANCHOR.ConstraintTokenTokenProgram,
        ANCHOR.InvalidProgramId,
        ANCHOR.AccountOwnedByWrongProgram,
        ANCHOR.IncorrectProgramId
      );
      await expectError(
        claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 1, claimant: hA.keypairs[1], overrides: { tokenProgram: SystemProgram.programId } }),
        ANCHOR.InvalidProgramId,
        ANCHOR.ConstraintMintTokenProgram,
        ANCHOR.ConstraintTokenTokenProgram,
        ANCHOR.AccountOwnedByWrongProgram,
        ANCHOR.IncorrectProgramId,
        ANCHOR.UnknownAccount
      );
      expect(await tokenBalance(claimantAta(A, hA.keypairs[1].publicKey))).to.equal(0n);
    });

    it("after all of the above the legitimate claim still works", async () => {
      await claim(A, { epochIndex: 0, tree: hA.tree, leafIndex: 0, claimant: hA.keypairs[0] });
      expect(await tokenBalance(claimantAta(A, hA.keypairs[0].publicKey))).to.equal(100n);
      await snapshot();
    });
  });

  describe("fund_epoch", () => {
    it("vault of another city is refused", async () => {
      await expectError(fundEpoch(A, { amount: 10n, tree: hA.tree, overrides: { vault: B.vault } }), ANCHOR.ConstraintSeeds, ANCHOR.ConstraintHasOne);
    });

    it("funder token account of another mint is refused", async () => {
      await expectError(fundEpoch(A, { amount: 10n, tree: hA.tree, funderTokenAccount: C.funderTokenAccount }), ANCHOR.ConstraintTokenMint, ANCHOR.ConstraintTokenOwner);
    });

    it("config of another city with A's authority is refused (Unauthorized via has_one)", async () => {
      await expectError(fundEpoch(B, { amount: 10n, tree: hB.tree, authority: A.authority }), "Unauthorized");
      await expectError(client.lockConfig({ authority: A.authority.publicKey, cityCoinMint: B.cityCoinMint }).signers([A.authority]).rpc(), "Unauthorized");
      await expectError(client.pause({ authority: A.authority.publicKey, cityCoinMint: B.cityCoinMint }).signers([A.authority]).rpc(), "Unauthorized");
    });

    it("founder ATA of another city's founder is refused", async () => {
      await expectError(
        fundEpoch(A, { amount: 10n, tree: hA.tree, overrides: { founderTokenAccount: ata(A.rewardMint, B.founder.publicKey) } }),
        ANCHOR.ConstraintAssociated,
        ANCHOR.ConstraintTokenOwner,
        ANCHOR.AccountNotAssociatedTokenAccount,
        ANCHOR.ConstraintSeeds
      );
      await expectError(fundEpoch(A, { amount: 10n, tree: hA.tree, founder: B.founder.publicKey }), ANCHOR.ConstraintHasOne);
    });

    it("a forged config is refused", async () => {
      await expectError(
        fundEpoch(A, { amount: 10n, tree: hA.tree, overrides: { config: Keypair.generate().publicKey } }),
        ANCHOR.AccountNotInitialized,
        ANCHOR.ConstraintSeeds,
        ANCHOR.AccountOwnedByWrongProgram
      );
    });
  });

  describe("sweep_epoch / cancel_epoch / close_claim_status", () => {
    it("epoch of another city is refused", async () => {
      await expectError(
        client.cancelEpoch({ authority: A.authority.publicKey, cityCoinMint: A.cityCoinMint, epochIndex: 0, overrides: { epoch: epochAddress(B, 0) } }).signers([A.authority]).rpc(),
        ANCHOR.ConstraintSeeds
      );
      await expectError(
        client.sweepEpoch({ authority: A.authority.publicKey, cityCoinMint: A.cityCoinMint, epochIndex: 0, overrides: { epoch: epochAddress(B, 0) } }).signers([A.authority]).rpc(),
        ANCHOR.ConstraintSeeds
      );
    });

    it("claim status of another epoch or claimant cannot be closed", async () => {
      const kp = hA.keypairs[0]; // claimed from A's epoch 0 above
      const realStatus = claimStatusAddress(A, 0, kp.publicKey);
      expect(await accountExists(realStatus)).to.equal(true);
      // real status, but B's epoch in the epoch slot: epoch seeds (config A, index 0) do not match
      await expectError(
        client
          .closeClaimStatus({ claimant: kp.publicKey, cityCoinMint: A.cityCoinMint, epochIndex: 0, overrides: { epoch: epochAddress(B, 0), claimStatus: realStatus } })
          .signers([kp])
          .rpc(),
        ANCHOR.ConstraintSeeds,
        "EpochStillOpen"
      );
      // another wallet tries to close kp's status
      const other = hA.keypairs[2];
      await expectError(
        client.closeClaimStatus({ claimant: other.publicKey, cityCoinMint: A.cityCoinMint, epochIndex: 0, overrides: { claimStatus: realStatus } }).signers([other]).rpc(),
        ANCHOR.ConstraintSeeds,
        ANCHOR.ConstraintHasOne,
        "EpochStillOpen"
      );
      expect(await accountExists(realStatus)).to.equal(true);
    });
  });

  describe("Token-2022 reward mints", () => {
    it("a Token-2022 mint with the transfer-fee extension is refused at init_city (UnsupportedRewardMint)", async () => {
      const feeMint = await createTransferFeeMint(100, 1_000_000n);
      const base = await createCity({ model: "holders", rewardMint: feeMint, tokenProgram: TOKEN_2022_PROGRAM_ID, skipInit: true, name: "fee-mint" });
      await expectError(initCityTx(base).signers([base.authority]).rpc(), "UnsupportedRewardMint");
      expect(await accountExists(base.config)).to.equal(false);
      expect(await accountExists(base.vault)).to.equal(false);
    });

    it("a Token-2022 mint with a close authority is refused at init_city (it could vanish or be recreated with other extensions)", async () => {
      const closable = await createClosableMint();
      const base = await createCity({ model: "holders", rewardMint: closable, tokenProgram: TOKEN_2022_PROGRAM_ID, skipInit: true, name: "closable-mint" });
      await expectError(initCityTx(base).signers([base.authority]).rpc(), "UnsupportedRewardMint");
      expect(await accountExists(base.config)).to.equal(false);
    });

    it("a plain Token-2022 mint (no extensions) works end to end with exact amounts", async () => {
      const mint22 = await createMint(6, TOKEN_2022_PROGRAM_ID);
      const city = await createCity({ model: "split", founderBps: 2_500, rewardMint: mint22, tokenProgram: TOKEN_2022_PROGRAM_ID, name: "token-2022" });
      const h = makeHolders([300n, 450n]);
      for (const kp of h.keypairs) await airdrop(kp.publicKey, 1);
      const r = await fundEpoch(city, { amount: 1_001n, tree: h.tree });
      expect(r.epochView.founderAmount).to.equal(250n);
      expect(r.epochView.holdersAmount).to.equal(751n);
      expect(await tokenBalance(ata(mint22, city.founder.publicKey, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID)).to.equal(250n);
      expect(await vaultBalance(city)).to.equal(751n);
      await claim(city, { epochIndex: 0, tree: h.tree, leafIndex: 1, claimant: h.keypairs[1] });
      expect(await tokenBalance(claimantAta(city, h.keypairs[1].publicKey), TOKEN_2022_PROGRAM_ID)).to.equal(450n);
      expect(await vaultBalance(city)).to.equal(301n);
      // the classic token program cannot be used for this city (refused by the token program during the ATA CPI,
      // or by Anchor's token_program constraints when the ATA already exists)
      await expectError(
        claim(city, { epochIndex: 0, tree: h.tree, leafIndex: 0, claimant: h.keypairs[0], tokenProgram: TOKEN_PROGRAM_ID }),
        ANCHOR.ConstraintMintTokenProgram,
        ANCHOR.ConstraintTokenTokenProgram,
        ANCHOR.InvalidProgramId,
        ANCHOR.AccountOwnedByWrongProgram,
        ANCHOR.ConstraintAssociated,
        ANCHOR.IncorrectProgramId
      );
      expect(await vaultBalance(city)).to.equal(301n);
      await assertInvariants(city);
    });

    it("the city coin may be a Token-2022 mint (it is only an identity)", async () => {
      const cityMint22 = await createMint(6, TOKEN_2022_PROGRAM_ID);
      const city = await createCity({ model: "holders", cityCoinMint: cityMint22, name: "city-2022" });
      expect((await fetchConfig(city)).cityCoinMint.equals(cityMint22)).to.equal(true);
      await assertInvariants(city);
    });
  });
});
