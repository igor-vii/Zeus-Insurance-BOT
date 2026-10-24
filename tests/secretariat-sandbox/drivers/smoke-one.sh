#!/bin/bash
# Smoke one scenario with full evidence dump (mock + secretariat managed here).
set -u
cd /home/z/my-project/audit-repo
# NOTE: the sandbox shell may export a foreign DATABASE_URL (e.g. sqlite) —
# this driver REQUIRES the embedded zeus PG, so hard-require it explicitly.
: "${DATABASE_URL:?pass the embedded PG URL, e.g. postgres://zeus@127.0.0.1:5433/zeus}"
case "$DATABASE_URL" in
  postgres://*) : ;;
  *) echo "[smoke] refusing non-postgres DATABASE_URL: $DATABASE_URL"; exit 1 ;;
esac
S="${1:-S3}"
STAMP="${2:-smoke}"
KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

node tests/secretariat-sandbox/drivers/argus-live-mock.mjs > /tmp/argus-live/smoke-mock.log 2>&1 &
MOCK_PID=$!
cd api-server
env DATABASE_URL="$DATABASE_URL" SECRETARIAT_PORT=8080 RATE_LIMIT_MAX=10000 \
  ZEUS_SIGNER_MODE=custodial_test ZEUS_SIGNER_PRIVATE_KEY="$KEY" \
  ZEUS_RPC_PROVIDERS='[{"providerId":"mock-a","underlyingProvider":"provider-a","rpcUrl":"http://127.0.0.1:9977/rpc","maxStalenessBlocks":10},{"providerId":"mock-b","underlyingProvider":"provider-b","rpcUrl":"http://127.0.0.1:9977/rpc","maxStalenessBlocks":10}]' \
  ZEUS_FACILITATOR_URL="http://127.0.0.1:9977/facilitator" \
  ZEUS_SELLER_URL="http://127.0.0.1:9977/seller" ZEUS_SELLER_TIMEOUT_MS=6000 \
  node --enable-source-maps ./dist/secretariat-index.mjs > /tmp/argus-live/smoke-srv.log 2>&1 &
SRV_PID=$!
cd ..
trap 'kill $MOCK_PID $SRV_PID 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -s -m 1 http://127.0.0.1:8080/health | grep -q '"ok"' && break; sleep 0.5; done
for i in $(seq 1 20); do curl -s -m 1 http://127.0.0.1:9977/health | grep -q '"ok"' && break; sleep 0.5; done
echo "[smoke] services up, running $S"
if [ -n "${SMOKE_MODE:-}" ]; then
  curl -s -X POST http://127.0.0.1:9977/__control -H 'content-type: application/json' -d "{\"mode\":\"$SMOKE_MODE\"}" > /dev/null
  echo "[smoke] seller mode forced: $SMOKE_MODE"
fi

cd tests/argus
env ARGUS_TARGET_KIND=secretariat ARGUS_TARGET_ENDPOINT=http://127.0.0.1:8080 \
  SECRETARIAT_URL=http://127.0.0.1:8080 SECRETARIAT_RESOURCE_URL=http://127.0.0.1:9977/resource \
  SECRETARIAT_CLIENT_KEY="$KEY" ARGUS_LIVE_SCENARIO="$S" ARGUS_LIVE_RUN_STAMP="$STAMP" \
  ARGUS_LIVE_POLL_DEADLINE_MS=25000 ARGUS_DUMP_EVIDENCE=1 \
  npx tsx src/cli/argus.ts run "$S"
echo "[smoke] exit=$?"
