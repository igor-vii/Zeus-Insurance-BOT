FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY api-server/package.json api-server/package.json
COPY sdk/package.json sdk/package.json
COPY frontend/package.json frontend/package.json
COPY lib/api-zod/package.json lib/api-zod/package.json
COPY lib/db/package.json lib/db/package.json
COPY lib/api-spec/package.json lib/api-spec/package.json
COPY lib/api-client-react/package.json lib/api-client-react/package.json
COPY sdk/tsconfig.json sdk/tsconfig.json
COPY tsconfig.base.json tsconfig.base.json
RUN pnpm install --no-frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm -r build

FROM base AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/api-server/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/api-server/package.json ./package.json
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
