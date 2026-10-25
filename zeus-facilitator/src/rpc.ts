/**
 * Zeus facilitator — chain access boundary.
 *
 * Everything the facilitator does on-chain is expressed through this small
 * interface so the entire verification/settle orchestration is unit-testable
 * without network access. The viem-backed implementation at the bottom is a
 * thin adapter kept free of logic (integration risk is covered by typecheck
 * and staging against the real rail, not by hermetic CI).
 */
import type { Address, Hash, Hex } from "viem";

export interface ChainRpc {
  /** eth_call a read-only contract method, returns raw hex return data. */
  call(to: Address, data: Hex): Promise<Hex>;
  /** Next nonce (pending) for the gas payer. */
  getTransactionCount(address: Address): Promise<number>;
  /** Estimate gas for the settlement transaction. */
  estimateGas(tx: { from: Address; to: Address; data: Hex }): Promise<bigint>;
  /** Current gas fee suggestion (max fee / priority in wei). */
  suggestFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  /** Broadcast a signed raw transaction, returns the tx hash. */
  sendRawTransaction(signedTx: Hex): Promise<Hash>;
  /** Wait until the transaction is mined (or throw on receipt timeout). */
  waitForReceipt(hash: Hash, timeoutMs: number): Promise<{ status: "success" | "reverted" }>;
}

export class RpcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcUnavailableError";
  }
}
