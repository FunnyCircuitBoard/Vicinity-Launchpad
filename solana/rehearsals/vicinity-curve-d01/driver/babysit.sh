#!/bin/bash
# Keeps the local D01 validator's ledger inside the disk: every 5 minutes, when the ledger passes 1.5 GB, restart the
# validator on the same ledger (state and clock carry on; the restart flushes rocksdb's write-ahead logs). Stops
# restarting after STOP_AT (UTC, epoch seconds) so that nothing restarts during the batch-launch steps.
export PATH=/root/.local/share/solana/install/releases/stable-44b42d45ec7e555b26ca15ad924a7432d18aaa9f/solana-release/bin:$PATH
T=/tmp/claude-0/-home-user-Vicinity-Launchpad/259e7af3-62d7-56de-8406-76246b95043c/scratchpad/d01-tools
LOG=$T/babysit.log
STOP_AT=${STOP_AT:?}
while [ "$(date +%s)" -lt "$STOP_AT" ]; do
  MB=$(du -sm $T/ledger | cut -f1)
  if [ "$MB" -gt 1500 ]; then
    echo "$(date -u +%FT%TZ) ledger ${MB} MB: restarting" >> $LOG
    P=$(pgrep -f 'solana-test-validator --ledger' | while read p; do [ "$(cat /proc/$p/comm)" = "solana-test-val" ] && echo $p; done | head -1)
    [ -z "$P" ] && P=$(pgrep -x solana-test-val | head -1)
    kill -TERM $P 2>/dev/null
    for i in $(seq 1 120); do kill -0 $P 2>/dev/null || break; sleep 1; done
    RUST_LOG=warn setsid nohup solana-test-validator --ledger $T/ledger --rpc-port 8899 --faucet-sol 1000000 --limit-ledger-size 100000 >> $T/validator-restarts.out 2>&1 < /dev/null &
    for i in $(seq 1 120); do curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' http://127.0.0.1:8899 | grep -q result && break; sleep 1; done
    echo "$(date -u +%FT%TZ) restarted; ledger $(du -sm $T/ledger | cut -f1) MB" >> $LOG
  fi
  sleep 300
done
echo "$(date -u +%FT%TZ) babysitter done" >> $LOG
