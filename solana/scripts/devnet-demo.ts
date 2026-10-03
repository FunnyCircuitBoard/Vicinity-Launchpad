// Devnet walk-through for the auditor: creates a test reward mint, the registry,
// one city config, one funded epoch with a 3-leaf tree, one claim, and a second
// epoch that is cancelled (carry-over). Prints every address with an explorer
// link and a JSON block for AUDIT.md.
//
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=<devnet deployer keypair, outside the repo> \
//   npm run devnet-demo
//
// The wallet must be the program's upgrade authority (it created the registry)
// or, once the registry exists, its admin. Nothing here is airdropped: the
// wallet pays for everything (about 0.03 SOL plus the registry and config rent).
// Sweep cannot be shown: the production minimum claim window is 14 days.

import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

if (!process.env.ANCHOR_PROVIDER_URL || !process.env.ANCHOR_WALLET) {
  console.error("set ANCHOR_PROVIDER_URL (devnet RPC) and ANCHOR_WALLET (the devnet deployer keypair)");
  process.exit(2);
}

type Helpers = typeof import("../tests/helpers");
type Merkle = typeof import("../tests/merkle-types");

const UNIT = 1_000_000n;
const fmt = (v: bigint) => {
  const whole = v / UNIT;
  const frac = (v % UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const cluster = (process.env.ANCHOR_PROVIDER_URL ?? "").includes("devnet") ? "devnet" : "custom";
const explorer = (kind: "address" | "tx", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=${cluster}`;

async function main() {
  const H: Helpers = await import("../tests/helpers");
  const M: Merkle = await import("../tests/merkle-types");
  const { client, connection, payer } = H;
  const record: Record<string, unknown> = { cluster, rpc: connection.rpcEndpoint, programId: client.programId.toBase58(), transactions: {} as Record<string, string> };
  const txs = record.transactions as Record<string, string>;
  const say = (label: string, id: string, kind: "address" | "tx" = "address") => console.log(`${label.padEnd(28)} ${id}\n${"".padEnd(28)} ${explorer(kind, id)}`);

  console.log(`RPC      ${connection.rpcEndpoint}`);
  say("program", client.programId.toBase58());
  say("wallet (deployer, admin)", payer.publicKey.toBase58());
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`wallet balance ${balance / 1e9} SOL`);
  if (balance < 0.1e9) throw new Error("the wallet needs at least 0.1 SOL");

  // ---- registry -----------------------------------------------------------
  let reg = await client.fetchRegistry();
  if (!reg) {
    txs.initRegistry = await client.initRegistry({ payer: payer.publicKey, upgradeAuthority: payer.publicKey, admin: payer.publicKey }).rpc();
    reg = (await client.fetchRegistry())!;
  }
  say("registry PDA", reg.address.toBase58());
  console.log(`${"".padEnd(28)} admin ${reg.admin.toBase58()}`);
  record.registry = { address: reg.address.toBase58(), admin: reg.admin.toBase58() };

  // ---- city ---------------------------------------------------------------
  // The deployer is payer, admin, authority and funder; the founder is a fresh
  // keypair (its ATA is created by fund_epoch). Holders are fresh keypairs
  // funded by the deployer with a little SOL for claim rent and fees.
  const founder = Keypair.generate();
  const city = await H.createCity({
    model: "split",
    founderBps: 5_000,
    tag: "devnet-demo",
    name: "devnet-demo",
    authority: payer,
    funder: payer,
    founder,
    funderBalance: 1_000n * UNIT,
  });
  say("city coin mint (test)", city.cityCoinMint.toBase58());
  say("reward mint (test, 6 dec)", city.rewardMint.toBase58());
  say("config PDA", city.config.toBase58());
  say("vault PDA (token account)", city.vault.toBase58());
  say("founder", founder.publicKey.toBase58());
  record.city = {
    cityCoinMint: city.cityCoinMint.toBase58(),
    rewardMint: city.rewardMint.toBase58(),
    config: city.config.toBase58(),
    vault: city.vault.toBase58(),
    authority: payer.publicKey.toBase58(),
    founder: founder.publicKey.toBase58(),
    rewardModel: "split",
    founderBps: 5000,
  };

  // ---- holders ------------------------------------------------------------
  const holders = [
    { name: "holder-a", kp: Keypair.generate(), balance: 500_000n },
    { name: "holder-b", kp: Keypair.generate(), balance: 300_000n },
    { name: "holder-c", kp: Keypair.generate(), balance: 200_000n },
  ];
  const fund = new Transaction();
  for (const h of holders) fund.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: h.kp.publicKey, lamports: 6_000_000 }));
  txs.fundHolders = await sendAndConfirmTransaction(connection, fund, [payer], { commitment: "confirmed" });

  // ---- epoch 0: 100 reward tokens, 50 founder / 50 holders ----------------
  const deposit0 = 100n * UNIT;
  const split0 = H.splitAmount(deposit0, 5_000);
  const alloc0 = M.allocateProRata(
    holders.map((h) => ({ claimant: h.kp.publicKey.toBytes(), balance: h.balance })),
    split0.holders
  );
  const tree0 = M.buildTree(alloc0.leaves);
  const snapshotFile = JSON.stringify({ slot: await connection.getSlot("confirmed"), mint: city.cityCoinMint.toBase58(), amount: split0.holders.toString(), leaves: alloc0.leaves.map((l, i) => ({ index: i, claimant: holders[i].kp.publicKey.toBase58(), amount: l.amount.toString() })) });
  const snapshotHash = M.sha256(Buffer.from(snapshotFile));
  const f0 = await H.fundEpoch(city, { amount: deposit0, tree: tree0, snapshotHash, window: client.claimWindowBounds().min });
  txs.fundEpoch0 = f0.signature;
  say("epoch 0 PDA", f0.epoch.toBase58());
  console.log(`${"".padEnd(28)} deposit ${fmt(deposit0)} founder ${fmt(f0.epochView.founderAmount ?? 0n)} holders ${fmt(f0.epochView.holdersAmount)} leaves ${f0.epochView.numLeaves} root ${M.toHex(tree0.root)}`);
  console.log(`${"".padEnd(28)} claim deadline ${new Date(f0.epochView.claimDeadline * 1000).toISOString()} (sweep_epoch(0) works after this)`);
  record.epoch0 = {
    address: f0.epoch.toBase58(),
    merkleRoot: M.toHex(tree0.root),
    snapshotHash: M.toHex(snapshotHash),
    snapshotFile: JSON.parse(snapshotFile),
    depositAmount: deposit0.toString(),
    founderAmount: (f0.epochView.founderAmount ?? 0n).toString(),
    holdersAmount: f0.epochView.holdersAmount.toString(),
    numLeaves: f0.epochView.numLeaves,
    claimDeadline: new Date(f0.epochView.claimDeadline * 1000).toISOString(),
  };

  // ---- one claim ----------------------------------------------------------
  const args = M.claimArgs(tree0, 0);
  txs.claimHolderA = await H.claim(city, { epochIndex: 0, tree: tree0, leafIndex: 0, claimant: holders[0].kp });
  const cu = await client.computeUnitsOf(txs.claimHolderA);
  say("holder-a", holders[0].kp.publicKey.toBase58());
  console.log(`${"".padEnd(28)} claimed ${fmt(args.amount)} with a ${args.proof.length}-hash proof, ${cu} compute units`);
  say("holder-a claim status PDA", H.claimStatusAddress(city, 0, holders[0].kp.publicKey).toBase58());
  record.claim = {
    claimant: holders[0].kp.publicKey.toBase58(),
    claimStatus: H.claimStatusAddress(city, 0, holders[0].kp.publicKey).toBase58(),
    amount: args.amount.toString(),
    proofLength: args.proof.length,
    computeUnits: cu,
  };

  // ---- epoch 1 funded and cancelled (carry-over) --------------------------
  const deposit1 = 20n * UNIT;
  const alloc1 = M.allocateProRata(
    holders.map((h) => ({ claimant: h.kp.publicKey.toBytes(), balance: h.balance })),
    H.splitAmount(deposit1, 5_000).holders
  );
  const tree1 = M.buildTree(alloc1.leaves);
  const f1 = await H.fundEpoch(city, { amount: deposit1, tree: tree1 });
  txs.fundEpoch1 = f1.signature;
  txs.cancelEpoch1 = await client.cancelEpoch({ authority: payer.publicKey, cityCoinMint: city.cityCoinMint, epochIndex: 1 }).rpc();
  say("epoch 1 PDA (cancelled)", f1.epoch.toBase58());
  const cfg = await H.fetchConfig(city);
  console.log(`${"".padEnd(28)} carry_over now ${fmt(cfg.carryOver)} (distributed by the next epoch)`);
  record.epoch1 = { address: f1.epoch.toBase58(), state: "cancelled", carryOver: cfg.carryOver.toString() };

  // ---- final state ---------------------------------------------------------
  await H.assertInvariants(city);
  console.log("\naccounting invariants: OK");
  console.log(`vault ${fmt(await H.vaultBalance(city))}  founder ${fmt(await H.founderBalance(city))}  total_funded ${fmt(cfg.totalFunded)}  to_founder ${fmt(cfg.totalToFounder)}  to_holders ${fmt(cfg.totalToHolders)}  claimed ${fmt(cfg.totalClaimed)}  carry_over ${fmt(cfg.carryOver)}`);
  record.finalState = {
    vault: (await H.vaultBalance(city)).toString(),
    founderBalance: (await H.founderBalance(city)).toString(),
    totalFunded: cfg.totalFunded.toString(),
    totalToFounder: cfg.totalToFounder.toString(),
    totalToHolders: cfg.totalToHolders.toString(),
    totalClaimed: cfg.totalClaimed.toString(),
    carryOver: cfg.carryOver.toString(),
    locked: cfg.locked,
  };
  console.log("\ntransactions:");
  for (const [k, v] of Object.entries(txs)) say(`  ${k}`, v, "tx");
  console.log("\nJSON for AUDIT.md:\n" + JSON.stringify(record, null, 2));
}

main().catch((e) => {
  console.error("\ndevnet demo failed:", e?.message ?? e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
