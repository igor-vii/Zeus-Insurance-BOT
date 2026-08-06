# Build context: zeus-watcher-stack/ (monorepo root)
FROM node:20-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm

# Copy workspace manifests for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/watcher/package.json ./apps/watcher/
COPY packages/shared/package.json ./packages/shared/

# 🔧 ИСПРАВЛЕНО: добавлен --no-frozen-lockfile
RUN pnpm install --no-frozen-lockfile

# Copy source
COPY packages/shared ./packages/shared
COPY apps/watcher ./apps/watcher

# Build shared first, then watcher
RUN pnpm --filter @zeus/shared build
RUN pnpm --filter @zeus/watcher build

# ── Production image ─────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/apps/watcher/dist ./apps/watcher/dist
COPY --from=builder /app/apps/watcher/package.json ./apps/watcher/package.json
COPY --from=builder /app/apps/watcher/node_modules ./apps/watcher/node_modules

WORKDIR /app/apps/watcher
CMD ["node", "dist/index.js"]
