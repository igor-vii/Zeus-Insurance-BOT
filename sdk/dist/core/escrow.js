import { Contract, Interface } from "ethers";
import { DepositAndCreateAgreementSchema, ConfirmExecutionSchema, RequestRefundSchema, ZeusError, ZeusNotConnectedError, ZeusValidationError, ZeusTransactionError, ZeusContractError, } from "../types/index.js";
/**
 * ABI for ZeusEscrowBOT.sol (Solidity 0.8.24).
 *
 * Key differences from the original spec:
 *  - proof is `bytes` (not `bytes32`) — stored on-chain, arbitrary length
 *  - Agreement fields: initiator / executor (not buyer / executor)
 *  - Status enum: Active(0) / Completed(1) / Refunded(2)
 */
const ESCROW_ABI = [
    "function depositAndCreateAgreement(address executor, uint256 amount, uint256 timeout) external returns (uint256 agreementId)",
    "function confirmExecution(uint256 agreementId, bytes proof) external",
    "function requestRefund(uint256 agreementId) external",
    "function getAgreement(uint256 agreementId) external view returns (tuple(address initiator, address executor, uint256 amount, uint256 timeout, uint256 createdAt, uint8 status, bytes proof))",
    "function agreementCount() external view returns (uint256)",
    "function token() external view returns (address)",
    "event AgreementCreated(uint256 indexed agreementId, address indexed initiator, address indexed executor, uint256 amount, uint256 timeout, uint256 createdAt)",
    "event ExecutionConfirmed(uint256 indexed agreementId, address indexed executor, uint256 amount, bytes proof)",
    "event RefundIssued(uint256 indexed agreementId, address indexed initiator, uint256 amount)",
];
/** Convert a plain UTF-8 string or existing 0x hex string to bytes hex. */
function toProofBytes(proof) {
    if (!proof)
        return "0x";
    if (proof.startsWith("0x"))
        return proof;
    return "0x" + Buffer.from(proof, "utf8").toString("hex");
}
const EMPTY_PROOF = "0x";
export class ZeusEscrow {
    client;
    constructor(client) {
        this.client = client;
    }
    getContract() {
        if (!this.client.isReady())
            throw new ZeusNotConnectedError();
        const network = this.client.getNetwork();
        if (!network.escrowAddress) {
            throw new ZeusContractError(`ZeusEscrowBOT is not deployed on "${network.name}" yet.`);
        }
        return new Contract(network.escrowAddress, ESCROW_ABI, this.client.getRunner());
    }
    buildTxResult(receipt) {
        return {
            hash: receipt.hash,
            status: receipt.status ?? 0,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
        };
    }
    parseEvent(receipt, eventName) {
        const iface = new Interface(ESCROW_ABI);
        for (const log of receipt.logs) {
            try {
                const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
                if (parsed?.name === eventName) {
                    return { args: parsed.args };
                }
            }
            catch {
                // skip non-matching logs
            }
        }
        return null;
    }
    /**
     * Lock USDC in escrow and create a new agreement.
     *
     * Before calling this, the caller must have approved the escrow contract
     * to spend `amount` of the USDC token:
     *   `usdc.approve(escrowAddress, amount)`
     *
     * @returns agreementId and transaction details
     */
    async depositAndCreateAgreement(executor, amount, timeout) {
        const parsed = DepositAndCreateAgreementSchema.safeParse({ executor, amount, timeout });
        if (!parsed.success) {
            throw new ZeusValidationError("Invalid parameters for depositAndCreateAgreement", parsed.error.issues);
        }
        const contract = this.getContract();
        try {
            const tx = await contract.depositAndCreateAgreement(parsed.data.executor, parsed.data.amount, BigInt(parsed.data.timeout));
            const receipt = await tx.wait();
            if (!receipt) {
                throw new ZeusTransactionError("Transaction was submitted but no receipt was received.");
            }
            if (receipt.status === 0) {
                throw new ZeusTransactionError("Transaction reverted.", receipt.hash);
            }
            const event = this.parseEvent(receipt, "AgreementCreated");
            if (!event) {
                throw new ZeusTransactionError("AgreementCreated event not found in transaction logs.", receipt.hash);
            }
            return {
                agreementId: Number(event.args["agreementId"]),
                tx: this.buildTxResult(receipt),
            };
        }
        catch (err) {
            if (err instanceof ZeusError)
                throw err;
            throw new ZeusTransactionError(`Failed to create escrow agreement: ${err.message}`, undefined, err);
        }
    }
    /**
     * Executor confirms that off-chain work is done and submits optional proof.
     * Proof can be an IPFS CID, transaction hash, URL, or any UTF-8 string.
     * It is stored on-chain in the Agreement struct.
     */
    async confirmExecution(agreementId, proof) {
        const parsed = ConfirmExecutionSchema.safeParse({ agreementId, proof });
        if (!parsed.success) {
            throw new ZeusValidationError("Invalid parameters for confirmExecution", parsed.error.issues);
        }
        const contract = this.getContract();
        const proofBytes = toProofBytes(parsed.data.proof);
        try {
            const tx = await contract.confirmExecution(BigInt(parsed.data.agreementId), proofBytes);
            const receipt = await tx.wait();
            if (!receipt) {
                throw new ZeusTransactionError("Transaction was submitted but no receipt was received.");
            }
            if (receipt.status === 0) {
                throw new ZeusTransactionError("Transaction reverted.", receipt.hash);
            }
            return this.buildTxResult(receipt);
        }
        catch (err) {
            if (err instanceof ZeusError)
                throw err;
            throw new ZeusTransactionError(`Failed to confirm execution: ${err.message}`, undefined, err);
        }
    }
    /**
     * Initiator requests a refund after the agreement timeout has elapsed.
     */
    async requestRefund(agreementId) {
        const parsed = RequestRefundSchema.safeParse({ agreementId });
        if (!parsed.success) {
            throw new ZeusValidationError("Invalid parameters for requestRefund", parsed.error.issues);
        }
        const contract = this.getContract();
        try {
            const tx = await contract.requestRefund(BigInt(parsed.data.agreementId));
            const receipt = await tx.wait();
            if (!receipt) {
                throw new ZeusTransactionError("Transaction was submitted but no receipt was received.");
            }
            if (receipt.status === 0) {
                throw new ZeusTransactionError("Transaction reverted.", receipt.hash);
            }
            return this.buildTxResult(receipt);
        }
        catch (err) {
            if (err instanceof ZeusError)
                throw err;
            throw new ZeusTransactionError(`Failed to request refund: ${err.message}`, undefined, err);
        }
    }
    /** Read agreement state from chain. */
    async getAgreement(agreementId) {
        if (!Number.isInteger(agreementId) || agreementId < 0) {
            throw new ZeusValidationError("Agreement ID must be a non-negative integer.");
        }
        const contract = this.getContract();
        try {
            const result = await contract.getAgreement(BigInt(agreementId));
            // Tuple order: initiator, executor, amount, timeout, createdAt, status, proof
            const proofHex = String(result[6]);
            return {
                id: agreementId,
                initiator: String(result[0]),
                executor: String(result[1]),
                amount: BigInt(result[2]),
                timeout: Number(result[3]),
                createdAt: Number(result[4]),
                status: Number(result[5]),
                proof: proofHex === EMPTY_PROOF || proofHex === "0x" ? null : proofHex,
            };
        }
        catch (err) {
            if (err instanceof ZeusError)
                throw err;
            throw new ZeusTransactionError(`Failed to fetch agreement: ${err.message}`, undefined, err);
        }
    }
    /** Total number of agreements ever created. */
    async getAgreementCount() {
        const contract = this.getContract();
        try {
            const count = await contract.agreementCount();
            return Number(count);
        }
        catch (err) {
            throw new ZeusContractError(`Failed to fetch agreement count: ${err.message}`, err);
        }
    }
    /** Address of the ERC-20 token the escrow accepts. */
    async getTokenAddress() {
        const contract = this.getContract();
        try {
            return String(await contract.token());
        }
        catch (err) {
            throw new ZeusContractError(`Failed to fetch token address: ${err.message}`, err);
        }
    }
}
//# sourceMappingURL=escrow.js.map