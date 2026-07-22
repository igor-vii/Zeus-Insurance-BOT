import { ZeusClient } from "./core/client.js";
import { ZeusEscrow } from "./core/escrow.js";
import { ZeusInsurance } from "./core/insurance.js";
/**
 * ZeusSDK — unified entry point for the Zeus Insurance Protocol.
 *
 * @example
 * ```ts
 * import { ZeusSDK } from "@zeus/sdk";
 * import { ethers } from "ethers";
 *
 * const sdk = new ZeusSDK();
 * const provider = new ethers.BrowserProvider(window.ethereum);
 * const signer = await provider.getSigner();
 *
 * await sdk.connect("base-sepolia", signer);
 *
 * // Create an escrow agreement (approve USDC first)
 * const { agreementId } = await sdk.escrow.depositAndCreateAgreement(
 *   "0xExecutorAddress",
 *   1_000_000n,   // 1 USDC (6 decimals)
 *   86_400,        // 1 day timeout
 * );
 *
 * // Executor confirms with on-chain proof
 * await sdk.escrow.confirmExecution(agreementId, "ipfs://Qm...");
 * ```
 */
export class ZeusSDK {
    client;
    escrow;
    insurance;
    constructor() {
        this.client = new ZeusClient();
        this.escrow = new ZeusEscrow(this.client);
        this.insurance = new ZeusInsurance(this.client);
    }
    /** Connect to a supported network with an ethers v6 Signer. */
    async connect(network, signer) {
        await this.client.connect(network, signer);
    }
    isReady() {
        return this.client.isReady();
    }
    disconnect() {
        this.client.disconnect();
    }
}
export { ZeusClient } from "./core/client.js";
export { ZeusEscrow } from "./core/escrow.js";
export { ZeusInsurance } from "./core/insurance.js";
export { NetworkSchema, NETWORKS, DepositAndCreateAgreementSchema, ConfirmExecutionSchema, RequestRefundSchema, CreatePolicySchema, ClaimPayoutSchema, GetPolicySchema, AgreementStatus, ZeusError, ZeusNotConnectedError, ZeusValidationError, ZeusTransactionError, ZeusContractError, } from "./types/index.js";
//# sourceMappingURL=index.js.map