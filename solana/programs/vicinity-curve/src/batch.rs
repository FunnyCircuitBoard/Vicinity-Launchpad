//! The batch launch approval's pure parts (VICINITY-CURVE-DESIGN.md 3.11,
//! 3.12, 4.25, 4.27, 8.6): the launch leaf, the sorted-pair tree and proof
//! verification, the depth bound on a proof, the publication window, and
//! which stored batch is in force at a moment. Nothing here touches an
//! account; `publish_launch_batch` and `launch_from_batch` call these and the
//! unit and property tests below (U13, P12) pin them, with the SDK's twin
//! (`sdk/curve/batch.mjs`) checked against the same fixture
//! (`sdk/fixtures/launch-batch.json`).
//!
//! ```text
//! leaf = SHA-256( 0x00 || "vicinity_curve/launch_leaf" || 0x01 || program_id
//!               || batch_seq u64 LE || city_id u64 LE || founder || config_id u16 LE
//!               || meta_hash || name_len u8 || name || symbol_len u8 || symbol )
//! node = SHA-256( 0x01 || min(a, b) || max(a, b) )     unsigned byte-wise comparison
//! ```
//!
//! The prefixes and the sorted-pair rule are those of `vicinity_rewards`'
//! `merkle.rs` (and `sdk/merkle.mjs`); the 26-byte tag and the version byte
//! keep a rewards leaf from ever reading as a launch leaf. A leaf preimage is
//! 144 bytes plus the name and the symbol (146 to 186 bytes) and starts with
//! 0x00; a node preimage is exactly 65 bytes and starts with 0x01, so a node
//! can never be presented as a leaf or a leaf as a node (T82). The program
//! never takes a leaf hash from a caller: it builds the leaf from the call's
//! own arguments and its signer.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::constants::{
    BATCH_MAX_LEAD_SECS, BATCH_MAX_VALIDITY_SECS, BATCH_REVIEW_SECS, LAUNCH_LEAF_TAG,
    LAUNCH_LEAF_VERSION, MAX_BATCH_PROOF_LEN, MERKLE_LEAF_PREFIX, MERKLE_NODE_PREFIX,
};
use crate::errors::CurveError;
use crate::state::{BatchRecord, LaunchBatch};

/// The launch leaf of 3.12. `name` and `symbol` have passed `check_name`
/// and `check_symbol` (at most 32 and 10 bytes); a string of more than 255
/// bytes cannot be length-prefixed and is refused (`BadName`, `BadSymbol`).
#[allow(clippy::too_many_arguments)]
pub fn launch_leaf(
    program_id: &Pubkey,
    batch_seq: u64,
    city_id: u64,
    founder: &Pubkey,
    config_id: u16,
    meta_hash: &[u8; 32],
    name: &str,
    symbol: &str,
) -> Result<[u8; 32]> {
    let name_len = u8::try_from(name.len()).map_err(|_| CurveError::BadName)?;
    let symbol_len = u8::try_from(symbol.len()).map_err(|_| CurveError::BadSymbol)?;
    Ok(hashv(&[
        &[MERKLE_LEAF_PREFIX],
        &LAUNCH_LEAF_TAG,
        &[LAUNCH_LEAF_VERSION],
        program_id.as_ref(),
        &batch_seq.to_le_bytes(),
        &city_id.to_le_bytes(),
        founder.as_ref(),
        &config_id.to_le_bytes(),
        meta_hash,
        &[name_len],
        name.as_bytes(),
        &[symbol_len],
        symbol.as_bytes(),
    ])
    .to_bytes())
}

/// Hash of two children in canonical (sorted) order.
pub fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[&[MERKLE_NODE_PREFIX], lo, hi]).to_bytes()
}

/// Folds `leaf` up through `proof` and compares with `root`. An empty proof
/// is valid only for a one-leaf tree (root == leaf). The caller bounds the
/// proof's length first (`max_proof_len`).
pub fn verify_proof(proof: &[[u8; 32]], root: &[u8; 32], leaf: &[u8; 32]) -> bool {
    let mut node = *leaf;
    for sibling in proof {
        node = node_hash(&node, sibling);
    }
    node == *root
}

/// `depth(n) = ceil(log2(n))` for `n >= 1` (0 for one leaf, and for 0, which
/// no stored batch has): the most siblings any leaf of an `n`-leaf tree has.
pub fn tree_depth(leaf_count: u32) -> u32 {
    if leaf_count <= 1 {
        0
    } else {
        u32::BITS - (leaf_count - 1).leading_zeros()
    }
}

/// The longest proof a batch of `leaf_count` leaves accepts:
/// `min(MAX_BATCH_PROOF_LEN, depth(leaf_count))` (3.12, 4.27 check 8).
pub fn max_proof_len(leaf_count: u32) -> usize {
    tree_depth(leaf_count).min(MAX_BATCH_PROOF_LEN as u32) as usize
}

/// The publication window of 4.25 check 6: `now + BATCH_REVIEW_SECS <=
/// valid_from <= now + BATCH_MAX_LEAD_SECS` and `valid_from < valid_until <=
/// valid_from + BATCH_MAX_VALIDITY_SECS`. Arithmetic that would leave `i64`
/// counts as outside the window.
pub fn batch_window_ok(now: i64, valid_from: i64, valid_until: i64) -> bool {
    let (Some(earliest), Some(latest)) = (
        now.checked_add(BATCH_REVIEW_SECS),
        now.checked_add(BATCH_MAX_LEAD_SECS),
    ) else {
        return false;
    };
    let Some(last) = valid_from.checked_add(BATCH_MAX_VALIDITY_SECS) else {
        return false;
    };
    earliest <= valid_from
        && valid_from <= latest
        && valid_from < valid_until
        && valid_until <= last
}

/// The batch named by `batch_seq` if it is in force at `now` (4.27 check 3,
/// 8.6), else the first failing rule's error, in this order:
///
/// 1. `b = latest` if `batch_seq == latest.seq`, else `b = previous` if
///    `batch_seq == previous.seq` and `now < latest.valid_from` (a newer batch
///    supersedes the older one when it takes force, not when it is
///    published); `batch_seq != 0`, a `b` found and `b.publisher ==
///    launch_approver`, else `BatchSuperseded`;
/// 2. `!b.cleared` (`BatchCleared`);
/// 3. `now >= b.valid_from` (`BatchNotYetValid`);
/// 4. `now <= b.valid_until` (`BatchExpired`).
///
/// The caller has already refused a zero approver (`LaunchApproverNotSet`)
/// and a halted batch path (`BatchesHalted`).
pub fn batch_in_force<'a>(
    lb: &'a LaunchBatch,
    launch_approver: &Pubkey,
    batch_seq: u64,
    now: i64,
) -> Result<&'a BatchRecord> {
    let b = if batch_seq == lb.latest.seq {
        Some(&lb.latest)
    } else if batch_seq == lb.previous.seq && now < lb.latest.valid_from {
        Some(&lb.previous)
    } else {
        None
    };
    let b = match b {
        Some(b) if batch_seq != 0 && b.publisher == *launch_approver => b,
        _ => return err!(CurveError::BatchSuperseded),
    };
    require!(!b.cleared, CurveError::BatchCleared);
    require!(now >= b.valid_from, CurveError::BatchNotYetValid);
    require!(now <= b.valid_until, CurveError::BatchExpired);
    Ok(b)
}

/// The record that is in force at `now`, if any (8.6): `latest` when it
/// passes every rule of `batch_in_force`, else `previous` when it does. Used
/// by the tests and mirrored by the SDK's `batchInForce`.
pub fn in_force_now(lb: &LaunchBatch, launch_approver: &Pubkey, now: i64) -> Option<u64> {
    if lb.halted || *launch_approver == Pubkey::default() {
        return None;
    }
    [lb.latest.seq, lb.previous.seq]
        .into_iter()
        .find(|&seq| batch_in_force(lb, launch_approver, seq, now).is_ok())
}

/// The effects of `publish_launch_batch` (4.25) on `lb`, after its checks:
/// if the latest batch has begun (`now >= latest.valid_from`, whether it is
/// in force, cleared or past its end) it moves to `previous`; otherwise it is
/// still in its review window (or there is none) and is replaced, never
/// taking force, while `previous` stays. Returns `(previous_seq,
/// replaced_seq)` for the event (`replaced_seq` 0 for none).
pub fn apply_publication(lb: &mut LaunchBatch, record: BatchRecord, now: i64) -> (u64, u64) {
    let mut replaced = 0;
    if lb.latest.seq != 0 && now >= lb.latest.valid_from {
        lb.previous = lb.latest;
    } else if lb.latest.seq != 0 {
        replaced = lb.latest.seq;
    }
    lb.latest = record;
    (lb.previous.seq, replaced)
}

/// Reference tree builder (test-only: the program never builds trees, it only
/// verifies proofs). Leaves in the given order (the SDK sorts entries by
/// `city_id`); each level hashed in pairs from the left; an odd last node is
/// promoted unchanged; the root is the single node at the top.
#[cfg(test)]
pub mod reference {
    use super::node_hash;

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

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
    fn unhex(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, o) in out.iter_mut().enumerate() {
            *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
        }
        out
    }
    fn sha(b: &[u8]) -> [u8; 32] {
        anchor_lang::solana_program::hash::hash(b).to_bytes()
    }

    /// The leaf preimage written out by hand, byte for byte (3.12).
    #[allow(clippy::too_many_arguments)]
    fn preimage(
        program: &Pubkey,
        seq: u64,
        city: u64,
        founder: &Pubkey,
        config: u16,
        meta: &[u8; 32],
        name: &str,
        symbol: &str,
    ) -> Vec<u8> {
        let mut v = vec![0x00];
        v.extend_from_slice(b"vicinity_curve/launch_leaf");
        v.push(0x01);
        v.extend_from_slice(program.as_ref());
        v.extend_from_slice(&seq.to_le_bytes());
        v.extend_from_slice(&city.to_le_bytes());
        v.extend_from_slice(founder.as_ref());
        v.extend_from_slice(&config.to_le_bytes());
        v.extend_from_slice(meta);
        v.push(name.len() as u8);
        v.extend_from_slice(name.as_bytes());
        v.push(symbol.len() as u8);
        v.extend_from_slice(symbol.as_bytes());
        v
    }

    /// U13: the worked example of 3.12 to the byte: preimages, leaves, the
    /// root, every proof, the depth bound.
    #[test]
    fn u13_worked_example_of_3_12() {
        let program = Pubkey::from_str("nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk").unwrap();
        assert_eq!(program, crate::ID);
        assert_eq!(
            hex(program.as_ref()),
            "0bb520f977287355b716c92bda75a1efcf5dafc69a57e01481083ae4df2e1c49"
        );
        let entries = [
            (2_643_743u64, "London", "LONDON", 0x11u8),
            (2_988_507, "Paris", "PARIS", 0x22),
            (5_128_581, "New York City", "NYC", 0x33),
        ];
        let want_meta = [
            "c252ce452838061b9ee03879063abccd3482e5fa49174b1ab87b5196e4a44d58",
            "901ac7d96290237431cc70beaf0d46977af1cdc9818ec75eeb46b78a062dcee3",
            "ddcc511e9df7568a13fbc2d6d6091020af5ed62e6120b50315600481bd1feff5",
        ];
        let want_leaf = [
            "539ae27079e009d0b140bea745a90b939c5f5eaf299312a252f9ec0e10cc71e0",
            "a606901235eb24b9a37c1fdc60354539b91f5cd1dcc4d553580d46cdcbc0f44e",
            "0c5ac2c3a5e2fdccf0a2a12d1e9f6696d7c49934e330e3939978835a22f84a5c",
        ];
        let want_len = [156usize, 154, 160];
        let mut leaves = vec![];
        for (i, (city, name, symbol, f)) in entries.iter().enumerate() {
            let founder = Pubkey::new_from_array([*f; 32]);
            let meta = sha(format!("{{\"name\":\"{name}\",\"symbol\":\"{symbol}\"}}").as_bytes());
            assert_eq!(hex(&meta), want_meta[i], "meta_hash {i}");
            let pre = preimage(&program, 7, *city, &founder, 0, &meta, name, symbol);
            assert_eq!(pre.len(), want_len[i], "preimage {i}");
            let leaf = launch_leaf(&program, 7, *city, &founder, 0, &meta, name, symbol).unwrap();
            assert_eq!(leaf, sha(&pre), "leaf {i} is SHA-256 of the preimage");
            assert_eq!(hex(&leaf), want_leaf[i], "leaf {i}");
            leaves.push(leaf);
        }
        // the founders in base58, as 3.12 prints them
        assert_eq!(
            Pubkey::new_from_array([0x11; 32]).to_string(),
            "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2"
        );
        // L0's preimage field by field
        let pre0 = preimage(
            &program,
            7,
            2_643_743,
            &Pubkey::new_from_array([0x11; 32]),
            0,
            &unhex(want_meta[0]),
            "London",
            "LONDON",
        );
        assert_eq!(
            hex(&pre0),
            [
                "00",
                "766963696e6974795f63757276652f6c61756e63685f6c656166",
                "01",
                "0bb520f977287355b716c92bda75a1efcf5dafc69a57e01481083ae4df2e1c49",
                "0700000000000000",
                "1f57280000000000",
                &"11".repeat(32),
                "0000",
                want_meta[0],
                "064c6f6e646f6e",
                "064c4f4e444f4e",
            ]
            .concat()
        );
        let levels = build_levels(&leaves);
        let n01 = node_hash(&leaves[0], &leaves[1]);
        assert_eq!(
            hex(&n01),
            "6565f42ef55b9b2dea2aaad63bdb674e5827004781161dfcefa49ab88085c4b3"
        );
        let r = root(&levels);
        assert_eq!(
            hex(&r),
            "678ab4f7709c306d03b4a47bbc0bd93272acd8cf6fd38c2d6d7629a88f4b5d45"
        );
        assert_eq!(proof(&levels, 0), vec![leaves[1], leaves[2]], "London");
        assert_eq!(proof(&levels, 1), vec![leaves[0], leaves[2]], "Paris");
        assert_eq!(proof(&levels, 2), vec![n01], "New York City");
        for (i, l) in leaves.iter().enumerate() {
            let p = proof(&levels, i);
            assert!(p.len() <= max_proof_len(3));
            assert!(verify_proof(&p, &r, l));
        }
        assert_eq!(tree_depth(3), 2);
        assert_eq!(max_proof_len(3), 2);
        // Paris as "Parisx", another config, ticker, metadata hash, signer,
        // batch or program: another leaf, so the proof fails
        let paris =
            |seq: u64, prog: &Pubkey, f: u8, cfg: u16, meta: &str, name: &str, sym: &str| {
                launch_leaf(
                    prog,
                    seq,
                    2_988_507,
                    &Pubkey::new_from_array([f; 32]),
                    cfg,
                    &unhex(meta),
                    name,
                    sym,
                )
                .unwrap()
            };
        let p1 = proof(&levels, 1);
        let ok = paris(7, &program, 0x22, 0, want_meta[1], "Paris", "PARIS");
        assert!(verify_proof(&p1, &r, &ok));
        for bad in [
            paris(7, &program, 0x22, 0, want_meta[1], "Parisx", "PARIS"),
            paris(7, &program, 0x22, 1, want_meta[1], "Paris", "PARIS"),
            paris(7, &program, 0x22, 0, want_meta[1], "Paris", "PARIX"),
            paris(7, &program, 0x22, 0, want_meta[0], "Paris", "PARIS"),
            paris(7, &program, 0x44, 0, want_meta[1], "Paris", "PARIS"),
            paris(8, &program, 0x22, 0, want_meta[1], "Paris", "PARIS"),
            paris(
                7,
                &Pubkey::new_unique(),
                0x22,
                0,
                want_meta[1],
                "Paris",
                "PARIS",
            ),
        ] {
            assert!(!verify_proof(&p1, &r, &bad));
        }
    }

    /// Distinct deterministic entries for the generated trees (the fixture's
    /// rule, `sdk/fixtures/launch-batch.json`).
    fn entry(i: u32) -> (u64, Pubkey, u16, [u8; 32], String, String) {
        let city = 1_000 + 7 * i as u64;
        let founder = Pubkey::new_from_array(sha(format!("founder:{i}").as_bytes()));
        let meta = sha(format!("meta:{i}").as_bytes());
        let name = format!("City {i}");
        let symbol = format!("C{}", radix36(i));
        (city, founder, (i % 3) as u16, meta, name, symbol)
    }
    fn radix36(mut n: u32) -> String {
        const D: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        let mut s = vec![];
        loop {
            s.push(D[(n % 36) as usize]);
            n /= 36;
            if n == 0 {
                break;
            }
        }
        s.reverse();
        String::from_utf8(s).unwrap()
    }
    fn leaves_of(n: u32, seq: u64) -> Vec<[u8; 32]> {
        (0..n)
            .map(|i| {
                let (c, f, cfg, m, name, sym) = entry(i);
                launch_leaf(&crate::ID, seq, c, &f, cfg, &m, &name, &sym).unwrap()
            })
            .collect()
    }

    /// U13: the shared fixture (trees of 1 to 70 leaves and of 512): every
    /// root, depth and proof the SDK computed is reproduced here (the proofs
    /// through a digest over all of them, plus every listed sample in full).
    #[test]
    fn u13_shared_fixture_with_the_sdk() {
        let path = format!(
            "{}/../../sdk/fixtures/launch-batch.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let fx: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(fx["programId"].as_str().unwrap(), crate::ID.to_string());
        let seq = fx["batchSeq"].as_u64().unwrap();
        let trees = fx["trees"].as_array().unwrap();
        assert_eq!(trees.len(), 71);
        for t in trees {
            let n = t["leaves"].as_u64().unwrap() as u32;
            let leaves = leaves_of(n, seq);
            let levels = build_levels(&leaves);
            let r = root(&levels);
            assert_eq!(hex(&r), t["root"].as_str().unwrap(), "root of {n}");
            assert_eq!(
                tree_depth(n) as u64,
                t["depth"].as_u64().unwrap(),
                "depth of {n}"
            );
            let mut leaf_cat = vec![];
            let mut proof_cat = vec![];
            for (i, l) in leaves.iter().enumerate() {
                let p = proof(&levels, i);
                assert!(
                    p.len() <= max_proof_len(n),
                    "proof {i} of {n} within the depth"
                );
                assert!(verify_proof(&p, &r, l));
                leaf_cat.extend_from_slice(l);
                proof_cat.push(p.len() as u8);
                for s in &p {
                    proof_cat.extend_from_slice(s);
                }
            }
            assert_eq!(
                hex(&sha(&leaf_cat)),
                t["leavesDigest"].as_str().unwrap(),
                "leaves of {n}"
            );
            assert_eq!(
                hex(&sha(&proof_cat)),
                t["proofsDigest"].as_str().unwrap(),
                "proofs of {n}"
            );
            for s in t["samples"].as_array().unwrap() {
                let i = s["index"].as_u64().unwrap() as usize;
                let want: Vec<String> = s["proof"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_str().unwrap().to_string())
                    .collect();
                let got: Vec<String> = proof(&levels, i).iter().map(|x| hex(x)).collect();
                assert_eq!(got, want, "sample proof {i} of {n}");
                assert_eq!(hex(&leaves[i]), s["leaf"].as_str().unwrap());
            }
        }
        // the fixture's worked example equals 3.12's
        assert_eq!(
            fx["workedExample"]["root"].as_str().unwrap(),
            "678ab4f7709c306d03b4a47bbc0bd93272acd8cf6fd38c2d6d7629a88f4b5d45"
        );
    }

    /// U13 (T81, T82): every field changed one at a time gives another leaf;
    /// a leaf preimage is never a node preimage (first byte and length);
    /// proofs truncated, extended, of a neighbour or with a leaf in place of a
    /// node are refused; a proof longer than the depth is refused by length.
    #[test]
    fn u13_mutations_and_second_preimages() {
        let (c, f, cfg, m, name, sym) = entry(5);
        let base = launch_leaf(&crate::ID, 3, c, &f, cfg, &m, &name, &sym).unwrap();
        let other = Pubkey::new_unique();
        let mut m2 = m;
        m2[31] ^= 1;
        let variants = [
            launch_leaf(&other, 3, c, &f, cfg, &m, &name, &sym),
            launch_leaf(&crate::ID, 4, c, &f, cfg, &m, &name, &sym),
            launch_leaf(&crate::ID, 3, c + 1, &f, cfg, &m, &name, &sym),
            launch_leaf(&crate::ID, 3, c, &other, cfg, &m, &name, &sym),
            launch_leaf(&crate::ID, 3, c, &f, cfg + 1, &m, &name, &sym),
            launch_leaf(&crate::ID, 3, c, &f, cfg, &m2, &name, &sym),
            launch_leaf(&crate::ID, 3, c, &f, cfg, &m, "City 6", &sym),
            launch_leaf(&crate::ID, 3, c, &f, cfg, &m, &name, "C6"),
            // the length prefixes make the encoding injective: moving a byte
            // from the name to the symbol changes the leaf
            launch_leaf(&crate::ID, 3, c, &f, cfg, &m, "City 5C", "5"),
        ];
        for v in variants {
            assert_ne!(v.unwrap(), base);
        }
        // a node preimage is 65 bytes starting 0x01; a leaf preimage is 146 to
        // 186 bytes starting 0x00
        let pre = preimage(&crate::ID, 3, c, &f, cfg, &m, &name, &sym);
        assert_eq!(pre[0], 0x00);
        assert!(pre.len() >= 146 && pre.len() <= 186);
        assert_eq!(
            144 + 1 + 1,
            preimage(&crate::ID, 0, 0, &f, 0, &m, "A", "B").len()
        );
        assert_eq!(
            144 + 32 + 10,
            preimage(&crate::ID, 0, 0, &f, 0, &m, &"a".repeat(32), "ABCDEFGHIJ").len()
        );
        // proofs against an 8-leaf tree
        let leaves = leaves_of(8, 3);
        let levels = build_levels(&leaves);
        let r = root(&levels);
        let p = proof(&levels, 2);
        assert!(verify_proof(&p, &r, &leaves[2]));
        assert!(!verify_proof(&p[..2], &r, &leaves[2]), "truncated");
        let mut ext = p.clone();
        ext.push(leaves[0]);
        assert!(!verify_proof(&ext, &r, &leaves[2]), "extended");
        assert!(!verify_proof(&proof(&levels, 3), &r, &leaves[2]) || leaves[2] == leaves[3]);
        assert!(
            !verify_proof(&proof(&levels, 5), &r, &leaves[2]),
            "a neighbour's proof"
        );
        // an inner node presented as a leaf: the node over leaves 2 and 3 with
        // the rest of the proof does fold to the root, but the program never
        // takes a leaf hash, only the fields of a leaf, and no fields hash to
        // that node (its preimage starts with 0x01 and is 65 bytes)
        let n23 = node_hash(&leaves[2], &leaves[3]);
        assert!(verify_proof(&p[1..], &r, &n23));
        let mut as_leaf = vec![0x01];
        as_leaf.extend_from_slice(&leaves[2].min(leaves[3]));
        as_leaf.extend_from_slice(&leaves[2].max(leaves[3]));
        assert_eq!(as_leaf.len(), 65);
        assert_eq!(sha(&as_leaf), n23);
        // a leaf in place of a node in the proof
        let mut swapped = p.clone();
        swapped[1] = leaves[0];
        assert!(!verify_proof(&swapped, &r, &leaves[2]));
        // the depth bound: a 9-hash proof for an 8-leaf tree is refused by
        // length before any hashing (max_proof_len(8) = 3)
        assert_eq!(max_proof_len(8), 3);
        assert_eq!(max_proof_len(512), 9);
        assert_eq!(max_proof_len(513), 9);
        assert_eq!(max_proof_len(u32::MAX), 9);
        for (n, d) in [
            (0u32, 0u32),
            (1, 0),
            (2, 1),
            (3, 2),
            (4, 2),
            (5, 3),
            (256, 8),
            (257, 9),
            (512, 9),
        ] {
            assert_eq!(tree_depth(n), d, "depth({n})");
        }
        // a proof of the right length is still checked: a one-leaf tree's root
        // is its leaf, and its only accepted proof is empty
        let one = leaves_of(1, 3);
        assert_eq!(root(&build_levels(&one)), one[0]);
        assert!(verify_proof(&[], &one[0], &one[0]));
        assert_eq!(max_proof_len(1), 0);
        // over-long strings cannot be length-prefixed
        let long = "a".repeat(256);
        assert!(launch_leaf(&crate::ID, 1, 1, &f, 0, &m, &long, "A").is_err());
        assert!(launch_leaf(&crate::ID, 1, 1, &f, 0, &m, "A", &long).is_err());
    }

    fn rec(seq: u64, from: i64, until: i64, publisher: Pubkey) -> BatchRecord {
        BatchRecord {
            seq,
            root: [seq as u8 | 1; 32],
            leaf_count: 3,
            valid_from: from,
            valid_until: until,
            published_at: from - BATCH_REVIEW_SECS,
            published_slot: 1,
            publisher,
            cleared: false,
        }
    }
    fn code(r: Result<&BatchRecord>) -> u32 {
        match r {
            Err(Error::AnchorError(e)) => e.error_code_number,
            Ok(b) => panic!("in force: batch {}", b.seq),
            other => panic!("{other:?}"),
        }
    }

    /// 4.25 check 6 at each bound (X76): 12 hours of review, 48 hours of lead
    /// and of validity, inclusive; overflows refused.
    #[test]
    fn publication_window_bounds() {
        let now = 1_800_000_000i64;
        let f = now + BATCH_REVIEW_SECS;
        assert!(batch_window_ok(now, f, f + 1));
        assert!(
            !batch_window_ok(now, f - 1, f + 1),
            "one second short of the review"
        );
        assert!(batch_window_ok(
            now,
            now + BATCH_MAX_LEAD_SECS,
            now + BATCH_MAX_LEAD_SECS + 1
        ));
        assert!(!batch_window_ok(
            now,
            now + BATCH_MAX_LEAD_SECS + 1,
            now + BATCH_MAX_LEAD_SECS + 2
        ));
        assert!(batch_window_ok(now, f, f + BATCH_MAX_VALIDITY_SECS));
        assert!(!batch_window_ok(now, f, f + BATCH_MAX_VALIDITY_SECS + 1));
        assert!(!batch_window_ok(now, f, f), "an empty window");
        assert!(!batch_window_ok(now, f, f - 1));
        assert!(!batch_window_ok(i64::MAX, i64::MAX, i64::MAX));
        assert!(!batch_window_ok(now, i64::MAX, i64::MAX));
        assert!(!batch_window_ok(now, i64::MIN, i64::MAX));
        assert_eq!(BATCH_REVIEW_SECS, 12 * 3_600);
        assert_eq!(BATCH_MAX_LEAD_SECS, 48 * 3_600);
        assert_eq!(BATCH_MAX_VALIDITY_SECS, 48 * 3_600);
    }

    /// 8.6's table, step by step: daily publications with no gap, a pending
    /// batch corrected without interrupting the one in force, supersession at
    /// the newer batch's `valid_from`, clears, a former approver's batch.
    #[test]
    fn which_batch_is_in_force_8_6() {
        let a = Pubkey::new_unique();
        let h = 3_600i64;
        let day = 24 * h;
        let d1 = 1_800_000_000i64; // day 1, 00:00
        let mut lb = LaunchBatch {
            bump: 255,
            halted: false,
            latest: BatchRecord::default(),
            previous: BatchRecord::default(),
            _reserved: [0; 32],
        };
        assert_eq!(in_force_now(&lb, &a, d1), None);
        assert_eq!(
            code(batch_in_force(&lb, &a, 0, d1)),
            6065,
            "batch 0 is no batch"
        );
        // day 1, 21:00: batch 1 published, from 09:00 day 2 for 36 hours
        let t = d1 + 21 * h;
        let r1 = rec(1, d1 + day + 9 * h, d1 + day + 45 * h, a);
        assert!(batch_window_ok(t, r1.valid_from, r1.valid_until));
        assert_eq!(apply_publication(&mut lb, r1, t), (0, 0));
        assert_eq!(in_force_now(&lb, &a, t), None);
        assert_eq!(code(batch_in_force(&lb, &a, 1, t)), 6067, "pending");
        // day 2, 09:00: batch 1 in force
        let t = d1 + day + 9 * h;
        assert_eq!(in_force_now(&lb, &a, t), Some(1));
        // day 2, 21:00: batch 2 published (from 09:00 day 3); 1 moves to previous
        let t = d1 + day + 21 * h;
        let r2 = rec(2, d1 + 2 * day + 9 * h, d1 + 2 * day + 45 * h, a);
        assert_eq!(apply_publication(&mut lb, r2, t), (1, 0));
        assert_eq!(in_force_now(&lb, &a, t), Some(1));
        // day 2, 22:00: batch 3 corrects 2 (from 10:00 day 3): 2 replaced
        let t = d1 + day + 22 * h;
        let r3 = rec(3, d1 + 2 * day + 10 * h, d1 + 2 * day + 46 * h, a);
        assert_eq!(apply_publication(&mut lb, r3, t), (1, 2));
        assert_eq!(lb.previous.seq, 1);
        assert_eq!(in_force_now(&lb, &a, t), Some(1));
        assert_eq!(
            code(batch_in_force(&lb, &a, 2, t)),
            6065,
            "a replaced batch never takes force"
        );
        // day 3, 09:30: still batch 1 (3 takes force at 10:00)
        let t = d1 + 2 * day + 9 * h + 1_800;
        assert_eq!(in_force_now(&lb, &a, t), Some(1));
        // day 3, 10:00: batch 3 in force, 1 superseded although not expired
        let t = d1 + 2 * day + 10 * h;
        assert!(t <= lb.previous.valid_until);
        assert_eq!(in_force_now(&lb, &a, t), Some(3));
        assert_eq!(
            code(batch_in_force(&lb, &a, 1, t)),
            6065,
            "superseded at the newer valid_from"
        );
        // a clear ends both
        let mut cleared = lb.clone();
        cleared.latest.cleared = true;
        cleared.previous.cleared = true;
        assert_eq!(in_force_now(&cleared, &a, t), None);
        assert_eq!(code(batch_in_force(&cleared, &a, 3, t)), 6066);
        // a batch past its end
        let late = lb.latest.valid_until + 1;
        assert_eq!(code(batch_in_force(&lb, &a, 3, late)), 6068);
        assert!(
            batch_in_force(&lb, &a, 3, lb.latest.valid_until).is_ok(),
            "inclusive end"
        );
        // a former approver's batch is not in force under a new approver
        let b = Pubkey::new_unique();
        assert_eq!(code(batch_in_force(&lb, &b, 3, t)), 6065);
        assert_eq!(in_force_now(&lb, &b, t), None);
        // a halt or a zero approver: nothing in force
        let mut halted = lb.clone();
        halted.halted = true;
        assert_eq!(in_force_now(&halted, &a, t), None);
        assert_eq!(in_force_now(&lb, &Pubkey::default(), t), None);
        // a publication once the latest has begun moves it to previous even
        // when it is cleared (8.6: "whether it is in force, cleared or past
        // its end")
        let mut c2 = cleared.clone();
        let r4 = rec(4, t + 13 * h, t + 40 * h, a);
        assert_eq!(apply_publication(&mut c2, r4, t + h), (3, 0));
        assert!(c2.previous.cleared);
        assert_eq!(
            in_force_now(&c2, &a, t + h),
            None,
            "no batch until 4 takes force"
        );
        assert_eq!(in_force_now(&c2, &a, t + 13 * h), Some(4));
    }

    /// P12 (in-force half, 12.2): over random publication, clear, rotation
    /// and clock sequences, `batch_in_force` agrees with a direct model of the
    /// two records written from 8.6's prose, and no two batches are ever in
    /// force at once.
    #[test]
    fn p12_in_force_agrees_with_a_direct_model() {
        let cases: u64 = std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(4_000);
        let mut x = 0x9E37_79B9_7F4A_7C15u64;
        let mut rnd = |n: u64| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x % n
        };
        let keys = [Pubkey::new_unique(), Pubkey::new_unique()];
        for _ in 0..cases {
            let mut lb = LaunchBatch {
                bump: 1,
                halted: false,
                latest: BatchRecord::default(),
                previous: BatchRecord::default(),
                _reserved: [0; 32],
            };
            let mut approver = keys[0];
            let mut now = 1_800_000_000i64;
            // the direct model: every published record, and which one each
            // publication replaced
            let mut history: Vec<(BatchRecord, bool)> = vec![]; // (record, replaced)
            for _ in 0..12 {
                match rnd(5) {
                    0 | 1 => {
                        let from = now + BATCH_REVIEW_SECS + rnd(36 * 3_600) as i64;
                        let until = from + 1 + rnd(BATCH_MAX_VALIDITY_SECS as u64) as i64;
                        let mut r = rec(lb.latest.seq + 1, from, until, approver);
                        r.published_at = now;
                        // the model's view of a replacement
                        if let Some(last) = history.last_mut() {
                            if now < last.0.valid_from {
                                last.1 = true;
                            }
                        }
                        apply_publication(&mut lb, r, now);
                        history.push((r, false));
                    }
                    2 => {
                        lb.latest.cleared = true;
                        lb.previous.cleared = true;
                        for h in history.iter_mut() {
                            h.0.cleared = true;
                        }
                    }
                    3 => {
                        approver = keys[rnd(2) as usize];
                        lb.latest.cleared = true;
                        lb.previous.cleared = true;
                        for h in history.iter_mut() {
                            h.0.cleared = true;
                        }
                    }
                    _ => now += rnd(30 * 3_600) as i64,
                }
                // the model: a record is in force when it was never replaced,
                // is not cleared, is the approver's, its window holds now, and
                // no later unreplaced record has begun
                let model: Vec<u64> = history
                    .iter()
                    .enumerate()
                    .filter(|(i, (r, replaced))| {
                        !replaced
                            && !r.cleared
                            && r.publisher == approver
                            && r.valid_from <= now
                            && now <= r.valid_until
                            && !history[i + 1..]
                                .iter()
                                .any(|(l, rep)| !rep && l.valid_from <= now)
                    })
                    .map(|(_, (r, _))| r.seq)
                    .collect();
                assert!(model.len() <= 1, "two batches in force: {model:?}");
                assert_eq!(in_force_now(&lb, &approver, now), model.first().copied());
                for seq in 0..=lb.latest.seq + 1 {
                    let ok = batch_in_force(&lb, &approver, seq, now).is_ok();
                    assert_eq!(ok, model.first() == Some(&seq), "seq {seq}");
                }
            }
        }
    }

    /// P12 (proof half): random batches of 1 to 512 entries with random names
    /// and tickers within the rules: every entry's proof verifies; a mutation
    /// of one field, of the program id or of `batch_seq`, and another
    /// entry's proof, fail.
    #[test]
    fn p12_random_batches() {
        let cases: u64 = std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|s| s.parse().ok())
            .map(|n: u64| n / 100)
            .unwrap_or(24)
            .max(4);
        let mut x = 0xD1B5_4A32_D192_ED03u64;
        let mut rnd = |n: u64| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x % n
        };
        let letters = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        for case in 0..cases {
            let n = if case == 0 { 512 } else { 1 + rnd(512) as u32 };
            let seq = 1 + rnd(1_000);
            let entries: Vec<_> = (0..n)
                .map(|i| {
                    let sym_len = 1 + rnd(10) as usize;
                    let symbol: String = (0..sym_len)
                        .map(|_| letters[rnd(36) as usize] as char)
                        .collect();
                    let name: String = (0..1 + rnd(32) as usize)
                        .map(|k| {
                            if k % 5 == 4 {
                                'é'
                            } else {
                                (b'a' + rnd(26) as u8) as char
                            }
                        })
                        .collect::<String>()
                        .chars()
                        .take(16)
                        .collect();
                    (
                        10_000 + i as u64 * 3 + rnd(3),
                        Pubkey::new_unique(),
                        rnd(4) as u16,
                        sha(&[i as u8, case as u8, 7]),
                        name,
                        symbol,
                    )
                })
                .collect();
            let leaf = |e: &(u64, Pubkey, u16, [u8; 32], String, String), s: u64, p: &Pubkey| {
                launch_leaf(p, s, e.0, &e.1, e.2, &e.3, &e.4, &e.5).unwrap()
            };
            let leaves: Vec<_> = entries.iter().map(|e| leaf(e, seq, &crate::ID)).collect();
            let levels = build_levels(&leaves);
            let r = root(&levels);
            for _ in 0..8 {
                let i = rnd(n as u64) as usize;
                let p = proof(&levels, i);
                assert!(p.len() <= max_proof_len(n));
                assert!(verify_proof(&p, &r, &leaves[i]));
                let e = &entries[i];
                assert!(!verify_proof(&p, &r, &leaf(e, seq + 1, &crate::ID)));
                assert!(!verify_proof(&p, &r, &leaf(e, seq, &Pubkey::new_unique())));
                let mut m = e.clone();
                match rnd(6) {
                    0 => m.0 += 1,
                    1 => m.1 = Pubkey::new_unique(),
                    2 => m.2 ^= 1,
                    3 => m.3[0] ^= 1,
                    4 => m.4.push('x'),
                    _ => m.5 = format!("{}Z", &m.5[..m.5.len().min(9)]),
                }
                assert!(!verify_proof(&p, &r, &leaf(&m, seq, &crate::ID)));
                if n > 1 {
                    let j = (i + 1 + rnd(n as u64 - 1) as usize) % n as usize;
                    assert!(
                        !verify_proof(&proof(&levels, j), &r, &leaves[i]) || leaves[i] == leaves[j]
                    );
                }
            }
        }
    }
}
