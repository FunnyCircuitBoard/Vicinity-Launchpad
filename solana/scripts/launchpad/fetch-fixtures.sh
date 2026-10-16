#!/usr/bin/env bash
# Fetch the Meteora and Metaplex programs the launchpad tests load, straight
# from mainnet (read-only: `solana program dump`), and check them against the
# pinned SHA-256 values in LAUNCHPAD-DESIGN.md section 17.
#
# A mismatch means Meteora (or Metaplex) upgraded the program on mainnet:
# stop, read their changelog, rerun the tests on the new binary (the whole
# suite, including tests-launchpad/20-legacy-config.test.mjs, which runs the
# live mainnet config through a coin's life), then re-pin the hash here, in
# the design file and in src/sol/dbc-config-data.js (worker-config-bytes.mjs).
# Never edit a hash to make this pass.
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
  # 503,167,099 and 503,166,267). Read again on 16 Oct 2026 (read-only): devnet's DBC was upgraded
  # too (slot 508,712,305, SHA-256 5edf76d9…) and has not been re-tested, so its pin stays and
  # NETWORK=devnet reports FAIL for dbc.so until someone runs the suite on it; DAMM v2 and
  # Metaplex are unchanged on devnet.
  PROGRAMS=(
    "dbc dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN f5ccbb01e37165d16108bda0259fb3acbfca29305e23098c3b248e50c22979f0"
    "damm_v2 cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG 82bb9375921bb8007551cb65f9ca43b191597496cc9922926468b36671081ec2"
    "mpl_token_metadata metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s bb0842f6d5740eabe8f9fb3b723b9ecd89cadf9f48ef9ad6a9dc6cfa8a9658e4"
  )
else
  OUT=tests-launchpad/fixtures/programs
  RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
  # Re-pinned on 16 Oct 2026 after Meteora upgraded both programs on mainnet: DBC 0.2.1 -> 0.2.2
  # (slot 457,502,600, 16 Oct 2026; was 4c26a8a5…) and DAMM v2 0.2.4 -> 0.2.5 (slot 457,080,014,
  # 15 Oct 2026; was 4d5b920b…). The whole suite was re-run on these bytes, also against the live
  # legacy (version 0) config (now tests-launchpad/20-legacy-config.test.mjs): LAUNCHPAD-DESIGN.md
  # section 17. Metaplex is unchanged.
  # name  program id                                       sha256
  PROGRAMS=(
    "dbc dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN e2bfc853c1a1778dd8ee40ea9a0f3edf5587442360c57c685e7e3024ad0cad47"
    "damm_v2 cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG 967ff9fb161eec2e62f66d2c899100739fb747c445f697b8625c86b31b9a2022"
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
