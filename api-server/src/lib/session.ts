import crypto from "crypto";
import { eq, and, gt } from "drizzle-orm";
import { db, sessionsTable, usersTable, type User, type UserRole } from "@workspace/db";
import type { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "zeus_session";
const NONCE_TTL_MS = 5 * 60 * 1_000;   // 5 minutes
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomHex(bytes: number) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function uuid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Nonce
// ---------------------------------------------------------------------------

/** Create (or refresh) a nonce for the given wallet address. */
export async function createNonce(walletAddress: string): Promise<string> {
  const nonce = randomHex(16);
  const nonceExpiresAt = new Date(Date.now() + NONCE_TTL_MS);

  await db
    .insert(sessionsTable)
    .values({
      id: uuid(),
      walletAddress: walletAddress.toLowerCase(),
      nonce,
      nonceExpiresAt,
    });

  return nonce;
}

export function buildSignMessage(address: string, nonce: string): string {
  return `Sign in to Zeus Dashboard\nAddress: ${address.toLowerCase()}\nNonce: ${nonce}`;
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** Verify nonce, create session token and upsert user. Returns plaintext token. */
export async function activateSession(
  walletAddress: string,
  nonce: string,
): Promise<string> {
  const addr = walletAddress.toLowerCase();
  const now = new Date();

  // Find a valid pending nonce row
  const rows = await db
    .select()
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.walletAddress, addr),
        eq(sessionsTable.nonce, nonce),
        gt(sessionsTable.nonceExpiresAt, now),
      ),
    )
    .limit(1);

  if (!rows.length) throw new Error("Nonce not found or expired");

  const token = randomHex(32);
  const tokenHash = sha256(token);
  const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  // Activate session
  await db
    .update(sessionsTable)
    .set({ nonce: null, nonceExpiresAt: null, tokenHash, tokenExpiresAt })
    .where(eq(sessionsTable.id, rows[0]!.id));

  // Upsert user (create with default role if first login)
  await db
    .insert(usersTable)
    .values({ walletAddress: addr })
    .onConflictDoNothing();

  return token;
}

/** Delete session by token hash. */
export async function destroySession(token: string): Promise<void> {
  await db
    .delete(sessionsTable)
    .where(eq(sessionsTable.tokenHash, sha256(token)));
}

/** Resolve a session token → User | null. */
export async function resolveSession(token: string): Promise<User | null> {
  const hash = sha256(token);
  const now = new Date();

  const rows = await db
    .select({ walletAddress: sessionsTable.walletAddress })
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.tokenHash, hash),
        gt(sessionsTable.tokenExpiresAt, now),
      ),
    )
    .limit(1);

  if (!rows.length) return null;

  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.walletAddress, rows[0]!.walletAddress))
    .limit(1);

  return users[0] ?? null;
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token =
    req.cookies?.[SESSION_COOKIE] as string | undefined ??
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined);

  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  resolveSession(token).then((user) => {
    if (!user) {
      res.status(401).json({ error: "Session expired or invalid" });
      return;
    }
    (req as AuthedRequest).user = user;
    next();
  }).catch(next);
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthedRequest).user;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthedRequest extends Request {
  user: User;
}
