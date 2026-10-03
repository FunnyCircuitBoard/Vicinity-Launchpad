// Shared test harness: provider, SDK client, mints/ATAs, cities, trees, error
// matching and the accounting invariants that every test file asserts.
//
// Runs against the validator `anchor test` starts (ANCHOR_PROVIDER_URL and
// ANCHOR_WALLET are set by Anchor). Every test file creates its own city coin
// mint, so files are independent and can run in any order.

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
  createMintToInstruction,
  MINT_SIZE,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  VicinityClient,
  camel,
  loadIdl,
  splitAmount,
  type RewardModelName,
  type CityConfigView,
  type EpochView,
} from "../sdk/client";
import { buildTree, claimArgs, getProof, hashLeaf, hashNode, sha256, type Tree } from "./merkle-types";

export { buildTree, claimArgs, getProof, hashLeaf, hashNode, sha256, splitAmount, BN, PublicKey, Keypair, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };
export type { Tree, CityConfigView, EpochView, RewardModelName };

// ---------------------------------------------------------------------------
// provider + client (confirmed commitment so getTransaction sees our logs)

function makeProvider(): AnchorProvider {
  const env = AnchorProvider.env();
  const connection = new Connection(env.connection.rpcEndpoint, "confirmed");
  const p = new AnchorProvider(connection, env.wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
  anchor.setProvider(p);
  return p;
}

export const provider = makeProvider();
export const connection = provider.connection;
export const payer: Keypair = (provider.wallet as anchor.Wallet).payer;
export const client = new VicinityClient(provider, loadIdl());
export const program = client.program;

export const DECIMALS = 6;
export const sol = (n: number) => Math.floor(n * LAMPORTS_PER_SOL);

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// lamports and tokens

export async function airdrop(pk: PublicKey, amountSol = 2): Promise<void> {
  const sig = await connection.requestAirdrop(pk, sol(amountSol));
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

export async function fundedKeypair(amountSol = 2): Promise<Keypair> {
  const kp = Keypair.generate();
  await airdrop(kp.publicKey, amountSol);
  return kp;
}

export async function solBalance(pk: PublicKey): Promise<number> {
  return connection.getBalance(pk, "confirmed");
}

export async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(connection, tx, [payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))], {
    commitment: "confirmed",
  });
}

export async function createMint(decimals = DECIMALS, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): Promise<PublicKey> {
  const mint = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: tokenProgram,
      }),
      createInitializeMintInstruction(mint.publicKey, decimals, payer.publicKey, null, tokenProgram),
    ],
    [mint]
  );
  return mint.publicKey;
}

// Token-2022 mint with the TransferFeeConfig extension (fee in bps, max fee).
export async function createTransferFeeMint(feeBps = 100, maxFee = 1_000_000n, decimals = DECIMALS): Promise<PublicKey> {
  const mint = Keypair.generate();
  const len = getMintLen([ExtensionType.TransferFeeConfig]);
  const lamports = await connection.getMinimumBalanceForRentExemption(len);
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: len,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferFeeConfigInstruction(mint.publicKey, payer.publicKey, payer.publicKey, feeBps, maxFee, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, decimals, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ],
    [mint]
  );
  return mint.publicKey;
}

export function ata(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
}

// Creates the ATA (idempotent) and mints `amount` into it. Mint authority is `payer`.
export async function createTokenAccount(
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint = 0n,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID
): Promise<PublicKey> {
  const address = ata(mint, owner, tokenProgram);
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, address, owner, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID)];
  if (amount > 0n) ixs.push(createMintToInstruction(mint, address, payer.publicKey, amount, [], tokenProgram));
  await send(ixs, []);
  return address;
}

export async function mintTo(mint: PublicKey, dest: PublicKey, amount: bigint, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): Promise<void> {
  await send([createMintToInstruction(mint, dest, payer.publicKey, amount, [], tokenProgram)], []);
}

// 0n when the account does not exist (a claimant before the first claim).
export async function tokenBalance(address: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): Promise<bigint> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) return 0n;
  const acc = await getAccount(connection, address, "confirmed", tokenProgram);
  return acc.amount;
}

export async function accountExists(address: PublicKey): Promise<boolean> {
  return (await connection.getAccountInfo(address, "confirmed")) !== null;
}

export async function nowOnChain(): Promise<number> {
  const info = await connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY, "confirmed");
  if (!info) throw new Error("no clock sysvar");
  // Clock: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64
  return Number(info.data.readBigInt64LE(32));
}

// ---------------------------------------------------------------------------
// cities

export interface City {
  name: string;
  cityCoinMint: PublicKey;
  rewardMint: PublicKey;
  tokenProgram: PublicKey;
  config: PublicKey;
  vault: PublicKey;
  authority: Keypair;
  founder: Keypair;
  funder: Keypair;
  funderTokenAccount: PublicKey;
  model: RewardModelName;
  founderBps: number;
  tag: string;
}

export interface CreateCityOptions {
  name?: string;
  model: RewardModelName;
  founderBps?: number;
  tag?: string;
  rewardMint?: PublicKey;
  cityCoinMint?: PublicKey;
  tokenProgram?: PublicKey;
  authority?: Keypair;
  founder?: Keypair;
  funder?: Keypair;
  funderBalance?: bigint;
  skipInit?: boolean;
  overrides?: Record<string, PublicKey>;
}

const registry: City[] = [];

export function registeredCities(): City[] {
  return registry.slice();
}

export async function createCity(o: CreateCityOptions): Promise<City> {
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  const authority = o.authority ?? (await fundedKeypair(2));
  const founder = o.founder ?? (await fundedKeypair(0.5));
  const funder = o.funder ?? (await fundedKeypair(2));
  const cityCoinMint = o.cityCoinMint ?? (await createMint(DECIMALS, TOKEN_PROGRAM_ID));
  const rewardMint = o.rewardMint ?? (await createMint(DECIMALS, tokenProgram));
  const founderBps = o.founderBps ?? (o.model === "creator" ? 10_000 : o.model === "holders" ? 0 : 5_000);
  const tag = o.tag ?? `test-${o.model}-${founderBps}`;
  const { config, vault } = client.city(cityCoinMint);
  const funderTokenAccount = await createTokenAccount(rewardMint, funder.publicKey, o.funderBalance ?? 1_000_000_000_000n, tokenProgram);
  const city: City = { name: o.name ?? tag, cityCoinMint, rewardMint, tokenProgram, config, vault, authority, founder, funder, funderTokenAccount, model: o.model, founderBps, tag };
  if (!o.skipInit) {
    await client
      .initCity({
        payer: payer.publicKey,
        authority: authority.publicKey,
        founder: founder.publicKey,
        cityCoinMint,
        rewardMint,
        rewardModel: o.model,
        founderBps,
        cityTag: tag,
        tokenProgram,
        overrides: o.overrides,
      })
      .signers([authority])
      .rpc();
    registry.push(city);
  }
  return city;
}

export function initCityTx(city: City, extra: { founderBps?: number; model?: RewardModelName; tag?: string | number[]; founder?: PublicKey; rewardMint?: PublicKey; overrides?: Record<string, PublicKey> } = {}) {
  return client.initCity({
    payer: payer.publicKey,
    authority: city.authority.publicKey,
    founder: extra.founder ?? city.founder.publicKey,
    cityCoinMint: city.cityCoinMint,
    rewardMint: extra.rewardMint ?? city.rewardMint,
    rewardModel: extra.model ?? city.model,
    founderBps: extra.founderBps ?? city.founderBps,
    cityTag: extra.tag ?? city.tag,
    tokenProgram: city.tokenProgram,
    overrides: extra.overrides,
  });
}

export const fetchConfig = (city: City) => client.fetchConfig(city.config);
export const epochAddress = (city: City, index: bigint | number) => client.epochAddress(city.config, index);
export const fetchEpoch = (city: City, index: bigint | number) => client.fetchEpoch(epochAddress(city, index));
export const founderAta = (city: City) => ata(city.rewardMint, city.founder.publicKey, city.tokenProgram);
export const vaultBalance = (city: City) => tokenBalance(city.vault, city.tokenProgram);
export const founderBalance = (city: City) => tokenBalance(founderAta(city), city.tokenProgram);

// ---------------------------------------------------------------------------
// holders and trees

export interface Holders {
  keypairs: Keypair[];
  amounts: bigint[];
  tree: Tree;
  total: bigint;
}

// Keypairs are not funded; fund the ones that will claim with airdrop().
export function makeHolders(amounts: Array<bigint | number>): Holders {
  const keypairs = amounts.map(() => Keypair.generate());
  const amts = amounts.map((a) => BigInt(a));
  const tree = buildTree(keypairs.map((k, i) => ({ claimant: k.publicKey.toBytes(), amount: amts[i] })));
  return { keypairs, amounts: amts, tree, total: tree.total };
}

export function windowBounds() {
  return client.claimWindowBounds();
}

export interface FundOptions {
  amount: bigint | number;
  tree?: Tree;
  root?: Uint8Array | number[];
  numLeaves?: number;
  snapshotSlot?: bigint | number;
  snapshotHash?: Uint8Array;
  window?: number;
  authority?: Keypair;
  funder?: Keypair;
  funderTokenAccount?: PublicKey;
  founder?: PublicKey;
  rewardMint?: PublicKey;
  tokenProgram?: PublicKey;
  overrides?: Record<string, PublicKey>;
}

export async function fundEpochTx(city: City, o: FundOptions) {
  const authority = o.authority ?? city.authority;
  const funder = o.funder ?? city.funder;
  return client.fundEpoch({
    authority: authority.publicKey,
    funder: funder.publicKey,
    funderTokenAccount: o.funderTokenAccount ?? city.funderTokenAccount,
    cityCoinMint: city.cityCoinMint,
    amount: o.amount,
    merkleRoot: o.root ?? o.tree?.root,
    numLeaves: o.numLeaves ?? o.tree?.numLeaves ?? 0,
    snapshotSlot: o.snapshotSlot ?? (await connection.getSlot("confirmed")),
    snapshotHash: o.snapshotHash ?? (o.tree ? sha256(o.tree.root) : new Uint8Array(32)),
    claimWindowSecs: o.window ?? windowBounds().min,
    founder: o.founder,
    rewardMint: o.rewardMint,
    tokenProgram: o.tokenProgram ?? city.tokenProgram,
    overrides: o.overrides,
  });
}

export async function fundEpoch(city: City, o: FundOptions): Promise<{ signature: string; index: bigint; epoch: PublicKey; config: CityConfigView; epochView: EpochView }> {
  const before = await fetchConfig(city);
  const authority = o.authority ?? city.authority;
  const funder = o.funder ?? city.funder;
  const signers = authority.publicKey.equals(funder.publicKey) ? [authority] : [authority, funder];
  const signature = await (await fundEpochTx(city, o)).signers(signers).rpc();
  const epoch = epochAddress(city, before.epochCount);
  return { signature, index: before.epochCount, epoch, config: await fetchConfig(city), epochView: await client.fetchEpoch(epoch) };
}

export interface ClaimOptions {
  epochIndex: bigint | number;
  claimant: Keypair;
  tree?: Tree;
  leafIndex?: number;
  amount?: bigint | number;
  proof?: Uint8Array[];
  tokenProgram?: PublicKey;
  overrides?: Record<string, PublicKey>;
}

export async function claimTx(city: City, o: ClaimOptions) {
  let leafIndex = o.leafIndex;
  let amount = o.amount;
  let proof = o.proof;
  if (o.tree && leafIndex !== undefined) {
    const args = claimArgs(o.tree, leafIndex);
    amount = amount ?? args.amount;
    proof = proof ?? args.proof;
  }
  if (leafIndex === undefined || amount === undefined || proof === undefined) throw new Error("claimTx needs tree+leafIndex or explicit leafIndex, amount, proof");
  return client.claim({
    claimant: o.claimant.publicKey,
    cityCoinMint: city.cityCoinMint,
    epochIndex: o.epochIndex,
    leafIndex,
    amount,
    proof,
    rewardMint: city.rewardMint,
    tokenProgram: o.tokenProgram ?? city.tokenProgram,
    overrides: o.overrides,
  });
}

export async function claim(city: City, o: ClaimOptions): Promise<string> {
  return (await claimTx(city, o)).signers([o.claimant]).rpc();
}

export const claimantAta = (city: City, claimant: PublicKey) => ata(city.rewardMint, claimant, city.tokenProgram);
export const claimStatusAddress = (city: City, epochIndex: bigint | number, claimant: PublicKey) =>
  client.claimAddress(epochAddress(city, epochIndex), claimant);

// A depth-`depth` proof for one leaf whose siblings are arbitrary hashes. The
// resulting root is valid for exactly this leaf (the other leaves are unknown),
// which is what a compute-unit measurement needs without building 2^20 leaves.
export function craftDeepProof(leafIndex: number, claimant: PublicKey, amount: bigint, depth: number) {
  const leaf = hashLeaf(leafIndex, claimant.toBytes(), amount);
  const proof: Uint8Array[] = [];
  let node = leaf;
  for (let i = 0; i < depth; i++) {
    const sibling = sha256(Buffer.from(`sibling-${i}-${leafIndex}`));
    proof.push(sibling);
    node = hashNode(node, sibling);
  }
  return { root: node, proof, leaf };
}

// ---------------------------------------------------------------------------
// errors

export const ANCHOR = {
  ConstraintSeeds: "ConstraintSeeds",
  ConstraintHasOne: "ConstraintHasOne",
  ConstraintTokenMint: "ConstraintTokenMint",
  ConstraintTokenOwner: "ConstraintTokenOwner",
  ConstraintTokenTokenProgram: "ConstraintTokenTokenProgram",
  ConstraintMintTokenProgram: "ConstraintMintTokenProgram",
  ConstraintAssociated: "ConstraintAssociated",
  ConstraintAssociatedInit: "ConstraintAssociatedInit",
  ConstraintRaw: "ConstraintRaw",
  AccountNotInitialized: "AccountNotInitialized",
  AccountOwnedByWrongProgram: "AccountOwnedByWrongProgram",
  AccountDiscriminatorMismatch: "AccountDiscriminatorMismatch",
  AccountNotAssociatedTokenAccount: "AccountNotAssociatedTokenAccount",
  InvalidProgramId: "InvalidProgramId",
  AccountNotSystemOwned: "AccountNotSystemOwned",
  // the system program refuses to create an account that exists (init on a live PDA)
  AlreadyInUse: /already in use|custom program error: 0x0\b/,
  // SPL token: insufficient funds (custom program error 0x1)
  InsufficientFunds: /insufficient funds|custom program error: 0x1\b/,
  // Anchor runs init_if_needed CPIs before has_one/token_program constraints, so an
  // inconsistent attacker set can fail inside the Token / ATA program first.
  IncorrectProgramId: /incorrect program id|IncorrectProgramId/,
  UnknownAccount: /unknown account|required by the instruction is missing/,
  // web3.js refuses to serialize a legacy transaction above 1232 bytes
  TransactionTooLarge: /Transaction too large/,
};

// Bytes of a legacy `claim` transaction with the claimant as the only signer:
// 1 signature, 11 account keys, blockhash, instruction header and 32 bytes of
// fixed args; every proof element adds 32. The runtime caps a transaction at
// 1232 bytes, so the deepest proof that fits is floor((1232 - 500) / 32) = 22.
export const CLAIM_TX_BASE_BYTES = 500;
export const MAX_LEGACY_TX_BYTES = 1232;
export const MAX_PROOF_DEPTH_LEGACY_TX = Math.floor((MAX_LEGACY_TX_BYTES - CLAIM_TX_BASE_BYTES) / 32);

// Hand-encoded `claim` instruction (Anchor's TS coder has a 1000-byte buffer and
// cannot encode proofs longer than 30 elements). Accounts in IDL order.
export function rawClaimInstruction(
  city: City,
  o: { claimant: Keypair; epochIndex: bigint | number; leafIndex: number; amount: bigint; proof: Uint8Array[] }
): TransactionInstruction {
  const ix = client.instruction("claim") as unknown as { accounts: Array<{ name: string; writable?: boolean; signer?: boolean }>; discriminator: number[] };
  const { config, vault } = client.city(city.cityCoinMint);
  const epoch = epochAddress(city, o.epochIndex);
  const accounts = client.resolveAccounts("claim", {
    claimant: o.claimant.publicKey,
    claimantTokenAccount: claimantAta(city, o.claimant.publicKey),
    rewardMint: city.rewardMint,
    config,
    vault,
    epoch,
    claimStatus: client.claimAddress(epoch, o.claimant.publicKey),
    tokenProgram: city.tokenProgram,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  });
  const keys = ix.accounts.map((a) => ({ pubkey: accounts[camel(a.name)], isSigner: Boolean(a.signer), isWritable: Boolean(a.writable) }));
  const data = Buffer.alloc(8 + 8 + 4 + 8 + 4 + 32 * o.proof.length);
  Buffer.from(ix.discriminator).copy(data, 0);
  data.writeBigUInt64LE(BigInt(o.epochIndex), 8);
  data.writeUInt32LE(o.leafIndex, 16);
  data.writeBigUInt64LE(o.amount, 20);
  data.writeUInt32LE(o.proof.length, 28);
  o.proof.forEach((p, i) => Buffer.from(p).copy(data, 32 + 32 * i));
  return new TransactionInstruction({ programId: client.programId, keys, data });
}

// A legacy transaction with exactly one signer (the claimant pays the fee), as a
// wallet would send it; returns the signed transaction without sending.
export async function claimantTransaction(ixs: TransactionInstruction[], claimant: Keypair): Promise<Transaction> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = claimant.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(claimant);
  return tx;
}

export async function sendSigned(tx: Transaction): Promise<string> {
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  const bh = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  return sig;
}

export function errorText(err: any): string {
  const parts: string[] = [];
  if (err?.message) parts.push(String(err.message));
  if (err?.error?.errorCode?.code) parts.push(`Error Code: ${err.error.errorCode.code}`);
  if (err?.error?.errorMessage) parts.push(String(err.error.errorMessage));
  const logs = err?.logs ?? err?.transactionLogs ?? err?.error?.logs;
  if (Array.isArray(logs)) parts.push(...logs.map(String));
  return parts.join("\n");
}

// Asserts that the promise rejects and that the failure names one of `codes`
// (custom error names, Anchor constraint names, or regexes over the logs).
export async function expectError(p: Promise<unknown> | (() => Promise<unknown>), ...codes: Array<string | RegExp>): Promise<any> {
  let err: any;
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    err = e;
  }
  if (!err) expect.fail(`expected a failure with ${codes.map(String).join(" | ")}, but the transaction succeeded`);
  if (codes.length === 0) return err;
  const text = errorText(err);
  const hit = codes.some((c) => (typeof c === "string" ? text.includes(`Error Code: ${c}`) || text.includes(c) : c.test(text)));
  if (!hit) expect.fail(`expected one of [${codes.map(String).join(", ")}], got:\n${text.slice(0, 2000)}`);
  return err;
}

// Anchor error code name of a thrown error, or undefined.
export function errorCode(err: any): string | undefined {
  return err?.error?.errorCode?.code;
}

// ---------------------------------------------------------------------------
// accounting invariants (spec section 5: "hold after every test")

export async function assertInvariants(city: City): Promise<void> {
  const cfg = await fetchConfig(city);
  const vault = await vaultBalance(city);
  expect(cfg.totalFunded, `${city.name}: total_funded == total_to_founder + total_to_holders`).to.equal(cfg.totalToFounder + cfg.totalToHolders);
  expect(cfg.totalClaimed <= cfg.totalToHolders, `${city.name}: total_claimed <= total_to_holders`).to.equal(true);
  expect(vault, `${city.name}: vault == total_to_holders - total_claimed (no other outflow exists)`).to.equal(cfg.totalToHolders - cfg.totalClaimed);
  let claimed = 0n;
  let openUnclaimed = 0n;
  let deposits = 0n;
  let founderParts = 0n;
  for (let i = 0n; i < cfg.epochCount; i++) {
    const e = await fetchEpoch(city, i);
    expect(e.index).to.equal(i);
    expect(e.claimedAmount <= e.holdersAmount, `${city.name} epoch ${i}: claimed <= holders`).to.equal(true);
    claimed += e.claimedAmount;
    if (e.state === "open") openUnclaimed += e.holdersAmount - e.claimedAmount;
    if (e.depositAmount !== undefined) deposits += e.depositAmount;
    if (e.founderAmount !== undefined) founderParts += e.founderAmount;
    if (cfg.rewardModel === "creator") {
      expect(e.holdersAmount).to.equal(0n);
      expect(e.numLeaves).to.equal(0);
      expect(Buffer.from(e.merkleRoot).equals(Buffer.alloc(32))).to.equal(true);
    }
  }
  expect(claimed, `${city.name}: sum(epoch.claimed) == total_claimed`).to.equal(cfg.totalClaimed);
  expect(openUnclaimed + cfg.carryOver, `${city.name}: vault == open unclaimed + carry_over`).to.equal(vault);
  if (cfg.epochCount > 0n) {
    expect(deposits, `${city.name}: sum(epoch.deposit) == total_funded`).to.equal(cfg.totalFunded);
    expect(founderParts, `${city.name}: sum(epoch.founder_amount) == total_to_founder`).to.equal(cfg.totalToFounder);
  }
  // the vault is always the PDA token account owned by the config, for the reward mint
  const vaultAcc = await getAccount(connection, city.vault, "confirmed", city.tokenProgram);
  expect(vaultAcc.owner.equals(city.config)).to.equal(true);
  expect(vaultAcc.mint.equals(cfg.rewardMint)).to.equal(true);
  expect(cfg.vault.equals(city.vault)).to.equal(true);
}

export async function assertAllInvariants(): Promise<void> {
  for (const c of registry) await assertInvariants(c);
}

// Economics that must never change after init (and especially after lock).
export function economicsOf(cfg: CityConfigView) {
  return {
    rewardModel: cfg.rewardModel,
    founderBps: cfg.founderBps,
    cityCoinMint: cfg.cityCoinMint.toBase58(),
    rewardMint: cfg.rewardMint.toBase58(),
    vault: cfg.vault.toBase58(),
  };
}

export function expectEvent(events: Array<{ name: string; data: any }>, name: string) {
  const ev = events.find((e) => e.name === name || e.name === name.charAt(0).toLowerCase() + name.slice(1));
  expect(ev, `event ${name} in ${events.map((e) => e.name).join(",") || "(none)"}`).to.not.equal(undefined);
  return ev!.data;
}

export const big = (v: BN | bigint | number | string): bigint => (typeof v === "bigint" ? v : BigInt(v.toString()));
export const bytesOf = (v: number[] | Uint8Array | Buffer) => Buffer.from(v as any);

export { expect };
