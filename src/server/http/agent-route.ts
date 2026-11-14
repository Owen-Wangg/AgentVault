import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { type AuthenticatedAgent, authenticateAgent } from "@/server/auth/agent-keys";
import type { Database, Db } from "@/server/db/client";
import { APPROVAL_KEY_PREFIX } from "@/server/payments/guarded";

/**
 * Shared plumbing for the agent API routes (/api/v1/pay, fetch, tool):
 * bearer authentication first (PXY-2, PXY-3), JSON bodies with a size
 * cap, Zod validation errors as 400, and fail-closed 503s with a
 * correlation ID whose details go only to the server log (PXY-7).
 */

export const MAX_BODY_BYTES = 16 * 1024;
/** Printable ASCII, no spaces, up to 255 characters. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

export const json = (status: number, body: unknown): Response => Response.json(body, { status });


/**
 * The Idempotency-Key header if it is well formed, else null. Keys that
 * start with `approval:` are reserved for approval re-runs (HITL-2): an
 * agent that claimed one first could make a human's approval replay the
 * agent's own stored result instead of running.
 */
export function idempotencyKeyOf(request: Request): string | null {
  const key = request.headers.get("idempotency-key");
  return key && IDEMPOTENCY_KEY.test(key) && !key.toLowerCase().startsWith(APPROVAL_KEY_PREFIX) ? key : null;
}

export const invalidIdempotencyKey = (): Response =>
  json(400, {
    error: "INVALID_IDEMPOTENCY_KEY",
    message: "Send an Idempotency-Key header of 1 to 255 printable characters that doesn't start with approval:",
  });

/** Parse the JSON body (at most 16 KB) with a strict schema. Returns the 400 response on failure. */
export async function parseBody<S extends z.ZodType>(request: Request, schema: S): Promise<{ ok: true; value: z.output<S> } | { ok: false; response: Response }> {
  const text = await request.text();
  let raw: unknown;
  try {
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new Error("too large");
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: json(400, { error: "INVALID_REQUEST", message: "The body must be JSON, at most 16 KB" }) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: json(400, {
        error: "INVALID_REQUEST",
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      }),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Open the database, authenticate the agent, and run `handle`. Any error
 * is a generic 503. Only the error message is logged, because driver
 * errors can reference connection settings.
 */
export async function withAgent(
  request: Request,
  openDb: () => Database,
  label: string,
  handle: (db: Db, agent: AuthenticatedAgent) => Promise<Response>,
): Promise<Response> {
  let database: Database | undefined;
  try {
    database = openDb();
    const agent = await authenticateAgent(database.db, request.headers.get("authorization"));
    if (!agent) return json(401, { error: "UNAUTHORIZED" });
    return await handle(database.db, agent);
  } catch (error) {
    const correlationId = randomUUID();
    console.error(`${label} failed [${correlationId}]:`, error instanceof Error ? error.message : "unknown error");
    return json(503, { error: "SERVICE_UNAVAILABLE", correlation_id: correlationId });
  } finally {
    await database?.close();
  }
}
