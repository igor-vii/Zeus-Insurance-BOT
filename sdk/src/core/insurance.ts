import { Contract, Interface, type TransactionReceipt } from "ethers";
import { ZeusClient } from "./client.js";
import {
  CreatePolicySchema,
  ClaimPayoutSchema,
  GetPolicySchema,
  SubmitObservationSchema,
  ZeusError,
  ZeusNotConnectedError,
  ZeusValidationError,
  ZeusTransactionError,
  ZeusContractError,
  PolicyStatus,
  type TransactionResult,
  type Policy,
  type Observation,
} from "../types/index.js";

/**
 * ZeusInsuranceV2 ABI — covers both the original timeout-based interface
 * and the new oracle/watcher observation interface.
 *
 * getPolicy returns a PolicyStatus enum (uint8) for `status` instead of
 * the three boolean flags (isActive, isPaidOut, isExpired) from v1.
 * The SDK derives the boolean fields from the enum value.
 */
const INSURANCE_ABI = [
  // ── Policy management ──────────────────────────────────────────────────────
  "function buyInsurance(address seller, uint256 amount, uint256 timeoutSeconds, uint256 maxRetries) external",
  "function claimPayout(uint256 policyId) external",
  "function getPolicy(uint256 policyId) external view returns (tuple(address buyer, address seller, uint256 amount, uint256 premium, uint256 retryDeadline, uint256 maxRetries, uint8 status))",
  // ── Oracle observation ─────────────────────────────────────────────────────
  "function submitObservation(uint256 policyId, tuple(bytes32 requestId, uint256 timestamp, uint8 status, bytes32 metadataHash, uint256 nonce, bytes signature) obs) external",
  // ── Watcher management (owner-only) ────────────────────────────────────────
  "function addWatcher(address watcher) external",
  "function removeWatcher(address watcher) external",
  "function getWatchers() external view returns (address[])",
  "function isWatcher(address) external view returns (bool)",
  // ── Events ─────────────────────────────────────────────────────────────────
  "event PolicyCreated(uint256 indexed policyId, address indexed buyer, address indexed seller, uint256 amount, uint256 premium, uint256 retryDeadline)",
  "event PayoutExecuted(uint256 indexed policyId, uint256 amount)",
  "event PolicyExpired(uint256 indexed policyId)",
  "event ObservationSubmitted(bytes32 indexed requestId, address indexed watcher, uint8 status)",
  "event VoteResolved(bytes32 indexed requestId, uint8 decision, uint256 indexed policyId)",
  "event ClaimRejected(uint256 indexed policyId)",
  "event WatcherAdded(address indexed watcher)",
  "event WatcherRemoved(address indexed watcher)",
] as const;

const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
] as const;

/**
 * Premium formula mirrors the contract:
 *   premiumBps = 700 + (maxRetries − 1) × 200
 *   premium    = amount × premiumBps / 10 000
 */
function calcPremium(amount: bigint, maxRetries: number): bigint {
  const bps = 700n + (BigInt(maxRetries) - 1n) * 200n;
  return (amount * bps) / 10_000n;
}

export class ZeusInsurance {
  constructor(private readonly client: ZeusClient) {}

  private getContract(): Contract {
    if (!this.client.isReady()) throw new ZeusNotConnectedError();
    const network = this.client.getNetwork();
    if (!network.insuranceAddress) {
      throw new ZeusContractError(
        `ZeusInsuranceV2 is not deployed on "${network.name}" yet.`,
      );
    }
    return new Contract(network.insuranceAddress, INSURANCE_ABI, this.client.getRunner());
  }

  private buildTxResult(receipt: TransactionReceipt): TransactionResult {
    return {
      hash: receipt.hash,
      status: receipt.status ?? 0,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
    };
  }

  private parseEvent(
    receipt: TransactionReceipt,
    eventName: string,
  ): { args: Record<string, unknown> } | null {
    const iface = new Interface(INSURANCE_ABI);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === eventName) {
          return { args: parsed.args as unknown as Record<string, unknown> };
        }
      } catch {
        // skip non-matching logs
      }
    }
    return null;
  }

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
  async createPolicy(
    seller: string,
    amount: bigint,
    timeout: number,
    retries: number,
  ): Promise<{ policyId: number; tx: TransactionResult }> {
    const parsed = CreatePolicySchema.safeParse({ seller, amount, timeout, retries });
    if (!parsed.success) {
      throw new ZeusValidationError(
        "Invalid parameters for createPolicy",
        parsed.error.issues,
      );
    }

    const network = this.client.getNetwork();
    if (!network.usdcAddress) {
      throw new ZeusContractError(`USDC address not configured for "${network.name}".`);
    }

    const contract = this.getContract();
    const premium = calcPremium(parsed.data.amount, parsed.data.retries);

    // --- Approve USDC premium transfer if allowance is insufficient ---
    try {
      const usdc = new Contract(network.usdcAddress, USDC_ABI, this.client.getRunner());
      const owner = this.client.getAddress();
      const allowance: bigint = await usdc.allowance(owner, network.insuranceAddress);
      if (allowance < premium) {
        const approveTx = await usdc.approve(network.insuranceAddress, premium);
        await approveTx.wait();
      }
    } catch (err) {
      if (err instanceof ZeusError) throw err;
      throw new ZeusTransactionError(
        `USDC approval failed: ${(err as Error).message}`,
        undefined,
        err,
      );
    }

    // --- Call buyInsurance on-chain ---
    try {
      const tx = await contract.buyInsurance(
        parsed.data.seller,
        parsed.data.amount,
        BigInt(parsed.data.timeout),
        BigInt(parsed.data.retries),
      );
      const receipt: TransactionReceipt | null = await tx.wait();
      if (!receipt) {
        throw new ZeusTransactionError(
          "Transaction was submitted but no receipt was received.",
        );
      }
      if (receipt.status === 0) {
        throw new ZeusTransactionError("Transaction reverted.", receipt.hash);
      }

      const event = this.parseEvent(receipt, "PolicyCreated");
      if (!event) {
        throw new ZeusTransactionError(
          "PolicyCreated event not found in transaction logs.",
          receipt.hash,
        );
      }

      return {
        policyId: Number(event.args["policyId"]),
        tx: this.buildTxResult(receipt),
      };
    } catch (err) {
      if (err instanceof ZeusError) throw err;
      throw new ZeusTransactionError(
        `Failed to create insurance policy: ${(err as Error).message}`,
        undefined,
        err,
      );
    }
  }

  /**
   * Claim a USDC payout once the retryDeadline has passed.
   * Only the policy buyer can call this.
   */
  async claimPayout(policyId: number): Promise<TransactionResult> {
    const parsed = ClaimPayoutSchema.safeParse({ policyId });
    if (!parsed.success) {
      throw new ZeusValidationError(
        "Invalid parameters for claimPayout",
        parsed.error.issues,
      );
    }

    const contract = this.getContract();

    try {
      const tx = await contract.claimPayout(BigInt(parsed.data.policyId));
      const receipt: TransactionReceipt | null = await tx.wait();
      if (!receipt) {
        throw new ZeusTransactionError(
          "Transaction was submitted but no receipt was received.",
        );
      }
      if (receipt.status === 0) {
        throw new ZeusTransactionError("Transaction reverted.", receipt.hash);
      }
      return this.buildTxResult(receipt);
    } catch (err) {
      if (err instanceof ZeusError) throw err;
      throw new ZeusTransactionError(
        `Failed to claim payout: ${(err as Error).message}`,
        undefined,
        err,
      );
    }
  }

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
  async submitObservation(
    policyId: number,
    observation: Observation,
  ): Promise<TransactionResult> {
    const parsed = SubmitObservationSchema.safeParse({ policyId, observation });
    if (!parsed.success) {
      throw new ZeusValidationError(
        "Invalid parameters for submitObservation",
        parsed.error.issues,
      );
    }

    const contract = this.getContract();
    const obs = parsed.data.observation;

    try {
      const tx = await contract.submitObservation(BigInt(parsed.data.policyId), {
        requestId:    obs.requestId,
        timestamp:    BigInt(obs.timestamp),
        status:       obs.status,
        metadataHash: obs.metadataHash,
        nonce:        BigInt(obs.nonce),
        signature:    obs.signature,
      });
      const receipt: TransactionReceipt | null = await tx.wait();
      if (!receipt) {
        throw new ZeusTransactionError(
          "Transaction was submitted but no receipt was received.",
        );
      }
      if (receipt.status === 0) {
        throw new ZeusTransactionError("Transaction reverted.", receipt.hash);
      }
      return this.buildTxResult(receipt);
    } catch (err) {
      if (err instanceof ZeusError) throw err;
      throw new ZeusTransactionError(
        `Failed to submit observation: ${(err as Error).message}`,
        undefined,
        err,
      );
    }
  }

  /** Read policy state from chain. */
  async getPolicy(policyId: number): Promise<Policy> {
    const parsed = GetPolicySchema.safeParse({ policyId });
    if (!parsed.success) {
      throw new ZeusValidationError(
        "Invalid parameters for getPolicy",
        parsed.error.issues,
      );
    }

    const contract = this.getContract();

    try {
      const p = await contract.getPolicy(BigInt(parsed.data.policyId));
      const status = Number(p.status) as PolicyStatus;
      return {
        id: parsed.data.policyId,
        buyer: String(p.buyer),
        seller: String(p.seller),
        amount: BigInt(p.amount),
        premium: BigInt(p.premium),
        retryDeadline: Number(p.retryDeadline),
        maxRetries: Number(p.maxRetries),
        status,
        isActive:  status === PolicyStatus.Active,
        isPaidOut: status === PolicyStatus.Claimed,
        isExpired: status === PolicyStatus.Expired,
      };
    } catch (err) {
      if (err instanceof ZeusError) throw err;
      throw new ZeusTransactionError(
        `Failed to fetch policy: ${(err as Error).message}`,
        undefined,
        err,
      );
    }
  }
}
