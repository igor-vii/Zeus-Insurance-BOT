/**
 * Zeus Secretariat V0 - Real On-Chain Checker (P0-4)
 *
 * section 6: Blockchain is System of Record
 * section 7: SETTLED proof requires full evidence bundle
 * authorizationState == true alone is NOT sufficient for SETTLED
 */
import { createPublicClient, http, keccak256, parseAbiItem, toBytes } from "viem";
import { DEFAULT_FINALITY_POLICY } from "./types.js";
// EIP-3009 AuthorizationUsed(address authorizer, bytes32 nonce)
const AUTHORIZATION_USED_EVENT = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const AUTHORIZATION_USED_TOPIC = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));
// ERC-20 Transfer(address from, address to, uint256 value)
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
// authorizationState(address,bytes32) function selector
const AUTH_STATE_ABI = parseAbiItem("function authorizationState(address authorizer, bytes32 nonce) view returns (bool)");
export class ViemOnChainChecker {
    client;
    finalityPolicy;
    networkConfig;
    constructor(networkConfig, finalityPolicy = DEFAULT_FINALITY_POLICY) {
        this.networkConfig = networkConfig;
        this.client = createPublicClient({
            chain: networkConfig.chain,
            transport: http(networkConfig.rpcUrl),
        });
        this.finalityPolicy = finalityPolicy;
    }
    getTokenContractAddress() {
        return this.networkConfig.tokenContractAddress;
    }
    async assertExpectedChain() {
        const expectedChainId = Number(this.networkConfig.chain.id);
        const actualChainId = await this.client.getChainId();
        if (actualChainId !== expectedChainId) {
            throw new Error(`RPC returned chain ${actualChainId}; expected ${expectedChainId}`);
        }
    }
    async getBlockNumber() {
        return Number(await this.client.getBlockNumber());
    }
    /** section 6: Check authorizationState(authorizer, nonce) */
    async checkAuthorizationState(tokenContract, authorizer, nonce) {
        await this.assertExpectedChain();
        return await this.client.readContract({
            address: tokenContract,
            abi: [AUTH_STATE_ABI],
            functionName: "authorizationState",
            args: [authorizer, nonce],
        });
    }
    /** section 6: Find AuthorizationUsed event to recover txHash */
    async findAuthorizationUsed(tokenContract, authorizer, nonce, fromBlock, toBlock) {
        await this.assertExpectedChain();
        const logs = await this.client.getLogs({
            address: tokenContract,
            event: AUTHORIZATION_USED_EVENT,
            args: { authorizer, nonce },
            fromBlock,
            toBlock,
        });
        if (logs.length === 0)
            return null;
        const log = logs[0];
        return {
            transactionHash: log.transactionHash,
            blockNumber: Number(log.blockNumber),
            logIndex: log.logIndex,
        };
    }
    /** section 7 + 8: Get receipt and verify Transfer matching */
    async verifySettledProof(txHash, expectedFrom, expectedTo, expectedMinValue, expectedTokenContract) {
        await this.assertExpectedChain();
        const receipt = await this.client.getTransactionReceipt({ hash: txHash });
        if (!receipt)
            return null;
        const chainHead = await this.getBlockNumber();
        const blockNumber = Number(receipt.blockNumber);
        const confirmations = chainHead - blockNumber;
        const receiptStatus = receipt.status === "success" ? 1 : 0;
        // section 9: Reverted tx = no settlement
        if (receiptStatus === 0) {
            return { receiptStatus, blockNumber, confirmations, transfer: null, authorizationUsed: null };
        }
        // Find AuthorizationUsed in logs
        let authorizationUsed = null;
        for (const log of receipt.logs) {
            if (log.topics.length >= 3 && log.address.toLowerCase() === expectedTokenContract.toLowerCase()) {
                // Check if this is AuthorizationUsed event
                try {
                    // Manual topic matching to avoid viem version compatibility issues
                    if (log.topics[0]?.toLowerCase() === AUTHORIZATION_USED_TOPIC.toLowerCase() && log.topics.length >= 3) {
                        authorizationUsed = {
                            transactionHash: txHash,
                            blockNumber,
                            logIndex: log.logIndex,
                        };
                    }
                }
                catch { /* not AuthorizationUsed */ }
            }
        }
        // section 8: Find matching Transfer
        let transfer = null;
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== expectedTokenContract.toLowerCase())
                continue;
            try {
                // Manual Transfer event parsing
                const TRANSFER_TOPIC_HASH = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
                if (log.topics.length >= 3 && log.topics[0] === TRANSFER_TOPIC_HASH) {
                    const from = ("0x" + log.topics[1].slice(26));
                    const to = ("0x" + log.topics[2].slice(26));
                    const value = BigInt(log.data);
                    const args = { from, to, value };
                    if (args.from.toLowerCase() === expectedFrom.toLowerCase() &&
                        args.to.toLowerCase() === expectedTo.toLowerCase() &&
                        args.value >= expectedMinValue) {
                        transfer = {
                            from: args.from,
                            to: args.to,
                            value: args.value,
                            tokenContract: log.address.toLowerCase(),
                        };
                    }
                }
            }
            catch { /* not Transfer */ }
        }
        return { receiptStatus, blockNumber, confirmations, transfer, authorizationUsed };
    }
    getFinalityPolicy() { return this.finalityPolicy; }
}
//# sourceMappingURL=viem-onchain-checker.js.map