import { getRedis } from "./redis.js";
import type { AgentStatus } from "./agent-status.js";

// In-memory fallback when Redis is not available
const memStatus = new Map<string, AgentStatus>();
const memErrors = new Map<string, number[]>();

export async function setAgentStatus(addr: string, data: AgentStatus, ttlMs: number) {
  const r = await getRedis();
  const key = addr.toLowerCase();
  const val = JSON.stringify(data);
  if (r) {
    await r.set(`agent:status:${key}`, val, { PX: ttlMs });
  } else {
    memStatus.set(key, data);
  }
}

export async function getAgentStatus(addr: string): Promise<AgentStatus> {
  const r = await getRedis();
  const key = addr.toLowerCase();
  if (r) {
    const v = await r.get(`agent:status:${key}`);
    return v ? JSON.parse(v) : { blockedUntil: 0, cooldownEnd: 0, currentMultiplier: 1.0 };
  }
  return memStatus.get(key) ?? { blockedUntil: 0, cooldownEnd: 0, currentMultiplier: 1.0 };
}

export async function deleteAgentStatus(addr: string) {
  const r = await getRedis();
  const key = addr.toLowerCase();
  if (r) await r.del(`agent:status:${key}`);
  else memStatus.delete(key);
}

export async function recordDailyError(addr: string, dayMs: number): Promise<{ count: number; blockedUntil: number | null }> {
  const r = await getRedis();
  const key = addr.toLowerCase();
  const now = Date.now();
  const cutoff = now - dayMs;
  
  if (r) {
    const errorKey = `agent:errors:${key}`;
    // Увеличиваем счётчик и устанавливаем TTL
    await r.multi()
      .incr(errorKey)
      .expire(errorKey, Math.floor(dayMs / 1000))
      .exec();
    
    const count = parseInt(await r.get(errorKey) ?? "0", 10);
    return { count, blockedUntil: null }; // blockedUntil устанавливается отдельно через setAgentStatus
  } else {
    // In-memory fallback
    const existing = memErrors.get(key) ?? [];
    const pruned = existing.filter(t => t > cutoff);
    pruned.push(now);
    memErrors.set(key, pruned);
    const count = pruned.length;
    return { count, blockedUntil: null };
  }
}

export async function getDailyErrorCount(addr: string, dayMs: number): Promise<number> {
  const r = await getRedis();
  const key = addr.toLowerCase();
  if (r) {
    const errorKey = `agent:errors:${key}`;
    const v = await r.get(errorKey);
    return v ? parseInt(v, 10) : 0;
  }
  // In-memory fallback
  const arr = memErrors.get(key) ?? [];
  const cutoff = Date.now() - dayMs;
  return arr.filter(t => t > cutoff).length;
}

export async function clearDailyErrors(addr: string) {
  const r = await getRedis();
  const key = addr.toLowerCase();
  if (r) await r.del(`agent:errors:${key}`);
  else memErrors.delete(key);
}

export async function clearAgentErrors(addr: string) {
  await deleteAgentStatus(addr);
  await clearDailyErrors(addr);
}
