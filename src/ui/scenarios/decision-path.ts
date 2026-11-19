import { type ReasonCode, isDenyReason, isHoldReason } from "@/core/policy";
import type { FeedRow } from "@/ui/events/summarize";

/**
 * A decision as a path through AgentVault's checks to the payment rail
 * (demo-agents AGT-17). Pure. Which check each reason code belongs to is
 * in the demo-agents design, "Decision path".
 */

export const CHECKS = ["agent", "limits", "scope", "taint"] as const;
export type Check = (typeof CHECKS)[number];
export type CheckState = "passed" | "held" | "denied" | "not_checked";

export interface DecisionPathView {
  checks: { check: Check; state: CheckState }[];
  /** Whether the request went on to the rail: only for an allowed decision. */
  railReached: boolean;
}

const CHECK_OF: Record<ReasonCode, Check> = {
  AGENT_FROZEN: "agent",
  INVALID_REQUEST: "agent",
  OVER_TX_MAX: "limits",
  OVER_WINDOW_CAP: "limits",
  VELOCITY_EXCEEDED: "limits",
  VENDOR_NOT_ALLOWED: "limits",
  TOOL_NOT_ALLOWED: "limits",
  NEEDS_APPROVAL: "limits",
  DENY_INTENT_DRIFT: "scope",
  OVER_TASK_BUDGET: "scope",
  ADVISORY_DRIFT: "scope",
  HELD_TAINTED: "taint",
};

const isKnown = (code: string): code is ReasonCode => Object.hasOwn(CHECK_OF, code);

const RANK: Record<CheckState, number> = { not_checked: 0, passed: 1, held: 2, denied: 3 };
const stricter = (a: CheckState, b: CheckState): CheckState => (RANK[b] > RANK[a] ? b : a);

export function decisionPath(row: Pick<FeedRow, "decision" | "reasons">): DecisionPathView {
  const states: Record<Check, CheckState> = { agent: "passed", limits: "passed", scope: "passed", taint: "passed" };
  for (const { code } of row.reasons) {
    if (isKnown(code)) {
      states[CHECK_OF[code]] = stricter(states[CHECK_OF[code]], isDenyReason(code) ? "denied" : isHoldReason(code) ? "held" : "passed");
    } else if (row.decision !== "allow") {
      // A code this table doesn't know: the decision's own outcome, on the agent check, so a deny never looks all-clear.
      states.agent = stricter(states.agent, row.decision === "deny" ? "denied" : "held");
    }
  }
  // INVALID_REQUEST is decided before evaluate(), so the later checks never ran.
  const refusedEarly = row.reasons.some((r) => r.code === "INVALID_REQUEST");
  return {
    checks: CHECKS.map((check) => ({ check, state: refusedEarly && check !== "agent" && states[check] === "passed" ? "not_checked" : states[check] })),
    railReached: row.decision === "allow",
  };
}
