import type { Micros } from "@/core/money";

/**
 * Per-session state the server loads for `evaluate()` (taint-and-intent
 * design). The taint rules that read `taintedAt` arrive in taint-and-intent
 * task 1; `agentFrozen` is read by the policy's `frozenRule` (ENV-5).
 */
export interface SessionState {
  sessionId: string;
  /** From `agents.frozen_at`, read after the envelope lock (PXY-11). */
  agentFrozen: boolean;
  /** ISO time the session was tainted, passed in. Null if never tainted. */
  taintedAt: string | null;
  taintSourceUrl: string | null;
  /** Reserved plus settled reservations for this session (audit-and-approvals RES-2). */
  sessionSpentMicros: Micros;
}
