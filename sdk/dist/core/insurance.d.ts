import { ZeusClient } from "./client.js";
import { type TransactionResult, type Policy, type Observation } from "../types/index.js";
export declare class ZeusInsurance {
    private readonly client;
    constructor(client: ZeusClient);
    private getContract;
    private buildTxResult;
    private parseEvent;
    /**
     * Purchase an insurance policy.
     *
     * This method automatically approves the USDC premium transfer before
     * calling `buyInsurance` on the contract, so callers do not need a
     * separate approve step.
     *
     * Premium formula (mirrors the contract):
     *   premium = amount × (700 + (maxRetries − 1) × 200) / 10 000
     *
     * @param seller   - Counterparty address being insured against.
     * @param amount   - Coverage amount in USDC (6-decimal bigint, e.g. 5_000_000n = 5 USDC).
     * @param timeout  - Per-retry timeout window in seconds (e.g. 86_400 = 24 h).
     * @param retries  - Number of retry windows allowed (1–10).
     */
    createPolicy(seller: string, amount: bigint, timeout: number, retries: number): Promise<{
        policyId: number;
        tx: TransactionResult;
    }>;
    /**
     * Claim a USDC payout once the retryDeadline has passed.
     * Only the policy buyer can call this.
     */
    claimPayout(policyId: number): Promise<TransactionResult>;
    /**
     * Submit a signed oracle observation on behalf of a watcher.
     *
     * The observation must be signed by a registered watcher address using
     * EIP-191 personal_sign over keccak256(requestId, timestamp, status,
     * metadataHash, nonce).  Any account can relay the signed struct — the
     * contract verifies authenticity via ECDSA.
     *
     * Vote resolution fires automatically once ≥ 3 observations accumulate for
     * the same requestId:
     *   ≥ 2 TIMEOUT (status=1) votes → payout approved
     *   otherwise                    → claim rejected
     *
     * @param policyId     ID of the policy being observed.
     * @param observation  Signed observation struct from the watcher.
     */
    submitObservation(policyId: number, observation: Observation): Promise<TransactionResult>;
    /** Read policy state from chain. */
    getPolicy(policyId: number): Promise<Policy>;
}
//# sourceMappingURL=insurance.d.ts.map