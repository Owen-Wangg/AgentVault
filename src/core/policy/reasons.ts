/**
 * Reason codes a decision can carry. Any deny reason makes the decision
 * `deny`; otherwise any hold reason makes it `hold` (ENV-12).
 */
export const DENY_REASONS = [
  "INVALID_REQUEST",
  "AGENT_FROZEN",
  "OVER_TX_MAX",
  "OVER_WINDOW_CAP",
  "VELOCITY_EXCEEDED",
  "VENDOR_NOT_ALLOWED",
  "TOOL_NOT_ALLOWED",
  "DENY_INTENT_DRIFT",
  "OVER_TASK_BUDGET",
] as const;

export const HOLD_REASONS = ["NEEDS_APPROVAL", "HELD_TAINTED", "ADVISORY_DRIFT"] as const;

export type DenyReason = (typeof DENY_REASONS)[number];
export type HoldReason = (typeof HOLD_REASONS)[number];
export type ReasonCode = DenyReason | HoldReason;

export const REASON_CODES: readonly ReasonCode[] = [...DENY_REASONS, ...HOLD_REASONS];

const DENY_SET: ReadonlySet<string> = new Set(DENY_REASONS);
const HOLD_SET: ReadonlySet<string> = new Set(HOLD_REASONS);

export function isDenyReason(code: ReasonCode): code is DenyReason {
  return DENY_SET.has(code);
}

export function isHoldReason(code: ReasonCode): code is HoldReason {
  return HOLD_SET.has(code);
}
