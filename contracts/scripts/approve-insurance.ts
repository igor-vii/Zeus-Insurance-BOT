/**
 * Approves ZeusInsuranceV2 to spend an unlimited amount of USDC from the
 * server wallet (SERVER_PRIVATE_KEY). Run once per wallet/network pair.
 *
 * Usage:
 *   pnpm --filter @workspace/contracts exec hardhat run scripts/approve-insurance.ts --network base-sepolia
 */
import { ethers } from "hardhat";
import * as hre from "hardhat";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const INSURANCE_ADDRESS =
  process.env["ZEUS_INSURANCE_ADDRESS"] ?? "0x1d9D90d2652296A2c89E3802d45B1F2132b30076";

const USDC: Record<string, string> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

async function main() {
  const network = hre.network.name;
  const usdcAddress = USDC[network];
  if (!usdcAddress) throw new Error(`No USDC address for network: ${network}`);
  if (!INSURANCE_ADDRESS) throw new Error("ZEUS_INSURANCE_ADDRESS not set");

  const [signer] = await ethers.getSigners();
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer);

  const symbol: string = await usdc.symbol();
  const decimals: number = await usdc.decimals();
  const current: bigint = await usdc.allowance(signer.address, INSURANCE_ADDRESS);

  console.log(`Network:    ${network}`);
  console.log(`Wallet:     ${signer.address}`);
  console.log(`Insurance:  ${INSURANCE_ADDRESS}`);
  console.log(`Allowance:  ${ethers.formatUnits(current, decimals)} ${symbol}`);

  if (current >= ethers.MaxUint256 / 2n) {
    console.log("Allowance already sufficient — nothing to do.");
    return;
  }

  console.log("Approving MaxUint256…");
  const tx = await usdc.approve(INSURANCE_ADDRESS, ethers.MaxUint256);
  console.log(`Tx sent:    ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt?.blockNumber} ✓`);
}

main().catch((e) => { console.error(e); process.exit(1); });
