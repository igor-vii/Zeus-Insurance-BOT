import type { Hex, TransactionReceipt } from "viem";

/**
 * Throws unless `to` is the expected escrow contract and has bytecode on-chain.
 * getCode returns undefined (not "0x") for an address without code, so all empty forms are rejected.
 */
export function assertDepositTarget(
  to: string,
  expectedEscrow: string,
  code: Hex | "" | undefined,
): void {
  if (to.toLowerCase() !== expectedEscrow.toLowerCase()) {
    throw new Error(
      `Unexpected escrow address ${to} (expected ${expectedEscrow}). Deposit refused, no funds were sent.`,
    );
  }
  if (!code || code === "0x") {
    throw new Error(
      `No contract deployed at ${to} on BOT Chain. Deposit refused, no funds were sent.`,
    );
  }
}

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
