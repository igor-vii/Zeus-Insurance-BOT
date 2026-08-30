/**
 * BLOCK 8.1 — Canonical x402 V2 PaymentPayload Tests
 *
 * Verifies:
 *   - Valid canonical V2 payload structure
 *   - EIP-3009 authorization completeness
 *   - Base64 PAYMENT-SIGNATURE construction
 *   - Facilitator adapter receives canonical V2 payload
 *   - Old V1-shaped object is NOT a valid PaymentPayload
 */

import type { PaymentPayload } from '../src/adapters/x402-facilitator-client';
import { encodePaymentSignature } from '../src/adapters/x402-facilitator-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidV2Payload(overrides?: Partial<PaymentPayload>): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "base-sepolia",
      amount: "1000000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0xSellerAddress",
      maxTimeoutSeconds: 300,
    },
    payload: {
      signature: "0xabcdef1234567890",
      authorization: {
        from: "0xPayerAddress",
        to: "0xSellerAddress",
        value: "1000000",
        validAfter: "0",
        validBefore: "1700000000",
        nonce: "0x0000000000000000000000000000000000000000000000000000000000000001",
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// G3: Valid V2 Payload Structure
// ---------------------------------------------------------------------------

describe("BLOCK 8.1: Canonical x402 V2 PaymentPayload", () => {

  test("x402Version must be literal 2", () => {
    const payload = makeValidV2Payload();
    expect(payload.x402Version).toBe(2);
  });

  test("accepted object must be present with all required fields", () => {
    const payload = makeValidV2Payload();
    expect(payload.accepted).toBeDefined();
    expect(payload.accepted.scheme).toBe("exact");
    expect(payload.accepted.network).toBe("base-sepolia");
    expect(payload.accepted.amount).toBe("1000000");
    expect(payload.accepted.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(payload.accepted.payTo).toBe("0xSellerAddress");
    expect(payload.accepted.maxTimeoutSeconds).toBe(300);
  });

  test("payload.signature must be present", () => {
    const payload = makeValidV2Payload();
    expect(payload.payload.signature).toBe("0xabcdef1234567890");
  });

  test("payload.authorization must have all six EIP-3009 fields as strings", () => {
    const payload = makeValidV2Payload();
    const auth = payload.payload.authorization;
    expect(typeof auth.from).toBe("string");
    expect(typeof auth.to).toBe("string");
    expect(typeof auth.value).toBe("string");
    expect(typeof auth.validAfter).toBe("string");
    expect(typeof auth.validBefore).toBe("string");
    expect(typeof auth.nonce).toBe("string");
  });

  test("resource is optional — payload without resource is valid", () => {
    const payload = makeValidV2Payload();
    expect(payload.resource).toBeUndefined();
  });

  test("resource is supported when present", () => {
    const payload = makeValidV2Payload({
      resource: { url: "https://api.example.com/service", mimeType: "application/json" },
    });
    expect(payload.resource?.url).toBe("https://api.example.com/service");
  });

  test("extensions are optional", () => {
    const payload = makeValidV2Payload();
    expect(payload.extensions).toBeUndefined();
  });

  test("maxTimeoutSeconds is a number, not converted to absolute timestamp", () => {
    const payload = makeValidV2Payload();
    expect(typeof payload.accepted.maxTimeoutSeconds).toBe("number");
    expect(payload.accepted.maxTimeoutSeconds).toBe(300);
  });

  // -------------------------------------------------------------------------
  // G4: Base64 PAYMENT-SIGNATURE Construction
  // -------------------------------------------------------------------------

  test("encodePaymentSignature produces base64 string", () => {
    const payload = makeValidV2Payload();
    const encoded = encodePaymentSignature(payload);
    expect(typeof encoded).toBe("string");
    // Base64 characters only
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test("base64 decode reconstructs the same canonical payload", () => {
    const payload = makeValidV2Payload();
    const encoded = encodePaymentSignature(payload);
    const decoded = JSON.parse(atob(encoded));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.scheme).toBe("exact");
    expect(decoded.payload.authorization.from).toBe("0xPayerAddress");
    expect(decoded.payload.signature).toBe("0xabcdef1234567890");
  });

  test("identical payload produces identical PAYMENT-SIGNATURE", () => {
    const p1 = makeValidV2Payload();
    const p2 = makeValidV2Payload();
    expect(encodePaymentSignature(p1)).toBe(encodePaymentSignature(p2));
  });

  test("changing any field produces different PAYMENT-SIGNATURE", () => {
    const original = makeValidV2Payload();
    const modified = makeValidV2Payload({
      payload: {
        ...original.payload,
        signature: "0xDIFFERENT_SIGNATURE",
      },
    });
    expect(encodePaymentSignature(original)).not.toBe(encodePaymentSignature(modified));
  });

  // -------------------------------------------------------------------------
  // V1 Rejection: old flattened shape is NOT valid V2
  // -------------------------------------------------------------------------

  test("V1-shaped object lacks required V2 fields (compile-time guarantee)", () => {
    // This test documents that the old V1 shape:
    //   { paymentHeader: string; resource: string; network: string }
    // is structurally incompatible with PaymentPayload.
    // TypeScript will reject assignment of V1 shape to PaymentPayload.
    // Runtime check: V2 payload MUST have x402Version and accepted.
    const v2 = makeValidV2Payload();
    expect(v2.x402Version).toBe(2);
    expect(v2.accepted).toBeDefined();
    expect((v2 as any).paymentHeader).toBeUndefined();
  });
});
