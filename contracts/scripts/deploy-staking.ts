import { ethers } from "hardhat";

/**
 * Deploy script for Zeus Staking Insurance stack (phase 1).
 *
 * Deploys three new contracts in sequence:
 *   1. WatcherRegistry (shared oracle, quorum=2)
 *   2. ZeusReserveV2 (dedicated vault for staking)
 *   3. ZeusStakingInsurance (staking cover product)
 *
 * Usage:
 *   USDT_ADDRESS=0x... WATCHER_ADDRESSES=0x..,0x.. npx hardhat run scripts/deploy-staking.ts --network bot-chain-testnet
 *
 * Required env vars:
 *   USDT_ADDRESS       - address of USDT (or testnet mock) on the target chain
 *   WATCHER_ADDRESSES  - comma-separated list of watcher addresses (can be empty)
 *   SLASHING_QUORUM    - optional, default 2
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying staking stack with:", deployer.address);
  console.log("Network chainId:", (await ethers.provider.getNetwork()).chainId);

  const USDT = process.env.USDT_ADDRESS;
  if (!USDT) throw new Error("USDT_ADDRESS env is required");

  const quorum = Number(process.env.SLASHING_QUORUM || 2);
  const watchers = (process.env.WATCHER_ADDRESSES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // 1. WatcherRegistry
  const Registry = await ethers.getContractFactory("WatcherRegistry");
  const registry = await Registry.deploy(quorum);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("\n✅ WatcherRegistry deployed at:", registryAddr);

  // 2. ZeusReserveV2 (dedicated vault for staking)
  const Reserve = await ethers.getContractFactory("ZeusReserveV2");
  const reserve = await Reserve.deploy(USDT, deployer.address);
  await reserve.waitForDeployment();
  const reserveAddr = await reserve.getAddress();
  console.log("✅ ZeusReserveV2 (staking vault) deployed at:", reserveAddr);

  // 3. ZeusStakingInsurance
  const Staking = await ethers.getContractFactory("ZeusStakingInsurance");
  const staking = await Staking.deploy(USDT, reserveAddr, registryAddr);
  await staking.waitForDeployment();
  const stakingAddr = await staking.getAddress();
  console.log("✅ ZeusStakingInsurance deployed at:", stakingAddr);

  // 4. Wire reserve to staking (so payClaim + isClaimApproved work)
  const tx = await reserve.setInsuranceContract(stakingAddr);
  await tx.wait();
  console.log("✅ Reserve wired to StakingInsurance");

  // 5. Add watchers
  for (const w of watchers) {
    const tx = await registry.addWatcher(w);
    await tx.wait();
    console.log("✅ Watcher added:", w);
  }

  // 6. Print env vars for api-server and watcher
  console.log("\n========================================");
  console.log("ENV VARS FOR api-server/.env:");
  console.log("========================================");
  console.log(`ZEUS_STAKING_INSURANCE_ADDRESS=${stakingAddr}`);
  console.log(`WATCHER_REGISTRY_ADDRESS=${registryAddr}`);
  console.log(`ZEUS_STAKING_RESERVE_ADDRESS=${reserveAddr}`);
  console.log("\n========================================");
  console.log("ENV VARS FOR zeus-watcher-stack/.env:");
  console.log("========================================");
  console.log(`WATCHER_REGISTRY_ADDRESS=${registryAddr}`);
  console.log(`BOT_CHAIN_MAINNET_RPC_URL=https://rpc.botchain.ai`);
  console.log(`WATCHER_PRIVATE_KEY=0x...`);
  console.log(`API_SERVER_URL=http://localhost:3001`);
  console.log(`CONSENSUS_RPC_URL=https://beaconcha.in/CL`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
