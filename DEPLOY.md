# Zeus Insurance BOT — Deployment Guide

This document describes how to deploy Zeus Insurance BOT after the security audit fixes.

## Recent Changes (Security Audit Fixes)

All changes have been applied and pushed to main branch:

1. watcherList swap-and-pop (contracts/src/ZeusInsuranceV2.sol)
   - Prevents unbounded array growth when removing watchers
   - Saves gas on getWatchers() calls

2. Strict CORS (api-server/src/app.ts)
   - Added production frontend URL to allowed origins
   - Removed wildcard domain allowance for security

3. JWT Authentication (api-server/src/routes/insurance.ts)
   - Replaced static ADMIN_SECRET with JWT tokens
   - More secure and supports token expiration

4. Dependencies (api-server/package.json)
   - Added jsonwebtoken
   - Added types for jsonwebtoken

---

## Deployment Steps

### 1. Railway (Backend: API Server + Watcher + Database)

#### Environment Variables

Make sure these variables are set in your Railway service:

Required:
- DATABASE_URL - PostgreSQL connection string
- PORT=3000
- NODE_ENV=production
- SERVER_PRIVATE_KEY - Private key for automatic mode
- ZEUS_INSURANCE_NETWORK - bot-chain or x-layer
- BOT_CHAIN_MAINNET_RPC_URL
- XLAYER_MAINNET_RPC_URL
- ADMIN_JWT_SECRET - NEW: generate a strong 32+ char secret
- CORS_ORIGINS - https://zeus-insurance-frontend.onrender.com

Generate ADMIN_JWT_SECRET:
  openssl rand -hex 32

#### Build and Deploy

Railway will automatically:
1. Run: pnpm install and cd api-server and node ./build.mjs
2. Start: node --enable-source-maps api-server/dist/index.mjs
3. Healthcheck: /health

Wait for deployment to complete and check logs for errors.

---

### 2. Render (Frontend: Static Site)

#### Environment Variables

Set these in your Render static site:

- VITE_API_BASE_URL=https://zeus-insurance-bot-api-production.up.railway.app/api
- NODE_VERSION=20

Build command (already configured in render.yaml):
- pnpm install --no-frozen-lockfile --prefer-offline --filter @workspace/frontend...
- pnpm --filter @zeus/sdk build
- pnpm --filter @workspace/frontend build

Publish path: frontend/dist

Render will automatically deploy on every push to main.

---

### 3. Smart Contracts

IMPORTANT: The smart contract ZeusInsuranceV2.sol has been updated, but the on-chain contract has NOT been redeployed.

If you need to deploy the updated contract:
  cd contracts
  pnpm compile
  pnpm deploy:bot-chain-mainnet
  # or
  pnpm deploy:x-layer-mainnet

After deployment, update the contract addresses in:
- api-server/src/lib/contracts-server.ts
- frontend/src/config/contracts.ts
- README.md (Contract Addresses section)

---

## Admin JWT Token Generation

After deployment, generate an admin JWT token:

  cd api-server
  ADMIN_JWT_SECRET="your-secret" npx tsx scripts/generate-admin-jwt.ts

This will output a JWT token. Use it in API requests:

  curl -X POST https://your-api.up.railway.app/api/admin/reset-agent \
    -H "Authorization: Bearer YOUR_JWT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"agent": "0x..."}'

Token expires in 30 days. Generate a new one before expiration.

---

## Verification Checklist

After deployment, verify:

- Railway API responds to GET /health with status ok
- Frontend loads correctly on Render URL
- CORS allows requests from frontend to API
- JWT authentication works for /admin/reset-agent
- All existing API endpoints still work
- Check Railway logs for any errors or warnings

---

## Troubleshooting

Railway deployment fails:
1. Check build logs for TypeScript errors
2. Verify all environment variables are set
3. Ensure ADMIN_JWT_SECRET is set (required for admin endpoints)
4. Check that DATABASE_URL is valid

Frontend cant connect to API:
1. Verify VITE_API_BASE_URL is set correctly
2. Check browser console for CORS errors
3. Verify API is accessible at the URL
4. Check Railway service is running

JWT token rejected:
1. Ensure token is not expired (30 days)
2. Verify ADMIN_JWT_SECRET matches the secret used to generate the token
3. Check token format: Bearer token in Authorization header

---

## Support

For issues or questions:
- GitHub: @igor-vii
- Telegram: @IvanovVII
- Email: zeusinsurance@mail.ru

---

Last updated: 2026-08-08 (Security Audit v1.0)
