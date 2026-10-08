/**
 * Block A — bilateral x402 scenarios S8 / S9 through ONE canonical
 * execution / evidence / assertion / verdict pipeline:
 *
 *   ScenarioDefinition → RunOrchestrator → ScenarioEngine
 *     → EvidenceCollector → AssertionEngine → Verdict
 *
 * Tests:
 * - A8.1  S8 happy path: 402 → signed payment → retry → resource response → PASS
 *         (driven through RunOrchestrator.run() with the REGISTERED S8
 *          definition and its own canonical assertions).
 * - A8.2  S8 negative payment/control-flow path. REUSES the B6-B case
 *         "forged signature → FAIL (crypto rejection)"
 *         (src/tests/b6b/B6BAcceptance.test.ts:91): the forged-signature
 *         condition is driven through the S8 canonical path
 *         (ScenarioEngine → EvidenceCollector → AssertionEngine) and the same
 *         FAIL verdict is reached there — proving the scenario does not
 *         silently become PASS. The external RESOURCE_SERVER rejects the
 *         forged PAYMENT-SIGNATURE via the SAME real X402SellerAdapter
 *         validation used by B6-B (EIP-712 recovery mismatch).
 * - A9.1  S9 happy path: external CLIENT → 402 → PAYMENT-SIGNATURE →
 *         validation → 200 resource response → PASS
 *         (RunOrchestrator.runInbound() + X402SellerAdapter inbound window).
 * - A9.2  S9 invalid/forged payment path: request → 402 → invalid
 *         PAYMENT-SIGNATURE → rejected → FAIL.
 *
 * Semantic boundary preserved everywhere: a validated PAYMENT-SIGNATURE is
 * authorization-validation evidence at the HTTP/x402 boundary; it is NEVER
 * asserted or reported as on-chain settlement.
 */

import { describe, it, expect } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { privateKeyToAccount } from 'viem/accounts';
import { RunOrchestrator } from '../../core/RunOrchestrator';
import { AgentController } from '../../core/AgentController';
import { ScenarioRegistry } from '../../cli/ScenarioRegistry';
import { MockX402Server } from '../helpers/MockX402Server';
import { X402AgentAdapter } from '../../adapters/x402/X402AgentAdapter';
import { BaseSepoliaPaymentAdapter } from '../../adapters/payment/evm/BaseSepoliaPaymentAdapter';
import { X402SellerAdapter, DEFAULT_BASE_SEPOLIA_PAY_TO } from '../../adapters/seller/X402SellerAdapter';
import type { InboundExecutionWindow } from '../../core/ScenarioEngine';
import type { ScenarioDefinition } from '../../core/ScenarioDefinition';

// Standard Anvil/Hardhat test keys (public, non-secret)
const VALID_PAYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
const OTHER_SIGNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as `0x${string}`;

const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const USDC_DOMAIN = {
  name: 'USDC',
  version: '2',
  chainId: 84532,
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

interface AuthFields {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

function defaultAuthorization(from: string, to = DEFAULT_BASE_SEPOLIA_PAY_TO): AuthFields {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    from,
    to,
    value: '10000',
    validAfter: String(nowSec - 10),
    validBefore: String(nowSec + 300),
    nonce: '0x' + 'ab'.repeat(32),
  };
}

/**
 * Build an x402 V2 PAYMENT-SIGNATURE envelope (Base64) — exactly the steps
 * any external client performs. For the forged case the signature key and
 * authorization.from intentionally disagree (B6-B "forged signature").
 */
async function buildPaymentSignatureEnvelope(
  signerPk: `0x${string}`,
  authorization: AuthFields,
): Promise<string> {
  const account = privateKeyToAccount(signerPk);
  const signature = await account.signTypedData({
    domain: USDC_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  });

  const envelope = {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: 'eip155:84532',
      asset: USDC_BASE_SEPOLIA,
      amount: '10000',
      payTo: authorization.to,
      maxTimeoutSeconds: 60,
    },
    payload: { signature, authorization },
  };
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

const PAYMENT_REQUIRED_BODY = {
  x402Version: 2,
  resource: { url: 'http://localhost/resource' },
  accepts: [{
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '10000',
    payTo: DEFAULT_BASE_SEPOLIA_PAY_TO,
    maxTimeoutSeconds: 60,
    asset: USDC_BASE_SEPOLIA,
  }],
};

// ---------------------------------------------------------------------------
// S8 — Argus CLIENT → external RESOURCE_SERVER (outbound direction)
// ---------------------------------------------------------------------------

describe('Block A / S8 — Argus CLIENT → external RESOURCE_SERVER', () => {
  async function setupS8(): Promise<{
    server: MockX402Server;
    controller: AgentController;
    adapter: X402AgentAdapter;
    paymentAdapter: BaseSepoliaPaymentAdapter;
  }> {
    const server = new MockX402Server();
    const { url } = await server.start();
    server.setBehavior({ type: '402_with_header', paymentRequired: PAYMENT_REQUIRED_BODY });

    const adapter = new X402AgentAdapter('x402-target');
    await adapter.connect({ transportType: 'x402', endpoint: url });

    const paymentAdapter = new BaseSepoliaPaymentAdapter({
      rpcUrl: 'http://localhost:8545',
      privateKey: VALID_PAYER_PK,
      receiveAddresses: { 'resource-server-1': DEFAULT_BASE_SEPOLIA_PAY_TO },
    });

    const controller = new AgentController(adapter, {
      connectionConfig: { transportType: 'x402', endpoint: url },
      timeoutMs: 5000,
    });
    controller.setRunId('block-a-s8-run');

    return { server, controller, adapter, paymentAdapter };
  }

  it('A8.1 S8 happy path: 402 → signed payment → retry → resource response → PASS', async () => {
    const { server, controller, adapter } = await setupS8();
    try {
      // Use the REGISTERED S8 definition with its own canonical assertions.
      const s8 = ScenarioRegistry.get('S8') as ScenarioDefinition;
      const controllers = new Map<string, AgentController>();
      controllers.set('client-1', controller);

      const s8PaymentAdapter = new BaseSepoliaPaymentAdapter({
        rpcUrl: 'http://localhost:8545',
        privateKey: VALID_PAYER_PK,
        receiveAddresses: { 'resource-server-1': DEFAULT_BASE_SEPOLIA_PAY_TO },
      });

      const orchestrator = new RunOrchestrator(s8, controllers, s8.assertions ?? [], s8PaymentAdapter);
      const result = await orchestrator.run();

      // Canonical verdict via AssertionEngine.
      expect(result.verdict?.status).toBe('PASS');

      // Canonical evidence: the x402 sign-and-retry control flow occurred.
      const evidence = orchestrator.getEvidence();
      const signedEvent = evidence.find(
        (e) => e.source === 'engine' && e.type === 'payment_signed_and_retried',
      );
      expect(signedEvent).toBeDefined();

      // Real HTTP control flow: request → 402 → retry with PAYMENT-SIGNATURE.
      const requests = server.getRequests();
      expect(requests.length).toBe(2);
      expect(requests[0].headers['payment-signature']).toBeUndefined();
      expect(requests[1].headers['payment-signature']).toBeDefined();

      // Semantic boundary: control-flow evidence only, never a settlement claim.
      expect(evidence.some((e) => /settle/i.test(e.type))).toBe(false);

      // L3: outbound x402 HTTP-boundary responses now reach the canonical
      // testSubject observation channel (source === scenario.testSubject).
      // NOTE (documented limitation, out of L3 scope): ScenarioEngine
      // .performAction() handles the INITIAL 402 exchange in the
      // payment-resolver branch and returns before the generic observation
      // translation loop, so the initial-402 adapter observations
      // ('payment_required_received') do not currently reach the canonical
      // channel — only the signed-retry response's do. Adapter-level coverage
      // of 'payment_required_received' remains in X402AgentAdapter.test.ts.
      const sutObservations = evidence.filter((e) => e.source === 'sut-1');
      expect(sutObservations.length).toBeGreaterThan(0);
      expect(sutObservations.map((e) => e.type)).toContain('http_response_received');
      // Observation presence did NOT change the verdict path: PASS is still
      // produced by the unchanged engine-behavior assertion over engine
      // evidence above.
      expect(result.verdict?.status).toBe('PASS');

      await adapter.disconnect();
    } finally {
      await server.stop();
    }
  });

  it('A8.2 S8 negative path — REUSES B6-B "forged signature → FAIL (crypto rejection)" (src/tests/b6b/B6BAcceptance.test.ts:91), driven through the S8 canonical path → FAIL', async () => {
    // External RESOURCE_SERVER that performs REAL x402 validation using the
    // same X402SellerAdapter.validatePaymentSignatureAsync (EIP-712 recovery)
    // as B6-B: unsigned → 402, forged signature → 402 rejection, valid → 200.
    const validator = new X402SellerAdapter({ payTo: DEFAULT_BASE_SEPOLIA_PAY_TO });
    const requestsSeen: Array<Record<string, string>> = [];
    const sut = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        const headers: Record<string, string> = {};
        Object.entries(req.headers).forEach(([k, v]) => {
          if (v) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        });
        void body;
        requestsSeen.push(headers);
        const sig = headers['payment-signature'];
        if (!sig) {
          const headerValue = Buffer.from(JSON.stringify(PAYMENT_REQUIRED_BODY)).toString('base64');
          res.writeHead(402, { 'Content-Type': 'application/json', 'payment-required': headerValue });
          res.end(JSON.stringify({ error: 'Payment Required' }));
          return;
        }
        void validator.validatePaymentSignatureAsync(sig).then((validation) => {
          if (validation.valid) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(402, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid payment signature', detail: validation.error }));
          }
        });
      });
    });
    await new Promise<void>((resolve) => sut.listen(0, '127.0.0.1', () => resolve()));
    const sutUrl = `http://127.0.0.1:${(sut.address() as AddressInfo).port}/resource`;

    try {
      const adapter = new X402AgentAdapter('x402-target');
      await adapter.connect({ transportType: 'x402', endpoint: sutUrl });
      const controller = new AgentController(adapter, {
        connectionConfig: { transportType: 'x402', endpoint: sutUrl },
        timeoutMs: 5000,
      });
      controller.setRunId('block-a-s8-negative-run');

      // FORGED signature: signed by OTHER_SIGNER but claiming payer as from
      // (the exact B6-B "forged signature" condition).
      const payer = privateKeyToAccount(VALID_PAYER_PK);
      const forgedAuth = defaultAuthorization(payer.address);
      const forgedSig = await buildPaymentSignatureEnvelope(OTHER_SIGNER_PK, forgedAuth);

      class ForgedSigningAdapter implements PaymentAdapterLike {
        getArgusAddress(): string { return payer.address; }
        async signX402Payment(): Promise<string> { return forgedSig; }
      }

      const s8 = ScenarioRegistry.get('S8') as ScenarioDefinition;
      const controllers = new Map<string, AgentController>();
      controllers.set('client-1', controller);

      const orchestrator = new RunOrchestrator(
        s8,
        controllers,
        s8.assertions ?? [],
        new ForgedSigningAdapter() as unknown as BaseSepoliaPaymentAdapter,
      );
      const result = await orchestrator.run();

      // Same FAIL verdict as B6-B — reached through the CANONICAL S8 path
      // (ScenarioEngine → EvidenceCollector → AssertionEngine), proving the
      // scenario does not silently become PASS.
      expect(result.verdict?.status).toBe('FAIL');
      expect(result.verdict?.reason ?? '').toContain('payment not signed and retried');

      const evidence = orchestrator.getEvidence();

      // A8.2 semantic contract: payment_signed_and_retried is an ACTION FACT
      // (the signed retry really happened) and remains present even when the
      // retry is rejected. Its presence must NOT determine the verdict; the
      // FAIL above is derived from canonical terminal-outcome evidence below.
      const signedEvent = evidence.find(
        (e) => e.source === 'engine' && e.type === 'payment_signed_and_retried',
      );
      expect(signedEvent).toBeDefined();

      // Canonical negative interaction evidence: the second HTTP 402 after
      // the signed retry is recorded as the terminal outcome of the retry,
      // independently of the action fact.
      const retryOutcome = evidence.find(
        (e) => e.source === 'engine' && e.type === 'payment_retry_outcome',
      );
      expect(retryOutcome).toBeDefined();
      expect(retryOutcome?.data.statusCode).toBe(402);
      expect(retryOutcome?.data.httpRejected).toBe(true);

      // The negative run crossed the real HTTP boundary twice, and the SUT
      // really rejected the forged signature (not a mock convenience).
      expect(requestsSeen.length).toBe(2);
      expect(requestsSeen[1]['payment-signature']).toBeDefined();
      expect(evidence.some((e) => /settle/i.test(e.type))).toBe(false);

      // L3 wiring present in the negative path too: the observed retry HTTP
      // response becomes a testSubject-sourced observation...
      // NOTE (same documented limitation as A8.1, out of L3 scope): the
      // initial-402 exchange is consumed by the payment-resolver branch of
      // ScenarioEngine.performAction(), which returns before the generic
      // observation translation loop, so its 'payment_required_received'
      // adapter observation does not currently reach the canonical channel.
      const sutObservations = evidence.filter((e) => e.source === 'sut-1');
      expect(sutObservations.length).toBeGreaterThan(0);
      expect(sutObservations.map((e) => e.type)).toContain('http_response_received');
      // ...but they do NOT determine the verdict: FAIL above is still derived
      // solely from payment_retry_outcome (terminal evidence), and observation
      // presence does not turn the rejected run into PASS.
      expect(result.verdict?.status).toBe('FAIL');

      await adapter.disconnect();
    } finally {
      await new Promise<void>((resolve) => sut.close(() => resolve()));
    }
  });
});

// Minimal structural type for the injected payment adapter (the orchestrator
// only needs getArgusAddress + signX402Payment via the PaymentResolver wiring).
interface PaymentAdapterLike {
  getArgusAddress(): string;
  signX402Payment(binding: unknown): Promise<string>;
}

// ---------------------------------------------------------------------------
// S9 — external CLIENT → Argus RESOURCE_SERVER (inbound direction)
// ---------------------------------------------------------------------------

describe('Block A / S9 — external CLIENT → Argus RESOURCE_SERVER', () => {
  interface S9Run {
    verdictStatus: string;
    reason?: string;
    evidenceTypes: string[];
    finalHttpStatus: number;
  }

  /**
   * Drive one full inbound interaction through the canonical pipeline:
   * ScenarioDefinition → RunOrchestrator.runInbound()
   *   → ScenarioEngine.beginInboundExecution() window
   *   → X402SellerAdapter (inbound transport, canonical Observations)
   *   → EvidenceCollector → AssertionEngine → Verdict
   *
   * The built-in client plays the EXTERNAL SUT purely at the HTTP boundary
   * (black-box: no Argus internals inspected).
   */
  async function runS9Interaction(clientPk: `0x${string}`, forged: boolean): Promise<S9Run> {
    const s9 = ScenarioRegistry.get('S9') as ScenarioDefinition;
    const sellerAdapter = new X402SellerAdapter({
      port: 0,
      payTo: DEFAULT_BASE_SEPOLIA_PAY_TO,
      observationSource: s9.testSubject,
    });

    let resolveInteraction: () => void = () => {};
    const interactionDone = new Promise<void>((resolve) => { resolveInteraction = resolve; });

    // The external client plays the SUT purely at the HTTP boundary
    // (black-box). Its fetch promises are awaited before the verdict is
    // read, so the final HTTP outcome is never observed mid-flight.
    let clientFlow: Promise<void> = Promise.resolve();

    let finalHttpStatus = 0;

    const startTransport = async (window: InboundExecutionWindow, endpointPath: string): Promise<void> => {
      const url = await sellerAdapter.start({
        endpointPath,
        window,
        onInteractionComplete: () => resolveInteraction(),
      });

      clientFlow = (async () => {
        try {
          const first = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
          if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
          const prHeader = first.headers.get('payment-required');
          if (!prHeader) throw new Error('missing payment-required header');

          const account = privateKeyToAccount(clientPk);
          const auth = defaultAuthorization(account.address);
          const sig = forged
            ? await buildPaymentSignatureEnvelope(OTHER_SIGNER_PK, auth) // forged: signer ≠ auth.from
            : await buildPaymentSignatureEnvelope(clientPk, auth);

          const second = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'payment-signature': sig },
          });
          finalHttpStatus = second.status;
        } catch {
          finalHttpStatus = -1;
          resolveInteraction();
        }
      })();
    };

    const stopTransport = async (): Promise<void> => {
      await sellerAdapter.stop();
    };

    const orchestrator = new RunOrchestrator(s9, new Map(), s9.assertions ?? []);
    const result = await orchestrator.runInbound(startTransport, stopTransport, {
      timeoutMs: 10_000,
      completionSignal: interactionDone,
    });

    // Await the black-box client's own view of the terminal exchange before
    // reading the final HTTP status (no mid-flight observation).
    await clientFlow;

    const evidenceTypes = orchestrator.getEvidence().map((e) => e.type);
    return {
      verdictStatus: result.verdict?.status ?? 'MISSING',
      reason: result.verdict?.reason,
      evidenceTypes,
      finalHttpStatus,
    };
  }

  it('A9.1 S9 happy path: external CLIENT → 402 → PAYMENT-SIGNATURE → validation → 200 → PASS', async () => {
    const r = await runS9Interaction(VALID_PAYER_PK, false);

    // Canonical verdict via the SAME AssertionEngine used by S8.
    expect(r.verdictStatus).toBe('PASS');
    expect(r.finalHttpStatus).toBe(200);

    // Canonical observations produced by the inbound transport.
    expect(r.evidenceTypes).toContain('payment_required_issued');
    expect(r.evidenceTypes).toContain('payment_signature_received');
    expect(r.evidenceTypes).toContain('payment_signature_validated');
    expect(r.evidenceTypes).toContain('resource_response_delivered');

    // Negative facts absent on the happy path.
    expect(r.evidenceTypes).not.toContain('payment_signature_rejected');

    // Semantic boundary (§10): validation is NOT settlement — no settlement
    // evidence exists or is claimed.
    expect(r.evidenceTypes.some((t) => /settle/i.test(t))).toBe(false);
  });

  it('A9.2 S9 invalid/forged payment path: request → 402 → invalid PAYMENT-SIGNATURE → rejected → FAIL', async () => {
    const r = await runS9Interaction(VALID_PAYER_PK, true);

    // Canonical FAIL verdict — computed by the SAME AssertionEngine.
    expect(r.verdictStatus).toBe('FAIL');
    expect(r.reason ?? '').toContain('payment signature was rejected');

    // External client was actually rejected at the HTTP boundary.
    expect(r.finalHttpStatus).toBe(402);

    // Observable failure evidence without a false success.
    expect(r.evidenceTypes).toContain('payment_required_issued');
    expect(r.evidenceTypes).toContain('payment_signature_received');
    expect(r.evidenceTypes).toContain('payment_signature_rejected');
    expect(r.evidenceTypes).not.toContain('payment_signature_validated');
    expect(r.evidenceTypes).not.toContain('resource_response_delivered');
  });
});
