#!/bin/bash
# R6 E2E runner — mirrors exactly what the CI workflow does.
# Usage: bash scripts/run-e2e.sh   (from repo root)
set -e
cd "$(dirname "$0")/.."

echo "== [1/4] start embedded-free prerequisite check: DATABASE_URL =="
: "${DATABASE_URL:?DATABASE_URL must be set}"

echo "== [2/4] boot Secretariat standalone =="
cd api-server
env DATABASE_URL="$DATABASE_URL" \
  SECRETARIAT_PORT=8080 \
  RATE_LIMIT_MAX=10000 \
  ZEUS_SIGNER_MODE=custodial_test \
  ZEUS_SIGNER_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" \
  ZEUS_RPC_PROVIDERS='[{"providerId":"mock-a","underlyingProvider":"provider-a","rpcUrl":"http://127.0.0.1:9977/rpc","maxStalenessBlocks":10},{"providerId":"mock-b","underlyingProvider":"provider-b","rpcUrl":"http://127.0.0.1:9977/rpc","maxStalenessBlocks":10}]' \
  ZEUS_FACILITATOR_URL="http://127.0.0.1:9977/facilitator" \
  ZEUS_SELLER_URL="http://127.0.0.1:9977/seller" \
  node --enable-source-maps ./dist/secretariat-index.mjs > /tmp/secretariat-e2e-boot.log 2>&1 &
SRV_PID=$!
trap 'kill $SRV_PID 2>/dev/null || true' EXIT

echo "== [3/4] wait for :8080/health =="
up=0
for i in $(seq 1 40); do
  if curl -s -m 1 http://127.0.0.1:8080/health | grep -q '"ok"'; then up=1; break; fi
  sleep 0.5
done
if [ "$up" != "1" ]; then echo "SECRETARIAT FAILED TO BOOT:"; tail -30 /tmp/secretariat-e2e-boot.log; exit 1; fi
echo "secretariat up (pid $SRV_PID)"

echo "== [4/4] run adversarial E2E (17 scenarios + PG assertions) =="
DATABASE_URL="$DATABASE_URL" node e2e/r6-argus-e2e.mjs
