import { z } from "zod";
import { type Micros, MicrosSchema } from "@/core/money";
import { type AuditEventMessage, type FeedRow, decisionRow } from "@/ui/events/summarize";

/**
 * What the scenarios page shows for a run (demo-agents AGT-3, AGT-10).
 * The live steps come from the event stream: the run's scenario_started
 * event names its agent, and that agent's decision and taint events are
 * its steps. The summary comes from the run's response. Pure.
 */

const StartedPayload = z.looseObject({ run_id: z.string(), agent_id: z.string() });
const TaintPayload = z.looseObject({ agent_id: z.string(), url: z.string() });

/** The agent a run created, from its scenario_started event. */
export function runAgentId(events: readonly AuditEventMessage[], runId: string): string | null {
  for (const e of events) {
    if (e.type !== "scenario_started") continue;
    const p = StartedPayload.safeParse(e.payload);
    if (p.success && p.data.run_id === runId) return p.data.agent_id;
  }
  return null;
}

export type RunStep = { kind: "decision"; seq: number; row: FeedRow } | { kind: "taint"; seq: number; url: string };

/** The agent's decisions and taints, oldest first. */
export function runSteps(events: readonly AuditEventMessage[], agentId: string): RunStep[] {
  const steps: RunStep[] = [];
  for (const e of events) {
    if (e.type === "decision") {
      const row = decisionRow(e);
      if (row?.agentId === agentId) steps.push({ kind: "decision", seq: e.seq, row });
    } else if (e.type === "taint") {
      const p = TaintPayload.safeParse(e.payload);
      if (p.success && p.data.agent_id === agentId) steps.push({ kind: "taint", seq: e.seq, url: p.data.url });
    }
  }
  return steps.sort((a, b) => a.seq - b.seq);
}

export interface RunSummaryView {
  requests: number;
  allowedMicros: Micros;
  heldMicros: Micros;
  blockedMicros: Micros;
  decisions: { allow: number; hold: number; deny: number };
  reasons: { code: string; count: number }[];
}

/** Why a live run stopped (demo-agents AGT-14, AGT-15). Scripted runs have none. */
export const LIVE_STOPS = ["finished", "tool_call_cap", "turn_cap", "time_limit", "gemini_rate_limited", "gemini_failed", "api_error"] as const;
export type LiveStop = (typeof LIVE_STOPS)[number];

export interface RunResult {
  agentId: string;
  completed: boolean;
  summary: RunSummaryView;
  /** Which agent ran the steps. */
  agent: "scripted" | "gemini";
  stop?: LiveStop;
}

const Count = z.number().int().nonnegative();

const RunResponse = z.looseObject({
  agent_id: z.string(),
  completed: z.boolean(),
  agent: z.enum(["scripted", "gemini"]).optional(),
  // An unknown stop code still shows the run, just without a reason.
  stop: z.enum(LIVE_STOPS).optional().catch(undefined),
  summary: z.looseObject({
    requests: Count,
    allowed_micros: MicrosSchema,
    held_micros: MicrosSchema,
    blocked_micros: MicrosSchema,
    decisions: z.looseObject({ allow: Count, hold: Count, deny: Count }),
    reasons: z.array(z.looseObject({ code: z.string(), count: Count })),
  }),
});

/** The run's response, or null if it isn't one. */
export function parseRunResult(body: unknown): RunResult | null {
  const r = RunResponse.safeParse(body);
  if (!r.success) return null;
  const s = r.data.summary;
  return {
    agentId: r.data.agent_id,
    completed: r.data.completed,
    agent: r.data.agent ?? "scripted",
    ...(r.data.stop ? { stop: r.data.stop } : {}),
    summary: {
      requests: s.requests,
      allowedMicros: s.allowed_micros,
      heldMicros: s.held_micros,
      blockedMicros: s.blocked_micros,
      decisions: { allow: s.decisions.allow, hold: s.decisions.hold, deny: s.decisions.deny },
      reasons: s.reasons.map((x) => ({ code: x.code, count: x.count })),
    },
  };
}
