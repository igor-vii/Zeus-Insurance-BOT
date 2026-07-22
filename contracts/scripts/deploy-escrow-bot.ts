import { ethers } from "hardhat";

/**
 * Deploy ZeusEscrowBOT to the local Hardhat network (or any configured network).
 *
 * Usage — local:
 *   pnpm --filter @workspace/contracts run deploy:escrow-local
 *
 * Usage — Base Sepolia:
 *   TOKEN_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
 *   pnpm --filter @workspace/contracts run deploy:escrow-baseSepolia
 *
 * Environment variables:
 *   TOKEN_ADDRESS  — ERC-20 token the escrow will hold (required for live networks;
 *                    omit on local and a fresh MockERC20 is deployed automatically).
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer available — check PRIVATE_KEY");

  console.log("Deployer:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance: ", ethers.formatEther(balance), "ETH\n");

  // ── Token ─────────────────────────────────────────────────────────────────
  let tokenAddress = process.env["TOKEN_ADDRESS"]?.trim();

  if (!tokenAddress) {
    console.log("TOKEN_ADDRESS not set — deploying MockERC20 for local testing…");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mock = await MockERC20.deploy("Mock BOT Token", "BOT", 18);
    await mock.waitForDeployment();
    tokenAddress = await mock.getAddress();
    console.log("MockERC20 deployed to:", tokenAddress);

    // Mint 1 000 000 tokens to the deployer for convenience
    const amount = ethers.parseUnits("1000000", 18);
    await mock.mint(deployer.address, amount);
    console.log("Minted 1 000 000 BOT to deployer for testing\n");
  } else {
    if (!ethers.isAddress(tokenAddress)) {
      throw new Error(`Invalid TOKEN_ADDRESS: "${tokenAddress}"`);
    }
    console.log("Using token:", tokenAddress, "\n");
  }

  // ── Treasury ──────────────────────────────────────────────────────────────
  const treasuryAddress = process.env["TREASURY_ADDRESS"]?.trim() ?? "";
  if (treasuryAddress) {
    if (!ethers.isAddress(treasuryAddress)) {
      throw new Error(`Invalid TREASURY_ADDRESS: "${treasuryAddress}"`);
    }
    console.log("Treasury (fee recipient):", treasuryAddress);
  } else {
    console.log("TREASURY_ADDRESS not set — deploying without fees (treasury = address(0))");
  }

  // ── ZeusEscrowBOT ─────────────────────────────────────────────────────────
  console.log("\nDeploying ZeusEscrowBOT…");
  const ZeusEscrowBOT = await ethers.getContractFactory("ZeusEscrowBOT");
  const escrow = await ZeusEscrowBOT.deploy(tokenAddress, treasuryAddress || ethers.ZeroAddress);
  await escrow.waitForDeployment();

  const escrowAddress = await escrow.getAddress();
  console.log("ZeusEscrowBOT deployed to:", escrowAddress);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n─── Deployment complete ───────────────────────────────────");
  console.log("Token:         ", tokenAddress);
  console.log("ZeusEscrowBOT: ", escrowAddress);
  console.log("\nNext steps:");
  console.log("  1. Approve the escrow contract to spend your tokens.");
  console.log(
    "  2. Call depositAndCreateAgreement(executor, amount, timeoutSeconds)."
  );
  console.log(
    "  3. Executor calls confirmExecution(agreementId, proof) to claim funds,"
  );
  console.log(
    "     or wait for timeout and call requestRefund(agreementId)."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
