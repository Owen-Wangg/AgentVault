import { randomUUID } from "node:crypto";
import { type Database, createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { type RateLimit, clientIp, hitRateLimit } from "@/server/http/rate-limit";

/**
 * A per-IP limit for the demo vendor's paid APIs (/vendor/api/weather and
 * /vendor/api/report, security-standards §8). They are public, and a
 * request carrying a payment makes a facilitator or Stripe call, so a
 * script could spend the vendor's free quotas. A person, the validator
 * (`pnpm mpp:validate`, about 20 requests), and the real-rail adapters
 * (two requests per payment) stay well under the limit.
 */
export const VENDOR_API_LIMIT: RateLimit = { limit: 60, windowMs: 60_000 };

export interface VendorLimitDeps {
  openDb: () => Database;
  now: () => Date;
  limit?: RateLimit;
}

const defaultDeps = (): VendorLimitDeps => ({ openDb: () => createDb(env.databaseUrl()), now: () => new Date() });

/** Count the request against its IP's limit, then run the handler. 429 over the limit; 503 if the count can't be made. */
export async function withVendorRateLimit(
  request: Request,
  action: string,
  handler: () => Promise<Response>,
  deps: VendorLimitDeps = defaultDeps(),
): Promise<Response> {
  let database: Database | undefined;
  let allowed: boolean;
  try {
    database = deps.openDb();
    allowed = await hitRateLimit(database.db, { action, ip: clientIp(request), now: deps.now(), ...(deps.limit ?? VENDOR_API_LIMIT) });
  } catch (error) {
    const correlationId = randomUUID();
    console.error(`${action} rate limit failed [${correlationId}]:`, error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "SERVICE_UNAVAILABLE", correlation_id: correlationId }, { status: 503 });
  } finally {
    await database?.close();
  }
  if (!allowed) return Response.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": "60" } });
  return handler();
}
