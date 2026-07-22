/**
 * Registers the Zeus Insurance Protocol in the ERC-8004 agent registry
 * on Base Mainnet.
 *
 * Usage:
 *   cd contracts
 *   npx hardhat run scripts/register-erc8004.ts --network base-mainnet
 *
 * The registry contract is at 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432.
 * The agent.json must already be pushed to the main branch of the GitHub repo.
 */
import { ethers } from "hardhat";

const REGISTRY_ADDRESS = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const AGENT_URI =
  "https://raw.githubusercontent.com/igor-vii/Zeus-Insurance-Escrow/main/agent.json";

const REGISTRY_ABI = [
  "function register(string agentURI) external returns (uint256 agentId)",
  "function getAgent(address owner) external view returns (string agentURI, uint256 agentId, bool active)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`Registrar:  ${signer.address}`);
  console.log(`Registry:   ${REGISTRY_ADDRESS}`);
  console.log(`Agent URI:  ${AGENT_URI}`);

  const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, signer);

  // Check if already registered
  try {
    const existing = await registry.getAgent(signer.address);
    if (existing.agentId && existing.agentId > 0n) {
      console.log(`\nAlready registered — agentId: ${existing.agentId}`);
      console.log(`Current URI: ${existing.agentURI}`);
      console.log("Nothing to do.");
      return;
    }
  } catch {
    // Not registered yet — proceed
  }

  console.log("\nRegistering…");
  const tx = await registry.register(AGENT_URI);
  console.log(`Tx sent:    ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt?.blockNumber}`);

  // Parse agentId from logs if emitted
  const iface = new ethers.Interface(REGISTRY_ABI);
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "AgentRegistered" || parsed?.name === "Registered") {
        console.log(`Agent ID:   ${parsed.args[0] ?? parsed.args.agentId}`);
      }
    } catch { /* ignore non-matching logs */ }
  }

  // Verify
  try {
    const agent = await registry.getAgent(signer.address);
    console.log(`\nVerified — agentId: ${agent.agentId}, active: ${agent.active}`);
  } catch {
    console.log("Registration complete (getAgent not supported on this registry version).");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
