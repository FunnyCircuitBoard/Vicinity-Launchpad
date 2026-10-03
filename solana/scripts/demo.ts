// Auditor demo: the whole life cycle of one city coin's rewards on a running
// local validator, printing every balance after every step.
//
//   1. start a validator with the program:   anchor localnet      (or see scripts/README-scripts.md)
//   2. in another shell:                      npm run demo
//
// Env (defaults in brackets): ANCHOR_PROVIDER_URL [http://127.0.0.1:8899],
// ANCHOR_WALLET [~/.config/solana/id.json]. The wallet is airdropped on localnet.
//
// Nothing here is production: every key is generated for this run and the
// reward mint is a fresh 6-decimal token standing in for USDC/WSOL.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

process.env.ANCHOR_PROVIDER_URL ??= "http://127.0.0.1:8899";
process.env.ANCHOR_WALLET ??= join(homedir(), ".config", "solana", "id.json");

type Helpers = typeof import("../tests/helpers");
type Merkle = typeof import("../tests/merkle-types");

const UNIT = 1_000_000n; // 6 decimals
const fmt = (v: bigint) => {
  const whole = v / UNIT;
  const frac = (v % UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const short = (s: { toBase58(): string } | string) => {
  const b = typeof s === "string" ? s : s.toBase58();
  return `${b.slice(0, 4)}..${b.slice(-4)}`;
};

let step = 0;
function headline(text: string) {
  step++;
  console.log(`\n${"=".repeat(78)}\n  STEP ${step}: ${text}\n${"=".repeat(78)}`);
}

async function main() {
  if (!existsSync(process.env.ANCHOR_WALLET!)) {
    // a throwaway wallet for this run only (localnet airdrops fund it)
    const dir = join(process.cwd(), ".anchor");
    mkdirSync(dir, { recursive: true });
    const kp = Keypair.generate();
    const p = join(dir, "demo-wallet.json");
    writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
    process.env.ANCHOR_WALLET = p;
    console.log(`no wallet at the default path; using a throwaway one at ${p}`);
  }

  const H: Helpers = await import("../tests/helpers");
  const M: Merkle = await import("../tests/merkle-types");
  const { client, connection, payer } = H;

  console.log(`RPC            ${connection.rpcEndpoint}`);
  console.log(`program        ${client.programId.toBase58()}`);
  console.log(`wallet (payer) ${payer.publicKey.toBase58()}`);
  const bounds = client.claimWindowBounds();
  console.log(`claim window   ${bounds.min}s .. ${bounds.max}s ${bounds.fromIdl ? "(from IDL constants)" : "(spec defaults; IDL has no constants)"}`);
  // Epoch 0 gets the shortest window the program allows so that, with a
  // `short-windows` test build (60 s), the sweep step at the end can run on a
  // real deadline. Every other epoch gets a normal 30-day window (clamped into
  // the program's bounds) so it is still open when the demo claims from it.
  const normalWindow = Math.min(bounds.max, Math.max(bounds.min, 30 * 86_400));

  if ((await connection.getBalance(payer.publicKey)) < 2e9) {
    console.log("airdropping 5 SOL to the wallet (localnet)");
    await H.airdrop(payer.publicKey, 5);
  }

  // -------------------------------------------------------------------------
  headline("Create the registry (once per deployment), the city coin, the reward mint and the people");
  await H.ensureRegistry();
  const reg = await client.fetchRegistry();
  console.log(`registry PDA     ${reg!.address.toBase58()}  admin ${reg!.admin.toBase58()} (only this key may create city configs)`);
  const city = await H.createCity({ model: "split", founderBps: 5_000, tag: "demo-city", name: "demo", funderBalance: 10_000n * UNIT });
  console.log(`city coin mint   ${city.cityCoinMint.toBase58()}`);
  console.log(`reward mint      ${city.rewardMint.toBase58()}  (6 decimals, stands in for USDC)`);
  console.log(`config PDA       ${city.config.toBase58()}`);
  console.log(`vault PDA        ${city.vault.toBase58()}`);
  console.log(`authority (ops)  ${city.authority.publicKey.toBase58()}`);
  console.log(`founder          ${city.founder.publicKey.toBase58()}`);
  console.log(`funder           ${city.funder.publicKey.toBase58()}  holds ${fmt(await H.tokenBalance(city.funderTokenAccount))} reward tokens`);
  console.log(`model            Split, founder_bps 5000 (50% founder / 50% holders)`);

  // simulated snapshot: four holders with city coin balances
  const holders = [
    { name: "Ana", kp: Keypair.generate(), balance: 500_000n },
    { name: "Ben", kp: Keypair.generate(), balance: 300_000n },
    { name: "Cid", kp: Keypair.generate(), balance: 150_000n },
    { name: "Dee", kp: Keypair.generate(), balance: 50_000n },
  ];
  for (const h of holders) await H.airdrop(h.kp.publicKey, 1);
  console.log("holders (snapshot of city coin balances):");
  for (const h of holders) console.log(`  ${h.name.padEnd(4)} ${h.kp.publicKey.toBase58()}  balance ${h.balance}`);

  const cfg0 = await H.fetchConfig(city);
  console.log(`\nconfig: locked=${cfg0.locked} paused=${cfg0.paused} epoch_count=${cfg0.epochCount} carry_over=${cfg0.carryOver}`);

  const table = async (label: string) => {
    const cfg = await H.fetchConfig(city);
    console.log(`\n  balances after ${label}`);
    console.log(`    vault              ${fmt(await H.vaultBalance(city)).padStart(14)}`);
    console.log(`    founder            ${fmt(await H.founderBalance(city)).padStart(14)}`);
    console.log(`    funder             ${fmt(await H.tokenBalance(city.funderTokenAccount)).padStart(14)}`);
    for (const h of holders) console.log(`    ${h.name.padEnd(18)} ${fmt(await H.tokenBalance(H.claimantAta(city, h.kp.publicKey))).padStart(14)}`);
    console.log(
      `    config: epoch_count=${cfg.epochCount} carry_over=${fmt(cfg.carryOver)} total_funded=${fmt(cfg.totalFunded)} to_founder=${fmt(cfg.totalToFounder)} to_holders=${fmt(cfg.totalToHolders)} claimed=${fmt(cfg.totalClaimed)} locked=${cfg.locked}`
    );
    await H.assertInvariants(city);
    console.log(`    accounting invariants: OK`);
  };
  await table("setup");

  // -------------------------------------------------------------------------
  headline("Fund epoch 0 with 1,000 reward tokens: 500 to the founder, 500 to the vault for holders");
  const deposit0 = 1_000n * UNIT;
  const split0 = H.splitAmount(deposit0, 5_000);
  const alloc0 = M.allocateProRata(
    holders.map((h) => ({ claimant: h.kp.publicKey.toBytes(), balance: h.balance })),
    split0.holders
  );
  const tree0 = M.buildTree(alloc0.leaves);
  console.log(`founder share    ${fmt(split0.founder)}   holders share ${fmt(split0.holders)}   (floor; remainder to holders)`);
  console.log(`pro-rata leaves  ${alloc0.leaves.map((l, i) => `${holders[i].name}=${fmt(l.amount)}`).join("  ")}   dust ${fmt(alloc0.dust)}`);
  console.log(`merkle root      ${M.toHex(tree0.root)}   leaves ${tree0.numLeaves} depth ${tree0.depth}`);
  const f0 = await H.fundEpoch(city, { amount: deposit0, tree: tree0, snapshotSlot: await connection.getSlot(), window: bounds.min });
  console.log(`tx               ${f0.signature}`);
  console.log(`epoch 0          holders_amount=${fmt(f0.epochView.holdersAmount)} num_leaves=${f0.epochView.numLeaves} deadline=${new Date(f0.epochView.claimDeadline * 1000).toISOString()} state=${f0.epochView.state}`);
  await table("fund_epoch(0)");

  // -------------------------------------------------------------------------
  headline("Ana, Ben and Cid claim their shares with Merkle proofs (Dee does not)");
  for (const i of [0, 1, 2]) {
    const args = M.claimArgs(tree0, i);
    const sig = await H.claim(city, { epochIndex: 0, tree: tree0, leafIndex: i, claimant: holders[i].kp });
    const cu = await client.computeUnitsOf(sig);
    console.log(`  ${holders[i].name} claims ${fmt(args.amount).padStart(10)}  proof length ${args.proof.length}  compute units ${cu}  tx ${short(sig)}`);
  }
  await table("three claims");

  // -------------------------------------------------------------------------
  headline("Attacks that must fail (the vault balance does not move)");
  const vaultBefore = await H.vaultBalance(city);
  // Every attack must be refused for the specific reason the spec names; a
  // refusal for another reason (or a success) fails the demo.
  const attempt = async (label: string, p: Promise<unknown>, expected: string | RegExp) => {
    try {
      await p;
      console.log(`  ${label.padEnd(44)} UNEXPECTEDLY SUCCEEDED`);
      process.exitCode = 1;
    } catch (e: any) {
      const text = H.errorText(e);
      // raw transactions (no Anchor wrapper) carry the code only in the logs
      const code = H.errorCode(e) ?? /Error Code: (\w+)/.exec(text)?.[1] ?? (/already in use/.test(text) ? "account already exists" : "rejected");
      const ok = typeof expected === "string" ? code === expected : expected.test(text);
      console.log(`  ${label.padEnd(44)} refused: ${code}${ok ? "" : `   <-- EXPECTED ${expected}`}`);
      if (!ok) process.exitCode = 1;
    }
  };
  await attempt("Ana claims a second time", H.claim(city, { epochIndex: 0, tree: tree0, leafIndex: 0, claimant: holders[0].kp }), H.ANCHOR.AlreadyInUse);
  await attempt("Dee claims with a bigger amount", H.claim(city, { epochIndex: 0, tree: tree0, leafIndex: 3, claimant: holders[3].kp, amount: M.claimArgs(tree0, 3).amount + 1n }), "InvalidProof");
  const thief = await H.fundedKeypair(1);
  await attempt("a stranger uses Dee's leaf", H.claim(city, { epochIndex: 0, leafIndex: 3, claimant: thief, amount: M.claimArgs(tree0, 3).amount, proof: M.claimArgs(tree0, 3).proof }), "InvalidProof");
  await attempt("Dee claims with a truncated proof", H.claim(city, { epochIndex: 0, leafIndex: 3, claimant: holders[3].kp, amount: M.claimArgs(tree0, 3).amount, proof: M.claimArgs(tree0, 3).proof.slice(1) }), "InvalidProof");
  await attempt("ops tries to sweep before the deadline", client.sweepEpoch({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 0 }).signers([city.authority]).rpc(), "ClaimDeadlineNotPassed");
  await attempt("ops tries to cancel an epoch with claims", client.cancelEpoch({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 0 }).signers([city.authority]).rpc(), "EpochHasClaims");
  await attempt("a stranger tries to pause", client.pause({ authority: thief.publicKey, cityCoinMint: city.cityCoinMint }).signers([thief]).rpc(), "Unauthorized");
  const squatMint = await H.createMint();
  const squat = await H.createCity({ model: "creator", cityCoinMint: squatMint, authority: thief, founder: thief, skipInit: true });
  // sent as a raw transaction (the stranger pays), so the code is read from the logs
  await attempt(
    "a stranger tries to create a city config (squat)",
    H.sendAs([await H.initCityTx(squat, { admin: thief.publicKey, payer: thief.publicKey }).instruction()], [thief]),
    /Error Code: Unauthorized\b/
  );
  await attempt("ops tries to lock again (auto-locked at fund)", client.lockConfig({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc(), "AlreadyLocked");
  console.log(`  vault before ${fmt(vaultBefore)} after ${fmt(await H.vaultBalance(city))}  (unchanged: ${vaultBefore === (await H.vaultBalance(city))})`);
  console.log(`  note: there is no withdraw instruction at all; the IDL lists: ${client.instructionNames().join(", ")}`);

  // -------------------------------------------------------------------------
  headline("Fund epoch 1 with 200, then cancel it before anyone claims (wrong snapshot caught in time)");
  const deposit1 = 200n * UNIT;
  const split1 = H.splitAmount(deposit1, 5_000);
  const alloc1 = M.allocateProRata(
    holders.map((h) => ({ claimant: h.kp.publicKey.toBytes(), balance: h.balance })),
    split1.holders
  );
  const tree1 = M.buildTree(alloc1.leaves);
  const f1 = await H.fundEpoch(city, { amount: deposit1, tree: tree1, window: normalWindow });
  console.log(`epoch 1 funded   founder +${fmt(split1.founder)}  holders_amount=${fmt(f1.epochView.holdersAmount)}  tx ${short(f1.signature)}`);
  const cancelSig = await client.cancelEpoch({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 1 }).signers([city.authority]).rpc();
  const e1 = await H.fetchEpoch(city, 1);
  console.log(`epoch 1 cancel   state=${e1.state}  carry_over now ${fmt((await H.fetchConfig(city)).carryOver)}  tx ${short(cancelSig)}`);
  await table("cancel_epoch(1)");

  // -------------------------------------------------------------------------
  headline("Fund epoch 2 with amount 0: the carry-over alone is distributed (founder gets nothing new)");
  const carry = (await H.fetchConfig(city)).carryOver;
  const alloc2 = M.allocateProRata(
    holders.map((h) => ({ claimant: h.kp.publicKey.toBytes(), balance: h.balance })),
    carry
  );
  const tree2 = M.buildTree(alloc2.leaves);
  const f2 = await H.fundEpoch(city, { amount: 0n, tree: tree2, window: normalWindow });
  console.log(`epoch 2          deposit=${fmt(f2.epochView.depositAmount ?? 0n)} holders_amount=${fmt(f2.epochView.holdersAmount)} (== carry-over) carry_over now ${fmt(f2.config.carryOver)}  tx ${short(f2.signature)}`);
  const sigDee = await H.claim(city, { epochIndex: 2, tree: tree2, leafIndex: 3, claimant: holders[3].kp });
  console.log(`Dee claims ${fmt(M.claimArgs(tree2, 3).amount)} from epoch 2  tx ${short(sigDee)}`);
  await table("fund_epoch(2) + Dee's claim");

  // -------------------------------------------------------------------------
  headline("A fee wallet sends 100 straight to the vault; fund_epoch_from_vault turns it into epoch 3 (50 to the founder, 50 for holders)");
  const direct = 100n * UNIT;
  await H.mintTo(city.rewardMint, city.vault, direct);
  const cfgBefore3 = await H.fetchConfig(city);
  const owed = cfgBefore3.totalToHolders - cfgBefore3.totalClaimed;
  console.log(`vault now holds ${fmt(await H.vaultBalance(city))}; it owes ${fmt(owed)} to open epochs and carry-over, so ${fmt((await H.vaultBalance(city)) - owed)} is unaccounted`);
  const split3 = H.splitAmount(direct, 5_000);
  const alloc3 = M.allocateProRata(
    holders.map((h) => ({ claimant: h.kp.publicKey.toBytes(), balance: h.balance })),
    split3.holders
  );
  const tree3 = M.buildTree(alloc3.leaves);
  const f3 = await H.fundEpochFromVault(city, { tree: tree3, window: normalWindow });
  console.log(`epoch 3          deposit=${fmt(f3.epochView.depositAmount ?? 0n)} founder=${fmt(f3.epochView.founderAmount ?? 0n)} (paid out of the vault, signed by the config PDA) holders_amount=${fmt(f3.epochView.holdersAmount)}  tx ${short(f3.signature)}`);
  await attempt("ops calls fund_epoch_from_vault again with nothing unaccounted", H.fundEpochFromVault(city, { tree: tree3, window: normalWindow }), "NothingToDistribute");
  await table("fund_epoch_from_vault(3)");

  // -------------------------------------------------------------------------
  if (bounds.min <= 120) {
    headline(`Wait for epoch 0's deadline (${bounds.min}s window) then sweep: Dee's unclaimed share rolls into carry-over`);
    const deadline = f0.epochView.claimDeadline;
    while ((await H.nowOnChain()) <= deadline) await H.sleep(1_000);
    const sweepSig = await client.sweepEpoch({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 0 }).signers([city.authority]).rpc();
    const e0 = await H.fetchEpoch(city, 0);
    console.log(`epoch 0 swept    state=${e0.state} unclaimed=${fmt(e0.holdersAmount - e0.claimedAmount)} carry_over=${fmt((await H.fetchConfig(city)).carryOver)}  tx ${short(sweepSig)}`);
    await attempt("Dee claims from the swept epoch 0", H.claim(city, { epochIndex: 0, tree: tree0, leafIndex: 3, claimant: holders[3].kp }), "EpochNotOpen");
    const rentBefore = await H.solBalance(holders[0].kp.publicKey);
    await client.closeClaimStatus({ claimant: holders[0].kp.publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 0 }).signers([holders[0].kp]).rpc();
    console.log(`Ana closes her claim status: rent back ${((await H.solBalance(holders[0].kp.publicKey)) - rentBefore) / 1e9} SOL`);
    await table("sweep_epoch(0)");
  } else {
    headline("Sweep skipped");
    console.log(`  MIN_CLAIM_WINDOW_SECS is ${bounds.min}s; sweep_epoch only works after the deadline, which cannot pass during a demo.`);
    console.log("  The test suite covers sweep with a short-window build (tests/04-sweep-cancel-deadline.ts).");
  }

  // -------------------------------------------------------------------------
  headline("Two-step authority transfer and pause/unpause");
  const newOps = await H.fundedKeypair(1);
  await client.proposeAuthority({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint, newAuthority: newOps.publicKey }).signers([city.authority]).rpc();
  console.log(`proposed         ${short(newOps.publicKey)} (pending; old authority still in charge)`);
  await client.acceptAuthority({ newAuthority: newOps.publicKey, cityCoinMint: city.cityCoinMint }).signers([newOps]).rpc();
  console.log(`accepted         authority is now ${short((await H.fetchConfig(city)).authority)}`);
  await attempt("old authority tries to pause", client.pause({ authority: city.authority.publicKey, cityCoinMint: city.cityCoinMint }).signers([city.authority]).rpc(), "Unauthorized");
  await client.pause({ authority: newOps.publicKey, cityCoinMint: city.cityCoinMint }).signers([newOps]).rpc();
  console.log(`paused           ${(await H.fetchConfig(city)).paused}`);
  await attempt("Ben claims while paused (epoch 2)", H.claim(city, { epochIndex: 2, tree: tree2, leafIndex: 1, claimant: holders[1].kp }), "Paused");
  await client.unpause({ authority: newOps.publicKey, cityCoinMint: city.cityCoinMint }).signers([newOps]).rpc();
  console.log(`unpaused         ${(await H.fetchConfig(city)).paused}`);
  city.authority = newOps;

  // -------------------------------------------------------------------------
  headline("Final state");
  await table("the whole demo");
  const cfg = await H.fetchConfig(city);
  console.log(`\n  economics unchanged since init: model=${cfg.rewardModel} founder_bps=${cfg.founderBps} reward_mint=${short(cfg.rewardMint)} vault=${short(cfg.vault)} locked=${cfg.locked}`);
  console.log(`  epochs:`);
  for (const e of await client.fetchEpochs(city.config)) {
    console.log(`    #${e.index} state=${e.state.padEnd(9)} deposit=${fmt(e.depositAmount ?? 0n).padStart(10)} founder=${fmt(e.founderAmount ?? 0n).padStart(10)} holders=${fmt(e.holdersAmount).padStart(10)} claimed=${fmt(e.claimedAmount).padStart(10)} leaves=${e.numLeaves}`);
  }
  console.log(`\nexplorer (local): https://explorer.solana.com/address/${city.config.toBase58()}?cluster=custom&customUrl=${encodeURIComponent(connection.rpcEndpoint)}`);
  console.log(process.exitCode ? "\nDEMO FINISHED WITH UNEXPECTED RESULTS (see the lines marked UNEXPECTEDLY or EXPECTED above)" : "\nDEMO COMPLETE: every step behaved as specified.");
}

main().catch((e) => {
  console.error("\ndemo failed:", e?.message ?? e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
