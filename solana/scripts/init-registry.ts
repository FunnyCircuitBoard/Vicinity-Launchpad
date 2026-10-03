// One-time step after a deploy: create the registry that says who may create
// city configs. The wallet must be the program's current upgrade authority
// (the key that ran `anchor deploy`); it pays the registry rent (0.00102 SOL).
//
//   ANCHOR_PROVIDER_URL=<rpc url> \
//   ANCHOR_WALLET=<upgrade authority keypair> \
//   REGISTRY_ADMIN=<public key of the admin, for example the Squads vault> \
//   npm run init-registry
//
// Without REGISTRY_ADMIN the wallet itself becomes the admin (fine on devnet;
// on mainnet pass the multisig). The script refuses to run when the wallet is
// not the on-chain upgrade authority and does nothing when the registry
// already exists, so it is safe to run twice.

import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { VicinityClient, loadIdl, anchor } from "../sdk/client";

if (!process.env.ANCHOR_PROVIDER_URL || !process.env.ANCHOR_WALLET) {
  console.error("set ANCHOR_PROVIDER_URL (RPC url) and ANCHOR_WALLET (the upgrade authority keypair)");
  process.exit(2);
}

const url = process.env.ANCHOR_PROVIDER_URL;
const cluster = url.includes("devnet") ? "devnet" : url.includes("mainnet") ? "mainnet" : "custom";
const explorer = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}${cluster === "mainnet" ? "" : `?cluster=${cluster}`}`;

// ProgramData account of the BPF upgradeable loader: u32 variant (3) | u64 slot
// | Option<Pubkey> upgrade authority (1 byte tag, 32 bytes key).
function upgradeAuthorityOf(data: Buffer): PublicKey | null {
  if (data.length < 45 || data.readUInt32LE(0) !== 3) throw new Error("not a ProgramData account");
  return data[12] === 1 ? new PublicKey(data.subarray(13, 45)) : null;
}

async function main() {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);
  const client = new VicinityClient(provider, loadIdl());
  const wallet = provider.wallet.publicKey;
  const admin = process.env.REGISTRY_ADMIN ? new PublicKey(process.env.REGISTRY_ADMIN) : wallet;

  console.log(`RPC                 ${url}`);
  console.log(`program             ${client.programId.toBase58()}  ${explorer("address", client.programId.toBase58())}`);
  console.log(`wallet              ${wallet.toBase58()}`);
  console.log(`registry PDA        ${client.registryAddress().toBase58()}`);
  console.log(`admin to be stored  ${admin.toBase58()}${admin.equals(wallet) ? "  (the wallet itself; pass REGISTRY_ADMIN for a multisig)" : ""}`);

  const programData = await provider.connection.getAccountInfo(client.programDataAddress(), "confirmed");
  if (!programData) throw new Error("the program is not deployed on this cluster (no ProgramData account)");
  const authority = upgradeAuthorityOf(programData.data);
  console.log(`upgrade authority   ${authority ? authority.toBase58() : "none (the program is frozen)"}`);
  if (!authority) throw new Error("the program has no upgrade authority, so init_registry can never run on this program id");
  if (!authority.equals(wallet)) throw new Error("the wallet is not the upgrade authority; init_registry would be refused (NotUpgradeAuthority)");

  const existing = await client.fetchRegistry();
  if (existing) {
    console.log(`\nthe registry already exists with admin ${existing.admin.toBase58()}; nothing to do`);
    return;
  }

  const signature = await client.initRegistry({ payer: wallet, upgradeAuthority: wallet, admin }).rpc();
  const created = await client.fetchRegistry();
  if (!created || !created.admin.equals(admin)) throw new Error("the registry was not created as expected");
  console.log(`\nregistry created    ${created.address.toBase58()}  admin ${created.admin.toBase58()}`);
  console.log(`transaction         ${signature}\n                    ${explorer("tx", signature)}`);
  console.log("\nnext: move the upgrade authority to the multisig (README.md, mainnet step 6)");
}

main().catch((e) => {
  console.error("\ninit-registry failed:", e?.message ?? e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
