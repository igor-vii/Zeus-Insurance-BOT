/**
 * Zeus Insurance — Oracle Watcher Node
 *
 * Polls the insurance contract for active policies that have passed their
 * retryDeadline, checks the seller's registered API endpoint, then signs
 * and submits an Observation to ZeusInsuranceV2 via the API server.
 *
 * Environment variables:
 *   WATCHER_PRIVATE_KEY   — private key of a registered watcher address (required)
 *   API_SERVER_URL        — base URL of the api-server (default: http://localhost:8080)
 *   BASE_SEPOLIA_RPC_URL  — RPC URL (default: https://sepolia.base.org)
 *   INSURANCE_ADDRESS     — override contract address (reads ZEUS_INSURANCE_ADDRESS fallback)
 *   POLL_INTERVAL_MS      — polling interval in ms (default: 15000)
 *   MAX_POLICY_SCAN       — how many recent policyIds to scan (default: 200)
 *   WATCHER_INDEX         — log prefix for this watcher instance (default: 0)
 *
 * Observation status codes (matches contract ObservationStatus):
 *   0 = OK        — endpoint returned 2xx
 *   1 = TIMEOUT   — endpoint timed out or connection refused
 *   2 = ERROR_500 — endpoint returned 5xx
 *   3 = LATE      — past retryDeadline but endpoint unreachable for different reason
 */

import { ethers } from "ethers";

// ── Config ──────────────────────────────────────────────────────────────────

const WATCHER_PRIVATE_KEY  = process.env["WATCHER_PRIVATE_KEY"];
const API_SERVER_URL       = (process.env["API_SERVER_URL"] ?? "http://localhost:8080").replace(/\/$/, "");
const RPC_URL              = process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org";
const INSURANCE_ADDRESS    = process.env["INSURANCE_ADDRESS"] ?? process.env["ZEUS_INSURANCE_ADDRESS"] ?? "";
const POLL_INTERVAL_MS     = Number(process.env["POLL_INTERVAL_MS"] ?? "15000");
const MAX_POLICY_SCAN      = Number(process.env["MAX_POLICY_SCAN"] ?? "200");
const IDX                  = process.env["WATCHER_INDEX"] ?? "0";

if (!WATCHER_PRIVATE_KEY) {
  console.error("[watcher] ❌  WATCHER_PRIVATE_KEY not set. Exiting.");
  process.exit(1);
}
if (!INSURANCE_ADDRESS) {
  console.error("[watcher] ❌  INSURANCE_ADDRESS / ZEUS_INSURANCE_ADDRESS not set. Exiting.");
  process.exit(1);
}

// ── Minimal ABI ──────────────────────────────────────────────────────────────

const INSURANCE_ABI = [
  "function nextPolicyId() external view returns (uint256)",
  "function getPolicy(uint256 policyId) external view returns (tuple(address buyer, address seller, uint256 amount, uint256 premium, uint256 retryDeadline, uint256 maxRetries, uint8 status))",
  "function isWatcher(address) external view returns (bool)",
] as const;

// PolicyStatus enum  (must match contract)
const STATUS_ACTIVE = 0;

// ── Provider / Signer ────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer   = new ethers.Wallet(
  WATCHER_PRIVATE_KEY.startsWith("0x") ? WATCHER_PRIVATE_KEY : `0x${WATCHER_PRIVATE_KEY}`,
  provider,
);
const contract = new ethers.Contract(INSURANCE_ADDRESS, INSURANCE_ABI, provider);

// ── Per-watcher state ────────────────────────────────────────────────────────

/** requestIds we've already voted on this session. */
const voted = new Set<string>();
/** Per-watcher nonce (monotonically increasing). */
let nonce = BigInt(Date.now());

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[watcher-${IDX}] ${new Date().toISOString()}  ${msg}`);
}

/** Check an HTTP endpoint; returns status code 0 for timeout/no-response. */
async function probeEndpoint(url: string, timeoutMs = 5000): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method:  "HEAD",
      signal:  controller.signal,
      headers: { "User-Agent": "ZeusWatcher/1.0" },
    });
    clearTimeout(timer);
    return res.status;
  } catch {
    clearTimeout(timer);
    return 0; // timeout / refused
  }
}

/** Derive observation status from HTTP probe result. */
function httpStatusToObsStatus(httpStatus: number): 0 | 1 | 2 | 3 {
  if (httpStatus === 0)              return 1; // TIMEOUT
  if (httpStatus >= 500)            return 2; // ERROR_500
  if (httpStatus >= 200 && httpStatus < 300) return 0; // OK
  return 3; // LATE / unexpected
}

/**
 * Build and sign an Observation struct.
 *
 * requestId = keccak256(buyer, seller, timestamp)  — matches contract verification.
 * msgHash   = keccak256(requestId, timestamp, status, metadataHash, nonce)
 * signature = EIP-191 personal_sign(msgHash)
 */
async function buildObservation(
  buyer:         string,
  seller:        string,
  obsStatus:     0 | 1 | 2 | 3,
  metadataExtra: string = "",
) {
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  nonce++;

  // requestId = keccak256(abi.encodePacked(buyer, seller, timestamp))
  const requestId = ethers.keccak256(
    ethers.solidityPacked(
      ["address", "address", "uint256"],
      [buyer, seller, timestamp],
    ),
  );

  // metadataHash — keccak256 of an arbitrary JSON string (for audit trail)
  const metadataJson = JSON.stringify({
    watcher:  signer.address,
    seller,
    status:   obsStatus,
    probed:   new Date().toISOString(),
    extra:    metadataExtra,
  });
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(metadataJson));

  // msgHash = keccak256(abi.encodePacked(requestId, timestamp, status, metadataHash, nonce))
  const msgHash = ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "uint256", "uint8", "bytes32", "uint256"],
      [requestId, timestamp, obsStatus, metadataHash, nonce],
    ),
  );

  // EIP-191 personal_sign: "\x19Ethereum Signed Message:\n32" + msgHash
  const signature = await signer.signMessage(ethers.getBytes(msgHash));

  return {
    requestId,
    timestamp:    timestamp.toString(),
    status:       obsStatus,
    metadataHash,
    nonce:        nonce.toString(),
    signature,
  };
}

/** POST the observation to the API server. */
async function submitObservation(policyId: number, obs: ReturnType<typeof buildObservation> extends Promise<infer T> ? T : never) {
  const url = `${API_SERVER_URL}/api/observation`;
  const body = JSON.stringify({ policyId, observation: obs });

  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const json = await res.json().catch(() => ({ error: "non-JSON response" }));

  if (!res.ok) {
    throw new Error(`API ${res.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

// ── Main polling loop ─────────────────────────────────────────────────────────

async function pollOnce() {
  // Verify watcher is registered
  const registered = await contract["isWatcher"](signer.address).catch(() => false);
  if (!registered) {
    log(`⚠️  ${signer.address} is NOT a registered watcher. Skipping cycle.`);
    return;
  }

  const nextId = Number(await contract["nextPolicyId"]());
  const start  = Math.max(0, nextId - MAX_POLICY_SCAN);
  const now    = Math.floor(Date.now() / 1000);

  log(`Scanning policies [${start}, ${nextId}) ...`);

  for (let id = start; id < nextId; id++) {
    let policy: { buyer: string; seller: string; retryDeadline: bigint; status: number };
    try {
      policy = await contract["getPolicy"](id);
    } catch {
      continue;
    }

    // Only active policies past their deadline
    if (policy.status !== STATUS_ACTIVE)            continue;
    if (Number(policy.retryDeadline) > now)         continue;

    // Build a request key: requestId computation depends on the observation
    // timestamp we'll use — compute approximately and check against voted set.
    const approxKey = `${id}-${policy.buyer}-${policy.seller}`;
    if (voted.has(approxKey)) continue;

    log(`Policy ${id}: active + past deadline. Probing seller...`);

    // Try to get the seller endpoint from the api-server
    let sellerEndpoint: string | null = null;
    try {
      const r = await fetch(`${API_SERVER_URL}/api/policies/${id}`);
      if (r.ok) {
        const d = await r.json() as { policy?: { apiEndpoint?: string } };
        sellerEndpoint = d.policy?.apiEndpoint ?? null;
      }
    } catch {
      // Endpoint not stored — probe a generic health URL instead
    }

    const probeUrl     = sellerEndpoint ?? `http://${policy.seller}`; // fallback
    const httpStatus   = sellerEndpoint ? await probeEndpoint(sellerEndpoint) : 0;
    const obsStatus    = httpStatusToObsStatus(httpStatus);

    log(`Policy ${id}: probe ${probeUrl} → HTTP ${httpStatus} → obs status ${obsStatus}`);

    try {
      const obs    = await buildObservation(policy.buyer, policy.seller, obsStatus, probeUrl);
      const result = await submitObservation(id, obs);
      voted.add(approxKey);
      log(`Policy ${id}: observation submitted ✅  ${JSON.stringify(result)}`);
    } catch (err) {
      log(`Policy ${id}: submission failed ❌  ${(err as Error).message}`);
    }

    // Small delay between submissions to avoid RPC rate limiting
    await new Promise(r => setTimeout(r, 2000));
  }

  log(`Scan complete. Waiting ${POLL_INTERVAL_MS / 1000}s...`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  log(`Starting — address: ${signer.address}`);
  log(`Contract: ${INSURANCE_ADDRESS}`);
  log(`API:      ${API_SERVER_URL}`);
  log(`RPC:      ${RPC_URL}`);
  log(`Interval: ${POLL_INTERVAL_MS}ms`);

  // Verify registration on startup
  const registered = await contract["isWatcher"](signer.address).catch(() => false);
  if (!registered) {
    log(`⚠️  This address is NOT registered as a watcher on the contract.`);
    log(`   Ask the contract owner to call: addWatcher(${signer.address})`);
    log(`   Continuing anyway — will recheck each poll cycle.`);
  } else {
    log(`✅ Registered as watcher`);
  }

  // Run immediately, then on interval
  await pollOnce().catch(e => log(`Poll error: ${(e as Error).message}`));
  setInterval(
    () => pollOnce().catch(e => log(`Poll error: ${(e as Error).message}`)),
    POLL_INTERVAL_MS,
  );
}

main().catch(e => {
  console.error("[watcher] Fatal:", e);
  process.exit(1);
});
