import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

// ── Defaults (Base Sepolia) ───────────────────────────────────────────────────
const USDC_BASE_SEPOLIA    = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RESERVE_BASE_SEPOLIA = "0xF5010Afe1856be1F447f962Dfa8AA30c2Ed19a47";

/**
 * Comma-separated list of initial watcher addresses.
 * Override via WATCHER_ADDRESSES env var, e.g.:
 *   WATCHER_ADDRESSES=0xABC,0xDEF npx hardhat run scripts/deploy-insurance-v2.ts --network base-sepolia
 */
const DEFAULT_WATCHERS: string[] = [];

async function main() {
  console.log("🚀 Starting deployment of ZeusInsuranceV2 (with oracle support)...\n");

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — set PRIVATE_KEY in contracts/.env");

  console.log(`📡 Deployer:  ${deployer.address}`);
  const balance = await deployer.provider.getBalance(deployer.address);
  console.log(`💰 Balance:   ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) throw new Error("Deployer has 0 ETH — top up before deploying");

  const usdcAddress    = process.env["USDC_ADDRESS"]    ?? USDC_BASE_SEPOLIA;
  const reserveAddress = process.env["RESERVE_ADDRESS"] ?? RESERVE_BASE_SEPOLIA;

  if (!ethers.isAddress(usdcAddress))    throw new Error(`Invalid USDC_ADDRESS: ${usdcAddress}`);
  if (!ethers.isAddress(reserveAddress)) throw new Error(`Invalid RESERVE_ADDRESS: ${reserveAddress}`);

  console.log(`\n  USDC:    ${usdcAddress}`);
  console.log(`  Reserve: ${reserveAddress}`);

  // ── 1. Deploy ZeusInsuranceV2 ─────────────────────────────────────────────
  console.log("\n📦 Deploying ZeusInsuranceV2...");
  const ZeusInsuranceV2 = await ethers.getContractFactory("ZeusInsuranceV2");
  const insurance = await ZeusInsuranceV2.deploy(usdcAddress, reserveAddress);
  await insurance.waitForDeployment();

  const insuranceAddress = await insurance.getAddress();
  console.log(`✅ ZeusInsuranceV2 deployed to: ${insuranceAddress}`);

  // ── 2. Register initial watchers ──────────────────────────────────────────
  const watcherEnv = process.env["WATCHER_ADDRESSES"] ?? "";
  const watchers = watcherEnv
    ? watcherEnv.split(",").map(w => w.trim()).filter(Boolean)
    : DEFAULT_WATCHERS;

  if (watchers.length > 0) {
    console.log(`\n👁️  Registering ${watchers.length} watcher(s)...`);
    for (const watcher of watchers) {
      if (!ethers.isAddress(watcher)) {
        console.log(`  ⚠️  Skipping invalid address: ${watcher}`);
        continue;
      }
      const tx = await insurance.addWatcher(watcher);
      await tx.wait();
      console.log(`  ✅ Added watcher: ${watcher}`);
      // Small delay to avoid in-flight tx limit on public RPCs
      await new Promise(r => setTimeout(r, 1500));
    }
  } else {
    console.log("\n⚠️  No watchers configured. Add them later with addWatcher().");
    console.log("    Set WATCHER_ADDRESSES=0x...,0x... to register during deployment.");
  }

  // ── 3. Verify on BaseScan ─────────────────────────────────────────────────
  console.log("\n🔍 Verifying on BaseScan (Etherscan V2 API)...");
  try {
    const hre = await import("hardhat");
    await hre.run("verify:verify", {
      address: insuranceAddress,
      constructorArguments: [usdcAddress, reserveAddress],
    });
    console.log("✅ Contract verified on BaseScan");
  } catch (error) {
    console.log("⚠️  Verification failed (may already be verified):", (error as Error).message);
  }

  // ── 4. Update SDK types with new address ──────────────────────────────────
  console.log("\n📝 Updating SDK (sdk/src/types/index.ts)...");
  const sdkTypesPath = path.join(__dirname, "../../sdk/src/types/index.ts");

  if (fs.existsSync(sdkTypesPath)) {
    let sdkContent = fs.readFileSync(sdkTypesPath, "utf8");
    sdkContent = sdkContent.replace(
      /(escrowAddress:.*\n.*insuranceAddress:\s*)"[^"]*"/,
      `$1"${insuranceAddress}"`
    );
    fs.writeFileSync(sdkTypesPath, sdkContent);
    console.log(`✅ SDK updated: base-sepolia insuranceAddress = ${insuranceAddress}`);
  } else {
    console.log(`⚠️  SDK types not found at ${sdkTypesPath} — update manually`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n🎉 Deployment complete!");
  console.log("─────────────────────────────────────────────────");
  console.log(`ZeusInsuranceV2:  ${insuranceAddress}`);
  console.log(`ZeusReserveV2:    ${reserveAddress}  (existing)`);
  console.log(`USDC:             ${usdcAddress}`);
  console.log("─────────────────────────────────────────────────");
  console.log("\nNext steps:");
  console.log("  1. Call ZeusReserveV2.setInsuranceContract(" + insuranceAddress + ")");
  console.log("  2. Update ZEUS_INSURANCE_ADDRESS in api-server env");
  console.log("  3. Rebuild SDK:  cd sdk && pnpm build");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
