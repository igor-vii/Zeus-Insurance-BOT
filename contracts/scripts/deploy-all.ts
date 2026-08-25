import { ethers, run, network } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Deploy all Zeus contracts to the target network.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-all.ts --network xlayer
 *   npx hardhat run scripts/deploy-all.ts --network xlayer-testnet
 *   npx hardhat run scripts/deploy-all.ts --network base-sepolia
 *
 * Required env vars:
 *   PRIVATE_KEY        — deployer wallet private key
 *   USDC_ADDRESS       — USDC token address on the target network
 *   TOKEN_ADDRESS      — ERC-20 token for ZeusEscrowBOT (can equal USDC_ADDRESS)
 *
 * Optional env vars:
 *   TREASURY_ADDRESS   — fee recipient for escrow (defaults to deployer)
 *   WATCHER_ADDRESSES  — comma-separated watcher addresses for ZeusInsuranceV2
 *   OKLINK_API_KEY     — for X Layer contract verification
 *   ETHERSCAN_API_KEY  — for Base contract verification
 */

// ── X Layer USDC-equivalent addresses ────────────────────────────────────────
// OKB (native token bridged as ERC-20 on X Layer) or OKX-bridged USDC
const XLAYER_USDC = process.env.USDC_ADDRESS ?? "";
const XLAYER_TOKEN = process.env.TOKEN_ADDRESS ?? XLAYER_USDC;

async function verify(address: string, constructorArgs: unknown[]) {
  try {
    await run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    console.log(`  ✅ Verified: ${address}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Already Verified") || msg.includes("already verified")) {
      console.log(`  ℹ️  Already verified: ${address}`);
    } else {
      console.log(`  ⚠️  Verification skipped: ${msg}`);
    }
  }
}

async function main() {
  const net = network.name;
  console.log(`\n🚀 Zeus full deployment — network: ${net}`);
  console.log("─────────────────────────────────────────────────────────────\n");

  // ── Signer ────────────────────────────────────────────────────────────────
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — set PRIVATE_KEY in env");

  const balance = await deployer.provider.getBalance(deployer.address);
  console.log(`📡 Deployer: ${deployer.address}`);
  console.log(`💰 Balance:  ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) throw new Error("Deployer balance is 0 — fund the wallet first");

  // ── Validate required addresses ───────────────────────────────────────────
  const usdcAddress = net.startsWith("xlayer") ? XLAYER_USDC : process.env.USDC_ADDRESS ?? "";
  const tokenAddress = net.startsWith("xlayer") ? XLAYER_TOKEN : process.env.TOKEN_ADDRESS ?? usdcAddress;
  const treasuryAddress = process.env.TREASURY_ADDRESS?.trim() || deployer.address;

  if (!ethers.isAddress(usdcAddress)) {
    throw new Error(
      `USDC_ADDRESS is missing or invalid: "${usdcAddress}"\n` +
      `  Set USDC_ADDRESS to the USDC (or equivalent stablecoin) contract on ${net}.`
    );
  }
  if (!ethers.isAddress(tokenAddress)) {
    throw new Error(`TOKEN_ADDRESS is missing or invalid: "${tokenAddress}"`);
  }

  console.log(`\n  USDC:     ${usdcAddress}`);
  console.log(`  Token:    ${tokenAddress}`);
  console.log(`  Treasury: ${treasuryAddress}\n`);

  // ── 1. Deploy ZeusReserveV2 ───────────────────────────────────────────────
  console.log("📦 [1/3] Deploying ZeusReserveV2...");
  const ZeusReserveV2 = await ethers.getContractFactory("ZeusReserveV2");
  const reserve = await ZeusReserveV2.deploy(usdcAddress, deployer.address);
  await reserve.waitForDeployment();
  const reserveAddress = await reserve.getAddress();
  console.log(`  ✅ ZeusReserveV2:    ${reserveAddress}`);

  // ── 2. Deploy ZeusInsuranceV2 ─────────────────────────────────────────────
  console.log("\n📦 [2/3] Deploying ZeusInsuranceV2...");
  const ZeusInsuranceV2 = await ethers.getContractFactory("ZeusInsuranceV2");
  const insurance = await ZeusInsuranceV2.deploy(usdcAddress, reserveAddress);
  await insurance.waitForDeployment();
  const insuranceAddress = await insurance.getAddress();
  console.log(`  ✅ ZeusInsuranceV2:  ${insuranceAddress}`);

  // Wire reserve → insurance
  console.log("  🔗 Linking reserve → insurance...");
  const linkTx = await reserve.setInsuranceContract(insuranceAddress);
  await linkTx.wait();
  console.log("  ✅ Reserve linked to insurance");

  // Register optional watchers
  const watcherEnv = process.env.WATCHER_ADDRESSES ?? "";
  const watchers = watcherEnv ? watcherEnv.split(",").map((w) => w.trim()).filter(Boolean) : [];
  if (watchers.length > 0) {
    console.log(`\n  👁️  Registering ${watchers.length} watcher(s)...`);
    for (const w of watchers) {
      if (!ethers.isAddress(w)) { console.log(`  ⚠️  Skipping invalid: ${w}`); continue; }
      const tx = await insurance.addWatcher(w);
      await tx.wait();
      console.log(`  ✅ Watcher: ${w}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // ── 3. Deploy ZeusEscrowBOT ───────────────────────────────────────────────
  console.log("\n📦 [3/3] Deploying ZeusEscrowBOT...");
  const ZeusEscrowBOT = await ethers.getContractFactory("ZeusEscrowBOT");
  const escrow = await ZeusEscrowBOT.deploy(tokenAddress, treasuryAddress);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log(`  ✅ ZeusEscrowBOT:    ${escrowAddress}`);

  // ── 4. Verify contracts ───────────────────────────────────────────────────
  console.log("\n🔍 Verifying contracts...");
  // Small delay to allow block explorer indexing
  await new Promise((r) => setTimeout(r, 10000));
  await verify(reserveAddress, [usdcAddress, deployer.address]);
  await verify(insuranceAddress, [usdcAddress, reserveAddress]);
  await verify(escrowAddress, [tokenAddress, treasuryAddress]);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n🎉 Deployment complete!");
  console.log("─────────────────────────────────────────────────────────────");
  console.log(`Network:          ${net}`);
  console.log(`ZeusReserveV2:    ${reserveAddress}`);
  console.log(`ZeusInsuranceV2:  ${insuranceAddress}`);
  console.log(`ZeusEscrowBOT:    ${escrowAddress}`);
  console.log(`USDC:             ${usdcAddress}`);
  console.log(`Token:            ${tokenAddress}`);
  console.log("─────────────────────────────────────────────────────────────");
  console.log("\nNext steps:");
  console.log("  1. Set ZEUS_INSURANCE_ADDRESS=" + insuranceAddress + " in api-server env");
  console.log("  2. Set ZEUS_ESCROW_BOT_ADDRESS=" + escrowAddress + " in api-server env");
  console.log("  3. Fund ZeusReserveV2 with USDC: reserve.deposit(amount)");
  console.log("  4. Update SDK network config with new addresses");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
