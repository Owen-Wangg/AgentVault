import { z } from "zod";
import { MicrosSchema, type Rail } from "@/core/money";
import { loadRailConfig } from "@/rails/config";
import { railFor } from "@/rails/select";
import type { RailAdapter } from "@/rails/types";
import { type Database, createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { idempotencyKeyOf, invalidIdempotencyKey, json, parseBody, withAgent } from "@/server/http/agent-route";
import { PAY_TOOLS } from "@/server/tools/registry";
import { runGuardedRequest } from "./guarded";

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
}

export function defaultPayDeps(): PayDeps {
  return {
    openDb: () => createDb(env.databaseUrl()),
    key: env.auditHeadKey,
    now: () => new Date(),
    // Validated per request, so a live key or wrong network refuses every payment (RAIL-7, RAIL-8).
    railFor: (rail, workspace) => railFor(rail, workspace, { config: loadRailConfig() }),
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
    return json(result.status, result.body);
  });
}
