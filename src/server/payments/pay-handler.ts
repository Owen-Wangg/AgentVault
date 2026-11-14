import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MicrosSchema, type Rail } from "@/core/money";
import { loadRailConfig } from "@/rails/config";
import { railFor } from "@/rails/select";
import type { RailAdapter } from "@/rails/types";
import { authenticateAgent } from "@/server/auth/agent-keys";
import { type Database, createDb } from "@/server/db/client";
import { env } from "@/server/env";
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

const MAX_BODY_BYTES = 16 * 1024;
/** Printable ASCII, no spaces, up to 255 characters. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

export const PayBodySchema = z.strictObject({
  vendor: z.string().min(1).max(200),
  tool: z.enum(PAY_TOOLS as [string, ...string[]]),
  amount_micros: MicrosSchema,
  session_id: z.uuid(),
});

const json = (status: number, body: unknown) => Response.json(body, { status });

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export async function handlePay(request: Request, deps: PayDeps = defaultPayDeps()): Promise<Response> {
  let database: Database | undefined;
  try {
    database = deps.openDb();

    // PXY-2, PXY-3: authenticate before reading anything else.
    const agent = await authenticateAgent(database.db, request.headers.get("authorization"));
    if (!agent) return json(401, { error: "UNAUTHORIZED" });

    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return json(400, { error: "INVALID_IDEMPOTENCY_KEY", message: "Send an Idempotency-Key header of 1 to 255 printable characters" });
    }

    const raw = await readJson(request);
    if (!raw.ok) return json(400, { error: "INVALID_REQUEST", message: "The body must be JSON, at most 16 KB" });
    const parsed = PayBodySchema.safeParse(raw.value);
    if (!parsed.success) {
      return json(400, {
        error: "INVALID_REQUEST",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      });
    }

    const result = await runGuardedRequest(
      {
        agent,
        idempotencyKey,
        body: { vendor: parsed.data.vendor, tool: parsed.data.tool, amountMicros: parsed.data.amount_micros, sessionId: parsed.data.session_id },
      },
      { db: database.db, key: deps.key(), now: deps.now, railFor: deps.railFor },
    );
    return json(result.status, result.body);
  } catch (error) {
    const correlationId = randomUUID();
    // Only the message: driver errors can reference connection settings.
    console.error(`pay failed [${correlationId}]:`, error instanceof Error ? error.message : "unknown error");
    return json(503, { error: "SERVICE_UNAVAILABLE", correlation_id: correlationId });
  } finally {
    await database?.close();
  }
}
