import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import { type Rail, toMicrosString } from "@/core/money";
import { serverRailFor } from "@/rails/real";
import type { RailAdapter } from "@/rails/types";
import { withHuman } from "@/server/approvals/handlers";
import { type Database, createDb } from "@/server/db/client";
import { sessions } from "@/server/db/schema";
import { env } from "@/server/env";
import { json, parseBody } from "@/server/http/agent-route";
import { type RateLimit, clientIp, hitRateLimit } from "@/server/http/rate-limit";
import { runGuardedRequest } from "@/server/payments/guarded";
import { scheduleReconcile } from "@/server/payments/pay-handler";
import { testnetRailReady } from "./available";
import { TESTNET_AGENT_NAME, TESTNET_PRICE, TESTNET_VENDOR, findTestnetWorkspace } from "./workspace";

/**
 * POST /api/v1/testnet/pay (testnet-demo TN-1 to TN-7). Makes one real
 * x402 payment of $0.0015 on Base Sepolia as the testnet workspace's demo
 * agent, through the full guarded flow. The visitor chooses nothing about
 * the payment: the body must be `{}`. Human-only, like the scenario
 * runner, and limited per IP and for all visitors before anything is
 * created.
 *
 * Responses: 200 with the decision (and, when settled, the transaction
 * hash and its BaseScan link), 400 INVALID_REQUEST, 403 AGENT_KEY_FORBIDDEN
 * or CROSS_ORIGIN, 404 TESTNET_OFF, 429 RATE_LIMITED or TESTNET_QUOTA_USED,
 * 503 on any error.
 */

export interface TestnetPayDeps {
  openDb: () => Database;
  key: () => Uint8Array;
  now: () => Date;
  railFor: (rail: Rail, workspace: { isSandbox: boolean }) => RailAdapter;
  /** Whether RAIL_MODE=real and the x402 variables pass (TN-1). */
  railReady: () => boolean;
  afterResponse?: (task: () => Promise<void>) => void;
  limits?: TestnetLimits;
}

export interface TestnetLimits {
  perIp: RateLimit;
  perMinute: RateLimit;
  perDay: RateLimit;
}

/** TN-5: 2 per IP an hour, and for everyone together 6 a minute and 20 a UTC day. */
export const TESTNET_LIMITS: TestnetLimits = {
  perIp: { limit: 2, windowMs: 60 * 60_000 },
  perMinute: { limit: 6, windowMs: 60_000 },
  perDay: { limit: 20, windowMs: 24 * 60 * 60_000 },
};

/** The rate-limit bucket every press counts against. Not an IP, so no visitor can land in it. */
const ALL_VISITORS = "all-visitors";

export function defaultTestnetPayDeps(): TestnetPayDeps {
  return {
    openDb: () => createDb(env.databaseUrl()),
    key: env.auditHeadKey,
    now: () => new Date(),
    railFor: serverRailFor,
    railReady: () => testnetRailReady(),
    afterResponse: (task) => after(task),
  };
}

const EmptyBody = z.strictObject({});

export function handleTestnetPay(request: Request, deps: TestnetPayDeps = defaultTestnetPayDeps()): Promise<Response> {
  return withHuman(request, deps, "testnet payment", async (db) => {
    const body = await parseBody(request, EmptyBody);
    if (!body.ok) return body.response;
    if (!deps.railReady()) return json(404, { error: "TESTNET_OFF" });
    const testnet = await findTestnetWorkspace(db);
    if (!testnet) return json(404, { error: "TESTNET_OFF" });

    // TN-5: every limit is checked before anything is created.
    const limits = deps.limits ?? TESTNET_LIMITS;
    const now = deps.now();
    const ip = clientIp(request);
    if (!(await hitRateLimit(db, { action: "testnet pay", ip, now, ...limits.perIp }))) return json(429, { error: "RATE_LIMITED" });
    if (!(await hitRateLimit(db, { action: "testnet pay minute", ip: ALL_VISITORS, now, ...limits.perMinute }))) return json(429, { error: "RATE_LIMITED" });
    if (!(await hitRateLimit(db, { action: "testnet pay day", ip: ALL_VISITORS, now, ...limits.perDay }))) return json(429, { error: "TESTNET_QUOTA_USED" });

    const [session] = await db.insert(sessions).values({ agentId: testnet.agentId, taskId: testnet.taskId, createdAt: now }).returning({ id: sessions.id });
    if (!session) throw new Error("Session insert returned no row");
    const agent = { id: testnet.agentId, workspaceId: testnet.workspaceId, name: TESTNET_AGENT_NAME };
    const result = await runGuardedRequest(
      {
        agent,
        idempotencyKey: `testnet:${randomUUID()}`,
        body: { vendor: TESTNET_VENDOR, tool: "x402.pay", amountMicros: TESTNET_PRICE, sessionId: session.id },
      },
      { db, key: deps.key(), now: deps.now, railFor: deps.railFor },
    );
    // An unknown outcome is resolved by the reconciler, here after the response and daily by cron.
    if (deps.afterResponse) scheduleReconcile({ ...deps, afterResponse: deps.afterResponse }, agent.id);
    return json(result.status, { ...result.body, vendor: TESTNET_VENDOR, amount_micros: toMicrosString(TESTNET_PRICE) });
  });
}
