/**
 * Zeus Secretariat V0 - x402 Facilitator Client
 * 
 * Real client for interacting with x402 Payment Facilitator.
 * Handles submission of signed payment authorizations and returns
 * settlement status with proper error handling for network uncertainty.
 */

import { SignedPaymentAuthorization } from '../core/payment-types';
import { SettlementAdapter, SettlementSubmissionResult } from '../core/types';

/**
 * x402 Payment Payload structure according to x402 v2 spec
 */
export interface PaymentPayload {
  /**
   * Payment scheme identifier (e.g., 'x402', 'EIP-3009')
   */
  scheme: string;
  
  /**
   * Blockchain network (e.g., 'base-mainnet', 'base-sepolia')
   */
  network: string;
  
  /**
   * Asset being transferred (e.g., 'USDC')
   */
  asset: string;
  
  /**
   * Payer address
   */
  payer: string;
  
  /**
   * Payee address
   */
  payTo: string;
  
  /**
   * Amount in smallest units (e.g., wei for ETH, cents for USDC)
   */
  value: string;
  
  /**
   * Validity window start (Unix timestamp)
   */
  validAfter: number;
  
  /**
   * Validity window end (Unix timestamp)
   */
  validBefore: number;
  
  /**
   * Unique nonce for this authorization (bytes32 hex string)
   */
  nonce: string;
  
  /**
   * ECDSA signature (hex string)
   */
  signature: string;
}

/**
 * Facilitator API response types
 */
interface FacilitatorSuccessResponse {
  status: 'ACCEPTED' | 'SUBMITTED';
  submissionId: string;
  transactionHash?: string;
  message?: string;
}

interface FacilitatorErrorResponse {
  status: 'REJECTED';
  reason: string;
  code?: string;
}

/**
 * Configuration for the Facilitator client
 */
export interface FacilitatorClientConfig {
  /**
   * Base URL of the x402 Facilitator API
   */
  baseUrl: string;
  
  /**
   * API key for authentication (if required)
   */
  apiKey?: string;
  
  /**
   * Request timeout in milliseconds (default: 30000)
   */
  timeoutMs?: number;
  
  /**
   * Network identifier for logging
   */
  network: string;
}

/**
 * x402 Facilitator Client - implements SettlementAdapter interface
 * 
 * This client handles the critical boundary between signed authorization
 * and actual blockchain settlement. It properly distinguishes between:
 * - SUBMITTED: Payment successfully sent to facilitator
 * - REJECTED: Payment explicitly rejected by facilitator
 * - UNKNOWN: Network error/timeout - settlement status unclear
 */
export class X402FacilitatorClient implements SettlementAdapter {
  private readonly config: Required<FacilitatorClientConfig>;
  
  constructor(config: FacilitatorClientConfig) {
    this.config = {
      timeoutMs: 30000,
      ...config,
    };
  }
  
  /**
   * Convert SignedPaymentAuthorization to x402 PaymentPayload
   */
  private buildPaymentPayload(auth: SignedPaymentAuthorization): PaymentPayload {
    const { request, signatureResult } = auth;
    
    return {
      scheme: request.scheme,
      network: request.network,
      asset: request.asset,
      payer: request.payer,
      payTo: request.payTo,
      value: request.amount,
      validAfter: request.validAfter,
      validBefore: request.validBefore,
      nonce: request.nonce,
      signature: signatureResult.signature,
    };
  }
  
  /**
   * Submit signed payment authorization to facilitator
   * 
   * CRITICAL INVARIANT: This method should only be called ONCE per intent.
   * Even if the response is UNKNOWN, do NOT call submit() again.
   * Use reconciliation to determine actual settlement status.
   * 
   * @param auth - Signed payment authorization
   * @returns Settlement submission result
   */
  async submit(auth: SignedPaymentAuthorization): Promise<SettlementSubmissionResult> {
    const payload = this.buildPaymentPayload(auth);
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);
      
      const response = await fetch(`${this.config.baseUrl}/v1/settle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { 'Authorization': `Bearer ${this.config.apiKey}` } : {}),
          'X-Network': this.config.network,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      // Handle successful response
      if (response.ok) {
        const data: FacilitatorSuccessResponse = await response.json();
        
        return {
          status: 'SUBMITTED',
          submissionId: data.submissionId,
          txHash: data.transactionHash,
        };
      }
      
      // Handle explicit rejection
      if (response.status >= 400 && response.status < 500) {
        const errorData: FacilitatorErrorResponse = await response.json().catch(() => ({
          status: 'REJECTED',
          reason: `HTTP ${response.status}: ${response.statusText}`,
        }));
        
        return {
          status: 'REJECTED',
          reason: errorData.reason || 'Facilitator rejected payment',
        };
      }
      
      // Server error (5xx) - could be transient, but we return UNKNOWN
      // DO NOT retry automatically
      return {
        status: 'UNKNOWN',
        reason: `Server error: ${response.status} ${response.statusText}`,
      };
      
    } catch (error) {
      // Network errors, timeouts, aborts - all map to UNKNOWN
      // This is CRITICAL: we cannot assume failure, must reconcile
      const errorMessage = error instanceof Error ? error.message : 'Unknown network error';
      
      console.warn(`[X402FacilitatorClient] Submission resulted in UNKNOWN: ${errorMessage}`);
      
      return {
        status: 'UNKNOWN',
        reason: errorMessage,
      };
    }
  }
  
  /**
   * Check submission status by submission ID (if supported by facilitator)
   * This is an optional helper for reconciliation
   */
  async checkStatus(submissionId: string): Promise<{
    status: 'PENDING' | 'SUBMITTED' | 'SETTLED' | 'FAILED' | 'UNKNOWN';
    transactionHash?: string;
    details?: unknown;
  }> {
    try {
      const response = await fetch(`${this.config.baseUrl}/v1/status/${submissionId}`, {
        method: 'GET',
        headers: {
          ...(this.config.apiKey ? { 'Authorization': `Bearer ${this.config.apiKey}` } : {}),
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        return {
          status: data.status || 'UNKNOWN',
          transactionHash: data.transactionHash,
          details: data,
        };
      }
      
      return { status: 'UNKNOWN' };
      
    } catch (error) {
      return { status: 'UNKNOWN' };
    }
  }
}
