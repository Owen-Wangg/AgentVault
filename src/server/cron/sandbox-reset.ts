import { randomUUID } from "node:crypto";
import { type Database, createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { type SandboxOptions, resetSandbox } from "@/server/sandbox/sandbox";
import { hasCronSecret } from "./auth";

export interface SandboxResetDeps {
  cronSecret: () => string;
  openDb: () => Database;
  options?: SandboxOptions;
}

const defaults: SandboxResetDeps = {
  cronSecret: env.cronSecret,
  openDb: () => createDb(env.databaseUrl()),
};

const json = (status: number, body: unknown) => Response.json(body, { status });

/**
 * GET /api/cron/sandbox-reset (AUD-9). Vercel Cron calls it nightly with
 * the CRON_SECRET bearer token. Fails closed: a missing secret
 * configuration is a 503, never an open endpoint.
 */
export async function handleSandboxReset(request: Request, deps: SandboxResetDeps = defaults): Promise<Response> {
  let secret: string;
  try {
    secret = deps.cronSecret();
  } catch {
    console.error("sandbox-reset: CRON_SECRET is not configured");
    return json(503, { error: "SERVICE_UNAVAILABLE" });
  }
  if (!hasCronSecret(request, secret)) return json(401, { error: "UNAUTHORIZED" });

  let database: Database | undefined;
  try {
    database = deps.openDb();
    const result = await resetSandbox(database.db, deps.options);
    return json(200, { workspace_id: result.workspaceId, retired: result.retired });
  } catch (error) {
    const correlationId = randomUUID();
    console.error(`sandbox-reset failed [${correlationId}]:`, error instanceof Error ? error.message : "unknown error");
    return json(503, { error: "SERVICE_UNAVAILABLE", correlation_id: correlationId });
  } finally {
    await database?.close();
  }
}
