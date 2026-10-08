/**
 * X402SellerAdapter — Block A INBOUND TRANSPORT ADAPTER.
 * Argus as ephemeral RESOURCE_SERVER (S9: external CLIENT → Argus RESOURCE_SERVER).
 *
 * Responsibilities (transport + x402 protocol only):
 * - Start an ephemeral HTTP server on a unique port
 * - Emit valid x402 V2 402 Payment Required on first request
 * - Accept and validate PAYMENT-SIGNATURE header (existing x402 validation)
 * - Return deterministic resource response after valid payment
 * - Translate every inbound HTTP interaction into CANONICAL Argus evidence
 *   (core/Evidence Observation) delivered through the canonical execution
 *   boundary (ScenarioEngine.beginInboundExecution() window).
 *
 * This adapter is NOT a semantic engine: it produces no verdicts. The verdict
 * for S9 comes exclusively from RunOrchestrator → AssertionEngine over the
 * canonical EvidenceCollector (see scenarios/S9_X402Seller.ts). In particular,
 * a validated signature is recorded as validation evidence ONLY — never as
 * on-chain settlement.
 *
 * Backward compatibility (B6-B, Mode A CLI): when started WITHOUT an
 * execution window (start(endpointPath) form), the adapter behaves exactly
 * like the legacy standalone seller HTTP server but records NO evidence at
 * all — the old TestSession/SessionEvidence side-channel was removed because
 * it constituted a second evidence/verdict model (Block A §6/§7). B6-B
 * acceptance semantics are computed by its own harness from real HTTP
 * responses and are unaffected.
 *
 * Reuses:
 * - x402 V2 envelope format from existing codebase conventions
 * - EIP-712 verification via viem (already a dependency)
 * - Canonical evidence model from core/Evidence (Observation)
 *
 * Does NOT:
 * - Perform on-chain settlement verification
 * - Support fault injection profiles (B6 scope)
 * - Maintain a second evidence/verdict model
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { recoverTypedDataAddress } from 'viem';
import type { Observation } from '../../core/Evidence';
import type { InboundExecutionWindow } from '../../core/ScenarioEngine';

// USDC on Base Sepolia - matches existing BaseSepoliaPaymentAdapter constants
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHAIN_ID_BASE_SEPOLIA = 84532;
const NETWORK_BASE_SEPOLIA = `eip155:${CHAIN_ID_BASE_SEPOLIA}`;
export const DEFAULT_BASE_SEPOLIA_PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const USDC_DOMAIN = {
  name: 'USDC',
  version: '2',
  chainId: CHAIN_ID_BASE_SEPOLIA,
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

interface PaymentRequiredBody {
  x402Version: number;
  resource: { url: string };
  accepts: Array<{
    scheme: string;
    network: string;
    amount: string;
    payTo: string;
    asset: string;
    maxTimeoutSeconds: number;
  }>;
}

export interface X402SellerAdapterConfig {
  port?: number;
  amount?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  /**
   * Canonical observation source stamp (scenario.testSubject in S9).
   * Defaults to 'argus-resource-server' for standalone use.
   */
  observationSource?: string;
}

/**
 * Options accepted by start(). Two forms:
 *
 * 1. String form (legacy / B6-B / standalone): endpoint path only.
 *    No canonical evidence is recorded — the adapter acts purely as an
 *    independent HTTP x402 seller process boundary.
 *
 * 2. Window form (canonical S9 path): an InboundExecutionWindow from
 *    ScenarioEngine.beginInboundExecution() plus the endpoint path. Every
 *    inbound HTTP interaction is translated into a canonical Observation
 *    and recorded through the window into the run's EvidenceCollector.
 */
export type SellerStartOptions =
  | string
  | {
      endpointPath: string;
      window: InboundExecutionWindow;
      /** Resolved once a paid request has been fully answered (200 or rejection). */
      onInteractionComplete?: () => void;
    };

export class X402SellerAdapter {
  private server: http.Server | null = null;
  private port: number;
  private config: Required<X402SellerAdapterConfig>;

  constructor(config: X402SellerAdapterConfig = {}) {
    this.port = config.port ?? 0;
    this.config = {
      port: this.port,
      amount: config.amount ?? '10000',
      payTo: config.payTo ?? DEFAULT_BASE_SEPOLIA_PAY_TO,
      maxTimeoutSeconds: config.maxTimeoutSeconds ?? 60,
      observationSource: config.observationSource ?? 'argus-resource-server',
    };
  }

  async start(options: SellerStartOptions): Promise<string> {
    const endpointPath = typeof options === 'string' ? options : options.endpointPath;

    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        void this.handleRequest(req, res, body, endpointPath, options);
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, '127.0.0.1', () => {
        const addr = this.server!.address() as AddressInfo;
        this.port = addr.port;
        const url = `http://127.0.0.1:${this.port}${endpointPath}`;
        resolve(url);
      });
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
    });
  }

  getPort(): number {
    return this.port;
  }

  // -----------------------------------------------------------------------
  // Request handling
  // -----------------------------------------------------------------------

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
    expectedPath: string,
    startOptions: SellerStartOptions,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const headers = this.normalizeHeaders(req.headers);

    const record = (type: string, data: Record<string, unknown>): void => {
      if (typeof startOptions === 'string') return; // legacy mode: no canonical evidence
      const observation: Observation = {
        source: this.config.observationSource,
        type,
        data: {
          direction: 'inbound',
          method,
          path: url,
          ...data,
        },
        timestamp: Date.now(),
      };
      startOptions.window.record(observation);
    };

    // Ordering contract (Block A repair §2): every final canonical
    // observation is recorded via window.record() — synchronously collected
    // into the shared EvidenceCollector — strictly BEFORE
    // onInteractionComplete() resolves the run-completion signal. This
    // guarantees RunOrchestrator.runInbound() never evaluates assertions
    // before the last inbound observation has been collected.
    //
    // Terminal semantics: completion fires ONLY at the terminal paid
    // interaction (validated 2xx delivery or payment rejection). The unpaid
    // 402 Payment Required is NOT terminal — the expected signed retry must
    // still be recordable while the inbound execution window is open.
    let interactionCompleted = false;
    const completeInteraction = (): void => {
      if (typeof startOptions === 'string') return;
      if (interactionCompleted) return; // fire exactly once
      interactionCompleted = true;
      startOptions.onInteractionComplete?.();
    };

    if (url !== expectedPath) {
      record('inbound_request_unmatched', { statusCode: 404 });
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const paymentSignatureHeader = headers['payment-signature'];

    if (paymentSignatureHeader) {
      await this.handlePaidRequest(res, body, headers, paymentSignatureHeader, record, completeInteraction);
    } else {
      // A9 terminal-completion repair: the unpaid 402 is NOT a terminal
      // interaction — the expected signed retry must still be recorded while
      // the inbound execution window is open. Completion happens only at the
      // terminal paid interaction (success or rejection).
      this.handleUnpaidRequest(res, body, record);
    }
  }

  private handleUnpaidRequest(
    res: http.ServerResponse,
    body: string,
    record: (type: string, data: Record<string, unknown>) => void,
  ): void {
    const paymentRequired = this.buildPaymentRequired();
    const headerValue = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');

    record('payment_required_issued', {
      statusCode: 402,
      x402Version: 2,
      bodySummary: body ? body.substring(0, 200) : undefined,
    });

    res.writeHead(402, {
      'Content-Type': 'application/json',
      'payment-required': headerValue,
    });
    res.end(JSON.stringify({ error: 'Payment Required' }));
  }

  private async handlePaidRequest(
    res: http.ServerResponse,
    body: string,
    headers: Record<string, string>,
    paymentSignatureBase64: string,
    record: (type: string, data: Record<string, unknown>) => void,
    completeInteraction: () => void,
  ): Promise<void> {
    record('payment_signature_received', {
      bodySummary: body ? body.substring(0, 200) : undefined,
      hasPaymentSignatureHeader: true,
      contentType: headers['content-type'],
    });

    const validationResult = await this.validatePaymentSignatureAsync(paymentSignatureBase64);

    if (validationResult.valid) {
      // NOTE: this is an authorization-VALIDATION fact at the HTTP/x402
      // boundary. It is deliberately NOT recorded as settlement (§5/§10).
      record('payment_signature_validated', { statusCode: 200 });

      const paymentResponse = Buffer.from(JSON.stringify({
        success: true,
        network: NETWORK_BASE_SEPOLIA,
      })).toString('base64');

      // Record the final canonical observation BEFORE writing the response
      // and BEFORE the completion signal (record → collect → resolve order).
      record('resource_response_delivered', { statusCode: 200 });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'payment-response': paymentResponse,
      });
      res.end(JSON.stringify({
        ok: true,
        resource: 'argus-test-resource',
      }));
      completeInteraction();
    } else {
      record('payment_signature_rejected', {
        statusCode: 402,
        validationError: validationResult.error ?? 'unknown',
      });

      const paymentRequired = this.buildPaymentRequired();
      const headerValue = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');

      res.writeHead(402, {
        'Content-Type': 'application/json',
        'payment-required': headerValue,
      });
      res.end(JSON.stringify({
        error: 'Invalid payment signature',
        detail: validationResult.error,
      }));
      completeInteraction();
    }
  }

  // -----------------------------------------------------------------------
  // x402 helpers
  // -----------------------------------------------------------------------

  private buildPaymentRequired(): PaymentRequiredBody {
    return {
      x402Version: 2,
      resource: { url: `http://127.0.0.1:${this.port}/resource` },
      accepts: [{
        scheme: 'exact',
        network: NETWORK_BASE_SEPOLIA,
        amount: this.config.amount,
        payTo: this.config.payTo,
        asset: USDC_BASE_SEPOLIA,
        maxTimeoutSeconds: this.config.maxTimeoutSeconds,
      }],
    };
  }

  private validatePaymentSignature(base64Payload: string): { valid: boolean; error?: string } {
    try {
      const decoded = Buffer.from(base64Payload, 'base64').toString('utf-8');
      const envelope = JSON.parse(decoded);

      if (envelope.x402Version !== 2) {
        return { valid: false, error: `Expected x402Version 2, got ${envelope.x402Version}` };
      }
      if (!envelope.payload?.signature || !envelope.payload?.authorization) {
        return { valid: false, error: 'Missing payload.signature or payload.authorization' };
      }

      const { signature, authorization } = envelope.payload;

      // Structural validation only; cryptographic verification is performed
      // by validatePaymentSignatureAsync before accepting the payment.

      // Structural checks
      if (!authorization.from || !authorization.to || !authorization.value) {
        return { valid: false, error: 'Incomplete authorization fields' };
      }
      if (authorization.nonce === undefined || authorization.nonce === null || authorization.validAfter === undefined || authorization.validAfter === null || authorization.validBefore === undefined || authorization.validBefore === null) {
        return { valid: false, error: 'Missing nonce/validAfter/validBefore' };
      }

      // Verify recipient matches our configured payTo
      if (authorization.to.toLowerCase() !== this.config.payTo.toLowerCase()) {
        return {
          valid: false,
          error: `Recipient mismatch: got ${authorization.to}, expected ${this.config.payTo}`,
        };
      }

      // Signature format check (basic)
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        return { valid: false, error: 'Invalid signature format (expected 0x + 65 bytes hex)' };
      }

      // Full EIP-712 verification is performed by the async request path.

      return { valid: true };
    } catch (err) {
      return { valid: false, error: `Signature decode/validation error: ${(err as Error).message}` };
    }
  }

  /**
   * Async version with full EIP-712 cryptographic verification.
   * Use this in production/integration tests.
   */
  async validatePaymentSignatureAsync(base64Payload: string): Promise<{ valid: boolean; error?: string }> {
    // First do structural validation
    const structural = this.validatePaymentSignature(base64Payload);
    if (!structural.valid) return structural;

    try {
      const decoded = Buffer.from(base64Payload, 'base64').toString('utf-8');
      const envelope = JSON.parse(decoded);
      const { signature, authorization } = envelope.payload;

      const recoveredAddress = await recoverTypedDataAddress({
        domain: USDC_DOMAIN,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
        signature,
      });

      if (recoveredAddress.toLowerCase() !== authorization.from.toLowerCase()) {
        return {
          valid: false,
          error: `Signer mismatch: recovered ${recoveredAddress}, expected ${authorization.from}`,
        };
      }

      // Enforce authorization time window: validAfter <= now < validBefore
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const validAfter = BigInt(authorization.validAfter);
      const validBefore = BigInt(authorization.validBefore);

      if (nowSec < validAfter) {
        return {
          valid: false,
          error: `Authorization not yet valid: current time ${nowSec} < validAfter ${validAfter}`,
        };
      }

      if (nowSec >= validBefore) {
        return {
          valid: false,
          error: `Authorization expired: current time ${nowSec} >= validBefore ${validBefore}`,
        };
      }

      return { valid: true };
    } catch (err) {
      return { valid: false, error: `Crypto verification failed: ${(err as Error).message}` };
    }
  }

  private normalizeHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value != null) {
        result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }
    return result;
  }
}

// ============================================================
// КОНЕЦ ФАЙЛА
// ============================================================
