#!/usr/bin/env bash
# Full matrix: 3 clients x S0..S5 through Secretariat /v1/requests only.
set -u
cd /workspace/tests/secretariat-sandbox
EVID=/workspace/evidence/secretariat-test
LOG=$EVID/secretariat/logs.txt
for client in ClawRouter Franklin BlockRun; do
  for s in S0 S1 S2 S3 S4 S5; do
    echo "=== RUN $client $s $(date -u +%FT%TZ) ===" >> "$LOG"
    node drivers/client-driver.mjs "$client" "$s" 2>&1 | tee -a "$LOG"
  done
done
echo "=== POLICYID-LESS PROOF RUN (ClawRouter S0, no policyId — default) already covered; explicit with-policyId probe: ===" >> "$LOG"
node drivers/client-driver.mjs ClawRouter S0 --with-policy-id 2>&1 | tee -a "$LOG"
