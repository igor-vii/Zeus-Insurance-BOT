/**
 * Post-deploy setup script for ZeusInsuranceV2.
 *
 * Usage:
 *   INSURANCE_ADDRESS=0x... \
 *   WATCHER_ADDRESSES=0xA,0xB,0xC \
 *   npx hardhat run scripts/post-deploy-setup.ts --network base-sepolia
 */
import { ethers } from "hardhat";

const RESERVE_ADDRESS = "0xF5010Afe1856be1F447f962Dfa8AA30c2Ed19a47";

async function main() {
  const insuranceAddress = process.env["INSURANCE_ADDRESS"];
  if (!insuranceAddress || !ethers.isAddress(insuranceAddress)) {
    throw new Error("Set INSURANCE_ADDRESS env var to the deployed ZeusInsuranceV2 address");
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — set PRIVATE_KEY");

  console.log(`\nDeployer:  ${deployer.address}`);
  console.log(`Insurance: ${insuranceAddress}`);
  console.log(`Reserve:   ${RESERVE_ADDRESS}\n`);

  const insurance = await ethers.getContractAt("ZeusInsuranceV2", insuranceAddress, deployer);
  const reserve   = await ethers.getContractAt("ZeusReserveV2",   RESERVE_ADDRESS,   deployer);

  // ── 1. Register watchers ──────────────────────────────────────────────────
  const watcherEnv = process.env["WATCHER_ADDRESSES"] ?? "";
  const watchers   = watcherEnv.split(",").map(w => w.trim()).filter(Boolean);

  if (watchers.length === 0) {
    console.log("⚠️  No WATCHER_ADDRESSES — skipping watcher registration");
  } else {
    console.log(`👁️  Registering ${watchers.length} watcher(s)...`);
    for (const w of watchers) {
      if (!ethers.isAddress(w)) {
        console.log(`  ⚠️  Invalid address, skipping: ${w}`);
        continue;
      }
      // Check if already registered to avoid revert
      const list: string[] = await insurance.getWatchers();
      if (list.map(a => a.toLowerCase()).includes(w.toLowerCase())) {
        console.log(`  ✔  Already registered: ${w}`);
        continue;
      }
      const tx = await insurance.addWatcher(w);
      await tx.wait();
      console.log(`  ✅ Added: ${w} (tx: ${tx.hash})`);
      await new Promise(r => setTimeout(r, 2000)); // avoid in-flight tx limit
    }
  }

  // ── 2. Link reserve → insurance ──────────────────────────────────────────
  console.log("\n🔗 Calling ZeusReserveV2.setInsuranceContract...");
  const tx = await reserve.setInsuranceContract(insuranceAddress);
  await tx.wait();
  console.log(`✅ Reserve linked to new insurance contract (tx: ${tx.hash})`);

  console.log("\n✅ Post-deploy setup complete.");
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
