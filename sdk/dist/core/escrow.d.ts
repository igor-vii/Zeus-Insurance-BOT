import { ZeusClient } from "./client.js";
import { type TransactionResult, type Agreement } from "../types/index.js";
export declare class ZeusEscrow {
    private readonly client;
    constructor(client: ZeusClient);
    private getContract;
    private buildTxResult;
    private parseEvent;
    /**
     * Lock USDC in escrow and create a new agreement.
     *
     * Before calling this, the caller must have approved the escrow contract
     * to spend `amount` of the USDC token:
     *   `usdc.approve(escrowAddress, amount)`
     *
     * @returns agreementId and transaction details
     */
    depositAndCreateAgreement(executor: string, amount: bigint, timeout: number): Promise<{
        agreementId: number;
        tx: TransactionResult;
    }>;
    /**
     * Executor confirms that off-chain work is done and submits optional proof.
     * Proof can be an IPFS CID, transaction hash, URL, or any UTF-8 string.
     * It is stored on-chain in the Agreement struct.
     */
    confirmExecution(agreementId: number, proof: string): Promise<TransactionResult>;
    /**
     * Initiator requests a refund after the agreement timeout has elapsed.
     */
    requestRefund(agreementId: number): Promise<TransactionResult>;
    /** Read agreement state from chain. */
    getAgreement(agreementId: number): Promise<Agreement>;
    /** Total number of agreements ever created. */
    getAgreementCount(): Promise<number>;
    /** Address of the ERC-20 token the escrow accepts. */
    getTokenAddress(): Promise<string>;
}
//# sourceMappingURL=escrow.d.ts.map