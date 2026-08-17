FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS build
WORKDIR /app
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @zeus/sdk build
RUN pnpm --filter @workspace/api-server build
RUN echo "=== api-server/dist ===" && ls -la /app/api-server/dist/ || echo "dist NOT FOUND"
RUN echo "=== api-server root ===" && ls -la /app/api-server/

FROM base AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/api-server/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/api-server/package.json ./package.json
RUN echo "=== production dist ===" && ls -la /app/dist/ || echo "NO DIST IN PRODUCTION"
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
