import { Router } from "express";
import { z } from "zod";
import { encodeFunctionData, isAddress } from "viem";
import { ZEUS_ESCROW_BOT_ADDRESS, ZEUS_ESCROW_BOT_ABI } from "../lib/escrow-contracts.js";
import { publicClient } from "../lib/chain.js";
import {
  isEscrowAutomaticModeAvailable,
  createEscrowAgreement,
} from "../services/escrow.js";

const router = Router();

function escrowAddress() {
  if (!ZEUS_ESCROW_BOT_ADDRESS) {
    return null;
  }
  return ZEUS_ESCROW_BOT_ADDRESS;
}

// ─── POST /api/escrow/prepare-deposit ────────────────────────────────────────
const depositSchema = z.object({
  executor: z.string().refine(isAddress, "Invalid executor address"),
  amount: z.string().regex(/^\d+$/, "amount must be a positive integer string"),
  timeoutSeconds: z.coerce.number().int().min(60),
});

router.post("/prepare-deposit", (req, res) => {
  const addr = escrowAddress();
  if (!addr) {
    res.status(503).json({ error: "Escrow contract not deployed. Set ZEUS_ESCROW_BOT_ADDRESS." });
    return;
  }
  const parsed = depositSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { executor, amount, timeoutSeconds } = parsed.data;
  const data = encodeFunctionData({
    abi: ZEUS_ESCROW_BOT_ABI,
    functionName: "depositAndCreateAgreement",
    args: [executor as `0x${string}`, BigInt(amount), BigInt(timeoutSeconds)],
  });
  res.json({ to: addr, data });
});

// ─── POST /api/escrow/prepare-confirm ────────────────────────────────────────
const confirmSchema = z.object({
  agreementId: z.string().regex(/^\d+$/, "agreementId must be a positive integer string"),
  proof: z.string().default(""),
});

router.post("/prepare-confirm", (req, res) => {
  const addr = escrowAddress();
  if (!addr) {
    res.status(503).json({ error: "Escrow contract not deployed. Set ZEUS_ESCROW_BOT_ADDRESS." });
    return;
  }
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { agreementId, proof } = parsed.data;
  const proofBytes = proof
    ? (proof.startsWith("0x") ? proof as `0x${string}` : `0x${Buffer.from(proof, "utf8").toString("hex")}` as `0x${string}`)
    : "0x";
  const data = encodeFunctionData({
    abi: ZEUS_ESCROW_BOT_ABI,
    functionName: "confirmExecution",
    args: [BigInt(agreementId), proofBytes],
  });
  res.json({ to: addr, data });
});

// ─── POST /api/escrow/prepare-refund ─────────────────────────────────────────
const refundSchema = z.object({
  agreementId: z.string().regex(/^\d+$/, "agreementId must be a positive integer string"),
});

router.post("/prepare-refund", (req, res) => {
  const addr = escrowAddress();
  if (!addr) {
    res.status(503).json({ error: "Escrow contract not deployed. Set ZEUS_ESCROW_BOT_ADDRESS." });
    return;
  }
  const parsed = refundSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const data = encodeFunctionData({
    abi: ZEUS_ESCROW_BOT_ABI,
    functionName: "requestRefund",
    args: [BigInt(parsed.data.agreementId)],
  });
  res.json({ to: addr, data });
});

// ─── GET /api/escrow/agreements ───────────────────────────────────────────────
const agreementsSchema = z.object({
  address: z.string().refine(isAddress, "Invalid wallet address"),
});

router.get("/agreements", async (req, res) => {
  const addr = escrowAddress();
  if (!addr) {
    res.status(503).json({ error: "Escrow contract not deployed. Set ZEUS_ESCROW_BOT_ADDRESS." });
    return;
  }
  const parsed = agreementsSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const walletAddr = parsed.data.address.toLowerCase() as `0x${string}`;

    // Base Sepolia public RPC caps eth_getLogs at 2000 blocks per request.
    // We paginate from the known deployment block in 2000-block chunks.
    const CHUNK = 1_999n;
    const deployBlock = BigInt(process.env["ESCROW_DEPLOY_BLOCK"] ?? "0");

    const AGREEMENT_CREATED_EVENT = {
      type: "event" as const,
      name: "AgreementCreated",
      inputs: [
        { indexed: true, name: "agreementId", type: "uint256" },
        { indexed: true, name: "initiator", type: "address" },
        { indexed: true, name: "executor", type: "address" },
        { indexed: false, name: "amount", type: "uint256" },
        { indexed: false, name: "timeout", type: "uint256" },
        { indexed: false, name: "createdAt", type: "uint256" },
      ],
    };

    async function fetchLogsInChunks(filterArgs: Record<string, unknown>) {
      const latest = await publicClient.getBlockNumber();
      const logs = [];
      for (let from = deployBlock; from <= latest; from += CHUNK + 1n) {
        const to = from + CHUNK > latest ? latest : from + CHUNK;
        const chunk = await publicClient.getLogs({
          address: addr!,
          event: AGREEMENT_CREATED_EVENT,
          args: filterArgs,
          fromBlock: from,
          toBlock: to,
        });
        logs.push(...chunk);
      }
      return logs;
    }

    const [asInitiator, asExecutor] = await Promise.all([
      fetchLogsInChunks({ initiator: walletAddr }),
      fetchLogsInChunks({ executor: walletAddr }),
    ]);

    // Deduplicate by agreementId
    const idSet = new Set<string>();
    const ids: bigint[] = [];
    for (const log of [...asInitiator, ...asExecutor]) {
      const id = log.args.agreementId?.toString() ?? "";
      if (!idSet.has(id)) {
        idSet.add(id);
        ids.push(log.args.agreementId!);
      }
    }

    // Multicall getAgreement for each id
    const agreements = await Promise.all(
      ids.map(async (id) => {
        const ag = await publicClient.readContract({
          address: addr,
          abi: ZEUS_ESCROW_BOT_ABI,
          functionName: "getAgreement",
          args: [id],
        });
        const STATUS_LABELS = ["Active", "Completed", "Refunded"] as const;
        return {
          id: id.toString(),
          initiator: ag.initiator,
          executor: ag.executor,
          amount: ag.amount.toString(),
          timeout: ag.timeout.toString(),
          createdAt: ag.createdAt.toString(),
          status: STATUS_LABELS[ag.status] ?? "Unknown",
          proof: ag.proof,
        };
      }),
    );

    res.json({ agreements });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Failed to fetch agreements", detail: msg });
  }
});

// ─── POST /api/escrow/create (automatic mode) ────────────────────────────────
const createSchema = z.object({
  executor: z.string().refine(isAddress, "Invalid executor address"),
  amount: z.string().regex(/^\d+$/, "amount must be a positive integer string"),
  timeoutSeconds: z.coerce.number().int().min(60),
});

router.post("/create", async (req, res) => {
  if (!isEscrowAutomaticModeAvailable()) {
    res.status(503).json({
      error: "Automatic escrow mode unavailable — SERVER_PRIVATE_KEY not configured",
    });
    return;
  }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { executor, amount, timeoutSeconds } = parsed.data;

  try {
    const result = await createEscrowAgreement({
      executor,
      amount: BigInt(amount),
      timeout: timeoutSeconds,
    });

    res.json({
      mode: "automatic",
      agreementId: result.agreementId,
      txHash: result.txHash,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Failed to create escrow agreement", detail: msg });
  }
});

export default router;
