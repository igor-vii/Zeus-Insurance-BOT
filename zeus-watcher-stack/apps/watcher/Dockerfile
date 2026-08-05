FROM node:20-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared ./packages/shared
COPY prisma ./prisma
RUN pnpm install
COPY . .
RUN pnpm db:generate
RUN pnpm --filter @zeus/api build

FROM node:20-alpine
WORKDIR /app
RUN npm install -g pnpm
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
