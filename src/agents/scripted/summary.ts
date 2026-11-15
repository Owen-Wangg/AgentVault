import { type Micros, add, micros, toMicrosString } from "@/core/money";
import type { ScriptedRun } from "./agent";

/**
 * The summary shown when a scenario finishes (AGT-10): requests made,
 * spend allowed, spend held for approval, spend blocked (denied), and
 * decisions by reason. Amounts are the requested amounts of each
 * decision, so a refund the agent was talked into counts at its full
 * $480 even though nothing moved.
 */

export interface RunSummary {
  requests: number;
  allowedMicros: Micros;
  heldMicros: Micros;
  blockedMicros: Micros;
  decisions: Record<"allow" | "hold" | "deny", number>;
  /** Each reason code with how many decisions carried it, in order of first appearance. */
  reasons: { code: string; count: number }[];
}

export function summarizeRun(run: Pick<ScriptedRun, "results" | "requests">): RunSummary {
  const spend = { allow: micros(0n), hold: micros(0n), deny: micros(0n) };
  const decisions = { allow: 0, hold: 0, deny: 0 };
  const reasons = new Map<string, number>();
  for (const r of run.results) {
    if (r.kind !== "pay" && r.kind !== "tool") continue;
    decisions[r.decision] += 1;
    // Scenario amounts are a few dollars at most, so add() can't pass MAX_MICROS here.
    spend[r.decision] = add(spend[r.decision], r.amountMicros);
    for (const code of r.reasons) reasons.set(code, (reasons.get(code) ?? 0) + 1);
  }
  return {
    requests: run.requests,
    allowedMicros: spend.allow,
    heldMicros: spend.hold,
    blockedMicros: spend.deny,
    decisions,
    reasons: [...reasons].map(([code, count]) => ({ code, count })),
  };
}

/** The summary on the wire: amounts as micros strings. */
export function summaryToWire(s: RunSummary) {
  return {
    requests: s.requests,
    allowed_micros: toMicrosString(s.allowedMicros),
    held_micros: toMicrosString(s.heldMicros),
    blocked_micros: toMicrosString(s.blockedMicros),
    decisions: s.decisions,
    reasons: s.reasons,
  };
}
