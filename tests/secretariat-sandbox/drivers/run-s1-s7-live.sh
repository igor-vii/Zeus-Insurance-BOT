#!/bin/bash
# run-s1-s7-live.sh — LIVE Argus S1–S8 matrix against the real Secretariat /v1
# boundary with PostgreSQL observation asserts. This is the "next stage" that
# evidence/secretariat-test/argus/README.md left pending: the old pre-flight
# (2026-10-08) ran the same scenario registry against the MOCK target; here
# the Secretariat process is the SUT.
#
# Usage: bash tests/secretariat-sandbox/drivers/run-s1-s7-live.sh
# Requires: DATABASE_URL pointing at a migrated zeus DB, argus lab installed
# (tests/argus/node_modules), Secretariat bundle built
# (api-server/dist/secretariat-index.mjs), mock argus deps (viem) resolvable
# from the repo root.
set -u
cd "$(dirname "$0")/../../.."   # repo root

REPO=$(pwd)
ARGUS_DIR="$REPO/tests/argus"
OUT="$REPO/evidence/secretariat-test/argus-live"
TMP=/tmp/argus-live
mkdir -p "$OUT" "$TMP"

CLIENT_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # hardhat #0, public test key
DATABASE_URL="${DATABASE_URL:?DATABASE_URL must be set}"
ARGUS_MOCK="http://127.0.0.1:9977"
RUN_STAMP="$(date +%s)"   # namespaces clientIds per run (non-destructive evidence)

log() { echo "[s1-s7-live] $*"; }

# fail fast if the database is not reachable (Secretariat boots into PG)
DATABASE_URL="$DATABASE_URL" node -e "const{createRequire}=require('module');const pg=createRequire('$REPO/lib/db/package.json')('pg');const p=new pg.Pool({connectionString:process.env.DATABASE_URL});p.query('SELECT 1').then(()=>{console.log('[s1-s7-live] PG reachable');return p.end()}).catch(e=>{console.error('[s1-s7-live] PG UNREACHABLE:',e.message);process.exit(1)})"

# ---------------------------------------------------------------------------
# [1/6] boot mock Argus (adversarial resource server + facilitator + RPC)
# ---------------------------------------------------------------------------
node tests/secretariat-sandbox/drivers/argus-live-mock.mjs > "$TMP/mock.log" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID $SRV_PID 2>/dev/null || true' EXIT
for i in $(seq 1 20); do curl -s -m 1 "$ARGUS_MOCK/health" | grep -q '"ok"' && break; sleep 0.5; done
log "mock argus up (pid $MOCK_PID)"

# ---------------------------------------------------------------------------
# [2/6] boot Secretariat standalone (the SUT)
# ---------------------------------------------------------------------------
SRV_PID=0
boot_secretariat() {
  cd "$REPO/api-server"
  env DATABASE_URL="$DATABASE_URL" \
    SECRETARIAT_PORT=8080 \
    RATE_LIMIT_MAX=10000 \
    ZEUS_SIGNER_MODE=custodial_test \
    ZEUS_SIGNER_PRIVATE_KEY="$CLIENT_KEY" \
    ZEUS_RPC_PROVIDERS='[{"providerId":"mock-a","underlyingProvider":"provider-a","rpcUrl":"http://127.0.0.1:9977/rpc","maxStalenessBlocks":10},{"providerId":"mock-b","underlyingProvider":"provider-b","rpcUrl":"http://127.0.0.1:9977/rpc","maxStalenessBlocks":10}]' \
    ZEUS_FACILITATOR_URL="$ARGUS_MOCK/facilitator" \
    ZEUS_SELLER_URL="$ARGUS_MOCK/seller" \
    ZEUS_SELLER_TIMEOUT_MS=6000 \
    node --enable-source-maps ./dist/secretariat-index.mjs >> "$TMP/secretariat.log" 2>&1 &
  SRV_PID=$!
  cd "$REPO"
  for i in $(seq 1 40); do
    curl -s -m 1 http://127.0.0.1:8080/health | grep -q '"ok"' && return 0
    sleep 0.5
  done
  log "SECRETARIAT FAILED TO BOOT:"; tail -20 "$TMP/secretariat.log"; exit 1
}
boot_secretariat
log "secretariat up (pid $SRV_PID)"

# ---------------------------------------------------------------------------
# [3/6] run the matrix S1..S8 (S9 is inbound seller-side, out of scope here)
# ---------------------------------------------------------------------------
run_scenario() {
  local S="$1"; local crash="$2"; local deadline="$3"
  ( cd "$ARGUS_DIR" && env \
      ARGUS_TARGET_KIND=secretariat \
      ARGUS_TARGET_ENDPOINT=http://127.0.0.1:8080 \
      SECRETARIAT_URL=http://127.0.0.1:8080 \
      SECRETARIAT_RESOURCE_URL="$ARGUS_MOCK/resource" \
      SECRETARIAT_CLIENT_KEY="$CLIENT_KEY" \
      ARGUS_LIVE_SCENARIO="$S" \
      ARGUS_LIVE_RUN_STAMP="$RUN_STAMP" \
      ARGUS_LIVE_CRASH="$crash" \
      ARGUS_LIVE_POLL_DEADLINE_MS="$deadline" \
      SECRETARIAT_ENABLE_402_RESOLVER=1 \
      SECRETARIAT_402_SPLIT=1 \
      ARGUS_DUMP_EVIDENCE=1 \
      timeout ${SCENARIO_TIMEOUT:-40} npx tsx src/cli/argus.ts run "$S" ) > "$TMP/$S.log" 2>&1
  echo $?
}

settle_wait() { # wait until mock facilitator sees >= $1 total settle calls
  local target="$1"
  for i in $(seq 1 60); do
    local n
    n=$(curl -s -m 1 "$ARGUS_MOCK/facilitator/stats" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).totalSettleCalls)}catch{console.log(0)}})")
    [ "${n:-0}" -ge "$target" ] && return 0
    sleep 0.5
  done
  return 1
}

: > "$TMP/matrix.txt"
current_settles() {
  curl -s -m 2 "$ARGUS_MOCK/facilitator/stats" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).totalSettleCalls)}catch{console.log(0)}})"
}

for S in S1 S2 S3 S4 S5 S6 S7 S8; do
  log "scenario $S starting"
  SCENARIO_TIMEOUT=40
  case "$S" in
    S3) crash=1; deadline=45000; SCENARIO_TIMEOUT=60 ;;
    # S8 now runs the FULL x402 split: Stage A (PAYMENT_REQUIRED) -> signed
    # retry (EIP-3009 over the persisted intent) -> Stage B -> poll terminal.
    S8) crash=0; deadline=45000; SCENARIO_TIMEOUT=55 ;;
    # S4's own hang fault (duration_ms=-1) never terminates by design —
    # B4 inventory: "canonical infinite hang is non-terminating". The runner
    # kills the scenario after the adapter's work is done and lets the PG
    # trail (attempts/jobs/final state) carry the S4 verdict.
    S4) crash=0; deadline=30000; SCENARIO_TIMEOUT=35 ;;
    S6) crash=0; deadline=20000 ;;
    *)  crash=0; deadline=20000 ;;
  esac

  # Seller fault modes are selected out-of-band (the Secretariat forwards an
  # empty body to the seller — see argus-live-mock.mjs /__control).
  # S3 deliberately hangs the seller so the crash lands MID-DELIVERY: the
  # restart must then resume via the PENDING EXECUTION recovery job.
  case "$S" in
    S3) mode="S4" ;;
    S4) mode="S4" ;;
    S7) mode="S7" ;;
    *)  mode="honest" ;;
  esac
  curl -s -X POST "$ARGUS_MOCK/__control" -H 'content-type: application/json' -d "{\"mode\":\"$mode\"}" > /dev/null

  if [ "$crash" = "1" ]; then
    # S3: crash the Secretariat AFTER THIS scenario's settlement (trigger =
    # payment_settled). The baseline is captured RIGHT HERE — the settle count
    # from S1/S2 must not satisfy the wait (that bug killed the SUT before the
    # S3 adapter had even connected).
    ( run_scenario "$S" "$crash" "$deadline" > "$TMP/$S.exit" ) &
    ARG_PID=$!
    BASE_SETTLES=$(current_settles)
    target=$((BASE_SETTLES + 1))
    if settle_wait "$target"; then
      log "$S: settlement observed — crashing Secretariat mid-delivery (kill $SRV_PID)"
      kill "$SRV_PID" 2>/dev/null
      # The seller hangs no more: after the restart the recovery worker must
      # re-drive the pending EXECUTION job against an honest seller.
      curl -s -X POST "$ARGUS_MOCK/__control" -H 'content-type: application/json' -d '{"mode":"honest"}' > /dev/null
      sleep 2
      boot_secretariat
      log "$S: secretariat restarted (pid $SRV_PID)"
    else
      log "$S: settlement never observed — crash step skipped"
    fi
    wait "$ARG_PID" || true
  else
    S6_LOGICAL=""
    if [ "$S" = "S6" ]; then
      # S6 models the adversarial buyer retrying the SAME logical request with
      # fresh authorizations — pin all three actions to one logical op.
      S6_LOGICAL="ARGUS_LIVE_LOGICAL_KEY=req-6"
    fi
    code=$( cd "$ARGUS_DIR" && env \
      ARGUS_TARGET_KIND=secretariat \
      ARGUS_TARGET_ENDPOINT=http://127.0.0.1:8080 \
      SECRETARIAT_URL=http://127.0.0.1:8080 \
      SECRETARIAT_RESOURCE_URL="$ARGUS_MOCK/resource" \
      SECRETARIAT_CLIENT_KEY="$CLIENT_KEY" \
      ARGUS_LIVE_SCENARIO="$S" \
      ARGUS_LIVE_RUN_STAMP="$RUN_STAMP" \
      ARGUS_LIVE_POLL_DEADLINE_MS="$deadline" \
      SECRETARIAT_ENABLE_402_RESOLVER=1 \
      SECRETARIAT_402_SPLIT=1 \
      ARGUS_DUMP_EVIDENCE=1 \
      $S6_LOGICAL \
      timeout ${SCENARIO_TIMEOUT:-40} npx tsx src/cli/argus.ts run "$S" > "$TMP/$S.log" 2>&1; echo $? )
    echo "$code" > "$TMP/$S.exit"
  fi

  verdict=$(grep -E '^\s+Result:' "$TMP/$S.log" | tail -1 | sed 's/.*Result: //')
  reason=$(grep -E '^\s+Reason:' "$TMP/$S.log" | tail -1 | sed 's/.*Reason: //')
  echo "$S|exit=$(cat "$TMP/$S.exit")|verdict=${verdict:-NONE}|reason=${reason:-}" >> "$TMP/matrix.txt"
  log "$S done: verdict=${verdict:-NONE} ${reason:+($reason)}"
done

# ---------------------------------------------------------------------------
# [4/6] facilitator double-spend probe + seller stats
# ---------------------------------------------------------------------------
curl -s "$ARGUS_MOCK/facilitator/stats" > "$TMP/facilitator-stats.json"
DOUBLE=$(node -e "const s=require('$TMP/facilitator-stats.json');console.log(s.doubleSettleAttempts)")
log "facilitator: $(node -e "const s=require('$TMP/facilitator-stats.json');console.log('totalSettleCalls='+s.totalSettleCalls,'distinctNonces='+s.distinctNonces,'doubleSettleAttempts='+s.doubleSettleAttempts,JSON.stringify(s.sellerStats))")"

# ---------------------------------------------------------------------------
# [5/6] PostgreSQL observation asserts (per scenario)
# ---------------------------------------------------------------------------
DATABASE_URL="$DATABASE_URL" SCENARIO_CLIENT_PREFIX="argus-live-$RUN_STAMP-" node --input-type=module <<'PGEOF'
import { createRequire } from "node:module";
import fs from "node:fs";
const pg = createRequire("/home/z/my-project/audit-repo/lib/db/package.json")("pg");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prefix = process.env.SCENARIO_CLIENT_PREFIX;
const out = {};

const q = async (sql, params) => (await pool.query(sql, params)).rows;

for (const S of ["S1","S2","S3","S4","S5","S6","S7","S8"]) {
  const r = { intents: 0, states: [], observations: [], attempts: [], recoveryJobs: 0 };
  // payment intents created for this scenario's logical requests
  const intents = await q(
    `SELECT payment_intent_id, request_id, client_id, settlement_state, tx_hash, nonce, value,
            reconciliation_observations
     FROM payment_intents WHERE client_id LIKE $1 ORDER BY payment_intent_id`, [`${prefix}${S}-%`]);
  r.intents = intents.length;
  r.states = intents.map(i => i.settlement_state);
  r.nonces = intents.map(i => i.nonce?.slice(0, 10));
  const obs = intents.flatMap(i => i.reconciliation_observations ?? []);
  r.observations = [...new Set(obs.map(o => o.event))];

  const opIds = intents.map(i => i.operation_id);
  if (opIds.length) {
    const att = await q(
      `SELECT attempt_number, status, error_reason, response_status_code
       FROM execution_attempts WHERE operation_id = ANY($1) ORDER BY attempt_number`, [opIds]);
    r.attempts = att.map(a => `#${a.attempt_number}:${a.status}${a.error_reason ? "(" + a.error_reason + ")" : ""}`);
    const jobs = await q(
      `SELECT status, count(*)::int AS n FROM recovery_jobs
       WHERE operation_id = ANY($1) GROUP BY status`, [opIds]);
    r.recoveryJobs = jobs.map(j => `${j.status}=${j.n}`).join(",") || "none";
  }
  out[S] = r;
}

// double-intent probe across the WHOLE run: any logical client with >1 intent row?
const dups = await q(
  `SELECT client_id, count(*)::int AS n FROM payment_intents
   WHERE client_id LIKE $1 GROUP BY client_id HAVING count(*) > 1`, [`${prefix}%`]);
out.DOUBLE_INTENT_CLIENTS = dups.map(d => `${d.client_id}=${d.n}`);

fs.writeFileSync("/tmp/argus-live/pg-observations.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await pool.end();
PGEOF

# ---------------------------------------------------------------------------
# [6/6] final matrix
# ---------------------------------------------------------------------------
echo ""
echo "===== ARGUS S1-S7 LIVE vs SECRETARIAT /v1 — VERDICT MATRIX ====="
cat "$TMP/matrix.txt"
echo ""
echo "double-settle attempts at facilitator: $DOUBLE (must be 0)"
cp "$TMP"/S*.log "$OUT/" 2>/dev/null
cp "$TMP/matrix.txt" "$OUT/matrix.txt"
cp "$TMP/facilitator-stats.json" "$OUT/facilitator-stats.json"
cp "$TMP/pg-observations.json" "$OUT/pg-observations.json" 2>/dev/null
log "evidence written to $OUT"
