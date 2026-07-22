import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { isAddress } from "viem";
import {
  db,
  usersTable,
  apiKeysTable,
  auditLogsTable,
  USER_ROLES,
  type UserRole,
} from "@workspace/db";
import { requireAuth, requireRole, sha256, uuid } from "../lib/session.js";
import type { AuthedRequest } from "../lib/session.js";

const router = Router();

// All admin routes require auth + admin role
router.use(requireAuth, requireRole("admin"));

function log(action: string, actor: string, target?: string, metadata?: unknown) {
  return db.insert(auditLogsTable).values({
    id: uuid(),
    action,
    actor,
    target: target ?? null,
    metadata: metadata ?? null,
  });
}

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
router.get("/users", async (_req, res) => {
  try {
    const users = await db
      .select()
      .from(usersTable)
      .orderBy(desc(usersTable.createdAt));
    res.json({ users });
  } catch {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// ─── PATCH /api/admin/users/:address/role ────────────────────────────────────
const roleSchema = z.object({
  role: z.enum(USER_ROLES as unknown as [UserRole, ...UserRole[]]),
});

router.patch("/users/:address/role", async (req, res) => {
  const addr = req.params["address"]?.toLowerCase();
  if (!addr || !isAddress(addr)) {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }
  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const actor = (req as AuthedRequest).user.walletAddress;
  try {
    const [updated] = await db
      .update(usersTable)
      .set({ role: parsed.data.role, updatedAt: new Date() })
      .where(eq(usersTable.walletAddress, addr))
      .returning();

    if (!updated) {
      // Create user with given role if they haven't logged in yet
      await db.insert(usersTable).values({
        walletAddress: addr,
        role: parsed.data.role,
      });
    }

    await log("role.set", actor, addr, { role: parsed.data.role });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to update role" });
  }
});

// ─── GET /api/admin/api-keys ──────────────────────────────────────────────────
router.get("/api-keys", async (_req, res) => {
  try {
    const keys = await db
      .select({
        id: apiKeysTable.id,
        name: apiKeysTable.name,
        createdBy: apiKeysTable.createdBy,
        isActive: apiKeysTable.isActive,
        createdAt: apiKeysTable.createdAt,
        lastUsedAt: apiKeysTable.lastUsedAt,
      })
      .from(apiKeysTable)
      .orderBy(desc(apiKeysTable.createdAt));
    res.json({ keys });
  } catch {
    res.status(500).json({ error: "Failed to fetch API keys" });
  }
});

// ─── POST /api/admin/api-keys ─────────────────────────────────────────────────
const createKeySchema = z.object({
  name: z.string().min(1).max(80),
});

router.post("/api-keys", async (req, res) => {
  const parsed = createKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const actor = (req as AuthedRequest).user.walletAddress;
  try {
    const plaintext = "zk_live_" + crypto.randomBytes(24).toString("hex");
    const keyHash = sha256(plaintext);
    const id = uuid();

    await db.insert(apiKeysTable).values({
      id,
      name: parsed.data.name,
      keyHash,
      createdBy: actor,
    });

    await log("api_key.create", actor, id, { name: parsed.data.name });

    // Return the plaintext key ONCE — it cannot be retrieved again
    res.status(201).json({ id, key: plaintext });
  } catch {
    res.status(500).json({ error: "Failed to create API key" });
  }
});

// ─── DELETE /api/admin/api-keys/:id ──────────────────────────────────────────
router.delete("/api-keys/:id", async (req, res) => {
  const id = req.params["id"];
  if (!id) {
    res.status(400).json({ error: "Missing key id" });
    return;
  }
  const actor = (req as AuthedRequest).user.walletAddress;
  try {
    const [revoked] = await db
      .update(apiKeysTable)
      .set({ isActive: false })
      .where(eq(apiKeysTable.id, id))
      .returning();

    if (!revoked) {
      res.status(404).json({ error: "API key not found" });
      return;
    }

    await log("api_key.revoke", actor, id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to revoke API key" });
  }
});

export default router;
