import { Router } from "express";
import { createPublicClient, http, parseAbiItem } from "viem";
import { quoteStaking, type ValidatorMetrics } from "../services/staking-pricing.js";
import { logger } from "../lib/logger.js";

const router = Router();

const STAKING_ADDRESS = (process.env.ZEUS_STAKING_INSURANCE_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

const RPC_URL = process.env.BOT_CHAIN_MAINNET_RPC_URL || "https://rpc.botchain.ai";

const client = createPublicClient({ transport: http(RPC_URL) });

const COVER_BOUGHT = parseAbiItem(
  "event CoverBought(uint256 indexed positionId, bytes32 indexed validatorKey, address indexed owner, uint256 coveredAmount, uint256 premium, uint256 expiry)"
);

const STAKING_ABI = [
  { type: "function", name: "getPosition", stateMutability: "view",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "validatorKey", type: "bytes32" },
      { name: "owner", type: "address" },
      { name: "stakedAmount", type: "uint256" },
      { name: "coveredAmount", type: "uint256" },
      { name: "premium", type: "uint256" },
      { name: "start", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "status", type: "uint8" },
    ]}],
  },
] as const;

/** GET /api/staking/positions — active positions (for consensus-monitor) */
router.get("/positions", async (_req, res) => {
  try {
    const logs = await client.getLogs({
      address: STAKING_ADDRESS,
      event: COVER_BOUGHT,
      fromBlock: "earliest",
      toBlock: "latest",
    });

    const now = Math.floor(Date.now() / 1000);
    const positions = [];

    for (const log of logs) {
      const id = log.args.positionId!;
      const p = await client.readContract({
        address: STAKING_ADDRESS,
        abi: STAKING_ABI,
        functionName: "getPosition",
        args: [id],
      });
      if (Number(p.status) === 0 && Number(p.expiry) > now) {
        positions.push({
          positionId: id.toString(),
          validatorKey: p.validatorKey,
          validatorPubkey: "", // v1: пока не передаётся on-chain; consensus-monitor вернёт isSlashed=false для пустых
          owner: p.owner,
          expiry: Number(p.expiry),
        });
      }
    }

    res.json(positions);
  } catch (err: any) {
    logger.warn({ err }, "[staking] positions failed");
    res.status(500).json({ error: "failed to read positions" });
  }
});

/** POST /api/staking/quote — premium quote */
router.post("/quote", (req, res) => {
  const { stakedAmount, termDays, metrics } = req.body as {
    stakedAmount: string;
    termDays: number;
    metrics?: Partial<ValidatorMetrics>;
  };

  if (!stakedAmount || !termDays) {
    return res.status(400).json({ error: "stakedAmount and termDays required" });
  }

  const m: ValidatorMetrics = {
    downtimePct: metrics?.downtimePct ?? 1,
    priorSlashes: metrics?.priorSlashes ?? 0,
    clientSharePct: metrics?.clientSharePct ?? 20,
  };

  const quote = quoteStaking(BigInt(stakedAmount), termDays, m);
  res.json(quote);
});

export default router;
