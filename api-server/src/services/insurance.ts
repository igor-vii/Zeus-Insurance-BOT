import { ethers } from "ethers";
import { encodeFunctionData } from "viem";
import {
  ZEUS_INSURANCE_ABI,
  SUPPORTED_NETWORKS,
  getInsuranceAddress,
  computePremium,
} from "../lib/contracts-server.js";

const SERVER_PRIVATE_KEY = process.env["SERVER_PRIVATE_KEY"];
const ZEUS_NETWORK = process.env["ZEUS_INSURANCE_NETWORK"] ?? process.env["ZEUS_NETWORK"] ?? "x-layer";

const RPC_URLS: Record<string, string> = {
  "base-mainnet": process.env["BASE_MAINNET_RPC_URL"] ?? "https://mainnet.base.org",
  "base-sepolia": process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org",
  "x-layer": process.env["XLAYER_MAINNET_RPC_URL"] ?? "https://rpc.xlayer.tech",
  "bot-chain": process.env["BOT_CHAIN_RPC_URL"] ?? "https://rpc.botchain.ai",
};

export function isAutomaticModeAvailable(): boolean {
  return Boolean(SERVER_PRIVATE_KEY);
}

function getProvider(network: string = ZEUS_NETWORK) {
  const url = RPC_URLS[network];
  if (!url) throw new Error(`No RPC for network: ${network}`);
  return new ethers.JsonRpcProvider(url);
}

/** Automatic mode — server broadcasts buyPolicy on behalf of AI agent */
export async function createPolicyFromServer(params: {
  seller: string;
  amount: bigint;
  timeout: number;
  retries: number;
  network?: string;
}): Promise<{ policyId: number; txHash: string }> {
  if (!SERVER_PRIVATE_KEY) throw new Error("SERVER_PRIVATE_KEY not configured");

  const network = params.network ?? ZEUS_NETWORK;
  const provider = getProvider(network);
  const signer = new ethers.Wallet(SERVER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(getInsuranceAddress(network as any), ZEUS_INSURANCE_ABI, signer);

  const premium = computePremium(params.amount, params.retries);
  const tx = await contract.buyPolicy(
    params.seller,
    params.amount,
    params.timeout,
    params.retries,
    premium
  );
  const receipt = await tx.wait();

  // Parse PolicyCreated event for policyId
  const iface = new ethers.Interface(ZEUS_INSURANCE_ABI as any);
  const log = receipt.logs.find((l: any) => {
    try { return iface.parseLog({ topics: l.topics, data: l.data })?.name === "PolicyCreated"; }
    catch { return false; }
  });
  const policyId = log ? Number(log.topics[1]) : 0;

  return { policyId, txHash: tx.hash };
}

/** Automatic mode — SlashingProtection policy */
export async function createSlashingProtectionFromServer(params: {
  validator: string;
  amount: bigint;
  timeout: number;
  network?: string;
}): Promise<{ policyId: number; txHash: string }> {
  if (!SERVER_PRIVATE_KEY) throw new Error("SERVER_PRIVATE_KEY not configured");

  const network = params.network ?? ZEUS_NETWORK;
  const provider = getProvider(network);
  const signer = new ethers.Wallet(SERVER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(getInsuranceAddress(network as any), ZEUS_INSURANCE_ABI, signer);

  const premium = (params.amount * 500n) / 10_000n; // 5% for slashing
  const tx = await contract.buySlashingProtection(
    params.validator,
    params.amount,
    params.timeout,
    premium
  );
  const receipt = await tx.wait();

  const iface = new ethers.Interface(ZEUS_INSURANCE_ABI as any);
  const log = receipt.logs.find((l: any) => {
    try { return iface.parseLog({ topics: l.topics, data: l.data })?.name === "PolicyCreated"; }
    catch { return false; }
  });
  const policyId = log ? Number(log.topics[1]) : 0;

  return { policyId, txHash: tx.hash };
}

/** Hybrid mode — calldata for agent to sign itself */
export function prepareBuyCalldata(params: {
  seller: `0x${string}`;
  amount: bigint;
  timeoutSeconds: number;
  maxRetries: number;
  premium: bigint;
  network?: string;
}): { to: `0x${string}`; data: `0x${string}` } {
  const data = encodeFunctionData({
    abi: ZEUS_INSURANCE_ABI,
    functionName: "buyPolicy",
    args: [
      params.seller,
      params.amount,
      BigInt(params.timeoutSeconds),
      BigInt(params.maxRetries),
      params.premium,
    ],
  });
  return { to: getInsuranceAddress((params
