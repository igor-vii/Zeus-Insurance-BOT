#!/bin/bash
# Apply the audited canonical migration set to a fresh database.
#
#   DATABASE_URL="postgres://user@host:5432/db" bash scripts/apply-migrations.sh
#
# Applies, in order:
#   lib/db/drizzle/0000_init.sql
#   lib/db/drizzle/migrations/0005..0010
#
# 0004_partitioning.sql is intentionally NOT applied: it is optional
# partitioning, and the audited baseline (R0-R6 verification) was built
# without it. Add it explicitly if/when partitioning becomes required.
#
# Requires psql on PATH. Idempotent-ish: safe on a fresh database, which is
# its intended use (CI service container, local bootstrap).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL must be set}"

FILES=(
  lib/db/drizzle/0000_init.sql
  lib/db/drizzle/migrations/0005_secretariat_tables.sql
  lib/db/drizzle/migrations/0006_client_request_unique.sql
  lib/db/drizzle/migrations/0007_reconciliation_job_active_unique.sql
  lib/db/drizzle/migrations/0008_c1_operation_semantics.sql
  lib/db/drizzle/migrations/0009_pre_intent_evidence.sql
  lib/db/drizzle/migrations/0010_payment_intent_extra_fields.sql
)

for f in "${FILES[@]}"; do
  echo "[migrate] $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "[migrate] done: $(psql "$DATABASE_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'") public tables"
