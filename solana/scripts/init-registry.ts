// One-time step after a deploy: create the registry that says who may create
// city configs, and hand the admin role to the multisig.
//
//   ANCHOR_PROVIDER_URL=<rpc url> \
//   ANCHOR_WALLET=<upgrade authority keypair> \
//   [REGISTRY_ADMIN=<public key of the multisig, for example the Squads vault>] \
//   npm run init-registry
//
// The wallet must be the program's current upgrade authority (the key that ran
// `anchor deploy`); it pays the registry rent (0.00102 SOL). The registry is
// always created with the wallet itself as admin: the program requires the
// admin to sign `init_registry`, so a key nobody controls (a typo, the vault of
// the wrong multisig) can never become the only key that may create cities,
// which would leave `init_city` unusable for ever (there is no second
// `init_registry` and `propose_admin` needs the stored admin).
//
// With REGISTRY_ADMIN the script then proposes that key (`propose_admin`) and
// prints the `accept_admin` instruction the multisig has to execute. The accept
// proves the key is live. Hand the upgrade authority over (README.md, mainnet
// step 6) only after a rerun of this script prints the multisig as admin.
//
// Safe to run any number of times: it does nothing that is already done.

import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { VicinityClient, loadIdl, anchor, upgradeAuthorityOf } from "../sdk/client";

if (!process.env.ANCHOR_PROVIDER_URL || !process.env.ANCHOR_WALLET) {
  console.error("set ANCHOR_PROVIDER_URL (RPC url) and ANCHOR_WALLET (the upgrade authority keypair)");
  process.exit(2);
}

const url = process.env.ANCHOR_PROVIDER_URL;
const cluster = url.includes("devnet") ? "devnet" : url.includes("mainnet") ? "mainnet" : "custom";
const explorer = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}${cluster === "mainnet" ? "" : `?cluster=${cluster}`}`;

async function main() {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);
  const client = new VicinityClient(provider, loadIdl());
  const wallet = provider.wallet.publicKey;
  const target = process.env.REGISTRY_ADMIN ? new PublicKey(process.env.REGISTRY_ADMIN) : null;

  console.log(`RPC                 ${url}`);
  console.log(`program             ${client.programId.toBase58()}  ${explorer("address", client.programId.toBase58())}`);
  console.log(`wallet              ${wallet.toBase58()}`);
  console.log(`registry PDA        ${client.registryAddress().toBase58()}`);
  if (target) console.log(`admin to hand to    ${target.toBase58()}`);

  const programData = await provider.connection.getAccountInfo(client.programDataAddress(), "confirmed");
  if (!programData) throw new Error("the program is not deployed on this cluster (no ProgramData account)");
  const authority = upgradeAuthorityOf(programData.data);
  console.log(`upgrade authority   ${authority ? authority.toBase58() : "none (the program is frozen)"}`);

  let registry = await client.fetchRegistry();
  if (!registry) {
    if (!authority) throw new Error("the program has no upgrade authority, so init_registry can never run on this program id");
    if (!authority.equals(wallet)) throw new Error("the wallet is not the upgrade authority; init_registry would be refused (NotUpgradeAuthority)");
    // admin = the wallet: the only key this script can make sign
    const signature = await client.initRegistry({ payer: wallet, upgradeAuthority: wallet, admin: wallet }).rpc();
    registry = await client.fetchRegistry();
    if (!registry || !registry.admin.equals(wallet)) throw new Error("the registry was not created as expected");
    console.log(`\nregistry created    ${registry.address.toBase58()}  admin ${registry.admin.toBase58()} (the wallet)`);
    console.log(`transaction         ${signature}\n                    ${explorer("tx", signature)}`);
  } else {
    console.log(`\nregistry exists     ${registry.address.toBase58()}  admin ${registry.admin.toBase58()}${registry.admin.equals(wallet) ? " (the wallet)" : ""}`);
    if (!registry.pendingAdmin.equals(PublicKey.default)) console.log(`pending admin       ${registry.pendingAdmin.toBase58()} (waiting for accept_admin)`);
  }

  if (!target) {
    if (registry.admin.equals(wallet)) {
      console.log("\nthe wallet is the admin. To hand the role to the multisig run again with REGISTRY_ADMIN=<its address>.");
    }
    return;
  }
  if (registry.admin.equals(target)) {
    console.log("\nthe multisig is the admin; done. Next: README.md, mainnet step 6 (move the upgrade authority).");
    return;
  }
  if (!registry.admin.equals(wallet)) {
    throw new Error(`only the current admin ${registry.admin.toBase58()} can propose a new one; this wallet is not it`);
  }

  // What is known about the target before proposing it. None of this blocks
  // the proposal: a wrong key simply never accepts and the wallet stays admin.
  const targetInfo = await provider.connection.getAccountInfo(target, "confirmed");
  console.log(`\nabout ${target.toBase58()}:`);
  console.log(`  ${PublicKey.isOnCurve(target.toBytes()) ? "an ordinary key (wallet)" : "off the ed25519 curve: a program address, for example a Squads vault"}`);
  console.log(`  ${targetInfo ? `account exists, ${targetInfo.lamports} lamports, owner ${targetInfo.owner.toBase58()}` : "no account on chain yet (normal for a vault that never received SOL; double check the address)"}`);
  if (targetInfo?.owner.equals(client.programId)) throw new Error("that address is an account of this program; it can never sign accept_admin");

  if (registry.pendingAdmin.equals(target)) {
    console.log("\nalready proposed; waiting for accept_admin.");
  } else {
    const signature = await client.proposeAdmin({ admin: wallet, newAdmin: target }).rpc();
    console.log(`\nproposed            ${target.toBase58()} as admin (the wallet stays admin until it accepts)`);
    console.log(`transaction         ${signature}\n                    ${explorer("tx", signature)}`);
  }

  // The instruction the multisig executes (Squads: a custom instruction in a
  // vault transaction, signed by the vault). Accounts in IDL order.
  const accept = await client.acceptAdmin({ newAdmin: target }).instruction();
  console.log("\naccept_admin instruction for the multisig:");
  console.log(`  program            ${accept.programId.toBase58()}`);
  for (const k of accept.keys) {
    console.log(`  account            ${k.pubkey.toBase58()}  ${k.isSigner ? "signer" : "      "}  ${k.isWritable ? "writable" : "        "}`);
  }
  console.log(`  data (hex)         ${Buffer.from(accept.data).toString("hex")}`);
  console.log("\nnext: after the multisig executed accept_admin, run this script again; it must print the multisig as admin.");
  console.log("Only then move the upgrade authority (README.md, mainnet step 6).");
}

main().catch((e) => {
  console.error("\ninit-registry failed:", e?.message ?? e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
