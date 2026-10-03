// Spec 4.8-4.10 and 5: sweep only after the deadline, cancel only with zero
// claims, carry-over flows into the next epoch exactly, close_claim_status.
//
// The deadline-dependent cases need an epoch whose claim window actually passes
// during the test run. MIN_CLAIM_WINDOW_SECS is a program constant (14 days by
// default). When the program is built for tests with a short minimum window
// (the IDL constant MIN_CLAIM_WINDOW_SECS <= 120), those cases run; otherwise
// they are skipped with a warning and the integrator must enable the short
// window for `anchor test` (see tests/README-tests.md).
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
  expect,
  expectEvent,
  expectError,
  fetchConfig,
  fetchEpoch,
  fundEpoch,
  fundedKeypair,
  makeHolders,
  nowOnChain,
  sleep,
  solBalance,
  tokenBalance,
  vaultBalance,
  windowBounds,
  big,
} from "./helpers";
import { effectiveDeadline } from "../sdk/client";

const SHORT_WINDOW_LIMIT = 120;

async function waitPastDeadline(deadline: number, maxWaitSecs: number): Promise<void> {
  const started = Date.now();
  while ((await nowOnChain()) <= deadline) {
    if (Date.now() - started > maxWaitSecs * 1000) throw new Error(`deadline ${deadline} not reached after ${maxWaitSecs}s`);
    await sleep(1_000);
  }
}

describe("04 cancel, carry-over and (with a short window) deadline + sweep + close_claim_status", () => {
  const auth = (city: City) => ({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint });

  describe("cancel_epoch and carry-over (no deadline needed)", () => {
    let city: City;
    let h1: Holders;
    let h2: Holders;
    before(async () => {
      city = await createCity({ model: "holders", name: "cancel" });
      h1 = makeHolders([300n, 300n, 300n]);
      h2 = makeHolders([700n, 700n]);
      for (const kp of [...h1.keypairs, ...h2.keypairs]) await airdrop(kp.publicKey, 1);
      await fundEpoch(city, { amount: 1_000n, tree: h1.tree });
    });
    afterEach(async () => assertInvariants(city));

    it("non-authority cannot cancel", async () => {
      const stranger = await fundedKeypair(1);
      await expectError(client.cancelEpoch({ authority: stranger.publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 0 }).signers([stranger]).rpc(), "Unauthorized");
      expect((await fetchEpoch(city, 0)).state).to.equal("open");
    });

    it("sweep before the deadline is refused (ClaimDeadlineNotPassed)", async () => {
      await expectError(client.sweepEpoch({ ...auth(city), epochIndex: 0 }).signers([city.authority]).rpc(), "ClaimDeadlineNotPassed");
      expect((await fetchConfig(city)).carryOver).to.equal(0n);
    });

    it("cancel with zero claims: state Cancelled, carry_over += holders_amount, vault unchanged, event", async () => {
      const sig = await client.cancelEpoch({ ...auth(city), epochIndex: 0 }).signers([city.authority]).rpc();
      const e = await fetchEpoch(city, 0);
      expect(e.state).to.equal("cancelled");
      expect(e.holdersAmount).to.equal(1_000n);
      expect(e.claimedAmount).to.equal(0n);
      const cfg = await fetchConfig(city);
      expect(cfg.carryOver).to.equal(1_000n);
      expect(await vaultBalance(city), "no money leaves the vault on cancel").to.equal(1_000n);
      const ev = expectEvent(await client.eventsOf(sig), "EpochCancelled");
      expect(big(ev.returnedAmount)).to.equal(1_000n);
      expect(big(ev.carryOver)).to.equal(1_000n);
      expect(big(ev.index)).to.equal(0n);
    });

    it("a cancelled epoch accepts no claims, no second cancel and no sweep (EpochNotOpen)", async () => {
      await expectError(claim(city, { epochIndex: 0, tree: h1.tree, leafIndex: 0, claimant: h1.keypairs[0] }), "EpochNotOpen");
      await expectError(client.cancelEpoch({ ...auth(city), epochIndex: 0 }).signers([city.authority]).rpc(), "EpochNotOpen");
      await expectError(client.sweepEpoch({ ...auth(city), epochIndex: 0 }).signers([city.authority]).rpc(), "EpochNotOpen");
      expect(await vaultBalance(city)).to.equal(1_000n);
    });

    it("the carry-over flows into the next epoch exactly: holders_amount = deposit + carry, carry reset", async () => {
      const { signature, epochView: e, config: cfg } = await fundEpoch(city, { amount: 500n, tree: h2.tree });
      expect(e.index).to.equal(1n);
      expect(e.holdersAmount).to.equal(1_500n);
      expect(e.depositAmount).to.equal(500n);
      expect(cfg.carryOver).to.equal(0n);
      expect(cfg.totalFunded).to.equal(1_500n);
      expect(cfg.totalToHolders).to.equal(1_500n);
      expect(await vaultBalance(city)).to.equal(1_500n);
      const ev = expectEvent(await client.eventsOf(signature), "EpochFunded");
      expect(big(ev.carryIn)).to.equal(1_000n);
      expect(big(ev.holdersDeposit)).to.equal(500n);
      expect(big(ev.holdersAmount)).to.equal(1_500n);
    });

    it("a leaf of the new epoch can claim from carried-over money", async () => {
      await claim(city, { epochIndex: 1, tree: h2.tree, leafIndex: 0, claimant: h2.keypairs[0] });
      expect(await tokenBalance(claimantAta(city, h2.keypairs[0].publicKey))).to.equal(700n);
      expect(await vaultBalance(city)).to.equal(800n);
    });

    it("cancel after a claim is refused (EpochHasClaims)", async () => {
      await expectError(client.cancelEpoch({ ...auth(city), epochIndex: 1 }).signers([city.authority]).rpc(), "EpochHasClaims");
      expect((await fetchEpoch(city, 1)).state).to.equal("open");
    });

    it("close_claim_status on an open epoch is refused (EpochStillOpen)", async () => {
      await expectError(
        client.closeClaimStatus({ claimant: h2.keypairs[0].publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 1 }).signers([h2.keypairs[0]]).rpc(),
        "EpochStillOpen"
      );
    });

    it("amount 0 is allowed when carry-over exists (a carry-only epoch); not otherwise", async () => {
      const c2 = await createCity({ model: "split", founderBps: 5_000, name: "carry-only" });
      const t1 = makeHolders([10n]);
      const t2 = makeHolders([20n, 30n]);
      await fundEpoch(c2, { amount: 1_000n, tree: t1.tree }); // founder 500, holders 500
      await client.cancelEpoch({ ...auth(c2), epochIndex: 0 }).signers([c2.authority]).rpc();
      expect((await fetchConfig(c2)).carryOver).to.equal(500n);
      const founderBefore = await tokenBalance(claimantAta(c2, c2.founder.publicKey));
      const { epochView: e, config: cfg } = await fundEpoch(c2, { amount: 0n, tree: t2.tree });
      expect(e.depositAmount).to.equal(0n);
      expect(e.founderAmount).to.equal(0n);
      expect(e.holdersAmount).to.equal(500n);
      expect(cfg.carryOver).to.equal(0n);
      expect(cfg.totalFunded).to.equal(1_000n);
      expect(await tokenBalance(claimantAta(c2, c2.founder.publicKey)), "founder gets nothing from carry-only").to.equal(founderBefore);
      expect(await vaultBalance(c2)).to.equal(500n);
      await expectError(fundEpoch(c2, { amount: 0n, tree: t2.tree }), "NothingToDistribute");
      await assertInvariants(c2);
    });

    it("pause does not block cancel (a paused city can still be wound down)", async () => {
      const c3 = await createCity({ model: "holders", name: "paused-cancel" });
      const t = makeHolders([1n]);
      await fundEpoch(c3, { amount: 100n, tree: t.tree });
      await client.pause(auth(c3)).signers([c3.authority]).rpc();
      await client.cancelEpoch({ ...auth(c3), epochIndex: 0 }).signers([c3.authority]).rpc();
      expect((await fetchEpoch(c3, 0)).state).to.equal("cancelled");
      expect((await fetchConfig(c3)).carryOver).to.equal(100n);
      await client.unpause(auth(c3)).signers([c3.authority]).rpc();
      await assertInvariants(c3);
    });

    it("pause time is accounted: paused_at while paused, paused_total_secs grows at unpause, epochs record the total at funding", async () => {
      const c4 = await createCity({ model: "holders", name: "pause-clock" });
      const t = makeHolders([1n]);
      const before = await fundEpoch(c4, { amount: 100n, tree: t.tree });
      expect(before.epochView.pauseSecsAtFunding).to.equal(0);
      const sig = await client.pause(auth(c4)).signers([c4.authority]).rpc();
      let cfg = await fetchConfig(c4);
      expect(cfg.paused).to.equal(true);
      expect(cfg.pausedAt).to.be.greaterThan(0);
      expect(cfg.pausedTotalSecs).to.equal(0);
      expect(Number(expectEvent(await client.eventsOf(sig), "PauseChanged").pausedTotalSecs)).to.equal(0);
      await sleep(2_500);
      const sig2 = await client.unpause(auth(c4)).signers([c4.authority]).rpc();
      cfg = await fetchConfig(c4);
      expect(cfg.paused).to.equal(false);
      expect(cfg.pausedAt).to.equal(0);
      expect(cfg.pausedTotalSecs).to.be.greaterThanOrEqual(2);
      expect(Number(expectEvent(await client.eventsOf(sig2), "PauseChanged").pausedTotalSecs)).to.equal(cfg.pausedTotalSecs);
      // the open epoch's effective deadline moved by exactly the pause time; a new epoch starts from the current total
      const e0 = await fetchEpoch(c4, 0);
      expect(effectiveDeadline(e0, cfg, await nowOnChain())).to.equal(e0.claimDeadline + cfg.pausedTotalSecs);
      const after = await fundEpoch(c4, { amount: 100n, tree: t.tree });
      expect(after.epochView.pauseSecsAtFunding).to.equal(cfg.pausedTotalSecs);
      expect(effectiveDeadline(after.epochView, cfg, await nowOnChain())).to.equal(after.epochView.claimDeadline);
      await assertInvariants(c4);
    });

    it("sweep/cancel need the epoch of this config: an epoch PDA of another index is refused", async () => {
      await expectError(client.cancelEpoch({ ...auth(city), epochIndex: 1, overrides: { epoch: client.epochAddress(city.config, 0) } }).signers([city.authority]).rpc(), ANCHOR.ConstraintSeeds);
      await expectError(client.sweepEpoch({ ...auth(city), epochIndex: 7 }).signers([city.authority]).rpc(), ANCHOR.AccountNotInitialized);
    });
  });

  describe("deadline, sweep and close_claim_status (needs a short MIN_CLAIM_WINDOW_SECS)", function () {
    const { min, fromIdl } = windowBounds();
    const short = min <= SHORT_WINDOW_LIMIT;
    let city: City;
    let h: Holders;
    let deadline: number;

    before(async function () {
      if (!short) {
        // CI sets VICINITY_REQUIRE_SHORT_WINDOWS so a production IDL can never turn
        // these 8 tests into "pending" and leave the workflow green.
        if (process.env.VICINITY_REQUIRE_SHORT_WINDOWS) {
          throw new Error(`short-windows test build required (VICINITY_REQUIRE_SHORT_WINDOWS is set) but the IDL says MIN_CLAIM_WINDOW_SECS=${min}`);
        }
        console.warn(
          `\n  [04] SKIPPED deadline/sweep tests: MIN_CLAIM_WINDOW_SECS is ${min}s (${fromIdl ? "from IDL" : "spec default, not in IDL"}).` +
            ` Build the program with a short test window (<= ${SHORT_WINDOW_LIMIT}s) so these run under anchor test.\n`
        );
        this.skip();
        return;
      }
      expect(fromIdl, "the short window must come from the IDL of the deployed binary").to.equal(true);
      expect(client.constant("MIN_CLAIM_WINDOW_SECS"), "the short-windows feature sets exactly 60 s").to.equal("60");
      city = await createCity({ model: "holders", name: "sweep" });
      h = makeHolders([300n, 300n, 300n]);
      for (const kp of h.keypairs) await airdrop(kp.publicKey, 1);
      const r = await fundEpoch(city, { amount: 1_000n, tree: h.tree, window: min });
      deadline = r.epochView.claimDeadline;
      await claim(city, { epochIndex: 0, tree: h.tree, leafIndex: 0, claimant: h.keypairs[0] });
    });
    afterEach(async function () {
      if (city) await assertInvariants(city);
    });

    it("before the deadline: claims work, sweep is refused", async () => {
      expect(await nowOnChain()).to.be.lessThanOrEqual(deadline);
      await expectError(client.sweepEpoch({ ...auth(city), epochIndex: 0 }).signers([city.authority]).rpc(), "ClaimDeadlineNotPassed");
      await claim(city, { epochIndex: 0, tree: h.tree, leafIndex: 1, claimant: h.keypairs[1] });
      expect(await vaultBalance(city)).to.equal(400n);
    });

    it("after the deadline: claim is refused (ClaimDeadlinePassed)", async () => {
      await waitPastDeadline(deadline, min + 60);
      await expectError(claim(city, { epochIndex: 0, tree: h.tree, leafIndex: 2, claimant: h.keypairs[2] }), "ClaimDeadlinePassed");
      expect(await vaultBalance(city)).to.equal(400n);
      expect(await accountExists(claimantAta(city, h.keypairs[2].publicKey))).to.equal(false);
    });

    it("non-authority cannot sweep", async () => {
      const stranger = await fundedKeypair(1);
      await expectError(client.sweepEpoch({ authority: stranger.publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 0 }).signers([stranger]).rpc(), "Unauthorized");
    });

    it("sweep (also while paused, because the deadline passed before the pause began): state Swept, carry_over += unclaimed, vault unchanged, event", async () => {
      await client.pause(auth(city)).signers([city.authority]).rpc();
      const sig = await client.sweepEpoch({ ...auth(city), epochIndex: 0 }).signers([city.authority]).rpc();
      await client.unpause(auth(city)).signers([city.authority]).rpc();
      const e = await fetchEpoch(city, 0);
      expect(e.state).to.equal("swept");
      expect(e.claimedAmount).to.equal(600n);
      const cfg = await fetchConfig(city);
      expect(cfg.carryOver).to.equal(400n);
      expect(await vaultBalance(city)).to.equal(400n);
      const ev = expectEvent(await client.eventsOf(sig), "EpochSwept");
      expect(big(ev.unclaimedAmount)).to.equal(400n);
      expect(big(ev.carryOver)).to.equal(400n);
    });

    it("a swept epoch accepts no claim, no second sweep, no cancel (EpochNotOpen)", async () => {
      await expectError(claim(city, { epochIndex: 0, tree: h.tree, leafIndex: 2, claimant: h.keypairs[2] }), "EpochNotOpen");
      await expectError(client.sweepEpoch({ ...auth(city), epochIndex: 0 }).signers([city.authority]).rpc(), "EpochNotOpen");
      await expectError(client.cancelEpoch({ ...auth(city), epochIndex: 0 }).signers([city.authority]).rpc(), "EpochNotOpen");
    });

    it("close_claim_status: only the claimant, only an existing status; rent returns to the claimant", async () => {
      const kp0 = h.keypairs[0];
      const status = claimStatusAddress(city, 0, kp0.publicKey);
      // holder 2 never claimed: no status to close
      await expectError(
        client.closeClaimStatus({ claimant: h.keypairs[2].publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 0 }).signers([h.keypairs[2]]).rpc(),
        ANCHOR.AccountNotInitialized
      );
      // holder 2 cannot close holder 0's status
      await expectError(
        client
          .closeClaimStatus({ claimant: h.keypairs[2].publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 0, overrides: { claimStatus: status } })
          .signers([h.keypairs[2]])
          .rpc(),
        ANCHOR.ConstraintSeeds,
        ANCHOR.ConstraintHasOne
      );
      expect(await accountExists(status)).to.equal(true);
      const rent = await solBalance(status);
      const before = await solBalance(kp0.publicKey);
      await client.closeClaimStatus({ claimant: kp0.publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 0 }).signers([kp0]).rpc();
      expect(await accountExists(status)).to.equal(false);
      const after = await solBalance(kp0.publicKey);
      expect(after - before).to.be.greaterThan(rent - 20_000); // rent back minus the fee
      await expectError(client.closeClaimStatus({ claimant: kp0.publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 0 }).signers([kp0]).rpc(), ANCHOR.AccountNotInitialized);
      // closing the status does not reopen the claim
      await expectError(claim(city, { epochIndex: 0, tree: h.tree, leafIndex: 0, claimant: kp0 }), "EpochNotOpen");
    });

    it("the swept carry-over flows into the next epoch", async () => {
      const t = makeHolders([5n]);
      const { epochView: e, config: cfg } = await fundEpoch(city, { amount: 300n, tree: t.tree });
      expect(e.holdersAmount).to.equal(700n);
      expect(cfg.carryOver).to.equal(0n);
      expect(await vaultBalance(city)).to.equal(700n);
    });

    it("a pause extends the deadline: holders lose no claim time and the authority cannot pause, wait and sweep", async function () {
      this.timeout(10 * 60_000);
      const c5 = await createCity({ model: "holders", name: "pause-deadline" });
      const t = makeHolders([300n, 300n, 400n]);
      for (const kp of t.keypairs) await airdrop(kp.publicKey, 1);
      const r = await fundEpoch(c5, { amount: 1_000n, tree: t.tree, window: min });
      const nominal = r.epochView.claimDeadline;
      await client.pause(auth(c5)).signers([c5.authority]).rpc();
      const pausedAt = (await fetchConfig(c5)).pausedAt;
      // let the NOMINAL deadline pass while paused
      await waitPastDeadline(nominal, min + 60);
      // while paused: nobody can claim, and the authority cannot sweep either
      await expectError(claim(c5, { epochIndex: 0, tree: t.tree, leafIndex: 0, claimant: t.keypairs[0] }), "Paused");
      await expectError(client.sweepEpoch({ ...auth(c5), epochIndex: 0 }).signers([c5.authority]).rpc(), "ClaimDeadlineNotPassed");
      await client.unpause(auth(c5)).signers([c5.authority]).rpc();
      const cfg = await fetchConfig(c5);
      expect(cfg.pausedTotalSecs).to.be.greaterThanOrEqual(nominal - pausedAt);
      // the window was extended by the pause: a claim after the nominal deadline succeeds
      expect(await nowOnChain()).to.be.greaterThan(nominal);
      await claim(c5, { epochIndex: 0, tree: t.tree, leafIndex: 0, claimant: t.keypairs[0] });
      expect(await tokenBalance(claimantAta(c5, t.keypairs[0].publicKey))).to.equal(300n);
      await expectError(client.sweepEpoch({ ...auth(c5), epochIndex: 0 }).signers([c5.authority]).rpc(), "ClaimDeadlineNotPassed");
      await assertInvariants(c5);
      // once the EXTENDED deadline passes, the normal rules apply again
      const e0 = await fetchEpoch(c5, 0);
      const extended = effectiveDeadline(e0, cfg, await nowOnChain());
      expect(extended).to.be.greaterThanOrEqual(nominal + (nominal - pausedAt));
      await waitPastDeadline(extended, min + 60);
      await expectError(claim(c5, { epochIndex: 0, tree: t.tree, leafIndex: 1, claimant: t.keypairs[1] }), "ClaimDeadlinePassed");
      await client.sweepEpoch({ ...auth(c5), epochIndex: 0 }).signers([c5.authority]).rpc();
      expect((await fetchEpoch(c5, 0)).state).to.equal("swept");
      expect((await fetchConfig(c5)).carryOver).to.equal(700n);
      expect(await vaultBalance(c5)).to.equal(700n);
      await assertInvariants(c5);
    });
  });
});
