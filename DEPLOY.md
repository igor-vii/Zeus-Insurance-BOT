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
- SERVER_PRIVATE_KEY - Private key for the LEGACY on-chain automatic mode of
  the escrow/insurance services (services/escrow.ts, services/insurance.ts).
  This is NOT the Secretariat signer — see below.
- ZEUS_INSURANCE_NETWORK - bot-chain or x-layer
- BOT_CHAIN_MAINNET_RPC_URL
- XLAYER_MAINNET_RPC_URL
- ADMIN_JWT_SECRET - NEW: generate a strong 32+ char secret
- CORS_ORIGINS - https://zeus-insurance-bot-frontend.vercel.app

Secretariat signer (F-116/M-16, external audit 2026-10-26 — the two keys
must never be confused; they authorize DIFFERENT wallets):
- ZEUS_SIGNER_MODE - non_custodial (production default; the client signs
  externally) or custodial_test (TEST-ONLY EOA hot key — hard-refused by the
  config loader when NODE_ENV=production).
- ZEUS_SIGNER_PRIVATE_KEY - the key env var read when custodial_test is
  explicitly enabled in a test environment. NEVER set a production-funded
  key here.
- ZEUS_EIP3009_DOMAIN_NAME / ZEUS_EIP3009_DOMAIN_VERSION - REQUIRED on
  production chains (eip155:196 / 8453 / 677): the EIP-712 domain the token
  contract enforces. For eip155:196 (X Layer) VERIFIED on-chain 2026-10-26:
  USDC 0x74b7F16337b8972027F6196A17a631aC6dE26d22 returns name()="USD Coin",
  version()="2" and its on-chain DOMAIN_SEPARATOR() matches the domain
  computed from these values — set ZEUS_EIP3009_DOMAIN_NAME="USD Coin",
  ZEUS_EIP3009_DOMAIN_VERSION="2" (see zeus-secretariat/docs/
  UNVERIFIED_ASSUMPTIONS.md row D1; 8453/677 still verify at deploy).
- ZEUS_RPC_PROVIDERS, ZEUS_FACILITATOR_URL, ZEUS_SELLER_URL - required by
  the standalone Secretariat boot (secretariat-index.mjs).

Generate ADMIN_JWT_SECRET:
  openssl rand -hex 32

#### Zeus Facilitator (own, D2) — two-facilitator architecture

The protocol runs TWO facilitators (user decision, 2026-10-26):

1. EXTERNAL FREE (library default, e.g. Coinbase CDP / x402.org) — free,
   zero infrastructure, used for base-sepolia dev/test. It does NOT support
   eip155:196 (X Layer) — that is why the second one exists.
2. ZEUS-OPERATED — shipped in this repo as the `zeus-facilitator` package.
   Canonical x402 v2 remote-facilitator contract, identical to the F-112
   mock enforcement:
     POST /verify {x402Version, paymentPayload, paymentRequirements}
       → 200 {isValid, payer} | {isValid:false, invalidReason}
     POST /settle same → 200 {success, transaction, transactionHash,
       network, payer} | 200 {success:false, errorReason} (definitive,
       pre-broadcast) | 409 duplicate | 503/504 ambiguous (client MUST go
       RECONCILING).
   Verification: exact scheme, pinned network/asset/domain (eip155:196 →
   USDC 0x74b7F16337b8972027F6196A17a631aC6dE26d22, domain "USD Coin"/"2",
   D1-verified on-chain), EIP-712 recovery == authorization.from, time
   window, on-chain authorizationState(nonce unused), payer balance.
   Settlement: gas payer broadcasts transferWithAuthorization (EIP-1559),
   waits for the receipt; per-nonce guard prevents double broadcast.

Deploy as a separate Railway service (root dir `zeus-facilitator`):
  Build:  pnpm install && pnpm --filter zeus-facilitator run build
  Start:  node zeus-facilitator/dist/server.js
  Health: GET /health → {ok, network, testnet, payer}
Required env:
  ZEUS_FACILITATOR_RPC_URLS - comma-separated X Layer RPC endpoints
    (public: https://xlayerrpc.okx.com — verify reachability from Railway)
  ZEUS_FACILITATOR_GAS_PRIVATE_KEY - dedicated gas-payer key funded with
    OKB. NEVER reuse ZEUS_SIGNER_PRIVATE_KEY (F-116: the two roles must
    never share a key).
  ZEUS_FACILITATOR_API_KEY - static bearer key; the api-server and
    Secretariat both send `Authorization: Bearer <ZEUS_FACILITATOR_API_KEY>`
    when ZEUS_FACILITATOR_API_KEY is set on THEIR side. Required in prod.
Optional env:
  ZEUS_FACILITATOR_NETWORK (default eip155:196; eip155:84532 = base-sepolia
    staging, refused under NODE_ENV=production)
  PORT (default 3001), ZEUS_FACILITATOR_RECEIPT_TIMEOUT_MS (default 45000),
  ZEUS_FACILITATOR_CHECK_PAYER_BALANCE (default true)

Point BOTH consumers at it (api-server X402_FACILITATOR_URL and Secretariat
ZEUS_FACILITATOR_URL = the deployed facilitator base URL). Never point
production at the free public facilitator for eip155:196 traffic.

#### Build and Deploy

Railway will automatically:
1. Run: pnpm install and cd api-server and node ./build.mjs
2. Start: node --enable-source-maps api-server/dist/index.mjs
3. Healthcheck: /health

Wait for deployment to complete and check logs for errors.

---

### 2. Vercel (Frontend — canonical)

Canonical frontend: https://zeus-insurance-bot-frontend.vercel.app
Vercel auto-deploys on every push to main.

#### Environment Variables

Set these in your Vercel project:

- VITE_API_BASE_URL=https://zeus-insurance-bot-api-production.up.railway.app/api
- VITE_WALLETCONNECT_PROJECT_ID - required for the WalletConnect connector (without it only injected wallets are offered)
- NODE_VERSION=20

Build (already configured in the Vercel project):
- pnpm install --no-frozen-lockfile --prefer-offline --filter @workspace/frontend...
- pnpm --filter @zeus/sdk build
- pnpm --filter @workspace/frontend build

Output: frontend/dist

Legacy hosts (do not use):
- Render static site is retired (service returns instant 404); render.yaml kept for history only.
- Netlify fully burned (netlify.toml removed in fcf6c02ee, site deleted).

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
- Frontend loads correctly at https://zeus-insurance-bot-frontend.vercel.app
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

Last updated: 2026-10-25 (canonical frontend -> Vercel)
