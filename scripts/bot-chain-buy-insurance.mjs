/**
 * BOT Chain mainnet (chain 677) — approve USDT + buyInsurance
 *
 * "All-inclusive" → buyInsurance with maxRetries=1
 * (premiumBps = 700 → premium = amount * 7% = 70_000 units = 0.07 USDT)
 */
import { ethers } from "../node_modules/.pnpm/ethers@6.17.0_bufferutil@4.1.0_utf-8-validate@5.0.10/node_modules/ethers/lib.esm/index.js";

const RPC_URL  = "https://rpc.botchain.ai";
const CHAIN_ID = 677n;

const INSURANCE_ADDRESS = "0x8D10C2c6C92b613C1938fe532f0e391044e76188";
const SELLER            = "0xc9b597d102f5575ba0acdf3ad222bc2dda1969ef";
const AMOUNT            = 1_000_000n;     // 1 USDT (6 decimals)
const TIMEOUT_SECONDS   = 3600n;
const MAX_RETRIES       = 1n;             // "All-inclusive" — single retry window

const INSURANCE_ABI = [
  "function usdt() external view returns (address)",
  "function reserve() external view returns (address)",
  "function nextPolicyId() external view returns (uint256)",
  "function buyInsurance(address seller, uint256 amount, uint256 timeoutSeconds, uint256 maxRetries) external",
  "function getPolicy(uint256 policyId) external view returns (tuple(address buyer, address seller, uint256 amount, uint256 premium, uint256 retryDeadline, uint256 maxRetries, uint8 status))",
  "event PolicyCreated(uint256 indexed policyId, address indexed buyer, address indexed seller, uint256 amount, uint256 premium, uint256 retryDeadline)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];

const STATUS_NAMES = ["Active", "Claimed", "Rejected", "Expired"];

async function main() {
  const privateKey = process.env.SERVER_PRIVATE_KEY;
  if (!privateKey) throw new Error("SERVER_PRIVATE_KEY not set");

  const provider = new ethers.JsonRpcProvider(RPC_URL, Number(CHAIN_ID), { staticNetwork: true });
  const wallet   = new ethers.Wallet(privateKey, provider);
  const walletAddr = wallet.address;

  console.log("═══ BOT Chain mainnet (chain 677) ═══");
  console.log("Wallet:", walletAddr);

  // ── Check native balance ───────────────────────────────────────────────────
  const nativeBal = await provider.getBalance(walletAddr);
  console.log("Native balance:", ethers.formatEther(nativeBal), "BTB");

  // ── Load contracts ─────────────────────────────────────────────────────────
  const insurance = new ethers.Contract(INSURANCE_ADDRESS, INSURANCE_ABI, wallet);

  const [usdtAddress, reserveAddress, nextPolicyIdBefore] = await Promise.all([
    insurance.usdt(),
    insurance.reserve(),
    insurance.nextPolicyId(),
  ]);

  console.log("\n── Contract state ────────────────────────");
  console.log("ZeusInsuranceV2:", INSURANCE_ADDRESS);
  console.log("USDT token:     ", usdtAddress);
  console.log("Reserve:        ", reserveAddress);
  console.log("Next policy ID: ", nextPolicyIdBefore.toString());

  const usdt     = new ethers.Contract(usdtAddress, ERC20_ABI, wallet);
  const decimals = await usdt.decimals();

  // ── Balances before ────────────────────────────────────────────────────────
  const [buyerBalBefore, reserveBalBefore] = await Promise.all([
    usdt.balanceOf(walletAddr),
    usdt.balanceOf(reserveAddress),
  ]);

  // Calculate premium: 700 bps for maxRetries=1
  const premiumBps = 700n + (MAX_RETRIES - 1n) * 200n;
  const premium    = (AMOUNT * premiumBps) / 10_000n;

  console.log("\n── Balances before ───────────────────────");
  console.log("Buyer USDT:  ", ethers.formatUnits(buyerBalBefore, decimals));
  console.log("Reserve USDT:", ethers.formatUnits(reserveBalBefore, decimals));
  console.log("\nExpected premium:", ethers.formatUnits(premium, decimals), "USDT");

  if (buyerBalBefore < premium) {
    throw new Error(`Insufficient USDT: have ${ethers.formatUnits(buyerBalBefore, decimals)}, need ${ethers.formatUnits(premium, decimals)}`);
  }

  // ── Step 1: Approve USDT ──────────────────────────────────────────────────
  console.log("\n[1/2] Approving USDT for ZeusInsuranceV2...");
  const currentAllowance = await usdt.allowance(walletAddr, INSURANCE_ADDRESS);
  if (currentAllowance >= AMOUNT) {
    console.log("     Allowance already sufficient:", ethers.formatUnits(currentAllowance, decimals));
  } else {
    const approveTx = await usdt.approve(INSURANCE_ADDRESS, AMOUNT);
    console.log("     Approve tx:", approveTx.hash);
    const approveReceipt = await approveTx.wait();
    console.log("     ✓ Confirmed in block", approveReceipt.blockNumber);
  }

  // ── Step 2: buyInsurance ──────────────────────────────────────────────────
  console.log("\n[2/2] Calling buyInsurance (All-inclusive, maxRetries=1)...");
  console.log("     seller:", SELLER);
  console.log("     amount:", ethers.formatUnits(AMOUNT, decimals), "USDT");
  console.log("     timeout:", TIMEOUT_SECONDS.toString(), "seconds");
  console.log("     maxRetries:", MAX_RETRIES.toString());

  const buyTx = await insurance.buyInsurance(SELLER, AMOUNT, TIMEOUT_SECONDS, MAX_RETRIES);
  console.log("     Buy tx:", buyTx.hash);
  const buyReceipt = await buyTx.wait();
  console.log("     ✓ Confirmed in block", buyReceipt.blockNumber);

  // ── Parse PolicyCreated event ─────────────────────────────────────────────
  const iface    = new ethers.Interface(INSURANCE_ABI);
  let   policyId = null;
  for (const log of buyReceipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "PolicyCreated") {
        policyId = parsed.args.policyId;
        break;
      }
    } catch {}
  }
  if (policyId === null) {
    // Fallback: nextPolicyId was incremented
    policyId = nextPolicyIdBefore;
  }

  // ── Step 3: Verify policy & balances ─────────────────────────────────────
  const [policy, buyerBalAfter, reserveBalAfter] = await Promise.all([
    insurance.getPolicy(policyId),
    usdt.balanceOf(walletAddr),
    usdt.balanceOf(reserveAddress),
  ]);

  console.log("\n══ РЕЗУЛЬТАТ ════════════════════════════");
  console.log("Policy ID:      ", policyId.toString());
  console.log("Tx hash:        ", buyTx.hash);
  console.log("Block:          ", buyReceipt.blockNumber);

  console.log("\n── Policy ────────────────────────────────");
  console.log("Buyer:          ", policy.buyer);
  console.log("Seller:         ", policy.seller);
  console.log("Amount:         ", ethers.formatUnits(policy.amount, decimals), "USDT");
  console.log("Premium paid:   ", ethers.formatUnits(policy.premium, decimals), "USDT");
  console.log("Retry deadline: ", new Date(Number(policy.retryDeadline) * 1000).toISOString());
  console.log("Max retries:    ", policy.maxRetries.toString());
  console.log("Status:         ", STATUS_NAMES[Number(policy.status)] ?? policy.status.toString());

  console.log("\n── Балансы ───────────────────────────────");
  console.log("Buyer USDT до:   ", ethers.formatUnits(buyerBalBefore, decimals));
  console.log("Buyer USDT после:", ethers.formatUnits(buyerBalAfter, decimals));
  console.log("Δ buyer:         -" + ethers.formatUnits(buyerBalBefore - buyerBalAfter, decimals), "USDT (списана премия)");
  console.log("Reserve до:      ", ethers.formatUnits(reserveBalBefore, decimals));
  console.log("Reserve после:   ", ethers.formatUnits(reserveBalAfter, decimals));
  console.log("Δ reserve:       +" + ethers.formatUnits(reserveBalAfter - reserveBalBefore, decimals), "USDT");
}

main().catch(err => { console.error("ERROR:", err.message || err); process.exit(1); });
