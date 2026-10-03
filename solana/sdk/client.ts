// Thin, explicit wrapper around the Anchor Program for vicinity_rewards.
//
// One place that knows the account list of every instruction, so the tests,
// scripts/demo.ts and (later) the Cloudflare Worker build identical
// transactions. Every builder returns the Anchor MethodsBuilder, so a caller
// can `.signers([...]).rpc()`, `.instruction()`, `.transaction()` or
// `.simulate()`. `overrides` replaces any account by its IDL name: the
// substitution-attack tests use it to pass a wrong vault, config, mint, etc.
//
// Account names are resolved against the IDL at run time: for each role below
// the first candidate present in the instruction's account list is used, and a
// missing required account throws a message that names it. If the Rust side
// renames an account, add the new name to ROLE_NAMES; nothing else changes.

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, EventParser, Idl, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deriveClaim, deriveConfig, deriveEpoch, deriveVault, setProgramId } from "./pda.mjs";
import { ZERO_ROOT, toClaimantBytes } from "./merkle.mjs";

export type RewardModelName = "creator" | "holders" | "split";
export type EpochStateName = "open" | "cancelled" | "swept";

export const BPS_DENOMINATOR = 10_000;
export const CREATOR_BPS = 10_000;
export const HOLDERS_BPS = 0;
export const ALLOWED_SPLIT_BPS = [2_500, 5_000, 7_500];
export const DAY = 86_400;
export const DEFAULT_MIN_CLAIM_WINDOW = 14 * DAY;
export const DEFAULT_MAX_CLAIM_WINDOW = 365 * DAY;

export const IDL_CANDIDATES = ["sdk/idl/vicinity_rewards.json", "target/idl/vicinity_rewards.json"];

// Role -> candidate IDL account names (camelCase, as the Anchor TS client exposes them).
const ROLE_NAMES: Record<string, string[]> = {
  config: ["config", "cityConfig"],
  vault: ["vault"],
  cityCoinMint: ["cityCoinMint", "cityMint"],
  rewardMint: ["rewardMint"],
  founder: ["founder"],
  payer: ["payer"],
  authority: ["authority"],
  newAuthority: ["newAuthority", "pendingAuthority"],
  funder: ["funder"],
  funderTokenAccount: ["funderTokenAccount", "funderAta", "sourceTokenAccount", "source"],
  founderTokenAccount: ["founderTokenAccount", "founderAta", "founderRewardAccount"],
  epoch: ["epoch"],
  claimant: ["claimant"],
  claimantTokenAccount: ["claimantTokenAccount", "claimantAta", "destinationTokenAccount", "destination"],
  claimStatus: ["claimStatus"],
  tokenProgram: ["tokenProgram"],
  associatedTokenProgram: ["associatedTokenProgram"],
  systemProgram: ["systemProgram"],
  rent: ["rent"],
};

export interface IdlAccountItem {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
  pda?: unknown;
  optional?: boolean;
  accounts?: IdlAccountItem[];
}

export function findIdlPath(root: string = workspaceRoot()): string | undefined {
  for (const rel of IDL_CANDIDATES) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function workspaceRoot(): string {
  // sdk/ -> solana/
  return dirname(__dirname);
}

export function loadIdl(path?: string): Idl {
  const p = path ?? findIdlPath();
  if (!p) {
    throw new Error(
      `IDL not found. Run 'anchor build' (writes target/idl/vicinity_rewards.json) and copy it to sdk/idl/vicinity_rewards.json. Looked at: ${IDL_CANDIDATES.join(", ")}`
    );
  }
  return JSON.parse(readFileSync(p, "utf8")) as Idl;
}

export function bn(v: bigint | number | string | BN): BN {
  if (v instanceof BN) return v;
  return new BN(typeof v === "bigint" ? v.toString() : v);
}

export function big(v: BN | bigint | number | string): bigint {
  if (typeof v === "bigint") return v;
  return BigInt(v.toString());
}

export function bytes32(v: Uint8Array | number[] | Buffer): number[] {
  const arr = Array.from(v as Iterable<number>);
  if (arr.length !== 32) throw new Error(`expected 32 bytes, got ${arr.length}`);
  return arr;
}

// ASCII, zero padded to 32 bytes (CityConfig.city_tag).
export function cityTag(text: string): number[] {
  const out = new Array<number>(32).fill(0);
  if (text.length > 32) throw new Error("city tag longer than 32 bytes");
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) throw new Error("city tag must be printable ASCII");
    out[i] = c;
  }
  return out;
}

export function cityTagToString(tag: number[] | Uint8Array): string {
  let s = "";
  for (const b of tag) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

// Anchor encodes Rust enums as { variantCamel: {} }.
export function enumArg(name: string): Record<string, Record<string, never>> {
  return { [name.charAt(0).toLowerCase() + name.slice(1)]: {} };
}

export function enumName(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const keys = Object.keys(value as object);
    if (keys.length === 1) return keys[0];
  }
  throw new Error(`not an enum value: ${JSON.stringify(value)}`);
}

export function rewardModelName(value: unknown): RewardModelName {
  const n = enumName(value);
  if (n === "0" || n === "creator") return "creator";
  if (n === "1" || n === "holders") return "holders";
  if (n === "2" || n === "split") return "split";
  throw new Error(`unknown reward model ${n}`);
}

export function epochStateName(value: unknown): EpochStateName {
  const n = enumName(value);
  if (n === "0" || n === "open") return "open";
  if (n === "1" || n === "cancelled") return "cancelled";
  if (n === "2" || n === "swept") return "swept";
  throw new Error(`unknown epoch state ${n}`);
}

export function bpsForModel(model: RewardModelName, splitBps?: number): number {
  if (model === "creator") return CREATOR_BPS;
  if (model === "holders") return HOLDERS_BPS;
  if (splitBps === undefined) throw new Error("split needs founder bps");
  return splitBps;
}

// floor(amount * bps / 10000); the remainder goes to holders (spec section 4.6).
export function splitAmount(amount: bigint, founderBps: number): { founder: bigint; holders: bigint } {
  const founder = (amount * BigInt(founderBps)) / BigInt(BPS_DENOMINATOR);
  return { founder, holders: amount - founder };
}

export interface CityAddresses {
  config: PublicKey;
  configBump: number;
  vault: PublicKey;
  vaultBump: number;
}

export interface InitCityParams {
  payer: PublicKey;
  authority: PublicKey;
  founder: PublicKey;
  cityCoinMint: PublicKey;
  rewardMint: PublicKey;
  rewardModel: RewardModelName;
  founderBps: number;
  cityTag: string | number[];
  tokenProgram?: PublicKey;
  overrides?: Record<string, PublicKey>;
}

export interface FundEpochParams {
  authority: PublicKey;
  funder: PublicKey;
  funderTokenAccount: PublicKey;
  cityCoinMint: PublicKey;
  amount: bigint | number | BN;
  merkleRoot?: Uint8Array | number[];
  numLeaves?: number;
  snapshotSlot?: bigint | number | BN;
  snapshotHash?: Uint8Array | number[];
  claimWindowSecs?: number | bigint | BN;
  // normally read from the config; pass to avoid an RPC round trip or to attack
  founder?: PublicKey;
  rewardMint?: PublicKey;
  tokenProgram?: PublicKey;
  overrides?: Record<string, PublicKey>;
}

export interface ClaimParams {
  claimant: PublicKey;
  cityCoinMint: PublicKey;
  epochIndex: bigint | number | BN;
  leafIndex: number;
  amount: bigint | number | BN;
  proof: Uint8Array[] | number[][];
  rewardMint?: PublicKey;
  tokenProgram?: PublicKey;
  overrides?: Record<string, PublicKey>;
}

export interface AuthorityParams {
  authority: PublicKey;
  cityCoinMint: PublicKey;
  overrides?: Record<string, PublicKey>;
}

export class VicinityClient {
  readonly program: Program<Idl>;
  readonly provider: AnchorProvider;
  readonly programId: PublicKey;
  readonly idl: Idl;
  readonly connection: Connection;

  constructor(provider: AnchorProvider, idl: Idl = loadIdl()) {
    this.provider = provider;
    this.idl = idl;
    this.program = new Program(idl, provider);
    this.programId = this.program.programId;
    this.connection = provider.connection;
    setProgramId(this.programId);
  }

  // ---- PDAs -------------------------------------------------------------

  city(cityCoinMint: PublicKey): CityAddresses {
    const c = deriveConfig(cityCoinMint, this.programId);
    const v = deriveVault(c.address, this.programId);
    return { config: c.address, configBump: c.bump, vault: v.address, vaultBump: v.bump };
  }

  epochAddress(config: PublicKey, index: bigint | number | BN): PublicKey {
    return deriveEpoch(config, big(index), this.programId).address;
  }

  claimAddress(epoch: PublicKey, claimant: PublicKey): PublicKey {
    return deriveClaim(epoch, claimant, this.programId).address;
  }

  ata(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
  }

  // ---- IDL helpers --------------------------------------------------------

  instruction(name: string) {
    const ix = this.idl.instructions.find((i) => i.name === name || camel(i.name) === name);
    if (!ix) throw new Error(`instruction ${name} is not in the IDL (have: ${this.idl.instructions.map((i) => i.name).join(", ")})`);
    return ix;
  }

  instructionNames(): string[] {
    return this.idl.instructions.map((i) => camel(i.name));
  }

  errorCodes(): string[] {
    return ((this.idl as unknown as { errors?: { name: string }[] }).errors ?? []).map((e) => e.name);
  }

  constant(name: string): string | undefined {
    const consts = (this.idl as unknown as { constants?: { name: string; value: string }[] }).constants ?? [];
    return consts.find((c) => c.name === name)?.value;
  }

  // Window bounds: from the IDL when the program exposes them with #[constant],
  // else the spec defaults.
  claimWindowBounds(): { min: number; max: number; fromIdl: boolean } {
    const min = this.constant("MIN_CLAIM_WINDOW_SECS") ?? this.constant("MIN_CLAIM_WINDOW");
    const max = this.constant("MAX_CLAIM_WINDOW_SECS") ?? this.constant("MAX_CLAIM_WINDOW");
    if (min !== undefined && max !== undefined) return { min: Number(min), max: Number(max), fromIdl: true };
    return { min: DEFAULT_MIN_CLAIM_WINDOW, max: DEFAULT_MAX_CLAIM_WINDOW, fromIdl: false };
  }

  // Map roles to the IDL's account names; throw for anything required and missing.
  resolveAccounts(ixName: string, roles: Record<string, PublicKey | undefined>, overrides: Record<string, PublicKey> = {}) {
    const ix = this.instruction(ixName);
    const out: Record<string, PublicKey> = {};
    const flat = (items: IdlAccountItem[]): IdlAccountItem[] =>
      items.flatMap((a) => (a.accounts ? flat(a.accounts) : [a]));
    const missing: string[] = [];
    for (const acc of flat(ix.accounts as IdlAccountItem[])) {
      const name = camel(acc.name);
      let value: PublicKey | undefined;
      for (const [role, names] of Object.entries(ROLE_NAMES)) {
        if (names.includes(name) && roles[role]) {
          value = roles[role];
          break;
        }
      }
      if (!value && roles[name]) value = roles[name];
      if (!value && KNOWN_ADDRESSES[name]) value = KNOWN_ADDRESSES[name];
      if (value) out[name] = value;
      else if (!acc.address && !acc.pda && !acc.optional) missing.push(acc.name);
    }
    if (missing.length) {
      throw new Error(`${ixName}: no value for IDL account(s) ${missing.join(", ")}. Add the name to ROLE_NAMES in sdk/client.ts.`);
    }
    for (const [k, v] of Object.entries(overrides)) out[camel(k)] = v;
    return out;
  }

  private argType(ixName: string, argName: string): unknown {
    const ix = this.instruction(ixName);
    const arg = ix.args.find((a) => camel(a.name) === camel(argName));
    return arg?.type;
  }

  private rewardModelArg(model: RewardModelName): unknown {
    const t = this.argType("init_city", "reward_model");
    if (t === "u8") return { creator: 0, holders: 1, split: 2 }[model];
    return enumArg(model);
  }

  // ---- builders -----------------------------------------------------------

  initCity(p: InitCityParams) {
    const { config, vault } = this.city(p.cityCoinMint);
    const accounts = this.resolveAccounts(
      "init_city",
      {
        payer: p.payer,
        authority: p.authority,
        founder: p.founder,
        cityCoinMint: p.cityCoinMint,
        rewardMint: p.rewardMint,
        config,
        vault,
        tokenProgram: p.tokenProgram ?? TOKEN_PROGRAM_ID,
      },
      p.overrides
    );
    const tag = typeof p.cityTag === "string" ? cityTag(p.cityTag) : p.cityTag;
    return this.program.methods.initCity(this.rewardModelArg(p.rewardModel), p.founderBps, tag).accountsPartial(accounts);
  }

  lockConfig(p: AuthorityParams) {
    const { config } = this.city(p.cityCoinMint);
    return this.program.methods.lockConfig().accountsPartial(this.resolveAccounts("lock_config", { authority: p.authority, config }, p.overrides));
  }

  setFounder(p: AuthorityParams & { newFounder: PublicKey }) {
    const { config } = this.city(p.cityCoinMint);
    return this.program.methods
      .setFounder(p.newFounder)
      .accountsPartial(this.resolveAccounts("set_founder", { authority: p.authority, config }, p.overrides));
  }

  proposeAuthority(p: AuthorityParams & { newAuthority: PublicKey }) {
    const { config } = this.city(p.cityCoinMint);
    return this.program.methods
      .proposeAuthority(p.newAuthority)
      .accountsPartial(this.resolveAccounts("propose_authority", { authority: p.authority, config }, p.overrides));
  }

  acceptAuthority(p: { newAuthority: PublicKey; cityCoinMint: PublicKey; overrides?: Record<string, PublicKey> }) {
    const { config } = this.city(p.cityCoinMint);
    return this.program.methods
      .acceptAuthority()
      .accountsPartial(this.resolveAccounts("accept_authority", { newAuthority: p.newAuthority, config }, p.overrides));
  }

  pause(p: AuthorityParams) {
    const { config } = this.city(p.cityCoinMint);
    return this.program.methods.pause().accountsPartial(this.resolveAccounts("pause", { authority: p.authority, config }, p.overrides));
  }

  unpause(p: AuthorityParams) {
    const { config } = this.city(p.cityCoinMint);
    return this.program.methods.unpause().accountsPartial(this.resolveAccounts("unpause", { authority: p.authority, config }, p.overrides));
  }

  async fundEpoch(p: FundEpochParams) {
    const { config, vault } = this.city(p.cityCoinMint);
    let founder = p.founder;
    let rewardMint = p.rewardMint;
    let epochIndex: bigint;
    if (!founder || !rewardMint || p.overrides?.epoch === undefined) {
      const cfg = await this.fetchConfig(config);
      founder = founder ?? cfg.founder;
      rewardMint = rewardMint ?? cfg.rewardMint;
      epochIndex = cfg.epochCount;
    } else {
      epochIndex = 0n;
    }
    const tokenProgram = p.tokenProgram ?? TOKEN_PROGRAM_ID;
    const epoch = p.overrides?.epoch ?? this.epochAddress(config, epochIndex);
    const accounts = this.resolveAccounts(
      "fund_epoch",
      {
        authority: p.authority,
        funder: p.funder,
        funderTokenAccount: p.funderTokenAccount,
        founder,
        founderTokenAccount: this.ata(rewardMint!, founder!, tokenProgram),
        rewardMint,
        config,
        vault,
        epoch,
        tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      },
      p.overrides
    );
    const bounds = this.claimWindowBounds();
    return this.program.methods
      .fundEpoch(
        bn(p.amount),
        bytes32(p.merkleRoot ?? ZERO_ROOT),
        p.numLeaves ?? 0,
        bn(p.snapshotSlot ?? 0),
        bytes32(p.snapshotHash ?? new Uint8Array(32)),
        bn(p.claimWindowSecs ?? bounds.min)
      )
      .accountsPartial(accounts);
  }

  async claim(p: ClaimParams) {
    const { config, vault } = this.city(p.cityCoinMint);
    const rewardMint = p.rewardMint ?? (await this.fetchConfig(config)).rewardMint;
    const tokenProgram = p.tokenProgram ?? TOKEN_PROGRAM_ID;
    const epoch = p.overrides?.epoch ?? this.epochAddress(config, p.epochIndex);
    const claimStatus = p.overrides?.claimStatus ?? this.claimAddress(epoch, p.claimant);
    const accounts = this.resolveAccounts(
      "claim",
      {
        claimant: p.claimant,
        claimantTokenAccount: this.ata(rewardMint, p.claimant, tokenProgram),
        rewardMint,
        config,
        vault,
        epoch,
        claimStatus,
        tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      },
      p.overrides
    );
    const proof = (p.proof as Array<Uint8Array | number[]>).map((x) => bytes32(x));
    return this.program.methods.claim(bn(p.epochIndex), p.leafIndex, bn(p.amount), proof).accountsPartial(accounts);
  }

  sweepEpoch(p: AuthorityParams & { epochIndex: bigint | number | BN }) {
    const { config } = this.city(p.cityCoinMint);
    const epoch = p.overrides?.epoch ?? this.epochAddress(config, p.epochIndex);
    return this.program.methods
      .sweepEpoch(bn(p.epochIndex))
      .accountsPartial(this.resolveAccounts("sweep_epoch", { authority: p.authority, config, epoch }, p.overrides));
  }

  cancelEpoch(p: AuthorityParams & { epochIndex: bigint | number | BN }) {
    const { config } = this.city(p.cityCoinMint);
    const epoch = p.overrides?.epoch ?? this.epochAddress(config, p.epochIndex);
    return this.program.methods
      .cancelEpoch(bn(p.epochIndex))
      .accountsPartial(this.resolveAccounts("cancel_epoch", { authority: p.authority, config, epoch }, p.overrides));
  }

  closeClaimStatus(p: { claimant: PublicKey; cityCoinMint: PublicKey; epochIndex: bigint | number | BN; overrides?: Record<string, PublicKey> }) {
    const { config } = this.city(p.cityCoinMint);
    const epoch = p.overrides?.epoch ?? this.epochAddress(config, p.epochIndex);
    const claimStatus = p.overrides?.claimStatus ?? this.claimAddress(epoch, p.claimant);
    return this.program.methods
      .closeClaimStatus(bn(p.epochIndex))
      .accountsPartial(this.resolveAccounts("close_claim_status", { claimant: p.claimant, config, epoch, claimStatus }, p.overrides));
  }

  // ---- readers ------------------------------------------------------------

  async fetchConfig(config: PublicKey): Promise<CityConfigView> {
    const raw = (await (this.program.account as any).cityConfig.fetch(config)) as Record<string, any>;
    return {
      address: config,
      authority: raw.authority,
      pendingAuthority: raw.pendingAuthority,
      founder: raw.founder,
      cityCoinMint: raw.cityCoinMint,
      rewardMint: raw.rewardMint,
      vault: raw.vault,
      rewardModel: rewardModelName(raw.rewardModel),
      founderBps: Number(raw.founderBps),
      locked: Boolean(raw.locked),
      paused: Boolean(raw.paused),
      epochCount: big(raw.epochCount),
      carryOver: big(raw.carryOver),
      totalFunded: big(raw.totalFunded),
      totalToFounder: big(raw.totalToFounder),
      totalToHolders: big(raw.totalToHolders),
      totalClaimed: big(raw.totalClaimed),
      cityTag: cityTagToString(raw.cityTag),
      bump: Number(raw.bump),
      vaultBump: Number(raw.vaultBump),
      raw,
    };
  }

  async fetchConfigNullable(config: PublicKey): Promise<CityConfigView | null> {
    const raw = await (this.program.account as any).cityConfig.fetchNullable(config);
    return raw ? this.fetchConfig(config) : null;
  }

  async fetchEpoch(epoch: PublicKey): Promise<EpochView> {
    const raw = (await (this.program.account as any).epoch.fetch(epoch)) as Record<string, any>;
    return {
      address: epoch,
      config: raw.config,
      index: big(raw.index),
      merkleRoot: Uint8Array.from(raw.merkleRoot),
      depositAmount: raw.depositAmount !== undefined ? big(raw.depositAmount) : undefined,
      founderAmount: raw.founderAmount !== undefined ? big(raw.founderAmount) : undefined,
      holdersAmount: big(raw.holdersAmount),
      claimedAmount: big(raw.claimedAmount),
      numLeaves: Number(raw.numLeaves),
      snapshotSlot: big(raw.snapshotSlot),
      snapshotHash: Uint8Array.from(raw.snapshotHash),
      fundedAt: Number(raw.fundedAt.toString()),
      claimDeadline: Number(raw.claimDeadline.toString()),
      state: epochStateName(raw.state),
      bump: Number(raw.bump),
      raw,
    };
  }

  async fetchEpochNullable(epoch: PublicKey): Promise<EpochView | null> {
    const raw = await (this.program.account as any).epoch.fetchNullable(epoch);
    return raw ? this.fetchEpoch(epoch) : null;
  }

  async fetchClaimStatus(addr: PublicKey): Promise<ClaimStatusView | null> {
    const raw = (await (this.program.account as any).claimStatus.fetchNullable(addr)) as Record<string, any> | null;
    if (!raw) return null;
    return { address: addr, claimant: raw.claimant, amount: big(raw.amount), claimedAt: Number(raw.claimedAt.toString()), bump: Number(raw.bump) };
  }

  async fetchEpochs(config: PublicKey): Promise<EpochView[]> {
    const cfg = await this.fetchConfig(config);
    const out: EpochView[] = [];
    for (let i = 0n; i < cfg.epochCount; i++) out.push(await this.fetchEpoch(this.epochAddress(config, i)));
    return out;
  }

  // ---- events -------------------------------------------------------------

  async eventsOf(signature: string): Promise<Array<{ name: string; data: any }>> {
    const tx = await this.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta?.logMessages) return [];
    const parser = new EventParser(this.programId, this.program.coder);
    const out: Array<{ name: string; data: any }> = [];
    for (const ev of parser.parseLogs(tx.meta.logMessages)) out.push({ name: ev.name, data: ev.data });
    return out;
  }

  // Compute units consumed by this program in a confirmed transaction (from logs).
  async computeUnitsOf(signature: string): Promise<number | undefined> {
    const tx = await this.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    return parseComputeUnits(tx?.meta?.logMessages ?? [], this.programId);
  }
}

export function parseComputeUnits(logs: string[], programId: PublicKey): number | undefined {
  const re = new RegExp(`^Program ${programId.toBase58()} consumed (\\d+) of \\d+ compute units`);
  for (const line of logs) {
    const m = re.exec(line);
    if (m) return Number(m[1]);
  }
  return undefined;
}

export interface CityConfigView {
  address: PublicKey;
  authority: PublicKey;
  pendingAuthority: PublicKey;
  founder: PublicKey;
  cityCoinMint: PublicKey;
  rewardMint: PublicKey;
  vault: PublicKey;
  rewardModel: RewardModelName;
  founderBps: number;
  locked: boolean;
  paused: boolean;
  epochCount: bigint;
  carryOver: bigint;
  totalFunded: bigint;
  totalToFounder: bigint;
  totalToHolders: bigint;
  totalClaimed: bigint;
  cityTag: string;
  bump: number;
  vaultBump: number;
  raw: Record<string, any>;
}

export interface EpochView {
  address: PublicKey;
  config?: PublicKey;
  index: bigint;
  merkleRoot: Uint8Array;
  depositAmount?: bigint;
  founderAmount?: bigint;
  holdersAmount: bigint;
  claimedAmount: bigint;
  numLeaves: number;
  snapshotSlot: bigint;
  snapshotHash: Uint8Array;
  fundedAt: number;
  claimDeadline: number;
  state: EpochStateName;
  bump: number;
  raw: Record<string, any>;
}

export interface ClaimStatusView {
  address: PublicKey;
  claimant: PublicKey;
  amount: bigint;
  claimedAt: number;
  bump: number;
}

const KNOWN_ADDRESSES: Record<string, PublicKey> = {
  tokenProgram: TOKEN_PROGRAM_ID,
  associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  systemProgram: SystemProgram.programId,
  rent: SYSVAR_RENT_PUBKEY,
};

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, toClaimantBytes, anchor };

export function camel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
