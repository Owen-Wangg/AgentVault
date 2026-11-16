import type { Content, Part } from "@google/genai";
import { AgentApiError, type DecisionResult } from "@/agents/client";
import { type ScenarioClient, type ScriptedRun, type StepResult, decisionResult } from "@/agents/scripted/agent";
import { SCENARIOS } from "@/agents/scripted/scenarios";
import { FUNCTION_DECLARATIONS, type ToolCall, parseToolCall } from "./tools";
import { GeminiError, type GeminiModel, type GeminiReply } from "./model";
import { LIVE_CATALOG, type LiveScenarioName, liveSystemPrompt, liveUserPrompt } from "./scenarios";
import { type ProposedAction, type ScoringContext, scoreDrift } from "./scorer";

/**
 * The live Gemini agent (demo-agents AGT-11 to AGT-16). It runs a
 * function-calling loop: Gemini picks fetch_url, pay, or request_tool;
 * the agent validates the arguments with Zod (AGT-13), asks a second
 * Gemini call for an advisory drift score before each pay or tool
 * request (AGT-16), and sends the request through AgentClient with the
 * run's own key, like any outside agent. AgentVault's rules make every
 * decision; the model only chooses what to ask for.
 *
 * Limits: 15 tool calls per run (AGT-15), 8 model turns, and a time
 * budget that fits the route's 60 s. A 429 or any other Gemini failure
 * stops the run (AGT-14).
 *
 * Page text goes to the model, as it would for any agent, but never to
 * the scorer, a log, or the run's result.
 */

export const MAX_TOOL_CALLS = 15;
export const MAX_TURNS = 8;
/** Leaves room inside the route's 60 s for the run's setup and response. */
export const DEFAULT_DEADLINE_MS = 45_000;
/** The most page text the model gets back from one fetch_url. */
export const MAX_PAGE_CHARS = 20_000;

/** /api/v1/fetch statuses that mean the page couldn't be read (taint-and-intent design, "Error handling"). */
const PAGE_ERRORS: ReadonlySet<number> = new Set([400, 502, 504]);

export type LiveStop = "finished" | "tool_call_cap" | "turn_cap" | "time_limit" | "gemini_rate_limited" | "gemini_failed" | "api_error";

export interface LiveRun extends ScriptedRun {
  stop: LiveStop;
  /** Function calls the model made that counted toward the cap, including rejected ones. */
  toolCalls: number;
  /** Calls whose arguments failed validation, so nothing was sent (AGT-13). */
  rejectedCalls: number;
  /** Gemini requests made: agent turns plus drift scores. */
  geminiRequests: number;
}

export interface LiveOptions {
  /** The deployment's origin: the API, the vendor pages, and the only host fetch_url may read. */
  vendorOrigin: string;
  /** Milliseconds, for the time budget. */
  now: () => number;
  deadlineMs?: number;
  maxToolCalls?: number;
  maxTurns?: number;
}

class Stop extends Error {
  constructor(
    readonly stop: LiveStop,
    readonly step?: Extract<StepResult, { kind: "error" }>,
  ) {
    super(stop);
  }
}

const decisionReply = (d: DecisionResult) => ({
  decision: d.decision,
  reasons: d.reasons.map((r) => r.code),
  ...(d.approvalId ? { approval_id: d.approvalId } : {}),
  ...(d.railStatus ? { rail_status: d.railStatus } : {}),
});

export async function runGemini(name: LiveScenarioName, client: ScenarioClient, model: GeminiModel, options: LiveOptions): Promise<LiveRun> {
  const scenario = SCENARIOS[name];
  const maxToolCalls = options.maxToolCalls ?? MAX_TOOL_CALLS;
  const maxTurns = options.maxTurns ?? MAX_TURNS;
  const deadline = options.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const scoring: ScoringContext = {
    task: scenario.task.description,
    allowedVendorCategories: scenario.task.allowedVendorCategories,
    allowedTools: scenario.task.allowedTools,
    budgetMicros: scenario.task.budgetMicros,
    catalog: Object.fromEntries(LIVE_CATALOG.map((v) => [v.name, v.category])),
  };

  const results: StepResult[] = [];
  let requests = 0;
  let toolCalls = 0;
  let rejectedCalls = 0;
  let geminiRequests = 0;
  const nextKey = () => `live-${requests}`;

  async function gemini<T>(call: () => Promise<T>): Promise<T> {
    geminiRequests += 1;
    try {
      return await call();
    } catch (error) {
      const e = error instanceof GeminiError ? error : new GeminiError("failed", 0);
      const code = e.kind === "rate_limited" ? "GEMINI_RATE_LIMITED" : "GEMINI_FAILED";
      throw new Stop(e.kind === "rate_limited" ? "gemini_rate_limited" : "gemini_failed", { kind: "error", step: "model", status: e.status, error: code });
    }
  }

  async function api<T>(step: "fetch" | "pay" | "tool", send: () => Promise<T>): Promise<T> {
    requests += 1;
    try {
      return await send();
    } catch (error) {
      if (error instanceof AgentApiError) throw new Stop("api_error", { kind: "error", step, status: error.status, error: error.code });
      throw new Stop("api_error", { kind: "error", step, status: 0, error: "REQUEST_FAILED" });
    }
  }

  async function decide(call: Exclude<ToolCall, { name: "fetch_url" }>): Promise<Record<string, unknown>> {
    const action: ProposedAction =
      call.name === "pay"
        ? { tool: "x402.pay", vendor: call.vendor, amountMicros: call.amountMicros }
        : { tool: call.tool, vendor: call.vendor, amountMicros: call.amountMicros, refs: refsOf(call.args) };
    const score = await gemini(() => scoreDrift(model, scoring, action));
    const d =
      call.name === "pay"
        ? await api("pay", () => client.pay(call.vendor, call.amountMicros, nextKey(), "x402.pay", { advisoryDriftScore: score }))
        : await api("tool", () => client.tool(call.tool, call.args, nextKey(), { advisoryDriftScore: score }));
    const kind = call.name === "pay" ? "pay" : "tool";
    results.push({ ...decisionResult(kind, action.tool, call.vendor, call.amountMicros, d), advisoryDriftScore: score } as StepResult);
    return { ...decisionReply(d), advisory_drift_score: score };
  }

  async function execute(call: ToolCall): Promise<Record<string, unknown>> {
    if (call.name !== "fetch_url") return decide(call);
    let page: Awaited<ReturnType<ScenarioClient["fetch"]>>;
    try {
      page = await api("fetch", () => client.fetch(call.url.toString()));
    } catch (error) {
      // A page that can't be read (blocked, missing, timed out) is the model's problem to work around,
      // like any agent's. AgentVault failing (401, 403, 503, no response) still stops the run.
      const step = error instanceof Stop ? error.step : undefined;
      if (step && PAGE_ERRORS.has(step.status)) return { error: `AgentVault could not fetch the page: ${step.error}` };
      throw error;
    }
    results.push({ kind: "fetch", url: page.url, label: page.label, ...(page.eventSeq !== undefined ? { eventSeq: page.eventSeq } : {}) });
    return { label: page.label, url: page.url, text: page.body.slice(0, MAX_PAGE_CHARS) };
  }

  const contents: Content[] = [{ role: "user", parts: [{ text: liveUserPrompt(name, options.vendorOrigin) }] }];
  const system = liveSystemPrompt(name);
  let stop: LiveStop = "turn_cap";

  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (options.now() > deadline) throw new Stop("time_limit");
      const reply: GeminiReply = await gemini(() => model.generate({ system, contents, tools: FUNCTION_DECLARATIONS, maxOutputTokens: 2048 }));
      if (reply.content) contents.push(reply.content);
      if (reply.functionCalls.length === 0) {
        stop = "finished";
        break;
      }
      const parts: Part[] = [];
      for (const fc of reply.functionCalls) {
        if (toolCalls >= maxToolCalls) throw new Stop("tool_call_cap");
        if (options.now() > deadline) throw new Stop("time_limit");
        toolCalls += 1;
        const parsed = parseToolCall(fc.name, fc.args, options.vendorOrigin);
        let response: Record<string, unknown>;
        if (parsed.ok) {
          response = await execute(parsed.call);
        } else {
          rejectedCalls += 1;
          response = { error: `Invalid arguments: ${parsed.error}` };
        }
        parts.push({ functionResponse: { ...(fc.id ? { id: fc.id } : {}), name: fc.name, response } });
      }
      contents.push({ role: "user", parts });
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stop = error.stop;
    if (error.step) results.push(error.step);
  }

  return { results, requests, completed: stop === "finished", stop, toolCalls, rejectedCalls, geminiRequests };
}

function refsOf(args: Readonly<Record<string, string>>): Record<string, string> {
  const refs: Record<string, string> = {};
  if (args.payment_ref) refs.payment_ref = args.payment_ref;
  if (args.payee_ref) refs.payee_ref = args.payee_ref;
  return refs;
}
