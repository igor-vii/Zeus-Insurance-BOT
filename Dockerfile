FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS build
WORKDIR /app
COPY . .
RUN pnpm install --no-frozen-lockfile && pnpm -r build

FROM base AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/api-server/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/api-server/package.json ./package.json
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
