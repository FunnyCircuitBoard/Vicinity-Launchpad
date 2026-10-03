// Spec 4.1-4.5 and 5: the registry (who may create cities), init_city,
// lock_config, set_founder, two-step authority, pause/unpause, and the
// IDL-level proof that economics cannot change.
import { PublicKey, Keypair } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import {
  ANCHOR,
  City,
  accountExists,
  assertInvariants,
  ata,
  client,
  connection,
  createCity,
  economicsOf,
  ensureRegistry,
  epochAddress,
  expect,
  expectEvent,
  expectError,
  fetchConfig,
  fundedKeypair,
  initCityTx,
  payer,
  registryAdmin,
  secondGenesisProgram,
  send,
  sendAs,
  upgradeAuthorityOf,
} from "./helpers";
import { ALLOWED_SPLIT_BPS, BPS_DENOMINATOR, CREATOR_BPS, HOLDERS_BPS, founderAccountWarnings, founderWarnings } from "../sdk/client";

const SPEC_INSTRUCTIONS = [
  "initRegistry",
  "proposeAdmin",
  "acceptAdmin",
  "initCity",
  "lockConfig",
  "setFounder",
  "proposeAuthority",
  "acceptAuthority",
  "pause",
  "unpause",
  "fundEpoch",
  "fundEpochFromVault",
  "claim",
  "sweepEpoch",
  "cancelEpoch",
  "closeClaimStatus",
];

const SPEC_ERRORS = [
  "FounderBpsMismatch",
  "SplitBpsNotAllowed",
  "RewardMintIsCityCoin",
  "FounderIsProgramAccount",
  "NotUpgradeAuthority",
  "NoPendingAdmin",
  "NotPendingAdmin",
  "MissingSnapshotHash",
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
    it("exposes exactly the 16 instructions of the spec plus the registry and fund_epoch_from_vault additions", () => {
      expect(client.instructionNames().sort()).to.deep.equal([...SPEC_INSTRUCTIONS].sort());
    });

    it("the SDK's typed fallback constants equal the policy constants of the deployed IDL", () => {
      const p = client.policy();
      expect(p.fromIdl, "the IDL carries every policy constant").to.equal(true);
      expect(p.allowedSplitBps).to.deep.equal(ALLOWED_SPLIT_BPS);
      expect(p.bpsDenominator).to.equal(BPS_DENOMINATOR);
      expect(p.creatorBps).to.equal(CREATOR_BPS);
      expect(p.holdersBps).to.equal(HOLDERS_BPS);
      expect(client.constant("MIN_CLAIM_WINDOW_SECS")).to.not.equal(undefined);
      expect(client.constant("MAX_CLAIM_WINDOW_SECS")).to.equal(String(365 * 86_400));
      expect(p.minClaimWindowSecs).to.be.greaterThan(0);
      expect(p.maxClaimWindowSecs).to.equal(365 * 86_400);
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

    it("the vault is writable only in init_city (creation), fund_epoch (deposit), fund_epoch_from_vault (founder share out) and claim (payout)", () => {
      for (const ix of client.idl.instructions) {
        const vault = (ix.accounts as Array<{ name: string; writable?: boolean }>).find((a) => a.name === "vault");
        if (vault?.writable) expect(["init_city", "fund_epoch", "fund_epoch_from_vault", "claim"], `${ix.name} writes the vault`).to.include(ix.name);
      }
    });

    it("declares the error codes the tests rely on", () => {
      const codes = client.errorCodes();
      for (const e of SPEC_ERRORS) expect(codes, `error ${e}`).to.include(e);
    });

    it("every PDA is derived with exactly the spec's seeds (IDL pda metadata, asserted unconditionally)", () => {
      type Seed = { kind: string; value?: number[]; path?: string; account?: string };
      const seedsOf = (ixName: string, accountName: string): Seed[] => {
        const ix = client.instruction(ixName);
        const acc = (ix.accounts as Array<{ name: string; pda?: { seeds: Seed[] } }>).find((a) => a.name === accountName);
        expect(acc?.pda, `${ixName}.${accountName} carries pda metadata`).to.not.equal(undefined);
        return acc!.pda!.seeds;
      };
      const constSeed = (text: string) => ({ kind: "const", value: Array.from(Buffer.from(text)) });
      const acct = (path: string, account?: string) => (account ? { kind: "account", path, account } : { kind: "account", path });
      const arg = (path: string) => ({ kind: "arg", path });
      expect(seedsOf("init_registry", "registry")).to.deep.equal([constSeed("registry")]);
      expect(seedsOf("init_city", "registry")).to.deep.equal([constSeed("registry")]);
      expect(seedsOf("init_city", "config")).to.deep.equal([constSeed("city"), acct("city_coin_mint")]);
      expect(seedsOf("init_city", "vault")).to.deep.equal([constSeed("vault"), acct("config")]);
      expect(seedsOf("fund_epoch", "epoch")).to.deep.equal([constSeed("epoch"), acct("config"), acct("config.epoch_count", "CityConfig")]);
      expect(seedsOf("fund_epoch_from_vault", "epoch")).to.deep.equal([constSeed("epoch"), acct("config"), acct("config.epoch_count", "CityConfig")]);
      expect(seedsOf("claim", "epoch")).to.deep.equal([constSeed("epoch"), acct("config"), arg("epoch_index")]);
      expect(seedsOf("claim", "claim_status")).to.deep.equal([constSeed("claim"), acct("epoch"), acct("claimant")]);
      expect(seedsOf("claim", "vault")).to.deep.equal([constSeed("vault"), acct("config")]);
      for (const ix of ["lock_config", "set_founder", "propose_authority", "accept_authority", "pause", "unpause", "fund_epoch", "claim", "sweep_epoch", "cancel_epoch", "close_claim_status"]) {
        expect(seedsOf(ix, "config"), ix).to.deep.equal([constSeed("city"), acct("config.city_coin_mint", "CityConfig")]);
      }
    });
  });

  describe("registry: only Vicinity can create a city's config", () => {
    // This file runs first and nothing before this point touches the chain, so
    // on the validator `anchor test` starts the registry does not exist yet:
    // the only state in which the upgrade-authority check is observable (Anchor
    // runs `init` before the other constraints, so afterwards every caller gets
    // "already in use"). A reused ledger fails here on purpose instead of
    // passing vacuously: run the suite against a fresh validator.
    it("a key that is not the upgrade authority cannot create the registry (NotUpgradeAuthority)", async () => {
      expect(await client.fetchRegistry(), "fresh validator required: the registry must not exist before this test").to.equal(null);
      const stranger = await fundedKeypair(1);
      const ix = await client.initRegistry({ payer: stranger.publicKey, upgradeAuthority: stranger.publicKey, admin: stranger.publicKey }).instruction();
      await expectError(sendAs([ix], [stranger]), "NotUpgradeAuthority");
      // naming the real upgrade authority without its signature is refused by the runtime check
      const ix2 = await client.initRegistry({ payer: stranger.publicKey, upgradeAuthority: payer.publicKey, admin: stranger.publicKey }).instruction();
      ix2.keys.find((k) => k.pubkey.equals(payer.publicKey))!.isSigner = false;
      await expectError(sendAs([ix2], [stranger]), ANCHOR.AccountNotSigner, ANCHOR.ConstraintSigner);
      expect(await client.fetchRegistry()).to.equal(null);
    });

    it("a real ProgramData account of another program is refused by the program binding (NotUpgradeAuthority), not by an earlier error", async () => {
      expect(await client.fetchRegistry(), "fresh validator required").to.equal(null);
      // Anchor.toml [[test.genesis]]: the same binary at another address, with
      // the test wallet as ITS upgrade authority too. So the authority check
      // passes and only `program.programdata_address() == program_data` can
      // refuse; without that constraint this call would create the registry.
      const second = secondGenesisProgram();
      const secondData = client.programDataAddressOf(second);
      const info = await connection.getAccountInfo(secondData, "confirmed");
      expect(info, `the validator must load the second genesis program ${second.toBase58()} of Anchor.toml (tests/README-tests.md)`).to.not.equal(null);
      expect(upgradeAuthorityOf(info!.data)?.equals(payer.publicKey), "the wallet is the second program's upgrade authority").to.equal(true);
      const attempt = (overrides: Record<string, PublicKey>) =>
        client.initRegistry({ payer: payer.publicKey, upgradeAuthority: payer.publicKey, admin: payer.publicKey, overrides }).rpc();
      await expectError(attempt({ programData: secondData }), "NotUpgradeAuthority");
      // the other program in the `program` slot: Program<VicinityRewards> checks the id
      await expectError(attempt({ program: second, programData: secondData }), ANCHOR.InvalidProgramId);
      // the other program's executable account (loader-owned, Program variant) in the program_data slot
      await expectError(attempt({ programData: second }), ANCHOR.AccountNotProgramData);
      // a key with no account fails at deserialization, before any constraint;
      // asserted on its own so it can never stand in for the cases above
      await expectError(attempt({ programData: Keypair.generate().publicKey }), ANCHOR.AccountNotInitialized);
      expect(await client.fetchRegistry()).to.equal(null);
    });

    it("the admin must sign: a key nobody controls can never become the only key that may create cities (AccountNotSigner)", async () => {
      expect(await client.fetchRegistry(), "fresh validator required").to.equal(null);
      const adminAccount = (client.instruction("init_registry").accounts as Array<{ name: string; signer?: boolean }>).find((a) => a.name === "admin");
      expect(adminAccount?.signer, "the IDL declares admin as a signer").to.equal(true);
      const lost = Keypair.generate().publicKey; // the secret is discarded: nobody can ever sign for it
      const ix = await client.initRegistry({ payer: payer.publicKey, upgradeAuthority: payer.publicKey, admin: lost }).instruction();
      ix.keys.find((k) => k.pubkey.equals(lost))!.isSigner = false;
      await expectError(send([ix], []), ANCHOR.AccountNotSigner, ANCHOR.ConstraintSigner);
      expect(await client.fetchRegistry(), "no registry with an admin nobody controls").to.equal(null);
    });

    it("the upgrade authority creates it once (event); a second creation by anyone fails because the PDA exists", async () => {
      await ensureRegistry();
      const r = await client.fetchRegistry();
      expect(r?.admin.equals(registryAdmin.publicKey)).to.equal(true);
      expect(r?.pendingAdmin.equals(PublicKey.default)).to.equal(true);
      expect(r?.address.equals(client.registryAddress())).to.equal(true);
      const stranger = await fundedKeypair(1);
      // the admin co-signs, so the transaction is valid and the chain answers
      await expectError(client.initRegistry({ payer: payer.publicKey, upgradeAuthority: payer.publicKey, admin: stranger.publicKey }).signers([stranger]).rpc(), ANCHOR.AlreadyInUse);
      const ix = await client.initRegistry({ payer: stranger.publicKey, upgradeAuthority: stranger.publicKey, admin: stranger.publicKey }).instruction();
      await expectError(sendAs([ix], [stranger]), ANCHOR.AlreadyInUse);
      expect((await client.fetchRegistry())?.admin.equals(registryAdmin.publicKey)).to.equal(true);
    });

    it("a stranger cannot create the config for a coin Vicinity has not configured (Unauthorized)", async () => {
      const base = await createCity({ model: "holders", skipInit: true });
      const squatter = await fundedKeypair(1);
      base.authority = squatter;
      const ix = await initCityTx(base, { admin: squatter.publicKey, payer: squatter.publicKey, founder: squatter.publicKey }).instruction();
      await expectError(sendAs([ix], [squatter]), "Unauthorized");
      expect(await accountExists(base.config)).to.equal(false);
      expect(await accountExists(base.vault)).to.equal(false);
    });

    it("naming the real admin without its signature is refused by the runtime check (AccountNotSigner)", async () => {
      const base = await createCity({ model: "holders", skipInit: true });
      const squatter = await fundedKeypair(1);
      base.authority = squatter;
      const ix = await initCityTx(base, { payer: squatter.publicKey }).instruction();
      const adminKey = ix.keys.find((k) => k.pubkey.equals(registryAdmin.publicKey))!;
      adminKey.isSigner = false;
      await expectError(sendAs([ix], [squatter]), ANCHOR.AccountNotSigner, ANCHOR.ConstraintSigner);
      expect(await accountExists(base.config)).to.equal(false);
    });

    it("two-step admin transfer: propose, wrong accept, accept; the old admin loses the power and the new one has it", async () => {
      const b = await fundedKeypair(2);
      const stranger = await fundedKeypair(1);
      await expectError(client.acceptAdmin({ newAdmin: b.publicKey }).signers([b]).rpc(), "NoPendingAdmin");
      await expectError(client.proposeAdmin({ admin: stranger.publicKey, newAdmin: stranger.publicKey }).signers([stranger]).rpc(), "Unauthorized");
      const sig = await client.proposeAdmin({ admin: registryAdmin.publicKey, newAdmin: b.publicKey }).rpc();
      expect(expectEvent(await client.eventsOf(sig), "AdminProposed").pendingAdmin.equals(b.publicKey)).to.equal(true);
      await expectError(client.acceptAdmin({ newAdmin: stranger.publicKey }).signers([stranger]).rpc(), "NotPendingAdmin");
      const sig2 = await client.acceptAdmin({ newAdmin: b.publicKey }).signers([b]).rpc();
      const ev = expectEvent(await client.eventsOf(sig2), "AdminAccepted");
      expect(ev.oldAdmin.equals(registryAdmin.publicKey)).to.equal(true);
      expect(ev.newAdmin.equals(b.publicKey)).to.equal(true);
      expect((await client.fetchRegistry())?.pendingAdmin.equals(PublicKey.default)).to.equal(true);
      try {
        // the old admin (the provider wallet) can no longer create cities
        const base = await createCity({ model: "holders", skipInit: true });
        await expectError(initCityTx(base).signers([base.authority]).rpc(), "Unauthorized");
        // the new admin can
        const city = await createCity({ model: "holders", admin: b, tag: "by-new-admin" });
        cities.push(city);
        expect((await fetchConfig(city)).cityTag).to.equal("by-new-admin");
      } finally {
        // hand the registry back so the rest of the suite can create cities
        await client.proposeAdmin({ admin: b.publicKey, newAdmin: registryAdmin.publicKey }).signers([b]).rpc();
        await client.acceptAdmin({ newAdmin: registryAdmin.publicKey }).rpc();
      }
      expect((await client.fetchRegistry())?.admin.equals(registryAdmin.publicKey)).to.equal(true);
    });

    it("proposing the zero address cancels a pending admin transfer", async () => {
      const b = await fundedKeypair(1);
      await client.proposeAdmin({ admin: registryAdmin.publicKey, newAdmin: b.publicKey }).rpc();
      await client.proposeAdmin({ admin: registryAdmin.publicKey, newAdmin: PublicKey.default }).rpc();
      await expectError(client.acceptAdmin({ newAdmin: b.publicKey }).signers([b]).rpc(), "NoPendingAdmin");
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

    it("rejects the config PDA, the vault, the registry PDA and another city's config as founder (their token accounts could never be emptied)", async () => {
      const base = await createCity({ model: "holders", skipInit: true });
      const other = await createCity({ model: "holders" });
      cities.push(other);
      for (const bad of [base.config, base.vault, client.registryAddress(), other.config]) {
        await expectError(initCityTx(base, { founder: bad }).signers([base.authority]).rpc(), "FounderIsProgramAccount");
      }
      expect(await accountExists(base.config)).to.equal(false);
    });

    it("SDK founderWarnings names what the program refuses and flags off-curve keys (the chain cannot see an unspendable key)", async () => {
      const base = await createCity({ model: "holders", skipInit: true });
      const ctx = { config: base.config, vault: base.vault, programId: client.programId };
      expect(founderWarnings(base.founder.publicKey, ctx)).to.deep.equal([]);
      expect(founderWarnings(PublicKey.default, ctx).join(" ")).to.match(/InvalidFounder/);
      expect(founderWarnings(base.config, ctx).join(" ")).to.match(/config PDA/);
      expect(founderWarnings(base.vault, ctx).join(" ")).to.match(/vault/);
      expect(founderWarnings(client.registryAddress(), ctx).join(" ")).to.match(/registry PDA/);
      expect(founderWarnings(epochAddress(base, 0), ctx).join(" ")).to.match(/not on the ed25519 curve/);
      expect(founderWarnings(ata(base.rewardMint, base.founder.publicKey), ctx).join(" ")).to.match(/not on the ed25519 curve/);
      expect((await founderAccountWarnings(connection, client.registryAddress(), client.programId)).join(" ")).to.match(/account of this program/);
      expect((await founderAccountWarnings(connection, base.funderTokenAccount, client.programId)).join(" ")).to.match(/token account/);
      expect(await founderAccountWarnings(connection, base.founder.publicKey, client.programId)).to.deep.equal([]);
      expect(await founderAccountWarnings(connection, Keypair.generate().publicKey, client.programId)).to.deep.equal([]);
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

    it("requires the authority signature (the transaction reaches the program and is refused there)", async () => {
      const base = await createCity({ model: "holders", skipInit: true });
      // the instruction names the authority but marks it as a non-signer, so the
      // transaction is valid for the runtime and the program's Signer check answers
      const ix = await initCityTx(base).instruction();
      const key = ix.keys.find((k) => k.pubkey.equals(base.authority.publicKey))!;
      key.isSigner = false;
      await expectError(send([ix], []), ANCHOR.AccountNotSigner, ANCHOR.ConstraintSigner);
      expect(await accountExists(base.config)).to.equal(false);
    });

    // Kept inside this describe on purpose: mocha runs a suite's own tests before
    // its nested suites, and this one creates a city (and so the registry), which
    // must not happen before the registry tests above.
    it("the test wallet never needs to be the authority (payer and authority are separate signers)", async () => {
      const city = await createCity({ model: "holders" });
      cities.push(city);
      expect((await fetchConfig(city)).authority.equals(payer.publicKey)).to.equal(false);
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

    it("rejects the config PDA and the vault as founder", async () => {
      for (const bad of [city.config, city.vault]) {
        await expectError(
          client.setFounder({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, newFounder: bad }).signers([city.authority]).rpc(),
          "FounderIsProgramAccount"
        );
      }
      expect((await fetchConfig(city)).founder.equals(city.founder.publicKey)).to.equal(true);
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

});
