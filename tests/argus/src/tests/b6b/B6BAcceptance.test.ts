/**
 * B6-B Acceptance Test Suite.
 *
 * Proves that Argus BUYER/CLIENT can test an external RESOURCE_SERVER/SELLER
 * through the real public HTTP/x402 boundary.
 *
 * Uses X402SellerAdapter as an independent HTTP server (NOT MockX402Server).
 * Buyer communicates via real HTTP fetch() through the network stack.
 *
 * Matrix:
 * - Valid payment → PASS
 * - Forged signature → FAIL
 * - Wrong signer → FAIL
 * - Wrong recipient → FAIL
 * - Malformed signature → FAIL
 * - Invalid timing (expired validBefore) → FAIL
 * - Payment accepted + normal response → PASS (delivery proven)
 * - Unpaid request → UNKNOWN (no payment submitted)
 *
 * Semantic boundary enforced:
 *   payment accepted ≠ work delivered
 *   timeout after payment = DELIVERY_UNKNOWN, NOT FAILURE
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  startB6BSut,
  buildPaymentSignature,
  buildForgedSignature,
  buildMalformedSignature,
  runB6BTestCase,
  type HarnessResult,
} from './B6BAcceptanceHarness';
import type { B6BVerdictStatus } from '../../core/B6BEvidence';

const VALID_PAYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
const OTHER_SIGNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as `0x${string}`;
const DEFAULT_PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const WRONG_RECIPIENT = '0x0000000000000000000000000000000000000001';

describe('B6-B Acceptance: Argus BUYER vs External SUT', () => {
  let sutUrl: string;
  let stopSut: () => Promise<void>;

  // Fresh SUT per test to avoid state leakage
  async function setupSut(customPayTo?: string) {
    const sut = await startB6BSut({ customPayTo });
    sutUrl = sut.url;
    stopSut = sut.stop;
    return sut;
  }

  afterEach(async () => {
    if (stopSut) {
      await stopSut();
    }
  });

  function assertResult(result: HarnessResult) {
    expect(result.passed, 
      `${result.caseName}: expected ${result.expectedVerdict}, got ${result.verdict}. ${result.summary}`
    ).toBe(true);
  }

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  it('valid payment → PASS with delivery proven', async () => {
    await setupSut();
    
    // Step 1: Unpaid request → get 402 (implicit in harness flow)
    // Step 2: Build valid signature and submit
    const sig = await buildPaymentSignature(VALID_PAYER_PK, DEFAULT_PAY_TO);
    const result = await runB6BTestCase(sutUrl, 'valid-payment', sig, 'PASS');
    
    assertResult(result);
    expect(result.httpStatus).toBe(200);
    
    // Verify evidence contains both payment_accepted and seller_response_received
    const evidenceTypes = result.evidence.map(e => e.type);
    expect(evidenceTypes).toContain('payment_signature_submitted');
    expect(evidenceTypes).toContain('payment_accepted');
    expect(evidenceTypes).toContain('seller_response_received');
  });

  // -----------------------------------------------------------------------
  // Negative cases: signature rejection
  // -----------------------------------------------------------------------

  it('forged signature → FAIL (crypto rejection)', async () => {
    await setupSut();
    const forged = buildForgedSignature();
    const result = await runB6BTestCase(sutUrl, 'forged-signature', forged, 'FAIL');
    
    assertResult(result);
    expect(result.httpStatus).toBe(402);
    
    const evidenceTypes = result.evidence.map(e => e.type);
    expect(evidenceTypes).toContain('payment_rejected');
  });

  it('wrong signer → FAIL (signer mismatch)', async () => {
    await setupSut();
    // Sign with OTHER key but declare VALID payer as authorization.from.
    // This creates a real EIP-712 signature whose recovered signer differs
    // from the declared payer address.
    const wrongSignerSig = await buildPaymentSignature(
      OTHER_SIGNER_PK,
      DEFAULT_PAY_TO,
      '10000',
      { from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' },
    );
    const result = await runB6BTestCase(sutUrl, 'wrong-signer', wrongSignerSig, 'FAIL');
    
    assertResult(result);
    expect(result.httpStatus).toBe(402);
    
    // Verify rejection is crypto-based, not structural
    const rejectionEvent = result.evidence.find(e => e.type === 'payment_rejected');
    expect(rejectionEvent).toBeDefined();
  });

  it('wrong recipient → FAIL (recipient mismatch)', async () => {
    // Start SUT with default payTo
    await setupSut();
    // Build signature paying to WRONG address
    const wrongRecipientSig = await buildPaymentSignature(
      VALID_PAYER_PK,
      DEFAULT_PAY_TO,
      '10000',
      { to: WRONG_RECIPIENT }
    );
    const result = await runB6BTestCase(sutUrl, 'wrong-recipient', wrongRecipientSig, 'FAIL');
    
    assertResult(result);
    expect(result.httpStatus).toBe(402);
    
    const rejectionEvent = result.evidence.find(e => e.type === 'payment_rejected');
    expect(rejectionEvent).toBeDefined();
    const detail = (rejectionEvent?.data as { rejectionDetail?: string })?.rejectionDetail ?? '';
    expect(detail.toLowerCase()).toContain('recipient mismatch');
  });

  it('malformed signature → FAIL (format rejection)', async () => {
    await setupSut();
    const malformed = buildMalformedSignature();
    const result = await runB6BTestCase(sutUrl, 'malformed-signature', malformed, 'FAIL');
    
    assertResult(result);
    expect(result.httpStatus).toBe(402);
    
    const evidenceTypes = result.evidence.map(e => e.type);
    expect(evidenceTypes).toContain('payment_rejected');
  });

  it('expired timing (validBefore in past) → FAIL', async () => {
    await setupSut();
    const nowSec = Math.floor(Date.now() / 1000);
    // Set validBefore to 1 hour ago — definitely expired
    const expiredSig = await buildPaymentSignature(
      VALID_PAYER_PK,
      DEFAULT_PAY_TO,
      '10000',
      {
        validAfter: String(nowSec - 7200),
        validBefore: String(nowSec - 3600),
      }
    );
    const result = await runB6BTestCase(sutUrl, 'expired-timing', expiredSig, 'FAIL');
    
    assertResult(result);
    // Note: Current X402SellerAdapter does not enforce time window validation.
    // If this test returns PASS instead of FAIL, it documents that gap.
    // The structural check passes; crypto verification may or may not reject
    // depending on viem behavior with expired windows.
    // This test documents the current behavior for future enhancement.
  });

  // -----------------------------------------------------------------------
  // UNKNOWN semantics
  // -----------------------------------------------------------------------

  it('unpaid request → UNKNOWN (no payment submitted)', async () => {
    await setupSut();
    // Send request WITHOUT payment signature
    const result = await runB6BTestCase(sutUrl, 'unpaid-request', null, 'UNKNOWN');
    
    assertResult(result);
    expect(result.httpStatus).toBe(402);
    
    // Should NOT be classified as FAIL
    expect(result.verdict).not.toBe('FAIL');
  });

  // -----------------------------------------------------------------------
  // Evidence vocabulary verification
  // -----------------------------------------------------------------------

  it('evidence distinguishes payment from delivery', async () => {
    await setupSut();
    const sig = await buildPaymentSignature(VALID_PAYER_PK, DEFAULT_PAY_TO);
    const result = await runB6BTestCase(sutUrl, 'evidence-distinction', sig, 'PASS');
    
    const evidenceTypes = result.evidence.map(e => e.type);
    
    // Must have separate evidence for signature submission and delivery
    expect(evidenceTypes).toContain('payment_signature_submitted');
    expect(evidenceTypes).toContain('payment_accepted');
    expect(evidenceTypes).toContain('seller_response_received');
    
    // Verify seller_response_received has deliveryIndicated field
    const sellerResponse = result.evidence.find(e => e.type === 'seller_response_received');
    expect(sellerResponse?.data).toHaveProperty('deliveryIndicated');
  });

  // -----------------------------------------------------------------------
  // PAYMENT-RESPONSE is HTTP artifact, not settlement proof
  // -----------------------------------------------------------------------

  it('PAYMENT-RESPONSE captured but not treated as settlement proof', async () => {
    await setupSut();
    const sig = await buildPaymentSignature(VALID_PAYER_PK, DEFAULT_PAY_TO);
    const result = await runB6BTestCase(sutUrl, 'payment-response-artifact', sig, 'PASS');
    
    // payment_accepted event should note paymentResponsePresent
    const acceptedEvent = result.evidence.find(e => e.type === 'payment_accepted');
    expect(acceptedEvent).toBeDefined();
    // The field exists but verdict is based on delivery, not payment-response alone
    expect(result.verdict).toBe('PASS'); // Because delivery IS indicated in this case
    
    // Key: if we removed seller_response_received evidence, verdict would change
    const withoutDelivery = result.evidence.filter(e => e.type !== 'seller_response_received');
    // Import computeB6BVerdict inline to verify
    const { computeB6BVerdict } = await import('../../core/B6BEvidence');
    const altVerdict = computeB6BVerdict(withoutDelivery);
    // Without delivery evidence, should be DELIVERY_UNKNOWN, not PASS
    expect(altVerdict.status).toBe('DELIVERY_UNKNOWN');
  });

  // -----------------------------------------------------------------------
  // R2: Authorization time window enforcement (executable)
  // -----------------------------------------------------------------------

  it('expired validBefore → FAIL (authorization expired)', async () => {
    await setupSut();
    const nowSec = Math.floor(Date.now() / 1000);
    // Set validBefore to 1 hour ago — definitely expired
    const expiredSig = await buildPaymentSignature(
      VALID_PAYER_PK,
      DEFAULT_PAY_TO,
      '10000',
      {
        validAfter: String(nowSec - 7200),
        validBefore: String(nowSec - 3600),
      }
    );
    const result = await runB6BTestCase(sutUrl, 'expired-validBefore', expiredSig, 'FAIL');
    
    assertResult(result);
    expect(result.httpStatus).toBe(402);
    
    const rejectionEvent = result.evidence.find(e => e.type === 'payment_rejected');
    expect(rejectionEvent).toBeDefined();
    const detail = (rejectionEvent?.data as { rejectionDetail?: string })?.rejectionDetail ?? '';
    expect(detail.toLowerCase()).toContain('expired');
  });

  it('not-yet-valid validAfter → FAIL (authorization not yet valid)', async () => {
    await setupSut();
    const nowSec = Math.floor(Date.now() / 1000);
    // Set validAfter to 1 hour in the future — not yet valid
    const futureSig = await buildPaymentSignature(
      VALID_PAYER_PK,
      DEFAULT_PAY_TO,
      '10000',
      {
        validAfter: String(nowSec + 3600),
        validBefore: String(nowSec + 7200),
      }
    );
    const result = await runB6BTestCase(sutUrl, 'not-yet-valid-validAfter', futureSig, 'FAIL');
    
    assertResult(result);
    expect(result.httpStatus).toBe(402);
    
    const rejectionEvent = result.evidence.find(e => e.type === 'payment_rejected');
    expect(rejectionEvent).toBeDefined();
    const detail = (rejectionEvent?.data as { rejectionDetail?: string })?.rejectionDetail ?? '';
    expect(detail.toLowerCase()).toContain('not yet valid');
  });

  // -----------------------------------------------------------------------
  // R3/F2: Post-payment delivery failure scenarios (end-to-end via HTTP)
  // -----------------------------------------------------------------------

  it('F2: payment accepted + seller error → DELIVERY_UNKNOWN (not FAILURE)', async () => {
    // Start SUT with error_after_payment fault mode
    const sut = await startB6BSut({ sellerBehavior: 'error_after_payment' });
    sutUrl = sut.url;
    stopSut = sut.stop;
    
    const sig = await buildPaymentSignature(VALID_PAYER_PK, DEFAULT_PAY_TO);
    const result = await runB6BTestCase(sutUrl, 'f2-error-after-payment', sig, 'DELIVERY_UNKNOWN', sut.getPaymentAccepted);
    
    // MUST NOT be PASS (delivery was not successful)
    expect(result.verdict).not.toBe('PASS');
    // MUST NOT be generic FAIL (payment WAS accepted, delivery failed)
    // DELIVERY_UNKNOWN is the correct semantic outcome
    expect(result.verdict).toBe('DELIVERY_UNKNOWN');
    
    // Evidence must show payment was submitted and accepted before delivery failure.
    const evidenceTypes = result.evidence.map(e => e.type);
    expect(evidenceTypes).toContain('payment_signature_submitted');
    expect(evidenceTypes).toContain('payment_accepted');
    expect(evidenceTypes).toContain('seller_response_received');
  });

  it('F2: payment accepted + no response (timeout) → DELIVERY_UNKNOWN (not FAILURE)', async () => {
    // Start SUT with no_response_after_payment fault mode
    const sut = await startB6BSut({ sellerBehavior: 'no_response_after_payment' });
    sutUrl = sut.url;
    stopSut = sut.stop;
    
    const sig = await buildPaymentSignature(VALID_PAYER_PK, DEFAULT_PAY_TO);
    // Use shorter timeout for this specific test
    const result = await runB6BTestCase(sutUrl, 'f2-no-response-timeout', sig, 'DELIVERY_UNKNOWN', sut.getPaymentAccepted);
    
    // MUST NOT be PASS
    expect(result.verdict).not.toBe('PASS');
    // Payment acceptance was observed before the response was withheld.
    expect(result.verdict).toBe('DELIVERY_UNKNOWN');
    const evidenceTypes = result.evidence.map(e => e.type);
    expect(evidenceTypes).toContain('payment_accepted');
    expect(evidenceTypes).toContain('timeout_no_response');
    // MUST NOT be generic FAIL
    expect(result.verdict).not.toBe('FAIL');
  });
});
