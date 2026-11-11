import { createClient } from "redis";
import { config } from "./config.ts";

export const redis = createClient({ url: config.redisUrl });

redis.on("error", (error) => {
  console.error("[redis]", error instanceof Error ? error.message : error);
});

export async function ensureRedis(): Promise<void> {
  if (!redis.isOpen) await redis.connect();
}

/**
 * 固定窗口限流：返回 true 表示放行。
 * 用 Redis INCR + EXPIRE，够用且不会因为进程重启丢计数。
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ ok: boolean; remaining: number }> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSec);
  return { ok: count <= limit, remaining: Math.max(0, limit - count) };
}
