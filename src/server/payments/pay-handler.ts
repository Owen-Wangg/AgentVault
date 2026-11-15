import { after } from "next/server";
import { z } from "zod";
import { MicrosSchema, type Rail } from "@/core/money";
import { railOptions } from "@/rails/real";
import { railFor } from "@/rails/select";
import type { RailAdapter } from "@/rails/types";
import { type Database, createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { idempotencyKeyOf, invalidIdempotencyKey, json, parseBody, withAgent } from "@/server/http/agent-route";
import { PAY_TOOLS } from "@/server/tools/registry";
import { runGuardedRequest } from "./guarded";
import { reconcile } from "./reconcile";

/**
 * POST /api/v1/pay (audit-and-approvals design, "API"). Authenticates the
 * agent, validates the body with Zod, and runs the guarded request. Any
 * error before a response is ready is a 503 with a generic message and a
 * correlation ID; details go to the server log only (PXY-7).
 */

export interface PayDeps {
  openDb: () => Database;
  key: () => Uint8Array;
  now: () => Date;
  railFor: (rail: Rail, workspace: { isSandbox: boolean }) => RailAdapter;
  /**
   * Run a task after the response is sent (Next.js after()). Used to
   * reconcile the agent's stale reservations. Optional, so tests that
   * don't pass it schedule nothing.
   */
  afterResponse?: (task: () => Promise<void>) => void;
}

/** How many of the agent's stale reservations each request reconciles afterwards. */
export const AFTER_REQUEST_RECONCILE_LIMIT = 5;

/**
 * After a pay or tool request, reconcile up to 5 of that agent's stale
 * reservations (design, "Reconciler" trigger 1). Vercel Hobby runs cron
 * only daily, so the agent's own traffic clears its backlog. The task
 * opens its own database connection, because the request's connection is
 * closed by then. Errors are logged, never thrown.
 */
export function scheduleReconcile(deps: PayDeps, agentId: string): void {
  if (!deps.afterResponse) return;
  deps.afterResponse(async () => {
    let database: Database | undefined;
    try {
      database = deps.openDb();
      await reconcile({ db: database.db, key: deps.key(), now: deps.now, railFor: deps.railFor }, { agentId, limit: AFTER_REQUEST_RECONCILE_LIMIT });
    } catch (error) {
      console.error("reconcile after request failed:", error instanceof Error ? error.message : "unknown error");
    } finally {
      await database?.close();
    }
  });
}

export function defaultPayDeps(): PayDeps {
  return {
    openDb: () => createDb(env.databaseUrl()),
    key: env.auditHeadKey,
    now: () => new Date(),
    // Validated per request, so a live key or wrong network refuses every payment (RAIL-7, RAIL-8).
    railFor: (rail, workspace) => railFor(rail, workspace, railOptions()),
    afterResponse: (task) => after(task),
  };
}

export const PayBodySchema = z.strictObject({
  vendor: z.string().min(1).max(200),
  tool: z.enum(PAY_TOOLS as [string, ...string[]]),
  amount_micros: MicrosSchema,
  session_id: z.uuid(),
});

export function handlePay(request: Request, deps: PayDeps = defaultPayDeps()): Promise<Response> {
  // PXY-2, PXY-3: authenticate before reading anything else.
  return withAgent(request, deps.openDb, "pay", async (db, agent) => {
    const idempotencyKey = idempotencyKeyOf(request);
    if (!idempotencyKey) return invalidIdempotencyKey();

    const parsed = await parseBody(request, PayBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;

    const result = await runGuardedRequest(
      { agent, idempotencyKey, body: { vendor: body.vendor, tool: body.tool, amountMicros: body.amount_micros, sessionId: body.session_id } },
      { db, key: deps.key(), now: deps.now, railFor: deps.railFor },
    );
    scheduleReconcile(deps, agent.id);
    return json(result.status, result.body);
  });
}
