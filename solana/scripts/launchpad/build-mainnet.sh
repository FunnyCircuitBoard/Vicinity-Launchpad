#!/usr/bin/env bash
# Build vicinity_launchpad and vicinity_rewards for MAINNET with the owner's two program addresses
# (docs/OWNER-LAUNCH-GUIDE.md, part 2). The team runs this; the owner gets the two .so files and SHA256SUMS.
#
#   bash solana/scripts/launchpad/build-mainnet.sh <launchpadProgramId> <rewardsProgramId> [outDir]
#
# Everything happens in a scratch copy. The repository keeps the devnet ids in declare_id! (the tests and devnet use
# them) and this script never runs `anchor keys sync`, never adds security.txt and never changes anything else:
#   1. both ids are checked: base58, 32 bytes, different from each other, from the devnet ids and from the dev wallet;
#   2. cargo-build-sbf and platform-tools must be the pinned versions (the audited binaries were built with them), and
#      the build inputs (programs/, Cargo.toml, Cargo.lock, Anchor.toml, idls/) must be committed;
#   3. the build inputs are copied to a scratch directory (no target, no node_modules);
#   4. both programs are built UNCHANGED first, and their SHA-256 must equal the audited devnet builds recorded in
#      LAUNCHPAD-AUDIT.md section 3 and AUDIT.md section 2: this machine reproduces the audited bytes;
#   5. the two declare_id! lines are replaced (and [programs.mainnet] added to Anchor.toml) in the copy, both are built
#      again, and each binary must be the audited one with ONLY its id swapped: same size; the audited binary with every
#      occurrence of the devnet id replaced by the new id is byte for byte the new binary (an occurrence is the id stored as
#      32 bytes, or the id the compiler inlined as four 64-bit immediates where the program compares an address with its own
#      id: the launchpad stores it once and inlines it 12 times, the rewards program only inlines it, 38 times); no 8-byte
#      piece of the devnet id is left anywhere; the other program's ids appear nowhere;
#   6. size, SHA-256 and the exact rent are printed (read-only `solana rent` on mainnet, with the measured formula as
#      the fallback); <outDir>/SHA256SUMS and <outDir>/build-record.json are written next to the two .so files;
#   7. the scratch copy, its target directory and the throwaway keypairs cargo-build-sbf writes are deleted.
# It reads mainnet (rent, one feature flag) and nothing else; it signs nothing, sends nothing and holds no key.
# outDir defaults to ${TMPDIR:-/tmp}/vicinity-mainnet-<first 8 characters of the launchpad id>, outside the repository.
set -euo pipefail

PIN_CARGO_BUILD_SBF="4.4.0"
PIN_PLATFORM_TOOLS="v1.57"
# The audited production builds with the devnet ids (LAUNCHPAD-AUDIT.md section 3, AUDIT.md section 2).
DEVNET_LAUNCHPAD_ID="Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7"
DEVNET_REWARDS_ID="Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi"
AUDITED_LAUNCHPAD_SHA256="8706e3bfb1dc7b39a5790586144327267cdb5336ed34a541504723811e0e27f0"
AUDITED_REWARDS_SHA256="f0fbc9d53ed092210eef3f97047644d6f796d634bf11c428795ff8b0b1e509a3"
EXPECTED_LAUNCHPAD_SIZE=433960
EXPECTED_REWARDS_SIZE=505864
OTHER_TAKEN_IDS="EVvMRwM4Dg9Etp7L9JkouWkcJkXRmW2jHYvgaMVfysbZ 13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN"
# Rent: ProgramData holds 45 bytes of header plus the binary, the program account 36 bytes; every account pays rent for
# 128 more bytes. 5,080 lamports per byte is the rate mainnet and devnet answered on 10 Oct 2026.
RENT_LAMPORTS_PER_BYTE=5080
SBPF_V3_FEATURE="5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC"
MAINNET_URL=${MAINNET_URL:-https://api.mainnet-beta.solana.com}

die() { echo "refusing: $*" >&2; exit 1; }
LP_ID=${1:-}
RW_ID=${2:-}
[ -n "$LP_ID" ] && [ -n "$RW_ID" ] || { echo "usage: bash solana/scripts/launchpad/build-mainnet.sh <launchpadProgramId> <rewardsProgramId> [outDir]" >&2; exit 2; }
OUT=${3:-${TMPDIR:-/tmp}/vicinity-mainnet-${LP_ID:0:8}}

SOLANA_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
for tool in cargo-build-sbf solana node sha256sum; do command -v "$tool" >/dev/null || die "$tool is not on PATH"; done

# ---- 1. the ids
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/vicinity-mainnet-build.XXXXXX")
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT
HELPER=$SCRATCH/ids.mjs
cat >"$HELPER" <<'EOF'
// node ids.mjs check <id>...            exit 1 unless each is base58 of exactly 32 bytes
// node ids.mjs swap <a.so> <b.so> <oldId> <newId>
//   B must be A with only the id swapped: same size; every byte where they differ belongs to an occurrence of the old id in
//   A that is the new id in B, either as 32 contiguous bytes (the stored id) or as 8-byte chunks loaded by lddw (opcode
//   0x18, the 64-bit immediate split in two 4-byte halves: where the compiler inlined a comparison with the program's own
//   id); prints JSON { identicalAfterSwap, differingBytes, contiguous, lddw (full ids inlined), oldLeft } of B, where oldLeft
//   counts every place an 8-byte piece of the old id is still found in B (stored, inlined or anywhere else).
import { readFileSync } from "node:fs";
const A58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function dec(s) {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return null;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A58.indexOf(c));
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === "1") out.unshift(0); else break; }
  return Buffer.from(out);
}
const [mode, ...args] = process.argv.slice(2);
if (mode === "check") {
  for (const id of args) { const k = dec(id); if (!k || k.length !== 32) { console.error(`${id} is not a 32-byte base58 address`); process.exit(1); } }
  process.exit(0);
}
const [fa, fb, oldId, newId] = args;
const a = readFileSync(fa), b = readFileSync(fb), o = dec(oldId), n = dec(newId);
if (a.length !== b.length) { console.log(JSON.stringify({ sameSize: false, sizeA: a.length, sizeB: b.length })); process.exit(1); }
// where an id sits in a binary: contiguous 32 bytes, or four lddw (16 bytes each: imm low 4 bytes at +4, imm high at +12)
function places(buf, k) {
  const out = { contiguous: [], lddw: [] };
  for (let at = buf.indexOf(k); at !== -1; at = buf.indexOf(k, at + 1)) out.contiguous.push(at);
  const pieces = [0, 1, 2, 3].map((i) => k.subarray(8 * i, 8 * i + 8));
  for (let at = 0; at + 16 <= buf.length; at += 8) {
    if (buf[at] !== 0x18) continue;
    for (let c = 0; c < 4; c++) {
      if (buf.compare(pieces[c], 0, 4, at + 4, at + 8) === 0 && buf.compare(pieces[c], 4, 8, at + 12, at + 16) === 0) out.lddw.push({ at, chunk: c });
    }
  }
  return out;
}
const pa = places(a, o);
// A with the id swapped at every place it occurs must equal B
const swapped = Buffer.from(a);
for (const at of pa.contiguous) n.copy(swapped, at);
for (const { at, chunk } of pa.lddw) { n.copy(swapped, at + 4, 8 * chunk, 8 * chunk + 4); n.copy(swapped, at + 12, 8 * chunk + 4, 8 * chunk + 8); }
let differing = 0;
for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
const pb = places(b, n), left = places(b, o);
const lddwSets = (p) => { const c = [0, 0, 0, 0]; for (const x of p.lddw) c[x.chunk]++; return Math.min(...c); };
const rawPieces = (buf, k) => { let hits = 0; for (let c = 0; c < 4; c++) { const piece = k.subarray(8 * c, 8 * c + 8); for (let at = buf.indexOf(piece); at !== -1; at = buf.indexOf(piece, at + 1)) hits++; } return hits; };
const report = {
  sameSize: true, identicalAfterSwap: swapped.equals(b), differingBytes: differing,
  contiguous: pb.contiguous.length, lddw: lddwSets(pb), oldLeft: left.contiguous.length + left.lddw.length + rawPieces(b, o),
};
console.log(JSON.stringify(report));
process.exit(report.identicalAfterSwap ? 0 : 1);
EOF
node "$HELPER" check "$LP_ID" "$RW_ID" || die "both ids must be Solana addresses (base58, 32 bytes)"
[ "$LP_ID" != "$RW_ID" ] || die "the launchpad and rewards ids are the same address"
for taken in "$DEVNET_LAUNCHPAD_ID" "$DEVNET_REWARDS_ID" $OTHER_TAKEN_IDS; do
  [ "$LP_ID" != "$taken" ] && [ "$RW_ID" != "$taken" ] || die "$taken is a devnet program id, the test program or the dev wallet, not a new mainnet program address"
done

# ---- 2. the pinned toolchain and a committed source
V=$(cargo-build-sbf --version 2>&1)
echo "$V" | grep -qx "cargo-build-sbf $PIN_CARGO_BUILD_SBF" || die "cargo-build-sbf is not $PIN_CARGO_BUILD_SBF (got: $(echo "$V" | head -1))"
echo "$V" | grep -qx "platform-tools $PIN_PLATFORM_TOOLS" || die "platform-tools is not $PIN_PLATFORM_TOOLS (got: $(echo "$V" | sed -n 2p))"
RUSTC_SBF=$(echo "$V" | sed -n 's/^rustc //p')
SOLANA_CLI=$(solana --version | awk '{print $2}')
INPUTS=(programs Cargo.toml Cargo.lock Anchor.toml idls)
COMMIT=unknown
if git -C "$SOLANA_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  dirty=$(cd "$SOLANA_DIR" && git status --porcelain -- "${INPUTS[@]}")
  [ -z "$dirty" ] || die "the build inputs have uncommitted changes (commit or stash them first):
$dirty"
  COMMIT=$(git -C "$SOLANA_DIR" rev-parse HEAD)
fi

# ---- 3. the scratch copy (build inputs only)
SRC=$SCRATCH/solana
mkdir -p "$SRC" "$SCRATCH/deploy-devnet" "$SCRATCH/deploy-mainnet" "$OUT"
for x in "${INPUTS[@]}"; do cp -a "$SOLANA_DIR/$x" "$SRC/"; done
export CARGO_TARGET_DIR=$SCRATCH/target

build() { # <out dir>
  local p
  for p in vicinity-launchpad vicinity-rewards; do
    (cd "$SRC" && cargo-build-sbf --manifest-path "programs/$p/Cargo.toml" --sbf-out-dir "$1" -- --locked) >"$SCRATCH/build.log" 2>&1 \
      || { tail -30 "$SCRATCH/build.log" >&2; die "the build of $p failed (log above)"; }
  done
  rm -f "$1"/*-keypair.json # throwaway program keypairs cargo-build-sbf writes; the owner's own keys are the program ids
}
sha() { sha256sum "$1" | cut -d' ' -f1; }
size() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }

# ---- 4. the audited bytes, reproduced
echo "building the audited source (commit ${COMMIT:0:12}) unchanged with cargo-build-sbf $PIN_CARGO_BUILD_SBF, platform-tools $PIN_PLATFORM_TOOLS ..."
build "$SCRATCH/deploy-devnet"
for pair in "vicinity_launchpad:$AUDITED_LAUNCHPAD_SHA256" "vicinity_rewards:$AUDITED_REWARDS_SHA256"; do
  name=${pair%%:*} want=${pair#*:}
  got=$(sha "$SCRATCH/deploy-devnet/$name.so")
  [ "$got" = "$want" ] || die "$name built from this source is $got, not the audited $want. The source or the toolchain differs from what was audited: stop and find out why."
  echo "  $name: reproduces the audited SHA-256 $want"
done

# ---- 5. the mainnet ids, in the copy only
sed -i.bak "s/declare_id!(\"$DEVNET_LAUNCHPAD_ID\")/declare_id!(\"$LP_ID\")/" "$SRC/programs/vicinity-launchpad/src/lib.rs"
sed -i.bak "s/declare_id!(\"$DEVNET_REWARDS_ID\")/declare_id!(\"$RW_ID\")/" "$SRC/programs/vicinity-rewards/src/lib.rs"
rm -f "$SRC"/programs/*/src/lib.rs.bak
grep -q "declare_id!(\"$LP_ID\")" "$SRC/programs/vicinity-launchpad/src/lib.rs" || die "declare_id! of vicinity_launchpad was not replaced"
grep -q "declare_id!(\"$RW_ID\")" "$SRC/programs/vicinity-rewards/src/lib.rs" || die "declare_id! of vicinity_rewards was not replaced"
[ "$(grep -c 'declare_id!' "$SRC/programs/vicinity-launchpad/src/lib.rs")" = 1 ] && [ "$(grep -c 'declare_id!' "$SRC/programs/vicinity-rewards/src/lib.rs")" = 1 ] || die "expected exactly one declare_id! per program"
printf '\n[programs.mainnet]\nvicinity_rewards = "%s"\nvicinity_launchpad = "%s"\n' "$RW_ID" "$LP_ID" >>"$SRC/Anchor.toml"
echo "building with the mainnet ids ..."
build "$SCRATCH/deploy-mainnet"

LP_LAMPORTS_RENT=0
RECORD_PROGRAMS=""
SUMS=""
for spec in "vicinity_launchpad:$LP_ID:$DEVNET_LAUNCHPAD_ID:$EXPECTED_LAUNCHPAD_SIZE:$DEVNET_REWARDS_ID:$RW_ID" "vicinity_rewards:$RW_ID:$DEVNET_REWARDS_ID:$EXPECTED_REWARDS_SIZE:$DEVNET_LAUNCHPAD_ID:$LP_ID"; do
  IFS=: read -r name id old expected otherOld otherNew <<<"$spec"
  dev=$SCRATCH/deploy-devnet/$name.so main=$SCRATCH/deploy-mainnet/$name.so
  report=$(node "$HELPER" swap "$dev" "$main" "$old" "$id") || die "$name with the mainnet id is not the audited binary with only its id swapped: $report"
  echo "$report" | grep -q '"oldLeft":0' || die "$name still holds (a piece of) the devnet id $old: $report"
  echo "$report" | grep -Eq '"contiguous":0,"lddw":0' && die "$name does not hold its new id at all: $report"
  # the other program's ids appear in neither form (the launchpad learns the rewards program at init, never from code)
  for o2 in "$otherNew" "$otherOld"; do
    other=$(node "$HELPER" swap "$main" "$main" "$o2" "$o2")
    echo "$other" | grep -q '"contiguous":0,"lddw":0' || die "$name unexpectedly holds the other program's id $o2: $other"
  done
  bytes=$(size "$main")
  [ "$bytes" = "$(size "$dev")" ] || die "$name changed size with the new id"
  [ "$bytes" = "$expected" ] || echo "  WARNING: $name is $bytes bytes, not the $expected recorded (the rent figures of the guide assume $expected)"
  digest=$(sha "$main")
  pd=$((bytes + 45))
  rent=$(solana rent "$pd" -u "$MAINNET_URL" --lamports 2>/dev/null | awk '/Rent-exempt/{print $(NF-1)}' || true)
  source=mainnet
  if ! [[ "$rent" =~ ^[0-9]+$ ]]; then rent=$(( (pd + 128) * RENT_LAMPORTS_PER_BYTE )); source="formula ($RENT_LAMPORTS_PER_BYTE lamports per byte)"; fi
  prog=$(solana rent 36 -u "$MAINNET_URL" --lamports 2>/dev/null | awk '/Rent-exempt/{print $(NF-1)}' || true)
  [[ "$prog" =~ ^[0-9]+$ ]] || prog=$(( (36 + 128) * RENT_LAMPORTS_PER_BYTE ))
  cp "$main" "$OUT/$name.so"
  SUMS="$SUMS$digest  $name.so"$'\n'
  stored=$(echo "$report" | sed -E 's/.*"contiguous":([0-9]+).*/\1/')
  inlined=$(echo "$report" | sed -E 's/.*"lddw":([0-9]+).*/\1/')
  differing=$(echo "$report" | sed -E 's/.*"differingBytes":([0-9]+).*/\1/')
  printf '  %-19s %s\n    %s bytes, SHA-256 %s\n    the new id is stored %s time(s) and inlined %s times; no piece of the devnet id is left; the %s bytes that differ from the audited build are exactly those id bytes\n    rent: ProgramData %s lamports (%s bytes, %s) + program account %s lamports\n' \
    "$name.so" "$id" "$bytes" "$digest" "$stored" "$inlined" "$differing" "$rent" "$pd" "$source" "$prog"
  LP_LAMPORTS_RENT=$((LP_LAMPORTS_RENT + rent + prog))
  RECORD_PROGRAMS="$RECORD_PROGRAMS${RECORD_PROGRAMS:+,}
    \"$name\": { \"programId\": \"$id\", \"file\": \"$name.so\", \"bytes\": $bytes, \"sha256\": \"$digest\", \"auditedDevnetSha256\": \"$(sha "$dev")\", \"devnetId\": \"$old\", \"idOccurrences\": $report, \"programDataBytes\": $pd, \"rentLamports\": { \"programData\": $rent, \"programAccount\": $prog, \"source\": \"$source\" } }"
done
printf '%s' "$SUMS" >"$OUT/SHA256SUMS"

# ---- 6. mainnet runs SBPF v3 (read-only; the binaries are v3, the default of cargo-build-sbf $PIN_CARGO_BUILD_SBF)
flags=$(node -e 'const b=require("fs").readFileSync(process.argv[1]);console.log(b.readUInt32LE(48))' "$OUT/vicinity_launchpad.so")
feature=$(solana feature status "$SBPF_V3_FEATURE" -u "$MAINNET_URL" 2>/dev/null | grep -o "active since epoch [0-9]*" || echo "unknown (mainnet not reachable)")
echo "  SBPF version $flags; mainnet SBPF v3: $feature"

total=$LP_LAMPORTS_RENT
cat >"$OUT/build-record.json" <<EOF
{
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "commit": "$COMMIT",
  "changedFromCommit": "only the declare_id! line of each program (and [programs.mainnet] in Anchor.toml) in a scratch copy",
  "toolchain": { "cargoBuildSbf": "$PIN_CARGO_BUILD_SBF", "platformTools": "$PIN_PLATFORM_TOOLS", "rustc": "$RUSTC_SBF", "solanaCli": "$SOLANA_CLI", "sbpfVersion": $flags, "mainnetSbpfV3": "$feature" },
  "programs": {$RECORD_PROGRAMS
  },
  "deployRentLamports": $total,
  "notVerifiable": "built without Docker (no anchor build --verifiable on this machine); reproducible with this script and the pinned toolchain"
}
EOF
printf '\nTotal rent for both programs: %s lamports (%s SOL). The owner funds the deployer with 4.85 SOL (docs/OWNER-LAUNCH-GUIDE.md).\n' "$total" "$(awk -v l="$total" 'BEGIN{printf "%.9f", l/1e9}')"
echo "Written to $OUT: vicinity_launchpad.so, vicinity_rewards.so, SHA256SUMS, build-record.json"
echo "The owner checks them with: shasum -a 256 -c SHA256SUMS"
# ---- 7. cleanup (the trap deletes the scratch copy, its target directory and the throwaway keypairs)
