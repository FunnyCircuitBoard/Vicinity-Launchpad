//! Merkle leaf and node hashing, and proof verification.
//!
//! These functions are the contract between the off-chain snapshot builder
//! (`sdk/merkle.mjs`) and the chain. Both sides must produce identical hashes;
//! `sdk/fixtures/merkle.json` pins the exact behaviour and is checked by a unit
//! test here and by the SDK's tests.
//!
//! Leaf  = sha256(0x00 || index: u32 LE || claimant: 32 bytes || amount: u64 LE)
//! Node  = sha256(0x01 || min(left, right) || max(left, right))
//! Tree  = standard binary tree; when a level has an odd number of nodes the
//!         last node is promoted unchanged to the next level (no duplication).
//!
//! Why these choices:
//! - The 0x00 / 0x01 prefixes separate leaves from inner nodes, so an inner
//!   node can never be presented as a leaf (second preimage attack).
//! - Sorting each pair means a proof is just a list of sibling hashes without
//!   direction bits; the verifier cannot be confused by a flipped bit.
//! - The leaf includes the index, so the same (wallet, amount) can never be
//!   encoded twice as two different leaves without the builder noticing; the
//!   off-chain builder additionally rejects duplicate wallets.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

/// Domain separation byte for leaves.
pub const LEAF_PREFIX: u8 = 0x00;
/// Domain separation byte for inner nodes.
pub const NODE_PREFIX: u8 = 0x01;

/// Hash of one snapshot entry.
pub fn leaf_hash(index: u32, claimant: &Pubkey, amount: u64) -> [u8; 32] {
    hashv(&[
        &[LEAF_PREFIX],
        &index.to_le_bytes(),
        claimant.as_ref(),
        &amount.to_le_bytes(),
    ])
    .to_bytes()
}

/// Hash of two children in canonical (sorted) order.
pub fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[&[NODE_PREFIX], lo, hi]).to_bytes()
}

/// Folds `leaf` up through `proof` and compares with `root`.
/// An empty proof is valid only for a tree with a single leaf (root == leaf).
/// Callers enforce the length cap (`MAX_PROOF_LEN`) before calling.
pub fn verify(proof: &[[u8; 32]], root: &[u8; 32], leaf: &[u8; 32]) -> bool {
    let mut node = *leaf;
    for sibling in proof {
        node = node_hash(&node, sibling);
    }
    node == *root
}

/// Reference tree builder. Test-only: the program never builds trees, it only
/// verifies proofs. The SDK's builder must behave exactly like this one.
#[cfg(test)]
pub mod reference {
    use super::node_hash;

    /// Returns every level, leaves first, root last.
    pub fn build_levels(leaves: &[[u8; 32]]) -> Vec<Vec<[u8; 32]>> {
        assert!(!leaves.is_empty(), "a tree needs at least one leaf");
        let mut levels = vec![leaves.to_vec()];
        while levels.last().unwrap().len() > 1 {
            let cur = levels.last().unwrap();
            let mut next = Vec::with_capacity(cur.len().div_ceil(2));
            for pair in cur.chunks(2) {
                match pair {
                    [a, b] => next.push(node_hash(a, b)),
                    [a] => next.push(*a),
                    _ => unreachable!(),
                }
            }
            levels.push(next);
        }
        levels
    }

    pub fn root(levels: &[Vec<[u8; 32]>]) -> [u8; 32] {
        levels.last().unwrap()[0]
    }

    pub fn proof(levels: &[Vec<[u8; 32]>], index: usize) -> Vec<[u8; 32]> {
        let mut out = Vec::new();
        let mut idx = index;
        for level in &levels[..levels.len() - 1] {
            let sibling = idx ^ 1;
            if sibling < level.len() {
                out.push(level[sibling]);
            }
            idx >>= 1;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::reference::{build_levels, proof, root};
    use super::*;
    use std::str::FromStr;

    /// Distinct wallet per leaf index (index + 1 in the first 8 bytes).
    fn key(n: usize) -> Pubkey {
        let mut bytes = [0u8; 32];
        bytes[..8].copy_from_slice(&(n as u64 + 1).to_le_bytes());
        Pubkey::new_from_array(bytes)
    }

    /// A wallet that is in no tree built by `leaves`.
    fn stranger() -> Pubkey {
        Pubkey::new_from_array([0xff; 32])
    }

    fn leaves(n: usize) -> Vec<[u8; 32]> {
        (0..n)
            .map(|i| leaf_hash(i as u32, &key(i), (i as u64 + 1) * 1_000))
            .collect()
    }

    #[test]
    fn leaf_hash_is_deterministic_and_sensitive_to_every_field() {
        let a = leaf_hash(0, &key(1), 100);
        assert_eq!(a, leaf_hash(0, &key(1), 100));
        assert_ne!(a, leaf_hash(1, &key(1), 100));
        assert_ne!(a, leaf_hash(0, &key(2), 100));
        assert_ne!(a, leaf_hash(0, &key(1), 101));
    }

    #[test]
    fn leaf_hash_matches_a_hand_computed_preimage() {
        // Same bytes, hashed directly: proves the exact encoding (prefix, LE).
        let claimant = key(9);
        let mut preimage = Vec::new();
        preimage.push(0u8);
        preimage.extend_from_slice(&7u32.to_le_bytes());
        preimage.extend_from_slice(claimant.as_ref());
        preimage.extend_from_slice(&123_456_789u64.to_le_bytes());
        assert_eq!(
            leaf_hash(7, &claimant, 123_456_789),
            anchor_lang::solana_program::hash::hash(&preimage).to_bytes()
        );
    }

    #[test]
    fn node_hash_is_order_independent_and_domain_separated() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        assert_eq!(node_hash(&a, &b), node_hash(&b, &a));
        let mut preimage = vec![1u8];
        preimage.extend_from_slice(&a);
        preimage.extend_from_slice(&b);
        assert_eq!(
            node_hash(&a, &b),
            anchor_lang::solana_program::hash::hash(&preimage).to_bytes()
        );
        // A leaf over the same 64 bytes would use prefix 0x00, so it differs.
        preimage[0] = 0;
        assert_ne!(
            node_hash(&a, &b),
            anchor_lang::solana_program::hash::hash(&preimage).to_bytes()
        );
    }

    #[test]
    fn single_leaf_tree_root_is_the_leaf() {
        let l = leaves(1);
        let levels = build_levels(&l);
        assert_eq!(root(&levels), l[0]);
        assert!(proof(&levels, 0).is_empty());
        assert!(verify(&[], &l[0], &l[0]));
        assert!(!verify(&[], &l[0], &[0u8; 32]));
    }

    #[test]
    fn every_leaf_of_every_small_tree_verifies_and_nothing_else_does() {
        for n in 1..=70usize {
            let l = leaves(n);
            let levels = build_levels(&l);
            let r = root(&levels);
            for (i, leaf) in l.iter().enumerate() {
                let p = proof(&levels, i);
                assert!(p.len() <= 7, "depth for {n} leaves");
                assert!(verify(&p, &r, leaf), "n={n} i={i}");
                // wrong amount
                let bad = leaf_hash(i as u32, &key(i), 1);
                assert!(!verify(&p, &r, &bad));
                // wrong index
                let bad = leaf_hash(i as u32 + 1, &key(i), (i as u64 + 1) * 1_000);
                assert!(!verify(&p, &r, &bad));
                // another wallet
                let bad = leaf_hash(i as u32, &stranger(), (i as u64 + 1) * 1_000);
                assert!(!verify(&p, &r, &bad));
                // truncated and extended proofs
                if !p.is_empty() {
                    assert!(!verify(&p[..p.len() - 1], &r, leaf));
                    assert!(!verify(&p[1..], &r, leaf));
                }
                let mut longer = p.clone();
                longer.push([7u8; 32]);
                assert!(!verify(&longer, &r, leaf));
                // proof of a neighbour
                if n > 1 {
                    let other = (i + 1) % n;
                    let p2 = proof(&levels, other);
                    assert!(!verify(&p2, &r, leaf));
                }
            }
        }
    }

    #[test]
    fn depth_twenty_tree_sample() {
        // 2^20 leaves is too slow to build fully in a unit test; build 2^11 and
        // check the depth formula, which is what the CU budget depends on.
        let l = leaves(2_048);
        let levels = build_levels(&l);
        assert_eq!(levels.len(), 12);
        assert_eq!(proof(&levels, 2_047).len(), 11);
        assert!(verify(&proof(&levels, 1_234), &root(&levels), &l[1_234]));
    }

    // ---- fixtures shared with the SDK ------------------------------------

    #[derive(serde::Deserialize)]
    struct FixtureFile {
        trees: Vec<FixtureTree>,
        leaf_vectors: Vec<LeafVector>,
    }

    #[derive(serde::Deserialize)]
    struct FixtureTree {
        #[serde(default)]
        name: String,
        leaves: Vec<FixtureLeaf>,
        root: String,
        proofs: std::collections::BTreeMap<String, Vec<String>>,
    }

    #[derive(serde::Deserialize)]
    struct FixtureLeaf {
        index: u32,
        claimant: String,
        amount: String,
    }

    #[derive(serde::Deserialize)]
    struct LeafVector {
        index: u32,
        claimant: String,
        amount: String,
        leaf: String,
    }

    fn hex32(s: &str) -> [u8; 32] {
        assert_eq!(s.len(), 64, "hex32 length: {s}");
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
        }
        out
    }

    fn load_fixtures() -> FixtureFile {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../sdk/fixtures/merkle.json"
        );
        let text = std::fs::read_to_string(path).expect("sdk/fixtures/merkle.json");
        serde_json::from_str(&text).expect("fixture json")
    }

    #[test]
    fn fixtures_match_the_sdk() {
        let fx = load_fixtures();
        assert!(fx.trees.len() >= 20, "at least 20 fixture trees");
        assert!(!fx.leaf_vectors.is_empty());

        for v in &fx.leaf_vectors {
            let claimant = Pubkey::from_str(&v.claimant).unwrap();
            let amount: u64 = v.amount.parse().unwrap();
            assert_eq!(
                leaf_hash(v.index, &claimant, amount),
                hex32(&v.leaf),
                "leaf vector {}",
                v.index
            );
        }

        for tree in &fx.trees {
            let leaves: Vec<[u8; 32]> = tree
                .leaves
                .iter()
                .enumerate()
                .map(|(i, l)| {
                    assert_eq!(
                        l.index as usize, i,
                        "{}: leaves are listed in index order",
                        tree.name
                    );
                    let claimant = Pubkey::from_str(&l.claimant).unwrap();
                    let amount: u64 = l.amount.parse().unwrap();
                    leaf_hash(l.index, &claimant, amount)
                })
                .collect();
            let levels = build_levels(&leaves);
            let r = root(&levels);
            assert_eq!(r, hex32(&tree.root), "{}: root", tree.name);
            assert!(!tree.proofs.is_empty(), "{}: has proofs", tree.name);
            for (index, proof_hex) in &tree.proofs {
                let index: usize = index.parse().unwrap();
                let fixture_proof: Vec<[u8; 32]> = proof_hex.iter().map(|h| hex32(h)).collect();
                assert_eq!(
                    proof(&levels, index),
                    fixture_proof,
                    "{}: proof {}",
                    tree.name,
                    index
                );
                assert!(
                    verify(&fixture_proof, &r, &leaves[index]),
                    "{}: verify {}",
                    tree.name,
                    index
                );
                // The same proof must not work for a neighbouring leaf.
                if leaves.len() > 1 {
                    let other = (index + 1) % leaves.len();
                    assert!(!verify(&fixture_proof, &r, &leaves[other]));
                }
            }
        }
    }
}
