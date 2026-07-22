import { Router } from "express";
import { z } from "zod";
import { isAddress } from "viem";
import { verifyMessage } from "viem";
import {
  createNonce,
  buildSignMessage,
  activateSession,
  destroySession,
  resolveSession,
  SESSION_COOKIE,
  requireAuth,
} from "../lib/session.js";
import type { AuthedRequest } from "../lib/session.js";

const router = Router();
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // seconds

// ─── GET /api/auth/nonce ──────────────────────────────────────────────────────
const nonceSchema = z.object({
  address: z.string().refine(isAddress, "Invalid wallet address"),
});

router.get("/nonce", async (req, res) => {
  const parsed = nonceSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const nonce = await createNonce(parsed.data.address.toLowerCase());
    const message = buildSignMessage(parsed.data.address, nonce);
    res.json({ nonce, message });
  } catch (err) {
    res.status(500).json({ error: "Failed to create nonce" });
  }
});

// ─── POST /api/auth/verify ────────────────────────────────────────────────────
const verifySchema = z.object({
  address: z.string().refine(isAddress, "Invalid wallet address"),
  signature: z.string().min(1),
  nonce: z.string().min(1),
});

router.post("/verify", async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { address, signature, nonce } = parsed.data;
  try {
    const message = buildSignMessage(address, nonce);
    const valid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    if (!valid) {
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    const token = await activateSession(address, nonce);

    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecure,
      maxAge: TOKEN_MAX_AGE * 1000,
      path: "/",
    });

    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(401).json({ error: msg });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get("/me", requireAuth, (req, res) => {
  const user = (req as AuthedRequest).user;
  res.json({ address: user.walletAddress, role: user.role });
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post("/logout", async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) {
    await destroySession(token).catch(() => null);
  }
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

export default router;
