import { sql } from "drizzle-orm";
import { AgentClient } from "@/agents/client";
import { type LiveRun, runGemini } from "@/agents/gemini/agent";
import type { GeminiModel } from "@/agents/gemini/model";
import type { LiveScenarioName } from "@/agents/gemini/scenarios";
import { type ScriptedRun, runScripted } from "@/agents/scripted/agent";
import { SCENARIOS, type ScenarioName } from "@/agents/scripted/scenarios";
import { type RunSummary, summarizeRun } from "@/agents/scripted/summary";
import { envelopeToWire } from "@/core/policy";
import { createAgent } from "@/server/agents/agents";
import { appendEvent } from "@/server/audit/append";
import { type Db, queryRows } from "@/server/db/client";
import { sessions, tasks, vendors } from "@/server/db/schema";

/**
 * The scenario runner (demo-agents design, "Runner"). Each run:
 * 1. takes the scenario's advisory lock, so one run per scenario is in
 *    progress at a time;
 * 2. creates a fresh agent with the scenario's envelope, a fresh task,
 *    and a session in the current sandbox, and appends scenario_started
 *    (AGT-2). Nothing earlier is changed or deleted, so earlier runs'
 *    freezes, reservations, and taint stay with their own agents;
 * 3. runs the scripted agent over HTTP with the new key (AGT-4). The key
 *    exists only in this function's memory: it's never stored, logged,
 *    or returned.
 */

export interface RunnerDeps {
  db: Db;
  /** Audit head key. */
  key: Uint8Array;
  now: () => Date;
  /**
   * The deployment's own origin (APP_ORIGIN), where the agent API and the
   * demo vendor pages live. Never taken from the request: the run's API
   * key is sent there.
   */
  baseUrl: string;
  /** How the agent sends HTTP requests. Defaults to the global fetch. */
  agentFetch?: typeof fetch;
  lock?: ScenarioLock;
  /** Wall-clock milliseconds for the live agent's time budget. Defaults to Date.now. */
  clockMs?: () => number;
}

export type Locked<T> = { acquired: true; value: T } | { acquired: false };

/** Run `run` while holding the scenario's lock, or return { acquired: false } if another run holds it. */
export type ScenarioLock = <T>(db: Db, scenario: ScenarioName, run: () => Promise<T>) => Promise<Locked<T>>;

/**
 * A transaction-scoped advisory lock, held by a transaction that stays
 * open for the run. It doesn't wait: a second run of the same scenario
 * gets { acquired: false } at once. If the function is killed mid-run,
 * Postgres ends the connection and the lock goes with it. The run's own
 * writes use other connections, so they commit as they go.
 */
export async function advisoryScenarioLock<T>(db: Db, scenario: ScenarioName, run: () => Promise<T>): Promise<Locked<T>> {
  let finished: Locked<T> | undefined;
  try {
    return await db.transaction(async (tx): Promise<Locked<T>> => {
      const [row] = await queryRows<{ locked: boolean }>(tx, sql`SELECT pg_try_advisory_xact_lock(hashtext(${`agentvault:scenario:${scenario}`})) AS locked`);
      if (row?.locked !== true) return { acquired: false };
      finished = { acquired: true, value: await run() };
      return finished;
    });
  } catch (error) {
    // The run finished, but closing the idle lock transaction failed (for example, the
    // connection was dropped). The lock is released either way, so the result stands.
    if (!finished) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    console.error(`scenario lock release failed${typeof code === "string" ? ` ${code}` : ""}:`, error instanceof Error ? error.message : "unknown error");
    return finished;
  }
}

export interface StartedRun {
  agentId: string;
  taskId: string;
  sessionId: string;
  apiKey: string;
  eventSeq: number;
  /** The run's own names for vendors its steps name: the per-run supplier, if the scenario has one. */
  vendors: Record<string, string>;
}

/** Where the per-run supplier says it lives. Nothing is fetched from it: the invoice is on the app's own origin. */
export const PAYEE_ORIGIN = "https://acme-supplies.example";

/**
 * The per-run supplier's name (payout-rails PO-23): the scenario's payee
 * name and the first 16 hex characters of the run's new agent ID. The agent
 * ID is made by the server for this run, so a visitor who resends a run ID
 * can't collide with another run's supplier.
 */
export function runPayeeName(payeeName: string, agentId: string): string {
  return `${payeeName}-${agentId.replaceAll("-", "").slice(0, 16).toLowerCase()}`;
}

/** Step 2: the fresh agent, task, and session, and scenario_started, in one transaction. */
export async function startRun(
  db: Db,
  input: { workspaceId: string; scenario: ScenarioName; runId: string; actor: string; agent?: RunAgent },
  options: { key: Uint8Array; now: Date },
): Promise<StartedRun> {
  const scenario = SCENARIOS[input.scenario];
  return db.transaction(async (tx) => {
    // The new envelope row is locked by nobody else yet, and the audit head comes last,
    // so this keeps the lock order (envelope, approvals, audit head).
    const { agentId, apiKey } = await createAgent(tx, { workspaceId: input.workspaceId, name: scenario.agentName, envelope: scenario.envelope, now: options.now });
    const [task] = await tx
      .insert(tasks)
      .values({
        workspaceId: input.workspaceId,
        description: scenario.task.description,
        allowedVendorCategories: [...scenario.task.allowedVendorCategories],
        allowedTools: [...scenario.task.allowedTools],
        budgetMicros: scenario.task.budgetMicros,
      })
      .returning({ id: tasks.id });
    if (!task) throw new Error("Task insert returned no row");
    const [session] = await tx.insert(sessions).values({ agentId, taskId: task.id, createdAt: options.now }).returning({ id: sessions.id });
    if (!session) throw new Error("Session insert returned no row");
    // payout-rails PO-23: a fresh supplier for this run, so another run's approved payee change can't redirect this run's payout.
    const runVendors: Record<string, string> = {};
    if (scenario.payee) {
      const name = runPayeeName(scenario.payee.name, agentId);
      await tx.insert(vendors).values({
        workspaceId: input.workspaceId,
        name,
        origin: PAYEE_ORIGIN,
        category: scenario.payee.category,
        trusted: false,
        stripeAccount: scenario.payee.stripeAccount,
        paypalReceiver: scenario.payee.paypalReceiver,
      });
      runVendors[scenario.payee.name] = name;
    }
    const { limits, vendorLimits, toolLimits, allowedVendors, allowedTools } = envelopeToWire(scenario.envelope, 1);
    const event = await appendEvent(
      tx,
      {
        workspaceId: input.workspaceId,
        type: "scenario_started",
        payload: {
          scenario: input.scenario,
          run_id: input.runId,
          actor: input.actor,
          agent_id: agentId,
          agent_name: scenario.agentName,
          // Only live runs say which agent and model ran, so scripted events are unchanged.
          ...(input.agent?.kind === "gemini" ? { agent: "gemini", model: input.agent.model.id } : {}),
          task_id: task.id,
          session_id: session.id,
          envelope: { limits, vendorLimits, toolLimits, allowedVendors, allowedTools },
          task: {
            description: scenario.task.description,
            allowed_vendor_categories: scenario.task.allowedVendorCategories,
            allowed_tools: scenario.task.allowedTools,
            budget_micros: scenario.task.budgetMicros,
          },
          ...(scenario.payee ? { vendors: runVendors } : {}),
        },
      },
      options,
    );
    return { agentId, taskId: task.id, sessionId: session.id, apiKey, eventSeq: event.seq, vendors: runVendors };
  });
}

export interface FinishedRun {
  agentId: string;
  sessionId: string;
  startedSeq: number;
  run: ScriptedRun | LiveRun;
  summary: RunSummary;
}

export type RunOutcome = { kind: "busy" } | ({ kind: "done" } & FinishedRun);

/**
 * Which agent runs the steps. `gemini` is the optional live agent
 * (demo-agents AGT-11), for the scenarios it offers; the caller checks that.
 */
export type RunAgent = { kind: "scripted" } | { kind: "gemini"; model: GeminiModel; scenario: LiveScenarioName };

export async function runScenario(
  input: { workspaceId: string; scenario: ScenarioName; runId: string; actor: string; agent?: RunAgent },
  deps: RunnerDeps,
): Promise<RunOutcome> {
  const lock = deps.lock ?? advisoryScenarioLock;
  const agent = input.agent ?? { kind: "scripted" };
  const locked = await lock(deps.db, input.scenario, async (): Promise<FinishedRun> => {
    const started = await startRun(deps.db, input, { key: deps.key, now: deps.now() });
    const client = new AgentClient(deps.baseUrl, started.apiKey, started.sessionId, deps.agentFetch ? { fetch: deps.agentFetch } : {});
    const run =
      agent.kind === "gemini"
        ? await runGemini(agent.scenario, client, agent.model, { vendorOrigin: deps.baseUrl, now: deps.clockMs ?? Date.now })
        : await runScripted(SCENARIOS[input.scenario], client, { vendorOrigin: deps.baseUrl, vendors: started.vendors });
    return { agentId: started.agentId, sessionId: started.sessionId, startedSeq: started.eventSeq, run, summary: summarizeRun(run) };
  });
  return locked.acquired ? { kind: "done", ...locked.value } : { kind: "busy" };
}
