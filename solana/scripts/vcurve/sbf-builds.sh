#!/usr/bin/env bash
# The three vicinity_curve SBF builds (VICINITY-CURVE-DESIGN.md 3.1, 8.3, C03,
# C04): production (default features: `no-idl`, mainnet ids), devnet (the
# compiled devnet ids of 3.2) and halt-all (the pre-audited emergency build:
# the eight outflow instructions refuse with TradingHalted).
#
# Each build recompiles the program crate itself (dependencies stay cached),
# so cargo-build-sbf prints every warning, and the script fails on any
# "Stack offset ... exceeded" warning (C04). It prints each binary's size and
# SHA-256 (C03). The binaries go to target/vcurve-builds/<variant>/ and never
# overwrite target/deploy (what `anchor build` and `anchor test` use).
#
# Usage (from solana/): npm run vcurve:sbf
set -euo pipefail
cd "$(dirname "$0")/../.."
MANIFEST=programs/vicinity-curve/Cargo.toml
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
status=0
summary=""
for variant in production devnet halt-all; do
  out="target/vcurve-builds/$variant"
  log="target/vcurve-builds/$variant.log"
  mkdir -p "$out"
  features=()
  if [ "$variant" != production ]; then features=(--features "$variant"); fi
  # A new mtime makes cargo recompile the crate, so its warnings are printed.
  touch programs/vicinity-curve/src/lib.rs
  cargo build-sbf --manifest-path "$MANIFEST" --sbf-out-dir "$out" ${features[@]+"${features[@]}"} 2>&1 | tee "$log"
  # CI sets CARGO_TERM_COLOR=always, which puts colour codes between "Compiling"
  # and the crate name: search a copy of the log with the codes removed.
  plain="target/vcurve-builds/$variant.plain.log"
  sed 's/\x1b\[[0-9;]*m//g' "$log" > "$plain"
  if ! grep -q "Compiling vicinity-curve " "$plain"; then
    echo "FAIL: the $variant build did not recompile the program crate" >&2
    status=1
  fi
  if grep -qi "stack offset" "$plain"; then
    echo "FAIL: stack offset warning in the $variant build (C04)" >&2
    status=1
  fi
  so="$out/vicinity_curve.so"
  summary+=$(printf '%-10s %8d bytes  sha256 %s' "$variant" "$(wc -c < "$so" | tr -d ' ')" "$(sha256 "$so")")$'\n'
done
printf '\nvicinity_curve builds (no stack warning: %s)\n%s' "$([ $status -eq 0 ] && echo yes || echo NO)" "$summary"
exit $status
