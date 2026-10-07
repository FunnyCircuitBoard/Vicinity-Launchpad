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
# Env:   RPC_URL (default: the public RPC of NETWORK)
#        NETWORK=devnet  dump the devnet binaries instead, into
#                        tests-launchpad/fixtures/programs-devnet, and check the
#                        devnet hashes below. Devnet runs different builds of the
#                        same programs (LAUNCHPAD-DEVNET.md); run the suite on them with
#                        LAUNCHPAD_PROGRAMS_DIR=tests-launchpad/fixtures/programs-devnet npm run test:launchpad
set -euo pipefail
cd "$(dirname "$0")/../.."
NETWORK="${NETWORK:-mainnet}"

if [ "$NETWORK" = "devnet" ]; then
  OUT=tests-launchpad/fixtures/programs-devnet
  RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
  # Read from devnet on 6 Oct 2026 (DBC and DAMM v2 upgrade authority
  # DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX, last deployed in slots
  # 503,167,099 and 503,166,267).
  PROGRAMS=(
    "dbc dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN f5ccbb01e37165d16108bda0259fb3acbfca29305e23098c3b248e50c22979f0"
    "damm_v2 cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG 82bb9375921bb8007551cb65f9ca43b191597496cc9922926468b36671081ec2"
    "mpl_token_metadata metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s bb0842f6d5740eabe8f9fb3b723b9ecd89cadf9f48ef9ad6a9dc6cfa8a9658e4"
  )
else
  OUT=tests-launchpad/fixtures/programs
  RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
  # name  program id                                       sha256
  PROGRAMS=(
    "dbc dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN 4c26a8a5da99f8ce932fa0300c46675b527090021fbb74214c9486bedda9f23b"
    "damm_v2 cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG 4d5b920baebc090f89b2e8796a3452ed067c9667a143058c96a312f2c1e6848b"
    "mpl_token_metadata metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s 31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011"
  )
fi
mkdir -p "$OUT"

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
    echo "FAIL $name.so  got $got, pinned $want  (the program changed on $NETWORK; see the comment at the top)"
    fail=1
  fi
done
exit $fail
