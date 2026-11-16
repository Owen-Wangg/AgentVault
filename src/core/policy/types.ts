import type { TaskScope } from "@/core/intent/types";
import type { Micros } from "@/core/money";
import type { SessionState, ToolDef } from "@/core/taint/types";
import type { HoldReason, ReasonCode } from "./reasons";

export type Window = "minute" | "hour" | "day";

export const WINDOWS: readonly Window[] = ["minute", "hour", "day"];

/** A set of limits. Every field is optional; a missing field means no limit. */
export interface Limits {
  txMaxMicros?: Micros;
  windowCapsMicros?: Partial<Record<Window, Micros>>;
  /** A count, not money, so `number` is fine. */
  callsPerMinute?: number;
  approvalThresholdMicros?: Micros;
}

export interface Envelope {
  agentId: string;
  /** Agent-level limits. */
  limits: Limits;
  /** Extra limits for one vendor or tool. The stricter limit wins (ENV-9). */
  vendorLimits: Record<string, Limits>;
  toolLimits: Record<string, Limits>;
  allowedVendors: readonly string[] | "*";
  allowedTools: readonly string[] | "*";
}

/** Trailing-window spend and call counts, computed by the server. */
export interface WindowState {
  /** Agent-level spend. */
  spentMicros: Record<Window, Micros>;
  /** Spend with this request's vendor. */
  vendorSpentMicros: Record<Window, Micros>;
  /** Spend with this request's tool. */
  toolSpentMicros: Record<Window, Micros>;
  /** Calls in the trailing minute, excluding this request. Denied and held calls count too. */
  callsLastMinute: number;
}

export interface PayRequest {
  kind: "pay" | "tool";
  agentId: string;
  sessionId: string;
  vendor: string;
  /** From the workspace vendor registry, never from the agent (INT-5). */
  vendorCategory: string;
  /** For example "x402.pay" or "stripe.refund". */
  tool: string;
  /** Already passed through `chargeableMicros()` (MON-10, MON-11). */
  amountMicros: Micros;
  idempotencyKey: string;
}

/** Everything `evaluate()` decides on. The server loads it; the core does no I/O. */
export interface EvaluateInput {
  request: PayRequest;
  envelope: Envelope;
  window: WindowState;
  session: SessionState;
  scope: TaskScope;
  /** The registry entry for `request.tool`. Its `privileged` flag drives the taint rule (TAINT-6). */
  tool: ToolDef;
  /**
   * Hold reasons a human approved (HITL-2), set only on an approval's
   * re-run. Matching hold reasons are dropped from the decision. Deny
   * reasons can't be approved: the schema rejects them, and they are never
   * dropped (HITL-3, TAINT-9).
   */
  approvedHoldReasons?: readonly HoldReason[];
  /**
   * An LLM's advisory drift score for this request, an integer from 0 to
   * 100 (INT-7). It can only add ADVISORY_DRIFT (INT-8, INT-9). A rating,
   * not money.
   */
  advisoryDriftScore?: number;
}

export interface ReasonDetail {
  code: ReasonCode;
  detail?: Record<string, string>;
}

export interface Decision {
  decision: "allow" | "hold" | "deny";
  reasons: readonly ReasonDetail[];
}

/** A rule looks at the input and returns the reasons it finds, or none. */
export type Rule = (input: EvaluateInput) => ReasonDetail[];
