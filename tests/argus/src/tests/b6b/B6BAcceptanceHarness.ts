/**
 * B6-B Acceptance Harness.
 *
 * Provides an independent HTTP SUT boundary for testing the Argus BUYER path.
 * Uses X402SellerAdapter as a standalone HTTP server process boundary.
 *
 * This is NOT MockX402Server. The buyer communicates via real HTTP fetch()
 * through X402AgentAdapter, exactly as it would with any external seller.
 *
 * Test matrix coverage:
 * - Valid payment → PASS
 * - Forged signature → FAIL
 * - Wrong signer → FAIL
 * - Wrong recipient → FAIL
 * - Malformed signature → FAIL
 * - Invalid/expired timing → FAIL
 * - Payment accepted + normal response → delivery proven
 * - Payment accepted + seller error → DELIVERY_UNKNOWN
 * - Payment accepted + no response/timeout → DELIVERY_UNKNOWN
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { privateKeyToAccount } from 'viem/accounts';
import { X402SellerAdapter, DEFAULT_BASE_SEPOLIA_PAY_TO } from '../../adapters/seller/X402SellerAdapter';
import { TestSession, type CreateSessionRequest } from '../../sessions/TestSession';
import { computeB6BVerdict, type B6BVerdictStatus } from '../../core/B6BEvidence';

// Standard Anvil/Hardhat test keys (public, non-secret)
const VALID_PAYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
const OTHER_SIGNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as `0x${string}`;

const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHAIN_ID = 84532;

const USDC_DOMAIN = {
  name: 'USDC',
  version: '2',
  chainId: CHAIN_ID,
  verifyingContract: USDC_BASE_SEPOLIA,
} as const;

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// ---------------------------------------------------------------------------
// Harness types
// ---------------------------------------------------------------------------

export interface HarnessResult {
  caseName: string;
  httpStatus: number;
  verdict: B6BVerdictStatus;
  summary: string;
  evidence: Array<{ type: string; data: Record<string, unknown> }>;
  passed: boolean;
  expectedVerdict: B6BVerdictStatus;
}



// ---------------------------------------------------------------------------
// Harness implementation
// ---------------------------------------------------------------------------

/**
 * Start an independent X402SellerAdapter HTTP server for B6-B acceptance testing.
 */
export type SellerFaultMode = 'normal' | 'error_after_payment' | 'no_response_after_payment';

export interface HarnessConfig {
  /** Seller behavior override for specific test cases. */
  sellerBehavior?: SellerFaultMode;
  /** Custom payTo address for wrong-recipient tests. */
  customPayTo?: string;
}

/**
 * Start an independent HTTP SUT for B6-B acceptance testing.
 *
 * When sellerBehavior is 'error_after_payment' or 'no_response_after_payment',
 * wraps the X402SellerAdapter with a proxy that intercepts post-payment responses
 * to simulate delivery failure scenarios. This crosses the real HTTP boundary.
 */
export async function startB6BSut(config: HarnessConfig = {}): Promise<{
  url: string;
  session: TestSession;
  adapter: X402SellerAdapter;
  stop: () => Promise<void>;
  getPaymentAccepted: () => boolean;
}> {
  const sessionReq: CreateSessionRequest = {
    test_mode: 'BUYER',
    test_profile: 'b6b-acceptance',
    timeout_seconds: 30,
  };
  const session = new TestSession(sessionReq);

  const adapter = new X402SellerAdapter({
    port: 0, // auto-assign
    payTo: config.customPayTo ?? DEFAULT_BASE_SEPOLIA_PAY_TO,
    amount: '10000',
    maxTimeoutSeconds: 30,
  });

  const baseUrl = await adapter.start(session.getEndpointPath());
  const faultMode = config.sellerBehavior ?? 'normal';

  let url: string = '';
  let stopFn: () => Promise<void>;
  let paymentAccepted = false;
  const heldResponses = new Set<http.ServerResponse>();

  if (faultMode === 'normal') {
    url = baseUrl;
    stopFn = async () => {
      session.checkExpiry();
      await adapter.stop();
    };
  } else {
    // Forward to the real seller first; inject faults only after upstream payment acceptance.
    const adapterPort = adapter.getPort();
    const proxyServer = http.createServer((req, res) => {
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: adapterPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      };

      const proxyReq = http.request(options, (proxyRes) => {
        let body = '';
        proxyRes.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        proxyRes.on('end', () => {
          const hasPaymentSig = req.headers['payment-signature'] != null;
          const upstreamAccepted = hasPaymentSig
            && (proxyRes.statusCode ?? 500) >= 200
            && (proxyRes.statusCode ?? 500) < 300
            && proxyRes.headers['payment-response'] != null;

          if (upstreamAccepted) paymentAccepted = true;

          if (upstreamAccepted && faultMode === 'error_after_payment') {
            res.writeHead(500, {
              'Content-Type': 'application/json',
              'x-argus-upstream-payment-accepted': 'true',
            });
            res.end(JSON.stringify({
              error: 'Internal server error after payment processing',
              code: 'DELIVERY_FAILED',
            }));
          } else if (upstreamAccepted && faultMode === 'no_response_after_payment') {
            heldResponses.add(res);
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'x-argus-upstream-payment-accepted': 'true',
            });
          } else {
            res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
            res.end(body);
          }
        });
      });

      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
      });

      req.pipe(proxyReq);
    });

    await new Promise<void>((resolve) => {
      proxyServer.listen(0, '127.0.0.1', () => {
        const addr = proxyServer.address() as AddressInfo;
        const endpointPath = session.getEndpointPath();
        url = `http://127.0.0.1:${addr.port}${endpointPath}`;
        resolve();
      });
    });

    stopFn = async () => {
      session.checkExpiry();
      for (const heldResponse of heldResponses) {
        if (!heldResponse.writableEnded) heldResponse.destroy();
      }
      heldResponses.clear();
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
      await adapter.stop();
    };
  }

  return { url, session, adapter, stop: stopFn, getPaymentAccepted: () => paymentAccepted };
}

/**
 * Build a valid x402 PAYMENT-SIGNATURE envelope using the given private key.
 */
export async function buildPaymentSignature(
  privateKey: `0x${string}`,
  payTo: string,
  amount: string = '10000',
  overrides?: {
    nonce?: string;
    validAfter?: string;
    validBefore?: string;
    to?: `0x${string}`; // override recipient for wrong-recipient test
    from?: `0x${string}`; // override declared payer for signer/from mismatch test
  }
): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  const nowSec = Math.floor(Date.now() / 1000);

  const authorization = {
    from: (overrides?.from ?? account.address) as `0x${string}`,
    to: (overrides?.to ?? payTo) as `0x${string}`,
    value: BigInt(amount),
    validAfter: BigInt(overrides?.validAfter ?? String(nowSec)),
    validBefore: BigInt(overrides?.validBefore ?? String(nowSec + 300)),
    nonce: (overrides?.nonce ?? ('0x' + 'ab'.repeat(32))) as `0x${string}`,
  };

  const signature = await account.signTypedData({
    domain: USDC_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });

  const envelope = {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: `eip155:${CHAIN_ID}`,
      asset: USDC_BASE_SEPOLIA,
      amount,
      payTo: overrides?.to ?? payTo,
      maxTimeoutSeconds: 30,
    },
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: String(authorization.value),
        validAfter: String(authorization.validAfter),
        validBefore: String(authorization.validBefore),
        nonce: authorization.nonce,
      },
    },
  };

  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

/**
 * Build a forged (structurally valid but cryptographically invalid) signature.
 */
export function buildForgedSignature(): string {
  const forgedEnvelope = {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: `eip155:${CHAIN_ID}`,
      asset: USDC_BASE_SEPOLIA,
      amount: '10000',
      payTo: DEFAULT_BASE_SEPOLIA_PAY_TO,
      maxTimeoutSeconds: 30,
    },
    payload: {
      signature: '0x' + 'cd'.repeat(65), // invalid signature bytes
      authorization: {
        from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        to: DEFAULT_BASE_SEPOLIA_PAY_TO,
        value: '10000',
        validAfter: String(Math.floor(Date.now() / 1000)),
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: '0x' + 'ab'.repeat(32),
      },
    },
  };
  return Buffer.from(JSON.stringify(forgedEnvelope)).toString('base64');
}

/**
 * Build a malformed signature (invalid format).
 */
export function buildMalformedSignature(): string {
  const malformedEnvelope = {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: `eip155:${CHAIN_ID}`,
      asset: USDC_BASE_SEPOLIA,
      amount: '10000',
      payTo: DEFAULT_BASE_SEPOLIA_PAY_TO,
      maxTimeoutSeconds: 30,
    },
    payload: {
      signature: 'not-a-valid-signature',
      authorization: {
        from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        to: DEFAULT_BASE_SEPOLIA_PAY_TO,
        value: '10000',
        validAfter: String(Math.floor(Date.now() / 1000)),
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: '0x' + 'ab'.repeat(32),
      },
    },
  };
  return Buffer.from(JSON.stringify(malformedEnvelope)).toString('base64');
}

/**
 * Execute a single B6-B acceptance test case against the SUT.
 */
export async function runB6BTestCase(
  sutUrl: string,
  caseName: string,
  signatureBase64: string | null, // null = unpaid request
  expectedVerdict: B6BVerdictStatus,
  getPaymentAccepted?: () => boolean,
): Promise<HarnessResult> {
  const evidence: Array<{ type: string; data: Record<string, unknown> }> = [];

  const timeoutMs = 2000;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (signatureBase64 !== null) {
      headers['payment-signature'] = signatureBase64;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(sutUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const httpStatus = response.status;
    const body = await response.text().catch(() => '');

    // Collect evidence based on response
    if (signatureBase64 === null) {
      // Unpaid request — expect 402
      evidence.push({
        type: 'action_request_resource',
        data: { httpStatus, direction: 'outbound' },
      });
    } else {
      evidence.push({
        type: 'payment_signature_submitted',
        data: { actionType: 'request_resource', httpStatus },
      });

      const upstreamPaymentAccepted = getPaymentAccepted?.() === true
        || response.headers.get('x-argus-upstream-payment-accepted') === 'true';

      if (httpStatus >= 200 && httpStatus < 300 && !upstreamPaymentAccepted) {
        const hasBody = body.length > 0;
        const parsed = (() => { try { return JSON.parse(body); } catch { return null; } })();
        const deliveryIndicated = parsed?.ok === true || parsed?.resource != null;
        evidence.push({
          type: 'payment_accepted',
          data: { actionType: 'request_resource', httpStatus, responseBodyPresent: hasBody, paymentResponsePresent: response.headers.has('payment-response') },
        });
        evidence.push({
          type: 'seller_response_received',
          data: { actionType: 'request_resource', httpStatus, deliveryIndicated, bodySummary: body.substring(0, 200) },
        });
      } else if (upstreamPaymentAccepted && httpStatus !== 402) {
        evidence.push({
          type: 'payment_accepted',
          data: { actionType: 'request_resource', httpStatus, responseBodyPresent: body.length > 0, paymentResponsePresent: false },
        });
        evidence.push({
          type: 'seller_response_received',
          data: { actionType: 'request_resource', httpStatus, deliveryIndicated: false, bodySummary: body.substring(0, 200) },
        });
      } else if (httpStatus === 402) {
        const parsed = (() => { try { return JSON.parse(body); } catch { return null; } })();
        evidence.push({
          type: 'payment_rejected',
          data: { actionType: 'request_resource', httpStatus, rejectionDetail: parsed?.detail ?? parsed?.error },
        });
      } else {
        evidence.push({
          type: 'payment_rejected',
          data: { actionType: 'request_resource', httpStatus, rejectionDetail: `Unexpected status ${httpStatus}` },
        });
      }
    }
  } catch (err) {
    // Timeout or network error
    // If this was a paid request, ensure evidence captures what happened
    // before the timeout — signature submission and possible upstream acceptance.
    const wasAccepted = getPaymentAccepted?.() === true;

    if (signatureBase64 !== null) {
      // Record signature submission if not already recorded in try block
      if (!evidence.some(e => e.type === 'payment_signature_submitted')) {
        evidence.push({
          type: 'payment_signature_submitted',
          data: { actionType: 'request_resource' },
        });
      }

      // Record payment acceptance if upstream seller accepted before timeout
      // This is NOT inferred from timeout or signature presence — it requires
      // explicit confirmation via getPaymentAccepted() callback.
      if (wasAccepted && !evidence.some(e => e.type === 'payment_accepted')) {
        evidence.push({
          type: 'payment_accepted',
          data: {
            actionType: 'request_resource',
            httpStatus: 200, // upstream accepted; response never reached client
            responseBodyPresent: false,
            paymentResponsePresent: false,
          },
        });
      }
    }

    evidence.push({
      type: 'timeout_no_response',
      data: {
        actionType: 'request_resource',
        timeoutMs,
        paymentWasAccepted: wasAccepted,
      },
    });
  }

  const { status: verdict, summary } = computeB6BVerdict(evidence);

  return {
    caseName,
    httpStatus: evidence.find(e => e.data.httpStatus)?.data.httpStatus as number ?? 0,
    verdict,
    summary,
    evidence,
    passed: verdict === expectedVerdict,
    expectedVerdict,
  };
}
