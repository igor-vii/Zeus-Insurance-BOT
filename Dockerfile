FROM node:20-slim
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @zeus/sdk build
# F-115/H-11 (external audit 2026-10-26): the api-server bundle externalizes
# zeus-secretariat and @workspace/db — their dist must exist at runtime.
RUN pnpm --filter @workspace/db run build
RUN pnpm --filter zeus-secretariat run build
RUN pnpm --filter @workspace/api-server build
RUN ls -la /app/api-server/dist/ && echo "BUILD OK"
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--enable-source-maps", "api-server/dist/index.mjs"]
