/**
 * Approves ZeusEscrowBOT to spend an unlimited amount of USDC from the
 * server wallet (SERVER_PRIVATE_KEY). Run once per wallet/network pair.
 *
 * Usage:
 *   pnpm --filter @workspace/contracts exec hardhat run scripts/approve-escrow.ts --network base-mainnet
 *   pnpm --filter @workspace/contracts exec hardhat run scripts/approve-escrow.ts --network base-sepolia
 */
import { ethers } from "hardhat";
import * as hre from "hardhat";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const ESCROW: Record<string, string> = {
  "base-mainnet": "0x8D10C2c6C92b613C1938fe532f0e391044e76188",
  "base-sepolia": process.env["ZEUS_ESCROW_BOT_ADDRESS"] ?? "0x87365462353bCBAB2CF0DF57c7Cb15519C5B7c76",
};

const USDC: Record<string, string> = {
  "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

async function main() {
  const network = hre.network.name;
  const usdcAddress = USDC[network];
  const escrowAddress = ESCROW[network];
  if (!usdcAddress) throw new Error(`No USDC address for network: ${network}`);
  if (!escrowAddress) throw new Error(`No escrow address for network: ${network}`);

  const [signer] = await ethers.getSigners();
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer);

  const symbol: string = await usdc.symbol();
  const decimals: number = await usdc.decimals();
  const current: bigint = await usdc.allowance(signer.address, escrowAddress);

  console.log(`Network:   ${network}`);
  console.log(`Wallet:    ${signer.address}`);
  console.log(`Escrow:    ${escrowAddress}`);
  console.log(`Allowance: ${ethers.formatUnits(current, decimals)} ${symbol}`);

  if (current >= ethers.MaxUint256 / 2n) {
    console.log("Allowance already sufficient — nothing to do.");
    return;
  }

  console.log("Approving MaxUint256…");
  const tx = await usdc.approve(escrowAddress, ethers.MaxUint256);
  console.log(`Tx sent:   ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt?.blockNumber} ✓`);
}

main().catch((e) => { console.error(e); process.exit(1); });
