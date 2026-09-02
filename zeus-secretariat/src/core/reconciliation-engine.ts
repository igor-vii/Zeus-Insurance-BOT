/**
 * Zeus Secretariat V0 - Reconciliation Engine
 * 
 * Handles the critical task of resolving UNKNOWN settlement states.
 * When a payment submission returns UNKNOWN (network error, timeout),
 * this engine determines the actual settlement status by:
 * 1. Checking transaction hash on-chain (if available)
 * 2. Querying facilitator status API (if available)
 * 3. Checking AuthorizationUsed event on blockchain by nonce
 */

import { createPublicClient, http, PublicClient } from 'viem';
import { base, baseSepolia, Chain } from 'viem/chains';
import { PaymentIntent } from '../core/types';

/**
 * Settlement status after reconciliation
 */
export type ReconciliationStatus =
  | 'SETTLED'      // Transaction confirmed on-chain
  | 'NOT_SETTLED'  // Transaction rejected or nonce not used
  | 'UNRESOLVED';  // Cannot determine status, manual audit required

/**
 * Result of reconciliation process
 */
export interface ReconciliationResult {
  status: ReconciliationStatus;
  
  /**
   * Transaction hash if found
   */
  transactionHash?: string;
  
  /**
   * Block number if confirmed
   */
  blockNumber?: bigint;
  
  /**
   * Number of confirmations
   */
  confirmations?: number;
  
  /**
   * Source of truth for this determination
   */
  source: 'ON_CHAIN_TX' | 'ON_CHAIN_NONCE' | 'FACILITATOR' | 'UNKNOWN';
  
  /**
   * Raw data from reconciliation
   */
  rawData?: unknown;
  
  /**
   * Error message if reconciliation failed
   */
  error?: string;
}

/**
 * Configuration for ReconciliationEngine
 */
export interface ReconciliationEngineConfig {
  /**
   * RPC URL for blockchain queries
   */
  rpcUrl: string;
  
  /**
   * Chain ID (e.g., 'base-mainnet', 'base-sepolia')
   */
  chain: Chain;
  
  /**
   * Optional facilitator client for status checks
   */
  facilitatorBaseUrl?: string;
  facilitatorApiKey?: string;
  
  /**
   * USDC contract address on the chain
   */
  usdcContractAddress: `0x${string}`;
  
  /**
   * Minimum confirmations required to consider settled
   */
  minConfirmations?: number;
}

/**
 * AuthorizationUsed event signature for EIP-3009
 * event AuthorizationUsed(address indexed from, bytes32 indexed nonce)
 */
const AUTHORIZATION_USED_EVENT_SIGNATURE = 
  '0x144a6fc87a521078619c6d89e7e8f6f8c8b3e8f8c8b3e8f8c8b3e8f8c8b3e8f8' as `0x${string}`;

/**
 * ReconciliationEngine - Resolves UNKNOWN settlement states
 * 
 * This is the "brain" that handles network uncertainty after payment submission.
 * Key principle: Even if we lose the txHash, we can still find the payment
 * by checking the nonce in the AuthorizationUsed event.
 */
export class ReconciliationEngine {
  private readonly config: Required<ReconciliationEngineConfig>;
  private readonly publicClient: PublicClient;
  
  constructor(config: ReconciliationEngineConfig) {
    this.config = {
      minConfirmations: 1,
      facilitatorBaseUrl: config.facilitatorBaseUrl || '',
      facilitatorApiKey: config.facilitatorApiKey || '',
      rpcUrl: config.rpcUrl,
      chain: config.chain,
      usdcContractAddress: config.usdcContractAddress,
    };
    
    this.publicClient = createPublicClient({
      chain: config.chain,
      transport: http(config.rpcUrl),
    });
  }
  
  /**
   * Reconcile settlement status for a payment intent
   * 
   * @param intent - Payment intent with signature and possibly txHash
   * @returns Reconciliation result
   */
  async reconcile(intent: {
    operationId: string;
    nonce: string;
    payer: string;
    payTo: string;
    amount: string;
    signature?: string;
    transactionHash?: string;
  }): Promise<ReconciliationResult> {
    // Strategy 1: If we have txHash, check it directly
    if (intent.transactionHash) {
      try {
        const result = await this.checkTransactionByHash(intent.transactionHash);
        if (result.status !== 'UNRESOLVED') {
          return result;
        }
      } catch (error) {
        console.warn(`[ReconciliationEngine] TxHash check failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    
    // Strategy 2: Check by nonce in AuthorizationUsed event
    // This works even if we lost the txHash
    try {
      const result = await this.checkByNonce(intent.payer, intent.nonce);
      if (result.status !== 'UNRESOLVED') {
        return result;
      }
    } catch (error) {
      console.warn(`[ReconciliationEngine] Nonce check failed: ${error instanceof Error ? error.message : error}`);
    }
    
    // Strategy 3: Check facilitator status (if available)
    if (this.config.facilitatorBaseUrl && intent.transactionHash) {
      try {
        const result = await this.checkFacilitatorStatus(intent.transactionHash);
        if (result.status !== 'UNRESOLVED') {
          return result;
        }
      } catch (error) {
        console.warn(`[ReconciliationEngine] Facilitator check failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    
    // All strategies failed
    return {
      status: 'UNRESOLVED',
      source: 'UNKNOWN',
      error: 'All reconciliation strategies failed - manual audit required',
    };
  }
  
  /**
   * Check transaction status by hash
   */
  private async checkTransactionByHash(
    txHash: string
  ): Promise<ReconciliationResult> {
    try {
      const tx = await this.publicClient.getTransaction({
        hash: txHash as `0x${string}`,
      });
      
      if (!tx) {
        return {
          status: 'NOT_SETTLED',
          source: 'ON_CHAIN_TX',
          error: 'Transaction not found on chain',
        };
      }
      
      // Check if transaction was successful
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: txHash as `0x${string}`,
      });
      
      if (receipt.status === 'reverted') {
        return {
          status: 'NOT_SETTLED',
          source: 'ON_CHAIN_TX',
          transactionHash: txHash,
          error: 'Transaction reverted',
        };
      }
      
      // Get current block for confirmation count
      const currentBlock = await this.publicClient.getBlockNumber();
      const confirmations = Number(currentBlock - receipt.blockNumber);
      
      if (confirmations >= this.config.minConfirmations) {
        return {
          status: 'SETTLED',
          source: 'ON_CHAIN_TX',
          transactionHash: txHash,
          blockNumber: receipt.blockNumber,
          confirmations,
        };
      } else {
        // Still pending confirmations
        return {
          status: 'UNRESOLVED',
          source: 'ON_CHAIN_TX',
          transactionHash: txHash,
          blockNumber: receipt.blockNumber,
          confirmations,
          error: `Insufficient confirmations: ${confirmations}/${this.config.minConfirmations}`,
        };
      }
      
    } catch (error) {
      return {
        status: 'UNRESOLVED',
        source: 'ON_CHAIN_TX',
        error: error instanceof Error ? error.message : 'Failed to check transaction',
      };
    }
  }
  
  /**
   * Check if nonce was used by looking for AuthorizationUsed event
   * This is the fallback when txHash is lost
   */
  private async checkByNonce(
    payer: string,
    nonce: string
  ): Promise<ReconciliationResult> {
    try {
      // Search for AuthorizationUsed events with this payer and nonce
      // Note: This is a simplified example - in production you'd need to
      // properly filter logs by event signature and indexed parameters
      
      const events = await this.publicClient.getLogs({
        address: this.config.usdcContractAddress,
        event: {
          type: 'event',
          name: 'AuthorizationUsed',
          inputs: [
            { type: 'address', name: 'from', indexed: true },
            { type: 'bytes32', name: 'nonce', indexed: true },
          ],
        },
        args: {
          from: payer as `0x${string}`,
          nonce: nonce as `0x${string}`,
        },
        fromBlock: 0n, // In production, optimize with a reasonable fromBlock
        toBlock: 'latest',
      });
      
      if (events.length === 0) {
        return {
          status: 'NOT_SETTLED',
          source: 'ON_CHAIN_NONCE',
          error: 'AuthorizationUsed event not found for this nonce',
        };
      }
      
      // Found the event - get transaction details
      const event = events[0];
      const txHash = event.transactionHash;
      
      const tx = await this.publicClient.getTransaction({ hash: txHash });
      const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
      
      const currentBlock = await this.publicClient.getBlockNumber();
      const confirmations = Number(currentBlock - receipt.blockNumber);
      
      if (receipt.status === 'success' && confirmations >= this.config.minConfirmations) {
        return {
          status: 'SETTLED',
          source: 'ON_CHAIN_NONCE',
          transactionHash: txHash,
          blockNumber: receipt.blockNumber,
          confirmations,
          rawData: { event },
        };
      }
      
      return {
        status: 'NOT_SETTLED',
        source: 'ON_CHAIN_NONCE',
        transactionHash: txHash,
        error: 'Transaction reverted or insufficient confirmations',
      };
      
    } catch (error) {
      return {
        status: 'UNRESOLVED',
        source: 'ON_CHAIN_NONCE',
        error: error instanceof Error ? error.message : 'Failed to check nonce',
      };
    }
  }
  
  /**
   * Check facilitator status API (optional)
   */
  private async checkFacilitatorStatus(
    txHash: string
  ): Promise<ReconciliationResult> {
    if (!this.config.facilitatorBaseUrl) {
      return {
        status: 'UNRESOLVED',
        source: 'FACILITATOR',
        error: 'Facilitator base URL not configured',
      };
    }
    
    try {
      const response = await fetch(
        `${this.config.facilitatorBaseUrl}/v1/status/${txHash}`,
        {
          headers: this.config.facilitatorApiKey
            ? { 'Authorization': `Bearer ${this.config.facilitatorApiKey}` }
            : {},
        }
      );
      
      if (!response.ok) {
        return {
          status: 'UNRESOLVED',
          source: 'FACILITATOR',
          error: `HTTP ${response.status}`,
        };
      }
      
      const data = await response.json() as { status?: string; transactionHash?: string; reason?: string };
      
      if (data.status === 'SETTLED' || data.status === 'CONFIRMED') {
        return {
          status: 'SETTLED',
          source: 'FACILITATOR',
          transactionHash: txHash,
          rawData: data,
        };
      }
      
      if (data.status === 'FAILED' || data.status === 'REJECTED') {
        return {
          status: 'NOT_SETTLED',
          source: 'FACILITATOR',
          error: data.reason || 'Facilitator reports failure',
        };
      }
      
      return {
        status: 'UNRESOLVED',
        source: 'FACILITATOR',
        rawData: data,
        error: 'Facilitator status unclear',
      };
      
    } catch (error) {
      return {
        status: 'UNRESOLVED',
        source: 'FACILITATOR',
        error: error instanceof Error ? error.message : 'Failed to check facilitator',
      };
    }
  }
}
