#!/usr/bin/env bash
# Bootstrap script — run once after cloning or importing to Replit.
# Installs all workspace dependencies and applies the database schema.
set -euo pipefail

echo "==> Installing workspace dependencies..."
pnpm install

echo "==> Applying database schema (drizzle push)..."
pnpm --filter @workspace/db push

echo ""
echo "Setup complete. Use the Run button (or the Frontend / API Server workflows) to start the app."
