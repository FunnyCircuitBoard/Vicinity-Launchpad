#!/usr/bin/env bash
# Fetch the Meteora and Metaplex programs the launchpad tests load, straight
# from mainnet (read-only: `solana program dump`), and check them against the
# pinned SHA-256 values in LAUNCHPAD-DESIGN.md section 17.
#
# A mismatch means Meteora (or Metaplex) upgraded the program on mainnet:
# stop, read their changelog, rerun the tests on the new binary, then re-pin
# the hash here and in the design file. Never edit a hash to make this pass.
#
# Usage: npm run launchpad:fixtures   (from solana/)
# Env:   RPC_URL (default https://api.mainnet-beta.solana.com)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=tests-launchpad/fixtures/programs
RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
mkdir -p "$OUT"

# name  program id                                       sha256
PROGRAMS=(
  "dbc dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN 4c26a8a5da99f8ce932fa0300c46675b527090021fbb74214c9486bedda9f23b"
  "damm_v2 cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG 4d5b920baebc090f89b2e8796a3452ed067c9667a143058c96a312f2c1e6848b"
  "mpl_token_metadata metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s 31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011"
)

fail=0
for row in "${PROGRAMS[@]}"; do
  read -r name id want <<<"$row"
  file="$OUT/$name.so"
  if [ ! -f "$file" ] || [ "$(sha256sum "$file" | cut -d' ' -f1)" != "$want" ]; then
    echo "dumping $name ($id) from $RPC_URL"
    solana program dump -u "$RPC_URL" "$id" "$file" >/dev/null
  fi
  got=$(sha256sum "$file" | cut -d' ' -f1)
  if [ "$got" = "$want" ]; then
    echo "ok   $name.so  $got"
  else
    echo "FAIL $name.so  got $got, pinned $want  (the program changed on mainnet; see the comment at the top)"
    fail=1
  fi
done
exit $fail
