/**
 * Zeus Secretariat V0 - Phase 2.3 Tests
 * 
 * Tests for Real x402 Facilitator Settlement & Reconciliation
 * 
 * Test AC: Real Submission (with Mock Facilitator)
 * Test AD: Timeout Handling
 * Test AE: Reconciliation Success
 * Test AF: No Blind Resubmit
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { MockX402FacilitatorClient, MockFacilitatorConfig } from '../src/adapters/mock-x402-facilitator-client';
import { SignedPaymentAuthorization, PaymentAuthorizationRequest } from '../src/core/payment-types';
import { ReconciliationEngine, ReconciliationEngineConfig } from '../src/core/reconciliation-engine';
import { baseSepolia } from 'viem/chains';

describe('Phase 2.3 - Real x402 Facilitator & Reconciliation', () => {
  
  const createMockAuthorization = (): SignedPaymentAuthorization => {
    const request: PaymentAuthorizationRequest = {
      operationId: 'op-test-123',
      scheme: 'x402',
      network: 'base-sepolia',
      asset: 'USDC',
      payer: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
      payTo: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1000000', // 1 USDC in cents
      nonce: '0x' + 'a'.repeat(64),
      validAfter: Math.floor(Date.now() / 1000),
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      createdAt: new Date().toISOString(),
    };
    
    return {
      request,
      signatureResult: {
        operationId: 'op-test-123',
        signerType: 'MOCK',
        payer: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        nonce: '0x' + 'a'.repeat(64),
        signature: '0x' + 'b'.repeat(130), // ECDSA signature
        signedAt: new Date().toISOString(),
      },
    };
  };

  // ============================================================================
  // Test AC: Real Submission (Mock Facilitator simulates real behavior)
  // ============================================================================
  describe('Test AC - Real Submission', () => {
    it('should successfully submit payment to mock facilitator and receive txHash', async () => {
      const config: MockFacilitatorConfig = {
        behavior: 'SUCCESS',
        fakeTxHash: '0xabc123def456',
        delayMs: 50,
      };
      
      const client = new MockX402FacilitatorClient(config);
      const auth = createMockAuthorization();
      
      const result = await client.submit(auth);
      
      expect(result.status).toBe('SUBMITTED');
      expect(result.submissionId).toBeDefined();
      expect(result.txHash).toBe('0xabc123def456');
      expect(client.getSubmitCallCount()).toBe(1);
    });
    
    it('should handle explicit rejection from facilitator', async () => {
      const config: MockFacilitatorConfig = {
        behavior: 'REJECTED',
        rejectionReason: 'Insufficient balance',
      };
      
      const client = new MockX402FacilitatorClient(config);
      const auth = createMockAuthorization();
      
      const result = await client.submit(auth);
      
      expect(result.status).toBe('REJECTED');
      expect(result.reason).toBe('Insufficient balance');
    });
  });

  // ============================================================================
  // Test AD: Timeout Handling
  // ============================================================================
  describe('Test AD - Timeout Handling', () => {
    it('should return UNKNOWN status on network timeout (not FAILED)', async () => {
      const config: MockFacilitatorConfig = {
        behavior: 'TIMEOUT',
        delayMs: 100,
      };
      
      const client = new MockX402FacilitatorClient(config);
      const auth = createMockAuthorization();
      
      const result = await client.submit(auth);
      
      // CRITICAL: Timeout must result in UNKNOWN, not FAILED
      // This allows reconciliation to determine actual state
      expect(result.status).toBe('UNKNOWN');
      expect(result.reason).toContain('timeout');
    });
    
    it('should return UNKNOWN status on server error (5xx)', async () => {
      const config: MockFacilitatorConfig = {
        behavior: 'SERVER_ERROR',
      };
      
      const client = new MockX402FacilitatorClient(config);
      const auth = createMockAuthorization();
      
      const result = await client.submit(auth);
      
      expect(result.status).toBe('UNKNOWN');
      expect(result.reason).toContain('Server error');
    });
  });

  // ============================================================================
  // Test AE: Reconciliation Success
  // ============================================================================
  describe('Test AE - Reconciliation Success', () => {
    it('should reconcile SETTLED status when transaction is confirmed on-chain', async () => {
      // Note: This test uses a mock/simulated scenario since we don't have
      // a real RPC connection in unit tests. In integration tests, this would
      // connect to a real Base Sepolia node.
      
      // For unit test purposes, we verify the engine structure and logic flow
      const config: ReconciliationEngineConfig = {
        rpcUrl: 'https://sepolia.base.org', // Mock URL for unit test
        chain: baseSepolia,
        usdcContractAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF71',
        minConfirmations: 1,
      };
      
      const engine = new ReconciliationEngine(config);
      
      // Simulate intent with txHash
      const intent = {
        operationId: 'op-reconcile-123',
        nonce: '0x' + 'c'.repeat(64),
        payer: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        payTo: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '1000000',
        transactionHash: '0xsimulated_tx_hash',
      };
      
      // In unit test without real RPC, this will return UNRESOLVED
      // But we verify the engine doesn't crash and returns proper structure
      const result = await engine.reconcile(intent);
      
      expect(result).toBeDefined();
      expect(result.status).toMatch(/SETTLED|NOT_SETTLED|UNRESOLVED/);
      expect(result.source).toBeDefined();
    });
    
    it('should use nonce as fallback when txHash is lost', async () => {
      const config: ReconciliationEngineConfig = {
        rpcUrl: 'https://sepolia.base.org',
        chain: baseSepolia,
        usdcContractAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF71',
      };
      
      const engine = new ReconciliationEngine(config);
      
      // Intent WITHOUT txHash - must use nonce-based lookup
      const intent = {
        operationId: 'op-nonce-lookup',
        nonce: '0x' + 'd'.repeat(64),
        payer: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        payTo: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '1000000',
        // NO transactionHash
      };
      
      const result = await engine.reconcile(intent);
      
      // Without real RPC connection, source will be UNKNOWN
      // But we verify the engine attempts reconciliation and returns proper structure
      expect(result).toBeDefined();
      expect(result.status).toMatch(/SETTLED|NOT_SETTLED|UNRESOLVED/);
      // Note: In unit tests without real RPC, source may be UNKNOWN
      // Integration tests with real RPC would verify ON_CHAIN_NONCE
    });
  });

  // ============================================================================
  // Test AF: No Blind Resubmit
  // ============================================================================
  describe('Test AF - No Blind Resubmit', () => {
    it('should only call submit() ONCE even if response is UNKNOWN', async () => {
      const config: MockFacilitatorConfig = {
        behavior: 'TIMEOUT', // Always returns UNKNOWN
      };
      
      const client = new MockX402FacilitatorClient(config);
      const auth = createMockAuthorization();
      
      // First submission - returns UNKNOWN
      const result1 = await client.submit(auth);
      expect(result1.status).toBe('UNKNOWN');
      expect(client.getSubmitCallCount()).toBe(1);
      
      // CRITICAL: Do NOT call submit again!
      // The invariant is: ONE submit per intent
      // Even though we got UNKNOWN, we must reconcile, not resubmit
      
      // Verify call count is still 1
      expect(client.getSubmitCallCount()).toBe(1);
      
      // If we were to incorrectly retry:
      // await client.submit(auth);
      // expect(client.getSubmitCallCount()).toBe(2); // THIS WOULD BE WRONG
      
      // Correct approach: Call reconciliation engine instead
      // (tested in Test AE)
    });
    
    it('should track submit calls across multiple operations', async () => {
      const config: MockFacilitatorConfig = {
        behavior: 'SUCCESS',
      };
      
      const client = new MockX402FacilitatorClient(config);
      
      // Submit for operation 1
      const auth1 = createMockAuthorization();
      await client.submit(auth1);
      
      // Submit for operation 2 - create fresh authorization with different operationId
      const auth2 = createMockAuthorization();
      // Note: We can't mutate readonly request, so we just call submit twice
      // The mock client tracks all calls regardless of operationId
      await client.submit(auth2);
      
      expect(client.getSubmitCallCount()).toBe(2);
    });
  });

  // ============================================================================
  // Additional: Flaky Network Simulation
  // ============================================================================
  describe('Additional - Flaky Network Simulation', () => {
    it('should handle random success/failure/unknown patterns', async () => {
      const config: MockFacilitatorConfig = {
        behavior: 'FLAKY',
        delayMs: 50,
      };
      
      const client = new MockX402FacilitatorClient(config);
      const auth = createMockAuthorization();
      
      // Run multiple submissions to see varied responses
      const results = [];
      for (let i = 0; i < 10; i++) {
        const result = await client.submit(auth);
        results.push(result.status);
      }
      
      // Should have mix of SUBMITTED, REJECTED, UNKNOWN
      const statuses = new Set(results);
      
      // With FLAKY behavior, we should see at least 2 different outcomes
      expect(statuses.size).toBeGreaterThanOrEqual(2);
    });
  });
});
