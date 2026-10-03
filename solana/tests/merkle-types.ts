// Typed facade over sdk/merkle.mjs for the TypeScript tests (the .mjs is plain
// JavaScript; this gives the tests a Tree type and typed signatures).
import * as m from "../sdk/merkle.mjs";

export interface Leaf {
  index: number;
  claimant: Uint8Array;
  amount: bigint;
}

export interface Tree {
  root: Uint8Array;
  layers: Uint8Array[][];
  leafHashes: Uint8Array[];
  leaves: Leaf[];
  depth: number;
  numLeaves: number;
  total: bigint;
}

export type Claimant = Uint8Array | string | number[] | { toBytes(): Uint8Array };
export type Amount = bigint | number | string;

export const buildTree = m.buildTree as (leaves: Array<{ claimant: Claimant; amount: Amount; index?: number }>) => Tree;
export const getProof = m.getProof as (tree: Tree, index: number) => Uint8Array[];
export const verifyProof = m.verifyProof as (root: Uint8Array, leaf: Uint8Array, proof: Uint8Array[]) => boolean;
export const claimArgs = m.claimArgs as (tree: Tree, index: number) => { index: number; claimant: Uint8Array; amount: bigint; proof: Uint8Array[] };
export const hashLeaf = m.hashLeaf as (index: number, claimant: Claimant, amount: Amount) => Uint8Array;
export const hashNode = m.hashNode as (a: Uint8Array, b: Uint8Array) => Uint8Array;
export const encodeLeaf = m.encodeLeaf as (index: number, claimant: Claimant, amount: Amount) => Uint8Array;
export const sha256 = m.sha256 as (...parts: Uint8Array[]) => Uint8Array;
export const toHex = m.toHex as (b: Uint8Array) => string;
export const allocateProRata = m.allocateProRata as (
  balances: Array<{ claimant: Claimant; balance: bigint }>,
  total: bigint
) => { leaves: Array<{ claimant: Uint8Array; amount: bigint }>; dust: bigint; allocated: bigint };
export const ZERO_ROOT: Uint8Array = m.ZERO_ROOT;
export const MAX_PROOF_LEN: number = m.MAX_PROOF_LEN;
