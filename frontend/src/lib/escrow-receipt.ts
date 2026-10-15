import type { TransactionReceipt } from "viem";

/**
 * Throws unless the deposit transaction succeeded on-chain.
 * waitForTransactionReceipt resolves (does not throw) on a revert, so the status must be checked explicitly.
 */
export function assertDepositReceiptSuccess(
  receipt: Pick<TransactionReceipt, "status" | "transactionHash">,
): void {
  if (receipt.status !== "success") {
    throw new Error(
      `Transaction reverted on-chain (${receipt.transactionHash}). No agreement was created and no funds were locked.`,
    );
  }
}
