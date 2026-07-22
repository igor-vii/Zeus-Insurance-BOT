import { ethers } from "ethers";
import { encodeFunctionData } from "viem";
import { ZeusSDK } from "@zeus/sdk";
import { ZEUS_INSURANCE_ADDRESS, ZEUS_INSURANCE_ABI } from "../lib/contracts-server.js";

const SERVER_PRIVATE_KEY = process.env["SERVER_PRIVATE_KEY"];
// ZEUS_INSURANCE_NETWORK controls which chain the insurance contract lives on.
// Defaults to base-sepolia until ZeusInsuranceV2 is deployed on mainnet.
const ZEUS_NETWORK =
  process.env["ZEUS_INSURANCE_NETWORK"] ?? process.env["ZEUS_NETWORK"] ?? "base-sepolia";

const RPC_URLS: Record<string, string> = {
  "base-mainnet": process.env["BASE_MAINNET_RPC_URL"] ?? "https://mainnet.base.org",
  "base-sepolia": process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org",
};

/**
 * Returns true when the server has a private key configured and can
 * broadcast transactions on behalf of an agent (automatic mode).
 */
export function isAutomaticModeAvailable(): boolean {
  return Boolean(SERVER_PRIVATE_KEY);
}

/**
 * Automatic mode — the API server signs and broadcasts the buyInsurance
 * transaction on behalf of the agent.
 *
 * Prerequisites:
 *  - SERVER_PRIVATE_KEY env var must be set (server wallet with USDC).
 *  - The chosen network must have ZeusInsuranceV2 deployed.
 *
 * @returns policyId and the transaction hash.
 */
export async function createPolicyFromServer(params: {
  seller: string;
  amount: bigint;
  timeout: number;
  retries: number;
}): Promise<{ policyId: number; txHash: string }> {
  if (!SERVER_PRIVATE_KEY) {
    throw new Error("SERVER_PRIVATE_KEY is not configured — automatic mode unavailable");
  }

  const rpcUrl = RPC_URLS[ZEUS_NETWORK] ?? RPC_URLS["base-sepolia"]!;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(SERVER_PRIVATE_KEY, provider);

  const sdk = new ZeusSDK();
  await sdk.connect(ZEUS_NETWORK, signer);

  const result = await sdk.insurance.createPolicy(
    params.seller,
    params.amount,
    params.timeout,
    params.retries,
  );

  return {
    policyId: result.policyId,
    txHash: result.tx.hash,
  };
}

/**
 * Hybrid mode — encode calldata for claimPayout so the agent can sign and
 * broadcast the transaction itself.
 *
 * @param policyId  The policy to claim against (on-chain ID).
 * @returns         `to` (contract address) and `data` (ABI-encoded calldata).
 */
export function prepareClaimCalldata(policyId: bigint): { to: string; data: string } {
  const data = encodeFunctionData({
    abi: ZEUS_INSURANCE_ABI,
    functionName: "claimPayout",
    args: [policyId],
  });
  return { to: ZEUS_INSURANCE_ADDRESS, data };
}
