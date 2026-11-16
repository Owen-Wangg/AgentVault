import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LiveRun } from "@/agents/gemini/agent";
import { type GeminiModel, createGeminiModel } from "@/agents/gemini/model";
import { isLiveScenario } from "@/agents/gemini/scenarios";
import type { ScriptedRun, StepResult } from "@/agents/scripted/agent";
import { isScenarioName } from "@/agents/scripted/scenarios";
import { summaryToWire } from "@/agents/scripted/summary";
import { toMicrosString } from "@/core/money";
import { SANDBOX_VISITOR, withHuman } from "@/server/approvals/handlers";
import { type Database, createDb } from "@/server/db/client";
import { env } from "@/server/env";
import { json, parseBody } from "@/server/http/agent-route";
import { type RateLimit, clientIp, hitRateLimit } from "@/server/http/rate-limit";
import { currentSandbox } from "@/server/sandbox/sandbox";
import { type RunAgent, type ScenarioLock, runScenario } from "./runner";

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
 * With `agent: "gemini"` the live Gemini agent runs the scenario instead
 * of the scripted one (AGT-11 to AGT-16), under the same envelope and
 * task. It has tighter limits, because every visitor shares one
 * free-tier quota (LIVE_RUN_LIMITS). A Gemini failure or 429 is still a
 * 200: the run stops, and `stop` says why, so the page can offer the
 * scripted run (AGT-14).
 *
 * Responses: 200 with the steps and summary, 404 UNKNOWN_SCENARIO,
 * NO_SANDBOX, or LIVE_AGENT_OFF (no GEMINI_API_KEY), 400
 * LIVE_NOT_OFFERED (the runaway loop), 409 SCENARIO_BUSY while another
 * run of the same scenario is in progress, 429 RATE_LIMITED or
 * LIVE_QUOTA_USED, 503 on any error.
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
  /** The live agent's model, or null when GEMINI_API_KEY is unset (AGT-11). */
  geminiModel?: () => GeminiModel | null;
  liveRateLimit?: { perIp: RateLimit; total: RateLimit };
  clockMs?: () => number;
}

/** The live agent's model from the environment, or null when it's off. The key goes only to the SDK. */
export function geminiModelFromEnv(): GeminiModel | null {
  if (!env.geminiEnabled()) return null;
  const apiKey = env.geminiApiKey();
  return apiKey ? createGeminiModel({ apiKey, model: env.geminiModel() }) : null;
}

export function defaultScenarioRouteDeps(): ScenarioRouteDeps {
  return { openDb: () => createDb(env.databaseUrl()), key: env.auditHeadKey, now: () => new Date(), baseUrl: env.appOrigin, geminiModel: geminiModelFromEnv };
}

/** Runs started per IP per minute. */
export const SCENARIO_RUN_LIMIT: RateLimit = { limit: 10, windowMs: 60_000 };

/**
 * Live runs share one free-tier Gemini quota (about 500 requests a day,
 * 4 to 8 per run), so they get their own limits on top of the one above:
 * 3 per IP per 10 minutes, and 40 a day across everyone (a UTC day, since
 * the windows are fixed). That leaves about 180 requests for the owner's
 * own use.
 */
export const LIVE_RUN_LIMITS = {
  perIp: { limit: 3, windowMs: 10 * 60_000 },
  total: { limit: 40, windowMs: 24 * 60 * 60_000 },
} as const satisfies { perIp: RateLimit; total: RateLimit };

/** The rate-limit bucket every live run counts against. Not an IP, so no visitor can land in it. */
const ALL_VISITORS = "all-visitors";

const RunBodySchema = z.strictObject({ run_id: z.uuid().optional(), agent: z.enum(["scripted", "gemini"]).optional() });

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
        advisory_drift_score: step.advisoryDriftScore,
      };
  }
}

/** The live agent's extra result fields, or none for a scripted run. */
function liveToWire(run: ScriptedRun | LiveRun) {
  if (!("stop" in run)) return { agent: "scripted" };
  return { agent: "gemini", stop: run.stop, tool_calls: run.toolCalls, rejected_calls: run.rejectedCalls, gemini_requests: run.geminiRequests };
}

export function handleRunScenario(request: Request, name: string, deps: ScenarioRouteDeps = defaultScenarioRouteDeps()): Promise<Response> {
  return withHuman(request, deps, "scenario run", async (db) => {
    if (!isScenarioName(name)) return json(404, { error: "UNKNOWN_SCENARIO" });
    const body = await parseBody(request, RunBodySchema);
    if (!body.ok) return body.response;
    let agent: RunAgent = { kind: "scripted" };
    if (body.value.agent === "gemini") {
      // AGT-11: the live agent exists only where GEMINI_API_KEY is set, and not for the runaway loop.
      const model = deps.geminiModel?.() ?? null;
      if (!model) return json(404, { error: "LIVE_AGENT_OFF" });
      if (!isLiveScenario(name)) return json(400, { error: "LIVE_NOT_OFFERED" });
      agent = { kind: "gemini", model, scenario: name };
    }
    const sandbox = await currentSandbox(db);
    if (!sandbox) return json(404, { error: "NO_SANDBOX" });
    const ip = clientIp(request);
    const allowed = await hitRateLimit(db, { action: "scenario run", ip, now: deps.now(), ...(deps.rateLimit ?? SCENARIO_RUN_LIMIT) });
    if (!allowed) return json(429, { error: "RATE_LIMITED" });
    if (agent.kind === "gemini") {
      const limits = deps.liveRateLimit ?? LIVE_RUN_LIMITS;
      if (!(await hitRateLimit(db, { action: "scenario live run", ip, now: deps.now(), ...limits.perIp }))) return json(429, { error: "RATE_LIMITED" });
      if (!(await hitRateLimit(db, { action: "scenario live run total", ip: ALL_VISITORS, now: deps.now(), ...limits.total }))) {
        return json(429, { error: "LIVE_QUOTA_USED" });
      }
    }

    const runId = body.value.run_id ?? randomUUID();
    const outcome = await runScenario(
      { workspaceId: sandbox.id, scenario: name, runId, actor: SANDBOX_VISITOR, agent },
      {
        db,
        key: deps.key(),
        now: deps.now,
        baseUrl: deps.baseUrl(),
        ...(deps.agentFetch ? { agentFetch: deps.agentFetch } : {}),
        ...(deps.lock ? { lock: deps.lock } : {}),
        ...(deps.clockMs ? { clockMs: deps.clockMs } : {}),
      },
    );
    if (outcome.kind === "busy") return json(409, { error: "SCENARIO_BUSY" });
    const last = outcome.run.results.at(-1);
    // Codes only: never a prompt, a page, or the key.
    if ("stop" in outcome.run && outcome.run.stop !== "finished") console.error(`live scenario ${name} stopped: ${outcome.run.stop}`);
    if (!outcome.run.completed && last?.kind === "error") {
      console.error(`scenario ${name} stopped at a ${last.step} step: ${last.status} ${last.error}`);
    }
    return json(200, {
      ...liveToWire(outcome.run),
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
