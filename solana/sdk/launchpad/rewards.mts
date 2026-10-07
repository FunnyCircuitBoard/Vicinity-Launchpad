// Rewards to holders (LAUNCHPAD-DESIGN.md section 12).
//
// Two ways money reaches a city's holders:
//
// 1. CLAIMS (the main path). The holders' 0.25% collects in the coin's
//    holders pot, `forward_holders_fees` (anyone) moves it to the city's
//    vicinity_rewards vault, and the city's rewards authority books a round
//    with `fund_epoch_from_vault` from a published snapshot
//    (snapshot.mjs prepareRound). Each holder then claims their own amount.
//    `buildFundRound` and `buildClaim` here build those instructions.
//
// 2. "SEND TO ALL HOLDERS" (push, promotional, from the admin's own wallet).
//    `buildAirdropBatches` turns a holder list (the same snapshot rules) into
//    UNSIGNED transactions the admin wallet signs, e.g. on a signing page with
//    Phantom's signAllTransactions: each batch creates any missing token
//    account and transfers exact amounts, packed under 1,232 bytes. The
//    rewards vault itself can never push (a claim needs the holder's
//    signature), so a push always comes out of the sender's own account.
//    The standard `solana-tokens distribute-spl-tokens` CLI does the same from
//    a keypair file, with a database against double sends (design 12.2).
import anchor from '@coral-xyz/anchor';
import web3 from '@solana/web3.js';
import type { VersionedTransaction as VersionedTransactionT } from '@solana/web3.js';
import { buildIx, IDL, Role } from './idl.mjs';
import { ADDRESSES, PROGRAM_IDS, ata, rewardsPdas } from './pda.mjs';
import * as C from './client.mjs';
import { claimArgs } from '../merkle.mjs';
import { createAta, systemTransfer, toV0Transaction, txBytes, unwrapSol, MAX_TX_BYTES, MEASURE_BLOCKHASH } from './trade.mts';
import type { Ix } from './trade.mts';
import type { Address, CoinAccount, RewardsCityConfig } from './accounts.mts';

const { BN } = anchor;
const { PublicKey } = web3;
const bn = (x: bigint | number) => new BN(x.toString());

// ---------------------------------------------------------------- push airdrop
export interface AirdropRecipient { owner: Address; amount: bigint }
export interface AirdropBatch { index: number; recipients: AirdropRecipient[]; total: bigint; instructions: Ix[]; cuLimit: number; bytes: number }
export interface AirdropPlan {
  kind: 'vicinity-holder-airdrop';
  mint: Address | 'SOL';
  decimals: number;
  sender: Address;
  payer: Address;
  batches: AirdropBatch[];
  total: bigint;
  recipients: number;
  /** the most rent the payer can spend creating token accounts (if every recipient lacks one) */
  maxAccountRentLamports: bigint;
}
/** Rent of a 165-byte token account at today's rate (5,080 lamports per byte incl. the 128-byte overhead). */
export const TOKEN_ACCOUNT_RENT = 1_488_440n;
/** A native SOL push must leave a new recipient rent-exempt; this is safe under both the old and the new rent rates. */
export const MIN_NATIVE_PUSH = 890_880n;
const CU_PER_RECIPIENT = 30_000;

/** SPL Token `TransferChecked` (tag 12): amount and decimals are checked by the token program. */
export function transferChecked({ source, mint, destination, owner, amount, decimals, tokenProgram = PROGRAM_IDS.token }: { source: Address; mint: Address; destination: Address; owner: Address; amount: bigint; decimals: number; tokenProgram?: Address }): Ix {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return { programAddress: tokenProgram, accounts: [{ address: source, role: Role.W }, { address: mint, role: Role.R }, { address: destination, role: Role.W }, { address: owner, role: Role.RS }], data: new Uint8Array(data) };
}

function checkRecipients(recipients: AirdropRecipient[], sender: Address, native: boolean): void {
  const seen = new Set<string>();
  for (const r of recipients) {
    let owner: string;
    try { owner = new PublicKey(r.owner).toBase58(); } catch { throw new Error(`not an address: ${r.owner}`); }
    if (seen.has(owner)) throw new Error(`recipient listed twice: ${owner}`);
    seen.add(owner);
    if (owner === sender) throw new Error('the sender cannot be a recipient');
    if (typeof r.amount !== 'bigint' || r.amount <= 0n) throw new Error(`amount for ${owner} must be a positive bigint`);
    if (native && r.amount < MIN_NATIVE_PUSH) throw new Error(`${owner}: a SOL push below ${MIN_NATIVE_PUSH} lamports can fail for a new account (rent)`);
  }
}

/**
 * Plan a push of `mint` (or native SOL with `mint: 'SOL'`) from `sender` to
 * every recipient, in as few transactions as fit `maxBytes`. Each recipient
 * appears in exactly one batch, in the given order. Token accounts are created
 * idempotently (the payer pays their rent when missing). Nothing is signed.
 */
export function buildAirdropBatches({ sender, payer = sender, mint, decimals, recipients, tokenProgram = PROGRAM_IDS.token, maxBytes = MAX_TX_BYTES, maxPerBatch = 24 }: {
  sender: Address; payer?: Address; mint: Address | 'SOL'; decimals: number; recipients: AirdropRecipient[];
  tokenProgram?: Address; maxBytes?: number; maxPerBatch?: number;
}): AirdropPlan {
  const native = mint === 'SOL';
  checkRecipients(recipients, sender, native);
  const source = native ? sender : ata(sender, mint, tokenProgram);
  const ixsFor = (r: AirdropRecipient): Ix[] => (native
    ? [systemTransfer(sender, r.owner, r.amount)]
    : [createAta(payer, r.owner, mint, tokenProgram),
      transferChecked({ source, mint, destination: ata(r.owner, mint, tokenProgram), owner: sender, amount: r.amount, decimals, tokenProgram })]);
  const batches: AirdropBatch[] = [];
  let cur: AirdropRecipient[] = [];
  const size = (rs: AirdropRecipient[]) => {
    try { return txBytes(toV0Transaction({ payer, instructions: rs.flatMap(ixsFor), cuLimit: rs.length * CU_PER_RECIPIENT + 10_000 })); } catch { return Infinity; }
  };
  const close = () => {
    if (cur.length === 0) return;
    const instructions = cur.flatMap(ixsFor);
    const cuLimit = Math.min(1_400_000, cur.length * CU_PER_RECIPIENT + 10_000);
    batches.push({ index: batches.length, recipients: cur, total: cur.reduce((s, r) => s + r.amount, 0n), instructions, cuLimit, bytes: size(cur) });
    cur = [];
  };
  for (const r of recipients) {
    const next = [...cur, r];
    if (cur.length > 0 && (next.length > maxPerBatch || size(next) > maxBytes)) close();
    cur.push(r);
    if (size(cur) > maxBytes) throw new Error(`one transfer to ${r.owner} alone does not fit ${maxBytes} bytes`);
  }
  close();
  const total = recipients.reduce((s, r) => s + r.amount, 0n);
  return {
    kind: 'vicinity-holder-airdrop', mint, decimals, sender, payer, batches, total, recipients: recipients.length,
    maxAccountRentLamports: native ? 0n : TOKEN_ACCOUNT_RENT * BigInt(recipients.length),
  };
}

/** The plan's batches as unsigned v0 transactions with one blockhash (sign within about a minute). */
export function airdropTransactions(plan: AirdropPlan, blockhash: string = MEASURE_BLOCKHASH): VersionedTransactionT[] {
  return plan.batches.map((b) => toV0Transaction({ payer: plan.payer, instructions: b.instructions, blockhash, cuLimit: b.cuLimit }));
}
/**
 * A JSON plan a signing page (or a person) can read: every batch with its
 * recipients, total and unsigned transaction (base64). Amounts are strings.
 */
export function airdropPlanJson(plan: AirdropPlan, blockhash?: string): string {
  const txs = airdropTransactions(plan, blockhash);
  return `${JSON.stringify({
    kind: plan.kind, mint: plan.mint, decimals: plan.decimals, sender: plan.sender, payer: plan.payer,
    total: plan.total.toString(), recipients: plan.recipients, maxAccountRentLamports: plan.maxAccountRentLamports.toString(),
    blockhash: blockhash ?? null,
    batches: plan.batches.map((b, i) => ({
      index: b.index, total: b.total.toString(), bytes: b.bytes, cuLimit: b.cuLimit,
      recipients: b.recipients.map((r) => ({ owner: r.owner, amount: r.amount.toString() })),
      unsignedTransaction: Buffer.from(txs[i].serialize()).toString('base64'),
    })),
  }, null, 2)}\n`;
}
/** Recipients from a snapshot round (snapshot.mjs planRound leaves). */
export function recipientsFromLeaves(leaves: { claimant: unknown; amount: bigint }[]): AirdropRecipient[] {
  return leaves.map((l) => ({ owner: String(l.claimant), amount: BigInt(l.amount) }));
}

// ---------------------------------------------------------------- claims: forward, fund, claim
/** Permissionless: move the coin's holders pot to the city's checked rewards vault. */
export function buildForwardHoldersFees(coin: Pick<CoinAccount, 'cityId' | 'mint' | 'quoteMint'>, rewardsProgram: Address = PROGRAM_IDS.rewards): Ix {
  return C.forwardHoldersFees({ coin, rewardsProgram }) as Ix;
}

export interface RoundToFund {
  /** Merkle root of the round (snapshot.mjs roundFile(...).tree.root) */
  root: Uint8Array;
  numLeaves: number;
  /** slot the snapshot was read at */
  slot: bigint;
  /** SHA-256 of the published round file */
  snapshotHash: Uint8Array;
}
/** Default claim window: 30 days (vicinity_rewards requires at least 14 in production). */
export const DEFAULT_CLAIM_WINDOW_SECS = 30n * 86_400n;

/**
 * Book a round: `fund_epoch_from_vault` signed by the city's rewards
 * authority (a Squads multisig on mainnet), preceded by the permissionless
 * forward so the pot's latest money is included. The epoch index is the
 * config's current `epoch_count`. The config must be Holders-only (0% founder),
 * which `forward_holders_fees` already enforces; this builder refuses others too.
 */
export function buildFundRound({ authority, payer = authority, coin, rewardsConfig, round, claimWindowSecs = DEFAULT_CLAIM_WINDOW_SECS, forwardFirst = true, rewardsProgram = PROGRAM_IDS.rewards }: {
  authority: Address; payer?: Address; coin: Pick<CoinAccount, 'cityId' | 'mint' | 'quoteMint'>; rewardsConfig: RewardsCityConfig;
  round: RoundToFund; claimWindowSecs?: bigint; forwardFirst?: boolean; rewardsProgram?: Address;
}): Ix[] {
  if (rewardsConfig.rewardModel !== 'Holders' || rewardsConfig.founderBps !== 0) throw new Error('the city rewards config is not Holders-only with a 0% founder share');
  if (rewardsConfig.cityCoinMint !== coin.mint || rewardsConfig.rewardMint !== coin.quoteMint) throw new Error('rewards config belongs to another coin or reward token');
  if (rewardsConfig.authority !== authority) throw new Error(`the rewards authority is ${rewardsConfig.authority}, not ${authority}`);
  if (round.root.length !== 32 || round.snapshotHash.length !== 32) throw new Error('root and snapshot hash must be 32 bytes');
  if (round.numLeaves < 1) throw new Error('a round needs at least one leaf');
  const R = rewardsPdas(rewardsProgram);
  const config = R.city(coin.mint);
  const fund = buildIx(IDL.rewards, 'fund_epoch_from_vault', {
    merkle_root: Array.from(round.root), num_leaves: round.numLeaves, snapshot_slot: bn(round.slot),
    snapshot_hash: Array.from(round.snapshotHash), claim_window_secs: bn(claimWindowSecs),
  }, {
    authority, payer, config, reward_mint: coin.quoteMint, vault: R.vault(config), founder: rewardsConfig.founder,
    founder_token_account: ata(rewardsConfig.founder, coin.quoteMint), epoch: R.epoch(config, rewardsConfig.epochCount),
    token_program: PROGRAM_IDS.token,
  }) as Ix;
  return forwardFirst ? [buildForwardHoldersFees(coin, rewardsProgram), fund] : [fund];
}

/**
 * A holder's claim of leaf `leafIndex` in round `epochIndex` (the tree comes
 * from the published round file). With `unwrap`, a WSOL reward arrives as SOL.
 */
export function buildClaim({ claimant, coin, epochIndex, tree, leafIndex, unwrap = true, rewardsProgram = PROGRAM_IDS.rewards }: {
  claimant: Address; coin: Pick<CoinAccount, 'mint' | 'quoteMint'>; epochIndex: bigint; tree: unknown; leafIndex: number; unwrap?: boolean; rewardsProgram?: Address;
}): Ix[] {
  const args = claimArgs(tree, leafIndex) as { claimant: Uint8Array; amount: bigint; proof: Uint8Array[] };
  if (new PublicKey(args.claimant).toBase58() !== claimant) throw new Error(`leaf ${leafIndex} belongs to ${new PublicKey(args.claimant).toBase58()}`);
  const R = rewardsPdas(rewardsProgram);
  const config = R.city(coin.mint);
  const epoch = R.epoch(config, epochIndex);
  const ix = buildIx(IDL.rewards, 'claim', {
    epoch_index: bn(epochIndex), leaf_index: leafIndex, amount: bn(args.amount), proof: args.proof.map((p) => Array.from(p)),
  }, {
    claimant, config, epoch, claim_status: R.claim(epoch, claimant), reward_mint: coin.quoteMint, vault: R.vault(config),
    claimant_token_account: ata(claimant, coin.quoteMint), token_program: PROGRAM_IDS.token,
  }) as Ix;
  return unwrap && coin.quoteMint === ADDRESSES.wsol ? [ix, unwrapSol(claimant)] : [ix];
}
