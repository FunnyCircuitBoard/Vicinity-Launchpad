#!/usr/bin/env bash
# The vicinity_curve client IDL (VICINITY-CURVE-DESIGN.md 8.4 and 14.3).
#
# The deployed binary has no IDL instructions (`no-idl` is a default feature,
# so nobody can create the legacy on-chain IDL account), and the IDL JSON is
# published with the verified build instead: it is generated from the source
# with Anchor's `idl-build` feature (the same step `anchor build` runs) and
# committed at sdk/idl/vicinity_curve.json. It is the default build's IDL
# (mainnet ids of vicinity_rewards and the old vicinity_launchpad); the devnet
# build differs only in the values of the constants REWARDS_PROGRAM_ID,
# LEGACY_PROGRAM_ID and LEGACY_LAUNCHPAD.
#
# Usage (from solana/):
#   npm run vcurve:idl         regenerate sdk/idl/vicinity_curve.json
#   npm run vcurve:idl:check   regenerate into target/idl/ and diff with the
#                              committed file (exit 1 on any difference)
# CI diffs the IDL that `anchor build` writes (target/idl/vicinity_curve.json)
# against the committed file, like the IDLs of the other two programs.
set -euo pipefail
cd "$(dirname "$0")/../.."
COMMITTED=sdk/idl/vicinity_curve.json
case "${1:-check}" in
  write)
    anchor idl build -p vicinity_curve -o "$COMMITTED"
    echo "wrote $COMMITTED"
    ;;
  check)
    mkdir -p target/idl
    anchor idl build -p vicinity_curve -o target/idl/vicinity_curve.check.json
    diff -u "$COMMITTED" target/idl/vicinity_curve.check.json
    echo "$COMMITTED matches the source"
    ;;
  *)
    echo "usage: $0 write|check" >&2
    exit 2
    ;;
esac
