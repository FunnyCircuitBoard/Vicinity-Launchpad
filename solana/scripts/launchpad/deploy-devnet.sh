#!/usr/bin/env bash
# Deploy (or upgrade) vicinity_launchpad on DEVNET with the throwaway deployer
# (LAUNCHPAD-DEVNET.md). It refuses any cluster but devnet, refuses a binary
# whose SHA-256 differs from the one recorded in LAUNCHPAD-AUDIT.md section 3,
# and refuses to start without enough SOL for the whole deploy.
#
# Keys are only ever passed by path and never printed. The deploy output goes
# to a file inside the keys folder and is never shown, because a failed deploy
# can print a recovery phrase for the buffer; only the program id and the
# signature are printed. Run it again after a failure: it resumes into the same
# buffer.
#
# Usage, from solana/:
#   bash scripts/launchpad/deploy-devnet.sh <keys dir>
# <keys dir> must hold devnet-deployer.json (payer and upgrade authority) and
# vicinity_launchpad-program-keypair.json (the address in declare_id!). The
# buffer keypair launchpad-buffer-keypair.json is created there if missing.
# Environment: RPC (default https://api.devnet.solana.com), EXPECTED_SHA256.
set -euo pipefail

KEYS=${1:?usage: bash scripts/launchpad/deploy-devnet.sh <keys dir>}
RPC=${RPC:-https://api.devnet.solana.com}
SO=target/deploy/vicinity_launchpad.so
EXPECTED_SHA256=${EXPECTED_SHA256:-8706e3bfb1dc7b39a5790586144327267cdb5336ed34a541504723811e0e27f0}
DEVNET_GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
DEPLOYER=$KEYS/devnet-deployer.json
PROGRAM_KP=$KEYS/vicinity_launchpad-program-keypair.json
BUFFER_KP=$KEYS/launchpad-buffer-keypair.json
FEE_MARGIN=20000000 # 0.02 SOL for about 450 write transactions and the deploy itself

for f in "$DEPLOYER" "$PROGRAM_KP" "$SO"; do [ -f "$f" ] || { echo "missing $f"; exit 1; }; done

genesis=$(solana genesis-hash -u "$RPC")
[ "$genesis" = "$DEVNET_GENESIS" ] || { echo "refusing: $RPC is not devnet (genesis $genesis)"; exit 1; }

sha=$(sha256sum "$SO" | cut -d' ' -f1)
[ "$sha" = "$EXPECTED_SHA256" ] || { echo "refusing: $SO has SHA-256 $sha; LAUNCHPAD-AUDIT.md section 3 records $EXPECTED_SHA256"; exit 1; }

PROGRAM_ID=$(solana address -k "$PROGRAM_KP")
grep -q "declare_id!(\"$PROGRAM_ID\")" programs/vicinity-launchpad/src/lib.rs \
  || { echo "refusing: the program keypair's address $PROGRAM_ID is not the declare_id! of vicinity_launchpad"; exit 1; }
DEPLOYER_ADDR=$(solana address -k "$DEPLOYER")
LEN=$(stat -c %s "$SO")

rent() { solana rent "$1" -u "$RPC" --lamports | awk '/Rent-exempt/{print $(NF-1)}'; }
if solana program show "$PROGRAM_ID" -u "$RPC" >/dev/null 2>&1; then
  what="upgrade"
  need=$(( $(rent $((LEN + 37))) + FEE_MARGIN )) # the buffer, refunded once the upgrade lands
else
  what="first deploy"
  need=$(( $(rent $((LEN + 45))) + $(rent 36) + FEE_MARGIN )) # ProgramData + program account
fi
have=$(solana balance "$DEPLOYER_ADDR" -u "$RPC" --lamports | awk '{print $1}')
sol() { awk -v l="$1" 'BEGIN{printf "%.9f", l/1e9}'; }
echo "$what of $PROGRAM_ID ($LEN bytes, SHA-256 $sha) by $DEPLOYER_ADDR"
echo "needs $(sol "$need") SOL, the deployer has $(sol "$have") SOL"
if [ "$have" -lt "$need" ]; then
  echo "not enough SOL: send at least $(sol $((need - have))) devnet SOL to $DEPLOYER_ADDR, then run this again"
  exit 2
fi

[ -f "$BUFFER_KP" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$BUFFER_KP" >/dev/null
echo "buffer $(solana address -k "$BUFFER_KP")"
LOG=$KEYS/launchpad-deploy-$(date -u +%Y%m%dT%H%M%SZ).log
if solana program deploy "$SO" --program-id "$PROGRAM_KP" --buffer "$BUFFER_KP" -k "$DEPLOYER" -u "$RPC" \
     --use-rpc --max-len "$LEN" >"$LOG" 2>&1; then
  grep -E '^(Program Id|Signature):' "$LOG" || true
  solana program show "$PROGRAM_ID" -u "$RPC"
  echo "deployer balance after: $(solana balance "$DEPLOYER_ADDR" -u "$RPC")"
else
  echo "deploy failed; its output is kept in $LOG (never share that file: it may hold a recovery phrase)."
  grep -E '^Error:' "$LOG" | head -3 || true
  echo "Run this script again to resume into the same buffer, or recover the buffer's SOL with:"
  echo "  solana program close $(solana address -k "$BUFFER_KP") -k <deployer keypair path> -u devnet"
  exit 1
fi
