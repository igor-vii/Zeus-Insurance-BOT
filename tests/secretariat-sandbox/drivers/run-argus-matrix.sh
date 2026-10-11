#!/bin/bash
# Argus scenario matrix runner for the Secretariat clean external-client test.
# Runs all registered Argus scenarios (S1..S9) against the sandbox and captures
# raw logs + verdicts. Does NOT modify Argus core.
set -u
OUT=/tmp/argus-matrix
mkdir -p $OUT
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80  # hardhat account #0, public test key, no funds
export ARGUS_TEST_WALLET_PRIVATE_KEY=$KEY
for s in S1 S2 S3 S4 S5 S6 S7 S8 S9; do
  timeout 120 npx tsx src/cli/argus.ts run $s > $OUT/$s.log 2>&1
  code=$?
  verdict=$(grep -E '^\s+Result:' $OUT/$s.log | tail -1 | sed 's/.*Result: //')
  reason=$(grep -E '^\s+Reason:' $OUT/$s.log | tail -1 | sed 's/.*Reason: //')
  echo "$s|exit=$code|verdict=${verdict:-NONE}|reason=${reason:-}" >> $OUT/matrix.txt
done
cat $OUT/matrix.txt
