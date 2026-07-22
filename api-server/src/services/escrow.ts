import { ethers } from "ethers";
import { ZeusSDK } from "@zeus/sdk";

const SERVER_PRIVATE_KEY = process.env["SERVER_PRIVATE_KEY"];

const RPC_URLS: Record<string, string> = {
  "base-mainnet": process.env["BASE_MAINNET_RPC_URL"] ?? "https://mainnet.base.org",
  "base-sepolia": process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org",
};

// Which network the escrow contract runs on.
// Defaults to base-mainnet now that ZeusEscrowBOT is deployed there.
const ZEUS_ESCROW_NETWORK =
  (process.env["ZEUS_ESCROW_NETWORK"] ?? process.env["ZEUS_NETWORK"] ?? "base-mainnet") as
    | "base-mainnet"
    | "base-sepolia";

/**
 * Returns true when the server can sign escrow transactions automatically.
 */
export function isEscrowAutomaticModeAvailable(): boolean {
  return Boolean(SERVER_PRIVATE_KEY);
}

/**
 * Automatic mode — server signs and broadcasts depositAndCreateAgreement
 * on behalf of an agent. The server wallet must have pre-approved the
 * ZeusEscrowBOT contract to spend USDC (run scripts/approve-escrow.ts once).
 *
 * @returns agreementId and the transaction hash.
 */
export async function createEscrowAgreement(params: {
  executor: string;
  amount: bigint;
  timeout: number;
}): Promise<{ agreementId: number; txHash: string }> {
  if (!SERVER_PRIVATE_KEY) {
    throw new Error("SERVER_PRIVATE_KEY is not configured — automatic escrow mode unavailable");
  }

  const rpcUrl = RPC_URLS[ZEUS_ESCROW_NETWORK] ?? RPC_URLS["base-mainnet"]!;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(SERVER_PRIVATE_KEY, provider);

  const sdk = new ZeusSDK();
  await sdk.connect(ZEUS_ESCROW_NETWORK, signer);

  const result = await sdk.escrow.depositAndCreateAgreement(
    params.executor,
    params.amount,
    params.timeout,
  );

  return {
    agreementId: result.agreementId,
    txHash: result.tx.hash,
  };
}
