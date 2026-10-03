// Spec 4.1-4.5 and 5: init_city, lock_config, set_founder, two-step authority,
// pause/unpause, and the IDL-level proof that economics cannot change.
import { PublicKey, Keypair } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import {
  ANCHOR,
  City,
  accountExists,
  assertInvariants,
  client,
  connection,
  createCity,
  economicsOf,
  expect,
  expectEvent,
  expectError,
  fetchConfig,
  fundedKeypair,
  initCityTx,
  payer,
} from "./helpers";

const SPEC_INSTRUCTIONS = [
  "initCity",
  "lockConfig",
  "setFounder",
  "proposeAuthority",
  "acceptAuthority",
  "pause",
  "unpause",
  "fundEpoch",
  "claim",
  "sweepEpoch",
  "cancelEpoch",
  "closeClaimStatus",
];

const SPEC_ERRORS = [
  "FounderBpsMismatch",
  "SplitBpsNotAllowed",
  "RewardMintIsCityCoin",
  "Unauthorized",
  "AlreadyLocked",
  "NoPendingAuthority",
  "NotPendingAuthority",
  "Paused",
  "ClaimWindowOutOfRange",
  "NothingToDistribute",
  "CreatorModelHasTree",
  "MissingMerkleRoot",
  "MissingLeaves",
  "EpochNotOpen",
  "ClaimDeadlinePassed",
  "ClaimDeadlineNotPassed",
  "LeafIndexOutOfRange",
  "ProofTooLong",
  "InvalidProof",
  "ClaimExceedsHoldersAmount",
  "EpochHasClaims",
  "EpochStillOpen",
  "MathOverflow",
];

describe("01 init_city, lock_config, set_founder, authority transfer, pause", () => {
  const cities: City[] = [];
  afterEach(async () => {
    for (const c of cities) await assertInvariants(c);
  });

  describe("IDL surface: economics are immutable because no instruction can write them", () => {
    it("exposes exactly the 12 instructions of the spec", () => {
      expect(client.instructionNames().sort()).to.deep.equal([...SPEC_INSTRUCTIONS].sort());
    });

    it("has no withdraw, set_root, update_config or similar instruction", () => {
      for (const n of client.instructionNames()) {
        expect(n).to.not.match(/withdraw|setRoot|updateRoot|update|setModel|setBps|setMint|setVault|setReward|migrate|upgrade|emergency|rescue/i);
      }
    });

    it("only init_city takes reward_model and founder_bps; no later instruction takes a mint, vault or bps argument", () => {
      for (const ix of client.idl.instructions) {
        const argNames = ix.args.map((a) => a.name);
        if (ix.name === "init_city") {
          expect(argNames).to.include.members(["reward_model", "founder_bps", "city_tag"]);
        } else {
          for (const a of argNames) expect(a, `${ix.name} arg ${a}`).to.not.match(/model|bps|mint|vault|founder_share/i);
        }
      }
    });

    it("the vault is writable only in init_city (creation), fund_epoch (deposit) and claim (payout)", () => {
      for (const ix of client.idl.instructions) {
        const vault = (ix.accounts as Array<{ name: string; writable?: boolean }>).find((a) => a.name === "vault");
        if (vault?.writable) expect(["init_city", "fund_epoch", "claim"], `${ix.name} writes the vault`).to.include(ix.name);
      }
    });

    it("declares the error codes the tests rely on", () => {
      const codes = client.errorCodes();
      for (const e of SPEC_ERRORS) expect(codes, `error ${e}`).to.include(e);
    });

    it("stores PDAs with the spec's seeds (IDL pda metadata where present)", () => {
      const init = client.instruction("init_city");
      const config = (init.accounts as Array<{ name: string; pda?: { seeds: Array<{ kind: string; value?: number[] }> } }>).find((a) => a.name === "config");
      if (config?.pda) {
        const first = config.pda.seeds[0];
        expect(Buffer.from(first.value ?? []).toString()).to.equal("city");
      }
    });
  });

  describe("init_city", () => {
    it("Creator: stores every field and creates the vault owned by the config PDA", async () => {
      const city = await createCity({ model: "creator", tag: "us-ny-utica" });
      cities.push(city);
      const cfg = await fetchConfig(city);
      expect(cfg.authority.equals(city.authority.publicKey)).to.equal(true);
      expect(cfg.pendingAuthority.equals(PublicKey.default)).to.equal(true);
      expect(cfg.founder.equals(city.founder.publicKey)).to.equal(true);
      expect(cfg.cityCoinMint.equals(city.cityCoinMint)).to.equal(true);
      expect(cfg.rewardMint.equals(city.rewardMint)).to.equal(true);
      expect(cfg.vault.equals(city.vault)).to.equal(true);
      expect(cfg.rewardModel).to.equal("creator");
      expect(cfg.founderBps).to.equal(10_000);
      expect(cfg.locked).to.equal(false);
      expect(cfg.paused).to.equal(false);
      expect(cfg.epochCount).to.equal(0n);
      expect(cfg.carryOver).to.equal(0n);
      expect(cfg.totalFunded).to.equal(0n);
      expect(cfg.totalToFounder).to.equal(0n);
      expect(cfg.totalToHolders).to.equal(0n);
      expect(cfg.totalClaimed).to.equal(0n);
      expect(cfg.cityTag).to.equal("us-ny-utica");
      expect(cfg.bump).to.equal(client.city(city.cityCoinMint).configBump);
      expect(cfg.vaultBump).to.equal(client.city(city.cityCoinMint).vaultBump);
      const vault = await getAccount(connection, city.vault, "confirmed");
      expect(vault.owner.equals(city.config)).to.equal(true);
      expect(vault.mint.equals(city.rewardMint)).to.equal(true);
      expect(vault.amount).to.equal(0n);
    });

    it("Holders and Split 25/50/75 accept their bps", async () => {
      const h = await createCity({ model: "holders" });
      cities.push(h);
      expect((await fetchConfig(h)).founderBps).to.equal(0);
      expect((await fetchConfig(h)).rewardModel).to.equal("holders");
      for (const bps of [2_500, 5_000, 7_500]) {
        const s = await createCity({ model: "split", founderBps: bps });
        cities.push(s);
        const cfg = await fetchConfig(s);
        expect(cfg.rewardModel).to.equal("split");
        expect(cfg.founderBps).to.equal(bps);
      }
    });

    it("emits CityInitialized with the stored values", async () => {
      const city = await createCity({ model: "split", founderBps: 2_500, skipInit: true, tag: "ev-city" });
      const sig = await initCityTx(city).signers([city.authority]).rpc();
      cities.push(city);
      const ev = expectEvent(await client.eventsOf(sig), "CityInitialized");
      expect(ev.config.equals(city.config)).to.equal(true);
      expect(ev.cityCoinMint.equals(city.cityCoinMint)).to.equal(true);
      expect(ev.rewardMint.equals(city.rewardMint)).to.equal(true);
      expect(ev.vault.equals(city.vault)).to.equal(true);
      expect(ev.authority.equals(city.authority.publicKey)).to.equal(true);
      expect(ev.founder.equals(city.founder.publicKey)).to.equal(true);
      expect(Number(ev.founderBps)).to.equal(2_500);
    });

    it("rejects bps that do not match the model (and unknown splits)", async () => {
      const base = await createCity({ model: "creator", skipInit: true });
      const tryInit = (extra: Parameters<typeof initCityTx>[1]) => initCityTx(base, extra).signers([base.authority]).rpc();
      await expectError(tryInit({ founderBps: 0 }), "FounderBpsMismatch");
      await expectError(tryInit({ founderBps: 5_000 }), "FounderBpsMismatch");
      await expectError(tryInit({ founderBps: 10_001 }), "FounderBpsMismatch", "InvalidFounderBps");
      await expectError(tryInit({ model: "holders", founderBps: 10_000 }), "FounderBpsMismatch");
      await expectError(tryInit({ model: "holders", founderBps: 1 }), "FounderBpsMismatch");
      await expectError(tryInit({ model: "split", founderBps: 1_234 }), "SplitBpsNotAllowed");
      await expectError(tryInit({ model: "split", founderBps: 0 }), "SplitBpsNotAllowed");
      await expectError(tryInit({ model: "split", founderBps: 10_000 }), "SplitBpsNotAllowed");
      await expectError(tryInit({ model: "split", founderBps: 5_001 }), "SplitBpsNotAllowed");
      expect(await accountExists(base.config)).to.equal(false);
      expect(await accountExists(base.vault)).to.equal(false);
    });

    it("rejects the city coin itself as reward mint", async () => {
      const base = await createCity({ model: "holders", skipInit: true });
      await expectError(initCityTx(base, { rewardMint: base.cityCoinMint }).signers([base.authority]).rpc(), "RewardMintIsCityCoin");
      expect(await accountExists(base.config)).to.equal(false);
    });

    it("rejects the zero address as founder", async () => {
      const base = await createCity({ model: "holders", skipInit: true });
      await expectError(initCityTx(base, { founder: PublicKey.default }).signers([base.authority]).rpc(), "InvalidFounder");
    });

    it("rejects a city tag with non-ASCII bytes or a zero inside the text", async () => {
      const base = await createCity({ model: "holders", skipInit: true });
      const bad1 = new Array(32).fill(0);
      bad1[0] = 0x75;
      bad1[1] = 0xc3; // start of a UTF-8 sequence
      await expectError(initCityTx(base, { tag: bad1 }).signers([base.authority]).rpc(), "InvalidCityTag");
      const bad2 = new Array(32).fill(0);
      bad2[0] = 0x75;
      bad2[2] = 0x73; // zero padding followed by text
      await expectError(initCityTx(base, { tag: bad2 }).signers([base.authority]).rpc(), "InvalidCityTag");
      const bad3 = new Array(32).fill(0);
      bad3[0] = 0x07; // control character
      await expectError(initCityTx(base, { tag: bad3 }).signers([base.authority]).rpc(), "InvalidCityTag");
    });

    it("rejects a second init for the same city coin (account exists)", async () => {
      const city = await createCity({ model: "holders" });
      cities.push(city);
      const before = await fetchConfig(city);
      await expectError(initCityTx(city, { model: "creator", founderBps: 10_000 }).signers([city.authority]).rpc(), ANCHOR.AlreadyInUse);
      expect(economicsOf(await fetchConfig(city))).to.deep.equal(economicsOf(before));
    });

    it("rejects a vault that is not the derived PDA", async () => {
      const base = await createCity({ model: "holders", skipInit: true });
      await expectError(
        initCityTx(base, { overrides: { vault: Keypair.generate().publicKey } }).signers([base.authority]).rpc(),
        ANCHOR.ConstraintSeeds
      );
      const otherCity = await createCity({ model: "holders", skipInit: true });
      await expectError(initCityTx(base, { overrides: { vault: otherCity.vault } }).signers([base.authority]).rpc(), ANCHOR.ConstraintSeeds);
    });

    it("rejects a config that is not the derived PDA", async () => {
      const base = await createCity({ model: "holders", skipInit: true });
      await expectError(
        initCityTx(base, { overrides: { config: Keypair.generate().publicKey } }).signers([base.authority]).rpc(),
        ANCHOR.ConstraintSeeds
      );
    });

    it("requires the authority signature", async () => {
      const base = await createCity({ model: "holders", skipInit: true });
      const stranger = await fundedKeypair(1);
      // authority account says city.authority but only the stranger signs: the runtime rejects the missing signature
      await expectError(initCityTx(base, { overrides: { authority: stranger.publicKey } }).signers([base.authority]).rpc(), /unknown signer|Signature verification failed|Missing signature|signer/i);
    });
  });

  describe("lock_config", () => {
    let city: City;
    before(async () => {
      city = await createCity({ model: "split", founderBps: 7_500 });
      cities.push(city);
    });

    it("non-authority cannot lock", async () => {
      const stranger = await fundedKeypair(1);
      await expectError(client.lockConfig({ authority: stranger.publicKey, cityCoinMint: city.cityCoinMint }).signers([stranger]).rpc(), "Unauthorized");
      expect((await fetchConfig(city)).locked).to.equal(false);
    });

    it("authority locks; event; economics unchanged; locking twice fails", async () => {
      const before = await fetchConfig(city);
      const sig = await client.lockConfig({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc();
      const cfg = await fetchConfig(city);
      expect(cfg.locked).to.equal(true);
      expect(economicsOf(cfg)).to.deep.equal(economicsOf(before));
      const ev = expectEvent(await client.eventsOf(sig), "ConfigLocked");
      expect(ev.config.equals(city.config)).to.equal(true);
      await expectError(client.lockConfig({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc(), "AlreadyLocked");
    });

    it("a locked config accepts a founder change and pause (not economics)", async () => {
      const before = await fetchConfig(city);
      const newFounder = Keypair.generate().publicKey;
      await client.setFounder({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, newFounder }).signers([city.authority]).rpc();
      await client.pause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc();
      await client.unpause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc();
      const cfg = await fetchConfig(city);
      expect(cfg.founder.equals(newFounder)).to.equal(true);
      expect(economicsOf(cfg)).to.deep.equal(economicsOf(before));
      expect(cfg.locked).to.equal(true);
    });
  });

  describe("set_founder", () => {
    let city: City;
    before(async () => {
      city = await createCity({ model: "holders" });
      cities.push(city);
    });

    it("non-authority cannot change the founder", async () => {
      const stranger = await fundedKeypair(1);
      await expectError(
        client.setFounder({ authority: stranger.publicKey, cityCoinMint: city.cityCoinMint, newFounder: stranger.publicKey }).signers([stranger]).rpc(),
        "Unauthorized"
      );
      expect((await fetchConfig(city)).founder.equals(city.founder.publicKey)).to.equal(true);
    });

    it("rejects the zero address", async () => {
      await expectError(
        client.setFounder({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, newFounder: PublicKey.default }).signers([city.authority]).rpc(),
        "InvalidFounder"
      );
    });

    it("authority changes the founder and the event carries old and new", async () => {
      const newFounder = Keypair.generate().publicKey;
      const sig = await client
        .setFounder({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, newFounder })
        .signers([city.authority])
        .rpc();
      const cfg = await fetchConfig(city);
      expect(cfg.founder.equals(newFounder)).to.equal(true);
      const ev = expectEvent(await client.eventsOf(sig), "FounderChanged");
      expect(ev.oldFounder.equals(city.founder.publicKey)).to.equal(true);
      expect(ev.newFounder.equals(newFounder)).to.equal(true);
      city.founder = Keypair.generate(); // keep the harness consistent: founder is now a key we do not hold
      (city as any).founderPubkey = newFounder;
    });
  });

  describe("propose_authority / accept_authority (two-step transfer)", () => {
    let city: City;
    let a: Keypair;
    let b: Keypair;
    let c: Keypair;
    before(async () => {
      city = await createCity({ model: "holders" });
      cities.push(city);
      a = await fundedKeypair(1);
      b = await fundedKeypair(1);
      c = await fundedKeypair(1);
    });

    it("accept with nothing pending fails", async () => {
      await expectError(client.acceptAuthority({ newAuthority: a.publicKey, cityCoinMint: city.cityCoinMint }).signers([a]).rpc(), "NoPendingAuthority");
    });

    it("non-authority cannot propose", async () => {
      await expectError(
        client.proposeAuthority({ authority: a.publicKey, cityCoinMint: city.cityCoinMint, newAuthority: a.publicKey }).signers([a]).rpc(),
        "Unauthorized"
      );
    });

    it("authority proposes A: pending set, authority unchanged, event", async () => {
      const sig = await client
        .proposeAuthority({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, newAuthority: a.publicKey })
        .signers([city.authority])
        .rpc();
      const cfg = await fetchConfig(city);
      expect(cfg.pendingAuthority.equals(a.publicKey)).to.equal(true);
      expect(cfg.authority.equals(city.authority.publicKey)).to.equal(true);
      const ev = expectEvent(await client.eventsOf(sig), "AuthorityProposed");
      expect(ev.pendingAuthority.equals(a.publicKey)).to.equal(true);
    });

    it("B (not pending) cannot accept; the old authority still works", async () => {
      await expectError(client.acceptAuthority({ newAuthority: b.publicKey, cityCoinMint: city.cityCoinMint }).signers([b]).rpc(), "NotPendingAuthority");
      await client.pause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc();
      await client.unpause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc();
    });

    it("proposing C replaces A (a pending transfer is cancelled by proposing a new one)", async () => {
      await client
        .proposeAuthority({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, newAuthority: c.publicKey })
        .signers([city.authority])
        .rpc();
      expect((await fetchConfig(city)).pendingAuthority.equals(c.publicKey)).to.equal(true);
      await expectError(client.acceptAuthority({ newAuthority: a.publicKey, cityCoinMint: city.cityCoinMint }).signers([a]).rpc(), "NotPendingAuthority");
    });

    it("proposing the zero address cancels the pending transfer", async () => {
      const sig = await client
        .proposeAuthority({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, newAuthority: PublicKey.default })
        .signers([city.authority])
        .rpc();
      expect((await fetchConfig(city)).pendingAuthority.equals(PublicKey.default)).to.equal(true);
      const ev = expectEvent(await client.eventsOf(sig), "AuthorityProposed");
      expect(ev.pendingAuthority.equals(PublicKey.default)).to.equal(true);
      await expectError(client.acceptAuthority({ newAuthority: c.publicKey, cityCoinMint: city.cityCoinMint }).signers([c]).rpc(), "NoPendingAuthority");
    });

    it("C accepts after a fresh proposal: authority moves, pending cleared, old key loses power", async () => {
      await client
        .proposeAuthority({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, newAuthority: c.publicKey })
        .signers([city.authority])
        .rpc();
      const sig = await client.acceptAuthority({ newAuthority: c.publicKey, cityCoinMint: city.cityCoinMint }).signers([c]).rpc();
      const cfg = await fetchConfig(city);
      expect(cfg.authority.equals(c.publicKey)).to.equal(true);
      expect(cfg.pendingAuthority.equals(PublicKey.default)).to.equal(true);
      const ev = expectEvent(await client.eventsOf(sig), "AuthorityAccepted");
      expect(ev.oldAuthority.equals(city.authority.publicKey)).to.equal(true);
      expect(ev.newAuthority.equals(c.publicKey)).to.equal(true);
      await expectError(client.pause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc(), "Unauthorized");
      await client.pause({ authority: c.publicKey, cityCoinMint: city.cityCoinMint }).signers([c]).rpc();
      await client.unpause({ authority: c.publicKey, cityCoinMint: city.cityCoinMint }).signers([c]).rpc();
      city.authority = c;
    });
  });

  describe("pause / unpause", () => {
    let city: City;
    before(async () => {
      city = await createCity({ model: "holders" });
      cities.push(city);
    });

    it("non-authority cannot pause or unpause", async () => {
      const stranger = await fundedKeypair(1);
      await expectError(client.pause({ authority: stranger.publicKey, cityCoinMint: city.cityCoinMint }).signers([stranger]).rpc(), "Unauthorized");
      await expectError(client.unpause({ authority: stranger.publicKey, cityCoinMint: city.cityCoinMint }).signers([stranger]).rpc(), "Unauthorized");
    });

    it("pause sets the flag and emits; pausing twice fails; unpause clears; unpausing twice fails", async () => {
      await expectError(client.unpause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc(), "NotPaused");
      const sig = await client.pause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc();
      expect((await fetchConfig(city)).paused).to.equal(true);
      expect(expectEvent(await client.eventsOf(sig), "PauseChanged").paused).to.equal(true);
      await expectError(client.pause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc(), "AlreadyPaused");
      const sig2 = await client.unpause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc();
      expect((await fetchConfig(city)).paused).to.equal(false);
      expect(expectEvent(await client.eventsOf(sig2), "PauseChanged").paused).to.equal(false);
      await expectError(client.unpause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc(), "NotPaused");
    });
  });

  it("the test wallet never needs to be the authority (payer and authority are separate signers)", async () => {
    const city = await createCity({ model: "holders" });
    cities.push(city);
    expect((await fetchConfig(city)).authority.equals(payer.publicKey)).to.equal(false);
  });
});
