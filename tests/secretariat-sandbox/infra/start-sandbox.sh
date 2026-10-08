#!/usr/bin/env bash
# Start the isolated Secretariat external-client test sandbox:
# 2x RPC mocks, facilitator mock, controlled resource server, and the SUT
# (standalone Secretariat API on /v1 only) against secretariat_test_db.
set -eu
EVID=/workspace/evidence/secretariat-test
LOGS=$EVID/secretariat
mkdir -p "$LOGS"
TOPIC=0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5 # keccak("AuthorizationUsed(address,bytes32)")

kill_sandbox() {
  pkill -f "rpc-mock.mjs" 2>/dev/null || true
  pkill -f "facilitator-mock.mjs" 2>/dev/null || true
  pkill -f "controlled-resource-server.mjs" 2>/dev/null || true
  pkill -f "secretariat-index.ts" 2>/dev/null || true
  sleep 1
}
kill_sandbox

cd /workspace/tests/secretariat-sandbox
AUTHZ_USED_TOPIC=$TOPIC node infra/rpc-mock.mjs 18545 >> "$LOGS/rpc-mock-a.log" 2>&1 &
echo $! > /tmp/sbx-rpcA.pid
AUTHZ_USED_TOPIC=$TOPIC node infra/rpc-mock.mjs 18546 >> "$LOGS/rpc-mock-b.log" 2>&1 &
echo $! > /tmp/sbx-rpcB.pid
RPC_MOCK_URLS="http://127.0.0.1:18545,http://127.0.0.1:18546" node infra/facilitator-mock.mjs 18500 >> "$LOGS/facilitator-mock.log" 2>&1 &
echo $! > /tmp/sbx-fac.pid
node infra/controlled-resource-server.mjs 18700 >> "$LOGS/controlled-resource-server.log" 2>&1 &
echo $! > /tmp/sbx-crs.pid

for p in 18545 18546 18500 18700; do
  for i in $(seq 1 20); do
    curl -s -m 1 "http://127.0.0.1:$p/_state" >/dev/null 2>&1 && break
    curl -s -m 1 "http://127.0.0.1:$p/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
done

cd /workspace/api-server
export DATABASE_URL="postgresql://secretariat_test:sbx_test_pw_2026@127.0.0.1:5432/secretariat_test_db"
export SECRETARIAT_PORT=18791
export ZEUS_RPC_PROVIDERS='[{"providerId":"mockA","underlyingProvider":"mockA","rpcUrl":"http://127.0.0.1:18545","maxStalenessBlocks":50},{"providerId":"mockB","underlyingProvider":"mockB","rpcUrl":"http://127.0.0.1:18546","maxStalenessBlocks":50}]'
export ZEUS_FACILITATOR_URL="http://127.0.0.1:18500"
export ZEUS_SELLER_URL="http://127.0.0.1:18700/execute"
export ZEUS_SELLER_TIMEOUT_MS=4000
export ZEUS_RECON_POLL_MS=1500
export ZEUS_SIGNER_MODE=custodial_test
export ZEUS_SIGNER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945d7186280032909be093da20fbccc4f0a111
# Sandbox SUT entry: production composition + /v1 router UNCHANGED, plus a
# test-only X-Test-Authorizer injection middleware (finding F-Z3 workaround).
npx tsx /workspace/tests/secretariat-sandbox/infra/sut-test-entry.ts >> "$LOGS/logs.txt" 2>&1 &
echo $! > /tmp/sbx-sut.pid
for i in $(seq 1 60); do
  curl -s -m 1 http://127.0.0.1:18791/healthz >/dev/null 2>&1 && { echo "SUT UP on :18791"; exit 0; }
  sleep 1
done
echo "SUT FAILED TO START"; tail -40 "$LOGS/logs.txt"; exit 1
