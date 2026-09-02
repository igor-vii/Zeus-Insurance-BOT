/**
 * Zeus Secretariat V0 - Mock x402 Facilitator Client
 * 
 * Mock implementation for testing Phase 2.3 without spending real USDC.
 * Simulates various facilitator behaviors:
 * - Successful submission with txHash
 * - Explicit rejection
 * - Network timeout (UNKNOWN)
 * - Server errors
 */

import { SignedPaymentAuthorization } from '../core/payment-types';
import { SettlementAdapter, SettlementSubmissionResult } from '../core/types';

export type MockFacilitatorBehavior = 
  | 'SUCCESS'           // Always returns success with txHash
  | 'REJECTED'          // Always returns rejection
  | 'TIMEOUT'           // Always times out (UNKNOWN)
  | 'SERVER_ERROR'      // Always returns 5xx error
  | 'FLAKY';            // Randomly succeeds/fails/unknowns

export interface MockFacilitatorConfig {
  behavior: MockFacilitatorBehavior;
  
  /**
   * Fake transaction hash to return on success
   */
  fakeTxHash?: string;
  
  /**
   * Delay in ms before responding (simulate network latency)
   */
  delayMs?: number;
  
  /**
   * Rejection reason (if behavior is REJECTED)
   */
  rejectionReason?: string;
}

/**
 * Mock x402 Facilitator Client for Phase 2.3 testing
 */
export class MockX402FacilitatorClient implements SettlementAdapter {
  private readonly config: Required<MockFacilitatorConfig>;
  private callCount = 0;
  
  constructor(config: MockFacilitatorConfig) {
    this.config = {
      fakeTxHash: '0xmock' + '1234567890abcdef'.repeat(4),
      delayMs: 100,
      rejectionReason: 'Insufficient balance',
      ...config,
    };
  }
  
  /**
   * Get the number of times submit() was called
   * Useful for verifying "no blind resubmit" invariant
   */
  getSubmitCallCount(): number {
    return this.callCount;
  }
  
  /**
   * Reset call counter
   */
  resetCallCount(): void {
    this.callCount = 0;
  }
  
  async submit(auth: SignedPaymentAuthorization): Promise<SettlementSubmissionResult> {
    this.callCount++;
    
    const { behavior, fakeTxHash, delayMs, rejectionReason } = this.config;
    
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, delayMs));
    
    switch (behavior) {
      case 'SUCCESS':
        return {
          status: 'SUBMITTED',
          submissionId: `mock-submission-${this.callCount}`,
          txHash: fakeTxHash,
        };
        
      case 'REJECTED':
        return {
          status: 'REJECTED',
          reason: rejectionReason,
        };
        
      case 'TIMEOUT':
        // Simulate network timeout - return UNKNOWN
        return {
          status: 'UNKNOWN',
          reason: 'Network timeout simulated',
        };
        
      case 'SERVER_ERROR':
        return {
          status: 'UNKNOWN',
          reason: 'Server error simulated (5xx)',
        };
        
      case 'FLAKY': {
        // Random behavior for stress testing
        const rand = Math.random();
        if (rand < 0.4) {
          // 40% success
          return {
            status: 'SUBMITTED',
            submissionId: `mock-submission-${this.callCount}`,
            txHash: fakeTxHash,
          };
        } else if (rand < 0.7) {
          // 30% rejected
          return {
            status: 'REJECTED',
            reason: 'Random rejection',
          };
        } else {
          // 30% unknown
          return {
            status: 'UNKNOWN',
            reason: 'Random network failure',
          };
        }
      }
      
      default:
        throw new Error(`Unknown behavior: ${behavior}`);
    }
  }
}
