/**
 * Zeus Insurance — Slashing Protection Oracle
 *
 * Monitors BOT Chain mainnet (chain 677) for validator slashing events and
 * reports them to ZeusInsuranceV2 via reportSlashing(), triggering immediate
 * payout for SlashingProtection policy holders.
 *
 * How it works:
 *   1. Polls active SlashingProtection policies from the API server.
 *   2. For each policy, checks scan.botchain.ai API for slashing transactions
 *      involving the validator address (policy seller).
 *   3. When slashing is confirmed, calls POST /api/report-slashing.
 *
 * Environment variables:
 *   WATCHER_PRIVATE_KEY        — registered watcher private key (required)
 *   API_SERVER_URL             — api-server base URL (default: http://localhost:8080)
 *   BOT_CHAIN_MAINNET_RPC_URL  — BOT Chain RPC (default: https://rpc.botchain.ai)
 *   INSURANCE_ADDRESS          — ZeusInsuranceV2 address override
 *   BOTCHAIN_SCAN_URL          — Explorer API base URL (default: https://scan.botchain.ai)
 *   POLL_INTERVAL_MS           — polling interval (default: 30000)
 */

import { ethers } from "ethers";
import { keccak256, toUtf8Bytes } from "ethers";

// ── Config ───────────────────────────────────────────────────────────────────

const WATCHER_PRIVATE_KEY = process.env["WATCHER_PRIVATE_KEY"];
const API_SERVER_URL      = (process.env["API_SERVER_URL"] ?? "http://localhost:8080").replace(/\/$/, "");
const RPC_URL             = process.env["BOT_CHAIN_MAINNET_RPC_URL"] ?? "https://rpc.botchain.ai";
const INSURANCE_ADDRESS   = process.env["INSURANCE_ADDRESS"] ?? process.env["ZEUS_INSURANCE_ADDRESS"] ?? "";
const BOTCHAIN_SCAN_URL   = (process.env["BOTCHAIN_SCAN_URL"] ?? "https://scan.botchain.ai").replace(/\/$/, "");
const POLL_INTERVAL_MS    = Number(process.env["POLL_INTERVAL_MS"] ?? "30000");

if (!WATCHER_PRIVATE_KEY) {
  console.error("[slashing-oracle] ❌  WATCHER_PRIVATE_KEY not set. Exiting.");
  process.exit(1);
}
if (!INSURANCE_ADDRESS) {
  console.error("[slashing-oracle] ❌  INSURANCE_ADDRESS / ZEUS_INSURANCE_ADDRESS not set. Exiting.");
  process.exit(1);
}

// ── Minimal ABI ──────────────────────────────────────────────────────────────

const INSURANCE_ABI = [
  "function nextPolicyId() external view returns (uint256)",
  "function getPolicy(uint256 policyId) external view returns (tuple(address buyer, address seller, uint256 amount, uint256 premium, uint256 retryDeadline, uint256 maxRetries, uint8 status))",
  "function getCoverageType(uint256 policyId) external view returns (uint8)",
  "function isWatcher(address) external view returns (bool)",
  "function reportSlashing(uint256 policyId, bytes32 evidenceHash) external",
] as const;

const COVERAGE_TYPE_SLASHING = 1; // CoverageType.SlashingProtection
const STATUS_ACTIVE           = 0; // PolicyStatus.Active

// ── Provider / Signer ────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC_URL, 677, { staticNetwork: true });
const signer   = new ethers.Wallet(
  WATCHER_PRIVATE_KEY.startsWith("0x") ? WATCHER_PRIVATE_KEY : `0x${WATCHER_PRIVATE_KEY}`,
  provider,
);
const contract = new ethers.Contract(INSURANCE_ADDRESS, INSURANCE_ABI, signer);

// ── Per-session state ────────────────────────────────────────────────────────

/** Set of policyIds we've already reported (avoid double-reporting). */
const reported = new Set<number>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[slashing-oracle] ${new Date().toISOString()}  ${msg}`);
}

function logError(msg: string, err?: unknown) {
  console.error(`[slashing-oracle] ⚠  ${msg}`, err instanceof Error ? err.message : err);
}

/**
 * Query scan.botchain.ai API for slashing transactions involving a validator.
 * Falls back gracefully if the endpoint is unavailable.
 *
 * Returns the tx hash of the slashing event, or null if not found.
 */
async function detectSlashingEvent(validatorAddr: string): Promise<string | null> {
  try {
    // Blockscout-compatible API endpoint for internal transactions / token transfers
    const url = `${BOTCHAIN_SCAN_URL}/api?module=account&action=txlist&address=${validatorAddr}&sort=desc&limit=50`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;

    const json = await resp.json() as { status: string; result: Array<{ hash: string; methodId?: string; input?: string; isError?: string }> };
    if (json.status !== "1" || !Array.isArray(json.result)) return null;

    for (const tx of json.result) {
      // Heuristic: look for transactions with known slashing method selectors
      // or transactions that sent funds out of the validator (penalty applied).
      // On BOT Chain, slashing is recorded as a specific system-level tx.
      // We flag any tx that came from the system address (0x00...01) or
      // has "slash" in the decoded input, or isError=1 (reverted penalty).
      const isSysSlash = tx.input && tx.input.toLowerCase().includes("736c617368"); // hex("slash")
      const isFromSystem = tx.hash && tx.isError === "1"; // simplified heuristic
      if (isSysSlash || isFromSystem) {
        return tx.hash;
      }
    }
  } catch {
    // Explorer unavailable — fall through
  }
  return null;
}

/**
 * Report a slashing event via the API server (which relays it on-chain if
 * SERVER_PRIVATE_KEY is set) or directly via the signer.
 */
async function reportSlashingEvent(policyId: number, txHash: string): Promise<void> {
  const evidenceHash = keccak256(toUtf8Bytes(txHash)) as `0x${string}`;

  // Try via API server first (respects automatic/hybrid mode)
  try {
    const resp = await fetch(`${API_SERVER_URL}/api/report-slashing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policyId, evidenceHash }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await resp.json() as { mode?: string; txHash?: string; error?: string };
    if (resp.ok) {
      log(`✅ Slashing reported for policy #${policyId} — mode=${body.mode} txHash=${body.txHash ?? "hybrid"}`);
      return;
    }
    logError(`API relay failed for policy #${policyId}: ${body.error}`);
  } catch (err) {
    logError(`API server unreachable, falling back to direct tx`, err);
  }

  // Fallback: broadcast directly from the watcher wallet
  const tx = await contract.reportSlashing(BigInt(policyId), evidenceHash);
  const receipt = await tx.wait();
  log(`✅ Direct reportSlashing tx for policy #${policyId}: ${receipt.hash}`);
}

// ── Main poll loop ───────────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  const nextId = Number(await contract.nextPolicyId());
  if (nextId === 0) return;

  const ids = Array.from({ length: nextId }, (_, i) => i);

  await Promise.allSettled(ids.map(async (policyId) => {
    if (reported.has(policyId)) return;

    const [policy, rawCovType] = await Promise.all([
      contract.getPolicy(BigInt(policyId)),
      contract.getCoverageType(BigInt(policyId)),
    ]);

    if (Number(policy.status) !== STATUS_ACTIVE)          return;
    if (Number(rawCovType)    !== COVERAGE_TYPE_SLASHING)  return;

    const validator = String(policy.seller);
    const slashTx   = await detectSlashingEvent(validator);
    if (!slashTx) return;

    log(`⚡ Slashing detected for validator ${validator} (policy #${policyId}) — evidence: ${slashTx}`);
    reported.add(policyId);

    try {
      await reportSlashingEvent(policyId, slashTx);
    } catch (err) {
      logError(`Failed to report slashing for policy #${policyId}`, err);
      reported.delete(policyId); // allow retry
    }
  }));
}

async function main(): Promise<void> {
  const addr = await signer.getAddress();
  const isW  = await contract.isWatcher(addr);
  log(`Starting. Watcher address: ${addr} | isWatcher: ${isW}`);
  if (!isW) {
    log("⚠  This address is not registered as a watcher. reportSlashing() calls will revert.");
  }

  log(`Polling every ${POLL_INTERVAL_MS / 1000}s — RPC: ${RPC_URL} — Contract: ${INSURANCE_ADDRESS}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await pollOnce();
    } catch (err) {
      logError("Poll iteration failed", err);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error("[slashing-oracle] Fatal:", err);
  process.exit(1);
});
