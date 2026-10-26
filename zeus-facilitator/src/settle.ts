/**
 * Zeus facilitator — settlement orchestration.
 *
 * Guarantees (aligned with the repo's D3/D4 taxonomy and the Secretariat
 * client's status mapping):
 *   - Verification failure  → HTTP 200 {success:false, errorReason} (definitive,
 *     pre-broadcast; the authorization was NOT broadcast).
 *   - Broadcast attempt started → the nonce guard makes a duplicate /settle
 *     with the same nonce return 409 {success:false, errorReason:"duplicate_…
 *     _inflight"} instead of a second broadcast (EIP-3009 authorizations are
 *     single-use; the durable guard is on-chain authorizationState, this map
 *     covers the in-flight window).
 *   - Broadcast accepted but receipt not seen in time → HTTP 504 (ambiguous;
 *     an honest client must go RECONCILING, not FAILED).
 *   - Receipt reverted → HTTP 200 {success:false, errorReason:"settle_reverted"}
 *     with the tx hash (definitive: nothing transferred, nonce NOT consumed —
 *     FiatToken marks the nonce only on success).
 */
import {
  createPublicClient,
  encodeFunctionData,
  fallback,
  http,
  type Address,
  type Chain,
  type Hash,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { FacilitatorNetwork } from "./config.js";
import type { ChainRpc } from "./rpc.js";
import { splitSignature, type VerifiedAuthorization } from "./verify.js";

const TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    name: "transferWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

export function encodeSettleCalldata(auth: {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}, sig: { v: number; r: Hex; s: Hex }): Hex {
  return encodeFunctionData({
    abi: TRANSFER_WITH_AUTHORIZATION_ABI,
    functionName: "transferWithAuthorization",
    args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig.v, sig.r, sig.s],
  });
}

type NonceEntry = { state: "inflight" | "done"; txHash?: Hash };

/** Process-local in-flight/done guard keyed by EIP-3009 nonce. */
export class NonceGuard {
  private readonly entries = new Map<string, NonceEntry>();

  /** Returns the existing entry for the nonce, or registers a new inflight one. */
  claim(nonce: string): { claimed: true } | { claimed: false; existing: NonceEntry } {
    const existing = this.entries.get(nonce);
    if (existing) return { claimed: false, existing };
    this.entries.set(nonce, { state: "inflight" });
    return { claimed: true };
  }

  markDone(nonce: string, txHash?: Hash): void {
    this.entries.set(nonce, { state: "done", txHash });
  }

  release(nonce: string): void {
    // Only called when nothing was broadcast (e.g. gas estimation failed) —
    // the authorization is still fresh and may be settled later.
    const entry = this.entries.get(nonce);
    if (entry && entry.state === "inflight") this.entries.delete(nonce);
  }
}

export interface SettleOutcome {
  readonly httpStatus: number;
  readonly body:
    | { readonly success: true; readonly transaction: Hash; readonly transactionHash: Hash; readonly network: string; readonly payer: Address }
    // R8-A4: failure bodies carry the canonical `transaction` REQUIRED by
    // the v2 wire schema — "" when nothing was broadcast, a hash when the
    // broadcast happened but did not land (reverted / receipt unseen).
    | { readonly success: false; readonly errorReason: string; readonly network: string; readonly transaction: string };
}

export class SettleExecutor {
  private readonly guard = new NonceGuard();

  constructor(
    private readonly rpc: ChainRpc,
    private readonly account: PrivateKeyAccount,
    private readonly chain: Chain,
    private readonly network: FacilitatorNetwork,
    private readonly receiptTimeoutMs: number,
  ) {}

  /**
   * Broadcast transferWithAuthorization and wait for the receipt.
   * `payer`/`authorization` come from an already-passed verification.
   */
  async settle(
    payer: Address,
    authorization: VerifiedAuthorization,
    signature: Hex,
  ): Promise<SettleOutcome> {
    const claim = this.guard.claim(authorization.nonce);
    if (!claim.claimed) {
      const reason =
        claim.existing.state === "inflight"
          ? "duplicate_settle_inflight"
          : `duplicate_settle_already_broadcast${claim.existing.txHash ? `:${claim.existing.txHash}` : ""}`;
      // R8-A4: when the original broadcast hash is known, surface it in the
      // canonical field — the caller can reconcile against THAT transaction.
      return { httpStatus: 409, body: { success: false, errorReason: reason, network: this.network.id, transaction: claim.existing.txHash ?? "" } };
    }

    let txHash: Hash | undefined;
    try {
      const { v, r, s } = splitSignature(signature);
      const data = encodeSettleCalldata(
        {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value,
          validAfter: authorization.validAfter,
          validBefore: authorization.validBefore,
          nonce: authorization.nonce,
        },
        { v, r, s },
      );

      const nonce = await this.rpc.getTransactionCount(this.account.address);
      const gas = await this.rpc.estimateGas({ from: this.account.address, to: this.network.usdc, data });
      const fees = await this.rpc.suggestFees();

      txHash = await this.rpc.sendRawTransaction(
        await this.signSettleTx(nonce, gas, fees, data),
      );
    } catch (err) {
      // Nothing was broadcast (gas estimate / nonce / sign / send failed) —
      // release the nonce: a retry with a fresh RPC may succeed.
      this.guard.release(authorization.nonce);
      const detail = err instanceof Error ? err.message : "unknown";
      // Distinguish "RPC down" (ambiguous, 503) from a definitively rejected
      // broadcast (e.g. always-failing tx reverts in estimation → 200).
      if (err instanceof Error && err.name === "RpcUnavailableError") {
        return {
          httpStatus: 503,
          // R8-A4: nothing was broadcast — empty canonical transaction field.
          body: { success: false, errorReason: `broadcast_unavailable:${detail}`, network: this.network.id, transaction: "" },
        };
      }
      return {
        httpStatus: 200,
        // R8-A4: canonical v2 schema-parses 2xx strictly (transaction: z.string())
        // — broadcast rejected = nothing on chain = empty hash.
        body: { success: false, errorReason: `broadcast_rejected:${detail}`, network: this.network.id, transaction: "" },
      };
    }

    this.guard.markDone(authorization.nonce, txHash);

    try {
      const receipt = await this.rpc.waitForReceipt(txHash, this.receiptTimeoutMs);
      if (receipt.status === "success") {
        return {
          httpStatus: 200,
          body: { success: true, transaction: txHash, transactionHash: txHash, network: this.network.id, payer },
        };
      }
      return {
        httpStatus: 200,
        body: { success: false, errorReason: "settle_reverted", network: this.network.id, transaction: txHash },
      };
    } catch {
      // Receipt not seen within budget — ambiguous. The tx may still land.
      return {
        httpStatus: 504,
        body: { success: false, errorReason: "receipt_timeout", network: this.network.id, transaction: txHash },
      };
    }
  }

  private async signSettleTx(
    nonce: number,
    gas: bigint,
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    data: Hex,
  ): Promise<Hex> {
    // LocalAccount.signTransaction signs offline with the account's private
    // key (gas payer) — no client, no network round-trip.
    return this.account.signTransaction({
      to: this.network.usdc,
      data,
      nonce,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      chainId: this.network.chainId,
      type: "eip1559",
    });
  }

  get guardForObservability(): NonceGuard {
    return this.guard;
  }
}

/** viem-backed ChainRpc over plain HTTP JSON-RPC endpoints (native fallback). */
export function createViemRpc(rpcUrls: readonly string[], chain: Chain): ChainRpc {
  const transports = rpcUrls.map((url) => http(url, { timeout: 15_000, retryCount: 1 }));
  const transport = transports.length > 1 ? fallback(transports) : transports[0];
  const publicClient = createPublicClient({ chain, transport });

  return {
    async call(to, data) {
      const result = await publicClient.call({ to, data });
      if (!result.data) throw new Error("eth_call returned no data");
      return result.data;
    },
    async getTransactionCount(address) {
      return publicClient.getTransactionCount({ address, blockTag: "pending" });
    },
    async estimateGas(tx) {
      return publicClient.estimateGas(tx as Parameters<typeof publicClient.estimateGas>[0]);
    },
    async suggestFees() {
      const [block, fees] = await Promise.all([
        publicClient.getBlock(),
        publicClient.estimateFeesPerGas(),
      ]);
      const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 100_000_000n;
      const baseFee = block.baseFeePerGas ?? 50_000_000n;
      const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
      return { maxFeePerGas, maxPriorityFeePerGas };
    },
    async sendRawTransaction(signedTx) {
      return publicClient.sendRawTransaction({ serializedTransaction: signedTx });
    },
    async waitForReceipt(hash, timeoutMs) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs, retryCount: 5, retryDelay: 1_000 });
      return { status: receipt.status === "success" ? "success" : "reverted" };
    },
  };
}
