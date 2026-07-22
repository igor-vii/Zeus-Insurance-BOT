/**
 * Approves ZeusInsuranceV2 to spend an unlimited amount of USDC from the
 * server wallet (SERVER_PRIVATE_KEY). Run once per wallet/network pair.
 *
 * Usage:
 *   npx ts-node --esm scripts/approve-insurance.ts
 */
import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const NETWORK = process.env["ZEUS_INSURANCE_NETWORK"] ?? "base-sepolia";

const CONFIG: Record<string, { rpc: string; usdc: string; insurance: string }> = {
  "base-sepolia": {
    rpc: process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    insurance: process.env["ZEUS_INSURANCE_ADDRESS"] ?? "0x1d9D90d2652296A2c89E3802d45B1F2132b30076",
  },
  "base-mainnet": {
    rpc: process.env["BASE_MAINNET_RPC_URL"] ?? "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    insurance: "", // update after ZeusInsuranceV2 mainnet deployment
  },
};

async function main() {
  const key = process.env["SERVER_PRIVATE_KEY"];
  if (!key) throw new Error("SERVER_PRIVATE_KEY not set");

  const cfg = CONFIG[NETWORK];
  if (!cfg) throw new Error(`Unknown network: ${NETWORK}`);
  if (!cfg.insurance) throw new Error(`ZeusInsuranceV2 address not set for ${NETWORK}`);

  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const wallet = new ethers.Wallet(key, provider);

  const usdc = new ethers.Contract(cfg.usdc, ERC20_ABI, wallet);
  const symbol: string = await usdc.symbol();
  const decimals: number = await usdc.decimals();

  const current: bigint = await usdc.allowance(wallet.address, cfg.insurance);
  console.log(`Network:     ${NETWORK}`);
  console.log(`Wallet:      ${wallet.address}`);
  console.log(`Insurance:   ${cfg.insurance}`);
  console.log(`${symbol} allowance: ${ethers.formatUnits(current, decimals)}`);

  if (current >= ethers.MaxUint256 / 2n) {
    console.log("Allowance already sufficient — nothing to do.");
    return;
  }

  console.log("Approving MaxUint256…");
  const tx = await usdc.approve(cfg.insurance, ethers.MaxUint256);
  console.log(`Tx sent: ${tx.hash}`);
  await tx.wait();
  console.log("Approval confirmed ✓");
}

main().catch((e) => { console.error(e); process.exit(1); });
