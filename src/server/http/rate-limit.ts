import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db, Tx } from "@/server/db/client";
import { rateLimits } from "@/server/db/schema";
import { env } from "@/server/env";

/**
 * Postgres-backed fixed-window rate limits for public sandbox actions
 * (security-standards §8, telemetry-dashboard UI-4). Serverless instances
 * share no memory, so the count lives in `rate_limits`. The key is a
 * SHA-256 of the action and the client IP, so raw IPs are never stored.
 */

export interface RateLimit {
  limit: number;
  windowMs: number;
}

/** 30 sandbox actions of one kind per IP per minute: plenty for a person clicking, not for a script. */
export const SANDBOX_ACTION_LIMIT: RateLimit = { limit: 30, windowMs: 60_000 };

/**
 * The client IP, for per-IP rate limits. x-real-ip and x-forwarded-for are
 * read only when TRUST_PROXY_HEADERS says a proxy sets them (on by default
 * on Vercel, which sets x-real-ip and overwrites x-forwarded-for). Anywhere
 * else a client could send any value and pick its own bucket, so every
 * caller shares one bucket instead.
 */
export function clientIp(request: Request): string {
  if (!env.trustProxyHeaders()) return "unknown";
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

export const rateLimitKey = (action: string, ip: string): string => createHash("sha256").update(`${action}\n${ip}`, "utf8").digest("hex");

/** Count one hit. Returns false once the window's count is over the limit. */
export async function hitRateLimit(db: Db | Tx, input: { action: string; ip: string; now: Date } & RateLimit): Promise<boolean> {
  const windowStart = new Date(input.now.getTime() - (input.now.getTime() % input.windowMs));
  const [row] = await db
    .insert(rateLimits)
    .values({ key: rateLimitKey(input.action, input.ip), windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  return (row?.count ?? Number.MAX_SAFE_INTEGER) <= input.limit;
}
