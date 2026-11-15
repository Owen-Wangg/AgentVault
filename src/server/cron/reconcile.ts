import { randomUUID } from "node:crypto";
import type { Rail } from "@/core/money";
import { railOptions } from "@/rails/real";
import { railFor } from "@/rails/select";
import type { RailAdapter } from "@/rails/types";
import { type Database, createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { runReconcileJob } from "@/server/payments/reconcile";
import { hasCronSecret } from "./auth";

export interface ReconcileCronDeps {
  cronSecret: () => string;
  openDb: () => Database;
  key: () => Uint8Array;
  now: () => Date;
  railFor: (rail: Rail, workspace: { isSandbox: boolean }) => RailAdapter;
}

function defaults(): ReconcileCronDeps {
  return {
    cronSecret: env.cronSecret,
    openDb: () => createDb(env.databaseUrl()),
    key: env.auditHeadKey,
    now: () => new Date(),
    railFor: (rail, workspace) => railFor(rail, workspace, railOptions()),
  };
}

const json = (status: number, body: unknown) => Response.json(body, { status });

/**
 * GET /api/cron/reconcile (RES-6 to RES-9, PXY-13). Vercel Cron calls it
 * once a day on Hobby with the CRON_SECRET bearer token. It resolves stale
 * reservations, deletes idempotency rows past 24 hours, and reports
 * reservations that need a human. Fails closed: a missing secret
 * configuration is a 503, never an open endpoint.
 */
export async function handleReconcileCron(request: Request, deps: ReconcileCronDeps = defaults()): Promise<Response> {
  let secret: string;
  try {
    secret = deps.cronSecret();
  } catch {
    console.error("reconcile: CRON_SECRET is not configured");
    return json(503, { error: "SERVICE_UNAVAILABLE" });
  }
  if (!hasCronSecret(request, secret)) return json(401, { error: "UNAUTHORIZED" });

  let database: Database | undefined;
  try {
    database = deps.openDb();
    const result = await runReconcileJob({ db: database.db, key: deps.key(), now: deps.now, railFor: deps.railFor });
    return json(200, { ...result.summary, cleaned_up: result.cleanup, stuck: result.stuck.length });
  } catch (error) {
    const correlationId = randomUUID();
    console.error(`reconcile failed [${correlationId}]:`, error instanceof Error ? error.message : "unknown error");
    return json(503, { error: "SERVICE_UNAVAILABLE", correlation_id: correlationId });
  } finally {
    await database?.close();
  }
}