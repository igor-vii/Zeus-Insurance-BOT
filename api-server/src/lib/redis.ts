import { createClient } from "redis";
import { logger } from "./logger.js";

let client: ReturnType<typeof createClient> | null = null;

export async function getRedis() {
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn("REDIS_URL not set — using in-memory fallback");
    return null;
  }
  client = createClient({ url });
  client.on("error", (err) => logger.error({ err }, "Redis error"));
  await client.connect();
  return client;
}
