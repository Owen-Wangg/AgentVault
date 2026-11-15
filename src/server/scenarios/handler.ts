import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StepResult } from "@/agents/scripted/agent";
import { isScenarioName } from "@/agents/scripted/scenarios";
import { summaryToWire } from "@/agents/scripted/summary";
import { toMicrosString } from "@/core/money";
import { SANDBOX_VISITOR, withHuman } from "@/server/approvals/handlers";
import { type Database, createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { json, parseBody } from "@/server/http/agent-route";
import { type RateLimit, clientIp, hitRateLimit } from "@/server/http/rate-limit";
import { currentSandbox } from "@/server/sandbox/sandbox";
import { type ScenarioLock, runScenario } from "./runner";

/**
 * POST /api/v1/scenarios/:name/run (demo-agents AGT-1 to AGT-10). Body:
 * `{ run_id? }`, a UUID the page generates so it can find the run's
 * scenario_started event on the event stream before this returns.
 *
 * Public, like other sandbox actions (telemetry-dashboard UI-21): runs
 * always go to the current sandbox, which uses mock rails only, whoever
 * is signed in. It's human-only like the approval routes: any
 * Authorization header and any cross-site request are 403 before the
 * database opens. Each IP may start 10 runs a minute (security-standards
 * §8), because one run makes up to 100 requests.
 *
 * Responses: 200 with the steps and summary, 404 UNKNOWN_SCENARIO or
 * NO_SANDBOX, 409 SCENARIO_BUSY while another run of the same scenario
 * is in progress, 429 RATE_LIMITED, 503 on any error.
 */

export interface ScenarioRouteDeps {
  openDb: () => Database;
  key: () => Uint8Array;
  now: () => Date;
  /** APP_ORIGIN. The agent API and the vendor pages are called there. */
  baseUrl: () => string;
  agentFetch?: typeof fetch;
  lock?: ScenarioLock;
  rateLimit?: RateLimit;
}

export function defaultScenarioRouteDeps(): ScenarioRouteDeps {
  return { openDb: () => createDb(env.databaseUrl()), key: env.auditHeadKey, now: () => new Date(), baseUrl: env.appOrigin };
}

/** Runs started per IP per minute. */
export const SCENARIO_RUN_LIMIT: RateLimit = { limit: 10, windowMs: 60_000 };

const RunBodySchema = z.strictObject({ run_id: z.uuid().optional() });

function stepToWire(step: StepResult) {
  switch (step.kind) {
    case "fetch":
      return { kind: step.kind, url: step.url, label: step.label, event_seq: step.eventSeq };
    case "error":
      return { kind: step.kind, step: step.step, status: step.status, error: step.error };
    default:
      return {
        kind: step.kind,
        tool: step.tool,
        vendor: step.vendor,
        amount_micros: toMicrosString(step.amountMicros),
        decision: step.decision,
        reasons: step.reasons,
        event_seq: step.eventSeq,
        approval_id: step.approvalId,
        rail_status: step.railStatus,
      };
  }
}

export function handleRunScenario(request: Request, name: string, deps: ScenarioRouteDeps = defaultScenarioRouteDeps()): Promise<Response> {
  return withHuman(request, deps, "scenario run", async (db) => {
    if (!isScenarioName(name)) return json(404, { error: "UNKNOWN_SCENARIO" });
    const body = await parseBody(request, RunBodySchema);
    if (!body.ok) return body.response;
    const sandbox = await currentSandbox(db);
    if (!sandbox) return json(404, { error: "NO_SANDBOX" });
    const allowed = await hitRateLimit(db, { action: "scenario run", ip: clientIp(request), now: deps.now(), ...(deps.rateLimit ?? SCENARIO_RUN_LIMIT) });
    if (!allowed) return json(429, { error: "RATE_LIMITED" });

    const runId = body.value.run_id ?? randomUUID();
    const outcome = await runScenario(
      { workspaceId: sandbox.id, scenario: name, runId, actor: SANDBOX_VISITOR },
      {
        db,
        key: deps.key(),
        now: deps.now,
        baseUrl: deps.baseUrl(),
        ...(deps.agentFetch ? { agentFetch: deps.agentFetch } : {}),
        ...(deps.lock ? { lock: deps.lock } : {}),
      },
    );
    if (outcome.kind === "busy") return json(409, { error: "SCENARIO_BUSY" });
    const last = outcome.run.results.at(-1);
    if (!outcome.run.completed && last?.kind === "error") {
      console.error(`scenario ${name} stopped at a ${last.step} step: ${last.status} ${last.error}`);
    }
    return json(200, {
      scenario: name,
      run_id: runId,
      workspace_id: sandbox.id,
      agent_id: outcome.agentId,
      session_id: outcome.sessionId,
      started_seq: outcome.startedSeq,
      completed: outcome.run.completed,
      steps: outcome.run.results.map(stepToWire),
      summary: summaryToWire(outcome.summary),
    });
  });
}
